import { describe, expect, test } from 'bun:test'
import type { CompactionBlock, Message, SessionOriginalStore } from './index'
import { buildView, buildResolveBlock, reconstructHistory, renderBlocksAsMessage } from './index'

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

describe('reconstructHistory（按块还原全文）', () => {
  test('无 blocks 时即为近期消息', async () => {
    const msgs = [msg('m1', 'a'), msg('m2', 'b')]
    const full = await reconstructHistory({ blocks: undefined, messages: msgs })
    expect(full.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('有 blocks：resolveBlock 返回块原文，拼接在近期之前', async () => {
    const blocks: CompactionBlock[] = [
      { id: 'b1', summary: 's1', startId: 'm1', endId: 'm2', at: 1, origKey: 'b1' },
    ]
    const resolveBlock = async (b: CompactionBlock) =>
      ({ b1: [msg('m1', 'a'), msg('m2', 'b')] })[b.origKey ?? b.id] ?? []
    const full = await reconstructHistory(
      { blocks, messages: [msg('m3', 'c')] },
      resolveBlock,
    )
    expect(full.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  test('resolveBlock 失败/为空时退化为仅近期，不抛错', async () => {
    const blocks: CompactionBlock[] = [
      { id: 'b1', summary: 's1', startId: 'm1', endId: 'm2', at: 1 },
    ]
    const full = await reconstructHistory(
      { blocks, messages: [msg('m3', 'c')] },
      async () => { throw new Error('read fail') },
    )
    expect(full.map((m) => m.id)).toEqual(['m3'])
  })

  test('原文与近期 id 重叠时去重', async () => {
    const blocks: CompactionBlock[] = [
      { id: 'b1', summary: 's1', startId: 'm1', endId: 'm2', at: 1 },
    ]
    const full = await reconstructHistory(
      { blocks, messages: [msg('m2', 'b'), msg('m3', 'c')] },
      async () => [msg('m1', 'a'), msg('m2', 'b')],
    )
    expect(full.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })
})

describe('buildResolveBlock（按 source/引用统一取原文）', () => {
  const SID = 'sess-1'
  function makeStore(over: Partial<SessionOriginalStore> = {}): SessionOriginalStore {
    return {
      save: async () => {},
      load: async (_sid, key) =>
        ({ b1: [msg('m1', 'a')], b2: [msg('m3', 'c')] })[key] ?? undefined,
      ...over,
    }
  }

  test('无 store 时返回空数组', async () => {
    const resolve = buildResolveBlock(undefined, SID)
    expect(await resolve({ id: 'b1', summary: 's', startId: 'm1', endId: 'm2', at: 1 })).toEqual([])
  })

  test('generic 块走 load(sessionId, origKey ?? id)', async () => {
    const store = makeStore()
    const resolve = buildResolveBlock(store, SID)
    const got = await resolve({
      id: 'b1',
      summary: 's',
      startId: 'm1',
      endId: 'm2',
      at: 1,
      source: 'generic',
      origKey: 'b1',
    })
    expect(got.map((m) => m.id)).toEqual(['m1'])
  })

  test('acp 块且带 archiveRef + loadRef 时走 loadRef', async () => {
    const store = makeStore({
      loadRef: async (_sid, ref) => (ref === 'acp:1' ? [msg('m9', 'acp-原文')] : undefined),
    })
    const resolve = buildResolveBlock(store, SID)
    const got = await resolve({
      id: 'b2',
      summary: 's',
      startId: 'm0',
      endId: 'm9',
      at: 2,
      source: 'acp',
      archiveRef: 'acp:1',
      origKey: 'b2',
    })
    expect(got.map((m) => m.id)).toEqual(['m9'])
  })

  test('acp 块 loadRef 失败/未实现时回退 load', async () => {
    const store = makeStore() // 无 loadRef
    const resolve = buildResolveBlock(store, SID)
    const got = await resolve({
      id: 'b2',
      summary: 's',
      startId: 'm0',
      endId: 'm2',
      at: 2,
      source: 'acp',
      archiveRef: 'acp:1',
      origKey: 'b2',
    })
    expect(got.map((m) => m.id)).toEqual(['m3'])
  })

  test('acp 块无 archiveRef 时走 load(origKey ?? id)', async () => {
    const store = makeStore({ failed: true } as any)
    const resolve = buildResolveBlock(makeStore(), SID)
    const got = await resolve({
      id: 'b1',
      summary: 's',
      startId: 'm1',
      endId: 'm1',
      at: 1,
      source: 'acp',
    })
    expect(got.map((m) => m.id)).toEqual(['m1'])
  })
})