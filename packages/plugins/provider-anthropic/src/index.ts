/**
 * @harness/provider-anthropic - Anthropic Claude Provider 插件
 *
 * 功能：
 * - 实现 Anthropic Messages API 对接（非流式）
 * - Session Message → Claude Message/Block 序列化
 *   - system role → 请求体 system 字段（合并为单个 string）
 *   - user → user 消息；assistant → assistant 消息
 *   - TextPart → text block
 *   - ToolCallPart (assistant 里的调用) → tool_use block
 *   - ToolCallPart (带 result 的，放在 user/tool role) → tool_result block
 *   - ReasoningPart → assistant: text block（thinking 预发行版本暂时降级，因为官方没有开放 thinking content block）
 *   - FilePart（base64 内容 → image/document；MIME image/ 开头 → image block，否则 → document（不支持时跳过））
 *   - PatchPart / ImagePart → text block 兜底描述
 * - Tool 定义 → tool_definitions（description + input_schema JSON Schema）
 * - 响应解析：Content Block（text / tool_use）→ ChatCompletionOutput
 * - 可配置：apiKey / baseUrl / defaultModel / maxTokens / timeoutMs / toolBashThreshold
 *
 * 配置来源（优先级从高到低）：
 * 1. createProviderAnthropicPlugin({ ... }) 直接传入配置
 * 2. ctx.config.get('provider.anthropic')
 * 3. 环境变量 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 */

import type { ChatProvider, ChatCompletionOutput, ChatStreamChunk, ProviderRuntime } from '@harness/core'
import { normalizeFinishReason } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext, ProviderConfig, ProviderTypeFactory } from '@harness/plugin'
import type { Message, Part } from '@harness/session'
import type { Tool } from '@harness/tool'

// 流式总时长兜底系数：空闲超时负责「卡住不吐数据」，总时长兜底负责「一直慢慢吐、永不结束」。
// 取 idle 的 10 倍作为宽松上限，正常请求不会触及。
const STREAM_TOTAL_TIMEOUT_FACTOR = 10

/**
 * 非流式 `complete()` 的总时长系数，与流式的 `STREAM_TOTAL_TIMEOUT_FACTOR` 对齐。
 *
 * 为什么必须对齐（真机实测）：`timeoutMs` 在流式路径是 **idle**（多久没数据判死），
 * 而 `complete()` 只有一个**总时长**计时器 —— 此前直接拿 `timeoutMs` 当总时长，
 * 等于同一件事（整段生成要多久）在非流式路径上严 10 倍。子 Agent 走 `preferComplete`
 * 非流式路径时因此更容易被误判超时（会话 `s_1789996799007_9cq9r` 的 reviewer 实测）。
 * 常量刻意复用流式系数：两条路径的"总时长上限"从此同义；要退回旧行为把系数配成 1。
 */
const COMPLETE_TIMEOUT_FACTOR_ALIGN = STREAM_TOTAL_TIMEOUT_FACTOR

// ===== 配置 =====

