import { describe, expect, it } from 'bun:test'
import { loadRetailDb, loadRetailTasks } from '../data'
import type { RetailDB, UserAddress } from '../types'
import {
  evalMathExpression,
  executeRetailTool,
  buildRetailHarnessTools,
  createRetailPlugin,
  MUTATES_STATE_TOOLS,
  RETAIL_TOOL_NAMES,
  round2,
} from './tools'

// task 0 的已知数据（Yusuf Rossi / order #W2378156 换货场景）
const TASK0_ORDER = '#W2378156'

const ADDR: UserAddress = {
  address1: '1 Main St',
  address2: '',
  city: 'Springfield',
  state: 'CA',
  country: 'USA',
  zip: '11111',
}

/**
 * 合成 DB：真实数据里「同一订单多件商品」「delivered 但无支付记录」「第二张信用卡」
 * 这些边界很难恰好找到，靠 `if (!x) return` 跳过就等于没有用例。
 */
function makeDb(): RetailDB {
  const item = (productId: string, itemId: string, price: number) => ({
    name: productId,
    product_id: productId,
    item_id: itemId,
    price,
    options: {},
  })
  return {
    products: {
      p1: {
        name: 'Widget',
        product_id: 'p1',
        variants: {
          p1v1: { item_id: 'p1v1', options: {}, available: true, price: 10 },
          p1v2: { item_id: 'p1v2', options: {}, available: true, price: 12 },
          p1v3: { item_id: 'p1v3', options: {}, available: true, price: 30 },
          p1sold: { item_id: 'p1sold', options: {}, available: false, price: 9 },
        },
      },
      p2: {
        name: 'Gadget',
        product_id: 'p2',
        variants: {
          p2v1: { item_id: 'p2v1', options: {}, available: true, price: 20 },
          p2v2: { item_id: 'p2v2', options: {}, available: true, price: 25 },
        },
      },
    },
    users: {
      u1: {
        user_id: 'u1',
        name: { first_name: 'Ada', last_name: 'Lovelace' },
        address: ADDR,
        email: 'Ada@Example.com',
        payment_methods: {
          gc1: { source: 'gift_card', id: 'gc1', balance: 100 },
          gc2: { source: 'gift_card', id: 'gc2', balance: 5 },
          cc1: { source: 'credit_card', id: 'cc1', brand: 'visa', last_four: '4242' },
          cc2: { source: 'credit_card', id: 'cc2', brand: 'mc', last_four: '1111' },
        },
        orders: ['#W1', '#W2', '#W3', '#W4', '#W6'],
      },
    },
    orders: {
      // pending，单件，gift card 已付
      '#W1': {
        order_id: '#W1',
        user_id: 'u1',
        address: ADDR,
        items: [item('p1', 'p1v1', 10)],
        status: 'pending',
        fulfillments: [],
        payment_history: [{ transaction_type: 'payment', amount: 10, payment_method_id: 'gc1' }],
      },
      // delivered，单件，信用卡已付
      '#W2': {
        order_id: '#W2',
        user_id: 'u1',
        address: ADDR,
        items: [item('p1', 'p1v2', 12)],
        status: 'delivered',
        fulfillments: [],
        payment_history: [{ transaction_type: 'payment', amount: 12, payment_method_id: 'cc1' }],
      },
      // delivered 但支付记录为空（真实数据不会出现，用来钉住「别抛 TypeError」）
      '#W3': {
        order_id: '#W3',
        user_id: 'u1',
        address: ADDR,
        items: [item('p2', 'p2v1', 20)],
        status: 'delivered',
        fulfillments: [],
        payment_history: [],
      },
      // pending 但已有两条支付记录（改支付方式的前置条件不满足）
      '#W4': {
        order_id: '#W4',
        user_id: 'u1',
        address: ADDR,
        items: [item('p1', 'p1v1', 10)],
        status: 'pending',
        fulfillments: [],
        payment_history: [
          { transaction_type: 'payment', amount: 10, payment_method_id: 'gc1' },
          { transaction_type: 'refund', amount: 10, payment_method_id: 'gc1' },
        ],
      },
      // pending，两件不同商品（多 item 改单 + 官方「最后 variant」行为）
      '#W6': {
        order_id: '#W6',
        user_id: 'u1',
        address: ADDR,
        items: [item('p1', 'p1v1', 10), item('p2', 'p2v1', 20)],
        status: 'pending',
        fulfillments: [],
        payment_history: [{ transaction_type: 'payment', amount: 30, payment_method_id: 'gc1' }],
      },
    },
  }
}

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

