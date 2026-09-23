import { describe, it, expect } from 'bun:test'
import {
  createHarness,
  defineTool,
  mergeStepGateDecision,
  stepGateDelayMs,
  STEP_GATE_BACKOFF_MS,
  STEP_GATE_MAX_TOTAL_MS,
  type AgentDefinition,
  type AgentPlugin,
  type AgentStreamEvent,
  type ChatProvider,
  type ChatStreamChunk,
  type Hooks,
} from './index'

/**
 * 步间闸门（观察点 3）：`core.agent.step.gate`
 *
 * 真机背景（s_1790163574429_tg1a6）：lead 派完 4 个后台 reader 后无事可做，却在 20 秒内
 * 把 30 步额度烧光（msg31 / msg66 两次撞顶；第一次撞顶时后台任务只做了一半），于是结果
 * 只能在**下一轮 query** 里才可能被看到 —— 要么用户自己敲键，要么等 barrier 续轮。
 *
 * 闸门要证的三件事：
 * 1. 插件说"还有存活任务"时，下一步开跑前确实等了（且发 `step_gate` 事件）；
 * 2. 插件说"没了"时**立刻**不再等（整轮关闭，不逐步重探）；
 * 3. 没有任何插件实现时行为与改造前完全一致（不多等、不多发事件）。
 */

// ===== L1：纯函数 =====

describe('stepGateDelayMs：退避阶梯', () => {
  it('按 3s → 6s → 12s → 24s → 48s → 60s 递增，之后封顶 60s', () => {
    expect(STEP_GATE_BACKOFF_MS).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000])
    expect([0, 1, 2, 3, 4, 5].map((i) => stepGateDelayMs(i))).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000])
    // 超出阶梯长度后**保持末档**（不是重置、也不是继续翻倍）
    expect([6, 7, 50].map((i) => stepGateDelayMs(i))).toEqual([60_000, 60_000, 60_000])
  })

  it('非法 attempt（负数 / 小数）落到第 1 档而不是 NaN', () => {
    expect(stepGateDelayMs(-1)).toBe(3_000)
    expect(stepGateDelayMs(1.9)).toBe(6_000)
    expect(stepGateDelayMs(Number.NaN)).toBe(3_000)
  })

  it('空阶梯 ⇒ 0（等价于"每次都不等"，供宿主关闸门用）', () => {
    expect(stepGateDelayMs(0, [])).toBe(0)
  })
})

describe('mergeStepGateDecision：多插件上报的合取与清洗', () => {
  it('未置 pending / 缺字段 ⇒ 不等', () => {
    expect(mergeStepGateDecision(undefined)).toEqual({ pending: false })
    expect(mergeStepGateDecision({})).toEqual({ pending: false })
    expect(mergeStepGateDecision({ pending: false, aliveCount: 3 })).toEqual({ pending: false })
    // 只认**严格 true**：插件写 'true'（字符串）这类脏值不该让引擎开始等
    expect(mergeStepGateDecision({ pending: 'true' })).toEqual({ pending: false })
  })

  it('pending=true 时透传合法 aliveCount / reason，脏值丢弃（不把引擎带下水）', () => {
    expect(mergeStepGateDecision({ pending: true, aliveCount: 4, reason: '4 个在跑' }))
      .toEqual({ pending: true, aliveCount: 4, reason: '4 个在跑' })
    expect(mergeStepGateDecision({ pending: true, aliveCount: Number.NaN })).toEqual({ pending: true })
    expect(mergeStepGateDecision({ pending: true, aliveCount: '4' })).toEqual({ pending: true })
    expect(mergeStepGateDecision({ pending: true, reason: '' })).toEqual({ pending: true })
  })
})

// ===== L2：端到端（真实引擎 + 真实插件链）=====

