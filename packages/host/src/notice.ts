/**
 * 装配期诊断通道（P0 收尾 · S1；S2 补一枚漏网 code `preload.meta-source-failed`）
 *
 * 解决的问题：`HarnessApp.boot` 与 boot 末尾的后台预加载共 20 处
 * `this.options.stdout?.write?.(...)` ——
 *   ① 三类语义混在一起（**用户必须知道的事实** / 配置写了没生效的告警 / verbose 才要的日志）；
 *   ② **宿主不传 `stdout` 时全部静默丢弃**：A2A server、VSCode 扩展、headless 都拿不到，
 *      于是「未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock」这类降级事实**没有任何信号**——
 *      远程调用方拿到的是 Mock 的回答，却以为自己接的是真模型。这是本仓"静默失效"老病的同一形态。
 *
 * 本模块只做三件事，**不含任何装配逻辑**（S1 纯新增、不接线，见
 * `docs/host-extraction-design.md` §4）：
 *   1. `HostNotice` 判别联合：`code` → 结构化 `data` 的类型映射；
 *   2. `renderNotice`：**逐字复刻**今天写进 stdout 的字节（含结尾换行），供 CLI 直接用
 *      ⇒ 搬迁后文案零变化，且 22 条从此有独立快照可依附（不再靠"跑一次 boot 抄 stdout"）；
 *   3. `installConsoleCapture`：罩住第三方 SDK 自己 `console.*` 的输出（P0.5 spike 实测：
 *      A2A SDK 的 `DefaultRequestHandler` 在 executor 抛异常时自己 `console.error` 打完整堆栈）。
 *
 * ## 与 `HarnessApp.setLogSink` 的分工：两条通道，不合并
 * | | 本模块 `onNotice` | `setLogSink`（既有，不改） |
 * |---|---|---|
 * | 时机 | **装配期**一次性（boot + 后台预加载） | **运行期**每轮 query |
 * | 内容 | 事实 / 告警 / verbose 日志，带稳定 `code` | 引擎 warn/error，自由文本 msg + meta |
 * | 消费方 | CLI 启动诊断 / A2A 任务 metadata / 启动自检 | TUI console 块 |
 * | 挂载 | 构造期 option（boot 之前就生效） | 运行期 `setLogSink()`（TUI 启动后挂） |
 * 合并两条要改一个已被测试钉住的契约，收益只是"少一个名词"。
 *
 * ## ⚠️ 设计修正：`level` 只有一份（不写在调用点）
 * 设计稿的 `HostNotice` 让调用点自己填 `level`。那等于把"这条算不算必须知道的事实"复制到
 * 20 个调用点 —— 正是本仓"同一个东西两套写法"的老病（改一处漏一处）。这里改为
 * **`NOTICE_LEVEL` 表是唯一来源**，`makeNotice()` 从表里盖 `level`，调用点只给 `code` + `data`。
 * 反面收益是**可测**：把 `provider.fallback-mock` 降级成 `log` 必须让测试失败（见
 * `notice.test.ts` 的等级表断言），而不是让"分级"退化成装饰。
 */

/** 三级：`notice` = 用户必须知道的事实；`warn` = 配置写了没生效；`log` = verbose 才要 */
export type NoticeLevel = 'notice' | 'warn' | 'log'

/**
 * code → 结构化 payload 的类型映射。**新增一处输出必须同时在此登记**：
 * 类型是判别联合的判别依据，漏登记 = 编译期就报错（不是等某次跑 boot 才发现少了一行）。
 *
 * 字段命名原则：只放**变量**，不放文案（常量文案归 `renderNotice`），
 * 也不放**可推导**的字段（如 fallback 的 `actual` 恒为 `'mock'`、default-chosen 的
 * `mismatch` 恒等于 `configured !== actual`）—— 冗余字段就是第二份口径。
 */
export interface NoticePayloads {
  // ── 外部插件目录（`loadPluginDirs`；这三条的字节含"双换行"，见 renderNotice 的说明）──
  /** 默认闸门：插件目录里的代码只登记不执行（代码注入防护），列出前 5 个文件 */
  'plugins.code-skipped': { count: number; files: string[] }
  /** 单个插件模块 import 失败 */
  'plugins.load-failed': { file: string; message: string; bareDependency: boolean }
  /** 模块既没导出通用 AgentPlugin、也没导出有效 Provider 类型工厂 ⇒ 已忽略 */
  'plugins.not-a-plugin': { file: string }

