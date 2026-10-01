/**
 * @harness/host —— 宿主装配层
 *
 * 目标（`docs/external-integration-plan.md` §6 P0）：CLI / TUI / headless 与将来的
 * A2A server、VSCode 扩展**共用同一份装配**，避免"两份装配必然分叉"。
 * 本包只做装配与注入，不内置业务决策、不绕过权限、不直接调工具。
 *
 * ## 为什么先搬这一块（`loadPluginDirs` 簇）
 *
 * P0 原计划把 6 个符号一次性搬走，实测闭包后发现它们的可搬性分三档：
 *
 * | 档 | 符号 | 闭包情况 |
 * |---|---|---|
 * | **A（本文件）** | `loadPluginDirs` + `PluginLoadResult` + `probeAgentPlugin` + `collectAgentPlugins` + `registerProviderTypeFactory` | **自足**：只依赖 `@harness/plugin` 的类型与 `@harness/workspace` 的 `MultiDirLoader`/`normalizeDirs`。且这是 A2A 宿主**必需**的能力（要能加载用户插件） |
 * | B | `buildProviderWindowTable` | 连着 cli 的 config 解析层（`normalizeProviderConfigs` / `resolveContextWindowTokens` / `HarnessConfig`），这些在 cli 别处大量复用 |
 * | C | `BuiltinPluginRegistry` / `getBuiltinRegistry` / `resolveBuiltinPlugins` / `preloadBuiltinToolMetas` | 连着 `lazyImport`（cli 内 27 处使用）与 `BuiltinToolRegistry`（8 处），一次搬走等于把启动基建整块上移 |
 *
 * ⇒ 先搬 A 档验证"新包 + cli re-export 兼容"这条机制（`cli.test.ts` 直接 `import` 这些符号，
 * 搬走必须保持导出面不变），再分两步收 B / C 档。
 */

import { pathToFileURL } from 'node:url'
import type { AgentPlugin, ProviderConfig, ProviderTypeRegistry } from '@harness/plugin'
import { MultiDirLoader, normalizeDirs } from '@harness/workspace'

/** 插件目录加载结果：通用 AgentPlugin（Hooks 插件）列表；Provider 类型工厂已注册进 registry */
export interface PluginLoadResult {
  /** 从插件目录加载出的通用 AgentPlugin（非 Provider 专用，参与 Hooks 生命周期） */
  plugins: AgentPlugin[]
}

/** 探测一个值是否为合法的 AgentPlugin（id + install） */
const probeAgentPlugin = (o: unknown): AgentPlugin | null => {
  if (!o || typeof o !== 'object') return null
  const x = o as Record<string, unknown>
  if (typeof x['id'] === 'string' && typeof x['install'] === 'function') return x as unknown as AgentPlugin
  return null
}

/** 从模块导出中提取通用 AgentPlugin（default / plugin / plugins 三种形态，含一层 default 包装） */
export function collectAgentPlugins(mod: Record<string, unknown>): AgentPlugin[] {
  const out: AgentPlugin[] = []
  const push = (o: unknown): void => {
    if (Array.isArray(o)) { for (const item of o) push(item); return }
    const p = probeAgentPlugin(o)
    if (p) out.push(p)
  }
  push(mod.default)
  push(mod.plugin)
  push(mod.plugins)
  // 兼容 default 里再包一层命名导出
  if (mod.default && typeof mod.default === 'object') {
    const d = mod.default as Record<string, unknown>
    push(d.plugin)
    push(d.plugins)
  }
  return out
}

/** 从模块导出中提取 Provider 类型工厂并注册（providerTypeFactory 或 providerType + createProviderPlugin） */
export function registerProviderTypeFactory(
  registry: ProviderTypeRegistry,
  mod: Record<string, unknown>,
  full: string,
  out: (s: string) => void,
): void {
  // 该模块已导出通用 AgentPlugin → 是「通用插件」，无需因缺少 Provider 工厂而报警告
  if (collectAgentPlugins(mod).length > 0) return
  const defaultHolder = (mod.default && typeof mod.default === 'object' ? mod.default : {}) as Record<string, unknown>
  const holders = [mod, defaultHolder] as const
  for (const holder of holders) {
    const factory = holder.providerTypeFactory as
      | { type?: string; createPlugin?: (config: ProviderConfig) => AgentPlugin | undefined }
      | undefined
    if (factory && typeof factory.type === 'string' && typeof factory.createPlugin === 'function') {
      registry.register({ type: factory.type, createPlugin: factory.createPlugin })
      return
    }
    const type = holder.providerType as string | undefined
    const createPlugin = holder.createProviderPlugin as ((config: ProviderConfig) => AgentPlugin | undefined) | undefined
    if (typeof type === 'string' && typeof createPlugin === 'function') {
      registry.register({ type, createPlugin })
      return
    }
  }
  out(`插件模块既未导出通用 AgentPlugin 也未导出有效 Provider 类型工厂，已忽略：${full}`)
}

