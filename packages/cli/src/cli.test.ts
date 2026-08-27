import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseCliArgs,
  SessionFileStore,
  CliPermissionEngine,
  HarnessApp,
  ConfigStore,
  resolveConfig,
  parseModelSpec,
  formatModel,
  startRepl,
  attachBackgroundTaskPanel,
  attachAutoContinue,
  HELP_TEXT,
  main,
} from './index'
import { SubagentEvents } from '@harness/subagent'
import { CoordinatorEvents } from '@harness/coordinator'
import type { PermissionDecision } from '@harness/permission'
import type { AgentPlugin, Hooks } from '@harness/plugin'

describe('parseCliArgs 命令解析', () => {
  it('默认 repl 命令', () => {
    const a = parseCliArgs([])
    expect(a.command).toBe('repl')
    expect(a.agentId).toBeUndefined()
  })

  it('start 别名 → repl', () => {
    expect(parseCliArgs(['start']).command).toBe('repl')
  })

  it('list-sessions / resume / run', () => {
    expect(parseCliArgs(['list-sessions']).command).toBe('list-sessions')
    const r = parseCliArgs(['resume', 's1'])
    expect(r.command).toBe('resume')
    expect(r.arg).toBe('s1')
    const r2 = parseCliArgs(['run', 'hello'])
    expect(r2.command).toBe('run')
    expect(r2.arg).toBe('hello')
  })

  it('长选项与短选项、= 形式', () => {
    const a = parseCliArgs(['repl', '--cwd', '/tmp', '-a', 'x', '--provider=mock', '-s=foo'])
    expect(a.cwd).toBe('/tmp')
    expect(a.agentId).toBe('x')
    expect(a.provider).toBe('mock')
    expect(a.sessionId).toBe('foo')
    expect(parseCliArgs(['-v', '--data-dir', '/x', '--permission', 'allow-all'])).toMatchObject({
      verbose: true, dataDir: '/x', permissionMode: 'allow-all'
    })
  })

  it('--help / -h → command=help', () => {
    expect(parseCliArgs(['-h']).command).toBe('help')
    expect(parseCliArgs(['--help', 'repl']).command).toBe('help')
  })

  it('teammate 子命令 + --team/--name 身份参数', () => {
    const a = parseCliArgs(['teammate', '--team', 'Alpha', '--name', 'bob', '--agent', 'researcher', '--data-dir', '/x'])
    expect(a.command).toBe('teammate')
    expect(a.team).toBe('Alpha')
    expect(a.name).toBe('bob')
    expect(a.agentId).toBe('researcher')
    expect(a.dataDir).toBe('/x')
  })

  it('--model / -m 解析模型 ID', () => {
    expect(parseCliArgs(['repl', '--model', 'claude-3-5-sonnet']).model).toBe('claude-3-5-sonnet')
    expect(parseCliArgs(['run', 'hi', '-m=model-x']).model).toBe('model-x')
    expect(parseCliArgs(['repl']).model).toBeUndefined()
  })
})

describe('ConfigStore 全局配置（config.json）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-config-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('文件缺失 → 空配置', async () => {
    expect(await new ConfigStore(join(dir, 'nope')).load()).toEqual({})
  })

  it('save 后 load 往返一致', async () => {
    const store = new ConfigStore(dir)
    await store.save({ agentId: 'researcher', provider: 'mock', model: 'claude-3-5-sonnet' })
    expect(await store.load()).toEqual({ agentId: 'researcher', provider: 'mock', model: 'claude-3-5-sonnet' })
  })

  it('损坏 JSON → 空配置（幂等友好）', async () => {
    const store = new ConfigStore(dir)
    writeFileSync(join(dir, 'config.json'), '{broken')
    expect(await store.load()).toEqual({})
  })

  it('resolveConfig：CLI 参数优先于 config', () => {
    const argCfg = { agentId: undefined, provider: 'mock' as const, model: 'cli-model' }
    const out = resolveConfig(argCfg as Parameters<typeof resolveConfig>[0], {
      agentId: 'cfg-agent', provider: 'anthropic', model: 'cfg-model', anthropicApiKey: 'sk-x',
    })
    expect(out.agentId).toBe('cfg-agent') // CLI 未给 → 用 config
    expect(out.provider).toBe('mock')     // CLI 给了 → 覆盖 config
    expect(out.model).toBe('cli-model')   // CLI 给了 → 覆盖 config
    expect(out.anthropicApiKey).toBe('sk-x')
  })

  it('resolveConfig：无任何来源 → 默认 default/anthropic', () => {
    const out = resolveConfig({} as Parameters<typeof resolveConfig>[0], {})
    expect(out.agentId).toBe('default')
    expect(out.provider).toBe('anthropic')
    expect(out.model).toBeUndefined()
  })
})

