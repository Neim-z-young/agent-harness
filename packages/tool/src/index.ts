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

// ===== Tool 自定义错误 =====

/** Schema 校验失败错误（inputSchema 或 outputSchema） */
export class ToolSchemaError extends Error {
  /** 'input' 或 'output' */
  readonly stage: 'input' | 'output'
  readonly toolId: string
  readonly cause: unknown

  constructor(toolId: string, stage: 'input' | 'output', cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause)
    super(`[${toolId}] ${stage} schema validation failed: ${causeMsg}`)
    this.name = 'ToolSchemaError'
    this.toolId = toolId
    this.stage = stage
    this.cause = cause
  }
}

/** 语义校验失败错误（validateInput） */
export class ToolValidationError extends Error {
  readonly toolId: string
  readonly cause: unknown

  constructor(toolId: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause)
    super(`[${toolId}] semantic validation failed: ${causeMsg}`)
    this.name = 'ToolValidationError'
    this.toolId = toolId
    this.cause = cause
  }
}

/** 权限拒绝错误 */
export class ToolPermissionDeniedError extends Error {
  readonly toolId: string
  readonly toolKey?: string
  readonly patterns?: string[]

  constructor(toolId: string, toolKey?: string, patterns?: string[]) {
    super(`[${toolId}] permission denied (key=${toolKey ?? 'n/a'}, patterns=${JSON.stringify(patterns)})`)
    this.name = 'ToolPermissionDeniedError'
    this.toolId = toolId
    this.toolKey = toolKey
    this.patterns = patterns
  }
}

/** 权限需要询问用户错误（Pipeline 无法自行决策，返回给上层 UI 处理） */
export class ToolPermissionAskRequiredError extends Error {
  readonly toolId: string
  readonly toolKey?: string
  readonly patterns?: string[]

  constructor(toolId: string, toolKey?: string, patterns?: string[]) {
    super(`[${toolId}] user permission required (key=${toolKey ?? 'n/a'})`)
    this.name = 'ToolPermissionAskRequiredError'
    this.toolId = toolId
    this.toolKey = toolKey
    this.patterns = patterns
  }
}

// ===== Tool Pipeline Hooks =====

/** PreHook 回调：在权限检查之后、真正 tool.call 之前被调用（中间件风格支持 next） */
export interface ToolPreHookContext {
  tool: Tool
  input: unknown
  ctx: ToolContext
  toolUseId: string
}

export type ToolPreHook = (
  ctx: ToolPreHookContext,
  next: (modifiedInput?: unknown) => Promise<ToolResult>
) => Promise<ToolResult>

/** PostHook 回调：在 tool.call 返回结果之后调用（可观察/修改结果） */
export interface ToolPostHookContext {
  tool: Tool
  input: unknown
  ctx: ToolContext
  toolUseId: string
}

export type ToolPostHook = (ctx: ToolPostHookContext, result: ToolResult) => Awaitable<ToolResult>

// ===== ToolRegistry =====

/** 注册参数 */
export interface ToolRegisterOptions {
  /** 若 ID 已存在是否覆盖，默认 false 抛错 */
  override?: boolean
}

/**
 * ToolRegistry：工具注册中心
 *
 * 负责：
 * - register / unregister / get / has 基本 CRUD
 * - alias 解析（工具别名也可查找）
 * - filterByWhitelist：按 Agent 的 tools 白名单过滤
 * - toSchemas：导出给 LLM 的工具 schema 描述（需要适配具体 Provider 时做转换）
 */
export class ToolRegistry {
  private readonly byId = new Map<string, Tool>()

  /**
   * 注册一个工具
   * @throws 如果 ID 已存在且 options.override !== true
   */
  register(tool: Tool, options: ToolRegisterOptions = {}): this {
    if (this.byId.has(tool.id) && !options.override) {
      throw new Error(`ToolRegistry: tool id "${tool.id}" already registered`)
    }
    this.byId.set(tool.id, tool)
    return this
  }

  /** 批量注册（按数组顺序依次 register） */
  registerAll(tools: Tool[], options: ToolRegisterOptions = {}): this {
    for (const t of tools) this.register(t, options)
    return this
  }

  /** 注销工具（ID 不存在时忽略） */
  unregister(toolId: string): this {
    this.byId.delete(toolId)
    return this
  }

  /** 是否存在（ID 或 alias 匹配） */
  has(idOrAlias: string): boolean {
    if (this.byId.has(idOrAlias)) return true
    for (const t of this.byId.values()) {
      if (t.aliases?.includes(idOrAlias)) return true
    }
    return false
  }

