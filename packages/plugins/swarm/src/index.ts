/**
 * @harness/swarm - Swarm 插件（长期在线团队协作）
 *
 * 参考 Claude Code swarm（teammateMailbox / TeamCreateTool / TaskCreateTool /
 * TaskStopTool / leaderPermissionBridge / spawnInProcess）：把多 Agent 协作从
 * "临时派工"升级为"显式组织"：
 *
 * 1. **Team 实体**（TeamManager）：team file 持久化（name/lead/members），
 *    存储于 `~/.harness/teams/{sanitized-name}/`（team.json + inboxes/ + tasks.json）。
 * 2. **Mailbox 文件收件箱**（TeammateMailbox）：每个成员一个 inbox 文件
 *    `inboxes/{agent}.json`，写操作带锁文件（原子 create + 重试），多 Agent 并发安全。
 * 3. **Task List 任务平面**（TaskListPlane）：共享任务池，状态机
 *    available → in_progress → completed/failed/cancelled，teammate 可 claim 未分配任务。
 * 4. **Leader 权限桥**（LeaderPermissionBridge）：module-level bridge，
 *    teammate 的 ask 权限请求回流到 leader 的 ToolUseConfirmQueue（带 workerBadge）。
 * 5. **Inbox Poller**（attachInboxPoller）：周期性读取 unread 消息，回调宿主驱动 teammate。
 * 6. **in-process teammate**（TeammateRegistry + spawnInProcessTeammate）：同进程、
 *    AsyncLocalStorage 隔离身份的子会话长期成员（tmux/iTerm2 后端为后续增强）。
 *
 * 工具：team_create / team_delete / team_status / send_teammate_message /
 * task_create / task_list / task_claim / task_update / task_stop
 *
 * @example
 * import { createSwarmPlugin } from '@harness/swarm'
 *
 * const h = await createHarness({
 *   internalPlugins: [
 *     createSubagentPlugin({ subagents: [teammateAgent] }),
 *     createSwarmPlugin(), // 所有 Agent 注入 swarm 协作工具
 *   ],
 * })
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { open, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentPlugin } from '@harness/plugin'
import type { AgentRuntime, SessionManager } from '@harness/core'
import { defineTool, type Tool, type ToolResult, type Schema, type ToolContext } from '@harness/tool'

// ===== 基础类型与错误 =====

export type SwarmOperation = 'team' | 'mailbox' | 'task' | 'permission'

/** Swarm 操作失败（统一错误，模块特定失败场景） */
export class SwarmError extends Error {
  readonly operation: SwarmOperation
  readonly cause?: unknown

  constructor(operation: SwarmOperation, message: string, cause?: unknown) {
    super(`[swarm:${operation}] ${message}`)
    this.name = 'SwarmError'
    this.operation = operation
    this.cause = cause
  }
}

/** 团队名/成员名 → 安全目录名（小写 + 非字母数字转 -） */
export function sanitizeName(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'unnamed'
}

/** 生成短唯一 ID（task 等用） */
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 默认团队存储根：~/.harness/teams */
function defaultTeamsDir(): string {
  return path.join(homedir(), '.harness', 'teams')
}

/** Schema helper（自包含，避免跨包依赖） */
function makeSchema<T>(): Schema<T> {
  return { parse: (v) => v as T, safeParse: (v) => ({ success: true, data: v as T }) }
}

/**
 * 锁文件互斥（对齐 Claude Code mailbox lockfile）：`{path}.lock` 原子创建（'wx'），
 * 占用（EEXIST）则重试，超时抛错；其它错误（如 ENOENT）直接抛出。
 * 自动确保父目录存在；finally 释放。
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let handle: Awaited<ReturnType<typeof open>> | undefined
  for (;;) {
    try {
      handle = await open(lockPath, 'wx')
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw new SwarmError('mailbox', `Failed to acquire lock: ${lockPath}`, err)
      if (Date.now() > deadline) throw new SwarmError('mailbox', `Lock timeout: ${lockPath}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

// ===== Team 实体 =====

export const TEAM_LEAD_NAME = 'lead'

/** 团队成员（对齐 Claude Code TeamFile.members 条目） */
export interface TeamMember {
  /** Agent 定义 ID（harness.agent.get(agentId)） */
  agentId: string
  /** 团队内成员名（mailbox 收件人地址） */
  name: string
  agentType?: string
  model?: { providerId?: string; modelId?: string; temperature?: number }
  color?: string
  role: 'lead' | 'teammate'
  /** 加入时间（首次入队时记录） */
  joinedAt?: number
  /** tmux pane id（out-of-process teammate 后端） */
  tmuxPaneId?: string
  /** 工作目录（out-of-process teammate 启动 cwd） */
  cwd?: string
  /** 消息订阅（后续 mailbox 路由广播用） */
  subscriptions?: string[]
}

/** Team 文件（对齐 Claude Code TeamFile） */
export interface TeamFile {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId: string
  /** 归属 leader 团队名（setLeaderTeamName 写入；多后端共享任务池定位） */
  leaderTeamName?: string
  members: TeamMember[]
}

/** Team 实体管理：team file 持久化（~/.harness/teams/{name}/team.json） */
export class TeamManager {
  constructor(private readonly teamsDir: string) {}

  teamDir(name: string): string {
    return path.join(this.teamsDir, sanitizeName(name))
  }

  private teamFilePath(name: string): string {
    return path.join(this.teamDir(name), 'team.json')
  }

  /** 创建团队：写入 team.json，初始化 inboxes 目录（task list 惰性创建） */
  async create(input: {
    name: string
    description?: string
    leadAgentId: string
    leadSessionId: string
    leadAgentType?: string
    leadModel?: TeamMember['model']
  }): Promise<TeamFile> {
    const name = sanitizeName(input.name)
    if (await this.get(name)) throw new SwarmError('team', `Team already exists: ${name}`)
    const team: TeamFile = {
      name,
      description: input.description,
      createdAt: Date.now(),
      leadAgentId: input.leadAgentId,
      leadSessionId: input.leadSessionId,
      members: [
        {
          agentId: input.leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: input.leadAgentType,
          model: input.leadModel,
          role: 'lead',
          joinedAt: Date.now(),
        },
      ],
    }
    await mkdir(this.teamDir(name), { recursive: true })
    await mkdir(path.join(this.teamDir(name), 'inboxes'), { recursive: true })
    await writeFile(this.teamFilePath(name), JSON.stringify(team, null, 2), 'utf-8')
    return team
  }

  /** 读取团队；不存在返回 undefined */
  async get(name: string): Promise<TeamFile | undefined> {
    try {
      return JSON.parse(await readFile(this.teamFilePath(name), 'utf-8')) as TeamFile
    } catch {
      return undefined
    }
  }

