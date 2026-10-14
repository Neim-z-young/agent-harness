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

import { createHash } from 'node:crypto'

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
 * ## 归属作用域键（P0-9）
 * 除工具键外，键还可以带**归属作用域前缀**，把同一工具规则按"给谁"分开：
 * - `session:<sid>|<toolKey>` —— 只对某个会话生效（见 {@link sessionScopeKey}）
 * - `caller:<hash>|<toolKey>` —— 只对某个调用方生效（见 {@link callerScopeKey}）
 *
 * 匹配优先级（`DefaultPermissionEngine.check`）：
 * `session:<sid>|<toolKey>` → `session:<sid>|*` → `caller:<hash>|<toolKey>` → `caller:<hash>|*`
 * → `<toolKey>` → `*`，逐层回退。**无归属（两面都拿不到）时只剩后两层 ⇒ 行为与分层前逐位相同。**
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
 *   'caller:9f2a1c8e7b3d05a4|bash': { allow: ['npm test'] },  // 仅该调用方免问
 *   '*': 'ask',                              // 其他工具默认询问
 * }
 */
export interface PermissionRuleset {
  [toolKey: string]: ToolPermissionRule | undefined
  /**
   * 全局默认规则（兜底）。**不限于简写**：自 P0-8 起，全局也可以是 **PathRules**，
   * 其 `deny` 对所有形态的工具规则行使**否决权**（string 工具规则没有自己的 deny 列表，
   * 不在这层兜底就是一条"绕过一切 deny"的通道）。见 `DefaultPermissionEngine.check`。
   */
  '*'?: ToolPermissionRule
}

// ===== 归属作用域键（P0-9）=====

/** 作用域与工具键的分隔符（工具权限键是标识符，不含 `|`） */
export const SCOPE_SEPARATOR = '|'

/** 会话作用域前缀 */
export const SESSION_SCOPE_PREFIX = 'session:'

/** 调用方作用域前缀 */
export const CALLER_SCOPE_PREFIX = 'caller:'

/** 会话作用域键：`session:<sessionId>` */
export function sessionScopeKey(sessionId: string): string {
  return `${SESSION_SCOPE_PREFIX}${sessionId}`
}

/**
 * 调用方作用域键：`caller:<principalHash>`（principal 先经 {@link hashPrincipal}）。
 *
 * ## ⚠️ 为什么必须哈希，不能直接用调用方标识
 * A2A 的调用方标识**就是 Bearer token 本身**（`a2a-server/src/auth.ts` 的 `callerKey()`：
 * 「配了 token ⇒ 用 token 本身当键」，且该注释明确要求"绝不落日志 / 不回报"）。
 * 而作用域键会**落盘**到 `<dataDir>/permissions.json` —— 直接把 token 写进去等于
 * **把凭据持久化**。哈希后不可逆（token 高熵，无需加盐），既保持"跨重启稳定"，
 * 又不留任何明文。这也是 `PermissionDecision.matchedPattern` 从不回填作用域键的原因。
 */
export function callerScopeKey(principal: string): string {
  return `${CALLER_SCOPE_PREFIX}${hashPrincipal(principal)}`
}

/** 主体标识 → 16 位十六进制摘要（sha256 前缀，零明文；见 {@link callerScopeKey}） */
export function hashPrincipal(principal: string): string {
  return createHash('sha256').update(principal).digest('hex').slice(0, 16)
}

/**
 * 拼归属规则键：`<scope>|<toolKey>`。
 * `scope` 取自 {@link sessionScopeKey} / {@link callerScopeKey}。
 */
export function scopedRuleKey(scope: string, toolKey: string): string {
  return `${scope}${SCOPE_SEPARATOR}${toolKey}`
}

