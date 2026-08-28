import { describe, it, expect, beforeEach } from 'bun:test'
import { BusEvent, createBus, InMemoryBus } from '@harness/bus'
import {
  AgentPlugin,
  Hooks,
  PluginCircularDependencyError,
  PluginDuplicateIdError,
  PluginHookError,
  PluginInstallError,
  PluginManager,
  PluginManagerImpl,
  PluginMissingDependencyError,
  PluginNotFoundError,
  PluginUninstallError,
  ProviderTypeRegistry,
  createPluginManager,
  resolveProviderTypeFactory,
  topologicalSortPlugins,
} from './index'

// ===== 插件工厂 helper =====

let seq = 0
function makePlugin(
  id: string,
  options: {
    dependsOn?: string[]
    hooks?: Hooks
    failInstall?: boolean
    failUninstall?: boolean
    version?: string
    track?: Partial<{
      installed: number[]
      uninstalled: number[]
    }>
  } = {}
): AgentPlugin {
  const { dependsOn, hooks, failInstall, failUninstall, version = '1.0.0', track } = options
  return {
    id,
    version,
    name: id,
    description: 'test plugin ' + id,
    dependsOn,
    async install(ctx) {
      const n = ++seq
      if (failInstall) throw new Error(`install-${id}-boom`)
      track?.installed?.push(n)
      ;(ctx as any).__order = n
      return hooks
    },
    async uninstall() {
      const n = ++seq
      track?.uninstalled?.push(n)
      if (failUninstall) throw new Error(`uninstall-${id}-boom`)
    },
  }
}

