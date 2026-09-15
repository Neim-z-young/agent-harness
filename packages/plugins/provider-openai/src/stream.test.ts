import { describe, it, expect, beforeEach } from 'bun:test'
import { OpenAIChatProvider } from './index'
import type { ChatStreamChunk } from '@harness/core'
import type { Message } from '@harness/session'

// ===== Mock SSE stream helper =====

/** 构造 OpenAI SSE 响应体（模拟 text + tool_calls 流式响应） */
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
  const model = options.model ?? 'gpt-4o-mini'
  const inputTokens = options.inputTokens ?? 10
  const outputTokens = options.outputTokens ?? 20

  // 首帧：role + model
  lines.push(`data: ${JSON.stringify({
    id: 'chatcmpl-1', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  })}`)
  lines.push('')

  // 文本增量
  if (options.text) {
    const words = options.text.split(/(\s+)/)
    for (const w of words) {
      if (!w) continue
      lines.push(`data: ${JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion.chunk', model,
        choices: [{ index: 0, delta: { content: w }, finish_reason: null }],
      })}`)
      lines.push('')
    }
  }

  // tool_calls 增量（如果配置）
  if (options.toolUseId && options.toolName) {
    // 首帧：带 id + function.name
    lines.push(`data: ${JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: options.toolUseId,
            type: 'function',
            function: { name: options.toolName, arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    })}`)
    lines.push('')

    // arguments 增量（分 2 段）
    const inputJson = JSON.stringify(options.toolInput ?? {})
    const half = Math.floor(inputJson.length / 2)
    for (const part of [inputJson.slice(0, half), inputJson.slice(half)]) {
      if (!part) continue
      lines.push(`data: ${JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion.chunk', model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: part },
            }],
          },
          finish_reason: null,
        }],
      })}`)
      lines.push('')
    }

    // finish_reason: tool_calls
    lines.push(`data: ${JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })}`)
    lines.push('')
  } else {
    // 纯文本结束
    lines.push(`data: ${JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}`)
    lines.push('')
  }

  // usage（最后一帧，OpenAI 新格式 stream_options.include_usage）
  lines.push(`data: ${JSON.stringify({
    id: 'chatcmpl-1', object: 'chat.completion.chunk', model,
    choices: [],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  })}`)
  lines.push('')

  // 终止符
  lines.push('data: [DONE]')
  lines.push('')

  return lines.join('\n')
}

/** 创建 mock fetch，返回 ReadableStream SSE */
function mockFetchSse(sseText: string, status = 200): any {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText))
      controller.close()
    },
  })
  const mockResp = {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    text: () => Promise.resolve(sseText),
  }
  return () => Promise.resolve(mockResp) as any
}

function makeMessages(text: string): Message[] {
  return [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }], createdAt: 1 }]
}

describe('OpenAIChatProvider.stream', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })

  it('纯文本流式：text_delta 拼接 = 原始文本', async () => {
    const provider = new OpenAIChatProvider({ apiKey: 'test-key' })
    globalThis.fetch = mockFetchSse(buildSseResponse({
      text: 'Hello world from GPT',
      model: 'gpt-4o',
      inputTokens: 15,
      outputTokens: 8,
    }))

    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.stream({
      providerId: 'openai', messages: makeMessages('hi'), params: {},
    })) {
      chunks.push(chunk)
    }

    const textDeltas = chunks.filter((c) => c.type === 'text_delta')
    const reassembled = textDeltas.map((c) => c.text).join('')
    expect(reassembled).toBe('Hello world from GPT')

    const done = chunks.find((c) => c.type === 'done')
    expect(done?.model).toBe('gpt-4o')
    expect(done?.tokenUsage?.input).toBe(15)
    expect(done?.tokenUsage?.output).toBe(8)
    expect(done?.tokenUsage?.total).toBe(23)
  })

  it('文本 + tool_calls 流式', async () => {
    const provider = new OpenAIChatProvider({ apiKey: 'test-key' })
    globalThis.fetch = mockFetchSse(buildSseResponse({
      text: 'Let me check.',
      toolUseId: 'call_abc',
      toolName: 'read_file',
      toolInput: { path: '/tmp/test.txt' },
    }))

    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.stream({
      providerId: 'openai', messages: makeMessages('read file'), params: {},
    })) {
      chunks.push(chunk)
    }

    // text deltas
    const textDeltas = chunks.filter((c) => c.type === 'text_delta')
    expect(textDeltas.map((c) => c.text).join('')).toBe('Let me check.')

    // tool_use_start
    const start = chunks.find((c) => c.type === 'tool_use_start')
    expect(start?.toolUseId).toBe('call_abc')
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
    const provider = new OpenAIChatProvider({ apiKey: 'test-key' })
    globalThis.fetch = mockFetchSse('error', 401)

    expect(async () => {
      for await (const _ of provider.stream({
        providerId: 'openai', messages: makeMessages('hi'), params: {},
      })) { void _ }
    }).toThrow()
  })

  it('无 API Key 抛出错误', async () => {
    const provider = new OpenAIChatProvider({ apiKey: '' })
    expect(async () => {
      for await (const _ of provider.stream({
        providerId: 'openai', messages: makeMessages('hi'), params: {},
      })) { void _ }
    }).toThrow()
  })
})

