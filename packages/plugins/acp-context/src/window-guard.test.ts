import { test, expect } from 'bun:test'
import {
  decideWindowGuardAction,
  formatWindowGuardNotice,
  formatWindowGuardRefusal,
  resolveWindowGuard,
  WINDOW_GUARD_DEFAULTS,
} from './window-guard'

// ===== resolveWindowGuard：默认值 / 非法取值回落 =====

test('resolveWindowGuard：不传即默认（开启，0.75 / 0.90 / 0.98 / truncate）', () => {
  expect(resolveWindowGuard()).toEqual(WINDOW_GUARD_DEFAULTS)
  expect(resolveWindowGuard(undefined)).toEqual(WINDOW_GUARD_DEFAULTS)
  expect(resolveWindowGuard().enabled).toBe(true)
})

test('resolveWindowGuard：部分字段覆盖，未给字段取默认', () => {
  expect(resolveWindowGuard({ notifyPct: 0.5 })).toEqual({
    ...WINDOW_GUARD_DEFAULTS,
    notifyPct: 0.5,
  })
  expect(resolveWindowGuard({ enabled: false }).enabled).toBe(false)
  expect(resolveWindowGuard({ onExceed: 'refuse' }).onExceed).toBe('refuse')
})

test('resolveWindowGuard：非法阈值一律回落默认（本闸是旁路保护，不因拼错让会话起不来）', () => {
  const bad = resolveWindowGuard({
    // 0 = 该档恒真；1.5 = 超过窗口；NaN / 负数 / 字符串都是"写错了"
    notifyPct: 0,
    forceCompressPct: 1.5,
    onExceedPct: NaN,
    enabled: 'yes' as unknown as boolean,
    onExceed: 'abort' as unknown as 'truncate',
  })
  expect(bad).toEqual(WINDOW_GUARD_DEFAULTS)
  expect(resolveWindowGuard({ notifyPct: -1 }).notifyPct).toBe(WINDOW_GUARD_DEFAULTS.notifyPct)
  expect(resolveWindowGuard({ notifyPct: '0.9' as unknown as number }).notifyPct).toBe(
    WINDOW_GUARD_DEFAULTS.notifyPct,
  )
})

test('resolveWindowGuard：边界值 1 合法（= 占满窗口即该档）', () => {
  expect(resolveWindowGuard({ notifyPct: 1 }).notifyPct).toBe(1)
})

test('resolveWindowGuard：includeFixedOverhead 默认 true，显式 false 才关（关 = 逐位回到消息体口径）', () => {
  expect(resolveWindowGuard().includeFixedOverhead).toBe(true)
  expect(resolveWindowGuard({ includeFixedOverhead: false }).includeFixedOverhead).toBe(false)
  // 非布尔按默认处理 —— 与 enabled 同纪律（一个拼错的开关不该让安全线含义变模糊）
  expect(
    resolveWindowGuard({ includeFixedOverhead: 'no' as unknown as boolean }).includeFixedOverhead,
  ).toBe(true)
})

// ===== decideWindowGuardAction：四档 + 边界 =====

const G = resolveWindowGuard()
const action = (occupancy: number, guard = G) => decideWindowGuardAction({ occupancy, guard })

test('decideWindowGuardAction：四档按占用率逐级升级', () => {
  expect(action(0.5)).toBe('none')
  expect(action(0.74)).toBe('none')
  expect(action(0.75)).toBe('notify') // 边界含在 notify（>=）
  expect(action(0.9)).toBe('forceCompress') // 边界含在 forceCompress
  // 默认 onExceed:'truncate' ⇒ 到硬线仍返回 forceCompress，把"再折一次"排在"切工具输出"之前
  expect(action(0.99)).toBe('forceCompress')
})

test('decideWindowGuardAction：onExceed=refuse 时硬线返回 refuse（优先于 forceCompress）', () => {
  const guard = resolveWindowGuard({ onExceed: 'refuse' })
  expect(action(0.89, guard)).toBe('notify')
  expect(action(0.9, guard)).toBe('forceCompress')
  expect(action(0.97, guard)).toBe('forceCompress')
  expect(action(0.98, guard)).toBe('refuse')
  expect(action(1.2, guard)).toBe('refuse')
})

test('decideWindowGuardAction：enabled=false 一律 none（= 改造前行为）', () => {
  const guard = resolveWindowGuard({ enabled: false })
  expect(action(0.5, guard)).toBe('none')
  expect(action(0.8, guard)).toBe('none')
  expect(action(0.95, guard)).toBe('none')
  expect(action(1.5, guard)).toBe('none')
})

test('decideWindowGuardAction：阈值不单调时只退化为"低档不可达"，不会"过线却只告警"', () => {
  // 配置写反：notifyPct 高于 forceCompressPct。判定顺序按**严重度**而非阈值大小，
  // 所以已过强制折叠线时返回的仍是 forceCompress（而不是被 notifyPct 截胡）。
  const guard = resolveWindowGuard({ notifyPct: 0.9, forceCompressPct: 0.6 })
  expect(decideWindowGuardAction({ occupancy: 0.7, guard })).toBe('forceCompress')
  expect(decideWindowGuardAction({ occupancy: 0.95, guard })).toBe('forceCompress')
})

test('decideWindowGuardAction：非有限 / 非正占用率按 none（分母异常时不动手）', () => {
  expect(action(NaN)).toBe('none')
  expect(action(Infinity)).toBe('none')
  expect(action(0)).toBe('none')
  expect(action(-0.5)).toBe('none')
})

