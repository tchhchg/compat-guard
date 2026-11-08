/**
 * compat-guard-panel — Host half.
 *
 * Exposes the existing checker over the Web GUI's own HTTP carrier:
 *
 *   GET  /compat-guard/state    current run state + last result
 *   POST /compat-guard/run      start a run ({ "to": "0.2.3-rc.1" } optional)
 *   GET  /compat-guard/report   the newest report.md as text/markdown
 *
 * It does not reimplement any rule: every run spawns the existing
 * `dist/hook.js --auto` and reads the contract JSON it prints on its last line.
 * `run.cmd` and this panel therefore produce identical verdicts by construction.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const guardRoot = dirname(here);
const hookPath = join(guardRoot, "dist", "hook.js");

/** In-memory run state. One run at a time; a second POST while running is refused. */
const state = {
  status: "idle", // idle | running | done
  runId: 0,
  startedAt: null,
  finishedAt: null,
  from: null,
  to: null,
  verdict: null,
  overall: null,
  counts: null,
  blockers: [],
  recommendation: null,
  reportPath: null,
  reason: null,
  logTail: [],
  error: null,
};

let running = null; // { child, timer }

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The desktop app runs inside Electron, so `process.execPath` is the app, not
 * node. Order matters: an explicit path, then PATH's node, then Electron in
 * node mode — the last one always exists, so a run never fails for lack of a
 * runtime.
 */
let nodeChoice = null;
function resolveNode() {
  if (nodeChoice) return nodeChoice;
  const explicit = [process.env.DSH_GUARD_NODE, join(guardRoot, "runtime", "node", "node.exe")]
    .filter((c) => typeof c === "string" && c !== "");
  for (const candidate of explicit) {
    if (existsSync(candidate)) {
      nodeChoice = { exe: candidate, env: {} };
      return nodeChoice;
    }
  }
  const probe = spawnSync("node", ["--version"], { encoding: "utf8", windowsHide: true });
  if (probe.status === 0) {
    nodeChoice = { exe: "node", env: {} };
    return nodeChoice;
  }
  nodeChoice = { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  return nodeChoice;
}

function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const name = process.env.DSH_PROFILE ?? "desktop";
  return join(process.env.USERPROFILE ?? "", ".dsh", "profiles", name);
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep looking upward */
    }
  }
  return null;
}

function pushLog(line) {
  const trimmed = line.trimEnd();
  if (trimmed === "") return;
  state.logTail.push(trimmed);
  if (state.logTail.length > 40) state.logTail.splice(0, state.logTail.length - 40);
}

function resetState(target) {
  state.status = "running";
  state.runId += 1;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.from = null;
  state.to = target ?? null;
  state.verdict = null;
  state.overall = null;
  state.counts = null;
  state.blockers = [];
  state.recommendation = null;
  state.reportPath = null;
  state.reason = null;
  state.logTail = [];
  state.error = null;
}

function startRun(target, timeoutMs) {
  if (running) return { started: false, reason: "already running" };
  if (!existsSync(hookPath)) {
    return { started: false, reason: `checker not built: ${hookPath} is missing` };
  }

  resetState(target);
  const node = resolveNode();
  const argv = [hookPath, "--auto", "--profile", profileDir()];
  if (typeof target === "string" && target.trim() !== "") argv.push("--to", target.trim());

  const child = spawn(node.exe, argv, {
    cwd: guardRoot,
    env: { ...process.env, ...node.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setTimeout(() => {
    pushLog(`[panel] 超过 ${timeoutMs}ms，终止子进程`);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    text.split(/\r?\n/).forEach(pushLog);
  });
  child.stderr.on("data", (chunk) => {
    chunk.toString("utf8").split(/\r?\n/).forEach(pushLog);
  });

  const settle = (code, spawnError) => {
    clearTimeout(timer);
    running = null;
    const payload = lastJsonLine(stdout);
    state.status = "done";
    state.finishedAt = new Date().toISOString();
    if (payload) {
      state.verdict = payload.verdict ?? null;
      state.overall = payload.overall ?? null;
      state.counts = payload.counts ?? null;
      state.blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
      state.recommendation = payload.recommendation ?? null;
      state.reportPath = payload.reportPath ?? null;
      state.from = payload.installed ?? null;
      state.to = payload.latest ?? state.to;
      state.reason = payload.reason ?? null;
      if (payload.mode === "auto") state.verdict = state.verdict ?? "pass";
    } else {
      state.error = spawnError?.message ?? `子进程未输出约定 JSON（exit ${code}）`;
    }
  };

  child.on("error", (error) => settle(null, error));
  child.on("close", (code) => settle(code, null));

  running = { child, timer };
  return { started: true, runId: state.runId };
}

/** Only serve a file the checker itself just reported, and only inside guardRoot. */
function readReport() {
  const path = state.reportPath;
  if (typeof path !== "string" || path === "") return null;
  const rel = relative(guardRoot, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function handleRun(request) {
  return (async () => {
    let target;
    try {
      const body = await request.json();
      if (body && typeof body.to === "string") target = body.to;
    } catch {
      /* empty body is fine: --auto decides */
    }
    const result = startRun(target, timeoutMsFromConfig());
    if (!result.started) return json({ ok: false, reason: result.reason }, 409);
    return json({ ok: true, runId: result.runId });
  })();
}

let configuredTimeoutMs = 240_000;
function timeoutMsFromConfig() {
  return configuredTimeoutMs;
}

export const inject = ["webServer"];

/** Minimal node-http helpers: WebRoute handlers own the raw response lifecycle. */
function send(res, status, headers, body) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(value));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (body === "") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Registered as a `WebRoute` (node handler), not a `WebResourceRoute`.
 * The resource form answers only GET/HEAD and replies 405 to anything else
 * *before* matching, so a POST-driven action cannot be expressed that way —
 * observed as `POST /compat-guard/run -> 405`.
 */
async function route(req, res) {
  const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "");

  if (path === "/compat-guard/state") {
    sendJson(res, 200, state);
    return;
  }

  if (path === "/compat-guard/run") {
    if (req.method !== "POST") {
      send(res, 405, { allow: "POST" }, "method not allowed");
      return;
    }
    const body = await readBody(req);
    const target = body && typeof body.to === "string" ? body.to : undefined;
    const result = startRun(target, configuredTimeoutMs);
    if (!result.started) sendJson(res, 409, { ok: false, reason: result.reason });
    else sendJson(res, 200, { ok: true, runId: result.runId });
    return;
  }

  if (path === "/compat-guard/report") {
    const markdown = readReport();
    if (markdown === null) send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "no report");
    else send(res, 200, { "content-type": "text/markdown; charset=utf-8" }, markdown);
    return;
  }

  send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
}

export function apply(ctx, config) {
  if (config && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0) {
    configuredTimeoutMs = config.timeoutMs;
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: "/compat-guard",
      handler: route,
    });
    return () => {
      dispose();
      if (running) {
        clearTimeout(running.timer);
        try {
          running.child.kill();
        } catch {
          /* already gone */
        }
        running = null;
      }
    };
  });
}
