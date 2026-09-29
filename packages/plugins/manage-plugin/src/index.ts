/**
 * @harness/manage-plugin
 *
 * 插件生命周期管理插件：通过 `cli.commands` / `cli.command` 提供 REPL `/plugins` 命令。
 *
 * 命令单一职责：`/plugins` 只管插件生命周期（list / enable / disable / reload）。
 * 启停成功后通过 harness.bus 发布 `plugin.*` 事件（LifecycleEvents）。下层
 * （mcp-server-registry / tools-manager 等）在 install 订阅事件自行刷新，
 * 不再由本命令直接修改下层的内部状态——实现「上层命令变更对下层的跨层解耦」。
 *
 * CLI 注入（cmdInput 扩展字段，见 CliCommandInput harness/manageablePlugin/pluginManageable）：
 *   harness: HarnessView
 *             .plugin.list()             已加载插件列表
 *             .plugin.unload(id)         禁用
 *             .plugin.loadInternal([obj])启用（重新安装原始对象）
 *             .plugin.hotReload(id)      重载
 *             .bus.publish(...)          发布生命周期事件
 *   manageablePlugin: (id) => AgentPlugin | undefined   enable/reload 需要的原始插件对象
 *   pluginManageable: (id) => boolean                  list 展示「可管理」判定
 */

import type { AgentPlugin, Hooks, CliCommandInput, LoadedPlugin } from '@harness/plugin'
import type { Bus } from '@harness/bus'
import { LifecycleEvents } from '@harness/core'

/** cli 注入的 harness 能力视图（由消费侧类型化 harness?: unknown） */
interface HarnessView {
  plugin: {
    list(): LoadedPlugin[]
    unload(pluginId: string): Promise<void>
    loadInternal(plugins: AgentPlugin[]): Promise<void>
    hotReload(pluginId: string): Promise<void>
  }
  bus: Bus
  /**
   * 注册表视图（可选）：`/plugins` 顺带报「注册了多少实例」。
   *
   * 为什么值得单独报：**装了什么插件**与**注册了什么实例**是两个问题 —— 插件装了可能
   * 一个实例都没注册（optIn 未触发 / 装配失败），反过来一个插件也能注册多个实例
   * （同一类型的多个端点）。只列插件时这两类偏差都不可见。
   *
   * 可选是因为老宿主 / 测试桩只注入 plugin + bus，缺了就不报这一行（而不是报 0 条）。
   */
  providers?: { list(): Array<{ id: string; source?: string; isDefault?: boolean }> }
  agent?: { list(): Array<{ id: string }> }
}

type PluginsCtx = Omit<CliCommandInput, 'harness'> & {
  harness: HarnessView
  manageablePlugin: (id: string) => AgentPlugin | undefined
  pluginManageable: (id: string) => boolean
  /** 全部「已登记可管理」插件（含未加载的，供 list 展示并支持 enable 恢复） */
  availablePlugins?: () => Array<{ id: string; name: string; version: string }>
}

/** 执行一个生命周期动作，返回错误字符串（undefined 表示成功） */
async function runAction(inp: PluginsCtx, op: 'enable' | 'disable' | 'reload', id: string): Promise<string | undefined> {
  switch (op) {
    case 'disable': {
      if (!inp.pluginManageable(id)) return `插件 "${id}" 不受管理（内置/未登记插件不可禁用）。`
      try {
        await inp.harness.plugin.unload(id)
      } catch (err: unknown) {
        return `禁用插件 "${id}" 失败：${(err as Error)?.message ?? String(err)}`
      }
      await inp.harness.bus.publish(LifecycleEvents.pluginUnloaded, { id }, { source: 'manage-plugin' })
      return undefined
    }
    case 'enable': {
      const obj = inp.manageablePlugin(id)
      if (!obj) return `插件 "${id}" 不受管理（内置/未登记插件不可启用）。`
      if (inp.harness.plugin.list().some((p) => p.plugin.id === id)) return `${id} 已是启用状态。`
      try {
        await inp.harness.plugin.loadInternal([obj])
      } catch (err: unknown) {
        return `启用插件 "${id}" 失败：${(err as Error)?.message ?? String(err)}`
      }
      await inp.harness.bus.publish(LifecycleEvents.pluginLoaded, { id }, { source: 'manage-plugin' })
      return undefined
    }
    case 'reload': {
      if (!inp.harness.plugin.list().some((p) => p.plugin.id === id)) return `插件 "${id}" 未加载。`
      try {
        await inp.harness.plugin.hotReload(id)
      } catch (err: unknown) {
        return `重载插件 "${id}" 失败：${(err as Error)?.message ?? String(err)}`
      }
      await inp.harness.bus.publish(LifecycleEvents.pluginUpdated, { id }, { source: 'manage-plugin' })
      return undefined
    }
  }
}

