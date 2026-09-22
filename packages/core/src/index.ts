/**
 * @harness/core - Harness 核心编排器
 *
 * 顶层实例，纯逻辑内核，统一编排：
 * - 生命周期（init→start→stop）串联 Bus 事件 + Plugin Hooks
 * - 能力模块访问器（session/agent/plugin/bus/tool/permission/skill/context）
 * - Tool Pipeline 接入 Plugin hooks（pre/post 管道桥接）
 * - LLM 调用链路（ChatProvider → core.llm.params 钩子）
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
import { createHash } from 'node:crypto'

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
  PermissionRequestLike,
  PermissionDecisionLike,
} from '@harness/plugin'
import type { CompactionContext, SystemStabilityReport } from '@harness/plugin'
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
  filterMcpTools,
} from '@harness/tool'
import type {
  AgentDefinition,
} from '@harness/agent'
import { agentFromMarkdown } from '@harness/agent'
import {
  USAGE_STATS_KEY,
  emptyFoldState,
  foldMessage,
  hydrateUsage,
  isBlankUsage,
  rebuildUsage,
  usageFromMeta,
  type UsageFoldState,
  type UsageStats,
} from '@harness/usage'
import { createSkillManager, formatSkillForPrompt, type SkillManager, type Skill, type SkillSource } from '@harness/skill'
import {
  MultiDirLoader,
  normalizeDirs,
  resolveWorkspace,
  type DirEntryInput,
  type DirSource,
  type Workspace,
} from '@harness/workspace'
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
  SessionView,
  HistoryLoader,
  HistoryLoadRange,
  SessionOriginalStore,
  TokenCalibration,
} from '@harness/session'
import {
  COMPACT_META_KEY as COMPACT_META_KEY_VAL,
  COMPACT_MEMORY_KEY as COMPACT_MEMORY_KEY_VAL,
  buildView,
  countTokensCJK,
  renderBlocksAsMessage,
  getSessionModelOverride,
  resolveCountTokens,
} from '@harness/session'
export {
  countTokensCJK,
  countTokensChars4,
  resolveCountTokens,
} from '@harness/session'
export type { TokenCalibration } from '@harness/session'
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
 * 触发插件 hook 的通用签名（与 PluginManager.trigger 同形）。
 * 供 `resolvePermission` 这类自由函数按需注入，避免把 PluginsRegistry 类型漏进工具链。
 */
type PluginTrigger = <N extends keyof Hooks>(
  name: N,
  ...args: Parameters<NonNullable<Hooks[N]>>
) => Promise<void>

/**
 * 把 `PluginManager.trigger` 包成可安全传递的触发函数。
 *
 * 为什么要包一层：`trigger` 是**类方法**，实现里读 `this.hooks` —— 直接把
 * `pm.trigger` 当值传出去会丢 this（运行时炸）。此前各处只能用
 * `(n, ...args) => (pm as any).trigger(n, ...args)` 绕类型，这里收口成一处，
 * 顺带把泛型签名保住（调用方 `trigger('core.llm.params', ...)` 仍有完整类型检查）。
 */
function bindTrigger(pm: PluginManager): PluginTrigger {
  return (name, ...args) => pm.trigger(name, ...args)
}

/**
 * 权限判定两步走：先 check（不询问），若需询问则调用 ask()（交上层交互，
 * 无交互器时引擎 ask() 默认 deny，保证安全）。工具执行统一经此入口拿到最终 allow/deny。
 *
 * 在 check 之后、ask() 之前插入 `core.permission.check` hook：插件可原地改写决策
 * （如 teammate 桥接 leader、herdr 上报「等待用户决策」）。触发点刻意放在 **ask 之前**：
 * 只有此刻 `decision.behavior` 还可能是 `'ask'`，消费方才能分辨「真会弹窗」与
 * 「规则已记住、不会弹窗」；放到 ask 之后就永远看不到 ask 了（那是 hook 契约失效，
 * 不是消费方的判断错）。
 *
 * 触发后行为：
 * - 插件把 behavior 改成 allow/deny ⇒ 直接采纳，不再询问用户；
 * - 插件改写了 updatedInput 而引擎侧决策没带回 ⇒ 补回，避免改写丢失
 *   （ToolPipeline 从返回的 decision.updatedInput 重写工具入参）。
 */
async function resolvePermission(
  engine: PermissionEngine,
  req: ToolPermissionRequest,
  triggerPlugin?: PluginTrigger,
): Promise<ToolPermissionDecision> {
  const d = await engine.check(req)
  const decision = { ...d } as PermissionDecisionLike
  if (triggerPlugin) {
    await triggerPlugin('core.permission.check', req as PermissionRequestLike, decision)
  }
  if (decision.behavior !== 'ask') return decision as ToolPermissionDecision
  const asked = await engine.ask(req)
  if (asked.updatedInput === undefined && decision.updatedInput !== undefined) {
    return { ...asked, updatedInput: decision.updatedInput }
  }
  return asked
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

/** 按 JSON Schema 的 type 生成一个占位值（只为让模型看懂"形状"，不是可直接使用的答案） */
function placeholderForType(type?: string): unknown {
  switch (type) {
    case 'number':
    case 'integer': return 0
    case 'boolean': return true
    case 'array': return []
    case 'object': return {}
    default: return '<string>'
  }
}

/**
 * 「入参自愈」：模型发出**零参数**工具调用时，把该工具的必填参数与最小示例直接写进错误消息。
 *
 * 为什么需要：schema 只影响模型"看不看得懂"，运行时的缺参保护在各工具入口（AGENTS.md 的硬约定）。
 * 真机实测（会话 `s_1789996799007_9cq9r`）模型会整段丢掉 tool-call arguments —— 100 次调用里
 * 37 次失败，其中 34 次 `input: {}`；这些轮的 output 中位数只有 22 token（发个空壳就结束），
 * 且**失败率随上下文增长从 12% 升到 50%**。原样回传错误消息时模型只能盲猜重试，
 * 每次失败都实打实烧掉一轮完整 prompt（占该会话上下文的 43.6%）。
 *
 * 只在「必填项一个都没给全」时才附加：必填齐全 ⇒ 是别的业务错误，不掺和（避免噪音与误伤）。
 */
function describeMissingRequiredParams(tool: Tool, input: unknown): string | undefined {
  const schema = tool.inputSchema?.__jsonSchema
  const required = Array.isArray(schema?.required) ? (schema!.required as string[]) : []
  if (required.length === 0) return undefined
  const obj = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
  const present = required.filter((k) => obj != null && obj[k] !== undefined && obj[k] !== null)
  if (present.length === required.length) return undefined
  const props = (schema?.properties ?? {}) as Record<string, { type?: string; description?: string }>
  const lines = required.map((k) => {
    const p = props[k] ?? {}
    return `  - ${k}（${p.type ?? 'any'}）${p.description ? `：${p.description}` : ''}`
  })
  const example: Record<string, unknown> = {}
  for (const k of required) example[k] = placeholderForType(props[k]?.type)
  const got = present.length > 0 ? `（已给出：${present.join('、')}）` : '（一个都没给）'
  return `[入参自愈] 工具「${tool.id}」缺少必填参数${got}。\n` +
    `必填参数：\n${lines.join('\n')}\n` +
    `最小示例：${JSON.stringify(example)}`
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
// 3. ChatProvider（LLM 抽象）+ core.llm.params Hook 桥
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

/**
 * 模型结束原因（跨 Provider **规范化后**的取值）。
 *
 * 各家原生值域不同（Anthropic `end_turn`/`tool_use`/`max_tokens`、OpenAI `stop`/`tool_calls`/
 * `length`/`content_filter`、Gemini 大写 `STOP`/`SAFETY`/`MALFORMED_FUNCTION_CALL`…），
 * 引擎只认这一套；原生值保留在 `finishRaw`，便于排障与新增枚举排查。
 *
 * 用途：agentic loop 的退出判定（`stop`/`length`/`content_filter` ⇒ 本轮即终点；
 * `tool_calls` ⇒ 需回喂工具结果续轮）。
 */
export type ChatFinishReason =
  /** 自然结束（本轮无待执行的工具调用） */
  | 'stop'
  /** 因工具调用而结束（工具结果需回喂后继续） */
  | 'tool_calls'
  /** 触达输出长度上限，内容被截断 */
  | 'length'
  /** 被内容安全策略拦截 */
  | 'content_filter'
  /** Provider 侧异常结束 */
  | 'error'
  /** 原生值不在已知集合内（语义未定，勿据此做退出判定） */
  | 'unknown'

/**
 * 原生 finish 值 → 规范化 {@link ChatFinishReason} 的映射表。
 *
 * 键一律**小写**（比较前对原生值做 trim + toLowerCase），故 `STOP` / `stop` / `' stop '`
 * 都能命中。表里没有的值落 `'unknown'` 而非猜一个近义项 —— 猜错会让循环提前退出或空转。
 */
export const FINISH_REASON_MAP: Readonly<Record<string, ChatFinishReason>> = {
  // 自然结束
  stop: 'stop',
  end_turn: 'stop',
  stop_sequence: 'stop',
  eos: 'stop',
  end: 'stop',
  complete: 'stop',
  // 工具调用
  tool_calls: 'tool_calls',
  tool_use: 'tool_calls',
  function_call: 'tool_calls',
  function_calls: 'tool_calls',
  // 触达上限
  length: 'length',
  max_tokens: 'length',
  max_output_tokens: 'length',
  token_limit: 'length',
  // 内容安全
  content_filter: 'content_filter',
  safety: 'content_filter',
  recitation: 'content_filter',
  blocklist: 'content_filter',
  prohibited_content: 'content_filter',
  spii: 'content_filter',
  image_safety: 'content_filter',
  // 异常
  error: 'error',
  malformed_function_call: 'error',
  failed: 'error',
  cancelled: 'error',
  timeout: 'error',
}

/**
 * 把 Provider 原生 finish 值规范化为 {@link ChatFinishReason}。
 *
 * 纯函数、无副作用；`null` / `undefined` / 空串 / 未知值一律返回 `'unknown'`
 * （**不是** `'stop'` —— "没有 finish 信息"与"模型明确表示结束"是两件事，
 * 前者只能靠 toolCalls 是否为空来判断，不能被误当成终点）。
 */
export function normalizeFinishReason(raw: string | null | undefined): ChatFinishReason {
  if (typeof raw !== 'string') return 'unknown'
  const key = raw.trim().toLowerCase()
  if (!key) return 'unknown'
  return FINISH_REASON_MAP[key] ?? 'unknown'
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
  /**
   * 结束原因（规范化）。缺失表示该 Provider 未提供此信息 —— 循环退出判定此时
   * 必须回退到「toolCalls 是否为空」，不能把缺失当作 `'stop'`。
   */
  finish?: ChatFinishReason
  /** Provider 原生 finish 值（如 `end_turn` / `tool_calls` / `STOP`），仅用于排障 */
  finishRaw?: string
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
  /** done 时的结束原因（规范化），语义同 ChatCompletionOutput.finish */
  finish?: ChatFinishReason
  /** done 时的 Provider 原生 finish 值，仅用于排障 */
  finishRaw?: string
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
    | 'done'             // **一步**结束（A 方案：引擎内自主多步时每个 step 都发一次，含 step 序号）
    | 'turn_end'         // **整轮**结束：所有 step 已跑完，本次查询不会再有任何事件
  text?: string
  toolUseId?: string
  toolId?: string
  input?: unknown
  result?: unknown
  isError?: boolean
  /** done 时的最终 assistant 消息 */
  message?: Message
  /**
   * done 时的步序号（从 1 开始）。
   *
   * A 方案：**每个 step 结束都发一次 done**（语义 = "这一步结束"），而不是只在最末轮发。
   * 上层据此把 done 当作"一次收尾渲染"信号，由 `step` 与后续是否再来 done 判断整轮是否结束；
   * 不要用"收到 done"作为"本次查询全部完成"的依据。
   */
  step?: number
  /**
   * done 时的结束原因（规范化）。agentic loop 据此判定是否续轮；
   * 缺失表示 Provider 未提供 —— 此时只能回退到「本轮是否产生工具调用」来判断。
   */
  finish?: ChatFinishReason
  /** done 时的 Provider 原生 finish 值，仅用于排障 */
  finishRaw?: string
  /**
   * done / turn_end 时：本次是否**因外部中断**（`signal`）而提前结束。
   *
   * 没有这个字段时，「模型正常收尾」与「用户按了 Ctrl-C」的事件序列完全一致
   * （都是 done + finish=stop），UI 只能靠自己的侧信道猜。中断时本步已完成的部分
   * 仍会写回会话，故上层应把它呈现为"已中断（保留已完成部分）"而非失败。
   */
  aborted?: boolean
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
    /**
     * 本 agent 实际可用的工具（已按 agent 白名单过滤）。
     * Provider 据此生成 tools 载荷；缺省时退回全局注册表 —— 那会让模型看到它无权执行的工具。
     */
    tools?: Tool[]
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
    /** 同 complete：本 agent 实际可用的工具（按 agent 白名单过滤） */
    tools?: Tool[]
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
  /** 触发插件 hook（供 core.session.compacting 等生命周期接入） */
  readonly triggerPlugin: <N extends keyof Hooks>(
    name: N,
    ...args: Parameters<NonNullable<Hooks[N]>>
  ) => Promise<void>
  /** 原文档案存储器（宿主注入；compact 裁剪前把窗口原文落盘，供全文回溯） */
  readonly originalStore?: SessionOriginalStore
}

// 把任意 title 转成安全的会话 id slug：只保留 ASCII 字母/数字（CJK 与非 ASCII 直接丢弃，
// 不引入任何拼音/转写依赖），非字母数字连续压成单个 `-`，首尾去 `-`，截断到 24 字符。
// 这样中文描述不会像 `\W` 那样被整串变成下划线、也保证 id 可读可 grep。
function slugifyTitle(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9]+/g, '-') // 非 ASCII 字母数字（含中文）→ 分隔符
    .replace(/-+/g, '-') // 连续分隔符压成一个
    .replace(/^-+|-+$/g, '') // 首尾去 `-`
    .slice(0, 24)
    .replace(/^-+|-+$/g, '') // 截断后可能残留首尾 `-`
}

