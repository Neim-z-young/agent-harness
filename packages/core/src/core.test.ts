import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  createHarness,
  Harness,
  HarnessImpl,
  HarnessEvents,
  AgentDefinition,
  ChatCompletionOutput,
  ChatProvider,
  DefaultPermissionEngine,
  BusEventRecord,
} from './index'
import { defineTool, Tool, ToolResult, Schema } from './index'
import type { AgentPlugin, Hooks, Message } from './index'
import { InMemoryBus } from '@harness/bus'

// ===== helpers =====
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

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'default',
    name: '默认 Agent',
    description: 'MVP 测试用',
    mode: 'primary',
    tools: ['*'],
    permission: { '*': 'allow' },
    promptFragments: ['You are a helpful test assistant.'],
    ...overrides,
  }
}

function mockChatProvider(behavior: 'text' | 'tool' = 'text', custom?: (p: any) => ChatCompletionOutput): ChatProvider & { calls: any[] } {
  const calls: any[] = []
  return {
    id: 'mock',
    calls,
    async complete(params) {
      calls.push(params)
      if (custom) return custom(params)
      if (behavior === 'tool') {
        return {
          content: '',
          model: 'mock-v1',
          tokenUsage: { input: 5, output: 2 },
          toolCalls: [{ toolUseId: 'tu_1', toolId: 'echo', input: { msg: 'hi' } }],
        }
      }
      return {
        content: '你好，我是测试助手。',
        reasoning: '用户需要问候，所以回复你好。',
        model: 'mock-v1',
        tokenUsage: { input: 10, output: 3 },
      }
    },
  }
}

function makeBusLogger(bus: InMemoryBus) {
  const events: BusEventRecord[] = []
  ;(bus as any).subscribeAll((e: BusEventRecord) => events.push(e))
  return events
}

