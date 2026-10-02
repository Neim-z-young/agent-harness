/**
 * 面板 view-model 用例：归一 / 排序 / 降级 / 动作规划。
 *
 * 全部是纯函数 —— 面板的数据来自跨进程回包（形状不可信），这些分支正是最容易
 * 埋雷的地方（脏数据 ⇒ 面板整块空白，而没人知道为什么）。
 */

import { describe, expect, it } from 'bun:test'
import {
  MAX_REF_ITEMS,
  buildPanelState,
  describePanelAction,
  formatTimestamp,
  humanizeTaskState,
  normalizeEndpoint,
  normalizeNotices,
  normalizeRefs,
  normalizeSessions,
  normalizeStats,
  normalizeTasks,
  planPanelAction,
} from './state'

const HS = {
  v: 1,
  pid: 4242,
  port: 65184,
  protocolVersion: '1.0',
  rpcUrl: 'http://127.0.0.1:65184/a2a',
  cardUrl: 'http://127.0.0.1:65184/.well-known/agent-card.json',
  controlUrl: 'http://127.0.0.1:65184/harness/rpc',
  auth: 'anonymous',
  permissionMode: 'ask',
  cwd: '/repo',
}

// ========================================================================
// 端点
// ========================================================================

describe('normalizeEndpoint', () => {
  it('握手对象 → 面板端点', () => {
    const e = normalizeEndpoint(HS)
    expect(e?.pid).toBe(4242)
    expect(e?.port).toBe(65184)
    expect(e?.permissionMode).toBe('ask')
  })

  it('缺 port ⇒ undefined（拿不到端点就是没连上，不该猜）', () => {
    expect(normalizeEndpoint({ pid: 1 })).toBeUndefined()
    expect(normalizeEndpoint(undefined)).toBeUndefined()
    expect(normalizeEndpoint('x')).toBeUndefined()
  })
})

// ========================================================================
// 会话
// ========================================================================

