import { describe, it, expect } from 'bun:test'
import type { AgentDefinition, AgentStreamEvent, ChatProvider, ChatStreamChunk, Message } from './index'
import { createHarness, defineTool, MAX_SELF_HEAL_FREE_STEPS } from './index'
import { withJsonSchema } from '@harness/tool'

/**
 * 入参自愈（core `describeMissingRequiredParams`）。
 *
 * 回归对象：会话 `s_1789996799007_9cq9r` 真机实测 —— 模型在长上下文下会**整段丢掉**
 * tool-call arguments：100 次调用里 37 次失败、其中 34 次 `input: {}`（这些轮的 output
 * 中位数只有 22 token），失败率随上下文从 12% 升到 50%。原样回传错误消息时模型只能盲猜重试，
 * 每次失败实打实烧掉一轮完整 prompt（占该会话上下文的 43.6%）。
 *
 * 这里把"这个工具到底要什么参数"直接塞进错误消息，让它在同一次重试里就能补齐。
 */

const agent: AgentDefinition = {
  id: 'default',
  name: 'selfheal 测试 Agent',
  description: 'd',
  mode: 'primary',
  tools: ['*'],
  permission: { '*': 'allow' },
  promptFragments: ['You are a test agent.'],
}

/** 带 JSON Schema 的工具：没有 command 就在入口拒绝（AGENTS.md 的硬约定） */
const needCmdTool = defineTool({
  id: 'need_cmd',
  description: '需要一个 command 参数',
  inputSchema: withJsonSchema(
    {
      parse: (v: unknown) => v as { command: string },
      safeParse: (v: unknown) => ({ success: true as const, data: v as { command: string } }),
    },
    {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的命令' } },
      required: ['command'],
      additionalProperties: false,
    },
  ),
  isReadOnly: () => true,
  async call(input: { command?: string }) {
    if (!input?.command) {
      return { ok: false as const, error: { message: '缺少 command：请在入参 `command` 里给出命令', code: 'COMMAND_REQUIRED' } }
    }
    return { ok: false as const, error: { message: '业务错误：命令不被允许', code: 'BOOM' } }
  },
})

/** 没有 schema 的工具（模拟"没写 schema"的旧工具）：失败时不应被附加自愈提示 */
const bareTool = defineTool({
  id: 'bare',
  description: '没有 JSON Schema',
  inputSchema: {
    parse: (v: unknown) => v as Record<string, unknown>,
    safeParse: (v: unknown) => ({ success: true as const, data: v as Record<string, unknown> }),
  },
  isReadOnly: () => true,
  async call() {
    return { ok: false as const, error: { message: '随便失败了', code: 'BOOM' } }
  },
})

/** 第 n 次 stream 返回第 n 个剧本；把每次请求的 messages 快照交出来供断言 */
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

/** 造一段「调用工具（入参由 argJson 给）→ 再收尾」的剧本 */
function toolThenFinish(toolId: string, argJson: string): ChatStreamChunk[][] {
  return [
    [
      { type: 'tool_use_start', toolUseId: 'tu_1', toolId },
      { type: 'tool_use_delta', inputDelta: argJson },
      { type: 'tool_use_stop', toolUseId: 'tu_1' },
      { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' },
    ],
    [
      { type: 'text_delta', text: '好的' },
      { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop' },
    ],
  ]
}

/** 取出回喂给模型的那条工具结果 */
function toolResultOf(messages: Message[]): Record<string, unknown> | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool' && (p as { toolId?: string }).toolId === 'need_cmd') {
        const r = (p as { result?: unknown }).result
        if (r && typeof r === 'object') return r as Record<string, unknown>
      }
    }
  }
  return undefined
}

