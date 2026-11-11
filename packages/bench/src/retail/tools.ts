/**
 * τ³-bench retail 域工具 —— 官方 `src/tau2/domains/retail/tools.py` 的 TypeScript 忠实翻译。
 *
 * 三个消费方共享同一份实现，保证「agent 执行」与「judge 回放」必然同源：
 * 1. `executeRetailTool(db, name, args)`：纯函数调度（judge 轨迹/gold 回放直接调用）
 * 2. `buildRetailHarnessTools(db)`：defineTool 包装（经 `core.tool.pool.assemble` 注入 harness）
 * 3. `createRetailPlugin(db)`：AgentPlugin 工厂（bench runner 的 extraPlugins 入参）
 *
 * 翻译约定：
 * - 工具名 / 描述 / 参数描述保持官方英文原文（模型行为与官方对齐，golden actions 按 name 匹配）
 * - Python `ValueError` → `{ ok: false, error }`（模型可见错误文本）
 * - 浮点金额统一 `round2`（gold 与 predicted 走同一实现，内部一致性优先）
 * - `MUTATES_STATE_TOOLS`：与官方 `is_tool(mutates_state=True)` 集合一致，judge 回放只重放这些
 * - 已知官方行为（含疑似 bug）按原样保留并注释标注，见 modify_pending_order_items
 */
import { defineTool, type AgentPlugin, type Hooks, type Tool } from '@harness/core'
import { fromJsonSchema } from '@harness/tool'
import type { GiftCard, Order, RetailDB, User, UserAddress, Variant } from '../types'
import type { ToolResult } from '@harness/tool'

// ===== 基础 helpers =====

/** 金额保留 2 位小数（gold/predicted 同一实现，内部一致即可） */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

class ToolError extends Error {}

function getOrder(db: RetailDB, orderId: string): Order {
  const order = db.orders[orderId]
  if (!order) throw new ToolError('Order not found')
  return order
}

function getUser(db: RetailDB, userId: string): User {
  const user = db.users[userId]
  if (!user) throw new ToolError('User not found')
  return user
}

function getProduct(db: RetailDB, productId: string) {
  const product = db.products[productId]
  if (!product) throw new ToolError('Product not found')
  return product
}

function getVariant(db: RetailDB, productId: string, variantId: string): Variant {
  const product = getProduct(db, productId)
  const variant = product.variants[variantId]
  if (!variant) throw new ToolError('Variant not found')
  return variant
}

function getItem(db: RetailDB, itemId: string): Variant {
  for (const product of Object.values(db.products)) {
    const v = product.variants[itemId]
    if (v) return v
  }
  throw new ToolError('Item not found')
}

function getPaymentMethod(db: RetailDB, userId: string, paymentMethodId: string) {
  const user = getUser(db, userId)
  const pm = user.payment_methods[paymentMethodId]
  if (!pm) throw new ToolError('Payment method not found')
  return pm
}

function isGiftCard(pm: unknown): pm is GiftCard {
  return typeof pm === 'object' && pm !== null && (pm as { source?: unknown }).source === 'gift_card'
}

/**
 * 「还能改」的 pending 语义：**包含** `pending (item modified)`。
 *
 * 与 `cancelPendingOrder` 里的 `order.status !== 'pending'`（只认严格 pending）**故意不同**：
 * item 被改过的订单仍可改地址 / 改支付方式，但不能取消。两处不一致是官方行为，别合并成一条判据。
 */
function isModifiablePending(order: Order): boolean {
  return order.status.includes('pending')
}

/**
 * 取必填字符串参数。
 *
 * 原来一律写 `String(args.x)`：缺参时得到的是**字面量 `"undefined"`**，于是 `getOrder` 报
 * "Order not found"——一句把"参数没传"说成"订单不存在"的错误文案，调用方（judge 回放 /
 * 手工构造的轨迹）几乎无法定位。缺参必须在进入业务逻辑前就说清楚。
 */
function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new ToolError(`Missing or invalid argument: ${key}`)
  return v
}

