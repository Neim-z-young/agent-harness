#!/usr/bin/env bun
/**
 * @harness/cli - Agent Harness 命令行入口
 *
 * 命令：
 *   harness repl                 交互式 REPL（默认命令，start 别名）
 *   harness start                同 repl
 *   harness list-sessions        列出持久化会话
 *   harness resume <sessionId>   恢复指定会话继续交互
 *   harness run "<prompt>"       一次性执行 prompt 并输出结果
 *
 * CLI 选项（适用于 repl/start/run）：
 *   --cwd <dir>               工作目录
 *   --agent <id>              默认 Agent ID
 *   --provider <name>         mock / anthropic（默认 anthropic，未配 key 时自动 fallback mock）
 *   --session <id>            复用/新建指定 ID 的会话（如 resume）
 *   --data-dir <dir>          持久化目录（默认 ~/.harness）
 *   --permission <mode>       allow-all / ask（默认 ask）
 *   --verbose                 输出调试信息
 *
 * 可执行入口（shebang 指向 bun）。模块对外导出 CLIApp 类，便于测试。
 */

import {
  createHarness,
  AgentDefinition,
  Harness,
  DefaultPermissionEngine,
  ChatProvider,
  PermissionDecision,
} from '@harness/core'
import type { AgentPlugin, PluginContext } from '@harness/plugin'
import {
  createProviderMockPlugin,
  providerMockPlugin,
  MockChatProvider,
} from '@harness/provider-mock'
import { createProviderAnthropicPlugin, providerAnthropicPlugin, AnthropicChatProvider } from '@harness/provider-anthropic'
import { toolsBuiltinPlugin, createToolsBuiltinPlugin } from '@harness/tools-builtin'
import { BackgroundTaskMonitor, type BackgroundTaskView } from '@harness/subagent'
import type { Message, Session } from '@harness/session'
import type { ToolContext, Tool } from '@harness/tool'

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'

// ========================================================================
// 1. 参数解析
// ========================================================================

export interface CliArgs {
  /** 子命令：repl / start / list-sessions / resume / run */
  command: 'repl' | 'list-sessions' | 'resume' | 'run' | 'help'
  /** resume / run 的参数 */
  arg?: string
  /** 选项 */
  cwd?: string
  agentId?: string
  provider?: 'mock' | 'anthropic'
  sessionId?: string
  dataDir?: string
  permissionMode?: 'allow-all' | 'ask'
  verbose?: boolean
  showHelp?: boolean
}

/**
 * 最小化参数解析（不引入外部依赖）
 * 支持：短形式 (-c dir) 与长形式 (--cwd dir / --cwd=dir) / 布尔标记 --verbose
 */
export function parseCliArgs(raw: string[]): CliArgs {
  const args = raw.slice()
  let command: CliArgs['command'] = 'repl'
  let arg: string | undefined

  const out: CliArgs = { command: 'repl' }

  // 第一个非标记 token → 子命令
  if (args.length > 0 && !args[0].startsWith('-')) {
    const cmd = args.shift()!
    if (['repl', 'start'].includes(cmd)) command = 'repl'
    else if (cmd === 'list-sessions') command = 'list-sessions'
    else if (cmd === 'resume') command = 'resume'
    else if (cmd === 'run') command = 'run'
    else if (cmd === 'help' || cmd === '--help' || cmd === '-h') { out.showHelp = true; command = 'help' }
    else { arg = cmd } // 非标准：直接填 arg 用于 run 无命令场景
    if ((command === 'resume' || command === 'run') && args.length > 0 && !args[0].startsWith('-')) {
      arg = args.shift()!
    }
    out.command = command
    out.arg = arg
  }

  while (args.length > 0) {
    const a = args.shift()!
    if (a === '-h' || a === '--help') { out.showHelp = true; continue }
    if (a === '-v' || a === '--verbose') { out.verbose = true; continue }
    const [k, v] = a.startsWith('--')
      ? a.slice(2).split('=', 2) as [string, string | undefined]
      : (() => {
          // 短选项：-s=foo → [s, foo]；-s → [s, undefined]
          const body = a.slice(1)
          const eq = body.indexOf('=')
          if (eq >= 0) return [body.slice(0, eq), body.slice(eq + 1)] as [string, string]
          return [body[0] ?? '', undefined] as [string, undefined]
        })()
    // 短选项特殊处理：-s=foo → k=s, v=foo；-s foo → k=s, v 从后续取
    let key = k
    let value: string | undefined = v
    if (!a.startsWith('--') && v === undefined) {
      // 短选项 -Xval 形式：key 已取 body[0]，value=body.slice(1)（如果是单字符 key 且无 =）
      const body = a.slice(1)
      if (body.length > 0 && body.indexOf('=') < 0 && body.length > 1) {
        // 仅在未用 = 形式，且 body 长度 >1 时当 -Xval
        key = body[0]
        value = body.slice(1)
      }
    }
    if (value === undefined) value = args.shift()
    switch (key) {
      case 'c': case 'cwd': out.cwd = value; break
      case 'a': case 'agent': out.agentId = value; break
      case 'p': case 'provider': out.provider = value === 'mock' ? 'mock' : value === 'anthropic' ? 'anthropic' : undefined; break
      case 's': case 'session': out.sessionId = value; break
      case 'd': case 'data-dir': out.dataDir = value; break
      case 'permission': out.permissionMode = value === 'allow-all' ? 'allow-all' : 'ask'; break
      case 'run': // "harness --run xxx" 场景
        out.command = 'run'; out.arg = value; break
      default: break // 忽略未知
    }
  }
  if (out.showHelp) out.command = 'help'
  return out
}

