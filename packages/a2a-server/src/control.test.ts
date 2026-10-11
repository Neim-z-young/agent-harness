/**
 * 控制面（`POST /harness/rpc`）用例。
 *
 * ## 为什么绝大多数用例直接调 `dispatchControl` 而不是发 HTTP
 * 控制面**没有 SSE**、没有出参翻译、没有流式分帧 —— 也就是说 server.test.ts 里那条
 * "必须走真网线"的理由在这里不成立。控制面真正会出错的地方是**参数校验与 host 调用次序**
 * （例如"`reset` 与 `key+behavior` 同时给会怎样"），这些在 `dispatchControl` 这一层就能钉死，
 * 且不必为每条用例起端口。
 * 路由 / 鉴权 / 尾斜杠 / 与协议面互不串线这几条**属于 HTTP 层**，放在 `server.test.ts` 里
 * 走真实 fetch（那里已有整套 HTTP 夹具）。
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition } from '@harness/core'
import { defineTool } from '@harness/core'
import { HarnessHost, type Host } from '@harness/host'
import { fromJsonSchema } from '@harness/tool'
import { ControlError, dispatchControl, listControlMethods, type ControlErrorCode } from './control'
import { wrapAskerWithControlApproval } from './control-approval'

// ========================================================================
// 夹具
// ========================================================================

const OTHER_AGENT: AgentDefinition = {
  id: 'other',
  name: '另一个 Agent',
  description: '测试用',
  mode: 'primary',
  tools: ['*'],
  permission: { '*': 'allow' },
  promptFragments: ['You are the other agent.'],
}

const hosts: Host[] = []
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
  hosts.length = 0
})

async function makeHost(): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-ctl-'))
  dirs.push(dir)
  const host = new HarnessHost({
    cwd: dir,
    dataDir: join(dir, '.harness'),
    agentId: 'default',
    provider: 'mock',
    permissionMode: 'ask',
    mockProviderConfig: { defaultResponse: '你好世界' },
    agents: [OTHER_AGENT],
    autoResume: false,
    backgroundPreload: false,
  })
  await host.boot()
  hosts.push(host)
  return host
}

async function expectControlError(fn: () => Promise<unknown>, code: ControlErrorCode): Promise<ControlError> {
  let err: unknown
  try {
    await fn()
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(ControlError)
  expect((err as ControlError).controlCode).toBe(code)
  return err as ControlError
}

const call = (host: Host, method: string, params?: unknown) => dispatchControl(host, method, params)

// ========================================================================
// 注册表
// ========================================================================

describe('控制面：注册表', () => {
  it('全部方法名以 harness/ 开头，且清单稳定可枚举（客户端能力探测的依据）', () => {
    const methods = listControlMethods()
    expect(methods.length).toBeGreaterThanOrEqual(14)
    for (const m of methods) expect(m.startsWith('harness/')).toBe(true)
    // 排序稳定 ⇒ 两次调用逐字相同（UI 直接渲染清单时不会跳序）
    expect(listControlMethods()).toEqual(methods)
    expect(methods).toContain('harness/notice.list')
    expect(methods).toContain('harness/permission.set')
  })

  it('未知方法 ⇒ METHOD_NOT_FOUND，且把可用清单带回给客户端', async () => {
    const host = await makeHost()
    const err = await expectControlError(() => call(host, 'harness/nope'), 'METHOD_NOT_FOUND')
    expect(err.jsonRpcCode).toBe(-32601)
    expect(err.detail?.available).toBeArray()
  })

  it('不带 harness/ 前缀的方法 ⇒ 也是 METHOD_NOT_FOUND，但文案指出命名空间要求', async () => {
    const host = await makeHost()
    const err = await expectControlError(() => call(host, 'compact'), 'METHOD_NOT_FOUND')
    expect(err.message).toContain('harness/')
  })

  it('params 不是对象 ⇒ INVALID_PARAMS（而不是静默当空对象）', async () => {
    const host = await makeHost()
    await expectControlError(() => call(host, 'harness/notice.list', [1, 2]), 'INVALID_PARAMS')
    // 不传 params 是合法的（等价空对象）
    const ok = (await call(host, 'harness/notice.list')) as { notices: unknown[] }
    expect(Array.isArray(ok.notices)).toBe(true)
  })
})

// ========================================================================
// 诊断（plan §6 遗留：让"降级事实"到达调用方）
// ========================================================================

describe('控制面：harness/notice.list', () => {
  it('装配期事实可回读，且每条都带服务端渲染好的 text（文案只有一份实现）', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/notice.list')) as {
      notices: Array<{ level: string; code: string; data: unknown; text: string }>
      total: number
    }
    expect(res.total).toBeGreaterThanOrEqual(1)
    const codes = res.notices.map((n) => n.code)
    // mock provider 的启动横幅是 notice 级、且 boot 里无条件发
    expect(codes).toContain('provider.default-chosen')
    for (const n of res.notices) {
      expect(['notice', 'warn', 'log']).toContain(n.level)
      expect(typeof n.text).toBe('string')
      expect(n.text.endsWith('\n')).toBe(true)
    }
  })

  it('按 level 过滤 + limit 取尾部（limit 是非正整数 ⇒ INVALID_PARAMS）', async () => {
    const host = await makeHost()
    const all = (await call(host, 'harness/notice.list')) as { total: number }
    const notices = (await call(host, 'harness/notice.list', { level: 'notice' })) as {
      notices: Array<{ level: string }>
    }
    expect(notices.notices.length).toBeLessThanOrEqual(all.total)
    for (const n of notices.notices) expect(n.level).toBe('notice')

    const one = (await call(host, 'harness/notice.list', { limit: 1 })) as { notices: unknown[] }
    expect(one.notices.length).toBe(1)

    await expectControlError(() => call(host, 'harness/notice.list', { limit: 0 }), 'INVALID_PARAMS')
    await expectControlError(() => call(host, 'harness/notice.list', { level: 'nope' }), 'INVALID_PARAMS')
  })
})

// ========================================================================
// 权限
// ========================================================================

describe('控制面：权限', () => {
  it('get 返回模式与规则（默认 ask + 全局 ask）', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/permission.get')) as {
      mode: string
      rules: Record<string, unknown>
    }
    expect(res.mode).toBe('ask')
    expect(res.rules['*']).toBe('ask')
  })

  it('key+behavior 增改并**落盘**（重启后仍在）', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/permission.set', { key: 'bash', behavior: 'deny' })) as {
      rules: Record<string, unknown>
    }
    expect(res.rules['bash']).toBe('deny')
    const written = JSON.parse(readFileSync(host.permissionStorePath, 'utf-8')) as {
      rules: Record<string, unknown>
    }
    expect(written.rules['bash']).toBe('deny')
    // 原规则没被覆盖掉（是"增改"不是"替换"）
    expect(written.rules['*']).toBe('ask')
  })

  it('mode 切换只动模式、不动规则文件', async () => {
    const host = await makeHost()
    await call(host, 'harness/permission.set', { key: 'bash', behavior: 'deny' })
    const res = (await call(host, 'harness/permission.set', { mode: 'allow-all' })) as {
      mode: string
      rules: Record<string, unknown>
    }
    expect(res.mode).toBe('allow-all')
    expect(res.rules['bash']).toBe('deny')
  })

  it('mode 带 sessionId ⇒ 只改该会话（P2-7）；不带 ⇒ 改进程默认', async () => {
    const host = await makeHost()
    const sid = host.session.id
    // 会话级：本会话变 allow-all，进程默认不动
    const r1 = (await call(host, 'harness/permission.set', { mode: 'allow-all', sessionId: sid })) as {
      mode: string
    }
    expect(r1.mode).toBe('allow-all')
    expect(host.permission.getMode()).toBe('ask')
    // 读也按会话读：给了 sessionId 读该会话，不给读进程默认
    const g = (await call(host, 'harness/permission.get', { sessionId: sid })) as { mode: string }
    expect(g.mode).toBe('allow-all')
    const d = (await call(host, 'harness/permission.get')) as { mode: string }
    expect(d.mode).toBe('ask')
  })

  it('rules 整份替换（CLI 表达不了的"删掉某条"）', async () => {
    const host = await makeHost()
    await call(host, 'harness/permission.set', { key: 'bash', behavior: 'deny' })
    const res = (await call(host, 'harness/permission.set', { rules: { '*': 'ask' } })) as {
      rules: Record<string, unknown>
    }
    expect(res.rules['bash']).toBeUndefined()
  })

  it('reset 回到「全局 ask + 空规则」并写盘', async () => {
    const host = await makeHost()
    await call(host, 'harness/permission.set', { key: 'bash', behavior: 'deny', mode: 'deny-all' })
    const res = (await call(host, 'harness/permission.set', { reset: true })) as {
      mode: string
      rules: Record<string, unknown>
    }
    expect(res.mode).toBe('ask')
    expect(res.rules).toEqual({ '*': 'ask' })
  })

  it('非法 / 空入参一律结构化拒绝（不留"看起来成功但什么都没改"的路径）', async () => {
    const host = await makeHost()
    await expectControlError(() => call(host, 'harness/permission.set', {}), 'INVALID_PARAMS')
    await expectControlError(
      () => call(host, 'harness/permission.set', { key: 'bash', behavior: 'maybe' }),
      'INVALID_PARAMS',
    )
    await expectControlError(
      () => call(host, 'harness/permission.set', { key: 'bash' }),
      'INVALID_PARAMS',
    )
    await expectControlError(
      () => call(host, 'harness/permission.set', { mode: 'sometimes' }),
      'INVALID_PARAMS',
    )
    await expectControlError(
      () => call(host, 'harness/permission.set', { rules: ['x'] }),
      'INVALID_PARAMS',
    )
  })
})

// ========================================================================
// Agent
// ========================================================================

describe('控制面：Agent', () => {
  it('list 标出当前 Agent（只改本会话）', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/agent.list')) as {
      sessionId: string
      current: string
      agents: Array<{ id: string; name: string; current: boolean }>
    }
    expect(res.sessionId).toBe(host.session.id)
    expect(res.current).toBe('default')
    expect(res.agents.map((a) => a.id).sort()).toEqual(['default', 'other'])
    expect(res.agents.find((a) => a.id === 'default')?.current).toBe(true)
    expect(res.agents.find((a) => a.id === 'other')?.current).toBe(false)
  })

  it('set 写会话并**立即落盘**（切完就退出也不丢）', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/agent.set', { agentId: 'other' })) as {
      ok: boolean
      agentId: string
    }
    expect(res.ok).toBe(true)
    expect(res.agentId).toBe('other')
    const saved = JSON.parse(readFileSync(host.sessionStore.pathFor(host.session.id), 'utf-8')) as {
      agentId?: string
    }
    expect(saved.agentId).toBe('other')
    // 再读一次 list：当前项跟着变
    const after = (await call(host, 'harness/agent.list')) as { current: string }
    expect(after.current).toBe('other')
  })

  it('set 未注册的 Agent ⇒ INVALID_PARAMS 且带上可用清单', async () => {
    const host = await makeHost()
    const err = await expectControlError(
      () => call(host, 'harness/agent.set', { agentId: 'ghost' }),
      'INVALID_PARAMS',
    )
    expect(err.detail?.available).toEqual(['default', 'other'])
  })
})

// ========================================================================
// 模型
// ========================================================================

describe('控制面：模型', () => {
  it('get 报出来源（agent / session）与覆盖内容', async () => {
    const host = await makeHost()
    const before = (await call(host, 'harness/model.get')) as {
      sessionId: string
      agentId: string
      source: string
      override: unknown
    }
    expect(before.sessionId).toBe(host.session.id)
    expect(before.agentId).toBe('default')
    expect(before.source).toBe('agent')
    expect(before.override).toBeNull()

    await call(host, 'harness/model.set', { modelId: 'gpt-4o-mini' })
    const after = (await call(host, 'harness/model.get')) as {
      source: string
      override: { modelId: string } | null
      current: string
    }
    expect(after.source).toBe('session')
    expect(after.override?.modelId).toBe('gpt-4o-mini')
    expect(after.current).toBe('gpt-4o-mini')
  })

  it('set 结构化入参：providerId+modelId 合串展示，随会话落盘', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/model.set', { providerId: 'mock', modelId: 'mock-a' })) as {
      ok: boolean
      scope: string
      current: string
    }
    expect(res.ok).toBe(true)
    expect(res.scope).toBe('session')
    expect(res.current).toBe('mock/mock-a')
    const saved = JSON.parse(readFileSync(host.sessionStore.pathFor(host.session.id), 'utf-8')) as {
      meta?: Record<string, unknown>
    }
    expect(JSON.stringify(saved.meta)).toContain('mock-a')
  })

  it('reset 清除会话覆盖、回到 Agent 绑定', async () => {
    const host = await makeHost()
    await call(host, 'harness/model.set', { modelId: 'gpt-4o-mini' })
    const res = (await call(host, 'harness/model.set', { reset: true })) as {
      ok: boolean
      cleared: boolean
      current: string
    }
    expect(res.ok).toBe(true)
    expect(res.cleared).toBe(true)
    expect(res.current).not.toBe('gpt-4o-mini')
    const after = (await call(host, 'harness/model.get')) as { source: string; override: unknown }
    expect(after.source).toBe('agent')
    expect(after.override).toBeNull()
  })

  it('global 写 Agent 全局默认（并落 config.json）', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/model.set', {
      providerId: 'mock',
      modelId: 'mock-global',
      global: true,
    })) as { ok: boolean; scope: string; current: string }
    expect(res.ok).toBe(true)
    expect(res.scope).toBe('global')
    expect(res.current).toBe('mock/mock-global')
    const cfg = JSON.parse(readFileSync(join(host.workspace.dataDir, 'config.json'), 'utf-8')) as {
      model?: string
      provider?: string
    }
    expect(cfg.model).toBe('mock-global')
    expect(cfg.provider).toBe('mock')
  })

  it('两个字段都不给 ⇒ INVALID_PARAMS（不接受"空切换"）', async () => {
    const host = await makeHost()
    const err = await expectControlError(() => call(host, 'harness/model.set', {}), 'INVALID_PARAMS')
    expect(err.message).toContain('reset')
  })
})

// ========================================================================
// 会话
// ========================================================================

describe('控制面：会话', () => {
  it('list 标出当前会话与"属于本目录"', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/session.list')) as {
      cwd: string
      current: string
      pointer: string | null
      sessions: Array<{ id: string; isCurrent: boolean; isCwd: boolean }>
    }
    expect(res.cwd).toBe(host.workspace.cwd)
    expect(res.current).toBe(host.session.id)
    const cur = res.sessions.find((s) => s.id === host.session.id)
    expect(cur?.isCurrent).toBe(true)
  })

  it('当前会话还没落盘时也在 list 里（0 消息的新会话不写文件）', async () => {
    const host = await makeHost()
    // boot 出来的会话是 0 消息 ⇒ 磁盘上没有它的文件（boot 不再无条件落盘）
    expect(await host.sessionStore.load(host.session.id)).toBeUndefined()

    // 于是 list 不能只照抄磁盘目录 —— 否则 `isCurrent` 无处可挂，消费方
    // 打开面板第一眼就是"当前会话不在列表里"。
    const res = (await call(host, 'harness/session.list')) as {
      current: string
      sessions: Array<{ id: string; isCurrent: boolean; messageCount: number }>
    }
    const cur = res.sessions.find((s) => s.id === res.current)
    expect(cur).toBeDefined()
    expect(cur?.isCurrent).toBe(true)
    expect(cur?.messageCount).toBe(0)
  })

  it('get 未 boot 之外的未知会话 ⇒ NOT_FOUND', async () => {
    const host = await makeHost()
    await expectControlError(() => call(host, 'harness/session.get', { sessionId: 's_不存在' }), 'NOT_FOUND')
  })

  it('new 换绑到新会话并**继承会话级模型覆盖**（切完模型再开新会话不该像设置被重置）', async () => {
    const host = await makeHost()
    await call(host, 'harness/model.set', { modelId: 'gpt-4o-mini' })
    const oldId = host.session.id
    const res = (await call(host, 'harness/session.new')) as {
      sessionId: string
      carriedModelOverride: boolean
      model: string
    }
    expect(res.sessionId).not.toBe(oldId)
    expect(res.carriedModelOverride).toBe(true)
    expect(res.model).toBe('gpt-4o-mini')
    // 新会话已落盘，且旧的仍在
    const list = (await call(host, 'harness/session.list')) as {
      sessions: Array<{ id: string }>
      pointer: string | null
    }
    expect(list.sessions.map((s) => s.id)).toContain(res.sessionId)
    expect(list.sessions.map((s) => s.id)).toContain(oldId)
    // 项目级指针指向新会话
    expect(list.pointer).toBe(res.sessionId)
  })

  it('resume 恢复指定会话并写回项目指针；不存在的 id ⇒ NOT_FOUND', async () => {
    const host = await makeHost()
    const firstId = host.session.id
    await call(host, 'harness/session.new')
    const res = (await call(host, 'harness/session.resume', { id: firstId })) as { sessionId: string }
    expect(res.sessionId).toBe(firstId)
    const list = (await call(host, 'harness/session.list')) as { pointer: string | null }
    expect(list.pointer).toBe(firstId)

    await expectControlError(() => call(host, 'harness/session.resume', { id: 's_无' }), 'NOT_FOUND')
  })

  it('new 指定未注册的 Agent ⇒ INVALID_PARAMS', async () => {
    const host = await makeHost()
    await expectControlError(
      () => call(host, 'harness/session.new', { agentId: 'ghost' }),
      'INVALID_PARAMS',
    )
  })
})

// ========================================================================
// 技能 / 压缩
// ========================================================================

describe('控制面：技能与压缩', () => {
  it('skill.list 在未启用技能系统时返回空数组（不是报错）', async () => {
    const host = await makeHost()
    const res = await call(host, 'harness/skill.list')
    expect(Array.isArray(res)).toBe(true)
  })

  it('skill.set 校验 op 与 id 的存在性（不存在的技能 = ok:false，不是异常）', async () => {
    const host = await makeHost()
    await expectControlError(() => call(host, 'harness/skill.set', { op: 'nope', id: 'x' }), 'INVALID_PARAMS')
    await expectControlError(() => call(host, 'harness/skill.set', { op: 'enable' }), 'INVALID_PARAMS')
    const res = (await call(host, 'harness/skill.set', { op: 'disable', id: 'ghost' })) as {
      ok: boolean
      message: string
    }
    expect(res.ok).toBe(false)
    expect(typeof res.message).toBe('string')
  })

  it('compact：空会话未达阈值 ⇒ did:false，且带回策略与计数', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/compact', { strategy: 'ifneeded' })) as {
      did: boolean
      sessionId: string
      strategy: string
      info: { count: number; round: number }
    }
    expect(res.did).toBe(false)
    expect(res.sessionId).toBe(host.session.id)
    expect(res.strategy).toBe('ifneeded')
    expect(res.info.count).toBe(0)
    // 缺省策略就是 ifneeded（与 CLI `/compact` 无参一致）
    const dflt = (await call(host, 'harness/compact')) as { strategy: string }
    expect(dflt.strategy).toBe('ifneeded')
  })
})

// ========================================================================
// 统计（harness/stats.get）
// ========================================================================

describe('控制面：harness/stats.get', () => {
  it('出参同时有结构化字段与服务端渲染的整页 text（渲染文案只有宿主一份）', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/stats.get')) as {
      usage: { llmCalls: number }
      today: { llmCalls: number }
      rollupText: string
      occupancyText: string
      text: string
    }
    expect(res.usage).toBeObject()
    expect(res.today).toBeObject()
    // 空会话没有子 agent ⇒ 聚合行为空串（不占版面，与 CLI 一致）
    expect(res.rollupText).toBe('')
    // 占用区至少有本会话一行，且带窗口/阈值口径
    expect(res.occupancyText).toContain('上下文占用')
    expect(res.occupancyText).toContain('自动压缩阈值')
    // 整页 text 按 CLI `/stats` 的段落顺序拼装
    expect(res.text).toContain('上下文占用')
    expect(res.text).toContain('（全部会话·当日）')
  })

  it('子 agent 用量进入 rollupText（children 按 Session.parentId 反查 + 展示层聚合）', async () => {
    const host = await makeHost()
    const child = await host.harness.session.create({ parentId: host.session.id })
    // 引擎是唯一累加者（UsageAccessor 只读）；测试里直接写 meta.usageStats 模拟"子会话已跑过"
    await host.harness.session.updateMeta(child.id, {
      usageStats: {
        llmCalls: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
        models: [], tools: [], agents: [], hourly: [],
      },
    })
    const res = (await call(host, 'harness/stats.get')) as { rollupText: string }
    expect(res.rollupText).toContain('1 个子会话')
    expect(res.rollupText).toContain('调用 2 次')
    expect(res.rollupText).toContain('in 100 / out 50')
  })

  it('sessionId 可寻址到落盘会话（与其它方法同一条 readSessionView 路径）', async () => {
    const host = await makeHost()
    const saved = host.session
    await host.sessionStore.save(saved)
    const res = (await call(host, 'harness/stats.get', { sessionId: saved.id })) as {
      occupancyText: string
    }
    expect(res.occupancyText).toContain('上下文占用')
    await expectControlError(() => call(host, 'harness/stats.get', { sessionId: 'ghost-id' }), 'NOT_FOUND')
  })
})

// ========================================================================
// 会话保存 / 目录树 / 统计导出（harness/session.save、tree.get、stats.export）
// ========================================================================

describe('控制面：harness/session.save（P2-v2）', () => {
  it('把当前会话立即落盘（messageCount 回传）', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/session.save')) as { ok: boolean; id: string; messageCount: number }
    expect(res.ok).toBe(true)
    expect(res.id).toBe(host.session.id)
    expect(typeof res.messageCount).toBe('number')
    // 落盘可验证：sessionStore 能读回同一条
    const saved = await host.sessionStore.load(res.id)
    expect(saved?.id).toBe(res.id)
  })

  it('sessionId 不可寻址 → NOT_FOUND', async () => {
    const host = await makeHost()
    await expectControlError(() => call(host, 'harness/session.save', { sessionId: 'ghost' }), 'NOT_FOUND')
  })
})

describe('控制面：harness/tree.get（P2-v2）', () => {
  it('返回磁盘树结构化节点 + CLI 口径 text；会话引用过的文件带 marked', async () => {
    const host = await makeHost()
    // 在工作目录里摆 src/a.txt 与 b.txt，并让会话引用其一（路径与磁盘一致才会标 *，CLI 同语义）
    const ws = host.workspace.cwd
    await mkdir(join(ws, 'src'), { recursive: true })
    await writeFile(join(ws, 'src', 'a.txt'), 'a')
    await writeFile(join(ws, 'b.txt'), 'b')
    const cur = (await host.harness.session.get(host.session.id))!
    cur.messages.push({
      id: 'm1', role: 'user', createdAt: Date.now(),
      parts: [{ type: 'text', text: '请看 src/a.txt 和 packages/x/index.ts' }],
    } as never)
    const res = (await call(host, 'harness/tree.get')) as {
      root: string; refs: string[]; truncated: boolean; marked: boolean
      nodes: Array<{ name: string; children: Array<{ name: string; marked?: boolean; children?: Array<{ name: string; marked?: boolean }> }> }>
      text: string
    }
    expect(res.root).toBe(ws)
    expect(res.refs.some((r) => r.startsWith('src/a.txt'))).toBe(true)
    expect(res.marked).toBe(true)
    const topNames = res.nodes.flatMap((n) => n.children.map((c) => c.name))
    expect(topNames).toContain('src')
    expect(topNames).toContain('b.txt')
    const srcDir = res.nodes.flatMap((n) => n.children).find((c) => c.name === 'src')
    const a = srcDir?.children?.find((c) => c.name === 'a.txt')
    expect(a?.marked).toBe(true)
    const b = res.nodes.flatMap((n) => n.children).find((c) => c.name === 'b.txt')
    expect(b?.marked).toBeFalsy()
    expect(res.text).toContain('文件树')
    expect(res.text).toContain('a.txt*')
  })

  it('root 参数指向不存在的目录 → INVALID_PARAMS', async () => {
    const host = await makeHost()
    await expectControlError(
      () => call(host, 'harness/tree.get', { root: '/nonexistent-dir-xyz' }),
      'INVALID_PARAMS',
    )
  })
})

describe('控制面：harness/stats.export（P2-v2）', () => {
  it('默认 markdown：写入工作目录并回传 path；内容是渲染好的统计报告', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/stats.export')) as { ok: boolean; path: string; bytes: number }
    expect(res.ok).toBe(true)
    expect(res.path.endsWith('.md')).toBe(true)
    const content = await readFile(res.path, 'utf8')
    expect(Buffer.byteLength(content, 'utf8')).toBe(res.bytes)
    expect(content).toContain('# 会话用量统计报告')
    expect(content).toContain('| LLM 调用次数（单轮对话） |')
  })

  it('format=json：导出 JSON 且可解析', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/stats.export', { format: 'json' })) as { path: string }
    expect(res.path.endsWith('.json')).toBe(true)
    const parsed = JSON.parse(await readFile(res.path, 'utf8')) as { sessionId?: string }
    expect(parsed).toBeObject()
  })
})

// ========================================================================
// 工具暴露（P3-D，设计稿 §14）
// ========================================================================

describe('控制面：harness/tools.*（P3-D）', () => {
  /**
   * 注册一个测试工具。
   *
   * ⚠️ `permission` 决定**权限链是否启动**：`ToolPipeline` 只在
   * 「工具声明了 `permission` 且有 `checkPermission`」时才构造 `PermissionRequest`
   * （`packages/tool/src/index.ts:1337`）。不声明 ⇒ 整条 check → ask → asker 短路，
   * 于是"未 approve 会被拒"这类用例会静默退化成"一律放行"。真实写工具都声明了它。
   */
  function installTool(host: Host, id: string, opts: { readOnly?: boolean; permission?: boolean } = {}): void {
    host.harness.tools.register(
      defineTool({
        id,
        description: `${id} 的说明`,
        inputSchema: fromJsonSchema<{ msg?: string }>({ type: 'object', properties: { msg: { type: 'string' } } }),
        ...(opts.readOnly ? { isReadOnly: () => true } : {}),
        ...(opts.permission ? { permission: { key: id, extractPatterns: () => [] } } : {}),
        async call() {
          return { ok: true as const, output: `${id}:done` }
        },
      }),
      { override: true },
    )
  }

  /**
   * 复刻 `server.ts` 的接线：**内层是 A2A asker**（在 A2A 任务上下文之外 ⇒ 返回 `undefined`
   * ⇒ 引擎按 deny 处理）。返回的计数器用来区分"短路"与"委派"——
   * 这正是本组用例真正在测的东西。
   */
  function installAsker(host: Host): { calls: number } {
    const spy = { calls: 0 }
    host.permission.setAsker(
      wrapAskerWithControlApproval(async () => {
        spy.calls += 1
        return undefined
      }),
    )
    return spy
  }

  it('tools.list：列出已注册工具，并给出 readOnly / requiresConfirmation 判定', async () => {
    const host = await makeHost()
    installTool(host, 'echo_ro', { readOnly: true })
    installTool(host, 'echo_write', { permission: true })
    // 只读 **且** 声明 permission —— 真实的 `read_file` 就是这个形状。它照样会落到 ask，
    // 故 requiresConfirmation 必须为 true（判据与权限链启动条件一致，与只读无关）。
    installTool(host, 'echo_ro_perm', { readOnly: true, permission: true })

    const res = (await call(host, 'harness/tools.list')) as { tools: Array<Record<string, unknown>> }
    const byName = new Map(res.tools.map((t) => [t['name'] as string, t]))
    expect(byName.get('echo_ro')).toMatchObject({ readOnly: true, requiresConfirmation: false })
    expect(byName.get('echo_ro_perm')).toMatchObject({ readOnly: true, requiresConfirmation: true })
    expect(byName.get('echo_write')).toMatchObject({ readOnly: false, requiresConfirmation: true })
    // 排序稳定（客户端 diff 不会误判"工具集变了"）
    expect(res.tools.map((t) => t['name'])).toEqual([...res.tools.map((t) => t['name'])].sort())
  })

  it('tools.call：未声明 permission 的工具直接跑通 —— 权限链根本不启动，也就没人问', async () => {
    const host = await makeHost()
    const asker = installAsker(host)
    installTool(host, 'echo_ro', { readOnly: true })

    const res = (await call(host, 'harness/tools.call', {
      sessionId: host.session.id,
      name: 'echo_ro',
      input: {},
    })) as Record<string, unknown>

    expect(res).toMatchObject({ ok: true, output: 'echo_ro:done' })
    expect(asker.calls).toBe(0)
  })

  it('tools.call：写工具 + 未 approve ⇒ **委派**给原 asker ⇒ 最终被拒（Fail-Closed）', async () => {
    const host = await makeHost()
    const asker = installAsker(host)
    installTool(host, 'echo_write', { permission: true })

    const res = (await call(host, 'harness/tools.call', {
      sessionId: host.session.id,
      name: 'echo_write',
      input: {},
    })) as { ok: boolean; error?: { code?: string } }

    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('PERMISSION_DENIED')
    // 关键：证明"没有 approve"走的是**委派**而不是"自己判拒绝"——
    // 若哪天有人把这里改成直接 deny，本断言会红（那会掩盖"谁在拒绝"）。
    expect(asker.calls).toBe(1)
  })

  it('tools.call：写工具 + approve ⇒ 放行，且**不打扰**原 asker（短路）', async () => {
    const host = await makeHost()
    const asker = installAsker(host)
    installTool(host, 'echo_write', { permission: true })

    const res = (await call(host, 'harness/tools.call', {
      sessionId: host.session.id,
      name: 'echo_write',
      input: {},
      approve: true,
    })) as Record<string, unknown>

    expect(res).toMatchObject({ ok: true, output: 'echo_write:done' })
    expect(asker.calls).toBe(0)
  })

  it('tools.call：静态规则已放行（allow-all）⇒ 不需要 approve 也能跑（approve 不是必经之路）', async () => {
    const host = await makeHost()
    const asker = installAsker(host)
    host.permission.setMode('allow-all')
    installTool(host, 'echo_write', { permission: true })

    const res = (await call(host, 'harness/tools.call', {
      sessionId: host.session.id,
      name: 'echo_write',
      input: {},
    })) as Record<string, unknown>

    expect(res).toMatchObject({ ok: true })
    expect(asker.calls).toBe(0)
  })

  it('tools.call：deny-all ⇒ 拒，**approve 也救不了**（approve 只影响 ask 阶段，不越过静态规则）', async () => {
    const host = await makeHost()
    installAsker(host)
    host.permission.setMode('deny-all')
    installTool(host, 'echo_write', { permission: true })

    const res = (await call(host, 'harness/tools.call', {
      sessionId: host.session.id,
      name: 'echo_write',
      input: {},
      approve: true,
    })) as { ok: boolean; error?: { code?: string } }

    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('PERMISSION_DENIED')
  })

  it('tools.call：会话不存在 ⇒ NOT_FOUND（**不回落 boot 会话**：归属不明就挑一个是静默失效）', async () => {
    const host = await makeHost()
    installTool(host, 'echo_ro', { readOnly: true })
    await expectControlError(
      () => call(host, 'harness/tools.call', { sessionId: 'sess-不存在', name: 'echo_ro', input: {} }),
      'NOT_FOUND',
    )
  })

  it('tools.call：形状错误 ⇒ 协议级错误（`input` 非对象 / 缺 sessionId / 工具名未知）', async () => {
    const host = await makeHost()
    installTool(host, 'echo_ro', { readOnly: true })

    await expectControlError(() => call(host, 'harness/tools.call', { name: 'echo_ro', input: {} }), 'INVALID_PARAMS')
    await expectControlError(
      () => call(host, 'harness/tools.call', { sessionId: host.session.id, name: 'echo_ro', input: [1, 2] }),
      'INVALID_PARAMS',
    )
    const err = await expectControlError(
      () => call(host, 'harness/tools.call', { sessionId: host.session.id, name: 'nope', input: {} }),
      'NOT_FOUND',
    )
    // 未知工具要把"有哪些"带回去，客户端才能纠错
    expect(err.detail?.available).toBeArray()
  })
})

