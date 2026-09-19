/**
 * `turn_end` 的引擎侧广播：hook 名是 **`agent.turn.end`**（core 层），不是 `agent.stream`（UI 层）。
 *
 * 为什么要分成两个 hook：`agent.stream` 的触发点是 UI 消费层（CLI 的 REPL/TUI/run），
 * 以库内嵌或 ACP 宿主自己消费事件流时**根本不会触发** —— 把引擎终态塞进那个通道，
 * 会让"每轮都该发生"的逻辑（如记忆的攒批放行）在无 UI 宿主里静默失效；反过来，同一个
 * hook 名由两层分别触发，消费方也分不清"这条是谁发的"。
 *
 * 本文件**故意不 import CLI**：证明引擎终态不依赖宿主。
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
import type { AgentPlugin, AgentStreamSignal, AgentTurnEndSignal } from '@harness/plugin'

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

/** 探针：同时订阅两条通道，用来证明"引擎只走 agent.turn.end" */
function probePlugin(ends: AgentTurnEndSignal[], streams: AgentStreamSignal[]): AgentPlugin {
  return {
    id: 'probe.turn-end',
    version: '0.0.0',
    name: 'probe',
    async install() {
      return {
        'agent.turn.end': (s) => {
          ends.push(JSON.parse(JSON.stringify(s)) as AgentTurnEndSignal)
        },
        'agent.stream': (s) => {
          streams.push(JSON.parse(JSON.stringify(s)) as AgentStreamSignal)
        },
      }
    },
  }
}

async function setup(): Promise<{ h: Harness; ends: AgentTurnEndSignal[]; streams: AgentStreamSignal[] }> {
  const ends: AgentTurnEndSignal[] = []
  const streams: AgentStreamSignal[] = []
  const h = await createHarness({
    agents: [primary, sub],
    chatProvider: scriptedProvider([toolCallChunks, finalChunks]),
  })
  h.tools.register(echoTool)
  await h.plugin.loadInternal([probePlugin(ends, streams)])
  return { h, ends, streams }
}

async function run(
  h: Harness,
  input: { sessionId: string; agentId: string; message: string; signal?: AbortSignal },
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of h.agent.queryStream({ ...input, maxSteps: 3 })) events.push(ev)
  return events
}

describe('core 广播整轮终态：agent.turn.end（引擎层）', () => {
  it('整轮结束发一次，带引擎事实字段（sessionId / step / finish / mode），且不碰 agent.stream', async () => {
    const { h, ends, streams } = await setup()
    const sess = await h.session.create()
    await run(h, { sessionId: sess.id, agentId: 'default', message: '干活' })

    expect(ends).toHaveLength(1) // 整轮只发一次（done 才是每步一次）
    const e = ends[0]!
    expect(e.agentId).toBe('default')
    expect(e.mode).toBe('primary')
    expect(e.sessionId).toBe(sess.id)
    expect(e.step).toBe(2)
    expect(e.finish).toBe('stop')
    expect(e.aborted).toBeUndefined()

    // 分层的关键断言：引擎**不往 UI 通道**（agent.stream）发任何东西
    expect(streams).toEqual([])
    await h.stop()
  })

  it('子 Agent 的轮也发（引擎不做"哪一轮算用户的轮"的判断），带 mode 供消费方筛', async () => {
    const { h, ends } = await setup()
    const sess = await h.session.create()
    await run(h, { sessionId: sess.id, agentId: 'worker', message: '干活' })

    expect(ends).toHaveLength(1)
    expect(ends[0]!.mode).toBe('subagent')
    expect(ends[0]!.agentId).toBe('worker')
    await h.stop()
  })

  it('中断路径也发（step=0 + aborted），消费方不会永远停在「运行中」', async () => {
    const { h, ends } = await setup()
    const sess = await h.session.create()
    const ctl = new AbortController()
    ctl.abort()
    const events = await run(h, { sessionId: sess.id, agentId: 'default', message: '干活', signal: ctl.signal })

    expect(events[events.length - 1]?.type).toBe('turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.step).toBe(0) // 一步都没跑
    expect(ends[0]!.aborted).toBe(true)
    expect(ends[0]!.finish).toBeUndefined()
    await h.stop()
  })
})
