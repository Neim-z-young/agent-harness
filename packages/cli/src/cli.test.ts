import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveWorkspace, createWorkspaceOriginalStore } from '@harness/workspace'
import type { Message } from '@harness/session'
import type { HarnessConfig } from './index'
import {
  parseCliArgs,
  SessionFileStore,
  CliPermissionEngine,
  HarnessApp,
  ConfigStore,
  resolveConfig,
  parseModelSpec,
  formatModel,
  ConfigValidationError,
  SecretCipher,
  resolveSecret,
  validateProviderConfigs,
  buildConfigOverview,
  checkCompressionConfig,
  registerBuiltinProviderTypes,
  getBuiltinRegistry,
  getBuiltinToolRegistry,
  preloadBuiltinToolMetas,
  resolveBuiltinPlugins,
  unknownBuiltinPluginIds,
  BuiltinToolRegistry,
  loadPluginDirs,
  startRepl,
  attachBackgroundTaskPanel,
  attachAutoContinue,
  formatProviderTypeList,
  buildProviderTypesSection,
  HELP_TEXT,
  main,
} from './index'
import { SubagentEvents } from '@harness/subagent'
import { CoordinatorEvents } from '@harness/coordinator'
import type { PermissionDecision } from '@harness/permission'
import type { AgentPlugin, Hooks } from '@harness/plugin'
import { ProviderTypeRegistry, resolveProviderTypeFactory } from '@harness/plugin'

describe('parseCliArgs 命令解析', () => {
  it('默认 repl 命令', () => {
    const a = parseCliArgs([])
    expect(a.command).toBe('repl')
    expect(a.agentId).toBeUndefined()
  })

  it('start 别名 → repl', () => {
    expect(parseCliArgs(['start']).command).toBe('repl')
  })

  it('list-sessions / resume / run', () => {
    expect(parseCliArgs(['list-sessions']).command).toBe('list-sessions')
    const r = parseCliArgs(['resume', 's1'])
    expect(r.command).toBe('resume')
    expect(r.arg).toBe('s1')
    const r2 = parseCliArgs(['run', 'hello'])
    expect(r2.command).toBe('run')
    expect(r2.arg).toBe('hello')
  })

  it('长选项与短选项、= 形式', () => {
    const a = parseCliArgs(['repl', '--cwd', '/tmp', '-a', 'x', '--provider=mock', '-s=foo'])
    expect(a.cwd).toBe('/tmp')
    expect(a.agentId).toBe('x')
    expect(a.provider).toBe('mock')
    expect(a.sessionId).toBe('foo')
    expect(parseCliArgs(['-v', '--data-dir', '/x', '--permission', 'allow-all'])).toMatchObject({
      verbose: true, dataDir: '/x', permissionMode: 'allow-all'
    })
  })

  it('--help / -h → command=help', () => {
    expect(parseCliArgs(['-h']).command).toBe('help')
    expect(parseCliArgs(['--help', 'repl']).command).toBe('help')
  })

  it('teammate 子命令 + --team/--name 身份参数', () => {
    const a = parseCliArgs(['teammate', '--team', 'Alpha', '--name', 'bob', '--agent', 'researcher', '--data-dir', '/x'])
    expect(a.command).toBe('teammate')
    expect(a.team).toBe('Alpha')
    expect(a.name).toBe('bob')
    expect(a.agentId).toBe('researcher')
    expect(a.dataDir).toBe('/x')
  })

  it('--snapshot 布尔标记', () => {
    expect(parseCliArgs(['--snapshot']).snapshot).toBe(true)
    expect(parseCliArgs(['repl', '--snapshot', '-v'])).toMatchObject({ snapshot: true, verbose: true })
    expect(parseCliArgs([]).snapshot).toBeUndefined()
  })

  it('--allow-plugin-code 布尔标记（默认关闭：不传即为 undefined）', () => {
    expect(parseCliArgs(['--allow-plugin-code']).allowPluginCode).toBe(true)
    expect(parseCliArgs(['repl', '--allow-plugin-code']).allowPluginCode).toBe(true)
    expect(parseCliArgs([]).allowPluginCode).toBeUndefined()
  })

  it('--model / -m 解析模型 ID', () => {
    expect(parseCliArgs(['repl', '--model', 'claude-3-5-sonnet']).model).toBe('claude-3-5-sonnet')
    expect(parseCliArgs(['run', 'hi', '-m=model-x']).model).toBe('model-x')
    expect(parseCliArgs(['repl']).model).toBeUndefined()
  })

  it('config 子命令：set-key/get-key/check + 剩余参数', () => {
    const a = parseCliArgs(['config', 'set-key', 'openai', 'sk-123'])
    expect(a.command).toBe('config')
    expect(a.arg).toBe('set-key')
    expect(a.rest).toEqual(['openai', 'sk-123'])
    expect(parseCliArgs(['config', 'check'])).toMatchObject({ command: 'config', arg: 'check' })
    expect(parseCliArgs(['config'])).toMatchObject({ command: 'config', arg: undefined })
  })

  it('--check-config 解析为 checkConfig: true', () => {
    expect(parseCliArgs(['--check-config']).checkConfig).toBe(true)
    expect(parseCliArgs(['--check-config', '-d', '/x'])).toMatchObject({ checkConfig: true, dataDir: '/x' })
    expect(parseCliArgs(['repl']).checkConfig).toBeUndefined()
  })

  it('-c / --cwd / --cwd= 都解析到 cwd；未传则不设置（由工作目录兜底）', () => {
    expect(parseCliArgs(['-c', '/tmp/a']).cwd).toBe('/tmp/a')
    expect(parseCliArgs(['--cwd', '/tmp/b']).cwd).toBe('/tmp/b')
    expect(parseCliArgs(['--cwd=/tmp/c']).cwd).toBe('/tmp/c')
    expect(parseCliArgs(['-c=/tmp/d']).cwd).toBe('/tmp/d')
    expect(parseCliArgs([]).cwd).toBeUndefined()
  })
})

// ===== 工作目录：启动参数传入，未传才取当前目录 =====
describe('工作目录（启动参数 > 当前目录）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cwd-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('传入 cwd → 以其为准，且项目级 .harness 落在该目录下', () => {
    const workdir = join(dir, 'projA')
    mkdirSync(workdir, { recursive: true })
    const app = new HarnessApp({
      cwd: workdir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
    })
    expect(app.workspace.cwd).toBe(workdir)
    expect(app.workspace.project.root).toBe(join(workdir, '.harness'))
    // 会话指针也要跟着工作目录走（自动恢复的 id 记在工作目录里）
    expect(app.sessionPointer.path()).toBe(join(workdir, '.harness', 'last-session.json'))
  })

  it('未传 cwd → 取当前进程目录', () => {
    const app = new HarnessApp({
      dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
    })
    expect(app.workspace.cwd).toBe(process.cwd())
  })

  it('相对 cwd 会被规范化为绝对路径；未传 dataDir 取默认数据目录', () => {
    const app = new HarnessApp({
      cwd: '.', dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
    })
    expect(app.workspace.cwd).toBe(process.cwd())
    expect(app.workspace.cwd.startsWith('/')).toBe(true)
  })
})

describe('ConfigStore 全局配置（config.json）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-config-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('文件缺失 → 空配置', async () => {
    expect(await new ConfigStore(resolveWorkspace({ dataDir: join(dir, 'nope') })).load()).toEqual({})
  })

  it('save 后 load 往返一致', async () => {
    const store = new ConfigStore(resolveWorkspace({ dataDir: dir }))
    await store.save({ agentId: 'researcher', provider: 'mock', model: 'claude-3-5-sonnet' })
    expect(await store.load()).toEqual({ agentId: 'researcher', provider: 'mock', model: 'claude-3-5-sonnet' })
  })

  it('损坏 JSON → 空配置（幂等友好）', async () => {
    const store = new ConfigStore(resolveWorkspace({ dataDir: dir }))
    writeFileSync(join(dir, 'config.json'), '{broken')
    expect(await store.load()).toEqual({})
  })

  it('resolveConfig：CLI 参数优先于 config', () => {
    const argCfg = { agentId: undefined, provider: 'mock' as const, model: 'cli-model' }
    const out = resolveConfig(argCfg as Parameters<typeof resolveConfig>[0], {
      agentId: 'cfg-agent', provider: 'anthropic', model: 'cfg-model', anthropicApiKey: 'sk-x',
    })
    expect(out.agentId).toBe('cfg-agent') // CLI 未给 → 用 config
    expect(out.provider).toBe('mock')     // CLI 给了 → 覆盖 config
    expect(out.model).toBe('cli-model')   // CLI 给了 → 覆盖 config
    expect(out.anthropicApiKey).toBe('sk-x')
  })

  it('resolveConfig：无任何来源 → 默认 default/anthropic', () => {
    const out = resolveConfig({} as Parameters<typeof resolveConfig>[0], {})
    expect(out.agentId).toBe('default')
    expect(out.provider).toBe('anthropic')
    expect(out.model).toBeUndefined()
  })
})

describe('SecretCipher / resolveSecret 密钥处理', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-secret-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('encrypt → decrypt 往返还原明文；非 enc 原样返回', async () => {
    const cipher = new SecretCipher(resolveWorkspace({ dataDir: dir }))
    const enc = await cipher.encrypt('sk-secret-abc')
    expect(enc.startsWith('enc:v1:')).toBe(true)
    expect(enc).not.toContain('sk-secret-abc') // 明文不落盘
    expect(await cipher.decrypt(enc)).toBe('sk-secret-abc')
    expect(await cipher.decrypt('plain-value')).toBe('plain-value')
  })

  it('主密钥来源：HARNESS_CONFIG_KEY 环境变量优先于 .config-key 文件', async () => {
    const prev = process.env.HARNESS_CONFIG_KEY
    try {
      process.env.HARNESS_CONFIG_KEY = 'my-master-secret-key'
      const cipher = new SecretCipher(resolveWorkspace({ dataDir: dir }))
      const enc = await cipher.encrypt('k1')
      const cipher2 = new SecretCipher(resolveWorkspace({ dataDir: dir })) // 同 env → 可解密
      expect(await cipher2.decrypt(enc)).toBe('k1')
      // 不同 env → 解密失败（ConfigValidationError）
      process.env.HARNESS_CONFIG_KEY = 'different-master-key'
      await expect(cipher2.decrypt(enc)).rejects.toThrow(ConfigValidationError)
    } finally {
      if (prev === undefined) delete process.env.HARNESS_CONFIG_KEY
      else process.env.HARNESS_CONFIG_KEY = prev
    }
  })

  it('resolveSecret：${ENV_VAR} 展开 / 未设置报错 / enc 解密 / 明文透传', async () => {
    const cipher = new SecretCipher(resolveWorkspace({ dataDir: dir }))
    const prev = process.env.HARNESS_TEST_KEY
    try {
      process.env.HARNESS_TEST_KEY = 'env-value'
      expect(await resolveSecret('${HARNESS_TEST_KEY}', cipher)).toBe('env-value')
      expect(await resolveSecret('plain-key', cipher)).toBe('plain-key')
      expect(await resolveSecret(undefined, cipher)).toBeUndefined()
      const enc = await cipher.encrypt('enc-secret')
      expect(await resolveSecret(enc, cipher)).toBe('enc-secret')
    } finally {
      if (prev === undefined) delete process.env.HARNESS_TEST_KEY
      else process.env.HARNESS_TEST_KEY = prev
    }
    await expect(resolveSecret('${HARNESS_TEST_NONEXISTENT_XYZ}', cipher)).rejects.toThrow(ConfigValidationError)
  })
})

