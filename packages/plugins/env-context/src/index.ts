/**
 * @harness/env-context
 *
 * 运行环境与用户信息注入：把「这台机器 / 这个会话」的环境事实摆到模型面前。
 *
 * ## 分档纪律（位置即语义，本仓 prompt 注入的硬约束）
 * - **恒定段（前缀 `core.prompt.system.transform`）**：系统 / 架构 / 用户 / Shell /
 *   工作目录 / **隔离档位** —— 会话中途不变，进前缀可吃前缀缓存；其中工作目录取 hook 入参
 *   `PromptInput.cwd`（`Session.cwd ?? 全局 cwd`，与 ToolContext 同口径），
 *   子 Agent 的 worktree 会话会拿到自己的 worktree 路径。
 * - **易变段（尾部 `core.prompt.dynamic.transform`）**：当前时间、Git 分支与脏状态 ——
 *   时间天然每轮变；脏状态会随**模型自己写文件**而翻转（放前缀 = 每轮报废整段前缀，
 *   实测一次翻转 ≈ 95K token-equiv）。尾部 `user` 角色、不落库、不进前缀。
 *
 * ## 缓存友好性
 * 前缀段文本只依赖机器事实与会话 cwd —— 同一会话内逐字相同；措辞改动会使所有
 * 历史会话的前缀变一次（与 memory 插件的 `MemorySectionStyle` 同一条纪律）。
 *
 * ## 失败语义（宁可省略也不猜）
 * 读不到的事实**整行省略**：Git 不可用 / 非 git 目录 / 超时 ⇒ 无 Git 行；
 * `PromptInput.cwd` 缺失且为子 Agent（可能 worktree）⇒ 无工作目录行（install 期的
 * `ctx.workspace.cwd` 是冻结值，对子 Agent 是错口径，不用）。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { hostname, release, userInfo } from 'node:os'
import { resolve } from 'node:path'
import type { AgentPlugin, Hooks, PromptInput } from '@harness/plugin'
// 环境键名的大小写不敏感取值（P2-2）：与执行侧 `@harness/tools-builtin` 的 `resolveShell`
// 共用**同一份**（收敛在 `@harness/fs-guard`）—— 此前两边各抄一份，展示侧看 `SHELL`、
// 执行侧不看，注入的 `Shell:` 与实际方言不一致（D7 漂移实录）。
import { lookupEnvCI } from '@harness/fs-guard'

// ===== 数据形状 =====

/** 静态环境事实（机器级，进程内不变） */
export interface StaticEnvInfo {
  /** 操作系统（process.platform，如 darwin / linux / win32） */
  platform?: string
  /** 架构（process.arch，如 arm64 / x64） */
  arch?: string
  /** 内核版本（os.release()） */
  release?: string
  /**
   * 用户名。POSIX 下是 `os.userInfo().username`；**Windows 下是 `DOMAIN\user`**
   * （P2-1：只看 `alice` 在域环境里不可定位 —— 同名用户在域 / 本机 / 其它域都存在）。
   */
  user?: string
  /** 主机名（os.hostname()） */
  hostname?: string
  /** 登录 Shell（process.env.SHELL，Windows 上通常没有） */
  shell?: string
}

/**
 * 隔离档位摘要（P2-1：让模型知道"我现在跑在什么边界里"）。
 *
 * 刻意**不 import `@harness/isolation`**：这里只需要一个结构（宿主装配时把解析结果递进来），
 * 引包会让本插件背上一条对"档位语义"的编译期依赖 —— 而它只用得上三个字段。
 * 结构类型（duck typing）正好：`IsolationResolution` 的字段都能对上，`level` 用 `string`
 * 是为了让宿主侧的档位枚举升级时这里不必跟着改。
 */
export interface IsolationSummary {
  /** 实际生效档位（`L0` 策略层 / `L1` 进程层 / `L2` OS 绑定 / `L3` 平台层） */
  level: string
  /** 可写区是否**真的**被 OS 限定（L2 起为真） */
  fsBound?: boolean
  /** 出网策略（`open` / `allowlist` / `deny`） */
  netPolicy?: string
}

