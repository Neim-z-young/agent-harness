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
 * 通过 core.tool.pool.assemble Hook 自动注入到 Harness 工具池。
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

import { defineTool, Tool, ToolResult, ToolContext, PermissionRequest, fromJsonSchema, formatSchemaError, schemaIssues } from '@harness/tool'
import type { Schema } from '@harness/tool'
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

/** 结构守卫的结果：成功给解析后的入参，失败给可直接塞进 `ToolResult` 的错误 */
type InputGuardResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; code: string } }

/**
 * 直调入参结构守卫（`read_file` / `write_file` / `edit_file` / `bash` 共用）。
 *
 * 管道内 Step 1 已经用同一份 schema 拦过一次；这段是**"越过管道直接调 `tool.call()`"**
 * 那条路径的兜底（测试正是直接调的）。规则只留一份 —— 复用的就是喂给模型的那份 schema。
 *
 * **为什么必须有**：这些工具的 `call()` 第一行就会用入参 —— `resolvePath(input.path, ctx.cwd)`
 * 内部先做 `isAbsolute(inputPath)`，传 `undefined` / `null` / 数字 / 对象都会抛
 * `TypeError: The "path" property must be of type string`；bash 则会把 `undefined` 一路送进
 * spawn，由 shell 报出 `bash: undefined: command not found`（真机会话里连撞 6 次）。
 * 更要命的是 `resolvePath` 那行在 `try` **之外**，异常不会被下面的 catch 收敛，会直接冒泡给
 * 调用方（权限引擎的 `extractPatterns` 在此之前还会先拿到 `[undefined]`）。
 *
 * 错误码分两档：缺 `requiredField` ⇒ `requiredCode`（模型从码名就能读出少了哪个参数），
 * 其余结构问题 ⇒ `INVALID_INPUT`。
 *
 * 注意这把守卫只管**结构**。JSON Schema 表达不了的语义判据（如 bash 的"纯空白 command"）
 * 仍留在各自的 `call()` 里 —— 别为了收口把语义塞进来。
 *
 * @param requiredField 必填字段名 —— 缺它才算"缺参数"
 * @param requiredCode  缺 `requiredField` 时的对外错误码（如 `PATH_REQUIRED`）
 */
