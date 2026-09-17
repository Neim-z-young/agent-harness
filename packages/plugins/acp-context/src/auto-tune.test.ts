/**
 * auto-tune（按上下文窗口自动适配 ACP 参数）单测。
 *
 * 断言点分三层：
 *  1. 纯公式 `deriveRetainTokens` / `deriveAutoTuneParams` —— 锚点、夹取、单调；
 *  2. 合并语义 `applyAutoTune` —— 用户显式键优先，未写键取推导值；
 *  3. 端到端 `resolveAcpConfig` —— 开关关时与不传 autoTune 等价（行为兼容）。
 */
import { test, expect } from 'bun:test'
import {
  deriveRetainTokens,
  deriveAutoTuneParams,
  applyAutoTune,
  describeAutoTune,
  minCompressRangeCeiling,
  AUTO_TUNE_RETAIN_MIN,
  AUTO_TUNE_RETAIN_MAX,
  AUTO_TUNE_MIN_COMPRESS_FLOOR,
  AUTO_TUNE_ANCHORS,
} from './auto-tune'
import { resolveAcpConfig } from './index'

// ===== 1. 纯公式 =====

test('deriveRetainTokens：三个实测锚点全部严格命中（表=公式的特例）', () => {
  // 200k 锚点（用户指定保真区间 30000~50000 的取值）
  expect(deriveRetainTokens(200_000)).toBe(35_000)
  // 300k（用户指定 50000）
  expect(deriveRetainTokens(300_000)).toBe(50_000)
  // 1m（用户指定 100000）
  expect(deriveRetainTokens(1_000_000)).toBe(100_000)
})

test('deriveRetainTokens：锚点之间对数线性插值，落在相邻锚点区间内', () => {
  // 250k 落在 200k(35k) 与 300k(50k) 之间
  const r250 = deriveRetainTokens(250_000)
  expect(r250).toBeGreaterThan(35_000)
  expect(r250).toBeLessThan(50_000)
  // 500k 落在 300k(50k) 与 1m(100k) 之间
  const r500 = deriveRetainTokens(500_000)
  expect(r500).toBeGreaterThan(50_000)
  expect(r500).toBeLessThan(100_000)
  // 段内线性：400k 是 300k~1M 段内 log 中点附近 → 约 62k
  expect(deriveRetainTokens(400_000)).toBe(62_000)
})

test('deriveRetainTokens：段外按端点斜率外插，窗口放大一个数量级约 +90k', () => {
  const r200k = deriveRetainTokens(200_000)
  const r2m = deriveRetainTokens(2_000_000)
  // 2M 是 200k 的 10 倍 → 沿末段斜率外插 ≈ +60k~+100k，且未触及 150000 上限
  expect(r2m - r200k).toBeGreaterThan(60_000)
  expect(r2m - r200k).toBeLessThan(110_000)
})

test('deriveRetainTokens：上下限夹取与非法输入兜底', () => {
  expect(deriveRetainTokens(50_000)).toBe(AUTO_TUNE_RETAIN_MIN) // 极小窗口 → 下限
  expect(deriveRetainTokens(100_000_000)).toBe(AUTO_TUNE_RETAIN_MAX) // 超大窗口 → 上限
  expect(deriveRetainTokens(0)).toBe(35_000) // 非法 → 回落锚点窗口
  expect(deriveRetainTokens(Number.NaN)).toBe(35_000)
})

test('deriveRetainTokens：随窗口严格单调不降', () => {
  const wins = [8_000, 50_000, 102_400, 128_000, 200_000, 300_000, 500_000, 1_000_000, 2_000_000, 50_000_000]
  const rs = wins.map(deriveRetainTokens)
  for (let i = 1; i < rs.length; i++) expect(rs[i]).toBeGreaterThanOrEqual(rs[i - 1])
})

test('参数表 ↔ 公式一致：三锚点窗口的推导值就是文档 §7.5 的最优参数表', () => {
  const TABLE = [
    { w: 200_000, r: 35_000, gf: 52_500, mc: 140_000 },
    { w: 300_000, r: 50_000, gf: 75_000, mc: 200_000 },
    { w: 1_000_000, r: 100_000, gf: 150_000, mc: 400_000 },
  ]
  for (const t of TABLE) {
    const p = deriveAutoTuneParams(t.w)
    expect(p.retainTokens).toBe(t.r)
    expect(p.growthFloor).toBe(t.gf)
    expect(p.minCompressRange).toBe(t.mc)
  }
  // 锚点集合本身也要与表一致（防止只改公式不改锚点表）
  expect(AUTO_TUNE_ANCHORS).toEqual(TABLE.map((t) => [t.w, t.r]))
})

