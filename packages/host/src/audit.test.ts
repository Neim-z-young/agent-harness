/**
 * `createAuditSink` 单元测试（M3 `decision.human` 落盘）。
 *
 * 覆盖点对应文件头的四条语义：按会话落盘 / 无 sessionId 丢弃 / 目录自建 / 失败静默。
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditSink } from './audit'
import type { HumanDecisionEvent } from './permission'

function evt(over: Partial<HumanDecisionEvent> = {}): HumanDecisionEvent {
  return {
    schema: 'harness.audit.v1',
    kind: 'decision.human',
    ts: 1_700_000_000_000,
    sessionId: 's1',
    decisionPoint: 'core.permission.ask',
    tool: 'bash',
    stateHash: 'abc123',
    riskLevel: 'high',
    actionTaken: 'allow',
    responseMs: 1200,
    rememberScope: 'once',
    ...over,
  }
}

describe('createAuditSink', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audit-sink-')) })
  afterEach(() => { /* tmpdir 由系统回收 */ })

  it('按会话写 sessions/{id}.audit.jsonl，且内容是可解析的事件信封', () => {
    const sink = createAuditSink(dir)
    sink(evt({ sessionId: 'sessA', tool: 'write_file', riskLevel: 'high' }))
    const file = join(dir, 'sessions', 'sessA.audit.jsonl')
    expect(existsSync(file)).toBe(true)
    const line = readFileSync(file, 'utf8').trim()
    const parsed = JSON.parse(line) as HumanDecisionEvent
    expect(parsed.tool).toBe('write_file')
    expect(parsed.riskLevel).toBe('high')
    expect(parsed.schema).toBe('harness.audit.v1')
  })

  it('无 sessionId 的事件直接丢弃（不建任何文件）', () => {
    const sink = createAuditSink(dir)
    sink(evt({ sessionId: undefined }))
    expect(existsSync(join(dir, 'sessions'))).toBe(false)
  })

  it('多会话各写各的文件（同一 sink 实例）', () => {
    const sink = createAuditSink(dir)
    sink(evt({ sessionId: 'a' }))
    sink(evt({ sessionId: 'b' }))
    sink(evt({ sessionId: 'a' }))
    const files = readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.audit.jsonl')).sort()
    expect(files).toEqual(['a.audit.jsonl', 'b.audit.jsonl'])
    expect(readFileSync(join(dir, 'sessions', 'a.audit.jsonl'), 'utf8').trim().split('\n').length).toBe(2)
  })

  it('sessions 目录不存在时自动创建（无需调用方预建）', () => {
    // 上面的用例已隐含验证；这里显式断言 dataDir 本身不存在时报错 → 由 mkdir -p 兜住
    const nested = join(dir, 'deep', 'data')
    const sink = createAuditSink(nested)
    sink(evt({ sessionId: 's' }))
    expect(existsSync(join(nested, 'sessions', 's.audit.jsonl'))).toBe(true)
  })

  it('落盘失败静默（dataDir 位置是个文件 ⇒ mkdir 失败，不抛给调用方）', () => {
    const asFile = join(dir, 'not-a-dir')
    writeFileSync(asFile, 'x')
    const sink = createAuditSink(asFile)
    // 关键：不抛。审计是旁路，写不进去不该让已经做出的决策失败。
    expect(() => sink(evt({ sessionId: 's' }))).not.toThrow()
  })

  it('零内容约束：写入行不含入参原文（事件信封只有标量 + stateHash）', () => {
    const sink = createAuditSink(dir)
    sink(evt({ sessionId: 's', stateHash: 'deadbeef' }))
    const text = readFileSync(join(dir, 'sessions', 's.audit.jsonl'), 'utf8')
    // 信封本身不含 input 字段 —— 入参只以哈希形式出现
    expect(text).not.toContain('"input"')
    expect(text).toContain('deadbeef')
  })
})
