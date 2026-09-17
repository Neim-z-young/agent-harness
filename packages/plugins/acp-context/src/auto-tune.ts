/**
 * ACP 参数自动适配（auto-tune）
 *
 * 由模型上下文窗口 W 推导 compression / nudge 参数，免去手工换算。
 * 参数来自 bench 实测（`bench/compress-params.ts`，见 `docs/acp-context-config.md` §7.4/§7.5）：
 *
 * ```
 * R  = clamp(round500(interpAnchors(W)), 15000, 150000)   // tokens
 *      interpAnchors：在 log10(W) 上按 AUTO_TUNE_ANCHORS 分段线性插值，两端按端点段斜率延伸
 *      (200000, 35000) → (300000, 50000) → (1000000, 100000)
 * GF = round500(1.5 × R)        → nudge.growthFloor = growthCap = minGrowthFloor
 * MC = clamp(4 × R, 8000, 2 × (W − R))   → compress.minCompressRange（单位 chars）
 * ```
 *
 * 三个锚点是**手工调优并实测过的最优值**（§7.5 参数表），插值保证
 * `deriveAutoTuneParams(锚点窗口)` 与参数表**逐位一致**——即「表是特例、公式是推广」。
 *
 * 语义：
 * - `R`（= `preserveRecentTokens`）是保护区：最近 R tokens 原文永不折叠，也是"每轮全价"
 *   的那部分（每轮都在变、永不命中前缀缓存）；
 * - `GF`（= `nudgeGrowthTokens`）是折叠触发量，`growthRatio = minGrowthRatio = 0` 让
 *   `nudgeGrowthTokens ≡ cadenceFloor ≡ GF`，于是节奏恒为「攒到约 R+GF 折一次、一次折掉约 GF」；
 * - `MC` 是**折叠粒度**（kernel 用 `mergeRangesToThreshold` 把连续可压缩范围合并到 ≥ MC chars
 *   才算一个折叠块，尾部不足 MC 的残块被丢弃不计入 pending）。它同时决定**单次折叠的压缩比**
 *   `≈ MC / maxSummaryLength`，即保真度损失：MC 越大 → 一次吞掉的原文越多、摘要上限不变 → 真实率越低。
 *
 * ⚠️ MC 的**上限**必须绑在可压缩区上，不能是绝对值：
 * `MC ≥ 可压缩区 chars` 时 `pendingByTier` 会把合并后的 range 全部过滤掉 → nudge 被抑制
 * （kernel 原话 "nudge suppressed to avoid offering ranges below minCompressRange"）→
 * **压缩彻底失效、请求一路涨到窗口后只能靠 truncate 兜底**。实测 200k 窗口 MC=600000 chars
 * 峰值即 203k（超窗 101%）、MC=900000 峰值 279k（139%）。
 * 这里按 kernel 自身的记账口径（`chars/4` tokens）取可压缩区 `≈ 4 × (W − R)` chars 的一半，
 * 即 `MC ≤ 2 × (W − R)`。注意该口径随内容类型变化：**中文 1 字 ≈ 1 token 时同一窗口的
 * 可压缩区只有英文的 1/4**，故 MC 也需要同步压到 1/4 —— 这正是不能用绝对下限的原因
 * （旧公式的 `max(200000, 4R)` 在中文 200k 窗口下 MC 反而大于可压缩区）。
 *
 * 实测（8 档窗口，同会话长度 500k/700k/1M 原文）：命中率 85.20% → 95.72% 单调上升，
 * 峰值占用 95.9%（102400 极限会话）→ 20.5%（2M），全部不超窗。
 *
 * 仅在 `autoTune` 开启时生效；任何**显式写出**的 compression 字段都会覆盖这里的推导值
 * （见 `applyAutoTune`），所以可以「自动打底 + 手工钉一两个键」。
 */

import type { Config } from 'acp-kernel'

// ===== 锚点与系数（改这里即可调整公式，勿散落到各处）=====

