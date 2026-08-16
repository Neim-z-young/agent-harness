import { describe, it, expect, beforeEach } from 'bun:test'
import {
  BusEvent,
  BusEventRecord,
  BusSchemaValidationError,
  EventSchema,
  createBus,
  InMemoryBus,
} from './index'

describe('@harness/bus', () => {
  // ===== 测试用事件定义 =====

  const SimpleEvent = BusEvent.define<{ id: string; text: string }>('simple.event')
  const CounterEvent = BusEvent.define<{ count: number }>('counter.event')

  // 带 schema 的事件（自定义简易 schema，不依赖 zod）
  const schemaCheck = <T>(validator: (v: unknown) => T): EventSchema<T> => ({
    parse: (v) => validator(v),
    safeParse: (v) => {
      try {
        return { success: true, data: validator(v) }
      } catch (err) {
        return { success: false, error: err }
      }
    },
  })

  const StrictEvent = BusEvent.define<{ name: string; age: number }>(
    'strict.event',
    schemaCheck((v) => {
      const o = v as { name: unknown; age: unknown }
      if (typeof o !== 'object' || o === null) throw new Error('不是对象')
      if (typeof o.name !== 'string') throw new Error('name 必须是字符串')
      if (typeof o.age !== 'number') throw new Error('age 必须是数字')
      return { name: o.name, age: o.age }
    })
  )

  let bus: InMemoryBus

  beforeEach(() => {
    bus = new InMemoryBus()
  })

  describe('BusEvent.define', () => {
    it('创建带名称的事件定义', () => {
      expect(SimpleEvent.name).toBe('simple.event')
      expect(CounterEvent.name).toBe('counter.event')
    })

    it('携带 schema 定义', () => {
      expect(StrictEvent.schema).toBeDefined()
    })
  })

  describe('subscribe + publish', () => {
    it('发布事件时触发订阅者回调', async () => {
      let received: BusEventRecord | null = null
      bus.subscribe(SimpleEvent, (e) => {
        received = e
      })

      await bus.publish(SimpleEvent, { id: '1', text: 'hello' })

      expect(received).not.toBeNull()
      expect(received!.name).toBe('simple.event')
      expect(received!.payload).toEqual({ id: '1', text: 'hello' })
      expect(typeof received!.timestamp).toBe('number')
      expect(received!.timestamp).toBeLessThanOrEqual(Date.now())
    })

    it('记录 source 元信息', async () => {
      let received: BusEventRecord | null = null
      bus.subscribe(SimpleEvent, (e) => {
        received = e
      })

      await bus.publish(SimpleEvent, { id: '2', text: 'x' }, { source: 'plugin-a' })
      expect(received!.source).toBe('plugin-a')
    })

    it('发布未订阅事件不会抛错', async () => {
      const result = await bus
        .publish(SimpleEvent, { id: '3', text: 'no-sub' })
        .then(() => 'ok', (e) => e)
      expect(result).toBe('ok')
    })

    it('支持多个订阅者，同时收到事件', async () => {
      const events1: string[] = []
      const events2: string[] = []
      bus.subscribe(SimpleEvent, (e) => {
        events1.push(e.payload.id)
      })
      bus.subscribe(SimpleEvent, (e) => {
        events2.push(e.payload.id + '-suffix')
      })

      await bus.publish(SimpleEvent, { id: 'a', text: '' })
      await bus.publish(SimpleEvent, { id: 'b', text: '' })

      expect(events1).toEqual(['a', 'b'])
      expect(events2).toEqual(['a-suffix', 'b-suffix'])
    })

    it('不同事件的订阅者互相隔离', async () => {
      const simple: string[] = []
      const counter: number[] = []
      bus.subscribe(SimpleEvent, (e) => { simple.push(e.payload.id) })
      bus.subscribe(CounterEvent, (e) => { counter.push(e.payload.count) })

      await bus.publish(SimpleEvent, { id: 'x', text: '' })
      await bus.publish(CounterEvent, { count: 42 })

      expect(simple).toEqual(['x'])
      expect(counter).toEqual([42])
    })
  })

  describe('unsubscribe', () => {
    it('调用返回句柄可取消订阅', async () => {
      const calls: number[] = []
      const off = bus.subscribe(CounterEvent, (e) => { calls.push(e.payload.count) })

      await bus.publish(CounterEvent, { count: 1 })
      off()
      await bus.publish(CounterEvent, { count: 2 })

      expect(calls).toEqual([1])
    })

    it('取消订阅是幂等的（多次调用无副作用）', async () => {
      const calls: number[] = []
      const off = bus.subscribe(CounterEvent, (e) => { calls.push(e.payload.count) })

      off()
      off()
      await bus.publish(CounterEvent, { count: 1 })

      expect(calls).toEqual([])
    })

    it('取消订阅后 byEvent Map 对应条目被清理', async () => {
      const off = bus.subscribe(CounterEvent, () => {})
      expect(bus._diagnostics().events).toHaveLength(1)

      off()
      expect(bus._diagnostics().events).toHaveLength(0)
    })
  })

  describe('subscribeAll', () => {
    it('接收所有事件', async () => {
      const events: string[] = []
      bus.subscribeAll((e) => {
        events.push(e.name)
      })

      await bus.publish(SimpleEvent, { id: '1', text: '' })
      await bus.publish(CounterEvent, { count: 1 })

      expect(events).toEqual(['simple.event', 'counter.event'])
    })

    it('subscribeAll 与指定事件订阅可同时工作', async () => {
      const names: string[] = []
      const ids: string[] = []
      bus.subscribeAll((e) => { names.push(e.name) })
      bus.subscribe(SimpleEvent, (e) => { ids.push(e.payload.id) })

      await bus.publish(SimpleEvent, { id: 's1', text: '' })

      expect(names).toEqual(['simple.event'])
      expect(ids).toEqual(['s1'])
    })

    it('subscribeAll 可取消', async () => {
      const names: string[] = []
      const off = bus.subscribeAll((e) => { names.push(e.name) })

      await bus.publish(SimpleEvent, { id: '1', text: '' })
      off()
      await bus.publish(CounterEvent, { count: 1 })

      expect(names).toEqual(['simple.event'])
    })
  })

  describe('schema 校验', () => {
    it('schema 校验通过时正常发布', async () => {
      const received: { name: string; age: number }[] = []
      bus.subscribe(StrictEvent, (e) => { received.push(e.payload) })

      await bus.publish(StrictEvent, { name: 'Alice', age: 30 })
      expect(received).toEqual([{ name: 'Alice', age: 30 }])
    })

    it('schema 校验失败抛出 BusSchemaValidationError', async () => {
      const caught = await bus
        .publish(StrictEvent, { name: 123 as any, age: 'abc' as any })
        .then(() => null, (e) => e)

      expect(caught).toBeInstanceOf(BusSchemaValidationError)
      expect((caught as BusSchemaValidationError).eventName).toBe('strict.event')
      expect(caught.name).toBe('BusSchemaValidationError')
    })

    it('schema 校验失败时订阅者不会被调用', async () => {
      let called = false
      bus.subscribe(StrictEvent, () => {
        called = true
      })

      try {
        await bus.publish(StrictEvent, { name: 123 as any, age: 'abc' as any })
      } catch {
        // ignore
      }

      expect(called).toBe(false)
    })
  })

  describe('订阅者错误隔离', () => {
    it('一个订阅者抛错不影响其他订阅者执行，但 publish 抛 AggregateError', async () => {
      const results: number[] = []
      bus.subscribe(CounterEvent, () => {
        throw new Error('第一个出错')
      })
      bus.subscribe(CounterEvent, (e) => {
        results.push(e.payload.count)
      })
      bus.subscribe(CounterEvent, () => {
        throw new Error('第三个出错')
      })

      const err = await bus
        .publish(CounterEvent, { count: 99 })
        .then(() => null, (e) => e)

      // 第二个订阅者成功运行
      expect(results).toEqual([99])

      // publish 抛出了聚合错误
      expect(err).toBeInstanceOf(AggregateError)
      expect((err as AggregateError).errors).toHaveLength(2)
      expect(((err as AggregateError).errors[0] as Error).message).toBe('第一个出错')
      expect(((err as AggregateError).errors[1] as Error).message).toBe('第三个出错')
    })

    it('异步订阅者也参与错误聚合', async () => {
      const calls: string[] = []
      bus.subscribe(CounterEvent, async () => {
        await Promise.resolve()
        throw new Error('异步错误')
      })
      bus.subscribe(CounterEvent, (e) => {
        calls.push('sync-' + e.payload.count)
      })

      const err = await bus
        .publish(CounterEvent, { count: 1 })
        .then(() => null, (e) => e)

      expect(calls).toEqual(['sync-1'])
      expect(err).toBeInstanceOf(AggregateError)
      expect(((err as AggregateError).errors[0] as Error).message).toBe('异步错误')
    })
  })

  describe('并发', () => {
    it('异步订阅者并发执行（总耗时 ≈ 最慢的单个订阅者）', async () => {
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
      const times: number[] = []
      bus.subscribe(CounterEvent, async () => {
        await sleep(50)
        times.push(Date.now())
      })
      bus.subscribe(CounterEvent, async () => {
        await sleep(80)
        times.push(Date.now())
      })

      const start = Date.now()
      await bus.publish(CounterEvent, { count: 1 })
      const duration = Date.now() - start

      // 两个任务并发，总耗时应接近 80ms 而非 130ms
      expect(duration).toBeGreaterThanOrEqual(70)
      expect(duration).toBeLessThan(120)
      expect(times).toHaveLength(2)
    })
  })

  describe('createBus 工厂', () => {
    it('createBus 返回 InMemoryBus 实例', () => {
      const b = createBus()
      expect(b).toBeInstanceOf(InMemoryBus)
    })

    it('createBus 创建的实例可用', async () => {
      const b = createBus()
      const list: string[] = []
      b.subscribe(SimpleEvent, (e) => { list.push(e.payload.id) })
      await b.publish(SimpleEvent, { id: 'x', text: '' })
      expect(list).toEqual(['x'])
    })
  })

  describe('_diagnostics', () => {
    it('返回正确的订阅数量诊断信息', () => {
      expect(bus._diagnostics()).toEqual({ events: [], allCount: 0 })

      const off1 = bus.subscribe(SimpleEvent, () => {})
      bus.subscribe(SimpleEvent, () => {})
      const offAll = bus.subscribeAll(() => {})

      expect(bus._diagnostics()).toEqual({
        events: [['simple.event', 2]],
        allCount: 1,
      })

      off1()
      offAll()
      expect(bus._diagnostics()).toEqual({
        events: [['simple.event', 1]],
        allCount: 0,
      })
    })
  })
})
