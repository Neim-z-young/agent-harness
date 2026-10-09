import { describe, expect, it } from 'bun:test'
import { loadRetailDb, loadRetailTasks } from '../data'
import {
  evalMathExpression,
  executeRetailTool,
  buildRetailHarnessTools,
  MUTATES_STATE_TOOLS,
  RETAIL_TOOL_NAMES,
  round2,
} from './tools'

// task 0 的已知数据（Yusuf Rossi / order #W2378156 换货场景）
const TASK0_ORDER = '#W2378156'

describe('evalMathExpression', () => {
  it('四则运算与括号', () => {
    expect(evalMathExpression('2 + 2')).toBe(4)
    expect(evalMathExpression('2 + 3 * 4')).toBe(14)
    expect(evalMathExpression('(2 + 3) * 4')).toBe(20)
    expect(evalMathExpression('10 / 4')).toBe(2.5)
    expect(evalMathExpression('100 - 2.5 * 3')).toBe(92.5)
  })
  it('非法字符与括号不匹配', () => {
    expect(() => evalMathExpression('2 ** 8')).toThrow()
    expect(() => evalMathExpression('import os')).toThrow()
    expect(() => evalMathExpression('(1 + 2')).toThrow()
    expect(() => evalMathExpression('1 + 2)')).toThrow()
  })
  it('round2', () => {
    expect(round2(2.675)).toBe(2.68)
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(-1.005)).toBe(-1)
  })
})