// ========================================================================
// 2. 会话持久化（文件 JSON）
// ========================================================================

/** 会话存储结构（文件 = sessionId.json） */
export interface SessionFile {
  /** 会话元数据 */
  id: string
  title?: string
  createdAt: number
  updatedAt: number
  agentId?: string
  cwd?: string
  meta?: Record<string, unknown>
  /** 完整消息列表 */
  messages: Message[]
}

export class SessionFileStore {
  constructor(public readonly dataDir: string) {}

  private sessionsDir(): string {
    return join(this.dataDir, 'sessions')
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.sessionsDir(), { recursive: true })
  }

  /** 会话文件路径 */
  pathFor(sessionId: string): string {
    return join(this.sessionsDir(), `${sessionId}.json`)
  }

  /** 从 Session → 文件对象 */
  toFile(s: Session): SessionFile {
    return {
      id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
      agentId: s.agentId, cwd: s.cwd, meta: s.meta, messages: s.messages,
    }
  }

  /** 持久化一个 Session */
  async save(session: Session): Promise<void> {
    await this.ensureDir()
    await writeFile(this.pathFor(session.id), JSON.stringify(this.toFile(session), null, 2))
  }

  /** 从文件恢复为 Session 对象（未注入 SessionManager） */
  async load(sessionId: string): Promise<SessionFile | undefined> {
    const p = this.pathFor(sessionId)
    if (!existsSync(p)) return undefined
    return JSON.parse(await readFile(p, 'utf-8')) as SessionFile
  }

  /** 列出所有会话（按 updatedAt 倒序） */
  async list(): Promise<Array<{ id: string; title?: string; updatedAt: number; messageCount: number }>> {
    if (!existsSync(this.sessionsDir())) return []
    const files = await readdir(this.sessionsDir())
    const ids = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    const items: Array<{ id: string; title?: string; updatedAt: number; messageCount: number }> = []
    for (const id of ids) {
      const s = await this.load(id)
      if (s) items.push({ id, title: s.title, updatedAt: s.updatedAt, messageCount: s.messages.length })
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return items
  }
}

// ========================================================================
// 3. 权限交互（CLI 提示符：allow / deny / always）
// ========================================================================

/** 规则持久化（dataDir/permissions.json） */
export interface PermissionStoreFile {
  rules: Record<string, unknown> // 对应 PermissionRuleset
}