describe('normalizeSessions', () => {
  it('排序：当前 → 项目指针 → 本目录 → 其余（store 的自然顺序会把当前埋在中间）', () => {
    const s = normalizeSessions({
      cwd: '/repo',
      current: 'c',
      sessions: [
        { id: 'a', title: 'A', messageCount: 3, updatedAt: 1, isCwd: true },
        { id: 'b', title: 'B', messageCount: 1, updatedAt: 2 },
        { id: 'c', title: 'C', messageCount: 5, updatedAt: 3, isCurrent: true },
        { id: 'd', title: 'D', messageCount: 2, updatedAt: 4, isPointer: true, isCwd: true },
      ],
    })
    expect(s.items.map((x) => x.id)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('无标题会话用 id 短码兜底（不显示 null）', () => {
    const s = normalizeSessions({
      cwd: '/repo',
      current: null,
      sessions: [{ id: 'abcdefghijklmnop', title: null, messageCount: 0 }],
    })
    expect(s.items[0]?.title).toContain('无标题')
    expect(s.items[0]?.title).not.toContain('abcdefghijklmnop')
  })

  it('徽章：当前 / 项目指针 / 本目录 各自成条', () => {
    const s = normalizeSessions({
      cwd: '/repo',
      current: 'x',
      sessions: [{ id: 'x', title: 'X', isCurrent: true, isPointer: true, isCwd: true }],
    })
    expect(s.items[0]?.badges).toEqual(['当前', '项目指针', '本目录'])
  })

  it('脏数据：非数组 / 元素缺 id ⇒ 跳过而不是崩', () => {
    expect(normalizeSessions({ sessions: 'nope' }).items).toEqual([])
    expect(normalizeSessions({ sessions: [null, { title: '无 id' }, 3] }).items).toEqual([])
    expect(normalizeSessions(undefined).items).toEqual([])
  })

  it('时间格式定长（前端不再二次格式化）', () => {
    expect(formatTimestamp(undefined)).toBe('')
    // 用同一个时间戳构造期望值，避免断言被时区影响
    const ts = new Date(2026, 9, 2, 21, 43, 5).getTime()
    expect(formatTimestamp(ts)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatTimestamp(ts)).toBe('2026-10-02 21:43')
  })
})

// ========================================================================
// 后台任务
// ========================================================================

describe('normalizeTasks', () => {
  it('A2A 的任务状态剥掉 TASK_STATE_ 前缀后小写', () => {
    const t = normalizeTasks({
      tasks: [{ id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_INPUT_REQUIRED' } }],
    })
    expect(t[0]?.state).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(t[0]?.stateText).toBe('input-required')
  })

  it('空 / 脏 ⇒ 空数组（面板显示"无后台任务"，不是报错）', () => {
    expect(normalizeTasks(undefined)).toEqual([])
    expect(normalizeTasks({ tasks: [{ status: {} }] })).toEqual([])
  })

  it('剥不动就原样（宁可丑，不可编造状态名）', () => {
    expect(humanizeTaskState('')).toBe('未知')
    expect(humanizeTaskState('WEIRD')).toBe('weird')
  })
})

// ========================================================================
// 文件引用
// ========================================================================

describe('normalizeRefs', () => {
  it('剥掉行号后缀，只留路径；name 取末段', () => {
    const r = normalizeRefs({ root: '/repo', cwd: '/repo', refs: ['src/a.ts:12', 'b.md'] })
    expect(r.items.map((x) => x.path)).toEqual(['src/a.ts', 'b.md'])
    expect(r.items[0]?.name).toBe('a.ts')
  })

  it(`超过 ${MAX_REF_ITEMS} 条 ⇒ 截断并保留总数（面板要能说"还有 N 条"）`, () => {
    const refs = Array.from({ length: MAX_REF_ITEMS + 7 }, (_, i) => `f${i}.ts`)
    const r = normalizeRefs({ root: '/repo', refs })
    expect(r.items.length).toBe(MAX_REF_ITEMS)
    expect(r.total).toBe(MAX_REF_ITEMS + 7)
    expect(r.truncated).toBe(true)
  })

  it('服务端自己截断也算截断', () => {
    expect(normalizeRefs({ refs: ['a.ts'], truncated: true }).truncated).toBe(true)
  })
})

// ========================================================================
// 统计 / 通知
// ========================================================================

describe('normalizeStats / normalizeNotices', () => {
  it('统计取服务端整页 text（扩展不写第二套渲染器）', () => {
    const s = normalizeStats({ text: '上下文占用 12%', rollupText: 'r', occupancyText: 'o' })
    expect(s?.text).toBe('上下文占用 12%')
    expect(s?.occupancyText).toBe('o')
  })

  it('没 text ⇒ undefined（分区降级，不显示空框）', () => {
    expect(normalizeStats({ usage: {} })).toBeUndefined()
    expect(normalizeStats(undefined)).toBeUndefined()
  })

  it('通知：空文案跳过，level 缺省为 notice', () => {
    const n = normalizeNotices({ notices: [{ text: '回落 Mock', level: 'warn' }, { text: '' }, null] })
    expect(n.length).toBe(1)
    expect(n[0]?.text).toBe('回落 Mock')
    expect(normalizeNotices({ notices: [{ text: 'x' }] })[0]?.level).toBe('notice')
  })
})

// ========================================================================
// 组装与降级
// ========================================================================

describe('buildPanelState', () => {
  it('没端点 ⇒ ready=false 且首条 warning 说明"未连接"', () => {
    const st = buildPanelState({})
    expect(st.ready).toBe(false)
    expect(st.warnings[0]).toContain('未连接')
  })

  it('分区独立降级：统计失败只写一条 warning，其余分区照常呈现', () => {
    const st = buildPanelState({
      endpoint: HS,
      sessionList: { cwd: '/repo', current: 'c', sessions: [{ id: 'c', title: 'C', isCurrent: true }] },
      statsError: '无活动会话',
      tree: { root: '/repo', refs: ['a.ts'] },
      notices: { notices: [{ text: '回落 Mock', level: 'warn' }] },
    })
    expect(st.ready).toBe(true)
    expect(st.warnings.some((w) => w.includes('统计'))).toBe(true)
    expect(st.sessions.items.length).toBe(1)
    expect(st.refs.items.length).toBe(1)
    expect(st.notices.length).toBe(1)
    expect(st.stats).toBeUndefined()
  })

  it('ready 但 stats 没给 ⇒ 视为降级（有活动会话却拿不到统计是异常，不该静默）', () => {
    const st = buildPanelState({ endpoint: HS, statsError: 'NOT_FOUND' })
    expect(st.warnings.some((w) => w.includes('统计分区不可用：NOT_FOUND'))).toBe(true)
  })

  it('loading 与刷新时间透传', () => {
    const st = buildPanelState({ loading: true }, new Date(2026, 9, 2, 22, 0).getTime())
    expect(st.loading).toBe(true)
    expect(st.refreshedText).toBe('2026-10-02 22:00')
  })
})

// ========================================================================
// 面板动作
// ========================================================================

describe('planPanelAction', () => {
  it('refresh / new / save → 控制面方法 + 打完重拉', () => {
    expect(planPanelAction({ type: 'refresh' })).toEqual({ kind: 'refresh' })
    expect(planPanelAction({ type: 'new' })).toMatchObject({
      kind: 'control',
      method: 'harness/session.new',
      refresh: true,
    })
    expect(planPanelAction({ type: 'save' })).toMatchObject({ method: 'harness/session.save' })
  })

  it('resume 带 id；缺 id ⇒ noop（不带 reason 的静默失败最难查）', () => {
    expect(planPanelAction({ type: 'resume', id: 'abc' })).toMatchObject({
      method: 'harness/session.resume',
      params: { id: 'abc' },
    })
    const bad = planPanelAction({ type: 'resume' })
    expect(bad.kind).toBe('noop')
    expect(bad.kind === 'noop' && bad.reason).toContain('缺 id')
  })

  it('compact：模式白名单（透传任意字符串等于把控制面参数校验交给了前端）', () => {
    expect(planPanelAction({ type: 'compact' })).toMatchObject({ method: 'harness/compact', params: {} })
    expect(planPanelAction({ type: 'compact', mode: 'prune' })).toMatchObject({ params: { mode: 'prune' } })
    expect(planPanelAction({ type: 'compact', mode: 'rm -rf' }).kind).toBe('noop')
  })

  it('stats-export：格式白名单，且不重拉面板（导出不改会话状态）', () => {
    expect(planPanelAction({ type: 'stats-export', format: 'json' })).toMatchObject({
      method: 'harness/stats.export',
      params: { format: 'json' },
      refresh: false,
    })
    expect(planPanelAction({ type: 'stats-export', format: 'yaml' }).kind).toBe('noop')
  })

  it('open / show-status / 未知消息', () => {
    expect(planPanelAction({ type: 'open', path: 'src/a.ts' })).toEqual({
      kind: 'open-file',
      path: 'src/a.ts',
    })
    expect(planPanelAction({ type: 'show-status' })).toMatchObject({ kind: 'command', id: 'harness.showStatus' })
    expect(planPanelAction({ type: 'nope' }).kind).toBe('noop')
    expect(planPanelAction(null).kind).toBe('noop')
    expect(planPanelAction('x').kind).toBe('noop')
  })

  it('describePanelAction 覆盖全部动作（面板操作要能在输出通道里追到）', () => {
    expect(describePanelAction({ kind: 'refresh' })).toBe('refresh')
    expect(describePanelAction({ kind: 'open-file', path: '/a' })).toContain('/a')
    expect(describePanelAction({ kind: 'command', id: 'harness.showStatus', refresh: false })).toContain('harness.showStatus')
    expect(describePanelAction({ kind: 'noop', reason: 'r' })).toBe('noop(r)')
    expect(
      describePanelAction({ kind: 'control', method: 'harness/session.new', params: {}, refresh: true, label: '新建会话' }),
    ).toContain('harness/session.new')
  })
})
