/**
 * @harness/tools-builtin - 内置 Tool 插件
 *
 * 提供三个基础工具：
 * - read_file：读取文件内容（支持行号、范围、截断）
 * - write_file：写入文件（创建/覆盖/追加）
 * - bash：执行 shell 命令（支持超时、cwd、stdout/stderr/exitCode）
 *
 * 通过 tool.pool.assemble Hook 自动注入到 Harness 工具池。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { providerMockPlugin } from '@harness/provider-mock'
 * import { toolsBuiltinPlugin } from '@harness/tools-builtin'
 *
 * const h = await createHarness({
 *   internalPlugins: [providerMockPlugin, toolsBuiltinPlugin],
 *   agents: [{ id: 'default', name: 'Agent', mode: 'primary', tools: ['*'], permission: { '*': 'allow' }, promptFragments: [] }],
 * })
 */

import { defineTool, Tool, ToolResult, Schema, ToolContext } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

// ===== 路径解析工具 =====

import { resolve, isAbsolute, relative, join } from 'node:path'
import { stat, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

/** 将路径解析为绝对路径（相对 cwd），并返回归一化结果 */
function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

/** 检查路径是否在 cwd 内（防止逃逸） */
function isWithinCwd(filePath: string, cwd: string): boolean {
  const rel = relative(cwd, filePath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

// ===== 通用 Schema 工厂（轻量级，不依赖 zod）=====

function makeSchema<T>(): Schema<T> {
  return {
    parse(value: unknown): T {
      return value as T
    },
    safeParse(value: unknown) {
      return { success: true, data: value as T }
    },
  }
}

// ========================================================================
// 1. read_file 工具
// ========================================================================

/** read_file 输入 */
export interface ReadFileInput {
  /** 文件路径（相对 cwd 或绝对路径） */
  path: string
  /** 起始行号（1-based，默认 1） */
  offset?: number
  /** 读取行数（默认全部） */
  limit?: number
  /** 是否添加行号前缀（默认 false） */
  showLineNumbers?: boolean
}

/** read_file 输出 */
export interface ReadFileOutput {
  /** 文件路径（绝对路径） */
  path: string
  /** 文件内容 */
  content: string
  /** 总行数 */
  totalLines: number
  /** 实际读取的行范围 [start, end]（1-based） */
  linesRead: [number, number]
  /** 是否被截断（超出限制） */
  truncated: boolean
  /** 文件大小（字节） */
  size: number
}

/** 最大读取行数（防止超大文件 OOM） */
const MAX_READ_LINES = 10000
/** 最大内容字符数（截断阈值） */
const MAX_CONTENT_CHARS = 256 * 1024 // 256KB

/**
 * read_file 工具：读取文件内容
 *
 * 安全声明：
 * - isReadOnly: true（只读操作）
 * - isConcurrencySafe: true（并发安全）
 * - permission.key: 'read'
 */
export const readFileTool = defineTool<ReadFileInput, ReadFileOutput>({
  id: 'read_file',
  description: '读取本地文件内容。支持行号范围、行号前缀和截断。只能读取工作目录内的文件。',
  inputSchema: makeSchema<ReadFileInput>(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path],
  },
  async call(input, ctx): Promise<ToolResult<ReadFileOutput>> {
    const absPath = resolvePath(input.path, ctx.cwd)

    // 路径安全检查
    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${input.path}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    try {
      const stats = await stat(absPath)
      if (!stats.isFile()) {
        return {
          ok: false,
          error: { message: `"${input.path}" 不是文件`, code: 'NOT_A_FILE' },
        }
      }

      const raw = await readFile(absPath, 'utf-8')
      const allLines = raw.split('\n')
      const totalLines = allLines.length

      // 行范围
      const startLine = Math.max(1, input.offset ?? 1)
      const maxLines = input.limit ? Math.min(input.limit, MAX_READ_LINES) : MAX_READ_LINES
      const endLine = Math.min(startLine + maxLines - 1, totalLines)
      const selectedLines = allLines.slice(startLine - 1, endLine)

      // 行号前缀
      let content: string
      if (input.showLineNumbers) {
        const width = String(endLine).length
        content = selectedLines
          .map((line, i) => `${String(startLine + i).padStart(width, ' ')}→${line}`)
          .join('\n')
      } else {
        content = selectedLines.join('\n')
      }

      // 截断
      let truncated = false
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.slice(0, MAX_CONTENT_CHARS) + '\n... [内容已截断，超过 256KB]'
        truncated = true
      }
      if (endLine < totalLines) {
        truncated = true
      }

      return {
        ok: true,
        output: {
          path: absPath,
          content,
          totalLines,
          linesRead: [startLine, endLine],
          truncated,
          size: stats.size,
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: { message: `文件不存在: ${input.path}`, code: 'FILE_NOT_FOUND' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'READ_ERROR' } }
    }
  },
})

// ========================================================================
// 2. write_file 工具
// ========================================================================

/** write_file 输入 */
export interface WriteFileInput {
  /** 文件路径（相对 cwd 或绝对路径） */
  path: string
  /** 写入内容 */
  content: string
  /** 写入模式：overwrite（覆盖/创建）、append（追加）、create（仅新建，已存在则报错） */
  mode?: 'overwrite' | 'append' | 'create'
  /** 是否自动创建父目录（默认 true） */
  createDirs?: boolean
}

/** write_file 输出 */
export interface WriteFileOutput {
  /** 文件路径（绝对路径） */
  path: string
  /** 写入的字节数 */
  bytesWritten: number
  /** 写入模式 */
  mode: string
  /** 是否新建了文件 */
  created: boolean
}

/**
 * write_file 工具：写入文件
 *
 * 安全声明：
 * - isReadOnly: false（有写副作用）
 * - isDestructive: mode=overwrite 时 true
 * - isConcurrencySafe: false（写操作不并发）
 * - permission.key: 'write'
 */
export const writeFileTool = defineTool<WriteFileInput, WriteFileOutput>({
  id: 'write_file',
  description: '写入本地文件。支持覆盖、追加和仅新建模式。只能在工目录内写入。',
  inputSchema: makeSchema<WriteFileInput>(),
  isReadOnly: () => false,
  isDestructive: (input) => input?.mode === 'overwrite',
  isConcurrencySafe: () => false,
  permission: {
    key: 'write',
    extractPatterns: (input) => [input.path],
  },
  async call(input, ctx): Promise<ToolResult<WriteFileOutput>> {
    const absPath = resolvePath(input.path, ctx.cwd)
    const mode = input.mode ?? 'overwrite'

    // 路径安全检查
    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${input.path}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    const existed = existsSync(absPath)

    // create 模式：文件已存在则报错
    if (mode === 'create' && existed) {
      return {
        ok: false,
        error: { message: `文件已存在: ${input.path}（mode=create 不允许覆盖）`, code: 'FILE_EXISTS' },
      }
    }

    try {
      // 自动创建父目录
      if ((input.createDirs ?? true) && !existed) {
        const dir = resolve(absPath, '..')
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true })
        }
      }

      if (mode === 'append') {
        await writeFile(absPath, input.content, { flag: 'a' })
      } else {
        await writeFile(absPath, input.content, 'utf-8')
      }

      return {
        ok: true,
        output: {
          path: absPath,
          bytesWritten: Buffer.byteLength(input.content, 'utf-8'),
          mode,
          created: !existed,
        },
      }
    } catch (err: any) {
      return { ok: false, error: { message: err.message ?? String(err), code: 'WRITE_ERROR' } }
    }
  },
})