export interface AnthropicProviderConfig {
  /** API Key（默认读 ANTHROPIC_API_KEY 环境变量） */
  apiKey?: string
  /** API 根路径（默认 https://api.anthropic.com） */
  baseUrl?: string
  /** 默认模型（默认 claude-3-sonnet-20240229） */
  defaultModel?: string
  /** max_tokens 默认值（默认 4096） */
  maxTokens?: number
  /** 请求超时（ms，默认 120_000） */
  timeoutMs?: number
  /**
   * 非流式 `complete()` 的总时长系数（缺省 {@link COMPLETE_TIMEOUT_FACTOR_ALIGN}）。
   *
   * `timeoutMs` 在两条路径上的**语义不同**，必须分级：
   * - 流式：`timeoutMs` 是 **idle**（多久没数据判死），另有 `× STREAM_TOTAL_TIMEOUT_FACTOR` 的总时长兜底；
   * - 非流式 `complete()`：只有一个**总时长**计时器，此前直接用 `timeoutMs` ⇒ 同一件事
   *   （整段生成要多久）在非流式路径上比流式严 10 倍。
   *
   * 真机后果（会话 `s_1789996799007_9cq9r`）：子 Agent 走 `preferComplete` 非流式路径审查
   * 77KB HTML，撞 60s 被判「OpenAI 请求超时（>60000ms）」，只能缩小范围重试。
   * 本系数让"总时长上限"在两个路径上语义一致；设为 1 即退回旧行为。
   */
  completeTimeoutFactor?: number
  /** anthropic-version 头（默认 2023-06-01） */
  apiVersion?: string
  /** 当模型输出空时是否报错误（默认 false 返回空 content） */
  strictEmptyContent?: boolean
  /**
   * 显式 prompt 缓存：给请求体打 Anthropic 的 `cache_control` 断点。
   *
   * ⚠️ **默认 false**，且本仓库**尚未在真实 Anthropic 端点上验收过**（开发机只有 DeepSeek 的
   * key）—— 这是本项目「与外部服务对接以真机为准」约定的直接后果：**未验收的行为不默认影响用户**。
   * 拿到 key 后应验收这两点，再把默认值翻成 true：
   *   ① 第二次同前缀请求的 `usage.cache_read_input_tokens > 0`；
   *   ② `cache_creation_input_tokens` 只在首次/前缀变化时出现（而不是每轮都写）。
   * 另一个待实测项：可缓存前缀有**最小 token 数**门槛（不足则静默不缓存，不报错）。
   *
   * 打开后打 3 个断点（tools 末尾 / system / 当前对话末尾），代价是首次写入多付 25%，
   * 第二次命中即回本（命中 ≈ 0.1x）。
   */
  promptCache?: boolean
  /**
   * 装配实例 id（**路由键**，默认 `'anthropic'`）。
   *
   * 与 `id` 作为类型标识不同：同一份 config 数组里可以有两个 anthropic 端点
   * （如 id="a1" / id="a2"），此时必须各自带自己的 providerId，否则会互相覆盖同一注册键。
   * 由 `providerTypeFactory.createPlugin` 从 `ProviderConfig.id` 透传（这是唯一权威来源）。
   */
  providerId?: string
}

// ===== Anthropic API 类型（精简子集）=====

/**
 * Anthropic 显式 prompt 缓存的断点标记。
 *
 * 与 OpenAI / DeepSeek 的**自动**前缀缓存不同：Anthropic 必须在请求体里显式标
 * `cache_control` 才会缓存 —— 不标记就是**每次把 system + tools + 历史按 input 全价重付**
 * （本项目此前的状态）。命中价约 0.1x、写入约 1.25x（首次写入即多付 25%），一次请求最多 4 个断点。
 */
export type CacheControl = { type: 'ephemeral' }

/** system 的 block 形态：要带 cache_control 就不能再用纯 string */
type AnthropicSystemBlock = { type: 'text'; text: string; cache_control?: CacheControl }

type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: CacheControl }
type AnthropicImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
  cache_control?: CacheControl
}
type AnthropicToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  cache_control?: CacheControl
}
type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
  cache_control?: CacheControl
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

type AnthropicToolDef = {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
  cache_control?: CacheControl
}

type AnthropicRequestBody = {
  model: string
  max_tokens: number
  /** 纯文本（默认）或 block 数组 —— 要带 cache_control 时必须用数组形态 */
  system?: string | AnthropicSystemBlock[]
  messages: AnthropicMessage[]
  tools?: AnthropicToolDef[]
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: false
}

type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type AnthropicResponseBody = {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
  stop_sequence?: string | null
  usage: AnthropicUsage
  error?: { type: string; message: string }
}

// ===== Part 序列化工具 =====

/** 合并 system prompt */
/**
 * 给请求体打上 Anthropic 显式缓存断点（`promptCache: true` 时调用）。返回断点个数。
 *
 * 断点语义：缓存覆盖「从头到该块为止」的**整个前缀**，所以只需标最靠后的那个关键点。
 * 这里打 3 个（协议上限 4）：
 *   ① `tools` 的**最后一个** → 一次覆盖整块工具定义（最稳、最该缓存的部分）
 *   ② `system`（必须转成 block 数组才能带标记）→ 覆盖 tools + system
 *   ③ 当前对话的**最后一个 block** → 下一轮这条消息成为历史，整段变成可命中前缀
 *
 * 为什么标「最后一条消息」而不是倒数第二条：每轮都会把最新的 user / tool_result 追加进来，
 * 它是**下一轮唯一必然逐字相同**的锚点；标在它上面，下一轮的命中长度最大。
 *
 * ⚠️ 未经真机验收 —— 见 `AnthropicProviderConfig.promptCache` 的说明。
 */
