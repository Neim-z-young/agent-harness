/**
 * `turn_end` 的插件广播归属：由 **core** 负责（不依赖宿主是否走 CLI）。
 *
 * 回归背景：原本只有 CLI 侧广播（`createProcessLine` / `harness run`），于是「以库内嵌」
 * 或「宿主（如 ACP）自己消费事件流」时插件永远收不到整轮结束 —— 靠它驱动的兜底逻辑
 * （记忆的攒批放行）会静默失效，且是「什么都没发生」式的失效，极难排查。
 *
 * 因此这里**完全不 import CLI**，只用 createHarness 验证：终态是引擎的事实。
 */
import { describe, it, expect } from 'bun:test'
import {
  createHarness,
  defineTool,
  type AgentDefinition,
  type AgentStreamEvent,
  type ChatProvider,
  type ChatStreamChunk,
  type Harness,
} from './index'
import type { AgentPlugin, AgentStreamSignal } from '@harness/plugin'

const primary: AgentDefinition = {
  id: 'default',
  name: '主 Agent',
  description: 'd',
  mode: 'primary',
  tools: ['*'],
  permission: { '*': 'allow' },
  promptFragments: ['You are a test agent.'],
}

const sub: AgentDefinition = {
  id: 'worker',
  name: '子 Agent',
  description: 'd',
  mode: 'subagent',
  tools: ['*'],
  permission: { '*': 'allow' },
  promptFragments: ['You are a subagent.'],
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
  { type: 'tool_use_start', toolUseId: 'tu_1', toolId: 'echo' },
  { type: 'tool_use_delta', inputDelta: '{"msg":"hi"}' },
  { type: 'tool_use_stop', toolUseId: 'tu_1' },
  { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' },
]

const finalChunks: ChatStreamChunk[] = [
  { type: 'text_delta', text: '完成' },
  { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop' },
]

/** 剧本 Provider：第 n 次 stream 返回第 n 个剧本（越界重复最后一个） */
function scriptedProvider(script: ChatStreamChunk[][]): ChatProvider {
  const p = {
    id: 'scripted',
    calls: 0,
    async complete() {
      throw new Error('本测试只走流式路径')
    },
    async *stream() {
      const chunks = script[Math.min(p.calls, script.length - 1)]
      p.calls++
      for (const c of chunks) yield c
    },
  }
  return p
}

/** 探针插件：把收到的 agent.stream 信号拷一份留档（跨 await 后仍可比对） */
function probePlugin(sink: AgentStreamSignal[]): AgentPlugin {
  return {
    id: 'probe.agent-stream',
    version: '0.0.0',
    name: 'probe',
    async install() {
      return {
        'agent.stream': (s) => {
          sink.push(JSON.parse(JSON.stringify(s)) as AgentStreamSignal)
        },
      }
    },
  }
}

async function setup(): Promise<{ h: Harness; sink: AgentStreamSignal[] }> {
  const sink: AgentStreamSignal[] = []
  const h = await createHarness({
    agents: [primary, sub],
    chatProvider: scriptedProvider([toolCallChunks, finalChunks]),
  })
  h.tools.register(echoTool)
  await h.plugin.loadInternal([probePlugin(sink)])
  return { h, sink }
}

async function run(
  h: Harness,
  input: { sessionId: string; agentId: string; message: string; signal?: AbortSignal },
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of h.agent.queryStream({ ...input, maxSteps: 3 })) events.push(ev)
  return events
}

describe('core 侧广播 turn_end（插件不依赖宿主）', () => {
  it('整轮结束广播一次，带 sessionId / idle / finish / step / mode', async () => {
    const { h, sink } = await setup()
    const sess = await h.session.create()
    await run(h, { sessionId: sess.id, agentId: 'default', message: '干活' })

    const ends = sink.filter((s) => s.eventType === 'turn_end')
    expect(ends).toHaveLength(1) // 整轮只发一次（done 才是每步一次）
    const s0 = ends[0]!
    expect(s0.sessionId).toBe(sess.id)
    expect(s0.status.phase).toBe('idle')
    expect(s0.status.agentId).toBe('default')
    expect(s0.status.mode).toBe('primary')
    expect(s0.status.step).toBe(2)
    expect(s0.status.finish).toBe('stop')
    await h.stop()
  })

  it('子 Agent（mode=subagent）不广播：它的「轮」不是用户的轮', async () => {
    const { h, sink } = await setup()
    const sess = await h.session.create()
    await run(h, { sessionId: sess.id, agentId: 'worker', message: '干活' })

    expect(sink.filter((s) => s.eventType === 'turn_end')).toHaveLength(0)
    await h.stop()
  })

  it('中断路径也广播（phase=aborted），消费方不会永远停在「运行中」', async () => {
    const { h, sink } = await setup()
    const sess = await h.session.create()
    const ctl = new AbortController()
    ctl.abort()
    const events = await run(h, { sessionId: sess.id, agentId: 'default', message: '干活', signal: ctl.signal })

    expect(events[events.length - 1]?.type).toBe('turn_end')
    const ends = sink.filter((s) => s.eventType === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.status.phase).toBe('aborted')
    expect(ends[0]!.status.aborted).toBe(true)
    await h.stop()
  })
})
