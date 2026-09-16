import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HarnessApp,
  normalizeProviderConfigs,
  checkProviderConfigs,
  resolveModelArg,
  formatResolutionRef,
  sanitizeProviderId,
  formatApiKeyTag,
  findTokenOnlyDuplicates,
  startRepl,
} from './index'
import type { ProviderConfig } from '@harness/plugin'

// ==========================================================================
// 归一化：id 不再必须冗长/手写
// ==========================================================================

describe('normalizeProviderConfigs：id 缺省由 model 派生', () => {
  it('省略 id 时按 model 命名（去 provider/ 前缀、规整非法字符）', () => {
    const { providers, issues } = normalizeProviderConfigs([
      { type: 'openai', baseUrl: 'http://x', model: 'hy3' },
      { type: 'openai', baseUrl: 'http://x', model: 'deepseek-v4.1-flash' },
      { type: 'anthropic', model: 'anthropic/claude-3-5-sonnet' },
    ])
    expect(issues).toHaveLength(0)
    expect(providers.map((p) => p.id)).toEqual(['hy3', 'deepseek-v4.1-flash', 'claude-3-5-sonnet'])
  })

  it('同 model 重复出现时按数组顺序追加 -2/-3（确定性，无需人工起名）', () => {
    const { providers } = normalizeProviderConfigs([
      { type: 'openai', baseUrl: 'http://a', model: 'gpt-4o' },
      { type: 'openai', baseUrl: 'http://b', model: 'gpt-4o' },
      { type: 'openai', baseUrl: 'http://c', model: 'gpt-4o' },
    ])
    expect(providers.map((p) => p.id)).toEqual(['gpt-4o', 'gpt-4o-2', 'gpt-4o-3'])
    // baseUrl 各自保留 —— 同模型多端点仍能区分
    expect(providers.map((p) => p.baseUrl)).toEqual(['http://a', 'http://b', 'http://c'])
  })

  it('显式 id 原样保留，且与派生 id 不冲突', () => {
    const { providers } = normalizeProviderConfigs([
      { id: 'gw-a', type: 'openai', baseUrl: 'http://a', model: 'gpt-4o' },
      { type: 'openai', baseUrl: 'http://b', model: 'gpt-4o' },
    ])
    expect(providers.map((p) => p.id)).toEqual(['gw-a', 'gpt-4o'])
  })

  it('显式 id 重复 → 报错（沿用旧语义，避免静默覆盖注册）', () => {
    const { issues } = normalizeProviderConfigs([
      { id: 'openai', type: 'openai' },
      { id: 'openai', type: 'openai' },
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('重复')
    expect(issues[0].index).toBe(1)
  })

  it('id 与 model 都缺失 → 报错（无从派生）', () => {
    const { issues } = normalizeProviderConfigs([{ type: 'openai', baseUrl: 'http://x' } as ProviderConfig])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('既未写 id 也未写 model')
  })

  it('sanitizeProviderId 规整非法字符并去首尾连字符', () => {
    expect(sanitizeProviderId('Qwen2.5 7B')).toBe('Qwen2.5-7B')
    expect(sanitizeProviderId('  /foo//bar/  ')).toBe('foo-bar')
  })

  it('checkProviderConfigs：省略 id 的配置校验通过，且默认 provider 可引用派生 id', () => {
    // 概览按派生 id 展示、校验也须按派生 id 判定，否则会出现「概览正常但报 id 缺失」的自相矛盾
    const { providers, issues } = checkProviderConfigs(
      [
        { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy4-preview-f' },
        { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy3' },
      ],
      'hy3',
      ['openai', 'anthropic'],
    )
    expect(issues).toHaveLength(0)
    expect(providers.map((p) => p.id)).toEqual(['hy4-preview-f', 'hy3'])
  })

  it('checkProviderConfigs：默认 provider 指向不存在的 id 仍报错', () => {
    const { issues } = checkProviderConfigs(
      [{ type: 'openai', baseUrl: 'http://x', model: 'hy3' }],
      'local-hy3',
      ['openai'],
    )
    expect(issues.some((s) => s.includes('未在 providers'))).toBe(true)
  })
})

// ==========================================================================
// 解析：/model 支持序号 / 实例 id / 模型名 / provider/model
// ==========================================================================

const PROVIDERS = normalizeProviderConfigs([
  { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy4-preview-f' },
  { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy3' },
  { id: 'online', type: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
]).providers

describe('resolveModelArg：四种写法', () => {
  it('序号 → 命中对应实例', () => {
    expect(resolveModelArg('2', PROVIDERS)).toMatchObject({
      kind: 'instance', providerId: 'hy3', modelId: 'hy3', matchedBy: 'index', index: 2,
    })
  })

  it('序号越界 → bad-index', () => {
    expect(resolveModelArg('9', PROVIDERS)).toMatchObject({ kind: 'bad-index', total: 3 })
    expect(resolveModelArg('0', PROVIDERS)).toMatchObject({ kind: 'bad-index' })
  })

  it('模型名 → 命中实例（这正是「必须写 id/model」被去掉的地方）', () => {
    // id 与 model 不同名时：按模型名命中
    expect(resolveModelArg('deepseek-flash', PROVIDERS)).toMatchObject({
      kind: 'instance', providerId: 'online', modelId: 'deepseek-flash', matchedBy: 'model',
    })
    // 派生 id 等于模型名时：id 与 model 同时命中同一实例，仍唯一命中（matchedBy 取 id）
    expect(resolveModelArg('hy3', PROVIDERS)).toMatchObject({
      kind: 'instance', providerId: 'hy3', modelId: 'hy3', matchedBy: 'id',
    })
  })

  it('实例 id → 命中实例（显式 id 与派生 id 都可用）', () => {
    expect(resolveModelArg('online', PROVIDERS)).toMatchObject({
      kind: 'instance', providerId: 'online', modelId: 'deepseek-flash', matchedBy: 'id',
    })
  })

  it('provider/model 显式写法保留，并标注 provider 是否已注册', () => {
    expect(resolveModelArg('online/deepseek-flash', PROVIDERS)).toMatchObject({
      kind: 'explicit', providerId: 'online', modelId: 'deepseek-flash', providerKnown: true,
    })
    expect(resolveModelArg('ghost/gpt-4o', PROVIDERS)).toMatchObject({
      kind: 'explicit', providerId: 'ghost', modelId: 'gpt-4o', providerKnown: false,
    })
  })

  it('一个词同时命中多个实例 → 要求消歧，不静默选第一个', () => {
    const dup = normalizeProviderConfigs([
      { id: 'a', type: 'openai', model: 'shared' },
      { id: 'b', type: 'openai', model: 'shared' },
    ]).providers
    const r = resolveModelArg('shared', dup)
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') {
      expect(r.candidates.map((c) => c.id)).toEqual(['a', 'b'])
    }
  })

  it('未配置任何 providers 实例时，裸模型名仍挂当前 Provider（保留旧用法）', () => {
    expect(resolveModelArg('claude-3-7-sonnet', [])).toMatchObject({ kind: 'model', modelId: 'claude-3-7-sonnet' })
  })

  it('已配置 providers 时陌生词 → not-found（防「拼错 provider 名被写成垃圾模型名」）', () => {
    // 回归：旧实现把 '/model local-hy4' 这类拼错直接落成 config.model='local-hy4'
    expect(resolveModelArg('local-hy4', PROVIDERS)).toMatchObject({ kind: 'not-found', arg: 'local-hy4' })
  })

  it('Provider 类型名（非实例）→ type-hint，给出用法提示', () => {
    expect(resolveModelArg('openai', PROVIDERS, ['openai', 'anthropic'])).toMatchObject({ kind: 'type-hint', arg: 'openai' })
    expect(resolveModelArg('mock', [], ['mock'])).toMatchObject({ kind: 'type-hint' })
  })

  it('formatResolutionRef 生成可展示引用', () => {
    expect(formatResolutionRef(resolveModelArg('2', PROVIDERS))).toBe('hy3/hy3')
    expect(formatResolutionRef(resolveModelArg('ghost/gpt-4o', PROVIDERS))).toBe('ghost/gpt-4o')
    expect(formatResolutionRef(resolveModelArg('claude-3-7-sonnet', []))).toBe('claude-3-7-sonnet')
    expect(formatResolutionRef(resolveModelArg('local-hy4', PROVIDERS))).toBeUndefined()
  })
})

// ==========================================================================
// 集成：省略 id 的真实 config + /model 切换 / 不污染配置
// ==========================================================================

function mount(providersConfig: unknown, provider = 'hy3') {
  const dir = mkdtempSync(join(tmpdir(), 'harness-model-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ provider, providers: providersConfig }, null, 2))
  const chunks: string[] = []
  const stdout = { write: (s: string) => { chunks.push(s) } }
  const app = new HarnessApp({
    cwd: dir,
    dataDir: dir,
    agentId: 'default',
    provider,
    permissionMode: 'allow-all',
    stdout,
    mockProviderConfig: { defaultResponse: 'hi' },
  })
  return { dir, app, chunks, stdout, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('/model 集成：省略 id 的配置也能直接按模型名切换', () => {
  it('config 未写 id：boot 后按 model 派生实例；/model 只改本会话、不写 config.json', async () => {
    const m = mount([
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-x', model: 'hy4-preview-f' },
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-x', model: 'hy3' },
    ])
    const { harness, session } = await m.app.boot()
    expect(m.app.listProviders()).toEqual(expect.arrayContaining(['hy3', 'hy4-preview-f']))

    const r = await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: ['/model hy4-preview-f', '/exit'],
    })
    expect(r).toBe('exit')
    const out = m.chunks.join('')
    expect(out).toInclude('已切换模型 hy4-preview-f/hy4-preview-f')
    expect(out).toInclude('仅本会话')

    // 会话级覆盖生效：Session.meta.model 记下 provider + model，本会话的展示也据此解析
    expect(m.app.sessionModelOverride(session)).toEqual({ providerId: 'hy4-preview-f', modelId: 'hy4-preview-f' })
    expect(m.app.resolveSessionModel(session)).toBe('hy4-preview-f/hy4-preview-f')

    // 旧实现会把 Agent 定义与 config.json 一起改掉（切一次影响所有会话），现在两者都不动
    expect(m.app.getModel('default')).toBeUndefined()
    const cfg = await m.app.configStore.load()
    expect(cfg.provider).toBe('hy3')
    expect(cfg.model).toBeUndefined()

    await m.app.shutdown()
    m.cleanup()
  })

  it('/model --global 写全局默认（Agent 定义 + config.json），并清除本会话覆盖', async () => {
    const m = mount([
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-x', model: 'hy4-preview-f' },
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-x', model: 'hy3' },
    ])
    const { harness, session } = await m.app.boot()
    const r = await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      // 先落一个会话级覆盖，再用 --global 改写全局：全局必须立刻对本会话生效
      scriptedStdin: ['/model hy4-preview-f', '/model --global hy3', '/exit'],
    })
    expect(r).toBe('exit')
    const out = m.chunks.join('')
    expect(out).toInclude('已切换模型 hy3/hy3')
    expect(out).toInclude('全局默认')
    expect(out).toInclude('已一并清除本会话的模型覆盖')

    expect(m.app.getModel('default')).toBe('hy3/hy3')
    expect(m.app.sessionModelOverride(session)).toBeUndefined()
    expect(m.app.resolveSessionModel(session)).toBe('hy3/hy3')
    const cfg = await m.app.configStore.load()
    expect(cfg.provider).toBe('hy3')
    expect(cfg.model).toBe('hy3')
    await m.app.shutdown()
    m.cleanup()
  })

  it('/model reset 清除会话覆盖，回到 Agent 默认', async () => {
    const m = mount([
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-x', model: 'hy4-preview-f' },
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-x', model: 'hy3' },
    ])
    const { harness, session } = await m.app.boot()
    const r = await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: ['/model hy4-preview-f', '/model reset', '/model', '/exit'],
    })
    expect(r).toBe('exit')
    const out = m.chunks.join('')
    expect(out).toInclude('已清除本会话的模型覆盖')
    expect(out).toInclude('来源：Agent "default" 的绑定（全局）')
    expect(m.app.sessionModelOverride(session)).toBeUndefined()
    await m.app.shutdown()
    m.cleanup()
  })

  it('/model ? 列出带序号的实例，且 /model <序号> 可切换', async () => {
    const m = mount([
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy4-preview-f' },
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy3' },
    ])
    const { harness, session } = await m.app.boot()
    const r = await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: ['/model ?', '/model 1', '/exit'],
    })
    expect(r).toBe('exit')
    const out = m.chunks.join('')
    // 列表带序号 + 切换示例
    expect(out).toInclude('1) hy4-preview-f/hy4-preview-f')
    expect(out).toInclude('2) hy3/hy3')
    expect(out).toInclude('/model hy4-preview-f')
    expect(out).toInclude('已切换模型 hy4-preview-f/hy4-preview-f')
    await m.app.shutdown()
    m.cleanup()
  })

  it('拼错的名字被拒绝，且不污染 config.model（回归：旧实现会写成垃圾值）', async () => {
    const m = mount([
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy4-preview-f' },
      { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'hy3' },
    ])
    const { harness, session } = await m.app.boot()
    const r = await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: ['/model local-hy4', '/exit'],
    })
    expect(r).toBe('exit')
    const out = m.chunks.join('')
    expect(out).toInclude('未找到 "local-hy4"')
    expect(out).toInclude('hy3')
    const cfg = await m.app.configStore.load()
    expect(cfg.model).toBeUndefined()
    expect(m.app.getModel('default')).toBeUndefined()
    await m.app.shutdown()
    m.cleanup()
  })
})

