import { describe, expect, it } from 'bun:test'
import type { AgentStreamSignal, PluginContext } from '@harness/plugin'
import {
  DEFAULT_AGENT,
  DEFAULT_SOURCE,
  HerdrReporter,
  buildReleaseArgs,
  buildReportArgs,
  createHerdrPlugin,
  detectHerdrEnv,
  mapStatusToHerdrState,
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
    expect(seqs).toEqual([1, 2, 3])
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
})

describe('插件装配', () => {
  it('Herdr 内：返回 agent.stream / permission.check 两个 Hook', async () => {
    const plugin = createHerdrPlugin({
      env: { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_BIN_PATH: '/bin/herdr' },
      runner: fakeRunner().runner,
    })
    const hooks = (await plugin.install(fakeCtx())) as Record<string, unknown>
    expect(typeof hooks['agent.stream']).toBe('function')
    expect(typeof hooks['permission.check']).toBe('function')
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

  it('permission.check：只有 decision=ask 才报 blocked（已记住的规则没人真的在等）', async () => {
    const { calls, runner } = fakeRunner()
    const plugin = createHerdrPlugin({
      env: { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_BIN_PATH: '/bin/herdr' },
      runner,
    })
    const hooks = (await plugin.install(fakeCtx())) as {
      'permission.check': (r: unknown, d: unknown) => void
    }
    hooks['permission.check']({ toolKey: 'bash' }, { behavior: 'allow' })
    expect(calls).toHaveLength(0)
    hooks['permission.check']({ toolKey: 'bash' }, { behavior: 'ask' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toContain('blocked')
    await plugin.uninstall?.()
  })

  it('uninstall 释放生命周期权威（否则 Herdr 一直认为该 pane 归本 source 管）', async () => {
    const { calls, runner } = fakeRunner()
    const plugin = createHerdrPlugin({
      env: { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_BIN_PATH: '/bin/herdr' },
      runner,
    })
    await plugin.install(fakeCtx())
    await plugin.uninstall?.()
    const release = calls.filter((c) => c.args.includes('release-agent'))
    expect(release).toHaveLength(1)
    expect(release[0]!.sync).toBe(true)
  })
})
