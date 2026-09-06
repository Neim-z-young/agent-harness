/**
 * mcp-client OAuth2 PKCE 授权码流程(纯逻辑 + 交互注入)
 *
 * - 端点来源:优先 well-known 自动发现(`{baseUrl}/.well-known/oauth-authorization-server`,
 *   RFC 8414),或显式配置 tokenEndpoint/authorizationEndpoint 时跳过 discovery。
 * - 授权码:打印授权 URL → 用户在浏览器授权 → 把回调 URL(或其 code 参数)粘贴回 REPL,
 *   不做本地回调服务器。公共客户端用 PKCE (S256),无 client_secret。
 * - token 持久化交给 OAuthTokenStore(加密落盘),本模块负责「缓存 → 刷新 → 交互授权」编排,
 *   对并发首次授权做 pending 去重。
 */

import { createHash, randomBytes } from 'node:crypto'
import type { OAuthTokenStore } from './token-store'

// ===== 类型 =====

/** OAuth 2.0 Authorization Server Metadata(RFC 8414 + MCP well-known 约定) */
export interface McpOauthServerMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  revocation_endpoint?: string
  scopes_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  code_challenge_methods_supported?: string[]
  registration_endpoint?: string
}

/** OAuth 客户端配置(挂在 McpAuthConfig.oauth 下) */
export interface McpOauthConfig {
  /** well-known 发现基址;缺省 = McpServerConfig.url */
  discoveryUrl?: string
  /** 显式 client_id(公共客户端可省略) */
  clientId?: string
  /** 提供后跳过 discovery,直接使用该 token 端点 */
  tokenEndpoint?: string
  /** 提供后跳过 discovery,直接使用该授权端点 */
  authorizationEndpoint?: string
  /** 申请 scope;缺省用 discovery 的 scopes_supported */
  scopes?: string[]
}

/** 一个已获取/待持久化的 token */
export interface McpToken {
  access_token: string
  refresh_token?: string
  token_type?: string
  /** token 端点返回的相对秒数 */
  expires_in?: number
  scope?: string
  /** 本地获取时间戳(ms),用于算绝对过期 */
  obtained_at?: number
}

// ===== PKCE(S256)=====

export interface PkcePair {
  verifier: string
  challenge: string
}

const base64url = (buf: Uint8Array): string =>
  Buffer.from(buf).toString('base64url').replace(/=+$/, '')

/** 生成随机 PKCE code_verifier(S256) */
export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32)) // 43 chars
  return { verifier, challenge: createPkceChallenge(verifier) }
}

/** 由 verifier 计算 code_challenge(base64url(SHA256(verifier))) */
export function createPkceChallenge(verifier: string): string {
  return base64url(new Uint8Array(createHash('sha256').update(verifier).digest()))
}

// ===== 端点发现 =====

/** 从 well-known 发现 OAuth 元数据;若 oauth 显式配置了双端点可跳过 */
export async function discoverOAuthMetadata(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpOauthServerMetadata> {
  const url = new URL('/.well-known/oauth-authorization-server', baseUrl).toString()
  const resp = await fetchImpl(url)
  if (!resp.ok) throw new Error(`OAuth discovery 失败 HTTP ${resp.status}: ${url}`)
  const meta = (await resp.json()) as McpOauthServerMetadata
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`OAuth metadata 缺少 authorization_endpoint/token_endpoint: ${url}`)
  }
  return meta
}

// ===== 授权码换 token / 刷新 =====

export interface TokenExchangeParams {
  tokenEndpoint: string
  clientId?: string
  code: string
  codeVerifier: string
  redirectUri: string
  fetchImpl?: typeof fetch
}

/** 用授权码换取 token(application/x-www-form-urlencoded) */
export async function exchangeAuthorizationCode(o: TokenExchangeParams): Promise<McpToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: o.code,
    code_verifier: o.codeVerifier,
    redirect_uri: o.redirectUri,
    ...(o.clientId ? { client_id: o.clientId } : {}),
  })
  return postTokenForm(o.tokenEndpoint, body, o.fetchImpl, '授权码换 token')
}

export interface TokenRefreshParams {
  tokenEndpoint: string
  clientId?: string
  refreshToken: string
  fetchImpl?: typeof fetch
}

/** 用 refresh_token 刷新 access_token */
export async function refreshOAuthToken(o: TokenRefreshParams): Promise<McpToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
    ...(o.clientId ? { client_id: o.clientId } : {}),
  })
  return postTokenForm(o.tokenEndpoint, body, o.fetchImpl, '刷新 token')
}

async function postTokenForm(
  tokenEndpoint: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch | undefined,
  action: string,
): Promise<McpToken> {
  const resp = await (fetchImpl ?? fetch)(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    throw new Error(`${action}失败 HTTP ${resp.status}: ${await resp.text().catch(() => '')}`)
  }
  return (await resp.json()) as McpToken
}

// ===== 拼授权 URL =====

/** 构造授权 URL(RFC 7636 PKCE,附加 client_id/scope/state) */
export function buildAuthorizationUrl(
  authorizationEndpoint: string,
  oauth: McpOauthConfig,
  challenge: string,
  redirectUri: string,
  state: string,
): string {
  const u = new URL(authorizationEndpoint)
  const p = new URLSearchParams({
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    state,
  })
  if (oauth.clientId) p.set('client_id', oauth.clientId)
  if (oauth.scopes?.length) p.set('scope', oauth.scopes.join(' '))
  u.search = p.toString()
  return u.toString()
}

