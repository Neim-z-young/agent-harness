/**
 * code-intel 进程内 MCP server
 *
 * 与 harness 解耦：本模块仅依赖 `core.ts`（索引/编辑引擎，零 harness 依赖），不 import
 * `@harness/tool` / `@harness/plugin`。实现 MCP JSON-RPC server（initialize / tools/list /
 * tools/call），暴露 code_symbols / code_reference / code_definition / code_semantic_edit，
 * 并包装为 `@harness/mcp-client` 的 `McpTransport`，由 mcp-server-registry 进程内连接并拉回 Harness。
 *
 * 交互契约：工具入参可选 `cwd`（缺省 server 构造时传入的 baseDir / process.cwd()），
 * `path` 相对该 cwd 解析（可绝对路径）。返回文本（便于 LLM 直接阅读）。
 */

import { CodeIntelIndex, execSemanticEdit, MAX_RESULTS } from './core'
// 路径边界：改用 @harness/fs-guard 的 realpath 版（P0-4/P0-5/P3-1）。
// 它不在上面的"不 import harness"名单里 —— 零依赖叶子包，不是 harness 的一部分。
import { resolvePath } from '@harness/fs-guard'

// ===== MCP 结构（与 @harness/mcp-client 的 McpToolDef 同构，自包含避免跨包依赖）=====

export interface McpToolDefParam {
  name: string
  description?: string
}

export type ToolEntry = {
  description: string
  inputSchema: Record<string, unknown>
  handle: (args: Record<string, unknown>, cwd: string) => Promise<{ content: string; isError: boolean }>
}

function textResult(text: string): { content: string; isError: boolean } {
  return { content: text, isError: false }
}
function errorResult(message: string): { content: string; isError: boolean } {
  return { content: `[Error] ${message}`, isError: true }
}

const STR = 'string'
function prop(type: string, description: string): Record<string, unknown> {
  return { type, description }
}

// ===== 进程内 MCP Server =====

export interface CodeIntelMcpServerOptions {
  /** 缺省 cwd（工具未显式传 cwd 时用）；缺省 process.cwd() */
  baseDir?: string
  index?: CodeIntelIndex
}

/**
 * code-intel 进程内 MCP JSON-RPC server。
 * 与 computer-use 同构：handle(msg, reply) 处理 initialize / tools/list / tools/call。
 */
export class CodeIntelMcpServer {
  readonly cwd: string
  private readonly index: CodeIntelIndex
  constructor(opts: CodeIntelMcpServerOptions = {}) {
    this.cwd = opts.baseDir ?? process.cwd()
    this.index = opts.index ?? new CodeIntelIndex()
  }

  readonly serverName = 'code-intel'