  // ── 配置校验（前两条随后 throw）──
  'config.providers-invalid': { issues: string[] }
  'config.secret-unresolved': { message: string }
  // ── 配置写了没生效（各段检查器汇总）──
  'config.plugins-inactive': { unknown: string[]; available: string[] }
  'config.compression-inactive': { items: string[] }
  'config.compaction-inactive': { items: string[] }
  'config.sandbox-inactive': { items: string[] }
  'config.memory-not-enabled': undefined
  'config.memory-inactive': { items: string[] }
  'config.telemetry-inactive': { items: string[] }

  // ── Provider 装配 ──
  'provider.construct-failed': { providerId: string }
  /**
   * 降级事实：请求的 Provider 用不了，实际装配成 Mock。
   * `reason` 区分两种成因（未配置 / 无 key），文案不同；两条都是 `notice` 级 ——
   * 远程宿主必须把它挂进任务 metadata，否则调用方拿到假回答而**没有任何信号**。
   */
  'provider.fallback-mock': { requested: string; reason: 'not-configured' | 'no-key' }
  /** 启动横幅：实际装配的默认 Provider（`configured !== actual` 时多一行偏差说明） */
  'provider.default-chosen': { configured: string; actual: string; type?: string; model?: string }
  'provider.default-not-registered': { providerId: string }

  // ── 后台预加载（`scheduleBuiltinPreload`，fire-and-forget）──
  'preload.plugin-failed': { pluginId: string; message: string }
  'preload.warmed': { pluginId: string }
  'preload.install-failed': { message: string }
  'preload.tools-failed': { message: string }
  /**
   * L1 元信息来源预载失败（`preloadBuiltinToolMetas`）。
   * **S2 才纳入的漏网站点**：这条此前是 `console.warn` 直写（不走 stdout、也不走 setLogSink），
   * 是本仓唯一"两个出口都不沾"的装配期诊断 —— 在 A2A 宿主下等于无声（见设计稿 §8 ②）。
   */
  'preload.meta-source-failed': { pluginId: string; message: string }

  // ── verbose 日志 ──
  'log.info': { message: string; meta?: unknown }
  'log.debug': { message: string; meta?: unknown }
}

export type NoticeCode = keyof NoticePayloads
export type NoticeData<C extends NoticeCode> = NoticePayloads[C]

/**
 * 稳定机器码 → 等级。**唯一来源**（见文件头「设计修正」）：
 * CLI 用 `renderNotice` 出文案，A2A 按 `code` 决定是否进任务 metadata / 启动自检。
 */
export const NOTICE_LEVEL: { readonly [C in NoticeCode]: NoticeLevel } = {
  // 用户必须知道的事实 —— 尤其是"配置意图与实际装配不一致"
  'plugins.code-skipped': 'notice',
  'plugins.load-failed': 'notice',
  'plugins.not-a-plugin': 'notice',
  'config.providers-invalid': 'notice',
  'config.secret-unresolved': 'notice',
  'provider.construct-failed': 'notice',
  'provider.fallback-mock': 'notice',
  'provider.default-chosen': 'notice',
  // 配置写了但没生效：丢一条不影响正确性，静默失效才是老病
  'config.plugins-inactive': 'warn',
  'config.compression-inactive': 'warn',
  'config.compaction-inactive': 'warn',
  'config.sandbox-inactive': 'warn',
  'config.memory-not-enabled': 'warn',
  'config.memory-inactive': 'warn',
  'config.telemetry-inactive': 'warn',
  'provider.default-not-registered': 'warn',
  'preload.plugin-failed': 'warn',
  'preload.install-failed': 'warn',
  'preload.tools-failed': 'warn',
  'preload.meta-source-failed': 'warn',
  // verbose 才要的（门控在 host 侧：verbose 为假时干脆不 emit，渲染器不必知道 verbose）
  'log.info': 'log',
  'log.debug': 'log',
  'preload.warmed': 'log',
}

/** 一次装配期诊断：`code` 决定等级（从 `NOTICE_LEVEL` 盖）与 `data` 的形状 */
export type HostNotice = {
  [C in NoticeCode]: { readonly level: NoticeLevel; readonly code: C; readonly data: NoticePayloads[C] }
}[NoticeCode]

/** 某个 code 对应的 notice 变体（保留判别信息 ⇒ 调用点取 `data` 时不用手动收窄） */
export type NoticeVariant<C extends NoticeCode> = Extract<HostNotice, { code: C }>

/** 构造一条 notice：等级由 `NOTICE_LEVEL` 决定，调用点无从填错 */
export function makeNotice<C extends NoticeCode>(code: C, data: NoticePayloads[C]): NoticeVariant<C> {
  // `as` 的理由：映射联合里"给定 C 时 level/code/data 三者同源"这件事 TS 推不出来
  // （它只看到 level 的可能取值与 data 的并集，无法自行配对）。运行时恒成立：
  // level 取自同上表的 NOTICE_LEVEL[code]，data 由调用点按 C 传入。
  return { level: NOTICE_LEVEL[code], code, data } as NoticeVariant<C>
}

