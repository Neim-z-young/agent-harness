/**
 * `loadPluginDirs` 簇的归属测试（从 `cli.test.ts` 迁出后的新家）。
 *
 * ## 与 cli 侧测试的关系（P0 收尾 S4 已收口）
 * 搬迁期 `cli.test.ts` 原样保留了一份同能力用例（"re-export 兼容"口径，9 条）。S4 收口按
 * 「**能力归 host，兼容归 cli**」去重：cli 侧重复的行为用例已删除，只留一条 re-export
 * 兼容断言（见 `cli.test.ts`）；本文件是**唯一**的能力测试 —— 覆盖实现本身，且不经过 cli。
 * 其中「相对路径导入失败按原样告警」原先只在 cli 侧有覆盖，已一并移入本文件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderTypeRegistry } from '@harness/plugin'
import { collectAgentPlugins, loadPluginDirs } from './index'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-host-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadPluginDirs：代码注入闸门', () => {
  it('默认只扫描不加载，告警说明两条开闸路径，且绝不补 node_modules 软链', async () => {
    const pluginDir = join(dir, 'injected', 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'evil.ts'), `
      export const plugins = [{ id: 'ext.injected', version: '1', name: 'x', async install() { return {} } }]
    `)

    const logs: string[] = []
    const result = await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], (s) => logs.push(s))

    expect(result.plugins).toEqual([])
    const text = logs.join('')
    expect(text).toContain('已跳过')
    expect(text).toContain('防止代码注入')
    expect(text).toContain('allowPluginCode')
    // 不允许软链关联 harness 内核文件（曾实现过，已移除）
    expect(existsSync(join(pluginDir, 'node_modules'))).toBe(false)
    expect(existsSync(join(pluginDir, '.gitignore'))).toBe(false)
  })

  it('allowCode: true 时才真正 import 插件代码', async () => {
    const pluginDir = join(dir, 'optin', 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'gen.ts'), `
      export const plugins = [{ id: 'ext.optin', version: '1', name: 'OptIn', async install() { return {} } }]
    `)

    const result = await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], undefined, { allowCode: true })
    expect(result.plugins.map((p) => p.id)).toEqual(['ext.optin'])
  })
})

describe('loadPluginDirs：多形态导出与多级覆盖', () => {
  it('通用 AgentPlugin 的 default / plugin / plugins 三种形态都能抽出（去重按 id）', async () => {
    const pluginDir = join(dir, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'gen.ts'), `
      export const statusPlugin = { id: 'ext.status', version: '1', name: 'Status', async install() { return {} } }
      export const helloPlugin = { id: 'ext.hello', version: '1', name: 'Hello', async install() { return {} } }
      export default { id: 'ext.default', version: '1', name: 'Default', async install() { return {} } }
      export const plugin = { id: 'ext.named', version: '1', name: 'Named', async install() { return {} } }
      export const plugins = [ { id: 'ext.arr', version: '1', name: 'Arr', async install() { return {} } } ]
    `)

    const result = await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], undefined, { allowCode: true })
    expect(result.plugins.map((p) => p.id).sort()).toEqual(['ext.arr', 'ext.default', 'ext.named'])
  })

  it('Provider 类型工厂（providerTypeFactory 形态）注册进 registry，且不产生通用插件', async () => {
    const pluginDir = join(dir, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'factory.ts'), `
      export const providerTypeFactory = {
        type: 'local-gw',
        createPlugin: () => ({ id: 'provider.local-gw', version: '1', name: 'LocalGW', async install() { return {} } }),
      }
    `)

    const reg = new ProviderTypeRegistry()
    const result = await loadPluginDirs(reg, [pluginDir], undefined, { allowCode: true })

    expect(reg.list()).toContain('local-gw')
    expect((await reg.resolve('local-gw')!.createPlugin({ id: 'x', type: 'local-gw' }))!.id).toBe('provider.local-gw')
    // Provider 工厂不产生通用插件
    expect(result.plugins).toEqual([])
  })

  it('providerType + createProviderPlugin 的旧约定同样可加载', async () => {
    const pluginDir = join(dir, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'my-gw.ts'), `
      export const providerType = 'my-gw'
      export function createProviderPlugin(config) {
        return { id: 'provider.my-gw', version: '1.0.0', name: 'MyGW Provider', async install() { return {} } }
      }
    `)

    const reg = new ProviderTypeRegistry()
    const result = await loadPluginDirs(reg, [pluginDir], undefined, { allowCode: true })

    expect(reg.list()).toContain('my-gw')
    expect(result.plugins).toEqual([])
  })

  it('多级目录：project 后加载覆盖 user（同名 Provider 与同 id 通用插件都只留一份）', async () => {
    const userDir = join(dir, 'user-plugins')
    const projDir = join(dir, 'proj-plugins')
    mkdirSync(userDir, { recursive: true })
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(userDir, 'p.ts'), `export const providerType = 'dup'; export function createProviderPlugin(c){ return { id: 'provider.dup.user', version: '1', name: 'user', async install(){} } }`)
    writeFileSync(join(projDir, 'p.ts'), `export const providerType = 'dup'; export function createProviderPlugin(c){ return { id: 'provider.dup.proj', version: '1', name: 'proj', async install(){} } }`)
    writeFileSync(join(userDir, 'gen.ts'), `export default { id: 'ext.same', version: '1', name: 'user', async install(){} }`)
    writeFileSync(join(projDir, 'gen.ts'), `export default { id: 'ext.same', version: '2', name: 'proj', async install(){} }`)

    const reg = new ProviderTypeRegistry()
    const result = await loadPluginDirs(reg, [userDir, projDir], undefined, { allowCode: true })

    expect((await reg.resolve('dup')!.createPlugin({ id: 'x', type: 'dup' }))!.id).toBe('provider.dup.proj')
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0].name).toBe('proj')
  })
})

describe('loadPluginDirs：失败隔离', () => {
  it('无有效导出的坏文件被忽略并告警，不阻断同批其它插件', async () => {
    const pluginDir = join(dir, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'bad.ts'), `export const foo = 1`)
    writeFileSync(join(pluginDir, 'good.ts'), `export default { id: 'ext.good', version: '1', name: 'Good', async install(){} }`)

    const warns: string[] = []
    const result = await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], (s) => warns.push(s), { allowCode: true })

    expect(warns.some((w) => w.includes('已忽略'))).toBe(true)
    expect(result.plugins.map((p) => p.id)).toEqual(['ext.good'])
  })

  it('裸依赖解析不到时，告警附带「改用 config.json → plugins」提示', async () => {
    const pluginDir = join(dir, 'missing-dep-plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'bad.ts'), `
      import { y } from 'definitely-not-installed-xyz'
      export const plugins = [{ id: 'ext.bad', version: '1', name: String(y), async install() { return {} } }]
    `)

    const logs: string[] = []
    await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], (s) => logs.push(s), { allowCode: true })

    const text = logs.join('')
    expect(text).toContain('插件加载失败')
    expect(text).toContain('config.json → "plugins"')
  })

  it('相对路径导入失败按原样告警（不再有补锚点逻辑）', async () => {
    const pluginDir = join(dir, 'relative-plugins')
    mkdirSync(pluginDir, { recursive: true })
    // 用上导入的绑定，避免被 Bun 当死代码消除而根本不解析
    writeFileSync(join(pluginDir, 'bad.ts'), `
      import { x } from './nowhere'
      export const plugins = [{ id: 'ext.bad', version: '1', name: String(x), async install() { return {} } }]
    `)
    const logs: string[] = []
    const result = await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], (s) => logs.push(s), { allowCode: true })
    expect(result.plugins).toEqual([])
    expect(logs.some((l) => l.includes('插件加载失败'))).toBe(true)
    expect(existsSync(join(pluginDir, 'node_modules'))).toBe(false)
  })

  it('log 回调缺省时退化写 stderr（不抛错）', async () => {
    const pluginDir = join(dir, 'empty')
    mkdirSync(pluginDir, { recursive: true })
    const result = await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], undefined, { allowCode: true })
    expect(result.plugins).toEqual([])
  })
})

describe('collectAgentPlugins', () => {
  it('兼容 default 里再包一层 plugin / plugins 命名导出', () => {
    const mod = {
      default: {
        plugin: { id: 'ext.wrapped-plugin', version: '1', name: 'W', async install() {} },
        plugins: [{ id: 'ext.wrapped-arr', version: '1', name: 'A', async install() {} }],
      },
    }
    expect(collectAgentPlugins(mod).map((p) => p.id).sort()).toEqual(['ext.wrapped-arr', 'ext.wrapped-plugin'])
  })

  it('id + install 缺一即不算插件', () => {
    expect(collectAgentPlugins({ default: { id: 'no-install' } })).toEqual([])
    expect(collectAgentPlugins({ default: { install() {} } })).toEqual([])
  })
})
