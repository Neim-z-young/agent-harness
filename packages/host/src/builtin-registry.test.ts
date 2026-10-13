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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildOsBinding, verifyOsBinding } from '@harness/isolation'
import { ProviderTypeRegistry } from '@harness/plugin'
import type { AgentPlugin } from '@harness/plugin'
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
      'code-intel', 'computer-use', 'mcp.server-registry', 'mcp-server',
      'subagent', 'coordinator', 'swarm',
      'herdr', 'memory', 'skill-forge', 'env-context',
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
    for (const id of ['code-intel', 'computer-use', 'mcp.server-registry', 'mcp-server', 'subagent', 'coordinator', 'swarm', 'memory', 'skill-forge', 'herdr', 'env-context']) {
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

  it('planning-files 可从 id 实例化（真 import + 真工厂调用），且不在默认装配里', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['planning-files'])
    expect(unknown).toEqual([])
    expect(plugins.map((p) => p.id)).toEqual(['planning-files'])
    expect(typeof plugins[0]!.install).toBe('function')
    // optIn：不声明就不装配 —— 它每轮往请求尾部注入计划块，是有成本的行为
    const none = await resolveBuiltinPlugins([])
    expect(none.plugins.map((p) => p.id)).not.toContain('planning-files')
  })

  it('env-context 可从 id 实例化（真 import + 真工厂调用），且 optIn 不默认装配', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['env-context'])
    expect(unknown).toEqual([])
    expect(plugins.map((p) => p.id)).toEqual(['env-context'])
    expect(typeof plugins[0]!.install).toBe('function')
    // optIn：不声明就不装配 —— 它改 system 前缀与每轮请求尾，是有成本的行为
    const none = await resolveBuiltinPlugins([])
    expect(none.plugins.map((p) => p.id)).not.toContain('env-context')
  })

  it('env-context 拿到的是**解析后的实际档位**（P2-1：与 BashOutput.isolation 同一份事实）', async () => {
    // 带 isolationLevel 装配 ⇒ 前缀里出现「隔离」行；fsBound 由档位换算（L1 ⇒ 非 OS 级）
    const { plugins } = await resolveBuiltinPlugins(['env-context'], undefined, { sandbox: { net: 'deny' } } as never, 'L1')
    const hooks = await plugins[0]!.install({ workspace: { cwd: '/w' } } as never)
    const parts: string[] = []
    await hooks!['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's1', cwd: '/w' } as never, parts)
    expect(parts[0]).toInclude('- 隔离: L1')
    expect(parts[0]).toInclude('仅策略判定')
    // 网络策略按同一份 resolveNetPolicy 归一（与 bash 出网门同口径，不是另算一套）
    expect(parts[0]).toInclude('出网 deny')
  })

  it('env-context 无加载上下文时不出现「隔离」行（不猜档位）', async () => {
    const { plugins } = await resolveBuiltinPlugins(['env-context'])
    const hooks = await plugins[0]!.install({ workspace: { cwd: '/w' } } as never)
    const parts: string[] = []
    await hooks!['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's1', cwd: '/w' } as never, parts)
    expect(parts[0]).not.toInclude('隔离')
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

// ===== P0-1：config.json → sandbox 段真的透传进内置工具 =====

/** 从插件实例里取出它注入的工具池（走它自己声明的 core.tool.pool.assemble） */
async function toolsOf(plugin: AgentPlugin): Promise<
  Array<{ id: string; call: (input: unknown, ctx: unknown) => Promise<unknown> }>
> {
  // 只为拿 hook 的测试替身：ctx 只用到 log，故整体 cast（install 的实现不读别的字段）
  const install = plugin.install as unknown as (ctx: unknown) => Promise<unknown>
  const hooks = (await install({ log: { info() {}, warn() {}, error() {}, debug() {} } })) as Record<
    string,
    (input: unknown, pool: unknown) => Promise<void>
  >
  const out: Array<{ id: string; call: (input: unknown, ctx: unknown) => Promise<unknown> }> = []
  await hooks['core.tool.pool.assemble']!({}, { add: (t: unknown) => out.push(t as never) })
  return out
}

function toolCtx(cwd: string) {
  return {
    sessionId: 's1', agentId: 'default', messageId: 'm1', toolUseId: 't1',
    signal: new AbortController().signal, variables: {}, cwd,
    requestPermission: async () => ({ behavior: 'allow' }),
  }
}

describe('P0-1：sandbox 段透传（配置不再静默失效）', () => {
  it('★readDeny:false 真传到了 read_file（默认则拒读 .env）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-readdeny-'))
    try {
      writeFileSync(join(dir, '.env'), 'SECRET=1')
      const withCfg = await toolsOf(
        await getBuiltinRegistry().get('tools-builtin')!.load({ config: { sandbox: { readDeny: false } } }),
      )
      const rfOff = withCfg.find((t) => t.id === 'read_file')!
      expect(((await rfOff.call({ path: '.env' }, toolCtx(dir))) as { ok: boolean }).ok).toBe(true)

      // 对照：不带 config ⇒ 走内置清单，拒读
      const noCfg = await toolsOf(await getBuiltinRegistry().get('tools-builtin')!.load())
      const rfDef = noCfg.find((t) => t.id === 'read_file')!
      const denied = (await rfDef.call({ path: '.env' }, toolCtx(dir))) as { ok: boolean; error?: { code?: string } }
      expect(denied.ok).toBe(false)
      expect(denied.error?.code).toBe('SANDBOX_READ_DENIED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★bash.limits 也传到了（自定义值生效，且与默认值不同）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-limits-'))
    try {
      const tools = await toolsOf(
        await getBuiltinRegistry().get('tools-builtin')!.load({
          config: { sandbox: { limits: { maxFileSizeKb: 1024 } } },
        }),
      )
      const bash = tools.find((t) => t.id === 'bash')!
      const res = (await bash.call({ command: 'ulimit -f' }, toolCtx(dir))) as { output?: { stdout: string } }
      // darwin：1 单位 = 1024B ⇒ 1024KB = 1024；linux：512B ⇒ 2048
      // ⚠️ 同上（tools-builtin 那处）：MSYS/Git Bash 的 `ulimit -f` 回读不是数字 ⇒ 只在非 win32 上比对。
      if (process.platform !== 'win32') {
        expect(Number(res.output!.stdout.trim())).toBe(process.platform === 'darwin' ? 1024 : 2048)
      }

      // 与默认（2 GiB）对照 —— 这一条才是"配置真的起作用"的证据：
      // 只断言 limits:false ⇒ unlimited 是**无效**的，因为"根本没加抬头"也是 unlimited。
      const dflt = (await toolsOf(await getBuiltinRegistry().get('tools-builtin')!.load())).find((t) => t.id === 'bash')!
      const def = (await dflt.call({ command: 'ulimit -f' }, toolCtx(dir))) as { output?: { stdout: string } }
      expect(Number(def.output!.stdout.trim())).not.toBe(Number(res.output!.stdout.trim()))
      expect(Number(def.output!.stdout.trim())).toBe(process.platform === 'darwin' ? 2_097_152 : 4_194_304)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不写 sandbox 段 ⇒ 仍是默认装配（工具齐全、无副作用）', async () => {
    const tools = await toolsOf(await getBuiltinRegistry().get('tools-builtin')!.load({ config: {} }))
    expect(tools.map((t) => t.id).sort()).toEqual(['bash', 'bash_ro', 'edit_file', 'read_file', 'write_file'])
  })
})

describe('checkSandboxConfig：写了但不生效的键要有声音', () => {
  const { checkSandboxConfig } = require('./index') as { checkSandboxConfig: (c: unknown) => string[] }

  it('未识别键被点名', () => {
    const out = checkSandboxConfig({ allowList: ['ls'] })
    expect(out.some((m) => m.includes('sandbox.allowList') && m.includes('不会生效'))).toBe(true)
  })

  it('fallbackToHost=true 需要显式确认的提示', () => {
    expect(checkSandboxConfig({ fallbackToHost: true }).some((m) => m.includes('宿主 bash 全权'))).toBe(true)
    expect(checkSandboxConfig({ fallbackToHost: false })).toEqual([])
  })

  it('★P0-7：fallbackToHost 与 requireHostApproval:false 同时出现要单独点名（完全静默）', () => {
    const out = checkSandboxConfig({ fallbackToHost: true, requireHostApproval: false })
    expect(out.some((m) => m.includes('requireHostApproval') && m.includes('sandbox.escalation'))).toBe(true)
    // 只关确认、没开回退 ⇒ 无此告警（档位不会下沉）
    expect(checkSandboxConfig({ fallbackToHost: false, requireHostApproval: false }).join()).not.toContain('escalation')
  })

  it('空 limits 对象与缺类目的 readDeny 都会被指出', () => {
    expect(checkSandboxConfig({ limits: {} }).some((m) => m.includes('limits 是空对象'))).toBe(true)
    expect(checkSandboxConfig({ readDeny: { names: ['x'] } }).some((m) => m.includes('缺类目'))).toBe(true)
  })

  it('正常配置不报', () => {
    expect(checkSandboxConfig({ allowlist: ['ls'], limits: { maxFileSizeKb: 1024 }, readDeny: false })).toEqual([])
  })

  it('★P1-3：osBinding 写错值要出声（默认 off，写错也按 off ⇒ 静默失效）', () => {
    expect(checkSandboxConfig({ osBinding: true }).some((m) => m.includes('osBinding') && m.includes('按 off 处理'))).toBe(true)
    expect(checkSandboxConfig({ osBinding: 'on' })).toEqual([])
  })

  it('★P1-3：要求 L2 却不给用原语 ⇒ 一定达不到（提前说，别等启动时才发现）', () => {
    const out = checkSandboxConfig({ level: 'L2' })
    expect(out.some((m) => m.includes('L2') && m.includes('osBinding'))).toBe(true)
    // 给了原语就不报
    expect(checkSandboxConfig({ level: 'L2', osBinding: 'on' }).join()).not.toContain('osBinding')
  })
})

describe('checkMcpCapabilities：声明了但强制不了的要出声（P1-7）', () => {
  const { checkMcpCapabilities } = require('./index') as {
    checkMcpCapabilities: (s: unknown, o?: { osBindingAvailable?: boolean }) => string[]
  }

  it('没声明 ⇒ 不报（默认不受限，与改造前逐位一致）', () => {
    expect(checkMcpCapabilities([{ name: 'a', command: 'x' }], { osBindingAvailable: true })).toEqual([])
  })

  it('★有绑定 + 声明 fs:"cwd" ⇒ 真强制，不报', () => {
    expect(checkMcpCapabilities([{ name: 'a', capabilities: { fs: 'cwd' } }], { osBindingAvailable: true })).toEqual([])
  })

  it('★没绑定 + 声明 fs:"cwd" ⇒ 报（否则"我声明了"就是自我安慰）', () => {
    const out = checkMcpCapabilities([{ name: 'a', capabilities: { fs: 'cwd' } }], { osBindingAvailable: false })
    expect(out.some((m) => m.includes('a') && m.includes('只声明、不强制'))).toBe(true)
  })

  it('★net:"none" 在两种档位下都报（任何档位都强制不了子进程出网）', () => {
    for (const avail of [true, false]) {
      const out = checkMcpCapabilities([{ name: 'a', capabilities: { net: 'none' } }], { osBindingAvailable: avail })
      expect(out.some((m) => m.includes('强制不了子进程出网'))).toBe(true)
    }
  })

  it('非数组 / 非对象元素不炸', () => {
    expect(checkMcpCapabilities(undefined)).toEqual([])
    expect(checkMcpCapabilities([null, 3, {}])).toEqual([])
  })
})

describe('P1-2 / P1-4：net 策略与解析后的档位透传', () => {
  it('★net=deny 与 isolationLevel 都到了 bash 工具（执行期自述可见）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-net-'))
    try {
      const tools = await toolsOf(
        await getBuiltinRegistry().get('tools-builtin')!.load({
          config: { sandbox: { net: 'deny' } },
          isolationLevel: 'L2',
        }),
      )
      const bash = tools.find((t) => t.id === 'bash')!
      const denied = (await bash.call({ command: 'curl https://example.com' }, toolCtx(dir))) as {
        ok: boolean; error?: { code?: string }
      }
      expect(denied.ok).toBe(false)
      expect(denied.error?.code).toBe('SANDBOX_NET_DENIED')

      const ok = (await bash.call({ command: 'echo hi' }, toolCtx(dir))) as {
        output?: { isolation?: Record<string, unknown> }
      }
      // 档位是 boot 解析后的**事实**（这里注入 L2），netPolicy 是策略本身。
      // ★P1-3 起的口径：`fsBound` 由"这次真递了 OS 绑定没有"决定，**不再由档位推导** ——
      // 只注入档位而不递绑定 ⇒ false（不模拟：档位叫 L2 不等于真的绑上了）。
      expect(ok.output!.isolation).toEqual({ level: 'L2', fsBound: false, netPolicy: 'deny', viaHost: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 真跑原语 ⇒ 只在 darwin 有 sandbox-exec 时执行（构造出的绑定在别的平台上 spawn 不到）
  it.skipIf(process.platform !== 'darwin')('★P1-3：递了 osBinding 才报 fsBound=true（档位与绑定是两件独立的事实）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-osb-'))
    try {
      const binding = buildOsBinding({ platform: 'darwin', writable: [dir], primitives: { sandboxExec: true, bwrap: false, landlock: false } })
      const tools = await toolsOf(
        await getBuiltinRegistry().get('tools-builtin')!.load({ isolationLevel: 'L2', osBinding: binding }),
      )
      const bash = tools.find((t) => t.id === 'bash_ro')!
      const res = (await bash.call({ command: 'echo hi' }, toolCtx(dir))) as {
        output?: { isolation?: Record<string, unknown> }
      }
      // ★判据要跟着环境走：递了绑定**不等于**绑上了 —— 嵌套沙箱（如本机 bun test 落在
      // WorkBuddy 沙箱内）下内核会拒 apply，此时 `fsBound` 必须是 false（并标 `fsBoundFailed`）。
      // 也就是"工具如实回传"这件事，两种环境都成立。
      const reallyBound = verifyOsBinding(binding!)
      expect(res.output!.isolation?.fsBound).toBe(reallyBound)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★readMaxBytes 透传到 read_file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-readmax-'))
    try {
      writeFileSync(join(dir, 'big.log'), 'x'.repeat(4096))
      const tools = await toolsOf(
        await getBuiltinRegistry().get('tools-builtin')!.load({ config: { sandbox: { readMaxBytes: 1024 } } }),
      )
      const rf = tools.find((t) => t.id === 'read_file')!
      const res = (await rf.call({ path: 'big.log' }, toolCtx(dir))) as { ok: boolean; error?: { code?: string } }
      expect(res.ok).toBe(false)
      expect(res.error?.code).toBe('SANDBOX_READ_TOO_LARGE')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bash_ro 也拿到档位（只读侧同样自述边界）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-ro-'))
    try {
      const tools = await toolsOf(
        await getBuiltinRegistry().get('tools-builtin')!.load({
          config: { sandbox: { level: 'L1' } },
          isolationLevel: 'L1',
        }),
      )
      const ro = tools.find((t) => t.id === 'bash_ro')!
      const res = (await ro.call({ command: 'echo hi' }, toolCtx(dir))) as {
        output?: { isolation?: Record<string, unknown> }
      }
      expect(res.output!.isolation!.level).toBe('L1')
      expect(res.output!.isolation!.fsBound).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checkSandboxConfig：net / level / onUnmet / readMaxBytes 的非法值与缺白名单都被点名', () => {
    const { checkSandboxConfig } = require('./index') as { checkSandboxConfig: (c: unknown) => string[] }
    expect(checkSandboxConfig({ net: 'allowlist' }).some((m) => m.includes('netAllow'))).toBe(true)
    expect(checkSandboxConfig({ net: 'block' }).some((m) => m.includes('合法取值'))).toBe(true)
    expect(checkSandboxConfig({ level: 'L9' }).some((m) => m.includes('合法档位'))).toBe(true)
    expect(checkSandboxConfig({ onUnmet: 'explode' }).some((m) => m.includes('合法取值'))).toBe(true)
    expect(checkSandboxConfig({ readMaxBytes: -1 }).some((m) => m.includes('非负数'))).toBe(true)
    // 合法组合不报
    expect(checkSandboxConfig({
      net: 'allowlist', netAllow: ['github.com'], level: 'L1', onUnmet: 'warn', readMaxBytes: 1024,
    })).toEqual([])
  })
})
