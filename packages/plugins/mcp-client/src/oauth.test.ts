import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAuthorizationUrl,
  createPkceChallenge,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  generatePkce,
  OAuthFlow,
  refreshOAuthToken,
  type McpToken,
} from './oauth'
import { OAuthTokenStore, oauthServerKey } from './token-store'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'oauth-flow-'))
}

interface Call {
  url: string
  init?: RequestInit
}
/** 路由式 fetch stub;未命中路由返回 404 */
function makeFetchMock(routes: Record<string, (url: string, init?: RequestInit) => any>): {
  fn: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : (url as URL).toString()
    calls.push({ url: u, init })
    const handler = routes[u]
    if (!handler) {
      return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as Response
    }
    return handler(u, init) as Response
  }) as typeof fetch
  return { fn, calls }
}

describe('PKCE', () => {
  test('createPkceChallenge 确定性 + 定长 43 无 padding', () => {
    const c1 = createPkceChallenge('some-verifier')
    const c2 = createPkceChallenge('some-verifier')
    expect(c1).toBe(c2)
    expect(c1).toHaveLength(43)
    expect(c1).not.toMatch(/[+/=]/)
  })
  test('generatePkce 每次不同,challenge 与 verifier 一致', () => {
    const a = generatePkce()
    const b = generatePkce()
    expect(a.challenge).toBe(createPkceChallenge(a.verifier))
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
    expect(a.verifier).toHaveLength(43)
  })
})

describe('discovery', () => {
  test('解析 well-known 元数据', async () => {
    const { fn } = makeFetchMock({
      'https://s/.well-known/oauth-authorization-server': () => ({
        ok: true,
        status: 200,
        json: async () => ({
          authorization_endpoint: 'https://s/authorize',
          token_endpoint: 'https://s/token',
          scopes_supported: ['tools.read'],
        }),
      }),
    })
    const meta = await discoverOAuthMetadata('https://s/mcp', fn)
    expect(meta.authorization_endpoint).toBe('https://s/authorize')
    expect(meta.token_endpoint).toBe('https://s/token')
    expect(meta.scopes_supported).toEqual(['tools.read'])
  })
  test('缺端点元数据抛错', async () => {
    const { fn } = makeFetchMock({
      'https://s/.well-known/oauth-authorization-server': () => ({
        ok: true,
        status: 200,
        json: async () => ({}) as any,
      }),
    })
    await expect(discoverOAuthMetadata('https://s/mcp', fn)).rejects.toThrow(/缺少/)
  })
  test('HTTP 非 2xx 抛错', async () => {
    const { fn } = makeFetchMock({})
    await expect(discoverOAuthMetadata('https://s/mcp', fn)).rejects.toThrow(/discovery 失败/)
  })
})

describe('exchange / refresh', () => {
  const TOKEN = 'https://auth/token'
  test('exchange:POST form 含 grant_type/code_verifier/redirect_uri', async () => {
    let body = ''
    const { fn } = makeFetchMock({
      [TOKEN]: (_u, init) => {
        body = String(init?.body)
        return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) }
      },
    })
    const tok = await exchangeAuthorizationCode({
      tokenEndpoint: TOKEN,
      clientId: 'cid',
      code: 'AUTH',
      codeVerifier: 'verifier-value',
      redirectUri: 'http://localhost',
      fetchImpl: fn,
    })
    expect(tok.access_token).toBe('at')
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code=AUTH')
    expect(body).toContain('code_verifier=verifier-value')
    expect(body).toContain('client_id=cid')
    expect(body).toContain('redirect_uri=http%3A%2F%2Flocalhost')
  })
  test('refresh:grant_type=refresh_token', async () => {
    let body = ''
    const { fn } = makeFetchMock({
      [TOKEN]: (_u, init) => {
        body = String(init?.body)
        return { ok: true, status: 200, json: async () => ({ access_token: 'new-at', expires_in: 7200 }) }
      },
    })
    const tok = await refreshOAuthToken({ tokenEndpoint: TOKEN, refreshToken: 'rt-1', fetchImpl: fn })
    expect(tok.access_token).toBe('new-at')
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=rt-1')
  })
})

describe('buildAuthorizationUrl', () => {
  test('含 PKCE 参数与 scope', () => {
    const url = buildAuthorizationUrl(
      'https://auth/authorize',
      { clientId: 'cid', scopes: ['a', 'b'] },
      'CHALLENGE',
      'http://localhost',
      'state-1',
    )
    expect(url).toContain('response_type=code')
    expect(url).toContain('code_challenge=CHALLENGE')
    expect(url).toContain('code_challenge_method=S256')
    expect(url).toContain('client_id=cid')
    expect(url).toContain('scope=a+b')
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost')
  })
})

