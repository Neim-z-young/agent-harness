import { describe, it, expect } from 'bun:test'
import {
  OpenAIChatProvider,
  createProviderOpenAIPlugin,
  providerOpenAIPlugin,
  OpenAIProviderConfig,
} from './index'
import type { Message } from '@harness/session'
import { defineTool, Schema, Tool } from '@harness/tool'
import { createHarness, DefaultPermissionEngine, AgentDefinition } from '@harness/core'

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

type FetchMock = (args: { url: string; init: RequestInit }) => Promise<Response>
function installMock(mock: FetchMock) {
  const prev = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string, init: RequestInit) => mock({ url, init })
  return () => {
    (globalThis as any).fetch = prev
  }
}

function okResponse(content: string, model = 'gpt-4o-mini', opts: { inputTokens?: number; outputTokens?: number } = {}): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: opts.inputTokens ?? 5,
      completion_tokens: opts.outputTokens ?? 3,
      total_tokens: (opts.inputTokens ?? 5) + (opts.outputTokens ?? 3),
    },
  })
}

// ===== 测试 =====

describe('@harness/provider-openai', () => {
  // ===== 单元：序列化映射 =====

  describe('Part → OpenAI Message 序列化', () => {
    it('system 角色合并为单条 system 消息', async () => {
      const p = new OpenAIChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(okResponse('ok'), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
      try {
        const messages: Message[] = [
          { id: 'm1', role: 'system', parts: [{ type: 'text', text: '你是助手' }, { type: 'text', text: '回答简洁' }], createdAt: 1 },
          { id: 'm2', role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: 2 },
        ]
        await p.complete({ providerId: 'openai', messages, params: {} })
        expect(captured.messages).toHaveLength(2)
        expect(captured.messages[0].role).toBe('system')
        expect(captured.messages[0].content).toBe('你是助手\n\n回答简洁')
        expect(captured.messages[1].role).toBe('user')
        expect(captured.messages[1].content).toBe('你好')
      } finally {
        restore()
      }
    })

    it('TextPart → content string', async () => {
      const p = new OpenAIChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(okResponse('hi'))
      })
      try {
        const msgs: Message[] = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '问' }], createdAt: 1 }]
        await p.complete({ providerId: 'o', messages: msgs, params: {} })
        expect(captured.messages[0].content).toBe('问')
      } finally {
        restore()
      }
    })

    it('assistant 内 ToolCallPart → tool_calls 数组；tool 结果 → role:tool 消息', async () => {
      const p = new OpenAIChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(okResponse('done'))
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
        await p.complete({ providerId: 'o', messages: msgs, params: {} })
        const assistant = captured.messages.find((m: any) => m.role === 'assistant')
        expect(assistant.tool_calls).toHaveLength(1)
        expect(assistant.tool_calls[0]).toEqual({
          id: 'tu1', type: 'function', function: { name: 'echo', arguments: '{"msg":"hi"}' },
        })
        const toolMsg = captured.messages.find((m: any) => m.role === 'tool')
        expect(toolMsg).toBeDefined()
        expect(toolMsg.content).toBe('{"reply":"echo:hi"}')
        expect(toolMsg.tool_call_id).toBe('tu1')
      } finally {
        restore()
      }
    })

    it('ImagePart → image_url content', async () => {
      const p = new OpenAIChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(okResponse('seen'))
      })
      try {
        const msgs: Message[] = [{
          id: 'u1', role: 'user', createdAt: 1,
          parts: [
            { type: 'text', text: '看图' },
            { type: 'image', content: 'base64data', mimeType: 'image/png' },
          ],
        }]
        await p.complete({ providerId: 'o', messages: msgs, params: {} })
        const content = captured.messages[0].content
        expect(Array.isArray(content)).toBe(true)
        expect(content[0]).toEqual({ type: 'text', text: '看图' })
        expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,base64data' } })
      } finally {
        restore()
      }
    })
  })

  // ===== Tool Schema 导出 =====

  describe('Tool Schema 导出', () => {
    it('带 __jsonSchema 的工具会精确导出 properties/required', async () => {
      const t = makeTool('my_tool', '一个工具', {
        path: { type: 'string', description: '文件路径' },
        offset: { type: 'integer' },
      })
      const p = new OpenAIChatProvider({ apiKey: 'k' }, () => [t])
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(okResponse('ok'))
      })
      try {
        await p.complete({ providerId: 'o', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }], params: {} })
        expect(captured.tools).toHaveLength(1)
        const def = captured.tools[0]
        expect(def.type).toBe('function')
        expect(def.function.name).toBe('my_tool')
        expect(def.function.description).toBe('一个工具')
        expect(def.function.parameters.required).toEqual(['path', 'offset'])
        expect(def.function.parameters.properties.path).toEqual({ type: 'string', description: '文件路径' })
      } finally {
        restore()
      }
    })

    it('带 documentation 的工具会合并为完整 description', async () => {
      const t = defineTool({
        id: 'my_tool',
        description: '一个工具',
        documentation: '用法：\n- 先 read 再 edit\n- 只在工作目录内操作',
        inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
        isReadOnly: () => true,
        async call(input): Promise<any> { return { ok: true, output: input } },
      })
      const p = new OpenAIChatProvider({ apiKey: 'k' }, () => [t])
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(okResponse('ok'))
      })
      try {
        await p.complete({ providerId: 'o', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }], params: {} })
        expect(captured.tools[0].function.description).toContain('一个工具')
        expect(captured.tools[0].function.description).toContain('先 read 再 edit')
      } finally {
        restore()
      }
    })

    it('不带 __jsonSchema 的工具回落到宽松 schema', async () => {
      const loose = defineTool({
        id: 'loose',
        description: '宽松工具',
        inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
        isReadOnly: () => true,
        async call(input): Promise<any> { return { ok: true, output: input } },
      })
      const p = new OpenAIChatProvider({ apiKey: 'k' }, () => [loose])
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(okResponse('ok'))
      })
      try {
        await p.complete({ providerId: 'o', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }], params: {} })
        expect(captured.tools[0].function.parameters.type).toBe('object')
        expect(captured.tools[0].function.parameters.additionalProperties).toBe(true)
      } finally {
        restore()
      }
    })
  })

  // ===== 请求/响应往返 =====

  describe('请求/响应往返', () => {
    it('请求头：Authorization Bearer / Content-Type / Organization', async () => {
      const p = new OpenAIChatProvider({ apiKey: 'sk-abc', organization: 'org-123' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = init
        return new Response(okResponse('ok'))
      })
      try {
        await p.complete({
          providerId: 'o',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
          headers: { 'X-Custom': 'foo' },
        })
        const h = captured.headers as Record<string, string>
        expect(h['Content-Type']).toBe('application/json')
        expect(h['Authorization']).toBe('Bearer sk-abc')
        expect(h['OpenAI-Organization']).toBe('org-123')
        expect(h['X-Custom']).toBe('foo')
      } finally {
        restore()
      }
    })

    it('响应解析：text + tool_calls → ChatCompletionOutput', async () => {
      const p = new OpenAIChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(JSON.stringify({
        id: 'chatcmpl-abc',
        object: 'chat.completion',
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '先做点计算',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
              { id: 'call_2', type: 'function', function: { name: 'echo', arguments: '{"msg":"123"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      })))
      try {
        const out = await p.complete({
          providerId: 'o',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: { temperature: 0.2 },
        })
        expect(out.content).toBe('先做点计算')
        expect(out.model).toBe('gpt-4o')
        expect(out.toolCalls).toHaveLength(2)
        expect(out.toolCalls![0]).toEqual({ toolUseId: 'call_1', toolId: 'read_file', input: { path: 'a.txt' } })
        expect(out.toolCalls![1]).toEqual({ toolUseId: 'call_2', toolId: 'echo', input: { msg: '123' } })
        expect(out.tokenUsage).toEqual({ input: 50, output: 20, total: 70 })
        expect(out.raw).toBeDefined()
      } finally {
        restore()
      }
    })

    it('API 返回 JSON error → 抛出带 message 的错误', async () => {
      const p = new OpenAIChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(JSON.stringify({
        error: { message: 'Invalid API Key', type: 'invalid_request_error' },
      }), { status: 401 }))
      try {
        const err = await p.complete({
          providerId: 'o',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        }).then(() => null, (e) => e)
        expect(err?.message).toContain('Invalid API Key')
      } finally {
        restore()
      }
    })

    it('未配 API Key → 立即抛错', async () => {
      const p = new OpenAIChatProvider()
      const restore = installMock(async () => { throw new Error('不应到达真实 fetch') })
      const savedKey = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY
      try {
        const err = await p.complete({
          providerId: 'o',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        }).then(() => null, (e) => e)
        expect(err?.message).toContain('API Key 未配置')
      } finally {
        restore()
        if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey
      }
    })

    it('calls 数组记录请求体，modelId 覆盖 defaultModel', async () => {
      const p = new OpenAIChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(okResponse('ok')))
      try {
        await p.complete({
          providerId: 'o', modelId: 'gpt-4o',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Q1' }], createdAt: 1 }],
          params: {},
        })
        await p.complete({
          providerId: 'o',
          messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Q2' }], createdAt: 2 }],
          params: {},
        })
        expect(p.calls).toHaveLength(2)
        expect(p.calls[0].body.model).toBe('gpt-4o')
        expect(p.calls[1].body.model).toBe('gpt-4o-mini')
      } finally {
        restore()
      }
    })
  })

  // ===== 插件集成 =====

  describe('createProviderOpenAIPlugin 集成', () => {
    it('config store 读取配置（key=provider.openai）', async () => {
      const restore = installMock(async () => new Response(okResponse('openai响应', 'gpt-4o-custom')))
      try {
        const plugin = createProviderOpenAIPlugin()
        const h = await createHarness({
          cwd: process.cwd(),
          internalPlugins: [plugin],
          agents: [makeAgent()],
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          config: {
            'provider.openai': {
              apiKey: 'from-store',
              defaultModel: 'gpt-4o-custom',
              baseUrl: 'https://mock.local',
            },
          },
        })
        await h.start()
        const sess = await h.session.create()
        const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })
        const textPart = reply.parts.find((p: any) => p.type === 'text') as any
        expect(textPart.text).toBe('openai响应')
        expect((reply.meta as any)?.model).toBe('gpt-4o-custom')
        expect(h.plugin.list().map((p) => p.plugin.id)).toEqual(
          expect.arrayContaining(['provider.openai'])
        )
        await h.stop()
      } finally {
        restore()
      }
    })

    it('直接传配置优先级高于 store', async () => {
      const restore = installMock(async () => new Response(okResponse('直接', 'direct-model')))
      try {
        const plugin = createProviderOpenAIPlugin({
          apiKey: 'direct-key',
          defaultModel: 'direct-model',
        })
        const h = await createHarness({
          cwd: process.cwd(),
          internalPlugins: [plugin],
          agents: [makeAgent()],
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          config: { 'provider.openai': { defaultModel: 'from-store' } },
        })
        await h.start()
        const sess = await h.session.create()
        const reply = await h.agent.query({ sessionId: sess.id, message: 'x' })
        expect((reply.meta as any)?.model).toBe('direct-model')
        await h.stop()
      } finally {
        restore()
      }
    })
  })
})
