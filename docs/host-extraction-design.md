# P0 收尾设计：`createHost` 接口与三条接缝

> 状态：**已全部落地（S1 / S2 / S3 / S4 完成）** —— 三个分叉按 §7 的推荐选项落定
> （继承 / `renderNotice` 放 host / `asker` 四态 + `Host.notices` 环形缓冲要）。
> S1（notice 通道）见 §8 的三处实测修正；S2（`HarnessHost` 上移）的三处实测修正与四处**有意偏离**见 §9；
> S4（测试收口：能力归 host、兼容归 cli）见 §9.5。
> 前置：`@harness/host` 已完成三批搬迁（A 档 `loadPluginDirs` 簇 / C 档内置注册表三节 / B 档配置归一化与窗口推导），
> 外部依赖闭包**已全部就位**。本设计只处理唯一剩余项：`HarnessApp` 本体（56 个成员 ≈ 1150 行）与它那 20 处输出站点。
> 相关：`docs/external-integration-plan.md` §5 / §6 / §7。

---

## 0. 结论摘要

1. **切口**：`HarnessApp` 上移到 `@harness/host`，改名 `HarnessHost`（实现）/ `Host`（契约）；CLI 侧
   `export class HarnessApp extends HarnessHost`。CLI 专属的东西**不在类里**（见 §2），所以继承是贴着事实的形态，
   而不是为了省转发代码。
2. **三条接缝**（host 不认识终端、不认识 readline、不认识 A2A）：
   - ① `PermissionAsker`：把「怎么问到答复」抽出来，「问到之后怎么记」留在引擎里 —— **四态语义因此第一次只有一份**。
   - ② `onNotice`：装配期结构化诊断（`notice | warn | log` 三级），CLI 用自带的默认渲染器输出 ⇒ 文案逐字不变；A2A 按 `code` 上报，不渲染。
   - ③ `installConsoleCapture()`：罩住第三方（A2A SDK 抛异常时自己 `console.error` 打完整堆栈），P1 用，本次只落工具函数。
3. **现状缺陷**（顺带修）：20 处 `stdout?.write?.(...)` 在宿主不传 `stdout` 时**静默丢弃**；其中 5 条是「降级事实」
   （无 key ⇒ 悄悄换成 Mock Provider）。A2A 宿主若照抄不传 stdout，远程调用方会**拿到假回答而没有任何信号**。
   新设计让 notice 进结构化通道 + 保留环形缓冲，任何宿主都能事后回读。
4. **三个待定分叉**见 §8。

---

## 1. 调研：`HarnessApp` 的三个面

### 1.1 输入面 —— `HarnessAppOptions`（19 个字段）

| 归类 | 字段 | 新归属 |
|---|---|---|
| 工作区 | `cwd?` `dataDir?` | `HostOptions` |
| 端点 | `agentId` `provider` `model?` `providers?` `anthropicProviderConfig?` `mockProviderConfig?` | `HostOptions` |
| 会话 | `sessionId?` `autoResume?` | `HostOptions` |
| 权限 | `permissionMode?` | `HostOptions` |
| 权限（适配） | `askPrompt?` | **CLI**（`HarnessAppOptions`）—— 文本型交互是 CLI 的形态 |
| 装配开关 | `snapshot?` `allowPluginCode?` `backgroundPreload?` `agents?` `extraPlugins?` | `HostOptions` |
| 输出 | `verbose?` | `HostOptions` |
| 输出（适配） | `stdout?` | **CLI**（`HarnessAppOptions`）—— host 只认 `onNotice` |

> ⚠️ 修正计划文档 §6 的草稿：那里列的 `plugins?` / `agentDirs?` **不是 boot 的入参** ——
> `plugins` 来自 `config.json`（boot 内 `resolveBuiltinPlugins(cfg.plugins)`），`agentDirs`/`skillDirs`
> 由 `workspace` 派生出 user/project 两级。写成入参等于给出第二条口径。

### 1.2 状态面 —— boot 读写哪些实例状态

| 状态 | 读 | 写 | 说明 |
|---|---|---|---|
| `workspace` | ✅ | 构造期建 | 由 `resolveWorkspace({cwd,dataDir})` 统一解析（避免「谁先算 cwd」两处各算一遍） |
| `configStore` | ✅ | — | boot 读 `cfg.providers / plugins / compression / compaction / memory / telemetry` |
| `sessionStore` / `sessionPointer` | ✅ | — | 会话恢复与「本目录下次恢复谁」的指针 |
| `providerTypes` | ✅ | ✅ | `loadPluginDirs` 往里注册外部 Provider 类型工厂 |
| `snapshotService` | ✅ | 构造期建 | 传给 `createHarness` |
| `permission` | — | ✅ | boot 建 `CliPermissionEngine` |
| `loadedProviders` | ✅（`configuredProviders`） | ✅ | 归一化后的 Provider 实例清单 |
| `harness` | ✅（后续方法） | ✅ | `createHarness` 产物 |
| `pluginRegistry` | — | ✅ | 「可管理插件」（`/plugins enable` 靠对象引用重装） |
| `sessionRestore` | — | ✅ | explicit / auto / new 三态决策结果 |

### 1.3 输出面 —— 三类宿主各要什么

| 宿主 | 需要 | 说明 |
|---|---|---|
| CLI / REPL / TUI | 全部 56 个成员里的 ~40 个 + `formatAgo` / `describeSessionRestore` / `listReplCommands` | 现状 |
| A2A server | `boot()` 的 `{harness, session}`、`sendStream(sid, text, signal)`、权限 ask 接缝、`shutdown()` | 其余方法按需（`/model` 等命令若要暴露成 A2A 方法再说） |
| VSCode sidecar | 同 A2A | 传输层不同 |

### 1.4 关键发现：CLI 专属的代码**不在类里**

逐条过完 56 个成员后，**没有任何一个成员是 CLI 专有的**：

