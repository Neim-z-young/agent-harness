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

import { defineTool, Tool, ToolResult, ToolContext, PermissionRequest, fromJsonSchema, guardInput } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

// ===== 路径解析工具 =====

// 路径边界（resolvePath / isWithinCwd）：P0-4/P0-5/P3-1 收敛到 @harness/fs-guard **一处**
// —— 原来这 6 个包各写一份，且是**纯字符串**判定（不解析符号链接）⇒ cwd 里一条
// `ln -s /etc secret` 就让 `secret/passwd` 通过边界检查、实际却读到界外。
import {
  resolvePath,
  isWithinCwd,
  isSensitiveReadPath,
  findSensitiveReadPath,
  resolveSensitiveReadPolicy,
  type SensitiveReadPolicyInput,
} from '@harness/fs-guard'
// 隔离档位与网络出口策略（P1-4 / P1-2）：与宿主、tools-web 共用同一份口径
import {
  assessNetAccess,
  detectOsBindingFailure,
  formatDenial,
  isOsBound,
  resolveNetPolicy,
  type IsolationLevel,
  type NetPolicy,
  type OsBinding,
} from '@harness/isolation'
import { resolve, relative } from 'node:path'
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
// 4 个原语工具的完整文档（documentation，参考 Claude Code / opencode），prompts/*.txt 加载
import readFileDoc from './prompts/read-file.txt'
import writeFileDoc from './prompts/write-file.txt'
import editFileDoc from './prompts/edit-file.txt'
import bashDoc from './prompts/bash.txt'
import { analyzeBashCommand, type BashCommandFacts } from './bash-ast'

/** bash 命令 AST 分析（公共 API；见 {@link analyzeBashCommand}） */
export { analyzeBashCommand } from './bash-ast'
export type { BashAstCommand, BashAstRedirect, BashCommandFacts } from './bash-ast'

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
 * 单次可读的文件**总大小**上限（P1-8，默认 10 MiB）。
 *
 * 为什么需要：上面两条只管**输出**（1 万行 / 256KB 字符），而 `readFile(absPath, 'utf-8')` 是
 * **整文件载入**后才切片 —— 读一个 2 GiB 的日志照样会先把 2 GiB 拉进内存（再被截到
 * 256KB）。既是可用性问题（一次调用吃掉整个进程的内存预算），也是安全问题（把数据文件
 * 当成源码来读）。`limit` / `offset` 也救不了这个：切片发生在载入之后。
 *
 * 上限而非拒绝类别：真需要大文件用 `grep_file`（流式逐文件）或 bash（`sed -n '1,80p'`）。
 */
export const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024

/** 人读的字节数（错误消息里说清"到底多大"—— 光给数字，模型/人都要自己换算） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

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
export function createReadFileTool(opts: { readDeny?: SensitiveReadPolicyInput; maxReadBytes?: number } = {}): Tool<ReadFileInput, ReadFileOutput> {
  const readDeny = resolveSensitiveReadPolicy(opts.readDeny)
  // P1-8：`0` / 非正数 = 不限制（与 BashLimits 的 0 = 不限制同口径）
  const maxReadBytes = opts.maxReadBytes !== undefined && opts.maxReadBytes > 0
    ? opts.maxReadBytes
    : DEFAULT_MAX_READ_BYTES
  return defineTool<ReadFileInput, ReadFileOutput>({
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
            formatDenial({
              what: `路径 "${input.path}" 超出工作目录范围（工作目录：${ctx.cwd}）`,
              why: OUTSIDE_CWD_WHY,
              how: OUTSIDE_CWD_HOW,
            }),
          code: 'PATH_OUTSIDE_CWD',
        },
        }
      }

      // 读侧敏感文件（P0-3）：**边界内**的密钥/凭据默认拒读。
      // “只能读工作目录内”只保证了边界，cwd 里的 `.env` / `id_rsa` 原本畅通。
      // 判据用**相对 cwd 的路径**（与策略的匹配口径一致）；命中项写进消息，便于解释为何被拒。
      if (readDeny) {
        const rel = relative(ctx.cwd, absPath)
        if (isSensitiveReadPath(rel, readDeny)) {
          return {
            ok: false,
            error: {
              message: formatDenial({
                what: `拒绝读取敏感文件：${rel}`,
                why: '沙箱默认拒读凭据类文件：.env / id_rsa* / *.pem / .ssh/** / .aws/** / permissions.json 等。',
                how: '确实需要时让用户确认后用 bash 读（bash 有独立的权限键与审批），'
                  + '或把该形态从 config.json → sandbox.readDeny 里去掉。',
              }),
              code: 'SANDBOX_READ_DENIED',
            },
          }
        }
      }

      try {
        const stats = await stat(absPath)
        if (!stats.isFile()) {
          // P1-8：原来只有一句「不是文件」—— 目录、块设备、`/dev/zero`（字符设备）、FIFO
          // 全归同一个含糊消息，模型看不出该换什么工具（读目录该用 list_dir，读设备本就不该读）。
          const kind = stats.isDirectory() ? '目录'
            : stats.isBlockDevice() ? '块设备'
              : stats.isCharacterDevice() ? '字符设备（如 /dev/zero、/dev/urandom）'
                : stats.isFIFO() ? '命名管道（FIFO）'
                  : stats.isSocket() ? '套接字'
                    : stats.isSymbolicLink() ? '符号链接'
                      : '特殊文件'
          const hint = stats.isDirectory() ? '目录内容请用 list_dir，目录内检索请用 grep_file。' : ''
          return {
            ok: false,
            error: { message: `"${input.path}" 不是普通文件（实际是${kind}），read_file 只读普通文件。${hint}`, code: 'NOT_A_FILE' },
          }
        }

        // P1-8：大小闸。放在 `readFile` **之前** —— 它的全部意义就是不让整文件进内存。
        if (stats.size > maxReadBytes) {
          return {
            ok: false,
            error: {
              message: formatDenial({
                what: `拒绝读取过大的文件：${input.path} 有 ${formatBytes(stats.size)}，`
                  + `超过单次读取上限 ${formatBytes(maxReadBytes)}`,
                why: 'read_file 是整文件载入后才切片（offset/limit 救不了），'
                  + '这个上限就是为了不把整文件拉进内存。',
                how: '调 config.json → sandbox.readMaxBytes（0 = 不限制）；'
                  + '或文件内检索改用 grep_file、按行段读取改用 bash（如 `sed -n \'1,80p\' 文件`）。',
              }),
              code: 'SANDBOX_READ_TOO_LARGE',
            },
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
}

/** 默认 read_file：内置敏感读清单（见 createReadFileTool） */
export const readFileTool: Tool<ReadFileInput, ReadFileOutput> = createReadFileTool()

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
        message: formatDenial({
          what: `路径 "${input.path}" 超出工作目录范围（工作目录：${ctx.cwd}）`,
          why: OUTSIDE_CWD_WHY,
          how: OUTSIDE_CWD_HOW,
        }),
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
  /**
   * 资源上限（P1-1 / L1）。未设的项取 {@link DEFAULT_BASH_LIMITS}，**显式 `0` 表示该项不限制**，
   * `false` 表示全部关掉。只在 **bash 族系**下经 `ulimit` 前置生效（非 bash 族系**不模拟**）。
   */
  limits?: BashLimits | false
  /**
   * 网络出口策略（P1-2）：`open`（默认，与改造前逐位一致）/ `allowlist` / `deny`。
   * 见 `@harness/isolation` 的 `assessNetAccess`（**L0 静态门**，不是内核边界）。
   */
  net?: NetPolicy
  /** `allowlist` 模式的目标白名单（host / 域名；子域自动覆盖） */
  netAllow?: string[]
  /**
   * 本次执行实际所处的隔离档位（P1-4），由宿主在装配期解析后注入；作为
   * `BashOutput.isolation.level` 回给模型与取证脚本。
   *
   * 缺省 `'L1'` 是本**工具自身**能兑现的下限（策略层 + 进程层：危险表 / 白名单 /
   * 权限键 / 进程树 kill / 资源上限 / env 默认拒绝），与宿主能坐到哪一档无关。
   * 注：宿主没注入时**不谎报** L2 —— L2 要 OS 级绑定（P1-3），不是这个工具能自己给的。
   */
  isolationLevel?: IsolationLevel
  /**
   * **OS 级绑定**（P1-3 / L2）：宿主在装配期构造并自检通过后递进来。
   *
   * 递进来 ⇒ 本次 spawn 会把命令包进原语（`sandbox-exec` / `bwrap`），可写区**真的**
   * 被 OS 限制在声明目录内；不递（缺省）⇒ 只有 L0/L1 的策略层与进程层 —— **不模拟**
   * （没有原语就是没有，`fsBound` 会如实报 false）。
   */
  osBinding?: OsBinding | null
}