/** 取字符串数组参数；缺省按空数组（官方 schema 允许空的 item_ids 列表） */
function stringList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new ToolError(`Missing or invalid argument: ${key}`)
  return v.map((x) => String(x))
}

/**
 * 订单地址的组装（改订单地址 / 改用户地址两处共用同一份字段口径）。
 * `address2` 允许缺省为空串（官方 docstring 写作 `''`）。
 */
function addressFromArgs(args: Record<string, unknown>): UserAddress {
  return {
    address1: requireString(args, 'address1'),
    address2: typeof args.address2 === 'string' ? args.address2 : '',
    city: requireString(args, 'city'),
    state: requireString(args, 'state'),
    country: requireString(args, 'country'),
    zip: requireString(args, 'zip'),
  }
}

/**
 * 校验「请求的每个 item 都在订单里，且出现次数不超过订单里的次数」。
 *
 * 换货 / 改单 / 退货三处原本各写一遍同一段 `itemIds.filter(...).length > allItemIds.filter(...).length`，
 * 且都是 O(n²)——每次循环重建两个数组。这里改为一次计数，三处共用。
 * 错误文案由调用方传入（三处的官方英文原文本来就不同）。
 */
function assertItemsInOrder(
  order: Order,
  itemIds: string[],
  notFoundMessage: (itemId: string) => string,
): void {
  const owned = new Map<string, number>()
  for (const item of order.items) owned.set(item.item_id, (owned.get(item.item_id) ?? 0) + 1)
  const requested = new Map<string, number>()
  for (const itemId of itemIds) {
    const seen = (requested.get(itemId) ?? 0) + 1
    requested.set(itemId, seen)
    if (seen > (owned.get(itemId) ?? 0)) throw new ToolError(notFoundMessage(itemId))
  }
}

/** 官方 calculate 工具的表达式子集求值（数字 / + - * / ( ) / 空格，递归下降） */
export function evalMathExpression(expression: string): number {
  const tokens: (number | string)[] = []
  let i = 0
  while (i < expression.length) {
    const ch = expression[i]!
    if (ch === ' ') { i++; continue }
    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < expression.length && /[0-9.]/.test(expression[j]!)) j++
      const num = Number(expression.slice(i, j))
      if (!Number.isFinite(num)) throw new ToolError('Invalid number')
      tokens.push(num)
      i = j
    } else if ('+-*/()'.includes(ch)) {
      tokens.push(ch)
      i++
    } else {
      throw new ToolError('Invalid characters in expression')
    }
  }
  let pos = 0
  const peek = () => tokens[pos]
  const parsePrimary = (): number => {
    const t = tokens[pos]
    if (t === '(') {
      pos++
      const v = parseAdd()
      if (tokens[pos] !== ')') throw new ToolError('Mismatched parentheses')
      pos++
      return v
    }
    if (typeof t === 'number') { pos++; return t }
    throw new ToolError('Invalid expression')
  }
  const parseMul = (): number => {
    let v = parsePrimary()
    while (peek() === '*' || peek() === '/') {
      const op = tokens[pos++] as string
      const rhs = parsePrimary()
      if (op === '*') {
        v = v * rhs
      } else {
        // 除零不抛的话会得到 Infinity，`String(Infinity)` 就是一个模型看得见却算不出数的值，
        // 且整条链路（round2 / 结果 JSON）都不会报警。官方 Python 走 eval，同样抛错。
        if (rhs === 0) throw new ToolError('Division by zero')
        v = v / rhs
      }
    }
    return v
  }
  function parseAdd(): number {
    let v = parseMul()
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++] as string
      const rhs = parseMul()
      v = op === '+' ? v + rhs : v - rhs
    }
    return v
  }
  const result = parseAdd()
  if (pos !== tokens.length) throw new ToolError('Invalid expression')
  return result
}

// ===== 工具实现（官方 tools.py 逐个对应）=====

