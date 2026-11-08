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
];
const MANIFEST_FILE = "manifest.json";
export function backupRoot(stateDir) {
    return join(stateDir, "backups");
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return null;
    }
}
function readBundles(profileDir) {
    const manifest = readJson(join(profileDir, "package.json"));
    const dsh = manifest?.dsh;
    const bundles = dsh?.profile?.bundles;
    return Array.isArray(bundles) ? bundles.filter((b) => typeof b === "string") : [];
}
function readPlugins(profileDir) {
    const manifest = readJson(join(profileDir, "package.json"));
    const deps = manifest?.dependencies;
    if (deps === undefined || deps === null || typeof deps !== "object")
        return [];
    const out = [];
    for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== "string")
            continue;
        let version = spec;
        if (spec.startsWith("link:") || spec.startsWith("file:")) {
            const pkg = readJson(join(spec.replace(/^(link:|file:)/, ""), "package.json"));
            if (typeof pkg?.version === "string")
                version = pkg.version;
        }
        out.push({ name, version, spec });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
/** dsh.profile.bundles order is the thing that actually decides what loads. */
export function createBackup(profileDir, stateDir, label = "") {
    const createdAt = new Date().toISOString();
    const id = createdAt.replace(/[:.]/g, "-") + (label === "" ? "" : `-${label}`);
    const dir = join(backupRoot(stateDir), id);
    mkdirSync(dir, { recursive: true });
    const files = [];
    for (const name of BACKUP_FILES) {
        const src = join(profileDir, name);
        if (!existsSync(src))
            continue;
        copyFileSync(src, join(dir, name));
        files.push(name);
    }
    const entry = {
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
export function listBackups(stateDir) {
    const root = backupRoot(stateDir);
    if (!existsSync(root))
        return [];
    const out = [];
    for (const id of readdirSync(root)) {
        const manifest = readJson(join(root, id, MANIFEST_FILE));
        if (manifest !== null && typeof manifest.id === "string")
            out.push(manifest);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/**
 * Put a snapshot's files back. A safety snapshot is always taken first.
 * Never touches node_modules: the packages on disk are whatever the installer left there.
 */
export function restoreBackup(stateDir, profileDir, id) {
    const backups = listBackups(stateDir);
    if (backups.length === 0)
        throw new Error(`no backup found under ${backupRoot(stateDir)}`);
    const source = id === undefined || id === "" ? backups[0] : backups.find((b) => b.id === id);
    if (source === undefined) {
        throw new Error(`backup ${JSON.stringify(id)} not found; available: ${backups.map((b) => b.id).slice(0, 5).join(", ")}`);
    }
    const safety = createBackup(profileDir, stateDir, "pre-restore");
    const dir = join(backupRoot(stateDir), source.id);
    const restored = [];
    for (const name of BACKUP_FILES) {
        const src = join(dir, name);
        if (!existsSync(src))
            continue;
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
