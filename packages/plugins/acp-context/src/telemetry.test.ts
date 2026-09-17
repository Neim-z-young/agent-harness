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
import { buildPreModelEvent } from './telemetry'
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