export const RETAIL_TOOL_NAMES = [
  'calculate',
  'cancel_pending_order',
  'exchange_delivered_order_items',
  'find_user_id_by_name_zip',
  'find_user_id_by_email',
  'get_order_details',
  'get_product_details',
  'get_item_details',
  'get_user_details',
  'list_all_product_types',
  'modify_pending_order_address',
  'modify_pending_order_items',
  'modify_pending_order_payment',
  'modify_user_address',
  'return_delivered_order_items',
  'transfer_to_human_agents',
] as const

export type RetailToolName = (typeof RETAIL_TOOL_NAMES)[number]

/** 会改 DB 状态的工具（= 官方 is_tool(mutates_state=True)；judge 回放只重放这些） */
export const MUTATES_STATE_TOOLS: ReadonlySet<string> = new Set([
  'cancel_pending_order',
  'exchange_delivered_order_items',
  'modify_pending_order_address',
  'modify_pending_order_items',
  'modify_pending_order_payment',
  'modify_user_address',
  'return_delivered_order_items',
])

function cancelPendingOrder(db: RetailDB, orderId: string, reason: string): Order {
  const order = getOrder(db, orderId)
  if (order.status !== 'pending') throw new ToolError('Non-pending order cannot be cancelled')
  if (reason !== 'no longer needed' && reason !== 'ordered by mistake') {
    throw new ToolError('Invalid reason')
  }
  const refunds = order.payment_history.map((payment) => ({
    transaction_type: 'refund' as const,
    amount: payment.amount,
    payment_method_id: payment.payment_method_id,
  }))
  for (const payment of order.payment_history) {
    const pm = getPaymentMethod(db, order.user_id, payment.payment_method_id)
    if (isGiftCard(pm)) pm.balance = round2(pm.balance + payment.amount)
  }
  order.status = 'cancelled'
  order.cancel_reason = reason
  order.payment_history.push(...refunds)
  return order
}

function exchangeDeliveredOrderItems(
  db: RetailDB,
  orderId: string,
  itemIds: string[],
  newItemIds: string[],
  paymentMethodId: string,
): Order {
  const order = getOrder(db, orderId)
  if (order.status !== 'delivered') throw new ToolError('Non-delivered order cannot be exchanged')

  assertItemsInOrder(order, itemIds, (itemId) => `Number of ${itemId} not found.`)
  if (itemIds.length !== newItemIds.length) {
    throw new ToolError('The number of items to be exchanged should match.')
  }

  let diffPrice = 0
  for (let k = 0; k < itemIds.length; k++) {
    const itemId = itemIds[k]!
    const newItemId = newItemIds[k]!
    const item = order.items.find((it) => it.item_id === itemId)
    if (!item) throw new ToolError(`Item ${itemId} not found`)
    const variant = getVariant(db, item.product_id, newItemId)
    if (!variant.available) throw new ToolError(`New item ${newItemId} not found or available`)
    diffPrice += variant.price - item.price
  }
  diffPrice = round2(diffPrice)

  const paymentMethod = getPaymentMethod(db, order.user_id, paymentMethodId)
  if (isGiftCard(paymentMethod) && paymentMethod.balance < diffPrice) {
    throw new ToolError('Insufficient gift card balance to pay for the price difference')
  }

  order.status = 'exchange requested'
  order.exchange_items = [...itemIds].sort()
  order.exchange_new_items = [...newItemIds].sort()
  order.exchange_payment_method_id = paymentMethodId
  order.exchange_price_difference = diffPrice
  return order
}

