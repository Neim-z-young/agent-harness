/**
 * @harness/provider-openai - OpenAI Chat Completions Provider 插件
 *
 * 功能：
 * - 实现 OpenAI Chat Completions API 对接（非流式 + 流式）
 * - Session Message → OpenAI Chat Message 序列化
 *   - system role → role: 'system' 消息（保留在 messages 数组里）
 *   - user → user 消息；assistant → assistant 消息
 *   - TextPart → content string
 *   - ToolCallPart (assistant 里的调用) → assistant.tool_calls 数组
 *   - ToolCallPart (带 result 的，放在 user/tool role) → role: 'tool' 消息（带 tool_call_id）
 *   - ReasoningPart → assistant: content text（OpenAI 暂无 thinking block，降级为文本）
 *   - FilePart / ImagePart（base64 → image_url with data: URI；其他 → text 描述）
 *   - PatchPart → text 兜底描述
 * - Tool 定义 → tools 数组（type: 'function', function: { name, description, parameters }）
 * - 响应解析：assistant message.content + tool_calls → ChatCompletionOutput
 * - 可配置：apiKey / baseUrl / defaultModel / maxTokens / timeoutMs
 *
 * 配置来源（优先级从高到低）：
 * 1. createProviderOpenAIPlugin({ ... }) 直接传入配置
 * 2. ctx.config.get('provider.openai')
 * 3. 环境变量 OPENAI_API_KEY / OPENAI_BASE_URL
 */

import type { ChatProvider, ChatCompletionOutput, ChatStreamChunk } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext, ProviderConfig, ProviderTypeFactory } from '@harness/plugin'
import type { Message, Part } from '@harness/session'
import type { Tool } from '@harness/tool'

// ===== 配置 =====

export interface OpenAIProviderConfig {
  /** API Key（默认读 OPENAI_API_KEY 环境变量） */
  apiKey?: string
  /** API 根路径（默认 https://api.openai.com，可指向 Azure / 本地代理） */
  baseUrl?: string
  /** API 路径（默认 /v1/chat/completions；智谱等兼容 API 可改为 /chat/completions） */
  apiPath?: string
  /** 默认模型（默认 gpt-4o-mini） */
  defaultModel?: string
  /** max_tokens 默认值（默认 4096） */
  maxTokens?: number
  /** 请求超时（ms，默认 120_000） */
  timeoutMs?: number
  /** 组织 ID（可选，X-OpenAI-Organization 头） */
  organization?: string
  /** 当模型输出空时是否报错（默认 false 返回空 content） */
  strictEmptyContent?: boolean
  /** Provider ID（默认 'openai'；子类可覆盖如 'qwen' / 'glm'） */
  providerId?: string
}

// ===== OpenAI API 类型（精简子集）=====

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{
    type: 'text' | 'image_url'
    text?: string
    image_url?: { url: string; detail?: 'auto' | 'low' | 'high' }
  }>
  name?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

type OpenAIToolDef = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
  }
}

type OpenAIRequestBody = {
  model: string
  messages: OpenAIChatMessage[]
  tools?: OpenAIToolDef[]
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
  stream?: boolean
}

type OpenAIUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

type OpenAIChoice = {
  index: number
  message: {
    role: 'assistant'
    content: string | null
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
  }
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string
}

type OpenAIResponseBody = {
  id: string
  object: string
  model: string
  choices: OpenAIChoice[]
  usage: OpenAIUsage
  error?: { message: string; type: string; code?: string }
}

// ===== Part 序列化工具 =====

