import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

  describe('agent.mcpServers 按 MCP server 粒度过滤工具', () => {
    /** 装两个 MCP server 的工具（gh / fs）；agent 级 mcp 声明经 core filterMcpTools 参与 allowedTools 组装，
     *  算法正确性由 @harness/tool filterMcpTools 单测覆盖，此处验证 query 装配链路接线不破坏执行 + 缺省向后兼容。 */
    function buildHarness(agentOverride: Partial<AgentDefinition>, chooseToolId: string) {
      const McpPlugin: AgentPlugin = {
        id: 'mcp-tools', version: '1', name: 'McpTools',
        async install() {
          return {
            async 'tool.pool.assemble'(_i, pool: any) {
              for (const [server, tool] of [['gh', 'create_issue'], ['fs', 'read']] as const) {
                pool.add(defineTool({
                  id: `mcp__${server}__${tool}`,
                  description: `${server}/${tool}`,
                  inputSchema: { parse: (v: any) => v, safeParse: (v: any) => ({ success: true, data: v }) },
                  async call(): Promise<ToolResult> { return { ok: true, output: 'ok' } },
                }))
              }
            },
          } as Hooks
        },
      }
      return createHarness({
        chatProvider: mockChatProvider('tool', (p: any) => ({
          content: '',
          model: 'mock-v1',
          tokenUsage: { input: 5, output: 2 },
          toolCalls: [{ toolUseId: 'tu_1', toolId: chooseToolId, input: {} }],
        })),
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
        agents: [makeAgent({ tools: ['*'], ...agentOverride })],
        internalPlugins: [McpPlugin],
      })
    }
    async function runQuery(h: Harness, chooseToolId: string) {
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: 'x' })
      return reply.parts.find((p: any) => p.type === 'tool') as any
    }

    it('白名单 server 内工具经 query 装配可执行', async () => {
      const h = await buildHarness({ mcpServers: ['gh'] }, 'mcp__gh__create_issue')
      const toolPart = await runQuery(h, 'mcp__gh__create_issue')
      expect(toolPart.toolId).toBe('mcp__gh__create_issue')
      await h.stop()
    })

    it('缺省 mcpServers → 全部 MCP server 工具可执行（向后兼容）', async () => {
      const h = await buildHarness({}, 'mcp__fs__read')
      const toolPart = await runQuery(h, 'mcp__fs__read')
      expect(toolPart.toolId).toBe('mcp__fs__read')
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

  describe('Session Compaction', () => {
    function makeSessionMessages(n: number): Message[] {
      const out: Message[] = []
      for (let i = 0; i < n; i++) {
        out.push({
          id: `u_${i}`,
          role: 'user',
          parts: [{ type: 'text', text: `第${i}轮用户问题：${'x'.repeat(50)}` }],
          createdAt: Date.now() + i * 2,
        })
        out.push({
          id: `a_${i}`,
          role: 'assistant',
          parts: [{ type: 'text', text: `回复第${i}轮：${'y'.repeat(80)}` }],
          createdAt: Date.now() + i * 2 + 1,
        })
      }
      return out
    }

    /** 用 addMessage 填充 N 轮 user/assistant */
    async function fillMessages(h: Harness, sessionId: string, rounds: number) {
      for (const m of makeSessionMessages(rounds)) await h.session.addMessage(sessionId, m)
    }

    it('summary 策略：压缩后 messages 变短，摘要写入 CompactMemory，统计正确', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      await fillMessages(h, sess.id, 10)
      await h.session.compact(sess.id, 'summary', { keepRecentMessages: 6 })
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBe(6)
      const info = await h.session.getCompactionInfo(sess.id)
      expect(info.meta?.count).toBe(1)
      expect(info.meta?.lastStrategy).toBe('summary')
      expect(info.meta?.lastMessagesBefore).toBe(20)
      expect(info.meta?.lastMessagesAfter).toBe(6)
      expect(info.meta?.totalPrunedMessages).toBe(14)
      expect(info.memory?.round).toBe(1)
      expect(info.memory?.summaryText).toBeTruthy()
      expect(info.memory!.summaryText!.length).toBeGreaterThan(20)
      await h.stop()
    })

    it('prune 策略：只截断，不生成摘要文本', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      await fillMessages(h, sess.id, 8)
      await h.session.compact(sess.id, 'prune', { keepRecentMessages: 4 })
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBe(4)
      const info = await h.session.getCompactionInfo(sess.id)
      expect(info.meta?.lastStrategy).toBe('prune')
      // prune 策略不产生新 summary，但 memory.round 仍递增
      expect(info.memory?.round).toBe(1)
      await h.stop()
    })

    it('compactIfNeeded 阈值命中时压缩，否则 no-op', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      // 2 条消息 ~38 tokens < 阈值 100 → 不压缩
      await fillMessages(h, sess.id, 1)
      const did1 = await h.session.compactIfNeeded(sess.id, { thresholdTokens: 100 })
      expect(did1).toBe(false)
      // 20 条消息 ~750 tokens ≥ 阈值 100 → 压缩
      await fillMessages(h, sess.id, 9) // 已有 2 条 + 18 = 20 条
      const did2 = await h.session.compactIfNeeded(sess.id, { thresholdTokens: 100 })
      expect(did2).toBe(true)
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBeLessThan(20)
      await h.stop()
    })

    it('compactIfNeeded 百分比阈值：默认 80% 可用窗口才触发', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      await fillMessages(h, sess.id, 10) // 20 条消息，估算 token 远低于 136K
      // 默认参数：(200000 - 30000) * 0.8 = 136000，20 条消息约 750 tokens → 不触发
      const did1 = await h.session.compactIfNeeded(sess.id, {})
      expect(did1).toBe(false)
      // 用小窗口 + 高百分比触发：contextWindow=500, reserved=100, pct=80 → 阈值=320
      // 20 条消息约 750 tokens ≥ 320 → 触发
      const did2 = await h.session.compactIfNeeded(sess.id, {
        contextWindowTokens: 500,
        reservedTokens: 100,
        autoCompactThresholdPct: 80,
      })
      expect(did2).toBe(true)
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBeLessThan(20)
      await h.stop()
    })

    it('AgentRuntime.query 把 CompactMemory 注入为 system prompt 片段', async () => {
      const provider = mockChatProvider('text')
      const h = await createHarness({ agents: [makeAgent()], chatProvider: provider })
      const sess = await h.session.create()
      await fillMessages(h, sess.id, 6)
      // 先压缩一轮，产生 memory.summaryText
      await h.session.compact(sess.id, 'summary', { keepRecentMessages: 4 })
      const info = await h.session.getCompactionInfo(sess.id)
      expect(info.memory?.summaryText).toBeTruthy()
      await h.start()
      await h.agent.query({ sessionId: sess.id, agentId: 'default', message: '测试一下' })
      await h.stop()
      expect(provider.calls.length).toBeGreaterThan(0)
      const lastCall = provider.calls[provider.calls.length - 1]
      const sysMsg = (lastCall.messages as Message[]).find((m) => m.role === 'system')
      expect(sysMsg).toBeTruthy()
      const texts = sysMsg!.parts.filter((p: any) => p.type === 'text').map((p: any) => String(p.text))
      const combined = texts.join('\n')
      expect(combined).toContain('会话压缩记忆')
      expect(combined).toContain(`压缩轮次：${info.memory!.round}`)
      expect(combined).toContain(info.memory!.summaryText!.slice(0, 60))
    })
  })

  describe('Session Compaction · 阶段二 Route B（blocks + 原文归档 + 精简视图）', () => {
    function makeSessionMessages(n: number): Message[] {
      const out: Message[] = []
      for (let i = 0; i < n; i++) {
        out.push({ id: `u_${i}`, role: 'user', parts: [{ type: 'text', text: `问题${i}: ${'x'.repeat(40)}` }], createdAt: Date.now() + i * 2 })
        out.push({ id: `a_${i}`, role: 'assistant', parts: [{ type: 'text', text: `回复${i}: ${'y'.repeat(40)}` }], createdAt: Date.now() + i * 2 + 1 })
      }
      return out
    }
    async function fill(h: Harness, sid: string, n: number) {
      for (const m of makeSessionMessages(n)) await h.session.addMessage(sid, m)
    }

    it('compact 产 block（带 origKey 断点）并调用原文归档，messages 瘦到 keepRecent', async () => {
      const saved: Array<{ key: string; msgs: Message[] }> = []
      const originalStore = {
        save: async (sid: string, key: string, msgs: Message[]) => { saved.push({ key, msgs }); return `${sid}/${key}` },
        load: async () => undefined,
      }
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider(), originalStore })
      const sess = await h.session.create()
      await fill(h, sess.id, 6)
      expect((await h.session.get(sess.id))!.messages.length).toBe(12)
      await h.session.compact(sess.id, 'summary', { keepRecentMessages: 4 })
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBe(4)
      expect(s.blocks?.length).toBe(1)
      const block = s.blocks![0]
      expect(block.topic).toBe('会话压缩')
      expect(block.startId).toBe('u_0')
      expect(block.endId).toBe('a_3')
      expect(block.origKey).toBe(block.id)
      // 原文归档被调用，且归档内容=被压缩窗口（12 条 → keepRecent 4 → 归档 8 条）
      expect(saved.length).toBe(1)
      expect(saved[0].msgs.length).toBe(8)
      // getView 为精简视图
      const view = await h.session.getView(sess.id)
      expect(view.slimmed).toBe(true)
      expect(view.blocks.length).toBe(1)
      expect(view.messages.length).toBe(4)
      await h.stop()
    })

    it('无 originalStore 时 compact 仍产 block，不阻断、不归档', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      await fill(h, sess.id, 5)
      await h.session.compact(sess.id, 'prune', { keepRecentMessages: 4 })
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBe(4)
      expect(s.blocks?.length).toBe(1)
      await h.stop()
    })

    it('windowHandled（ACP 认领）：跳过 .cmp.orig 归档与 generic 块，应用 blocksPatch 的 acp 块', async () => {
      const saved: Array<{ key: string; msgs: Message[] }> = []
      const originalStore = {
        save: async (sid: string, key: string, msgs: Message[]) => { saved.push({ key, msgs }); return `${sid}/${key}` },
        load: async () => undefined,
      }
      const acpLike: AgentPlugin = {
        id: 'acp-like',
        version: '1',
        name: 'acp-like',
        async install(ctx) {
          return {
            'session.compacting': async (_input, output) => {
              output.windowHandled = true
              output.blocksPatch = [
                { id: 'b_acp_1', summary: 'ACP折叠摘要', startId: 'u_0', endId: 'a_3', source: 'acp', archiveRef: 'acp:1' },
              ]
            },
          }
        },
      }
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider(), originalStore, internalPlugins: [acpLike] })
      const sess = await h.session.create()
      await fill(h, sess.id, 6)
      await h.session.compact(sess.id, 'summary', { keepRecentMessages: 4 })
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBe(4) // 仍物理截断
      expect(saved.length).toBe(0) // ACP 已保全，不再重复归档
      expect(s.blocks?.length).toBe(1)
      expect(s.blocks![0].source).toBe('acp')
      expect(s.blocks![0].id).toBe('b_acp_1')
      expect(s.blocks![0].archiveRef).toBe('acp:1')
      const view = await h.session.getView(sess.id)
      expect(view.slimmed).toBe(true)
      await h.stop()
    })

    it('未设 windowHandled 时产 source:\'generic\' 块并归档（默认行为）', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      await fill(h, sess.id, 5)
      await h.session.compact(sess.id, 'summary', { keepRecentMessages: 4 })
      const s = (await h.session.get(sess.id))!
      expect(s.blocks?.length).toBe(1)
      expect(s.blocks![0].source).toBe('generic')
      expect(s.blocks![0].origKey).toBe(s.blocks![0].id)
      await h.stop()
    })

    it('session.preModel 回传 blocksPatch：每轮内部折叠的 acp 块合并进 session.blocks（幂等去重）', async () => {
      const acpLike: AgentPlugin = {
        id: 'acp-premodel',
        version: '1',
        name: 'acp-premodel',
        async install(ctx) {
          return {
            'session.preModel': async (input, _msgs) => {
              // 每轮内部折叠产出一个 source:'acp' 块（模拟 runPreModel 折叠）
              input.blocksPatch?.push({
                id: 'acp_b_c1',
                topic: 'ACP 每轮折叠',
                summary: '内部折叠摘要',
                startId: 'u_0',
                endId: 'a_3',
                source: 'acp',
                archiveRef: 'acp:s1:c1',
              })
            },
          }
        },
      }
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider(), internalPlugins: [acpLike] })
      const sess = await h.session.create()
      await fill(h, sess.id, 4)
      // 两轮 query：同一块 id 重复回传 → session.blocks 只保留一条（幂等去重覆盖）
      await h.agent.query({ sessionId: sess.id, message: '第一轮' })
      await h.agent.query({ sessionId: sess.id, message: '第二轮' })
      const s = (await h.session.get(sess.id))!
      expect(s.blocks?.length).toBe(1)
      expect(s.blocks![0].source).toBe('acp')
      expect(s.blocks![0].id).toBe('acp_b_c1')
      expect(s.blocks![0].archiveRef).toBe('acp:s1:c1')
      expect(typeof s.blocks![0].at).toBe('number')
      await h.stop()
    })

    it('compact 后 query 的请求历史 = 摘要占位 + 近期，不含被压缩原文消息', async () => {
      const provider = mockChatProvider() // 收集 calls
      const h = await createHarness({ agents: [makeAgent()], chatProvider: provider })
      const sess = await h.session.create()
      await fill(h, sess.id, 6)
      await h.session.compact(sess.id, 'summary', { keepRecentMessages: 4 })
      await h.start()
      await h.agent.query({ sessionId: sess.id, agentId: 'default', message: '再来一轮' })
      await h.stop()
      const lastCall = provider.calls[provider.calls.length - 1]
      const msgs = lastCall.messages as Message[]
      // 仅取真实用户消息（排除摘要占位这类以 ===COMPACTED 开头的合成 user 消息）
      const userOnly = msgs
        .filter((m) => m.role === 'user')
        .map((m) => {
          const t = m.parts.find((p: any) => p.type === 'text')
          return String((t as any)?.text ?? '')
        })
        .filter((t) => !t.startsWith('===COMPACTED'))
      // 请求历史含摘要占位，但不含被压缩的原文消息（u_0 明文不该进入请求）
      expect(userOnly.join('\n')).not.toContain('问题0')
      const view = await h.session.getView(sess.id)
      expect(view.slimmed).toBe(true)
    })
  })

  describe('AgentRuntime + snapshot 自动捕获挂载（meta.snapshot）', () => {
    it('注入 snapshot 工厂后，query 的 assistant 消息携带 meta.snapshot.start（首轮 files 为空）', async () => {
      let calls = 0
      const svc = {
        capture: async () => { calls++; return `tree-${calls}` as any },
        files: async () => ['a.txt', 'b.txt'],
      }
      const h = await createHarness({
        agents: [makeAgent()],
        chatProvider: mockChatProvider(),
        snapshot: () => svc as any,
      })
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })

      const snap = (reply.meta as any)?.snapshot
      expect(snap).toBeDefined()
      expect(snap.start).toBe('tree-1')
      // 首轮无上一轮快照基准，files 为空（不对齐 any 旧快照）
      expect(snap.files).toBeUndefined()
    })

    it('queryStream 同样挂载 meta.snapshot', async () => {
      let calls = 0
      const svc = {
        capture: async () => { calls++; return `tree-${calls}` as any },
        files: async () => [],
      }
      const h = await createHarness({
        agents: [makeAgent()],
        chatProvider: mockChatProvider(),
        snapshot: () => svc as any,
      })
      const sess = await h.session.create()
      let last: any
      for await (const ev of h.agent.queryStream({ sessionId: sess.id, message: '流式测试' })) {
        if (ev.type === 'done') last = (ev as any).message
      }
      const snap = (last?.meta as any)?.snapshot
      expect(snap).toBeDefined()
      expect(snap.start).toBe('tree-1')
    })

    it('第二轮 query 的 files 为两轮快照间的变更文件', async () => {
      let snapCount = 0
      const filesCalls: Array<{ from: string; to: string }> = []
      const svc = {
        capture: async () => { snapCount++; return `tree-${snapCount}` as any },
        files: async (from: string, to: string) => { filesCalls.push({ from, to }); return ['c.txt'] },
      }
      const h = await createHarness({
        agents: [makeAgent()],
        chatProvider: mockChatProvider(),
        snapshot: () => svc as any,
      })
      const sess = await h.session.create()
      await h.agent.query({ sessionId: sess.id, message: '第一轮' })
      const second = await h.agent.query({ sessionId: sess.id, message: '第二轮' })

      const snap = (second.meta as any)?.snapshot
      expect(snap.start).toBe('tree-2')
      expect(snap.files).toEqual(['c.txt'])
      expect(filesCalls).toEqual([{ from: 'tree-1', to: 'tree-2' }])
    })

    it('未注入 snapshot 工厂时不挂载 meta.snapshot', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })
      expect((reply.meta as any)?.snapshot).toBeUndefined()
    })

    it('capture 失败（返回 undefined）时 best-effort，不挂载且不中断推理', async () => {
      const h = await createHarness({
        agents: [makeAgent()],
        chatProvider: mockChatProvider(),
        snapshot: () => ({ capture: async () => undefined, files: async () => [] }) as any,
      })
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })
      expect(reply.parts.some((p) => (p as any).type === 'text')).toBe(true)
      expect((reply.meta as any)?.snapshot).toBeUndefined()
    })
  })

  describe('Session Management Enhancement', () => {
    it('自动标题：首条 user 消息截取为 title', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      expect(sess.title).toBeUndefined()
      await h.session.addMessage(sess.id, {
        id: `m_${Date.now()}`,
        role: 'user',
        parts: [{ type: 'text', text: '帮我写一个排序算法并解释原理' }],
        createdAt: Date.now(),
      })
      const updated = (await h.session.get(sess.id))!
      expect(updated.title).toBe('帮我写一个排序算法并解释原理')
      // 第二条 user 消息不覆盖标题
      await h.session.addMessage(sess.id, {
        id: `m_${Date.now() + 1}`,
        role: 'user',
        parts: [{ type: 'text', text: '再来一个搜索算法' }],
        createdAt: Date.now() + 1,
      })
      const updated2 = (await h.session.get(sess.id))!
      expect(updated2.title).toBe('帮我写一个排序算法并解释原理')
      await h.stop()
    })

    it('自动标题：超长消息截取 60 字符', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      const longText = '这是一段非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的用户输入内容需要被截断到六十个字符以内的标题'
      await h.session.addMessage(sess.id, {
        id: `m_${Date.now()}`,
        role: 'user',
        parts: [{ type: 'text', text: longText }],
        createdAt: Date.now(),
      })
      const updated = (await h.session.get(sess.id))!
      expect(updated.title!.length).toBe(60)
      expect(longText.startsWith(updated.title!)).toBe(true)
      await h.stop()
    })

    it('search：关键词搜索匹配消息文本', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const s1 = await h.session.create()
      await h.session.addMessage(s1.id, {
        id: 'm1', role: 'user',
        parts: [{ type: 'text', text: '如何使用 TypeScript 泛型' }],
        createdAt: Date.now(),
      })
      const s2 = await h.session.create()
      await h.session.addMessage(s2.id, {
        id: 'm2', role: 'user',
        parts: [{ type: 'text', text: 'Python 数据分析教程' }],
        createdAt: Date.now(),
      })
      const results = await h.session.search('TypeScript')
      expect(results.length).toBe(1)
      expect(results[0].id).toBe(s1.id)
      // 大小写不敏感
      const results2 = await h.session.search('typescript')
      expect(results2.length).toBe(1)
      // 无匹配
      const results3 = await h.session.search('Java')
      expect(results3.length).toBe(0)
      await h.stop()
    })

    it('exportMarkdown：导出会话为 Markdown 文本', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      await h.session.addMessage(sess.id, {
        id: 'u1', role: 'user',
        parts: [{ type: 'text', text: '你好' }],
        createdAt: Date.now(),
      })
      await h.session.addMessage(sess.id, {
        id: 'a1', role: 'assistant',
        parts: [{ type: 'text', text: '你好！有什么可以帮你的？' }],
        createdAt: Date.now() + 1,
      })
      const md = await h.session.exportMarkdown(sess.id)
      expect(md).toContain('# 你好')
      expect(md).toContain('**User**')
      expect(md).toContain('你好！有什么可以帮你的？')
      expect(md).toContain('**Assistant**')
      await h.stop()
    })
  })

  describe('多 Provider 自由切换（按 providerId 分发）', () => {
    function providerWithHit(id: string, hits: Record<string, number>): ChatProvider & { calls: any[]; id: string } {
      return {
        id,
        calls: [],
        async complete(params) {
          hits[id] = (hits[id] ?? 0) + 1
          return {
            content: `来自 ${id} 的回复`,
            model: `${id}-v1`,
            tokenUsage: { input: 1, output: 1 },
          }
        },
        async *stream(params) {
          hits[id] = (hits[id] ?? 0) + 1
          yield { type: 'text_delta', text: '流' }
          yield { type: 'done', model: `${id}-v1`, tokenUsage: { input: 1, output: 1 } }
        },
      }
    }

    it('agent.model.providerId 决定命中哪个 ChatProvider；无 providerId 回退默认', async () => {
      const hits: Record<string, number> = {}
      const pAlpha = providerWithHit('alpha', hits)
      const pBeta = providerWithHit('beta', hits)
      const pGamma = providerWithHit('gamma', hits)

      const h = await createHarness({
        agents: [
          makeAgent({ id: 'use-alpha', model: { providerId: 'alpha', modelId: 'm-alpha' } }),
          makeAgent({ id: 'use-beta', model: { providerId: 'beta', modelId: 'm-beta' } }),
          makeAgent({ id: 'use-gamma', model: { providerId: 'gamma', modelId: 'm-gamma' } }),
          // 无 providerId：回退默认（最后注册的 beta）
          makeAgent({ id: 'use-default', model: { modelId: 'm-bare' } }),
        ],
        chatProvider: pAlpha,
      })
      // 模拟多个 Provider 插件逐个注册（注册表按 id 分发，最后注册的作为默认）
      ;(h as unknown as HarnessImpl)._setChatProvider(pAlpha)
      ;(h as unknown as HarnessImpl)._setChatProvider(pBeta)
      ;(h as unknown as HarnessImpl)._setChatProvider(pGamma)
      // 显式指定默认 = beta（覆盖 context 中最后注册的 gamma）
      ;(h as unknown as HarnessImpl)._setChatProvider(pBeta)

      await h.start()
      const sess = await h.session.create()
      await h.agent.query({ sessionId: sess.id, agentId: 'use-alpha', message: 'hi' })
      await h.agent.query({ sessionId: sess.id, agentId: 'use-beta', message: 'hi' })
      await h.agent.query({ sessionId: sess.id, agentId: 'use-gamma', message: 'hi' })
      await h.agent.query({ sessionId: sess.id, agentId: 'use-default', message: 'hi' })
      await h.stop()

      expect(hits.alpha).toBe(1)
      expect(hits.beta).toBe(2) // use-beta 显式分发 + use-default 回退默认
      expect(hits.gamma).toBe(1)
    })

    it('resolveChatProvider：命中注册表 / 回退默认 / 未知 id 回退默认', () => {
      const hits: Record<string, number> = {}
      const pAlpha = providerWithHit('alpha', hits)
      const pBeta = providerWithHit('beta', hits)
      const pLegacy = providerWithHit('legacy', hits)
      const impl = new HarnessImpl({
        cwd: process.cwd(),
        chatProvider: pLegacy,
      } as any)
      impl._setChatProvider(pAlpha)
      impl._setChatProvider(pBeta)
      expect(impl.resolveChatProvider('alpha')).toBe(pAlpha)
      expect(impl.resolveChatProvider('beta')).toBe(pBeta)
      // 'default' 与未注册 id 均回退默认（最后注册的 beta）
      expect(impl.resolveChatProvider('default')).toBe(pBeta)
      expect(impl.resolveChatProvider('nonexistent')).toBe(pBeta)
      expect(impl.resolveChatProvider(undefined)).toBe(pBeta)
    })
  })

  describe('SessionManager.setId 重命名会话', () => {
    it('setId 同步更新内部索引，按新 id 可查得同一会话', async () => {
      const h = await createHarness({ chatProvider: mockChatProvider() })
      const sess = await h.session.create({ title: 'tmp' })
      const oldId = sess.id
      await h.session.addMessage(sess.id, { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a' }], createdAt: Date.now() })
      const renamed = await h.session.setId(oldId, 's_custom')
      expect(renamed.id).toBe('s_custom')
      // 旧 id 不再命中，新 id 命中且消息保留
      expect(await h.session.get(oldId)).toBeUndefined()
      const found = await h.session.get('s_custom')
      expect(found?.id).toBe('s_custom')
      expect(found?.messages).toHaveLength(1)
      await h.stop()
    })

    it('setId 不存在的会话抛错', async () => {
      const h = await createHarness({ chatProvider: mockChatProvider() })
      await expect(h.session.setId('nope', 'new')).rejects.toThrow('nope')
      await h.stop()
    })
  })

  describe('多级目录加载（MultiDirLoader 收敛）', () => {
    function makeAgentMd(name: string, tag: string): string {
      return `---
name: ${name}
mode: primary
tools: ['*']
permission: allow
---
${tag} 版 body
`
    }

    it('agentDirs：user → project 多级加载，同名 agent 后加载（project）覆盖先加载（user）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'harness-agents-'))
      try {
        const userAgents = join(root, 'user', 'agents')
        const projectAgents = join(root, 'project', 'agents')
        mkdirSync(userAgents, { recursive: true })
        mkdirSync(projectAgents, { recursive: true })
        writeFileSync(join(userAgents, 'worker.md'), makeAgentMd('User Worker', 'user'))
        writeFileSync(join(projectAgents, 'worker.md'), makeAgentMd('Project Worker', 'project'))
        writeFileSync(join(userAgents, 'only-user.md'), makeAgentMd('Only User', 'user'))

        const h = await createHarness({
          chatProvider: mockChatProvider(),
          agentDirs: [
            { dir: userAgents, source: 'user' },
            { dir: projectAgents, source: 'project' },
          ],
        })
        // project 覆盖 user
        expect(h.agent.get('worker')?.name).toBe('Project Worker')
        // 仅 user 有的保留
        expect(h.agent.get('only-user')?.name).toBe('Only User')
        await h.stop()
      } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('skillDirs：从目录加载 SKILL.md（目录形式 + 单文件形式）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'harness-skills-'))
      try {
        const userSkills = join(root, 'user', 'skills')
        const projectSkills = join(root, 'project', 'skills')
        // 目录形式：greet/SKILL.md
        mkdirSync(join(userSkills, 'greet'), { recursive: true })
        writeFileSync(join(userSkills, 'greet', 'SKILL.md'), '---\nname: Greet\n---\n问候一下。\n')
        // 单文件形式：summarize.md
        writeFileSync(join(userSkills, 'summarize.md'), '---\nname: Summarize\n---\n总结。\n')
        // project 同名覆盖 greet
        mkdirSync(join(projectSkills, 'greet'), { recursive: true })
        writeFileSync(join(projectSkills, 'greet', 'SKILL.md'), '---\nname: Greet Pro\n---\n专业问候。\n')

        const h = await createHarness({
          chatProvider: mockChatProvider(),
          skillDirs: [
            { dir: userSkills, source: 'user' },
            { dir: projectSkills, source: 'project' },
          ],
        })
        const all = h.skillManager?.all() ?? []
        expect(all.some((s) => s.id === 'summarize')).toBe(true)
        // 同名 greet 被 project 覆盖（name 取 project 版）
        expect(all.find((s) => s.id === 'greet')?.name).toBe('Greet Pro')
        await h.stop()
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  })
})