function modifyPendingOrderItems(
  db: RetailDB,
  orderId: string,
  itemIds: string[],
  newItemIds: string[],
  paymentMethodId: string,
): Order {
  const order = getOrder(db, orderId)
  if (order.status !== 'pending') throw new ToolError('Non-pending order cannot be modified')

  assertItemsInOrder(order, itemIds, (itemId) => `${itemId} not found`)
  if (itemIds.length !== newItemIds.length) {
    throw new ToolError('The number of items to be exchanged should match')
  }

  let diffPrice = 0
  let lastVariant: Variant | undefined
  for (let k = 0; k < itemIds.length; k++) {
    const itemId = itemIds[k]!
    const newItemId = newItemIds[k]!
    if (itemId === newItemId) throw new ToolError('The new item id should be different from the old item id')
    const item = order.items.find((it) => it.item_id === itemId)
    if (!item) throw new ToolError(`Item ${itemId} not found`)
    const variant = getVariant(db, item.product_id, newItemId)
    if (!variant.available) throw new ToolError(`New item ${newItemId} not found or available`)
    lastVariant = variant
    diffPrice += variant.price - item.price
  }

  const paymentMethod = getPaymentMethod(db, order.user_id, paymentMethodId)
  if (isGiftCard(paymentMethod) && paymentMethod.balance < diffPrice) {
    throw new ToolError('Insufficient gift card balance to pay for the new item')
  }

  order.payment_history.push({
    transaction_type: diffPrice > 0 ? 'payment' : 'refund',
    amount: Math.abs(diffPrice),
    payment_method_id: paymentMethodId,
  })
  if (isGiftCard(paymentMethod)) paymentMethod.balance = round2(paymentMethod.balance - diffPrice)

  // 官方实现（tools.py L533-539）：循环外引用的 `variant` 是最后一次循环的值 ——
  // 多 item 修改时所有 item 都会拿到最后 variant 的 price/options。疑似 bug，
  // 但 gold 与 predicted 走同一实现，且与官方对齐，按原样保留。
  for (let k = 0; k < itemIds.length; k++) {
    const itemId = itemIds[k]!
    const item = order.items.find((it) => it.item_id === itemId)
    if (!item) throw new ToolError(`Item ${itemId} not found`)
    item.item_id = newItemIds[k]!
    item.price = lastVariant!.price
    item.options = { ...lastVariant!.options }
  }
  order.status = 'pending (item modified)'
  return order
}

function modifyPendingOrderPayment(db: RetailDB, orderId: string, paymentMethodId: string): Order {
  const order = getOrder(db, orderId)
  if (!isModifiablePending(order)) throw new ToolError('Non-pending order cannot be modified')

  const paymentMethod = getPaymentMethod(db, order.user_id, paymentMethodId)

  if (
    order.payment_history.length !== 1 ||
    order.payment_history[0]!.transaction_type !== 'payment'
  ) {
    throw new ToolError('There should be exactly one payment for a pending order')
  }
  if (order.payment_history[0]!.payment_method_id === paymentMethodId) {
    throw new ToolError('The new payment method should be different from the current one')
  }

  const amount = order.payment_history[0]!.amount
  if (isGiftCard(paymentMethod) && paymentMethod.balance < amount) {
    throw new ToolError('Insufficient gift card balance to pay for the order')
  }

  order.payment_history.push(
    { transaction_type: 'payment', amount, payment_method_id: paymentMethodId },
    {
      transaction_type: 'refund',
      amount,
      payment_method_id: order.payment_history[0]!.payment_method_id,
    },
  )
  if (isGiftCard(paymentMethod)) paymentMethod.balance = round2(paymentMethod.balance - amount)

  const oldPaymentMethod = getPaymentMethod(db, order.user_id, order.payment_history[0]!.payment_method_id)
  if (isGiftCard(oldPaymentMethod)) oldPaymentMethod.balance = round2(oldPaymentMethod.balance + amount)
  return order
}

