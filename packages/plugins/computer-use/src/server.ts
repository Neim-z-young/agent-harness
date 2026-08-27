/**
 * computer-use 进程内 MCP server
 *
 * 不依赖外部 MCP server 进程：通过一个内存中的 JSON-RPC 2.0 server 实现
 * MCP 协议（tools/list + tools/call + initialize），再把后端能力映射为 MCP 工具。
 * registry 通过 createComputerUseServerTransport() 拿到一个 @harness/mcp-client 的
 * McpTransport，把客户端 JSON-RPC 请求直接导入本 server 处理。
 *
 * 参考：reference/电脑控制mcp 功能.md（工具清单与 schema）
 */

import { ComputerUseBackend, type AppInfo, type PermissionsResult } from './mac'

// ===== MCP 工具定义（JSON-RPC schema 胶囊） =====

export interface McpToolDef {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image-uri'; uri: string }

export interface McpToolCallResult {
  content: McpContentBlock[]
  isError: true | null
}

/** 工具分发表：name → { handle, schema } */
interface ToolEntry {
  description: string
  inputSchema: Record<string, unknown>
  handle: (args: Record<string, unknown>) => Promise<McpToolCallResult>
}

/** 把任意值转为文本（错误时用） */
function textBlock(text: string): McpToolCallResult {
  return { content: [{ type: 'text', text }], isError: null }
}

function errorBlock(message: string): McpToolCallResult {
  return { content: [{ type: 'text', text: `[Error] ${message}` }], isError: true }
}

/** 简化 JSON Schema 构造：string / number / boolean / 可选 */
function str(desc: string): Record<string, unknown> {
  return { type: 'string', description: desc }
}
function num(desc: string): Record<string, unknown> {
  return { type: 'number', description: desc }
}
function bool(desc: string): Record<string, unknown> {
  return { type: 'boolean', description: desc }
}

// ===== 进程内 MCP Server =====

/**
 * computer-use MCP JSON-RPC server（进程内）。
 * 每次注册一个 transport 时创建一个独立实例，处理代理给后端的方法。
 */
export class ComputerUseMcpServer {
  constructor(private readonly backend: ComputerUseBackend) {}

