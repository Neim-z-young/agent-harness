/**
 * 案 A 传输用例：用假 fetch 验证"发出去的对不对、收进来的解析得对不对"。
 *
 * 不起真进程 —— 真 sidecar 的端到端在 `e2e.test.ts`。
 */

import { describe, expect, it } from 'bun:test'
import { mapA2aEvent } from '../map/render'
import type { Sidecar } from '../sidecar'
import type { SidecarHandshake } from '../types'
import { A2aTransport, TransportError, type FetchLike } from './a2a'

const HS: SidecarHandshake = {
  v: 1,
  pid: 1,
  port: 65184,
  protocolVersion: '1.0',
  rpcUrl: 'http://127.0.0.1:65184/a2a',
  cardUrl: 'http://127.0.0.1:65184/.well-known/agent-card.json',
  controlUrl: 'http://127.0.0.1:65184/harness/rpc',
  auth: 'anonymous',
  permissionMode: 'ask',
  cwd: '/repo',
}

function fakeSidecar(hs: SidecarHandshake = HS): Sidecar {
  return {
    endpoint: hs,
    started: true,
    start: async () => hs,
    dispose: async () => {},
  } as unknown as Sidecar
}

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const TASK = 'data: {"jsonrpc":"2.0","id":2,"result":{"task":{"id":"t1","contextId":"c1","status":{"state":"TASK_STATE_SUBMITTED"}}}}\n\n'
const DONE = 'data: {"jsonrpc":"2.0","id":2,"result":{"statusUpdate":{"taskId":"t1","status":{"state":"TASK_STATE_COMPLETED"}}}}\n\n'

interface Call {
  url: string
  init: RequestInit
}

/** 记录每次调用并按序返回预设响应 */
function recordingFetch(handler: (url: string, body: unknown) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    return handler(String(url), body)
  }) as unknown as FetchLike
  return { fetch, calls }
}

describe('A2aTransport.send', () => {
  it('**必须**带 A2A-Version 头 —— 缺头会被服务端按 0.3 校验拒掉（实测 -32009）', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse([TASK, DONE]))
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    for await (const _ of t.send({}, 'hi', new AbortController().signal)) {
      /* 消费完 */
    }

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['A2A-Version']).toBe('1.0')
  })

  it('方法名与参数形态符合 A2A v1.0', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse([TASK]))
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    for await (const _ of t.send({ contextId: 'c1', taskId: 't1' }, 'hi', new AbortController().signal)) {
      /* 消费完 */
    }

    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.method).toBe('SendStreamingMessage')
    expect(body.params.message.kind).toBe('message')
    expect(body.params.message.role).toBe('user')
    expect(body.params.message.contextId).toBe('c1')
    expect(body.params.message.taskId).toBe('t1')
  })

  it('每次发送的 messageId 都不同 —— 它是服务端的幂等键', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse([TASK]))
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })
    const sig = new AbortController().signal

    for await (const _ of t.send({}, 'a', sig)) break
    for await (const _ of t.send({}, 'b', sig)) break

    const a = JSON.parse(calls[0]!.init.body as string).params.message.messageId
    const b = JSON.parse(calls[1]!.init.body as string).params.message.messageId
    expect(a).not.toBe(b)
  })

  it('SSE 帧被解析成对象序列（且顺序保持）', async () => {
    const { fetch } = recordingFetch(() => sseResponse([TASK, DONE]))
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    const got: unknown[] = []
    for await (const f of t.send({}, 'hi', new AbortController().signal)) got.push(f)

    expect(got).toHaveLength(2)
    expect((got[0] as { result: { task: { id: string } } }).result.task.id).toBe('t1')
    expect((got[1] as { result: { statusUpdate: { status: { state: string } } } }).result.statusUpdate.status.state).toBe(
      'TASK_STATE_COMPLETED',
    )
  })

  it('HTTP 非 2xx ⇒ TransportError（不尝试 json() 掩盖真因）', async () => {
    const { fetch } = recordingFetch(
      () => new Response('not found', { status: 404 }),
    )
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    let thrown: unknown
    try {
      for await (const _ of t.send({}, 'hi', new AbortController().signal)) break
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(TransportError)
    expect((thrown as TransportError).code).toBe(404)
  })

  it('★ 预流错误（HTTP 200 + application/json）必须被分流成 1 帧，不能吞成 0 帧', async () => {
    // 回归（真机 2026-10-09，见 docs/vscode-chat-sessions-spike.md §5c）：
    // A2A 的预流错误走 `serverErrorResponse` → `Response.json(...)`，即 **HTTP 200 +
    // application/json**。旧实现只看 `res.ok`，之后无条件按 SSE 解帧 ⇒ `SseDecoder` 解出
    // **0 帧** ⇒ 调用方的 for-await 一次循环体都不进 ⇒ 表现为"这一轮正常结束、但什么都没有"。
    // 判据只能是 content-type —— 这里的 HTTP 状态码就是 200。
    const { fetch } = recordingFetch(
      () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32004, message: 'Task is terminal' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    const got: unknown[] = []
    for await (const f of t.send({ contextId: 'c1', taskId: 't1' }, 'hi', new AbortController().signal)) got.push(f)

    expect(got).toHaveLength(1)
    // 原样吐出信封，由 mapA2aEvent 翻成 error 算子（错误渲染只有一处定义）
    expect(mapA2aEvent(got[0])).toMatchObject({ kind: 'error', code: -32004 })
  })

  it('既非 SSE 也非 JSON ⇒ TransportError（带上 content-type 便于归因）', async () => {
    const { fetch } = recordingFetch(
      () => new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    let thrown: unknown
    try {
      for await (const _ of t.send({}, 'hi', new AbortController().signal)) break
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(TransportError)
    expect((thrown as Error).message).toContain('text/html')
  })

  it('配了 token ⇒ 带 Bearer', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse([TASK]))
    const t = new A2aTransport({ sidecar: fakeSidecar(), token: 'secret', fetchImpl: fetch })
    for await (const _ of t.send({}, 'hi', new AbortController().signal)) break
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer secret')
  })
})

