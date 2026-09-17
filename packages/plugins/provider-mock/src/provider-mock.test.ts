import { describe, it, expect } from 'bun:test'
import {
  MockChatProvider,
  createProviderMockPlugin,
  providerMockPlugin,
  MockProviderConfig,
  MockResponseRule,
} from './index'
import { createHarness, AgentDefinition, defineTool, Tool, ToolResult, Schema, DefaultPermissionEngine } from '@harness/core'
import type { AgentPlugin, Hooks } from '@harness/plugin'
import type { Message } from '@harness/session'

// ===== helpers =====

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'default',
    name: '默认 Agent',
    description: '测试用',
    mode: 'primary',
    tools: ['*'],
    permission: { '*': 'allow' },
    promptFragments: ['You are a test assistant.'],
    ...overrides,
  }
}

function createEchoTool(): Tool<{ msg: string }, { reply: string }> {
  const schemaAny: Schema<any> = {
    parse: (v) => v as any,
    safeParse: (v) => ({ success: true, data: v as any }),
  }
  return defineTool({
    id: 'echo',
    description: '返回传入的 msg',
    inputSchema: schemaAny,
    isReadOnly: () => true,
    async call(input) {
      return { ok: true, output: { reply: `echo:${input.msg}` } }
    },
  })
}

// ===== 测试 =====