export function applyAnthropicCacheBreakpoints(body: AnthropicRequestBody): number {
  const cc: CacheControl = { type: 'ephemeral' }
  let count = 0
  const lastTool = body.tools?.[body.tools.length - 1]
  if (lastTool) {
    lastTool.cache_control = cc
    count += 1
  }
  // 纯 string 形态无法承载 cache_control，必须换成 block 数组（协议允许两种形态）
  if (typeof body.system === 'string' && body.system.length > 0) {
    body.system = [{ type: 'text', text: body.system, cache_control: cc }]
    count += 1
  }
  const lastMsg = body.messages[body.messages.length - 1]
  const lastBlock = lastMsg?.content[lastMsg.content.length - 1]
  if (lastBlock) {
    lastBlock.cache_control = cc
    count += 1
  }
  return count
}

function extractSystemPrompt(messages: Message[]): { system: string | undefined; rest: Message[] } {
  const sysParts: string[] = []
  const rest: Message[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      for (const p of m.parts) if (p.type === 'text') sysParts.push((p as { text: string }).text)
    } else {
      rest.push(m)
    }
  }
  return { system: sysParts.length > 0 ? sysParts.join('\n\n') : undefined, rest }
}

/** 格式化 Part → Claude content block 数组 */
function serializePart(part: Part, role: Message['role']): AnthropicContentBlock[] {
  switch (part.type) {
    case 'text':
      return [{ type: 'text', text: (part as any).text }]

    case 'tool': {
      const tp = part as any
      const hasResult = 'result' in tp && tp.result !== undefined
      if (role === 'assistant' || !hasResult) {
        // 作为模型调用：tool_use block（放在 assistant 消息里）
        return [{
          type: 'tool_use',
          id: tp.toolUseId ?? `gen_${Math.random().toString(36).slice(2, 10)}`,
          name: tp.toolId,
          input: tp.input ?? {},
        }]
      }
      // 有 result：tool_result block（user 消息里带结果）
      const isError = !!tp.isError
      let contentStr: string
      try {
        contentStr = typeof tp.result === 'string' ? tp.result : JSON.stringify(tp.result)
      } catch {
        contentStr = String(tp.result)
      }
      const block: AnthropicToolResultBlock = { type: 'tool_result', tool_use_id: tp.toolUseId, content: contentStr }
      if (isError) block.is_error = true
      return [block]
    }

    case 'reasoning':
      // thinking block 目前非公开，降级为纯文本（带 thinking 前缀方便识别）
      return [{ type: 'text', text: `[thinking]\n${(part as any).text ?? ''}` }]

    case 'file': {
      const fp = part as any
      const mime = fp.mimeType ?? 'application/octet-stream'
      if (fp.content) {
        // base64：image → image block，其他降级为 text（文档块 MIME 支持有限，保守策略）
        if (mime.startsWith('image/')) {
          return [{
            type: 'image',
            source: { type: 'base64', media_type: mime, data: fp.content },
          }]
        }
        return [{ type: 'text', text: `[File: ${fp.path ?? 'inline file'} mime=${mime}]` }]
      }
      return [{ type: 'text', text: `[File: ${fp.path}]` }]
    }

    case 'image': {
      const ip = part as any
      const mime = ip.mimeType ?? 'image/png'
      if (ip.content) {
        return [{
          type: 'image',
          source: { type: 'base64', media_type: mime, data: ip.content },
        }]
      }
      return [{ type: 'text', text: `[Image: ${ip.path ?? 'image'}]` }]
    }

    case 'patch': {
      const pp = part as any
      return [{ type: 'text', text: `[Patch: ${pp.path ?? 'unknown'}]\n${pp.patch ?? ''}` }]
    }

    default:
      return [{ type: 'text', text: JSON.stringify(part) }]
  }
}

