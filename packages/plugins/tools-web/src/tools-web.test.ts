import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  webFetchTool,
  webTools,
  createToolsWebPlugin,
  WebFetchOutput,
} from './index'
import type { ToolContext } from '@harness/tool'

let ctx: ToolContext

beforeEach(() => {
  ctx = {
    cwd: '/tmp',
    sessionId: 's1',
    agentId: 'default',
    messageId: 'm1',
    toolUseId: 'tu1',
    signal: new AbortController().signal,
    variables: {},
    requestPermission: async () => ({ behavior: 'allow' } as any),
  }
})

// Mock fetch helper
type FetchMock = (args: { url: string; init: RequestInit }) => Promise<Response>
function installMock(mock: FetchMock) {
  const prev = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string, init: RequestInit) => mock({ url, init })
  return () => { (globalThis as any).fetch = prev }
}

function blob(data: string | Uint8Array, headers?: Record<string, string>): Response {
  return new Response(typeof data === 'string' ? data : new Uint8Array(data), {
    status: 200,
    headers: { 'Content-Type': 'text/plain', ...headers },
  })
}

describe('webFetchTool', () => {
  it('默认 GET，返回 text 格式', async () => {
    const restore = installMock(async () => blob('hello world'))
    try {
      const res = await webFetchTool.call!({ url: 'https://example.com' } as any, ctx)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.output!.status).toBe(200)
      expect(res.output!.body).toBe('hello world')
      expect(res.output!.bytes).toBe(11)
    } finally { restore() }
  })

  it('POST 方法 + 对象 body 自动 JSON 序列化，application/json', async () => {
    let captured: { method?: string; body?: any; ct?: string } = {}
    const restore = installMock(async ({ init }) => {
      captured.method = init.method
      captured.body = init.body
      captured.ct = (init.headers as any)['Content-Type']
      return blob('{"ok":true}', { 'Content-Type': 'application/json' })
    })
    try {
      const res = await webFetchTool.call!({
        url: 'https://example.com/api',
        method: 'POST',
        body: { a: 1 },
        format: 'json',
      } as any, ctx)
      expect(captured.method).toBe('POST')
      expect(JSON.parse(captured.body)).toEqual({ a: 1 })
      expect(captured.ct).toBe('application/json')
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.output!.body).toEqual({ ok: true })
    } finally { restore() }
  })

  it('json 格式：非 JSON 内容返回 JSON_PARSE_ERROR', async () => {
    const restore = installMock(async () => blob('not json', { 'Content-Type': 'text/plain' }))
    try {
      const res = await webFetchTool.call!({
        url: 'https://example.com',
        format: 'json',
      } as any, ctx)
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.error!.code).toBe('JSON_PARSE_ERROR')
    } finally { restore() }
  })

  it('base64 格式：返回 data:<mime>;base64,...', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47]) // PNG 魔数
    const restore = installMock(async () => new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }))
    try {
      const res = await webFetchTool.call!({
        url: 'https://example.com/img.png',
        format: 'base64',
      } as any, ctx)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      const body = res.output!.body as string
      expect(body.startsWith('data:image/png;base64,')).toBe(true)
      expect(res.output!.bytes).toBe(4)
    } finally { restore() }
  })

  it('URL 无效返回错误', async () => {
    const res = await webFetchTool.call!({ url: 'not-a-url' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('INVALID_URL')
  })

  it('非 http(s) 协议被拒绝', async () => {
    const res = await webFetchTool.call!({ url: 'file:///etc/passwd' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('INVALID_PROTOCOL')
  })

  it('SSRF 防护：默认拦截 localhost / 127.0.0.1 / 192.168.x', async () => {
    const res1 = await webFetchTool.call!({ url: 'http://localhost/api' } as any, ctx)
    expect(res1.ok).toBe(false); if (res1.ok) return
    expect(res1.error!.code).toBe('SSRF_BLOCKED')

    const res2 = await webFetchTool.call!({ url: 'http://10.0.0.1/x' } as any, ctx)
    expect(res2.ok).toBe(false); if (res2.ok) return
    expect(res2.error!.code).toBe('SSRF_BLOCKED')

    const res3 = await webFetchTool.call!({ url: 'http://192.168.1.1/x' } as any, ctx)
    expect(res3.ok).toBe(false); if (res3.ok) return
    expect(res3.error!.code).toBe('SSRF_BLOCKED')
  })

  it('allowPrivateNetwork=true 允许访问私有网络', async () => {
    const restore = installMock(async () => blob('local'))
    try {
      const res = await webFetchTool.call!({
        url: 'http://localhost/api',
        allowPrivateNetwork: true,
      } as any, ctx)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.output!.body).toBe('local')
    } finally { restore() }
  })

  it('maxResponseBytes 截断响应', async () => {
    const data = 'x'.repeat(1000)
    const restore = installMock(async () => blob(data))
    try {
      const res = await webFetchTool.call!({
        url: 'https://example.com/big',
        maxResponseBytes: 50,
      } as any, ctx)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.output!.truncated).toBe(true)
      expect(res.output!.bytes).toBe(50)
      expect((res.output!.body as string).length).toBe(50)
    } finally { restore() }
  })

  it('非 2xx 也正常返回状态（非异常）', async () => {
    const restore = installMock(async () => new Response('not found', { status: 404, statusText: 'Not Found' }))
    try {
      const res = await webFetchTool.call!({ url: 'https://example.com/404' } as any, ctx)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.output!.status).toBe(404)
      expect(res.output!.statusText).toBe('Not Found')
    } finally { restore() }
  })

  it('AbortSignal（已提前 abort 的）取消请求返回 ABORTED', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already aborted'))
    const c2: ToolContext = { ...ctx, signal: controller.signal }
    // 正常返回 mock；tool 内部在 fetch 之前同步检查 aborted 并传入 signal
    const restore = installMock(async () => blob('never reach'))
    try {
      const res = await webFetchTool.call!({ url: 'https://example.com', timeoutMs: 5000 } as any, c2)
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.error!.code).toBe('ABORTED')
    } finally { restore() }
  })

  it('timeoutMs 触发超时 → ABORTED', async () => {
    // mock 挂起直到 signal abort 触发，reject AbortError
    const restore = installMock(async ({ init }) => new Promise<Response>((_, reject) => {
      const sig = (init as any).signal as AbortSignal
      if (sig?.aborted) { reject(sig.reason ?? new Error('aborted')); return }
      const onAbort = () => reject(sig.reason ?? new DOMException('abort', 'AbortError'))
      sig?.addEventListener('abort', onAbort, { once: true })
    }))
    try {
      const res = await webFetchTool.call!({
        url: 'https://example.com',
        timeoutMs: 30,
      } as any, ctx)
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.error!.code).toBe('ABORTED')
      expect(res.error!.message).toContain('超时')
    } finally { restore() }
  })
})

describe('插件集成', () => {
  it('webTools 导出包含 web_fetch', () => {
    expect(webTools.map((t) => t.id)).toEqual(['web_fetch'])
  })
  it('createToolsWebPlugin id', () => {
    expect(createToolsWebPlugin().id).toBe('tools.web')
  })
})