| 成员 | 是否 CLI 专属 | 判断 |
|---|---|---|
| `send` / `sendStream` / `flushDirtySessions` / `shutdown` / `loadFullHistory` | ❌ | 会话输入输出的宿主级原语，A2A 直接要用 |
| `getModel` / `resolveSessionModel` / `resolveSessionEndpoint` / `setModel` / `setSessionModel` / `sessionModelOverride` / `resolveChatProvider` / `configuredProviders` / `listProviders` / `listConfiguredProviders` / `tokenOnlyDuplicateGroups` | ❌ | 端点解析与展示口径，**多宿主必须同一份**（否则又是「显示 26% 实际已 103%」那类静默故障） |
| `setAgentTools` / `getMcpServers` / `setMcpServers` / `setPermissionRules` / `applyConfigAgentOverrides` / `applyMcpServers` | ❌ | config.json 读写，A2A 的 `setAgentTools` 类方法同样要落盘 |
| `skillInfos` / `enableSkill` / `disableSkill` / `reloadSkill` | ❌ | 技能管理 |
| `restoreSession` / `findResumeTarget` / `rememberSession` / `pickResumeCandidate` | ❌ | 会话恢复策略 |
| `defaultAgent()` / `applyModel` / `buildProviderPlugin` / `scheduleBuiltinPreload` / `emitLog` / `setLogSink` | ❌ | 装配与日志出口 |
| `_harness` getter | ❌ | 兼容访问器 |

真正 CLI 专属的只有三处**类外**代码：

1. `defaultCliAsk(write)` —— `readline`（`packages/cli/src/index.ts:1758`）
2. `CliPermissionEngine.ask` 里的文本渲染与 `⚠️ 权限请求 [bash] …[a/d/A/D]` 话术（`1724`）
3. REPL/TUI 命令实现（`createProcessLine` / `startRepl` / `tui.tsx`）与展示助手 `formatAgo` / `describeSessionRestore` / `listReplCommands`

⇒ **共享的是绝大多数，不共享的是少数**。这是选「继承」而不是「委托」的实测依据：委托形态要为 ~40 个方法写转发，
且 `emitLog` 这种「测试用 `as any` 摸 private」的形态会在转发层失真（`cli.test.ts:3194` 就是这么用的）。

---

## 2. 接口设计

### 2.1 `HostOptions`（host 侧，19 个原字段 − 2 个 CLI 专属 + 1 个新接缝）

```ts
export interface HostOptions {
  // ── 工作区（resolveWorkspace 统一解析；两处各算一遍是本仓老病） ──
  cwd?: string
  dataDir?: string

  // ── 默认端点 ──
  agentId: string
  provider: string
  model?: string
  /** 高于 config.json → providers（CLI --provider/--model 的落点） */
  providers?: ProviderConfig[]
  anthropicProviderConfig?: unknown
  mockProviderConfig?: MockProviderConfig

  // ── 会话 ──
  sessionId?: string
  autoResume?: boolean

  // ── 权限 ──
  permissionMode?: 'allow-all' | 'ask' | 'deny-all'
  /** 询问接缝（§2.4）。缺省 = DefaultPermissionEngine 的 ask→deny 语义 */
  asker?: PermissionAsker

  // ── 装配开关 ──
  snapshot?: boolean
  allowPluginCode?: boolean
  backgroundPreload?: boolean
  agents?: AgentDefinition[]
  extraPlugins?: AgentPlugin[]

  // ── 输出 ──
  verbose?: boolean
  /** 装配期结构化诊断出口（§2.5）。缺省只进环形缓冲，不写任何流 */
  onNotice?: (n: HostNotice) => void
}
```

### 2.2 `Host`（契约）与 `HarnessHost`（实现）

```ts
export interface Host {
  // 装配产物（boot 的返回，平铺到实例上）
  readonly harness: Harness
  readonly session: Session

  // 工作区与存储
  readonly workspace: Workspace
  readonly sessionStore: SessionFileStore
  readonly sessionPointer: SessionPointerStore
  readonly permissionStorePath: string
  readonly configStore: ConfigStore<HarnessConfig>
  readonly providerTypes: ProviderTypeRegistry
  readonly permission: PermissionEngine
  readonly snapshotService: SnapshotService | undefined
  readonly pluginRegistry: ReadonlyMap<string, AgentPlugin>
  readonly sessionRestore: SessionRestoreInfo

  // 装配期事实的回读出口（新增，见 §2.5）
  readonly notices: readonly HostNotice[]

  // 会话
  send(sessionId: string, text: string): Promise<Message>
  sendStream(sessionId: string, text: string, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent, void, unknown>
  restoreSession(saved: SessionFile): Promise<Session>
  findResumeTarget(): Promise<ResumeTarget | undefined>
  rememberSession(session: Session): Promise<void>
  flushDirtySessions(): Promise<void>
  loadFullHistory(sessionId: string, range?: HistoryLoadRange): Promise<Message[]>
  shutdown(): Promise<void>

  // 端点解析与切换（多宿主必须同一份口径）
  getModel(agentId: string): string | undefined
  resolveSessionModel(session: Pick<Session, 'agentId' | 'meta'> | undefined): string | undefined
  resolveSessionEndpoint(session: Pick<Session, 'agentId' | 'meta'> | undefined): SessionEndpoint
  sessionModelOverride(session: Pick<Session, 'meta'> | undefined): SessionModelOverride | undefined
  setSessionModel(session: Session, override: SessionModelOverride | undefined): Promise<Session>
  setModel(agentId: string, spec: string): Promise<boolean>
  resolveChatProvider(providerId?: string): ChatProvider | undefined
  configuredProviders(): ResolvedProviderConfig[]
  listProviders(): string[]
  listConfiguredProviders(): Array<{ id: string; type?: string; model?: string; isDefault: boolean }>
  tokenOnlyDuplicateGroups(): ReturnType<typeof findTokenOnlyDuplicates>

  // config.json 写入
  setAgentTools(agentId: string, tools: string[]): Promise<void>
  getMcpServers(): Promise<McpServerEntry[]>
  setMcpServers(list: McpServerEntry[]): Promise<void>
  setPermissionRules(rules: Record<string, unknown>): Promise<void>

  // 技能
  skillInfos(): Array<{ id: string; name: string; source: string; sourceLabel: string; enabled: boolean }>
  enableSkill(id: string): Promise<{ ok: boolean; message: string }>
  disableSkill(id: string): Promise<{ ok: boolean; message: string }>
  reloadSkill(id: string): Promise<{ ok: boolean; message: string }>

  // 装配
  boot(): Promise<{ harness: Harness; session: Session }>
}

/** 装配 + 启动，一步到位（A2A / VSCode 的入口；CLI 保留 new + boot 两步以兼容既有调用点） */
export async function createHost(options: HostOptions): Promise<Host> {
  const host = new HarnessHost(options)
  await host.boot()
  return host
}
```

