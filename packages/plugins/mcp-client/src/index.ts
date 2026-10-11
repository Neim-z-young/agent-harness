/**
 * @harness/mcp-client
 *
 * MCP Client 插件：对接 Model Context Protocol
 * - 支持三种 transport：
 *   - stdio：通过子进程 stdin/stdout 通信（newline-delimited JSON-RPC 2.0）
 *   - http：Streamable HTTP（MCP 2025-03-26），POST JSON-RPC 请求，响应可为 JSON 或 SSE 流
 *   - sse：旧版 HTTP+SSE（MCP 2024-11-05 之前的 HTTP transport），GET 建立 SSE 后 POST 请求
 * - 自动发现 MCP Server 的 tools / resources / prompts 并按需注册到 Harness
 * - 工具命名：mcp__${serverName}__${toolName}（同 Claude Code 约定）
 * - 工具安全声明：Fail-Closed（isReadOnly=false, isDestructive=false）
 * - 支持 Bearer Token 鉴权（HTTP/SSE transport）
 * - 支持 OAuth2 PKCE 授权码（HTTP/SSE transport）：
 *   端点 well-known 自动发现 / 显式配置；token 加密持久化到 dataDir/oauth-tokens.json；
 *   access 过期自动 refresh；HTTP 401/403 强制刷新后重试一次。
 *   详见 src/oauth.ts 与 src/token-store.ts。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentPlugin, Hooks } from '@harness/plugin'
import type { Tool, ToolResult, Schema, ToolContext } from '@harness/tool'
import { withJsonSchema } from '@harness/tool'
import { defaultUserDir } from '@harness/workspace'
import { OAuthFlow, type McpOauthConfig } from './oauth'
import { OAuthTokenStore, oauthServerKey } from './token-store'
// MCP 资源注入模板（prompts/mcp-resources.txt，import 加载，参考 opencode）
import mcpResourceTemplate from './prompts/mcp-resources.txt'

// ===== 类型定义 =====

/** 异步 OAuth token 解析器：返回可用明文 access_token（内部负责缓存/刷新/交互授权） */
export type OauthResolver = (opts?: { refresh?: boolean }) => Promise<string>

/** 鉴权配置（用于 HTTP/SSE transport） */
export interface McpAuthConfig {
  /** Bearer Token，会在请求头注入 `Authorization: Bearer ${token}` */
  bearerToken?: string
  /** 直接作为 Authorization 头值（如 "Bearer xxx"），优先级低于 oauth、高于 bearerToken */
  authorizationHeader?: string
  /** 自定义请求头（合并到 fetch headers） */
  headers?: Record<string, string>
  /** OAuth2 PKCE 配置：存在时优先走 OAuth 授权码流程，其次回落静态 bearerToken */
  oauth?: McpOauthConfig
}

/** MCP Server 配置（支持 stdio / http / sse 三种 transport） */
export interface McpServerConfig {
  /** 服务器名称（用于工具命名 mcp__${name}__${tool}） */
  name: string
  /**
   * 传输类型。缺省时根据字段推断：
   * - 有 command → stdio
   * - 有 url → http
   */
  transport?: 'stdio' | 'sse' | 'http'
  /** stdio 模式：启动命令（如 "npx"） */
  command?: string
  /** stdio 模式：命令参数 */
  args?: string[]
  /** stdio 模式：环境变量（**总是不受白名单限制地透传** —— 这是“你需要就自己声明”的路径） */
  env?: Record<string, string>
  /**
   * stdio 模式：除默认白名单外，额外要从宿主环境透传的变量名（P0-2）。
   * 例：需要 `GITHUB_TOKEN` 又不想写进配置时用。
   */
  envKeep?: string[]
  /**
   * stdio 模式：**关闭 env 隔离**，恢复“全量继承宿主环境”（P0-2）。
   * 默认 `false` —— 第三方 server 拿全量 env 是取“同一个 `GITHUB_TOKEN`，bash 里被摘掉、
   * MCP 里照样读得到”那个不对称。确实需要时显式打开。
   */
  inheritEnv?: boolean
  /** sse/http 模式：服务器 URL */
  url?: string
  /** 鉴权配置（仅 sse/http） */
  auth?: McpAuthConfig
  /** MCP 协议版本号，缺省 '2024-11-05' */
  protocolVersion?: string
  /** 单次请求超时（毫秒），缺省 30000 */
  requestTimeoutMs?: number
  /** 是否自动发现 resources（缺省 true） */
  discoverResources?: boolean
  /** 是否自动发现 prompts（缺省 true） */
  discoverPrompts?: boolean
}

/** MCP 工具定义（来自 tools/list 响应） */
export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** MCP 工具调用结果（来自 tools/call 响应） */
export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  isError?: boolean
}

