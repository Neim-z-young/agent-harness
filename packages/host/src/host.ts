/**
 * @harness/host —— 宿主装配主体（`HarnessHost`）
 *
 * 自 `@harness/cli` 上移（P0 收尾 · S2 第三步）：装配流程（会话持久化、权限存储、插件装配、
 * `boot()` 全流程）此前只存在于 CLI 的 `HarnessApp` 里，A2A server / VSCode 扩展若照抄一份
 * 就是"两份装配必然分叉"。上移后 CLI 侧 `export class HarnessApp extends HarnessHost` 只留
 * 两个**终端形态**的接缝（`stdout → onNotice`、`askPrompt → asker`），其余继承即导出面。
 *
 * ## 三条接缝（host 不认识终端、不认识 readline、不认识 A2A）
 * - `asker`（`./permission.ts`）："怎么问到答复"由宿主给，"问到之后怎么记"留在引擎里
 *   ⇒ 四态语义第一次只有一份。
 * - `onNotice`（`./notice.ts`）：装配期三级诊断。缺省只进 `notices` 环形缓冲，不写任何流。
 * - `logLine`：**运行期**引擎 warn/error 的兜底行出口（TUI 会另挂 `setLogSink` 接管）。
 *   `onNotice` 与 `setLogSink` / `logLine` 是**两条通道，不合并**（时机、内容、消费方都不同）。
 *
 * ## 与 boot 的时序：一个都没动
 * 14 个步骤的顺序、判据、抛错点全部保持（Hooks 顺序敏感：`applyConfigAgentOverrides` 必须在
 * `createHarness` 之后、`start` 之前；`applyMcpServers` 必须在 `start` 之前）。唯一变化是
 * 21 处 `this.options.stdout?.write?.(...)` → `this.emitNotice(...)`。
 *
 * ## 有意偏离设计稿的四处（详见 `docs/host-extraction-design.md` §9）
 * ① `Host` 用 `type Host = HarnessHost` 而非另立 interface（同一份 56 成员写两遍 = 第二套口径）；
 * ② `HostOptions` 多一个 `logLine`（运行期行出口，设计稿只列了装配期的 `onNotice`）；
 * ③ `anthropicProviderConfig` 保持 `any`（设计稿写 `unknown`，会逼出四处无谓 cast）；
 * ④ `createPermissionEngine` 是有意的覆写点（让 CLI 保留 `CliPermissionEngine` / `setAskPrompt`）。
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createHarness } from '@harness/core'
import type { AgentDefinition, ChatProvider, Harness } from '@harness/core'
import { ProviderTypeRegistry } from '@harness/plugin'
import type { AgentPlugin, ProviderConfig } from '@harness/plugin'
import type { MockProviderConfig } from '@harness/provider-mock'
import type { McpServerEntry } from '@harness/mcp-server-registry'
import { createSnapshotService } from '@harness/snapshot'
import type { SnapshotService } from '@harness/snapshot'
import { createWorkspacePlugin } from '@harness/workspace-shell'
import { createRevertPlugin, createSnapshotPlugin } from '@harness/revert'
import { formatSkillSource } from '@harness/skill'
import {
  reconstructHistory,
  buildResolveBlock,
  getSessionModelOverride,
  sessionModelMetaPatch,
} from '@harness/session'
import type {
  CompactionBlock,
  HistoryLoadRange,
  Message,
  Session,
  SessionModelOverride,
  SessionOriginalStore,
} from '@harness/session'
import {
  ConfigStore,
  SessionFileStore,
  SessionPointerStore,
  SecretCipher,
  ConfigValidationError,
  resolveSecret,
  resolveWorkspace,
  createWorkspaceOriginalStore,
} from '@harness/workspace'
import type { SessionFile, Workspace } from '@harness/workspace'

// 本包内：叶子模块（不得反向 import `./index`，见各文件头）
import { lazyImport } from './lazy'
import { loadPluginDirs, getBuiltinRegistry, preloadBuiltinToolMetas, registerBuiltinProviderTypes, resolveBuiltinPlugins } from './plugins'
import { buildProviderWindowTable, formatModel, normalizeProviderConfigs, parseModelSpec } from './provider'
import type { ResolvedProviderConfig } from './provider'
import {
  checkCompactionConfig,
  checkCompactionReachability,
  checkCompressionConfig,
  checkMemoryConfig,
  checkTelemetryConfig,
  findTokenOnlyDuplicates,
  formatApiKeyTag,
  memoryPluginOptions,
  resolveModelArg,
  telemetryPluginOptions,
  toAcpConfig,
  toAcpScope,
  toAcpScopeMap,
  validateProviderConfigs,
} from './config'
import type { HarnessConfig, SessionEndpoint } from './config'
import { makeNotice, renderNotice } from './notice'
import type { HostNotice, NoticeSink } from './notice'
import { InteractivePermissionEngine } from './permission'
import type { HumanDecisionEvent, PermissionAsker, PermissionMode, PermissionStoreFile } from './permission'
// 默认 Agent 提示词：独立文本文件，import 加载（Bun 原生支持文本导入；tsc 侧由 ./env.d.ts 声明）。
// 随 `defaultAgent()` 一并自 cli 上移 —— 它是装配产物的一部分，不是终端形态。
import defaultAgentPrompt from './prompts/default-agent.txt'

/** `Host.notices` 环形缓冲容量：装配期 notice 的量级是「数十条」，1024 足够覆盖且不会无限增长 */
export const HOST_NOTICE_LIMIT = 1024

/** 装配期诊断的渲染出口（CLI 用 `renderNotice` 接上） */
export type { NoticeSink }

/**
 * 宿主装配选项（原 `HarnessAppOptions` 去掉两个 CLI 专属字段 + 两条接缝）。
 *
 * 有意**不含** `stdout`：host 不认识终端。装配期诊断走 `onNotice`（结构化），
 * 运行期告警走 `logLine` / `setLogSink`；CLI 侧由 `HarnessAppOptions` 补上输出适配。
 */
export interface HostOptions {
  /**
   * 工作目录。启动时参数传入（CLI 上是 `-c/--cwd <dir>`）即以此为准；
   * **不传时取当前进程目录**（`process.cwd()`）。
   */
  cwd?: string
  /** 持久化目录。不传时取默认数据目录（`~/.harness`）；会话/配置/权限文件都在其下。 */
  dataDir?: string
  agentId: string
  provider: string
  /** 默认模型 ID（如 claude-3-5-sonnet，或 provider/model 跨 Provider 指定），设置到默认 Agent 的 model */
  model?: string
  sessionId?: string
  permissionMode?: 'allow-all' | 'ask' | 'deny-all'
  /**
   * 权限询问接缝（见 `./permission.ts`）："怎么问到答复"由宿主给。
   * 缺省 = `InteractivePermissionEngine` 的"取不到答复 ⇒ deny"语义。
   */
  asker?: PermissionAsker
  /**
   * 人工决策审计落盘接缝（M3 `decision.human`，见 `./permission.ts` 的 `HumanDecisionEvent`）。
   *
   * 权限引擎只**产出**事件，落盘实现归宿主：CLI 传 `createAuditSink(dataDir)`，A2A 宿主
   * （`runA2aCli` / VSCode sidecar 走的就是它）同样传一份 —— 否则「同一条人工决策换个宿主
   * 就没有审计记录」。缺省不审计（纯 headless 场景无人工决策可记）。
   */
  audit?: (env: HumanDecisionEvent) => void | Promise<void>
  /** 测试注入 */
  mockProviderConfig?: MockProviderConfig
  anthropicProviderConfig?: any
  /** 多 Provider 定义（来自 config.json 的 providers；boot 时逐项安装，支持运行时跨 Provider 切换） */
  providers?: ProviderConfig[]
  verbose?: boolean
  /** 额外要注册的 Agent 列表 */
  agents?: AgentDefinition[]
  /** 额外 internalPlugins */
  extraPlugins?: AgentPlugin[]
  /**
   * 启用文件快照 + /revert 命令（默认 false）。
   * 开启后：createHarness 注入 @harness/snapshot 工厂（每轮 query 自动 capture
   * 并挂载 meta.snapshot），REPL 提供 /revert stage|clear|commit|status。
   */
  snapshot?: boolean
  /**
   * 启动时自动恢复上次会话（默认 true，等价 config.autoResume）。
   * `harness run "<prompt>"` 一次性执行请显式传 false —— 脚本化调用不该悄悄接着上一个会话写。
   */
  autoResume?: boolean
  /** 是否启用 boot 末尾的后台静默预加载内置插件/工具（多级加载 L2，默认 true）。设为 false 关闭。 */
  backgroundPreload?: boolean
  /**
   * 允许加载外部插件目录里的**代码**（默认 false）。
   * 等价于 config.json 的 `allowPluginCode`；两者任一为真即开闸（CLI 参数优先）。
   * 关闭时插件目录里的文件只被登记、不 import —— 防止克隆来的仓库借 `.harness/plugins` 执行代码。
   */
  allowPluginCode?: boolean
  /**
   * 装配期结构化诊断出口（`./notice.ts`）。**缺省只进 `notices` 环形缓冲，不写任何流** ——
   * 这样 A2A / VSCode 不传它也不会把降级事实丢掉（CLI 传 `renderNotice` 复刻原文案）。
   */
  onNotice?: NoticeSink
  /**
   * 运行期文本行出口：引擎 `logger.warn/error` 在没有 `setLogSink` 时的兜底（headless / REPL）。
   * **与 `onNotice` 是两条通道**：这条是运行期、自由文本；那条是装配期、结构化 `code`。
   */
  logLine?: (line: string) => void
}

/**
 * {@link HarnessHost.warmupBuiltins} 的结果 —— 供调用方判断"工具池到底有没有备好"。
 *
 * 三个字段都是为了**可归因**：`installed` 空 + `tools` 为 0 时，是"本来就没插件"还是
 * "插件都在、只是组装没跑"？只有分开报才答得出来。失败进 `failed`（并按既有 notice 上报），
 * 不进异常 —— 一个插件坏了不该让工具池读不出来。
 */
