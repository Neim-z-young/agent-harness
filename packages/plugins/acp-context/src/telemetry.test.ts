/**
 * telemetry token 口径单测。
 *
 * 断言点：`buildPreModelEvent` 的 `rawTok` / `requestTok` / `occupancy` 必须跟随调用方
 * 传入的 `countTokens`——即与 `createCore({ countTokens })`、`acp_status` 用**同一把尺子**。
 *
 * 回归背景：曾漏传该参数（沿用函数默认值），于是配置 `tokenCalibration: 'chars4'` 时
 * 遥测按 CJK 口径记账、内核决策与 status 按 chars4 记账，导出报告与决策行为对不上，
 * 事后无法用遥测复盘"参数 × 指标"的关系。
 */
import { test, expect } from 'bun:test'
import { createInitialState, defaultConfig, type CoreMessage } from 'acp-kernel'
import { buildPreModelEvent, buildProviderCacheEvent, diffPromptPrefix } from './telemetry'
import { chars4CountTokens, cjkAwareCountTokens, estimateTokens } from './adapter'

const ZH = '压'.repeat(4000) // 4000 个汉字：CJK 口径 4000 token，chars4 口径 1000 token

function coresOf(): CoreMessage[] {
  return [{ id: 'm1', role: 'user', contentType: 'text', text: ZH }]
}

function eventOf(countTokens?: typeof cjkAwareCountTokens) {
  const cores = coresOf()
  return buildPreModelEvent({
    sessionId: 's',
    round: 1,
    config: defaultConfig(200_000),
    state: createInitialState(),
    prevRequestCores: undefined,
    inflatCores: cores,
    requestCores: cores,
    nudge: undefined,
    countTokens,
  })
}

test('buildPreModelEvent：缺省 countTokens 时按内核 CJK 口径记账（与 estimateTokens 默认一致）', () => {
  const ev = eventOf(undefined)
  expect(ev.rawTok).toBe(4_000) // 汉字 1 token/字，而非 chars/4 的 1000
  expect(ev.rawTok).toBe(estimateTokens(coresOf()))
  expect(ev.occupancy).toBeCloseTo(4_000 / 200_000, 9)
})

test('buildPreModelEvent：显式传 chars4 时遥测跟随该口径（与内核/status 不分裂）', () => {
  const ev = eventOf(chars4CountTokens)
  expect(ev.rawTok).toBe(1_000) // ceil(4000 / 4)
  expect(ev.requestTok).toBe(1_000)
  expect(ev.occupancy).toBeCloseTo(1_000 / 200_000, 9)
  // 占比类指标不受口径影响（分子分母同口径）
  expect(ev.compressRatio).toBe(1)
  expect(ev.retention).toBe(1)
})

test('buildPreModelEvent：中文场景两档口径的占用率差约 4 倍（口径分叉的观测量）', () => {
  const auto = eventOf(cjkAwareCountTokens)
  const legacy = eventOf(chars4CountTokens)
  expect(auto.rawTok).toBeGreaterThan(legacy.rawTok * 3)
  expect(auto.occupancy! / legacy.occupancy!).toBeGreaterThan(3)
})

// ==========================================================================
// 前缀缓存回退归因（回答「这轮缓存为什么掉」）
//
// 回归背景：会话 `s_1789996799007_9cq9r` 出现两处 cacheRead 断崖（−12.9K / −46.7K），
// 但当时的遥测只有 cacheRead 一个数字，无法区分「我们自己把前缀改坏了」与
// 「provider 侧缓存过期/被逐出」。更糟的是既有的 `commonPrefixHit` **只比 message id**，
// 同 id 消息内容被就地改写时它仍报高命中率 —— 误导性的绿灯。
// ==========================================================================

const msg = (role: string, text: string) => ({ role, text })

test('diffPromptPrefix：尾部追加 ⇒ appended，前缀未动（不该归因到前缀）', () => {
  const prev = [msg('system', 'S'), msg('user', 'A')]
  const curr = [msg('system', 'S'), msg('user', 'A'), msg('assistant', 'B')]
  const d = diffPromptPrefix(prev, curr)!
  expect(d.changedKind).toBe('appended')
  expect(d.stableMessages).toBe(2)
  expect(d.changedAt).toBeNull()
  expect(d.systemChanged).toBe(false)
})

test('diffPromptPrefix：同 id 但内容被就地改写 —— id 比对测不出，指纹能测出（mutated）', () => {
  // 这正是 commonPrefixHit 的盲区：两条消息 id 完全相同（甚至没有 id 概念），
  // 但正文变了。provider 缓存按字节命中，所以这里是真失效。
  const prev = [msg('user', '正文 A'), msg('user', 'B')]
  const curr = [msg('user', '正文 A 被改写'), msg('user', 'B')]
  const d = diffPromptPrefix(prev, curr)!
  expect(d.changedKind).toBe('mutated')
  expect(d.stableMessages).toBe(0)
  expect(d.changedAt).toBe(0)
  expect(d.changedAtRole).toBe('user')
})

