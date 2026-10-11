import { describe, expect, it } from 'bun:test'
import { DefaultPermissionEngine } from './index'

/**
 * denyPatterns（仅参与 deny 判定的附加 pattern）语义钉子。
 *
 * 背景（2026-09-30）：bash 工具的 extractPatterns 只上报整条命令字符串，
 * deny 规则（如 `shutdown*`）对 `echo hi; shutdown -h now` 这种「恶意段藏在全串中」
 * 的形态失明。修复方式是把段级命令放进独立的 `denyPatterns` —— 绝不能混进
 * `patterns`：allow/ask 是**任一 pattern 命中即生效**，混入会放宽 allow。
 * 本文件钉死这两个方向。
 */
describe('DefaultPermissionEngine.denyPatterns', () => {
  const engine = () =>
    new DefaultPermissionEngine({
      bash: {
        allow: ['echo*'],
        deny: ['shutdown*'],
      },
    })

  it('denyPatterns 命中 deny 规则 → deny（段级命令被拦）', async () => {
    const res = await engine().check({
      toolKey: 'bash',
      patterns: ['echo hi; shutdown -h now'],
      input: {},
      denyPatterns: ['echo hi', 'shutdown -h now'],
    })
    expect(res.behavior).toBe('deny')
    // matchedPattern 的既有语义是「命中的请求 pattern」（此处为段级命令），不是规则文本
    expect(res.matchedPattern).toBe('shutdown -h now')
  })

  it('对照组：不含 denyPatterns 时同一条命令被 allow 放行（这就是为什么段级不能进 patterns）', async () => {
    // 全串 'echo hi; shutdown -h now' 无斜杠，`echo*`（* = [^/]*）能整串匹配
    const res = await engine().check({
      toolKey: 'bash',
      patterns: ['echo hi; shutdown -h now'],
      input: {},
    })
    expect(res.behavior).toBe('allow')
  })

  it('denyPatterns 不参与 allow 匹配：deny 规则不命中时仍按 patterns 走 allow', async () => {
    const e = new DefaultPermissionEngine({ bash: { allow: ['echo*'] } })
    const res = await e.check({
      toolKey: 'bash',
      patterns: ['echo hi'],
      input: {},
      denyPatterns: ['echo hi'],
    })
    expect(res.behavior).toBe('allow')
  })

  it('denyPatterns 不参与 ask 匹配：ask 规则只看 patterns，不因 denyPatterns 提前问', async () => {
    const e = new DefaultPermissionEngine({ bash: { ask: ['echo*'] } })
    const res = await e.check({
      toolKey: 'bash',
      patterns: ['ls something-else'],
      input: {},
      denyPatterns: ['echo hi'],
    })
    // 未命中 ask/allow/deny ⇒ 默认 ask（引擎兜底），但 matchedPattern 是全局兜底而非 'echo*'
    expect(res.matchedPattern).toBe('*')
  })

  it('denyPatterns 为空数组时行为与不传一致', async () => {
    const res = await engine().check({
      toolKey: 'bash',
      patterns: ['echo hi; shutdown -h now'],
      input: {},
      denyPatterns: [],
    })
    expect(res.behavior).toBe('allow')
  })

  it('工具级 string 规则不受 denyPatterns 影响（PathRules 之外的形态不变）', async () => {
    const e = new DefaultPermissionEngine({ bash: 'deny' })
    const res = await e.check({
      toolKey: 'bash',
      patterns: ['echo hi'],
      input: {},
      denyPatterns: ['echo hi'],
    })
    expect(res.behavior).toBe('deny')
    expect(res.matchedRule).toBe('tool')
  })
})

/**
 * 全局 deny 的否决权（P0-8 配套）。
 *
 * 起因：工具规则是 **string `'allow'`** 时（手写 `/permission bash=allow`、控制面
 * `harness/permission.set`，或旧版本 `rememberRule` 的写回产物），`check()` 会走
 * `typeof toolRule === 'string'` **直接 return** —— string 形态**没有自己的 deny 列表**，
 * 于是它就是一条"绕过一切 deny"的通道。写回路径已由
 * `InteractivePermissionEngine.rememberRule` 修为不再产生 string；这一层兜住**手写**的 string。
 *
 * 语义边界：**只收紧不放宽**。默认全局是 `'*': 'ask'`（string）⇒ 不触发，逐位不变；
 * 只有显式把全局写成 PathRules 且带 `deny` 时才生效。
 */