function returnDeliveredOrderItems(
  db: RetailDB,
  orderId: string,
  itemIds: string[],
  paymentMethodId: string,
): Order {
  const order = getOrder(db, orderId)
  if (order.status !== 'delivered') throw new ToolError('Non-delivered order cannot be returned')

  // 官方实现同样先解析 user / payment_method（不存在即报错），只是不参与后续计算 ——
  // 原先靠 `void user` / `void paymentMethod` 吞掉返回值，`void paymentMethod` 尤其荒谬：
  // 下一段就真的用到它，那行纯粹是死语句。
  getUser(db, order.user_id)
  const paymentMethod = getPaymentMethod(db, order.user_id, paymentMethodId)
  const originalPayment = order.payment_history[0]
  if (!originalPayment) {
    // 原先是 `order.payment_history[0]!.payment_method_id` —— 空数组时抛的是
    // "Cannot read properties of undefined (reading 'payment_method_id')"，指向的是实现细节
    throw new ToolError('Order has no payment history')
  }

  if (!isGiftCard(paymentMethod) && paymentMethodId !== originalPayment.payment_method_id) {
    throw new ToolError('Payment method should be the original payment method')
  }

  assertItemsInOrder(order, itemIds, () => 'Some item not found')

  order.status = 'return requested'
  order.return_items = [...itemIds].sort()
  order.return_payment_method_id = paymentMethodId
  return order
}

/**
 * 纯函数工具调度：judge 回放与 harness 执行的共享入口。
 * 只读工具对 DB 无影响，judge 回放时调用方可跳过（见 MUTATES_STATE_TOOLS）。
 */
export async function executeRetailTool(
  db: RetailDB,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult<unknown>> {
  try {
    switch (name) {
      case 'calculate':
        return { ok: true, output: String(round2(evalMathExpression(requireString(args, 'expression')))) }
      case 'cancel_pending_order':
        return {
          ok: true,
          output: cancelPendingOrder(db, requireString(args, 'order_id'), requireString(args, 'reason')),
        }
      case 'exchange_delivered_order_items':
        return {
          ok: true,
          output: exchangeDeliveredOrderItems(
            db,
            requireString(args, 'order_id'),
            stringList(args, 'item_ids'),
            stringList(args, 'new_item_ids'),
            requireString(args, 'payment_method_id'),
          ),
        }
      case 'find_user_id_by_name_zip': {
        const first = requireString(args, 'first_name').toLowerCase()
        const last = requireString(args, 'last_name').toLowerCase()
        const zip = requireString(args, 'zip')
        for (const [userId, user] of Object.entries(db.users)) {
          if (
            user.name.first_name.toLowerCase() === first &&
            user.name.last_name.toLowerCase() === last &&
            user.address.zip === zip
          ) {
            return { ok: true, output: userId }
          }
        }
        throw new ToolError('User not found')
      }
      case 'find_user_id_by_email': {
        const email = requireString(args, 'email').toLowerCase()
        for (const [userId, user] of Object.entries(db.users)) {
          if (user.email.toLowerCase() === email) return { ok: true, output: userId }
        }
        throw new ToolError('User not found')
      }
      case 'get_order_details':
        return { ok: true, output: getOrder(db, requireString(args, 'order_id')) }
      case 'get_product_details':
        return { ok: true, output: getProduct(db, requireString(args, 'product_id')) }
      case 'get_item_details':
        return { ok: true, output: getItem(db, requireString(args, 'item_id')) }
      case 'get_user_details':
        return { ok: true, output: getUser(db, requireString(args, 'user_id')) }
      case 'list_all_product_types': {
        const dict: Record<string, string> = {}
        for (const p of Object.values(db.products)) dict[p.name] = p.product_id
        const sorted = Object.fromEntries(Object.keys(dict).sort().map((k) => [k, dict[k]!]))
        return { ok: true, output: JSON.stringify(sorted) }
      }
      case 'modify_pending_order_address': {
        const order = getOrder(db, requireString(args, 'order_id'))
        if (!isModifiablePending(order)) throw new ToolError('Non-pending order cannot be modified')
        order.address = addressFromArgs(args)
        return { ok: true, output: order }
      }
      case 'modify_pending_order_items':
        return {
          ok: true,
          output: modifyPendingOrderItems(
            db,
            requireString(args, 'order_id'),
            stringList(args, 'item_ids'),
            stringList(args, 'new_item_ids'),
            requireString(args, 'payment_method_id'),
          ),
        }
      case 'modify_pending_order_payment':
        return {
          ok: true,
          output: modifyPendingOrderPayment(
            db,
            requireString(args, 'order_id'),
            requireString(args, 'payment_method_id'),
          ),
        }
      case 'modify_user_address': {
        const user = getUser(db, requireString(args, 'user_id'))
        user.address = addressFromArgs(args)
        return { ok: true, output: user }
      }
      case 'return_delivered_order_items':
        return {
          ok: true,
          output: returnDeliveredOrderItems(
            db,
            requireString(args, 'order_id'),
            stringList(args, 'item_ids'),
            requireString(args, 'payment_method_id'),
          ),
        }
      case 'transfer_to_human_agents':
        return { ok: true, output: 'Transfer successful' }
      default:
        return { ok: false, error: { message: `Unknown retail tool: ${name}` } }
    }
  } catch (err) {
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } }
  }
}