// ===== 文案：必须自带可读的数字与出路 =====

test('formatWindowGuardNotice：notify 档写清当前占用与下一档在哪', () => {
  const text = formatWindowGuardNotice({
    occupancy: 0.78,
    window: 300_000,
    used: 234_000,
    guard: G,
  })
  expect(text).toContain('超过告警线 75.0%')
  expect(text).toContain('强制折叠线 90.0%')
  expect(text).toContain('300,000')
  expect(text).toContain('234,000')
  expect(text).toContain('78.0%')
})

test('formatWindowGuardNotice：forceCompress 折叠成功报块数/回收量，并点明可 decompress', () => {
  const text = formatWindowGuardNotice({
    occupancy: 0.95,
    window: 10_000,
    used: 4_000,
    guard: G,
    folded: { blocks: 3, tokens: 6_000 },
  })
  expect(text).toContain('已强制折叠')
  expect(text).toContain('折 3 段')
  expect(text).toContain('6,000 tokens')
  expect(text).toContain('decompress')
})

test('formatWindowGuardNotice：折叠成功必须分开报「触发时」与「折叠后」两个占用率', () => {
  // 回归：调用点曾只留一个变量，折叠后的值覆盖掉触发时的值，文案写成
  // 「占用 90.0%（其实是阈值）→ 折叠，折叠前 12.0%（其实是折叠后）」——自证矛盾
  // （12.0% 触发不了 90.0% 的线）。这条用例同时钉住两个数各有独立来源。
  const text = formatWindowGuardNotice({
    occupancy: 0.847,
    occupancyAfter: 0.12,
    window: 300_000,
    used: 35_855,
    guard: resolveWindowGuard(),
    folded: { blocks: 3, tokens: 203_758 },
  })
  expect(text).toContain('占用 84.7% 已达强制折叠线 90.0%')
  expect(text).toContain('折叠后 12.0%')
  expect(text).not.toContain('折叠前')
  expect(text).toContain('203,758 tokens')
})

test('formatWindowGuardNotice：没给 occupancyAfter 时不编造「折叠后」（老调用方仍可用）', () => {
  const text = formatWindowGuardNotice({
    occupancy: 0.93,
    window: 10_000,
    used: 9_300,
    guard: resolveWindowGuard(),
    folded: { blocks: 1, tokens: 500 },
  })
  expect(text).toContain('已达强制折叠线 90.0%')
  expect(text).not.toContain('折叠后')
})

test('formatWindowGuardNotice：折不动时点明成因 + 给出路 + 说清后果（不是静默无事发生）', () => {
  const base = { occupancy: 0.93, window: 10_000, used: 9_300, guard: G }
  const noRanges = formatWindowGuardNotice({ ...base, foldSkipReason: 'no-ranges' })
  expect(noRanges).toContain('没有未压缩的原文可折')
  expect(noRanges).toContain('truncate')
  // 出路纪律：只说"我没动手"就是把静默损坏换成静默报错
  expect(noRanges).toContain('/compact')
  expect(noRanges).toContain('decompress')
  expect(noRanges).toContain('modelContextLimit')

  const thin = formatWindowGuardNotice({ ...base, foldSkipReason: 'below-threshold' })
  expect(thin).toContain('minCompressRange')

  const noSummary = formatWindowGuardNotice({ ...base, foldSkipReason: 'no-summary' })
  expect(noSummary).toContain('归档缺失')

  // 三种成因**措辞必须互不相同** —— 压成一句就退化为"自检面撒谎"
  expect(new Set([noRanges, thin, noSummary]).size).toBe(3)
})

test('formatWindowGuardRefusal：错误文案必须自带出路（否则只是把静默损坏换成静默报错）', () => {
  const text = formatWindowGuardRefusal({
    occupancy: 0.99,
    window: 300_000,
    used: 297_000,
    guard: resolveWindowGuard({ onExceed: 'refuse' }),
  })
  expect(text).toContain('refuse')
  expect(text).toContain('未向模型发起请求')
  expect(text).toContain('/compact') // 可执行出路
  expect(text).toContain('decompress')
  expect(text).toContain('truncate') // 改回内核兜底的那条
  expect(text).toContain('modelContextLimit') // 窗口配小了的可能
})

// ===== 固定前缀（system prompt + 工具 schema）计入读数 =====

test('formatWindowGuardNotice：给了固定前缀就计入「实际发出」并单列（判据与读数同口径）', () => {
  const text = formatWindowGuardNotice({
    occupancy: 0.9,
    window: 100_000,
    used: 80_000,
    fixed: 9_600,
    guard: G,
  })
  expect(text).toContain('实际发出 89,600（89.6%）')
  expect(text).toContain('含固定前缀 9,600')
})

test('formatWindowGuardNotice：不给固定前缀时读数只算消息体（老调用方逐字不变）', () => {
  const text = formatWindowGuardNotice({ occupancy: 0.8, window: 100_000, used: 80_000, guard: G })
  expect(text).toContain('实际发出 80,000（80.0%）')
  expect(text).not.toContain('含固定前缀')
})

test('formatWindowGuardRefusal：固定前缀同样计入「实际发出」（否则与判据对不上）', () => {
  const text = formatWindowGuardRefusal({
    occupancy: 0.99,
    window: 100_000,
    used: 90_000,
    fixed: 9_600,
    guard: resolveWindowGuard({ onExceed: 'refuse' }),
  })
  expect(text).toContain('实际发出 99,600（99.6%）')
  expect(text).toContain('含固定前缀 9,600')
})