export class DefaultSessionManager implements SessionManager {
  private readonly sessions = new Map<string, Session>()
  /** 脏会话集合：自上次落盘以来发生过变更的会话 id（标脏由 SessionManager 统一登记） */
  private readonly dirty = new Set<string>()
  /** 会话惰性加载器（host 注入，供 flushHistory 按需读盘原文） */
  private readonly historyLoaders = new Map<string, HistoryLoader>()
  constructor(private readonly services?: () => SessionServices) {}

  /** 标脏：登记某会话自上次落盘后有变更（供宿主在轮末批量保存） */
  markDirty(sessionId: string): void {
    this.dirty.add(sessionId)
  }

  /** 取出自上次落盘以来变更的会话（脏会话）并清空脏标记；供宿主在轮末批量保存 */
  takeDirtySessions(): Session[] {
    const out: Session[] = []
    for (const id of this.dirty) {
      const s = this.sessions.get(id)
      if (s) out.push(s)
    }
    this.dirty.clear()
    return out
  }

  /** 访问注入的原文档案器（compact 落盘原文用） */
  private get originalStore(): SessionOriginalStore | undefined {
    return this.services?.()?.originalStore
  }

  async create(options: SessionCreateOptions = {}): Promise<Session> {
    // title → 安全 slug（中文等非 ASCII 直接丢弃）；空 slug 回落 'session'。
    // 末尾拼 Date.now() + 随机段：随机段保证同一毫秒内多次 create 不会撞 id（即使 slug 相同），
    // 再用已存在 id 兜底去重，彻底规避「同毫秒 + 相同 slug」互相覆盖。
    const rand = () => Math.random().toString(36).slice(2, 7) // 5 位 base36
    const slug = options?.title ? slugifyTitle(options.title) || 'session' : ''
    let id: string
    do {
      id = slug
        ? `s_${slug}_${Date.now()}_${rand()}`
        : `s_${Date.now()}_${rand()}`
    } while (this.sessions.has(id))
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
    // 新会话标脏：确保子会话（subagent 插件内部 create）也能在轮末被落盘
    this.dirty.add(id)
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
      // 脏标记随 id 迁移：否则按 newId 查不到脏状态、子会话恢复后不会被落盘
      this.dirty.delete(oldId)
      this.dirty.add(newId)
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
    // 会话级模型覆盖（Session.meta.model）优先级最高：会话内用 /model 切换后
    // 只影响本会话，不改 Agent 定义、不写 config.json，因此必须在这里透传给查询。
    const model = getSessionModelOverride(sess)
    const assistant = await svc.agent.query({
      sessionId,
      agentId: sess.agentId ?? svc.currentAgentId(),
      message: text,
      ...(model ? { model } : {}),
    })
    return assistant as Message
  }

