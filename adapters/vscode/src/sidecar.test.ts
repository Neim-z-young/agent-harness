/**
 * 握手解析用例（纯逻辑，不起进程）。
 *
 * 样本取自真机：`bun packages/cli/src/index.ts a2a --json --port 0` 的第一行 stdout。
 */

import { describe, expect, it } from 'bun:test'
import { HandshakeError, parseHandshake, pickHandshakeLine } from './sidecar'

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
