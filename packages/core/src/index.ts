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
  CliCommandDef,
  CliCommandsInput,
  CliCommandInput,
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
import { agentFromMarkdown } from '@harness/agent'
import { createSkillManager, formatSkillForPrompt, type SkillManager, type Skill, type SkillSource } from '@harness/skill'
import { MultiDirLoader, normalizeDirs, type DirEntryInput, type DirSource } from '@harness/workspace'
import { readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
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
  CompactOptions,
  CompactionMeta,
  CompactMemory,
  COMPACT_META_KEY,
  COMPACT_MEMORY_KEY,
} from '@harness/session'
import {
  COMPACT_META_KEY as COMPACT_META_KEY_VAL,
  COMPACT_MEMORY_KEY as COMPACT_MEMORY_KEY_VAL,
} from '@harness/session'
import type {
  SnapshotID,
  SnapshotService,
} from '@harness/snapshot'

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

/**
 * 权限判定两步走：先 check（不询问），若需询问则调用 ask()（交上层交互，
 * 无交互器时引擎 ask() 默认 deny，保证安全）。工具执行统一经此入口拿到最终 allow/deny。
 */
async function resolvePermission(engine: PermissionEngine, req: ToolPermissionRequest): Promise<ToolPermissionDecision> {
  const d = await engine.check(req)
  if (d.behavior !== 'ask') return d
  return engine.ask(req)
}

/**
 * 工具执行兜底：把权限拒绝 / 未知异常归一化为「失败的 ToolResult」，
 * 作为 tool error 反馈给 LLM（模型可据此调整），而不是中断整个 agent 流转发。
 */
