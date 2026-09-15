/**
 * @harness/workspace —— 存储类工厂（消费工作区解析路径，消灭 magic path）
 *
 * 从 cli 抽离的会话 / 配置 / 密钥三种存储，改为直接消费 `Workspace` 解析出的路径
 * （`ws.files.*`），不再在类内 `join(dataDir, 'xxx')` 硬编码相对路径。
 * 仅做「定位 + 读写」，不含业务装配逻辑。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Message, Session } from '@harness/session'
import type { Workspace } from './index'
import { SessionCompactionStore } from './compaction-store'

/** 配置校验 / 密钥解析等一次性启动失败 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

/** 会话存储结构（文件 = sessionId.json） */
export interface SessionFile {
  id: string
  title?: string
  createdAt: number
  updatedAt: number
  agentId?: string
  cwd?: string
  /** 父会话 ID（子 Agent 派生时关联）；Session 有该字段，落盘时同步保存，否则恢复后链路断掉 */
  parentId?: string
  meta?: Record<string, unknown>
  /** 已压缩摘要块（上下文压缩·阶段二 Route B；原文在盘 .cmp.orig 由 loader 还原） */
  blocks?: Session['blocks']
  /** 完整消息列表（未压缩时为全量；压缩后为「近期」消息） */
  messages: Message[]
}

/** 会话文件存储：dataDir/sessions/{sessionId}.json */
export class SessionFileStore {
  constructor(public readonly workspace: Workspace) {}

  private sessionsDir(): string {
    return this.workspace.files.sessions
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
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      agentId: s.agentId,
      cwd: s.cwd,
      parentId: s.parentId,
      meta: s.meta,
      blocks: s.blocks,
      messages: s.messages,
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

  /**
   * 列出所有会话（按 updatedAt 倒序）。
   * 附带 `cwd` / `agentId` / `title`：`harness` 启动时的「自动恢复上次会话」需要按
   * 工作目录筛选（磁盘里可能同时躺着好几个项目的会话），这里顺手带出，避免调用方
   * 为了筛目录把每个会话文件再读一遍。
   */
  async list(): Promise<Array<{ id: string; title?: string; updatedAt: number; messageCount: number; cwd?: string; agentId?: string }>> {
    if (!existsSync(this.sessionsDir())) return []
    const files = await readdir(this.sessionsDir())
    const ids = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    const items: Array<{ id: string; title?: string; updatedAt: number; messageCount: number; cwd?: string; agentId?: string }> = []
    // 压缩后 sessions/{id}.json 只存近期消息，原文归档在 .cmp.orig；计数需合并以反映全量
    const compaction = new SessionCompactionStore(this.workspace)
    for (const id of ids) {
      const s = await this.load(id)
      if (s) {
        const archived = await compaction.countOriginals(id).catch(() => 0)
        items.push({
          id,
          title: s.title,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length + archived,
          cwd: s.cwd,
          agentId: s.agentId,
        })
      }
    }
    // updatedAt 是毫秒精度，同毫秒的两条会话若只按时间排，顺序会取决于 readdir 的返回顺序
    // （不同文件系统不同）—— 而「启动时恢复最近会话」依赖这个顺序，必须是确定的。
    // 因此同时间戳再按 id 兜底排序，保证同一个目录快照两次列出结果一致。
    items.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return items
  }
}

/** 项目级「上次会话」指针文件名（位于 `<cwd>/.harness/` 下） */
export const LAST_SESSION_FILE = 'last-session.json'

/**
 * 确保 `dir/.gitignore` 含有一行 `entry`（目录/文件不存在则建，已含则不动）。
 *
 * 用途：把 harness 自己生成的状态文件挡在用户仓库之外。生成物一旦被 `git add -A`
 * 收进暂存区就很难清（worktree 目录会记成 gitlink，得 `git worktree remove`），
 * 所以**写状态文件前先落忽略规则**，别指望调用方记得。
 *
 * 注：subagent 插件的 `ensureWorktreeIgnored()` 是同一套逻辑的副本——那个包没有
 * 依赖本包，故未合并；两处若要改行为需一起改。
 */
export async function ensureGitignoreEntry(dir: string, entry: string): Promise<void> {
  const ignoreFile = join(dir, '.gitignore')
  let content = ''
  if (existsSync(ignoreFile)) {
    try { content = await readFile(ignoreFile, 'utf-8') } catch { content = '' }
  }
  if (content.split('\n').some((l) => l.trim() === entry)) return
  await mkdir(dir, { recursive: true })
  const next = content.trimEnd() ? `${content.trimEnd()}\n${entry}\n` : `${entry}\n`
  await writeFile(ignoreFile, next)
}

/** `<cwd>/.harness/last-session.json` 的结构 */
export interface SessionPointerFile {
  /** 该工作目录下次启动应恢复的会话 id（对应 dataDir/sessions/{id}.json） */
  sessionId: string
  /** 写入时刻（仅便于人工查看；判定不依赖它） */
  savedAt: number
}

/**
 * 项目级「上次会话」指针：`<cwd>/.harness/last-session.json`
 *
 * 为什么写在**工作目录**而不是 dataDir：dataDir（缺省 ~/.harness）是所有项目共用的，
 * 所有项目的会话文件都躺在同一层，启动时只能拿「会话里记的 cwd 字符串」反查该恢复哪一条。
 * 字符串比对天生脆弱——符号链接（macOS 的 /tmp → /private/tmp）、相对路径、大小写、
 * 末尾斜杠任一有差异就会误判：轻则该恢复的没恢复，重则**在 A 目录里恢复出 B 目录的会话**。
 *
 * 把记录写进工作目录本身，「谁属于谁」由文件位置决定，天生按目录隔离：
 * 不同工作目录各自一份指针，互不干扰，也不需要对 cwd 做任何字符串规范化。
 */
export class SessionPointerStore {
  constructor(public readonly workspace: Workspace) {}

