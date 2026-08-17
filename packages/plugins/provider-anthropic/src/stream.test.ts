import { describe, it, expect, beforeEach } from 'bun:test'
import { AnthropicChatProvider } from './index'
import type { ChatStreamChunk } from '@harness/core'
import type { Message } from '@harness/session'

// ===== Mock SSE stream helper =====

/** 构造 Anthropic SSE 响应体（模拟 text + tool_use 流式响应） */
function buildSseResponse(options: {
  text?: string
  toolUseId?: string
  toolName?: string
  toolInput?: object
  model?: string
  inputTokens?: number
  outputTokens?: number
}): string {
  const lines: string[] = []
  const model = options.model ?? 'claude-3-sonnet-20240229'
  const inputTokens = options.inputTokens ?? 10
  const outputTokens = options.outputTokens ?? 20

  // message_start
  lines.push('event: message_start')
  lines.push(`data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant',
      model, content: [], stop_reason: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })}`)
  lines.push('')

  // content_block_start (text)
  lines.push('event: content_block_start')
  lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`)
  lines.push('')

  // text deltas
  if (options.text) {
    const words = options.text.split(/(\s+)/)
    for (const w of words) {
      if (!w) continue
      lines.push('event: content_block_delta')
      lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } })}`)
      lines.push('')
    }
  }

  // content_block_stop (text)
  lines.push('event: content_block_stop')
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`)
  lines.push('')

  // tool_use block (if configured)
  if (options.toolUseId && options.toolName) {
    const toolIndex = 1
    lines.push('event: content_block_start')
    lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id: options.toolUseId, name: options.toolName, input: {} } })}`)
    lines.push('')

    // input_json_delta
    const inputJson = JSON.stringify(options.toolInput ?? {})
    // 分成 2 段
    const half = Math.floor(inputJson.length / 2)
    for (const part of [inputJson.slice(0, half), inputJson.slice(half)]) {
      lines.push('event: content_block_delta')
      lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: part } })}`)
      lines.push('')
    }

    lines.push('event: content_block_stop')
    lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: toolIndex })}`)
    lines.push('')
  }

  // message_delta
  lines.push('event: message_delta')
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: options.toolUseId ? 'tool_use' : 'end_turn' }, usage: { output_tokens: outputTokens } })}`)
  lines.push('')

  // message_stop
  lines.push('event: message_stop')
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}`)
  lines.push('')

  return lines.join('\n')
}

/** 创建 mock fetch，返回 ReadableStream SSE */
function mockFetchSse(sseText: string, status = 200): typeof fetch {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText))
      controller.close()
    },
  })
  return ((() => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    text: () => Promise.resolve(sseText),
  }) as any)) as typeof fetch
}

function makeMessages(text: string): Message[] {
  return [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }], createdAt: 1 }]
}

describe('AnthropicChatProvider.stream', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })

  it('纯文本流式：text_delta 拼接 = 原始文本', async () => {
    const provider = new AnthropicChatProvider({ apiKey: 'test-key' })
    globalThis.fetch = mockFetchSse(buildSseResponse({
      text: 'Hello world from Claude',
      model: 'claude-3-sonnet',
      inputTokens: 15,
      outputTokens: 8,
    }))

    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.stream({
      providerId: 'anthropic', messages: makeMessages('hi'), params: {},
    })) {
      chunks.push(chunk)
    }

    const textDeltas = chunks.filter((c) => c.type === 'text_delta')
    const reassembled = textDeltas.map((c) => c.text).join('')
    expect(reassembled).toBe('Hello world from Claude')

    const done = chunks.find((c) => c.type === 'done')
    expect(done?.model).toBe('claude-3-sonnet')
    expect(done?.tokenUsage?.input).toBe(15)
    expect(done?.tokenUsage?.output).toBe(8)
    expect(done?.tokenUsage?.total).toBe(23)
  })

  it('文本 + tool_use 流式', async () => {
    const provider = new AnthropicChatProvider({ apiKey: 'test-key' })
    globalThis.fetch = mockFetchSse(buildSseResponse({
      text: 'Let me check.',
      toolUseId: 'tool_abc',
      toolName: 'read_file',
      toolInput: { path: '/tmp/test.txt' },
    }))

    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.stream({
      providerId: 'anthropic', messages: makeMessages('read file'), params: {},
    })) {
      chunks.push(chunk)
    }

    // text deltas
    const textDeltas = chunks.filter((c) => c.type === 'text_delta')
    expect(textDeltas.map((c) => c.text).join('')).toBe('Let me check.')

    // tool_use_start
    const start = chunks.find((c) => c.type === 'tool_use_start')
    expect(start?.toolUseId).toBe('tool_abc')
    expect(start?.toolId).toBe('read_file')

    // tool_use_delta（2 段）
    const deltas = chunks.filter((c) => c.type === 'tool_use_delta')
    expect(deltas.length).toBe(2)
    const reassembledInput = deltas.map((c) => c.inputDelta).join('')
    expect(JSON.parse(reassembledInput)).toEqual({ path: '/tmp/test.txt' })

    // tool_use_stop
    const stop = chunks.find((c) => c.type === 'tool_use_stop')
    expect(stop).toBeDefined()
  })

  it('HTTP 错误抛出异常', async () => {
    const provider = new AnthropicChatProvider({ apiKey: 'test-key' })
    globalThis.fetch = mockFetchSse('error', 401)

    expect(async () => {
      for await (const _ of provider.stream({
        providerId: 'anthropic', messages: makeMessages('hi'), params: {},
      })) { void _ }
    }).toThrow()
  })

  it('无 API Key 抛出错误', async () => {
    const provider = new AnthropicChatProvider({ apiKey: '' })
    expect(async () => {
      for await (const _ of provider.stream({
        providerId: 'anthropic', messages: makeMessages('hi'), params: {},
      })) { void _ }
    }).toThrow()
  })
})