async function safeExecuteTool(
  pipeline: ToolPipeline,
  tool: Tool,
  input: unknown,
  tctx: ToolContext,
): Promise<ToolResult> {
  try {
    return await pipeline.execute(tool, input, tctx)
  } catch (err: any) {
    // 避免依赖 re-export 的类绑定，用错误名判定（tool 层 ToolPermissionDeniedError.name 固定）
    if (err?.name === 'ToolPermissionDeniedError') {
      return { ok: false, error: { message: `权限被拒绝：${err.message}`, code: 'PERMISSION_DENIED' }, interrupted: false }
    }
    return { ok: false, error: { message: err?.message ?? String(err), code: 'TOOL_ERROR' }, interrupted: false }
  }
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

/** LLM token 用量统计（含缓存命中/未命中明细） */
export interface TokenUsage {
  /** 输入 token（含缓存部分） */
  input: number
  /** 输出 token */
  output: number
  total?: number
  /** 命中缓存的输入 token（Anthropic cache_read_input_tokens / OpenAI prompt_tokens_details.cached_tokens / Gemini cachedContentTokenCount） */
  cacheRead?: number
  /** 写入缓存（未命中但计入缓存）的输入 token（Anthropic cache_creation_input_tokens） */
  cacheWrite?: number
}

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
  tokenUsage?: TokenUsage
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
  tokenUsage?: TokenUsage
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
      parentId: options?.parentId,
      meta: options?.meta,
    }
    this.sessions.set(id, sess)
    return sess
  }

  async get(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId)
  }

  async setId(oldId: string, newId: string): Promise<Session> {
    const sess = this.sessions.get(oldId)
    if (!sess) throw new Error(`Session "${oldId}" not found`)
    if (oldId !== newId) {
      // 同步更新内部索引键，避免只改对象 id 导致后续按 newId 查不到
      this.sessions.delete(oldId)
      sess.id = newId
      this.sessions.set(newId, sess)
    }
    return sess
  }

  async list(options?: SessionListOptions): Promise<Session[]> {
    const items = Array.from(this.sessions.values())
    if (!options) return items
    let out = items
    if (options.agentId) out = out.filter((s) => s.agentId === options.agentId)
    if (options.limit) out = out.slice(0, options.limit)
    return out
  }

  async search(query: string, options?: SessionListOptions): Promise<Session[]> {
    const q = query.toLowerCase().trim()
    if (!q) return []
    let results = Array.from(this.sessions.values()).filter((s) =>
      s.messages.some((m) =>
        m.parts.some((p: any) => p.type === 'text' && String(p.text ?? '').toLowerCase().includes(q))
      )
    )
    if (options?.agentId) results = results.filter((s) => s.agentId === options.agentId)
    if (options?.limit) results = results.slice(0, options.limit)
    return results
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
    // 自动生成标题：首条 user 消息截取前 60 字符
    if (!sess.title && message.role === 'user') {
      const textPart = message.parts.find((p: any) => p.type === 'text') as any
      if (textPart?.text) {
        sess.title = String(textPart.text).replace(/\n/g, ' ').slice(0, 60)
      }
    }
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

  // ---------- Compaction ----------

  private readMeta(sess: Session): CompactionMeta {
    const raw = sess.meta?.[COMPACT_META_KEY_VAL] as CompactionMeta | undefined
    return raw ?? { count: 0, totalPrunedMessages: 0 }
  }
  private writeMeta(sess: Session, meta: CompactionMeta): void {
    sess.meta = { ...(sess.meta ?? {}), [COMPACT_META_KEY_VAL]: meta }
  }
  private readMemory(sess: Session): CompactMemory | undefined {
    return sess.meta?.[COMPACT_MEMORY_KEY_VAL] as CompactMemory | undefined
  }
  private writeMemory(sess: Session, mem: CompactMemory): void {
    sess.meta = { ...(sess.meta ?? {}), [COMPACT_MEMORY_KEY_VAL]: mem }
  }

  async compact(
    sessionId: string,
    strategy?: CompactionStrategy,
    options: CompactOptions = {}
  ): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return
    const now = Date.now()
    const strat = strategy ?? options.strategy ?? 'summary'
    const keepRecent = Math.max(options.keepRecentMessages ?? 10, 0)

    const beforeLen = sess.messages.length
    // 所有消息按时间排序（约定已是）；不包含 role===system 的消息（它们在 AgentRuntime 内动态构建，不在 session.messages 里）
    const msgs = sess.messages
    if (msgs.length <= keepRecent) return // 无需压缩

    const cutIndex = Math.max(0, msgs.length - keepRecent)
    const windowToPrune = msgs.slice(0, cutIndex)
    const kept = msgs.slice(cutIndex)

    // 生成摘要（仅 summary / agent）
    let summaryText: string | undefined
    const prevMemory = this.readMemory(sess)

    if (strat === 'summary' || strat === 'agent') {
      const maxChars = options.summaryMaxChars ?? 8000
      if (strat === 'agent') {
        // 尝试调用 agent（通过 services?.agent）——缺失或失败则 fallback 到规则摘要
        const svc = this.services?.()
        summaryText = await this.tryAgentSummary({
          window: windowToPrune,
          prevMemory,
          maxChars,
          agentRuntime: svc?.agent,
          sessionId,
          agentId: sess.agentId ?? svc?.currentAgentId(),
        })
      }
      // summary 策略，或 agent 策略 fallback：统一走规则摘要
      if (!summaryText) {
        summaryText = this.ruleBasedSummary(windowToPrune, prevMemory, maxChars)
      }
    }

    const memoryStartAt = (windowToPrune[0]?.createdAt ?? sess.createdAt)

    // 更新记忆：保留"旧轮次"并把 summaryText 写入
    const newRound = (prevMemory?.round ?? 0) + 1
    // 合并新旧摘要：把旧 summary 作为"更早记忆"放在新摘要前面
    const mergedSummary = summaryText !== undefined
      ? (prevMemory?.summaryText ? `（更早记忆，第 ${prevMemory.round} 轮摘要）\n${prevMemory.summaryText}\n\n（最新压缩，第 ${newRound} 轮）\n${summaryText}`
        : summaryText)
      : prevMemory?.summaryText
    const newMemory: CompactMemory = {
      summaryText: mergedSummary,
      memoryStartAt: prevMemory?.memoryStartAt ?? memoryStartAt,
      round: newRound,
    }
    this.writeMemory(sess, newMemory)

    // 实际截断：删除 windowToPrune
    sess.messages = kept
    const afterLen = sess.messages.length

    // 更新元数据
    const oldMeta = this.readMeta(sess)
    const newMeta: CompactionMeta = {
      count: oldMeta.count + 1,
      lastStrategy: strat,
      lastAt: now,
      lastMessagesBefore: beforeLen,
      lastMessagesAfter: afterLen,
      totalPrunedMessages: (oldMeta.totalPrunedMessages ?? 0) + (beforeLen - afterLen),
    }
    this.writeMeta(sess, newMeta)

    sess.updatedAt = now
  }

  async compactIfNeeded(sessionId: string, options: CompactOptions = {}): Promise<boolean> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return false
    // token 估算：优先用旧的 tokensPerMessage（向后兼容），否则用字符长度 / 4
    const estimated = options.tokensPerMessage != null
      ? sess.messages.length * options.tokensPerMessage
      : this.estimateTokensForMessages(sess.messages)
    // 阈值计算：固定阈值优先，否则用百分比
    let threshold: number
    if (options.thresholdTokens != null) {
      threshold = options.thresholdTokens
    } else {
      const ctx = options.contextWindowTokens ?? 200000
      const reserved = options.reservedTokens ?? 30000
      const pct = options.autoCompactThresholdPct ?? 80
      threshold = Math.floor((ctx - reserved) * (pct / 100))
    }
    if (estimated < threshold) return false
    await this.compact(sessionId, options.strategy ?? 'summary', options)
    return true
  }

  async estimateTokens(sessionId: string): Promise<number> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return 0
    return this.estimateTokensForMessages(sess.messages)
  }

  /**
   * 粗估 messages 的 token 数：按字符长度 / 4（参考 Claude Code 的 roughTokenCountEstimation）。
   * text part: text.length / 4
   * tool part: JSON.stringify(result + input).length / 4
   * 其他 part: JSON.stringify(part).length / 4
   */
  private estimateTokensForMessages(messages: Message[]): number {
    let chars = 0
    for (const m of messages) {
      for (const p of m.parts) {
        const pt = p as any
        if (pt.type === 'text') {
          chars += String(pt.text ?? '').length
        } else if (pt.type === 'tool') {
          try { chars += JSON.stringify(pt.result ?? '').length } catch { chars += 100 }
          try { chars += JSON.stringify(pt.input ?? {}).length } catch { /* ignore */ }
        } else {
          try { chars += JSON.stringify(pt).length } catch { /* ignore */ }
        }
      }
    }
    return Math.ceil(chars / 4)
  }

  async getCompactionInfo(sessionId: string) {
    const sess = this.sessions.get(sessionId)
    if (!sess) return {}
    return {
      meta: this.readMeta(sess),
      memory: this.readMemory(sess),
    }
  }

  async exportMarkdown(sessionId: string): Promise<string> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return ''
    const lines: string[] = []
    // 标题
    lines.push(`# ${sess.title ?? sess.id}`)
    lines.push('')
    lines.push(`> 会话 ID: \`${sess.id}\``)
    lines.push(`> 创建时间: ${new Date(sess.createdAt).toLocaleString()}`)
    lines.push(`> 更新时间: ${new Date(sess.updatedAt).toLocaleString()}`)
    if (sess.agentId) lines.push(`> Agent: ${sess.agentId}`)
    lines.push('')
    // 压缩记忆
    const mem = this.readMemory(sess)
    if (mem?.summaryText) {
      lines.push('## 会话压缩记忆')
      lines.push('')
      lines.push(`> 压缩轮次：${mem.round}`)
      lines.push(`> 摘要：${mem.summaryText}`)
      lines.push('')
    }
    // 消息
    for (const m of sess.messages) {
      const ts = new Date(m.createdAt).toLocaleString()
      const roleLabel = m.role === 'user' ? '👤 **User**' : m.role === 'assistant' ? '🤖 **Assistant**' : `🔧 **${m.role}**`
      lines.push(`---`)
      lines.push('')
      lines.push(`${roleLabel}  \n*${ts}*`)
      lines.push('')
      for (const p of m.parts) {
        const pt = p as any
        if (pt.type === 'text') {
          lines.push(String(pt.text ?? ''))
          lines.push('')
        } else if (pt.type === 'tool') {
          const input = (() => { try { return JSON.stringify(pt.input ?? {}) } catch { return String(pt.input ?? '') } })()
          const result = (() => { try { return typeof pt.result === 'string' ? pt.result : JSON.stringify(pt.result ?? '') } catch { return String(pt.result ?? '') } })()
          lines.push('```')
          lines.push(`[Tool: ${pt.toolId}]`)
          lines.push(`Input: ${input.slice(0, 500)}`)
          lines.push(`Result: ${result.slice(0, 500)}`)
          lines.push('```')
          lines.push('')
        }
      }
    }
    return lines.join('\n')
  }

  // --------- 待处理通知队列（后台任务完成通知等） ---------

  private readonly pendingNotifications = new Map<string, string[]>()

  enqueueNotification(sessionId: string, message: string): void {
    const queue = this.pendingNotifications.get(sessionId) ?? []
    queue.push(message)
    this.pendingNotifications.set(sessionId, queue)
  }

  drainNotifications(sessionId: string): string[] {
    const queue = this.pendingNotifications.get(sessionId) ?? []
    if (queue.length > 0) this.pendingNotifications.delete(sessionId)
    return queue
  }

  // --------- 内部摘要实现 ---------

  /** 规则摘要：简单但稳定的基于消息类型/文本要点的摘要；无需 LLM */
  private ruleBasedSummary(
    window: Message[],
    prevMemory: CompactMemory | undefined,
    maxChars: number
  ): string {
    const lines: string[] = []
    const total = window.length
    lines.push(`对话摘要（压缩前消息数：${total}，时间范围 ${
      window[0]?.createdAt ? new Date(window[0].createdAt).toISOString() : '?'
    } ~ ${
      window[window.length - 1]?.createdAt ? new Date(window[window.length - 1].createdAt).toISOString() : '?'
    }）`)
    if (prevMemory?.round) {
      lines.push(`上一轮为第 ${prevMemory.round} 次压缩，本摘要建立在先前记忆之上。`)
    }

    // 参与方统计
    const byRole: Record<string, number> = {}
    const toolCalls: Array<{ toolId: string; result: unknown }> = []
    const firstUserLines: string[] = []
    const lastUserLines: string[] = []
    const assistantLines: string[] = []

    for (const m of window) {
      byRole[m.role] = (byRole[m.role] ?? 0) + 1
      if (m.role === 'user') {
        const texts = m.parts.filter((p: any) => p.type === 'text').map((p: any) => String(p.text))
        if (texts.length) {
          if (firstUserLines.length < 2) firstUserLines.push(texts.join('\n').slice(0, 200))
          lastUserLines.length = 0
          lastUserLines.push(texts.join('\n').slice(0, 200))
        }
      } else if (m.role === 'assistant') {
        for (const p of m.parts) {
          const pt = p as any
          if (pt.type === 'text') assistantLines.push(String(pt.text).slice(0, 200))
          else if (pt.type === 'tool') {
            toolCalls.push({ toolId: String(pt.toolId), result: pt.result })
          }
        }
      } else if (m.role === 'tool') {
        for (const p of m.parts) {
          const pt = p as any
          if (pt.type === 'tool') {
            toolCalls.push({ toolId: String(pt.toolId), result: pt.result })
          }
        }
      }
    }

    lines.push(`参与角色分布：${Object.entries(byRole).map(([k, v]) => `${k}=${v}`).join(', ')}`)

    if (firstUserLines.length) {
      lines.push('最早的用户消息要点：')
      for (const l of firstUserLines) lines.push(`- ${l}`)
    }
    if (lastUserLines.length) {
      lines.push('最近的用户消息要点：')
      for (const l of lastUserLines) lines.push(`- ${l}`)
    }
    if (assistantLines.length) {
      const joined = assistantLines.slice(0, 3).join('\n').slice(0, 500)
      lines.push(`助手要点（节选）：\n- ${joined}`)
    }
    if (toolCalls.length) {
      const perTool = new Map<string, number>()
      for (const tc of toolCalls) perTool.set(tc.toolId, (perTool.get(tc.toolId) ?? 0) + 1)
      lines.push(`工具调用（共 ${toolCalls.length} 次）：${
        Array.from(perTool.entries()).map(([id, c]) => `${id}×${c}`).join(', ')
      }`)
      // 列出前 3 条结果小片段
      const first3 = toolCalls.slice(0, 3).map((t) => {
        let s = ''
        try { s = typeof t.result === 'string' ? t.result : JSON.stringify(t.result) }
        catch { s = String(t.result) }
        return `${t.toolId}: ${s.slice(0, 100)}`
      })
      if (first3.length) {
        lines.push('工具结果节选：')
        for (const l of first3) lines.push(`- ${l}`)
      }
    }

    let out = lines.join('\n')
    if (out.length > maxChars) out = out.slice(0, maxChars - 3) + '...'
    return out
  }

  /**
   * 尝试调用 Agent/LLM 生成摘要（agent strategy）。
   * 若当前缺少 AgentRuntime / ChatProvider / 出错，则返回空字符串让调用方 fallback。
   */
  private async tryAgentSummary(args: {
    window: Message[]
    prevMemory: CompactMemory | undefined
    maxChars: number
    agentRuntime?: AgentRuntime
    sessionId: string
    agentId?: string
  }): Promise<string | undefined> {
    const { window, prevMemory, maxChars, agentRuntime } = args
    if (!agentRuntime || !args.agentId) return undefined

    const userLines: string[] = []
    for (const m of window) {
      if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') {
        for (const p of m.parts) {
          const pt = p as any
          if (pt.type === 'text') userLines.push(`[${m.role}] ${String(pt.text).slice(0, 300)}`)
          else if (pt.type === 'tool') {
            const line = `[tool] id=${pt.toolId} input=${JSON.stringify(pt.input ?? {}).slice(0, 200)} result=${JSON.stringify(pt.result ?? '').slice(0, 200)}`
            userLines.push(line)
          }
        }
      }
    }
    let userContent = `请把下面对话窗口压缩为 1 段长摘要（不超过 ${maxChars} 字符），保留关键意图、决策与工具结果：\n\n`
    userContent += userLines.join('\n').slice(0, 4000)
    if (prevMemory?.summaryText) {
      userContent = `此前已有摘要记忆（用作上下文背景，无需复述）：\n${prevMemory.summaryText.slice(0, 800)}\n\n---\n` + userContent
    }

    try {
      // 复用 AgentRuntime 做一轮推理；失败则 return undefined（不把异常抛出给业务）
      const msg = await agentRuntime.query({
        sessionId: args.sessionId + '__compaction__',
        agentId: args.agentId,
        message: userContent,
      })
      const texts = (msg.parts as unknown as any[])
        .filter((p) => p.type === 'text')
        .map((p) => String(p.text))
      const summary = texts.join('\n').trim().slice(0, maxChars) || undefined
      return summary
    } catch {
      return undefined
    }
  }
}