export interface BuiltinWarmupResult {
  /**
   * 预热过程中**实际新装上**的非 optIn 内置插件 id（boot 阶段已装过的不列）。
   *
   * 注意它是"**那次预热**"的描述而不是"这次调用"的：整个预热只跑一次（见 `warmupBuiltins`），
   * 后续调用拿到的是同一份结果对象 —— 所以第二次调用看到的 `installed` 与第一次**相同**，
   * 这不表示它又装了一遍。判断"没重复装"要看插件列表有没有重名。
   */
  installed: string[]
  /** 加载或安装失败的插件 id */
  failed: string[]
  /** 组装**之后** `ToolRegistry` 里的工具数（= 调用方接下来能列到的数量） */
  tools: number
}

/** boot() 的会话决策结果，供各宿主的启动提示用（「已恢复上次会话」/「为何没恢复」） */
export interface SessionRestoreInfo {  /** explicit：`-s/--session` 指定；auto：自动恢复最近会话；new：新建 */
  source: 'explicit' | 'auto' | 'new'
  sessionId: string
  /** source=auto 时：该会话的消息条数 */
  messageCount?: number
  /** source=auto 时：该会话最后更新时间（ms） */
  updatedAt?: number
  /**
   * 被跳过的「最近会话」：它属于其它工作目录（或自动恢复已关闭）。
   * 明确记录是为了让「为什么这次没接着上次」有答案，而不是让用户对着空会话猜。
   */
  skipped?: { id: string; cwd?: string; updatedAt: number; reason: 'other-cwd' | 'disabled' }
}

/**
 * 惰性构造 Mock Provider 插件（默认 provider 兜底时使用；Mock 模块用时才加载）。
 */
async function lazyMockProvider(config?: MockProviderConfig): Promise<AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } }> {
  const { createProviderMockPlugin } = await lazyImport<{ createProviderMockPlugin: (c?: MockProviderConfig) => AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } } }>('@harness/provider-mock')
  return createProviderMockPlugin(config) as any
}

/**
 * 惰性构造 Anthropic Provider 插件（默认 provider=anthropic 且已配置 key 时使用；模块用时才加载）。
 */
async function lazyAnthropicProvider(config: unknown): Promise<AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } }> {
  const { createProviderAnthropicPlugin } = await lazyImport<{ createProviderAnthropicPlugin: (c: unknown) => AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } } }>('@harness/provider-anthropic')
  return createProviderAnthropicPlugin(config as any) as any
}

export class HarnessHost {
  /** 工作区布局（两级目录 + 数据文件路径），由 cwd/dataDir 解析而得 */
  public readonly workspace: Workspace
  public readonly sessionStore: SessionFileStore
  /**
   * 项目级「上次会话」指针（`<cwd>/.harness/last-session.json`）。
   * 自动恢复的会话 id 记在**当前工作目录**里，见 findResumeTarget / rememberSession。
   */
  public readonly sessionPointer: SessionPointerStore
  public readonly permissionStorePath: string
  /** 全局配置读写（config.json：model / provider / apiKey 持久化） */
  public readonly configStore: ConfigStore<HarnessConfig>
  /** Provider 类型注册表（内置 + 外部 plugins 插件注册的工厂；config.type 据此动态解析） */
  public readonly providerTypes: ProviderTypeRegistry
  /** 文件快照服务（options.snapshot 开启时创建，供 createHarness 注入与 /revert 命令） */
  public readonly snapshotService: SnapshotService | undefined
  /** 权限引擎（boot 时构建）。/permission 命令据此查看/切换交互模式与规则 */
  public permission!: InteractivePermissionEngine
  /** 插件管理：boot 时登记的「可管理」插件对象（pluginId → AgentPlugin），供 /plugins enable 重新安装 */
  readonly pluginRegistry = new Map<string, AgentPlugin>()
  /** 已 start 的 Harness（boot 产物）。boot 前为 undefined —— 与 `_harness` 同一实例。 */
  public harness!: Harness
  /** boot 选中的会话（boot 产物）。boot 前为 undefined；与 `boot()` 返回的 `session` 同一实例。 */
  public session!: Session
  private options: Required<Pick<HostOptions, 'cwd' | 'dataDir' | 'agentId' | 'provider'>> & HostOptions
  /**
   * boot() 装载的 Provider 配置（CLI options.providers 优先，其次 config.json providers），
   * 已归一化（id 必定存在）——供 /model ? 展示，也是 /model 解析实例的直接数据源。
   */
  private loadedProviders: ResolvedProviderConfig[] = []
  /** boot() 的会话决策结果（explicit / auto / new），供 REPL、TUI 提示用。每次 boot 覆盖。 */
  sessionRestore: SessionRestoreInfo = { source: 'new', sessionId: '' }
  /**
   * 引擎侧运行时告警（如「system 区前缀变化 ⇒ 缓存整段重算」）的可挂载出口。
   *
   * TUI 会挂一个 sink：OpenTUI 接管 stdout 做布局排版，而 boot 里 `logger.warn/error`
   * 默认直写 `stdout` —— 引擎每轮跑出的告警会**混进渲染字符流、把 UI 排错位**（用户反馈）。
   * 挂上 sink 后，TUI 的 `warn/error` 改走应用层（渲染成 console 块）；headless/REPL
   * 不挂 sink，行为不变（仍写 stdout）。
   */
  private logSink?: (level: 'warn' | 'error', msg: string, meta?: unknown) => void
  /** 装配期 notice 环形缓冲（见 emitNotice）：不依赖任何输出流也能事后回读 */
  private readonly noticeLog: HostNotice[] = []
  /** 挂载/卸载命令日志出口（TUI 用；传 undefined 卸载，回到写 stdout）。 */
  setLogSink(fn: ((level: 'warn' | 'error', msg: string, meta?: unknown) => void) | undefined): void {
    this.logSink = fn
  }
  /** 引擎告警统一出口：有 sink 走应用层（TUI console 块），否则写宿主行出口（headless/REPL）。 */
  private emitLog(level: 'warn' | 'error', msg: string, meta?: unknown): void {
    const line = `[${level.toUpperCase()}] ${msg}${meta !== undefined ? ' ' + JSON.stringify(meta) : ''}\n`
    if (this.logSink) this.logSink(level, msg, meta)
    else this.writeLine(line)
  }

  /**
   * 装配期诊断出口（`./notice.ts` 的三级通道）——**与 `emitLog` 是两条通道，不合并**：
   * 这条管装配期（boot + 后台预加载）的「事实 / 告警 / verbose 日志」，带稳定 `code`，
   * 供 CLI 渲染、A2A 上报、启动自检；`emitLog` 管运行期每轮 query 的引擎 warn/error，
   * 是自由文本。合并两条要改一个已被 `cli.test.ts` 钉住的契约，收益只是"少一个名词"。
   *
   * **verbose 门控在这里**（不是渲染器里）：`log` 级且非 verbose 时根本不 emit ——
   * 于是 `renderNotice` 是纯全函数，快照测试不必为 log 级造两种期望。
   *
   * **无论有没有 sink 都进环形缓冲**：治的正是「宿主不传输出流 ⇒ 降级事实静默丢弃」这个老病
   * （如"未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock"）。A2A / VSCode 不传 sink 也能事后读
   * `notices` 做启动自检，而不是拿到一个 Mock 的回答却**没有任何信号**。
   */
  protected emitNotice(n: HostNotice): void {
    if (n.level === 'log' && !this.options.verbose) return
    this.noticeLog.push(n)
    if (this.noticeLog.length > HOST_NOTICE_LIMIT) this.noticeLog.shift()
    if (this.options.onNotice) this.options.onNotice(n)
    else this.writeLine(renderNotice(n))
  }

  /** 宿主文本行出口：装配期 notice 无 sink 时的兜底 + 运行期 emitLog 的兜底 */
  private writeLine(line: string): void {
    this.options.logLine?.(line)
  }

  /** 本次装配发出的 notice（环形缓冲，≤ HOST_NOTICE_LIMIT 条）——供启动自检事后回读 */
  get notices(): readonly HostNotice[] {
    return this.noticeLog
  }

  /**
   * 权限引擎工厂（boot 调用）——默认装宿主无关的 `InteractivePermissionEngine`：
   * 四态语义 / mode 短路 / 规则写回**只有这一份**（三个宿主共用）。CLI 覆写成 `CliPermissionEngine`
   * 以保留其文本问答的 `setAskPrompt` 形态（见设计稿 §2.4「收益」）。
   */
  protected createPermissionEngine(
    rules: Record<string, unknown>,
    save: (r: Record<string, unknown>) => Promise<void>,
    mode: PermissionMode,
  ): InteractivePermissionEngine {
    return new InteractivePermissionEngine(rules, {
      mode,
      asker: this.options.asker,
      audit: this.options.audit,
      store: { ...(rules as any), save },
    })
  }

  constructor(options: HostOptions) {
    // 工作目录：**启动参数传入即用传入值，未传才取当前进程目录**（dataDir 同理，未传取默认数据目录）。
    // 统一交给 resolveWorkspace 解析，避免「谁先算 cwd」两处各算一遍导致口径不一致。
    this.workspace = resolveWorkspace({ cwd: options.cwd, dataDir: options.dataDir })
    const cwd = this.workspace.cwd
    this.options = {
      ...options,
      cwd,
      dataDir: this.workspace.dataDir,
      agentId: options.agentId,
      provider: options.provider,
    }
    this.sessionStore = new SessionFileStore(this.workspace)
    this.sessionPointer = new SessionPointerStore(this.workspace)
    this.permissionStorePath = this.workspace.files.permissions
    this.configStore = new ConfigStore<HarnessConfig>(this.workspace)
    // Provider 类型注册表：注册内置类型（openai/anthropic/gemini/glm/qwen/mock），
    // boot() 时再加载外部 plugins 插件注册的自定义 type
    this.providerTypes = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(this.providerTypes)
    if (options.snapshot) {
      this.snapshotService = createSnapshotService({ worktree: cwd })
    }
  }

  /** 加载权限文件 */
  private async loadRules(): Promise<Record<string, unknown>> {
    if (existsSync(this.permissionStorePath)) {
      try {
        const s = JSON.parse(await readFile(this.permissionStorePath, 'utf-8')) as PermissionStoreFile
        return s.rules ?? { '*': 'ask' }
      } catch { return { '*': 'ask' } }
    }
    return { '*': 'ask' }
  }
  private async saveRules(rules: Record<string, unknown>): Promise<void> {
    await mkdir(this.workspace.dataDir, { recursive: true })
    await writeFile(this.permissionStorePath, JSON.stringify({ rules }, null, 2))
  }
  /** 更新权限引擎规则并落盘（/permission 使用） */
  async setPermissionRules(rules: Record<string, unknown>): Promise<void> {
    this.permission.updateRules(rules as any)
    await this.saveRules(rules)
  }

