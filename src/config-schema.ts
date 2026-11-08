/**
 * Item 9 — config schema compatibility.
 *
 * Source of truth is the host itself: `dsh --dump-config-schema` emits a
 * JSON Schema (draft 2020-12) whose `$defs.entry.allOf[]` carries one branch per
 * plugin module, each pointing at that plugin's own Config schema under
 * `$defs.configN`. `dsh --dump-config` emits the *composed* entry list (bundles
 * -> cordis.patch.yml -> overlays) as YAML, with `!!js` scalars in the
 * `{ __jsExpr: string }` shape the schema itself documents as `loaderExpression`.
 *
 * So we validate what the host will actually mount, against the schema the host
 * itself generated — no guessing at plugin internals, no hand-maintained copy.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import yaml from "js-yaml";
import { resolveDshBin, type IsolateHandle } from "./isolate.js";

/**
 * ajv ships as CJS. Under NodeNext a default import resolves to the module
 * namespace, which is not constructable, so load it through require and unwrap
 * the CJS/default interop by hand.
 */
const nodeRequire = createRequire(import.meta.url);
type AjvValidateFn = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; keyword?: string; message?: string }> | null;
};
type AjvLike = {
  addSchema(schema: object, key?: string): unknown;
  getSchema(key: string): AjvValidateFn | undefined;
  compile(schema: object): AjvValidateFn;
};
const ajvModule = nodeRequire("ajv/dist/2020.js") as
  | (new (opts?: Record<string, unknown>) => AjvLike)
  | { default: new (opts?: Record<string, unknown>) => AjvLike };
const Ajv2020: new (opts?: Record<string, unknown>) => AjvLike =
  typeof ajvModule === "function" ? ajvModule : ajvModule.default;

export interface SchemaDump {
  /** True when a parseable schema document came back (even if the CLI exited non-zero). */
  ok: boolean;
  rc: number | null;
  /** Bundles the host's own preflight refused, so no schema branch exists for them. */
  skippedBundles: string[];
  schemaBytes: number;
  entryBranches: number;
  error?: string;
}

export interface ComposedDump {
  ok: boolean;
  rc: number | null;
  entries: ComposedEntry[];
  /** Raw host stderr: the only place row-level warnings and errors appear. */
  stderr: string;
  error?: string;
}

export interface ComposedEntry {
  id: string | null;
  name: string;
  config: unknown;
  disabled: unknown;
}

export interface ConfigViolation {
  entryId: string | null;
  entryName: string;
  keyword: string;
  instancePath: string;
  message: string;
}

export interface ConfigCheckResult {
  schema: SchemaDump;
  composed: ComposedDump;
  violations: ConfigViolation[];
  /** Entries whose config could not be judged (no schema branch, or a !!js expression). */
  unjudged: string[];
  checked: number;
  /** Diagnostic counts: schema branches seen, composed entries seen, entries carrying config. */
  slots: number;
  entries: number;
  withConfig: number;
}

const SKIP_BUNDLE_RE =
  /^dsh: skipping profile bundle "(.+?)":/gm;

const JS_TAG = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (data: string) => ({ __jsExpr: data }),
});

const YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_TAG]);

interface RunResult {
  rc: number | null;
  stdout: string;
  stderr: string;
}

function runDsh(handle: IsolateHandle, extraArgs: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const dsh = resolveDshBin();
    const argv = ["--profile", handle.probeName, ...extraArgs];
    const quoted = argv.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
    const tail = `""${dsh}" ${quoted}"`;

    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", tail], {
      env: { ...process.env, DSH_HOME: handle.tmpHome },
      shell: false,
      windowsVerbatimArguments: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (rc: number | null, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (note) stderr += `\n[compat-guard] ${note}`;
      resolve({ rc, stdout, stderr });
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null, `schema command exceeded ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(null, `spawn failed: ${error.message}`));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Generate the schema with the host that is about to be installed.
 *
 * The CLI exits non-zero when its own preflight refuses a bundle, yet still
 * prints a complete document for everything it accepted. Partial output is
 * used deliberately: refusing to parse it would drop item 9 for every profile
 * that carries one incompatible plugin — exactly the profile that needs the check.
 */
export async function dumpConfigSchema(handle: IsolateHandle, timeoutMs = 60_000): Promise<{
  dump: SchemaDump;
  doc: Record<string, unknown> | null;
}> {
  const run = await runDsh(handle, ["--dump-config-schema"], timeoutMs);
  const skipped = [...run.stderr.matchAll(SKIP_BUNDLE_RE)].map((m) => m[1]!);

  if (run.stdout.trim() === "") {
    return {
      dump: {
        ok: false,
        rc: run.rc,
        skippedBundles: skipped,
        schemaBytes: 0,
        entryBranches: 0,
        error: run.rc === null ? "schema command did not finish" : `empty schema output (rc=${run.rc})`,
      },
      doc: null,
    };
  }

  try {
    const doc = JSON.parse(run.stdout) as Record<string, unknown>;
    const branches = countEntryBranches(doc);
    return {
      dump: {
        ok: branches > 0,
        rc: run.rc,
        skippedBundles: skipped,
        schemaBytes: run.stdout.length,
        entryBranches: branches,
        ...(branches > 0 ? {} : { error: "schema has no entry branches" }),
      },
      doc,
    };
  } catch (error) {
    return {
      dump: {
        ok: false,
        rc: run.rc,
        skippedBundles: skipped,
        schemaBytes: run.stdout.length,
        entryBranches: 0,
        error: `schema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
      doc: null,
    };
  }
}

