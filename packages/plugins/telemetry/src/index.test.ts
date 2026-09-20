import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryBus, BusEvent } from '@harness/bus'
import { makeEnvelope, pickMetrics, pickAttrs, extractIdentity } from './envelope.js'
import { createJsonlWriter } from './writer.js'
import { mapBusEvent } from './map.js'
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
    expect(extractIdentity({ id: 'x' })).toEqual({ sessionId: 'x' })
    expect(extractIdentity('nope')).toEqual({})
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
  test('普通事件 → telemetry.bus.<name>，提取 session/metrics', () => {
    const rec = { name: 'tool.enabled', payload: { id: 'bash', agentId: 'd' }, timestamp: 7, source: 'tools' }
    const ev = mapBusEvent(rec)
    expect(ev.kind).toBe('telemetry.bus.tool.enabled')
    expect(ev.ts).toBe(7)
    expect(ev.attrs.sessionId).toBe('bash')
    expect(ev.attrs.source).toBe('tools')
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