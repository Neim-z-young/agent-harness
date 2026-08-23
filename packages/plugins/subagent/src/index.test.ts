import { describe, it, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import {
  createSubagentPlugin,
  createSubagentTool,
  isAgentDenied,
  filterAccessibleAgents,
  type SubagentToolInput,
  type SubagentToolOutput,
  type SubagentPluginOptions,
} from './index'
import type { AgentDefinition } from '@harness/agent'
import type { AgentRuntime } from '@harness/core'
import type { SessionManager, Session, Message } from '@harness/session'
import type { ToolContext, ToolResult } from '@harness/tool'

// ===== Mock helper =====

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    id: `m_${Math.random().toString(36).slice(2, 7)}`,
    role,
    parts: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
}

function createMockAgentRuntime(agents: AgentDefinition[], queryImpl?: (input: { sessionId: string; agentId?: string; message: string; model?: { providerId?: string; modelId?: string; temperature?: number } }) => Promise<Message>): AgentRuntime {
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  return {
    register: (def: AgentDefinition) => { agentMap.set(def.id, def) },
    get: (id: string) => agentMap.get(id),
    list: () => Array.from(agentMap.values()),
    query: queryImpl ?? (async () => makeMessage('assistant', 'mock response')),
    queryStream: async function* () { /* noop */ },
  }
}

function createMockSessionManager(sessions: Map<string, Session>): SessionManager {
  return {
    create: async (options?: { title?: string; parentId?: string }) => {
      const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const session: Session = {
        id,
        title: options?.title ?? 'subagent session',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentId: options?.parentId,
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

  it('harness.start 注册子 Agent + 缓存 harness 引用', async () => {
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

    await (hooks as any)['harness.start']?.({ harness: mockHarness })
    expect(registered.length).toBe(1)
    expect(registered[0].id).toBe('coder')
    expect(logs.some(([_, m]) => m.includes('已注册'))).toBe(true)
  })

  it('harness.start 跳过 mode 非 subagent 的定义', async () => {
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

    await (hooks as any)['harness.start']?.({ harness: mockHarness })
    expect(registered.length).toBe(0)
    expect(logs.some(([level, _]) => level === 'warn')).toBe(true)
  })

  it('tool.pool.assemble 注入 SubagentTool', async () => {
    const plugin = createSubagentPlugin({ subagents: [] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    // 先触发 harness.start（缓存 harness 引用）
    const mockHarness = {
      agent: { register: () => {}, get: () => undefined, list: () => [], query: async () => makeMessage('assistant', 'ok'), queryStream: async function* () {} } as any,
      session: createMockSessionManager(new Map()),
    }
    await (hooks as any)['harness.start']?.({ harness: mockHarness })

    const added: unknown[] = []
    const pool = { add: (t: unknown) => { added.push(t) } }
    await (hooks as any)['tool.pool.assemble']?.({}, pool)
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
    expect(cmdInput.commands.length).toBe(1)
    expect(cmdInput.commands[0].command).toBe('subagents')

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

  it('无子 Agent 时不注册 /subagents 命令', async () => {
    const plugin = createSubagentPlugin({ subagents: [] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    const cmdInput = { commands: [] as any[] }
    ;(hooks as any)['cli.commands']?.(cmdInput)
    expect(cmdInput.commands.length).toBe(0)
  })

  it('uninstall 清理 harness 引用', async () => {
    const plugin = createSubagentPlugin({ subagents: [] })
    const { ctx } = makeCtx()
    const hooks = await plugin.install(ctx)

    const mockHarness = {
      agent: { register: () => {}, get: () => undefined, list: () => [], query: async () => makeMessage('assistant', 'ok'), queryStream: async function* () {} } as any,
      session: createMockSessionManager(new Map()),
    }
    await (hooks as any)['harness.start']?.({ harness: mockHarness })

    // 工具应该能工作
    const added: unknown[] = []
    const pool = { add: (t: unknown) => { added.push(t) } }
    await (hooks as any)['tool.pool.assemble']?.({}, pool)
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

    // 1. harness.start
    await (hooks as any)['harness.start']?.({ harness: { agent: mockAgent, session: mockSession } })

    // 2. tool.pool.assemble
    const added: unknown[] = []
    const pool = { add: (t: unknown) => { added.push(t) } }
    await (hooks as any)['tool.pool.assemble']?.({}, pool)
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
    // 模拟部分 harness：有 bus 但无 agent/session（harness.start 未完成）
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
    // ctx.variables.callerToolIds 包含 read_file
    const ctx = makeToolContext({ variables: { callerToolIds: ['read_file', 'bash'] } })
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, ctx)

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('可使用 read_file 或 grep_file 工具查看')
  })

  it('智能提示：父 Agent 无探索工具时给出通用提示', async () => {
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
    // ctx.variables 不含 callerToolIds
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, makeToolContext())

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('请考虑拆分任务')
  })

  it('智能提示：父 Agent 有 subagent 工具时提示可委派 explore agent', async () => {
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
    const ctx = makeToolContext({
      variables: { callerToolIds: ['read_file', 'grep_file', 'subagent'] },
    })
    const res = await tool.call({ agentId: 'coder', prompt: 'test' }, ctx)

    expect(res.output!.summarized).toBe(true)
    expect(res.output!.message).toInclude('或再次调用 subagent 工具委派 explore agent 处理')
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
