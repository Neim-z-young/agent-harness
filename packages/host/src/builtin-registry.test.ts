/**
 * @harness/host 内置注册表三节（P0 第二步搬迁）的归属测试。
 *
 * ## 与 cli.test.ts 的关系：S4 已收口为「能力归 host，兼容归 cli」
 * 搬迁前这些用例住在 `packages/cli/src/cli.test.ts`，搬迁期两边同时存在、各测一件事：
 *   - **cli 侧**测「re-export 兼容」—— 符号还能从 `@harness/cli` 拿到、行为不变；
 *   - **本文件**测「能力本身」—— 注册/解析/惰性加载的语义在 host 这一层成立，
 *     且**不经过 cli**（将来 A2A server / 编辑器扩展也吃这份实现，不该只被 cli 的
 *     测试间接覆盖）。
 * P0 收尾 S4 把 cli 侧的**重复行为用例删除**，只留一条 re-export 兼容断言；本文件成为唯一
 * 的能力测试。这样"符号仍可从 `@harness/cli` 取得"这条约定由断言钉住，而能力覆盖不再有两份。
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ProviderTypeRegistry } from '@harness/plugin'
import {
  lazyImport,
  registerBuiltinProviderTypes,
  BuiltinPluginRegistry,
  getBuiltinRegistry,
  unknownBuiltinPluginIds,
  resolveBuiltinPlugins,
  BuiltinToolRegistry,
  getBuiltinToolRegistry,
  preloadBuiltinToolMetas,
} from './index'

describe('lazyImport：内置插件统一惰性加载入口', () => {
  it('按 specifier 取命名导出', async () => {
    const mod = await lazyImport<{ toolsBuiltinPlugin: { id: string } }>('@harness/tools-builtin')
    expect(mod.toolsBuiltinPlugin.id).toBeDefined()
  })

  it('specifier 不存在时抛错（不静默返回 undefined）', async () => {
    await expect(lazyImport('@harness/definitely-not-a-package')).rejects.toThrow()
  })
})

describe('registerBuiltinProviderTypes：内置 Provider 类型工厂注册表', () => {
  it('内置 6 类型齐全', () => {
    const reg = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(reg)
    expect(reg.list().sort()).toEqual(['anthropic', 'gemini', 'glm', 'mock', 'openai', 'qwen'])
  })

  it('展示元信息同步登记：不加载任何 Provider 模块即可列出描述 / 用法 / 是否需 key', () => {
    const reg = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(reg)
    const metas = reg.listMeta()
    expect(metas).toHaveLength(6)
    const openai = metas.find((m) => m.type === 'openai')!
    expect(openai.description).toContain('OpenAI')
    expect(openai.usage).toContain('/model openai/')
    expect(openai.builtin).toBe(true)
    expect(reg.meta('mock')?.requiresApiKey).toBe(false)
    expect(reg.meta('anthropic')?.requiresApiKey).toBe(true)
  })

  it('惰性：createPlugin 被调用时才 import provider-* 模块，返回真实插件', async () => {
    const reg = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(reg)
    const plugin = (await reg.resolve('mock')!.createPlugin({ id: 'x', type: 'mock' }))!
    expect(plugin.id).toBeDefined()
    expect(typeof plugin.install).toBe('function')
  })
})

describe('BuiltinPluginRegistry：内置通用插件统一登记', () => {
  it('注册表本体：register / get / has / list', () => {
    const reg = new BuiltinPluginRegistry()
    expect(reg.list()).toEqual([])
    expect(reg.has('a')).toBe(false)
    reg.register({ id: 'a', name: 'A', description: 'a', source: 'builtin', load: async () => ({ id: 'a', install: () => {} }) as never })
    expect(reg.has('a')).toBe(true)
    expect(reg.get('a')?.name).toBe('A')
    expect(reg.list().map((p) => p.id)).toEqual(['a'])
    // 同 id 后注册覆盖前注册
    reg.register({ id: 'a', name: 'A2', description: 'a2', source: 'builtin', load: async () => ({ id: 'a', install: () => {} }) as never })
    expect(reg.get('a')?.name).toBe('A2')
    expect(reg.list()).toHaveLength(1)
  })

  it('默认注册表是单例，且登记了各能力域的关键插件', () => {
    expect(getBuiltinRegistry()).toBe(getBuiltinRegistry())
    const reg = getBuiltinRegistry()
    for (const id of [
      'tools-builtin', 'tools-manager', 'manage-plugin',
      'tools-search', 'tools-glob', 'tools-web', 'tools-media',
      'code-intel', 'computer-use', 'mcp.server-registry',
      'subagent', 'coordinator', 'swarm',
      'herdr', 'memory', 'skill-forge',
    ]) {
      expect(reg.has(id)).toBe(true)
      expect(reg.get(id)!.source).toBe('builtin')
    }
  })

  it('惰性加载：load() 才 import 运行时模块，拿到真实 AgentPlugin', async () => {
    const p = await getBuiltinRegistry().get('tools-builtin')!.load()
    expect(p.id).toBeDefined()
    expect(typeof p.install).toBe('function')
  })

  it('optIn 语义：进程内 MCP server 与编排类插件默认不自动装配', () => {
    const reg = getBuiltinRegistry()
    for (const id of ['code-intel', 'computer-use', 'mcp.server-registry', 'subagent', 'coordinator', 'swarm', 'memory', 'skill-forge', 'herdr']) {
      expect(reg.get(id)!.optIn).toBe(true)
    }
    // tools-* 是默认装配的：没有 optIn 标记
    for (const id of ['tools-builtin', 'tools-manager', 'manage-plugin', 'tools-search', 'tools-glob', 'tools-web', 'tools-media']) {
      expect(reg.get(id)!.optIn).toBeUndefined()
    }
  })
})

describe('resolveBuiltinPlugins / unknownBuiltinPluginIds：声明式启用路径', () => {
  it('按 id 实例化，并用 dependsOn 递归补齐依赖闭包（code-intel → mcp.server-registry）', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['code-intel'])
    expect(unknown).toEqual([])
    const ids = plugins.map((p) => p.id)
    expect(ids).toContain('code-intel')
    expect(ids).toContain('mcp.server-registry')
    // 宿主必须先安装：拓扑序由 core 保证，这里只要求依赖在场
    expect(plugins).toHaveLength(2)
  })

  it('只声明 coordinator 时经 dependsOn 自动补上 subagent', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['coordinator'])
    expect(unknown).toEqual([])
    expect(plugins.map((p) => p.id).sort()).toEqual(['coordinator', 'subagent'])
  })

  it('未登记 id 与重复项只记入 unknown / 去重，不抛错', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['no-such-plugin', 'code-intel', 'code-intel'])
    expect(unknown).toEqual(['no-such-plugin'])
    expect(plugins.map((p) => p.id).filter((id) => id === 'code-intel')).toHaveLength(1)
  })

  it('空 / undefined 声明不加载任何模块', async () => {
    expect(await resolveBuiltinPlugins(undefined)).toEqual({ plugins: [], unknown: [] })
    expect(await resolveBuiltinPlugins([])).toEqual({ plugins: [], unknown: [] })
  })

  it('unknownBuiltinPluginIds 只查表不加载模块，并做 trim / 去重', () => {
    expect(unknownBuiltinPluginIds(undefined)).toEqual([])
    expect(unknownBuiltinPluginIds(['code-intel', ' nope '])).toEqual(['nope'])
    expect(unknownBuiltinPluginIds(['code-intel', 'code-intel'])).toEqual([])
  })
})

describe('BuiltinToolRegistry：多级加载 L1（元信息先于运行时模块可用）', () => {
  it('注册表契约：register / registerAll / registerSource / has / get / list / size', () => {
    const reg = new BuiltinToolRegistry()
    expect(reg.size).toBe(0)
    reg.register({ id: 'a_file', description: 'a' })
    reg.registerAll([{ id: 'b_file', description: 'b' }, { id: 'c_file', description: 'c' }])
    expect(reg.size).toBe(3)
    expect(reg.has('b_file')).toBe(true)
    expect(reg.list().map((m) => m.id).sort()).toEqual(['a_file', 'b_file', 'c_file'])
    // register 同 id 覆盖，不增条目
    reg.register({ id: 'a_file', description: 'a2' })
    expect(reg.get('a_file')?.description).toBe('a2')
    expect(reg.size).toBe(3)
  })

  it('别名可查到（ToolMetaLookup 的输入来自未加载的工具名）', () => {
    const reg = new BuiltinToolRegistry()
    reg.register({ id: 'x_file', aliases: ['xf', 'xxf'], description: 'x' })
    expect(reg.get('xf')?.id).toBe('x_file')
    expect(reg.get('xxf')?.id).toBe('x_file')
    expect(reg.get('nope')).toBeUndefined()
  })

  it('ToolMetaSource 抽象契约：registerSource 合并来源 list() 的元信息', () => {
    const reg = new BuiltinToolRegistry()
    reg.registerSource({ id: 'src-a', description: 'a', list: () => [{ id: 'y_file', description: 'y' }] })
    expect(reg.has('y_file')).toBe(true)
    expect(reg.get('y_file')?.description).toBe('y')
  })

  it('默认注册表是单例', () => {
    expect(getBuiltinToolRegistry()).toBe(getBuiltinToolRegistry())
  })
})

describe('preloadBuiltinToolMetas：preload 后内置工具描述无需加载 L2 模块即可用', () => {
  it('登记全部内置原语工具与场景化工具插件的元信息', async () => {
    await preloadBuiltinToolMetas()
    const reg = getBuiltinToolRegistry()
    expect(reg instanceof BuiltinToolRegistry).toBe(true)
    // 内置原语（tools-builtin）
    for (const id of ['read_file', 'write_file', 'bash', 'edit_file']) {
      expect(reg.has(id)).toBe(true)
    }
    // 场景化插件（search/glob/web/media）+ 进程内 MCP server 插件（computer-use / code-intel）
    for (const id of ['list_dir', 'grep_file', 'glob', 'web_fetch', 'view_image', 'mcp__computer-use__list_apps', 'mcp__code-intel__code_symbols']) {
      expect(reg.has(id)).toBe(true)
    }
    // 描述 / 权限键 / 破坏性标记都可提前取得（与运行时模块是否加载无关）
    const bash = reg.get('bash')!
    expect(bash.description).toContain('shell')
    expect(bash.permissionKey).toBe('bash')
    expect(bash.isDestructive).toBe(true)
    const permByTool: Record<string, string> = {
      web_fetch: 'network', list_dir: 'read', glob: 'read', view_image: 'read',
    }
    for (const [id, k] of Object.entries(permByTool)) {
      expect(reg.get(id)?.permissionKey).toBe(k)
    }
  })
})

// ========================================================================
// P3-A：内置包清单 ↔ lazy.ts 静态查表（编译友好性守卫）
// ========================================================================

/**
 * 为什么要有这条：内置包是**按包名**惰性 import 的，而打包器只能静态分析字面量
 * —— `import(变量)` 不会进 bundle，`bun build --compile` 出的二进制一启动就
 * `Cannot find module '@harness/provider-openai' from '/$bunfs/root/…'`（P3-A 实测）。
 * 故 lazy.ts 把它们改成了静态查表；**新增内置插件忘了同步表 = 编译产物启动即崩**，
 * 这条守卫把「注册点集合」与「查表键集合」钉在一起。
 */
