/**
 * adapter 的 reasoning 往返契约测试。
 *
 * 背景（内核 reasoning-pairs.d.ts 的契约）：acp-kernel 预期 reasoning 是独立的
 * `contentType: 'reasoning'` core、紧跟它所属的 assistant text/tool-call 之前，
 * 且「每个 adapter 都依赖这个往返契约来重建 reasoning_content」。此前本插件把
 * reasoning 拼进 text 视图，往返后 reasoning part 降级成 text part —— thinking
 * 端点（DeepSeek）要求的 `reasoning_content` 回传随之缺失（自适应只能补空串）。
 */
import { describe, it, expect } from 'bun:test'
import { toCores, requestMessages } from './adapter'
import type { Message } from '@harness/session'

const mkMsg = (id: string, role: Message['role'], parts: Message['parts']): Message => ({
  id,
  role,
  parts,
  createdAt: 1,
})

describe('reasoning 往返契约（ACP ↔ 内核）', () => {
  it('toCores：reasoning part 输出为独立 reasoning core，且位于 tool/text core 之前', () => {
    const msg = mkMsg('m1', 'assistant', [
      { type: 'reasoning', text: '先想想' } as never,
      { type: 'tool', toolUseId: 'tu1', toolId: 'echo', input: { msg: 'hi' } } as never,
      { type: 'text', text: '结论' } as never,
    ])

    const { cores } = toCores([msg])
    const types = cores.map((c) => c.contentType)

    // 顺序契约：reasoning 紧跟它所属的 assistant 内容**之前**（reasoning-pairs 的配对依据）
    expect(types).toEqual(['reasoning', 'tool-call', 'text'])
    expect(cores[0]!.text).toBe('先想想')
    expect(cores[0]!.role).toBe('assistant')
  })

  it('requestMessages：reasoning core 并回紧随的 assistant 消息（reasoning_content 与 tool_calls 同消息）', () => {
    const { cores } = toCores([
      mkMsg('m1', 'user', [{ type: 'text', text: '问' } as never]),
      mkMsg('m2', 'assistant', [
        { type: 'reasoning', text: '思考中' } as never,
        { type: 'text', text: '答' } as never,
      ]),
    ])

    const msgs = requestMessages(cores)
    const asst = msgs.find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'reasoning'))

    // 不是独立消息，而是并入 assistant 的 parts 开头 —— OpenAI 序列化时
    // reasoning_content 与 content 出现在同一条 assistant 消息（DeepSeek 官方样例形态）
    expect(asst).toBeDefined()
    expect(asst!.parts[0]).toEqual({ type: 'reasoning', text: '思考中' })
    expect(asst!.parts.some((p) => p.type === 'text' && (p as { text?: string }).text === '答')).toBe(true)
  })

  it('往返不丢内容：reasoning 文本在往返前后等价（此前会降级成 text part）', () => {
    const original = mkMsg('a1', 'assistant', [
      { type: 'reasoning', text: '推理过程 ABC' } as never,
      { type: 'text', text: '最终回答' } as never,
    ])

    const roundTrip = requestMessages(toCores([original]).cores)
    const reasoningTexts = roundTrip
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'reasoning')
      .map((p) => (p as { text?: string }).text)

    expect(reasoningTexts).toEqual(['推理过程 ABC'])
    // 也不再以 `<reasoning>` 文本视图混进任何 text part（旧实现的降级形态）
    const textJoined = roundTrip
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text?: string }).text)
      .join('')
    expect(textJoined).not.toContain('<reasoning>')
    expect(textJoined).toContain('最终回答')
  })

  it('孤儿 reasoning（后继非 assistant）兜底为独立消息，内容不丢', () => {
    // 内核配对契约下正常不会出现；防御性覆盖
    const { cores } = toCores([
      mkMsg('a1', 'assistant', [{ type: 'reasoning', text: '孤儿推理' } as never]),
      mkMsg('u1', 'user', [{ type: 'text', text: '下一问' } as never]),
    ])

    const msgs = requestMessages(cores)
    const reasoningMsgs = msgs.filter((m) => m.parts.some((p) => p.type === 'reasoning'))
    expect(reasoningMsgs).toHaveLength(1)
    expect(reasoningMsgs[0]!.parts[0]).toEqual({ type: 'reasoning', text: '孤儿推理' })
    // user 消息不受影响
    expect(msgs.some((m) => m.role === 'user')).toBe(true)
  })

  it('core id 对同一消息稳定：不随输入前缀漂移（covered 幂等判定的前提）', () => {
    // 回归：core id 原用「跨消息累加计数器」（base#0/#1/#2…），同一条消息出现在
    // 全量历史与窗口切片（session.compacting 的 runCompacting 会重新 toCores）里
    // 会得到不同 id ⇒ coveredMessageIds 幂等判定失效（重复折叠 + ref 重复分配）。
    // 修复后 id = base#(r|t|x)partIdx，只依赖消息自身。
    const msg = mkMsg('m5', 'assistant', [
      { type: 'text', text: '内容' } as never,
      { type: 'tool', toolUseId: 'tu', toolId: 'bash', input: { c: 1 } } as never,
    ])
    // 场景 A：全量历史（m5 前面有含 2 个 tool part 的消息）
    const full = toCores([
      mkMsg('m1', 'user', [{ type: 'text', text: 'a' } as never]),
      mkMsg('m2', 'assistant', [
        { type: 'tool', toolUseId: 'tu_a', toolId: 'x', input: {} } as never,
        { type: 'tool', toolUseId: 'tu_b', toolId: 'x', result: {} } as never,
      ]),
      mkMsg('m3', 'user', [{ type: 'text', text: 'b' } as never]),
      msg,
    ])
    // 场景 B：窗口切片（只有 m5）
    const slice = toCores([msg])

    const idsFull = full.cores.filter((c) => c.id.startsWith('m5')).map((c) => c.id)
    const idsSlice = slice.cores.map((c) => c.id)
    expect(idsFull).toEqual(idsSlice)
    // 且各 part 形态的 id 互不相同（tool 与 text 不碰撞）
    expect(new Set(idsFull).size).toBe(idsFull.length)
  })
})