  /**
   * 获取工具实例（ID 或 alias 查找）
   * @returns Tool 或 undefined
   */
  get(idOrAlias: string): Tool | undefined {
    const direct = this.byId.get(idOrAlias)
    if (direct) return direct
    for (const t of this.byId.values()) {
      if (t.aliases?.includes(idOrAlias)) return t
    }
    return undefined
  }

  /** 列出所有已注册工具 */
  list(): Tool[] {
    return Array.from(this.byId.values())
  }

  /** 当前注册数量 */
  get size(): number {
    return this.byId.size
  }

  /**
   * 按 Agent 的工具白名单过滤
   *
   * 规则：
   * - whitelist = ['*'] → 全部放行
   * - 否则：只保留 ID 在列表里的工具，并同时匹配 alias
   */
  filterByWhitelist(whitelist: string[] | ['*']): Tool[] {
    if (whitelist.length === 1 && whitelist[0] === '*') {
      return this.list()
    }
    const result: Tool[] = []
    for (const id of whitelist as string[]) {
      const t = this.get(id)
      if (t && !result.includes(t)) result.push(t)
    }
    return result
  }

  /** 清空注册表 */
  clear(): void {
    this.byId.clear()
  }
}

// ===== ToolPipeline =====

/** ToolPipeline 构造参数 */
export interface ToolPipelineOptions {
  /** 权限检查实现（通常由 PermissionEngine 提供），缺省时跳过权限检查（开发模式） */
  checkPermission?: (req: PermissionRequest) => Awaitable<PermissionDecision>
  /** PreHook 列表（按注册顺序执行，洋葱模型） */
  preHooks?: ToolPreHook[]
  /** PostHook 列表（按注册顺序执行） */
  postHooks?: ToolPostHook[]
  /** outputSchema 校验失败时是抛错还是降级为 warning，默认 false（抛错） */
  softOutputSchema?: boolean
  /** 结果最大字符数截断（用于 ToolResult string 输出，防止 LLM 上下文爆炸），默认 200k */
  resultMaxChars?: number
}

/**
 * ToolPipeline：工具调用 7 步生命周期执行器
 *
 * 1. inputSchema.safeParse 硬校验 → 失败抛 ToolSchemaError(stage=input)
 * 2. tool.validateInput 语义校验 → 失败抛 ToolValidationError
 * 3. PreHook 洋葱模型管道（可修改 input）
 * 4. PermissionEngine.check()（若声明了 tool.permission）：
 *    - allow → 继续
 *    - ask   → 抛 ToolPermissionAskRequiredError（交给上层处理用户交互）
 *    - deny  → 抛 ToolPermissionDeniedError
 * 5. tool.call() 真正调用（含耗时统计、AbortSignal 中断检查）
 * 6. outputSchema 校验（soft 模式降级为日志，默认抛错）
 * 7. PostHook 管道（可修改 result）+ 超大结果截断
 */
export class ToolPipeline {
  private readonly checkPermission?: ToolPipelineOptions['checkPermission']
  private readonly preHooks: ToolPreHook[]
  private readonly postHooks: ToolPostHook[]
  private readonly softOutputSchema: boolean
  private readonly resultMaxChars: number

  constructor(options: ToolPipelineOptions = {}) {
    this.checkPermission = options.checkPermission
    this.preHooks = options.preHooks ?? []
    this.postHooks = options.postHooks ?? []
    this.softOutputSchema = options.softOutputSchema ?? false
    this.resultMaxChars = options.resultMaxChars ?? 200_000
  }

  /** 新增 PreHook（链式调用） */
  addPreHook(hook: ToolPreHook): this {
    this.preHooks.push(hook)
    return this
  }

  /** 新增 PostHook（链式调用） */
  addPostHook(hook: ToolPostHook): this {
    this.postHooks.push(hook)
    return this
  }