/** 把单条 Harness Message 转成 OpenAI Chat Message（可能产生多条：assistant tool_calls + 后续 tool results） */
function toOpenAIMessages(messages: Message[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'system') {
      // system：合并所有 text part 为 content string
      const sysText = msg.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('\n\n')
      if (sysText) out.push({ role: 'system', content: sysText })
      continue
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: NonNullable<OpenAIChatMessage['tool_calls']> = []
      const imageParts: Array<{ url: string }> = []

      for (const p of msg.parts) {
        const part = p as Part
        switch (part.type) {
          case 'text':
            textParts.push((part as { text: string }).text)
            break
          case 'tool': {
            const tp = part as any
            // assistant 内的 tool part → tool_calls（无 result 时）
            if (tp.result === undefined) {
              toolCalls.push({
                id: tp.toolUseId ?? `call_${Math.random().toString(36).slice(2, 10)}`,
                type: 'function',
                function: {
                  name: tp.toolId,
                  arguments: JSON.stringify(tp.input ?? {}),
                },
              })
            }
            break
          }
          case 'reasoning':
            textParts.push(`[thinking]\n${(part as any).text ?? ''}`)
            break
          case 'image': {
            const ip = part as any
            const mime = ip.mimeType ?? 'image/png'
            if (ip.content) {
              imageParts.push({ url: `data:${mime};base64,${ip.content}` })
            }
            break
          }
          case 'file': {
            const fp = part as any
            const mime = fp.mimeType ?? 'application/octet-stream'
            if (fp.content && mime.startsWith('image/')) {
              imageParts.push({ url: `data:${mime};base64,${fp.content}` })
            } else {
              textParts.push(`[File: ${fp.path ?? 'inline'} mime=${mime}]`)
            }
            break
          }
          case 'patch':
            textParts.push(`[Patch: ${(part as any).path ?? 'unknown'}]\n${(part as any).patch ?? ''}`)
            break
          default:
            textParts.push(JSON.stringify(part))
            break
        }
      }

      const assistantMsg: OpenAIChatMessage = {
        role: 'assistant',
        content: textParts.join('\n') || '',
      }
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      // 注意：OpenAI assistant 消息即使有 tool_calls 也可以有 content（可空）
      out.push(assistantMsg)
      continue
    }

    // user 或 tool role
    if (msg.role === 'tool') {
      // tool role：每条消息对应一个 tool_call_id
      for (const p of msg.parts) {
        if (p.type === 'tool') {
          const tp = p as any
          let contentStr: string
          try {
            contentStr = typeof tp.result === 'string' ? tp.result : JSON.stringify(tp.result)
          } catch {
            contentStr = String(tp.result)
          }
          out.push({
            role: 'tool',
            content: contentStr,
            tool_call_id: tp.toolUseId,
          })
        }
      }
      continue
    }

    // user role
    const textParts: string[] = []
    const imageParts: Array<{ url: string }> = []
    const toolResults: Array<{ toolUseId: string; result: unknown; isError?: boolean }> = []

    for (const p of msg.parts) {
      const part = p as Part
      switch (part.type) {
        case 'text':
          textParts.push((part as { text: string }).text)
          break
        case 'tool': {
          const tp = part as any
          if (tp.result !== undefined) {
            toolResults.push({ toolUseId: tp.toolUseId, result: tp.result, isError: !!tp.isError })
          }
          break
        }
        case 'image': {
          const ip = part as any
          const mime = ip.mimeType ?? 'image/png'
          if (ip.content) imageParts.push({ url: `data:${mime};base64,${ip.content}` })
          break
        }
        case 'file': {
          const fp = part as any
          const mime = fp.mimeType ?? 'application/octet-stream'
          if (fp.content && mime.startsWith('image/')) {
            imageParts.push({ url: `data:${mime};base64,${fp.content}` })
          } else {
            textParts.push(`[File: ${fp.path ?? 'inline'} mime=${mime}]`)
          }
          break
        }
        case 'reasoning':
          textParts.push(`[thinking]\n${(part as any).text ?? ''}`)
          break
        case 'patch':
          textParts.push(`[Patch: ${(part as any).path ?? 'unknown'}]\n${(part as any).patch ?? ''}`)
          break
        default:
          textParts.push(JSON.stringify(part))
          break
      }
    }

    // OpenAI：tool 结果必须用 role: 'tool' 消息（且需对应 assistant 的 tool_calls）
    // 把 user 消息里带 result 的 tool part 拆出来作为 role: 'tool' 消息
    for (const tr of toolResults) {
      let contentStr: string
      try {
        contentStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)
      } catch {
        contentStr = String(tr.result)
      }
      out.push({
        role: 'tool',
        content: contentStr,
        tool_call_id: tr.toolUseId,
      })
    }

    // 如果 user 消息还有 text / image 内容，push 为 user 消息
    if (textParts.length > 0 || imageParts.length > 0) {
      if (imageParts.length > 0) {
        const contentArr: OpenAIChatMessage['content'] = []
        if (textParts.length > 0) contentArr.push({ type: 'text', text: textParts.join('\n') })
        for (const img of imageParts) contentArr.push({ type: 'image_url', image_url: img })
        out.push({ role: 'user', content: contentArr as any })
      } else {
        out.push({ role: 'user', content: textParts.join('\n') })
      }
    }
  }
  return out
}

// ===== Tool Schema 导出 =====

/** 合并 tool.documentation 到 description，让 LLM 获得完整使用指引 */
function fullDescription(tool: Tool): string {
  const base = tool.description || tool.id
  return tool.documentation ? `${base}\n\n${tool.documentation}` : base
}