test('diffPromptPrefix：系统区被改写 ⇒ systemChanged（其后整段历史重算，最贵）', () => {
  const prev = [msg('system', '工具清单 v1'), msg('system', 'HINT'), msg('user', 'A')]
  const curr = [msg('system', '工具清单 v2'), msg('system', 'HINT'), msg('user', 'A')]
  const d = diffPromptPrefix(prev, curr)!
  expect(d.systemChanged).toBe(true)
  expect(d.changedAt).toBe(0)
  expect(d.changedAtRole).toBe('system')
})

test('diffPromptPrefix：只有尾条被改写 ⇒ tail-rewritten（廉价，不当中段失效）', () => {
  const prev = [msg('system', 'S'), msg('user', 'A'), msg('user', 'nudge: 1 段可压')]
  const curr = [msg('system', 'S'), msg('user', 'A'), msg('user', 'nudge: 2 段可压')]
  const d = diffPromptPrefix(prev, curr)!
  expect(d.changedKind).toBe('tail-rewritten')
  expect(d.systemChanged).toBe(false)
})

test('diffPromptPrefix：prompt 变短 ⇒ shrunk（删尾条）', () => {
  const prev = [msg('system', 'S'), msg('user', 'A'), msg('user', 'B')]
  const curr = [msg('system', 'S'), msg('user', 'A')]
  const d = diffPromptPrefix(prev, curr)!
  expect(d.changedKind).toBe('shrunk')
})

test('diffPromptPrefix：删的是**中段**也报 shrunk（不能报成"内容被改写"）', () => {
  // 压缩/截断 pruned 掉的是旧消息 ⇒ 删的通常在中段。若按"首处分歧"单看会得到 mutated，
  // 那会把真正的原因（少了东西）盖掉。changedAt 仍指向分歧点，定位信息不丢。
  const prev = [msg('system', 'S'), msg('user', 'A'), msg('user', 'B'), msg('user', 'C')]
  const curr = [msg('system', 'S'), msg('user', 'B'), msg('user', 'C')]
  const d = diffPromptPrefix(prev, curr)!
  expect(d.changedKind).toBe('shrunk')
  expect(d.changedAt).toBe(1)
  expect(d.stableMessages).toBe(1)
})

test('diffPromptPrefix：首轮（无上轮）返回 null', () => {
  expect(diffPromptPrefix(undefined, [msg('user', 'A')])).toBeNull()
  expect(diffPromptPrefix([], [msg('user', 'A')])).toBeNull()
})

test('providerCache 归因：首轮 / 未下降 / 系统区改写 / 中段改写 / 前缀完好但掉量', () => {
  const base = { sessionId: 's', round: 1, cacheWrite: 0, requestTok: 1000 }

  // 首轮
  expect(buildProviderCacheEvent({ ...base, cacheRead: 0 })!.cacheMissReason).toBe('first-request')

  // 未下降
  const noDrop = buildProviderCacheEvent({
    ...base, cacheRead: 900, prev: { ts: Date.now() - 1000, cacheRead: 800 },
  })!
  expect(noDrop.cacheMissReason).toBe('none')
  expect(noDrop.cacheDropTokens).toBe(0)

  // 系统区改写（最贵）
  const sys = buildProviderCacheEvent({
    ...base, cacheRead: 100,
    prev: { ts: Date.now() - 5000, cacheRead: 5000 },
    prefix: diffPromptPrefix([msg('system', 'v1')], [msg('system', 'v2')]),
  })!
  expect(sys.cacheMissReason).toBe('system-changed')
  expect(sys.cacheDropTokens).toBe(4900)
  expect(sys.idleMs).toBeGreaterThanOrEqual(0)

  // 中段改写
  const mut = buildProviderCacheEvent({
    ...base, cacheRead: 100,
    prev: { ts: Date.now(), cacheRead: 5000 },
    prefix: diffPromptPrefix([msg('user', 'a'), msg('user', 'b')], [msg('user', 'a!'), msg('user', 'b')]),
  })!
  expect(mut.cacheMissReason).toBe('prefix-mutated')

  // 前缀完好（append）但仍然掉量 ⇒ 只能是 provider 侧过期/逐出，靠 idleMs 佐证
  const idle = buildProviderCacheEvent({
    ...base, cacheRead: 100,
    prev: { ts: Date.now() - 400_000, cacheRead: 5000 },
    prefix: diffPromptPrefix([msg('user', 'a')], [msg('user', 'a'), msg('user', 'b')]),
  })!
  expect(idle.cacheMissReason).toBe('idle-expiry')
  expect(idle.idleMs).toBeGreaterThan(300_000)
})