const agent: AgentDefinition = {
  id: 'default',
  name: '闸门测试 Agent',
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

/** 一步：调工具；再一步：收尾 */
const stepChunks = (msg: string): ChatStreamChunk[] => [
  { type: 'tool_use_start', toolUseId: `tu_${msg}`, toolId: 'echo' },
  { type: 'tool_use_delta', inputDelta: JSON.stringify({ msg }) },
  { type: 'tool_use_stop', toolUseId: `tu_${msg}` },
  { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls' },
]
const finalChunks: ChatStreamChunk[] = [
  { type: 'text_delta', text: 'done' },
  { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop' },
]

function scriptedProvider(script: ChatStreamChunk[][]): ChatProvider & { calls: number } {
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

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, unknown>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

/**
 * 探针插件：按 `aliveSeq` 依次回答"还有几个存活任务"（越界则重复最后一个）。
 * `0` / `undefined` 表示"没有存活任务"。
 *
 * 为什么要用序列而不是固定值：闸门的核心行为是"探测 → 等待 → **再探测**"，
 * 必须能演出"第一次说有、第二次说没有"。
 */
function gateProbe(aliveSeq: Array<number | undefined>): AgentPlugin & { probes: number } {
  const plugin = {
    id: 'gate-probe',
    version: '1',
    name: 'GateProbe',
    probes: 0,
    async install() {
      return {
        'core.agent.step.gate'(_input: unknown, decision: { pending?: boolean; aliveCount?: number; reason?: string }) {
          const alive = aliveSeq[Math.min(plugin.probes, aliveSeq.length - 1)]
          plugin.probes++
          if (alive !== undefined && alive > 0) {
            decision.pending = true
            decision.aliveCount = alive
            decision.reason = `${alive} 个后台子任务仍在运行`
          }
        },
      } as Hooks
    },
  }
  return plugin
}

describe('步间闸门：真实引擎 + 探针插件', () => {
  it('探针说有存活任务 ⇒ 下一步之前按阶梯等待并逐次发 step_gate', async () => {
    // 三步剧本：前两步都"还在调工具"，第三步才收尾 ⇒ 有**两次**"下一步之前"的机会
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    // 阶梯压到毫秒级：这里验的是"等了 + 事件形状"，不是"等得够久"
    const probe = gateProbe([2, 1, 0])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [5, 10], maxTotalMs: 10_000 },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 5))
    const gates = events.filter((e) => e.type === 'step_gate')

    // 探测点 = 每步开跑前：第 2 步前（2 个存活 ⇒ 等 5ms）、第 3 步前（1 个 ⇒ 等 10ms）。
    // 第 4 步不存在（第 3 步收尾）⇒ 恰两条，不多不少。
    expect(gates).toHaveLength(2)
    expect(gates.map((g) => g.gate?.waitMs)).toEqual([5, 10])
    expect(gates.map((g) => g.gate?.waitedMs)).toEqual([5, 15])
    expect(gates.map((g) => g.gate?.attempt)).toEqual([1, 2])
    expect(gates.map((g) => g.gate?.aliveCount)).toEqual([2, 1])
    expect(gates[0].gate?.reason).toBe('2 个后台子任务仍在运行')

    // 等待不改步数语义：三步都跑完了
    expect(provider.calls).toBe(3)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(3)
    expect(probe.probes).toBe(2)
    await h.stop()
  })

  it('探针说没有存活任务 ⇒ 一次都不等（不发 step_gate），但每个步边界仍会重探一次', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([0])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [5] },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 5))
    expect(events.filter((e) => e.type === 'step_gate')).toHaveLength(0)
    // 为什么"每步都问"而不是问一次就永久关掉：同一轮里 coordinator 可能再派一批任务，
    // 永久关门会让新一波完全不受节奏约束。探测本身只是一次内存过滤，重探成本可忽略。
    expect(probe.probes).toBe(2) // 第 2 步前、第 3 步前各一次
    expect(provider.calls).toBe(3)
    await h.stop()
  })

  it('探测从"有任务"转为"静默"后阶梯归零（新一波派工从最小档重新起步）', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), stepChunks('c'), finalChunks])
    // 探针序列：第 1 次有 1 个存活（等 5ms）；之后静默（阶梯归零）；再之后又出现 2 个存活
    const probe = gateProbe([1, 0, 2])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [5, 999] },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 6))
    const gates = events.filter((e) => e.type === 'step_gate')
    // 三次探测：① 有任务 ⇒ 等 5ms（档位 0）；② 静默 ⇒ 归零、不等；
    // ③ 又有任务 ⇒ 仍取档位 0（5ms，**不是** 999）—— 这正是"归零"的可观测证据。
    expect(gates.map((g) => g.gate?.waitMs)).toEqual([5, 5])
    expect(gates.map((g) => g.gate?.attempt)).toEqual([1, 1])
    expect(probe.probes).toBe(3)
    await h.stop()
  })

  it('等待总预算用尽后停止等待（按 maxTotalMs 兜底，不被插件误报拖住）', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), stepChunks('c'), finalChunks])
    const probe = gateProbe([9]) // 永远说"还有 9 个"，模拟插件误报/任务卡死
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      // 预算 12ms、阶梯每档 5ms ⇒ 最多等 2 次（5+5=10 ≤ 12；再等一次 15 > 12 ⇒ 关闸门）
      stepGate: { ladderMs: [5], maxTotalMs: 12 },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 6))
    const gates = events.filter((e) => e.type === 'step_gate')
    expect(gates).toHaveLength(2)
    // 预算耗尽后**步数语义不受影响**：模型被叫了几次就几次（4 步）
    expect(provider.calls).toBe(4)
    await h.stop()
  })

  it('宿主显式关闸门（stepGate.enabled=false）⇒ 与没有插件时完全一致', async () => {
    const provider = scriptedProvider([stepChunks('a'), finalChunks])
    const probe = gateProbe([3])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { enabled: false },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 3))
    expect(events.filter((e) => e.type === 'step_gate')).toHaveLength(0)
    expect(probe.probes).toBe(0) // 关掉后连探测都不做
    expect(provider.calls).toBe(2)
    await h.stop()
  })

  it('单步查询（maxSteps=1）不触发闸门：第 1 步之前没有"派出去的任务"可言', async () => {
    const provider = scriptedProvider([finalChunks])
    const probe = gateProbe([7])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [5] },
    })
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 1))
    expect(events.filter((e) => e.type === 'step_gate')).toHaveLength(0)
    expect(probe.probes).toBe(0)
    await h.stop()
  })

  it('中断信号打断等待：不把"用户按了 Ctrl-C"拖到一档等满', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([5])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      // 单档 10s：若 sleep 不可中断，这条用例会真的挂 10 秒（测试超时会暴露）
      stepGate: { ladderMs: [10_000], maxTotalMs: 60_000 },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const ctl = new AbortController()
    const events: AgentStreamEvent[] = []
    const started = Date.now()
    for await (const ev of h.session.promptStream(sess.id, 'go', 6, ctl.signal)) {
      events.push(ev)
      // 第一步的 done 之后立刻中断（此时闸门正准备等 10s）
      if (ev.type === 'done' && ev.step === 1) ctl.abort()
    }
    const elapsed = Date.now() - started

    // 中断在步边界生效：等待被打断，没有真等满 10 秒
    expect(elapsed).toBeLessThan(3_000)
    expect(provider.calls).toBe(1)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    await h.stop()
  })

  it('未实现该 hook 的宿主行为不变（不多等、不发事件）—— 向后兼容', async () => {
    const provider = scriptedProvider([stepChunks('a'), finalChunks])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 3))
    expect(events.filter((e) => e.type === 'step_gate')).toHaveLength(0)
    expect(provider.calls).toBe(2)
    await h.stop()
  })
})

describe('步间闸门常量', () => {
  it('阶梯末档（60s）必须 ≤ 等待总预算，否则末档永远取不到', () => {
    expect(Math.max(...STEP_GATE_BACKOFF_MS)).toBeLessThanOrEqual(STEP_GATE_MAX_TOTAL_MS)
  })

  it('总预算是有限值：闸门终止条件依赖插件上报，引擎必须有兜底', () => {
    expect(Number.isFinite(STEP_GATE_MAX_TOTAL_MS)).toBe(true)
    expect(STEP_GATE_MAX_TOTAL_MS).toBeLessThanOrEqual(600_000)
  })
})
