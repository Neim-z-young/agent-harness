/**
 * @harness/skill - 技能系统
 *
 * 双轨制设计：
 * - Skill = 知识（Markdown 正文）
 * - Tool = 功能（代码执行）
 *
 * 三来源合并：bundled / user / project / mcp
 * 条件触发：paths glob 匹配（修改文件时自动注入上下文）
 * 内嵌 Shell：embeds 支持执行 shell 命令（MCP 来源强制切断）
 */

/** 支持 Promise 或同步值的类型 */
export type Awaitable<T> = T | Promise<T>

// ===== 技能来源 =====

/**
 * 技能加载来源
 * - bundled：随包内置
 * - user：用户全局配置（~/.harness/skills）
 * - project：项目级（.harness/skills）
 * - mcp：MCP Server 提供（安全限制：禁用 shell embed）
 */
export type SkillSource = 'bundled' | 'user' | 'project' | 'mcp'

/** 任务预估（给 coordinator 参考，用于任务派发优先级） */
export type SkillEffort = 'low' | 'medium' | 'high'

// ===== 内嵌资源 =====

/**
 * 内嵌资源（shell 命令或变量替换）
 * 在 Markdown 中以 !`cmd` 或 {{var}} 形式出现
 */
export interface SkillEmbed {
  /** 类型：shell 命令 / 变量替换 */
  type: 'shell' | 'variable'
  /** 源码："git status" / "${SKILL_DIR}" */
  source: string
}

// ===== Skill 接口 =====

/**
 * 技能接口
 *
 * 安全策略：
 * - MCP 来源（loadedFrom === 'mcp'）强制 allowEmbedShell = false
 *   （防 RCE，同 Claude Code 安全切断）
 */
export interface Skill {
  /** 技能 ID（唯一） */
  id: string
  /** 显示名 */
  name: string
  /** AI 何时使用的触发说明 */
  description: string

  // === 来源 ===
  /** 加载来源（影响安全策略） */
  loadedFrom: SkillSource

  // === 条件触发 ===
  /** glob 匹配：修改这些文件时自动注入上下文 */
  paths?: string[]
  /** /skill-name 命令是否对用户可见 */
  userInvocable?: boolean
  /** 仅这些 Agent 可用（不填则所有 Agent 可用） */
  agentBind?: string[]

  // === 内容（双轨制：Markdown + 可选 Script 执行）===
  /** Markdown 正文 */
  content: string
  /** 内嵌 !`cmd` 或 {{var}} 资源列表 */
  embeds?: SkillEmbed[]
  /**
   * 是否允许内嵌 Shell 执行
   * - MCP 来源强制 false（安全切断，防 RCE）
   * - 其他来源默认 true
   */
  allowEmbedShell?: boolean

  // === 元数据 ===
  /** 加载后额外放开哪些工具 */
  allowedTools?: string[]
  /** 绑定特定模型（不填则跟随 Agent） */
  model?: string
  /** 任务预估（给 coordinator 参考） */
  effort?: SkillEffort
}

// ===== SkillManager 接口 =====

/**
 * 技能管理器接口
 * 负责三来源技能的加载、合并、查询、条件触发
 */
export interface SkillManager {
  /** 列出所有已加载技能 */
  all(): Skill[]
  /** 按 ID 获取技能 */
  get(id: string): Skill | undefined
  /** 加载技能（从指定来源或路径） */
  load(source: SkillSource | string): Promise<Skill[]>
  /** 按路径匹配触发（paths glob 匹配，返回需注入上下文的技能） */
  matchByPath(filePath: string): Skill[]
  /** 按 Agent ID 过滤可用技能 */
  filterByAgent(agentId: string): Skill[]
  /** 重载技能（热更新） */
  reload(id: string): Promise<Skill | undefined>
}
