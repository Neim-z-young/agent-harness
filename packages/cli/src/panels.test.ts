/**
 * M4 面板纯函数测试：审计日志解析（放行率/responseMs/风险分布/时间线）+ bench summary/history 解析。
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAuditLog, parseBenchHistory, parseBenchSummary, loadBenchHistory, auditPanelLines, benchPanelLines } from './panels'

describe('parseAuditLog · 审计汇总', () => {
  const base = (suffix: object = {}) => ({
    schema: 'harness.audit.v1', kind: 'decision.human', ts: 1000,
    tool: 'bash', riskLevel: 'high', actionTaken: 'allow', responseMs: 20, rememberScope: 'once',
    ...suffix,
  })

  it('空文本 → 0 决策', () => {
    const s = parseAuditLog('')
    expect(s.total).toBe(0)
    expect(s.allowRate).toBe(0)
    expect(s.timeline).toEqual([])
  })

  it('放行率 = (allow + always-allow) / 有效数；拒绝不算放行', () => {
    const text = [
      JSON.stringify(base({ actionTaken: 'allow' })),
      JSON.stringify(base({ actionTaken: 'deny' })),
      JSON.stringify(base({ actionTaken: 'always-allow', responseMs: 99 })),
      JSON.stringify(base({ actionTaken: 'always-deny' })),
    ].join('\n')
    const s = parseAuditLog(text)
    expect(s.total).toBe(4)
    expect(s.allowRate).toBe(0.5) // allow + always-allow = 2/4
  })

  it('responseMs：平均与中位（偶数个取均值）', () => {
    const text = [20, 40, 60, 80].map((ms, i) => JSON.stringify(base({ responseMs: ms, ts: i }))).join('\n')
    const s = parseAuditLog(text)
    expect(s.avgResponseMs).toBe(50)
    expect(s.medianResponseMs).toBe(50)
    expect(s.lastResponseMs).toBe(80)
  })

  it('风险分布 + 时间线按 ts 升序', () => {
    const text = [
      JSON.stringify(base({ riskLevel: 'low', ts: 300 })),
      JSON.stringify(base({ riskLevel: 'high', ts: 100 })),
      JSON.stringify(base({ riskLevel: 'medium', ts: 200 })),
    ].join('\n')
    const s = parseAuditLog(text)
    expect(s.riskCounts).toEqual({ low: 1, high: 1, medium: 1 })
    expect(s.timeline.map((d) => d.ts)).toEqual([100, 200, 300])
  })

  it('非法行 / 非 decision.human / 缺 responseMs 计入 malformed 不计入 total', () => {
    const text = [
      'not-json',
      JSON.stringify({ kind: 'other', ts: 1, responseMs: 2 }),
      JSON.stringify(base({ responseMs: undefined })),
      JSON.stringify(base({})),
    ].join('\n')
    const s = parseAuditLog(text)
    expect(s.total).toBe(1) // 只有最后一行完整
    expect(s.malformed).toBe(2) // not-json + responseMs 被 stringify 丢字段
  })
})

describe('parseBenchSummary / parseBenchHistory · 跑分', () => {
  const summary = {
    meta: { domain: 'retail', split: 'test', model: 'gpt-4o', userModel: 'gpt-4o', k: 3 },
    numTasks: 10,
    passAtK: { 1: 0.5, 2: 0.4, 3: 0.3 },
    avgReward: 0.42,
    avgLatencyMs: 1234,
  }

  it('单份 summary：pass1 与 passK（取 k 对应档）', () => {
    const r = parseBenchSummary(JSON.stringify(summary))!
    expect(r).not.toBeNull()
    expect(r.pass1).toBe(0.5)
    expect(r.passK).toBe(0.3) // k=3 → passAtK['3']
    expect(r.avgReward).toBe(0.42)
    expect(r.avgLatencyMs).toBe(1234)
  })

  it('k 缺省或 passK 档缺时为 pass1 兜底', () => {
    const noK = parseBenchSummary(JSON.stringify({ meta: { model: 'x' }, passAtK: { 1: 0.7 } }))!
    expect(noK.passK).toBe(0.7)
  })

  it('非法 JSON → null', () => {
    expect(parseBenchSummary('nope')).toBeNull()
  })

  it('history.jsonl：逐行解析，保持顺序', () => {
    const text = [
      JSON.stringify({ ...summary, meta: { ...summary.meta, model: 'm1' } }),
      JSON.stringify({ ...summary, meta: { ...summary.meta, model: 'm2' } }),
      'garbage-line',
    ].join('\n')
    const h = parseBenchHistory(text)
    expect(h).toHaveLength(2)
    expect(h.map((r) => r.model)).toEqual(['m1', 'm2'])
  })

  it('loadBenchHistory：读磁盘 history.jsonl；文件缺失返回空 + error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'benchhist-'))
    const empty = loadBenchHistory(dir)
    expect(empty.history).toEqual([])
    expect(empty.error).toBeTruthy()
    mkdirSync(join(dir, 'bench'), { recursive: true })
    writeFileSync(join(dir, 'bench', 'history.jsonl'), JSON.stringify(summary) + '\n')
    expect(loadBenchHistory(dir).history).toHaveLength(1)
  })
})

describe('面板渲染行', () => {
  it('auditPanelLines：无决策给引导文案', () => {
    expect(auditPanelLines(parseAuditLog(''))[0]).toContain('暂无')
  })
  it('auditPanelLines：含放行率/响应/风险/时间线行', () => {
    const text = [
      JSON.stringify({ schema: 'x', kind: 'decision.human', ts: 1700000000000, tool: 'write_file', riskLevel: 'high', actionTaken: 'allow', responseMs: 25, rememberScope: 'once' }),
      JSON.stringify({ schema: 'x', kind: 'decision.human', ts: 1700000006000, tool: 'read_file', riskLevel: 'low', actionTaken: 'deny', responseMs: 15, rememberScope: 'once' }),
    ].join('\n')
    const lines = auditPanelLines(parseAuditLog(text))
    expect(lines[0]).toContain('放行率 50%')
    expect(lines[1]).toContain('20ms 均')
    expect(lines[2]).toContain('高1 中0 低1')
    expect(lines.some((l) => l.includes('✓放行') && l.includes('write_file'))).toBe(true)
    expect(lines.some((l) => l.includes('✗拒绝') && l.includes('read_file'))).toBe(true)
  })
  it('benchPanelLines：无数据给引导；有数据显示 pass^1 与模型', () => {
    expect(benchPanelLines([])[0]).toContain('未发现')
    const history = [{
      model: 'gpt-4o', userModel: 'gpt-4o', split: 'test', k: 3, pass1: 0.5, passK: 0.3, avgReward: 0.4, avgLatencyMs: 2000,
    }]
    const lines = benchPanelLines(history)
    expect(lines[0]).toContain('跑分 1 次')
    expect(lines[1]).toContain('gpt-4o test k3')
    expect(lines[1]).toContain('50%')
  })
})