/** 把多条 Harness Messages 转成 Claude Messages */
function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue // 已在请求体 system 字段提取
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user'
    const blocks: AnthropicContentBlock[] = []
    for (const p of msg.parts) {
      const converted = serializePart(p, role)
      // 合并相邻 text block（避免空 text 块）
      for (const b of converted) if (!(b.type === 'text' && b.text === '')) blocks.push(b)
    }
    if (blocks.length === 0) continue
    out.push({ role, content: blocks })
  }
  // 约束：第一条和最后一条不能都与上一次角色相同？通常 messages 长度为 0 时不需要，这里让 Claude 返回自然错误即可
  return out
}

// ===== Tool Schema 导出 =====

/**
 * 把 Tool → Anthropic tool_definition。
 * 由于 Tool.inputSchema 是抽象 Schema 接口（parse/safeParse），无法直接抽取 JSON Schema。
 * 所以有两级策略：
 *   1. 如果 schema.__jsonSchema（非标准但插件可以扩展）存在则直接使用
 *   2. 否则生成宽松的 {type:'object',additionalProperties:true} 兜底 schema（让模型填 JSON，ToolPipeline 再硬校验）
 */
function toolToAnthropicDef(tool: Tool): AnthropicToolDef {
  const description = tool.documentation
    ? `${tool.description || tool.id}\n\n${tool.documentation}`
    : tool.description || tool.id
  const schema: any = (tool.inputSchema as any).__jsonSchema
  if (schema && typeof schema === 'object') {
    return {
      name: tool.id,
      description,
      // 整体转发：保留 oneOf 等关键字（同 openai，勿逐字段挑选）
      input_schema: { ...schema, type: schema.type ?? 'object' },
    }
  }
  // 兜底：宽松对象 schema
  return {
    name: tool.id,
    description,
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  }
}

// ========================================================================
// AnthropicChatProvider
// ========================================================================

export class AnthropicChatProvider implements ChatProvider {
  /**
   * 装配实例 id —— **路由键**（= ProviderConfig.id），默认 `'anthropic'`。
   *
   * 不再是硬编码常量：硬编码会让「同一模型挂多个端点」的两个实例自报同一个 id，
   * 从而在注册表里互相覆盖（`agent.model.providerId='a2'` 会静默回退默认）。
   */
  readonly id: string
  readonly calls: Array<{ body: AnthropicRequestBody; response?: AnthropicResponseBody; error?: unknown }> = []

  private readonly config: Required<
    Pick<
      AnthropicProviderConfig,
      'baseUrl' | 'defaultModel' | 'maxTokens' | 'timeoutMs' | 'completeTimeoutFactor' | 'apiVersion' | 'strictEmptyContent' | 'promptCache'
    >
  > & { apiKey?: string }

  /** 工具池回调：每次 complete() 时实时取最新工具列表 */
  private toolsGetter: () => Tool[]

  constructor(
    config: AnthropicProviderConfig = {},
    toolsGetter: () => Tool[] = () => []
  ) {
    this.toolsGetter = toolsGetter
    this.id = config.providerId ?? 'anthropic'
    const envKey = typeof process !== 'undefined' ? process.env.ANTHROPIC_API_KEY : undefined
    const envBase = typeof process !== 'undefined' ? process.env.ANTHROPIC_BASE_URL : undefined
    this.config = {
      apiKey: config.apiKey ?? envKey,
      baseUrl: config.baseUrl ?? envBase ?? 'https://api.anthropic.com',
      defaultModel: config.defaultModel ?? 'claude-3-sonnet-20240229',
      maxTokens: config.maxTokens ?? 4096,
      timeoutMs: config.timeoutMs ?? 120_000,
      completeTimeoutFactor: config.completeTimeoutFactor ?? COMPLETE_TIMEOUT_FACTOR_ALIGN,
      apiVersion: config.apiVersion ?? '2023-06-01',
      strictEmptyContent: config.strictEmptyContent ?? false,
      promptCache: config.promptCache ?? false,
    }
  }

  /** 动态更新工具池 getter（由 core.harness.init Hook 在注册完成后调用） */
  setToolsGetter(getter: () => Tool[]): void {
    this.toolsGetter = getter
  }

  /** 动态更新 API Key */
  setApiKey(key: string): void {
    this.config.apiKey = key
  }