// ========================================================================
// 3. bash 工具
// ========================================================================

/** bash 输入 */
export interface BashInput {
  /** 要执行的命令 */
  command: string
  /** 工作目录（默认使用 ctx.cwd） */
  cwd?: string
  /** 超时时间（毫秒，默认 30000） */
  timeoutMs?: number
  /** 环境变量 */
  env?: Record<string, string>
}

/** bash 输出 */
export interface BashOutput {
  /** 标准输出 */
  stdout: string
  /** 标准错误 */
  stderr: string
  /** 退出码（0 = 成功） */
  exitCode: number
  /** 是否超时 */
  timedOut: boolean
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 执行的命令 */
  command: string
}

/** 默认超时 30 秒 */
const DEFAULT_BASH_TIMEOUT = 30_000
/** 最大输出字符数（stdout + stderr 各自截断） */
const MAX_OUTPUT_CHARS = 64 * 1024 // 64KB

/**
 * bash 工具：执行 shell 命令
 *
 * 安全声明：
 * - isReadOnly: false（可能有写副作用）
 * - isConcurrencySafe: false（命令可能有副作用）
 * - isDestructive: true（命令可能删除文件等）
 * - permission.key: 'bash'
 *
 * 使用 spawn 执行，支持超时、cwd、env。
 * stdout/stderr 各截断到 64KB。
 */
