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

import type { CliCommandInput, AgentPlugin, Hooks, ToolMetaEntry, ToolMetaLookup } from '@harness/plugin'
import type { Tool } from '@harness/tool'
import type { Bus, Unsubscribe } from '@harness/bus'
import { LifecycleEvents } from '@harness/core'
import type { McpServerEntry } from '@harness/mcp-server-registry'

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
  /** config.json 的 mcpServers 列表（供 mcp__ 前缀工具的 server 级掩码写入） */
  mcpServers?: McpServerEntry[]
  /** 把新的 mcpServers 列表写回 config.json */
  setMcpServers?: (list: McpServerEntry[]) => Promise<void>
}

const FLAGS = new Set(['--all', '--json', '--global'])

/** mcp__<server>__<tool> → 拆分（server 部分可能含 __，取首个 __ 之前作为 server 名） */
function parseMcpTool(id: string): { server: string; tool: string } | undefined {
  const rest = id.startsWith('mcp__') ? id.slice('mcp__'.length) : id
  if (!rest.includes('__')) return undefined
  const i = rest.indexOf('__')
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}

/** 归一化「运行时 Tool（isXxx 为函数）或静态元信息（isXxx 为布尔）」的安全声明到统一布尔视图 */
function entryFlags(t: Tool | ToolMetaEntry): { readOnly: boolean; destructive: boolean; concurrent: boolean } {
  const asTool = t as Tool
  const readOnly = typeof t.isReadOnly === 'function' ? asTool.isReadOnly?.(undefined) : t.isReadOnly
  const destructive = typeof t.isDestructive === 'function' ? asTool.isDestructive?.(undefined) : t.isDestructive
  const concurrent = typeof t.isConcurrencySafe === 'function' ? asTool.isConcurrencySafe?.(undefined) : t.isConcurrencySafe
  return { readOnly: !!readOnly, destructive: !!destructive, concurrent: !!concurrent }
}

/** 判断是否仅元信息（未加载运行时）——无 call 实现即视为 meta 占位 */
function isMetaEntry(t: Tool | ToolMetaEntry): t is ToolMetaEntry {
  return !('call' in t)
}

/** 合并「已加载运行时工具 + 内置静态元信息兜底」：未加载的内置工具也能展示，标记 (meta) */
function unionTools(loaded: Tool[], meta: ToolMetaLookup | undefined): Array<Tool | ToolMetaEntry> {
  const seen = new Set<string>()
  const result: Array<Tool | ToolMetaEntry> = []
  for (const t of loaded) {
    result.push(t)
    seen.add(t.id)
  }
  for (const m of meta?.list() ?? []) {
    if (!seen.has(m.id)) {
      result.push(m)
      seen.add(m.id)
    }
  }
  return result
}

/**
 * 计算 Agent 的全部可用工具（不受懒加载影响）：
 * 「已加载且在白名单内的运行时工具」+「白名单内未加载的静态元信息」。
 * 通配（*）白名单时补全部静态元信息；显式白名单时仅补白名单内未加载的工具。
 * 这样 /tools 列表在懒加载期间也能完整呈现 Agent 可用工具及其描述/状态。
 */
function agentUsableEntries(inp: ToolsCtx): Array<Tool | ToolMetaEntry> {
  const harness = inp.harness
  const agentTools = harness.agent.get(inp.agentId)?.tools ?? ['*']
  const wildcard = agentTools.length === 1 && agentTools[0] === '*'
  const loaded = harness.tools.filterByWhitelist(agentTools)
  if (wildcard) return unionTools(loaded, inp.toolMeta)   // 全允许：补全部静态元信息
  const meta = inp.toolMeta
  if (!meta) return loaded
  const result: Array<Tool | ToolMetaEntry> = [...loaded]
  const seen = new Set(result.map((x) => x.id))
  for (const id of agentTools) {
    if (id === '*' || seen.has(id)) continue
    const m = meta.get(id)
    if (m) { result.push(m); seen.add(id) }
  }
  return result
}

/** 从运行时 Tool 或静态元信息归一化出权限键 */
function permKeyOf(t: Tool | ToolMetaEntry): string {
  const asTool = t as Tool
  const key = (asTool as { permission?: { key?: string } }).permission?.key ?? (t as ToolMetaEntry).permissionKey
  return key ?? '-'
}

