/**
 * @harness/host —— 装配原语：外部插件目录加载 + 内置注册表
 *
 * 本文件是 `@harness/host` 的**实现模块**（`./index.ts` 只做转出）。单独成文件的理由与
 * `./provider.ts` / `./config.ts` / `./notice.ts` 一致 —— **叶子模块不得反向 import barrel**：
 * `./host.ts` 的 `HarnessHost` 要用这里的 `loadPluginDirs` / `getBuiltinRegistry` /
 * `registerBuiltinProviderTypes` / `preloadBuiltinToolMetas` / `resolveBuiltinPlugins`；
 * 它们若留在 `index.ts`，`host.ts → index.ts → host.ts` 就会成环，而本仓已明确回避该形态
 * （见 `./lazy.ts` 的注释）。
 *
 * 两节（对应迁移清单的 A 档与 C 档）：
 *   1. 外部插件目录加载 —— user → project 多级、代码注入默认闸门、诊断双出口
 *   2. 内置（随应用打包）Provider 类型与通用插件的注册表
 *      2.1 Provider 类型工厂注册表 / 2.2 内置通用插件注册表 / 2.3 内置工具静态元信息注册表
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
import { makeNotice } from './notice'
import type { NoticeSink } from './notice'

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
  onNotice?: NoticeSink,
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
  // 有结构化出口时发 notice（其渲染字节与 out 路径逐字相同，见 notice.test.ts 的对齐用例）；
  // 否则保留原文本路径 —— 老调用方与既有测试的 log 契约不变。
  if (onNotice) onNotice(makeNotice('plugins.not-a-plugin', { file: full }))
  else out(`插件模块既未导出通用 AgentPlugin 也未导出有效 Provider 类型工厂，已忽略：${full}`)
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
  opts: { allowCode?: boolean; onNotice?: NoticeSink } = {},
): Promise<PluginLoadResult> {
  const out = log ?? ((s: string) => { if (typeof process !== 'undefined') process.stderr.write(s + '\n') })
  // 装配期诊断的两条出口（见 `./notice.ts` 文件头）：
  //   有 `onNotice` ⇒ 只发结构化 notice（宿主自己决定渲染/上报），不再走文本；
  //   没有        ⇒ 保留原文本路径，既有调用方与测试的 `log` 契约逐字不变。
  // 两条路径的**最终字节相同**（由 `notice.test.ts` 的"与真实 loadPluginDirs 捕获字节对齐"钉住），
  // 所以这不是"同一个东西两套写法"，而是同一份文案的两个出口。
  const emit = (n: ReturnType<typeof makeNotice>, legacy: () => void): void => {
    if (opts.onNotice) opts.onNotice(n as never)
    else legacy()
  }
  // 枚举交给通用多级目录加载器（workspace 收敛「scan + 来源标注」），来源顺序 user → project
  const items = new MultiDirLoader(normalizeDirs(dirs)).scan({ name: (n) => /\.(ts|js|mjs)$/.test(n) })
  // 默认闸门：代码注入防护 —— 只登记文件、不执行
  if (!opts.allowCode) {
    if (items.length) {
      emit(
        makeNotice('plugins.code-skipped', {
          count: items.length,
          files: items.slice(0, 5).map((it) => it.full),
        }),
        () => {
          out(`已跳过 ${items.length} 个插件代码文件（默认不加载外部插件代码，防止代码注入）：\n`)
          for (const it of items.slice(0, 5)) out(`  - ${it.full}\n`)
          if (items.length > 5) out(`  …… 其余 ${items.length - 5} 个\n`)
          out('  启用内置能力请改用 config.json → "plugins": ["code-intel"]（零代码，推荐）；\n')
          out('  确需加载自定义插件代码时，设置 config.json → "allowPluginCode": true 或启动参数 --allow-plugin-code。\n')
        },
      )
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
      registerProviderTypeFactory(registry, mod, full, out, opts.onNotice)
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      // 裸依赖解析不到要给出可操作的提示（正则与改造前逐字一致）
      const bareDependency = /Cannot find (?:module|package)\s+["']/.test(msg)
      emit(makeNotice('plugins.load-failed', { file: full, message: msg, bareDependency }), () => {
        out(`插件加载失败 ${full}：${msg}\n`)
        if (bareDependency) {
          out('  （该插件目录无法解析裸依赖：请把它放在能解析到依赖的位置；或改用 config.json → "plugins" 声明式启用内置能力）\n')
        }
      })
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

import { lazyImport } from './lazy'

// 统一惰性加载入口已单独成文件（`./lazy.ts`）：`./config.ts` 与 `./provider.ts` 都要用它，
// 留在本文件会让它们反向 import index 而形成环。这里 import + re-export 保持导出面不变。


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
    // planning-files：文件化持久规划（计划放 .planning/ 三文件，每轮尾部注入）。
    // optIn：它**每轮都往请求尾部注入计划块** —— 那是有成本的行为（额外 prefill + 上下文占用），
    // 属于"启用了才付代价"的能力，不能默认给所有会话挂上（与 memory 同理：默认零行为）。
    // 未启用时完全零行为（既不建 .planning/、也不注入）。
    defaultBuiltinRegistry.register({
      id: 'planning-files',
      name: 'Planning Files',
      description: '文件化持久规划：task_plan / findings / progress 三文件放 .planning/，每轮尾部注入（跨会话 / 压缩 / 崩溃存活）+ /plan 系命令',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createPlanningFilesPlugin: () => AgentPlugin }>('@harness/planning-files')).createPlanningFilesPlugin(),
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
 *
 * ## 诊断出口：与 `loadPluginDirs` 同形（结构化 notice 优先，否则回落到文本）
 * S1 盘点时这里是**唯一"两个出口都不沾"的装配期诊断** —— `console.warn` 直写，既不走宿主输出流、
 * 也不走 `setLogSink`（见 `docs/host-extraction-design.md` §8 ②）。A2A / VSCode 宿主因此对
 * "元信息来源预载失败"完全无声。S2 把它纳入同一条通道：有 `onNotice` 发 notice（等级 `warn`），
 * 没有则保留 `console.warn` —— 两条出口的**最终字节相同**（换行由 renderNotice 显式补上，
 * 因为 console.warn 是自己补的）。
 */
export async function preloadBuiltinToolMetas(onNotice?: NoticeSink): Promise<void> {
  const reg = getBuiltinToolRegistry()
  const items = getBuiltinRegistry().list().filter((p) => p.metaSource)
  await Promise.all(
    items.map(async (p) => {
      try {
        const source = await p.metaSource!()
        reg.registerSource(source)
      } catch (err) {
        const message = (err as Error)?.message ?? String(err)
        if (onNotice) onNotice(makeNotice('preload.meta-source-failed', { pluginId: p.id, message }))
        else {
          // eslint-disable-next-line no-console
          console.warn(`[WARN] 内置插件「${p.id}」元信息来源预载失败：${message}`)
        }
      }
    }),
  )
}