describe('A2aTransport.cancel', () => {
  it('走 CancelTask，id 在 params.id', async () => {
    const { fetch, calls } = recordingFetch(() => Response.json({ jsonrpc: '2.0', id: 1, result: { id: 't1' } }))
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    await t.cancel('t1')

    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.method).toBe('CancelTask')
    expect(body.params).toEqual({ id: 't1' })
    expect(String(calls[0]!.url)).toBe(HS.rpcUrl)
  })

  it('协议错误 ⇒ 抛 TransportError，带上服务端给的 code', async () => {
    const { fetch } = recordingFetch(() =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32004, message: 'Task is terminal' } }),
    )
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    await expect(t.cancel('t1')).rejects.toThrow(/terminal/)
  })
})

describe('A2aTransport.listTasks', () => {
  it('走 /a2a 的 ListTasks —— 协议里有的方法不许搬进控制面（设计稿 §12.2）', async () => {
    const { fetch, calls } = recordingFetch(() =>
      Response.json({ jsonrpc: '2.0', id: 1, result: { tasks: [{ id: 't1', status: { state: 'TASK_STATE_WORKING' } }] } }),
    )
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    const r = await t.listTasks()

    expect(String(calls[0]!.url)).toBe(HS.rpcUrl)
    expect(JSON.parse(calls[0]!.init.body as string).method).toBe('ListTasks')
    expect(r).toEqual({ tasks: [{ id: 't1', status: { state: 'TASK_STATE_WORKING' } }] })
  })

  it('服务端不认识 ListTasks ⇒ 抛错（由调用方按分区降级，不静默）', async () => {
    const { fetch } = recordingFetch(() =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
    )
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    let thrown: unknown
    try {
      await t.listTasks()
    } catch (e) {
      thrown = e
    }
    expect((thrown as TransportError).code).toBe(-32601)
  })
})

describe('A2aTransport.control', () => {
  it('打向 controlUrl，不是 rpcUrl —— 控制面与协议面不共享路径', async () => {
    const { fetch, calls } = recordingFetch(() =>
      Response.json({ jsonrpc: '2.0', id: 1, result: { notices: [], total: 0 } }),
    )
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    const r = await t.control('harness/notice.list')

    expect(String(calls[0]!.url)).toBe(HS.controlUrl)
    expect(r).toEqual({ notices: [], total: 0 })
  })

  it('控制面的错误码是独立一套（原样透出，不翻译成 A2A 码）', async () => {
    const { fetch } = recordingFetch(() =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32099, message: '未知控制方法' } }),
    )
    const t = new A2aTransport({ sidecar: fakeSidecar(), fetchImpl: fetch })

    let thrown: unknown
    try {
      await t.control('harness/nope')
    } catch (e) {
      thrown = e
    }
    expect((thrown as TransportError).code).toBe(-32099)
  })
})
