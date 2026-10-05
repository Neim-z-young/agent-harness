/**
 * 插件层测试：参数解析、命令链路（serve/status/stop）、asker 包装与还原。
 *
 * 这里用**假 harness / 假 engine**：插件层关心的是"装配顺序与生命周期"，
 * 不是工具真实执行（那已由 `server.test.ts` 端到端覆盖）。假件让"启动/停止/还原"的
 * 时序断言变得可读。
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { Harness } from '@harness/core'
import type { AgentPlugin, CliCommandInput, CliCommandsInput, PluginContext } from '@harness/plugin'
import { ToolPipeline, ToolRegistry, defineTool, withJsonSchema } from '@harness/tool'
import type { AnswerLike, AskInputLike, PromptLike } from './elicit'
import { type PermissionAskerLike, createMcpServerPlugin, parseServeArgs } from './index'

// ===== 假件 =====

const prompt: PromptLike = { toolKey: 'bash', patterns: [], summary: '权限请求 [bash]', text: 'x' }

class FakeEngine {
  asker?: PermissionAskerLike
  setAsker(fn?: PermissionAskerLike): void {
    this.asker = fn
  }
  getAsker(): PermissionAskerLike | undefined {
    return this.asker
  }
}

function makeHarness(engine: FakeEngine): Harness {
  const registry = new ToolRegistry()
  registry.register(
    defineTool({
      id: 'read_file',
      description: 'r',
      inputSchema: withJsonSchema(
        { parse: (v) => v as Record<string, unknown>, safeParse: (v) => ({ success: true as const, data: v }) },
        { type: 'object', properties: {} },
      ),
      async call() {
        return { ok: true, output: 'x' }
      },
    }),
  )
  return {
    tools: registry,
    toolPipeline: new ToolPipeline({}),
    permission: engine,
    cwd: '/tmp',
  } as unknown as Harness
}

interface Harnessed {
  plugin: AgentPlugin
  engine: FakeEngine
  lines: string[]
  run: (command: string, arg?: string) => Promise<string>
  serverUrl: () => string | undefined
}

async function setup(withHarness = true): Promise<Harnessed> {
  const plugin = createMcpServerPlugin()
  const engine = new FakeEngine()
  const lines: string[] = []
  const ctx = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { cwd: '/tmp' },
  } as unknown as PluginContext
  const hooks = (await plugin.install(ctx)) as Record<string, unknown>
  if (withHarness) {
    ;(hooks['core.harness.init'] as (i: unknown, o: unknown) => void)({}, { harness: makeHarness(engine) })
  }
  const run = async (command: string, arg = ''): Promise<string> => {
    lines.length = 0
    const input = { command, raw: `${command} ${arg}`.trim(), arg, out: (s: string) => lines.push(s), sessionId: 's' } as unknown as CliCommandInput
    await (hooks['cli.command'] as (i: CliCommandInput) => Promise<void>)(input)
    return lines.join('')
  }
  return {
    plugin,
    engine,
    lines,
    run,
    serverUrl: () => lines.join('').match(/端点: (\S+)/)?.[1],
  }
}

const started: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => {
  for (const s of started.splice(0)) await s.stop()
})

function trackServe(h: Harnessed): Harnessed {
  started.push({ stop: () => h.run('mcp-stop').then(() => undefined) })
  return h
}

// ===== 参数解析 =====

describe('parseServeArgs', () => {
  it('支持 --k v 与 --k=v 两种写法', () => {
    expect(parseServeArgs('--port 8080 --token abc --prefix h_')).toEqual({ port: 8080, token: 'abc', prefix: 'h_' })
    expect(parseServeArgs('--port=0 --token=t --path=/x')).toEqual({ port: 0, token: 't', path: '/x' })
  })

  it('非法 / 缺值参数被忽略（不因一个参数让启动失败）', () => {
    expect(parseServeArgs('--port abc')).toEqual({})
    expect(parseServeArgs('--port -1')).toEqual({})
    expect(parseServeArgs('--token')).toEqual({})
    expect(parseServeArgs('')).toEqual({})
  })

  it('port 0 被保留（= 让系统分配空闲端口，与"缺省"不是一回事）', () => {
    expect(parseServeArgs('--port 0')).toEqual({ port: 0 })
  })
})

// ===== 命令链路 =====

describe('插件装配与命令', () => {
  it('插件形态：id / name / install / uninstall', async () => {
    const h = await setup()
    expect(h.plugin.id).toBe('mcp-server')
    expect(h.plugin.name).toBe('MCP Server')
    expect(typeof h.plugin.install).toBe('function')
    expect(typeof h.plugin.uninstall).toBe('function')
  })

  it('注册三个命令', async () => {
    const plugin = createMcpServerPlugin()
    const commands: Array<{ command: string }> = []
    const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, workspace: { cwd: '/tmp' } } as unknown as PluginContext
    const hooks = (await plugin.install(ctx)) as Record<string, unknown>
    ;(hooks['cli.commands'] as (i: CliCommandsInput) => void)({ commands } as unknown as CliCommandsInput)
    expect(commands.map((c) => c.command)).toEqual(['mcp-serve', 'mcp-status', 'mcp-stop'])
  })

  it('未启动时 /mcp-status 与 /mcp-stop 都提示未运行', async () => {
    const h = await setup()
    expect(await h.run('mcp-status')).toContain('未运行')
    expect(await h.run('mcp-stop')).toContain('未运行')
  })

  it('harness 未就绪时 /mcp-serve 明确提示而不是静默失败', async () => {
    const h = await setup(false)
    expect(await h.run('mcp-serve', '--port 0')).toContain('harness 尚未就绪')
  })

  it('/mcp-serve → /mcp-status → /mcp-stop 全链路', async () => {
    const h = trackServe(await setup())
    const serveOut = await h.run('mcp-serve', '--port 0')
    expect(serveOut).toContain('MCP server 已启动')
    expect(serveOut).toContain('工具: 1 个')
    const url = h.serverUrl()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

    expect(await h.run('mcp-status')).toContain('运行中')
    expect(await h.run('mcp-stop')).toContain('已停止')
    expect(await h.run('mcp-status')).toContain('未运行')
  })

  it('重复启动被拒（先 stop 再改参数）', async () => {
    const h = trackServe(await setup())
    await h.run('mcp-serve', '--port 0')
    expect(await h.run('mcp-serve', '--port 0')).toContain('已在运行')
  })

  it('端口被占用 ⇒ 给出可操作提示（含 --port 0 的建议）', async () => {
    const hog = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') })
    try {
      const h = await setup()
      const out = await h.run('mcp-serve', `--port ${hog.port}`)
      expect(out).toContain('启动失败')
      expect(out).toContain('--port 0')
    } finally {
      await hog.stop(true)
    }
  })

  it('非 mcp- 前缀的命令不认领（不设 result，交给别的插件/默认逻辑）', async () => {
    const plugin = createMcpServerPlugin()
    const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, workspace: { cwd: '/tmp' } } as unknown as PluginContext
    const hooks = (await plugin.install(ctx)) as Record<string, unknown>
    const lines: string[] = []
    const input = { command: 'plan', raw: 'plan', arg: '', out: (s: string) => lines.push(s), sessionId: 's' } as unknown as CliCommandInput
    await (hooks['cli.command'] as (i: CliCommandInput) => Promise<void>)(input)
    expect(input.result).toBeUndefined()
    expect(lines).toEqual([])
  })
})

// ===== asker 包装与还原（权限桥的装配侧） =====

describe('asker 包装与还原', () => {
  it('启动时装包装、停止时还原为原 asker（不把宿主中途换上的顶掉）', async () => {
    const h = trackServe(await setup())
    const original: PermissionAskerLike = () => Promise.resolve('deny')
    h.engine.setAsker(original)
    await h.run('mcp-serve', '--port 0')
    const wrapped = h.engine.getAsker()
    expect(wrapped).toBeDefined()
    expect(wrapped).not.toBe(original)

    await h.run('mcp-stop')
    expect(h.engine.getAsker()).toBe(original)
  })

  it('分流：非 MCP 会话委派给原 asker；属于 MCP 会话但不在此请求上下文 ⇒ 不委派（返回 undefined ⇒ deny）', async () => {
    const h = trackServe(await setup())
    const delegated: Array<string | undefined> = []
    h.engine.setAsker((req: AskInputLike) => {
      delegated.push(req.sessionId)
      return Promise.resolve('deny' as AnswerLike)
    })
    await h.run('mcp-serve', '--port 0')
    const wrapped = h.engine.getAsker()!

    // ① TUI 侧会话 ⇒ 委派
    expect(await wrapped({ toolKey: 'bash', patterns: [], sessionId: 'tui' }, prompt)).toBe('deny')
    expect(delegated).toEqual(['tui'])

    // ② MCP 会话（真拿一个）：不在 elicitation 请求上下文里 ⇒ 不接管、也不误委派
    const init = await fetch(h.serverUrl()!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    })
    const sid = init.headers.get('mcp-session-id') as string
    expect(await wrapped({ toolKey: 'write', patterns: [], sessionId: sid }, prompt)).toBeUndefined()
    expect(delegated).toEqual(['tui']) // 没有新增委派
  })

  it('权限引擎不支持 setAsker ⇒ 启动时给出告警（而不是静默假装已接权限）', async () => {
    const plugin = createMcpServerPlugin()
    const lines: string[] = []
    const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, workspace: { cwd: '/tmp' } } as unknown as PluginContext
    const hooks = (await plugin.install(ctx)) as Record<string, unknown>
    const bare = { tools: new ToolRegistry(), toolPipeline: new ToolPipeline({}), permission: {}, cwd: '/tmp' } as unknown as Harness
    ;(hooks['core.harness.init'] as (i: unknown, o: unknown) => void)({}, { harness: bare })
    const input = { command: 'mcp-serve', raw: 'mcp-serve --port 0', arg: '--port 0', out: (s: string) => lines.push(s), sessionId: 's' } as unknown as CliCommandInput
    await (hooks['cli.command'] as (i: CliCommandInput) => Promise<void>)(input)
    expect(lines.join('')).toContain('不支持 setAsker')
    await (hooks['cli.command'] as (i: CliCommandInput) => Promise<void>)({
      command: 'mcp-stop',
      raw: 'mcp-stop',
      arg: '',
      out: () => {},
      sessionId: 's',
    } as unknown as CliCommandInput)
  })
})
