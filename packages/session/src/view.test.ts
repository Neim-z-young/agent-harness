import { describe, expect, test } from 'bun:test'
import type { CompactionBlock, Message } from './index'
import { buildView, renderBlocksAsMessage } from './index'

function msg(id: string, text: string): Message {
  return { id, role: 'user', parts: [{ type: 'text', text }], createdAt: 1 }
}

describe('buildView（压缩视图组装）', () => {
  test('无 blocks 时退化为全量（slimmed=false、messages 原样、blocks 空）', () => {
    const msgs = [msg('m1', 'a'), msg('m2', 'b')]
    const view = buildView(undefined, msgs)
    expect(view.slimmed).toBe(false)
    expect(view.messages).toBe(msgs)
    expect(view.blocks).toEqual([])
  })

  test('空数组 blocks 同样退化', () => {
    const msgs = [msg('m1', 'a')]
    const view = buildView([], msgs)
    expect(view.slimmed).toBe(false)
    expect(view.messages).toBe(msgs)
  })

  test('有 blocks 时为已精简视图（slimmed=true）', () => {
    const blocks: CompactionBlock[] = [
      { id: 'b1', summary: 's1', startId: 'm1', endId: 'm2', at: 1 },
    ]
    const view = buildView(blocks, [msg('m3', 'c')])
    expect(view.slimmed).toBe(true)
    expect(view.blocks).toBe(blocks)
    expect(view.messages).toHaveLength(1)
  })
})

describe('renderBlocksAsMessage（摘要占位消息）', () => {
  test('无 blocks 返回 undefined', () => {
    expect(renderBlocksAsMessage(undefined)).toBeUndefined()
    expect(renderBlocksAsMessage([])).toBeUndefined()
  })

  test('有 blocks 生成一条 user text 消息，含各块摘要', () => {
    const blocks: CompactionBlock[] = [
      { id: 'b1', topic: 'phase-1', summary: '完成 A', startId: 'm1', endId: 'm2', at: 1 },
      { id: 'b2', summary: '发现 B', startId: 'm3', endId: 'm4', at: 2 },
    ]
    const m = renderBlocksAsMessage(blocks)!
    expect(m.role).toBe('user')
    expect(m.id).toBe('__compaction_view__')
    const text = m.parts[0].type === 'text' ? m.parts[0].text : ''
    expect(text).toContain('===COMPACTED HISTORY SUMMARY===')
    expect(text).toContain('[phase-1] 完成 A')
    expect(text).toContain('发现 B')
  })
})

describe('CompactionBlock 结构与 workspace 同构（字段完整）', () => {
  test('字段：id/topic/summary/startId/endId/at', () => {
    const b: CompactionBlock = {
      id: 'b1',
      summary: 's',
      startId: 'm1',
      endId: 'm2',
      at: 1,
    }
    expect(b.id).toBe('b1')
    expect(b.topic).toBeUndefined()
    expect(b.summary).toBe('s')
    expect(b.startId).toBe('m1')
    expect(b.endId).toBe('m2')
    expect(b.at).toBe(1)
  })
})