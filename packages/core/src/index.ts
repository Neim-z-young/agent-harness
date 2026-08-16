/**
 * @harness/core - Harness 核心
 *
 * 顶层编排器，纯逻辑内核，不依赖任何 UI/CLI 库。
 * 同一套执行内核可嵌入 SDK / CLI / IDE / Worker / Server 多形态。
 *
 * 通过 Harness 实例暴露所有能力访问器：
 * - session：会话管理
 * - agent：Agent 运行时
 * - plugin：插件管理
 * - bus：事件总线
 * - context：DI 容器
 * - permission：权限引擎
 * - skill：技能管理
 */

import type { Bus } from '@harness/bus'
import type { PluginManager } from '@harness/plugin'
import type { SessionManager } from '@harness/session'
import type { AgentDefinition } from '@harness/agent'

// ===== Context Provider（DI 容器）=====

/**
 * 上下文容器（依赖注入）
 * 提供 register/resolve/createChild 接口
 */
export interface ContextProvider {
  /** 注册依赖 */
  register<T>(key: string, value: T): void
  /** 获取依赖（同步） */
  resolve<T>(key: string): T | undefined
  /** 获取依赖（异步，支持懒加载） */
  resolveAsync<T>(key: string): Promise<T | undefined>
  /** 创建子上下文（隔离作用域） */
  createChild(): ContextProvider
}

// ===== Agent Runtime =====

/** Agent 查询输入 */
export interface AgentQueryInput {
  /** 会话 ID */
  sessionId: string
  /** Agent ID（不填用默认） */
  agentId?: string
  /** 用户消息 */
  message: string
}

/**
 * Agent 运行时接口
 * 由 Harness 暴露，负责 Agent 注册和查询执行
 */
export interface AgentRuntime {
  /** 注册 Agent 定义 */
  register(def: AgentDefinition): void
  /** 获取 Agent 定义 */
  get(agentId: string): AgentDefinition | undefined
  /** 列出所有 Agent */
  list(): AgentDefinition[]
  /** 执行一轮推理（触发 LLM 调用 + Tool Pipeline） */
  query(input: AgentQueryInput): Promise<unknown>
}

// ===== Harness 选项 =====

/**
 * Harness 创建选项
 */
export interface HarnessOptions {
  /** 工作目录 */
  cwd?: string
  /** 初始 Agent ID */
  agentId?: string
  /** 初始插件列表（npm spec 或 file:// 路径） */
  plugins?: string[]
  /** 配置覆盖 */
  config?: Record<string, unknown>
  /** 是否启用 Skill 系统 */
  enableSkills?: boolean
}

// ===== Harness 接口 =====

/**
 * Harness 核心接口
 *
 * 生命周期：create → start → (suspend ↔ resume) → stop
 * 通过访问器获取各能力模块
 */
export interface Harness {
  // === 生命周期 ===
  /** 创建并初始化 Harness 实例 */
  create(options: HarnessOptions): Promise<Harness>
  /** 启动（加载插件、连接资源） */
  start(): Promise<void>
  /** 停止（清理资源、断开连接） */
  stop(): Promise<void>
  /** 挂起（长任务暂停，如后台 worker） */
  suspend(): Promise<void>
  /** 恢复（从挂起状态恢复） */
  resume(): Promise<void>

  // === 能力访问器 ===
  /** 会话管理 */
  readonly session: SessionManager
  /** Agent 运行时 */
  readonly agent: AgentRuntime
  /** 插件管理 */
  readonly plugin: PluginManager
  /** 事件总线 */
  readonly bus: Bus
  /** 上下文容器（DI） */
  readonly context: ContextProvider
}

// ===== 工厂函数 =====

/**
 * Harness 工厂（待 Phase 1 MVP 实现）
 *
 * @example
 * const harness = await createHarness({
 *   cwd: process.cwd(),
 *   agentId: 'primary',
 *   plugins: ['@harness/mcp-client'],
 * })
 * await harness.start()
 */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  throw new Error('createHarness() 尚未实现，等待 Phase 1 MVP')
}