test('deriveAutoTuneParams：growthFloor = 1.5R、minCompressRange = clamp(4R, 8000, 2(W−R))', () => {
  const p = deriveAutoTuneParams(200_000)
  expect(p.retainTokens).toBe(35_000)
  expect(p.growthFloor).toBe(52_500) // 1.5 × 35000
  // 4×35000 = 140000，上限 2×(200000−35000) = 330000 未绑定 → 取下限系数
  expect(p.minCompressRange).toBe(140_000)

  const big = deriveAutoTuneParams(1_000_000)
  expect(big.retainTokens).toBe(100_000)
  expect(big.growthFloor).toBe(150_000)
  expect(big.minCompressRange).toBe(400_000) // 4 × 100000；上限 1.8M 未绑定

  // 小窗口：4R 也变小，但不会低于绝对下限
  const small = deriveAutoTuneParams(102_400)
  expect(small.retainTokens).toBe(AUTO_TUNE_RETAIN_MIN)
  expect(small.minCompressRange).toBe(60_000) // 4 × 15000
})

test('minCompressRange 不能吃掉可压缩区：MC ≤ 2 × (W − R)，否则 nudge 会被抑制', () => {
  // 守卫本身
  expect(minCompressRangeCeiling(200_000, 35_000)).toBe(330_000)
  expect(minCompressRangeCeiling(102_400, 15_000)).toBe(174_800)
  // 极小窗口下限兜底：可压缩区 2×(17000−15000)=4000 < FLOOR → 取 FLOOR
  expect(minCompressRangeCeiling(17_000, 15_000)).toBe(AUTO_TUNE_MIN_COMPRESS_FLOOR)

  // 用户把保留量钉得很大（200k 窗口 / R=150k）→ 可压缩区只剩 50k，MC 必须被压到 100k 以内
  const pinned = applyAutoTune(200_000, { preserveRecentTokens: 150_000 })
  expect(pinned.compress!.minCompressRange).toBe(100_000)
  expect(pinned.compress!.minCompressRange).toBeLessThanOrEqual(2 * (200_000 - 150_000))

  // 不钉 R 时守卫不介入（与纯公式一致）
  const auto = applyAutoTune(200_000)
  expect(auto.compress!.minCompressRange).toBe(140_000)
})

// ===== 2. 合并语义 =====

test('applyAutoTune：未写键取推导值，growthRatio/minGrowthRatio 归零', () => {
  const cfg = applyAutoTune(1_000_000)
  expect(cfg.preserveRecentTokens).toBe(100_000)
  expect(cfg.nudge!.growthFloor).toBe(150_000)
  // growthCap / minGrowthFloor 与 floor 相等 ⇒ nudgeGrowthTokens ≡ cadenceFloor ≡ GF
  expect(cfg.nudge!.growthCap).toBe(150_000)
  expect(cfg.nudge!.minGrowthFloor).toBe(150_000)
  expect(cfg.nudge!.growthRatio).toBe(0)
  expect(cfg.nudge!.minGrowthRatio).toBe(0)
  expect(cfg.compress!.minCompressRange).toBe(400_000)
})

test('applyAutoTune：用户显式键覆盖推导值，其余仍自动', () => {
  const cfg = applyAutoTune(1_000_000, {
    preserveRecentTokens: 120_000,
    nudge: { maxContextLimitPct: 0.5 },
  })
  // 显式值优先
  expect(cfg.preserveRecentTokens).toBe(120_000)
  expect(cfg.nudge!.maxContextLimitPct).toBe(0.5)
  // 未显式写的键仍走推导
  expect(cfg.nudge!.growthFloor).toBe(150_000)
  expect(cfg.compress!.minCompressRange).toBe(400_000)
  // 显式钉住保留量时，minCompressRange 不跟着变（推导基于窗口而非最终 R）
  expect(cfg.compress!.minCompressRange).not.toBe((cfg.preserveRecentTokens ?? 0) * 4)
})

test('applyAutoTune：用户可单独钉住 growthFloor 系列', () => {
  const cfg = applyAutoTune(300_000, { nudge: { growthFloor: 200_000, growthCap: 200_000, minGrowthFloor: 200_000 } })
  expect(cfg.nudge!.growthFloor).toBe(200_000)
  expect(cfg.nudge!.growthCap).toBe(200_000)
  expect(cfg.nudge!.minGrowthFloor).toBe(200_000)
  expect(cfg.preserveRecentTokens).toBe(50_000) // 仍自动
})

