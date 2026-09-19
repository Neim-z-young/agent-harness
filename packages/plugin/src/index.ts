/**
 * @harness/plugin - 插件管理
 *
 * 结合 OpenCode Hooks 流水线 + Claude Code 多来源插件加载。
 *
 * 三级插件加载顺序：
 * 1. Internal 内置插件（硬编码）
 * 2. Builtin 默认插件（npm 白名单）
 * 3. User 用户插件（配置文件指定，支持 file:///）
 * 每一级内部按 dependsOn 拓扑排序
 *
 * Hooks 命名规范：域.动作 格式（如 tool.pre.execute、session.compacting）
 */

import type { Awaitable, Bus, BusEventRecord } from '@harness/bus'

// ===== PluginContext =====

/**
 * 插件安装上下文
 * 由 PluginManager 在 install() 时注入
 */
/**
 * 宿主工作区路径视图（只读）。
 *
 * 刻意**不** import `@harness/workspace` 的类型：该包依赖 `@harness/session`，
 * 而契约层要保持"只依赖 bus"的轻量依赖方向。这里用结构化最小接口，
 * `Workspace` 对象在结构上可直接赋值（TS 结构化类型），因此不会漏字段 ——
 * 若 workspace 包改了字段名，赋值处会编译报错。
 *
 * 存在意义：插件在 `install(ctx)` 与 `session.preModel` / `prompt.system.transform`
 * 等**每轮 hook** 里都需要知道"记忆/技能该写到哪、该从哪读"。此前插件只能拿
 * `process.cwd()` 猜，而 CLI 支持 `--cwd` / `--data-dir` ⇒ 会拼错目录
 * （本项目已两次栽在"路径口径分裂"上）。
 */
export interface PluginWorkspaceView {
  /** 工作目录（绝对路径） */
  cwd: string
  /** 用户级数据根（缺省 ~/.harness） */
  dataDir: string
  user: { root: string; plugins: string; skills: string; agents: string; memory: string }
  project: { root: string; plugins: string; skills: string; agents: string; memory: string }
}

export interface PluginContext {
  /** Bus 事件总线（发布/订阅事件） */
  bus: Bus
  /** 配置访问 */
  config: {
    get<T>(key: string): T | undefined
    set<T>(key: string, value: T): void
  }
  /** 日志器 */
  log: {
    info(msg: string, meta?: unknown): void
    warn(msg: string, meta?: unknown): void
    error(msg: string, meta?: unknown): void
    debug(msg: string, meta?: unknown): void
  }
  /**
   * 宿主工作区路径（core 注入；缺省时插件须自行回退）。
   *
   * 可选是刻意的：`createPluginManager` 可被独立使用（单测、非 CLI 宿主），
   * 此时没有 workspace —— 插件应把它当作"路径未知"而不是崩溃。
   */
  workspace?: PluginWorkspaceView
}

// ===== Tool Pool =====

/**
 * 工具池（组装阶段使用）
 * 由 Agent Runtime 构造，插件通过 hook 注入/移除工具
 */
export interface ToolPool {
  /** 添加工具 */
  add(tool: unknown): void
  /** 批量添加 */
  addAll(tools: unknown[]): void
  /** 条件添加（不存在时才加） */
  addIfMissing(toolIds: string[]): void
  /** 移除工具 */
  remove(toolId: string): void
  /** 列出所有工具 */
  list(): unknown[]
}

// ===== Hook 输入/输出类型 =====

export interface HarnessInitInput {
  harnessOptions: unknown
}
export interface HarnessInitOutput {
  harness?: unknown
}

export interface HarnessStartInput {
  harness: unknown
}
export interface HarnessStartOutput {
  started: boolean
}

export interface ToolPoolAssembleInput {
  agentId: string
}

export interface LLMInput {
  providerId: string
  modelId?: string
  messages: unknown[]
}

export interface LLMParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  [key: string]: unknown
}

export interface PromptInput {
  agentId: string
  sessionId: string
  /**
   * 该 Agent 的模式（`primary` / `subagent` / `coordinator` / `teammate`…）。
   *
   * 供 prompt 构建类插件按 agent 类型分流 —— 典型用法：主会话的记忆**不注入子 Agent**
   * （对齐 Claude Code 的 subagent 隔离语义）。此前 hook 只给 agentId，
   * 插件还得自己查注册表（且拿不到），只能在首轮猜。
   */
  agentMode?: string
}

export interface CompactionContext {
  /** 保留最近 N 条消息（插件可改写） */
  keepLast?: number
  /** 摘要策略（插件可改写；`prune` 表示仅删除不写摘要） */
  strategy?: 'prune' | 'summary' | 'agent'
  /** 摘要内容（输出；插件若已提供则 core 不再自行生成） */
  summary?: string
  /**
   * 待压缩窗口（将要被删除的消息，只读参考）。core 会在真正删除前的
   * `session.compacting` hook 里传入，供 ACP 等插件在删除前保全原文。
   * 语义为只读：插件不应修改该数组（core 之后会按 keepLast 重算并存取）。
   */
  window?: readonly unknown[]
  /**
   * 插件置 true 表示已把 window 原文保全到自身持久化（如 ACP 块/摘要文件），
   * core 可放心物理删除。非强制：未置位时 core 仅按默认行为压缩。
   */
  windowHandled?: boolean
  /**
   * 插件折叠成功后产出的压缩块（统一块模型）。
   * 输出字段：ACP 等插件把孩子折叠成新块时回传，core 将其追加到 session.blocks，
   * 与通用 compact 块一致供视图/loader/reconstructHistory/revert 消费。
   */
  blocksPatch?: {
    id: string
    topic?: string
    summary: string
    startId: string
    endId: string
    source?: 'generic' | 'acp'
    archiveRef?: string
  }[]
  /**
   * 会话 meta 访问器：与 `session.preModel` 的 meta 同义，供插件在物理删除前
   * 把窗口原文/状态持久化到 session.meta，跨重启后可回溯。只读/浅合并读写。
   */
  meta?: {
    read: () => Promise<Record<string, unknown> | undefined>
    patch: (patch: Record<string, unknown>) => Promise<void>
  }
}