**为什么 `boot()` 仍返回 `{harness, session}` 而不是改成 void**：`main()` 与 30+ 处测试都是
`const { harness, session } = await app.boot()`。平铺属性（`host.harness`）**另外**提供，两者并存 ——
这是零翻修成本的兼容形态，不是重复口径（同一个实例的两个访问路径）。

### 2.3 boot 的时序不变，变的是出口

14 个步骤的顺序、判据、抛错点**一个都不动**（Hooks 顺序敏感：`applyConfigAgentOverrides` 必须在
`createHarness` 之后、`start` 之前；`applyMcpServers` 必须在 `start` 之前）。唯一变化是 20 处
`this.options.stdout?.write?.(...)` → `this.emitNotice({ level, code, data })`。

### 2.4 接缝 ①：`PermissionAsker`（四态，语义只一份）

```ts
/** 规范答复四态。「always-*」会写回规则集并置 remember=true */
export type PermissionAnswer = 'allow' | 'deny' | 'always-allow' | 'always-deny'

/** 宿主无关的提问材料：结构 + 一段默认文案（CLI 用 text，远程宿主用 summary 落 metadata） */
export interface PermissionPrompt {
  toolKey: string
  patterns: string[]
  summary: string   // '权限请求 [bash] rm -rf /tmp/x'
  text: string      // 默认渲染的完整问题（含'操作: allow / deny / …'）
}

export type PermissionAsker = (
  req: PermissionRequest,
  prompt: PermissionPrompt,
) => Promise<PermissionAnswer | undefined>   // undefined = 取不到答复 ⇒ 按 deny（与现有 readline 兜底一致）
```

```ts
/** 四态语义 + mode 短路 + 规则写回都在这里 —— 三个宿主共用同一份 */
export class InteractivePermissionEngine extends DefaultPermissionEngine {
  constructor(rules: PermissionRuleset, opts: {
    mode?: 'allow-all' | 'ask' | 'deny-all'
    asker?: PermissionAsker
    store?: PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }
  })
  getMode(): 'allow-all' | 'ask' | 'deny-all'
  setMode(mode: 'allow-all' | 'ask' | 'deny-all'): void
  override async ask(req: PermissionRequest): Promise<PermissionDecision>
}
```

CLI 侧只留适配器，**导出面与今天逐字相同**：

```ts
// @harness/cli
export class CliPermissionEngine extends InteractivePermissionEngine {
  constructor(rules, opts: { store?; mode?; askPrompt?: (q: string) => Promise<string>; stdout? })
  getMode() / setMode()                 // 继承
  setAskPrompt(fn?): void               // TUI 模态替换（保留）
  override async ask(req) { /* 组装 asker：TUI 模态 或 readline；其余走 super */ }
}
```

| 宿主 | asker 实现 |
|---|---|
| CLI/REPL | `defaultCliAsk`：渲染 `prompt.text` → readline → 把文本解析成四态 |
| CLI/TUI | `setAskPrompt` 注入模态；返回同样四态 |
| A2A | 任务转 `TASK_STATE_INPUT_REQUIRED`、挂起 resolver；答复到达时 resolve 成四态（§3.4 模式 A） |
| VSCode | webview 授权卡 |

**收益**：今天「先判永久（`A`/`always`）→ 写回规则 → 再判单次」这套顺序只写在 `CliPermissionEngine` 里，
A2A 若另起一份实现就是**同一语义两套写法**——将来「always 到底该写 `tool` 还是 `global` 规则」改一处漏一处。
上移后只有一份。

### 2.5 接缝 ②：`onNotice` —— 装配期三级诊断

```ts
export type NoticeLevel = 'notice' | 'warn' | 'log'

export interface HostNotice {
  level: NoticeLevel
  /** 稳定机器码：CLI 用它选渲染模板，A2A 用它决定是否进任务 metadata */
  code: NoticeCode
  /** 结构化字段：渲染与上报都从这里取值，不在 host 里拼字符串 */
  data?: Record<string, unknown>
}
```

> S1 落地时改了两处（理由见 §8 ①）：`level` **不再由调用点填**，而是由 `NOTICE_LEVEL[code]` 表驱动
> 经 `makeNotice()` 盖上；`data` 由 `Record<string, unknown>` 收紧为按 `code` 的判别联合
> （`NoticePayloads`），漏登记新 code = 编译期报错。

**20 处输出站点逐条分级**（`code` 与文案模板 1:1，便于逐字复刻与 grep）：