/** 装配期诊断出口：CLI 接 `renderNotice` 写流；A2A / VSCode 按 `code` 上报 */
export type NoticeSink = (n: HostNotice) => void

/**
 * `HostNotice` → **今天写进 stdout 的那串字节**（可能含多次 `write` 的拼接，恒以换行结尾）。
 *
 * ## 为什么把"字节"当契约（而不是"文本"）
 * S2 要把 20 处 `stdout?.write?.(...)` 换成 `emitNotice(...)`，判据是**输出逐字不变**。
 * 只要本函数复刻的是同一串字节，"文案没变"就是可执行的断言（快照测试），而不是读 diff 目测。
 *
 * ## 为什么外部插件目录那三条是"双换行"
 * `loadPluginDirs` 的 `out()` 参数**自带结尾 `\n`**（`'已跳过 N 个…：\n'`），而 CLI 传的
 * 回调是 `(s) => stdout?.write?.(s + '\n')` —— 于是每个 out 落成 `…\n\n`。这三条据此复刻。
 * 这是今天的**实际字节**（跑一次就能复核），不是本函数的风格选择：S2 要零 diff 就必须留着它；
 * 想改掉那对空行是另一次**有意识**的改动（涉及 `loadPluginDirs` 的扇出形态，见其 `out` 调用）。
 *
 * ## 未知 code 不静默
 * 判别联合让未知 code 在类型层不成立，但运行时（非 TS 调用点）仍可能传进来。此时返回一条
 * **可见的兜底行**而不是空串 —— "静默丢弃"正是本模块要治的病，不能自己再犯一次。
 */