describe('DefaultPermissionEngine · 全局 deny 否决 string 形态（P0-8 配套）', () => {
  it('★工具规则是 string allow 时，全局 deny 仍能拦下段级命令', async () => {
    const e = new DefaultPermissionEngine({ bash: 'allow', '*': { deny: ['shutdown*'] } })
    const res = await e.check({
      toolKey: 'bash',
      patterns: ['echo hi; shutdown -h now'],
      input: {},
      denyPatterns: ['echo hi', 'shutdown -h now'],
    })
    expect(res.behavior).toBe('deny')
    expect(res.matchedRule).toBe('global')
    expect(res.matchedPattern).toBe('shutdown -h now')
  })

  it('工具规则是 string allow 且全局无 deny ⇒ 仍 allow（默认 `*: ask` 行为逐位不变）', async () => {
    const e = new DefaultPermissionEngine({ bash: 'allow', '*': 'ask' })
    const res = await e.check({ toolKey: 'bash', patterns: ['anything'], input: {}, denyPatterns: ['anything'] })
    expect(res.behavior).toBe('allow')
  })

  it('全局 deny 未命中时不干预：工具 PathRules 的 allow 照常生效', async () => {
    const e = new DefaultPermissionEngine({ bash: { allow: ['ls*'] }, '*': { deny: ['shutdown*'] } })
    const res = await e.check({ toolKey: 'bash', patterns: ['ls -la'], input: {} })
    expect(res.behavior).toBe('allow')
  })

  it('全局 deny 对**普通 PathRules** 工具规则同样有效（不只针对 string）', async () => {
    const e = new DefaultPermissionEngine({ bash: { allow: ['echo*'] }, '*': { deny: ['shutdown*'] } })
    const res = await e.check({
      toolKey: 'bash',
      patterns: ['echo hi; shutdown -h now'],
      input: {},
      denyPatterns: ['echo hi', 'shutdown -h now'],
    })
    expect(res.behavior).toBe('deny')
    expect(res.matchedPattern).toBe('shutdown -h now')
  })
})

/**
 * 归属分层（P0-9）：`session:<sid>|<tool>` / `caller:<hash>|<tool>` 只在**匹配到归属**时才参与。
 *
 * 基类 `resolvePrincipalKey` 缺省返回 `undefined` ⇒ 只有工具键 / 全局键两层参与 —— 与分层前
 * 逐位相同。这里钉死的是一条**安全性质**：无归属时，别人（别的会话/调用方）的作用域规则
 * **绝不能**被误用（宁可不命中、回落到全局 ask 问人，也不能放行）。
 */
describe('DefaultPermissionEngine · 归属分层（P0-9）', () => {
  it('★无 sessionId / 无主体时，作用域键被忽略（不误用别人的规则）', async () => {
    const e = new DefaultPermissionEngine({
      'caller:deadbeefdeadbeef|bash': { allow: ['ls'] },
      'session:s-other|bash': { allow: ['ls'] },
      '*': 'ask',
    })
    const res = await e.check({ toolKey: 'bash', patterns: ['ls'], input: {} })
    expect(res.behavior).toBe('ask') // 不是 allow
    expect(res.matchedRule).toBe('global')
  })

  it('会话键命中：匹配到 sessionId 才生效，且 `matchedScope=session`', async () => {
    const e = new DefaultPermissionEngine({
      bash: 'deny',
      'session:sA|bash': { allow: ['ls'] },
    })
    const hit = await e.check({ toolKey: 'bash', patterns: ['ls'], input: {}, sessionId: 'sA' })
    expect(hit.behavior).toBe('allow')
    expect(hit.matchedScope).toBe('session')
    // 另一个会话 ⇒ 落回全局工具层 deny
    const miss = await e.check({ toolKey: 'bash', patterns: ['ls'], input: {}, sessionId: 'sB' })
    expect(miss.behavior).toBe('deny')
    expect(miss.matchedScope).toBeUndefined()
  })

  it('作用域通配的 deny 有否决权：`session:<sid>|*` 拦下同会话的 string allow', async () => {
    const e = new DefaultPermissionEngine({
      'session:sA|bash': 'allow',
      'session:sA|*': { deny: ['shutdown*'] },
    })
    const res = await e.check({
      toolKey: 'bash',
      patterns: ['echo hi; shutdown -h now'],
      input: {},
      sessionId: 'sA',
      denyPatterns: ['echo hi', 'shutdown -h now'],
    })
    expect(res.behavior).toBe('deny')
    expect(res.matchedPattern).toBe('shutdown -h now')
  })
})