// ===== OAuthFlow:编排 =====

export interface OAuthFlowOptions {
  /** dataDir store 的键(由 baseUrl 派生) */
  serverKey: string
  /** well-known 发现基址 / 展示用 */
  baseUrl: string
  oauth: McpOauthConfig
  store: OAuthTokenStore
  fetchImpl?: typeof fetch
  /** 授权码读取器(可注入 stdin);缺省读 process.stdin 一行 */
  readCode?: () => Promise<string>
  log?: (msg: string) => void
}

/** OAuth 授权流程门面:对外只需 ensureAccessToken;并发去重 */
export class OAuthFlow {
  readonly serverKey: string
  private readonly baseUrl: string
  private readonly oauth: McpOauthConfig
  private readonly store: OAuthTokenStore
  private readonly fetchImpl: typeof fetch
  private readonly readCode: () => Promise<string>
  private readonly log: (msg: string) => void
  private token?: McpToken
  private pending?: Promise<string>

  constructor(o: OAuthFlowOptions) {
    this.serverKey = o.serverKey
    this.baseUrl = o.baseUrl
    this.oauth = o.oauth
    this.store = o.store
    this.fetchImpl = o.fetchImpl ?? fetch
    this.readCode = o.readCode ?? defaultReadCode
    this.log = o.log ?? (() => {})
  }

  /** 当前内存态 token 明文(未读取为 undefined) */
  get accessToken(): string | undefined {
    return this.token?.access_token
  }

  /**
   * 返回可用的明文 access_token。命中缓存/磁盘直接返回;过期先后 refresh;
   * 无 refresh 或无 token 则触发交互授权。首次并发的多次调用只触发一次流程。
   */
  ensureAccessToken(opts?: { refresh?: boolean }): Promise<string> {
    if (this.pending) return this.pending
    const p = this.run(opts?.refresh === true).finally(() => {
      this.pending = undefined
    })
    this.pending = p
    return p
  }

  /** 清内存缓存 + 强制重新授权 */
  reauthorize(): Promise<string> {
    this.token = undefined
    return this.ensureAccessToken()
  }

  private async run(forceRefresh: boolean): Promise<string> {
    // 1) 缓存/磁盘命中(未过期)
    const cached = this.token ?? (await this.store.load(this.serverKey))
    if (!forceRefresh && cached) {
      const exp =
        cached.obtained_at != null && cached.expires_in != null
          ? cached.obtained_at + cached.expires_in * 1000
          : undefined
      if (!exp || exp > Date.now() + 30_000) {
        this.token = cached
        return cached.access_token
      }
    }
    const meta = await this.resolveMetadata()

    // 2) refresh(失败则回落交互)
    const rt = (this.token ?? cached)?.refresh_token
    if (rt && !forceRefresh) {
      try {
        const fresh = await refreshOAuthToken({
          tokenEndpoint: meta.token_endpoint,
          clientId: this.oauth.clientId,
          refreshToken: rt,
          fetchImpl: this.fetchImpl,
        })
        const merged: McpToken = { ...(this.token ?? cached), ...fresh, obtained_at: Date.now() }
        this.token = merged
        await this.store.save(this.serverKey, merged)
        return merged.access_token
      } catch {
        /* 刷新失败,回落交互 */
      }
    }

    // 3) 交互授权
    const { verifier, challenge } = generatePkce()
    const authUrl = buildAuthorizationUrl(
      meta.authorization_endpoint,
      this.oauth,
      challenge,
      'http://localhost',
      randomBytes(9).toString('hex'),
    )
    this.log(
      `请授权 MCP Server(<${this.baseUrl}>)\n` +
        `打开浏览器访问:\n  ${authUrl}\n` +
        `授权完成后把回调地址(整段,或其中的 code 参数)粘贴到下面:`,
    )
    const code = await this.readCode()
    const token = await exchangeAuthorizationCode({
      tokenEndpoint: meta.token_endpoint,
      clientId: this.oauth.clientId,
      code: extractCode(code),
      codeVerifier: verifier,
      redirectUri: 'http://localhost',
      fetchImpl: this.fetchImpl,
    })
    const full: McpToken = { ...token, obtained_at: Date.now() }
    this.token = full
    await this.store.save(this.serverKey, full)
    return full.access_token
  }

  private async resolveMetadata(): Promise<McpOauthServerMetadata> {
    if (this.oauth.tokenEndpoint && this.oauth.authorizationEndpoint) {
      return {
        authorization_endpoint: this.oauth.authorizationEndpoint,
        token_endpoint: this.oauth.tokenEndpoint,
      }
    }
    return discoverOAuthMetadata(this.oauth.discoveryUrl ?? this.baseUrl, this.fetchImpl)
  }
}

/** 缺省授权码读取器:从 stdin 读一行 */
function defaultReadCode(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.setEncoding('utf-8')
    process.stdin.once('data', (chunk) => resolve(String(chunk).trim()))
  })
}

/** 从粘贴内容提取 code(兼容整段回调 URL) */
function extractCode(input: string): string {
  const m = /[?&]code=([^&\s#]+)/i.exec(input)
  return m ? decodeURIComponent(m[1]) : input.trim()
}