/**
 * MCP 会话表 + 待决 server→client 请求表（elicitation 用）。
 *
 * 范式参照 `a2a-server/src/suspend.ts`：**挂起表 + TTL + 超时转失败**。差别只在结算物：
 * A2A 挂的是"任务的最终答复"，本表挂的是"一次 elicitation 的允许/拒绝"。
 *
 * ## 为什么超时必须转 cancel 而不是"不结算"
 * 一个永远不 resolve 的 promise 会**把 tools/call 的响应流永久挂住**（SSE 不 close），
 * 客户端那头表现为 IDE 一直转圈。超时转 cancel ⇒ 上层按 Fail-Closed 拒绝 ⇒ 错误可见。
 */
import { randomUUID } from 'node:crypto'

export interface McpSession {
  id: string
  protocolVersion: string
  /**
   * 该会话的客户端是否支持 elicitation（**协商时定死**，运行期不再变）。
   * 依据是协议版本 —— `2025-06-18` 才引入 elicitation，旧版本天然不支持。
   */
  elicitation: boolean
  createdAt: number
  lastSeenAt: number
}

/** elicitation 的三态答复（MCP 语义） */
export type ElicitAction = 'accept' | 'decline' | 'cancel'

export interface ElicitAnswer {
  action: ElicitAction
  content?: Record<string, unknown>
}

export interface PendingElicit {
  id: string
  sessionId: string
  /** 一句话摘要（状态展示 / 自检用） */
  message: string
  deadlineAt: number
}

export interface McpSessionTableOptions {
  /** 单次 elicitation 的等待上限（毫秒），缺省 5 分钟（与 A2A 挂起表同值） */
  elicitTtlMs?: number
  now?: () => number
  idFactory?: () => string
}

export const DEFAULT_ELICIT_TTL_MS = 5 * 60_000

interface PendingEntry {
  sessionId: string
  message: string
  deadlineAt: number
  resolve: (a: ElicitAnswer) => void
  timer: ReturnType<typeof setTimeout>
}

export class McpSessionTable {
  private readonly sessions = new Map<string, McpSession>()
  private readonly pending = new Map<string, PendingEntry>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly idFactory: () => string

  constructor(opts: McpSessionTableOptions = {}) {
    this.ttlMs = opts.elicitTtlMs ?? DEFAULT_ELICIT_TTL_MS
    this.now = opts.now ?? (() => Date.now())
    this.idFactory = opts.idFactory ?? (() => randomUUID())
  }

  // ----- 会话 -----

  create(protocolVersion: string, elicitation: boolean): McpSession {
    const t = this.now()
    const s: McpSession = { id: this.idFactory(), protocolVersion, elicitation, createdAt: t, lastSeenAt: t }
    this.sessions.set(s.id, s)
    return s
  }

  get(id: string | undefined): McpSession | undefined {
    return id === undefined ? undefined : this.sessions.get(id)
  }

  has(id: string | undefined): boolean {
    return id !== undefined && this.sessions.has(id)
  }

  touch(id: string): void {
    const s = this.sessions.get(id)
    if (s) s.lastSeenAt = this.now()
  }

  /** 终止会话：同时结算它名下所有待决 elicitation（按 cancel 处理，避免悬挂） */
  delete(id: string): boolean {
    const existed = this.sessions.delete(id)
    for (const [eid, entry] of [...this.pending]) {
      if (entry.sessionId !== id) continue
      this.settle(eid, { action: 'cancel' })
    }
    return existed
  }

  get size(): number {
    return this.sessions.size
  }

  list(): McpSession[] {
    return [...this.sessions.values()]
  }

  clear(): void {
    for (const id of [...this.sessions.keys()]) this.delete(id)
  }

  // ----- 待决 elicitation -----

  /**
   * 登记一次 elicitation，返回 id（要发给客户端的请求 id）与结算 promise。
   * 超过 `elicitTtlMs` 未被答复 ⇒ 按 `cancel` 结算。
   */
  registerElicit(sessionId: string, message: string): { id: string; promise: Promise<ElicitAnswer> } {
    const id = `elicit_${this.idFactory()}`
    const deadlineAt = this.now() + this.ttlMs
    const promise = new Promise<ElicitAnswer>((resolve) => {
      const timer = setTimeout(() => this.settle(id, { action: 'cancel' }), this.ttlMs)
      // Node/Bun 下定时器不应阻止进程退出
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.pending.set(id, { sessionId, message, deadlineAt, resolve, timer })
    })
    return { id, promise }
  }

  /**
   * 用客户端答复结算。返回是否命中某个待决项 ——
   * 未命中（重复答复 / 已超时 / id 伪造）⇒ `false`，由调用方决定回 202 还是 404。
   */
  resolveElicit(id: string, answer: ElicitAnswer): boolean {
    if (!this.pending.has(id)) return false
    this.settle(id, answer)
    return true
  }

  pendingList(): PendingElicit[] {
    return [...this.pending.entries()].map(([id, e]) => ({
      id,
      sessionId: e.sessionId,
      message: e.message,
      deadlineAt: e.deadlineAt,
    }))
  }

  get pendingCount(): number {
    return this.pending.size
  }

  private settle(id: string, answer: ElicitAnswer): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(answer)
  }
}
