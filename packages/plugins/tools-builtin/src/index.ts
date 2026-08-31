/**
 * @harness/tools-builtin - 内置 Tool 插件（文件 I/O + Shell 原语）
 *
 * 仅保留四个不可替代的原语工具：
 * - read_file：读取文件内容（支持行号、范围、截断）
 * - write_file：写入文件（创建/覆盖/追加）
 * - bash：执行 shell 命令（支持超时、cwd、stdout/stderr/exitCode）
 * - edit_file：精确查找替换（old_string → new_string）
 *
 * 搜索/导航类工具（list_dir / grep_file）见 @harness/tools-search。
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

import { resolve, isAbsolute, relative } from 'node:path'
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
// 3. bash 工具（含沙箱防护）
// ========================================================================

/** bash 沙箱配置 */
export interface BashSandboxConfig {
  /** 危险命令检测（默认 true） */
  dangerousDetection?: boolean
  /** 额外危险命令正则（追加到默认检测表） */
  additionalDangerous?: RegExp[]
  /** 工作目录根：cwd 必须在此目录内（默认 ctx.cwd，限制逃逸） */
  rootDir?: string
  /** 是否对继承环境做敏感变量隔离（默认 true） */
  sanitizeEnv?: boolean
  /** 环境隔离时额外保留的环境变量名 */
  keepEnv?: string[]
  /** 命令白名单（首命令名或完整命令片段，空/未设置则不限制） */
  allowlist?: string[]
}

/** 默认危险命令正则表（命中即拒绝执行） */
const DEFAULT_DANGEROUS_PATTERNS: RegExp[] = [
  /\(\)\s*\{[^{}]*\|[^{}]*\}/, // fork bomb（函数体启动即时递归 fork）
  /\brm\s+(?:-[a-z]*f[a-z]*\s+)*\/\s*(?:\*|$|--)/m, // rm -rf / 或 rm -rf /*
  /\brm\s+(-[a-z]*f[a-z]*\s*)*~\s/, // rm -rf ~
  /\bmkfs\.\w+/, // mkfs.*
  /\bdd\b.*\bof=\s*\/dev\/(sd|hd|rdisk|disk|vd|nvme)\w*/, // dd 写裸盘
  /\b>(>>)?\s*\/dev\/(sd|hd|rdisk|disk|vd|nvme)\w*/, // 重定向裸设备
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, // 关机/重启
  />\s*\/dev\/null\b|\/dev\/sda|format\s+\/\s*\/s\s*\/f\/q/, // 常见破坏性
  /\bcurl\b[^|;]*\|\s*(bash|sh)\b|\bwget\b[^|;]*\|\s*(bash|sh)\b/, // curl|bash
  /\bchmod\s+-R\s+777\s+\//, // 递归改根目录权限
  /\bsudo\s+rm\s+-rf\s+(\/|\*)/, // sudo rm -rf /
]

/** 默认敏感环境变量名（隔离时从继承环境移除） */
const DEFAULT_SENSITIVE_ENV = [
  /AWS_ACCESS_KEY|AWS_SECRET|AWS_SESSION_TOKEN/,
  /GITHUB_TOKEN|GITLAB_TOKEN|GH_TOKEN/,
  /OPENAI|ANTHROPIC|DEEPSEEK|GOOGLE|AZURE|BEDROCK|GEMINI|MISTRAL|COHERE/i,
  /API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN/,
  /PASSWORD|PASSWD|CREDENTIAL/i,
  /PRIVATE_KEY|PEM\b/,
]

/** 危险命令检测：返回命中的模式描述，未命中返回 null */
function detectDangerous(command: string, patterns: RegExp[]): RegExp | null {
  for (const re of patterns) {
    if (re.test(command)) return re
  }
  return null
}

/** 环境隔离：过滤掉敏感变量，保留必要与 keepEnv 指定的变量 */
function sanitizeEnv(env: NodeJS.ProcessEnv, keepEnv: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    const value = env[key]
    if (value === undefined) continue
    if (keepEnv.includes(key)) {
      result[key] = value
      continue
    }
    const sensitive = DEFAULT_SENSITIVE_ENV.some((re) => re.test(key))
    if (!sensitive) result[key] = value
  }
  return result
}

/** 从命令提取首个命令名（用于白名单匹配） */
function extractFirstCommand(command: string): string {
  const trimmed = command.trim().replace(/^[;&|\s]*/, '')
  // 跳过前缀赋值（VAR=x cmd）与 sudo/env 前缀
  let m = trimmed.match(/^(?:[A-Za-z_][\w]*=[^\s]*\s+)*(?:sudo\s+|env\s+)?([^\s|;&<>]+)/)
  return m ? m[1] : trimmed.split(/\s+/)[0] ?? ''
}

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
 * 创建 bash 工具（含沙箱防护）
 *
 * 安全声明：
 * - isReadOnly: false（可能有写副作用）
 * - isConcurrencySafe: false（命令可能有副作用）
 * - isDestructive: true（命令可能删除文件等）
 * - permission.key: 'bash'
 *
 * 沙箱能力（config 控制）：
 * - 危险命令检测：命中默认/自定义危险正则即拒绝执行
 * - cwd 限制：cwd 必须位于 rootDir（默认 ctx.cwd）内，防止路径逃逸
 * - env 隔离：从继承环境过滤敏感变量（密钥/token/密码）
 * - 命令白名单：配置后仅允许列出的命令
 */
