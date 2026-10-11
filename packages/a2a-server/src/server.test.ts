/**
 * `createA2aServer` 端到端：**真起 HTTP 服务**（`Bun.serve`，`port: 0` 自动分配），
 * 用真实 `fetch` 打通 P1-C 的验收口径 —— 而不是直接调内部函数。
 *
 * 为什么必须走真实 HTTP：`Bun.serve` 的 SSE 写出、`formatSSEEvent` 的分帧、
 * `JsonRpcTransportHandler` 的进出参翻译，三者只有在**走一遍网线**时才可能暴露
 * "内部表示漏到线上"这类静默失败（见 `mapping.ts` 开头的两条）。直接调 `handle()`
 * 能测路由逻辑，但测不到分帧与 Content-Type。
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_CARD_PATH, A2A_VERSION_HEADER, Message, TaskState } from '@a2a-js/sdk'
import { defineTool, hashPrincipal, type Hooks } from '@harness/core'
import { HarnessHost, createAuditSink, type Host } from '@harness/host'
import type { MockProviderConfig } from '@harness/provider-mock'
import { CallerRegistry, LOCAL_CALLER } from './auth'
import { messageOf, textPart } from './mapping'
import { DEFAULT_A2A_HOSTNAME, createA2aServer, type A2aServer } from './server'

// ========================================================================
// 夹具
// ========================================================================

/** 注入一个只读 `echo` 工具（声明 `permission` —— 否则权限链不启动，见 executor.test.ts 说明） */
function echoPlugin(calls: { echo: number }) {
  const tool = defineTool({
    id: 'echo',
    description: '回显 msg',
    inputSchema: {
      parse: (v: unknown) => v as { msg: string },
      safeParse: (v: unknown) => ({ success: true as const, data: v as { msg: string } }),
    },
    isReadOnly: () => true,
    permission: { key: 'echo', extractPatterns: (input) => [input.msg] },
    async call(input: { msg: string }) {
      calls.echo += 1
      return { ok: true as const, output: { reply: `echo:${input.msg}` } }
    },
  })
  return {
    id: 'test-echo',
    version: '0.0.0',
    name: 'test-echo',
    async install(): Promise<Hooks> {
      return {
        'core.tool.pool.assemble'(_input: unknown, pool: unknown) {
          ;(pool as { add: (t: unknown) => void }).add(tool)
        },
      } as unknown as Hooks
    },
  }
}

/**
 * 让 mock 在命中某个关键词时先调一次 `echo`，之后给文本。
 *
 * 每条规则 `once`：命中即消耗 —— 于是"工具调完后的第二问"回落到 `defaultResponse`。
 * 多个关键词对应多条规则，供**同一个 provider 上跑多条互不干扰的任务**的用例
 * （`once` 是 provider 实例级状态，一个关键词只能驱动一条任务）。
 */
function toolRules(keywords: string[], finalText: string): MockProviderConfig {
  return {
    defaultResponse: finalText,
    responses: keywords.map((kw) => ({
      match: kw,
      response: '',
      once: true,
      toolCalls: [{ toolUseId: `tu-${kw}`, toolId: 'echo', input: { msg: kw } }],
    })),
  }
}

function toolThenText(toolText: string, finalText: string): MockProviderConfig {
  return toolRules([toolText], finalText)
}

const servers: A2aServer[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of servers) s.stop(true)
  servers.length = 0
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

interface Fixture {
  host: Host
  server: A2aServer
  calls: { echo: number }
  /** 本次 fixture 的数据目录（审计文件落在其 `sessions/` 下） */
  dataDir: string
}

async function makeServer(opts: {
  mock?: MockProviderConfig
  permissionMode?: 'allow-all' | 'ask' | 'deny-all'
  token?: string
  maxConcurrentTasks?: number
  /** 装人工决策审计 sink（`createAuditSink(dataDir)`）；默认不装 */
  audit?: boolean
}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-srv-'))
  dirs.push(dir)
  const calls = { echo: 0 }
  const dataDir = join(dir, '.harness')
  const host = new HarnessHost({
    cwd: dir,
    dataDir,
    agentId: 'default',
    provider: 'mock',
    permissionMode: opts.permissionMode ?? 'ask',
    mockProviderConfig: opts.mock ?? { defaultResponse: '你好世界' },
    extraPlugins: [echoPlugin(calls) as never],
    autoResume: false,
    backgroundPreload: false,
    ...(opts.audit ? { audit: createAuditSink(dataDir) } : {}),
  })
  await host.boot()
  const server = createA2aServer({
    host,
    port: 0, // 系统分配，避免测试间抢端口
    chunkChars: 1000,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: opts.maxConcurrentTasks } : {}),
  })
  servers.push(server)
  return { host, server, calls, dataDir }
}