describe('内置包清单与 lazy.ts 静态查表一致（--compile 友好性）', () => {
  /** 源码里出现的内置包 specifier（注册点集合） */
  const REGISTERED = new Set<string>()
  for (const file of ['./plugins.ts', './host.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const m of src.matchAll(/lazyImport(?:<[\s\S]*?>)?\s*\(\s*'([\w@/.\-]+)'/g)) REGISTERED.add(m[1])
    for (const m of src.matchAll(/lazyToolMetaSource\('([\w@/.\-]+)'\)/g)) REGISTERED.add(m[1])
    for (const m of src.matchAll(/registerBuiltinProviderType\(registry,\s*'[\w-]+',\s*'([\w@/.\-]+)'\)/g)) {
      REGISTERED.add(m[1])
    }
  }

  /** lazy.ts 静态表的键集合 */
  const TABLED = new Set(
    [...readFileSync(new URL('./lazy.ts', import.meta.url), 'utf8').matchAll(/^ {2}'(@harness\/[\w.\-/]+)':/gm)].map(
      (m) => m[1],
    ),
  )

  // 注：`@harness/telemetry` 住在 packages/plugins/ 下（不在 packages/* 平铺层），
  // 靠根 node_modules 软链解析 —— 未编译时能命中、编译后就会漏，是最典型的一类
  // 「静态表漏项」受害者，故本轮一并收进静态表并把依赖显式声明进 host。

  it('注册点集合非空（扫描正则本身没失效）', () => {
    expect(REGISTERED.size).toBeGreaterThan(20)
  })

  it('每个注册点都在静态表里', () => {
    const missing = [...REGISTERED].filter((s) => !TABLED.has(s))
    expect(missing).toEqual([])
  })

  it('静态表里没有已失效的注册点（表不会腐烂）', () => {
    const stale = [...TABLED].filter((s) => !REGISTERED.has(s))
    expect(stale).toEqual([])
  })

  it('表内 specifier 都能被真实解析（编译期可静态分析的前置）', async () => {
    // 逐个真的 import 一遍：解析不到会直接抛 —— 比"表看起来对"更硬
    for (const spec of [...TABLED].filter((s) => !s.endsWith('/meta'))) {
      const mod = await lazyImport<Record<string, unknown>>(spec)
      expect(mod).toBeObject()
    }
  })
})