| # | 行 | 现状文案（截断） | level | code | data |
|---|---|---|---|---|---|
| 1 | 2336 | 已跳过 N 个插件代码文件（默认不加载…） | `notice` | `plugins.code-skipped` | `{ count, files, hint }` |
| 2 | 2336 | 插件加载失败 `<path>`：`<msg>` | `notice` | `plugins.load-failed` | `{ file, message, bareDep? }` |
| 3 | 2357 | 配置错误（config.json → providers）：…（**随后 throw**） | `notice` | `config.providers-invalid` | `{ issues: string[] }` |
| 4 | 2398 | ⚠️ 未能构造默认 Provider "x"（未知 type） | `notice` | `provider.construct-failed` | `{ providerId }` |
| 5 | 2421 | 配置错误：`<msg>`（**随后 throw**） | `notice` | `config.secret-unresolved` | `{ message }` |
| 6 | 2435 | ℹ️ 未在 config.json → providers 中找到默认 Provider "x"，自动 fallback 到 Mock | `notice` | `provider.fallback-mock` | `{ requested, actual: 'mock', reason: 'not-configured' }` |
| 7 | 2446 | ℹ️ 未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock Provider | `notice` | `provider.fallback-mock` | `{ requested: 'anthropic', actual: 'mock', reason: 'no-key' }` |
| 8 | 2463 | ✅ 默认 Provider: x（type=… · model=…） | `notice` | `provider.default-chosen` | `{ configured, actual, type?, model?, mismatch? }` |
| 9 | 2486 | [WARN] config.json → plugins 有未生效项：… | `warn` | `config.plugins-inactive` | `{ unknown: string[], available: string[] }` |
| 10 | 2499 | [WARN] config.json → compression 有以下未生效项 | `warn` | `config.compression-inactive` | `{ items: string[] }` |
| 11 | 2511 | [WARN] config.json → compaction 有以下问题 | `warn` | `config.compaction-inactive` | `{ items: string[] }` |
| 12 | 2569 | [WARN] 写了 memory 段，但没有启用记忆 | `warn` | `config.memory-not-enabled` | `{}` |
| 13 | 2575 | [WARN] config.json → memory 有以下问题 | `warn` | `config.memory-inactive` | `{ items: string[] }` |
| 14 | 2593 | [WARN] config.json → telemetry 有以下问题 | `warn` | `config.telemetry-inactive` | `{ items: string[] }` |
| 15 | 2643 | [INFO] …（仅 verbose） | `log` | `log.info` | `{ message, meta? }` |
| 16 | 2648 | [DEBUG] …（仅 verbose） | `log` | `log.debug` | `{ message, meta? }` |
| 17 | 2659 | [WARN] 默认 Provider "x" 未注册为实例 | `warn` | `provider.default-not-registered` | `{ providerId }` |
| 18 | 2987 | [WARN] 内置插件「x」后台预加载失败 | `warn` | `preload.plugin-failed` | `{ pluginId, message }` |
| 19 | 2991 | [INFO] 内置插件「x」已后台预热（仅 verbose） | `log` | `preload.warmed` | `{ pluginId }` |
| 20 | 2998 / 3004 | [WARN] 内置插件安装失败 / 工具池预热失败 | `warn` | `preload.install-failed` / `preload.tools-failed` | `{ message }` |

> 行 2987–3004 属 `scheduleBuiltinPreload`（boot 末尾的 fire-and-forget），一并纳入 ——
> **装配期**（boot + 后台预加载）是一个整体，只分级的 boot 会让「预热失败」成为漏网之鱼。

**分级的硬判据**（不是审美）：

- `notice` = **用户必须知道的事实**，尤其是「配置意图与实际装配不一致」类（#6 #7 #8 #4）。A2A 必须把这类
  挂进任务 metadata / 启动自检输出 —— 否则远程调用方拿到的是一个 Mock 的回答，而**没有任何信号**说明它是假的。
- `warn` = 配置写了但没生效（#9–#14 #17 #18 #20）。丢一条不影响正确性，但静默失效是本仓的老病。
- `log` = verbose 才要的（#15 #16 #19）。今天的 verbose 门控保持原样：**门控在 host 侧**
  （verbose 为假时根本不 emit），CLI 渲染器不再判断 verbose。

**默认渲染器放在 host 且导出**：

```ts
/** 纯函数：HostNotice → 今天那段逐字相同的文本（含结尾换行） */
export function renderNotice(n: HostNotice): string
```

> S1 落地时取消了"按 verbose 返回空串"这一条：**门控在 host 侧**（verbose 为假时根本不 emit），
> 渲染器因此是纯全函数 —— 21 个 code 都能出文案，快照测试不必为 log 级造两种期望。

选它放 host 的三条理由：
1. CLI 直接用 ⇒ **文案逐字不变**：`cli.test.ts` 的 boot「有未登记 id 时只告警」与「后台静默预加载」
   （verbose ⇒ `已后台预热`）两条用例无需改动；
2. 纯函数 ⇒ 20 条可逐条快照测试，**不再依赖「跑一次 boot 抄 stdout」**；
3. A2A/VSCode 可以不用它（按 `code` 上报），也可以用它（写服务日志）——是**默认**不是**唯一**。

**`onNotice` 与既有 `setLogSink` 的关系：两条通道，不合并**。

| | `onNotice`（新） | `setLogSink`（已存在，`cli.test.ts` 的「HarnessApp 日志 sink」describe 已测） |
|---|---|---|
| 时机 | 装配期一次性（boot + 后台预加载） | 运行期每轮 query |
| 内容 | 事实 + 告警 + verbose 日志（结构化 `code`） | 引擎 warn/error（自由文本 msg + meta） |
| 消费方 | CLI 启动横幅 / A2A 任务 metadata / 启动自检 | TUI console 块（避免混进渲染流） |
| 挂载 | 构造期 option（boot 之前就生效） | 运行期 `setLogSink()`（TUI 启动后挂） |

合并两条要改一个已被测试钉住的契约，收益只是「少一个名词」—— 不值。

**环形缓冲**：`Host.notices` 保留本次装配发出的全部 notice（≤ 数十条）。
它解决的是现状缺陷：今天不传 `stdout` ⇒ 20 条**静默丢弃**，事后无从追查。A2A 启动自检可以直接读它。

### 2.6 接缝 ③：`installConsoleCapture()`（P0 只落工具，P1 接）

P0.5 实测：`DefaultRequestHandler` 在 executor 抛异常时**自己 `console.error` 打完整堆栈**。
宿主日志出口必须罩得住它，但**对外响应只给结构化 code + message，不泄露堆栈**。

```ts
/** 临时接管 console.warn/error（第三方 SDK 用）；返回卸载函数 */
export function installConsoleCapture(handler: (level: 'warn' | 'error', args: unknown[]) => void): () => void
```

P0 只把它落成 host 的导出工具 + 单测；P1 里 A2A server 在 boot 前装上、shutdown 时卸载。

