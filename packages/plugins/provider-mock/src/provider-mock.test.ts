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
    it('通过 internalPlugins 注入 → core.harness.init Hook 替换 ChatProvider', async () => {
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

    it('端到端：mock provider + tool call + core.tool.pool.assemble 注入工具', async () => {
      // 用一个 ToolPlugin 通过 core.tool.pool.assemble 注册 echo 工具
      const ToolPlugin: AgentPlugin = {
        id: 'tools', version: '1', name: 'Tools',
        async install() {
          return {
            async 'core.tool.pool.assemble'(_i, pool: any) {
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

    it('agent 白名单过滤后的工具真的传到了 provider', async () => {
      // 这条链路此前**无法断言**：mock 的入参类型里没有 `tools`，收不到也不记录。
      // 结果是"白名单 → provider 载荷"这一段全仓没有一个端到端观察点 —— 引擎若把
      // 全量注册表（而不是该 agent 可用的那份）发出去，也不会有任何用例变红。
      const schemaAny: Schema<any> = {
        parse: (v) => v as any,
        safeParse: (v) => ({ success: true, data: v as any }),
      }
      const noiseTool = defineTool({
        id: 'noise',
        description: '不在该 agent 白名单内，不应出现在 provider 工具列表里',
        inputSchema: schemaAny,
        isReadOnly: () => true,
        async call() {
          return { ok: true, output: {} }
        },
      })
      const ToolPlugin: AgentPlugin = {
        id: 'tools', version: '1', name: 'Tools',
        async install() {
          return {
            async 'core.tool.pool.assemble'(_i, pool: any) {
              pool.add(createEchoTool())
              pool.add(noiseTool)
            },
          } as Hooks
        },
      }
      const mockPlugin = createProviderMockPlugin({ defaultResponse: 'ok' })

      const h = await createHarness({
        internalPlugins: [mockPlugin, ToolPlugin],
        agents: [makeAgent({ tools: ['echo'] })],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      await h.start()
      const sess = await h.session.create()
      await h.agent.query({ sessionId: sess.id, message: '你好' })

      const seen = mockPlugin.provider.calls.at(-1)?.tools
      expect(seen?.map((t) => t.id)).toStrictEqual(['echo'])
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

// ==========================================================================
// usageSequence：按调用次序取用量
//
// 为什么需要：tokenUsage 是静态值，而"缓存塌陷""用量台阶""校准比值"这类**滚动 rollout**
// 场景必须逐轮可变 —— 否则无法验证任何依赖"相邻两轮差值"的归因逻辑
// （acp-context 的 cacheMissReason / cacheDropTokens / calibration）。
// ==========================================================================

describe('usageSequence（逐轮用量）', () => {
  const msgs: Message[] = [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1 },
  ]

  it('按次序推进；越界后回落到 tokenUsage（缺省行为不变）', async () => {
    const p = new MockChatProvider({
      defaultResponse: 'ok',
      tokenUsage: { input: 7, output: 1, cacheRead: 3 },
      usageSequence: [
        { input: 100, output: 5, cacheRead: 90 },
        { input: 200, output: 5, cacheRead: 50 },   // 相对上一轮"塌陷"
      ],
    })
    const a = await p.complete({ providerId: 'mock', messages: msgs, params: {} })
    const b = await p.complete({ providerId: 'mock', messages: msgs, params: {} })
    const c = await p.complete({ providerId: 'mock', messages: msgs, params: {} })

    expect(a.tokenUsage!.input).toBe(100)
    expect(a.tokenUsage!.cacheRead).toBe(90)
    expect(b.tokenUsage!.input).toBe(200)
    expect(b.tokenUsage!.cacheRead).toBe(50)
    // 第 3 次越界 ⇒ 回落到静态 tokenUsage
    expect(c.tokenUsage!.input).toBe(7)
    expect(c.tokenUsage!.cacheRead).toBe(3)
  })

  it('未配 usageSequence ⇒ 每次都取 tokenUsage（与旧版逐位等价）', async () => {
    const p = new MockChatProvider({ tokenUsage: { input: 42, output: 2, cacheRead: 40 } })
    for (let i = 0; i < 3; i++) {
      const r = await p.complete({ providerId: 'mock', messages: msgs, params: {} })
      expect(r.tokenUsage!.input).toBe(42)
      expect(r.tokenUsage!.cacheRead).toBe(40)
    }
  })
})

// ==========================================================================
// 测试替身的**保真度**：这些断言守的是"mock 与真实 provider 契约不漂移"，
// 不是 mock 自己的产品功能。mock 被 core/cli/a2a-server/tools-builtin/bench/host
// 共用，任何一处漂移都会让下游用例在"看起来在测"的状态下测不到东西。
// ==========================================================================

describe('契约保真度', () => {
  const msgs = (t: string): Message[] => [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: t }], createdAt: 1 },
  ]

  it('带 g / y 标志的正则：每次调用都命中（不复用 lastIndex）', async () => {
    // 回归：`/hello/g` 的 test() 会推进 lastIndex，第二次从上次位置继续 ⇒ 交替 命中/落空。
    const p = new MockChatProvider({
      defaultResponse: 'MISS',
      responses: [
        { match: /hello/g, response: 'HIT_G' },
        { match: /world/y, response: 'HIT_Y' },
      ],
    })
    for (let i = 0; i < 3; i++) {
      const g = await p.complete({ providerId: 'mock', messages: msgs('say hello'), params: {} })
      expect(g.content).toBe('HIT_G')
      const y = await p.complete({ providerId: 'mock', messages: msgs('world peace'), params: {} })
      expect(y.content).toBe('HIT_Y')
    }
  })

  it('记录引擎传来的 tools（区分「没传」与「传了空数组」）', async () => {
    const tool = createEchoTool()
    const p = new MockChatProvider()

    await p.complete({ providerId: 'mock', messages: msgs('a'), params: {}, tools: [tool] })
    await p.complete({ providerId: 'mock', messages: msgs('a'), params: {}, tools: [] })
    await p.complete({ providerId: 'mock', messages: msgs('a'), params: {} })

    expect(p.calls[0].tools?.map((t) => t.id)).toStrictEqual(['echo'])
    // 三者必须各不相同：[] 是"白名单一个都不允许"，undefined 是"这条链路没人传"
    expect(p.calls[1].tools).toStrictEqual([])
    expect(p.calls[2].tools).toBeUndefined()
  })

  it('记录命中的规则下标；未命中时为 undefined', async () => {
    const p = new MockChatProvider({
      defaultResponse: '默认',
      responses: [
        { match: 'alpha', response: 'A' },
        { match: 'beta', response: 'B' },
      ],
    })
    await p.complete({ providerId: 'mock', messages: msgs('alpha'), params: {} })
    await p.complete({ providerId: 'mock', messages: msgs('beta'), params: {} })
    await p.complete({ providerId: 'mock', messages: msgs('gamma'), params: {} })

    expect(p.calls[0].matchedRuleIndex).toBe(0)
    expect(p.calls[1].matchedRuleIndex).toBe(1)
    expect(p.calls[2].matchedRuleIndex).toBeUndefined()
  })

  it('同一条 user 消息的多个 text part 都参与匹配', async () => {
    // 只取第一个 text part 时，关键词落在第二段上 ⇒ 静默走默认响应。
    const p = new MockChatProvider({
      defaultResponse: '默认',
      responses: [{ match: 'beta-gamma', response: 'HIT' }],
    })
    const r = await p.complete({
      providerId: 'mock',
      messages: [{
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'alpha' }, { type: 'text', text: 'beta-gamma' }],
        createdAt: 1,
      }],
      params: {},
    })
    expect(r.content).toBe('HIT')
  })

  it('delayMs 期间被中断 ⇒ 立即抛 AbortError，不等满延迟、不记录调用', async () => {
    const p = new MockChatProvider({ delayMs: 500 })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)

    const start = Date.now()
    let caught: unknown
    try {
      await p.complete({ providerId: 'mock', messages: msgs('a'), params: {}, signal: ac.signal })
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - start

    // 名字是契约：core 的 isAbortError 只认 'AbortError' / 'TimeoutError'
    expect((caught as { name?: string } | undefined)?.name).toBe('AbortError')
    expect(elapsed).toBeLessThan(300)   // 远早于 500ms 延迟
    expect(p.calls).toHaveLength(0)
  })

  it('传入已中断的 signal ⇒ 一个 chunk 都不发', async () => {
    const p = new MockChatProvider({ delayMs: 0, defaultResponse: 'hi.' })
    const ac = new AbortController()
    ac.abort()

    let caught: unknown
    const chunks: unknown[] = []
    try {
      for await (const ch of p.stream({ providerId: 'mock', messages: msgs('a'), params: {}, signal: ac.signal })) {
        chunks.push(ch)
      }
    } catch (e) {
      caught = e
    }
    expect((caught as { name?: string } | undefined)?.name).toBe('AbortError')
    expect(chunks).toHaveLength(0)
  })

  it('流式过程中被中断 ⇒ 抛 AbortError 且不发 done', async () => {
    // 少了这条，"per-chunk 检查 signal" 就只被"起始已中断"那条覆盖 —— 而那条是被 delay() 的
    // 前置检查拦下的，把 guard() 整个删掉也不会变红。
    const p = new MockChatProvider({ defaultResponse: 'one two three four' })
    const ac = new AbortController()

    let text = ''
    let sawDone = false
    let caught: unknown
    try {
      for await (const ch of p.stream({ providerId: 'mock', messages: msgs('a'), params: {}, signal: ac.signal })) {
        if (ch.type === 'text_delta') {
          text += ch.text
          ac.abort()               // 收到第一段就取消
        }
        if (ch.type === 'done') sawDone = true
      }
    } catch (e) {
      caught = e
    }

    expect((caught as { name?: string } | undefined)?.name).toBe('AbortError')
    expect(sawDone).toBe(false)
    expect(text.length).toBeGreaterThan(0)   // 半截文本确实产出过
  })

  it('complete 与 stream 对同一配置给出逐位一致的 content / model / usage / finish', async () => {
    // 两条路径曾各内联一份"取 turn + 组用量 + 算 finish"，改一侧忘另一侧就会静默分叉。
    type Case = { name: string; config: MockProviderConfig; text: string }
    const cases: Case[] = [
      { name: '默认响应', config: { defaultResponse: '默认文案', model: 'm0' }, text: 'x' },
      { name: '规则命中 + 缓存用量', config: { tokenUsage: { input: 9, output: 4, cacheRead: 7, cacheWrite: 3 }, responses: [{ match: 'k', response: 'K', model: 'm1' }] }, text: 'k' },
      { name: '工具调用', config: { responses: [{ match: 'k', response: 'K', toolCalls: [{ toolUseId: 't1', toolId: 'echo', input: { m: 1 } }] }] }, text: 'k' },
    ]

    for (const c of cases) {
      const pc = new MockChatProvider(c.config)
      const ps = new MockChatProvider(c.config)
      const done = await pc.complete({ providerId: 'mock', messages: msgs(c.text), params: {} })

      let streamed = ''
      let last: { model?: string; tokenUsage?: unknown; finish?: string } | undefined
      for await (const ch of ps.stream({ providerId: 'mock', messages: msgs(c.text), params: {} })) {
        if (ch.type === 'text_delta') streamed += ch.text
        if (ch.type === 'done') last = ch
      }

      expect(streamed).toBe(done.content)
      expect(last?.model).toBe(done.model)
      expect(last?.tokenUsage).toStrictEqual(done.tokenUsage)
      expect(last?.finish).toBe(done.finish)
    }
  })
})
