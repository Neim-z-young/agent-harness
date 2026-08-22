import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseCliArgs,
  SessionFileStore,
  CliPermissionEngine,
  HarnessApp,
  startRepl,
  HELP_TEXT,
  main,
} from './index'
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
