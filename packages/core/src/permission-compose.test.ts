import { describe, expect, it } from 'bun:test'
import { DefaultPermissionEngine, composeRules } from './index'
import type { PermissionRuleset } from './index'

/**
 * D1（2026-10-14）：agent 权限**只收紧不放宽**的分层合成。
 *
 * 背景：`_prepareQueryOnce` 曾用 `{ ...getRules(), ...agent.permission }` 把 agent 权限整键覆盖
 * 到用户规则上。两个方向都错：
 *  - 正序（agent 压上）：agent 默认 `{'*':'ask'}` 抹掉用户 `{'*':{deny:[…]}}` 的全局否决权（fail-open）；
 *  - 反转（用户压上）：把只读子 agent 的 `{'*':'deny'}` 放大回宽松（fail-open）。
 * 正确模型＝两层独立 + 逐键取最严（见 `composeRules`）。本文件同时钉住"合成结果"与"引擎行为"。
 */

const req = (toolKey: string, patterns: string[]) => ({ toolKey, patterns, input: {} })

describe('composeRules：逐键取最严（纯函数）', () => {
  it('P：用户的全局否决权（deny）在 agent 的 "ask" 之上仍生效', () => {
    const base: PermissionRuleset = { '*': { deny: ['/etc/**'] } }
    const agent: PermissionRuleset = { '*': 'ask' }
    const out = composeRules(base, agent)
    expect(out['*']).toEqual({ deny: ['/etc/**'], ask: ['**'] })
  })

  it('Q：agent 的全 deny 不被用户宽松规则放大', () => {
    const out = composeRules({ '*': 'ask' }, { '*': 'deny' })
    expect(out['*']).toBe('deny')
  })

  it('简写行为按"最严"取：allow+ask=ask、allow+deny=deny、ask+deny=deny（保持 string 形态）', () => {
    expect(composeRules({ bash: 'allow' }, { bash: 'ask' }).bash).toBe('ask')
    expect(composeRules({ bash: 'allow' }, { bash: 'deny' }).bash).toBe('deny')
    expect(composeRules({ bash: 'ask' }, { bash: 'deny' }).bash).toBe('deny')
    // 同向叠加仍是原行为
    expect(composeRules({ bash: 'allow' }, { bash: 'allow' }).bash).toBe('allow')
  })

  it('allow 取交集且"缺一边即空"（保 ⊆ 不变式，偏严不偏松）', () => {
    // 两边都有 allow：只保留都在的
    expect(
      composeRules({ x: { allow: ['a', 'b'] } }, { x: { allow: ['b', 'c'] } }).x,
    ).toEqual({ allow: ['b'] })
    // 一边有 allow、另一边只有 deny：allow 归空（否则会比 agent 侧更宽松）
    expect(
      composeRules({ bash: 'allow' }, { bash: { deny: ['rm*'] } }).bash,
    ).toEqual({ deny: ['rm*'] })
    // `**` 通配短路：['**'] ∩ ['ls*'] = ['ls*']（逐字面比对会误判成空集）
    expect(composeRules({ x: { allow: ['ls*'] } }, { x: 'allow' }).x).toEqual({ allow: ['ls*'] })
  })

  it('deny/ask 取并集', () => {
    const out = composeRules(
      { x: { deny: ['d1'], ask: ['q1'] } },
      { x: { deny: ['d2'], ask: ['q2'] } },
    )
    expect((out.x as { deny: string[] }).deny.sort()).toEqual(['d1', 'd2'])
    expect((out.x as { ask: string[] }).ask.sort()).toEqual(['q1', 'q2'])
  })

  it('只在一侧出现的键原样保留（含归属键 session:/caller:）', () => {
    const base: PermissionRuleset = { read: 'allow', 'session:s1|write': 'deny' }
    const agent: PermissionRuleset = { glob: 'allow' }
    const out = composeRules(base, agent)
    expect(out.read).toBe('allow')
    expect(out['session:s1|write']).toBe('deny')
    expect(out.glob).toBe('allow')
  })

  it('agent 为空/缺省 ⇒ 原样返回基线', () => {
    const base: PermissionRuleset = { '*': 'ask', read: 'allow' }
    expect(composeRules(base, undefined)).toEqual(base)
    expect(composeRules(base, {})).toEqual(base)
  })
})

describe('DefaultPermissionEngine：agent 约束层经 setAgentRules 并入', () => {
  it('P：agent 默认 ask 不抹掉用户的 deny 否决权', async () => {
    const e = new DefaultPermissionEngine({ '*': { deny: ['/etc/**'] } })
    e.setAgentRules({ '*': 'ask' })
    expect((await e.check(req('read', ['/etc/passwd']))).behavior).toBe('deny')
    expect((await e.check(req('read', ['/tmp/a']))).behavior).toBe('ask')
  })

  it('Q：只读子 agent 的全 deny 生效（用户宽松规则放不开）', async () => {
    const e = new DefaultPermissionEngine({ '*': 'ask', read: 'allow' })
    e.setAgentRules({ '*': 'deny' })
    expect((await e.check(req('bash', ['rm -rf /']))).behavior).toBe('deny')
    // read 是 agent 显式放行的例外，仍在
    expect((await e.check(req('read', ['a.ts']))).behavior).toBe('allow')
  })

  it('getRules() 只回用户基线：agent 约束不进持久化', () => {
    const e = new DefaultPermissionEngine({ '*': 'ask' })
    e.setAgentRules({ bash: 'deny' })
    expect(e.getRules()).toEqual({ '*': 'ask' })
  })

  it('换 agent 不留残影：setAgentRules 每轮整体替换约束层', async () => {
    const e = new DefaultPermissionEngine({ '*': 'ask' })
    e.setAgentRules({ bash: 'deny' })
    expect((await e.check(req('bash', ['ls']))).behavior).toBe('deny')
    // 切到不声明 bash 的 agent ⇒ 旧约束消失（旧实现会残留）
    e.setAgentRules({})
    expect((await e.check(req('bash', ['ls']))).behavior).toBe('ask')
  })

  it('agent 不能放宽用户对同键的 deny（区间内仍 deny）', async () => {
    const e = new DefaultPermissionEngine({ bash: { deny: ['sudo*'] } })
    e.setAgentRules({ bash: 'allow' })
    expect((await e.check(req('bash', ['sudo ls']))).behavior).toBe('deny')
  })
})