### 2.7 CLI 侧：`HarnessApp` 与三个适配器

```ts
// @harness/cli
export interface HarnessAppOptions extends HostOptions {
  /** CLI 专属：直写流（host 侧只认 onNotice） */
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  /** CLI 专属：文本型询问（内部转成 asker） */
  askPrompt?: (q: string) => Promise<string>
}

export class HarnessApp extends HarnessHost {
  constructor(options: HarnessAppOptions) {
    // 装配默认适配器：askPrompt/readline → asker；stdout + renderNotice → onNotice
    super({ ...options, asker: ..., onNotice: (n) => options.stdout?.write?.(renderNotice(n)) })
  }
  // 不再覆写任何宿主级方法 —— 继承即导出面
}
```

CLI 保留（不动）：`CliPermissionEngine`、`defaultCliAsk`、`formatAgo`、`describeSessionRestore`、
`listReplCommands`、`createProcessLine`、`startRepl`、`startTuiRepl` / `tui.tsx`、`resolveTodayUsage`、
`runTeammateCli`、`main()`。

---

## 3. 依赖与登记

`packages/host/package.json` 需新增（按 AGENTS.md §1 登记四件事）：

| 包 | 用途 |
|---|---|
| `@harness/core` | `createHarness` / `Harness` / `DefaultPermissionEngine` / `PermissionRequest` |
| `@harness/workspace` | 已有（`ConfigStore` / `SessionFileStore` / `SessionPointerStore` / `resolveWorkspace` / `SecretCipher` / `resolveSecret` / `createWorkspaceOriginalStore` / `ConfigValidationError`） |
| `@harness/snapshot` | `createSnapshotService` |
| `@harness/workspace-shell` | `createWorkspacePlugin` |
| `@harness/revert` | `createRevertPlugin` / `createSnapshotPlugin` |
| `@harness/mcp-server-registry` | `McpServerEntry`（仅类型） |
| `@harness/session` | `Session` / `Message` / `reconstructHistory` … |
| `@harness/skill` | `formatSkillSource`（`skillInfos` 用） |
| `@harness/provider-mock` | `MockProviderConfig`（仅类型） |

另外需一并上移的**非代码资源**：`packages/cli/src/prompts/default-agent.txt`（`defaultAgent()` 的 systemPrompt，
今天靠 `import defaultAgentPrompt from './prompts/default-agent.txt'` 加载；Bun 的文本 import 在 host 包同样可用）。

`@harness/cli` 反过来从 `@harness/host` import `HarnessHost`，并**继续 re-export** 既有导出面
（`cli.test.ts` / `provider-model.test.ts` 直接 import `HarnessApp`、`CliPermissionEngine` 及各装配符号）。

---

## 4. 落地步骤（实际拆成 7 个可独立验证的 commit）

设计稿原排 S1→S2→S3→S4；实施时把 S3（权限接缝）**前插到 S2 之前**，因为 `boot()` 直接构造
`CliPermissionEngine`，而 host 不能再反向 import cli —— 不先上移权限引擎，主体就搬不动。
于是实际序列为 S1 → S2-① → S2-②（= 原 S3）→ S2-③（前置 + 主体）→ S2-③补 → S4。

| 步 | 内容 | 独立性 / 验证 |
|---|---|---|
| **S1** ✅ | `packages/host/src/notice.ts`：`HostNotice` / `NoticeCode` / `renderNotice` + 25 条用例 | **纯新增、不接线** ⇒ 其余测试逐条不变。host 71 pass、全量 2197 pass、typecheck 40 包 exit 0。三处实测修正见 §8 |
| **S2-①** ✅ | 配置层上移（`./config.ts`）：`HarnessConfig` / 模型解析 / Provider 校验 / 各段检查 / ACP 档位翻译 / 配置概览 | boot 直接依赖它。`4197a3b`，全量 2197 pass |
| **S2-②** ✅ | 权限接缝上移（`./permission.ts`）：`InteractivePermissionEngine` + `PermissionAsker` 四态；`CliPermissionEngine` 退化为 asker 适配器 | 权限用例（`cli.test.ts` 权限段）**逐字通过** = 语义没动。`3e8c4f5`，全量 2210 pass |
| **S2-③ 前置** ✅ | `./plugins.ts`：A 档 + C 档自 `index.ts` 抽出，`index.ts` 退化为纯 barrel | 主体要用这几个装配原语，留在 index 就成环（叶子不得反向 import barrel）。纯搬移，全量 2210 pass 逐条不变。`bbb366d` |
| **S2-③ 主体** ✅ | `./host.ts`：`HarnessHost` + `HostOptions` + `createHost()`；21 处 `stdout?.write?.(…)` → `emitNotice`；CLI 变 `HarnessApp extends HarnessHost` | 最大的一步。**2215 pass**（基线 2210 + host notice 端到端 5 条）。三处实测修正 + 四处有意偏离见 §9。`b13f81a` |
| **S2-③ 补** ✅ | `preloadBuiltinToolMetas` 的 `console.warn` 漏网站点纳入 notice（+1 code） | §8 ② 要求 S2 一并处理。`6dc4e69` |
| **S4** ✅ | 收口 host / cli 之间有意重叠的测试（能力归 host、兼容归 cli）；更新 `AGENTS.md` 与计划文档 | 见 §9.5。**2194 pass**（host 99 / cli 398）。反向验证 6/7 已执行 |

S1 先做的意义：把「文案」从「会不会被 boot 的其它改动顺带改掉」里摘出来 —— 20 条文案一旦有独立快照，
S2 的重构就有了**逐字不变**的判据，而不是靠读 diff 目测。

---

## 5. 验收口径