describe('SessionFileStore 会话持久化', () => {
  let dir: string
  let store: SessionFileStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-'))
    store = new SessionFileStore(dir)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('save/load/list 基本流程', async () => {
    const session = {
      id: 's1', title: 'hello', createdAt: 1, updatedAt: 2, agentId: 'a', cwd: '/tmp',
      messages: [{ id: 'm1', role: 'user', createdAt: 1, updatedAt: 1, agentId: 'a', parts: [] } as any],
    }
    await store.save(session)
    const f = store.pathFor('s1')
    const disk = JSON.parse(readFileSync(f, 'utf-8'))
    expect(disk.id).toBe('s1')
    expect(disk.title).toBe('hello')

    const loaded = await store.load('s1')
    expect(loaded?.id).toBe('s1')
    expect(loaded?.messages.length).toBe(1)

    expect(await store.load('not-exist')).toBeUndefined()

    const list = await store.list()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe('s1')
  })
})

describe('CliPermissionEngine', () => {
  it('mode=allow-all 直接放行', async () => {
    const e = new CliPermissionEngine({}, { mode: 'allow-all' })
    const d = await e.ask({ toolKey: 'read', patterns: [] }) as PermissionDecision
    expect(d.behavior).toBe('allow')
    expect(d.matchedRule).toBe('global')
  })

  it('mode=ask 按用户答案', async () => {
    const askPrompt = async (s: string) => {
      if (s.includes('read')) return 'a'
      if (s.includes('write')) return 'd'
      if (s.includes('bash')) return 'A'
      if (s.includes('foo')) return 'D'
      return ''
    }
    let saved: Record<string, unknown> | undefined
    const store: any = { save: async (r: any) => { saved = r } }
    const e = new CliPermissionEngine({}, { mode: 'ask', askPrompt, store })

    expect((await e.ask({ toolKey: 'read', patterns: ['/x'] })).behavior).toBe('allow')
    expect((await e.ask({ toolKey: 'write', patterns: [] })).behavior).toBe('deny')
    const a = await e.ask({ toolKey: 'bash', patterns: [] }) as PermissionDecision
    expect(a.behavior).toBe('allow')
    expect(a.remember).toBe(true)
    expect(saved).toMatchObject({ bash: 'allow' })
    const b = await e.ask({ toolKey: 'foo', patterns: [] }) as PermissionDecision
    expect(b.behavior).toBe('deny')
    expect(b.remember).toBe(true)
    expect(saved).toMatchObject({ bash: 'allow', foo: 'deny' })
  })
})

