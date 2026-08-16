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
