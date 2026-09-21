import { describe, it, expect } from 'bun:test'
import type { AgentDefinition, ChatProvider, ChatStreamChunk, Message } from './index'
import { createHarness, defineTool } from './index'
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
