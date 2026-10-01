/**
 * @harness/host —— 宿主装配层
 *
 * 目标（`docs/external-integration-plan.md` §6 P0）：CLI / TUI / headless 与将来的
 * A2A server、VSCode 扩展**共用同一份装配**，避免"两份装配必然分叉"。
 * 本包只做装配与注入，不内置业务决策、不绕过权限、不直接调工具。
 *
 * ## 搬迁进度：P0 原清单实测分三档（不是"六个符号一次搬完"）
 *
 * | 档 | 符号 | 闭包情况 | 状态 |
 * |---|---|---|---|
 * | **A** | `loadPluginDirs` + `PluginLoadResult` + `probeAgentPlugin` + `collectAgentPlugins` + `registerProviderTypeFactory` | **自足**：只依赖 `@harness/plugin` 的类型与 `@harness/workspace` 的 `MultiDirLoader`/`normalizeDirs`。且这是 A2A 宿主**必需**的能力（要能加载用户插件） | ✅ 已搬（§1） |
 * | **C** | `registerBuiltinProviderTypes` + `BuiltinPluginRegistry` / `getBuiltinRegistry` / `unknownBuiltinPluginIds` / `resolveBuiltinPlugins` + `BuiltinToolRegistry` / `getBuiltinToolRegistry` / `preloadBuiltinToolMetas` | **闭包自足**，但要连 `lazyImport` 一起搬（它是内置插件的统一惰性加载入口）。原清单漏了 `BuiltinToolRegistry` / `getBuiltinToolRegistry` / `unknownBuiltinPluginIds` / `registerBuiltinProviderTypes` —— 是闭包带出来的 | ✅ 已搬（§2） |
 * | **B** | `buildProviderWindowTable` + `resolveContextWindowTokens` + `normalizeProviderConfigs`（连同 `parseModelSpec` / `formatModel` / `sanitizeProviderId` / `ResolvedProviderConfig` / `ProviderConfigIssue` / `isUsableWindow`） | 连着 cli 的配置归一化层。**裁剪点**：不搬 `HarnessConfig`（那份配置模型有二十来段，窗口链只读两段），改用 `ProviderWindowConfigSource` 窄类型 —— 见 §3 开头 | ✅ 已搬（§3） |
 *
 * ⇒ 采用分步搬迁而非一次大 commit：每一步都要求 `cli.test.ts` 逐字通过（它直接 `import`
 * 这些符号，搬走必须保持导出面不变），用小步换定位成本。
 *
 * 剩余（P0 收尾）：`HarnessApp.boot` 主体 → `createHost({...})`，以及 boot 内 16 处
 * `stdout.write` 的三级分级 + 接管 SDK 的 console（P0.5 spike 结论）。
 *
 * ## ⚠️ 本包不"自带"内置插件
 * §2 的注册表引用了一批 `@harness/*` specifier（provider-* / tools-* / 编排类），但**只在运行期**
 * `import()` 它们；本包只提供登记与解析逻辑。因此：
 *   - TS 侧不需要这些包（specifier 是 `string`，不是 import 语句）；
 *   - 运行期由消费方的依赖树解析 ⇒ 已把它们列入本包 `dependencies` 作为**可机读的契约**；
 *   - `bun build --compile` 打包时需按该清单显式收入口（`import(变量)` 无法被静态分析）。
 */

import { pathToFileURL } from 'node:url'
import type {
  AgentPlugin,
  ProviderConfig,
  ProviderTypeMeta,
  ProviderTypeRegistry,
  ToolMetaEntry,
  ToolMetaLookup,
  ToolMetaRegistry,
  ToolMetaSource,
} from '@harness/plugin'
import { resolveProviderTypeFactory } from '@harness/plugin'
import { MultiDirLoader, normalizeDirs } from '@harness/workspace'
// 仅类型（`import type` 完全擦除，不会把 ACP 内核拖上启动路径）：窗口表的形状定义在
// acp-context 侧，装配处必须按它构造 —— 写内联结构体就会与插件侧两份定义漂移
// （本仓"同一个东西两套写法"的老病）。host 与 cli 都只是这一份类型的消费方。
import type { ProviderWindowTable } from '@harness/acp-context'

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

// ========================================================================
// 2. 内置（随应用打包）Provider 类型与通用插件的注册表
// ========================================================================
// 与上面「外部插件目录」并列的第二条装配路径：只想开一个内置能力的用户改一行配置
// （config.json → plugins: ["code-intel"]）即可，不必写代码、也不必知道宿主插件的存在。
//
// 三节各管一层：
//   2.1 Provider 类型工厂注册表 —— config.type 的动态解析（provider-* 包）
//   2.2 内置通用插件注册表     —— 随应用打包的 AgentPlugin（tools-* / 编排类）
//   2.3 内置工具静态元信息注册表 —— 多级加载 L1，描述先于运行时模块可用

