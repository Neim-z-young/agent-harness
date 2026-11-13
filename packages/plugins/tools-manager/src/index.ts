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
 * 作用域 B 在插件内部缓存被卸载的 Tool 以便 on 时恢复；插件 uninstall 时把缓存里的工具
 * 还回注册池 —— 否则"本轮进程生效"会变成"直到重启"。
 *
 * 三个刻意的拒绝（都不是静默忽略）：
 *   · 未知选项（`--nope`）⇒ 直接报"未知选项"，不当成 toolId 去查（写错一个字母时提示才有用）
 *   · `mcp__` 工具 + `--global` ⇒ 拒绝：它的启停是写入 config.json 的 server 级掩码（跨进程持久），
 *     与 `--global` 的"进程级、易失"语义相反
 *   · `<toolId> on` 且 id 既未注册也不在内置元信息里 ⇒ 拒绝，不把拼错的 id 写进 config.json
 */

import type { CliCommandInput, AgentPlugin, Hooks, ToolMetaEntry, ToolMetaLookup } from '@harness/plugin'
import { globalMcpToolIndex, resolveMcpTool, supplyMcpTools, formatToolWhitelist, type Tool } from '@harness/tool'
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
    get(agentId: string): {
      id: string
      tools: string[]
      /** MCP server 声明：非空数组 = 供给这些 server 的全部工具（与 core 装配同一判据） */
      mcpServers?: string[]
      excludeMcpServers?: string[]
    } | undefined
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

/** 通配白名单字面量（`tools: ['*']` = 全部允许），冻结以免被调用方就地改写 */
const WILDCARD_WHITELIST: readonly string[] = Object.freeze(['*'])

/**
 * `tools: ['*']` 的唯一判据。
 * 全文件曾有 3 处手写同一个表达式（列表视图 / 状态列 / 命令分支），
 * 只要有一处漏改，就会出现「列表说全部允许、off 却按显式白名单删」这类自相矛盾。
 */
function isWildcardWhitelist(list: readonly string[]): boolean {
  return list.length === 1 && list[0] === '*'
}

/** MCP 工具 id → { server, tool }。走 @harness/tool 的共享解析：优先用
 * globalMcpToolIndex 精确反解（server 名可含 __），未登记时回退启发式切分。 */