/**
 * 实测锚点表：`[窗口 tokens, 保护区 R tokens]`，**按窗口升序**。
 *
 * 这三组是 bench 网格扫描（R × GF × MC）后手工选定的最优值，也是
 * `docs/acp-context-config.md` §7.5「最优参数表」的数据源；其它窗口在 log10(W) 上
 * 于相邻锚点间线性插值（两端按端点段斜率延伸，再夹到 `RETAIN_MIN`/`RETAIN_MAX`）。
 *
 * 注意 `R` 是**保真锚定**（近期原文保底量），不是成本最优——成本最优会一直往小压，
 * 但小到一定程度后模型会丢失近场细节。实测：200k 窗口 R=28000 比 R=35000 便宜 ~4%，
 * 代价是峰值占窗从 73% 降到 60%（可压缩区被挤小，折叠更频繁）。
 */
export const AUTO_TUNE_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [200_000, 35_000],
  [300_000, 50_000],
  [1_000_000, 100_000],
]

/** 兜底窗口（非法/缺失 `modelContextLimit` 时视为该窗口）＝ 首个锚点窗口 */
export const AUTO_TUNE_ANCHOR_WINDOW = AUTO_TUNE_ANCHORS[0][0]
/** 保留量下/上限（tokens）：下限保证小窗口仍有足够近期原文，上限避免超大窗口把窗口吃满 */
export const AUTO_TUNE_RETAIN_MIN = 15_000
export const AUTO_TUNE_RETAIN_MAX = 150_000
/** 折叠块系数：growthFloor = AUTO_TUNE_GROWTH_FACTOR × R */
export const AUTO_TUNE_GROWTH_FACTOR = 1.5
/** 压缩粒度系数：minCompressRange = AUTO_TUNE_MIN_COMPRESS_FACTOR × R（chars） */
export const AUTO_TUNE_MIN_COMPRESS_FACTOR = 4
/** 压缩粒度绝对下限（chars）：仅在 R 被钉得极小时兜底，防止折叠碎成小片 */
export const AUTO_TUNE_MIN_COMPRESS_FLOOR = 8_000
/**
 * 压缩粒度相对可压缩区（`W − R`）的**上限倍数**（chars 口径）。
 *
 * 语义：`MC ≤ AUTO_TUNE_MIN_COMPRESS_REGION_FRACTION × (W − R)`。系数 2 对应
 * 「MC 最多吃到可压缩区的一半（按 kernel 默认 `chars/4` 记账）」——超过这个量级后
 * 合并范围会撞上 MC 门槛而被 `pendingByTier` 过滤，nudge 直接失效（见文件头说明）。
 */
export const AUTO_TUNE_MIN_COMPRESS_REGION_FRACTION = 2

/** 折算到 500 的整数倍，便于人类阅读与现网配置对齐 */
const round500 = (n: number): number => Math.max(500, Math.round(n / 500) * 500)

/** 窗口 → log10，非法输入回落锚点窗口 */
const logWindow = (modelContextLimit: number): number =>
  Math.log10(
    Number.isFinite(modelContextLimit) && modelContextLimit > 0
      ? modelContextLimit
      : AUTO_TUNE_ANCHOR_WINDOW,
  )

/**
 * 锚点分段线性插值（自变量为 `log10(W)`，保证平滑单调）。
 *
 * - 落在两锚点之间 → 按该段斜率插值（**锚点处严格命中参数表**）；
 * - 低于首锚点 / 高于末锚点 → 按相邻端点段的斜率向两端延伸（对数尺度外插）；
 * - 结果再夹到 `[AUTO_TUNE_RETAIN_MIN, AUTO_TUNE_RETAIN_MAX]` 并折算到 500 的倍数。
 */
export function interpRetainTokens(modelContextLimit: number): number {
  const x = logWindow(modelContextLimit)
  const A = AUTO_TUNE_ANCHORS
  let i = 0
  while (i < A.length - 2 && x > Math.log10(A[i + 1][0])) i++
  const [wLo, rLo] = A[i]
  const [wHi, rHi] = A[i + 1]
  const slope = (rHi - rLo) / (Math.log10(wHi) - Math.log10(wLo))
  const r = rLo + slope * (x - Math.log10(wLo))
  return round500(Math.min(AUTO_TUNE_RETAIN_MAX, Math.max(AUTO_TUNE_RETAIN_MIN, r)))
}

