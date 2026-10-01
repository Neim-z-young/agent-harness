/**
 * @harness/host 配置归一化与窗口推导（P0 第三步 B 档）的归属测试。
 *
 * ## 与 cli 侧测试的关系
 * `cli.test.ts` / `provider-model.test.ts` 里原有用例保留原样（它们测的是「符号还能从
 * `@harness/cli` 拿到 + 行为不变」）。本文件测能力本身，且**不经过 cli** —— 将来 A2A server /
 * 编辑器扩展也吃这份实现，不该只被 cli 的测试间接覆盖。
 *
 * ## 为什么这几条值得钉住
 * 窗口是**占用率的分母**：显示、压缩阈值、ACP 三处若各算一遍，就会得到
 * 「概览说 26%、实际已 103%」这类**全程无症状**的故障（阈值算到真实窗口之外 ⇒ 压缩永不触发）。
 * 所以这里既钉数值，也钉「脏值不当分母」（0 / 负数 / NaN 会让占用率算出 Infinity 或负数）。
 */

import { describe, it, expect } from 'bun:test'
import type { ProviderConfig } from '@harness/plugin'
import {
  parseModelSpec,
  formatModel,
  sanitizeProviderId,
  normalizeProviderConfigs,
  isUsableWindow,
  resolveContextWindowTokens,
  buildProviderWindowTable,
} from './index'

describe('parseModelSpec / formatModel：provider/model 规格解析', () => {
  it('带前缀按 provider/model 拆，裸模型名只有 modelId', () => {
    expect(parseModelSpec('openai/gpt-4o')).toEqual({ providerId: 'openai', modelId: 'gpt-4o' })
    expect(parseModelSpec('claude-3-5-sonnet')).toEqual({ providerId: undefined, modelId: 'claude-3-5-sonnet' })
    expect(parseModelSpec('')).toEqual({ providerId: undefined, modelId: '' })
    // 首字符是 '/' 不算前缀（idx <= 0 走裸名分支）
    expect(parseModelSpec('/foo')).toEqual({ providerId: undefined, modelId: '/foo' })
  })

  it('formatModel 无 providerId 时只回 modelId，modelId 空则 undefined', () => {
    expect(formatModel('openai', 'gpt-4o')).toBe('openai/gpt-4o')
    expect(formatModel(undefined, 'gpt-4o')).toBe('gpt-4o')
    expect(formatModel('openai', undefined)).toBeUndefined()
    expect(formatModel('openai', '')).toBeUndefined()
  })
})

describe('sanitizeProviderId：id 片段规整', () => {
  it('保留 [A-Za-z0-9._-]，其余折叠为连字符并去首尾', () => {
    expect(sanitizeProviderId('Qwen2.5 7B')).toBe('Qwen2.5-7B')
    expect(sanitizeProviderId('  /foo//bar/  ')).toBe('foo-bar')
    expect(sanitizeProviderId('a_b-c.d')).toBe('a_b-c.d')
    expect(sanitizeProviderId('中文')).toBe('')
  })
})

describe('normalizeProviderConfigs：id 缺省由 model 派生', () => {
  it('显式 id 原样保留；缺 id 由 model 派生（去 provider/ 前缀并规整）', () => {
    const { providers, issues } = normalizeProviderConfigs([
      { id: 'hy3', type: 'openai', model: 'hy3' },
      { type: 'openai', model: 'openai/gpt-4o' },
    ] as ProviderConfig[])
    expect(issues).toEqual([])
    expect(providers.map((p) => p.id)).toEqual(['hy3', 'gpt-4o'])
  })

  it('派生 id 冲突时按数组顺序追加 -2 / -3（结果确定、可复现）', () => {
    const { providers } = normalizeProviderConfigs([
      { type: 'openai', model: 'hy3' },
      { type: 'openai', model: 'hy3' },
      { type: 'openai', model: 'hy3' },
    ] as ProviderConfig[])
    expect(providers.map((p) => p.id)).toEqual(['hy3', 'hy3-2', 'hy3-3'])
  })

  it('显式 id 重复 → 报错并保留首个（沿用旧校验语义，不静默覆盖注册）', () => {
    const { providers, issues } = normalizeProviderConfigs([
      { id: 'dup', type: 'openai', model: 'a' },
      { id: 'dup', type: 'openai', model: 'b' },
    ] as ProviderConfig[])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.index).toBe(1)
    expect(issues[0]!.message).toContain('重复')
    expect(providers).toHaveLength(1)
  })

  it('id 与 model 都缺 → 报错且不入列（无从派生）', () => {
    const { providers, issues } = normalizeProviderConfigs([{ type: 'openai', baseUrl: 'http://x' } as ProviderConfig])
    expect(providers).toEqual([])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toContain('无法派生')
  })
})

