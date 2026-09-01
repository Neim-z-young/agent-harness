/**
 * @harness/tools-manager
 *
 * 工具管理插件：通过 `cli.commands` / `cli.command` 提供 REPL `/tools` 命令。
 *
 * 命令语法（repl '/' 前缀省略）：
 *   /tools                          # 列出当前 Agent 可用工具（filterByWhitelist(agent.tools)）
 *   /tools --all                    # 列出全局注册的全部工具（harness.tools.list()）
 *   /tools --json                   # 全局全部工具，JSON 结构化输出
 *   /tools <toolId>                 # 详情：描述/别名/安全声明/启用态
 *   /tools <toolId> on|off          # 作用域 A：加入/移出当前 agent.tools 并持久化（config.json）
 *   /tools <toolId> --global on|off # 作用域 B：全局工具池运行时 register/unregister（本轮进程生效）
 *
 * 作用域 A 依赖 cli 注入的 setAgentTools（写 config.json 的 agents[].tools + 即时覆盖运行时）；
 * 作用域 B 在插件内部缓存被卸载的 Tool 以便 on 时恢复。
 */

import type { CliCommandInput, AgentPlugin, Hooks } from '@harness/plugin'
import type { Tool } from '@harness/tool'

/** cli 注入的 harness 能力视图（由消费侧类型化 harness?: unknown） */
interface HarnessView {
  tools: {
    list(): Tool[]
    get(id: string): Tool | undefined
    unregister(id: string): void
    register(tool: Tool): void
    filterByWhitelist(whitelist: string[] | ['*']): Tool[]
  }
  agent: {
    get(agentId: string): { id: string; tools: string[] } | undefined
  }
}

type ToolsCtx = Omit<CliCommandInput, 'harness'> & {
  harness: HarnessView
  agentId: string
  setAgentTools: (agentId: string, tools: string[]) => Promise<void>
}

const FLAGS = new Set(['--all', '--json', '--global'])

function formatTool(t: Tool): string {
  const flags: string[] = []
  if (t.isReadOnly?.(undefined)) flags.push('只读')
  if (t.isDestructive?.(undefined)) flags.push('危险')
  const meta = flags.length ? ` [${flags.join(',')}]` : ''
  return `  ${t.id.padEnd(22)}${(t.description ?? '').slice(0, 42)}${meta}`
}

