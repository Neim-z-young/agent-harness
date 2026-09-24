import { describe, it, expect, afterAll } from 'bun:test'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runGit, gitTopLevel } from './worktree'
import {
  createSubagentPlugin,
  createSubagentTool,
  DEFAULT_SUBAGENT_MAX_STEPS,
  BackgroundTaskRegistry,
  BackgroundTaskMonitor,
  subagentCapability,
  SubagentEvents,
  formatTaskNotification,
  formatTaskNotificationBrief,
  listPersistedTasks,
  isAgentDenied,
  filterAccessibleAgents,
  renderRoster,
  type SubagentToolInput,
  type SubagentToolOutput,
  type SubagentPluginOptions,
} from './index'
import { createBus } from '@harness/bus'
import { READONLY_TOOLS_SENTINEL } from '@harness/tool'
import type { AgentDefinition } from '@harness/agent'
import type { AgentRuntime, AgentStreamEvent } from '@harness/core'
import type { SessionManager, Session, Message } from '@harness/session'
import type { ToolContext, ToolResult } from '@harness/tool'
import { partitionToolCalls, type ToolUse } from '@harness/tool'

// ===== Mock helper =====

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    id: `m_${Math.random().toString(36).slice(2, 7)}`,
    role,
    parts: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
}

type MockQueryImpl = (input: { sessionId: string; agentId?: string; message: string; model?: { providerId?: string; modelId?: string; temperature?: number } }) => Promise<Message>

function createMockAgentRuntime(
  agents: AgentDefinition[],
  queryImpl?: MockQueryImpl,
  streamImpl?: (input: Parameters<MockQueryImpl>[0]) => AsyncGenerator<AgentStreamEvent, void, unknown>,
): AgentRuntime {
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  return {
    register: (def: AgentDefinition) => { agentMap.set(def.id, def) },
    get: (id: string) => agentMap.get(id),
    list: () => Array.from(agentMap.values()),
    query: queryImpl ?? (async () => makeMessage('assistant', 'mock response')),
    // 默认流：走 queryImpl 拿最终消息，yield text_delta + done（P1-5 后后台执行依赖 queryStream）
    queryStream: streamImpl ?? (async function* (input) {
      const msg = queryImpl ? await queryImpl(input) : makeMessage('assistant', 'mock response')
      const text = msg.parts.filter((p) => p.type === 'text').map((p: any) => p.text).join('')
      if (text) yield { type: 'text_delta', text }
      yield { type: 'done', message: msg }
    }),
  }
}

function createMockSessionManager(sessions: Map<string, Session>): SessionManager {
  const pendingNotifications = new Map<string, string[]>()
  return {
    create: async (options?: { title?: string; parentId?: string; cwd?: string; meta?: Record<string, unknown> }) => {
      const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const session: Session = {
        id,
        title: options?.title ?? 'subagent session',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentId: options?.parentId,
        cwd: options?.cwd,
        meta: options?.meta,
      }
      sessions.set(id, session)
      return session
    },
    get: async (id: string) => sessions.get(id),
    list: async () => Array.from(sessions.values()),
    search: async () => [],
    prompt: async () => makeMessage('assistant', ''),
    promptStream: async function* () { /* noop */ },
    updateMessage: async () => {},
    updatePart: async () => {},
    addMessage: async (id: string, msg: Message) => {
      const s = sessions.get(id)
      if (s) { s.messages.push(msg); s.updatedAt = Date.now() }
    },
    deleteMessage: async () => {},
    snapshot: async () => 'snap',
    revert: async () => {},
    unrevert: async () => {},
    compact: async () => {},
    compactIfNeeded: async () => false,
    getCompactionInfo: async () => ({}),
    generateTitle: async () => '',
    exportMarkdown: async () => '',
    estimateTokens: async () => 0,
    enqueueNotification: (sessionId: string, message: string) => {
      const queue = pendingNotifications.get(sessionId) ?? []
      queue.push(message)
      pendingNotifications.set(sessionId, queue)
    },
    drainNotifications: (sessionId: string) => {
      const queue = pendingNotifications.get(sessionId) ?? []
      if (queue.length > 0) pendingNotifications.delete(sessionId)
      return queue
    },
    // 只读查看（不消费）：自动续轮的空转判断用它
    peekNotifications: (sessionId: string) => [...(pendingNotifications.get(sessionId) ?? [])],
  } as unknown as SessionManager
}

function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'parent-session',
    agentId: 'primary',
    messageId: 'm_parent',
    toolUseId: 'tu_1',
    signal: new AbortController().signal,
    variables: {},
    cwd: '/tmp',
    ...overrides,
  }
}

/** 最小可订阅的假 Bus：只支持本文件需要的 publish / subscribe（按事件对象身份分组） */
function createRecordingBus() {
  const handlers = new Map<unknown, Array<(payload: unknown) => void>>()
  const published: Array<{ event: unknown; payload: unknown }> = []
  return {
    on(event: unknown, h: (payload: unknown) => void) {
      const arr = handlers.get(event) ?? []
      arr.push(h)
      handlers.set(event, arr)
    },
    published,
    asBus() {
      return {
        publish: (event: unknown, payload: unknown) => {
          published.push({ event, payload })
          for (const h of handlers.get(event) ?? []) h(payload)
          return Promise.resolve()
        },
        subscribe: (event: unknown, h: (payload: unknown) => void) => {
          const arr = handlers.get(event) ?? []
          arr.push(h)
          handlers.set(event, arr)
          return () => {}
        },
      } as any
    },
  }
}

// ===== 测试 =====

describe('SubagentTool', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }

  it('正常调用：创建子 session + query + 返回最终文本', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', 'Task done: refactored foo()')
      // 模拟 agent.query 内部会 addMessage
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        s.messages.push(msg)
      }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call({ agentId: 'coder', prompt: '重构 foo 函数' }, makeToolContext())

    expect(res.ok).toBe(true)
    expect(res.output!.sessionId).toStartWith('s_')
    expect(res.output!.message).toBe('Task done: refactored foo()')
    expect(res.output!.messageCount).toBe(2)
  })

  it('子 Agent 步数上限：缺省用保守的 10，子 Agent 定义显式写了则优先', async () => {
    const sessions = new Map<string, Session>()
    const session = createMockSessionManager(sessions)

    // 1) 定义里没写 maxSteps ⇒ 用 DEFAULT_SUBAGENT_MAX_STEPS（比主 Agent 的 30 保守：
    //    子 Agent 是聚焦执行，步数越多越容易撞上 timeoutMs）
    const seen: Array<number | undefined> = []
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      seen.push((input as { maxSteps?: number }).maxSteps)
      return makeMessage('assistant', 'done')
    })
    const tool = createSubagentTool(() => ({ agent, session }), 5000, false)
    await tool.call({ agentId: 'coder', prompt: 'x' }, makeToolContext())
    expect(seen[0]).toBe(DEFAULT_SUBAGENT_MAX_STEPS)

    // 2) 子 Agent 定义里写了 maxSteps ⇒ 以定义为准（个别子 Agent 确实需要长链）
    const seen2: Array<number | undefined> = []
    const longAgent = createMockAgentRuntime(
      [{ ...coderAgent, maxSteps: 25 }],
      async (input) => {
        seen2.push((input as { maxSteps?: number }).maxSteps)
        return makeMessage('assistant', 'done')
      },
    )
    const tool2 = createSubagentTool(() => ({ agent: longAgent, session }), 5000, false)
    await tool2.call({ agentId: 'coder', prompt: 'x' }, makeToolContext())
    expect(seen2[0]).toBe(25)
  })

  it('Agent 未注册时返回 AGENT_NOT_FOUND', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([], async () => makeMessage('assistant', 'x'))
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call({ agentId: 'unknown', prompt: 'test' }, makeToolContext())

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('AGENT_NOT_FOUND')
  })

  it('mode 不是 subagent 时返回 INVALID_AGENT_MODE', async () => {
    const primaryAgent: AgentDefinition = { ...coderAgent, id: 'primary', mode: 'primary' }
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([primaryAgent], async () => makeMessage('assistant', 'x'))
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call({ agentId: 'primary', prompt: 'test' }, makeToolContext())

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('INVALID_AGENT_MODE')
  })

  it('Harness 未就绪时返回 HARNESS_NOT_READY', async () => {
    const tool = createSubagentTool(() => undefined, 5000, false)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('HARNESS_NOT_READY')
  })

  it('子 Agent 超时返回 SUBAGENT_FAILED', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], () => new Promise<Message>(() => {})) // 永不 resolve
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 50, false) // 50ms 超时
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('SUBAGENT_FAILED')
    expect(res.error!.message).toInclude('超时')
  })

  it('子 Agent 无文本回复时返回默认提示', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      // 只返回 tool_use part，无 text part
      const msg: Message = {
        id: 'm_empty',
        role: 'assistant',
        parts: [{ type: 'tool_use', toolUseId: 'tu_1', toolId: 'bash', input: { command: 'ls' } } as any],
        createdAt: Date.now(),
      }
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.ok).toBe(true)
    expect(res.output!.message).toBe('(子 Agent 无文本回复)')
  })

  it('安全声明 Fail-Closed：isReadOnly=false, isConcurrencySafe=false', () => {
    const tool = createSubagentTool(() => undefined, 5000, false)
    expect(tool.isReadOnly?.()).toBe(false)
    expect(tool.isConcurrencySafe?.()).toBe(false)
    expect(tool.isDestructive?.()).toBe(false)
    expect(tool.requiresUserInteraction).toBe(false)
  })

  it('permission.key = agent, extractPatterns 返回 agentId', () => {
    const tool = createSubagentTool(() => undefined, 5000, false)
    expect(tool.permission?.key).toBe('agent')
    const patterns = tool.permission!.extractPatterns({ agentId: 'coder', prompt: 'test' })
    expect(patterns).toEqual(['coder'])
  })

  it('renderUse 截断长 prompt', () => {
    const tool = createSubagentTool(() => undefined, 5000, false)
    const longPrompt = 'a'.repeat(200)
    const rendered = tool.renderUse!({ agentId: 'coder', prompt: longPrompt }) as any
    expect(rendered.agentId).toBe('coder')
    expect(rendered.prompt.length).toBeLessThan(200)
    expect(rendered.prompt).toInclude('...')
  })

  it('renderResult 返回预览', () => {
    const tool = createSubagentTool(() => undefined, 5000, false)
    const result: ToolResult<SubagentToolOutput> = {
      ok: true,
      output: { sessionId: 's_1', message: 'a'.repeat(300), messageCount: 3, summarized: false, toolCallCount: 0 },
    }
    const rendered = tool.renderResult!(result) as any
    expect(rendered.sessionId).toBe('s_1')
    expect(rendered.preview.length).toBeLessThan(300)
    expect(rendered.preview).toInclude('...')
  })

  // ===== Phase 1 新增测试 =====

  it('description 参数用作 session title', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const s = sessions.get(input.sessionId)
      if (s) { s.messages.push(makeMessage('assistant', 'done')) }
      return makeMessage('assistant', 'done')
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: '重构', description: 'Refactor foo' },
      makeToolContext(),
    )

    expect(res.ok).toBe(true)
    const created = sessions.get(res.output!.sessionId)
    expect(created?.title).toBe('Refactor foo')
  })

  it('model 覆盖传给 agent.query', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    let capturedModel: unknown = undefined
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      capturedModel = input.model
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(makeMessage('assistant', 'ok')) }
      return makeMessage('assistant', 'ok')
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    await tool.call(
      { agentId: 'coder', prompt: 'test', model: { modelId: 'gpt-4o', temperature: 0.1 } },
      makeToolContext(),
    )

    expect(capturedModel).toEqual({ modelId: 'gpt-4o', temperature: 0.1 })
  })

  it('sessionId 续接已有子 session', async () => {
    const sessions = new Map<string, Session>()
    // 预先创建一个子 session
    const session = createMockSessionManager(sessions)
    const existing = await session.create({ title: 'existing sub' })
    existing.messages.push(makeMessage('user', '第一轮'))
    existing.messages.push(makeMessage('assistant', '第一轮回复'))

    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const s = sessionsRef.get(input.sessionId)!
      s.messages.push(makeMessage('user', input.message))
      const msg = makeMessage('assistant', '第二轮回复')
      s.messages.push(msg)
      return msg
    })
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: '第二轮', sessionId: existing.id },
      makeToolContext(),
    )

    expect(res.ok).toBe(true)
    expect(res.output!.sessionId).toBe(existing.id)
    expect(res.output!.message).toBe('第二轮回复')
    expect(res.output!.messageCount).toBe(4) // 2 轮 × 2 条
  })

  it('sessionId 不存在时返回 SESSION_NOT_FOUND', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async () => makeMessage('assistant', 'x'))
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: 'test', sessionId: 'nonexistent' },
      makeToolContext(),
    )

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('SESSION_NOT_FOUND')
  })

  it('新创建的子 session 关联 parentId', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const s = sessions.get(input.sessionId)
      if (s) { s.messages.push(makeMessage('assistant', 'done')) }
      return makeMessage('assistant', 'done')
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: 'test' },
      makeToolContext({ sessionId: 'parent-session-123' }),
    )

    expect(res.ok).toBe(true)
    const created = sessions.get(res.output!.sessionId)
    expect(created?.parentId).toBe('parent-session-123')
  })

  it('renderUse 包含 description/model/sessionId', () => {
    const tool = createSubagentTool(() => undefined, 5000, false)
    const rendered = tool.renderUse!({
      agentId: 'coder',
      prompt: 'test',
      description: 'Refactor foo',
      model: { modelId: 'gpt-4o' },
      sessionId: 's_existing',
    }) as any
    expect(rendered.agentId).toBe('coder')
    expect(rendered.description).toBe('Refactor foo')
    expect(rendered.model).toBe('gpt-4o')
    expect(rendered.sessionId).toBe('s_existing')
  })
})

// ===== 插件测试 =====