  /** 默认 Agent 定义（无 agent 指定时使用）；含 CLI/config 解析出的默认模型。
   *  提示词文本存放于 prompts/default-agent.txt（参考 opencode：prompt 独立成文件，import 加载），
   *  便于直接编辑文本而不改代码。 */
  defaultAgent(): AgentDefinition {
    const def: AgentDefinition = {
      id: this.options.agentId,
      name: 'Harness Agent',
      description: 'CLI 默认 Agent',
      mode: 'primary',
      tools: ['*'],
      permission: { '*': 'ask' },
      systemPrompt: defaultAgentPrompt.trim(),
    }
    if (this.options.model) {
      const spec = parseModelSpec(this.options.model)
      def.model = { providerId: spec.providerId, modelId: spec.modelId }
    }
    return def
  }

  /**
   * 合并 config.json 的 agents[].tools 到已注册 Agent 定义（按 id 覆盖 tools 白名单）。
   * 必须放在 createHarness 之后、query 之前：工具池在 query 时经 filterByWhitelist(agent.tools)
   * 实时读白名单，因此覆盖任何来源（default / options.agents / agentDirs 的 md）的同名 Agent。
   */
  async applyConfigAgentOverrides(harness: Harness): Promise<void> {
    const cfg = await this.configStore.load()
    if (!cfg.agents?.length) return
    for (const { id, tools, mcpServers, excludeMcpServers } of cfg.agents) {
      if (!tools?.length && !mcpServers && !excludeMcpServers) continue
      const existing = harness.agent.get(id)
      if (!existing) continue
      const merged: AgentDefinition = { ...existing }
      if (tools) merged.tools = [...tools]
      if (mcpServers) merged.mcpServers = [...mcpServers]
      if (excludeMcpServers) merged.excludeMcpServers = [...excludeMcpServers]
      // source=config + overlay：这是文档化覆盖链的最后一环（会覆盖 options / dir 来源的同名定义），
      // 属于正常路径 ⇒ 只发 agent.reregistered（from/to 带来源）不打 WARN。
      harness.agent.register(merged, { source: 'config', overlay: true })
    }
  }

  /**
   * 持久化某 Agent 的 tools 白名单到 config.json（upsert agents[].tools）并即时应用到运行时。
   * 供 /tools 等插件调用：写入端 + 内存覆盖一次完成，重启后由 applyConfigAgentOverrides 回读生效。
   * 保留已有 entry 的 mcpServers/excludeMcpServers 声明，避免 /tools 触发时静默丢弃。
   */
  async setAgentTools(agentId: string, tools: string[]): Promise<void> {
    const cfg = await this.configStore.load()
    const agents = [...(cfg.agents ?? [])]
    const idx = agents.findIndex((a) => a.id === agentId)
    const prev = idx >= 0 ? agents[idx] : undefined
    const entry: { id: string; tools: string[]; mcpServers?: string[]; excludeMcpServers?: string[] } = {
      id: agentId,
      tools: [...tools],
      ...(prev?.mcpServers ? { mcpServers: [...prev.mcpServers] } : {}),
      ...(prev?.excludeMcpServers ? { excludeMcpServers: [...prev.excludeMcpServers] } : {}),
    }
    if (idx >= 0) agents[idx] = entry
    else agents.push(entry)
    await this.configStore.save({ ...cfg, agents })
    // 即时覆盖运行时同名 Agent（query 时实时 filterByWhitelist(agent.tools)）
    // source=cli.tools：与启动回读（source=config）区分开，归因时能看出"这次是 /tools 干的"；
    // overlay：用户显式操作，只发事件不打 WARN。
    const existing = this.harness?.agent?.get?.(agentId)
    if (existing) this.harness!.agent.register({ ...existing, tools: [...tools] }, { source: 'cli.tools', overlay: true })
  }

  /** 读取 config.json 的 mcpServers 列表（缺省 []） */
  async getMcpServers(): Promise<McpServerEntry[]> {
    const cfg = await this.configStore.load()
    return [...(cfg.mcpServers ?? [])]
  }

  /**
   * 持久化 mcpServers 列表到 config.json（upsert 顶层 mcpServers）。供 mcp-server-registry 的
   * /mcp 命令在启用/禁用/增删后写回；重启后由 boot 阶段经 cli.mcp.configure 重新注入生效。
   */
  async setMcpServers(list: McpServerEntry[]): Promise<void> {
    const cfg = await this.configStore.load()
    await this.configStore.save({ ...cfg, mcpServers: [...list] })
  }

  /**
   * 把 config.json 的 mcpServers 应用到运行时：createHarness 后、core.harness.start 前触发
   * cli.mcp.configure Hook，注入 mcp-server-registry 插件（按 enabled 开关在 start 时连接）。
   *
   * 该 hook 已在 @harness/plugin 的 `Hooks` 里声明 ⇒ 不再需要 `as any` 绕过类型
   * （此前调用点用 `(harness.plugin as any)?.trigger?.(...)`，hook 名写错也不会报错）。
   * `harness.plugin` 由 createHarness 建好，可空断言仅为防手写 Harness 桩。
   */
  async applyMcpServers(harness: Harness): Promise<void> {
    const cfg = await this.configStore.load()
    const list = [...(cfg.mcpServers ?? [])]
    await harness.plugin?.trigger('cli.mcp.configure', { mcpServers: list })
  }

  /**
   * 当前生效模型展示（`provider/model`）：优先读取活动 Agent 定义的 model，回退 options.model。
   * 只绑定了 provider、未指定 model 时显示 `<provider>/(默认模型)`——让 /model 输出不至于空着。
   */
  getModel(agentId: string): string | undefined {
    const a = this.harness?.agent?.get?.(agentId)
    if (a?.model?.providerId) return formatModel(a.model.providerId, a.model.modelId) ?? `${a.model.providerId}/(provider 默认模型)`
    if (a?.model?.modelId) return a.model.modelId
    return this.options.model
  }

  /**
   * 「本会话实际会用的模型」展示标签 —— 优先级与 core 的解析链严格一致：
   * 会话级覆盖（Session.meta.model）> Agent 定义 > 启动参数 -m > Provider 默认模型。
   */
  resolveSessionModel(session: Pick<Session, 'agentId' | 'meta'> | undefined): string | undefined {
    const ov = getSessionModelOverride(session)
    if (ov) {
      if (ov.providerId) return formatModel(ov.providerId, ov.modelId) ?? `${ov.providerId}/(provider 默认模型)`
      return ov.modelId
    }
    return this.getModel(session?.agentId ?? this.options.agentId)
  }

