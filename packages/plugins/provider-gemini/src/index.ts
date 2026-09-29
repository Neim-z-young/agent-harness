/**
 * @harness/provider-gemini - Google Gemini Provider 插件
 *
 * 实现 Google Generative Language API 对接（非流式 + 流式）。
 *
 * 功能：
 * - Session Message → Gemini Contents 序列化
 *   - system role → systemInstruction 字段（合并为单 string）
 *   - user → role: 'user'；assistant → role: 'model'
 *   - TextPart → { text }
 *   - ToolCallPart (assistant 内的调用) → { functionCall: { name, args } }
 *   - ToolCallPart (带 result 的) → { functionResponse: { name, response } }
 *   - ReasoningPart → { text } 降级（Gemini 无 thinking block）
 *   - FilePart / ImagePart（base64 → inlineData { mimeType, data }）
 *   - PatchPart → { text } 兜底描述
 * - Tool 定义 → tools.functionDeclarations 数组
 * - 响应解析：candidates[0].content.parts → ChatCompletionOutput
 * - 可配置：apiKey / baseUrl / defaultModel / maxTokens / timeoutMs
 *
 * API 端点：
 * - 非流式：POST /v1beta/models/{model}:generateContent?key={apiKey}
 * - 流式：POST /v1beta/models/{model}:streamGenerateContent?alt=sse&key={apiKey}
 *
 * 配置来源（优先级从高到低）：
 * 1. createProviderGeminiPlugin({ ... }) 直接传入配置
 * 2. ctx.config.get('provider.gemini')
 * 3. 环境变量 GEMINI_API_KEY / GEMINI_BASE_URL
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

export interface GeminiProviderConfig {
  /** API Key（默认读 GEMINI_API_KEY 环境变量） */
  apiKey?: string
  /** API 根路径（默认 https://generativelanguage.googleapis.com） */
  baseUrl?: string
  /** 默认模型（默认 gemini-1.5-flash） */
  defaultModel?: string
  /** maxOutputTokens 默认值（默认 4096） */
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
  /** 当模型输出空时是否报错（默认 false 返回空 content） */
  strictEmptyContent?: boolean
  /**
   * 装配实例 id（**路由键**，默认 `'gemini'`）。
   *
   * 同一份 config 数组里可以有两个 gemini 端点（如 id="g1" / id="g2"），
   * 必须各自带自己的 providerId，否则会互相覆盖同一注册键。
   * 由 `providerTypeFactory.createPlugin` 从 `ProviderConfig.id` 透传（唯一权威来源）。
   */
  providerId?: string
}

// ===== Gemini API 类型（精简子集）=====

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: unknown; id?: string } }
  | { functionResponse: { name: string; response: unknown; id?: string } }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }

type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiFunctionDeclaration = {
  name: string
  description?: string
  parameters?: {
    type: string
    properties?: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

type GeminiRequestBody = {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>
  toolConfig?: { functionCallingConfig?: { mode: 'AUTO' | 'ANY' | 'NONE' } }
  generationConfig?: {
    temperature?: number
    topP?: number
    topK?: number
    maxOutputTokens?: number
    stopSequences?: string[]
  }
}

type GeminiCandidate = {
  content: { role: 'model'; parts: GeminiPart[] }
  finishReason: string
  index: number
  citationMetadata?: unknown
}

type GeminiResponseBody = {
  candidates: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
    cachedContentTokenCount?: number
  }
  error?: { code: number; message: string; status: string }
}

// ===== Part 序列化工具 =====

/** 提取 system 消息为 systemInstruction */
function extractSystem(messages: Message[]): {
  system: string | undefined
  rest: Message[]
} {
  const sysParts: string[] = []
  const rest: Message[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      for (const p of m.parts) {
        if (p.type === 'text') sysParts.push((p as { text: string }).text)
      }
    } else {
      rest.push(m)
    }
  }
  return {
    system: sysParts.length > 0 ? sysParts.join('\n\n') : undefined,
    rest,
  }
}

