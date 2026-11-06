/**
 * data：任务加载器的契约（此前零覆盖）。
 *
 * 钉住两件事：① DB 每次返回独立深拷贝（调用方持有并演进，串了会污染其它任务的判分）；
 * ② 取不到划分时报错而不是静默返回空数组。
 */
import { describe, expect, it } from 'bun:test'
import {
  loadRetailDb,
  loadRetailPolicy,
  loadRetailSplit,
  loadRetailTasks,
  loadTasksBySplit,
  loadUserSimGuidelines,
} from './data'
import type { TaskSplit } from './types'

describe('loadRetailDb', () => {
  it('两次调用各自独立（改一个不污染另一个）', () => {
    const a = loadRetailDb()
    const b = loadRetailDb()
    expect(a).not.toBe(b)
    const firstOrder = Object.keys(a.orders)[0]!
    a.orders[firstOrder]!.status = 'cancelled'
    expect(b.orders[firstOrder]!.status).not.toBe('cancelled')
  })
})

describe('loadRetailSplit / loadTasksBySplit', () => {
  it('split_tasks.json 的三档都在类型里可取（train / test / base）', () => {
    const split = loadRetailSplit()
    expect(Object.keys(split).sort()).toEqual(['base', 'test', 'train'])
    expect(split.test!.length).toBeGreaterThan(0)
  })

  it('按划分取任务：结果是全集子集且 id 都在划分里', () => {
    const all = loadRetailTasks()
    const test = loadTasksBySplit('test')
    expect(test.length).toBeGreaterThan(0)
    expect(test.length).toBeLessThan(all.length)
    const ids = new Set(loadRetailSplit().test!)
    expect(test.every((t) => ids.has(t.id))).toBe(true)
  })

  it("'all' 取全集", () => {
    expect(loadTasksBySplit('all').length).toBe(loadRetailTasks().length)
  })

  it("'base' 可用（此前类型不认这一档，只能绕开 loader）", () => {
    const base = loadTasksBySplit('base')
    expect(base.length).toBe(loadRetailSplit().base!.length)
  })

  it('未知划分显式报错，并把可用划分写进消息', () => {
    expect(() => loadTasksBySplit('nope' as TaskSplit)).toThrow(/未知的任务划分 "nope"/)
    expect(() => loadTasksBySplit('nope' as TaskSplit)).toThrow(/train/)
  })
})

describe('policy / guidelines 缓存口径', () => {
  it('内容非空，重复调用稳定返回同一份', () => {
    const p = loadRetailPolicy()
    expect(p.length).toBeGreaterThan(0)
    expect(loadRetailPolicy()).toBe(p)
    const g = loadUserSimGuidelines()
    expect(g.length).toBeGreaterThan(0)
    expect(loadUserSimGuidelines()).toBe(g)
  })
})
