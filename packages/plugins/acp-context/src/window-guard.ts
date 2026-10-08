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
  /**
   * 判据是否计入**固定前缀**（system prompt + 工具 schema）的实测规模。默认 `true`。
   *
   * 为什么需要：本闸的占用率原本只算**消息体**（ACP 折叠后 `requestTok / window`），
   * 而真正发出去的请求还包含 system prompt 与全部工具 schema —— 那部分**不随会话增长，
   * 却实占窗口**。真机实测（本机 32 个工具）：固定前缀约 **9,600 tokens**，在 30 万窗口上
   * 让四档全部偏晚约 3.2%（`onExceedPct: 0.98` 的硬线实际在**超窗之后**才到）；
   * 窗口越小越致命 —— 3.2 万窗口下偏差是 30 个百分点，`notify` 0.75 档触发时真实请求已超窗。
   *
   * 数字来自**实测而非配置**（见 ACP 的 `AcpSessionCtx.fixedPrefix`）：拿引擎累计的
   * `usageStats.inputTokens` 与 ACP 自己估算的消息体相减，自动适配任何模型 / 工具集，
   * 不需要把"32 个工具 ≈ 9600"这类值写死。拿不到实测值时按 0 处理 ⇒ 逐位回到老口径。
   *
   * 关掉即回到"只算消息体"（统计面板的「实际发出」一行**也随之**不再追加固定前缀段 ——
   * 面板与判据刻意同源，否则会出现"面板显示合计、闸门按消息体判"的第三种口径）。
   */
  includeFixedOverhead?: boolean
}

/** 归一化后的生效值（所有字段必有值） */
export interface ResolvedWindowGuard {
  enabled: boolean
  notifyPct: number
  forceCompressPct: number
  onExceedPct: number
  onExceed: 'truncate' | 'refuse'
  includeFixedOverhead: boolean
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
  includeFixedOverhead: true,
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
    includeFixedOverhead:
      typeof raw.includeFixedOverhead === 'boolean'
        ? raw.includeFixedOverhead
        : WINDOW_GUARD_DEFAULTS.includeFixedOverhead,
  }
}

/** 本轮的处置档位 */
export type WindowGuardAction = 'none' | 'notify' | 'forceCompress' | 'refuse'

/**
 * `forceCompress` 档**折不动**的三种成因 —— 三种的处境与出路都不同，混成一句
 * 「没有够格的可折叠内容」时，前两种会被误读成"门槛没到、再等等就好"。
 *
 * - `no-ranges`：内核压根没推荐范围 ⇒ 本会话**没有未压缩原文**（都在块里了）。
 *   等下去也不会变好，只能换手段（`/compact` 真删消息 / `decompress` 腾空）。
 * - `no-summary`：有范围但取不回原文（归档缺失）⇒ 摘要生成不了。归档链坏了，同样等不动。
 * - `below-threshold`：有范围、有原文，只是**合计字符数**没到内核 `minCompressRange`。
 *   唯一"再涨涨就会出现"的一档。
 */
export type WindowGuardFoldSkipReason = 'no-ranges' | 'no-summary' | 'below-threshold'

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

/**
 * 组装占位数字段：`窗口 300,000 · 实际发出 234,000（78.0%）`
 *
 * `fixed > 0` 时把固定前缀（system + 工具 schema）单列出来 —— 它是「实际发出」的一部分，
 * 不标出来就会与占位率对不上（判据含它、读数不含它 = 两套口径）。
 */
function usagePart(window: number, used: number, fixed = 0): string {
  const total = used + fixed
  const base = `窗口 ${num(window)} · 实际发出 ${num(total)}（${pct(window > 0 ? total / window : 0)}）`
  return fixed > 0 ? `${base}〔含固定前缀 ${num(fixed)}〕` : base
}

/**
 * `notify` 档文案：只告警、不改请求。
 *
 * 措辞刻意带上"下一档在哪"（强制折叠线）—— 只报一个孤立百分比，读的人无从判断
 * 是"刚过线"还是"马上要被动手"。
 */