// ------------------------------------------------------------------------
// 2.1 Provider 类型工厂注册表（插件化扩展点）
// ------------------------------------------------------------------------
// 抽象层契约（ProviderTypeFactory / ProviderTypeRegistry / resolveProviderTypeFactory）
// 定义于 @harness/plugin —— 本模块只经此抽象层与 Provider 插件交互，不直接依赖任何
// 具体 provider-* 包；具体 Provider 包通过导出 providerTypeFactory 实现该契约。

/**
 * 惰性 import 一个随应用打包的模块并返回其命名导出（内置插件的统一惰性加载入口）。
 *
 * ## 为什么是惰性而不是顶部 import
 * 内置插件二十余个（provider-* / tools-* / 编排类），启动时全量加载会明显拖慢首屏，
 * 而绝大多数会话只用到其中两三个。故一律经本函数在「真正用到时」才 dynamic import。
 *
 * ## ⚠️ 契约：specifier 由**消费方**的依赖树解析，不是本包自带的
 * `import(specifier)` 的解析基准是本包文件位置，但这些模块并不在这里：它们由 monorepo
 * 根 `node_modules`（或最终宿主的依赖树）提供。由此派生两条约束：
 *   1. 消费 `@harness/host` 的宿主（cli / a2a-server / 编辑器扩展）必须能解析下表列出的包；
 *   2. `bun build --compile` 打包时 `import(变量)` 无法被静态分析 ⇒ 这些包**不会**自动进
 *      bundle，必须由打包配置显式收入口（P3 分发路径的前置项）。
 * 本包 `package.json` 把这份清单声明为 dependencies：既表达真实契约，也给打包器一份可机读
 * 的入口来源（而不是靠"反正是 monorepo 根 node_modules 有"这种隐式事实）。
 */
export async function lazyImport<T extends Record<string, unknown>>(specifier: string): Promise<T> {
  return (await import(specifier)) as T
}

/**
 * 内置 Provider 类型的展示元信息（惰性注册时同步登记，不加载 Provider 模块即可在 help / config check 中展示）。
 */
const BUILTIN_PROVIDER_META: Record<string, ProviderTypeMeta> = {
  anthropic: { type: 'anthropic', description: 'Anthropic Claude', defaultModel: 'claude-3-5-sonnet', requiresApiKey: true, builtin: true, usage: '/model anthropic/claude-3-5-sonnet' },
  openai: { type: 'openai', description: 'OpenAI 及任意 OpenAI 兼容端点（DeepSeek / Ollama / 智谱 GLM / 通义等）', defaultModel: 'gpt-4o', requiresApiKey: false, builtin: true, usage: '/model openai/gpt-4o' },
  gemini: { type: 'gemini', description: 'Google Gemini', defaultModel: 'gemini-2.0-flash', requiresApiKey: true, builtin: true, usage: '/model gemini/gemini-2.0-flash' },
  glm: { type: 'glm', description: '智谱 GLM', defaultModel: 'glm-4', requiresApiKey: true, builtin: true, usage: '/model glm/glm-4' },
  qwen: { type: 'qwen', description: '阿里通义千问', defaultModel: 'qwen-max', requiresApiKey: true, builtin: true, usage: '/model qwen/qwen-max' },
  mock: { type: 'mock', description: '内置 Mock（无网络，测试 / 兜底）', defaultModel: 'mock', requiresApiKey: false, builtin: true, usage: '/model mock/…' },
}

/**
 * 注册一个内置 Provider 类型工厂（惰性）。
 * 只登记「type → 惰性 createPlugin」描述符；createPlugin 在按 config.type 真正解析 Provider 时
 * 才 dynamic import 对应 provider-* 模块、取其 providerTypeFactory（抽象层契约）构造插件。
 * 因此即使配置里只用某一种 Provider，其余模块也不会被加载，尽量不影响启动速度。
 * 同时登记展示元信息（BUILTIN_PROVIDER_META），help / config check 无需加载模块即可列出。
 */
function registerBuiltinProviderType(registry: ProviderTypeRegistry, type: string, specifier: string): void {
  registry.register(
    {
      type,
      async createPlugin(config: ProviderConfig) {
        const mod = await lazyImport<Record<string, unknown>>(specifier)
        const factory = resolveProviderTypeFactory(mod)
        if (!factory) {
          throw new Error(`内置 Provider 模块 "${specifier}" 未导出 providerTypeFactory（抽象层契约）`)
        }
        return factory.createPlugin(config)
      },
    },
    BUILTIN_PROVIDER_META[type],
  )
}

