/**
 * @harness/snapshot - 文件快照 / Diff / 回滚
 *
 * 实现方案参考 OpenCode v2（packages/core/src/snapshot.ts + git.ts）：
 * 用「独立 git 仓库 + content-addressed tree」做快照，而非文件副本。
 *
 * - capture()   ：git add --all → git write-tree，返回 tree hash 作为快照 ID（只存引用，零拷贝）
 * - files()     ：git diff --name-only 列出两个快照间变更的文件
 * - diff()      ：逐文件 name-status + numstat + unified patch，产出结构化 FileDiff
 * - preview()   ：用临时 GIT_INDEX_FILE 做零副作用回滚预览（不落盘）
 * - restore()   ：选择性恢复（只动指定文件；目标树中不存在则删除）
 * - checkout()  ：整仓恢复（read-tree + checkout-index）
 *
 * 快照仓库位于 {worktree}/.git 之外时可通过 options.gitDirectory 指定；
 * 所有写操作按仓库加互斥锁（KeyedMutex），capture 失败为 best-effort（返回 undefined）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// ===== 基础类型 =====

/** 快照 ID：git tree hash（content-addressed，天然去重） */
export type SnapshotID = string & { readonly __snapshot: unique symbol }

/** 单文件结构化 diff（对齐 OpenCode File.Diff / Claude Code StructuredPatchHunk 用途） */
export interface FileDiff {
  /** 项目相对路径 */
  path: string
  /** 变更类型 */
  status: 'added' | 'modified' | 'deleted'
  /** 新增行数（二进制文件为 0） */
  additions: number
  /** 删除行数（二进制文件为 0） */
  deletions: number
  /** unified diff 文本（二进制文件为空串） */
  patch: string
}

/** SnapshotService 构造参数 */
export interface SnapshotOptions {
  /** 工作目录（被快照的项目根，绝对路径） */
  worktree: string
  /**
   * 快照 git 仓库目录（默认 ~/.harness/snapshots/{worktree-hash}）。
   * 独立于用户项目的 .git 且位于 worktree 之外，避免污染用户 index、
   * 也避免快照仓库自身被扫描进快照（对齐 OpenCode data/snapshot 语义）。
   */
  gitDirectory?: string
  /** 未跟踪文件超过该字节数则跳过快照（默认 2MB，对齐 OpenCode） */
  maximumUntrackedFileBytes?: number
  /** 是否启用（默认 true；关闭后 capture 返回 undefined、restore/checkout 抛错） */
  enabled?: boolean
}

// ===== 自定义错误 =====

export type SnapshotOperation = 'capture' | 'files' | 'diff' | 'preview' | 'restore'

/** 快照操作失败（统一错误，模块特定失败场景） */
export class SnapshotError extends Error {
  readonly operation: SnapshotOperation
  readonly cause?: unknown

  constructor(operation: SnapshotOperation, message: string, cause?: unknown) {
    super(`[snapshot:${operation}] ${message}`)
    this.name = 'SnapshotError'
    this.operation = operation
    this.cause = cause
  }
}

// ===== KeyedMutex：按仓库串行化快照写操作（对齐 OpenCode locked()） =====

/** 按 key 串行化的互斥锁（同一 key 的任务严格顺序执行） */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  /** 串行执行 task；前序任务失败不阻断后续任务 */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(() => task())
    this.tails.set(key, next.then(() => undefined, () => undefined))
    await prev.catch(() => undefined)
    return next
  }
}

// ===== Git 底层封装 =====

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** 执行 git 命令（Bun.spawn，stderr/stdout 全量收集） */
async function runGit(
  args: string[],
  cwd: string,
  stdin?: string,
  env?: Record<string, string>,
): Promise<GitResult> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdin: stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin)
    proc.stdin.end()
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

/** 按 \0 拆分 git -z 输出 */
function splitNul(text: string): string[] {
  return text.split('\0').filter(Boolean)
}

