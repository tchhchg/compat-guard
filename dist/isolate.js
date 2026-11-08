/**
 * Isolated host launcher.
 *
 * The recipe implemented here was validated against the real host before this file was
 * written. Four non-obvious constraints are load-bearing, each one cost a failed run:
 *
 *  1. Renaming the profile is NOT enough. Plugins still write the real `~/.dsh/storages`,
 *     so `DSH_HOME` must be redirected. (dsh-cost-meter printed the real ledger path.)
 *  2. Redefining DSH_HOME alone breaks profile lookup, because `profiles/` lives under it.
 *     The profile has to be copied into `$DSH_HOME/profiles/` as well.
 *  3. The app arguments must NOT include the app name: `--profile X web --host` fails with
 *     "too many arguments. Expected 0 arguments but got 1: web." The app comes from the
 *     profile; `dsh web` is just shorthand for `dsh --profile web`.
 *  4. `spawn(dshCmd, args, { shell: true })` breaks on the space in "DeepSeek Harness".
 *     The command must go through ComSpec with per-argument quoting.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJunction, removeTreeSafe } from "./safety.js";
import { parseSignals } from "./signal.js";
const PROBE_NAME = "compat-guard-probe";
const CONFIG_FILES = ["cordis.yml", "cordis.patch.yml"];
/**
 * Live isolated hosts. Registered so an outer budget watchdog can kill them
 * before exiting: process.exit tears down this process but NOT a spawned host,
 * which would leak a listening port and a ~200MB process per timeout.
 */
const activeChildren = new Set();
/**
 * Kill every isolated host still running. Returns how many were signalled.
 * Safe to call at any time; teardown() only removes files.
 */
export function killActiveChildren() {
    let killed = 0;
    for (const child of activeChildren) {
        try {
            killTree(child);
            killed += 1;
        }
        catch {
            // A child that already died is not an error.
        }
    }
    activeChildren.clear();
    return killed;
}
export function resolveDshBin() {
    const fromEnv = process.env.DSH_BIN;
    if (fromEnv && existsSync(fromEnv))
        return fromEnv;
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
        const candidate = join(localAppData, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd");
        if (existsSync(candidate))
            return candidate;
    }
    throw new Error("cannot locate dsh.cmd; set DSH_BIN to the host CLI path");
}
function pickPort(preferred) {
    if (preferred !== undefined)
        return preferred;
    // 17000-19000 was verified free on this machine; collisions are handled by the caller.
    return 17000 + Math.floor(Math.random() * 2000);
}
/**
 * Build the disposable profile. Nothing here writes to `profileDir`: reads only.
 */
export function prepareIsolation(options) {
    const { profileDir, runtimeBundles, log } = options;
    const tmpHome = mkdtempSync(join(tmpdir(), "cg-home-"));
    const probeDir = join(tmpHome, "profiles", PROBE_NAME);
    mkdirSync(probeDir, { recursive: true });
    const sourceManifestPath = join(profileDir, "package.json");
    const manifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
    const rewritten = {
        ...manifest,
        dsh: {
            ...(manifest.dsh ?? {}),
            profile: { ...(manifest.dsh?.profile ?? {}), bundles: runtimeBundles },
        },
    };
    writeFileSync(join(probeDir, "package.json"), JSON.stringify(rewritten, null, 2) + "\n", "utf8");
    for (const file of CONFIG_FILES) {
        const src = join(profileDir, file);
        if (existsSync(src))
            copyFileSync(src, join(probeDir, file));
    }
    createJunction(join(probeDir, "node_modules"), join(profileDir, "node_modules"));
    log(`isolated home: ${tmpHome}`);
    log(`isolated profile: ${probeDir} (bundles=${runtimeBundles.length})`);
    return { tmpHome, probeName: PROBE_NAME, probeDir, port: pickPort(options.port), log };
}
function canConnect(port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const done = (ok) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
    });
}
async function waitForPort(port, deadline) {
    const started = Date.now();
    while (Date.now() < deadline) {
        if (await canConnect(port, 300))
            return Date.now() - started;
        await new Promise((r) => setTimeout(r, 120));
    }
    return null;
}
function killTree(child) {
    if (child.pid === undefined)
        return;
    try {
        // The launcher is cmd -> node; killing only the child leaves the node grandchild
        // holding the port and the stdout pipe.
        spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
            stdio: "ignore",
            windowsHide: true,
        });
    }
    catch {
        /* best effort */
    }
}
/**
 * Launch the isolated host and wait for it to listen.
 * Never throws for a host-side failure: it returns a LoadResult with `setupError` set so
 * the caller can classify "host would not start" separately from "a plugin crashed".
 */