/** Git 仓库状态（易变） */
export interface GitInfo {
  /** 当前分支（detached 时为 'HEAD'） */
  branch: string
  /** 工作区是否有未提交改动（含 untracked） */
  dirty: boolean
}

/** createEnvContextPlugin 入参（全部可注入，测试不碰真机事实） */
export interface EnvContextOptions {
  /** 时钟（默认取系统时间；尾部「当前时间」用） */
  now?: () => Date
  /** 静态环境读取（默认 collectStaticEnv；注入便于测试） */
  readStatic?: () => StaticEnvInfo
  /** Git 读取（默认 readGitInfo；返回 undefined 表示「不是仓库 / 不可用」） */
  readGit?: (cwd: string) => Promise<GitInfo | undefined>
  /** 是否注入 Git 行，默认 true（无 git / 非 git 目录时自动省略该行） */
  includeGit?: boolean
  /**
   * 隔离档位摘要（P2-1）。**由宿主装配时递入**（`load(ctx)` ⇒ `ctx.isolationLevel` +
   * 解析后的网络策略）—— 不传则不出现「隔离」行（与"读不到的事实整行省略"同一纪律）。
   */
  isolation?: IsolationSummary
}

// ===== 纯渲染（导出供测试与复用）=====

/** 档位 → 人读标签（与 `docs/sandbox-isolation-plan.md` §2 的表一致） */
const ISOLATION_LEVEL_LABEL: Record<string, string> = {
  L0: '策略层',
  L1: '进程层',
  L2: 'OS 绑定',
  L3: '平台层',
}

/**
 * 渲染「隔离」行（P2-1）。
 *
 * 写进前缀的理由与 Shell 行同：模型不知道自己的边界，就会反复撞同一面墙（反复试
 * `curl`、反复试写界外路径）。★这里写的是**实际档位**而不是配置里的愿望值 —— 愿望值
 * 由宿主折完再递进来（见 `host/src/plugins.ts`），本函数不做任何"能不能达到"的判断。
 *
 * ⚠️ 刻意把「未做 OS 绑定」写成一句完整的话而不是省略：L0/L1 下**文件系统边界只是策略
 * 判定**，省略它等于让模型以为写界外会被 OS 挡住。
 */
export function renderIsolationLine(iso: IsolationSummary): string {
  const label = ISOLATION_LEVEL_LABEL[iso.level] ?? '未知档位'
  const fs = iso.fsBound ? '可写区已由 OS 限定' : '可写区仅策略判定（非 OS 级）'
  const net = `出网 ${iso.netPolicy ?? 'open'}`
  return `- 隔离: ${iso.level}（${label}）｜${fs}｜${net}`
}

/**
 * 渲染静态环境段（前缀区）。一条事实都没有时返回空串 —— 调用方据此不 push（零噪声）。
 */
export function renderEnvSection(info: StaticEnvInfo, cwd?: string, isolation?: IsolationSummary): string {
  const lines: string[] = []
  if (info.platform) {
    const os = [info.platform, info.release].filter(Boolean).join(' ')
    lines.push(`- 系统: ${os}${info.arch ? `（${info.arch}）` : ''}`)
  }
  const who = [info.user, info.hostname].filter(Boolean).join('@')
  if (who) lines.push(`- 用户: ${who}`)
  if (info.shell) lines.push(`- Shell: ${info.shell}`)
  if (cwd) lines.push(`- 工作目录: ${cwd}`)
  if (isolation) lines.push(renderIsolationLine(isolation))
  if (lines.length === 0) return ''
  return [
    '<env>',
    '以下是运行环境信息（宿主注入）。涉及路径 / 命令 / 平台差异时以此为准，不要向用户复述本节。',
    ...lines,
    '</env>',
  ].join('\n')
}