describe('入参自愈：零参数工具调用时把必填参数摆给模型', () => {
  it('input={} 触发失败 → 回喂的消息含 [入参自愈] + 必填参数名 + 最小示例，且原 code 保留', async () => {
    const seen: Message[][] = []
    const provider = scriptedProvider(toolThenFinish('need_cmd', '{}'), (m) => seen.push(m))
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(needCmdTool)
    const sess = await h.session.create()

    for await (const _ of h.session.promptStream(sess.id, '跑一下', 2)) { /* drain */ }

    const result = toolResultOf(seen[1])!
    expect(result).toBeDefined()
    const msg = String(result.message)
    expect(msg).toContain('[入参自愈]')
    expect(msg).toContain('command')          // 必填参数名
    expect(msg).toContain('要执行的命令')      // 参数描述（来自 schema）
    expect(msg).toContain('{"command":"<string>"}') // 最小示例
    expect(msg).toContain('一个都没给')
    // 原有错误信息与错误码都不能丢（下游按 code 判定）
    expect(msg).toContain('缺少 command')
    expect(result.code).toBe('COMMAND_REQUIRED')
    await h.stop()
  })

  it('必填参数已给齐但业务失败 → 不追加自愈提示（避免噪音）', async () => {
    const seen: Message[][] = []
    const provider = scriptedProvider(toolThenFinish('need_cmd', '{"command":"ls"}'), (m) => seen.push(m))
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(needCmdTool)
    const sess = await h.session.create()

    for await (const _ of h.session.promptStream(sess.id, '跑一下', 2)) { /* drain */ }

    const result = toolResultOf(seen[1])!
    expect(result.code).toBe('BOOM')
    expect(String(result.message)).not.toContain('[入参自愈]')
    await h.stop()
  })

  it('只给了一部分必填时也提示，并列出已给出的项', async () => {
    // 该工具只有一个必填项，这里用"给了 null"模拟"等于没给"
    const seen: Message[][] = []
    const provider = scriptedProvider(toolThenFinish('need_cmd', '{"command":null}'), (m) => seen.push(m))
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(needCmdTool)
    const sess = await h.session.create()

    for await (const _ of h.session.promptStream(sess.id, '跑一下', 2)) { /* drain */ }

    const msg = String(toolResultOf(seen[1])!.message)
    expect(msg).toContain('[入参自愈]')
    await h.stop()
  })

  it('工具没有 JSON Schema / 没有必填项 → 不追加（不静默改文案）', async () => {
    const seen: Message[][] = []
    const provider = scriptedProvider(toolThenFinish('bare', '{}'), (m) => seen.push(m))
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(bareTool)
    const sess = await h.session.create()

    for await (const _ of h.session.promptStream(sess.id, '跑一下', 2)) { /* drain */ }

    // 第一条 assistant 消息里的 tool part 即 bare 的结果
    let msg: string | undefined
    for (const m of seen[1]) {
      for (const p of m.parts) {
        if (p.type === 'tool' && (p as { toolId?: string }).toolId === 'bare') {
          msg = String((p as { result?: { message?: string } }).result?.message)
        }
      }
    }
    expect(msg).toBe('随便失败了')
    expect(msg).not.toContain('[入参自愈]')
    await h.stop()
  })
})

// ===== 观察点 9：必填全缺的回喂步免计额度 =====
//
// 动机：这类步的产出只有一条 `[入参自愈]` 说明 + 模型的一次重试，等于把额度花在"把参数写全"上。
// 真机 lead 6 次 `input={}`（bash×3 / read_file×3）就是 6 步额度，一个字的结果都没产出。

