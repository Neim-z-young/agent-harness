import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryBus, BusEvent } from '@harness/bus'
import { makeEnvelope, pickMetrics, pickAttrs, extractIdentity } from './envelope.js'
import { createJsonlWriter } from './writer.js'
import { mapBusEvent, toolFailureEnvelope, turnEndEnvelope, paramsMissingEnvelope, stepEmptyEnvelope, whitelistBlockedEnvelope } from './map.js'
import { createTelemetryService, deriveUserID, stackHashStack } from './index.js'

describe('envelope', () => {
  test('makeEnvelope 归一化 schema/ts', () => {
    const ev = makeEnvelope('telemetry.request', { sessionId: 's1' }, { tok: 10 }, 5)
    expect(ev.schema).toBe(1)
    expect(ev.ts).toBe(5)
    expect(ev.attrs.sessionId).toBe('s1')
    expect(ev.metrics.tok).toBe(10)
  })

  test('pickMetrics 只取有限数值', () => {
    expect(pickMetrics({ a: 1, b: 'x', c: NaN, d: Infinity })).toEqual({ a: 1 })
  })

  test('pickAttrs 提取字符串/数值并归一 sessionId 别名', () => {
    const attrs = pickAttrs({ sessionId: 's', id: 'sid2', provider: 'openai' })
    expect(attrs.sessionId).toBe('s')
    expect(attrs.provider).toBe('openai')
  })

  test('extractIdentity 从载荷挑 sessionId/agentId', () => {
    expect(extractIdentity({ session_id: 'a', agent_id: 'ag' })).toEqual({ sessionId: 'a', agentId: 'ag' })
    expect(extractIdentity({ sessionId: 's' })).toEqual({ sessionId: 's' })
    expect(extractIdentity({ id: 'x' })).toEqual({}) // 任意 id 不当 sessionId（防 tool/plugin id 污染）
    expect(extractIdentity('nope')).toEqual({})
  })

  test('布尔折叠为 0/1：此前被静默丢弃（aborted / background / isContinuation 一直在丢）', () => {
    // 回归：pickMetrics / pickAttrs 原本只收 string|number ⇒ 载荷里的布尔字段**整条消失**，
    // 消费方只能把"字段不存在"当 false，分不清"真是 false"与"压根没采到"。
    expect(pickMetrics({ aborted: true, cacheHit: false, n: 5 })).toEqual({ aborted: 1, cacheHit: 0, n: 5 })
    expect(pickAttrs({ background: true, isContinuation: false, provider: 'openai' }))
      .toEqual({ background: 1, isContinuation: 0, provider: 'openai' })
  })

  test('布尔折叠不放宽其它类型：空串 / null / 对象 / NaN 一律仍丢弃', () => {
    expect(pickMetrics({ a: null, b: {}, c: [], d: NaN, e: Infinity })).toEqual({})
    expect(pickAttrs({ s: '', o: { x: 1 }, n: null })).toEqual({})
  })
})

describe('writer', () => {
  let dir: string
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'tel-'))))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('no-path 为 no-op 且 disabled', () => {
    const w = createJsonlWriter<{ a: number }>(undefined)
    expect(w.enabled).toBe(false)
    w.write({ a: 1 })
    w.flush()
  })

  test('写入与 flush 落盘一行一对象', () => {
    const p = join(dir, 'a.jsonl')
    const w = createJsonlWriter<{ a: number }>(p, 50)
    w.write({ a: 1 })
    w.write({ a: 2 })
    w.flush()
    const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { a: number })
    expect(lines).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('flush 后再次 write 追加而非覆盖', () => {
    const p = join(dir, 'b.jsonl')
    const w = createJsonlWriter<{ a: number }>(p, 50)
    w.write({ a: 1 })
    w.flush()
    w.write({ a: 2 })
    w.flush()
    const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { a: number })
    expect(lines).toEqual([{ a: 1 }, { a: 2 }])
  })
})

