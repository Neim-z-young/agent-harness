# P0 收尾设计：`createHost` 接口与三条接缝

> 状态：**已定稿并开工** —— 三个分叉按 §7 的推荐选项落定（继承 / `renderNotice` 放 host / `asker` 四态
> + `Host.notices` 环形缓冲要）；**S1 已落地**（`packages/host/src/notice.ts` + 25 条用例），
> S1 期间的三处实测修正见 §8。
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
1. CLI 直接用 ⇒ **文案逐字不变**，`cli.test.ts:1939`（`config.json → plugins 有未生效项：no-such-plugin`）与
   `cli.test.ts:1027`（verbose ⇒ `已后台预热`）无需改动；
2. 纯函数 ⇒ 20 条可逐条快照测试，**不再依赖「跑一次 boot 抄 stdout」**；
3. A2A/VSCode 可以不用它（按 `code` 上报），也可以用它（写服务日志）——是**默认**不是**唯一**。

**`onNotice` 与既有 `setLogSink` 的关系：两条通道，不合并**。

| | `onNotice`（新） | `setLogSink`（已存在，`cli.test.ts:3185` 已测） |
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

## 4. 落地步骤（4 个可独立验证的 commit）

| 步 | 内容 | 独立性 |
|---|---|---|
| **S1** ✅ | `packages/host/src/notice.ts`：`HostNotice` / `NoticeCode` / `renderNotice` + 21 条快照测试 | **纯新增、不接线** ⇒ 其余测试逐条不变，可单独验证「渲染器是否逐字复刻」。**已完成**：host 71 pass（原 46 + 25）、全量 2197 pass（原 2172 + 25，其余逐条不变）、typecheck 40 包 exit 0 |
| **S2** | boot 主体 20 处改 `emitNotice`；`HarnessHost` 上移；`HarnessApp extends`；CLI 装默认渲染 sink | 最大的一步，但 S1 的快照测试此时成为兜底 |
| **S3** | `InteractivePermissionEngine` + `PermissionAsker` 上移；`CliPermissionEngine` 只留 asker | 权限用例（`cli.test.ts` 权限段）逐字通过 = 语义没动 |
| **S4** | 导出 `createHost()`；收口 host/cli 重叠测试；更新 `AGENTS.md` §3 与计划文档 | 文档与收尾 |

S1 先做的意义：把「文案」从「会不会被 boot 的其它改动顺带改掉」里摘出来 —— 20 条文案一旦有独立快照，
S2 的重构就有了**逐字不变**的判据，而不是靠读 diff 目测。

---

## 5. 验收口径

| 项 | 判据 |
|---|---|
| `bun run typecheck` | 40 包 exit 0 |
| `bun test ./packages` | 现有 2172 pass 逐条不变 + 新增 host 用例 |
| `cli.test.ts` | **逐字通过**，含三条被钉住的契约：`:1939`（plugins 未生效项文案）、`:1027`（verbose 预热日志）、`:3185`（`setLogSink` 路由 warn/error） |
| `packages/cli` | 429 pass，与搬迁前逐条一致 |
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
   ⏳ 待 S3。

> 现状：20 处输出里**只有 1 条**被测试钉住（`:1939`）。剩下 19 条今天既没有断言、也没进任何结构化通道 ——
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
| 1 | **形态** | ✅ **`HarnessApp extends HarnessHost`**（继承；实测 56 个成员 0 个 CLI 专属，继承贴着事实） | S2 |
| 2 | **文案归属** | ✅ **`renderNotice` 放 host 并导出**（逐字复刻；A2A 可选择不用） | S1 |
| 3 | **ask 接缝粒度** | ✅ **`asker(req, prompt) → 四态`**（远程宿主直接给四态，不做文本往返） | S3 |

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

还有一条**漏网站点**：`host/src/index.ts` 的 `preloadBuiltinToolMetas` 用 `console.warn` 直写
（不走 `stdout`、也不走 `setLogSink`），是本轮唯一"两个出口都不沾"的装配期诊断。S1 未纳入
（它属于 console 通道，与 `installConsoleCapture` 同侧）；**S2 要一并处理**，否则"元信息来源预载失败"
在 A2A 宿主下同样无声。

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
