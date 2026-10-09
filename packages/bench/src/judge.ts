/**
 * τ³-bench judge —— 环境数据库终态校验（官方 evaluator_env.py 的 TS 等价实现）
 *
 * 原理与官方一致：
 * 1. gold 环境：初始 DB + 回放 task.evaluation_criteria.actions（golden actions）
 * 2. predicted 环境：初始 DB + 回放 agent 会话轨迹中的工具调用（只重放 mutates_state 工具，
 *    与官方 set_state 的 mutates_state 语义一致；isError 调用跳过 —— 工具实现「先检查后
 *    修改」，报错时 DB 未变，等价于官方重放报错仅告警跳过）
 * 3. deepEqual(gold, predicted) ⇒ DB 终态匹配 ⇒ reward_basis 含 DB 时计入 reward
 *
 * M1 范围：DB 校验（retail 任务 reward_basis = ['DB','NL_ASSERTION'] 的 DB 维度）。
 * NL_ASSERTION / COMMUNICATE_INFO（LLM judge）留接口，后续按 telemetry 同款
 * 「零内容 + 摘要哈希」约束接入。
 */
import { executeRetailTool, MUTATES_STATE_TOOLS } from './retail/tools'
import { loadRetailDb } from './data'
import type { RewardBasis, TauTask, ToolInvocation } from './types'

export interface JudgeResult {
  /** DB 终态是否与 gold 一致 */
  dbMatch: boolean
  /** 综合 reward（M1 = DB 维度；0 或 1） */
  reward: number
  rewardBasis: RewardBasis[]
  /** DB 首个差异位置（dbMatch=false 时，调试用） */
  dbDiffPath?: string
  /** M1 未实现的 judge 维度（NL_ASSERTION / COMMUNICATE_INFO 等） */
  skippedBasis: RewardBasis[]
}

/**
 * 结构化深比较：键序无关、undefined 与缺失字段视为相等、数字精确比较
 * （gold 与 predicted 走同一份工具实现，浮点路径一致，无需容差）。
 * 返回首个差异路径（null 表示相等）。
 */
export function deepEqualWithDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b ? null : path
  }
  if (typeof a !== typeof b) return path
  if (typeof a !== 'object') {
    // Number.NaN !== Number.NaN；-0 与 0 视为相等（金额不产生 -0）
    if (Number.isNaN(a as number) && Number.isNaN(b as number)) return null
    return path
  }
  if (Array.isArray(a) !== Array.isArray(b)) return path
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length(${a.length} vs ${b.length})`
    for (let i = 0; i < a.length; i++) {
      const d = deepEqualWithDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = new Set(Object.keys(objA).filter((k) => objA[k] !== undefined))
  const keysB = new Set(Object.keys(objB).filter((k) => objB[k] !== undefined))
  if (keysA.size !== keysB.size) {
    const onlyA = [...keysA].filter((k) => !keysB.has(k))
    const onlyB = [...keysB].filter((k) => !keysA.has(k))
    return `${path}.keys(${onlyA.length ? `仅gold有:${onlyA.join(',')}` : ''}${onlyB.length ? `仅pred有:${onlyB.join(',')}` : ''})`
  }
  for (const k of keysA) {
    const d = deepEqualWithDiff(objA[k], objB[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}

/** 回放 golden actions / 轨迹到指定 DB（失败调用静默跳过，与官方 make_tool_call 容错一致） */
async function replay(db: Parameters<typeof executeRetailTool>[0], invocations: ToolInvocation[], onlyMutating: boolean): Promise<void> {
  for (const inv of invocations) {
    if (inv.isError) continue
    if (onlyMutating && !MUTATES_STATE_TOOLS.has(inv.toolId)) continue
    await executeRetailTool(db, inv.toolId, inv.input)
  }
}

/** 单任务 judge：gold 回放 vs 轨迹回放 → DB 终态 deepEqual */
export async function judgeTask(task: TauTask, trajectory: ToolInvocation[]): Promise<JudgeResult> {
  const criteria = task.evaluation_criteria
  const rewardBasis: RewardBasis[] = (criteria?.reward_basis as RewardBasis[]) ?? []
  const skippedBasis: RewardBasis[] = []

  const goldDb = loadRetailDb()
  const goldInvocations: ToolInvocation[] = (criteria?.actions ?? []).map((a) => ({
    toolId: a.name,
    input: a.arguments,
    isError: false,
  }))
  await replay(goldDb, goldInvocations, false)

  const predictedDb = loadRetailDb()
  await replay(predictedDb, trajectory, true)

  const dbDiffPath = deepEqualWithDiff(goldDb, predictedDb)
  const dbMatch = dbDiffPath === null

  let reward = 1
  for (const basis of rewardBasis) {
    if (basis === 'DB') {
      if (!dbMatch) reward = 0
    } else {
      // NL_ASSERTION / COMMUNICATE_INFO / ENV_ASSERTION：M1 未实现，不计入（既不惩罚也不奖励）
      skippedBasis.push(basis)
    }
  }
  // 无 reward_basis 的任务视为 DB 校验
  if (rewardBasis.length === 0 && !dbMatch) reward = 0

  return { dbMatch, reward, rewardBasis, dbDiffPath: dbDiffPath ?? undefined, skippedBasis }
}
