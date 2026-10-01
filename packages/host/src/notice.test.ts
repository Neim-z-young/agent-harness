/**
 * 装配期诊断通道的归属测试（P0 收尾 · S1）。
 *
 * 这一批用例是 S2 的**判据**：S2 要把 boot 内 20 处 `stdout?.write?.(...)` 换成 `emitNotice(...)`，
 * 而"文案逐字不变"在 S2 之后是**看不见的**（diff 里只剩函数名换了）。把 21 条模板的字节钉在这里，
 * S2 的重构就有了可执行的判据，而不是靠读 diff 目测。
 *
 * 三层：
 *   ① 逐条快照 —— 每个 code 的完整字节（含结尾换行、缩进空格数）；
 *   ② 与真实 `loadPluginDirs` 的**捕获字节**对照 —— 外部插件目录那三条的"双换行"不是本模块的
 *      风格选择，是今天的实际输出（`out()` 自带 `\n`，CLI 回调再加一个），必须与实现对齐；
 *   ③ 等级表 —— 分级不是装饰：把 `provider.fallback-mock` 降成 `log` 必须让这里失败。
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderTypeRegistry } from '@harness/plugin'
import { loadPluginDirs } from './index'
import {
  NOTICE_LEVEL,
  installConsoleCapture,
  makeNotice,
  renderNotice,
  type NoticeCode,
  type NoticeLevel,
} from './notice'

const r = (code: NoticeCode, data: unknown): string =>
  renderNotice(makeNotice(code as never, data as never))

describe('renderNotice：逐条字节快照（S2 的逐字不变判据）', () => {
  it('plugins.code-skipped：默认闸门只登记不执行，列出前 5 个文件与两条开闸路径', () => {
    expect(r('plugins.code-skipped', { count: 3, files: ['/p/a.ts', '/p/b.ts', '/p/c.ts'] })).toBe(
      '已跳过 3 个插件代码文件（默认不加载外部插件代码，防止代码注入）：\n\n' +
        '  - /p/a.ts\n\n' +
        '  - /p/b.ts\n\n' +
        '  - /p/c.ts\n\n' +
        '  启用内置能力请改用 config.json → "plugins": ["code-intel"]（零代码，推荐）；\n\n' +
        '  确需加载自定义插件代码时，设置 config.json → "allowPluginCode": true 或启动参数 --allow-plugin-code。\n\n',
    )
  })

  it('plugins.code-skipped：超过 5 个时才追加"其余 N 个"（N 按总数减已列出的算）', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
    const text = r('plugins.code-skipped', { count: 8, files })
    expect(text).toContain('已跳过 8 个插件代码文件')
    expect(text).toContain('  …… 其余 3 个\n\n')
    // 少于等于 5 个时不得出现该行
    expect(r('plugins.code-skipped', { count: 5, files })).not.toContain('其余')
  })

  it('plugins.load-failed：裸依赖时多一行成因与处置提示', () => {
    expect(r('plugins.load-failed', { file: '/p/x.ts', message: 'boom', bareDependency: false })).toBe(
      '插件加载失败 /p/x.ts：boom\n\n',
    )
    expect(r('plugins.load-failed', { file: '/p/x.ts', message: 'boom', bareDependency: true })).toBe(
      '插件加载失败 /p/x.ts：boom\n\n' +
        '  （该插件目录无法解析裸依赖：请把它放在能解析到依赖的位置；或改用 config.json → "plugins" 声明式启用内置能力）\n\n',
    )
  })

  it('plugins.not-a-plugin：既无通用插件也无 Provider 工厂时只留一行', () => {
    expect(r('plugins.not-a-plugin', { file: '/p/x.ts' })).toBe(
      '插件模块既未导出通用 AgentPlugin 也未导出有效 Provider 类型工厂，已忽略：/p/x.ts\n',
    )
  })

  it('config.providers-invalid：汇总成带缩进的清单（随后 throw）', () => {
    expect(r('config.providers-invalid', { issues: ['providers[0] 重复', 'providers[1] 缺 id'] })).toBe(
      '配置错误（config.json → providers）：\n  - providers[0] 重复\n  - providers[1] 缺 id\n',
    )
  })

  it('config.secret-unresolved：单行（随后 throw）', () => {
    expect(r('config.secret-unresolved', { message: '密钥解密失败' })).toBe('配置错误：密钥解密失败\n')
  })

  it('config.plugins-inactive：未生效项 + 可用清单两行（cli.test.ts 的 boot「未登记 id 只告警」钉的就是这条）', () => {
    expect(r('config.plugins-inactive', { unknown: ['no-such-plugin'], available: ['memory', 'code-intel'] })).toBe(
      '[WARN] config.json → plugins 有未生效项：no-such-plugin\n' +
        '       可用内置插件：memory / code-intel\n',
    )
  })

  it('config.*-inactive：四个段共用同一形态（7 空格缩进的清单）', () => {
    expect(r('config.compression-inactive', { items: ['未知键 t5'] })).toBe(
      '[WARN] config.json → compression 有以下未生效项：\n       - 未知键 t5\n',
    )
    expect(r('config.compaction-inactive', { items: ['阈值不可达'] })).toBe(
      '[WARN] config.json → compaction 有以下问题：\n       - 阈值不可达\n',
    )
    expect(r('config.memory-inactive', { items: ['未知键 foo'] })).toBe(
      '[WARN] config.json → memory 有以下问题：\n       - 未知键 foo\n',
    )
    expect(r('config.telemetry-inactive', { items: ['未知键 bar'] })).toBe(
      '[WARN] config.json → telemetry 有以下问题：\n       - 未知键 bar\n',
    )
  })

  it('config.memory-not-enabled：写了 memory 段却没声明插件', () => {
    expect(r('config.memory-not-enabled', undefined)).toBe(
      '[WARN] config.json 写了 memory 段，但没有启用记忆（plugins 里加 "memory"）⇒ 该段不会生效\n',
    )
  })

  it('provider.construct-failed：⚠️ 后是两个空格，且以空行收尾', () => {
    expect(r('provider.construct-failed', { providerId: 'my-endpoint' })).toBe(
      '⚠️  未能构造默认 Provider "my-endpoint"（未知 type）。\n\n',
    )
  })

  it('provider.fallback-mock：两种成因文案不同，都是 notice 级降级事实', () => {
    expect(r('provider.fallback-mock', { requested: 'my-endpoint', reason: 'not-configured' })).toBe(
      'ℹ️  未在 config.json → providers 中找到默认 Provider "my-endpoint"，自动 fallback 到 Mock Provider。\n' +
        '   可在 <data-dir>/config.json 的 providers 数组中定义它（type=openai/anthropic/gemini）。\n\n',
    )
    expect(r('provider.fallback-mock', { requested: 'anthropic', reason: 'no-key' })).toBe(
      'ℹ️  未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock Provider。\n' +
        '   如要使用真实 Claude，请 export ANTHROPIC_API_KEY=xxx。\n\n',
    )
  })

  it('provider.default-chosen：三种形态（带 type / 降级到 mock / 自定义 id 无 type）', () => {
    expect(
      r('provider.default-chosen', { configured: 'anthropic', actual: 'anthropic', type: 'anthropic', model: 'claude-3-5-sonnet' }),
    ).toBe(
      '✅ 默认 Provider: anthropic（type=anthropic · model=claude-3-5-sonnet）\n' +
        '   /model 命令可切换；若 "当前模型" 仍显示 Mock，请重启 CLI 使配置生效。\n\n',
    )
    // mock 分支优先于 type 标签；且"配置意图 ≠ 实际装配"时**多一行偏差说明**
    expect(r('provider.default-chosen', { configured: 'anthropic', actual: 'mock' })).toBe(
      '✅ 默认 Provider: mock（测试 Mock）\n' +
        '   config.json → provider="anthropic"，实际装配 "mock"。\n' +
        '   /model 命令可切换；若 "当前模型" 仍显示 Mock，请重启 CLI 使配置生效。\n\n',
    )
    // 自定义 id 但没写 type ⇒ 无标签、无偏差行（配置意图与实际一致）
    expect(r('provider.default-chosen', { configured: 'ollama', actual: 'ollama' })).toBe(
      '✅ 默认 Provider: ollama\n' +
        '   /model 命令可切换；若 "当前模型" 仍显示 Mock，请重启 CLI 使配置生效。\n\n',
    )
  })

  it('provider.default-not-registered：setDefault 落空不静默', () => {
    expect(r('provider.default-not-registered', { providerId: 'ghost' })).toBe(
      '[WARN] 默认 Provider "ghost" 未注册为实例；已回退 resolve() 默认链（首个已注册 → 构造期 Provider）。\n',
    )
  })

  it('preload.*：后台预加载的四条（含 verbose 才要的 warmed）+ L1 元信息预载失败', () => {
    expect(r('preload.plugin-failed', { pluginId: 'subagent', message: 'boom' })).toBe(
      '[WARN] 内置插件「subagent」后台预加载失败：boom\n',
    )
    expect(r('preload.warmed', { pluginId: 'subagent' })).toBe('[INFO] 内置插件「subagent」已后台预热。\n')
    expect(r('preload.install-failed', { message: 'boom' })).toBe('[WARN] 内置插件安装失败：boom\n')
    expect(r('preload.tools-failed', { message: 'boom' })).toBe('[WARN] 工具池预热失败：boom\n')
    // S2 补的漏网 code：字节必须**显式带换行** —— 改造前是 `console.warn(无换行结尾的串)`，
    // 换行由 console 自己补。sink 出口没有 console 代劳，所以要自己写。
    expect(r('preload.meta-source-failed', { pluginId: 'tools-builtin', message: 'boom' })).toBe(
      '[WARN] 内置插件「tools-builtin」元信息来源预载失败：boom\n',
    )
  })

  it('log.info / log.debug：meta 用真值判断（空串 / 0 / null 都不追加）', () => {
    expect(r('log.info', { message: 'hi' })).toBe('[INFO] hi\n')
    expect(r('log.info', { message: 'hi', meta: { a: 1 } })).toBe('[INFO] hi {"a":1}\n')
    expect(r('log.info', { message: 'hi', meta: '' })).toBe('[INFO] hi\n')
    expect(r('log.debug', { message: 'hi', meta: undefined })).toBe('[DEBUG] hi\n')
  })

  it('每条都以换行结尾（渲染器契约：可直接 write）', () => {
    const samples: Array<[NoticeCode, unknown]> = [
      ['plugins.code-skipped', { count: 1, files: ['a'] }],
      ['plugins.load-failed', { file: 'a', message: 'm', bareDependency: false }],
      ['plugins.not-a-plugin', { file: 'a' }],
      ['config.providers-invalid', { issues: [] }],
      ['config.secret-unresolved', { message: 'm' }],
      ['config.plugins-inactive', { unknown: [], available: [] }],
      ['config.compression-inactive', { items: [] }],
      ['config.compaction-inactive', { items: [] }],
      ['config.memory-not-enabled', undefined],
      ['config.memory-inactive', { items: [] }],
      ['config.telemetry-inactive', { items: [] }],
      ['provider.construct-failed', { providerId: 'p' }],
      ['provider.fallback-mock', { requested: 'p', reason: 'no-key' }],
      ['provider.default-chosen', { configured: 'a', actual: 'a' }],
      ['provider.default-not-registered', { providerId: 'p' }],
      ['preload.plugin-failed', { pluginId: 'p', message: 'm' }],
      ['preload.warmed', { pluginId: 'p' }],
      ['preload.install-failed', { message: 'm' }],
      ['preload.tools-failed', { message: 'm' }],
      ['preload.meta-source-failed', { pluginId: 'p', message: 'm' }],
      ['log.info', { message: 'm' }],
      ['log.debug', { message: 'm' }],
    ]
    // 覆盖度自查：每个 code 都必须在这里出现（新增 code 忘了写快照 ⇒ 这条失败）
    expect(new Set(samples.map(([c]) => c))).toEqual(new Set(Object.keys(NOTICE_LEVEL) as NoticeCode[]))
    for (const [code, data] of samples) expect(r(code, data).endsWith('\n')).toBe(true)
  })

  it('未知 code 不静默：返回可见兜底行，绝不返回空串', () => {
    const bogus = { level: 'notice', code: 'nope.unknown', data: { a: 1 } } as never
    const text = renderNotice(bogus)
    expect(text).not.toBe('')
    expect(text).toContain('nope.unknown')
    expect(text).toContain('{"a":1}')
  })
})

describe('与真实 loadPluginDirs 的捕获字节对齐（"双换行"不是本模块的风格选择）', () => {
  it('code-skipped：逐字等于 CLI 今天写入的字节', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-notice-'))
    try {
      const pluginDir = join(dir, 'plugins')
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(join(pluginDir, 'evil.ts'), 'export const plugins = []\n')

      // 复刻 CLI 今天的回调：`(s) => stdout?.write?.(s + '\n')`
      const bytes: string[] = []
      await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], (s) => bytes.push(s + '\n'), {
        allowCode: false,
      })

      const expected = r('plugins.code-skipped', {
        count: 1,
        files: [join(pluginDir, 'evil.ts')],
      })
      expect(expected).toBe(bytes.join(''))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('load-failed：模板的前后缀与换行与实现一致（消息槽位原样透传）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-notice-'))
    try {
      const pluginDir = join(dir, 'plugins')
      mkdirSync(pluginDir, { recursive: true })
      const file = join(pluginDir, 'broken.ts')
      writeFileSync(file, 'throw new Error("kaboom")\n')

      const bytes: string[] = []
      await loadPluginDirs(new ProviderTypeRegistry(), [pluginDir], (s) => bytes.push(s + '\n'), {
        allowCode: true,
      })

      expect(bytes.length).toBeGreaterThan(0)
      const prefix = `插件加载失败 ${file}：`
      expect(bytes[0]!.startsWith(prefix)).toBe(true)
      expect(bytes[0]!.endsWith('\n')).toBe(true)
      // 捕获形态 = `msg + '\n'`（out 自带）+ '\n'（CLI 回调再加）⇒ 取回原始 msg 要剥**两层**换行。
      // （第一次写这条断言就少剥了一层，收到 `kaboom\n`，渲染出来平白多一个空行。）
      const message = bytes[0]!.slice(prefix.length, -2)
      expect(bytes[0]).toBe(prefix + message + '\n\n')

      expect(r('plugins.load-failed', { file, message, bareDependency: false })).toBe(bytes.join(''))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('等级表：分级不是装饰', () => {
  it('"配置意图 ≠ 实际装配"与降级事实必须是 notice 级', () => {
    // 这几条是 A2A 必须上报的：漏了它，远程调用方会拿到 Mock 的回答而毫无信号
    expect(NOTICE_LEVEL['provider.fallback-mock']).toBe('notice')
    expect(NOTICE_LEVEL['provider.construct-failed']).toBe('notice')
    expect(NOTICE_LEVEL['provider.default-chosen']).toBe('notice')
    expect(NOTICE_LEVEL['config.providers-invalid']).toBe('notice')
  })

  it('"配置写了没生效"类必须是 warn 级', () => {
    const warnCodes: NoticeCode[] = [
      'config.plugins-inactive',
      'config.compression-inactive',
      'config.compaction-inactive',
      'config.memory-not-enabled',
      'config.memory-inactive',
      'config.telemetry-inactive',
      'provider.default-not-registered',
      'preload.plugin-failed',
      'preload.install-failed',
      'preload.tools-failed',
      'preload.meta-source-failed',
    ]
    for (const c of warnCodes) expect(NOTICE_LEVEL[c]).toBe('warn')
  })

  it('verbose 才要的三条是 log 级（门控在 host 侧，渲染器不判 verbose）', () => {
    const logCodes: NoticeCode[] = ['log.info', 'log.debug', 'preload.warmed']
    for (const c of logCodes) expect(NOTICE_LEVEL[c]).toBe('log')
  })

  it('makeNotice 从表里盖等级 —— 调用点无从填错', () => {
    const n = makeNotice('provider.fallback-mock', { requested: 'x', reason: 'no-key' })
    expect(n.level).toBe('notice')
    const l = makeNotice('log.debug', { message: 'x' })
    expect(l.level).toBe('log')
  })

  it('等级取值只有三种', () => {
    const allowed: NoticeLevel[] = ['notice', 'warn', 'log']
    for (const level of Object.values(NOTICE_LEVEL)) expect(allowed).toContain(level)
  })
})

describe('installConsoleCapture：罩住第三方 SDK 的 console（P1 用）', () => {
  it('安装后 warn/error 转交 handler，卸载后还原原函数', () => {
    const originalWarn = console.warn
    const originalError = console.error
    const seen: Array<[string, unknown[]]> = []

    const uninstall = installConsoleCapture((level, args) => seen.push([level, args]))
    expect(console.warn).not.toBe(originalWarn)
    console.warn('a', 1)
    console.error('b')
    uninstall()

    expect(seen).toEqual([
      ['warn', ['a', 1]],
      ['error', ['b']],
    ])
    // 还原到**同一个函数引用**（不是新包装），否则测试环境里会层层套娃
    expect(console.warn).toBe(originalWarn)
    expect(console.error).toBe(originalError)
  })
})
