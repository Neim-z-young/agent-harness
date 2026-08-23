import { describe, it, expect } from 'bun:test'
import {
  createSubagentPlugin,
  createSubagentTool,
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

function createMockAgentRuntime(agents: AgentDefinition[], queryImpl?: (input: { sessionId: string; agentId?: string; message: string }) => Promise<Message>): AgentRuntime {
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
    create: async (options?: { title?: string }) => {
      const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const session: Session = {
        id,
        title: options?.title ?? 'subagent session',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
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
      output: { sessionId: 's_1', message: 'a'.repeat(300), messageCount: 3 },
    }
    const rendered = tool.renderResult!(result) as any
    expect(rendered.sessionId).toBe('s_1')
    expect(rendered.preview.length).toBeLessThan(300)
    expect(rendered.preview).toInclude('...')
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
