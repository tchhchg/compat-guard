/**
 * Entry point for both the pre-install hook and manual CLI use.
 *
 * Exit code contract (must not change; the installer branches on it):
 *   0 = pass   -> installer continues
 *   1 = block  -> installer aborts and rolls back the staged files
 *   2 = warn   -> installer continues but shows a warning (also used for timeout /
 *                 "could not run", i.e. fail-open)
 *
 * stdout protocol: the LAST line must be a single-line JSON object. Everything before it
 * is free-form text, so a human can read the run while the installer parses one line.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCheck } from "./check.js";
import { detectRunningHost } from "./host-detect.js";
import { teardown, killActiveChildren } from "./isolate.js";
import { appendRun, detectLoop, postflight, readRuns, type LoopVerdict } from "./postflight.js";
import { installedDshVersion, latestDshVersion, relate } from "./update-source.js";
import type { Verdict } from "./types.js";

interface HookInput {
  fromVersion: string;
  toVersion: string;
  profileDir: string;
  targetDir?: string;
  timeoutMs: number;
  outDir: string;
  runtime: boolean;
  /** Stage 2b. Disabled with --no-client (no browser available, or a fast static run). */
  client: boolean;
  /** W1 only: compose the target profile and exit, mounting nothing. */
  postflight: boolean;
  /**
   * Never block, even on a BLOCKER: turn exit 1 into exit 2 and keep the finding.
   * Default is to block, because a BLOCKER means the update will crash on start;
   * this switch exists for people who would rather try anyway.
   */
  failOpen: boolean;
  /** Run ledger directory (W3). */
  stateDir: string;
  /** Discover the version pair from the installed app and the npm registry. */
  auto: boolean;
}

/**
 * One sentence the installer UI can show verbatim. Repeated failures get a
 * different instruction than a first-time failure: retrying the same thing a
 * fourth time is the failure mode this tool exists to prevent.
 */
function recommend(input: HookInput, loop: LoopVerdict, blockerPlugins: string[]): string {
  const names = blockerPlugins.slice(0, 3).join("、");
  if (loop.loop && blockerPlugins.length > 0) {
    return input.failOpen
      ? `已连续 ${loop.attempts} 次未通过，本次按 fail-open 放行，但 ${names} 很可能导致启动失败；建议先临时禁用它们再启动。`
      : `已连续 ${loop.attempts} 次未通过。先临时禁用 ${names} 再重试，或回滚到 ${input.fromVersion}；重复重试不会改变结果。`;
  }
  if (loop.loop) {
    return `已连续 ${loop.attempts} 次未通过且没有 BLOCKER。建议回滚到 ${input.fromVersion}，而不是继续重试。`;
  }
  if (blockerPlugins.length > 0) {
    return `不要直接更新：先临时禁用 ${names}（可用 compat-guard disable），或升级这些插件到声明支持 ${input.toVersion} 的版本。`;
  }
  return "可以更新；若更新后出现功能异常，对照报告里“未做运行期验证”的插件逐个排查。";
}

/** Append the retry history to the markdown report (append-only: never rewrite it). */
function appendRetrySection(
  reportPath: string,
  loop: LoopVerdict,
  recommendation: string,
): void {
  try {
    const section = [
      "",
      "---",
      "",
      "## 重试历史（W3）",
      "",
      `- 判定：**${loop.loop ? "疑似反复失败" : "正常"}**`,
      `- 最近 ${loop.windowMinutes} 分钟内的检查次数：${loop.attempts}（未通过 ${loop.failedAttempts} 次）`,
      `- 说明：${loop.reason}`,
      `- 建议：${recommendation}`,
      "",
    ].join("\n");
    appendFileSync(reportPath, section, "utf8");
  } catch {
    // A report that cannot be extended still carries its main conclusion.
  }
}