// ========================================================================
// 6. AgentRuntimeImpl：Agent 注册 + query（Chat + Tool Pipeline 循环）
// ========================================================================

export interface AgentQueryInput {
  sessionId: string
  agentId?: string
  message: string
  /** 模型覆盖（SubagentTool 派出子 Agent 时可指定模型，优先级高于 agent 定义） */
  model?: { providerId?: string; modelId?: string; temperature?: number }
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
  /** 惰性创建的快照服务实例 */
  private snapshotSvc: SnapshotService | undefined
  /** 每 session 最近一次快照（用于计算本轮变更文件列表） */
  private readonly lastSnapshots = new Map<string, SnapshotID>()
  constructor(
    defaultAgentId: string,
    private readonly deps: {
      readonly session: SessionManager
      readonly toolRegistry: ToolRegistry
      readonly toolPipeline: ToolPipeline
      readonly chatProvider: (providerId?: string) => ChatProvider
      readonly permission: PermissionEngine
      readonly triggerPlugin: <N extends keyof Hooks>(
        name: N,
        ...args: Parameters<NonNullable<Hooks[N]>>
      ) => Promise<void>
      readonly bus: Bus
      readonly cwd: string
      /** 可选：快照服务工厂（注入后自动 capture 挂载 meta.snapshot） */
      readonly snapshot?: () => SnapshotService
    }
  ) {
    this.defaultAgentId = defaultAgentId
  }

