/**
 * Stage 1 — static scan.
 *
 * Design rule: static scanning produces *suspicions that need runtime evidence*, with one
 * exception — a bundle that is declared but absent from node_modules is a certainty and is
 * reported as BLOCKER directly.
 *
 * Semantics mirror the host's own preflight exactly (`semver.satisfies(v, range,
 * { includePrerelease: true })`), so the two never disagree about the same manifest.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import semver from "semver";
import ts from "typescript";
import { buildEventTable, extractEventUses } from "./event-table.js";
import { surveyDependencies } from "./dep-tree.js";
const HOST_ENTRY_PACKAGES = ["@deepseek-ai/cordis", "@deepseek-ai/dsh"];
function satisfies(target, range) {
    try {
        return semver.satisfies(target, range.trim(), { includePrerelease: true });
    }
    catch {
        return false;
    }
}
function isExempted(plugin, toVersion, exemptions) {
    const key = `${plugin.name}@${plugin.version}`;
    return (exemptions[key] ?? []).includes(toVersion);
}
/**
 * Check item 1 + 15: declared host range, and the plugin's own release map.
 *
 * Two corrections over the naive form, both forced by the same-version self-check:
 *
 *  a) Host-shipped bundles (`@deepseek-ai/dsh-*`) are part of the host itself and carry no
 *     meaningful version declaration of their own; asserting on them only manufactures
 *     UNKNOWN noise.
 *  b) A range is evaluated on BOTH sides of the update. "The declared range excludes the
 *     target" is only a risk *introduced by this update* when it also included the current
 *     version. If it excludes both, the mismatch predates the update and must not block it.
 */
