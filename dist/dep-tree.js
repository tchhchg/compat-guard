/**
 * Dependency resolution survey — check item 7 (multiple major versions).
 *
 * The profile uses a hoisted real directory (not a symlink farm), so a package
 * resolved to two different majors appears as a nested `node_modules` below
 * some dependent. We walk the physical tree instead of asking a package manager,
 * because the profile's node_modules is already materialised and asking pnpm
 * would mutate it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const MAX_DEPTH = 4;
const MAX_PACKAGES = 20000;
const SKIP = new Set([".bin", ".cache", ".pnpm", ".modules.yaml"]);
function readPackage(dir) {
    try {
        const raw = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (typeof raw.name !== "string" || typeof raw.version !== "string")
            return null;
        return { name: raw.name, version: raw.version };
    }
    catch {
        return null;
    }
}
function majorOf(version) {
    const m = /^(\d+)\./.exec(version);
    return m ? m[1] : version;
}
/**
 * Walk a `node_modules` tree and report packages resolved to multiple majors.
 *
 * @param modulesRoot — the profile's `node_modules`.
 */
export function surveyDependencies(modulesRoot) {
    const instances = [];
    let truncated = false;
    const walkModules = (modulesDir, depth, prefix) => {
        if (depth > MAX_DEPTH || truncated)
            return;
        let entries;
        try {
            entries = readdirSync(modulesDir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (truncated)
                return;
            if (SKIP.has(entry) || entry.startsWith("."))
                continue;
            const names = entry.startsWith("@")
                ? (() => {
                    try {
                        return readdirSync(join(modulesDir, entry)).map((n) => `${entry}/${n}`);
                    }
                    catch {
                        return [];
                    }
                })()
                : [entry];
            for (const name of names) {
                const dir = join(modulesDir, name);
                let st;
                try {
                    st = statSync(dir);
                }
                catch {
                    continue;
                }
                if (!st.isDirectory())
                    continue;
                const pkg = readPackage(dir);
                if (pkg) {
                    instances.push({ name: pkg.name, version: pkg.version, path: `${prefix}${name}` });
                    if (instances.length >= MAX_PACKAGES) {
                        truncated = true;
                        return;
                    }
                }
                // Nested tree: only follow it when the package actually has one.
                walkModules(join(dir, "node_modules"), depth + 1, `${prefix}${name} > `);
            }
        }
    };
    walkModules(modulesRoot, 0, "");
    const byName = new Map();
    for (const inst of instances) {
        const list = byName.get(inst.name);
        if (list)
            list.push(inst);
        else
            byName.set(inst.name, [inst]);
    }
    const collisions = [];
    for (const [name, list] of byName) {
        const majors = [...new Set(list.map((i) => majorOf(i.version)))];
        if (majors.length > 1)
            collisions.push({ name, instances: list, majors });
    }
    collisions.sort((a, b) => a.name.localeCompare(b.name));
    return { instances, collisions, truncated };
}