describe('HarnessApp + startRepl 集成（mock provider）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('HarnessApp boot 建 session，send 追加消息，shutdown 持久化', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: {
        defaultResponse: '你好',
        responses: [{
          match: /.*/,
          response: 'OK',
          toolCalls: [{ toolUseId: 't1', toolId: 'echo', input: { msg: 'hi' } }],
        }]
      },
    })
    const { harness, session } = await app.boot()
    expect(typeof session.id).toBe('string')

    // send 一条，产生 user+assistant 消息
    const assistant = await app.send(session.id, 'ping')
    expect(assistant.role).toBe('assistant')

    const sess = (await harness.session.get(session.id))!
    expect(sess.messages.length).toBeGreaterThanOrEqual(2) // user + assistant

    // 磁盘保存
    const sf = await app.sessionStore.load(session.id)
    expect(sf?.id).toBe(session.id)
    expect(sf?.messages.length).toBeGreaterThanOrEqual(2)

    await app.shutdown()
  })

  it('startRepl 脚本模式：发送 prompt + /sessions + /new + /save + /exit 正常', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    const scriptedStdin = [
      '你好',
      '/sessions',
      '/new',
      '/save',
      '/exit',
    ]
    const r = await startRepl({ app, harness, session, stdout, scriptedStdin })
    expect(r).toBe('exit')
    // 拼接起来方便看
    const output = chunks.join('')
    expect(output).toInclude('Harness CLI')
    expect(output).toInclude('你好')
    // /exit 之前会 exit，所以 /save 没有被执行完是正常的
    await app.shutdown()
  })

  it('/model 查看与切换模型：更新 Agent.model + 持久化 config.json', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      model: 'claude-3-5-sonnet', // 初始默认模型（权限 allow-all 以便静默交互）
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    // 初始：默认 Agent 已绑定默认模型
    expect(harness.agent.get('default')?.model?.modelId).toBe('claude-3-5-sonnet')

    const r = await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/model', '/model claude-3-7-sonnet', '/model', '/exit'],
    })
    expect(r).toBe('exit')

    const output = chunks.join('')
    expect(output).toInclude('当前模型：claude-3-5-sonnet')
    expect(output).toInclude('已切换模型 claude-3-7-sonnet')
    // 运行时切换已写入 Agent 定义 → 影响下次 send
    expect(harness.agent.get('default')?.model?.modelId).toBe('claude-3-7-sonnet')
    expect(app.getModel('default')).toBe('claude-3-7-sonnet')
    // config.json 已持久化
    const cfg = await app.configStore.load()
    expect(cfg.model).toBe('claude-3-7-sonnet')

    await app.shutdown()
  })

  it('parseModelSpec / formatModel：provider/model 规格解析', () => {
    expect(parseModelSpec('openai/gpt-4o')).toEqual({ providerId: 'openai', modelId: 'gpt-4o' })
    expect(parseModelSpec('claude-3-5-sonnet')).toEqual({ providerId: undefined, modelId: 'claude-3-5-sonnet' })
    expect(parseModelSpec('')).toEqual({ providerId: undefined, modelId: '' })
    expect(formatModel('openai', 'gpt-4o')).toBe('openai/gpt-4o')
    expect(formatModel(undefined, 'gpt-4o')).toBe('gpt-4o')
    expect(formatModel('openai', undefined)).toBeUndefined()
  })

  it('--model provider/model：默认 Agent 绑定 providerId（跨 Provider）', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'openai',
      model: 'openai/gpt-4o',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [{ id: 'openai', type: 'openai', baseUrl: 'http://x', model: 'gpt-4o' }],
    })
    const { harness } = await app.boot()
    expect(harness.agent.get('default')?.model?.providerId).toBe('openai')
    expect(harness.agent.get('default')?.model?.modelId).toBe('gpt-4o')
    expect(app.getModel('default')).toBe('openai/gpt-4o')
    await app.shutdown()
  })

  it('setModel 跨 Provider 切换：openai/gpt-4o → 更新 providerId+modelId 并持久化', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'openai', type: 'openai', baseUrl: 'http://x', model: 'gpt-4o' },
        { id: 'deepseek', type: 'openai', baseUrl: 'http://y', model: 'deepseek-chat' },
      ],
    })
    await app.boot()
    const ok = await app.setModel('default', 'deepseek/deepseek-chat')
    expect(ok).toBe(true)
    expect(app.getModel('default')).toBe('deepseek/deepseek-chat')
    const cfg = await app.configStore.load()
    expect(cfg.provider).toBe('deepseek')
    expect(cfg.model).toBe('deepseek-chat')
    await app.shutdown()
  })

  it('boot 多 Provider 注册：config.providers 逐项注册，按 id 分发', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'deepseek',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'openai', type: 'openai', baseUrl: 'http://openai', model: 'gpt-4o' },
        { id: 'deepseek', type: 'openai', baseUrl: 'http://deepseek', model: 'deepseek-chat' },
      ],
    })
    const { harness } = await app.boot()
    expect(app.listProviders()).toEqual(expect.arrayContaining(['openai', 'deepseek']))
    // 默认 provider = deepseek（最后安装，作为兜底）
    const h = harness as unknown as { resolveChatProvider: (id?: string) => { id?: string } }
    const impl = (id?: string) => h.resolveChatProvider(id)
    expect(impl('deepseek')?.id).toBe('deepseek')
    expect(impl('openai')?.id).toBe('openai')
    // 'default' / 未知 id 回退默认（deepseek）
    expect(impl('default')?.id).toBe('deepseek')
    await app.shutdown()
  })

  it('main run 子命令执行 prompt 并输出文本', async () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
    try {
      const dd = join(dir, '.harness')
      const code = await main([
        'run', 'hello',
        '-p', 'mock',
        '-d', dd,
        '-c', dir,
        '--permission', 'allow-all',
      ])
      expect(code).toBe(0)
      const out = chunks.join('')
      expect(out).toInclude('Mock Provider')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('main list-sessions 输出空列表', async () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
    try {
      const dd = join(dir, '.harness')
      const code = await main(['list-sessions', '-d', dd])
      expect(code).toBe(0)
      expect(chunks.join('')).toInclude('（无持久化会话）')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('main help → 输出帮助', async () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
    try {
      const code = await main(['--help'])
      expect(code).toBe(0)
      expect(chunks.join('')).toInclude(HELP_TEXT.slice(0, 20))
    } finally {
      process.stdout.write = originalWrite
    }
  })
})

describe('插件 CLI 命令扩展', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** 测试插件：注册 /status 斜杠命令 */
  function createStatusPlugin(): AgentPlugin {
    return {
      id: 'test.status-cmd',
      version: '1.0.0',
      name: 'Status Command Plugin',
      async install() {
        const hooks: Hooks = {
          'cli.commands'(input) {
            input.commands.push({ command: 'status', description: '显示会话状态' })
          },
          'cli.command'(input) {
            if (input.command !== 'status') return
            input.out(`会话 ${input.sessionId} 运行中\n`)
            input.result = 'continue'
          },
        }
        return hooks
      },
    }
  }

  it('插件 /status 命令被 REPL 分发', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      extraPlugins: [createStatusPlugin()],
    })
    const { harness, session } = await app.boot()
    const r = await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/status', '/exit'],
    })
    expect(r).toBe('exit')
    const output = chunks.join('')
    expect(output).toInclude('会话')
    expect(output).toInclude('运行中')
    await app.shutdown()
  })

  it('/help 显示插件注册的命令', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      extraPlugins: [createStatusPlugin()],
    })
    const { harness, session } = await app.boot()
    await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/help', '/exit'],
    })
    const output = chunks.join('')
    expect(output).toInclude('/status')
    expect(output).toInclude('显示会话状态')
    await app.shutdown()
  })

  it('未知命令仍提示未知', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      extraPlugins: [createStatusPlugin()],
    })
    const { harness, session } = await app.boot()
    await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/foobar', '/exit'],
    })
    const output = chunks.join('')
    expect(output).toInclude('未知命令')
    await app.shutdown()
  })
})