describe('@harness/core', () => {
  describe('createHarness 基础', () => {
    it('默认构造：访问器都定义 + 初始化事件发出', async () => {
      const bus = new InMemoryBus()
      const evs = makeBusLogger(bus)
      const h = await createHarness({ bus })
      expect(h).toBeInstanceOf(HarnessImpl)
      expect(h.bus).toBe(bus)
      expect(typeof h.session.create).toBe('function')
      expect(typeof h.agent.register).toBe('function')
      expect(typeof h.plugin.list).toBe('function')
      expect(typeof h.tools.list).toBe('function')
      expect(typeof h.toolPipeline.execute).toBe('function')
      expect(typeof h.permission.check).toBe('function')
      expect(typeof h.context.register).toBe('function')
      expect(h.start).toBeDefined()
      expect(h.stop).toBeDefined()
      const init = evs.find((e) => e.name === 'harness.initialized')
      expect(init).toBeDefined()
      expect((init!.payload as any).pluginCount).toBe(0)
      await h.stop()
    })

    it('internalPlugins 会被加载', async () => {
      let installCalled = false
      const P: AgentPlugin = {
        id: 'p1',
        version: '1',
        name: 'P1',
        async install(ctx) {
          installCalled = true
          ctx.config.set('x', 1)
          return {}
        },
      }
      const h = await createHarness({ internalPlugins: [P] })
      expect(installCalled).toBe(true)
      expect(h.plugin.list().map((p) => p.plugin.id)).toEqual(['p1'])
      await h.stop()
    })

    it('harness.init / harness.start hooks 被触发', async () => {
      const steps: string[] = []
      const P: AgentPlugin = {
        id: 'p1',
        version: '1',
        name: 'P1',
        async install() {
          return {
            async 'harness.init'(_i, o) {
              steps.push('init')
              expect((o as any).harness).toBeDefined()
            },
            async 'harness.start'(_i, _o) {
              steps.push('start')
            },
          } as Hooks
        },
      }
      const h = await createHarness({ internalPlugins: [P] })
      await h.start()
      expect(steps).toEqual(['init', 'start'])
      await h.stop()
    })

    it('loadBuiltin 通过 pluginOverrides.dynamicImport 注入', async () => {
      const X: AgentPlugin = {
        id: 'x-plugin',
        version: '1',
        name: 'X',
        async install() { return {} },
      }
      const h = await createHarness({
        builtinPlugins: ['npm:x@1'],
        pluginOverrides: {
          dynamicImport: async () => ({ default: X }),
        },
      })
      expect(h.plugin.list().map((p) => p.plugin.id)).toEqual(['x-plugin'])
      await h.stop()
    })
  })

  describe('PermissionEngine', () => {
    it('DefaultPermissionEngine: 路径 glob 匹配 allow → allow', async () => {
      const pe = new DefaultPermissionEngine({
        write: { allow: ['src/**'] },
      })
      const r1 = await pe.check({ toolKey: 'write', patterns: ['src/foo.ts'], input: {} })
      expect(r1.behavior).toBe('allow')
      expect(r1.matchedRule).toBe('glob')
      const r2 = await pe.check({ toolKey: 'write', patterns: ['etc/x.conf'], input: {} })
      expect(r2.behavior).toBe('ask') // fallback * (constructor 默认 ask)
    })

    it('工具级简写规则匹配', async () => {
      const pe = new DefaultPermissionEngine({ bash: 'deny', '*': 'ask' })
      const r = await pe.check({ toolKey: 'bash', patterns: ['rm -rf /'], input: {} })
      expect(r.behavior).toBe('deny')
    })
  })

  describe('AgentRuntime + query 单轮（纯文本响应）', () => {
    it('创建会话 → prompt → 输出 assistant 消息，插件修改 llm.params temperature', async () => {
      const cp = mockChatProvider('text')
      const TempPlugin: AgentPlugin = {
        id: 'temp',
        version: '1',
        name: 'Temp',
        async install() {
          return {
            async 'llm.params'(_i, params) {
              params.temperature = 0.2
              params.maxTokens = 2048
            },
            async 'prompt.system.transform'(_i, parts) {
              parts.push('【测试注入】回答要简洁')
            },
          } as Hooks
        },
      }
      const h = await createHarness({
        chatProvider: cp,
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
        agents: [makeAgent()],
        internalPlugins: [TempPlugin],
      })
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })
      expect(reply.role).toBe('assistant')
      expect(reply.parts.some((p: any) => p.type === 'text' && p.text.includes('你好'))).toBe(true)
      expect((reply.meta as any)?.model).toBe('mock-v1')
      // 温度和 prompt fragment 注入生效
      expect(cp.calls).toHaveLength(1)
      const { params, messages } = cp.calls[0]
      expect(params.temperature).toBe(0.2)
      expect(params.maxTokens).toBe(2048)
      const sysMsg = messages.find((m: Message) => m.role === 'system') as Message | undefined
      expect(sysMsg).toBeDefined()
      const sysText = (sysMsg!.parts[0] as any).text as string
      expect(sysText).toContain('【测试注入】回答要简洁')
      expect(sysText).toContain('helpful test assistant')
      await h.stop()
    })
  })

  describe('AgentRuntime + ToolPipeline 联动（tool call）', () => {
    it('模型返回 toolCall → 执行 echo 工具 → tool.pre.execute / tool.post.execute Hook 生效', async () => {
      const cp = mockChatProvider('tool')
      const register: string[] = []
      const HooksPlugin: AgentPlugin = {
        id: 'hooks',
        version: '1',
        name: 'Hooks',
        async install(ctx) {
          ctx.bus  // 验证 ctx 注入
          return {
            async 'tool.pre.execute'(ctx: any, next: any) {
              register.push(`pre:${ctx.tool.id}`)
              // 修改输入
              const modified = { ...(ctx.input as any), msg: (ctx.input as any).msg + '+pre' }
              return next(modified)
            },
            async 'tool.post.execute'(ctx: any, result: ToolResult) {
              register.push(`post:${ctx.tool.id}`)
              return { ...result, output: { reply: (result.output as any).reply + '+post' } }
            },
          } as Hooks
        },
      }
      const ToolPlugin: AgentPlugin = {
        id: 'tools',
        version: '1',
        name: 'Tools',
        async install() {
          return {
            async 'tool.pool.assemble'(_i, pool: any) {
              pool.add(createEchoTool())
              register.push('pool.assemble')
            },
          } as Hooks
        },
      }
      const h = await createHarness({
        chatProvider: cp,
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
        agents: [makeAgent()],
        internalPlugins: [ToolPlugin, HooksPlugin],
      })
      expect(h.tools.has('echo')).toBe(false) // 组装前不注册全局
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '调用工具试试' })
      expect(reply.role).toBe('assistant')
      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart).toBeDefined()
      expect(toolPart.toolId).toBe('echo')
      // pre 改输入 msg: 'hi' → 'hi+pre'，echo 返回 echo:hi+pre，post 加 +post
      expect((toolPart.result as any).reply).toBe('echo:hi+pre+post')
      // hook 调用顺序
      expect(register).toEqual(['pool.assemble', 'pre:echo', 'post:echo'])
      await h.stop()
    })
  })

  describe('Session snapshot / revert / unrevert', () => {
    it('snapshot → add message → revert → unrevert', async () => {
      const h = await createHarness({ chatProvider: mockChatProvider() })
      const s = await h.session.create({ title: 't1' })
      const m: Message = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a' }], createdAt: Date.now() }
      await h.session.addMessage(s.id, m)
      const snap = await h.session.snapshot(s.id)
      await h.session.addMessage(s.id, { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'b' }], createdAt: Date.now() })
      expect((await h.session.get(s.id))!.messages).toHaveLength(2)
      await h.session.revert(s.id, snap)
      expect((await h.session.get(s.id))!.messages).toHaveLength(1)
      await h.session.unrevert(s.id, snap)
      expect((await h.session.get(s.id))!.messages).toHaveLength(2)
      await h.stop()
    })
  })

  describe('Harness lifecycle Bus 事件', () => {
    it('start / stop 发出对应事件 + stop 卸载所有插件', async () => {
      const bus = new InMemoryBus()
      const evs = makeBusLogger(bus)
      const P: AgentPlugin = {
        id: 'p1', version: '1', name: 'P1',
        async install() { return {} },
        async uninstall() { /* 标记 */ (globalThis as any).__uninstalled = true },
      }
      const h = await createHarness({ bus, internalPlugins: [P] })
      await h.start()
      await h.stop()
      expect(evs.map((e) => e.name)).toEqual(
        expect.arrayContaining([
          'harness.initializing', 'harness.initialized',
          'harness.starting', 'harness.started',
          'harness.stopping', 'harness.stopped',
        ])
      )
      expect((globalThis as any).__uninstalled).toBe(true)
      delete (globalThis as any).__uninstalled
    })

    it('start 阶段抛错 → harness.error(stage=start) 发布且错误被抛出', async () => {
      const bus = new InMemoryBus()
      const evs = makeBusLogger(bus)
      const Bad: AgentPlugin = {
        id: 'bad', version: '1', name: 'bad',
        async install() {
          return {
            async 'harness.start'() { throw new Error('start-boom') },
          } as Hooks
        },
      }
      const h = await createHarness({ bus, internalPlugins: [Bad] })
      const err = await h.start().then(() => null, (e) => e)
      expect(err?.message).toContain('start-boom')
      const errEv = evs.find((e) => e.name === 'harness.error') as BusEventRecord<{ stage: string }> | undefined
      expect(errEv?.payload.stage).toBe('start')
      await h.stop()
    })
  })

  describe('tool.pool.assemble Hook 按 Agent 白名单限制工具', () => {
    it('agent.tools whitelist 限制为 ["echo"] 未注册的工具不被执行', async () => {
      const cp = mockChatProvider('tool')
      const ToolPlugin: AgentPlugin = {
        id: 'tools', version: '1', name: 'Tools',
        async install() {
          return {
            async 'tool.pool.assemble'(_i, pool: any) {
              pool.add(createEchoTool())
              // 第二个工具模型不会选到，同时也不在 agent.tools 里
              const other = defineTool({
                id: 'other',
                description: '其他工具',
                inputSchema: { parse: (v: any) => v, safeParse: (v: any) => ({ success: true, data: v }) },
                async call(_i): Promise<ToolResult> { return { ok: true, output: 'nope' } },
              })
              pool.add(other)
            },
          } as Hooks
        },
      }
      const h = await createHarness({
        chatProvider: cp,
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
        agents: [makeAgent({ tools: ['echo'] as any })],
        internalPlugins: [ToolPlugin],
      })
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: 'x' })
      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart.toolId).toBe('echo')
      // 成功执行
      expect((toolPart.result as any).reply).toBe('echo:hi')
      await h.stop()
    })
  })

  describe('bus.event 桥（Plugin hooks → Bus publish）', () => {
    it('插件声明 bus.event Hook 能订阅 Harness lifecycle 事件', async () => {
      const bus = new InMemoryBus()
      const received: string[] = []
      // 在 bus 侧额外订阅，用于接收插件卸载后发出的 stopped 事件
      const busSide: string[] = []
      ;(bus as any).subscribeAll((e: BusEventRecord) => busSide.push(e.name))
      const P: AgentPlugin = {
        id: 'spy', version: '1', name: 'Spy',
        async install() {
          return {
            async 'bus.event'(rec: any) { received.push(rec.name) },
          } as Hooks
        },
      }
      const h = await createHarness({ bus, internalPlugins: [P] })
      await h.start()
      await h.stop()
      // plugin side：internalPlugins 是在 publish(initializing) 之后才 install，所以
      // 只能收到 initializing 之后的初始化事件：initialized + starting/started + stopping
      expect(received).toEqual(
        expect.arrayContaining([
          'harness.initialized',
          'harness.starting',
          'harness.started',
          'harness.stopping',
        ])
      )
      // plugin 卸载在前，所以收不到 stopped
      expect(received).not.toContain('harness.stopped')
      // 但 bus.subscribeAll 侧能收到完整 lifecycle（包括 initializing）
      expect(busSide).toEqual(
        expect.arrayContaining([
          'harness.initializing', 'harness.initialized',
          'harness.starting', 'harness.started',
          'harness.stopping', 'harness.stopped',
        ])
      )
    })
  })
})