export function createToolsManagerPlugin(): AgentPlugin {
  /** 作用域 B：记录被 --global off 从注册池卸载的 Tool，供 on 时恢复 */
  const suspended = new Map<string, Tool>()

  const hooks: Hooks = {
    'cli.commands'(input: { commands: Array<{ command: string; description: string; usage?: string }> }) {
      input.commands.push({
        command: 'tools',
        description: '工具管理：查看 / Agent 白名单持久化 / --global 运行时启停',
        usage:
          '/tools [--all | --json | <toolId> | <toolId> on|off | <toolId> --global on|off]',
      })
    },

    async 'cli.command'(input: CliCommandInput) {
      if (input.command !== 'tools') return
      const inp = input as ToolsCtx
      const { out, harness } = inp
      const tokens = inp.arg.trim().split(/\s+/).filter(Boolean)
      const hasAll = tokens.includes('--all')
      const hasJson = tokens.includes('--json')
      const isGlobal = tokens.includes('--global')
      const body = tokens.filter((t) => !FLAGS.has(t))

      // 列表视图
      if (body.length === 0) {
        if (hasAll || hasJson) {
          const all = harness.tools.list()
          if (hasJson) {
            out(JSON.stringify(all.map((t) => ({
              id: t.id, description: t.description, aliases: t.aliases,
              isReadOnly: t.isReadOnly?.(undefined) ?? false,
              isDestructive: t.isDestructive?.(undefined) ?? false,
              isConcurrencySafe: t.isConcurrencySafe?.(undefined) ?? false,
            })), null, 2) + '\n')
          } else {
            out(`全局注册 ${all.length} 个工具：\n${all.map(formatTool).join('\n')}\n`)
          }
          return
        }
        const agentTools = harness.agent.get(inp.agentId)?.tools ?? ['*']
        const usable = harness.tools.filterByWhitelist(agentTools)
        out(`Agent「${inp.agentId}」可用工具（白名单：${agentTools.join(', ') || '(空)'}）：\n${usable.map(formatTool).join('\n')}\n`)
        return
      }

      // 工具对象 / 动作
      const toolArg = body[0]
      const action = body[1]
      const isOn = action === 'on'

      if (action && action !== 'on' && action !== 'off') {
        out(`未知动作：${action}（期望 on | off）。\n`)
        return
      }

      // 作用域 B：--global 运行时启停（本轮进程生效，不持久化）
      if (isGlobal) {
        if (!action) {
          out(`用法：/tools <toolId> --global on|off\n`)
          return
        }
        if (isOn) {
          const cached = suspended.get(toolArg)
          if (!cached) {
            if (harness.tools.get(toolArg)) out(`工具 "${toolArg}" 已在启用态。\n`)
            else out(`工具 "${toolArg}" 未注册，无法启用。\n`)
            return
          }
          harness.tools.register(cached)
          suspended.delete(toolArg)
          out(`已全局启用工具 "${toolArg}"（本轮进程生效）。\n`)
          return
        }
        const t = harness.tools.get(toolArg)
        if (!t) {
          out(`工具 "${toolArg}" 未注册（可能已被全局禁用）。\n`)
          return
        }
        suspended.set(toolArg, t)
        harness.tools.unregister(toolArg)
        out(`已全局禁用工具 "${toolArg}"（影响所有 Agent，本轮进程生效；使用 --global on 恢复）。\n`)
        return
      }

      // 详情视图（无动作）
      if (!action) {
        const t = harness.tools.get(toolArg)
        if (!t) {
          out(`工具 "${toolArg}" 未找到（先看 /tools --all 确认 id）。\n`)
          return
        }
        const agentTools = harness.agent.get(inp.agentId)?.tools ?? ['*']
        const enabled = agentTools.includes('*') || harness.tools.filterByWhitelist(agentTools).some((x) => x.id === t.id)
        out(`工具：${t.id}\n`
          + `  描述：${t.description ?? ''}\n`
          + `  别名：${t.aliases?.join(', ') ?? '-'}\n`
          + `  安全：${[
            t.isReadOnly?.(undefined) ? '只读' : '可写',
            t.isDestructive?.(undefined) ? '危险' : '',
            t.isConcurrencySafe?.(undefined) === false ? '非并发' : '',
          ].filter(Boolean).join(' / ') || '-'}\n`
          + `  当前 Agent 启用：${enabled ? '是' : '否'}\n`)
        return
      }

      // 作用域 A：Agent 白名单增删 + 持久化
      const cur = harness.agent.get(inp.agentId)?.tools ?? ['*']
      const wildcard = cur.length === 1 && cur[0] === '*'
      if (isOn) {
        if (wildcard || cur.includes(toolArg)) {
          out(`工具 "${toolArg}" 已在 Agent「${inp.agentId}」白名单中（${wildcard ? '默认全部允许' : '已显式启用'}）。\n`)
          return
        }
        await inp.setAgentTools(inp.agentId, [...cur, toolArg])
        out(`已启用工具 "${toolArg}" 并写入 config.json（Agent「${inp.agentId}」白名单，重启后保持）。\n`)
        return
      }

      // off
      if (!cur.includes(toolArg) && !wildcard) {
        out(`工具 "${toolArg}" 不在 Agent「${inp.agentId}」白名单中。\n`)
        return
      }
      if (wildcard) {
        // 默认全部 → 移除一个需展开为显式白名单（除目标外全部注册工具）
        const allIds = harness.tools.list().map((t) => t.id)
        out(`注意：Agent 白名单当前为全允许（*），"${toolArg}" 将转为显式白名单（除 ${toolArg} 外全部允许）后持久化。\n`)
        await inp.setAgentTools(inp.agentId, allIds.filter((id) => id !== toolArg))
        return
      }
      await inp.setAgentTools(inp.agentId, cur.filter((id) => id !== toolArg))
      out(`已禁用工具 "${toolArg}" 并写入 config.json（Agent「${inp.agentId}」白名单）。\n`)
    },
  }

  return {
    id: 'tools-manager',
    name: 'Tools Manager',
    version: '0.1.0',
    async install() {
      return hooks
    },
  }
}

export default createToolsManagerPlugin