function countEntryBranches(doc: unknown): number {
  const entry = (doc as { $defs?: { entry?: { allOf?: unknown[] } } })?.$defs?.entry;
  return Array.isArray(entry?.allOf) ? entry!.allOf!.length : 0;
}

/** Composed (post-patch) entry list, i.e. what the host will actually mount. */
export async function dumpComposedEntries(
  handle: IsolateHandle,
  timeoutMs = 60_000,
): Promise<ComposedDump> {
  const run = await runDsh(handle, ["--dump-config"], timeoutMs);
  if (run.stdout.trim() === "") {
    return {
      ok: false,
      rc: run.rc,
      entries: [],
      stderr: run.stderr,
      error: run.rc === null ? "dump-config did not finish" : `empty output (rc=${run.rc})`,
    };
  }
  try {
    const loaded = yaml.load(run.stdout, { schema: YAML_SCHEMA });
    if (!Array.isArray(loaded)) {
      return { ok: false, rc: run.rc, entries: [], stderr: run.stderr, error: "composed tree is not a list" };
    }
    const entries: ComposedEntry[] = [];
    for (const row of loaded) {
      if (row === null || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : null;
      if (name === null) continue;
      entries.push({
        id: typeof rec.id === "string" ? rec.id : null,
        name,
        config: rec.config,
        disabled: rec.disabled,
      });
    }
    return { ok: true, rc: run.rc, entries, stderr: run.stderr };
  } catch (error) {
    return {
      ok: false,
      rc: run.rc,
      entries: [],
      stderr: run.stderr,
      error: `composed tree is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * `module specifier -> that plugin's config schema` for every branch the host
 * declared. Three shapes occur in the host's output and all must be handled:
 *
 *   config: { $ref: "#/$defs/configN" }                       direct reference
 *   config: { anyOf: [ { $ref: "#/$defs/configN" } ] }        wrapped in anyOf
 *   config: { type: ..., properties: ... }                    inline schema
 *
 * A branch pointing at `$defs.unknownConfig` means the host has no schema for
 * that plugin; it is recorded as `unknown` so the caller can report "cannot
 * judge" rather than mistaking a permissive schema for a passing check.
 */
export interface ConfigSchemaSlot {
  ref: string | null;
  inline: unknown | null;
  unknown: boolean;
}

export function extractConfigSlots(doc: unknown): Map<string, ConfigSchemaSlot> {
  const slots = new Map<string, ConfigSchemaSlot>();
  const entry = (doc as { $defs?: { entry?: { allOf?: unknown[] } } })?.$defs?.entry;
  if (!Array.isArray(entry?.allOf)) return slots;
  for (const branch of entry!.allOf!) {
    const rec = branch as {
      if?: { properties?: { name?: { const?: unknown } } };
      then?: { properties?: { config?: Record<string, unknown> } };
    };
    const name = rec?.if?.properties?.name?.const;
    if (typeof name !== "string") continue;
    const cfg = rec?.then?.properties?.config;
    if (cfg === undefined || cfg === null || typeof cfg !== "object") {
      slots.set(name, { ref: null, inline: null, unknown: true });
      continue;
    }

    let ref: string | null = typeof cfg.$ref === "string" ? cfg.$ref : null;
    if (ref === null && Array.isArray(cfg.anyOf)) {
      for (const alt of cfg.anyOf as Array<Record<string, unknown>>) {
        if (typeof alt?.$ref === "string") {
          ref = alt.$ref;
          break;
        }
      }
    }

    if (ref !== null) {
      slots.set(name, { ref, inline: null, unknown: ref === "#/$defs/unknownConfig" });
      continue;
    }

    // No $ref: `cfg` may still be an inline schema (configN style) or nothing useful.
    const looksLikeSchema =
      typeof cfg.type === "string" || cfg.properties !== undefined || cfg.anyOf !== undefined;
    slots.set(name, {
      ref: null,
      inline: looksLikeSchema ? cfg : null,
      unknown: !looksLikeSchema,
    });
  }
  return slots;
}

/** Kept for callers that only need the reference form. */
export function extractConfigRefs(doc: unknown): Map<string, string> {
  const refs = new Map<string, string>();
  for (const [name, slot] of extractConfigSlots(doc)) {
    if (slot.ref !== null && !slot.unknown) refs.set(name, slot.ref);
  }
  return refs;
}

function isJsExpr(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "__jsExpr")
  );
}

/**
 * Validate every composed entry's config against its plugin's schema branch.
 *
 * A missing `required` field or a wrong primitive type is HIGH: the plugin
 * receives a config its own schema rejects, which ranges from silently falling
 * back to defaults to throwing in `apply`. Anything else is MEDIUM.
 */
export function validateComposedConfigs(doc: unknown, entries: ComposedEntry[]): {
  violations: ConfigViolation[];
  unjudged: string[];
  checked: number;
} {
  const slots = extractConfigSlots(doc);
  if (slots.size === 0) {
    return {
      violations: [],
      unjudged: entries.map((e) => e.id ?? e.name),
      checked: 0,
    };
  }

  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateFormats: false,
    allowUnionTypes: true,
  });
  const ROOT = "cg-schema";
  try {
    ajv.addSchema(doc as object, ROOT);
  } catch (error) {
    return {
      violations: [],
      unjudged: entries.map((e) => e.id ?? e.name),
      checked: 0,

    };
  }

  const violations: ConfigViolation[] = [];
  const unjudged: string[] = [];
  let checked = 0;

  for (const entry of entries) {
    const label = entry.id ?? entry.name;
    if (entry.config === undefined || entry.config === null) {
      // Omitted config: the host applies the schema's defaults. Not a finding,
      // and not an unjudged entry either.
      continue;
    }
    const slot = slots.get(entry.name);
    if (slot === undefined || slot.unknown) {
      // No branch, or the host declares no schema for this plugin. Both are
      // "cannot judge", never "passes".
      unjudged.push(label);
      continue;
    }
    if (isJsExpr(entry.config)) {
      unjudged.push(label);
      continue;
    }

    let validate: AjvValidateFn | undefined;
    if (slot.ref !== null) {
      // ajv keys a schema registered under "cg-schema" as "cg-schema#/...".
      // Stripping the "#" produced "cg-schema/$defs/configN", which always missed.
      validate = ajv.getSchema(`${ROOT}${slot.ref}`);
    } else if (slot.inline !== null) {
      try {
        validate = ajv.compile(slot.inline as object) as AjvValidateFn;
      } catch {
        validate = undefined;
      }
    }
    if (validate === undefined) {
      unjudged.push(label);
      continue;
    }

    checked += 1;
    if (validate(entry.config)) continue;

    for (const err of validate.errors ?? []) {
      const keyword = err.keyword ?? "invalid";
      violations.push({
        entryId: entry.id,
        entryName: entry.name,
        keyword,
        instancePath: err.instancePath ? err.instancePath : "/",
        message: err.message ?? "does not satisfy the schema",
      });
    }
  }

  return { violations, unjudged, checked };
}