export const bashTool = defineTool<BashInput, BashOutput>({
  id: 'bash',
  description: '执行 shell 命令。支持超时、工作目录和环境变量。返回 stdout/stderr/exitCode。',
  inputSchema: makeSchema<BashInput>(),
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  permission: {
    key: 'bash',
    extractPatterns: (input) => [input.command],
  },
  async call(input, ctx): Promise<ToolResult<BashOutput>> {
    const cwd = input.cwd ? resolvePath(input.cwd, ctx.cwd) : ctx.cwd
    const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT
    const startedAt = Date.now()

    return new Promise((resolvePromise) => {
      const env = { ...process.env, ...input.env }
      const child = spawn('bash', ['-c', input.command], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          timedOut = true
          child.kill('SIGKILL')
        }
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
        if (stdout.length > MAX_OUTPUT_CHARS) {
          stdout = stdout.slice(0, MAX_OUTPUT_CHARS) + '\n... [stdout 已截断]'
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
        if (stderr.length > MAX_OUTPUT_CHARS) {
          stderr = stderr.slice(0, MAX_OUTPUT_CHARS) + '\n... [stderr 已截断]'
        }
      })

      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({
          ok: false,
          error: { message: `无法执行命令: ${err.message}`, code: 'SPAWN_ERROR', cause: err },
        })
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({
          ok: true,
          output: {
            stdout,
            stderr,
            exitCode: code ?? (timedOut ? 124 : -1),
            timedOut,
            durationMs: Date.now() - startedAt,
            command: input.command,
          },
        })
      })

      // 支持 AbortSignal
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            child.kill('SIGKILL')
            resolvePromise({
              ok: false,
              error: { message: '操作被中断', code: 'ABORTED' },
              interrupted: true,
            })
          }
        } else {
          ctx.signal.addEventListener('abort', () => {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              child.kill('SIGKILL')
              resolvePromise({
                ok: false,
                error: { message: '操作被中断', code: 'ABORTED' },
                interrupted: true,
              })
            }
          })
        }
      }
    })
  },
})

// ========================================================================
// 4. list_dir 工具
// ========================================================================

/** list_dir 输入 */
export interface ListDirInput {
  /** 目录路径（相对 cwd 或绝对路径，默认 "."） */
  path?: string
  /** 是否递归列出子目录（默认 false，最大深度 3） */
  recursive?: boolean
  /** 是否显示隐藏文件（默认 false） */
  showHidden?: boolean
  /** 最大递归深度（默认 3） */
  maxDepth?: number
}

/** list_dir 条目 */
export interface DirEntry {
  /** 名称 */
  name: string
  /** 类型：file / dir / symlink */
  type: 'file' | 'dir' | 'symlink'
  /** 大小（字节，仅 file） */
  size?: number
  /** 相对路径（相对于输入路径） */
  relativePath: string
}

/** list_dir 输出 */
export interface ListDirOutput {
  /** 目录路径（绝对路径） */
  path: string
  /** 条目列表 */
  entries: DirEntry[]
  /** 总条目数 */
  count: number
  /** 是否被截断（超过限制） */
  truncated: boolean
}

/** 最大条目数 */
const MAX_DIR_ENTRIES = 500

/**
 * list_dir 工具：列出目录内容
 *
 * 安全声明：
 * - isReadOnly: true
 * - isConcurrencySafe: true
 * - permission.key: 'read'
 */
