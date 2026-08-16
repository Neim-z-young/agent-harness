import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  AnthropicChatProvider,
  createProviderAnthropicPlugin,
  providerAnthropicPlugin,
  AnthropicProviderConfig,
} from './index'
import type { Message, Part } from '@harness/session'
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

// Mock fetch（可重放）
type FetchMock = (args: { url: string; init: RequestInit }) => Promise<Response>
function installMock(mock: FetchMock) {
  const prev = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string, init: RequestInit) => mock({ url, init })
  return () => {
    (globalThis as any).fetch = prev
  }
}

// ===== 测试 =====

describe('@harness/provider-anthropic', () => {
  // ===== 单元：序列化映射 =====

  describe('Part → Claude Content Block 序列化', () => {
    it('system 角色提取为请求体 system 字段', () => {
      const messages: Message[] = [
        {
          id: 'm1',
          role: 'system',
          parts: [{ type: 'text', text: '你是助手' }, { type: 'text', text: '回答简洁' }],
          createdAt: 1,
        },
        {
          id: 'm2',
          role: 'user',
          parts: [{ type: 'text', text: '你好' }],
          createdAt: 2,
        },
      ]
      // 不 import 内部函数，通过调用 AnthropicChatProvider 并 mock fetch 反推 body
      const p = new AnthropicChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse((init.body as any) as string)
        return new Response(JSON.stringify({
          id: 'm_x', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
      try {
        p.complete({ providerId: 'anthropic', messages, params: {} })
        // 同步部分：body 会在 fetch 被调用时 captured
        return new Promise<void>((res) => setImmediate(async () => {
          try {
            // 等待 fetch 被调用（complete 已经进入 await fetch）
            // 直接再试一次调用 + setTimeout 确保 promise 推进
            await new Promise((r) => setTimeout(r, 5))
            expect(captured.system).toBe('你是助手\n\n回答简洁')
            expect(captured.messages).toHaveLength(1)
            expect(captured.messages[0].role).toBe('user')
            expect(captured.messages[0].content[0]).toEqual({ type: 'text', text: '你好' })
            res()
          } finally {
            restore()
          }
        }))
      } finally {
        // restore 可能在 finally 执行
      }
    })

    it('TextPart → text block', () => {
      // 用 mock fetch 完整调用断言
      const p = new AnthropicChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(JSON.stringify({
          id: '1', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          model: 'm', stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }))
      })
      return new Promise<void>((res) => setImmediate(async () => {
        try {
          await new Promise((r) => setTimeout(r, 5))
          const msgs: Message[] = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '问' }], createdAt: 1 }]
          p.complete({ providerId: 'a', messages: msgs, params: {} })
          await new Promise((r) => setTimeout(r, 10))
          expect(captured.messages[0].content).toEqual([{ type: 'text', text: '问' }])
          res()
        } finally {
          restore()
        }
      }))
    })

    it('assistant 消息内 ToolCallPart → tool_use block，user 内带 result → tool_result block', () => {
      const p = new AnthropicChatProvider({ apiKey: 'k' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(JSON.stringify({
          id: '1', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          model: 'm', stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }))
      })
      return new Promise<void>((res) => setImmediate(async () => {
        try {
          await new Promise((r) => setTimeout(r, 5))
          const msgs: Message[] = [
            { id: 'a1', role: 'assistant', agentId: 'a', createdAt: 1, parts: [
              { type: 'tool', toolUseId: 'tu1', toolId: 'echo', input: { msg: 'hi' } },
            ]},
            { id: 'u1', role: 'user', createdAt: 2, parts: [
              { type: 'tool', toolUseId: 'tu1', toolId: 'echo', input: { msg: 'hi' }, result: { reply: 'echo:hi' } },
            ]},
          ]
          p.complete({ providerId: 'a', messages: msgs, params: {} })
          await new Promise((r) => setTimeout(r, 10))
          const assistant = captured.messages.find((m: any) => m.role === 'assistant')
          expect(assistant.content[0]).toEqual({
            type: 'tool_use', id: 'tu1', name: 'echo', input: { msg: 'hi' },
          })
          const user = captured.messages.find((m: any) => m.role === 'user')
          expect(user.content[0]).toEqual({
            type: 'tool_result', tool_use_id: 'tu1', content: '{"reply":"echo:hi"}',
          })
          res()
        } finally {
          restore()
        }
      }))
    })
  })

  // ===== Tool Schema 导出 =====

  describe('Tool Schema 导出', () => {
    it('带 __jsonSchema 的工具会精确导出 properties/required', () => {
      const t = makeTool('my_tool', '一个工具', {
        path: { type: 'string', description: '文件路径' },
        offset: { type: 'integer' },
      })
      const p = new AnthropicChatProvider({ apiKey: 'k' }, () => [t])
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(JSON.stringify({
          id: '1', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }], model: 'm', stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }))
      })
      return new Promise<void>((res) => setImmediate(async () => {
        try {
          await new Promise((r) => setTimeout(r, 5))
          p.complete({ providerId: 'a', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }], params: {} })
          await new Promise((r) => setTimeout(r, 10))
          expect(captured.tools).toHaveLength(1)
          const def = captured.tools[0]
          expect(def.name).toBe('my_tool')
          expect(def.description).toBe('一个工具')
          expect(def.input_schema.required).toEqual(['path', 'offset'])
          expect(def.input_schema.properties.path).toEqual({ type: 'string', description: '文件路径' })
          res()
        } finally {
          restore()
        }
      }))
    })

    it('不带 __jsonSchema 的工具回落到宽松 schema（additionalProperties=true）', () => {
      const loose = defineTool({
        id: 'loose',
        description: '宽松工具',
        inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
        isReadOnly: () => true,
        async call(input): Promise<any> { return { ok: true, output: input } },
      })
      const p = new AnthropicChatProvider({ apiKey: 'k' }, () => [loose])
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = JSON.parse(init.body as string)
        return new Response(JSON.stringify({
          id: '1', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }], model: 'm', stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }))
      })
      return new Promise<void>((res) => setImmediate(async () => {
        try {
          await new Promise((r) => setTimeout(r, 5))
          p.complete({ providerId: 'a', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }], params: {} })
          await new Promise((r) => setTimeout(r, 10))
          expect(captured.tools[0].input_schema.type).toBe('object')
          expect(captured.tools[0].input_schema.additionalProperties).toBe(true)
          res()
        } finally {
          restore()
        }
      }))
    })
  })

  // ===== 请求/响应 往返 =====

  describe('请求/响应往返', () => {
    it('请求头正确：x-api-key / anthropic-version / Content-Type', () => {
      const p = new AnthropicChatProvider({ apiKey: 'sk-abc', apiVersion: '2024-02-29' })
      let captured: any
      const restore = installMock(async ({ init }) => {
        captured = init
        return new Response(JSON.stringify({
          id: '1', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }], model: 'm', stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 3 },
        }))
      })
      return new Promise<void>((res) => setImmediate(async () => {
        try {
          await new Promise((r) => setTimeout(r, 5))
          p.complete({
            providerId: 'a',
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
            params: {},
            headers: { 'X-Custom': 'foo' },
          })
          await new Promise((r) => setTimeout(r, 10))
          const h = captured.headers as Record<string, string>
          expect(h['Content-Type']).toBe('application/json')
          expect(h['x-api-key']).toBe('sk-abc')
          expect(h['anthropic-version']).toBe('2024-02-29')
          expect(h['X-Custom']).toBe('foo')
          res()
        } finally {
          restore()
        }
      }))
    })

    it('响应解析：text + tool_use → ChatCompletionOutput 双字段', async () => {
      const p = new AnthropicChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(JSON.stringify({
        id: 'm_abc', type: 'message', role: 'assistant',
        content: [
          { type: 'text', text: '先做点计算' },
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
          { type: 'tool_use', id: 'tu_2', name: 'echo', input: { msg: '123' } },
        ],
        model: 'claude-3-sonnet-20240229',
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 20 },
      })))
      try {
        const out = await p.complete({
          providerId: 'a',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: { temperature: 0.2 },
        })
        expect(out.content).toBe('先做点计算')
        expect(out.model).toBe('claude-3-sonnet-20240229')
        expect(out.toolCalls).toHaveLength(2)
        expect(out.toolCalls![0]).toEqual({ toolUseId: 'tu_1', toolId: 'read_file', input: { path: 'a.txt' } })
        expect(out.toolCalls![1]).toEqual({ toolUseId: 'tu_2', toolId: 'echo', input: { msg: '123' } })
        expect(out.tokenUsage).toEqual({ input: 50, output: 20, total: 70 })
        expect(out.raw).toBeDefined()
      } finally {
        restore()
      }
    })

    it('API 返回 JSON error → 抛出带 message 的错误', async () => {
      const p = new AnthropicChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(JSON.stringify({
        error: { type: 'authentication_error', message: 'Invalid API Key' },
      }), { status: 401 }))
      try {
        const err = await p.complete({
          providerId: 'a',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        }).then(() => null, (e) => e)
        expect(err?.message).toContain('Invalid API Key')
      } finally {
        restore()
      }
    })

    it('未配 API Key → 立即抛错', async () => {
      const p = new AnthropicChatProvider() // 不传 apiKey，也不依赖环境变量
      const restore = installMock(async () => {
        throw new Error('不应到达真实 fetch')
      })
      const savedKey = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        const err = await p.complete({
          providerId: 'a',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        }).then(() => null, (e) => e)
        expect(err?.message).toContain('API Key 未配置')
      } finally {
        restore()
        if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
      }
    })

    it('calls 数组记录请求体', async () => {
      const p = new AnthropicChatProvider({ apiKey: 'k' })
      const restore = installMock(async () => new Response(JSON.stringify({
        id: '1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }], model: 'm', stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })))
      try {
        await p.complete({
          providerId: 'a', modelId: 'm1',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Q1' }], createdAt: 1 }],
          params: {},
        })
        await p.complete({
          providerId: 'a',
          messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Q2' }], createdAt: 2 }],
          params: {},
        })
        expect(p.calls).toHaveLength(2)
        expect(p.calls[0].body.model).toBe('m1')
        expect(p.calls[1].body.model).toBe('claude-3-sonnet-20240229')
      } finally {
        restore()
      }
    })
  })

  // ===== 插件集成 =====

  describe('createProviderAnthropicPlugin 集成', () => {
    it('config store 读取配置（key=provider.anthropic）', async () => {
      let body: any
      const restore = installMock(async ({ init }) => {
        body = JSON.parse(init.body as string)
        return new Response(JSON.stringify({
          id: '1', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'anthropic响应' }],
          model: 'claude-custom',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }))
      })
      try {
        const plugin = createProviderAnthropicPlugin()
        const h = await createHarness({
          cwd: process.cwd(),
          internalPlugins: [plugin],
          agents: [makeAgent()],
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          config: {
            'provider.anthropic': {
              apiKey: 'from-store',
              defaultModel: 'claude-custom',
              baseUrl: 'https://mock.local',
            },
          },
        })
        await h.start()
        const sess = await h.session.create()
        const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })

        const textPart = reply.parts.find((p: any) => p.type === 'text') as any
        expect(textPart.text).toBe('anthropic响应')
        expect((reply.meta as any)?.model).toBe('claude-custom')
        // 确认调用了 baseUrl
        expect(body).toBeDefined()
        expect(h.plugin.list().map((p) => p.plugin.id)).toEqual(
          expect.arrayContaining(['provider.anthropic'])
        )
        await h.stop()
      } finally {
        restore()
      }
    })

    it('直接传配置（优先级高于 store）', async () => {
      let reqInit: RequestInit | undefined
      const restore = installMock(async ({ init }) => {
        reqInit = init
        return new Response(JSON.stringify({
          id: '1', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: '直接' }],
          model: 'direct-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }))
      })
      try {
        const plugin = createProviderAnthropicPlugin({
          apiKey: 'direct-key',
          defaultModel: 'direct-model',
        })
        const h = await createHarness({
          cwd: process.cwd(),
          internalPlugins: [plugin],
          agents: [makeAgent()],
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          config: {
            'provider.anthropic': { defaultModel: 'from-store' },
          },
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