export function formatWindowGuardNotice(input: {
  /**
   * **触发时刻**的占用率 —— `forceCompress` 档是**折叠前**的值。
   *
   * 必须与 {@link occupancyAfter} 分开：折叠会立刻改写请求体，调用点若只留一个
   * 变量，折叠后的值会覆盖掉触发时的值，文案就写成「占用 12.0% 已达强制折叠线
   * 90.0%」这种自证矛盾的句子（真机实测踩过）。
   */
  occupancy: number
  /**
   * `forceCompress` 档**折叠后**重算的占用率（缺省 = 本轮没折叠）。
   * 与 {@link occupancy} 一起才构成「折叠前 X% → 折叠后 Y%」的完整读数。
   */
  occupancyAfter?: number
  window: number
  used: number
  /**
   * 固定前缀（system prompt + 工具 schema）的**实测** tokens，计入「实际发出」总量。
   * 缺省 0 = 不含（老口径，读数与告警都只算消息体）。
   */
  fixed?: number
  guard: ResolvedWindowGuard
  /** forceCompress 档：实际折掉的结果（缺省表示"这个动作没触发"） */
  folded?: { blocks: number; tokens: number }
  /**
   * forceCompress 档但**没折成** —— 必须说明成因（三种处境不同，见
   * {@link WindowGuardFoldSkipReason}）。此时只剩内核截断兜底。
   */
  foldSkipReason?: WindowGuardFoldSkipReason
}): string {
  const at = usagePart(input.window, input.used, input.fixed ?? 0)
  if (input.folded) {
    const after = input.occupancyAfter !== undefined ? `· 折叠后 ${pct(input.occupancyAfter)} ` : ''
    return (
      `ACP 窗口保护：占用 ${pct(input.occupancy)} 已达强制折叠线 ${pct(input.guard.forceCompressPct)} → 已强制折叠`
      + `（折 ${input.folded.blocks} 段 / 回收约 ${num(input.folded.tokens)} tokens；`
      + `原文可用 decompress 还原）${after}· ${at}`
    )
  }
  if (input.foldSkipReason) {
    return (
      `ACP 窗口保护：占用 ${pct(input.occupancy)} 已达强制折叠线 ${pct(input.guard.forceCompressPct)}，`
      + `但${describeFoldSkip(input.foldSkipReason)} ⇒ 本轮未折叠，超出部分由内核 truncate 兜底 · ${at}\n`
      + FOLD_SKIP_EXITS
    )
  }
  return (
    `ACP 窗口保护：占用 ${pct(input.occupancy)} 超过告警线 ${pct(input.guard.notifyPct)}`
    + `（强制折叠线 ${pct(input.guard.forceCompressPct)}）· ${at}`
  )
}

/** 三种"折不动"的成因，各自一句人话（措辞要能指向出路，不是复述 code） */
function describeFoldSkip(reason: WindowGuardFoldSkipReason): string {
  switch (reason) {
    case 'no-ranges':
      return '本会话已没有未压缩的原文可折（历史都已在折叠块里）'
    case 'no-summary':
      return '候选范围的原文取不回来（归档缺失），生成不了块摘要'
    case 'below-threshold':
      return '可折内容合计未达内核 minCompressRange 门槛'
  }
}

/**
 * 「折不动」时的出路。**必须自带出路**：只说"我没动手"，不说"接下来会怎样、你能做什么"，
 * 就只是把静默损坏换成了静默报错 —— 与本模块 `refuse` 档文案同一条纪律。
 *
 * 前两条出路针对"没有可折内容"（等下去也不会变好），第三条针对"门槛没到 / 窗口配小了"。
 */
const FOLD_SKIP_EXITS =
  '可选出路：① 执行 /compact（真删消息，直接降原文口径与磁盘）；'
  + '② 用 decompress 取回并清理不再需要的折叠块，腾出可折空间；'
  + '③ 调大 compression.modelContextLimit（若窗口配小导致占用虚高）。'

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
  /** 固定前缀（system + 工具 schema）实测 tokens；与告警档同一口径 */
  fixed?: number
  guard: ResolvedWindowGuard
}): string {
  const at = usagePart(input.window, input.used, input.fixed ?? 0)
  return (
    `ACP 窗口保护（refuse）：本轮请求占用 ${pct(input.occupancy)} 已达硬线 ${pct(input.guard.onExceedPct)}，`
    + `已中止本轮、未向模型发起请求 · ${at}\n`
    + '可选出路：① 先执行 /compact（或 /compact auto）压缩会话历史；'
    + '② 用 decompress 取回并清理不需要的折叠块；'
    + '③ 把 compression.windowGuard.onExceed 设为 "truncate" 改回内核静默截断兜底；'
    + '④ 调大 compression.modelContextLimit（若窗口配小了）。'
  )
}
