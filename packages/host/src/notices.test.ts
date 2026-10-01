/**
 * `HarnessHost` 装配期诊断通道的端到端用例（P0 收尾 · S2 第三步）
 *
 * 与 `notice.test.ts` 的分工：
 *   - `notice.test.ts` 守**渲染器**（`renderNotice` 的逐字字节 + 等级表唯一来源）；
 *   - 这里守**装配是否真的把 21 处输出走在了这条通道上** —— 即"分级不是装饰"。
 *
 * 为什么必须单独有一条端到端：`renderNotice` 快照全绿、`NOTICE_LEVEL` 表断言全绿，
 * 仍然可能发生"boot 里某处其实没 emit"（改回 `stdout.write`、或 verbose 门控写反）。
 * 这条用例把"跑一次真 boot，然后按 code 取回事实"钉住。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessHost } from './host'
import type { HostNotice } from './notice'

/** 造一个带 config.json 的临时工作区 */
function fixture(config: unknown): { cwd: string; dataDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-host-notices-'))
  const dataDir = join(cwd, '.harness')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config, null, 2))
  return { cwd, dataDir }
}

describe('HarnessHost：装配期 notice 端到端（不依赖任何输出流）', () => {
  let dirs: string[] = []
  const mk = (config: unknown) => {
    const f = fixture(config)
    dirs.push(f.cwd)
    return f
  }
  beforeEach(() => { dirs = [] })
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  /** 不传 onNotice / logLine：这正是 A2A / VSCode "照抄不传 stdout" 的场景 */
  const bootHeadless = (config: unknown) => {
    const { cwd, dataDir } = mk(config)
    const host = new HarnessHost({
      cwd, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all',
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    return { host, cwd }
  }

  it('宿主不传任何输出出口时，降级事实仍可从 notices 按 code 取回（治"静默丢弃"）', async () => {
    const { host } = bootHeadless({})
    await host.boot()
    const codes = host.notices.map((n) => n.code)
    // 启动横幅是 notice 级（用户必须知道的事实）：A2A 得把它挂进任务 metadata，
    // 否则远程调用方拿到 Mock 的回答却没有任何信号说它是假的。
    expect(codes).toContain('provider.default-chosen')
    const banner = host.notices.find((n) => n.code === 'provider.default-chosen') as
      | Extract<HostNotice, { code: 'provider.default-chosen' }>
      | undefined
    expect(banner).toBeDefined()
    expect(banner!.level).toBe('notice')
    expect(banner!.data.actual).toBe('mock')
    await host.shutdown()
  })

  it('配置写了没生效的段 ⇒ warn 级 notice，带结构化 items/unknown（不是纯文本）', async () => {
    const { host } = bootHeadless({ plugins: ['no-such-plugin'] })
    await host.boot()
    const n = host.notices.find((x) => x.code === 'config.plugins-inactive') as
      | Extract<HostNotice, { code: 'config.plugins-inactive' }>
      | undefined
    expect(n).toBeDefined()
    expect(n!.level).toBe('warn')
    expect(n!.data.unknown).toEqual(['no-such-plugin'])
    // available 是"当时可用的内置插件清单"，非空才有可操作性
    expect(n!.data.available.length).toBeGreaterThan(0)
    await host.shutdown()
  })

  it('onNotice 出口收到的是与 notices 缓冲同一批（两个出口，不是两份事实）', async () => {
    const { cwd, dataDir } = mk({ plugins: ['no-such-plugin'] })
    const seen: Array<HostNotice['code']> = []
    const host = new HarnessHost({
      cwd, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all',
      mockProviderConfig: { defaultResponse: 'hi' },
      onNotice: (n) => seen.push(n.code),
    })
    await host.boot()
    expect(seen).toContain('config.plugins-inactive')
    // sink 收到的 code 序列是缓冲的前缀（顺序一致、无重复投递）
    expect(host.notices.map((n) => n.code).slice(0, seen.length)).toEqual(seen)
    await host.shutdown()
  })

  it('verbose 门控在宿主侧：log 级 notice 非 verbose 时不进缓冲，verbose 时进且仍为 log 级', async () => {
    const quiet = bootHeadless({})
    await quiet.host.boot()
    expect(quiet.host.notices.some((n) => n.level === 'log')).toBe(false)
    await quiet.host.shutdown()

    const { cwd, dataDir } = mk({})
    const loud = new HarnessHost({
      cwd, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', verbose: true,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    await loud.boot()
    // 后台预加载是 fire-and-forget，给它一点时间跑完
    await new Promise((r) => setTimeout(r, 300))
    const logs = loud.notices.filter((n) => n.level === 'log')
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.every((n) => n.code === 'preload.warmed' || n.code === 'log.info' || n.code === 'log.debug')).toBe(true)
    await loud.shutdown()
  })

  it('环形缓冲容量上限生效：不会因为长跑而无限增长', async () => {
    const { host } = bootHeadless({})
    await host.boot()
    // 直接经 emitNotice 灌入远多于上限的条目（protected ⇒ 用最小接口绕过访问修饰符）
    const emit = (host as unknown as { emitNotice(n: HostNotice): void }).emitNotice.bind(host)
    for (let i = 0; i < 1500; i++) {
      emit({ level: 'notice', code: 'provider.default-not-registered', data: { providerId: `p${i}` } } as HostNotice)
    }
    const { HOST_NOTICE_LIMIT } = await import('./host')
    expect(host.notices.length).toBe(HOST_NOTICE_LIMIT)
    // 保留的是**最近**的（环形：老的被 shift 掉）
    const last = host.notices[host.notices.length - 1] as Extract<HostNotice, { code: 'provider.default-not-registered' }>
    expect(last.data.providerId).toBe('p1499')
    await host.shutdown()
  })
})
