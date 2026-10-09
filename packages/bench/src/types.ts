/**
 * @harness/bench - τ³-bench（retail 域）类型定义
 *
 * 与官方 sierra-research/tau2-bench 的数据模型一一对应（字段保持 snake_case，
 * JSON.parse 后即为类型实例，无需转换）：
 * - 任务：src/tau2/data_model/tasks.py
 * - retail DB：src/tau2/domains/retail/data_model.py
 */

// ===== 任务模型（tasks.py）=====

export interface UserScenarioInstructions {
  task_instructions: string
  domain: string
  reason_for_call: string
  known_info: string
  unknown_info: string
}

export interface UserScenario {
  persona?: unknown
  instructions: UserScenarioInstructions
}

/** judge 期望的 golden action（DB 终态校验的回放脚本） */
export interface ExpectedAction {
  action_id: string
  name: string
  arguments: Record<string, unknown>
  info?: unknown
  /** retail 域无此字段；tau2 双控域用它区分 user/assistant 发起 */
  requestor?: 'user' | 'assistant'
}

export type RewardBasis = 'DB' | 'ENV_ASSERTION' | 'NL_ASSERTION' | 'COMMUNICATE_INFO'

export interface EvaluationCriteria {
  actions?: ExpectedAction[] | null
  communicate_info?: string[] | null
  nl_assertions?: unknown[] | null
  env_assertions?: unknown[] | null
  reward_basis?: RewardBasis[]
}

export interface TauTask {
  id: string
  description?: {
    purpose?: string | null
    relevant_policies?: string | null
    notes?: string | null
  } | null
  user_scenario: UserScenario
  initial_state?: unknown | null
  evaluation_criteria?: EvaluationCriteria | null
}

// ===== retail DB 模型（data_model.py）=====

export interface Variant {
  item_id: string
  options: Record<string, string>
  available: boolean
  price: number
}

export interface Product {
  name: string
  product_id: string
  variants: Record<string, Variant>
}

export interface UserName {
  first_name: string
  last_name: string
}

export interface UserAddress {
  address1: string
  address2: string
  city: string
  country: string
  state: string
  zip: string
}

export interface CreditCard {
  source: 'credit_card'
  id: string
  brand: string
  last_four: string
}

export interface Paypal {
  source: 'paypal'
  id: string
}

export interface GiftCard {
  source: 'gift_card'
  id: string
  balance: number
}

export type PaymentMethod = CreditCard | Paypal | GiftCard

export interface User {
  user_id: string
  name: UserName
  address: UserAddress
  email: string
  payment_methods: Record<string, PaymentMethod>
  orders: string[]
}

export interface OrderItem {
  name: string
  product_id: string
  item_id: string
  price: number
  options: Record<string, string>
}

export interface OrderFulfillment {
  tracking_id: string[]
  item_ids: string[]
}

export interface OrderPayment {
  transaction_type: 'payment' | 'refund'
  amount: number
  payment_method_id: string
}

export type OrderStatus =
  | 'processed'
  | 'pending'
  | 'pending (item modified)'
  | 'delivered'
  | 'cancelled'
  | 'exchange requested'
  | 'return requested'

export type CancelReason = 'no longer needed' | 'ordered by mistake'

export interface Order {
  order_id: string
  user_id: string
  address: UserAddress
  items: OrderItem[]
  status: OrderStatus
  fulfillments: OrderFulfillment[]
  payment_history: OrderPayment[]
  cancel_reason?: CancelReason | null
  exchange_items?: string[] | null
  exchange_new_items?: string[] | null
  exchange_payment_method_id?: string | null
  exchange_price_difference?: number | null
  return_items?: string[] | null
  return_payment_method_id?: string | null
}

export interface RetailDB {
  products: Record<string, Product>
  users: Record<string, User>
  orders: Record<string, Order>
}

// ===== 轨迹 / 结果模型（bench 自有）=====

/** 从 session 提取的工具调用（judge 回放的最小单元） */
export interface ToolInvocation {
  toolId: string
  input: Record<string, unknown>
  isError: boolean
}

export interface TurnRecord {
  role: 'user' | 'assistant'
  /** assistant 轮：最终文本回复；user 轮：模拟用户消息（可含 STOP token） */
  text: string
  /** assistant 轮内的工具调用序列（按时间序） */
  toolCalls: ToolInvocation[]
  /** 本轮耗时（ms） */
  latencyMs: number
}

export type TerminationReason =
  | 'user_stop' // 模拟用户输出 ###STOP###
  | 'user_transfer' // ###TRANSFER###
  | 'user_out_of_scope' // ###OUT-OF-SCOPE###
  | 'max_turns'
  | 'error'

export interface TaskRunResult {
  taskId: string
  /** 第几个采样（pass^k 的 k 次重复，0-based） */
  sampleIndex: number
  sessionId: string
  terminated: TerminationReason
  turns: number
  trajectory: TurnRecord[]
  /** judge 结果 */
  dbMatch: boolean
  reward: number
  rewardBasis?: RewardBasis[]
  /** 成本（agent 侧，来自 harness usage；user simulator 单独计） */
  usage: {
    llmCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
  }
  /** user simulator 用量（独立模型调用） */
  userSimUsage: {
    calls: number
    inputTokens: number
    outputTokens: number
  }
  latencyMs: number
  error?: string
}