  /** 列出所有团队 */
  async list(): Promise<TeamFile[]> {
    let dirs: string[] = []
    try {
      const entries = await readdir(this.teamsDir, { withFileTypes: true })
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
    const teams: TeamFile[] = []
    for (const dir of dirs) {
      const team = await this.get(dir)
      if (team) teams.push(team)
    }
    return teams
  }

  /** 加入成员（幂等：同名覆盖；新成员记录 joinedAt） */
  async addMember(name: string, member: TeamMember): Promise<TeamFile> {
    const team = await this.get(name)
    if (!team) throw new SwarmError('team', `Team not found: ${name}`)
    const full: TeamMember = { ...member, joinedAt: member.joinedAt ?? Date.now() }
    team.members = [...team.members.filter((m) => m.name !== member.name), full]
    await writeFile(this.teamFilePath(name), JSON.stringify(team, null, 2), 'utf-8')
    return team
  }

  /** 查询成员（按成员名） */
  getMember(team: TeamFile, memberName: string): TeamMember | undefined {
    return team.members.find((m) => m.name === memberName)
  }

  /**
   * 设置 leader 团队名：把团队绑定到 leader 的任务池命名空间（多后端共享任务池定位；
   * out-of-process teammate 通过 leaderTeamName 找到自己归属的团队目录）。
   */
  async setLeaderTeamName(name: string, leaderTeamName: string): Promise<TeamFile> {
    const team = await this.get(name)
    if (!team) throw new SwarmError('team', `Team not found: ${name}`)
    team.leaderTeamName = leaderTeamName
    await writeFile(this.teamFilePath(name), JSON.stringify(team, null, 2), 'utf-8')
    return team
  }

  /** 删除团队（连同 inboxes/tasks） */
  async delete(name: string): Promise<void> {
    await rm(this.teamDir(name), { recursive: true, force: true })
  }
}

// ===== Mailbox：文件式收件箱（带锁） =====

/** mailbox 协作协议消息类型（对齐 Claude Code MailboxMessage 协议；isStructuredProtocolMessage 用于路由分流） */
export type MailboxMessageType =
  | 'message' // 普通文本
  | 'permission_request' // 权限请求（teammate → leader）
  | 'permission_response' // 权限响应（leader → teammate）
  | 'sandbox_permission_request' // sandbox 权限请求
  | 'sandbox_permission_response' // sandbox 权限响应
  | 'plan_approval_request' // plan 审批请求
  | 'plan_approval_response' // plan 审批响应
  | 'shutdown_request' // 关停请求（leader → teammate）
  | 'shutdown_approved' // 关停已批准（teammate → leader）
  | 'shutdown_rejected' // 关停被拒绝（teammate → leader）
  | 'idle_notification' // teammate 空闲通知（→ leader）
  | 'task_assignment' // 任务指派
  | 'team_permission_update' // 团队权限更新
  | 'mode_set_request' // 模式设置请求
  | 'task_notification' // 任务完成/失败通知

/** Mailbox 消息（对齐 Claude Code MailboxMessage；type 支持协作协议消息） */
export interface MailboxMessage {
  /** 发送者成员名 */
  from: string
  /** 收件人成员名 */
  to: string
  text: string
  summary?: string
  /** ISO 时间戳 */
  timestamp: string
  /** 协作协议消息类型 */
  type: MailboxMessageType
  read?: boolean
  /** 关联请求 ID（权限/关停/plan 请求-响应配对） */
  replyTo?: string
  /** 发起方生成的 requestId（响应方写 replyTo 关联） */
  requestId?: string
  /** plan 审批响应携带的 leader 权限模式（供对方继承） */
  permissionMode?: string
  /** idle_notification 空闲原因 */
  idleReason?: 'available' | 'interrupted' | 'failed'
  /** shutdown 决策（shutdown_approved/rejected） */
  decision?: 'approved' | 'rejected'
  /** 附加结构化数据（permission 响应 allow/forever、sandbox、team_permission_update 等） */
  data?: Record<string, unknown>
}

/** 结构化协议消息类型（非普通 message，poller/teammate 循环按此路由） */
const STRUCTURED_PROTOCOL_TYPES: ReadonlySet<MailboxMessageType> = new Set([
  'permission_request',
  'permission_response',
  'sandbox_permission_request',
  'sandbox_permission_response',
  'plan_approval_request',
  'plan_approval_response',
  'shutdown_request',
  'shutdown_approved',
  'shutdown_rejected',
  'idle_notification',
  'task_assignment',
  'team_permission_update',
  'mode_set_request',
  'task_notification',
])

/** 是否为协作协议消息（true = 结构化路由，避免被当作普通 LLM 上下文吞掉） */
export function isStructuredProtocolMessage(msg: MailboxMessage): boolean {
  return STRUCTURED_PROTOCOL_TYPES.has(msg.type)
}

/**
 * 消息优先级排序（对齐 Claude Code useInboxPoller 的 inbox priority）：
 * shutdown 最高（防 peer 消息饿死）→ lead 消息 > peer 消息；同级保持写入顺序（FIFO，sort 稳定）。
 */
export function sortMessagesByPriority(messages: MailboxMessage[]): MailboxMessage[] {
  const priority = (m: MailboxMessage): number => {
    if (m.type === 'shutdown_request' || m.type === 'shutdown_approved' || m.type === 'shutdown_rejected') return 0
    if (m.from === TEAM_LEAD_NAME) return 1
    return 2
  }
  return [...messages].sort((a, b) => priority(a) - priority(b))
}

let protocolSeq = 0

/** 生成请求 ID（权限/关停/plan 配对用；对齐 generateRequestId） */
export function generateRequestId(prefix: string): string {
  protocolSeq = (protocolSeq + 1) % 0xffff
  return `${prefix}-${Date.now().toString(36)}-${protocolSeq.toString(36)}`
}

/** 构造权限请求消息（对齐 createPermissionRequest） */
export function createPermissionRequest(opts: {
  from: string
  to: string
  toolName: string
  input?: unknown
  requestId?: string
  summary?: string
}): Omit<MailboxMessage, 'to'> & { to: string } {
  const requestId = opts.requestId ?? generateRequestId('perm')
  return {
    from: opts.from,
    to: opts.to,
    text: `[permission] ${opts.toolName} 需要权限批准`,
    summary: opts.summary,
    timestamp: new Date().toISOString(),
    type: 'permission_request',
    requestId,
    data: { toolName: opts.toolName, input: opts.input },
  }
}

/** 构造权限响应消息（对齐 createPermissionResponse） */
export function createPermissionResponse(opts: {
  from: string
  to: string
  requestId: string
  allow: boolean
  forever?: boolean
  summary?: string
}): Omit<MailboxMessage, 'to'> & { to: string } {
  return {
    from: opts.from,
    to: opts.to,
    text: opts.allow ? `[permission] 已批准` : `[permission] 已拒绝`,
    summary: opts.summary,
    timestamp: new Date().toISOString(),
    type: 'permission_response',
    replyTo: opts.requestId,
    data: { allow: opts.allow, forever: opts.forever ?? false },
  }
}

/** 构造关停请求消息（对齐 sendShutdownRequestToMailbox） */
export function createShutdownRequest(opts: {
  from: string
  to: string
  reason?: string
  requestId?: string
}): Omit<MailboxMessage, 'to'> & { to: string } {
  const requestId = opts.requestId ?? generateRequestId('shutdown')
  return {
    from: opts.from,
    to: opts.to,
    text: `[shutdown] 请求关停${opts.reason ? `：${opts.reason}` : ''}`,
    timestamp: new Date().toISOString(),
    type: 'shutdown_request',
    requestId,
    data: { reason: opts.reason },
  }
}

/** 构造关停决策响应消息（shutdown_approved / shutdown_rejected） */
export function createShutdownDecision(opts: {
  from: string
  to: string
  requestId: string
  decision: 'approved' | 'rejected'
  reason?: string
}): Omit<MailboxMessage, 'to'> & { to: string } {
  return {
    from: opts.from,
    to: opts.to,
    text: `[shutdown] ${opts.decision === 'approved' ? '已批准关停' : '拒绝关停'}${opts.reason ? `：${opts.reason}` : ''}`,
    timestamp: new Date().toISOString(),
    type: opts.decision === 'approved' ? 'shutdown_approved' : 'shutdown_rejected',
    replyTo: opts.requestId,
    decision: opts.decision,
  }
}

/** 构造空闲通知消息（teammate → leader；每轮结束上报可用/中断/失败 + 处理摘要） */
export function createIdleNotification(opts: {
  from: string
  to: string
  idleReason?: 'available' | 'interrupted' | 'failed'
  summary?: string
}): Omit<MailboxMessage, 'to'> & { to: string } {
  const idleReason = opts.idleReason ?? 'available'
  return {
    from: opts.from,
    to: opts.to,
    text: `[idle] ${idleReason}`,
    summary: opts.summary,
    timestamp: new Date().toISOString(),
    type: 'idle_notification',
    idleReason,
  }
}

/** 构造 plan 审批请求消息（teammate → leader；携带 plan 内容 + 期望 permissionMode） */
export function createPlanApprovalRequest(opts: {
  from: string
  to: string
  plan?: string
  permissionMode?: string
  requestId?: string
}): Omit<MailboxMessage, 'to'> & { to: string } {
  const requestId = opts.requestId ?? generateRequestId('plan')
  return {
    from: opts.from,
    to: opts.to,
    text: `[plan] 请求审批计划${opts.plan ? `：${opts.plan.slice(0, 100)}` : ''}`,
    timestamp: new Date().toISOString(),
    type: 'plan_approval_request',
    requestId,
    permissionMode: opts.permissionMode,
    data: { plan: opts.plan, permissionMode: opts.permissionMode },
  }
}

/** 构造 plan 审批响应消息（leader → teammate；approved + leader permissionMode 继承） */
export function createPlanApprovalResponse(opts: {
  from: string
  to: string
  requestId: string
  approved: boolean
  permissionMode?: string
}): Omit<MailboxMessage, 'to'> & { to: string } {
  return {
    from: opts.from,
    to: opts.to,
    text: `[plan] ${opts.approved ? '已批准' : '已拒绝'}`,
    timestamp: new Date().toISOString(),
    type: 'plan_approval_response',
    replyTo: opts.requestId,
    permissionMode: opts.permissionMode,
    data: { approved: opts.approved, permissionMode: opts.permissionMode },
  }
}

/**
 * 文件式收件箱：每个成员一个 `inboxes/{agent}.json`（MailboxMessage[]）。
 * 写操作经 withLock 串行化，多 Agent 并发写入安全。
 */
export class TeammateMailbox {
  constructor(private readonly teamsDir: string) {}