  /** 把 Session.CompactMemory 追加到 sysParts（作为长期系统记忆），让 LLM 看到已压缩的历史。 */
  private async appendCompactionMemory(sessionId: string, sysParts: string[]): Promise<void> {
    const info = await this.deps.session.getCompactionInfo(sessionId)
    if (!info.memory?.summaryText) return
    const blockLines: string[] = []
    blockLines.push('=== 会话压缩记忆（已被截断/压缩的对话历史摘要）===')
    blockLines.push(`压缩轮次：${info.memory.round}`)
    if (info.memory.memoryStartAt) {
      blockLines.push(`覆盖时间起点：${new Date(info.memory.memoryStartAt).toISOString()}`)
    }
    if (info.meta?.totalPrunedMessages) {
      blockLines.push(`累计压缩消息数：${info.meta.totalPrunedMessages}`)
    }
    blockLines.push('摘要内容：')
    blockLines.push(info.memory.summaryText)
    blockLines.push('===============================================')
    sysParts.push(blockLines.join('\n'))
  }

  /** 惰性获取快照服务（deps.snapshot 未注入则不启用自动快照） */
  private getSnapshotService(): SnapshotService | undefined {
    if (this.snapshotSvc === undefined && this.deps.snapshot) {
      this.snapshotSvc = this.deps.snapshot()
    }
    return this.snapshotSvc
  }