// ========================================================================
// HTTP 小工具
// ========================================================================

function userMsg(text: string, o: { messageId?: string; contextId?: string; taskId?: string } = {}) {
  return Message.toJSON(
    messageOf({
      role: 'user',
      parts: [textPart(text)],
      ...(o.messageId ? { messageId: o.messageId } : {}),
      contextId: o.contextId ?? '',
      taskId: o.taskId ?? '',
    }),
  )
}

interface RpcResult {
  status: number
  body: any
}

async function rpc(
  server: A2aServer,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<RpcResult> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [A2A_VERSION_HEADER]: '1.0',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method, params }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

const send = (server: A2aServer, text: string, o: Parameters<typeof userMsg>[1] = {}, headers = {}) =>
  rpc(server, 'SendMessage', { message: userMsg(text, o) }, headers)

/** 解析 SSE 文本为事件数组 */
function parseSSE(raw: string): any[] {
  return raw
    .split('\n\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('data:'))
    .map((s) => JSON.parse(s.slice(5).trim()))
}

async function streamSend(server: A2aServer, text: string, o: Parameters<typeof userMsg>[1] = {}) {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [A2A_VERSION_HEADER]: '1.0' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-s',
      method: 'SendStreamingMessage',
      params: { message: userMsg(text, o) },
    }),
  })
  return { res, events: parseSSE(await res.text()) }
}

const taskOf = (r: RpcResult): any => r.body?.result?.task ?? r.body?.result

async function waitUntil(fn: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitUntil 超时')
}

// ========================================================================
// 卡片 + 路由
// ========================================================================