/** 把单条 Part 转 Gemini Part 数组 */
function serializePart(part: Part, role: 'user' | 'model'): GeminiPart[] {
  switch (part.type) {
    case 'text':
      return [{ text: (part as { text: string }).text }]

    case 'tool': {
      const tp = part as {
        toolUseId?: string
        toolId: string
        input?: unknown
        result?: unknown
        isError?: boolean
      }
      const hasResult = 'result' in tp && tp.result !== undefined
      if (role === 'model' || !hasResult) {
        // 模型调用：functionCall
        const fc: { name: string; args: unknown; id?: string } = {
          name: tp.toolId,
          args: tp.input ?? {},
        }
        if (tp.toolUseId) fc.id = tp.toolUseId
        return [{ functionCall: fc }]
      }
      // user 消息里带结果：functionResponse
      const fr: { name: string; response: unknown; id?: string } = {
        name: tp.toolId,
        response: tp.isError ? { error: tp.result } : tp.result,
      }
      if (tp.toolUseId) fr.id = tp.toolUseId
      return [{ functionResponse: fr }]
    }

    case 'reasoning':
      // Gemini 无 thinking block，降级为文本
      return [{ text: `[thinking]\n${(part as { text?: string }).text ?? ''}` }]

    case 'image': {
      const ip = part as { content?: string; mimeType?: string; path?: string }
      const mime = ip.mimeType ?? 'image/png'
      if (ip.content) {
        return [{ inlineData: { mimeType: mime, data: ip.content } }]
      }
      return [{ text: `[Image: ${ip.path ?? 'image'}]` }]
    }

    case 'file': {
      const fp = part as { content?: string; mimeType?: string; path?: string }
      const mime = fp.mimeType ?? 'application/octet-stream'
      if (fp.content) {
        if (mime.startsWith('image/')) {
          return [{ inlineData: { mimeType: mime, data: fp.content } }]
        }
        // 非图片文件：降级为文本描述（Gemini 文档 inlineData 支持更多类型，保守策略）
        return [{ inlineData: { mimeType: mime, data: fp.content } }]
      }
      return [{ text: `[File: ${fp.path ?? 'inline file'} mime=${mime}]` }]
    }

    case 'patch': {
      const pp = part as { path?: string; patch?: string }
      return [{ text: `[Patch: ${pp.path ?? 'unknown'}]\n${pp.patch ?? ''}` }]
    }

    default:
      return [{ text: JSON.stringify(part) }]
  }
}

/** 把多条 Harness Messages 转 Gemini Contents */
function toGeminiContents(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []
    for (const p of msg.parts) {
      for (const gp of serializePart(p, role)) {
        // 过滤空 text part
        if ('text' in gp && gp.text === '') continue
        parts.push(gp)
      }
    }
    if (parts.length === 0) continue
    out.push({ role, parts })
  }
  return out
}

// ===== Tool Schema 导出 =====

function toolToGeminiDecl(tool: Tool): GeminiFunctionDeclaration {
  const description = tool.documentation
    ? `${tool.description || tool.id}\n\n${tool.documentation}`
    : tool.description || tool.id
  const schema: any = (tool.inputSchema as any).__jsonSchema
  if (schema && typeof schema === 'object') {
    return {
      name: tool.id,
      description,
      // 整体转发：保留 oneOf 等关键字（同 openai，勿逐字段挑选）
      parameters: { ...schema, type: schema.type ?? 'object' },
    }
  }
  // 兜底：宽松对象 schema
  return {
    name: tool.id,
    description,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  }
}

// ========================================================================
// GeminiChatProvider
// ========================================================================

export class GeminiChatProvider implements ChatProvider {
  /**
   * 装配实例 id —— **路由键**（= ProviderConfig.id），默认 `'gemini'`。
   *
   * 不再是硬编码常量：硬编码会让「同一模型挂多个端点」的两个实例自报同一个 id，
   * 从而在注册表里互相覆盖（`agent.model.providerId='g2'` 会静默回退默认）。
   */
  readonly id: string
  readonly calls: Array<{
    body: GeminiRequestBody
    response?: GeminiResponseBody
    error?: unknown
  }> = []

  private readonly config: Required<
    Pick<
      GeminiProviderConfig,
      'baseUrl' | 'defaultModel' | 'maxTokens' | 'timeoutMs' | 'completeTimeoutFactor' | 'strictEmptyContent'
    >
  > & { apiKey?: string }

  private toolsGetter: () => Tool[]