describe('OAuthFlow 编排', () => {
  const DISCOVERY = 'https://mcp.example.com/.well-known/oauth-authorization-server'
  const TOKEN = 'https://auth.example.com/token'

  test('discovery + 授权码换 token + 持久化 + 缓存命中不发网络', async () => {
    const dir = tmpDir()
    try {
      let tokenExchange = 0
      const routes: Record<string, (url: string, init?: RequestInit) => any> = {
        [DISCOVERY]: () => ({
          ok: true,
          status: 200,
          json: async () => ({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: TOKEN,
          }),
        }),
        [TOKEN]: (_u: string, init?: RequestInit) => {
          tokenExchange++
          const body = String(init?.body)
          expect(body).toContain('grant_type=authorization_code')
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'access1', refresh_token: 'r1', expires_in: 3600 }),
          }
        },
      }
      const { fn, calls } = makeFetchMock(routes)
      const store = new OAuthTokenStore(dir)
      const key = oauthServerKey('https://mcp.example.com/mcp')
      const flow = new OAuthFlow({
        serverKey: key,
        baseUrl: 'https://mcp.example.com/mcp',
        oauth: { discoveryUrl: 'https://mcp.example.com/' },
        store,
        fetchImpl: fn,
        readCode: async () => 'https://cb.example.com/?code=AUTH',
      })
      const at = await flow.ensureAccessToken()
      expect(at).toBe('access1')
      expect(calls.some((c) => c.url === DISCOVERY)).toBe(true)
      expect(await store.hasStored(key)).toBe(true)
      expect((await store.load(key))?.access_token).toBe('access1')

      // 同一 flow 第二次调用:缓存命中,不再触发 exchange
      await flow.ensureAccessToken()
      expect(tokenExchange).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('磁盘缓存命中:直接返回,不发网络', async () => {
    const dir = tmpDir()
    try {
      const store = new OAuthTokenStore(dir)
      const key = oauthServerKey('https://mcp2/mcp')
      await store.save(key, { access_token: 'from-disk', expires_in: 3600, obtained_at: Date.now() })
      const routes = {
        [DISCOVERY]: () => ({
          ok: true,
          status: 200,
          json: async () => ({ authorization_endpoint: 'https://a', token_endpoint: TOKEN }),
        }),
      }
      const { fn, calls } = makeFetchMock(routes)
      const flow = new OAuthFlow({
        serverKey: key,
        baseUrl: 'https://mcp2/mcp',
        oauth: {},
        store,
        fetchImpl: fn,
      })
      expect(await flow.ensureAccessToken()).toBe('from-disk')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('过期时用 refresh_token 刷新', async () => {
    const dir = tmpDir()
    try {
      const store = new OAuthTokenStore(dir)
      const key = oauthServerKey('https://mcp3/mcp')
      await store.save(key, {
        access_token: 'expired',
        refresh_token: 'r1',
        expires_in: 0,
        obtained_at: Date.now() - 3600_000, // 早已过期
      })
      const routes = {
        [DISCOVERY]: () => ({
          ok: true,
          status: 200,
          json: async () => ({ authorization_endpoint: 'https://a', token_endpoint: TOKEN }),
        }),
        [TOKEN]: (_u: string, init?: RequestInit) => {
          expect(String(init?.body)).toContain('grant_type=refresh_token')
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'refreshed', expires_in: 7200 }),
          }
        },
      }
      const { fn } = makeFetchMock(routes)
      const flow = new OAuthFlow({
        serverKey: key,
        baseUrl: 'https://mcp3/mcp',
        oauth: { discoveryUrl: 'https://mcp.example.com/' },
        store,
        fetchImpl: fn,
      })
      expect(await flow.ensureAccessToken()).toBe('refreshed')
      expect((await store.load(key))?.access_token).toBe('refreshed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('并发 ensureAccessToken 只触发一次授权', async () => {
    const dir = tmpDir()
    try {
      let exchange = 0
      const routes = {
        [DISCOVERY]: () => ({
          ok: true,
          status: 200,
          json: async () => ({ authorization_endpoint: 'https://a', token_endpoint: TOKEN }),
        }),
        [TOKEN]: () => {
          exchange++
          return { ok: true, status: 200, json: async () => ({ access_token: 'c', refresh_token: 'r', expires_in: 3600 }) }
        },
      }
      const { fn } = makeFetchMock(routes)
      let readCount = 0
      const store = new OAuthTokenStore(dir)
      const flow = new OAuthFlow({
        serverKey: 'k',
        baseUrl: 'https://mcp4/mcp',
        oauth: { discoveryUrl: 'https://mcp.example.com/' },
        store,
        fetchImpl: fn,
        readCode: async () => {
          readCount++
          return 'CODE'
        },
      })
      const [a, b] = await Promise.all([flow.ensureAccessToken(), flow.ensureAccessToken()])
      expect(a).toBe('c')
      expect(b).toBe('c')
      expect(exchange).toBe(1)
      expect(readCount).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})