  private inboxPath(team: string, agent: string): string {
    return path.join(this.teamsDir, sanitizeName(team), 'inboxes', `${sanitizeName(agent)}.json`)
  }

  private lockPath(team: string, agent: string): string {
    return `${this.inboxPath(team, agent)}.lock`
  }

  /** 读取完整 inbox */
  async readMailbox(team: string, agent: string): Promise<MailboxMessage[]> {
    try {
      return JSON.parse(await readFile(this.inboxPath(team, agent), 'utf-8')) as MailboxMessage[]
    } catch {
      return []
    }
  }

  /** 读取未读消息 */
  async readUnreadMessages(team: string, agent: string): Promise<MailboxMessage[]> {
    const all = await this.readMailbox(team, agent)
    return all.filter((m) => !m.read)
  }

  /** 未读消息数（Inbox Poller 轮询判空用） */
  async countUnread(team: string, agent: string): Promise<number> {
    return (await this.readUnreadMessages(team, agent)).length
  }

  /** 写入消息（带锁） */
  async writeToMailbox(team: string, recipient: string, msg: Omit<MailboxMessage, 'to'>): Promise<MailboxMessage> {
    const full: MailboxMessage = { ...msg, to: recipient }
    const inbox = this.inboxPath(team, recipient)
    await withLock(this.lockPath(team, recipient), async () => {
      let messages: MailboxMessage[] = []
      try {
        messages = JSON.parse(await readFile(inbox, 'utf-8')) as MailboxMessage[]
      } catch {
        // 首次写入
      }
      messages.push(full)
      await mkdir(path.dirname(inbox), { recursive: true })
      await writeFile(inbox, JSON.stringify(messages), 'utf-8')
    })
    return full
  }

  /** 按索引标记已读（带锁；索引为写入顺序，0 = 最新？约定：数组尾=最新，故索引为从数组末尾倒数） */
  async markMessageAsRead(team: string, agent: string, indexFromTail: number): Promise<void> {
    await withLock(this.lockPath(team, agent), async () => {
      const all = await this.readMailbox(team, agent)
      const idx = all.length - 1 - indexFromTail
      if (idx >= 0 && idx < all.length) all[idx]!.read = true
      await writeFile(this.inboxPath(team, agent), JSON.stringify(all), 'utf-8')
    })
  }

