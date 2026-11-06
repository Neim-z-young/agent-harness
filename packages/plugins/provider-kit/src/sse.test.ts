import { describe, expect, it } from 'bun:test'
import { SseDecoder } from './sse'

/** 把整段文本一次性喂进去 */
function decodeAll(text: string) {
  const d = new SseDecoder()
  return [...d.push(text), ...d.flush()]
}

describe('SseDecoder：分帧口径', () => {
  it('LF 分隔：按空行切帧，data 原样取出', () => {
    const frames = decodeAll('data: {"a":1}\n\ndata: {"a":2}\n\n')
    expect(frames).toEqual([{ data: '{"a":1}' }, { data: '{"a":2}' }])
  })

  it('CRLF 分隔（回归：只认 \\n\\n 时一帧都切不出来，整条流静默空转）', () => {
    const frames = decodeAll('data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n')
    expect(frames).toEqual([{ data: '{"a":1}' }, { data: '{"a":2}' }])
  })

  it('裸 CR 分隔（老式网关）同样能切', () => {
    expect(decodeAll('data: x\r\rdata: y\r\r')).toEqual([{ data: 'x' }, { data: 'y' }])
  })

  it('块边界落在 \\r 与 \\n 之间：不得凭空多切一帧', () => {
    const d = new SseDecoder()
    expect(d.push('data: a\r')).toEqual([])
    expect(d.push('\n\r\ndata: b\r\n\r\n')).toEqual([{ data: 'a' }, { data: 'b' }])
    expect(d.flush()).toEqual([])
  })

  it('event 字段被保留；没有 event 时不产出该键', () => {
    const frames = decodeAll('event: ping\ndata: 1\n\ndata: 2\n\n')
    expect(frames).toEqual([{ event: 'ping', data: '1' }, { data: '2' }])
  })

  it('多行 data 按规范以 \\n 连接（旧实现是后行覆盖前行，静默丢内容）', () => {
    expect(decodeAll('data: line1\ndata: line2\n\n')).toEqual([{ data: 'line1\nline2' }])
  })

  it('一个事件被切成两块喂入：状态跨 push 保持', () => {
    const d = new SseDecoder()
    expect(d.push('event: content_block_delta\nda')).toEqual([])
    expect(d.push('ta: {"type":"x"}\n')).toEqual([])
    expect(d.push('\n')).toEqual([{ event: 'content_block_delta', data: '{"type":"x"}' }])
  })

  it('注释行（心跳 `: keep-alive`）不产出帧、也不污染后续帧', () => {
    expect(decodeAll(': keep-alive\n\ndata: 1\n\n')).toEqual([{ data: '1' }])
  })

  it('id / retry 字段被忽略', () => {
    expect(decodeAll('id: 7\nretry: 1000\ndata: 1\n\n')).toEqual([{ data: '1' }])
  })

  it('`data:` 后无前导空格时也能取到值', () => {
    expect(decodeAll('data:{"a":1}\n\n')).toEqual([{ data: '{"a":1}' }])
  })

  it('flush：末帧没有尾随空行时仍然交出（网关发完就关的场景）', () => {
    const d = new SseDecoder()
    expect(d.push('data: last')).toEqual([])
    expect(d.flush()).toEqual([{ data: 'last' }])
  })

  it('flush 后再次 push 不会重复交出旧帧', () => {
    const d = new SseDecoder()
    d.push('data: a\n\n')
    expect(d.flush()).toEqual([])
    expect(d.push('data: b\n\n')).toEqual([{ data: 'b' }])
  })

  it('空块是 no-op', () => {
    const d = new SseDecoder()
    expect(d.push('')).toEqual([])
    expect(d.flush()).toEqual([])
  })
})