/** session.preModel hook 的输入（每轮进入模型前） */
export interface SessionPreModelInput {
  /** 会话 ID */
  sessionId: string
  /** Agent ID */
  agentId: string
  /** 目标 Provider ID */
  providerId: string
  /** 目标模型 ID（可选） */
  modelId?: string
  /**
   * 把精简后的会话消息回写持久层（不含 system）。消息 object 形态由 host 决定（本项目为 Message[]）。
   */
  save: (messages: unknown[]) => Promise<void>
  /**
   * 插件本轮折叠产出的压缩块（统一块模型）。
   * 输出字段：ACP 等插件把每轮内部折叠（tier 1/2/3）的块 push 进该数组，
   * host 在 preModel hook 返回后统一合并进 session.blocks（按块 id 去重覆盖），
   * 与通用 compact 块一致供视图/loader/reconstructHistory/revert 消费。
   */
  blocksPatch?: {
    id: string
    topic?: string
    summary: string
    startId: string
    endId: string
    source?: 'generic' | 'acp'
    archiveRef?: string
  }[]
  /**
   * 会话 meta 访问器：插件可据此在 session.meta 中持久化运行时状态
   * （如 ACP 压缩状态），随会话落盘、重启后恢复。patch 为浅合并。
   */
  meta: {
    /** 读取当前会话 meta（无则 undefined） */
    read: () => Promise<Record<string, unknown> | undefined>
    /** 浅合并写入 session.meta */
    patch: (patch: Record<string, unknown>) => Promise<void>
  }
}

export interface PermissionRequestLike {
  toolKey: string
  patterns: string[]
  input: unknown
  from?: string
}

export interface PermissionDecisionLike {
  behavior: 'allow' | 'deny' | 'ask'
  updatedInput?: unknown
  remember?: boolean
}

// ===== Agent 流式事件（外部集成用） =====

/**
 * Agent 运行时状态快照。由消费层把流式事件归约而成，供集成类插件（状态上报、
 * 遥测、外部 UI 桥接）直接消费，无需各自解释原始事件。
 */
export interface AgentStatusSnapshot {
  /** Agent ID（未知时可缺省 —— 集成类插件不应假定它必然存在） */
  agentId?: string
  /** Agent 显示名（有则填） */
  agentName?: string
  /** Agent 模式（primary / subagent / teammate …，有则填） */
  mode?: string
  /**
   * 当前阶段：
   * - `idle` 等待输入（未开始或整轮已结束）
   * - `thinking` 模型推理中（含工具返回后的继续推理）
   * - `streaming` 正在收到文本增量
   * - `tool` 工具执行中（失败时也留在此态，便于显示「卡在哪个工具上」）
   * - `aborted` 被中断（Ctrl-C / 超限被拦）
   */
  phase: 'idle' | 'thinking' | 'streaming' | 'tool' | 'aborted'
  /** 当前步序号（多步循环下从 1 开始；已知时填） */
  step?: number
  /** 正在执行的工具 ID（phase=tool 时） */
  toolId?: string
  /** 结束原因（stop / tool_calls / length / content_filter / error，已知时填） */
  finish?: string
  /** 是否因外部中断而结束（区别于模型正常收尾） */
  aborted?: boolean
}

/** `agent.stream` hook 的输入 */
export interface AgentStreamSignal {
  /** 原始事件类型名（text_delta / tool_call_start / done / turn_end …），仅供排查 */
  eventType: string
  /** 归约后的当前状态 */
  status: AgentStatusSnapshot
  /** 会话 ID（外部集成可用它做会话关联/恢复） */
  sessionId?: string
}

// ===== Hooks 接口 =====

/**
 * Hooks 注册表
 * 插件通过 install() 返回此对象，介入 Harness 各生命周期
 *
 * 命名规范：域.动作 格式，支持后续新域不冲突
 */
export interface Hooks {
  // === Harness 级 ===
  /** Harness 初始化阶段（create 时） */
  'harness.init'?: (input: HarnessInitInput, output: HarnessInitOutput) => Awaitable<void>
  /** Harness 启动阶段（start 时） */
  'harness.start'?: (input: HarnessStartInput, output: HarnessStartOutput) => Awaitable<void>

  // === 工具池构建 ===
  /** 组装 Agent 工具池（可注入/移除工具） */
  'tool.pool.assemble'?: (input: ToolPoolAssembleInput, pool: ToolPool) => Awaitable<void>

