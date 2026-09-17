import { describe, it, expect } from 'bun:test'
import {
  countTokensCJK,
  countTokensChars4,
  resolveCountTokens,
} from './index'

/**
 * 这里的定值断言是**口径守卫**：countTokensCJK 必须与 acp-kernel 的 `defaultCountTokens`
 * 保持一致（中日韩 1 token/字 + 其余 4 字符/token）。两边一旦漂移，ACP 层（用内核的函数）
 * 与会话压缩层（用本文件的函数）就会对同一个会话给出两个占用率 —— 表现为「ACP 判定已超窗、
 * 会话自动压缩却说远未到阈值」。测试失败时请同步两边，而不是改这里的数字。
 */
describe('token 折算口径（与 acp-kernel defaultCountTokens 同口径）', () => {
  it('纯英文：4 字符 1 token（向上取整）', () => {
    expect(countTokensCJK('hello world')).toBe(3) // 11 chars → ceil(11/4)=3
    expect(countTokensCJK('abcd')).toBe(1)
    expect(countTokensCJK('abcde')).toBe(2)
  })

  it('空串与非字符串输入 → 0', () => {
    expect(countTokensCJK('')).toBe(0)
    expect(countTokensCJK(undefined as unknown as string)).toBe(0)
    expect(countTokensChars4('')).toBe(0)
  })

  it('纯中文：1 字 1 token（旧口径只算 1/4）', () => {
    const zh = '这是一段中文技术讨论内容'
    expect(countTokensCJK(zh)).toBe(12)
    expect(countTokensChars4(zh)).toBe(3) // ceil(12/4)
  })

  it('中英混排：分别按各自口径相加后再取整', () => {
    // “中文”（2 字）+ “ is fine”（8 chars，含空格）→ 2 + ceil(8/4)=2+2=4
    expect(countTokensCJK('中文 is fine')).toBe(4)
  })

  it('日文假名与韩文同样按 1 字 1 token', () => {
    expect(countTokensCJK('こんにちは')).toBe(5)
    expect(countTokensCJK('안녕하세요')).toBe(5)
  })

  it('中文会话下两口径相差约 4 倍（ACP 修正前低估的来源）', () => {
    const text = '我们讨论一下这个模块的重构方案和它对上下文压缩的影响'
    expect(countTokensCJK(text)).toBe(26)
    expect(countTokensChars4(text)).toBe(7)
    expect(countTokensCJK(text) / countTokensChars4(text)).toBeGreaterThan(3.5)
  })

  it('英文会话下两口径逐位等价（修正不得引入英文回归）', () => {
    for (const t of ['function foo() { return 1 }', 'The quick brown fox jumps over the lazy dog', 'a'.repeat(1001)]) {
      expect(countTokensCJK(t)).toBe(countTokensChars4(t))
    }
  })

  it('resolveCountTokens：缺省 auto（CJK 感知），chars4 走旧口径', () => {
    expect(resolveCountTokens()).toBe(countTokensCJK)
    expect(resolveCountTokens('auto')).toBe(countTokensCJK)
    expect(resolveCountTokens('chars4')).toBe(countTokensChars4)
    expect(resolveCountTokens(undefined)('中文')).toBe(2)
  })
})
