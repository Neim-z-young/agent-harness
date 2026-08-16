/**
 * @harness/tool - Tool 运行时协议
 *
 * Tool 是完整的运行时协议对象，不只是 call() 函数。
 * 包含：
 * - 安全声明（Fail-Closed 默认值）
 * - Schema 校验（inputSchema / outputSchema）
 * - 语义校验（validateInput）
 * - 权限声明（permission.key + extractPatterns）
 * - 执行入口（call）
 * - UI 呈现（renderUse / renderResult / renderError）
 *
 * 同时提供 Tool.define() 工厂函数和 partitionToolCalls 并发分批调度。
 */

// ===== 基础工具类型 =====

/** 支持 Promise 或同步值的类型 */
export type Awaitable<T> = T | Promise<T>

/**
 * 通用 Schema 接口（抽象层，兼容 zod / valibot / 自定义校验）
 * 用于 Tool 的 inputSchema / outputSchema 硬校验
 */
export interface Schema<T> {
  /** 严格解析，失败抛错 */
  parse(value: unknown): T
  /** 安全解析，返回结果对象 */
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }
}

// ===== ToolContext =====

/** 权限请求（由 Tool 通过 ctx.requestPermission 发起） */
export interface PermissionRequest {
  /** 权限键："write" / "bash" / "read" */
  toolKey: string
  /** 提取的路径或命令模式 */
  patterns: string[]
  /** 原始输入 */
  input: unknown
}

/** 权限决策（由 PermissionEngine 返回） */
export interface PermissionDecision {
  /** 最终行为：allow / deny / ask */
  behavior: 'allow' | 'deny' | 'ask'
  /** 修正后的输入参数（插件可深度修改） */
  updatedInput?: unknown
  /** 是否记住决策（用户选"始终允许"时写回规则） */
  remember?: boolean
}

/**
 * 工具执行上下文（每次调用注入）
 * 由 Agent Runtime 在调用 tool.call() 时构造
 */
export interface ToolContext {
  /** 当前会话 ID */
  sessionId: string
  /** 当前 Agent ID */
  agentId: string
  /** 当前消息 ID */
  messageId: string
  /** 工具调用 ID（LLM 生成的 tool_use_id） */
  toolUseId: string
  /** AbortSignal，用于中断长任务 */
  signal: AbortSignal
  /** 上下文变量（DI 容器派生） */
  variables: Record<string, unknown>
  /** 当前工作目录 */
  cwd: string
  /** 请求权限的回调（由 PermissionEngine 提供） */
  requestPermission?: (req: PermissionRequest) => Promise<PermissionDecision>
  /** 日志器 */
  log?: {
    info(msg: string, meta?: unknown): void
    warn(msg: string, meta?: unknown): void
    error(msg: string, meta?: unknown): void
  }
}

// ===== ToolResult =====

/**
 * 工具执行结果
 * ok=true 时 output 有值，ok=false 时 error 有值
 */
export interface ToolResult<T = unknown> {
  /** 是否成功 */
  ok: boolean
  /** 输出值（ok=true 时） */
  output?: T
  /** 错误信息（ok=false 时） */
  error?: {
    message: string
    code?: string
    cause?: unknown
  }
  /** 元数据（执行耗时、token 用量等） */
  meta?: {
    durationMs?: number
    tokenUsage?: number
    [key: string]: unknown
  }
  /** 是否被用户中断 */
  interrupted?: boolean
}

// ===== Tool 接口 =====

/**
 * Tool 运行时协议
 *
 * 安全声明采用 Fail-Closed 策略：
 * 所有安全相关字段默认值都是最保守的（false），
 * 必须由工具显式声明为 true 才会启用相应能力。
 */
export interface Tool<Input = any, Output = any, Progress = any> {
  // === 标识 ===
  /** 工具唯一 ID（如 "read_file"、"edit_file"） */
  id: string
  /** 别名（兼容旧名） */
  aliases?: string[]
  /** 给 AI 看的短描述 */
  description: string
  /** 给 AI 看的完整文档（.txt 等价内容） */
  documentation?: string
  /** 搜索提示（用于工具选择/路由） */
  searchHint?: string

  // === 安全声明（Fail-Closed：所有默认值都是最保守的 false）===
  /** 是否并发安全（默认 false，必须显式声明 true 才并发执行） */
  isConcurrencySafe?: (input?: Input) => boolean
  /** 是否只读操作（默认 false，保守认为有写副作用） */
  isReadOnly?: (input?: Input) => boolean
  /** 是否破坏性操作（删除/覆盖等，默认 false） */
  isDestructive?: (input?: Input) => boolean
  /** 是否需要用户交互（如 AskUserQuestionTool，默认 false） */
  requiresUserInteraction?: boolean

  // === Schema ===
  /** 输入 schema（zod / 自定义，硬校验） */
  inputSchema: Schema<Input>
  /** 输出 schema（可选，校验结果） */
  outputSchema?: Schema<Output>

  // === 语义校验（独立于 Schema，如 Edit 工具字符串存在性校验）===
  validateInput?: (input: Input, ctx: ToolContext) => Awaitable<void>

  // === 权限（路径级匹配，配合 PermissionEngine）===
  permission?: {
    /** 权限键："write" / "bash" / "read" */
    key: string
    /** 提取需要权限的路径或命令模板 */
    extractPatterns: (input: Input) => string[]
  }

