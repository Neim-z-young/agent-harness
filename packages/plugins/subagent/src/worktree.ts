/**
 * @harness/subagent - git worktree 工具模块
 *
 * 子 Agent 隔离的核心原语：为每个子 Agent 提供一个独立的 git worktree 作为其工具执行
 * 工作目录，从文件系统层面隔离写操作，避免多个子 Agent（尤其后台并行）并发写同一
 * working tree + index 造成冲突。
 *
 * 纯函数设计：不 import core（避免循环依赖），只用 node:child_process + node:fs。
 * 所有 git 命令失败统一归一化为 {@link GitCommandError}，调用方需自行 try/catch 降级。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'

const execFileP = promisify(execFile)

/** git 命令执行失败错误 */
export class GitCommandError extends Error {
  /** 进程退出码（如捕获到）；spawn 失败时为 null */
  constructor(
    message: string,
    public readonly code: number | null,
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

/** git 命令执行结果 */
export interface GitResult {
  stdout: string
  stderr: string
}

/**
 * 统一执行 git 命令（不传 shell，防命令注入；失败抛 {@link GitCommandError}）。
 *
 * @param base 命令执行目录（可被 opts.cwd 覆盖）
 * @param args git 子命令及参数（如 `['worktree', 'add', ...]`）
 */
export async function runGit(base: string, args: string[], opts?: { cwd?: string }): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd: opts?.cwd ?? base,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    })
    return { stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message?: string }
    throw new GitCommandError(
      `git ${args.join(' ')} 失败：${e?.stderr?.trim() || e?.message || String(err)}`,
      e?.code ?? null,
    )
  }
}

/**
 * 检测 base 是否为 git 仓库，返回仓库根目录（绝对路径）；非仓库返回 null。
 * `git rev-parse --show-toplevel` 从任意子目录向上定位仓库根，失败即视为非仓库。
 */
export async function gitTopLevel(base: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(base, ['rev-parse', '--show-toplevel'])
    const root = stdout.trim()
    return root ? root : null
  } catch {
    return null
  }
}

/** 便捷判断：base 是否为 git 仓库 */
export async function isGitRepo(base: string): Promise<boolean> {
  return (await gitTopLevel(base)) !== null
}

/**
 * worktree 目录：`<base>/.harness/worktrees/<sanitized token>`。
 * token 会被清洗（仅保留字母数字点下划线连字符），避免路径注入。
 */
export function worktreeDirFor(base: string, token: string): string {
  const sanitized = token.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(base, '.harness', 'worktrees', sanitized)
}

/**
 * 幂等写入 `.harness/.gitignore` 包含 `worktrees/`，防止 worktree 目录被宿主仓库当作
 * untracked 文件扫描/误提交。
 */
export function ensureWorktreeIgnored(base: string): void {
  const dir = join(base, '.harness')
  const ignoreFile = join(dir, '.gitignore')
  let content = ''
  if (existsSync(ignoreFile)) {
    try { content = readFileSync(ignoreFile, 'utf-8') } catch { content = '' }
  }
  if (content.split('\n').map((l) => l.trim()).includes('worktrees/')) return
  mkdirSync(dir, { recursive: true })
  const next = content.trimEnd() ? `${content.trimEnd()}\nworktrees/\n` : 'worktrees/\n'
  writeFileSync(ignoreFile, next, 'utf-8')
}

/** 单个 worktree 的信息（porcelain 解析结果） */
export interface WorktreeInfo {
  /** worktree 绝对路径 */
  path: string
  /** 当前 HEAD 提交 SHA */
  head: string
}

/**
 * 创建独立 worktree（detached HEAD）并返回其目录绝对路径。
 * 幂等：目录已存在则直接复用（续接/后台预创建场景）。
 */
export async function createWorktree(opts: { base: string; token: string; ref?: string }): Promise<string> {
  const dir = worktreeDirFor(opts.base, opts.token)
  if (existsSync(dir)) return dir
  await runGit(opts.base, ['worktree', 'add', '--detach', '--force', dir, opts.ref ?? 'HEAD'])
  return dir
}

/** worktree 相对基线 HEAD 的变更信息 */
export interface WorktreeDiff {
  /** `git diff HEAD --stat` 摘要（有变更时为非空多行文本） */
  summary: string
  /** 完整 diff（`git diff HEAD` 输出） */
  patch: string
  /** 是否有变更 */
  hasChanges: boolean
}

/**
 * 获取 worktree 相对基线 HEAD 的 diff 摘要 + 完整 patch。
 *
 * 注意：`git diff HEAD` 只覆盖已跟踪文件的改动；全新未跟踪文件不在其中（合理边界，
 * 摘要用于给父 Agent 提供变更概览，不自动 merge，无需对未跟踪文件建索引）。
 */
export async function getWorktreeDiff(opts: { base: string; dir?: string }): Promise<WorktreeDiff> {
  const cwd = opts.dir ?? opts.base
  const statRes = await runGit(cwd, ['diff', 'HEAD', '--stat'])
  const patchRes = await runGit(cwd, ['diff', 'HEAD'])
  const summary = statRes.stdout.trim()
  const patch = patchRes.stdout
  return { summary, patch, hasChanges: patch.trim().length > 0 }
}

/**
 * 移除 worktree（幂等）。
 * git 移除失败（如元数据损坏）时先 `worktree prune`，再对残留目录做目录级兜底清理。
 */
export async function removeWorktree(opts: { base: string; dir: string }): Promise<void> {
  try {
    await runGit(opts.base, ['worktree', 'remove', '--force', opts.dir])
  } catch {
    try { await runGit(opts.base, ['worktree', 'prune']) } catch { /* ignore */ }
  }
  if (existsSync(opts.dir)) {
    try { rmSync(opts.dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/**
 * 列出仓库所有 worktree（解析 `git worktree list --porcelain`）。
 */
export async function listWorktrees(base: string): Promise<WorktreeInfo[]> {
  const { stdout } = await runGit(base, ['worktree', 'list', '--porcelain'])
  const out: WorktreeInfo[] = []
  let cur: Partial<WorktreeInfo> = {}
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      if (cur.path) out.push(cur as WorktreeInfo)
      cur = {}
    } else if (line.startsWith('worktree ')) {
      cur.path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim()
    }
    // 其余 flag 行（detached / bare / locked / prunable 等）在此忽略
  }
  if (cur.path) out.push(cur as WorktreeInfo)
  return out
}