/** Full item 9 pass: dump schema, dump composed tree, validate. */
export async function checkConfigCompatibility(
  handle: IsolateHandle,
  timeoutMs = 60_000,
): Promise<ConfigCheckResult> {
  const { dump, doc } = await dumpConfigSchema(handle, timeoutMs);
  if (!dump.ok || doc === null) {
    return {
      schema: dump,
      composed: { ok: false, rc: null, entries: [], stderr: "" },
      violations: [],
      unjudged: [],
      checked: 0,
      slots: 0,
      entries: 0,
      withConfig: 0,
    };
  }

  const composed = await dumpComposedEntries(handle, timeoutMs);
  if (!composed.ok) {
    return {
      schema: dump,
      composed,
      violations: [],
      unjudged: [],
      checked: 0,
      slots: extractConfigSlots(doc).size,
      entries: 0,
      withConfig: 0,
    };
  }

  const result = validateComposedConfigs(doc, composed.entries);
  return {
    schema: dump,
    composed,
    violations: result.violations,
    unjudged: result.unjudged,
    checked: result.checked,
    slots: extractConfigSlots(doc).size,
    entries: composed.entries.length,
    withConfig: composed.entries.filter((e) => e.config !== undefined && e.config !== null).length,
  };
}

/** Level for one violation, per the plan's item 9 thresholds. */
export function levelForViolation(violation: ConfigViolation): "HIGH" | "MEDIUM" {
  if (violation.keyword === "required" || violation.keyword === "type") return "HIGH";
  return "MEDIUM";
}
