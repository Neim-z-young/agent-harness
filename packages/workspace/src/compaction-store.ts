/**
 * @harness/workspace —— 会话压缩消息文件（上下文压缩改造·阶段一：双写落盘 + 断点索引）
 *
 * 在既有会话文件（`sessions/{id}.json`，原文全量、原样保留）旁新增一类只读落盘：
 * `sessions/{id}.cmp.json` 记录"已压缩的摘要块"及其指向原文的**断点索引**。
 *
 * - 原文不动：会话完整消息仍序列化在 `{id}.json`，本文件只是旁路快照。
 * - 覆盖式写：每次压缩整体重写 blocks（固定大小，随会话增长恒定为一组摘要块）。
 * - 断点索引：`buildIndex()` 从 blocks 生成 `blockId → { file, startId, endId }`，
 *   供后续 loader 按 block 定位回原文件内这段消息，实现全文可按需还原。
 *
 * 本类仅做「定位 + 读写」，不含业务压缩逻辑；核心 compact 的接入放在改造阶段二/三。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Message, SessionOriginalStore } from '@harness/session'
import type { Workspace } from './index'

/** 压缩文件格式版本（会话 meta 的"已启用压缩文件"标记与之对应，预留键见 COMPACTION_META_KEY） */
export const COMPACTION_FILE_VERSION = 1 as const

/** 会话 meta 中标记"已启用压缩文件"的键（预留：由接入层在写入 cm同文件时写入 session.meta） */
export const COMPACTION_META_KEY = 'contextCompaction' as const

/** 一条压缩块：摘要 + 指向原文 id 段的断点。id 稳定，跨重启可定位。 */
export interface CompactionBlock {
  /** 块 ID（稳定，重启不重建） */
  id: string
  /** 主题（可选，便于检索/展示） */
  topic?: string
  /** 压缩摘要内容 */
  summary: string
  /** 被压缩原文消息范围的起始 message id */
  startId: string
  /** 被压缩原文消息范围的结束 message id */
  endId: string
  /** 该块原文在 SessionOriginalStore 中的归档 key（缺省沿用 id） */
  origKey?: string
  /** 本块创建时间戳 */
  at: number
}

/** 会话压缩消息文件结构（`sessions/{sessionId}.cmp.json`） */
export interface CompactionFile {
  /** 文件格式版本 */
  version: typeof COMPACTION_FILE_VERSION
  /** 所属会话 id */
  sessionId: string
  /** 已压缩块集合（覆盖式整体写，不影响原文文件） */
  blocks: CompactionBlock[]
}

/** 断点索引条目：由块定位回原始会话文件中的消息 id 段 */
export interface CompactionPoint {
  blockId: string
  /** 原文所在文件（绝对路径，即该会话的 `{id}.json`） */
  file: string
  startId: string
  endId: string
  summary: string
}

export interface SaveCompactionOptions {
  /** 自定义块 id 生成（默认 randomUUID，便于测试注入确定性 id） */
  blockId?: () => string
  /** 若为 true，`save` 传入的 blocks 与现有合并（追加）；否则整体覆盖 */
  append?: boolean
}

/**
 * 会话压缩消息文件存储。
 *
 * 写路径：`save()`（可 append 追加 / 整体覆盖），内部用 tmp + rename 原子落盘。
 * 读路径：`load()` 读全部 blocks；`readBlock()` 返回单个块 + 其断点索引。
 */
export class SessionCompactionStore {
  constructor(public readonly workspace: Workspace) {}

  private sessionsDir(): string {
    return this.workspace.files.sessions
  }

  /** 压缩消息文件路径 */
  pathFor(sessionId: string): string {
    return join(this.sessionsDir(), `${sessionId}.cmp.json`)
  }

  /** 该会话的原文文件路径（断点索引中的 file） */
  sourceFileFor(sessionId: string): string {
    return join(this.sessionsDir(), `${sessionId}.json`)
  }

  /** 读取压缩文件；不存在返回 undefined */
  async load(sessionId: string): Promise<CompactionFile | undefined> {
    const p = this.pathFor(sessionId)
    if (!existsSync(p)) return undefined
    return JSON.parse(await readFile(p, 'utf-8')) as CompactionFile
  }

  /** 读取全部压缩块（无则空数组） */
  async loadBlocks(sessionId: string): Promise<CompactionBlock[]> {
    const f = await this.load(sessionId)
    return f?.blocks ?? []
  }