describe('createSubagentPlugin', () => {
  function makeCtx() {
    const logs: Array<[string, string]> = []
    return {
      ctx: {
        log: {
          info: (m: string) => logs.push(['info', m]),
          warn: (m: string) => logs.push(['warn', m]),
          error: (m: string) => logs.push(['error', m]),
          debug: (m: string) => logs.push(['debug', m]),
        },
        bus: { publish: () => {}, subscribe: () => () => {} },
        config: { get: () => undefined, set: () => {} },
      } as any,
      logs,
    }
  }

  it('core.harness.start 注册子 Agent + 缓存 harness 引用', async () => {
    const coderAgent: AgentDefinition = {
      id: 'coder',
      name: 'Coder',
      description: '写代码',
      mode: 'subagent',
      tools: ['bash'],
      permission: { '*': 'allow' },
      promptFragments: [],
    }
    const plugin = createSubagentPlugin({ subagents: [coderAgent] })
    const { ctx, logs } = makeCtx()
    const hooks = await plugin.install(ctx)

    // Mock harness 引用
    let registered: AgentDefinition[] = []
    const mockHarness = {
      agent: {
        register: (def: AgentDefinition) => { registered.push(def) },
        get: () => undefined,
        list: () => registered,
        query: async () => makeMessage('assistant', 'ok'),
        queryStream: async function* () {},
      } as any,
      session: createMockSessionManager(new Map()),
    }

    await (hooks as any)['core.harness.start']?.({ harness: mockHarness })
    expect(registered.length).toBe(1)
    expect(registered[0].id).toBe('coder')
    expect(logs.some(([_, m]) => m.includes('已注册'))).toBe(true)
  })

  it('core.harness.start 跳过 mode 非 subagent 的定义', async () => {
    const primaryAgent: AgentDefinition = {
      id: 'primary',
      name: 'Primary',
      description: '主 Agent',
      mode: 'primary',
      tools: ['*'],
      permission: { '*': 'allow' },
      promptFragments: [],
    }
    const plugin = createSubagentPlugin({ subagents: [primaryAgent] })
    const { ctx, logs } = makeCtx()
    const hooks = await plugin.install(ctx)

    let registered: AgentDefinition[] = []
    const mockHarness = {
      agent: {
        register: (def: AgentDefinition) => { registered.push(def) },
        get: () => undefined,
        list: () => registered,
        query: async () => makeMessage('assistant', 'ok'),
        queryStream: async function* () {},
      } as any,
      session: createMockSessionManager(new Map()),
    }

    await (hooks as any)['core.harness.start']?.({ harness: mockHarness })
    expect(registered.length).toBe(0)
    expect(logs.some(([level, _]) => level === 'warn')).toBe(true)
  })

  it('core.tool.pool.assemble 注入 SubagentTool', async () => {
    const plugin = createSubagentPlugin({ subagents: [] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    // 先触发 core.harness.start（缓存 harness 引用）
    const mockHarness = {
      agent: { register: () => {}, get: () => undefined, list: () => [], query: async () => makeMessage('assistant', 'ok'), queryStream: async function* () {} } as any,
      session: createMockSessionManager(new Map()),
    }
    await (hooks as any)['core.harness.start']?.({ harness: mockHarness })

    const added: unknown[] = []
    const pool = { add: (t: unknown) => { added.push(t) } }
    await (hooks as any)['core.tool.pool.assemble']?.({}, pool)
    expect(added.length).toBe(1)
    expect((added[0] as { id: string }).id).toBe('subagent')
  })

  it('/subagents CLI 命令列出已注册子 Agent', async () => {
    const coderAgent: AgentDefinition = {
      id: 'coder',
      name: 'Coder',
      description: '写代码',
      mode: 'subagent',
      tools: ['bash', 'read_file'],
      permission: { '*': 'allow' },
      promptFragments: [],
      model: { modelId: 'gpt-4o' },
    }
    const plugin = createSubagentPlugin({ subagents: [coderAgent] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    // CLI commands 注册
    const cmdInput = { commands: [] as any[] }
    ;(hooks as any)['cli.commands']?.(cmdInput)
    expect(cmdInput.commands.length).toBe(2)
    expect(cmdInput.commands[0].command).toBe('subagents')
    expect(cmdInput.commands[1].command).toBe('tasks')

    // CLI command 处理
    const out: string[] = []
    const cliInput = {
      command: 'subagents', arg: '', out: (s: string) => { out.push(s) },
      sessionId: 's1', raw: 'subagents', result: undefined as any,
    }
    await (hooks as any)['cli.command']?.(cliInput)
    const text = out.join('')
    expect(text).toInclude('coder')
    expect(text).toInclude('Coder')
    expect(text).toInclude('bash, read_file')
    expect(text).toInclude('gpt-4o')
    expect(cliInput.result).toBe('continue')
  })

  it('无子 Agent 时不注册 /subagents 命令（但仍注册 /tasks 命令）', async () => {
    const plugin = createSubagentPlugin({ subagents: [] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    const cmdInput = { commands: [] as any[] }
    ;(hooks as any)['cli.commands']?.(cmdInput)
    expect(cmdInput.commands.length).toBe(1)
    expect(cmdInput.commands[0].command).toBe('tasks')
  })

  it('core.harness.start 后 /subagents 以注册表为准：md 定义的子 Agent（未配在插件里）也会列出并标注来源', async () => {
    const coderAgent: AgentDefinition = {
      id: 'coder',
      name: 'Coder',
      description: '', // 未提供描述 → 输出「（未提供）」而不是 undefined
      mode: 'subagent',
      tools: ['bash'],
      permission: { '*': 'allow' },
      promptFragments: [],
    }
    const plugin = createSubagentPlugin({ subagents: [coderAgent] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    // 模拟真实装配：md 定义的子 Agent 由 core 经 agentDirs 直接注册进 AgentRuntime，不经本插件
    const devopsAgent: AgentDefinition = {
      id: 'devops-architect',
      name: 'DevOps 工程师',
      description: 'CI/CD 与部署',
      mode: 'subagent',
      tools: ['bash'],
      permission: { '*': 'allow' },
      promptFragments: [],
    }
    const primaryAgent: AgentDefinition = {
      id: 'default',
      name: '主 Agent',
      description: 'primary 身份',
      mode: 'primary',
      tools: ['*'],
      permission: { '*': 'allow' },
      promptFragments: [],
    }
    const registry: AgentDefinition[] = [primaryAgent, devopsAgent]
    const mockHarness = {
      agent: {
        register: (def: AgentDefinition) => { registry.push(def) },
        get: (id: string) => registry.find((a) => a.id === id),
        list: () => registry,
        query: async () => makeMessage('assistant', 'ok'),
        queryStream: async function* () {},
      } as any,
      session: createMockSessionManager(new Map()),
    }
    await (hooks as any)['core.harness.start']?.({ harness: mockHarness })

    const out: string[] = []
    const cliInput = {
      command: 'subagents', arg: '', out: (s: string) => { out.push(s) },
      sessionId: 's1', raw: 'subagents', result: undefined as any,
    }
    await (hooks as any)['cli.command']?.(cliInput)
    const text = out.join('')

    // 注册表里两个 mode=subagent（coder 由插件注册、devops 来自 md）→ 都要列出
    expect(text).toInclude('可调用 2 个子 Agent')
    expect(text).toInclude('coder')
    expect(text).toInclude('devops-architect')
    // 来源标注区分「插件配置」与「agent 定义」
    expect(text).toInclude('[插件配置]')
    expect(text).toInclude('[agent 定义]')
    // 缺描述时不打印 undefined
    expect(text).toInclude('（未提供）')
    expect(text).not.toInclude('undefined')
    // primary 不是子 Agent，不该出现
    expect(text).not.toInclude('主 Agent')
  })

  it('/subagents：只读哨兵白名单渲染成「只读工具（缺省）」并解析出实际工具 id', async () => {
    // md 未声明 tools 时由 agentFromMarkdown 写入只读哨兵，这里的展示必须让用户
    // 看懂「它到底能用什么」——只写「只读工具」四个字等于没说。
    const mdAgent: AgentDefinition = {
      id: 'devops-architect',
      name: 'DevOps 工程师',
      description: 'CI/CD 与部署',
      mode: 'subagent',
      tools: [READONLY_TOOLS_SENTINEL],
      permission: { '*': 'allow' },
      promptFragments: [],
    }
    const plugin = createSubagentPlugin({ subagents: [] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)
    const registry: AgentDefinition[] = [mdAgent]
    const mockHarness = {
      agent: {
        register: () => {},
        get: (id: string) => registry.find((a) => a.id === id),
        list: () => registry,
        query: async () => makeMessage('assistant', 'ok'),
        queryStream: async function* () {},
      } as any,
      session: createMockSessionManager(new Map()),
      // 哨兵由 ToolRegistry 展开；这里模拟「只读工具 = read_file + list_dir」
      tools: {
        filterByWhitelist: (w: string[]) => (w.includes(READONLY_TOOLS_SENTINEL) ? [{ id: 'read_file' }, { id: 'list_dir' }] : []),
      },
    }
    await (hooks as any)['core.harness.start']?.({ harness: mockHarness })

    const out: string[] = []
    await (hooks as any)['cli.command']?.({
      command: 'subagents', arg: '', out: (s: string) => { out.push(s) },
      sessionId: 's1', raw: 'subagents', result: undefined as any,
    })
    const text = out.join('')

    expect(text).toInclude('只读工具（缺省）')
    expect(text).toInclude('= read_file, list_dir')
    // 不把内部字面量吐给用户
    expect(text).not.toInclude(READONLY_TOOLS_SENTINEL)
  })

  it('插件未配置子 Agent、但注册表里有 md 定义的子 Agent 时，/subagents 仍注册', async () => {
    const plugin = createSubagentPlugin({ subagents: [] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    const devopsAgent: AgentDefinition = {
      id: 'devops-architect',
      name: 'DevOps 工程师',
      description: 'CI/CD',
      mode: 'subagent',
      tools: ['bash'],
      permission: { '*': 'allow' },
      promptFragments: [],
    }
    const mockHarness = {
      agent: {
        register: () => {},
        get: () => undefined,
        list: () => [devopsAgent],
        query: async () => makeMessage('assistant', 'ok'),
        queryStream: async function* () {},
      } as any,
      session: createMockSessionManager(new Map()),
    }
    await (hooks as any)['core.harness.start']?.({ harness: mockHarness })

    const cmdInput = { commands: [] as any[] }
    ;(hooks as any)['cli.commands']?.(cmdInput)
    expect(cmdInput.commands.some((c) => c.command === 'subagents')).toBe(true)
  })

  it('uninstall 清理 harness 引用', async () => {
    const plugin = createSubagentPlugin({ subagents: [] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    const mockHarness = {
      agent: { register: () => {}, get: () => undefined, list: () => [], query: async () => makeMessage('assistant', 'ok'), queryStream: async function* () {} } as any,
      session: createMockSessionManager(new Map()),
    }
    await (hooks as any)['core.harness.start']?.({ harness: mockHarness })

    // 工具应该能工作
    const added: unknown[] = []
    const pool = { add: (t: unknown) => { added.push(t) } }
    await (hooks as any)['core.tool.pool.assemble']?.({}, pool)
    expect(added.length).toBe(1)

    await plugin.uninstall?.()

    // uninstall 后工具调用应返回 HARNESS_NOT_READY
    const tool = added[0] as { call: (i: SubagentToolInput, c: ToolContext) => Promise<ToolResult> }
    const res = await tool.call({ agentId: 'x', prompt: 'x' }, makeToolContext())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('HARNESS_NOT_READY')
  })
})

// ===== 端到端集成测试 =====

describe('Subagent 端到端', () => {
  it('主 Agent 通过 SubagentTool 派出子 Agent 完整流程', async () => {
    const coderAgent: AgentDefinition = {
      id: 'coder',
      name: 'Coder',
      description: '写代码的子 Agent',
      mode: 'subagent',
      tools: ['bash'],
      permission: { '*': 'allow' },
      promptFragments: ['你是写代码的子 Agent'],
    }

    const sessions = new Map<string, Session>()
    const sessionsRef = sessions

    // Mock agent.query：模拟子 Agent 执行任务
    const mockAgent = createMockAgentRuntime([coderAgent], async (input) => {
      const s = sessionsRef.get(input.sessionId)
      if (!s) throw new Error('session not found')
      // 模拟子 Agent 的对话
      s.messages.push(makeMessage('user', input.message))
      const assistantMsg = makeMessage('assistant', `已完成任务：${input.message}`)
      s.messages.push(assistantMsg)
      return assistantMsg
    })
    const mockSession = createMockSessionManager(sessions)

    const plugin = createSubagentPlugin({ subagents: [coderAgent] })
    const ctx = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }
    const hooks = await plugin.install(ctx as any)

    // 1. core.harness.start
    await (hooks as any)['core.harness.start']?.({ harness: { agent: mockAgent, session: mockSession } })

    // 2. core.tool.pool.assemble
    const added: unknown[] = []
    const pool = { add: (t: unknown) => { added.push(t) } }
    await (hooks as any)['core.tool.pool.assemble']?.({}, pool)
    const tool = added[0] as { call: (i: SubagentToolInput, c: ToolContext) => Promise<ToolResult<SubagentToolOutput>> }

    // 3. 主 Agent 调用 SubagentTool
    const res = await tool.call(
      { agentId: 'coder', prompt: '把 foo() 重构为 bar()' },
      makeToolContext({ sessionId: 'parent-session' }),
    )

    // 4. 验证结果
    expect(res.ok).toBe(true)
    expect(res.output!.message).toBe('已完成任务：把 foo() 重构为 bar()')
    expect(res.output!.messageCount).toBe(2)
    expect(res.output!.sessionId).not.toBe('parent-session') // 独立 session
  })
})

// ===== Bus 事件测试 =====

describe('SubagentTool Bus 事件', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }

  /** 创建一个捕获 Bus 事件的 mock bus */
  function createMockBus() {
    const events: Array<{ name: string; payload: any; source?: string }> = []
    const subscribers = new Map<string, Array<(e: any) => void>>()
    const allSubscribers: Array<(e: any) => void> = []
    return {
      events,
      bus: {
        async publish(event: any, payload: any, options?: { source?: string }) {
          const record = { name: event.name, payload, timestamp: Date.now(), source: options?.source }
          events.push({ name: event.name, payload, source: options?.source })
          // 通知特定事件订阅者
          const subs = subscribers.get(event.name) ?? []
          for (const s of subs) { await s(record) }
          // 通知全局订阅者
          for (const s of allSubscribers) { await s(record) }
        },
        subscribe(event: any, subscriber: any) {
          if (!subscribers.has(event.name)) subscribers.set(event.name, [])
          subscribers.get(event.name)!.push(subscriber)
          return () => {
            const arr = subscribers.get(event.name)
            if (arr) {
              const idx = arr.indexOf(subscriber)
              if (idx >= 0) arr.splice(idx, 1)
            }
          }
        },
        subscribeAll(subscriber: any) {
          allSubscribers.push(subscriber)
          return () => {
            const idx = allSubscribers.indexOf(subscriber)
            if (idx >= 0) allSubscribers.splice(idx, 1)
          }
        },
      } as any,
    }
  }

  it('成功执行时发布 started + completed 事件', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', 'Task done')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const { bus, events } = createMockBus()
    const harness = { agent, session, bus }

    const tool = createSubagentTool(() => harness, 5000, false)
    const ctx = makeToolContext({ sessionId: 'parent-1', agentId: 'primary', toolUseId: 'tu_1' })
    const res = await tool.call(
      { agentId: 'coder', prompt: '重构 foo', description: 'Refactor foo' },
      ctx,
    )

    expect(res.ok).toBe(true)
    expect(events.length).toBe(2)
    expect(events[0].name).toBe('subagent.started')
    expect(events[1].name).toBe('subagent.completed')

    // 验证 started 事件载荷
    const started = events[0].payload
    expect(started.agentId).toBe('coder')
    expect(started.agentName).toBe('Coder')
    expect(started.parentSessionId).toBe('parent-1')
    expect(started.parentAgentId).toBe('primary')
    expect(started.toolUseId).toBe('tu_1')
    expect(started.prompt).toBe('重构 foo')
    expect(started.description).toBe('Refactor foo')
    expect(started.isContinuation).toBe(false)
    expect(typeof started.startedAt).toBe('number')

    // 验证 completed 事件载荷
    const completed = events[1].payload
    expect(completed.agentId).toBe('coder')
    expect(completed.parentSessionId).toBe('parent-1')
    expect(completed.toolUseId).toBe('tu_1')
    expect(completed.replyPreview).toBe('Task done')
    expect(completed.messageCount).toBe(1)
    expect(typeof completed.durationMs).toBe('number')
    expect(completed.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('续接 session 时 started 事件 isContinuation=true', async () => {
    const sessions = new Map<string, Session>()
    const session = createMockSessionManager(sessions)
    const existing = await session.create({ title: 'existing sub' })
    existing.messages.push(makeMessage('user', '第一轮'))
    existing.messages.push(makeMessage('assistant', '第一轮回复'))

    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const s = sessionsRef.get(input.sessionId)!
      s.messages.push(makeMessage('assistant', '第二轮回复'))
      return makeMessage('assistant', '第二轮回复')
    })
    const { bus, events } = createMockBus()
    const harness = { agent, session, bus }

    const tool = createSubagentTool(() => harness, 5000, false)
    await tool.call(
      { agentId: 'coder', prompt: '第二轮', sessionId: existing.id },
      makeToolContext(),
    )

    expect(events.length).toBe(2)
    expect(events[0].name).toBe('subagent.started')
    expect(events[0].payload.isContinuation).toBe(true)
    expect(events[0].payload.subSessionId).toBe(existing.id)
  })

  it('Agent 未注册时发布 failed 事件', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([], async () => makeMessage('assistant', 'x'))
    const session = createMockSessionManager(sessions)
    const { bus, events } = createMockBus()
    const harness = { agent, session, bus }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call(
      { agentId: 'unknown', prompt: 'test' },
      makeToolContext({ toolUseId: 'tu_fail' }),
    )

    expect(res.ok).toBe(false)
    expect(events.length).toBe(1)
    expect(events[0].name).toBe('subagent.failed')
    expect(events[0].payload.code).toBe('AGENT_NOT_FOUND')
    expect(events[0].payload.agentId).toBe('unknown')
    expect(events[0].payload.toolUseId).toBe('tu_fail')
    expect(typeof events[0].payload.durationMs).toBe('number')
  })

  it('Harness 未就绪时返回 HARNESS_NOT_READY（bus 不可用，不发布事件）', async () => {
    // harness 为 undefined 时 bus 也不可用，无法发布事件
    const tool = createSubagentTool(() => undefined, 5000, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: 'test' },
      makeToolContext({ toolUseId: 'tu_no_harness' }),
    )

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('HARNESS_NOT_READY')
    // 无 bus，不发布任何事件
  })

  it('Harness 部分可用（有 bus 无 agent）时发布 failed 事件', async () => {
    const { bus, events } = createMockBus()
    // 模拟部分 harness：有 bus 但无 agent/session（core.harness.start 未完成）
    const tool = createSubagentTool(() => ({ bus } as any), 5000, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: 'test' },
      makeToolContext({ toolUseId: 'tu_partial' }),
    )

    // harness 存在但无 agent/session → 解构的 agent 为 undefined → agent.get 抛错
    // 但 harness 本身 truthy，不会进 HARNESS_NOT_READY 分支
    // 实际上 agent 为 undefined 时 agent.get 会抛 TypeError
    expect(res.ok).toBe(false)
    expect(events.length).toBe(1)
    expect(events[0].name).toBe('subagent.failed')
    expect(events[0].payload.code).toBe('HARNESS_NOT_READY')
  })

  it('超时时发布 failed 事件', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], () => new Promise<Message>(() => {}))
    const session = createMockSessionManager(sessions)
    const { bus, events } = createMockBus()
    const harness = { agent, session, bus }

    const tool = createSubagentTool(() => harness, 50, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: 'test' },
      makeToolContext({ toolUseId: 'tu_timeout' }),
    )

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('SUBAGENT_FAILED')
    // 应发布 started + failed 两个事件
    expect(events.length).toBe(2)
    expect(events[0].name).toBe('subagent.started')
    expect(events[1].name).toBe('subagent.failed')
    expect(events[1].payload.code).toBe('SUBAGENT_FAILED')
    expect(events[1].payload.agentId).toBe('coder')
    expect(events[1].payload.message).toInclude('超时')
  })

  it('无 bus 时不影响正常执行', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', 'done')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    // 不提供 bus
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: 'test' },
      makeToolContext(),
    )

    // 无 bus 时也应正常工作
    expect(res.ok).toBe(true)
    expect(res.output!.message).toBe('done')
  })

  it('completed 事件的 replyPreview 对长文本截断', async () => {
    const longReply = 'x'.repeat(300)
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', longReply)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const { bus, events } = createMockBus()
    const harness = { agent, session, bus }

    const tool = createSubagentTool(() => harness, 5000, false)
    await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    const completed = events.find((e) => e.name === 'subagent.completed')
    expect(completed).toBeDefined()
    expect(completed!.payload.replyPreview.length).toBeLessThan(300)
    expect(completed!.payload.replyPreview).toInclude('...')
  })

  it('started 事件的 prompt 对长文本截断', async () => {
    const longPrompt = 'y'.repeat(600)
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', 'done')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const { bus, events } = createMockBus()
    const harness = { agent, session, bus }

    const tool = createSubagentTool(() => harness, 5000, false)
    await tool.call({ agentId: 'coder', prompt: longPrompt }, makeToolContext())

    const started = events.find((e) => e.name === 'subagent.started')
    expect(started).toBeDefined()
    expect(started!.payload.prompt.length).toBeLessThan(600)
    expect(started!.payload.prompt).toInclude('...')
  })

  it('SUBAGENT_FAILED 时 failed 事件包含 subSessionId', async () => {
    // 模拟 agent.query 抛错（非超时）
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async () => {
      throw new Error('LLM 请求失败')
    })
    const session = createMockSessionManager(sessions)
    const { bus, events } = createMockBus()
    const harness = { agent, session, bus }

    const tool = createSubagentTool(() => harness, 5000, false)
    const res = await tool.call(
      { agentId: 'coder', prompt: 'test' },
      makeToolContext(),
    )

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('SUBAGENT_FAILED')
    const failed = events.find((e) => e.name === 'subagent.failed')
    expect(failed).toBeDefined()
    expect(failed!.payload.subSessionId).toBeDefined()
    expect(failed!.payload.message).toInclude('LLM 请求失败')
  })
})