  /**
   * 本轮开始时 capture 文件快照，返回挂到 assistant 消息 `meta.snapshot` 的引用。
   * files 为相对上一轮快照的变更文件列表（首轮为 undefined）；
   * capture 失败 best-effort 返回 undefined（不中断推理）。
   */
  private async captureForMessage(
    sessionId: string,
  ): Promise<{ start: SnapshotID; files?: string[] } | undefined> {
    const svc = this.getSnapshotService()
    if (!svc) return undefined
    try {
      const start = await svc.capture()
      if (!start) return undefined
      const last = this.lastSnapshots.get(sessionId)
      const files = last ? await svc.files(last, start) : undefined
      this.lastSnapshots.set(sessionId, start)
      return { start, files }
    } catch {
      return undefined
    }
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

    // 在处理用户输入前，先 drain 待处理通知（如后台任务完成通知），
    // 将其作为 user-role 消息注入对话，大模型在后续 turn 自动感知任务完成，
    // 不需要主动调用 task_status 工具轮询。参考 Claude Code enqueueAgentNotification。
    const notifications = this.deps.session.drainNotifications(sessionId)
    for (const notif of notifications) {
      await this.deps.session.addMessage(sessionId, {
        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        parts: [{ type: 'text', text: notif }],
        createdAt: Date.now(),
      })
    }

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
    await this.appendCompactionMemory(sessionId, sysParts)
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
    // input.model 优先级高于 agent.model（SubagentTool 派出子 Agent 时可覆盖模型）
    const llmIn: LLMInput = {
      providerId: input.model?.providerId ?? agent.model?.providerId ?? 'default',
      modelId: input.model?.modelId ?? agent.model?.modelId,
      messages: finalMessages,
    }
    const params: LLMParams = {
      temperature: input.model?.temperature ?? agent.model?.temperature ?? 0.7,
      ...(agent.model?.options ?? {}),
    }
    const headers: Record<string, string> = {}
    await this.deps.triggerPlugin('llm.params', llmIn, params)
    await this.deps.triggerPlugin('llm.headers', llmIn, headers)

    const provider = this.deps.chatProvider(llmIn.providerId)
    const completion = await provider.complete({
      providerId: llmIn.providerId,
      modelId: llmIn.modelId,
      messages: finalMessages,
      params,
      headers,
      sessionId,
      agentId,
    })

    // 本轮开始时自动 capture 快照并挂到 assistant 消息（供 revert 收集回滚目标）
    const snap = await this.captureForMessage(sessionId)

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
          ...(completion.tokenUsage.cacheRead !== undefined ? { cacheRead: completion.tokenUsage.cacheRead } : {}),
          ...(completion.tokenUsage.cacheWrite !== undefined ? { cacheWrite: completion.tokenUsage.cacheWrite } : {}),
        } : undefined,
        ...(snap ? { snapshot: { start: snap.start, files: snap.files } } : {}),
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
          cwd: session2.cwd ?? this.deps.cwd,
          requestPermission: (r) => resolvePermission(this.deps.permission, r as ToolPermissionRequest) as Promise<ToolPermissionDecision>,
        }
        const res: ToolResult = await safeExecuteTool(this.deps.toolPipeline, tool, tc.input, tctx)
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
    providerId: string
    modelId?: string
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

    // drain 待处理通知（如后台任务完成通知），注入为 user-role 消息
    const notifications = this.deps.session.drainNotifications(sessionId)
    for (const notif of notifications) {
      await this.deps.session.addMessage(sessionId, {
        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        parts: [{ type: 'text', text: notif }],
        createdAt: Date.now(),
      })
    }

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
    await this.appendCompactionMemory(sessionId, sysParts)
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

    // input.model 优先级高于 agent.model（SubagentTool 派出子 Agent 时可覆盖模型）
    const llmIn: LLMInput = {
      providerId: input.model?.providerId ?? agent.model?.providerId ?? 'default',
      modelId: input.model?.modelId ?? agent.model?.modelId,
      messages: finalMessages,
    }
    const params: LLMParams = {
      temperature: input.model?.temperature ?? agent.model?.temperature ?? 0.7,
      ...(agent.model?.options ?? {}),
    }
    const headers: Record<string, string> = {}
    await this.deps.triggerPlugin('llm.params', llmIn, params)
    await this.deps.triggerPlugin('llm.headers', llmIn, headers)

    return { agentId, sessionId, finalMessages, params, headers, allowedTools, providerId: llmIn.providerId, modelId: llmIn.modelId }
  }

  async *queryStream(input: AgentQueryInput): AsyncGenerator<AgentStreamEvent, void, unknown> {
    const { agentId, sessionId, finalMessages, params, headers, allowedTools, providerId, modelId } = await this._prepareQuery(input)
    const provider = this.deps.chatProvider(providerId)

    // 本轮开始时自动 capture 快照（挂到 assistant 消息 meta.snapshot）
    const snap = await this.captureForMessage(sessionId)

    // 收集流式结果
    let textBuf = ''
    let reasoningBuf = ''
    const toolCalls: Array<{ toolUseId: string; toolId: string; inputParts: string[] }> = []
    let model: string | undefined
    let tokenUsage: TokenUsage | undefined
    let raw: unknown

    if (provider.stream) {
      // 流式路径
      const gen = provider.stream({
        providerId: providerId,
        modelId: modelId,
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
        providerId: providerId,
        modelId: modelId,
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
        tokenUsage: tokenUsage ? {
          input: tokenUsage.input,
          output: tokenUsage.output,
          ...(tokenUsage.cacheRead !== undefined ? { cacheRead: tokenUsage.cacheRead } : {}),
          ...(tokenUsage.cacheWrite !== undefined ? { cacheWrite: tokenUsage.cacheWrite } : {}),
        } : undefined,
        ...(snap ? { snapshot: { start: snap.start, files: snap.files } } : {}),
      },
    }
    if (reasoningBuf) assistant.parts.push({ type: 'reasoning', text: reasoningBuf })
    if (textBuf) assistant.parts.push({ type: 'text', text: textBuf })

    // 读取会话级工作目录（若 Session.cwd 存在则覆盖全局 deps.cwd，支持子 Agent worktree 隔离）
    const sessCwd = (await this.deps.session.get(sessionId))?.cwd
    const tctxCwd = sessCwd ?? this.deps.cwd

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
        cwd: tctxCwd,
        requestPermission: (r) => resolvePermission(this.deps.permission, r as ToolPermissionRequest) as Promise<ToolPermissionDecision>,
      }
      const res: ToolResult = await safeExecuteTool(this.deps.toolPipeline, tool, parsedInput, tctx)
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
  /**
   * 组装工具池：对每个已注册 Agent 触发 `tool.pool.assemble` Hook，把插件工具注册进全局
   * ToolRegistry。幂等（ToolPool.add 仅注册尚未注册的工具）。供 boot 后台预加载插件后主动
   * 预热，使 /tools 无需等待首条消息即可呈现「已加载」状态（query 内部仍会再触发一次）。
   */
  assembleTools(): Promise<void>

  // === 能力访问器 ===
  readonly session: SessionManager
  readonly agent: AgentRuntime
  readonly plugin: PluginManager
  readonly bus: Bus
  readonly context: ContextProvider
  readonly tools: ToolRegistry
  readonly toolPipeline: ToolPipeline
  readonly permission: PermissionEngine
  /** Skill 管理器（加载/查询/禁用/重载技能；插件可在 harness.init 中通过此注册 plugin 来源技能） */
  readonly skillManager?: SkillManager

  // === 工作目录 ===
  /** 全局工具工作目录（= options.cwd ?? process.cwd()；子 Agent 判断 git worktree 用） */
  readonly cwd: string
}