describe('后台任务面板 attachBackgroundTaskPanel（P1-4）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('subagent 后台任务 started/completed 事件实时打印状态行', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    const detach = attachBackgroundTaskPanel({ harness, stdout })

    const started = {
      agentId: 'researcher', agentName: 'Researcher',
      subSessionId: 's_sub', parentSessionId: 's_parent', parentAgentId: 'default',
      parentMessageId: 'm1', toolUseId: 't1',
      prompt: '调研竞品定价', description: '调研竞品定价',
      isContinuation: false, startedAt: Date.now(),
      taskId: 'task-1', background: true,
    }
    await harness.bus.publish(SubagentEvents.started, started as any)
    await harness.bus.publish(SubagentEvents.completed, {
      agentId: 'researcher', subSessionId: 's_sub', parentSessionId: 's_parent',
      toolUseId: 't1', replyPreview: '竞品 X 定价 29 美元/月', messageCount: 5, durationMs: 1200,
      taskId: 'task-1', background: true,
    } as any)
    detach()

    const output = chunks.join('')
    expect(output).toInclude('[后台任务] task-1 开始：Researcher')
    expect(output).toInclude('调研竞品定价')
    expect(output).toInclude('[后台任务] task-1 完成：Researcher（1200ms）')
    expect(output).toInclude('竞品 X 定价 29 美元/月')
    await app.shutdown()
  })

  it('subagent 后台任务 failed 事件打印失败行', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    const detach = attachBackgroundTaskPanel({ harness, stdout })

    await harness.bus.publish(SubagentEvents.started, {
      agentId: 'researcher', agentName: 'Researcher',
      subSessionId: 's_sub', parentSessionId: 's_parent', parentAgentId: 'default',
      parentMessageId: 'm1', toolUseId: 't1',
      prompt: '调研失败任务', description: '调研失败任务',
      isContinuation: false, startedAt: Date.now(),
      taskId: 'task-2', background: true,
    } as any)
    await harness.bus.publish(SubagentEvents.failed, {
      agentId: 'researcher', subSessionId: 's_sub', parentSessionId: 's_parent',
      toolUseId: 't1', code: 'QUERY_FAILED', message: 'provider error', durationMs: 800,
      taskId: 'task-2', background: true,
    } as any)
    detach()

    const output = chunks.join('')
    expect(output).toInclude('[后台任务] task-2 开始')
    expect(output).toInclude('[后台任务] task-2 失败：Researcher')
    expect(output).toInclude('provider error')
    await app.shutdown()
  })

  it('subagent.progress 事件实时打印工具调用进度（P1-5）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    const detach = attachBackgroundTaskPanel({ harness, stdout })

    await harness.bus.publish(SubagentEvents.started, {
      agentId: 'researcher', agentName: 'Researcher',
      subSessionId: 's_sub', parentSessionId: 's_parent', parentAgentId: 'default',
      parentMessageId: 'm1', toolUseId: 't1',
      prompt: '读取文件', description: '读取文件',
      isContinuation: false, startedAt: Date.now(),
      taskId: 'task-3', background: true,
    } as any)
    await harness.bus.publish(SubagentEvents.progress, {
      taskId: 'task-3', agentId: 'researcher', parentSessionId: 's_parent',
      toolUseId: 'tu-1', toolName: 'read_file', toolStatus: 'running',
      summary: 'src/index.ts', timestamp: Date.now(),
    } as any)
    await harness.bus.publish(SubagentEvents.progress, {
      taskId: 'task-3', agentId: 'researcher', parentSessionId: 's_parent',
      toolUseId: 'tu-1', toolName: 'read_file', toolStatus: 'completed',
      summary: 'file content', timestamp: Date.now(),
    } as any)
    detach()

    const output = chunks.join('')
    expect(output).toInclude('🔧  [task-3] read_file：src/index.ts...')
    expect(output).toInclude('✅  [task-3] read_file → file content')
    await app.shutdown()
  })
})