/**
 * 注册宿主内置 Provider 类型工厂（anthropic / openai / gemini / glm / qwen / mock）。
 * 全部经 provider-* 包的 providerTypeFactory（@harness/plugin 抽象层契约）惰性加载，
 * 本函数不含任何具体 Provider 配置结构 / 工厂的硬编码映射。
 */
export function registerBuiltinProviderTypes(registry: ProviderTypeRegistry): void {
  registerBuiltinProviderType(registry, 'anthropic', '@harness/provider-anthropic')
  registerBuiltinProviderType(registry, 'openai', '@harness/provider-openai')
  registerBuiltinProviderType(registry, 'gemini', '@harness/provider-gemini')
  registerBuiltinProviderType(registry, 'glm', '@harness/provider-glm')
  registerBuiltinProviderType(registry, 'qwen', '@harness/provider-qwen')
  registerBuiltinProviderType(registry, 'mock', '@harness/provider-mock')
}

// ------------------------------------------------------------------------
// 2.2 内置（随应用打包）通用插件统一注册表 —— 惰性加载，来源=builtin
// ------------------------------------------------------------------------

/** 内置通用插件描述符：登记随应用打包的通用插件（如 tools-builtin），统一惰性加载 */
export interface BuiltinGeneralPlugin {
  id: string
  name: string
  description: string
  source: 'builtin'
  /** 惰性加载：首次用到（boot 装配 / /plugins 管理）才 dynamic import，返回 AgentPlugin 实例 */
  load: () => Promise<AgentPlugin>
  /**
   * 静态元信息来源（多级加载 L1）：插件自携带，惰性 dynamic import 对应 /meta 模块（纯数据、无副作用），
   * 供 /tools 等在任何运行时模块（L2）加载前展示描述/别名/安全声明/权限键。
   */
  metaSource?: () => Promise<ToolMetaSource>
  /**
   * **登记但默认不装配**：不参与 boot 末尾的后台预加载（scheduleBuiltinPreload），
   * 因而不会被自动安装——需经 `config.json → plugins` 声明式启用，或由外部插件目录
   * （.harness/plugins）显式装配。
   *
   * 两种典型用法：
   *  1. 进程内 MCP server 类插件（computer-use / code-intel）：工具要靠 mcp-client 连上才可用，
   *     故只预登记 metaSource 供 /tools 展示，不自动拉起 MCP 通道；
   *  2. 可选能力插件（subagent / coordinator / swarm）：默认不给所有 Agent 注入额外工具与编排 Hook，
   *     由用户按需声明（这类插件通常不提供 metaSource）。
   */
  optIn?: boolean
}

/** 内置通用插件注册表：`内置插件也要支持加载`的统一入口（与外部插件目录 loadPluginDirs 并列） */
export class BuiltinPluginRegistry {
  private readonly items = new Map<string, BuiltinGeneralPlugin>()

  register(p: BuiltinGeneralPlugin): void {
    this.items.set(p.id, p)
  }
  get(id: string): BuiltinGeneralPlugin | undefined {
    return this.items.get(id)
  }
  has(id: string): boolean {
    return this.items.has(id)
  }
  list(): BuiltinGeneralPlugin[] {
    return [...this.items.values()]
  }
}

let defaultBuiltinRegistry: BuiltinPluginRegistry | undefined

/** 惰性取某工具插件 /meta 模块的 toolMetaSource（多级加载 L1，纯数据、无副作用） */
function lazyToolMetaSource(specifier: string): () => Promise<ToolMetaSource> {
  return async () => (await lazyImport<{ toolMetaSource?: ToolMetaSource }>(specifier)).toolMetaSource!
}