/** createHarness() 参数 */
export interface AgentHarnessOptions {
  /** 工作目录（注入 ToolContext.cwd，默认 process.cwd()） */
  cwd?: string
  /** 默认 Agent ID（必填：需要能在 agent.register 后生效） */
  defaultAgentId?: string
  /** 初始 Agent 定义列表（默认注册） */
  agents?: AgentDefinition[]
  /**
   * Agent 配置文件目录列表（从 .harness/agents/ 等目录加载 Markdown Agent 定义）
   * 每个目录扫描 *.md 文件，解析 frontmatter + body 为 AgentDefinition 并注册。
   * 加载顺序：options.agents 先注册，然后 agentDirs 中的 Agent（同 ID 后加载覆盖先加载）
   *
   * 支持两种形式：
   * - 字符串：目录路径（缺省按 project 来源处理）
   * - 对象：`{ dir: string, source?: 'user' | 'project' }` 显式指定来源
   *
   * 多级加载：建议 user 目录在前，project 目录在后，project 覆盖 user
   * 例：`[{ dir: '~/.harness/agents', source: 'user' }, '.harness/agents']`
   */
  agentDirs?: Array<string | { dir: string; source?: 'user' | 'project' }>
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
  /**
   * Skill 配置文件目录列表（从 .harness/skills/ 等目录加载 SKILL.md）
   * 支持两种目录结构：
   * - skill-name/SKILL.md（目录形式，Claude Code 风格）
   * - skill-name.md（单文件形式）
   * Skill 通过 agent.skills 白名单注入到 system prompt
   *
   * 支持两种形式：
   * - 字符串：目录路径（缺省按 project 来源处理）
   * - 对象：`{ dir: string, source?: SkillSource }` 显式指定来源
   *
   * 多级加载：建议 user 目录在前，project 目录在后，project 覆盖 user。
   * MCP 来源一般不走文件目录，建议通过插件用 register() 注册。
   * 例：`[{ dir: '~/.harness/skills', source: 'user' }, '.harness/skills']`
   */
  skillDirs?: Array<string | { dir: string; source?: SkillSource }>
  /** 可选：自定义 ChatProvider 注入（若无则安装 Provider 插件后才可用） */
  chatProvider?: ChatProvider
  /** 可选：自定义 PermissionEngine（无则 DefaultPermissionEngine，默认 ask→deny） */
  permission?: PermissionEngine
  /** 可选：自定义 Bus 实例（无则 createBus()） */
  bus?: Bus
  /** 可选：自定义 ToolRegistry（便于测试注入） */
  toolRegistry?: ToolRegistry
  /**
   * 可选：快照服务工厂（@harness/snapshot）。
   * 注入后，AgentRuntime 每轮 query/queryStream 会自动 capture 文件快照，
   * 并把 `meta.snapshot = { start, files }` 挂到生成的 assistant 消息上
   * （供 @harness/revert 收集回滚目标，对齐 OpenCode message.snapshot）。
   * 未注入则不启用自动快照记录。
   */
  snapshot?: () => SnapshotService
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
  /** Skill 管理器（从 skillDirs 加载，通过 prompt.system.transform 注入） */
  public skillManager?: SkillManager
  /** 全局工具工作目录（= options.cwd ?? process.cwd()） */
  public readonly cwd: string