  /** 把某条消息标记已读（按消息对象 identity 匹配 from+timestamp） */
  async markMessageAsReadByRef(team: string, agent: string, ref: { from: string; timestamp: string }): Promise<void> {
    await withLock(this.lockPath(team, agent), async () => {
      const all = await this.readMailbox(team, agent)
      for (const m of all) {
        if (m.from === ref.from && m.timestamp === ref.timestamp) m.read = true
      }
      await writeFile(this.inboxPath(team, agent), JSON.stringify(all), 'utf-8')
    })
  }
}

// ===== Task List：共享任务平面 =====

export type SwarmTaskStatus = 'available' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/** 共享任务（对齐 Claude Code task list 条目） */
export interface SwarmTask {
  id: string
  title: string
  description?: string
  status: SwarmTaskStatus
  /** 认领成员名 */
  claimedBy?: string
  /** 依赖任务 id 列表：全部 completed 后才可认领 */
  blockedBy?: string[]
  createdAt: number
  updatedAt: number
  result?: string
}

const TASK_LIFE_CYCLE: Record<SwarmTaskStatus, SwarmTaskStatus[]> = {
  available: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/** Task List 平面：team 绑定的共享任务池（tasks.json，带锁） */
export class TaskListPlane {
  constructor(private readonly teamsDir: string) {}

  private tasksPath(team: string): string {
    return path.join(this.teamsDir, sanitizeName(team), 'tasks.json')
  }

  private lockPath(team: string): string {
    return `${this.tasksPath(team)}.lock`
  }

  private async read(team: string): Promise<SwarmTask[]> {
    try {
      return JSON.parse(await readFile(this.tasksPath(team), 'utf-8')) as SwarmTask[]
    } catch {
      return []
    }
  }

  private async write(team: string, tasks: SwarmTask[]): Promise<void> {
    await mkdir(path.dirname(this.tasksPath(team)), { recursive: true })
    await writeFile(this.tasksPath(team), JSON.stringify(tasks, null, 2), 'utf-8')
  }

  /** 创建任务（available） */
  async create(team: string, input: { title: string; description?: string; blockedBy?: string[] }): Promise<SwarmTask> {
    const task: SwarmTask = {
      id: genId('task'),
      title: input.title,
      description: input.description,
      blockedBy: input.blockedBy && input.blockedBy.length > 0 ? input.blockedBy : undefined,
      status: 'available',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await withLock(this.lockPath(team), async () => {
      const tasks = await this.read(team)
      tasks.push(task)
      await this.write(team, tasks)
    })
    return task
  }

  /** 列出任务（可选按状态过滤） */
  async list(team: string, status?: SwarmTaskStatus): Promise<SwarmTask[]> {
    const tasks = await this.read(team)
    return status ? tasks.filter((t) => t.status === status) : tasks
  }

  /** 查询任务 */
  async get(team: string, id: string): Promise<SwarmTask | undefined> {
    return (await this.read(team)).find((t) => t.id === id)
  }

  /** 认领任务：available → in_progress（已被认领/非 available/依赖未解决抛错；锁内 busy-check 防 TOCTOU） */
  async claim(team: string, id: string, agentName: string): Promise<SwarmTask> {
    let claimed: SwarmTask | undefined
    await withLock(this.lockPath(team), async () => {
      const tasks = await this.read(team)
      const task = tasks.find((t) => t.id === id)
      if (!task) throw new SwarmError('task', `Task not found: ${id}`)
      if (task.status !== 'available') {
        throw new SwarmError('task', `Task ${id} is not claimable (status=${task.status}, claimedBy=${task.claimedBy ?? '-'})`)
      }
      if (task.blockedBy && task.blockedBy.length > 0) {
        const unresolved = task.blockedBy.filter((bid) => {
          const blocker = tasks.find((t) => t.id === bid)
          return !blocker || blocker.status !== 'completed'
        })
        if (unresolved.length > 0) {
          throw new SwarmError('task', `Task ${id} is blocked by unresolved tasks: ${unresolved.join(', ')}`)
        }
      }
      task.status = 'in_progress'
      task.claimedBy = agentName
      task.updatedAt = Date.now()
      await this.write(team, tasks)
      claimed = task
    })
    return claimed!
  }

  /** 状态迁移（带生命周期校验） */
  async update(
    team: string,
    id: string,
    patch: { status?: SwarmTaskStatus; result?: string },
  ): Promise<SwarmTask> {
    let updated: SwarmTask | undefined
    await withLock(this.lockPath(team), async () => {
      const tasks = await this.read(team)
      const task = tasks.find((t) => t.id === id)
      if (!task) throw new SwarmError('task', `Task not found: ${id}`)
      if (patch.status && patch.status !== task.status) {
        if (!TASK_LIFE_CYCLE[task.status].includes(patch.status)) {
          throw new SwarmError('task', `Invalid transition ${task.status} → ${patch.status}`)
        }
        task.status = patch.status
      }
      if (patch.result !== undefined) task.result = patch.result
      task.updatedAt = Date.now()
      await this.write(team, tasks)
      updated = task
    })
    return updated!
  }

  /** 停止任务：in_progress → cancelled（统一 kill switch） */
  async stop(team: string, id: string): Promise<SwarmTask> {
    return this.update(team, id, { status: 'cancelled' })
  }
}

// ===== Leader 权限桥（module-level，对齐 leaderPermissionBridge.ts） =====

export type PermissionDecision = { allow: boolean; forever?: boolean }

/** 权限确认请求（teammate → leader confirm queue） */
export interface ConfirmRequest {
  toolName: string
  input?: unknown
  /** 请求来源 badge（UI 展示谁在请求） */
  workerBadge?: { name: string; color?: string }
  resolve: (decision: PermissionDecision) => void
}

let leaderEnqueue: ((req: ConfirmRequest) => void) | undefined

/**
 * CLI/REPL 注册 leader 的权限确认入口：把 teammate 的 ask 权限请求推入 leader 的
 * ToolUseConfirmQueue（一次一个请求），用户批准/拒绝后 resolve。
 */
export function registerLeaderConfirmQueue(enqueue: (req: ConfirmRequest) => void): void {
  leaderEnqueue = enqueue
}

/** 是否已注册 leader 权限桥 */
export function hasLeaderConfirmQueue(): boolean {
  return leaderEnqueue !== undefined
}

/** 注销 leader 权限桥（CLI/测试清理全局状态） */
export function unregisterLeaderConfirmQueue(): void {
  leaderEnqueue = undefined
}

/**
 * teammate 权限请求：优先借用 leader 的权限确认队列（带 workerBadge）；
 * 无 leader 桥时 fail-closed 拒绝。
 */
export function requestPermissionThroughLeader(
  req: Omit<ConfirmRequest, 'resolve'>,
): Promise<PermissionDecision> {
  return new Promise((resolve) => {
    if (!leaderEnqueue) {
      resolve({ allow: false })
      return
    }
    leaderEnqueue({ ...req, resolve })
  })
}

// ===== 权限 mailbox 双轨 fallback（对齐 useSwarmPermissionPoller + permissionSync） =====

/** 挂起的权限回调（requestId → resolve；teammate 侧注册，收到响应后触发） */
const pendingPermissionCallbacks = new Map<string, (decision: PermissionDecision) => void>()

/** 注册权限回调（requestId 关联） */
export function registerPermissionCallback(requestId: string, resolve: (decision: PermissionDecision) => void): void {
  pendingPermissionCallbacks.set(requestId, resolve)
}

/** 是否还有挂起的权限回调 */
export function hasPendingPermissionCallback(requestId?: string): boolean {
  return requestId ? pendingPermissionCallbacks.has(requestId) : pendingPermissionCallbacks.size > 0
}

/** 通过 mailbox 向目标（通常是 leader）发送权限请求 */
export async function sendPermissionRequestViaMailbox(
  mailbox: TeammateMailbox,
  team: string,
  recipientName: string,
  req: { from: string; toolName: string; input?: unknown; requestId?: string },
): Promise<void> {
  await mailbox.writeToMailbox(team, recipientName, createPermissionRequest({
    from: req.from,
    to: recipientName,
    toolName: req.toolName,
    input: req.input,
    requestId: req.requestId,
  }))
}

/**
 * 处理 teammate inbox 中的权限响应（permission_response / sandbox_permission_response）：
 * 命中挂起回调则 resolve 并标记已读；返回是否处理了响应。
 * teammate poller / 执行循环空闲时调用。
 */
export async function processMailboxPermissionResponse(
  mailbox: TeammateMailbox,
  team: string,
  agentName: string,
): Promise<boolean> {
  const unread = await mailbox.readUnreadMessages(team, agentName)
  let handled = false
  for (const msg of unread) {
    if (msg.type !== 'permission_response' && msg.type !== 'sandbox_permission_response') continue
    const requestId = msg.replyTo
    if (requestId && pendingPermissionCallbacks.has(requestId)) {
      const resolve = pendingPermissionCallbacks.get(requestId)!
      pendingPermissionCallbacks.delete(requestId)
      const allow = msg.data?.allow === true
      const forever = msg.data?.forever === true
      resolve({ allow, forever })
      handled = true
    }
    await mailbox.markMessageAsReadByRef(team, agentName, { from: msg.from, timestamp: msg.timestamp })
  }
  return handled
}

/**
 * 双轨权限请求：有 leader 桥走 confirm queue（workerBadge）；
 * 无桥且提供 mailbox 时降级为 mailbox 请求/响应配对（挂起回调 + 响应轮询）。
 * 两者皆不可用时 fail-closed 拒绝。
 */
export async function requestSwarmPermission(opts: {
  from: string
  toolName: string
  input?: unknown
  workerBadge?: { name: string; color?: string }
  /** 无 leader 桥时的 mailbox 降级参数（都提供才降级） */
  mailbox?: TeammateMailbox
  team?: string
  leaderName?: string
}): Promise<PermissionDecision> {
  if (hasLeaderConfirmQueue()) {
    return requestPermissionThroughLeader({ toolName: opts.toolName, input: opts.input, workerBadge: opts.workerBadge })
  }
  if (opts.mailbox && opts.team && opts.leaderName) {
    const requestId = generateRequestId('perm')
    const decision = new Promise<PermissionDecision>((resolve) => {
      registerPermissionCallback(requestId, resolve)
    })
    await sendPermissionRequestViaMailbox(opts.mailbox, opts.team, opts.leaderName, {
      from: opts.from,
      toolName: opts.toolName,
      input: opts.input,
      requestId,
    })
    return decision
  }
  return { allow: false }
}

// ===== plan approval + permissionMode 继承（对齐 Claude Code plan approval 自动批准） =====

/** 挂起的 plan 审批回调（requestId → resolve；teammate 侧注册，收到响应后触发） */
const pendingPlanApprovalCallbacks = new Map<string, (result: PlanApprovalResult) => void>()

/** plan 审批结果（approved + 继承的 leader permissionMode） */
export interface PlanApprovalResult {
  approved: boolean
  permissionMode?: string
}

/** 注册 plan 审批回调（requestId 关联） */
export function registerPlanApprovalCallback(requestId: string, resolve: (result: PlanApprovalResult) => void): void {
  pendingPlanApprovalCallbacks.set(requestId, resolve)
}

/** 是否还有挂起的 plan 审批回调 */
export function hasPendingPlanApproval(requestId?: string): boolean {
  return requestId ? pendingPlanApprovalCallbacks.has(requestId) : pendingPlanApprovalCallbacks.size > 0
}

/** 通过 mailbox 向 leader 发送 plan 审批请求 */
export async function sendPlanApprovalRequestViaMailbox(
  mailbox: TeammateMailbox,
  team: string,
  recipientName: string,
  req: { from: string; plan?: string; permissionMode?: string; requestId?: string },
): Promise<void> {
  await mailbox.writeToMailbox(team, recipientName, createPlanApprovalRequest({
    from: req.from,
    to: recipientName,
    plan: req.plan,
    permissionMode: req.permissionMode,
    requestId: req.requestId,
  }))
}

/** teammate 侧：请求 plan 审批（写请求到 leader inbox + 挂起回调等待响应配对） */
export async function requestPlanApproval(opts: {
  from: string
  to: string
  plan?: string
  permissionMode?: string
  mailbox: TeammateMailbox
  team: string
}): Promise<PlanApprovalResult> {
  const requestId = generateRequestId('plan')
  const result = new Promise<PlanApprovalResult>((resolve) => {
    registerPlanApprovalCallback(requestId, resolve)
  })
  await sendPlanApprovalRequestViaMailbox(opts.mailbox, opts.team, opts.to, {
    from: opts.from,
    plan: opts.plan,
    permissionMode: opts.permissionMode,
    requestId,
  })
  return result
}

/** teammate 侧：处理 inbox 中的 plan_approval_response（命中回调 resolve + 标记已读） */
export async function processMailboxPlanApprovalResponse(
  mailbox: TeammateMailbox,
  team: string,
  agentName: string,
): Promise<boolean> {
  const unread = await mailbox.readUnreadMessages(team, agentName)
  let handled = false
  for (const msg of unread) {
    if (msg.type !== 'plan_approval_response') continue
    const requestId = msg.replyTo
    if (requestId && pendingPlanApprovalCallbacks.has(requestId)) {
      const resolve = pendingPlanApprovalCallbacks.get(requestId)!
      pendingPlanApprovalCallbacks.delete(requestId)
      resolve({
        approved: msg.data?.approved === true,
        permissionMode: msg.permissionMode ?? (msg.data?.permissionMode as string | undefined),
      })
      handled = true
    }
    await mailbox.markMessageAsReadByRef(team, agentName, { from: msg.from, timestamp: msg.timestamp })
  }
  return handled
}

/**
 * leader 侧：自动批准 plan_approval_request 并回写 plan_approval_response
 * （含 leader permissionMode 继承）；返回处理的请求数。
 */
export async function processMailboxPlanApprovalRequests(
  mailbox: TeammateMailbox,
  team: string,
  leaderName: string,
  opts: { permissionMode?: string } = {},
): Promise<number> {
  const unread = await mailbox.readUnreadMessages(team, leaderName)
  let handled = 0
  for (const msg of unread) {
    if (msg.type !== 'plan_approval_request') continue
    await mailbox.writeToMailbox(team, msg.from, createPlanApprovalResponse({
      from: leaderName,
      to: msg.from,
      requestId: msg.requestId ?? msg.replyTo ?? '',
      approved: true,
      permissionMode: opts.permissionMode,
    }))
    await mailbox.markMessageAsReadByRef(team, leaderName, { from: msg.from, timestamp: msg.timestamp })
    handled++
  }
  return handled
}

// ===== Inbox Poller =====

export interface InboxPollerOptions {
  mailbox: TeammateMailbox
  team: string
  agent: string
  /** 轮询间隔（毫秒），默认 2000；0 = 关闭自动轮询（手动 pollOnce） */
  intervalMs?: number
  /** 新消息回调（消息已自动标记已读） */
  onMessage: (msg: MailboxMessage) => void | Promise<void>
}

export interface InboxPoller {
  start(): void
  stop(): void
  /** 手动轮询一次：读取未读消息 → 回调 → 标记已读 */
  pollOnce(): Promise<void>
  readonly unreadCount: number
}

/**
 * Inbox Poller：周期性读取某成员 inbox 的未读消息并回调宿主
 * （对齐 Claude Code useInboxPoller，简化为无 React 依赖的纯逻辑版本）。
 */
export function attachInboxPoller(options: InboxPollerOptions): InboxPoller {
  const intervalMs = options.intervalMs ?? 2000
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  let unread = 0

  async function pollOnce(): Promise<void> {
    // 优先级：shutdown 最高 → lead > peer（同级 FIFO）
    const messages = sortMessagesByPriority(await options.mailbox.readUnreadMessages(options.team, options.agent))
    if (messages.length === 0) return
    for (const msg of messages) {
      try {
        await options.onMessage(msg)
        // 投递成功后才标记已读（失败留未读，下轮重试，防丢消息）
        await options.mailbox.markMessageAsReadByRef(options.team, options.agent, { from: msg.from, timestamp: msg.timestamp })
      } catch {
        // 单个消息处理失败不阻断后续；该消息保持未读等待下轮重试
      }
    }
    unread = await options.mailbox.countUnread(options.team, options.agent)
  }

  return {
    start() {
      if (running || intervalMs <= 0) return
      running = true
      void pollOnce()
      timer = setInterval(() => { void pollOnce() }, intervalMs)
    },
    stop() {
      running = false
      if (timer) clearInterval(timer)
      timer = undefined
    },
    async pollOnce() {
      await pollOnce()
    },
    get unreadCount() {
      return unread
    },
  }
}

// ===== in-process teammate：AsyncLocalStorage 身份隔离（基础版） =====

/** teammate 身份（AsyncLocalStorage 注入，供权限桥 workerBadge 等使用） */
export interface TeammateIdentity {
  team: string
  name: string
  agentId: string
  color?: string
}

/** 当前 teammate 身份（无则 undefined = 非 teammate 上下文） */
export const currentTeammateStore = new AsyncLocalStorage<TeammateIdentity>()

/** 在 teammate 身份上下文中执行（对齐 spawnInProcess 的 context isolation） */
export function withTeammateIdentity<T>(identity: TeammateIdentity, fn: () => T | Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    currentTeammateStore.run(identity, () => {
      Promise.resolve(fn()).then(resolve, reject)
    })
  })
}

/** 获取当前 teammate 身份（非 teammate 上下文返回 undefined） */
export function getCurrentTeammate(): TeammateIdentity | undefined {
  return currentTeammateStore.getStore()
}

/** teammate 运行时状态（对齐 InProcessTeammateTaskState） */
export interface TeammateTaskState {
  /** 全局唯一 agentId（formatAgentId：{name}@{team}） */
  agentId: string
  identity: TeammateIdentity
  /** 子 session ID（独立隔离上下文） */
  sessionId: string
  status: 'running' | 'idle' | 'shutdown'
  prompt: string
  model?: { providerId?: string; modelId?: string }
  abortController: AbortController
  createdAt: number
}

/** 全局 teammate 注册表（agentId → 状态） */
export class TeammateRegistry {
  private readonly tasks = new Map<string, TeammateTaskState>()