/**
 * Git 仓库句柄：所有命令显式携带 --git-dir / --work-tree，
 * 使快照仓库可以独立于用户项目存放（对齐 OpenCode Repository）
 */
class GitRepo {
  readonly worktree: string
  readonly gitDirectory: string

  constructor(options: { worktree: string; gitDirectory: string }) {
    this.worktree = options.worktree
    this.gitDirectory = options.gitDirectory
  }

  /** 执行 git 命令；失败抛 OperationError 风格的异常 */
  async run(
    args: string[],
    options?: { stdin?: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string }> {
    const fullArgs = ['--git-dir', this.gitDirectory, '--work-tree', this.worktree, ...args]
    const result = await runGit(fullArgs, this.worktree, options?.stdin, options?.env)
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`
      throw new Error(`git ${args.join(' ')}: ${message}`)
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

// ===== SnapshotService =====

/** 默认快照仓库目录：~/.harness/snapshots/{worktree-hash}（对齐 OpenCode data/snapshot） */
function defaultSnapshotGitDirectory(worktree: string): string {
  const hash = createHash('sha256').update(worktree).digest('hex').slice(0, 16)
  return path.join(homedir(), '.harness', 'snapshots', hash)
}

/** 快照服务：capture / files / diff / preview / restore / checkout */
export class SnapshotService {
  private readonly repo: GitRepo
  private readonly mutex = new KeyedMutex()
  private readonly maximumUntrackedFileBytes: number
  private readonly enabled: boolean

  constructor(options: SnapshotOptions) {
    if (!path.isAbsolute(options.worktree)) {
      throw new Error(`SnapshotService: worktree must be absolute, got "${options.worktree}"`)
    }
    this.repo = new GitRepo({
      worktree: options.worktree,
      gitDirectory:
        options.gitDirectory ?? defaultSnapshotGitDirectory(options.worktree),
    })
    this.maximumUntrackedFileBytes = options.maximumUntrackedFileBytes ?? 2 * 1024 * 1024
    this.enabled = options.enabled ?? true
  }

  /**
   * 捕获当前文件系统状态为 content-addressed tree，返回快照 ID。
   * 失败为 best-effort：返回 undefined（对齐 OpenCode capture 语义）。
   */
  async capture(scope = '.'): Promise<SnapshotID | undefined> {
    if (!this.enabled) return undefined
    try {
      return await this.mutex.run('tree', async () => {
        await this.ensureRepository()
        await this.refresh(scope)
        return await this.writeTree()
      })
    } catch (err) {
      console.warn('[snapshot] capture failed (best-effort)', err)
      return undefined
    }
  }

  /** 列出两个快照间变更的项目相对路径 */
  async files(from: SnapshotID, to: SnapshotID): Promise<string[]> {
    return this.mutex.run('tree', () => this.filesUnlocked(from, to)).catch((err) => {
      throw new SnapshotError('files', err instanceof Error ? err.message : String(err), err)
    })
  }

  /** 生成两个快照间的结构化 per-file diff（status + numstat + unified patch） */
  async diff(
    from: SnapshotID,
    to: SnapshotID,
    options?: { context?: number; paths?: string[] },
  ): Promise<FileDiff[]> {
    return this.mutex
      .run('tree', () => this.diffUnlocked(from, to, options))
      .catch((err) => {
        throw new SnapshotError('diff', err instanceof Error ? err.message : String(err), err)
      })
  }

  /**
   * 零副作用回滚预览：在临时 index 上把指定文件替换为其它快照的版本，
   * 计算新旧树 diff，不触碰工作目录。
   */
  async preview(
    files: ReadonlyMap<string, SnapshotID>,
    options?: { context?: number },
  ): Promise<FileDiff[]> {
    if (!this.enabled) throw new SnapshotError('preview', 'Snapshots are disabled')
    const context = options?.context ?? 3
    return this.mutex.run('tree', async () => {
      await this.ensureRepository()
      // 先刷新 index 同步当前工作目录，再 write-tree 得到"当前状态"基准树
      await this.refresh('.')
      const current = await this.writeTree()
      const index = path.join(this.repo.gitDirectory, `preview-${randomUUID()}.index`)
      try {
        const env = { GIT_INDEX_FILE: index }
        await this.repo.run(['read-tree', current], { env })
        for (const [file, tree] of files) {
          const entry = await this.lsTreeEntry(tree, file)
          if (!entry) {
            await this.repo.run(['update-index', '--force-remove', '--', file], { env })
          } else {
            await this.repo.run(
              ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.object},${file}`],
              { env },
            )
          }
        }
        const target = (await this.repo.run(['write-tree'], { env })).stdout.trim() as SnapshotID
        return await this.diffUnlocked(current, target, { context, paths: Array.from(files.keys()) })
      } finally {
        await rm(index, { force: true }).catch(() => undefined)
      }
    }).catch((err) => {
      if (err instanceof SnapshotError) throw err
      throw new SnapshotError('preview', err instanceof Error ? err.message : String(err), err)
    })
  }

  /**
   * 选择性恢复：每个文件从关联的 tree 恢复。
   * 文件在目标 tree 中不存在 → 删除当前文件；不在 map 中的文件不动。
   */
  async restore(files: ReadonlyMap<string, SnapshotID>): Promise<void> {
    if (!this.enabled) throw new SnapshotError('restore', 'Snapshots are disabled')
    await this.mutex.run('tree', async () => {
      for (const [file, tree] of files) {
        const absolute = path.resolve(this.repo.worktree, file)
        if (!this.contains(this.repo.worktree, absolute)) {
          throw new SnapshotError('restore', `Path escapes the project: ${file}`)
        }
        if (await this.lsTreeEntry(tree, file)) {
          await this.repo.run(['checkout', tree, '--', file])
        } else {
          await rm(absolute, { recursive: true, force: true })
        }
      }
    }).catch((err) => {
      if (err instanceof SnapshotError) throw err
      throw new SnapshotError('restore', err instanceof Error ? err.message : String(err), err)
    })
  }

  /** 整仓恢复：把工作目录替换为快照树（快照中不存在的文件保留） */
  async checkout(snapshot: SnapshotID): Promise<void> {
    if (!this.enabled) throw new SnapshotError('restore', 'Snapshots are disabled')
    await this.mutex.run('tree', async () => {
      await this.repo.run(['read-tree', snapshot])
      await this.repo.run(['checkout-index', '--all', '--force'])
    }).catch((err) => {
      if (err instanceof SnapshotError) throw err
      throw new SnapshotError('restore', err instanceof Error ? err.message : String(err), err)
    })
  }

  // ===== 内部实现 =====

  /** 无锁 files：仅供已持有锁的内部路径（diffUnlocked / preview）调用 */
  private async filesUnlocked(from: SnapshotID, to: SnapshotID): Promise<string[]> {
    const { stdout } = await this.repo.run(['diff', '--name-only', '-z', from, to])
    return splitNul(stdout)
  }

  /** 无锁 diff：仅供已持有锁的内部路径（preview）调用 */
  private async diffUnlocked(
    from: SnapshotID,
    to: SnapshotID,
    options?: { context?: number; paths?: string[] },
  ): Promise<FileDiff[]> {
    const context = options?.context ?? 3
    const paths = options?.paths ?? (await this.filesUnlocked(from, to))
    const result: FileDiff[] = []
    for (const file of paths) {
      const { stdout: statusOut } = await this.repo.run([
        'diff', '--name-status', '--no-renames', from, to, '--', file,
      ])
      const statusText = statusOut.trim()
      const status: FileDiff['status'] = statusText.startsWith('A')
        ? 'added'
        : statusText.startsWith('D')
          ? 'deleted'
          : 'modified'

      const { stdout: numstatOut } = await this.repo.run([
        'diff', '--numstat', '--no-renames', from, to, '--', file,
      ])
      const parts = numstatOut.trim().split('\t')
      const binary = parts[0] === '-' || parts[1] === '-'
      const patch = binary
        ? ''
        : (await this.repo.run([
            'diff', `--unified=${context}`, '--no-renames', from, to, '--', file,
          ])).stdout

      result.push({
        path: file,
        status,
        additions: binary ? 0 : Number(parts[0] ?? 0),
        deletions: binary ? 0 : Number(parts[1] ?? 0),
        patch,
      })
    }
    return result
  }

  private contains(root: string, target: string): boolean {
    const relative = path.relative(root, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  /** 初始化快照仓库（首次使用时）：git init + 关键 config（对齐 OpenCode） */
  private async ensureRepository(): Promise<void> {
    const head = path.join(this.repo.gitDirectory, 'HEAD')
    try {
      await stat(head)
      return
    } catch {
      // 不存在则初始化
    }
    await mkdir(this.repo.gitDirectory, { recursive: true })
    await this.repo.run(['init'])
    await this.repo.run(['config', 'core.autocrlf', 'false'])
    await this.repo.run(['config', 'core.longpaths', 'true'])
    await this.repo.run(['config', 'index.version', '4'])
    await this.repo.run(['config', 'core.untrackedCache', 'true'])
  }

  /**
   * 刷新 index：已跟踪变更 + 未跟踪新文件入暂存，超限/删除项移出。
   * 对齐 OpenCode git.index.refresh（暂不接入用户仓库 check-ignore，作为后续增强）。
   */
  private async refresh(scope: string): Promise<void> {
    const [tracked, untracked] = await Promise.all([
      this.repo.run(['diff-files', '--name-only', '-z', '--', scope]),
      this.repo.run(['ls-files', '--others', '--exclude-standard', '-z', '--', scope]),
    ])
    const candidates = Array.from(
      new Set([...splitNul(tracked.stdout), ...splitNul(untracked.stdout)]),
    )
    if (candidates.length === 0) return

    const skipped: string[] = []
    if (this.maximumUntrackedFileBytes > 0) {
      for (const item of splitNul(untracked.stdout)) {
        try {
          const info = await stat(path.join(this.repo.worktree, item))
          if (info.isFile() && info.size > this.maximumUntrackedFileBytes) skipped.push(item)
        } catch {
          // 文件已消失，忽略
        }
      }
    }

    if (skipped.length > 0) {
      await this.repo.run(
        ['rm', '--cached', '-f', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { stdin: skipped.join('\0') + '\0' },
      )
    }
    const stage = candidates.filter((item) => !skipped.includes(item))
    if (stage.length > 0) {
      await this.repo.run(
        ['add', '--all', '--sparse', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { stdin: stage.join('\0') + '\0' },
      )
    }
  }

  private async writeTree(): Promise<SnapshotID> {
    const { stdout } = await this.repo.run(['write-tree'])
    return stdout.trim() as SnapshotID
  }

  /** 查询 tree 中某个文件的 entry（mode + object id）；不存在返回 undefined */
  private async lsTreeEntry(
    tree: SnapshotID,
    file: string,
  ): Promise<{ mode: string; object: string } | undefined> {
    const { stdout } = await this.repo.run(['ls-tree', '-z', tree, '--', file])
    const text = stdout.replace(/\0$/, '')
    if (!text) return undefined
    const match = text.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t/)
    if (!match) {
      throw new SnapshotError('restore', `Invalid tree entry for ${file}`)
    }
    return { mode: match[1]!, object: match[2]! }
  }
}

/** 便捷工厂 */
export function createSnapshotService(options: SnapshotOptions): SnapshotService {
  return new SnapshotService(options)
}