test('applyAutoTune：只写三键中的一键时其余两键跟随（防止 floor 被 cap 静默截断）', () => {
  // 用例背景：300k 窗口推导 GF=75000。内核取 nudgeGrowthTokens = min(growthCap, max(growthFloor, …))，
  // 所以「显式 floor 90000 + 自动 cap 75000」会让用户写的值被静默截断到 75000。
  const up = applyAutoTune(300_000, { nudge: { growthFloor: 90_000 } })
  expect(up.nudge!.growthFloor).toBe(90_000)
  expect(up.nudge!.growthCap).toBe(90_000) // 修复前是 75_000（推导值）⇒ floor 被截断
  expect(up.nudge!.minGrowthFloor).toBe(90_000)

  // 反向：只想压节奏时 floor 跟随下降，而不是造出 floor > cap 的矛盾组合
  const down = applyAutoTune(300_000, { nudge: { growthCap: 10_000 } })
  expect(down.nudge!.growthCap).toBe(10_000)
  expect(down.nudge!.growthFloor).toBe(10_000)
  expect(down.nudge!.minGrowthFloor).toBe(10_000)
  expect(down.nudge!.growthFloor!).toBeLessThanOrEqual(down.nudge!.growthCap!)

  // 三键都显式写 → 原样采用（不做联动改写）
  const all = applyAutoTune(300_000, {
    nudge: { growthFloor: 30_000, growthCap: 40_000, minGrowthFloor: 35_000 },
  })
  expect([all.nudge!.growthFloor, all.nudge!.growthCap, all.nudge!.minGrowthFloor]).toEqual([
    30_000, 40_000, 35_000,
  ])

  // 一键都不写 → 三键同为推导值
  const none = applyAutoTune(300_000)
  expect([none.nudge!.growthFloor, none.nudge!.growthCap, none.nudge!.minGrowthFloor]).toEqual([
    75_000, 75_000, 75_000,
  ])
})

test('describeAutoTune：输出可读摘要且含推导三参数与折叠比', () => {
  const s = describeAutoTune(200_000)
  expect(s).toContain('35000')
  expect(s).toContain('52500')
  expect(s).toContain('minCompressRange=140000')
  expect(s).toContain('压缩比≈14:1') // 140000 / maxSummaryLength(10000)
})

// ===== 3. 端到端：开关语义 =====

test('resolveAcpConfig：autoTune 关（或未传）时完全不介入，与原始参数一致', () => {
  const userCfg = { preserveRecentTokens: 4_000, nudge: { growthFloor: 1 } }
  const off = resolveAcpConfig(200_000, userCfg, false)
  const undef = resolveAcpConfig(200_000, userCfg, undefined)
  expect(off.preserveRecentTokens).toBe(4_000)
  expect(off.nudge.growthFloor).toBe(1)
  expect(undef.preserveRecentTokens).toBe(off.preserveRecentTokens)
  expect(undef.nudge.growthFloor).toBe(off.nudge.growthFloor)
  // 未传 config 时回落 kernel 默认（preserveRecentTokens=5000）
  expect(resolveAcpConfig(200_000, undefined, false).preserveRecentTokens).toBe(5_000)
})

test('resolveAcpConfig：autoTune 开时按窗口推导且可被显式键覆盖', () => {
  const cfg = resolveAcpConfig(1_000_000, undefined, true)
  expect(cfg.preserveRecentTokens).toBe(100_000)
  expect(cfg.nudge.growthFloor).toBe(150_000)
  expect(cfg.nudge.growthCap).toBe(150_000)
  expect(cfg.compress.minCompressRange).toBe(400_000)
  expect(cfg.modelContextLimit).toBe(1_000_000)

  const pinned = resolveAcpConfig(1_000_000, { preserveRecentTokens: 50_000 }, true)
  expect(pinned.preserveRecentTokens).toBe(50_000)
  expect(pinned.nudge.growthFloor).toBe(150_000) // 未显式写 → 仍自动
})

test('resolveAcpConfig：非法配置组合被 kernel 校验捕捉（推导值不越界）', () => {
  // 推导出的 minGrowthFloor(=GF) 远大于 kernel 默认，需确保 < maxContextLimitPct×W 才有意义
  const cfg = resolveAcpConfig(102_400, undefined, true)
  expect(cfg.preserveRecentTokens).toBe(AUTO_TUNE_RETAIN_MIN)
  expect(cfg.nudge.growthFloor).toBe(22_500)
  // 小窗口也要保持 floor < 窗口，否则永远折不动
  expect(cfg.nudge.growthFloor).toBeLessThan(cfg.modelContextLimit)
})