// ===== 工具调用摘要测试 =====

describe('SubagentTool 工具调用摘要', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }

  /** 创建包含工具调用 part 的 assistant 消息 */
  function makeAssistantWithToolCalls(text: string, toolCalls: Array<{ toolUseId: string; toolId: string; input?: unknown; isError?: boolean }>): Message {
    const parts: any[] = [{ type: 'text', text }]
    for (const tc of toolCalls) {
      parts.push({ type: 'tool', toolUseId: tc.toolUseId, toolId: tc.toolId, input: tc.input, isError: tc.isError })
    }
    return { id: 'm_tc', role: 'assistant', parts, createdAt: Date.now() }
  }

  it('短结果不摘要：summarized=false，返回完整文本', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', '这是简短回复')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.ok).toBe(true)
    expect(res.output!.summarized).toBe(false)
    expect(res.output!.message).toBe('这是简短回复')
    expect(res.output!.toolCallCount).toBe(0)
  })

  it('长结果摘要：summarized=true，包含截断文本 + 工具调用列表', async () => {
    const longReply = 'x'.repeat(3000) // 超过 2000 字符阈值
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      // 模拟子 Agent 先调用工具再回复
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        // 工具调用消息
        s.messages.push(makeAssistantWithToolCalls('正在处理', [
          { toolUseId: 'tu_1', toolId: 'read_file', input: { path: '/src/foo.ts' } },
          { toolUseId: 'tu_2', toolId: 'bash', input: { command: 'npm test' } },
        ]))
        // 最终回复
        s.messages.push(makeMessage('assistant', longReply))
      }
      return makeMessage('assistant', longReply)
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.ok).toBe(true)
    expect(res.output!.summarized).toBe(true)
    expect(res.output!.toolCallCount).toBe(2)
    expect(res.output!.message).toInclude('[工具调用摘要（2 次）]')
    expect(res.output!.message).toInclude('read_file: /src/foo.ts')
    expect(res.output!.message).toInclude('bash: npm test')
    expect(res.output!.message).toInclude('[完整回复 1 行 / 3000 字符已截断为摘要]')
    expect(res.output!.message.length).toBeLessThan(3000)
    // 新增：outputPath 应有值且指向临时文件
    expect(res.output!.outputPath).toStartWith(tmpdir())
    expect(res.output!.outputPath).toInclude('subagent-output-')
  })

  it('工具调用摘要标记错误工具', async () => {
    const longReply = 'y'.repeat(2500)
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        s.messages.push(makeAssistantWithToolCalls('处理中', [
          { toolUseId: 'tu_1', toolId: 'bash', input: { command: 'false' }, isError: true },
        ]))
        s.messages.push(makeMessage('assistant', longReply))
      }
      return makeMessage('assistant', longReply)
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('bash: false [错误]')
  })

  it('maxResultLength 可配置', async () => {
    const mediumReply = 'z'.repeat(500) // 超过 100 但不超过 2000
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', mediumReply)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    // maxResultLength=100，500 字符应被摘要
    const tool = createSubagentTool(() => harness, 5000, false, 100)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('[完整回复 1 行 / 500 字符已截断为摘要]')
  })

  it('无工具调用的长结果仅截断文本', async () => {
    const longReply = 'w'.repeat(3000)
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', longReply)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.toolCallCount).toBe(0)
    // 无工具调用时不应包含工具调用摘要
    expect(res.output!.message).not.toInclude('[工具调用摘要')
    expect(res.output!.message).toInclude('[完整回复 1 行 / 3000 字符已截断为摘要]')
  })

  // ===== 新增：双阈值（行数）测试 =====

  it('maxResultLines 触发摘要：字符数不超但行数超', async () => {
    // 每行 10 字符，100 行 = 1000 字符（不超过 2000 字符阈值，但超过 50 行阈值）
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`)
    const longReply = lines.join('\n') // 100 行
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', longReply)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    // maxResultLength=2000（不触发），maxResultLines=50（触发）
    const tool = createSubagentTool(() => harness, 5000, false, 2000, 50)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('[完整回复 100 行 /')
    expect(res.output!.outputPath).toBeDefined()
  })

  // ===== 新增：head + tail 保留策略测试 =====

  it('head+tail 保留策略：摘要包含首行和末行', async () => {
    // 100 行，maxResultLines=20 → head 10 + tail 10
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`)
    const longReply = lines.join('\n')
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', longReply)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000, 20)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    const msg = res.output!.message
    // head 应包含 line-0 到 line-9
    expect(msg).toInclude('line-0')
    expect(msg).toInclude('line-9')
    // tail 应包含 line-90 到 line-99
    expect(msg).toInclude('line-90')
    expect(msg).toInclude('line-99')
    // 中间行不应出现
    expect(msg).not.toInclude('line-50')
    expect(msg).toInclude('...') // 分隔符
  })

  // ===== 新增：智能提示测试 =====

  it('智能提示：父 Agent 有 read_file 时提示用 read_file/grep_file', async () => {
    const longReply = 'x'.repeat(3000)
    const cwd = mkdtempSync(join(tmpdir(), 'sa-hint-read-'))
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', longReply)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500,
      undefined, undefined, undefined, DEFAULT_SUBAGENT_MAX_STEPS,
      () => join(cwd, '.harness', 'tasks'),
    )
    // ctx.variables.callerToolIds 包含 read_file，且结果目录在工作目录内 ⇒ 才能承诺可读
    const ctx = makeToolContext({
      variables: { callerToolIds: ['read_file', 'bash'] },
      cwd,
    })
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, ctx)

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('可使用 read_file 或 grep_file 工具查看')
    rmSync(cwd, { recursive: true, force: true })
  })

  it('智能提示：无探索工具且路径在工作目录外时，如实说明读不到（不再误报「请考虑拆分任务」）', async () => {
    const longReply = 'x'.repeat(3000)
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', longReply)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000)
    // ctx.variables 不含 callerToolIds；cwd=/tmp，落盘在 dataDir（工作目录外）
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('该路径不在工作目录内')
    expect(res.output!.message).not.toInclude('请考虑拆分任务')
  })

  it('智能提示：有 subagent 工具时提示可委派 explore agent', async () => {
    const longReply = 'x'.repeat(3000)
    const cwd = mkdtempSync(join(tmpdir(), 'sa-hint-'))
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', longReply)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500,
      undefined, undefined, undefined, DEFAULT_SUBAGENT_MAX_STEPS,
      () => join(cwd, '.harness', 'tasks'),
    )
    const ctx = makeToolContext({
      variables: { callerToolIds: ['read_file', 'grep_file', 'subagent'] },
      cwd,
    })
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, ctx)

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('或再次调用 subagent 工具委派 explore agent 处理')
    rmSync(cwd, { recursive: true, force: true })
  })

  // ===== 新增：directive 注入测试 =====

  it('directive 注入到子 Agent 的 prompt 前面', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    let capturedMessage: string | undefined
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      capturedMessage = input.message
      const msg = makeMessage('assistant', 'done')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const directive = '请按 Scope/Result/Key files 格式回复'
    const tool = createSubagentTool(() => harness, 5000, false, 2000, 500, directive)
    await tool.call({ agentId: 'coder', prompt: '分析 foo' }, makeToolContext())

    expect(capturedMessage).toStartWith(directive)
    expect(capturedMessage).toInclude('分析 foo')
  })

  it('无 directive 时 prompt 不被修改', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    let capturedMessage: string | undefined
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      capturedMessage = input.message
      const msg = makeMessage('assistant', 'done')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000, 500)
    await tool.call({ agentId: 'coder', prompt: '只做这件事' }, makeToolContext())

    expect(capturedMessage).toBe('只做这件事')
  })

  it('renderResult 包含 summarized 和 toolCallCount', () => {
    const tool = createSubagentTool(() => undefined, 5000, false, 2000)
    const result: ToolResult<SubagentToolOutput> = {
      ok: true,
      output: { sessionId: 's_1', message: 'test', messageCount: 3, summarized: true, toolCallCount: 5 },
    }
    const rendered = tool.renderResult!(result) as any
    expect(rendered.summarized).toBe(true)
    expect(rendered.toolCallCount).toBe(5)
  })

  it('summarizeToolInput 按工具类型提取关键信息', async () => {
    // 这个测试通过实际调用验证 summarizeToolInput 的行为
    const longReply = 'q'.repeat(2500)
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        s.messages.push(makeAssistantWithToolCalls('处理', [
          { toolUseId: 'tu_1', toolId: 'read_file', input: { path: '/src/index.ts' } },
          { toolUseId: 'tu_2', toolId: 'write_file', input: { filepath: '/dist/out.js' } },
          { toolUseId: 'tu_3', toolId: 'bash', input: { command: 'echo hello' } },
          { toolUseId: 'tu_4', toolId: 'glob', input: { pattern: '**/*.ts' } },
          { toolUseId: 'tu_5', toolId: 'grep_file', input: { pattern: 'TODO' } },
          { toolUseId: 'tu_6', toolId: 'web_fetch', input: { url: 'https://example.com' } },
          { toolUseId: 'tu_7', toolId: 'custom_tool', input: { name: 'value' } },
        ]))
        s.messages.push(makeMessage('assistant', longReply))
      }
      return makeMessage('assistant', longReply)
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    const msg = res.output!.message
    expect(msg).toInclude('read_file: /src/index.ts')
    expect(msg).toInclude('write_file: /dist/out.js')
    expect(msg).toInclude('bash: echo hello')
    expect(msg).toInclude('glob: **/*.ts')
    expect(msg).toInclude('grep_file: TODO')
    expect(msg).toInclude('web_fetch: https://example.com')
    expect(msg).toInclude('custom_tool: value')
  })

  it('bash 长命令截断到 80 字符', async () => {
    const longCmd = 'c'.repeat(100)
    const longReply = 'r'.repeat(2500)
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        s.messages.push(makeAssistantWithToolCalls('处理', [
          { toolUseId: 'tu_1', toolId: 'bash', input: { command: longCmd } },
        ]))
        s.messages.push(makeMessage('assistant', longReply))
      }
      return makeMessage('assistant', longReply)
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false, 2000)
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    const msg = res.output!.message
    // bash 命令应被截断到 80+3(...)
    const bashLine = msg.split('\n').find((l) => l.includes('bash:'))
    expect(bashLine).toBeDefined()
    expect(bashLine!.length).toBeLessThan(longCmd.length + 20)
    expect(bashLine).toInclude('...')
  })
})

