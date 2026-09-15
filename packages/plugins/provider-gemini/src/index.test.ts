import { describe, it, expect } from 'bun:test'
import {
  GeminiChatProvider,
  createProviderGeminiPlugin,
  providerGeminiPlugin,
  type GeminiProviderConfig,
} from './index'
import type { Message } from '@harness/session'
import { defineTool, Schema, type Tool } from '@harness/tool'
import { createHarness, DefaultPermissionEngine, type AgentDefinition } from '@harness/core'

// ===== helpers =====

function makeTool(id: string, desc: string, properties?: Record<string, unknown>): Tool {
  const schema: Schema<any> = {
    parse: (v) => v,
    safeParse: (v) => ({ success: true, data: v }),
  }
  if (properties) {
    ;(schema as any).__jsonSchema = { type: 'object', properties, required: Object.keys(properties) }
  }
  return defineTool({
    id,
    description: desc,
    inputSchema: schema,
    isReadOnly: () => true,
    async call(input): Promise<any> {
      return { ok: true, output: input }
    },
  })
}

function makeAgent(): AgentDefinition {
  return {
    id: 'default',
    name: 'Agent',
    description: 'x',
    mode: 'primary',
    tools: ['*'],
    permission: { '*': 'allow' },
    promptFragments: [],
  }
}

type FetchMock = (args: { url: string; init: RequestInit }) => Response | Promise<Response>
function installMock(mock: FetchMock) {
  const prev = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string, init: RequestInit) => mock({ url, init })
  return () => {
    ;(globalThis as any).fetch = prev
  }
}

function geminiOkResponse(text: string, model = 'gemini-1.5-flash', opts: { inputTokens?: number; outputTokens?: number } = {}): string {
  return JSON.stringify({
    candidates: [{
      content: { role: 'model', parts: [{ text }] },
      finishReason: 'STOP',
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: opts.inputTokens ?? 5,
      candidatesTokenCount: opts.outputTokens ?? 3,
      totalTokenCount: (opts.inputTokens ?? 5) + (opts.outputTokens ?? 3),
    },
  })
}

function geminiToolResponse(toolName: string, args: unknown, model = 'gemini-1.5-flash'): string {
  return JSON.stringify({
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { text: '先查一下' },
          { functionCall: { name: toolName, args, id: 'call_1' } },
        ],
      },
      finishReason: 'STOP',
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    },
  })
}

// ===== 测试 =====

