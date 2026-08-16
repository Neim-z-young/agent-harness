/**
 * @harness/permission - 权限引擎
 *
 * 路径级通配符权限匹配，支持 allow / deny / ask 三种行为。
 *
 * 匹配优先级（同 OpenCode 4 级）：
 * 1. 具体路径精确匹配（"src/main.ts"）
 * 2. 通配符 glob 匹配（"src/**"）
 * 3. 工具级规则（write: "ask"）
 * 4. 全局通配（*: "ask"）
 */

/** 支持 Promise 或同步值的类型 */
export type Awaitable<T> = T | Promise<T>

// ===== 权限行为 =====

/** 权限行为：允许 / 拒绝 / 询问 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

// ===== 路径级规则 =====

/**
 * 路径级规则集合
 * 对某个工具的所有路径统一配置 allow / deny / ask
 */
export interface PathRules {
  /** 允许的路径 glob 列表（命中即 allow，不询问） */
  allow?: string[]
  /** 拒绝的路径 glob 列表（命中即 deny，不可执行） */
  deny?: string[]
  /** 需要询问的路径 glob 列表（命中触发 ask） */
  ask?: string[]
}

/**
 * 单个工具的权限规则
 * - 简写形式：直接给 PermissionBehavior（如 "ask"，对所有路径生效）
 * - 详细形式：PathRules（按路径 glob 分别配置）
 */
export type ToolPermissionRule = PermissionBehavior | PathRules

/**
 * 权限规则集
 *
 * 键 = 工具权限键（如 "write"、"bash"、"read"）
 * 值 = 行为（简写）或路径级规则（详细）
 * '*' = 全局默认行为（兜底）
 *
 * @example
 * const rules: PermissionRuleset = {
 *   read: 'allow',                           // 所有读操作放行
 *   write: {                                 // 写操作按路径分
 *     allow: ['src/**', 'docs/**'],
 *     ask: ['*.env', 'package.json'],
 *     deny: ['node_modules/**'],
 *   },
 *   bash: 'ask',                             // 所有 bash 命令询问
 *   '*': 'ask',                              // 其他工具默认询问
 * }
 */
export interface PermissionRuleset {
  [toolKey: string]: ToolPermissionRule | undefined
  /** 全局默认行为（兜底） */
  '*'?: PermissionBehavior
}

// ===== PermissionDecision =====

/**
 * 权限决策（含可深度修正参数）
 * 参考 Claude Code，允许插件通过 updatedInput 修改工具输入
 */
export interface PermissionDecision {
  /** 最终行为 */
  behavior: PermissionBehavior
  /** 修正后的输入参数（插件可深度修改，如路径重写） */
  updatedInput?: unknown
  /** 是否记住决策（用户选"始终允许"时写回规则集） */
  remember?: boolean
  /** 匹配的规则来源（精确路径/glob/工具级/全局） */
  matchedRule?: 'exact' | 'glob' | 'tool' | 'global'
  /** 匹配的模式（用于日志/调试） */
  matchedPattern?: string
}

// ===== PermissionRequest =====

/** 权限请求（由 Tool 通过 ctx.requestPermission 发起） */
export interface PermissionRequest {
  /** 工具权限键（如 "write"、"bash"） */
  toolKey: string
  /** 提取的路径或命令模式（由 Tool.permission.extractPatterns 生成） */
  patterns: string[]
  /** 原始输入 */
  input: unknown
  /** 请求来源（如 agentId / pluginId） */
  from?: string
}

// ===== PermissionEngine 接口 =====

/**
 * 权限引擎接口
 *
 * 4 级匹配优先级：精确路径 → glob → 工具级 → 全局通配
 *
 * 工作流程：
 * 1. Tool.call 前由 Pipeline 调用 check()
 * 2. 若 check 返回 ask，调用 ask() 询问用户
 * 3. 用户选择 allow/deny/始终允许，写回 remember
 */
export interface PermissionEngine {
  /**
   * 检查权限（不询问用户）
   * 返回决策：allow / deny / ask
   * - allow：直接放行
   * - deny：拒绝执行
   * - ask：需要调用 ask() 询问用户
   */
  check(req: PermissionRequest): Promise<PermissionDecision>

  /**
   * 询问用户（behavior=ask 时调用）
   * 用户可选择：allow / deny / 始终允许 / 始终拒绝
   * 选择"始终"时，remember=true 并写回规则集
   */
  ask(req: PermissionRequest): Promise<PermissionDecision>

  /**
   * 更新规则集（如记住用户选择）
   */
  updateRules(rules: PermissionRuleset): void

  /**
   * 获取当前规则集（可用于调试/序列化）
   */
  getRules(): PermissionRuleset
}

// ===== 工具函数 =====

/**
 * 路径 glob 匹配（简化版，支持 * / ** / ?）
 * 实际实现可使用 minimatch / picomatch
 */
export function matchGlob(pattern: string, path: string): boolean {
  // 简化实现：** 匹配任意层级，* 匹配单层
  const regex = globToRegExp(pattern)
  return regex.test(path)
}

/** 将 glob 模式转换为正则表达式 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLESTAR>>/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}