export class CliPermissionEngine extends DefaultPermissionEngine {
  constructor(
    rules: Record<string, unknown> = { '*': 'ask' },
    private readonly options: {
      store?: PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }
      mode?: 'allow-all' | 'ask'
      /** 测试注入：替换真实 readline 交互 */
      askPrompt?: (question: string) => Promise<string>
      stdout?: NodeJS.WritableStream | { write: (s: string) => void }
    } = {}
  ) {
    super(rules as any)
  }

  private write(s: string) {
    ;(this.options.stdout ?? process.stdout).write(s)
  }

  /** CLI 级 ask：默认 mode=allow-all 直接 allow；mode=ask 则 prompt 用户 */
  override async ask(req: any): Promise<PermissionDecision> {
    if (this.options.mode === 'allow-all') return { behavior: 'allow', matchedRule: 'global' }
    const promptFn = this.options.askPrompt ?? defaultCliAsk(this.write)
    const pat = (req.patterns ?? []).slice(0, 3).join(', ') || '(无路径)'
    const q = `\n⚠️  权限请求 [${req.toolKey}] ${pat}\n` +
      `  操作: allow / deny / always(a) / deny-always(d)? [a/d/A/D] `
    const answer = (await promptFn(q)).trim()
    const low = answer.toLowerCase()
    // 先判断"永久"：answer 保留大小写（A/D 直接表示永久），否则"always"/"never"语义
    const permanentAllow = low === 'always' || low === 'all' || answer === 'A'
    const permanentDeny = low === 'never' || low === 'none' || answer === 'D'
    if (permanentAllow) {
      const current = this.getRules()
      const updated = { ...current, [req.toolKey]: 'allow' }
      this.updateRules(updated)
      await this.options.store?.save?.(updated)
      return { behavior: 'allow', matchedRule: 'tool', remember: true }
    }
    if (permanentDeny) {
      const current = this.getRules()
      const updated = { ...current, [req.toolKey]: 'deny' }
      this.updateRules(updated)
      await this.options.store?.save?.(updated)
      return { behavior: 'deny', matchedRule: 'tool', remember: true }
    }
    // 单次
    if (['y', 'yes', 'a', 'allow'].includes(low)) return { behavior: 'allow', matchedRule: 'tool' }
    if (['n', 'no', 'd', 'deny'].includes(low)) return { behavior: 'deny', matchedRule: 'tool' }
    return { behavior: 'deny', matchedRule: 'global' }
  }
}

/** 默认 CLI 读行（process.stdin/readline） */
function defaultCliAsk(write: (s: string) => void): (q: string) => Promise<string> {
  return (q: string) => new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, (ans) => { rl.close(); resolve(ans) })
  })
}

// ========================================================================
// 4. HarnessApp：CLI 级的 Harness 封装（会话持久化、权限存储、插件装配）
// ========================================================================

export interface HarnessAppOptions {
  cwd: string
  dataDir: string
  agentId: string
  provider: 'mock' | 'anthropic'
  sessionId?: string
  permissionMode?: 'allow-all' | 'ask'
  /** 测试注入 */
  mockProviderConfig?: Parameters<typeof createProviderMockPlugin>[0]
  anthropicProviderConfig?: any
  askPrompt?: (q: string) => Promise<string>
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  verbose?: boolean
  /** 额外要注册的 Agent 列表 */
  agents?: AgentDefinition[]
  /** 额外 internalPlugins */
  extraPlugins?: AgentPlugin[]
}

export class HarnessApp {
  public readonly sessionStore: SessionFileStore
  public readonly permissionStorePath: string
  private harness!: Harness
  private options: Required<Pick<HarnessAppOptions, 'cwd' | 'dataDir' | 'agentId' | 'provider'>> & HarnessAppOptions

  constructor(options: HarnessAppOptions) {
    const cwd = resolve(options.cwd)
    this.options = { ...options, cwd, dataDir: resolve(options.dataDir), agentId: options.agentId, provider: options.provider }
    this.sessionStore = new SessionFileStore(this.options.dataDir)
    this.permissionStorePath = join(this.options.dataDir, 'permissions.json')
  }

  /** 加载权限文件 */
  private async loadRules(): Promise<Record<string, unknown>> {
    if (existsSync(this.permissionStorePath)) {
      try {
        const s = JSON.parse(await readFile(this.permissionStorePath, 'utf-8')) as PermissionStoreFile
        return s.rules ?? { '*': 'ask' }
      } catch { return { '*': 'ask' } }
    }
    return { '*': 'ask' }
  }
  private async saveRules(rules: Record<string, unknown>): Promise<void> {
    await mkdir(this.options.dataDir, { recursive: true })
    await writeFile(this.permissionStorePath, JSON.stringify({ rules }, null, 2))
  }

  /** 默认 Agent 定义（无 agent 指定时使用） */
  defaultAgent(): AgentDefinition {
    return {
      id: this.options.agentId,
      name: 'Harness Agent',
      description: 'CLI 默认 Agent',
      mode: 'primary',
      tools: ['*'],
      permission: { '*': 'ask' },
      promptFragments: [
        'You are Harness Agent, a helpful assistant with access to tools (file system, shell).',
        'Be concise and precise.',
      ],
    }
  }

