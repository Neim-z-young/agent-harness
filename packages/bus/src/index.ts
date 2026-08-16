/**
 * @harness/bus - 类型安全的事件总线
 *
 * 提供 BusEvent.define() 类型安全事件定义、Bus 接口
 * （publish / subscribe / subscribeAll 三 API）。
 *
 * 事件自动桥接 SSE（Web UI）等下游订阅者。
 */

// ===== 基础工具类型 =====

/** 支持 Promise 或同步值的类型 */
export type Awaitable<T> = T | Promise<T>

// ===== 事件 Schema 抽象 =====

/**
 * 事件 Schema 接口（抽象层，兼容 zod / valibot / 自定义校验）
 * 用于运行时校验事件载荷。
 */
export interface EventSchema<T> {
  /** 严格解析，失败抛错 */
  parse(value: unknown): T
  /** 安全解析，返回结果对象 */
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }
}

// ===== BusEvent 类型安全事件定义 =====

/** 事件载荷类型映射（从 BusEvent 实例推导载荷类型） */
export type EventPayload<E> = E extends BusEvent<infer T> ? T : never

/**
 * 类型安全的事件定义
 * 通过 BusEvent.define<T>(name, schema) 创建
 */
export interface BusEvent<T = unknown> {
  /** 事件名（建议域.动作 格式，如 session.message.created） */
  readonly name: string
  /** 载荷 schema（运行时校验，可选） */
  readonly schema?: EventSchema<T>
  /** 类型标识（仅用于类型推导，运行时为 undefined） */
  readonly __type?: T
}

export namespace BusEvent {
  /**
   * 定义一个类型安全的事件
   * @param name 事件名（建议域.动作 格式）
   * @param schema 可选的载荷 schema（zod 等）
   * @example
   * const MessageCreated = BusEvent.define<{ id: string }>('session.message.created')
   */
  export function define<T>(name: string, schema?: EventSchema<T>): BusEvent<T> {
    return { name, schema }
  }
}

// ===== 事件记录 =====

/** 事件订阅句柄，调用即取消订阅 */
export type Unsubscribe = () => void

/** 已发布的事件记录（含元数据） */
export interface BusEventRecord<T = unknown> {
  /** 事件名 */
  readonly name: string
  /** 载荷 */
  readonly payload: T
  /** 时间戳（ms） */
  readonly timestamp: number
  /** 来源标识（如 pluginId、agentId） */
  readonly source?: string
}

/** 事件订阅者函数 */
export type EventSubscriber<T = unknown> = (event: BusEventRecord<T>) => Awaitable<void>

// ===== Bus 接口 =====

/**
 * Bus 事件总线接口
 * 类型安全的 Pub/Sub，支持 publish / subscribe / subscribeAll
 */
export interface Bus {
  /**
   * 发布一个类型安全事件
   *
   * 流程：
   * 1. 若 event 带有 schema，则先校验 payload，失败则抛错
   * 2. 构造 BusEventRecord（含时间戳、来源）
   * 3. 并发通知所有事件匹配订阅者 + 全局订阅者
   * 4. 某个订阅者抛错不影响其他订阅者，错误收集到 AggregateError
   *
   * @param event BusEvent.define() 创建的事件定义
   * @param payload 事件载荷
   */
  publish<E extends BusEvent>(
    event: E,
    payload: EventPayload<E>,
    options?: { source?: string }
  ): Promise<void>

  /**
   * 订阅特定事件
   * @param event 事件定义
   * @param subscriber 订阅函数
   * @returns 取消订阅函数
   * @example
   * const off = bus.subscribe(MessageCreated, ({ payload }) => {
   *   console.log('新消息：', payload.id)
   * })
   */
  subscribe<E extends BusEvent>(
    event: E,
    subscriber: EventSubscriber<EventPayload<E>>
  ): Unsubscribe

  /**
   * 订阅所有事件（用于日志、调试、SSE 桥接等）
   * @param subscriber 订阅函数
   * @returns 取消订阅函数
   */
  subscribeAll(subscriber: EventSubscriber): Unsubscribe
}

