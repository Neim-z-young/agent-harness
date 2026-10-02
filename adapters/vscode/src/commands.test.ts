/**
 * `commands.ts`（斜杠命令解析与渲染）的纯单测 —— 不起 sidecar、不碰 vscode。
 *
 * 语义锚点：命令词法对齐 CLI（`/compact [strategy]`、`/permission k=v`、
 * `/model <序号|provider/model|reset>`），结构化入参对齐 `packages/a2a-server/src/control.ts`。
 */
import { describe, it, expect } from 'bun:test'
import {
  planCommand,
  renderCommandHelp,
  renderControlResult,
  renderWarnNotices,
  resolveModelSpec,
  SLASH_COMMANDS,
  type ConfiguredProvider,
} from './commands'

const CONFIGURED: ConfiguredProvider[] = [
  { index: 1, id: 'anthropic', model: 'claude-sonnet-4-5' },
  { index: 2, id: 'glm', model: 'hy3' },
  { index: 3, id: 'openai', model: 'gpt-5.1' },
]

describe('planCommand：单次调用', () => {
  it('/compact：无参 → ifneeded 缺省；auto 别名；非法策略报用法', () => {
    expect(planCommand('compact', '')).toEqual({
      kind: 'call',
      call: { method: 'harness/compact', params: {} },
    })
    expect(planCommand('compact', 'auto')).toEqual({
      kind: 'call',
      call: { method: 'harness/compact', params: { strategy: 'ifneeded' } },
    })
    expect(planCommand('compact', 'summary')).toEqual({
      kind: 'call',
      call: { method: 'harness/compact', params: { strategy: 'summary' } },
    })
    expect(planCommand('compact', 'nope')).toMatchObject({ kind: 'unknown' })
  })

  it('/stats：无参 → harness/stats.get', () => {
    expect(planCommand('stats', '')).toEqual({
      kind: 'call',
      call: { method: 'harness/stats.get', params: {} },
    })
    expect(planCommand('stats', '多余参数')).toMatchObject({ kind: 'unknown' })
  })

  it('/agent：无参 list；带 id set', () => {
    expect(planCommand('agent', '')).toMatchObject({ call: { method: 'harness/agent.list' } })
    expect(planCommand('agent', 'other')).toMatchObject({
      call: { method: 'harness/agent.set', params: { agentId: 'other' } },
    })
  })

  it('/model：无参 get；reset；其余进入 model-resolve 两段计划', () => {
    expect(planCommand('model', '')).toMatchObject({ call: { method: 'harness/model.get' } })
    expect(planCommand('model', 'reset')).toMatchObject({
      call: { method: 'harness/model.set', params: { reset: true } },
    })
    expect(planCommand('model', 'hy3')).toEqual({ kind: 'model-resolve', spec: 'hy3' })
  })

  it('/permission：get / mode / k=v / reset / 非法', () => {
    expect(planCommand('permission', '')).toMatchObject({ call: { method: 'harness/permission.get' } })
    expect(planCommand('permission', 'reset')).toMatchObject({
      call: { method: 'harness/permission.set', params: { reset: true } },
    })
    expect(planCommand('permission', 'ask')).toMatchObject({
      call: { method: 'harness/permission.set', params: { mode: 'ask' } },
    })
    expect(planCommand('permission', 'bash=deny')).toMatchObject({
      call: { method: 'harness/permission.set', params: { key: 'bash', behavior: 'deny' } },
    })
    // 非法 behavior
    expect(planCommand('permission', 'bash=sometimes')).toMatchObject({ kind: 'unknown' })
    // 纯文本既不是 mode 也不是 k=v
    expect(planCommand('permission', 'hello')).toMatchObject({ kind: 'unknown' })
  })

  it('/skills：list / op+id / 非法', () => {
    expect(planCommand('skills', '')).toMatchObject({ call: { method: 'harness/skill.list' } })
    expect(planCommand('skills', 'disable web-search')).toMatchObject({
      call: { method: 'harness/skill.set', params: { op: 'disable', id: 'web-search' } },
    })
    expect(planCommand('skills', 'frobnicate web-search')).toMatchObject({ kind: 'unknown' })
  })

  it('宿主把整行塞进 prompt 时剥掉前导命令名（不假设切分行为）', () => {
    expect(planCommand('permission', 'permission bash=deny')).toMatchObject({
      call: { params: { key: 'bash', behavior: 'deny' } },
    })
    expect(planCommand('model', '/model glm/hy3')).toEqual({ kind: 'model-resolve', spec: 'glm/hy3' })
  })

  it('未知命令 → unknown', () => {
    expect(planCommand('nope', '')).toMatchObject({ kind: 'unknown' })
  })
})

