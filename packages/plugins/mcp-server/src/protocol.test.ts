/**
 * 协议层测试：JSON-RPC 编解码 / 判别 / 错误码 / 版本协商 / SSE 往返。
 *
 * 全部**纯函数**级，不起端口、不碰 harness —— 协议层的回归应该跑得比业务快一个数量级。
 */
import { describe, expect, it } from 'bun:test'
import {
  ELICITATION_SINCE,
  LATEST_PROTOCOL_VERSION,
  RPC_PARSE_ERROR,
  SUPPORTED_PROTOCOL_VERSIONS,
  JsonRpcParseError,
  decodeSseEvents,
  encodeError,
  encodeResult,
  encodeSseEvent,
  isNotification,
  isRequest,
  isResponse,
  negotiateProtocolVersion,
  parseMessage,
  supportsElicitation,
} from './protocol'

describe('parseMessage：JSON-RPC 报文解析与形状校验', () => {
  it('解析请求 / 通知 / 响应三类', () => {
    const req = parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    expect(isRequest(req)).toBe(true)
    expect(isNotification(req)).toBe(false)

    const note = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    expect(isNotification(note)).toBe(true)
    expect(isRequest(note)).toBe(false)

    const resp = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
    expect(isResponse(resp)).toBe(true)
    expect(isRequest(resp)).toBe(false)
  })

  it('id 为 0 / 空串 时仍算请求（不能用 falsy 判存在）', () => {
    expect(isRequest(parseMessage('{"jsonrpc":"2.0","id":0,"method":"ping"}'))).toBe(true)
    expect(isRequest(parseMessage('{"jsonrpc":"2.0","id":"","method":"ping"}'))).toBe(true)
  })

  it('id 为 null 的响应也算响应（协议允许）', () => {
    const m = parseMessage('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"x"}}')
    expect(isResponse(m)).toBe(true)
  })

  it('非法 JSON → JsonRpcParseError', () => {
    expect(() => parseMessage('{oops')).toThrow(JsonRpcParseError)
  })

  it('非对象 / jsonrpc 字段不对 → JsonRpcParseError', () => {
    expect(() => parseMessage('[1,2]')).toThrow(JsonRpcParseError)
    expect(() => parseMessage('"str"')).toThrow(JsonRpcParseError)
    expect(() => parseMessage('{"id":1,"method":"ping"}')).toThrow(JsonRpcParseError)
    expect(() => parseMessage('{"jsonrpc":"1.0","id":1,"method":"ping"}')).toThrow(JsonRpcParseError)
  })

  it('既无 method 也无 id → JsonRpcParseError（不是三类中的任何一种）', () => {
    expect(() => parseMessage('{"jsonrpc":"2.0"}')).toThrow(JsonRpcParseError)
  })
})

describe('编解码：encodeResult / encodeError', () => {
  it('encodeResult 产出可被 parseMessage 解回的响应', () => {
    const raw = encodeResult(7, { tools: [] })
    const m = parseMessage(raw)
    expect(isResponse(m)).toBe(true)
    expect((m as { id: number }).id).toBe(7)
    expect((m as { result: unknown }).result).toEqual({ tools: [] })
  })

  it('encodeError 携带错误码；data 缺省时不出现该键（避免污染逐字断言）', () => {
    const m = JSON.parse(encodeError(3, RPC_PARSE_ERROR, '坏报文')) as {
      error: { code: number; message: string; data?: unknown }
    }
    expect(m.error.code).toBe(RPC_PARSE_ERROR)
    expect(m.error.message).toBe('坏报文')
    expect('data' in m.error).toBe(false)

    const withData = JSON.parse(encodeError(3, -32602, 'x', { hint: 'y' })) as { error: { data?: unknown } }
    expect(withData.error.data).toEqual({ hint: 'y' })
  })
})

describe('版本协商', () => {
  it('客户端要的版本在列表内 ⇒ 回显', () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) expect(negotiateProtocolVersion(v)).toBe(v)
  })

  it('未知 / 非字符串 ⇒ 回落最新版（不回显不认识的版本）', () => {
    expect(negotiateProtocolVersion('1999-01-01')).toBe(LATEST_PROTOCOL_VERSION)
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION)
    expect(negotiateProtocolVersion(42)).toBe(LATEST_PROTOCOL_VERSION)
  })

  it('supportsElicitation：仅 2025-06-18 及更新 ⇒ true；未知版本 Fail-Closed', () => {
    expect(supportsElicitation(ELICITATION_SINCE)).toBe(true)
    expect(supportsElicitation('2025-03-26')).toBe(false)
    expect(supportsElicitation('2024-11-05')).toBe(false)
    // 关键：不认识 ⇒ false，不假装支持
    expect(supportsElicitation('2099-01-01')).toBe(false)
    expect(supportsElicitation('')).toBe(false)
  })
})

describe('SSE 编解码', () => {
  it('单行报文往返逐字一致', () => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    const wire = encodeSseEvent(payload)
    expect(wire).toBe(`data: ${payload}\n\n`)
    expect(decodeSseEvents(wire)).toEqual([payload])
  })

  it('多行数据逐行加 data: 前缀，解回时用 \\n 拼接还原', () => {
    const payload = 'line1\nline2'
    const wire = encodeSseEvent(payload)
    expect(wire).toBe('data: line1\ndata: line2\n\n')
    expect(decodeSseEvents(wire)).toEqual([payload])
  })

  it('一次解析多帧（响应中途插帧的真实形态：elicitation 请求 + 最终结果）', () => {
    const a = JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create' })
    const b = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [] } })
    expect(decodeSseEvents(encodeSseEvent(a) + encodeSseEvent(b))).toEqual([a, b])
  })

  it('CRLF 与无 data: 行混入时按客户端侧同款规则跳过', () => {
    expect(decodeSseEvents('event: x\r\ndata: {"a":1}\r\n\r\n')).toEqual(['{"a":1}'])
    expect(decodeSseEvents(': keepalive\n\n')).toEqual([])
    expect(decodeSseEvents('')).toEqual([])
  })
})