describe('mapBusEvent', () => {
  test('普通事件 → telemetry.bus.<name>，tool.enabled 的 id 不顶 sessionId', () => {
    const rec = { name: 'tool.enabled', payload: { id: 'bash', agentId: 'd' }, timestamp: 7, source: 'tools' }
    const ev = mapBusEvent(rec)
    expect(ev.kind).toBe('telemetry.bus.tool.enabled')
    expect(ev.ts).toBe(7)
    expect(ev.attrs.sessionId).toBeUndefined() // tool id 不再被当成 sessionId（防会话文件错乱）
    expect(ev.attrs.source).toBe('tools')
  })

  test('带真实 sessionId 的事件会提取到 sessionId', () => {
    const rec = { name: 'core.agent.turn.end', payload: { sessionId: 's_1', step: 3 }, timestamp: 9 }
    const ev = mapBusEvent(rec)
    expect(ev.attrs.sessionId).toBe('s_1')
    expect(ev.metrics.step).toBe(3)
  })

  test('harness.error → telemetry.error', () => {
    const rec = { name: 'harness.error', payload: { stage: 'start', error: new Error('boom') }, timestamp: 1 }
    const ev = mapBusEvent(rec)
    expect(ev.kind).toBe('telemetry.error')
    expect(ev.attrs.stage).toBe('start')
  })
})

describe('createTelemetryService', () => {
  let dir: string
  let bus: InMemoryBus
  const Started = BusEvent.define<{ durationMs: number }>('harness.started')

  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'tel-svc-'))))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const pathBuilder = (sid: string | undefined) => join(dir, 'sessions', `${sid ?? 'run'}.telemetry.jsonl`)

  test('record 按 sessionId 落会话文件，含匿名 user id', async () => {
    const svc = createTelemetryService({ enabled: true, dataDir: dir, pathBuilder })
    // 直接调用 controller 验证落盘（插件 install 接线由 cli 宿主负责）
    svc.telemetry.record('telemetry.session.start', { sessionId: 'sessA', round: 1 }, { durationMs: 12 })
    svc.telemetry.flush()
    const p = pathBuilder('sessA')
    expect(existsSync(p)).toBe(true)
    const line = JSON.parse(readFileSync(p, 'utf8')) as { kind: string; attrs: Record<string, unknown> }
    expect(line.kind).toBe('telemetry.session.start')
    expect(line.attrs.sessionId).toBe('sessA')
    expect(typeof line.attrs.userID).toBe('string')
    expect(line.attrs.userID).toHaveLength(24)
  })

  test('关闭时 record 为 no-op（不写盘）', () => {
    const p = join(dir, 'off.jsonl')
    const svc = createTelemetryService({ enabled: false, pathBuilder: () => p })
    svc.telemetry.record('telemetry.x', {}, {})
    svc.telemetry.flush()
    expect(existsSync(p)).toBe(false)
  })

  test('controller.enabled 反映开关', () => {
    expect(createTelemetryService({ enabled: true }).telemetry.enabled).toBe(true)
    expect(createTelemetryService({ enabled: false }).telemetry.enabled).toBe(false)
  })
})