describe('@harness/plugin', () => {
  let bus: InMemoryBus

  beforeEach(() => {
    bus = createBus() as InMemoryBus
    seq = 0
  })

  describe('topologicalSortPlugins', () => {
    it('无依赖 → 保持输入顺序', () => {
      const a = makePlugin('a')
      const b = makePlugin('b')
      const out = topologicalSortPlugins([a, b])
      expect(out.map((p) => p.id)).toEqual(['a', 'b'])
    })

    it('简单链 A→B→C → 结果 [A,B,C]', () => {
      const C = makePlugin('C')
      const B = makePlugin('B', { dependsOn: ['C'] })
      const A = makePlugin('A', { dependsOn: ['B'] })
      const out = topologicalSortPlugins([A, B, C])
      expect(out.map((p) => p.id)).toEqual(['C', 'B', 'A'])
    })

    it('DAG: D 依赖 A&B，A 依赖 C → C 在 A 之前，A&B 在 D 之前', () => {
      const A = makePlugin('A', { dependsOn: ['C'] })
      const B = makePlugin('B')
      const C = makePlugin('C')
      const D = makePlugin('D', { dependsOn: ['A', 'B'] })
      const ordered = topologicalSortPlugins([A, B, C, D])
      const idx = new Map(ordered.map((p, i) => [p.id, i]))
      // C 在 A 前
      expect(idx.get('C')!).toBeLessThan(idx.get('A')!)
      // A 在 D 前
      expect(idx.get('A')!).toBeLessThan(idx.get('D')!)
      // B 在 D 前
      expect(idx.get('B')!).toBeLessThan(idx.get('D')!)
    })

    it('重复 ID 抛 PluginDuplicateIdError', () => {
      const a1 = makePlugin('dup')
      const a2 = makePlugin('dup')
      expect(() => topologicalSortPlugins([a1, a2])).toThrow(PluginDuplicateIdError)
    })

    it('跨批依赖（依赖不在批内）→ 该节点当没有批内依赖处理，可正常排序', () => {
      const A = makePlugin('A', { dependsOn: ['MISSING-LOADED-EARLIER'] })
      const B = makePlugin('B', { dependsOn: ['A'] })
      const out = topologicalSortPlugins([A, B])
      expect(out.map((p) => p.id)).toEqual(['A', 'B'])
    })

    it('A→B→A 循环依赖 → PluginCircularDependencyError', () => {
      const A = makePlugin('A', { dependsOn: ['B'] })
      const B = makePlugin('B', { dependsOn: ['A'] })
      const err = (() => {
        try {
          topologicalSortPlugins([A, B])
          return null
        } catch (e) {
          return e
        }
      })()
      expect(err).toBeInstanceOf(PluginCircularDependencyError)
      const cycle = (err as PluginCircularDependencyError).cycle
      expect(cycle[0]).toBe(cycle[cycle.length - 1]) // cycle 闭合
      expect(['A', 'B']).toEqual(expect.arrayContaining(cycle)) // 包含两节点
    })

    it('3 节点环 A→B→C→A → 循环依赖错误', () => {
      const A = makePlugin('A', { dependsOn: ['C'] })
      const B = makePlugin('B', { dependsOn: ['A'] })
      const C = makePlugin('C', { dependsOn: ['B'] })
      expect(() => topologicalSortPlugins([A, B, C])).toThrow(PluginCircularDependencyError)
    })
  })

  describe('PluginManager (Internal)', () => {
    it('factory createPluginManager 返回 PluginManagerImpl 实例', () => {
      const pm = createPluginManager({ bus })
      expect(pm).toBeInstanceOf(PluginManagerImpl)
    })

    it('loadInternal 拓扑排序 install，按依赖顺序调用', async () => {
      const track = { installed: [] as number[] }
      const C = makePlugin('C', { track })
      const B = makePlugin('B', { dependsOn: ['C'], track })
      const A = makePlugin('A', { dependsOn: ['B'], track })

      const pm = createPluginManager({ bus })
      // 故意乱序传入
      await pm.loadInternal([A, C, B])
      const ids = pm.list().map((p) => p.plugin.id)
      // 顺序应该是 C, B, A
      expect(ids).toEqual(['C', 'B', 'A'])
      // 安装顺序也是 C 的序号 < B < A
      expect(track.installed[0]).toBeLessThan(track.installed[1]!)
      expect(track.installed[1]).toBeLessThan(track.installed[2]!)
    })

    it('list 返回 LoadedPlugin 元信息', async () => {
      const A = makePlugin('A')
      const pm = createPluginManager({ bus })
      const nowBefore = Date.now()
      await pm.loadInternal([A])
      const nowAfter = Date.now()
      const lp = pm.list()[0]!
      expect(lp.plugin).toBe(A)
      expect(lp.source).toBe('internal')
      expect(lp.loadedAt).toBeGreaterThanOrEqual(nowBefore)
      expect(lp.loadedAt).toBeLessThanOrEqual(nowAfter)
    })

    it('重复 ID 抛 PluginDuplicateIdError', async () => {
      const A = makePlugin('A')
      const A2 = makePlugin('A')
      const pm = createPluginManager({ bus })
      await pm.loadInternal([A])
      const err = await pm.loadInternal([A2]).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(PluginDuplicateIdError)
      expect((err as PluginDuplicateIdError).pluginId).toBe('A')
    })

    it('install 抛错时 PluginInstallError', async () => {
      const X = makePlugin('X', { failInstall: true })
      const pm = createPluginManager({ bus })
      const err = await pm.loadInternal([X]).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(PluginInstallError)
      expect((err as PluginInstallError).pluginId).toBe('X')
      expect(err.message).toContain('install-X-boom')
      expect(pm.list()).toHaveLength(0) // 失败的插件不会留在表中
    })

    it('install 抛错不会中断之前已成功安装的插件', async () => {
      const track = { installed: [] as number[] }
      const A = makePlugin('A', { track })
      const B = makePlugin('B', { dependsOn: ['A'], track, failInstall: true })
      const pm = createPluginManager({ bus })
      // 同一批：拓扑排序 [A, B]，A 成功，B 失败，但已安装的 A 是否还能保持？
      // 我们当前实现 installOne 是逐个提交到 this.loaded，所以 A 会保留
      await pm.loadInternal([B, A]).catch(() => null)
      const ids = pm.list().map((p) => p.plugin.id)
      expect(ids).toEqual(['A'])
    })

    it('unload: 未存在的 id → PluginNotFoundError', async () => {
      const pm = createPluginManager({ bus })
      const err = await pm.unload('nope').then(() => null, (e) => e)
      expect(err).toBeInstanceOf(PluginNotFoundError)
      expect((err as PluginNotFoundError).pluginId).toBe('nope')
    })

    it('unload: uninstall 抛 PluginUninstallError', async () => {
      const track = { installed: [] as number[], uninstalled: [] as number[] }
      const A = makePlugin('A', { track, failUninstall: true })
      const pm = createPluginManager({ bus })
      await pm.loadInternal([A])
      const err = await pm.unload('A').then(() => null, (e) => e)
      expect(err).toBeInstanceOf(PluginUninstallError)
      expect(err.message).toContain('uninstall-A-boom')
      // unload 失败时 load 仍在表中（保持一致性，未清理状态）
      expect(pm.list().map((p) => p.plugin.id)).toEqual(['A'])
    })

    it('unload: 正常流程调用 uninstall() 插件清理', async () => {
      const track = { installed: [] as number[], uninstalled: [] as number[] }
      const A = makePlugin('A', { track })
      const B = makePlugin('B', { dependsOn: ['A'], track })
      const pm = createPluginManager({ bus })
      await pm.loadInternal([A, B])
      await pm.unload('A')
      expect(track.uninstalled).toHaveLength(1)
      expect(pm.list().map((p) => p.plugin.id)).toEqual(['B'])
    })

    it('hotReload 未加载 → NotFound', async () => {
      const pm = createPluginManager({ bus })
      const err = await pm.hotReload('z').then(() => null, (e) => e)
      expect(err).toBeInstanceOf(PluginNotFoundError)
    })

    it('hotReload Internal: 卸载后重新安装', async () => {
      const track = { installed: [] as number[], uninstalled: [] as number[] }
      const A = makePlugin('A', { track })
      const pm = createPluginManager({ bus })
      await pm.loadInternal([A])
      expect(track.installed).toHaveLength(1)
      expect(track.uninstalled).toHaveLength(0)

      await pm.hotReload('A')
      expect(track.uninstalled).toHaveLength(1)
      expect(track.installed).toHaveLength(2) // 第二次 install
      const ids = pm.list().map((p) => p.plugin.id)
      expect(ids).toEqual(['A'])
    })
  })

  describe('PluginManager (loadBuiltin / loadUser via injected dynamicImport)', () => {
    it('loadBuiltin 通过 dynamicImport 解析默认导出', async () => {
      const FakeA = makePlugin('fake-a', { version: '2.0.0' })
      const FakeB = makePlugin('fake-b', { dependsOn: ['fake-a'], version: '3.0.0' })

      const dynamicImport = async (spec: string) => {
        if (spec === 'npm:fake-a') return { default: FakeA }
        if (spec === 'npm:fake-b') return { default: FakeB }
        throw new Error('unknown spec: ' + spec)
      }

      const pm = createPluginManager({ bus, dynamicImport: dynamicImport as any })
      await pm.loadBuiltin(['npm:fake-a', 'npm:fake-b'])
      const ids = pm.list().map((p) => p.plugin.id)
      expect(ids).toEqual(['fake-a', 'fake-b'])
      expect(pm.list().every((p) => p.source === 'builtin')).toBe(true)
    })

    it('loadUser 解析命名导出 { plugin }', async () => {
      const U = makePlugin('user-p')
      const dynamicImport = async (spec: string) => {
        expect(spec).toBe('file:///Users/me/plugin.mjs')
        return { plugin: U }
      }
      const pm = createPluginManager({ bus, dynamicImport })
      await pm.loadUser(['file:///Users/me/plugin.mjs'])
      const ids = pm.list().map((p) => p.plugin.id)
      expect(ids).toEqual(['user-p'])
      expect(pm.list()[0]!.source).toBe('user')
    })

    it('spec 未导出有效 AgentPlugin 时抛 PluginInstallError', async () => {
      const dynamicImport = async (_s: string) => ({ foo: 1 })
      const pm = createPluginManager({ bus, dynamicImport })
      const err = await pm.loadUser(['not-a-plugin']).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(PluginInstallError)
      expect(err.message).toContain('did not export a valid AgentPlugin')
    })

    it('loadBuiltin 重复 ID 抛 PluginDuplicateIdError（跨内/外部也一样）', async () => {
      const A = makePlugin('A')
      const dynamicImport = async () => ({ default: makePlugin('A', { version: 'other' }) })
      const pm = createPluginManager({ bus, dynamicImport })
      await pm.loadInternal([A])
      const err = await pm.loadBuiltin(['spec-for-a']).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(PluginDuplicateIdError)
    })
  })

  describe('PluginContext', () => {
    it('config.get/set 通过内存 store 工作', async () => {
      let got: unknown
      const P = makePlugin('cfg', {
        hooks: {
          async 'harness.init'(_i, _o) {},
        },
      })
      const pm = createPluginManager({
        bus,
        initialConfig: { 'flag.foo': true },
        // 通过 logger 没暴露 ctx；换做法：重写 plugin.install
      }) as any
      // 用 spy 插件在 install 里读/写 config
      const probe: AgentPlugin = {
        id: 'probe',
        version: '1',
        name: 'probe',
        async install(ctx) {
          got = ctx.config.get('flag.foo')
          ctx.config.set('flag.foo', 'modified')
          return {}
        },
      }
      await pm.loadInternal([probe])
      expect(got).toBe(true)
      // 写入对其他插件也可见（后续触发时都同一份 ctx.config）
      const pm2 = createPluginManager({ bus })
      const probe2: AgentPlugin = {
        id: 'probe2',
        version: '1',
        name: 'probe2',
        async install(ctx) {
          ctx.config.set('key', 'v')
          return {}
        },
      }
      const reader: AgentPlugin = {
        id: 'reader',
        version: '1',
        name: 'reader',
        dependsOn: ['probe2'],
        async install(ctx) {
          ;(this as any)._val = ctx.config.get('key')
          return {}
        },
      }
      await pm2.loadInternal([probe2, reader])
      expect((reader as any)._val).toBe('v')
    })
  })

  describe('Hook trigger 管道', () => {
    it('trigger("harness.init") 顺序调用所有注册的 hook，mutate input/output', async () => {
      const pm = createPluginManager({ bus })
      const traces: string[] = []
      const P1 = makePlugin('p1', {
        hooks: {
          async 'harness.init'(input, output) {
            traces.push('p1:' + (input.harnessOptions as any).id)
            output.harness = 'from-p1'
          },
        },
      })
      const P2 = makePlugin('p2', {
        dependsOn: ['p1'],
        hooks: {
          async 'harness.init'(input, output) {
            traces.push('p2')
            expect(output.harness).toBe('from-p1')
          },
        },
      })
      await pm.loadInternal([P2, P1]) // 故意乱序，依赖排序让 p1 先
      const input: any = { harnessOptions: { id: 'test' } }
      const output: any = { harness: undefined }
      await pm.trigger('harness.init', input, output)
      expect(traces).toEqual(['p1:test', 'p2'])
      expect(output.harness).toBe('from-p1')
    })

    it('未注册 hook 的 trigger 不报错', async () => {
      const pm = createPluginManager({ bus })
      await pm.trigger('harness.start', { harness: {} as any }, { started: false })
      // 通过
    })

    it('某个 hook 失败 → 抛 PluginHookError 包含 pluginId', async () => {
      const pm = createPluginManager({ bus })
      const Bad = makePlugin('bad', {
        hooks: {
          async 'llm.params'() {
            throw new Error('bad-hook')
          },
        },
      })
      const Good = makePlugin('good', {
        hooks: {
          async 'llm.params'(i, params) {
            params.touched = true
          },
        },
      })
      await pm.loadInternal([Bad, Good])
      const params: any = {}
      const err = await pm.trigger('llm.params', { providerId: 'x', messages: [] }, params)
        .then(() => null, (e) => e)
      expect(err).toBeInstanceOf(PluginHookError)
      expect((err as PluginHookError).pluginId).toBe('bad')
      expect((err as PluginHookError).hookName).toBe('llm.params')
    })

    it('多个 hook 都失败 → AggregateError', async () => {
      const pm = createPluginManager({ bus })
      const A = makePlugin('A', {
        hooks: { async 'session.compacting'() { throw new Error('A-err') } },
      })
      const B = makePlugin('B', {
        hooks: { async 'session.compacting'() { throw new Error('B-err') } },
      })
      await pm.loadInternal([A, B])
      const err = await pm.trigger('session.compacting', { agentId: '', sessionId: '' }, {}).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(AggregateError)
      expect((err as AggregateError).errors.map((e: any) => e.message).join(',')).toContain('A-err')
      expect((err as AggregateError).errors.map((e: any) => e.message).join(',')).toContain('B-err')
    })

    it('unload 插件会移除 hooks', async () => {
      const pm = createPluginManager({ bus })
      let called = 0
      const P = makePlugin('P', {
        hooks: {
          async 'permission.check'(req, dec) {
            called++
            req.from = 'touched'
          },
        },
      })
      await pm.loadInternal([P])
      const req: any = { toolKey: 'w', patterns: [], input: null }
      await pm.trigger('permission.check', req, { behavior: 'allow' })
      expect(called).toBe(1)

      await pm.unload('P')
      await pm.trigger('permission.check', req, { behavior: 'allow' })
      expect(called).toBe(1) // 不再调用
    })
  })

  describe('bus.event Hook 桥接', () => {
    it('插件声明 bus.event Hook → 自动订阅所有 Bus 事件', async () => {
      const pm = createPluginManager({ bus })
      const events: { name: string; payload: any }[] = []
      const P = makePlugin('logger', {
        hooks: {
          async 'bus.event'(rec) {
            events.push({ name: rec.name, payload: rec.payload })
          },
        },
      })
      await pm.loadInternal([P])

      const Ev1 = BusEvent.define<{ id: string }>('msg.created')
      const Ev2 = BusEvent.define<number>('counter.inc')
      await bus.publish(Ev1, { id: 'abc' })
      await bus.publish(Ev2, 7)

      expect(events.map((e) => e.name)).toEqual(['msg.created', 'counter.inc'])
      expect(events[0]!.payload).toEqual({ id: 'abc' })
      expect(events[1]!.payload).toBe(7)
    })

    it('bus.event Hook 抛错时不中断 Bus 发布（日志记录）', async () => {
      const logs: { msg: string; meta?: unknown }[] = []
      const logger = {
        info() {},
        warn() {},
        debug() {},
        error(msg: string, meta: unknown) {
          logs.push({ msg, meta })
        },
      }
      const pm = createPluginManager({ bus, logger })
      const Bad = makePlugin('bad-logger', {
        hooks: {
          async 'bus.event'() {
            throw new Error('bus-handler-crash')
          },
        },
      })
      await pm.loadInternal([Bad])

      const E = BusEvent.define<{ ok: boolean }>('e.test')
      // 发布不应抛错（因为 bus subscribeAll 内已经 try/catch）
      await bus.publish(E, { ok: true })
      // 错误被 logger.error 记录（日志里包含 "bus.event handler failed"）
      const err = logs.find((l) => l.msg.includes('bus.event handler failed'))
      expect(err).toBeDefined()
    })

    it('卸载插件后 bus.event 不再被调用', async () => {
      let n = 0
      const pm = createPluginManager({ bus })
      const P = makePlugin('c', {
        hooks: { async 'bus.event'() { n++ } },
      })
      await pm.loadInternal([P])
      const E = BusEvent.define<{ v: number }>('e.v')
      await bus.publish(E, { v: 1 })
      await bus.publish(E, { v: 2 })
      expect(n).toBe(2)

      await pm.unload('c')
      await bus.publish(E, { v: 3 })
      expect(n).toBe(2)
    })
  })

  describe('HooksRegistry 直接 API', () => {
    const { HooksRegistry } = require('./index')
    it('register / unregister / listFor / has 工作', () => {
      const reg = new HooksRegistry()
      const hooksP: Hooks = {
        async 'harness.init'() {},
        async 'harness.start'() {},
      }
      const hooksQ: Hooks = {
        async 'harness.init'() {},
      }
      reg.register('p', hooksP)
      reg.register('q', hooksQ)

      expect(reg.has('harness.init')).toBe(true)
      expect(reg.has('session.compacting')).toBe(false)
      expect(reg.listFor('harness.init').map((r: any) => r.pluginId)).toEqual(['p', 'q'])
      expect(reg.listFor('harness.start').map((r: any) => r.pluginId)).toEqual(['p'])

      reg.unregister('p')
      expect(reg.has('harness.start')).toBe(false)
      expect(reg.listFor('harness.init').map((r: any) => r.pluginId)).toEqual(['q'])
    })
  })

  describe('Provider 抽象契约（ProviderTypeRegistry / resolveProviderTypeFactory）', () => {
    it('ProviderTypeRegistry：register / resolve / list / clear', () => {
      const reg = new ProviderTypeRegistry()
      reg.register({ type: 'a', createPlugin: () => undefined })
      reg.register({ type: 'b', createPlugin: () => undefined })
      expect(reg.list().sort()).toEqual(['a', 'b'])
      expect(reg.resolve('a')?.type).toBe('a')
      expect(reg.resolve('nope')).toBeUndefined()
      // 后注册覆盖
      reg.register({ type: 'a', createPlugin: () => undefined })
      expect(reg.resolve('a')).toBeDefined()
      reg.clear()
      expect(reg.list()).toEqual([])
    })

    it('resolveProviderTypeFactory：直接导出 providerTypeFactory 形态', () => {
      const mod = {
        providerTypeFactory: {
          type: 'gw',
          createPlugin: (c: any) => ({ id: 'provider.gw' }),
        },
      }
      const factory = resolveProviderTypeFactory(mod)
      expect(factory?.type).toBe('gw')
      expect(factory?.createPlugin({ id: 'x', type: 'gw' })).toEqual({ id: 'provider.gw' })
    })

    it('resolveProviderTypeFactory：providerType + createProviderPlugin 形态', () => {
      const mod = {
        providerType: 'gw2',
        createProviderPlugin: (c: any) => ({ id: 'provider.gw2' }),
      }
      const factory = resolveProviderTypeFactory(mod)!
      expect(factory.type).toBe('gw2')
      expect(factory.createPlugin({ id: 'x', type: 'gw2' })).toEqual({ id: 'provider.gw2' })
    })

    it('resolveProviderTypeFactory：default 包装内亦能识别', () => {
      const mod = {
        default: {
          providerTypeFactory: {
            type: 'gw3',
            createPlugin: (c: any) => undefined,
          },
        },
      }
      expect(resolveProviderTypeFactory(mod)?.type).toBe('gw3')
    })

    it('resolveProviderTypeFactory：无契约模块返回 undefined', () => {
      expect(resolveProviderTypeFactory({ foo: 1 })).toBeUndefined()
      expect(resolveProviderTypeFactory({ providerTypeFactory: 42 })).toBeUndefined()
    })
  })
})
