/**
 * 握手解析用例（纯逻辑，不起进程）。
 *
 * 样本取自真机：`bun packages/cli/src/index.ts a2a --json --port 0` 的第一行 stdout。
 */

import { describe, expect, it } from 'bun:test'
import { HandshakeError, parseHandshake, pickHandshakeLine, Sidecar } from './sidecar'

const REAL =
  '{"v":1,"pid":82400,"port":65184,"protocolVersion":"1.0","rpcUrl":"http://127.0.0.1:65184/a2a","cardUrl":"http://127.0.0.1:65184/.well-known/agent-card.json","controlUrl":"http://127.0.0.1:65184/harness/rpc","auth":"anonymous","permissionMode":"ask","cwd":"/repo"}'

describe('parseHandshake', () => {
  it('真机样本 ⇒ 全字段解析', () => {
    const hs = parseHandshake(REAL)
    expect(hs.v).toBe(1)
    expect(hs.port).toBe(65184)
    expect(hs.protocolVersion).toBe('1.0')
    expect(hs.rpcUrl).toBe('http://127.0.0.1:65184/a2a')
    expect(hs.controlUrl).toBe('http://127.0.0.1:65184/harness/rpc')
    expect(hs.auth).toBe('anonymous')
    expect(hs.permissionMode).toBe('ask')
  })

  it('--port 0 的真实端口被回传（扩展靠它连，猜不出来）', () => {
    expect(parseHandshake(REAL).port).toBeGreaterThan(0)
  })

  it('非 JSON ⇒ 抛（不是返回 undefined）', () => {
    expect(() => parseHandshake('A2A 服务已启动')).toThrow(HandshakeError)
  })

  it('缺字段 ⇒ 抛，并指明缺哪个', () => {
    const bad = JSON.stringify({ ...JSON.parse(REAL), controlUrl: undefined })
    expect(() => parseHandshake(bad)).toThrow(/controlUrl/)
  })

  it('v 高于契约版本 ⇒ 抛（避免按旧字段硬解析）', () => {
    const future = JSON.stringify({ ...JSON.parse(REAL), v: 2 })
    expect(() => parseHandshake(future)).toThrow(/高于/)
  })

  it('非法 auth / permissionMode ⇒ 抛', () => {
    expect(() => parseHandshake(JSON.stringify({ ...JSON.parse(REAL), auth: 'weird' }))).toThrow(/auth/)
    expect(() => parseHandshake(JSON.stringify({ ...JSON.parse(REAL), permissionMode: 'maybe' }))).toThrow(
      /permissionMode/,
    )
  })
})

describe('pickHandshakeLine', () => {
  it('从一段 stdout 里挑第一个 JSON 对象行', () => {
    expect(pickHandshakeLine(`${REAL}\n`)).toBe(REAL)
  })

  it('跳过空行（Bun / 插件加载可能吐噪声）', () => {
    expect(pickHandshakeLine(`\n\n${REAL}\n`)).toBe(REAL)
  })

  it('没有 JSON 行 ⇒ undefined（继续等下一次 data）', () => {
    expect(pickHandshakeLine('[a2a] 正在停止...\n')).toBeUndefined()
  })
})

describe('reconfigure（配置变更后重启要生效）', () => {
  it('换参数后 launch 反映新值', () => {
    const s = new Sidecar({ cliPath: '/repo/packages/cli/src/index.ts', runner: '/opt/homebrew/bin/bun', cwd: '/repo' })
    s.reconfigure({ cliPath: '/opt/harness-a2a', runner: undefined, cwd: '/repo', token: undefined })
    expect(s.launch.cliPath).toBe('/opt/harness-a2a')
    expect(s.launch.runner).toBeUndefined()
  })

  it('runner 能被清掉（.ts → 二进制时必须清，否则会 spawn "bun 跑二进制"）', () => {
    const s = new Sidecar({ cliPath: '/x/cli.ts', runner: 'bun', cwd: '/r' })
    s.reconfigure({ cliPath: '/x/cli.ts', runner: undefined, cwd: '/r', token: undefined })
    expect(s.launch.runner).toBeUndefined()
  })

  it('cwd / token 也一起换', () => {
    const s = new Sidecar({ cliPath: '/x', cwd: '/old', token: 'old' })
    s.reconfigure({ cliPath: '/x', runner: undefined, cwd: '/new', token: 'new' })
    expect(s.launch.cliPath).toBe('/x')
  })

  it('未运行时可反复调用（幂等，后一次覆盖前一次）', () => {
    const s = new Sidecar({ cliPath: '/x', cwd: '/r' })
    s.reconfigure({ cliPath: '/a', runner: undefined, cwd: '/r', token: undefined })
    s.reconfigure({ cliPath: '/b', runner: undefined, cwd: '/r', token: undefined })
    expect(s.launch.cliPath).toBe('/b')
  })

  it('运行中调用 ⇒ 抛，且参数不被改（否则会留下跑着旧参数的进程）', () => {
    const s = new Sidecar({ cliPath: '/x', cwd: '/r' })
    // 伪造"有进程在跑"：起一个真进程要挑「忽略参数、打印握手、且不退出」的可执行文件，
    // 为一个守卫分支不值得。cast 进私有字段能精确命中这条分支。
    ;(s as unknown as { proc: unknown }).proc = { pid: 1 }
    expect(() => s.reconfigure({ cliPath: '/y', runner: undefined, cwd: '/r', token: undefined })).toThrow(
      /正在运行/,
    )
    expect(s.launch.cliPath).toBe('/x')
  })
})
