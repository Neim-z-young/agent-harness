/**
 * `createAuditSink` 单元测试（`decision.human` / `permission.rule.changed` 落盘）。
 *
 * 覆盖点对应文件头的语义：按会话落盘 / 无归属落工作区级文件 / 目录自建 / 失败静默 / 零内容。
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditSink } from './audit'
import type { AuditEvent, HumanDecisionEvent, PermissionRuleChangedEvent } from './permission'

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

function ruleEvt(over: Partial<PermissionRuleChangedEvent> = {}): PermissionRuleChangedEvent {
  return {
    schema: 'harness.audit.v1',
    kind: 'permission.rule.changed',
    ts: 1_700_000_000_001,
    source: 'control-api',
    stateHash: 'f00d',
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

  it('无 sessionId 的事件落**工作区级** {dataDir}/audit.jsonl（不再丢弃：规则变更可能无会话归属）', () => {
    const sink = createAuditSink(dir)
    sink(ruleEvt({ key: 'bash', behavior: 'deny' }))
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(true)
    // 不建 sessions/（该事件不可归属到任何会话）
    expect(existsSync(join(dir, 'sessions'))).toBe(false)
    const parsed = JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim()) as PermissionRuleChangedEvent
    expect(parsed.kind).toBe('permission.rule.changed')
    expect(parsed.source).toBe('control-api')
    expect(parsed.key).toBe('bash')
    expect(parsed.stateHash).toBe('f00d')
  })

  it('同一 sink 同时服务两类事件：有归属进会话文件、无归属进工作区文件', () => {
    const sink = createAuditSink(dir)
    const events: AuditEvent[] = [evt({ sessionId: 's1' }), ruleEvt(), evt({ sessionId: 's1' }), ruleEvt({ source: 'cli' })]
    for (const e of events) sink(e)
    expect(readFileSync(join(dir, 'sessions', 's1.audit.jsonl'), 'utf8').trim().split('\n').length).toBe(2)
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').length).toBe(2)
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
    expect(() => sink(ruleEvt())).not.toThrow()
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