  // -------- ChatProvider.complete --------
  /**
   * 构造请求体（`complete` / `stream` 共用）。
   *
   * 抽出来的理由：这两处原本是**逐字重复**的两份（连字段顺序都一样），加任何请求参数都得改两遍
   * —— 而"只改了一处"正是本项目反复出现的静默失效来源（见 AGENTS.md「与外部服务对接以真机为准」）。
   */
  private buildBody(params: {
    model: string
    messages: AnthropicMessage[]
    llmParams: Record<string, unknown>
    system?: string
    tools?: Tool[]
  }): AnthropicRequestBody {
    const toolsDefs = (params.tools ?? this.toolsGetter()).map(toolToAnthropicDef)
    const body: AnthropicRequestBody = {
      model: params.model,
      max_tokens: this.config.maxTokens,
      messages: params.messages,
      stream: false,
    }
    if (params.system) body.system = params.system
    if (toolsDefs.length > 0) body.tools = toolsDefs
    const lp = params.llmParams
    if (typeof lp.temperature === 'number') body.temperature = lp.temperature as number
    if (typeof lp.top_p === 'number') body.top_p = lp.top_p as number
    if (typeof lp.top_k === 'number') body.top_k = lp.top_k as number
    if (Array.isArray(lp.stop_sequences)) body.stop_sequences = lp.stop_sequences as string[]
    if (this.config.promptCache) applyAnthropicCacheBreakpoints(body)
    return body
  }

  async complete(params: {
    providerId: string
    modelId?: string
    messages: Message[]
    params: Record<string, unknown>
    headers?: Record<string, string>
    signal?: AbortSignal
    sessionId?: string
    agentId?: string
    /** 本 agent 实际可用的工具（core 按 agent 白名单传入） */
    tools?: Tool[]
  }): Promise<ChatCompletionOutput> {
    const { system, rest } = extractSystemPrompt(params.messages)
    const messages = toAnthropicMessages(rest)

    const body = this.buildBody({
      model: params.modelId ?? this.config.defaultModel,
      messages,
      llmParams: params.params ?? {},
      system,
      tools: params.tools,
    })

    const record = { body, response: undefined as AnthropicResponseBody | undefined, error: undefined as unknown }
    this.calls.push(record)

    // AbortController 管理：外层 signal + 超时
    const inner = new AbortController()
    const outerSignal = params.signal
    const onOuter = () => inner.abort()
    if (outerSignal) {
      if (outerSignal.aborted) inner.abort()
      else outerSignal.addEventListener('abort', onOuter, { once: true })
    }
    // 非流式的计时器是**总时长**，不是 idle ⇒ 与流式的总时长兜底取同一系数（见 completeTimeoutFactor）
    const completeTimeoutMs = this.config.timeoutMs * this.config.completeTimeoutFactor
    const timer = setTimeout(
      () => inner.abort(new Error(`Anthropic 请求超时（>${completeTimeoutMs}ms = timeoutMs ${this.config.timeoutMs}ms × ${this.config.completeTimeoutFactor}）`)),
      completeTimeoutMs,
    )

    try {
      if (!this.config.apiKey) {
        throw new Error('Anthropic API Key 未配置，请设置 ANTHROPIC_API_KEY 环境变量或在 config 中传入 apiKey')
      }
      if (body.messages.length === 0) {
        // 防止 Anthropic API 报 400：messages cannot be empty
        body.messages = [{ role: 'user', content: [{ type: 'text', text: '(no history)' }] }]
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': this.config.apiVersion,
        ...(params.headers ?? {}),
      }

      const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: inner.signal,
      })

