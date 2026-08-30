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

import type { ChatProvider, ChatCompletionOutput, ChatStreamChunk } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext, ProviderConfig, ProviderTypeFactory } from '@harness/plugin'
import type { Message, Part } from '@harness/session'
import type { Tool } from '@harness/tool'

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
  /** anthropic-version 头（默认 2023-06-01） */
  apiVersion?: string
  /** 当模型输出空时是否报错误（默认 false 返回空 content） */
  strictEmptyContent?: boolean
}

// ===== Anthropic API 类型（精简子集）=====

type AnthropicTextBlock = { type: 'text'; text: string }
type AnthropicImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}
type AnthropicToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
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
}

type AnthropicRequestBody = {
  model: string
  max_tokens: number
  system?: string
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
  const schema: any = (tool.inputSchema as any).__jsonSchema
  if (schema && typeof schema === 'object') {
    return {
      name: tool.id,
      description: tool.description || tool.id,
      input_schema: {
        type: 'object',
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
  readonly id = 'anthropic'
  readonly calls: Array<{ body: AnthropicRequestBody; response?: AnthropicResponseBody; error?: unknown }> = []

  private readonly config: Required<
    Pick<
      AnthropicProviderConfig,
      'baseUrl' | 'defaultModel' | 'maxTokens' | 'timeoutMs' | 'apiVersion' | 'strictEmptyContent'
    >
  > & { apiKey?: string }

  /** 工具池回调：每次 complete() 时实时取最新工具列表 */
  private toolsGetter: () => Tool[]

  constructor(
    config: AnthropicProviderConfig = {},
    toolsGetter: () => Tool[] = () => []
  ) {
    this.toolsGetter = toolsGetter
    const envKey = typeof process !== 'undefined' ? process.env.ANTHROPIC_API_KEY : undefined
    const envBase = typeof process !== 'undefined' ? process.env.ANTHROPIC_BASE_URL : undefined
    this.config = {
      apiKey: config.apiKey ?? envKey,
      baseUrl: config.baseUrl ?? envBase ?? 'https://api.anthropic.com',
      defaultModel: config.defaultModel ?? 'claude-3-sonnet-20240229',
      maxTokens: config.maxTokens ?? 4096,
      timeoutMs: config.timeoutMs ?? 120_000,
      apiVersion: config.apiVersion ?? '2023-06-01',
      strictEmptyContent: config.strictEmptyContent ?? false,
    }
  }

  /** 动态更新工具池 getter（由 harness.init Hook 在注册完成后调用） */
  setToolsGetter(getter: () => Tool[]): void {
    this.toolsGetter = getter
  }

  /** 动态更新 API Key */
  setApiKey(key: string): void {
    this.config.apiKey = key
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
    const { system, rest } = extractSystemPrompt(params.messages)
    const messages = toAnthropicMessages(rest)

    const model = params.modelId ?? this.config.defaultModel
    const llmParams = params.params ?? {}
    const toolsDefs = this.toolsGetter().map(toolToAnthropicDef)

    const body: AnthropicRequestBody = {
      model,
      max_tokens: this.config.maxTokens,
      messages,
      stream: false,
    }
    if (system) body.system = system
    if (toolsDefs.length > 0) body.tools = toolsDefs
    if (typeof llmParams.temperature === 'number') body.temperature = llmParams.temperature as number
    if (typeof llmParams.top_p === 'number') body.top_p = llmParams.top_p as number
    if (typeof llmParams.top_k === 'number') body.top_k = llmParams.top_k as number
    if (Array.isArray(llmParams.stop_sequences)) body.stop_sequences = llmParams.stop_sequences as string[]

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
    const timer = setTimeout(() => inner.abort(new Error(`Anthropic 请求超时（>${this.config.timeoutMs}ms）`)), this.config.timeoutMs)

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
  }): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const { system, rest } = extractSystemPrompt(params.messages)
    const messages = toAnthropicMessages(rest)

    const model = params.modelId ?? this.config.defaultModel
    const llmParams = params.params ?? {}
    const toolsDefs = this.toolsGetter().map(toolToAnthropicDef)

    const body: AnthropicRequestBody = {
      model,
      max_tokens: this.config.maxTokens,
      messages,
      stream: false, // 会覆盖为 true，见下方 streamBody
    }
    if (system) body.system = system
    if (toolsDefs.length > 0) body.tools = toolsDefs
    if (typeof llmParams.temperature === 'number') body.temperature = llmParams.temperature as number
    if (typeof llmParams.top_p === 'number') body.top_p = llmParams.top_p as number
    if (typeof llmParams.top_k === 'number') body.top_k = llmParams.top_k as number
    if (Array.isArray(llmParams.stop_sequences)) body.stop_sequences = llmParams.stop_sequences as string[]

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
    const timer = setTimeout(() => inner.abort(new Error(`Anthropic stream 超时（>${this.config.timeoutMs}ms）`)), this.config.timeoutMs)

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
      // 当前 content block 的 index → 类型映射
      const blockTypes: Map<number, 'text' | 'tool_use'> = new Map()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
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
                break
              }
              case 'message_stop': {
                break
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

/**
 * 创建 Anthropic Provider 插件
 *
 * @param config Provider 配置（会被 ctx.config.get('provider.anthropic') 和 环境变量覆盖或合并）
 */
export function createProviderAnthropicPlugin(config?: AnthropicProviderConfig): AgentPlugin & {
  readonly provider: AnthropicChatProvider
} {
  let provider: AnthropicChatProvider | undefined

  const plugin: AgentPlugin & { readonly provider: AnthropicChatProvider } = {
    id: 'provider.anthropic',
    version: '0.1.0',
    name: 'Anthropic Provider',
    description: '对接 Anthropic Claude Messages API 的 Provider 插件',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      // 配置来源：直接传入 > config store
      const storeCfg = ctx.config.get<AnthropicProviderConfig>('provider.anthropic')
      const merged: AnthropicProviderConfig = { ...(storeCfg ?? {}), ...(config ?? {}) }

      provider = new AnthropicChatProvider(merged, () => [])

      ctx.log.info('Anthropic Provider 已安装', {
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

          // 注入 ChatProvider
          if (harness?._setChatProvider) {
            harness._setChatProvider(provider)
          } else {
            ctx.log.warn('Harness._setChatProvider 未找到，Anthropic Provider 可能未注册')
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
    }),
}
