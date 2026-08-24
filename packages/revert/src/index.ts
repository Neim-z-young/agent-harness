/**
 * @harness/revert - 会话级文件回滚（Revert 三态）
 *
 * 对齐 OpenCode SessionRevert（packages/core/session/revert.ts）：
 * - stage({ sessionId, messageID })：把 boundary 消息之后的文件变更回滚掉
 *   （收集消息快照引用 → Snapshot.restore 选择性恢复），计算回滚 diff，
 *   保存 RevertState，发布 snapshot.revert.staged 事件；
 * - clear(sessionId)：撤销回滚（把文件恢复到回滚前的原始快照），发布 cleared；
 * - commit(sessionId)：接受回滚结果（文件保持回滚后状态），清除 revert 状态，发布 committed。
 *
 * 消息快照引用约定（对齐 OpenCode message.snapshot = { start, files }）：
 *   message.meta.snapshot = { start: SnapshotID, files?: string[] }
 * 通过 attachSnapshotToMessage() 挂载（core 的 AgentRuntime 集成见架构文档 §10.3）；
 * collectSnapshotMap() 从会话收集"边界消息之后各 assistant 消息"的文件快照引用。
 */

import { BusEvent } from '@harness/bus'
import type { Bus } from '@harness/bus'
import type { Session, SessionManager } from '@harness/session'
import type { FileDiff, SnapshotID, SnapshotService } from '@harness/snapshot'

// ===== RevertState =====

/** 会话级回滚状态（约定写入 session.meta[REVERT_META_KEY]） */
export interface RevertState {
  /** 回滚边界消息 ID（回滚"该消息之后"的文件变更） */
  messageID: string
  /** 回滚前的原始快照（clear 时据此恢复，撤销回滚） */
  snapshot?: string
  /** 回滚产生的 diff（各文件 patch 拼接） */
  diff?: string
  /** 回滚产生的结构化文件差异 */
  files?: FileDiff[]
}

/** session.meta 中存放 RevertState 的 key */
export const REVERT_META_KEY = 'revert' as const

// ===== 自定义错误 =====

export type RevertOperation = 'stage' | 'clear' | 'commit' | 'attach'

/** Revert 操作失败（模块特定失败场景） */
export class RevertError extends Error {
  readonly operation: RevertOperation
  readonly cause?: unknown

  constructor(operation: RevertOperation, message: string, cause?: unknown) {
    super(`[revert:${operation}] ${message}`)
    this.name = 'RevertError'
    this.operation = operation
    this.cause = cause
  }
}

// ===== Bus 事件 =====

/** Revert 相关事件定义（域：snapshot.revert.*） */
export const RevertEvents = {
  /** stage 完成：文件已回滚，diff 已生成 */
  staged: BusEvent.define<{
    sessionId: string
    messageID: string
    diff: string
    files: FileDiff[]
  }>('snapshot.revert.staged'),
  /** clear 完成：回滚被撤销，文件恢复原状 */
  cleared: BusEvent.define<{ sessionId: string }>('snapshot.revert.cleared'),
  /** commit 完成：回滚被接受，revert 状态清除 */
  committed: BusEvent.define<{ sessionId: string; messageID: string }>('snapshot.revert.committed'),
} as const satisfies Record<string, BusEvent>

// ===== 消息快照引用辅助 =====

/** 消息 meta 中快照引用的约定结构（对齐 OpenCode message.snapshot） */
export interface MessageSnapshotRef {
  /** 该轮开始时 capture 的快照 ID */
  start: SnapshotID
  /** 该快照涉及的文件（项目相对路径） */
  files?: string[]
}

/**
 * 把快照引用挂载到某条消息的 meta 上（约定 key: meta.snapshot）。
 * 用于"每轮 query 开始时 capture 并挂到 assistant 消息"（§10.3 集成路线）。
 */
export function attachSnapshotToMessage(
  session: Session,
  messageId: string,
  snapshot: SnapshotID,
  files?: string[],
): void {
  const msg = session.messages.find((m) => m.id === messageId)
  if (!msg) throw new RevertError('attach', `Message "${messageId}" not found`)
  const ref: MessageSnapshotRef = files ? { start: snapshot, files } : { start: snapshot }
  msg.meta = { ...msg.meta, snapshot: ref }
}

/**
 * 从会话收集回滚目标：boundary 消息之后所有 assistant 消息的快照引用，
 * 每个文件取"最早出现"的消息快照（对齐 OpenCode SessionRevert.plan）。
 */
export function collectSnapshotMap(
  session: Session,
  boundaryMessageId: string,
): Map<string, SnapshotID> {
  const boundaryIndex = session.messages.findIndex((m) => m.id === boundaryMessageId)
  if (boundaryIndex < 0) return new Map()

  const files = new Map<string, SnapshotID>()
  for (let i = boundaryIndex + 1; i < session.messages.length; i++) {
    const msg = session.messages[i]
    if (msg.role !== 'assistant') continue
    const ref = msg.meta?.snapshot as MessageSnapshotRef | undefined
    if (!ref?.start) continue
    for (const file of ref.files ?? []) {
      if (!files.has(file)) files.set(file, ref.start)
    }
  }
  return files
}