export const listDirTool = defineTool<ListDirInput, ListDirOutput>({
  id: 'list_dir',
  description: '列出目录内容。支持递归、隐藏文件显示。返回文件名、类型和大小。',
  inputSchema: makeSchema<ListDirInput>(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path ?? '.'],
  },
  async call(input, ctx): Promise<ToolResult<ListDirOutput>> {
    const relPath = input.path ?? '.'
    const absPath = resolvePath(relPath, ctx.cwd)

    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${relPath}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    try {
      const stats = await stat(absPath)
      if (!stats.isDirectory()) {
        return {
          ok: false,
          error: { message: `"${relPath}" 不是目录`, code: 'NOT_A_DIR' },
        }
      }

      const showHidden = input.showHidden ?? false
      const recursive = input.recursive ?? false
      const maxDepth = Math.min(input.maxDepth ?? 3, 5)
      const entries: DirEntry[] = []
      let truncated = false

      async function scanDir(dirPath: string, relBase: string, depth: number): Promise<void> {
        if (truncated) return
        if (depth > maxDepth) return

        const items = await readdir(dirPath, { withFileTypes: true })
        // 排序：目录优先，然后按名称
        const sorted = items.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1
          if (!a.isDirectory() && b.isDirectory()) return 1
          return a.name.localeCompare(b.name)
        })

        for (const item of sorted) {
          if (!showHidden && item.name.startsWith('.')) continue
          if (entries.length >= MAX_DIR_ENTRIES) { truncated = true; return }

          const itemRel = relBase ? `${relBase}/${item.name}` : item.name
          let type: DirEntry['type'] = 'file'
          let size: number | undefined

          try {
            if (item.isSymbolicLink()) {
              type = 'symlink'
              const realStat = await stat(join(dirPath, item.name))
              if (realStat.isFile()) { type = 'file'; size = realStat.size }
              else if (realStat.isDirectory()) type = 'dir'
            } else if (item.isDirectory()) {
              type = 'dir'
            } else {
              type = 'file'
              const s = await stat(join(dirPath, item.name))
              size = s.size
            }
          } catch {
            // stat 失败时保守处理
          }

          entries.push({ name: item.name, type, size, relativePath: itemRel })

          // 递归
          if (recursive && type === 'dir' && depth < maxDepth) {
            await scanDir(join(dirPath, item.name), itemRel, depth + 1)
          }
        }
      }

      await scanDir(absPath, '', 0)

      return {
        ok: true,
        output: {
          path: absPath,
          entries,
          count: entries.length,
          truncated,
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: { message: `目录不存在: ${relPath}`, code: 'DIR_NOT_FOUND' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'LIST_DIR_ERROR' } }
    }
  },
})

// ========================================================================
// 5. grep_file 工具
// ========================================================================

/** grep_file 输入 */
export interface GrepFileInput {
  /** 搜索模式（正则表达式字符串） */
  pattern: string
  /** 搜索路径：文件或目录（相对 cwd 或绝对路径，默认 "."） */
  path?: string
  /** 是否递归搜索目录（默认 true） */
  recursive?: boolean
  /** 是否大小写敏感（默认 true） */
  caseSensitive?: boolean
  /** 文件名 glob 过滤（如 "*.ts"，默认 "*" 匹配所有） */
  include?: string
  /** 最大返回匹配数（默认 100） */
  maxResults?: number
}

/** grep_file 匹配结果 */
export interface GrepMatch {
  /** 文件路径（绝对路径） */
  filePath: string
  /** 相对路径（相对于 cwd） */
  relativePath: string
  /** 行号（1-based） */
  line: number
  /** 匹配行内容 */
  content: string
  /** 匹配部分（高亮用，若 capture groups 存在则取第一个 group，否则取整行） */
  match: string
}

/** grep_file 输出 */
export interface GrepFileOutput {
  /** 搜索模式 */
  pattern: string
  /** 搜索路径 */
  path: string
  /** 匹配结果列表 */
  matches: GrepMatch[]
  /** 总匹配数 */
  count: number
  /** 搜索的文件数 */
  filesSearched: number
  /** 是否被截断 */
  truncated: boolean
}

/** 最大 grep 搜索文件数 */
const MAX_GREP_FILES = 200

/**
 * glob 匹配（简单实现：* → 任意字符，? → 单个字符）
 */
