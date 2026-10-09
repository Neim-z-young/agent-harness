/**
 * @harness/env-context
 *
 * 运行环境与用户信息注入：把「这台机器 / 这个会话」的环境事实摆到模型面前。
 *
 * ## 分档纪律（位置即语义，本仓 prompt 注入的硬约束）
 * - **恒定段（前缀 `core.prompt.system.transform`）**：系统 / 架构 / 用户 / Shell /
 *   工作目录 —— 会话中途不变，进前缀可吃前缀缓存；其中工作目录取 hook 入参
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

// ===== 数据形状 =====

/** 静态环境事实（机器级，进程内不变） */
export interface StaticEnvInfo {
  /** 操作系统（process.platform，如 darwin / linux / win32） */
  platform?: string
  /** 架构（process.arch，如 arm64 / x64） */
  arch?: string
  /** 内核版本（os.release()） */
  release?: string
  /** 用户名（os.userInfo().username） */
  user?: string
  /** 主机名（os.hostname()） */
  hostname?: string
  /** 登录 Shell（process.env.SHELL，Windows 上通常没有） */
  shell?: string
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
}

// ===== 纯渲染（导出供测试与复用）=====

/**
 * 渲染静态环境段（前缀区）。一条事实都没有时返回空串 —— 调用方据此不 push（零噪声）。
 */
export function renderEnvSection(info: StaticEnvInfo, cwd?: string): string {
  const lines: string[] = []
  if (info.platform) {
    const os = [info.platform, info.release].filter(Boolean).join(' ')
    lines.push(`- 系统: ${os}${info.arch ? `（${info.arch}）` : ''}`)
  }
  const who = [info.user, info.hostname].filter(Boolean).join('@')
  if (who) lines.push(`- 用户: ${who}`)
  if (info.shell) lines.push(`- Shell: ${info.shell}`)
  if (cwd) lines.push(`- 工作目录: ${cwd}`)
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
export function detectShellForDisplay(
  deps: { platform?: string; pathSep?: string; dirSep?: string; exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = deps.env ?? process.env
  const sh = env.SHELL
  if (sh) return sh

  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return 'bash'

  const listSep = deps.pathSep ?? ';'
  const dirSep = deps.dirSep ?? '\\'
  const joinDir = (dir: string, file: string) => (dir.endsWith(dirSep) ? dir + file : dir + dirSep + file)
  const exists = deps.exists ?? existsSync
  const pathDirs = (env.PATH ?? '').split(listSep).filter(Boolean)

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
  return env.ComSpec ?? 'cmd.exe'
}

/** 收集静态环境事实（os 调用逐项 try：容器 / CI 里 userInfo 等可能抛） */
export function collectStaticEnv(): StaticEnvInfo {
  const info: StaticEnvInfo = {}
  try { info.platform = process.platform } catch { /* 不可能，但保持逐项独立 */ }
  try { info.arch = process.arch } catch { /* 同上 */ }
  try { info.release = release() } catch { /* 沙箱里可能读不到 */ }
  try { info.user = userInfo().username } catch { /* 无用户上下文（某些 service 进程） */ }
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
      const section = renderEnvSection(staticInfo, resolveCwd(input))
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
      '运行环境与用户信息注入：静态环境（系统/用户/Shell/工作目录）进 system 前缀，易变信息（当前时间/Git 状态）走尾部动态区',
    async install(ctx) {
      frozenCwd = ctx?.workspace?.cwd
      return hooks
    },
  }
}

export default createEnvContextPlugin