  /** 装配并启动 Harness，返回已 start 的实例；加载/恢复 session */
  async boot(): Promise<{ harness: Harness; session: Session }> {
    const rules = await this.loadRules()
    const mode = this.options.permissionMode ?? 'ask'
    const perm = new CliPermissionEngine(rules, {
      mode,
      askPrompt: this.options.askPrompt,
      stdout: this.options.stdout,
      store: {
        ...(rules as any),
        save: (r) => this.saveRules(r),
      },
    })

    // Provider 插件：优先用户选项；anthropic 无 key 时 fallback mock
    const providerPlugins: AgentPlugin[] = []
    let chosenProvider: AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } }
    if (this.options.provider === 'mock') {
      chosenProvider = createProviderMockPlugin({
        defaultResponse: '(Mock Provider) 你好，我是测试助手。',
        ...(this.options.mockProviderConfig ?? {}),
      })
    } else {
      const envKey = typeof process !== 'undefined' ? process.env.ANTHROPIC_API_KEY : undefined
      const hasKey = !!(this.options.anthropicProviderConfig?.apiKey ?? envKey)
      if (hasKey) {
        chosenProvider = createProviderAnthropicPlugin(this.options.anthropicProviderConfig) as any
      } else {
        // 自动 fallback mock 并打印提示
        this.options.stdout?.write?.(
          'ℹ️  未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock Provider。\n' +
          '   如要使用真实 Claude，请 export ANTHROPIC_API_KEY=xxx。\n\n'
        )
        chosenProvider = createProviderMockPlugin({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
      }
    }
    providerPlugins.push(chosenProvider)
    providerPlugins.push(toolsBuiltinPlugin)
    if (this.options.extraPlugins?.length) providerPlugins.push(...this.options.extraPlugins)

    // 创建 Harness
    const home = typeof process !== 'undefined' ? (process.env.HOME ?? homedir()) : '/tmp'
    const harness = await createHarness({
      cwd: this.options.cwd,
      defaultAgentId: this.options.agentId,
      internalPlugins: providerPlugins,
      agents: [this.defaultAgent(), ...(this.options.agents ?? [])],
      // Agent 多级加载：user 全局目录在前，project 项目目录在后（后者覆盖前者）
      agentDirs: [
        { dir: join(home, '.harness', 'agents'), source: 'user' },
        '.harness/agents',
      ],
      // Skill 多级加载：user 全局目录在前，project 项目目录在后（后者覆盖前者）
      skillDirs: [
        { dir: join(home, '.harness', 'skills'), source: 'user' },
        '.harness/skills',
      ],
      permission: perm,
      logger: {
        info: (msg, meta) => this.options.verbose
          ? this.options.stdout?.write?.(`[INFO] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`)
          : undefined,
        warn: (msg, meta) => this.options.stdout?.write?.(`[WARN] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`),
        error: (msg, meta) => this.options.stdout?.write?.(`[ERROR] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`),
        debug: (msg, meta) => this.options.verbose
          ? this.options.stdout?.write?.(`[DEBUG] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`)
          : undefined,
      },
    })
    await harness.start()
    this.harness = harness

    // 会话：恢复 / 新建
    const sm = harness.session
    let session: Session
    const sid = this.options.sessionId
    if (sid) {
      const saved = await this.sessionStore.load(sid)
      if (saved) {
        // 先 create 后回填 messages（SessionManager 接口没有批量 restore，这里创建新 session + 逐行 addMessage）
        session = await sm.create({ title: saved.title, agentId: saved.agentId, cwd: this.options.cwd, meta: saved.meta })
        // 将 session.id 改为 sid（通过直接操作 manager 内部）：这里简单使用默认 ID，但把 messages 写回去
        for (const m of saved.messages) await sm.addMessage(session.id, m)
        // 若用户明确 --session sid，实际文件 id ≠ sid，做个 save 用正确 id
        ;(session as any).id = sid
      } else {
        session = await sm.create({ title: sid, agentId: this.options.agentId, cwd: this.options.cwd })
        ;(session as any).id = sid
      }
    } else {
      session = await sm.create({ agentId: this.options.agentId, cwd: this.options.cwd })
    }
    await this.sessionStore.save(session)

    return { harness, session }
  }

  /** 发送一次用户消息，得到 assistant Message（内部持久化） */
  async send(sessionId: string, text: string): Promise<Message> {
    const h = this.harness
    // 通过 harness.session.prompt 发送，内部会写入消息 + 调用 agent.query
    const assistant = await h.session.prompt(sessionId, text)
    const sess = (await h.session.get(sessionId))!
    await this.sessionStore.save(sess)
    return assistant
  }

  /** 流式发送：逐事件 yield AgentStreamEvent，完成后自动持久化 session */
  async *sendStream(sessionId: string, text: string): AsyncGenerator<import('@harness/core').AgentStreamEvent, void, unknown> {
    const h = this.harness
    const gen = h.session.promptStream(sessionId, text)
    for await (const ev of gen) {
      yield ev
    }
    // 持久化
    const sess = (await h.session.get(sessionId))!
    await this.sessionStore.save(sess)
  }

  /** 关闭 harness */
  async shutdown(): Promise<void> {
    const sess = await this.harness.session.list({ limit: 1 })
    if (sess?.[0]) await this.sessionStore.save(sess[0])
    await this.harness.stop()
  }

  get _harness(): Harness { return this.harness }
}

