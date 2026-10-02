/**
 * 块模型时间线用例（纯归约器，可脱离 VSCode 单测）。
 *
 * 合并口径是这里最值得测的东西：文本逐帧增量若各自成块，时间线会碎成上百条；
 * 闸门心跳若每次成块，一条"等待中"能刷满一屏。
 */

import { describe, expect, it } from 'bun:test'
import {
  EMPTY_TIMELINE,
  MAX_TIMELINE_BLOCKS,
  TIMELINE_FLUSH_MS,
  TimelineStore,
  appendOp,
  finishTimeline,
  outcomeText,
  shouldFlush,
  startTimeline,
  type TimelineState,
} from './timeline'
import type { RenderOp } from '../types'

const text = (t: string, refs?: readonly string[]): RenderOp => ({ kind: 'text', text: t, ...(refs ? { refs } : {}) })
const progress = (t: string): RenderOp => ({ kind: 'progress', text: t })
const permission: RenderOp = {
  kind: 'permission',
  tool: 'bash',
  patterns: ['rm -rf'],
  options: ['allow', 'deny'],
  question: '是否允许执行 rm -rf？',
}
const error: RenderOp = { kind: 'error', code: -32001, message: '工具失败' }
const done = (state: string): RenderOp => ({ kind: 'done', state })

function run(ops: RenderOp[], from: TimelineState = EMPTY_TIMELINE): TimelineState {
  let s = from
  for (const op of ops) s = appendOp(s, op)
  return s
}

describe('startTimeline', () => {
  it('先落 user 块（时间线要知道这一轮是谁问的）', () => {
    const s = startTimeline(EMPTY_TIMELINE, '  看一下 src/a.ts  ')
    expect(s.started).toBe(true)
    expect(s.streaming).toBe(true)
    expect(s.blocks.length).toBe(1)
    expect(s.blocks[0]?.kind).toBe('user')
    expect(s.blocks[0]?.text).toBe('看一下 src/a.ts')
  })

  it('空 prompt ⇒ 不开轮（不该出现一个空的 user 块）', () => {
    expect(startTimeline(EMPTY_TIMELINE, '   ').blocks).toEqual([])
    expect(startTimeline(EMPTY_TIMELINE, '').started).toBe(false)
  })
})