// ==========================================================================
// 同配置不同 token：识别 + 可区分展示
// ==========================================================================
// 背景：同一 type/baseUrl/model 只换 apiKey（两个额度 / 两个账号）是常见诉求，本机制允许它，
// 但这类实例只能靠按 model 派生的 `-2` id 区分，而派生 id 与数组顺序绑定，容易出现两个坑：
//   1) 调整数组顺序 → 同名 id 悄悄指向另一个 token；
//   2) 列表里 type/baseUrl/model 全同，人眼无法判断哪条是哪个 token。
// 因此补上：组识别（findTokenOnlyDuplicates）+ key 指纹展示（formatApiKeyTag fingerprint）。

describe('formatApiKeyTag：apiKey 展示口径', () => {
  it('未配置 / 加密 / env 引用 / 明文（脱敏与指纹）', () => {
    expect(formatApiKeyTag(undefined)).toBe('（未配置）')
    expect(formatApiKeyTag('  ')).toBe('（未配置）')
    expect(formatApiKeyTag('enc:v1:abc')).toBe('已加密')
    expect(formatApiKeyTag('${DEEPSEEK_KEY}')).toBe('env(DEEPSEEK_KEY)')
    expect(formatApiKeyTag('sk-TOKEN-A')).toBe('已配置')
    expect(formatApiKeyTag('sk-TOKEN-A', { fingerprint: true })).toBe('已配置(…EN-A)')
    // 加密态不回显明文、也不给指纹
    expect(formatApiKeyTag('enc:v1:abc', { fingerprint: true })).toBe('已加密')
    // 极短 key 不做尾部截取（避免整串被回显）
    expect(formatApiKeyTag('abc', { fingerprint: true })).toBe('已配置')
  })
})