// ===== SessionRevert：三态核心 =====

/** SessionRevert 构造参数 */
export interface SessionRevertOptions {
  /** 会话管理器（读取会话 / 消息） */
  session: SessionManager
  /** 快照服务（capture / restore / diff） */
  snapshot: SnapshotService
  /** 事件总线（发布 staged/cleared/committed） */
  bus: Bus
}

/**
 * 会话级文件回滚三态控制器
 *
 * 生命周期：
 *   stage → 文件已回滚 + RevertState 已保存（可 clear 撤销 / commit 接受）
 *   clear → 文件恢复回滚前状态，revert 状态清除
 *   commit → 文件保持回滚后状态，revert 状态清除
 */
export class SessionRevert {
  private readonly session: SessionManager
  private readonly snapshot: SnapshotService
  private readonly bus: Bus

  constructor(options: SessionRevertOptions) {
    this.session = options.session
    this.snapshot = options.snapshot
    this.bus = options.bus
  }

  /**
   * 回滚 boundary 消息之后的文件变更。
   *
   * @param input.snapshotMap 显式回滚目标（可选覆盖；缺省从消息快照引用收集）
   */
  async stage(input: {
    sessionId: string
    messageID: string
    snapshotMap?: ReadonlyMap<string, SnapshotID>
  }): Promise<RevertState> {
    const session = await this.session.get(input.sessionId)
    if (!session) throw new RevertError('stage', `Session "${input.sessionId}" not found`)
    if (!session.messages.some((m) => m.id === input.messageID)) {
      throw new RevertError('stage', `Message "${input.messageID}" not found`)
    }

    // 回滚前原始快照：重复 stage 沿用上次，首次捕获
    const existing = session.meta?.[REVERT_META_KEY] as RevertState | undefined
    const original = existing?.snapshot ?? (await this.snapshot.capture())
    if (!original) throw new RevertError('stage', 'Snapshot capture failed (snapshots disabled or unsupported)')

    // 回滚目标：已有 revert 文件（恢复到 original）+ 新收集的快照引用
    const restore = new Map<string, SnapshotID>()
    if (existing) {
      for (const f of existing.files ?? []) restore.set(f.path, original as SnapshotID)
    }
    const collected = input.snapshotMap ?? collectSnapshotMap(session, input.messageID)
    for (const [file, tree] of collected) {
      if (!restore.has(file)) restore.set(file, tree)
    }

    if (restore.size > 0) await this.snapshot.restore(restore)

    // 回滚 diff：original（回滚前）→ 回滚后状态
    const paths = Array.from(restore.keys())
    const after = await this.snapshot.capture()
    const files = after ? await this.snapshot.diff(original as SnapshotID, after, { paths }) : []
    const diff = files.map((f) => f.patch).join('').trim()

    const state: RevertState = {
      messageID: input.messageID,
      snapshot: original,
      diff,
      files,
    }
    this.setRevertState(session, state)

    await this.bus.publish(RevertEvents.staged, {
      sessionId: input.sessionId,
      messageID: input.messageID,
      diff,
      files,
    })
    return state
  }

  /** 撤销回滚：把文件恢复到回滚前的原始快照，清除 revert 状态 */
  async clear(sessionId: string): Promise<void> {
    const session = await this.session.get(sessionId)
    if (!session) return
    const state = session.meta?.[REVERT_META_KEY] as RevertState | undefined
    if (!state) return

    if (state.snapshot) {
      const files = new Map<string, SnapshotID>(
        (state.files ?? []).map((f) => [f.path, state.snapshot as SnapshotID]),
      )
      await this.snapshot.restore(files)
    }
    this.clearRevertState(session)
    await this.bus.publish(RevertEvents.cleared, { sessionId })
  }

  /** 接受回滚：文件保持回滚后状态，清除 revert 状态 */
  async commit(sessionId: string): Promise<void> {
    const session = await this.session.get(sessionId)
    if (!session) return
    const state = session.meta?.[REVERT_META_KEY] as RevertState | undefined
    if (!state) return

    this.clearRevertState(session)
    await this.bus.publish(RevertEvents.committed, { sessionId, messageID: state.messageID })
  }

  /** 读取当前 revert 状态（无则 undefined） */
  async getState(sessionId: string): Promise<RevertState | undefined> {
    const session = await this.session.get(sessionId)
    return session?.meta?.[REVERT_META_KEY] as RevertState | undefined
  }

  // ===== 内部 =====

  private setRevertState(session: Session, state: RevertState): void {
    session.meta = { ...session.meta, [REVERT_META_KEY]: state }
  }

  private clearRevertState(session: Session): void {
    if (!session.meta) return
    delete session.meta[REVERT_META_KEY]
  }
}

/** 便捷工厂 */
export function createSessionRevert(options: SessionRevertOptions): SessionRevert {
  return new SessionRevert(options)
}