/** MCP 资源定义（来自 resources/list 响应） */
export interface McpResourceDef {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/** MCP 资源内容（来自 resources/read 响应） */
export interface McpResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

/** MCP Prompt 定义（来自 prompts/list 响应） */
export interface McpPromptDef {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

/** MCP Prompt 消息（来自 prompts/get 响应） */
export interface McpPromptMessage {
  role: 'user' | 'assistant'
  content: { type: string; text?: string; [k: string]: unknown }
}

/** MCP Server 能力（来自 initialize 响应） */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { listChanged?: boolean; subscribe?: boolean }
  prompts?: { listChanged?: boolean }
  logging?: {}
  experimental?: Record<string, unknown>
}

// ===== Transport 抽象 =====

/** 传输层接口（便于测试注入） */
export interface McpTransport {
  /** 发送原始数据（JSON-RPC 字符串） */
  send(data: string): void
  /** 注册消息处理回调 */
  onMessage(handler: (data: string) => void): void
  /** 关闭连接 */
  close(): void
}

/**
 * 子进程环境变量的**默认白名单**（P0-2）。
 *
 * 选取原则：只收“…不给它就跑不起来”的东西 —— 进程启动/查找依赖（`PATH` / `SystemRoot` /
 * `COMSPEC`）、家目录与临时目录（`HOME` / `TMPDIR`）、本地化与终端（`LANG` / `TERM`）。
 * **凭据一律不在内**：`GITHUB_TOKEN` / `AWS_*` / `OPENAI_API_KEY` … 要传就在
 * `mcpServers[].env` 里**显式声明**（或 `envKeep` 点名）。
 */
export const DEFAULT_MCP_ENV_KEEP: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  // Windows：MCP server 多数是 node/python，缺这几个直接启动失败
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]

/**
 * 组装 MCP 子进程的环境变量（P0-2）。
 *
 * 改造前是 `{ ...process.env, ...config.env }` —— **全量继承**。同一个 `GITHUB_TOKEN`，
 * bash 里被 `sanitizeEnv` 摘掉、第三方 MCP server 里却照样读得到，隔离不对称且没人会注意到。
 * 现在默认只透传白名单 + 声明项：**默认拒绍，要用自己声明**。
 *
 * 优先级：`inheritEnv`（全量）> 白名单（+ `envKeep`）> `declared`（后盖前）。
 */
export function buildMcpChildEnv(opts: {
  /** 服务声明里显式给的 env（总是生效、且优先于宿主同名变量） */
  declared?: Record<string, string>
  /** 额外保留的宿主变量名 */
  keep?: string[]
  /** 是否恢复全量继承（默认 false） */
  inheritAll?: boolean
  /** 宿主环境（测试注入用，默认 process.env） */
  hostEnv?: NodeJS.ProcessEnv
} = {}): Record<string, string> {
  const host = opts.hostEnv ?? process.env
  const inherited: Record<string, string> = {}
  if (opts.inheritAll) {
    for (const [k, v] of Object.entries(host)) if (v !== undefined) inherited[k] = v
  } else {
    const keep = new Set([...DEFAULT_MCP_ENV_KEEP, ...(opts.keep ?? [])])
    for (const [k, v] of Object.entries(host)) if (v !== undefined && keep.has(k)) inherited[k] = v
  }
  return { ...inherited, ...(opts.declared ?? {}) }
}

/** stdio 传输：通过子进程 stdin/stdout */
export class StdioTransport implements McpTransport {
  private proc: ChildProcessWithoutNullStreams
  private handler?: (data: string) => void
  private buffer = ''

  constructor(config: {
    command: string
    args?: string[]
    env?: Record<string, string>
    /** P0-2：额外保留的宿主变量名 / 关闭 env 隔离（见 {@link buildMcpChildEnv}） */
    envKeep?: string[]
    inheritEnv?: boolean
  }) {
    this.proc = spawn(config.command, config.args ?? [], {
      env: buildMcpChildEnv({ declared: config.env, keep: config.envKeep, inheritAll: config.inheritEnv }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) this.handler?.(line.trim())
      }
    })
    this.proc.stderr.on('data', () => { /* 忽略 stderr */ })
  }

  send(data: string): void {
    this.proc.stdin.write(data + '\n')
  }

  onMessage(handler: (data: string) => void): void {
    this.handler = handler
  }

  close(): void {
    try { this.proc.kill() } catch { /* 忽略 */ }
  }
}

// ===== HTTP/SSE transport 公共辅助 =====

/**
 * 把鉴权配置 + 自定义头合并为 fetch headers。
 * oauth 存在时优先从 oauthResolver 取动态 token（异步），否则回落静态 bearerToken/authorizationHeader。
 */
