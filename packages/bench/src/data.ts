/**
 * τ³-bench 数据加载（retail 域）
 *
 * 数据文件与官方 sierra-research/tau2-bench `data/tau2/domains/retail/` 保持一致：
 * - tasks.json：114 个任务（含 golden actions / reward_basis）
 * - db.json：环境初始 DB（50 商品 / 500 用户 / 1000 订单）
 * - policy.md：agent 域政策（system prompt 素材）
 * - split_tasks.json：train/test 任务 id 划分
 * - simulation_guidelines.md（上级目录）：user simulator 全局行为准则
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RetailDB, TaskSplit, TaskSplitMap, TauTask } from './types'

const DATA_DIR = join(import.meta.dir, 'data')
const RETAIL_DIR = join(DATA_DIR, 'retail')

// 四个 loader 一律「首次读盘 + 缓存」：此前 db/tasks/split 缓存、policy/guidelines 每次
// 读盘，同一件事两套写法 —— policy 是每建一个 agent 定义读一次、guidelines 是每建一个
// user simulator 读一次，114 任务 × k 采样下是纯浪费。
let dbCache: RetailDB | undefined
let tasksCache: TauTask[] | undefined
let splitCache: TaskSplitMap | undefined
let policyCache: string | undefined
let guidelinesCache: string | undefined

/** 读一次并缓存（统一用 `=== undefined` 判「未加载」，不用 falsy —— 空串/空对象也是合法内容） */

/** retail 环境初始 DB（每次返回独立深拷贝，调用方持有并自行演进） */
export function loadRetailDb(): RetailDB {
  if (!dbCache) dbCache = JSON.parse(readFileSync(join(RETAIL_DIR, 'db.json'), 'utf8')) as RetailDB
  return structuredClone(dbCache)
}

/** 全部 retail 任务 */
export function loadRetailTasks(): TauTask[] {
  if (!tasksCache) {
    tasksCache = JSON.parse(readFileSync(join(RETAIL_DIR, 'tasks.json'), 'utf8')) as TauTask[]
  }
  return tasksCache
}

/** train/test/base 划分（split_tasks.json） */
export function loadRetailSplit(): TaskSplitMap {
  if (splitCache === undefined) {
    splitCache = JSON.parse(readFileSync(join(RETAIL_DIR, 'split_tasks.json'), 'utf8')) as TaskSplitMap
  }
  return splitCache
}

/** retail 域政策（agent system prompt 的 <policy> 段） */
export function loadRetailPolicy(): string {
  if (policyCache === undefined) policyCache = readFileSync(join(RETAIL_DIR, 'policy.md'), 'utf8')
  return policyCache
}

/** user simulator 全局行为准则（官方 data/tau2/user_simulator/simulation_guidelines.md） */
export function loadUserSimGuidelines(): string {
  if (guidelinesCache === undefined) {
    guidelinesCache = readFileSync(join(DATA_DIR, 'simulation_guidelines.md'), 'utf8')
  }
  return guidelinesCache
}

/** 按 split 取任务（默认 test 划分） */
export function loadTasksBySplit(split: TaskSplit): TauTask[] {
  const tasks = loadRetailTasks()
  if (split === 'all') return tasks
  const ids = loadRetailSplit()[split]
  // 此前未知/缺失的划分静默返回空数组 ⇒ 一次拼错的 --split 会「跑完 0 个任务、输出一份
  // 全是 0 的报表」，全程无报错。改成显式报错，并把可用划分写进消息里。
  if (!ids) {
    const available = Object.keys(loadRetailSplit())
    throw new Error(
      `未知的任务划分 "${split}"：split_tasks.json 可用的是 ${available.length > 0 ? available.join(' / ') : '(该文件为空)'}，或传 'all' 取全集`,
    )
  }
  const idSet = new Set(ids)
  return tasks.filter((t) => idSet.has(t.id))
}
