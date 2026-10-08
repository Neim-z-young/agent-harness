import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
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
  createProcessLine,
  checkCompressionConfig,
  checkTelemetryConfig,
  toAcpConfig,
  buildProviderWindowTable,
  resolveCompactionWindow,
  checkCompactionConfig,
  checkCompactionReachability,
  registerBuiltinProviderTypes,
  getBuiltinRegistry,
  resolveBuiltinPlugins,
  startRepl,
  attachBackgroundTaskPanel,
  attachAutoContinue,
  formatProviderTypeList,
  buildProviderTypesSection,
  HELP_TEXT,
  main,
  formatToolInput,
  formatToolResult,
  TOOL_CONT_MARK,
} from './index'
import { SubagentEvents } from '@harness/subagent'
import { CoordinatorEvents } from '@harness/coordinator'
import { defineTool } from '@harness/tool'
import type { PermissionDecision } from '@harness/permission'
import type { AgentPlugin, Hooks } from '@harness/plugin'
import { ProviderTypeRegistry, resolveProviderTypeFactory } from '@harness/plugin'

// ==========================================================================
// re-export 兼容（P0 收尾 S4 收口）
// ==========================================================================
// P0 把装配原语 / 配置层 / 权限接缝 / 装配主体上移到 `@harness/host` 后，`@harness/cli` 继续
// re-export 这些符号（外部与既有调用点都直接 `import` 它们）。搬迁期 cli 侧还留了一份同能力的
// **行为**用例作双保险；S4 收口删掉了这份重复，只留下面这一条：**导出面不变 —— 从 `@harness/cli`
// 取到的名字与从 `@harness/host` 取到的是同一个**。这样"符号仍可从 `@harness/cli` 取得"这条约定
// 仍被钉住，而能力覆盖只有 host 一份（见各 host 测试文件）。
describe('@harness/cli re-export 兼容（上移符号与 @harness/host 同源）', () => {
  it('每个上移符号都 === 从 @harness/host 取到的那个（导出面逐字不变）', async () => {
    const cli = await import('./index') as Record<string, unknown>
    const host = await import('@harness/host') as Record<string, unknown>
    const MOVED = [
      // A 档：外部插件目录加载
      'loadPluginDirs', 'collectAgentPlugins', 'registerProviderTypeFactory',
      // C 档：内置注册表三节 + 共用惰性加载入口
      'lazyImport', 'registerBuiltinProviderTypes', 'getBuiltinRegistry', 'unknownBuiltinPluginIds',
      'resolveBuiltinPlugins', 'getBuiltinToolRegistry', 'preloadBuiltinToolMetas',
      'BuiltinPluginRegistry', 'BuiltinToolRegistry',
      // B 档：配置归一化与上下文窗口推导
      'parseModelSpec', 'formatModel', 'sanitizeProviderId', 'normalizeProviderConfigs',
      'resolveContextWindowTokens', 'buildProviderWindowTable', 'isUsableWindow',
      // 配置层（S2-①）
      'resolveModelArg', 'formatResolutionRef', 'validateProviderConfigs', 'checkProviderConfigs',
      'formatApiKeyTag', 'findTokenOnlyDuplicates', 'toAcpConfig', 'checkCompressionConfig',
      'resolveCompactionWindow', 'checkCompactionConfig', 'buildCompactionOptions',
      'checkCompactionReachability', 'checkTelemetryConfig', 'buildConfigOverview',
      // 权限接缝（S2-②）
      'InteractivePermissionEngine',
      // 装配主体（S2-③）
      'HarnessHost', 'createHost',
    ]
    for (const name of MOVED) {
      const h = host[name]
      if (h === undefined) throw new Error(`@harness/host 未导出 ${name}（导出面被改动）`)
      if (cli[name] !== h) throw new Error(`@harness/cli 的 ${name} 与 @harness/host 不同源（re-export 被改动）`)
      expect(cli[name]).toBe(h)
    }
  })
})

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

  it('a2a 子命令 + --port/--token', () => {
    expect(parseCliArgs(['a2a']).command).toBe('a2a')
    expect(parseCliArgs(['a2a']).a2aPort).toBeUndefined()
    const a = parseCliArgs(['a2a', '--port', '5000', '--token', 'secret', '--cwd', '/x'])
    expect(a.command).toBe('a2a')
    expect(a.a2aPort).toBe(5000)
    expect(a.a2aToken).toBe('secret')
    expect(a.cwd).toBe('/x')
    // 不传 token ⇒ undefined（匿名，仅本机可达）
    expect(parseCliArgs(['a2a', '--port', '0']).a2aToken).toBeUndefined()
  })

  it('a2a --json：结构化握手标记（默认关闭）', () => {
    // 供扩展 / 脚本 spawn 后确定性地取端点；不传则走人类可读多行输出。
    expect(parseCliArgs(['a2a', '--json']).json).toBe(true)
    expect(parseCliArgs(['a2a', '--json', '--port', '0'])).toMatchObject({ json: true, a2aPort: 0 })
    expect(parseCliArgs(['a2a']).json).toBeUndefined()
    expect(parseCliArgs([]).json).toBeUndefined()
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

  it('buildConfigOverview：显示 token 校正系数（未配则不显示）', () => {
    const scaled = buildConfigOverview(
      { model: 'm', compression: { enabled: true, tokenCalibrationScale: 1.33 } },
      'mock',
    )
    expect(scaled).toInclude('token 口径 自动（CJK 感知）')
    expect(scaled).toInclude('× 校正 1.33')

    // 缺省 / 显式 1 都不显示（不制造噪音）
    const none = buildConfigOverview({ model: 'm', compression: { enabled: true } }, 'mock')
    expect(none).not.toInclude('× 校正')
    const one = buildConfigOverview(
      { model: 'm', compression: { enabled: true, tokenCalibrationScale: 1 } },
      'mock',
    )
    expect(one).not.toInclude('× 校正')
  })

  it('checkCompressionConfig：tokenCalibrationScale 非法取值告警（> 0 的数才是合法）', () => {
    // 合法：正数
    expect(checkCompressionConfig({ tokenCalibrationScale: 1.33 })).toHaveLength(0)
    // 非法：0 / 负数 / 字符串
    for (const bad of [0, -1, '1.33'] as const) {
      const out = checkCompressionConfig({ tokenCalibrationScale: bad })
      expect(out.some((m) => m.includes('compression.tokenCalibrationScale'))).toBe(true)
      expect(out.some((m) => m.includes('已按不校正（1）处理'))).toBe(true)
    }
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
        manualInjection: 'on-demand',
        windowGuard: { enabled: true, notifyPct: 0.75, forceCompressPct: 0.9, onExceedPct: 0.98, onExceed: 'truncate' },
        subagent: {
          modelContextLimit: 200_000,
          manualInjection: 'off',
          preserveRecentMessages: 3,
          preserveRecentTokens: 30_000,
          promotionThreshold: 4,
          tiers: { tier2Trigger: 5, tier3Trigger: 10 },
          nudge: { maxContextLimitPct: 0.75, minContextLimitPct: 0.45, emergencyThresholdPct: 0.95 },
          config: { truncate: { threshold: 0.95 }, nudge: { growthRatio: 0 }, compress: { minSummaryLength: 50 } },
        },
        perAgent: {
          reader: { manualInjection: 'off', modelContextLimit: 128_000 },
          coordinator: { config: { absorb: { enabled: true } } },
        },
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
    // 非对象的档位段不误报 —— `subagent: "off"` 这种脏数据按"未配置"处理，不该刷屏
    expect(checkCompressionConfig({ subagent: 'off', perAgent: { reader: 'off' } })).toEqual([])
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

  it('checkCompressionConfig：manualInjection 非法取值告警（顶层与档位同一套口径）', () => {
    // 三个合法档位都不告警
    for (const mode of ['on-demand', 'always', 'off']) {
      expect(checkCompressionConfig({ manualInjection: mode })).toEqual([])
    }
    // 顶层与档位段都要报 —— 只在顶层查会让"档位里写错静默"成为新的失效面
    const bad = checkCompressionConfig({
      manualInjection: 'never',
      subagent: { manualInjection: 'always-on' },
    })
    expect(bad).toContain(
      'compression.manualInjection 取值 "never" 未知（可选：on-demand / always / off），已按 on-demand 处理',
    )
    expect(bad).toContain(
      'compression.subagent.manualInjection 取值 "always-on" 未知（可选：on-demand / always / off），已按 on-demand 处理',
    )
    expect(bad.length).toBe(2)
  })

  it('checkCompressionConfig：窗口保护闸（B3）的非法阈值/取值都被点名', () => {
    // 插件侧 resolveWindowGuard 对非法值**静默回落默认**（本闸是旁路保护，不该因一个拼错的
    // 百分比让会话起不来）⇒ 不在这里报，用户就只会看到"配了没反应"。
    const issues = checkCompressionConfig({
      windowGuard: {
        enabled: 'yes',            // 应为布尔
        notifyPct: 0,              // (0,1] 之外
        forceCompressPct: 1.5,     // 超过窗口
        onExceedPct: NaN,
        onExceed: 'abort',         // 只认 truncate / refuse
        notifyPct2: 0.5,           // 拼错的键名
      },
    })
    expect(issues).toContain('compression.windowGuard.enabled 取值 "yes" 非法（应为布尔），已按 true 处理')
    expect(issues).toContain('compression.windowGuard.notifyPct 取值 0 非法（应为 (0, 1] 的占用率），已按默认值处理')
    expect(issues).toContain('compression.windowGuard.forceCompressPct 取值 1.5 非法（应为 (0, 1] 的占用率），已按默认值处理')
    expect(issues.some((m) => m.includes('compression.windowGuard.onExceedPct 取值'))).toBe(true)
    expect(issues).toContain(
      'compression.windowGuard.onExceed 取值 "abort" 未知（可选：truncate / refuse），已按 truncate 处理',
    )
    expect(issues).toContain('compression.windowGuard.notifyPct2 未被识别，该配置不会生效')
    expect(issues.length).toBe(6)
  })

  it('checkCompressionConfig：窗口保护闸三档写反序要告警（低档永远不可达 = 配了却不生效）', () => {
    const issues = checkCompressionConfig({ windowGuard: { notifyPct: 0.95, forceCompressPct: 0.6 } })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('compression.windowGuard.notifyPct（0.95）高于 .forceCompressPct（0.6）')
    expect(issues[0]).toContain('永远不可达')
    // 正序 / 只给一个键 → 零告警（不能对合法配置刷屏）
    expect(checkCompressionConfig({ windowGuard: { notifyPct: 0.5, forceCompressPct: 0.9, onExceedPct: 0.98 } })).toEqual([])
    expect(checkCompressionConfig({ windowGuard: { notifyPct: 0.5 } })).toEqual([])
    expect(checkCompressionConfig({ windowGuard: {} })).toEqual([])
    expect(checkCompressionConfig({ windowGuard: undefined })).toEqual([])
  })

  it('checkCompressionConfig：档位段内的未知键带作用域路径报出（含 perAgent 的 agent id）', () => {
    const issues = checkCompressionConfig({
      subagent: {
        preserveRecentToken: 30_000, // 少个 s —— 顶层会报，档位里同样要报
        nudge: { minGrowthFloar: 1 }, // 拼错的键（少个 o）：既不在结构化口、也不在内核字段表 ⇒ 朴素文案
        config: {
          preserveRecentToken: 30_000, // 高级透传里同样的错
          compress: { minSummaryLenght: 50 }, // 内核 CompressValidationConfig 拼错
        },
      },
      perAgent: {
        reader: { manualInjecton: 'off' }, // 档位顶层键拼错（agent id 写对、字段写错）
        reviewer: { tiers: { tier2trigger: 5 } },
      },
    })
    expect(issues).toContain('compression.subagent.preserveRecentToken 未被识别，该档位不会生效')
    expect(issues).toContain('compression.subagent.nudge.minGrowthFloar 未被识别，该配置不会生效')
    expect(issues).toContain('compression.subagent.config.preserveRecentToken 内核 Config 无此字段，该配置不会生效')
    expect(issues).toContain(
      'compression.subagent.config.compress.minSummaryLenght 内核 CompressValidationConfig 无此字段，该配置不会生效',
    )
    expect(issues).toContain('compression.perAgent.reader.manualInjecton 未被识别，该档位不会生效')
    expect(issues).toContain('compression.perAgent.reviewer.tiers.tier2trigger 未被识别，该配置不会生效')
    expect(issues.length).toBe(6)
  })

  it('checkCompressionConfig：内核字段写进结构化口时，告警直接指出该写到哪（顶层与档位同一套）', () => {
    // 这两个键**确实是内核字段**，只是写错了口 —— 结构化的 `nudge` / `tiers` 刻意只收常用键，
    // 内核字段的其余部分必须写 `config.*`。只报"未被识别"会让人只知道没生效、不知道该搬到哪
    //（真机反馈：`compression.subagent.nudge.growthFloor`，抄的就是文档正文里的字段名）。
    const top = checkCompressionConfig({ nudge: { growthFloor: 75_000 }, tiers: { enabled: true } })
    expect(top.join('\n')).toInclude('compression.nudge.growthFloor 未被识别')
    expect(top.join('\n')).toInclude('请写到 compression.config.nudge.growthFloor 才生效')
    expect(top.join('\n')).toInclude('compression.tiers.enabled 未被识别')
    expect(top.join('\n')).toInclude('请写到 compression.config.tiers.enabled 才生效')
    expect(top.length).toBe(2)

    // 档位里同理，且路径要带作用域前缀（含 perAgent 的 agent id）
    const scoped = checkCompressionConfig({
      subagent: { nudge: { minGrowthRatio: 0.45 }, tiers: { enabled: false } },
      perAgent: { reader: { nudge: { frequency: 5 } } },
    })
    expect(scoped.join('\n')).toInclude('请写到 compression.subagent.config.nudge.minGrowthRatio 才生效')
    expect(scoped.join('\n')).toInclude('请写到 compression.subagent.config.tiers.enabled 才生效')
    expect(scoped.join('\n')).toInclude('请写到 compression.perAgent.reader.config.nudge.frequency 才生效')
    expect(scoped.length).toBe(3)
  })

  it('checkCompressionConfig：拼错的键不会被指到"内核字段"那条路上（指路只认内核真实字段名）', () => {
    // 与上一条正交。若把"长得像"的键也指路，用户会照着告警抄一条**同样无效**的路径 ——
    // 比不指路更糟。内核字段表里没有 `growthFloar` / `minGrowthFloar` ⇒ 只能朴素文案。
    const issues = checkCompressionConfig({ nudge: { growthFloar: 1, minGrowthFloar: 2 } })
    expect(issues).toContain('compression.nudge.growthFloar 未被识别，该配置不会生效')
    expect(issues).toContain('compression.nudge.minGrowthFloar 未被识别，该配置不会生效')
    expect(issues.length).toBe(2)
  })

  it('checkTelemetryConfig：未知键附可用键清单（该段没有透传口，写错的键没有别的去处）', () => {
    // 真机反馈 `telemetry.store: { directory, debounceMs }` —— 想配"目录 + 防抖"，
    // 而目录本就是 `sessions`（不可单独配）、`debounceMs` 是顶层键。段内没有兜底透传口，
    // 所以必须把合法键直接列出来。
    const issues = checkTelemetryConfig({ store: { directory: 'sessions', debounceMs: 500 } })
    expect(issues.join('\n')).toInclude(
      'telemetry.store 未被识别，该配置不会生效（可用键：enabled / path / debounceMs / crash / userId / otlp）',
    )
    expect(issues.length).toBe(1)
    expect(checkTelemetryConfig({ otlp: { endpont: 'https://x' } }).join('\n')).toInclude(
      'telemetry.otlp.endpont 未被识别，该配置不会生效（可用键：enabled / endpoint / headers）',
    )
  })

  it('docs 里的 jsonc 示例必须通过 checkCompressionConfig（文档是规格，不该含"照抄就告警"的示例）', () => {
    // 起因：正文把 `growthFloor` 这类**内核字段名**统一记作 `nudge.X`，而 §7.5 / 速查卡的"直接抄"
    // 示例又把它写进了结构化口 `nudge:` —— 照抄就报"未被识别"，用户却以为自己写对了。
    // 把"文档示例"变成受检对象：改了口径却漏改示例，这条立刻红。
    const docsDir = join(import.meta.dir, '..', '..', '..', 'docs')
    const stripComments = (s: string): string => s.replace(/(^|\s)\/\/.*$/gm, '$1')
    const bad: string[] = []
    let checked = 0
    for (const file of readdirSync(docsDir).filter((f) => f.endsWith('.md'))) {
      const md = readFileSync(join(docsDir, file), 'utf8')
      for (const m of md.matchAll(/```jsonc\n([\s\S]*?)```/g)) {
        // 片段里可能并列写多个候选对象（每行一个）：按行累积，能 parse 就收一个
        let buf = ''
        for (const line of stripComments(m[1]).split('\n')) {
          buf += (buf ? '\n' : '') + line
          try {
            const obj = JSON.parse(buf.trim()) as Record<string, unknown>
            buf = ''
            const target = (obj.compression ?? obj) as Record<string, unknown>
            if (typeof target !== 'object' || target === null || Array.isArray(target)) continue
            if (!('tiers' in target || 'nudge' in target || 'config' in target || 'enabled' in target)) continue
            checked++
            const issues = checkCompressionConfig(target)
            if (issues.length) bad.push(`${file} → ${issues.join(' / ')}`)
          } catch {
            /* 还没凑齐（或含占位符），继续吃下一行 */
          }
        }
      }
    }
    // 守住"真的扫到了"：正则或目录一旦失配，不至于静默通过
    expect(checked).toBeGreaterThan(10)
    expect(bad).toEqual([])
  })

  it('toAcpConfig：结构化口与 config.* 描述同一棵子树时深合并（不再整体替换）', () => {
    // 文档 §6 的推荐用法就是"结构化口写常用几个 + config.* 补其余"，两者必须共存。
    // 旧实现是 `out.nudge = {三个 pct}`（整体替换），会把 `config.nudge.growthFloor` 静默丢掉 ——
    // 两个键都在"已配置"清单里，却只有一个活着。
    const out = toAcpConfig({
      config: { nudge: { growthFloor: 75_000, growthCap: 75_000 }, tiers: { enabled: true }, compress: { minSummaryLength: 1_000 } },
      nudge: { maxContextLimitPct: 0.65 },
      tiers: { tier2Trigger: 5 },
      preserveRecentTokens: 50_000,
    })
    expect(out.nudge).toEqual({ growthFloor: 75_000, growthCap: 75_000, maxContextLimitPct: 0.65 })
    expect(out.tiers).toEqual({ enabled: true, tier2Trigger: 5 })
    // 没有结构化口的子树（compress）原样透传，不受影响
    expect(out.compress).toEqual({ minSummaryLength: 1_000 })
    expect(out.preserveRecentTokens).toBe(50_000)
    // 同键冲突时以结构化口为准（显式字段压在最上层）
    expect(toAcpConfig({ config: { nudge: { maxContextLimitPct: 0.1 } }, nudge: { maxContextLimitPct: 0.9 } }).nudge).toEqual({
      maxContextLimitPct: 0.9,
    })
  })

  it('buildConfigOverview：窗口按 modelContextLimit → 默认 provider 的 contextWindowTokens → 200000 推导', () => {
    // 关键回归点：概览曾直接兜底 200000，与插件实际收到的窗口（providers[].contextWindowTokens）不符
    const base = { model: 'm', compression: { enabled: true } }
    // ① 显式覆盖优先
    expect(
      buildConfigOverview({ ...base, compression: { enabled: true, modelContextLimit: 300_000 } }, 'mock'),
    ).toInclude('fitWindow=300000')
    // ② 回退默认 provider 的 contextWindowTokens（默认 provider 省略 id 时按 model 派生，同样要命中）
    const withWin = {
      ...base,
      providers: [
        { id: 'other', type: 'openai', model: 'gpt-4o', contextWindowTokens: 1_000_000 },
        { type: 'openai', model: 'hy3', contextWindowTokens: 102_400 },
      ],
    } as unknown as HarnessConfig
    expect(buildConfigOverview(withWin, 'hy3')).toInclude('fitWindow=102400')
    // ③ 都没有才兜底 200000
    expect(buildConfigOverview(base, 'mock')).toInclude('fitWindow=200000')
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

  it('查表顺序与 acp-context 的 lookupProviderWindow 一致（守卫：两份实现不许各说各话）', async () => {
    // 为什么要有这条：CLI 侧刻意**没有**复用 acp-context 的实现 —— 那会连带 acp-kernel 上启动
    // 路径（为 6 行查表加载整棵内核不划算）。于是"ACP 与 compaction 同一把尺子"这件事只能靠
    // 这条用例钉住：谁改了取小 / 判空 / 优先级规则而另一边没跟上，这里就红。
    const { lookupProviderWindow } = await import('@harness/acp-context')
    const providers = [
      { id: 'big', type: 'openai', model: 'gpt-4o', contextWindowTokens: 1_000_000 },
      { id: 'small-a', type: 'openai', model: 'hy3', contextWindowTokens: 200_000 },
      { id: 'small-b', type: 'openai', model: 'hy3', contextWindowTokens: 102_400 },
      { id: 'no-win', type: 'openai', model: 'm1' },
      { id: 'zero', type: 'openai', model: 'm2', contextWindowTokens: 0 },
    ] as HarnessConfig['providers']
    const cfg = { providers }
    const table = buildProviderWindowTable(cfg, 'big')
    const cases: Array<{ providerId?: string; modelId?: string }> = [
      {}, { providerId: 'big' }, { providerId: 'small-b' }, { providerId: 'no-win' }, { providerId: 'zero' },
      { modelId: 'hy3' }, { modelId: 'm1' }, { providerId: 'ghost' },
      { providerId: 'no-win', modelId: 'hy3' }, { providerId: 'ghost', modelId: 'm2' },
    ]
    for (const ep of cases) {
      const viaAcp = lookupProviderWindow(table, ep.providerId, ep.modelId) ?? table.fallback
      expect(resolveCompactionWindow(cfg, 'big', ep)).toBe(viaAcp)
    }
    // 同名模型多端点取最小（宁可早压；分母虚高会漏压）——两边都得是 102400
    expect(lookupProviderWindow(table, undefined, 'hy3')).toBe(102_400)
    expect(resolveCompactionWindow(cfg, 'big', { modelId: 'hy3' })).toBe(102_400)
  })

  it('ACP 装配：窗口只传"显式值"，默认 Provider 的窗口走 providerWindows.fallback（防回归）', () => {
    // 为什么要读源码文本：这条装配行**没有**别的守卫能覆盖它 —— 插件侧用例无论收到什么选项都成立，
    // 类型上也通不过检查（`modelContextLimit?: number` 收得下任何数字）。而把它写回
    // `resolveContextWindowTokens(cfg, defaultProviderId)` 就等于**复活本轮修的 bug**：
    // 所有会话（含子 Agent）共用默认 Provider 的分母，占用率虚低、压缩不触发且毫无症状。
    // 两份文本断言都很短且唯一，失败时的信息直接指出"装配行写错了"。
    //
    // P0 收尾 S2 第三步：装配行随 `boot()` 搬进了 `@harness/host`（`packages/host/src/host.ts`），
    // 守卫据此改读新家 —— 断言的两行**逐字未改**，只是位置变了。这一点很重要：守卫必须跟着
    // 代码走，否则它会在"代码搬走了"时以失败的形式误报（本次改造第一轮就跑出过这条失败）。
    const src = readFileSync(new URL('../../host/src/host.ts', import.meta.url), 'utf8')
    const start = src.indexOf('acp.createAcpContextPlugin({')
    expect(start).toBeGreaterThan(0)
    const body = src.slice(start, src.indexOf('})', start))
    expect(body).toInclude('modelContextLimit: compression.modelContextLimit')
    expect(body).toInclude('providerWindows: buildProviderWindowTable(cfg, defaultProviderId)')
    // 窗口保护闸（B3）同理：这一行没有别的守卫能覆盖它 —— 漏传 ⇒ `resolveWindowGuard(undefined)`
    // 仍会给出默认档，闸门看起来"在工作"、实际宿主怎么配都无效（静默失效）。
    expect(body).toInclude('windowGuard: compression.windowGuard')
  })

  it('checkCompactionConfig：拼错键与非法取值都能被点名', () => {
    const issues = checkCompactionConfig({
      keepRecentMessage: 20,
      strategy: 'summarize',
      tokenCalibration: 'chars/4',
    })
    expect(issues).toContain('compaction.keepRecentMessage 未被识别，该配置不会生效')
    expect(issues).toContain('compaction.strategy 取值 "summarize" 未知（可选：prune / summary / agent），已按默认 summary 处理')
    expect(issues).toContain('compaction.tokenCalibration 取值 "chars/4" 未知（可选：auto / chars4），已按默认 auto 处理')
    expect(issues.length).toBe(3)
  })

  it('checkCompactionConfig：全部合法键写满 → 零告警（白名单完整性守卫）', () => {
    expect(
      checkCompactionConfig({
        strategy: 'agent',
        autoCompactThresholdPct: 70,
        reservedTokens: 10_000,
        contextWindowTokens: 60_000,
        keepRecentMessages: 20,
        summaryMaxChars: 5_000,
        tokenCalibration: 'chars4',
      }),
    ).toEqual([])
    expect(checkCompactionConfig(undefined)).toEqual([])
  })

  it('checkCompactionReachability：阈值 ≥ 窗口时告警（自动压缩形同虚设的主要成因）', () => {
    // 默认参数 + 真实小窗口：(102400−30000)×80% = 57920 < 102400 ⇒ 可达
    const providers = [{ type: 'openai', model: 'hy3', contextWindowTokens: 102_400 }] as HarnessConfig['providers']
    expect(checkCompactionReachability({ providers }, 'hy3')).toBeUndefined()
    // 阈值被抬到窗口之上：无论会话多长都不会触发，且此前没有任何症状
    const bad = checkCompactionReachability(
      { providers, compaction: { autoCompactThresholdPct: 150, reservedTokens: 0 } },
      'hy3',
    )
    expect(bad).toInclude('永远不会触发')
    expect(bad).toInclude('102400')
  })

  it('buildConfigOverview：会话压缩展示窗口与阈值，并对不可达阈值给出告警', () => {
    const providers = [{ type: 'openai', model: 'hy3', contextWindowTokens: 102_400 }] as HarnessConfig['providers']
    const ok = buildConfigOverview({ providers }, 'hy3')
    expect(ok).toInclude('会话压缩（/compact）：窗口 102400 · 阈值 57920 tokens')
    expect(ok).toInclude('策略 summary · 保留最近 10 条 · token 口径 自动（CJK 感知）')
    expect(ok).toInclude('（全部默认值，config.json → compaction 可配）')
    const bad = buildConfigOverview({ providers, compaction: { autoCompactThresholdPct: 150, reservedTokens: 0 } }, 'hy3')
    expect(bad).toInclude('永远不会触发')
    // 拼错键也一并点名（必须绕开结构类型：多余键正是本用例要模拟的脏数据）
    const typo = { compaction: { keepRecentMessage: 20 } } as unknown as HarnessConfig
    expect(buildConfigOverview(typo, 'mock')).toInclude('compaction.keepRecentMessage 未被识别')
  })

  it('buildConfigOverview：providers 窗口不一致时注明"这个窗口只对默认 Provider 成立"', () => {
    // 不注明就会被读成"我的会话就是这个分母"：默认端点 300K、会话切到 200K 的模型后，
    // 阈值按 300K 算出来 256500 > 200000 —— 概览看着一切正常，压缩却永不触发。
    const providers: NonNullable<HarnessConfig['providers']> = [
      { id: 'big', type: 'openai', model: 'm-big', contextWindowTokens: 300_000 },
      { id: 'small', type: 'openai', model: 'm-small', contextWindowTokens: 200_000 },
    ]
    expect(buildConfigOverview({ providers }, 'big'))
      .toInclude('会话压缩（/compact）：窗口 300000（默认 Provider 口径；各会话按自身端点解析）')
    // 只有一个窗口 ⇒ 无分化可标注（保持改造前的输出，不制造噪音）
    expect(buildConfigOverview({ providers: [providers[0]!] }, 'big'))
      .not.toInclude('各会话按自身端点解析')
    // 显式配了窗口 ⇒ 所有会话都按它算，同样没有分化可标注
    expect(buildConfigOverview({ providers, compaction: { contextWindowTokens: 123_456 } }, 'big'))
      .not.toInclude('各会话按自身端点解析')
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
})

describe('内置插件声明式启用（config.json → plugins）', () => {
  it('BuiltinPluginRegistry 登记 mcp.server-registry（进程内 MCP server 的宿主）', () => {
    const entry = getBuiltinRegistry().get('mcp.server-registry')!
    expect(entry).toBeDefined()
    expect(entry.source).toBe('builtin')
    // 宿主插件自身不提供工具，无需 metaSource
    expect(entry.metaSource).toBeUndefined()
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

// 四态语义 / 模式短路 / 规则写回已上移到 `@harness/host`（`permission.test.ts` 是那份能力测试）。
// 这里只留 **CLI 适配器**该管的两件事：`askPrompt` 文本 → 四态的映射（'a'/'d'/'A'/'D'），
// 以及 `--permission` 的解析。S4 收口时删掉了与 host 重复的 allow-all / deny-all / getMode 用例。
describe('CliPermissionEngine（CLI 适配器：文本提问 → 四态）', () => {
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

/**
 * 工具回显：**完整打印，不截断**。
 *
 * 此前入参写死 `JSON.stringify(input).slice(0, 60) + '...'`、结果 `.slice(0, 120)`：
 * bash 命令稍长就只剩前半截（而且是**变形**过的前半截），长输出的结论永远落在 120 字符
 * 之外。下面用"超过旧上限的正文必须一字不少地出现"来锁 —— 谁把 slice 加回来立刻变红，
 * 而不是仅凭肉眼"看着差不多"。
 */
describe('工具回显格式化：完整打印 + 续行标记', () => {
  it('formatToolInput：长入参原样序列化，不切、不加省略号', () => {
    const command = `for i in $(seq 1 30); do echo "line-$i-${'p'.repeat(40)}"; done`
    expect(command.length).toBeGreaterThan(60)                 // 旧实现在 60 字符处切断
    const s = formatToolInput({ command, description: '遍历打印' })
    expect(s).toBe(JSON.stringify({ command, description: '遍历打印' }))
    expect(s).toContain(JSON.stringify(command))
  })

  it('formatToolInput：undefined → {}；不可序列化时退化为完整字符串而非抛错', () => {
    expect(formatToolInput(undefined)).toBe('{}')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => formatToolInput(cyclic)).not.toThrow()
    expect(formatToolInput(cyclic)).toContain('self')
  })

  it('formatToolResult：长结果一字不少（不再停在 120 字符）', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line-${i}-${'y'.repeat(30)}`).join('\n')
    expect(body.length).toBeGreaterThan(5_000)
    expect(formatToolResult(body)).toBe(body)
  })

  it('formatToolResult：对象结果 JSON 化后同样完整', () => {
    const out = { path: '/tmp/a.ts', content: 'z'.repeat(300), totalLines: 1 }
    expect(formatToolResult(out)).toBe(JSON.stringify(out))
  })

  it('formatToolResult：续行标记只在 TUI 模式下加', () => {
    // REPL：纯文本通道，原样输出
    expect(formatToolResult('l1\nl2\nl3')).toBe('l1\nl2\nl3')
    // TUI：第 2..N 行带标记（供分类器并块）
    expect(formatToolResult('l1\nl2\nl3', true).split('\n'))
      .toEqual(['l1', `${TOOL_CONT_MARK}l2`, `${TOOL_CONT_MARK}l3`])
    // 单行结果无需标记
    expect(formatToolResult('single', true)).toBe('single')
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
    // overlay 覆盖（文档化的配置覆盖链）**不打**「被重新注册」WARN：这是正常路径，
    // 每次启动刷一条会把真正异常的那条淹掉。覆盖事实仍进 agent.reregistered（from/to 带来源）。
    expect(chunks.join('')).not.toInclude('被重新注册')
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
    // 来源列读的是**运行期注册表**的 source（谁把它装上去的），不是配置意图：
    // 这两个实例由 openai 类型插件按自己的 id 注册，所以是 plugin:provider.<id>
    expect(output).toInclude('来源=plugin:provider.deepseek')
    expect(output).toInclude('来源=plugin:provider.local')
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

  it('同 type=anthropic 的两个端点：各按自己的 ProviderConfig.id 注册 / 分发（P2：不再互相覆盖）', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'claude-a',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'claude-a', type: 'anthropic', baseUrl: 'https://a.example.com', apiKey: 'key-a', model: 'claude-3-5-sonnet' },
        { id: 'claude-b', type: 'anthropic', baseUrl: 'https://b.example.com', apiKey: 'key-b', model: 'claude-3-5-sonnet' },
      ],
    })
    const { harness } = await app.boot()
    const h = harness as unknown as {
      resolveChatProvider: (id?: string) => { id?: string; config?: { apiKey?: string; baseUrl?: string } } | undefined
      providers: { list(): Array<{ id: string; source: string; type?: string; isDefault: boolean }> }
    }
    // 两个实例各占一个注册键。修前它们都自报 id='anthropic' ⇒ 只剩最后一个（claude-b 覆盖 claude-a）
    expect(h.providers.list().map((p) => p.id).sort()).toEqual(['claude-a', 'claude-b'])
    // 来源与类型随实例带出来（/model 的来源列可用）
    expect(h.providers.list().every((p) => p.type === 'anthropic')).toBe(true)
    // 来源是插件注册键（不是 legacy）—— 迁移完成的标志
    expect(h.providers.list().map((p) => p.source).sort()).toEqual([
      'plugin:provider.claude-a',
      'plugin:provider.claude-b',
    ])

    const a = h.resolveChatProvider('claude-a')
    const b = h.resolveChatProvider('claude-b')
    expect(a?.id).toBe('claude-a')
    expect(a?.config?.apiKey).toBe('key-a')
    expect(a?.config?.baseUrl).toContain('a.example.com')
    expect(b?.id).toBe('claude-b')
    expect(b?.config?.apiKey).toBe('key-b')
    expect(b?.config?.baseUrl).toContain('b.example.com')
    // 默认 = claude-a（CLI 显式 setDefault，不再靠「最后注册赢」）；未注册 id 回退它
    expect(h.providers.list().find((p) => p.isDefault)?.id).toBe('claude-a')
    expect(h.resolveChatProvider('nope')).toBe(a)
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

  it('内置 Provider 类型全部走运行期注册表（source=plugin:*），不再依赖 @internal 的 _setChatProvider', async () => {
    const stdout = { write: () => {} }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'oai',
      permissionMode: 'allow-all', stdout, mockProviderConfig: { defaultResponse: 'hi' },
      providers: [
        { id: 'oai', type: 'openai', baseUrl: 'http://x', apiKey: 'k' },
        { id: 'g', type: 'glm', apiKey: 'k' },
        { id: 'q', type: 'qwen', apiKey: 'k' },
        { id: 'c', type: 'anthropic', apiKey: 'k' },
        { id: 'gem', type: 'gemini', apiKey: 'k' },
      ],
    })
    const { harness } = await app.boot()
    const list = (harness as unknown as {
      providers: { list(): Array<{ id: string; source: string; type?: string }> }
    }).providers.list()
    const byId = new Map(list.map((p) => [p.id, p]))
    // 五个实例，各占一个注册键、各带自己的 source
    expect([...byId.keys()].sort()).toEqual(['c', 'g', 'gem', 'oai', 'q'])
    for (const [id, type] of [['oai', 'openai'], ['g', 'glm'], ['q', 'qwen'], ['c', 'anthropic'], ['gem', 'gemini']] as const) {
      expect(byId.get(id)).toMatchObject({ source: `plugin:provider.${id}`, type })
    }
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
            async 'core.harness.init'(_i: unknown, output: any) {
              output?.harness?.providers?.register('my-gw', provider as any, { source: 'plugin:my-gw' })
            },
          } as any
        },
      }),
    })
    const { harness } = await app.boot()
    expect(app.listProviders()).toContain('my-gw')
    const h = harness as unknown as {
      resolveChatProvider: (id?: string) => { id?: string }
      providers: { list(): Array<{ id: string; source: string }> }
    }
    expect(h.resolveChatProvider('my-gw')?.id).toBe('my-gw')
    // 第三方插件走的是**与内置包同一条**公开路径（`providers.register`）。
    // `_setChatProvider` 删除后不再有第二条注入路径 —— 这也是"内置包全迁完"
    // 与"第三方不落后"两件事同时成立的原因（见 remaining-work-plan §2-D）。
    expect(h.providers.list().map((p) => p.source)).toEqual(['plugin:my-gw'])
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
      // P1-D：a2a 子命令必须在帮助里可发现（否则等于没入口）
      expect(HELP_TEXT).toInclude('harness a2a')
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

  /**
   * 观察点 2：`barrier.completed` 只在**全部**任务结束时发 —— 真机 s_1790163574429_tg1a6 里
   * 快任务 19:43:10 就完成了，barrier 到 19:44:03 才触发，快结果被慢任务拖了 53 秒。
   * coordinator 因此补了一条「单个任务完成」事件，这里固定"它也能唤醒续轮"。
   */
  it('coordinator.worker.completed（单任务完成）同样触发注入 <continue/>，且卸载函数两条都摘', async () => {
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
    await harness.bus.publish(CoordinatorEvents.workerCompleted, {
      sessionId: 's_parent', taskId: 'task-a', status: 'completed', remaining: 2,
    } as any)
    expect(injected).toEqual(['<continue/>'])

    // 卸载必须把**两条**订阅都摘掉：只摘一条会让"已在后台等待唤醒"的订阅泄漏到下一次装配
    detach()
    await harness.bus.publish(CoordinatorEvents.workerCompleted, {
      sessionId: 's_parent', taskId: 'task-b', status: 'completed', remaining: 1,
    } as any)
    await harness.bus.publish(CoordinatorEvents.barrierCompleted, {
      sessionId: 's_parent', taskIds: ['task-a', 'task-b'],
    } as any)
    expect(injected).toEqual(['<continue/>'])

    await app.shutdown()
  })

  /**
   * 自动续轮（`<continue/>`）的空转识别。
   *
   * 内部循环上线后，一次自动续轮可能跑多步（每步都是一次模型调用），所以
   * 「没有后台结果却仍续轮」的代价被放大了 —— 这类空转必须被识别出来。
   */
  it('自动续轮空转识别：无待处理通知时跳过，不发起查询', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    const sess = await harness.session.create()

    const out: string[] = []
    const processLine = createProcessLine({
      app, harness, session: sess, out: (s) => { out.push(s) },
    })

    const r = await processLine('<continue/>')

    expect(r).toBe('continue')
    expect(out.join('')).toContain('跳过本次自动续轮')
    // 关键：确实没有发起模型调用
    expect(out.join('')).not.toContain('hi')
    await app.shutdown()
  })

  it('自动续轮：有待处理通知时正常执行（不误跳）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: { defaultResponse: '汇总完成' },
    })
    const { harness } = await app.boot()
    const sess = await harness.session.create()

    harness.session.enqueueNotification(sess.id, '[task-notification] 后台任务已完成')

    const out: string[] = []
    const processLine = createProcessLine({
      app, harness, session: sess, out: (s) => { out.push(s) },
    })

    await processLine('<continue/>')

    expect(out.join('')).not.toContain('跳过本次自动续轮')
    expect(out.join('')).toContain('汇总完成')
    // 通知被消费（drain）掉了
    expect(harness.session.peekNotifications(sess.id)).toEqual([])
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

  /**
   * 工具回显：**完整打印，不截断**。
   *
   * 此前入参写死 `JSON.stringify(input).slice(0, 60) + '...'`、结果 `.slice(0, 120)`：
   * bash 命令稍长就只看得到前半截（而且是**变形**后的前半截），长输出的结论永远落在
   * 120 字符之外。下面的断言都用"超过旧上限的正文必须一字不少地出现"来锁 —— 谁把 slice
   * 加回来，它们立刻变红（而不是仅凭肉眼"看不出区别"）。
   */
  it('工具回显完整打印：整条命令（>60 字符）与最后一行输出（>120 字符处）都在', async () => {
    const command = `for i in $(seq 1 30); do echo "line-$i-${'p'.repeat(20)}"; done`
    const lastLine = `line-30-${'p'.repeat(20)}`
    expect(command.length).toBeGreaterThan(60)

    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout: { write: () => {} },
      mockProviderConfig: {
        defaultResponse: '完成',
        responses: [{
          match: '跑一条命令', once: true, response: '',
          toolCalls: [{ toolUseId: 't1', toolId: 'bash', input: { command } }],
        }],
      },
    })
    const { harness } = await app.boot()
    const sess = await harness.session.create()

    const out: string[] = []
    const processLine = createProcessLine({ app, harness, session: sess, out: (s) => { out.push(s) } })
    await processLine('跑一条命令')
    const text = out.join('')
    // 断言必须**盯住 🔧 那一行**：bash 的 output 里也回显了 command，用整段文本判"命令是否完整"
    // 会被那份回显蒙混过去（回退验证实测：入参切到 60 字符时整段断言照样通过）。
    const toolLine = text.split('\n').find((l) => l.startsWith('🔧')) ?? ''

    // ① 入参完整（含 JSON 结尾引号）⇒ 没被切到 60 字符
    expect(toolLine).toContain(JSON.stringify(command))
    // ② 结果完整 ⇒ 没被切到 120 字符
    expect(text).toContain(lastLine)
    // ③ REPL 是直写 stdout 的纯文本通道：不能出现 TUI 专用的续行标记
    expect(text).not.toContain(TOOL_CONT_MARK)

    await app.shutdown()
  })

  it('多行字符串结果：TUI 模式带续行标记、REPL 模式是干净原文', async () => {
    // 为什么要注入工具：MCP 工具返回的就是**纯字符串**（多行文本内容，见 mcp-client 的
    // `texts[0]` / `texts.join('\n')`），而内置工具的 output 是对象 —— JSON.stringify 会把
    // 换行转义成 `\n` 两个字符，压根不带真实换行。用注入工具才造得出"多行结果"。
    const MultiText: AgentPlugin = {
      id: 'multi-text-tool', version: '1', name: 'MultiText',
      async install() {
        return {
          async 'core.tool.pool.assemble'(_i: unknown, pool: unknown) {
            (pool as { add: (t: unknown) => void }).add(defineTool({
              id: 'echo_text',
              description: '回显多行文本',
              inputSchema: {
                parse: (v: unknown) => v,
                safeParse: (v: unknown) => ({ success: true as const, data: v }),
                __jsonSchema: { type: 'object', properties: {} },
              } as never,
              async call() { return { ok: true, output: 'alpha\nbeta\ngamma' } },
            }))
          },
        } as Hooks
      },
    }
    const boot = (match: string) => new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout: { write: () => {} },
      extraPlugins: [MultiText],
      mockProviderConfig: {
        defaultResponse: '完成',
        responses: [{
          match, once: true, response: '',
          toolCalls: [{ toolUseId: 'tt', toolId: 'echo_text', input: {} }],
        }],
      },
    })

    // ① REPL 模式（无 onEvent）：直写 stdout 的纯文本通道，不能出现传输用标记
    const replApp = boot('第一次')
    const a = await replApp.boot()
    const aSess = await a.harness.session.create()
    const replOut: string[] = []
    await createProcessLine({ app: replApp, harness: a.harness, session: aSess, out: (s) => { replOut.push(s) } })('第一次')
    expect(replOut.join('')).toContain('alpha\nbeta\ngamma')
    expect(replOut.join('')).not.toContain(TOOL_CONT_MARK)
    await replApp.shutdown()

    // ② TUI 模式（有 onEvent）：续行带标记，分类器据此并回同一个 tool 块
    const tuiApp = boot('第二次')
    const b = await tuiApp.boot()
    const bSess = await b.harness.session.create()
    const tuiOut: string[] = []
    await createProcessLine({
      app: tuiApp, harness: b.harness, session: bSess,
      out: (s) => { tuiOut.push(s) }, onEvent: () => {},
    })('第二次')
    expect(tuiOut.join('')).toContain(`${TOOL_CONT_MARK}beta`)
    await tuiApp.shutdown()
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
    // 注册实例数：装了什么插件 与 注册了什么实例 是两个维度；默认实例带 (默认) 标记
    expect(out).toInclude('已注册 Provider 实例 1：mock(默认)')
    expect(out).toInclude('已注册 Agent 1：default')
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

describe('HarnessApp 日志 sink（引擎告警不该写进 TUI 渲染流）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-logsink-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('挂 sink ⇒ warn/error 走 sink 不写 stdout；卸载 ⇒ 恢复写 stdout', () => {
    const buf: string[] = []
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      stdout: { write: (s: string) => void buf.push(s) },
    })
    const captured: Array<{ level: string; msg: string }> = []
    app.setLogSink((level, msg) => { captured.push({ level, msg }) })
    // 直接经 app 调用（保持 this 绑定；emitLog 是 private，测试用 as any 访问）
    const emit = (l: 'warn' | 'error', m: string, meta?: unknown) => (app as unknown as { emitLog(l: 'warn' | 'error', m: string, meta?: unknown): void }).emitLog(l, m, meta)

    // 挂 sink 时：路由到应用层，stdout 不被写（TUI 拿它做布局，直写会错位）
    emit('warn', 'system 区前缀变化，缓存整段重算', { sessionId: 's1' })
    expect(captured).toEqual([{ level: 'warn', msg: 'system 区前缀变化，缓存整段重算' }])
    expect(buf).toEqual([])

    // 卸载 sink：恢复写 stdout（headless/REPL 行为不变）
    app.setLogSink(undefined)
    emit('error', 'boom', { a: 1 })
    expect(captured.length).toBe(1)
    expect(buf.join('')).toContain('[ERROR] boom')
  })
})