/** 该规则键是否是"作用域通配"（`*` 或 `<scope>|*`）—— 全局 deny 否决权只扫这些键 */
export function isScopeWildcardKey(key: string): boolean {
  return key === '*' || key.endsWith(`${SCOPE_SEPARATOR}*`)
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
  /**
   * 命中的**归属作用域**（P0-9，见 {@link sessionScopeKey} / {@link callerScopeKey}）。
   * 缺省 `undefined` = 命中未分归属的规则（工具键 / `*`）。
   *
   * 为什么单独一个字段而不是塞进 `matchedRule`：`matchedRule` 描述的是**规则的形态**
   * （精确 / glob / 工具级 / 全局），归属描述的是**给谁**。两者是正交维度，混进同一个
   * 联合类型后，"caller 层的一条 glob 规则"就无处安放。
   */
  matchedScope?: 'session' | 'caller'
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
  /**
   * 发起该请求的会话 ID（由 ToolPipeline 从 `ToolContext.sessionId` 填入）。
   *
   * 为什么需要：`asker` 是**全局单槽**（`InteractivePermissionEngine.setAsker`），而同一
   * 进程里可能同时存在多个"询问源" —— TUI 里的 Agent、A2A 任务、本进程的 MCP server。
   * 没有归属信息时，后装的 asker 无法判断"这次询问该由谁应答"，只能顶掉前一个
   * （并发下互相串台）。带上会话 ID 后，包装型 asker 可据此路由：属于自己接管的会话
   * ⇒ 自己应答；否则委派给被包装的原 asker。
   *
   * 为什么可选：既有引擎实现与测试桩只读 `toolKey` / `patterns`，不应因新增归属信息被迫
   * 改写；且工具内直接调 `ctx.requestPermission` 的场景未必拿得到会话归属 —— 缺省即
   * "无归属"，按既有行为处理。
   */
  sessionId?: string
  /**
   * 仅参与 **deny** 判定的附加 pattern（可选，如 bash 的段级命令）。
   * allow/ask 是任一 pattern 命中即生效，混入段级 pattern 会放宽它们；
   * deny 是任一命中即拒绝 —— 本字段只进 deny 判定，只收紧不放宽。
   */
  denyPatterns?: string[]
  /**
   * **沙箱档位下沉**标记（P0-7）。`'host-fallback'` = 这次不是普通工具授权，而是把命令
   * 从沙箱约束升到**宿主全权**执行。引擎据此**无条件留审计**（`sandbox.escalation`），
   * 覆盖 `allow-all` 下"没问人、自动放行"那条静默路径。语义与
   * `@harness/tool` 的同名字段一致（两侧都声明是为了 core 的 cast 不丢字段）。
   */
  escalation?: 'host-fallback'
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
   * 设置 **agent 约束层**（可选举缝）。
   *
   * agent 定义里的 `permission` 是**约束**（如只读子 agent 声明 `{ '*': 'deny' }`），
   * 语义上**只收紧不放宽**，绝不能整键覆盖用户基线规则。实现方应把它与用户基线
   * **分层合成**（最严者胜，见 `@harness/core` 的 `composeRules`），且**不进持久化**。
   *
   * 缺省（不实现）⇒ 引擎无 agent 约束概念，core 跳过该层。`DefaultPermissionEngine` 已实现。
   */
  setAgentRules?(rules: PermissionRuleset | undefined): void

  /**
   * 获取当前规则集（可用于调试/序列化）
   *
   * ⚠️ 实现方应返回**用户基线**（不含 agent 约束层）—— 展示与持久化都读它，
   * 混入 agent 约束会把"运行时约束"误当"用户配置"落盘。
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

/**
 * 将 glob 模式转换为正则表达式。
 *
 * 替换顺序是**刻意**的：先把 `**` 换成占位符、再把 `?` 换掉，最后才把占位符展开 ——
 * 因为展开出来的正则片段自身含星号与问号，若放在后面处理会被前两步再次改写
 * （`(?:` 里那个问号会被当成通配符吃掉，非捕获组的语义随之坏掉）。
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    // `**/x` 也要匹配根级的 `x`（标准 glob 语义；minimatch 同此）。
    // 修正前的 `.*\/x` 要求**至少一层目录**，于是 `**/*.ts` 漏掉根级 `a.ts`、
    // `deny: ['**/secrets*']` 漏掉根级 `secrets.txt` —— 后者是**不安全方向**的漏判。
    .replace(/<<DOUBLESTAR>>\//g, '(?:.*/)?')
    .replace(/<<DOUBLESTAR>>/g, '.*')
  return new RegExp(`^${escaped}$`)
}
