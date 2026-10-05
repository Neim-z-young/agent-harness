/**
 * `@harness/mcp-server` 插件：把 harness 工具集经 MCP 协议暴露给外部 MCP 客户端。
 *
 * ## ⚠️ 不要与 `@harness/mcp-server-registry` 混淆
 * `mcp-server-registry` 管的是"**harness 要去连哪些 server**"（client 侧清单）；
 * 本包是"**harness 自己当 server**"（server 侧）。两者方向相反，配置与命令都不通用。
 *
 * ## 为什么是 `optIn`
 * 它占一个端口、开一个网络面（虽只绑回环）。这类有副作用的能力不该默认装配 ——
 * 与 `code-intel` / `computer-use` 同档（它们靠 `mcp.server-registry` 起，本包自带 HTTP 服务）。
 *
 * ## 权限桥：包装而不是替换 asker
 * `InteractivePermissionEngine.setAsker` 是**全局单槽**。本插件启动时取到原 asker
 * （`getAsker`），装一个按会话归属分流的包装：属于本 MCP 会话的询问走 elicitation，
 * 其余原样交回 —— 否则会把 TUI 的模态审批顶掉。停止时**仅在仍是我们那个**的前提下还原。
 */
import type { Harness } from '@harness/core'
import type { AgentPlugin, CliCommandInput, CliCommandsInput, PluginContext } from '@harness/plugin'
import type { AnswerLike, AskInputLike, PromptLike } from './elicit'
import {
  DEFAULT_MCP_PATH,
  DEFAULT_MCP_PORT,
  type McpLogger,
  type McpServerHandle,
  createMcpServer,
} from './server'
import { buildToolIndex } from './tools'

export interface McpServerPluginOptions {
  /** 默认端口（`/mcp-serve --port n` 可覆盖） */
  port?: number
  path?: string
  token?: string
  prefix?: string
}

/** 与 `@harness/host` 的 `PermissionAsker` 结构兼容（此处结构化声明，避免反向依赖 host） */
export type PermissionAskerLike = (req: AskInputLike, prompt: PromptLike) => Promise<AnswerLike | undefined>

/**
 * 权限引擎里我们**真正需要**的两个方法。
 * `PermissionEngine` 接口本身只有 check/ask/updateRules；`setAsker`/`getAsker` 是
 * `InteractivePermissionEngine` 的额外能力 ⇒ 结构化探测，缺了就明确告警而不是静默。
 */
interface AskableEngine {
  setAsker?: (fn: PermissionAskerLike | undefined) => void
  getAsker?: () => PermissionAskerLike | undefined
}

/**
 * 解析 `/mcp-serve` 的参数：支持 `--k v` 与 `--k=v` 两种写法。
 * 非法的 `--port` 值（非整数 / 负数）**忽略而不是报错**：命令层的容错交给默认值，
 * 少一个参数不该让整个启动失败。
 */
export function parseServeArgs(arg: string): { port?: number; token?: string; prefix?: string; path?: string } {
  const out: { port?: number; token?: string; prefix?: string; path?: string } = {}
  const tokens = arg.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const eq = t.indexOf('=')
    const key = eq === -1 ? t : t.slice(0, eq)
    const inline = eq === -1 ? undefined : t.slice(eq + 1)
    const take = (): string | undefined => (inline !== undefined ? inline : tokens[++i])
    switch (key) {
      case '--port': {
        const v = Number(take())
        if (Number.isInteger(v) && v >= 0) out.port = v
        break
      }
      case '--token': {
        const v = take()
        if (v) out.token = v
        break
      }
      case '--prefix': {
        const v = take()
        if (v) out.prefix = v
        break
      }
      case '--path': {
        const v = take()
        if (v) out.path = v
        break
      }
      default:
        break
    }
  }
  return out
}

