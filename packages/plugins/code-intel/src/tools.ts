/**
 * code-intel Harness Tool 适配层
 *
 * 把 `core.ts`（索引/编辑引擎，解耦）适配为 `@harness/tool` 的 Tool，返回 ToolResult。
 * 保留既有工具 id（code_symbols / code_reference / code_definition / code_semantic_edit）
 * 与权限/只读/并发安全声明，供直接装配或 REPL `/tools` 展示；MCP 路径见 `server.ts`。
 */

import { resolve, isAbsolute } from 'node:path'
import { defineTool, Schema, Tool, ToolResult, ToolContext } from '@harness/tool'
import {
  CodeIntelIndex,
  execSemanticEdit,
  isWithinCwd,
  MAX_RESULTS,
  type CodeSymbol,
  type CodeReference,
  type CodeDefinition,
  type CodeSemanticEditInput,
  type CodeSemanticEditOutput,
} from './core'

// ===== 共享 helper =====

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

function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

/** 结果中返回的最多条目数（与 core 一致） */

export interface CodeSymbolsInput {
  path?: string
}
export interface CodeSymbolsOutput {
  path: string
  count: number
  symbols: CodeSymbol[]
  truncated: boolean
}

export const codeSymbolsTool = (index: CodeIntelIndex): Tool<CodeSymbolsInput, CodeSymbolsOutput> =>
  defineTool<CodeSymbolsInput, CodeSymbolsOutput>({
    id: 'code_symbols',
    description: '列出文件或目录中的代码符号（函数/类/变量/接口/类型/枚举/导入）。基于 AST 解析：TS/TSX/JS/JSX 走 babel，Go/Python/Rust/Java 走 tree-sitter，返回符号名、类型、位置与签名。',
    inputSchema: makeSchema<CodeSymbolsInput>(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permission: {
      key: 'read',
      extractPatterns: (input) => [input.path ?? '.'],
    },
    async call(input, ctx): Promise<ToolResult<CodeSymbolsOutput>> {
      const absPath = resolvePath(input.path ?? '.', ctx.cwd)
      if (!isWithinCwd(absPath, ctx.cwd)) {
        return { ok: false, error: { message: `路径 "${input.path ?? '.'}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
      }
      try {
        const symbols = await index.symbols(absPath, ctx.cwd)
        const truncated = symbols.length > MAX_RESULTS
        return {
          ok: true,
          output: {
            path: absPath,
            count: symbols.length,
            symbols: symbols.slice(0, MAX_RESULTS),
            truncated,
          },
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { ok: false, error: { message: `路径不存在: ${input.path ?? '.'}`, code: 'PATH_NOT_FOUND' } }
        }
        return { ok: false, error: { message: err.message ?? String(err), code: 'CODE_INTEL_ERROR' } }
      }
    },
  })

export interface CodeReferenceInput {
  symbol: string
  path?: string
}
export interface CodeReferenceOutput {
  symbol: string
  path: string
  count: number
  references: CodeReference[]
  truncated: boolean
}

export const codeReferenceTool = (index: CodeIntelIndex): Tool<CodeReferenceInput, CodeReferenceOutput> =>
  defineTool<CodeReferenceInput, CodeReferenceOutput>({
    id: 'code_reference',
    description: '查找某符号在代码中的引用（usages，含跨文件）。先索引目标目录（AST 解析），再返回所有使用位置（行/列 + 上下文）；TS/JS 语义引用，Go/Python/Rust/Java 名字命中型引用。',
    inputSchema: makeSchema<CodeReferenceInput>(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permission: {
      key: 'read',
      extractPatterns: (input) => [input.path ?? '.'],
    },
    async call(input, ctx): Promise<ToolResult<CodeReferenceOutput>> {
      const absPath = resolvePath(input.path ?? '.', ctx.cwd)
      if (!isWithinCwd(absPath, ctx.cwd)) {
        return { ok: false, error: { message: `路径 "${input.path ?? '.'}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
      }
      try {
        await index.load(absPath, ctx.cwd)
        const references = index.allReferences(input.symbol)
        const truncated = references.length > MAX_RESULTS
        return {
          ok: true,
          output: {
            symbol: input.symbol,
            path: absPath,
            count: references.length,
            references: references.slice(0, MAX_RESULTS),
            truncated,
          },
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { ok: false, error: { message: `路径不存在: ${input.path ?? '.'}`, code: 'PATH_NOT_FOUND' } }
        }
        return { ok: false, error: { message: err.message ?? String(err), code: 'CODE_INTEL_ERROR' } }
      }
    },
  })

export interface CodeDefinitionInput {
  symbol: string
  path?: string
}
export interface CodeDefinitionOutput {
  symbol: string
  path: string
  count: number
  definitions: CodeDefinition[]
}

export const codeDefinitionTool = (index: CodeIntelIndex): Tool<CodeDefinitionInput, CodeDefinitionOutput> =>
  defineTool<CodeDefinitionInput, CodeDefinitionOutput>({
    id: 'code_definition',
    description: '符号 go-to-definition：返回符号的声明位置（文件/行/列/类型/签名）。先索引目标目录（AST 解析，babel+tree-sitter 双后端），再定位声明。',
    inputSchema: makeSchema<CodeDefinitionInput>(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permission: {
      key: 'read',
      extractPatterns: (input) => [input.path ?? '.'],
    },
    async call(input, ctx): Promise<ToolResult<CodeDefinitionOutput>> {
      const absPath = resolvePath(input.path ?? '.', ctx.cwd)
      if (!isWithinCwd(absPath, ctx.cwd)) {
        return { ok: false, error: { message: `路径 "${input.path ?? '.'}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
      }
      try {
        await index.load(absPath, ctx.cwd)
        const definitions = index.allDefinitions(input.symbol)
        return {
          ok: true,
          output: {
            symbol: input.symbol,
            path: absPath,
            count: definitions.length,
            definitions: definitions.slice(0, MAX_RESULTS),
          },
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { ok: false, error: { message: `路径不存在: ${input.path ?? '.'}`, code: 'PATH_NOT_FOUND' } }
        }
        return { ok: false, error: { message: err.message ?? String(err), code: 'CODE_INTEL_ERROR' } }
      }
    },
  })

export const codeSemanticEditTool = (
  index: CodeIntelIndex,
): Tool<CodeSemanticEditInput, CodeSemanticEditOutput> =>
  defineTool<CodeSemanticEditInput, CodeSemanticEditOutput>({
    id: 'code_semantic_edit',
    description: '结构感知编辑：rename（符号重命名，只改精确 AST 标识符位点，字符串与 obj.x 属性不触碰；支持 scope 子目录限定、resolveImporters 跨目录反向 import）/ replace_node（按 AST 节点范围替换，圈选自动吸附到节点）/ replace_subtree（按成员链如 config.server.host 定位子表达式替换，path 可为目录批量）。落盘前重解析校验结构，dryRun 预览。',
    inputSchema: makeSchema<CodeSemanticEditInput>(),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    permission: {
      key: 'edit',
      extractPatterns: (input) => {
        const patterns = [('path' in input && input.path) ? input.path : '.']
        if ('scope' in input && input.scope) patterns.push(input.scope)
        if ('importRoot' in input && input.importRoot) patterns.push(input.importRoot)
        return patterns
      },
    },
    async call(input, ctx): Promise<ToolResult<CodeSemanticEditOutput>> {
      const res = await execSemanticEdit(index, input, { cwd: ctx.cwd })
      // CoreResult 与 ToolResult 同构，直传
      if (res.ok) return { ok: true, output: res.output }
      return { ok: false, error: res.error }
    },
  })