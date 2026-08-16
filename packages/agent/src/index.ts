/**
 * @harness/agent - Agent 定义
 *
 * 配置化 + 可组合的 Agent 人设。
 *
 * 四模式分层（参考 Claude Code 三层体系 + 扩展）：
 * - primary：主 Agent，可直接对用户
 * - subagent：只能被主 Agent 调用（独立 worker）
 * - coordinator：调度器身份（不自己写代码，专派工）
 * - teammate：Swarm 协作成员（带 inbox/task list）
 *
 * 能力白名单：tools / skills / subagents
 * 权限配置：PermissionRuleset（结构兼容 @harness/permission）
 * Prompt 片段：可组合叠加，systemPrompt 优先级更高
 */

// ===== Agent 角色 =====

/**
 * Agent 角色模式
 * - primary：主 Agent，可直接对用户
 * - subagent：只能被主 Agent 调用（独立 worker）
 * - coordinator：调度器身份（不自己写代码，专派工）
 * - teammate：Swarm 协作成员（带 inbox/task list）
 */
export type AgentMode = 'primary' | 'subagent' | 'coordinator' | 'teammate'

// ===== 模型偏好 =====

/**
 * Agent 模型偏好（覆盖默认 Provider/模型）
 * 同 OpenCode agent.model 配置
 */
export interface AgentModelPreference {
  /** Provider ID（如 "anthropic"、"openai"） */
  providerId?: string
  /** 模型 ID（如 "claude-3-5-sonnet"、"gpt-4o"） */
  modelId?: string
  /** 温度（0-2） */
  temperature?: number
  /** 其他模型选项（如 top_p、max_tokens） */
  options?: Record<string, unknown>
}

// ===== Swarm 协作能力 =====

/**
 * Swarm 协作能力声明
 * 由 Swarm 插件读取，决定 Agent 的协作能力
 */
export interface SwarmCapabilities {
  /** 是否可派生 teammate（默认 false，teammate 不能嵌套） */
  canSpawnTeammate?: boolean
  /** 是否可认领共享任务 */
  canClaimTask?: boolean
  /** 是否可使用邮箱（接收其他 Agent 消息） */
  canUseMailbox?: boolean
}

// ===== Agent 权限配置（结构兼容 @harness/permission 的 PermissionRuleset）=====

/** 权限行为 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

/** 路径级规则 */
export interface AgentPathRules {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}

/**
 * Agent 权限配置
 * 结构兼容 @harness/permission 的 PermissionRuleset
 */
export interface AgentPermissionConfig {
  [toolKey: string]: PermissionBehavior | AgentPathRules | undefined
  '*'?: PermissionBehavior
}

// ===== AgentDefinition 接口 =====

/**
 * Agent 定义
 *
 * 完整描述一个 Agent 的能力、权限、Prompt、协作能力。
 * 可通过配置文件加载或代码注册。
 */
export interface AgentDefinition {
  /** Agent ID（唯一） */
  id: string
  /** 显示名 */
  name: string
  /** 描述（给 coordinator 用于任务派发决策） */
  description: string
  /** 图标（UI 呈现） */
  icon?: string
  /** 标签（用于分类/搜索） */
  tags?: string[]

  // === 分层角色声明 ===
  /**
   * 角色模式
   * - primary：主 Agent，可直接对用户
   * - subagent：只能被主 Agent 调用（独立 worker）
   * - coordinator：调度器身份（不自己写代码，专派工）
   * - teammate：Swarm 协作成员（带 inbox/task list）
   */
  mode: AgentMode

  // === 能力白名单 ===
  /** 工具 ID 列表，['*'] 表示全部工具 */
  tools: string[] | ['*']
  /** 技能 ID 白名单 */
  skills?: string[]
  /** 允许派出的 subagent ID 列表（mode=primary/coordinator 时有效） */
  subagents?: string[]

  // === 权限配置 ===
  /** 权限规则集（结构兼容 @harness/permission） */
  permission: AgentPermissionConfig

  // === 模型偏好 ===
  /** 模型偏好（覆盖默认 Provider/模型） */
  model?: AgentModelPreference

  // === Prompt 片段（可组合叠加） ===
  /** System Prompt 片段数组（按顺序拼接） */
  promptFragments?: string[]
  /** 完整覆盖 Prompt（优先级高于 promptFragments） */
  systemPrompt?: string

  // === 协作能力（Swarm 插件读取）===
  /** Swarm 协作能力声明 */
  swarm?: SwarmCapabilities
}