  // === Tool 执行 Pipeline ===
  /** 前置 Hook：可拦截、修改输入、提前返回（中间件模式） */
  'tool.pre.execute'?: (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>
  /** 后置 Hook：可修改结果 */
  'tool.post.execute'?: (ctx: unknown, result: unknown) => Awaitable<unknown>

  // === LLM 调用链路 ===
  /** 修改 LLM 调用参数（temperature/maxTokens 等） */
  'llm.params'?: (input: LLMInput, params: LLMParams) => Awaitable<void>
  /** 修改 LLM 请求头（如注入 API key、版本号） */
  'llm.headers'?: (input: LLMInput, headers: Record<string, string>) => Awaitable<void>

  // === Prompt 构建链 ===
  /** 修改 System Prompt 片段数组 */
  'prompt.system.transform'?: (input: PromptInput, parts: string[]) => Awaitable<void>

  // === Session 生命周期 ===
  /** 会话压缩阶段 */
  'session.compacting'?: (input: PromptInput, output: CompactionContext) => Awaitable<void>
  /**
   * 每轮进入模型前 Hook：把本轮待发消息（含 system）交给插件，插件可裁剪/改写 messages 原地生效，
   * 并通过 save(messages) 把精简后的会话消息回写持久层（上下文压缩插件使用）。
   * messages 为待发消息数组，可原地 splice/push（会反映到本轮的模型请求）。
   */
  'session.preModel'?: (
    input: SessionPreModelInput,
    messages: unknown[]
  ) => Awaitable<void>

  // === Permission 扩展 ===
  /** 权限检查 Hook：可修改决策（如 teammate 桥接到 leader） */
  'permission.check'?: (
    req: PermissionRequestLike,
    decision: PermissionDecisionLike
  ) => Awaitable<void>

  // === Bus 事件订阅 ===
  /** 订阅所有 Bus 事件（用于日志、遥测、桥接） */
  'bus.event'?: (event: BusEventRecord) => Awaitable<void>

  // === Agent 流式事件（外部集成用） ===
  /**
   * Agent 执行过程中的每个流式事件，携带**归约后**的状态快照。
   *
   * 为什么带的是归约结果而不是原始事件：原始 AgentStreamEvent 是引擎内部结构
   * （text_delta / tool_call_start / done.step / turn_end 等十来种），让每个集成插件
   * 各自解释一遍既重复又容易分歧；归约器（CLI 侧）已把「现在在干什么」算清楚。
   *
   * 触发点是 **UI 消费层**（REPL / TUI / run），不是引擎 —— 没走 UI 的调用方
   * （如 subagent 的 query()）不触发，集成插件需知悉这一边界。
   */
  'agent.stream'?: (input: AgentStreamSignal) => Awaitable<void>

  // === CLI 扩展 ===
  /** 注册 CLI 斜杠命令：插件往 input.commands 追加自己的命令定义 */
  'cli.commands'?: (input: CliCommandsInput) => Awaitable<void>
  /** 处理 CLI 斜杠命令：当 REPL 收到非内置 /xxx 时触发，插件设 input.result 表示已处理 */
  'cli.command'?: (input: CliCommandInput) => Awaitable<void>
}

/** CLI 命令定义（供 /help 展示） */
export interface CliCommandDef {
  /** 命令名（不含 /，如 "mcp" → /mcp） */
  command: string
  /** 简短描述 */
  description: string
  /** 用法说明 */
  usage?: string
}

/** cli.commands hook 的输入 */
export interface CliCommandsInput {
  /** 插件往此数组追加命令定义 */
  commands: CliCommandDef[]
}

/**
 * 内置工具静态元信息条目（多级加载 L1）。
 * 由 cli 注入；工具本身（运行时模块 L2）未加载时也能据此展示描述/别名/安全声明/权限键。
 */
export interface ToolMetaEntry {
  id: string
  description?: string
  aliases?: string[]
  isReadOnly?: boolean
  isDestructive?: boolean
  isConcurrencySafe?: boolean
  permissionKey?: string
}

/** cli 注入：内置工具静态元信息访问（按 id/别名查找、列出） */
export interface ToolMetaLookup {
  get(id: string): ToolMetaEntry | undefined
  list(): ToolMetaEntry[]
}

/**
 * 工具静态元信息来源（多级加载 L1）。
 *
 * 插件包以统一契约暴露内置工具的静态元信息（描述/别名/安全声明/权限键），
 * 供 CLI 展示层（/tools、help）在不加载对应运行时工具模块（L2）的前提下提前获取。
 * CLI 只消费本抽象接口，不硬编码具体插件包的元信息导出。
 */
export interface ToolMetaSource {
  /** 来源标识（一般为插件 id / 包名） */
  id: string
  /** 来源描述（供 /tools --all 或详情视图展示） */
  description?: string
  /** 该来源提供的静态元信息列表 */
  list(): ToolMetaEntry[]
}

/** 工具静态元信息注册表（多级加载 L1）：CLI 经此抽象登记/查询内置工具元信息 */
export interface ToolMetaRegistry {
  registerSource(source: ToolMetaSource): void
  /** 按 id 或别名查找 */
  get(id: string): ToolMetaEntry | undefined
  list(): ToolMetaEntry[]
  readonly size: number
}

/** 默认内存实现：按 id（含别名）索引，登记来源时合并其元信息 */
export function createToolMetaRegistry(): ToolMetaRegistry {
  const byId = new Map<string, ToolMetaEntry>()
  return {
    registerSource(source) {
      for (const m of source.list()) byId.set(m.id, m)
    },
    get(id) {
      if (byId.has(id)) return byId.get(id)
      for (const m of byId.values()) {
        if (m.aliases?.includes(id)) return m
      }
      return undefined
    },
    list() {
      return [...byId.values()]
    },
    get size() {
      return byId.size
    },
  }
}

/** cli.command hook 的输入 */
export interface CliCommandInput {
  /** 原始命令行（不含前缀 /） */
  raw: string
  /** 命令名（第一个 token，不含 /） */
  command: string
  /** 参数部分（命令名后的剩余文本） */
  arg: string
  /** 输出函数（往终端写文本） */
  out: (text: string) => void
  /** 当前会话 ID */
  sessionId: string
  /** 处理结果：插件设为 'continue' 或 'exit' 表示已处理 */
  result?: 'continue' | 'exit'
  /**
   * cli 注入：当前 Agent ID（命令归属的 Agent）
   */
  agentId?: string
  /**
   * cli 注入：持久化某 Agent 的 tools 白名单到 config.json（upsert agents[].tools）
   * 并即时覆盖运行时；供 /tools 等命令管理插件使用。
   */
  setAgentTools?: (agentId: string, tools: string[]) => Promise<void>
  /**
   * cli 注入：harness 能力访问（工具启停等运行时操作）。具体子字段由消费插件自行类型化。
   */
  harness?: unknown
  /**
   * cli 注入：内置工具静态元信息查找（多级加载 L1）。
   * 供工具管理命令在对应工具运行时模块未加载/懒加载时也能展示描述、别名、安全声明与权限键。
   */
  toolMeta?: ToolMetaLookup
}

// ===== AgentPlugin 接口 =====

/**
 * Agent 插件接口
 *
 * 结合 OpenCode 配置化 + Claude Code 多来源加载
 */
export interface AgentPlugin {
  /** 插件 ID（唯一，建议命名空间.功能 格式，如 "core.mcp"） */
  id: string
  /** 版本 */
  version: string
  /** 显示名 */
  name: string
  /** 描述 */
  description?: string
  /** 依赖的其他插件 ID（保证加载顺序，拓扑排序） */
  dependsOn?: string[]