  // === 执行入口 ===
  call(
    input: Input,
    ctx: ToolContext,
    onProgress?: (p: Progress) => void
  ): Promise<ToolResult<Output>>

  // === UI 呈现（可选，插件可自定义渲染）===
  /** 渲染工具调用参数 */
  renderUse?: (input: Input) => unknown
  /** 渲染工具执行结果 */
  renderResult?: (result: ToolResult<Output>) => unknown
  /** 渲染错误 */
  renderError?: (err: Error) => unknown
}

// ===== Fail-Closed 默认值 =====

/**
 * 工具安全声明默认值：Fail-Closed 策略
 * 所有未显式声明的安全字段都会回退到这里
 */
export const TOOL_DEFAULTS = {
  /** 默认不可并发（保守） */
  isConcurrencySafe: (() => false) as (input?: unknown) => boolean,
  /** 默认非只读（保守，认为有写副作用） */
  isReadOnly: (() => false) as (input?: unknown) => boolean,
  /** 默认非破坏性 */
  isDestructive: (() => false) as (input?: unknown) => boolean,
  /** 默认不需要用户交互 */
  requiresUserInteraction: false,
} as const

// ===== Tool.define 工厂函数 =====

/** Tool 定义参数（id/description/call/inputSchema 必填，其他可选） */
export type ToolDefinition<I = any, O = any, P = any> = {
  id: string
  description: string
  call: Tool<I, O, P>['call']
  inputSchema: Schema<I>
} & Partial<Omit<Tool<I, O, P>, 'id' | 'description' | 'call' | 'inputSchema'>>

/**
 * Tool 工厂函数：创建一个应用 Fail-Closed 默认值的 Tool 实例
 *
 * 所有未显式声明的安全字段都会回退到最保守的默认值。
 *
 * @example
 * const ReadFile = Tool.define({
 *   id: 'read_file',
 *   description: '读取文件内容',
 *   inputSchema: z.object({ path: z.string() }),
 *   isReadOnly: () => true,           // 显式声明只读
 *   isConcurrencySafe: () => true,    // 显式声明并发安全
 *   async call({ path }, ctx) {
 *     return { ok: true, output: await readFile(path) }
 *   }
 * })
 */
export function defineTool<I = any, O = any, P = any>(
  def: ToolDefinition<I, O, P>
): Tool<I, O, P> {
  return {
    // 应用 Fail-Closed 默认值
    isConcurrencySafe: TOOL_DEFAULTS.isConcurrencySafe,
    isReadOnly: TOOL_DEFAULTS.isReadOnly,
    isDestructive: TOOL_DEFAULTS.isDestructive,
    requiresUserInteraction: TOOL_DEFAULTS.requiresUserInteraction,
    // 用户定义（覆盖默认值）
    ...def,
  }
}

// Tool 命名空间：interface + namespace 合并
export namespace Tool {
  /** Tool 定义参数类型 */
  export type Definition<I = any, O = any, P = any> = ToolDefinition<I, O, P>
  /** 工厂函数别名 */
  export const define = defineTool
}

// ===== partitionToolCalls 并发分批调度 =====

/** 一次工具调用（含工具实例和输入） */
export interface ToolUse {
  toolId: string
  tool: Tool
  input: unknown
  toolUseId: string
}

/** 一批工具调用（同批次可并发，批次间串行） */
export interface ToolBatch {
  /** 该批次的工具调用 */
  uses: ToolUse[]
  /** 是否可并行执行（true = 并发，false = 串行） */
  parallel: boolean
  /** 上下文修改器（延迟应用，防竞态） */
  contextModifier?: (ctx: ToolContext) => ToolContext
}

/**
 * 并发分批调度：按 isConcurrencySafe 把工具调用分成多个批次
 *
 * 策略（参考 Claude Code partitionToolCalls）：
 * - 连续并发安全的工具合批并行执行
 * - 非并发安全的工具各自串行批次
 * - 批次间 contextModifier 延迟应用（防止竞态污染）
 *
 * @example
 * const batches = partitionToolCalls([
 *   { tool: ReadFile, ... },   // safe
 *   { tool: ReadFile, ... },   // safe → 合批并行
 *   { tool: WriteFile, ... },  // unsafe → 单独批次串行
 *   { tool: ReadFile, ... },   // safe → 新批次并行
 * ])
 * // 3 个批次：[parallel, serial, parallel]
 */
export function partitionToolCalls(uses: ToolUse[]): ToolBatch[] {
  const batches: ToolBatch[] = []
  let currentBatch: ToolBatch | null = null

  for (const use of uses) {
    const safe = use.tool.isConcurrencySafe?.(use.input) ?? false

    if (safe) {
      // 并发安全：尝试合批
      if (!currentBatch || !currentBatch.parallel) {
        // 开新并行批次
        currentBatch = { uses: [use], parallel: true }
        batches.push(currentBatch)
      } else {
        // 加入当前并行批次
        currentBatch.uses.push(use)
      }
    } else {
      // 非并发安全：单独串行批次
      currentBatch = { uses: [use], parallel: false }
      batches.push(currentBatch)
    }
  }

  return batches
}
