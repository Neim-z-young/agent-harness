import { describe, expect, it } from 'bun:test'
import { RequestDeadline } from './deadline'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('RequestDeadline：取消桥', () => {
  it('外层 signal 取消即传播到内层', async () => {
    const outer = new AbortController()
    const d = new RequestDeadline(outer.signal)
    expect(d.signal.aborted).toBe(false)
    outer.abort()
    expect(d.signal.aborted).toBe(true)
    expect(d.aborted).toBe(true)
    d.dispose()
  })

  it('外层已取消时构造即处于取消态（竞态：signal 在装配前就 abort 过）', () => {
    const outer = new AbortController()
    outer.abort()
    const d = new RequestDeadline(outer.signal)
    expect(d.signal.aborted).toBe(true)
    d.dispose()
  })

  it('超时以 Error 作为 reason（调用方据此区分「超时」与「用户取消」）', async () => {
    const d = new RequestDeadline()
    d.armTotal(10, '请求超时（测试）')
    await sleep(60)
    expect(d.signal.aborted).toBe(true)
    expect((d.signal.reason as Error).message).toBe('请求超时（测试）')
    d.dispose()
  })

  it('armIdle 会被续期：持续有数据时不触发', async () => {
    const d = new RequestDeadline()
    d.armIdle(40, '空闲超时')
    for (let i = 0; i < 6; i += 1) {
      await sleep(15)
      d.armIdle(40, '空闲超时')
    }
    expect(d.signal.aborted).toBe(false)
    d.dispose()
  })

  it('armIdle 停止续期后触发', async () => {
    const d = new RequestDeadline()
    d.armIdle(15, '空闲超时')
    await sleep(80)
    expect(d.signal.aborted).toBe(true)
    expect((d.signal.reason as Error).message).toBe('空闲超时')
    d.dispose()
  })

  it('armTotal 不随数据续期：慢速吐数据也照样被总时长收掉', async () => {
    const d = new RequestDeadline()
    d.armTotal(30, '总时长超时')
    for (let i = 0; i < 8; i += 1) {
      await sleep(12)
      d.armIdle(30, '空闲超时')
    }
    expect((d.signal.reason as Error).message).toBe('总时长超时')
    d.dispose()
  })

  it('dispose 后计时器不再触发（finally 路径必须真正停表）', async () => {
    const d = new RequestDeadline()
    d.armTotal(10, '总时长超时')
    d.dispose()
    await sleep(60)
    expect(d.signal.aborted).toBe(false)
  })

  it('dispose 摘掉外层监听器：之后外层取消不再传播（长会话内存不随请求数增长）', () => {
    const outer = new AbortController()
    const d = new RequestDeadline(outer.signal)
    d.dispose()
    outer.abort()
    expect(d.signal.aborted).toBe(false)
  })

  it('dispose 幂等', () => {
    const d = new RequestDeadline()
    d.dispose()
    expect(() => d.dispose()).not.toThrow()
  })

  it('已取消后 arm 不再安排新计时器（不产生幽灵 timer）', async () => {
    const outer = new AbortController()
    const d = new RequestDeadline(outer.signal)
    outer.abort()
    d.armIdle(5, '不该出现')
    await sleep(30)
    expect((d.signal.reason as Error | undefined)?.message).not.toBe('不该出现')
    d.dispose()
  })
})