  /** 安装：返回 Hooks 注册表 */
  install(ctx: PluginContext): Promise<Hooks | void>
  /** 卸载：清理资源 */
  uninstall?(): Promise<void>
}

// ===== PluginManager 接口 =====

/** 已加载插件信息 */
export interface LoadedPlugin {
  /** 插件定义 */
  plugin: AgentPlugin
  /** 已注册的 Hooks */
  hooks: Hooks | void
  /** 加载时间戳 */
  loadedAt: number
  /** 来源：internal / builtin / user */
  source: 'internal' | 'builtin' | 'user'
}

/**
 * 插件管理器接口
 *
 * 三级加载：Internal → Builtin → User（每级内部按 dependsOn 拓扑排序）
 * 支持：load / unload / hotReload / list / trigger
 */
export interface PluginManager {
  /** 加载内置插件（硬编码，最高优先级） */
  loadInternal(plugins: AgentPlugin[]): Promise<void>
  /** 加载默认 npm 插件（白名单，如 "@harness/mcp-client@1.0.0"） */
  loadBuiltin(npmSpecs: string[]): Promise<void>
  /** 加载用户插件（配置文件指定，支持 file:/// 本地路径） */
  loadUser(userSpecs: string[]): Promise<void>

  /** 卸载插件 */
  unload(pluginId: string): Promise<void>
  /** 热重载插件（卸载后重新加载） */
  hotReload(pluginId: string): Promise<void>
  /** 列出已加载插件 */
  list(): LoadedPlugin[]

  /**
   * 触发 Hook（管道式依次调用所有已注册插件）
   * 同 OpenCode trigger 机制
   */
  trigger<N extends keyof Hooks>(
    name: N,
    ...args: Parameters<NonNullable<Hooks[N]>>
  ): Promise<void>
}

// ===== 自定义错误 =====

/** 插件 ID 重复 */
export class PluginDuplicateIdError extends Error {
  readonly pluginId: string
  constructor(id: string) {
    super(`Plugin "${id}" already loaded`)
    this.name = 'PluginDuplicateIdError'
    this.pluginId = id
  }
}

/** 插件未找到 */
export class PluginNotFoundError extends Error {
  readonly pluginId: string
  constructor(id: string) {
    super(`Plugin "${id}" not found`)
    this.name = 'PluginNotFoundError'
    this.pluginId = id
  }
}

/** 循环依赖 */
export class PluginCircularDependencyError extends Error {
  readonly cycle: string[]
  constructor(cycle: string[]) {
    super(`Circular dependency detected among plugins: ${cycle.join(' → ')} → ${cycle[0]}`)
    this.name = 'PluginCircularDependencyError'
    this.cycle = cycle
  }
}

/** 缺失依赖 */
export class PluginMissingDependencyError extends Error {
  readonly pluginId: string
  readonly missingDep: string
  constructor(id: string, missing: string) {
    super(`Plugin "${id}" depends on "${missing}", which is not provided in the same load batch`)
    this.name = 'PluginMissingDependencyError'
    this.pluginId = id
    this.missingDep = missing
  }
}

/** 插件 install 抛错 */
export class PluginInstallError extends Error {
  readonly pluginId: string
  readonly cause: unknown
  constructor(id: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(`Plugin "${id}" install() failed: ${msg}`)
    this.name = 'PluginInstallError'
    this.pluginId = id
    this.cause = cause
  }
}

/** 插件 uninstall 抛错 */
export class PluginUninstallError extends Error {
  readonly pluginId: string
  readonly cause: unknown
  constructor(id: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(`Plugin "${id}" uninstall() failed: ${msg}`)
    this.name = 'PluginUninstallError'
    this.pluginId = id
    this.cause = cause
  }
}

/** Hook 管道执行时某个插件抛错 */
export class PluginHookError extends Error {
  readonly hookName: string
  readonly pluginId: string
  readonly cause: unknown
  constructor(hookName: string, pluginId: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(`Hook "${hookName}" in plugin "${pluginId}" failed: ${msg}`)
    this.name = 'PluginHookError'
    this.hookName = hookName
    this.pluginId = pluginId
    this.cause = cause
  }
}

// ===== 拓扑排序 =====

/**
 * 拓扑排序：按 dependsOn 对插件列表排序
 *
 * - 缺失依赖 → PluginMissingDependencyError
 * - 循环依赖 → PluginCircularDependencyError
 * - 其他按 Kahn BFS 算法排序
 */
export function topologicalSortPlugins(plugins: AgentPlugin[]): AgentPlugin[] {
  const byId = new Map<string, AgentPlugin>()
  for (const p of plugins) {
    if (byId.has(p.id)) throw new PluginDuplicateIdError(p.id)
    byId.set(p.id, p)
  }

  // 依赖是否都在同一批内存在（只对在批内的校验；跨批依赖由调用方保证已加载）
  for (const p of plugins) {
    for (const dep of p.dependsOn ?? []) {
      // 若依赖不在批内但 ID 不重复，假设它是跨批的（已加载），跳过校验
    }
  }

  // Kahn 算法
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of byId.keys()) {
    indeg.set(id, 0)
    adj.set(id, [])
  }
  for (const p of plugins) {
    for (const dep of p.dependsOn ?? []) {
      // 仅对批内节点算入度
      if (byId.has(dep)) {
        indeg.set(p.id, (indeg.get(p.id) ?? 0) + 1)
        adj.get(dep)!.push(p.id)
      }
    }
  }