describe('参数缺失的可操作性（requireString / stringList）', () => {
  it('缺 order_id 时报「参数缺失」而不是「订单不存在」', async () => {
    const db = makeDb()
    const r = await executeRetailTool(db, 'get_order_details', {})
    expect(r.ok).toBe(false)
    // 原实现 `String(undefined)` 得到字面量 "undefined" ⇒ getOrder 报 'Order not found'
    expect(r.error?.message).toBe('Missing or invalid argument: order_id')
  })

  it('item_ids 缺省按空数组处理，类型不符才报错', async () => {
    const db = makeDb()
    const missing = await executeRetailTool(db, 'return_delivered_order_items', {
      order_id: '#W2',
      payment_method_id: 'cc1',
    })
    // 空列表通过数量校验，直接落到状态变更
    expect(missing.ok).toBe(true)

    const bad = await executeRetailTool(makeDb(), 'return_delivered_order_items', {
      order_id: '#W2',
      item_ids: 'p1v2',
      payment_method_id: 'cc1',
    })
    expect(bad.ok).toBe(false)
    expect(bad.error?.message).toBe('Missing or invalid argument: item_ids')
  })
})

describe('retail 工具（合成 DB：此前零覆盖的分支）', () => {
  it('find_user_id_by_email：大小写不敏感', async () => {
    const ok = await executeRetailTool(makeDb(), 'find_user_id_by_email', { email: 'ada@example.COM' })
    expect(ok.ok).toBe(true)
    expect(ok.output).toBe('u1')

    const miss = await executeRetailTool(makeDb(), 'find_user_id_by_email', { email: 'nobody@example.com' })
    expect(miss.ok).toBe(false)
    expect(miss.error?.message).toBe('User not found')
  })

  it('三个 details 工具：命中与缺失文案', async () => {
    const db = makeDb()
    const product = await executeRetailTool(db, 'get_product_details', { product_id: 'p1' })
    expect(product.ok).toBe(true)
    expect((product.output as { name: string }).name).toBe('Widget')

    const variant = await executeRetailTool(db, 'get_item_details', { item_id: 'p2v2' })
    expect(variant.ok).toBe(true)
    expect((variant.output as { item_id: string }).item_id).toBe('p2v2')

    const user = await executeRetailTool(db, 'get_user_details', { user_id: 'u1' })
    expect(user.ok).toBe(true)

    expect((await executeRetailTool(db, 'get_product_details', { product_id: 'nope' })).error?.message).toBe(
      'Product not found',
    )
    expect((await executeRetailTool(db, 'get_item_details', { item_id: 'nope' })).error?.message).toBe(
      'Item not found',
    )
    expect((await executeRetailTool(db, 'get_user_details', { user_id: 'nope' })).error?.message).toBe(
      'User not found',
    )
  })

  it('list_all_product_types：按商品名升序', async () => {
    const r = await executeRetailTool(makeDb(), 'list_all_product_types', {})
    expect(r.ok).toBe(true)
    // Gadget < Widget
    expect(Object.keys(JSON.parse(r.output as string) as Record<string, string>)).toEqual(['Gadget', 'Widget'])
  })

  it('modify_pending_order_address：整块替换地址', async () => {
    const db = makeDb()
    const r = await executeRetailTool(db, 'modify_pending_order_address', {
      order_id: '#W1',
      address1: '2 Oak Ave',
      address2: 'Apt 3',
      city: 'Shelbyville',
      state: 'NY',
      country: 'USA',
      zip: '22222',
    })
    expect(r.ok).toBe(true)
    expect(db.orders['#W1']!.address).toEqual({
      address1: '2 Oak Ave',
      address2: 'Apt 3',
      city: 'Shelbyville',
      state: 'NY',
      country: 'USA',
      zip: '22222',
    })
  })

  it('modify_pending_order_address：非 pending 被拒，DB 不变', async () => {
    const db = makeDb()
    const before = JSON.stringify(db.orders['#W2'])
    const r = await executeRetailTool(db, 'modify_pending_order_address', {
      order_id: '#W2',
      address1: 'x',
      address2: '',
      city: 'x',
      state: 'x',
      country: 'x',
      zip: 'x',
    })
    expect(r.error?.message).toBe('Non-pending order cannot be modified')
    expect(JSON.stringify(db.orders['#W2'])).toBe(before)
  })

  it('modify_user_address：改默认地址', async () => {
    const db = makeDb()
    const r = await executeRetailTool(db, 'modify_user_address', {
      user_id: 'u1',
      address1: '9 Elm St',
      address2: '',
      city: 'Ogdenville',
      state: 'UT',
      country: 'USA',
      zip: '33333',
    })
    expect(r.ok).toBe(true)
    expect(db.users['u1']!.address.city).toBe('Ogdenville')
    // 已有订单地址不受影响（官方语义：只改用户默认地址）
    expect(db.orders['#W1']!.address.city).toBe('Springfield')
  })

  it('modify_pending_order_payment：换卡后旧 gift card 余额退回', async () => {
    const db = makeDb()
    const r = await executeRetailTool(db, 'modify_pending_order_payment', {
      order_id: '#W1',
      payment_method_id: 'cc1',
    })
    expect(r.ok).toBe(true)
    const history = db.orders['#W1']!.payment_history
    expect(history.map((p) => `${p.transaction_type}:${p.payment_method_id}`)).toEqual([
      'payment:gc1',
      'payment:cc1',
      'refund:gc1',
    ])
    expect((db.users['u1']!.payment_methods['gc1'] as { balance: number }).balance).toBe(110)
  })

  it('modify_pending_order_payment：同卡 / 多条支付记录被拒', async () => {
    const same = await executeRetailTool(makeDb(), 'modify_pending_order_payment', {
      order_id: '#W1',
      payment_method_id: 'gc1',
    })
    expect(same.error?.message).toBe('The new payment method should be different from the current one')

    const multi = await executeRetailTool(makeDb(), 'modify_pending_order_payment', {
      order_id: '#W4',
      payment_method_id: 'cc1',
    })
    expect(multi.error?.message).toBe('There should be exactly one payment for a pending order')
  })

  it('return_delivered_order_items：原支付方式成功；非原支付方式被拒', async () => {
    const okReq = await executeRetailTool(makeDb(), 'return_delivered_order_items', {
      order_id: '#W2',
      item_ids: ['p1v2'],
      payment_method_id: 'cc1',
    })
    expect(okReq.ok).toBe(true)
    expect((okReq.output as { status: string }).status).toBe('return requested')

    const wrong = await executeRetailTool(makeDb(), 'return_delivered_order_items', {
      order_id: '#W2',
      item_ids: ['p1v2'],
      payment_method_id: 'cc2',
    })
    expect(wrong.error?.message).toBe('Payment method should be the original payment method')
  })

  it('return：支付记录为空时报干净错误，而不是 TypeError', async () => {
    const r = await executeRetailTool(makeDb(), 'return_delivered_order_items', {
      order_id: '#W3',
      item_ids: ['p2v1'],
      payment_method_id: 'cc1',
    })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toBe('Order has no payment history')
  })

  it('exchange：四个前置校验各自的官方文案', async () => {
    const db = makeDb()
    expect(
      (
        await executeRetailTool(db, 'exchange_delivered_order_items', {
          order_id: '#W2',
          item_ids: ['p1v2'],
          new_item_ids: [],
          payment_method_id: 'gc1',
        })
      ).error?.message,
    ).toBe('The number of items to be exchanged should match.')

    expect(
      (
        await executeRetailTool(db, 'exchange_delivered_order_items', {
          order_id: '#W2',
          item_ids: ['p2v1'],
          new_item_ids: ['p1v2'],
          payment_method_id: 'gc1',
        })
      ).error?.message,
    ).toBe('Number of p2v1 not found.')

    expect(
      (
        await executeRetailTool(db, 'exchange_delivered_order_items', {
          order_id: '#W2',
          item_ids: ['p1v2'],
          new_item_ids: ['p1sold'],
          payment_method_id: 'gc1',
        })
      ).error?.message,
    ).toBe('New item p1sold not found or available')
  })

  it('exchange：gift card 余额不足以补差价被拒', async () => {
    const db = makeDb()
    const r = await executeRetailTool(db, 'exchange_delivered_order_items', {
      order_id: '#W2',
      item_ids: ['p1v2'],
      new_item_ids: ['p1v3'],
      payment_method_id: 'gc2',
    })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toBe('Insufficient gift card balance to pay for the price difference')
    expect(db.orders['#W2']!.status).toBe('delivered')
  })

  it('modify_pending_order_items：新旧 item 相同 / 数量不匹配被拒', async () => {
    const db = makeDb()
    expect(
      (
        await executeRetailTool(db, 'modify_pending_order_items', {
          order_id: '#W6',
          item_ids: ['p1v1'],
          new_item_ids: ['p1v1'],
          payment_method_id: 'gc1',
        })
      ).error?.message,
    ).toBe('The new item id should be different from the old item id')

    expect(
      (
        await executeRetailTool(db, 'modify_pending_order_items', {
          order_id: '#W6',
          item_ids: ['p1v1'],
          new_item_ids: [],
          payment_method_id: 'gc1',
        })
      ).error?.message,
    ).toBe('The number of items to be exchanged should match')
  })

  it('modify_pending_order_items：多件时沿用官方「最后 variant」行为（按原样保留）', async () => {
    const db = makeDb()
    const r = await executeRetailTool(db, 'modify_pending_order_items', {
      order_id: '#W6',
      item_ids: ['p1v1', 'p2v1'],
      new_item_ids: ['p1v2', 'p2v2'],
      payment_method_id: 'gc1',
    })
    expect(r.ok).toBe(true)
    const order = db.orders['#W6']!
    expect(order.status).toBe('pending (item modified)')
    expect(order.items.map((it) => it.item_id)).toEqual(['p1v2', 'p2v2'])
    // 两件的 price 都是**最后**一个 variant 的价（p2v2=25），这正是官方实现的行为
    expect(order.items.map((it) => it.price)).toEqual([25, 25])
  })

  it('「pending (item modified)」仍可改地址但不可取消（两处 pending 判据故意不同）', async () => {
    const db = makeDb()
    db.orders['#W1']!.status = 'pending (item modified)'
    const addr = await executeRetailTool(db, 'modify_pending_order_address', {
      order_id: '#W1',
      address1: '3 Pine Rd',
      address2: '',
      city: 'c',
      state: 's',
      country: 'USA',
      zip: '44444',
    })
    // isModifiablePending 用 includes('pending') ⇒ 放行
    expect(addr.ok).toBe(true)
    // cancelPendingOrder 用严格的 !== 'pending' ⇒ 拒绝
    const cancel = await executeRetailTool(db, 'cancel_pending_order', {
      order_id: '#W1',
      reason: 'no longer needed',
    })
    expect(cancel.error?.message).toBe('Non-pending order cannot be cancelled')
  })

  it('calculate：除零报错而不是把 Infinity 交给模型', async () => {
    const r = await executeRetailTool(makeDb(), 'calculate', { expression: '1 / 0' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toBe('Division by zero')
  })

  it('未知工具与 transfer_to_human_agents', async () => {
    expect((await executeRetailTool(makeDb(), 'nope', {})).error?.message).toBe('Unknown retail tool: nope')
    const transfer = await executeRetailTool(makeDb(), 'transfer_to_human_agents', { summary: 'x' })
    expect(transfer.ok).toBe(true)
    expect(transfer.output).toBe('Transfer successful')
  })
})

describe('只读性派生（readOnly 唯一来源 = MUTATES_STATE_TOOLS）', () => {
  it('写工具 isReadOnly/open 一致为 false，其余为 true', () => {
    const tools = buildRetailHarnessTools(makeDb())
    for (const tool of tools) {
      const expected = !MUTATES_STATE_TOOLS.has(tool.id)
      expect(tool.isReadOnly?.()).toBe(expected)
      expect(tool.isConcurrencySafe?.()).toBe(expected)
    }
  })

  it('两处口径不可能漂移：集合里的每个名字都确实是工具', () => {
    const ids = new Set(buildRetailHarnessTools(makeDb()).map((t) => t.id))
    for (const name of MUTATES_STATE_TOOLS) expect(ids.has(name)).toBe(true)
  })
})

describe('createRetailPlugin', () => {
  it('install 通过 core.tool.pool.assemble 注入 16 个工具', async () => {
    const plugin = createRetailPlugin(makeDb())
    expect(plugin.id).toBe('tau-retail')
    const hooks = (await plugin.install!({} as never)) as unknown as Record<string, unknown>
    const assemble = hooks['core.tool.pool.assemble'] as (
      input: unknown,
      pool: { addAll: (tools: unknown[]) => void },
    ) => void
    const added: unknown[] = []
    assemble({}, { addAll: (tools) => added.push(...tools) })
    expect(added).toHaveLength(RETAIL_TOOL_NAMES.length)
  })
})