  /**
   * 覆盖式 / 追加式写入压缩块集合。不用导出的场景也有，这里只负责落盘底座。
   * - `append=false`（默认）：以 `blocks` 整体覆盖现有（"每次压缩覆盖内容"语义）。
   * - `append=true`：与现有合并后写入。
   * tmp + rename 保证写入原子性：崩溃时旧文件不被半写破坏。
   */
  async save(
    sessionId: string,
    blocks: Array<Omit<CompactionBlock, 'id'> & { id?: string }>,
    options: SaveCompactionOptions = {},
  ): Promise<CompactionBlock[]> {
    await mkdir(this.sessionsDir(), { recursive: true })

    const base = options.append ? await this.loadBlocks(sessionId) : []
    const idGen = options.blockId ?? randomUUID
    const now = Date.now()

    // 归一化为完整块（无 id 则生成稳定 id）
    const normalized: CompactionBlock[] = blocks.map((b, i) => ({
      id: b.id ?? idGen(),
      topic: b.topic,
      summary: b.summary,
      startId: b.startId,
      endId: b.endId,
      at: b.at ?? now,
    }))

    const merged = append_blocks(base, normalized)

    const file: CompactionFile = {
      version: COMPACTION_FILE_VERSION,
      sessionId,
      blocks: merged,
    }

    const p = this.pathFor(sessionId)
    const tmp = `${p}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(file, null, 2))
    await rename(tmp, p)

    return merged
  }

  /** 追加单个压缩块 */
  async append(sessionId: string, block: Omit<CompactionBlock, 'id'> & { id?: string }): Promise<CompactionBlock> {
    const all = await this.save(sessionId, [block], { append: true })
    return all[all.length - 1]
  }

  /** 是否已存在压缩文件 */
  async exists(sessionId: string): Promise<boolean> {
    return existsSync(this.pathFor(sessionId))
  }

  /**
   * 生成断点索引：`blockId → 原文定位`。file 指向该会话的原文文件。
   * blocks 按原顺序构建；同一块 id 重复时后者覆盖（合并逻辑已去重，这里兜底）。
   */
  buildIndex(file: CompactionFile): Record<string, CompactionPoint> {
    const idx: Record<string, CompactionPoint> = {}
    for (const b of file.blocks) {
      idx[b.id] = {
        blockId: b.id,
        file: this.sourceFileFor(file.sessionId),
        startId: b.startId,
        endId: b.endId,
        summary: b.summary,
      }
    }
    return idx
  }

  /** 读取单个块及其断点索引条目 */
  async readBlock(
    sessionId: string,
    blockId: string,
  ): Promise<{ block: CompactionBlock; point: CompactionPoint } | undefined> {
    const f = await this.load(sessionId)
    if (!f) return undefined
    const block = f.blocks.find((b) => b.id === blockId)
    if (!block) return undefined
    const point = this.buildIndex(f)[blockId]
    return { block, point }
  }

  // ---------- 原文档案（上下文压缩·阶段二，Route B）----------
  // 被压缩窗口的原文落盘到 `sessions/{id}.cmp.orig/{blockId}.json`，
  // 内存只驻留近期消息 + blocks，loader 经此按块还原全文（全文可回溯）。

  /** 原文档案目录（sessions/{id}.cmp.orig） */
  origDirFor(sessionId: string): string {
    return join(this.sessionsDir(), `${sessionId}.cmp.orig`)
  }

  /** 原文档案单个块文件路径（{dir}/{blockId}.json） */
  origPathFor(sessionId: string, blockId: string): string {
    return join(this.origDirFor(sessionId), `${blockId}.json`)
  }

  /** 把某压缩块的原文消息序列化到盘（tmp+rename 原子写，同 key 覆盖式）。返回写入路径。 */
  async saveOriginals(
    sessionId: string,
    blockId: string,
    messages: Message[],
  ): Promise<string> {
    const p = this.origPathFor(sessionId, blockId)
    await mkdir(this.origDirFor(sessionId), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(messages, null, 2))
    await rename(tmp, p)
    return p
  }

  /** 读取某压缩块归档的原文消息；不存在返回 undefined */
  async loadOriginals(sessionId: string, blockId: string): Promise<Message[] | undefined> {
    const p = this.origPathFor(sessionId, blockId)
    if (!existsSync(p)) return undefined
    return JSON.parse(await readFile(p, 'utf-8')) as Message[]
  }

  /** 该会话已归档原文消息总数（供 list 计数展示全量条数） */
  async countOriginals(sessionId: string): Promise<number> {
    const dir = this.origDirFor(sessionId)
    if (!existsSync(dir)) return 0
    const files = await readdir(dir)
    let total = 0
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const p = join(dir, f)
        const arr = JSON.parse(await readFile(p, 'utf-8')) as unknown
        if (Array.isArray(arr)) total += arr.length
      } catch {
        /* 单个归档损坏不影响整体计数 */
      }
    }
    return total
  }
}

/** 把 SessionCompactionStore 适配成 @harness/session 的 SessionOriginalStore（CLI 注入 core 用） */
export function createWorkspaceOriginalStore(ws: Workspace): SessionOriginalStore {
  const store = new SessionCompactionStore(ws)
  return {
    save: (sessionId, blockId, messages) => store.saveOriginals(sessionId, blockId, messages),
    load: (sessionId, blockId) => store.loadOriginals(sessionId, blockId),
    loadRef: async (sessionId, ref) => {
      // 统一块模型：ref 形如 `orig:{sessionId}:{blockId}` 时转本地原文档案；
      // `acp:` 前缀留给宿主层（ACP 归档在 session.meta，workspace 无权访问），返回 undefined 由调用方回退。
      const orig = /^orig:([^:]+):(.+)$/.exec(ref)
      if (!orig) return undefined
      // 忽略前缀中的 sid（本 store 已由调用方给定 sessionId），以块 id 读取
      return store.loadOriginals(sessionId, orig[2])
    },
  }
}

/** 合并 blocks：按 id 去重（同 id 取新值），保持首次出现的顺序 */
function append_blocks(base: CompactionBlock[], incoming: CompactionBlock[]): CompactionBlock[] {
  if (incoming.length === 0) return base
  const map = new Map<string, CompactionBlock>()
  for (const b of [...base, ...incoming]) map.set(b.id, b)
  return [...map.values()]
}