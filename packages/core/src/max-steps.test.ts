import { describe, it, expect } from 'bun:test'
import {
  createHarness,
  defineTool,
  normalizeMaxSteps,
  DEFAULT_MAX_STEPS,
  type AgentDefinition,
  type AgentStreamEvent,
  type ChatProvider,
  type ChatStreamChunk,
} from './index'

/**
 * 步数上限的归一化与优先级（评审后修复，回归用例）。
 *
 * 修复前的实现是 `configured === -1 ? Infinity : Math.max(1, Math.floor(configured))`，两个坑：
 * 1. `maxSteps: 0` 被**静默抬成 1** —— 子 Agent 跑一步就收尾，现象像「任务太小 / 模型不肯干活」，
 *    而真实原因是入参非法（模型在 `subagent({ maxSteps })` 里填了 `0`，`0 ?? x` 又不会跳过 `0`）。
 * 2. `maxSteps: NaN` ⇒ `maxSteps = NaN` ⇒ `step >= NaN` **恒为 false** ⇒ 步数上限被静默取消
 *    （只剩 doom-loop 守卫兜底）。这一条最危险：现象是"跑得很久"，实际是"没有上限了"。
 *
 * 现在的语义：
 * - `-1` / `+Infinity` → 不限
 * - 有限且 `>= 1` → 取下整
 * - 其余（`0` / `< -1` / `NaN`）→ 视为**未指定**，回落下一优先级，并告警（不静默）
 */

const loopingTool = defineTool({
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

/** 每轮都返回**互不相同**入参的工具调用（避免命中 doom-loop 守卫，从而真正跑到步数上限） */
function loopingProvider(): ChatProvider & { calls: number } {
  const p = {
    id: 'looping',
    calls: 0,
    async complete() {
      throw new Error('本测试只走流式路径')
    },
    async *stream() {
      p.calls++
      const n = p.calls
      yield { type: 'tool_use_start', toolUseId: `tu_${n}`, toolId: 'echo' } as ChatStreamChunk
      yield { type: 'tool_use_delta', inputDelta: `{"msg":"m${n}"}` } as ChatStreamChunk
      yield { type: 'tool_use_stop', toolUseId: `tu_${n}` } as ChatStreamChunk
      yield { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' } as ChatStreamChunk
    },
  }
  return p
}

/** 跑一轮并把 LLM 调用次数交出来（跑满上限时会多一次"收尾提示"调用，见 queryStream 注释） */
async function callsFor(
  input: { maxSteps?: number },
  agentDef?: Partial<AgentDefinition>,
): Promise<{ calls: number; warns: string[] }> {
  const warns: string[] = []
  const provider = loopingProvider()
  const agent: AgentDefinition = {
    id: 'default',
    name: '步数上限测试 Agent',
    description: 'd',
    mode: 'primary',
    tools: ['*'],
    permission: { '*': 'allow' },
    promptFragments: ['You are a test agent.'],
    ...agentDef,
  }
  const h = await createHarness({
    agents: [agent],
    chatProvider: provider,
    logger: {
      info: (_m: string) => {},
      warn: (m: string) => { warns.push(m) },
      error: (_m: string) => {},
      debug: (_m: string) => {},
    },
  })
  h.tools.register(loopingTool)
  const sess = await h.session.create()
  try {
    for await (const _ev of h.agent.queryStream({
      sessionId: sess.id,
      agentId: 'default',
      message: '干活',
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    })) {
      // 只关心副作用（调用次数 / 告警），事件本身另有测试覆盖
    }
  } finally {
    await h.stop()
  }
  return { calls: provider.calls, warns }
}

describe('normalizeMaxSteps：合法值归一化（L1）', () => {
  it('未指定 → undefined（回落下一优先级）', () => {
    expect(normalizeMaxSteps(undefined)).toBeUndefined()
    expect(normalizeMaxSteps(null)).toBeUndefined()
  })

  it('-1 / +Infinity → 不限', () => {
    expect(normalizeMaxSteps(-1)).toBe(Number.POSITIVE_INFINITY)
    expect(normalizeMaxSteps(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })

  it('>= 1 的有限数 → 取下整', () => {
    expect(normalizeMaxSteps(1)).toBe(1)
    expect(normalizeMaxSteps(35)).toBe(35)
    expect(normalizeMaxSteps(2.7)).toBe(2)
  })

  it('0 / < -1 / NaN → undefined（**不是**钳成 1，也不是 NaN）', () => {
    expect(normalizeMaxSteps(0)).toBeUndefined()
    expect(normalizeMaxSteps(-2)).toBeUndefined()
    expect(normalizeMaxSteps(Number.NaN)).toBeUndefined()
    expect(normalizeMaxSteps(Number.NEGATIVE_INFINITY)).toBeUndefined()
  })
})

describe('步数上限优先级与非法值回落（L2 端到端）', () => {
  it('入参 maxSteps=0 被忽略 ⇒ 回落 Agent 定义（不是静默跑 1 步）', async () => {
    const { calls, warns } = await callsFor({ maxSteps: 0 }, { maxSteps: 25 })
    // 跑满 25 步 + 1 次收尾提示
    expect(calls).toBe(26)
    expect(warns.some((w) => w.includes('[maxSteps]') && w.includes('入参'))).toBe(true)
  })

  it('入参 maxSteps=NaN 不再取消上限 ⇒ 回落 Agent 定义', async () => {
    const { calls, warns } = await callsFor({ maxSteps: Number.NaN }, { maxSteps: 3 })
    expect(calls).toBe(4) // 修复前：NaN ⇒ 上限失效，会一路跑到 doom-loop / 模型自己停
    expect(warns.some((w) => w.includes('入参'))).toBe(true)
  })

  it('入参 / 定义都非法 ⇒ 回落 DEFAULT_MAX_STEPS', async () => {
    const { calls } = await callsFor({ maxSteps: -5 })
    expect(calls).toBe(DEFAULT_MAX_STEPS + 1)
  })

  it('Agent 定义里的 maxSteps=0（绕过 md 解析，程序化注册）同样被判非法并告警', async () => {
    const { calls, warns } = await callsFor({}, { maxSteps: 0 })
    expect(calls).toBe(DEFAULT_MAX_STEPS + 1)
    expect(warns.some((w) => w.includes('定义的 maxSteps'))).toBe(true)
  })

  it('maxSteps=1 是显式单轮：有工具调用也不追加收尾步', async () => {
    const { calls, warns } = await callsFor({ maxSteps: 1 })
    expect(calls).toBe(1)
    expect(warns.length).toBe(0)
  })

  it('合法入参不产生告警', async () => {
    const { calls, warns } = await callsFor({ maxSteps: 3 })
    expect(calls).toBe(4)
    expect(warns.filter((w) => w.includes('[maxSteps]')).length).toBe(0)
  })
})