/**
 * 推导保护区 token 量 R：锚点分段插值（见 `AUTO_TUNE_ANCHORS`），夹到 [15000, 150000]。
 * 严格命中三个锚点：200k → 35000、300k → 50000、1M → 100000。
 */
export function deriveRetainTokens(modelContextLimit: number): number {
  return interpRetainTokens(modelContextLimit)
}

/** 由窗口推导出的一组完整参数（供日志/遥测/测试直接消费） */
export interface AutoTuneParams {
  /** 输入窗口 */
  window: number
  /** 保护区 token（compression.preserveRecentTokens） */
  retainTokens: number
  /** 折叠触发量（nudge.growthFloor = growthCap = minGrowthFloor） */
  growthFloor: number
  /** 单个折叠范围的最小原文长度（compress.minCompressRange，单位 chars） */
  minCompressRange: number
}

/**
 * 折叠粒度 MC 的安全上限（chars）。超过它 `pendingByTier` 会把合并范围过滤掉、nudge 失效。
 * `retainTokens` 传**最终生效**的保留量（可能被用户显式覆盖），以保证守卫跟得住现场配置。
 */
export function minCompressRangeCeiling(
  modelContextLimit: number,
  retainTokens: number,
): number {
  const region = Math.max(0, modelContextLimit - retainTokens)
  return Math.max(
    AUTO_TUNE_MIN_COMPRESS_FLOOR,
    Math.round(region * AUTO_TUNE_MIN_COMPRESS_REGION_FRACTION),
  )
}

/**
 * 由窗口推导 `{ retainTokens, growthFloor, minCompressRange }`。
 * `MC` 取 `clamp(4R, 8000, 2 × (W − R))`：既保证折叠"成大块"（不碎），又不让它吃到可压缩区。
 */
export function deriveAutoTuneParams(
  modelContextLimit: number,
  effectiveRetainTokens?: number,
): AutoTuneParams {
  const retainTokens = deriveRetainTokens(modelContextLimit)
  const w =
    Number.isFinite(modelContextLimit) && modelContextLimit > 0
      ? modelContextLimit
      : AUTO_TUNE_ANCHOR_WINDOW
  const mcRaw = retainTokens * AUTO_TUNE_MIN_COMPRESS_FACTOR
  const ceiling = minCompressRangeCeiling(w, effectiveRetainTokens ?? retainTokens)
  return {
    window: modelContextLimit,
    retainTokens,
    growthFloor: round500(retainTokens * AUTO_TUNE_GROWTH_FACTOR),
    minCompressRange: Math.max(
      AUTO_TUNE_MIN_COMPRESS_FLOOR,
      Math.min(mcRaw, ceiling),
    ),
  }
}

/** 自动适配模式下固定的非缩放参数（均为 bench 实测所用的取值） */
export const AUTO_TUNE_FIXED = {
  /** 折叠节奏即 growthFloor（置 0 抵消 kernel 默认的 0.45 × nudgeGrowthTokens） */
  nudge: { growthRatio: 0, minGrowthRatio: 0, maxContextLimitPct: 0.65, minContextLimitPct: 0.35, emergencyThresholdPct: 0.8 },
  tiers: { tier2Trigger: 5, tier3Trigger: 18 },
  promotionThreshold: 10,
  compress: { maxSummaryLength: 10_000, minSummaryLength: 1_000 },
  preserveRecentMessages: 5,
} as const

/**
 * `Partial<Config>` 的宽松形态：CLI 从 config.json 翻译过来的嵌套对象是"部分字段"，
 * 不能直接标成 kernel 的完整 `NudgeConfig` / `CompressValidationConfig`。
 */
export type LooseAcpConfig = Partial<Omit<Config, 'nudge' | 'compress' | 'tiers'>> & {
  nudge?: Partial<Config['nudge']>
  compress?: Partial<Config['compress']>
  tiers?: Partial<Config['tiers']>
}