// ===== harness 工具包装（defineTool + fromJsonSchema）=====
// 描述与参数描述保持官方 docstring 英文原文。

type ToolSpecInit = {
  name: RetailToolName
  description: string
  schema: Record<string, { type: 'string' | 'number' | 'boolean' | 'array' | 'object'; description: string; items?: { type: 'string' } }>
  required: string[]
}

/** spec + 派生出的只读性（不手写，见 `TOOL_SPECS`） */
type ToolSpec = ToolSpecInit & { readOnly: boolean }

/** 官方 docstring 里反复出现的 id 提示，抽出复用（与原文一致） */
const ORDER_ID_DESC =
  "The order id, such as '#W0000000'. Be careful there is a '#' symbol at the beginning of the order id."
const PAYMENT_METHOD_ID_DESC =
  "The payment method id to pay or receive refund for the item price difference, such as 'gift_card_0000000' or 'credit_card_0000000'. These can be looked up from the user or order details."

const TOOL_SPEC_LITERALS: ToolSpecInit[] = [
  {
    name: 'calculate',
    description:
      'Calculate the result of a mathematical expression.',
    schema: {
      expression: {
        type: 'string',
        description:
          "The mathematical expression to calculate, such as '2 + 2'. The expression can contain numbers, operators (+, -, *, /), parentheses, and spaces.",
      },
    },
    required: ['expression'],
  },
  {
    name: 'cancel_pending_order',
    description:
      "Cancel a pending order. If the order is already processed or delivered, it cannot be cancelled. The agent needs to explain the cancellation detail and ask for explicit user confirmation (yes/no) to proceed. If the user confirms, the order status will be changed to 'cancelled' and the payment will be refunded. The refund will be added to the user's gift card balance immediately if the payment was made using a gift card, otherwise the refund would take 5-7 business days to process. The function returns the order details after the cancellation.",
    schema: {
      order_id: { type: 'string', description: ORDER_ID_DESC },
      reason: {
        type: 'string',
        description: "The reason for cancellation, which should be either 'no longer needed' or 'ordered by mistake'.",
      },
    },
    required: ['order_id', 'reason'],
  },
  {
    name: 'exchange_delivered_order_items',
    description:
      'Exchange items in a delivered order to new items of the same product type. For a delivered order, return or exchange can be only done once by the agent. The agent needs to explain the exchange detail and ask for explicit user confirmation (yes/no) to proceed.',
    schema: {
      order_id: { type: 'string', description: ORDER_ID_DESC },
      item_ids: {
        type: 'array',
        items: { type: 'string' },
        description: "The item ids to be exchanged, each such as '1008292230'. There could be duplicate items in the list.",
      },
      new_item_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          "The item ids to be exchanged for, each such as '1008292230'. There could be duplicate items in the list. Each new item id should match the item id in the same position and be of the same product.",
      },
      payment_method_id: { type: 'string', description: PAYMENT_METHOD_ID_DESC },
    },
    required: ['order_id', 'item_ids', 'new_item_ids', 'payment_method_id'],
  },
  {
    name: 'find_user_id_by_name_zip',
    description:
      'Find user id by first name, last name, and zip code. If the user is not found, the function will return an error message. By default, find user id by email, and only call this function if the user is not found by email or cannot remember email.',
    schema: {
      first_name: { type: 'string', description: "The first name of the customer, such as 'John'." },
      last_name: { type: 'string', description: "The last name of the customer, such as 'Doe'." },
      zip: { type: 'string', description: "The zip code of the customer, such as '12345'." },
    },
    required: ['first_name', 'last_name', 'zip'],
  },
  {
    name: 'find_user_id_by_email',
    description:
      'Find user id by email. If the user is not found, the function will return an error message.',
    schema: {
      email: { type: 'string', description: "The email of the user, such as 'something@example.com'." },
    },
    required: ['email'],
  },
  {
    name: 'get_order_details',
    description: 'Get the status and details of an order.',
    schema: { order_id: { type: 'string', description: ORDER_ID_DESC } },
    required: ['order_id'],
  },
  {
    name: 'get_product_details',
    description: 'Get the inventory details of a product.',
    schema: {
      product_id: {
        type: 'string',
        description: "The product id, such as '6086499569'. Be careful the product id is different from the item id.",
      },
    },
    required: ['product_id'],
  },
  {
    name: 'get_item_details',
    description: 'Get the inventory details of an item.',
    schema: {
      item_id: {
        type: 'string',
        description: "The item id, such as '6086499569'. Be careful the item id is different from the product id.",
      },
    },
    required: ['item_id'],
  },
  {
    name: 'get_user_details',
    description: 'Get the details of a user, including their orders.',
    schema: { user_id: { type: 'string', description: "The user id, such as 'sara_doe_496'." } },
    required: ['user_id'],
  },
  {
    name: 'list_all_product_types',
    description:
      'List the name and product id of all product types. Each product type has a variety of different items with unique item ids and options. There are only 50 product types in the store.',
    schema: {},
    required: [],
  },
  {
    name: 'modify_pending_order_address',
    description:
      'Modify the shipping address of a pending order. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.',
    schema: {
      order_id: { type: 'string', description: ORDER_ID_DESC },
      address1: { type: 'string', description: "The first line of the address, such as '123 Main St'." },
      address2: { type: 'string', description: "The second line of the address, such as 'Apt 1' or ''." },
      city: { type: 'string', description: "The city, such as 'San Francisco'." },
      state: { type: 'string', description: "The state, such as 'CA'." },
      country: { type: 'string', description: "The country, such as 'USA'." },
      zip: { type: 'string', description: "The zip code, such as '12345'." },
    },
    required: ['order_id', 'address1', 'address2', 'city', 'state', 'country', 'zip'],
  },
  {
    name: 'modify_pending_order_items',
    description:
      'Modify items in a pending order to new items of the same product type. For a pending order, this function can only be called once. The agent needs to explain the exchange detail and ask for explicit user confirmation (yes/no) to proceed.',
    schema: {
      order_id: { type: 'string', description: ORDER_ID_DESC },
      item_ids: {
        type: 'array',
        items: { type: 'string' },
        description: "The item ids to be modified, each such as '1008292230'. There could be duplicate items in the list.",
      },
      new_item_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          "The item ids to be modified for, each such as '1008292230'. There could be duplicate items in the list. Each new item id should match the item id in the same position and be of the same product.",
      },
      payment_method_id: { type: 'string', description: PAYMENT_METHOD_ID_DESC },
    },
    required: ['order_id', 'item_ids', 'new_item_ids', 'payment_method_id'],
  },
  {
    name: 'modify_pending_order_payment',
    description:
      'Modify the payment method of a pending order. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.',
    schema: {
      order_id: { type: 'string', description: ORDER_ID_DESC },
      payment_method_id: { type: 'string', description: PAYMENT_METHOD_ID_DESC },
    },
    required: ['order_id', 'payment_method_id'],
  },
  {
    name: 'modify_user_address',
    description:
      'Modify the default address of a user. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.',
    schema: {
      user_id: { type: 'string', description: "The user id, such as 'sara_doe_496'." },
      address1: { type: 'string', description: "The first line of the address, such as '123 Main St'." },
      address2: { type: 'string', description: "The second line of the address, such as 'Apt 1' or ''." },
      city: { type: 'string', description: "The city, such as 'San Francisco'." },
      state: { type: 'string', description: "The state, such as 'CA'." },
      country: { type: 'string', description: "The country, such as 'USA'." },
      zip: { type: 'string', description: "The zip code, such as '12345'." },
    },
    required: ['user_id', 'address1', 'address2', 'city', 'state', 'country', 'zip'],
  },
  {
    name: 'return_delivered_order_items',
    description:
      "Return some items of a delivered order. The order status will be changed to 'return requested'. The agent needs to explain the return detail and ask for explicit user confirmation (yes/no) to proceed. The user will receive follow-up email for how and where to return the item.",
    schema: {
      order_id: { type: 'string', description: ORDER_ID_DESC },
      item_ids: {
        type: 'array',
        items: { type: 'string' },
        description: "The item ids to be returned, each such as '1008292230'. There could be duplicate items in the list.",
      },
      payment_method_id: { type: 'string', description: PAYMENT_METHOD_ID_DESC },
    },
    required: ['order_id', 'item_ids', 'payment_method_id'],
  },
  {
    name: 'transfer_to_human_agents',
    description:
      'Transfer the user to a human agent, with a summary of the user\'s issue. Only transfer if - the user explicitly asks for a human agent - given the policy and the available tools, you cannot solve the user\'s issue.',
    schema: {
      summary: { type: 'string', description: 'A summary of the user\'s issue.' },
    },
    required: ['summary'],
  },
]

