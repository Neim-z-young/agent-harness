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

test('formatWindowGuardNotice：无内容可折时点明已交回内核截断兜底（不是静默无事发生）', () => {
  const text = formatWindowGuardNotice({
    occupancy: 0.93,
    window: 10_000,
    used: 9_300,
    guard: G,
    foldSkipped: true,
  })
  expect(text).toContain('没有够格的可折叠内容')
  expect(text).toContain('truncate')
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
