/**
 * Pipeline orchestration: collect -> static scan -> isolated load -> probe -> aggregate ->
 * report.
 *
 * Aggregation follows the agreed v3 rules:
 *   overall = max(finding levels)
 *   one plugin with >= 3 MEDIUM  -> that plugin is promoted to HIGH
 *   >= 5 MEDIUM across plugins   -> overall drops one level
 *   UNKNOWN never contributes to the max; when unknowns outnumber verified results the
 *   report is marked low-confidence.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collect } from "./collect.js";
import { probeClient } from "./client-probe.js";
import { checkConfigCompatibility, levelForViolation, } from "./config-schema.js";
import { launchIsolated, persistLogs, prepareIsolation, teardown } from "./isolate.js";
import { isAllowlistedForRuntime, HOST_MUTATING_PLUGINS } from "./safety.js";
import { parseSignals, splitServices } from "./signal.js";
import { staticScan } from "./static-scan.js";
import { LEVEL_ORDER, } from "./types.js";
function direction(from, to) {
    const a = from.split("-")[0] ?? "";
    const b = to.split("-")[0] ?? "";
    const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i += 1) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va < vb)
            return "upgrade";
        if (va > vb)
            return "downgrade";
    }
    if (from === to)
        return "sidestep";
    return from < to ? "upgrade" : "downgrade";
}
/** Runtime findings derived from the isolated host's behaviour (items 12/13/14). */
function classifyRuntime(result, ctx, out) {
    if (result.setupError) {
        out.unknowns.push({
            plugin: "(host)",
            item: 12,
            title: "隔离宿主未能启动",
            reason: result.setupError,
            manual: "手工在新版本下启动一次宿主，观察是否有插件相关的崩溃",
        });
        return;
    }
    const seen = new Set(out.findings.map((f) => `${f.plugin}#${f.item}`));
    for (const signal of result.signals) {
        if (signal.kind === "stack-frame") {
            const plugin = signal.plugin ?? "(unknown)";
            const key = `${plugin}#12`;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.findings.push({
                plugin,
                item: 12,
                title: "隔离宿主启动时出现该插件的栈帧",
                level: "BLOCKER",
                detail: signal.line.trim(),
                evidence: "隔离环境 stderr 中的调用栈",
                action: "临时禁用该插件后重试更新",
                runtimeVerified: true,
            });
            continue;
        }
        if (signal.kind === "preflight-disabled") {
            const plugin = signal.plugin ?? "(unknown)";
            const already = out.findings.some((f) => f.plugin === plugin && f.item === 1);
            if (already)
                continue;
            out.findings.push({
                plugin,
                item: 1,
                title: "宿主 preflight 已抑制该插件",
                level: "BLOCKER",
                detail: `宿主输出：${signal.line.trim()}`,
                evidence: "隔离环境 stderr（宿主自身的兼容性预检）",
                action: "该插件在目标版本下不会加载；如需保留需授予精确版本豁免",
                runtimeVerified: true,
            });
            continue;
        }
        if (signal.kind === "did-not-activate") {
            out.findings.push({
                plugin: "(profile)",
                item: 12,
                title: "有条目未激活",
                level: "HIGH",
                detail: `宿主输出：${signal.line.trim()}（共 ${signal.detail ?? "?"} 条）`,
                evidence: "隔离环境 stderr",
                action: "对照明细逐条确认；被 preflight 抑制的条目属预期，其余需排查",
                runtimeVerified: true,
            });
            continue;
        }
        if (signal.kind === "pending") {
            const services = splitServices(signal.detail).join(", ");
            out.unknowns.push({
                plugin: signal.plugin ?? "(unknown)",
                item: 12,
                title: "插件未激活（等待服务）",
                reason: `等待服务：${services || "(未解析)"}。隔离 profile 只挂载了白名单内的 bundle，缺服务很可能是本次组合造成的，而非插件缺陷`,
                manual: "在真实 profile 下确认该服务存在；或把提供该服务的 bundle 加入运行时白名单后重跑",
            });
        }
    }
    if (!result.ready) {
        const hasPluginFrame = result.signals.some((s) => s.kind === "stack-frame");
        if (!hasPluginFrame) {
            if (result.killedByTimeout) {
                // Timeout is not a verdict: it means the check could not reach a conclusion.
                out.unknowns.push({
                    plugin: "(host)",
                    item: 12,
                    title: "隔离宿主在超时前未就绪",
                    reason: `端口 ${result.port} 始终未监听，进程被超时终止（预算耗尽）`,
                    manual: "提高 DSH_GUARD_TIMEOUT_MS 后重跑；或手工在新版本下启动一次宿主",
                });
            }
            else {
                out.findings.push({
                    plugin: "(host)",
                    item: 12,
                    title: "隔离宿主启动失败",
                    level: "HIGH",
                    detail: `exitCode=${result.exitCode ?? "-"}，端口 ${result.port} 始终未监听，且未捕获插件栈帧`,
                    evidence: "隔离环境进程状态",
                    action: "查看 isolated-host.log；若 stderr 只有宿主自身报错，属宿主问题而非插件问题",
                    runtimeVerified: true,
                });
            }
        }
    }
}
/**
 * Item 16 — client-side evidence. Kept fully separate from classifyRuntime because the two
 * chains fail independently: a host that boots cleanly can still ship a blank UI.
 *
 * Grading mirrors the design doc, with one deliberate deviation: an unattributable
 * `request-failed` is MEDIUM, not BLOCKER. Browsers routinely cancel requests during
 * navigation, so a cancelled asset is weak evidence on its own; 4xx/5xx on a module URL is
 * strong evidence and stays BLOCKER.
 */