  private tools(): Map<string, ToolEntry> {
    const index = this.index
    const entries: Array<[string, ToolEntry]> = [
      [
        'code_symbols',
        {
          description: '列出文件或目录中的代码符号（函数/类/变量/接口/类型/枚举/导入）。支持 TS/JS（babel）与 Go/Python/Rust/Java（tree-sitter）。入参 path（可选，缺省 cwd）、cwd。',
          inputSchema: {
            type: 'object',
            properties: {
              path: prop(STR, '文件或目录路径，相对 cwd 或绝对路径；缺省 cwd'),
              cwd: prop(STR, '解析相对 path 的工作目录；缺省 server baseDir'),
            },
            additionalProperties: false,
          },
          async handle(args, cwd) {
            const path = (args.path as string | undefined) ?? '.'
            const list = await index.symbols(resolvePath(path, cwd), cwd)
            const rows = list.slice(0, MAX_RESULTS).map((s) => `${s.kind}\t${s.name}\t${s.relativePath}:${s.line}:${s.column}${s.signature ? `\t${s.signature}` : ''}`)
            const head = `symbols=${list.length}${list.length > MAX_RESULTS ? ` (首 ${MAX_RESULTS})` : ''}\n`
            return textResult(head + rows.join('\n'))
          },
        },
      ],
      [
        'code_reference',
        {
          description: '查找某符号在代码中的引用（usages，含跨文件）。入参 symbol、path（可选）、cwd。',
          inputSchema: {
            type: 'object',
            properties: {
              symbol: prop(STR, '符号名'),
              path: prop(STR, '扫描根目录/文件，相对 cwd 或绝对路径；缺省 cwd'),
              cwd: prop(STR, '工作目录'),
            },
            required: ['symbol'],
            additionalProperties: false,
          },
          async handle(args, cwd) {
            const symbol = String(args.symbol ?? '')
            const path = (args.path as string | undefined) ?? '.'
            await index.load(resolvePath(path, cwd), cwd)
            const refs = index.allReferences(symbol)
            const rows = refs.slice(0, MAX_RESULTS).map((r) => `${r.relativePath}:${r.line}:${r.column}\t${r.context}`)
            const head = `references=${refs.length}${refs.length > MAX_RESULTS ? ` (首 ${MAX_RESULTS})` : ''} for "${symbol}"\n`
            return textResult(head + rows.join('\n'))
          },
        },
      ],
      [
        'code_definition',
        {
          description: '符号 go-to-definition：返回声明位置（文件/行/列/类型/签名）。入参 symbol、path（可选）、cwd。',
          inputSchema: {
            type: 'object',
            properties: {
              symbol: prop(STR, '符号名'),
              path: prop(STR, '扫描根目录/文件，相对 cwd 或绝对路径；缺省 cwd'),
              cwd: prop(STR, '工作目录'),
            },
            required: ['symbol'],
            additionalProperties: false,
          },
          async handle(args, cwd) {
            const symbol = String(args.symbol ?? '')
            const path = (args.path as string | undefined) ?? '.'
            await index.load(resolvePath(path, cwd), cwd)
            const defs = index.allDefinitions(symbol)
            const rows = defs.slice(0, MAX_RESULTS).map((d) => `${d.kind}\t${d.name}\t${d.relativePath}:${d.line}:${d.column}${d.signature ? `\t${d.signature}` : ''}`)
            const head = `definitions=${defs.length} for "${symbol}"\n`
            return textResult(head + rows.join('\n'))
          },
        },
      ],
      [
        'code_semantic_edit',
        {
          description: `结构感知编辑。mode=rename（symbol→to，可 scope 限子目录、resolveImporters 跨目录反向 import）/ mode=replace_node（按行列吸附节点替换，startLine/startColumn/endLine/endColumn/replacement）/ mode=replace_subtree（selector 成员链，path 可为目录批量）。dryRun 预览不落盘。返回编辑文件的 JSON 摘要。`,
          inputSchema: {
            type: 'object',
            properties: {
              mode: { enum: ['rename', 'replace_node', 'replace_subtree'], description: '编辑模式' },
              symbol: prop(STR, 'rename：目标符号名'),
              to: prop(STR, 'rename：新符号名'),
              path: prop(STR, 'rename/replace_subtree 的根（目录=批量）；replace_node 的目标文件；相对 cwd 或绝对路径'),
              scope: prop(STR, 'rename：作用域限定子目录/文件'),
              resolveImporters: { type: 'boolean', description: 'rename：跨目录反向 import 查找' },
              importRoot: prop(STR, 'rename：反向 import 扫描根'),
              startLine: { type: 'number', description: 'replace_node：起始行(1-based)' },
              startColumn: { type: 'number', description: 'replace_node：起始列(1-based)' },
              endLine: { type: 'number', description: 'replace_node：结束行(1-based)' },
              endColumn: { type: 'number', description: 'replace_node：结束列(1-based)；0=行尾' },
              replacement: prop(STR, 'replace_node/replace_subtree：替换文本'),
              selector: prop(STR, 'replace_subtree：成员链选择器，如 config.server.host'),
              dryRun: { type: 'boolean', description: '仅预览不落盘' },
              cwd: prop(STR, '工作目录'),
            },
            required: ['mode'],
            additionalProperties: false,
          },
          async handle(args, cwd) {
            const mode = String(args.mode)
            const input: Record<string, unknown> = { mode }
            if (mode === 'rename') {
              input.symbol = String(args.symbol ?? '')
              input.to = String(args.to ?? '')
              if (args.path !== undefined) input.path = String(args.path)
              if (args.scope !== undefined) input.scope = String(args.scope)
              if (args.resolveImporters !== undefined) input.resolveImporters = Boolean(args.resolveImporters)
              if (args.importRoot !== undefined) input.importRoot = String(args.importRoot)
              if (args.dryRun !== undefined) input.dryRun = Boolean(args.dryRun)
            } else if (mode === 'replace_node') {
              input.path = String(args.path ?? '')
              input.startLine = Number(args.startLine)
              input.startColumn = Number(args.startColumn)
              input.endLine = Number(args.endLine)
              if (args.endColumn !== undefined) input.endColumn = Number(args.endColumn)
              input.replacement = String(args.replacement ?? '')
              if (args.dryRun !== undefined) input.dryRun = Boolean(args.dryRun)
            } else if (mode === 'replace_subtree') {
              input.path = String(args.path ?? '')
              input.selector = String(args.selector ?? '')
              input.replacement = String(args.replacement ?? '')
              if (args.dryRun !== undefined) input.dryRun = Boolean(args.dryRun)
            }
            const res = await execSemanticEdit(index, input as never, { cwd })
            if (!res.ok) return errorResult(`${res.error.code}: ${res.error.message}`)
            return textResult(JSON.stringify(res.output, null, 2))
          },
        },
      ],
    ]
    return new Map(entries)
  }

