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
import type { Session, SessionManager, Message } from '@harness/session'
import type { FileDiff, SnapshotID, SnapshotService } from '@harness/snapshot'
import type { AgentPlugin, Hooks, CliCommandInput, CliCommandsInput } from '@harness/plugin'

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
  messages?: Message[],
): Map<string, SnapshotID> {
  const list = messages ?? session.messages
  const boundaryIndex = list.findIndex((m) => m.id === boundaryMessageId)
  if (boundaryIndex < 0) return new Map()

  const files = new Map<string, SnapshotID>()
  for (let i = boundaryIndex + 1; i < list.length; i++) {
    const msg = list[i]
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
  /**
   * 全文回溯器（统一块模型，可选）：经 reconstructHistory 还原会话"完整历史"
   * （含被 ACP/通用 compact 折叠块的原文 + 近期），供 stage 在折叠后仍能定位
   * boundary 并收集其后消息的快照引用（"只回退最近消息"在压缩后依然可靠）。
   * 缺省时回退到 session.messages 直接定位（未压缩/未折叠会话）。
   */
  getFullHistory?: (sessionId: string) => Promise<Message[]>
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
  private readonly getFullHistory?: (sessionId: string) => Promise<Message[]>

  constructor(options: SessionRevertOptions) {
    this.session = options.session
    this.snapshot = options.snapshot
    this.bus = options.bus
    this.getFullHistory = options.getFullHistory
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

    // 统一块模型：折叠后 boundary 可能已不在近期 messages，经全文回溯还原定位；
    // 缺省（未压缩）回退到近期消息直接定位。
    const full = this.getFullHistory ? await this.getFullHistory(input.sessionId) : session.messages
    if (!full.some((m) => m.id === input.messageID)) {
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
    const collected = input.snapshotMap ?? collectSnapshotMap(session, input.messageID, full)
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

// ===== 薄壳插件：/revert 命令（cli.commands / cli.command） =====

/** cli.command 输入 + cli 注入的 snapshot 服务（cli 装配时注入，插件 cast 消费） */
export interface RevertCmdInput extends CliCommandInput {
  /** cli 注入的 snapshot 服务（HarnessApp.snapshotService）；缺省回退 opts.snapshotService */
  snapshotService?: SnapshotService
  /** cli 注入的会话全文回溯器（统一块模型，缺省回落近期直接定位） */
  getFullHistory?: (sessionId: string) => Promise<Message[]>
}

/** createRevertPlugin 入参 */
export interface RevertShellOptions {
  /** 注入的 snapshot 服务（缺省改读命令输入的 input.snapshotService） */
  snapshotService?: SnapshotService
}

/**
 * 薄壳 AgentPlugin：把 `/revert stage|clear|commit|status|help` 以 `cli.command` hook 提供。
 * - 依赖 cli 注入的 `input.snapshotService` 与 `input.harness.session/bus`（见 cli cmdInput），
 *   本插件不持有任何装配逻辑；`session`/`bus` 经 `input.harness` 读取（类型窄化见命令内 cast）。
 * - 快照未启用（snapshotService 缺省）时给出提示，不抛错；复用同包 `createSessionRevert` 三态控制器。
 */
export function createRevertPlugin(opts: RevertShellOptions = {}): AgentPlugin {
  const hooks: Hooks = {
    'cli.commands'(input: CliCommandsInput) {
      input.commands.push({
        command: 'revert',
        description: '文件快照回滚：stage/clear/commit/status',
        usage: '/revert <sub> [messageID]',
      })
    },

    async 'cli.command'(input: CliCommandInput) {
      if (input.command !== 'revert') return
      const inp = input as RevertCmdInput
      try {
        const snapshot = inp.snapshotService ?? opts.snapshotService
        if (!snapshot) {
          inp.out('快照未启用：构造 HarnessApp 时传 snapshot: true 后可用 /revert。\n')
          return
        }
        const session = (inp.harness as { session?: SessionManager } | undefined)?.session
        const bus = (inp.harness as { bus?: Bus } | undefined)?.bus
        if (!session || !bus) {
          inp.out('harness 未注入 session/bus，无法执行 /revert。\n')
          return
        }
        const revert = createSessionRevert({
          session,
          snapshot,
          bus,
          getFullHistory: inp.getFullHistory,
        })
        // 子命令与参数从完整 raw 解析（cli 注入的 arg 只含第二个 token，见 workspace-shell 同款处理）
        const parts = input.raw.trim().split(/\s+/)
        const sub = parts[1] ?? 'help'
        const sid = input.sessionId
        try {
          switch (sub) {
            case 'help':
              inp.out(
                '用法：\n' +
                '  /revert stage <messageID>  回滚该消息之后的文件变更（生成 diff）\n' +
                '  /revert clear              撤销回滚（恢复回滚前状态）\n' +
                '  /revert commit             接受回滚（文件保持回滚后状态）\n' +
                '  /revert status             查看当前回滚状态\n',
              )
              return
            case 'status': {
              const state = await revert.getState(sid)
              if (!state) { inp.out('（当前无进行中的回滚）\n'); return }
              inp.out(`回滚状态：messageID=${state.messageID}\n`)
              inp.out(`快照：${state.snapshot}\n`)
              const filesText = (state.files ?? []).map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join(', ')
              inp.out(`变更文件：${filesText || '（无）'}\n`)
              return
            }
            case 'clear':
              await revert.clear(sid)
              inp.out('已撤销回滚，文件恢复回滚前状态。\n')
              return
            case 'commit':
              await revert.commit(sid)
              inp.out('已接受回滚，文件保持回滚后状态。\n')
              return
            case 'stage': {
              const messageID = parts[2]
              if (!messageID) { inp.out('用法：/revert stage <messageID>\n'); return }
              const state = await revert.stage({ sessionId: sid, messageID })
              inp.out(`已回滚 ${messageID} 之后的文件变更（${state.files?.length ?? 0} 个文件）：\n`)
              for (const f of state.files ?? []) {
                inp.out(`  ${f.status.padEnd(8)} ${f.path}  +${f.additions}/-${f.deletions}\n`)
                if (f.patch) inp.out(`${f.patch.slice(0, 400)}${f.patch.length > 400 ? '...' : ''}\n`)
              }
              return
            }
            default:
              inp.out(`未知子命令：${sub}，输入 /revert help 查看用法。\n`)
          }
        } catch (err: any) {
          inp.out(`回滚失败：${err?.message ?? String(err)}\n`)
        }
      } finally {
        // 标记命令已处理，避免 cli fallthrough 到"未知命令"
        input.result = 'continue'
      }
    },
  }

  return {
    id: 'revert-shell',
    name: 'Revert Shell',
    version: '0.1.0',
    async install() {
      return hooks
    },
  }
}

// ===== 薄壳插件：/snapshot 命令（cli.commands / cli.command） =====

/** cli.command 输入 + cli 注入的 snapshot 服务（cli 装配时注入） */
export interface SnapshotCmdInput extends CliCommandInput {
  snapshotService?: SnapshotService
}

/** createSnapshotPlugin 入参 */
export interface SnapshotShellOptions {
  /** 注入的 snapshot 服务（缺省改读命令输入的 input.snapshotService） */
  snapshotService?: SnapshotService
}

/**
 * 薄壳 AgentPlugin：把 `/snapshot status|capture|files|help` 以 `cli.command` hook 提供。
 * - 依赖 cli 注入的 `input.snapshotService`，只读/轻量操作，不持有任何装配逻辑。
 * - 快照未启用时给出开启指引（`--snapshot` 或 config.json `harness.snapshot:true`），不抛错。
 */
export function createSnapshotPlugin(opts: SnapshotShellOptions = {}): AgentPlugin {
  const hooks: Hooks = {
    'cli.commands'(input: CliCommandsInput) {
      input.commands.push({
        command: 'snapshot',
        description: '文件快照管理：status/list/capture/diff/restore/checkout/preview/gc/help',
        usage: '/snapshot [status|list|capture [scope]|diff <from> <to> [path]|restore <to> <path...>|checkout <to>|preview <to> <path...>|gc|help]',
      })
    },

    async 'cli.command'(input: CliCommandInput) {
      if (input.command !== 'snapshot') return
      const inp = input as SnapshotCmdInput
      try {
        const snapshot = inp.snapshotService ?? opts.snapshotService
        if (!snapshot) {
          inp.out('快照未启用：启动加 `--snapshot`，或 config.json 设 `"snapshot": true`（亦可 `"harness": { "snapshot": true }`）。\n')
          return
        }
        const parts = input.raw.trim().split(/\s+/)
        const sub = parts[1] ?? 'status'
        switch (sub) {
          case 'help':
            inp.out(
              '用法：\n' +
              '  /snapshot                   查看快照启用状态\n' +
              '  /snapshot status            同上\n' +
              '  /snapshot list              列出快照历史（最新在前，含时间戳）\n' +
              '  /snapshot capture [scope]   手动捕获当前文件系统快照（返回快照 ID）\n' +
              '  /snapshot files <from> <to>     列出两个快照间的变更文件路径\n' +
              '  /snapshot diff <from> <to> [path]   两个快照间的增量统计；给 path 时附 unified 补丁\n' +
              '  /snapshot preview <to> <path...>   零副作用预览：从快照 <to> 恢复指定文件的 diff（不落盘）\n' +
              '  /snapshot restore <to> <path...>   从快照 <to> 恢复指定文件（目标快照中不存在则删除）\n' +
              '  /snapshot checkout <to>           整仓恢复到快照 <to>\n' +
              '  /snapshot gc                    清理过期快照存储\n',
            )
            return
          case 'status': {
            const infos = await snapshot.list()
            const lines = [
              `状态：${snapshot.enabled ? '已启用' : '未启用'}`,
              `后端：${snapshot.backend}`,
              `快照数：${infos.length}`,
            ]
            if (infos[0]) {
              const ts = infos[0].timestamp
                ? new Date(infos[0].timestamp).toLocaleString('zh-CN', { hour12: false })
                : 'unknown'
              lines.push(`最新快照：${infos[0].id}`)
              lines.push(`捕获于：${ts}`)
            } else {
              lines.push('最新快照：（暂无，/snapshot capture 或任意一轮 query 会自动捕获）')
            }
            inp.out(`快照状态：\n${lines.map((l) => `  ${l}`).join('\n')}\n`)
            return
          }
          case 'list': {
            const infos = await snapshot.list()
            if (infos.length === 0) { inp.out('（暂无快照，/snapshot capture 或任意一轮 query 会自动捕获。）\n'); return }
            const lines = infos.map((s) => {
              const ts = s.timestamp
                ? new Date(s.timestamp).toLocaleString('zh-CN', { hour12: false })
                : 'unknown'
              return `  ${s.id}\t${ts}`
            })
            inp.out(`快照（${infos.length}）：\n${lines.join('\n')}\n`)
            return
          }
          case 'capture': {
            const id = await snapshot.capture(parts[2])
            inp.out(id ? `已捕获快照：${id}\n` : '捕获失败（无可捕获变更或出错）。\n')
            return
          }
          case 'files': {
            const from = parts[2], to = parts[3]
            if (!from || !to) { inp.out('用法：/snapshot files <from> <to>\n'); return }
            const paths = await snapshot.files(from as SnapshotID, to as SnapshotID)
            inp.out(paths.length ? `变更文件（${paths.length}）：\n${paths.join('\n')}\n` : '（两个快照间无差异）\n')
            return
          }
          case 'diff': {
            const from = parts[2], to = parts[3], target = parts[4]
            if (!from || !to) { inp.out('用法：/snapshot diff <from> <to> [path]\n'); return }
            const diffs = await snapshot.diff(from as SnapshotID, to as SnapshotID, target ? { paths: [target] } : undefined)
            const statusZh: Record<string, string> = { added: '新增', modified: '修改', deleted: '删除' }
            const summary = diffs.map((d) => `  ${statusZh[d.status] ?? d.status}\t${d.path}\t+${d.additions}/-${d.deletions}`)
            inp.out(summary.length ? `差异：\n${summary.join('\n')}\n` : '（两个快照间无差异）\n')
            if (target && diffs[0]?.patch) inp.out(diffs[0].patch)
            return
          }
          case 'restore': {
            const to = parts[2], paths = parts.slice(3)
            if (!to || paths.length === 0) { inp.out('用法：/snapshot restore <to> <path...>\n'); return }
            await snapshot.restore(new Map(paths.map((p) => [p, to as SnapshotID])))
            inp.out(`已从快照 ${to} 恢复 ${paths.length} 个文件：${paths.join(', ')}\n`)
            return
          }
          case 'checkout': {
            const to = parts[2]
            if (!to) { inp.out('用法：/snapshot checkout <to>\n'); return }
            await snapshot.checkout(to as SnapshotID)
            inp.out(`已整仓恢复到快照 ${to}。\n`)
            return
          }
          case 'preview': {
            const to = parts[2], paths = parts.slice(3)
            if (!to || paths.length === 0) { inp.out('用法：/snapshot preview <to> <path...>\n'); return }
            const diffs = await snapshot.preview(new Map(paths.map((p) => [p, to as SnapshotID])))
            const statusZh: Record<string, string> = { added: '新增', modified: '修改', deleted: '删除' }
            const summary = diffs.map((d) => `  ${statusZh[d.status] ?? d.status}\t${d.path}\t+${d.additions}/-${d.deletions}`)
            inp.out(`回滚预览（自快照 ${to}，不落盘）：\n`)
            inp.out(summary.length ? `${summary.join('\n')}\n` : '（这些文件与快照内容一致，无变更）\n')
            for (const d of diffs) if (d.patch) inp.out(d.patch)
            return
          }
          case 'gc': {
            if (!snapshot.gc) { inp.out('当前后端不支持 gc。\n'); return }
            await snapshot.gc()
            inp.out('已清理过期快照存储。\n')
            return
          }
          default: {
            inp.out(`未知子命令：${sub}，输入 /snapshot help 查看用法。\n`)
            return
          }
        }
      } finally {
        input.result = 'continue'
      }
    },
  }

  return {
    id: 'snapshot-shell',
    name: 'Snapshot Shell',
    version: '0.1.0',
    async install() {
      return hooks
    },
  }
}
