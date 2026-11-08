/**
 * W1 (post-install, pre-first-boot) and W3 (repeat-failure detection).
 *
 * W1 — after the installer has replaced the files but before the new host is
 * booted, one read-only question decides whether to let the app start:
 * "does the target release still compose this profile?" `--dump-config` answers
 * it without mounting anything, so it is safe to run against the freshly
 * installed version.
 *
 * W3 — there is no host-provided crash log on this platform: `~/.dsh/logs/`
 * holds only plugin-owned subdirectories, and the `startup-*.log` writer in
 * `dsh/lib/bin.js` fires only on a CLI boot failure, which the Electron app
 * never takes. Rather than inventing a signal, this module keeps its own run
 * ledger and reports what it can actually prove: the same target version being
 * checked repeatedly and never passing means the user is stuck in a retry loop.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dumpComposedEntries } from "./config-schema.js";
import { prepareIsolation, teardown, type IsolateHandle } from "./isolate.js";

export interface PostflightResult {
  ok: boolean;
  rc: number | null;
  entries: number;
  /** Host lines that indicate a row was dropped rather than composed. */
  warnings: string[];
  errors: string[];
  error?: string;
  ms: number;
}

const WARN_RE = /^dsh: (warning|skipping profile bundle|disabling profile plugin)\b.*$/gm;
const ERROR_RE = /^dsh: (error|fatal)\b.*$/gm;

/**
 * Compose the target profile with the installed host, without mounting it.
 * Returns whether the composed tree parsed and how many entries it holds.
 */
export async function postflight(
  profileDir: string,
  runtimeBundles: string[],
  timeoutMs = 60_000,
): Promise<PostflightResult> {
  const started = Date.now();
  let handle: IsolateHandle | null = null;
  try {
    handle = prepareIsolation({
      profileDir,
      runtimeBundles,
      timeoutMs,
      log: () => {
        /* quiet: postflight writes only the summary */
      },
    });

    // One host call is enough here: postflight only asks "does the tree compose?".
    // Generating the schema as well doubled the wall time to ~14s for no extra signal.
    const composed = await dumpComposedEntries(handle, timeoutMs);

    const stderrBlob = [composed.stderr, composed.error ?? ""].join("\n");
    const warnings = [...stderrBlob.matchAll(WARN_RE)].map((m) => m[0]);
    const errors = [...stderrBlob.matchAll(ERROR_RE)].map((m) => m[0]);

    const ok = composed.ok && composed.entries.length > 0;
    return {
      ok,
      rc: composed.rc,
      entries: composed.entries.length,
      warnings,
      errors,
      ...(ok ? {} : { error: composed.error ?? "composed tree did not parse" }),
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      rc: null,
      entries: 0,
      warnings: [],
      errors: [],
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    };
  } finally {
    if (handle) teardown(handle);
  }
}

// ---------------------------------------------------------------------------
// W3 — run ledger
// ---------------------------------------------------------------------------

export interface RunRecord {
  ts: string;
  from: string;
  to: string;
  verdict: string;
  overall: string;
  exitCode: number;
  blockers: string[];
}

export interface LoopVerdict {
  /** True when the ledger shows repeated failed attempts at the same target. */
  loop: boolean;
  attempts: number;
  failedAttempts: number;
  windowMinutes: number;
  reason: string;
}

const HISTORY_FILE = "runs.jsonl";

export function historyPath(stateDir: string): string {
  return join(stateDir, HISTORY_FILE);
}

export function appendRun(stateDir: string, record: RunRecord): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(historyPath(stateDir), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // A ledger write failure must never change the check's own verdict.
  }
}

export function readRuns(stateDir: string, limit = 50): RunRecord[] {
  const file = historyPath(stateDir);
  if (!existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const rec = JSON.parse(trimmed) as RunRecord;
      if (typeof rec.ts === "string" && typeof rec.to === "string") out.push(rec);
    } catch {
      // Skip a torn line; the ledger is append-only and crash-tolerant.
    }
  }
  return out.slice(-limit);
}

/**
 * A loop means: same target version, several attempts inside the window, and
 * not one of them passed. A single block is a normal "don't upgrade"; repeated
 * blocks are a user who does not know what to do next.
 */
export function detectLoop(
  runs: RunRecord[],
  options: { windowMinutes?: number; minAttempts?: number; now?: number } = {},
): LoopVerdict {
  const windowMinutes = options.windowMinutes ?? 30;
  const minAttempts = options.minAttempts ?? 3;
  const now = options.now ?? Date.now();
  const since = now - windowMinutes * 60_000;

  const recent = runs.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= since;
  });
  if (recent.length === 0) {
    return { loop: false, attempts: 0, failedAttempts: 0, windowMinutes, reason: "窗口内没有检查记录" };
  }

  const lastTarget = recent[recent.length - 1]!.to;
  const attempts = recent.filter((r) => r.to === lastTarget).length;
  const failed = recent.filter((r) => r.to === lastTarget && r.verdict !== "pass");
  const anyPass = recent.some((r) => r.to === lastTarget && r.verdict === "pass");

  const loop = attempts >= minAttempts && failed.length >= minAttempts && !anyPass;
  const reason = loop
    ? `最近 ${windowMinutes} 分钟内对 ${lastTarget} 检查了 ${attempts} 次，全部未通过：更新很可能反复失败，建议先处理下面的 BLOCKER 再重试`
    : anyPass
      ? `最近 ${windowMinutes} 分钟内有通过记录，不判定为循环`
      : `最近 ${windowMinutes} 分钟内对 ${lastTarget} 检查 ${attempts} 次（阈值 ${minAttempts}），暂不判定为循环`;

  return { loop, attempts, failedAttempts: failed.length, windowMinutes, reason };
}
