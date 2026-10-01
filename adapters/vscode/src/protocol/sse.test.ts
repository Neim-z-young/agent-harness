/**
 * SSE 解帧器用例。
 *
 * 帧样本**全部取自真机抓包**（`harness a2a` 起服务后 `SendStreamingMessage`，
 * 见设计稿 §9），不是照着规范想象出来的 —— 这能挡住"服务端改封帧格式"这类静默断裂。
 */

import { describe, expect, it } from 'bun:test'
import { SseDecoder, SseParseError } from './sse'

const TASK_FRAME =
  'data: {"jsonrpc":"2.0","id":1,"result":{"task":{"id":"af29f8cf","contextId":"6627f436","status":{"state":"TASK_STATE_SUBMITTED"}}}}\n\n'

const WORKING_FRAME =
  'data: {"jsonrpc":"2.0","id":1,"result":{"statusUpdate":{"taskId":"af29f8cf","status":{"state":"TASK_STATE_WORKING"},"metadata":{"phase":"tool-start","tool":"bash"}}}}\n\n'

const ERROR_FRAME =
  'event: error\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Task not found"}}\n\n'

describe('SseDecoder', () => {
  it('一个完整帧 ⇒ 一次切出', () => {
    const d = new SseDecoder()
    const out = d.push(TASK_FRAME)
    expect(out).toHaveLength(1)
    expect(out[0]!.event).toBe('message')
    expect(out[0]!.data).toMatchObject({ jsonrpc: '2.0', id: 1 })
  })

  it('错误帧带 event: error（普通帧没有该行，默认是 message）', () => {
    const d = new SseDecoder()
    const out = d.push(ERROR_FRAME)
    expect(out[0]!.event).toBe('error')
    expect(out[0]!.data).toMatchObject({ error: { code: -32001 } })
  })

  it('分块到达（帧被网络切成两半）⇒ 拼齐后才产出', () => {
    const d = new SseDecoder()
    // 恰好切在 JSON 中间
    const half = Math.floor(TASK_FRAME.length / 2)
    expect(d.push(TASK_FRAME.slice(0, half))).toHaveLength(0)
    const out = d.push(TASK_FRAME.slice(half))
    expect(out).toHaveLength(1)
    expect(out[0]!.data).toMatchObject({ id: 1 })
  })

  it('一次 push 含多个帧 ⇒ 全部分别产出', () => {
    const d = new SseDecoder()
    const out = d.push(TASK_FRAME + WORKING_FRAME + ERROR_FRAME)
    expect(out).toHaveLength(3)
    expect(out[1]!.data).toMatchObject({ result: { statusUpdate: { metadata: { tool: 'bash' } } } })
  })

  it('CRLF 也能解（SSE 允许 \\r\\n）', () => {
    const d = new SseDecoder()
    const out = d.push(TASK_FRAME.replace(/\n\n$/, '\r\n\r\n').replace(/^data:/, 'data:'))
    expect(out).toHaveLength(1)
  })

  it('心跳注释行（: ping）必须被忽略，不能产出帧', () => {
    const d = new SseDecoder()
    const out = d.push(': ping\n\n' + TASK_FRAME)
    expect(out).toHaveLength(1)
  })

  it('flush 交出没等到空行结尾的残留块', () => {
    const d = new SseDecoder()
    const noTail = TASK_FRAME.replace(/\n\n$/, '')
    expect(d.push(noTail)).toHaveLength(0)
    expect(d.flush()).toHaveLength(1)
  })

  it('坏 JSON ⇒ 抛 SseParseError（不静默跳过）', () => {
    const d = new SseDecoder()
    expect(() => d.push('data: {not json\n\n')).toThrow(SseParseError)
  })
})