/**
 * 从多级目录加载外部插件（user → project，后加载覆盖先加载）。
 * 插件目录统一为 plugins，一个 .ts/.js/.mjs 模块可同时导出多种插件：
 *   1. 通用 AgentPlugin（Hooks 插件）：default / plugin / plugins
 *   2. Provider 类型工厂（扩展 config.type）：providerTypeFactory 或 providerType + createProviderPlugin
 * 通用插件汇总返回；Provider 类型工厂按 type 注册进 registry（供 config.type 动态解析）。
 *
 * ## 安全：插件代码默认不加载
 * 插件目录里的 `.ts/.js/.mjs` 是**可执行代码**。若无条件 `import()`，那么克隆一个带
 * `.harness/plugins/*.ts` 的仓库、在该目录里跑一次 harness 就会执行他人代码（代码注入）。
 * 故默认**只扫描不加载**：`opts.allowCode` 为 false 时仅告警并返回空。真正需要扩展能力时二选一：
 *   1. **声明式启用内置插件**（推荐，零代码）：`config.json → "plugins": ["code-intel"]`；
 *   2. **显式开闸**：`config.json → "allowPluginCode": true` 或启动参数 `--allow-plugin-code`。
 *
 * ## 安全：不为插件目录补任何 node_modules 软链
 * 曾实现过「裸依赖解析不到就软链到 harness 内核的 node_modules」，已移除：那等于把 harness
 * 内核的整棵依赖树暴露给工作目录下的任意文件（且软链会被写进用户仓库、被提交、还可能悬空）。
 * 裸依赖解析不到就是解析不到——自定义插件应放在能解析到其依赖的位置。
 */
export async function loadPluginDirs(
  registry: ProviderTypeRegistry,
  dirs: Array<string | { dir: string; source?: 'user' | 'project' }>,
  log?: (s: string) => void,
  opts: { allowCode?: boolean } = {},
): Promise<PluginLoadResult> {
  const out = log ?? ((s: string) => { if (typeof process !== 'undefined') process.stderr.write(s + '\n') })
  // 枚举交给通用多级目录加载器（workspace 收敛「scan + 来源标注」），来源顺序 user → project
  const items = new MultiDirLoader(normalizeDirs(dirs)).scan({ name: (n) => /\.(ts|js|mjs)$/.test(n) })
  // 默认闸门：代码注入防护 —— 只登记文件、不执行
  if (!opts.allowCode) {
    if (items.length) {
      out(`已跳过 ${items.length} 个插件代码文件（默认不加载外部插件代码，防止代码注入）：\n`)
      for (const it of items.slice(0, 5)) out(`  - ${it.full}\n`)
      if (items.length > 5) out(`  …… 其余 ${items.length - 5} 个\n`)
      out('  启用内置能力请改用 config.json → "plugins": ["code-intel"]（零代码，推荐）；\n')
      out('  确需加载自定义插件代码时，设置 config.json → "allowPluginCode": true 或启动参数 --allow-plugin-code。\n')
    }
    return { plugins: [] }
  }
  // 通用插件按 id 去重：后加载覆盖先加载（project 覆盖 user，扫描顺序即覆盖顺序）
  const byId = new Map<string, AgentPlugin>()
  for (const item of items) {
    const full = item.full
    try {
      const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>
      // 1) 通用 AgentPlugin
      for (const p of collectAgentPlugins(mod)) byId.set(p.id, p)
      // 2) Provider 类型工厂
      registerProviderTypeFactory(registry, mod, full, out)
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      out(`插件加载失败 ${full}：${msg}\n`)
      if (/Cannot find (?:module|package)\s+["']/.test(msg)) {
        out('  （该插件目录无法解析裸依赖：请把它放在能解析到依赖的位置；或改用 config.json → "plugins" 声明式启用内置能力）\n')
      }
    }
  }
  return { plugins: [...byId.values()] }
}