test('providerCache 归因：系统区变化时点名到**段**（引擎侧归因透传）', () => {
  // 动机：system 区位于请求位置 0，它一变其后整段历史都要重算。而 system 区是多个插件
  // 往同一数组 push 拼的 —— 遥测只说 "system-changed" 等于没说，得能指认"第 N 段"。
  const ev = buildProviderCacheEvent({
    sessionId: 's', round: 3, cacheRead: 100, cacheWrite: 0, requestTok: 1000,
    prev: { ts: Date.now() - 1000, cacheRead: 5000 },
    prefix: diffPromptPrefix([msg('system', 'v1')], [msg('system', 'v2')]),
    systemChangedParts: [1],
    systemChangedDetail: ['第 2 段变化：642 → 1 284 字符（首行：「项目长期记忆」→「项目长期记忆 + 新增」）'],
  })!
  expect(ev.cacheMissReason).toBe('system-changed')
  expect(ev.systemChangedParts).toEqual([1])
  expect(ev.systemChangedDetail![0]).toContain('第 2 段变化')

  // 引擎未给归因（首轮无基线 / 未接线宿主）⇒ 如实记 null，不编造"没变"
  const noAttrib = buildProviderCacheEvent({
    sessionId: 's', round: 1, cacheRead: 0, cacheWrite: 0, requestTok: 10,
  })!
  expect(noAttrib.systemChangedParts).toBeNull()
  expect(noAttrib.systemChangedDetail).toBeNull()
})

test('providerCache：尾部动态块规模如实透传（归因视野看不见它本身）', () => {
  // 动机：core 的尾部动态区拼在**请求最末尾**，ACP 按 messages 建视图时看不到它
  // （拼接发生在 preModel 返回之后）。而它是请求最后一条 —— anthropic 显式 promptCache
  // 断点的落点。不记规模，"前缀没动（none）却仍有 cache write"就成了无解释的读数。
  const ev = buildProviderCacheEvent({
    sessionId: 's', round: 2, cacheRead: 900, cacheWrite: 320, requestTok: 1000,
    prev: { ts: Date.now() - 1000, cacheRead: 900 },
    tailDynamicParts: 2,
    tailDynamicChars: 1500,
  })!
  expect(ev.cacheMissReason).toBe('none') // 前缀确实没动
  expect(ev.cacheWrite).toBe(320)         // 写入却不为 0 ⇒ 解释在下面两行
  expect(ev.tailDynamicParts).toBe(2)
  expect(ev.tailDynamicChars).toBe(1500)

  // 没有尾部动态块（或宿主未接线）⇒ 记 null，不编造 0（0 会被读成"引擎说没有"）
  const plain = buildProviderCacheEvent({
    sessionId: 's', round: 2, cacheRead: 900, cacheWrite: 0, requestTok: 1000,
  })!
  expect(plain.tailDynamicParts).toBeNull()
  expect(plain.tailDynamicChars).toBeNull()
})

test('providerCache 口径：calibration 的分母必须是**整包**估算，不是历史估算', () => {
  // 分母用整包（含 system + 工具）⇒ 1320/1000 = 1.32
  const ev = buildProviderCacheEvent({
    sessionId: 's', round: 1, cacheRead: 800, cacheWrite: 0,
    requestTok: 300, localInputEstimate: 1000, providerInput: 1320,
  })!
  expect(ev.calibration).toBeCloseTo(1.32, 5)
  // 固定开销 = 整包 − 历史 = system + 工具载荷（每轮都要重发的那部分）
  expect(ev.overheadTok).toBe(700)

  // 分母缺失（或为 0）⇒ null，绝不退回用 requestTok 当分母
  // （真机取证：那样量到的是"漏算固定开销"，首轮比值虚高到 415×）
  expect(buildProviderCacheEvent({
    sessionId: 's', round: 1, cacheRead: 1, cacheWrite: 0,
    requestTok: 300, localInputEstimate: 0, providerInput: 10,
  })!.calibration).toBeNull()
  expect(buildProviderCacheEvent({
    sessionId: 's', round: 1, cacheRead: 1, cacheWrite: 0,
    requestTok: 300, providerInput: 10,
  })!.calibration).toBeNull()

  // 无整包估算 ⇒ overheadTok 也为 null（不编造）
  expect(buildProviderCacheEvent({
    sessionId: 's', round: 1, cacheRead: 1, cacheWrite: 0, requestTok: 300,
  })!.overheadTok).toBeNull()
})