export async function launchIsolated(handle, options) {
    const { timeoutMs, log } = options;
    const startedAt = Date.now();
    let dshBin;
    try {
        dshBin = resolveDshBin();
    }
    catch (error) {
        return failedResult(handle.port, `cannot locate host CLI: ${String(error)}`);
    }
    // `--no-open` matters: without it the isolated host launches the default browser on this
    // machine. A compatibility check must never steal focus or leave windows behind.
    const argv = [
        "--profile",
        handle.probeName,
        "--host",
        "127.0.0.1",
        "--port",
        String(handle.port),
        "--no-open",
    ];
    // Two layers of quoting are required. The inner layer protects argument boundaries; the
    // outer layer exists because `cmd /s /c` strips the first and last quote of the command
    // string when it starts with a quote. Without the outer pair, the space in
    // "DeepSeek Harness" splits the executable path and cmd reports
    // "'C:\...\DeepSeek Harness' is not recognized" — the install path contains a
    // space, and `shell: true` split it before the arguments were even seen.
    const inner = `"${dshBin}" ${argv.map((a) => `"${a}"`).join(" ")}`;
    const commandLine = `"${inner}"`;
    log(`spawn: ${commandLine}`);
    let child;
    try {
        child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
            env: { ...process.env, DSH_HOME: handle.tmpHome },
            shell: false,
            windowsVerbatimArguments: true,
            windowsHide: true,
        });
    }
    catch (error) {
        return failedResult(handle.port, `spawn failed: ${String(error)}`);
    }
    let stdout = "";
    let stderr = "";
    activeChildren.add(child);
    child.on("close", () => {
        activeChildren.delete(child);
    });
    child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
    });
    const exited = new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
    });
    const deadline = startedAt + timeoutMs;
    let readyAt = null;
    let readyBy = null;
    let announcedUrl = null;
    // Poll the port and the process concurrently: a crash before listening is the crash we
    // most want to catch, and waiting the full timeout for it would waste the hook budget.
    const exitWatcher = exited.then((code) => ({ kind: "exit", code }));
    const portWatcher = waitForPort(handle.port, deadline).then((ms) => ({ kind: "port", ms }));
    const winner = await Promise.race([exitWatcher, portWatcher]);
    if (winner.kind === "port" && winner.ms !== null) {
        readyAt = winner.ms;
        readyBy = "port";
    }
    else if (winner.kind === "exit") {
        // The process died before listening. Give the port watcher no more time.
        readyBy = "process-exit";
    }
    // A listening socket is NOT the same as a browsable UI: the web app answers 401 on "/"
    // until the browser presents the process-scoped launch token, and that token is only ever
    // printed to stdout once the loader settles. Measured gap on this machine: ~1.6s after
    // bind. Waiting for the line is what makes stage 2b possible at all.
    if (readyAt !== null) {
        const urlDeadline = Math.min(deadline, Date.now() + 30_000);
        while (Date.now() < urlDeadline) {
            const match = /dsh web:\s*(http:\/\/\S+)/.exec(stdout);
            if (match !== null && match[1] !== undefined) {
                announcedUrl = match[1];
                break;
            }
            await new Promise((r) => setTimeout(r, 150));
        }
        if (announcedUrl !== null)
            readyBy = "url";
    }
    let killedByTimeout = false;
    if (readyAt === null && readyBy === null) {
        killedByTimeout = true;
    }
    // Stage 2b window: the host is listening but still alive. A hung probe must not leak the
    // process, so the callback gets its own hard cap independent of the load timeout.
    if (readyAt !== null && options.onReady) {
        const STAGE2B_CAP_MS = 45_000;
        try {
            await Promise.race([
                options.onReady({ port: handle.port, url: announcedUrl }),
                new Promise((resolve) => {
                    const t = setTimeout(() => {
                        log(`stage 2b exceeded ${STAGE2B_CAP_MS}ms; abandoning the client probe`);
                        resolve();
                    }, STAGE2B_CAP_MS);
                    t.unref?.();
                }),
            ]);
        }
        catch (error) {
            // A broken probe is not a broken plugin: swallow and let the caller record UNKNOWN.
            log(`stage 2b error: ${String(error)}`);
        }
    }
    // Always stop the host: on success the port is occupied and must be released.
    killTree(child);
    const exitCode = await Promise.race([
        exited,
        new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    if (readyAt === null && Date.now() - startedAt >= timeoutMs)
        killedByTimeout = true;
    const signals = parseSignals(stderr);
    return {
        ready: readyAt !== null,
        readyBy,
        readyAtMs: readyAt,
        url: announcedUrl,
        exitCode,
        killedByTimeout,
        stdout,
        stderr,
        port: handle.port,
        signals,
    };
}
function failedResult(port, message) {
    return {
        ready: false,
        readyBy: null,
        readyAtMs: null,
        url: null,
        exitCode: null,
        killedByTimeout: false,
        stdout: "",
        stderr: message,
        port,
        setupError: message,
        signals: [],
    };
}
export function teardown(handle) {
    handle.log(`teardown: ${handle.tmpHome}`);
    removeTreeSafe(handle.tmpHome, handle.log);
}
/** Copy the isolated host's stderr/stdout next to the report for post-mortem. */
export function persistLogs(handle, result, outDir) {
    // Same rule as check.ts: keep out/ limited to timestamped report directories.
    mkdirSync(join(outDir, "_archive"), { recursive: true });
    const path = join(outDir, "_archive", "isolated-host.log");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
        `# isolated home: ${handle.tmpHome}`,
        `# profile: ${handle.probeDir}`,
        `# port: ${handle.port}`,
        `# ready: ${result.ready} (${result.readyBy}) at ${result.readyAtMs ?? "-"}ms`,
        `# exitCode: ${result.exitCode}  killedByTimeout: ${result.killedByTimeout}`,
        "",
        "## stdout",
        result.stdout,
        "",
        "## stderr",
        result.stderr,
    ].join("\n"), "utf8");
    return path;
}