  /**
   * 本会话**实际端点**（`providerId` / `modelId`）—— `resolveSessionModel` 的 id 版。
   *
   * 为什么另开一个而不是复用展示标签：标签是 `provider/model` 的合串（还可能带
   * `/(provider 默认模型)` 这类文案），拿它去查窗口表只会永远 miss；这里给的是查表要的原始字段。
   *
   * 解析链与 core `_prepareQueryOnce` 严格一致（`input.model?.providerId ?? agent.model?.providerId`）：
   * 会话级覆盖（`Session.meta.model`）> Agent 定义 model。**注意**：覆盖里只写了 modelId 时
   * providerId 仍回落到 Agent 定义，与 core 同；两边都解析不出就返回空对象，由查表侧落
   * fallback（= 默认 Provider 的窗口），与改造前逐位相同。
   */
  resolveSessionEndpoint(session: Pick<Session, 'agentId' | 'meta'> | undefined): SessionEndpoint {
    const ov = getSessionModelOverride(session)
    const a = this.harness?.agent?.get?.(session?.agentId ?? this.options.agentId)
    const providerId = ov?.providerId ?? a?.model?.providerId
    const modelId = ov?.modelId ?? a?.model?.modelId
    return { ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}) }
  }

  /** 当前会话的模型覆盖（undefined = 未覆盖，跟随 Agent 定义与全局默认） */
  sessionModelOverride(session: Pick<Session, 'meta'> | undefined): SessionModelOverride | undefined {
    return getSessionModelOverride(session)
  }

  /**
   * 写「会话级模型覆盖」并立即落盘：只影响本会话，**不动** Agent 定义、**不写** config.json。
   * `override` 传 undefined 即清除覆盖（回落该 Agent 的默认模型）。
   *
   * 为什么必须落盘：重启后「自动恢复上次会话」要把这个选择一起带回来，
   * 否则用户每次重启都得重新切一遍模型。
   */
  async setSessionModel(session: Session, override: SessionModelOverride | undefined): Promise<Session> {
    await this.harness.session.updateMeta(session.id, sessionModelMetaPatch(override))
    const fresh = (await this.harness.session.get(session.id)) ?? session
    await this.sessionStore.save(fresh)
    return fresh
  }

  /** 解析指定 providerId 在当前 harness 实际命中的 ChatProvider；未装配的 provider 会回退到默认 Provider */
  resolveChatProvider(providerId?: string): ChatProvider | undefined {
    const h = this.harness as { resolveChatProvider?: (id?: string) => ChatProvider } | undefined
    return h?.resolveChatProvider?.(providerId)
  }

  /** 当前已配置的 Provider 实例（归一化后，id 必有）；供 /model 解析与展示 */
  configuredProviders(): ResolvedProviderConfig[] {
    return this.loadedProviders.length ? this.loadedProviders : normalizeProviderConfigs(this.options.providers ?? []).providers
  }

  /**
   * 运行时切换模型（兼容入口）：接受 `/model` 的全部写法（序号 / 实例 id / 模型名 / `provider/model`）。
   * 解析不成立（歧义、序号越界、拼错）时返回 false，不产生任何副作用。
   */
  async setModel(agentId: string, spec: string): Promise<boolean> {
    const r = resolveModelArg(spec, this.configuredProviders(), this.providerTypes.list())
    switch (r.kind) {
      case 'instance':
        // 命中实例：provider 与其配置的 model 一并生效；实例未声明 model 时清空 modelId，
        // 交由该 Provider 的默认模型接管（避免把上一个模型的 id 带到新 Provider）
        return this.applyModel(agentId, r.providerId, r.modelId, { replaceModel: true })
      case 'explicit':
        return this.applyModel(agentId, r.providerId, r.modelId, { replaceModel: true })
      case 'model':
        return this.applyModel(agentId, undefined, r.modelId)
      default:
        return false
    }
  }

  /**
   * 落地一次模型切换：更新 Agent 的 model 覆盖 + 持久化到 config.json。
   * `replaceModel`：即使 modelId 为空也覆盖（并删除旧的 modelId），用于「切到某实例」的语义。
   */
  private async applyModel(
    agentId: string,
    providerId: string | undefined,
    modelId: string | undefined,
    opts: { replaceModel?: boolean } = {},
  ): Promise<boolean> {
    const a = this.harness?.agent?.get?.(agentId)
    if (!a) return false
    const next = { ...(a.model ?? {}) }
    if (providerId) next.providerId = providerId
    if (modelId) next.modelId = modelId
    else if (opts.replaceModel) delete next.modelId
    a.model = next
    // provider 与 model 同步落盘：保证 config.provider/model 与运行时一致。
    // （旧实现只在 `provider/` 前缀命中时改 provider，会出现 provider 指向 A、model 属于 B 的不自洽配置。）
    const cfg = await this.configStore.load()
    const nextCfg: HarnessConfig = { ...cfg, ...(providerId ? { provider: providerId } : {}) }
    if (modelId) nextCfg.model = modelId
    else if (opts.replaceModel) delete nextCfg.model
    await this.configStore.save(nextCfg)
    return true
  }

  // ------------------------------------------------------------------
  // 技能管理（/skills）
  // ------------------------------------------------------------------

  /** 技能信息（供 /skills 展示，来源中文标注） */
  skillInfos(): Array<{ id: string; name: string; source: string; sourceLabel: string; enabled: boolean }> {
    const mgr = this.harness?.skillManager
    if (!mgr) return []
    return mgr.all().map((s) => ({
      id: s.id,
      name: s.name,
      source: s.loadedFrom,
      sourceLabel: formatSkillSource(s.loadedFrom),
      enabled: true,
    }))
  }

  /** 禁用技能 */
  async disableSkill(id: string): Promise<{ ok: boolean; message: string }> {
    const mgr = this.harness?.skillManager
    if (!mgr) return { ok: false, message: '技能系统未启用。' }
    if (!mgr.get(id)) return { ok: false, message: `技能 "${id}" 不存在。` }
    const ok = mgr.disable(id)
    return ok
      ? { ok: true, message: `已禁用技能 "${id}"（可在 /skills enable ${id} 恢复）。` }
      : { ok: false, message: `技能 "${id}" 已是禁用状态。` }
  }

  /** 启用技能 */
  async enableSkill(id: string): Promise<{ ok: boolean; message: string }> {
    const mgr = this.harness?.skillManager
    if (!mgr) return { ok: false, message: '技能系统未启用。' }
    if (mgr.get(id)) return { ok: false, message: `技能 "${id}" 已是启用状态。` }
    const s = await mgr.enable(id)
    return s
      ? { ok: true, message: `已启用技能 "${id}"（来源：${formatSkillSource(s.loadedFrom)}）。` }
      : { ok: false, message: `技能 "${id}" 不存在且无可恢复来源。` }
  }

  /** 重载技能 */
  async reloadSkill(id: string): Promise<{ ok: boolean; message: string }> {
    const mgr = this.harness?.skillManager
    if (!mgr) return { ok: false, message: '技能系统未启用。' }
    const s = await mgr.reload(id)
    return s
      ? { ok: true, message: `已重载技能 "${id}"（来源：${formatSkillSource(s.loadedFrom)}）。` }
      : { ok: false, message: `技能 "${id}" 不存在。` }
  }

  /**
   * 根据一条 ProviderConfig 构造对应 Provider 插件。
   * 通过 ProviderTypeRegistry 按 config.type 动态解析（内置类型 + 外部 plugins 插件注册的工厂），
   * 不再硬编码 switch —— 新增 Provider 类型无需改 CLI 代码。
   * type=openai 支持任意 OpenAI 兼容端点（DeepSeek / Ollama / GLM/Qwen 兼容 API）。
   */
  private async buildProviderPlugin(pc: ProviderConfig): Promise<AgentPlugin | undefined> {
    return this.providerTypes.resolve(pc.type)?.createPlugin(pc)
  }

  /**
   * 列出当前可切换的 Provider 候选（供 /model ? / /config ?）：config.providers 的实例 id +
   * 默认 provider + 注册表里已注册的 Provider 类型（含插件扩展的自定义 type）。
   * 后两者不依赖该 type 是否已在 config 定义实例，因此插件注册的 type 也能在 /model 中展示与校验。
   */
  listProviders(): string[] {
    const ids: string[] = []
    // config / CLI 定义的 Provider 实例 id 优先（已归一化：省略 id 的项也已按 model 派生）
    for (const pc of this.configuredProviders()) if (!ids.includes(pc.id)) ids.push(pc.id)
    // 默认 provider（mock/anthropic 或自定义）放最前
    const def = this.options.provider ?? 'anthropic'
    if (!ids.includes(def)) ids.unshift(def)
    // 合并注册表里已注册的 Provider 类型（内置 + 外部插件自定义 type，来自 providerTypes）
    for (const t of this.providerTypes.list()) if (!ids.includes(t)) ids.push(t)
    return ids
  }

  /**
   * 启动装载的 Provider 实例配置（含各自默认/附加模型），供 /model ? 展示。
   * `index` 为 1-based 列表序号，用户可直接 `/model <序号>` 选择。
   *
   * `keyTag`：apiKey 展示标签。**仅当该实例与别的实例「type+baseUrl+model 全同」时才附指纹**
   * （`已配置(…AB12)`），因为只有这种情况下列表行会完全一样、只能靠 token 区分；其余场景保持简洁。
   *
   * `source`：实例在**运行期注册表**里的来源（`plugin:provider.anthropic` / `legacy` / `runtime` …）。
   * 与 config 侧的配置意图是两件事：配置说「我想要这个端点」，source 说「谁把它装了上去」——
   * 只有后者能区分「配置写了但压根没装配」（`未注册`）。
   * boot 前（harness 未建）不做交叉，此时不带 source（展示层也就不会有来源列）。
   */
  listConfiguredProviders(): Array<{
    index: number
    id: string
    model?: string
    baseUrl?: string
    apiPath?: string
    type?: string
    keyTag?: string
    source?: string
  }> {
    const dupIds = new Set(findTokenOnlyDuplicates(this.loadedProviders).flatMap((g) => g.members.map((m) => m.id)))
    // 老宿主 / 测试桩可能没有 providers 视图 ⇒ 可选链，取不到就不交叉（等于 boot 前的行为）
    const runtime = (this.harness as Harness | undefined)?.providers?.list?.()
    const sourceById = new Map((runtime ?? []).map((p) => [p.id, p.source]))
    return this.loadedProviders.map((p, i) => ({
      index: i + 1,
      id: p.id,
      model: p.model,
      baseUrl: p.baseUrl,
      apiPath: p.apiPath,
      type: p.type,
      ...(runtime ? { source: sourceById.get(p.id) ?? '未注册' } : {}),
      ...(dupIds.has(p.id) ? { keyTag: formatApiKeyTag(p.apiKey, { fingerprint: true }) } : {}),
    }))
  }

  /**
   * 「同端点同模型」实例组（同配置不同 token / 完全重复）——供 /model ? 提示：
   * 这类实例的 id 是从 model 派生的（`-2`/`-3`），与数组顺序绑定，调整顺序会让
   * `config.provider` 悄悄指到另一个 token，因此建议显式写 id。
   */
  tokenOnlyDuplicateGroups(): ReturnType<typeof findTokenOnlyDuplicates> {
    return findTokenOnlyDuplicates(this.loadedProviders)
  }

  /** 装配并启动 Harness，返回已 start 的实例；加载/恢复 session */
  async boot(): Promise<{ harness: Harness; session: Session }> {
    // 多级加载 L1：预载内置工具静态元信息（描述/别名/安全），由各工具插件自携带 metaSource，
    // 保证后续 /tools 等命令在任何运行时工具模块（L2）加载前即可展示内置工具描述。
    await preloadBuiltinToolMetas((n) => this.emitNotice(n))

    const rules = await this.loadRules()
    const mode = this.options.permissionMode ?? 'ask'
    const perm = this.createPermissionEngine(rules, (r) => this.saveRules(r), mode)
    this.permission = perm

    // ------------------------------------------------------------------
    // Provider 装配：支持多 Provider 自由切换
    // 1) 优先安装 config.providers 里显式定义的多 Provider（按顺序注册到注册表，供跨 Provider 分发）
    // 2) 默认 Provider 的**实例只构造一次**（放在这一段的末尾，见下方 `chosenProvider`）。
    // 默认由谁担当**不再由注册顺序决定** —— 构造完所有实例后显式 `providers.setDefault(...)`。
    // ------------------------------------------------------------------
    const cfg = await this.configStore.load()
    const rawProviderConfigs = this.options.providers?.length ? this.options.providers : (cfg.providers ?? [])
    // 归一化：把可选的 id 补全为唯一实例 id（缺省由 model 派生、重名自动加序号）。
    // 之后所有环节（装配 / 路由 / 校验 / 展示）都按「id 必定存在」处理，无需到处判空。
    const normalized = normalizeProviderConfigs(rawProviderConfigs)
    this.loadedProviders = normalized.providers
    const defaultProviderId = this.options.provider ?? cfg.provider ?? 'anthropic'

    // 加载外部插件（user ~/.harness/plugins → project .harness/plugins，后加载覆盖先加载）：
    // 通用 AgentPlugin 汇总到 externalPlugins 参与 Hooks 生命周期；Provider 类型工厂注册进 providerTypes 供 config.type 动态解析
    // 路径统一来自解析好的 workspace（dataDir 支持 --data-dir 覆盖，非写死 $HOME）
    // 代码注入防护：默认**不执行**插件目录里的代码（只登记告警），需 allowPluginCode 显式开闸
    const externalPlugins = await loadPluginDirs(this.providerTypes, [
      { dir: this.workspace.user.plugins, source: 'user' },
      { dir: this.workspace.project.plugins, source: 'project' },
    ], undefined, {
      allowCode: this.options.allowPluginCode ?? cfg.allowPluginCode ?? false,
      // 装配期诊断改走结构化出口（文案字节由 renderNotice 复刻，逐字不变）
      onNotice: (n) => this.emitNotice(n),
    })

    // 显式校验 + 密钥解析（错误一次性汇总，避免静默跳过/误导）
    const cipher = new SecretCipher(this.workspace)
    const configIssues: string[] = []
    // 归一化阶段的问题（id 重复 / id 与 model 均缺失）优先上报，避免后续就着残缺配置继续跑
    for (const iss of normalized.issues) configIssues.push(iss.message)
    const providerConfigs: ResolvedProviderConfig[] = []
    for (const [index, pc] of normalized.providers.entries()) {
      try {
        providerConfigs.push({ ...pc, apiKey: await resolveSecret(pc.apiKey, cipher) })
      } catch (err: any) {
        configIssues.push(`providers[${index}]（id=${pc.id}）：${err?.message ?? String(err)}`)
      }
    }
    for (const iss of validateProviderConfigs(normalized.providers, defaultProviderId, this.providerTypes.list())) {
      configIssues.push(iss.message)
    }
    if (configIssues.length) {
      this.emitNotice(makeNotice('config.providers-invalid', { issues: configIssues }))
      throw new ConfigValidationError(configIssues.join('；'))
    }

    // 默认 Provider 若是命名 Provider（非 mock/anthropic），从配置中找到它（避免重复注册，放到最后作默认）
    const isCustomDefault = defaultProviderId !== 'mock' && defaultProviderId !== 'anthropic'
    const defaultPc = isCustomDefault
      ? providerConfigs.find((p) => p.id === defaultProviderId)
      : undefined

    const providerPlugins: AgentPlugin[] = []
    let chosenProvider: AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } }
    /**
     * 实际装配为默认的**实例 id**（= 注册键）—— 供下面显式 `providers.setDefault` 用。
     *
     * 刻意不复用展示用的 `cpId`：两者口径不同 ——
     * `cpId` 说的是**配置意图**（config.json → provider），这里说的是**实际装配的事实**。
     * 无 ANTHROPIC_API_KEY 时配置意图是 anthropic、实际装配的是 mock；此时若拿意图去
     * `setDefault('anthropic')` 会抛「未注册」——正是要避免的静默/误导。
     */
    let chosenProviderId: string

    // 1) 其他（非默认）Provider
    const builtIds = new Set<string>()
    const pushBuilt = (plugin: AgentPlugin | undefined, id: string) => {
      if (!plugin || builtIds.has(id)) return
      builtIds.add(id)
      providerPlugins.push(plugin)
    }
    for (const pc of providerConfigs) {
      // 默认实例只在下面构造一次（避免同一 id 出现两个实例、互相覆盖注册键）
      if (defaultPc && pc.id === defaultPc.id) continue
      pushBuilt(await this.buildProviderPlugin(pc), pc.id)
    }

    // 2) 默认 Provider 的实例
    if (defaultPc) {
      // 默认 Provider 的默认模型优先取 --model / config.model 指定的模型（去 provider 前缀）
      const defaultModel = parseModelSpec(this.options.model ?? '').modelId || defaultPc.model
      const plugin = await this.buildProviderPlugin({ ...defaultPc, model: defaultModel })
      if (!plugin) {
        this.emitNotice(makeNotice('provider.construct-failed', { providerId: defaultProviderId }))
        chosenProvider = await lazyMockProvider({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
        chosenProviderId = 'mock'
      } else {
        chosenProvider = plugin as any
        chosenProviderId = defaultPc.id
      }
    } else if (defaultProviderId === 'mock') {
      chosenProvider = await lazyMockProvider({
        defaultResponse: '(Mock Provider) 你好，我是测试助手。',
        ...(this.options.mockProviderConfig ?? {}),
      })
      chosenProviderId = 'mock'
    } else {
      // anthropic（或无 key 时 fallback mock）
      const envKey = typeof process !== 'undefined' ? process.env.ANTHROPIC_API_KEY : undefined
      let mergedApiKey = this.options.anthropicProviderConfig?.apiKey ?? cfg.anthropicApiKey ?? envKey
      try {
        mergedApiKey = await resolveSecret(mergedApiKey, cipher)
      } catch (err: any) {
        this.emitNotice(makeNotice('config.secret-unresolved', { message: err?.message ?? String(err) }))
        throw new ConfigValidationError(err?.message ?? String(err))
      }
      const mergedAnthropic = {
        ...(this.options.anthropicProviderConfig ?? {}),
        apiKey: mergedApiKey,
        defaultModel: this.options.anthropicProviderConfig?.defaultModel ?? (parseModelSpec(this.options.model ?? '').modelId || undefined),
      }
      const hasKey = !!mergedAnthropic.apiKey
      if (hasKey && (defaultProviderId === 'anthropic' || this.options.provider === undefined)) {
        chosenProvider = await lazyAnthropicProvider(mergedAnthropic)
        chosenProviderId = 'anthropic'
      } else if (hasKey && defaultProviderId !== 'anthropic') {
        // 默认 provider 是自定义 id 但未在 providers 中配置 → 提示并 fallback mock
        this.emitNotice(makeNotice('provider.fallback-mock', { requested: defaultProviderId, reason: 'not-configured' }))
        chosenProvider = await lazyMockProvider({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
        chosenProviderId = 'mock'
      } else {
        this.emitNotice(makeNotice('provider.fallback-mock', { requested: 'anthropic', reason: 'no-key' }))
        chosenProvider = await lazyMockProvider({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
        chosenProviderId = 'mock'
      }
    }
    providerPlugins.push(chosenProvider)
    // 明确输出启动时装配的默认 Provider（不触碰 lazy getter，直接用已解析的配置信息）
    const cpId = defaultProviderId === 'mock'
      ? 'mock'
      : defaultPc?.id ?? 'anthropic'
    this.emitNotice(makeNotice('provider.default-chosen', {
      configured: defaultProviderId,
      actual: cpId,
      // 标签由 renderNotice 从 type/model 现算（与搬迁前那段三元表达式逐字相同）；
      // 非自定义默认（mock / anthropic）不带这两个字段 —— 渲染出的就是「（测试 Mock）」或空标签。
      ...(cpId !== 'mock' && defaultPc?.type
        ? { type: defaultPc.type, model: parseModelSpec(this.options.model ?? '').modelId || defaultPc.model }
        : {}),
    }))
    // 内置（随应用打包）通用插件：经 BuiltinPluginRegistry 统一惰性加载
    const toolsBuiltin = await getBuiltinRegistry().get('tools-builtin')!.load()
    providerPlugins.push(toolsBuiltin)
    const toolsManager = await getBuiltinRegistry().get('tools-manager')!.load()
    providerPlugins.push(toolsManager)
    const managePlugin = await getBuiltinRegistry().get('manage-plugin')!.load()
    providerPlugins.push(managePlugin)
    // 薄壳插件：/workspace 查看工作区布局（依赖 cli 注入的 workspace，见 cmdInput.workspace）
    providerPlugins.push(createWorkspacePlugin())
    // 薄壳插件：/revert 文件快照回滚（依赖 cli 注入的 snapshotService 与 harness.session/bus，见 cmdInput）
    providerPlugins.push(createRevertPlugin())
    // 薄壳插件：/snapshot 快照信息命令（依赖 cli 注入的 snapshotService，见 cmdInput）
    providerPlugins.push(createSnapshotPlugin())
    // 内置插件声明式启用（config.json → plugins）：与外部插件目录并列的第二条装配路径，
    // 让「只想开个内置能力」的用户改一行配置即可（依赖闭包自动补齐，如 computer-use → mcp.server-registry）。
    // 这里只解析实例，实际入列在外部插件之后（见下方按 id 去重），避免与 .harness/plugins 里的同 id 重复安装。
    const declaredPlugins = await resolveBuiltinPlugins(cfg.plugins)
    if (declaredPlugins.unknown.length) {
      this.emitNotice(makeNotice('config.plugins-inactive', {
        unknown: declaredPlugins.unknown,
        available: getBuiltinRegistry().list().map((p) => p.id),
      }))
    }
    // ACP 上下文压缩：config.json → compression.enabled 为真时才惰性装配 @harness/acp-context。
    // 上下文窗口推导优先级：compression.modelContextLimit → 默认 Provider 的 contextWindowTokens → 插件默认 200_000；
    // t1/t2/t3 阈值与层保留从结构化字段翻译进 kernel config。
    const compression = cfg.compression
    // 未生效项告警（未知键被静默丢弃 / tokenCalibration 拼错静默降级）：
    // 放在 enabled 判断之外 —— 开关关着时恰好是「照抄参数表却怎么也不生效」最常发生的场景。
    const compressionIssues = checkCompressionConfig(compression)
    if (compressionIssues.length) {
      this.emitNotice(makeNotice('config.compression-inactive', { items: compressionIssues }))
    }
    // 会话压缩（另一套机制）：同样会因未知键 / 拼错取值静默失效；
    // 额外的「阈值 ≥ 窗口 ⇒ 永不触发」检查尤其重要 —— 它没有任何其它症状。
    const compactionIssues = checkCompactionConfig(cfg.compaction)
    const compactionUnreachable = checkCompactionReachability(cfg, defaultProviderId)
    if (compactionIssues.length || compactionUnreachable) {
      const all = compactionUnreachable ? [...compactionIssues, compactionUnreachable] : compactionIssues
      this.emitNotice(makeNotice('config.compaction-inactive', { items: all }))
    }
    if (compression?.enabled) {
      const acp = await lazyImport<{ createAcpContextPlugin: (o?: any) => AgentPlugin }>('@harness/acp-context')
      // 与档位段（`subagent` / `perAgent`）**共用同一份翻译**：此前顶层在这里内联写一遍、
      // 档位那边再写一遍，两套语法一旦漂移就是"顶层这么写生效、档位那样写不生效"。
      const acpConfig = toAcpConfig(compression)
      // 遥测默认开启：每轮 preModel 追加 dataDir/sessions/{sessionId}.telemetry.jsonl
      const telemetryEnabled = compression.telemetry?.enabled !== false
      const sessionsDir = join(this.workspace.dataDir, 'sessions')
      providerPlugins.push(acp.createAcpContextPlugin({
        // 只传「用户显式指定」的窗口（`compression.modelContextLimit`），压过按端点的推导。
        // 缺省刻意留 undefined —— 若把默认 Provider 推导出的窗口塞进这里，它会在窗口解析链上
        // 截胡，下面那条按端点分化的腿永远走不到（那正是本次要修的 bug）。
        modelContextLimit: compression.modelContextLimit,
        // 占用率分母按**本会话实际用的端点**解析：子 Agent 常被派到另一个 Provider（也可被
        // `SubagentTool.model` 逐次覆盖），两端窗口不同时分母必须跟着走。都查不到时回落
        // `fallback` = 改造前那个数，故缺省行为逐位不变。
        providerWindows: buildProviderWindowTable(cfg, defaultProviderId),
        systemPrompt: compression.systemPrompt,
        prompts: compression.prompts as any,
        config: acpConfig as any,
        // autoTune：按窗口推导 compression/nudge 参数（显式字段仍优先，见 compression.autoTune 注释）
        autoTune: compression.autoTune === true,
        // token 折算口径：缺省 auto（CJK 感知），与内核内部计数共用同一函数
        tokenCalibration: compression.tokenCalibration,
        tokenCalibrationScale: compression.tokenCalibrationScale,
        // 压缩提示注入策略（顶层）。另有一条能力判据与它叠加：该 Agent 白名单里确实没有
        // compress 时一律不注入（只读 worker 拿着手册只会去撞 TOOL_NOT_ALLOWED）。
        manualInjection: compression.manualInjection,
        // 窗口保护闸（B3）：按**真实占用率**（折叠后）四档处置，与 autoCompact 的原文口径并存。
        // 形状与插件侧 `WindowGuardConfig` 一致 ⇒ 直接透传，不经 `toAcpConfig`（那不是内核 config，
        // 喂给内核只会被 `defaultConfig` 静默丢掉）。
        windowGuard: compression.windowGuard,
        // 作用域档位：subagent（按 parentId，即子会话）/ perAgent（按 agent id）。
        // 两者都不配置时不传 ⇒ 插件侧不叠加，缺省行为与改造前逐位一致。
        subagent: toAcpScope(compression.subagent) as never,
        perAgent: toAcpScopeMap(compression.perAgent) as never,
        telemetryEnabled,
        telemetryPathBuilder: telemetryEnabled
          ? (sessionId: string) => join(sessionsDir, `${sessionId}.telemetry.jsonl`)
          : undefined,
      }))
    }
    // 其余能力一律通过外部插件目录（~/.harness/plugins、.harness/plugins）可插拔加载，
    // CLI 不做硬编码依赖（避免依赖倒置）：此处 externalPlugins 来自 loadPluginDirs（user → project）。
    if (externalPlugins.plugins.length) providerPlugins.push(...externalPlugins.plugins)
    // 长期记忆：`plugins: ["memory"]` 启用，`memory` 段覆盖参数 —— 目前唯一"带参装配"的内置插件。
    //
    // 位置刻意是「外部插件目录之后、declaredPlugins 之前」：外部插件已入列 ⇒ 下面的按 id 去重会
    // 跳过注册表那份（保持"外部插件目录优先"的既有语义，便于临时替换实现）；参数则来自 config.json，
    // 不在组合根写死 —— 与 compression → acp-context 同一模式，不违背"无参工厂"的初衷。
    const memoryCfg = cfg.memory
    const memoryDeclared = (cfg.plugins ?? []).some((id) => String(id).trim() === 'memory')
    if (memoryDeclared && !providerPlugins.some((p) => p.id === 'memory')) {
      const memoryMod = await lazyImport<{ createMemoryPlugin: (o?: Record<string, unknown>) => AgentPlugin }>(
        '@harness/memory',
      )
      providerPlugins.push(memoryMod.createMemoryPlugin(memoryPluginOptions(memoryCfg)))
    } else if (memoryCfg && !memoryDeclared) {
      this.emitNotice(makeNotice('config.memory-not-enabled', undefined))
    }
    const memoryIssues = checkMemoryConfig(memoryCfg)
    if (memoryIssues.length) {
      this.emitNotice(makeNotice('config.memory-inactive', { items: memoryIssues }))
    }
    // 通用遥测：config.json → telemetry 段存在才装配 @harness/telemetry（默认零影响）。
    // 会话级 JSONL 采集（bus 事件 → 统一 envelope）+ 崩溃兜底。dataDir 用 CLI 实际 workspace，
    // 避免路径口径分裂（--data-dir 时 core 自推导会拼错目录）。
    const telemetryOpts = telemetryPluginOptions(cfg.telemetry)
    if (telemetryOpts) {
      const telMod = await lazyImport<{
        createTelemetryService: (o?: Record<string, unknown>) => { plugin: AgentPlugin }
      }>('@harness/telemetry')
      providerPlugins.push(
        telMod.createTelemetryService({ dataDir: this.workspace.dataDir, ...telemetryOpts }).plugin,
      )
    }
    const telemetryIssues = checkTelemetryConfig(cfg.telemetry)
    if (telemetryIssues.length) {
      this.emitNotice(makeNotice('config.telemetry-inactive', { items: telemetryIssues }))
    }
    // config.json → plugins 声明的内置插件：与外部插件目录按 id 去重（外部插件目录优先，便于临时替换实现）
    if (declaredPlugins.plugins.length) {
      const present = new Set(providerPlugins.map((p) => p.id))
      for (const p of declaredPlugins.plugins) if (!present.has(p.id)) providerPlugins.push(p)
    }
    if (this.options.extraPlugins?.length) providerPlugins.push(...this.options.extraPlugins)

    // 登记「可管理」插件（/plugins enable 需要对象引用重新安装）：
    // 排除 core 内置工具插件（toolsBuiltin）与后续由 core 内部注册的 core.*（skill-injection 等），
    // 仅管理用户装配的 Provider / 插件目录 / extraPlugins。
    this.pluginRegistry.clear()
    for (const p of providerPlugins) {
      if (p.id === toolsBuiltin.id) continue
      this.pluginRegistry.set(p.id, p)
    }

    // 创建 Harness
    const harness = await createHarness({
      cwd: this.options.cwd,
      // 工作区路径视图交给插件（记忆/技能目录定位）：CLI 的 dataDir 可能来自 --data-dir，
      // 让 core 自己 resolve 会算错 ⇒ 传实际 workspace，避免路径口径分裂。
      workspace: this.workspace,
      defaultAgentId: this.options.agentId,
      internalPlugins: providerPlugins,
      agents: [this.defaultAgent(), ...(this.options.agents ?? [])],
      // Agent 多级加载：user 全局目录在前，project 项目目录在后（后者覆盖前者）
      agentDirs: [
        { dir: this.workspace.user.agents, source: 'user' },
        this.workspace.project.agents,
      ],
      // Skill 多级加载：user 全局目录在前，project 项目目录在后（后者覆盖前者）
      skillDirs: [
        { dir: this.workspace.user.skills, source: 'user' },
        this.workspace.project.skills,
      ],
      permission: perm,
      // token 折算口径：与 acp-context 传的是**同一个值**（引擎侧用量估算与 ACP 占用率闸门
      // 必须用同一把尺子，否则"本地 vs provider"的偏差无法归因）
      tokenCalibration: compression?.tokenCalibration,
      tokenCalibrationScale: compression?.tokenCalibrationScale,
      snapshot: this.snapshotService ? () => this.snapshotService! : undefined,
      // 上下文压缩·阶段二（Route B）：宿主注入原文档案存储器，compact 裁剪前把被压缩窗口原文落盘到
      // sessions/{id}.cmp.orig/，供惰性 loader 按块还原全文（内存瘦身 + 全文可回溯）。
      originalStore: createWorkspaceOriginalStore(this.workspace),
      logger: {
        // info/debug → 装配期 notice 通道（verbose 门控已移进 emitNotice，行为与改造前一致）；
        // warn/error → 运行期 emitLog。两条通道的分工见 emitNotice 的注释。
        info: (msg, meta) => this.emitNotice(makeNotice('log.info', { message: msg, meta })),
        warn: (msg, meta) => this.emitLog('warn', msg, meta),
        error: (msg, meta) => this.emitLog('error', msg, meta),
        debug: (msg, meta) => this.emitNotice(makeNotice('log.debug', { message: msg, meta })),
      },
    })
    // 显式指定默认 Provider —— 不再依赖「最后注册赢」的注册顺序。
    // 各 Provider 插件在 core.harness.init 里只 register、不 setDefault（默认是组合根的决定），
    // 这样「只追加一个实例、不动默认」才成为可能。见 docs/runtime-registration-plan.md §2.1/§2.2。
    if (harness.providers.get(chosenProviderId)) {
      harness.providers.setDefault(chosenProviderId)
    } else {
      // 不静默：setDefault 是唯一入口，落空说明「装配」与「预期默认」不一致
      this.emitNotice(makeNotice('provider.default-not-registered', { providerId: chosenProviderId }))
    }
    // 回读 config.json 的 agents[] 覆盖（tools 白名单 + mcpServers/excludeMcpServers）到已注册 Agent（createHarness 全部组装完成后、query 前）
    await this.applyConfigAgentOverrides(harness)
    // 把 config.json 的 mcpServers 注入 mcp-server-registry 插件（在 start 前建立配置态，
    // 由 core.harness.start 按 enabled 开关连接外部 MCP server）。
    await this.applyMcpServers(harness)
    await harness.start()
    this.harness = harness

    // 多级加载 L2：boot 末尾后台静默预加载内置插件/工具（fire-and-forget，
    // allSettled，失败仅记录日志，不阻塞 boot、不向上抛错）。
    this.scheduleBuiltinPreload()

    // 会话：显式指定 > 自动恢复上次 > 新建
    const sm = harness.session
    let session: Session
    const sid = this.options.sessionId
    if (sid) {
      const saved = await this.sessionStore.load(sid)
      if (saved) {
        session = await this.restoreSession(saved)
        this.sessionRestore = {
          source: 'explicit',
          sessionId: session.id,
          messageCount: saved.messages.length,
          updatedAt: saved.updatedAt,
        }
      } else {
        // 指定了 id 但磁盘上不存在：沿用原语义建一个「同名」会话（用于预置 id 的场景）
        session = await sm.create({ title: sid, agentId: this.options.agentId, cwd: this.options.cwd })
        await sm.setId(session.id, sid)
        this.sessionRestore = { source: 'explicit', sessionId: session.id }
      }
    } else {
      const pick = await this.pickResumeCandidate()
      if (pick.kind === 'hit') {
        session = await this.restoreSession(pick.saved)
        this.sessionRestore = {
          source: 'auto',
          sessionId: session.id,
          messageCount: pick.item.messageCount,
          updatedAt: pick.item.updatedAt,
        }
      } else {
        session = await sm.create({ agentId: this.options.agentId, cwd: this.options.cwd })
        this.sessionRestore = { source: 'new', sessionId: session.id, ...(pick.skipped ? { skipped: pick.skipped } : {}) }
      }
    }
    // 落盘：**0 消息的新会话不落盘**。
    //
    // boot 无条件 `save` 曾让每个"启动过、没聊"的宿主在磁盘上留下一个 194 字节空壳，
    // 实测积到 **499 个**（`/sessions` 列表被灌满，每次 `list()` 都要把它们逐个读一遍；
    // 而它们既无 title/meta、也没有同名 telemetry —— 是纯噪音）。服务端形态尤其密集：
    // VSCode 每 spawn 一次 A2A 侧车就 boot 一次，一次一个。
    //
    // 不落盘不会丢内容：真正该存的那次由每轮结束的 `flushDirtySessions()` 补上（按"标脏"
    // 驱动，聊过就一定存），`/sessions` 从第一条消息起照常可见。恢复出来的会话本就有消息，
    // 走的是同一个判断，行为不变。
    if (session.messages.length > 0) await this.sessionStore.save(session)
    // 记下「本工作目录下次要恢复的会话」：无论是显式 -s、自动恢复还是新建，
    // 都要把指针指向本次实际在用的这条，否则下次启动会回到更早的会话。
    //
    // 例外：**服务端形态（`autoResume:false`，A2A / VSCode 侧车）不写指针**。这条前提
    // 在它身上不成立 —— 这类 boot 每次都会新建一条一次性会话（会话由 A2A 的 `contextId`
    // 显式寻址，恢复不靠 cwd 指针），却把它写成"本目录上次会话"。实测后果：侧车启动一次
    // 就把 CLI 的指针指到一个 0 消息的空壳（`s_1791382595159_sopo1`），下次 `harness run`
    // 自动恢复出的是空会话。`autoResume` 是宿主显式声明的"我是服务端"，正好是这条判据。
    if (this.options.autoResume !== false) await this.rememberSession(session)

    // 平铺属性（Host 契约）：与 `boot()` 的返回是同一个实例的两个访问路径，
    // 供 A2A / VSCode 这样"先 createHost 再随时取"的宿主用（CLI main 仍解构 boot 的返回）。
    this.session = session

    return { harness, session }
  }

  /**
   * 把磁盘会话还原为运行中的 Session。
   *
   * SessionManager 接口没有批量 restore，只能 `create` 一个新会话 → 逐条 `addMessage`
   * → 再 `setId` 把临时 id 换成磁盘里的原 id（setId 会同步内部索引键）。
   * boot 的显式恢复与 `/resume` 共用这一份实现，避免两处各写一遍、各自漏掉压缩块。
   */
  async restoreSession(saved: SessionFile): Promise<Session> {
    const sm = this.harness.session
    const session = await sm.create({
      title: saved.title,
      agentId: saved.agentId,
      cwd: saved.cwd ?? this.options.cwd,
      meta: saved.meta,
      ...(saved.parentId ? { parentId: saved.parentId } : {}),
    })
    for (const m of saved.messages) await sm.addMessage(session.id, m)
    await sm.setId(session.id, saved.id)
    // 上下文压缩·阶段二（Route B）：恢复压缩块并注册惰性加载器，供 /history 等按需读盘还原被压缩原文
    if (saved.blocks?.length) {
      session.blocks = saved.blocks
      sm.setHistoryLoader(session.id, { load: (s, range) => this.loadFullHistory(s, range) })
    }
    return session
  }

  /**
   * 找出「本工作目录上次用的会话」。
   *
   * 判定顺序：
   * 1. **项目级指针** `<cwd>/.harness/last-session.json`（权威）。会话 id 就写在当前工作
   *    目录里，所以「哪个目录恢复哪条会话」由文件位置决定——不需要拿 cwd 字符串互相比对，
   *    符号链接 / 相对路径 / 大小写差异都不会让判定漂移，也不会跨目录串台。
   *    指针另带 `dataDir`：同一 cwd 换 `--data-dir` 启动时，sessionId 撞号也不会把
   *    另一个 dataDir 的会话恢复出来（旧指针无该字段 → 兼容照常返回）。
   * 2. **兜底**：全局 sessions 里 cwd 与本目录一致的最新一条。只为兼容「指针出现之前建的
   *    会话」；命中后 boot 会把它写进指针，此后一律走 1。
   *
   * 两处返回 undefined 的语义都是「本目录没有可恢复的会话」，调用方按新建处理。
   */
  async findResumeTarget(): Promise<
    { id: string; updatedAt: number; messageCount: number; cwd?: string; saved: SessionFile } | undefined
  > {
    // 指针绑定了 dataDir：同 cwd 换 --data-dir 时不该把另一个 dataDir 的会话恢复出来
    // （sessionId 形如 s_<ts>_<5位随机>，理论上可能撞号）。旧指针无 dataDir 字段 → 兼容照常返回。
    const pointer = await this.sessionPointer.readIfOwnedBy(this.workspace.dataDir)
    if (pointer) {
      const saved = await this.sessionStore.load(pointer.sessionId)
      // 指针里的会话文件不见了（被删 / 换了 dataDir）就往下走兜底，别让启动卡在一个坏指针上
      if (saved) {
        // 指针只校验了「dataDir 归属」，没校验「会话自己的 cwd」：把 .harness/ 整目录复制到
        // 别处后，在新目录启动会恢复出旧目录的会话（跨目录串台）。这里再比对 saved.cwd 与当前
        // cwd，不一致（含旧会话 saved.cwd 为 undefined）就**不**从指针分支返回，落到同 cwd 兜底
        // 分支——rememberSession 只在会话属于当前目录时才写指针，两边语义要对齐，复制目录不该串台。
        if (resolve(saved.cwd ?? '') === this.workspace.cwd) {
          return {
            id: saved.id,
            updatedAt: saved.updatedAt,
            messageCount: saved.messages.length,
            cwd: saved.cwd,
            saved,
          }
        }
      }
    }
    const list = await this.sessionStore.list()
    const cwd = this.workspace.cwd
    const hit = list.find((s) => !!s.cwd && resolve(s.cwd) === cwd)
    if (!hit) return undefined
    const saved = await this.sessionStore.load(hit.id)
    if (!saved) return undefined
    return { id: hit.id, updatedAt: hit.updatedAt, messageCount: hit.messageCount, cwd: hit.cwd, saved }
  }

  /**
   * 把「本目录下次要恢复的会话」写进项目级指针。
   *
   * 只在会话确实属于当前工作目录时写：本目录里 `/resume` 了别的目录的会话后，不该把本目录
   * 的记录改成外目录会话——那正是「A 目录又恢复了 B 目录的会话」的来源。
   *
   * 写盘失败一律忽略（只读挂载、权限不足等）：这是启动路径上的记录动作，不能因为它
   * 把整个 boot 拖挂。失败时下次启动退回「同 cwd 兜底」，功能仍在。
   */
  async rememberSession(session: Session): Promise<void> {
    const cwd = this.workspace.cwd
    if (resolve(session.cwd ?? cwd) !== cwd) return
    try {
      await this.sessionPointer.write(session.id)
    } catch { /* 指针写不动不影响本次会话 */ }
  }

  /**
   * 挑「上次会话」用于自动恢复。
   *
   * 命中判定交给 findResumeTarget（指针优先、同 cwd 兜底）。没命中时把「全局最近的会话」
   * 原样回报给调用方：这样提示能说清是「目录不同」还是「被 --no-resume 关掉了」，而不是
   * 让用户对着一个空会话猜。
   */
  private async pickResumeCandidate(): Promise<
    | { kind: 'hit'; item: { id: string; updatedAt: number; messageCount: number; cwd?: string }; saved: SessionFile }
    | { kind: 'miss'; skipped?: SessionRestoreInfo['skipped'] }
  > {
    const autoResume = this.options.autoResume !== false
    const list = await this.sessionStore.list()
    if (list.length === 0) return { kind: 'miss' }
    const newest = list[0]
    if (!autoResume) {
      return { kind: 'miss', skipped: { id: newest.id, cwd: newest.cwd, updatedAt: newest.updatedAt, reason: 'disabled' } }
    }
    const target = await this.findResumeTarget()
    if (!target) {
      return { kind: 'miss', skipped: { id: newest.id, cwd: newest.cwd, updatedAt: newest.updatedAt, reason: 'other-cwd' } }
    }
    return { kind: 'hit', item: target, saved: target.saved }
  }

  /** 发送一次用户消息，得到 assistant Message（内部持久化） */
  async send(sessionId: string, text: string): Promise<Message> {
    const h = this.harness
    // 通过 harness.session.prompt 发送，内部会写入消息 + 调用 agent.query
    const assistant = await h.session.prompt(sessionId, text)
    const sess = (await h.session.get(sessionId))!
    await this.sessionStore.save(sess)
    return assistant
  }

  /**
   * 上下文压缩·阶段二（Route B）：按需读盘还原被压缩原文的全文历史。
   * 以会话「近期消息 + blocks」为骨架，经 originalStore 逐块取回被压缩窗口原文，
   * 再与近期合并、去重排序得到全文；可选按 range（startId/endId/blockIds）过滤。
   * 无 blocks 或读盘失败时 best-effort 返回近期消息，不阻断调用方。
   */
  async loadFullHistory(sessionId: string, range?: HistoryLoadRange): Promise<Message[]> {
    const h = this.harness
    const sess = await h.session.get(sessionId)
    if (!sess) return []
    if (!sess.blocks?.length) return range ? this.filterByRange([...sess.messages], range) : [...sess.messages]
    const originalStore: SessionOriginalStore = createWorkspaceOriginalStore(this.workspace)
    // 统一块模型：generic 块经 originalStore(.cmp.orig)，acp 块经 session.meta[acp.archive.v1] 还原
    const acpArchive = (sess.meta?.['acp.archive.v1'] ?? {}) as Record<string, Message>
    const resolveBlock = async (block: CompactionBlock): Promise<Message[]> => {
      if (block.source === 'acp' && Object.keys(acpArchive).length > 0) {
        return resolveAcpBlockOriginals(acpArchive, block)
      }
      return buildResolveBlock(originalStore, sessionId)(block)
    }
    const full = await reconstructHistory(sess, resolveBlock)
    // 阶段四·按需渲染：blockIds 存在时只返回命中块的原文段（压缩提示行惰性展开用）
    if (range?.blockIds?.length) {
      const wanted = new Set(range.blockIds)
      const parts: Message[] = []
      for (const b of sess.blocks ?? []) {
        if (!wanted.has(b.id)) continue
        parts.push(...(await resolveBlock(b)))
      }
      return parts
    }
    return range ? this.filterByRange(full, range) : full
  }

  /** 供 /revert 注入的会话全文回溯器（统一块模型）：经 loadFullHistory 还原） */
  private getFullHistory = (sessionId: string): Promise<Message[]> =>
    this.loadFullHistory(sessionId)

  /** 按 range（startId/endId/blockIds）过滤消息列表 */
  private filterByRange(
    messages: Message[],
    range: HistoryLoadRange,
  ): Message[] {
    let out = messages
    if (range.blockIds?.length) {
      // 块级过滤经 reconstructHistory 无法直接映射原文，此处忽略 blockIds（按时间范围兜底）
      void range.blockIds
    }
    if (range.startId || range.endId) {
      const startIdx = range.startId ? out.findIndex((m) => m.id === range.startId) : -1
      const endIdx = range.endId ? out.findIndex((m) => m.id === range.endId) : out.length - 1
      const from = startIdx >= 0 ? startIdx : 0
      const to = endIdx >= 0 ? endIdx : out.length - 1
      out = out.slice(from, to + 1)
    }
    return out
  }

  /**
   * 流式发送：逐事件 yield AgentStreamEvent，完成后自动持久化 session。
   * `signal` 用于中断（引擎会在步边界与每个工具执行前响应它）。
   */
  /**
   * 落盘所有「脏会话」（自上次保存以来有变更的会话）。
   *
   * 设计（缺陷修复：子 agent 会话不落盘）：
   * - 只保存有变化的会话（DefaultSessionManager 在 create / addMessage / updateMeta 等变更时统一标脏），
   *   不无脑全量保存，避免子会话文件每轮被反复重写放大 IO；
   * - 子会话是 subagent 插件内部 `harness.session.create()` 出来的、不在 CLI 持有的列表里，
   *   但同属 DefaultSessionManager，标脏后这里一并保存 —— 子会话的消息与 meta（含 usageStats）随之落盘；
   * - 落盘失败绝不能让 agent 跑挂（可观测性增强）：单条失败仅告警，并重新标脏以便后续重试。
   */
  async flushDirtySessions(): Promise<void> {
    let dirty: Session[] = []
    try {
      dirty = this.harness.session.takeDirtySessions()
    } catch {
      return
    }
    if (dirty.length === 0) return
    for (const s of dirty) {
      try {
        await this.sessionStore.save(s)
      } catch (err) {
        // 可观测性增强：落盘失败不应中断主流程
        console.warn(`[WARN] 脏会话落盘失败（${s.id}）：${(err as Error)?.message ?? String(err)}`)
        try { this.harness.session.markDirty(s.id) } catch { /* ignore */ }
      }
    }
  }

  async *sendStream(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<import('@harness/core').AgentStreamEvent, void, unknown> {
    const h = this.harness
    const gen = h.session.promptStream(sessionId, text, undefined, signal)
    for await (const ev of gen) {
      yield ev
    }
    // 持久化：轮末把「有变化」的会话（含本轮主会话与期间产生的子会话）统一落盘
    await this.flushDirtySessions()
  }

  /** 关闭 harness */
  async shutdown(): Promise<void> {
    // 退出前把残留的脏会话（含子会话）兜底落盘
    await this.flushDirtySessions().catch(() => undefined)
    await this.harness.stop()
  }

  /**
   * 多级加载 L2 —— boot 末尾后台静默预加载内置插件/工具（fire-and-forget）。
   *
   * 真正的实现在 {@link warmupBuiltins}（**幂等、可 await**）：这里只是"不阻塞 boot"的那个调用形态。
   * 「A2A 服务端不预加载」（`runA2aCli` 传 `backgroundPreload:false`）曾经意味着**工具池永远是空的**，
   * 直到有人显式调 {@link warmupBuiltins} —— 这条因果见 `harness/tools.list` 的注释。
   */
  private scheduleBuiltinPreload(): void {
    if (this.options.backgroundPreload === false) return
    void this.warmupBuiltins()
  }

  /**
   * 把内置（**非 optIn**）插件补齐并组装工具池 —— **幂等**：重复调用只跑第一次。
   *
   * 为什么需要它（而不是只靠 boot 末尾那次 fire-and-forget）：
   *
   * - 「工具池已装配」这件事**不是 boot 的返回值**就能保证的。实测（`backgroundPreload:false`，
   *   即 `runA2aCli` 的形态）：`tools.list()` = **0**，`await assembleTools()` 后 = 5
   *   （只有 `tools.builtin` 的工具），把 `tools.glob/search/web/media` 也装上才到 10。
   *   也就是说"工具可列"= 「非 optIn 内置插件都装了」+「assembleTools 跑过」，缺一不可。
   * - 于是**读工具池的一方**（控制面 `harness/tools.list`、编辑器扩展的 LM 工具注册）不能依赖
   *   "启动时它跑过"：那是一个**启动顺序**依赖，A2A 服务端恰好不满足它，而失败形态是
   *   "工具池看起来是空的" —— 静默、且看起来像正常状态（空清单不该报错）。
   *
   * 幂等因此不是优化而是必要：调用点可能每读一次就调一次，装插件与组装都不该重复做。
   *
   * **不抛**：单个插件加载失败只记 notice（与原来的 fire-and-forget 同款语义）——
   * 一个插件坏了不该让整个工具池读不出来。
   */
  warmupBuiltins(): Promise<BuiltinWarmupResult> {
    this.warmupPromise ??= this.doWarmupBuiltins()
    return this.warmupPromise
  }

  private warmupPromise: Promise<BuiltinWarmupResult> | undefined

  private async doWarmupBuiltins(): Promise<BuiltinWarmupResult> {
    const result: BuiltinWarmupResult = { installed: [], failed: [], tools: 0 }
    const harness = this.harness
    const items = getBuiltinRegistry().list()
    if (!items.length || !harness) return result

    // optIn 插件（computer-use / code-intel / subagent / coordinator / swarm）只「登记」，
    // 不在此实例化：要么其工具需 mcp-client 连上才可用，要么是不该默认注入的可选能力。
    // 它们的启用路径是 config.json → plugins 声明式启用，或外部插件目录显式装配。
    const loadable = items.filter((p) => !p.optIn)
    const results = await Promise.allSettled(loadable.map((p) => p.load()))
    const installedIds = new Set(harness.plugin.list().map((lp) => lp.plugin.id))
    const toInstall: AgentPlugin[] = []
    for (let i = 0; i < loadable.length; i++) {
      const item = loadable[i]!
      const r = results[i]!
      if (r.status === 'rejected') {
        result.failed.push(item.id)
        this.emitNotice(makeNotice('preload.plugin-failed', {
          pluginId: item.id,
          message: (r.reason as Error)?.message ?? String(r.reason),
        }))
      } else {
        const plugin = r.value
        if (plugin && !installedIds.has(plugin.id)) toInstall.push(plugin)
        this.emitNotice(makeNotice('preload.warmed', { pluginId: item.id }))
      }
    }
    if (toInstall.length > 0) {
      try {
        await harness.plugin.loadInternal(toInstall)
        result.installed = toInstall.map((p) => p.id)
      } catch (err) {
        result.failed.push(...toInstall.map((p) => p.id))
        this.emitNotice(makeNotice('preload.install-failed', { message: (err as Error)?.message ?? String(err) }))
      }
    }
    try {
      await harness.assembleTools()
      result.tools = harness.tools.list().length
    } catch (err) {
      this.emitNotice(makeNotice('preload.tools-failed', { message: (err as Error)?.message ?? String(err) }))
    }
    return result
  }

  get _harness(): Harness { return this.harness }
}

/**
 * 统一块模型·ACP 原文取回：从 session.meta[acp.archive.v1]（coreId → Message）中，
 * 还原被某 ACP 折叠块（source:'acp'）覆盖的原文。
 * 归档记录保持消息插入序，故按 startId/endId 定位切片；id 不存在/范围非法时返回空
 * （加载方回退到 buildResolveBlock 的通用兜底，最终退化为仅摘要，不阻断）。
 */
function resolveAcpBlockOriginals(
  archive: Record<string, Message>,
  block: CompactionBlock,
): Message[] {
  const ordered = Object.values(archive).filter((m): m is Message => !!m && typeof m.id === 'string')
  const startIdx = ordered.findIndex((m) => m.id === block.startId)
  const endIdx = ordered.findIndex((m) => m.id === block.endId)
  if (startIdx < 0 || endIdx < startIdx) return []
  return ordered.slice(startIdx, endIdx + 1)
}

/**
 * `Host` 契约 —— **即 `HarnessHost` 的公开面**。
 *
 * 有意不另立一个 interface：那是把同一份 56 个成员写两遍（名称、签名、只读性各维护一次），
 * 正是本仓"同一个东西两套写法"的老病 —— 而且这种重复的漂移是静默的（interface 不会因为
 * class 改了而报错，除非有人用 `implements` 且恰好跑到）。`type` 别名让两者**定义上**同一。
 *
 * 消费方（A2A / VSCode）只依赖这个类型：`const host: Host = await createHost({...})`。
 */
export type Host = HarnessHost

/** 装配 + 启动，一步到位（A2A / VSCode 的入口；CLI 保留 `new` + `boot()` 两步以兼容既有调用点） */
export async function createHost(options: HostOptions): Promise<Host> {
  const host = new HarnessHost(options)
  await host.boot()
  return host
}