  register(state: TeammateTaskState): void {
    this.tasks.set(state.agentId, state)
  }

  get(agentId: string): TeammateTaskState | undefined {
    return this.tasks.get(agentId)
  }

  list(): TeammateTaskState[] {
    return Array.from(this.tasks.values())
  }

  /** 按成员名在团队内查找 */
  findByMember(team: string, name: string): TeammateTaskState | undefined {
    return this.list().find((t) => t.identity.team === team && t.identity.name === name)
  }

  requestShutdown(agentId: string): boolean {
    const t = this.tasks.get(agentId)
    if (!t) return false
    t.abortController.abort()
    t.status = 'shutdown'
    return true
  }
}

/** 全局 teammate agentId 格式化：{name}@{team}（对齐 formatAgentId） */
export function formatAgentId(name: string, team: string): string {
  return `${sanitizeName(name)}@${sanitizeName(team)}`
}

/** 全局 teammate 注册表单例（spawnInProcessTeammate 默认注册目标，对齐 module-level task registry） */
export const teammateRegistry = new TeammateRegistry()

// ===== in-process teammate 完整执行循环（对齐 inProcessRunner teammateLoop） =====

/** Harness 引用最小接口（避免循环依赖） */
interface HarnessLike {
  agent: AgentRuntime
  session: SessionManager
}

/** 从 Message 提取最终文本 */
function extractText(msg: { parts: Array<{ type: string; text?: string }> }): string {
  return msg.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('')
}

/** teammate 单轮执行依赖 */
export interface TeammateTickDeps {
  harness: HarnessLike
  mailbox: TeammateMailbox
  taskPlane: TaskListPlane
  team: string
  /** 成员名（mailbox 收件人地址） */
  name: string
}

/** teammate 单轮执行结果（诊断/测试） */
export interface TeammateTickResult {
  /** 处理的 mailbox 消息数 */
  handledMessages: number
  /** 本轮认领并执行的任务 */
  claimedTask?: SwarmTask
  /** 执行完的任务（completed/failed） */
  finishedTask?: SwarmTask
  /** 本轮的异常（不抛出，循环继续） */
  error?: string
}

/** 认领下一个 available 任务（对齐 tryClaimNextTask；依赖未解决/已被并发认领的任务跳过，尝试下一个） */
export async function tryClaimNextTask(deps: TeammateTickDeps): Promise<SwarmTask | undefined> {
  const tasks = await deps.taskPlane.list(deps.team, 'available')
  if (tasks.length === 0) return undefined
  for (const task of tasks) {
    try {
      return await deps.taskPlane.claim(deps.team, task.id, deps.name)
    } catch {
      // 依赖未解决或竞态被抢：跳过尝试下一个
    }
  }
  return undefined
}

/** 向 leader 发送 idle_notification（每轮结束上报空闲状态 + 处理摘要） */
async function sendIdleNotification(deps: TeammateTickDeps, result: TeammateTickResult, interrupted: boolean): Promise<void> {
  const idleReason: 'available' | 'interrupted' | 'failed' = result.error
    ? 'failed'
    : interrupted
      ? 'interrupted'
      : 'available'
  await deps.mailbox.writeToMailbox(deps.team, TEAM_LEAD_NAME, {
    from: deps.name,
    text: `[idle] ${idleReason}`,
    summary: `处理 ${result.handledMessages} 条消息${result.claimedTask ? `，认领任务 ${result.claimedTask.id}` : ''}${result.finishedTask ? `，任务 ${result.finishedTask.id} → ${result.finishedTask.status}` : ''}${result.error ? `，异常：${result.error}` : ''}`,
    timestamp: new Date().toISOString(),
    type: 'idle_notification',
    idleReason,
    data: { handledMessages: result.handledMessages },
  })
}

/**
 * teammate 单轮执行（对齐 teammateLoop 的循环体）：
 * 1. 处理挂起的权限响应（mailbox 双轨 fallback 回调配对）
 * 2. 按优先级处理 mailbox 未读消息（shutdown 最高 → lead > peer；投递成功后才标记已读，防丢消息）
 * 3. tryClaimNextTask：认领 available 任务（依赖已解决）→ query 执行 → 更新任务状态 + 通知 leader
 * 4. 每轮结束向 leader 发 idle_notification（available / interrupted / failed + 处理摘要）
 */
export async function runTeammateTick(state: TeammateTaskState, deps: TeammateTickDeps): Promise<TeammateTickResult> {
  const result: TeammateTickResult = { handledMessages: 0 }
  try {
    if (state.status === 'shutdown') return result

    // 1) 先处理挂起的权限响应 / plan 审批响应（mailbox 双轨 fallback 的回调配对）
    await processMailboxPermissionResponse(deps.mailbox, deps.team, deps.name)
    await processMailboxPlanApprovalResponse(deps.mailbox, deps.team, deps.name)

    // 2) mailbox 消息（优先级：shutdown 最高 → lead > peer，同级 FIFO）
    const messages = sortMessagesByPriority(await deps.mailbox.readUnreadMessages(deps.team, deps.name))
    for (const msg of messages) {
      if (state.status !== 'running' && state.status !== 'idle') break
      if (msg.type === 'shutdown_request') {
        // shutdown 模型决策（对齐 Claude Code：shutdown_request 不自动批准）：
        // 把请求注入 query，由模型调用 approve_shutdown / reject_shutdown 工具决策
        try {
          await withTeammateIdentity(state.identity, () =>
            deps.harness.agent.query({
              sessionId: state.sessionId,
              agentId: state.identity.agentId,
              message: `收到团队关停请求（requestId=${msg.requestId ?? '-'}）：${msg.text}\n请调用 approve_shutdown 或 reject_shutdown 工具做出决策。`,
            }),
          )
          // 决策投递成功后才标记已读
          await deps.mailbox.markMessageAsReadByRef(deps.team, deps.name, { from: msg.from, timestamp: msg.timestamp })
          result.handledMessages++
        } catch {
          // 决策查询失败：不标记已读，下轮重试
          result.error = 'shutdown decision failed'
        }
        continue
      }
      try {
        const reply = await withTeammateIdentity(state.identity, () =>
          deps.harness.agent.query({
            sessionId: state.sessionId,
            agentId: state.identity.agentId,
            message: msg.text,
          }),
        )
        await deps.mailbox.writeToMailbox(deps.team, msg.from, {
          from: deps.name,
          text: extractText(reply) || '(无文本回复)',
          timestamp: new Date().toISOString(),
          type: 'message',
          replyTo: msg.timestamp,
        })
        // 回复投递成功后才标记已读
        await deps.mailbox.markMessageAsReadByRef(deps.team, deps.name, { from: msg.from, timestamp: msg.timestamp })
        result.handledMessages++
      } catch (err) {
        result.error = `message handling failed: ${(err as Error).message}`
        // 不标记已读：下轮重试，防丢消息
      }
    }

    // 消息循环中途被中断（如 approve_shutdown 触发关停）：不再认领任务
    const interrupted = state.status !== 'running' && state.status !== 'idle'
    if (interrupted) {
      await sendIdleNotification(deps, result, true)
      return result
    }

    // 3) 认领并执行任务
    const task = await tryClaimNextTask(deps)
    if (!task) {
      await sendIdleNotification(deps, result, false)
      return result
    }
    result.claimedTask = task
    try {
      const reply = await withTeammateIdentity(state.identity, () =>
        deps.harness.agent.query({
          sessionId: state.sessionId,
          agentId: state.identity.agentId,
          message: `执行团队任务 ${task.id}：${task.title}${task.description ? `\n\n${task.description}` : ''}`,
        }),
      )
      const finished = await deps.taskPlane.update(deps.team, task.id, { status: 'completed', result: extractText(reply) })
      result.finishedTask = finished
      // 向 leader 发送任务完成通知
      await deps.mailbox.writeToMailbox(deps.team, TEAM_LEAD_NAME, {
        from: deps.name,
        text: `任务 ${task.id}「${task.title}」已完成`,
        summary: extractText(reply).slice(0, 200),
        timestamp: new Date().toISOString(),
        type: 'task_notification',
        replyTo: task.id,
      })
    } catch (err) {
      const message = (err as Error).message
      result.error = `task execution failed: ${message}`
      result.finishedTask = await deps.taskPlane.update(deps.team, task.id, { status: 'failed', result: message })
      await deps.mailbox.writeToMailbox(deps.team, TEAM_LEAD_NAME, {
        from: deps.name,
        text: `任务 ${task.id}「${task.title}」失败：${message}`,
        timestamp: new Date().toISOString(),
        type: 'task_notification',
        replyTo: task.id,
      })
    }
    await sendIdleNotification(deps, result, false)
    return result
  } catch (err) {
    result.error = (err as Error).message
    try {
      await sendIdleNotification(deps, result, false)
    } catch {
      // 通知失败不掩盖原始错误
    }
    return result
  }
}

/**
 * 派生 in-process teammate（对齐 spawnInProcessTeammate）：
 * 加入团队（不存在则创建，lead=自身）→ 创建独立子 session → 注册到 registry →
 * 带初始 prompt 则立即执行一轮。
 */
export async function spawnInProcessTeammate(input: {
  harness: HarnessLike
  teamManager: TeamManager
  team: string
  name: string
  /** Agent 定义 ID（mode: 'subagent'） */
  agentId: string
  /** 初始任务（可选，立即执行一轮） */
  prompt?: string
  model?: TeammateTaskState['model']
  color?: string
  /** 注册目标（默认全局 teammateRegistry；测试可注入隔离实例） */
  registry?: TeammateRegistry
}): Promise<TeammateTaskState> {
  const { harness, teamManager, team, name, agentId, prompt, model, color, registry: targetRegistry } = input
  let teamFile = await teamManager.get(team)
  if (!teamFile) {
    teamFile = await teamManager.create({ name: team, leadAgentId: agentId, leadSessionId: '' })
  }
  // 加入团队（lead 同名则跳过，避免覆盖）
  if (sanitizeName(name) !== TEAM_LEAD_NAME) {
    await teamManager.addMember(team, { agentId, name, role: 'teammate', model, color })
  }

  const session = await harness.session.create({
    parentId: teamFile.leadSessionId || undefined,
    title: `${sanitizeName(name)}@${teamFile.name}`,
  })

  const taskId = formatAgentId(name, team)
  const state: TeammateTaskState = {
    agentId: taskId,
    identity: { team: teamFile.name, name: sanitizeName(name), agentId, color },
    sessionId: session.id,
    status: 'running',
    prompt: prompt ?? '',
    model,
    abortController: new AbortController(),
    createdAt: Date.now(),
  }
  ;(targetRegistry ?? teammateRegistry).register(state)

  if (prompt) {
    await withTeammateIdentity(state.identity, () =>
      harness.agent.query({ sessionId: session.id, agentId, message: prompt }),
    )
  }
  return state
}

/** teammate 循环句柄 */
export interface TeammateLoopHandle {
  /** 停止循环（teammate 进入 shutdown） */
  stop(): Promise<void>
  readonly running: boolean
}

/**
 * 启动 teammate 执行循环：每 intervalMs 执行一轮 runTeammateTick，
 * 直到 shutdown（stop() 或 mailbox shutdown 消息）。
 */
export function startTeammateLoop(
  state: TeammateTaskState,
  deps: TeammateTickDeps,
  options?: { intervalMs?: number },
): TeammateLoopHandle {
  const intervalMs = options?.intervalMs ?? 1000
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  async function tick(): Promise<void> {
    if (stopped || state.status === 'shutdown') {
      stopped = true
      if (timer) clearInterval(timer)
      return
    }
    await runTeammateTick(state, deps).catch(() => undefined)
  }

  timer = setInterval(() => { void tick() }, intervalMs)
  void tick()

  return {
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      state.status = 'shutdown'
      state.abortController.abort()
    },
    get running() {
      return !stopped && state.status !== 'shutdown'
    },
  }
}