/** 是否已加载运行时实现（false = 仅静态元信息占位） */
function entryLoaded(t: Tool | ToolMetaEntry): boolean {
  return !isMetaEntry(t)
}

/**
 * 状态串：启用/禁用（相对当前 Agent 白名单）+ 加载状态（已加载 / 仅元信息）。
 * 未加载的元信息占位：仅在 Agent 白名单为通配 * 时视为启用，否则为禁用。
 */
function entryStatus(inp: ToolsCtx, t: Tool | ToolMetaEntry): string {
  const agentTools = inp.harness.agent.get(inp.agentId)?.tools ?? ['*']
  const wildcard = agentTools.length === 1 && agentTools[0] === '*'
  const loaded = entryLoaded(t)
  const enabled = wildcard
    ? true
    : isMetaEntry(t)
      ? agentTools.includes(t.id)                       // 未加载但显式在白名单 → 启用
      : inp.harness.tools.filterByWhitelist(agentTools).some((x) => x.id === t.id)
  const en = enabled ? '启用' : '禁用'
  const ld = loaded ? '已加载' : '仅元信息'
  return [en, ld].join('·')
}

/** 渲染工具表格：ID | 元信息(描述) | 权限键 | 状态（启用·加载·安全） */
function renderToolTable(inp: ToolsCtx, entries: Array<Tool | ToolMetaEntry>, mcpDownServer?: Set<string>): string {
  const rows = entries.map((t) => {
    const { readOnly, destructive, concurrent } = entryFlags(t)
    const safety = [...(readOnly ? ['只读'] : []), ...(destructive ? ['危险'] : []), ...(concurrent === false ? ['非并发'] : [])]
    const base = entryStatus(inp, t)
    let status = safety.length ? `${base}·${safety.join(',')}` : base
    if (t.id.startsWith('mcp__')) {
      // MCP 场景化工具：标注来源 server；server 已被 /mcp 禁用时额外标注不可用
      const m = parseMcpTool(t.id)
      if (m) {
        status += `·源自mcp${mcpDownServer?.has(m.server) ? '·server已禁用' : ''}`
      }
    }
    return { id: t.id, desc: (t.description ?? '').slice(0, 38), perm: permKeyOf(t), status }
  })
  const idW = Math.max('ID'.length, ...rows.map((r) => r.id.length))
  const descW = 40
  const permW = Math.max('权限'.length, ...rows.map((r) => r.perm.length))
  const statusW = Math.max('状态'.length, ...rows.map((r) => r.status.length))
  const head = `  ${'ID'.padEnd(idW)}${'元信息(描述)'.padEnd(descW)}${'权限'.padEnd(permW)}  ${'状态'.padEnd(statusW)}`
  const lines = [head, ...rows.map((r) => `  ${r.id.padEnd(idW)}${r.desc.padEnd(descW)}${r.perm.padEnd(permW)}  ${r.status.padEnd(statusW)}`)]
  return lines.join('\n')
}

/** 详情视图的安全声明文本 */
function formatSafety(t: Tool | ToolMetaEntry): string {
  const { readOnly, destructive, concurrent } = entryFlags(t)
  return [
    readOnly ? '只读' : '可写',
    destructive ? '危险' : '',
    concurrent === false ? '非并发' : '',
  ].filter(Boolean).join(' / ') || '-'
}

/** 详情视图：优先运行时工具；未加载则回退内置静态元信息（并标注） */
function renderDetail(inp: ToolsCtx, toolArg: string): void {
  const harness = inp.harness
  const t = harness.tools.get(toolArg)
  const out = inp.out
  if (!t) {
    const m = inp.toolMeta?.get(toolArg)
    if (m) {
      out(`工具：${m.id}（运行时未加载，以下为内置静态元信息）\n`
        + `  描述：${m.description ?? ''}\n`
        + `  别名：${m.aliases?.join(', ') ?? '-'}\n`
        + `  权限键：${m.permissionKey ?? '-'}\n`
        + `  安全：${formatSafety(m)}\n`)
      return
    }
    out(`工具 "${toolArg}" 未找到（先看 /tools --all 确认 id）。\n`)
    return
  }
  const agentTools = harness.agent.get(inp.agentId)?.tools ?? ['*']
  const enabled = agentTools.includes('*') || harness.tools.filterByWhitelist(agentTools).some((x) => x.id === t.id)
  out(`工具：${t.id}\n`
    + `  描述：${t.description ?? ''}\n`
    + `  别名：${t.aliases?.join(', ') ?? '-'}\n`
    + `  权限键：${permKeyOf(t)}\n`
    + `  安全：${formatSafety(t)}\n`
    + `  当前 Agent 启用：${enabled ? '是' : '否'}\n`)
}

