/**
 * @harness/host 配置归一化与窗口推导（P0 第三步 B 档）的归属测试。
 *
 * ## 与 cli 侧测试的关系（P0 收尾 S4 已收口）
 * 搬迁期 `cli.test.ts` / `provider-model.test.ts` 里原样保留了一份同能力用例（"re-export 兼容"
 * 口径）。S4 收口时按「**能力归 host，兼容归 cli**」去重：
 *   - 本文件是**唯一**的能力测试 —— 覆盖实现本身，且**不经过 cli**（将来 A2A server / 编辑器扩展
 *     也吃这份实现，不该只被 cli 的测试间接覆盖）；
 *   - cli 侧的重复行为用例已删除，只留一条 re-export 兼容断言（见 `cli.test.ts`）；
 *   - 曾经**只有 cli 覆盖**的 `resolveCompactionWindow` / `buildCompactionOptions` 已移入本文件
 *     （它们是 host 拥有的推导，cli 侧只保留"与 acp-context 同一把尺子"的跨包守卫）。
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
  checkProviderConfigs,
  isUsableWindow,
  resolveContextWindowTokens,
  resolveCompactionWindow,
  buildProviderWindowTable,
  buildCompactionOptions,
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

  it('同 model 多实例：派生 id 递增，但各自 baseUrl 原样保留（同模型多端点仍可区分）', () => {
    const { providers } = normalizeProviderConfigs([
      { type: 'openai', baseUrl: 'http://a', model: 'gpt-4o' },
      { type: 'openai', baseUrl: 'http://b', model: 'gpt-4o' },
      { type: 'openai', baseUrl: 'http://c', model: 'gpt-4o' },
    ] as ProviderConfig[])
    expect(providers.map((p) => p.id)).toEqual(['gpt-4o', 'gpt-4o-2', 'gpt-4o-3'])
    expect(providers.map((p) => p.baseUrl)).toEqual(['http://a', 'http://b', 'http://c'])
  })

  it('显式 id 与派生 id 不冲突（显式优先，派生让位）', () => {
    const { providers } = normalizeProviderConfigs([
      { id: 'gw-a', type: 'openai', baseUrl: 'http://a', model: 'gpt-4o' },
      { type: 'openai', baseUrl: 'http://b', model: 'gpt-4o' },
    ] as ProviderConfig[])
    expect(providers.map((p) => p.id)).toEqual(['gw-a', 'gpt-4o'])
  })
})

describe('checkProviderConfigs：校验也按派生 id 判定（概览与校验不许各说各话）', () => {
  it('省略 id 的配置校验通过，且默认 provider 可引用派生 id', () => {
    // 概览按派生 id 展示、校验也须按派生 id 判定，否则会出现「概览正常但报 id 缺失」的自相矛盾
    const { providers, issues } = checkProviderConfigs(
      [
        { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy4-preview-f' },
        { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy3' },
      ],
      'hy3',
      ['openai', 'anthropic'],
    )
    expect(issues).toHaveLength(0)
    expect(providers.map((p) => p.id)).toEqual(['hy4-preview-f', 'hy3'])
  })

  it('默认 provider 指向不存在的 id 仍报错', () => {
    const { issues } = checkProviderConfigs(
      [{ type: 'openai', baseUrl: 'http://x', model: 'hy3' }],
      'local-hy3',
      ['openai'],
    )
    expect(issues.some((s) => s.includes('未在 providers'))).toBe(true)
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

// ---------------------------------------------------------------------------
// 会话压缩分母：`resolveCompactionWindow` / `buildCompactionOptions`
// ---------------------------------------------------------------------------
// 从 `cli.test.ts` 移入（S4 收口）：这两个是 host 拥有的推导，此前**只有 cli 侧**覆盖。
// 它们把「窗口表 + 本会话端点」翻译成会话压缩实际使用的分母 —— 分母算错就是那条
// 「阈值算到真实窗口之外 ⇒ 自动压缩永不触发且无任何症状」的故障形态。

describe('resolveCompactionWindow：分母跟着本会话端点走', () => {
  const providers = [
    { id: 'online', type: 'openai', model: 'deepseek-flash', contextWindowTokens: 300_000 },
    { id: 'hy3', type: 'openai', model: 'hy3', contextWindowTokens: 200_000 },
  ] as ProviderConfig[]
  const cfg = { providers }

  it('同一份 config、两条会话、两个分母；查不到端点则逐位回到改造前的推导', () => {
    // 这正是要修的 bug 形态：此前恒为默认 Provider 的 300000。
    // 真机后果：阈值 = 95% × (300000 − 30000) = 256500 > 200000 ⇒ 自动压缩**永不触发**且无任何症状。
    expect(resolveCompactionWindow(cfg, 'online', { providerId: 'hy3' })).toBe(200_000)
    expect(resolveCompactionWindow(cfg, 'online', { providerId: 'online' })).toBe(300_000)
    // 只给 modelId 也能命中（agent md 里写 modelId 比写派生出的 provider id 自然）
    expect(resolveCompactionWindow(cfg, 'online', { modelId: 'hy3' })).toBe(200_000)
    // 两个维度都给时按实例维度（更具体）
    expect(resolveCompactionWindow(cfg, 'online', { providerId: 'online', modelId: 'hy3' })).toBe(300_000)
    // 查不到 / 没给端点 ⇒ fallback，逐位等于改造前的推导（"缺省零行为变更"的保证点）
    expect(resolveCompactionWindow(cfg, 'online', { providerId: 'ghost' })).toBe(300_000)
    expect(resolveCompactionWindow(cfg, 'online', {})).toBe(300_000)
    expect(resolveCompactionWindow(cfg, 'online')).toBe(resolveContextWindowTokens(cfg, 'online'))
  })

  it('显式值排在最前（写了就得生效）：compaction 段专用键优先于 compression 的全局键', () => {
    expect(resolveCompactionWindow({ ...cfg, compaction: { contextWindowTokens: 50_000 } }, 'online', { providerId: 'hy3' }))
      .toBe(50_000)
    expect(resolveCompactionWindow({ ...cfg, compression: { modelContextLimit: 60_000 } }, 'online', { providerId: 'hy3' }))
      .toBe(60_000)
  })

  it('表里混进非法窗口（0 / 负数）时不当分母、也不算出 NaN/Infinity', () => {
    const dirty = [{ id: 'zero', type: 'openai', model: 'z', contextWindowTokens: 0 }] as ProviderConfig[]
    expect(resolveCompactionWindow({ providers: dirty }, 'zero', { providerId: 'zero' })).toBe(200_000)
    expect(resolveCompactionWindow({}, 'mock', { providerId: 'x', modelId: 'y' })).toBe(200_000)
  })
})

describe('buildCompactionOptions：窗口按 Provider 推导，配置字段逐项透传', () => {
  it('缺省只带推导出的窗口；compaction 段字段逐项透传；显式窗口压过 Provider', () => {
    const providers = [{ type: 'openai', model: 'hy3', contextWindowTokens: 102_400 }] as ProviderConfig[]
    // 缺省：只带推导出的窗口（102400，而不是 core 内那个硬编码的 200000）
    expect(buildCompactionOptions({ providers }, 'hy3')).toEqual({ contextWindowTokens: 102_400 })
    const opt = buildCompactionOptions(
      {
        providers,
        compaction: {
          strategy: 'prune',
          keepRecentMessages: 20,
          summaryMaxChars: 5_000,
          autoCompactThresholdPct: 70,
          reservedTokens: 10_000,
          tokenCalibration: 'chars4',
        },
      },
      'hy3',
    )
    expect(opt).toEqual({
      contextWindowTokens: 102_400,
      strategy: 'prune',
      keepRecentMessages: 20,
      summaryMaxChars: 5_000,
      autoCompactThresholdPct: 70,
      reservedTokens: 10_000,
      tokenCalibration: 'chars4',
    })
    // compaction.contextWindowTokens 是本段专用覆盖，优先级高于 Provider
    expect(buildCompactionOptions({ providers, compaction: { contextWindowTokens: 60_000 } }, 'hy3').contextWindowTokens)
      .toBe(60_000)
  })

  it('传了端点 ⇒ 窗口按该端点取；不传 ⇒ 仍按默认 Provider（老调用点分母不被静默改掉）', () => {
    const two = [
      { id: 'big', type: 'openai', model: 'm-big', contextWindowTokens: 300_000 },
      { id: 'small', type: 'openai', model: 'm-small', contextWindowTokens: 200_000 },
    ] as ProviderConfig[]
    expect(buildCompactionOptions({ providers: two }, 'big', { providerId: 'small' }).contextWindowTokens).toBe(200_000)
    expect(buildCompactionOptions({ providers: two }, 'big', { providerId: 'big' }).contextWindowTokens).toBe(300_000)
    expect(buildCompactionOptions({ providers: two }, 'big').contextWindowTokens).toBe(300_000)
  })
})