| 项 | 判据 |
|---|---|
| `bun run typecheck` | 40 包 exit 0 |
| `bun test ./packages` | 现有用例逐条不变 + 新增 host 用例（S4 收口后基线：**2194 pass / 0 fail / 95 文件**） |
| `cli.test.ts` | **逐字通过**，含三条被钉住的契约：boot「有未登记 id 时只告警」（plugins 未生效项文案）、boot「后台静默预加载」（verbose 预热日志）、「HarnessApp 日志 sink」（`setLogSink` 路由 warn/error） |
| `packages/cli` | 随迁移更新的用例逐条通过（S4 收口后 **398 pass**：删掉与 host 重复的行为用例、加一条 re-export 兼容断言）；`packages/host` **99 pass** |
| 行为不变 | cli / tui / headless 三种启动路径输出与今天一致 |

**反向验证**（证明分级不是装饰）：

1. 把 `provider.fallback-mock` 的 level 由 `notice` 降成 `log` ⇒ **必须有测试失败**。✅ **已执行**：
   2 条失败 —— `"配置意图 ≠ 实际装配"与降级事实必须是 notice 级` 与 `makeNotice 从表里盖等级`。
   后者尤其关键：等级是 `NOTICE_LEVEL` 表**盖上去**的（见 §8 修正 ①），所以降级是改一处表，
   而不是改 20 个调用点里的一处 —— 本仓"改一处漏一处"的老病在这里被结构性消掉。
2. 把 `plugins.code-skipped` 的文案改一个字 ⇒ S1 快照必须失败。✅ **已执行**：2 条失败 ——
   纯快照用例 **和** `与真实 loadPluginDirs 的捕获字节对齐` 那条。后者证明快照绑的是**实现现实**
   （真的跑一遍 `loadPluginDirs` 再比字节），不是"自己和自己比"。
3. 把 `asker` 换成永远返回 `undefined` ⇒ `always-allow` 的规则写回必须不发生（`remember` 不置位）。
   ✅ **已执行**（S2-②）：`permission.test.ts` 13 条含这条，`cli.test.ts` 权限段 8 条逐字通过。
4. **S2-③ 追加**：把 CLI 侧的两条输出出口（`onNotice` 与 `logLine`）**同时摘掉** ⇒ 钉住文案的用例
   必须失败。✅ **已执行**：`boot：config.json → plugins 有未登记 id 时只告警` 报
   `Received: ""` —— 证明 20 处输出**确实走在这条通道上**；只摘 `onNotice` 时仍通过，说明
   `logLine` 兜底**同字节**（这正是"两条出口不是两份事实"的可执行证据）。
5. **S2-③ 追加**：不给任何输出出口 ⇒ 文本丢失，但 `app.notices` 里仍能按 `code` 取回。
   ✅ 已固化为 `notices.test.ts` 的常驻用例（治「静默丢弃」的正面断言）。
6. **S4 追加**（证明收口后的用例不是装饰）：把 `resolveCompactionWindow` 的端点查表摘掉
   （恒回 `fallback`）⇒ 刚移入 host 的用例必须失败。✅ **已执行**：2 条失败
   （`resolveCompactionWindow` 与 `buildCompactionOptions` 各一条）。
7. **S4 追加**（证明 re-export 兼容断言有效）：从 `cli/src/index.ts` 摘掉任一条 re-export
   ⇒ 断言/模块加载必须失败。✅ **已执行**：摘掉 `resolveBuiltinPlugins` ⇒ 模块加载即
   `SyntaxError: Export named 'resolveBuiltinPlugins' not found`。

> 现状（S1 时的记录）：20 处输出里**只有 1 条**被测试钉住（`:1939`，S4 后迁到 `:1597`）。其余 19 条
> 当时既没有断言、也没进任何结构化通道 ——
> 「配置写了没生效」这类问题因此只以「终端上的一行」形式存在，跑 headless / A2A 时全部消失。

---

## 6. 与相邻机制的分工

| 机制 | 边界 |
|---|---|
| `step_gate` / 回合结束闸门 | 运行期等待语义，与本次无关 |
| `setLogSink` | 运行期引擎告警（上表），本次**不动** |
| `installConsoleCapture` | 第三方 SDK 的 console，P1 接 |
| `RemotePermissionEngine`（计划 §7.1） | 本次只落 `PermissionAsker` 接缝；A2A 的挂起/唤醒在 P1 —— **别在 P0 预支 P1 的挂起表** |

---

## 7. 三个待定分叉 —— 已按选项 A 定案

| # | 分叉 | 定案 | 落地位置 |
|---|---|---|---|
| 1 | **形态** | ✅ **`HarnessApp extends HarnessHost`**（继承；实测 56 个成员 0 个 CLI 专属，继承贴着事实） | S2-③ |
| 2 | **文案归属** | ✅ **`renderNotice` 放 host 并导出**（逐字复刻；A2A 可选择不用） | S1 |
| 3 | **ask 接缝粒度** | ✅ **`asker(req, prompt) → 四态`**（远程宿主直接给四态，不做文本往返） | S2-② |

小项：✅ **`Host.notices` 环形缓冲要** —— 它是「不传 `stdout` 就静默丢失」这个缺陷的正面解法。

---

## 8. S1 落地实测修正（设计稿的三处偏差）

### ① `level` 只有一份：从"调用点填"改为"表里盖"

设计稿让每个 `HostNotice` 自带 `level`，由调用点填。那等于把"这条算不算必须知道的事实"复制到
20 个调用点 —— 正是本仓"同一个东西两套写法"的老病。**改为 `NOTICE_LEVEL: Record<NoticeCode, NoticeLevel>`
是唯一来源，`makeNotice()` 从表里盖。** 收益可测：降级必须是改表（见 §5 反向验证 1），
调用点在类型上无从填错。

### ② 站点数是 21 个 code，不是 20 个

原表把 `2336` 行记成"一个站点"，实际那是 `loadPluginDirs` 的 `log` 回调，**背后有三条不同消息**：
代码注入闸门块 / 单模块加载失败 / 模块既无通用插件也无 Provider 工厂。前两条又各自是
**多次 `write` 的扇出**（闸门块 5–7 次、加载失败 1–2 次），所以模板按**整块字节**复刻。