describe('misc helpers', () => {
  test('deriveUserID 稳定且确定性', () => {
    const a = deriveUserID('/tmp/nonexist-dir-x')
    const b = deriveUserID('/tmp/nonexist-dir-x')
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  test('stackHashStack 截断并出哈希，不抛', () => {
    const r = stackHashStack('line1\nline2\nelse'.repeat(500))
    expect(r.hash).toBeTruthy()
    expect(r.trace!.length).toBeLessThanOrEqual(2048)
  })

  test('makeEnvelope 隐私：undefined 不残留', () => {
    const ev = makeEnvelope('k', { sessionId: undefined, provider: 'p' }, { n: undefined as unknown as number })
    expect(Object.values(ev.attrs).join('')).toContain('p')
    expect(JSON.stringify(ev).includes('undefined')).toBe(false)
  })
})

describe('toolFailureEnvelope（异常场景专项埋点）', () => {
  const ctx = { tool: { id: 'bash' } }

  test('成功 ok=true ⇒ null（不埋点）', () => {
    expect(toolFailureEnvelope(ctx, { ok: true })).toBeNull()
  })

  test('普通失败 ⇒ telemetry.tool.fail', () => {
    const ev = toolFailureEnvelope(ctx, { ok: false, error: { code: 'TOOL_ERROR' }, meta: { durationMs: 12 } })
    expect(ev!.kind).toBe('telemetry.tool.fail')
    expect(ev!.attrs.toolId).toBe('bash')
    expect(ev!.attrs.errName).toBe('TOOL_ERROR')
    expect(ev!.metrics.durationMs).toBe(12)
  })

  test('权限拒绝 ⇒ telemetry.permission.deny', () => {
    const ev = toolFailureEnvelope(ctx, { ok: false, error: { code: 'PERMISSION_DENIED' } })!
    expect(ev.kind).toBe('telemetry.permission.deny')
    expect(ev.attrs.errName).toBe('ToolPermissionDeniedError')
  })

  test('DOOM_LOOP ⇒ telemetry.doomloop', () => {
    const ev = toolFailureEnvelope(ctx, { ok: false, error: { code: 'DOOM_LOOP' } })!
    expect(ev.kind).toBe('telemetry.doomloop')
    expect(ev.attrs.toolId).toBe('bash')
  })

  test('result 为空 ⇒ null', () => {
    expect(toolFailureEnvelope(ctx, undefined)).toBeNull()
  })

  test('带上 ctx 的会话归属（否则事件会落到 run 级文件、会话取证永远看不到）', () => {
    // 回归：此前不带 sessionId ⇒ TelemetryService.persist 走 switchWriter(undefined)
    // ⇒ 全落 run.telemetry.jsonl。实测 79 条 tool.fail 的 sessionId 全为 undefined，
    // 9 个会话文件合计 0 条 —— 按会话取证时工具失败完全不可见。
    const withCtx = {
      tool: { id: 'grep_file' },
      ctx: { sessionId: 's_123', agentId: 'reader' },
    }
    const ev = toolFailureEnvelope(withCtx, { ok: false, error: { code: 'TOOL_ERROR' } })!
    expect(ev.attrs.sessionId).toBe('s_123')
    expect(ev.attrs.agentId).toBe('reader')
    expect(ev.attrs.toolId).toBe('grep_file')
  })
})

describe('turnEndEnvelope（整轮终态 / 额度口径）', () => {
  test('落 telemetry.turn.end，带 step 与派生的 billedSteps', () => {
    const ev = turnEndEnvelope({
      agentId: 'lead',
      agentName: 'Lead',
      mode: 'primary',
      sessionId: 's_1',
      step: 12,
      finish: 'stop',
    })!
    expect(ev.kind).toBe('telemetry.turn.end')
    expect(ev.attrs.sessionId).toBe('s_1')
    expect(ev.attrs.agentId).toBe('lead')
    expect(ev.attrs.mode).toBe('primary')
    expect(ev.attrs.finish).toBe('stop')
    expect(ev.metrics.step).toBe(12)
    // 没有免计步时 billedSteps === step（额度口径与展示步号一致）
    expect(ev.metrics.billedSteps).toBe(12)
    expect(ev.metrics.freeSteps).toBeUndefined() // 0 不落无用字段
  })

  test('freeSteps > 0 时 step 与 billedSteps 分叉（观察点 9 之后这是常态，不是 bug）', () => {
    const ev = turnEndEnvelope({ agentId: 'lead', sessionId: 's_2', step: 30, freeSteps: 3 })!
    expect(ev.metrics.step).toBe(30)
    expect(ev.metrics.freeSteps).toBe(3)
    expect(ev.metrics.billedSteps).toBe(27) // 只烧了 27 步额度
  })

  test('aborted 折叠为 1（布尔会被提取器折叠，不会静默丢）', () => {
    const ev = turnEndEnvelope({ agentId: 'lead', sessionId: 's_3', step: 4, aborted: true })!
    expect(ev.metrics.aborted).toBe(1)
    const ok = turnEndEnvelope({ agentId: 'lead', sessionId: 's_3', step: 4 })!
    expect(ok.metrics.aborted).toBeUndefined()
  })

  test('子 Agent 的轮也落盘，靠 mode 区分（引擎不做"哪轮算用户的轮"的判断）', () => {
    const ev = turnEndEnvelope({ agentId: 'reader', mode: 'subagent', sessionId: 's_sub', step: 35 })!
    expect(ev.attrs.mode).toBe('subagent')
  })

  test('缺 sessionId 不丢事件（落到 run 级文件，不静默吞掉轮数）', () => {
    const ev = turnEndEnvelope({ agentId: 'lead', step: 1 })!
    expect(ev).not.toBeNull()
    expect(ev.attrs.sessionId).toBeUndefined()
    expect(ev.metrics.step).toBe(1)
  })

  test('非法输入 ⇒ null', () => {
    expect(turnEndEnvelope(undefined)).toBeNull()
    expect(turnEndEnvelope('nope')).toBeNull()
  })
})

// --------------------------------------------------------------------------
// 批次 3 埋点：入参缺失（B2）、空步（C1）与白名单越界（C2）
//
// 这三条的共同前提是**三件套**：core 的 hook 只是事实源，没有落盘消费方就等于死代码
// —— 真机「开场 3 轮空转」之所以只能提出两种假设、无法证伪，正是因为两件都缺。
// --------------------------------------------------------------------------

describe('paramsMissingEnvelope（入参缺失型失败）', () => {
  test('落 telemetry.tool.params.missing，带工具 id 与缺参数个数', () => {
    const ev = paramsMissingEnvelope({ toolId: 'read_file', sessionId: 's_1', agentId: 'reader', step: 3, missingCount: 1 })!
    expect(ev.kind).toBe('telemetry.tool.params.missing')
    expect(ev.attrs.toolId).toBe('read_file')
    expect(ev.attrs.sessionId).toBe('s_1')
    expect(ev.metrics.step).toBe(3)
    expect(ev.metrics.missingCount).toBe(1)
  })

  test('不落任何入参/提示词正文（遥测红线）', () => {
    const ev = paramsMissingEnvelope({ toolId: 'read_file', sessionId: 's_1', step: 1, missingCount: 1 })!
    const dump = JSON.stringify(ev)
    expect(dump).not.toContain('path')
    // undefined 键在对象里存在、但 JSON.stringify 会丢 ⇒ 落盘面只看有值的键
    expect(Object.keys(ev.attrs).filter((k) => ev.attrs[k] !== undefined).sort()).toEqual(['sessionId', 'toolId'])
  })

  test('缺 toolId ⇒ null（无归属的事件不该落，否则计数对不上账）', () => {
    expect(paramsMissingEnvelope({ sessionId: 's_1', step: 1 })).toBeNull()
    expect(paramsMissingEnvelope(undefined)).toBeNull()
  })
})

describe('stepEmptyEnvelope（空步：一次完整 prompt 换来零产出）', () => {
  test('落 telemetry.step.empty，布尔折成 0/1 便于聚合', () => {
    const ev = stepEmptyEnvelope({ sessionId: 's_1', agentId: 'lead', step: 1, hasTokenUsage: false, aborted: false })!
    expect(ev.kind).toBe('telemetry.step.empty')
    expect(ev.attrs.sessionId).toBe('s_1')
    expect(ev.metrics.step).toBe(1)
    expect(ev.metrics.hasTokenUsage).toBe(0)
    expect(ev.metrics.aborted).toBe(0)
  })

  test('中断导致的空步单独标 1：不该被当成"模型没说话"计入浪费', () => {
    const ev = stepEmptyEnvelope({ sessionId: 's_1', step: 2, aborted: true })!
    expect(ev.metrics.aborted).toBe(1)
  })

  test('非法输入 ⇒ null', () => {
    expect(stepEmptyEnvelope(undefined)).toBeNull()
    expect(stepEmptyEnvelope('nope')).toBeNull()
  })
})

describe('whitelistBlockedEnvelope（白名单越界：能力边界事件，与工具自身报错不同类）', () => {
  test('落 telemetry.tool.whitelist.blocked，带工具 id 与步号', () => {
    const ev = whitelistBlockedEnvelope({ toolId: 'compress', sessionId: 's_1', agentId: 'reader-4', step: 9 })!
    expect(ev.kind).toBe('telemetry.tool.whitelist.blocked')
    expect(ev.attrs.toolId).toBe('compress')
    expect(ev.attrs.agentId).toBe('reader-4')
    expect(ev.metrics.step).toBe(9)
  })

  test('不落入参/提示词正文（遥测红线）', () => {
    const ev = whitelistBlockedEnvelope({ toolId: 'compress', sessionId: 's_1', step: 1 })!
    expect(Object.keys(ev.attrs).filter((k) => ev.attrs[k] !== undefined).sort()).toEqual(['sessionId', 'toolId'])
  })

  test('缺 toolId ⇒ null（无归属的事件不该落）', () => {
    expect(whitelistBlockedEnvelope({ sessionId: 's_1', step: 1 })).toBeNull()
    expect(whitelistBlockedEnvelope(undefined)).toBeNull()
  })
})

describe('turnEndEnvelope：emptySteps 整轮汇总', () => {
  test('有空步时落 emptySteps（区分「模型零产出」与「整轮没跑起来」）', () => {
    const ev = turnEndEnvelope({ agentId: 'lead', sessionId: 's_4', step: 1, emptySteps: 1 })!
    expect(ev.metrics.emptySteps).toBe(1)
    expect(ev.metrics.billedSteps).toBe(1)
  })

  test('无空步时不落该字段（0 值不占盘）', () => {
    const ev = turnEndEnvelope({ agentId: 'lead', sessionId: 's_5', step: 3 })!
    expect(ev.metrics.emptySteps).toBeUndefined()
  })
})

describe('telemetry 插件：三个新 hook 都真的落盘（不是只挂不消费的死 hook）', () => {
  let dir: string
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'tel-batch3-'))))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const readLines = (sid: string) =>
    readFileSync(join(dir, 'sessions', `${sid}.telemetry.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; attrs: Record<string, unknown>; metrics: Record<string, number> })

  test('core.tool.params.missing / core.step.empty / core.tool.whitelist.blocked 各自落一条会话级事件', async () => {
    const pathBuilder = (sid: string | undefined) => join(dir, 'sessions', `${sid ?? 'run'}.telemetry.jsonl`)
    const svc = createTelemetryService({ enabled: true, dataDir: dir, pathBuilder, crash: false })
    const bus = new InMemoryBus()
    const hooks = (await svc.plugin.install({ bus } as never)) as Record<string, ((s: unknown) => void) | undefined>

    expect(typeof hooks['core.tool.params.missing']).toBe('function')
    expect(typeof hooks['core.step.empty']).toBe('function')
    expect(typeof hooks['core.tool.whitelist.blocked']).toBe('function')

    hooks['core.tool.params.missing']!({ toolId: 'read_file', sessionId: 'sessB3', agentId: 'reader', step: 7, missingCount: 1 })
    hooks['core.step.empty']!({ sessionId: 'sessB3', agentId: 'lead', step: 1, hasTokenUsage: false, aborted: false })
    hooks['core.tool.whitelist.blocked']!({ toolId: 'compress', sessionId: 'sessB3', agentId: 'reader', step: 9 })
    svc.telemetry.flush()

    const kinds = readLines('sessB3').map((l) => l.kind)
    expect(kinds).toContain('telemetry.tool.params.missing')
    expect(kinds).toContain('telemetry.step.empty')
    expect(kinds).toContain('telemetry.tool.whitelist.blocked')
    await svc.plugin.uninstall?.()
  })
})

describe('telemetry 插件：core.agent.turn.end 落到会话文件', () => {
  let dir: string
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'tel-turnend-'))))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('注册该 hook 后，整轮终态按 sessionId 落会话级 JSONL', async () => {
    const pathBuilder = (sid: string | undefined) => join(dir, 'sessions', `${sid ?? 'run'}.telemetry.jsonl`)
    // crash: false —— 否则会往 process 上挂 SIGTERM/uncaughtException 处理器
    const svc = createTelemetryService({ enabled: true, dataDir: dir, pathBuilder, crash: false })
    const bus = new InMemoryBus()
    const hooks = (await svc.plugin.install({ bus } as never)) as {
      'core.agent.turn.end'?: (s: unknown) => void
    }
    expect(typeof hooks['core.agent.turn.end']).toBe('function')

    hooks['core.agent.turn.end']!({ agentId: 'lead', mode: 'primary', sessionId: 'sessT', step: 8, freeSteps: 2 })
    svc.telemetry.flush()

    const p = pathBuilder('sessT')
    expect(existsSync(p)).toBe(true)
    const line = JSON.parse(readFileSync(p, 'utf8').trim()) as {
      kind: string
      attrs: Record<string, unknown>
      metrics: Record<string, number>
    }
    expect(line.kind).toBe('telemetry.turn.end')
    expect(line.attrs.sessionId).toBe('sessT')
    expect(line.metrics.step).toBe(8)
    expect(line.metrics.freeSteps).toBe(2)
    expect(line.metrics.billedSteps).toBe(6)
    await svc.plugin.uninstall?.()
  })
})

/**
 * 闸门遥测（`agent.step.gate`）：**本包零改动**的自动入明细验证。
 *
 * core 把闸门每一步的处置发到 bus，`subscribeAll` 自动落成
 * `telemetry.bus.agent.step.gate`。这里刻意**不** import core 的类型 —— 事件按**名字**
 * 匹配，字段口径写成字面量即可；telemetry 是通用插件，不该依赖具体包。
 */
describe('闸门遥测：agent.step.gate 自动入明细', () => {
  let dir: string
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'tel-gate-'))))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const pathBuilder = () => (sid: string | undefined) => join(dir, 'sessions', `${sid ?? 'run'}.telemetry.jsonl`)
  const readLines = (sid: string | undefined) =>
    readFileSync(pathBuilder()(sid), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; attrs: Record<string, unknown>; metrics: Record<string, number> })

  test('waited 记录：数值进 metrics、枚举与归属进 attrs', async () => {
    const svc = createTelemetryService({ enabled: true, dataDir: dir, pathBuilder: pathBuilder(), crash: false })
    const bus = new InMemoryBus()
    await svc.plugin.install({ bus } as never)

    const StepGate = BusEvent.define<Record<string, unknown>>('agent.step.gate')
    await bus.publish(StepGate, {
      sessionId: 'sessG',
      agentId: 'lead',
      step: 3,
      nextStep: 4,
      attempt: 2,
      waitedMs: 9_000,
      outcome: 'waited',
      waitMs: 3_000,
      plannedMs: 6_000,
      slices: 6,
      sliceMs: 500,
      aliveCount: 2,
      reason: '2 个后台子任务仍在运行',
    }, { source: 'agent' })
    svc.telemetry.flush()

    const line = readLines('sessG').find((l) => l.kind === 'telemetry.bus.agent.step.gate')
    expect(line).toBeDefined()
    // 归属：telemetry 靠 sessionId 选文件
    expect(line!.attrs.sessionId).toBe('sessG')
    expect(line!.attrs.agentId).toBe('lead')
    // 枚举进 attrs（可分组、低基数）
    expect(line!.attrs.outcome).toBe('waited')
    expect(line!.attrs.reason).toBe('2 个后台子任务仍在运行')
    // 数值进 metrics（可求和）—— waitMs < plannedMs 即"被切片提前结束"
    expect(line!.metrics.waitMs).toBe(3_000)
    expect(line!.metrics.plannedMs).toBe(6_000)
    expect(line!.metrics.slices).toBe(6)
    expect(line!.metrics.waitedMs).toBe(9_000)
    expect(line!.metrics.aliveCount).toBe(2)
    await svc.plugin.uninstall?.()
  })

  test('overBudget 记录：布尔折叠成 0|1、waited 带 waitMs；skipReason 只有 zero_ladder 才会出现', async () => {
    const svc = createTelemetryService({ enabled: true, dataDir: dir, pathBuilder: pathBuilder(), crash: false })
    const bus = new InMemoryBus()
    await svc.plugin.install({ bus } as never)

    const StepGate = BusEvent.define<Record<string, unknown>>('agent.step.gate')
    // 超预算仍等待：outcome=waited + overBudget=true（预算=提醒阈值）。
    // overBudget 是布尔，落盘应折叠成 1（而不是被静默丢弃）。
    await bus.publish(StepGate, {
      sessionId: 'sessS',
      agentId: 'lead',
      step: 7,
      nextStep: 8,
      attempt: 5,
      waitedMs: 300_000,
      outcome: 'waited',
      waitMs: 60_000,
      overBudget: true,
      aliveCount: 3,
    }, { source: 'agent' })
    // 配错阶梯：skipped(zero_ladder)—— 预算耗尽不再产生 skipped，这是唯一合法 skipReason
    await bus.publish(StepGate, {
      sessionId: 'sessS',
      agentId: 'lead',
      step: 8,
      nextStep: 9,
      attempt: 1,
      waitedMs: 300_000,
      outcome: 'skipped',
      skipReason: 'zero_ladder',
      aliveCount: 3,
    }, { source: 'agent' })
    svc.telemetry.flush()

    const lines = readLines('sessS').filter((l) => l.kind === 'telemetry.bus.agent.step.gate')
    expect(lines).toHaveLength(2)
    const [over, skipped] = lines
    // 超预算那条：outcome=waited、带 waitMs、overBudget 折叠成 1
    expect(over!.attrs.outcome).toBe('waited')
    expect(over!.metrics.waitMs).toBe(60_000)
    expect(over!.metrics.overBudget).toBe(1)
    expect(over!.attrs.skipReason).toBeUndefined()
    // skipped 那条：只有 zero_ladder 是合法 skipReason
    expect(skipped!.attrs.outcome).toBe('skipped')
    expect(skipped!.attrs.skipReason).toBe('zero_ladder')
    expect(skipped!.metrics.waitMs).toBeUndefined() // 没等 ⇒ 不许有 waitMs
    await svc.plugin.uninstall?.()
  })
})