  private chatProvider: ChatProvider
  private started = false
  private stopped = false

  constructor(private readonly options: AgentHarnessOptions) {
    this.bus = options.bus ?? createBus()
    this.cwd = options.cwd ?? process.cwd()
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
      checkPermission: (req) => resolvePermission(this.permission, req as ToolPermissionRequest) as Promise<ToolPermissionDecision>,
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
      chatProvider: (providerId?: string) => this.resolveChatProvider(providerId),
      permission: this.permission,
      triggerPlugin: (n, ...args) => (this.plugin as any).trigger(n, ...args),
      bus: this.bus,
      cwd: options.cwd ?? process.cwd(),
      snapshot: options.snapshot,
    })
    ;(options.agents ?? []).forEach((a) => agentImpl.register(a))

    // 从配置文件目录加载 Agent（支持多级来源：user → project，后加载覆盖先加载）
    // 参考 Claude Code loadAgentsDir 和 OpenCode config.ts loadAgent 逻辑
    // 目录枚举/来源标注/覆盖顺序交由 MultiDirLoader（workspace 通用原语，收敛 readdir + source 骨架）；
    // source 仅用于日志，AgentDefinition 没有 loadedFrom 字段（多级覆盖通过加载顺序保证，user 在前 project 在后）
    const cwd = this.options.cwd ?? process.cwd()
    const agentLoader = new MultiDirLoader(
      normalizeDirs(options.agentDirs ?? [], 'project').map((e) => ({ dir: resolve(cwd, e.dir), source: e.source })),
    )
    for (const item of agentLoader.scan({ kind: 'file', name: (n) => extname(n) === '.md' })) {
      try {
        const content = readFileSync(item.full, 'utf-8')
        // 文件名（不含扩展名）作为 fallbackId
        const def = agentFromMarkdown(content, basename(item.name, '.md'))
        agentImpl.register(def)
      } catch (err) {
        this.options.logger?.warn?.(`Agent 配置文件加载失败: ${item.full}: ${(err as Error)?.message ?? err}`)
      }
    }

    this.agent = agentImpl
    agentRuntime = agentImpl

    // SkillManager 实例化（从 skillDirs 异步加载放到 init() 中，避免构造函数里 await）
    this.skillManager = createSkillManager()

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

      // Skill 注入插件：在 prompt.system.transform Hook 中注入匹配的 Skill 内容
      // 参考 Claude Code 的 Skill 注入机制：agent.skills 白名单中的 Skill 自动注入到 system prompt
      if (this.skillManager) {
        // 1. 从 skillDirs 异步加载 SKILL.md（构造函数中不能 await，故延迟到 init）
        //    多级来源：按 skillDirs 数组顺序加载，后加载覆盖先加载（user → project）
        //    支持 string（缺省 project）和 {dir, source} 对象形式；目录归一化/来源标注交由 MultiDirLoader
        const cwd = this.options.cwd ?? process.cwd()
        const skillLoader = new MultiDirLoader(
          normalizeDirs(
            (this.options.skillDirs ?? []).map((e): DirEntryInput =>
              typeof e === 'string' ? e : { dir: e.dir, source: e.source as DirSource }),
            'project',
          ).map((e) => ({ dir: resolve(cwd, e.dir), source: e.source })),
        )
        for (const { dir, source } of skillLoader.dirs) {
          try {
            await this.skillManager.load(dir, source)
          } catch (err) {
            this.options.logger?.warn?.(`Skill 目录加载失败: ${dir} (source=${source}): ${(err as Error)?.message ?? err}`)
          }
        }

        // 2. 仅当有 Skill 加载成功时才注册注入插件（避免空 Hook）
        if (this.skillManager.all().length > 0) {
          const skillManager = this.skillManager
          const agentAccessor = this.agent
          await this.plugin.loadInternal([{
            id: 'core.skill-injection',
            version: '0.1.0',
            name: 'Skill 注入',
            description: '将 agent.skills 白名单中的 Skill 通过 prompt.system.transform 注入到 system prompt',
            async install() {
              return {
                async 'prompt.system.transform'(
                  input: { agentId: string; sessionId: string },
                  parts: string[],
                ) {
                  const agent = agentAccessor.get(input.agentId)
                  if (!agent?.skills || agent.skills.length === 0) return
                  // 注入白名单中的 Skill（参考 Claude Code getPromptForCommand）
                  for (const skillId of agent.skills) {
                    const skill = skillManager.get(skillId)
                    if (skill) {
                      parts.push(formatSkillForPrompt(skill))
                    }
                  }
                },
              } as import('@harness/plugin').Hooks
            },
          }])
        }
      }

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

  /**
   * 组装工具池（见 Harness.assembleTools 注释）。与 query 内联逻辑一致：新建
   * DefaultToolPool 绑定全局 ToolRegistry，逐 Agent 触发 tool.pool.assemble Hook。
   */
  async assembleTools(): Promise<void> {
    const pool = new DefaultToolPool(this.tools)
    for (const def of this.agent.list()) {
      await (this.plugin as any).trigger('tool.pool.assemble', { agentId: def.id } as ToolPoolAssembleInput, pool)
    }
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

  // ----- Provider 注册表：支持多 Provider，按 providerId 分发 -----

  /** 已注册的 ChatProvider（key = provider.id）。支持多 Provider 自由切换。 */
  private readonly chatProviders = new Map<string, ChatProvider>()

  /** 按 providerId 解析 ChatProvider：命中注册表返回之，否则回退默认 Provider。 */
  resolveChatProvider(providerId?: string): ChatProvider {
    // 上下文可能记录了最新的默认 provider（_setChatProvider / 插件注册）
    const ctxProvider = this.context.resolve<ChatProvider>('chat.provider')
    if (providerId && providerId !== 'default' && this.chatProviders.has(providerId)) {
      return this.chatProviders.get(providerId)!
    }
    return ctxProvider ?? this.chatProvider
  }

  // ----- 内部工具：替换 ChatProvider（供 Plugin 使用） -----
  /** @internal 替换默认 ChatProvider（Provider 插件 install 时调用）；同时按 Provider.id 注册到注册表 */
  _setChatProvider(p: ChatProvider): void {
    this.chatProvider = p
    this.context.register('chat.provider', p)
    if (p?.id) this.chatProviders.set(p.id, p)
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
