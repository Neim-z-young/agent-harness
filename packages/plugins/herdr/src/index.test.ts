import { describe, expect, it } from 'bun:test'
import type { AgentStreamSignal, PluginContext } from '@harness/plugin'
import {
  DEFAULT_AGENT,
  DEFAULT_SOURCE,
  EXIT_SIGNALS,
  HerdrReporter,
  buildReleaseArgs,
  buildReportArgs,
  createHerdrPlugin,
  detectHerdrEnv,
  mapStatusToHerdrState,
  nextSeqBase,
  type HerdrEnv,
  type HerdrRunner,
} from './index'

const ENV: HerdrEnv = { paneId: 'pane-1', binPath: '/usr/local/bin/herdr' }

/** 记录调用的执行器替身 */
function fakeRunner() {
  const calls: Array<{ sync: boolean; bin: string; args: string[] }> = []
  const runner: HerdrRunner = {
    run(bin, args) {
      calls.push({ sync: false, bin, args })
    },
    runSync(bin, args) {
      calls.push({ sync: true, bin, args })
    },
  }
  return { calls, runner }
}

function status(phase: 'idle' | 'thinking' | 'streaming' | 'tool' | 'aborted'): AgentStreamSignal {
  return { eventType: 'text_delta', status: { agentId: 'default', phase }, sessionId: 's1' }
}

function fakeCtx(): PluginContext {
  const noop = () => undefined
  return {
    bus: { publish: async () => undefined, subscribe: () => () => undefined } as never,
    config: { get: () => undefined, set: noop },
    log: { info: noop, warn: noop, error: noop, debug: noop },
  }
}

describe('环境探测', () => {
  it('四个变量齐备 → 生效', () => {
    expect(
      detectHerdrEnv({
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'pane-1',
        HERDR_BIN_PATH: '/bin/herdr',
        HERDR_SOCKET_PATH: '/tmp/sock',
      }),
    ).toEqual({ paneId: 'pane-1', binPath: '/bin/herdr', socketPath: '/tmp/sock' })
  })

  it('HERDR_ENV≠1 → 不生效（官方要求：环境外必须 no-op）', () => {
    expect(
      detectHerdrEnv({ HERDR_ENV: '0', HERDR_PANE_ID: 'p', HERDR_BIN_PATH: '/b' }),
    ).toBeUndefined()
  })

  it('缺 PANE_ID 或 BIN_PATH → 不生效（缺任一个就无法上报）', () => {
    expect(detectHerdrEnv({ HERDR_ENV: '1', HERDR_BIN_PATH: '/b' })).toBeUndefined()
    expect(detectHerdrEnv({ HERDR_ENV: '1', HERDR_PANE_ID: 'p' })).toBeUndefined()
  })

  it('完全无相关变量 → 不生效', () => {
    expect(detectHerdrEnv({})).toBeUndefined()
  })
})

describe('状态映射', () => {
  it('thinking / streaming / tool → working', () => {
    expect(mapStatusToHerdrState({ phase: 'thinking' })).toBe('working')
    expect(mapStatusToHerdrState({ phase: 'streaming' })).toBe('working')
    expect(mapStatusToHerdrState({ phase: 'tool' })).toBe('working')
  })

  it('idle / aborted → idle（中断是回到等待输入，不是「等你决策」）', () => {
    expect(mapStatusToHerdrState({ phase: 'idle' })).toBe('idle')
    expect(mapStatusToHerdrState({ phase: 'aborted' })).toBe('idle')
  })
})

