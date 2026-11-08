# Compat Guard

在更新 DeepSeek Harness 之前，先跑一遍「现有插件 × 新版本」的兼容性检查，把会在启动阶段崩掉的插件提前找出来。

插件作者更新不及时、宿主 API 移除、原生模块 ABI 变化、配置字段改名——这些问题的共同点是：**装上去之后才发现，宿主已经起不来了**。Compat Guard 把这一组合搬进一个一次性的隔离环境跑一遍，然后给出一份能直接照着做的报告。

## 它解决什么

| 你现在的处境 | Compat Guard 的回答 |
|---|---|
| 想更新，但怕那 30 个插件炸掉 | 哪些插件会崩、崩在哪、要不要先禁用 |
| 更新后界面白屏 | client 侧 bundle 能否加载并渲染 |
| 配置文件会不会被新版本拒绝 | 现有配置能否通过目标版本的 schema 校验 |
| 已经试了三次都失败 | 这是第几次、该处理哪个插件而不是继续重试 |

## 工作原理

宿主已经内置了「版本声明」层面的预检（按 `engines.dsh` 决定是否禁用某行）。Compat Guard 不重复这件事，只补它不做的部分——**真的把插件跑起来**：

1. **采集**：读当前安装版本、`dsh.profile.bundles`、依赖树、用户配置、`compatibility.json` 豁免记录
2. **静态扫描**：版本约束、依赖区间、API 符号差集（对照宿主自带的 `.d.ts`）、事件名、清单字段、原生模块、配置 schema
3. **隔离试加载**：复制 profile 到临时目录，用独立 `DSH_HOME` + 随机高位端口启动一次新版本宿主，捕获崩溃栈与未激活行
4. **client 侧探测**：用 Edge 打开隔离实例，检查 `pageerror` / `console.error` / 资源 404 与渲染产物
5. **聚合与报告**：按 BLOCKER / HIGH / MEDIUM / LOW 分级，产出 `report.json` + `report.md`
6. **三态退出**：`0` 放行、`1` 阻断、`2` 警告（超时也走 2，绝不挂住安装器）

隔离环境不复制真实凭据（实测隔离出的 `.credentials.yaml` 是 161 字节空模板，真实的是 15324 字节），不动真实 profile，跑完自清理。

## 安装

### 作为 DSH 插件（设置界面入口）

```bash
dsh plugin --profile desktop add "<本仓库路径>/panel" --offline
```

`--offline` 只影响 pnpm 的元数据解析，本地目录依赖不需要联网。装完后确认 `dsh.profile.bundles` 里出现了 `compat-guard-panel`（本机曾因 pnpm build 脚本警告导致 bundles 未被追加，那时插件会静默不加载）。

宿主的设置界面会热加载这个 bundle；如果没出现，重启一次 DSH。

### 作为独立命令

检查器本体是纯 Node 项目，不依赖 DSH 也能跑：

```bash
npm install
npm run build
node dist/hook.js --auto --profile "<你的 profile 目录>"
```

或者直接双击仓库根目录的 `run.cmd`。

**要求**：Node.js ≥ 24.9.0、Windows（隔离配方依赖 `ComSpec`、junction 与 `tasklist`）。

## 使用方式

### 入口一：设置左栏「兼容性预检」

设置面板左栏新增一行 **兼容性预检**（`settings.section`，id `compat-guard`，order 40）。点开就是完整面板。

### 入口二：插件详情页面板

设置 → 插件管理 → `compat-guard-panel` → 详情页中部（`plugins.bundle.config`，key 为包名）。两处入口渲染的是同一个组件，**都保留**。

### 命令行参数

| 参数 | 作用 |
|---|---|
| `--auto` | 自动发现版本对：当前版读 `dsh-app-boot/package.json`，最新版查 npm registry |
| `--from` / `--to` | 显式指定版本对；两者都给时完全离线 |
| `--postflight` | 只做组合层复检（约 1.6 秒），不 mount |
| `--no-client` | 跳过浏览器探测 |
| `--no-runtime` | 只做静态检查（约 3 秒） |
| `--fail-open` | 即使存在 BLOCKER 也只警告（退出码 2），`blockers` 仍照实输出 |
| `--backup` | 把决定「加载哪些插件」的四个文件快照到 `state/backups/<时间戳>/`，不需要版本号 |
| `--rollback [id]` | 恢复某个快照（省略 id 用最新一个）；恢复前自动再备份一次，回滚本身可撤销 |
| `--timeout` | 预算毫秒数，默认 180000；超时按 fail-open 放行 |

## 配置项

**无。** 插件不需要任何配置即可工作。

`cordis.patch.yml` 里只声明了一个可选的 `timeoutMs`（默认 240000，单次检查的硬上限），不需要改动。

## 输出内容

面板与报告里会出现：

- **结论徽章**：`PASS` / `WARN` / `BLOCK` / `UNKNOWN`，颜色区分
- **「检查兼容性」按钮**：点击后后台运行，界面显示「检查中…约需 20 秒」，不阻塞页面
- **版本对**：`0.2.2-rc.1 → 0.2.3-rc.1`（或「已是最新，无需检查」）
- **检出项**：findings 数 / unknown 数 / 实际运行期验证的 bundle 数
- **风险插件列表**：BLOCKER 级插件的 `包名#检查项` 清单
- **打开 report.md**：链接到本次检查的完整报告（含每个插件的证据与建议动作）
- 离线时额外提供**目标版本输入框**：registry 不可达时手填版本号再检查

