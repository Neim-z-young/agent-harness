/**
 * computer-use MCP server 的协议与契约测试（后端用注入 exec 的真后端，不用 stub 子类）
 */
import { describe, expect, it } from 'bun:test'
import { ComputerUseBackend } from './mac'
import type { ExecFn } from './mac'
import { ComputerUseMcpServer, createComputerUseServerTransport } from './server'

function fakeExec(handler: (script: string) => string): ExecFn {
  return async (args) => ({ code: 0, stdout: handler(args[args.length - 1] ?? ''), stderr: '' })
}

function makeServer(exec: ExecFn) {
  const server = new ComputerUseMcpServer(new ComputerUseBackend({ exec, allowScreenshot: false }))
  const transport = createComputerUseServerTransport(server)
  return {
    async call(body: string): Promise<any> {
      return new Promise((resolve) => {
        transport.onMessage((data) => resolve(JSON.parse(data)))
        transport.send(body)
      })
    },
  }
}

describe('JSON-RPC 报文处理', () => {
  it('非法 JSON 返回 -32700（旧实现静默 return，客户端只能干等超时）', async () => {
    const s = makeServer(fakeExec(() => ''))
    const resp = await s.call('{ not json')
    expect(resp.error.code).toBe(-32700)
    expect(resp.id).toBeNull()
  })

  it('合法请求不受影响（对照）', async () => {
    const s = makeServer(fakeExec(() => ''))
    const resp = await s.call(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    expect(resp.result.serverInfo.name).toBe('computer-use')
  })
})

describe('tools/list 契约', () => {
  it('click / scroll / drag 都声明 required app（与后端校验口径一致）', async () => {
    const s = makeServer(fakeExec(() => ''))
    const resp = await s.call(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
    const byName = new Map(resp.result.tools.map((t: any) => [t.name, t]))
    expect((byName.get('click') as any).inputSchema.required).toContain('app')
    expect((byName.get('scroll') as any).inputSchema.required).toContain('app')
    expect((byName.get('drag') as any).inputSchema.required).toEqual(['app', 'fromX', 'fromY', 'toX', 'toY'])
  })
})

describe('list_apps 的 windowLimit 透传', () => {
  it('server 层传的 windowLimit 真的生效（不是只存在于 schema）', async () => {
    const s = makeServer(fakeExec(() => 'A\t1\nB\t2\nC\t3\n'))
    const resp = await s.call(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_apps', arguments: { windowLimit: 1 } },
    }))
    const text = resp.result.content[0].text as string
    expect(text.split('\n')).toHaveLength(2) // 表头 + 1 行
    expect(text).toContain('A')
    expect(text).not.toContain('B')
  })
})