function classifyClient(probe, out) {
    if (!probe.attempted)
        return;
    if (probe.error !== undefined || !probe.browserLaunched) {
        out.unknowns.push({
            plugin: "(client)",
            item: 16,
            title: "client 侧无法探测",
            reason: probe.error ?? "浏览器启动失败",
            manual: "确认本机可用 Microsoft Edge（或安装 playwright 的 chromium）后重跑；在此之前 client 侧完全未验证",
        });
        return;
    }
    if (!probe.pageLoaded) {
        out.unknowns.push({
            plugin: "(client)",
            item: 16,
            title: "页面未能加载",
            reason: probe.error ?? "navigate 阶段失败",
            manual: "手工打开隔离端口的首页，确认服务是否真的在提供 HTML",
        });
        return;
    }
    const seen = new Set();
    const push = (finding) => {
        const key = `${finding.plugin}#${finding.item}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.findings.push(finding);
    };
    for (const issue of probe.issues) {
        if (issue.kind === "pageerror") {
            const plugin = issue.plugin ?? "(client)";
            push({
                plugin,
                item: 16,
                title: "client bundle 抛出未捕获异常",
                level: issue.plugin === undefined ? "HIGH" : "BLOCKER",
                detail: issue.text,
                evidence: "headless 浏览器 pageerror",
                action: "更新后界面会白屏或功能缺失；临时禁用该插件",
                runtimeVerified: true,
            });
            continue;
        }
        if (issue.kind === "http-error") {
            // 4xx/5xx on a module URL means the client bundle could not be fetched at all.
            const plugin = issue.plugin ?? "(client)";
            push({
                plugin,
                item: 16,
                title: "client 资源请求返回错误状态",
                level: issue.plugin === undefined ? "MEDIUM" : "BLOCKER",
                detail: issue.text,
                evidence: "headless 浏览器 HTTP 响应",
                action: "确认该插件的 dsh.client 入口是否存在于新版本宿主",
                runtimeVerified: true,
            });
            continue;
        }
        if (issue.kind === "request-failed") {
            push({
                plugin: issue.plugin ?? "(client)",
                item: 16,
                title: "client 资源请求失败",
                level: "MEDIUM",
                detail: issue.text,
                evidence: "headless 浏览器 requestfailed（可能是导航期取消，属弱证据）",
                action: "对照 isolated-host.log 与该插件的 dsh.client.inject 清单逐条确认",
                runtimeVerified: true,
            });
            continue;
        }
        // console-error
        push({
            plugin: issue.plugin ?? "(client)",
            item: 16,
            title: "client 侧 console 报错",
            level: "MEDIUM",
            detail: issue.text,
            evidence: "headless 浏览器 console.error",
            action: "更新后重点观察该插件涉及的 UI 区域",
            runtimeVerified: true,
        });
    }
    if (!probe.renderOk) {
        const notes = probe.notes.length > 0 ? probe.notes.join("；") : "无额外观测";
        push({
            plugin: "(client)",
            item: 16,
            title: "页面在预算内没有渲染出可见内容",
            level: "HIGH",
            detail: `通用判据（body 有元素子节点且正文非空）未在预算内满足。观测：${notes}`,
            evidence: "headless 浏览器 + 结构性渲染判据",
            action: "优先排查 client 侧注入；若浏览器本身就打不开端口，需先确认隔离宿主真的在提供页面",
            runtimeVerified: true,
        });
    }
}
function promotePerPlugin(findings) {
    const byPlugin = new Map();
    for (const f of findings) {
        const list = byPlugin.get(f.plugin) ?? [];
        list.push(f);
        byPlugin.set(f.plugin, list);
    }
    const promoted = [];
    for (const [plugin, list] of byPlugin) {
        const mediums = list.filter((f) => f.level === "MEDIUM").length;
        if (mediums >= 3) {
            promoted.push({
                plugin,
                item: 0,
                title: "多项中等风险累积升级",
                level: "HIGH",
                detail: `该插件命中 ${mediums} 项 MEDIUM；按聚合规则升级为 HIGH`,
                evidence: "聚合规则：同插件 >=3 项 MEDIUM 升 HIGH",
                action: "建议临时禁用",
                runtimeVerified: list.some((f) => f.runtimeVerified),
            });
        }
    }
    return [...findings, ...promoted];
}
function aggregate(findings, unknowns, direction) {
    if (findings.length === 0) {
        return { overall: "PASS", lowConfidence: unknowns.length > 0 };
    }
    // The accumulation rules exist to model risk *added by a version change*. On a
    // same-version run nothing changed, so every finding is a pre-existing state and
    // aggregating them upward would report a risk the update did not introduce.
    const accumulate = direction !== "sidestep";
    const promoted = accumulate ? promotePerPlugin(findings) : findings;
    let max = 0;
    for (const f of promoted)
        max = Math.max(max, LEVEL_ORDER[f.level]);
    let overall = Object.keys(LEVEL_ORDER).find((k) => LEVEL_ORDER[k] === max) ?? "LOW";
    const mediums = promoted.filter((f) => f.level === "MEDIUM").length;
    if (accumulate && mediums >= 5 && overall === "MEDIUM")
        overall = "HIGH";
    const verified = promoted.filter((f) => f.runtimeVerified).length;
    const lowConfidence = unknowns.length > verified;
    return { overall, lowConfidence };
}
function verdictFor(overall) {
    // Only a BLOCKER blocks an install. HIGH means "recommend disabling these plugins",
    // which is an informed choice the user must still be able to make — blocking on it
    // would turn a single false positive into a refused update (§3.5, fail-open default).
    if (overall === "PASS" || overall === "LOW")
        return { verdict: "pass", exitCode: 0 };
    if (overall === "MEDIUM" || overall === "HIGH")
        return { verdict: "warn", exitCode: 2 };
    return { verdict: "block", exitCode: 1 };
}
function headlineFor(report) {
    const blockers = report.findings.filter((f) => f.level === "BLOCKER");
    const highs = report.findings.filter((f) => f.level === "HIGH");
    if (report.overall === "PASS") {
        return `未发现风险：${report.counts.bundles} 个插件在加载与初始化层面通过检查。`;
    }
    const parts = [];
    if (blockers.length > 0)
        parts.push(`${blockers.length} 项阻断级`);
    if (highs.length > 0)
        parts.push(`${highs.length} 项高风险`);
    if (parts.length === 0)
        parts.push(`整体 ${report.overall}`);
    return `${parts.join("、")}：${report.overall}。${blockers[0]?.plugin ? `优先处理 ${blockers[0].plugin}。` : ""}`;
}
function renderMarkdown(report) {
    const lines = [];
    lines.push("# 插件兼容性预检报告", "");
    lines.push(`- 检查时间：${report.generatedAt}`);
    lines.push(`- 宿主版本：${report.fromVersion} → **${report.toVersion}**（${report.direction}）`);
    lines.push(`- 配置文件：\`${report.profileDir}\``);
    lines.push(`- 插件集合指纹：\`${report.pluginSetHash}\``);
    lines.push(`- 规模：bundles ${report.counts.bundles} 个 / 隔离挂载 ${report.counts.runtimeBundles} 个 / 静态检查 ${report.counts.findings} 项 / 未判定 ${report.counts.unknowns} 项`);
    lines.push(`- 隔离试加载：${report.runtime.attempted ? (report.runtime.ready ? `就绪（${report.runtime.readyBy}，${report.runtime.readyAtMs}ms，端口 ${report.runtime.port}）` : "未就绪") : "本次未执行"}`);
    lines.push(`- client 侧探测：${describeClient(report.client)}`);
    lines.push(`- 配置 schema：${describeConfig(report.config)}`);
    lines.push(`- 宿主进程：${describeHostRunning(report)}`);
    lines.push(`- **结论：${report.overall}${report.lowConfidence ? "（可信度低）" : ""}**`, "");
    lines.push("---", "", "## 一句话结论", "", report.headline, "");
    if (report.runtime.skippedBundles.length > 0) {
        lines.push("## 未做运行期验证的插件", "");
        lines.push("以下插件不在运行时白名单内（白名单用于防止会改写宿主安装目录的插件进入隔离环境），本次只做了静态检查：", "");
        for (const name of report.runtime.skippedBundles)
            lines.push(`- \`${name}\``);
        lines.push("");
    }
    if (report.findings.length > 0) {
        lines.push("## 有风险的插件", "");
        lines.push("| 插件 | 检查项 | 风险等级 | 问题 | 证据 | 建议 | 运行期验证 |");
        lines.push("|---|---|---|---|---|---|---|");
        for (const f of report.findings) {
            lines.push(`| ${f.plugin} | ${f.item} ${f.title} | **${f.level}** | ${esc(f.detail)} | ${esc(f.evidence)} | ${esc(f.action)} | ${f.runtimeVerified ? "是" : "否"} |`);
        }
        lines.push("");
    }
    if (report.unknowns.length > 0) {
        lines.push("## 未判定项（需人工确认）", "");
        lines.push("| 插件 | 检查项 | 类别 | 原因 | 人工兜底 |");
        lines.push("|---|---|---|---|---|");
        for (const u of report.unknowns) {
            lines.push(`| ${u.plugin} | ${u.item} ${u.title} | UNKNOWN | ${esc(u.reason)} | ${esc(u.manual)} |`);
        }
        lines.push("");
    }
    if (report.client.attempted) {
    }
    {
        lines.push("## 配置 schema 兼容（检查项 9）", "");
        const c = report.config;
        if (!c.attempted) {
            lines.push("- 未执行：隔离环境未就绪，无法向目标版本索取 `--dump-config-schema`。", "");
        }
        else if (!c.schemaOk) {
            lines.push(`- **schema 生成失败**：${esc(c.error ?? "未知原因")}`, "");
        }
        else {
            lines.push(`- schema 来源：目标版本宿主自生成（${c.entryBranches} 个条目分支）`);
            lines.push(`- 已校验条目：${c.checked} 个｜违规：${c.violationCount} 个｜无法判定：${c.unjudgedCount} 个`);
            if (c.skippedBundles.length > 0) {
                lines.push(`- 被宿主 preflight 跳过、因而没有 schema 的 bundle：${c.skippedBundles.map((b) => `\`${b}\``).join("、")}`);
            }
            lines.push(`- 说明：只校验「宿主自己声明过 schema」的条目；未声明 schema 的插件记为无法判定，**不等于通过**。`);
            lines.push("");
        }
    }
    if (report.client.attempted) {
        lines.push("## client 侧（阶段 2b）", "");
        lines.push(`- 浏览器：${report.client.browserLaunched ? `已启动（${report.client.browserChannel ?? "-"}）` : "未启动"}`);
        lines.push(`- 页面加载：${report.client.pageLoaded ? "成功" : "失败"}`);
        lines.push(`- 渲染判据：${report.client.renderOk ? `通过（${report.client.renderWaitMs ?? "-"}ms）` : "**未通过**（本报告只做结构性判断，不比对画面）"}`);
        if (report.client.implicatedPlugins.length > 0) {
            lines.push("- 命中插件：" + report.client.implicatedPlugins.map((p) => `\`${p}\``).join("、"));
        }
        if (report.client.error !== undefined)
            lines.push(`- 探测错误：${esc(report.client.error)}`);
        lines.push("");
    }
    if (report.runtime.note) {
        lines.push("## 运行环境说明", "", report.runtime.note, "");
    }
    lines.push("---", "", "## 本次检查的边界", "");
    lines.push("- 已验证：能否加载、注入、注册、被宿主 preflight 放行。");
    lines.push("- **未验证**：懒加载功能路径、真实数据下的行为、UI 交互、长时间稳定性、语义级行为变更。");
    lines.push("- `PASS` 不等于“完全兼容”，只等于“未发现加载期崩溃风险”。");
    lines.push("");
    return lines.join("\n");
}
function describeHostRunning(report) {
    if (report.hostRunning === null) {
        return `未探测（${report.hostEvidence || "无证据"}）`;
    }
    if (!report.hostRunning)
        return "未运行";
    const note = report.runtime.attempted && report.runtime.ready
        ? "仍在运行，隔离试加载已完成（独立 DSH_HOME + 随机端口，未受影响）"
        : "正在运行";
    return `${note}（${report.hostEvidence}）`;
}
function describeConfig(config) {
    if (!config.attempted)
        return "未执行（隔离环境未就绪）";
    if (!config.schemaOk)
        return `**失败**（${config.error ?? "未知原因"}）`;
    if (config.violationCount > 0)
        return `**${config.violationCount} 个配置与目标版本 schema 不符**`;
    return `通过（校验 ${config.checked} 个条目，${config.unjudgedCount} 个无法判定）`;
}
function describeClient(client) {
    if (!client.attempted)
        return "本次未执行";
    if (client.error !== undefined || !client.browserLaunched) {
        return `无法探测（${client.error ?? "浏览器未启动"}）`;
    }
    const bits = [client.browserChannel ?? "unknown-channel"];
    bits.push(client.pageLoaded ? "页面已加载" : "页面未加载");
    bits.push(client.renderOk
        ? `已渲染${client.renderWaitMs !== null ? `（${client.renderWaitMs}ms）` : ""}`
        : "**未渲染**");
    if (client.issueCount > 0)
        bits.push(`${client.issueCount} 条 client 侧异常`);
    return bits.join("，");
}
function esc(value) {
    return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
export async function runCheck(options) {
    const { log } = options;
    const ctx = collect({
        profileDir: options.profileDir,
        fromVersion: options.fromVersion,
        toVersion: options.toVersion,
    });
    log(`collected ${ctx.bundles.length} bundles, ${ctx.plugins.length} manifests`);
    // Split bundles into "will be mounted" vs "static only".
    for (const bundle of ctx.bundles) {
        if (isAllowlistedForRuntime(bundle))
            ctx.runtimeBundles.push(bundle);
        else
            ctx.skippedRuntime.push(bundle);
    }
    // Boot-required bundles. dsh-credentials-local is on this list because the web UI's launch
    // token is only announced once the `connection` service exists; without it the isolated host
    // listens but answers 401 forever, which would make stage 2b impossible rather than failing.
    // These are host-internal packages, not user plugins, so adding them does not change what is
    // being verified about the user's own plugin set.
    const bootRequired = [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-credentials-local",
    ];
    for (const required of bootRequired) {
        if (ctx.runtimeBundles.includes(required))
            continue;
        const onDisk = existsSync(join(options.profileDir, "node_modules", required, "package.json"));
        if (onDisk) {
            ctx.runtimeBundles.unshift(required);
            ctx.skippedRuntime = ctx.skippedRuntime.filter((b) => b !== required);
        }
    }
    log(`runtime bundles: ${ctx.runtimeBundles.length}, static only: ${ctx.skippedRuntime.length}`);
    const scan = await staticScan(ctx);
    log(`static findings: ${scan.findings.length}, unknowns: ${scan.unknowns.length}`);
    const findings = [...scan.findings];
    const unknowns = [...scan.unknowns];
    let clientProbe;
    let clientOutcome = {
        attempted: false,
        browserLaunched: false,
        browserChannel: null,
        pageLoaded: false,
        renderOk: false,
        renderWaitMs: null,
        issueCount: 0,
        implicatedPlugins: [],
    };
    let configCheck = null;
    let runtime = {
        attempted: false,
        ready: false,
        readyBy: null,
        readyAtMs: null,
        port: null,
        skippedBundles: ctx.skippedRuntime,
        note: "",
    };
    if (options.runtime) {
        runtime.attempted = true;
        let handle;
        try {
            handle = prepareIsolation({
                profileDir: options.profileDir,
                runtimeBundles: ctx.runtimeBundles,
                timeoutMs: options.timeoutMs,
                log,
            });
        }
        catch (error) {
            runtime.note = `隔离环境准备失败：${String(error)}`;
            unknowns.push({
                plugin: "(host)",
                item: 12,
                title: "隔离环境准备失败",
                reason: String(error),
                manual: "检查磁盘空间与 %TEMP% 权限后重跑",
            });
        }
        if (handle) {
            // Item 9 — the target host generates its own config schema; validate the
            // composed config the host is about to mount against it. Runs before the
            // mount, so a config the target release rejects is known independently of
            // whether the plugin then crashes.
            try {
                configCheck = await checkConfigCompatibility(handle, Math.min(60_000, options.timeoutMs));
                log(`config schema: ok=${configCheck.schema.ok} branches=${configCheck.schema.entryBranches} ` +
                    `slots=${configCheck.slots} entries=${configCheck.entries} withConfig=${configCheck.withConfig} ` +
                    `checked=${configCheck.checked} violations=${configCheck.violations.length} ` +
                    `unjudged=${configCheck.unjudged.length}`);
                if (configCheck.unjudged.length > 0) {
                    log(`config schema: unjudged sample: ${configCheck.unjudged.slice(0, 5).join(" | ")}`);
                }
                if (configCheck.schema.skippedBundles.length > 0) {
                    log(`config schema: preflight skipped ${configCheck.schema.skippedBundles.join(", ")}`);
                }
            }
            catch (error) {
                log(`config schema: failed ${String(error)}`);
                configCheck = null;
            }
            let result;
            try {
                result = await launchIsolated(handle, {
                    timeoutMs: options.timeoutMs,
                    log,
                    // Stage 2b runs inside the ready-window, before the host is killed.
                    onReady: options.client
                        ? async ({ port, url }) => {
                            clientProbe = await probeClient({
                                port,
                                url,
                                timeoutMs: Math.min(60_000, options.timeoutMs),
                                settleMs: 1500,
                                log,
                            });
                            log(`client probe: browser=${clientProbe.browserLaunched} channel=${clientProbe.browserChannel ?? "-"} loaded=${clientProbe.pageLoaded} render=${clientProbe.renderOk} issues=${clientProbe.issues.length}`);
                        }
                        : undefined,
                });
                // Re-parse with stdout included: some lines arrive on stdout.
                result.signals = parseSignals(result.stderr, result.stdout);
            }
            finally {
                // Persist before teardown so the log survives the cleanup.
                try {
                    // Support files live under _archive/: out/ itself must stay one-directory-per-run.
                    const probe = join(options.outDir, "_archive", "pending");
                    mkdirSync(probe, { recursive: true });
                }
                catch {
                    /* ignore */
                }
            }
            runtime.ready = result.ready;
            runtime.readyBy = result.readyBy;
            runtime.readyAtMs = result.readyAtMs;
            runtime.port = result.port;
            log(`isolated host: ready=${result.ready} by=${result.readyBy ?? "-"} at=${result.readyAtMs ?? "-"}ms exit=${result.exitCode ?? "-"}`);
            classifyRuntime(result, ctx, { findings, unknowns });
            if (options.client && clientProbe !== undefined) {
                const cp = clientProbe;
                clientOutcome = {
                    attempted: cp.attempted,
                    browserLaunched: cp.browserLaunched,
                    browserChannel: cp.browserChannel,
                    pageLoaded: cp.pageLoaded,
                    renderOk: cp.renderOk,
                    renderWaitMs: cp.renderWaitMs,
                    issueCount: cp.issues.length,
                    implicatedPlugins: [
                        ...new Set(cp.issues
                            .map((i) => i.plugin)
                            .filter((p) => typeof p === "string" && p.length > 0)),
                    ],
                    ...(cp.error === undefined ? {} : { error: cp.error }),
                };
                classifyClient(cp, { findings, unknowns });
            }
            else if (options.client) {
                unknowns.push({
                    plugin: "(client)",
                    item: 16,
                    title: "client 侧未探测",
                    reason: "隔离宿主未就绪，没有可供浏览器访问的端口",
                    manual: "先解决隔离宿主启动问题，再重跑以覆盖 client 侧",
                });
            }
            try {
                persistLogs(handle, result, options.outDir);
            }
            catch (error) {
                log(`WARN failed to persist isolated log: ${String(error)}`);
            }
            teardown(handle);
        }
    }
    else {
        runtime.note = "本次以 --no-runtime 运行，未执行隔离试加载。";
    }
    // Item 9 findings are contributed before aggregation so they take part in the
    // promotion/accumulation rules like any other static result.
    if (configCheck) {
        for (const violation of configCheck.violations) {
            findings.push({
                plugin: violation.entryName,
                item: 9,
                title: "配置对象与目标版本的插件 schema 不符",
                level: levelForViolation(violation),
                detail: `${violation.instancePath} 处 ${violation.keyword} 校验失败：${violation.message}`,
                evidence: `宿主自生成 schema（${configCheck.schema.entryBranches} 个条目分支）拒绝该配置；条目 ${violation.entryId ?? "(无 id)"}`,
                action: "更新后到该插件的设置里修正此字段，或临时禁用该插件",
                runtimeVerified: false,
            });
        }
        if (configCheck.schema.skippedBundles.length > 0) {
            unknowns.push({
                plugin: configCheck.schema.skippedBundles.join(", "),
                item: 9,
                title: "被宿主 preflight 跳过的 bundle 无法校验配置",
                reason: "这些 bundle 未通过宿主的版本约束预检，因此不存在对应的 config schema 分支",
                manual: "先解决版本约束（升级插件或授予精确版本豁免），再重跑检查",
            });
        }
        const unjudged = configCheck.unjudged;
        if (unjudged.length > 0) {
            unknowns.push({
                plugin: unjudged.slice(0, 8).join(", ") + (unjudged.length > 8 ? " …" : ""),
                item: 9,
                title: `配置无法判定（${unjudged.length} 个条目）`,
                reason: "该条目没有 schema 分支，或配置是 !!js 表达式（运行期才求值）",
                manual: "更新后观察这些插件的行为变化；若某个插件功能异常，优先怀疑它的配置字段",
            });
        }
    }
    else if (options.runtime) {
        unknowns.push({
            plugin: "(host)",
            item: 9,
            title: "配置 schema 校验未执行",
            reason: "隔离环境未就绪，无法向目标版本索取 --dump-config-schema",
            manual: "排障后重跑，或用 `dsh --profile <p> --dump-config-schema` 手工核对",
        });
    }
    const route = direction(options.fromVersion, options.toVersion);
    const { overall, lowConfidence } = aggregate(findings, unknowns, route);
    const report = {
        schemaVersion: 1,
        generatedAt: ctx.generatedAt,
        fromVersion: options.fromVersion,
        toVersion: options.toVersion,
        direction: route,
        profileDir: options.profileDir,
        pluginSetHash: ctx.pluginSetHash,
        overall,
        lowConfidence,
        findings,
        unknowns,
        runtime,
        client: clientOutcome,
        hostRunning: options.hostRunning ?? null,
        hostEvidence: options.hostEvidence ?? "",
        config: {
            attempted: configCheck !== null,
            schemaOk: configCheck?.schema.ok ?? false,
            entryBranches: configCheck?.schema.entryBranches ?? 0,
            checked: configCheck?.checked ?? 0,
            violationCount: configCheck?.violations.length ?? 0,
            unjudgedCount: configCheck?.unjudged.length ?? 0,
            skippedBundles: configCheck?.schema.skippedBundles ?? [],
            error: configCheck?.schema.error ?? null,
        },
        counts: {
            plugins: ctx.plugins.length,
            bundles: ctx.bundles.length,
            runtimeBundles: ctx.runtimeBundles.length,
            findings: findings.length,
            unknowns: unknowns.length,
        },
        headline: "",
    };
    report.headline = headlineFor(report);
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const dir = join(options.outDir, stamp);
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, "report.json");
    const mdPath = join(dir, "report.md");
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    writeFileSync(mdPath, renderMarkdown(report), "utf8");
    const { verdict, exitCode } = verdictFor(overall);
    return { report, reportJsonPath: jsonPath, reportMarkdownPath: mdPath, verdict, exitCode };
}
export { HOST_MUTATING_PLUGINS };