describe('命令构造', () => {
  it('report-agent：必带 seq（乱序防护是官方要求）', () => {
    const args = buildReportArgs(ENV, { state: 'working', seq: 7, sessionId: 's1' })
    expect(args.slice(0, 3)).toEqual(['pane', 'report-agent', 'pane-1'])
    expect(args).toContain('--state')
    expect(args[args.indexOf('--state') + 1]).toBe('working')
    expect(args[args.indexOf('--seq') + 1]).toBe('7')
    expect(args).toContain('--source')
    expect(args[args.indexOf('--agent-session-id') + 1]).toBe('s1')
  })

  it('message 只在阻塞时带（不污染常态上报）', () => {
    const plain = buildReportArgs(ENV, { state: 'working', seq: 1 })
    expect(plain).not.toContain('--message')
    const blocked = buildReportArgs(ENV, { state: 'blocked', seq: 2, message: '等待批准：bash' })
    expect(blocked[blocked.indexOf('--message') + 1]).toBe('等待批准：bash')
  })

  it('release-agent：不带 state（协议里结束靠 release，没有 done）', () => {
    const args = buildReleaseArgs(ENV)
    expect(args.slice(0, 3)).toEqual(['pane', 'release-agent', 'pane-1'])
    expect(args).not.toContain('--state')
    expect(args).toContain(DEFAULT_SOURCE)
    expect(args).toContain(DEFAULT_AGENT)
  })

  it('release-agent：给了 seq 就必须带上（真机实测：不带会被当旧序号丢弃）', () => {
    const withSeq = buildReleaseArgs(ENV, { seq: 11 })
    expect(withSeq[withSeq.indexOf('--seq') + 1]).toBe('11')
    // 不传就不带（不塞默认值，避免写入一个"看起来有、其实没意义"的序号）
    expect(buildReleaseArgs(ENV)).not.toContain('--seq')
  })
})

describe('HerdrReporter', () => {
  const envFull = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_BIN_PATH: '/bin/herdr' }

  it('节流：状态不变不重复发（text_delta 每帧都会触发 hook）', () => {
    const { calls, runner } = fakeRunner()
    const r = new HerdrReporter({ env: envFull, runner })
    expect(r.active).toBe(true)
    expect(r.handleStream(status('thinking'))).toBe(true)
    expect(r.handleStream(status('thinking'))).toBe(false)
    expect(r.handleStream(status('streaming'))).toBe(false) // 同为 working
    expect(calls).toHaveLength(1)
  })

  it('seq 严格递增（Herdr 靠它丢弃同源旧序号）', () => {
    const { calls, runner } = fakeRunner()
    const r = new HerdrReporter({ env: envFull, runner })
    r.handleStream(status('thinking'))
    r.handleStream(status('idle'))
    r.handleStream(status('tool'))
    const seqs = calls.map((c) => Number(c.args[c.args.indexOf('--seq') + 1]))
    expect(seqs[1]).toBeGreaterThan(seqs[0]!)
    expect(seqs[2]).toBeGreaterThan(seqs[1]!)
  })

  it('序号基线取自微秒级时钟（不是 1 起算的计数）', () => {
    // 固定输入 ⇒ 确定性断言：epoch 毫秒 × 1000（微秒量级）
    expect(nextSeqBase(1_700_000_000_000)).toBe(1_700_000_000_000_000)
    // 真实基线：远超任何一次运行的上报条数，且随时间前进
    expect(nextSeqBase()).toBeGreaterThan(1_000_000_000_000)
    expect(nextSeqBase(1_700_000_000_001)).toBeGreaterThan(nextSeqBase(1_700_000_000_000))
  })

  it('新运行的序号恒大于上一次运行的末序号（跨进程重启也不会撞上旧水位线）', () => {
    // 上一次运行：基线更早（模拟「上次结束于 1 秒前」），跑了 2 条
    const a = fakeRunner()
    const first = new HerdrReporter({ env: envFull, runner: a.runner, seqBase: nextSeqBase(Date.now() - 1000) })
    first.reportStarted()
    first.report('working')
    const lastSeqOfRun1 = Number(a.calls.at(-1)!.args[a.calls.at(-1)!.args.indexOf('--seq') + 1])

    // 新进程重新构造（真机语义：水位线跨进程不重置）⇒ 首条就必须超过它
    const b = fakeRunner()
    const second = new HerdrReporter({ env: envFull, runner: b.runner })
    second.reportStarted()
    const firstSeqOfRun2 = Number(b.calls[0]!.args[b.calls[0]!.args.indexOf('--seq') + 1])

    expect(firstSeqOfRun2).toBeGreaterThan(lastSeqOfRun1)
    expect(firstSeqOfRun2).toBeGreaterThan(1_000_000_000_000)
  })

  it('sessionId 变化也会上报（同一状态换会话仍需告知）', () => {
    const { calls, runner } = fakeRunner()
    const r = new HerdrReporter({ env: envFull, runner })
    r.handleStream(status('thinking'))
    r.handleStream({ eventType: 'text_delta', status: { phase: 'thinking' }, sessionId: 's2' })
    expect(calls).toHaveLength(2)
  })

  it('不在 Herdr 环境：active=false 且零调用（no-op 是官方硬要求）', () => {
    const { calls, runner } = fakeRunner()
    const r = new HerdrReporter({ env: { HERDR_ENV: '0' }, runner })
    expect(r.active).toBe(false)
    expect(r.handleStream(status('thinking'))).toBe(false)
    expect(r.release()).toBe(false)
    expect(r.shutdown()).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('release 走同步执行（进程 exit 钩子里不能异步等待）且幂等', () => {
    const { calls, runner } = fakeRunner()
    const r = new HerdrReporter({ env: envFull, runner })
    expect(r.release()).toBe(true)
    expect(r.release()).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sync).toBe(true)
    // release 之后不再上报
    expect(r.handleStream(status('thinking'))).toBe(false)
  })

  it('release 必须带比末次上报更高的 seq（真机实测：不带则 release 被丢弃）', () => {
    const { calls, runner } = fakeRunner()
    const r = new HerdrReporter({ env: envFull, runner })
    r.handleStream(status('thinking'))
    r.release()
    const reportSeq = Number(calls[0]!.args[calls[0]!.args.indexOf('--seq') + 1])
    const releaseArgs = calls[1]!.args
    expect(releaseArgs).toContain('release-agent')
    expect(releaseArgs).toContain('--seq')
    expect(Number(releaseArgs[releaseArgs.indexOf('--seq') + 1])).toBeGreaterThan(reportSeq)
  })

  it('shutdown = 先报 unknown（同步）再 release（同步、序号更高）', () => {
    const { calls, runner } = fakeRunner()
    const r = new HerdrReporter({ env: envFull, runner })
    r.handleStream(status('thinking'))
    expect(r.shutdown()).toBe(true)

    const [report, release] = calls.slice(1)
    expect(report!.args).toContain('--state')
    expect(report!.args[report!.args.indexOf('--state') + 1]).toBe('unknown')
    expect(report!.sync).toBe(true)
    expect(release!.args).toContain('release-agent')
    expect(release!.sync).toBe(true)
    expect(Number(release!.args[release!.args.indexOf('--seq') + 1]))
      .toBeGreaterThan(Number(report!.args[report!.args.indexOf('--seq') + 1]))

    // 幂等：已退出后不再发任何命令
    const n = calls.length
    expect(r.shutdown()).toBe(false)
    expect(r.release()).toBe(false)
    expect(calls).toHaveLength(n)
  })
})

