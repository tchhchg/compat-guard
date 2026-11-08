/**
 * Stage 2b — client-side bundle probe (check item 16).
 *
 * Why this exists: DSH has TWO independent load chains. The host chain (cordis tree from
 * `dsh.profile.bundles`) is what `--dump-config` and the isolated host exercise. The client
 * chain is separate: `@deepseek-ai/dsh-client-runtime` reads each plugin's `dsh.client`
 * field in the browser. A plugin can pass the host check and still white-screen the UI.
 *
 * This module drives a real browser against the isolated host that is already listening, so
 * it must run BETWEEN "port is up" and "host is killed" — see launchIsolated's onReady hook.
 *
 * Browser strategy: playwright-core + the system Edge (`channel: "msedge"`). This avoids a
 * ~150 MB chromium download and reuses a browser that is guaranteed present on Windows.
 * When Edge is missing the probe reports `browserLaunched: false` and the caller records an
 * UNKNOWN rather than a PASS — "could not look" is never "looked and found nothing".
 *
 * Render criterion: no selector is hardcoded. DSH's web UI mount point is not part of any
 * published contract we inspected, so the check uses a structural predicate
 * (body has element children AND visible text). It is weaker than a selector: an error
 * overlay that renders text would satisfy it. Recorded as a known limitation.
 */

import { chromium, type Browser, type Page } from "playwright-core";

/**
 * Minimal DOM surface used by the in-page predicates.
 *
 * Declared locally instead of enabling lib "DOM": this package is a Node program, and
 * pulling in the full DOM lib would let accidental browser-only API usage compile silently
 * everywhere else. Only these two members cross the process boundary.
 */
interface MinimalDocument {
  body: { children: { length: number }; innerText?: string } | null;
  title: string;
  /** Used to reject "plausible text" that is not an application shell (e.g. a 401 body). */
  scripts: { length: number };
  querySelector(selector: string): unknown;
}
declare const document: MinimalDocument;

export interface ClientProbeOptions {
  port: number;
  /**
   * The token-bearing URL the host printed (`dsh web: http://…/?token=…`).
   * REQUIRED: the web app answers 401 on a bare origin and hands out its session cookie only
   * during the `?token=` exchange. Passing null is a hard "cannot probe", never a pass.
   */
  url: string | null;
  /** Budget for the whole browser phase (launch + goto + settle). */
  timeoutMs: number;
  /** Extra wait after the page settles, for lazily-mounted UI. */
  settleMs: number;
  log: (line: string) => void;
}

export interface ClientIssue {
  kind: "pageerror" | "console-error" | "request-failed" | "http-error";
  text: string;
  /** Package name mined out of a stack frame or asset URL, when identifiable. */
  plugin?: string;
}

export interface ClientProbeResult {
  attempted: boolean;
  browserLaunched: boolean;
  browserChannel: string | null;
  /** The page actually navigated and the document loaded. */
  pageLoaded: boolean;
  /** Structural render predicate passed within the budget. */
  renderOk: boolean;
  renderWaitMs: number | null;
  issues: ClientIssue[];
  /** Fatal probe failure (no browser, navigation refused, ...). Never a verdict. */
  error?: string;
  notes: string[];
}