describe('resolveModelSpec（/model 的歧义消解，输入词汇住扩展端）', () => {
  it('序号 → configured 清单命中（provider + model）', () => {
    expect(resolveModelSpec('2', CONFIGURED)).toEqual({ providerId: 'glm', modelId: 'hy3' })
  })

  it('序号越界 → 错误文案（带回 /model 提示）', () => {
    const err = resolveModelSpec('9', CONFIGURED)
    expect(typeof err).toBe('string')
    expect(err).toContain('/model')
  })

  it('provider/model 两段显式给出', () => {
    expect(resolveModelSpec('glm/hy3', CONFIGURED)).toEqual({ providerId: 'glm', modelId: 'hy3' })
  })

  it('裸名在清单里精确匹配 → 带上 provider；匹配不上 → 纯 modelId 交给 sidecar 判断', () => {
    expect(resolveModelSpec('hy3', CONFIGURED)).toEqual({ providerId: 'glm', modelId: 'hy3' })
    expect(resolveModelSpec('ghost-model', CONFIGURED)).toEqual({ modelId: 'ghost-model' })
  })
})

describe('renderControlResult：控制出参 → markdown', () => {
  it('/stats：直接展示服务端渲染的整页 text（不抄第二份统计渲染器）', () => {
    const out = renderControlResult('stats', { text: 'LLM 调用 3 次\n上下文占用：1 / 2 tokens' })
    expect(out).toContain('### /stats')
    expect(out).toContain('LLM 调用 3 次')
    // 必须走 text 分支渲染，而不是退化成 JSON 兜底（兜底会把整页塞进带转义的 JSON 字符串里）
    expect(out).not.toContain('"text"')
  })

  it('/agent：当前 agent 打勾 + 切换提示', () => {
    const out = renderControlResult('agent', {
      current: 'default',
      agents: [
        { id: 'default', name: '默认', description: '', model: 'mock', current: true },
        { id: 'other', name: '另一个', description: '测试用', model: null, current: false },
      ],
    })
    expect(out).toContain('✅')
    expect(out).toContain('`other`')
    expect(out).toContain('/agent <id>')
  })

  it('/model get：当前值 + 来源 + 可切换清单；set：作用域 + warning 块', () => {
    const get = renderControlResult('model', {
      current: 'glm/hy3',
      source: 'session',
      agentModel: 'mock',
      endpoint: { providerId: 'glm', modelId: 'hy3' },
      configured: CONFIGURED,
    })
    expect(get).toContain('本会话覆盖')
    expect(get).toContain('2. `glm` → `hy3`')

    const set = renderControlResult('model', {
      ok: true,
      scope: 'session',
      cleared: false,
      current: 'glm/hy3',
      warning: '当前进程未装配 Provider "glm"，实际将以 "mock" 发送',
    })
    expect(set).toContain('作用域：session')
    expect(set).toContain('> ⚠️ 当前进程未装配 Provider')
  })

  it('/permission：get 与 set 都渲染模式 + 规则表', () => {
    const get = renderControlResult('permission', { mode: 'ask', rules: { bash: 'deny', '*': 'ask' } })
    expect(get).toContain('模式：**ask**')
    expect(get).toContain('`bash` | deny')
  })

  it('/skills：清单表 + set 结果', () => {
    const list = renderControlResult('skills', [
      { id: 'web-search', name: '网页搜索', sourceLabel: '内置', enabled: true },
    ])
    expect(list).toContain('✅ | `web-search`')

    const set = renderControlResult('skills', { ok: true, message: '已禁用技能 "web-search"。', op: 'disable', id: 'web-search' })
    expect(set).toContain('已禁用技能')
  })

  it('/compact：did 两态 + 计数', () => {
    const no = renderControlResult('compact', {
      did: false,
      strategy: 'ifneeded',
      info: { count: 0, totalPrunedMessages: 0, lastMessagesBefore: null, lastMessagesAfter: null, round: 0, summaryPreview: null },
    })
    expect(no).toContain('未达到压缩阈值')

    const yes = renderControlResult('compact', {
      did: true,
      strategy: 'summary',
      info: { count: 2, totalPrunedMessages: 40, lastMessagesBefore: 120, lastMessagesAfter: 30, round: 1, summaryPreview: '此前对话……' },
    })
    expect(yes).toContain('已执行压缩')
    expect(yes).toContain('此前对话……')
  })

  it('形状没认出来 → 原样 JSON 兜底（宁可原始，不可编造）', () => {
    const out = renderControlResult('stats', { nonsense: true })
    expect(out).toContain('"nonsense": true')
  })
})

describe('启动自检（设计稿 §8）', () => {
  it('无 warn → 空串（不占版面）', () => {
    expect(renderWarnNotices([])).toBe('')
  })

  it('有 warn → 逐条列出，文案来自服务端', () => {
    const out = renderWarnNotices(['未配置 API key，已回落到 Mock Provider'])
    expect(out).toContain('sidecar 启动自检')
    expect(out).toContain('- ⚠️ 未配置 API key')
  })

  it('SLASH_COMMANDS 清单与帮助文案一致', () => {
    const help = renderCommandHelp()
    for (const c of SLASH_COMMANDS) expect(help).toContain(`/${c.name}`)
  })
})
