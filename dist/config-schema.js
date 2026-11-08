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
import { resolveDshBin } from "./isolate.js";
/**
 * ajv ships as CJS. Under NodeNext a default import resolves to the module
 * namespace, which is not constructable, so load it through require and unwrap
 * the CJS/default interop by hand.
 */
const nodeRequire = createRequire(import.meta.url);
const ajvModule = nodeRequire("ajv/dist/2020.js");
const Ajv2020 = typeof ajvModule === "function" ? ajvModule : ajvModule.default;
const SKIP_BUNDLE_RE = /^dsh: skipping profile bundle "(.+?)":/gm;
const JS_TAG = new yaml.Type("tag:yaml.org,2002:js", {
    kind: "scalar",
    construct: (data) => ({ __jsExpr: data }),
});
const YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_TAG]);
function runDsh(handle, extraArgs, timeoutMs) {
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
        const finish = (rc, note) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (note)
                stderr += `\n[compat-guard] ${note}`;
            resolve({ rc, stdout, stderr });
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch {
                /* already gone */
            }
            finish(null, `schema command exceeded ${timeoutMs}ms`);
        }, timeoutMs);
        timer.unref?.();
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
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
export async function dumpConfigSchema(handle, timeoutMs = 60_000) {
    const run = await runDsh(handle, ["--dump-config-schema"], timeoutMs);
    const skipped = [...run.stderr.matchAll(SKIP_BUNDLE_RE)].map((m) => m[1]);
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
        const doc = JSON.parse(run.stdout);
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
    }
    catch (error) {
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
function countEntryBranches(doc) {
    const entry = doc?.$defs?.entry;
    return Array.isArray(entry?.allOf) ? entry.allOf.length : 0;
}
/** Composed (post-patch) entry list, i.e. what the host will actually mount. */
export async function dumpComposedEntries(handle, timeoutMs = 60_000) {
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
        const entries = [];
        for (const row of loaded) {
            if (row === null || typeof row !== "object")
                continue;
            const rec = row;
            const name = typeof rec.name === "string" ? rec.name : null;
            if (name === null)
                continue;
            entries.push({
                id: typeof rec.id === "string" ? rec.id : null,
                name,
                config: rec.config,
                disabled: rec.disabled,
            });
        }
        return { ok: true, rc: run.rc, entries, stderr: run.stderr };
    }
    catch (error) {
        return {
            ok: false,
            rc: run.rc,
            entries: [],
            stderr: run.stderr,
            error: `composed tree is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
export function extractConfigSlots(doc) {
    const slots = new Map();
    const entry = doc?.$defs?.entry;
    if (!Array.isArray(entry?.allOf))
        return slots;
    for (const branch of entry.allOf) {
        const rec = branch;
        const name = rec?.if?.properties?.name?.const;
        if (typeof name !== "string")
            continue;
        const cfg = rec?.then?.properties?.config;
        if (cfg === undefined || cfg === null || typeof cfg !== "object") {
            slots.set(name, { ref: null, inline: null, unknown: true });
            continue;
        }
        let ref = typeof cfg.$ref === "string" ? cfg.$ref : null;
        if (ref === null && Array.isArray(cfg.anyOf)) {
            for (const alt of cfg.anyOf) {
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
        const looksLikeSchema = typeof cfg.type === "string" || cfg.properties !== undefined || cfg.anyOf !== undefined;
        slots.set(name, {
            ref: null,
            inline: looksLikeSchema ? cfg : null,
            unknown: !looksLikeSchema,
        });
    }
    return slots;
}
/** Kept for callers that only need the reference form. */
export function extractConfigRefs(doc) {
    const refs = new Map();
    for (const [name, slot] of extractConfigSlots(doc)) {
        if (slot.ref !== null && !slot.unknown)
            refs.set(name, slot.ref);
    }
    return refs;
}
function isJsExpr(value) {
    return (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, "__jsExpr"));
}
/**
 * Validate every composed entry's config against its plugin's schema branch.
 *
 * A missing `required` field or a wrong primitive type is HIGH: the plugin
 * receives a config its own schema rejects, which ranges from silently falling
 * back to defaults to throwing in `apply`. Anything else is MEDIUM.
 */
export function validateComposedConfigs(doc, entries) {
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
        ajv.addSchema(doc, ROOT);
    }
    catch (error) {
        return {
            violations: [],
            unjudged: entries.map((e) => e.id ?? e.name),
            checked: 0,
        };
    }
    const violations = [];
    const unjudged = [];
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
        let validate;
        if (slot.ref !== null) {
            // ajv keys a schema registered under "cg-schema" as "cg-schema#/...".
            // Stripping the "#" produced "cg-schema/$defs/configN", which always missed.
            validate = ajv.getSchema(`${ROOT}${slot.ref}`);
        }
        else if (slot.inline !== null) {
            try {
                validate = ajv.compile(slot.inline);
            }
            catch {
                validate = undefined;
            }
        }
        if (validate === undefined) {
            unjudged.push(label);
            continue;
        }
        checked += 1;
        if (validate(entry.config))
            continue;
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
export async function checkConfigCompatibility(handle, timeoutMs = 60_000) {
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
export function levelForViolation(violation) {
    if (violation.keyword === "required" || violation.keyword === "type")
        return "HIGH";
    return "MEDIUM";
}