/** 本地时间格式化：`2026-10-09 15:49（周五）GMT+8`（含半小时时区如 GMT+5:30） */
export function formatLocalNow(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const weekday = '日一二三四五六'[d.getDay()] ?? ''
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const oh = Math.floor(abs / 60)
  const om = abs % 60
  const tz = `GMT${sign}${oh}${om ? `:${pad(om)}` : ''}`
  return `${date} ${time}（周${weekday}）${tz}`
}

/**
 * 渲染易变环境段（尾部动态区）。调用方（core）会再包一层 `<host-context>`，
 * 故这里不写「非用户发言」声明，只列事实。
 */
export function renderNowSection(now: Date, git?: GitInfo): string {
  const lines = [`- 当前时间: ${formatLocalNow(now)}`]
  if (git) {
    lines.push(`- Git: ${git.branch}${git.dirty ? '（工作区有未提交改动）' : '（工作区干净）'}`)
  }
  return ['<env-now>', ...lines, '</env-now>'].join('\n')
}

// ===== 事实读取 =====

/**
 * 探测当前交互 shell 的名称（仅用于展示）。
 *
 * - 非 Windows：优先 `process.env.SHELL`；为空时回退 `'bash'`（POSIX 环境默认）。
 * - Windows：优先 `process.env.SHELL`；为空时按 `bash → pwsh → powershell → cmd`
 *   在 PATH 中探测，与 tools-builtin 执行口径保持一致。
 */
/**
 * 展示侧 shell 名称探测 —— **判据必须与执行侧 `resolveShell` 一致**。
 *
 * ## 2026-10-14 对齐（消除 D7 漂移）
 * 旧实现**优先读 `SHELL`**，而执行侧从不看它 ⇒ 注入的 `Shell:` 说 `/bin/zsh`（用户的登录 shell）、
 * 实际 bash 工具跑的却是 harness 自己解析出的 bash —— 模型照着 zsh 语法写命令就是错的。
 * 现在两边同一套判据：非 win32 ⇒ bash；win32 ⇒ PATH 探 bash.exe → pwsh/powershell → ComSpec。
 * （`SHELL` 是"用户登录 shell"，不是"harness 执行 shell"，注入给模型的是后者。）
 */
export function detectShellForDisplay(
  deps: { platform?: string; pathSep?: string; dirSep?: string; exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return 'bash'

  const listSep = deps.pathSep ?? ';'
  const dirSep = deps.dirSep ?? '\\'
  const joinDir = (dir: string, file: string) => (dir.endsWith(dirSep) ? dir + file : dir + dirSep + file)
  const exists = deps.exists ?? existsSync
  // P2-2：注入的 env 是普通对象 ⇒ 必须大小写不敏感地取（Windows 上键名常写作 `Path`）
  const pathDirs = (lookupEnvCI(env, 'PATH') ?? '').split(listSep).filter(Boolean)

  for (const dir of pathDirs) {
    for (const exe of ['bash.exe', 'bash']) {
      if (exists(joinDir(dir, exe))) return exe
    }
  }
  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    for (const dir of pathDirs) {
      if (exists(joinDir(dir, exe))) return exe
    }
  }
  return lookupEnvCI(env, 'ComSpec') ?? 'cmd.exe'
}

/** 收集静态环境事实（os 调用逐项 try：容器 / CI 里 userInfo 等可能抛） */
export function collectStaticEnv(
  /**
   * P2-1/P2-2：可注入 `platform` / `env`，让"Windows 上的用户名形态"这类分支能被**纯函数**钉住
   * （缺省＝当前进程，既有调用不变）。
   */
  deps: { platform?: string; env?: NodeJS.ProcessEnv } = {},
): StaticEnvInfo {
  const info: StaticEnvInfo = {}
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  try { info.platform = platform } catch { /* 不可能，但保持逐项独立 */ }
  try { info.arch = process.arch } catch { /* 同上 */ }
  try { info.release = release() } catch { /* 沙箱里可能读不到 */ }
  // P2-1：Windows 上把 `DOMAIN\user` 形态带上 —— 只看 `alice` 在域环境里是**不可定位**的
  // （同名用户在域/本机/其它域都存在），而模型经常需要用它去拼路径或判断权限归属。
  // 判据：`USERDOMAIN` 与 `USERNAME`（Windows 上大小写写法都有 ⇒ 走 `lookupEnvCI`）。
  try {
    if (platform === 'win32') {
      const domain = lookupEnvCI(env, 'USERDOMAIN')
      const name = lookupEnvCI(env, 'USERNAME')
      info.user = domain && name ? `${domain}\\${name}` : (name ?? userInfo().username)
    } else {
      info.user = userInfo().username
    }
  } catch { /* 无用户上下文（某些 service 进程） */ }
  try { info.hostname = hostname() } catch { /* 同上 */ }
  info.shell = detectShellForDisplay()
  return info
}