function globMatch(pattern: string, name: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regexStr}$`).test(name)
}

/**
 * grep_file 工具：搜索文件内容
 *
 * 安全声明：
 * - isReadOnly: true
 * - isConcurrencySafe: true
 * - permission.key: 'read'
 */
export const grepFileTool = defineTool<GrepFileInput, GrepFileOutput>({
  id: 'grep_file',
  description: '在文件或目录中搜索文本模式（正则表达式）。支持 glob 文件过滤、大小写敏感、递归搜索。',
  inputSchema: makeSchema<GrepFileInput>(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path ?? '.'],
  },
  async call(input, ctx): Promise<ToolResult<GrepFileOutput>> {
    const relPath = input.path ?? '.'
    const absPath = resolvePath(relPath, ctx.cwd)

    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${relPath}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    try {
      let regex: RegExp
      try {
        regex = new RegExp(input.pattern, input.caseSensitive === false ? 'gi' : 'g')
      } catch (e: any) {
        return { ok: false, error: { message: `正则表达式无效: ${e.message}`, code: 'INVALID_REGEX' } }
      }

      const recursive = input.recursive ?? true
      const includeGlob = input.include ?? '*'
      const maxResults = input.maxResults ?? 100
      const matches: GrepMatch[] = []
      let filesSearched = 0
      let truncated = false

      async function searchFile(filePath: string, relFilePath: string): Promise<void> {
        if (truncated) return
        filesSearched++
        if (filesSearched > MAX_GREP_FILES) { truncated = true; return }

        try {
          const content = await readFile(filePath, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) { truncated = true; return }
            regex.lastIndex = 0
            const m = regex.exec(lines[i])
            if (m) {
              matches.push({
                filePath,
                relativePath: relFilePath,
                line: i + 1,
                content: lines[i],
                match: m[1] ?? m[0],
              })
            }
          }
        } catch {
          // 跳过无法读取的文件
        }
      }

      async function scanDir(dirPath: string, relBase: string): Promise<void> {
        if (truncated) return
        const items = await readdir(dirPath, { withFileTypes: true })
        for (const item of items) {
          if (truncated) return
          if (item.name.startsWith('.') && !includeGlob.startsWith('.')) continue

          const itemAbs = join(dirPath, item.name)
          const itemRel = relBase ? `${relBase}/${item.name}` : item.name

          if (item.isDirectory()) {
            if (recursive) await scanDir(itemAbs, itemRel)
          } else if (item.isFile()) {
            if (globMatch(includeGlob, item.name)) {
              await searchFile(itemAbs, itemRel)
            }
          }
        }
      }

      const stats = await stat(absPath)
      if (stats.isFile()) {
        await searchFile(absPath, relPath)
      } else if (stats.isDirectory()) {
        await scanDir(absPath, '')
      } else {
        return { ok: false, error: { message: `路径不是文件或目录: ${relPath}`, code: 'INVALID_PATH' } }
      }

      return {
        ok: true,
        output: {
          pattern: input.pattern,
          path: absPath,
          matches,
          count: matches.length,
          filesSearched,
          truncated,
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: { message: `路径不存在: ${relPath}`, code: 'PATH_NOT_FOUND' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'GREP_ERROR' } }
    }
  },
})

// ========================================================================
// 6. edit_file 工具
// ========================================================================

/** edit_file 输入 */
export interface EditFileInput {
  /** 文件路径（相对 cwd 或绝对路径） */
  path: string
  /** 要替换的旧文本（必须精确匹配，含缩进/换行） */
  oldString: string
  /** 替换为的新文本 */
  newString: string
  /** 是否替换所有匹配（默认 false，仅替换第一个） */
  replaceAll?: boolean
}

/** edit_file 输出 */
export interface EditFileOutput {
  /** 文件路径（绝对路径） */
  path: string
  /** 替换次数 */
  replacements: number
  /** 修改前内容的行数（用于 diff 预览） */
  linesBefore: number
  /** 修改后内容的行数 */
  linesAfter: number
  /** 修改前片段（上下文 3 行） */
  beforeSnippet: string
  /** 修改后片段（上下文 3 行） */
  afterSnippet: string
}

/**
 * edit_file 工具：编辑文件（old_string → new_string 替换）
 *
 * 安全声明：
 * - isReadOnly: false
 * - isDestructive: false（精确替换，不会丢失内容）
 * - isConcurrencySafe: false（写操作）
 * - permission.key: 'write'
 *
 * 若 oldString 在文件中未找到 → 返回错误（NOT_FOUND）
 * 若 oldString 出现多次且 replaceAll=false → 返回错误（MULTIPLE_MATCHES）
 * 若 oldString === newString → 返回错误（NO_CHANGE）
 */
export const editFileTool = defineTool<EditFileInput, EditFileOutput>({
  id: 'edit_file',
  description: '编辑文件：精确查找并替换文本片段。默认只替换第一个匹配，支持 replaceAll。需要 oldString 在文件中唯一匹配。',
  inputSchema: makeSchema<EditFileInput>(),
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  permission: {
    key: 'write',
    extractPatterns: (input) => [input.path],
  },
  async call(input, ctx): Promise<ToolResult<EditFileOutput>> {
    const absPath = resolvePath(input.path, ctx.cwd)

    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${input.path}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    // 无变化检查
    if (input.oldString === input.newString) {
      return {
        ok: false,
        error: { message: 'oldString 和 newString 相同，无需修改', code: 'NO_CHANGE' },
      }
    }

    try {
      const existed = existsSync(absPath)
      if (!existed) {
        return { ok: false, error: { message: `文件不存在: ${input.path}`, code: 'FILE_NOT_FOUND' } }
      }

      const content = await readFile(absPath, 'utf-8')

      // 查找匹配
      let replacementCount = 0
      let newContent: string

      if (input.replaceAll) {
        const parts = content.split(input.oldString)
        replacementCount = parts.length - 1
        if (replacementCount === 0) {
          return { ok: false, error: { message: `未找到匹配的文本`, code: 'NOT_FOUND' } }
        }
        newContent = parts.join(input.newString)
      } else {
        const idx = content.indexOf(input.oldString)
        if (idx === -1) {
          return { ok: false, error: { message: `未找到匹配的文本`, code: 'NOT_FOUND' } }
        }
        // 检查是否有多个匹配
        const secondIdx = content.indexOf(input.oldString, idx + 1)
        if (secondIdx !== -1) {
          return {
            ok: false,
            error: {
              message: `oldString 在文件中匹配了多处（≥2），请提供更长的上下文使其唯一匹配，或设置 replaceAll=true`,
              code: 'MULTIPLE_MATCHES',
            },
          }
        }
        newContent = content.slice(0, idx) + input.newString + content.slice(idx + input.oldString.length)
        replacementCount = 1
      }

      await writeFile(absPath, newContent, 'utf-8')

      // 生成上下文片段（替换位置前后各 3 行）
      const beforeLines = content.split('\n')
      const afterLines = newContent.split('\n')
      const beforeSnippet = beforeLines.slice(0, 3).join('\n')
      const afterSnippet = afterLines.slice(0, 3).join('\n')

      return {
        ok: true,
        output: {
          path: absPath,
          replacements: replacementCount,
          linesBefore: beforeLines.length,
          linesAfter: afterLines.length,
          beforeSnippet,
          afterSnippet,
        },
      }
    } catch (err: any) {
      return { ok: false, error: { message: err.message ?? String(err), code: 'EDIT_ERROR' } }
    }
  },
})

// ========================================================================
// 7. AgentPlugin 入口
// ========================================================================

/** 内置工具列表（可按需选取） */
export const builtinTools: Tool[] = [readFileTool, writeFileTool, bashTool, listDirTool, grepFileTool, editFileTool]

/**
 * 内置 Tool 插件
 *
 * 通过 tool.pool.assemble Hook 把工具注入到工具池。
 * 可通过配置选择只注入部分工具。
 *
 * @param options.toolIds 可选：只注入指定 ID 的工具（默认全部）
 */
export function createToolsBuiltinPlugin(options?: {
  toolIds?: string[]
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds
    ? builtinTools.filter((t) => toolIds.includes(t.id))
    : builtinTools

  return {
    id: 'tools.builtin',
    version: '0.2.0',
    name: '内置工具',
    description: '提供 read_file / write_file / bash / list_dir / grep_file / edit_file 六个基础工具',
    async install(ctx) {
      ctx.log.info('内置工具插件已加载', { tools: tools.map((t) => t.id) })
      return {
        async 'tool.pool.assemble'(_input, pool) {
          for (const tool of tools) {
            ;(pool as { add: (t: unknown) => void }).add(tool)
          }
        },
      } as Hooks
    },
  }
}

/** 默认导出：注入全部六个工具的插件常量 */
export const toolsBuiltinPlugin: AgentPlugin = createToolsBuiltinPlugin()
