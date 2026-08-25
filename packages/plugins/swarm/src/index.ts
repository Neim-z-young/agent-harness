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
}

/** Team 文件（对齐 Claude Code TeamFile） */
export interface TeamFile {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId: string
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

  /** 加入成员（幂等：同名覆盖） */
  async addMember(name: string, member: TeamMember): Promise<TeamFile> {
    const team = await this.get(name)
    if (!team) throw new SwarmError('team', `Team not found: ${name}`)
    team.members = [...team.members.filter((m) => m.name !== member.name), member]
    await writeFile(this.teamFilePath(name), JSON.stringify(team, null, 2), 'utf-8')
    return team
  }

  /** 查询成员（按成员名） */
  getMember(team: TeamFile, memberName: string): TeamMember | undefined {
    return team.members.find((m) => m.name === memberName)
  }

  /** 删除团队（连同 inboxes/tasks） */
  async delete(name: string): Promise<void> {
    await rm(this.teamDir(name), { recursive: true, force: true })
  }
}

// ===== Mailbox：文件式收件箱（带锁） =====

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
  /** 协作协议消息类型（普通文本 / 权限请求 / 权限响应 / 关停 / 任务通知） */
  type: 'message' | 'permission_request' | 'permission_response' | 'shutdown' | 'task_notification'
  read?: boolean
  /** 关联请求 ID（权限请求/响应配对用） */
  replyTo?: string
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
  async create(team: string, input: { title: string; description?: string }): Promise<SwarmTask> {
    const task: SwarmTask = {
      id: genId('task'),
      title: input.title,
      description: input.description,
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

  /** 认领任务：available → in_progress（已被认领/非 available 抛错） */
  async claim(team: string, id: string, agentName: string): Promise<SwarmTask> {
    let claimed: SwarmTask | undefined
    await withLock(this.lockPath(team), async () => {
      const tasks = await this.read(team)
      const task = tasks.find((t) => t.id === id)
      if (!task) throw new SwarmError('task', `Task not found: ${id}`)
      if (task.status !== 'available') {
        throw new SwarmError('task', `Task ${id} is not claimable (status=${task.status}, claimedBy=${task.claimedBy ?? '-'})`)
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
    const messages = await options.mailbox.readUnreadMessages(options.team, options.agent)
    if (messages.length === 0) return
    for (const msg of messages) {
      try {
        await options.onMessage(msg)
      } catch {
        // 单个消息处理失败不阻断后续
      }
      await options.mailbox.markMessageAsReadByRef(options.team, options.agent, { from: msg.from, timestamp: msg.timestamp })
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

// ===== 工具 =====

/** Harness 引用最小接口（避免循环依赖） */
interface HarnessLike {
  agent: AgentRuntime
  session: SessionManager
}

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
  /** 消息类型（默认 message） */
  type?: 'message' | 'task_notification' | 'permission_response' | 'shutdown'
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

/** task_create 输入/输出 */
export interface TaskCreateInput {
  team: string
  title: string
  description?: string
}
export type TaskCreateOutput = SwarmTask

export function createTaskCreateTool(getTaskPlane: () => TaskListPlane): Tool<TaskCreateInput, TaskCreateOutput> {
  return defineTool<TaskCreateInput, TaskCreateOutput>({
    id: 'task_create',
    aliases: ['create_task'],
    description: '在团队共享任务平面创建任务（available，等待成员认领）。输入：team、title、description（可选）。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    requiresUserInteraction: false,
    inputSchema: makeSchema<TaskCreateInput>(),
    permission: { key: 'task_create', extractPatterns: (input) => [input.team] },
    async call(input) {
      try {
        return { ok: true, output: await getTaskPlane().create(input.team, { title: input.title, description: input.description }) }
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
