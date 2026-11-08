/**
 * Detect whether a live DSH host instance is running.
 *
 * Why this exists: the design assumed a running host would force the checker to
 * skip the isolated trial load (shared profile lock, contested port). Measured
 * behaviour contradicts that: the isolation recipe uses its own DSH_HOME and a
 * random high port, and five consecutive runs completed with the live host in
 * the foreground. So this probe is INFORMATIONAL, not a gate — it is reported so
 * a failure can be attributed to concurrent writes, but it never disables the
 * trial load on its own.
 *
 * Platform coverage: Windows uses tasklist (no PowerShell startup cost). Other
 * platforms return null (unknown) rather than guessing from /proc heuristics
 * that differ per distribution.
 */
import { execFile } from "node:child_process";

export interface HostDetection {
  /** true = a host process was observed, false = none observed, null = could not tell. */
  running: boolean | null;
  /** Process names the probe looked for. */
  candidates: string[];
  /** PIDs observed (empty when running is false/null). */
  pids: number[];
  /** Human-readable explanation, also copied into the report. */
  evidence: string;
}

/** Executable names as shipped by the installer. Measured: `DeepSeek Harness.exe`. */
export const HOST_PROCESS_CANDIDATES = [
  "DeepSeek Harness.exe",
  "DeepSeek Harness",
];

function runTasklist(imageName: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", `IMAGENAME eq ${imageName}`, "/NH", "/FO", "CSV"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Parse `tasklist /NH /FO CSV` output into PIDs.
 * A no-match run prints a localised INFO line (Chinese or English) instead of
 * rows, so only lines whose first CSV field ends in `.exe` count.
 */
export function parseTasklistCsv(stdout: string): number[] {
  const pids: number[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const first = line.startsWith('"') ? line.slice(1, line.indexOf('"', 1)) : line.split(",")[0];
    if (!first || !/\.exe$/i.test(first.trim())) continue;
    const match = line.match(/,\s*"?(\d+)"?,/);
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}

export async function detectRunningHost(timeoutMs = 5000): Promise<HostDetection> {
  if (process.platform !== "win32") {
    return {
      running: null,
      candidates: HOST_PROCESS_CANDIDATES,
      pids: [],
      evidence: `process probe unsupported on ${process.platform}`,
    };
  }

  for (const imageName of HOST_PROCESS_CANDIDATES) {
    const stdout = await runTasklist(imageName, timeoutMs);
    if (stdout === null) {
      return {
        running: null,
        candidates: HOST_PROCESS_CANDIDATES,
        pids: [],
        evidence: "tasklist failed or timed out",
      };
    }
    const pids = parseTasklistCsv(stdout);
    if (pids.length > 0) {
      return {
        running: true,
        candidates: HOST_PROCESS_CANDIDATES,
        pids,
        evidence: `${imageName} running (${pids.length} process(es): ${pids.join(", ")})`,
      };
    }
  }

  return {
    running: false,
    candidates: HOST_PROCESS_CANDIDATES,
    pids: [],
    evidence: "no host process observed",
  };
}
