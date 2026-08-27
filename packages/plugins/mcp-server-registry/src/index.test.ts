/**
 * @harness/mcp-server-registry 测试
 * - 注册表的 register/unregister/has/list/clear
 * - createMcpServerRegistryPlugin：harness.start 连接 → tool.pool.assemble 暴露工具 → /mcp 命令
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import {
  McpServerRegistry,
  createMcpServerRegistry,
  createMcpServerRegistryPlugin,
  type McpServerRegistration,
} from './index'
import type { PluginContext } from '@harness/plugin'
import type { McpTransport } from '@harness/mcp-client'

/** 日志 ctx 桩 */
const mockLog: PluginContext['log'] = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}

/** 进程内假 server：响应 initialize / tools/list / tools/call */
function createFakeTransport(tools: Array<{ name: string; description?: string }>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let handler: ((data: string) => void) | undefined
  const transport: McpTransport = {
    send(data: string) {
      const req = JSON.parse(data) as any
      const respond = (result: unknown) =>
        handler?.(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
      if (req.method === 'initialize') {
        respond({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.0' } })
      } else if (req.method === 'tools/list') {
        respond({ tools })
      } else if (req.method === 'tools/call') {
        calls.push({ name: req.params.name, args: req.params.arguments ?? {} })
        respond({ content: [{ type: 'text', text: `called:${req.params.name}` }], isError: null })
      } else if (req.id != null) {
        handler?.(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Unknown' } }))
      }
    },
    onMessage(h) { handler = h },
    close() { handler = undefined },
  }
  return { transport, calls }
}

function fakePool() {
  const tools: unknown[] = []
  return {
    add: (t: unknown) => tools.push(t),
    addAll: (ts: unknown[]) => tools.push(...ts),
    addIfMissing: () => undefined,
    remove: (id: string) => { const i = tools.findIndex((t: any) => t.id === id); if (i >= 0) tools.splice(i, 1) },
    list: () => tools,
  }
}

describe('McpServerRegistry', () => {
  beforeEach(() => { createMcpServerRegistry().clear() })

  test('register / unregister / has / list / clear', () => {
    const reg = createMcpServerRegistry()
    const entry: McpServerRegistration = { name: 'x', createTransport: () => ({ send(){}, onMessage(){}, close(){} }) }
    expect(reg.has('x')).toBe(false)
    reg.register(entry)
    expect(reg.has('x')).toBe(true)
    expect(reg.list().map((e) => e.name)).toEqual(['x'])

    reg.register({ name: 'x', createTransport: entry.createTransport })
    expect(reg.list().length).toBe(1) // 同名覆盖

    expect(reg.unregister('x')).toBe(true)
    expect(reg.unregister('x')).toBe(false)
    expect(reg.has('x')).toBe(false)

    reg.register(entry)
    reg.clear()
    expect(reg.list().length).toBe(0)
  })
})

describe('createMcpServerRegistryPlugin', () => {
  test('harness.start 连接服务器并用 tool.pool.assemble 暴露工具', async () => {
    const reg = createMcpServerRegistry()
    const { transport, calls } = createFakeTransport([
      { name: 'list_apps', description: 'list apps' },
      { name: 'click', description: 'click' },
    ])
    reg.register({ name: 'fake', createTransport: () => transport })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog } as PluginContext)

    await hooks!['harness.start']!({ harness: {} } as any, { started: true })
    const pool = fakePool()
    await hooks!['tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().length).toBe(2)
    const ids = pool.list().map((t: any) => t.id).sort()
    expect(ids).toEqual(['mcp__fake__click', 'mcp__fake__list_apps'])

    // 工具可被调用（pass-through → server → McpClient.callTool）
    const clickTool = pool.list().find((t: any) => t.id === 'mcp__fake__click') as any
    const result = await clickTool.call({ app: 'x', x: 1, y: 2 }, { cwd: '/tmp' })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('called:click')
    expect(calls).toEqual([{ name: 'click', args: { app: 'x', x: 1, y: 2 } }])

    await plugin.uninstall?.()
  })

  test('/mcp servers 与 /mcp tools 命令输出', async () => {
    const reg = createMcpServerRegistry()
    const { transport } = createFakeTransport([{ name: 'list_apps' }])
    reg.register({ name: 'fake', createTransport: () => transport })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog } as PluginContext)
    await hooks!['harness.start']!({ harness: {} } as any, { started: true })

    // 无服务器注册时可不出现在命令列表
    const cmdInput1: any = { commands: [] }
    await hooks!['cli.commands']!(cmdInput1)
    expect(cmdInput1.commands.map((c: any) => c.command)).toContain('mcp')

    // /mcp servers
    const inputA: any = { command: 'mcp', arg: 'servers', raw: 'mcp servers', out: (s: string) => { /* noop */ }, sessionId: 's' }
    const outA: string[] = []
    inputA.out = (s: string) => outA.push(s)
    await hooks!['cli.command']!(inputA)
    expect(inputA.result).toBe('continue')
    expect(outA.join('')).toContain('fake')
    expect(outA.join('')).toContain('tools=1')

    // /mcp tools
    const inputB: any = { command: 'mcp', arg: 'tools', raw: 'mcp tools', out: (s: string) => { /* noop */ }, sessionId: 's' }
    const outB: string[] = []
    inputB.out = (s: string) => outB.push(s)
    await hooks!['cli.command']!(inputB)
    expect(outB.join('')).toContain('mcp__fake__list_apps')

    await plugin.uninstall?.()
  })

  test('config 模式缺 command（stdio）时连接失败不阻塞其余', async () => {
    const reg = createMcpServerRegistry()
    // config 但没有 command/jsonrpc → defaultTransportFactory 抛错
    reg.register({ name: 'bad', config: { name: 'bad' as any, transport: 'stdio' } as any })
    reg.register({ name: 'ok', createTransport: () => (createFakeTransport([{ name: 't' }]).transport) })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog } as PluginContext)
    await hooks!['harness.start']!({ harness: {} } as any, { started: true })

    const pool = fakePool()
    await hooks!['tool.pool.assemble']!({ agentId: 'a' }, pool)
    const ids = pool.list().map((t: any) => t.id)
    expect(ids).toContain('mcp__ok__t')
    expect(ids).not.toContain('mcp__bad__')
    await plugin.uninstall?.()
  })
})