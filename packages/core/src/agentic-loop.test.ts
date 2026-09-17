import { describe, it, expect } from 'bun:test'
import {
  createHarness,
  defineTool,
  DefaultPermissionEngine,
  isDoomLoop,
  DOOM_LOOP_THRESHOLD,
  DEFAULT_MAX_STEPS,
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
  it('缺省步数（30）下若模型不给工具调用 ⇒ 只调一次模型，done 带 step=1', async () => {
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

// ============================================================================
// S2：续轮判据 + 保护（doom-loop / 步数到顶）
// ============================================================================

/** 「调用 echo」剧本；`idx` 用于制造不同入参（避免 doom-loop 干扰无关用例） */
function toolCallScript(idx: number | string, finish?: 'stop' | 'tool_calls' | 'length'): ChatStreamChunk[] {
  return [
    { type: 'tool_use_start', toolUseId: `tu_${idx}`, toolId: 'echo' },
    { type: 'tool_use_delta', inputDelta: JSON.stringify({ msg: String(idx) }) },
    { type: 'tool_use_stop', toolUseId: `tu_${idx}` },
    { type: 'done', model: 'm', finish: finish ?? 'tool_calls' },
  ]
}

function textScript(text: string): ChatStreamChunk[] {
  return [{ type: 'text_delta', text }, { type: 'done', model: 'm', finish: 'stop' }]
}

/** ask 一律放行的权限引擎（用于验证「用户允许时不误伤」） */
class AllowAskEngine extends DefaultPermissionEngine {
  override async ask() {
    return { behavior: 'allow' as const }
  }
}

describe('S2 续轮判据与保护', () => {
  it('连续多步工具链：自主跑完并以文本收尾', async () => {
    const provider = scriptedProvider([
      toolCallScript(1),
      toolCallScript(2),
      toolCallScript(3),
      textScript('全部完成'),
    ])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'chain'))
    const dones = events.filter((e) => e.type === 'done')

    expect(provider.calls).toBe(4)
    expect(dones.map((d) => d.step)).toEqual([1, 2, 3, 4])
    expect(dones[3].finish).toBe('stop')

    const assistants = (await h.session.get(sess.id))!.messages.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(4)
    expect(assistants[3].parts.some((p) => p.type === 'text')).toBe(true)
    await h.stop()
  })

  it('finish=length（输出被截断）：即使带 toolCalls 也不续轮', async () => {
    const provider = scriptedProvider([toolCallScript(1, 'length')])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    await collect(h.session.promptStream(sess.id, 'truncated'))
    expect(provider.calls).toBe(1)
    await h.stop()
  })

  it('doom-loop：同工具同入参连续 3 次被拦（无人交互 ⇒ 保守拒绝）', async () => {
    const provider = scriptedProvider([toolCallScript('same')])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'loop'))
    const results = events.filter((e) => e.type === 'tool_call_result')

    // 第 3 次模型调用仍发生（模型请求了），但工具**没有真的再执行一遍** ⇒ 循环终止在 step 3
    expect(provider.calls).toBe(DOOM_LOOP_THRESHOLD)
    const last = results[results.length - 1]
    expect(last?.isError).toBe(true)
    expect(JSON.stringify(last?.result)).toContain('DOOM_LOOP')
    // 只有前两次真的执行成功
    expect(results.filter((r) => r.isError !== true)).toHaveLength(DOOM_LOOP_THRESHOLD - 1)
    await h.stop()
  })

  it('doom-loop 且用户允许 ⇒ 继续执行，不误伤合法重试', async () => {
    const provider = scriptedProvider([
      toolCallScript('same'),
      toolCallScript('same'),
      toolCallScript('same'),
      textScript('收尾'),
    ])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      permission: new AllowAskEngine({ '*': 'allow' }),
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'retry'))
    const results = events.filter((e) => e.type === 'tool_call_result')

    // 三次都真的执行了（用户放行），之后模型给出文本收尾
    expect(results).toHaveLength(DOOM_LOOP_THRESHOLD)
    expect(results.every((r) => r.isError !== true)).toBe(true)
    expect(provider.calls).toBe(4)
    await h.stop()
  })

  it('步数到顶：注入收尾提示后额外跑一步，且提示确实进了请求', async () => {
    const seen: Message[][] = []
    const provider = scriptedProvider(
      [toolCallScript(1), toolCallScript(2), toolCallScript(3)],
      (m) => seen.push(m),
    )
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    await collect(h.session.promptStream(sess.id, 'top', 2))

    // maxSteps=2 ⇒ 跑满 2 步后仍要续轮 ⇒ 追加收尾提示再跑第 3 步，然后停止
    expect(provider.calls).toBe(3)
    expect(JSON.stringify(seen[2])).toContain('最大步数上限')
    await h.stop()
  })

  it('maxSteps=1 是显式单轮：即使有工具调用也不追加收尾步', async () => {
    const provider = scriptedProvider([toolCallScript(1), textScript('不该被调用')])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    await collect(h.session.promptStream(sess.id, 'single', 1))
    expect(provider.calls).toBe(1)
    await h.stop()
  })

  it('isDoomLoop：只看窗口内连续相同，早于窗口的重复不算', () => {
    expect(isDoomLoop([])).toBe(false)
    expect(isDoomLoop(['a', 'a'])).toBe(false)
    expect(isDoomLoop(['a', 'a', 'a'])).toBe(true)
    expect(isDoomLoop(['a', 'a', 'b'])).toBe(false)
    expect(isDoomLoop(['a', 'b', 'a', 'a', 'a'])).toBe(true)
    expect(isDoomLoop(['a', 'a', 'a'], 2)).toBe(true)
    expect(isDoomLoop(['a'], 0)).toBe(false)
  })

  it('默认步数是 30（防被误改成 1）', () => {
    expect(DEFAULT_MAX_STEPS).toBe(30)
  })
})