// ===== InMemoryBus 具体实现 =====

/**
 * 内存事件总线实现
 *
 * 特点：
 * - 单个进程内的 Pub/Sub，不做跨进程广播
 * - publish 异步并发通知所有订阅者，单个错误隔离
 * - schema 校验失败直接抛错（认为是开发期错误）
 * - 订阅者重复注册：同一函数多次订阅会被多次调用
 * - 取消订阅是幂等的（多次调用 unsubscribe 无副作用）
 */
export class InMemoryBus implements Bus {
  /** 事件名 → 订阅者集合 */
  private readonly byEvent: Map<string, Set<EventSubscriber>> = new Map()
  /** 全局订阅者集合（subscribeAll） */
  private readonly all: Set<EventSubscriber> = new Set()

  async publish<E extends BusEvent>(
    event: E,
    payload: EventPayload<E>,
    options?: { source?: string }
  ): Promise<void> {
    // 1. Schema 校验（开发期校验，失败抛错）
    if (event.schema) {
      const result = event.schema.safeParse(payload)
      if (!result.success) {
        throw new BusSchemaValidationError(event.name, result.error)
      }
      payload = result.data as EventPayload<E>
    }

    // 2. 构造事件记录
    const record: BusEventRecord<EventPayload<E>> = {
      name: event.name,
      payload,
      timestamp: Date.now(),
      source: options?.source,
    }

    // 3. 收集所有需要通知的订阅者（事件匹配 + 全局）
    const subscribers = [
      ...(this.byEvent.get(event.name) ?? []),
      ...this.all,
    ]

    if (subscribers.length === 0) return

    // 4. 并发调用，错误隔离
    // 用 async IIFE 包装：同步 throw 的订阅者也会变成 rejected promise，被 allSettled 捕获
    const results = await Promise.allSettled(
      subscribers.map(async (sub) => sub(record as BusEventRecord))
    )

    // 5. 汇总错误
    const errors: Error[] = []
    for (const r of results) {
      if (r.status === 'rejected') {
        errors.push(r.reason instanceof Error ? r.reason : new Error(String(r.reason)))
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `Bus.publish(${event.name}): ${errors.length} subscriber(s) failed`)
    }
  }

  subscribe<E extends BusEvent>(
    event: E,
    subscriber: EventSubscriber<EventPayload<E>>
  ): Unsubscribe {
    const set = this.byEvent.get(event.name) ?? (() => {
      const s = new Set<EventSubscriber>()
      this.byEvent.set(event.name, s)
      return s
    })()

    set.add(subscriber as EventSubscriber)

    return () => {
      set.delete(subscriber as EventSubscriber)
      if (set.size === 0) {
        this.byEvent.delete(event.name)
      }
    }
  }

  subscribeAll(subscriber: EventSubscriber): Unsubscribe {
    this.all.add(subscriber)
    return () => {
      this.all.delete(subscriber)
    }
  }

  /** 诊断：返回当前订阅数（调试用） */
  _diagnostics() {
    return {
      events: Array.from(this.byEvent.entries()).map(([name, set]) => [name, set.size] as const),
      allCount: this.all.size,
    }
  }
}

// ===== 自定义错误 =====

/** Schema 校验失败错误 */
export class BusSchemaValidationError extends Error {
  readonly eventName: string
  readonly cause: unknown

  constructor(eventName: string, cause: unknown) {
    super(
      `Bus schema validation failed for event "${eventName}": ` +
        (cause instanceof Error ? cause.message : String(cause))
    )
    this.name = 'BusSchemaValidationError'
    this.eventName = eventName
    this.cause = cause
  }
}

// ===== 工厂函数 =====

/**
 * 创建一个 Bus 实例（当前默认 InMemoryBus）
 *
 * @example
 * const bus = createBus()
 * const MessageCreated = BusEvent.define<{ id: string }>('message.created')
 * const off = bus.subscribe(MessageCreated, ({ payload }) => { ... })
 * await bus.publish(MessageCreated, { id: '123' })
 */
export function createBus(): Bus {
  return new InMemoryBus()
}
