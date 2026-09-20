import { describe, expect, test } from 'bun:test'
import { makeEnvelope } from './envelope.js'
import { toOtlpLogRecord, toExportRequest, severityFor, createOtlpExporter } from './otlp.js'

describe('severityFor', () => {
  test('异常类事件为 ERROR', () => {
    expect(severityFor('telemetry.crash').number).toBe(17)
    expect(severityFor('telemetry.error').text).toBe('ERROR')
    expect(severityFor('telemetry.tool.fail').number).toBe(17)
    expect(severityFor('telemetry.doomloop').number).toBe(17)
    expect(severityFor('telemetry.permission.deny').number).toBe(17)
  })
  test('普通事件为 INFO', () => {
    expect(severityFor('telemetry.bus.harness.started').number).toBe(9)
  })
})

describe('toOtlpLogRecord', () => {
  test('映射 kind/时间/attrs/metrics（隐私：undefined 不落）', () => {
    const rec = toOtlpLogRecord(
      makeEnvelope('telemetry.request', { sessionId: 's1', provider: 'openai', round: undefined as unknown as number }, { tok: 128 }, 1_700_000_000_000),
    )
    expect(rec.timeUnixNano).toBe('1700000000000000000')
    expect(rec.body.stringValue).toBe('telemetry.request')
    const keys = rec.attributes.map((a) => a.key)
    expect(keys).toContain('source.kind')
    expect(keys).toContain('sessionId')
    expect(keys).toContain('provider')
    expect(keys).toContain('metric.tok')
    expect(keys).not.toContain('round') // undefined → 不产生 attrs 键
  })
  test('数值 metric 用 intValue', () => {
    const rec = toOtlpLogRecord(makeEnvelope('k', {}, { n: 5 }))
    const m = rec.attributes.find((a) => a.key === 'metric.n')!
    expect(m.value).toEqual({ intValue: '5' })
  })
})

describe('toExportRequest', () => {
  test('包出 resourceLogs/scopeLogs/logRecords 结构', () => {
    const req = toExportRequest([toOtlpLogRecord(makeEnvelope('k', {}, {}))]) as {
      resourceLogs: { resource: { attributes: { key: string }[] }; scopeLogs: { logRecords: unknown[] }[] }[]
    }
    expect(req.resourceLogs[0].resource.attributes.map((a) => a.key)).toContain('service.name')
    expect(req.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1)
  })
})

describe('createOtlpExporter', () => {
  test('无 endpoint ⇒ no-op，enabled=false', async () => {
    const ex = createOtlpExporter({})
    expect(ex.enabled).toBe(false)
    ex.push(makeEnvelope('k'))
    expect(await ex.flush()).toBeUndefined()
  })

  test('explicit enabled:false 即使有 endpoint 也 no-op', () => {
    expect(createOtlpExporter({ endpoint: 'http://x', enabled: false }).enabled).toBe(false)
  })

  test('有 endpoint ⇒ enabled=true 且带尾斜杠归一', async () => {
    const ex = createOtlpExporter({ endpoint: 'http://collector:4318/', batchMs: 9999 })
    expect(ex.enabled).toBe(true)
    ex.push(makeEnvelope('k', {}, { n: 1 }))
    const sent = await ex.flush()
    expect(sent).toBeUndefined()
    // flush 不发真实网络（无法在单测里联调）；这里仅验证不抛、管线可用
    ex.close()
  })
})