/**
 * 资源上限（P1-1）。全部单位见字段注释；**0 = 不限制**。
 *
 * 实现走 `ulimit` 抬头（子 shell 内生效），不依赖任何 native 模块。三条实测得来的约束
 * 见 {@link buildLimitPreamble} 的注释（`-f` 的单位不统一、`-v` 在 macOS 不支持、
 * 合并形态会互相连累）。
 */
export interface BashLimits {
  /** CPU 秒数（`ulimit -t`）。wall-clock 超时（`timeoutMs`）已覆盖大部分场景，默认不设 */
  cpuSeconds?: number
  /** 单文件大小上限（KB，`ulimit -f`）。默认 2 GiB */
  maxFileSizeKb?: number
  /** 进程/线程数上限（`ulimit -u`，fork bomb 防线）。默认不设（理由见 DEFAULT_BASH_LIMITS） */
  maxProcesses?: number
  /** 虚拟内存上限（KB，`ulimit -v`）。⚠️ macOS 不支持（EINVAL）+ 会挡住 Node/npm ⇒ 默认不设 */
  memoryKb?: number
}

// ===== 资源上限与进程树 kill（P0-6 / P1-1）=====

/**
 * 默认资源上限。**只开"单文件大小 2 GiB"** 一项，其余按需开 —— 理由是每一项的取舍不同：
 *
 * - `maxFileSizeKb`（**默认开**）：正常开发几乎不会写单个 >2 GiB 的文件，而"把磁盘写满"是最廉价
 *   的一种破坏。默认 2 GiB。
 * - `maxProcesses`（默认不设）：`ulimit -u` 在 macOS 上**按用户计**（还把线程算进去），本机默认
 *   已经是 2666；压到 1024 之类的"安全值"会让忙碌机器上的**正常构建 fork 失败**，而症状是
 *   "莫名其妙的报错"。宁可少挡一点，也不制造无法归因的失败。
 * - `memoryKb`（默认不设）：`ulimit -v` 在 macOS 上**根本不支持**（实测 `Invalid argument`），
 *   在 Linux 上也会挡住 Node/npm（V8 预留大块虚拟内存）。
 * - `cpuSeconds`（默认不设）：`timeoutMs` 的 wall-clock 超时已经能杀，而 `-t` 会误伤长构建。
 */
export const DEFAULT_BASH_LIMITS: Required<BashLimits> = {
  cpuSeconds: 0,
  maxFileSizeKb: 2 * 1024 * 1024,
  maxProcesses: 0,
  memoryKb: 0,
}

/** 把配置解析成"四项都有值"的形态（`0` = 不限制）；`false` ⇒ 全部关掉（四项全 0）。 */
export function resolveBashLimits(cfg: BashSandboxConfig['limits']): Required<BashLimits> {
  if (cfg === false) return { cpuSeconds: 0, maxFileSizeKb: 0, maxProcesses: 0, memoryKb: 0 }
  const l = cfg ?? {}
  return {
    cpuSeconds: l.cpuSeconds ?? DEFAULT_BASH_LIMITS.cpuSeconds,
    maxFileSizeKb: l.maxFileSizeKb ?? DEFAULT_BASH_LIMITS.maxFileSizeKb,
    maxProcesses: l.maxProcesses ?? DEFAULT_BASH_LIMITS.maxProcesses,
    memoryKb: l.memoryKb ?? DEFAULT_BASH_LIMITS.memoryKb,
  }
}

/**
 * 组装 `ulimit` 抬头（P1-1）。**非 bash 族系返回空串**（原则是"不模拟"），`0` 的项不出现。
 *
 * 两个实测得来的坑（都不是想当然能对的）：
 *
 * 1. **`ulimit -f` 的单位不统一**：macOS 的 bash 是 **1 = 1024 字节**（`ulimit -f 100` ⇒
 *    `RLIMIT_FSIZE` = 102400，实测），而 Linux/POSIX 是 **1 = 512 字节块**。对外只暴露
 *    `maxFileSizeKb`，这里按平台换算 —— 不换算的话，2 GiB 的默认值在 macOS 上会缩成 2 MiB
 *    （每次写文件都超限），在 Linux 上会放大 512 倍（等于没设）。
 * 2. **每个选项各起一次 `ulimit`**，不用合并形态：合并时任一项失败会**连累其它项**。macOS 上
 *    `ulimit -v` 直接 `Invalid argument`，写成 `ulimit -t 5 -v 100 2>/dev/null` 会把 `-t`
 *    一起丢掉，而且因为 `2>/dev/null` 而毫无声音。分开写，失败只影响它自己。
 */
export function buildLimitPreamble(
  limits: Required<BashLimits> | undefined,
  family: ShellFamily,
  platform: string = process.platform,
): string {
  if (!limits || family !== 'bash') return ''
  const unitBytes = platform === 'darwin' ? 1024 : 512
  const stmts: string[] = []
  if (limits.cpuSeconds > 0) stmts.push(`ulimit -t ${Math.floor(limits.cpuSeconds)}`)
  if (limits.maxFileSizeKb > 0) stmts.push(`ulimit -f ${Math.ceil((limits.maxFileSizeKb * 1024) / unitBytes)}`)
  if (limits.maxProcesses > 0) stmts.push(`ulimit -u ${Math.floor(limits.maxProcesses)}`)
  if (limits.memoryKb > 0) stmts.push(`ulimit -v ${Math.floor(limits.memoryKb)}`)
  if (stmts.length === 0) return ''
  return stmts.map((s) => `${s} 2>/dev/null; `).join('')
}

/**
 * 杀**整棵进程树**（P0-6）。
 *
 * 为什么不能只 `child.kill()`：那只把信号发给 shell 自己。`npm run dev` / `vite` / 后台
 * `sleep &` 这类命令的**子孙进程会成为孤儿继续跑**（占端口、写文件、出网）—— 超时了而沙箱里
 * 的东西还活着，"隔离"就名存实亡。
 *
 * - POSIX：spawn 时带 `detached: true` 让子进程成为**新进程组的组长**，于是 `kill(-pid)`
 *   一次覆盖全组（含所有后代）。
 * - Windows：没有"进程组信号"，走 `taskkill /T /F`。
 * - 两者都不可用（如组已消失）⇒ 退回杀直接子进程，至少不比改造前差。
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid
  if (typeof pid === 'number' && pid > 0) {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
        return
      } catch { /* taskkill 不可用 ⇒ 退回单进程 */ }
    } else {
      try {
        process.kill(-pid, signal)
        return
      } catch { /* 组不存在 / 已退出 ⇒ 退回单进程 */ }
    }
  }
  try { child.kill(signal) } catch { /* 已退出 */ }
}