// ==========================================================================
// 流结束语义 / 超时语义（回归：本地网关发完 [DONE] 不关连接 → 明明有响应却报超时）
// ==========================================================================

/** 可控 SSE 流：可分段推送、可「永不 close」（模拟发完 [DONE] 仍保持连接的网关） */
function mockFetchSseControllable(): {
  fetch: any
  push: (text: string) => void
  close: () => void
  canceled: () => boolean
} {
  const encoder = new TextEncoder()
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { ctrl = controller },
    cancel() { canceled = true },
  })
  return {
    // 忠实模拟 fetch：把 AbortSignal 接到 body 流上（abort → 挂起的 read() 以该 reason 拒绝），
    // 否则「超时」用例里的 reader.read() 会一直挂住，测不出真实行为。
    fetch: ((_url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined
      if (signal) {
        if (signal.aborted) ctrl?.error((signal as AbortSignal).reason)
        else signal.addEventListener('abort', () => ctrl?.error((signal as AbortSignal).reason), { once: true })
      }
      return Promise.resolve({ ok: true, status: 200, body: stream, text: () => Promise.resolve('') }) as any
    }) as any,
    push: (text) => ctrl?.enqueue(encoder.encode(text)),
    close: () => ctrl?.close(),
    canceled: () => canceled,
  }
}

/** 只含一段文本 + [DONE] 的 SSE 片段 */
function sseChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: 'c', object: 'chat.completion.chunk', model: 'hy3',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`
}
const SSE_DONE = 'data: [DONE]\n\n'

describe('OpenAIChatProvider.stream：结束与超时语义', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })

  const collect = async (provider: OpenAIChatProvider) => {
    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.stream({
      providerId: 'openai', messages: makeMessages('hi'), params: {},
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  it('收到 [DONE] 即结束，不等 socket 关闭（回归：不关连接会被空闲超时误判为失败）', async () => {
    const ctl = mockFetchSseControllable()
    globalThis.fetch = ctl.fetch
    // timeoutMs 远大于用例时长：若能正常结束，说明没有依赖「连接关闭」或「计时器兜底」
    const provider = new OpenAIChatProvider({ apiKey: 'k', timeoutMs: 5_000 })

    const promise = collect(provider)
    ctl.push(sseChunk('你好'))
    ctl.push(sseChunk('，世界'))
    ctl.push(SSE_DONE)
    // 注意：故意不调用 ctl.close() —— 连接一直开着
    const chunks = await promise

    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join('')).toBe('你好，世界')
    expect(chunks.find((c) => c.type === 'done')).toBeDefined()
    expect(ctl.canceled()).toBe(true) // 提前 break 后主动释放连接
    globalThis.fetch = originalFetch
  })

  it('持续有数据时总时长超过 timeoutMs 也不超时（idle 语义，而非总时长语义）', async () => {
    const ctl = mockFetchSseControllable()
    globalThis.fetch = ctl.fetch
    const provider = new OpenAIChatProvider({ apiKey: 'k', timeoutMs: 60 })

    const promise = collect(provider)
    // 5 段 × 每段间隔 25ms ≈ 125ms > timeoutMs(60)；单段间隔却始终 < 60
    for (const piece of ['长', '回', '答', '不', '掐']) {
      ctl.push(sseChunk(piece))
      await new Promise((r) => setTimeout(r, 25))
    }
    ctl.push(SSE_DONE)
    const chunks = await promise

    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join('')).toBe('长回答不掐')
    expect(chunks.find((c) => c.type === 'done')).toBeDefined()
    globalThis.fetch = originalFetch
  })

  it('真正卡死（一直无数据）仍会超时，且报「空闲超时」', async () => {
    const ctl = mockFetchSseControllable()
    globalThis.fetch = ctl.fetch
    const provider = new OpenAIChatProvider({ apiKey: 'k', timeoutMs: 40 })

    // 一个字节都不推 → 空闲计时器应触发
    const err = await collect(provider).then(() => undefined, (e: Error) => e.message)
    expect(err).toInclude('空闲超时')
    expect(err).toInclude('40ms')
    globalThis.fetch = originalFetch
  })
})