退出码与末行 JSON 与命令行完全一致——面板只是调用了同一个 `dist/hook.js`。

## 逐项结果字段（v0.2.0 起）

报告不再只有一个 pass/fail。`report.json` 的 `outcomes` 把九个轴分别输出，互不掩盖：

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `versionConstraints` | pass / blocked / unknown | 目标版本是否拒绝某个插件的版本声明 |
| `buildScriptApproval` | not-required / declared | 插件是否声明了 `preinstall`/`install`/`postinstall`/`prepare`（宿主的批准状态在外部读不到，所以只报「声明」） |
| `nonLayerPackages` | none / present | 没有 `dsh.bundle.patch` 的包（按普通包加载，不是 patch layer） |
| `pluginLoad` | pass / fail / timeout / not-run | 隔离宿主能否启动 |
| `clientRender` | pass / fail / not-run | 界面是否真的渲染出来 |
| `configSchema` | pass / violation / unavailable / not-run | 组合配置是否被目标版本的 schema 接受 |
| `hostThrottling` | none / observed / unknown | 本次运行是否遇到限流 / 429 / 配额 |
| `defects` | none / present | 非阻断的缺陷（BLOCKER 以下） |
| `timeout` | hit + budgetMs | 本次运行自己是否耗尽预算 |

这些字段是**派生只读**的：`overall`、三态退出码、聚合规则都没变，所以既有的 `--from` / `--to` 结论完全一致。

## 备份与回滚（v0.2.0 起）

```bash
node dist/hook.js --backup                      # 快照
node dist/hook.js --rollback                    # 恢复最新一份
node dist/hook.js --rollback 2026-11-08T07-57-31-310Z   # 恢复指定一份
```

- **备份位置**：`state/backups/<ISO 时间戳>/`，内含 `package.json`、`cordis.yml`、`cordis.patch.yml`、`compatibility.json`（存在才复制），外加 `manifest.json` 记录当时的 bundle 顺序与每个插件的解析版本。
- **触发时机**：手动（也可由安装器调用）。检查流程本身不会自动写盘。
- **恢复做什么**：只重写上面那几个配置文件，然后读回并回报新的 bundle 列表。
- **不做什么**：不动 `node_modules`——回滚改的是「加载哪些」，「磁盘上装了哪个版本」由安装器决定。
- **可撤销**：每次恢复动作前自动生成 `*-pre-restore` 快照，回滚错了再回滚回来即可。

## 已知限制

- **渲染样式尚未经过目视确认。** 组件注册（`settings.section` 的 occupant `active: true`）与 host 路由（`GET /compat-guard/state` 200、`POST /compat-guard/run` 200、状态机 idle→running→done）都已实测通过，但在真实设置界面里点击后的**视觉布局**没有截图级验证——自动化脚本抓不到设置入口（它是齿轮图标，不是文字）。
- **只检测加载期问题。** 懒加载路径、特定用户数据触发、UI 交互崩溃、长时间运行后的内存泄漏，都不在覆盖范围。通过检查 ≠ 完全兼容。
- **重试循环判定不是崩溃检测。** 它判的是「同一目标版本 30 分钟内检查 ≥3 次且全部未通过」，拿不到宿主启动崩溃的直接证据。
- **白名单机制。** 会写宿主安装目录的插件（如补丁类工具）被排除在隔离试加载之外，只做静态检查；报告里会单列「未做运行期验证」的插件。
- **检查项深度不均。** 15 项检查里，钩子签名只比对参数个数（arity），不看类型与返回值。
- **Windows only。** 隔离配方依赖 Windows 的进程与链接语义。

## 目录结构

```
compat-guard/
├── src/                     检查器源码（TypeScript，14 个模块）
│   ├── hook.ts              入口：三态退出码 + 末行 JSON 契约
│   ├── check.ts             流程编排与结果聚合
│   ├── isolate.ts           隔离环境（临时 home + junction + 端口重定向）
│   ├── static-scan.ts       15 项静态检查
│   ├── config-schema.ts     用宿主自生成的 schema 校验配置
│   ├── client-probe.ts      client 侧浏览器探测
│   ├── postflight.ts        W1 复检 + W3 重试账本
│   └── …
├── dist/                    编译产物（ESM）
├── panel/                   设置界面插件
│   ├── index.js             host 半：/compat-guard/{state,run,report}
│   ├── client.js            client 半：settings.section + plugins.bundle.config
│   ├── cordis.patch.yml     组合树插入行
│   ├── locale/              中英文名称与描述
│   └── icon.svg
├── templates/
│   └── dsh-compat-guard.cmd 安装器 pre-install 调用面（Node 三级回退）
├── run.cmd                  双击即跑
└── package.json / tsconfig.json
```

## 许可证与作者

- 许可证：MIT（见 [LICENSE](LICENSE)）
- 作者：[TCHCHCHG](https://github.com/TCHCHCHG)
- 仓库地址：https://github.com/TCHCHCHG/compat-guard
