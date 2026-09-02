/**
 * @harness/workspace —— 存储类工厂（消费工作区解析路径，消灭 magic path）
 *
 * 从 cli 抽离的会话 / 配置 / 密钥三种存储，改为直接消费 `Workspace` 解析出的路径
 * （`ws.files.*`），不再在类内 `join(dataDir, 'xxx')` 硬编码相对路径。
 * 仅做「定位 + 读写」，不含业务装配逻辑。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Message, Session } from '@harness/session'
import type { Workspace } from './index'

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
  meta?: Record<string, unknown>
  /** 完整消息列表 */
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
      meta: s.meta,
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