export function createBashTool(config: BashSandboxConfig = {}): Tool<BashInput, BashOutput> {
  const dangerousPatterns = config.dangerousDetection === false
    ? []
    : [...DEFAULT_DANGEROUS_PATTERNS, ...(config.additionalDangerous ?? [])]
  const allowlist = config.allowlist
  const keepEnv = config.keepEnv ?? []

  return defineTool<BashInput, BashOutput>({
    id: 'bash',
    description: '执行 shell 命令（沙箱受限）。支持超时、工作目录和环境变量。返回 stdout/stderr/exitCode。',
    inputSchema: makeSchema<BashInput>(),
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false,
    permission: {
      key: 'bash',
      extractPatterns: (input) => [input.command],
    },
    async call(input, ctx): Promise<ToolResult<BashOutput>> {
      const rootDir = config.rootDir ? resolvePath(config.rootDir, ctx.cwd) : ctx.cwd

      // ---- 沙箱防护 1：cwd 限制（防路径逃逸） ----
      if (input.cwd) {
        const absCwd = resolvePath(input.cwd, ctx.cwd)
        if (!isWithinCwd(absCwd, rootDir)) {
          return {
            ok: false,
            error: { message: `cwd 超出沙箱根目录，已拒绝：${input.cwd}`, code: 'SANDBOX_CWD' },
          }
        }
      }

      // ---- 沙箱防护 2：危险命令检测 ----
      if (dangerousPatterns.length > 0) {
        const hit = detectDangerous(input.command, dangerousPatterns)
        if (hit) {
          return {
            ok: false,
            error: { message: `命令被沙箱判定为危险并拒绝执行（命中：${hit}）`, code: 'SANDBOX_DANGEROUS' },
          }
        }
      }

      // ---- 沙箱防护 3：命令白名单 ----
      if (allowlist && allowlist.length > 0) {
        const firstCmd = extractFirstCommand(input.command)
        const allowed = allowlist.some((a) =>
          firstCmd === a || input.command.trim().startsWith(a) || input.command.includes(a),
        )
        if (!allowed) {
          return {
            ok: false,
            error: { message: `命令不在沙箱白名单内，已拒绝：${firstCmd}`, code: 'SANDBOX_ALLOWLIST' },
          }
        }
      }

      const cwd = input.cwd ? resolvePath(input.cwd, ctx.cwd) : rootDir
      const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT
      const startedAt = Date.now()

      return new Promise((resolvePromise) => {
        // ---- 沙箱防护 4：env 隔离（过滤敏感变量） ----
        const inherited = config.sanitizeEnv === false ? process.env : sanitizeEnv(process.env, keepEnv)
        const env = { ...inherited, ...input.env }
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
}

// ========================================================================
// 4. edit_file 工具
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
// 5. AgentPlugin 入口
// ========================================================================

/** 默认 bash 工具（沙箱使用推荐配置） */
export const bashTool: Tool<BashInput, BashOutput> = createBashTool()

/** 内置工具列表（仅保留文件 I/O + Shell 四个原语；搜索类见 @harness/tools-search） */
export const builtinTools: Tool[] = [readFileTool, writeFileTool, bashTool, editFileTool]

/**
 * 内置 Tool 插件
 *
 * 通过 tool.pool.assemble Hook 把工具注入到工具池。
 * 可通过配置选择只注入部分工具，并配置 bash 沙箱。
 *
 * @param options.toolIds 可选：只注入指定 ID 的工具（默认全部）
 * @param options.bash 可选：bash 沙箱配置（危险命令检测 / env 隔离 / cwd 限制 / 白名单）
 */
export function createToolsBuiltinPlugin(options?: {
  toolIds?: string[]
  bash?: BashSandboxConfig
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds
    ? builtinTools.filter((t) => toolIds.includes(t.id))
    : builtinTools.map((t) => t.id === 'bash' && options?.bash ? createBashTool(options.bash) : t)

  return {
    id: 'tools.builtin',
    version: '0.3.0',
    name: '内置工具',
    description: '提供 read_file / write_file / bash / edit_file 四个文件 I/O + Shell 原语（搜索类见 @harness/tools-search）',
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

/** 默认导出：注入全部四个原语工具的插件常量 */
export const toolsBuiltinPlugin: AgentPlugin = createToolsBuiltinPlugin()
