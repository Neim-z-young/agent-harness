/**
 * @harness/snapshot - 文件快照 / Diff / 回滚
 *
 * 双后端设计（§10.4）：
 * - GitSnapshotService（默认）：参考 OpenCode v2（packages/core/src/snapshot.ts + git.ts），
 *   用「独立 git 仓库 + content-addressed tree」做快照（git write-tree → tree hash）。
 * - FileSnapshotService（非 git 环境 fallback）：参考 Claude Code fileHistory，
 *   文件副本 `{sha256_16}@v{n}` + 快照链（snapshots.json），三级变更检测
 *   （stat mode/size → mtime → 内容）+ 上限淘汰（maxSnapshots，默认 100）。
 *
 * 工厂 createSnapshotService({ backend: 'auto' | 'git' | 'file' })：
 * auto（默认）探测 git 二进制，不可用时自动降级到文件副本后端。
 *
 * 公共操作（两后端一致）：
 * - capture()   ：快照当前状态，返回快照 ID
 * - files()     ：两个快照间变更的文件列表
 * - diff()      ：结构化 FileDiff（status + 增删统计 + unified patch）
 * - preview()   ：零副作用回滚预览（不落盘）
 * - restore()   ：选择性恢复（只动指定文件；目标快照中不存在则删除）
 * - checkout()  ：整仓恢复
 * - gc()        ：清理过期快照存储（git：git gc --prune=7.days；file：清理无引用备份）
 *
 * 所有写操作按后端加互斥锁（KeyedMutex），capture 失败为 best-effort（返回 undefined）。
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// ===== 基础类型 =====

/** 快照 ID：git 后端为 tree hash；文件后端为 `fs-{seq}` 递增序号 */
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

/** 快照后端选择 */
export type SnapshotBackend = 'auto' | 'git' | 'file'

/** 快照服务公共接口（两后端一致） */
export interface SnapshotService {
  /** 快照当前文件系统状态，返回快照 ID；失败 best-effort 返回 undefined */
  capture(scope?: string): Promise<SnapshotID | undefined>
  /** 两个快照间变更的项目相对路径 */
  files(from: SnapshotID, to: SnapshotID): Promise<string[]>
  /** 两个快照间的结构化 per-file diff */
  diff(
    from: SnapshotID,
    to: SnapshotID,
    options?: { context?: number; paths?: string[] },
  ): Promise<FileDiff[]>
  /** 零副作用回滚预览（不修改工作目录） */
  preview(files: ReadonlyMap<string, SnapshotID>, options?: { context?: number }): Promise<FileDiff[]>
  /** 选择性恢复：每个文件从关联快照恢复（目标快照中不存在则删除） */
  restore(files: ReadonlyMap<string, SnapshotID>): Promise<void>
  /** 整仓恢复：把工作目录替换为快照树（快照中不存在的文件保留） */
  checkout(snapshot: SnapshotID): Promise<void>
  /** 清理过期快照存储（git 后端：git gc --prune=7.days；file 后端：淘汰无引用备份） */
  gc?(): Promise<void>
}