还有一条**漏网站点**：`preloadBuiltinToolMetas` 用 `console.warn` 直写
（不走 `stdout`、也不走 `setLogSink`），是本轮唯一"两个出口都不沾"的装配期诊断。S1 未纳入
（它属于 console 通道，与 `installConsoleCapture` 同侧）；**S2 要一并处理**，否则"元信息来源预载失败"
在 A2A 宿主下同样无声。
⇒ ✅ **S2-③ 补已完成**（`6dc4e69`）：新增 code `preload.meta-source-failed`（`warn` 级），
`preloadBuiltinToolMetas(onNotice?)` 与 `loadPluginDirs` 同形的双出口。注意模板要**显式带结尾换行**
—— 改造前那个 `\n` 是 `console.warn` 代劳的，sink 出口没有人代劳。于是 code 总数 **22**。

### ③ 外部插件目录那三条字节是**双换行**，这是要保留的

`loadPluginDirs` 的 `out()` 参数自带结尾 `\n`，而 CLI 传的回调是 `(s) => stdout?.write?.(s + '\n')`
⇒ 每个 `out` 落成 `…\n\n`。`renderNotice` **据此复刻**：S2 才能做到零 diff。想改掉那对空行是
另一次**有意识**的改动（涉及 `out` 的扇出形态），不该混在搬迁里。

### ④ 顺带修掉上一轮遗留的一处 typecheck 缺口

上一轮 B 档的验收口径写了"typecheck 40 包 exit 0"，但那是在 `config-window.test.ts` **写出来之前**
跑的 —— 该文件里 4 处 `t.byProvider[...]` / `t.byModel[...]` 一直没过类型检查（`ProviderWindowTable`
的两个字段在插件侧是**可选**的）。本轮补类型时暴露并修掉：`buildProviderWindowTable` 的返回类型
收紧为 `ProviderWindowTableView`（`byProvider` / `byModel` / `fallback` 恒存在）—— 装配方的**产出**
不该说"可能没有"，否则每个消费方都要写一次 `?.` / `!`。

> 教训：验收口径要跑在**最后一个改动之后**。测试文件也是产物，写完必须再过一次 typecheck。

---

## 9. S2 落地实测修正（三处）与有意偏离（四处）

### 9.1 三处实测修正（设计稿没算到的）

#### ① 主体搬不动，除非先把 A/C 档从 `index.ts` 摘出去

设计稿把这次改造写成"S2 一步"。实测：`host.ts` 需要 `loadPluginDirs` / `getBuiltinRegistry` /
`preloadBuiltinToolMetas` / `registerBuiltinProviderTypes` / `resolveBuiltinPlugins` —— 它们当时都
定义在 `index.ts`。`host.ts` 若从 `./index` 取，就形成 `host.ts → index.ts → host.ts` 的环，
而本仓已明确回避该形态（`./lazy.ts` 就是为此拆的）。⇒ 先做一步**纯搬移**把 A 档 + C 档抽成
`./plugins.ts`（`bbb366d`），`index.ts` 退化为纯 barrel（688 → 125 行）。
这一步是零行为变化的，单独验证成本极低 —— 属于"先拆环、再搬家"。

#### ② 权限引擎是**构造期**依赖，不是运行期依赖 ⇒ 原 S3 必须前插

设计稿把权限接缝排在主体之后。实测：`boot()` 里就 `new CliPermissionEngine(...)`，主体不先拿到
一个宿主无关的引擎就搬不走。⇒ 权限接缝（原 S3）实际是 **S2-②**，排在主体之前。

#### ③ TUI 的 `setAskPrompt` 逼出一个**有意的覆写点**

主体上移后，`app.permission` 若直接是 `InteractivePermissionEngine`，`tui.tsx:1515` 的
`setAskPrompt(...)` 就没有了（`cli.test.ts` 也依赖 `CliPermissionEngine` 这个导出）。
两条路：改 TUI 用 `setAsker(cliAsker(...))`（动 2 处 + 导出内部函数），或给 host 一个覆写点。
选了后者 —— `protected createPermissionEngine(rules, save, mode)`，CLI 覆写成返回
`CliPermissionEngine`，并用 `declare public permission: CliPermissionEngine` 窄化字段类型。
**收益**：`tui.tsx` / `cli.test.ts` / `CliPermissionEngine` 全部逐字未改，且四态语义依然只有一份
（CLI 覆写的只是"用什么问"，不是"问到之后怎么记"）。

### 9.2 四处**有意偏离**设计稿（每一处都要留痕）

| # | 设计稿 | 实际 | 理由 |
|---|---|---|---|
| ① | `export interface Host { …（56 个成员） }` + `class HarnessHost implements Host` | `export type Host = HarnessHost` | 另立 interface 就是把同一份 56 个成员写两遍（名称、签名、只读性各维护一次）——**这种重复的漂移是静默的**（interface 不会因为 class 改了而报错）。`type` 别名让两者定义上同一。设计稿自己反对"同一个东西两套写法"，这一条同理 |
| ② | `HostOptions` 19 个原字段 − 2 个 CLI 专属 + `onNotice` | 再多一个 `logLine?: (line: string) => void` | 设计稿只列了**装配期**的 `onNotice`，漏了**运行期** `emitLog` 的兜底出口。host 不再有 `stdout`，不补这个字段则运行期引擎 warn/error 在 headless 下无处可去。它与 `onNotice` 仍是**两条通道**（时机/内容/消费方都不同），不是合并 |
| ③ | `anthropicProviderConfig?: unknown` | `anthropicProviderConfig?: any` | `unknown` 会把 `this.options.anthropicProviderConfig?.apiKey` 与 `...spread` 逼出四处无谓 cast，收益为零。**保留原类型**，不为了"更严"制造噪音 |
| ④ | CLI 侧 `super({ ...options, asker: ..., onNotice: (n) => options.stdout?.write?.(renderNotice(n)) })` | 多两样：`stdout` 缺省落 `process.stdout`；多一个 `createPermissionEngine` 覆写 | `stdout ?? process.stdout` 是**搬迁前**的既有语义（`main()` 不传 stdout），不补就会让真 CLI 的装配诊断全部消失 —— 这是"零行为变化"判据要求的。覆写点见 9.1 ③ |