  const queue: string[] = []
  for (const [id, deg] of indeg) if (deg === 0) queue.push(id)

  const result: AgentPlugin[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(byId.get(id)!)
    for (const nxt of adj.get(id) ?? []) {
      const d = (indeg.get(nxt) ?? 0) - 1
      indeg.set(nxt, d)
      if (d === 0) queue.push(nxt)
    }
  }

  if (result.length !== plugins.length) {
    // 剩余节点组成环，DFS 找一条示例
    const remaining = new Set(plugins.map((p) => p.id).filter((id) => !result.find((r) => r.id === id)))
    const cycle: string[] = []
    const visited = new Set<string>()
    const stack: string[] = []
    const dfs = (u: string): boolean => {
      visited.add(u)
      stack.push(u)
      for (const v of byId.get(u)!.dependsOn ?? []) {
        if (!remaining.has(v)) continue
        if (stack.includes(v)) {
          cycle.push(...stack.slice(stack.indexOf(v)))
          cycle.push(v)
          return true
        }
        if (!visited.has(v) && dfs(v)) return true
      }
      stack.pop()
      return false
    }
    for (const id of remaining) if (!visited.has(id) && dfs(id)) break
    throw new PluginCircularDependencyError(cycle || Array.from(remaining))
  }

  return result
}

// ===== HooksRegistry =====

/**
 * HooksRegistry：Hook name → （pluginId, callback）有序列表
 *
 * trigger(name, args) 按注册顺序依次调用所有回调；
 * - 对 `tool.pre.execute` / `tool.post.execute` 特殊处理 Promise 链返回值给调用方（见 PluginManager）
 * - 其他 hooks 管道式 mutate 参数（返回值忽略）
 */
export class HooksRegistry {
  private readonly store = new Map<keyof Hooks, Array<{ pluginId: string; fn: NonNullable<Hooks[keyof Hooks]> }>>()

  /** 注册一个插件返回的所有 Hooks */
  register(pluginId: string, hooks: Hooks | void): void {
    if (!hooks) return
    for (const rawKey of Object.keys(hooks) as (keyof Hooks)[]) {
      const fn = hooks[rawKey] as NonNullable<Hooks[keyof Hooks]> | undefined
      if (!fn) continue
      const arr = this.store.get(rawKey) ?? (() => {
        const a: Array<{ pluginId: string; fn: NonNullable<Hooks[keyof Hooks]> }> = []
        this.store.set(rawKey, a)
        return a
      })()
      arr.push({ pluginId, fn })
    }
  }

  /** 注销某个插件的所有 hooks（unload 时调用） */
  unregister(pluginId: string): void {
    for (const [key, arr] of this.store) {
      const filtered = arr.filter((e) => e.pluginId !== pluginId)
      if (filtered.length === 0) this.store.delete(key)
      else this.store.set(key, filtered)
    }
  }

  /** 返回某 hook 名称下按注册顺序的回调列表 */
  listFor<N extends keyof Hooks>(name: N): ReadonlyArray<{ pluginId: string; fn: NonNullable<Hooks[N]> }> {
    return ((this.store.get(name) ?? []) as unknown) as ReadonlyArray<{ pluginId: string; fn: NonNullable<Hooks[N]> }>
  }

  /** 是否有 hook 注册 */
  has<N extends keyof Hooks>(name: N): boolean {
    return (this.store.get(name)?.length ?? 0) > 0
  }
}

// ===== PluginManagerImpl =====

/** createPluginManager 参数 */
export interface PluginManagerOptions {
  /** Bus 事件总线 */
  bus: Bus
  /** 初始配置（可选） */
  initialConfig?: Record<string, unknown>
  /** 日志器实现（可选，缺省时使用 silent logger） */
  logger?: PluginContext['log']
  /** 动态 import 实现（用于 loadBuiltin/loadUser；便于单测注入） */
  dynamicImport?: (spec: string) => Promise<{ default?: unknown } | unknown>
  /**
   * 宿主工作区路径（可选）：注入到所有插件的 `PluginContext.workspace`。
   * 由宿主（core）传入；不传则插件的 `ctx.workspace` 为 undefined。
   */
  workspace?: PluginWorkspaceView
}

/**
 * PluginManager 具体实现
 *
 * 流程：
 * 1. 构造时注入 PluginContext（bus + 内存 config + logger + dynamicImport）
 * 2. loadInternal/loadBuiltin/loadUser 三级加载
 *    - 每级：拓扑排序 → 去重检查 → install → hooks 聚合 + bus.event 订阅桥接
 *    - loadBuiltin/loadUser 调用 dynamicImport 或 Bun 的自动 npm install
 * 3. trigger(name, ...args) 按插件加载顺序依次回调，出错聚合抛错
 * 4. unload：bus.event 退订 → hooks unregister → uninstall
 * 5. hotReload：卸载后再安装
 */
export class PluginManagerImpl implements PluginManager {
  private readonly bus: Bus
  private readonly ctx: PluginContext
  private readonly configStore: Record<string, unknown>
  private readonly dynamicImport: (spec: string) => Promise<{ default?: unknown } | unknown>
  private readonly logger: PluginContext['log']

  /** 已加载插件表 */
  private readonly loaded = new Map<string, LoadedPlugin>()
  /** Hooks 注册表 */
  private readonly hooks = new HooksRegistry()
  /** bus.event Hook → Bus unsubscribe 句柄映射 */
  private readonly busEventUnsubs = new Map<string, () => void>()
  /** loadBuiltin / loadUser 动态 import 后保存 spec 对应 pluginId 以支持 hotReload */
  private readonly specById = new Map<string, { source: 'builtin' | 'user'; spec: string }>()
  /** Internal 原始引用以支持 hotReload */
  private readonly internalPlugins = new Map<string, AgentPlugin>()