      const text = await resp.text()
      let parsed: AnthropicResponseBody
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        throw new Error(`Anthropic 响应不是 JSON (HTTP ${resp.status})：${text.slice(0, 500)}`)
      }
      record.response = parsed

      if (!resp.ok || parsed.error) {
        const msg = parsed.error?.message ?? `HTTP ${resp.status}: ${text.slice(0, 500)}`
        throw new Error(`Anthropic API 错误：${msg}`)
      }

      const textParts: string[] = []
      const toolCalls: Array<{ toolUseId: string; toolId: string; input: unknown }> = []
      for (const b of parsed.content) {
        if (b.type === 'text') textParts.push(b.text)
        else if (b.type === 'tool_use') toolCalls.push({ toolUseId: b.id, toolId: b.name, input: b.input })
      }

      if (this.config.strictEmptyContent && textParts.length === 0 && toolCalls.length === 0) {
        throw new Error('Anthropic 响应内容为空')
      }

      return {
        content: textParts.join('\n'),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model: parsed.model,
        tokenUsage: {
          input: parsed.usage.input_tokens,
          output: parsed.usage.output_tokens,
          total: parsed.usage.input_tokens + parsed.usage.output_tokens,
          ...(parsed.usage.cache_read_input_tokens != null ? { cacheRead: parsed.usage.cache_read_input_tokens } : {}),
          ...(parsed.usage.cache_creation_input_tokens != null ? { cacheWrite: parsed.usage.cache_creation_input_tokens } : {}),
        },
        finish: normalizeFinishReason(parsed.stop_reason),
        ...(parsed.stop_reason ? { finishRaw: parsed.stop_reason } : {}),
        raw: parsed,
      }
    } finally {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onOuter)
    }
  }

  // -------- ChatProvider.stream --------

  /**
   * 流式调用 Anthropic Messages API（stream: true），解析 SSE 事件逐 chunk yield。
   *
   * SSE 事件类型：
   *   message_start       → 初始化
   *   content_block_start → 新 block 开始（text / tool_use）
   *   content_block_delta → 增量（text_delta → text，input_json_delta → tool input）
   *   content_block_stop  → block 结束
   *   message_delta       → stop_reason / usage
   *   message_stop        → 流结束
   */
  async *stream(params: {
    providerId: string
    modelId?: string
    messages: Message[]
    params: Record<string, unknown>
    headers?: Record<string, string>
    signal?: AbortSignal
    sessionId?: string
    agentId?: string
    /** 本 agent 实际可用的工具（core 按 agent 白名单传入） */
    tools?: Tool[]
  }): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const { system, rest } = extractSystemPrompt(params.messages)
    const messages = toAnthropicMessages(rest)

    const body = this.buildBody({
      model: params.modelId ?? this.config.defaultModel,
      messages,
      llmParams: params.params ?? {},
      system,
      tools: params.tools,
    })

    // stream 请求体（覆盖 stream: true）
    const streamBody = { ...body, stream: true as const }

    if (!this.config.apiKey) {
      throw new Error('Anthropic API Key 未配置，请设置 ANTHROPIC_API_KEY 环境变量或在 config 中传入 apiKey')
    }
    if (streamBody.messages.length === 0) {
      streamBody.messages = [{ role: 'user', content: [{ type: 'text', text: '(no history)' }] }]
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': this.config.apiVersion,
      'Accept': 'text/event-stream',
      ...(params.headers ?? {}),
    }

    // AbortController 管理
    const inner = new AbortController()
    const outerSignal = params.signal
    const onOuter = () => inner.abort()
    if (outerSignal) {
      if (outerSignal.aborted) inner.abort()
      else outerSignal.addEventListener('abort', onOuter, { once: true })
    }
    // 空闲超时（idle），**不是**总时长超时：每收到一块数据就重新计时。
    // 总时长语义下，只要模型持续输出超过 timeoutMs 就会把长回答无理由掐断，
    // 用户看到的是「内容明明已经渲染出来了，却报发送失败」。判定结束的职责
    // 交给 `message_stop`（Anthropic SSE 的终止事件），见下方 readLoop。
    let timer: ReturnType<typeof setTimeout> | undefined
    const armIdleTimeout = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () => inner.abort(new Error(`Anthropic stream 空闲超时（>${this.config.timeoutMs}ms 无数据）`)),
        this.config.timeoutMs,
      )
    }
    armIdleTimeout()

    // 总时长兜底：即使上游持续慢速吐数据（每次间隔 < timeoutMs，idle 计时器永远被续期），
    // 一旦累计超过总时长上限也必须结束，否则请求会永远挂住。该计时器**不**随数据续期。
    const totalMs = this.config.timeoutMs * STREAM_TOTAL_TIMEOUT_FACTOR
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    totalTimer = setTimeout(
      () => inner.abort(new Error(`Anthropic stream 总时长超时（>${totalMs}ms）`)),
      totalMs,
    )

    try {
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(streamBody),
        signal: inner.signal,
      })

      if (!resp.ok) {
        const text = await resp.text()
        let msg = `HTTP ${resp.status}`
        try { const j = JSON.parse(text); if (j.error?.message) msg = j.error.message } catch {}
        throw new Error(`Anthropic stream 错误：${msg}`)
      }

      // SSE 解析
      const reader = resp.body?.getReader()
      if (!reader) throw new Error('Response body 不可读（stream not supported）')

      const decoder = new TextDecoder()
      let buf = ''
      let modelOut: string | undefined
      let tokenUsage: { input: number; output: number; total?: number; cacheRead?: number; cacheWrite?: number } | undefined
      // 原生 stop_reason（`message_start` 里为 null，终值随 `message_delta` 到达）
      let finishRaw: string | undefined
      // 当前 content block 的 index → 类型映射
      const blockTypes: Map<number, 'text' | 'tool_use'> = new Map()

      readLoop: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        armIdleTimeout() // 有数据到达 → 重新计时（idle 语义，持续输出不会被掐断）
        buf += decoder.decode(value, { stream: true })

        // 按行解析 SSE
        const lines = buf.split('\n')
        buf = lines.pop() ?? '' // 最后一行可能不完整

        let currentEvent = ''
        let currentData = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6)
          } else if (line === '' && currentData) {
            // 空行 = 事件结束
            const json = JSON.parse(currentData)
            currentEvent = json.type ?? currentEvent

            switch (currentEvent) {
              case 'message_start': {
                modelOut = json.message?.model
                const u = json.message?.usage
                if (u) tokenUsage = {
                  input: u.input_tokens ?? 0,
                  output: u.output_tokens ?? 0,
                  ...(u.cache_read_input_tokens != null ? { cacheRead: u.cache_read_input_tokens } : {}),
                  ...(u.cache_creation_input_tokens != null ? { cacheWrite: u.cache_creation_input_tokens } : {}),
                }
                break
              }
              case 'content_block_start': {
                const block = json.content_block
                if (block?.type === 'text') {
                  blockTypes.set(json.index, 'text')
                } else if (block?.type === 'tool_use') {
                  blockTypes.set(json.index, 'tool_use')
                  yield { type: 'tool_use_start', toolUseId: block.id, toolId: block.name }
                }
                break
              }
              case 'content_block_delta': {
                const delta = json.delta
                if (delta?.type === 'text_delta') {
                  yield { type: 'text_delta', text: delta.text }
                } else if (delta?.type === 'input_json_delta') {
                  yield { type: 'tool_use_delta', inputDelta: delta.partial_json }
                }
                break
              }
              case 'content_block_stop': {
                const bt = blockTypes.get(json.index)
                if (bt === 'tool_use') {
                  yield { type: 'tool_use_stop' }
                }
                blockTypes.delete(json.index)
                break
              }
              case 'message_delta': {
                const u = json.usage
                if (u && tokenUsage) {
                  tokenUsage.output = u.output_tokens ?? tokenUsage.output
                  tokenUsage.total = tokenUsage.input + tokenUsage.output
                }
                // 终态 stop_reason 随 message_delta 到达（message_start 里是 null）
                if (typeof json.delta?.stop_reason === 'string' && json.delta.stop_reason) {
                  finishRaw = json.delta.stop_reason
                }
                break
              }
              case 'message_stop': {
                // `message_stop` 是 SSE 规范里的流终止事件 —— 到此为止，**不能再等 socket EOF**。
                // 与 provider-openai 的 `data: [DONE]` 是同一类坑：部分自建网关/代理发完终止
                // 事件后并不关闭连接，若继续 await reader.read()，循环会一直挂着，直到超时
                // 计时器把整次请求判失败：内容早已渲染，用户却看到「发送失败」。
                break readLoop
              }
              case 'error': {
                throw new Error(`Anthropic stream error: ${json.error?.message ?? JSON.stringify(json)}`)
              }
            }

            currentEvent = ''
            currentData = ''
          }
        }
      }

      // 由 `message_stop` 提前 break 时主动释放连接（服务端不关连接 → 不 cancel 会让连接滞留在池里）
      try { await reader.cancel() } catch {}

      yield {
        type: 'done',
        model: modelOut ?? body.model,
        tokenUsage,
        finish: normalizeFinishReason(finishRaw),
        ...(finishRaw ? { finishRaw } : {}),
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onOuter)
    }
  }
}

