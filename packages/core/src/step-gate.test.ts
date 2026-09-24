import { describe, it, expect } from 'bun:test'
import {
  AgentEvents,
  createHarness,
  defineTool,
  mergeStepGateDecision,
  normalizeGateSliceMs,
  stepGateDelayMs,
  STEP_GATE_BACKOFF_MS,
  STEP_GATE_MAX_TOTAL_MS,
  STEP_GATE_SLICE_MS,
  type AgentDefinition,
  type AgentPlugin,
  type AgentStepGateRecord,
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
 * 闸门要证的五件事：
 * 1. 插件说"还有存活任务"时，下一步开跑前确实等了（且发 `step_gate` 事件）；
 * 2. 插件说"没了"时**这一步不再等**，但**每个步边界仍会重探**（阶梯归零，不是关闸门）；
 * 3. **档内分片重探**：任务中途跑完就不睡满整档（最多白等一个切片），`sliceMs=0` 能退回硬等；
 * 4. 没有任何插件实现时行为与改造前完全一致（不多等、不多发事件）；
 * 5. 每一步的**处置**都落一条 `agent.step.gate` 遥测 —— 其中"插件报存活、引擎却没等"
 *    （预算用尽 / 空阶梯 / 被中断）在改造前是**完全静默**的，见文件末尾那组用例。
 *
 * ⚠️ 闸门挂靠在**续轮**上，不是挂在"空转"上：`shouldContinueStep()` 的判据是
 * `toolCallCount > 0`，所以**能走到闸门的步边界，前提都是上一步调用了工具**；
 * 上一步没调工具（给最终答复）时本轮直接结束，闸门**根本不会被触达**。
 * 因此"有 tool call 就不等"是错的 —— 恰恰是有 tool call 的步才续轮、下一步开跑前才经过闸门。
 * 真机语境里的"空转"指的是**有 tool call 但无进展**（反复 read_file/bash 查状态），
 * 这类步同样续轮、同样被闸门减速，那才是闸门要治的东西。
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

describe('normalizeGateSliceMs：切片归一化', () => {
  it('未指定 ⇒ 默认 500ms', () => {
    expect(STEP_GATE_SLICE_MS).toBe(500)
    expect(normalizeGateSliceMs(undefined)).toBe(500)
  })

  it('0 / 负数 / NaN / Infinity ⇒ 0（关掉切片，回退到整档硬等）', () => {
    expect(normalizeGateSliceMs(0)).toBe(0)
    expect(normalizeGateSliceMs(-1)).toBe(0)
    expect(normalizeGateSliceMs(Number.NaN)).toBe(0)
    expect(normalizeGateSliceMs(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('正数下取整；下取整后为 0 的极小值也走硬等（0.5ms 一片等于忙等）', () => {
    expect(normalizeGateSliceMs(12.9)).toBe(12)
    expect(normalizeGateSliceMs(1)).toBe(1)
    expect(normalizeGateSliceMs(0.5)).toBe(0)
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
 * 订阅闸门遥测（`agent.step.gate`）并收集载荷。
 *
 * 发布是 fire-and-forget（`void bus.publish().catch()`），订阅回调可能落在后面的任务里，
 * 所以断言前要 `await flushBus()` —— 与生产环境的时序差别只在于"谁先跑完"。
 */
function watchGateBus(h: Awaited<ReturnType<typeof createHarness>>): AgentStepGateRecord[] {
  const records: AgentStepGateRecord[] = []
  h.bus.subscribe(AgentEvents.stepGate, ({ payload }) => {
    records.push(payload)
  })
  return records
}

/** 等一次宏任务：让 bus 的发布链跑完 */
const flushBus = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 探针插件：按 `aliveSeq` 依次回答"还有几个存活任务"（越界则重复最后一个）。
 * `0` / `undefined` 表示"没有存活任务"。
 *
 * 为什么要用序列而不是固定值：闸门的核心行为是"探测 → 等待 → **再探测**"，
 * 必须能演出"第一次说有、第二次说没有"。同一条序列现在还要覆盖**片间重探**——
 * 片间重探会额外消耗序列里的元素，写用例时得把这一步算进去。
 *
 * 额外的 `inputs` 记录每次调用看到的 `waitAttempt` / `waitedMs`：用来钉住
 * "片间重探不算新的一次等待"（这一档还没记账，插件看到的值不该变）。
 */
function gateProbe(aliveSeq: Array<number | undefined>): AgentPlugin & {
  probes: number
  inputs: Array<{ waitAttempt: number; waitedMs: number }>
} {
  const plugin = {
    id: 'gate-probe',
    version: '1',
    name: 'GateProbe',
    probes: 0,
    inputs: [] as Array<{ waitAttempt: number; waitedMs: number }>,
    async install() {
      return {
        'core.agent.step.gate'(input: unknown, decision: { pending?: boolean; aliveCount?: number; reason?: string }) {
          const gi = (input ?? {}) as { waitAttempt?: number; waitedMs?: number }
          plugin.inputs.push({ waitAttempt: gi.waitAttempt ?? -1, waitedMs: gi.waitedMs ?? -1 })
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

  it('档内分片重探：后台任务中途跑完 ⇒ 提前结束这一档，不把整档睡满', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    // 第 1 次探测（第 2 步开跑前）说"还有 2 个"；第 1 片之后重探就说"没了"
    const probe = gateProbe([2, 0])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      // 档位 400ms 故意远大于切片 20ms：没提前结束的话，实测耗时必然逼近 400ms
      stepGate: { ladderMs: [400], maxTotalMs: 10_000, sliceMs: 20 },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const started = Date.now()
    const events = await collect(h.session.promptStream(sess.id, 'go', 5))
    const elapsed = Date.now() - started
    const gates = events.filter((e) => e.type === 'step_gate')

    expect(gates).toHaveLength(1)
    // waitMs 是**实际**等待（一片），plannedMs 才是那一档的原定值。
    // 两者分开报的理由：报"等了 400ms"而实际只有 20ms 就是假信息。
    expect(gates[0].gate?.waitMs).toBe(20)
    expect(gates[0].gate?.plannedMs).toBe(400)
    expect(gates[0].gate?.waitedMs).toBe(20)
    // 真的没睡满：整轮 query 的总耗时远小于档位
    expect(elapsed).toBeLessThan(300)
    // 探测点：第 2 步前 1 次 + 片间 1 次 + 第 3 步前 1 次（探针已序列越界 ⇒ 静默）
    expect(probe.probes).toBe(3)
    // 片间重探不算新的一次等待：它看到的 waitAttempt/waitedMs 与档位开始时**一致**
    // （若实现里提前记了账，这里会变成 1 / 20）
    expect(probe.inputs[0]).toEqual({ waitAttempt: 0, waitedMs: 0 })
    expect(probe.inputs[1]).toEqual({ waitAttempt: 0, waitedMs: 0 })
    await h.stop()
  })

  it('全程都有后台任务 ⇒ 睡满整档（不出现 plannedMs），片与片之间都会重探', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([9]) // 永远说"还有 9 个"，模拟任务迟迟不结束
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      // 档位 60ms、切片 20ms ⇒ 恰好 3 片
      stepGate: { ladderMs: [60], maxTotalMs: 10_000, sliceMs: 20 },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 5))
    const gates = events.filter((e) => e.type === 'step_gate')

    expect(gates.map((g) => g.gate?.waitMs)).toEqual([60, 60])
    expect(gates.map((g) => g.gate?.waitedMs)).toEqual([60, 120])
    // 睡满 ⇒ 不该有 plannedMs（它只在"被提前结束"时出现）
    expect(gates.map((g) => g.gate?.plannedMs)).toEqual([undefined, undefined])
    // 2 条步边界各 1 次 + 每档片间各 2 次（第 3 片后 remain=0，不再多探一次）= 6
    expect(probe.probes).toBe(6)
    await h.stop()
  })

  it('sliceMs=0 ⇒ 关掉切片、整档硬等（显式回退到改造前的行为）', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([9])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [30], maxTotalMs: 10_000, sliceMs: 0 },
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 5))
    const gates = events.filter((e) => e.type === 'step_gate')

    expect(gates.map((g) => g.gate?.waitMs)).toEqual([30, 30])
    // 关掉切片后只剩"步边界"的探测，没有片间探测
    expect(probe.probes).toBe(2)
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

  it('中断信号打断等待：不把"用户按了 Ctrl-C"拖到一档等满（切片路径同样立刻停）', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([5])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      // 单档 10s：若 sleep 不响应 abort，这条用例会真的挂 10 秒（测试超时会暴露）。
      // 切片 50ms 是**更严**的设定：分片后每次睡眠都短，但循环条件是 `!signal.aborted`，
      // 中断不生效的话会一片接一片地把 10s 睡完 —— 断言依然有区分度。
      stepGate: { ladderMs: [10_000], maxTotalMs: 60_000, sliceMs: 50 },
    })
    h.tools.register(echoTool)
    const records = watchGateBus(h)
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
    await flushBus()

    // 中断在步边界生效：等待被打断，没有真等满 10 秒
    expect(elapsed).toBeLessThan(3_000)
    expect(provider.calls).toBe(1)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    // 中断在**循环顶部的步边界检查**就 break 了（在闸门之前）⇒ 闸门根本没被问到，
    // 因此一条闸门记录都不该有、连探测也不该发生。钉住这个顺序，免得将来有人
    // 把闸门挪到中断检查之前（那会让中断多等一档）。
    expect(probe.probes).toBe(0)
    expect(records).toHaveLength(0)
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

// ===== 闸门遥测：`agent.step.gate`（bus 事件）=====

/**
 * 为什么要这条通道：`step_gate` **流事件**只到 UI（CLI/TUI），进程一结束就蒸发 ——
 * 产线遥测里闸门原本是**完整盲区**，而切片粒度、退避档位这些参数只能靠线上数据调
 * （架构 §17.7 把"L4 产线遥测"列为验证的一层）。
 *
 * 三类记录与被测行为的对应：
 * - `outcome: 'waited'` —— 真的等了；
 * - `outcome: 'skipped'` —— 插件报存活、引擎却没等（预算用尽 / 空阶梯 / 被中断）；
 * - **一条都不发** —— 探测为静默（没有存活任务）。那是常态：每一步都会走到那条分支，
 *   落事件只会把明细淹掉；要分母用 `turn.end` 的 `step`。
 */
describe('闸门遥测：agent.step.gate（bus）', () => {
  it('真的等了 ⇒ outcome=waited，且与 step_gate 流事件描述同一件事', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([9])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      // 档位 60ms、切片 20ms ⇒ 每档恰好 3 片
      stepGate: { ladderMs: [60], maxTotalMs: 10_000, sliceMs: 20 },
    })
    h.tools.register(echoTool)
    const records = watchGateBus(h)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 5))
    await flushBus()
    const gates = events.filter((e) => e.type === 'step_gate')

    expect(records).toHaveLength(2)
    expect(records.map((r) => r.outcome)).toEqual(['waited', 'waited'])
    expect(records.map((r) => r.waitMs)).toEqual([60, 60])
    // slices 说明"引擎问了几次" —— 探测次数就是 gate hook 实现的成本量级
    expect(records.map((r) => r.slices)).toEqual([3, 3])
    expect(records.map((r) => r.sliceMs)).toEqual([20, 20])
    expect(records.map((r) => r.waitedMs)).toEqual([60, 120])
    expect(records.map((r) => r.attempt)).toEqual([1, 2])
    expect(records.map((r) => r.aliveCount)).toEqual([9, 9])
    // 真等满了 ⇒ 不该有 plannedMs（它只在"被提前结束"时出现）
    expect(records.map((r) => r.plannedMs)).toEqual([undefined, undefined])
    expect(records.map((r) => r.skipReason)).toEqual([undefined, undefined])
    // 会话/Agent 归属：telemetry 靠这两个字段决定落哪个 run/session 文件
    expect(records.map((r) => r.sessionId)).toEqual([sess.id, sess.id])
    expect(records.map((r) => r.agentId)).toEqual(['default', 'default'])
    // 步号：第 1 条是"跑完第 1 步、要开第 2 步"
    expect(records.map((r) => [r.step, r.nextStep])).toEqual([[1, 2], [2, 3]])
    // 两条通道对同一件事的描述必须一致 —— 否则消费方会各算各的
    expect(records.map((r) => r.waitMs)).toEqual(gates.map((g) => g.gate?.waitMs))
    expect(records.map((r) => r.slices)).toEqual(gates.map((g) => g.gate?.slices))
    await h.stop()
  })

  it('被切片提前结束 ⇒ waitMs < plannedMs（"省掉了多少等待"因此可算）', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([2, 0])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [400], maxTotalMs: 10_000, sliceMs: 20 },
    })
    h.tools.register(echoTool)
    const records = watchGateBus(h)
    const sess = await h.session.create()

    await collect(h.session.promptStream(sess.id, 'go', 5))
    await flushBus()

    expect(records).toHaveLength(1)
    expect(records[0].outcome).toBe('waited')
    expect(records[0].waitMs).toBe(20)
    expect(records[0].plannedMs).toBe(400)
    expect(records[0].slices).toBe(1)
    await h.stop()
  })

  it('预算用尽 ⇒ 插件仍报存活却不再等：落 skipped(budget_exhausted) 并记下"没能等的那一档"', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), stepChunks('c'), finalChunks])
    const probe = gateProbe([9]) // 永远说"还有 9 个"（任务卡死 / 插件误报）
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      // 预算 12ms、每档 5ms ⇒ 前两次等得成（5 + 5 ≤ 12），第三次起 "本该等却没等"
      stepGate: { ladderMs: [5], maxTotalMs: 12 },
    })
    h.tools.register(echoTool)
    const records = watchGateBus(h)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 6))
    await flushBus()

    expect(records.map((r) => r.outcome)).toEqual(['waited', 'waited', 'skipped'])
    const last = records[2]
    expect(last.skipReason).toBe('budget_exhausted')
    expect(last.plannedMs).toBe(5) // 本可再等 5ms，预算不够了
    expect(last.waitMs).toBeUndefined() // 没等 ⇒ 不许有 waitMs（有它就是假信息）
    expect(last.waitedMs).toBe(10) // 累计仍是真等过的那 10ms
    expect(last.attempt).toBe(2) // 未递增（这一档没记账）
    expect(last.aliveCount).toBe(9)
    // 流事件只报"真的等了"的两次：界面不该显示"等待中"而实际没等
    expect(events.filter((e) => e.type === 'step_gate')).toHaveLength(2)
    await h.stop()
  })

  it('阶梯配成空数组 ⇒ 每步都 skipped(zero_ladder)：这是"等于关了等待"的配置错，必须看得见', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([9])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [] },
    })
    h.tools.register(echoTool)
    const records = watchGateBus(h)
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 5))
    await flushBus()

    expect(records).toHaveLength(2)
    expect(records.map((r) => r.skipReason)).toEqual(['zero_ladder', 'zero_ladder'])
    expect(records.map((r) => r.plannedMs)).toEqual([0, 0])
    expect(records.map((r) => r.outcome)).toEqual(['skipped', 'skipped'])
    // 一条流事件都没有：没等过就没有心跳，这与"界面安静但步数在烧"的真机现象一致
    expect(events.filter((e) => e.type === 'step_gate')).toHaveLength(0)
    await h.stop()
  })

  it('探测为静默 ⇒ 一条事件都不发（没有存活任务时的每一步都发会把明细淹掉）', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([0])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [5] },
    })
    h.tools.register(echoTool)
    const records = watchGateBus(h)
    const sess = await h.session.create()

    await collect(h.session.promptStream(sess.id, 'go', 5))
    await flushBus()

    expect(probe.probes).toBe(2) // 确实在每一步都探了
    expect(records).toHaveLength(0) // 但一条都不落
    await h.stop()
  })

  it('没有任何插件实现该 hook ⇒ 零事件（不产生新噪声）', async () => {
    const provider = scriptedProvider([stepChunks('a'), finalChunks])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const records = watchGateBus(h)
    const sess = await h.session.create()

    await collect(h.session.promptStream(sess.id, 'go', 3))
    await flushBus()

    expect(records).toHaveLength(0)
    await h.stop()
  })

  it('订阅者抛错不打断本轮：bus.publish 会把 AggregateError 抛回来，引擎侧必须自己吃掉', async () => {
    const provider = scriptedProvider([stepChunks('a'), stepChunks('b'), finalChunks])
    const probe = gateProbe([9])
    const h = await createHarness({
      agents: [agent],
      chatProvider: provider,
      internalPlugins: [probe],
      stepGate: { ladderMs: [5] },
    })
    h.tools.register(echoTool)
    // 订阅者之间互不影响、但失败会**抛给调用方**（不是"错误隔离"）：
    // 引擎侧若少了 `.catch`，一条写坏的遥测订阅者就能把 agent 主循环带下水。
    // 这条用例就是那个 `.catch` 的回归守卫（少了它会冒 unhandled rejection / 主循环中断）。
    h.bus.subscribe(AgentEvents.stepGate, () => {
      throw new Error('遥测订阅者炸了')
    })
    const sess = await h.session.create()

    const events = await collect(h.session.promptStream(sess.id, 'go', 5))
    await flushBus()

    expect(provider.calls).toBe(3) // 三步全跑完
    expect(events.filter((e) => e.type === 'step_gate')).toHaveLength(2) // 心跳照发
    expect(events.filter((e) => e.type === 'done')).toHaveLength(3)
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