function guardInput<T>(
  schema: Schema<T>,
  input: unknown,
  requiredField: string,
  requiredCode: string,
): InputGuardResult<T> {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { ok: true, data: parsed.data }
  // 判据必须是 rule，不能只看 path：缺必填与"该字段类型不符"的 path 完全相同（都是字段名），
  // 只看 path 会把 `command: 123` 也报成 COMMAND_REQUIRED（码说"缺"、消息说"应为 字符串"）。
  const missing = schemaIssues(parsed.error).some(
    (i) => i.rule === 'required' && i.path === requiredField,
  )
  return {
    ok: false,
    error: {
      message: formatSchemaError(parsed.error),
      code: missing ? requiredCode : 'INVALID_INPUT',
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

/** read_file 的入参 schema（提到模块级，供 `call()` 里的直调守卫复用同一份） */
const readFileInputSchema = fromJsonSchema<ReadFileInput>({
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径（相对 cwd 或绝对路径）' },
    offset: { type: 'number', description: '起始行号（1-based，默认 1）' },
    limit: { type: 'number', description: '读取行数（默认全部）' },
    showLineNumbers: { type: 'boolean', description: '是否添加行号前缀（默认 false）' },
  },
  required: ['path'],
  additionalProperties: false,
})

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
  /**
   * 描述里**带一个可直接照抄的完整调用示例**，不只是字段说明。
   *
   * 为什么：真机（会话 `s_1790592617954_axqkk`）里 `read_file` 被发出 **14 次 `input: {}`**
   * （`jeha1` 6 / `rra6h` 6 / `goggv` 2），每次都触发一轮「入参自愈」回喂 ——
   * 自愈不吃步数，但**每一轮都是一次完整 prompt**（全 run 约 0.68M token ≈ 10%）。
   * 规律是"重度用 read_file 的会话才丢"（以 grep 为主的 n6fl0 一次没丢），
   * 且失败率随上下文变长而陡升 ⇒ 模型在长上下文里整段丢了 arguments。
   * 字段清单说明了"要什么"，示例说明了"长什么样" —— 后者才是可照抄的形状。
   */
  description: '读取本地文件内容。支持行号范围、行号前缀和截断。只能读取工作目录内的文件。'
    + '调用示例：read_file({"path":"src/index.ts"})、read_file({"path":"src/index.ts","offset":1,"limit":80})；'
    + 'path 是必填项，只给路径即可，不要省略 arguments。',
  documentation: readFileDoc.trim(),
  inputSchema: readFileInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path],
  },
  async call(input, ctx): Promise<ToolResult<ReadFileOutput>> {
    // 直调路径的结构守卫（管道路径已由 Step 1 拦过）——见 guardInput 的文档
    const guard = guardInput(readFileInputSchema, input, 'path', 'PATH_REQUIRED')
    if (!guard.ok) return { ok: false, error: guard.error }
    const absPath = resolvePath(input.path, ctx.cwd)

    // 路径安全检查
    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: {
        message:
          `路径 "${input.path}" 超出工作目录范围（工作目录：${ctx.cwd}）。` +
          'read_file / write_file / edit_file 只在工作目录内工作；' +
          '工作目录外请先在会话里说明要访问哪个路径及其用途，由用户确认后再处理。',
        code: 'PATH_OUTSIDE_CWD',
      },
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

/** write_file 的入参 schema（提到模块级，供 `call()` 里的直调守卫复用同一份） */
const writeFileInputSchema = fromJsonSchema<WriteFileInput>({
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径（相对 cwd 或绝对路径）' },
    content: { type: 'string', description: '写入内容' },
    mode: { type: 'string', enum: ['overwrite', 'append', 'create'], description: 'overwrite=覆盖/创建，append=追加，create=仅新建' },
    createDirs: { type: 'boolean', description: '是否自动创建父目录（默认 true）' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
})

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
  inputSchema: writeFileInputSchema,
  isReadOnly: () => false,
  isDestructive: (input) => input?.mode === 'overwrite',
  isConcurrencySafe: () => false,
  permission: {
    key: 'write',
    extractPatterns: (input) => [input.path],
  },
  async call(input, ctx): Promise<ToolResult<WriteFileOutput>> {
    // 直调路径的结构守卫（管道路径已由 Step 1 拦过）——见 guardInput 的文档
    const guard = guardInput(writeFileInputSchema, input, 'path', 'PATH_REQUIRED')
    if (!guard.ok) return { ok: false, error: guard.error }
    const absPath = resolvePath(input.path, ctx.cwd)
    const mode = input.mode ?? 'overwrite'

    // 路径安全检查
    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: {
        message:
          `路径 "${input.path}" 超出工作目录范围（工作目录：${ctx.cwd}）。` +
          'read_file / write_file / edit_file 只在工作目录内工作；' +
          '工作目录外请先在会话里说明要访问哪个路径及其用途，由用户确认后再处理。',
        code: 'PATH_OUTSIDE_CWD',
      },
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
  // 重定向裸设备。`>` 左侧允许**行首 / 空白 / fd 数字**三种形态，实测必须全覆盖：
  //   `echo x > /dev/sda`（空格）· `echo hi>/dev/sda`（无空格）· `echo x 2>/dev/sda`（fd）
  // 只用 `(?:^|\s)` 会把后两种**漏报**，只用 `\b`（单词边界）会把第一种漏报 —— 两种写法
  // 都出过事，故这里用 `\d*`（0 个或多个数字）而非限定左侧字符类。
  /\d*>>?\s*\/dev\/(sd|hd|rdisk|disk|vd|nvme)\w*/,
  // 破坏性命令直接以裸设备为参数（无重定向，故上一条覆盖不到）：
  // shred / wipefs / mkfs -t / parted mklabel / sgdisk -Z …
  // 刻意不含 fdisk（`-l` 是常见只读查看，误拒会直接卡住正常使用）。
  /\b(shred|wipefs|sgdisk|sfdisk|mkswap|badblocks|blockdev|mkfs|parted)\b[^|;&\n]*\/dev\/(sd|hd|rdisk|disk|vd|nvme)\w*/,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, // 关机/重启
  /format\s+\/\s*\/s\s*\/f\/q/i, // Windows format /s /f /q（清盘）
  // 注：曾有一条 `>\s*\/dev\/null\b|\/dev\/sda`，已删除 ——
  // - `>/dev/null` / `2>/dev/null` 是最常见的**无害**重定向（丢弃输出），把它判为危险会
  //   大面积误伤正常命令（实测：`git rev-parse --is-inside-work-tree 2>/dev/null` 直接被拒）；
  // - 裸 `/dev/sda` 字面量本身**不能**无差别保留：它会连 `fdisk -l /dev/sda`（只读查看）一起拒。
  //   改为上面两条更精确的规则兜底（重定向写盘 + 破坏性命令写盘），覆盖面不降、误伤更小。
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

/**
 * 只读 bash 的入参：与 {@link BashInput} 的唯一差别是**没有 `env`**。
 *
 * 为什么用一个单独的类型、而不是在 schema 里悄悄省掉 `env`：
 * 只读工具**刻意**不接受入参覆盖环境变量 —— ENV 是绕过只读的常见后门（`PYTHONSTARTUP` /
 * `NODE_OPTIONS` 都能让"只读命令"执行任意代码，见 {@link createReadOnlyBashTool} 内说明）。
 * 用 `Omit` 把这个决定写进类型，schema 与类型才是一致的；否则模型传 `env` 会被静默忽略，
 * 而编译期守卫（`JsonSchemaFor<T>`）也没法表达"这里少一个字段是故意的"。
 */
export type ReadOnlyBashInput = Omit<BashInput, 'env'>

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
 * bash 的入参 schema（模块级，与 `read_file` / `write_file` / `edit_file` 同形）。
 *
 * 之所以不写在工厂函数里：`call()` 内的直调守卫要复用**同一份**对象 ——
 * 复用的必须是喂给模型的那一份，否则又回到"schema 说一套、守卫判另一套"。
 */
const bashInputSchema = fromJsonSchema<BashInput>({
  type: 'object',
  properties: {
    command: { type: 'string', description: '要执行的 shell 命令' },
    cwd: { type: 'string', description: '工作目录（默认使用当前会话 cwd）' },
    timeoutMs: { type: 'number', description: '超时时间（毫秒，默认 30000）' },
    env: { type: 'object', description: '附加环境变量', additionalProperties: { type: 'string' } },
  },
  required: ['command'],
  additionalProperties: false,
})

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
    inputSchema: bashInputSchema,
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false,
    permission: {
      key: 'bash',
      extractPatterns: (input) => [input.command],
    },
    async call(input, ctx): Promise<ToolResult<BashOutput>> {
      const rootDir = config.rootDir ? resolvePath(config.rootDir, ctx.cwd) : ctx.cwd

      // 直调路径的结构守卫（管道路径已由 Step 1 拦过）——见 guardInput 的文档。
      // 历史（评审/真机修复）：缺 command 时曾把 undefined 一路传进 spawn，shell 报出
      // `bash: undefined: command not found`（exit 127）—— 模型看到的是一句和"你漏了参数"
      // 毫无关系的错误（真机会话里连撞 6 次）。
      const guard = guardInput(bashInputSchema, input, 'command', 'COMMAND_REQUIRED')
      if (!guard.ok) return { ok: false, error: guard.error }
      // 语义判据：JSON Schema 表达不了"纯空白串"，留在这里手判（不塞进结构守卫）。
      if (guard.data.command.trim() === '') {
        return {
          ok: false,
          error: { message: '缺少 command：请在入参 `command` 里给出要执行的 shell 命令', code: 'COMMAND_REQUIRED' },
        }
      }

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

// ========================================================================
// 4.5 只读 bash（bash_ro）—— 给「只读哨兵」用
// ========================================================================

/**
 * 只读命令白名单（首命令级）。
 *
 * 只放行「读 / 算 / 查」三类；凡是会写文件、改系统状态、联网、提权的命令一律不在表内。
 * 刻意**不含** `xargs`（它能把任意命令当参数执行）、`curl`/`wget`/`ssh`/`scp`（联网）、
 * `tee`/`dd`/`truncate`（写）、以及 `npm`/`tsc`/`make` 这类会产出构建物的命令。
 */
export const DEFAULT_READONLY_COMMANDS: readonly string[] = [
  // 文本查看 / 统计
  'cat', 'head', 'tail', 'wc', 'nl', 'sort', 'uniq', 'cut', 'tr', 'paste', 'rev', 'fold',
  'column', 'comm', 'join', 'diff', 'cmp', 'strings', 'od', 'hexdump',
  // 搜索 / 结构化查询
  'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'jq',
  // 目录 / 文件元信息
  'ls', 'find', 'tree', 'stat', 'file', 'du', 'df', 'pwd', 'realpath', 'basename', 'dirname', 'readlink',
  // 杂项只读
  'echo', 'printf', 'seq', 'true', 'false', 'test', 'expr', 'date', 'which', 'type', 'id', 'uname',
  'printenv', 'hostname', 'whoami',
  // 解释器（见 checkReadOnlyCommand 的「协作式只读」说明）
  'python', 'python3', 'node', 'bun', 'deno',
  // 版本控制（子命令另有只读白名单）
  'git',
]

/**
 * `git` 的只读子命令白名单（其余一律拒绝）。
 *
 * 刻意**不含** `tag` / `branch` / `remote` / `config` / `stash` / `worktree`：
 * 它们既能列出（读）也能带参数创建/修改（写），而只读工具没法按"有没有给参数"再分档
 * —— 宁可在只读模式下少给一点能力，也不要留一个"看起来只读实则能写"的口子。
 */
export const READONLY_GIT_SUBCOMMANDS: readonly string[] = [
  'log', 'show', 'diff', 'status', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
  'describe', 'shortlog', 'cat-file', 'show-ref', 'for-each-ref', 'symbolic-ref', 'merge-base',
  'count-objects', 'diff-files', 'diff-tree', 'diff-index', 'name-rev', 'whatchanged',
]

/** 命令参数级禁区：首命令在白名单里，但这些开关/子命令会写 */
const READONLY_FORBIDDEN_ARGS: ReadonlyArray<{ cmd: string; re: RegExp; why: string }> = [
  { cmd: 'sed', re: /(^|\s)-i(\s|$)|--in-place/, why: 'sed -i 会就地写文件' },
  { cmd: 'find', re: /-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/, why: 'find -delete/-exec 会写或执行命令' },
  { cmd: 'jq', re: /(^|\s)-i(\s|$)|--in-place/, why: 'jq -i 会就地写文件' },
  { cmd: 'sort', re: /(^|\s)-o(\s|$)|--output/, why: 'sort -o 会写文件' },
  { cmd: 'awk', re: /\bsystem\s*\(|\bprint(?:f)?\b[^;\n]*>\s*["'A-Za-z_./~/]/, why: 'awk 可 system() 或重定向写文件（> 在引号内，结构检查看不到）' },
  { cmd: 'date', re: /(^|\s)-s(\s|$)|--set/, why: 'date -s 会改系统时间' },
]

/**
 * 解释器（python/node/bun/deno）内联代码里的写/网特征。
 *
 * ⚠️ **这是过滤器，不是沙箱**。解释器天然能写文件，任何基于字符串的检查都能被绕过
 * （动态拼接、base64、getattr…）。只读哨兵给的是**协作式只读**：挡住"顺手写一下"这类
 * 常见误用，真正的写权限仍由 permission 引擎与宿主沙箱兜底。之所以仍然放行解释器，
 * 是因为量化统计类任务（`wc` 数不出来、需要按结构解析）离了它就只能靠 list_dir 的 size 字段凑
 * —— 真机里成功那个 reader 就是这么残废的。
 */
const INTERPRETER_WRITE_PATTERNS: readonly RegExp[] = [
  // 注意：模式必须锚在**逗号后**的 mode 参数上。早先写成 `open\([^)]*['"][wax]` 会把
  // `open('a.txt')`（只读！）误判成写 —— 文件名首字母恰好是 a/x/w 就中招。
  /\bopen\s*\([^)]*,\s*['"](?:w|a|x|w\+|a\+|r\+|wb|ab|xb|wt|at)[b+]*['"]/,
  /\bos\.(remove|unlink|rmdir|makedirs|mkdir|rename|replace|chmod|chown|truncate|system|popen)\b/,
  /\bshutil\./,
  /\bsubprocess\b/,
  /\bos\.(fork|exec)\w*/,
  /\brequests\b/,
  /\burllib\b/,
  /\bsocket\b/,
  /\bhttp\.client\b/,
  /\bfs\.(write|append|unlink|rm|mkdir|rename|chmod)\w*/,
  /\brequire\s*\(\s*['"](?:fs|child_process|http|https|net|os)['"]\s*\)/,
  /\bBun\.(write|spawn|file)\b/,
  /\bprocess\.(exit|kill)\b/,
  /\bDeno\.(write|remove|mkdir|run|Command)\w*/,
]

/** 这些命令的"脚本内容"需要额外做写/网特征扫描 */
const INTERPRETER_COMMANDS: readonly string[] = ['python', 'python3', 'node', 'bun', 'deno']

/** 只读校验裁决 */
export type ReadOnlyVerdict = { ok: true } | { ok: false; code: string; reason: string }

/** 结构性写入通道（在**去掉引号内容**的投影上检查：引号里的 `>` 是数据不是重定向） */
const WRITE_CHANNEL_PATTERNS: ReadonlyArray<{ re: RegExp; code: string; why: string }> = [
  { re: />>?/, code: 'SANDBOX_RO_REDIRECT', why: '输出重定向（> / >>）会写文件' },
  { re: /<\(|>\(/, code: 'SANDBOX_RO_SUBST', why: '进程替换（<() / >()）会执行子命令' },
  { re: /<</, code: 'SANDBOX_RO_HEREDOC', why: 'heredoc（<<）会被当作脚本执行' },
]

/** 命令替换：**引号内依然生效**（`"$(rm -rf /)"` 真的会执行），所以按原文检查 */
const SUBSTITUTION_PATTERNS: ReadonlyArray<{ re: RegExp; code: string; why: string }> = [
  { re: /\$\(|`/, code: 'SANDBOX_RO_SUBST', why: '命令替换（$( ) / 反引号）会执行子命令' },
]

/** 提权 / 系统控制 */
const PRIV_PATTERNS: ReadonlyArray<{ re: RegExp; code: string; why: string }> = [
  { re: /(^|[\s;&|])(sudo|doas|su|osascript|launchctl)\b/, code: 'SANDBOX_RO_PRIV', why: '提权 / 系统控制命令' },
]

/**
 * 把引号内的内容替换成占位符，得到"只含 shell 结构"的投影。
 *
 * 为什么必须这么做：`python3 -c "import os; os.remove('x')"` 里的 `;` 是**脚本内容**，
 * 不是 shell 的分段符；不做这一步就会把它切段，然后把 `os.remove(...)` 当成首命令报
 * "不在白名单"——错误码和真实原因完全对不上（写出来的是"命令不白名单"，实际是"脚本在写文件"）。
 */
function stripQuoted(command: string): string {
  let out = ''
  let q: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (q) {
      if (ch === q) { q = null; out += '""' }
      continue
    }
    if (ch === '"' || ch === "'") { q = ch; continue }
    out += ch
  }
  return out
}

/** 按 shell 分段符切段，**引号内的分隔符不算** */
function splitSegments(command: string): string[] {
  const out: string[] = []
  let buf = ''
  let q: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (q) {
      buf += ch
      if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue }
    if (ch === '\n' || ch === ';') { out.push(buf); buf = ''; continue }
    if (ch === '&' && command[i + 1] === '&') { out.push(buf); buf = ''; i++; continue }
    if (ch === '|' && command[i + 1] === '|') { out.push(buf); buf = ''; i++; continue }
    if (ch === '|') { out.push(buf); buf = ''; continue }
    buf += ch
  }
  out.push(buf)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * 校验一条命令是否**只读**（纯函数，可单测）。
 *
 * 判定顺序（任一不满足即拒绝，fail-closed）：
 * 1. 结构性写入通道（重定向 / 进程替换 / heredoc，按去引号投影）/ 命令替换（按原文）/
 *    提权（按去引号投影）—— 命中即整体拒绝；
 * 2. 按 shell 分段符切段（**引号内的分隔符不算**），每一段的首命令都必须 ∈ 白名单；
 * 3. 参数级禁区（sed -i / find -delete / sort -o / awk system 等）；
 * 4. `git` 子命令只读白名单；
 * 5. 解释器内联代码不得含写/网特征。
 */
export function checkReadOnlyCommand(
  command: string,
  allowlist: readonly string[] = DEFAULT_READONLY_COMMANDS,
): ReadOnlyVerdict {
  const raw = String(command ?? '')
  if (raw.trim() === '') {
    return { ok: false, code: 'COMMAND_REQUIRED', reason: '缺少 command：请在入参 `command` 里给出要执行的只读命令' }
  }
  // 1a. 只作用于 shell 结构的通道：先剥掉 2>&1 / 1>&2 这类 fd 复制（不写文件），再去引号
  const noFdDup = raw.replace(/[12]>&[12]/g, '')
  const structural = stripQuoted(noFdDup)
  for (const p of WRITE_CHANNEL_PATTERNS) {
    if (p.re.test(structural)) {
      return { ok: false, code: p.code, reason: `只读模式拒绝：${p.why}` }
    }
  }
  for (const p of PRIV_PATTERNS) {
    if (p.re.test(structural)) {
      return { ok: false, code: p.code, reason: `只读模式拒绝：${p.why}` }
    }
  }
  // 1b. 命令替换在引号内依然生效 ⇒ 按**原文**检查
  for (const p of SUBSTITUTION_PATTERNS) {
    if (p.re.test(noFdDup)) {
      return { ok: false, code: p.code, reason: `只读模式拒绝：${p.why}` }
    }
  }
  // 2. 逐段校验首命令
  const segments = splitSegments(stripQuoted(raw))
  const rawSegments = splitSegments(raw)
  if (segments.length === 0) {
    return { ok: false, code: 'COMMAND_REQUIRED', reason: '只读模式拒绝：命令为空' }
  }
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]!
    // 引号被剥掉后，段内只剩结构与命令名；脚本内容从对应的原文段取
    const rawSeg = rawSegments[si] ?? seg
    const cmd = extractFirstCommand(seg)
    if (!allowlist.includes(cmd)) {
      return {
        ok: false,
        code: 'SANDBOX_RO_ALLOWLIST',
        reason:
          `只读模式拒绝：「${cmd}」不在只读命令白名单内。`
          + '允许的命令见工具说明；需要写/联网/构建请让主 Agent 用 bash。',
      }
    }
    // 3. 参数级禁区（在原文段上判，避免被去引号影响）
    for (const f of READONLY_FORBIDDEN_ARGS) {
      if (cmd === f.cmd && f.re.test(rawSeg)) {
        return { ok: false, code: 'SANDBOX_RO_ALLOWLIST', reason: `只读模式拒绝：${f.why}` }
      }
    }
    // 4. git 子命令白名单
    if (cmd === 'git') {
      // 先剥掉"带值的全局旗标"（-C <dir> / --git-dir <dir> / -c <k=v>），
      // 否则它们的**值**会被误当成子命令（`git -C /x log` 里的 /x）。
      const args = seg.trim().split(/\s+/).slice(1)
      const cleaned: string[] = []
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '-c') { i++; continue }
        if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) continue
        cleaned.push(a)
      }
      const sub = cleaned.find((t) => !t.startsWith('-'))
      // 没有子命令词（如 `git --version`）⇒ 只剩只读旗标，放行
      if (sub !== undefined && !READONLY_GIT_SUBCOMMANDS.includes(sub)) {
        return {
          ok: false,
          code: 'SANDBOX_RO_ALLOWLIST',
          reason:
            `只读模式拒绝：git 子命令「${sub}」不在只读白名单内`
            + `（只读：${READONLY_GIT_SUBCOMMANDS.join(' / ')}）。需要提交/推送请让主 Agent 用 bash。`,
        }
      }
    }
    // 5. 解释器内联代码（在原文段上判，含引号内容）
    if (INTERPRETER_COMMANDS.includes(cmd)) {
      for (const re of INTERPRETER_WRITE_PATTERNS) {
        if (re.test(rawSeg)) {
          return {
            ok: false,
            code: 'SANDBOX_RO_SCRIPT',
            reason: `只读模式拒绝：脚本里出现写/网特征（${String(re)}）。只读模式只允许纯计算与读取。`,
          }
        }
      }
    }
  }
  return { ok: true }
}

/** 只读 bash 配置 */
export interface ReadOnlyBashConfig {
  /** 覆盖只读命令白名单（默认 {@link DEFAULT_READONLY_COMMANDS}） */
  allowlist?: readonly string[]
  /** 工作目录沙箱根（默认 ctx.cwd） */
  rootDir?: string
  /** 超时（毫秒，默认 15000 —— 只读命令通常很快，卡住多半是错的） */
  timeoutMs?: number
}

/**
 * 创建**只读** bash 工具（`bash_ro`）。
 *
 * 为什么单独一个工具而不是给 bash 加开关：`isReadOnly()` 是**无入参**的静态谓词，
 * 而 `@readonly` 哨兵是按它展开的（`ToolRegistry.filterByWhitelist`）。要让只读哨兵拿到 shell，
 * 只能提供一个"恒只读"的工具 —— 于是有了它。
 *
 * 真机背景（s_1790163574429_tg1a6）：成功那个 reader 在报告开头自述
 * 「本轮工具集**无命令执行能力**（白名单仅 read_file / list_dir / glob / grep_file），
 * 无法运行 wc/python3」，导致它的统计章节只能标注"未覆盖" —— 哨兵把 bash 一起禁掉，
 * 让量化盘点类任务天生残废。
 *
 * 安全声明：
 * - isReadOnly: true（{@link checkReadOnlyCommand} 强制只读白名单，非白名单即拒绝）
 * - isConcurrencySafe: true（只读，可与其它只读调用并行）
 * - 不做宿主回退（回退等于绕过只读约束）
 * - **协作式只读**：挡的是"顺手写一下"，不是恶意绕过；硬边界仍由 permission 引擎与宿主沙箱负责
 */
export function createReadOnlyBashTool(config: ReadOnlyBashConfig = {}): Tool<ReadOnlyBashInput, BashOutput> {
  const allowlist = config.allowlist ?? DEFAULT_READONLY_COMMANDS
  const timeoutDefault = config.timeoutMs ?? 15_000

  return defineTool<ReadOnlyBashInput, BashOutput>({
    id: 'bash_ro',
    description:
      '执行**只读** shell 命令（白名单受限：cat/head/tail/wc/grep/sed/awk/find/ls/stat/du/git log/python3 -c 等）。'
      + '拒绝重定向、命令替换、提权与任何写操作。用于统计、检索、结构化盘点；要写文件请用主 Agent 的 bash。',
    inputSchema: fromJsonSchema<ReadOnlyBashInput>({
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的只读命令（不得含 >、$()、反引号、heredoc）' },
        cwd: { type: 'string', description: '工作目录（默认当前会话 cwd，且不得逃出它）' },
        timeoutMs: { type: 'number', description: '超时时间（毫秒，默认 15000）' },
      },
      required: ['command'],
      additionalProperties: false,
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    permission: {
      key: 'bash_ro',
      extractPatterns: (input) => [input.command],
    },
    async call(input, ctx): Promise<ToolResult<BashOutput>> {
      const verdict = checkReadOnlyCommand(input?.command, allowlist)
      if (!verdict.ok) {
        return { ok: false, error: { message: verdict.reason, code: verdict.code } }
      }
      const rootDir = config.rootDir ? resolvePath(config.rootDir, ctx.cwd) : ctx.cwd
      const requestedCwd = input.cwd ? resolvePath(input.cwd, ctx.cwd) : null
      if (requestedCwd && !isWithinCwd(requestedCwd, rootDir)) {
        return {
          ok: false,
          error: { message: `cwd 超出沙箱根目录，已拒绝：${input.cwd}`, code: 'SANDBOX_CWD' },
        }
      }
      // 只读工具不接受入参覆盖环境变量：ENV 是绕过只读的常见后门（PYTHONSTARTUP / NODE_OPTIONS
      // 都能让"只读命令"执行任意代码）。一律用过滤后的宿主环境，不做任何合并。
      const env = sanitizeEnv(process.env, [])
      const result = await runBash({
        command: input.command,
        cwd: requestedCwd ?? rootDir,
        env,
        timeoutMs: input.timeoutMs ?? timeoutDefault,
        signal: ctx.signal,
      })
      return result
    },
  })
}

/** 默认只读 bash 工具（只读哨兵用） */
export const readOnlyBashTool: Tool<ReadOnlyBashInput, BashOutput> = createReadOnlyBashTool()

/** 执行一条 bash 命令并采集 stdout/stderr/退出码。支持超时 kill 与 AbortSignal 中断。
 * viaHost=true 时在返回的 BashOutput 上标注，表示这次是宿主 bash 回退执行（放开白名单与 env 隔离）。
 */
function runBash(opts: {  command: string
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

/** edit_file 的入参 schema（提到模块级，供 `call()` 里的直调守卫复用同一份） */
const editFileInputSchema = fromJsonSchema<EditFileInput>({
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径（相对 cwd 或绝对路径）' },
    oldString: { type: 'string', description: '要替换的旧文本（必须精确匹配，含缩进/换行）' },
    newString: { type: 'string', description: '替换为的新文本' },
    replaceAll: { type: 'boolean', description: '是否替换所有匹配（默认 false，仅替换第一个）' },
  },
  required: ['path', 'oldString', 'newString'],
  additionalProperties: false,
})

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
  inputSchema: editFileInputSchema,
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  permission: {
    key: 'write',
    extractPatterns: (input) => [input.path],
  },
  async call(input, ctx): Promise<ToolResult<EditFileOutput>> {
    // 直调路径的结构守卫（管道路径已由 Step 1 拦过）——见 guardInput 的文档
    const guard = guardInput(editFileInputSchema, input, 'path', 'PATH_REQUIRED')
    if (!guard.ok) return { ok: false, error: guard.error }
    const absPath = resolvePath(input.path, ctx.cwd)

    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: {
        message:
          `路径 "${input.path}" 超出工作目录范围（工作目录：${ctx.cwd}）。` +
          'read_file / write_file / edit_file 只在工作目录内工作；' +
          '工作目录外请先在会话里说明要访问哪个路径及其用途，由用户确认后再处理。',
        code: 'PATH_OUTSIDE_CWD',
      },
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

/** 内置工具列表（文件 I/O + Shell 原语 + 只读 shell；搜索类见 @harness/tools-search） */
export const builtinTools: Tool[] = [readFileTool, writeFileTool, bashTool, editFileTool, readOnlyBashTool]

/**
 * 内置 Tool 插件
 *
 * 通过 core.tool.pool.assemble Hook 把工具注入到工具池。
 * 可通过配置选择只注入部分工具，并配置 bash 沙箱。
 *
 * @param options.toolIds 可选：只注入指定 ID 的工具（默认全部）
 * @param options.bash 可选：bash 沙箱配置（危险命令检测 / env 隔离 / cwd 限制 / 白名单）
 * @param options.readOnlyBash 可选：只读 bash（`bash_ro`）配置；传 `false` 不注册该工具
 */
export function createToolsBuiltinPlugin(options?: {
  toolIds?: string[]
  bash?: BashSandboxConfig
  readOnlyBash?: ReadOnlyBashConfig | false
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds
    ? builtinTools.filter((t) => toolIds.includes(t.id))
    : builtinTools
        .filter((t) => !(t.id === 'bash_ro' && options?.readOnlyBash === false))
        .map((t) => {
          if (t.id === 'bash' && options?.bash) return createBashTool(options.bash)
          if (t.id === 'bash_ro' && options?.readOnlyBash) return createReadOnlyBashTool(options.readOnlyBash)
          return t
        })

  return {
    id: 'tools.builtin',
    version: '0.3.0',
    name: '内置工具',
    description: '提供 read_file / write_file / bash / bash_ro / edit_file 五个文件 I/O + Shell 原语（搜索类见 @harness/tools-search）',
    async install(ctx) {
      ctx.log.info('内置工具插件已加载', { tools: tools.map((t) => t.id) })
      return {
        async 'core.tool.pool.assemble'(_input, pool) {
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