// ===== 基于 caller.permission 过滤 Agent =====

describe('isAgentDenied', () => {
  it('无 callerPermission 时返回 false（全部放行）', () => {
    expect(isAgentDenied('coder')).toBe(false)
  })

  it('简写形式 agent: deny → 拒绝所有', () => {
    expect(isAgentDenied('coder', { agent: 'deny' })).toBe(true)
    expect(isAgentDenied('admin', { agent: 'deny' })).toBe(true)
  })

  it('简写形式 agent: allow/ask → 放行所有', () => {
    expect(isAgentDenied('coder', { agent: 'allow' })).toBe(false)
    expect(isAgentDenied('coder', { agent: 'ask' })).toBe(false)
  })

  it('详细形式 deny 列表匹配 agentId → 拒绝', () => {
    expect(isAgentDenied('admin', { agent: { deny: ['admin'] } })).toBe(true)
    expect(isAgentDenied('coder', { agent: { deny: ['admin'] } })).toBe(false)
  })

  it('详细形式 deny glob 匹配 → 拒绝', () => {
    expect(isAgentDenied('admin-1', { agent: { deny: ['admin-*'] } })).toBe(true)
    expect(isAgentDenied('coder', { agent: { deny: ['admin-*'] } })).toBe(false)
  })

  it('fallback 到 * 全局规则', () => {
    expect(isAgentDenied('coder', { '*': 'deny' })).toBe(true)
    expect(isAgentDenied('coder', { '*': 'allow' })).toBe(false)
  })

  it('agent 键优先于 * 全局规则', () => {
    // agent: allow 优先于 *: deny
    expect(isAgentDenied('coder', { agent: 'allow', '*': 'deny' })).toBe(false)
    // agent: deny 优先于 *: allow
    expect(isAgentDenied('coder', { agent: 'deny', '*': 'allow' })).toBe(true)
  })

  it('无 agent 键且无 * 键 → 放行', () => {
    expect(isAgentDenied('coder', { bash: 'allow' })).toBe(false)
  })

  it('allow/ask 不影响可见性（只 deny 拒绝）', () => {
    // coder 在 allow 列表，但 admin 不在 → 两者都可见（不被 deny）
    expect(isAgentDenied('coder', { agent: { allow: ['coder'] } })).toBe(false)
    expect(isAgentDenied('admin', { agent: { allow: ['coder'] } })).toBe(false)
  })
})

describe('filterAccessibleAgents', () => {
  const agents: AgentDefinition[] = [
    { id: 'coder', name: 'Coder', description: '写代码', mode: 'subagent', tools: ['bash'], permission: {} },
    { id: 'admin', name: 'Admin', description: '管理', mode: 'subagent', tools: ['*'], permission: {} },
    { id: 'reviewer', name: 'Reviewer', description: '审查', mode: 'subagent', tools: ['read_file'], permission: {} },
  ]

  it('无 callerPermission → 全部可见', () => {
    expect(filterAccessibleAgents(agents)).toHaveLength(3)
  })

  it('agent: deny → 全部被过滤', () => {
    expect(filterAccessibleAgents(agents, { agent: 'deny' })).toHaveLength(0)
  })

  it('agent: allow → 全部可见', () => {
    expect(filterAccessibleAgents(agents, { agent: 'allow' })).toHaveLength(3)
  })

  it('详细形式 deny 列表过滤特定 Agent', () => {
    const filtered = filterAccessibleAgents(agents, { agent: { deny: ['admin'] } })
    expect(filtered).toHaveLength(2)
    expect(filtered.map((a) => a.id).sort()).toEqual(['coder', 'reviewer'])
  })

  it('详细形式 deny glob 过滤多个 Agent', () => {
    const filtered = filterAccessibleAgents(agents, { agent: { deny: ['a*'] } })
    // 'admin' 匹配 'a*'，'coder' 和 'reviewer' 不匹配
    expect(filtered).toHaveLength(2)
    expect(filtered.map((a) => a.id).sort()).toEqual(['coder', 'reviewer'])
  })
})

describe('SubagentTool PERMISSION_DENIED', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }

  it('父 Agent permission.agent = deny 时调用子 Agent 返回 PERMISSION_DENIED', async () => {
    // 父 Agent 'primary' 的 permission 配置 agent: 'deny'
    const primaryAgent: AgentDefinition = {
      id: 'primary',
      name: 'Primary',
      description: '主 Agent',
      mode: 'primary',
      tools: ['subagent'],
      permission: { agent: 'deny', '*': 'allow' },
      promptFragments: [],
    }

    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([primaryAgent, coderAgent], async () => makeMessage('assistant', 'done'))
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const ctx = makeToolContext({ agentId: 'primary' })
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, ctx)

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('PERMISSION_DENIED')
  })

  it('父 Agent permission.agent.deny 匹配 agentId 时返回 PERMISSION_DENIED', async () => {
    const primaryAgent: AgentDefinition = {
      id: 'primary',
      name: 'Primary',
      description: '主 Agent',
      mode: 'primary',
      tools: ['subagent'],
      permission: { agent: { deny: ['admin'] }, '*': 'allow' },
      promptFragments: [],
    }
    const adminAgent: AgentDefinition = {
      id: 'admin',
      name: 'Admin',
      description: '管理 Agent',
      mode: 'subagent',
      tools: ['*'],
      permission: { '*': 'allow' },
      promptFragments: [],
    }

    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([primaryAgent, adminAgent], async () => makeMessage('assistant', 'done'))
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const ctx = makeToolContext({ agentId: 'primary' })
    // 调用被 deny 的 admin Agent
    const res = await tool.call({ agentId: 'admin', prompt: 'test' }, ctx)

    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('PERMISSION_DENIED')
  })

  it('父 Agent permission.agent.allow 时正常调用', async () => {
    const primaryAgent: AgentDefinition = {
      id: 'primary',
      name: 'Primary',
      description: '主 Agent',
      mode: 'primary',
      tools: ['subagent'],
      permission: { agent: 'allow', '*': 'allow' },
      promptFragments: [],
    }

    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([primaryAgent, coderAgent], async (input) => {
      const msg = makeMessage('assistant', 'Task done')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    const ctx = makeToolContext({ agentId: 'primary' })
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, ctx)

    expect(res.ok).toBe(true)
    expect(res.output!.message).toBe('Task done')
  })

  it('无父 Agent 定义时（ctx.agentId 无对应 Agent）不检查权限', async () => {
    // ctx.agentId = 'unknown'，agent.get('unknown') 返回 undefined → 不检查权限
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', 'done')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }

    const tool = createSubagentTool(() => harness, 5000, false)
    // ctx.agentId = 'unknown'，agent.get('unknown') 返回 undefined
    const ctx = makeToolContext({ agentId: 'unknown' })
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, ctx)

    expect(res.ok).toBe(true)
  })

  it('PERMISSION_DENIED 时发布 subagent.failed 事件', async () => {
    const primaryAgent: AgentDefinition = {
      id: 'primary',
      name: 'Primary',
      description: '主 Agent',
      mode: 'primary',
      tools: ['subagent'],
      permission: { agent: 'deny', '*': 'allow' },
      promptFragments: [],
    }

    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([primaryAgent, coderAgent], async () => makeMessage('assistant', 'done'))
    const session = createMockSessionManager(sessions)
    const { bus, events } = createMockBus()
    const harness = { agent, session, bus }

    const tool = createSubagentTool(() => harness, 5000, false)
    const ctx = makeToolContext({ agentId: 'primary' })
    await tool.call({ agentId: 'coder', prompt: 'test' }, ctx)

    // 应发布 failed 事件
    expect(events.length).toBe(1)
    expect(events[0].name).toBe('subagent.failed')
    expect(events[0].payload.code).toBe('PERMISSION_DENIED')
  })

  // 从 Bus 事件测试中复用 createMockBus
  function createMockBus() {
    const events: Array<{ name: string; payload: any; source?: string }> = []
    return {
      bus: {
        publish: async (eventDef: any, payload: any) => {
          // BusEvent.define 返回的是 { name, schema } 对象，不是字符串
          const name = typeof eventDef === 'string' ? eventDef : eventDef?.name
          events.push({ name, payload })
        },
        // Bus.subscribe/subscribeAll 返回同步 Unsubscribe（不是 Promise）
        subscribe: () => (() => {}),
        subscribeAll: () => (() => {}),
      },
      events,
    }
  }
})

// ===== BackgroundTaskRegistry 单元测试 =====