/** 全局默认内置通用插件注册表（登记 tools-builtin 等随应用打包的插件，惰性加载） */
export function getBuiltinRegistry(): BuiltinPluginRegistry {
  if (!defaultBuiltinRegistry) {
    defaultBuiltinRegistry = new BuiltinPluginRegistry()
    defaultBuiltinRegistry.register({
      id: 'tools-builtin',
      name: 'Builtin Tools',
      description: '内置工作台工具（文件读写 + Shell）',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsBuiltinPlugin: AgentPlugin }>('@harness/tools-builtin')).toolsBuiltinPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-builtin/meta'),
    })
    defaultBuiltinRegistry.register({
      id: 'tools-manager',
      name: 'Tools Manager',
      description: '工具管理命令 /tools（查看 / Agent 白名单持久化 / --global 运行时启停 / mcp__ 工具掩码）',
      source: 'builtin',
      load: async () => (await lazyImport<{ createToolsManagerPlugin: () => AgentPlugin }>('@harness/tools-manager')).createToolsManagerPlugin(),
    })
    defaultBuiltinRegistry.register({
      id: 'manage-plugin',
      name: 'Plugin Manager',
      description: '插件生命周期管理命令 /plugins（查看 / 启用 / 禁用 / 重载）',
      source: 'builtin',
      load: async () => (await lazyImport<{ createPluginManagerPlugin: () => AgentPlugin }>('@harness/manage-plugin')).createPluginManagerPlugin(),
    })
    // 场景化工具插件（search/glob/web/media，metaSource 由各插件自携带）：
    // 登记进 BuiltinPluginRegistry 后，boot 末尾的后台预加载（scheduleBuiltinPreload）
    // 就会真正预热这些运行时模块，使「后台加载」生效——不再停留在"仅元信息"。
    defaultBuiltinRegistry.register({
      id: 'tools-search',
      name: 'Search Tools',
      description: '搜索类工具插件：list_dir 目录列举 + grep_file 内容检索',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsSearchPlugin: AgentPlugin }>('@harness/tools-search')).toolsSearchPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-search/meta'),
    })
    defaultBuiltinRegistry.register({
      id: 'tools-glob',
      name: 'Glob Tools',
      description: 'glob 文件匹配工具插件',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsGlobPlugin: AgentPlugin }>('@harness/tools-glob')).toolsGlobPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-glob/meta'),
    })
    defaultBuiltinRegistry.register({
      id: 'tools-web',
      name: 'Web Tools',
      description: 'Web 抓取工具插件：web_fetch',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsWebPlugin: AgentPlugin }>('@harness/tools-web')).toolsWebPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-web/meta'),
    })
    defaultBuiltinRegistry.register({
      id: 'tools-media',
      name: 'Media Tools',
      description: '媒体工具插件：view_image',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsMediaPlugin: AgentPlugin }>('@harness/tools-media')).toolsMediaPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-media/meta'),
    })
    // code-intel：进程内 MCP server（mcp__code-intel__*），工具经 mcp-client 连接后才可用。
    // 仅携带 metaSource（/tools 可提前展示），optIn=true 使其不被后台预加载实例化——
    // 启用方式二选一（都无需改动 core/宿主代码）：config.json → plugins: ["code-intel"]，或
    // 外部插件目录 .harness/plugins 里显式装配 createMcpServerRegistryPlugin + createCodeIntelPlugin。
    defaultBuiltinRegistry.register({
      id: 'code-intel',
      name: 'Code Intel',
      description: '代码情报 MCP server 插件（mcp__code-intel__*）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createCodeIntelPlugin: () => AgentPlugin }>('@harness/code-intel')).createCodeIntelPlugin(),
      metaSource: lazyToolMetaSource('@harness/code-intel/meta'),
    })
    // computer-use：进程内 MCP server，工具经 mcp-client 连接后才可用。仅携带 metaSource
    // （/tools 可提前展示 mcp__computer-use__* 元信息），optIn=true 使其不被后台预加载实例化。
    defaultBuiltinRegistry.register({
      id: 'computer-use',
      name: 'Computer Use',
      description: '电脑控制 MCP server 插件（mcp__computer-use__*）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createComputerUsePlugin: () => AgentPlugin }>('@harness/computer-use')).createComputerUsePlugin(),
      metaSource: lazyToolMetaSource('@harness/computer-use/meta'),
    })
    // mcp.server-registry：computer-use / code-intel 这类「进程内 MCP server 插件」的宿主
    // （自身不提供工具，故无 metaSource）。optIn=true → 默认不自动装配：不给用不到的能力拉起
    // MCP 通道；**必须在 core.harness.start 之前**装好，否则 applyMcpServers 的 cli.mcp.configure
    // 注入与 start 时的连接都会落空（这正是它不能靠「后台预加载」补装的原因）。
    // 由 config.json → plugins 声明式启用（依赖闭包也会自动补上），或外部插件目录显式装配。
    defaultBuiltinRegistry.register({
      id: 'mcp.server-registry',
      name: 'MCP Server Registry',
      description: 'MCP Server 注册表（连接进程内/外部 MCP server 并暴露其工具，提供 /mcp 命令）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createMcpServerRegistryPlugin: () => AgentPlugin }>('@harness/mcp-server-registry')).createMcpServerRegistryPlugin(),
    })
    // ── Agent 编排类插件（subagent / coordinator / swarm）──
    // 与 tools-* 的区别是 **optIn**：登记只让它们「可声明」（config.json → plugins 校验/补全、
    // /plugins 可见），不自动装配——不给用不到的会话注入 subagent 工具与编排 Hook。
    //
    // **工厂一律不传参**：这些能力的「配置」本就不该写在组合根——
    //   · 子 Agent 定义以 AgentRuntime 注册表为准（md frontmatter 定义），插件里的
    //     `subagents` 数组只是「本插件自注册」的兜底，写死会与注册表形成两个口径；
    //   · coordinator 的 forceAsync 走环境变量 HARNESS_FORCE_ASYNC，其余选项取默认。
    // 需要带参的装配用外部插件目录（.harness/plugins/*.ts）。
    defaultBuiltinRegistry.register({
      id: 'subagent',
      name: 'Subagent',
      description: '子 Agent 派工：subagent 工具 + /subagents 命令（目标取 AgentRuntime 注册表）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createSubagentPlugin: () => AgentPlugin }>('@harness/subagent')).createSubagentPlugin(),
    })
    defaultBuiltinRegistry.register({
      id: 'coordinator',
      name: 'Coordinator',
      description: '主 Agent 编排：四阶段派工 + barrier 自动续轮 + send_message（依赖 subagent，自动补齐）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createCoordinatorPlugin: () => AgentPlugin }>('@harness/coordinator')).createCoordinatorPlugin(),
    })
    defaultBuiltinRegistry.register({
      id: 'swarm',
      name: 'Swarm',
      description: '长期在线团队协作：Team / Mailbox / Task List 工具（leader 侧；teammate 由 `harness teammate` 启动）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createSwarmPlugin: () => AgentPlugin }>('@harness/swarm')).createSwarmPlugin(),
    })
    // ── 外部集成类插件 ──
    // herdr：把 Agent 状态（working / idle / blocked）上报到 Herdr 侧栏。
    // optIn + 环境内自查双保险：未声明 ⇒ 不加载；已声明但不在 Herdr pane 内 ⇒ install 时
    // 检测不到 HERDR_ENV=1 就返回空 Hooks（零进程、零副作用）。所以**常驻声明也安全**。
    defaultBuiltinRegistry.register({
      id: 'herdr',
      name: 'Herdr Agent State',
      description: '把 Agent 状态上报到 Herdr 终端复用器侧栏（仅在 Herdr pane 内生效，环境外为 no-op）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createHerdrPlugin: () => AgentPlugin }>('@harness/herdr')).createHerdrPlugin(),
    })
    // memory：长期记忆（L0 项目指令 AGENTS.md + L1 记忆索引 MEMORY.md）注入 system prompt。
    // optIn：不声明 `plugins: ["memory"]` 就完全不加载 —— 记忆会占用 system（永不回收的窗口成本），
    // 必须由用户显式开启。无工作区视图时插件自身也会退化为空 Hooks（宁可不做也不猜路径）。
    defaultBuiltinRegistry.register({
      id: 'memory',
      name: 'Memory',
      description: '长期记忆：加载两级 MEMORY.md 索引与 AGENTS.md 项目指令并注入 system prompt（子 Agent 不注入）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createMemoryPlugin: () => AgentPlugin }>('@harness/memory')).createMemoryPlugin(),
    })
    // skill-forge：技能锻造（F1/F2）。optIn：会往 skills 目录写文件，必须显式声明才启用。
    // 与 memory 互补：单条事实进记忆，多步流程进技能（见 docs/memory-and-skill-forge-plan.md §0）。
    defaultBuiltinRegistry.register({
      id: 'skill-forge',
      name: 'Skill Forge',
      description: '技能锻造：从会话工具轨迹生成技能草稿，人工确认后落盘为 SKILL.md 并当轮生效（/skill-forge）',
      source: 'builtin',
      optIn: true,
      load: async () =>
        (await lazyImport<{ createSkillForgePlugin: () => AgentPlugin }>('@harness/skill-forge')).createSkillForgePlugin(),
    })
  }
  return defaultBuiltinRegistry
}