function readProfileBundles(profileDir: string): string[] {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir, "package.json"), "utf8"),
    ) as { dsh?: { profile?: { bundles?: unknown } } };
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) return [];
    return bundles.filter((b): b is string => typeof b === "string");
  } catch {
    return [];
  }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function resolveInput(): HookInput {
  const here = process.cwd();
  const profileDir =
    flag("--profile") ??
    process.env.DSH_PROFILE_DIR ??
    join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "desktop");

  const fromVersion = flag("--from") ?? process.env.DSH_FROM_VERSION ?? "";
  const toVersion = flag("--to") ?? process.env.DSH_TO_VERSION ?? "";
  // `--auto` may fill these in later; resolveInput keeps them as-is.

  const timeoutRaw = flag("--timeout") ?? process.env.DSH_GUARD_TIMEOUT_MS ?? "180000";
  const parsedTimeout = Number.parseInt(timeoutRaw, 10);

  return {
    fromVersion,
    toVersion,
    profileDir: resolve(profileDir),
    targetDir: flag("--target") ?? process.env.DSH_TARGET_DIR,
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 180_000,
    outDir: flag("--out") ?? process.env.DSH_GUARD_OUT ?? join(here, "out"),
    runtime: !hasFlag("--no-runtime"),
    // Stage 2b needs a live isolated host; without one there is nothing to browse.
    client: !hasFlag("--no-client") && !hasFlag("--no-runtime"),
    postflight: hasFlag("--postflight"),
    failOpen: hasFlag("--fail-open") || process.env.DSH_GUARD_FAIL_OPEN === "1",
    stateDir: flag("--state") ?? process.env.DSH_GUARD_STATE ?? join(here, "state"),
    auto: hasFlag("--auto") || process.env.DSH_GUARD_AUTO === "1",
  };
}

let finished = false;

