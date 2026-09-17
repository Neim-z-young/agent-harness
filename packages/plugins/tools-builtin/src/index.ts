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

import { defineTool, Tool, ToolResult, Schema, ToolContext, PermissionRequest } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

// ===== 路径解析工具 =====

import { resolve, isAbsolute, relative } from 'node:path'
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
// 4 个原语工具的完整文档（documentation，参考 Claude Code / opencode），prompts/*.txt 加载
import readFileDoc from './prompts/read-file.txt'
import writeFileDoc from './prompts/write-file.txt'
import editFileDoc from './prompts/edit-file.txt'
import bashDoc from './prompts/bash.txt'

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
  documentation: readFileDoc.trim(),
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
  documentation: writeFileDoc.trim(),
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
  /** 沙箱回退：非破坏性命令在沙箱内执行失败（被白名单拦截 / 遇 spawn/env 问题 / 命令非零退出）时，
   *  尝试提升到宿主 bash 重跑（放开白名单与 env 隔离、补充系统 PATH）。默认 false 关闭。 */
  fallbackToHost?: boolean
  /** 宿主回退前是否经权限引擎确认：ask 模式会询问用户，allow 静默放行，deny 拦截。默认 true。 */
  requireHostApproval?: boolean
}

/** 默认危险命令正则表（命中即拒绝执行） */
const DEFAULT_DANGEROUS_PATTERNS: RegExp[] = [
  /\(\)\s*\{[^{}]*\|[^{}]*\}/, // fork bomb（函数体启动即时递归 fork）
  /\brm\s+(?:-[a-z]*f[a-z]*\s+)*\/\s*(?:\*|$|--)/m, // rm -rf / 或 rm -rf /*
  /\brm\s+(-[a-z]*f[a-z]*\s*)*~\s/, // rm -rf ~
  /\bmkfs\.\w+/, // mkfs.*
  /\bdd\b.*\bof=\s*\/dev\/(sd|hd|rdisk|disk|vd|nvme)\w*/, // dd 写裸盘
  // 重定向裸设备。注意用 `(?:^|\s)` 而非 `\b`：`\b` 要求左侧是单词字符，
  // 于是 `echo x > /dev/sda`（`>` 前是空格）这种最常见写法反而**漏报**（测试已固定）。
  /(?:^|\s)>>?\s*\/dev\/(sd|hd|rdisk|disk|vd|nvme)\w*/,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, // 关机/重启
  /format\s+\/\s*\/s\s*\/f\/q/i, // Windows format /s /f /q（清盘）
  // 注：曾有一条 `>\s*\/dev\/null\b|\/dev\/sda`，已删除 ——
  // - `>/dev/null` / `2>/dev/null` 是最常见的**无害**重定向（丢弃输出），把它判为危险会
  //   大面积误伤正常命令（实测：`git rev-parse --is-inside-work-tree 2>/dev/null` 直接被拒）；
  // - `/dev/sda` 已由上面「重定向裸设备」那条更完整的规则覆盖（含 sd/hd/nvme/rdisk/disk/vd）。
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
  /** 是否经由沙箱回退到宿主 bash 执行（fallbackToHost 触发） */
  viaHost?: boolean
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
    documentation: bashDoc.trim(),
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

      // ---- 沙箱防护 2 前置：危险命令检测（无论是否回退都硬性拒绝，不可豁免） ----
      if (dangerousPatterns.length > 0) {
        const hit = detectDangerous(input.command, dangerousPatterns)
        if (hit) {
          return {
            ok: false,
            error: { message: `命令被沙箱判定为危险并拒绝执行（命中：${hit}）`, code: 'SANDBOX_DANGEROUS' },
          }
        }
      }

      // ---- 沙箱防护 1：cwd 限制（防路径逃逸；回退到宿主同样不允许逃逸工作区根） ----
      const requestedCwd = input.cwd ? resolvePath(input.cwd, ctx.cwd) : null
      if (requestedCwd && !isWithinCwd(requestedCwd, rootDir)) {
        return {
          ok: false,
          error: { message: `cwd 超出沙箱根目录，已拒绝：${input.cwd}`, code: 'SANDBOX_CWD' },
        }
      }

      const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT
      const cwd = requestedCwd ?? rootDir

      // ---- 沙箱防护 4：env 隔离（过滤敏感变量） ----
      const inherited = config.sanitizeEnv === false ? process.env : sanitizeEnv(process.env, keepEnv)
      const sandboxEnv = { ...inherited, ...(input.env ?? {}) }

      // ---- 沙箱防护 3：命令白名单 ----
      let allowlisted = true
      if (allowlist && allowlist.length > 0) {
        const firstCmd = extractFirstCommand(input.command)
        allowlisted = allowlist.some((a) =>
          firstCmd === a || input.command.trim().startsWith(a) || input.command.includes(a),
        )
        if (!allowlisted) {
          // 白名单拦截但允许宿主回退：非破坏性命令提升到宿主 bash 执行
          if (config.fallbackToHost) {
            const confirmed = await confirmHostRun(input, ctx, config)
            if (!confirmed) {
              return {
                ok: false,
                error: { message: `命令不在沙箱白名单内，宿主回退被拒绝：${firstCmd}`, code: 'SANDBOX_HOST_DENIED' },
              }
            }
            return runBash({ command: input.command, cwd, env: { ...process.env, ...(input.env ?? {}) }, timeoutMs, signal: ctx.signal, viaHost: true })
          }
          return {
            ok: false,
            error: { message: `命令不在沙箱白名单内，已拒绝：${firstCmd}`, code: 'SANDBOX_ALLOWLIST' },
          }
        }
      }

      // ---- 沙箱内执行 ----
      const sandboxResult = await runBash({
        command: input.command, cwd, env: sandboxEnv, timeoutMs, signal: ctx.signal,
      })

      // ---- 回退兜底：非破坏性命令在沙箱内未按预期执行（spawn 失败 / env 隔离开致命令非零退出）时提升到宿主 bash ----
      if (!sandboxResult.interrupted && sandboxResult.output?.exitCode !== 0 && config.fallbackToHost) {
        const confirmed = await confirmHostRun(input, ctx, config)
        if (!confirmed) {
          return {
            ok: false,
            error: { message: `命令在沙箱内执行失败，宿主回退被拒绝`, code: 'SANDBOX_HOST_DENIED' },
          }
        }
        return runBash({ command: input.command, cwd, env: { ...process.env, ...(input.env ?? {}) }, timeoutMs, signal: ctx.signal, viaHost: true })
      }

      return sandboxResult
    },
  })
}