describe('findTokenOnlyDuplicates：同端点同模型实例组识别', () => {
  const p = (raw: ProviderConfig[]) => normalizeProviderConfigs(raw).providers

  it('仅 apiKey 不同 → 归为一组，distinctKeys=2', () => {
    const dups = findTokenOnlyDuplicates(
      p([
        { type: 'openai', baseUrl: 'http://x/v1', apiKey: 'sk-A', model: 'hy3' },
        { type: 'openai', baseUrl: 'http://x/v1', apiKey: 'sk-B', model: 'hy3' },
      ]),
    )
    expect(dups).toHaveLength(1)
    expect(dups[0].members.map((m) => m.id)).toEqual(['hy3', 'hy3-2'])
    expect(dups[0].distinctKeys).toBe(2)
  })

  it('apiKey 也相同 → 仍是同组，但 distinctKeys=1（属重复项）', () => {
    const dups = findTokenOnlyDuplicates(
      p([
        { type: 'openai', baseUrl: 'http://x/v1', apiKey: 'sk-A', model: 'hy3' },
        { type: 'openai', baseUrl: 'http://x/v1', apiKey: 'sk-A', model: 'hy3' },
      ]),
    )
    expect(dups).toHaveLength(1)
    expect(dups[0].distinctKeys).toBe(1)
  })

  it('baseUrl / model / type 任一不同则不算同组', () => {
    expect(
      findTokenOnlyDuplicates(
        p([
          { type: 'openai', baseUrl: 'http://a', apiKey: 'sk-A', model: 'hy3' },
          { type: 'openai', baseUrl: 'http://b', apiKey: 'sk-B', model: 'hy3' },
          { type: 'openai', baseUrl: 'http://a', apiKey: 'sk-C', model: 'hy4' },
          { type: 'anthropic', baseUrl: 'http://a', apiKey: 'sk-D', model: 'hy3' },
        ]),
      ),
    ).toHaveLength(0)
  })
})