/** Mine a package name out of `.../node_modules/@scope/pkg/...` or `.../node_modules/pkg/...`. */
export function pluginFromPath(text: string): string | undefined {
  const m = /node_modules[\\/]((?:@[^\\/\s"')]+[\\/])?[^\\/\s"'):]+)[\\/]/.exec(text);
  if (!m || m[1] === undefined) return undefined;
  return m[1].replace(/\\/g, "/").replace(/\/$/, "");
}

function short(text: string, max = 300): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

async function launchBrowser(log: (l: string) => void): Promise<{ browser: Browser; channel: string } | null> {
  // Ordered by cost: the system browser first, then whatever playwright has cached.
  const candidates = ["msedge", "chrome", undefined] as const;
  for (const channel of candidates) {
    try {
      const browser = await chromium.launch({
        headless: true,
        ...(channel === undefined ? {} : { channel }),
      });
      return { browser, channel: channel ?? "bundled-chromium" };
    } catch (error) {
      log(`client-probe: launch failed for channel=${channel ?? "bundled"}: ${short(String(error), 160)}`);
    }
  }
  return null;
}

export async function probeClient(options: ClientProbeOptions): Promise<ClientProbeResult> {
  const { port, timeoutMs, settleMs, log } = options;
  const result: ClientProbeResult = {
    attempted: true,
    browserLaunched: false,
    browserChannel: null,
    pageLoaded: false,
    renderOk: false,
    renderWaitMs: null,
    issues: [],
    notes: [],
  };

  const started = Date.now();

  // No token-bearing URL means every request will answer 401. Report that as "could not
  // look" and never spend a browser launch on a guaranteed failure.
  if (options.url === null) {
    result.error =
      "宿主没有在超时前打印带 token 的访问 URL（`dsh web: http://…/?token=…`）；没有该 token 时所有请求返回 401，client 侧无法探测";
    return result;
  }

  const launched = await launchBrowser(log);
  if (!launched) {
    result.error = "no usable browser (msedge / chrome / bundled chromium all failed to launch)";
    return result;
  }
  result.browserLaunched = true;
  result.browserChannel = launched.channel;
  const browser = launched.browser;

  let page: Page | undefined;
  try {
    page = await browser.newPage();

    page.on("pageerror", (error) => {
      const text = short(`${error.name}: ${error.message}\n${error.stack ?? ""}`);
      result.issues.push({ kind: "pageerror", text, plugin: pluginFromPath(text) });
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = short(msg.text());
      result.issues.push({ kind: "console-error", text, plugin: pluginFromPath(text) });
    });
    page.on("requestfailed", (req) => {
      const url = req.url();
      const reason = req.failure()?.errorText ?? "request failed";
      result.issues.push({
        kind: "request-failed",
        text: short(`${reason} ${url}`),
        plugin: pluginFromPath(url),
      });
    });
    page.on("response", (res) => {
      const status = res.status();
      if (status < 400) return;
      const url = res.url();
      result.issues.push({
        kind: "http-error",
        text: short(`HTTP ${status} ${url}`),
        plugin: pluginFromPath(url),
      });
    });

    const target = options.url;
    log(`client-probe: goto ${target.replace(/token=[^&]+/, "token=***")} (channel=${launched.channel})`);

    const budgetLeft = Math.max(2000, timeoutMs - (Date.now() - started));
    const nav = await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(budgetLeft, 20000),
    });
    const navStatus = nav?.status() ?? null;
    if (navStatus === 401) {
      // The token was rejected: the host rotated it, or the probe raced the announcement.
      result.error = `访问被拒（HTTP 401）：携带的 launch token 未被接受，client 侧无法探测`;
      return result;
    }
    result.pageLoaded = true;

    // Structural render predicate. Deliberately not a selector: see the module comment.
    const renderStart = Date.now();
    try {
      await page.waitForFunction(
        () => {
          const body = document.body;
          if (body === null) return false;
          if (body.children.length < 2) return false;
          if ((body.innerText ?? "").trim().length === 0) return false;
          // Reject "plausible text that is not an app": a plain-text 401 body has text but no
          // application shell. Without this guard a rejected token could be scored as rendered.
          if (document.scripts.length === 0) return false;
          return true;
        },
        undefined,
        { timeout: Math.max(2000, Math.min(30000, budgetLeft)), polling: 250 },
      );
      result.renderOk = true;
      result.renderWaitMs = Date.now() - renderStart;
    } catch {
      result.renderOk = false;
      result.renderWaitMs = null;
      // Record what the page DID look like; this is the only clue for a near-miss.
      try {
        const shape = await page.evaluate(() => ({
          children: document.body?.children.length ?? -1,
          textLen: (document.body?.innerText ?? "").trim().length,
          title: document.title,
        }));
        result.notes.push(
          `render predicate not met within budget: body.children=${shape.children}, innerText.length=${shape.textLen}, title=${JSON.stringify(shape.title)}`,
        );
      } catch {
        result.notes.push("render predicate not met and the page was no longer inspectable");
      }
    }

    if (settleMs > 0) await page.waitForTimeout(settleMs);
  } catch (error) {
    result.error = short(String(error), 400);
  } finally {
    try {
      await page?.close();
    } catch {
      /* ignore */
    }
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }

  return result;
}