/** Shell 族系 */
type ShellFamily = 'bash' | 'powershell' | 'cmd'

/** 解析后的 shell 可执行文件与调用参数 */
interface ResolvedShell {
  /** 可执行文件路径或名称（spawn 第一参数） */
  program: string
  /** 传给可执行文件的固定参数（如 ['-c'] / ['-Command'] / ['/c']） */
  args: string[]
  /** 族系，用于决定安全策略 */
  family: ShellFamily
  /** 人类可读名称，用于输出与遥测 */
  name: string
}

/**
 * 解析当前平台下应使用的 shell。
 *
 * 策略：
 * - 非 Windows：始终用 bash（POSIX 环境）。
 * - Windows：优先 bash（Git Bash / WSL / MSYS2）；无 bash 则 PowerShell（pwsh → powershell）；
 *   最后回退 cmd.exe。
 *
 * 探测只读 PATH，避免运行时 spawn 失败再重试的延迟。
 */
/** 解析当前平台下应使用的 shell（导出供测试与外部探测复用）。 */
export function resolveShell(
  deps: { platform?: string; pathSep?: string; dirSep?: string; exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): ResolvedShell {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return { program: 'bash', args: ['-c'], family: 'bash', name: 'Bash' }
  }

  const listSep = deps.pathSep ?? ';'
  const dirSep = deps.dirSep ?? '\\'
  const joinDir = (dir: string, file: string) => (dir.endsWith(dirSep) ? dir + file : dir + dirSep + file)
  const exists = deps.exists ?? existsSync
  const pathDirs = (env.PATH ?? '').split(listSep).filter(Boolean)

  for (const dir of pathDirs) {
    for (const exe of ['bash.exe', 'bash']) {
      const candidate = joinDir(dir, exe)
      if (exists(candidate)) {
        return { program: candidate, args: ['-c'], family: 'bash', name: 'Git Bash' }
      }
    }
  }

  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    for (const dir of pathDirs) {
      const candidate = joinDir(dir, exe)
      if (exists(candidate)) {
        return {
          program: candidate,
          args: ['-Command'],
          family: 'powershell',
          name: exe === 'pwsh.exe' ? 'PowerShell Core' : 'Windows PowerShell',
        }
      }
    }
  }

  return { program: 'cmd.exe', args: ['/c'], family: 'cmd', name: 'CMD' }
}

/** 缓存进程级 shell 解析结果（同一进程内 platform/PATH 不变） */
let cachedShell: ResolvedShell | undefined
function getShell(): ResolvedShell {
  cachedShell ??= resolveShell()
  return cachedShell
}

/**
 * 危险命令被拒时的「怎么改」（P2-2）。
 *
 * ★这里必须说清**危险检测不可豁免**：它不是权限卡能放行的东西（注释见「沙箱防护 2 前置」），
 * 只写"换个写法"而不写"别指望批准"，模型就会反复请求审批、把人拖进无意义的确认循环。
 */
const DANGEROUS_HOW =
  '危险命令检测**不可豁免**（权限卡的「允许」不覆盖它）：请改写为不触发该模式的等价命令；'
  + '确实必须执行时，请让用户在自己的终端里跑（harness 不代跑破坏性命令），'
  + '或由管理员在 config.json → sandbox.dangerousDetection 调整自定义条目（默认表不可整表关闭）。'

/** 路径越界的「为什么 / 怎么改」（P2-2；read_file / write_file / edit_file 三处共用同一份） */
const OUTSIDE_CWD_WHY =
  'read_file / write_file / edit_file 只在工作目录内工作（边界经 realpath 判定，symlink 逃逸同样拦下）。'
const OUTSIDE_CWD_HOW = '工作目录外请先在会话里说明要访问哪个路径及其用途，由用户确认后再处理。'

/** cwd 越界的「为什么 / 怎么改」（P2-2；bash 与 bash_ro 两处共用同一份） */
const CWD_OUTSIDE_WHY = '沙箱根（config.json → sandbox.rootDir，缺省为工作目录）之外的路径一律不允许作为执行目录。'
const CWD_OUTSIDE_HOW =
  '不传 `cwd`（默认就在沙箱根内执行）、改写为沙箱根内的相对路径，'
  + '或确实要跨目录时由管理员调 sandbox.rootDir —— 逐条命令临时越界不在模型侧开放。'

/** 命令不在白名单内的「怎么改」（P2-2） */
const ALLOWLIST_HOW =
  '把该命令加进 config.json → sandbox.allowlist（按首命令名或完整片段匹配），'
  + '或开启 sandbox.fallbackToHost 走「人工确认后在宿主执行」（会落 sandbox.escalation 审计）。'

/** 宿主回退被拒的「怎么改」（P2-2） */
const HOST_DENIED_HOW =
  '让人在权限卡片上批准本次回退（回退会放开白名单与 env 隔离，属档位下沉），'
  + '或把命令加进 sandbox.allowlist 让它留在沙箱内执行。'

/**
 * 只读模式（`bash_ro`）各类拒绝的「怎么改」（P2-2）。
 *
 * 一处固定文案覆盖 `checkReadOnlyCommand` 的十余条 reason：那些 reason 各自说的是**具体
 * 命中了什么**（重定向 / 命令替换 / 提权 / 非白名单命令 …），而"接下来该怎么办"对它们
 * 全都一样 —— 分开写只会让十余份文案各自漂移。
 */
const READ_ONLY_HOW =
  '要写文件 / 出网 / 执行子命令，请用主 Agent 的 `bash`（有独立权限键与人工审批）；'
  + '确属只读但被误判，请改写命令避开上述特征（如把 `$(...)` 换成直接给参数）。'

/**
 * 默认危险命令正则表（命中即拒绝执行）。
 *
 * 导出是**为单测**（与 `checkReadOnlyCommand` / `resolveShell` 同风格）：判定口径要能被逐条钉住，
 * 而"跑一条真命令看是否被拒"既慢又依赖平台。
 */
