/**
 * Stage 0 — collect.
 *
 * Read-only. Everything the later stages need is gathered here so that a failure further
 * down cannot leave the pipeline half-informed.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, PluginManifest } from "./types.js";

/**
 * The host version is only compared against @deepseek-ai/dsh and @deepseek-ai/dsh-*.
 * @deepseek-ai/cordis shares the @deepseek-ai scope but has an independent version line
 * (currently 4.x), so comparing it against the host version produces false BLOCKERs on
 * every bundle. The host's own preflight excludes it for the same reason.
 */
const HOST_PEER_RE = /^@deepseek-ai\/dsh(?:-.+)?$/;
const HOST_DEP_RE = /^@deepseek-ai\/dsh(?:-.+)?$/;
const CORDIS_RE = /^@deepseek-ai\/cordis$/;

function readJson<T = Record<string, unknown>>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function pickHostEntries(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof source !== "object" || source === null) return out;
  for (const [name, range] of Object.entries(source as Record<string, unknown>)) {
    if (typeof range === "string" && HOST_PEER_RE.test(name)) out[name] = range;
  }
  return out;
}

function pickHostDeps(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof source !== "object" || source === null) return out;
  for (const [name, range] of Object.entries(source as Record<string, unknown>)) {
    if (typeof range === "string" && HOST_DEP_RE.test(name)) out[name] = range;
  }
  return out;
}

function pickCordis(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof source !== "object" || source === null) return out;
  for (const [name, range] of Object.entries(source as Record<string, unknown>)) {
    if (typeof range === "string" && CORDIS_RE.test(name)) out[name] = range;
  }
  return out;
}

function resolveEntry(dir: string, raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined;
  const exportsField = raw.exports as Record<string, unknown> | undefined;
  const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  if (exportsField && typeof exportsField === "object") {
    const dot = (exportsField as Record<string, unknown>)["."];
    const direct = asString(dot);
    if (direct) return join(dir, direct);
    if (dot && typeof dot === "object") {
      const d = dot as Record<string, unknown>;
      const candidate = asString(d.default) ?? asString(d.import) ?? asString(d.require);
      if (candidate) return join(dir, candidate);
    }
  }
  const main = asString(raw.main);
  if (main) return join(dir, main);
  return undefined;
}

export interface CollectOptions {
  profileDir: string;
  fromVersion: string;
  toVersion: string;
  /** Optional override; usually derived from the manifest bundle list. */
  bundles?: string[];
}

export function collect(options: CollectOptions): Context {
  const { profileDir, fromVersion, toVersion } = options;

  const manifestPath = join(profileDir, "package.json");
  const manifest = readJson<Record<string, any>>(manifestPath);
  if (!manifest) throw new Error(`cannot read profile manifest: ${manifestPath}`);

  const bundles: string[] =
    options.bundles ??
    (manifest.dsh?.profile?.bundles as string[] | undefined) ??
    [];

  const plugins: PluginManifest[] = bundles.map((name) => {
    const dir = join(profileDir, "node_modules", name);
    const pkgPath = join(dir, "package.json");
    const raw = readJson<Record<string, any>>(pkgPath);
    if (!raw) {
      return {
        name,
        version: "(missing)",
        dir,
        present: false,
        hostPeers: {},
        hostDeps: {},
        cordisRanges: {},
      };
    }
    const dsh = (raw.dsh ?? {}) as Record<string, any>;
    return {
      name: typeof raw.name === "string" ? raw.name : name,
      version: typeof raw.version === "string" ? raw.version : "(unknown)",
      dir,
      present: true,
      raw,
      enginesDsh: typeof dsh.engines?.dsh === "string" ? dsh.engines.dsh : undefined,
      dshReleases:
        dsh.compatibility?.dshReleases && typeof dsh.compatibility.dshReleases === "object"
          ? (dsh.compatibility.dshReleases as Record<string, string>)
          : undefined,
      bundlePatch: typeof dsh.bundle?.patch === "string" ? dsh.bundle.patch : undefined,
      clientInject: Array.isArray(dsh.client?.inject)
        ? (dsh.client.inject as string[])
        : undefined,
      hostPeers: pickHostEntries(raw.peerDependencies),
      hostDeps: pickHostDeps(raw.dependencies),
      cordisRanges: {
        ...pickCordis(raw.peerDependencies),
        ...pickCordis(raw.dependencies),
      },
      entryFile: resolveEntry(dir, raw),
    };
  });

  const exemptions: Record<string, string[]> = {};
  const compatPath = join(profileDir, "compatibility.json");
  if (existsSync(compatPath)) {
    const parsed = readJson<Record<string, unknown>>(compatPath);
    if (parsed) {
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) exemptions[key] = value.filter((v): v is string => typeof v === "string");
      }
    }
  }

  const pluginSetHash = createHash("sha256")
    .update(
      [...bundles]
        .sort()
        .map((b) => {
          const p = plugins.find((x) => x.name === b);
          return `${b}@${p?.version ?? "missing"}`;
        })
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    profileDir,
    fromVersion,
    toVersion,
    bundles,
    runtimeBundles: [],
    skippedRuntime: [],
    plugins,
    exemptions,
    generatedAt: new Date().toISOString(),
    pluginSetHash,
  };
}