describe('BackgroundTaskRegistry', () => {
  it('register → pending → start → running', () => {
    const reg = new BackgroundTaskRegistry()
    const taskId = reg.register({
      agentId: 'coder',
      agentName: 'Coder',
      subSessionId: 's_1',
      parentSessionId: 'p_1',
      prompt: 'test',
    })
    expect(taskId).toStartWith('task-')

    const task = reg.get(taskId)!
    expect(task.status).toBe('pending')
    expect(task.agentId).toBe('coder')
    expect(task.subSessionId).toBe('s_1')

    reg.start(taskId)
    expect(reg.get(taskId)!.status).toBe('running')
    expect(reg.get(taskId)!.startedAt).toBeGreaterThan(0)
  })

  it('complete → 触发 wait 的 resolver', async () => {
    const reg = new BackgroundTaskRegistry()
    const taskId = reg.register({
      agentId: 'coder',
      agentName: 'Coder',
      subSessionId: 's_1',
      parentSessionId: 'p_1',
      prompt: 'test',
    })
    reg.start(taskId)

    // 启动 waiter
    const waitPromise = reg.wait(taskId, 1000)
    // 立即完成
    reg.complete(taskId, { result: 'done', messageCount: 5, toolCallCount: 2 })

    const task = await waitPromise
    expect(task).toBeDefined()
    expect(task!.status).toBe('completed')
    expect(task!.result).toBe('done')
    expect(task!.messageCount).toBe(5)
    expect(task!.toolCallCount).toBe(2)
    expect(task!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('fail → 触发 wait 的 resolver', async () => {
    const reg = new BackgroundTaskRegistry()
    const taskId = reg.register({
      agentId: 'coder',
      agentName: 'Coder',
      subSessionId: 's_1',
      parentSessionId: 'p_1',
      prompt: 'test',
    })
    reg.start(taskId)

    const waitPromise = reg.wait(taskId, 1000)
    reg.fail(taskId, { code: 'SUBAGENT_FAILED', message: 'error msg' })

    const task = await waitPromise
    expect(task!.status).toBe('failed')
    expect(task!.errorCode).toBe('SUBAGENT_FAILED')
    expect(task!.errorMessage).toBe('error msg')
  })

  it('wait 已完成任务立即返回', async () => {
    const reg = new BackgroundTaskRegistry()
    const taskId = reg.register({
      agentId: 'coder', agentName: 'Coder', subSessionId: 's_1', parentSessionId: 'p_1', prompt: 'x',
    })
    reg.start(taskId)
    reg.complete(taskId, { result: 'done' })

    const task = await reg.wait(taskId, 100)
    expect(task!.status).toBe('completed')
  })

  it('wait 超时返回 undefined', async () => {
    const reg = new BackgroundTaskRegistry()
    const taskId = reg.register({
      agentId: 'coder', agentName: 'Coder', subSessionId: 's_1', parentSessionId: 'p_1', prompt: 'x',
    })
    reg.start(taskId)

    const task = await reg.wait(taskId, 50)
    expect(task).toBeUndefined()
  })

  it('list 支持状态和 parentSessionId 过滤', () => {
    const reg = new BackgroundTaskRegistry()
    const t1 = reg.register({ agentId: 'a', agentName: 'A', subSessionId: 's1', parentSessionId: 'p1', prompt: 'x' })
    const t2 = reg.register({ agentId: 'b', agentName: 'B', subSessionId: 's2', parentSessionId: 'p1', prompt: 'y' })
    const t3 = reg.register({ agentId: 'c', agentName: 'C', subSessionId: 's3', parentSessionId: 'p2', prompt: 'z' })

    reg.start(t1); reg.complete(t1, { result: 'done' })
    reg.start(t2)

    expect(reg.list()).toHaveLength(3)
    expect(reg.list({ status: 'completed' })).toHaveLength(1)
    expect(reg.list({ status: 'running' })).toHaveLength(1)
    expect(reg.list({ parentSessionId: 'p1' })).toHaveLength(2)
    expect(reg.list({ parentSessionId: 'p1', status: 'completed' })).toHaveLength(1)
  })

  it('cancel 通过 AbortController 中断', () => {
    const reg = new BackgroundTaskRegistry()
    const taskId = reg.register({
      agentId: 'a', agentName: 'A', subSessionId: 's1', parentSessionId: 'p1', prompt: 'x',
    })
    const controller = new AbortController()
    reg.get(taskId)!.controller = controller
    reg.start(taskId)

    let aborted = false
    controller.signal.addEventListener('abort', () => { aborted = true })
    expect(reg.cancel(taskId)).toBe(true)
    expect(aborted).toBe(true)
    // 已 abort 后再次 cancel 返回 false（status 还是 running，但 controller.signal 已 aborted）
    // 实际：cancel 只检查 status === 'running'，所以仍可调用，但 abort 是幂等的
  })

  it('clear 清理已完成/失败任务', () => {
    const reg = new BackgroundTaskRegistry()
    const t1 = reg.register({ agentId: 'a', agentName: 'A', subSessionId: 's1', parentSessionId: 'p1', prompt: 'x' })
    const t2 = reg.register({ agentId: 'b', agentName: 'B', subSessionId: 's2', parentSessionId: 'p1', prompt: 'y' })
    reg.start(t1); reg.complete(t1, { result: 'done' })
    reg.start(t2); reg.fail(t2, { code: 'ERR', message: 'fail' })

    expect(reg.list()).toHaveLength(2)
    const removed = reg.clear()
    expect(removed).toBe(2)
    expect(reg.list()).toHaveLength(0)
  })

  it('并发多个任务（独立 taskId）', () => {
    const reg = new BackgroundTaskRegistry()
    const ids = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const id = reg.register({
        agentId: `a${i}`, agentName: `A${i}`, subSessionId: `s${i}`, parentSessionId: 'p1', prompt: 'x',
      })
      ids.add(id)
    }
    expect(ids.size).toBe(5)  // 5 个独立 taskId
    expect(reg.list()).toHaveLength(5)
  })
})

// ===== SubagentTool runInBackground 集成测试 =====

describe('SubagentTool runInBackground', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }

  it('runInBackground=true 立即返回 taskId（不等待子 Agent 完成）', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    // 模拟延迟的 agent.query
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      await new Promise((r) => setTimeout(r, 100))
      const msg = makeMessage('assistant', 'background done')
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        s.messages.push(msg)
      }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )
    const start = Date.now()
    const res = await tool.call(
      { agentId: 'coder', prompt: '后台重构', runInBackground: true },
      makeToolContext(),
    )
    const elapsed = Date.now() - start

    expect(res.ok).toBe(true)
    expect(res.output!.background).toBe(true)
    expect(res.output!.taskId).toStartWith('task-')
    expect(res.output!.sessionId).toStartWith('s_')
    // 立即返回（远小于 100ms 的 query 延迟）
    expect(elapsed).toBeLessThan(50)

    // 等待后台任务完成
    const task = await registry.wait(res.output!.taskId!, 1000)
    expect(task).toBeDefined()
    expect(task!.status).toBe('completed')
    expect(task!.result).toBe('background done')
    expect(task!.messageCount).toBe(2)
  })

  it('runInBackground=true 子 Agent 失败时 task 状态变 failed', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async () => {
      throw new Error('query error')
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )
    const res = await tool.call(
      { agentId: 'coder', prompt: 'fail task', runInBackground: true },
      makeToolContext(),
    )
    expect(res.ok).toBe(true)

    const task = await registry.wait(res.output!.taskId!, 1000)
    expect(task!.status).toBe('failed')
    expect(task!.errorCode).toBe('SUBAGENT_FAILED')
    expect(task!.errorMessage).toContain('query error')
  })


  it('并行调用多个 background subagent，所有任务独立完成', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const delay = 30 + Math.random() * 50
      await new Promise((r) => setTimeout(r, delay))
      const msg = makeMessage('assistant', `done ${input.message}`)
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        s.messages.push(msg)
      }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )

    // 并行启动 3 个后台任务
    const prompts = ['task A', 'task B', 'task C']
    const startPromises = prompts.map((p) =>
      tool.call({ agentId: 'coder', prompt: p, runInBackground: true }, makeToolContext())
    )
    const results = await Promise.all(startPromises)

    expect(results).toHaveLength(3)
    const taskIds = results.map((r) => r.output!.taskId)
    expect(new Set(taskIds).size).toBe(3)  // 3 个独立 taskId

    // 等待所有任务完成
    const waitPromises = taskIds.map((id) => registry.wait(id!, 1000))
    const tasks = await Promise.all(waitPromises)

    for (let i = 0; i < 3; i++) {
      expect(tasks[i]!.status).toBe('completed')
      expect(tasks[i]!.result).toBe(`done ${prompts[i]}`)
    }
  })

  it('partitionToolCalls：所有 subagent 调用均分到串行批次（即使 runInBackground=true）', async () => {
    const harness = {
      agent: createMockAgentRuntime([coderAgent], async () => makeMessage('assistant', 'ok')),
      session: createMockSessionManager(new Map()),
    }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )

    // 构造 4 个工具调用：bg, bg, sync, bg
    // 即使有 runInBackground=true，也全部各自串行批次
    const makeUse = (prompt: string, bg: boolean): ToolUse => ({
      toolId: 'subagent',
      tool,
      input: { agentId: 'coder', prompt, runInBackground: bg } as unknown,
      toolUseId: `${bg ? 'bg' : 'sync'}-${prompt}`,
    })
    const uses: ToolUse[] = [
      makeUse('A', true),
      makeUse('B', true),
      makeUse('C', false),
      makeUse('D', true),
    ]

    const batches = partitionToolCalls(uses)

    // 预期 4 个批次，全部串行：
    // runInBackground 的并行性由异步执行块保证，不依赖 partitionToolCalls
    expect(batches).toHaveLength(4)
    for (const batch of batches) {
      expect(batch.parallel).toBe(false)
      expect(batch.uses).toHaveLength(1)
    }
  })

  it('runInBackground=true 任务完成后自动向父 session 注入 task-notification 通知', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const delay = 20 + Math.random() * 20
      await new Promise((r) => setTimeout(r, delay))
      const msg = makeMessage('assistant', `done ${input.message}`)
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        s.messages.push(msg)
      }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )

    // 父 session 必须先存在
    const parentSession = await session.create({ title: 'parent' })
    const ctx = makeToolContext({ sessionId: parentSession.id })

    const res = await tool.call(
      { agentId: 'coder', prompt: 'do something', runInBackground: true },
      ctx,
    )

    expect(res.ok).toBe(true)
    expect(res.output!.taskId).toBeDefined()

    // 等待后台任务完成
    const taskId = res.output!.taskId!
    await registry.wait(taskId, 1000)

    // 验证父 session 的 pendingNotifications 队列中已注入通知
    const notifications = session.drainNotifications(parentSession.id)
    expect(notifications).toHaveLength(1)
    const notif = notifications[0]
    expect(notif).toInclude('<task-notification>')
    expect(notif).toInclude(`<task-id>${taskId}</task-id>`)
    expect(notif).toInclude('<status>completed</status>')
    expect(notif).toInclude('Agent "coder" completed')
    expect(notif).toInclude('<result>done do something</result>')
    expect(notif).toInclude('<duration-ms>')

    // 再次 drain 应为空（去重，不重复注入）
    const again = session.drainNotifications(parentSession.id)
    expect(again).toHaveLength(0)
  })

  it('completed 事件到达时通知**已经**入队（先入队后发事件）', async () => {
    // 回归：此前 `bus.publish(completed)` 排在 `enqueueNotification()` **之前**，而 publish 是
    // 异步的 ⇒ 驱动 barrier 的"全部完成"信号可能先于数据到达。CLI 收到 barrier 就注入
    // `<continue/>` 续轮并 peek 待处理通知 —— 读到空队列 ⇒ 判定空转 ⇒ 放弃且不重试 ⇒
    // 已跑完的结果滞留到用户下一次发话才送达（真机 s_1790082671456_82ikm 滞留 3 分钟）。
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      const msg = makeMessage('assistant', `done ${input.message}`)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(makeMessage('user', input.message)); s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const bus = createRecordingBus()
    const harness = { agent, session, bus: bus.asBus() }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )
    const parentSession = await session.create({ title: 'parent' })

    // 在 completed 事件的**订阅者里**查看队列：这就是 CLI 自动续轮所处的位置
    let queuedWhenEventArrived: number | undefined
    bus.on(SubagentEvents.completed, () => {
      queuedWhenEventArrived = session.peekNotifications(parentSession.id).length
    })

    const res = await tool.call(
      { agentId: 'coder', prompt: 'do something', runInBackground: true },
      makeToolContext({ sessionId: parentSession.id }),
    )
    await registry.wait(res.output!.taskId!, 1000)

    // 关键断言：事件到达时通知已在队列里（而不是"事件先到、数据后到"）
    expect(queuedWhenEventArrived).toBe(1)
  })

  it('failed 事件到达时通知**已经**入队（先入队后发事件）', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async () => { throw new Error('agent crashed') })
    const session = createMockSessionManager(sessions)
    const bus = createRecordingBus()
    const harness = { agent, session, bus: bus.asBus() }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )
    const parentSession = await session.create({ title: 'parent' })

    let queuedWhenEventArrived: number | undefined
    bus.on(SubagentEvents.failed, () => {
      queuedWhenEventArrived = session.peekNotifications(parentSession.id).length
    })

    const res = await tool.call(
      { agentId: 'coder', prompt: 'will fail', runInBackground: true },
      makeToolContext({ sessionId: parentSession.id }),
    )
    await registry.wait(res.output!.taskId!, 1000)

    expect(queuedWhenEventArrived).toBe(1)
  })

  it('runInBackground=true 任务失败后自动注入 failed task-notification 通知', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async () => {
      throw new Error('agent crashed')
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )

    const parentSession = await session.create({ title: 'parent' })
    const ctx = makeToolContext({ sessionId: parentSession.id })

    const res = await tool.call(
      { agentId: 'coder', prompt: 'will fail', runInBackground: true },
      ctx,
    )

    const taskId = res.output!.taskId!
    await registry.wait(taskId, 1000)

    const notifications = session.drainNotifications(parentSession.id)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toInclude('<status>failed</status>')
    expect(notifications[0]).toInclude('Agent "coder" failed')
    expect(notifications[0]).toInclude('agent crashed')
  })

  it('formatTaskNotification 生成完整的 task-notification XML', () => {
    const notif = formatTaskNotification({
      taskId: 'task-abc-1',
      status: 'completed',
      agentName: 'coder',
      description: '写单元测试',
      result: '已添加 3 个测试用例',
      outputPath: '/tmp/task-abc-1.txt',
      durationMs: 1500,
      messageCount: 5,
      toolCallCount: 2,
    })
    expect(notif).toInclude('<task-notification>')
    expect(notif).toInclude('</task-notification>')
    expect(notif).toInclude('<task-id>task-abc-1</task-id>')
    expect(notif).toInclude('<status>completed</status>')
    expect(notif).toInclude('Agent "写单元测试" completed')
    expect(notif).toInclude('<result>已添加 3 个测试用例</result>')
    expect(notif).toInclude('<output-file>/tmp/task-abc-1.txt</output-file>')
    expect(notif).toInclude('<duration-ms>1500</duration-ms>')
    expect(notif).toInclude('<message-count>5</message-count>')
    expect(notif).toInclude('<tool-call-count>2</tool-call-count>')
  })

  it('Agent 定义 background=true 时，即使不传 runInBackground 也走后台路径', async () => {
    const bgAgent: AgentDefinition = {
      id: 'researcher',
      name: 'Researcher',
      description: '默认后台执行的调研 Agent',
      mode: 'subagent',
      tools: ['read_file', 'web_search'],
      permission: { '*': 'allow' },
      promptFragments: ['你是调研 Agent'],
      background: true,
    }
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([bgAgent], async (input) => {
      await new Promise((r) => setTimeout(r, 100))
      const msg = makeMessage('assistant', 'research done')
      const s = sessionsRef.get(input.sessionId)
      if (s) {
        s.messages.push(makeMessage('user', input.message))
        s.messages.push(msg)
      }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )

    // 关键：不传 runInBackground，靠 Agent 定义 background: true 触发后台路径
    const start = Date.now()
    const res = await tool.call(
      { agentId: 'researcher', prompt: '调研竞品定价' },
      makeToolContext(),
    )
    const elapsed = Date.now() - start

    expect(res.ok).toBe(true)
    expect(res.output!.background).toBe(true)
    expect(res.output!.taskId).toStartWith('task-')
    // 立即返回（未等 100ms 的 query 延迟完成）
    expect(elapsed).toBeLessThan(50)

    // 等待后台任务完成
    const task = await registry.wait(res.output!.taskId!, 1000)
    expect(task!.status).toBe('completed')
    expect(task!.result).toBe('research done')
  })

  it('后台执行期间通过 queryStream 发布 subagent.progress 工具调用进度事件（P1-5）', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], undefined, async function* (input) {
      yield { type: 'tool_call_start', toolUseId: 'tu-1', toolId: 'read_file', input: { path: 'src/index.ts' } }
      yield { type: 'tool_call_result', toolUseId: 'tu-1', toolId: 'read_file', result: 'file content', isError: false }
      yield { type: 'tool_call_start', toolUseId: 'tu-2', toolId: 'bash', input: { command: 'ls' } }
      yield { type: 'tool_call_result', toolUseId: 'tu-2', toolId: 'bash', result: 'index.ts\n', isError: false }
      yield { type: 'text_delta', text: 'done reading' }
      yield { type: 'done', message: makeMessage('assistant', 'progress done') }
    })
    const session = createMockSessionManager(sessions)
    const bus = createBus()
    const progressEvents: Array<any> = []
    const off = bus.subscribe(SubagentEvents.progress, ({ payload }) => { progressEvents.push(payload) })
    const harness = { agent, session, bus }
    const registry = new BackgroundTaskRegistry()

    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry,
    )
    const res = await tool.call(
      { agentId: 'coder', prompt: '读取文件', runInBackground: true },
      makeToolContext(),
    )
    const taskId = res.output!.taskId!
    await registry.wait(taskId, 1000)
    off()

    expect(progressEvents.length).toBeGreaterThanOrEqual(4)
    // running 事件：read_file 输入摘要
    const running = progressEvents.find((e) => e.toolStatus === 'running' && e.toolName === 'read_file')
    expect(running).toBeDefined()
    expect(running.taskId).toBe(taskId)
    expect(running.summary).toInclude('src/index.ts')
    // completed 事件：read_file 结果预览
    const completed = progressEvents.find((e) => e.toolStatus === 'completed' && e.toolName === 'read_file')
    expect(completed).toBeDefined()
    expect(completed.summary).toInclude('file content')
    // bash 输入摘要
    const bash = progressEvents.find((e) => e.toolName === 'bash' && e.toolStatus === 'running')
    expect(bash).toBeDefined()
    expect(bash.summary).toInclude('ls')
  })
})

// ===== 完成通知去重降级（缺陷1）=====