/**
 * 把自动推导参数叠加到用户配置上：**自动值打底，用户显式值优先**。
 *
 * 判定"显式"的依据是该键在对象里存在（`!== undefined`）——CLI 只把 config.json 里
 * 真正写了的字段透传进来，因此未写的键会保留自动推导值。
 *
 * @example 只钉住保留量，其余仍自动跟随窗口
 *   applyAutoTune(1_000_000, { preserveRecentTokens: 120_000 })
 */
export function applyAutoTune(
  modelContextLimit: number,
  userConfig: LooseAcpConfig = {},
): LooseAcpConfig {
  const effectiveRetain = userConfig.preserveRecentTokens ?? deriveRetainTokens(modelContextLimit)
  const p = deriveAutoTuneParams(modelContextLimit, effectiveRetain)
  const uNudge = userConfig.nudge ?? {}
  const uCompress = userConfig.compress ?? {}
  const uTiers = userConfig.tiers ?? {}
  // 生效的折叠块大小（GF）：显式写了 nudge 三键中任意一键就跟随它，否则用窗口推导值。
  // 三键同源的理由见下方 nudge 组装处的注释。
  const effectiveGrowthFloor =
    uNudge.growthFloor ?? uNudge.growthCap ?? uNudge.minGrowthFloor ?? p.growthFloor
  return {
    ...userConfig,
    preserveRecentTokens: userConfig.preserveRecentTokens ?? p.retainTokens,
    preserveRecentMessages:
      userConfig.preserveRecentMessages ?? AUTO_TUNE_FIXED.preserveRecentMessages,
    promotionThreshold:
      userConfig.promotionThreshold ?? AUTO_TUNE_FIXED.promotionThreshold,
    tiers: { ...AUTO_TUNE_FIXED.tiers, ...uTiers },
    compress: { ...AUTO_TUNE_FIXED.compress, ...uCompress, minCompressRange: uCompress.minCompressRange ?? p.minCompressRange },
    nudge: {
      ...AUTO_TUNE_FIXED.nudge,
      ...uNudge,
      // 三键最后写入并**同源联动**：内核取 `nudgeGrowthTokens = min(growthCap, max(growthFloor, …))`、
      // `cadenceFloor = max(minGrowthFloor, …)`，三键本就是这个模式里的同一个概念（GF）。
      // 若只显式写其中一键而不联动，未写的两键仍是窗口推导值，会出现
      // `growthFloor > growthCap` ⇒ 用户显式写的 floor 被 cap **静默截断**
      // （例：窗口 300k 推导 GF=75000，只写 `nudge.growthFloor: 90000` ⇒ 实际增长仍按 75000）。
      // 故：显式写了任一键，未显式写的两键跟随它；一个都没写时才取窗口推导值。
      //   · 只写 floor=90000 → 90000/90000/90000（原先退化为 90000/75000/75000）
      //   · 只写 cap=10000   → 10000/10000/10000（用户想压节奏，floor 跟着降而不是被截断）
      //   · 三键都写         → 原样采用（若 floor > cap 属配置矛盾，内核以 cap 为准，见文档）
      growthFloor: uNudge.growthFloor ?? effectiveGrowthFloor,
      growthCap: uNudge.growthCap ?? effectiveGrowthFloor,
      minGrowthFloor: uNudge.minGrowthFloor ?? effectiveGrowthFloor,
    },
  }
}

/** 生成一行人类可读的推导摘要（用于插件加载日志 / `harness config` 展示） */
export function describeAutoTune(modelContextLimit: number): string {
  const p = deriveAutoTuneParams(modelContextLimit)
  const foldRatio = Math.round(p.minCompressRange / AUTO_TUNE_FIXED.compress.maxSummaryLength)
  return (
    `auto-tune 窗口 ${p.window} → preserveRecentTokens=${p.retainTokens}` +
    ` / growthFloor=growthCap=minGrowthFloor=${p.growthFloor}` +
    ` / minCompressRange=${p.minCompressRange}(chars，单次折叠压缩比≈${foldRatio}:1)`
  )
}
