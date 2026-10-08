/**
 * 窗口保护闸（B3）—— 把「请求别超模型窗口」这件事从 `compactIfNeeded` 手里接过来。
 *
 * ## 为什么需要它
 *
 * 本仓有两条"省上下文"管线，各有各的尺子：
 *
 * | | ACP 模型侧压缩 | 会话压缩 `compactIfNeeded` |
 * |---|---|---|
 * | 判据 | `requestTok / window`（**折叠后**） | `estimateTokens(sess.messages)`（**原文口径**） |
 * | 对 `sess.messages` | 不删（只记块引用） | **真删** |
 * | 触发点 | 每轮 `core.session.preModel` | resume / start、`/compact auto` |
 *
 * ACP 把 `requestTok` 压得很低而 `rawTok` 继续单调增长 ⇒ 原文口径先撞线：
 * 真机会话 `s_1791373374635_9hqyb` 里原文口径 **79.6%** 撞线时真实请求只有 **31.5%** ——
 * 即在模型端还很宽裕时就触发了裁剪。两把尺子各守一个目标（前者守语义、后者守内存），
 * 本身没错；错的是**"窗口保护"被寄存在了那道按原文口径判的闸上** —— 只要 ACP 启用
 * （两把尺子分离），窗口保护就事实上缺位。
 *
 * 对称性（本模块必要性的证明）：**ACP 关闭 ⇒ `requestTok ≈ rawTok` ⇒ 原文口径的
 * autoCompact 恰好等价于窗口闸。** 若本模块无意义，则 ACP 关闭时的行为会显得荒谬。
 *
 * ## 与内核既有兜底的关系
 *
 * 内核 `acp-kernel` 已有三层窗口保护，但**都不可见**，且最重要的是兜底形态选错了：
 *
 * | 档 | 配置键 | 动作 | 可见性 |
 * |---|---|---|---|
 * | `overLimit` | `nudge.maxContextLimitPct` | nudge 注入压缩建议 | 只有模型 |
 * | `emergencyOverride` | `nudge.emergencyThresholdPct` | 同上（文案换 EMERGENCY） | 只有模型 |
 * | `truncate` | `config.truncate.threshold`（默认 0.95） | **静默取头尾切中段**工具输出 | 谁都不知道 |
 *
 * 到 95% 直接切工具输出，而"再折一次"（有归档、可 `decompress` 还原）这条更干净的路径
 * 根本没有机会。本模块的核心决定就是**把非破坏的折叠排在破坏性的截断之前**。
 *
 * ## 四档（逐级升级）
 *
 * | 档 | 阈值（本模块） | 动作 | 破坏性 |
 * |---|---|---|---|
 * | `notify` | `notifyPct`（默认 0.75） | 宿主可见告警一行，**不改请求** | 无 |
 * | `forceCompress` | `forceCompressPct`（默认 0.90） | 复用内核能力折一次 | 非破坏（有归档） |
 * | 内核兜底 | 内核 `truncate.threshold`（0.95） | 静默截断 | 有损（仅本轮副本） |
 * | `refuse` | `onExceedPct` + `onExceed: 'refuse'` | 抛错中止本轮，**不发请求** | 不发请求 |
 *
 * 本文件只放**纯决策与纯文案**：不含 IO、不依赖内核、不依赖 `./index.js`
 * （避免与 index 形成循环导入）。折叠动作本身留在 `runPreModel`（那里才有 engine /
 * state / archive），从而**不产生第二份折叠实现**。
 */

/** 用户可写的 `compression.windowGuard` 段（全部可选，省略即取默认） */
export interface WindowGuardConfig {
  /** 总开关。false = 本闸完全退场（此时窗口保护只剩内核那三层，即改造前行为） */
  enabled?: boolean
  /** 告警线（占用率，0~1）。默认 0.75 */
  notifyPct?: number
  /** 强制折叠线（占用率，0~1）。默认 0.90 */
  forceCompressPct?: number
  /** 硬线（占用率，0~1）。默认 0.98；`onExceed` 决定到线后做什么 */
  onExceedPct?: number
  /**
   * 到 `onExceedPct` 后做什么：
   * - `'truncate'`（默认）：**不额外动作**，交还给内核既有的静默截断（改造前行为）
   * - `'refuse'`：从 `preModel` 抛错中止本轮（不发请求）
   */
  onExceed?: 'truncate' | 'refuse'
}

/** 归一化后的生效值（所有字段必有值） */
export interface ResolvedWindowGuard {
  enabled: boolean
  notifyPct: number
  forceCompressPct: number
  onExceedPct: number
  onExceed: 'truncate' | 'refuse'
}

/**
 * 默认值。**刻意不进 `autoTune`**：autoTune 按窗口推导 nudge / compress 参数，
 * 但硬闸不该被自动调 —— 自动调会把安全线的含义弄模糊（"这条线到底在哪"取决于窗口推导逻辑，
 * 排查时无从下手）。
 */
export const WINDOW_GUARD_DEFAULTS: ResolvedWindowGuard = {
  enabled: true,
  notifyPct: 0.75,
  forceCompressPct: 0.9,
  onExceedPct: 0.98,
  onExceed: 'truncate',
}

/** 占用率阈值必须是 (0, 1] 内的有限数 —— 0 会让那一档恒真、>1 会让它恒假，都属非法 */
function usablePct(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback
}

/**
 * 归一化用户配置：缺省取默认、非法取值回落默认（**不抛错**）。
 *
 * 为什么不抛错：本闸是旁路保护，一个拼错的百分比不该让整个会话起不来。
 * 配置问题由宿主侧 `checkCompressionConfig` 产出一条**指名到键**的告警
 * （见 `@harness/host` 的 config.ts），与 `tokenCalibration` / `manualInjection` 同纪律。
 */