function toolToOpenAIDef(tool: Tool): OpenAIToolDef {
  const schema: any = (tool.inputSchema as any).__jsonSchema
  if (schema && typeof schema === 'object') {
    return {
      type: 'function',
      function: {
        name: tool.id,
        description: fullDescription(tool),
        parameters: {
          type: 'object',
          properties: schema.properties ?? {},
          required: Array.isArray(schema.required) ? schema.required : undefined,
          additionalProperties: schema.additionalProperties ?? true,
        },
      },
    }
  }
  // 兜底：宽松对象 schema
  return {
    type: 'function',
    function: {
      name: tool.id,
      description: fullDescription(tool),
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    },
  }
}

// ========================================================================
// OpenAIChatProvider
// ========================================================================

export class OpenAIChatProvider implements ChatProvider {
  readonly id: string
  readonly calls: Array<{ body: OpenAIRequestBody; response?: OpenAIResponseBody; error?: unknown }> = []

  private readonly config: Required<
    Pick<OpenAIProviderConfig, 'baseUrl' | 'apiPath' | 'defaultModel' | 'maxTokens' | 'timeoutMs' | 'strictEmptyContent' | 'providerId'>
  > & { apiKey?: string; organization?: string }

  private toolsGetter: () => Tool[]

  constructor(
    config: OpenAIProviderConfig = {},
    toolsGetter: () => Tool[] = () => []
  ) {
    this.toolsGetter = toolsGetter
    const envKey = typeof process !== 'undefined' ? process.env.OPENAI_API_KEY : undefined
    const envBase = typeof process !== 'undefined' ? process.env.OPENAI_BASE_URL : undefined
    this.config = {
      apiKey: config.apiKey ?? envKey,
      baseUrl: config.baseUrl ?? envBase ?? 'https://api.openai.com',
      apiPath: config.apiPath ?? '/v1/chat/completions',
      defaultModel: config.defaultModel ?? 'gpt-4o-mini',
      maxTokens: config.maxTokens ?? 4096,
      timeoutMs: config.timeoutMs ?? 120_000,
      organization: config.organization,
      strictEmptyContent: config.strictEmptyContent ?? false,
      providerId: config.providerId ?? 'openai',
    }
    this.id = this.config.providerId
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
      'Authorization': `Bearer ${this.config.apiKey ?? ''}`,
    }
    if (this.config.organization) headers['OpenAI-Organization'] = this.config.organization
    return { ...headers, ...(extra ?? {}) }
  }

  private buildBody(params: {
    modelId?: string
    messages: Message[]
    llmParams: Record<string, unknown>
    stream?: boolean
  }): OpenAIRequestBody {
    const messages = toOpenAIMessages(params.messages)
    const model = params.modelId ?? this.config.defaultModel
    const llmParams = params.llmParams ?? {}
    const toolsDefs = this.toolsGetter().map(toolToOpenAIDef)

    const body: OpenAIRequestBody = {
      model,
      messages,
      max_tokens: this.config.maxTokens,
    }
    if (toolsDefs.length > 0) {
      body.tools = toolsDefs
      body.tool_choice = 'auto'
    }
    if (typeof llmParams.temperature === 'number') body.temperature = llmParams.temperature as number
    if (typeof llmParams.top_p === 'number') body.top_p = llmParams.top_p as number
    if (typeof llmParams.max_tokens === 'number') body.max_tokens = llmParams.max_tokens as number
    if (typeof llmParams.maxTokens === 'number') body.max_tokens = llmParams.maxTokens as number
    if (Array.isArray(llmParams.stop)) body.stop = llmParams.stop as string[]
    else if (typeof llmParams.stop === 'string') body.stop = llmParams.stop
    if (typeof llmParams.tool_choice === 'string') body.tool_choice = llmParams.tool_choice as any
    if (params.stream) body.stream = true
    return body
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
    const body = this.buildBody({
      modelId: params.modelId,
      messages: params.messages,
      llmParams: params.params,
      stream: false,
    })

    const record = { body, response: undefined as OpenAIResponseBody | undefined, error: undefined as unknown }
    this.calls.push(record)

    const inner = new AbortController()
    const outerSignal = params.signal
    const onOuter = () => inner.abort()
    if (outerSignal) {
      if (outerSignal.aborted) inner.abort()
      else outerSignal.addEventListener('abort', onOuter, { once: true })
    }
    const timer = setTimeout(() => inner.abort(new Error(`OpenAI 请求超时（>${this.config.timeoutMs}ms）`)), this.config.timeoutMs)

    try {
      if (!this.config.apiKey) {
        throw new Error('OpenAI API Key 未配置，请设置 OPENAI_API_KEY 环境变量或在 config 中传入 apiKey')
      }
      if (body.messages.length === 0) {
        body.messages = [{ role: 'user', content: '(no history)' }]
      }

      const headers = this.buildHeaders(params.headers)
      const url = `${this.config.baseUrl.replace(/\/$/, '')}${this.config.apiPath}`
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: inner.signal,
      })

      const text = await resp.text()
      let parsed: OpenAIResponseBody
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`OpenAI 响应不是 JSON (HTTP ${resp.status})：${text.slice(0, 500)}`)
      }
      record.response = parsed

      if (!resp.ok || parsed.error) {
        const msg = parsed.error?.message ?? `HTTP ${resp.status}: ${text.slice(0, 500)}`
        throw new Error(`OpenAI API 错误：${msg}`)
      }

      const choice = parsed.choices?.[0]
      if (!choice) throw new Error('OpenAI 响应无 choices')

      const textParts: string[] = []
      const toolCalls: Array<{ toolUseId: string; toolId: string; input: unknown }> = []

      if (choice.message.content) textParts.push(choice.message.content)
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          let input: unknown
          try {
            input = JSON.parse(tc.function.arguments || '{}')
          } catch {
            input = tc.function.arguments
          }
          toolCalls.push({
            toolUseId: tc.id,
            toolId: tc.function.name,
            input,
          })
        }
      }

      if (this.config.strictEmptyContent && textParts.length === 0 && toolCalls.length === 0) {
        throw new Error('OpenAI 响应内容为空')
      }

      return {
        content: textParts.join('\n'),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model: parsed.model,
        tokenUsage: {
          input: parsed.usage.prompt_tokens,
          output: parsed.usage.completion_tokens,
          total: parsed.usage.total_tokens,
          ...(parsed.usage.prompt_tokens_details?.cached_tokens != null ? { cacheRead: parsed.usage.prompt_tokens_details.cached_tokens } : {}),
        },
        raw: parsed,
      }
    } finally {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onOuter)
    }
  }

  // -------- ChatProvider.stream --------

  /**
   * 流式调用 OpenAI Chat Completions（stream: true），解析 SSE 逐 chunk yield。
   *
   * OpenAI SSE 格式：
   *   data: {"choices":[{"delta":{"content":"...","tool_calls":[...]}}]}
   *   ...
   *   data: [DONE]
   *
   * tool_calls 增量格式（按 index 累积）：
   *   首帧 → { index, id, type:'function', function:{ name, arguments:'' } }
   *   后续 → { index, function:{ arguments: '部分 JSON' } }
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
    const body = this.buildBody({
      modelId: params.modelId,
      messages: params.messages,
      llmParams: params.params,
      stream: true,
    })

    if (!this.config.apiKey) {
      throw new Error('OpenAI API Key 未配置，请设置 OPENAI_API_KEY 环境变量或在 config 中传入 apiKey')
    }
    if (body.messages.length === 0) {
      body.messages = [{ role: 'user', content: '(no history)' }]
    }

    const headers = this.buildHeaders({ ...params.headers, Accept: 'text/event-stream' })

    const inner = new AbortController()
    const outerSignal = params.signal
    const onOuter = () => inner.abort()
    if (outerSignal) {
      if (outerSignal.aborted) inner.abort()
      else outerSignal.addEventListener('abort', onOuter, { once: true })
    }
    const timer = setTimeout(() => inner.abort(new Error(`OpenAI stream 超时（>${this.config.timeoutMs}ms）`)), this.config.timeoutMs)

    try {
      const url = `${this.config.baseUrl.replace(/\/$/, '')}${this.config.apiPath}`
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
        throw new Error(`OpenAI stream 错误：${msg}`)
      }

      const reader = resp.body?.getReader()
      if (!reader) throw new Error('Response body 不可读（stream not supported）')

      const decoder = new TextDecoder()
      let buf = ''
      let modelOut: string | undefined
      let tokenUsage: { input: number; output: number; total?: number; cacheRead?: number } | undefined

      // tool_calls 增量累积状态：index → { id?, name?, argsBuf }
      const toolCallState: Map<number, { id?: string; name?: string; argsBuf: string; started: boolean }> = new Map()

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
            if (data === '[DONE]') {
              // 收尾：所有未 stop 的 tool_call 发 tool_use_stop
              for (const [idx, state] of toolCallState) {
                if (state.started) {
                  yield { type: 'tool_use_stop', toolUseId: state.id }
                  toolCallState.delete(idx)
                }
              }
              continue
            }

            let json: any
            try {
              json = JSON.parse(data)
            } catch {
              continue
            }

            if (json.model) modelOut = json.model
            if (json.usage) {
              tokenUsage = {
                input: json.usage.prompt_tokens ?? 0,
                output: json.usage.completion_tokens ?? 0,
                total: json.usage.total_tokens,
                ...(json.usage.prompt_tokens_details?.cached_tokens != null ? { cacheRead: json.usage.prompt_tokens_details.cached_tokens } : {}),
              }
            }

            const choice = json.choices?.[0]
            if (!choice) continue
            const delta = choice.delta
            if (!delta) continue

            // 文本增量
            if (typeof delta.content === 'string' && delta.content) {
              yield { type: 'text_delta', text: delta.content }
            }

            // tool_calls 增量
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx: number = tc.index ?? 0
                let state = toolCallState.get(idx)
                if (!state) {
                  state = { argsBuf: '', started: false }
                  toolCallState.set(idx, state)
                }

                // 首帧：带 id + function.name
                if (tc.id || (tc.function?.name && !state.started)) {
                  state.id = tc.id ?? state.id
                  state.name = tc.function?.name ?? state.name
                  state.started = true
                  yield {
                    type: 'tool_use_start',
                    toolUseId: state.id!,
                    toolId: state.name!,
                  }
                }

                // 后续：function.arguments 增量
                if (tc.function?.arguments) {
                  state.argsBuf += tc.function.arguments
                  yield { type: 'tool_use_delta', inputDelta: tc.function.arguments }
                }
              }
            }

            // finish_reason: tool_calls → 发 tool_use_stop
            if (choice.finish_reason === 'tool_calls') {
              for (const [idx, state] of toolCallState) {
                if (state.started) {
                  yield { type: 'tool_use_stop', toolUseId: state.id }
                  toolCallState.delete(idx)
                }
              }
            }
          }
        }
      }

      // 兜底：流结束时还有未 stop 的 tool_call
      for (const [idx, state] of toolCallState) {
        if (state.started) {
          yield { type: 'tool_use_stop', toolUseId: state.id }
          toolCallState.delete(idx)
        }
      }

      yield {
        type: 'done',
        model: modelOut ?? (params.modelId ?? this.config.defaultModel),
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

export function createProviderOpenAIPlugin(config?: OpenAIProviderConfig): AgentPlugin & {
  readonly provider: OpenAIChatProvider
} {
  let provider: OpenAIChatProvider | undefined

  // 插件 id 随 providerId 派生，使多个 OpenAI 兼容端点（openai/deepseek/ollama/glm/qwen…）
  // 可在同一进程内各自注册而不冲突（PluginDuplicateIdError）。
  const providerId = config?.providerId ?? 'openai'
  const pluginId = `provider.${providerId}`

  const plugin: AgentPlugin & { readonly provider: OpenAIChatProvider } = {
    id: pluginId,
    version: '0.1.0',
    name: 'OpenAI Provider',
    description: '对接 OpenAI Chat Completions API 的 Provider 插件',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      const storeCfg = ctx.config.get<OpenAIProviderConfig>(pluginId)
      const merged: OpenAIProviderConfig = { ...(storeCfg ?? {}), ...(config ?? {}) }

      provider = new OpenAIChatProvider(merged, () => [])

      ctx.log.info('OpenAI Provider 已安装', {
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
            ctx.log.warn('Harness._setChatProvider 未找到，OpenAI Provider 可能未注册')
          }

          provider.setToolsGetter(() => harness?.tools?.list?.() ?? [])
        },
      }
    },

    async uninstall() {
      provider = undefined
    },

    get provider(): OpenAIChatProvider {
      if (!provider) throw new Error('OpenAIChatProvider 未创建 — plugin.install() 未执行')
      return provider
    },
  }

  return plugin
}

/** 默认导出：无配置常量（配置来自 config store 与环境变量） */
export const providerOpenAIPlugin: AgentPlugin & { readonly provider: OpenAIChatProvider } =
  createProviderOpenAIPlugin()

// ========================================================================
// Provider 类型工厂（抽象层契约：@harness/plugin → ProviderTypeFactory）
// 上层（core/cli）只经 ProviderTypeRegistry 按 type 解析，不感知本模块具体配置结构。
// ========================================================================

export const providerTypeFactory: ProviderTypeFactory = {
  type: 'openai',
  createPlugin: (config: ProviderConfig): AgentPlugin =>
    createProviderOpenAIPlugin({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      defaultModel: config.model,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      apiPath: config.apiPath,
      providerId: config.id,
    }),
}
