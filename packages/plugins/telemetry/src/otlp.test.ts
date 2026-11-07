import { describe, expect, test } from 'bun:test'
import { makeEnvelope } from './envelope.js'
import { toOtlpLogRecord, toExportRequest, severityFor, createOtlpExporter, normalizeEndpoint, type OtlpFetch } from './otlp.js'

/** 从请求体里数出这批记录条数（顺带证明 body 是合法 JSON 的 OTLP 请求） */
function recordCount(body: string): number {
  const parsed = JSON.parse(body) as { resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[] }
  return parsed.resourceLogs[0].scopeLogs[0].logRecords.length
}

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

describe('normalizeEndpoint', () => {
  test('去空白与尾斜杠；空白串 ⇒ undefined（不再"看着有值"却拼出坏 URL）', () => {
    expect(normalizeEndpoint('http://c:4318/')).toBe('http://c:4318')
    expect(normalizeEndpoint('http://c:4318///')).toBe('http://c:4318')
    expect(normalizeEndpoint('  http://c:4318  ')).toBe('http://c:4318')
    expect(normalizeEndpoint('   ')).toBeUndefined()
    expect(normalizeEndpoint('')).toBeUndefined()
    expect(normalizeEndpoint(undefined)).toBeUndefined()
  })
})

describe('createOtlpExporter', () => {
  test('无 endpoint ⇒ no-op，enabled=false，统计全 0', async () => {
    const ex = createOtlpExporter({})
    expect(ex.enabled).toBe(false)
    ex.push(makeEnvelope('k'))
    expect(await ex.flush()).toBeUndefined()
    expect(ex.stats).toEqual({ sent: 0, failed: 0, dropped: 0 })
  })

  test('explicit enabled:false 即使有 endpoint 也 no-op', () => {
    expect(createOtlpExporter({ endpoint: 'http://x', enabled: false }).enabled).toBe(false)
  })

  test('endpoint 只有空白 ⇒ no-op（旧写法按 `length !== 0` 判，空白串会拼出 `" /v1/logs"`）', () => {
    expect(createOtlpExporter({ endpoint: '   ' }).enabled).toBe(false)
  })

  test('端到端 URL = 归一后的端点 + /v1/logs，且 2xx 计入 sent', async () => {
    const urls: string[] = []
    const ex = createOtlpExporter({
      endpoint: 'http://collector:4318///',
      batchMs: 60_000,
      fetchImpl: async (url) => {
        urls.push(url)
        return { ok: true, status: 200 }
      },
    })
    expect(ex.enabled).toBe(true)
    ex.push(makeEnvelope('k', {}, { n: 1 }))
    ex.push(makeEnvelope('k', {}, { n: 2 }))
    await ex.flush()
    expect(urls).toEqual(['http://collector:4318/v1/logs'])
    expect(ex.stats).toEqual({ sent: 2, failed: 0, dropped: 0 })
    ex.close()
  })

  test('非 2xx 计入 failed（此前根本没看 res.ok，4xx/5xx 一律当成功且无任何痕迹）', async () => {
    const ex = createOtlpExporter({
      endpoint: 'http://collector:4318',
      batchMs: 60_000,
      fetchImpl: async () => ({ ok: false, status: 401 }),
    })
    ex.push(makeEnvelope('k'))
    await ex.flush()
    expect(ex.stats).toEqual({ sent: 0, failed: 1, dropped: 0 })
    ex.close()
  })

  test('fetch 抛错（网络/超时）计入 failed，不向外抛', async () => {
    const ex = createOtlpExporter({
      endpoint: 'http://collector:4318',
      batchMs: 60_000,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    ex.push(makeEnvelope('k'))
    expect(await ex.flush()).toBeUndefined()
    expect(ex.stats.failed).toBe(1)
    ex.close()
  })

  test('flush 的 await 期间 push 的事件不会被丢（旧实现 `await send(pending); pending = []` 会清掉）', async () => {
    const batches: number[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fetchImpl: OtlpFetch = async (_url, init) => {
      batches.push(recordCount(init.body))
      await gate
      return { ok: true, status: 200 }
    }
    const ex = createOtlpExporter({ endpoint: 'http://c', batchMs: 60_000, fetchImpl })

    ex.push(makeEnvelope('a'))
    const inflight = ex.flush() // 第 1 批卡在 gate 里
    ex.push(makeEnvelope('b')) // 落在 await 窗口内
    release()
    await inflight
    await ex.flush() // 第 2 批必须把 b 发出去

    expect(batches).toEqual([1, 1])
    ex.close()
  })

  test('close 把最后一批尽力发出，之后拒收并计入 dropped', async () => {
    const batches: number[] = []
    const ex = createOtlpExporter({
      endpoint: 'http://c',
      batchMs: 60_000,
      fetchImpl: async (_url, init) => {
        batches.push(recordCount(init.body))
        return { ok: true, status: 200 }
      },
    })
    ex.push(makeEnvelope('x'))
    ex.close()
    // 请求在 close() 内同步发出（fetch 的调用本身是同步的，只有结算才是异步的）
    expect(batches).toEqual([1])
    ex.push(makeEnvelope('y'))
    expect(ex.stats.dropped).toBe(1)
    // 再 close 一次是幂等的，不会重复发
    ex.close()
    expect(batches).toEqual([1])
  })
})