// ========================================================================
// 工具池就绪 —— P3-D 的**前提**（本组是回归守卫，防止再次静默变空）
// ========================================================================

/**
 * 为什么单列一组：`makeHost()` 与 `runA2aCli` 一样用 `backgroundPreload:false`，
 * 也就是说**内置工具插件不会在 boot 时装配、工具也不会注册**。实测（改造前）：
 * `harness/tools.list` 返回 **0 个工具**，而失败形态是"清单为空"——静默、且看起来正常。
 *
 * 客户端那一侧更狠：编辑器扩展在**激活期**拿这份清单去 `lm.registerTool`，
 * 拿到空的就一个 LM 工具都注册不上，用户只看到"Copilot 里没有 harness 工具"。
 */
describe('控制面：工具池就绪（P3-D 的前提）', () => {
  it('backgroundPreload=false 的宿主（= A2A 服务端形态）里 tools.list 仍能列到内置工具', async () => {
    const host = await makeHost()
    const res = (await call(host, 'harness/tools.list')) as { tools: Array<{ name: string }> }
    const names = res.tools.map((t) => t.name)
    // 核心断言：**非空**。为空就是 P3-D 整体失效（0 个 LM 工具被注册）
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('read_file')
    expect(names).toContain('bash')
  })

  it('warmupBuiltins() 幂等：只跑一次，重复调用不重复装插件', async () => {
    const host = await makeHost()
    const first = await host.warmupBuiltins()
    const second = await host.warmupBuiltins()

    expect(first.tools).toBeGreaterThan(0)
    // 幂等的实现是"缓存首次结果"⇒ 两次拿到**同一个对象**（这才叫没重跑）
    expect(second).toBe(first)
    expect(host.warmupBuiltins()).toBe(host.warmupBuiltins())

    // 真正的"没重复装"看插件列表：装配后每个 id 只出现一次
    const ids = host.harness.plugin.list().map((p) => p.plugin.id)
    expect(ids.length).toBe(new Set(ids).size)
    // 第一次预热确实装了东西（否则上面的"没重名"就退化成"什么都没有"）
    expect(first.installed.length).toBeGreaterThan(0)
  })

  it('tools.list 每次读都先保证就绪 ⇒ 两次调用的清单一致（不会"第一次空、第二次才有"）', async () => {
    const host = await makeHost()
    const a = (await call(host, 'harness/tools.list')) as { tools: Array<{ name: string }> }
    const b = (await call(host, 'harness/tools.list')) as { tools: Array<{ name: string }> }
    expect(b.tools.map((t) => t.name)).toEqual(a.tools.map((t) => t.name))
  })
})
