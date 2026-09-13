import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import {
  COMPACTION_FILE_VERSION,
  COMPACTION_META_KEY,
  SessionCompactionStore,
  createWorkspaceOriginalStore,
} from './compaction-store'
import { resolveWorkspace } from './index'
import type { Message } from '@harness/session'

/** 构造一个指向临时 dataDir 的 workspace + store */
function makeStore(): { store: SessionCompactionStore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-cmp-'))
  const ws = resolveWorkspace({ cwd: dataDir, dataDir })
  const store = new SessionCompactionStore(ws)
  return { store, dataDir }
}

const SID = 'sess-1'

describe('SessionCompactionStore', () => {
  test('文件路径与来源文件定位', () => {
    const { store, dataDir } = makeStore()
    expect(store.pathFor(SID)).toBe(join(dataDir, 'sessions', 'sess-1.cmp.json'))
    expect(store.sourceFileFor(SID)).toBe(join(dataDir, 'sessions', 'sess-1.json'))
  })

  test('覆盖式 save：二次 save 整体替换，不含残留旧块', async () => {
    const { store } = makeStore()
    const first = await store.save(
      SID,
      [
        { topic: 't1', summary: 's1', startId: 'm1', endId: 'm3', at: 1, id: 'b1' },
        { summary: 's2', startId: 'm4', endId: 'm6', at: 2, id: 'b2' },
      ],
      { blockId: () => 'b' },
    )
    expect(first.map((b) => b.id)).toEqual(['b1', 'b2'])

    // 覆盖写：只剩新块
    await store.save(SID, [{ summary: 's3', startId: 'm7', endId: 'm9', at: 3, id: 'b3' }])
    const after = await store.loadBlocks(SID)
    expect(after.map((b) => b.id)).toEqual(['b3'])
  })

  test('append：与现有合并并按 id 去重、保留顺序', async () => {
    const { store } = makeStore()
    await store.save(SID, [{ summary: 's1', startId: 'm1', endId: 'm2', at: 1, id: 'b1' }])
    const b2 = await store.append(SID, { summary: 's2', startId: 'm3', endId: 'm4', at: 2, id: 'b2' })
    expect(b2.id).toBe('b2')
    // 重复 append 同 id 不产生重复
    await store.append(SID, { summary: 's2-new', startId: 'm3', endId: 'm4', at: 5, id: 'b2' })
    const all = await store.loadBlocks(SID)
    expect(all.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(all[1].summary).toBe('s2-new')
  })

  test('无 id 的块自动分配 id，且经 options.blockId 注入可生成确定性 id', async () => {
    const { store } = makeStore()
    await store.save(SID, [{ summary: 'x', startId: 'm0', endId: 'm1', at: 1 }], {
      blockId: () => 'gen-1',
    })
    const f = await store.load(SID)
    expect(f?.blocks[0].id).toBe('gen-1')
  })

  test('落盘文件符合 CompactionFile 结构且带版本标记', async () => {
    const { store, dataDir } = makeStore()
    await store.save(SID, [{ summary: 's1', startId: 'm1', endId: 'm2', at: 1, id: 'b1' }])
    const raw = JSON.parse(await readFile(store.pathFor(SID), 'utf-8'))
    expect(raw.version).toBe(COMPACTION_FILE_VERSION)
    expect(raw.sessionId).toBe(SID)
    expect(raw.blocks).toHaveLength(1)
    // 压缩文件与原文文件共存
    expect(existsSync(store.sourceFileFor(SID))).toBe(false) // 阶段一原文由既有 store 维护，此处尚未写入
    expect(COMPACTION_META_KEY).toBe('contextCompaction')
  })

  test('buildIndex：blockId → { file, startId, endId, summary }', async () => {
    const { store, dataDir } = makeStore()
    await store.save(SID, [
      { topic: 'phase-1', summary: 's1', startId: 'm1', endId: 'm3', at: 1, id: 'b1' },
      { summary: 's2', startId: 'm4', endId: 'm6', at: 2, id: 'b2' },
    ])
    const f = await store.load(SID)
    const idx = store.buildIndex(f!)
    expect(idx['b1']).toEqual({
      blockId: 'b1',
      file: join(dataDir, 'sessions', 'sess-1.json'),
      startId: 'm1',
      endId: 'm3',
      summary: 's1',
    })
    expect(idx['b2'].endId).toBe('m6')
  })

  test('readBlock：返回块及其断点索引；不存在的 block 返回 undefined', async () => {
    const { store } = makeStore()
    await store.save(SID, [{ summary: 's1', startId: 'm1', endId: 'm3', at: 1, id: 'b1' }])
    const got = await store.readBlock(SID, 'b1')
    expect(got?.block.summary).toBe('s1')
    expect(got?.point.file).toBe(store.sourceFileFor(SID))
    expect(await store.readBlock(SID, 'nope')).toBeUndefined()
    // 无压缩文件时 readBlock 返回 undefined
    expect(await store.readBlock('no-session', 'b1')).toBeUndefined()
  })

  test('exists 与 load 在无文件时返回安全默认', async () => {
    const { store } = makeStore()
    expect(await store.exists(SID)).toBe(false)
    expect(await store.load(SID)).toBeUndefined()
    expect(await store.loadBlocks(SID)).toEqual([])
  })

  test('写路径原子：成功写入后无残留 tmp 文件', async () => {
    const { store, dataDir } = makeStore()
    await mkdir(join(dataDir, 'sessions'), { recursive: true })
    await store.save(SID, [{ summary: 's1', startId: 'm1', endId: 'm2', at: 1, id: 'b1' }])
    expect(existsSync(store.pathFor(SID))).toBe(true)
    // 目录内不应有残余 .tmp
    const files = await readdir(join(dataDir, 'sessions'))
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  test('saveOriginals/loadOriginals 往返（原文档案落盘）', async () => {
    const { store, dataDir } = makeStore()
    const msgs: Message[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text' as const, text: 'a' }], createdAt: 1 },
      { id: 'm2', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'b' }], createdAt: 2 },
    ]
    const p = await store.saveOriginals(SID, 'bk-1', msgs)
    expect(p).toBe(store.origPathFor(SID, 'bk-1'))
    expect(existsSync(store.origPathFor(SID, 'bk-1'))).toBe(true)
    const loaded = await store.loadOriginals(SID, 'bk-1')
    expect(loaded?.map((m) => m.id)).toEqual(['m1', 'm2'])
    // 覆盖式写
    await store.saveOriginals(SID, 'bk-1', [{ id: 'm9', role: 'user', parts: [{ type: 'text' as const, text: 'z' }], createdAt: 9 }])
    expect((await store.loadOriginals(SID, 'bk-1'))!.map((m) => m.id)).toEqual(['m9'])
    // 不存在的块返回 undefined
    expect(await store.loadOriginals(SID, 'nope')).toBeUndefined()
  })

  test('countOriginals：按块累计归档原文条数', async () => {
    const { store } = makeStore()
    expect(await store.countOriginals(SID)).toBe(0)
    await store.saveOriginals(SID, 'bk-1', [{ id: 'm1', role: 'user' as const, parts: [], createdAt: 1 }])
    await store.saveOriginals(SID, 'bk-2', [
      { id: 'm2', role: 'user' as const, parts: [], createdAt: 2 },
      { id: 'm3', role: 'user' as const, parts: [], createdAt: 3 },
    ])
    expect(await store.countOriginals(SID)).toBe(3)
  })

  test('createWorkspaceOriginalStore 适配 SessionOriginalStore 接口', async () => {
    const { store, dataDir } = makeStore()
    expect(store.origDirFor(SID)).toBe(join(dataDir, 'sessions', 'sess-1.cmp.orig'))
    const os = createWorkspaceOriginalStore(resolveWorkspace({ cwd: dataDir, dataDir }))
    const msgs = [{ id: 'm1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'a' }], createdAt: 1 }]
    await os.save(SID, 'bk-1', msgs)
    expect((await os.load(SID, 'bk-1'))?.map((m) => m.id)).toEqual(['m1'])
    expect(await os.load(SID, 'none')).toBeUndefined()
  })

  test('createWorkspaceOriginalStore.loadRef：orig:{sid}:{block} 转本地归档，acp: 回退 undefined', async () => {
    const { dataDir } = makeStore()
    const os = createWorkspaceOriginalStore(resolveWorkspace({ cwd: dataDir, dataDir }))
    const msgs = [{ id: 'm1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'a' }], createdAt: 1 }]
    await os.save(SID, 'bk-1', msgs)
    // orig: 前缀 → 命中本地原文档案
    expect((await os.loadRef!(SID, `orig:${SID}:bk-1`))?.map((m) => m.id)).toEqual(['m1'])
    // 默认不要 star 前缀 / 空引用回退
    expect(await os.loadRef!(SID, 'acp:archive-1')).toBeUndefined()
    expect(await os.loadRef!(SID, 'unknown-ref')).toBeUndefined()
  })
})