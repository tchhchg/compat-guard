/**
 * Shared types for the Compat Guard check pipeline.
 *
 * Level ordering matters: aggregate() takes the maximum over all findings.
 * UNKNOWN is deliberately NOT part of the ordering — it is tracked separately so a
 * single "could not verify" never inflates a PASS into a risk, and never hides one.
 */

export type Level = "BLOCKER" | "HIGH" | "MEDIUM" | "LOW";

/** Severity used for ordering/aggregation only. */
export const LEVEL_ORDER: Record<Level, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  BLOCKER: 3,
};

export type Verdict = "pass" | "block" | "warn";

export interface Finding {
  /** Plugin package name, or a profile/host pseudo-target. */
  plugin: string;
  /** Check item number from the design document (§2 table). */
  item: number;
  title: string;
  level: Level;
  detail: string;
  evidence: string;
  action: string;
  /** false => this plugin was not exercised in the isolated host (static only). */
  runtimeVerified: boolean;
}

export interface UnknownFinding {
  plugin: string;
  item: number;
  title: string;
  reason: string;
  /** How a human can settle it. */
  manual: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  dir: string;
  present: boolean;
  /** Raw parsed package.json, or undefined when unreadable/missing. */
  raw?: Record<string, unknown>;
  /** dsh.engines.dsh */
  enginesDsh?: string;
  /** dsh.compatibility.dshReleases */
  dshReleases?: Record<string, string>;
  /** dsh.bundle.patch */
  bundlePatch?: string;
  /** dsh.client.inject[] */
  clientInject?: string[];
  /** peerDependencies entries naming the host: @deepseek-ai/dsh or @deepseek-ai/dsh-* only.
   *  @deepseek-ai/cordis is deliberately excluded: it has its own version line (4.x) and is
   *  NOT compared against the host version — the host's own preflight skips it too. */
  hostPeers: Record<string, string>;
  /** dependencies entries naming @deepseek-ai/(dsh|dsh-*). */
  hostDeps: Record<string, string>;
  /** cordis constraints from either field, compared against the INSTALLED cordis version. */
  cordisRanges: Record<string, string>;
  entryFile?: string;
}

export interface Context {
  profileDir: string;
  fromVersion: string;
  toVersion: string;
  /** dsh.profile.bundles, in declaration order. */
  bundles: string[];
  /** Bundles that will actually be mounted in the isolated host. */
  runtimeBundles: string[];
  /** Bundles skipped because they are not on the isolation allowlist. */
  skippedRuntime: string[];
  plugins: PluginManifest[];
  /** Raw exemptions from the profile compatibility.json (read-only here). */
  exemptions: Record<string, string[]>;
  generatedAt: string;
  pluginSetHash: string;
}

export interface Signal {
  kind:
    | "preflight-disabled"
    | "pending"
    | "did-not-activate"
    | "stack-frame"
    | "error-line"
    | "other";
  line: string;
  plugin?: string;
  detail?: string;
}

export interface LoadResult {
  ready: boolean;
  /**
   * "url" — the host announced `dsh web: http://…/?token=…` (authenticated, browsable).
   * "port" — the socket is listening but the URL was never announced; the web UI answers 401
   *          in that state, so a client probe against it would be a false failure.
   * "process-exit" — the process died before it could listen.
   */
  readyBy: "url" | "port" | "process-exit" | null;
  readyAtMs: number | null;
  /** The token-bearing URL from stdout; required for stage 2b. */
  url: string | null;
  exitCode: number | null;
  killedByTimeout: boolean;
  stdout: string;
  stderr: string;
  port: number;
  /** Set when the isolated host itself could not be started at all. */
  setupError?: string;
  signals: Signal[];
}

export interface CheckReport {
  schemaVersion: 1;
  generatedAt: string;
  fromVersion: string;
  toVersion: string;
  direction: "upgrade" | "downgrade" | "sidestep";
  profileDir: string;
  pluginSetHash: string;
  overall: Level | "PASS";
  /** Set when the not-verified count exceeds the verified count. */
  lowConfidence: boolean;
  findings: Finding[];
  unknowns: UnknownFinding[];
  runtime: {
    attempted: boolean;
    ready: boolean;
    readyBy: string | null;
    readyAtMs: number | null;
    port: number | null;
    skippedBundles: string[];
    note: string;
  };
  /**
   * Stage 2b (item 16). Separate from `runtime` on purpose: the host chain and the client
   * chain fail independently, and conflating them makes "host is fine but UI is blank"
   * indistinguishable from "host did not boot".
   */
  client: {
    attempted: boolean;
    browserLaunched: boolean;
    browserChannel: string | null;
    pageLoaded: boolean;
    renderOk: boolean;
    renderWaitMs: number | null;
    issueCount: number;
    /** Distinct plugins implicated by client-side evidence. */
    implicatedPlugins: string[];
    error?: string;
  };
  /**
   * Item 9. The target host generates its own config schema and the checker
   * validates the composed config against it; no plugin internals are read.
   */
  config: {
    attempted: boolean;
    schemaOk: boolean;
    entryBranches: number;
    checked: number;
    violationCount: number;
    unjudgedCount: number;
    skippedBundles: string[];
    error: string | null;
  };
  /**
   * Independent per-axis outcomes. Derived, read-only: it never feeds `overall` or
   * the exit code, it only stops different failure kinds from collapsing into one
   * pass/fail. See src/outcomes.ts.
   */
  outcomes: import("./outcomes.js").CheckOutcomes;
  counts: {
    plugins: number;
    bundles: number;
    runtimeBundles: number;
    findings: number;
    unknowns: number;
  };
  /**
   * Informational only: a live host process was observed. Deliberately NOT a gate.
   * The design assumed a running host forces `--no-runtime`; measurement shows the
   * isolation recipe (own DSH_HOME + random high port) coexists with the live host,
   * so this value explains a failure, it never prevents the attempt.
   */
  hostRunning: boolean | null;
  hostEvidence: string;
  /** Human-readable one-liner for the report header. */
  headline: string;
}