describe('插件装配', () => {
  const envInHerdr = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_BIN_PATH: '/bin/herdr' }

  /** monkey-patch process 上的进程级 API，返回记录与还原函数 */
  function spyProcess() {
    const on: string[] = []
    const off: string[] = []
    const killed: Array<{ pid: number; sig: string | number }> = []
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const orig = { on: process.on, once: process.once, off: process.off, kill: process.kill }

    const record = (ev: string, fn: (...a: unknown[]) => void) => {
      const arr = listeners.get(ev) ?? []
      arr.push(fn)
      listeners.set(ev, arr)
    }
    ;(process as any).on = (ev: string, fn: (...a: unknown[]) => void) => {
      on.push(ev)
      record(ev, fn)
      return process
    }
    ;(process as any).once = (ev: string, fn: (...a: unknown[]) => void) => {
      on.push(`once:${ev}`)
      record(ev, fn)
      return process
    }
    ;(process as any).off = (ev: string, fn: (...a: unknown[]) => void) => {
      off.push(ev)
      listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn))
      return process
    }
    ;(process as any).kill = (pid: number, sig: string | number) => {
      killed.push({ pid, sig })
      return true
    }
    return {
      on,
      off,
      killed,
      fire: (ev: string) => (listeners.get(ev) ?? []).forEach((f) => f(ev)),
      restore: () => {
        ;(process as any).on = orig.on
        ;(process as any).once = orig.once
        ;(process as any).off = orig.off
        ;(process as any).kill = orig.kill
      },
    }
  }

  it('Herdr 内：返回 core.harness.start / cli.agent.stream / core.permission.check 三个 Hook', async () => {
    const plugin = createHerdrPlugin({ env: envInHerdr, runner: fakeRunner().runner })
    const hooks = (await plugin.install(fakeCtx())) as Record<string, unknown>
    expect(typeof hooks['core.harness.start']).toBe('function')
    expect(typeof hooks['cli.agent.stream']).toBe('function')
    expect(typeof hooks['core.permission.check']).toBe('function')
    await plugin.uninstall?.()
  })

  it('core.harness.start：启动即报 idle（否则侧栏要等用户第一个回车才有状态）', async () => {
    const { calls, runner } = fakeRunner()
    const plugin = createHerdrPlugin({ env: envInHerdr, runner })
    const hooks = (await plugin.install(fakeCtx())) as {
      'core.harness.start': () => void
    }
    expect(calls).toHaveLength(0)
    hooks['core.harness.start']()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[calls[0]!.args.indexOf('--state') + 1]).toBe('idle')
    await plugin.uninstall?.()
  })

  it('Herdr 外：install 返回空 Hooks（不注册任何监听、不产生进程）', async () => {
    const { calls, runner } = fakeRunner()
    const plugin = createHerdrPlugin({ env: {}, runner })
    const hooks = await plugin.install(fakeCtx())
    expect(hooks && Object.keys(hooks).length).toBe(0)
    expect(calls).toHaveLength(0)
    await plugin.uninstall?.()
  })

  it('core.permission.check：只有 decision=ask 才报 blocked（已记住的规则没人真的在等）', async () => {
    const { calls, runner } = fakeRunner()
    const plugin = createHerdrPlugin({ env: envInHerdr, runner })
    const hooks = (await plugin.install(fakeCtx())) as {
      'core.permission.check': (r: unknown, d: unknown) => void
    }
    hooks['core.permission.check']({ toolKey: 'bash' }, { behavior: 'allow' })
    expect(calls).toHaveLength(0)
    hooks['core.permission.check']({ toolKey: 'bash' }, { behavior: 'ask' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toContain('blocked')
    await plugin.uninstall?.()
  })

  it('uninstall：先报 unknown 再 release（且 release 带序号），否则 Herdr 一直认为该 pane 归本 source 管', async () => {
    const { calls, runner } = fakeRunner()
    const plugin = createHerdrPlugin({ env: envInHerdr, runner })
    await plugin.install(fakeCtx())
    await plugin.uninstall?.()
    const released = calls.filter((c) => c.args.includes('release-agent'))
    expect(released).toHaveLength(1)
    expect(released[0]!.sync).toBe(true)
    expect(released[0]!.args).toContain('--seq')
    // unknown 上报在 release 之前，且同样是同步的（退出路径不能等事件循环）
    const unknownIdx = calls.findIndex(
      (c) => !c.args.includes('release-agent') && c.args[c.args.indexOf('--state') + 1] === 'unknown',
    )
    expect(unknownIdx).toBeGreaterThanOrEqual(0)
    expect(calls[unknownIdx]!.sync).toBe(true)
    expect(unknownIdx).toBeLessThan(calls.indexOf(released[0]!))
  })

  it('注册 exit + SIGTERM/SIGHUP，卸载时全部卸掉（不留监听把进程"钉住"）', async () => {
    const spy = spyProcess()
    try {
      const plugin = createHerdrPlugin({ env: envInHerdr, runner: fakeRunner().runner })
      await plugin.install(fakeCtx())
      expect(spy.on).toContain('once:exit')
      for (const s of EXIT_SIGNALS) expect(spy.on).toContain(s)
      // 刻意不抢 SIGINT：CLI 的 REPL/TUI 用它表示「中断当前查询」
      expect(spy.on).not.toContain('SIGINT')

      await plugin.uninstall?.()
      expect(spy.off).toContain('exit')
      for (const s of EXIT_SIGNALS) expect(spy.off).toContain(s)
    } finally {
      spy.restore()
    }
  })

  it('收到 SIGTERM/SIGHUP：同步 release 后按默认处置重发信号（exit 事件覆盖不到信号退出）', async () => {
    const spy = spyProcess()
    const { calls, runner } = fakeRunner()
    try {
      const plugin = createHerdrPlugin({ env: envInHerdr, runner })
      await plugin.install(fakeCtx())
      spy.fire('SIGTERM')

      const released = calls.filter((c) => c.args.includes('release-agent'))
      expect(released).toHaveLength(1)
      expect(released[0]!.sync).toBe(true)
      // 重发信号：否则进程会被我们的监听"留下不退出"
      expect(spy.killed).toContainEqual({ pid: process.pid, sig: 'SIGTERM' })
      // 重发前先卸掉自己的监听（避免自己再收一次）
      expect(spy.off).toContain('SIGTERM')
      expect(spy.off).toContain('SIGHUP')
      expect(spy.off).toContain('exit')
    } finally {
      spy.restore()
    }
  })
})