// ========================================================================
// 5. REPL
// ========================================================================

export interface ReplOptions {
  app: HarnessApp
  harness: Harness
  session: Session
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  stdin?: NodeJS.ReadableStream
  /** 测试注入：返回数组每取一条当作一行 stdin，取完后自动 /exit */
  scriptedStdin?: string[]
  onLine?: (line: string) => Promise<void> | void
}

/** 特殊 REPL 命令（以 / 开头） */
const REPL_COMMANDS = ['/help', '/exit', '/quit', '/sessions', '/new', '/switch', '/save', '/compact']

// ========================================================================
// 5.1 后台任务面板（P1-4 前端事件驱动展示）
// ========================================================================

export interface BackgroundTaskPanelOptions {
  /** Harness 实例（提供 bus） */
  harness: Harness
  /** 输出流（默认 process.stdout） */
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  /** 仅展示这些父 session 派发的任务；不传则展示所有 */
  parentSessionIds?: string[]
}

/**
 * 挂载后台任务面板（P1-4 前端事件驱动展示）。
 *
 * 订阅 subagent.started / completed / failed Bus 事件，任务状态变化时
 * 增量打印到 stdout（⏳ 开始 / ✅ 完成 / ❌ 失败 + 结果预览），
 * 用户无需执行 /tasks、无需大模型主动查询。
 *
 * UI 无关：本函数只做"事件 → 文本行"的渲染，底层状态由
 * @harness/subagent 的 BackgroundTaskMonitor 维护。
 *
 * @returns 卸载函数（取消订阅 + 释放 monitor）
 */
export function attachBackgroundTaskPanel(options: BackgroundTaskPanelOptions): () => void {
  const { harness } = options
  if (!harness.bus) return () => {}
  const out = (s: string) => (options.stdout ?? process.stdout).write(s)

  const monitor = new BackgroundTaskMonitor({
    bus: harness.bus,
    parentSessionIds: options.parentSessionIds,
  })
  /** taskId → 已打印的状态（增量渲染，同一状态只打印一次） */
  const printed = new Map<string, BackgroundTaskView['status']>()

  const off = monitor.subscribe((tasks) => {
    for (const t of tasks) {
      if (printed.get(t.taskId) === t.status) continue
      printed.set(t.taskId, t.status)
      if (t.status === 'running') {
        out(`⏳  [后台任务] ${t.taskId} 开始：${t.agentName}${t.description ? `（${t.description}）` : ''}\n`)
      } else if (t.status === 'completed') {
        out(`✅  [后台任务] ${t.taskId} 完成：${t.agentName}（${t.durationMs ?? '?'}ms）\n`)
        if (t.result) {
          out(`     ↳ ${t.result.length > 140 ? t.result.slice(0, 140) + '…' : t.result}\n`)
        }
      } else if (t.status === 'failed') {
        out(`❌  [后台任务] ${t.taskId} 失败：${t.agentName} — ${t.error?.message ?? '未知错误'}\n`)
      }
    }
  })

  return () => { off(); monitor.dispose() }
}

/**
 * 启动交互式 REPL。
 *
 * - 用户输入文本 → HarnessApp.send()
 * - 显示 assistant 文本 + 每个 tool call（执行前→执行后）
 * - /exit、/quit 退出；/sessions 列出持久化会话；/new 清空当前会话；/save 手动保存
 * - 支持 scriptedStdin（测试用，或流水线一次性脚本）
 * - 自动挂载后台任务面板：subagent 后台任务开始/完成/失败时实时打印（P1-4）
 *
 * @returns 退出原因：'exit' / 'eof' / 'scripted-done'
 */
export async function startRepl(options: ReplOptions): Promise<'exit' | 'eof' | 'scripted-done'> {
  // P1-4：挂载后台任务面板（事件驱动自动展示，无需 /tasks）
  const detachPanel = attachBackgroundTaskPanel({
    harness: options.harness,
    stdout: options.stdout,
  })
  try {
    return await startReplCore(options)
  } finally {
    detachPanel()
  }
}

