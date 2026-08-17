/**
 * @harness/core - Harness 核心编排器
 *
 * 顶层实例，纯逻辑内核，统一编排：
 * - 生命周期（init→start→stop）串联 Bus 事件 + Plugin Hooks
 * - 能力模块访问器（session/agent/plugin/bus/tool/permission/skill/context）
 * - Tool Pipeline 接入 Plugin hooks（pre/post 管道桥接）
 * - LLM 调用链路（ChatProvider → llm.params 钩子）
 *
 * 同一套内核可嵌入 SDK/CLI/IDE/Worker/Server 多形态。
 */

// ===== Re-export 常用基础类型 =====
// value re-exports（class / function / namespace）
export {
  BusEvent,
  createBus,
  InMemoryBus,
} from '@harness/bus'
// type-only re-exports（interface / type alias）
export type {
  Awaitable,
  Bus,
  BusEventRecord,
  EventPayload,
  EventSchema,
  EventSubscriber,
  Unsubscribe,
} from '@harness/bus'

export {
  createPluginManager,
  PluginManagerImpl,
  PluginDuplicateIdError,
  PluginNotFoundError,
  PluginCircularDependencyError,
  PluginMissingDependencyError,
  PluginInstallError,
  PluginUninstallError,
  PluginHookError,
  topologicalSortPlugins,
  HooksRegistry,
} from '@harness/plugin'
export type {
  AgentPlugin,
  Hooks,
  LoadedPlugin,
  PluginContext,
  PluginManager,
  PluginManagerOptions,
  ToolPool,
  HarnessInitInput,
  HarnessInitOutput,
  HarnessStartInput,
  HarnessStartOutput,
  ToolPoolAssembleInput,
  LLMInput,
  LLMParams,
  PromptInput,
  CompactionContext,
  PermissionRequestLike,
  PermissionDecisionLike,
} from '@harness/plugin'

export {
  defineTool,
  Tool,
  TOOL_DEFAULTS,
  ToolRegistry,
  ToolPipeline,
  ToolSchemaError,
  ToolValidationError,
  ToolPermissionDeniedError,
  ToolPermissionAskRequiredError,
} from '@harness/tool'
export type {
  Awaitable as ToolAwaitable,
  Schema,
  PermissionRequest as ToolPermissionRequest,
  PermissionDecision as ToolPermissionDecision,
  ToolContext,
  ToolDefinition,
  ToolPreHookContext,
  ToolPreHook,
  ToolPostHookContext,
  ToolPostHook,
  ToolRegisterOptions,
  ToolResult,
  ToolPipelineOptions,
} from '@harness/tool'

export type {
  AgentDefinition,
  AgentMode,
  AgentModelPreference,
  AgentPermissionConfig,
  SwarmCapabilities,
} from '@harness/agent'

export {
  matchGlob,
} from '@harness/permission'
export type {
  Awaitable as PermissionAwaitable,
  PermissionBehavior,
  PathRules,
  ToolPermissionRule,
  PermissionRuleset,
  PermissionDecision,
  PermissionRequest,
  PermissionEngine,
} from '@harness/permission'

export type {
  Awaitable as SkillAwaitable,
  SkillSource,
  SkillEffort,
  SkillEmbed,
  Skill,
  SkillManager,
} from '@harness/skill'

export type {
  Part,
  TextPart,
  ToolCallPart,
  FilePart,
  ReasoningPart,
  PatchPart,
  ImagePart,
  MessageRole,
  Message,
  Session,
  SessionCreateOptions,
  SessionListOptions,
  CompactionStrategy,
  SessionManager,
} from '@harness/session'

// ===== 内部依赖 =====
import { createBus, InMemoryBus, Bus, BusEvent, BusEventRecord, Awaitable } from '@harness/bus'
import {
  AgentPlugin,
  createPluginManager,
  Hooks,
  PluginManager,
  PluginManagerOptions,
  HarnessInitInput as PluginHarnessInitInput,
  HarnessInitOutput as PluginHarnessInitOutput,
  HarnessStartInput as PluginHarnessStartInput,
  HarnessStartOutput as PluginHarnessStartOutput,
  ToolPoolAssembleInput,
  ToolPool as PluginToolPool,
  LLMInput,
  LLMParams,
  PromptInput,
} from '@harness/plugin'
import {
  Tool,
  ToolResult,
  ToolRegistry,
  ToolPipeline,
  ToolPreHook,
  ToolPreHookContext,
  ToolPostHook,
  ToolPostHookContext,
  ToolContext,
  PermissionRequest as ToolPermissionRequest,
  PermissionDecision as ToolPermissionDecision,
} from '@harness/tool'
import type {
  AgentDefinition,
} from '@harness/agent'
import type {
  PermissionRuleset,
  PermissionEngine,
  PermissionRequest as PermRequest,
  PermissionDecision as PermDecision,
} from '@harness/permission'
import type {
  Message,
  Session,
  SessionCreateOptions,
  SessionListOptions,
  SessionManager,
  CompactionStrategy,
} from '@harness/session'

// ========================================================================
// 1. ContextProvider (DI 容器)
// ========================================================================

export interface ContextProvider {
  /** 注册依赖 */
  register<T>(key: string, value: T): void
  /** 获取依赖（同步） */
  resolve<T>(key: string): T | undefined
  /** 获取依赖（异步，支持懒加载） */
  resolveAsync<T>(key: string): Promise<T | undefined>
  /** 创建子上下文（隔离作用域，fallback 父） */
  createChild(): ContextProvider
}