describe('A2aServer：卡路由', () => {
  it('GET /.well-known/agent-card.json 返回卡片，协议版本只声明在 supportedInterfaces', async () => {
    const { server } = await makeServer({})
    const card = await fetch(`${new URL(server.url).origin}/${AGENT_CARD_PATH}`).then((r) => r.json())
    expect(card.name).toBeTruthy()
    expect(card.supportedInterfaces[0].protocolVersion).toBe('1.0')
    expect(card.supportedInterfaces[0].protocolBinding).toBe('JSONRPC')
    // 顶层 version 是 agent 自身版本，不该等于协议版本
    expect(card.version).not.toBe('1.0')
    expect(card.skills.length).toBeGreaterThanOrEqual(1)
  })

  it('配了 token ⇒ 卡片声明 Bearer 安全方案（走 AgentCard.toJSON，不是裸序列化）', async () => {
    const { server } = await makeServer({ token: 'secret' })
    const card = await fetch(`${new URL(server.url).origin}/${AGENT_CARD_PATH}`).then((r) => r.json())
    // 判别式联合在线上是 {httpAuthSecurityScheme:{…}} —— 裸序列化会变成 {$case,value}
    expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe('Bearer')
    expect(card.securityRequirements.length).toBe(1)
    expect(JSON.stringify(card)).not.toContain('$case')
  })

  it('未知路径 404；JSON-RPC 端点非 POST 405', async () => {
    const { server } = await makeServer({})
    expect((await fetch(`${new URL(server.url).origin}/nope`)).status).toBe(404)
    expect((await fetch(server.url)).status).toBe(405)
  })

  // 回归：官方 a2a-tck 的 JSON-RPC 客户端用 `httpx.Client(base_url=interface.url)` 后
  // `post("/")`，而 httpx 会把 base_url 规范成带尾斜杠的 `/a2a/`（实测 raw_path === b'/a2a/'）。
  // 只匹配精确路径 ⇒ 404 + 非 JSON 体 ⇒ 客户端 `response.json()` 崩（不落进它的
  // `except httpx.HTTPError`）⇒ 一个尾斜杠被放大成整轮验收崩盘。故 `/a2a` 与 `/a2a/` 必须等价。
  it('JSON-RPC 端点与卡路由都容忍尾斜杠（官方 tck 客户端会打到 /a2a/）', async () => {
    const { server } = await makeServer({ mock: { defaultResponse: '尾斜杠也通' } })
    const res = await fetch(`${server.url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [A2A_VERSION_HEADER]: '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-slash',
        method: 'SendMessage',
        params: { message: userMsg('hi', { contextId: 'c-slash' }) },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as RpcResult['body'] & { result?: { task?: { status?: { state?: string } } } }
    expect(body.result?.task?.status?.state).toBe('TASK_STATE_COMPLETED')
    // 取卡路径同样等价（`/.well-known/agent-card.json/`）
    const card = await fetch(`${new URL(server.url).origin}/${AGENT_CARD_PATH}/`)
    expect(card.status).toBe(200)
  })

  it('默认只监听 127.0.0.1', () => {
    expect(DEFAULT_A2A_HOSTNAME).toBe('127.0.0.1')
  })

  // 规范 §8.6.1（官方 a2a-tck CARD-CACHE-001/002/003）：卡片端点要带
  // Cache-Control(含 max-age) / ETag / Last-Modified，并支持条件请求回 304。
  it('卡片响应带缓存校验子，且 If-None-Match 命中时回 304', async () => {
    const { server } = await makeServer({})
    const cardUrl = `${new URL(server.url).origin}/${AGENT_CARD_PATH}`
    const res = await fetch(cardUrl)
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('max-age')
    const etag = res.headers.get('etag')
    expect(etag).toBeTruthy()
    expect(res.headers.get('last-modified')).toBeTruthy()

    // ETag 必须对应**实际响应的字节**
    const body = await res.text()
    const expected = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`
    expect(etag).toBe(expected)

    // 条件请求：带同一 ETag ⇒ 304 且无响应体
    const cond = await fetch(cardUrl, { headers: { 'if-none-match': etag! } })
    expect(cond.status).toBe(304)
    expect(await cond.text()).toBe('')
    // 带 Last-Modified ⇒ 同样 304
    const byDate = await fetch(cardUrl, {
      headers: { 'if-modified-since': res.headers.get('last-modified')! },
    })
    expect(byDate.status).toBe(304)
  })
})

// ========================================================================
// 正常路径 + 流式
// ========================================================================

describe('A2aServer：SendMessage / GetTask', () => {
  it('非流式 SendMessage → task(COMPLETED) + artifact 文本（线上 proto JSON）', async () => {
    const { server } = await makeServer({ mock: { defaultResponse: '你好世界' } })
    const r = await send(server, 'hi', { contextId: 'c1', messageId: 'm1' })
    const task = taskOf(r)
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    // 出参必须是线上形态 {"text":…}，不是内部 content:{$case}
    expect(task.artifacts[0].parts[0].text).toBe('你好世界')
    expect(JSON.stringify(r.body)).not.toContain('$case')
  })

  it('GetTask 取回同一任务', async () => {
    const { server } = await makeServer({ mock: { defaultResponse: 'x' } })
    const task = taskOf(await send(server, 'hi', { contextId: 'c1', messageId: 'm1' }))
    const r = await rpc(server, 'GetTask', { id: task.id })
    expect(taskOf(r).id).toBe(task.id)
  })

  it('SendStreamingMessage → SSE，事件序列以 COMPLETED 收尾', async () => {
    const { server } = await makeServer({ mock: { defaultResponse: '流式回答' } })
    const { res, events } = await streamSend(server, 'hi', { contextId: 'c1', messageId: 'm1' })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(events.length).toBeGreaterThanOrEqual(3)
    const states = events.map(
      (e) => e?.result?.task?.status?.state ?? e?.result?.statusUpdate?.status?.state,
    )
    expect(states).toContain('TASK_STATE_COMPLETED')
    expect(states.at(-1)).toBe('TASK_STATE_COMPLETED')
    // 首个事件是 task
    expect(events[0]?.result?.task?.id).toBeTruthy()
  })

  it('CancelTask 把在跑的任务转 CANCELED', async () => {
    // 用挂起中的任务当"在跑"：确定性，不靠时序
    const { server } = await makeServer({ mock: toolThenText('go', 'x'), permissionMode: 'ask' })
    const task = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED')

    const r = await rpc(server, 'CancelTask', { id: task.id })
    expect(taskOf(r).status.state).toBe('TASK_STATE_CANCELED')
  })
})

// ========================================================================
// 版本 / 认证
// ========================================================================

describe('A2aServer：版本与认证', () => {
  it('缺 A2A-Version 头被拒（宿主层 validateVersion 兜住）', async () => {
    const { server } = await makeServer({})
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'r', method: 'SendMessage', params: { message: userMsg('hi') } }),
    })
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

  it('配了 token ⇒ 缺/错 token 401，正确 token 放行', async () => {
    const { server } = await makeServer({ token: 'secret', mock: { defaultResponse: 'ok' } })

    const noAuth = await send(server, 'hi', { contextId: 'c1', messageId: 'm1' })
    expect(noAuth.status).toBe(401)
    expect(noAuth.body.error.data.a2aCode).toBe('UNAUTHORIZED')

    const badAuth = await send(server, 'hi', { contextId: 'c1', messageId: 'm1' }, { authorization: 'Bearer nope' })
    expect(badAuth.status).toBe(401)

    const good = await send(server, 'hi', { contextId: 'c1', messageId: 'm1' }, { authorization: 'Bearer secret' })
    expect(good.status).toBe(200)
    expect(taskOf(good).status.state).toBe('TASK_STATE_COMPLETED')
  })
})