describe('runInBackground 完成通知去重降级（缺陷1）', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }
  const RESULT_FULL = '这是完整结果：测绘 1902 个文件 / 512K 行源码'

  it('① 结果已被本地续跑通道取回：完成通知降级为简短提示且不含结果全文', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      await new Promise((r) => setTimeout(r, 20))
      const msg = makeMessage('assistant', RESULT_FULL)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(makeMessage('user', input.message)); s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(() => harness, 5000, false, 2000, 500, undefined, () => registry)

    const parentSession = await session.create({ title: 'parent' })
    const ctx = makeToolContext({ sessionId: parentSession.id })
    const res = await tool.call({ agentId: 'coder', prompt: 'do something', runInBackground: true }, ctx)
    const taskId = res.output!.taskId!

    // 模拟"结果已通过 send_message 本地续跑通道取回"
    registry.get(taskId)!.resultFetched = true

    await registry.wait(taskId, 1000)
    const notifications = session.drainNotifications(parentSession.id)
    expect(notifications).toHaveLength(1)
    const notif = notifications[0]
    expect(notif).toInclude('<task-notification>')
    expect(notif).toInclude(`<task-id>${taskId}</task-id>`)
    // 降级为简短提示
    expect(notif).toInclude('不再重复注入')
    // 关键：不含结果全文
    expect(notif).not.toInclude(RESULT_FULL)
    expect(notif).not.toInclude('<result>')
  })

  it('② 结果未被取回：完成通知仍注入结果全文', async () => {
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      await new Promise((r) => setTimeout(r, 20))
      const msg = makeMessage('assistant', RESULT_FULL)
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(makeMessage('user', input.message)); s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(() => harness, 5000, false, 2000, 500, undefined, () => registry)

    const parentSession = await session.create({ title: 'parent' })
    const ctx = makeToolContext({ sessionId: parentSession.id })
    const res = await tool.call({ agentId: 'coder', prompt: 'do something', runInBackground: true }, ctx)
    const taskId = res.output!.taskId!

    await registry.wait(taskId, 1000)
    const notifications = session.drainNotifications(parentSession.id)
    expect(notifications).toHaveLength(1)
    const notif = notifications[0]
    // 未被取回：注入结果全文
    expect(notif).toInclude('<result>')
    expect(notif).toInclude(RESULT_FULL)
  })

  it('formatTaskNotificationBrief 生成不含结果全文的简短提示', () => {
    const brief = formatTaskNotificationBrief({ taskId: 'task-abc-1', status: 'completed', agentName: 'coder', description: '测绘' })
    expect(brief).toInclude('<task-notification>')
    expect(brief).toInclude('<task-id>task-abc-1</task-id>')
    expect(brief).toInclude('不再重复注入')
    expect(brief).not.toInclude('<result>')
  })
})

// ===== 后台任务结果落盘（缺陷2）=====

describe('runInBackground 结果落盘可回看（缺陷2）', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }

  it('③ 父会话不可用（enqueueNotification 抛错）时结果落盘到 {dataDir}/tasks 且不抛异常', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'subagent-data-'))
    const tasksDir = join(dataDir, 'tasks')
    const sessions = new Map<string, Session>()
    const sessionsRef = sessions
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      await new Promise((r) => setTimeout(r, 20))
      const msg = makeMessage('assistant', '落盘内容：完成重构')
      const s = sessionsRef.get(input.sessionId)
      if (s) { s.messages.push(makeMessage('user', input.message)); s.messages.push(msg) }
      return msg
    })
    const session = createMockSessionManager(sessions)
    // 模拟父会话不可用：enqueueNotification 直接抛错
    ;(session as any).enqueueNotification = () => { throw new Error('session gone') }
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => tasksDir,
    )

    const parentSession = await session.create({ title: 'parent' })
    const ctx = makeToolContext({ sessionId: parentSession.id })
    const res = await tool.call({ agentId: 'coder', prompt: 'do', runInBackground: true }, ctx)
    const taskId = res.output!.taskId!

    // 等待完成：不应因 enqueue 抛错而异常或被判失败
    const task = await registry.wait(taskId, 1000)
    expect(task!.status).toBe('completed')

    // 等待落盘 IIFE 中 await persistTaskRecord 完成（registry.wait 在 complete 时即 resolve，先于落盘写文件）
    await new Promise((r) => setTimeout(r, 50))

    // 结果已落盘
    const file = join(tasksDir, `${taskId}.json`)
    expect(existsSync(file)).toBe(true)
    const rec = JSON.parse(readFileSync(file, 'utf-8'))
    expect(rec.taskId).toBe(taskId)
    expect(rec.status).toBe('completed')
    expect(rec.result).toInclude('落盘内容')
    expect(rec.agentId).toBe('coder')
    expect(typeof rec.createdAt).toBe('number')
    expect(typeof rec.finishedAt).toBe('number')

    // index.jsonl 可枚举
    const indexFile = join(tasksDir, 'index.jsonl')
    expect(existsSync(indexFile)).toBe(true)
    const lines = readFileSync(indexFile, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]).taskId).toBe(taskId)

    // listPersistedTasks 可读回
    const listed = await listPersistedTasks(tasksDir)
    expect(listed).toHaveLength(1)
    expect(listed[0].taskId).toBe(taskId)

    rmSync(dataDir, { recursive: true, force: true })
  })

  it('失败的后台任务同样落盘错误信息到 {dataDir}/tasks', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'subagent-data-fail-'))
    const tasksDir = join(dataDir, 'tasks')
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async () => { throw new Error('query error') })
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => tasksDir,
    )
    const parentSession = await session.create({ title: 'parent' })
    const ctx = makeToolContext({ sessionId: parentSession.id })
    const res = await tool.call({ agentId: 'coder', prompt: 'fail', runInBackground: true }, ctx)
    const taskId = res.output!.taskId!
    const task = await registry.wait(taskId, 1000)
    expect(task!.status).toBe('failed')

    // 等待落盘完成（registry.wait 在 fail 时即 resolve，先于 await persistTaskRecord 写文件）
    await new Promise((r) => setTimeout(r, 50))

    const rec = JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf-8'))
    expect(rec.status).toBe('failed')
    expect(rec.errorCode).toBe('SUBAGENT_FAILED')
    expect(rec.errorMessage).toInclude('query error')
    rmSync(tasksDir, { recursive: true, force: true })
  })

  // ===== 观察点 7：长任务中途草稿 =====
  //
  // 真机 s_1790163574429_tg1a6：reader#1 在 119,916ms 被 120s 超时掐断，而它当时"正在生成
  // 最终答复" —— registry 里 tasksDone=0，成果全丢。只读盘点型长任务尤其亏：工具早跑完了，
  // 差的就是最后那次总结，掐掉等于白跑。

  it('失败/超时被掐断时把中途产出落成草稿，并在失败信息里给出路径', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'subagent-draft-'))
    const tasksDir = join(dataDir, 'tasks')
    const sessions = new Map<string, Session>()
    // 剧本：先产出两条工具结果（"已经跑完的盘点"），然后在生成总结时炸掉
    const agent = createMockAgentRuntime(
      [coderAgent],
      undefined,
      async function* () {
        yield {
          type: 'tool_call_result', toolUseId: 't1', toolId: 'grep_file',
          result: 'packages/a.ts:12: TODO 待办', isError: false,
        }
        yield {
          type: 'tool_call_result', toolUseId: 't2', toolId: 'bash',
          result: '1902 files', isError: false,
        }
        throw new Error('后台子 Agent 执行超时（120000ms）')
      },
    )
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => tasksDir,
    )
    const parentSession = await session.create({ title: 'parent' })
    const ctx = makeToolContext({ sessionId: parentSession.id })
    const res = await tool.call({ agentId: 'coder', prompt: '盘点全仓 TODO', runInBackground: true }, ctx)
    const taskId = res.output!.taskId!
    const task = await registry.wait(taskId, 1000)
    expect(task!.status).toBe('failed')
    await new Promise((r) => setTimeout(r, 50))

    // 草稿文件按 taskId 固定命名，落在 {dataDir}/subagent-results/（与全文落盘同域）
    const draftPath = join(dataDir, 'subagent-results', `subagent-draft-${taskId}.md`)
    expect(existsSync(draftPath)).toBe(true)
    const draft = readFileSync(draftPath, 'utf-8')
    // ① 任务描述留着（否则草稿读不懂在干什么）；② 已完成的两条工具产出留着（这就是"没全丢"）
    expect(draft).toInclude('盘点全仓 TODO')
    expect(draft).toInclude('grep_file')
    expect(draft).toInclude('TODO 待办')
    expect(draft).toInclude('1902 files')
    // ③ 标题如实说明这是未完成的中间态，不是最终结果
    expect(draft).toInclude('中途草稿')

    // 失败信息里带路径 + **如实**的可读性说明（草稿在 dataDir 下，通常不在工作目录内）
    const rec = JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf-8'))
    expect(rec.errorMessage).toInclude('超时')
    expect(rec.errorMessage).toInclude(draftPath)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('草稿按 taskId 覆盖（同一任务只留一份，不堆半成品）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'subagent-draft-one-'))
    const tasksDir = join(dataDir, 'tasks')
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime(
      [coderAgent],
      undefined,
      async function* () {
        yield { type: 'tool_call_result', toolUseId: 't1', toolId: 'bash', result: 'a', isError: false }
        throw new Error('boom')
      },
    )
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => tasksDir,
    )
    const parentSession = await session.create({ title: 'parent' })
    const res = await tool.call(
      { agentId: 'coder', prompt: 'do', runInBackground: true },
      makeToolContext({ sessionId: parentSession.id }),
    )
    await registry.wait(res.output!.taskId!, 1000)
    await new Promise((r) => setTimeout(r, 50))

    const resultsDir = join(dataDir, 'subagent-results')
    const drafts = readdirSync(resultsDir).filter((f) => f.startsWith('subagent-draft-'))
    expect(drafts).toEqual([`subagent-draft-${res.output!.taskId!}.md`])
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('任务正常结束 ⇒ 草稿被删除（"有草稿文件"恒等于"这次被掐断"，语义干净）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'subagent-draft-clean-'))
    const tasksDir = join(dataDir, 'tasks')
    const sessions = new Map<string, Session>()
    // 间隔压到 0：第一次 done 之前的两条工具结果就会刷出一版草稿，
    // 之后任务正常收尾 ⇒ 必须把那份草稿删掉（完整结果已另存全文）
    const agent = createMockAgentRuntime(
      [coderAgent],
      undefined,
      async function* (input) {
        yield { type: 'tool_call_result', toolUseId: 't1', toolId: 'bash', result: 'halfway', isError: false }
        const msg = makeMessage('assistant', '最终报告：全部完成')
        const s = sessions.get(input.sessionId)
        if (s) { s.messages.push(makeMessage('user', input.message), msg) }
        yield { type: 'done', message: msg, step: 1 }
      },
    )
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => tasksDir, 0,
    )
    const parentSession = await session.create({ title: 'parent' })
    const res = await tool.call(
      { agentId: 'coder', prompt: 'do', runInBackground: true },
      makeToolContext({ sessionId: parentSession.id }),
    )
    const taskId = res.output!.taskId!
    const task = await registry.wait(taskId, 1000)
    expect(task!.status).toBe('completed')
    await new Promise((r) => setTimeout(r, 50))

    const resultsDir = join(dataDir, 'subagent-results')
    // 草稿已清：短结果整段内联回喂，不会另存全文，所以这里只断言"没有草稿残留"
    // （"草稿存在 ⇔ 被掐断"这条不变量就是靠它成立的）
    expect(existsSync(join(resultsDir, `subagent-draft-${taskId}.md`))).toBe(false)
    const leftovers = existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => f.includes('draft')) : []
    expect(leftovers).toEqual([])
    // 结果本身照常回到调用方（草稿的清理不影响结果）
    expect(task!.result ?? '').toInclude('最终报告')
    rmSync(dataDir, { recursive: true, force: true })
  })

  // ── 草稿的**最终归属**遥测（subagent.draft）──
  //
  // 为什么要有事件而不是只看文件：语义"有草稿文件 ⇔ 被掐断"依赖 `ls subagent-results/`，
  // 目录一旦被清理、或想直接算"掐断率"，就答不上来。事件化后可聚合：掐断占比、草稿多大、刷了几次。

  it('草稿遥测：被掐断 ⇒ subagent.draft kept=true，并带上 chars / flushCount', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'subagent-draft-tel-'))
    const tasksDir = join(dataDir, 'tasks')
    const sessions = new Map<string, Session>()
    // 没有 done 事件（直接抛）⇒ 只有 catch 里那一次强制刷盘
    const agent = createMockAgentRuntime(
      [coderAgent],
      undefined,
      async function* () {
        yield { type: 'tool_call_result', toolUseId: 't1', toolId: 'bash', result: 'halfway', isError: false }
        throw new Error('boom')
      },
    )
    const session = createMockSessionManager(sessions)
    const bus = createBus()
    const harness = { agent, session, bus }
    const drafts: Array<{ kept: boolean; chars: number; flushCount: number; taskId: string }> = []
    bus.subscribe(SubagentEvents.draft, ({ payload }) => { drafts.push(payload) })
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => tasksDir, 0,
    )
    const parentSession = await session.create({ title: 'parent' })
    const res = await tool.call(
      { agentId: 'coder', prompt: '盘点全仓 TODO', runInBackground: true },
      makeToolContext({ sessionId: parentSession.id }),
    )
    const taskId = res.output!.taskId!
    await registry.wait(taskId, 1000)
    await new Promise((r) => setTimeout(r, 50))

    expect(drafts).toHaveLength(1)
    const d = drafts[0]!
    expect(d.kept).toBe(true)
    expect(d.taskId).toBe(taskId)
    expect(d.chars).toBeGreaterThan(0)   // 保留时有内容（不是空壳）
    expect(d.flushCount).toBe(1)         // 只有 catch 那一次
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('草稿遥测：写过草稿但正常结束 ⇒ kept=false 且 chars=0（说明"这次没留残留"）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'subagent-draft-tel-ok-'))
    const tasksDir = join(dataDir, 'tasks')
    const sessions = new Map<string, Session>()
    // 间隔 0 ⇒ done 事件前就会刷一版草稿；随后正常收尾把它删掉
    const agent = createMockAgentRuntime(
      [coderAgent],
      undefined,
      async function* (input) {
        yield { type: 'tool_call_result', toolUseId: 't1', toolId: 'bash', result: 'halfway', isError: false }
        const msg = makeMessage('assistant', '最终报告：全部完成')
        const s = sessions.get(input.sessionId)
        if (s) { s.messages.push(makeMessage('user', input.message), msg) }
        yield { type: 'done', message: msg, step: 1 }
      },
    )
    const session = createMockSessionManager(sessions)
    const bus = createBus()
    const harness = { agent, session, bus }
    const drafts: Array<{ kept: boolean; chars: number; flushCount: number; path?: string }> = []
    bus.subscribe(SubagentEvents.draft, ({ payload }) => { drafts.push(payload) })
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => tasksDir, 0,
    )
    const parentSession = await session.create({ title: 'parent' })
    const res = await tool.call(
      { agentId: 'coder', prompt: 'do', runInBackground: true },
      makeToolContext({ sessionId: parentSession.id }),
    )
    const task = await registry.wait(res.output!.taskId!, 1000)
    expect(task!.status).toBe('completed')
    await new Promise((r) => setTimeout(r, 50))

    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.kept).toBe(false)
    expect(drafts[0]!.chars).toBe(0)          // 删掉了就不能报字节数
    expect(drafts[0]!.flushCount).toBe(1)     // done 前刷过一次
    expect(drafts[0]!.path).toBeUndefined()   // 只在 kept 时给路径
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('草稿遥测：从没写过草稿的快任务不发事件（不拿噪声充数，分母交给 completed/failed）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'subagent-draft-tel-none-'))
    const tasksDir = join(dataDir, 'tasks')
    const sessions = new Map<string, Session>()
    // 用**默认**间隔（15s）：任务秒级跑完，两次刷盘机会都没到
    const agent = createMockAgentRuntime(
      [coderAgent],
      undefined,
      async function* (input) {
        const msg = makeMessage('assistant', '快')
        const s = sessions.get(input.sessionId)
        if (s) { s.messages.push(makeMessage('user', input.message), msg) }
        yield { type: 'done', message: msg, step: 1 }
      },
    )
    const session = createMockSessionManager(sessions)
    const bus = createBus()
    const harness = { agent, session, bus }
    const drafts: unknown[] = []
    bus.subscribe(SubagentEvents.draft, ({ payload }) => { drafts.push(payload) })
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => tasksDir,
    )
    const parentSession = await session.create({ title: 'parent' })
    const res = await tool.call(
      { agentId: 'coder', prompt: 'do', runInBackground: true },
      makeToolContext({ sessionId: parentSession.id }),
    )
    await registry.wait(res.output!.taskId!, 1000)
    await new Promise((r) => setTimeout(r, 50))

    expect(drafts).toEqual([])
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('tasksDir 不可用时退化为不落盘且不抛异常', async () => {
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coderAgent], async () => makeMessage('assistant', 'ok'))
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const registry = new BackgroundTaskRegistry()
    const tool = createSubagentTool(
      () => harness, 5000, false, 2000, 500, undefined, () => registry, undefined, undefined, () => undefined,
    )
    const parentSession = await session.create({ title: 'parent' })
    const ctx = makeToolContext({ sessionId: parentSession.id })
    const res = await tool.call({ agentId: 'coder', prompt: 'do', runInBackground: true }, ctx)
    const task = await registry.wait(res.output!.taskId!, 1000)
    expect(task!.status).toBe('completed')
  })
})

