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
  DefaultSessionManager,
  ChatCompletionOutput,
  ChatProvider,
  DefaultPermissionEngine,
  BusEventRecord,
  extractFilePaths,
  stableStringify,
  shortHash,
  resultPayload,
  ProviderEvents,
} from './index'
import { defineTool, Tool, ToolResult, Schema } from './index'
import type { AgentPlugin, Hooks, Message, ProviderRuntime } from './index'
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

    it('core.harness.init / core.harness.start hooks 被触发', async () => {
      const steps: string[] = []
      const P: AgentPlugin = {
        id: 'p1',
        version: '1',
        name: 'P1',
        async install() {
          return {
            async 'core.harness.init'(_i, o) {
              steps.push('init')
              expect((o as any).harness).toBeDefined()
            },
            async 'core.harness.start'(_i, _o) {
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
    it('创建会话 → prompt → 输出 assistant 消息，插件修改 core.llm.params temperature', async () => {
      const cp = mockChatProvider('text')
      const TempPlugin: AgentPlugin = {
        id: 'temp',
        version: '1',
        name: 'Temp',
        async install() {
          return {
            async 'core.llm.params'(_i, params) {
              params.temperature = 0.2
              params.maxTokens = 2048
            },
            async 'core.prompt.system.transform'(_i, parts) {
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
    it('模型返回 toolCall → 执行 echo 工具 → core.tool.pre.execute / core.tool.post.execute Hook 生效', async () => {
      const cp = mockChatProvider('tool')
      const register: string[] = []
      const HooksPlugin: AgentPlugin = {
        id: 'hooks',
        version: '1',
        name: 'Hooks',
        async install(ctx) {
          ctx.bus  // 验证 ctx 注入
          return {
            async 'core.tool.pre.execute'(ctx: any, next: any) {
              register.push(`pre:${ctx.tool.id}`)
              // 修改输入
              const modified = { ...(ctx.input as any), msg: (ctx.input as any).msg + '+pre' }
              return next(modified)
            },
            async 'core.tool.post.execute'(ctx: any, result: ToolResult) {
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
            async 'core.tool.pool.assemble'(_i, pool: any) {
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
      // maxSteps: 1 —— 本用例只验证「单轮工具执行 + pre/post hook」；
      // 该 mock provider 每次都返回同一个 toolCall，若放任自主多步会一路跑到 doom-loop 拦截。
      const reply = await h.agent.query({ sessionId: sess.id, message: '调用工具试试', maxSteps: 1 })
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
            async 'core.harness.start'() { throw new Error('start-boom') },
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

  describe('core.tool.pool.assemble Hook 按 Agent 白名单限制工具', () => {
    it('agent.tools whitelist 限制为 ["echo"] 未注册的工具不被执行', async () => {
      const cp = mockChatProvider('tool')
      const ToolPlugin: AgentPlugin = {
        id: 'tools', version: '1', name: 'Tools',
        async install() {
          return {
            async 'core.tool.pool.assemble'(_i, pool: any) {
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
      // maxSteps: 1 —— 理由同上：本用例只验证白名单工具能被执行
      const reply = await h.agent.query({ sessionId: sess.id, message: 'x', maxSteps: 1 })
      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart.toolId).toBe('echo')
      // 成功执行
      expect((toolPart.result as any).reply).toBe('echo:hi')
      await h.stop()
    })

    /**
     * 回归守卫（真机 s_1790592617954_axqkk）：
     *
     * reader 的 `tools:` 只给了 read_file/list_dir/glob/grep_file，`compress` 却调用成功。
     * 根因是执行期解析多了个回落：`allowedTools.find(...) ?? toolRegistry.get(...)`
     * —— 一旦模型点名一个"**已注册**、但不在白名单"的工具，就会从全局注册表取到实例并执行，
     * `tools:` 这条硬边界形同虚设（`tools: []` 同样被架空）。
     *
     * 断言三件：① 工具**没真被调用**；② 结果里是明确的"不在可用范围"失败（不是静默 undefined）；
     * ③ 审计 hook `core.tool.whitelist.blocked` 有触达。
     */
    it('已注册但不在白名单的工具**拒绝执行**（fail-closed，而非从全局注册表回落）', async () => {
      let otherCalled = false
      const ToolPlugin: AgentPlugin = {
        id: 'tools', version: '1', name: 'Tools',
        async install() {
          return {
            async 'core.tool.pool.assemble'(_i, pool: any) {
              pool.add(createEchoTool())
              pool.add(defineTool({
                id: 'compress',
                description: '已注册、但不在本 agent 白名单内',
                inputSchema: { parse: (v: any) => v, safeParse: (v: any) => ({ success: true, data: v }) },
                async call(): Promise<ToolResult> { otherCalled = true; return { ok: true, output: 'should-not-run' } },
              }))
            },
          } as Hooks
        },
      }
      const cp = mockChatProvider('tool', () => ({
        content: '',
        model: 'mock-v1',
        tokenUsage: { input: 5, output: 2 },
        toolCalls: [{ toolUseId: 'tu_1', toolId: 'compress', input: {} }],
      }))
      const blocked: unknown[] = []
      const AuditProbe: AgentPlugin = {
        id: 'audit-probe', version: '1', name: 'AuditProbe',
        async install() {
          return { 'core.tool.whitelist.blocked': (input: unknown) => { blocked.push(input) } } as Hooks
        },
      }
      const h = await createHarness({
        chatProvider: cp,
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
        agents: [makeAgent({ tools: ['echo'] as any })],
        internalPlugins: [ToolPlugin, AuditProbe],
      })
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: 'x', maxSteps: 1 })
      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart.toolId).toBe('compress')
      // ① 越界工具没有被真正执行
      expect(otherCalled).toBe(false)
      // ② 回喂明确原因（`TOOL_NOT_ALLOWED`），不是静默 undefined
      expect(toolPart.isError).toBe(true)
      expect((toolPart.result as any)?.code).toBe('TOOL_NOT_ALLOWED')
      // ③ 审计 hook 触达且带得动 id
      expect(blocked.length).toBe(1)
      expect((blocked[0] as { toolId?: string }).toolId).toBe('compress')
      await h.stop()
    })

    /**
     * `tools: []` 是"一个都不给"（与"未声明 ⇒ 回落只读哨兵"不同，见 AGENTS.md）。
     * 同一条回落也会架空它 —— 显式空白名单下任何工具调用都该被拒。
     */
    it('tools: []（一个都不给）下任何工具调用都被拒，不再从全局注册表回落', async () => {
      let echoCalled = false
      const ToolPlugin: AgentPlugin = {
        id: 'tools', version: '1', name: 'Tools',
        async install() {
          return {
            async 'core.tool.pool.assemble'(_i, pool: any) {
              pool.add(defineTool({
                id: 'echo',
                description: '返回传入的 msg',
                inputSchema: { parse: (v: any) => v, safeParse: (v: any) => ({ success: true, data: v }) },
                async call(): Promise<ToolResult> { echoCalled = true; return { ok: true, output: { reply: 'echo:hi' } } },
              }))
            },
          } as Hooks
        },
      }
      const h = await createHarness({
        chatProvider: mockChatProvider('tool'), // 默认就调 echo
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
        agents: [makeAgent({ tools: [] as any })],
        internalPlugins: [ToolPlugin],
      })
      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: 'x', maxSteps: 1 })
      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(echoCalled).toBe(false)
      expect((toolPart.result as any)?.code).toBe('TOOL_NOT_ALLOWED')
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
            async 'core.tool.pool.assemble'(_i, pool: any) {
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
    async function runQuery(h: Harness, _chooseToolId: string) {
      const sess = await h.session.create()
      // maxSteps: 1 —— mock provider 每次都回同一个 tool call，不限步会先撞 DOOM_LOOP，
      // 那样断言到的就不是白名单判定结果了。
      const reply = await h.agent.query({ sessionId: sess.id, message: 'x', maxSteps: 1 })
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

    // ── 修复回归：`mcpServers` 是**供给**语义，不是"二次过滤" ──
    // 修复前 `_prepareQueryOnce` 写的是 `filterMcpTools(filterByWhitelist(agent.tools), ...)`，
    // 第二阶段只能做减法，而 MCP 工具在第一步（显式列表）就已被剔掉 ⇒ 声明了 server 也拿到 0 个。
    it('★ 显式 tools 列表 + 声明 mcpServers ⇒ 该 server 的工具被供给（修复前被 TOOL_NOT_ALLOWED 挡掉）', async () => {
      const h = await buildHarness({ tools: ['read_file'], mcpServers: ['gh'] } as any, 'mcp__gh__create_issue')
      const toolPart = await runQuery(h, 'mcp__gh__create_issue')
      expect(toolPart.toolId).toBe('mcp__gh__create_issue')
      expect(toolPart.isError).toBeFalsy()
      await h.stop()
    })

    it('显式 tools 列表 + 未声明 mcpServers ⇒ 不供给（不给没声明 MCP 的 agent 静默扩权）', async () => {
      const h = await buildHarness({ tools: ['read_file'] } as any, 'mcp__gh__create_issue')
      const toolPart = await runQuery(h, 'mcp__gh__create_issue')
      expect((toolPart.result as any)?.code).toBe('TOOL_NOT_ALLOWED')
      await h.stop()
    })

    it('tools: [] 是绝对逃生口 ⇒ 连 mcpServers 声明的工具也不给', async () => {
      const h = await buildHarness({ tools: [], mcpServers: ['gh'] } as any, 'mcp__gh__create_issue')
      const toolPart = await runQuery(h, 'mcp__gh__create_issue')
      expect((toolPart.result as any)?.code).toBe('TOOL_NOT_ALLOWED')
      await h.stop()
    })
  })

  describe('core.bus.event 桥（Plugin hooks → Bus publish）', () => {
    it('插件声明 core.bus.event Hook 能订阅 Harness lifecycle 事件', async () => {
      const bus = new InMemoryBus()
      const received: string[] = []
      // 在 bus 侧额外订阅，用于接收插件卸载后发出的 stopped 事件
      const busSide: string[] = []
      ;(bus as any).subscribeAll((e: BusEventRecord) => busSide.push(e.name))
      const P: AgentPlugin = {
        id: 'spy', version: '1', name: 'Spy',
        async install() {
          return {
            async 'core.bus.event'(rec: any) { received.push(rec.name) },
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

    /** 施加 n 对中文 user/assistant 消息（默认每条 1000 字，用于撑到万级 token） */
    async function fillChineseMessages(h: Harness, sessId: string, pairs: number, chars = 1000): Promise<void> {
      const base = '这是一段用于验证上下文压缩阈值的中文会话内容，编号为'
      for (let i = 0; i < pairs; i++) {
        const body = new Array(Math.ceil(chars / base.length)).fill(base).join('').slice(0, chars)
        const at = Date.now() + i * 2
        await h.session.addMessage(sessId, { id: `zu_${i}`, role: 'user', parts: [{ type: 'text', text: body }], createdAt: at })
        await h.session.addMessage(sessId, { id: `za_${i}`, role: 'assistant', parts: [{ type: 'text', text: body }], createdAt: at + 1 })
      }
    }

    it('自动压缩的窗口来自调用方：同一会话在真实窗口 102400 下触发，在旧硬编码 200000 下永不触发', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      // 120 条 × 1000 字中文 ≈ 119k tokens（auto 口径）
      await fillChineseMessages(h, sess.id, 60)
      // 旧行为：core 内硬编码 200000 ⇒ 阈值 (200000−30000)×80% = 136000 > 119k ⇒ 永不触发，
      // 于是 providers 写 102400 的用户"配了自动压缩却从没见过它生效"，且没有任何报错。
      const legacy = await h.session.compactIfNeeded(sess.id, { contextWindowTokens: 200_000 })
      expect(legacy).toBe(false)
      const afterLegacy = (await h.session.get(sess.id))!
      expect(afterLegacy.messages.length).toBe(120)
      // 修好之后：窗口按「显式覆盖 → Provider contextWindowTokens」推导并显式传入
      // ⇒ 阈值 (102400−30000)×80% = 57920 < 119k ⇒ 触发压缩
      const did = await h.session.compactIfNeeded(sess.id, {
        contextWindowTokens: 102_400,
        keepRecentMessages: 10,
      })
      expect(did).toBe(true)
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBeLessThan(120)
      await h.stop()
    })

    it('estimateTokens：中文会话在 auto 与 chars4 下相差约 4 倍', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      await fillChineseMessages(h, sess.id, 10) // 20 条 × 1000 字 ≈ 20k tokens
      const auto = await h.session.estimateTokens(sess.id)
      const legacy = await h.session.estimateTokens(sess.id, 'chars4')
      expect(auto).toBeGreaterThan(19_000)
      expect(auto / legacy).toBeGreaterThan(3.5)
      // 缺省即 auto（与 ACP 层同一口径）
      expect(await h.session.estimateTokens(sess.id, 'auto')).toBe(auto)
      await h.stop()
    })

    it('同一中文会话：chars4 口径判定未达阈值，auto 口径判定命中并压缩', async () => {
      const h = await createHarness({ agents: [makeAgent()], chatProvider: mockChatProvider() })
      const sess = await h.session.create()
      await fillChineseMessages(h, sess.id, 15) // 30 条 × 1000 字 ≈ 30k tokens（chars4 只有 ~7.5k）
      const opts = { contextWindowTokens: 40_000, reservedTokens: 5_000, autoCompactThresholdPct: 80, keepRecentMessages: 10 }
      // 阈值 = (40000−5000)×80% = 28000
      const oldCaliber = await h.session.compactIfNeeded(sess.id, { ...opts, tokenCalibration: 'chars4' })
      expect(oldCaliber).toBe(false)
      const hit = await h.session.compactIfNeeded(sess.id, { ...opts, tokenCalibration: 'auto' })
      expect(hit).toBe(true)
      const s = (await h.session.get(sess.id))!
      expect(s.messages.length).toBeLessThan(30)
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
            'core.session.compacting': async (_input, output) => {
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

    it('core.session.preModel 回传 blocksPatch：每轮内部折叠的 acp 块合并进 session.blocks（幂等去重）', async () => {
      const acpLike: AgentPlugin = {
        id: 'acp-premodel',
        version: '1',
        name: 'acp-premodel',
        async install(ctx) {
          return {
            'core.session.preModel': async (input, _msgs) => {
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

    it('core.session.preModel 透传 agentTools 与 parentSessionId（压缩插件据此决定提示该不该注入）', async () => {
      // 背景：ACP 的压缩手册过去是无条件下发的，而只读 worker 的白名单里根本没有 compress，
      // 模型只能照着手册拼出字段完整的调用去撞 TOOL_NOT_ALLOWED（真机 12/12）。
      // 修法不是让插件去查 agent 注册表（它拿不到），而是 core 把已在手边的判别符传下去。
      const seen: Array<{ agentTools?: readonly string[]; parentSessionId?: string }> = []
      const ToolPlugin: AgentPlugin = {
        id: 'tools', version: '1', name: 'Tools',
        async install() {
          return {
            async 'core.tool.pool.assemble'(_i, pool: any) { pool.add(createEchoTool()) },
          } as Hooks
        },
      }
      const CapturePlugin: AgentPlugin = {
        id: 'capture', version: '1', name: 'capture',
        async install() {
          return {
            'core.session.preModel': async (input) => {
              seen.push({
                agentTools: input.agentTools,
                ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
              })
            },
          } as Hooks
        },
      }
      const h = await createHarness({
        agents: [makeAgent({ tools: ['echo'] })],
        chatProvider: mockChatProvider(),
        internalPlugins: [ToolPlugin, CapturePlugin],
      })
      await h.start()
      const root = await h.session.create()
      await h.agent.query({ sessionId: root.id, message: '主会话' })
      // 子会话走的就是 subagent 插件那条路：`session.create({ parentId })`
      const child = await h.session.create({ parentId: root.id })
      await h.agent.query({ sessionId: child.id, message: '子会话' })
      await h.stop()

      // agentTools 是**白名单过滤后**的最终 id（不是 agent 定义的原始列表，也不是全注册表）
      expect(seen[0]!.agentTools).toEqual(['echo'])
      expect(seen[0]!.parentSessionId).toBeUndefined() // 顶层会话没有父
      expect(seen[1]!.agentTools).toEqual(['echo'])
      expect(seen[1]!.parentSessionId).toBe(root.id)
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

    // ---- 运行期注册表（ProviderRuntime）：键由调用方给 / 默认显式 / 可反注册 ----

    /** 造一个"只做注册"的 Provider 插件（模拟 provider-* 插件的 core.harness.init 那一段） */
    function registrarPlugin(id: string, fn: (p: ProviderRuntime) => void): AgentPlugin {
      return {
        id,
        version: '0.0.0',
        name: id,
        async install() {
          return {
            async 'core.harness.init'(_input: unknown, output: unknown) {
              const harness = (output as { harness?: { providers?: ProviderRuntime } }).harness
              if (harness?.providers) fn(harness.providers)
            },
          } as unknown as Hooks
        },
      }
    }

    /** 带独立计数的替身：`selfId` 是它**自报**的 id（可能就是错的），`tag` 用于分辨谁被调到 */
    function spyProvider(selfId: string): { provider: ChatProvider; count: () => number } {
      let n = 0
      const provider: ChatProvider = {
        id: selfId,
        async complete() {
          n++
          return { content: `${selfId}#${n}`, model: `${selfId}-v1`, tokenUsage: { input: 1, output: 1 } }
        },
      }
      return { provider, count: () => n }
    }

    it('providers.register 用**调用方给的 id** 作键：两个自报同一 id 的实例不互相覆盖（P2 修复）', async () => {
      // 两个实例**自报同一个 id** —— 正是修前 anthropic / gemini / mock 的形状
      const a1 = spyProvider('anthropic')
      const a2 = spyProvider('anthropic')
      const h = await createHarness({
        chatProvider: spyProvider('legacy').provider,
        agents: [
          makeAgent({ id: 'use-a2', model: { providerId: 'a2', modelId: 'm' } }),
          makeAgent({ id: 'use-default', model: { modelId: 'm' } }),
        ],
        internalPlugins: [
          registrarPlugin('test.reg', (p) => {
            p.register('a1', a1.provider, { source: 'config', type: 'anthropic' })
            p.register('a2', a2.provider, { source: 'config', type: 'anthropic' })
            p.setDefault('a1')
          }),
        ],
      })

      // 两个实例各占一个键（旧实现按 p.id 入表 ⇒ 只会剩最后一个）
      expect(h.providers.get('a1')).toBe(a1.provider)
      expect(h.providers.get('a2')).toBe(a2.provider)
      expect(h.providers.list().map((p) => p.id).sort()).toEqual(['a1', 'a2'])
      // 自报 id 不作键：'anthropic' 必须**未命中**（旧实现下这里会命中，且是最后一个实例）
      expect(h.providers.get('anthropic')).toBeUndefined()

      // 路由：agent.model.providerId='a2' 命中 a2（不再静默回退默认）
      expect(h.providers.resolve('a2')).toBe(a2.provider)
      await h.start()
      const sess = await h.session.create()
      await h.agent.query({ sessionId: sess.id, agentId: 'use-a2', message: 'hi' })
      // 默认 = a1（显式 setDefault），无 providerId 的 agent 走它
      await h.agent.query({ sessionId: sess.id, agentId: 'use-default', message: 'hi' })
      await h.stop()
      expect(a2.count()).toBe(1)
      expect(a1.count()).toBe(1)
    })

    it('默认由显式 setDefault 决定，不由注册顺序决定（Q2）', async () => {
      const second = spyProvider('second')
      const first = spyProvider('first')
      const h = await createHarness({
        chatProvider: spyProvider('legacy').provider,
        internalPlugins: [
          registrarPlugin('test.reg', (p) => {
            // 注册顺序刻意把 second 放前面：若默认还按「首个已注册」算，得到的就是 second
            p.register('second', second.provider)
            p.register('first', first.provider)
            p.setDefault('first')
          }),
        ],
      })
      expect(h.providers.resolve()).toBe(first.provider)
      expect(h.providers.resolve('default')).toBe(first.provider)
      expect(h.providers.list().find((p) => p.isDefault)?.id).toBe('first')
      // 老名字仍在（委托同一实现）—— CLI 至今靠 duck typing 调 `resolveChatProvider`
      expect((h as unknown as HarnessImpl).resolveChatProvider()).toBe(first.provider)
    })

    it('unregister：摘掉当前默认 ⇒ 默认回落「首个已注册」（Q3）；未注册 id 返回 false', async () => {
      const a1 = spyProvider('a1')
      const a2 = spyProvider('a2')
      const h = await createHarness({
        chatProvider: spyProvider('legacy').provider,
        internalPlugins: [
          registrarPlugin('test.reg', (p) => {
            p.register('a1', a1.provider)
            p.register('a2', a2.provider)
            p.setDefault('a2')
          }),
        ],
      })
      expect(h.providers.resolve()).toBe(a2.provider)

      expect(h.providers.unregister('a2')).toBe(true)
      expect(h.providers.get('a2')).toBeUndefined()
      // 默认回落「首个已注册」而不是保留一个已消失的 id
      expect(h.providers.resolve()).toBe(a1.provider)
      expect(h.providers.list().map((p) => p.id)).toEqual(['a1'])
      // 未注册的 id：false，且不抛
      expect(h.providers.unregister('ghost')).toBe(false)
    })

    it('setDefault 指向未注册的 id ⇒ 抛错（默认不接受静默失败）', async () => {
      const h = await createHarness({ chatProvider: spyProvider('legacy').provider })
      expect(() => h.providers.setDefault('ghost')).toThrow(/未注册/)
    })

    it('显式 id 未命中 ⇒ 发 provider.resolveMiss（静默回退可见），并回退默认', async () => {
      const bus = new InMemoryBus()
      const misses: Array<{ requested: string; fallbackId?: string }> = []
      bus.subscribe(ProviderEvents.resolveMiss, (e) => {
        misses.push(e.payload as { requested: string; fallbackId?: string })
      })
      const a1 = spyProvider('a1')
      const h = await createHarness({
        bus,
        chatProvider: spyProvider('legacy').provider,
        internalPlugins: [
          registrarPlugin('test.reg', (p) => {
            p.register('a1', a1.provider, { source: 'config' })
            p.setDefault('a1')
          }),
        ],
      })

      expect(h.providers.resolve('ghost')).toBe(a1.provider)
      // bus.publish 是 fire-and-forget（不 await），刷一轮微任务再断言
      await new Promise((r) => setTimeout(r, 0))
      expect(misses).toEqual([{ requested: 'ghost', fallbackId: 'a1' }])

      // 命中时**不发** miss（否则事件本身就成了噪音）
      expect(h.providers.resolve('a1')).toBe(a1.provider)
      await new Promise((r) => setTimeout(r, 0))
      expect(misses).toHaveLength(1)
    })

    it('resolveMiss 带会话归属：显式给 ctx 才有，不给就不凭空编造', async () => {
      const bus = new InMemoryBus()
      const misses: Array<Record<string, unknown>> = []
      bus.subscribe(ProviderEvents.resolveMiss, (e) => {
        misses.push(e.payload as Record<string, unknown>)
      })
      const a1 = spyProvider('a1')
      const h = await createHarness({
        bus,
        chatProvider: spyProvider('legacy').provider,
        internalPlugins: [
          registrarPlugin('test.reg', (p) => {
            p.register('a1', a1.provider, { source: 'config' })
            p.setDefault('a1')
          }),
        ],
      })

      expect(h.providers.resolve('ghost', { sessionId: 's-1', agentId: 'coder' })).toBe(a1.provider)
      await new Promise((r) => setTimeout(r, 0))
      expect(misses[0]).toEqual({ requested: 'ghost', fallbackId: 'a1', sessionId: 's-1', agentId: 'coder' })

      // 无会话上下文的解析（装配期 / 探针调用）：不编造 sessionId —— 编造会让事件落进错误的会话文件
      expect(h.providers.resolve('ghost2')).toBe(a1.provider)
      await new Promise((r) => setTimeout(r, 0))
      expect(misses[1]).toEqual({ requested: 'ghost2', fallbackId: 'a1' })
    })

    it('轮内 providerId 未命中 ⇒ 事件带 sessionId（否则遥测落 run 级文件，按会话取证看不见）', async () => {
      const bus = new InMemoryBus()
      const misses: Array<Record<string, unknown>> = []
      bus.subscribe(ProviderEvents.resolveMiss, (e) => {
        misses.push(e.payload as Record<string, unknown>)
      })
      const h = await createHarness({
        bus,
        chatProvider: spyProvider('legacy').provider,
        agents: [makeAgent({ id: 'use-ghost', model: { providerId: 'ghost', modelId: 'm' } })],
      })
      await h.start()
      const sess = await h.session.create()
      await h.agent.query({ sessionId: sess.id, agentId: 'use-ghost', message: 'hi' })
      await h.stop()

      // 这一条盯的是 `_runStep` 里 `deps.chatProvider(providerId, { sessionId, agentId })` 那个调用点：
      // 只在 ProviderRuntime 层支持 ctx 是不够的 —— 轮内不传就白搭
      expect(misses).toHaveLength(1)
      expect(misses[0]).toMatchObject({ requested: 'ghost', sessionId: sess.id, agentId: 'use-ghost' })
    })

    it('provider.registered / defaultChanged 事实可观测，且带来源', async () => {
      const bus = new InMemoryBus()
      const registered: Array<{ id: string; source: string; type?: string }> = []
      const defaults: Array<{ id?: string; previous?: string; reason: string }> = []
      bus.subscribe(ProviderEvents.registered, (e) => {
        registered.push(e.payload as { id: string; source: string; type?: string })
      })
      bus.subscribe(ProviderEvents.defaultChanged, (e) => {
        defaults.push(e.payload as { id?: string; previous?: string; reason: string })
      })
      await createHarness({
        bus,
        chatProvider: spyProvider('legacy').provider,
        internalPlugins: [
          registrarPlugin('test.reg', (p) => {
            p.register('a1', spyProvider('a1').provider, { source: 'plugin:provider.anthropic', type: 'anthropic' })
            p.register('a2', spyProvider('a2').provider, { source: 'config' })
            p.setDefault('a1')
          }),
        ],
      })
      await new Promise((r) => setTimeout(r, 0))
      expect(registered).toEqual([
        { id: 'a1', source: 'plugin:provider.anthropic', type: 'anthropic' },
        { id: 'a2', source: 'config' },
      ])
      expect(defaults).toEqual([{ id: 'a1', reason: 'set' }])
    })

    it('core.llm.usage 带 providerId：同一模型挂多个端点时，用量才分得清是哪个端点', async () => {
      const seen: Array<{ model?: string; providerId?: string }> = []
      const usagePlugin: AgentPlugin = {
        id: 'test.usage',
        version: '0.0.0',
        name: 'test.usage',
        async install() {
          return {
            'core.llm.usage'(sig: unknown) {
              seen.push(sig as { model?: string; providerId?: string })
            },
          } as unknown as Hooks
        },
      }
      const h = await createHarness({
        chatProvider: spyProvider('legacy').provider,
        agents: [
          makeAgent({ id: 'use-ep', model: { providerId: 'ep2', modelId: 'claude-3-5-sonnet' } }),
          makeAgent({ id: 'use-bare', model: { modelId: 'claude-3-5-sonnet' } }),
        ],
        internalPlugins: [
          registrarPlugin('test.reg', (p) => {
            p.register('ep1', spyProvider('ep1').provider, { source: 'config' })
            p.register('ep2', spyProvider('ep2').provider, { source: 'config' })
            p.setDefault('ep1')
          }),
          usagePlugin,
        ],
      })
      await h.start()
      const sess = await h.session.create()
      await h.agent.query({ sessionId: sess.id, agentId: 'use-ep', message: 'hi' })
      await h.agent.query({ sessionId: sess.id, agentId: 'use-bare', message: 'hi' })
      await h.stop()

      expect(seen).toHaveLength(2)
      // 两个 agent 的 modelId 完全一样，唯一的区别就是这个维度 —— 没有它，两条端点不可区分
      expect(seen[0]).toMatchObject({ providerId: 'ep2', model: 'ep2-v1' })
      // 未绑定 providerId 的 agent：不凭空编造端点（编造会让用量归到错误的一端）
      expect(seen[1].providerId).toBeUndefined()
    })
  })

  describe('Agent 运行期注册（来源 / 覆盖 / 反注册 / 工具池）', () => {
    function makeBusLogger2(bus: InMemoryBus) {
      const events: BusEventRecord[] = []
      ;(bus as any).subscribeAll((e: BusEventRecord) => events.push(e))
      return events
    }

    it('同 id 二次注册 ⇒ 发 agent.reregistered（带 from/to 来源）且打 WARN', async () => {
      const bus = new InMemoryBus()
      const events = makeBusLogger2(bus)
      const warns: string[] = []
      const h = await createHarness({
        bus,
        chatProvider: mockChatProvider(),
        logger: { warn: (m: string) => warns.push(m), info: () => {}, error: () => {}, debug: () => {} } as any,
      })
      h.agent.register(makeAgent({ id: 'dup' }), { source: 'plugin:x' })
      h.agent.register(makeAgent({ id: 'dup' }), { source: 'runtime' })
      await new Promise((r) => setTimeout(r, 0))

      const reReg = events.filter((e) => e.name === 'agent.reregistered')
      expect(reReg).toHaveLength(1)
      // from/to 是**来源**而不是同一个 id —— 覆盖最需要看见的正是"改动前后各是谁注册的"
      expect(reReg[0].payload).toEqual({ id: 'dup', from: 'plugin:x', to: 'runtime' })
      expect(warns.some((w) => w.includes('dup') && w.includes('plugin:x') && w.includes('runtime'))).toBe(true)
    })

    it('overlay 覆盖只发事件不打 WARN（文档化覆盖链不打噪音）', async () => {
      const bus = new InMemoryBus()
      const events = makeBusLogger2(bus)
      const warns: string[] = []
      const h = await createHarness({
        bus,
        chatProvider: mockChatProvider(),
        logger: { warn: (m: string) => warns.push(m), info: () => {}, error: () => {}, debug: () => {} } as any,
      })
      h.agent.register(makeAgent({ id: 'x' }), { source: 'options' })
      h.agent.register(makeAgent({ id: 'x' }), { source: 'config', overlay: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(events.filter((e) => e.name === 'agent.reregistered')).toHaveLength(1)
      expect(warns).toHaveLength(0)
    })

    it('overwrite:false ⇒ 抛错（调用方显式表达"这个 id 不许被换掉"）', async () => {
      const h = await createHarness({ chatProvider: mockChatProvider() })
      h.agent.register(makeAgent({ id: 'locked' }), { source: 'options' })
      expect(() => h.agent.register(makeAgent({ id: 'locked' }), { source: 'runtime', overwrite: false }))
        .toThrow(/locked.*overwrite=false/)
      // 抛错时**不动**已有定义（否则"拒绝覆盖"反而把旧定义弄丢了）
      expect(h.agent.get('locked')).toBeDefined()
    })

    it('unregister：摘掉返回 true 且不再可查，未注册 id 返回 false（不级联删历史）', async () => {
      const h = await createHarness({ chatProvider: mockChatProvider() })
      h.agent.register(makeAgent({ id: 'temp' }), { source: 'runtime' })
      expect(h.agent.get('temp')?.id).toBe('temp')
      expect(h.agent.unregister('temp')).toBe(true)
      expect(h.agent.get('temp')).toBeUndefined()
      expect(h.agent.list().some((a) => a.id === 'temp')).toBe(false)
      expect(h.agent.unregister('temp')).toBe(false)
    })

    it('运行期注册的 Agent：下一轮 query 立刻有工具（工具池每轮重算，不能被挪回装配期）', async () => {
      const seenTools: string[][] = []
      const provider: ChatProvider = {
        id: 'spy',
        async complete(params) {
          seenTools.push((params.tools ?? []).map((t) => t.id))
          return { content: 'ok', model: 'spy-1', tokenUsage: { input: 1, output: 1 } }
        },
      }
      // 工具注入**按 agentId 分流**：只有 'late' 这个 Agent 触发才加 echo。
      // 这样若有人把工具池组装挪回装配期（或不再每轮 trigger），本用例必红 ——
      // 全局注册表里预先有 echo 的实现骗不过这条断言。
      const LateToolsPlugin: AgentPlugin = {
        id: 'late-tools',
        version: '1',
        name: 'LateTools',
        async install() {
          return {
            async 'core.tool.pool.assemble'(input: any, pool: any) {
              if (input?.agentId === 'late') pool.add(createEchoTool())
            },
          } as Hooks
        },
      }
      const h = await createHarness({
        chatProvider: provider,
        agents: [makeAgent({ id: 'default' })],
        internalPlugins: [LateToolsPlugin],
      })
      await h.start()
      const sess = await h.session.create()

      // 控制组：先跑默认 Agent —— 它不该看到 echo
      await h.agent.query({ sessionId: sess.id, message: 'hi' })
      expect(seenTools[0]).not.toContain('echo')

      // 运行期注册一个**构造期不存在**的 Agent，下一轮 query 立刻拿到按 agentId 注入的工具
      h.agent.register(makeAgent({ id: 'late', tools: ['echo'] }), { source: 'runtime' })
      await h.agent.query({ sessionId: sess.id, agentId: 'late', message: 'hi' })
      expect(seenTools[1]).toContain('echo')
      await h.stop()
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

  describe('extractFilePaths（技能 paths 条件触发的路径提取）', () => {
    it('提取相对/绝对/点路径，去重、剔除明显非路径', () => {
      expect(extractFilePaths('看看 src/foo.ts 和 /Users/x/a.ts，还有 ./x 和 3.14 和 v1.2'))
        .toEqual(['src/foo.ts', '/Users/x/a.ts', './x'])
    })

    it('无路径时返回空数组', () => {
      expect(extractFilePaths('今天天气不错')).toEqual([])
      expect(extractFilePaths('')).toEqual([])
    })

    it('去引号包裹', () => {
      expect(extractFilePaths('改一下 "packages/cli/src/index.ts"')).toEqual(['packages/cli/src/index.ts'])
    })
  })

  describe('技能 paths 条件触发走尾部动态通道（§8.1）', () => {
    it('用户消息提及路径 ⇒ 命中 paths 的技能注入请求尾部（dynParts），不进 system 前缀', async () => {
      const root = mkdtempSync(join(tmpdir(), 'core-skill-paths-'))
      try {
        const userSkills = join(root, 'skills')
        mkdirSync(join(userSkills, 'ts-help'), { recursive: true })
        writeFileSync(
          join(userSkills, 'ts-help', 'SKILL.md'),
          '---\nname: TS Help\npaths: ["src/**/*.ts", "packages/**/*.ts"]\n---\nTypeScript 相关技能。\n',
        )
        mkdirSync(join(userSkills, 'readme-help'), { recursive: true })
        writeFileSync(
          join(userSkills, 'readme-help', 'SKILL.md'),
          '---\nname: Readme Help\npaths: ["**/README.md"]\n---\nREADME 相关技能。\n',
        )
        const provider = mockChatProvider()
        const h = await createHarness({
          chatProvider: provider,
          skillDirs: [{ dir: userSkills, source: 'user' }],
          agents: [makeAgent()],
        })
        const sess = await h.session.create()
        await h.start()
        // 提及 packages/**/*.ts 路径 ⇒ 只命中 ts-help，不命中 readme-help
        await h.agent.query({ sessionId: sess.id, message: '看看 packages/plugins/tools-builtin/src/index.ts' })
        await h.stop()
        const lastCall = provider.calls[provider.calls.length - 1]
        const msgs = lastCall.messages as Message[]
        // system 前缀不得含条件触发技能（paths 是变量 ⇒ 只能进尾部）
        const sys = msgs.filter((m) => m.role === 'system').map((m) => JSON.stringify(m)).join('')
        expect(sys).not.toContain('TS Help')
        // 尾部（最后一条 user 消息）含命中技能
        const tailUser = [...msgs].reverse().find((m) => m.role === 'user')
        expect(JSON.stringify(tailUser)).toContain('TS Help')
        expect(JSON.stringify(tailUser)).not.toContain('Readme Help')
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  })

  describe('stableStringify / shortHash / resultPayload（§8.2 结果复用的序列化基元）', () => {
    it('对象键序无关', () => {
      expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }))
    })
    it('数组/标量稳定', () => {
      expect(stableStringify([1, 'x', null])).toBe('[1,"x",null]')
      expect(stableStringify('s')).toBe('"s"')
    })
    it('shortHash 定长且确定', () => {
      expect(shortHash('abc')).toBe(shortHash('abc'))
      expect(shortHash('abc')).toHaveLength(16)
      expect(shortHash('abc')).not.toBe(shortHash('abd'))
    })
    it('resultPayload：string 直用 / 对象取 content / 其余 JSON', () => {
      expect(resultPayload('abc')).toBe('abc')
      expect(resultPayload({ content: 'big', path: 'x' })).toBe('big')
      expect(resultPayload({ a: [1] })).toBe('{"a":[1]}')
    })
  })

  describe('§8.2 重复侦察结果截写（只读工具 + TTL + 同参同 hash）', () => {
    it('同 read_file 同参 TTL 内重复 ⇒ 第二次结果截写为提示，工具真实执行、历史原文不动', async () => {
      const root = mkdtempSync(join(tmpdir(), 'core-repeat-'))
      try {
        const p = join(root, 'big.txt')
        writeFileSync(p, 'line-'.repeat(2000)) // > 2000 字符
        const cp = mockChatProvider('tool', (params) => {
          // 每次都让模型发起同一 read_file 调用（同参数）→ 引擎自主多步重复执行
          void params
          return {
            content: '',
            model: 'mock-v1',
            tokenUsage: { input: 5, output: 2 },
            toolCalls: [{ toolUseId: 'tu_r', toolId: 'read_file', input: { path: p } }],
          } as any
        })
        const h = await createHarness({
          chatProvider: cp,
          cwd: root, // read_file 只在 cwd 内工作
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          agents: [makeAgent()],
          internalPlugins: [{
            id: 'rb',
            version: '1',
            name: 'ReadBuiltin',
            async install() {
              return {
                async 'core.tool.pool.assemble'(_i, pool: any) {
                  const { readFileTool } = await import('@harness/tools-builtin')
                  pool.add(readFileTool)
                },
              } as Hooks
            },
          }],
        })
        const sess = await h.session.create()
        await h.start()
        await h.agent.query({ sessionId: sess.id, message: '读文件', maxSteps: 2 })
        await h.stop()
        const s = (await h.session.get(sess.id))!
        const toolParts = (s.messages as Message[]).flatMap((m) => (m.parts as any[]).filter((pt) => pt.type === 'tool'))
        // maxSteps:2 含收尾轮 ⇒ 至少 2 次执行；取前两条验证"第一次全文、第二次截写"
        expect(toolParts.length).toBeGreaterThanOrEqual(2)
        expect(String((toolParts[0].result as any).content).length).toBeGreaterThan(2000)
        expect(String((toolParts[1].result as any).content)).toContain('结果与第 1 轮一致')
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  })
})

// ===== 观察点 8：零收益空压缩（core 侧短路）=====
//
// 真机 reader#1 round 11 出现过一次零收益压缩（createdBlocks:0 / tokensCompressed:0）。
// 而生成摘要是要花**一次完整模型调用**的（strategy==='agent' 走 tryAgentSummary）——
// 窗口为空时那次调用纯属白烧。这里固定"没有可折叠窗口就不生成摘要"。
describe('compact：没有可折叠窗口时不生成摘要（零收益短路）', () => {
  it('插件把 keepLast 抬到 ≥ 消息数 ⇒ 一次模型调用都不发，也不建块', async () => {
    let agentCalls = 0
    const mgr = new DefaultSessionManager(() => ({
      agent: {
        async query() {
          agentCalls += 1
          return { id: 'x', role: 'assistant', parts: [{ type: 'text', text: '摘要' }], createdAt: 0 }
        },
      },
      currentAgentId: () => 'default',
      async triggerPlugin(_name: string, _input: unknown, ctx: any) {
        // 模拟插件在 hook 里把"保留段"抬到覆盖全部消息 ⇒ 可折叠窗口变为空
        if (ctx && typeof ctx === 'object') ctx.keepLast = 999
      },
    }) as any)

    const sess = await mgr.create()
    sess.agentId = 'default'
    for (let i = 0; i < 6; i++) {
      await mgr.addMessage(sess.id, {
        id: `m${i}`,
        role: i % 2 ? 'assistant' : 'user',
        parts: [{ type: 'text', text: `msg ${i}` }],
        createdAt: i,
      } as Message)
    }

    await mgr.compact(sess.id, 'agent')

    // 关键断言：窗口为空 ⇒ 不烧那一次完整模型调用
    expect(agentCalls).toBe(0)
    // 也没建任何压缩块（空块会污染 session.blocks / revert 视图）
    const after = (await mgr.get(sess.id))!
    expect(after.blocks ?? []).toHaveLength(0)
    // 消息一条不少（没有可折叠的就别动历史）
    expect(after.messages).toHaveLength(6)
  })
})