// ========================================================================
// 权限挂起 + 续接（跨 HTTP 请求）
// ========================================================================

describe('A2aServer：INPUT_REQUIRED 挂起与续接', () => {
  it('ask 点转 INPUT_REQUIRED，带同一 taskId 答复后续接到 COMPLETED', async () => {
    const { server, calls } = await makeServer({ mock: toolThenText('go', '工具说 ok'), permissionMode: 'ask' })

    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED')
    // 结构化待决描述在 `status.message.metadata`（Task.status 本身没有 metadata 字段；
    // 那条 metadata 挂在 statusUpdate **事件**上，SDK 折叠任务快照时只带 message）
    expect(first.status.message.metadata.tool).toBe('echo')
    expect(first.status.message.metadata.options).toContain('allow')
    expect(first.status.message.parts[0].text).toContain('需要授权')
    expect(calls.echo).toBe(0)

    // 答复（同一 taskId，新 messageId）
    const second = taskOf(
      await send(server, 'allow', { contextId: first.contextId, taskId: first.id, messageId: 'm2' }),
    )
    expect(second.status.state).toBe('TASK_STATE_COMPLETED')
    expect(calls.echo).toBe(1)
    // 续接后拿到最终 artifact
    const text = second.artifacts.at(-1).parts.map((p: any) => p.text ?? '').join('')
    expect(text).toBe('工具说 ok')
  })

  it('deny 答复 ⇒ 工具不执行，任务仍 COMPLETED', async () => {
    const { server, calls } = await makeServer({ mock: toolThenText('go', '工具说 ok'), permissionMode: 'ask' })
    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    const second = taskOf(
      await send(server, 'deny', { contextId: first.contextId, taskId: first.id, messageId: 'm2' }),
    )
    expect(second.status.state).toBe('TASK_STATE_COMPLETED')
    expect(calls.echo).toBe(0)
  })

  // A2A / VSCode 宿主的审计落盘接入：远程权限点经挂起桥问到人之后，人工决策要落
  // `{dataDir}/sessions/{id}.audit.jsonl`。这条用例同时钉住两件事：
  //   ① 权限询问在 A2A 路径下**带 sessionId**（`ToolPipeline` 从 `ctx.sessionId` 填入），
  //      否则 `createAuditSink` 的"无 sessionId 即丢弃"会让审计静默残缺；
  //   ② 落盘的文件名/内容与 CLI 路径一致（同一份 `createAuditSink`）。
  it('人工答复落 audit.jsonl（会话归属正确、零内容 + stateHash）', async () => {
    const { server, dataDir } = await makeServer({
      mock: toolThenText('go', '工具说 ok'),
      permissionMode: 'ask',
      audit: true,
    })
    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED')
    const second = taskOf(
      await send(server, 'allow', { contextId: first.contextId, taskId: first.id, messageId: 'm2' }),
    )
    expect(second.status.state).toBe('TASK_STATE_COMPLETED')

    const file = join(dataDir, 'sessions', 'c1.audit.jsonl')
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const evt = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(evt.schema).toBe('harness.audit.v1')
    expect(evt.kind).toBe('decision.human')
    expect(evt.sessionId).toBe('c1')
    expect(evt.tool).toBe('echo')
    expect(evt.actionTaken).toBe('allow')
    expect(evt.rememberScope).toBe('once')
    // 零内容：入参原文（'go'）只以 stateHash 形式体现，不落明文
    expect(typeof evt.stateHash).toBe('string')
    expect(lines[0]).not.toContain('"input"')
  })

  it('未装审计 sink 时不产生 audit 文件（缺省无审计，不误建空文件）', async () => {
    const { server, dataDir } = await makeServer({ mock: toolThenText('go', 'ok'), permissionMode: 'ask' })
    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    await send(server, 'allow', { contextId: first.contextId, taskId: first.id, messageId: 'm2' })
    expect(existsSync(join(dataDir, 'sessions', 'c1.audit.jsonl'))).toBe(false)
  })

  // P0-9 / §8 D2：A2A 宿主**必须**把"调用方是谁"接进权限归属，否则本机 `always-allow`
  // 会被同一 dataDir 的远程 A2A 调用方继承。这条用例走完整 HTTP：答复 `a`（always-allow）
  // ⇒ 读 `permissions.json` 断言写回键是 `caller:<hash>|echo`（不是裸 `echo`）。
  it('★always-allow 写回带归属键（A2A 装了 caller resolver：caller:<hash>|echo，无明文）', async () => {
    const { server, dataDir } = await makeServer({ mock: toolThenText('go', '工具说 ok'), permissionMode: 'ask' })
    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED')
    // 'a' ⇒ parsePermissionAnswer ⇒ always-allow ⇒ 写回
    const second = taskOf(await send(server, 'a', { contextId: first.contextId, taskId: first.id, messageId: 'm2' }))
    expect(second.status.state).toBe('TASK_STATE_COMPLETED')

    const { rules } = JSON.parse(readFileSync(join(dataDir, 'permissions.json'), 'utf8')) as {
      rules: Record<string, unknown>
    }
    // 无 token ⇒ 匿名调用方 = LOCAL_CALLER，规则键是它的**哈希**（落盘不留明文）
    const key = `caller:${hashPrincipal(LOCAL_CALLER)}|echo`
    expect(rules[key]).toEqual({ allow: ['go'] })
    expect(Object.keys(rules)).not.toContain('echo')
  })

  // P1-9 / §8 D5：控制面 `harness/permission.set` 是**进程级**规则写盘，没有会话上下文
  // ⇒ 审计落工作区级 `{dataDir}/audit.jsonl`（不是 sessions/ 下），source=control-api。
  it('控制面 harness/permission.set 落 permission.rule.changed 审计（工作区级、零内容）', async () => {
    const { server, dataDir } = await makeServer({ audit: true })
    const res = await control(server, 'harness/permission.set', { key: 'bash', behavior: 'deny' })
    expect(res.status).toBe(200)

    const file = join(dataDir, 'audit.jsonl')
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const evt = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(evt.schema).toBe('harness.audit.v1')
    expect(evt.kind).toBe('permission.rule.changed')
    expect(evt.source).toBe('control-api')
    expect(evt.key).toBe('bash')
    expect(evt.behavior).toBe('deny')
    expect(evt.stateHash).toMatch(/^[0-9a-f]{64}$/)
    // 零内容：不含规则原文/入参
    expect(lines[0]).not.toContain('"input"')
    // 进程级事件不落会话目录
    expect(existsSync(join(dataDir, 'sessions'))).toBe(false)
  })

  // 回归（真机踩过，2026-10-09）：**流式**续接同样必须成立。
  //
  // 上面两个用例都走非流式 `SendMessage`，而它恰好绕过 SDK 的一条硬要求 ——
  // `ResultManager` 要求**每个响应的首事件是 `task` / `message``**。续接轮真正产出事件的是
  // 第一轮那次 in-flight 的生成器（挂在旧 bus 上），新 bus 一个事件都不发时，跨 bus 流进来的
  // 第一个 `statusUpdate` 会被判 "Received statusUpdate before initial 'Message'/'Task' event"
  // （-32004）⇒ 整条续接被拒、任务永远停在 `INPUT_REQUIRED`，且它仍算"活跃任务"
  // ⇒ 该 `contextId` 之后的每条消息都被 `ConcurrentTaskError` 拒（VSCode 侧表现：
  // 授权后弹 `-32004`，此后整个会话发什么都报错）。
  it('【回归】流式续接（SendStreamingMessage）：首事件是 task，且续到 COMPLETED', async () => {
    const { server, calls } = await makeServer({ mock: toolThenText('go', '工具说 ok'), permissionMode: 'ask' })

    const first = await streamSend(server, 'go', { contextId: 'c-stream', messageId: 'ms1' })
    const stateOf = (e: any) =>
      e?.result?.task?.status?.state ?? e?.result?.statusUpdate?.status?.state
    const firstTaskId = first.events[0]?.result?.task?.id as string
    expect(firstTaskId).toBeTruthy()
    expect(first.events.map(stateOf).at(-1)).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(calls.echo).toBe(0)

    const second = await streamSend(server, 'allow', {
      contextId: 'c-stream',
      taskId: firstTaskId,
      messageId: 'ms2',
    })

    // ① 不是"200 + application/json 的预流错误信封"（旧缺陷的形态）
    expect(second.res.headers.get('content-type')).toContain('text/event-stream')
    expect(second.events[0]?.error).toBeUndefined()
    // ② ★ 首事件是 task —— 少了它，SDK 会对后续 statusUpdate 抛 -32004
    expect(second.events[0]?.result?.task?.id).toBe(firstTaskId)
    // ③ 真的续到终态，且工具已被放行执行、产物取回
    expect(second.events.map(stateOf).at(-1)).toBe('TASK_STATE_COMPLETED')
    expect(calls.echo).toBe(1)
    const text = second.events
      .map((e: any) =>
        (e?.result?.artifactUpdate?.artifact?.parts ?? []).map((p: any) => p.text ?? '').join(''),
      )
      .join('')
    expect(text).toContain('工具说 ok')
  })
})