describe('validateProviderConfigs / buildConfigOverview 配置校验', () => {
  const TYPES = ['anthropic', 'openai', 'gemini', 'glm', 'qwen', 'mock']

  it('重复 id / 未知 type / 默认 provider 未定义 → 报错', () => {
    const issues = validateProviderConfigs(
      [
        { id: 'openai', type: 'openai' },
        { id: 'openai', type: 'openai' },
        { id: 'bad', type: 'wat' },
      ],
      'deepseek',
      TYPES,
    )
    expect(issues.length).toBe(3)
    expect(issues.some((i) => i.message.includes('重复'))).toBe(true)
    expect(issues.some((i) => i.message.includes('未知'))).toBe(true)
    expect(issues.some((i) => i.message.includes('"deepseek" 未在 providers'))).toBe(true)
  })

  it('缺 id 报错；合法配置（含 mock/anthropic 默认）无问题', () => {
    expect(validateProviderConfigs([{ id: '', type: 'openai' }], 'mock', TYPES).length).toBe(1)
    expect(validateProviderConfigs(
      [
        { id: 'glm', type: 'glm' },
        { id: 'qwen', type: 'qwen' },
        { id: 'gemini', type: 'gemini' },
      ],
      'glm',
      TYPES,
    )).toEqual([])
    // 内置 mock/anthropic 作为默认不要求出现在 providers
    expect(validateProviderConfigs([], 'mock', TYPES)).toEqual([])
    expect(validateProviderConfigs([], 'anthropic', TYPES)).toEqual([])
  })

  it('已知类型由注册表动态提供：注册自定义 type 后校验通过（插件化）', () => {
    const registry = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(registry)
    registry.register({ type: 'my-gw', createPlugin: () => undefined })
    // 未注册 → 未知 type 报错
    expect(validateProviderConfigs([{ id: 'gw', type: 'my-gw' }], 'my-gw', registry.list()).length).toBe(1)
    registry.register({ type: 'gw' as any, createPlugin: () => undefined })
    // 注册后通过
    expect(validateProviderConfigs([{ id: 'gw', type: 'gw' }], 'gw', registry.list())).toEqual([])
  })

  it('buildConfigOverview：输出默认标记、端点与 apiKey 状态（默认脱敏）', () => {
    const overview = buildConfigOverview(
      {
        provider: 'deepseek',
        model: 'deepseek-chat',
        providers: [
          { id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-plain', model: 'gpt-4o' },
          { id: 'deepseek', type: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: '${DEEPSEEK_KEY}', model: 'deepseek-chat' },
        ],
      },
      'deepseek',
    )
    expect(overview).toInclude('默认 provider：deepseek')
    expect(overview).toInclude('默认 model：deepseek-chat')
    expect(overview).toInclude('openai')
    expect(overview).toInclude('deepseek ← 默认')
    expect(overview).toInclude('apiKey=已配置')     // 明文被脱敏
    expect(overview).toInclude('apiKey=env(DEEPSEEK_KEY)') // 环境变量引用显式展示
    expect(overview).not.toContain('sk-plain')      // 明文不输出
    // 反向保护：buildConfigOverview 永不应回显明文 apiKey（即使传入明文 key）
    expect(buildConfigOverview({ providers: [{ id: 'a', type: 'openai', apiKey: 'sk-x' }] }, 'a')).not.toContain('sk-x')
  })

  it('buildConfigOverview：展示 ACP 压缩启用/未启用与自定义提示词状态', () => {
    // 未启用：提示如何开启
    expect(buildConfigOverview({ model: 'm' }, 'mock')).toInclude('上下文压缩（ACP）：未启用')
    // 启用：展示 fitWindow 与自定义提示词标记
    const on = buildConfigOverview(
      { model: 'm', compression: { enabled: true, modelContextLimit: 300000, prompts: { compressPhilosophy: 'x' } } },
      'mock',
    )
    expect(on).toInclude('上下文压缩（ACP）：启用')
    expect(on).toInclude('fitWindow=300000')
    expect(on).toInclude('自定义提示词')
  })

  it('buildConfigOverview：区分 autoTune 自动适配 / 原始参数两种控制方式', () => {
    // 默认（未写 autoTune）：原始压缩参数控制
    const manual = buildConfigOverview({ model: 'm', compression: { enabled: true } }, 'mock')
    expect(manual).toInclude('原始压缩参数控制')
    expect(manual).not.toInclude('按窗口自动适配参数')
    // autoTune: true：按窗口自动适配
    const auto = buildConfigOverview(
      { model: 'm', compression: { enabled: true, autoTune: true, modelContextLimit: 1000000 } },
      'mock',
    )
    expect(auto).toInclude('按窗口自动适配参数')
    expect(auto).toInclude('fitWindow=1000000')
  })

  it('buildConfigOverview：显示 token 折算口径（默认 auto / 显式 chars4）', () => {
    // 未写 tokenCalibration：默认 CJK 感知口径
    const auto = buildConfigOverview({ model: 'm', compression: { enabled: true } }, 'mock')
    expect(auto).toInclude('token 口径 自动（CJK 感知）')
    // 显式回退旧口径
    const legacy = buildConfigOverview(
      { model: 'm', compression: { enabled: true, tokenCalibration: 'chars4' } },
      'mock',
    )
    expect(legacy).toInclude('token 口径 chars/4（旧）')
  })

  it('checkCompressionConfig：合法配置（含全部可选键）零告警', () => {
    // 全键写满是"白名单本身正确"的守卫：任何一处白名单漏列合法键，这条就会误报
    expect(
      checkCompressionConfig({
        enabled: true,
        autoTune: true,
        tokenCalibration: 'chars4',
        modelContextLimit: 300_000,
        systemPrompt: 'x',
        prompts: { compressPhilosophy: 'a', howToCompressRules: 'b', tier2DistillRules: 'c', tier3CondenseRules: 'd' },
        preserveRecentMessages: 5,
        preserveRecentTokens: 50_000,
        promotionThreshold: 5,
        tiers: { tier2Trigger: 5, tier3Trigger: 10 },
        nudge: { maxContextLimitPct: 0.75, minContextLimitPct: 0.45, emergencyThresholdPct: 0.95 },
        telemetry: { enabled: false },
        config: {
          truncate: { threshold: 0.95 },
          compress: { minCompressRange: 200_000, maxSummaryLength: 20_000, minSummaryLength: 50 },
          protectedTools: ['x'],
          absorb: { enabled: true, toolName: 'absorb', minToolTokens: 1_000, contextThresholdPct: 0, excludeTools: [] },
          nudge: {
            maxContextLimitPct: 0.75, minContextLimitPct: 0.45, frequency: 5, iterationThreshold: 15,
            force: 'soft', growthRatio: 0, growthFloor: 75_000, growthCap: 75_000,
            minGrowthFloor: 75_000, minGrowthRatio: 0, emergencyThresholdPct: 0.95,
            tier2GrowthMultiplier: 1.5, minPressureBenefitTokens: 0,
          },
          tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
        },
      }),
    ).toEqual([])
    // 空 / undefined 也不应产生任何输出（否则每次概览都会挂一行空标题）
    expect(checkCompressionConfig(undefined)).toEqual([])
    expect(checkCompressionConfig({})).toEqual([])
  })

  it('checkCompressionConfig：拼错的键一律被抓出（否则会被内核静默丢弃）', () => {
    const issues = checkCompressionConfig({
      enabled: true,
      preserveRecentToken: 50_000,          // 少个 s —— 照抄参数表最典型的错法
      tokenCalibration: 'chars/4',          // 取值拼错
      nudge: { growthFloar: 75_000 },       // 结构化字段里拼错
      tiers: { tier2trigger: 5 },           // 大小写错（内核是 camelCase）
      config: {
        preserveRecentToken: 50_000,        // 高级透传里同样的错
        nudge: { minGrowthFloar: 75_000 },
      },
    })
    expect(issues).toContain('compression.preserveRecentToken 未被识别，该配置不会生效')
    expect(issues).toContain(
      'compression.tokenCalibration 取值 "chars/4" 未知（可选：auto / chars4），已按默认 auto 处理',
    )
    expect(issues).toContain('compression.nudge.growthFloar 未被识别，该配置不会生效')
    expect(issues).toContain('compression.tiers.tier2trigger 未被识别，该配置不会生效')
    expect(issues).toContain('compression.config.preserveRecentToken 内核 Config 无此字段，该配置不会生效')
    expect(issues).toContain('compression.config.nudge.minGrowthFloar 内核 NudgeConfig 无此字段，该配置不会生效')
    expect(issues.length).toBe(6)
  })

  it('buildConfigOverview：未生效项作为告警行输出，且不影响原有概览内容', () => {
    // 必须绕开结构类型：多余的属性正是本用例要模拟的脏数据（真实来源是被 JSON.parse 的 config.json）
    const dirty = { model: 'm', compression: { enabled: true, preserveRecentToken: 50_000 } } as unknown as HarnessConfig
    const bad = buildConfigOverview(dirty, 'mock')
    expect(bad).toInclude('上下文压缩（ACP）：启用')
    expect(bad).toInclude('preserveRecentToken 未被识别')
    // 干净配置不应多出告警标题段
    const clean = buildConfigOverview({ model: 'm', compression: { enabled: true } }, 'mock')
    expect(clean).not.toContain('配置告警')
  })
})

describe('ProviderTypeRegistry / 插件化扩展', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-plugin-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('register / resolve / list 基本行为', () => {
    const reg = new ProviderTypeRegistry()
    reg.register({ type: 'a', createPlugin: () => undefined })
    reg.register({ type: 'b', createPlugin: () => undefined })
    expect(reg.list()).toEqual(expect.arrayContaining(['a', 'b']))
    expect(reg.resolve('a')?.type).toBe('a')
    expect(reg.resolve('nope')).toBeUndefined()
    // 后注册覆盖
    reg.register({ type: 'a', createPlugin: () => undefined })
    expect(reg.resolve('a')).toBeDefined()
  })

  it('registerBuiltinProviderTypes：内置 6 类型齐全', () => {
    const reg = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(reg)
    expect(reg.list().sort()).toEqual(['anthropic', 'gemini', 'glm', 'mock', 'openai', 'qwen'])
  })

  it('惰性展示元信息：同步注册后 listMeta 即可列出，无需加载任何 Provider 模块', () => {
    const reg = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(reg)
    const metas = reg.listMeta()
    expect(metas).toHaveLength(6)
    const openai = metas.find((m) => m.type === 'openai')!
    // 未触发 createPlugin / 未 import 模块时也有描述与用法提示（人机交互友好）
    expect(openai.description).toContain('OpenAI')
    expect(openai.usage).toContain('/model openai/')
    expect(openai.builtin).toBe(true)
    expect(reg.meta('mock')?.requiresApiKey).toBe(false)
    expect(reg.meta('anthropic')?.requiresApiKey).toBe(true)
  })

  it('formatProviderTypeList / buildProviderTypesSection：展示友好清单并提示自动加载', () => {
    const reg = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(reg)
    const section = buildProviderTypesSection(reg)
    expect(section).toContain('可用的 Provider 类型')
    expect(section).toContain('[内置]')
    expect(section).toContain('openai')
    expect(section).toContain('自动加载')
    expect(section).toContain('/model openai/')
    // 关闭用法提示时不再出现例示
    expect(formatProviderTypeList(reg, false)).not.toContain('/model openai/')
  })

  it('内置插件惰性加载：resolve(type).createPlugin 才 import，返回真实 Provider 插件', async () => {
    const reg = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(reg)
    const plugin = (await reg.resolve('openai')!.createPlugin({ id: 'deepseek', type: 'openai', baseUrl: 'http://x', apiKey: 'k' }))!
    expect(plugin.id).toBe('provider.deepseek')
  })

  it('内置 provider-* 包导出 providerTypeFactory（抽象层契约），type 正确且可构造插件', async () => {
    const cases: Array<[string, string]> = [
      ['@harness/provider-anthropic', 'anthropic'],
      ['@harness/provider-openai', 'openai'],
      ['@harness/provider-gemini', 'gemini'],
      ['@harness/provider-glm', 'glm'],
      ['@harness/provider-qwen', 'qwen'],
      ['@harness/provider-mock', 'mock'],
    ]
    for (const [spec, type] of cases) {
      const mod = await import(spec)
      const factory = resolveProviderTypeFactory(mod as Record<string, unknown>)!
      expect(factory.type).toBe(type)
      const plugin = factory.createPlugin({ id: type, type })
      expect(plugin).toBeDefined()
    }
  })

  it('BuiltinPluginRegistry：内置通用插件统一登记并惰性加载（tools-builtin 可解析出真实插件）', async () => {
    const reg = getBuiltinRegistry()
    expect(reg.get('tools-builtin')?.source).toBe('builtin')
    expect(reg.has('missing'))    .toBe(false)
    const p = await reg.get('tools-builtin')!.load()
    expect(p.id).toBeDefined()
    expect(typeof p.install).toBe('function')
  })

  it('BuiltinToolRegistry（多级加载 L1）：preload 后登记内置工具元信息，无需加载运行时模块即可描述', async () => {
    await preloadBuiltinToolMetas()
    const reg = getBuiltinToolRegistry()
    expect(reg instanceof BuiltinToolRegistry).toBe(true)
    // 覆盖全部内置原语工具
    for (const id of ['read_file', 'write_file', 'bash', 'edit_file']) {
      expect(reg.has(id)).toBe(true)
    }
    // 覆盖随应用打包的场景化工具插件元信息（search/glob/web/media）+ 进程内 MCP server 插件（computer-use / code-intel）
    for (const id of ['list_dir', 'grep_file', 'glob', 'web_fetch', 'view_image', 'mcp__computer-use__list_apps', 'mcp__code-intel__code_symbols']) {
      expect(reg.has(id)).toBe(true)
    }
    // optIn 插件（computer-use / code-intel）仅登记元信息，不参与后台预加载实例化
    const cuEntry = getBuiltinRegistry().get('computer-use')!
    expect(cuEntry.optIn).toBe(true)
    const ciEntry = getBuiltinRegistry().get('code-intel')!
    expect(ciEntry.optIn).toBe(true)
    const permByTool: Record<string, string> = {
      web_fetch: 'network', list_dir: 'read', glob: 'read', view_image: 'read',
    }
    for (const [id, k] of Object.entries(permByTool)) {
      expect(reg.get(id)?.permissionKey).toBe(k)
    }
    // 描述可提前取得（运行时模块是否加载都无关）
    const bash = reg.get('bash')!
    expect(bash.description).toContain('shell')
    expect(bash.permissionKey).toBe('bash')
    expect(bash.isDestructive).toBe(true)
    // 别名在未加载时也能查到
    const reg2 = new BuiltinToolRegistry()
    reg2.register({ id: 'x_file', aliases: ['xf'], description: 'x' })
    expect(reg2.get('xf')?.id).toBe('x_file')
    // ToolMetaSource 抽象契约：registerSource 合并来源 list() 元信息
    const reg3 = new BuiltinToolRegistry()
    reg3.registerSource({ id: 'src-a', description: 'a', list: () => [{ id: 'y_file', description: 'y' }] })
    expect(reg3.has('y_file')).toBe(true)
    expect(reg3.get('y_file')?.description).toBe('y')
  })

  it('boot 末尾后台静默预加载（fire-and-forget）：不阻塞 boot，verbose 下预热有日志、关闭开关则无', async () => {
    const verboseChunks: string[] = []
    const vApp = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', verbose: true,
      stdout: { write: (s: string) => { verboseChunks.push(s) } },
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const vBoot = await vApp.boot() // boot 正常返回，不被后台预加载阻塞
    expect(typeof vBoot.session.id).toBe('string')
    // 等待 fire-and-forget 的 Promise.allSettled 完成
    await new Promise((r) => setTimeout(r, 100))
    expect(verboseChunks.some((s) => s.includes('已后台预热'))).toBe(true)
    await vApp.shutdown()

    // backgroundPreload:false → 不触发后台预加载，无预热日志
    const quietChunks: string[] = []
    const qApp = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', verbose: true, backgroundPreload: false,
      stdout: { write: (s: string) => { quietChunks.push(s) } },
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    await qApp.boot()
    await new Promise((r) => setTimeout(r, 50))
    expect(quietChunks.some((s) => s.includes('已后台预热'))).toBe(false)
    await qApp.shutdown()
  })

  it('后台预加载后插件工具已注册进 harness.tools（无需首条消息 /tools 即显示已加载）', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'harness-preload-tools-'))
    const app = new HarnessApp({
      cwd: dir2, dataDir: join(dir2, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all',
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    // 等待 fire-and-forget 预加载 + assembleTools 完成
    await new Promise((r) => setTimeout(r, 300))
    const ids = harness.tools.list().map((t) => t.id).sort()
    // 内置原语 + 场景化插件工具应全部就位（list_dir 来自 tools-search 等）
    expect(ids).toContain('read_file')
    expect(ids).toContain('write_file')
    expect(ids).toContain('list_dir')
    expect(ids).toContain('grep_file')
    expect(ids).toContain('glob')
    expect(ids).toContain('web_fetch')
    await app.shutdown()
    rmSync(dir2, { recursive: true, force: true })
  })

  it('REPL /tools 在后台预加载完成后直接显示「已加载」（无需先发一条消息）', async () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'harness-repl-tools-'))
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir3, dataDir: join(dir3, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    // 等 fire-and-forget 预加载 + assembleTools 完成后再发 /tools（复现用户场景）
    await new Promise((r) => setTimeout(r, 300))
    const r = await startRepl({ app, harness, session, stdout, scriptedStdin: ['/tools', '/exit'] })
    expect(r).toBe('exit')
    const text = chunks.join('')
    // 内置原语工具已加载
    expect(text).toContain('read_file')
    expect(text).toContain('已加载')
    // list_dir 等场景化工具也已加载（不再是 仅元信息）
    const line = text.split('\n').find((l) => l.includes('list_dir')) ?? ''
    expect(line).toContain('list_dir')
    expect(line).toContain('已加载')
    expect(line).not.toContain('仅元信息')
    await app.shutdown()
    rmSync(dir3, { recursive: true, force: true })
  })

  it('loadPluginDirs：从 plugins 目录加载 Provider 类型工厂（providerType + createProviderPlugin 约定）', async () => {
    const pluginDir = join(dir, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'my-gw.ts'), `
      export const providerType = 'my-gw'
      export function createProviderPlugin(config) {
        return { id: 'provider.my-gw', version: '1.0.0', name: 'MyGW Provider', async install() { return {} } }
      }
    `)
    const reg = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(reg)
    const result = await loadPluginDirs(reg, [pluginDir], undefined, { allowCode: true })
    expect(reg.list()).toContain('my-gw')
    const plugin = (await reg.resolve('my-gw')!.createPlugin({ id: 'gw', type: 'my-gw', baseUrl: 'http://x', apiKey: 'k' }))!
    expect(plugin.id).toBe('provider.my-gw')
    // Provider 类型工厂不产生通用插件
    expect(result.plugins).toEqual([])
  })

  it('loadPluginDirs：providerTypeFactory 形态同样可加载', async () => {
    const pluginDir = join(dir, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'factory.ts'), `
      export const providerTypeFactory = {
        type: 'local-gw',
        createPlugin: (c) => ({ id: 'provider.local-gw', version: '1.0.0', name: 'LocalGW', async install() { return {} } }),
      }
    `)
    const reg = new ProviderTypeRegistry()
    await loadPluginDirs(reg, [pluginDir], undefined, { allowCode: true })
    expect((await reg.resolve('local-gw')?.createPlugin({ id: 'x', type: 'local-gw' }))?.id).toBe('provider.local-gw')
  })

  it('loadPluginDirs：plugins 目录同时加载通用 AgentPlugin（default/plugin/plugins）', async () => {
    const pluginDir = join(dir, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'gen.ts'), `
      export const statusPlugin = { id: 'ext.status', version: '1', name: 'Status', async install() { return {} } }
      export const helloPlugin = { id: 'ext.hello', version: '1', name: 'Hello', async install() { return {} } }
      export default { id: 'ext.default', version: '1', name: 'Default', async install() { return {} } }
      export const plugin = { id: 'ext.named', version: '1', name: 'Named', async install() { return {} } }
      export const plugins = [ { id: 'ext.arr', version: '1', name: 'Arr', async install() { return {} } } ]
    `)
    const reg = new ProviderTypeRegistry()
    const result = await loadPluginDirs(reg, [pluginDir], undefined, { allowCode: true })
    const ids = result.plugins.map((p) => p.id).sort()
    expect(ids).toEqual(['ext.arr', 'ext.default', 'ext.named'])
  })

  it('loadPluginDirs：project 目录后加载覆盖 user（多级插件化，通用插件按 id 去重）', async () => {
    const userDir = join(dir, 'user-plugins')
    const projDir = join(dir, 'proj-plugins')
    mkdirSync(userDir, { recursive: true })
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(userDir, 'p.ts'), `export const providerType = 'dup'; export function createProviderPlugin(c){ return { id: 'provider.dup.user', version: '1', name: 'user', async install(){} } }`)
    writeFileSync(join(projDir, 'p.ts'), `export const providerType = 'dup'; export function createProviderPlugin(c){ return { id: 'provider.dup.proj', version: '1', name: 'proj', async install(){} } }`)
    writeFileSync(join(userDir, 'gen.ts'), `export default { id: 'ext.same', version: '1', name: 'user', async install(){} }`)
    writeFileSync(join(projDir, 'gen.ts'), `export default { id: 'ext.same', version: '2', name: 'proj', async install(){} }`)
    const reg = new ProviderTypeRegistry()
    const result = await loadPluginDirs(reg, [userDir, projDir], undefined, { allowCode: true })
    expect((await reg.resolve('dup')!.createPlugin({ id: 'x', type: 'dup' }))!.id).toBe('provider.dup.proj')
    // 通用插件：project 覆盖 user（name=proj，且只保留一份）
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0].name).toBe('proj')
  })

  it('loadPluginDirs：无有效导出的坏文件被忽略并告警', async () => {
    const pluginDir = join(dir, 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'bad.ts'), `export const foo = 1`)
    const warns: string[] = []
    const reg = new ProviderTypeRegistry()
    const result = await loadPluginDirs(reg, [pluginDir], (s) => warns.push(s), { allowCode: true })
    expect(warns.some((w) => w.includes('已忽略'))).toBe(true)
    expect(result.plugins).toEqual([])
  })

  it('loadPluginDirs：默认不加载插件代码（防代码注入），且绝不补 node_modules 软链', async () => {
    // 插件目录里的 .ts 是可执行代码：克隆来的仓库只要带一个 .harness/plugins/*.ts，
    // 在该目录跑一次 harness 就会被 import 执行 —— 默认必须挡住。
    const pluginDir = join(dir, 'injected', 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'mcp.ts'), `
      import { READONLY_TOOLS_SENTINEL } from '@harness/tool'
      export const plugins = [
        { id: 'ext.injected', version: '1', name: READONLY_TOOLS_SENTINEL, async install() { return {} } },
      ]
    `)
    const logs: string[] = []
    const reg = new ProviderTypeRegistry()
    const result = await loadPluginDirs(reg, [pluginDir], (s) => logs.push(s))
    expect(result.plugins).toEqual([])
    const text = logs.join('')
    expect(text).toContain('已跳过')
    expect(text).toContain('防止代码注入')
    // 绝不为插件目录创建任何 node_modules 软链 / .gitignore（不允许软链关联 harness 内核文件）
    expect(existsSync(join(pluginDir, 'node_modules'))).toBe(false)
    expect(existsSync(join(pluginDir, '.gitignore'))).toBe(false)
  })

  it('loadPluginDirs：allowCode: true 时才真正加载插件代码', async () => {
    const pluginDir = join(dir, 'optin', 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'mcp.ts'), `
      export const plugins = [{ id: 'ext.optin', version: '1', name: 'OptIn', async install() { return {} } }]
    `)
    const reg = new ProviderTypeRegistry()
    const result = await loadPluginDirs(reg, [pluginDir], undefined, { allowCode: true })
    expect(result.plugins.map((p) => p.id)).toEqual(['ext.optin'])
  })

  it('loadPluginDirs：相对路径导入失败按原样告警（不再有补锚点逻辑）', async () => {
    const pluginDir = join(dir, 'relative-plugins')
    mkdirSync(pluginDir, { recursive: true })
    // 用上导入的绑定，避免被 Bun 当死代码消除而根本不解析
    writeFileSync(join(pluginDir, 'bad.ts'), `
      import { x } from './nowhere'
      export const plugins = [{ id: 'ext.bad', version: '1', name: String(x), async install() { return {} } }]
    `)
    const logs: string[] = []
    const result = await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], (s) => logs.push(s), { allowCode: true })
    expect(result.plugins).toEqual([])
    expect(logs.some((l) => l.includes('插件加载失败'))).toBe(true)
    expect(existsSync(join(pluginDir, 'node_modules'))).toBe(false)
  })

  it('loadPluginDirs：裸依赖确实无法解析时，告警附带「改用 config.json → plugins」提示', async () => {
    const pluginDir = join(dir, 'missing-dep-plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'bad.ts'), `
      import { y } from 'definitely-not-installed-xyz'
      export const plugins = [{ id: 'ext.bad2', version: '1', name: String(y), async install() { return {} } }]
    `)
    const logs: string[] = []
    await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], (s) => logs.push(s), { allowCode: true })
    const text = logs.join('')
    expect(text).toContain('插件加载失败')
    expect(text).toContain('config.json → "plugins"')
  })
})

describe('内置插件声明式启用（config.json → plugins）', () => {
  it('BuiltinPluginRegistry 登记 mcp.server-registry（进程内 MCP server 的宿主）', () => {
    const entry = getBuiltinRegistry().get('mcp.server-registry')!
    expect(entry).toBeDefined()
    expect(entry.source).toBe('builtin')
    // 宿主插件自身不提供工具，无需 metaSource
    expect(entry.metaSource).toBeUndefined()
  })

  it('resolveBuiltinPlugins：按 id 实例化，并用 dependsOn 自动补齐依赖闭包', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['code-intel'])
    expect(plugins.map((p) => p.id)).toEqual(['code-intel', 'mcp.server-registry'])
    expect(unknown).toEqual([])
  })

  it('resolveBuiltinPlugins：未登记 id 与重复项只记入 unknown/去重，不抛错', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['no-such-plugin', 'code-intel', 'code-intel'])
    expect(unknown).toEqual(['no-such-plugin'])
    expect(plugins.map((p) => p.id)).toEqual(['code-intel', 'mcp.server-registry'])
  })

  it('unknownBuiltinPluginIds：只查表不加载模块', () => {
    expect(unknownBuiltinPluginIds(undefined)).toEqual([])
    expect(unknownBuiltinPluginIds(['code-intel', ' nope '])).toEqual(['nope'])
  })

  it('BuiltinPluginRegistry 登记 Agent 编排类插件 subagent / coordinator / swarm', () => {
    for (const id of ['subagent', 'coordinator', 'swarm']) {
      const entry = getBuiltinRegistry().get(id)!
      expect(entry).toBeDefined()
      expect(entry.source).toBe('builtin')
      // optIn：登记只让它们「可声明」，不参与后台预加载 → 不会被自动装配
      expect(entry.optIn).toBe(true)
      // 这三个包不提供 /meta 模块：未装配时不应在 /tools 里以「仅元信息」现身（避免误导为可用）
      expect(entry.metaSource).toBeUndefined()
    }
  })

  it('resolveBuiltinPlugins：工厂**不传参**即可实例化（配置不写在组合根）', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['subagent', 'coordinator', 'swarm'])
    expect(unknown).toEqual([])
    // 声明顺序即实例顺序；coordinator 的依赖 subagent 已显式声明，不重复追加
    expect(plugins.map((p) => p.id)).toEqual(['subagent', 'coordinator', 'swarm'])
    // 无参默认：coordinator 只认注册表里的依赖，不自带 subagents/forceAsync 等组合根参数
    const coordinator = plugins.find((p) => p.id === 'coordinator')!
    expect(coordinator.dependsOn).toContain('subagent')
  })

  it('resolveBuiltinPlugins：只声明 coordinator 时经 dependsOn 自动补上 subagent', async () => {
    const { plugins, unknown } = await resolveBuiltinPlugins(['coordinator'])
    expect(unknown).toEqual([])
    expect(plugins.map((p) => p.id)).toEqual(['coordinator', 'subagent'])
  })
})

describe('SessionFileStore 会话持久化', () => {
  let dir: string
  let store: SessionFileStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-'))
    store = new SessionFileStore(resolveWorkspace({ dataDir: dir }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('save/load/list 基本流程', async () => {
    const session = {
      id: 's1', title: 'hello', createdAt: 1, updatedAt: 2, agentId: 'a', cwd: '/tmp',
      messages: [{ id: 'm1', role: 'user', createdAt: 1, updatedAt: 1, agentId: 'a', parts: [] } as any],
    }
    await store.save(session)
    const f = store.pathFor('s1')
    const disk = JSON.parse(readFileSync(f, 'utf-8'))
    expect(disk.id).toBe('s1')
    expect(disk.title).toBe('hello')

    const loaded = await store.load('s1')
    expect(loaded?.id).toBe('s1')
    expect(loaded?.messages.length).toBe(1)

    expect(await store.load('not-exist')).toBeUndefined()

    const list = await store.list()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe('s1')
  })
})

describe('findResumeTarget 自动恢复目标选择（含跨目录串台防护）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-resume-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function makeApp(workdir: string): HarnessApp {
    const dataDir = join(workdir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    return new HarnessApp({ cwd: workdir, dataDir, agentId: 'default', provider: 'mock' })
  }

  function fakeSession(id: string, cwd: string | undefined, updatedAt: number): any {
    return { id, title: id, createdAt: updatedAt, updatedAt, agentId: 'default', cwd, messages: [] }
  }

  it('指针指向的会话 cwd 与当前 cwd 一致 → 从指针分支命中返回', async () => {
    const app = makeApp(join(dir, 'projA'))
    await app.sessionStore.save(fakeSession('s_match', app.workspace.cwd, 100))
    await app.sessionPointer.write('s_match')
    const target = await app.findResumeTarget()
    expect(target?.id).toBe('s_match')
  })

  it('指针指向的会话 cwd 是别的目录 → 不返回指针会话，落到同 cwd 兜底（有同目录会话）', async () => {
    const app = makeApp(join(dir, 'projA'))
    const otherCwd = join(dir, 'projB')
    // 指针指向一个属于别的目录的会话：修复前会错误地从指针分支返回它
    await app.sessionStore.save(fakeSession('s_other', otherCwd, 200))
    // 当前目录下另有一个会话，作为同 cwd 兜底目标
    await app.sessionStore.save(fakeSession('s_same', app.workspace.cwd, 100))
    await app.sessionPointer.write('s_other')
    const target = await app.findResumeTarget()
    // 指针分支不应命中 s_other；应退回同 cwd 兜底得到 s_same（改前会错误地拿到 s_other）
    expect(target?.id).toBe('s_same')
    expect(target?.id).not.toBe('s_other')
  })

  it('指针指向的会话 cwd 是别的目录且无同 cwd 会话 → 返回 undefined', async () => {
    const app = makeApp(join(dir, 'projA'))
    const otherCwd = join(dir, 'projB')
    await app.sessionStore.save(fakeSession('s_other', otherCwd, 200))
    await app.sessionPointer.write('s_other')
    const target = await app.findResumeTarget()
    // 指针分支不命中，且没有任何同 cwd 会话 → undefined（改前会错误地返回 s_other）
    expect(target).toBeUndefined()
  })

  it('指针指向的会话 cwd 为 undefined（旧数据）→ 不命中指针分支，退回同 cwd 兜底', async () => {
    const app = makeApp(join(dir, 'projA'))
    // 旧会话无 cwd 字段：修复前会从指针分支返回它
    await app.sessionStore.save(fakeSession('s_old', undefined, 200))
    await app.sessionStore.save(fakeSession('s_same', app.workspace.cwd, 100))
    await app.sessionPointer.write('s_old')
    const target = await app.findResumeTarget()
    // cwd 不匹配（含 undefined）应降级到同 cwd 兜底，拿到 s_same（改前会错误地拿到 s_old）
    expect(target?.id).toBe('s_same')
    expect(target?.id).not.toBe('s_old')
  })
})

describe('CliPermissionEngine', () => {
  it('mode=allow-all 直接放行', async () => {
    const e = new CliPermissionEngine({}, { mode: 'allow-all' })
    const d = await e.ask({ toolKey: 'read', patterns: [] }) as PermissionDecision
    expect(d.behavior).toBe('allow')
    expect(d.matchedRule).toBe('global')
  })

  it('mode=deny-all 一律拒绝', async () => {
    const e = new CliPermissionEngine({}, { mode: 'deny-all' })
    const d = await e.ask({ toolKey: 'read', patterns: [] }) as PermissionDecision
    expect(d.behavior).toBe('deny')
    expect(d.matchedRule).toBe('global')
  })

  it('getMode/setMode 切换交互模式（含 deny-all）', async () => {
    const e = new CliPermissionEngine({}, { mode: 'ask' })
    expect(e.getMode()).toBe('ask')
    e.setMode('allow-all')
    expect(e.getMode()).toBe('allow-all')
    expect((await e.ask({ toolKey: 'x', patterns: [] })).behavior).toBe('allow')
    e.setMode('deny-all')
    expect(e.getMode()).toBe('deny-all')
    expect((await e.ask({ toolKey: 'x', patterns: [] })).behavior).toBe('deny')
  })

  it('parseCliArgs 识别 deny-all', () => {
    expect(parseCliArgs(['--permission', 'deny-all'])).toMatchObject({ permissionMode: 'deny-all' })
    expect(parseCliArgs(['--permission', 'ask'])).toMatchObject({ permissionMode: 'ask' })
    expect(parseCliArgs(['--permission', 'unknown'])).toMatchObject({ permissionMode: 'ask' })
  })

  it('mode=ask 按用户答案', async () => {
    const askPrompt = async (s: string) => {
      if (s.includes('read')) return 'a'
      if (s.includes('write')) return 'd'
      if (s.includes('bash')) return 'A'
      if (s.includes('foo')) return 'D'
      return ''
    }
    let saved: Record<string, unknown> | undefined
    const store: any = { save: async (r: any) => { saved = r } }
    const e = new CliPermissionEngine({}, { mode: 'ask', askPrompt, store })

    expect((await e.ask({ toolKey: 'read', patterns: ['/x'] })).behavior).toBe('allow')
    expect((await e.ask({ toolKey: 'write', patterns: [] })).behavior).toBe('deny')
    const a = await e.ask({ toolKey: 'bash', patterns: [] }) as PermissionDecision
    expect(a.behavior).toBe('allow')
    expect(a.remember).toBe(true)
    expect(saved).toMatchObject({ bash: 'allow' })
    const b = await e.ask({ toolKey: 'foo', patterns: [] }) as PermissionDecision
    expect(b.behavior).toBe('deny')
    expect(b.remember).toBe(true)
    expect(saved).toMatchObject({ bash: 'allow', foo: 'deny' })
  })
})

describe('HarnessApp + startRepl 集成（mock provider）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('HarnessApp boot 建 session，send 追加消息，shutdown 持久化', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: {
        defaultResponse: '你好',
        responses: [{
          match: /.*/,
          response: 'OK',
          toolCalls: [{ toolUseId: 't1', toolId: 'echo', input: { msg: 'hi' } }],
        }]
      },
    })
    const { harness, session } = await app.boot()
    expect(typeof session.id).toBe('string')

    // send 一条，产生 user+assistant 消息
    const assistant = await app.send(session.id, 'ping')
    expect(assistant.role).toBe('assistant')

    const sess = (await harness.session.get(session.id))!
    expect(sess.messages.length).toBeGreaterThanOrEqual(2) // user + assistant

    // 磁盘保存
    const sf = await app.sessionStore.load(session.id)
    expect(sf?.id).toBe(session.id)
    expect(sf?.messages.length).toBeGreaterThanOrEqual(2)

    await app.shutdown()
  })

  it('boot 回读 config.json 的 agents[].tools 覆盖到 Agent 白名单', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    // 预置 config.json：agents[].tools 指定 'bash','echo'（缺省 tools:['*'] 应被覆盖）
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ agents: [{ id: 'default', tools: ['bash', 'echo'] }] }, null, 2))
    const app = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    expect(harness.agent.get('default')?.tools).toEqual(['bash', 'echo'])
    await app.shutdown()
  })

  it('boot 回读 config.json agents[].mcpServers/excludeMcpServers 覆盖到 Agent', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({ agents: [{ id: 'default', tools: ['*'], mcpServers: ['gh'], excludeMcpServers: ['sandbox'] }] }, null, 2),
    )
    const app = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    expect(harness.agent.get('default')?.tools).toEqual(['*'])
    expect(harness.agent.get('default')?.mcpServers).toEqual(['gh'])
    expect(harness.agent.get('default')?.excludeMcpServers).toEqual(['sandbox'])
    await app.shutdown()
  })

  it('setAgentTools 触发后保留 config.json 已有 mcp 声明（不丢弃）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({ agents: [{ id: 'default', tools: ['*'], mcpServers: ['gh'] }] }, null, 2),
    )
    const app = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    await app.setAgentTools('default', ['bash'])
    // config.json 回读：tools 已更新且 mcpServers 被保留
    const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8'))
    const entry = cfg.agents.find((a: any) => a.id === 'default')
    expect(entry.tools).toEqual(['bash'])
    expect(entry.mcpServers).toEqual(['gh'])
    await app.shutdown()
  })

  it('compression.enabled：装配 @harness/acp-context 并透传结构化阈值/提示词（含 Provider contextWindowTokens）', async () => {
    const stdout = { write: () => {} }
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({
        provider: 'my-gw',
        providers: [{ id: 'my-gw', type: 'openai', baseUrl: 'http://gw', apiKey: 'gw-key', contextWindowTokens: 128000 }],
        compression: {
          enabled: true,
          preserveRecentTokens: 4000,
          preserveRecentMessages: 6,
          tiers: { tier2Trigger: 3, tier3Trigger: 8 },
          nudge: { maxContextLimitPct: 0.25 },
          prompts: { howToCompressRules: 'CUSTOM_T1' },
        },
      }, null, 2),
    )
    const app = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'my-gw',
      permissionMode: 'allow-all', stdout,
    })
    const { harness } = await app.boot()
    // ACP 插件已随 boot 装配（id: context.acp；Provider contextWindowTokens 供其推导窗口不报错）
    expect(app.pluginRegistry.get('context.acp')).toBeDefined()
    expect(harness).toBeDefined()
    // config.json 结构化字段被持久保留
    const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8'))
    expect(saved.compression.tiers.tier2Trigger).toBe(3)
    expect(saved.compression.nudge.maxContextLimitPct).toBe(0.25)
    await app.shutdown()
  })

  it('compression.autoTune：装配不报错，且与原始参数模式可切换（窗口取自 Provider contextWindowTokens）', async () => {
    const stdout = { write: () => {} }
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({
        provider: 'my-gw',
        providers: [{ id: 'my-gw', type: 'openai', baseUrl: 'http://gw', apiKey: 'gw-key', contextWindowTokens: 128000 }],
        compression: { enabled: true, autoTune: true },
      }, null, 2),
    )
    const app = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'my-gw',
      permissionMode: 'allow-all', stdout,
    })
    const { harness } = await app.boot()
    expect(app.pluginRegistry.get('context.acp')).toBeDefined()
    expect(harness).toBeDefined()
    await app.shutdown()

    // 切回原始参数模式（autoTune 置 false）：同样能正常装配
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({
        provider: 'my-gw',
        providers: [{ id: 'my-gw', type: 'openai', baseUrl: 'http://gw', apiKey: 'gw-key', contextWindowTokens: 128000 }],
        compression: { enabled: true, autoTune: false, preserveRecentTokens: 4000, nudge: { maxContextLimitPct: 0.25 } },
      }, null, 2),
    )
    const app2 = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'my-gw',
      permissionMode: 'allow-all', stdout,
    })
    const boot2 = await app2.boot()
    expect(app2.pluginRegistry.get('context.acp')).toBeDefined()
    expect(boot2.harness).toBeDefined()
    await app2.shutdown()
  })

  it('compression.tokenCalibration：两种口径都能装配，缺省即 auto', async () => {
    const stdout = { write: () => {} }
    for (const tokenCalibration of ['auto', 'chars4', undefined] as const) {
      const dataDir = join(dir, '.harness')
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(
        join(dataDir, 'config.json'),
        JSON.stringify({
          provider: 'my-gw',
          providers: [{ id: 'my-gw', type: 'openai', baseUrl: 'http://gw', apiKey: 'gw-key', contextWindowTokens: 128000 }],
          compression: tokenCalibration ? { enabled: true, tokenCalibration } : { enabled: true },
        }, null, 2),
      )
      const app = new HarnessApp({
        cwd: dir, dataDir, agentId: 'default', provider: 'my-gw',
        permissionMode: 'allow-all', stdout,
      })
      const { harness } = await app.boot()
      expect(app.pluginRegistry.get('context.acp')).toBeDefined()
      expect(harness).toBeDefined()
      // 概览反映口径
      const overview = buildConfigOverview(
        { model: 'm', compression: { enabled: true, tokenCalibration } },
        'mock',
      )
      expect(overview).toInclude(tokenCalibration === 'chars4' ? 'token 口径 chars/4（旧）' : 'token 口径 自动（CJK 感知）')
      await app.shutdown()
    }
  })

  it('startRepl 脚本模式：发送 prompt + /sessions + /new + /save + /exit 正常', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    const scriptedStdin = [
      '你好',
      '/sessions',
      '/new',
      '/save',
      '/exit',
    ]
    const r = await startRepl({ app, harness, session, stdout, scriptedStdin })
    expect(r).toBe('exit')
    // 拼接起来方便看
    const output = chunks.join('')
    expect(output).toInclude('Harness CLI')
    expect(output).toInclude('你好')
    // /exit 之前会 exit，所以 /save 没有被执行完是正常的
    await app.shutdown()
  })

  it('/model 切换模型：默认只改本会话（Session.meta.model），不动 Agent 与 config.json', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      model: 'claude-3-5-sonnet', // 初始默认模型（权限 allow-all 以便静默交互）
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    // 初始：默认 Agent 已绑定默认模型
    expect(harness.agent.get('default')?.model?.modelId).toBe('claude-3-5-sonnet')

    const r = await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/model', '/model claude-3-7-sonnet', '/model', '/exit'],
    })
    expect(r).toBe('exit')

    const output = chunks.join('')
    expect(output).toInclude('当前模型：claude-3-5-sonnet')
    expect(output).toInclude('来源：Agent "default" 的绑定（全局）')
    expect(output).toInclude('已切换模型 claude-3-7-sonnet')
    expect(output).toInclude('仅本会话')
    // 再查一次：来源应变成「本会话模型覆盖」
    expect(output).toInclude('当前模型：claude-3-7-sonnet')
    expect(output).toInclude('来源：本会话模型覆盖')

    // 覆盖落在会话上：本会话的解析即刻改变
    expect(app.sessionModelOverride(session)).toEqual({ modelId: 'claude-3-7-sonnet' })
    expect(app.resolveSessionModel(session)).toBe('claude-3-7-sonnet')
    // …而 Agent 定义与 config.json 都不动（旧行为是「切一次影响所有会话」）
    expect(harness.agent.get('default')?.model?.modelId).toBe('claude-3-5-sonnet')
    expect(app.getModel('default')).toBe('claude-3-5-sonnet')
    const cfg = await app.configStore.load()
    expect(cfg.model).toBeUndefined()

    await app.shutdown()
  })

  it('/model --global 才写 Agent 定义 + config.json（并清除本会话覆盖）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      model: 'claude-3-5-sonnet',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    const r = await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/model claude-3-7-sonnet', '/model --global claude-3-5-sonnet', '/exit'],
    })
    expect(r).toBe('exit')
    const output = chunks.join('')
    expect(output).toInclude('全局默认')
    expect(output).toInclude('已一并清除本会话的模型覆盖')

    expect(harness.agent.get('default')?.model?.modelId).toBe('claude-3-5-sonnet')
    expect(app.getModel('default')).toBe('claude-3-5-sonnet')
    expect(app.sessionModelOverride(session)).toBeUndefined()
    const cfg = await app.configStore.load()
    expect(cfg.model).toBe('claude-3-5-sonnet')

    await app.shutdown()
  })

  it('/model ? 展示 config.json 配置的 Provider 模型（含 baseUrl/type）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const dd = join(dir, '.harness')
    mkdirSync(dd, { recursive: true })
    writeFileSync(join(dd, 'config.json'), JSON.stringify({
      provider: 'deepseek',
      providers: [
        { id: 'deepseek', type: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test' },
        { id: 'local', type: 'openai', baseUrl: 'http://localhost:11434', model: 'qwen2.5' },
      ],
    }, null, 2))
    const app = new HarnessApp({
      cwd: dir, dataDir: dd, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    const r = await startRepl({ app, harness, session, stdout, scriptedStdin: ['/model', '/exit'] })
    expect(r).toBe('exit')
    const output = chunks.join('')
    expect(output).toInclude('配置的模型（providers）：')
    expect(output).toInclude('deepseek/deepseek-chat')
    expect(output).toInclude('baseUrl=https://api.deepseek.com')
    expect(output).toInclude('local/qwen2.5')
    await app.shutdown()
  })

  it('/model <provider>/<model> 切换后 send 统计行显示完整 provider/model（mock 场景）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness-sendmodel'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    const r = await startRepl({ app, harness, session, stdout, scriptedStdin: ['/model mock/deepseek-flash', 'hi', '/exit'] })
    expect(r).toBe('exit')
    const full = chunks.join('')
    // 统计行用完整 provider/model 展示（而非仅 modelId），不再出现「model=deepseek-flash」
    expect(full).toInclude('model=mock/deepseek-flash')
    await app.shutdown()
  })

  it('parseModelSpec / formatModel：provider/model 规格解析', () => {
    expect(parseModelSpec('openai/gpt-4o')).toEqual({ providerId: 'openai', modelId: 'gpt-4o' })
    expect(parseModelSpec('claude-3-5-sonnet')).toEqual({ providerId: undefined, modelId: 'claude-3-5-sonnet' })
    expect(parseModelSpec('')).toEqual({ providerId: undefined, modelId: '' })
    expect(formatModel('openai', 'gpt-4o')).toBe('openai/gpt-4o')
    expect(formatModel(undefined, 'gpt-4o')).toBe('gpt-4o')
    expect(formatModel('openai', undefined)).toBeUndefined()
  })

  it('--model provider/model：默认 Agent 绑定 providerId（跨 Provider）', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'openai',
      model: 'openai/gpt-4o',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [{ id: 'openai', type: 'openai', baseUrl: 'http://x', model: 'gpt-4o' }],
    })
    const { harness } = await app.boot()
    expect(harness.agent.get('default')?.model?.providerId).toBe('openai')
    expect(harness.agent.get('default')?.model?.modelId).toBe('gpt-4o')
    expect(app.getModel('default')).toBe('openai/gpt-4o')
    await app.shutdown()
  })

  it('setModel 跨 Provider 切换：openai/gpt-4o → 更新 providerId+modelId 并持久化', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'openai', type: 'openai', baseUrl: 'http://x', model: 'gpt-4o' },
        { id: 'deepseek', type: 'openai', baseUrl: 'http://y', model: 'deepseek-chat' },
      ],
    })
    await app.boot()
    const ok = await app.setModel('default', 'deepseek/deepseek-chat')
    expect(ok).toBe(true)
    expect(app.getModel('default')).toBe('deepseek/deepseek-chat')
    const cfg = await app.configStore.load()
    expect(cfg.provider).toBe('deepseek')
    expect(cfg.model).toBe('deepseek-chat')
    await app.shutdown()
  })

  it('getMcpServers/setMcpServers：读写 config.json mcpServers；boot 时注入运行时', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    // 预写入 mcpServers
    await app.setMcpServers([{ name: 'alpha', transport: 'stdio', command: 'echo', args: ['hi'], enabled: true }])
    const loaded = await app.getMcpServers()
    expect(loaded.length).toBe(1)
    expect(loaded[0].name).toBe('alpha')
    expect(loaded[0].enabled).toBe(true)

    await app.boot()
    const cfg = await app.configStore.load()
    expect(cfg.mcpServers?.[0]?.name).toBe('alpha')
    await app.shutdown()
  })

  it('boot：config.json → plugins 声明式启用内置插件（免写 .harness/plugins 代码）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ plugins: ['code-intel'] }, null, 2))
    const app = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    const ids = harness.plugin.list().map((p) => p.plugin.id)
    expect(ids).toContain('mcp.server-registry') // 依赖闭包自动补齐（code-intel → 宿主 registry）
    expect(ids).toContain('code-intel')
    // 装配工具池后 mcp__code-intel__* 真正可调用（不再是「仅元信息」）
    await harness.assembleTools()
    expect(harness.tools.list().map((t) => t.id)).toContain('mcp__code-intel__code_symbols')
    await app.shutdown()
  })

  it('boot：config.json → plugins 有未登记 id 时只告警，不阻断启动', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ plugins: ['no-such-plugin'] }, null, 2))
    const app = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    await app.boot()
    expect(chunks.join('')).toContain('config.json → plugins 有未生效项：no-such-plugin')
    await app.shutdown()
  })

  it('boot：optIn 内置插件未被声明时不参与后台预加载（登记 ≠ 自动装配）', async () => {
    const stdout = { write: () => {} }
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    // 不声明任何 plugins：这些插件应保持「仅登记」状态
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({}, null, 2))
    const app = new HarnessApp({
      cwd: dir, dataDir, agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    // 等 fire-and-forget 预加载结束（若它们会被自动装配，此时必然已经装上）
    await new Promise((r) => setTimeout(r, 300))
    const ids = harness.plugin.list().map((p) => p.plugin.id)
    for (const id of ['subagent', 'coordinator', 'swarm', 'code-intel', 'computer-use', 'mcp.server-registry']) {
      expect(ids).not.toContain(id)
    }
    await harness.assembleTools()
    const tools = harness.tools.list().map((t) => t.id)
    for (const t of ['subagent', 'send_message', 'team_create', 'task_create']) {
      expect(tools).not.toContain(t)
    }
    await app.shutdown()
  })

  it('boot 多 Provider 注册：config.providers 逐项注册，按 id 分发', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'deepseek',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'openai', type: 'openai', baseUrl: 'http://openai', model: 'gpt-4o' },
        { id: 'deepseek', type: 'openai', baseUrl: 'http://deepseek', model: 'deepseek-chat' },
      ],
    })
    const { harness } = await app.boot()
    expect(app.listProviders()).toEqual(expect.arrayContaining(['openai', 'deepseek']))
    // 默认 provider = deepseek（最后安装，作为兜底）
    const h = harness as unknown as { resolveChatProvider: (id?: string) => { id?: string } }
    const impl = (id?: string) => h.resolveChatProvider(id)
    expect(impl('deepseek')?.id).toBe('deepseek')
    expect(impl('openai')?.id).toBe('openai')
    // 'default' / 未知 id 回退默认（deepseek）
    expect(impl('default')?.id).toBe('deepseek')
    await app.shutdown()
  })

  it('listProviders 合并插件注册的自定义 type：boot 时 loadPluginDirs 注入，/model 可列出', async () => {
    const stdout = { write: () => {} }
    // 项目级插件目录 .harness/plugins，存放导出 providerTypeFactory 的 provider 插件
    const pluginDir = join(dir, '.harness', 'plugins')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'my-gw.ts'), `
      export const providerTypeFactory = {
        type: 'my-gw',
        createPlugin: (c) => ({ id: 'provider.my-gw', version: '1.0.0', name: 'MyGW', async install() { return {} } }),
      }
    `)
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      // 默认不加载插件代码（防注入），本用例就是要验证插件目录生效，故显式开闸
      allowPluginCode: true,
    })
    await app.boot()
    expect(app.listProviders()).toContain('mock')           // 默认 provider
    expect(app.listProviders()).toContain('anthropic')      // 内置注册表类型
    expect(app.listProviders()).toContain('my-gw')          // 插件注册的自定义 type
    await app.shutdown()
  })

  it('同 baseUrl 不同 apiKey 的 Provider：不同 id 各自分发，key 互不干扰', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'gateway-a',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'gateway-a', type: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'key-a', model: 'gpt-4o' },
        { id: 'gateway-b', type: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'key-b', model: 'gpt-4o' },
      ],
    })
    const { harness } = await app.boot()
    expect(app.listProviders()).toEqual(expect.arrayContaining(['gateway-a', 'gateway-b']))
    const h = harness as unknown as { resolveChatProvider: (id?: string) => { id?: string; config?: { apiKey?: string; baseUrl?: string } } }
    const a = h.resolveChatProvider('gateway-a')
    const b = h.resolveChatProvider('gateway-b')
    expect(a?.id).toBe('gateway-a')
    expect(a?.config?.apiKey).toBe('key-a')
    expect(b?.id).toBe('gateway-b')
    expect(b?.config?.apiKey).toBe('key-b')
    // 未注册 id 回退默认（gateway-a）
    expect(h.resolveChatProvider('nope')?.id).toBe('gateway-a')
    await app.shutdown()
  })

  it('boot 显式校验：重复 id / 未知 type / 默认 provider 未定义 → ConfigValidationError', async () => {
    const stdout = { write: () => {} }
    // 重复 id
    await expect(new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'openai',
      permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'openai', type: 'openai', baseUrl: 'http://x' },
        { id: 'openai', type: 'openai', baseUrl: 'http://y' },
      ],
    }).boot()).rejects.toThrow(ConfigValidationError)
    // 未知 type
    await expect(new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'openai',
      permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
      providers: [{ id: 'openai', type: 'wat' as any, baseUrl: 'http://x' }],
    }).boot()).rejects.toThrow(ConfigValidationError)
    // 默认 provider 未在 providers 中定义
    await expect(new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'my-gw',
      permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
      providers: [{ id: 'openai', type: 'openai', baseUrl: 'http://x' }],
    }).boot()).rejects.toThrow(/未在 providers/)
  })

  it('boot 校验错误会一次性输出所有问题（重复 id + 默认缺失同时报出）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    await expect(new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'nope',
      permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'a', type: 'openai' },
        { id: 'a', type: 'openai' },
      ],
    }).boot()).rejects.toThrow(ConfigValidationError)
    expect(chunks.join('')).toInclude('配置错误（config.json → providers）')
    expect(chunks.join('')).toInclude('"a" 与前面的 provider 重复')
    expect(chunks.join('')).toInclude('"nope" 未在 providers')
  })

  it('type=glm / type=qwen：预设端点插件注册并可按 id 分发', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'glm',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'glm', type: 'glm', apiKey: 'glm-key' },
        { id: 'qwen', type: 'qwen', apiKey: 'qwen-key' },
      ],
    })
    const { harness } = await app.boot()
    expect(app.listProviders()).toEqual(expect.arrayContaining(['glm', 'qwen']))
    const h = harness as unknown as { resolveChatProvider: (id?: string) => { id?: string; config?: { apiKey?: string; baseUrl?: string } } }
    const glm = h.resolveChatProvider('glm')
    const qwen = h.resolveChatProvider('qwen')
    expect(glm?.id).toBe('glm')
    expect(glm?.config?.apiKey).toBe('glm-key')
    expect(glm?.config?.baseUrl).toContain('bigmodel') // 预设端点
    expect(qwen?.id).toBe('qwen')
    expect(qwen?.config?.apiKey).toBe('qwen-key')
    expect(qwen?.config?.baseUrl).toContain('dashscope') // 预设端点
    await app.shutdown()
  })

  it('apiKey 支持 ${ENV_VAR} 引用：boot 时展开', async () => {
    const prev = process.env.HARNESS_TEST_OPENAI_KEY
    try {
      process.env.HARNESS_TEST_OPENAI_KEY = 'env-openai-key'
      const stdout = { write: () => {} }
      const app = new HarnessApp({
        cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'openai',
        permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
        providers: [
          { id: 'openai', type: 'openai', baseUrl: 'http://x', apiKey: '${HARNESS_TEST_OPENAI_KEY}' },
        ],
      })
      const { harness } = await app.boot()
      const h = harness as unknown as { resolveChatProvider: (id?: string) => { id?: string; config?: { apiKey?: string } } }
      expect(h.resolveChatProvider('openai')?.config?.apiKey).toBe('env-openai-key')
      await app.shutdown()
    } finally {
      if (prev === undefined) delete process.env.HARNESS_TEST_OPENAI_KEY
      else process.env.HARNESS_TEST_OPENAI_KEY = prev
    }
  })

  it('插件化：自定义 type 经注册表装配并参与分发（无需改 CLI 代码）', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'my-gw',
      permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
      providers: [{ id: 'my-gw', type: 'my-gw', baseUrl: 'http://gw', apiKey: 'gw-key' }],
    })
    // 插件注册：boot 前注入自定义 type 工厂（等价 ~/.harness/plugins 插件加载）
    app.providerTypes.register({
      type: 'my-gw',
      createPlugin: (pc) => ({
        id: 'provider.my-gw',
        version: '1.0.0',
        name: 'MyGW Provider',
        async install() {
          const provider = {
            id: pc.id,
            async complete(p: any) {
              return { content: `gw:${pc.apiKey}`, model: 'gw-1', tokenUsage: { input: 1, output: 1 } }
            },
            async *stream(p: any) {
              yield { type: 'done', model: 'gw-1', tokenUsage: { input: 1, output: 1 } }
            },
          }
          return {
            async 'harness.init'(_i: unknown, output: any) {
              output?.harness?._setChatProvider?.(provider as any)
            },
          } as any
        },
      }),
    })
    const { harness } = await app.boot()
    expect(app.listProviders()).toContain('my-gw')
    const h = harness as unknown as { resolveChatProvider: (id?: string) => { id?: string } }
    expect(h.resolveChatProvider('my-gw')?.id).toBe('my-gw')
    await app.shutdown()
  })

  it('main run 子命令执行 prompt 并输出文本', async () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
    try {
      const dd = join(dir, '.harness')
      const code = await main([
        'run', 'hello',
        '-p', 'mock',
        '-d', dd,
        '-c', dir,
        '--permission', 'allow-all',
      ])
      expect(code).toBe(0)
      const out = chunks.join('')
      expect(out).toInclude('Mock Provider')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('main list-sessions 输出空列表', async () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
    try {
      const dd = join(dir, '.harness')
      const code = await main(['list-sessions', '-d', dd])
      expect(code).toBe(0)
      expect(chunks.join('')).toInclude('（无持久化会话）')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('main help → 输出帮助', async () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
    try {
      const code = await main(['--help'])
      expect(code).toBe(0)
      expect(chunks.join('')).toInclude(HELP_TEXT.slice(0, 20))
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('main config set-key / get-key：apiKey 加密落盘并可解密还原', async () => {
    const dd = join(dir, '.harness')
    mkdirSync(dd, { recursive: true })
    // 预置 providers 配置（openai 无 key）
    const cfg: Record<string, unknown> = {
      provider: 'openai',
      model: 'gpt-4o',
      providers: [{ id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com' }],
    }
    writeFileSync(join(dd, 'config.json'), JSON.stringify(cfg, null, 2))

    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
    try {
      const code = await main(['config', 'set-key', 'openai', 'sk-live-abc', '-d', dd])
      expect(code).toBe(0)
      expect(chunks.join('')).toInclude('已加密写入')
    } finally {
      process.stdout.write = originalWrite
    }

    // config.json 中是 enc:v1 密文，不落明文
    const saved = JSON.parse(readFileSync(join(dd, 'config.json'), 'utf-8'))
    expect(saved.providers[0].apiKey).toMatch(/^enc:v1:/)
    expect(saved.providers[0].apiKey).not.toContain('sk-live-abc')

    // get-key 解密还原
    const chunks2: string[] = []
    process.stdout.write = ((s: any) => { chunks2.push(String(s)); return true }) as any
    try {
      const code = await main(['config', 'get-key', 'openai', '-d', dd])
      expect(code).toBe(0)
      expect(chunks2.join('')).toInclude('sk-live-abc')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('main config check / --check-config：合法配置打印概览并校验通过', async () => {
    const dd = join(dir, '.harness')
    mkdirSync(dd, { recursive: true })
    writeFileSync(join(dd, 'config.json'), JSON.stringify({
      provider: 'deepseek',
      model: 'deepseek-chat',
      providers: [
        { id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-1', model: 'gpt-4o' },
        { id: 'deepseek', type: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
      ],
    }, null, 2))
    for (const argv of [['config', 'check'], ['--check-config']]) {
      const chunks: string[] = []
      const originalWrite = process.stdout.write.bind(process.stdout) as any
      process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
      try {
        const code = await main([...argv, '-d', dd])
        expect(code).toBe(0)
        const out = chunks.join('')
        expect(out).toInclude('默认 provider：deepseek')
        expect(out).toInclude('deepseek ← 默认')
        expect(out).toInclude('配置校验通过')
      } finally {
        process.stdout.write = originalWrite
      }
    }
  })

  it('main --check-config：配置错误 → 返回 1 并输出错误', async () => {
    const dd = join(dir, '.harness')
    mkdirSync(dd, { recursive: true })
    writeFileSync(join(dd, 'config.json'), JSON.stringify({
      provider: 'deepseek',
      providers: [{ id: 'openai', type: 'openai' }, { id: 'openai', type: 'openai' }],
    }, null, 2))
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true }) as any
    try {
      const code = await main(['--check-config', '-d', dd])
      expect(code).toBe(1)
      const out = chunks.join('')
      expect(out).toInclude('配置错误（config.json → providers）')
      expect(out).toInclude('重复')
      expect(out).toInclude('"deepseek" 未在 providers')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('阶段四：loadFullHistory({ blockIds }) 只返回命中块原文（惰性展开）', async () => {
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all',
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()

    // 构造：4 条近期消息 + 1 个 generic 压缩块（覆盖前 2 条，原文入 .cmp.orig 归档）
    const mk = (id: string, role: 'user' | 'assistant', text: string) =>
      ({ id, role, createdAt: 0, parts: [{ type: 'text', text }] }) as Message
    const m1 = mk('m1', 'user', '旧一问')
    const m2 = mk('m2', 'assistant', '旧一答')
    const m3 = mk('m3', 'user', '近问')
    const m4 = mk('m4', 'assistant', '近答')
    await harness.session.setMessages(session.id, [m1, m2, m3, m4])

    const sess = (await harness.session.get(session.id))!
    sess.blocks = [{ id: 'b1', topic: '旧段', summary: 's', startId: 'm1', endId: 'm2', at: 1, source: 'generic' }]
    await createWorkspaceOriginalStore(app.workspace).save(session.id, 'b1', [m1, m2])

    // 命中块 → 仅原文段
    const parts = await app.loadFullHistory(session.id, { blockIds: ['b1'] })
    expect(parts.map((m) => m.id)).toEqual(['m1', 'm2'])
    // 未命中块 → 空（不回落全量）
    const none = await app.loadFullHistory(session.id, { blockIds: ['nope'] })
    expect(none).toEqual([])
    // 无 range → 全量（近期 + 块原文）
    const all = await app.loadFullHistory(session.id)
    expect(all.length).toBe(4)
    await app.shutdown()
  })
})

describe('插件 CLI 命令扩展', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** 测试插件：注册 /status 斜杠命令 */
  function createStatusPlugin(): AgentPlugin {
    return {
      id: 'test.status-cmd',
      version: '1.0.0',
      name: 'Status Command Plugin',
      async install() {
        const hooks: Hooks = {
          'cli.commands'(input) {
            input.commands.push({ command: 'status', description: '显示会话状态' })
          },
          'cli.command'(input) {
            if (input.command !== 'status') return
            input.out(`会话 ${input.sessionId} 运行中\n`)
            input.result = 'continue'
          },
        }
        return hooks
      },
    }
  }

  it('插件 /status 命令被 REPL 分发', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      extraPlugins: [createStatusPlugin()],
    })
    const { harness, session } = await app.boot()
    const r = await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/status', '/exit'],
    })
    expect(r).toBe('exit')
    const output = chunks.join('')
    expect(output).toInclude('会话')
    expect(output).toInclude('运行中')
    await app.shutdown()
  })

  it('/help 显示插件注册的命令', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      extraPlugins: [createStatusPlugin()],
    })
    const { harness, session } = await app.boot()
    await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/help', '/exit'],
    })
    const output = chunks.join('')
    expect(output).toInclude('/status')
    expect(output).toInclude('显示会话状态')
    await app.shutdown()
  })

  it('未知命令仍提示未知', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      extraPlugins: [createStatusPlugin()],
    })
    const { harness, session } = await app.boot()
    await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/foobar', '/exit'],
    })
    const output = chunks.join('')
    expect(output).toInclude('未知命令')
    await app.shutdown()
  })

  it('/stats 与 /stats-export（无参数）正常工作且不崩溃', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/stats', '/stats-export', '/stats-export json', '/stats-export md', '/exit'],
    })
    const output = chunks.join('')
    expect(output).toInclude('LLM 调用')
    expect(output).toInclude('# 会话用量统计报告')
    expect(output).toInclude('"llmCalls"')
    expect(output).not.toInclude('执行失败') // 不触发命令异常防护
    expect(output).not.toInclude('TypeError')
    await app.shutdown()
  })

  it('/resume 恢复会话后发送不再报 Session not found（setId 同步索引）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    // 在默认会话产生历史并持久化，作为待恢复的会话
    await app.send(session.id, 'hello')
    await app.sessionStore.save((await harness.session.get(session.id))!)
    // 另起一个会话作为当前 REPL 会话，再 /resume 回已持久化会话并继续发送
    const other = await harness.session.create({ agentId: 'default' })
    await startRepl({
      app, harness, session: other, stdout,
      scriptedStdin: [`/resume ${session.id}`, 'hi there', '/exit'],
    })
    const output = chunks.join('')
    expect(output).toInclude(`已恢复会话 ${session.id}`)
    expect(output).not.toInclude('Session ')
    expect(output).not.toInclude('not found')
    expect(output).not.toInclude('发送失败')
    await app.shutdown()
  })
})

describe('后台任务面板 attachBackgroundTaskPanel（P1-4）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('subagent 后台任务 started/completed 事件实时打印状态行', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    const detach = attachBackgroundTaskPanel({ harness, stdout })

    const started = {
      agentId: 'researcher', agentName: 'Researcher',
      subSessionId: 's_sub', parentSessionId: 's_parent', parentAgentId: 'default',
      parentMessageId: 'm1', toolUseId: 't1',
      prompt: '调研竞品定价', description: '调研竞品定价',
      isContinuation: false, startedAt: Date.now(),
      taskId: 'task-1', background: true,
    }
    await harness.bus.publish(SubagentEvents.started, started as any)
    await harness.bus.publish(SubagentEvents.completed, {
      agentId: 'researcher', subSessionId: 's_sub', parentSessionId: 's_parent',
      toolUseId: 't1', replyPreview: '竞品 X 定价 29 美元/月', messageCount: 5, durationMs: 1200,
      taskId: 'task-1', background: true,
    } as any)
    detach()

    const output = chunks.join('')
    expect(output).toInclude('[后台任务] task-1 开始：Researcher')
    expect(output).toInclude('调研竞品定价')
    expect(output).toInclude('[后台任务] task-1 完成：Researcher（1200ms）')
    expect(output).toInclude('竞品 X 定价 29 美元/月')
    await app.shutdown()
  })

  it('subagent 后台任务 failed 事件打印失败行', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    const detach = attachBackgroundTaskPanel({ harness, stdout })

    await harness.bus.publish(SubagentEvents.started, {
      agentId: 'researcher', agentName: 'Researcher',
      subSessionId: 's_sub', parentSessionId: 's_parent', parentAgentId: 'default',
      parentMessageId: 'm1', toolUseId: 't1',
      prompt: '调研失败任务', description: '调研失败任务',
      isContinuation: false, startedAt: Date.now(),
      taskId: 'task-2', background: true,
    } as any)
    await harness.bus.publish(SubagentEvents.failed, {
      agentId: 'researcher', subSessionId: 's_sub', parentSessionId: 's_parent',
      toolUseId: 't1', code: 'QUERY_FAILED', message: 'provider error', durationMs: 800,
      taskId: 'task-2', background: true,
    } as any)
    detach()

    const output = chunks.join('')
    expect(output).toInclude('[后台任务] task-2 开始')
    expect(output).toInclude('[后台任务] task-2 失败：Researcher')
    expect(output).toInclude('provider error')
    await app.shutdown()
  })

  it('subagent.progress 事件实时打印工具调用进度（P1-5）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    const detach = attachBackgroundTaskPanel({ harness, stdout })

    await harness.bus.publish(SubagentEvents.started, {
      agentId: 'researcher', agentName: 'Researcher',
      subSessionId: 's_sub', parentSessionId: 's_parent', parentAgentId: 'default',
      parentMessageId: 'm1', toolUseId: 't1',
      prompt: '读取文件', description: '读取文件',
      isContinuation: false, startedAt: Date.now(),
      taskId: 'task-3', background: true,
    } as any)
    await harness.bus.publish(SubagentEvents.progress, {
      taskId: 'task-3', agentId: 'researcher', parentSessionId: 's_parent',
      toolUseId: 'tu-1', toolName: 'read_file', toolStatus: 'running',
      summary: 'src/index.ts', timestamp: Date.now(),
    } as any)
    await harness.bus.publish(SubagentEvents.progress, {
      taskId: 'task-3', agentId: 'researcher', parentSessionId: 's_parent',
      toolUseId: 'tu-1', toolName: 'read_file', toolStatus: 'completed',
      summary: 'file content', timestamp: Date.now(),
    } as any)
    detach()

    const output = chunks.join('')
    expect(output).toInclude('🔧  [task-3] read_file：src/index.ts...')
    expect(output).toInclude('✅  [task-3] read_file → file content')
    await app.shutdown()
  })
})

describe('Coordinator 自动续轮 attachAutoContinue', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('coordinator.barrier.completed 事件触发注入 <continue/>', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()

    const injected: string[] = []
    const detach = attachAutoContinue(harness, (line) => injected.push(line))
    await harness.bus.publish(CoordinatorEvents.barrierCompleted, {
      sessionId: 's_parent', taskIds: ['task-a', 'task-b'],
    } as any)
    detach()

    expect(injected).toEqual(['<continue/>'])
    await app.shutdown()
  })

  it('卸载后不再注入', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()

    const injected: string[] = []
    const detach = attachAutoContinue(harness, (line) => injected.push(line))
    detach()
    await harness.bus.publish(CoordinatorEvents.barrierCompleted, { sessionId: 's', taskIds: [] } as any)

    expect(injected).toHaveLength(0)
    await app.shutdown()
  })
})

describe('/revert 命令', () => {
  let dir: string
  beforeEach(() => {
    // 普通临时目录即可：快照仓库独立于 worktree，命令分支不依赖 worktree 是 git 仓库
    dir = mkdtempSync(join(tmpdir(), 'harness-cli-revert-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function bootApp(snapshot = false) {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      snapshot,
    })
    const { harness, session } = await app.boot()
    return { app, harness, session, stdout, chunks }
  }

  it('未启用 snapshot 时 /revert 提示启用', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(false)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert', '/exit'] })
    expect(chunks.join('')).toInclude('快照未启用')
    await app.shutdown()
  })

  it('启用后 /revert help 显示子命令用法', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert help', '/exit'] })
    const out = chunks.join('')
    expect(out).toInclude('stage')
    expect(out).toInclude('clear')
    expect(out).toInclude('commit')
    expect(out).toInclude('status')
    await app.shutdown()
  })

  it('/revert status 无进行中回滚时提示', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert status', '/exit'] })
    expect(chunks.join('')).toInclude('当前无进行中的回滚')
    await app.shutdown()
  })

  it('/revert stage 不存在的消息时打印回滚失败（不崩溃）', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert stage no-such-msg', '/exit'] })
    expect(chunks.join('')).toInclude('回滚失败')
    await app.shutdown()
  })

  it('/revert 未知子命令提示', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/revert nope', '/exit'] })
    expect(chunks.join('')).toInclude('未知子命令')
    await app.shutdown()
  })

  it('/help 列表包含 /revert', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/help', '/exit'] })
    expect(chunks.join('')).toInclude('/revert')
    await app.shutdown()
  })

  it('未启用 snapshot 时 /snapshot 提示开启方式', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(false)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/snapshot', '/exit'] })
    expect(chunks.join('')).toInclude('--snapshot')
    await app.shutdown()
  })

  it('启用后 /snapshot 输出已启用状态', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/snapshot status', '/exit'] })
    expect(chunks.join('')).toInclude('状态：已启用')
    await app.shutdown()
  })

  it('/snapshot files 缺参提示用法', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/snapshot files', '/exit'] })
    expect(chunks.join('')).toInclude('用法')
    await app.shutdown()
  })

  it('/help 列表包含 /snapshot', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp(true)
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/help', '/exit'] })
    expect(chunks.join('')).toInclude('/snapshot')
    await app.shutdown()
  })
})

// ===== /plugins 插件管理命令 =====

describe('/plugins 插件管理', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function bootApp() {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    return { app, harness, session, stdout, chunks }
  }

  it('列表展示已加载插件（含 mock provider，来源 + 可管理标记）', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/plugins', '/exit'] })
    const out = chunks.join('')
    expect(out).toInclude('provider.mock')
    expect(out).toInclude('可管理')
    expect(out).toInclude('用法：/plugins')
    await app.shutdown()
  })

  it('查找未登记插件提示不受管理', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/plugins disable no-such', '/exit'] })
    expect(chunks.join('')).toInclude('不受管理')
    await app.shutdown()
  })

  it('/permission：查看模式与规则 + 切换 deny-all + 设置规则并落盘', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()
    await startRepl({
      app, harness, session, stdout,
      scriptedStdin: [
        '/permission',
        '/permission deny-all',
        '/permission bash=deny',
        '/permission',
        '/exit',
      ],
    })
    const out = chunks.join('')
    // bootApp 默认 permissionMode=allow-all
    expect(out).toInclude('权限交互模式：allow-all')
    // 切换 deny-all
    expect(out).toInclude('已切换权限交互模式为 deny-all')
    expect(app.permission.getMode()).toBe('deny-all')
    // 设置规则 bash=deny 已落盘
    expect(out).toInclude('已设置规则 bash=deny')
    expect((app.permission.getRules() as Record<string, unknown>).bash).toBe('deny')
    const file = readFileSync(join(dir, '.harness', 'permissions.json'), 'utf-8')
    expect(file).toInclude('"bash": "deny"')
    await app.shutdown()
  })

  it('/permission reset 恢复全局 ask 并清空规则', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()
    await app.setPermissionRules({ '*': 'ask', bash: 'deny' })
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/permission reset', '/exit'] })
    const out = chunks.join('')
    expect(out).toInclude('已重置权限')
    expect(app.permission.getMode()).toBe('ask')
    expect(app.permission.getRules()).toEqual({ '*': 'ask' })
    await app.shutdown()
  })

  it('enable/disable 插件幂等往返（经 /plugins 命令）', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()

    // disable → 从插件列表移除
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/plugins disable provider.mock', '/exit'] })
    let out = chunks.join('')
    expect(out).toInclude('已禁用插件')

    // 同一 app 内 enable 恢复 → 再次出现在列表；再次 enable 幂等提示已是启用状态
    await startRepl({
      app, harness, session, stdout,
      scriptedStdin: ['/plugins enable provider.mock', '/plugins enable provider.mock', '/exit'],
    })
    out = chunks.join('')
    expect(out).toInclude('已启用插件')
    expect(out).toInclude('已是启用状态')
    await app.shutdown()
  })

  it('/help 列表包含 /plugins', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/help', '/exit'] })
    expect(chunks.join('')).toInclude('/plugins')
    await app.shutdown()
  })
})

// ===== /skills 技能管理命令 =====

describe('/skills 技能管理', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-cli-test-'))
    // 项目级技能：.harness/skills/<id>.md（boot 会以 project 来源加载）
    mkdirSync(join(dir, '.harness', 'skills'), { recursive: true })
    writeFileSync(join(dir, '.harness', 'skills', 'greet.md'), `---
name: greet
description: 问候技能
---
你好，这是一条问候。
`)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function bootApp() {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness, session } = await app.boot()
    return { app, harness, session, stdout, chunks }
  }

  it('列表展示已加载技能并标注来源', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()
    expect(app.skillInfos().some((s) => s.id === 'greet' && s.sourceLabel === '项目')).toBe(true)

    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/skills', '/exit'] })
    const out = chunks.join('')
    expect(out).toInclude('greet')
    expect(out).toInclude('项目(project)')
    expect(out).toInclude('用法：/skills')
    await app.shutdown()
  })

  it('/skills disable + enable 往返', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()

    const disable = await app.disableSkill('greet')
    expect(disable.ok).toBe(true)
    expect(app.skillInfos().some((s) => s.id === 'greet')).toBe(false)

    const enable = await app.enableSkill('greet')
    expect(enable.ok).toBe(true)
    expect(app.skillInfos().some((s) => s.id === 'greet')).toBe(true)

    // 已启用时 enable → 提示已启用
    const again = await app.enableSkill('greet')
    expect(again.ok).toBe(false)
    expect(again.message).toInclude('已是启用状态')

    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/skills disable greet', '/skills enable greet', '/exit'] })
    const out = chunks.join('')
    expect(out).toInclude('已禁用技能 "greet"')
    expect(out).toInclude('已启用技能 "greet"')
    await app.shutdown()
  })

  it('/skills disable 不存在的技能返回失败', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()
    const res = await app.disableSkill('nope')
    expect(res.ok).toBe(false)
    expect(res.message).toInclude('不存在')
    await app.shutdown()
  })

  it('/help 列表包含 /skills', async () => {
    const { app, harness, session, stdout, chunks } = await bootApp()
    await startRepl({ app, harness, session, stdout, scriptedStdin: ['/help', '/exit'] })
    expect(chunks.join('')).toInclude('/skills')
    await app.shutdown()
  })
})