  /** 构建工具分发表（按需读取） */
  private tools(): Map<string, ToolEntry> {
    const backend = this.backend
    const entries: Array<[string, ToolEntry]> = [
      [
        'check_permissions',
        {
          description: '检查「辅助功能」与「屏幕录制」权限状态',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async handle() {
            const p: PermissionsResult = await backend.checkPermissions()
            return textBlock(`accessibility=${p.accessibility}\nscreenRecording=${p.screenRecording ?? 'unknown'}`)
          },
        },
      ],
      [
        'list_apps',
        {
          description: '列出本机运行中的应用（name、pid、运行状态，可选 windowId 丰富）',
          inputSchema: {
            type: 'object',
            properties: {
              includeWindowIds: bool('是否附带 windowId（缺省 false）'),
              windowLimit: num('返回窗口数量上限'),
            },
            additionalProperties: false,
          },
          async handle(args) {
            const r = await backend.listApps({
              includeWindowIds: args.includeWindowIds as boolean | undefined,
            })
            return textBlock(formatApps(r.apps))
          },
        },
      ],
      [
        'get_app_state',
        {
          description: '获取应用当前状态：辅助功能 UI 树 + 可选窗口截图。每次交互前先调用。',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用 bundleId / 进程名'),
              windowId: num('指定窗口 id（多窗口时）'),
              disableDiff: bool('是否禁用差异（缺省 false）'),
            },
            required: ['app'],
            additionalProperties: false,
          },
          async handle(args) {
            const app = args.app as string
            if (!app) return errorBlock('get_app_state 缺少 app')
            const r = await backend.getAppState({
              app,
              windowId: args.windowId as number | undefined,
            })
            const content: McpContentBlock[] = [{ type: 'text', text: `<ui_tree>\n${r.uiTree}\n</ui_tree>` }]
            if (r.screenshot) content.push({ type: 'image-uri', uri: r.screenshot })
            return { content, isError: null }
          },
        },
      ],
      [
        'click',
        {
          description: '按图片像素坐标或 UI 树 element_id 点击。左键后台交付不抢焦点。',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用'),
              windowId: num('窗口 id'),
              x: num('x 坐标（图片像素）'),
              y: num('y 坐标（图片像素）'),
              element_id: str('UI 树 element_id'),
              button: str('left | right | middle'),
              clickCount: num('点击次数'),
            },
            additionalProperties: false,
          },
          async handle(args) {
            await backend.click({
              app: args.app as string,
              x: args.x as number | undefined,
              y: args.y as number | undefined,
              element_id: args.element_id as string | undefined,
              button: (args.button as string) ?? 'left',
              clickCount: args.clickCount as number | undefined,
            })
            return textBlock('clicked')
          },
        },
      ],
      [
        'scroll',
        {
          description: '按方向滚动元素。优先用 element_id；deltaY>0 向下，deltaY<0 向上。',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用'),
              element_id: str('UI 树 element_id'),
              x: num('x 坐标'),
              y: num('y 坐标'),
              deltaY: num('垂直滚动量'),
              deltaX: num('水平滚动量'),
              direction: str('up | down | left | right'),
              pages: num('滚动页数（缺省 1）'),
            },
            additionalProperties: false,
          },
          async handle(args) {
            await backend.scroll({
              app: args.app as string,
              element_id: args.element_id as string | undefined,
              deltaY: args.deltaY as number | undefined,
              deltaX: args.deltaX as number | undefined,
              direction: args.direction as string | undefined,
              pages: args.pages as number | undefined,
            })
            return textBlock('scrolled')
          },
        },
      ],
      [
        'drag',
        {
          description: '从一点拖到另一点（图片像素坐标）',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用'),
              windowId: num('窗口 id'),
              fromX: num('起点 x'),
              fromY: num('起点 y'),
              toX: num('终点 x'),
              toY: num('终点 y'),
            },
            additionalProperties: false,
          },
          async handle(args) {
            await backend.drag({
              app: args.app as string,
              fromX: args.fromX as number | undefined,
              fromY: args.fromY as number | undefined,
              toX: args.toX as number | undefined,
              toY: args.toY as number | undefined,
            })
            return textBlock('dragged')
          },
        },
      ],
      [
        'type_text',
        {
          description: '向目标输入框输入文本（后台不抢焦点）。务必先 click 目标字段。',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用'),
              text: str('要输入的文本'),
              slowly: bool('是否慢速输入'),
            },
            required: ['text'],
            additionalProperties: false,
          },
          async handle(args) {
            await backend.typeText({ app: args.app as string, text: args.text as string, slowly: args.slowly as boolean | undefined })
            return textBlock('typed')
          },
        },
      ],
      [
        'press_key',
        {
          description: '按键或组合键。如 press_key(key="enter") / press_key(key="v", modifiers=["cmd"])',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用'),
              key: str('按键名（enter/tab/space/字母/数字/方向键等）'),
              modifiers: { type: 'array', items: str('cmd/ctrl/opt/shift'), description: '组合键修饰符' },
            },
            required: ['key'],
            additionalProperties: false,
          },
          async handle(args) {
            await backend.pressKey({ app: args.app as string, key: args.key as string, modifiers: args.modifiers as string[] | undefined })
            return textBlock('pressed')
          },
        },
      ],
      [
        'perform_action',
        {
          description: '对 UI 元素调用辅助功能动作（AXPress/AXShowMenu）。失败可退回 click。',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用'),
              element_id: str('UI 树 element_id'),
              action: str('要执行的动作，如 Show Menu'),
            },
            required: ['action'],
            additionalProperties: false,
          },
          async handle(args) {
            await backend.performAction({ app: args.app as string, element_id: args.element_id as string | undefined, action: args.action as string })
            return textBlock('action performed')
          },
        },
      ],
      [
        'set_value',
        {
          description: '设置可写辅助功能元素的值。Electron 等应用可能拒写，可退回 click + type_text。',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用'),
              element_id: str('UI 树 element_id'),
              value: str('要设置的值'),
            },
            required: ['value'],
            additionalProperties: false,
          },
          async handle(args) {
            await backend.setValue({ app: args.app as string, element_id: args.element_id as string | undefined, value: args.value as string })
            return textBlock('value set')
          },
        },
      ],
      [
        'select_text',
        {
          description: '在元素内选中文本或定位光标（text | cursor_before | cursor_after）',
          inputSchema: {
            type: 'object',
            properties: {
              app: str('目标应用'),
              element_id: str('UI 树 element_id'),
              text: str('目标文本'),
              selection: str('text | cursor_before | cursor_after'),
              prefix: str('前缀消歧'),
              suffix: str('后缀消歧'),
            },
            additionalProperties: false,
          },
          async handle(args) {
            await backend.selectText({ app: args.app as string, element_id: args.element_id as string, text: args.text as string, selection: args.selection as string | undefined })
            return textBlock('selected')
          },
        },
      ],
    ]
    return new Map(entries)
  }

  /**
   * 处理一条 JSON-RPC 请求/通知。
   * @param msg 已序列化的 JSON-RPC 报文
   * @param reply 回传响应（同步方法直接调，异步方法稍后调）
   */
  handle(msg: string, reply: (data: string) => void): void {
    let req: any
    try {
      req = JSON.parse(msg)
    } catch {
      return
    }
    const respond = (result: unknown) =>
      reply(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    const respondError = (code: number, message: string) =>
      reply(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code, message } }))

    // 通知：不需要响应
    if (req.id == null) return

    switch (req.method) {
      case 'initialize':
        respond({
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'computer-use', version: '0.1.0' },
        })
        return
      case 'tools/list':
        respond({ tools: this.toolDefs() })
        return
      case 'tools/call':
        void this.dispatchToolCall(req, respond, respondError)
        return
      default:
        respondError(-32601, `Method not found: ${req.method}`)
    }
  }

  /** MCP 工具列表（仅 name/description/inputSchema） */
  private toolDefs(): McpToolDef[] {
    return Array.from(this.tools().entries()).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  /** 执行 tools/call */
  private async dispatchToolCall(
    req: { params?: { name?: string; arguments?: Record<string, unknown> } },
    respond: (r: unknown) => void,
    respondError: (code: number, message: string) => void,
  ): Promise<void> {
    const name = req.params?.name ?? ''
    const entry = this.tools().get(name)
    if (!entry) {
      respondError(-32602, `Unknown tool: ${name}`)
      return
    }
    try {
      const result = await entry.handle(req.params?.arguments ?? {})
      respond(result)
    } catch (err) {
      respond(errorBlock((err as Error)?.message ?? String(err)))
    }
  }
}