export function createMcpServerPlugin(options: McpServerPluginOptions = {}): AgentPlugin {
  let harness: Harness | undefined
  let handle: McpServerHandle | undefined
  let engineRef: AskableEngine | undefined
  let ourAsker: PermissionAskerLike | undefined
  let prevAsker: PermissionAskerLike | undefined
  let log: McpLogger = () => {}

  const exposure = (): { prefix?: string } => (options.prefix ? { prefix: options.prefix } : {})
  const exposedCount = (): number =>
    harness ? buildToolIndex(harness.tools, exposure()).descriptors.length : 0

  /**
   * 装配询问接缝（包装形态）。返回需要展示给用户的告警（无则 undefined）。
   */
  function installAsker(h: McpServerHandle): string | undefined {
    const engine = harness?.permission as unknown as AskableEngine | undefined
    if (!engine || typeof engine.setAsker !== 'function') {
      return '当前宿主的权限引擎不支持 setAsker ⇒ 写工具将被一律拒绝（只读工具不受影响）'
    }
    engineRef = engine
    prevAsker = engine.getAsker?.()
    ourAsker = (req, prompt) =>
      h.owns(req.sessionId)
        ? h.asker(req, prompt)
        : prevAsker
          ? prevAsker(req, prompt)
          : Promise.resolve(undefined)
    engine.setAsker(ourAsker)
    if (typeof engine.getAsker !== 'function') {
      return '当前宿主的权限引擎没有 getAsker ⇒ 停止时无法还原原 asker（请在停止后重装宿主交互）'
    }
    return undefined
  }

  /** 还原 asker：**仅在仍是我们那个**时才动，避免把宿主中途换上的顶掉 */
  function restoreAsker(): void {
    if (engineRef && ourAsker && engineRef.getAsker?.() === ourAsker) engineRef.setAsker?.(prevAsker)
    engineRef = undefined
    ourAsker = undefined
    prevAsker = undefined
  }

  async function stopServer(): Promise<string | undefined> {
    if (!handle) return undefined
    const url = handle.url
    restoreAsker()
    await handle.stop()
    handle = undefined
    return url
  }

  return {
    id: 'mcp-server',
    version: '0.1.0',
    name: 'MCP Server',
    description:
      '把 harness 工具集经 MCP（Streamable HTTP）暴露给外部客户端（VSCode Copilot Chat / Continue / Cline）；写操作经 elicitation 二次确认，客户端不支持则拒绝',

    async install(ctx: PluginContext) {
      log = (level, message, meta) => {
        const line = meta === undefined ? message : `${message} ${JSON.stringify(meta)}`
        if (level === 'error') ctx.log.error(line)
        else if (level === 'warn') ctx.log.warn(line)
        else ctx.log.info(line)
      }

      return {
        'core.harness.init'(_input, output) {
          harness = (output as { harness?: Harness }).harness
        },

        'cli.commands'(input: CliCommandsInput) {
          input.commands.push(
            {
              command: 'mcp-serve',
              description: '启动 MCP server（把工具集暴露给外部 MCP 客户端）',
              usage: '/mcp-serve [--port n] [--token t] [--prefix p]',
            },
            {
              command: 'mcp-status',
              description: 'MCP server 状态（端点 / 工具数 / 会话 / 待决确认）',
              usage: '/mcp-status',
            },
            { command: 'mcp-stop', description: '停止 MCP server', usage: '/mcp-stop' },
          )
        },

        async 'cli.command'(input: CliCommandInput) {
          if (!input.command.startsWith('mcp-')) return
          input.result = 'continue'
          const out = input.out

          switch (input.command) {
            case 'mcp-serve': {
              if (!harness) {
                out('mcp-server：harness 尚未就绪，请稍后再试\n')
                return
              }
              if (handle) {
                out(`mcp-server：已在运行（${handle.url}）。先 /mcp-stop 再改参数\n`)
                return
              }
              const args = parseServeArgs(input.arg)
              const port = args.port ?? options.port ?? DEFAULT_MCP_PORT
              const token = args.token ?? options.token
              const prefix = args.prefix ?? options.prefix
              let h: McpServerHandle
              try {
                h = createMcpServer({
                  harness,
                  port,
                  path: args.path ?? options.path ?? DEFAULT_MCP_PATH,
                  ...(token ? { token } : {}),
                  ...(prefix ? { prefix } : {}),
                  log,
                })
              } catch (err) {
                out(
                  `mcp-server：启动失败：${(err as Error)?.message ?? String(err)}\n` +
                    '  端口被占用？可改用 /mcp-serve --port 0（由系统分配空闲端口）\n',
                )
                return
              }
              handle = h
              const warn = installAsker(h)
              out(
                `MCP server 已启动\n` +
                  `  端点: ${h.url}\n` +
                  `  工具: ${exposedCount()} 个${prefix ? `（名字前缀 ${prefix}）` : ''}\n` +
                  `  鉴权: ${token ? 'Bearer' : '无（仅本机回环）'}\n` +
                  `  写操作: 需客户端 elicitation 确认，不支持则拒绝\n`,
              )
              if (warn) out(`  ⚠️ ${warn}\n`)
              return
            }

            case 'mcp-status': {
              if (!handle) {
                out('mcp-server：未运行（用 /mcp-serve 启动）\n')
                return
              }
              out(
                `MCP server 运行中\n` +
                  `  端点: ${handle.url}\n` +
                  `  工具: ${exposedCount()} 个\n` +
                  `  会话: ${handle.sessions.size} 个\n` +
                  `  待决确认: ${handle.sessions.pendingCount} 个\n`,
              )
              return
            }

            case 'mcp-stop': {
              if (!handle) {
                out('mcp-server：未运行\n')
                return
              }
              const url = await stopServer()
              out(`MCP server 已停止（${url ?? ''}）\n`)
              return
            }

            default:
              return
          }
        },
      }
    },

    async uninstall() {
      await stopServer()
    },
  }
}

export { createMcpServer } from './server'
export type { McpServerHandle, McpServerOptions } from './server'
export type { McpSession } from './session'
export * from './protocol'
export * from './tools'
export * from './elicit'
