import { describe, expect, it } from 'bun:test'
import {
  InteractivePermissionEngine,
  buildPermissionPrompt,
  type PermissionAnswer,
  type PermissionAsker,
} from './permission'

function engineWith(answer: PermissionAnswer | undefined, opts: { save?: (r: Record<string, unknown>) => Promise<void> } = {}) {
  const seen: string[] = []
  const asker: PermissionAsker = (_req, prompt) => {
    seen.push(prompt.text)
    return Promise.resolve(answer)
  }
  const e = new InteractivePermissionEngine({ '*': 'ask' }, { mode: 'ask', asker, ...(opts.save ? { store: { rules: {}, save: opts.save } } : {}) })
  return { e, seen }
}

describe('InteractivePermissionEngine · 模式短路', () => {
  it('allow-all 直接放行（不问 asker）', async () => {
    const asker: PermissionAsker = () => { throw new Error('不该被问到') }
    const e = new InteractivePermissionEngine({}, { mode: 'allow-all', asker })
    const d = await e.ask({ toolKey: 'read', patterns: [] })
    expect(d).toEqual({ behavior: 'allow', matchedRule: 'global' })
  })

  it('deny-all 一律拒绝', async () => {
    const e = new InteractivePermissionEngine({}, { mode: 'deny-all' })
    expect(await e.ask({ toolKey: 'read', patterns: [] })).toEqual({ behavior: 'deny', matchedRule: 'global' })
  })

  it('getMode 缺省 ask；setMode 可切', () => {
    const e = new InteractivePermissionEngine({})
    expect(e.getMode()).toBe('ask')
    e.setMode('deny-all')
    expect(e.getMode()).toBe('deny-all')
  })
})

describe('InteractivePermissionEngine · 四态', () => {
  it('always-allow：写回规则 + remember + 落盘', async () => {
    let saved: Record<string, unknown> | undefined
    const { e } = engineWith('always-allow', { save: async (r) => { saved = r } })
    const d = await e.ask({ toolKey: 'bash', patterns: ['rm -rf /tmp/x'] })
    expect(d).toEqual({ behavior: 'allow', matchedRule: 'tool', remember: true })
    expect(e.getRules()).toMatchObject({ bash: 'allow' })
    expect(saved).toMatchObject({ bash: 'allow' })
  })

  it('always-deny：写回 deny + remember + 落盘', async () => {
    let saved: Record<string, unknown> | undefined
    const { e } = engineWith('always-deny', { save: async (r) => { saved = r } })
    const d = await e.ask({ toolKey: 'foo', patterns: [] })
    expect(d).toEqual({ behavior: 'deny', matchedRule: 'tool', remember: true })
    expect(saved).toMatchObject({ foo: 'deny' })
  })

  it('单次 allow / deny：remember 不置位、不落盘', async () => {
    let saves = 0
    const { e } = engineWith('allow', { save: async () => { saves++ } })
    expect(await e.ask({ toolKey: 'read', patterns: ['/x'] })).toEqual({ behavior: 'allow', matchedRule: 'tool' })
    expect(saves).toBe(0)
    expect(e.getRules()).not.toHaveProperty('read')
  })

  it('deny（单次）', async () => {
    const { e } = engineWith('deny')
    expect(await e.ask({ toolKey: 'write', patterns: [] })).toEqual({ behavior: 'deny', matchedRule: 'tool' })
  })
})

describe('InteractivePermissionEngine · 取不到答复一律 deny（反向验证 ③）', () => {
  it('asker 返回 undefined ⇒ deny/global 且**不写回规则**', async () => {
    let saves = 0
    const { e } = engineWith(undefined, { save: async () => { saves++ } })
    const d = await e.ask({ toolKey: 'bash', patterns: [] })
    expect(d).toEqual({ behavior: 'deny', matchedRule: 'global' })
    // 这条是关键：若把 undefined 当成 always-allow，规则会被悄悄写回 allow —— 安全缺陷
    expect(saves).toBe(0)
    expect(e.getRules()).not.toHaveProperty('bash')
  })

  it('未挂 asker ⇒ 同样 deny/global（DefaultPermissionEngine 的 ask→deny 语义）', async () => {
    const e = new InteractivePermissionEngine({ '*': 'ask' }, { mode: 'ask' })
    expect(await e.ask({ toolKey: 'bash', patterns: [] })).toEqual({ behavior: 'deny', matchedRule: 'global' })
  })

  it('setAsker 可在运行期替换（TUI 模态）', async () => {
    const e = new InteractivePermissionEngine({ '*': 'ask' }, { mode: 'ask' })
    e.setAsker(() => Promise.resolve('always-allow'))
    expect((await e.ask({ toolKey: 'bash', patterns: [] })).behavior).toBe('allow')
  })
})

describe('buildPermissionPrompt · 文案逐字（改造前 cli 内的 readline 问题串）', () => {
  it('含工具名与前 3 个 pattern，开头换行、⚠️ 后两空格、结尾带 [a/d/A/D] 提示', () => {
    const p = buildPermissionPrompt({ toolKey: 'bash', patterns: ['a', 'b', 'c', 'd'] })
    expect(p.summary).toBe('权限请求 [bash] a, b, c')
    expect(p.text).toBe(
      '\n⚠️  权限请求 [bash] a, b, c\n' +
      '  操作: allow / deny / always(a) / deny-always(d)? [a/d/A/D] ',
    )
  })

  it('无 pattern 时显示 (无路径)', () => {
    expect(buildPermissionPrompt({ toolKey: 'read', patterns: [] }).summary).toBe('权限请求 [read] (无路径)')
  })

  it('引擎把 prompt.text 原样交给 asker', async () => {
    const { e, seen } = engineWith('deny')
    await e.ask({ toolKey: 'bash', patterns: ['/tmp/x'] })
    expect(seen[0]).toBe(
      '\n⚠️  权限请求 [bash] /tmp/x\n' +
      '  操作: allow / deny / always(a) / deny-always(d)? [a/d/A/D] ',
    )
  })
})