  constructor(
    config: GeminiProviderConfig = {},
    toolsGetter: () => Tool[] = () => [],
  ) {
    this.toolsGetter = toolsGetter
    this.id = config.providerId ?? 'gemini'
    const envKey = typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : undefined
    const envBase = typeof process !== 'undefined' ? process.env.GEMINI_BASE_URL : undefined
    this.config = {
      apiKey: config.apiKey ?? envKey,
      baseUrl: config.baseUrl ?? envBase ?? 'https://generativelanguage.googleapis.com',
      defaultModel: config.defaultModel ?? 'gemini-1.5-flash',
      maxTokens: config.maxTokens ?? 4096,
      timeoutMs: config.timeoutMs ?? 120_000,
      completeTimeoutFactor: config.completeTimeoutFactor ?? COMPLETE_TIMEOUT_FACTOR_ALIGN,
      strictEmptyContent: config.strictEmptyContent ?? false,
    }
  }

  setToolsGetter(getter: () => Tool[]): void {
    this.toolsGetter = getter
  }

  setApiKey(key: string): void {
    this.config.apiKey = key
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    // Gemini 支持 x-goog-api-key 头或 ?key= 查询参数；使用头更干净
    if (this.config.apiKey) {
      headers['x-goog-api-key'] = this.config.apiKey
    }
    return { ...headers, ...(extra ?? {}) }
  }

