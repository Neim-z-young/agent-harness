import { describe, it, expect, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCatchupSection,
  buildCatchup,
  catchupMarker,
  extractCatchupTurns,
  hasCatchup,
  readSessionFile,
  renderCatchupSection,
  type CatchupMessageLike,
} from './catchup'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'plan-catchup-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const msg = (role: string, text: string): CatchupMessageLike => ({ role, parts: [{ type: 'text', text }] })

describe('extractCatchupTurns', () => {
  it('只取 user / assistant 的文本，跳过 system / tool', () => {
    const r = extractCatchupTurns([
      msg('user', '做 A'),
      msg('assistant', '好'),
      msg('tool', '工具输出'),
      msg('system', '系统提示'),
    ])
    expect(r.turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(r.turns.map((t) => t.text)).toEqual(['做 A', '好'])
    expect(r.total).toBe(2)
    expect(r.dropped).toBe(0)
  })

  it('从最新往回取，超出预算的轮数计入 dropped，结果仍按时间正序', () => {
    const messages = [1, 2, 3, 4, 5].flatMap((n) => [msg('user', `问 ${n}`), msg('assistant', `答 ${n}`)])
    const r = extractCatchupTurns(messages, { maxTurns: 3 })
    expect(r.total).toBe(10)
    expect(r.dropped).toBe(7)
    // 尾部三条是「答4 / 问5 / 答5」—— 窗口取满即可，不保证落在问答对边界上
    expect(r.turns.map((t) => t.text)).toEqual(['答 4', '问 5', '答 5'])
  })

  it('跳过本插件的注入块（历史里的遗留块不该进日志）', () => {
    const r = extractCatchupTurns([
      msg('user', '真正的提问'),
      msg('user', '===BEGIN PLAN DATA===\n计划: .planning/task_plan.md\n===END PLAN DATA==='),
    ])
    expect(r.total).toBe(1)
    expect(r.turns[0]!.text).toBe('真正的提问')
  })

  it('忽略空文本 / 非文本 part', () => {
    const r = extractCatchupTurns([
      { role: 'user', parts: [{ type: 'text', text: '   ' }] },
      { role: 'user', parts: [{ type: 'tool_call' }] },
      { role: 'user', parts: [] },
      msg('user', '有内容'),
    ])
    expect(r.total).toBe(1)
  })

  it('每轮折成单行并截断（日志一行一条）', () => {
    const r = extractCatchupTurns([msg('assistant', `多行\n文本\t带空白 ${'x'.repeat(300)}`)], { maxCharsPerTurn: 40 })
    const text = r.turns[0]!.text
    expect(text).not.toContain('\n')
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('marker / 幂等', () => {
  it('marker 按 sessionId 区分', () => {
    expect(catchupMarker('s1')).toBe('<!-- plan-catchup:s1 -->')
    expect(hasCatchup(`abc\n${catchupMarker('s1')}\ndef`, 's1')).toBe(true)
    expect(hasCatchup(`abc\n${catchupMarker('s1')}\ndef`, 's2')).toBe(false)
    expect(hasCatchup('', 's1')).toBe(false)
  })
})

describe('renderCatchupSection / appendCatchupSection', () => {
  it('渲染出 marker、时间、来源与逐轮条目', () => {
    const extract = extractCatchupTurns([msg('user', '做 A'), msg('assistant', '做完了')])
    const section = renderCatchupSection({
      sessionId: 's1',
      title: '会话标题',
      extract,
      at: new Date(2026, 9, 5, 12, 0).getTime(),
      source: '.harness/sessions/s1.json',
    })
    expect(section).toContain(catchupMarker('s1'))
    expect(section).toContain('Catchup 2026-10-05 12:00（会话标题）')
    expect(section).toContain('> 来源：.harness/sessions/s1.json')
    expect(section).toContain('- 用户：做 A')
    expect(section).toContain('- 助手：做完了')
  })

  it('有 dropped 时如实标注条数', () => {
    const messages = [1, 2, 3].flatMap((n) => [msg('user', `问 ${n}`), msg('assistant', `答 ${n}`)])
    const extract = extractCatchupTurns(messages, { maxTurns: 2 })
    const section = renderCatchupSection({ sessionId: 's1', extract, at: 0 })
    expect(section).toContain('只收录最近 2 轮；更早的 4 轮未收录')
  })

  it('没有可汇总内容时不假装有（明说没有）', () => {
    const section = renderCatchupSection({ sessionId: 's1', extract: extractCatchupTurns([]), at: 0 })
    expect(section).toContain('没有可汇总的')
  })

  it('append：空文件不产生多余空行；非空追加在后面（原文一字不动）', () => {
    expect(appendCatchupSection('', 'X')).toBe('X\n')
    expect(appendCatchupSection('# 进度\n\n- 旧行\n', 'X')).toBe('# 进度\n\n- 旧行\n\nX\n')
  })
})

describe('buildCatchup：一次到位且幂等', () => {
  const messages = [msg('user', '做 A'), msg('assistant', '做完了')]

  it('首次写入：progress.md 变长且带 marker', () => {
    const r = buildCatchup('# 进度\n', 's1', messages, { at: 0 })
    expect(r.skipped).toBe(false)
    expect(r.extract.turns).toHaveLength(2)
    expect(hasCatchup(r.md, 's1')).toBe(true)
    expect(r.md.startsWith('# 进度\n')).toBe(true) // 原内容保留
  })

  it('二次调用：skipped=true 且 md **逐字不变**（追加式文件不能写两份）', () => {
    const first = buildCatchup('# 进度\n', 's1', messages, { at: 0 })
    const second = buildCatchup(first.md, 's1', messages, { at: 999 })
    expect(second.skipped).toBe(true)
    expect(second.md).toBe(first.md)
  })

  it('不同会话各写一份（互不吞掉）', () => {
    const a = buildCatchup('# 进度\n', 's1', messages, { at: 0 })
    const b = buildCatchup(a.md, 's2', messages, { at: 0 })
    expect(b.skipped).toBe(false)
    expect(hasCatchup(b.md, 's1')).toBe(true)
    expect(hasCatchup(b.md, 's2')).toBe(true)
  })
})

describe('readSessionFile（容错）', () => {
  it('读到 title 与 messages', () => {
    const dataDir = tmp()
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    writeFileSync(join(dataDir, 'sessions', 's1.json'), JSON.stringify({ title: 'T', messages: [msg('user', 'hi')] }), 'utf8')
    const found = readSessionFile(dataDir, 's1')
    expect(found?.file.title).toBe('T')
    expect(found?.file.messages).toHaveLength(1)
    expect(found?.path).toBe(join(dataDir, 'sessions', 's1.json'))
  })

  it('缺失 / 损坏 / 空 sessionId ⇒ undefined（不抛）', () => {
    const dataDir = tmp()
    expect(readSessionFile(dataDir, 'nope')).toBeUndefined()
    expect(readSessionFile(dataDir, '')).toBeUndefined()
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    writeFileSync(join(dataDir, 'sessions', 'bad.json'), '{ not json', 'utf8')
    expect(readSessionFile(dataDir, 'bad')).toBeUndefined()
    writeFileSync(join(dataDir, 'sessions', 'arr.json'), '[]', 'utf8')
    expect(readSessionFile(dataDir, 'arr')).toBeUndefined()
  })

  it('messages 不是数组 ⇒ 读成空列表（不让 catchup 崩）', () => {
    const dataDir = tmp()
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    writeFileSync(join(dataDir, 'sessions', 's3.json'), JSON.stringify({ messages: 'oops' }), 'utf8')
    expect(readSessionFile(dataDir, 's3')?.file.messages).toEqual([])
  })
})