// ===== 工具 =====

/** 工具上下文提取当前 agent/session（供 lead 身份等） */
function ctxIdentity(ctx: ToolContext): { agentId: string; sessionId: string } {
  return { agentId: ctx.agentId, sessionId: ctx.sessionId }
}

/** team_create 输入/输出 */
export interface TeamCreateInput {
  /** 团队名（目录名将 sanitize） */
  name: string
  description?: string
  /** lead Agent 类型（默认当前 agentId） */
  agentType?: string
}
export interface TeamCreateOutput {
  name: string
  leadAgentId: string
  leadSessionId: string
  members: Array<{ name: string; role: string }>
}

export function createTeamCreateTool(getTeamManager: () => TeamManager): Tool<TeamCreateInput, TeamCreateOutput> {
  return defineTool<TeamCreateInput, TeamCreateOutput>({
    id: 'team_create',
    aliases: ['create_team', 'team_new'],
    description: '创建 Swarm 团队：显式 Team 实体（team file 持久化），当前 Agent 成为 lead，自动初始化成员 inbox。输入：name（团队名）、description（可选）、agentType（可选）。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TeamCreateInput>(),
    permission: { key: 'team_create', extractPatterns: (input) => [input.name] },
    async call(input, ctx) {
      try {
        const { agentId, sessionId } = ctxIdentity(ctx)
        const team = await getTeamManager().create({
          name: input.name,
          description: input.description,
          leadAgentId: agentId,
          leadSessionId: sessionId,
          leadAgentType: input.agentType,
        })
        return {
          ok: true,
          output: {
            name: team.name,
            leadAgentId: team.leadAgentId,
            leadSessionId: team.leadSessionId,
            members: team.members.map((m) => ({ name: m.name, role: m.role })),
          },
        }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'TEAM_CREATE_FAILED' } }
      }
    },
    renderUse: (input) => ({ name: input.name, description: input.description }),
    renderResult: (result) => (result.ok && result.output ? { name: result.output.name, lead: result.output.leadAgentId } : undefined),
  })
}