// ========================================================================
// 插件工厂
// ========================================================================

/**
 * 创建 Anthropic Provider 插件
 *
 * @param config Provider 配置（会被 ctx.config.get('provider.anthropic') 和 环境变量覆盖或合并）
 */
export function createProviderAnthropicPlugin(config?: AnthropicProviderConfig): AgentPlugin & {
  readonly provider: AnthropicChatProvider
} {
  let provider: AnthropicChatProvider | undefined

  // 插件 id 随 providerId 派生，使多个 anthropic 端点可在同一进程内各自注册而不冲突。
  // 此前它们都是 'provider.anthropic'，多实例会被 pushBuilt 的 builtIds **静默去重丢掉**。
  const providerId = config?.providerId ?? 'anthropic'
  const pluginId = `provider.${providerId}`

  const plugin: AgentPlugin & { readonly provider: AnthropicChatProvider } = {
    id: pluginId,
    version: '0.1.0',
    name: 'Anthropic Provider',
    description: '对接 Anthropic Claude Messages API 的 Provider 插件',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      // 配置来源：直接传入 > config store（store 键随 providerId 派生，缺省仍是 'provider.anthropic'）
      const storeCfg = ctx.config.get<AnthropicProviderConfig>(pluginId)
      const merged: AnthropicProviderConfig = { ...(storeCfg ?? {}), ...(config ?? {}) }

      provider = new AnthropicChatProvider(merged, () => [])

      ctx.log.info('Anthropic Provider 已安装', {
        baseUrl: provider['config'].baseUrl,
        defaultModel: provider['config'].defaultModel,
        providerId,
      })

      return {
        async 'core.harness.init'(_input, output) {
          const harness = (output as { harness?: unknown }).harness as
            | {
                providers?: ProviderRuntime
                _setChatProvider?: (p: ChatProvider) => void
                tools?: { list?: () => Tool[] }
              }
            | undefined

          if (!provider) return

          // 注册键由调用方给（= ProviderConfig.id 派生），不让实例自报 id —— 见
          // docs/runtime-registration-plan.md §2.1。**不设默认**：默认由宿主显式 setDefault。
          if (harness?.providers) {
            harness.providers.register(providerId, provider, {
              source: `plugin:${pluginId}`,
              type: 'anthropic',
            })
          } else if (harness?._setChatProvider) {
            // 老宿主回退（渐进迁移）
            harness._setChatProvider(provider)
          } else {
            ctx.log.warn('Harness.providers 未找到，Anthropic Provider 可能未注册')
          }

          // 绑定工具池 getter（harness.tools.list() 实时取）
          provider.setToolsGetter(() => harness?.tools?.list?.() ?? [])
        },
      }
    },

    async uninstall() {
      provider = undefined
    },

    get provider(): AnthropicChatProvider {
      if (!provider) throw new Error('AnthropicChatProvider 未创建 — plugin.install() 未执行')
      return provider
    },
  }

  return plugin
}