// ===== 子 Agent 默认步数上限（缺陷3）=====

describe('子 Agent 默认步数上限（缺陷3）', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }

  it('④ 默认步数上限为 20', () => {
    expect(DEFAULT_SUBAGENT_MAX_STEPS).toBe(20)
  })

  it('④ 插件 maxSteps 选项可覆盖默认值', async () => {
    const sessions = new Map<string, Session>()
    const session = createMockSessionManager(sessions)
    const seen: Array<number | undefined> = []
    const agent = createMockAgentRuntime([coderAgent], async (input) => {
      seen.push((input as { maxSteps?: number }).maxSteps)
      return makeMessage('assistant', 'done')
    })
    const tool = createSubagentTool(() => ({ agent, session }), 5000, false, 2000, 500, undefined, undefined, undefined, 15)
    await tool.call({ agentId: 'coder', prompt: 'x' }, makeToolContext())
    expect(seen[0]).toBe(15)
  })

  it('④ 子 Agent 定义 maxSteps 优先于选项默认值', async () => {
    const sessions = new Map<string, Session>()
    const session = createMockSessionManager(sessions)
    const seen: Array<number | undefined> = []
    const agent = createMockAgentRuntime(
      [{ ...coderAgent, maxSteps: 25 }],
      async (input) => {
        seen.push((input as { maxSteps?: number }).maxSteps)
        return makeMessage('assistant', 'done')
      },
    )
    const tool = createSubagentTool(() => ({ agent, session }), 5000, false, 2000, 500, undefined, undefined, undefined, 15)
    await tool.call({ agentId: 'coder', prompt: 'x' }, makeToolContext())
    expect(seen[0]).toBe(25)
  })
})

// ===== BackgroundTaskMonitor 单元测试（P1-4 前端事件驱动展示）=====

describe('BackgroundTaskMonitor', () => {
  function makeStarted(taskId: string, overrides: Record<string, unknown> = {}) {
    return {
      agentId: 'coder',
      agentName: 'Coder',
      subSessionId: 's_sub',
      parentSessionId: 's_parent',
      parentAgentId: 'default',
      parentMessageId: 'm1',
      toolUseId: 't1',
      prompt: '写单元测试',
      description: '写单元测试',
      isContinuation: false,
      startedAt: Date.now(),
      taskId,
      background: true,
      ...overrides,
    }
  }

  it('started → running，completed → completed + 结果预览', async () => {
    const bus = createBus()
    const monitor = new BackgroundTaskMonitor({ bus })

    const snapshots: Array<ReadonlyArray<unknown>> = []
    monitor.subscribe((tasks) => snapshots.push(tasks))

    await bus.publish(SubagentEvents.started, makeStarted('task-1') as any)
    expect(monitor.getTasks()).toHaveLength(1)
    const running = monitor.get('task-1')!
    expect(running.status).toBe('running')
    expect(running.agentName).toBe('Coder')
    expect(running.description).toBe('写单元测试')

    await bus.publish(SubagentEvents.completed, {
      agentId: 'coder',
      subSessionId: 's_sub',
      parentSessionId: 's_parent',
      toolUseId: 't1',
      replyPreview: '已添加 3 个测试用例',
      messageCount: 5,
      durationMs: 1200,
      taskId: 'task-1',
      background: true,
    } as any)
    const done = monitor.get('task-1')!
    expect(done.status).toBe('completed')
    expect(done.result).toBe('已添加 3 个测试用例')
    expect(done.durationMs).toBe(1200)
    expect(done.messageCount).toBe(5)
    expect(done.finishedAt).toBeDefined()

    // 快照依次触发（running → completed 至少 2 次）
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    monitor.dispose()
  })

  it('failed → status=failed + error 信息', async () => {
    const bus = createBus()
    const monitor = new BackgroundTaskMonitor({ bus })

    await bus.publish(SubagentEvents.started, makeStarted('task-2') as any)
    await bus.publish(SubagentEvents.failed, {
      agentId: 'coder',
      subSessionId: 's_sub',
      parentSessionId: 's_parent',
      toolUseId: 't1',
      code: 'QUERY_FAILED',
      message: 'provider error',
      durationMs: 800,
      taskId: 'task-2',
      background: true,
    } as any)

    const t = monitor.get('task-2')!
    expect(t.status).toBe('failed')
    expect(t.error).toEqual({ code: 'QUERY_FAILED', message: 'provider error' })
    expect(t.durationMs).toBe(800)
    monitor.dispose()
  })

  it('parentSessionIds 过滤：只展示指定父 session 的任务', async () => {
    const bus = createBus()
    const monitor = new BackgroundTaskMonitor({ bus, parentSessionIds: ['s_a'] })

    await bus.publish(SubagentEvents.started, makeStarted('task-3', { parentSessionId: 's_a' }) as any)
    await bus.publish(SubagentEvents.started, makeStarted('task-4', { parentSessionId: 's_b' }) as any)

    expect(monitor.getTasks()).toHaveLength(1)
    expect(monitor.get('task-3')).toBeDefined()
    expect(monitor.get('task-4')).toBeUndefined()
    monitor.dispose()
  })

  it('backgroundOnly=false 时也纳入前台任务；默认只关注后台任务', async () => {
    const bus = createBus()
    const monitor = new BackgroundTaskMonitor({ bus }) // 默认 backgroundOnly=true

    await bus.publish(SubagentEvents.started, makeStarted('task-bg', { background: true }) as any)
    await bus.publish(SubagentEvents.started, makeStarted('task-fg', { background: false }) as any)

    expect(monitor.get('task-bg')).toBeDefined()
    expect(monitor.get('task-fg')).toBeUndefined()
    monitor.dispose()

    const monitorAll = new BackgroundTaskMonitor({ bus, backgroundOnly: false })
    await bus.publish(SubagentEvents.started, makeStarted('task-fg2', { background: false }) as any)
    expect(monitorAll.get('task-fg2')).toBeDefined()
    monitorAll.dispose()
  })

  it('无 taskId 的 started 事件被忽略（前台任务）', async () => {
    const bus = createBus()
    const monitor = new BackgroundTaskMonitor({ bus, backgroundOnly: false })

    await bus.publish(SubagentEvents.started, { ...makeStarted('x', { background: false }), taskId: undefined } as any)
    expect(monitor.getTasks()).toHaveLength(0)
    monitor.dispose()
  })

  it('dispose 后不再接收事件', async () => {
    const bus = createBus()
    const monitor = new BackgroundTaskMonitor({ bus })
    monitor.dispose()

    await bus.publish(SubagentEvents.started, makeStarted('task-5') as any)
    expect(monitor.getTasks()).toHaveLength(0)
  })

  it('progress 事件追加到任务进度列表，同 toolUseId 覆盖旧条目（P1-5）', async () => {
    const bus = createBus()
    const monitor = new BackgroundTaskMonitor({ bus })

    await bus.publish(SubagentEvents.started, makeStarted('task-6') as any)
    await bus.publish(SubagentEvents.progress, {
      taskId: 'task-6', agentId: 'coder', parentSessionId: 's_parent',
      toolUseId: 'tu-1', toolName: 'read_file', toolStatus: 'running',
      summary: 'src/index.ts', timestamp: 1,
    } as any)
    await bus.publish(SubagentEvents.progress, {
      taskId: 'task-6', agentId: 'coder', parentSessionId: 's_parent',
      toolUseId: 'tu-1', toolName: 'read_file', toolStatus: 'completed',
      summary: 'file content', timestamp: 2,
    } as any)
    await bus.publish(SubagentEvents.progress, {
      taskId: 'task-6', agentId: 'coder', parentSessionId: 's_parent',
      toolUseId: 'tu-2', toolName: 'bash', toolStatus: 'running',
      summary: 'ls', timestamp: 3,
    } as any)

    const t = monitor.get('task-6')!
    expect(t.progress).toHaveLength(2)
    // 最新在前
    expect(t.progress![0].toolUseId).toBe('tu-2')
    // tu-1 的 running 被 completed 覆盖
    const tu1 = t.progress!.find((p) => p.toolUseId === 'tu-1')!
    expect(tu1.toolStatus).toBe('completed')
    expect(tu1.summary).toBe('file content')
    monitor.dispose()
  })
})

// ===== 抽象层能力契约 =====
describe('subagentCapability（@harness/plugin.SubagentCapability）', () => {
  it('createMonitor 返回结构兼容 BackgroundTaskMonitor 的监控器并接收 Bus 事件', async () => {
    const bus = createBus()
    const monitor = subagentCapability.createMonitor({ bus, parentSessionIds: ['s_parent'] })

    const snapshots: Array<ReadonlyArray<{ taskId: string; status: string }>> = []
    monitor.subscribe((tasks) => snapshots.push(tasks.map((t) => ({ taskId: t.taskId, status: t.status }))))

    await bus.publish(SubagentEvents.started, {
      agentId: 'coder', agentName: 'Coder', subSessionId: 's_sub', parentSessionId: 's_parent',
      parentAgentId: 'default', parentMessageId: 'm1', toolUseId: 't1', prompt: '写测试',
      description: '写测试', isContinuation: false, startedAt: Date.now(), taskId: 'cap-1',
      background: true,
    } as any)

    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    const latest = snapshots[snapshots.length - 1]
    expect(latest).toEqual([{ taskId: 'cap-1', status: 'running' }])

    monitor.dispose()
  })
})

// ===== Subagent git worktree 隔离集成测试 =====
describe('Subagent git worktree 隔离', () => {
  const coderAgent: AgentDefinition = {
    id: 'coder',
    name: 'Coder',
    description: '负责写代码的子 Agent',
    mode: 'subagent',
    tools: ['read_file', 'write_file', 'bash'],
    permission: { '*': 'allow' },
    promptFragments: ['你是写代码的子 Agent'],
  }

  const cleanupDirs: string[] = []
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** 构造一个含基线提交的临时 git 仓库（返回 realpath，与 git 输出对齐） */
  async function makeGitRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'wt-int-'))
    await runGit(dir, ['init', '-q'])
    await runGit(dir, ['config', 'user.email', 't@e.com'])
    await runGit(dir, ['config', 'user.name', 'T'])
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'base'])
    cleanupDirs.push(dir)
    return realpathSync(dir)
  }

  /** 组装插件并触发 core.harness.start，返回可调用的 subagentTool */
  async function setupPlugin(cwd: string) {
    const sessions = new Map<string, Session>()
    const session = createMockSessionManager(sessions)
    const agent = createMockAgentRuntime(
      [coderAgent],
      async (input) => {
        if (input.message.includes('[delay]')) await sleep(40)
        const msg = makeMessage('assistant', 'done')
        const s = sessions.get(input.sessionId)
        if (s) { s.messages.push(makeMessage('user', input.message)); s.messages.push(msg) }
        return msg
      },
    )
    const plugin = createSubagentPlugin({ subagents: [coderAgent] })
    const ctx = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: async () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }
    const hooks = await plugin.install(ctx as any)
    await (hooks as any)['core.harness.start']?.({ harness: { agent, session, cwd } })
    const added: unknown[] = []
    const pool = { add: (t: unknown) => { added.push(t) } }
    await (hooks as any)['core.tool.pool.assemble']?.({}, pool)
    return {
      hooks,
      session,
      tool: added[0] as { call: (i: SubagentToolInput, c: ToolContext) => Promise<ToolResult<SubagentToolOutput>> },
    }
  }

  afterAll(() => {
    for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  })

  it('git 仓库下：子 session 落到独立 worktree；续接复用；有改动时返回 diff 摘要 + diffPath', async () => {
    const repo = await makeGitRepo()
    const { session, tool } = await setupPlugin(repo)
    const tctx = makeToolContext({ sessionId: 'parent-session' })

    // 首次调用：创建 worktree
    const res1 = await tool.call({ agentId: 'coder', prompt: '任务A' }, tctx)
    expect(res1.ok).toBe(true)
    const subSessionId = res1.output!.sessionId
    const child = await session.get(subSessionId)
    const worktreeDir = child!.cwd!
    expect(worktreeDir).toInclude(join(repo, '.harness', 'worktrees'))
    expect(existsSync(worktreeDir)).toBe(true)
    expect(await gitTopLevel(worktreeDir)).toBe(worktreeDir) // worktree 本身是有效 git 工作根
    // 无改动时不含 diff 摘要
    expect(res1.output!.message).not.toInclude('Git Diff 摘要')

    // 修改 worktree 内已跟踪文件（模拟子 Agent 修改；新文件不在 `git diff HEAD` 中）
    writeFileSync(join(worktreeDir, 'a.txt'), 'base\nchanged\n')

    // 续接同一 session：复用同一 worktree，且检测到改动
    const res2 = await tool.call({ agentId: 'coder', prompt: '继续', sessionId: subSessionId }, tctx)
    expect(res2.ok).toBe(true)
    const child2 = await session.get(subSessionId)
    expect(child2!.cwd).toBe(worktreeDir)
    expect(res2.output!.message).toInclude('## Git Diff 摘要')
    expect(res2.output!.message).toInclude('a.txt')
    expect(res2.output!.diffPath).toBeTruthy()
    expect(existsSync(res2.output!.diffPath!)).toBe(true)
  })

  it('非 git 目录：回退无隔离，session.cwd undefined、无 diff 摘要', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'wt-plain-int-'))
    cleanupDirs.push(plain)
    const { session, tool } = await setupPlugin(plain)
    const res = await tool.call({ agentId: 'coder', prompt: '任务' }, makeToolContext({ sessionId: 'parent-session' }))
    expect(res.ok).toBe(true)
    const child = await session.get(res.output!.sessionId)
    expect(child!.cwd).toBeUndefined()
    expect(res.output!.message).not.toInclude('Git Diff 摘要')
  })

  it('后台模式：子 session 落到 worktree，且有改动时通知含 diffPath', async () => {
    const repo = await makeGitRepo()
    const { session, tool } = await setupPlugin(repo)
    const tctx = makeToolContext({ sessionId: 'parent-session' })

    const res = await tool.call({ agentId: 'coder', prompt: '[delay] 后台任务', runInBackground: true }, tctx)
    expect(res.ok).toBe(true)
    expect(res.output!.taskId).toBeTruthy()
    const child = await session.get(res.output!.sessionId)
    const worktreeDir = child!.cwd!
    expect(worktreeDir).toInclude('.harness')
    expect(existsSync(worktreeDir)).toBe(true)

    // 立即修改已跟踪文件（后台 executor 内部带 40ms 延迟，确保 diff 能检测到）
    writeFileSync(join(worktreeDir, 'a.txt'), 'base\nchanged\n')

    // 等待后台完成并注入通知（git diff 较慢，轮询直到出现）
    let notif: string[] = []
    for (let i = 0; i < 20; i++) {
      await sleep(100)
      notif = session.drainNotifications('parent-session')
      if (notif.length > 0) break
    }
    expect(notif.length).toBe(1)
    expect(notif[0]).toInclude('<diff-file>')
    expect(notif[0]).toInclude('a.txt')
    expect(notif[0]).toInclude('Git Diff 摘要')
  })

  it('/worktrees 命令：list 显示隔离 worktree，remove 回收', async () => {
    const repo = await makeGitRepo()
    const { hooks, session, tool } = await setupPlugin(repo)

    // 产生一个 worktree
    const res = await tool.call({ agentId: 'coder', prompt: '任务' }, makeToolContext({ sessionId: 'parent-session' }))
    const child = await session.get(res.output!.sessionId)
    const worktreeDir = child!.cwd!

    // list
    const out: string[] = []
    const cliInput = { command: 'worktrees', arg: '', out: (s: string) => { out.push(s) }, sessionId: 's1', raw: 'worktrees', result: undefined as any }
    await (hooks as any)['cli.command']?.(cliInput)
    const listed = out.join('')
    expect(listed).toInclude('Worktrees')
    expect(listed).toInclude('HEAD=')

    // remove
    const out2: string[] = []
    const rmInput = { command: 'worktrees', arg: `remove ${worktreeDir}`, out: (s: string) => { out2.push(s) }, sessionId: 's1', raw: 'worktrees remove', result: undefined as any }
    await (hooks as any)['cli.command']?.(rmInput)
    expect(existsSync(worktreeDir)).toBe(false)
  })
})