  constructor(options: PluginManagerOptions) {
    this.bus = options.bus
    this.configStore = { ...(options.initialConfig ?? {}) }
    this.logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} }
    this.dynamicImport = options.dynamicImport ?? ((s) => import(/* @vite-ignore */ s))

    // PluginContext
    this.ctx = {
      bus: this.bus,
      config: {
        get: <T,>(key: string) => this.configStore[key] as T | undefined,
        set: <T,>(key: string, value: T) => {
          this.configStore[key] = value
        },
      },
      log: this.logger,
      ...(options.workspace ? { workspace: options.workspace } : {}),
    }
  }

  // ---- 三级加载 ----

  async loadInternal(plugins: AgentPlugin[]): Promise<void> {
    const ordered = topologicalSortPlugins(plugins)
    for (const p of ordered) {
      if (this.loaded.has(p.id)) throw new PluginDuplicateIdError(p.id)
    }
    for (const p of ordered) {
      await this.installOne(p, 'internal')
      this.internalPlugins.set(p.id, p)
    }
  }

  async loadBuiltin(npmSpecs: string[]): Promise<void> {
    const loaded = await Promise.all(npmSpecs.map((s) => this.resolveSpec(s)))
    await this.loadExternalBatch(loaded, 'builtin', npmSpecs)
  }

  async loadUser(userSpecs: string[]): Promise<void> {
    const loaded = await Promise.all(userSpecs.map((s) => this.resolveSpec(s)))
    await this.loadExternalBatch(loaded, 'user', userSpecs)
  }

  // ---- 卸载 / 热重载 ----

  async unload(pluginId: string): Promise<void> {
    const lp = this.loaded.get(pluginId)
    if (!lp) throw new PluginNotFoundError(pluginId)

    // 1. bus.event 退订
    const unsub = this.busEventUnsubs.get(pluginId)
    if (unsub) {
      unsub()
      this.busEventUnsubs.delete(pluginId)
    }

    // 2. hooks 注销
    this.hooks.unregister(pluginId)

    // 3. uninstall()
    try {
      await lp.plugin.uninstall?.()
    } catch (err) {
      throw new PluginUninstallError(pluginId, err)
    }

    // 4. 清理
    this.loaded.delete(pluginId)
    this.specById.delete(pluginId)
    this.internalPlugins.delete(pluginId)
  }

  async hotReload(pluginId: string): Promise<void> {
    const lp = this.loaded.get(pluginId)
    if (!lp) throw new PluginNotFoundError(pluginId)

    const source = lp.source
    // 保存需要的信息
    let plugin: AgentPlugin | null = null

    if (source === 'internal') {
      plugin = this.internalPlugins.get(pluginId) ?? null
    } else {
      const specInfo = this.specById.get(pluginId)
      if (specInfo) {
        const mod = await this.resolveSpec(specInfo.spec)
        plugin = mod
      }
    }

    // 先卸载
    await this.unload(pluginId)

    // 再安装
    if (plugin === null) return

    if (source === 'internal') {
      // 重新按单批加载
      await this.installOne(plugin, 'internal')
      this.internalPlugins.set(pluginId, plugin)
    } else {
      await this.installOne(plugin, source as 'builtin' | 'user')
      this.specById.set(pluginId, { source: source as 'builtin' | 'user', spec: this.specById.get(pluginId)?.spec ?? '' })
    }
  }

  list(): LoadedPlugin[] {
    return Array.from(this.loaded.values())
  }

  // ---- trigger Hook 管道 ----

  async trigger<N extends keyof Hooks>(
    name: N,
    ...args: Parameters<NonNullable<Hooks[N]>>
  ): Promise<void> {
    const entries = this.hooks.listFor(name)
    if (entries.length === 0) return

    const errors: PluginHookError[] = []
    for (const { pluginId, fn } of entries) {
      try {
        await (fn as (...a: unknown[]) => Promise<unknown> | unknown)(...args)
      } catch (err) {
        errors.push(new PluginHookError(String(name), pluginId, err))
      }
    }

    if (errors.length > 0) {
      // 多个错误时用 AggregateError 包装
      if (errors.length === 1) throw errors[0]
      const agg = new AggregateError(errors, `Hook "${String(name)}": ${errors.length} plugin(s) failed`)
      ;(agg as { hookName?: string }).hookName = String(name)
      throw agg
    }
  }

  // ===== 内部辅助 =====

  private async installOne(plugin: AgentPlugin, source: LoadedPlugin['source']): Promise<void> {
    const start = performance.now()
    let hooksResult: Hooks | void
    try {
      hooksResult = await plugin.install(this.ctx)
    } catch (err) {
      throw new PluginInstallError(plugin.id, err)
    }

    const lp: LoadedPlugin = {
      plugin,
      hooks: hooksResult,
      loadedAt: Date.now(),
      source,
    }
    this.loaded.set(plugin.id, lp)

    // 聚合到 HooksRegistry
    this.hooks.register(plugin.id, hooksResult)

    // bus.event 桥接：如果插件声明了 bus.event Hook，则用 bus.subscribeAll 订阅
    const busEventFn = hooksResult?.['bus.event']
    if (busEventFn) {
      const unsub = this.bus.subscribeAll((record) => {
        return Promise.resolve(busEventFn(record as BusEventRecord)).catch((err) => {
          this.logger.error(`[plugin:${plugin.id}] bus.event handler failed`, err)
        })
      })
      this.busEventUnsubs.set(plugin.id, unsub)
    }

    this.logger.info(`[plugin] loaded ${plugin.id}@${plugin.version} (${(performance.now() - start).toFixed(1)}ms, source=${source})`)
  }

  private async loadExternalBatch(
    plugins: AgentPlugin[],
    source: 'builtin' | 'user',
    specs: string[]
  ): Promise<void> {
    const ordered = topologicalSortPlugins(plugins)
    for (const p of ordered) {
      if (this.loaded.has(p.id)) throw new PluginDuplicateIdError(p.id)
    }
    const idToSpec = new Map<string, string>()
    // 简单地按顺序对应：如果顺序不稳定会用插件本身 id 存；实际上 resolver 返回顺序和传入顺序一致
    for (let i = 0; i < specs.length; i++) {
      const plug = plugins[i]
      if (plug) idToSpec.set(plug.id, specs[i]!)
    }
    for (const p of ordered) {
      await this.installOne(p, source)
      const spec = idToSpec.get(p.id)
      if (spec) this.specById.set(p.id, { source, spec })
    }
  }

  /** 将 spec 解析成 AgentPlugin（dynamic import 后找 default 或 匹配的命名导出） */
  private async resolveSpec(spec: string): Promise<AgentPlugin> {
    const mod = await this.dynamicImport(spec)
    const candidates = [
      (mod as { default?: unknown }).default,
      (mod as { default?: { default?: unknown } }).default?.['default'],
      (mod as { plugin?: unknown }).plugin,
    ]
    // 直接是模块对象：找 id + install 字段
    const probe = (o: unknown): AgentPlugin | null => {
      if (!o || typeof o !== 'object') return null
      const x = o as Record<string, unknown>
      if (typeof x['id'] === 'string' && typeof x['install'] === 'function') return x as unknown as AgentPlugin
      return null
    }
    for (const c of candidates) {
      const r = probe(c)
      if (r) return r
    }
    if (probe(mod)) return probe(mod)!
    // 模块是普通对象，尝试遍历找一个 plugin
    if (mod && typeof mod === 'object') {
      for (const v of Object.values(mod as Record<string, unknown>)) {
        const r = probe(v)
        if (r) return r
      }
    }
    throw new PluginInstallError(spec, new Error(`spec "${spec}" did not export a valid AgentPlugin`))
  }
}