export const DEFAULT_DANGEROUS_PATTERNS: RegExp[] = [
  /\(\)\s*\{[^{}]*\|[^{}]*\}/, // fork bomb（函数体启动即时递归 fork）
  /\brm\s+(?:-[a-z]*f[a-z]*\s+)*\/\s*(?:\*|$|--)/m, // rm -rf / 或 rm -rf /*
  // `~\s` 曾要求波浪号后必须有空白 —— `rm -rf ~`（行尾无空白）在原文上直接漏过。
  // AST 归一化路径同样受此影响（normalized 行尾也没有空白），故锚点改为 `~(?:\s|$)`。
  /\brm\s+(-[a-z]*f[a-z]*\s*)*~(?:\s|$)/m, // rm -rf ~
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
  // ⚠️ 2026-10-12 实测：原正则 `/format\s+\/\s*\/s\s*\/f\/q/i` **匹配不到目标串** ——
  // `format /s /f /q` 里 `/f` 与 `/q` 之间有空格，而它要求 `/f/q` 紧邻。也就是说这条从落地起
  // 就一直是死的（典型的"写了但没生效"）。改为按**危险开关**判定：`/q` = 快速格式化。
  /\bformat\s+(?=[^|;&\n]*\/q\b)/i, // Windows format <盘> /q（快速格式化）
  // ---- Windows 原生破坏形态（P0-1，2026-10-12）----
  // 判据：**递归/强制语义**才拦 —— `del /q foo.txt` 这类单文件删除是正常用法，拦了会大面积误伤。
  // 每条都用 `[^|;&\n]*` 限定在同一段内，与既有 `shred|wipefs|…` 那条同一纪律：
  // 不限定会让"只是提到它"（如 `echo del /s`）也被判危险。
  /\b(?:del|erase)\s+[^|;&\n]*\/s\b/i, // del /f /s /q <dir>（/s = 连子目录一起删）
  /\b(?:rd|rmdir)\s+[^|;&\n]*\/s\b/i, // rd /s /q <dir>
  /\bRemove-Item\b[^|;&\n]*-Recurse\b/i, // PowerShell Remove-Item -Recurse -Force
  /\b(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, // 磁盘/分区级操作
  /\b(?:Stop-Computer|Restart-Computer)\b/i, // 关机/重启（PowerShell 形态）
  /\breg\s+delete\s+(?:HKLM|HKEY_LOCAL_MACHINE|HKCR|HKEY_CLASSES_ROOT|HKU\b|HKEY_USERS)/i, // 系统级注册表
  /\bbcdedit\b/i, // 改引导配置（可能直接让机器起不来）
  /\bvssadmin\s+delete\s+shadows\b/i, // 删卷影副本（勒索软件标志动作，同时毁掉回滚能力）
  /\b(?:takeown|icacls)\b[^|;&\n]*\/t\b/i, // 递归改属主/权限（/t = 递归）
  // 注：曾有一条 `>\s*\/dev\/null\b|\/dev\/sda`，已删除 ——
  // - `>/dev/null` / `2>/dev/null` 是最常见的**无害**重定向（丢弃输出），把它判为危险会
  //   大面积误伤正常命令（实测：`git rev-parse --is-inside-work-tree 2>/dev/null` 直接被拒）；
  // - 裸 `/dev/sda` 字面量本身**不能**无差别保留：它会连 `fdisk -l /dev/sda`（只读查看）一起拒。
  //   改为上面两条更精确的规则兜底（重定向写盘 + 破坏性命令写盘），覆盖面不降、误伤更小。
  /\bcurl\b[^|;]*\|\s*(bash|sh)\b|\bwget\b[^|;]*\|\s*(bash|sh)\b/, // curl|bash
  /\bchmod\s+-R\s+777\s+\//, // 递归改根目录权限
  /\bsudo\s+rm\s+-rf\s+(\/|\*)/, // sudo rm -rf /
]

/**
 * 默认敏感环境变量名（隔离时从继承环境移除）。
 *
 * P2-3（2026-10-12）三处修正，都来自"Windows 上键名大小写不固定"这条事实：
 * ① **全部加 `/i`** —— 原来六条里只有两条有，于是 `github_token` / `Github_Token` 这类
 *    真实存在的写法**直接漏过**（Windows 的环境变量名大小写不敏感，用户/工具写哪种都有）；
 * ② 补**后缀型与专用名**：上面按子串枚举漏掉了 `NPM_TOKEN` / `SLACK_TOKEN` / `SENTRY_DSN` …
 *    这类"不以已知前缀开头、也不含已枚举子串"的名字；
 * ③ 反之，`USERPROFILE` / `APPDATA` / `LOCALAPPDATA` / `TEMP` / `TMP` **刻意不进表** ——
 *    它们是**路径**不是凭据，摘掉会让依赖它们的命令直接坏掉（Windows 上尤其明显）。
 *    这条纪律由用例钉住（见 `tools-builtin.test.ts` 的 P2-3 组）。
 */
export const DEFAULT_SENSITIVE_ENV = [
  /AWS_ACCESS_KEY|AWS_SECRET|AWS_SESSION_TOKEN/i,
  /GITHUB_TOKEN|GITLAB_TOKEN|GH_TOKEN/i,
  /OPENAI|ANTHROPIC|DEEPSEEK|GOOGLE|AZURE|BEDROCK|GEMINI|MISTRAL|COHERE/i,
  /API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN/i,
  /PASSWORD|PASSWD|CREDENTIAL/i,
  /PRIVATE_KEY|PEM\b/i,
  // 后缀型（`*_KEY` / `*_TOKEN` / `KEY`）—— 用 `(?:^|_)` 与 `(?:_|$)` 夹住，
  // 免得 `MONKEY` / `KEYBOARD` 这类**结尾或开头含 KEY** 的普通名被误摘。
  /(?:^|_)TOKEN(?:_|$)|(?:^|_)KEY(?:_|$)/i,
  // 专用名（不以已知前缀开头，也不含上面任何子串）
  /NPM_TOKEN|PYPI_TOKEN|NUGET_API_KEY|SLACK_TOKEN|DISCORD_TOKEN|TELEGRAM_TOKEN/i,
  // ⚠️ 这里**不能**写 `\bDSN\b`：`_` 属于词字符，`SENTRY_DSN` 里的 `DSN` 前一个字符是 `_`
  // ⇒ 形不成词边界，规则等于没写（实测踩过）。`DSN` 作为子串极少出现在非凭据名里，直接匹配。
  /DATABASE_URL|CONNECTION_STRING|DSN|MONGO_URL|REDIS_URL|AMQP_URL/i,
]

/** 危险命令检测：返回命中的模式描述，未命中返回 null */
function detectDangerous(command: string, patterns: RegExp[]): RegExp | null {
  for (const re of patterns) {
    if (re.test(command)) return re
  }
  return null
}

/**
 * AST 层危险判定（在解码字面量上重跑危险表 + 间接执行结构判定）。
 *
 * 为什么需要：原始正则对 `"r"m -rf /`、`'rm' -rf /` 这类**引号混淆**天然失明
 * （字面上没有 `rm`），对 `R=rm; $R -rf /` 更是完全不可见（命令名在运行期才确定）。
 * bash-ast 把引号/转义解码回运行期字面量、把展开标成 opaque，这里据此补两刀：
 *   1. 任何命令的命令名含展开 → 拒（间接执行不可审计，fail-closed；
 *      代价：`$(which docker) ps` 这类写法也被拒 —— 提示改用直接路径）；
 *   2. 在**归一化文本**（全部命令解码拼接，展开处 OPAQUE 占位）上重跑危险表。
 * 返回命中的描述（进错误消息），未命中 null。wasm 不可用（facts=null）或语法
 * 有错（ok=false）时返回 null —— 调用方回落原始正则的结果，绝不因此放行。
 */
function detectAstDangerous(facts: BashCommandFacts, patterns: RegExp[]): string | null {
  for (const cmd of facts.commands) {
    // 放行例外：命令名展开仅为 `$(which x)` / `$(command -v x)` / `$(type -P x)`
    // 路径解析惯用法（替换体已审计为纯字面量）—— 其余展开一律 fail-closed
    if (cmd.nameOpaque && !cmd.namePathResolution) {
      return `命令名含变量/命令替换展开，间接执行不可审计：「${cmd.raw}」`
    }
  }
  for (const re of patterns) {
    if (re.test(facts.normalized)) return `解码引号/转义后命中危险模式 ${re}`
  }
  return null
}

/** 环境隔离：过滤掉敏感变量，保留必要与 keepEnv 指定的变量（导出为单测，见 P2-3） */
export function sanitizeEnv(env: NodeJS.ProcessEnv, keepEnv: string[]): Record<string, string> {
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

/**
 * 从命令提取**首个命令名**（用于白名单匹配与只读判定）。
 *
 * P0-3（2026-10-12）：三种形态都要取对 ——
 * ① POSIX：`VAR=x sudo rm -rf` ⇒ `rm`（前缀赋值 / `sudo` / `env` 都跳过）；
 * ② **PowerShell 调用运算符**：`& 'C:\\Program Files\\x.exe' -x` ⇒ `C:\\Program Files\\x.exe`
 *    —— `&` 是调用运算符**不是分隔符**，而且这种形态的命令**几乎总被引号包住**，
 *    原实现会把引号一起返回（`'C:\\...x.exe'`），于是永远匹配不上白名单里写的字面量；
 * ③ CMD：分段后段首残留的 `&` 同样跳过（`cmd1 & cmd2` 的第二段）。
 */
export function extractFirstCommand(command: string): string {
  // 前导分隔符（**不含 `&`** —— 它可能是调用运算符）
  let s = command.trim().replace(/^[;|\s]+/, '')
  // 段首 `&`：PS 调用运算符 / CMD 串联残留 —— 两种情况下后面才是真命令
  s = s.replace(/^&\s*/, '')
  // 跳过前缀赋值（`VAR=x cmd`）与 `sudo` / `env` 前缀 —— **三者要能交替重复**：
  // `env FOO=1 BAR=2 ls` 里 `env` 之后还有赋值，只吃一种会把 `FOO=1` 当成命令名。
  const m = s.match(/^(?:(?:[A-Za-z_]\w*=[^\s]*|sudo|env)\s+)*(.+)$/)
  const head = (m ? m[1]! : s).trim()
  const token = head.match(/^("[^"]*"|'[^']*'|[^\s|;&<>]+)/)?.[1] ?? ''
  return unquoteOnce(token)
}

/** 去掉**一层**包裹引号（白名单里写的是不含引号的字面量，而 PS 常常写带引号的路径） */
function unquoteOnce(s: string): string {
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1)
  }
  return s
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
  /**
   * 本次执行的**边界自述**（P1-4 / P2-3）。
   *
   * 存在的理由与 `env-context` 注入 `Shell:` 同源：模型不知道自己的边界，就会反复撞
   * 同一面墙（"为什么 curl 被拒"）。四个字段都只说**事实**，不含建议：
   * - `level`：本次生效的隔离档位；
   * - `fsBound`：是否真的把文件系统限住了（L2 起才为 true）；
   * - `netPolicy`：网络出口策略；
   * - `viaHost`：这次是不是**升到宿主全权**执行的（与 `viaHost` 字段同值，放这里是为了
   *   让"我到底在什么边界里"一次看全）。
   */
  isolation?: {
    level: IsolationLevel
    fsBound: boolean
    netPolicy: NetPolicy
    viaHost: boolean
    /** P1-3：**递了绑定但内核拒了 apply**（嵌套沙箱）。`fsBound` 此时为 false */
    fsBoundFailed?: true
  }
  /** 实际执行命令的 shell 名称（跨平台回退时用于告知模型） */
  shell?: string
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
  // P1-1：资源上限（仅 bash 族系生效，见 buildLimitPreamble）
  const limits = resolveBashLimits(config.limits)
  // P1-2：网络出口策略（缺省 open = 与改造前逐位一致）
  const net = resolveNetPolicy({ net: config.net, netAllow: config.netAllow })
  // P1-4：本次执行所处的档位（宿主注入；缺省 L1 = 本工具自身能兑现的下限）
  // P1-3：OS 绑定（宿主构造并自检通过后递入）。`fsBound` 说**这次真的绑上了没有**，
  // 而不是"档位叫 L2 所以算绑上了" —— 后者正是"看起来隔离了"。
  const osBinding = config.osBinding ?? null
  const isolation = {
    level: config.isolationLevel ?? ('L1' as IsolationLevel),
    netPolicy: net.mode,
    fsBound: osBinding != null,
  }

  const shell = getShell()

  return defineTool<BashInput, BashOutput>({
    id: 'bash',
    description:
      '执行 shell 命令（沙箱受限）。支持超时、工作目录和环境变量。返回 stdout/stderr/exitCode。'
      + (shell.family === 'bash'
        ? ''
        : ` 当前环境未检测到 bash，实际使用 ${shell.name} 执行命令；配置的白名单与只读语义仅适用于 bash。`),
    documentation: bashDoc.trim(),
    inputSchema: bashInputSchema,
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false,
    permission: {
      key: 'bash',
      extractPatterns: (input) => [input.command],
      // 段级 deny（2026-09-30）：权限引擎的 allow/ask 是任一 pattern 命中即生效，
      // 段级 pattern 绝不能混进 patterns（会放宽 allow）；deny 是任一命中即拒绝，
      // 收紧无害 —— 让 `deny: ['shutdown*']` 能拦住 `echo hi; shutdown -h now` 这类
      // 「恶意段藏在全串中」的形态。切段用引号感知的 splitSegments（与 bash_ro 同源）。
      extractDenyPatterns: (input) => splitSegments(input.command),
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
      // 两层：先对原始文本跑危险正则（历史行为，错误消息引用原文命中）；
      // 再跑 AST 层（decode 后重跑危险表 + 间接执行判定，见 detectAstDangerous）。
      // AST 层是**增强**而非替代：wasm 不可用/语法错误时回落原始正则结果。
      if (dangerousPatterns.length > 0) {
        const hit = detectDangerous(input.command, dangerousPatterns)
        if (!hit) {
          const facts = await analyzeBashCommand(input.command)
          if (facts?.ok) {
            const astHit = detectAstDangerous(facts, dangerousPatterns)
            if (astHit) {
              return {
                ok: false,
                error: {
                  message: formatDenial({
                    what: '命令被沙箱判定为危险，已拒绝执行',
                    why: `命中危险模式：${astHit}`,
                    how: DANGEROUS_HOW,
                  }),
                  code: 'SANDBOX_DANGEROUS',
                },
              }
            }
          }
        } else {
          return {
            ok: false,
            error: {
              message: formatDenial({
                what: '命令被沙箱判定为危险，已拒绝执行',
                why: `命中危险模式：${hit}`,
                how: DANGEROUS_HOW,
              }),
              code: 'SANDBOX_DANGEROUS',
            },
          }
        }
      }

      // ---- 沙箱防护 5：网络出口策略（P1-2）----
      // L0 **静态门**（不是内核边界）：`net: 'deny'` 拒掉一切名字即意图的出网客户端，
      // `'allowlist'` 只放行目标在白名单内的那些，且元数据/私有地址一律硬拒。
      // 用 AST 的命令表（比正则准），拿不到时退文本兜底 —— 与上面危险检测同一条降级纪律。
      if (net.mode !== 'open') {
        const netFacts = await analyzeBashCommand(input.command)
        const verdict = assessNetAccess(
          netFacts?.ok
            ? {
              commands: netFacts.commands.map((c) => c.name),
              args: netFacts.commands.flatMap((c) => c.args.map((a) => a.text).filter((t): t is string => t !== null)),
              astAvailable: true,
            }
            : { raw: input.command, astAvailable: false },
          net,
        )
        if (!verdict.ok) {
          return {
            ok: false,
            error: {
              message: formatDenial({ what: '网络出口策略拒绝执行', why: verdict.why, how: verdict.how }),
              code: 'SANDBOX_NET_DENIED',
            },
          }
        }
      }

      // ---- 沙箱防护 1：cwd 限制（防路径逃逸；回退到宿主同样不允许逃逸工作区根） ----
      const requestedCwd = input.cwd ? resolvePath(input.cwd, ctx.cwd) : null
      if (requestedCwd && !isWithinCwd(requestedCwd, rootDir)) {
        return {
          ok: false,
          error: {
            message: formatDenial({ what: `cwd 超出沙箱根目录，已拒绝：${input.cwd}`, why: CWD_OUTSIDE_WHY, how: CWD_OUTSIDE_HOW }),
            code: 'SANDBOX_CWD',
          },
        }
      }

      const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT
      const cwd = requestedCwd ?? rootDir

      // ---- 沙箱防护 4：env 隔离（过滤敏感变量） ----
      const inherited = config.sanitizeEnv === false ? process.env : sanitizeEnv(process.env, keepEnv)
      const sandboxEnv = { ...inherited, ...(input.env ?? {}) }

      // ---- 沙箱防护 3：命令白名单 ----
      // 匹配语义（2026-09-30 修复）：allowlist 条目是「首命令名」或「完整命令片段」。
      // 历史缺陷：旧判据含 `input.command.includes(a)` —— 子串命中即放行，等于白名单形同虚设：
      //   allowlist=['git'] 时 `echo git && rm -rf /`（命令任意位置含 'git'）直接过闸。
      // 现在只认两种形态：
      //   1) 首命令名精确等于条目（含跳过前缀赋值后的首命令，extractFirstCommand）；
      //   2) 整串以条目开头且条目后是空白/结尾（真「片段」）—— `github` 不会命中 `git`。
      // 跨平台：白名单条目是按 bash 首命令名写的；在 PowerShell / CMD 下语义不匹配，
      // 若强行匹配会大面积误伤（如 `ls` 在 PS 中实际解析为 Get-ChildItem）。因此非 bash
      // 族系下禁用 allowlist，改为在执行结果里附加降级提示。
      const allowlistActive = allowlist && allowlist.length > 0 && shell.family === 'bash'
      let firstCmd = ''
      if (allowlistActive) {
        firstCmd = extractFirstCommand(input.command)
        const trimmedCommand = input.command.trim()
        const allowlisted = allowlist.some((a) => {
          if (firstCmd === a) return true
          if (!trimmedCommand.startsWith(a)) return false
          const next = trimmedCommand[a.length]
          return next === undefined || /\s/.test(next)
        })
        if (!allowlisted) {
          // 白名单拦截但允许宿主回退：非破坏性命令提升到宿主 bash 执行
          if (config.fallbackToHost) {
            const confirmed = await confirmHostRun(input, ctx, config)
            if (!confirmed) {
              return {
                ok: false,
                error: {
                  message: formatDenial({
                    what: `命令不在沙箱白名单内，宿主回退被拒绝：${firstCmd}`,
                    why: '回退到宿主属档位下沉（放开白名单 + env 隔离），未获批准即拒绝。',
                    how: HOST_DENIED_HOW,
                  }),
                  code: 'SANDBOX_HOST_DENIED',
                },
              }
            }
            return runBash({ command: input.command, cwd, env: { ...process.env, ...(input.env ?? {}) }, timeoutMs, signal: ctx.signal, viaHost: true, limits, isolation })
          }
          return {
            ok: false,
            error: {
              message: formatDenial({
                what: `命令不在沙箱白名单内，已拒绝：${firstCmd}`,
                why: `当前白名单：${allowlist.join(' / ')}；只匹配首命令名或完整片段。`,
                how: ALLOWLIST_HOW,
              }),
              code: 'SANDBOX_ALLOWLIST',
            },
          }
        }
      }

      // ---- 沙箱内执行 ----
      const sandboxResult = await runBash({
        command: input.command, cwd, env: sandboxEnv, timeoutMs, signal: ctx.signal, limits, isolation,
        osBinding,
      })

      // ---- 回退兜底：非破坏性命令在沙箱内未按预期执行（spawn 失败 / env 隔离开致命令非零退出）时提升到宿主 bash ----
      if (!sandboxResult.interrupted && sandboxResult.output?.exitCode !== 0 && config.fallbackToHost) {
        const confirmed = await confirmHostRun(input, ctx, config)
        if (!confirmed) {
          return {
            ok: false,
            error: {
              message: formatDenial({
                what: '命令在沙箱内执行失败，宿主回退被拒绝',
                why: '回退到宿主属档位下沉（放开白名单 + env 隔离），未获批准即拒绝。',
                how: HOST_DENIED_HOW,
              }),
              code: 'SANDBOX_HOST_DENIED',
            },
          }
        }
        return runBash({ command: input.command, cwd, env: { ...process.env, ...(input.env ?? {}) }, timeoutMs, signal: ctx.signal, viaHost: true, limits, isolation })
      }

      // 非 bash 环境：给模型一个可见提示，避免它把 exit 127/命令未找到误判为命令本身问题。
      if (shell.family !== 'bash' && sandboxResult.ok && sandboxResult.output) {
        const warn = `[harness] 当前由 ${shell.name} 执行命令；bash 专用白名单/只读语义未生效。`
        return {
          ok: true,
          output: {
            ...sandboxResult.output,
            stderr: sandboxResult.output.stderr ? `${sandboxResult.output.stderr}\n${warn}` : warn,
          },
        }
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
 *
 * P0-7：请求带 `escalation: 'host-fallback'` ⇒ 权限引擎**无条件**落一条
 * `sandbox.escalation` 审计（含 `allow-all` 下没问人的那次）。`patterns` 里的 `host:`
 * 前缀是给人看的展示约定，**判据不靠它** —— 见 `PermissionRequest.escalation` 的说明。
 * `requireHostApproval === false` 是显式的"不要问"，那条路径无请求可记，改由
 * `checkSandboxConfig()` 在装配期报警（见 `host/src/config.ts`）。
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
    escalation: 'host-fallback',
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
  // 判据是"有没有指向真实文件的 `>`"：指向 /dev/null 的丢弃型重定向已由 stripNullSink 摘掉
  { re: />>?/, code: 'SANDBOX_RO_REDIRECT', why: '输出重定向（> / >>）会写文件（丢弃到 /dev/null 的除外）' },
  { re: /<\(|>\(/, code: 'SANDBOX_RO_SUBST', why: '进程替换（<() / >()）会执行子命令' },
  { re: /<</, code: 'SANDBOX_RO_HEREDOC', why: 'heredoc（<<）会被当作脚本执行' },
]

/** 命令替换：**引号内依然生效**（`"$(rm -rf /)"` 真的会执行），所以按原文检查 */
const SUBSTITUTION_PATTERNS: ReadonlyArray<{ re: RegExp; code: string; why: string }> = [
  { re: /\$\(|`/, code: 'SANDBOX_RO_SUBST', why: '命令替换（$( ) / 反引号）会执行子命令' },
]

/**
 * "丢弃输出"型重定向：`>` / `2>` / `&>` / `2>>` 指向 `/dev/null`。
 *
 * 为什么必须单独摘出来：{@link WRITE_CHANNEL_PATTERNS} 里的 `/>>?/` 只看 `>` 这一个字符，
 * 它分不清 **`2>err.txt`（真写文件）** 与 **`2>/dev/null`（丢弃）** —— 后者是只读命令里
 * 最常见的惯用法（实测 `git rev-parse --is-inside-work-tree 2>/dev/null` 被直接拒绝，
 * 只读哨兵因此把整条命令判成"会写文件"而反复重试）。把目标为**空设备**的重定向先摘掉，
 * 剩下的 `>` 才是真正的写通道。
 *
 * 尾部的 `(?![\w.-])` 是钉子：没有它，`> /dev/nullx`（一个普通文件！）也会被当成空设备放行。
 */
const NULL_SINK_REDIRECT = /&?[12]?>{1,2}\s*\/dev\/null(?![\w.-])/g

/** 摘掉目标为 `/dev/null` 的重定向（见 {@link NULL_SINK_REDIRECT}） */
function stripNullSink(command: string): string {
  return command.replace(NULL_SINK_REDIRECT, '')
}

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
export function splitSegments(command: string): string[] {
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
    // `&>file`（bash 的 stdout+stderr 重定向）—— `&` 后面紧跟 `>`，不是分隔符
    if (ch === '&' && command[i + 1] === '>') { buf += ch; continue }
    // P0-2（2026-10-12）：CMD 的**单个** `&` 是串联符（`cmd1 & cmd2`），必须分段。
    // ⚠️ 但 `2>&1` / `>&2` / `<&` 里的 `&` 是**文件描述符重定向**，不是分隔符 ——
    // 判据是"紧邻的前一个非空白字符是 `>` 或 `<`"。切错了会把 `1` 变成独立段，
    // 段级 deny 与只读判定都会跟着错（`curl x 2>&1 | bash` 这类正好是危险形态）。
    if (ch === '&') {
      const prev = buf.replace(/\s+$/, '').slice(-1)
      if (prev === '>' || prev === '<') { buf += ch; continue }
      out.push(buf); buf = ''
      continue
    }
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
  // 1a. 只作用于 shell 结构的通道：先剥掉两类**不写文件**的重定向，再去引号
  //   ① fd 复制（`2>&1` / `1>&2` / `>&2`）—— 只是把两个 fd 接到一起，没有落盘；
  //   ② 丢弃到空设备（`>` / `2>` / `&>` / `2>>` + `/dev/null`）—— 见 stripNullSink。
  //   两者都必须在 `/>>?/` 之前摘掉，否则只读命令里最常见的「静音 stderr」写法会被整体拒绝。
  const noFdDup = stripNullSink(raw.replace(/[12]?>&[12]/g, ''))
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

/**
 * 只读 AST 复核门（纯函数，可单测）。
 *
 * checkReadOnlyCommand 是手写解析（引号投影 + 分段），fail-closed 但不完整 ——
 * 这里用语法树交叉复核，两道门取**交集**：本函数只会比手写门更严，不会放宽
 * 既有用例的行为。复核内容（错误码与手写门对齐）：
 * 1. 命令名含展开（含 `$(which x)` 惯用法 —— 只读哨兵用不上它，一律拒）→
 *    `SANDBOX_RO_ALLOWLIST`（间接执行对只读哨兵同样不可审计）；
 * 2. 全部命令（含替换体内的嵌套命令）的**解码后**命令名必须仍在白名单内 ——
 *    手写门的分段基于去引号投影，语法树看到的是 bash 真正会执行的那条命令序列。
 *
 * @param facts   {@link analyzeBashCommand} 的产物（仅接受 ok=true 的 facts）
 * @param allowlist 只读命令白名单（与 checkReadOnlyCommand 同一份）
 */
export function checkReadOnlyByAst(
  facts: BashCommandFacts,
  allowlist: readonly string[] = DEFAULT_READONLY_COMMANDS,
): ReadOnlyVerdict {
  for (const cmd of facts.commands) {
    if (cmd.nameOpaque) {
      return {
        ok: false,
        code: 'SANDBOX_RO_ALLOWLIST',
        reason: `只读模式拒绝：命令名含变量/命令替换展开，间接执行不可审计（「${cmd.raw}」）。`,
      }
    }
    if (cmd.name !== null && !allowlist.includes(cmd.name)) {
      return {
        ok: false,
        code: 'SANDBOX_RO_ALLOWLIST',
        reason:
          `只读模式拒绝：「${cmd.name}」不在只读命令白名单内。`
          + '允许的命令见工具说明；需要写/联网/构建请让主 Agent 用 bash。',
      }
    }
    // git 子命令白名单（与手写门同一份表）：`git` 在白名单内但 `git push` 是写操作。
    // 旗标带值（-C <dir> 等）跳过，取首个非旗标词为子命令 —— 与 checkReadOnlyCommand 同判据。
    if (cmd.name === 'git') {
      const decoded = cmd.args.map((a) => a.text).filter((t): t is string => t !== null)
      const cleaned: string[] = []
      for (let i = 0; i < decoded.length; i++) {
        const a = decoded[i]!
        if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '-c') { i++; continue }
        if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) continue
        cleaned.push(a)
      }
      const sub = cleaned.find((t) => !t.startsWith('-'))
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
  /**
   * 资源上限（P1-1）。只读**不等于**资源安全：白名单里有 `python3 -c` / `find`，一样能跑飞。
   * 默认同 {@link DEFAULT_BASH_LIMITS}。
   */
  limits?: BashLimits | false
  /**
   * 读侧敏感文件策略（P0-3）。缺省用内置清单（`cat .env` / `head .ssh/id_rsa` 这类被拒）；
   * `false` 关闭；给对象则**替换**内置清单。
   */
  readDeny?: SensitiveReadPolicyInput
  /**
   * 本次执行实际所处的隔离档位（P1-4），宿主装配期解析后注入。缺省 `'L1'`。
   * `bash_ro` 只做只读判定，网络不适用（白名单里本就没有出网命令），故不下发 netPolicy。
   */
  isolationLevel?: IsolationLevel
  /** OS 级绑定（P1-3）。只读工具**同样套**：只读判定是策略层，它挡不住 symlink 逃逸写 */
  osBinding?: OsBinding | null
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
  const limits = resolveBashLimits(config.limits)
  const osBinding = config.osBinding ?? null
  const isolation = {
    level: config.isolationLevel ?? ('L1' as IsolationLevel),
    netPolicy: 'open' as NetPolicy,
    fsBound: osBinding != null,
  }
  const readDeny = resolveSensitiveReadPolicy(config.readDeny)
  const shell = getShell()

  return defineTool<ReadOnlyBashInput, BashOutput>({
    id: 'bash_ro',
    description:
      '执行**只读** shell 命令（白名单受限：cat/head/tail/wc/grep/sed/awk/find/ls/stat/du/git log/python3 -c 等）。'
      + '拒绝重定向、命令替换、提权与任何写操作。用于统计、检索、结构化盘点；要写文件请用主 Agent 的 bash。'
      + (shell.family === 'bash'
        ? ''
        : ` 当前环境未检测到 bash，只读哨兵无法保证语义（实际使用 ${shell.name}），请安装 Git Bash / WSL 以启用 bash_ro。`),
    inputSchema: fromJsonSchema<ReadOnlyBashInput>({
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的只读命令（不得含重定向、$()、反引号、heredoc；`2>/dev/null` 这类丢弃输出除外）' },
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
      // 段级 deny：与 bash 同理（只进 deny 判定，不碰 allow/ask 语义）
      extractDenyPatterns: (input) => splitSegments(input.command),
    },
    async call(input, ctx): Promise<ToolResult<BashOutput>> {
      if (shell.family !== 'bash') {
        return {
          ok: false,
          error: {
            message: formatDenial({
              what: `只读 shell 需要 bash；当前环境为 ${shell.name}`,
              why: '只读白名单是按 bash 语义写的，其它 shell 下同样的命令名可能是别的东西（误判与漏判同时发生）。',
              how: '请在 Windows 上安装 Git Bash / WSL / MSYS2 后重试；急用时改用 bash（有独立权限键与审批）。',
            }),
            code: 'SANDBOX_RO_NO_BASH',
          },
        }
      }
      const verdict = checkReadOnlyCommand(input?.command, allowlist)
      if (!verdict.ok) {
        // P2-2：`verdict.reason` 说的是**具体命中了什么**，统一在这一处补「怎么改」
        return { ok: false, error: { message: formatDenial({ what: verdict.reason, how: READ_ONLY_HOW }), code: verdict.code } }
      }
      // AST 复核门（2026-09-30）：手写解析门之上再过一道语法树复核（见 checkReadOnlyByAst）。
      // facts 为 null / ok=false（wasm 不可用 / 语法错误）时跳过 —— 手写门已放行的行为不变，
      // 不因 AST 层缺失而拒绝；语法错误本身 bash 也会报错，无额外风险。
      const facts = await analyzeBashCommand(input.command)
      if (facts?.ok) {
        const astVerdict = checkReadOnlyByAst(facts, allowlist)
        if (!astVerdict.ok) {
          return { ok: false, error: { message: formatDenial({ what: astVerdict.reason, how: READ_ONLY_HOW }), code: astVerdict.code } }
        }
        // 读侧敏感文件（P0-3）：只读工具**不是“什么都能读”**。
        // `cat .env` / `head .ssh/id_rsa` 完全在白名单内，所以这道闸必须在只读判定**之外**。
        // 判据落在**参数里的路径字面量**上（与 read_file 同一份策略）；`facts?.ok` 不成立时
        // （wasm 不可用 / 语法错误）本闸与上面的 AST 门**同时失效** —— 口径一致，不假装摸到了。
        if (readDeny) {
          const operands: string[] = []
          for (const cmd of facts.commands) {
            for (const a of cmd.args) if (a.text !== null) operands.push(a.text)
          }
          const hit = findSensitiveReadPath(operands, readDeny)
          if (hit !== undefined) {
            return {
              ok: false,
              error: {
                message: formatDenial({
                  what: `只读模式拒绝：命令引用了敏感文件「${hit}」`,
                  why: '沙箱默认拒读凭据类文件（.env / id_rsa* / *.pem / .ssh/** / .aws/** 等）。',
                  how: '确实需要读，让用户确认后用 bash（有独立的权限键与审批），'
                    + '或把该形态从 config.json → sandbox.readDeny 里去掉。',
                }),
                code: 'SANDBOX_READ_DENIED',
              },
            }
          }
        }
      }
      const rootDir = config.rootDir ? resolvePath(config.rootDir, ctx.cwd) : ctx.cwd
      const requestedCwd = input.cwd ? resolvePath(input.cwd, ctx.cwd) : null
      if (requestedCwd && !isWithinCwd(requestedCwd, rootDir)) {
        return {
          ok: false,
          error: {
            message: formatDenial({ what: `cwd 超出沙箱根目录，已拒绝：${input.cwd}`, why: CWD_OUTSIDE_WHY, how: CWD_OUTSIDE_HOW }),
            code: 'SANDBOX_CWD',
          },
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
        limits,
        isolation,
        osBinding,
      })
      return result
    },
  })
}

/** 默认只读 bash 工具（只读哨兵用） */
export const readOnlyBashTool: Tool<ReadOnlyBashInput, BashOutput> = createReadOnlyBashTool()

/** 执行一条 shell 命令并采集 stdout/stderr/退出码。支持超时 kill 与 AbortSignal 中断。
 * viaHost=true 时在返回的 BashOutput 上标注，表示这次是宿主 bash 回退执行（放开白名单与 env 隔离）。
 */
function runBash(opts: {  command: string
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs: number
  signal?: AbortSignal
  viaHost?: boolean
  shell?: ResolvedShell
  /**
   * 资源上限（P1-1）。⚠️ `viaHost` 时**不套**（宿主回退＝宿主全权，与放开白名单/env 隔离
   * 同口径）—— 这条路径的权限放大已由 `sandbox.escalation` 审计记下（见 P0-7）。
   */
  limits?: Required<BashLimits>
  /** 本次执行的边界自述（P1-4 / P2-3）；缺省不上报该字段 */
  isolation?: { level: IsolationLevel; netPolicy: NetPolicy; fsBound?: boolean }
  /**
   * OS 绑定（P1-3 / L2）。⚠️ `viaHost` 时**不套**（宿主回退＝宿主全权，与放开白名单 /
   * env 隔离 / 资源上限同口径 —— 这条路径的权限放大已由 `sandbox.escalation` 审计记下）。
   */
  osBinding?: OsBinding | null
}): Promise<ToolResult<BashOutput>> {
  const sh = opts.shell ?? getShell()
  const startedAt = Date.now()
  // P1-1：ulimit 抬头只加在**真正要发出去的**命令上；`output.command` 仍是原文（遥测/展示不被污染）。
  const command = opts.viaHost ? opts.command : `${buildLimitPreamble(opts.limits, sh.family)}${opts.command}`
  // P1-3：绑定是 **argv 前缀**（`sandbox-exec -p <profile>` / `bwrap --ro-bind …`），被包装的
  // shell program 落到 prefix 之后 —— 不做字符串拼接（命令文本已经过一次拼接，再叠必错）。
  const prefix = opts.viaHost ? [] : (opts.osBinding?.prefix ?? [])
  const [program, ...preArgs] = prefix.length > 0 ? prefix : [sh.program]
  const argv = prefix.length > 0 ? [...preArgs, sh.program, ...sh.args, command] : [...sh.args, command]
  return new Promise((resolvePromise) => {
    const child = spawn(program, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // P0-6：让子进程成为新进程组的组长 ⇒ 超时/中断时 `kill(-pid)` 一次覆盖整棵树。
      // 不影响终端 Ctrl-C —— CLI 的中断走 AbortController（repl 的 SIGINT / TUI 的 Ctrl-C
      // 都调 `activeAbort.current.abort()`，再经 ctx.signal 传到下面那个 abort 监听）。
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true
        killProcessTree(child)
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
          ...(opts.isolation ? {
            isolation: {
              level: opts.isolation.level,
              // P1-3：**这次真的绑上了没有**（不是"档位叫 L2 就算"）—— 宿主回退 / 无原语
              // / 自检失败 / **内核把 apply 拒了**（嵌套沙箱）四种形态下都是 false，
              // 模型读到的是事实而不是愿望。
              fsBound: (opts.isolation.fsBound ?? isOsBound(opts.isolation.level))
                && !detectOsBindingFailure(stderr),
              // 绑了但被内核拒 ⇒ 显式标注（否则 stderr 里那句 sandbox_apply 会被当成命令自身的报错）
              ...((opts.isolation.fsBound && detectOsBindingFailure(stderr))
                ? { fsBoundFailed: true as const } : {}),
              netPolicy: opts.isolation.netPolicy,
              viaHost: opts.viaHost === true,
            },
          } : {}),
          shell: sh.name,
        },
      })
    })

    if (opts.signal) {
      if (opts.signal.aborted) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          killProcessTree(child)
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
            killProcessTree(child)
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
        message: formatDenial({
          what: `路径 "${input.path}" 超出工作目录范围（工作目录：${ctx.cwd}）`,
          why: OUTSIDE_CWD_WHY,
          how: OUTSIDE_CWD_HOW,
        }),
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
  /**
   * 读侧敏感文件策略（P0-3），同时作用于 `read_file` 与 `bash_ro`（两者共用同一份判据）。
   * 缺省 = 内置清单；`false` = 关闭；给对象 = 替换。见 {@link createReadFileTool}。
   */
  readDeny?: SensitiveReadPolicyInput
  /**
   * `read_file` 单次可读的文件**大小**上限（字节，P1-8）。缺省
   * {@link DEFAULT_MAX_READ_BYTES}（10 MiB）；`0` = 不限制。见 {@link createReadFileTool}。
   */
  readMaxBytes?: number
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds
    ? builtinTools.filter((t) => toolIds.includes(t.id))
    : builtinTools
        .filter((t) => !(t.id === 'bash_ro' && options?.readOnlyBash === false))
        .map((t) => {
          if (t.id === 'read_file') return createReadFileTool({ readDeny: options?.readDeny, maxReadBytes: options?.readMaxBytes })
          if (t.id === 'bash' && options?.bash) return createBashTool(options.bash)
          if (t.id === 'bash_ro') {
            // 插件级 `readDeny` 合并进 bash_ro 自己的配置（⚠️ 用 `!== undefined` 区分
            // “没配”与“显式 false 关闭”—— 前者用默认清单，后者要真的关掉）。
            if (options?.readOnlyBash === undefined && options?.readDeny === undefined) return t
            const ro: ReadOnlyBashConfig = { ...(options?.readOnlyBash ?? {}) }
            if (options?.readDeny !== undefined) ro.readDeny = options.readDeny
            return createReadOnlyBashTool(ro)
          }
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