/**
 * 宿主回退前的权限确认。
 *
 * 洞开沙箱（白名单/env 隔离）在宿主 bash 执行的命令，需要一次独立确认：
 * - 复用 bash 权限 key，pattern 前缀 `host:` 标识"宿主回退执行"；
 * - 权限引擎按规则/mode 决策：ask 模式会询问用户，allow 静默放行，deny 拦截；
 * - 无 requestPermission（纯工具调用）或 requireHostApproval=false 时静默放行。
 */
async function confirmHostRun(
  input: BashInput,
  ctx: ToolContext,
  config: BashSandboxConfig,
): Promise<boolean> {
  if (config.requireHostApproval === false || !ctx.requestPermission) return true
  const req: PermissionRequest = {
    toolKey: 'bash',
    patterns: [`host:\n${input.command}`],
    input,
  }
  const decision = await ctx.requestPermission(req)
  return decision.behavior !== 'deny'
}

/** 执行一条 bash 命令并采集 stdout/stderr/退出码。支持超时 kill 与 AbortSignal 中断。
 * viaHost=true 时在返回的 BashOutput 上标注，表示这次是宿主 bash 回退执行（放开白名单与 env 隔离）。
 */
function runBash(opts: {
  command: string
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs: number
  signal?: AbortSignal
  viaHost?: boolean
}): Promise<ToolResult<BashOutput>> {
  const startedAt = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn('bash', ['-c', opts.command], {
      cwd: opts.cwd,
      env: opts.env,
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
    }, opts.timeoutMs)

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
      // ok 语义：工具执行成功（命令实际跑起来），命令自身结果由 exitCode 反映。
      // 仅在 spawn 失败或 AbortSignal 中断时才返回 ok:false。
      resolvePromise({
        ok: true as boolean,
        output: {
          stdout,
          stderr,
          exitCode: code ?? (timedOut ? 124 : -1),
          timedOut,
          durationMs: Date.now() - startedAt,
          command: opts.command,
          viaHost: opts.viaHost,
        },
      })
    })

    if (opts.signal) {
      if (opts.signal.aborted) {
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
        opts.signal.addEventListener('abort', () => {
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

/** 把花引号归一化为直引号（参考 Claude Code findActualString / normalizeQuotes） */
function normalizeQuotes(s: string): string {
  return s
    .replaceAll('‘', "'")
    .replaceAll('’', "'")
    .replaceAll('“', '"')
    .replaceAll('”', '"')
}

/**
 * 定位文件里真正的匹配片段。
 * 先精确匹配；失败时把双方花引号归一化为直引号后再定位，
 * 返回文件里与该搜索意图对应的原始子串（保留原引号，便于精确替换）。
 */
function findActualString(fileContent: string, search: string): string | null {
  if (fileContent.includes(search)) {
    return search
  }
  const normalizedFile = normalizeQuotes(fileContent)
  const normalizedSearch = normalizeQuotes(search)
  const idx = normalizedFile.indexOf(normalizedSearch)
  if (idx === -1) {
    return null
  }
  return fileContent.substring(idx, idx + search.length)
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
 *
 * 替换逻辑增强（参考 Claude Code + opencode）：
 * - 换行归一：按文件实际的换行风格（LF/CRLF）归一 old/new string 再匹配
 * - 引号归一：精确匹配失败时，花引号（“”‘’）按直引号匹配定位真实片段
 * - 整行删除：newString 为空时顺带删掉尾随换行，不留空行
 */
export const editFileTool = defineTool<EditFileInput, EditFileOutput>({
  id: 'edit_file',
  description: '编辑文件：精确查找并替换文本片段。默认只替换第一个匹配，支持 replaceAll。需要 oldString 在文件中唯一匹配。',
  documentation: editFileDoc.trim(),
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

      // 归一化换行风格：读取文件的换行，把 old/new string 归一化到同样风格再匹配，
      // 避免 CRLF 文件因模型传入 \n 而匹配失败（参考 opencode 的 line-ending 处理）。
      const lineEnding = content.includes('\r\n') ? '\r\n' : '\n'
      const toLf = (s: string) => s.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      const toFileEnding = (s: string) => (lineEnding === '\r\n' ? s.replaceAll('\n', '\r\n') : s)
      const oldNorm = toFileEnding(toLf(input.oldString))
      const newNorm = toFileEnding(toLf(input.newString))

      // 定位文件里真正匹配的片段：先精确，匹配失败再引号归一（花引号→直引号）
      const actualOld = findActualString(content, oldNorm)
      if (actualOld === null) {
        return { ok: false, error: { message: `未找到匹配的文本`, code: 'NOT_FOUND' } }
      }
      if (actualOld === newNorm) {
        return { ok: false, error: { message: 'oldString 和 newString 相同，无需修改', code: 'NO_CHANGE' } }
      }

      // 整行删除：newString 为空且 oldString 不在行末时，顺带删掉尾随换行，避免留下空行；
      // 仅当内容里确实存在「old + 换行」时才扩展（文件末尾无换行时直接替换）
      const deleteWholeLine =
        newNorm === '' &&
        !actualOld.endsWith('\n') &&
        content.includes(actualOld + lineEnding)
      const oldForReplace = deleteWholeLine ? actualOld + lineEnding : actualOld

      // 查找匹配
      let replacementCount = 0
      let newContent: string

      if (input.replaceAll) {
        const parts = content.split(oldForReplace)
        replacementCount = parts.length - 1
        if (replacementCount === 0) {
          return { ok: false, error: { message: `未找到匹配的文本`, code: 'NOT_FOUND' } }
        }
        newContent = parts.join(newNorm)
      } else {
        const idx = content.indexOf(oldForReplace)
        if (idx === -1) {
          return { ok: false, error: { message: `未找到匹配的文本`, code: 'NOT_FOUND' } }
        }
        // 检查是否有多个匹配
        const secondIdx = content.indexOf(oldForReplace, idx + 1)
        if (secondIdx !== -1) {
          return {
            ok: false,
            error: {
              message: `oldString 在文件中匹配了多处（≥2），请提供更长的上下文使其唯一匹配，或设置 replaceAll=true`,
              code: 'MULTIPLE_MATCHES',
            },
          }
        }
        newContent = content.slice(0, idx) + newNorm + content.slice(idx + oldForReplace.length)
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