/**
 * 只读性**唯一来源**是 `MUTATES_STATE_TOOLS`。
 *
 * 原先 16 条 spec 各手写一遍 `readOnly`，与那个集合构成两个口径；漂移不会报错，
 * 而是让 `buildRetailHarnessTools` 把写工具标成只读（`isReadOnly` / `isConcurrencySafe`
 * 都从它派生）——judge 回放会跳过写工具、并发调度会把改 DB 的工具当安全并发执行。
 * 派生后两者在结构上不可能不一致。
 */
const TOOL_SPECS: ToolSpec[] = TOOL_SPEC_LITERALS.map((spec) => ({
  ...spec,
  readOnly: !MUTATES_STATE_TOOLS.has(spec.name),
}))

/** 构造 harness 工具集（闭包持有 DB，工具执行即操作该 DB 实例） */
export function buildRetailHarnessTools(db: RetailDB): Tool[] {
  return TOOL_SPECS.map((spec) =>
    defineTool({
      id: spec.name,
      description: spec.description,
      inputSchema: fromJsonSchema<Record<string, unknown>>({
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(spec.schema).map(([k, v]) => [
            k,
            v.type === 'array' ? { type: 'array', items: v.items, description: v.description } : { type: v.type, description: v.description },
          ]),
        ),
        required: spec.required,
      }),
      isReadOnly: () => spec.readOnly,
      isConcurrencySafe: () => spec.readOnly,
      async call(input: Record<string, unknown>) {
        return executeRetailTool(db, spec.name, input)
      },
    }),
  )
}

/**
 * retail 域插件：把 16 个域工具经 `core.tool.pool.assemble` 注入 harness 工具池。
 * DB 由调用方持有（runner 传任务级深拷贝，judge 传回放专用拷贝）。
 */
export function createRetailPlugin(db: RetailDB): AgentPlugin {
  const tools = buildRetailHarnessTools(db)
  return {
    id: 'tau-retail',
    version: '0.1.0',
    name: 'tau-retail',
    async install(): Promise<Hooks> {
      return {
        'core.tool.pool.assemble': (_input, pool) => {
          pool.addAll(tools)
        },
      } as Hooks
    },
  }
}