// ===== 工厂 =====

export function createPluginManager(options: PluginManagerOptions): PluginManager {
  return new PluginManagerImpl(options)
}

// ===== Provider 契约（抽象层，供 core / cli 消费、Provider 插件实现）=====
// 依赖方向：core / cli -----> @harness/plugin（本抽象层）；Provider 插件 -----> @harness/plugin
// 具体 Provider 实现（provider-* 包）通过导出 providerTypeFactory 实现下方契约，
// 上层只经 ProviderTypeRegistry 按 type 解析，不感知具体实现。

/** 单个 Provider 定义（config.json 的 providers 数组元素 / cli 传入） */
export interface ProviderConfig {
  /**
   * 实例 ID：运行时按 `providerId` 路由到具体 ChatProvider（注册表 key + 插件 id `provider.<id>`）。
   *
   * **可省略**（推荐）：省略时由 CLI 的 `normalizeProviderConfigs` 依据 `model` 自动派生
   * （如 model="hy3" → id="hy3"），同名时按数组顺序追加 `-2` / `-3` 保证唯一。
   * 因此「id 必须全局唯一且冗长」不再是配置者的负担。
   *
   * 仅在需要「同一模型挂多个端点」或想让 id 比模型名更短时才显式写；显式写时仍必须唯一。
   */
  id?: string
  /** Provider 类型：内置支持 anthropic / openai / gemini / glm / qwen / mock；可经插件扩展任意自定义 type */
  type: string
  /** API 根路径（如 api.openai.com / api.deepseek.com / http://localhost:11434） */
  baseUrl?: string
  /** API Key */
  apiKey?: string
  /** 该 Provider 默认模型 */
  model?: string
  /** OpenAI 类型专用：API 路径（默认 /v1/chat/completions；智谱等兼容 API 可改 /chat/completions） */
  apiPath?: string
  /** max_tokens 默认值 */
  maxTokens?: number
  /** 请求超时（ms） */
  timeoutMs?: number
  /**
   * 模型上下文窗口（输入 tokens）。供上下文压缩（@harness/acp-context）等工具据此判断
   * 触发阈值；缺省时各消费者回退自己的默认（默认 200_000）。
   */
  contextWindowTokens?: number
  /**
   * 思考模式开关（OpenAI 兼容 thinking 端点：DeepSeek / GLM 等；仅 openai 系 Provider 消费）。
   * 请求体顶层注入 `thinking: { type }`。缺省不发送（DeepSeek 默认启用；标准 OpenAI 不认识该参数）。
   */
  thinking?: 'enabled' | 'disabled'
  /**
   * 思考力度：请求体顶层注入 `reasoning_effort`。
   * DeepSeek 接受 minimal/low/medium/high/xhigh/max/ultra；OpenAI o 系接受 low/medium/high。
   * 缺省不发送。可被 Agent 定义 `model.options.reasoningEffort` 按覆盖。
   */
  reasoningEffort?: string
  /** 额外透传字段（供特定 Provider 自定义配置，如 mock 的 defaultResponse） */
  [key: string]: unknown
}

/**
 * Provider 类型工厂：`config.type` → 插件构造。
 * Provider 插件实现该接口并导出 providerTypeFactory；`createPlugin` 可为惰性的（内部 await import()），
 * 返回值允许为 Promise（返回 undefined 表示该配置不可用）。
 */
export interface ProviderTypeFactory {
  /** 对应 ProviderConfig.type 的值 */
  type: string
  createPlugin: (config: ProviderConfig) => AgentPlugin | undefined | Promise<AgentPlugin | undefined>
}

