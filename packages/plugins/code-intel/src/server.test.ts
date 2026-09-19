/**
 * code-intel 进程内 MCP server 单测
 *
 * 覆盖：initialize / tools/list / tools/call（code_symbols / code_reference / code_definition）
 * 与 createCodeIntelServerTransport（transport 对接，响应回传）。不与 harness 耦合。
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listRegisteredMcpServers, unregisterMcpServer, createMcpServerRegistryPlugin } from '@harness/mcp-server-registry'
import { McpClient } from '@harness/mcp-client'
import { CodeIntelMcpServer, createCodeIntelServerTransport } from './server'
import { createCodeIntelPlugin, CODE_INTEL_SERVER_NAME } from './index'

let dir: string
let server: CodeIntelMcpServer

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-codeintel-mcp-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(
    join(dir, 'src', 'util.ts'),
    `export const VERSION = '1.0.0'\n\nexport function greet(name: string): string {\n  return 'hi ' + name\n}\n`,
  )
  writeFileSync(
    join(dir, 'src', 'main.ts'),
    `import { greet, VERSION } from './util'\n\nconsole.log(greet('world'))\nconsole.log(VERSION)\n`,
  )
  server = new CodeIntelMcpServer({ baseDir: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

type Rpc = { id: number; method?: string; params?: any }
// tools/call 为异步分发（void dispatchToolCall），响应经 reply 在微任务回传；故用 Promise 承接
function call(msg: Rpc): Promise<any> {
  return new Promise((resolve) => {
    server.handle(JSON.stringify(msg), (d: string) => resolve(JSON.parse(d)))
  })
}

describe('CodeIntelMcpServer JSON-RPC', () => {
  it('initialize 返回协议与 serverInfo', async () => {
    const res = await call({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } } })
    expect(res.id).toBe(1)
    expect(res.result.capabilities.tools).toEqual({})
    expect(res.result.serverInfo.name).toBe('code-intel')
  })

  it('tools/list 返回四个工具且 schema 含 required', async () => {
    const res = await call({ id: 2, method: 'tools/list' })
    const names = res.result.tools.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual(['code_definition', 'code_reference', 'code_semantic_edit', 'code_symbols'])
    const ref = res.result.tools.find((t: { name: string }) => t.name === 'code_reference')
    expect(ref.inputSchema.required).toContain('symbol')
  })

  it('tools/call code_symbols 返回 util 中的符号行', async () => {
    const res = await call({ id: 3, method: 'tools/call', params: { name: 'code_symbols', arguments: { path: 'src/util.ts' } } })
    expect(res.id).toBe(3)
    expect(res.result.isError).toBeNull()
    const text = res.result.content[0].text as string
    expect(text).toContain('VERSION')
    expect(text).toContain('greet')
    expect(text).toContain('function')
  })

  it('tools/call code_reference 找到跨文件引用（含 cwd 覆盖）', async () => {
    const res = await call({ id: 4, method: 'tools/call', params: { name: 'code_reference', arguments: { symbol: 'greet', path: 'src', cwd: dir } } })
    expect(res.result.isError).toBeNull()
    const text = res.result.content[0].text as string
    expect(text).toContain('references=1')
    expect(text).toContain('main.ts')
  })

  it('tools/call code_definition 返回声明位置', async () => {
    const res = await call({ id: 5, method: 'tools/call', params: { name: 'code_definition', arguments: { symbol: 'greet', path: 'src' } } })
    const text = res.result.content[0].text as string
    expect(text).toContain('definitions=1')
    expect(text).toContain('util.ts')
  })

  it('tools/call 未知工具返回 -32602', async () => {
    const res = await call({ id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } })
    expect(res.error.code).toBe(-32602)
  })

  it('未知 method 返回 -32601', async () => {
    const res = await call({ id: 7, method: 'tools/unknown' })
    expect(res.error.code).toBe(-32601)
  })

  it('tools/call code_semantic_edit rename dryRun 不改盘但预览', async () => {
    const res = await call({ id: 8, method: 'tools/call', params: { name: 'code_semantic_edit', arguments: { mode: 'rename', symbol: 'greet', to: 'hello', path: 'src', dryRun: true } } })
    expect(res.result.isError).toBeNull()
    const parsed = JSON.parse(res.result.content[0].text as string)
    expect(parsed.mode).toBe('rename')
    expect(parsed.to).toBe('hello')
    expect(parsed.total).toBeGreaterThan(0)
    // dryRun 未落盘
    const content = (await import('node:fs')).readFileSync(join(dir, 'src', 'util.ts'), 'utf-8')
    expect(content).toContain('greet')
  })
})

describe('createCodeIntelServerTransport', () => {
  it('响应经 onMessage 回传 / 提前收到走队列', async () => {
    const transport = createCodeIntelServerTransport(server)
    const received: string[] = []
    // 先 send（此时无 handler，响应进入队列）
    transport.send(JSON.stringify({ id: 1, method: 'tools/list' }))
    transport.onMessage((d: string) => received.push(d))
    // 队列内的响应被派发
    expect(received.length).toBe(1)
    expect(JSON.parse(received[0]).result.tools.length).toBe(4)
    // 之后 send 直接回传
    transport.send(JSON.stringify({ id: 2, method: 'initialize', params: {} }))
    expect(received.length).toBe(2)
    expect(JSON.parse(received[1]).result.serverInfo.name).toBe('code-intel')
    transport.close()
  })
})

describe('createCodeIntelPlugin 装配（可插拔，对齐 computer-use）', () => {
  afterEach(() => {
    unregisterMcpServer(CODE_INTEL_SERVER_NAME)
  })

  it('install 注册 code-intel 进程内 MCP server（依赖 registry，纯 MCP 不直装工具）', async () => {
    const plugin = createCodeIntelPlugin()
    expect(plugin.dependsOn).toContain('mcp.server-registry')
    const hooks = await plugin.install({ log: { info() {}, warn() {}, error() {}, debug() {} } } as any)

    // 纯 MCP 装配：不产生 core.tool.pool.assemble 直装工具
    expect((hooks as any)['core.tool.pool.assemble']).toBeUndefined()

    // registry 中可见 code-intel server（伴随 core.harness.start 由 mcp-server-registry 连接）
    const entry = listRegisteredMcpServers().find((r) => r.name === CODE_INTEL_SERVER_NAME)
    expect(entry).toBeDefined()
    expect(entry && 'createTransport' in entry ? (entry as { createTransport: unknown }).createTransport : null).toBeTypeOf('function')
  })

  it('transport 对接 McpClient（registry 使用路径）listTools + callTool 可用', async () => {
    const plugin = createCodeIntelPlugin()
    await plugin.install({ log: { info() {}, warn() {}, error() {}, debug() {} } } as any)
    const entry = listRegisteredMcpServers().find((r) => r.name === CODE_INTEL_SERVER_NAME) as
      | { createTransport: () => any }
      | undefined
    expect(entry).toBeDefined()
    const transport = await entry!.createTransport()
    const client = new McpClient('code-intel', transport)
    await client.connect()
    const tools = await client.listTools()
    expect(tools.length).toBe(4)
    const callResult = await client.callTool('code_symbols', { path: 'src/util.ts' })
    expect(callResult.isError).toBeNull()
    client.close()
  })

  it('端到端：code-intel + registry 装配后 core.harness.start 连接，core.tool.pool.assemble 暴露 mcp__code-intel__*', async () => {
    const log = { info() {}, warn() {}, error() {}, debug() {} }
    const bus = { publish: async () => undefined, subscribe: () => () => undefined, subscribeAll: () => () => undefined }
    const codeIntel = createCodeIntelPlugin()
    await codeIntel.install({ log } as any)
    const registry = createMcpServerRegistryPlugin()
    const regHooks = await registry.install({ log, bus } as any)

    // 模拟 core.harness.start：连接所有已注册进程内 server（含 code-intel）
    await (regHooks as any)['core.harness.start']()
    const pool = { added: [] as unknown[] }
    await (regHooks as any)['core.tool.pool.assemble']({} as any, { add: (t: unknown) => (pool.added as unknown[]).push(t) })

    const ids = pool.added.map((t) => (t as { id: string }).id).sort()
    expect(ids).toEqual([
      'mcp__code-intel__code_definition',
      'mcp__code-intel__code_reference',
      'mcp__code-intel__code_semantic_edit',
      'mcp__code-intel__code_symbols',
    ])
    // 直装无前缀工具不在池中（纯 MCP）
    expect(ids.some((id) => id === 'code_symbols')).toBe(false)
  })
})