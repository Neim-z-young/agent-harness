/**
 * P1-5 的两半：**能力面收窄**（`plugin-context`）与 **worker 装载后端**（`plugin-runner`）。
 *
 * 两半的共同纪律：**只说能做到的**。
 * - 能力收窄管的是"宿主主动递出的四件"，不是安全边界（插件照样 `import('node:fs')`）；
 * - worker 给的是资源与故障边界，不是安全边界（实测 env / pid / fs 与宿主一致）。
 * 这些不是免责声明 —— 它们是判据：如果哪天有人把它当墙用，用例里这几条会显得很怪。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGIN_CAPABILITIES,
  applyPluginCapabilities,
  formatCapabilityGrant,
  loadPluginsInWorker,
  narrowPluginContext,
  resolvePluginCapabilities,
} from './index'
import type { PluginContext } from '@harness/plugin'

function makeCtx(): PluginContext {
  return {
    bus: { on: () => () => {}, emit: () => {} } as never,
    config: { get: () => undefined, set: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    workspace: { projectRoot: '/p' } as never,
  }
}

describe('resolvePluginCapabilities / narrowPluginContext（P1-5 能力收窄）', () => {
  it('没声明过这张表 ⇒ undefined（调用方据此不做 Proxy，零开销、逐位等于改造前）', () => {
    expect(resolvePluginCapabilities('a', undefined)).toBeUndefined()
    expect(resolvePluginCapabilities('a', { b: ['log'] })).toBeUndefined()
  })

  it('精确 id 覆盖 "*" 模板（模板只作兜底，不合并）', () => {
    const table = { '*': ['log'] as const, special: ['bus', 'log'] as const }
    expect(resolvePluginCapabilities('special', table as never)).toEqual(['bus', 'log'])
    expect(resolvePluginCapabilities('other', table as never)).toEqual(['log'])
  })

  it('★未声明的通道**取用即抛**，且给出可执行指引（不是静默给空对象）', () => {
    const ctx = narrowPluginContext(makeCtx(), ['log'])
    expect(() => (ctx as unknown as { bus: unknown }).bus).toThrow(/怎么改/)
    expect(() => (ctx as unknown as { bus: unknown }).bus).toThrow(/pluginCapabilities/)
    // 已声明的照常
    expect(typeof (ctx as unknown as { log: unknown }).log).toBe('object')
  })

  it('`in` 也如实反映（插件可以用它探测而不是靠 try/catch）', () => {
    const ctx = narrowPluginContext(makeCtx(), ['log'])
    expect('log' in ctx).toBe(true)
    expect('bus' in ctx).toBe(false)
  })

  it('★四通道全给时**不包 Proxy**（同一个对象，零开销）', () => {
    const raw = makeCtx()
    const ctx = narrowPluginContext(raw, [...PLUGIN_CAPABILITIES])
    expect(ctx.bus).toBe(raw.bus)
    expect(ctx).toBe(raw)
  })

  it('applyPluginCapabilities：包装 install 并把**收窄后的 ctx** 递进去；未配置则原样返回', async () => {
    // 未声明 ⇒ 同一个插件对象（逐位等于改造前）
    const plain = { id: 'p0', install: async () => undefined }
    expect(applyPluginCapabilities(plain, undefined)).toBe(plain)

    const seen: string[] = []
    const p2 = {
      id: 'p2',
      install: async (ctx: PluginContext) => {
        seen.push(`log:${typeof (ctx as unknown as { log: unknown }).log}`)
        return (ctx as unknown as { bus: unknown }).bus // 未授予 ⇒ 这里应当抛
      },
    }
    await expect(applyPluginCapabilities(p2, { p2: ['log'] }).install(makeCtx()))
      .rejects.toThrow(/pluginCapabilities/)
    // 抛之前 log 是可用的（说明不是"整个 ctx 都废了"）
    expect(seen).toEqual(['log:object'])
  })

  it('formatCapabilityGrant：把"授予了什么/没给什么"说清（收窄了要看得见）', () => {
    expect(formatCapabilityGrant('a', undefined)).toContain('四通道全给')
    const line = formatCapabilityGrant('a', ['log'])
    expect(line).toContain('log')
    expect(line).toContain('未授予 bus')
  })
})

describe('loadPluginsInWorker（P1-5 worker 装载）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'p15-worker-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('能装载 .ts 插件并回传**可序列化摘要**（worker 里 import 可行）', async () => {
    const f = join(dir, 'ok.ts')
    writeFileSync(f, `export const plugins = [{ id: 'w.ok', version: '1.2.3', name: 'OK', dependsOn: ['x'] }]`)
    const [o] = await loadPluginsInWorker([f])
    expect(o!.error).toBeUndefined()
    expect(o!.summaries).toEqual([
      { id: 'w.ok', name: 'OK', version: '1.2.3', dependsOn: ['x'], hasUninstall: false },
    ])
  })

  it('★加载即抛异常 ⇒ 错误回传、宿主不受影响（崩溃隔离）', async () => {
    const f = join(dir, 'boom.ts')
    writeFileSync(f, `throw new Error('plugin exploded')`)
    const [o] = await loadPluginsInWorker([f])
    expect(o!.error).toContain('plugin exploded')
    expect(o!.summaries).toEqual([])
  })

  it('★内存炸弹被 resourceLimits 拦住（实测：worker OOM 而宿主存活）—— 这是 worker 模式的真价值', async () => {
    // ⚠️ 刻意**放到子进程里跑**：worker 的 OOM 会污染**同进程**的其它用例。
    // 实测（2026-10-12）：把这条件直接放在 host 包内跑，`bun test` 的另外 5 条用例（内置插件
    // 递归装配 / limits 透传 / lazy 查表）会一起变红 —— 而单独跑这一组时全绿。
    // 也就是说：**bun 的 worker OOM 有进程级副作用**（产品路径上"宿主进程存活"仍成立，
    // 但"宿主不受任何影响"这句话不能这么说）。真证据不能因为脏就删掉，隔离起来跑即可。
    const bomb = join(dir, 'bomb.ts')
    writeFileSync(bomb, `const a: any[] = []\nwhile (true) { a.push(Buffer.alloc(4 * 1024 * 1024)) }`)
    const runner = join(dir, 'bomb-runner.ts')
    writeFileSync(runner, [
      `import { loadPluginsInWorker } from ${JSON.stringify(new URL('./plugin-runner.ts', import.meta.url).pathname)}`,
      `const [o] = await loadPluginsInWorker([${JSON.stringify(bomb)}], { memoryMb: 24, timeoutMs: 8000 })`,
      `process.stdout.write('BOMB_RESULT=' + JSON.stringify({ error: o.error ?? null, n: o.summaries.length }))`,
    ].join('\n'))

    const r = spawnSync(process.execPath, ['run', runner], { encoding: 'utf-8', timeout: 30_000 })
    const m = /BOMB_RESULT=(\{[^]*\})/.exec(r.stdout ?? '')
    expect(m).not.toBeNull()
    const parsed = JSON.parse(m![1]!) as { error: string | null; n: number }
    expect(parsed.error).toBeTruthy() // 具体文案随实现（OOM / 提前退出）
    expect(parsed.n).toBe(0)
  })

  it('★加载期死循环被超时拦住（worker 里没有"执行到一半"的中断点，只能靠超时）', async () => {
    const f = join(dir, 'spin.ts')
    writeFileSync(f, `while (true) {}`)
    const t0 = Date.now()
    const [o] = await loadPluginsInWorker([f], { timeoutMs: 500 })
    expect(o!.error).toContain('超时')
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('静态扫描结果随装载一起回传（与 in-process 路径同一份判定）', async () => {
    const f = join(dir, 'risky.ts')
    writeFileSync(f, `import { spawn } from 'node:child_process'\nexport const plugins = [{ id: 'w.risky' }]`)
    const [o] = await loadPluginsInWorker([f])
    expect(o!.findings.join()).toContain('[child-process]')
  })

  it('多文件逐个处理：一个炸了不影响另一个', async () => {
    const ok = join(dir, 'a.ts')
    const bad = join(dir, 'b.ts')
    writeFileSync(ok, `export const plugins = [{ id: 'a' }]`)
    writeFileSync(bad, `throw new Error('bad')`)
    const out = await loadPluginsInWorker([ok, bad])
    expect(out.map((o) => o.summaries.length)).toEqual([1, 0])
    expect(out[1]!.error).toContain('bad')
  })
})
