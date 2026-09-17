import { describe, it, expect } from 'bun:test'
import {
  createHarness,
  defineTool,
  type AgentDefinition,
  type AgentStreamEvent,
  type ChatProvider,
  type ChatStreamChunk,
  type Message,
} from './index'

/**
 * S1：循环骨架。
 *
 * 两条不变量：
 * 1. `maxSteps` 缺省为 1 ⇒ 单轮，与改造前逐事件等价（多一个 done.step 字段）；
 * 2. `maxSteps > 1` 时，**工具结果会被回喂**给下一次请求 —— 这正是 agentic loop 的
 *    核心机制，也是 S2 放开步数的前提。这里先证明机制通，S2 再加续轮判据
 *    （finish × toolCalls 取合取）。
 */

const agent: AgentDefinition = {
  id: 'default',
  name: 'loop 测试 Agent',
  description: 'd',
  mode: 'primary',
  tools: ['*'],
  permission: { '*': 'allow' },
  promptFragments: ['You are a test agent.'],
}

const echoTool = defineTool({
  id: 'echo',
  description: '回显 msg',
  inputSchema: {
    parse: (v: unknown) => v as { msg: string },
    safeParse: (v: unknown) => ({ success: true as const, data: v as { msg: string } }),
  },
  isReadOnly: () => true,
  async call(input: { msg: string }) {
    return { ok: true as const, output: { reply: `echo:${input.msg}` } }
  },
})

const toolCallChunks: ChatStreamChunk[] = [
  { type: 'text_delta', text: '先调用工具' },
  { type: 'tool_use_start', toolUseId: 'tu_1', toolId: 'echo' },
  { type: 'tool_use_delta', inputDelta: '{"msg":"hi"}' },
  { type: 'tool_use_stop', toolUseId: 'tu_1' },
  { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' },
]

const finalTextChunks: ChatStreamChunk[] = [
  { type: 'text_delta', text: '工具说：' },
  { type: 'text_delta', text: 'echo:hi' },
  { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop' },
]

/**
 * 剧本 Provider：第 n 次 stream 调用返回第 n 个剧本（越界则重复最后一个），
 * 并把每次收到的 messages 快照交给 onCall，供断言「回喂内容」。
 */
function scriptedProvider(
  script: ChatStreamChunk[][],
  onCall?: (messages: Message[]) => void,
): ChatProvider & { calls: number } {
  const p = {
    id: 'scripted',
    calls: 0,
    async complete() {
      throw new Error('本测试只走流式路径')
    },
    async *stream(params: { messages: Message[] }) {
      onCall?.(JSON.parse(JSON.stringify(params.messages)) as Message[])
      const chunks = script[Math.min(p.calls, script.length - 1)]
      p.calls++
      for (const c of chunks) yield c
    },
  }
  return p
}

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, unknown>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('S1 循环骨架', () => {
  it('maxSteps 缺省为 1：只调一次模型，done 带 step=1', async () => {
    const provider = scriptedProvider([finalTextChunks])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'hi'))
    const dones = events.filter((e) => e.type === 'done')

    expect(provider.calls).toBe(1)
    expect(dones).toHaveLength(1)
    expect(dones[0].step).toBe(1)
    expect(dones[0].finish).toBe('stop')
    await h.stop()
  })

  it('maxSteps=2：第二步的请求里含第一步的 assistant 消息与工具结果（回喂）', async () => {
    const seen: Message[][] = []
    const provider = scriptedProvider([toolCallChunks, finalTextChunks], (m) => seen.push(m))
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 2))
    const dones = events.filter((e) => e.type === 'done')

    // 两步都跑了，done 各带 step
    expect(provider.calls).toBe(2)
    expect(dones.map((d) => d.step)).toEqual([1, 2])

    // 第一次请求：只有 system + user
    const first = seen[0]
    expect(first.some((m) => m.role === 'assistant')).toBe(false)

    // 第二次请求：多了 assistant 消息，且其中的 tool part 已带上执行结果 —— 这就是「回喂」
    const second = seen[1]
    const assistantMsgs = second.filter((m) => m.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)
    const toolParts = assistantMsgs.flatMap((m) => m.parts).filter((p) => p.type === 'tool')
    expect(toolParts.length).toBeGreaterThan(0)
    expect(JSON.stringify(toolParts[0])).toContain('echo:hi')

    // 会话最终留下两条 assistant 消息（每个 step 一条）
    const final = (await h.session.get(sess.id))!
    expect(final.messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
    await h.stop()
  })

  it('每步独立发 done（A 方案）：step 递增，且末步 finish 可判终止', async () => {
    const provider = scriptedProvider([toolCallChunks, finalTextChunks])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 2))
    const dones = events.filter((e) => e.type === 'done')

    // 事件顺序：两个 done 之间夹着第二步的 text_delta（证明 done 不是"全部结束"信号）
    const types = events.map((e) => e.type)
    const lastDone = types.lastIndexOf('done')
    const firstDone = types.indexOf('done')
    expect(firstDone).toBeLessThan(lastDone)
    expect(types.slice(firstDone + 1, lastDone)).toContain('text_delta')

    expect(dones[0].finish).toBe('tool_calls')
    expect(dones[1].finish).toBe('stop')
    await h.stop()
  })
})
