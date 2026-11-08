/**
 * Version backup and rollback.
 *
 * The checker used to end at "here is what will break". This adds the other half:
 * a restorable snapshot of the files that decide *which* plugins load, taken before
 * an update and restorable afterwards.
 *
 * Scope is deliberately narrow — four files, never `node_modules`:
 *   package.json          dsh.profile.bundles (the list that decides what loads)
 *   cordis.yml            the profile root entry list
 *   cordis.patch.yml      user overrides and per-row config
 *   compatibility.json    granted exact-version exemptions (when present)
 *
 * Restoring rewrites those files only. It does not install, remove or downgrade a
 * single package, so a rollback can always be undone by restoring the snapshot that
 * is taken automatically right before it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The only files a snapshot may contain, in restore order. */
export const BACKUP_FILES = [
  "package.json",
  "cordis.yml",
  "cordis.patch.yml",
  "compatibility.json",
] as const;

export interface BackupPlugin {
  name: string;
  version: string;
  /** `link:` / `file:` / registry spec, straight from the profile's dependencies. */
  spec: string;
}

export interface BackupEntry {
  /** Directory name, also the id accepted by restore. */
  id: string;
  createdAt: string;
  profileDir: string;
  /** Files actually copied (absent ones are skipped, not faked). */
  files: string[];
  /** Bundle order at snapshot time — the thing a rollback really restores. */
  bundles: string[];
  plugins: BackupPlugin[];
}

const MANIFEST_FILE = "manifest.json";

export function backupRoot(stateDir: string): string {
  return join(stateDir, "backups");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readBundles(profileDir: string): string[] {
  const manifest = readJson(join(profileDir, "package.json"));
  const dsh = manifest?.dsh as { profile?: { bundles?: unknown } } | undefined;
  const bundles = dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles.filter((b): b is string => typeof b === "string") : [];
}

function readPlugins(profileDir: string): BackupPlugin[] {
  const manifest = readJson(join(profileDir, "package.json"));
  const deps = manifest?.dependencies;
  if (deps === undefined || deps === null || typeof deps !== "object") return [];
  const out: BackupPlugin[] = [];
  for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof spec !== "string") continue;
    let version = spec;
    if (spec.startsWith("link:") || spec.startsWith("file:")) {
      const pkg = readJson(join(spec.replace(/^(link:|file:)/, ""), "package.json"));
      if (typeof pkg?.version === "string") version = pkg.version;
    }
    out.push({ name, version, spec });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** dsh.profile.bundles order is the thing that actually decides what loads. */
export function createBackup(profileDir: string, stateDir: string, label = ""): BackupEntry {
  const createdAt = new Date().toISOString();
  const id = createdAt.replace(/[:.]/g, "-") + (label === "" ? "" : `-${label}`);
  const dir = join(backupRoot(stateDir), id);
  mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  for (const name of BACKUP_FILES) {
    const src = join(profileDir, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(dir, name));
    files.push(name);
  }

  const entry: BackupEntry = {
    id,
    createdAt,
    profileDir,
    files,
    bundles: readBundles(profileDir),
    plugins: readPlugins(profileDir),
  };
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(entry, null, 2) + "\n", "utf8");
  return entry;
}

export function listBackups(stateDir: string): BackupEntry[] {
  const root = backupRoot(stateDir);
  if (!existsSync(root)) return [];
  const out: BackupEntry[] = [];
  for (const id of readdirSync(root)) {
    const manifest = readJson(join(root, id, MANIFEST_FILE)) as BackupEntry | null;
    if (manifest !== null && typeof manifest.id === "string") out.push(manifest);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface RestoreResult {
  restored: string[];
  /** Snapshot taken immediately before the restore, so the restore itself is undoable. */
  safetyBackupId: string;
  /** Bundles the profile now declares, read back after writing. */
  bundles: string[];
  source: BackupEntry;
}

/**
 * Put a snapshot's files back. A safety snapshot is always taken first.
 * Never touches node_modules: the packages on disk are whatever the installer left there.
 */
export function restoreBackup(stateDir: string, profileDir: string, id?: string): RestoreResult {
  const backups = listBackups(stateDir);
  if (backups.length === 0) throw new Error(`no backup found under ${backupRoot(stateDir)}`);

  const source = id === undefined || id === "" ? backups[0]! : backups.find((b) => b.id === id);
  if (source === undefined) {
    throw new Error(
      `backup ${JSON.stringify(id)} not found; available: ${backups.map((b) => b.id).slice(0, 5).join(", ")}`,
    );
  }

  const safety = createBackup(profileDir, stateDir, "pre-restore");

  const dir = join(backupRoot(stateDir), source.id);
  const restored: string[] = [];
  for (const name of BACKUP_FILES) {
    const src = join(dir, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(profileDir, name));
    restored.push(name);
  }

  return {
    restored,
    safetyBackupId: safety.id,
    bundles: readBundles(profileDir),
    source,
  };
}