/**
 * Serialise the stdout contract line as pure ASCII.
 * Report paths contain CJK characters, and the installer may read stdout under a
 * legacy code page (932/936). Escaping every non-ASCII char keeps the line
 * byte-identical to valid JSON for any consumer.
 */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => {
    return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

function emit(payload: Record<string, unknown>, code: 0 | 1 | 2): never {
  if (!finished) {
    finished = true;
    process.stdout.write(asciiJson(payload) + "\n");
  }
  // The launcher chain is cmd -> node; a lingering grandchild can hold the stdout pipe
  // open and hang the caller. Exiting explicitly is mandatory here. Nothing in this
  // process holds an open socket: version discovery uses one-shot HTTPS requests
  // (agent:false), so there is no keep-alive pool for process.exit to trip over.
  process.exit(code);
}

async function main(): Promise<void> {
  const input = resolveInput();
  const log = (line: string): void => {
    process.stderr.write(`[compat-guard] ${line}\n`);
  };

  log(`profile=${input.profileDir}`);
  log(`from=${input.fromVersion || "(unset)"} to=${input.toVersion || "(unset)"}`);
  log(`runtime=${input.runtime} client=${input.client} timeoutMs=${input.timeoutMs}`);

  // W1: post-install, pre-first-boot. Compose the freshly installed profile and
  // exit. Nothing is mounted, so this is safe to run against the new files.
  // `--auto`: fill in the version pair instead of asking the user for it.
  // Runs before every other branch so the rest of the code never sees an empty pair.
  if (input.auto && (!input.fromVersion || !input.toVersion)) {
    const installed = installedDshVersion(input.profileDir);
    log(`auto: installed=${installed.version ?? "(unknown)"} from ${installed.source || "-"}`);
    if (installed.version === null) {
      emit(
        {
          verdict: "warn" as Verdict,
          overall: "UNKNOWN",
          reason: installed.error ?? "无法确定已安装版本",
          reportPath: null,
        },
        2,
      );
    }
    const latest = await latestDshVersion();
    log(
      `auto: latest=${latest.version ?? "(unknown)"} via ${latest.source || "-"} ` +
        `(${latest.versions} versions, ${latest.ms}ms)` +
        (latest.error ? ` error=${latest.error}` : ""),
    );
    if (latest.version === null) {
      emit(
        {
          verdict: "warn" as Verdict,
          overall: "UNKNOWN",
          reason: `无法查询最新版本（${latest.error ?? "registry unreachable"}）；请用 --to 手动指定目标版本`,
          reportPath: null,
        },
        2,
      );
    }
    // Only fill what is missing: an explicit --to must win over the registry.
    const explicitTarget = input.toVersion !== "";
    const relation = relate(installed.version, latest.version);
    if (!explicitTarget && relation === "same") {
      log(`auto: already current (${installed.version}), nothing to check`);
      // The contract line is ASCII-escaped for the installer; a human reading the
      // console needs the same conclusion unescaped.
      process.stderr.write(`\n已是最新版本 ${installed.version}，无需检查。\n`);
      emit(
        {
          verdict: "pass",
          overall: "PASS",
          mode: "auto",
          reason: `已是最新版本 ${installed.version}，无需检查`,
          installed: installed.version,
          latest: latest.version,
          reportPath: null,
        },
        0,
      );
    }
    if (!input.fromVersion) input.fromVersion = installed.version;
    if (!explicitTarget) input.toVersion = latest.version;
    log(`auto: checking ${input.fromVersion} -> ${input.toVersion}`);
  }

  if (input.postflight) {
    const bundles = readProfileBundles(input.profileDir);
    log(`postflight: composing ${bundles.length} bundle(s) with the installed host`);
    const result = await postflight(input.profileDir, bundles, input.timeoutMs);
    log(
      `postflight: ok=${result.ok} entries=${result.entries} rc=${result.rc} ${result.ms}ms` +
        (result.error ? ` error=${result.error}` : ""),
    );
    for (const w of result.warnings.slice(0, 5)) log(`  warn: ${w}`);
    for (const e of result.errors.slice(0, 5)) log(`  err: ${e}`);
    const verdict: Verdict = result.ok ? "pass" : "warn";
    emit(
      {
        verdict,
        overall: result.ok ? "PASS" : "UNKNOWN",
        mode: "postflight",
        composedEntries: result.entries,
        warnings: result.warnings.length,
        errors: result.errors.length,
        ...(result.error ? { reason: result.error } : {}),
      },
      result.ok ? 0 : 2,
    );
  }

  if (!existsSync(input.profileDir)) {
    emit(
      {
        verdict: "warn" as Verdict,
        overall: "UNKNOWN",
        reason: `profile not found: ${input.profileDir}`,
        reportPath: null,
      },
      2,
    );
  }

  if (!input.fromVersion || !input.toVersion) {
    emit(
      {
        verdict: "warn" as Verdict,
        overall: "UNKNOWN",
        reason: "missing DSH_FROM_VERSION / DSH_TO_VERSION (or --from/--to)",
        reportPath: null,
      },
      2,
    );
  }

  // Hard watchdog: the check must never hold the installer open. launchIsolated already
  // enforces its own budget and kills the child; this is the last-resort net.
  const watchdog = setTimeout(() => {
    log("watchdog fired: emitting fail-open result");
    emit(
      {
        verdict: "warn" as Verdict,
        overall: "UNKNOWN",
        reason: "timeout (fail-open)",
        reportPath: null,
      },
      2,
    );
  }, input.timeoutMs + 30_000);
  watchdog.unref?.();

  // Informational probe: a live host does NOT gate the trial load (see host-detect.ts).
  // It is reported so a failure can be attributed to concurrent writes.
  const host = await detectRunningHost();
  log(`host: ${host.evidence}`);

  // Budget enforcement. The watchdog above is only a last-resort backstop
  // (timeout + 30s); this race is what actually honours DSH_GUARD_TIMEOUT_MS.
  // Measured reason: with a 2000ms budget the check still ran 18.7s and returned a
  // real MEDIUM verdict, because each stage carried its own internal cap and nothing
  // observed the shared budget. A budget hit must produce NOT_RUN, never a verdict.
  const budgetHit = Symbol("budget-hit");
  const budgetPromise = new Promise<typeof budgetHit>((resolveBudget) => {
    const timer = setTimeout(() => resolveBudget(budgetHit), input.timeoutMs);
    timer.unref?.();
  });

  const raced = await Promise.race([
    runCheck({
      profileDir: input.profileDir,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      outDir: input.outDir,
      timeoutMs: input.timeoutMs,
      runtime: input.runtime,
      client: input.client,
      hostRunning: host.running,
      hostEvidence: host.evidence,
      log,
    }),
    budgetPromise,
  ]);

  if (raced === budgetHit) {
    const killed = killActiveChildren();
    log(`budget ${input.timeoutMs}ms exhausted; killed ${killed} isolated host(s)`);
    emit(
      {
        verdict: "warn" as Verdict,
        overall: "UNKNOWN",
        reason: `timeout (budget ${input.timeoutMs}ms, fail-open)`,
        reportPath: null,
        killedHosts: killed,
      },
      2,
    );
  }

  const outcome = raced;

  clearTimeout(watchdog);

  // W3: record this attempt, then say whether the ledger looks like a retry loop.
  appendRun(input.stateDir, {
    ts: new Date().toISOString(),
    from: input.fromVersion,
    to: input.toVersion,
    verdict: outcome.verdict,
    overall: outcome.report.overall,
    exitCode: outcome.exitCode,
    blockers: outcome.report.findings
      .filter((f) => f.level === "BLOCKER")
      .map((f) => `${f.plugin}#${f.item}`),
  });
  const loop = detectLoop(readRuns(input.stateDir));
  if (loop.loop) log(`loop detected: ${loop.reason}`);

  const blockers = outcome.report.findings.filter((f) => f.level === "BLOCKER");
  const recommendation = recommend(input, loop, blockers.map((b) => b.plugin));

  // The markdown report is the artefact a human reads after the fact, so the
  // retry history belongs in it, not only in the contract line.
  if (loop.loop) {
    appendRetrySection(outcome.reportMarkdownPath, loop, recommendation);
    log(`report: appended retry history (${loop.attempts} attempts)`);
  }

  let exitCode = outcome.exitCode;
  let verdict: Verdict = outcome.verdict;
  let overriddenBy: string | undefined;
  if (input.failOpen && exitCode === 1) {
    exitCode = 2;
    verdict = "warn";
    overriddenBy = "fail-open";
    log("fail-open: BLOCKER downgraded to warn (--fail-open)");
  }

  log(`overall=${outcome.report.overall} verdict=${verdict}`);
  log(`report: ${outcome.reportMarkdownPath}`);

  process.stderr.write("\n" + outcome.report.headline + "\n");
  // `recommendation` lives in the contract JSON for machines; a human looking at the
  // console needs the same next step spelled out, not a \u-escaped string.
  if (recommendation) process.stderr.write(recommendation + "\n");

  emit(
    {
      verdict,
      overall: outcome.report.overall,
      reportPath: outcome.reportMarkdownPath,
      reportJsonPath: outcome.reportJsonPath,
      pluginSetHash: outcome.report.pluginSetHash,
      counts: outcome.report.counts,
      hostRunning: outcome.report.hostRunning,
      blockers: outcome.report.findings
        .filter((f) => f.level === "BLOCKER")
        .map((f) => `${f.plugin}#${f.item}`),
      // Both chains are surfaced independently so an installer can act on either one:
      // `runtime.ready=false` means the host could not boot, `client.renderOk=false`
      // means it booted but the UI did not render. Collapsing them hides the second case.
      runtime: {
        attempted: outcome.report.runtime.attempted,
        ready: outcome.report.runtime.ready,
        readyBy: outcome.report.runtime.readyBy,
        readyAtMs: outcome.report.runtime.readyAtMs,
        skippedBundles: outcome.report.runtime.skippedBundles.length,
      },
      client: outcome.report.client.attempted
        ? {
            browserLaunched: outcome.report.client.browserLaunched,
            channel: outcome.report.client.browserChannel,
            pageLoaded: outcome.report.client.pageLoaded,
            renderOk: outcome.report.client.renderOk,
            issueCount: outcome.report.client.issueCount,
            implicated: outcome.report.client.implicatedPlugins,
          }
        : null,
      lowConfidence: outcome.report.lowConfidence,
      headline: outcome.report.headline,
      recommendation,
      ...(overriddenBy ? { overriddenBy } : {}),
      loop: {
        detected: loop.loop,
        attempts: loop.attempts,
        failedAttempts: loop.failedAttempts,
        windowMinutes: loop.windowMinutes,
        reason: loop.reason,
      },
    },
    exitCode,
  );
}

main().catch((error: unknown) => {
  // A crash in the checker must never block an update: report and fail open.
  process.stderr.write(`[compat-guard] FATAL ${String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(error.stack + "\n");
  emit(
    {
      verdict: "warn" as Verdict,
      overall: "UNKNOWN",
      reason: `checker crashed: ${error instanceof Error ? error.message : String(error)}`,
      reportPath: null,
    },
    2,
  );
});