  /** 指针文件路径：`<cwd>/.harness/last-session.json` */
  path(): string {
    return join(this.workspace.project.root, LAST_SESSION_FILE)
  }

  /** 读指针；文件缺失 / 解析失败 / sessionId 为空都按「没有记录」返回 undefined（调用方退回兜底判定） */
  async read(): Promise<SessionPointerFile | undefined> {
    const p = this.path()
    if (!existsSync(p)) return undefined
    try {
      const raw = JSON.parse(await readFile(p, 'utf-8')) as Partial<SessionPointerFile>
      const id = typeof raw?.sessionId === 'string' ? raw.sessionId.trim() : ''
      if (!id) return undefined
      return { sessionId: id, savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0 }
    } catch {
      return undefined
    }
  }

  /** 写入指针（顺手把文件加进 `<cwd>/.harness/.gitignore`，避免污染用户仓库） */
  async write(sessionId: string): Promise<void> {
    const id = sessionId.trim()
    if (!id) return
    await ensureGitignoreEntry(this.workspace.project.root, LAST_SESSION_FILE)
    await writeFile(this.path(), JSON.stringify({ sessionId: id, savedAt: Date.now() }, null, 2) + '\n')
  }

  /** 清除指针（会话被删等场景） */
  async clear(): Promise<void> {
    const p = this.path()
    if (existsSync(p)) await rm(p, { force: true })
  }
}

/** dataDir/config.json 读写（泛型 T，幂等：文件缺失 / 解析失败均返回空对象） */
export class ConfigStore<T extends object = Record<string, unknown>> {
  constructor(public readonly workspace: Workspace) {}

  private path(): string {
    return this.workspace.files.config
  }

  async load(): Promise<T> {
    const p = this.path()
    if (!existsSync(p)) return {} as T
    try {
      return JSON.parse(await readFile(p, 'utf-8')) as T
    } catch {
      return {} as T
    }
  }

  async save(cfg: T): Promise<void> {
    const p = this.path()
    await mkdir(this.workspace.dataDir, { recursive: true })
    await writeFile(p, JSON.stringify(cfg, null, 2))
  }
}

/**
 * API Key 加密（AES-256-GCM）。主密钥来源（优先级从高到低）：
 * 1. HARNESS_CONFIG_KEY 环境变量（sha256 派生 32 字节）
 * 2. <data-dir>/.config-key 文件（首次自动生成 64 位 hex，chmod 600）
 */
export class SecretCipher {
  constructor(public readonly workspace: Workspace) {}

  private keyFile(): string {
    return this.workspace.files.secretKey
  }

  async masterKey(): Promise<Buffer> {
    const env = typeof process !== 'undefined' ? process.env.HARNESS_CONFIG_KEY : undefined
    if (env && env.length >= 8) return createHash('sha256').update(env).digest()
    const p = this.keyFile()
    if (existsSync(p)) return Buffer.from((await readFile(p, 'utf-8')).trim(), 'hex')
    const key = randomBytes(32).toString('hex')
    await mkdir(this.workspace.dataDir, { recursive: true })
    await writeFile(p, key, { mode: 0o600 })
    return Buffer.from(key, 'hex')
  }

  /** 加密为 `enc:v1:<iv>:<tag>:<ct>`（base64） */
  async encrypt(plain: string): Promise<string> {
    const key = await this.masterKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
  }

  /** 解密 enc:v1 值；非 enc: 前缀原样返回 */
  async decrypt(token: string): Promise<string> {
    if (!token.startsWith('enc:v1:')) return token
    const parts = token.split(':')
    const ivB64 = parts[2]
    const tagB64 = parts[3]
    const ctB64 = parts.slice(4).join(':')
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new ConfigValidationError(`无效的加密密钥格式：${token.slice(0, 24)}…`)
    }
    try {
      const key = await this.masterKey()
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf-8')
    } catch (err: any) {
      throw new ConfigValidationError(
        `加密密钥解密失败（HARNESS_CONFIG_KEY / .config-key 与写入时不一致？）：${err?.message ?? String(err)}`,
      )
    }
  }
}

/**
 * apiKey 值解析：
 * - `${ENV_VAR}` → 环境变量（未设置时抛 ConfigValidationError）
 * - `enc:v1:...` → SecretCipher 解密
 * - 其他 → 原样明文返回
 */
export async function resolveSecret(
  value: string | undefined,
  cipher: SecretCipher,
): Promise<string | undefined> {
  if (!value) return undefined
  const trimmed = value.trim()
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed)
  if (m) {
    const v = typeof process !== 'undefined' ? process.env[m[1]] : undefined
    if (v === undefined) {
      throw new ConfigValidationError(`环境变量 ${m[1]} 未设置（apiKey 引用了它）`)
    }
    return v
  }
  if (trimmed.startsWith('enc:v1:')) return cipher.decrypt(trimmed)
  return value
}