### 9.3 一处守卫改址（**不是**改断言）

`cli.test.ts` 有一条读**源码文本**的防回归守卫：守 `acp.createAcpContextPlugin({...})` 必须传
`modelContextLimit: compression.modelContextLimit` 与 `providerWindows: buildProviderWindowTable(cfg, defaultProviderId)`
（读源码是因为这条装配行**没有任何别的守卫能覆盖**：插件侧用例无论收到什么选项都成立，
类型上 `modelContextLimit?: number` 也收得下任何数字，而写错就等于复活"分母共用"那个 bug）。

装配行随 `boot()` 搬进了 `packages/host/src/host.ts` ⇒ 守卫改读 `../../host/src/host.ts`，
**两条断言逐字未改**。这是本次改造第一轮唯一暴露的测试失败，而它报的正是这个：
守卫必须跟着代码走，否则"代码搬走了"会以**测试失败**的形式误报。

### 9.4 一个未处理的已知项（非重叠，留作后续）

`flushDirtySessions` 里的 `console.warn('[WARN] 脏会话落盘失败（…）')` **保持原样**。理由：
它是**运行期**（`sendStream` / `shutdown` 路径）诊断，不在 `notice` 的"装配期"分级表内；
把它塞进 notice 会让"装配期 vs 运行期"这条边界变模糊，而它今天走 stderr、本来也不会污染
stdout 协议。真要收，应该收进 `emitLog`（运行期通道）而不是 notice —— 但那会把它的流向从
stderr 改成宿主的 `logLine`，属于**另一次有意识的改动**，不混在搬迁里。

### 9.5 S4 测试收口：能力归 host，兼容归 cli

搬迁期为了让"CLI 导出面逐字不变"这条约定有据可依，`cli.test.ts` / `provider-model.test.ts`
里**原样保留**了一份与 host 同能力的用例（计划 §5 明确记为"有意重叠，待搬 `boot` 时统一收口"）。
S4 收口按一条原则落地：**能力测试只留 host 一份，cli 只留「re-export 兼容」+「CLI 专属」**。

**① 删除的重复（同一符号两侧都有覆盖）** —— cli 侧净删 24 条：

| 位置 | 删除的用例 | host 侧对应能力测试 |
|---|---|---|
| `cli.test.ts` `ProviderTypeRegistry / 插件化扩展` | `loadPluginDirs` 9 条、`registerBuiltinProviderTypes` 6 类型、惰性展示元信息、`BuiltinPluginRegistry` 统一登记、`BuiltinToolRegistry` 多级加载 L1 | `load-plugin-dirs.test.ts` / `builtin-registry.test.ts` |
| `cli.test.ts` `内置插件声明式启用` | `resolveBuiltinPlugins` 依赖闭包/去重/coordinator、`unknownBuiltinPluginIds` | `builtin-registry.test.ts` |
| `cli.test.ts` `配置校验` | `resolveContextWindowTokens`、`buildProviderWindowTable` | `config-window.test.ts` |
| `cli.test.ts` `CliPermissionEngine` | allow-all / deny-all / getMode-setMode 三条模式短路 | `permission.test.ts` |
| `provider-model.test.ts` | `normalizeProviderConfigs`/`sanitizeProviderId`/`checkProviderConfigs` 整个 describe（8 条） | `config-window.test.ts` |

**② 从"仅 cli 覆盖"移入 host 的 3 处**（host 拥有该能力，却只有 cli 有用例 —— 只能搬不能删）：
`resolveCompactionWindow`、`buildCompactionOptions`（→ `config-window.test.ts`）、
`loadPluginDirs` 相对路径导入失败（→ `load-plugin-dirs.test.ts`）。其中 `provider-model.test.ts`
的 `normalizeProviderConfigs` 段里 2 条**独有用例**（同模型多实例的 baseUrl 保留、显式 id 与派生
id 不冲突）在删除前先并入 host，避免删出覆盖洞。

**③ 替换为一条 re-export 兼容断言**：`cli.test.ts` 新增 `describe('@harness/cli re-export 兼容')`
—— 逐个断言上移符号（A/C/B 档 + 配置层 + 权限接缝 + 装配主体，共 35 个）从 `@harness/cli` 与从
`@harness/host` 取到的是**同一个引用**。这把"导出面不变"从"靠 24 条行为用例顺带守着"变成"一条
直指的断言"。（注：任一条 re-export 被删，`cli.test.ts` 的静态 import 会先以 `SyntaxError` 报错
—— 兼容断言额外钉住"是同一个函数，不是重新包一层"。）

**④ 刻意保留在 cli 的**：presentation（`formatProviderTypeList` / `buildProviderTypesSection`）、
`parseCliArgs`、`CliPermissionEngine` 的 `askPrompt → 四态` 映射、provider 包工厂契约、boot 预加载
集成、REPL `/tools`、日志 sink、ACP 装配源码守卫，以及跨包一致性守卫（`resolveCompactionWindow`
与 `acp-context.lookupProviderWindow` 对照）。

**⑤ 已知的残留（非"重叠"，不在 S4 范围）**：`provider-model.test.ts` 里仍有若干 **host 拥有但只有
cli 覆盖**的直接函数用例（`resolveModelArg` / `formatResolutionRef` / `formatApiKeyTag` /
`findTokenOnlyDuplicates`），以及它们作为 helper 被 CLI 集成用例复用的部分。它们不是"两侧都有一份"
的重叠，按"先不动"留待一次单独的**能力归位**（把直接函数用例搬进 host，集成用例留 cli）。

**验证**：`bun run typecheck` 40 包 exit 0；`bun test ./packages` **2194 pass / 0 fail / 95 文件**
（2215 − 24 − 8 + 10 + 1 = 2194：host +10、cli −23）；`packages/host` 99 pass、`packages/cli` 398 pass。
反向验证 6/7（见 §5）：摘端点查表 ⇒ 移入的用例失败；摘 re-export ⇒ 兼容断言/模块加载失败。