async function buildAuthHeaders(
  auth?: McpAuthConfig,
  oauthResolver?: OauthResolver,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (oauthResolver && auth?.oauth) {
    const token = await oauthResolver()
    if (token) headers['Authorization'] = `Bearer ${token}`
  } else if (auth?.authorizationHeader) {
    headers['Authorization'] = auth.authorizationHeader
  } else if (auth?.bearerToken) {
    headers['Authorization'] = `Bearer ${auth.bearerToken}`
  }
  if (auth?.headers) Object.assign(headers, auth.headers)
  return headers
}

/** 从 SSE 文本流中解析出 data 行（按 `\n\n` 分事件，每个事件合并多行 data） */
function parseSseChunk(chunk: string): string[] {
  const messages: string[] = []
  // SSE 事件以空行分隔；只取 data: 行内容（多行 data 用 \n 拼接）
  const events = chunk.split(/\r?\n\r?\n/)
  for (const ev of events) {
    if (!ev.trim()) continue
    const dataLines = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
    if (dataLines.length > 0) messages.push(dataLines.join('\n'))
  }
  return messages
}

/** Streamable HTTP transport（MCP 2025-03-26）：直接 POST JSON-RPC，响应可为 JSON 或 SSE */
export class HttpTransport implements McpTransport {
  private handler?: (data: string) => void
  private closed = false
  private sessionId?: string
  private readonly url: string
  private readonly auth?: McpAuthConfig
  private readonly oauthResolver?: OauthResolver

  constructor(config: { url: string; auth?: McpAuthConfig; oauthResolver?: OauthResolver }) {
    this.url = config.url
    this.auth = config.auth
    this.oauthResolver = config.oauthResolver
  }

  async send(data: string): Promise<void> {
    if (this.closed) throw new Error('HTTP transport closed')
    const status = await this.post(data)
    if (status !== 401 && status !== 403) return
    // 401/403：可重试的 oauth 场景强制刷新后重试一次，再失败抛错
    if (this.oauthResolver && this.auth?.oauth) {
      await this.oauthResolver({ refresh: true })
      const retryStatus = await this.post(data)
      if (retryStatus === 401 || retryStatus === 403) {
        throw new Error(`HTTP ${retryStatus}: OAuth 重试后仍被拒绝`)
      }
      return
    }
    throw new Error(`HTTP ${status}: 鉴权被拒绝`)
  }