  async *promptStream(
    sessionId: string,
    text: string,
    maxSteps?: number,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent, void, unknown> {
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
    const model = getSessionModelOverride(sess)
    const gen = svc.agent.queryStream({
      sessionId,
      agentId: sess.agentId ?? svc.currentAgentId(),
      message: text,
      ...(model ? { model } : {}),
      ...(maxSteps != null ? { maxSteps } : {}),
      ...(signal ? { signal } : {}),
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
    this.dirty.add(sessionId)
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
    this.dirty.add(sessionId)
  }

  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return
    sess.messages = sess.messages.filter((m) => m.id !== messageId)
    sess.updatedAt = Date.now()
    this.dirty.add(sessionId)
  }

  async setMessages(sessionId: string, messages: Message[]): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return
    sess.messages = messages
    sess.updatedAt = Date.now()
    this.dirty.add(sessionId)
  }

  async setBlocks(sessionId: string, blocks: NonNullable<Session['blocks']>): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess || blocks.length === 0) return
    const map = new Map<string, NonNullable<Session['blocks']>[number]>((sess.blocks ?? []).map((b) => [b.id, b]))
    const now = Date.now()
    for (const b of blocks) map.set(b.id, { ...b, at: now })
    sess.blocks = [...map.values()]
    sess.updatedAt = now
    this.dirty.add(sessionId)
  }

  async updateMeta(sessionId: string, patch: Record<string, unknown>): Promise<void> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return
    sess.meta = { ...(sess.meta ?? {}), ...patch }
    sess.updatedAt = Date.now()
    this.dirty.add(sessionId)
  }

  async getView(sessionId: string): Promise<SessionView> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return { blocks: [], messages: [], slimmed: false }
    return buildView(sess.blocks, sess.messages)
  }

  setHistoryLoader(sessionId: string, loader?: HistoryLoader): void {
    if (loader) this.historyLoaders.set(sessionId, loader)
    else this.historyLoaders.delete(sessionId)
  }

  async flushHistory(sessionId: string, range?: HistoryLoadRange): Promise<Message[]> {
    const loader = this.historyLoaders.get(sessionId)
    if (!loader) return []
    try {
      return await loader.load(sessionId, range)
    } catch {
      // 惰性加载失败仅返回空，不影响主流程
      return []
    }
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
    let strat = strategy ?? options.strategy ?? 'summary'
    const keepRecent = Math.max(options.keepRecentMessages ?? 10, 0)

    const beforeLen = sess.messages.length
    // 所有消息按时间排序（约定已是）；不包含 role===system 的消息（它们在 AgentRuntime 内动态构建，不在 session.messages 里）
    const msgs = sess.messages
    if (msgs.length <= keepRecent) return // 无需压缩

    let cutIndex = Math.max(0, msgs.length - keepRecent)
    let windowToPrune = msgs.slice(0, cutIndex)
    let kept = msgs.slice(cutIndex)

    // 触发 core.session.compacting hook：给插件（如 ACP）在删除前保全原文的窗口，
    // 并可改写 keepLast/strategy/summary。核心路径此前从未触发该 hook。
    const compactCtx: CompactionContext = {
      keepLast: keepRecent,
      strategy: strat,
      window: windowToPrune,
      meta: {
        read: async () => sess.meta,
        patch: async (patch) => {
          sess.meta = { ...(sess.meta ?? {}), ...patch }
          sess.updatedAt = Date.now()
        },
      },
    }
    await this.services?.()?.triggerPlugin(
      'core.session.compacting',
      { agentId: sess.agentId ?? '', sessionId },
      compactCtx,
    )
    // 消费插件改写：keepLast → 重算窗口/保留段；strategy 覆盖；已提供 summary 则不再自行生成
    if (compactCtx.keepLast != null && compactCtx.keepLast !== keepRecent) {
      cutIndex = Math.max(0, msgs.length - Math.max(compactCtx.keepLast, 0))
      windowToPrune = msgs.slice(0, cutIndex)
      kept = msgs.slice(cutIndex)
    }
    if (compactCtx.strategy != null) strat = compactCtx.strategy
    const pluginSummary = compactCtx.summary

    // 生成摘要（仅 summary / agent；插件已提供 summary 时跳过自行生成）
    let summaryText: string | undefined = pluginSummary
    const prevMemory = this.readMemory(sess)

    if (summaryText === undefined && (strat === 'summary' || strat === 'agent')) {
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

    // 上下文压缩·统一块模型：ACP 已认领窗口（windowHandled）时，由 ACP 落 source:'acp' 块，
    // core 不再重复归档 / 产 generic 块（消除同一窗口双击/双归档）。
    // 否则走通用 compact 产 source:'generic' 块 + .cmp.orig 原文档案（内存瘦身 + 全文可回溯）。
    if (windowToPrune.length > 0 && !compactCtx.windowHandled) {
      const blockId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      // 原文落盘为 best-effort：失败仅记录，不阻断压缩（此时归档缺失，全文回溯退化为仅摘要）
      if (this.originalStore) {
        try {
          await this.originalStore.save(sessionId, blockId, windowToPrune)
        } catch {
          // SessionManager 无统一 logger，使用 console 兜底告警（不阻断主流程）
          if (typeof console !== 'undefined') {
            console.warn(`[compact] 原文归档失败，session=${sessionId} block=${blockId}`)
          }
        }
      }
      sess.blocks = [
        ...(sess.blocks ?? []),
        {
          id: blockId,
          topic: '会话压缩',
          summary: summaryText ?? '',
          startId: windowToPrune[0]?.id ?? '',
          endId: windowToPrune[windowToPrune.length - 1]?.id ?? '',
          at: now,
          origKey: blockId,
          source: 'generic',
        },
      ]
    }

    // 应用插件（ACP）回传的折叠块：按块 id 合并去重进入统一 session.blocks，
    // 使 ACP 折叠与通用 compact 块一致，供视图/loader/reconstructHistory/revert 消费。
    const patches = compactCtx.blocksPatch ?? []
    if (patches.length > 0) {
      const map = new Map<string, NonNullable<Session['blocks']>[number]>(
        (sess.blocks ?? []).map((b) => [b.id, b]),
      )
      for (const p of patches) {
        map.set(p.id, { ...p, at: now })
      }
      sess.blocks = [...map.values()]
    }

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
    // token 估算：优先用旧的 tokensPerMessage（向后兼容），否则按 tokenCalibration 口径
    const countTokens = resolveCountTokens(options.tokenCalibration, options.tokenCalibrationScale)
    const estimated = options.tokensPerMessage != null
      ? sess.messages.length * options.tokensPerMessage
      : this.estimateTokensForMessages(sess.messages, countTokens)
    // 阈值计算：固定阈值优先，否则用百分比
    let threshold: number
    if (options.thresholdTokens != null) {
      threshold = options.thresholdTokens
    } else {
      // contextWindowTokens 缺省只作兜底：真实窗口应由调用方（CLI）按「显式覆盖 →
      // 默认 Provider 的 contextWindowTokens → 200000」推导后显式传入。这里若默默用
      // 200000，小窗口模型（如 102400）会算出阈值 136000 > 窗口本身 ⇒ 永远压不到 ⇒
      // 自动压缩"配了但从不生效"，还不报错。
      const ctx = options.contextWindowTokens ?? 200000
      const reserved = options.reservedTokens ?? 30000
      const pct = options.autoCompactThresholdPct ?? 80
      threshold = Math.floor((ctx - reserved) * (pct / 100))
    }
    if (estimated < threshold) return false
    await this.compact(sessionId, options.strategy ?? 'summary', options)
    return true
  }

  async estimateTokens(
    sessionId: string,
    calibration?: TokenCalibration,
    /** 额外校正系数（缺省 1）；与 `compression.tokenCalibrationScale` 同源 */
    scale: number = 1,
  ): Promise<number> {
    const sess = this.sessions.get(sessionId)
    if (!sess) return 0
    return this.estimateTokensForMessages(sess.messages, resolveCountTokens(calibration, scale))
  }

  /** @see estimateMessagesTokens（抽成模块级函数：`_runOneStep` 在另一个类里也要用） */
  private estimateTokensForMessages(
    messages: Message[],
    countTokens: (text: string) => number = countTokensCJK,
  ): number {
    return estimateMessagesTokens(messages, countTokens)
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
    // 消息（上下文压缩·阶段二：有压缩块时经 loader 还原全文再导出；否则近期/全量）
    let msgs: Message[] = sess.messages
    if (sess.blocks?.length) {
      const full = await this.flushHistory(sessionId).catch(() => [] as Message[])
      if (full.length > 0) msgs = full
    }
    for (const m of msgs) {
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

  /** 只读查看（不消费）：供自动续轮前的空转判断使用 */
  peekNotifications(sessionId: string): string[] {
    return [...(this.pendingNotifications.get(sessionId) ?? [])]
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
  /**
   * 单次 queryStream 的最多步数（工具结果回喂续轮的次数上限）。
   *
   * 默认 `1` —— 即「单轮」：一次模型调用 + 执行工具后结束，与改造前行为一致。
   * 引擎内自主多步在 S2 放开，届时默认值提高（参照 opencode `agent.steps`）。
   */
  maxSteps?: number
  /**
   * 中断信号。传入后可在**步边界**（不再开始新的一步）与**每个工具执行前**生效，
   * 并会透传给 Provider 请求（chat completion）与 `ToolContext.signal`
   * （bash 会据此 kill 子进程、web 工具会中止 fetch）。
   *
   * 中断时不会丢弃已有成果：本步已产生的 assistant 消息（含已执行工具的结果）照常写回会话，
   * 尚未执行的工具被标记为 `ABORTED` 错误 —— 对齐 opencode 的 cleanup 收尾语义。
   */
  signal?: AbortSignal
  /**
   * 优先使用**非流式** `complete()`（`query()` 走这条）。
   *
   * 非流式入口不需要增量事件，走 complete 更省流式解析开销，也兼容只实现 complete 的端点。
   * `queryStream()` 不设此标志 —— 它要的就是逐 chunk 的增量。
   */
  preferComplete?: boolean
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

/**
 * 一次查询内**不变**的准备产物（`_prepareQueryOnce` 的返回）。
 * 随轮次变化的部分（消息历史、core.llm.params/headers、preModel 裁剪）不在这里，
 * 由 `_buildStepMessages` 每轮重建。
 */
interface PreparedQuery {
  agentId: string
  sessionId: string
  /**
   * 前缀区 system prompt 片段（已过 `core.prompt.system.transform` 与压缩记忆注入）。
   *
   * ⚠️ 只应包含**恒定**文本。位置在请求最前，一变则其后全部内容（含整段历史）
   * 在前缀缓存里失效。会变的内容走 {@link dynParts}。
   */
  sysParts: string[]
  /**
   * 尾部动态上下文片段（已过 `core.prompt.dynamic.transform`）。
   *
   * 与 `sysParts` 的唯一区别是**位置** —— 这些拼在请求最末尾（`user` 角色、每轮重算、
   * 不落库）。前缀缓存按最长公共前缀命中，所以同一份会变的文本放在这里，翻转代价 ≈ 0。
   */
  dynParts: string[]
  /** 本轮相对上一轮 query 的系统区段级归因；仅在实际变化时有值（首轮无基线时也没有） */
  systemStability?: SystemStabilityReport
  allowedTools: Tool[]
  providerId: string
  modelId?: string
  /** 基础 LLM 参数（temperature / agent.model.options），每轮浅拷贝后交给 `core.llm.params` hook */
  paramsBase: LLMParams
}

/** 单个 step 的终值（`_runOneStep` 的 return）——供循环决定是否续轮 */
interface StepOutcome {
  /** 本步写回会话的 assistant 消息 */
  assistant: Message
  /** 本步结束原因（Provider 未提供时为 undefined） */
  finish?: ChatFinishReason
  /** 本步实际发起的工具调用数（> 0 是续轮的必要条件之一，见 docs/agentic-loop-plan.md） */
  toolCallCount: number
  /** 本步工具调用的签名（`toolId|稳定序列化的 input`），跨步累积后用于 doom-loop 检测 */
  toolSigs: string[]
  /**
   * 本步的**聚合签名**（所有 toolSigs 排序后拼接），用于检测「整步重复」。
   *
   * 只有 toolSigs 不够：模型每步返回 2 个调用时全局序列是 `A,B,A,B,A,B…`，
   * 尾部连续 3 个永远不相同 ⇒ 「连续 N 次同一调用」的判据恒不命中、保护失效。
   * 按步聚合后 `A|B,A|B,A|B` 连续 3 步相同即可拦下。
   */
  stepSig: string
  /** 本步是否因 doom-loop 被拒而中断（中断后不再续轮） */
  doomLoopTripped?: boolean
  /** 本步是否因外部中断（`signal`）而提前结束（中断后不再续轮） */
  aborted?: boolean
}

/** 判断一个异常是否为 AbortError（各家实现细节不一，按 name/形状兜底判断） */
function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = (e as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * 从用户文本里提取疑似文件路径的 token，供技能 `paths` 条件触发。
 *
 * 判据（保守，宁多勿漏 —— matchByPath 是 glob 命中，误报只会多注入一条尾部技能，
 * 漏报则技能完全不触发）：
 *  - 去掉引号/括号/空白包裹后仍含 `/` 或 `.` 的连续 token（相对路径 `src/foo.ts`、
 *    绝对路径 `/Users/x/a.ts`、点路径 `./x` / `../y`）；
 *  - 排除纯数字/纯版本号等明显不是路径的串（至少含一个字母）。
 */
export function extractFilePaths(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // 中文标点先换空格：路径后常紧跟中文词且无空格（如 "a.ts，还有"），否则 token 会被中文词粘连
  const normalized = text.replace(/[，。、；：！？]/g, ' ')
  for (const raw of normalized.split(/\s+/)) {
    const tok = raw.replace(/^[(`"'<\[{]+|[)\]>"'\],.:;!?]+$/g, '').trim()
    if (tok.length < 2) continue
    if (!/[/.]/.test(tok)) continue
    if (!/[A-Za-z]/.test(tok)) continue
    // 排除版本号（v1.2 / 1.2.3）等明显非路径
    if (/^v?\d+(\.\d+){1,3}$/i.test(tok)) continue
    if (seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
  }
  return out
}

/**
 * agentic loop 的默认步数上限（含首次模型调用）。
 *
 * 30 是权衡值：够跑完 read → edit → bash → verify 这类典型链条（含若干次重试），
 * 又不至于在一次查询里烧掉失控的 token。可用 `AgentDefinition.maxSteps` 或
 * `AgentQueryInput.maxSteps` 覆盖（后者优先）；`-1` 表示不限。
 */
export const DEFAULT_MAX_STEPS = 30

/**
 * 步数上限归一化 —— 引擎侧**唯一**的判定点（`AgentQueryInput.maxSteps` 与
 * `AgentDefinition.maxSteps` 都经这里变成最终上限）。
 *
 * 合法输入：
 * - `-1` 或 `+Infinity` → 不限（仅受 doom-loop 守卫约束）
 * - 有限且 `>= 1` → 取下整
 *
 * 其余（`0`、`-2` 这类 `< -1`、`NaN`、非法类型）一律返回 `undefined`，语义是
 * **「未指定」**，由调用方按优先级回落下一层（引擎调用点见 {@link DEFAULT_MAX_STEPS} 的取值链）。
 *
 * 为什么不沿用 `Math.max(1, Math.floor(configured))`：
 * 1. 它把 `0` **静默抬成 1** —— 子 Agent 会跑一步就收尾，现象像「任务太小 / 模型没干活」，
 *    而真实原因是入参非法（模型在 `subagent({ maxSteps })` 里填了 `0`，而 `0 ?? x` 不会跳过 `0`）。
 * 2. 它对 `NaN` 返回 `NaN` ⇒ `step >= NaN` 恒为 `false` ⇒ **步数上限被静默取消**，
 *    循环只能靠模型自觉或 doom-loop 守卫停下（最危险的一种：看起来像"跑得很久"，
 *    实际是"没有上限了"）。
 */
export function normalizeMaxSteps(value: number | undefined | null): number | undefined {
  if (value === undefined || value === null || typeof value !== 'number') return undefined
  if (value === -1 || value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(value) || value < 1) return undefined
  return Math.floor(value)
}

/**
 * doom-loop 拦截阈值：同一工具 + 完全相同的入参连续出现的次数。
 * 对齐 opencode `processor.ts` 的 `DOOM_LOOP_THRESHOLD = 3`。
 */
export const DOOM_LOOP_THRESHOLD = 3

// ===== 重复侦察结果复用（§8.2）=====

/** 可"重复结果截写"的只读工具白名单（纯只读、无副作用才允许） */
export const REPEAT_READONLY_TOOLS: ReadonlySet<string> = new Set(['read_file', 'list_dir', 'grep_file', 'glob'])
/** 结果至少多少字符才算"大"（小于它直接拼最新，不值得省） */
export const REPEAT_RESULT_MIN_CHARS = 2000
/** TTL：时间窗口（ms）与轮次窗口（步数），双窗口 OR */
export const REPEAT_TTL_MS = 60_000
export const REPEAT_TTL_ROUNDS = 10

/** 稳定序列化（对象键排序），保证同参必得同串 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const rec = v as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`
}

/** sha256 截断（16 hex 字符，防碰撞足够） */
export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/**
 * 提取工具结果的"可比较载荷"（用于 §8.2 的重复判定）：
 * string 直接用；对象取 `content` 字段（read_file 的输出结构）；其余 JSON 序列化。
 * 载荷既决定"多大才算大"，也是 hash 的对象。
 */
export function resultPayload(r: unknown): string {
  if (typeof r === 'string') return r
  if (r !== null && typeof r === 'object') {
    const c = (r as Record<string, unknown>).content
    if (typeof c === 'string') return c
    try {
      return JSON.stringify(r)
    } catch {
      return ''
    }
  }
  return String(r)
}

/** 步数到顶时追加的最后一条 user 消息（对齐 opencode `MAX_STEPS_PROMPT`） */
const MAX_STEPS_WRAP_UP =
  '[系统] 本次执行已达到最大步数上限。请立即停止调用工具，基于已经获得的信息给出最终答复；' +
  '若任务尚未完成，请说明已完成的部分与剩余待办。'

/**
 * 用量折叠检查点：记录「已折叠到哪条 assistant 消息」+ 跨消息的折叠状态。
 *
 * 为什么必须存：引擎每步折叠一次，重开会话（或同一会话被再次 prompt）时若从零再折一遍
 * 就会**重复计数** —— 这正是 TUI 时代那条「空累积器覆盖已持久化历史 ⇒ 重连后用量清零」
 * 的反面。存消息 id 而不是计数，是因为 `/compact`、`deleteMessage` 会改写消息列表：
 * 一旦 id 对不上就退化为全量重建（见 `HarnessImpl.accumulateUsage`）—— 宁可重算，不能算错。
 */
const USAGE_FOLD_KEY = 'usageFold'

/** 用量折叠检查点的持久化形态 */
interface UsageFoldCheckpoint {
  /** 已折叠的最后一条 assistant 消息 id */
  upToMessageId: string
  /**
   * 跨消息折叠状态。必须与累积器一起存：`pending`（待归并的 LLM 用量）如果丢了，
   * 下一个工具的 token 归并就会落到错误的步上，两个口径立刻分叉。
   */
  state: UsageFoldState
}

/**
 * 判断签名序列尾部是否已构成 doom-loop（末尾 threshold 个完全相同）。
 *
 * 纯函数、只看最近 threshold 个 —— 早于窗口的重复不算（避免把"开了三个文件再回头重开第一个"
 * 这种正常行为误判成死循环）。
 */
export function isDoomLoop(sigs: readonly string[], threshold = DOOM_LOOP_THRESHOLD): boolean {
  if (threshold <= 0 || sigs.length < threshold) return false
  const tail = sigs[sigs.length - 1]
  for (let i = sigs.length - threshold; i < sigs.length; i++) {
    if (sigs[i] !== tail) return false
  }
  return true
}

/**
 * 续轮判据：**本步有工具调用** 且 finish 不表示异常终止。
 *
 * 不要写成「finish === 'tool_calls' 才续轮」—— Gemini 在返回 `functionCall` 时
 * `finishReason` 仍是 `STOP`（`provider-gemini/src/index.test.ts` 已断言固定），
 * 那种写法会让它在该续轮时直接退出，退化成单轮。
 *
 * 反过来，`length` / `content_filter` / `error` 表示本步是**被截断/拦截**的异常结束，
 * 即便消息里残留 toolCalls 也不该续 —— 回喂一个残缺的调用链没有意义。
 *
 * finish 缺失（Provider 未提供）时不阻断续轮：宁可多跑一步，也不能丢掉工具结果。
 */
function shouldContinueStep(o: StepOutcome): boolean {
  if (o.toolCallCount === 0) return false
  if (o.finish === 'length' || o.finish === 'content_filter' || o.finish === 'error') return false
  return true
}

export class AgentRuntimeImpl implements AgentRuntime {
  private readonly agents = new Map<string, AgentDefinition>()
  private readonly defaultAgentId: string
  /** 惰性创建的快照服务实例 */
  private snapshotSvc: SnapshotService | undefined
  /** 每 session 最近一次快照（用于计算本轮变更文件列表） */
  private readonly lastSnapshots = new Map<string, SnapshotID>()
  /**
   * 每 session 最近一次的系统区（前缀）段级快照 —— 用于跨 turn 归因"谁把前缀改了"。
   *
   * 为什么不复用 `lastSnapshots`：那是文件快照 ID，语义不同；这里的键是**段指纹**。
   * 只存内存（进程内存续即可）：跨重启后首轮无基线 ⇒ 不报变化，不会误报。
   */
  private readonly sysSnapshots = new Map<string, SystemSnapshot>()
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
      /**
       * token 折算口径（引擎侧唯一取值点；由 HarnessImpl 从 options.tokenCalibration 解析后注入）。
       * 用于把「整包请求」的本地估算与 provider 上报用量放在同一把尺子上比对。
       */
      readonly countTokens: (text: string) => number
      /** 可选：快照服务工厂（注入后自动 capture 挂载 meta.snapshot） */
      readonly snapshot?: () => SnapshotService
      /** 可选：宿主 logger（用于"已忽略"类告警 —— 可观测性增强不得静默失效） */
      readonly logger?: import('@harness/plugin').PluginContext['log']
    }
  ) {
    this.defaultAgentId = defaultAgentId
  }

  /**
   * §8.2 重复侦察结果缓存：键 = `sessionId\u0000toolId\u0000stable(parsedInput)`。
   * 值 = { hash, round, ts }。只在工具**真实执行后**更新（hash 是执行得来的判定依据）。
   * 会话级内存态：重开进程即失效（可接受 —— 跨进程复用需要持久化+过期策略，另行立项）。
   */
  private readonly toolResultCache = new Map<string, { hash: string; round: number; ts: number }>()

  /**
   * 大结果重复截写：只读工具白名单 + TTL 窗口内同工具同参 hash 一致 ⇒ 返回提示文本
   * （新消息不重放全文，**历史一字不动**，见 docs/usage-accounting-and-prompt-cache-plan.md §8.2）。
   * 未命中 / 不满足条件 ⇒ 更新缓存并返回 null（照常写全文）。
   */
  private maybeTruncateRepeatResult(
    sessionId: string,
    round: number,
    toolId: string,
    input: unknown,
    result: unknown,
  ): unknown | null {
    if (!REPEAT_READONLY_TOOLS.has(toolId)) return null
    const payload = resultPayload(result)
    if (payload.length < REPEAT_RESULT_MIN_CHARS) return null
    const key = `${sessionId}\u0000${toolId}\u0000${stableStringify(input)}`
    const hash = shortHash(payload)
    const prev = this.toolResultCache.get(key)
    const now = Date.now()
    const fresh = prev !== undefined && (now - prev.ts <= REPEAT_TTL_MS || round - prev.round <= REPEAT_TTL_ROUNDS)
    if (fresh && prev.hash === hash) {
      const hint = `[结果与第 ${prev.round} 轮一致（缓存，TTL 内有效，全文见该轮）]`
      // string → 整体替换；对象含 content（read_file 输出）→ 只替换 content，保留 path/行数等小字段
      if (typeof result === 'string') return hint
      if (result !== null && typeof result === 'object' && 'content' in (result as object)) {
        return { ...(result as Record<string, unknown>), content: hint }
      }
      return hint
    }
    this.toolResultCache.set(key, { hash, round, ts: now })
    return null
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

  /**
   * 记录本轮系统区快照并归因相对上一轮的变化；有变化时告警并返回报告。
   *
   * 系统区位于请求位置 0，任何一个字符变化都会让其后的**整个历史**按全价重算
   * （代价量化见 acp-context 的 MANUAL_INJECT_MARGIN 注释：越阈值时翻转一次
   * ≈ 95K token-equiv）。所以"system 变了"是高代价事件，必须能点名到段。
   *
   * 开销：每 query 一次段遍历（段数十来条），无 IO。首轮只建立基线、不报（否则每次
   * 新会话都会误报一次"前缀变化"）。
   */
  private noteSystemStability(
    sessionId: string,
    sysParts: string[],
  ): SystemStabilityReport | undefined {
    const curr = systemSnapshotOf(sysParts, Date.now())
    const prev = this.sysSnapshots.get(sessionId)
    this.sysSnapshots.set(sessionId, curr)
    if (!prev) return undefined
    const report = buildSystemStabilityReport(prev, curr)
    if (!report) return undefined
    try {
      this.deps.logger?.warn?.(
        `system 区（前缀）本轮变化 ${report.details.length} 处 —— 自动前缀缓存将整段重算：` +
          report.details.join('；'),
        { sessionId },
      )
    } catch {
      // 告警失败不影响主流程
    }
    return report
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

  /**
   * 非流式执行：复用 `queryStream` 的完整循环，只取最后一步的 assistant 消息。
   *
   * 此处原有一份与 `_prepareQuery` 平行的逻辑副本（各自维护 system prompt、工具池、
   * hooks、消息组装），与流式链路重复且极易分叉。改为复用后，循环语义（步数上限、
   * doom-loop、续轮判据）对两条链路天然一致 —— 这也正是 subagent / swarm 需要的。
   */
  async query(input: AgentQueryInput): Promise<Message> {
    let last: Message | undefined
    // preferComplete：非流式入口不该被迫走流式解析（它只要最终消息），
    // 也让只实现 complete 的端点/测试替身继续可用。
    for await (const ev of this.queryStream({ ...input, preferComplete: true })) {
      if (ev.type === 'done' && ev.message) last = ev.message
    }
    if (!last) throw new Error('query() 未产生 assistant 消息（Provider 未返回任何内容）')
    return last
  }
  /**
   * 一次查询内**只做一次**的准备：Agent 解析、工具池组装、权限规则、待处理通知与
   * 用户消息注入、system prompt 片段、provider/model 解析。
   *
   * 与 `_buildStepMessages` 的分界依据是「是否随轮次变化」：
   * 工具池 / 权限规则 / system prompt / model 解析在同一次查询内不变；
   * 而消息历史（含 ACP 折叠后的块）每轮都不同，必须每轮重建 —— 分错会丢 hook
   * 或重复执行（详见 docs/agentic-loop-plan.md 的 P1）。
   */
  private async _prepareQueryOnce(input: AgentQueryInput): Promise<PreparedQuery> {
    const { sessionId, message } = input
    const agentId = input.agentId ?? this.defaultAgentId
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent "${agentId}" not registered`)

    const pool = new DefaultToolPool(this.deps.toolRegistry)
    await this.deps.triggerPlugin('core.tool.pool.assemble', { agentId } as ToolPoolAssembleInput, pool)
    const allowedTools = filterMcpTools(
      this.deps.toolRegistry.filterByWhitelist(agent.tools),
      agent.mcpServers,
      agent.excludeMcpServers,
    )

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

    // —— system prompt 片段（一次查询内不变）——
    const sysParts: string[] = agent.promptFragments ? [...agent.promptFragments] : []
    if (agent.systemPrompt) { sysParts.length = 0; sysParts.push(agent.systemPrompt) }
    await this.appendCompactionMemory(sessionId, sysParts)
    // agentMode 一并交给插件：主会话记忆不应注入子 Agent（隔离语义），而插件此前拿不到 mode
    const promptIn: PromptInput = {
      agentId,
      sessionId,
      ...(agent.mode ? { agentMode: agent.mode } : {}),
    }
    // 技能 paths 条件触发用：从本轮用户输入提取疑似文件路径（仅命中者经动态通道注入尾部）
    const involvedPaths = extractFilePaths(message)
    if (involvedPaths.length > 0) promptIn.involvedPaths = involvedPaths
    await this.deps.triggerPlugin('core.prompt.system.transform', promptIn, sysParts)

    // 尾部动态上下文：给"内容会变"的注入一条不拖垮前缀缓存的通道。
    //
    // 为什么不把它们也扔进 sysParts：前缀缓存按最长公共 token 前缀命中，system 位于位置 0，
    // 它一变其后**整段历史**都要按全价重算；而同样的文本放在请求末尾，翻转代价 ≈ 0。
    // 判断标准：**这段文本会不会在会话中途变？会就走这里。**
    const dynParts: string[] = []
    await this.deps.triggerPlugin('core.prompt.dynamic.transform', promptIn, dynParts)

    // 系统区（前缀）跨 turn 归因：变化时点名到段（告警 + 交给插件写遥测）
    const systemStability = this.noteSystemStability(sessionId, sysParts)

    // input.model 优先级高于 agent.model（SubagentTool 派出子 Agent 时可覆盖模型）
    const providerId = input.model?.providerId ?? agent.model?.providerId ?? 'default'
    const modelId = input.model?.modelId ?? agent.model?.modelId
    // 基础参数一次算好（浅拷贝给每轮的 params）；`core.llm.params` hook 仍每轮跑 ——
    // 它的入参含本轮 messages，提前到一次阶段会让 hook 看到过期的历史。
    const paramsBase: LLMParams = {
      temperature: input.model?.temperature ?? agent.model?.temperature ?? 0.7,
      ...(agent.model?.options ?? {}),
    }

    return {
      agentId,
      sessionId,
      sysParts,
      dynParts,
      ...(systemStability ? { systemStability } : {}),
      allowedTools,
      providerId,
      modelId,
      paramsBase,
    }
  }

  /**
   * 每个 step 都重建的「消息 + 参数」。
   *
   * 必须每轮重做：上一轮的 assistant 消息与工具结果已写回会话，ACP 也可能刚折叠过
   * 消息（`setMessages` / `setBlocks`），因此会话内容与 `getView()` 的精简视图都会变。
   */
  private async _buildStepMessages(
    p: PreparedQuery,
  ): Promise<{ messages: Message[]; params: LLMParams; headers: Record<string, string> }> {
    const { sessionId } = p
    const sess = await this.deps.session.get(sessionId)
    if (!sess) throw new Error(`Session "${sessionId}" not found`)

    const messages: Message[] = []
    if (p.sysParts.length > 0) {
      messages.push({
        id: `sys_${Date.now()}`,
        role: 'system',
        parts: [{ type: 'text', text: p.sysParts.join('\n\n') }],
        createdAt: Date.now(),
      })
    }
    // 上下文压缩·阶段二（D1）：有压缩块时用「精简视图」组装请求历史
    // （摘要占位 + 近期消息），不再全量拼接原文；无块则零变化。
    const view = await this.deps.session.getView(sessionId)
    if (view.slimmed) {
      const summaryMsg = renderBlocksAsMessage(view.blocks)
      if (summaryMsg) messages.push(summaryMsg)
      messages.push(...view.messages)
    } else {
      messages.push(...sess.messages)
    }

    const llmIn: LLMInput = { providerId: p.providerId, modelId: p.modelId, messages }
    const params: LLMParams = { ...p.paramsBase }
    const headers: Record<string, string> = {}
    await this.deps.triggerPlugin('core.llm.params', llmIn, params)
    await this.deps.triggerPlugin('core.llm.headers', llmIn, headers)

    // 每轮进入模型前：交给上下文压缩插件裁剪/改写 messages（原地生效），并回写精简后的会话
    const preModelBlocks: NonNullable<import('@harness/plugin').SessionPreModelInput['blocksPatch']> = []
    await this.deps.triggerPlugin(
      'core.session.preModel',
      {
        sessionId,
        agentId: p.agentId,
        providerId: p.providerId,
        modelId: p.modelId,
        save: async (msgs) => {
          await this.deps.session.setMessages(sessionId, msgs as Message[])
        },
        meta: {
          read: async () => (await this.deps.session.get(sessionId))?.meta,
          patch: async (patch) => this.deps.session.updateMeta(sessionId, patch),
        },
        blocksPatch: preModelBlocks,
        // 前缀区段级归因：让压缩插件（ACP）能把 "system-changed" 细化到"第 N 段变了"。
        // 只在实际变化时有值 —— 消费方不必自己维护上一轮快照。
        ...(p.systemStability ? { systemStability: p.systemStability } : {}),
      },
      messages,
    )
    // 统一块模型：把插件（ACP）每轮内部折叠的 source:'acp' 块合并进 session.blocks（按 id 去重覆盖）
    if (preModelBlocks.length > 0) this.deps.session.setBlocks(sessionId, preModelBlocks)

    // ---- 尾部动态上下文：拼在请求**最末尾** ----
    //
    // 两个位置约束都不是风格问题：
    // ① **必须在 `core.session.preModel` 之后** —— 那是压缩插件的折叠/回写点。放它之前会被
    //    折叠流程看见，有被写进持久层的风险；而这段内容每轮重算，落库就是脏数据。放这里
    //    即"发送时拼接"，天然不落库（`messages` 是每步新建的数组，返回后只用于本次请求）。
    // ② **必须用 `user` role** —— provider-anthropic 的 `extractSystemPrompt` 与
    //    provider-gemini 的 `extractSystem` 会把**任意位置**的 system 消息上提进顶层
    //    `system` / `systemInstruction`（原位置直接跳过）。用 system 角色放尾部等于把它送回
    //    前缀，收益归零。只有 OpenAI 保持原序，不能指望它。
    //
    // 为什么值得单开一条通道：同一份文本换个位置，代价差几个数量级 —— 放前缀是"整段历史
    // 重算"，放尾部是"只有这一小段不命中"。
    if (p.dynParts.length > 0) {
      messages.push({
        id: `dyn_${Date.now()}`,
        role: 'user',
        parts: [{ type: 'text', text: renderDynamicBlock(p.dynParts) }],
        createdAt: Date.now(),
      })
    }

    return { messages, params, headers }
  }

  async *queryStream(input: AgentQueryInput): AsyncGenerator<AgentStreamEvent, void, unknown> {
    const prepared = await this._prepareQueryOnce(input)
    const { sessionId } = prepared

    // 步数上限优先级：input.maxSteps > AgentDefinition.maxSteps > DEFAULT_MAX_STEPS。
    // 非法取值**不静默钳制**：`normalizeMaxSteps` 把 `0`/`NaN`/`<-1` 判为「未指定」并回落下一层，
    // 同时告警 —— 否则「0 被抬成 1」会让子 Agent 跑一步就收尾，现象与真实原因完全对不上；
    // 而 NaN 会让 `step >= NaN` 恒假，等于把上限静默取消。
    const agentDef = this.agents.get(prepared.agentId)
    const fromInput = normalizeMaxSteps(input.maxSteps)
    const fromAgent = normalizeMaxSteps(agentDef?.maxSteps)
    if (input.maxSteps != null && fromInput === undefined) {
      this.deps.logger?.warn?.(
        `[maxSteps] 入参 maxSteps=${JSON.stringify(input.maxSteps)} 无效（应为 -1 = 不限，或 >= 1 的整数），`
        + `已忽略并回落下一优先级（agent="${prepared.agentId}"）。`,
      )
    }
    if (agentDef?.maxSteps != null && fromAgent === undefined) {
      this.deps.logger?.warn?.(
        `[maxSteps] Agent "${prepared.agentId}" 定义的 maxSteps=${JSON.stringify(agentDef.maxSteps)} 无效`
        + '（应为 -1 = 不限，或 >= 1 的整数），已忽略并回落引擎默认值。',
      )
    }
    const maxSteps = fromInput ?? fromAgent ?? DEFAULT_MAX_STEPS

    let step = 0
    let wrapUpInjected = false
    const signal = input.signal
    // 最近若干次工具调用签名（跨步累积，供 doom-loop 检测）。保持 threshold-1 个即可：
    // 本步自己的签名会在 _runOneStep 内顺序追加，足够凑出连续 threshold 个。
    let recentSigs: string[] = []
    // 各步的聚合签名（同样只留 threshold-1 个）：供「整步重复」检测 —— 每步多个调用时，
    // 单看调用签名的判据恒不命中（见 StepOutcome.stepSig 的说明），必须按步再判一次。
    let stepSigs: string[] = []
    // 末步结果：turn_end 的插件广播要用（finish 在循环外本来拿不到）
    let lastOutcome: StepOutcome | undefined

    try {
      while (true) {
        // 中断只在**步边界**生效：当前步已在 _runOneStep 内做工具级中断检查。
        // 这样不会把一步切成两半，已产生的 assistant 消息与工具结果都保持完整。
        if (signal?.aborted) break

        step++
        const outcome = yield* this._runOneStep(
          prepared,
          step,
          recentSigs,
          signal,
          !!input.preferComplete,
          stepSigs,
        )
        lastOutcome = outcome
        if (outcome.toolSigs.length > 0) {
          recentSigs = [...recentSigs, ...outcome.toolSigs].slice(-(DOOM_LOOP_THRESHOLD - 1))
          stepSigs = [...stepSigs, outcome.stepSig].slice(-(DOOM_LOOP_THRESHOLD - 1))
        }

        // doom-loop 被拒 / 被中断 ⇒ 立刻收手，不再续轮
        if (outcome.doomLoopTripped || outcome.aborted) break
        if (!shouldContinueStep(outcome)) break

        if (step >= maxSteps) {
          // 到顶但模型仍想继续：给一次收尾机会（追加提示再跑一步），而非硬截断。
          // 例外：maxSteps=1 是「显式单轮」语义（子 Agent 只要一次工具结果、旧调用方要单轮行为），
          // 此时不追加收尾步 —— 否则「1 步」会变成 2 次模型调用。
          if (wrapUpInjected || maxSteps <= 1) break
          wrapUpInjected = true
          await this.deps.session.addMessage(sessionId, {
            id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            role: 'user',
            parts: [{ type: 'text', text: MAX_STEPS_WRAP_UP }],
            createdAt: Date.now(),
          })
        }
      }
    } finally {
      // 整轮结束标记。`done` 每个 step 都会发（A 方案），上层无法据此判断"全部跑完"——
      // 而 TUI 的 busy 状态、REPL 的收尾都需要这个信息，因此显式收一条终态事件。
      //
      // 放在 finally 而非循环之后：中间任一步抛错（网络断连、preModel 插件异常、addMessage 失败…）
      // 时也要送达，否则以 turn_end 收状态的消费者（TUI 的 busy、swarm tick）会永久卡在"运行中"。
      // 异常本身不再被吞：finally 执行完仍会继续向上传播。
      //
      // 顺带**广播整轮结束**给插件：走 `core.agent.turn.end`（引擎层事实），不走 `cli.agent.stream`
      // —— 后者是 UI 消费层（CLI 的 REPL/TUI/run）的"现在在干什么"状态流，引擎不该往里塞事件，
      // 否则同一个 hook 名由两层分别触发，消费方无法分辨来源。
      //
      // 为什么必须由 core 发：原先只有 CLI 侧广播终态，于是「以库内嵌 / ACP 宿主自己消费事件流」
      // 时插件永远收不到整轮结束，靠它驱动的逻辑（如记忆的攒批放行）会静默失效。
      //
      // 触发范围包含子 Agent 的轮（引擎不做"哪一轮算用户的轮"这种消费侧判断）——
      // 要不要筛由消费方按 mode / sessionId 决定。
      const def = this.agents.get(prepared.agentId)
      void this.deps
        .triggerPlugin('core.agent.turn.end', {
          agentId: prepared.agentId,
          ...(def?.name ? { agentName: def.name } : {}),
          ...(def?.mode ? { mode: def.mode } : {}),
          sessionId,
          step,
          ...(lastOutcome?.finish ? { finish: lastOutcome.finish } : {}),
          ...(signal?.aborted ? { aborted: true } : {}),
        })
        .catch(() => undefined)
      yield { type: 'turn_end', ...(signal?.aborted ? { aborted: true } : {}) }
    }
  }

  /**
   * 执行一个 step：重建消息 → capture 快照 → 调模型（流式或 complete fallback）→
   * 执行工具 → 写回 assistant 消息 → 发 done 事件。返回续轮判定所需的信息。
   *
   * 用 async generator 而非普通函数，是为了让流式增量照常 `yield` 给上层；
   * 终值（StepOutcome）通过 `yield*` 的返回值传出，避免再引一条回调通道。
   */
  private async *_runOneStep(
    prepared: PreparedQuery,
    step: number,
    priorSigs: readonly string[] = [],
    signal?: AbortSignal,
    preferComplete = false,
    priorStepSigs: readonly string[] = [],
  ): AsyncGenerator<AgentStreamEvent, StepOutcome, unknown> {
    const { agentId, sessionId, allowedTools, providerId, modelId } = prepared
    const provider = this.deps.chatProvider(providerId)

    // 每轮重建：会话已被上一轮写回（assistant + 工具结果），ACP 也可能刚折叠过消息
    const { messages: finalMessages, params, headers } = await this._buildStepMessages(prepared)

    // 本轮开始时自动 capture 快照（挂到 assistant 消息 meta.snapshot）
    const snap = await this.captureForMessage(sessionId)

    // 收集流式结果
    let textBuf = ''
    let reasoningBuf = ''
    const toolCalls: Array<{ toolUseId: string; toolId: string; inputParts: string[] }> = []
    let model: string | undefined
    let tokenUsage: TokenUsage | undefined
    let raw: unknown
    // 本轮结束原因（Provider 未提供时为 undefined —— 调用方须回退到「是否有工具调用」判断）
    let finish: ChatFinishReason | undefined
    let finishRaw: string | undefined
    /** 本步是否被外部中断（模型请求被 abort 或工具执行前发现已中断） */
    let aborted = false

    if (provider.stream && !preferComplete) {
      // 流式路径
      const gen = provider.stream({
        providerId: providerId,
        modelId: modelId,
        messages: finalMessages,
        params,
        headers,
        sessionId,
        agentId,
        // 本 agent 实际可用的工具：provider 据此生成 tools 载荷。
        // 不传的话 provider 只能拿全局注册表 —— 模型会看到它无权执行的工具（提示词/执行两侧不一致）。
        tools: allowedTools,
        ...(signal ? { signal } : {}),
      })
      // 中断时 Provider 会抛 AbortError：这里吞掉并保留**已收到的部分**（partial assistant），
      // 而不是让异常穿透 —— 否则上层只会看到一句"发送失败"，已渲染的内容与已执行的工具全丢。
      try {
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
              finish = chunk.finish
              finishRaw = chunk.finishRaw
              break
          }
        }
      } catch (e) {
        // 只吞中断类异常；其它错误照旧向上抛（不能把真实故障伪装成"用户取消"）
        if (isAbortError(e) || signal?.aborted) aborted = true
        else throw e
      }
    } else {
      // Fallback：非流式 complete()，模拟单次 yield
      let completion
      try {
      completion = await provider.complete({
        providerId: providerId,
        modelId: modelId,
        messages: finalMessages,
        params,
        headers,
        sessionId,
        agentId,
        tools: allowedTools,
        ...(signal ? { signal } : {}),
      })
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) {
          completion = undefined
          aborted = true
        } else throw e
      }
      if (completion) {
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
        finish = completion.finish
        finishRaw = completion.finishRaw
        // 一次性 yield 文本
        if (textBuf) yield { type: 'text_delta', text: textBuf }
        if (reasoningBuf) yield { type: 'reasoning_delta', text: reasoningBuf }
      }
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
    const toolSigs: string[] = []
    let doomLoopTripped = false
    // 跨步累积（priorSigs）+ 本步顺序追加 ⇒ 尾部连续 threshold 个相同即判定死循环
    const sigs = [...priorSigs]

    // 预解析本步全部调用：既要算「整步聚合签名」做重复检测，也在执行时复用，
    // 避免两次解析产生不一致。
    const planned = toolCalls.map((tc) => {
      const inputJson = tc.inputParts.join('')
      let parsedInput: unknown
      try { parsedInput = inputJson ? JSON.parse(inputJson) : {} }
      catch { parsedInput = inputJson }
      return { parsedInput, sig: `${tc.toolId}|${JSON.stringify(parsedInput)}` }
    })
    // 排序后拼接：模型返回的调用顺序不稳定时也能识别出「同一组动作」
    const stepSig = planned.map((p) => p.sig).sort().join('\u0001')

    // 整步重复检测 —— 补「每步多个调用」的漏检：
    // 每步 2 个调用时全局序列是 A,B,A,B,A,B…，尾部连续 3 个永不相同，
    // 单看「同一调用连续 N 次」恒不命中。按步聚合后 A|B 连续 3 步相同即可拦下。
    //
    // ⚠️ 判据命中即**硬中断**，不征求权限（见下方两处 DOOM_LOOP）：这不是「能不能执行」的权限问题，
    // 而是「已经在空转」的资源保护。交给权限引擎裁决会被 `--permission allow-all`（或已记住的
    // allow 规则）架空 —— 实测会话 s_1789862291973_b0c2s：判据命中 5 步，allow-all 下全部放行，
    // 25 步空转 21 秒无任何拦截，最后靠模型自己吐了个空步才收尾。
    const stepRepeat = planned.length > 0 && isDoomLoop([...priorStepSigs, stepSig])

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const { parsedInput, sig } = planned[i]

      const tool = allowedTools.find((t) => t.id === tc.toolId) ?? this.deps.toolRegistry.get(tc.toolId)
      const resultPart: any = {
        type: 'tool',
        toolUseId: tc.toolUseId,
        toolId: tc.toolId,
        input: parsedInput,
      }

      // 中断检查：已 abort ⇒ 不再执行剩余工具（含当前这个），逐个标记为 ABORTED。
      // **不丢已完成的部分**：本步此前已 push 的工具结果与已收到的 assistant 文本照常写回会话
      // （对齐 opencode cleanup 的收尾语义）。放在 tool_call_start 之前 —— 没执行就不该报"开始"。
      // 位置在重复检测之前：中断优先于重复处理（已中断就按 ABORTED 记账，不再询问）。
      if (signal?.aborted) {
        aborted = true
        resultPart.result = { message: '执行已中断，该工具未运行。', code: 'ABORTED' }
        resultPart.isError = true
        assistant.parts.push(resultPart)
        yield {
          type: 'tool_call_result',
          toolUseId: tc.toolUseId,
          toolId: tc.toolId,
          result: resultPart.result,
          isError: true,
        }
        continue
      }

      // 整步重复 ⇒ 本步所有调用都不执行（同样挡在执行之前）
      if (stepRepeat) {
        doomLoopTripped = true
        resultPart.result = {
          message:
            `检测到重复调用：连续 ${DOOM_LOOP_THRESHOLD} 步都在发起完全相同的一组工具调用，` +
            '已自动中断本轮以避免死循环。若确有需要，请换一种入参或策略后重试。',
          code: 'DOOM_LOOP',
        }
        resultPart.isError = true
        assistant.parts.push(resultPart)
        yield {
          type: 'tool_call_result',
          toolUseId: tc.toolUseId,
          toolId: tc.toolId,
          result: resultPart.result,
          isError: true,
        }
        continue
      }

      // doom-loop 检测挡在**执行之前**：第 threshold 次不再真的跑一遍，直接中断（硬保护，
      // 不问权限 —— 见 stepRepeat 处的说明）。命中后由循环终止，不再续轮。
      sigs.push(sig)
      toolSigs.push(sig)

      yield { type: 'tool_call_start', toolUseId: tc.toolUseId, toolId: tc.toolId, input: parsedInput }

      if (isDoomLoop(sigs)) {
        doomLoopTripped = true
        resultPart.result = {
          message:
            `检测到重复调用：同一工具（${tc.toolId}）与完全相同的入参已连续 ${DOOM_LOOP_THRESHOLD} 次，` +
            '已自动中断本轮以避免死循环。若确有需要，请换一种入参或策略后重试。',
          code: 'DOOM_LOOP',
        }
        resultPart.isError = true
        assistant.parts.push(resultPart)
        yield {
          type: 'tool_call_result',
          toolUseId: tc.toolUseId,
          toolId: tc.toolId,
          result: resultPart.result,
          isError: true,
        }
        break
      }

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
        // 接上真正会 abort 的信号：bash 据此 kill 子进程、web 工具据此中止 fetch。
        // 未传 signal 时才退回新建（保持向后兼容 —— 旧调用方行为不变）。
        signal: signal ?? new AbortController().signal,
        // callerToolIds：本轮该 Agent **实际可用**的工具 id 列表。
        // 消费方是 subagent 插件 —— 它据此判断"回给父 Agent 的完整输出用 read_file 读不读得到"。
        // 此前这个字段只有读取方没有写入方（声明了却没人填），提示语因此永远走错分支。
        variables: { callerToolIds: allowedTools.map((t) => t.id) },
        cwd: tctxCwd,
        requestPermission: (r) => resolvePermission(this.deps.permission, r as ToolPermissionRequest, this.deps.triggerPlugin) as Promise<ToolPermissionDecision>,
      }
      const res: ToolResult = await safeExecuteTool(this.deps.toolPipeline, tool, parsedInput, tctx)
      resultPart.result = res.ok ? res.output : { message: res.error?.message, code: res.error?.code }
      resultPart.isError = !res.ok
      // §8.2 重复侦察结果截写：只读工具 + 大结果 + TTL 内同工具同参 hash 一致 ⇒ 新消息只写提示、
      // 不重放全文。工具已**真实执行**（hash 是执行得来的真凭实据），历史一字不动 ⇒ 前缀缓存不打断。
      if (res.ok && resultPart.result !== undefined && resultPart.result !== null) {
        const truncated = this.maybeTruncateRepeatResult(sessionId, step, tc.toolId, parsedInput, resultPart.result)
        if (truncated !== null) resultPart.result = truncated
      }
      // 入参自愈：模型偶发发出**零参数**工具调用（`input: {}`），工具入口按 Fail-Closed 拒绝。
      // 原样回传错误消息时模型只能盲猜重试（真机实测：37% 的调用如此，长上下文下失败率升到 50%）。
      // 这里把"这个工具到底要什么参数"直接摆到错误消息里，让它在**同一次**重试里就能补齐。
      if (!res.ok) {
        const heal = describeMissingRequiredParams(tool, parsedInput)
        if (heal && resultPart.result && typeof resultPart.result === 'object') {
          (resultPart.result as { message?: string }).message =
            `${(resultPart.result as { message?: string }).message ?? '入参不合法'}\n\n${heal}`
        }
      }
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
    // 引擎事实广播：provider 返回的用量（含缓存命中/写入）。消费方是各家的可观测性
    // （ACP 遥测的 providerCache 行即靠它 —— 此前那个 builder 只有定义没有调用方）。
    if (tokenUsage) {
      // 本地"整包请求"估算（含 system + 工具载荷）——与 provider 上报的 input 是**同类**口径。
      // 只报历史消息的估算会让「本地 vs provider」看起来像 tokenizer 差几倍，实为漏算固定开销。
      const localInputEstimate =
        estimateMessagesTokens(finalMessages, this.deps.countTokens) +
        estimateToolPayloadTokens(allowedTools, this.deps.countTokens)
      await this.deps.triggerPlugin('core.llm.usage', {
        sessionId,
        ...(agentId ? { agentId } : {}),
        ...(model ? { model } : {}),
        step,
        input: tokenUsage.input,
        output: tokenUsage.output,
        ...(tokenUsage.cacheRead !== undefined ? { cacheRead: tokenUsage.cacheRead } : {}),
        ...(tokenUsage.cacheWrite !== undefined ? { cacheWrite: tokenUsage.cacheWrite } : {}),
        localInputEstimate,
      })
    }
    // 引擎层唯一累加：把本步折叠进会话用量（幂等，见 accumulateUsage）。
    // 必须在 addMessage 之后：此刻 assistant.parts 已含本步 tool 结果，
    // 而"LLM 用量归并到紧随的首个工具"这条规则依赖 tool part 已就位。
    await this.accumulateUsage(sessionId, assistant)
    // A 方案：每步都发 done（语义 =「这一步结束」），step 让上层能区分中间步与最终步。
    yield {
      type: 'done',
      message: assistant,
      step,
      ...(finish ? { finish } : {}),
      ...(finishRaw ? { finishRaw } : {}),
      // 本次查询是否已被中断：上层据此区分「模型正常收尾」与「用户按了 Ctrl-C」——
      // 否则两者的事件序列完全一样（都是 done + finish），UI 只能猜。
      //
      // 判据取 `aborted || signal.aborted` 两者之一，缺一不可：
      // - `aborted`：中断检查命中、剩余工具被跳过；
      // - `signal.aborted`：中断发生在**最后一个工具执行期间** —— 此时没有后续迭代，
      //   `aborted` 永远不会置位，只看它会把这次中断漏报成正常收尾（有测试固定）。
      ...(aborted || signal?.aborted ? { aborted: true } : {}),
    }
    return {
      assistant,
      finish,
      toolCallCount: toolCalls.length,
      toolSigs,
      stepSig,
      ...(doomLoopTripped ? { doomLoopTripped } : {}),
      ...(aborted ? { aborted } : {}),
    }
  }

  /**
   * 把一条 assistant 消息折叠进会话用量 —— **引擎层唯一累加点**。
   *
   * 三条设计约束（每条都对应一个踩过的坑）：
   *
   * 1. **幂等靠检查点**：`meta[USAGE_FOLD_KEY]` 记「已折叠到哪条消息」。重开会话 / 再次 prompt
   *    时只折新增部分；若从零再折一遍就是**重复计数**（历史上 TUI 那条"空累积器覆盖已持久化
   *    历史 ⇒ 重连后用量清零"是同一枚硬币的另一面）。
   * 2. **自愈靠重建**：检查点指向的消息不在了（`/compact`、`deleteMessage`、手工改过）就用
   *    `rebuildUsage(messages)` 全量重算 —— 复用与增量**完全相同**的 `foldMessage` 规则，
   *    因此重建结果与"从未被破坏"时一致，不会让用户看到数字跳变。
   * 3. **只 updateMeta、不落盘**：写文件交给已有的脏会话刷盘（CLI 轮末 `flushDirtySessions`）。
   *    引擎直接 `sessionStore.save` 会和宿主写盘打架。
   *
   * 折叠状态（pending/attributed）与累积器一起持久化：只存累积器而丢掉状态，
   * 下一个工具的 token 归并就会落到错误的步上。
   */
  private async accumulateUsage(sessionId: string, message: Message): Promise<void> {
    // 可观测性增强 —— 任何异常都不得影响主流程，但也**不许静默**（本项目反复栽在静默失效上）
    try {
      const sess = await this.deps.session.get(sessionId)
      if (!sess) return
      const meta = (sess.meta ?? {}) as Record<string, unknown>
      const ck = meta[USAGE_FOLD_KEY] as UsageFoldCheckpoint | undefined
      const ckValid = ck != null && sess.messages.some((m) => m.id === ck.upToMessageId)

      let usage: UsageStats
      let state: UsageFoldState
      if (ckValid) {
        // 增量：从已持久化的累积器继续折叠这一条。
        //
        // ⚠️ 这里**不能**用 hydrateUsage —— 它在 meta 累积器为空时会回退到「按消息重建」，
        // 而此刻 `message` 已经在 `sess.messages` 里，重建结果**已含它**，再 fold 一次就是双计。
        // 触发条件真实可达：某轮 assistant 既无 tokenUsage 也无工具（provider 未回报用量 /
        // 流式中断）⇒ 折叠后累积器恰好完全为空（llmCalls=0 / hourly=[] / tools=[]），
        // 但检查点有效 ⇒ 下一轮把当前消息折第二遍（实测：llmCalls 2 应为 1、input 300 应为 150）。
        // 所以必须区分「累积器存在但为空」（合法状态 → 直接增量）与「字段缺失」（→ 重建）。
        const fromMeta = usageFromMeta(meta)
        if (fromMeta) {
          usage = foldMessage(fromMeta, message, ck.state)
          state = ck.state
        } else {
          const rebuilt = rebuildUsage(sess.messages)
          usage = rebuilt.usage
          state = rebuilt.state
        }
      } else {
        // 自愈 / 首次：全量重建。此刻 message 已在 sess.messages 里，所以**不能**再 fold 一次
        // （那会重复计数）。meta 里若留有旧宿主（TUI 时代）写入的用量，会被消息重建值覆盖——
        // 两者同源，且重建值更完整（含 agent 维度归因与 tasksDone）。
        const rebuilt = rebuildUsage(sess.messages)
        usage = rebuilt.usage
        state = rebuilt.state
        // 极端退化：消息为空但 meta 已有用量（老会话只留了 meta）⇒ 保住 meta 的数字，别写小
        if (isBlankUsage(usage) && sess.messages.length === 0) usage = hydrateUsage({ meta })
      }

      await this.deps.session.updateMeta(sessionId, {
        [USAGE_STATS_KEY]: usage,
        [USAGE_FOLD_KEY]: { upToMessageId: message.id, state } satisfies UsageFoldCheckpoint,
      })
    } catch (err) {
      this.deps.logger?.warn?.(`[usage] 折叠会话用量失败（已忽略，不影响本轮）：${(err as Error)?.message ?? err}`)
    }
  }
}

// ========================================================================
// 7. Harness 接口 + 实现
// ========================================================================

/**
 * 用量审计访问器 —— **引擎是唯一累加者，宿主与插件只读**。
 *
 * 为什么放引擎层：累加口径必须唯一。在此之前的实现方只有 TUI（`tui.tsx` 模块 4），
 * 于是 headless / REPL 宿主与子 agent 会话完全没有 `meta.usageStats`
 * （真机：6 个子会话约 1.5M 输入 token 不入账，会话面板只看到总额的 42%）。
 * 现在引擎在**每步结束**折叠一条 assistant 消息，任何宿主都自动获得同一份数字。
 */
export interface UsageAccessor {
  /**
   * 取某会话的用量统计（读 `session.meta.usageStats`，meta 为空时按消息重建）。
   * 口径是**本会话**：子 agent 各自累积在自己的会话里，聚合看 `children()` + `sumUsage`。
   */
  get(sessionId: string): Promise<UsageStats>
  /** 直接子会话 id 列表（按 `Session.parentId` 反查；用于"含子 agent"的聚合展示） */
  children(sessionId: string): Promise<string[]>
}

/** 工作中的 Harness 接口（与模板文档略有差异，这里提供具体可用 API） */
export interface Harness {
  // === 生命周期 ===
  /** 启动（触发 core.harness.start hook + harness.started event） */
  start(): Promise<void>
  /** 停止（unload 所有插件 + bus publish） */
  stop(): Promise<void>
  /** 挂起（MVP：占位） */
  suspend(): Promise<void>
  /** 恢复（MVP：占位） */
  resume(): Promise<void>
  /**
   * 组装工具池：对每个已注册 Agent 触发 `core.tool.pool.assemble` Hook，把插件工具注册进全局
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
  /** Skill 管理器（加载/查询/禁用/重载技能；插件可在 core.harness.init 中通过此注册 plugin 来源技能） */
  readonly skillManager?: SkillManager
  /** 用量审计（引擎层唯一累加者；宿主只读，见 `UsageAccessor`） */
  readonly usage: UsageAccessor

  // === 工作目录 ===
  /** 全局工具工作目录（= options.cwd ?? process.cwd()；子 Agent 判断 git worktree 用） */
  readonly cwd: string
}

/**
 * 系统区（前缀区）的**段级**快照。
 *
 * system 区是多个插件往同一个数组 push 拼出来的，所以快照按"段"存三项：
 * 指纹（判等）、长度（说清变化量级）、首行预览（说清这是谁的那段）。
 */
export interface SystemSnapshot {
  digests: string[]
  lengths: number[]
  previews: string[]
  at: number
}

/** 单段文本的稳定指纹（djb2 + 长度；非加密，只用于判等） */
function segDigest(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}:${s.length}`
}

/** 段首行预览 —— 让归因结果能直接指认"这是哪个插件 push 的那段" */
function segPreview(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? ''
  const t = line.trim()
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}

export function systemSnapshotOf(parts: readonly string[], at: number): SystemSnapshot {
  return {
    digests: parts.map(segDigest),
    lengths: parts.map((s) => s.length),
    previews: parts.map(segPreview),
    at,
  }
}

/**
 * 比对两次系统区快照，产出**段级**归因；无变化返回 null。
 *
 * 为什么逐段比而不是整段比文本：整段比只能告诉你"system 变了"，逐段比能告诉你
 * "第 3 段由 1.2K 变成 2.4K 字符、首行是「项目长期记忆」" —— 直接指向插件。
 * 本项目的 system 区已知贡献者：agent promptFragments / systemPrompt、压缩记忆、
 * core.skill-injection、subagent roster、coordinator、mcp-client resources、memory。
 *
 * 同下标指纹不同 = 该段被就地改写；超出上轮长度的下标 = 新增；超出本轮长度的 = 移除。
 * 只判等、不猜语义：段内容的增删改都如实落在 details 里。
 */
export function buildSystemStabilityReport(
  prev: SystemSnapshot,
  curr: SystemSnapshot,
): SystemStabilityReport | null {
  const changedParts: number[] = []
  const addedParts: number[] = []
  const removedParts: number[] = []
  const details: string[] = []

  const common = Math.min(prev.digests.length, curr.digests.length)
  for (let i = 0; i < common; i++) {
    if (prev.digests[i] === curr.digests[i]) continue
    changedParts.push(i)
    // 首行预览给**新旧两份**：只有旧预览时，"变了"是知道了、但"变成了什么"还得自己去翻
    // （排障时最想确认的恰恰是"新增的这段是不是 memory / roster / MCP resources"）。
    // 两份首行相同（只改了段内后文）时只留一份，避免制造噪音。
    const samePreview = prev.previews[i] === curr.previews[i]
    details.push(
      `第 ${i + 1} 段变化：${prev.lengths[i]} → ${curr.lengths[i]} 字符（首行：「${prev.previews[i]}」` +
        (samePreview ? '' : ` → 「${curr.previews[i]}」`) +
        '）',
    )
  }
  for (let i = common; i < curr.digests.length; i++) {
    addedParts.push(i)
    details.push(`第 ${i + 1} 段新增：${curr.lengths[i]} 字符（首行：「${curr.previews[i]}」）`)
  }
  for (let i = common; i < prev.digests.length; i++) {
    removedParts.push(i)
    details.push(`第 ${i + 1} 段移除：原 ${prev.lengths[i]} 字符（原首行：「${prev.previews[i]}」）`)
  }

  if (details.length === 0) return null
  return {
    at: curr.at,
    prevAt: prev.at,
    parts: curr.digests.length,
    prevParts: prev.digests.length,
    changedParts,
    addedParts,
    removedParts,
    details,
  }
}

/**
 * 尾部动态上下文的渲染（core 在 `core.prompt.dynamic.transform` 之后拼接）。
 *
 * 用一层标记把"宿主注入的上下文"和"用户真的说了什么"分开：这段是 `user` 角色（因为
 * anthropic/gemini 会把任意位置的 system 上提到前缀，见 `_buildStepMessages` 的注释），
 * 不加标记的话模型会把它当成用户发言，进而影响回复对象/口吻。
 */
export function renderDynamicBlock(parts: readonly string[]): string {
  return `<host-context note="宿主注入，非用户发言；内容可能每轮变化">\n${parts.join('\n\n')}\n</host-context>`
}

/**
 * 粗估一组消息的 token 数。
 *
 * 计数口径由 `countTokens` 决定（默认 CJK 感知，与 ACP 层一致）；旧口径 chars/4 会系统性
 * 低估中文会话约 4 倍 —— 那是 Claude Code 的 roughTokenCountEstimation，按英文语料标定。
 * - text part:  countTokens(text)
 * - tool part:  countTokens(JSON.stringify(result) + JSON.stringify(input))
 * - 其他 part:  countTokens(JSON.stringify(part))
 *
 * 先拼成一整段再计数（而不是每段各自 ceiling 后相加）：逐段 ceiling 会累积出系统性高估，
 * 也让"英文会话下新旧口径逐位等价"这条不变量失效。
 */
export function estimateMessagesTokens(
  messages: Message[],
  countTokens: (text: string) => number = countTokensCJK,
): number {
  let all = ''
  const add = (s: string): void => {
    all += s
  }
  for (const m of messages) {
    for (const p of m.parts) {
      const pt = p as any
      if (pt.type === 'text') {
        add(String(pt.text ?? ''))
      } else if (pt.type === 'tool') {
        try { add(JSON.stringify(pt.result ?? '')) } catch { add('x'.repeat(100)) }
        try { add(JSON.stringify(pt.input ?? {})) } catch { /* ignore */ }
      } else {
        try { add(JSON.stringify(pt)) } catch { /* ignore */ }
      }
    }
  }
  return countTokens(all)
}

/**
 * 工具载荷的本地 token 估算（近似 provider 实际发出的 `tools` 字段形状）。
 *
 * 为什么必须有它：ACP 侧的 `occupancy` / `requestTok` **只算历史消息**，不含 system 与工具载荷；
 * 而 provider 计费/缓存口径是**整包请求**。真机取证（临时 dataDir 跑 3 轮）实测：工具载荷占
 * 请求体的绝大部分（body 18.7KB，system 仅 187 字符），把它漏掉会让"本地 vs provider"的比
 * 看起来像 tokenizer 差 3 倍，其实主要是**漏算了固定开销**。有了这一项，口径对比才是同类相比。
 */
function estimateToolPayloadTokens(tools: Tool[], countTokens: (text: string) => number): number {
  if (!tools || tools.length === 0) return 0
  try {
    const payload = tools.map((t) => ({
      name: t.id,
      description: t.description ?? '',
      parameters: (t.inputSchema as { __jsonSchema?: unknown } | undefined)?.__jsonSchema ?? {},
    }))
    return countTokens(JSON.stringify(payload))
  } catch {
    return 0
  }
}

/** createHarness() 参数 */
export interface AgentHarnessOptions {
  /** 工作目录（注入 ToolContext.cwd，默认 process.cwd()） */
  cwd?: string
  /**
   * token 折算口径：`auto`（缺省，CJK 感知）/ `chars4`（旧口径）。
   *
   * 与 `compression.tokenCalibration` 同源，宿主应把**同一个值**传进来 —— 否则引擎侧的
   * 用量估算与 ACP 层的占用率闸门会用两把尺子（历史上分裂过一次）。
   */
  tokenCalibration?: TokenCalibration
  /**
   * 本地 token 估算的额外校正系数（缺省 1 = 不校正）。
   *
   * 与 `compression.tokenCalibrationScale` 同源，宿主应把**同一个值**传进来：
   * 本地估算与 provider 计费口径不是同一把尺子（真机实测 DeepSeek 稳定 1.33），
   * 只在一侧校正就等于制造新的口径分裂。
   */
  tokenCalibrationScale?: number
  /**
   * 宿主工作区布局（由 CLI 传入，含 `--data-dir` 等实际取值）。
   *
   * 不传时 core 会按 `resolveWorkspace({ cwd })` 自建一份（缺省 `~/.harness`）——
   * 独立使用 core 的场景（测试、嵌入式宿主）因此也能给插件一个可用的路径视图。
   * 传入的意义是**避免路径口径分裂**：CLI 的 dataDir 可能来自 `--data-dir`，
   * core 自己 resolve 会算错。
   */
  workspace?: Workspace
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
  /**
   * 可选：原文档案存储器（@harness/session 的 SessionOriginalStore）。
   * 注入后，会话 compact 在裁剪前会把被压缩窗口原文落盘到内存之外，
   * 供 flushHistory/loader 按块还原（"内存瘦身 + 全文可回溯"）。
   * 未注入则压缩不产原文档案（仍产 blocks 与摘要，全文回溯退化为仅摘要）。
   */
  originalStore?: SessionOriginalStore
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

/**
 * 生命周期跨层解耦事件。
 *
 * 命令单一职责：`plugin` 只管插件生命周期、`mcp` 只管 MCP server 生命周期、
 * `tool` 只管工具启停。上层命令变更对下层的影响通过本组事件解耦——
 * 下层组件在 install 订阅、uninstall 退订，收到事件后自行刷新自身缓存/清单，
 * 不反向修改上层的内部状态。
 *
 * 发布方（变更提起来的那一方）：
 * - manage-plugin：pluginLoaded / pluginUnloaded / pluginUpdated
 * - mcp-server-registry：mcpServerEnabled / mcpServerDisabled / mcpServerAdded / mcpServerRemoved
 * - tools-manager：toolEnabled / toolDisabled
 *
 * 载荷使用 `{ id }` / `{ name }` 细粒度，便于订阅方精确命中并刷新自身状态。
 */
export const LifecycleEvents = {
  pluginLoaded:   BusEvent.define<{ id: string }>('plugin.loaded'),
  pluginUnloaded: BusEvent.define<{ id: string }>('plugin.unloaded'),
  pluginUpdated:  BusEvent.define<{ id: string }>('plugin.updated'),
  mcpServerEnabled:  BusEvent.define<{ name: string }>('mcp.server.enabled'),
  mcpServerDisabled: BusEvent.define<{ name: string }>('mcp.server.disabled'),
  mcpServerAdded:    BusEvent.define<{ name: string }>('mcp.server.added'),
  mcpServerRemoved:  BusEvent.define<{ name: string }>('mcp.server.removed'),
  toolEnabled:   BusEvent.define<{ id: string; agentId?: string }>('tool.enabled'),
  toolDisabled:  BusEvent.define<{ id: string; agentId?: string }>('tool.disabled'),
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
  /** 用量审计（引擎层唯一累加者） */
  public readonly usage: UsageAccessor
  /** Skill 管理器（从 skillDirs 加载，通过 core.prompt.system.transform 注入） */
  public skillManager?: SkillManager
  /** 全局工具工作目录（= options.cwd ?? process.cwd()） */
  public readonly cwd: string

  /**
   * token 折算口径（引擎侧唯一取值点）。
   *
   * 与 ACP 层、`compactIfNeeded`、`acp_status` 用**同一把尺子**：口径分裂过一次
   * （遥测 CJK / 决策 chars4），事后无法用遥测复盘决策。缺省 `auto` = CJK 感知。
   */
  private readonly countTokens: (text: string) => number

  private chatProvider: ChatProvider
  private started = false
  private stopped = false

  constructor(private readonly options: AgentHarnessOptions) {
    this.bus = options.bus ?? createBus()
    this.cwd = options.cwd ?? process.cwd()
    this.countTokens = resolveCountTokens(options.tokenCalibration, options.tokenCalibrationScale)
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
      // 工作区路径视图：优先用宿主传入的（CLI 可能带 --data-dir），否则按 cwd 自建。
      // 插件靠它定位记忆/技能目录 —— 不能靠 process.cwd() 猜（--cwd 时口径不同）。
      // ⚠️ 这里必须用 `options.cwd` 而不是 `this.cwd`：后者在本行之后（:2376）才赋值，
      // 此时读到的是 undefined，会静默退回 process.cwd() —— 正好造成要避免的口径分裂。
      workspace: options.workspace ?? resolveWorkspace({ cwd: options.cwd }),
    })

    // ToolPipeline 接入 Plugin hooks（pre/post）
    // - preHook 洋葱：按插件序，把 core.tool.pre.execute 包装成 next() 链
    // - postHook 顺序：把 core.tool.post.execute 插入
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let _self: unknown = null
    _self = this as any
    const preHook: ToolPreHook = async (preCtx, next) => {
      const idx = 0
      // 每次执行时重新取（插件可热插拔），顺序 = 插件加载顺序
      const entries = this.plugin.listHooks('core.tool.pre.execute')
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
      const entries = this.plugin.listHooks('core.tool.post.execute')
      for (const e of entries) {
        const fn = e.fn as (ctx: unknown, res: unknown) => Awaitable<unknown>
        const next = await fn({ ...postCtx, pluginId: e.pluginId }, r)
        if (next && typeof next === 'object') r = next as ToolResult
      }
      return r
    }
    this.toolPipeline = new ToolPipeline({
      checkPermission: (req) =>
        resolvePermission(this.permission, req as ToolPermissionRequest, bindTrigger(this.plugin)) as Promise<ToolPermissionDecision>,
      preHooks: [preHook],
      postHooks: [postHook],
    })

    // Session 引用 AgentRuntime（懒回调）
    let agentRuntime: AgentRuntime | undefined
    this.session = new DefaultSessionManager(() => {
      if (!agentRuntime) throw new Error('AgentRuntime 未就绪')
      return {
        agent: agentRuntime,
        currentAgentId: () => options.defaultAgentId ?? 'default',
        triggerPlugin: bindTrigger(this.plugin),
        originalStore: options.originalStore,
      }
    })

    // 用量审计：以 meta 为唯一真相（引擎每步折叠写入，见 accumulateUsage）。
    // 这里刻意不持有独立累加器 —— 进程内再存一份就会与持久化值分叉，
    // 而分叉的症状正是历史上踩过的"重连后数字变了"。
    this.usage = {
      get: async (sessionId: string) => {
        const sess = await this.session.get(sessionId)
        if (!sess) return hydrateUsage()
        return hydrateUsage({ meta: sess.meta, messages: sess.messages })
      },
      children: async (sessionId: string) => {
        const all = await this.session.list()
        // ⚠️ parentId 是 **Session 的顶层字段**（`session.create({ parentId })`，subagent 插件
        // 派生时写入；落盘/恢复也走顶层字段），**不在 meta 里**。真机核对过：
        // 子会话 json 顶层有 `parentId`，`meta.parentId` 为 null。
        return all.filter((s) => s.parentId === sessionId).map((s) => s.id)
      },
    }

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
      countTokens: this.countTokens,
      snapshot: options.snapshot,
      logger: options.logger,
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
    const warnAgent = this.options.logger?.warn?.bind(this.options.logger)
    for (const item of agentLoader.scan({ kind: 'file', name: (n) => extname(n) === '.md' })) {
      try {
        const content = readFileSync(item.full, 'utf-8')
        // 文件名（不含扩展名）作为 fallbackId
        // onWarn：md 未声明 tools 时会按「只读工具」兜底（fail-safe），必须让用户看见，
        // 否则现象是「子 Agent 能派出但什么也干不了」——正是缺 tools 的隐蔽症状。
        const def = agentFromMarkdown(content, basename(item.name, '.md'), {
          onWarn: (msg) => (warnAgent ? warnAgent(msg) : console.warn(msg)),
        })
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

  /** 初始化：加载 Internal/Builtin/User 插件 + core.harness.init Hook */
  private async init(): Promise<void> {
    const startedAt = Date.now()
    await this.bus.publish(HarnessEvents.initializing, { startedAt }, { source: 'harness' })
    try {
      if (this.options.internalPlugins?.length) await this.plugin.loadInternal(this.options.internalPlugins)
      if (this.options.builtinPlugins?.length) await this.plugin.loadBuiltin(this.options.builtinPlugins)
      if (this.options.userPlugins?.length) await this.plugin.loadUser(this.options.userPlugins)

      // Skill 注入插件：在 core.prompt.system.transform Hook 中注入匹配的 Skill 内容
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

        // 2. 注册注入插件。
        //
        // 判据是「**宿主编配了技能目录**」（= 技能系统启用），**不是**「当前有没有技能」：
        // 技能可能在会话中途被锻造/新增（`@harness/skill-forge` 落盘后 reload 进 manager），
        // 若 init 时为空就不注册，之后新增的技能**永远进不了提示词** —— 真机实测过：空 skills
        // 目录启动 → 锻造并绑定白名单 → 后续每轮 system 指纹完全不变（技能从未注入）。
        // 未配技能目录的宿主（多为单测/内嵌最小用法）不注册，避免污染插件列表。
        if ((this.options.skillDirs?.length ?? 0) > 0) {
          const skillManager = this.skillManager
          const agentAccessor = this.agent
          await this.plugin.loadInternal([{
            id: 'core.skill-injection',
            version: '0.1.0',
            name: 'Skill 注入',
            description: '将 agent.skills 白名单中的 Skill 注入 system prompt；paths 条件触发的技能经尾部动态通道注入',
            async install() {
              return {
                async 'core.prompt.system.transform'(
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
                // paths 条件触发：命中 skill.paths 的技能走**尾部动态通道**（不进前缀）。
                // 位置为什么是这里：条件是"内容随轮变化"，进 sysParts 会让前缀缓存每轮失效
                // （真机量化 ≈ 95K token-equiv/翻转，见 docs/usage-accounting-and-prompt-cache-plan.md §8.1）。
                async 'core.prompt.dynamic.transform'(
                  input: { agentId: string; sessionId: string; involvedPaths?: string[] },
                  dynParts: string[],
                ) {
                  const paths = input.involvedPaths
                  if (!paths || paths.length === 0) return
                  const matched = new Map<string, ReturnType<SkillManager['get']>>()
                  for (const p of paths) {
                    for (const s of skillManager.matchByPath(p)) matched.set(s.id, s)
                  }
                  for (const s of matched.values()) {
                    if (s) dynParts.push(formatSkillForPrompt(s))
                  }
                },
              } as import('@harness/plugin').Hooks
            },
          }])
        }
      }

      // core.harness.init Hook（给插件最后一次修改 context/tool 机会）
      const initIn: PluginHarnessInitInput = { harnessOptions: this.options }
      const initOut: PluginHarnessInitOutput = { harness: this }
      await (this.plugin as any).trigger('core.harness.init', initIn, initOut)
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
      await (this.plugin as any).trigger('core.harness.start', startIn, startOut)
    } catch (err) {
      await this.bus.publish(HarnessEvents.error, { stage: 'start', error: err }, { source: 'harness' })
      throw err
    }
    this.started = true
    await this.bus.publish(HarnessEvents.started, { durationMs: Date.now() - startedAt }, { source: 'harness' })
  }

  /**
   * 组装工具池（见 Harness.assembleTools 注释）。与 query 内联逻辑一致：新建
   * DefaultToolPool 绑定全局 ToolRegistry，逐 Agent 触发 core.tool.pool.assemble Hook。
   */
  async assembleTools(): Promise<void> {
    const pool = new DefaultToolPool(this.tools)
    for (const def of this.agent.list()) {
      await (this.plugin as any).trigger('core.tool.pool.assemble', { agentId: def.id } as ToolPoolAssembleInput, pool)
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
 * 2. init（加载 Internal/Builtin/User 插件 + 触发 core.harness.init Hook）
 * 3. 返回实例（未 start，由调用方按需 await harness.start()）
 */
export async function createHarness(options: AgentHarnessOptions = {}): Promise<Harness> {
  const harness = new HarnessImpl(options)
  // 私有方法：通过原型调用 init
  await (harness as unknown as { init(): Promise<void> }).init()
  return harness
}
