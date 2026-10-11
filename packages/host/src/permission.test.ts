import { describe, expect, it } from 'bun:test'
import { callerScopeKey, hashPrincipal, scopedRuleKey, sessionScopeKey } from '@harness/core'
import {
  InteractivePermissionEngine,
  assessRisk,
  buildPermissionPrompt,
  rulesStateHash,
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
  it('always-allow：写回 **本次命令**（命令级粒度）+ remember + 落盘', async () => {
    let saved: Record<string, unknown> | undefined
    const { e } = engineWith('always-allow', { save: async (r) => { saved = r } })
    const d = await e.ask({ toolKey: 'bash', patterns: ['rm -rf /tmp/x'] })
    expect(d).toEqual({ behavior: 'allow', matchedRule: 'tool', remember: true })
    // P0-8：不再是整工具简写 `'allow'`，而是把**具体命令**并进 allow 列表
    expect(e.getRules()).toMatchObject({ bash: { allow: ['rm -rf /tmp/x'] } })
    expect(saved).toMatchObject({ bash: { allow: ['rm -rf /tmp/x'] } })
  })

  it('always-deny：写回 deny + remember + 落盘', async () => {
    let saved: Record<string, unknown> | undefined
    const { e } = engineWith('always-deny', { save: async (r) => { saved = r } })
    const d = await e.ask({ toolKey: 'foo', patterns: [] })
    expect(d).toEqual({ behavior: 'deny', matchedRule: 'tool', remember: true })
    // patterns 为空 ⇒ `**` 通配（语义等价旧的 string `'deny'`，但保留既有 allow/ask 列表）
    expect(saved).toMatchObject({ foo: { deny: ['**'] } })
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

// ===== P0-8（D1 回归）：写回不再吞掉已有规则，段级 deny 不会静默消失 =====

describe('InteractivePermissionEngine · P0-8 写回粒度与保留（D1 回归）', () => {
  /** 组装一个用固定四态答复的引擎（可带初始规则与落盘计数） */
  const answering = (
    answer: PermissionAnswer,
    rules: Record<string, unknown> = {},
  ): { e: InteractivePermissionEngine; saved: () => Record<string, unknown> | undefined } => {
    let last: Record<string, unknown> | undefined
    const e = new InteractivePermissionEngine(rules, {
      mode: 'ask',
      asker: () => Promise.resolve(answer),
      store: { rules: {}, save: async (r) => { last = r } },
    })
    return { e, saved: () => last }
  }

  it('已有 PathRules（含 deny/ask）时，always-allow **增量并入** allow 且**一个都不丢**', async () => {
    const { e, saved } = answering('always-allow', {
      bash: { allow: ['ls*'], deny: ['shutdown*'], ask: ['git*'] },
    })
    await e.ask({ toolKey: 'bash', patterns: ['cat /etc/passwd'] })
    const bash = (e.getRules() as Record<string, unknown>).bash as { allow?: string[]; deny?: string[]; ask?: string[] }
    // 增量：新命令进 allow；旧的 allow / deny / ask 全部保留（旧实现会把整键替换成 'allow'）
    expect(bash.allow).toEqual(['ls*', 'cat /etc/passwd'])
    expect(bash.deny).toEqual(['shutdown*'])
    expect(bash.ask).toEqual(['git*'])
    expect(saved()).toMatchObject({ bash: { deny: ['shutdown*'], ask: ['git*'] } })
  })

  it('★写回之后段级 `denyPatterns` **仍然生效**（旧实现退化成 string ⇒ 整条防线消失）', async () => {
    const { e } = answering('always-allow', { bash: { allow: ['echo*'], deny: ['shutdown*'] } })
    // 先「始终允许」一条普通命令
    await e.ask({ toolKey: 'bash', patterns: ['echo hi'] })
    // 再跑同键的**拼接命令**：整串会被 allow 的 `echo*` 匹配，必须靠段级 denyPatterns 拦下
    const res = await e.check({
      toolKey: 'bash',
      patterns: ['echo hi; shutdown -h now'],
      input: {},
      denyPatterns: ['echo hi', 'shutdown -h now'],
    })
    expect(res.behavior).toBe('deny')
    expect(res.matchedPattern).toBe('shutdown -h now')
  })

  it('旧 string 规则再次被写回时归一成 PathRules（不丢语义，且恢复"可被 deny 拦"）', async () => {
    const { e } = answering('always-allow', { bash: 'deny' })
    await e.ask({ toolKey: 'bash', patterns: ['ls'] })
    expect(e.getRules()).toMatchObject({ bash: { deny: ['**'], allow: ['ls'] } })
  })

  it('patterns 为空 ⇒ `**` 通配（等价旧 string，但仍保留既有 deny/ask）', async () => {
    const { e } = answering('always-allow', { bash: { deny: ['shutdown*'] } })
    await e.ask({ toolKey: 'bash', patterns: [] })
    const bash = (e.getRules() as Record<string, unknown>).bash as { allow?: string[]; deny?: string[] }
    expect(bash.allow).toEqual(['**'])
    expect(bash.deny).toEqual(['shutdown*'])
  })

  it('重复写同一条命令是幂等的（不产生重复项）', async () => {
    const { e } = answering('always-allow')
    await e.ask({ toolKey: 'bash', patterns: ['ls'] })
    await e.ask({ toolKey: 'bash', patterns: ['ls'] })
    expect(((e.getRules() as Record<string, unknown>).bash as { allow?: string[] }).allow).toEqual(['ls'])
  })

  it('always-deny 同样增量：不改粒度、不动既有 allow', async () => {
    const { e } = answering('always-deny', { bash: { allow: ['ls*'] } })
    await e.ask({ toolKey: 'bash', patterns: ['rm -rf /'] })
    expect(e.getRules()).toMatchObject({ bash: { allow: ['ls*'], deny: ['rm -rf /'] } })
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

  it('getAsker 拿到当前交互器：包装型 asker 必需（否则"包装"会退化成"替换"）', async () => {
    const e = new InteractivePermissionEngine({ '*': 'ask' }, { mode: 'ask' })
    expect(e.getAsker()).toBeUndefined()
    const prev: PermissionAsker = () => Promise.resolve('deny')
    e.setAsker(prev)
    expect(e.getAsker()).toBe(prev)
    // 典型用法：先取到原 asker，再装一个按会话归属分流的包装（进程内 MCP server 的形态）
    const captured = e.getAsker()!
    const delegated: string[] = []
    e.setAsker(async (req, prompt) => {
      if (req.sessionId === 'mine') return 'allow'
      delegated.push(req.toolKey)
      return await captured(req, prompt)
    })
    expect((await e.ask({ toolKey: 'bash', patterns: [], sessionId: 'mine' })).behavior).toBe('allow')
    expect((await e.ask({ toolKey: 'bash', patterns: [], sessionId: 'tui' })).behavior).toBe('deny')
    expect(delegated).toEqual(['bash'])
  })
})

describe('buildPermissionPrompt · 文案逐字（改造前 cli 内的 readline 问题串）', () => {
  it('含工具名与前 3 个 pattern，开头换行、⚠️ 后两空格、结尾带 `状态(键)` 提示', () => {
    const p = buildPermissionPrompt({ toolKey: 'bash', patterns: ['a', 'b', 'c', 'd'] })
    expect(p.summary).toBe('权限请求 [bash] a, b, c')
    expect(p.text).toBe(
      '\n⚠️  权限请求 [bash] a, b, c\n' +
      '  操作: allow(a) / deny(d) / always-allow(A) / always-deny(D)? ',
    )
  })

  it('无 pattern 时显示 (无路径)', () => {
    expect(buildPermissionPrompt({ toolKey: 'read', patterns: [] }).summary).toBe('权限请求 [read] (无路径)')
  })

  it('透传会话归属：有则原样带出，无则 undefined（asker 据此路由，未给时不伪造）', () => {
    expect(buildPermissionPrompt({ toolKey: 'bash', patterns: [], sessionId: 'sess-1' }).sessionId).toBe('sess-1')
    expect(buildPermissionPrompt({ toolKey: 'bash', patterns: [] }).sessionId).toBeUndefined()
  })

  it('asker 收到的 req 保留 sessionId（路由信息不被引擎层剥掉）', async () => {
    const got: Array<string | undefined> = []
    const asker: PermissionAsker = (req) => {
      got.push(req.sessionId)
      return Promise.resolve('deny')
    }
    const e = new InteractivePermissionEngine({ '*': 'ask' }, { mode: 'ask', asker })
    await e.ask({ toolKey: 'bash', patterns: [], sessionId: 'sess-9' })
    expect(got).toEqual(['sess-9'])
  })

  it('引擎把 prompt.text 原样交给 asker', async () => {
    const { e, seen } = engineWith('deny')
    await e.ask({ toolKey: 'bash', patterns: ['/tmp/x'] })
    expect(seen[0]).toBe(
      '\n⚠️  权限请求 [bash] /tmp/x\n' +
      '  操作: allow(a) / deny(d) / always-allow(A) / always-deny(D)? ',
    )
  })
})

// ===== M3：风险分级 + decision.human 审计 =====

describe('assessRisk · 风险分级（只打标签不决策）', () => {
  it('高危命令模式 → high（bash 入参里的 rm -rf）', () => {
    expect(assessRisk('bash', [], { command: 'rm -rf /tmp/x' })).toBe('high')
    expect(assessRisk('bash', [], { command: 'sudo rm -rf /tmp/x' })).toBe('high')
    expect(assessRisk('bash', [], { command: 'dd if=/dev/zero of=/dev/sda' })).toBe('high')
  })
  it('高危工具键 → high（写/删类）', () => {
    expect(assessRisk('edit_file', [], { path: 'a.ts' })).toBe('high')
    expect(assessRisk('write_file', [], { path: 'a.ts' })).toBe('high')
  })
  it('已知只读工具键 → low', () => {
    expect(assessRisk('read_file', [], {})).toBe('low')
    expect(assessRisk('grep_file', [], {})).toBe('low')
    // P2-5：只读 shell 变体天然不可写 ⇒ low
    expect(assessRisk('bash_ro', [], { command: 'ls' })).toBe('low')
  })
  it('中间地带 → medium', () => {
    expect(assessRisk('custom_tool', [], {})).toBe('medium')
    // 权限键与工具 id 不同名：实际询问用的键是 `write`（不是 `write_file`）
    expect(assessRisk('write', [], { path: 'a.ts' })).toBe('medium')
  })
})

// ===== P2-5（D4）=====

describe('assessRisk · bash 走命令模式表（D4 回归：不再恒为 high）', () => {
  it('整条命令都是只读命令 ⇒ low（`ls` 与 `rm -rf` 不再同标签）', () => {
    expect(assessRisk('bash', [], { command: 'ls -la /tmp' })).toBe('low')
    expect(assessRisk('bash', [], { command: 'pwd' })).toBe('low')
    expect(assessRisk('bash', [], { command: 'echo hello' })).toBe('low')
    expect(assessRisk('bash', [], { command: 'FOO=1 ls' })).toBe('low') // 前置环境变量赋值
    expect(assessRisk('bash', [], { command: 'cat a.txt | grep -i foo' })).toBe('low') // 管道两边都只读
    expect(assessRisk('bash', [], { command: 'ls && pwd; echo ok' })).toBe('low') // 多段
  })

  it('空设备重定向不算写 ⇒ low（`2>/dev/null` 不该把标签顶到 medium）', () => {
    expect(assessRisk('bash', [], { command: 'ls -la 2>/dev/null' })).toBe('low')
    expect(assessRisk('bash', [], { command: 'cat x &>/dev/null' })).toBe('low')
    expect(assessRisk('bash', [], { command: 'cat x 2> /dev/null' })).toBe('low')
    // 钉子：`> /dev/nullx` 不是空设备（负向前瞻）；且这里有真的 `>` ⇒ 至少 medium
    expect(assessRisk('bash', [], { command: 'cat x 2>/dev/nullx' })).toBe('medium')
  })

  it('写入 / 命令替换 ⇒ medium', () => {
    expect(assessRisk('bash', [], { command: 'ls > out.txt' })).toBe('medium')
    expect(assessRisk('bash', [], { command: 'echo `whoami`' })).toBe('medium')
    expect(assessRisk('bash', [], { command: 'echo $(ls)' })).toBe('medium')
  })

  it('首词不在只读白名单 ⇒ medium（跳板与读/写同词的工具一律不收）', () => {
    expect(assessRisk('bash', [], { command: 'npm test' })).toBe('medium')
    expect(assessRisk('bash', [], { command: 'git status' })).toBe('medium')
    expect(assessRisk('bash', [], { command: 'ls | xargs rm' })).toBe('medium')
    expect(assessRisk('bash', [], { command: 'env FOO=1 ls' })).toBe('medium')
  })

  it('只读首词带危险开关 ⇒ medium（`-exec` / `-delete` 是写）', () => {
    expect(assessRisk('bash', [], { command: 'find . -name "*.ts"' })).toBe('low')
    expect(assessRisk('bash', [], { command: 'find . -delete' })).toBe('medium')
    expect(assessRisk('bash', [], { command: 'find . -exec echo {} +' })).toBe('medium')
  })

  it('拿不到命令文本 ⇒ high（保守默认，与改造前逐位一致）', () => {
    expect(assessRisk('bash', [], {})).toBe('high')
    expect(assessRisk('bash', [], { command: '' })).toBe('high')
    expect(assessRisk('bash', [])).toBe('high')
  })
})

describe('InteractivePermissionEngine · decision.human 审计', () => {
  it('人工答复（allow）⇒ 落审计事件：零内容 + stateHash + responseMs + rememberScope=once', async () => {
    const events: unknown[] = []
    const asker: PermissionAsker = async () => {
      // 模拟人工响应耗时（模态挂起）
      await new Promise((r) => setTimeout(r, 5))
      return 'allow'
    }
    const e = new InteractivePermissionEngine({ '*': 'ask' }, { mode: 'ask', asker, audit: (env) => { events.push(env) } })
    await e.ask({ toolKey: 'read_file', patterns: ['/tmp/a'], input: { path: '/tmp/a' }, sessionId: 's1' })
    expect(events).toHaveLength(1)
    const env = events[0] as { kind: string; tool: string; riskLevel: string; actionTaken: string; rememberScope: string; responseMs: number; stateHash: string; sessionId: string; decisionPoint: string }
    expect(env.kind).toBe('decision.human')
    expect(env.decisionPoint).toBe('core.permission.ask')
    expect(env.tool).toBe('read_file')
    expect(env.riskLevel).toBe('low')
    expect(env.actionTaken).toBe('allow')
    expect(env.rememberScope).toBe('once')
    expect(env.sessionId).toBe('s1')
    expect(env.responseMs).toBeGreaterThanOrEqual(5)
    // 零内容：信封里没有入参原文，只有哈希
    expect(JSON.stringify(env)).not.toContain('/tmp/a')
    expect(env.stateHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('always-deny ⇒ rememberScope=tool（写回规则的永久决策）', async () => {
    const events: unknown[] = []
    const e = new InteractivePermissionEngine(
      { '*': 'ask' },
      { mode: 'ask', asker: () => Promise.resolve('always-deny'), audit: (env) => { events.push(env) } },
    )
    await e.ask({ toolKey: 'bash', patterns: [] })
    expect((events[0] as { actionTaken: string }).actionTaken).toBe('always-deny')
    expect((events[0] as { rememberScope: string }).rememberScope).toBe('tool')
  })

  it('allow-all 短路：非人工决策，不落审计', async () => {
    const events: unknown[] = []
    const e = new InteractivePermissionEngine({}, { mode: 'allow-all', asker: () => Promise.resolve('allow'), audit: (env) => { events.push(env) } })
    await e.ask({ toolKey: 'bash', patterns: [] })
    expect(events).toHaveLength(0)
  })

  it('asker 取不到答复（undefined ⇒ deny 兜底）：非人工决策，不落审计', async () => {
    const events: unknown[] = []
    const e = new InteractivePermissionEngine({ '*': 'ask' }, { mode: 'ask', asker: () => Promise.resolve(undefined), audit: (env) => { events.push(env) } })
    await e.ask({ toolKey: 'bash', patterns: [] })
    expect(events).toHaveLength(0)
  })
})

// ===== P0-9（D2 回归）：规则按归属分层，授权不跟调用方串台 =====

describe('InteractivePermissionEngine · P0-9 归属分层（D2 回归）', () => {
  /** 造一个带归属解析器 + 落盘的引擎 */
  const scoped = (
    principal: string | undefined,
    rules: Record<string, unknown> = { '*': 'ask' },
    answer: PermissionAnswer = 'always-allow',
  ) => {
    let saved: Record<string, unknown> | undefined
    const e = new InteractivePermissionEngine(rules, {
      mode: 'ask',
      asker: () => Promise.resolve(answer),
      store: { rules: {}, save: async (r) => { saved = r } },
      ...(principal !== undefined ? { callerResolver: () => principal } : {}),
    })
    return { e, saved: () => saved }
  }

  it('装了归属解析器 ⇒ 写回键带 `caller:<hash>|`，且**落盘不含主体明文**', async () => {
    const token = 'super-secret-token'
    const { e, saved } = scoped(token)
    await e.ask({ toolKey: 'bash', patterns: ['npm test'] })
    const key = scopedRuleKey(callerScopeKey(token), 'bash')
    expect(e.getRules()).toMatchObject({ [key]: { allow: ['npm test'] } })
    expect(saved()).toMatchObject({ [key]: { allow: ['npm test'] } })
    // ★零明文：主体（= 凭据本身）绝不落盘
    expect(JSON.stringify(saved())).not.toContain(token)
    expect(key).toBe(`caller:${hashPrincipal(token)}|bash`)
  })

  it('未装归属解析器 ⇒ 退回裸工具键（与分层前逐位相同）', async () => {
    const { e, saved } = scoped(undefined)
    await e.ask({ toolKey: 'bash', patterns: ['ls'] })
    expect(saved()).toMatchObject({ bash: { allow: ['ls'] } })
  })

  it('★远程调用方**不继承**本机 always-allow（D2 的正向证据）', async () => {
    const { e } = scoped('local')
    // 本机点一次「始终允许 npm test」⇒ 写进 caller:local|bash
    await e.ask({ toolKey: 'bash', patterns: ['npm test'], sessionId: 'local-1' })
    // 同一个引擎换成远程调用方（同一份 dataDir 级规则集）
    e.setCallerResolver(() => 'remote-token')
    const remote = await e.check({ toolKey: 'bash', patterns: ['npm test'], input: {}, sessionId: 'remote-1' })
    // 落到全局兜底 ask，而不是本机那条 allow
    expect(remote.behavior).toBe('ask')
    // 反过来：本机自己仍然命中（归属稳定）
    e.setCallerResolver(() => 'local')
    const local = await e.check({ toolKey: 'bash', patterns: ['npm test'], input: {}, sessionId: 'local-1' })
    expect(local.behavior).toBe('allow')
    expect(local.matchedScope).toBe('caller')
  })

  it('层序：session 工具 > session 通配 > caller 工具 > caller 通配 > 工具 > 全局', async () => {
    const h = callerScopeKey('local')
    const e = new InteractivePermissionEngine(
      {
        bash: 'deny',                                // 全局工具层
        [`${h}|bash`]: { allow: ['npm test'] },      // 调用方工具层
        [`${sessionScopeKey('s9')}|bash`]: { ask: ['npm test'] }, // 会话工具层（最具体）
      } as Record<string, unknown>,
      { mode: 'ask', callerResolver: () => 'local' },
    )
    // 会话层最具体 ⇒ 命中 ask（压过 caller 层 allow）
    const sess = await e.check({ toolKey: 'bash', patterns: ['npm test'], input: {}, sessionId: 's9' })
    expect(sess.behavior).toBe('ask')
    expect(sess.matchedScope).toBe('session')
    // 别的会话 ⇒ 落到 caller 工具层 allow
    const other = await e.check({ toolKey: 'bash', patterns: ['npm test'], input: {}, sessionId: 's2' })
    expect(other.behavior).toBe('allow')
    expect(other.matchedScope).toBe('caller')
    // 未命中 caller allow 的命令 ⇒ 落到全局工具层 deny（管理员规则不被架空）
    const denied = await e.check({ toolKey: 'bash', patterns: ['rm -rf /'], input: {}, sessionId: 's2' })
    expect(denied.behavior).toBe('deny')
    expect(denied.matchedRule).toBe('tool')
  })

  it('会话归属键：只有该会话命中，其它会话不受影响（不需要 resolver）', async () => {
    const e = new InteractivePermissionEngine(
      { bash: 'deny', [`${sessionScopeKey('sA')}|bash`]: { allow: ['ls'] } } as Record<string, unknown>,
      { mode: 'ask' },
    )
    expect((await e.check({ toolKey: 'bash', patterns: ['ls'], input: {}, sessionId: 'sA' })).behavior).toBe('allow')
    expect((await e.check({ toolKey: 'bash', patterns: ['ls'], input: {}, sessionId: 'sB' })).behavior).toBe('deny')
  })

  it('作用域通配层也能否决：`caller:<h>|*` 的 deny 拦住同层 string allow', async () => {
    const h = callerScopeKey('local')
    const e = new InteractivePermissionEngine(
      { [`${h}|bash`]: 'allow', [`${h}|*`]: { deny: ['shutdown*'] } } as Record<string, unknown>,
      { mode: 'ask', callerResolver: () => 'local' },
    )
    const res = await e.check({
      toolKey: 'bash',
      patterns: ['echo hi; shutdown -h now'],
      input: {},
      sessionId: 's1',
      denyPatterns: ['echo hi', 'shutdown -h now'],
    })
    expect(res.behavior).toBe('deny')
    expect(res.matchedRule).toBe('global')
    expect(res.matchedPattern).toBe('shutdown -h now')
  })
})

// ===== P1-9（D5 回归）：规则变更留痕 =====

describe('InteractivePermissionEngine · P1-9 规则变更审计（D5 回归）', () => {
  it('always-allow 写回 ⇒ 决策事件之后跟一条 `permission.rule.changed`（source=asker，零内容）', async () => {
    const events: Array<Record<string, unknown>> = []
    const token = 'tok-xyz'
    const e = new InteractivePermissionEngine({ '*': 'ask' }, {
      mode: 'ask',
      asker: () => Promise.resolve('always-allow'),
      audit: (env) => { events.push(env as unknown as Record<string, unknown>) },
      callerResolver: () => token,
    })
    await e.ask({ toolKey: 'bash', patterns: ['npm test'], sessionId: 's1' })

    expect(events.map((e) => e.kind)).toEqual(['decision.human', 'permission.rule.changed'])
    const changed = events[1]!
    expect(changed.source).toBe('asker')
    expect(changed.sessionId).toBe('s1')
    expect(changed.key).toBe(scopedRuleKey(callerScopeKey(token), 'bash'))
    expect(changed.behavior).toBe('allow')
    expect(changed.stateHash).toMatch(/^[0-9a-f]{64}$/)
    // 零内容：不含主体明文，也不含命令原文
    expect(JSON.stringify(changed)).not.toContain(token)
    expect(JSON.stringify(changed)).not.toContain('npm test')
  })

  it('单次答复（allow / deny）**不**产生规则变更事件（没写回就没变更）', async () => {
    const events: Array<Record<string, unknown>> = []
    const e = new InteractivePermissionEngine({ '*': 'ask' }, {
      mode: 'ask',
      asker: () => Promise.resolve('allow'),
      audit: (env) => { events.push(env as unknown as Record<string, unknown>) },
    })
    await e.ask({ toolKey: 'bash', patterns: [], sessionId: 's1' })
    expect(events.map((e) => e.kind)).toEqual(['decision.human'])
  })

  it('rulesStateHash 对同一规则集稳定，对新增键敏感（零内容摘要）', () => {
    const a = rulesStateHash({ '*': 'ask', bash: { allow: ['ls'] } })
    const b = rulesStateHash({ '*': 'ask', bash: { allow: ['ls'] } })
    const c = rulesStateHash({ '*': 'ask', bash: { allow: ['ls', 'pwd'] } })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