/** 默认内存 DI 容器 */
export class DefaultContextProvider implements ContextProvider {
  private readonly values = new Map<string, unknown>()
  constructor(private readonly parent?: DefaultContextProvider) {}
  register<T>(key: string, value: T): void {
    this.values.set(key, value)
  }
  resolve<T>(key: string): T | undefined {
    if (this.values.has(key)) return this.values.get(key) as T | undefined
    return this.parent?.resolve<T>(key)
  }
  async resolveAsync<T>(key: string): Promise<T | undefined> {
    return this.resolve<T>(key)
  }
  createChild(): DefaultContextProvider {
    return new DefaultContextProvider(this)
  }
}

// ========================================================================
// 2. PermissionEngine 默认实现（内存 + 4 级 glob 匹配）
// ========================================================================

function defaultGlob(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLESTAR>>/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`).test(path)
}

export class DefaultPermissionEngine implements PermissionEngine {
  private rules: PermissionRuleset
  constructor(rules: PermissionRuleset = { '*': 'ask' }) {
    this.rules = { ...rules }
  }

  updateRules(rules: PermissionRuleset): void {
    this.rules = { ...rules }
  }
  getRules(): PermissionRuleset {
    return { ...this.rules }
  }

  async check(req: PermRequest): Promise<PermDecision> {
    const { toolKey, patterns } = req
    const toolRule = this.rules[toolKey]
    const globalRule = this.rules['*']

    // behavior ask 时的默认匹配：tool/global
    let behavior: PermDecision['behavior'] | undefined
    let matched: PermDecision['matchedRule'] | undefined
    let matchedPattern: string | undefined

    const applyPathRule = (pr: { allow?: string[]; deny?: string[]; ask?: string[] }) => {
      for (const pat of patterns) {
        if (pr.allow?.some((p) => defaultGlob(p, pat))) {
          behavior = 'allow'; matched = 'glob'; matchedPattern = pat; return true
        }
      }
      for (const pat of patterns) {
        if (pr.deny?.some((p) => defaultGlob(p, pat))) {
          behavior = 'deny'; matched = 'glob'; matchedPattern = pat; return true
        }
      }
      for (const pat of patterns) {
        if (pr.ask?.some((p) => defaultGlob(p, pat))) {
          behavior = 'ask'; matched = 'glob'; matchedPattern = pat; return true
        }
      }
      return false
    }

    if (typeof toolRule === 'object' && toolRule) {
      if (applyPathRule(toolRule)) {
        return { behavior: behavior!, matchedRule: matched, matchedPattern }
      }
    }
    if (typeof toolRule === 'string') {
      return { behavior: toolRule, matchedRule: 'tool', matchedPattern: toolKey }
    }
    if (typeof globalRule === 'string') {
      return { behavior: globalRule, matchedRule: 'global', matchedPattern: '*' }
    }
    return { behavior: 'ask', matchedRule: 'global', matchedPattern: '*' }
  }

  async ask(_req: PermRequest): Promise<PermDecision> {
    // 默认实现：无人交互，保守 ask→deny，由上层（CLI/IDE）覆盖 ask 回调
    return { behavior: 'deny', matchedRule: 'tool', matchedPattern: '(default deny for ask)' }
  }
}

// ========================================================================
// 3. ChatProvider（LLM 抽象）+ llm.params Hook 桥
// ========================================================================

/** LLM 完成消息（文本或流式） */
export interface ChatCompletionOutput {
  /** 文本内容 */
  content: string
  /** 工具调用（若模型支持） */
  toolCalls?: Array<{
    toolUseId: string
    toolId: string
    input: unknown
  }>
  /** 推理内容（reasoning） */
  reasoning?: string
  /** 模型名 */
  model?: string
  /** token 统计 */
  tokenUsage?: { input: number; output: number; total?: number }
  /** 原始响应，透传给插件 */
  raw?: unknown
}

// --- 流式类型 ---

/** ChatProvider 流式输出的增量 chunk */
export interface ChatStreamChunk {
  type:
    | 'text_delta'        // 文本增量
    | 'reasoning_delta'   // 推理增量
    | 'tool_use_start'    // 工具调用开始（含 id/name）
    | 'tool_use_delta'    // 工具调用 input 增量（部分 JSON 字符串）
    | 'tool_use_stop'    // 工具调用结束
    | 'done'             // 流结束（含 model/usage/raw）
  /** text_delta / reasoning_delta 的文本片段 */
  text?: string
  /** tool_use_start 的工具调用 ID */
  toolUseId?: string
  /** tool_use_start 的工具名 */
  toolId?: string
  /** tool_use_delta 的部分 JSON 字符串 */
  inputDelta?: string
  /** done 时的模型名 */
  model?: string
  /** done 时的 token 统计 */
  tokenUsage?: { input: number; output: number; total?: number }
  /** done 时的原始响应 */
  raw?: unknown
}

/** AgentRuntime 流式事件（在 ChatStreamChunk 基础上增加工具执行结果） */
export interface AgentStreamEvent {
  type:
    | 'text_delta'
    | 'reasoning_delta'
    | 'tool_call_start'  // 工具开始执行（含 input 完整值）
    | 'tool_call_result' // 工具执行结果
    | 'done'             // 全部完成（含最终 assistant Message）
  text?: string
  toolUseId?: string
  toolId?: string
  input?: unknown
  result?: unknown
  isError?: boolean
  /** done 时的最终 assistant 消息 */
  message?: Message
}

/**
 * LLM Provider 接口
 * Harness 层通过此接口与具体模型提供商解耦。
 * Provider 插件通过 plugin.install → ctx.context.register('chat.provider', xxx) 注入。
 */
export interface ChatProvider {
  /** Provider ID，如 "anthropic" / "openai" */
  readonly id: string
  /** 执行一次 chat completion（非流式） */
  complete(params: {
    providerId: string
    modelId?: string
    messages: Message[]
    params: LLMParams
    headers?: Record<string, string>
    signal?: AbortSignal
    sessionId?: string
    agentId?: string
  }): Promise<ChatCompletionOutput>
  /**
   * 执行一次流式 chat completion，逐 chunk yield。
   * 若 Provider 未实现此方法，调用方可 fallback 到 complete()。
   */
  stream?(params: {
    providerId: string
    modelId?: string
    messages: Message[]
    params: LLMParams
    headers?: Record<string, string>
    signal?: AbortSignal
    sessionId?: string
    agentId?: string
  }): AsyncGenerator<ChatStreamChunk, void, unknown>
}

/** 默认空实现：无 Provider 时抛出清晰错误 */
class MissingChatProvider implements ChatProvider {
  readonly id = '__missing__'
  async complete(): Promise<ChatCompletionOutput> {
    throw new Error(
      'Harness: 未注册 ChatProvider。请安装 Provider 插件（如 @harness/provider-anthropic），' +
        '或在 AgentHarnessOptions.chatProvider 手动注入。'
    )
  }
}

// ========================================================================
// 4. ToolPool 实现（组装阶段，支持 hook 注入工具）
// ========================================================================

class DefaultToolPool implements PluginToolPool {
  private readonly registry: ToolRegistry
  constructor(registry: ToolRegistry) {
    this.registry = registry
  }
  add(tool: unknown): void {
    const t = tool as Tool
    if (!this.registry.has(t.id)) this.registry.register(t)
  }
  addAll(tools: unknown[]): void {
    for (const t of tools as Tool[]) if (!this.registry.has(t.id)) this.registry.register(t)
  }
  addIfMissing(toolIds: string[]): void {
    // noop: missing tools cannot be synthesized, caller responsibility
    void toolIds
  }
  remove(toolId: string): void {
    this.registry.unregister(toolId)
  }
  list(): unknown[] {
    return this.registry.list()
  }
}

// ========================================================================
// 5. DefaultSessionManager（内存实现；prompt 回调到 Harness Services）
// ========================================================================

/** 供 SessionManager 回调的内部服务 */
interface SessionServices {
  readonly agent: AgentRuntime
  readonly currentAgentId: () => string
}

export class DefaultSessionManager implements SessionManager {
  private readonly sessions = new Map<string, Session>()
  constructor(private readonly services?: () => SessionServices) {}

  async create(options: SessionCreateOptions = {}): Promise<Session> {
    const id = options?.title
      ? `s_${options.title.replace(/\W/g, '_')}_${Date.now()}`
      : `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const now = Date.now()
    const sess: Session = {
      id,
      title: options?.title,
      createdAt: now,
      updatedAt: now,
      agentId: options?.agentId,
      messages: [],
      cwd: options?.cwd,
      meta: options?.meta,
    }
    this.sessions.set(id, sess)
    return sess
  }

  async get(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId)
  }

  async list(options?: SessionListOptions): Promise<Session[]> {
    const items = Array.from(this.sessions.values())
    if (!options) return items
    let out = items
    if (options.agentId) out = out.filter((s) => s.agentId === options.agentId)
    if (options.limit) out = out.slice(0, options.limit)
    return out
  }

  async prompt(sessionId: string, text: string): Promise<Message> {
    const sess = await this.get(sessionId)
    if (!sess) throw new Error(`Session "${sessionId}" not found`)
    const svc = this.services?.()
    if (!svc) throw new Error('SessionServices 未配置，无法 prompt()')
    const msg: Message = {
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: Date.now(),
    }
    await this.addMessage(sessionId, msg)
    const assistant = await svc.agent.query({
      sessionId,
      agentId: sess.agentId ?? svc.currentAgentId(),
      message: text,
    })
    return assistant as Message
  }

  async *promptStream(sessionId: string, text: string): AsyncGenerator<AgentStreamEvent, void, unknown> {
    const sess = await this.get(sessionId)
    if (!sess) throw new Error(`Session "${sessionId}" not found`)
    const svc = this.services?.()
    if (!svc) throw new Error('SessionServices 未配置，无法 promptStream()')
    const msg: Message = {
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: Date.now(),
    }
    await this.addMessage(sessionId, msg)
    // queryStream 内部会写入 user 消息（若不存在），这里已写入，故不会重复
    const gen = svc.agent.queryStream({
      sessionId,
      agentId: sess.agentId ?? svc.currentAgentId(),
      message: text,
    })
    for await (const ev of gen) {
      yield ev
    }
  }

  async updateMessage(sessionId: string, messageId: string, patch: Partial<Message>): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return
    const idx = sess.messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    sess.messages[idx] = { ...sess.messages[idx], ...patch }
    sess.updatedAt = Date.now()
  }

  async updatePart(
    sessionId: string,
    messageId: string,
    partIndex: number,
    patch: Partial<import('@harness/session').Part>
  ): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return
    const msg = sess.messages.find((m) => m.id === messageId)
    if (!msg) return
    const p = msg.parts[partIndex]
    if (!p) return
    msg.parts[partIndex] = { ...p, ...patch } as import('@harness/session').Part
    sess.updatedAt = Date.now()
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return
    sess.messages.push(message)
    sess.updatedAt = Date.now()
  }

  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return
    sess.messages = sess.messages.filter((m) => m.id !== messageId)
    sess.updatedAt = Date.now()
  }

  private readonly snapshots = new Map<string, Map<string, Session>>()
  async snapshot(sessionId: string): Promise<string> {
    const sess = this.sessions.get(sessionId)
    if (!sess) throw new Error(`Session "${sessionId}" not found`)
    const snapshotId = `ss_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const cloned: Session = JSON.parse(JSON.stringify(sess))
    const bucket = this.snapshots.get(sessionId) ?? new Map<string, Session>()
    bucket.set(snapshotId, cloned)
    this.snapshots.set(sessionId, bucket)
    return snapshotId
  }

  async revert(sessionId: string, snapshotId: string): Promise<void> {
    const bucket = this.snapshots.get(sessionId)
    if (!bucket) return
    const snap = bucket.get(snapshotId)
    if (!snap) return
    // 保留当前作为 unrevert 快照（按 snapshotId 存在 bucket 里即可，简单处理）
    const current = this.sessions.get(sessionId)
    if (current) bucket.set(`__unrevert_${snapshotId}`, JSON.parse(JSON.stringify(current)))
    this.sessions.set(sessionId, JSON.parse(JSON.stringify(snap)))
  }

  async unrevert(sessionId: string, snapshotId: string): Promise<void> {
    const bucket = this.snapshots.get(sessionId)
    const unrevert = bucket?.get(`__unrevert_${snapshotId}`)
    if (!unrevert) return
    this.sessions.set(sessionId, JSON.parse(JSON.stringify(unrevert)))
  }

  async compact(sessionId: string, _strategy?: CompactionStrategy): Promise<void> {
    // 默认压缩：占位实现（MVP 不做摘要算法）
    const sess = this.sessions.get(sessionId)
    if (sess) sess.updatedAt = Date.now()
  }
}

// ========================================================================
// 6. AgentRuntimeImpl：Agent 注册 + query（Chat + Tool Pipeline 循环）
// ========================================================================

export interface AgentQueryInput {
  sessionId: string
  agentId?: string
  message: string
}

export interface AgentRuntime {
  /** 注册 Agent 定义 */
  register(def: AgentDefinition): void
  /** 获取 Agent 定义 */
  get(agentId: string): AgentDefinition | undefined
  /** 列出所有 Agent */
  list(): AgentDefinition[]
  /**
   * 执行一轮推理（单轮：构建 prompt → 调 LLM → 若 tool call 则执行 ToolPipeline → 返回 assistant 消息）
   * 多轮/循环由上层或插件继续驱动。
   */
  query(input: AgentQueryInput): Promise<Message>
  /**
   * 流式执行一轮推理：逐 chunk yield AgentStreamEvent，最后一个事件为 done（含最终 Message）。
   * 若 ChatProvider 未实现 stream()，内部自动 fallback 到 complete() 并只发一个 done 事件。
   */
  queryStream(input: AgentQueryInput): AsyncGenerator<AgentStreamEvent, void, unknown>
}

export class AgentRuntimeImpl implements AgentRuntime {
  private readonly agents = new Map<string, AgentDefinition>()
  private readonly defaultAgentId: string
  constructor(
    defaultAgentId: string,
    private readonly deps: {
      readonly session: SessionManager
      readonly toolRegistry: ToolRegistry
      readonly toolPipeline: ToolPipeline
      readonly chatProvider: () => ChatProvider
      readonly permission: PermissionEngine
      readonly triggerPlugin: <N extends keyof Hooks>(
        name: N,
        ...args: Parameters<NonNullable<Hooks[N]>>
      ) => Promise<void>
      readonly bus: Bus
      readonly cwd: string
    }
  ) {
    this.defaultAgentId = defaultAgentId
  }

  register(def: AgentDefinition): void {
    this.agents.set(def.id, def)
  }
  get(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId)
  }
  list(): AgentDefinition[] {
    return Array.from(this.agents.values())
  }

  async query(input: AgentQueryInput): Promise<Message> {
    const { sessionId, message } = input
    const agentId = input.agentId ?? this.defaultAgentId
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent "${agentId}" not registered`)

    // 工具池组装（触发 tool.pool.assemble Hook）
    const pool = new DefaultToolPool(this.deps.toolRegistry)
    await this.deps.triggerPlugin('tool.pool.assemble', { agentId } as ToolPoolAssembleInput, pool)
    const allowedTools = this.deps.toolRegistry.filterByWhitelist(agent.tools)

    // 把 agent 的权限规则写回 PermissionEngine（若配置项比默认更具体）
    this.deps.permission.updateRules({
      ...this.deps.permission.getRules(),
      ...(agent.permission as PermissionRuleset),
    })

    // 写入 user 消息（若还未在 session.prompt 里写入）
    const sess = await this.deps.session.get(sessionId)
    if (!sess) throw new Error(`Session "${sessionId}" not found`)
    if (!sess.messages.some((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && (p as any).text === message))) {
      await this.deps.session.addMessage(sessionId, {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        parts: [{ type: 'text', text: message }],
        createdAt: Date.now(),
      })
    }

    const session2 = (await this.deps.session.get(sessionId))!
    // 构建 system prompt
    const sysParts: string[] = agent.promptFragments ? [...agent.promptFragments] : []
    if (agent.systemPrompt) sysParts.length = 0, sysParts.push(agent.systemPrompt)
    const promptIn: PromptInput = { agentId, sessionId }
    await this.deps.triggerPlugin('prompt.system.transform', promptIn, sysParts)

    // 最终 messages：system + session.messages
    const finalMessages: Message[] = []
    if (sysParts.length > 0) {
      finalMessages.push({
        id: `sys_${Date.now()}`,
        role: 'system',
        parts: [{ type: 'text', text: sysParts.join('\n\n') }],
        createdAt: Date.now(),
      })
    }
    finalMessages.push(...session2.messages)

    // LLM params + headers（触发 llm.params / llm.headers hooks）
    const llmIn: LLMInput = {
      providerId: agent.model?.providerId ?? 'default',
      modelId: agent.model?.modelId,
      messages: finalMessages,
    }
    const params: LLMParams = {
      temperature: agent.model?.temperature ?? 0.7,
      ...(agent.model?.options ?? {}),
    }
    const headers: Record<string, string> = {}
    await this.deps.triggerPlugin('llm.params', llmIn, params)
    await this.deps.triggerPlugin('llm.headers', llmIn, headers)

    const provider = this.deps.chatProvider()
    const completion = await provider.complete({
      providerId: llmIn.providerId,
      modelId: llmIn.modelId,
      messages: finalMessages,
      params,
      headers,
      sessionId,
      agentId,
    })

    // 创建 assistant 消息
    const assistantId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const assistant: Message = {
      id: assistantId,
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
      agentId,
      meta: {
        model: completion.model,
        tokenUsage: completion.tokenUsage ? {
          input: completion.tokenUsage.input,
          output: completion.tokenUsage.output,
        } : undefined,
      },
    }
    if (completion.reasoning) assistant.parts.push({ type: 'reasoning', text: completion.reasoning })
    if (completion.content) assistant.parts.push({ type: 'text', text: completion.content })

    // 执行 tool calls（若有）
    if (completion.toolCalls?.length) {
      for (const tc of completion.toolCalls) {
        const tool = allowedTools.find((t) => t.id === tc.toolId) ?? this.deps.toolRegistry.get(tc.toolId)
        const resultPart: any = {
          type: 'tool',
          toolUseId: tc.toolUseId,
          toolId: tc.toolId,
          input: tc.input,
        }
        if (!tool) {
          resultPart.result = undefined
          resultPart.isError = true
          assistant.parts.push(resultPart)
          continue
        }
        const tctx: ToolContext = {
          sessionId,
          agentId,
          messageId: assistantId,
          toolUseId: tc.toolUseId,
          signal: new AbortController().signal,
          variables: {},
          cwd: this.deps.cwd,
          requestPermission: (r) => this.deps.permission.check(r as ToolPermissionRequest) as Promise<ToolPermissionDecision>,
        }
        const res: ToolResult = await this.deps.toolPipeline.execute(tool, tc.input, tctx)
        resultPart.result = res.ok ? res.output : { message: res.error?.message, code: res.error?.code }
        resultPart.isError = !res.ok
        assistant.parts.push(resultPart)
      }
    }

    await this.deps.session.addMessage(sessionId, assistant)
    return assistant
  }

  /** query/queryStream 共用的准备逻辑：返回构建好的 messages/params/headers/allowedTools */
  private async _prepareQuery(input: AgentQueryInput): Promise<{
    agentId: string
    sessionId: string
    finalMessages: Message[]
    params: LLMParams
    headers: Record<string, string>
    allowedTools: Tool[]
  }> {
    const { sessionId, message } = input
    const agentId = input.agentId ?? this.defaultAgentId
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent "${agentId}" not registered`)

    const pool = new DefaultToolPool(this.deps.toolRegistry)
    await this.deps.triggerPlugin('tool.pool.assemble', { agentId } as ToolPoolAssembleInput, pool)
    const allowedTools = this.deps.toolRegistry.filterByWhitelist(agent.tools)

    this.deps.permission.updateRules({
      ...this.deps.permission.getRules(),
      ...(agent.permission as PermissionRuleset),
    })

    const sess = await this.deps.session.get(sessionId)
    if (!sess) throw new Error(`Session "${sessionId}" not found`)
    if (!sess.messages.some((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && (p as any).text === message))) {
      await this.deps.session.addMessage(sessionId, {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        parts: [{ type: 'text', text: message }],
        createdAt: Date.now(),
      })
    }

    const session2 = (await this.deps.session.get(sessionId))!
    const sysParts: string[] = agent.promptFragments ? [...agent.promptFragments] : []
    if (agent.systemPrompt) { sysParts.length = 0; sysParts.push(agent.systemPrompt) }
    const promptIn: PromptInput = { agentId, sessionId }
    await this.deps.triggerPlugin('prompt.system.transform', promptIn, sysParts)

    const finalMessages: Message[] = []
    if (sysParts.length > 0) {
      finalMessages.push({
        id: `sys_${Date.now()}`,
        role: 'system',
        parts: [{ type: 'text', text: sysParts.join('\n\n') }],
        createdAt: Date.now(),
      })
    }
    finalMessages.push(...session2.messages)

    const llmIn: LLMInput = {
      providerId: agent.model?.providerId ?? 'default',
      modelId: agent.model?.modelId,
      messages: finalMessages,
    }
    const params: LLMParams = {
      temperature: agent.model?.temperature ?? 0.7,
      ...(agent.model?.options ?? {}),
    }
    const headers: Record<string, string> = {}
    await this.deps.triggerPlugin('llm.params', llmIn, params)
    await this.deps.triggerPlugin('llm.headers', llmIn, headers)

    return { agentId, sessionId, finalMessages, params, headers, allowedTools }
  }

  async *queryStream(input: AgentQueryInput): AsyncGenerator<AgentStreamEvent, void, unknown> {
    const { agentId, sessionId, finalMessages, params, headers, allowedTools } = await this._prepareQuery(input)
    const provider = this.deps.chatProvider()

    // 收集流式结果
    let textBuf = ''
    let reasoningBuf = ''
    const toolCalls: Array<{ toolUseId: string; toolId: string; inputParts: string[] }> = []
    let model: string | undefined
    let tokenUsage: { input: number; output: number; total?: number } | undefined
    let raw: unknown

    if (provider.stream) {
      // 流式路径
      const gen = provider.stream({
        providerId: finalMessages[0]?.role === 'system' ? (agentId === 'default' ? 'default' : agentId) : agentId,
        modelId: this.agents.get(agentId)?.model?.modelId,
        messages: finalMessages,
        params,
        headers,
        sessionId,
        agentId,
      })
      for await (const chunk of gen) {
        switch (chunk.type) {
          case 'text_delta':
            if (chunk.text) {
              textBuf += chunk.text
              yield { type: 'text_delta', text: chunk.text }
            }
            break
          case 'reasoning_delta':
            if (chunk.text) {
              reasoningBuf += chunk.text
              yield { type: 'reasoning_delta', text: chunk.text }
            }
            break
          case 'tool_use_start':
            toolCalls.push({ toolUseId: chunk.toolUseId ?? '', toolId: chunk.toolId ?? '', inputParts: [] })
            break
          case 'tool_use_delta':
            if (chunk.inputDelta && toolCalls.length > 0) {
              toolCalls[toolCalls.length - 1].inputParts.push(chunk.inputDelta)
            }
            break
          case 'tool_use_stop':
            // 不单独 yield，tool_call_start 在执行时发
            break
          case 'done':
            model = chunk.model
            tokenUsage = chunk.tokenUsage
            raw = chunk.raw
            break
        }
      }
    } else {
      // Fallback：非流式 complete()，模拟单次 yield
      const completion = await provider.complete({
        providerId: agentId === 'default' ? 'default' : agentId,
        modelId: this.agents.get(agentId)?.model?.modelId,
        messages: finalMessages,
        params,
        headers,
        sessionId,
        agentId,
      })
      textBuf = completion.content
      reasoningBuf = completion.reasoning ?? ''
      if (completion.toolCalls) {
        for (const tc of completion.toolCalls) {
          toolCalls.push({ toolUseId: tc.toolUseId, toolId: tc.toolId, inputParts: [JSON.stringify(tc.input)] })
        }
      }
      model = completion.model
      tokenUsage = completion.tokenUsage
      raw = completion.raw
      // 一次性 yield 文本
      if (textBuf) yield { type: 'text_delta', text: textBuf }
      if (reasoningBuf) yield { type: 'reasoning_delta', text: reasoningBuf }
    }

    // 构建 assistant 消息
    const assistantId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const assistant: Message = {
      id: assistantId,
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
      agentId,
      meta: {
        model,
        tokenUsage: tokenUsage ? { input: tokenUsage.input, output: tokenUsage.output } : undefined,
      },
    }
    if (reasoningBuf) assistant.parts.push({ type: 'reasoning', text: reasoningBuf })
    if (textBuf) assistant.parts.push({ type: 'text', text: textBuf })

    // 执行 tool calls
    for (const tc of toolCalls) {
      const inputJson = tc.inputParts.join('')
      let parsedInput: unknown
      try { parsedInput = inputJson ? JSON.parse(inputJson) : {} }
      catch { parsedInput = inputJson }

      const tool = allowedTools.find((t) => t.id === tc.toolId) ?? this.deps.toolRegistry.get(tc.toolId)
      const resultPart: any = {
        type: 'tool',
        toolUseId: tc.toolUseId,
        toolId: tc.toolId,
        input: parsedInput,
      }

      yield { type: 'tool_call_start', toolUseId: tc.toolUseId, toolId: tc.toolId, input: parsedInput }

      if (!tool) {
        resultPart.result = undefined
        resultPart.isError = true
        assistant.parts.push(resultPart)
        yield { type: 'tool_call_result', toolUseId: tc.toolUseId, toolId: tc.toolId, result: undefined, isError: true }
        continue
      }

      const tctx: ToolContext = {
        sessionId,
        agentId,
        messageId: assistantId,
        toolUseId: tc.toolUseId,
        signal: new AbortController().signal,
        variables: {},
        cwd: this.deps.cwd,
        requestPermission: (r) => this.deps.permission.check(r as ToolPermissionRequest) as Promise<ToolPermissionDecision>,
      }
      const res: ToolResult = await this.deps.toolPipeline.execute(tool, parsedInput, tctx)
      resultPart.result = res.ok ? res.output : { message: res.error?.message, code: res.error?.code }
      resultPart.isError = !res.ok
      assistant.parts.push(resultPart)

      yield {
        type: 'tool_call_result',
        toolUseId: tc.toolUseId,
        toolId: tc.toolId,
        result: resultPart.result,
        isError: !res.ok,
      }
    }

    await this.deps.session.addMessage(sessionId, assistant)
    yield { type: 'done', message: assistant }
  }
}

// ========================================================================
// 7. Harness 接口 + 实现
// ========================================================================

/** 工作中的 Harness 接口（与模板文档略有差异，这里提供具体可用 API） */
export interface Harness {
  // === 生命周期 ===
  /** 启动（触发 harness.start hook + harness.started event） */
  start(): Promise<void>
  /** 停止（unload 所有插件 + bus publish） */
  stop(): Promise<void>
  /** 挂起（MVP：占位） */
  suspend(): Promise<void>
  /** 恢复（MVP：占位） */
  resume(): Promise<void>

  // === 能力访问器 ===
  readonly session: SessionManager
  readonly agent: AgentRuntime
  readonly plugin: PluginManager
  readonly bus: Bus
  readonly context: ContextProvider
  readonly tools: ToolRegistry
  readonly toolPipeline: ToolPipeline
  readonly permission: PermissionEngine
}

/** createHarness() 参数 */
export interface AgentHarnessOptions {
  /** 工作目录（注入 ToolContext.cwd，默认 process.cwd()） */
  cwd?: string
  /** 默认 Agent ID（必填：需要能在 agent.register 后生效） */
  defaultAgentId?: string
  /** 初始 Agent 定义列表（默认注册） */
  agents?: AgentDefinition[]
  /** 内置插件列表（随 create 阶段 loadInternal） */
  internalPlugins?: AgentPlugin[]
  /** 默认插件 npm spec（会走 loadBuiltin，支持测试注入 dynamicImport） */
  builtinPlugins?: string[]
  /** 用户插件 npm spec / file:// 路径（走 loadUser） */
  userPlugins?: string[]
  /** 配置覆盖（注入 PluginManager initialConfig） */
  config?: Record<string, unknown>
  /** 是否启用 Skill 系统（MVP 留占位） */
  enableSkills?: boolean
  /** 可选：自定义 ChatProvider 注入（若无则安装 Provider 插件后才可用） */
  chatProvider?: ChatProvider
  /** 可选：自定义 PermissionEngine（无则 DefaultPermissionEngine，默认 ask→deny） */
  permission?: PermissionEngine
  /** 可选：自定义 Bus 实例（无则 createBus()） */
  bus?: Bus
  /** 可选：自定义 ToolRegistry（便于测试注入） */
  toolRegistry?: ToolRegistry
  /** 可选：透传给 PluginManager（测试注入 dynamicImport） */
  pluginOverrides?: Partial<PluginManagerOptions>
  /** 可选：透传 logger */
  logger?: import('@harness/plugin').PluginContext['log']
}

// ---- Bus 事件定义（Harness 生命周期）----
export const HarnessEvents = {
  initializing: BusEvent.define<{ startedAt: number }>('harness.initializing'),
  initialized:  BusEvent.define<{ durationMs: number; pluginCount: number }>('harness.initialized'),
  starting:     BusEvent.define<{ startedAt: number }>('harness.starting'),
  started:      BusEvent.define<{ durationMs: number }>('harness.started'),
  stopping:     BusEvent.define<{ stoppedAt: number }>('harness.stopping'),
  stopped:      BusEvent.define<{ durationMs: number }>('harness.stopped'),
  error:        BusEvent.define<{ stage: 'init' | 'start' | 'stop' | 'runtime'; error: unknown }>('harness.error'),
} as const

export class HarnessImpl implements Harness {
  public readonly bus: Bus
  public readonly context: ContextProvider
  public readonly permission: PermissionEngine
  public readonly tools: ToolRegistry
  public readonly toolPipeline: ToolPipeline
  public readonly plugin: PluginManager
  public readonly session: SessionManager
  public readonly agent: AgentRuntime

  private chatProvider: ChatProvider
  private started = false
  private stopped = false

  constructor(private readonly options: AgentHarnessOptions) {
    this.bus = options.bus ?? createBus()
    this.context = new DefaultContextProvider()
    this.permission = options.permission ?? new DefaultPermissionEngine({ '*': 'ask' })
    this.tools = options.toolRegistry ?? new ToolRegistry()

    // ChatProvider（支持后替换，给插件注入留入口）
    this.chatProvider = options.chatProvider ?? new MissingChatProvider()
    this.context.register('chat.provider', this.chatProvider)

    // PluginManager
    this.plugin = createPluginManager({
      bus: this.bus,
      initialConfig: options.config ?? {},
      logger: options.logger,
      dynamicImport: options.pluginOverrides?.dynamicImport,
    })

    // ToolPipeline 接入 Plugin hooks（pre/post）
    // - preHook 洋葱：按插件序，把 tool.pre.execute 包装成 next() 链
    // - postHook 顺序：把 tool.post.execute 插入
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let _self: unknown = null
    _self = this as any
    const preHook: ToolPreHook = async (preCtx, next) => {
      let idx = 0
      const entries = (this.plugin as any).hooks?.listFor
        ? (this.plugin as any).hooks.listFor('tool.pre.execute') as ReadonlyArray<{ pluginId: string; fn: NonNullable<Hooks['tool.pre.execute']> }>
        : []
      const callNth = async (i: number, inp: unknown): Promise<ToolResult> => {
        if (i >= entries.length) return next(inp)
        const entry = entries[i]
        const fn = entry.fn as (ctx: unknown, nxt: () => Promise<unknown>) => Promise<unknown>
        // 把 plugin pre hook 签名 (ctx, next) → next() 调用继续
        return fn(
          { ...preCtx, input: inp, pluginId: entry.pluginId },
          async (modified?: unknown) => callNth(i + 1, modified ?? inp)
        ) as Promise<ToolResult>
      }
      return callNth(idx, preCtx.input)
    }
    const postHook: ToolPostHook = async (postCtx, result) => {
      let r: ToolResult = result
      const entries: ReadonlyArray<{ pluginId: string; fn: NonNullable<Hooks['tool.post.execute']> }> =
        (this.plugin as any).hooks?.listFor
          ? (this.plugin as any).hooks.listFor('tool.post.execute')
          : []
      for (const e of entries) {
        const fn = e.fn as (ctx: unknown, res: unknown) => Awaitable<unknown>
        const next = await fn({ ...postCtx, pluginId: e.pluginId }, r)
        if (next && typeof next === 'object') r = next as ToolResult
      }
      return r
    }
    this.toolPipeline = new ToolPipeline({
      checkPermission: (req) => this.permission.check(req as PermRequest) as Promise<ToolPermissionDecision>,
      preHooks: [preHook],
      postHooks: [postHook],
    })

    // Session 引用 AgentRuntime（懒回调）
    let agentRuntime: AgentRuntime | undefined
    this.session = new DefaultSessionManager(() => {
      if (!agentRuntime) throw new Error('AgentRuntime 未就绪')
      return { agent: agentRuntime, currentAgentId: () => options.defaultAgentId ?? 'default' }
    })

    const defaultAgentId = options.defaultAgentId ?? 'default'
    const agentImpl = new AgentRuntimeImpl(defaultAgentId, {
      session: this.session,
      toolRegistry: this.tools,
      toolPipeline: this.toolPipeline,
      chatProvider: () => (this.context.resolve<ChatProvider>('chat.provider') ?? this.chatProvider),
      permission: this.permission,
      triggerPlugin: (n, ...args) => (this.plugin as any).trigger(n, ...args),
      bus: this.bus,
      cwd: options.cwd ?? process.cwd(),
    })
    ;(options.agents ?? []).forEach((a) => agentImpl.register(a))
    this.agent = agentImpl
    agentRuntime = agentImpl
    // 防止 _self 被 tree-shaking 判定为未使用（真实运行中无用，仅满足 lint）
    void _self
  }

  /** 初始化：加载 Internal/Builtin/User 插件 + harness.init Hook */
  private async init(): Promise<void> {
    const startedAt = Date.now()
    await this.bus.publish(HarnessEvents.initializing, { startedAt }, { source: 'harness' })
    try {
      if (this.options.internalPlugins?.length) await this.plugin.loadInternal(this.options.internalPlugins)
      if (this.options.builtinPlugins?.length) await this.plugin.loadBuiltin(this.options.builtinPlugins)
      if (this.options.userPlugins?.length) await this.plugin.loadUser(this.options.userPlugins)

      // harness.init Hook（给插件最后一次修改 context/tool 机会）
      const initIn: PluginHarnessInitInput = { harnessOptions: this.options }
      const initOut: PluginHarnessInitOutput = { harness: this }
      await (this.plugin as any).trigger('harness.init', initIn, initOut)
    } catch (err) {
      await this.bus.publish(HarnessEvents.error, { stage: 'init', error: err }, { source: 'harness' })
      throw err
    }
    await this.bus.publish(HarnessEvents.initialized, {
      durationMs: Date.now() - startedAt,
      pluginCount: this.plugin.list().length,
    }, { source: 'harness' })
  }

  async start(): Promise<void> {
    if (this.started) return
    const startedAt = Date.now()
    await this.bus.publish(HarnessEvents.starting, { startedAt }, { source: 'harness' })
    try {
      const startIn: PluginHarnessStartInput = { harness: this }
      const startOut: PluginHarnessStartOutput = { started: true }
      await (this.plugin as any).trigger('harness.start', startIn, startOut)
    } catch (err) {
      await this.bus.publish(HarnessEvents.error, { stage: 'start', error: err }, { source: 'harness' })
      throw err
    }
    this.started = true
    await this.bus.publish(HarnessEvents.started, { durationMs: Date.now() - startedAt }, { source: 'harness' })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    const stoppedAt = Date.now()
    await this.bus.publish(HarnessEvents.stopping, { stoppedAt }, { source: 'harness' })
    try {
      // 反向卸载插件（list 顺序拓扑升序 → 倒序卸载）
      const loaded = [...this.plugin.list()].reverse()
      for (const p of loaded) {
        try { await this.plugin.unload(p.plugin.id) } catch (_) { /* ignore; bus 已记录 */ }
      }
    } catch (err) {
      await this.bus.publish(HarnessEvents.error, { stage: 'stop', error: err }, { source: 'harness' })
      throw err
    }
    this.stopped = true
    await this.bus.publish(HarnessEvents.stopped, { durationMs: Date.now() - stoppedAt }, { source: 'harness' })
  }

  async suspend(): Promise<void> { /* MVP: placeholder */ }
  async resume(): Promise<void> { /* MVP: placeholder */ }

  // ----- 内部工具：替换 ChatProvider（供 Plugin 使用） -----
  /** @internal 替换默认 ChatProvider（Provider 插件 install 时调用） */
  _setChatProvider(p: ChatProvider): void {
    this.chatProvider = p
    this.context.register('chat.provider', p)
  }
}

// ========================================================================
// 8. createHarness() 工厂
// ========================================================================

/**
 * 创建并初始化 Harness 实例。
 *
 * 流程：
 * 1. 构造 HarnessImpl（bus/context/permission/tools/plugin/session/agent）
 * 2. init（加载 Internal/Builtin/User 插件 + 触发 harness.init Hook）
 * 3. 返回实例（未 start，由调用方按需 await harness.start()）
 */
export async function createHarness(options: AgentHarnessOptions = {}): Promise<Harness> {
  const harness = new HarnessImpl(options)
  // 私有方法：通过原型调用 init
  await (harness as unknown as { init(): Promise<void> }).init()
  return harness
}
