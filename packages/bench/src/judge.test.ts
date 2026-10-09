import { describe, expect, it } from 'bun:test'
import { loadRetailTasks } from './data'
import { deepEqualWithDiff, judgeTask } from './judge'
import type { ToolInvocation } from './types'

describe('deepEqualWithDiff', () => {
  it('键序无关 / undefined 与缺失等价', () => {
    expect(deepEqualWithDiff({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBeNull()
    expect(deepEqualWithDiff({ a: 1, b: undefined }, { a: 1 })).toBeNull()
  })
  it('差异定位', () => {
    expect(deepEqualWithDiff({ a: { b: 1 } }, { a: { b: 2 } })).toBe('$.a.b')
    expect(deepEqualWithDiff([1, 2, 3], [1, 2, 4])).toBe('$[2]')
    expect(deepEqualWithDiff({ a: 1 }, { a: 1, b: 2 })).toContain('$.keys')
  })
})

describe('judgeTask（DB 终态校验）', () => {
  const tasks = loadRetailTasks()

  it('轨迹 = golden actions ⇒ dbMatch=true', async () => {
    const task = tasks.find((t) => t.id === '0')!
    const invocations: ToolInvocation[] = (task.evaluation_criteria!.actions ?? []).map((a) => ({
      toolId: a.name,
      input: a.arguments,
      isError: false,
    }))
    const r = await judgeTask(task, invocations)
    expect(r.dbMatch).toBe(true)
    expect(r.reward).toBe(1)
  })

  it('轨迹缺失关键写操作 ⇒ dbMatch=false 且给出差异路径', async () => {
    const task = tasks.find((t) => t.id === '0')!
    const actions = task.evaluation_criteria!.actions!
    // 去掉最后的 exchange（写操作）
    const invocations: ToolInvocation[] = actions.slice(0, -1).map((a) => ({
      toolId: a.name,
      input: a.arguments,
      isError: false,
    }))
    const r = await judgeTask(task, invocations)
    expect(r.dbMatch).toBe(false)
    expect(r.dbDiffPath).toBeDefined()
    expect(r.reward).toBe(0)
  })

  it('空轨迹 + 有写操作的任务 ⇒ dbMatch=false', async () => {
    const task = tasks.find((t) => t.id === '0')!
    const r = await judgeTask(task, [])
    expect(r.dbMatch).toBe(false)
  })

  it('全量任务回放自洽：golden 轨迹判分全部 dbMatch（数据/实现一致性总检）', async () => {
    // 对每个任务：把 golden actions 当轨迹判分。
    // 排除「golden actions 本身含失败调用」的任务（官方数据存在少量此类任务，判分必然 false ——
    // 回放时 gold 侧静默跳过失败动作，predicted 侧跳过 isError 动作，两者仍应一致，
    // 故此用例期望全部通过，可作为任务数据与工具实现的交叉验证）。
    const withActions = tasks.filter((t) => (t.evaluation_criteria?.actions ?? []).length > 0)
    expect(withActions.length).toBeGreaterThan(80)
    for (const task of withActions) {
      const invocations: ToolInvocation[] = (task.evaluation_criteria!.actions ?? []).map((a) => ({
        toolId: a.name,
        input: a.arguments,
        isError: false,
      }))
      const r = await judgeTask(task, invocations)
      if (!r.dbMatch) {
        throw new Error(`task ${task.id} golden 回放不自洽: ${r.dbDiffPath}`)
      }
    }
  })
})
