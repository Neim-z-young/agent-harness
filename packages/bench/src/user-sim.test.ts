/**
 * user-sim：终止 token 判定（纯函数，此前零覆盖）。
 *
 * 判定一旦漂移，表现是「对话永远停不下来 / 提前停」——不崩，只是跑分口径变掉。
 */
import { describe, expect, it } from 'bun:test'
import { OUT_OF_SCOPE, STOP, TRANSFER, detectTermination } from './user-sim'

describe('detectTermination', () => {
  it('三个 token 各自映射', () => {
    expect(detectTermination(STOP)).toBe('stop')
    expect(detectTermination(TRANSFER)).toBe('transfer')
    expect(detectTermination(OUT_OF_SCOPE)).toBe('out_of_scope')
  })

  it('token 嵌在句子中间也识别（官方口径是 includes，不是全等）', () => {
    expect(detectTermination(`好的，那就这样${STOP}谢谢`)).toBe('stop')
  })

  it('无 token ⇒ null（对话继续）', () => {
    expect(detectTermination('我还想改一下地址')).toBeNull()
    expect(detectTermination('')).toBeNull()
  })

  it('同时含多个 token 时按官方优先级取 stop', () => {
    expect(detectTermination(`${TRANSFER}${STOP}`)).toBe('stop')
    expect(detectTermination(`${OUT_OF_SCOPE}${TRANSFER}`)).toBe('transfer')
  })
})