/** SnapshotService 构造参数 */
export interface SnapshotOptions {
  /** 工作目录（被快照的项目根，绝对路径） */
  worktree: string
  /**
   * 后端选择：auto（默认，探测 git，不可用降级 file）/ git / file
   */
  backend?: SnapshotBackend
  /**
   * git 后端：快照 git 仓库目录（默认 ~/.harness/snapshots/{worktree-hash}）。
   * 独立于用户项目的 .git 且位于 worktree 之外，避免污染用户 index、
   * 也避免快照仓库自身被扫描进快照（对齐 OpenCode data/snapshot 语义）。
   */
  gitDirectory?: string
  /**
   * file 后端：快照存储根目录（默认 ~/.harness/file-snapshots/{worktree-hash}）。
   * 备份文件 `{sha256_16}@v{n}`（dataDir/backups/）+ snapshots.json 快照链。
   */
  dataDir?: string
  /** 未跟踪文件超过该字节数则跳过快照（默认 2MB，对齐 OpenCode；git 后端生效） */
  maximumUntrackedFileBytes?: number
  /** 是否启用（默认 true；关闭后 capture 返回 undefined、restore/checkout 抛错） */
  enabled?: boolean
  /** 快照上限（默认 100，对齐 Claude Code MAX_SNAPSHOTS；超出淘汰最旧） */
  maxSnapshots?: number
  /** git 后端：capture 每 N 次自动执行 git gc --prune=7.days（默认 50；0 关闭） */
  gcEvery?: number
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

// ===== git 二进制解析 =====

let cachedGitBin: string | undefined

/**
 * 解析可用的 git 二进制：先查 PATH，再回退到常见绝对路径。
 * macOS 上终端 PATH 可能异常（如 zsh 环境），但 /usr/bin/git 几乎必然存在。
 */
function resolveGitBin(): string {
  if (cachedGitBin) return cachedGitBin
  for (const candidate of ['git', '/usr/bin/git', '/opt/homebrew/bin/git']) {
    try {
      const proc = Bun.spawnSync({
        cmd: [candidate, '--version'],
        stdout: 'ignore',
        stderr: 'ignore',
      })
      if (proc.exitCode === 0) {
        cachedGitBin = candidate
        return candidate
      }
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error('[snapshot] git executable not found in PATH or common locations')
}

/** 探测 git 是否可用（auto 后端降级判定） */
function detectGit(): boolean {
  try {
    resolveGitBin()
    return true
  } catch {
    return false
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
    cmd: [resolveGitBin(), ...args],
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

  /** 执行 git 命令；失败抛异常 */
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

// ===== 公共工具 =====

/** 默认快照仓库目录：~/.harness/snapshots/{worktree-hash}（对齐 OpenCode data/snapshot） */
function defaultSnapshotGitDirectory(worktree: string): string {
  const hash = createHash('sha256').update(worktree).digest('hex').slice(0, 16)
  return path.join(homedir(), '.harness', 'snapshots', hash)
}

/** 默认文件后端存储目录：~/.harness/file-snapshots/{worktree-hash} */
function defaultFileSnapshotDataDir(worktree: string): string {
  const hash = createHash('sha256').update(worktree).digest('hex').slice(0, 16)
  return path.join(homedir(), '.harness', 'file-snapshots', hash)
}

/** 按行拆分（吞掉末尾换行产生的空串，对齐 git 行统计：'a\nb\n' 计 2 行） */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

/**
 * 简化行 diff（unified patch）。
 * 前缀/后缀公共行 + 中间区贪心对齐（对 a 的每个剩余行在 b 剩余区间顺序查找首个匹配），
 * 使"插入/删除在中间"的公共行被识别为上下文而非 -/+（对齐 git 对预览的统计）。
 */
function lineDiff(
  a: string,
  b: string,
  context = 3,
): { additions: number; deletions: number; patch: string } {
  const aLines = splitLines(a)
  const bLines = splitLines(b)

  // 前缀公共行
  let start = 0
  const maxStart = Math.min(aLines.length, bLines.length)
  while (start < maxStart && aLines[start] === bLines[start]) start++

  // 后缀公共行
  let aEnd = aLines.length
  let bEnd = bLines.length
  while (aEnd > start && bEnd > start && aLines[aEnd - 1] === bLines[bEnd - 1]) {
    aEnd--
    bEnd--
  }
  if (start === aEnd && start === bEnd) {
    return { additions: 0, deletions: 0, patch: '' }
  }

  // 中间区贪心对齐：a 中每个剩余行在 b 剩余区间顺序查找首个匹配
  const aChanged = aLines.slice(start, aEnd)
  const bChanged = bLines.slice(start, bEnd)
  const aRemoved = new Set<number>()
  const bMatched = new Set<number>()
  let bi = 0
  for (let ai = 0; ai < aChanged.length; ai++) {
    let found = -1
    for (let k = bi; k < bChanged.length; k++) {
      if (bChanged[k] === aChanged[ai]) {
        found = k
        break
      }
    }
    if (found >= 0) {
      bMatched.add(found)
      bi = found + 1
    } else {
      aRemoved.add(ai)
    }
  }

  const aStart = Math.max(0, start - context)
  const aStop = Math.min(aLines.length, aEnd + context)
  const bStart = Math.max(0, start - context)
  const bStop = Math.min(bLines.length, bEnd + context)

  const header = `@@ -${aStart + 1},${aStop - aStart} +${bStart + 1},${bStop - bStart} @@`
  const out: string[] = [header]
  let additions = 0
  let deletions = 0

  for (let k = aStart; k < start; k++) out.push(` ${aLines[k]}`)

  let bOut = 0
  for (let ai = 0; ai < aChanged.length; ai++) {
    if (aRemoved.has(ai)) {
      out.push(`-${aChanged[ai]}`)
      deletions++
    } else {
      // 该 a 行匹配 b[bOut]：先输出 b 中排在匹配行之前的所有行（新增）
      while (bOut < bChanged.length && !bMatched.has(bOut)) {
        out.push(`+${bChanged[bOut]}`)
        additions++
        bOut++
      }
      if (bOut < bChanged.length && bMatched.has(bOut)) {
        out.push(` ${aChanged[ai]}`)
        bOut++
      }
    }
  }
  while (bOut < bChanged.length) {
    out.push(`+${bChanged[bOut]}`)
    additions++
    bOut++
  }

  for (let k = aEnd; k < aStop; k++) out.push(` ${aLines[k]}`)

  return { additions, deletions, patch: out.join('\n') + '\n' }
}

// ===== GitSnapshotService（OpenCode v2 git tree 方案） =====

/** git 后端快照服务：独立 git 仓库 + content-addressed tree（对齐 OpenCode v2） */
export class GitSnapshotService implements SnapshotService {
  private readonly repo: GitRepo
  private readonly mutex = new KeyedMutex()
  private readonly maximumUntrackedFileBytes: number
  private readonly enabled: boolean
  private readonly maxSnapshots: number
  /** 快照 ID 注册表路径（记录已知快照，超上限淘汰最旧） */
  private readonly snapshotIdsPath: string
  /** capture 计数（达到阈值自动 git gc） */
  private captureCount = 0
  private readonly gcEvery: number

  constructor(options: SnapshotOptions) {
    if (!path.isAbsolute(options.worktree)) {
      throw new Error(`SnapshotService: worktree must be absolute, got "${options.worktree}"`)
    }
    const gitDirectory = options.gitDirectory ?? defaultSnapshotGitDirectory(options.worktree)
    this.snapshotIdsPath = path.join(gitDirectory, 'snapshot-ids.json')
    this.repo = new GitRepo({ worktree: options.worktree, gitDirectory })
    this.maximumUntrackedFileBytes = options.maximumUntrackedFileBytes ?? 2 * 1024 * 1024
    this.enabled = options.enabled ?? true
    this.maxSnapshots = options.maxSnapshots ?? 100
    this.gcEvery = options.gcEvery ?? 50
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
        const id = await this.writeTree()
        await this.recordSnapshotId(id)
        return id
      })
    } catch (err) {
      console.warn('[snapshot] capture failed (best-effort)', err)
      return undefined
    }
  }

  /** 清理快照仓库对象（git gc --prune=7.days，对齐 OpenCode 定期清理） */
  async gc(): Promise<void> {
    if (!this.enabled) return
    await this.mutex.run('tree', () => this.gcUnlocked())
  }

  /** 快照 ID 注册表：记录已知快照，超上限淘汰最旧（对象由后续 git gc 清理） */
  private async recordSnapshotId(id: SnapshotID): Promise<void> {
    try {
      let ids: string[] = []
      try {
        ids = JSON.parse(await readFile(this.snapshotIdsPath, 'utf-8')) as string[]
      } catch {
        // 首次使用，无注册表
      }
      ids.push(id)
      while (ids.length > this.maxSnapshots) ids.shift()
      await writeFile(this.snapshotIdsPath, JSON.stringify(ids), 'utf-8')

      // 自动 gc：每 gcEvery 次 capture 触发一次（prune 掉无引用的旧对象）
      this.captureCount++
      if (this.gcEvery > 0 && this.captureCount % this.gcEvery === 0) {
        // 已在 capture 的锁内，调用无锁内部实现，避免同 key 嵌套死锁
        await this.gcUnlocked()
      }
    } catch {
      // 注册表/自动 gc 失败不影响快照本身
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

  /** 无锁 gc：仅供已持有锁的内部路径（recordSnapshotId）调用 */
  private async gcUnlocked(): Promise<void> {
    await this.ensureRepository()
    await this.repo.run(['gc', '--prune=7.days'])
  }

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
   * `--exclude-standard` 自动复用用户项目 .gitignore 语义（check-ignore，对齐 OpenCode）。
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

// ===== FileSnapshotService（Claude Code fileHistory 文件副本方案） =====

/** 单个文件的备份元数据（对齐 Claude Code FileHistoryBackup） */
interface FileBackupMeta {
  /** 备份文件名（dataDir/backups/{name}）；null = 该版本文件不存在 */
  backup: string | null
  /** 版本号（单调递增，文件名 @v{n} 后缀） */
  version: number
  /** 备份时文件 mode（restore 时恢复权限） */
  mode: number
  /** 备份时文件大小（stat 级变更检测） */
  size: number
  /** 备份时文件 mtimeMs（mtime 级变更检测） */
  mtime: number
}

/** 一次快照（对齐 Claude Code FileHistorySnapshot） */
interface FileSnapshotRecord {
  id: SnapshotID
  /** 项目相对路径 → 备份元数据 */
  files: Record<string, FileBackupMeta>
  timestamp: number
}

/** 快照链（对齐 Claude Code FileHistoryState） */
interface FileSnapshotChain {
  snapshots: FileSnapshotRecord[]
  sequence: number
}

/** 简化 .gitignore matcher（支持 *、**、?、目录 / 结尾、! 取反、# 注释，单文件根级） */
function compileIgnorePatterns(patterns: string[]): (rel: string) => boolean {
  const rules: Array<{ re: RegExp; negate: boolean }> = []
  for (const raw of patterns) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let pat = line
    let negate = false
    if (pat.startsWith('!')) {
      negate = true
      pat = pat.slice(1).trim()
    }
    if (!pat) continue
    if (pat.startsWith('/')) pat = pat.slice(1)
    const dirOnly = pat.endsWith('/')
    if (dirOnly) pat = pat.slice(0, -1)

    let out = ''
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i]!
      if (ch === '*') {
        if (pat[i + 1] === '*') {
          out += '.*'
          i++
        } else {
          out += '[^/]*'
        }
      } else if (ch === '?') {
        out += '[^/]'
      } else if ('\\.+(){}[]^$|'.includes(ch)) {
        out += `\\${ch}`
      } else {
        out += ch
      }
    }
    const core = out
    // 目录模式：匹配该目录及其下任意内容（git 语义：foo/ 忽略整个目录）
    const re = new RegExp(dirOnly ? `^${core}(/.*)?$` : `^${core}$`)
    rules.push({ re, negate })
  }
  return (rel: string): boolean => {
    let ignored = false
    for (const rule of rules) {
      if (rule.re.test(rel)) ignored = !rule.negate
    }
    return ignored
  }
}

/**
 * 文件副本后端：不依赖 git，纯文件系统。
 * 快照 = 变更文件全量备份（`{sha256_16}@v{n}`）+ snapshots.json 快照链；
 * 变更检测三级降级：stat(mode/size) → mtime → 内容（对齐 Claude Code checkOriginFileChanged）。
 */
export class FileSnapshotService implements SnapshotService {
  private readonly worktree: string
  private readonly dataDir: string
  private readonly backupsDir: string
  private readonly chainPath: string
  private readonly mutex = new KeyedMutex()
  private readonly enabled: boolean
  private readonly maxSnapshots: number
  /** dataDir 若位于 worktree 内则跳过（避免快照存储被自身扫描） */
  private readonly dataDirInside: string | null
  private ignoreRules: ((rel: string) => boolean) | null = null

  constructor(options: SnapshotOptions) {
    if (!path.isAbsolute(options.worktree)) {
      throw new Error(`SnapshotService: worktree must be absolute, got "${options.worktree}"`)
    }
    this.worktree = options.worktree
    this.dataDir = options.dataDir ?? defaultFileSnapshotDataDir(options.worktree)
    this.backupsDir = path.join(this.dataDir, 'backups')
    this.chainPath = path.join(this.dataDir, 'snapshots.json')
    this.enabled = options.enabled ?? true
    this.maxSnapshots = options.maxSnapshots ?? 100

    const rel = path.relative(this.worktree, this.dataDir)
    this.dataDirInside =
      rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
  }

  /** 捕获当前文件系统状态为文件副本快照，返回 `fs-{seq}` 快照 ID */
  async capture(scope = '.'): Promise<SnapshotID | undefined> {
    if (!this.enabled) return undefined
    try {
      return await this.mutex.run('tree', async () => {
        await this.loadIgnoreRules()
        const chain = await this.loadChain()
        const prev = chain.snapshots[chain.snapshots.length - 1]
        const files: Record<string, FileBackupMeta> = {}

        const scopeAbs = path.resolve(this.worktree, scope)
        for await (const rel of this.walk(scopeAbs)) {
          const abs = path.join(this.worktree, rel)
          files[rel] = await this.buildMeta(rel, abs, prev?.files[rel])
        }
        // 上一快照存在、本次缺失的文件 → 记录"该版本不存在"
        if (prev) {
          for (const rel of Object.keys(prev.files)) {
            if (!files[rel] && this.inScope(scope, rel)) {
              const p = prev.files[rel]!
              files[rel] = { backup: null, version: p.version, mode: 0, size: 0, mtime: 0 }
            }
          }
        }

        const id = `fs-${chain.sequence + 1}` as SnapshotID
        chain.sequence++
        chain.snapshots.push({ id, files, timestamp: Date.now() })
        // 上限淘汰：超出 maxSnapshots 丢弃最旧快照（其独有备份由 gc 清理）
        while (chain.snapshots.length > this.maxSnapshots) chain.snapshots.shift()
        await this.saveChain(chain)
        return id
      })
    } catch (err) {
      console.warn('[snapshot] capture failed (best-effort)', err)
      return undefined
    }
  }

  /** 清理无引用备份：快照链中不再被引用的 {sha256}@v{n} 文件 */
  async gc(): Promise<void> {
    if (!this.enabled) return
    await this.mutex.run('tree', async () => {
      const chain = await this.loadChain()
      const referenced = new Set<string>()
      for (const snap of chain.snapshots) {
        for (const meta of Object.values(snap.files)) {
          if (meta.backup) referenced.add(meta.backup)
        }
      }
      let entries: string[] = []
      try {
        entries = await readdir(this.backupsDir)
      } catch {
        return
      }
      for (const name of entries) {
        if (name.includes('@v') && !referenced.has(name)) {
          await rm(path.join(this.backupsDir, name), { force: true }).catch(() => undefined)
        }
      }
    })
  }

  /** 列出两个快照间变更的项目相对路径 */
  async files(from: SnapshotID, to: SnapshotID): Promise<string[]> {
    return this.mutex.run('tree', () => this.filesUnlocked(from, to)).catch((err) => {
      throw new SnapshotError('files', err instanceof Error ? err.message : String(err), err)
    })
  }

  /** 生成两个快照间的结构化 per-file diff（简化行 diff，unified patch） */
  async diff(
    from: SnapshotID,
    to: SnapshotID,
    options?: { context?: number; paths?: string[] },
  ): Promise<FileDiff[]> {
    return this.mutex
      .run('tree', async () => {
        const a = await this.lookupUnlocked(from)
        const b = await this.lookupUnlocked(to)
        const paths = options?.paths ?? (await this.filesUnlocked(from, to))
        const result: FileDiff[] = []
        for (const rel of paths) {
          const aMeta = a.files[rel]
          const bMeta = b.files[rel]
          const aContent = aMeta?.backup
            ? await this.readBackup(aMeta.backup)
            : ''
          const bContent = bMeta?.backup
            ? await this.readBackup(bMeta.backup)
            : ''
          const { additions, deletions, patch } = lineDiff(aContent, bContent, options?.context ?? 3)
          const status: FileDiff['status'] =
            !aMeta || aMeta.backup === null ? 'added' : !bMeta || bMeta.backup === null ? 'deleted' : 'modified'
          result.push({ path: rel, status, additions, deletions, patch })
        }
        return result
      })
      .catch((err) => {
        throw new SnapshotError('diff', err instanceof Error ? err.message : String(err), err)
      })
  }

  /** 零副作用回滚预览：当前内容 vs 目标快照备份内容，不修改工作目录 */
  async preview(
    files: ReadonlyMap<string, SnapshotID>,
    options?: { context?: number },
  ): Promise<FileDiff[]> {
    if (!this.enabled) throw new SnapshotError('preview', 'Snapshots are disabled')
    return this.mutex
      .run('tree', async () => {
        const result: FileDiff[] = []
        for (const [rel, snapshotId] of files) {
          const abs = path.resolve(this.worktree, rel)
          if (!this.contains(abs)) {
            throw new SnapshotError('preview', `Path escapes the project: ${rel}`)
          }
          const target = await this.lookupUnlocked(snapshotId)
          const meta = target.files[rel]
          const exists = await stat(abs).then(() => true, () => false)
          const current = exists ? await readFile(abs, 'utf-8').catch(() => '') : ''
          const targetContent = meta?.backup ? await this.readBackup(meta.backup) : ''
          const { additions, deletions, patch } = lineDiff(current, targetContent, options?.context ?? 3)
          const status: FileDiff['status'] =
            !exists && meta?.backup ? 'added' : exists && (!meta || meta.backup === null) ? 'deleted' : 'modified'
          result.push({ path: rel, status, additions, deletions, patch })
        }
        return result
      })
      .catch((err) => {
        if (err instanceof SnapshotError) throw err
        throw new SnapshotError('preview', err instanceof Error ? err.message : String(err), err)
      })
  }

  /** 选择性恢复：从目标快照备份 copyFile 恢复（目标快照中不存在则删除） */
  async restore(files: ReadonlyMap<string, SnapshotID>): Promise<void> {
    if (!this.enabled) throw new SnapshotError('restore', 'Snapshots are disabled')
    await this.mutex
      .run('tree', async () => {
        for (const [rel, snapshotId] of files) {
          const abs = path.resolve(this.worktree, rel)
          if (!this.contains(abs)) {
            throw new SnapshotError('restore', `Path escapes the project: ${rel}`)
          }
          const target = await this.lookupUnlocked(snapshotId)
          const meta = target.files[rel]
          if (!meta || meta.backup === null) {
            await rm(abs, { recursive: true, force: true })
          } else {
            await mkdir(path.dirname(abs), { recursive: true })
            await copyFile(this.backupPath(meta.backup), abs)
            await chmod(abs, meta.mode)
          }
        }
      })
      .catch((err) => {
        if (err instanceof SnapshotError) throw err
        throw new SnapshotError('restore', err instanceof Error ? err.message : String(err), err)
      })
  }

  /** 整仓恢复：恢复快照内所有文件（快照外的文件保留） */
  async checkout(snapshot: SnapshotID): Promise<void> {
    if (!this.enabled) throw new SnapshotError('restore', 'Snapshots are disabled')
    await this.mutex
      .run('tree', async () => {
        const target = await this.lookupUnlocked(snapshot)
        for (const [rel, meta] of Object.entries(target.files)) {
          const abs = path.resolve(this.worktree, rel)
          if (!this.contains(abs)) {
            throw new SnapshotError('restore', `Path escapes the project: ${rel}`)
          }
          if (meta.backup === null) {
            await rm(abs, { recursive: true, force: true })
          } else {
            await mkdir(path.dirname(abs), { recursive: true })
            await copyFile(this.backupPath(meta.backup), abs)
            await chmod(abs, meta.mode)
          }
        }
      })
      .catch((err) => {
        if (err instanceof SnapshotError) throw err
        throw new SnapshotError('restore', err instanceof Error ? err.message : String(err), err)
      })
  }

  // ===== 内部实现 =====

  /** 无锁 files：仅供已持有锁的内部路径（diff）调用 */
  private async filesUnlocked(from: SnapshotID, to: SnapshotID): Promise<string[]> {
    const a = await this.lookupUnlocked(from)
    const b = await this.lookupUnlocked(to)
    const changed = new Set<string>()
    for (const [rel, meta] of Object.entries(b.files)) {
      const aMeta = a.files[rel]
      if (!aMeta || aMeta.backup !== meta.backup) changed.add(rel)
    }
    for (const rel of Object.keys(a.files)) {
      if (!b.files[rel]) changed.add(rel)
    }
    return Array.from(changed)
  }

  private async lookupUnlocked(id: SnapshotID): Promise<FileSnapshotRecord> {
    const chain = await this.loadChain()
    const record = chain.snapshots.find((s) => s.id === id)
    if (!record) throw new SnapshotError('files', `Snapshot not found: ${id}`)
    return record
  }

  /** 三级变更检测：stat(mode/size/mtime) → 内容兜底，未变化则复用上一备份（对齐 Claude Code） */
  private async buildMeta(
    rel: string,
    abs: string,
    prev: FileBackupMeta | undefined,
  ): Promise<FileBackupMeta> {
    const info = await stat(abs)
    if (
      prev &&
      prev.backup !== null &&
      info.mode === prev.mode &&
      info.size === prev.size &&
      info.mtimeMs === prev.mtime
    ) {
      return prev // stat 级未变化，直接复用
    }
    if (prev && prev.backup !== null) {
      // stat/mtime 变化 → 内容级兜底：内容一致仍复用（避免无谓备份 I/O）
      const current = await readFile(abs, 'utf-8').catch(() => null)
      const backup = await readFile(this.backupPath(prev.backup), 'utf-8').catch(() => null)
      if (current !== null && backup !== null && current === backup) return prev
    }
    return this.createBackup(rel, abs, info, prev?.version ?? 0)
  }

  private async createBackup(
    rel: string,
    abs: string,
    info: Stats,
    prevVersion: number,
  ): Promise<FileBackupMeta> {
    const version = prevVersion + 1
    const name = `${createHash('sha256').update(rel).digest('hex').slice(0, 16)}@v${version}`
    await mkdir(this.backupsDir, { recursive: true })
    await copyFile(abs, this.backupPath(name))
    return { backup: name, version, mode: info.mode, size: info.size, mtime: info.mtimeMs }
  }

  /** 递归遍历 worktree，产出项目相对路径（跳过 .git / dataDir / .gitignore 匹配项） */
  private async *walk(dir: string, relPrefix = ''): AsyncGenerator<string> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (await this.shouldIgnore(rel)) continue
        yield* this.walk(abs, rel)
      } else if (entry.isFile()) {
        if (await this.shouldIgnore(rel)) continue
        yield rel
      }
    }
  }

  private async shouldIgnore(rel: string): Promise<boolean> {
    if (rel === '.git' || rel.startsWith('.git/')) return true
    if (this.dataDirInside && (rel === this.dataDirInside || rel.startsWith(`${this.dataDirInside}/`))) {
      return true
    }
    return this.ignoreRules ? this.ignoreRules(rel) : false
  }

  private inScope(scope: string, rel: string): boolean {
    if (scope === '.' || scope === '') return true
    const normalized = scope.replace(/\/+$/, '')
    return rel === normalized || rel.startsWith(`${normalized}/`)
  }

  private contains(target: string): boolean {
    const relative = path.relative(this.worktree, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  private backupPath(name: string): string {
    return path.join(this.backupsDir, name)
  }

  private async readBackup(name: string): Promise<string> {
    return readFile(this.backupPath(name), 'utf-8').catch(() => '')
  }

  /** 惰性加载 worktree 根 .gitignore（不存在则忽略规则为空） */
  private async loadIgnoreRules(): Promise<void> {
    if (this.ignoreRules !== null) return
    try {
      const content = await readFile(path.join(this.worktree, '.gitignore'), 'utf-8')
      this.ignoreRules = compileIgnorePatterns(content.split('\n'))
    } catch {
      this.ignoreRules = () => false
    }
  }

  private async loadChain(): Promise<FileSnapshotChain> {
    try {
      const parsed = JSON.parse(await readFile(this.chainPath, 'utf-8')) as FileSnapshotChain
      return { snapshots: parsed.snapshots ?? [], sequence: parsed.sequence ?? 0 }
    } catch {
      return { snapshots: [], sequence: 0 }
    }
  }

  private async saveChain(chain: FileSnapshotChain): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.chainPath, JSON.stringify(chain), 'utf-8')
  }
}

// ===== 工厂 =====

/**
 * 便捷工厂：backend=auto（默认）探测 git 二进制，不可用降级 file 后端；
 * backend 显式指定则直接构造对应后端。
 */
export function createSnapshotService(options: SnapshotOptions): SnapshotService {
  const backend = options.backend ?? 'auto'
  if (backend === 'git') return new GitSnapshotService(options)
  if (backend === 'file') return new FileSnapshotService(options)
  return detectGit() ? new GitSnapshotService(options) : new FileSnapshotService(options)
}