/**
 * 校验 config.json → `plugins` 里的 id 是否都在 BuiltinPluginRegistry 登记（只查表，不加载模块）。
 * 供 `harness config check` 与 boot 的告警使用。
 */
export function unknownBuiltinPluginIds(ids: string[] | undefined, registry = getBuiltinRegistry()): string[] {
  const wanted = [...new Set((ids ?? []).map((s) => String(s).trim()).filter(Boolean))]
  return wanted.filter((id) => !registry.has(id))
}

/**
 * 解析 config.json → `plugins`（内置插件 id）→ 插件实例（含 dependsOn 依赖闭包）。
 *
 * 这是与「外部插件目录 .harness/plugins」并列的第二条装配路径：只想开一个内置能力的用户
 * 改一行配置即可，**不必写代码**，也不必知道 mcp.server-registry 这种宿主插件的存在——
 * 依赖按实例上的 dependsOn 递归补齐（如 computer-use → mcp.server-registry）。
 * 同一批实例交给 core 的 loadInternal，由它按 dependsOn 拓扑排序保证宿主先安装。
 *
 * 失败隔离：未登记的 id / 单个模块加载失败都只记入 `unknown` 并继续，不阻断 boot。
 *
 * @returns plugins：按声明顺序去重的实例；unknown：未登记或加载失败的 id 描述
 */