export function resolveWindowGuard(raw?: WindowGuardConfig): ResolvedWindowGuard {
  if (!raw) return { ...WINDOW_GUARD_DEFAULTS }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : WINDOW_GUARD_DEFAULTS.enabled,
    notifyPct: usablePct(raw.notifyPct, WINDOW_GUARD_DEFAULTS.notifyPct),
    forceCompressPct: usablePct(raw.forceCompressPct, WINDOW_GUARD_DEFAULTS.forceCompressPct),
    onExceedPct: usablePct(raw.onExceedPct, WINDOW_GUARD_DEFAULTS.onExceedPct),
    onExceed: raw.onExceed === 'refuse' ? 'refuse' : 'truncate',
  }
}

/** 本轮的处置档位 */
export type WindowGuardAction = 'none' | 'notify' | 'forceCompress' | 'refuse'

/**
 * 按占用率决定本级动作（纯函数）。
 *
 * 判定顺序即**严重度顺序**（refuse > forceCompress > notify > none），与阈值大小无关 ——
 * 这样即使配置把三档写成不单调（如 `notifyPct: 0.95` > `forceCompressPct: 0.9`），
 * 也只会得到"告警档不可达"这种良性退化，而不会出现"已过强制折叠线却只告警"。
 *
 * `refuse` 只在显式配了 `onExceed: 'refuse'` 时参与判定；默认 `'truncate'` 表示
 * 到硬线后**不额外动作**，交还内核既有的静默截断（改造前行为），
 * 所以此时高占用仍然返回 `forceCompress`（让"再折一次"先于"切工具输出"）。
 */
export function decideWindowGuardAction(input: {
  occupancy: number
  guard: ResolvedWindowGuard
}): WindowGuardAction {
  const { occupancy, guard } = input
  if (!guard.enabled) return 'none'
  if (!Number.isFinite(occupancy) || occupancy <= 0) return 'none'
  if (guard.onExceed === 'refuse' && occupancy >= guard.onExceedPct) return 'refuse'
  if (occupancy >= guard.forceCompressPct) return 'forceCompress'
  if (occupancy >= guard.notifyPct) return 'notify'
  return 'none'
}

/** 命中硬线且配置为 `refuse` 时抛出的错误 —— 调用方须**不吞**它，否则退化为静默失败 */
export class WindowGuardExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WindowGuardExceededError'
  }
}

/** 百分比展示：保留一位小数（0.7823 → "78.2%"） */
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

/** 千分位展示（便于与统计面板的数字对齐阅读） */
function num(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}

/** 组装占位数字段：`窗口 300,000 · 实际发出 234,000（78.0%）` */
function usagePart(window: number, used: number): string {
  return `窗口 ${num(window)} · 实际发出 ${num(used)}（${pct(window > 0 ? used / window : 0)}）`
}

/**
 * `notify` 档文案：只告警、不改请求。
 *
 * 措辞刻意带上"下一档在哪"（强制折叠线）—— 只报一个孤立百分比，读的人无从判断
 * 是"刚过线"还是"马上要被动手"。
 */
export function formatWindowGuardNotice(input: {
  occupancy: number
  window: number
  used: number
  guard: ResolvedWindowGuard
  /** forceCompress 档：实际折掉的结果（缺省表示"这个动作没触发"） */
  folded?: { blocks: number; tokens: number }
  /** forceCompress 档但**没有可折内容**（此时只剩内核截断兜底） */
  foldSkipped?: boolean
}): string {
  const at = usagePart(input.window, input.used)
  if (input.folded) {
    return (
      `ACP 窗口保护：占用 ${pct(input.guard.forceCompressPct)} → 已强制折叠`
      + `（折 ${input.folded.blocks} 段 / 回收约 ${num(input.folded.tokens)} tokens；`
      + `原文可用 decompress 还原）· 折叠前 ${pct(input.occupancy)} · ${at}`
    )
  }
  if (input.foldSkipped) {
    return (
      `ACP 窗口保护：占用 ${pct(input.occupancy)} 已达强制折叠线 ${pct(input.guard.forceCompressPct)}，`
      + `但当前没有够格的可折叠内容（内核 minCompressRange 门槛未达）⇒ 本轮未折叠，`
      + `超出部分由内核 ${'truncate'} 兜底 · ${at}`
    )
  }
  return (
    `ACP 窗口保护：占用 ${pct(input.occupancy)} 超过告警线 ${pct(input.guard.notifyPct)}`
    + `（强制折叠线 ${pct(input.guard.forceCompressPct)}）· ${at}`
  )
}

/**
 * `refuse` 档文案。
 *
 * **必须自带出路**：抛错本身不解决问题，只把"静默损坏"换成"静默报错"。
 * 所以要写清"发生了什么 / 可以怎么办"。
 */
export function formatWindowGuardRefusal(input: {
  occupancy: number
  window: number
  used: number
  guard: ResolvedWindowGuard
}): string {
  const at = usagePart(input.window, input.used)
  return (
    `ACP 窗口保护（refuse）：本轮请求占用 ${pct(input.occupancy)} 已达硬线 ${pct(input.guard.onExceedPct)}，`
    + `已中止本轮、未向模型发起请求 · ${at}\n`
    + '可选出路：① 先执行 /compact（或 /compact auto）压缩会话历史；'
    + '② 用 decompress 取回并清理不需要的折叠块；'
    + '③ 把 compression.windowGuard.onExceed 设为 "truncate" 改回内核静默截断兜底；'
    + '④ 调大 compression.modelContextLimit（若窗口配小了）。'
  )
}