// ===== 派工 roster 注入 =====
//
// 背景：agent 的 `description` **不进模型上下文**（只有 /subagents 展示用），subagent 工具的
// description 又是静态 txt ⇒ 派工方看不见有哪些子 Agent，只能靠用户点名或靠猜。roster 就是
// 把「id + 一句话触发条件」摆到它面前。

describe('派工 roster 注入', () => {
  // 本文件里的 makeCtx 定义在另一个 describe 内部（作用域不外露），这里自带一份最小 ctx
  const mkCtx = () =>
    ({
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }) as any

  const worker: AgentDefinition = {
    id: 'reader',
    name: '速读员',
    description:
      '并行读取多个文件/目录并回报事实（只读、不改文件、不做实现）。适合"把这几处的现状汇报给我"。',
    mode: 'subagent',
    tools: ['read_file'],
    permission: { '*': 'allow' },
    promptFragments: [],
  }

  it('renderRoster：每行 id + 一句话，长描述只取第一句并截断（不把省下的载荷吃回去）', () => {
    const text = renderRoster([worker])
    expect(text).toContain('## 可派工的子 Agent')
    const line = text.split('\n').find((l) => l.startsWith('- reader'))!
    expect(line).toContain('reader')
    // 只到第一个句号，且 ≤60 字符 ⇒ 不可能把整段 description（含 example）塞进来
    expect(line.length).toBeLessThan(90)
    expect(line).not.toContain('适合')
  })

  it('只给"自己有 subagent 工具"的 Agent 注入；派不了工的不注入（拿到是噪音）', async () => {
    const plugin = createSubagentPlugin({ subagents: [worker] })
    const ctx = mkCtx()
    const hooks = (await plugin.install(ctx)) as any
    const defs: Record<string, AgentDefinition> = {
      coordinator: {
        id: 'coordinator', name: 'Coordinator', mode: 'coordinator',
        description: '协调者：只看不写、负责派工',
        tools: ['subagent', 'read_file'], promptFragments: [],
        permission: { '*': 'ask' },
      },
      reader: worker,
    }
    const registered: AgentDefinition[] = []
    await hooks['core.harness.start']?.({
      harness: {
        agent: {
          register: (def: AgentDefinition) => registered.push(def),
          get: (id: string) => defs[id],
          list: () => [...registered, worker],
        } as any,
        session: createMockSessionManager(new Map()),
      },
    })

    const parts: string[] = []
    hooks['core.prompt.system.transform']?.({ agentId: 'coordinator' }, parts)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toContain('- reader — ')

    const parts2: string[] = []
    hooks['core.prompt.system.transform']?.({ agentId: 'reader' }, parts2)
    expect(parts2).toHaveLength(0) // reader 的 tools 里没有 subagent
  })

  it('injectRoster: false 时完全不注入（可关）', async () => {
    const plugin = createSubagentPlugin({ subagents: [worker], injectRoster: false })
    const ctx = mkCtx()
    const hooks = (await plugin.install(ctx)) as any
    await hooks['core.harness.start']?.({
      harness: {
        agent: {
          register: () => {},
          get: () => ({ id: 'coordinator', tools: ['subagent'] }),
          list: () => [worker],
        } as any,
        session: createMockSessionManager(new Map()),
      },
    })
    const parts: string[] = []
    hooks['core.prompt.system.transform']?.({ agentId: 'coordinator' }, parts)
    expect(parts).toHaveLength(0)
  })
})

describe('派工 roster：不把自己列进去', () => {
  const leader: AgentDefinition = {
    id: 'lead', name: '组长', description: '既能自己写代码，也能派工', mode: 'subagent',
    tools: ['bash', 'subagent'], promptFragments: [], permission: { '*': 'ask' },
  }
  const worker: AgentDefinition = {
    id: 'reader', name: '速读员', description: '只读并回报事实', mode: 'subagent',
    tools: ['read_file'], promptFragments: [], permission: { '*': 'ask' },
  }

  it('roster 只列别的子 Agent（否则会诱导"派给自己" ⇒ 无深度上限的递归）', async () => {
    const plugin = createSubagentPlugin({ subagents: [leader, worker] })
    const ctx = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    } as any
    const hooks = (await plugin.install(ctx)) as any
    await hooks['core.harness.start']?.({
      harness: {
        agent: {
          register: () => {},
          get: (id: string) => ({ lead: leader, reader: worker }[id]),
          list: () => [leader, worker],
        } as any,
        session: createMockSessionManager(new Map()),
      },
    })
    const parts: string[] = []
    hooks['core.prompt.system.transform']?.({ agentId: 'lead' }, parts)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toContain('- reader — ')
    expect(parts[0]).not.toContain('- lead — ')
  })
})

// ==========================================================================
// 完整输出落盘位置 + 提示语如实 + 派工方步数覆盖
//
// 回归对象：会话 `s_1789996799007_9cq9r`（lead 扫描仓库生成架构图）实测到的三处缺陷：
//   ① 全文写 `os.tmpdir()` ⇒ macOS 定期清理，而落盘的任务记录只有摘要 ⇒ 全文只此一份
//   ② 提示语把「报告超了 2000 字符阈值」误报成「请考虑拆分任务」；
//      且按 callerToolIds 拼的「可用 read_file 查看」分支因 core 从未注入该字段而是死代码
//   ③ 派工方无法按本次任务规模覆盖步数上限 ⇒ 6/6 reader 撞 20 步顶、报告全被截断
// ==========================================================================

describe('完整输出落盘位置与提示语', () => {
  const agentDef: AgentDefinition = {
    id: 'coder', name: 'Coder', description: '负责写代码', mode: 'subagent',
    tools: ['read_file'], promptFragments: [], permission: { '*': 'ask' },
  }

  /** 跑一次「子 Agent 返回超长文本」，返回摘要文本与完整输出路径 */
  // getTasksDir 的契约是返回 `{dataDir}/tasks`；插件据此把全文落到 `{dataDir}/subagent-results`，
  // 所以这里传的是 **tasksDir** 而不是结果目录本身。
  async function run(opts: {
    tasksDir?: string
    callerToolIds?: string[]
    cwd?: string
    replyLength?: number
  } = {}): Promise<{ message: string; outputPath: string }> {
    const reply = 'x'.repeat(opts.replyLength ?? 3000) // 默认超 2000 阈值 ⇒ 触发摘要
    const sessions = new Map<string, Session>()
    const ref = sessions
    const agent = createMockAgentRuntime([agentDef], async (input) => {
      ref.get(input.sessionId)?.messages.push(makeMessage('assistant', reply))
      return makeMessage('assistant', reply)
    })
    const session = createMockSessionManager(sessions)
    const tool = createSubagentTool(
      () => ({ agent, session }),
      5000, false, 2000, 500,
      undefined, undefined, undefined,
      DEFAULT_SUBAGENT_MAX_STEPS,
      () => opts.tasksDir,
    )
    const res = await tool.call(
      { agentId: 'coder', prompt: 'test' },
      makeToolContext({
        variables: { callerToolIds: opts.callerToolIds ?? [] },
        cwd: opts.cwd ?? '/tmp',
      }),
    )
    expect(res.ok).toBe(true)
    expect(res.output!.summarized).toBe(true)
    return { message: res.output!.message, outputPath: res.output!.outputPath! }
  }

  it('落盘到 {dataDir}/subagent-results：文件真实存在且内容为全文（不再只写 OS 临时目录）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sa-results-'))
    try {
      const expectedDir = join(base, 'subagent-results')
      const { outputPath, message } = await run({ tasksDir: join(base, 'tasks') })
      expect(outputPath).toStartWith(expectedDir)
      expect(outputPath).toInclude('subagent-output-')
      expect(existsSync(outputPath)).toBe(true)
      expect(readFileSync(outputPath, 'utf-8')).toHaveLength(3000)
      expect(message).toInclude(outputPath)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('文件名带随机段：连续两次不撞名（只用 Date.now() 同毫秒会互相覆盖）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sa-uniq-'))
    try {
      const tasksDir = join(base, 'tasks')
      const a = await run({ tasksDir })
      const b = await run({ tasksDir })
      expect(a.outputPath).not.toBe(b.outputPath)
      expect(existsSync(a.outputPath)).toBe(true)
      expect(existsSync(b.outputPath)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('结果目录不可用时退化到 OS 临时目录（旧行为不变）', async () => {
    const { outputPath } = await run({})
    expect(outputPath).toStartWith(tmpdir())
  })

  it('路径在工作目录外：即使调用方有 read_file 也不承诺可读（避免模型必去试、试必失败）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sa-out-'))
    const cwd = mkdtempSync(join(tmpdir(), 'sa-cwd-'))
    try {
      const { message } = await run({
        tasksDir: join(base, 'tasks'), cwd,
        callerToolIds: ['read_file', 'grep_file', 'subagent'],
      })
      expect(message).not.toInclude('可使用 read_file')
      expect(message).toInclude('不在工作目录内')
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('不再把「超了字符阈值」误报成「请考虑拆分任务」', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sa-msg-'))
    try {
      const { message } = await run({ tasksDir: join(base, 'tasks'), callerToolIds: [] })
      expect(message).not.toInclude('请考虑拆分任务')
      expect(message).toInclude('已截断为摘要')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('路径在工作目录内且调用方确有 read_file 时才承诺可读', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sa-in-'))
    try {
      const { message } = await run({
        tasksDir: join(cwd, '.harness', 'tasks'), cwd, callerToolIds: ['read_file'],
      })
      expect(message).toInclude('可使用 read_file')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('派工方可按本次任务规模覆盖子 Agent 步数上限', () => {
  const base: AgentDefinition = {
    id: 'reader', name: '速读员', description: '只读回报事实', mode: 'subagent',
    tools: ['read_file'], promptFragments: [], permission: { '*': 'ask' },
  }

  async function seenSteps(def: AgentDefinition, input: Partial<SubagentToolInput>): Promise<number | undefined> {
    const seen: Array<number | undefined> = []
    const agent = createMockAgentRuntime([def], async (i) => {
      seen.push((i as { maxSteps?: number }).maxSteps)
      return makeMessage('assistant', 'done')
    })
    const tool = createSubagentTool(() => ({ agent, session: createMockSessionManager(new Map()) }), 5000, false)
    await tool.call({ agentId: def.id, prompt: 'x', ...input }, makeToolContext())
    return seen[0]
  }

  it('未传 maxSteps：仍以子 Agent 定义为准（旧行为不变）', async () => {
    expect(await seenSteps({ ...base, maxSteps: 25 }, {})).toBe(25)
    expect(await seenSteps(base, {})).toBe(DEFAULT_SUBAGENT_MAX_STEPS)
  })

  it('传了 maxSteps：优先于子 Agent 定义与插件默认（通读类任务可显式给足）', async () => {
    expect(await seenSteps({ ...base, maxSteps: 25 }, { maxSteps: 40 })).toBe(40)
    expect(await seenSteps(base, { maxSteps: 40 })).toBe(40)
  })

  // 回归：`0 ?? x` 不会跳过 `0`，非法覆盖值此前会一路透传下去。若引擎侧也无脑 `Math.max(1, 0)`，
  // 子 Agent 就只跑 1 步 —— 现象像「任务太小」，与「模型把入参填成 0」完全对不上。
  // 现在这一层直接忽略非法值，按下一优先级取值。
  it('非法覆盖值（0 / <-1 / NaN）被忽略：回落子 Agent 定义或插件默认，不静默变成 1 步', async () => {
    expect(await seenSteps({ ...base, maxSteps: 25 }, { maxSteps: 0 })).toBe(25)
    expect(await seenSteps(base, { maxSteps: 0 })).toBe(DEFAULT_SUBAGENT_MAX_STEPS)
    expect(await seenSteps({ ...base, maxSteps: 25 }, { maxSteps: -3 })).toBe(25)
    expect(await seenSteps({ ...base, maxSteps: 25 }, { maxSteps: Number.NaN })).toBe(25)
  })

  it('-1 = 不限是合法覆盖值：原样透传（由引擎转 Infinity）', async () => {
    expect(await seenSteps({ ...base, maxSteps: 25 }, { maxSteps: -1 })).toBe(-1)
  })

  it('非法覆盖值会经 ctx.log.warn 告警（可观测，不静默）', async () => {
    const warns: string[] = []
    const agent = createMockAgentRuntime([{ ...base, maxSteps: 25 }], async () => makeMessage('assistant', 'done'))
    const tool = createSubagentTool(() => ({ agent, session: createMockSessionManager(new Map()) }), 5000, false)
    await tool.call(
      { agentId: base.id, prompt: 'x', maxSteps: 0 },
      makeToolContext({
        log: { info: () => {}, warn: (m: string) => { warns.push(m) }, error: () => {} },
      }),
    )
    expect(warns.some((w) => w.includes('maxSteps') && w.includes('无效'))).toBe(true)
  })
})