export async function resolveBuiltinPlugins(
  ids: string[] | undefined,
  registry = getBuiltinRegistry(),
): Promise<{ plugins: AgentPlugin[]; unknown: string[] }> {
  const plugins: AgentPlugin[] = []
  const unknown: string[] = []
  const done = new Set<string>()
  const queue = [...(ids ?? [])]
  while (queue.length) {
    const id = String(queue.shift() ?? '').trim()
    if (!id || done.has(id)) continue
    const entry = registry.get(id)
    if (!entry) { unknown.push(id); continue }
    done.add(id)
    try {
      const plugin = await entry.load()
      plugins.push(plugin)
      for (const dep of plugin.dependsOn ?? []) if (!done.has(dep)) queue.push(dep)
    } catch (err) {
      unknown.push(`${id}（加载失败：${(err as Error)?.message ?? String(err)}）`)
    }
  }
  return { plugins, unknown }
}

// ------------------------------------------------------------------------
// 2.3 内置工具静态元信息注册表 —— 多级加载 L1（描述可提前加载，运行时模块 L2 保持惰性/后台）
// ------------------------------------------------------------------------

/**
 * 内置工具静态元信息注册表（多级加载 L1）。
 *
 * 在 boot 早期同步登记全部内置工具的 meta（描述/别名/安全声明/权限键），
 * 无需加载对应的运行时工具模块（L2），即可供 REPL `/tools`、help 等展示。
 * 实现 `ToolMetaRegistry` 抽象契约（@harness/plugin），内部存储统一为 `ToolMetaEntry`；
 * 实现 `ToolMetaLookup`，注入 cli.command 输入供工具管理插件合并展示。
 */
export class BuiltinToolRegistry implements ToolMetaRegistry, ToolMetaLookup {
  private readonly byId = new Map<string, ToolMetaEntry>()

  register(m: ToolMetaEntry): void {
    this.byId.set(m.id, m)
  }
  registerAll(metas: ToolMetaEntry[]): void {
    for (const m of metas) this.register(m)
  }
  /** 登记一个 ToolMetaSource：合并其 list() 元信息（抽象契约统一入口） */
  registerSource(source: ToolMetaSource): void {
    this.registerAll(source.list())
  }
  has(id: string): boolean {
    return this.byId.has(id)
  }
  get(id: string): ToolMetaEntry | undefined {
    if (this.byId.has(id)) return this.byId.get(id)
    for (const m of this.byId.values()) {
      if (m.aliases?.includes(id)) return m
    }
    return undefined
  }
  list(): ToolMetaEntry[] {
    return [...this.byId.values()]
  }
  get size(): number {
    return this.byId.size
  }
}

let defaultToolMetaRegistry: BuiltinToolRegistry | undefined

/**
 * 全局默认内置工具元信息注册表（多级加载 L1）。注册表本体同步可访问；
 * 具体来源由各随应用打包工具插件自携带（BuiltinGeneralPlugin.metaSource），
 * 经 `preloadBuiltinToolMetas()` 异步登记。boot 早期 await 预载后，/tools 等命令
 * 在任何运行时模块（L2）加载前即可展示内置工具描述。
 */
export function getBuiltinToolRegistry(): BuiltinToolRegistry {
  if (!defaultToolMetaRegistry) defaultToolMetaRegistry = new BuiltinToolRegistry()
  return defaultToolMetaRegistry
}

/**
 * 预载全部随应用打包工具插件的静态元信息来源（L1）：
 * 遍历 `getBuiltinRegistry().list()`，对每个携带 `metaSource` 的插件 dynamic import 其 /meta 模块
 * （纯数据、无副作用）并登记到 `getBuiltinToolRegistry()`。plugin 自携带，宿主不硬编码具体包导出。
 * 失败按插件隔离，不阻塞整体登记（避免单个 meta 模块异常影响 boot）。
 */
