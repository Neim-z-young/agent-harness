import { describe, it, expect } from 'bun:test'
import {
  createHarness,
  type AgentDefinition,
  type AgentStreamEvent,
  type ChatCompletionOutput,
  type ChatProvider,
  type ChatStreamChunk,
} from './index'

/**
 * finish reason 的**端到端透传**：Provider 原生值 → core.queryStream 的 done 事件。
 *
 * 单测 `finish-reason.test.ts` 只验证映射函数本身；这里验证接线——映射后的值真的
 * 走到了事件里，且 Provider 未提供时**不会**被伪造成 'stop'（那会让上层循环误判终点）。
 * 两条路径都要覆盖：流式（provider.stream）与非流式 fallback（provider.complete）。
 */

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'default',
    name: '默认 Agent',
    description: 'finish 透传测试用',
    mode: 'primary',
    tools: ['*'],
    permission: { '*': 'allow' },
    promptFragments: ['You are a helpful test assistant.'],
    ...overrides,
  }
}

/** 只实现 stream 的 Provider（走流式路径） */
function streamingProvider(chunks: ChatStreamChunk[]): ChatProvider {
  return {
    id: 'mock-stream',
    async complete() {
      throw new Error('本测试不应走到 complete()')
    },
    async *stream() {
      for (const c of chunks) yield c
    },
  }
}

/** 只实现 complete 的 Provider（走非流式 fallback 路径） */
function completingProvider(output: ChatCompletionOutput): ChatProvider {
  return {
    id: 'mock-complete',
    async complete() {
      return output
    },
  }
}

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, unknown>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('finish reason 透传（core.queryStream）', () => {
  it('流式路径：done 的 finish 原样带到 AgentStreamEvent', async () => {
    const h = await createHarness({
      agents: [makeAgent()],
      chatProvider: streamingProvider([
        { type: 'text_delta', text: '好的' },
        { type: 'done', model: 'm', finish: 'stop', finishRaw: 'end_turn' },
      ]),
    })
    const sess = await h.session.create()
    const events = await collect(h.session.promptStream(sess.id, 'hi'))
    const done = events.find((e) => e.type === 'done')
    expect(done?.finish).toBe('stop')
    expect(done?.finishRaw).toBe('end_turn')
    await h.stop()
  })

  it('流式路径：tool_calls 不会被降级成 stop', async () => {
    const h = await createHarness({
      agents: [makeAgent()],
      chatProvider: streamingProvider([
        { type: 'tool_use_start', toolUseId: 'tu_1', toolId: 'echo' },
        { type: 'tool_use_delta', inputDelta: '{"msg":"hi"}' },
        { type: 'tool_use_stop', toolUseId: 'tu_1' },
        { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' },
      ]),
    })
    const sess = await h.session.create()
    const events = await collect(h.session.promptStream(sess.id, 'go'))
    const done = events.find((e) => e.type === 'done')
    expect(done?.finish).toBe('tool_calls')
    // 工具确实被尝试执行了（id 不存在 ⇒ isError），工具结果在 done 之前已发
    expect(events.some((e) => e.type === 'tool_call_result')).toBe(true)
    await h.stop()
  })

  it('非流式 fallback：complete 的 finish 同样透传', async () => {
    const h = await createHarness({
      agents: [makeAgent()],
      chatProvider: completingProvider({
        content: 'ok',
        model: 'm',
        tokenUsage: { input: 1, output: 1 },
        finish: 'length',
        finishRaw: 'max_tokens',
      }),
    })
    const sess = await h.session.create()
    const events = await collect(h.session.promptStream(sess.id, 'hi'))
    const done = events.find((e) => e.type === 'done')
    expect(done?.finish).toBe('length')
    expect(done?.finishRaw).toBe('max_tokens')
    await h.stop()
  })

  it('Provider 未提供 finish ⇒ 事件里没有该字段（不伪造成 stop）', async () => {
    const h = await createHarness({
      agents: [makeAgent()],
      chatProvider: streamingProvider([
        { type: 'text_delta', text: 'ok' },
        { type: 'done', model: 'm' },
      ]),
    })
    const sess = await h.session.create()
    const events = await collect(h.session.promptStream(sess.id, 'hi'))
    const done = events.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    expect(done?.finish).toBeUndefined()
    expect(done?.finishRaw).toBeUndefined()
    await h.stop()
  })
})