// ========================================================================
// 并发 / 幂等 / 隔离
// ========================================================================

describe('A2aServer：并发与幂等', () => {
  it('同 contextId 并行第二条 ⇒ 结构化拒绝 CONCURRENT_TASK（不排队）', async () => {
    // 两个关键词 ⇒ 两条互不干扰的"调工具"任务（`once` 是 provider 实例级状态）
    const { server } = await makeServer({ mock: toolRules(['go1', 'go2'], 'x'), permissionMode: 'ask' })
    // 第一条挂在 INPUT_REQUIRED（= 活跃任务）
    const first = taskOf(await send(server, 'go1', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED')

    // 同一会话、另一条消息（不同 messageId、不带 taskId）⇒ 拒绝
    const second = await send(server, 'go1', { contextId: 'c1', messageId: 'm2' })
    expect(second.body.error.data.a2aCode).toBe('CONCURRENT_TASK')
    expect(second.body.error.data.activeTaskId).toBe(first.id)

    // 别的会话不受影响
    const other = await send(server, 'go2', { contextId: 'c-other', messageId: 'm3' })
    expect(other.body.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED')
  })

  // 行为修正（外部验收查出）：原先这里断言"回放快照且不报错"，但协议要求给**终态任务**
  // 发消息必须报错（官方 a2a-tck CORE-SEND-002 / CORE-MULTI-006，都是 MUST）。
  // 静默回放会把"用错 taskId"掩盖成成功。**不重复执行**这条保证不变（工具调用数仍为 1）。
  it('迟到 / 重复的答复 ⇒ 任务已终态，结构化拒绝且不重复执行', async () => {
    const { server, calls } = await makeServer({ mock: toolThenText('go', '工具说 ok'), permissionMode: 'ask' })
    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED')

    // 正常答复一次 → 已唤醒 → 续接请求拿到终态
    const done = taskOf(
      await send(server, 'allow', { contextId: first.contextId, taskId: first.id, messageId: 'm2' }),
    )
    expect(done.status.state).toBe('TASK_STATE_COMPLETED')
    expect(calls.echo).toBe(1)

    // 再答一次（同一 taskId、新 messageId）：挂起表里已无该 task，任务已终态 ⇒ 拒绝
    const late = await send(server, 'allow', { contextId: first.contextId, taskId: first.id, messageId: 'm3' })
    expect(late.body.error.data.a2aCode).toBe('TASK_TERMINAL')
    expect(calls.echo).toBe(1)
  })

  // 协议 MUST（官方 a2a-tck CORE-SEND-002）
  it('给终态任务发消息 ⇒ TASK_TERMINAL（不是静默回放旧快照）', async () => {
    const { server } = await makeServer({ mock: { defaultResponse: '完事' } })
    const first = taskOf(await send(server, 'hi', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_COMPLETED')

    const again = await send(server, 'follow up', { contextId: 'c1', taskId: first.id, messageId: 'm2' })
    expect(again.body.error.code).toBe(-32004)
    expect(again.body.error.data.a2aCode).toBe('TASK_TERMINAL')
    expect(again.body.result).toBeUndefined()
  })

  // 协议 MUST（官方 a2a-tck CORE-MULTI-006）
  it('taskId 与 contextId 不匹配 ⇒ CONTEXT_TASK_MISMATCH（不放行写进去）', async () => {
    const { server } = await makeServer({ mock: { defaultResponse: '完事' } })
    const first = taskOf(await send(server, 'hi', { contextId: 'c-real', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_COMPLETED')

    const bad = await send(server, 'x', { contextId: 'c-wrong', taskId: first.id, messageId: 'm2' })
    expect(bad.body.error.code).toBe(-32602)
    expect(bad.body.error.data.a2aCode).toBe('CONTEXT_TASK_MISMATCH')
  })

  // 反面保险：**中断态不是终态** —— 挂起中的任务必须仍然可续接（判成终态会把续接挡死）
  it('INPUT_REQUIRED（中断态）不算终态 ⇒ 续接照常放行', async () => {
    const { server } = await makeServer({ mock: toolThenText('go', 'ok'), permissionMode: 'ask' })
    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED')

    const resumed = taskOf(
      await send(server, 'allow', { contextId: 'c1', taskId: first.id, messageId: 'm2' }),
    )
    expect(resumed.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('重复 messageId ⇒ 回放任务快照，**不重复执行**', async () => {
    const { server, calls } = await makeServer({
      mock: toolThenText('go', 'done'),
      permissionMode: 'allow-all',
    })
    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_COMPLETED')
    expect(calls.echo).toBe(1)

    // 同一 messageId 再发 ⇒ 回放（GetTask 快照），工具不再执行
    const again = await send(server, 'go', { contextId: 'c1', messageId: 'm1' })
    expect(taskOf(again).id).toBe(first.id)
    expect(taskOf(again).status.state).toBe('TASK_STATE_COMPLETED')
    expect(calls.echo).toBe(1)

    // 回放的**出参形态**必须是 SendMessageResponse（`{task}`），不能把 GetTask 的裸 Task 透传。
    // 反例：`result` 直接是 Task 字段 ⇒ 对端按 SendMessageResponse 校验报
    // "additional properties are not allowed"（官方 a2a-tck CORE-EXECUTION-MODE-001/002 即此）。
    const raw = (again.body as { result?: Record<string, unknown> }).result!
    expect(Object.keys(raw)).toEqual(['task'])
    expect((raw['task'] as { id?: string }).id).toBe(first.id)
  })

  it('流式回放的 SSE 帧同样是 StreamResponse（`{task}`），不是裸 Task', async () => {
    const { server } = await makeServer({ mock: { defaultResponse: '流式回放' } })
    const first = await streamSend(server, 'go', { contextId: 'c-sl', messageId: 'ms1' })
    const firstTaskId = first.events[0].result.task.id as string
    expect(first.events.at(-1).result.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED')

    // 同一 messageId 再发流式 ⇒ 回放
    const replay = await streamSend(server, 'go', { contextId: 'c-sl', messageId: 'ms1' })
    expect(replay.events).toHaveLength(1)
    const result = replay.events[0].result
    expect(Object.keys(result)).toEqual(['task'])
    expect(result.task.id).toBe(firstTaskId)
  })

  // 回归：SDK 的流是**惰性**的（`resubscribe` / `sendMessageStream` 返回生成器），
  // 参数或任务不合法时异常要到第一次 `next()` 才抛。不在提交 SSE 响应**之前**预热首值，
  // 异常就会落进 SSE 写出逻辑 ⇒ 客户端只收到 **200 空体**，错误被吞掉
  // （官方 a2a-tck STREAM-SUB-004 正是这么判失败的）。
  it('订阅不存在的任务 ⇒ 普通 JSON-RPC error（不是 200 空体 / 空 SSE）', async () => {
    const { server } = await makeServer({})
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [A2A_VERSION_HEADER]: '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-sub',
        method: 'SubscribeToTask',
        params: { id: 'no-such-task' },
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).not.toContain('text/event-stream')
    const body = (await res.json()) as { error?: { code?: number } }
    expect(body.error?.code).toBe(-32001)
  })

  it('并发上限生效 ⇒ TOO_MANY_TASKS', async () => {
    const { server } = await makeServer({
      mock: toolThenText('go', 'x'),
      permissionMode: 'ask',
      maxConcurrentTasks: 1,
    })
    const first = taskOf(await send(server, 'go', { contextId: 'c1', messageId: 'm1' }))
    expect(first.status.state).toBe('TASK_STATE_INPUT_REQUIRED')
    const second = await send(server, 'go', { contextId: 'c2', messageId: 'm2' })
    expect(second.body.error.data.a2aCode).toBe('TOO_MANY_TASKS')
  })

  it('缺 messageId ⇒ 拒绝（幂等键必填）', async () => {
    const { server } = await makeServer({})
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [A2A_VERSION_HEADER]: '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'r',
        method: 'SendMessage',
        params: { message: { contextId: 'c1', role: 'ROLE_USER', parts: [{ text: 'hi' }] } },
      }),
    })
    const body = await res.json()
    expect(body.error.data.a2aCode).toBe('BAD_REQUEST')
  })
})

describe('A2aServer：调用方隔离（CallerRegistry）', () => {
  it('contextId 首次使用即绑定调用方，别的调用方再用即拒绝', () => {
    const reg = new CallerRegistry()
    expect(reg.claim('ctx-1', 'alice')).toBe(true)
    expect(reg.claim('ctx-1', 'alice')).toBe(true) // 同一调用方重复使用 OK
    expect(reg.claim('ctx-1', 'bob')).toBe(false) // 别的调用方拒绝
    expect(reg.ownerOf('ctx-1')).toBe('alice')
    // 空 contextId（服务端自动生成）无从绑定，不构成风险
    expect(reg.claim('', 'bob')).toBe(true)
  })
})

// ========================================================================
// 控制面（P2-A）：POST /harness/rpc
//
// 这里只测**属于 HTTP 层**的四件事：路由可达、鉴权（同一 Bearer）、方法与状态码、
// 以及与协议面**互不串线**。方法本身的参数校验与 host 调用次序在 control.test.ts 里
// 直接打 `dispatchControl`（控制面没有 SSE，没有必须走网线的理由）。
// ========================================================================

function controlUrlOf(server: A2aServer, path = server.controlPath): string {
  return `${new URL(server.url).origin}${path}`
}

async function control(
  server: A2aServer,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
): Promise<RpcResult> {
  const res = await fetch(controlUrlOf(server), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'ctl-1', method, params }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

describe('A2aServer：控制面（/harness/rpc）', () => {
  it('端点暴露且可达；**不需要 A2A-Version 头**（它不是 A2A，故不做版本校验）', async () => {
    const { server } = await makeServer({})
    expect(server.controlPath).toBe('/harness/rpc')
    expect(server.controlUrl).toBe(controlUrlOf(server))
    const res = await control(server, 'harness/notice.list')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.result.notices)).toBe(true)
    expect(res.body.error).toBeUndefined()
  })

  it('容忍尾斜杠（与 /a2a 同一理由：客户端会把 base_url 规范成带尾斜杠）', async () => {
    const { server } = await makeServer({})
    const res = await fetch(`${controlUrlOf(server)}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'c', method: 'harness/permission.get' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).result.mode).toBe('ask')
  })

  it('与协议面**共用同一个 Bearer**：配了 token 时未带凭据 ⇒ 401', async () => {
    const { server } = await makeServer({ token: 'secret' })
    const denied = await control(server, 'harness/permission.get')
    expect(denied.status).toBe(401)
    expect(denied.body.error.data.a2aCode).toBe('UNAUTHORIZED')
    const allowed = await control(server, 'harness/permission.get', undefined, {
      authorization: 'Bearer secret',
    })
    expect(allowed.status).toBe(200)
    expect(allowed.body.result.mode).toBe('ask')
  })

  it('非 POST ⇒ 405；未知控制方法 ⇒ -32601 + controlCode', async () => {
    const { server } = await makeServer({})
    expect((await fetch(controlUrlOf(server))).status).toBe(405)
    const res = await control(server, 'harness/does-not-exist')
    expect(res.status).toBe(200)
    expect(res.body.error.code).toBe(-32601)
    expect(res.body.error.data.controlCode).toBe('METHOD_NOT_FOUND')
  })

  it('协议面**不认**控制方法：同一方法名打到 /a2a ⇒ MethodNotFound（两条面互不串线）', async () => {
    const { server } = await makeServer({})
    const res = await rpc(server, 'harness/notice.list', {})
    expect(res.body.result).toBeUndefined()
    expect(res.body.error.code).toBe(-32601)
    // 且错误词汇是 A2A 的，不是控制面的 controlCode
    expect(res.body.error.data?.controlCode).toBeUndefined()
  })

  it('控制路径**不进 AgentCard**（不对外承诺一套不打算标准化的 API）', async () => {
    const { server } = await makeServer({ token: 'secret' })
    const card = (await fetch(`${new URL(server.url).origin}/${AGENT_CARD_PATH}`).then((r) => r.json())) as {
      supportedInterfaces: Array<{ url: string }>
    }
    const text = JSON.stringify(card)
    expect(text).not.toContain('/harness')
    expect(text).not.toContain('rpc')
    expect(card.supportedInterfaces[0]?.url).toBe(server.url)
  })
})