function mcpToolOf(id: string): { server: string; tool: string } | undefined {
  return resolveMcpTool(id, globalMcpToolIndex)
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

/** 当前 Agent 的白名单（缺省 = 全部允许）。全文件唯一取白名单的入口 —— 4 处曾各写一遍 `?? ['*']` */
function agentWhitelist(inp: ToolsCtx): readonly string[] {
  return inp.harness.agent.get(inp.agentId)?.tools ?? WILDCARD_WHITELIST
}

/** 合并「已加载运行时工具 + 内置静态元信息兜底」：未加载的内置工具也能展示，标记 (meta) */
function unionTools(loaded: Tool[], meta: ToolMetaLookup | undefined): Array<Tool | ToolMetaEntry> {
  const result: Array<Tool | ToolMetaEntry> = [...loaded]
  appendUnseen(result, meta?.list() ?? [])
  return result
}

/**
 * 按 id 去重追加：`candidates` 中未被现有 id 覆盖的项补到末尾（保持传入顺序）。
 * 两处（{@link unionTools} 与 {@link agentUsableEntries} 的显式白名单分支）曾各手写一遍
 * seen 集合循环，重复实现的下场是其中一处忘了 `seen.add` 就会重复出行。
 */
function appendUnseen(
  target: Array<Tool | ToolMetaEntry>,
  candidates: Iterable<Tool | ToolMetaEntry>,
): void {
  const seen = new Set(target.map((x) => x.id))
  for (const c of candidates) {
    if (seen.has(c.id)) continue
    target.push(c)
    seen.add(c.id)
  }
}

/**
 * Agent 最终可用工具（**与 core 装配同一判据**）：
 * `filterByWhitelist(agent.tools)` 定原生部分，再由 `supplyMcpTools` 在注册表全量上
 * 补齐 agent 声明的 `mcpServers` 的全部工具。
 *
 * 为什么必须共用同一个函数：`/tools` 展示的是"模型能调什么"。若这里只按 `filterByWhitelist`
 * 算，声明了 `mcpServers: ['gh']` 的 agent 会被显示成「拿不到 gh 工具」，
 * 而实际执行已经能调 —— 展示与执行两套判据，用户就没法信任其中任何一套。
 */
function agentAllowedTools(inp: ToolsCtx): Tool[] {
  const def = inp.harness.agent.get(inp.agentId)
  const whitelist = agentWhitelist(inp)
  // `tools: []`（"一个都不给"）是绝对逃生口，连 MCP 供给一并关掉 —— 与 core 装配同一判据
  if (whitelist.length === 0) return []
  return supplyMcpTools(
    inp.harness.tools.filterByWhitelist(whitelist as string[] | ['*']),
    inp.harness.tools.list(),
    def?.mcpServers,
    def?.excludeMcpServers,
  )
}

/** 上述结果的 id 集合（表格按行查状态用；一次算好，避免逐行重算） */
function agentAllowedIds(inp: ToolsCtx): Set<string> {
  return new Set(agentAllowedTools(inp).map((t) => t.id))
}

/**
 * 计算 Agent 的全部可用工具（不受懒加载影响）：
 * 「已加载且在白名单内的运行时工具」+「白名单内未加载的静态元信息」。
 * 通配（*）白名单时补全部静态元信息；显式白名单时仅补白名单内未加载的工具。
 * 这样 /tools 列表在懒加载期间也能完整呈现 Agent 可用工具及其描述/状态。
 */
function agentUsableEntries(inp: ToolsCtx): Array<Tool | ToolMetaEntry> {
  const agentTools = agentWhitelist(inp)
  const loaded = agentAllowedTools(inp)
  const meta = inp.toolMeta
  // 全允许：补全部静态元信息
  if (isWildcardWhitelist(agentTools)) return unionTools(loaded, meta)
  if (!meta) return loaded
  const result: Array<Tool | ToolMetaEntry> = [...loaded]
  appendUnseen(result, agentTools.flatMap((id) => {
    const m = meta.get(id)
    return m ? [m] : []
  }))
  return result
}

/**
 * 权限键（未声明 = undefined）。
 * 运行时 Tool 放在 `permission.key`，静态元信息放在顶层 `permissionKey` —— 两个来源必须在这里
 * 合流；`--json` 曾自己取 `permission?.key`，于是「表格里有权限键、JSON 里字段直接消失」。
 */
function permissionKeyOf(t: Tool | ToolMetaEntry): string | undefined {
  // 两侧都用断言取：联合类型上直接读 `permissionKey` 不成立（Tool 不声明该字段），
  // 而 `isMetaEntry()` 的类型谓词会把另一支收窄成 never —— 断言比"看似更类型安全"的写法可靠。
  return (t as Tool).permission?.key ?? (t as ToolMetaEntry).permissionKey
}

/** 权限键的展示形态（缺省用 `-` 占位，避免表格列错位） */
function permKeyOf(t: Tool | ToolMetaEntry): string {
  return permissionKeyOf(t) ?? '-'
}

/**
 * 状态串：启用/禁用（相对当前 Agent 白名单）+ 加载状态（已加载 / 仅元信息）。
 * 未加载的元信息占位：仅在 Agent 白名单为通配 *（或显式列出）时视为启用，否则为禁用。
 * `allowedIds` 由 {@link agentAllowedIds} 一次算好传入 —— 已加载的工具必须用它判，
 * 才能与 core 的装配判据（含 MCP server 供给）保持一致；`wildcard` 同样由调用方算一次，
 * 否则每行都要重新取一次 agent 定义（表长 n 就是 n 次）。
 */
function entryStatus(
  t: Tool | ToolMetaEntry,
  allowedIds: Set<string>,
  whitelist: readonly string[],
  wildcard: boolean,
): string {
  const metaOnly = isMetaEntry(t)
  const enabled = metaOnly
    ? (wildcard || whitelist.includes(t.id))              // 未加载的占位只能按显式白名单判
    : allowedIds.has(t.id)                               // 已加载 ⇒ 与装配同源
  return `${enabled ? '启用' : '禁用'}·${metaOnly ? '仅元信息' : '已加载'}`
}

/** 渲染工具表格：ID | 元信息(描述) | 权限键 | 状态（启用·加载·安全） */
function renderToolTable(inp: ToolsCtx, entries: Array<Tool | ToolMetaEntry>, mcpDownServer?: Set<string>): string {
  const allowedIds = agentAllowedIds(inp)
  // 白名单与通配判定各算一次：entryStatus 逐行再取一次 agent 定义是纯重复 I/O
  const whitelist = agentWhitelist(inp)
  const wildcard = isWildcardWhitelist(whitelist)
  const rows = entries.map((t) => {
    const { readOnly, destructive, concurrent } = entryFlags(t)
    const safety = [...(readOnly ? ['只读'] : []), ...(destructive ? ['危险'] : []), ...(concurrent === false ? ['非并发'] : [])]
    const base = entryStatus(t, allowedIds, whitelist, wildcard)
    let status = safety.length ? `${base}·${safety.join(',')}` : base
    if (t.id.startsWith('mcp__')) {
      // MCP 场景化工具：标注来源 server；server 已被 /mcp 禁用时状态改为「禁用」并额外标注
      const m = mcpToolOf(t.id)
      if (m) {
        const down = mcpDownServer?.has(m.server)
        if (down) status = status.replace(/^启用/, '禁用') // 禁用态优先于 Agent 白名单判定
        status += `·源自mcp${down ? '·server已禁用' : ''}`
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

/** 详情视图的安全声明文本（首项恒为 只读/可写，故不存在"全空"情形） */
function formatSafety(t: Tool | ToolMetaEntry): string {
  const { readOnly, destructive, concurrent } = entryFlags(t)
  return [
    readOnly ? '只读' : '可写',
    destructive ? '危险' : '',
    concurrent === false ? '非并发' : '',
  ].filter(Boolean).join(' / ')
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
  const enabled = agentAllowedIds(inp).has(t.id)
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
  /**
   * 最近一条命令看到的工具池。`--global off` 的语义是「本轮进程生效」，插件被卸载时
   * 本轮就结束了 —— 若不在这里恢复，`suspended` 会跟着实例一起消失，注册池永久少一个工具，
   * 用户只能重启进程才能拿回来（文档承诺的"本轮"变成了"直到重启"）。
   */
  let toolsRegistry: HarnessView['tools'] | undefined

  /** 发布 tool.enabled / tool.disabled 的唯一入口（此前 6 处各写一遍同样的 payload 与 source） */
  async function emitToolLifecycle(id: string, agentId: string, enabled: boolean): Promise<void> {
    await bus?.publish(
      enabled ? LifecycleEvents.toolEnabled : LifecycleEvents.toolDisabled,
      { id, agentId },
      { source: 'tools-manager' },
    )
  }

  /** 判定某工具是否来自「已被 /mcp 禁用的 server」 */
  function mcpServerDown(t: Tool | ToolMetaEntry): boolean {
    const m = mcpToolOf(t.id)
    return !!m && disabledMcpServers.has(m.server)
  }

  /**
   * 工具掩码统一收口到 /tools：对 mcp__<server>__<tool> 写入/删除 server 级掩码
   * config.json mcpServers[].tools。on→删除键（全开）；off→tools[tool]=false。
   * 返回错误字符串（undefined 表示成功）。
   */
  async function applyMcpMask(inp: ToolsCtx, id: string, isOn: boolean): Promise<string | undefined> {
    const m = mcpToolOf(id)
    if (!m) return undefined
    const list = [...(inp.mcpServers ?? [])]
    const entry = list.find((s) => s.name === m.server)
    if (!entry) return `未知 MCP server："${m.server}"（用 /mcp servers 查看）。`
    // `setMcpServers` 是可选注入：宿主没给就只能空转。此前 `await inp.setMcpServers?.(…)`
    // 会成功返回 undefined，于是命令照样打印"已写入 config.json" —— 用户以为改生效了，重启才发现没变。
    if (!inp.setMcpServers) return '当前宿主未提供 config.json 写入能力，无法持久化 MCP 工具掩码（本次未做任何改动）。'
    const tools = { ...(entry.tools ?? {}) }
    if (isOn) delete tools[m.tool]
    else tools[m.tool] = false
    await inp.setMcpServers([...list.map((s) => (s.name === m.server ? { ...s, tools } : s))])
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
        // 记下工具池：uninstall 时靠它把 `--global off` 卸下的工具还回去（见 toolsRegistry 注释）
        toolsRegistry = harness.tools
        const tokens = inp.arg.trim().split(/\s+/).filter(Boolean)
        // 未知选项必须在解析阶段拦下：以前 `--nope` 会被当成工具 id，
        // 用户写错一个字母，得到的是「工具 "--nope" 未找到（先看 /tools --all 确认 id）」——
        // 把人指向一个根本不存在的地方，比什么都不说更糟。
        const unknownOpts = tokens.filter((t) => t.startsWith('-') && !FLAGS.has(t))
        if (unknownOpts.length) {
          out(`未知选项：${unknownOpts.join(' ')}（支持 ${[...FLAGS].join(' / ')}）。\n`)
          return
        }
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
              // 三个安全位与权限键都走 entryFlags / permissionKeyOf —— 这段曾经手抄一遍三元链，
              // 结果只有它丢了 permissionKey 的 meta 回退（表格显示 read、JSON 里字段直接消失）。
              out(JSON.stringify(all.map((t) => {
                const { readOnly, destructive, concurrent } = entryFlags(t)
                return {
                  id: t.id,
                  description: t.description,
                  aliases: t.aliases,
                  isReadOnly: readOnly,
                  isDestructive: destructive,
                  isConcurrencySafe: concurrent,
                  permissionKey: permissionKeyOf(t),
                }
              }), null, 2) + '\n')
            } else {
              out(`全局注册 ${all.length} 个工具（含未加载的静态元信息）：\n${renderToolTable(inp, all, disabledMcpServers)}\n`)
            }
            return
          }
          const usable = agentUsableEntries(inp)
          out(`Agent「${inp.agentId}」可用工具（白名单：${formatToolWhitelist([...agentWhitelist(inp)])}）：\n${renderToolTable(inp, usable, disabledMcpServers)}\n`)
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
        if (mcpToolOf(toolArg)) {
          // 掩码写的是 config.json（持久、跨进程），`--global` 写的是本轮注册池（进程级、易失）——
          // 两者语义相反。此前 --global 在这一支被整个忽略，用户要的是"本轮别给我"，得到的是"永久关掉"。
          if (isGlobal) {
            out(`MCP 工具不支持 --global：它的启停是写入 config.json 的 server 级掩码（跨进程持久）。\n`
              + `  本轮临时停用请改 server 粒度：/mcp disable ${mcpToolOf(toolArg)?.server}；\n`
              + `  只想持久屏蔽该工具请用：/tools ${toolArg} off\n`)
            return
          }
          if (!action) {
            out(`MCP 工具：${toolArg}\n  启停语法：/tools ${toolArg} on|off\n`)
            if (mcpServerDown({ id: toolArg } as Tool)) out(`  来源 server 已被 /mcp 禁用，工具当前不可用。\n`)
            return
          }
          const err = await applyMcpMask(inp, toolArg, isOn)
          if (err) { out(`${err}\n`); return }
          await emitToolLifecycle(toolArg, inp.agentId, isOn)
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
            await emitToolLifecycle(toolArg, inp.agentId, true)
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
          await emitToolLifecycle(toolArg, inp.agentId, false)
          out(`已全局禁用工具 "${toolArg}"（影响所有 Agent，本轮进程生效；使用 --global on 恢复）。\n`)
          return
        }

        // 详情视图（无动作）
        if (!action) {
          renderDetail(inp, toolArg)
          return
        }

        // 作用域 A：Agent 白名单增删 + 持久化
        const cur = agentWhitelist(inp)
        const wildcard = isWildcardWhitelist(cur)
        if (isOn) {
          if (wildcard || cur.includes(toolArg)) {
            out(`工具 "${toolArg}" 已在 Agent「${inp.agentId}」白名单中（${wildcard ? '默认全部允许' : '已显式启用'}）。\n`)
            return
          }
          // 既不在注册池也不在内置元信息里 ⇒ 几乎一定是拼错。以前照样写进 config.json 并报"已启用"，
          // 那条记录此后永远留在白名单里，而对应工具一天都不会出现。
          if (!harness.tools.get(toolArg) && !inp.toolMeta?.get(toolArg)) {
            out(`工具 "${toolArg}" 不存在（既未注册，也不在内置元信息中），未写入白名单。先用 /tools --all 确认 id。\n`)
            return
          }
          await inp.setAgentTools(inp.agentId, [...cur, toolArg])
          await emitToolLifecycle(toolArg, inp.agentId, true)
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
          await emitToolLifecycle(toolArg, inp.agentId, false)
          return
        }
        await inp.setAgentTools(inp.agentId, cur.filter((id) => id !== toolArg))
        await emitToolLifecycle(toolArg, inp.agentId, false)
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
      // registry 插件被卸载 / 热更新 ⇒ 它缓存的"哪些 server 被禁用"已过期，整体清空。
      // 两个事件的处理体逐字相同，收敛成一个函数（否则改一处忘一处就是半个语义）。
      const clearOnRegistryReload = (payload: { id: string }) => {
        if (payload.id === 'mcp.server-registry') disabledMcpServers.clear()
      }
      offs.push(bus.subscribe(LifecycleEvents.pluginUnloaded, ({ payload }) => clearOnRegistryReload(payload)))
      offs.push(bus.subscribe(LifecycleEvents.pluginUpdated, ({ payload }) => clearOnRegistryReload(payload)))
      return hooks
    },
    async uninstall() {
      for (const off of offs) off()
      offs.length = 0
      bus = undefined
      disabledMcpServers.clear()
      // 把 `--global off` 卸下的工具还回注册池：插件卸载 = 本插件"本轮"结束，
      // 若把 Tool 留在这个即将被丢弃的 Map 里，工具就永久消失（只能重启进程恢复）。
      // 已被别处重新注册的同 id 不动（`get` 有值即跳过），避免覆盖别人的实现。
      if (toolsRegistry) {
        for (const [id, tool] of suspended) {
          if (!toolsRegistry.get(id)) toolsRegistry.register(tool)
        }
        toolsRegistry = undefined
      }
      suspended.clear()
    },
  }
}

export default createToolsManagerPlugin