describe('同配置不同 token 的集成：可区分 + 必须消歧', () => {
  const twoTokens = [
    { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-TOKEN-A', model: 'hy3' },
    { type: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-TOKEN-B', model: 'hy3' },
  ]

  it('装配出两个独立实例（各自 apiKey 独立路由），id 派生为 hy3 / hy3-2', async () => {
    const m = mount(twoTokens)
    const { harness } = await m.app.boot()
    const anyH = harness as unknown as { resolveChatProvider: (id?: string) => { id: string } }
    expect(anyH.resolveChatProvider('hy3').id).toBe('hy3')
    expect(anyH.resolveChatProvider('hy3-2').id).toBe('hy3-2')
    await m.app.shutdown()
    m.cleanup()
  })

  it('/model ? 列出 key 指纹 + 顺序绑定提示；/model <模型名> 要求消歧；/model hy3-2 可切换', async () => {
    const m = mount(twoTokens)
    const { harness, session } = await m.app.boot()
    const r = await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: ['/model ?', '/model hy3', '/model hy3-2', '/exit'],
    })
    expect(r).toBe('exit')
    const out = m.chunks.join('')
    // 同组实例才附 key 指纹，用于区分两个 token（只回显末 4 位，不泄露完整 key）
    expect(out).toInclude('1) hy3/hy3')
    expect(out).toInclude('key=已配置(…EN-A)')
    expect(out).toInclude('key=已配置(…EN-B)')
    expect(out).not.toContain('sk-TOKEN-A')
    expect(out).toInclude('type/baseUrl/model 完全相同')
    expect(out).toInclude('与 providers 数组顺序绑定')
    // 模型名命中两条 → 消歧提示里也带 key，且给出序号写法
    expect(out).toInclude('同时命中多个 Provider 实例')
    expect(out).toInclude('改为 /model <序号>')
    // 用派生 id 才能精确切到第二个 token
    expect(out).toInclude('已切换模型 hy3-2/hy3')
    // 会话级：两个 token 的区分结果只落到本会话，不改 config.provider
    expect(m.app.sessionModelOverride(session)).toEqual({ providerId: 'hy3-2', modelId: 'hy3' })
    const cfg = await m.app.configStore.load()
    expect(cfg.provider).toBe('hy3')
    await m.app.shutdown()
    m.cleanup()
  })

  it('回归：删掉「hy3-2」对应实例后启动报错可定位（派生 id 与数组绑定，config.provider 会悬空）', async () => {
    // 直接构造「config.provider 指向派生 id hy3-2，但数组里只剩一条」的状态（= 用户删掉了第二条 token）
    const dir = mkdtempSync(join(tmpdir(), 'harness-token-'))
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ provider: 'hy3-2', model: 'hy3', providers: [twoTokens[0]] }, null, 2),
    )
    const chunks: string[] = []
    const app = new HarnessApp({
      cwd: dir, dataDir: dir, agentId: 'default', provider: 'hy3-2',
      permissionMode: 'allow-all', stdout: { write: (s: string) => { chunks.push(s) } },
    })
    const failed = await app.boot().then(() => undefined, (e: Error) => e.message)
    expect(failed).toInclude('默认 provider "hy3-2" 未在 providers 数组中定义')
    expect(chunks.join('')).toInclude('配置错误（config.json → providers）')
    rmSync(dir, { recursive: true, force: true })
  })
})