describe('@harness/provider-mock', () => {
  describe('MockChatProvider 独立使用', () => {
    it('默认配置返回 mock 响应', async () => {
      const p = new MockChatProvider()
      const out = await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }], createdAt: Date.now() }],
        params: { temperature: 0.7 },
      })
      expect(out.content).toBe('This is a mock response.')
      expect(out.model).toBe('mock-v1')
      expect(out.tokenUsage?.input).toBe(10)
      expect(out.tokenUsage?.output).toBe(5)
      expect(out.tokenUsage?.total).toBe(15)
    })

    it('自定义配置：defaultResponse / model / tokenUsage / reasoning', async () => {
      const p = new MockChatProvider({
        defaultResponse: '你好',
        defaultReasoning: '思考中...',
        model: 'mock-v2',
        tokenUsage: { input: 20, output: 10 },
      })
      const out = await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: Date.now() }],
        params: {},
      })
      expect(out.content).toBe('你好')
      expect(out.reasoning).toBe('思考中...')
      expect(out.model).toBe('mock-v2')
      expect(out.tokenUsage?.total).toBe(30)
    })

    it('按关键词匹配响应规则（字符串子串）', async () => {
      const p = new MockChatProvider({
        defaultResponse: '默认',
        responses: [
          { match: '工具', response: '好的，我来调用工具', toolCalls: [{ toolUseId: 't1', toolId: 'echo', input: { msg: 'hi' } }] },
          { match: '天气', response: '今天晴天' },
        ],
      })
      // 匹配 "工具"
      const out1 = await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '帮我调用工具' }], createdAt: Date.now() }],
        params: {},
      })
      expect(out1.content).toBe('好的，我来调用工具')
      expect(out1.toolCalls).toHaveLength(1)
      expect(out1.toolCalls![0].toolId).toBe('echo')

      // 匹配 "天气"
      const out2 = await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm2', role: 'user', parts: [{ type: 'text', text: '今天天气如何' }], createdAt: Date.now() }],
        params: {},
      })
      expect(out2.content).toBe('今天晴天')
      expect(out2.toolCalls).toBeUndefined()

      // 无匹配 → 默认
      const out3 = await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm3', role: 'user', parts: [{ type: 'text', text: '随便说' }], createdAt: Date.now() }],
        params: {},
      })
      expect(out3.content).toBe('默认')
    })

    it('按正则匹配响应规则', async () => {
      const p = new MockChatProvider({
        defaultResponse: '默认',
        responses: [
          { match: /\d{4}-\d{2}-\d{2}/, response: '检测到日期格式' },
        ],
      })
      const out = await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '日期是 2026-08-16' }], createdAt: Date.now() }],
        params: {},
      })
      expect(out.content).toBe('检测到日期格式')
    })

    it('记录调用历史（calls 数组）', async () => {
      const p = new MockChatProvider({ defaultResponse: 'ok' })
      await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a' }], createdAt: Date.now() }],
        params: { temperature: 0.5 },
        sessionId: 's1',
        agentId: 'default',
      })
      await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'b' }], createdAt: Date.now() }],
        params: { temperature: 0.9 },
      })
      expect(p.calls).toHaveLength(2)
      expect(p.calls[0].sessionId).toBe('s1')
      expect(p.calls[0].params.temperature).toBe(0.5)
      expect(p.calls[1].params.temperature).toBe(0.9)
    })

    it('recordCalls: false 时不记录', async () => {
      const p = new MockChatProvider({ defaultResponse: 'ok', recordCalls: false })
      await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a' }], createdAt: Date.now() }],
        params: {},
      })
      expect(p.calls).toHaveLength(0)
    })

    it('delayMs 模拟延迟', async () => {
      const p = new MockChatProvider({ defaultResponse: 'ok', delayMs: 50 })
      const start = Date.now()
      await p.complete({
        providerId: 'mock',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a' }], createdAt: Date.now() }],
        params: {},
      })
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(40) // 允许一点误差
    })

    it('从多 Part 消息提取最后 user 文本', async () => {
      const p = new MockChatProvider({
        responses: [{ match: '特殊', response: 'matched' }],
      })
      const messages: Message[] = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }], createdAt: Date.now() },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hi' }], createdAt: Date.now() },
        { id: 'm3', role: 'user', parts: [{ type: 'file', path: '/x' }, { type: 'text', text: '这是特殊请求' }], createdAt: Date.now() },
      ]
      const out = await p.complete({ providerId: 'mock', messages, params: {} })
      expect(out.content).toBe('matched')
    })
  })

  describe('providerMockPlugin 插件集成', () => {
    it('通过 internalPlugins 注入 → harness.init Hook 替换 ChatProvider', async () => {
      const plugin = createProviderMockPlugin({
        defaultResponse: '插件注入成功',
        model: 'mock-plugin-v1',
      })
      const h = await createHarness({
        internalPlugins: [plugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      await h.start()

      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '测试' })

      expect(reply.role).toBe('assistant')
      const textPart = reply.parts.find((p: any) => p.type === 'text') as any
      expect(textPart.text).toBe('插件注入成功')
      expect((reply.meta as any)?.model).toBe('mock-plugin-v1')

      // 插件暴露的 provider 可用于断言
      expect(plugin.provider.calls).toHaveLength(1)
      expect(plugin.provider.calls[0].params).toBeDefined()

      await h.stop()
    })

    it('通过 config store 读取配置（provider.mock key）', async () => {
      const plugin = createProviderMockPlugin() // 不传 config，从 config store 读
      const h = await createHarness({
        internalPlugins: [plugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
        config: {
          'provider.mock': {
            defaultResponse: '从 config 来',
            model: 'mock-cfg-v1',
            responses: [
              { match: '工具', response: '', toolCalls: [{ toolUseId: 't1', toolId: 'echo', input: { msg: 'cfg' } }] },
            ],
          },
        },
      })
      await h.start()

      const sess = await h.session.create()

      // 默认响应
      const r1 = await h.agent.query({ sessionId: sess.id, message: '你好' })
      const t1 = r1.parts.find((p: any) => p.type === 'text') as any
      expect(t1.text).toBe('从 config 来')

      // 工具调用匹配
      const r2 = await h.agent.query({ sessionId: sess.id, message: '用工具' })
      const toolPart = r2.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart).toBeDefined()
      expect(toolPart.toolId).toBe('echo')

      await h.stop()
    })

    it('端到端：mock provider + tool call + tool.pool.assemble 注入工具', async () => {
      // 用一个 ToolPlugin 通过 tool.pool.assemble 注册 echo 工具
      const ToolPlugin: AgentPlugin = {
        id: 'tools', version: '1', name: 'Tools',
        async install() {
          return {
            async 'tool.pool.assemble'(_i, pool: any) {
              pool.add(createEchoTool())
            },
          } as Hooks
        },
      }
      const mockPlugin = createProviderMockPlugin({
        defaultResponse: '无工具',
        responses: [
          {
            match: '调用',
            response: '',
            toolCalls: [{ toolUseId: 'tu_1', toolId: 'echo', input: { msg: 'mock-echo' } }],
          },
        ],
      })

      const h = await createHarness({
        internalPlugins: [mockPlugin, ToolPlugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      await h.start()

      const sess = await h.session.create()

      // 不触发工具 → 文本响应
      const r1 = await h.agent.query({ sessionId: sess.id, message: '你好' })
      expect(r1.parts.some((p: any) => p.type === 'text' && p.text === '无工具')).toBe(true)

      // 触发工具 → echo 执行（maxSteps: 1 —— 本用例只验证工具链装配与执行一次，
      // 该 mock 规则可重复命中，放任自主多步会一路跑到 doom-loop 拦截）
      const r2 = await h.agent.query({ sessionId: sess.id, message: '调用', maxSteps: 1 })
      const toolPart = r2.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart).toBeDefined()
      expect((toolPart.result as any).reply).toBe('echo:mock-echo')

      // 验证 mock provider 调用历史
      expect(mockPlugin.provider.calls).toHaveLength(2)

      await h.stop()
    })

    it('直接使用 providerMockPlugin 常量（默认配置）', async () => {
      const h = await createHarness({
        internalPlugins: [providerMockPlugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
        config: {
          'provider.mock': { defaultResponse: '常量插件' },
        },
      })
      await h.start()
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: 'test' })
      const textPart = reply.parts.find((p: any) => p.type === 'text') as any
      expect(textPart.text).toBe('常量插件')
      await h.stop()
    })
  })
})
