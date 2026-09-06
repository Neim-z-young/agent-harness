import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuthTokenStore, oauthServerKey } from './token-store'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'oauth-store-'))
}

describe('OAuthTokenStore', () => {
  test('save/load 加解密 roundtrip,落盘为 enc:v1: 密文不含明文', async () => {
    const dir = tmpDir()
    try {
      const store = new OAuthTokenStore(dir)
      const key = oauthServerKey('https://mcp.example.com/mcp')
      const token = { access_token: 'at-secret', refresh_token: 'rt-secret', expires_in: 3600, scope: 'a b' }
      await store.save(key, token)
      expect(await store.hasStored(key)).toBe(true)
      expect(await store.load(key)).toEqual(token)
      const raw = readFileSync(join(dir, 'oauth-tokens.json'), 'utf-8')
      expect(raw).toContain('enc:v1:')
      expect(raw).not.toContain('at-secret')
      expect(raw).not.toContain('rt-secret')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('不存在的 serverKey 返回 undefined,hasStored false', async () => {
    const dir = tmpDir()
    try {
      const store = new OAuthTokenStore(dir)
      expect(await store.load('missing')).toBeUndefined()
      expect(await store.hasStored('missing')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('clear 移除条目(幂等)', async () => {
    const dir = tmpDir()
    try {
      const store = new OAuthTokenStore(dir)
      const key = oauthServerKey('https://x/mcp')
      await store.save(key, { access_token: 't' })
      await store.clear(key)
      expect(await store.hasStored(key)).toBe(false)
      expect(await store.load(key)).toBeUndefined()
      await store.clear(key) // 幂等不抛
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('篡改密文后 load 抛错(校验 tag)', async () => {
    const dir = tmpDir()
    try {
      const store = new OAuthTokenStore(dir)
      const key = oauthServerKey('https://x/mcp')
      await store.save(key, { access_token: 't' })
      const p = join(dir, 'oauth-tokens.json')
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      raw[key].enc = 'enc:v1:AAAAAAAA:AAAAAAAA:AAAAAAAA'
      writeFileSync(p, JSON.stringify(raw))
      await expect(store.load(key)).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})