  private buildBody(params: {
    messages: Message[]
    llmParams: Record<string, unknown>
    /** 本 agent 实际可用的工具（core 按 agent 白名单传入） */
    tools?: Tool[]
  }): GeminiRequestBody {
    const { system, rest } = extractSystem(params.messages)
    const contents = toGeminiContents(rest)
    const llmParams = params.llmParams ?? {}
    const toolsDefs = (params.tools ?? this.toolsGetter()).map(toolToGeminiDecl)

    const body: GeminiRequestBody = {
      contents,
    }
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] }
    }
    if (toolsDefs.length > 0) {
      body.tools = [{ functionDeclarations: toolsDefs }]
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
    }

    const genConfig: NonNullable<GeminiRequestBody['generationConfig']> = {
      maxOutputTokens: this.config.maxTokens,
    }
    if (typeof llmParams.temperature === 'number')
      genConfig.temperature = llmParams.temperature as number
    if (typeof llmParams.topP === 'number') genConfig.topP = llmParams.topP as number
    if (typeof llmParams.topK === 'number') genConfig.topK = llmParams.topK as number
    if (typeof llmParams.maxTokens === 'number')
      genConfig.maxOutputTokens = llmParams.maxTokens as number
    if (Array.isArray(llmParams.stop)) genConfig.stopSequences = llmParams.stop as string[]
    else if (typeof llmParams.stop === 'string')
      genConfig.stopSequences = [llmParams.stop as string]
    body.generationConfig = genConfig

    return body
  }

  private buildUrl(model: string, stream: boolean): string {
    const base = this.config.baseUrl.replace(/\/$/, '')
    const action = stream ? 'streamGenerateContent' : 'generateContent'
    // 使用查询参数 key 作为认证（Gemini 两种方式都支持，查询参数最通用）
    const keyParam = this.config.apiKey ? `?key=${encodeURIComponent(this.config.apiKey)}` : ''
    const streamParam = stream ? (this.config.apiKey ? '&alt=sse' : '?alt=sse') : ''
    return `${base}/v1beta/models/${encodeURIComponent(model)}:${action}${keyParam}${streamParam}`
  }

  // -------- ChatProvider.complete --------

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
    const model = params.modelId ?? this.config.defaultModel
    const body = this.buildBody({ messages: params.messages, llmParams: params.params, tools: params.tools })

    const record = {
      body,
      response: undefined as GeminiResponseBody | undefined,
      error: undefined as unknown,
    }
    this.calls.push(record)

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
      () => inner.abort(new Error(`Gemini 请求超时（>${completeTimeoutMs}ms = timeoutMs ${this.config.timeoutMs}ms × ${this.config.completeTimeoutFactor}）`)),
      completeTimeoutMs,
    )

    try {
      if (!this.config.apiKey) {
        throw new Error(
          'Gemini API Key 未配置，请设置 GEMINI_API_KEY 环境变量或在 config 中传入 apiKey',
        )
      }
      if (body.contents.length === 0) {
        body.contents = [{ role: 'user', parts: [{ text: '(no history)' }] }]
      }

      const headers = this.buildHeaders(params.headers)
      const url = this.buildUrl(model, false)
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: inner.signal,
      })

      const text = await resp.text()
      let parsed: GeminiResponseBody
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(
          `Gemini 响应不是 JSON (HTTP ${resp.status})：${text.slice(0, 500)}`,
        )
      }
      record.response = parsed

      if (!resp.ok || parsed.error) {
        const msg = parsed.error?.message ?? `HTTP ${resp.status}: ${text.slice(0, 500)}`
        throw new Error(`Gemini API 错误：${msg}`)
      }

      const candidate = parsed.candidates?.[0]
      if (!candidate) throw new Error('Gemini 响应无 candidates')

      const textParts: string[] = []
      const toolCalls: Array<{ toolUseId: string; toolId: string; input: unknown }> = []

      for (const p of candidate.content.parts) {
        if ('text' in p) {
          textParts.push(p.text)
        } else if ('functionCall' in p) {
          const fc = (p as { functionCall: { name: string; args: unknown; id?: string } })
            .functionCall
          toolCalls.push({
            toolUseId: fc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            toolId: fc.name,
            input: fc.args,
          })
        }
      }

      if (this.config.strictEmptyContent && textParts.length === 0 && toolCalls.length === 0) {
        throw new Error('Gemini 响应内容为空')
      }

      const usage = parsed.usageMetadata
      return {
        content: textParts.join('\n'),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model,
        tokenUsage: usage
          ? {
              input: usage.promptTokenCount,
              output: usage.candidatesTokenCount,
              total: usage.totalTokenCount,
              ...(usage.cachedContentTokenCount != null ? { cacheRead: usage.cachedContentTokenCount } : {}),
            }
          : undefined,
        finish: normalizeFinishReason(candidate.finishReason),
        ...(candidate.finishReason ? { finishRaw: candidate.finishReason } : {}),
        raw: parsed,
      }
    } finally {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onOuter)
    }
  }

  // -------- ChatProvider.stream --------

  /**
   * 流式调用 Gemini streamGenerateContent（alt=sse），解析 SSE 逐 chunk yield。
   *
   * Gemini SSE 格式：
   *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]}}]}
   *   ...
   *
   * functionCall 在 stream 中通常在某个 chunk 的 parts 里完整出现（非增量）。
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
    const model = params.modelId ?? this.config.defaultModel
    const body = this.buildBody({ messages: params.messages, llmParams: params.params, tools: params.tools })

    if (!this.config.apiKey) {
      throw new Error(
        'Gemini API Key 未配置，请设置 GEMINI_API_KEY 环境变量或在 config 中传入 apiKey',
      )
    }
    if (body.contents.length === 0) {
      body.contents = [{ role: 'user', parts: [{ text: '(no history)' }] }]
    }

    const headers = this.buildHeaders({
      ...params.headers,
      Accept: 'text/event-stream',
    })

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
    // 交给 `candidate.finishReason`，见下方 readLoop。
    let timer: ReturnType<typeof setTimeout> | undefined
    const armIdleTimeout = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () => inner.abort(new Error(`Gemini stream 空闲超时（>${this.config.timeoutMs}ms 无数据）`)),
        this.config.timeoutMs,
      )
    }
    armIdleTimeout()

    // 总时长兜底：即使上游持续慢速吐数据（每次间隔 < timeoutMs，idle 计时器永远被续期），
    // 一旦累计超过总时长上限也必须结束，否则请求会永远挂住。该计时器**不**随数据续期。
    const totalMs = this.config.timeoutMs * STREAM_TOTAL_TIMEOUT_FACTOR
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    totalTimer = setTimeout(
      () => inner.abort(new Error(`Gemini stream 总时长超时（>${totalMs}ms）`)),
      totalMs,
    )

    try {
      const url = this.buildUrl(model, true)
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: inner.signal,
      })

      if (!resp.ok) {
        const text = await resp.text()
        let msg = `HTTP ${resp.status}`
        try {
          const j = JSON.parse(text)
          if (j.error?.message) msg = j.error.message
        } catch {}
        throw new Error(`Gemini stream 错误：${msg}`)
      }

      const reader = resp.body?.getReader()
      if (!reader) throw new Error('Response body 不可读（stream not supported）')

      const decoder = new TextDecoder()
      let buf = ''
      let modelOut: string | undefined
      let tokenUsage: { input: number; output: number; total?: number; cacheRead?: number } | undefined
      // functionCall 在 stream 中可能跨 chunk，用 id 累积
      const pendingToolCalls: Map<string, { id: string; name: string; args: unknown }> = new Map()
      // 是否已看到 candidate.finishReason（= 模型生成已结束）
      let sawFinishReason = false
      // 原生 finishReason（大写，如 STOP / MAX_TOKENS / SAFETY / MALFORMED_FUNCTION_CALL）
      let finishRaw: string | undefined

      // Gemini 的 SSE **没有** OpenAI 的 `data: [DONE]` 终止帧，结束只能靠
      // `candidate.finishReason` 判定。真实端点会在末帧后关闭连接，但自建网关/代理
      // 常常发完就不关 —— 那种情况下若只认 EOF，循环会一直挂着直到超时计时器把整次
      // 请求判失败（内容早已渲染，用户却看到「发送失败」，同 provider-openai 的坑）。
      //
      // 已看到 finishReason 后再给一小段「收尾窗口」：usageMetadata 偶尔是单独一帧、
      // 排在 finishReason 之后，直接 break 会丢掉 token 统计。窗口内持续有新数据就
      // 不断续期；直到窗口内没有新数据才收工并 cancel 连接。
      // 窗口必须**短于** timeoutMs，不能只是「不超过」：收到 finishReason 后 idle
      // 计时器不再续期，若窗口 ≥ timeoutMs（旧实现的 max(50,…) 在 timeoutMs<200 时
      // 恰好造成这种倒挂），idle 会先触发，把已经正常结束的流误判成「空闲超时」。
      // 故取 min(300, timeoutMs, timeoutMs/4)，且不再用 50ms 硬下限顶住——
      // 正常配置（timeoutMs ≥ 1200）下结果仍是 300ms，与旧行为一致。
      const DRAIN_MS = Math.max(
        1,
        Math.min(300, this.config.timeoutMs, Math.floor(this.config.timeoutMs / 4)),
      )
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      const readOrDrain = async () => {
        const pending = reader.read()
        const drain = new Promise<'drain'>((resolve) => {
          drainTimer = setTimeout(() => resolve('drain'), DRAIN_MS)
        })
        try {
          return await Promise.race([pending, drain])
        } finally {
          if (drainTimer) clearTimeout(drainTimer)
        }
      }

      readLoop: while (true) {
        const next = sawFinishReason ? await readOrDrain() : await reader.read()
        if (next === 'drain' || next.done) break
        armIdleTimeout() // 有数据到达 → 重新计时（idle 语义，持续输出不会被掐断）
        buf += decoder.decode(next.value, { stream: true })

        // SSE 按双换行分块
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''

        for (const part of parts) {
          const lines = part.split('\n')
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (!data) continue

            let json: GeminiResponseBody & { error?: { message: string } }
            try {
              json = JSON.parse(data)
            } catch {
              continue
            }

            if (json.error) {
              throw new Error(`Gemini stream error: ${json.error.message ?? JSON.stringify(json)}`)
            }

            // usageMetadata 可能在最后一个 chunk，也**可能单独一帧、不带 candidates**
            // （部分网关/代理仿 OpenAI 的 include_usage 行为）。必须在 `!candidate` 分支
            // 之前解析，否则这一帧会被整个跳过、token 统计直接丢失。
            if (json.usageMetadata) {
              tokenUsage = {
                input: json.usageMetadata.promptTokenCount ?? 0,
                output: json.usageMetadata.candidatesTokenCount ?? 0,
                total: json.usageMetadata.totalTokenCount,
                ...(json.usageMetadata.cachedContentTokenCount != null ? { cacheRead: json.usageMetadata.cachedContentTokenCount } : {}),
              }
            }

            const candidate = json.candidates?.[0]
            if (!candidate) continue
            // finishReason 出现即代表生成结束（STOP / MAX_TOKENS / SAFETY…）
            if (candidate.finishReason) {
              sawFinishReason = true
              finishRaw = candidate.finishReason
            }

            for (const p of candidate.content.parts) {
              if ('text' in p && p.text) {
                yield { type: 'text_delta', text: p.text }
              } else if ('functionCall' in p) {
                const fc = (p as { functionCall: { name: string; args: unknown; id?: string } })
                  .functionCall
                const id = fc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`
                yield {
                  type: 'tool_use_start',
                  toolUseId: id,
                  toolId: fc.name,
                }
                // Gemini functionCall.args 是完整对象，一次性 yield
                const argsStr = JSON.stringify(fc.args ?? {})
                yield { type: 'tool_use_delta', inputDelta: argsStr }
                yield { type: 'tool_use_stop', toolUseId: id }
                pendingToolCalls.set(id, { id, name: fc.name, args: fc.args })
              }
            }
          }
        }
      }

      // 提前 break 时主动释放连接（服务端不关连接 → 不 cancel 会让连接滞留在池里）
      try { await reader.cancel() } catch {}

      yield {
        type: 'done',
        model: modelOut ?? model,
        tokenUsage,
        finish: normalizeFinishReason(finishRaw),
        ...(finishRaw ? { finishRaw } : {}),
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (totalTimer) clearTimeout(totalTimer)
      if (outerSignal) outerSignal.removeEventListener('abort', onOuter)
    }
  }
}

// ========================================================================
// 插件工厂
// ========================================================================

export function createProviderGeminiPlugin(
  config?: GeminiProviderConfig,
): AgentPlugin & { readonly provider: GeminiChatProvider } {
  let provider: GeminiChatProvider | undefined

  // 插件 id 随 providerId 派生，使多个 Gemini 端点可在同一进程内各自注册而不冲突
  const providerId = config?.providerId ?? 'gemini'
  const pluginId = `provider.${providerId}`

  const plugin: AgentPlugin & { readonly provider: GeminiChatProvider } = {
    id: pluginId,
    version: '0.1.0',
    name: 'Gemini Provider',
    description: '对接 Google Gemini Generative Language API 的 Provider 插件',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      const storeCfg = ctx.config.get<GeminiProviderConfig>(pluginId)
      const merged: GeminiProviderConfig = { ...(storeCfg ?? {}), ...(config ?? {}) }

      provider = new GeminiChatProvider(merged, () => [])

      ctx.log.info('Gemini Provider 已安装', {
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

          // 注册键由调用方给（= ProviderConfig.id 派生），不让实例自报 id。**不设默认**。
          if (harness?.providers) {
            harness.providers.register(providerId, provider, {
              source: `plugin:${pluginId}`,
              type: 'gemini',
            })
          } else if (harness?._setChatProvider) {
            harness._setChatProvider(provider)
          } else {
            ctx.log.warn('Harness.providers 未找到，Gemini Provider 可能未注册')
          }

          provider.setToolsGetter(() => harness?.tools?.list?.() ?? [])
        },
      }
    },

    async uninstall() {
      provider = undefined
    },

    get provider(): GeminiChatProvider {
      if (!provider) throw new Error('GeminiChatProvider 未创建 — plugin.install() 未执行')
      return provider
    },
  }

  return plugin
}

/** 默认导出：无配置常量（配置来自 config store 与环境变量） */
export const providerGeminiPlugin: AgentPlugin & { readonly provider: GeminiChatProvider } =
  createProviderGeminiPlugin()

// ========================================================================
// Provider 类型工厂（抽象层契约：@harness/plugin → ProviderTypeFactory）
// 上层（core/cli）只经 ProviderTypeRegistry 按 type 解析，不感知本模块具体配置结构。
// ========================================================================

export const providerTypeFactory: ProviderTypeFactory = {
  type: 'gemini',
  createPlugin: (config: ProviderConfig): AgentPlugin =>
    createProviderGeminiPlugin({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      defaultModel: config.model,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      // 非流式总时长系数：ProviderConfig 有 index signature，这里的取值校验是唯一闸门
      completeTimeoutFactor: typeof config.completeTimeoutFactor === 'number' && config.completeTimeoutFactor > 0
        ? config.completeTimeoutFactor
        : undefined,
      // 装配实例键：ProviderConfig.id 是唯一权威来源（缺省时退回 'gemini'）
      providerId: config.id,
    }),
}