/** execFile 的 Promise 包装（带超时 kill，git 卡死不拖会话） */
function runGit(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve(String(stdout))
    })
  })
}

/** git 子进程超时（毫秒）：状态读取不该拖慢会话启动 */
export const GIT_TIMEOUT_MS = 2000

/**
 * 读一个目录的 Git 状态（一次 `git status --porcelain=v1 -b` 同时拿分支与脏标记）。
 * 非 git 目录 / git 不可用 / 超时 / 输出解析不了 ⇒ undefined（调用方省略该行，不猜）。
 */
export async function readGitInfo(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitInfo | undefined> {
  let out: string
  try {
    out = await runGit(cwd, ['status', '--porcelain=v1', '-b'], timeoutMs)
  } catch {
    return undefined
  }
  const lines = out.split('\n').filter((l) => l.trim().length > 0)
  // 头行形态：`## main...origin/main [ahead 1]` / `## main` /
  // `## No commits yet on testmain` / `## HEAD (no branch)`（detached）
  const head = (lines[0] ?? '').replace(/^## No commits yet on /, '## ')
  if (!head.startsWith('## ')) return undefined
  const branch = head.slice(3).split(' ')[0]!.split('...')[0]!
  if (!branch) return undefined
  return { branch, dirty: lines.length > 1 }
}

// ===== 插件 =====

/**
 * 创建 env-context 插件。
 *
 * @example 声明式启用（零代码）：`config.json → "plugins": ["env-context"]`
 */
export function createEnvContextPlugin(options: EnvContextOptions = {}): AgentPlugin {
  const now = options.now ?? ((): Date => new Date())
  const readStatic = options.readStatic ?? collectStaticEnv
  const includeGit = options.includeGit ?? true
  const readGit = options.readGit ?? readGitInfo

  /** 本轮会话的工作目录：hook 入参（权威）→ 缺失时仅主会话可信冻结值；子 Agent 不猜。 */
  let frozenCwd: string | undefined
  /** 静态事实只收集一次（进程内不变，重复调 os.userInfo 纯浪费） */
  let staticInfo: StaticEnvInfo | undefined
  const resolveCwd = (input: PromptInput): string | undefined =>
    input.cwd ?? (input.agentMode === 'subagent' ? undefined : frozenCwd)

  const hooks: Hooks = {
    'core.prompt.system.transform'(input: PromptInput, parts: string[]) {
      staticInfo ??= readStatic()
      const section = renderEnvSection(staticInfo, resolveCwd(input), options.isolation)
      if (section) parts.push(section)
    },
    async 'core.prompt.dynamic.transform'(input: PromptInput, parts: string[]) {
      const cwd = resolveCwd(input)
      let git: GitInfo | undefined
      if (includeGit && cwd) git = await readGit(cwd).catch(() => undefined)
      parts.push(renderNowSection(now(), git))
    },
  }

  return {
    id: 'env-context',
    name: 'Env Context',
    version: '0.1.0',
    description:
      '运行环境与用户信息注入：静态环境（系统/用户/Shell/工作目录/隔离档位）进 system 前缀，易变信息（当前时间/Git 状态）走尾部动态区',
    async install(ctx) {
      frozenCwd = ctx?.workspace?.cwd
      return hooks
    },
  }
}

export default createEnvContextPlugin
