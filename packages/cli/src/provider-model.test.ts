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
  it('config 未写 id：boot 后按 model 派生实例，provider 字段直接引用派生 id', async () => {
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
    expect(m.app.getModel('default')).toBe('hy4-preview-f/hy4-preview-f')

    // 持久化自洽：provider 与 model 同步落盘
    const cfg = await m.app.configStore.load()
    expect(cfg.provider).toBe('hy4-preview-f')
    expect(cfg.model).toBe('hy4-preview-f')
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