  private toolDefs(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.tools().entries()].map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }))
  }

  handle(msg: string, reply: (data: string) => void): void {
    let req: { id?: number | string | null; method?: string; params?: any }
    try {
      req = JSON.parse(msg)
    } catch {
      return
    }
    if (req.id == null) return
    const respond = (result: unknown) => reply(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    const respondError = (code: number, message: string) => reply(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code, message } }))
    switch (req.method) {
      case 'initialize':
        respond({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'code-intel', version: '0.10.0' },
        })
        break
      case 'tools/list':
        respond({ tools: this.toolDefs() })
        break
      case 'tools/call':
        void this.dispatchToolCall(req, respond, respondError)
        break
      default:
        respondError(-32601, `Method not found: ${req.method}`)
    }
  }

  private async dispatchToolCall(
    req: { id?: number | string | null; params?: any },
    respond: (r: unknown) => void,
    respondError: (code: number, message: string) => void,
  ): Promise<void> {
    const name = req.params?.name
    const tools = this.tools()
    const entry = tools.get(name)
    if (!entry) {
      respondError(-32602, `Unknown tool: ${name}`)
      return
    }
    // cwd 解析：优先入参 cwd，否则缺省 server baseDir
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>
    const cwdArg = args.cwd as string | undefined
    const cwd = cwdArg ? resolvePath(cwdArg, this.cwd) : this.cwd
    try {
      const result = await entry.handle(args, cwd)
      respond({
        content: [{ type: 'text', text: result.content }],
        isError: result.isError ? true : null,
      })
    } catch (err) {
      respondError(-32603, String((err as Error)?.message ?? err))
    }
  }
}

// ===== 与 registry / mcp-client 对接的 Transport =====

/**
 * 把 code-intel 进程内 server 包装为 `@harness/mcp-client` 的 `McpTransport`。
 * 客户端 send() 直接喂给 server，响应经 onMessage 回调回传。
 */
export function createCodeIntelServerTransport(server: CodeIntelMcpServer): {
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
      while (queued.length) h(queued.shift() as string)
    },
    close(): void {
      handler = undefined
      queued.length = 0
    },
  }
}