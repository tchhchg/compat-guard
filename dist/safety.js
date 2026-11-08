/**
 * Safety layer. This module is intentionally dependency-free and has no imports from
 * other modules in this package, because everything else depends on it being correct.
 *
 * Two hard rules it enforces:
 *  1. Some plugins mutate the *real* host installation when mounted (dsh-purge rewrites
 *     app.asar). Those must never enter the isolated profile, or the isolation becomes
 *     the attacker.
 *  2. A junction must be removed with `rmdir`, never with a recursive delete, because a
 *     recursive delete walks through the link and destroys the real node_modules.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync, } from "node:fs";
import { join } from "node:path";
/**
 * Plugins that write to the host installation directory when mounted.
 * Evidence: dsh-purge applies patches to app.asar / system-prompt / agent-loop on load.
 * Anything added here is excluded from the isolated host AND flagged in the report.
 */
export const HOST_MUTATING_PLUGINS = new Set(["dsh-purge"]);
/**
 * Bundles allowed into the isolated host in M0.
 *
 * M0 uses an allowlist rather than a denylist on purpose: only one host-mutating plugin
 * has been proven so far, and an unknown plugin that writes to the host would turn the
 * checker into the thing it is meant to prevent. Everything outside this list still gets
 * full static scanning and is reported as "not runtime-verified".
 *
 * (待补充：逐插件核对 dsh.bundle.patch 与代码中的宿主路径写入，把结论并入
 * HOST_MUTATING_PLUGINS，再逐步撤掉白名单。)
 */
export const RUNTIME_ALLOWLIST = new Set([
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-pet",
    "dsh-free-search",
    "dsh-cost-meter",
    "dsh-prompt-enhance",
    "dsh-better-sidebar",
    "dsh-whale-widget",
]);
export function isAllowlistedForRuntime(bundle) {
    return RUNTIME_ALLOWLIST.has(bundle) && !HOST_MUTATING_PLUGINS.has(bundle);
}
/** True for a Windows junction or a symlink (Node reports both via isSymbolicLink). */
export function isLink(path) {
    try {
        return lstatSync(path).isSymbolicLink();
    }
    catch {
        return false;
    }
}
/**
 * Delete a directory tree without ever following a link.
 *
 * `rmSync(recursive)` on a junction is not safe across Node/Windows versions: depending on
 * the version it either fails with EPERM or resolves the target. Walking the tree manually
 * and dispatching links to `rmdir` is the only form that is safe on every path.
 */
export function removeTreeSafe(target, log) {
    if (!existsSync(target))
        return;
    if (isLink(target)) {
        try {
            execFileSync("cmd", ["/c", "rmdir", target], { stdio: "ignore" });
            log(`rmdir link: ${target}`);
        }
        catch (error) {
            log(`WARN failed to rmdir link ${target}: ${String(error)}`);
        }
        return;
    }
    let stat;
    try {
        stat = lstatSync(target);
    }
    catch {
        return;
    }
    if (!stat.isDirectory()) {
        try {
            rmSync(target, { force: true });
        }
        catch (error) {
            log(`WARN failed to remove file ${target}: ${String(error)}`);
        }
        return;
    }
    let entries = [];
    try {
        entries = readdirSync(target);
    }
    catch (error) {
        log(`WARN failed to list ${target}: ${String(error)}`);
    }
    for (const entry of entries)
        removeTreeSafe(join(target, entry), log);
    try {
        // rmdirSync, not rmSync: rmSync on a directory that is now empty still reports
        // ERR_FS_EISDIR on Windows unless recursive is set, and recursive is exactly what we
        // must not use here.
        rmdirSync(target);
    }
    catch (error) {
        log(`WARN failed to remove dir ${target}: ${String(error)}`);
    }
}
/**
 * Create a directory junction. Uses PowerShell because `mklink` needs a cmd shell and
 * quoting through `cmd /c` breaks on paths containing spaces (observed with the host path).
 */
export function createJunction(linkPath, targetPath) {
    const script = `New-Item -ItemType Junction -Path '${linkPath.replace(/'/g, "''")}' ` +
        `-Target '${targetPath.replace(/'/g, "''")}' | Out-Null`;
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: "pipe",
    });
}
/** Refuse to run against an obviously wrong profile directory. */
export function assertProfileDir(profileDir) {
    const manifest = join(profileDir, "package.json");
    if (!existsSync(manifest)) {
        throw new Error(`not a DSH profile directory (no package.json): ${profileDir}`);
    }
    if (!existsSync(join(profileDir, "node_modules"))) {
        throw new Error(`profile has no node_modules: ${profileDir}`);
    }
}
/** True when a process is listening on the port (used to detect the running host). */
export function portInUse(port) {
    try {
        // netstat is present on every supported Windows; avoids importing node:net twice.
        const out = execFileSync("cmd", ["/c", `netstat -ano | findstr ":${port}"`], {
            stdio: "pipe",
            encoding: "utf8",
        });
        return /LISTENING/i.test(out);
    }
    catch {
        return false;
    }
}