function checkVersionConstraints(ctx, out) {
    const { toVersion, fromVersion } = ctx;
    for (const plugin of ctx.plugins) {
        if (plugin.name.startsWith("@deepseek-ai/dsh"))
            continue; // host-shipped bundle
        const peerRanges = Object.entries(plugin.hostPeers);
        const declared = plugin.enginesDsh
            ? [{ field: "engines.dsh", range: plugin.enginesDsh }]
            : peerRanges.map(([name, range]) => ({ field: `peer ${name}`, range }));
        if (declared.length === 0) {
            out.unknowns.push({
                plugin: plugin.name,
                item: 1,
                title: "宿主版本约束",
                reason: "插件未声明 dsh.engines.dsh，也没有 @deepseek-ai/dsh* 的 peerDependencies",
                manual: "查看插件 README 的兼容说明，或在新版本下手工加载一次",
            });
            continue;
        }
        const unmetTo = declared.filter((d) => !satisfies(toVersion, d.range));
        if (unmetTo.length === 0) {
            // Item 15: the plugin's self-reported release map. The host does NOT read this field,
            // so it is a Compat Guard-only signal.
            if (plugin.dshReleases && Object.keys(plugin.dshReleases).length > 0) {
                if (!(toVersion in plugin.dshReleases)) {
                    out.findings.push({
                        plugin: plugin.name,
                        item: 15,
                        title: "插件自报适配版本未覆盖目标版本",
                        level: "MEDIUM",
                        detail: `dsh.compatibility.dshReleases 未列出 ${toVersion}（已列出：${Object.keys(plugin.dshReleases).join(", ")}）`,
                        evidence: "插件 package.json 的 dsh.compatibility.dshReleases（宿主不使用该字段）",
                        action: "放行但观察；插件作者未对该宿主版本做过验证声明",
                        runtimeVerified: false,
                    });
                }
            }
            continue;
        }
        const unmetFrom = declared.filter((d) => !satisfies(fromVersion, d.range));
        const preexisting = unmetFrom.length > 0;
        const exempted = isExempted(plugin, toVersion, ctx.exemptions);
        const detail = unmetTo.map((d) => `${d.field}=${d.range}`).join("; ");
        out.findings.push({
            plugin: plugin.name,
            item: 1,
            title: preexisting ? "宿主版本约束不满足（更新前即已如此）" : "宿主版本约束不满足",
            level: exempted ? "MEDIUM" : preexisting ? "MEDIUM" : "BLOCKER",
            detail: `目标版本 ${toVersion} 不落在声明区间内：${detail}` +
                (preexisting
                    ? `；当前版本 ${fromVersion} 同样不在区间内，属既存偏差，不是本次更新引入`
                    : `；当前版本 ${fromVersion} 在区间内，本次更新会使其失配`),
            evidence: "插件 package.json 的 dsh.engines.dsh / peerDependencies",
            action: exempted
                ? "用户已授予精确版本豁免，宿主不会禁用该插件；风险自负"
                : preexisting
                    ? "放行；如需消除宿主 stderr 的 disabling 提示，可授予精确版本豁免或升级插件"
                    : `宿主 preflight 会在加载前禁用该插件（stderr: disabling profile plugin）；` +
                        `如需强行保留：dsh plugin --profile desktop allow-version ${plugin.name}@${plugin.version} ` +
                        `--dsh-version ${toVersion} --accept-risk`,
            runtimeVerified: false,
        });
    }
}
function installedVersion(profileDir, packageName) {
    try {
        const manifestPath = join(profileDir, "node_modules", packageName, "package.json");
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
        return typeof parsed.version === "string" ? parsed.version : null;
    }
    catch {
        return null;
    }
}
/** Check item 6: host packages appearing anywhere in the dependency closure. */
function checkHostDependencies(ctx, out) {
    const { toVersion } = ctx;
    const targetMajor = semver.valid(toVersion) ? semver.major(toVersion) : null;
    // @deepseek-ai/cordis has its own version line: it must be compared against the version
    // actually installed in the profile, NOT against the host version. Comparing it to the
    // host version flagged 15 bundles as BLOCKER on an identical from/to version, which is
    // the definition of a false positive.
    const cordisInstalled = installedVersion(ctx.profileDir, "@deepseek-ai/cordis");
    for (const plugin of ctx.plugins) {
        for (const [name, range] of Object.entries(plugin.hostDeps)) {
            if (satisfies(toVersion, range))
                continue;
            const minVersion = semver.minVersion(range);
            const ownMajor = minVersion ? semver.major(minVersion) : null;
            const stale = targetMajor !== null && ownMajor !== null && ownMajor < targetMajor;
            out.findings.push({
                plugin: plugin.name,
                item: 6,
                title: "依赖带入了旧版宿主包",
                level: stale ? "HIGH" : "MEDIUM",
                detail: `dependencies["${name}"] = ${range}，目标宿主为 ${toVersion}${stale ? "；该插件会自带一份旧版副本，可能与宿主实例并存" : ""}`,
                evidence: "插件 package.json 的 dependencies",
                action: stale
                    ? "建议临时禁用；或联系作者把该依赖改为 peerDependencies"
                    : "放行但观察：出现 instanceof 失效、事件收不到时优先怀疑此项",
                runtimeVerified: false,
            });
        }
        for (const [name, range] of Object.entries(plugin.cordisRanges)) {
            if (!cordisInstalled) {
                out.unknowns.push({
                    plugin: plugin.name,
                    item: 6,
                    title: `无法确定 ${name} 的安装版本`,
                    reason: "profile 的 node_modules 中找不到该包",
                    manual: "确认该包已安装；在隔离环境中观察插件是否抛错",
                });
                continue;
            }
            if (satisfies(cordisInstalled, range))
                continue;
            const wantMin = semver.minVersion(range);
            const wantMajor = wantMin ? semver.major(wantMin) : null;
            const haveMajor = semver.major(cordisInstalled);
            const majorMismatch = wantMajor !== null && wantMajor !== haveMajor;
            out.findings.push({
                plugin: plugin.name,
                item: 6,
                title: "cordis 版本区间不满足",
                level: majorMismatch ? "HIGH" : "MEDIUM",
                detail: `插件声明 ${name} = ${range}，profile 实际安装 ${cordisInstalled}${majorMismatch ? "；主版本不一致" : ""}`,
                evidence: `node_modules/${name}/package.json 的 version`,
                action: majorMismatch
                    ? "建议临时禁用：主版本不一致通常伴随 API 变更"
                    : "放行但观察：同主版本内的差异一般可容忍",
                runtimeVerified: false,
            });
        }
    }
}
/** Check item 11: declared bundle vs what is actually on disk. */
function checkPresence(ctx, out) {
    for (const plugin of ctx.plugins) {
        if (plugin.present)
            continue;
        out.findings.push({
            plugin: plugin.name,
            item: 11,
            title: "清单声明但磁盘缺失",
            level: "BLOCKER",
            detail: `dsh.profile.bundles 列出了 ${plugin.name}，但 node_modules 下没有它的 package.json`,
            evidence: `${plugin.dir}\\package.json 不存在`,
            action: "从 dsh.profile.bundles 移除该条目，或重新安装该插件",
            runtimeVerified: false,
        });
    }
}
/** Check item 10 (M0 slice): the patch file a bundle points at must exist. */
function checkBundlePatch(ctx, out) {
    for (const plugin of ctx.plugins) {
        if (!plugin.present || !plugin.bundlePatch)
            continue;
        const patchPath = join(plugin.dir, plugin.bundlePatch);
        if (existsSync(patchPath))
            continue;
        out.findings.push({
            plugin: plugin.name,
            item: 10,
            title: "声明的 patch 文件缺失",
            level: "HIGH",
            detail: `dsh.bundle.patch = ${plugin.bundlePatch}，但文件不存在`,
            evidence: `${patchPath} 不存在`,
            action: "该插件的组合树贡献会丢失（可能静默不生效）；联系作者或重装",
            runtimeVerified: false,
        });
    }
}
function collectImportedSymbols(plugin) {
    if (!plugin.entryFile || !existsSync(plugin.entryFile))
        return [];
    let source;
    try {
        const text = readFileSync(plugin.entryFile, "utf8");
        source = ts.createSourceFile(plugin.entryFile, text, ts.ScriptTarget.Latest, true, plugin.entryFile.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    }
    catch {
        return [];
    }
    const out = [];
    const visit = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const moduleName = node.moduleSpecifier.text;
            if (moduleName.startsWith("@deepseek-ai/")) {
                const symbols = [];
                const bindings = node.importClause?.namedBindings;
                if (bindings && ts.isNamedImports(bindings)) {
                    for (const el of bindings.elements)
                        symbols.push(el.name.text);
                }
                if (symbols.length > 0)
                    out.push({ module: moduleName, symbols, plugin: plugin.name });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
}
function resolveTypesEntry(moduleName, fromDir) {
    try {
        const require = createRequire(join(fromDir, "package.json"));
        const pkgPath = require.resolve(`${moduleName}/package.json`);
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const types = (typeof pkg.types === "string" && pkg.types) ||
            (typeof pkg.typings === "string" && pkg.typings) ||
            pkg.exports?.["."]?.types;
        if (!types)
            return undefined;
        const abs = join(dirname(pkgPath), types);
        return existsSync(abs) ? abs : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Check item 2 (M0 slice): imported host symbols must still exist.
 *
 * Deliberately conservative: if a type entry cannot be resolved or parsed, the item is
 * reported as UNKNOWN rather than as a missing symbol. A false BLOCKER here would block
 * updates for nothing, which is worse than missing a real one in M0.
 */
function checkApiSymbols(ctx, out) {
    const imported = [];
    for (const plugin of ctx.plugins)
        imported.push(...collectImportedSymbols(plugin));
    if (imported.length === 0)
        return;
    const dtsByModule = new Map();
    const unresolved = new Set();
    for (const entry of imported) {
        if (dtsByModule.has(entry.module) || unresolved.has(entry.module))
            continue;
        const dts = resolveTypesEntry(entry.module, ctx.profileDir);
        if (dts)
            dtsByModule.set(entry.module, dts);
        else
            unresolved.add(entry.module);
    }
    const program = ts.createProgram([...dtsByModule.values()], {
        noEmit: true,
        skipLibCheck: true,
        allowJs: false,
    });
    const checker = program.getTypeChecker();
    const exportsByModule = new Map();
    for (const [moduleName, dts] of dtsByModule) {
        const sourceFile = program.getSourceFile(dts);
        if (!sourceFile)
            continue;
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
        if (!moduleSymbol)
            continue;
        const names = new Set();
        for (const sym of checker.getExportsOfModule(moduleSymbol)) {
            names.add(sym.getName());
        }
        exportsByModule.set(moduleName, names);
    }
    for (const entry of imported) {
        const exported = exportsByModule.get(entry.module);
        if (!exported)
            continue;
        const missing = entry.symbols.filter((s) => s !== "default" && !exported.has(s));
        if (missing.length === 0)
            continue;
        out.findings.push({
            plugin: entry.plugin,
            item: 2,
            title: "引用的宿主符号在目标版本中不存在",
            level: "BLOCKER",
            detail: `${entry.module} 缺少导出：${missing.join(", ")}`,
            evidence: `目标版本类型声明 ${dtsByModule.get(entry.module)} 中无该符号`,
            action: "临时禁用；或升级到适配目标版本的插件版本",
            runtimeVerified: false,
        });
    }
    // Packages whose type entry could not be resolved are reported once, not per plugin.
    for (const moduleName of unresolved) {
        out.unknowns.push({
            plugin: "(profile)",
            item: 2,
            title: `无法解析 ${moduleName} 的类型声明`,
            reason: "该包未提供 types/typings/exports.types，或解析失败",
            manual: "在隔离环境中加载该插件，观察是否抛 TypeError",
        });
    }
}
/**
 * Check item 4 + 5: event names and listener arity.
 *
 * The host exports no runtime event registry, but cordis widens a shared `Events`
 * interface through declaration merging across its own packages. Those `.d.ts` files are
 * the truth source: a name absent there cannot be dispatched, and a listener declaring
 * MORE parameters than the host supplies is reading values that will always be undefined.
 *
 * Both directions are asymmetric on purpose: a listener declaring fewer parameters is
 * legal JavaScript and is not reported.
 */
function checkEvents(ctx, out) {
    const modulesRoot = join(ctx.profileDir, "node_modules");
    const table = buildEventTable(modulesRoot);
    if (table.unavailable) {
        out.unknowns.push({
            plugin: "(profile)",
            item: 4,
            title: "无法构建宿主事件表",
            reason: table.unavailable,
            manual: "在隔离环境中加载该插件，观察是否抛 'unknown event' 类错误",
        });
        return;
    }
    for (const plugin of ctx.plugins) {
        if (!plugin.present || plugin.name.startsWith("@deepseek-ai/dsh"))
            continue;
        if (!plugin.entryFile || !existsSync(plugin.entryFile))
            continue;
        let text;
        try {
            text = readFileSync(plugin.entryFile, "utf8");
        }
        catch {
            continue;
        }
        // A large bundled entry can be megabytes; the event references we want are cheap to
        // find but parsing is not, so skip pure-asset-looking files.
        if (text.length > 8_000_000) {
            out.unknowns.push({
                plugin: plugin.name,
                item: 4,
                title: "入口文件过大，未做事件引用扫描",
                reason: `入口 ${entryRelative(ctx, plugin)} 大小 ${text.length} 字节`,
                manual: "人工检索该插件对 ctx.on / ctx.emit 的字符串字面量调用",
            });
            continue;
        }
        for (const use of extractEventUses(plugin.entryFile, text)) {
            const declared = table.events.get(use.name);
            if (!declared) {
                // NOT a BLOCKER. Cordis validates event names only in the type layer (`Events`
                // even carries a `[key: symbol]` index signature); at runtime `on` accepts any
                // string. A name the host never dispatches therefore means "this listener never
                // fires" — a silently dead code path, not a crash. Two causes are
                // indistinguishable without a baseline of the *previous* host version: the plugin
                // may always have listened to nothing, or the event may have been removed by this
                // update. Reporting MEDIUM keeps the signal without blocking an update on it.
                out.findings.push({
                    plugin: plugin.name,
                    item: 4,
                    title: "监听了宿主未声明的事件名（该监听不会触发）",
                    level: "MEDIUM",
                    detail: `ctx.${use.via}('${use.name}') 不在宿主事件表中；cordis 运行时不校验事件名，因此不会崩溃，只会静默失效`,
                    evidence: `${entryRelative(ctx, plugin)}:${use.line}；宿主事件表来自 ${table.scanned.length} 份类型声明`,
                    action: "若该监听承载关键逻辑，更新后功能会静默缺失；核对插件是否另有事件名拼写错误",
                    runtimeVerified: false,
                });
                continue;
            }
            if (use.listenerArity !== undefined && use.listenerArity > declared.arity) {
                out.findings.push({
                    plugin: plugin.name,
                    item: 5,
                    title: "事件监听器声明的参数多于宿主提供",
                    level: "HIGH",
                    detail: `'${use.name}' 监听器声明 ${use.listenerArity} 个参数，宿主只提供 ${declared.arity} 个`,
                    evidence: `${entryRelative(ctx, plugin)}:${use.line}；事件表来源 ${declared.source}`,
                    action: "人工核对该回调是否依赖多出的参数；如是则升级或禁用该插件",
                    runtimeVerified: false,
                });
            }
        }
    }
}
function entryRelative(ctx, plugin) {
    if (!plugin.entryFile)
        return "(no entry)";
    return plugin.entryFile.startsWith(ctx.profileDir)
        ? plugin.entryFile.slice(ctx.profileDir.length + 1)
        : plugin.entryFile;
}
/**
 * Check item 7: multiple major versions of the same package.
 *
 * A profile is a hoisted real directory, so a second major resolves inside some
 * dependent's nested `node_modules`. Two majors of a host package means two module
 * instances: `instanceof` fails, shared symbols differ, and event buses stop matching.
 */
function checkDependencyTree(ctx, out) {
    const modulesRoot = join(ctx.profileDir, "node_modules");
    if (!existsSync(modulesRoot)) {
        out.unknowns.push({
            plugin: "(profile)",
            item: 7,
            title: "未找到 node_modules，无法检查依赖多版本",
            reason: modulesRoot,
            manual: "确认 profile 已完成依赖安装",
        });
        return;
    }
    const survey = surveyDependencies(modulesRoot);
    // A hoisted tree legitimately holds several majors of unrelated transitive packages
    // (semver, string-width, …). Reporting each one as a per-plugin finding buries the real
    // signal and — via the "3× MEDIUM upgrades the plugin" aggregation rule — inflates the
    // overall verdict without a single attributable risk. Only two classes earn a finding:
    // host packages (two module instances of the host break instanceof and event buses) and
    // packages a plugin in this profile actually declares.
    let unrelated = 0;
    for (const collision of survey.collisions) {
        const isHostPackage = collision.name === "@deepseek-ai/cordis" || collision.name.startsWith("@deepseek-ai/dsh");
        const declaredBy = ctx.plugins
            .filter((p) => Object.hasOwn(p.hostPeers, collision.name) || Object.hasOwn(p.hostDeps, collision.name))
            .map((p) => p.name);
        if (!isHostPackage && declaredBy.length === 0) {
            unrelated += 1;
            continue;
        }
        out.findings.push({
            plugin: declaredBy.length > 0 ? declaredBy.join(", ") : "(host)",
            item: 7,
            title: "同一包存在多个主版本",
            level: "HIGH",
            detail: `${collision.name} 解析到 ${collision.majors.length} 个主版本：${collision.majors.join(" / ")}`,
            evidence: collision.instances.map((i) => `${i.path}@${i.version}`).join("；"),
            action: isHostPackage
                ? "统一宿主包版本后再更新；否则会出现双实例， instanceof 与事件总线失效"
                : "核对依赖声明，必要时锁定单一主版本",
            runtimeVerified: false,
        });
    }
    if (unrelated > 0) {
        out.unknowns.push({
            plugin: "(profile)",
            item: 7,
            title: `${unrelated} 个与插件无关的传递依赖存在多主版本`,
            reason: "这些包未被任何插件直接声明，双实例通常只影响其自身行为",
            manual: "如出现难以解释的类型/相等性错误，再用 pnpm why <pkg> 逐个核对",
        });
    }
    if (survey.truncated) {
        out.unknowns.push({
            plugin: "(profile)",
            item: 7,
            title: "依赖树遍历超出预算，结果不完整",
            reason: `已扫描 ${survey.instances.length} 个包实例后停止`,
            manual: "用 pnpm why <pkg> 人工核对可疑包",
        });
    }
}
/** Host entry packages are always present; used to decide whether a pending signal is real. */
export function hostServicesProvided() {
    // M0 does not enumerate the service registry (no host API for it). This set only lists
    // the services the base bundle is known to provide; anything else is treated as
    // "we cannot tell", which routes a pending signal to UNKNOWN instead of HIGH.
    return new Set(HOST_ENTRY_PACKAGES.map(() => "").filter(Boolean));
}
/**
 * Run every static check.
 *
 * Async on purpose: the steps are long synchronous CPU blocks, and a synchronous
 * staticScan starves the event loop so an outer budget timer cannot fire. Yielding
 * between steps lets the caller's budget watchdog win at step granularity —
 * measured: 7 checks over 30 plugins used to run 19s with a 2s budget and return a
 * real verdict; now the budget converts to NOT_RUN at the next step boundary.
 * The worst-case lag is one step, not the whole scan.
 */
export async function staticScan(ctx) {
    const out = { findings: [], unknowns: [] };
    const steps = [
        ["presence", checkPresence],
        ["version-constraints", checkVersionConstraints],
        ["host-dependencies", checkHostDependencies],
        ["bundle-patch", checkBundlePatch],
        ["api-symbols", checkApiSymbols],
        ["events", checkEvents],
        ["dependency-tree", checkDependencyTree],
    ];
    for (const [, step] of steps) {
        step(ctx, out);
        // Hand the loop a turn so a pending budget timer can fire.
        await new Promise((resolve) => setImmediate(resolve));
    }
    return out;
}
