/**
 * 插件**能力面收窄**（P1-5 的"API 白名单"）。
 *
 * ## 它是什么
 * `PluginContext`（`@harness/plugin`）只暴露四条件：`bus` / `config` / `log` / `workspace`。
 * 宿主授予插件的能力，边界**只在这四件上**。所谓"API 白名单"就是：按插件 id 声明它允许拿哪几件，
 * 没声明的通道**取用即抛**（带可执行指引），而不是默默给全套。
 *
 * ## 它不是什么（必须说清）
 * 它**不是安全边界** —— 插件代码仍在宿主进程里，`import('node:fs')` / `import('node:child_process')`
 * 完全不受这里约束。它管的是「**宿主主动递出去的东西**"，属于最小权限的"授予面收窄"，
 * 与 `plugin-scan.ts` 的静态预警是同一层（**预警与收窄，不是墙**）。真墙要 WASI。
 *
 * 默认（`pluginCapabilities` 未声明）⇒ **四件全给**，逐位等于改造前。
 */
import { formatDenial } from '@harness/isolation'
import type { PluginContext } from '@harness/plugin'

/** 可收窄的四条通道 */
export const PLUGIN_CAPABILITIES = ['bus', 'config', 'log', 'workspace'] as const
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

/** 按插件 id 声明的能力表（`'*'` 是默认模板；精确 id 覆盖模板） */
export type PluginCapabilityTable = Record<string, PluginCapability[]>

/**
 * 解析某个插件实际拿到哪些能力。
 *
 * 没声明过 ⇒ `undefined`（调用方据此**原样返回 ctx**，不做 Proxy —— 零开销、
 * 也保证"没配就逐位等于改造前"）。
 */
export function resolvePluginCapabilities(
  pluginId: string,
  table: PluginCapabilityTable | undefined,
): PluginCapability[] | undefined {
  if (!table) return undefined
  if (Object.prototype.hasOwnProperty.call(table, pluginId)) return table[pluginId]
  if (Object.prototype.hasOwnProperty.call(table, '*')) return table['*']
  return undefined
}

/**
 * 按能力表收窄 `PluginContext`。
 *
 * 未声明的通道用 **Proxy 拦访问即抛**（而不是"给个空对象"）：空对象会让插件在**更深的地方**
 * 以更难懂的方式失败（`ctx.bus.on is not a function`），而这里能一次说清"你没声明它、去哪加"。
 */
export function narrowPluginContext(ctx: PluginContext, allowed: PluginCapability[]): PluginContext {
  // 四通道全给 ⇒ **原样返回**（不包 Proxy）：没配就逐位等于改造前，且零开销
  if (allowed.length >= PLUGIN_CAPABILITIES.length) return ctx
  const allow = new Set(allowed)
  const missing = (key: PluginCapability): never => {
    throw new Error(formatDenial({
      what: `插件未获授权使用 \`ctx.${key}\``,
      why: `config.json → sandbox.pluginCapabilities 里没有给它 \`${key}\`（授予面收窄，最小权限）。`,
      how: `在该插件 id（或 "*" 模板）的能力数组里加上 "${key}"，可选值：${PLUGIN_CAPABILITIES.join(' / ')}。`,
    }))
  }
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && (PLUGIN_CAPABILITIES as readonly string[]).includes(prop)) {
        if (!allow.has(prop as PluginCapability)) missing(prop as PluginCapability)
      }
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      if (typeof prop === 'string' && (PLUGIN_CAPABILITIES as readonly string[]).includes(prop)) {
        return allow.has(prop as PluginCapability)
      }
      return Reflect.has(target, prop)
    },
  })
}

/** 最小形状：只要 `id` 与 `install`（避免这里依赖 AgentPlugin 的具体声明） */
interface Installable {
  id: string
  install: (ctx: PluginContext) => Promise<unknown> | unknown
}

/**
 * 把"能力表"套到插件上：**包装 `install`**，把收窄后的 ctx 递进去。
 *
 * 为什么在宿主侧包装而不是改 core：`install(ctx)` 由 core 的 PluginManager 调用，而
 * **能力表是宿主的配置语义**（`config.sandbox.pluginCapabilities`）。让 core 认识它，
 * 等于把宿主策略下沉进内核 —— 与本仓"layer 各管各的"纪律相悖。
 */
export function applyPluginCapabilities<P extends Installable>(
  plugin: P,
  table: PluginCapabilityTable | undefined,
): P {
  const allowed = resolvePluginCapabilities(plugin.id, table)
  if (!allowed || allowed.length === PLUGIN_CAPABILITIES.length) return plugin
  const original = plugin.install
  return {
    ...plugin,
    install: (ctx: PluginContext) => original.call(plugin, narrowPluginContext(ctx, allowed)),
  }
}

/** 装配期人读清单：把"授予了什么"摆出来（可观测，否则收窄了也没人知道） */
export function formatCapabilityGrant(pluginId: string, allowed: PluginCapability[] | undefined): string {
  if (!allowed) return `${pluginId}：未声明 ⇒ 四通道全给（与改造前一致）`
  const denied = PLUGIN_CAPABILITIES.filter((c) => !allowed.includes(c))
  return `${pluginId}：授予 ${allowed.length ? allowed.join(' / ') : '（无）'}${
    denied.length ? `；未授予 ${denied.join(' / ')}（取用即抛）` : ''
  }`
}