describe('appendOp · 文本', () => {
  it('连续增量并进同一个 assistant 块（不是每帧一块）', () => {
    const s = run([text('你好'), text('，世界')])
    expect(s.blocks.length).toBe(1)
    expect(s.blocks[0]?.text).toBe('你好，世界')
    expect(s.blocks[0]?.streaming).toBe(true)
  })

  it('文本被工具打断后 ⇒ 新开一个 assistant 块（顺序不丢）', () => {
    const s = run([text('先看'), progress('调用工具 read'), text('再看')])
    expect(s.blocks.map((b) => b.kind)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('文本里的文件引用累积进块（去重）', () => {
    const s = run([text('改了 a.ts', ['src/a.ts']), text('和 b.ts', ['src/b.ts', 'src/a.ts'])])
    expect(s.blocks[0]?.refs).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('appendOp · 进度 / 权限', () => {
  it('同文案心跳合并成一条（repeats 计数），不刷成一长串', () => {
    const s = run([progress('等待中'), progress('等待中'), progress('等待中')])
    expect(s.blocks.length).toBe(1)
    expect(s.blocks[0]?.repeats).toBe(3)
  })

  it('换文案 ⇒ 新块', () => {
    const s = run([progress('调用工具 read'), progress('调用工具 write')])
    expect(s.blocks.length).toBe(2)
    expect(s.blocks[1]?.text).toBe('调用工具 write')
  })

  it('权限单独一类（IDE 里它是模态对话框，不是控制台文本）', () => {
    const s = run([text('先说一句'), permission])
    const b = s.blocks[s.blocks.length - 1]
    expect(b?.kind).toBe('permission')
    expect(b?.text).toContain('bash')
    expect(b?.text).toContain('rm -rf')
    expect(s.assistantId).toBe(-1)
  })
})

describe('appendOp · 终态与错误', () => {
  it('done ⇒ 写终态 system 块 + 关掉所有 streaming', () => {
    const s = run([text('回答'), done('TASK_STATE_COMPLETED')])
    expect(s.outcome).toBe('TASK_STATE_COMPLETED')
    expect(s.streaming).toBe(false)
    expect(s.blocks.map((b) => b.kind)).toEqual(['assistant', 'system'])
    expect(s.blocks[0]?.streaming).toBe(false)
    expect(s.blocks[1]?.text).toBe('完成')
  })

  it('取消 ⇒ outcome 是 cancelled（不是协议里的 TASK_STATE_*）', () => {
    const s = run([text('回答'), done('TASK_STATE_CANCELED')])
    expect(s.outcome).toBe('cancelled')
    expect(s.blocks[s.blocks.length - 1]?.text).toBe('已停止')
  })

  it('error ⇒ 错误块带 code，并落 outcome=error', () => {
    const s = run([text('回答中'), error])
    const b = s.blocks[s.blocks.length - 1]
    expect(b?.kind).toBe('error')
    expect(b?.text).toContain('-32001')
    expect(s.outcome).toBe('error')
    expect(s.streaming).toBe(false)
  })

  it('finishTimeline 兜底收尾（取消/异常退出也不能一直显示进行中）', () => {
    const s = finishTimeline(run([text('回答中')]), 'cancelled')
    expect(s.streaming).toBe(false)
    expect(s.outcome).toBe('cancelled')
  })

  it('静默帧不产生块（filetree / reference / noop 在别处呈现）', () => {
    const base = run([text('x')])
    expect(appendOp(base, { kind: 'noop' })).toBe(base)
    expect(appendOp(base, { kind: 'filetree', baseUri: '/repo', nodes: [] })).toBe(base)
    expect(appendOp(base, { kind: 'reference', path: '/repo/a.ts' })).toBe(base)
  })

  it('outcomeText 的人读映射', () => {
    expect(outcomeText('cancelled')).toBe('已停止')
    expect(outcomeText('error')).toBe('失败')
    expect(outcomeText('TASK_STATE_COMPLETED')).toBe('完成')
    expect(outcomeText('WEIRD')).toBe('WEIRD')
  })
})

describe('环形缓冲', () => {
  it(`超过 ${MAX_TIMELINE_BLOCKS} 块 ⇒ 丢最旧（长会话不该让 webview 消息无限膨胀）`, () => {
    let s = EMPTY_TIMELINE
    for (let i = 0; i < MAX_TIMELINE_BLOCKS + 25; i++) s = appendOp(s, progress(`第 ${i} 步`))
    expect(s.blocks.length).toBe(MAX_TIMELINE_BLOCKS)
    expect(s.blocks[0]?.text).toBe(`第 25 步`)
  })
})

describe('shouldFlush（节流策略）', () => {
  it('首帧必推；间隔内不推；过间隔再推', () => {
    expect(shouldFlush(1000, 0)).toBe(true)
    expect(shouldFlush(1050, 1000)).toBe(false)
    expect(shouldFlush(1120, 1000, TIMELINE_FLUSH_MS)).toBe(true)
  })
})

describe('TimelineStore', () => {
  it('订阅者拿到快照；unsubscribe 后不再收到', () => {
    const store = new TimelineStore()
    const seen: number[] = []
    const off = store.subscribe((snap) => seen.push(snap.blocks.length))

    store.startTurn('hi')
    store.append(text('回答'))

    off()
    store.append(progress('调用工具 read'))

    expect(seen).toEqual([1, 2])
    expect(store.snapshot.blocks.length).toBe(3)
  })

  it('clear 回到空（面板上"清空"按钮）', () => {
    const store = new TimelineStore()
    store.startTurn('hi')
    store.append(text('回答'))
    store.clear()
    expect(store.snapshot.blocks).toEqual([])
    expect(store.snapshot.started).toBe(false)
    expect(store.snapshot.streaming).toBe(false)
  })
})
