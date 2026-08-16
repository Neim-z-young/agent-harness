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
}

export interface CompactionContext {
  /** 保留最近 N 条消息 */
  keepLast?: number
  /** 摘要策略 */
  strategy?: 'prune' | 'summary' | 'agent'
  /** 摘要内容（输出） */
  summary?: string
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

  // === Permission 扩展 ===
  /** 权限检查 Hook：可修改决策（如 teammate 桥接到 leader） */
  'permission.check'?: (
    req: PermissionRequestLike,
    decision: PermissionDecisionLike
  ) => Awaitable<void>

  // === Bus 事件订阅 ===
  /** 订阅所有 Bus 事件（用于日志、遥测、桥接） */
  'bus.event'?: (event: BusEventRecord) => Awaitable<void>
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