/** Provider 类型展示元信息：用于 help / config check 等"无需加载 Provider 模块"即可友好展示的场景 */
export interface ProviderTypeMeta {
  /** 对应 ProviderTypeFactory.type */
  type: string
  /** 人读描述 */
  description?: string
  /** 该类型默认模型 */
  defaultModel?: string
  /** 是否需要 apiKey（用于提示） */
  requiresApiKey?: boolean
  /** 是否为内置类型（随应用打包） */
  builtin?: boolean
  /** 人机交互用法示例（如 `/model openai/gpt-4o`） */
  usage?: string
}

/** Provider 类型注册表：按 type 动态解析工厂（内置 + 外部插件注册，替代硬编码 switch） */
export class ProviderTypeRegistry {
  private readonly factories = new Map<string, ProviderTypeFactory>()
  private readonly metas = new Map<string, ProviderTypeMeta>()

  register(factory: ProviderTypeFactory, meta?: Partial<ProviderTypeMeta>): void {
    this.factories.set(factory.type, factory)
    if (meta) this.metas.set(factory.type, { type: factory.type, ...meta })
  }

  resolve(type: string): ProviderTypeFactory | undefined {
    return this.factories.get(type)
  }

  list(): string[] {
    return [...this.factories.keys()]
  }

  /** 指定 type 的展示元信息（未登记则为 undefined） */
  meta(type: string): ProviderTypeMeta | undefined {
    return this.metas.get(type)
  }

  /** 全部已注册类型的展示元信息；未登记 meta 的类型也返回仅含 type 的占位，保证清单完整 */
  listMeta(): ProviderTypeMeta[] {
    return [...this.factories.keys()].map((t) => this.metas.get(t) ?? { type: t })
  }

  clear(): void {
    this.factories.clear()
    this.metas.clear()
  }
}

/**
 * 从插件模块导出中提取 Provider 类型工厂。
 * 支持三种形态：`providerTypeFactory`、`providerType`+`createProviderPlugin`、`default` 带上述字段。
 * 找不到时返回 undefined。
 */
export function resolveProviderTypeFactory(mod: Record<string, unknown>): ProviderTypeFactory | undefined {
  const holder = (mod.default && typeof mod.default === 'object' ? mod.default : {}) as Record<string, unknown>
  const probe = (o: Record<string, unknown>): ProviderTypeFactory | undefined => {
    if (o.providerTypeFactory && typeof (o.providerTypeFactory as ProviderTypeFactory).createPlugin === 'function') {
      return o.providerTypeFactory as ProviderTypeFactory
    }
    if (
      typeof o.providerType === 'string' &&
      typeof (o as { createProviderPlugin?: unknown }).createProviderPlugin === 'function'
    ) {
      const { providerType, createProviderPlugin } = o as {
        providerType: string
        createProviderPlugin: (config: ProviderConfig) => AgentPlugin | undefined | Promise<AgentPlugin | undefined>
      }
      return { type: providerType, createPlugin: createProviderPlugin }
    }
    return undefined
  }
  return probe(mod) ?? probe(holder) ?? undefined
}

// ===== 运行时能力服务契约（抽象层，供 cli 消费、subagent / swarm 插件实现）=====
// 依赖方向：cli -----> @harness/plugin（本抽象层）；subagent / swarm 插件 -----> @harness/plugin
// 具体能力对象（subagentCapability / swarmCapability）由插件包导出并在运行期注入（组合根装配），
// cli 只经下方抽象接口与之交互，不依赖具体插件的实现细节类型。
// 抽象接口均取"最小结构契约"，实现类天然结构兼容，避免抽象层反向依赖具体插件。

// --- 后台任务监控（subagent 插件实现）---

/** 后台任务进度条目（结构兼容 subagent.BackgroundTaskProgress） */
export interface BackgroundProgressLike {
  toolUseId: string
  toolName: string
  toolStatus: 'running' | 'completed' | 'failed'
  summary: string
}

/** 后台任务只读快照（结构兼容 subagent.BackgroundTaskView） */
export interface BackgroundTaskViewLike {
  taskId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  agentId?: string
  agentName?: string
  description?: string
  result?: string
  durationMs?: number
  error?: { code?: string; message?: string }
  progress?: BackgroundProgressLike[]
}

/** 后台任务变更订阅回调 */
export type BackgroundTaskListenerLike = (tasks: readonly BackgroundTaskViewLike[]) => void

/** 后台任务监控器抽象：subagent 插件的 BackgroundTaskMonitor 实现本接口 */
export interface BackgroundTaskMonitorLike {
  subscribe(listener: BackgroundTaskListenerLike): () => void
  dispose(): void
}

/** subagent 插件能力：创建后台任务监控器（cli 持此抽象，不依赖具体实现） */
export interface SubagentCapability {
  createMonitor(options: { bus: Bus; parentSessionIds?: string[] }): BackgroundTaskMonitorLike
}

// --- 团队成员协作子命令能力（swarm 插件实现）---

/** 团队成员协作循环参数（cli 只传必要参数，mailbox/taskPlane 创建与循环细节由 swarm 插件封装） */
export interface SwarmLoopDeps {
  /** 团队共享数据目录（mailbox / taskPlane 都在此创建） */
  teamsDir: string
  /** 团队名（已规范化） */
  team: string
  /** 成员名（已规范化） */
  name: string
  /** 成员 agentId（agent 定义 id） */
  agentId: string
  /** 关联会话 id */
  sessionId: string
  /** 运行时 harness（接入总线 / 会话） */
  harness: unknown
}

/** 团队成员协作循环句柄 */
export interface SwarmLoopHandle {
  /** 是否已收到 shutdown 决策 / 外部停止请求 */
  isDone(): boolean
  /** 停止循环（幂等） */
  stop(): Promise<void>
}

/** swarm 插件能力：团队成员子命令（cli 持此抽象，不依赖具体实现） */
export interface SwarmCapability {
  sanitizeName(name: string): string
  formatAgentId(name: string, team: string): string
  startTeammateLoop(deps: SwarmLoopDeps): SwarmLoopHandle
}