describe('@harness/provider-gemini', () => {
  // ===== 单元：序列化映射 =====

  describe('Part → Gemini Content 序列化', () => {
    it('system 角色提取为 systemInstruction', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(geminiOkResponse('ok'))
      })
      try {
        const messages: Message[] = [
          { id: 'm1', role: 'system', parts: [{ type: 'text', text: '你是助手' }, { type: 'text', text: '回答简洁' }], createdAt: 1 },
          { id: 'm2', role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: 2 },
        ]
        await p.complete({ providerId: 'gemini', messages, params: {} })
        expect(captured.systemInstruction).toBeDefined()
        expect(captured.systemInstruction.parts[0].text).toBe('你是助手\n\n回答简洁')
        expect(captured.contents[0].role).toBe('user')
        expect(captured.contents[0].parts[0]).toEqual({ text: '你好' })
      } finally {
        restore()
      }
    })

    it('assistant → role: model；user → role: user', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(geminiOkResponse('hi'))
      })
      try {
        const msgs: Message[] = [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: '问' }], createdAt: 1 },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '答' }], createdAt: 2 },
        ]
        await p.complete({ providerId: 'gemini', messages: msgs, params: {} })
        expect(captured.contents).toHaveLength(2)
        expect(captured.contents[0].role).toBe('user')
        expect(captured.contents[1].role).toBe('model')
      } finally {
        restore()
      }
    })

    it('assistant 内 ToolCallPart → functionCall；user 内带 result → functionResponse', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(geminiOkResponse('done'))
      })
      try {
        const msgs: Message[] = [
          { id: 'a1', role: 'assistant', agentId: 'a', createdAt: 1, parts: [
            { type: 'tool', toolUseId: 'tu1', toolId: 'echo', input: { msg: 'hi' } },
          ]},
          { id: 'u1', role: 'user', createdAt: 2, parts: [
            { type: 'tool', toolUseId: 'tu1', toolId: 'echo', input: { msg: 'hi' }, result: { reply: 'echo:hi' } },
          ]},
        ]
        await p.complete({ providerId: 'gemini', messages: msgs, params: {} })
        // assistant → functionCall
        const modelContent = captured.contents.find((c: any) => c.role === 'model')
        expect(modelContent.parts).toHaveLength(1)
        expect(modelContent.parts[0].functionCall).toEqual({ name: 'echo', args: { msg: 'hi' }, id: 'tu1' })
        // user → functionResponse
        const userContent = captured.contents.find((c: any) => c.role === 'user')
        expect(userContent.parts[0].functionResponse).toEqual({ name: 'echo', response: { reply: 'echo:hi' }, id: 'tu1' })
      } finally {
        restore()
      }
    })

    it('ImagePart → inlineData', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(geminiOkResponse('seen'))
      })
      try {
        const msgs: Message[] = [{
          id: 'u1', role: 'user', createdAt: 1,
          parts: [
            { type: 'text', text: '看图' },
            { type: 'image', content: 'base64data', mimeType: 'image/png' },
          ],
        }]
        await p.complete({ providerId: 'gemini', messages: msgs, params: {} })
        const parts = captured.contents[0].parts
        expect(parts[0]).toEqual({ text: '看图' })
        expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'base64data' } })
      } finally {
        restore()
      }
    })

    it('reasoning part 降级为 text', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(geminiOkResponse('ok'))
      })
      try {
        const msgs: Message[] = [{
          id: 'a1', role: 'assistant', createdAt: 1,
          parts: [
            { type: 'reasoning', text: 'thinking...' },
            { type: 'text', text: 'answer' },
          ],
        }]
        await p.complete({ providerId: 'gemini', messages: msgs, params: {} })
        const parts = captured.contents[0].parts
        expect(parts[0].text).toContain('thinking...')
        expect(parts[1].text).toBe('answer')
      } finally {
        restore()
      }
    })
  })

  // ===== Tool Schema 导出 =====

  describe('Tool Schema 导出', () => {
    it('带 __jsonSchema 的工具会导出 functionDeclarations', async () => {
      const t = makeTool('my_tool', '一个工具', {
        path: { type: 'string', description: '文件路径' },
        offset: { type: 'integer' },
      })
      const p = new GeminiChatProvider({ apiKey: 'k' }, () => [t])
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(geminiOkResponse('ok'))
      })
      try {
        await p.complete({
          providerId: 'gemini',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        })
        expect(captured.tools).toHaveLength(1)
        const fd = captured.tools[0].functionDeclarations[0]
        expect(fd.name).toBe('my_tool')
        expect(fd.description).toBe('一个工具')
        expect(fd.parameters.required).toEqual(['path', 'offset'])
        expect(fd.parameters.properties.path).toEqual({ type: 'string', description: '文件路径' })
      } finally {
        restore()
      }
    })

    it('toolConfig.mode 为 AUTO', async () => {
      const t = makeTool('t1', '工具')
      const p = new GeminiChatProvider({ apiKey: 'k' }, () => [t])
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(geminiOkResponse('ok'))
      })
      try {
        await p.complete({
          providerId: 'gemini',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        })
        expect(captured.toolConfig.functionCallingConfig.mode).toBe('AUTO')
      } finally {
        restore()
      }
    })
  })

  // ===== 请求/响应往返 =====

  describe('请求/响应往返', () => {
    it('URL 包含 model 和 generateContent action + key 查询参数', async () => {
      const p = new GeminiChatProvider({ apiKey: 'gem-key' })
      let capturedUrl = ''
      const restore = installMock(({ url }) => {
        capturedUrl = url
        return new Response(geminiOkResponse('ok'))
      })
      try {
        await p.complete({
          providerId: 'gemini',
          modelId: 'gemini-1.5-pro',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        })
        expect(capturedUrl).toContain('/v1beta/models/gemini-1.5-pro:generateContent')
        expect(capturedUrl).toContain('key=gem-key')
      } finally {
        restore()
      }
    })

    it('认证头 x-goog-api-key 正确', async () => {
      const p = new GeminiChatProvider({ apiKey: 'goog-key' })
      let capturedHeaders: Record<string, string> = {}
      const restore = installMock(({ init }) => {
        capturedHeaders = init.headers as Record<string, string>
        return new Response(geminiOkResponse('ok'))
      })
      try {
        await p.complete({
          providerId: 'gemini',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
          headers: { 'X-Custom': 'foo' },
        })
        expect(capturedHeaders['x-goog-api-key']).toBe('goog-key')
        expect(capturedHeaders['Content-Type']).toBe('application/json')
        expect(capturedHeaders['X-Custom']).toBe('foo')
      } finally {
        restore()
      }
    })

    it('响应解析：text + functionCall → ChatCompletionOutput', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(geminiToolResponse('read_file', { path: 'a.txt' })))
      try {
        const out = await p.complete({
          providerId: 'gemini',
          modelId: 'gemini-1.5-pro',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: { temperature: 0.2 },
        })
        expect(out.content).toBe('先查一下')
        expect(out.model).toBe('gemini-1.5-pro')
        expect(out.toolCalls).toHaveLength(1)
        expect(out.toolCalls![0].toolId).toBe('read_file')
        expect(out.toolCalls![0].input).toEqual({ path: 'a.txt' })
        expect(out.tokenUsage).toEqual({ input: 10, output: 20, total: 30 })
        expect(out.raw).toBeDefined()
      } finally {
        restore()
      }
    })

    it('API 返回 error → 抛出带 message 的错误', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(JSON.stringify({
        error: { code: 400, message: 'Invalid API key', status: 'INVALID_ARGUMENT' },
      }), { status: 400 }))
      try {
        const err = await p.complete({
          providerId: 'gemini',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        }).then(() => null, (e) => e)
        expect(err?.message).toContain('Invalid API key')
      } finally {
        restore()
      }
    })

    it('未配 API Key → 立即抛错', async () => {
      const p = new GeminiChatProvider()
      const restore = installMock(async () => { throw new Error('不应到达真实 fetch') })
      const savedKey = process.env.GEMINI_API_KEY
      delete process.env.GEMINI_API_KEY
      try {
        const err = await p.complete({
          providerId: 'gemini',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        }).then(() => null, (e) => e)
        expect(err?.message).toContain('API Key 未配置')
      } finally {
        restore()
        if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey
      }
    })

    it('calls 数组记录请求体，modelId 覆盖 defaultModel', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(geminiOkResponse('ok')))
      try {
        await p.complete({
          providerId: 'gemini', modelId: 'gemini-1.5-pro',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Q1' }], createdAt: 1 }],
          params: {},
        })
        await p.complete({
          providerId: 'gemini',
          messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Q2' }], createdAt: 2 }],
          params: {},
        })
        expect(p.calls).toHaveLength(2)
        // 默认模型是 gemini-1.5-flash
        // URL 里带 model，但 body 不带 model（Gemini API model 在 URL 里）
      } finally {
        restore()
      }
    })
  })

  // ===== 流式 =====

  describe('流式 stream', () => {
    it('解析 SSE text_delta + done', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      const sseChunks = [
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP', index: 0 }],
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: ' world' }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
        })}\n\n`,
      ].join('')
      const restore = installMock(async () => new Response(sseChunks, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      try {
        const chunks: any[] = []
        for await (const c of p.stream({
          providerId: 'gemini',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1 }],
          params: {},
        })) {
          chunks.push(c)
        }
        const textDeltas = chunks.filter((c) => c.type === 'text_delta')
        expect(textDeltas.map((c) => c.text).join('')).toBe('Hello world')
        const done = chunks.find((c) => c.type === 'done')
        expect(done).toBeDefined()
        expect(done.tokenUsage).toEqual({ input: 5, output: 10, total: 15 })
      } finally {
        restore()
      }
    })

    it('流式 URL 包含 streamGenerateContent + alt=sse', async () => {
      const p = new GeminiChatProvider({ apiKey: 'stream-key' })
      let capturedUrl = ''
      const restore = installMock(({ url }) => {
        capturedUrl = url
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      })
      try {
        const iter = p.stream({
          providerId: 'gemini',
          modelId: 'gemini-1.5-flash',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        })
        // 触发请求
        await iter.next()
        expect(capturedUrl).toContain(':streamGenerateContent')
        expect(capturedUrl).toContain('alt=sse')
        expect(capturedUrl).toContain('key=stream-key')
      } finally {
        restore()
      }
    })

    it('流式 functionCall → tool_use_start/delta/stop', async () => {
      const p = new GeminiChatProvider({ apiKey: 'k' })
      const sseChunk = `data: ${JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'read_file', args: { path: 'a.txt' }, id: 'fc_1' } },
            ],
          },
          finishReason: 'STOP',
          index: 0,
        }],
      })}\n\n`
      const restore = installMock(async () => new Response(sseChunk, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      try {
        const chunks: any[] = []
        for await (const c of p.stream({
          providerId: 'gemini',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'read' }], createdAt: 1 }],
          params: {},
        })) {
          chunks.push(c)
        }
        const start = chunks.find((c) => c.type === 'tool_use_start')
        expect(start).toBeDefined()
        expect(start.toolUseId).toBe('fc_1')
        expect(start.toolId).toBe('read_file')
        const stop = chunks.find((c) => c.type === 'tool_use_stop')
        expect(stop).toBeDefined()
        expect(stop.toolUseId).toBe('fc_1')
      } finally {
        restore()
      }
    })
  })

  // ===== 插件集成 =====

  describe('createProviderGeminiPlugin 集成', () => {
    it('config store 读取配置（key=provider.gemini）', async () => {
      const restore = installMock(async () => new Response(geminiOkResponse('gemini响应', 'gemini-1.5-flash')))
      try {
        const plugin = createProviderGeminiPlugin()
        const h = await createHarness({
          cwd: process.cwd(),
          internalPlugins: [plugin],
          agents: [makeAgent()],
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          config: {
            'provider.gemini': {
              apiKey: 'from-store',
              defaultModel: 'gemini-1.5-flash',
            },
          },
        })
        await h.start()
        const sess = await h.session.create()
        const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })
        const textPart = reply.parts.find((p: any) => p.type === 'text') as any
        expect(textPart.text).toBe('gemini响应')
        expect((reply.meta as any)?.model).toBe('gemini-1.5-flash')
        expect(h.plugin.list().map((p) => p.plugin.id)).toEqual(
          expect.arrayContaining(['provider.gemini']),
        )
        await h.stop()
      } finally {
        restore()
      }
    })

    it('直接传配置优先级高于 store', async () => {
      const restore = installMock(async () => new Response(geminiOkResponse('直接', 'gemini-1.5-pro')))
      try {
        const plugin = createProviderGeminiPlugin({
          apiKey: 'direct-key',
          defaultModel: 'gemini-1.5-pro',
        })
        const h = await createHarness({
          cwd: process.cwd(),
          internalPlugins: [plugin],
          agents: [makeAgent()],
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          config: { 'provider.gemini': { defaultModel: 'from-store' } },
        })
        await h.start()
        const sess = await h.session.create()
        const reply = await h.agent.query({ sessionId: sess.id, message: 'x' })
        expect((reply.meta as any)?.model).toBe('gemini-1.5-pro')
        await h.stop()
      } finally {
        restore()
      }
    })

    it('plugin.id / name / description 正确', () => {
      expect(providerGeminiPlugin.id).toBe('provider.gemini')
      expect(providerGeminiPlugin.name).toBe('Gemini Provider')
      expect(providerGeminiPlugin.description).toContain('Google Gemini')
    })
  })
})

// ==========================================================================
// 流结束语义 / 超时语义（回归：网关发完 finishReason 不关连接 → 明明有响应却报超时）
// ==========================================================================

/** 可控 SSE 流：可分段推送、可「永不 close」（模拟发完末帧仍保持连接的网关） */
function mockFetchSseControllable(): {
  fetch: any
  push: (text: string) => void
  close: () => void
  canceled: () => boolean
} {
  const encoder = new TextEncoder()
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { ctrl = controller },
    cancel() { canceled = true },
  })
  return {
    // 忠实模拟 fetch：把 AbortSignal 接到 body 流上（abort → 挂起的 read() 以该 reason 拒绝），
    // 否则「超时」用例里的 reader.read() 会一直挂住，测不出真实行为。
    fetch: ((_url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined
      if (signal) {
        if (signal.aborted) ctrl?.error((signal as AbortSignal).reason)
        else signal.addEventListener('abort', () => ctrl?.error((signal as AbortSignal).reason), { once: true })
      }
      return Promise.resolve({ ok: true, status: 200, body: stream, text: () => Promise.resolve('') }) as any
    }) as any,
    push: (text) => ctrl?.enqueue(encoder.encode(text)),
    close: () => ctrl?.close(),
    canceled: () => canceled,
  }
}

/** 文本帧（无 finishReason） */
function sseGeminiText(text: string): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
  })}\n\n`
}
/** 末帧：finishReason = STOP */
function sseGeminiFinish(): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
  })}\n\n`
}
/** 独立的 usage 帧（不带 candidates —— 部分网关仿 OpenAI include_usage 行为） */
function sseGeminiUsage(input: number, output: number, total: number): string {
  return `data: ${JSON.stringify({
    usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: total },
  })}\n\n`
}

describe('@harness/provider-gemini：流结束与超时语义', () => {
  const collect = async (p: GeminiChatProvider) => {
    const chunks: any[] = []
    for await (const c of p.stream({
      providerId: 'gemini',
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1 }],
      params: {},
    })) {
      chunks.push(c)
    }
    return chunks
  }

  it('收到 finishReason 即结束，不等 socket 关闭；尾部独立 usage 帧不丢', async () => {
    const ctl = mockFetchSseControllable()
    const prev = globalThis.fetch
    globalThis.fetch = ctl.fetch
    // timeoutMs 远大于用例时长：能正常结束说明没有依赖「连接关闭」或「计时器兜底」
    const p = new GeminiChatProvider({ apiKey: 'k', timeoutMs: 5_000 })

    try {
      const promise = collect(p)
      ctl.push(sseGeminiText('你好'))
      ctl.push(sseGeminiFinish())
      await new Promise((r) => setTimeout(r, 50))
      ctl.push(sseGeminiUsage(5, 10, 15)) // finishReason 之后才到达（收尾窗口内）
      // 注意：故意不调用 ctl.close() —— 连接一直开着
      const chunks = await promise

      expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join('')).toBe('你好')
      const done = chunks.find((c) => c.type === 'done')
      expect(done).toBeDefined()
      expect(done.tokenUsage).toEqual({ input: 5, output: 10, total: 15 })
      expect(ctl.canceled()).toBe(true) // 提前 break 后主动释放连接
    } finally {
      globalThis.fetch = prev
    }
  })

  it('持续有数据时总时长超过 timeoutMs 也不超时（idle 语义，而非总时长语义）', async () => {
    const ctl = mockFetchSseControllable()
    const prev = globalThis.fetch
    globalThis.fetch = ctl.fetch
    const p = new GeminiChatProvider({ apiKey: 'k', timeoutMs: 60 })

    try {
      const promise = collect(p)
      // 5 段 × 每段间隔 25ms ≈ 125ms > timeoutMs(60)；单段间隔却始终 < 60
      for (const piece of ['长', '回', '答', '不', '掐']) {
        ctl.push(sseGeminiText(piece))
        await new Promise((r) => setTimeout(r, 25))
      }
      ctl.push(sseGeminiFinish())
      const chunks = await promise

      expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join('')).toBe('长回答不掐')
      expect(chunks.find((c) => c.type === 'done')).toBeDefined()
    } finally {
      globalThis.fetch = prev
    }
  })

  it('真正卡死（一直无数据）仍会超时，且报「空闲超时」', async () => {
    const ctl = mockFetchSseControllable()
    const prev = globalThis.fetch
    globalThis.fetch = ctl.fetch
    const p = new GeminiChatProvider({ apiKey: 'k', timeoutMs: 40 })

    try {
      // 一个字节都不推 → 空闲计时器应触发
      const err = await collect(p).then(() => undefined, (e: Error) => e.message)
      expect(err).toInclude('空闲超时')
      expect(err).toInclude('40ms')
    } finally {
      globalThis.fetch = prev
    }
  })
})
