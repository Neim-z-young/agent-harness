/**
 * OAuth token 加密持久化存储
 *
 * 复用 `@harness/workspace` 的 SecretCipher(AES-256-GCM,主密钥优先级
 * env HARNESS_CONFIG_KEY > dataDir/.config-key)把每个 server 的 token 加密落盘到
 * `dataDir/oauth-tokens.json`,一行一个 server。解密失败(密钥不一致/篡改)抛错,
 * 由 OAuthFlow 捕获后回落交互重授权。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveWorkspace, SecretCipher } from '@harness/workspace'
import type { McpToken } from './oauth'

/** 由 baseUrl 派生的稳定 serverKey(sha256 → base64url,不可逆) */
export function oauthServerKey(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('base64url')
}

interface OAuthStoreFile {
  [serverKey: string]: { enc: string }
}

export class OAuthTokenStore {
  private readonly dataDir: string
  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  private file(): string {
    return join(this.dataDir, 'oauth-tokens.json')
  }

  private async cipher(): Promise<SecretCipher> {
    return new SecretCipher(resolveWorkspace({ dataDir: this.dataDir }))
  }

  private async readAll(): Promise<OAuthStoreFile> {
    const p = this.file()
    if (!existsSync(p)) return {}
    try {
      return JSON.parse(await readFile(p, 'utf-8')) as OAuthStoreFile
    } catch {
      return {}
    }
  }

  private async writeAll(all: OAuthStoreFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.file(), JSON.stringify(all, null, 2), { mode: 0o600 })
  }

  /** 读取解密后的 token;不存在返回 undefined */
  async load(serverKey: string): Promise<McpToken | undefined> {
    const enc = (await this.readAll())[serverKey]?.enc
    if (!enc) return undefined
    const plain = await (await this.cipher()).decrypt(enc)
    return JSON.parse(plain) as McpToken
  }

  /** 加密持久化(存在则覆盖) */
  async save(serverKey: string, token: McpToken): Promise<void> {
    const all = await this.readAll()
    const cipher = await this.cipher()
    all[serverKey] = { enc: await cipher.encrypt(JSON.stringify(token)) }
    await this.writeAll(all)
  }

  /** 删除某 server 的 token(幂等) */
  async clear(serverKey: string): Promise<void> {
    const all = await this.readAll()
    if (!(serverKey in all)) return
    delete all[serverKey]
    await this.writeAll(all)
  }

  /** 是否已有持久化 token */
  async hasStored(serverKey: string): Promise<boolean> {
    return (await this.readAll())[serverKey]?.enc != null
  }
}