export function createPluginManagerPlugin(): AgentPlugin {
  const hooks: Hooks = {
    'cli.commands'(input: { commands: Array<{ command: string; description: string; usage?: string }> }) {
      input.commands.push({
        command: 'plugins',
        description: '插件生命周期管理：查看 / 启用 / 禁用 / 重载',
        usage: '/plugins [enable <id> | disable <id> | reload <id>]',
      })
    },

    async 'cli.command'(input: CliCommandInput) {
      if (input.command !== 'plugins') return
      const inp = input as PluginsCtx
      const { out } = inp
      const parts = inp.arg.trim().split(/\s+/).filter(Boolean)
      const op = parts[0]
      const pid = parts[1]

      if (!op || !pid || !['enable', 'disable', 'reload'].includes(op ?? '')) {
        // 合并「已加载」与「已登记未加载」插件：禁用后仍可见、可重新启用
        const loaded = new Map(inp.harness.plugin.list().map((lp) => [lp.plugin.id, lp]))
        const metas = new Map<string, { name: string; version: string }>()
        for (const p of inp.availablePlugins?.() ?? []) metas.set(p.id, p)
        for (const [id, lp] of loaded) {
          if (!metas.has(id)) metas.set(id, { name: lp.plugin.name, version: lp.plugin.version })
        }
        if (metas.size === 0) {
          out('（未加载任何插件）\n')
        } else {
          for (const [id, meta] of metas) {
            const lp = loaded.get(id)
            const manage = inp.pluginManageable(id) ? '可管理' : '内置'
            const state = lp ? '已加载' : '已禁用'
            out(`  ${id.padEnd(28)}${meta.name}  v${meta.version}  来源=${lp?.source ?? '未加载'}  [${manage}·${state}]\n`)
          }
        }
        // 已注册实例（视图存在才报）：与插件清单是两个维度，见 HarnessView.providers 注释
        const provs = inp.harness.providers?.list?.()
        if (provs) {
          const def = provs.find((p) => p.isDefault)?.id
          const items = provs.map((p) => (p.id === def ? `${p.id}(默认)` : p.id)).join(' / ')
          out(`已注册 Provider 实例 ${provs.length}${items ? `：${items}` : ''}\n`)
        }
        const agents = inp.harness.agent?.list?.()
        if (agents) {
          out(`已注册 Agent ${agents.length}${agents.length ? `：${agents.map((a) => a.id).join(' / ')}` : ''}\n`)
        }
        out('用法：/plugins <enable|disable|reload> <pluginId>\n')
        input.result = 'continue'
        return
      }

      const action = op as 'enable' | 'disable' | 'reload'
      const err = await runAction(inp, action, pid)
      out((err ? err : `${action === 'reload' ? '已重载' : `已${action === 'enable' ? '启用' : '禁用'}插件`} "${pid}"。`) + '\n')
      input.result = 'continue'
    },
  }

  return {
    id: 'manage-plugin',
    name: 'Plugin Manager',
    version: '0.1.0',
    description: '插件生命周期管理命令 /plugins（查看 / 启用 / 禁用 / 重载）',
    async install() {
      return hooks
    },
  }
}

export default createPluginManagerPlugin