describe('retail 工具（真实 db 数据）', () => {
  it('find_user_id_by_name_zip：task 0 场景', async () => {
    const db = loadRetailDb()
    const r = await executeRetailTool(db, 'find_user_id_by_name_zip', {
      first_name: 'Yusuf',
      last_name: 'Rossi',
      zip: '19122',
    })
    expect(r.ok).toBe(true)
    expect(typeof r.output).toBe('string')
    // 该用户应有订单 #W2378156
    const userId = r.output as string
    expect(db.users[userId]!.orders).toContain(TASK0_ORDER)
  })

  it('find_user_id_by_name_zip：查无此人', async () => {
    const db = loadRetailDb()
    const r = await executeRetailTool(db, 'find_user_id_by_name_zip', {
      first_name: 'Nobody',
      last_name: 'Here',
      zip: '00000',
    })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toBe('User not found')
  })

  it('get_order_details：task 0 订单为 delivered', async () => {
    const db = loadRetailDb()
    const r = await executeRetailTool(db, 'get_order_details', { order_id: TASK0_ORDER })
    expect(r.ok).toBe(true)
    expect((r.output as { status: string }).status).toBe('delivered')
  })

  it('exchange_delivered_order_items：golden 参数成功换货', async () => {
    const db = loadRetailDb()
    const task0 = loadRetailTasks().find((t) => t.id === '0')!
    const exchange = task0.evaluation_criteria!.actions!.find((a) => a.name === 'exchange_delivered_order_items')!
    const r = await executeRetailTool(db, 'exchange_delivered_order_items', exchange.arguments)
    expect(r.ok).toBe(true)
    const order = r.output as { status: string; exchange_items: string[]; exchange_new_items: string[] }
    expect(order.status).toBe('exchange requested')
    expect(order.exchange_items).toEqual([...(exchange.arguments.item_ids as string[])].sort())
  })

  it('exchange：非 delivered 订单被拒', async () => {
    const db = loadRetailDb()
    // 找一个 pending 订单
    const pending = Object.values(db.orders).find((o) => o.status === 'pending')!
    const r = await executeRetailTool(db, 'exchange_delivered_order_items', {
      order_id: pending.order_id,
      item_ids: [pending.items[0]!.item_id],
      new_item_ids: ['whatever'],
      payment_method_id: 'whatever',
    })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toBe('Non-delivered order cannot be exchanged')
  })

  it('cancel_pending_order：gift card 即时退款入余额', async () => {
    const db = loadRetailDb()
    // 找 pending + gift card 支付的订单
    const order = Object.values(db.orders).find(
      (o) =>
        o.status === 'pending' &&
        o.payment_history.length > 0 &&
        db.users[o.user_id]!.payment_methods[o.payment_history[0]!.payment_method_id]?.source === 'gift_card',
    )
    expect(order).toBeDefined()
    const pmId = order!.payment_history[0]!.payment_method_id
    const balanceBefore = (db.users[order!.user_id]!.payment_methods[pmId] as { balance: number }).balance
    const amount = order!.payment_history[0]!.amount

    const r = await executeRetailTool(db, 'cancel_pending_order', {
      order_id: order!.order_id,
      reason: 'no longer needed',
    })
    expect(r.ok).toBe(true)
    expect((r.output as { status: string }).status).toBe('cancelled')
    const balanceAfter = (db.users[order!.user_id]!.payment_methods[pmId] as { balance: number }).balance
    expect(balanceAfter).toBe(round2(balanceBefore + amount))
  })

  it('cancel：非法 reason 被拒且 DB 不变', async () => {
    const db = loadRetailDb()
    const pending = Object.values(db.orders).find((o) => o.status === 'pending')!
    const before = JSON.stringify(db.orders[pending.order_id])
    const r = await executeRetailTool(db, 'cancel_pending_order', {
      order_id: pending.order_id,
      reason: 'changed my mind',
    })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(db.orders[pending.order_id])).toBe(before)
  })

  it('modify_pending_order_items：官方「最后 variant」行为（疑似 bug 按原样保留）', async () => {
    const db = loadRetailDb()
    // task 0 场景是 exchange，这里手工构造：找 pending 订单里两个同商品不同 item 的情况罕见，
    // 用单 item 修改验证主路径即可
    const pending = Object.values(db.orders).find((o) => o.status === 'pending' && o.items.length > 0)!
    const item = pending.items[0]!
    // 找同商品的另一可用 variant
    const product = db.products[item.product_id]!
    const newVariant = Object.values(product.variants).find((v) => v.available && v.item_id !== item.item_id)
    if (!newVariant) return // 数据不满足则跳过
    const pm = Object.values(db.users[pending.user_id]!.payment_methods)[0]!
    const r = await executeRetailTool(db, 'modify_pending_order_items', {
      order_id: pending.order_id,
      item_ids: [item.item_id],
      new_item_ids: [newVariant.item_id],
      payment_method_id: pm.id,
    })
    expect(r.ok).toBe(true)
    const order = r.output as { status: string; items: { item_id: string; price: number }[] }
    expect(order.status).toBe('pending (item modified)')
    expect(order.items.find((it) => it.item_id === newVariant.item_id)?.price).toBe(newVariant.price)
  })

  it('list_all_product_types：50 个商品', async () => {
    const db = loadRetailDb()
    const r = await executeRetailTool(db, 'list_all_product_types', {})
    expect(r.ok).toBe(true)
    const parsed = JSON.parse(r.output as string) as Record<string, string>
    expect(Object.keys(parsed).length).toBe(50)
  })
})

describe('工具集完整性', () => {
  it('16 个工具全部可构造（schema 合法）', () => {
    const db = loadRetailDb()
    const tools = buildRetailHarnessTools(db)
    expect(tools).toHaveLength(16)
    expect(tools.map((t) => t.id).sort()).toEqual([...RETAIL_TOOL_NAMES].sort())
  })

  it('mutates_state 集合 = 官方 7 个写工具', () => {
    expect([...MUTATES_STATE_TOOLS].sort()).toEqual([
      'cancel_pending_order',
      'exchange_delivered_order_items',
      'modify_pending_order_address',
      'modify_pending_order_items',
      'modify_pending_order_payment',
      'modify_user_address',
      'return_delivered_order_items',
    ])
  })

  it('所有 golden actions 的工具名都在工具集内（tasks.json 覆盖校验）', () => {
    const tasks = loadRetailTasks()
    const known = new Set<string>(RETAIL_TOOL_NAMES)
    for (const t of tasks) {
      for (const a of t.evaluation_criteria?.actions ?? []) {
        if (!known.has(a.name)) throw new Error(`task ${t.id} 引用未知工具: ${a.name}`)
      }
    }
  })
})