/** team_delete 输入/输出 */
export interface TeamDeleteInput {
  name: string
}
export interface TeamDeleteOutput {
  name: string
}

export function createTeamDeleteTool(getTeamManager: () => TeamManager): Tool<TeamDeleteInput, TeamDeleteOutput> {
  return defineTool<TeamDeleteInput, TeamDeleteOutput>({
    id: 'team_delete',
    aliases: ['delete_team'],
    description: '删除 Swarm 团队（连同 inboxes/tasks 全部清理）。输入：name。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TeamDeleteInput>(),
    permission: { key: 'team_delete', extractPatterns: (input) => [input.name] },
    async call(input) {
      try {
        await getTeamManager().delete(input.name)
        return { ok: true, output: { name: sanitizeName(input.name) } }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'TEAM_DELETE_FAILED' } }
      }
    },
    renderUse: (input) => ({ name: input.name }),
    renderResult: (result) => (result.ok && result.output ? { name: result.output.name } : undefined),
  })
}

/** team_status 输入/输出 */
export interface TeamStatusInput {
  name: string
}
export interface TeamStatusOutput {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  members: Array<{ name: string; role: string; agentId: string }>
  tasks: Array<{ id: string; title: string; status: string; claimedBy?: string }>
}

export function createTeamStatusTool(
  getTeamManager: () => TeamManager,
  getTaskPlane: () => TaskListPlane,
): Tool<TeamStatusInput, TeamStatusOutput> {
  return defineTool<TeamStatusInput, TeamStatusOutput>({
    id: 'team_status',
    aliases: ['team_info', 'team_view'],
    description: '查看 Swarm 团队状态：成员名单 + 共享任务概览。输入：name。',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TeamStatusInput>(),
    permission: { key: 'team_status', extractPatterns: (input) => [input.name] },
    async call(input) {
      const team = await getTeamManager().get(input.name)
      if (!team) return { ok: false, error: { message: `Team not found: ${input.name}`, code: 'TEAM_NOT_FOUND' } }
      const tasks = await getTaskPlane().list(input.name)
      return {
        ok: true,
        output: {
          name: team.name,
          description: team.description,
          createdAt: team.createdAt,
          leadAgentId: team.leadAgentId,
          members: team.members.map((m) => ({ name: m.name, role: m.role, agentId: m.agentId })),
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, claimedBy: t.claimedBy })),
        },
      }
    },
    renderUse: (input) => ({ name: input.name }),
    renderResult: (result) =>
      result.ok && result.output
        ? { name: result.output.name, members: result.output.members.length, tasks: result.output.tasks.length }
        : undefined,
  })
}

/** send_teammate_message 输入/输出 */
export interface SendTeammateMessageInput {
  /** 团队名 */
  team: string
  /** 收件人成员名（lead 表示队长） */
  to: string
  /** 消息内容 */
  message: string
  summary?: string
  /** 消息类型（默认 message；协作协议消息见 MailboxMessageType） */
  type?: 'message' | 'task_notification' | 'permission_response' | 'shutdown_request' | 'shutdown_approved' | 'shutdown_rejected' | 'idle_notification'
}
export interface SendTeammateMessageOutput {
  deliveredTo: string
  team: string
  from: string
  timestamp: string
}

export function createSendTeammateMessageTool(getMailbox: () => TeammateMailbox): Tool<SendTeammateMessageInput, SendTeammateMessageOutput> {
  return defineTool<SendTeammateMessageInput, SendTeammateMessageOutput>({
    id: 'send_teammate_message',
    aliases: ['team_send', 'message_teammate', 'mailbox_send'],
    description: '向团队成员发送消息（写入其 mailbox 收件箱）。输入：team、to（收件人成员名）、message、summary（可选）、type（可选）。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    requiresUserInteraction: false,
    inputSchema: makeSchema<SendTeammateMessageInput>(),
    permission: { key: 'send_teammate_message', extractPatterns: (input) => [input.team, input.to] },
    async call(input, ctx) {
      try {
        const from = ctx.agentId
        const msg = await getMailbox().writeToMailbox(input.team, input.to, {
          from,
          text: input.message,
          summary: input.summary,
          timestamp: new Date().toISOString(),
          type: input.type ?? 'message',
        })
        return {
          ok: true,
          output: { deliveredTo: msg.to, team: sanitizeName(input.team), from: msg.from, timestamp: msg.timestamp },
        }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'MAILBOX_WRITE_FAILED' } }
      }
    },
    renderUse: (input) => ({ to: input.to, message: input.message.length > 100 ? input.message.slice(0, 100) + '...' : input.message }),
    renderResult: (result) => (result.ok && result.output ? { to: result.output.deliveredTo, from: result.output.from } : undefined),
  })
}

// ===== shutdown 决策工具（模型对 shutdown_request 的批准/拒绝，对齐 Claude Code approveShutdown/rejectShutdown） =====

/** approve_shutdown / reject_shutdown 输入 */
export interface ShutdownDecisionInput {
  team: string
  /** 团队成员名（默认用当前 agentId；关停目标按此查找 registry） */
  memberName?: string
  /** 关联的 shutdown_request 的 requestId */
  requestId?: string
  reason?: string
}

/** approve_shutdown / reject_shutdown 输出 */
export interface ShutdownDecisionOutput {
  decision: 'approved' | 'rejected'
}

/**
 * 创建 shutdown 决策工具（approve_shutdown / reject_shutdown）：
 * 向 leader 回发 shutdown_approved / shutdown_rejected；approved 时通过 onDecision
 * 回调触发自身关停（宿主注入，如 abort controller + 状态置 shutdown）。
 */
export function createShutdownDecisionTool(
  decision: 'approved' | 'rejected',
  getMailbox: () => TeammateMailbox,
  onDecision?: (input: ShutdownDecisionInput, ctx: ToolContext) => void | Promise<void>,
): Tool<ShutdownDecisionInput, ShutdownDecisionOutput> {
  const id = decision === 'approved' ? 'approve_shutdown' : 'reject_shutdown'
  return defineTool<ShutdownDecisionInput, ShutdownDecisionOutput>({
    id,
    aliases: decision === 'approved' ? ['accept_shutdown'] : ['deny_shutdown'],
    description:
      decision === 'approved'
        ? '批准团队关停请求：向 leader 回发 shutdown_approved 并触发自身关停。输入：team、requestId（关联的关停请求 ID，可选）、memberName（可选，默认当前成员）、reason（可选）。'
        : '拒绝团队关停请求：向 leader 回发 shutdown_rejected，自身继续运行。输入：team、requestId（可选）、memberName（可选）、reason（可选）。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => decision === 'approved',
    requiresUserInteraction: false,
    inputSchema: makeSchema<ShutdownDecisionInput>(),
    permission: { key: id, extractPatterns: (input) => [input.team] },
    async call(input, ctx) {
      try {
        await getMailbox().writeToMailbox(input.team, TEAM_LEAD_NAME, createShutdownDecision({
          from: input.memberName ?? ctx.agentId,
          to: TEAM_LEAD_NAME,
          requestId: input.requestId ?? '',
          decision,
          reason: input.reason,
        }))
        await onDecision?.(input, ctx)
        return { ok: true, output: { decision } }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'SHUTDOWN_DECISION_FAILED' } }
      }
    },
    renderUse: (input) => ({ team: input.team, requestId: input.requestId, reason: input.reason }),
    renderResult: (result) => (result.ok && result.output ? { decision: result.output.decision } : undefined),
  })
}

/** task_create 输入/输出 */
export interface TaskCreateInput {
  team: string
  title: string
  description?: string
  /** 依赖任务 id 列表（全部完成后才可认领） */
  blockedBy?: string[]
}
export type TaskCreateOutput = SwarmTask

