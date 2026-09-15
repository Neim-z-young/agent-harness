import { describe, it, expect } from 'bun:test'
import {
  SESSION_MODEL_META_KEY,
  getSessionModelOverride,
  sessionModelMetaPatch,
  type Session,
} from './index'

function sess(meta: Record<string, unknown> | undefined): Pick<Session, 'meta'> {
  return { meta }
}

describe('getSessionModelOverride：会话级模型覆盖的读取', () => {
  it('读取 providerId + modelId', () => {
    expect(getSessionModelOverride(sess({ model: { providerId: 'hy3', modelId: 'hy3' } })))
      .toEqual({ providerId: 'hy3', modelId: 'hy3' })
  })

  it('只给 modelId（未配置 providers 时的裸模型名用法）', () => {
    expect(getSessionModelOverride(sess({ model: { modelId: 'claude-3-7-sonnet' } })))
      .toEqual({ modelId: 'claude-3-7-sonnet' })
  })

  it('只给 providerId（用该 Provider 的默认模型）', () => {
    expect(getSessionModelOverride(sess({ model: { providerId: 'local' } })))
      .toEqual({ providerId: 'local' })
  })

  it('无 meta / 无该 key / null（清除后的形态）→ 视作未覆盖', () => {
    expect(getSessionModelOverride(sess(undefined))).toBeUndefined()
    expect(getSessionModelOverride(sess({}))).toBeUndefined()
    expect(getSessionModelOverride(sess({ model: null }))).toBeUndefined()
    expect(getSessionModelOverride(undefined)).toBeUndefined()
  })

  it('形状非法或字段全空 → 视作未覆盖（不抛错，避免半个坏值把会话打开就崩）', () => {
    expect(getSessionModelOverride(sess({ model: 'hy3' }))).toBeUndefined()
    expect(getSessionModelOverride(sess({ model: ['hy3'] }))).toBeUndefined()
    expect(getSessionModelOverride(sess({ model: {} }))).toBeUndefined()
    expect(getSessionModelOverride(sess({ model: { providerId: '  ', modelId: '' } }))).toBeUndefined()
    expect(getSessionModelOverride(sess({ model: { providerId: 123, modelId: null } }))).toBeUndefined()
  })

  it('字段两侧空白被裁掉，且不携带无关字段', () => {
    expect(getSessionModelOverride(sess({ model: { providerId: ' hy3 ', modelId: ' hy3 ', temperature: 0.5 } })))
      .toEqual({ providerId: 'hy3', modelId: 'hy3' })
  })
})

describe('sessionModelMetaPatch：写入 / 清除', () => {
  it('写入覆盖', () => {
    expect(sessionModelMetaPatch({ providerId: 'hy3', modelId: 'hy3' })).toEqual({ [SESSION_MODEL_META_KEY]: { providerId: 'hy3', modelId: 'hy3' } })
  })

  it('清除写 null 而非删 key —— updateMeta 是浅合并，只有显式给值才能盖掉旧覆盖', () => {
    const patch = sessionModelMetaPatch(undefined)
    expect(patch).toEqual({ [SESSION_MODEL_META_KEY]: null })
    expect(SESSION_MODEL_META_KEY in patch).toBe(true)
  })

  it('往返：写进去再读出来形状一致；清除后回到「未覆盖」', () => {
    const merged: Record<string, unknown> = { compaction: { count: 1 } }
    Object.assign(merged, sessionModelMetaPatch({ providerId: 'a', modelId: 'b' }))
    expect(getSessionModelOverride(sess(merged))).toEqual({ providerId: 'a', modelId: 'b' })
    // 只覆盖 model 键，其它 meta 键保留（浅合并不动 compaction）
    Object.assign(merged, sessionModelMetaPatch(undefined))
    expect(getSessionModelOverride(sess(merged))).toBeUndefined()
    expect(merged.compaction).toEqual({ count: 1 })
  })
})
