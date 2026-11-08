/**
 * compat-guard-panel — Client half.
 *
 * Renders one block on this bundle's own page in Settings → Plugins by
 * in two places:
 *   - `settings.section`      -> a first-class row in the Settings left column
 *   (id `compat-guard`, order 40), one click away;
 *   - `plugins.bundle.config` -> the same block on this bundle's detail page,
 *   keyed by the package name.
 * All work happens in the Host half; this file only reads `/compat-guard/state`
 * and asks `/compat-guard/run` to start a run.
 */
window.__ModuleLoader__.load({
  id: "compat-guard-panel",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const zh =
      typeof navigator !== "undefined" && /^zh/i.test(navigator.language ?? "");
    const S = {
      run: zh ? "检查兼容性" : "Check compatibility",
      running: zh ? "检查中…约需 20 秒" : "Checking… about 20 seconds",
      idle: zh ? "本次会话尚未运行" : "Not run yet in this session",
      versions: zh ? "版本对" : "Version pair",
      result: zh ? "结论" : "Result",
      pass: zh ? "PASS — 可以更新" : "PASS — safe to update",
      warn: zh ? "WARN — 可以更新，但请看报告" : "WARN — possible, but read the report",
      block: zh ? "BLOCK — 暂不要更新" : "BLOCK — do not update yet",
      unknown: zh ? "UNKNOWN — 检查未完成" : "UNKNOWN — the check did not finish",
      counts: zh ? "检出项" : "Findings",
      risky: zh ? "有风险的插件" : "Plugins at risk",
      none: zh ? "无" : "None",
      open: zh ? "打开 report.md" : "Open report.md",
      noReport: zh ? "还没有报告" : "No report yet",
      offline: zh ? "registry 不可达 — 可直接填写目标版本" : "Registry unreachable — enter a target version",
      placeholder: zh ? "例如 0.2.3-rc.1" : "e.g. 0.2.3-rc.1",
      runTarget: zh ? "检查这个版本" : "Check this version",
      blockHint: zh
        ? "暂不要更新。先处理下面这些插件；本工具不会自动禁用或修改任何插件。"
        : "Do not update yet. Deal with these plugins first; nothing is disabled or changed automatically.",
      lastRun: zh ? "上次运行" : "Last run",
      failed: zh ? "检查未完成" : "The check did not finish",
    };

    const COLOR = {
      pass: "#16a34a",
      warn: "#d97706",
      block: "#dc2626",
      unknown: "#6b7280",
      idle: "#6b7280",
      running: "#2563eb",
    };

    function badgeTone(status, verdict) {
      if (status === "running") return COLOR.running;
      if (verdict === "pass") return COLOR.pass;
      if (verdict === "warn") return COLOR.warn;
      if (verdict === "block") return COLOR.block;
      return COLOR.unknown;
    }

    function verdictLabel(verdict) {
      if (verdict === "pass") return S.pass;
      if (verdict === "warn") return S.warn;
      if (verdict === "block") return S.block;
      return S.unknown;
    }

    const chip = (bg) => ({
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 12,
      lineHeight: "18px",
      fontWeight: 600,
      color: "#fff",
      background: bg,
      whiteSpace: "nowrap",
    });

    const row = {
      display: "flex",
      gap: 8,
      alignItems: "baseline",
      fontSize: 13,
      lineHeight: "20px",
      margin: "4px 0",
    };
    const key = { opacity: 0.62, minWidth: 88, flex: "0 0 auto" };
    const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12 };

    function useGuardState() {
      const [snapshot, setSnapshot] = useState(null);
      const alive = useRef(true);

      const refresh = useCallback(async () => {
        try {
          const response = await fetch("/compat-guard/state", { credentials: "same-origin" });
          if (!response.ok) return;
          const data = await response.json();
          if (alive.current) setSnapshot(data);
        } catch {
          /* the panel stays on its last snapshot; the run itself is unaffected */
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        refresh();
        return () => {
          alive.current = false;
        };
      }, [refresh]);

      // Poll fast while a run is in flight, slowly otherwise, never twice at once.
      useEffect(() => {
        const delay = snapshot?.status === "running" ? 900 : 8000;
        const id = setTimeout(refresh, delay);
        return () => clearTimeout(id);
      }, [snapshot, refresh]);

      return [snapshot, refresh];
    }

    function Panel(props) {
      const [snapshot, refresh] = useGuardState();
      const [busy, setBusy] = useState(false);
      const [target, setTarget] = useState("");
      const [note, setNote] = useState(null);

      const status = snapshot?.status ?? "idle";
      const runningNow = status === "running" || busy;
      const tone = badgeTone(status, snapshot?.verdict);
      const offline = Boolean(snapshot?.reason && /registry|不可达|unreachable|latest/i.test(snapshot.reason)) && status !== "running";

      const start = useCallback(
        async (to) => {
          setBusy(true);
          setNote(null);
          try {
            const response = await fetch("/compat-guard/run", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(to ? { to } : {}),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.ok === false) {
              setNote(data.reason ?? `HTTP ${response.status}`);
            }
            refresh();
          } catch (error) {
            setNote(String(error && error.message ? error.message : error));
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      if (props && props.view === "summary") {
        return h(
          "div",
          { style: { ...row, gap: 10 } },
          h("span", { style: chip(tone) }, runningNow ? S.running : verdictLabel(snapshot?.verdict)),
          h("span", { style: { opacity: 0.7 } }, S.versions),
          h(
            "span",
            { style: mono },
            snapshot?.from ?? "?", " → ", snapshot?.to ?? "?",
          ),
        );
      }

      const counts = snapshot?.counts ?? null;
      const blockers = Array.isArray(snapshot?.blockers) ? snapshot.blockers : [];

      return h(
        "div",
        {
          style: {
            border: "1px solid rgba(128,128,128,.3)",
            borderRadius: 10,
            padding: "14px 16px",
            margin: "8px 0 14px",
          },
        },
        h(
          "div",
          { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          h("span", { style: chip(tone) }, runningNow ? S.running : verdictLabel(snapshot?.verdict)),
          h(
            "button",
            {
              type: "button",
              disabled: runningNow,
              onClick: () => start(),
              style: {
                padding: "5px 14px",
                borderRadius: 7,
                border: "1px solid rgba(128,128,128,.45)",
                background: runningNow ? "rgba(128,128,128,.18)" : "rgba(37,99,235,.12)",
                color: "inherit",
                fontWeight: 600,
                fontSize: 13,
                cursor: runningNow ? "progress" : "pointer",
              },
            },
            runningNow ? S.running : S.run,
          ),
          h(
            "input",
            {
              value: target,
              placeholder: S.placeholder,
              onChange: (event) => setTarget(event.target.value),
              style: {
                width: 150,
                padding: "5px 8px",
                borderRadius: 7,
                border: "1px solid rgba(128,128,128,.45)",
                background: "transparent",
                color: "inherit",
                fontSize: 13,
              },
            },
          ),
          h(
            "button",
            {
              type: "button",
              disabled: runningNow || target.trim() === "",
              onClick: () => start(target.trim()),
              style: {
                padding: "5px 12px",
                borderRadius: 7,
                border: "1px solid rgba(128,128,128,.45)",
                background: "transparent",
                color: "inherit",
                fontSize: 13,
                cursor: runningNow || target.trim() === "" ? "not-allowed" : "pointer",
              },
            },
            S.runTarget,
          ),
        ),

        h("div", { style: { height: 8 } }),

        h(
          "div",
          { style: row },
          h("span", { style: key }, S.versions),
          h("span", { style: mono }, snapshot?.from ?? "?", " → ", snapshot?.to ?? "?"),
        ),
        h(
          "div",
          { style: row },
          h("span", { style: key }, S.result),
          h("span", { style: { fontWeight: 600 } }, runningNow ? S.running : verdictLabel(snapshot?.verdict)),
        ),
        counts
          ? h(
              "div",
              { style: row },
              h("span", { style: key }, S.counts),
              h(
                "span",
                { style: mono },
                String(counts.findings ?? 0), " findings / ",
                String(counts.unknowns ?? 0), " unknown / ",
                String(counts.runtimeBundles ?? 0), "_of_", String(counts.bundles ?? 0), " exercised",
              ),
            )
          : null,
        h(
          "div",
          { style: row },
          h("span", { style: key }, S.risky),
          h(
            "span",
            { style: mono },
            blockers.length === 0 ? S.none : blockers.join(", "),
          ),
        ),

        snapshot?.verdict === "block"
          ? h(
              "div",
              {
                style: {
                  marginTop: 8,
                  padding: "8px 10px",
                  borderRadius: 7,
                  background: "rgba(220,38,38,.1)",
                  fontSize: 13,
                  lineHeight: "19px",
                },
              },
              S.blockHint,
              snapshot?.recommendation ? h("div", { style: { marginTop: 4 } }, snapshot.recommendation) : null,
            )
          : null,

        offline
          ? h(
              "div",
              { style: { marginTop: 8, fontSize: 12, opacity: 0.75 } },
              S.offline,
              snapshot?.reason ? `（${snapshot.reason}）` : "",
            )
          : null,

        note ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLOR.block } }, S.failed, "：", note) : null,

        h(
          "div",
          { style: { marginTop: 10, fontSize: 12, opacity: 0.72, display: "flex", gap: 12, flexWrap: "wrap" } },
          snapshot?.reportPath
            ? h(
                "a",
                {
                  href: "/compat-guard/report",
                  target: "_blank",
                  rel: "noreferrer",
                  style: { color: "inherit", textDecoration: "underline" },
                },
                S.open,
              )
            : h("span", null, S.noReport),
          snapshot?.finishedAt ? h("span", null, S.lastRun, " ", snapshot.finishedAt.replace("T", " ").slice(0, 19)) : null,
          h("span", null, snapshot?.status === "idle" ? S.idle : ""),
        ),
      );
    }

    /**
     * Settings left-nav entry (`settings.section`). The shell renders one nav row
     * per registration and shows this component in the panel content column, so
     * the check is reachable in one click instead of three.
     */
    function Section() {
      return h("div", { style: { padding: "2px 0" } }, h(Panel, { view: "page" }));
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // Kept: the bundle detail page still shows the same block.
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            { name: "plugins.bundle.config", key: "compat-guard-panel" },
            Panel,
          ),
        );
        // New: first-class row in the settings left column.
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "compat-guard",
              order: 40,
              label: () => (zh ? "兼容性预检" : "Compatibility check"),
            },
            Section,
          ),
        );
      },
    };
  },
});
