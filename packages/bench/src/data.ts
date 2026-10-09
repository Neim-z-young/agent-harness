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
import type { RetailDB, TauTask } from './types'

const DATA_DIR = join(import.meta.dir, 'data')
const RETAIL_DIR = join(DATA_DIR, 'retail')

let dbCache: RetailDB | undefined
let tasksCache: TauTask[] | undefined
let splitCache: Record<'train' | 'test', string[]> | undefined

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

/** train/test 划分（split_tasks.json） */
export function loadRetailSplit(): Record<'train' | 'test', string[]> {
  if (!splitCache) {
    splitCache = JSON.parse(readFileSync(join(RETAIL_DIR, 'split_tasks.json'), 'utf8'))
  }
  return splitCache!
}

/** retail 域政策（agent system prompt 的 <policy> 段） */
export function loadRetailPolicy(): string {
  return readFileSync(join(RETAIL_DIR, 'policy.md'), 'utf8')
}

/** user simulator 全局行为准则（官方 data/tau2/user_simulator/simulation_guidelines.md） */
export function loadUserSimGuidelines(): string {
  return readFileSync(join(DATA_DIR, 'simulation_guidelines.md'), 'utf8')
}

/** 按 split 取任务（默认 test 划分） */
export function loadTasksBySplit(split: 'train' | 'test' | 'all'): TauTask[] {
  const tasks = loadRetailTasks()
  if (split === 'all') return tasks
  const ids = new Set(loadRetailSplit()[split] ?? [])
  return tasks.filter((t) => ids.has(t.id))
}