describe('isUsableWindow：能不能当分母', () => {
  it('只有正有限数可用；0 / 负数 / NaN / Infinity 一律按「没配」', () => {
    expect(isUsableWindow(200_000)).toBe(true)
    expect(isUsableWindow(1)).toBe(true)
    expect(isUsableWindow(0)).toBe(false)
    expect(isUsableWindow(-1)).toBe(false)
    expect(isUsableWindow(Number.NaN)).toBe(false)
    expect(isUsableWindow(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isUsableWindow(undefined)).toBe(false)
    expect(isUsableWindow('200000')).toBe(false)
  })
})

describe('resolveContextWindowTokens：三级推导', () => {
  const providers = [
    { id: 'hy3', type: 'openai', model: 'hy3', contextWindowTokens: 102_400 },
    { id: 'other', type: 'openai', model: 'm', contextWindowTokens: 1_000_000 },
  ] as ProviderConfig[]

  it('compression.modelContextLimit → 默认 Provider 的窗口 → 200000', () => {
    expect(resolveContextWindowTokens({ providers, compression: { modelContextLimit: 300_000 } }, 'hy3')).toBe(300_000)
    expect(resolveContextWindowTokens({ providers }, 'hy3')).toBe(102_400)
    expect(resolveContextWindowTokens({ providers }, 'other')).toBe(1_000_000)
    expect(resolveContextWindowTokens({}, 'mock')).toBe(200_000)
    // 默认 Provider 不在 providers 里（如拼错 id）⇒ 回落 200000，不抛错
    expect(resolveContextWindowTokens({ providers }, 'ghost')).toBe(200_000)
  })

  it('脏窗口（0 / 负数）与脏显式值都不当分母，逐级回落', () => {
    const broken = [
      { id: 'zero', type: 'openai', model: 'z', contextWindowTokens: 0 },
      { id: 'neg', type: 'openai', model: 'n', contextWindowTokens: -5 },
    ] as ProviderConfig[]
    expect(resolveContextWindowTokens({ providers: broken }, 'zero')).toBe(200_000)
    expect(resolveContextWindowTokens({ providers: broken }, 'neg')).toBe(200_000)
    expect(resolveContextWindowTokens({ providers: broken, compression: { modelContextLimit: 0 } }, 'zero')).toBe(200_000)
  })
})

describe('buildProviderWindowTable：按端点建表（ACP 的分母来源）', () => {
  const providers = [
    { id: 'big', type: 'openai', model: 'gpt-4o', contextWindowTokens: 1_000_000 },
    { id: 'small-a', type: 'openai', model: 'hy3', contextWindowTokens: 200_000 },
    { id: 'small-b', type: 'openai', model: 'hy3', contextWindowTokens: 102_400 },
    { id: 'no-win', type: 'openai', model: 'm1' },
    { id: 'zero', type: 'openai', model: 'm2', contextWindowTokens: 0 },
  ] as ProviderConfig[]

  it('byProvider 按实例 id，缺窗口/脏窗口的实例不入表', () => {
    const t = buildProviderWindowTable({ providers }, 'big')
    expect(t.byProvider).toEqual({ big: 1_000_000, 'small-a': 200_000, 'small-b': 102_400 })
    expect(t.byProvider['no-win']).toBeUndefined()
    expect(t.byProvider['zero']).toBeUndefined()
  })

  it('byModel 对同名多实例取最小（宁可早压；分母虚高会漏压）', () => {
    const t = buildProviderWindowTable({ providers }, 'big')
    expect(t.byModel['hy3']).toBe(102_400)
    expect(t.byModel['m1']).toBeUndefined()
  })

  it('fallback 与 resolveContextWindowTokens 同源（查不到端点时逐位回到改造前）', () => {
    const t = buildProviderWindowTable({ providers }, 'big')
    expect(t.fallback).toBe(resolveContextWindowTokens({ providers }, 'big'))
    const t2 = buildProviderWindowTable({ providers, compression: { modelContextLimit: 300_000 } }, 'big')
    expect(t2.fallback).toBe(300_000)
  })

  it('省略 id 的实例用派生 id 入表（表里的键必须能被 byProvider 命中）', () => {
    const t = buildProviderWindowTable({ providers: [{ type: 'openai', model: 'hy3', contextWindowTokens: 128_000 }] }, 'hy3')
    expect(t.byProvider['hy3']).toBe(128_000)
  })

  it('空配置 / 无参数时给出空表 + 200000 兜底', () => {
    expect(buildProviderWindowTable({}, 'mock')).toEqual({ byProvider: {}, byModel: {}, fallback: 200_000 })
  })

  it('窄类型契约：带多余字段的宽对象（模拟 HarnessConfig）可直接传入', () => {
    // host 只声明自己读的两段（providers / compression.modelContextLimit）；宽类型天然兼容。
    const wide = {
      agentId: 'default',
      providers,
      compression: { enabled: true, modelContextLimit: 300_000, tokenCalibration: 'auto' as const },
      compaction: { strategy: 'summary' as const },
      plugins: ['memory'],
    }
    expect(resolveContextWindowTokens(wide, 'big')).toBe(300_000)
    expect(buildProviderWindowTable(wide, 'big').fallback).toBe(300_000)
  })
})
