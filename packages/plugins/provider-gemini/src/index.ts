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

import type { ChatProvider, ChatCompletionOutput, ChatStreamChunk } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext } from '@harness/plugin'
import type { Message, Part } from '@harness/session'
import type { Tool } from '@harness/tool'

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
  /** 当模型输出空时是否报错（默认 false 返回空 content） */
  strictEmptyContent?: boolean
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
  const schema: any = (tool.inputSchema as any).__jsonSchema
  if (schema && typeof schema === 'object') {
    return {
      name: tool.id,
      description: tool.description || tool.id,
      parameters: {
        type: schema.type ?? 'object',
        properties: schema.properties ?? {},
        required: Array.isArray(schema.required) ? schema.required : undefined,
        additionalProperties: schema.additionalProperties ?? true,
      },
    }
  }
  // 兜底：宽松对象 schema
  return {
    name: tool.id,
    description: tool.description || tool.id,
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
  readonly id = 'gemini'
  readonly calls: Array<{
    body: GeminiRequestBody
    response?: GeminiResponseBody
    error?: unknown
  }> = []

  private readonly config: Required<
    Pick<
      GeminiProviderConfig,
      'baseUrl' | 'defaultModel' | 'maxTokens' | 'timeoutMs' | 'strictEmptyContent'
    >
  > & { apiKey?: string }

  private toolsGetter: () => Tool[]

  constructor(
    config: GeminiProviderConfig = {},
    toolsGetter: () => Tool[] = () => [],
  ) {
    this.toolsGetter = toolsGetter
    const envKey = typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : undefined
    const envBase = typeof process !== 'undefined' ? process.env.GEMINI_BASE_URL : undefined
    this.config = {
      apiKey: config.apiKey ?? envKey,
      baseUrl: config.baseUrl ?? envBase ?? 'https://generativelanguage.googleapis.com',
      defaultModel: config.defaultModel ?? 'gemini-1.5-flash',
      maxTokens: config.maxTokens ?? 4096,
      timeoutMs: config.timeoutMs ?? 120_000,
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
  }): GeminiRequestBody {
    const { system, rest } = extractSystem(params.messages)
    const contents = toGeminiContents(rest)
    const llmParams = params.llmParams ?? {}
    const toolsDefs = this.toolsGetter().map(toolToGeminiDecl)

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
  }): Promise<ChatCompletionOutput> {
    const model = params.modelId ?? this.config.defaultModel
    const body = this.buildBody({ messages: params.messages, llmParams: params.params })

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
    const timer = setTimeout(
      () => inner.abort(new Error(`Gemini 请求超时（>${this.config.timeoutMs}ms）`)),
      this.config.timeoutMs,
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
            }
          : undefined,
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
  }): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const model = params.modelId ?? this.config.defaultModel
    const body = this.buildBody({ messages: params.messages, llmParams: params.params })

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
    const timer = setTimeout(
      () => inner.abort(new Error(`Gemini stream 超时（>${this.config.timeoutMs}ms）`)),
      this.config.timeoutMs,
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
      let tokenUsage: { input: number; output: number; total?: number } | undefined
      // functionCall 在 stream 中可能跨 chunk，用 id 累积
      const pendingToolCalls: Map<string, { id: string; name: string; args: unknown }> = new Map()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

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

            const candidate = json.candidates?.[0]
            if (!candidate) continue

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

            // usageMetadata 可能在最后一个 chunk
            if (json.usageMetadata) {
              tokenUsage = {
                input: json.usageMetadata.promptTokenCount ?? 0,
                output: json.usageMetadata.candidatesTokenCount ?? 0,
                total: json.usageMetadata.totalTokenCount,
              }
            }
          }
        }
      }

      yield {
        type: 'done',
        model: modelOut ?? model,
        tokenUsage,
      }
    } finally {
      clearTimeout(timer)
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

  const plugin: AgentPlugin & { readonly provider: GeminiChatProvider } = {
    id: 'provider.gemini',
    version: '0.1.0',
    name: 'Gemini Provider',
    description: '对接 Google Gemini Generative Language API 的 Provider 插件',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      const storeCfg = ctx.config.get<GeminiProviderConfig>('provider.gemini')
      const merged: GeminiProviderConfig = { ...(storeCfg ?? {}), ...(config ?? {}) }

      provider = new GeminiChatProvider(merged, () => [])

      ctx.log.info('Gemini Provider 已安装', {
        baseUrl: provider['config'].baseUrl,
        defaultModel: provider['config'].defaultModel,
      })

      return {
        async 'harness.init'(_input, output) {
          const harness = (output as { harness?: unknown }).harness as
            | {
                _setChatProvider?: (p: ChatProvider) => void
                tools?: { list?: () => Tool[] }
              }
            | undefined

          if (!provider) return

          if (harness?._setChatProvider) {
            harness._setChatProvider(provider)
          } else {
            ctx.log.warn('Harness._setChatProvider 未找到，Gemini Provider 可能未注册')
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
