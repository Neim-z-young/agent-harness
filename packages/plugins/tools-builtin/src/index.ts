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
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
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
// 4. AgentPlugin 入口
// ========================================================================

/** 内置工具列表（可按需选取） */
export const builtinTools: Tool[] = [readFileTool, writeFileTool, bashTool]

/**
 * 内置 Tool 插件
 *
 * 通过 tool.pool.assemble Hook 把 read_file / write_file / bash 注入到工具池。
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
    version: '0.1.0',
    name: '内置工具',
    description: '提供 read_file / write_file / bash 三个基础工具',
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

/** 默认导出：注入全部三个工具的插件常量 */
export const toolsBuiltinPlugin: AgentPlugin = createToolsBuiltinPlugin()
