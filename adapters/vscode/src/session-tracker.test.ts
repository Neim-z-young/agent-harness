/**
 * `session-tracker.ts`（P3-D 的"当前会话"承载点）纯单测。
 *
 * 只有三件事值得钉：**未绑定时不回落**、**空值不写入**、**换绑是覆盖不是追加**。
 */
import { describe, expect, it } from 'bun:test'
import { SessionTracker } from './session-tracker'

describe('SessionTracker：当前会话承载点', () => {
  it('未绑定 ⇒ undefined，**不回落任何默认值**（回落 = 把工具执行记到别的会话上）', () => {
    const t = new SessionTracker()
    expect(t.get()).toBeUndefined()
    expect(t.bound).toBe(false)
  })

  it('set 后取回；bound 转真', () => {
    const t = new SessionTracker()
    t.set('s_123')
    expect(t.get()).toBe('s_123')
    expect(t.bound).toBe(true)
  })

  it('undefined / 空白串 = 空操作（调用点写 `set(ids.contextId)` 才安全）', () => {
    const t = new SessionTracker()
    t.set('s_1')
    t.set(undefined)
    t.set('   ')
    expect(t.get()).toBe('s_1')
  })

  it('未绑定时的空值写入不会把状态变成"已绑定但为空"', () => {
    const t = new SessionTracker()
    t.set(undefined)
    t.set('')
    expect(t.get()).toBeUndefined()
    expect(t.bound).toBe(false)
  })

  it('换绑是覆盖：/new 或 /resume 之后只认新的那个', () => {
    const t = new SessionTracker()
    t.set('s_old')
    t.set('s_new')
    expect(t.get()).toBe('s_new')
  })

  it('首尾空白被 trim（与会话 id 的比较口径一致）', () => {
    const t = new SessionTracker()
    t.set('  s_9  ')
    expect(t.get()).toBe('s_9')
  })

  it('clear() 回到未绑定（扩展停用 / 重启 sidecar 时用）', () => {
    const t = new SessionTracker()
    t.set('s_1')
    t.clear()
    expect(t.get()).toBeUndefined()
    expect(t.bound).toBe(false)
  })
})