describe('Coordinator 自动续轮 attachAutoContinue', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('coordinator.barrier.completed 事件触发注入 <continue/>', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()

    const injected: string[] = []
    const detach = attachAutoContinue(harness, (line) => injected.push(line))
    await harness.bus.publish(CoordinatorEvents.barrierCompleted, {
      sessionId: 's_parent', taskIds: ['task-a', 'task-b'],
    } as any)
    detach()

    expect(injected).toEqual(['<continue/>'])
    await app.shutdown()
  })

  it('卸载后不再注入', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()

    const injected: string[] = []
    const detach = attachAutoContinue(harness, (line) => injected.push(line))
    detach()
    await harness.bus.publish(CoordinatorEvents.barrierCompleted, { sessionId: 's', taskIds: [] } as any)

    expect(injected).toHaveLength(0)
    await app.shutdown()
  })
})

describe('/revert 命令', () => {
  let dir: string
  beforeEach(() => {
    // 普通临时目录即可：快照仓库独立于 worktree，命令分支不依赖 worktree 是 git 仓库
    dir = mkdtempSync(join(tmpdir(), 'harness-cli-revert-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function bootApp(snapshot = false) {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      snapshot,
    })
    const { harness, session } = await app.boot()
    return { app, harness, session, stdout, chunks }
  }

  it('未启用 snapshot 时 /revert 提示启用', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(false)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert', '/exit'] })
    expect(chunks.join('')).toInclude('快照未启用')
    await app.shutdown()
  })

  it('启用后 /revert help 显示子命令用法', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert help', '/exit'] })
    const out = chunks.join('')
    expect(out).toInclude('stage')
    expect(out).toInclude('clear')
    expect(out).toInclude('commit')
    expect(out).toInclude('status')
    await app.shutdown()
  })

  it('/revert status 无进行中回滚时提示', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert status', '/exit'] })
    expect(chunks.join('')).toInclude('当前无进行中的回滚')
    await app.shutdown()
  })

  it('/revert stage 不存在的消息时打印回滚失败（不崩溃）', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert stage no-such-msg', '/exit'] })
    expect(chunks.join('')).toInclude('回滚失败')
    await app.shutdown()
  })

  it('/revert 未知子命令提示', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert nope', '/exit'] })
    expect(chunks.join('')).toInclude('未知子命令')
    await app.shutdown()
  })

  it('/help 列表包含 /revert', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/help', '/exit'] })
    expect(chunks.join('')).toInclude('/revert')
    await app.shutdown()
  })
})