/** 第二个带必填的工具：用来演示"交替空参"（单一工具会先被 doom-loop 拦掉） */
const needPathTool = defineTool({
  id: 'need_path',
  description: '需要一个 path 参数',
  inputSchema: withJsonSchema(
    {
      parse: (v: unknown) => v as { path: string },
      safeParse: (v: unknown) => ({ success: true as const, data: v as { path: string } }),
    },
    {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
  ),
  isReadOnly: () => true,
  async call(input: { path?: string }) {
    if (!input?.path) {
      return { ok: false as const, error: { message: '缺少 path', code: 'PATH_REQUIRED' } }
    }
    return { ok: true as const, output: { path: input.path } }
  },
})

/** 造一段「调用 a（空参）→ 调用 b（空参）→ …」的交替空参剧本，共 n 步 */
function alternatingEmptyCalls(n: number): ChatStreamChunk[][] {
  const out: ChatStreamChunk[][] = []
  for (let i = 0; i < n; i++) {
    const id = i % 2 === 0 ? 'need_cmd' : 'need_path'
    out.push([
      { type: 'tool_use_start', toolUseId: `tu_${i}`, toolId: id },
      { type: 'tool_use_delta', inputDelta: '{}' },
      { type: 'tool_use_stop', toolUseId: `tu_${i}` },
      { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' },
    ])
  }
  return out
}

describe('入参自愈的额度代价：必填全缺的回喂步免计（有上限）', () => {
  it('全是空参调用的步不吃额度：maxSteps=2 也能跑完 3 步（第 3 步是真正的收尾）', async () => {
    const script = [
      ...alternatingEmptyCalls(2),
      [
        { type: 'text_delta', text: '参数补齐了' },
        { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop' },
      ],
    ]
    const provider = scriptedProvider(script)
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(needCmdTool)
    h.tools.register(needPathTool)
    const sess = await h.session.create()

    const events: AgentStreamEvent[] = []
    for await (const ev of h.session.promptStream(sess.id, '跑一下', 2)) events.push(ev)

    // 改造前：2 步额度被两次空参回喂吃光，第 3 次模型调用根本不会发生
    expect(provider.calls).toBe(3)
    const dones = events.filter((e) => e.type === 'done')
    expect(dones.map((d) => d.step)).toEqual([1, 2, 3]) // 展示步号照常单调递增
    const turnEnd = events.find((e) => e.type === 'turn_end')
    expect(turnEnd?.freeSteps).toBe(2) // 免计 2 步：步号 3 但只花了 1 步额度
    await h.stop()
  })

  it('免计有硬上限（MAX_SELF_HEAL_FREE_STEPS）：交替空参不会变成无限循环', async () => {
    // 剧本给足 10 步交替空参；真实上限是 3 ⇒ 之后每一步都正常吃额度，
    // maxSteps=2 的额度随即耗尽（若上限失效，这个用例会一直跑到 bun 超时）
    const provider = scriptedProvider(alternatingEmptyCalls(10))
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(needCmdTool)
    h.tools.register(needPathTool)
    const sess = await h.session.create()

    const events: AgentStreamEvent[] = []
    for await (const ev of h.session.promptStream(sess.id, '跑一下', 2)) events.push(ev)

    expect(MAX_SELF_HEAL_FREE_STEPS).toBe(3)
    const turnEnd = events.find((e) => e.type === 'turn_end')
    // 恰好免 3 步，多一步都不免
    expect(turnEnd?.freeSteps).toBe(3)
    // 循环确实终止了：额度耗尽后还会给一次收尾机会（MAX_STEPS_WRAP_UP）
    expect(provider.calls).toBe(6)
    await h.stop()
  })

  it('一步里有任何一个工具真的执行了 ⇒ 这一步照常吃额度（只有全缺才免）', async () => {
    // 同一步两个调用：一个空参（会被自愈）、一个必填给齐（业务失败但**不是**缺参）
    const provider = scriptedProvider([
      [
        { type: 'tool_use_start', toolUseId: 'tu_1', toolId: 'need_cmd' },
        { type: 'tool_use_delta', inputDelta: '{}' },
        { type: 'tool_use_stop', toolUseId: 'tu_1' },
        { type: 'tool_use_start', toolUseId: 'tu_2', toolId: 'need_cmd' },
        { type: 'tool_use_delta', inputDelta: '{"command":"ls"}' },
        { type: 'tool_use_stop', toolUseId: 'tu_2' },
        { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: '结束' },
        { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop' },
      ],
    ])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(needCmdTool)
    const sess = await h.session.create()

    const events: AgentStreamEvent[] = []
    for await (const ev of h.session.promptStream(sess.id, '跑一下', 1)) events.push(ev)

    // maxSteps=1 ⇒ 第 1 步就吃满额度，不再续轮
    expect(provider.calls).toBe(1)
    const turnEnd = events.find((e) => e.type === 'turn_end')
    expect(turnEnd?.freeSteps).toBeUndefined()
    await h.stop()
  })

  it('必填给齐后正常执行 ⇒ 后续步照常吃额度（免计只覆盖"补齐参数"的那一步）', async () => {
    const provider = scriptedProvider([
      ...alternatingEmptyCalls(1), // 第 1 步：空参（免计）
      [
        { type: 'tool_use_start', toolUseId: 'tu_ok', toolId: 'need_path' },
        { type: 'tool_use_delta', inputDelta: '{"path":"a.ts"}' },
        { type: 'tool_use_stop', toolUseId: 'tu_ok' },
        { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: '结束' },
        { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop' },
      ],
    ])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(needCmdTool)
    h.tools.register(needPathTool)
    const sess = await h.session.create()

    const events: AgentStreamEvent[] = []
    for await (const ev of h.session.promptStream(sess.id, '跑一下', 2)) events.push(ev)

    // step1 免计（额度 0/2）→ step2 吃 1 步（1/2）→ step3 吃第 2 步（2/2）→ 收尾步
    expect(provider.calls).toBe(3)
    const turnEnd = events.find((e) => e.type === 'turn_end')
    expect(turnEnd?.freeSteps).toBe(1)
    await h.stop()
  })
})