export function createToolsManagerPlugin(): AgentPlugin {
  /** 作用域 B：记录被 --global off 从注册池卸载的 Tool，供 on 时恢复 */
  const suspended = new Map<string, Tool>()
  /** 事件总线（install 注入，用于发布/订阅生命周期事件） */
  let bus: Bus | undefined
  /** 事件退订句柄 */
  const offs: Unsubscribe[] = []
  /** 已被 /mcp 禁用的 server（用于 /tools 列表标注 mcp 工具来自的 server 不可用） */
  const disabledMcpServers = new Set<string>()

  /** 判定某工具是否来自「已被 /mcp 禁用的 server」 */
  function mcpServerDown(t: Tool | ToolMetaEntry): boolean {
    const m = parseMcpTool(t.id)
    return !!m && disabledMcpServers.has(m.server)
  }

  /**
   * 工具掩码统一收口到 /tools：对 mcp__<server>__<tool> 写入/删除 server 级掩码
   * config.json mcpServers[].tools。on→删除键（全开）；off→tools[tool]=false。
   * 返回错误字符串（undefined 表示成功）。
   */
  async function applyMcpMask(inp: ToolsCtx, id: string, isOn: boolean): Promise<string | undefined> {
    const m = parseMcpTool(id)
    if (!m) return undefined
    const list = [...(inp.mcpServers ?? [])]
    const entry = list.find((s) => s.name === m.server)
    if (!entry) return `未知 MCP server："${m.server}"（用 /mcp servers 查看）。`
    const tools = { ...(entry.tools ?? {}) }
    if (isOn) delete tools[m.tool]
    else tools[m.tool] = false
    await inp.setMcpServers?.([...list.map((s) => (s.name === m.server ? { ...s, tools } : s))])
    return undefined
  }

  const hooks: Hooks = {
    'cli.commands'(input: { commands: Array<{ command: string; description: string; usage?: string }> }) {
      input.commands.push({
        command: 'tools',
        description: '工具管理：查看 / Agent 白名单持久化 / --global 运行时启停 / mcp__ 工具掩码',
        usage:
          '/tools [--all | --json | <toolId> | <toolId> on|off | <toolId> --global on|off]',
      })
    },

    async 'cli.command'(input: CliCommandInput) {
      if (input.command !== 'tools') return
      const inp = input as ToolsCtx
      try {
        const { out, harness } = inp
        const tokens = inp.arg.trim().split(/\s+/).filter(Boolean)
        const hasAll = tokens.includes('--all')
        const hasJson = tokens.includes('--json')
        const isGlobal = tokens.includes('--global')
        const body = tokens.filter((t) => !FLAGS.has(t))

        // 列表视图
        if (body.length === 0) {
          if (hasAll || hasJson) {
            // 合并未加载的运行时工具：以内置静态元信息兜底，保证懒加载时也能看到全部内置工具
            const all = unionTools(harness.tools.list(), inp.toolMeta)
            if (hasJson) {
              out(JSON.stringify(all.map((t) => ({
                id: t.id, description: t.description, aliases: t.aliases,
                isReadOnly: t.isReadOnly ? (typeof t.isReadOnly === 'function' ? (t as Tool).isReadOnly?.(undefined) ?? false : t.isReadOnly) : false,
                isDestructive: t.isDestructive ? (typeof t.isDestructive === 'function' ? (t as Tool).isDestructive?.(undefined) ?? false : t.isDestructive) : false,
                isConcurrencySafe: t.isConcurrencySafe ? (typeof t.isConcurrencySafe === 'function' ? (t as Tool).isConcurrencySafe?.(undefined) ?? false : t.isConcurrencySafe) : false,
                permissionKey: (t as { permission?: { key?: string } }).permission?.key,
              })), null, 2) + '\n')
            } else {
              out(`全局注册 ${all.length} 个工具（含未加载的静态元信息）：\n${renderToolTable(inp, all, disabledMcpServers)}\n`)
            }
            return
          }
          const agentTools = harness.agent.get(inp.agentId)?.tools ?? ['*']
          const usable = agentUsableEntries(inp)
          out(`Agent「${inp.agentId}」可用工具（白名单：${agentTools.join(', ') || '(空)'}）：\n${renderToolTable(inp, usable, disabledMcpServers)}\n`)
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

        // MCP 场景化工具（mcp__<server>__<tool>）：工具掩码统一收口到 /tools，写入 server 级掩码
        if (parseMcpTool(toolArg)) {
          if (!action) {
            out(`MCP 工具：${toolArg}\n  启停语法：/tools ${toolArg} on|off\n`)
            if (mcpServerDown({ id: toolArg } as Tool)) out(`  来源 server 已被 /mcp 禁用，工具当前不可用。\n`)
            return
          }
          const err = await applyMcpMask(inp, toolArg, isOn)
          if (err) { out(`${err}\n`); return }
          await bus?.publish(isOn ? LifecycleEvents.toolEnabled : LifecycleEvents.toolDisabled, { id: toolArg, agentId: inp.agentId }, { source: 'tools-manager' })
          out(`已${isOn ? '启用' : '禁用'} MCP 工具 "${toolArg}"（${isOn ? '清除' : '写入'} server 级掩码，写入 config.json mcpServers[].tools）。\n`)
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
            await bus?.publish(LifecycleEvents.toolEnabled, { id: toolArg, agentId: inp.agentId }, { source: 'tools-manager' })
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
          await bus?.publish(LifecycleEvents.toolDisabled, { id: toolArg, agentId: inp.agentId }, { source: 'tools-manager' })
          out(`已全局禁用工具 "${toolArg}"（影响所有 Agent，本轮进程生效；使用 --global on 恢复）。\n`)
          return
        }

        // 详情视图（无动作）
        if (!action) {
          renderDetail(inp, toolArg)
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
          await bus?.publish(LifecycleEvents.toolEnabled, { id: toolArg, agentId: inp.agentId }, { source: 'tools-manager' })
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
          await bus?.publish(LifecycleEvents.toolDisabled, { id: toolArg, agentId: inp.agentId }, { source: 'tools-manager' })
          return
        }
        await inp.setAgentTools(inp.agentId, cur.filter((id) => id !== toolArg))
        await bus?.publish(LifecycleEvents.toolDisabled, { id: toolArg, agentId: inp.agentId }, { source: 'tools-manager' })
        out(`已禁用工具 "${toolArg}" 并写入 config.json（Agent「${inp.agentId}」白名单）。\n`)
      } finally {
        // 关键：标记命令已处理，避免 cli 因未设 result 而 fallthrough 到"未知命令"
        input.result = 'continue'
      }
    },
  }

  return {
    id: 'tools-manager',
    name: 'Tools Manager',
    version: '0.1.0',
    async install(ctx) {
      bus = ctx.bus
      // 跨层解耦：订阅 mcp / plugin 生命周期事件，刷新「哪些 mcp 工具的来源 server 不可用」
      offs.push(
        bus.subscribe(LifecycleEvents.mcpServerDisabled, ({ payload }) => {
          disabledMcpServers.add(payload.name)
        }),
      )
      offs.push(
        bus.subscribe(LifecycleEvents.mcpServerEnabled, ({ payload }) => {
          disabledMcpServers.delete(payload.name)
        }),
      )
      offs.push(
        bus.subscribe(LifecycleEvents.mcpServerAdded, ({ payload }) => {
          disabledMcpServers.delete(payload.name)
        }),
      )
      offs.push(
        bus.subscribe(LifecycleEvents.pluginUnloaded, ({ payload }) => {
          if (payload.id === 'mcp.server-registry') disabledMcpServers.clear()
        }),
      )
      offs.push(
        bus.subscribe(LifecycleEvents.pluginUpdated, ({ payload }) => {
          if (payload.id === 'mcp.server-registry') disabledMcpServers.clear()
        }),
      )
      return hooks
    },
    async uninstall() {
      for (const off of offs) off()
      offs.length = 0
      bus = undefined
      disabledMcpServers.clear()
    },
  }
}

export default createToolsManagerPlugin