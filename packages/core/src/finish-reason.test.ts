import { describe, it, expect } from 'bun:test'
import { FINISH_REASON_MAP, normalizeFinishReason, type ChatFinishReason } from './index'

/**
 * finish reason 规范化。
 *
 * 这层的正确性直接决定 agentic loop 的退出判定：把「未知」误判成 'stop' 会让循环
 * 提前退出（工具结果送不回模型，表现为"模型看完文件就停了"）；把 'stop' 误判成
 * 可续轮会让循环空转（多一次无谓请求）。因此下面两条最关键：
 *  - 未知/缺失 ⇒ 'unknown'（**不是** 'stop'）
 *  - 三家原生值各自归一（end_turn / tool_calls / STOP 等）
 */
describe('normalizeFinishReason', () => {
  it('Anthropic 原生值归一', () => {
    expect(normalizeFinishReason('end_turn')).toBe('stop')
    expect(normalizeFinishReason('stop_sequence')).toBe('stop')
    expect(normalizeFinishReason('tool_use')).toBe('tool_calls')
    expect(normalizeFinishReason('max_tokens')).toBe('length')
  })

  it('OpenAI 原生值归一', () => {
    expect(normalizeFinishReason('stop')).toBe('stop')
    expect(normalizeFinishReason('tool_calls')).toBe('tool_calls')
    expect(normalizeFinishReason('function_call')).toBe('tool_calls')
    expect(normalizeFinishReason('length')).toBe('length')
    expect(normalizeFinishReason('content_filter')).toBe('content_filter')
  })

  it('Gemini 原生值归一（大写 + 安全/异常类）', () => {
    expect(normalizeFinishReason('STOP')).toBe('stop')
    expect(normalizeFinishReason('MAX_TOKENS')).toBe('length')
    expect(normalizeFinishReason('SAFETY')).toBe('content_filter')
    expect(normalizeFinishReason('RECITATION')).toBe('content_filter')
    expect(normalizeFinishReason('MALFORMED_FUNCTION_CALL')).toBe('error')
  })

  it('大小写与首尾空白不敏感', () => {
    expect(normalizeFinishReason('STOP')).toBe(normalizeFinishReason('stop'))
    expect(normalizeFinishReason('  end_turn  ')).toBe('stop')
    expect(normalizeFinishReason('Tool_Calls')).toBe('tool_calls')
  })

  it('缺失 / 空串 / 未知值 ⇒ unknown（绝不能落 stop）', () => {
    // 这是本函数最重要的不变量：Provider 没给 finish 信息 ≠ 模型表示结束。
    // 若这里返回 'stop'，agentic loop 会在「有工具调用但 finish 缺失」时直接退出，
    // 工具结果永远送不回模型 —— 与改造前的单轮行为一模一样，改造等于白做。
    for (const raw of [undefined, null, '', '   ', 'some_new_reason', 'eos_v2']) {
      expect(normalizeFinishReason(raw as string | null | undefined)).toBe('unknown')
    }
  })

  it('映射表自身不含 unknown 作值（否则未知值会被静默吞掉）', () => {
    const values = Object.values(FINISH_REASON_MAP)
    expect(values).not.toContain('unknown' as ChatFinishReason)
  })

  it('映射表所有键都是小写、且无空键（大小写不敏感的前提）', () => {
    for (const key of Object.keys(FINISH_REASON_MAP)) {
      expect(key).toBe(key.toLowerCase())
      expect(key.trim()).toBe(key)
      expect(key.length).toBeGreaterThan(0)
    }
  })
})