/** startRepl 内部实现（由 startRepl wrapper 挂载任务面板后调用） */
async function startReplCore(options: ReplOptions): Promise<'exit' | 'eof' | 'scripted-done'> {
  const { app, harness, session } = options
  const out = (s: string) => (options.stdout ?? process.stdout).write(s)

  out(`Harness CLI (session=${session.id}, agent=${session.agentId ?? 'default'})\n`)
  out(`输入问题开始对话；输入 /help 查看特殊命令；/exit 退出。\n\n`)

  let idx = 0
  const scripted = options.scriptedStdin ? [...options.scriptedStdin] : null

  const processLine = async (raw: string): Promise<'continue' | 'exit'> => {
    const line = raw.trim()
    if (!line) return 'continue'

    // 特殊命令
    if (line.startsWith('/')) {
      const [cmd, arg] = line.split(/\s+/, 2)
      switch (cmd) {
        case '/help':
          out('命令列表：\n')
          out('  /help              显示帮助\n')
          out('  /exit, /quit       退出 REPL\n')
          out('  /sessions          列出持久化会话\n')
          out('  /new               新建会话（保留当前历史到磁盘）\n')
          out('  /save              手动保存当前会话\n')
          out('  /switch <agentId>  切换默认 Agent（下一条 send 生效）\n')
          out('  /switch ?          列出已注册 Agent\n')
          out('  /compact [mode]    立即压缩会话：mode=prune/summary(默认)/agent\n')
          out('  /compact auto      达到阈值才压缩（默认 80% 可用窗口才触发）\n')
          out('  /search <keyword>  关键词搜索会话（匹配消息文本）\n')
          out('  /export [sessionId]  导出会话为 Markdown（默认当前会话）\n')
          // 收集插件注册的命令
          try {
            const cmdInput = { commands: [] as Array<{ command: string; description: string; usage?: string }> }
            await harness.plugin.trigger('cli.commands', cmdInput)
            for (const c of cmdInput.commands) {
              out(`  /${c.command.padEnd(16)}${c.description}\n`)
            }
          } catch { /* 忽略插件 hook 错误 */ }
          return 'continue'

        case '/exit': case '/quit':
          return 'exit'

        case '/sessions': {
          const list = await app.sessionStore.list()
          if (list.length === 0) { out('（无持久化会话）\n'); return 'continue' }
          for (const s of list) {
            const when = new Date(s.updatedAt).toLocaleString()
            out(`  ${s.id}  ${s.title ?? '(untitled)'}  ${s.messageCount} msgs  ${when}\n`)
          }
          return 'continue'
        }
        case '/save': {
          const s = (await harness.session.get(session.id))!
          await app.sessionStore.save(s)
          out(`已保存会话 ${session.id}\n`)
          return 'continue'
        }
        case '/new': {
          const cur = (await harness.session.get(session.id))!
          await app.sessionStore.save(cur)
          const next = await harness.session.create({ agentId: session.agentId })
          // 更新 REPL 绑定：重新赋值
          ;(options as any).session = next
          out(`已新建会话 ${next.id}\n`)
          return 'continue'
        }
        case '/switch': {
          if (!arg || arg === '?') {
            out('已注册 Agent：\n')
            for (const a of harness.agent.list()) out(`  ${a.id}  -  ${a.name}\n`)
            return 'continue'
          }
          const exists = harness.agent.get(arg)
          if (!exists) { out(`Agent "${arg}" 未注册。\n`); return 'continue' }
          const cur = (await harness.session.get(session.id))!
          cur.agentId = arg
          out(`已切换到 Agent ${arg}（影响下次 send）\n`)
          return 'continue'
        }
        case '/compact': {
          const curSessionId = (options as any).session.id as string
          if (arg === 'auto' || arg === 'ifneeded') {
            const did = await harness.session.compactIfNeeded(curSessionId)
            const info = await harness.session.getCompactionInfo(curSessionId)
            if (did) out(`已触发压缩（阈值命中）：策略=${info.meta?.lastStrategy}，前=${info.meta?.lastMessagesBefore} 后=${info.meta?.lastMessagesAfter}\n`)
            else {
              const est = await harness.session.estimateTokens(curSessionId)
              out(`未达阈值（估算 ${est} tokens），跳过压缩。\n`)
            }
          } else {
            const strategy = (arg === 'prune' || arg === 'summary' || arg === 'agent') ? arg : 'summary'
            await harness.session.compact(curSessionId, strategy)
            const info = await harness.session.getCompactionInfo(curSessionId)
            out(`已压缩会话（策略=${strategy}）：`)
            out(`累计压缩次数=${info.meta?.count ?? 0}，累计压缩消息=${info.meta?.totalPrunedMessages ?? 0}\n`)
            out(`本轮：前=${info.meta?.lastMessagesBefore} 后=${info.meta?.lastMessagesAfter}；摘要轮次=${info.memory?.round ?? 0}\n`)
            if (info.memory?.summaryText) out(`摘要（前 400 字）：${info.memory.summaryText.slice(0, 400)}\n`)
          }
          return 'continue'
        }
        case '/search': {
          if (!arg || !arg.trim()) { out('用法：/search <keyword>\n'); return 'continue' }
          const results = await harness.session.search(arg.trim())
          if (results.length === 0) { out('（无匹配会话）\n'); return 'continue' }
          for (const s of results) {
            const when = new Date(s.updatedAt).toLocaleString()
            out(`  ${s.id}  ${s.title ?? '(untitled)'}  ${s.messages.length} msgs  ${when}\n`)
          }
          return 'continue'
        }
        case '/export': {
          const exportSid = arg?.trim() || (options as any).session.id
          const md = await harness.session.exportMarkdown(exportSid)
          if (!md) { out(`会话 ${exportSid} 不存在或为空\n`); return 'continue' }
          out(md)
          out('\n')
          return 'continue'
        }
        default: {
          // 尝试交给插件处理
          const cmdInput: { raw: string; command: string; arg: string; out: (s: string) => void; sessionId: string; result?: 'continue' | 'exit' } = {
            raw: line.slice(1),
            command: cmd.slice(1),
            arg: (arg ?? '').trim(),
            out,
            sessionId: (options as any).session.id,
          }
          try {
            await harness.plugin.trigger('cli.command', cmdInput)
          } catch { /* 忽略插件 hook 错误 */ }
          if (cmdInput.result === 'exit') return 'exit'
          if (cmdInput.result === 'continue') return 'continue'
          out(`未知命令：${line}，输入 /help 查看。\n`)
          return 'continue'
        }
      }
    }

    // 正常发送（流式）
    await options.onLine?.(line)
    out(`\n🧑  ${line}\n`)
    const started = Date.now()
    let assistant: Message | undefined
    try {
      const curSessionId = (options as any).session.id
      const gen = app.sendStream(curSessionId, line)
      let inReasoning = false
      let inText = false
      let inToolOutput = false
      for await (const ev of gen) {
        switch (ev.type) {
          case 'reasoning_delta':
            if (!inReasoning) { out('💭  '); inReasoning = true }
            out(ev.text ?? '')
            break
          case 'text_delta':
            if (!inText) { if (inReasoning) out('\n'); out('🤖  '); inText = true }
            out(ev.text ?? '')
            break
          case 'tool_call_start':
            if (inText || inReasoning) { out('\n'); inText = false; inReasoning = false }
            out(`🔧  ${ev.toolId} ${JSON.stringify(ev.input).slice(0, 60)}...\n`)
            break
          case 'tool_call_result': {
            const status = ev.isError ? '❌' : '✅'
            const preview = typeof ev.result === 'string'
              ? ev.result.slice(0, 120)
              : JSON.stringify(ev.result ?? '').slice(0, 120)
            out(`${status}  → ${preview}\n`)
            break
          }
          case 'done':
            assistant = ev.message
            break
        }
      }
      if (inText || inReasoning) out('\n') // 换行收尾
    } catch (err: any) {
      out(`\n❌  发送失败：${err?.message ?? String(err)}\n`)
      return 'continue'
    }
    const duration = Date.now() - started
    out(`⏱️  ${duration}ms | agent=${assistant?.agentId ?? session.agentId ?? '?'}` +
      (assistant?.meta?.model ? ` | model=${assistant.meta.model}` : '') + '\n\n')
    return 'continue'
  }

  if (scripted) {
    for (const line of scripted) {
      idx++
      const res = await processLine(line)
      if (res === 'exit') return 'exit'
    }
    // 脚本结束后顺手 /save
    const cur = (await harness.session.get((options as any).session.id))
    if (cur) await app.sessionStore.save(cur)
    return 'scripted-done'
  }

  // 使用 readline 交互
  return new Promise((resolve) => {
    const rl = createInterface({
      input: options.stdin ?? process.stdin,
      output: options.stdout ?? process.stdout as any,
      prompt: '❯ ',
    })
    rl.prompt()
    rl.on('line', async (line) => {
      const r = await processLine(line)
      if (r === 'exit') { rl.close(); resolve('exit') }
      else rl.prompt()
    })
    rl.on('close', () => resolve('eof'))
  })
}