export function renderNotice(n: HostNotice): string {
  /** 外部插件目录专用：`out()` 自带 `\n`，回调再加一个；空串不产生行 */
  const outLines = (...parts: string[]): string => parts.filter(Boolean).map((p) => p + '\n').join('')

  switch (n.code) {
    case 'plugins.code-skipped':
      return outLines(
        `已跳过 ${n.data.count} 个插件代码文件（默认不加载外部插件代码，防止代码注入）：\n`,
        ...n.data.files.map((f) => `  - ${f}\n`),
        n.data.count > n.data.files.length ? `  …… 其余 ${n.data.count - n.data.files.length} 个\n` : '',
        '  启用内置能力请改用 config.json → "plugins": ["code-intel"]（零代码，推荐）；\n',
        '  确需加载自定义插件代码时，设置 config.json → "allowPluginCode": true 或启动参数 --allow-plugin-code。\n',
      )

    case 'plugins.load-failed':
      return outLines(
        `插件加载失败 ${n.data.file}：${n.data.message}\n`,
        n.data.bareDependency
          ? '  （该插件目录无法解析裸依赖：请把它放在能解析到依赖的位置；或改用 config.json → "plugins" 声明式启用内置能力）\n'
          : '',
      )

    case 'plugins.not-a-plugin':
      return outLines(`插件模块既未导出通用 AgentPlugin 也未导出有效 Provider 类型工厂，已忽略：${n.data.file}`)

    case 'config.providers-invalid':
      return '配置错误（config.json → providers）：\n' + n.data.issues.map((s) => `  - ${s}`).join('\n') + '\n'

    case 'config.secret-unresolved':
      return `配置错误：${n.data.message}\n`

    case 'config.plugins-inactive':
      return (
        `[WARN] config.json → plugins 有未生效项：${n.data.unknown.join('、')}\n` +
        `       可用内置插件：${n.data.available.join(' / ')}\n`
      )

    case 'config.compression-inactive':
      return (
        '[WARN] config.json → compression 有以下未生效项：\n' +
        n.data.items.map((m) => `       - ${m}`).join('\n') +
        '\n'
      )

    case 'config.compaction-inactive':
      return (
        '[WARN] config.json → compaction 有以下问题：\n' +
        n.data.items.map((m) => `       - ${m}`).join('\n') +
        '\n'
      )

    case 'config.sandbox-inactive':
      return (
        '[WARN] config.json → sandbox 有以下问题：\n' +
        n.data.items.map((m) => `       - ${m}`).join('\n') +
        '\n'
      )

    case 'config.memory-not-enabled':
      return '[WARN] config.json 写了 memory 段，但没有启用记忆（plugins 里加 "memory"）⇒ 该段不会生效\n'

    case 'config.memory-inactive':
      return (
        '[WARN] config.json → memory 有以下问题：\n' +
        n.data.items.map((m) => `       - ${m}`).join('\n') +
        '\n'
      )

    case 'config.telemetry-inactive':
      return (
        '[WARN] config.json → telemetry 有以下问题：\n' +
        n.data.items.map((m) => `       - ${m}`).join('\n') +
        '\n'
      )

    case 'provider.construct-failed':
      return `⚠️  未能构造默认 Provider "${n.data.providerId}"（未知 type）。\n\n`

    case 'provider.fallback-mock':
      return n.data.reason === 'not-configured'
        ? `ℹ️  未在 config.json → providers 中找到默认 Provider "${n.data.requested}"，` +
            '自动 fallback 到 Mock Provider。\n' +
            '   可在 <data-dir>/config.json 的 providers 数组中定义它（type=openai/anthropic/gemini）。\n\n'
        : 'ℹ️  未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock Provider。\n' +
            '   如要使用真实 Claude，请 export ANTHROPIC_API_KEY=xxx。\n\n'

    case 'provider.default-chosen': {
      const { actual, configured, type, model } = n.data
      const label = actual === 'mock' ? '（测试 Mock）' : type ? `（type=${type} · model=${model}）` : ''
      return (
        `✅ 默认 Provider: ${actual}${label}\n` +
        (configured !== actual ? `   config.json → provider="${configured}"，实际装配 "${actual}"。\n` : '') +
        `   /model 命令可切换；若 "当前模型" 仍显示 Mock，请重启 CLI 使配置生效。\n\n`
      )
    }

    case 'provider.default-not-registered':
      return (
        `[WARN] 默认 Provider "${n.data.providerId}" 未注册为实例；已回退 resolve() 默认链` +
        `（首个已注册 → 构造期 Provider）。\n`
      )

    case 'preload.plugin-failed':
      return `[WARN] 内置插件「${n.data.pluginId}」后台预加载失败：${n.data.message}\n`

    case 'preload.warmed':
      return `[INFO] 内置插件「${n.data.pluginId}」已后台预热。\n`

    case 'preload.install-failed':
      return `[WARN] 内置插件安装失败：${n.data.message}\n`

    case 'preload.tools-failed':
      return `[WARN] 工具池预热失败：${n.data.message}\n`

    case 'preload.meta-source-failed':
      // 改造前是 `console.warn('…')` —— console.warn 自己补换行，所以这里要把那个 `\n` 显式写上，
      // 两条出口（sink / console 兜底）的最终字节才一致。
      return `[WARN] 内置插件「${n.data.pluginId}」元信息来源预载失败：${n.data.message}\n`

    case 'log.info':
      // `meta` 用真值判断（与改造前逐字一致：空串 / 0 / null 都不追加）
      return `[INFO] ${n.data.message}${n.data.meta ? ' ' + JSON.stringify(n.data.meta) : ''}\n`

    case 'log.debug':
      return `[DEBUG] ${n.data.message}${n.data.meta ? ' ' + JSON.stringify(n.data.meta) : ''}\n`

    default: {
      // 类型层不可达；运行时兜底为**可见**一行（绝不返回空串 ⇒ 不重蹈"静默丢弃"）
      const u = n as { level?: string; code?: string; data?: unknown }
      return `[${String(u.level ?? 'notice').toUpperCase()}] ${String(u.code)} ${JSON.stringify(u.data ?? null)}\n`
    }
  }
}

/**
 * 临时接管 `console.warn` / `console.error`，返回卸载函数。
 *
 * 用途：第三方 SDK 的输出不走我们的日志出口。P0.5 spike 实测 —— A2A SDK 的
 * `DefaultRequestHandler` 在 executor 抛异常时会**自己 `console.error` 打完整堆栈**；
 * 宿主若只把结构化 code 回给调用方、却让堆栈打到共享 stdout，两个后果：
 *   ① 远程调用方拿到的是干净的错误码，而运维在服务日志里才能看到真因（合理）；
 *   ② 不接管则堆栈会混进任何"共用一个进程"的输出（TUI 渲染流、机器可读的 stdout 协议）。
 *
 * 边界：**不吞异常、不改语义**，只是把参数转给 handler（是否落日志、脱敏到什么程度由宿主定）。
 * 嵌套安装未做保护（重复安装时后一个持有原函数，卸载顺序必须与安装相反）—— 宿主数量级是 1。
 *
 * P0 只落工具 + 单测；P1 由 A2A server 在 boot 前装上、shutdown 时卸载（见设计稿 §2.6）。
 */
export function installConsoleCapture(
  handler: (level: 'warn' | 'error', args: unknown[]) => void,
): () => void {
  if (typeof console === 'undefined') return () => {}
  const original = { warn: console.warn, error: console.error }
  console.warn = (...args: unknown[]) => handler('warn', args)
  console.error = (...args: unknown[]) => handler('error', args)
  return () => {
    console.warn = original.warn
    console.error = original.error
  }
}