export async function preloadBuiltinToolMetas(): Promise<void> {
  const reg = getBuiltinToolRegistry()
  const items = getBuiltinRegistry().list().filter((p) => p.metaSource)
  await Promise.all(
    items.map(async (p) => {
      try {
        const source = await p.metaSource!()
        reg.registerSource(source)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[WARN] 内置插件「${p.id}」元信息来源预载失败：${(err as Error)?.message ?? String(err)}`)
      }
    }),
  )
}

// ========================================================================
// 3. 配置归一化与上下文窗口推导（P0 第三步：B 档）
// ========================================================================
// 纯函数、无 IO。搬它们不是因为"顺路"，而是因为**上下文窗口这个分母必须全进程一份口径**：
// 显示（/stats、TUI 占用率）、会话压缩阈值、ACP 占用率三处各自算一遍，就会出现
// "概览说 26%、实际已 103%"这类**全程无症状**的故障（本仓出过）。
//
// ## 为什么用 `ProviderWindowConfigSource` 窄类型而不是 `HarnessConfig`
// 配置模型（`HarnessConfig`）还住在 `@harness/cli`，它有二十来段（压缩 / 记忆 / 遥测 /
// 插件 / 快照…），而窗口推导只读其中两段。为两个字段把整份配置模型拖进共用装配层，
// 等于让 host 反向依赖 cli 的配置口径 —— 而 A2A server / 编辑器扩展的配置来源未必是
// config.json。用结构化的最小契约是**依赖倒置**，不是本仓的老病"同一个东西两套写法"：
// 它不含任何第二份实现，宽类型（`HarnessConfig`）传进来天然兼容。

/** 解析 `[provider/]modelId` 规格。示例：'openai/gpt-4o' → { providerId:'openai', modelId:'gpt-4o' }；'claude-3-5-sonnet' → { modelId:'claude-3-5-sonnet' } */
export function parseModelSpec(spec: string): { providerId?: string; modelId: string } {
  const s = spec.trim()
  const idx = s.indexOf('/')
  if (idx <= 0) return { providerId: undefined, modelId: s }
  return { providerId: s.slice(0, idx).trim() || undefined, modelId: s.slice(idx + 1).trim() || s }
}

/** 格式化显示 `provider/modelId`（无 providerId 时仅返回 modelId） */
export function formatModel(providerId: string | undefined, modelId: string | undefined): string | undefined {
  if (!modelId) return undefined
  return providerId ? `${providerId}/${modelId}` : modelId
}

/** providers 配置校验问题（index=-1 表示非数组内问题，如默认 provider 未定义） */
export interface ProviderConfigIssue {
  index: number
  message: string
}

/**
 * 已归一化的 Provider 定义：`id` 必定存在（显式指定，或由 `normalizeProviderConfigs` 从 model 派生）。
 * 归一化之后的下游代码（装配 / 路由 / 展示）一律按「id 必有」处理，无需到处判空。
 */
export interface ResolvedProviderConfig extends ProviderConfig {
  id: string
}

/** 把任意字符串规整为可用的 id 片段：保留 [A-Za-z0-9._-]，其余折叠为 '-'，去首尾连字符 */
export function sanitizeProviderId(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * 归一化 providers 数组：把可选的 `id` 补全为**确定性且唯一**的实例 id。
 *
 * 设计意图（本函数是「id 不再必须冗长/手写」的落点）：
 * - 显式写了 `id` → 原样保留；重复则报错（沿用旧校验语义，避免静默覆盖注册）。
 * - 未写 `id` 但写了 `model` → 由模型名派生（去 `provider/` 前缀、规整非法字符）；
 *   与已占用 id 冲突时按数组顺序追加 `-2` / `-3`…（结果确定、可复现，无需人工起名）。
 * - `id` 与 `model` 都缺失 → 报错（无从派生）。
 *
 * 纯函数（无 IO），`issues[].index` 对应原始数组下标，便于在报错中定位。
 */
export function normalizeProviderConfigs(raw: ProviderConfig[]): {
  providers: ResolvedProviderConfig[]
  issues: ProviderConfigIssue[]
} {
  const issues: ProviderConfigIssue[] = []
  const taken = new Set<string>()
  const providers: ResolvedProviderConfig[] = []
  raw.forEach((pc, index) => {
    const explicit = pc.id?.trim()
    if (explicit) {
      if (taken.has(explicit)) {
        issues.push({
          index,
          message: `providers[${index}].id "${explicit}" 与前面的 provider 重复（显式 id 必须唯一，否则后注册的会被覆盖；也可省略 id，交由系统按 model 自动派生）`,
        })
      }
      taken.add(explicit)
      // 首个同 id 保留，保持与旧行为一致（默认 provider 仍能在数组中找到）
      if (!providers.some((p) => p.id === explicit)) providers.push({ ...pc, id: explicit })
      return
    }
    const derived = pc.model ? sanitizeProviderId(parseModelSpec(pc.model).modelId) : ''
    if (!derived) {
      issues.push({ index, message: `providers[${index}] 既未写 id 也未写 model，无法派生实例 id（至少填写其一）` })
      return
    }
    let id = derived
    for (let n = 2; taken.has(id); n++) id = `${derived}-${n}`
    taken.add(id)
    providers.push({ ...pc, id })
  })
  return { providers, issues }
}

/**
 * 窗口推导所需的最小配置面（见本节开头：为什么不用 `HarnessConfig`）。
 * `providers[]` 提供端点级窗口；`compression.modelContextLimit` 是全局显式覆盖。
 */
export interface ProviderWindowConfigSource {
  providers?: ProviderConfig[]
  compression?: { modelContextLimit?: number }
}

/** 窗口得是个能当分母的正有限数 —— `0` / 负数 / `NaN` 一律按「没配」处理（否则占用率会算出 Infinity/NaN） */
export function isUsableWindow(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * 上下文窗口推导（ACP 默认 Provider 口径）：
 * `compression.modelContextLimit → 默认 Provider 的 contextWindowTokens → 200000`。
 *
 * 抽成函数是因为**三处**都要它：boot 装配 ACP、配置概览、会话压缩选项。此前概览与 boot
 * 各写一份、会话压缩干脆硬编码 200000，于是同一份 config 能同时得出 200000 和 102400
 * 两个窗口 —— 按概览做的判断全部落空，会话压缩则因阈值 136000 > 真实窗口而从不触发。
 * 默认 provider 的 id 可能省略（由 model 派生），故同样走 normalizeProviderConfigs。
 *
 * 各级都要求窗口是**能当分母的正有限数**（见 isUsableWindow）：`contextWindowTokens: 0` 这种
 * 笔误若原样当选，占用率会算出 Infinity、阈值会算成负数 —— 两个都伪装成"正常显示"。
 */
export function resolveContextWindowTokens(cfg: ProviderWindowConfigSource, defaultProviderId: string): number {
  const { providers } = normalizeProviderConfigs(cfg.providers ?? [])
  const explicit = cfg.compression?.modelContextLimit
  if (isUsableWindow(explicit)) return explicit
  const derived = providers.find((p) => p.id === defaultProviderId)?.contextWindowTokens
  return isUsableWindow(derived) ? derived : 200_000
}

/**
 * 构造「Provider / 模型 → 上下文窗口」表，供 ACP 按会话**实际**使用的端点解析占用率分母。
 *
 * 为什么必须按端点分化：`resolveContextWindowTokens` 只回答「**默认** Provider 的窗口是多少」，
 * 而 Provider / 模型是**按 Agent 解析、且每次派工都能覆盖**的
 * （core：`input.model?.providerId ?? agent.model?.providerId ?? 'default'`，见 SubagentTool 的
 * `model` 入参）。子 Agent 被派到小窗口端点时，拿默认 Provider 的窗口当分母会让占用率**虚低** ——
 * 真机形态：默认端点 300K、子 Agent 走 200K 端点 ⇒ 报 66% 时其实已 100%，压缩永不触发，
 * 且全程无任何症状（`acp_status` 照常报数，只是分母不是本会话的）。
 *
 * `fallback` 取 `resolveContextWindowTokens` 的**原值**（不是另算一遍）：查不到端点时逐位回到
 * 改造前的行为。这是「缺省零行为变更」的保证点 —— 换成别的推导就会在无 providers 的场景下
 * 悄悄改掉分母。
 *
 * `byModel` 对同名多实例取**最小**窗口：模型名相同而端点窗口不同时无从分辨到底走哪个，
 * 取最小 = 宁可早压。反方向（取最大）会让分母虚高，正是要避免的那个。
 */
export function buildProviderWindowTable(
  cfg: ProviderWindowConfigSource,
  defaultProviderId: string,
): ProviderWindowTable & { fallback: number } {
  const { providers } = normalizeProviderConfigs(cfg.providers ?? [])
  const byProvider: Record<string, number> = {}
  const byModel: Record<string, number> = {}
  for (const p of providers) {
    const w = p.contextWindowTokens
    // 窗口得是能当分母的正有限数；`0` / 负数 / `NaN` 只当"没配"（否则占用率会算出 Infinity/NaN）
    if (!isUsableWindow(w)) continue
    byProvider[p.id] = w
    if (p.model) byModel[p.model] = Math.min(byModel[p.model] ?? Number.POSITIVE_INFINITY, w)
  }
  return { byProvider, byModel, fallback: resolveContextWindowTokens(cfg, defaultProviderId) }
}