  /**
   * 执行一次工具调用（7 步生命周期）
   */
  async execute(
    tool: Tool,
    rawInput: unknown,
    ctx: ToolContext,
    onProgress?: (p: unknown) => void
  ): Promise<ToolResult> {
    const startedAt = performance.now()

    // --- Step 1: inputSchema 硬校验 ---
    const parseResult = tool.inputSchema.safeParse(rawInput)
    if (!parseResult.success) {
      throw new ToolSchemaError(tool.id, 'input', parseResult.error)
    }
    let input: unknown = parseResult.data

    // --- Step 2: 语义校验（validateInput）---
    if (tool.validateInput) {
      try {
        await tool.validateInput(input as any, ctx)
      } catch (err) {
        throw new ToolValidationError(tool.id, err)
      }
    }

    // --- 构造 preHook context ---
    const preCtx: ToolPreHookContext = {
      tool,
      input,
      ctx,
      toolUseId: ctx.toolUseId,
    }

    // --- Step 3: PreHook 洋葱管道 + Step 4 权限 + Step 5 tool.call ---
    // PreHook 采用洋葱模型：第一个 hook 的 next 是第二个 hook，... 最后一个 hook 的 next = doExecute()
    const index = 0
    const doExecute = async (finalInput: unknown = input): Promise<ToolResult> => {
      input = finalInput

      // Step 4: 权限检查（声明了 permission + 有 checkPermission 实现时）
      if (tool.permission && this.checkPermission) {
        const permReq: PermissionRequest = {
          toolKey: tool.permission.key,
          patterns: tool.permission.extractPatterns(input as any),
          input,
        }
        const decision = await Promise.resolve(this.checkPermission(permReq))
        // 允许插件通过 updatedInput 重写输入（Claude Code 风格）
        if (decision.updatedInput !== undefined) {
          input = decision.updatedInput
        }
        switch (decision.behavior) {
          case 'deny':
            throw new ToolPermissionDeniedError(tool.id, permReq.toolKey, permReq.patterns)
          case 'ask':
            throw new ToolPermissionAskRequiredError(tool.id, permReq.toolKey, permReq.patterns)
          case 'allow':
          default:
            // 放行
            break
        }
      }

      // 中断检查
      ctx.signal.throwIfAborted?.()

      // Step 5: tool.call() 真正执行
      const callStartedAt = performance.now()
      const result0 = await tool.call(input as any, ctx, onProgress)
      const callDurationMs = performance.now() - callStartedAt

      // 附加耗时元数据
      const result: ToolResult = {
        ...result0,
        meta: {
          durationMs: callDurationMs,
          ...(result0.meta ?? {}),
        },
      }

      // --- Step 6: outputSchema 校验（可选）---
      if (tool.outputSchema && result.ok && result.output !== undefined) {
        const r = tool.outputSchema.safeParse(result.output)
        if (!r.success) {
          if (this.softOutputSchema) {
            // soft：仅日志，不抛错
            ctx.log?.error?.('outputSchema failed', { toolId: tool.id, error: r.error })
          } else {
            throw new ToolSchemaError(tool.id, 'output', r.error)
          }
        } else {
          result.output = r.data
        }
      }

      // --- 截断超大结果（string / object→JSON.stringfy→截断→转回字符串提示）---
      this.truncateLargeResult(result, this.resultMaxChars)

      // 附加总耗时 meta
      result.meta = {
        ...(result.meta ?? {}),
        totalDurationMs: performance.now() - startedAt,
      }
      return result
    }

    // PreHook 洋葱调用链
    const dispatch = async (hookIndex: number, currentInput: unknown): Promise<ToolResult> => {
      if (hookIndex >= this.preHooks.length) {
        return doExecute(currentInput)
      }
      const hook = this.preHooks[hookIndex]!
      // 每个 hook 的 preCtx 能看到最新 input
      const c: ToolPreHookContext = { ...preCtx, input: currentInput }
      return hook(c, async (modifiedInput?: unknown): Promise<ToolResult> => {
        return dispatch(hookIndex + 1, modifiedInput ?? currentInput)
      })
    }

    let result = await dispatch(index, input)

    // --- Step 7: PostHook 管道（按顺序）---
    const postCtx: ToolPostHookContext = {
      tool,
      input,
      ctx,
      toolUseId: ctx.toolUseId,
    }
    for (const hook of this.postHooks) {
      result = await Promise.resolve(hook(postCtx, result))
    }

    return result
  }

  /** 截断超大 ToolResult 输出（仅用于展示层提示，不破坏原结构时尽量保留） */
  private truncateLargeResult(result: ToolResult, maxChars: number): void {
    if (!result.ok || result.output === undefined) return
    if (typeof result.output === 'string') {
      if (result.output.length > maxChars) {
        const truncated = result.output.slice(0, maxChars)
        result.output = truncated + `\n... [truncated, original length=${result.output.length}]` as any
      }
    } else {
      // 对象/数组：尝试 JSON.stringify 估计大小，超了则提示并替换
      try {
        const s = JSON.stringify(result.output)
        if (s.length > maxChars) {
          result.output = s.slice(0, maxChars) + `\n... [truncated, original length=${s.length}]` as any
        }
      } catch {
        // 不可序列化忽略
      }
    }
  }
}