  /** 发送一次 POST，返回响应状态码；SSE/JSON 响应会分发给 handler */
  private async post(data: string): Promise<number> {
    const headers: Record<string, string> = await buildAuthHeaders(this.auth, this.oauthResolver)
    headers['Accept'] = 'application/json, text/event-stream'
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    const resp = await fetch(this.url, {
      method: 'POST',
      headers,
      body: data,
    })
    // 缓存 session id（202 状态或首次响应）
    const sid = resp.headers.get('Mcp-Session-Id')
    if (sid) this.sessionId = sid

    const contentType = resp.headers.get('Content-Type') ?? ''
    if (contentType.includes('text/event-stream')) {
      // SSE 流响应：逐块解析
      const reader = resp.body?.getReader()
      if (!reader) return resp.status
      const decoder = new TextDecoder()
      let buf = ''
      while (!this.closed) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // 按事件边界切分，保留最后一段不完整的内容
        const lastBoundary = buf.lastIndexOf('\n\n')
        if (lastBoundary !== -1) {
          const complete = buf.slice(0, lastBoundary + 2)
          buf = buf.slice(lastBoundary + 2)
          for (const msg of parseSseChunk(complete)) {
            this.handler?.(msg)
          }
        }
      }
      // flush 残留
      if (buf.trim()) for (const msg of parseSseChunk(buf + '\n\n')) this.handler?.(msg)
      return resp.status
    } else if (contentType.includes('application/json')) {
      const text = await resp.text()
      if (text.trim()) this.handler?.(text)
      return resp.status
    } else if (resp.status === 202) {
      // Accepted：响应在后续 SSE 推送中（这里不处理，等后续 GET 流）
      return resp.status
    } else if (resp.status === 401 || resp.status === 403) {
      // 鉴权拒绝：交由 send 判定是否 OAuth 重试
      await resp.text().catch(() => '')
      return resp.status
    } else {
      throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`)
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.handler = handler
  }

  close(): void {
    this.closed = true
  }
}

/** 旧版 HTTP+SSE transport（MCP 2024-11-05 之前的 HTTP transport） */
export class SseTransport implements McpTransport {
  private handler?: (data: string) => void
  private closed = false
  private postEndpoint?: string
  private readonly baseUrl: string
  private readonly auth?: McpAuthConfig
  private readonly oauthResolver?: OauthResolver

  constructor(config: { url: string; auth?: McpAuthConfig; oauthResolver?: OauthResolver }) {
    this.baseUrl = config.url
    this.auth = config.auth
    this.oauthResolver = config.oauthResolver
  }

  /** 建立 SSE 连接，等待服务器推送 endpoint 事件 */
  async connectSse(): Promise<void> {
    if (this.closed) throw new Error('SSE transport closed')
    const headers = await buildAuthHeaders(this.auth, this.oauthResolver)
    headers['Accept'] = 'text/event-stream'
    const resp = await fetch(this.baseUrl, { method: 'GET', headers })
    if (!resp.ok) throw new Error(`SSE connect failed: ${resp.status}`)
    const reader = resp.body?.getReader()
    if (!reader) throw new Error('No SSE stream')

    const decoder = new TextDecoder()
    let buf = ''
    // 后台消费 SSE 流
    ;(async () => {
      while (!this.closed) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lastBoundary = buf.lastIndexOf('\n\n')
        if (lastBoundary !== -1) {
          const complete = buf.slice(0, lastBoundary + 2)
          buf = buf.slice(lastBoundary + 2)
          this.handleSseEvent(complete)
        }
      }
    })().catch(() => { /* 连接断开忽略 */ })
  }

  private handleSseEvent(raw: string): void {
    // 解析 event + data
    const lines = raw.split(/\r?\n/)
    let eventName = 'message'
    const dataLines: string[] = []
    for (const l of lines) {
      if (l.startsWith('event:')) eventName = l.slice(6).trim()
      else if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''))
    }
    const data = dataLines.join('\n')
    if (eventName === 'endpoint') {
      // 服务器告知 POST 端点（可能是相对 URL）
      this.postEndpoint = data.startsWith('http')
        ? data
        : new URL(data, this.baseUrl).toString()
    } else if (eventName === 'message' && data) {
      this.handler?.(data)
    }
  }

  async send(data: string): Promise<void> {
    if (this.closed) throw new Error('SSE transport closed')
    if (!this.postEndpoint) throw new Error('SSE endpoint not received yet')
    const headers = await buildAuthHeaders(this.auth, this.oauthResolver)
    const resp = await fetch(this.postEndpoint, {
      method: 'POST',
      headers,
      body: data,
    })
    // POST 响应应为 202，实际 JSON-RPC 响应通过 SSE 流推送
    if (!resp.ok && resp.status !== 202) {
      throw new Error(`SSE POST failed: ${resp.status}`)
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.handler = handler
  }

  close(): void {
    this.closed = true
  }
}

/** transport 工厂上下文：承载 OAuth token 持久化目录与交互/日志注入 */
export interface TransportFactoryContext {
  /** token 加密持久化目录；缺省用 defaultUserDir() */
  dataDir?: string
  /** 替换全局 fetch（测试注入） */
  fetchImpl?: typeof fetch
  /** 授权码读取器（缺省读 stdin 一行） */
  readCode?: () => Promise<string>
  /** 授权提示/日志输出 */
  log?: (msg: string) => void
}

/** 为 OAuth 配置装配 OAuthFlow 的 ensureAccessToken 解析器 */
function oauthResolverFor(config: McpServerConfig, ctx: TransportFactoryContext): OauthResolver | undefined {
  if (!config.auth?.oauth) return undefined
  const baseUrl = config.url
  if (!baseUrl) return undefined
  const flow = new OAuthFlow({
    serverKey: oauthServerKey(baseUrl),
    baseUrl,
    oauth: config.auth.oauth,
    store: new OAuthTokenStore(ctx.dataDir ?? defaultUserDir()),
    fetchImpl: ctx.fetchImpl,
    readCode: ctx.readCode,
    log: ctx.log,
  })
  return (opts) => flow.ensureAccessToken(opts)
}

/** 默认 transport 工厂：根据 config.transport 选择 */
export function defaultTransportFactory(
  config: McpServerConfig,
  ctx: TransportFactoryContext = {},
): McpTransport {
  const t = config.transport ?? (config.command ? 'stdio' : 'http')
  const oauthResolver = oauthResolverFor(config, ctx)
  if (t === 'stdio') {
    if (!config.command) throw new Error(`MCP Server "${config.name}" 缺少 command（stdio 模式必填）`)
    return new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      envKeep: config.envKeep,
      inheritEnv: config.inheritEnv,
    })
  }
  if (t === 'sse') {
    if (!config.url) throw new Error(`MCP Server "${config.name}" 缺少 url（sse 模式必填）`)
    return new SseTransport({ url: config.url, auth: config.auth, oauthResolver })
  }
  if (t === 'http') {
    if (!config.url) throw new Error(`MCP Server "${config.name}" 缺少 url（http 模式必填）`)
    return new HttpTransport({ url: config.url, auth: config.auth, oauthResolver })
  }
  throw new Error(`Unknown transport: ${t as string}`)
}

// ===== MCP Client =====

/** JSON-RPC 2.0 请求/响应管理 */
export class McpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private connected = false
  /** Server capabilities（initialize 响应中缓存） */
  private capabilities: McpServerCapabilities = {}
  /** Server 信息（initialize 响应中缓存） */
  serverInfo: { name?: string; version?: string } = {}
  /** 协议版本（initialize 响应中缓存） */
  protocolVersion: string = '2024-11-05'
  /** 配置（用于读取 protocolVersion / requestTimeoutMs） */
  private readonly config?: McpServerConfig

  constructor(
    public readonly name: string,
    private readonly transport: McpTransport,
    config?: McpServerConfig,
  ) {
    this.config = config
    transport.onMessage((data) => this.handleMessage(data))
  }

  /** 建立 MCP 连接：发送 initialize + notifications/initialized */
  async connect(): Promise<void> {
    const protocolVersion = this.config?.protocolVersion ?? '2024-11-05'
    const result = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'harness-mcp-client', version: '0.1.0' },
    })
    const resp = (result ?? {}) as {
      protocolVersion?: string
      capabilities?: McpServerCapabilities
      serverInfo?: { name?: string; version?: string }
    }
    if (resp.protocolVersion) this.protocolVersion = resp.protocolVersion
    if (resp.capabilities) this.capabilities = resp.capabilities
    if (resp.serverInfo) this.serverInfo = resp.serverInfo
    this.connected = true
    // 发送 initialized 通知（不期望响应）
    await this.notify('notifications/initialized', {})
  }

  /** 列出 MCP Server 提供的工具 */
  async listTools(): Promise<McpToolDef[]> {
    if (!this.capabilities.tools) return []
    const result = await this.request('tools/list', {})
    const tools = (result as { tools?: McpToolDef[] })?.tools ?? []
    return tools
  }

  /** 调用 MCP 工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    return result as McpToolCallResult
  }

  /** 列出 MCP Server 提供的资源 */
  async listResources(): Promise<McpResourceDef[]> {
    if (!this.capabilities.resources) return []
    const result = await this.request('resources/list', {})
    const resources = (result as { resources?: McpResourceDef[] })?.resources ?? []
    return resources
  }

  /** 读取指定资源的内容 */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    if (!this.capabilities.resources) return []
    const result = await this.request('resources/read', { uri })
    const contents = (result as { contents?: McpResourceContent[] })?.contents ?? []
    return contents
  }

  /** 订阅资源变更（需 capabilities.resources.subscribe） */
  async subscribeResource(uri: string): Promise<void> {
    if (!this.capabilities.resources?.subscribe) return
    await this.notify('resources/subscribe', { uri })
  }

  /** 取消订阅资源变更 */
  async unsubscribeResource(uri: string): Promise<void> {
    if (!this.capabilities.resources?.subscribe) return
    await this.notify('resources/unsubscribe', { uri })
  }

  /** 列出 MCP Server 提供的 prompts */
  async listPrompts(): Promise<McpPromptDef[]> {
    if (!this.capabilities.prompts) return []
    const result = await this.request('prompts/list', {})
    const prompts = (result as { prompts?: McpPromptDef[] })?.prompts ?? []
    return prompts
  }

  /** 获取指定 prompt 渲染后的消息 */
  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptMessage[]> {
    if (!this.capabilities.prompts) return []
    const result = await this.request('prompts/get', { name, arguments: args ?? {} })
    const messages = (result as { messages?: McpPromptMessage[] })?.messages ?? []
    return messages
  }

  /** 关闭连接 */
  close(): void {
    this.transport.close()
    this.connected = false
    // 拒绝所有 pending 请求
    for (const [, p] of this.pending) p.reject(new Error('MCP client closed'))
    this.pending.clear()
  }

  get isConnected(): boolean { return this.connected }
  /** 服务器能力（只读视图） */
  get serverCapabilities(): Readonly<McpServerCapabilities> { return this.capabilities }

  // ----- JSON-RPC 内部 -----

  /** 设置自定义通知处理器（用于插件层接收 resources/listChanged 等通知） */
  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler
  }
  private notificationHandler?: (method: string, params: unknown) => void

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const timeoutMs = this.config?.requestTimeoutMs ?? 30_000
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // send 可能是 async（HTTP/SSE transport），需要捕获其抛出的错误
      Promise.resolve(this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })))
        .catch((err) => {
          if (this.pending.has(id)) {
            this.pending.delete(id)
            reject(new Error(`MCP send "${method}" failed: ${String((err as Error)?.message ?? err)}`))
          }
        })
      // 超时
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP request "${method}" timed out (${timeoutMs}ms)`))
        }
      }, timeoutMs)
    })
  }

  private async notify(method: string, params: unknown): Promise<void> {
    try {
      await Promise.resolve(this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params })))
    } catch (err) {
      // notify 失败不阻塞业务，但记录到 stderr
      console.error(`[mcp-client] notify "${method}" failed:`, (err as Error)?.message ?? err)
    }
  }

  private handleMessage(data: string): void {
    let msg: any
    try { msg = JSON.parse(data) } catch { return }
    // 响应（有 id 且 pending 中存在）
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error?.message ?? 'MCP error'))
      else p.resolve(msg.result)
      return
    }
    // 通知 / 请求（有 method 无 id 或 id 不在 pending 中）
    if (msg.method && msg.id == null) {
      // 纯通知
      this.notificationHandler?.(msg.method, msg.params)
    } else if (msg.method && msg.id != null) {
      // 服务器发起的请求（如 sampling/createMessage、roots/list）
      // 当前实现：返回 method not supported 错误响应
      try {
        Promise.resolve(this.transport.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not supported: ${msg.method}` },
        }))).catch(() => { /* ignore */ })
      } catch { /* ignore */ }
    }
  }
}

// ===== MCP Tool → Harness Tool 转换 =====

/** Passthrough schema：接受任何对象输入（MCP Server 自行校验） */
class PassthroughSchema implements Schema<Record<string, unknown>> {
  parse(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) throw new Error('Expected object')
    return value as Record<string, unknown>
  }
  safeParse(value: unknown) {
    if (typeof value !== 'object' || value === null) {
      return { success: false as const, error: new Error('Expected object') }
    }
    return { success: true as const, data: value as Record<string, unknown> }
  }
}

/** 把 MCP 工具定义转换为 Harness Tool 对象 */
export function convertMcpToolToHarnessTool(
  mcpTool: McpToolDef,
  serverName: string,
  client: McpClient,
): Tool<Record<string, unknown>, unknown> {
  const toolId = `mcp__${serverName}__${mcpTool.name}`
  return {
    id: toolId,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
    // Fail-Closed 安全声明
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    // MCP 服务端声明的 inputSchema 原样透传给模型（此前用裸 PassthroughSchema，
    // 服务端声明的参数名/类型/必填项全部丢失 ⇒ 模型只能空参调用或瞎猜）。
    inputSchema: withJsonSchema(new PassthroughSchema(), (mcpTool.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    }) as never),
    async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult<unknown>> {
      try {
        const result = await client.callTool(mcpTool.name, input)
        // 提取文本内容
        const texts = (result.content ?? [])
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
        const output = texts.length === 1 ? texts[0] : texts.length > 1 ? texts.join('\n') : result
        return {
          ok: !result.isError,
          output: result.isError ? undefined : output,
          error: result.isError ? { message: `MCP tool "${mcpTool.name}" returned error`, code: 'MCP_ERROR' } : undefined,
        }
      } catch (err) {
        return {
          ok: false,
          error: { message: String((err as Error)?.message ?? err), code: 'MCP_CALL_FAILED' },
        }
      }
    },
  }
}

// ===== 插件工厂 =====

/** MCP Server 在插件内部的运行时状态 */
interface McpServerRuntime {
  config: McpServerConfig
  client: McpClient
  tools: Tool[]
  resources: McpResourceDef[]
  prompts: McpPromptDef[]
}

/**
 * 创建 MCP Client 插件
 *
 * @param servers MCP Server 配置列表
 * @param transportFactory 可选：自定义传输层工厂（测试注入用）。缺省使用 defaultTransportFactory。
 * @param autoInjectResources 可选：自动把这些资源的 text 内容追加到 system prompt。
 *   - 'all'：注入所有发现到的资源
 *   - string[]：注入指定 URI 的资源
 *   - 缺省：不注入
 * @param dataDir transport 上下文透传（OAuth token 持久化目录）
 */
export function createMcpClientPlugin(options: {
  servers: McpServerConfig[]
  transportFactory?: (config: McpServerConfig, ctx?: TransportFactoryContext) => McpTransport
  autoInjectResources?: 'all' | string[]
  dataDir?: string
}): AgentPlugin {
  const { servers, transportFactory, autoInjectResources, dataDir } = options
  const runtimes: McpServerRuntime[] = []
  /** 自动注入的资源内容缓存（uri → text） */
  const injectedResourceCache = new Map<string, string>()
  let connected = false

  return {
    id: 'mcp.client',
    version: '0.2.0',
    name: 'MCP Client',
    description: `MCP Client 插件：连接 ${servers.length} 个 MCP Server，自动发现并注册工具 / 资源 / prompts`,

    async install(ctx) {
      ctx.log.info('MCP Client 插件已加载', { servers: servers.map((s) => s.name) })
      return {
        async 'core.harness.start'() {
          if (connected) return
          for (const config of servers) {
            try {
              const transport = transportFactory
                ? transportFactory(config, { dataDir })
                : defaultTransportFactory(config, { dataDir })
              const client = new McpClient(config.name, transport, config)
              await client.connect()

              // SSE transport 需要先建立 SSE 流
              if (transport instanceof SseTransport) {
                await (transport as SseTransport).connectSse()
              }

              // 监听 server 通知：resources/listChanged 等
              client.onNotification((method, _params) => {
                if (method === 'notifications/resources/listChanged') {
                  // 重新拉取资源列表并更新对应 runtime
                  client.listResources()
                    .then((fresh) => {
                      const rt = runtimes.find((r) => r.client === client)
                      if (rt) rt.resources = fresh
                    })
                    .catch(() => { /* ignore */ })
                }
              })

              const tools = await client.listTools()
              const harnessTools = tools.map((t) => convertMcpToolToHarnessTool(t, config.name, client))

              let resources: McpResourceDef[] = []
              if (config.discoverResources !== false) {
                resources = await client.listResources()
                // 自动注入资源到 system prompt
                if (autoInjectResources) await loadAutoInjectResources(client, resources, injectedResourceCache, autoInjectResources)
              }
              let prompts: McpPromptDef[] = []
              if (config.discoverPrompts !== false) {
                prompts = await client.listPrompts()
              }

              runtimes.push({ config, client, tools: harnessTools, resources, prompts })
              ctx.log.info(`MCP Server "${config.name}" 已连接`, {
                transport: config.transport ?? (config.command ? 'stdio' : 'http'),
                tools: tools.map((t) => t.name),
                resources: resources.map((r) => r.uri),
                prompts: prompts.map((p) => p.name),
                capabilities: client.serverCapabilities,
              })
            } catch (err) {
              ctx.log.error(`MCP Server "${config.name}" 连接失败`, { error: String((err as Error)?.message ?? err) })
            }
          }
          connected = true
        },

        async 'core.tool.pool.assemble'(_input, pool) {
          for (const rt of runtimes) {
            for (const tool of rt.tools) {
              ;(pool as { add: (t: unknown) => void }).add(tool)
            }
          }
        },

        /**
         * MCP resources 注入走**尾部动态区**，不走 system 区。
         *
         * 理由：`injectedResourceCache` 是**只增不减**的（每读到一份资源就多一条），
         * 放在 system 区意味着"每读到一份新资源，其后的整段历史都要重算"——
         * 而资源正文是参考材料，本来就不需要指令级权威，放尾部零代价。
         * 位置约束的量化见 @harness/plugin 里 `core.prompt.dynamic.transform` 的文档。
         */
        'core.prompt.dynamic.transform'(_input, parts) {
          // 注入自动拉取的资源文本（模板含 `# MCP Resources` 标题 + `{uri}`/`{text}` 占位符）
          if (injectedResourceCache.size > 0) {
            const rendered = Array.from(injectedResourceCache.entries())
              .map(([uri, text]) => mcpResourceTemplate.replace('{uri}', uri).replace('{text}', text))
            // 模板第一条自带标题；后续条目剥离标题行后拼接，避免重复标题
            const [first = '', ...rest] = rendered
            const header = mcpResourceTemplate.match(/^(# [^\n]+\n+)/)?.[1] ?? '# MCP Resources\n\n'
            const extra = rest
              .map((r) => r.startsWith(header) ? r.slice(header.length) : r)
              .join('\n\n')
            // 片段间的空行由 core 拼接时统一补（renderDynamicBlock 用 \n\n join）——
            // 这里不再自己加前导换行，否则尾部块里会出现多余空行
            parts.push(extra ? `${first}\n\n${extra}` : first)
          }
        },

        'cli.commands'(input) {
          if (runtimes.length > 0) {
            input.commands.push({
              command: 'mcp',
              description: 'MCP 服务器 / 工具 / 资源 / prompts 管理',
              usage: '/mcp [servers | tools | resources | read <uri> | prompts | prompt <name>]',
            })
          }
        },

        async 'cli.command'(input) {
          if (input.command !== 'mcp') return
          const sub = (input.arg.trim().split(/\s+/)[0] ?? '').toLowerCase()
          const rest = input.arg.trim().slice(sub.length).trim()

          if (sub === '' || sub === 'servers') {
            // 列出所有 server
            if (runtimes.length === 0) {
              input.out('（无已连接的 MCP Server）\n')
            } else {
              input.out(`已连接 ${runtimes.length} 个 MCP Server：\n`)
              for (const rt of runtimes) {
                const t = rt.config.transport ?? (rt.config.command ? 'stdio' : 'http')
                input.out(`  ${rt.config.name}  [${t}]  tools=${rt.tools.length}  resources=${rt.resources.length}  prompts=${rt.prompts.length}\n`)
              }
            }
          } else if (sub === 'tools') {
            const total = runtimes.reduce((s, r) => s + r.tools.length, 0)
            if (total === 0) {
              input.out('（无已注册的 MCP 工具）\n')
            } else {
              input.out(`已注册 ${total} 个 MCP 工具：\n`)
              for (const rt of runtimes) {
                for (const t of rt.tools) {
                  input.out(`  ${t.id}  -  ${t.description}\n`)
                }
              }
            }
          } else if (sub === 'resources') {
            const total = runtimes.reduce((s, r) => s + r.resources.length, 0)
            if (total === 0) {
              input.out('（无 MCP 资源）\n')
            } else {
              input.out(`可用 ${total} 个 MCP 资源：\n`)
              for (const rt of runtimes) {
                for (const r of rt.resources) {
                  input.out(`  [${rt.config.name}] ${r.uri}  -  ${r.description ?? r.name ?? '(no description)'}\n`)
                }
              }
            }
          } else if (sub === 'read') {
            if (!rest) {
              input.out('用法：/mcp read <uri>\n')
            } else {
              // 跨所有 server 查找该 URI
              let found = false
              for (const rt of runtimes) {
                if (!rt.resources.some((r) => r.uri === rest)) continue
                try {
                  const contents = await rt.client.readResource(rest)
                  for (const c of contents) {
                    if (c.text) input.out(`[${c.uri}] (${c.mimeType ?? 'text'})\n${c.text}\n`)
                    else if (c.blob) input.out(`[${c.uri}] (base64 blob, ${c.blob.length} chars)\n`)
                  }
                  found = true
                } catch (err) {
                  input.out(`读取失败：${(err as Error)?.message ?? err}\n`)
                  found = true
                }
              }
              if (!found) input.out(`未找到资源：${rest}\n`)
            }
          } else if (sub === 'prompts') {
            const total = runtimes.reduce((s, r) => s + r.prompts.length, 0)
            if (total === 0) {
              input.out('（无 MCP prompts）\n')
            } else {
              input.out(`可用 ${total} 个 MCP prompts：\n`)
              for (const rt of runtimes) {
                for (const p of rt.prompts) {
                  const args = p.arguments?.map((a) => `${a.name}${a.required ? '*' : ''}`).join(', ') ?? ''
                  input.out(`  [${rt.config.name}] ${p.name}  -  ${p.description ?? ''}${args ? `  args: ${args}` : ''}\n`)
                }
              }
            }
          } else if (sub === 'prompt') {
            // /mcp prompt <name> [k=v k=v...]
            const parts = rest.split(/\s+/).filter(Boolean)
            if (parts.length === 0) {
              input.out('用法：/mcp prompt <name> [key=value ...]\n')
            } else {
              const promptName = parts[0]
              const args: Record<string, string> = {}
              for (const kv of parts.slice(1)) {
                const [k, ...vParts] = kv.split('=')
                if (k && vParts.length > 0) args[k] = vParts.join('=')
              }
              let found = false
              for (const rt of runtimes) {
                if (!rt.prompts.some((p) => p.name === promptName)) continue
                try {
                  const messages = await rt.client.getPrompt(promptName, args)
                  for (const m of messages) {
                    input.out(`[${m.role}] ${m.content.text ?? JSON.stringify(m.content)}\n`)
                  }
                  found = true
                } catch (err) {
                  input.out(`获取 prompt 失败：${(err as Error)?.message ?? err}\n`)
                  found = true
                }
              }
              if (!found) input.out(`未找到 prompt：${promptName}\n`)
            }
          } else {
            input.out(`未知子命令：${sub}\n用法：/mcp [servers | tools | resources | read <uri> | prompts | prompt <name>]\n`)
          }
          input.result = 'continue'
        },
      } as Hooks
    },

    async uninstall() {
      for (const rt of runtimes) rt.client.close()
      runtimes.length = 0
      injectedResourceCache.clear()
      connected = false
    },
  }
}

// ===== 插件内部 helper =====

/** 根据 autoInjectResources 策略加载资源文本到缓存 */
async function loadAutoInjectResources(
  client: McpClient,
  resources: McpResourceDef[],
  cache: Map<string, string>,
  policy: 'all' | string[],
): Promise<void> {
  const targets = policy === 'all'
    ? resources
    : resources.filter((r) => (policy as string[]).includes(r.uri))
  for (const r of targets) {
    try {
      const contents = await client.readResource(r.uri)
      const text = contents
        .map((c) => c.text ?? '')
        .filter(Boolean)
        .join('\n')
      if (text) cache.set(r.uri, text)
    } catch { /* 忽略单个资源读取失败 */ }
  }
}