export function createTaskCreateTool(getTaskPlane: () => TaskListPlane): Tool<TaskCreateInput, TaskCreateOutput> {
  return defineTool<TaskCreateInput, TaskCreateOutput>({
    id: 'task_create',
    aliases: ['create_task'],
    description: '在团队共享任务平面创建任务（available，等待成员认领）。输入：team、title、description（可选）、blockedBy（可选，依赖任务 id 列表，全部完成后才可认领）。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TaskCreateInput>(),
    permission: { key: 'task_create', extractPatterns: (input) => [input.team] },
    async call(input) {
      try {
        return { ok: true, output: await getTaskPlane().create(input.team, { title: input.title, description: input.description, blockedBy: input.blockedBy }) }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'TASK_CREATE_FAILED' } }
      }
    },
    renderUse: (input) => ({ team: input.team, title: input.title }),
    renderResult: (result) => (result.ok && result.output ? { id: result.output.id, status: result.output.status } : undefined),
  })
}

/** task_list 输入/输出 */
export interface TaskListInput {
  team: string
  status?: SwarmTaskStatus
}
export type TaskListOutput = SwarmTask[]

export function createTaskListTool(getTaskPlane: () => TaskListPlane): Tool<TaskListInput, TaskListOutput> {
  return defineTool<TaskListInput, TaskListOutput>({
    id: 'task_list',
    aliases: ['list_tasks'],
    description: '列出团队共享任务（可按状态过滤：available/in_progress/completed/failed/cancelled）。输入：team、status（可选）。',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TaskListInput>(),
    permission: { key: 'task_list', extractPatterns: (input) => [input.team] },
    async call(input) {
      try {
        return { ok: true, output: await getTaskPlane().list(input.team, input.status) }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'TASK_LIST_FAILED' } }
      }
    },
    renderUse: (input) => ({ team: input.team, status: input.status }),
    renderResult: (result) =>
      result.ok && result.output ? { count: result.output.length, available: result.output.filter((t) => t.status === 'available').length } : undefined,
  })
}

/** task_claim 输入/输出 */
export interface TaskClaimInput {
  team: string
  taskId: string
  /** 认领成员名（默认当前 agentId） */
  agentName?: string
}
export type TaskClaimOutput = SwarmTask

export function createTaskClaimTool(getTaskPlane: () => TaskListPlane): Tool<TaskClaimInput, TaskClaimOutput> {
  return defineTool<TaskClaimInput, TaskClaimOutput>({
    id: 'task_claim',
    aliases: ['claim_task'],
    description: '认领团队任务：available → in_progress（已被认领或非 available 会失败）。输入：team、taskId、agentName（可选，默认当前 Agent）。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TaskClaimInput>(),
    permission: { key: 'task_claim', extractPatterns: (input) => [input.team, input.taskId] },
    async call(input, ctx) {
      try {
        const agentName = input.agentName ?? ctx.agentId
        return { ok: true, output: await getTaskPlane().claim(input.team, input.taskId, agentName) }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'TASK_CLAIM_FAILED' } }
      }
    },
    renderUse: (input) => ({ team: input.team, taskId: input.taskId, agentName: input.agentName }),
    renderResult: (result) => (result.ok && result.output ? { id: result.output.id, status: result.output.status, claimedBy: result.output.claimedBy } : undefined),
  })
}

/** task_update 输入/输出 */
export interface TaskUpdateInput {
  team: string
  taskId: string
  status?: SwarmTaskStatus
  result?: string
}
export type TaskUpdateOutput = SwarmTask

export function createTaskUpdateTool(getTaskPlane: () => TaskListPlane): Tool<TaskUpdateInput, TaskUpdateOutput> {
  return defineTool<TaskUpdateInput, TaskUpdateOutput>({
    id: 'task_update',
    aliases: ['update_task'],
    description: '更新任务状态（in_progress → completed/failed 等，带生命周期校验）或写入 result。输入：team、taskId、status（可选）、result（可选）。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TaskUpdateInput>(),
    permission: { key: 'task_update', extractPatterns: (input) => [input.team, input.taskId] },
    async call(input) {
      try {
        return {
          ok: true,
          output: await getTaskPlane().update(input.team, input.taskId, {
            status: input.status,
            result: input.result,
          }),
        }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'TASK_UPDATE_FAILED' } }
      }
    },
    renderUse: (input) => ({ team: input.team, taskId: input.taskId, status: input.status }),
    renderResult: (result) => (result.ok && result.output ? { id: result.output.id, status: result.output.status } : undefined),
  })
}

/** task_stop 输入/输出 */
export interface TaskStopInput {
  team: string
  taskId: string
}
export type TaskStopOutput = SwarmTask

export function createTaskStopTool(getTaskPlane: () => TaskListPlane): Tool<TaskStopInput, TaskStopOutput> {
  return defineTool<TaskStopInput, TaskStopOutput>({
    id: 'task_stop',
    aliases: ['stop_task'],
    description: '停止进行中的任务：in_progress → cancelled（统一 kill switch）。输入：team、taskId。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TaskStopInput>(),
    permission: { key: 'task_stop', extractPatterns: (input) => [input.team, input.taskId] },
    async call(input) {
      try {
        return { ok: true, output: await getTaskPlane().stop(input.team, input.taskId) }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: 'TASK_STOP_FAILED' } }
      }
    },
    renderUse: (input) => ({ team: input.team, taskId: input.taskId }),
    renderResult: (result) => (result.ok && result.output ? { id: result.output.id, status: result.output.status } : undefined),
  })
}

// ===== 插件 =====

export interface SwarmPluginOptions {
  /** 团队存储根目录（默认 ~/.harness/teams） */
  teamsDir?: string
  /** inbox 自动轮询间隔（毫秒，默认 2000；0 关闭自动轮询） */
  inboxPollIntervalMs?: number
}

/**
 * 创建 Swarm 插件：向所有 Agent 注入 swarm 协作工具
 * （team/task/send_teammate_message），并提供 TeamManager/Mailbox/TaskListPlane
 * 访问器供宿主（CLI/SDK）编排 teammate。
 */
export function createSwarmPlugin(options: SwarmPluginOptions = {}): AgentPlugin {
  const teamsDir = options.teamsDir ?? defaultTeamsDir()
  const teamManager = new TeamManager(teamsDir)
  const mailbox = new TeammateMailbox(teamsDir)
  const taskPlane = new TaskListPlane(teamsDir)

  return {
    id: 'swarm',
    version: '0.1.0',
    name: 'Swarm',
    description: 'Swarm 插件：Team 实体 + Mailbox + Task List 任务平面 + Leader 权限桥 + in-process teammate（长期在线团队协作）',

    async install(ctx) {
      ctx.log.info('Swarm 插件已加载', { teamsDir })

      const tools: Tool<unknown, unknown>[] = [
        createTeamCreateTool(() => teamManager) as unknown as Tool<unknown, unknown>,
        createTeamDeleteTool(() => teamManager) as unknown as Tool<unknown, unknown>,
        createTeamStatusTool(() => teamManager, () => taskPlane) as unknown as Tool<unknown, unknown>,
        createSendTeammateMessageTool(() => mailbox) as unknown as Tool<unknown, unknown>,
        // shutdown 决策工具：approve 时按 memberName 查找 teammate 并关停
        createShutdownDecisionTool('approved', () => mailbox, async (input, ctx) => {
          const name = input.memberName ?? ctx.agentId
          const state = teammateRegistry.findByMember(input.team, name)
          if (state) {
            state.abortController.abort()
            state.status = 'shutdown'
          }
        }) as unknown as Tool<unknown, unknown>,
        createShutdownDecisionTool('rejected', () => mailbox) as unknown as Tool<unknown, unknown>,
        createTaskCreateTool(() => taskPlane) as unknown as Tool<unknown, unknown>,
        createTaskListTool(() => taskPlane) as unknown as Tool<unknown, unknown>,
        createTaskClaimTool(() => taskPlane) as unknown as Tool<unknown, unknown>,
        createTaskUpdateTool(() => taskPlane) as unknown as Tool<unknown, unknown>,
        createTaskStopTool(() => taskPlane) as unknown as Tool<unknown, unknown>,
      ]

      return {
        'tool.pool.assemble'(input, pool) {
          const reg = pool as { add: (t: unknown) => void }
          for (const tool of tools) reg.add(tool)
        },
      }
    },
  }
}

/** 便捷导出：默认 Swarm 插件 */
export const swarmPlugin = createSwarmPlugin()

/** 插件访问器工厂：宿主可复用同一份 manager 实例 */
export function createSwarmManagers(teamsDir?: string): {
  teamManager: TeamManager
  mailbox: TeammateMailbox
  taskPlane: TaskListPlane
} {
  const dir = teamsDir ?? defaultTeamsDir()
  return {
    teamManager: new TeamManager(dir),
    mailbox: new TeammateMailbox(dir),
    taskPlane: new TaskListPlane(dir),
  }
}
