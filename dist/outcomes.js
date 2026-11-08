const THROTTLE_RE = /\b(429|rate[-\s]?limit|throttl\w*|too many requests|quota)\b/i;
const BUILD_SCRIPT_KEYS = ["preinstall", "install", "postinstall", "prepare"];
function declaresBuildScript(plugin) {
    const scripts = plugin.raw?.scripts;
    if (scripts === undefined || scripts === null || typeof scripts !== "object")
        return false;
    return BUILD_SCRIPT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(scripts, key));
}
export function deriveOutcomes(input) {
    const { ctx, runtime, client, config, findings, reason, timeoutMs } = input;
    const blockers = findings.filter((f) => f.level === "BLOCKER");
    const blockedByVersion = blockers.filter((f) => f.item === 1 || f.item === 6).map((f) => f.plugin);
    const buildScriptPackages = ctx.plugins.filter(declaresBuildScript).map((p) => p.name);
    const nonLayer = ctx.plugins.filter((p) => p.bundlePatch === undefined).map((p) => p.name);
    const timedOut = reason !== null && /timeout/i.test(reason);
    let pluginLoad;
    if (!runtime.attempted) {
        pluginLoad = { status: "not-run", detail: runtime.note || "隔离试加载未执行" };
    }
    else if (timedOut) {
        pluginLoad = { status: "timeout", detail: reason ?? "超出预算" };
    }
    else if (runtime.ready) {
        pluginLoad = { status: "pass", detail: `就绪（${runtime.readyBy ?? "-"}，${runtime.readyAtMs ?? "-"}ms）` };
    }
    else {
        pluginLoad = { status: "fail", detail: runtime.note || "隔离宿主未就绪" };
    }
    let clientRender;
    if (!client.attempted) {
        clientRender = { status: "not-run", detail: "未探测" };
    }
    else if (client.renderOk) {
        clientRender = { status: "pass", detail: `已渲染（${client.renderWaitMs ?? "-"}ms）` };
    }
    else {
        clientRender = { status: "fail", detail: client.error ?? "页面未渲染" };
    }
    let configSchema;
    if (!config.attempted) {
        configSchema = { status: "not-run", detail: "未执行" };
    }
    else if (!config.schemaOk) {
        configSchema = { status: "unavailable", detail: config.error ?? "schema 不可用" };
    }
    else if (config.violationCount > 0) {
        configSchema = { status: "violation", detail: `${config.violationCount} 处配置与目标版本 schema 不符` };
    }
    else {
        configSchema = {
            status: "pass",
            detail: `校验 ${config.checked} 个条目，${config.unjudgedCount} 个无法判定`,
        };
    }
    const throttleEvidence = [];
    const scanned = [runtime.note, client.error ?? "", config.error ?? "", reason ?? ""].join("\n");
    for (const line of scanned.split(/\r?\n/)) {
        if (line.trim() !== "" && THROTTLE_RE.test(line))
            throttleEvidence.push(line.trim());
    }
    for (const f of findings) {
        if (THROTTLE_RE.test(f.detail) || THROTTLE_RE.test(f.evidence))
            throttleEvidence.push(`${f.plugin}#${f.item}`);
    }
    const hostThrottling = throttleEvidence.length > 0
        ? { status: "observed", evidence: [...new Set(throttleEvidence)].slice(0, 5) }
        : runtime.attempted
            ? { status: "none", evidence: [] }
            : { status: "unknown", evidence: [] };
    const defects = findings.filter((f) => f.level !== "BLOCKER").map((f) => `${f.plugin}#${f.item}: ${f.title}`);
    return {
        versionConstraints: {
            status: blockers.length === 0 ? "pass" : blockedByVersion.length > 0 ? "blocked" : "unknown",
            blocked: [...new Set(blockedByVersion)],
        },
        buildScriptApproval: {
            status: buildScriptPackages.length > 0 ? "declared" : "not-required",
            packages: buildScriptPackages,
        },
        nonLayerPackages: {
            status: nonLayer.length > 0 ? "present" : "none",
            packages: nonLayer,
        },
        pluginLoad,
        clientRender,
        configSchema,
        hostThrottling,
        defects: { status: defects.length > 0 ? "present" : "none", items: defects.slice(0, 20) },
        timeout: { hit: timedOut, budgetMs: timeoutMs },
    };
}
/** One-line-per-axis rendering for report.md. */
export function describeOutcomes(outcomes) {
    const line = (label, status, detail = "") => `- ${label}：**${status}**${detail === "" ? "" : `（${detail}）`}`;
    return [
        line("版本约束", outcomes.versionConstraints.status, outcomes.versionConstraints.blocked.join("、")),
        line("构建脚本", outcomes.buildScriptApproval.status, outcomes.buildScriptApproval.packages.slice(0, 5).join("、")),
        line("非 layer 包", outcomes.nonLayerPackages.status, outcomes.nonLayerPackages.packages.slice(0, 5).join("、")),
        line("插件加载", outcomes.pluginLoad.status, outcomes.pluginLoad.detail),
        line("界面渲染", outcomes.clientRender.status, outcomes.clientRender.detail),
        line("配置 schema", outcomes.configSchema.status, outcomes.configSchema.detail),
        line("宿主限流", outcomes.hostThrottling.status, outcomes.hostThrottling.evidence.join("；")),
        line("非阻断缺陷", outcomes.defects.status, String(outcomes.defects.items.length)),
        line("预算是否耗尽", outcomes.timeout.hit ? "yes" : "no", `${outcomes.timeout.budgetMs}ms`),
    ];
}
