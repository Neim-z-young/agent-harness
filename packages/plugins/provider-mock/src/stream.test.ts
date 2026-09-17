import { describe, it, expect } from 'bun:test'
import { MockChatProvider } from './index'
import type { Message } from '@harness/session'
import type { ChatStreamChunk } from '@harness/core'

function makeMessages(text: string): Message[] {
  return [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }], createdAt: 1 }]
}

describe('MockChatProvider.stream', () => {
  it('基础文本流式输出：多个 text_delta 拼接 = complete 结果', async () => {
    const provider = new MockChatProvider({ defaultResponse: 'Hello world. Foo bar.' })
    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.stream({
      providerId: 'test', messages: makeMessages('hi'), params: {},
    })) {
      chunks.push(chunk)
    }

    // 应有多个 text_delta + 一个 done
    const textDeltas = chunks.filter((c) => c.type === 'text_delta')
    expect(textDeltas.length).toBeGreaterThan(1)
    const reassembled = textDeltas.map((c) => c.text).join('')
    expect(reassembled).toBe('Hello world. Foo bar.')

    const done = chunks.find((c) => c.type === 'done')
    expect(done).toBeDefined()
    expect(done?.model).toBe('mock-v1')
    expect(done?.tokenUsage?.input).toBe(10)
    expect(done?.tokenUsage?.output).toBe(5)
    // 无工具调用 ⇒ 自然结束
    expect(done?.finish).toBe('stop')
  })

  it('reasoning + text + tool_call 流式', async () => {
    const provider = new MockChatProvider({
      responses: [{
        match: '调用工具',
        response: '好的',
        reasoning: '需要调用工具',
        toolCalls: [{ toolUseId: 't1', toolId: 'echo', input: { msg: 'hi' } }],
      }],
    })
    const chunks: ChatStreamChunk[] = []
    for await (const chunk of provider.stream({
      providerId: 'test', messages: makeMessages('请调用工具'), params: {},
    })) {
      chunks.push(chunk)
    }

    // reasoning_delta
    const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning_delta')
    expect(reasoningDeltas.length).toBeGreaterThan(0)
    expect(reasoningDeltas.map((c) => c.text).join('')).toBe('需要调用工具')

    // text_delta
    const textDeltas = chunks.filter((c) => c.type === 'text_delta')
    expect(textDeltas.map((c) => c.text).join('')).toBe('好的')

    // tool_use_start / delta / stop
    const start = chunks.find((c) => c.type === 'tool_use_start')
    expect(start?.toolUseId).toBe('t1')
    expect(start?.toolId).toBe('echo')

    const delta = chunks.find((c) => c.type === 'tool_use_delta')
    expect(delta?.inputDelta).toContain('msg')

    const stop = chunks.find((c) => c.type === 'tool_use_stop')
    expect(stop).toBeDefined()

    // done
    const done = chunks.find((c) => c.type === 'done')
    expect(done).toBeDefined()
    // 有工具调用 ⇒ 因工具调用结束（循环需据此续轮，不能当作终点）
    expect(done?.finish).toBe('tool_calls')
  })

  it('calls 记录与 complete 一致', async () => {
    const provider = new MockChatProvider({ defaultResponse: 'test', recordCalls: true })
    for await (const _ of provider.stream({
      providerId: 'p', messages: makeMessages('hello'), params: { temperature: 0.5 },
    })) { void _ }
    expect(provider.calls.length).toBe(1)
    expect(provider.calls[0].providerId).toBe('p')
    expect(provider.calls[0].params.temperature).toBe(0.5)
  })
})
