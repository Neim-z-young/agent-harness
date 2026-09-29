/**
 * @harness/tools-glob - Glob 搜索工具插件
 *
 * 提供：
 * - glob：按模式（可多个）递归搜索匹配文件，支持排除/大小/时间过滤
 *
 * 通过 core.tool.pool.assemble Hook 注入到 Harness 工具池。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { toolsGlobPlugin } from '@harness/tools-glob'
 *
 * const h = await createHarness({
 *   internalPlugins: [toolsGlobPlugin],
 *   agents: [{ id: 'default', name: 'Agent', mode: 'primary', tools: ['*'], permission: { '*': 'allow' }, promptFragments: [] }],
 * })
 */

import { defineTool, Tool, ToolResult, ToolContext, fromJsonSchema, formatSchemaError, schemaIssues } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

import { resolve, isAbsolute, relative, join } from 'node:path'
import { stat, readdir } from 'node:fs/promises'

// ===== 共享 helper（自包含）=====

function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

function isWithinCwd(filePath: string, cwd: string): boolean {
  const rel = relative(cwd, filePath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * glob 转 RegExp（支持 ** / * / ?）。
 * - **：匹配 0+ 个路径段（含中间的 / 分隔），可出现在任何位置
 * - * ：单层内任意字符（不含 /）
 * - ? ：单个非 / 字符
 */
function globToRegex(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/')
  const parts = p.split('/')
  let s = ''
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    const isLast = i === parts.length - 1
    if (seg === '**') {
      // **/xxx 或 a/**/b → (?:.*/)? （包含段间的/），最后一段的 ** 特殊处理成 .*
      s += isLast ? '.*' : '(?:.*/)?'
    } else {
      const escaped = seg
        .replace(/[.+^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
      s += escaped
      if (!isLast) s += '/'
    }
  }
  return new RegExp('^' + s + '$')
}

// ========================================================================
// 1. glob 工具
// ========================================================================

export interface GlobInput {
  /** 一个或多个匹配模式（如 "*.ts"、["src/**\/*.ts", "!src/dist/**"]）。以 "!" 开头表示排除 */
  pattern: string | string[]
  /** 搜索根目录（相对 cwd 或绝对路径，默认 "."） */
  path?: string
  /** 最大结果数量（默认 500） */
  maxResults?: number
  /** 是否包含隐藏文件（默认 false） */
  includeHidden?: boolean
  /** 排除模式数组（便捷字段，等同在 pattern 里用 ! 前缀） */
  exclude?: string[]
  /** 最小文件大小（字节） */
  minSizeBytes?: number
  /** 最大文件大小（字节） */
  maxSizeBytes?: number
  /** 最大递归深度（默认 10） */
  maxDepth?: number
}

export interface GlobEntry {
  /** 基础文件名（不含路径） */
  name: string
  /** 相对于输入路径的相对路径（正斜杠） */
  relativePath: string
  /** 绝对路径 */
  absolutePath: string
  /** 文件大小（字节） */
  sizeBytes: number
  /** 修改时间（ms since epoch） */
  mtimeMs: number
  /** 条目类型 */
  type: 'file' | 'dir' | 'symlink'
}

export interface GlobOutput {
  pattern: string[]
  root: string
  entries: GlobEntry[]
  count: number
  filesScanned: number
  truncated: boolean
}

const MAX_GLOB_RESULTS = 5000

/**
 * 兜底成「排除项之外的全部」时的结果上限，远低于常规上限。
 *
 * 为什么单独设：pattern 全是 `!xxx` 排除项时，兜底成「全匹配」是**正确语义**（"除这些之外的全部"），
 * 不能报错；但这种调用没有正向约束，规模完全不可控 —— 不压上限就是"一次调用扫回整个仓库"。
 */
const FALLBACK_MAX_RESULTS = 200

/**
 * 输出字符预算（对 `entries` 的累积估算，非精确序列化长度）。
 *
 * 真机教训（会话 `s_1790592617954_axqkk`）：子 Agent 一次 `glob` 返回 **215,562 字符**
 * （约 1,937 个文件），而合法入参重调只有 665 字符 —— 该子会话成本是干同类活的另一个的
 * **3.05 倍**。`MAX_GLOB_RESULTS`（5000）只管条目数、不管体积，几千条短路径照样能撑爆上下文。
 * 命中数再多也只回传预算内的部分，并置 `truncated = true` 让调用方知道要收窄 pattern。
 */
const MAX_GLOB_OUTPUT_CHARS = 20_000

/**
 * glob 的入参 schema。
 *
 * 提到模块级是为了让 `call()` 内的守卫复用**同一份**：schema 是"模型看到什么"与"运行期接受什么"
 * 的唯一取源，守卫只补 JSON Schema 表达不了的那部分（全空白 / 空数组）。
 */
const globInputSchema = fromJsonSchema<GlobInput>({
  type: 'object',
  properties: {
    pattern: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '匹配模式（如 "*.ts"、["src/**/*.ts","!src/dist/**"]，"!" 开头表示排除）' },
    path: { type: 'string', description: '搜索根目录（相对 cwd 或绝对路径，默认 "."）' },
    maxResults: { type: 'number', description: '最大结果数量（默认 500）' },
    includeHidden: { type: 'boolean', description: '是否包含隐藏文件（默认 false）' },
    exclude: { type: 'array', items: { type: 'string' }, description: '排除模式数组（便捷字段，等同在 pattern 里用 "!" 前缀）' },
    minSizeBytes: { type: 'number', description: '最小文件大小（字节），小于它的条目被过滤' },
    maxSizeBytes: { type: 'number', description: '最大文件大小（字节），大于它的条目被过滤' },
    maxDepth: { type: 'number', description: '最大递归深度（默认 10，上限 20）' },
  },
  required: ['pattern'],
  additionalProperties: false,
})

export const globTool = defineTool<GlobInput, GlobOutput>({
  id: 'glob',
  description: '按模式（glob，支持 **/*/? 通配符，! 取反）递归搜索文件，支持排除、大小过滤、深度限制。',
  inputSchema: globInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path ?? '.'],
  },
  async call(input, ctx): Promise<ToolResult<GlobOutput>> {
    // 入参守卫（结构）：管道内 Step 1 已由 globInputSchema 拦过一次，这里是"越过管道直接调
    // tool.call()"那条路径的兜底（测试就是直接调的）。
    // 错误码按失败**性质**分流：缺 pattern ⇒ GLOB_PATTERN_MISSING（与下面的语义守卫同码，
    // 消费方不必区分"从管道来的"还是"从守卫来的"）；其它字段的结构问题 ⇒ INVALID_INPUT。
    // 判据必须是 rule（不能只看 path）——"缺必填"与"类型不符"的 path 都是 'pattern'。
    const parsedInput = globInputSchema.safeParse(input)
    if (!parsedInput.success) {
      const missingPattern = schemaIssues(parsedInput.error).some(
        (i) => i.rule === 'required' && i.path === 'pattern',
      )
      return {
        ok: false,
        error: {
          message: formatSchemaError(parsedInput.error),
          code: missingPattern ? 'GLOB_PATTERN_MISSING' : 'INVALID_INPUT',
        },
      }
    }

    const relRoot = input.path ?? '.'
    const absRoot = resolvePath(relRoot, ctx.cwd)

    if (!isWithinCwd(absRoot, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${relRoot}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    // 解析 include / exclude patterns
    const rawPatterns = Array.isArray(input.pattern) ? input.pattern : [input.pattern]
    /**
     * 非空判定用 `trim()`：模型丢参数时的典型形态是 `''` / 纯空白 / 非法类型，
     * 而 `if (!pat) continue` 会把它们全部静默跳过 —— 跳过之后 `includes` 为空，
     * 再兜底成全匹配 ⇒ 退化成全仓遍历（见 MAX_GLOB_OUTPUT_CHARS 处的真机数字）。
     */
    const isUsable = (p: unknown): p is string => typeof p === 'string' && p.trim().length > 0
    const includes: RegExp[] = []
    const excludes: RegExp[] = []
    for (const pat of rawPatterns) {
      if (!isUsable(pat)) continue
      if (pat.startsWith('!')) excludes.push(globToRegex(pat.slice(1)))
      else includes.push(globToRegex(pat))
    }
    if (input.exclude) {
      for (const ex of input.exclude) {
        if (isUsable(ex)) excludes.push(globToRegex(ex.startsWith('!') ? ex.slice(1) : ex))
      }
    }

    // ⚠️ 拒绝「静默退化成全仓遍历」：pattern 语义为空时**直接报错**，不再兜底。
    // `pattern` 缺失、或类型不是 string/string[] 的形态，已由上面的 globInputSchema 守卫拦下；
    // 这里只剩 JSON Schema 表达不了的那几种（`''` / `'   '` / `[]` / `['', '  ']`）——
    // 都属"语法合法但语义为空"，正是当初退化成全仓遍历的入口。
    // 明确报错让模型走「入参自愈」补齐参数，代价远小于把整个仓库灌进上下文。
    if (rawPatterns.filter(isUsable).length === 0) {
      return {
        ok: false,
        error: {
          message:
            `pattern 缺失或全为空（收到 ${JSON.stringify(input.pattern)}）：拒绝退化成全仓遍历。`
            + '请给出明确的匹配模式，如 "src/**/*.ts" 或 ["src/**/*.ts","!src/dist/**"]。',
          code: 'GLOB_PATTERN_MISSING',
        },
      }
    }

    // 合法兜底：pattern 全是排除项（"!..."）时确实要「除这些之外的全部」，但规模必须压制
    const fellBackToAll = includes.length === 0
    if (fellBackToAll) includes.push(globToRegex('**/*'))

    const maxResults = fellBackToAll
      ? Math.min(input.maxResults ?? FALLBACK_MAX_RESULTS, FALLBACK_MAX_RESULTS)
      : Math.min(input.maxResults ?? MAX_GLOB_RESULTS, MAX_GLOB_RESULTS)
    const includeHidden = input.includeHidden ?? false
    const maxDepth = Math.min(input.maxDepth ?? 10, 20)
    const minSize = input.minSizeBytes
    const maxSize = input.maxSizeBytes

    const entries: GlobEntry[] = []
    let filesScanned = 0
    let truncated = false

    async function scan(dirPath: string, depth: number): Promise<void> {
      if (truncated) return
      if (depth > maxDepth) return

      const items = await readdir(dirPath, { withFileTypes: true })
      for (const item of items) {
        if (truncated) return
        if (!includeHidden && item.name.startsWith('.')) continue

        const abs = join(dirPath, item.name)
        const rel = relative(absRoot, abs).replace(/\\/g, '/')
        if (!rel || rel === '.') continue

        try {
          let kind: GlobEntry['type'] = 'file'
          let s = await stat(abs)
          if (item.isSymbolicLink()) kind = 'symlink'
          else if (s.isDirectory()) kind = 'dir'
          else kind = 'file'

          if (kind === 'file') {
            filesScanned++
            // 过滤
            if (minSize !== undefined && s.size < minSize) continue
            if (maxSize !== undefined && s.size > maxSize) continue
            const passInclude = includes.length === 0 || includes.some((r) => r.test(rel) || r.test(item.name))
            const passExclude = excludes.length === 0 || !excludes.some((r) => r.test(rel) || r.test(item.name))
            if (passInclude && passExclude) {
              if (entries.length >= maxResults) { truncated = true; return }
              entries.push({
                name: item.name,
                relativePath: rel,
                absolutePath: abs,
                sizeBytes: s.size,
                mtimeMs: s.mtimeMs,
                type: kind,
              })
            }
          }
          if (kind === 'dir') {
            await scan(abs, depth + 1)
          }
        } catch {
          // 跳过无法 stat/read 的条目
        }
      }
    }

    try {
      const rootStats = await stat(absRoot)
      if (!rootStats.isDirectory()) {
        return { ok: false, error: { message: `"${relRoot}" 不是目录`, code: 'NOT_A_DIR' } }
      }
      await scan(absRoot, 0)

      const sorted = entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      // 字符预算裁剪：命中数再多，也只回传预算内的部分（至少留 1 条，避免"全被裁掉"的空结果）。
      // 估算口径 = 相对路径 + 绝对路径 + 其余字段的固定开销，序列化里这两项占绝大部分。
      let used = 0
      let kept = 0
      for (const e of sorted) {
        const cost = e.relativePath.length + e.absolutePath.length + 64
        if (kept > 0 && used + cost > MAX_GLOB_OUTPUT_CHARS) { truncated = true; break }
        used += cost
        kept++
      }
      const outEntries = kept < sorted.length ? sorted.slice(0, kept) : sorted

      return {
        ok: true,
        output: {
          pattern: rawPatterns,
          root: absRoot,
          entries: outEntries,
          count: outEntries.length,
          filesScanned,
          truncated,
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: { message: `目录不存在: ${relRoot}`, code: 'DIR_NOT_FOUND' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'GLOB_ERROR' } }
    }
  },
})

// ========================================================================
// 2. AgentPlugin 入口
// ========================================================================

export const globTools: Tool[] = [globTool]

export function createToolsGlobPlugin(options?: {
  toolIds?: string[]
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds ? globTools.filter((t) => toolIds.includes(t.id)) : globTools

  return {
    id: 'tools.glob',
    version: '0.1.0',
    name: 'Glob 搜索工具',
    description: '提供 glob 搜索工具（按模式匹配查找文件）',
    async install(ctx) {
      ctx.log.info('Glob 工具插件已加载', { tools: tools.map((t) => t.id) })
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

export const toolsGlobPlugin: AgentPlugin = createToolsGlobPlugin()