// ========================================================================
// 6. help 文本
// ========================================================================

export const HELP_TEXT = `harness — Agent Harness CLI

用法:
  harness [repl|start] [options]        启动交互式 REPL（默认）
  harness list-sessions [options]       列出持久化会话
  harness resume <sessionId> [opt]      恢复指定会话进入 REPL
  harness run "<prompt>" [opt]          一次性执行 prompt，输出结果后退出
  harness help | -h | --help            显示帮助

选项:
  -c, --cwd <dir>            工作目录（默认当前目录）
  -a, --agent <id>           默认 Agent ID（默认 default）
  -p, --provider <name>      mock / anthropic（默认 anthropic，无 key 时自动 fallback mock）
  -s, --session <id>         指定会话 ID（用于 resume/run 时复用历史）
  -d, --data-dir <dir>       持久化目录（默认 ~/.harness）
      --permission <mode>    allow-all / ask（默认 ask）
  -v, --verbose              输出调试信息
`

// ========================================================================
// 7. 顶层 main()：处理脚本入口
// ========================================================================

export async function main(rawArgs: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(rawArgs)
  const stdout: { write: (s: string) => void } = process.stdout
  const write = (s: string) => stdout.write(s)

  if (args.command === 'help' || args.showHelp) { write(HELP_TEXT); return 0 }

  const cwd = args.cwd ?? process.cwd()
  const agentId = args.agentId ?? 'default'
  const provider = args.provider ?? 'anthropic'
  const home = typeof process !== 'undefined' ? (process.env.HOME ?? homedir()) : '/tmp'
  const dataDir = args.dataDir ?? join(home, '.harness')
  const permissionMode = args.permissionMode ?? 'ask'

  if (args.command === 'list-sessions') {
    const store = new SessionFileStore(dataDir)
    const list = await store.list()
    if (list.length === 0) { write('（无持久化会话）\n'); return 0 }
    for (const s of list) {
      const when = new Date(s.updatedAt).toLocaleString()
      write(`${s.id}\t${s.title ?? ''}\t${s.messageCount} msgs\t${when}\n`)
    }
    return 0
  }

  const app = new HarnessApp({
    cwd, dataDir, agentId, provider,
    sessionId: args.command === 'resume' ? args.arg ?? args.sessionId : args.sessionId,
    permissionMode, verbose: args.verbose,
  })
  const { harness, session } = await app.boot()

  try {
    if (args.command === 'run') {
      const prompt = args.arg ?? ''
      if (!prompt) { write('用法: harness run "<prompt>"\n'); return 1 }
      // 流式输出（逐 token 打印到 stdout，脚本友好）
      const gen = app.sendStream(session.id, prompt)
      for await (const ev of gen) {
        if (ev.type === 'text_delta') write(ev.text ?? '')
        else if (ev.type === 'done') {
          if (ev.message) {
            // 换行收尾
            const textParts = ev.message.parts.filter((p: any) => p.type === 'text')
            if (textParts.length > 0) write('\n')
          }
        }
      }
      return 0
    }

    // repl / resume / start → REPL
    {
      const did = await harness.session.compactIfNeeded(session.id)
      if (did) {
        const info = await harness.session.getCompactionInfo(session.id)
        write(`[会话] 自动压缩：策略=${info.meta?.lastStrategy}，前=${info.meta?.lastMessagesBefore} 后=${info.meta?.lastMessagesAfter}\n`)
      }
    }
    await startRepl({ app, harness, session })
    return 0
  } finally {
    try { await app.shutdown() } catch {}
  }
}

// ========================================================================
// 8. 作为脚本直接执行
// ========================================================================

// 仅当该文件是 CLI 入口时运行 main。
// Bun 的 import.meta.main 语义与 ESM 一致。
// 这里用 typeof Bun !== undefined + require.main 等价策略。
if (typeof process !== 'undefined' && typeof Bun !== 'undefined') {
  const isEntry = (Bun as any)?.main === import.meta.path || (process as any)?.mainModule?.filename === (import.meta as any).filename
  if (isEntry) {
    main()
      .then((code) => { if (typeof process !== 'undefined') process.exit(code) })
      .catch((err) => {
        process.stderr.write('Fatal: ' + (err?.message ?? String(err)) + '\n')
        process.exit(1)
      })
  }
}