/** 默认导出：无配置常量（配置来自 config store 与环境变量） */
export const providerAnthropicPlugin: AgentPlugin & { readonly provider: AnthropicChatProvider } =
  createProviderAnthropicPlugin()

// ========================================================================
// Provider 类型工厂（抽象层契约：@harness/plugin → ProviderTypeFactory）
// 上层（core/cli）只经 ProviderTypeRegistry 按 type 解析，不感知本模块具体配置结构。
// ========================================================================

export const providerTypeFactory: ProviderTypeFactory = {
  type: 'anthropic',
  createPlugin: (config: ProviderConfig): AgentPlugin =>
    createProviderAnthropicPlugin({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      defaultModel: config.model,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      // 装配实例键：ProviderConfig.id 是唯一权威来源（normalizeProviderConfigs 保证非空）。
      // 不传 ⇒ 本例会退回默认 'anthropic'，同类多实例就会互相覆盖同一个注册键。
      providerId: config.id,
      // 非流式总时长系数：ProviderConfig 有 index signature，这里的取值校验是唯一闸门
      completeTimeoutFactor: typeof config.completeTimeoutFactor === 'number' && config.completeTimeoutFactor > 0
        ? config.completeTimeoutFactor
        : undefined,
      // 显式缓存断点：ProviderConfig 有 index signature，不在这里透传就等于「配了没人消费」
      // （config.json 里写 `promptCache: true` 会被静默丢弃）。默认仍为关。
      promptCache: config.promptCache === true ? true : undefined,
    }),
}