// ===== 与 registry / mcp-client 对接的 Transport =====

/**
 * 把 computer-use 进程内 server 包装为 @harness/mcp-client 的 McpTransport。
 * 客户端 send() 直接喂给 server，server 的响应经 onMessage 回调回传。
 */
export function createComputerUseServerTransport(server: ComputerUseMcpServer): {
  send(data: string): void
  onMessage(handler: (data: string) => void): void
  close(): void
} {
  let handler: ((data: string) => void) | undefined
  const queued: string[] = []

  return {
    send(data: string): void {
      server.handle(data, (resp) => {
        if (handler) handler(resp)
        else queued.push(resp)
      })
    },
    onMessage(h: (data: string) => void): void {
      handler = h
      // flush 缓存响应（onMessage 在 connect 前注册，正常不会触发，兜底）
      while (queued.length) h(queued.shift() as string)
    },
    close(): void {
      handler = undefined
      queued.length = 0
    },
  }
}

/** 应用列表格式化为文本 */
function formatApps(apps: AppInfo[]): string {
  const header = 'name\trunning\tpid\twindowId'
  const rows = apps.map(
    (a) => `${a.name}\t${a.running ? 'yes' : 'no'}\t${a.pid ?? '-'}\t${a.windowId ?? '-'}`,
  )
  return [header, ...rows].join('\n')
}