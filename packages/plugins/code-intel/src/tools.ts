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
// 工具提示词文本（prompts/*.txt，import 加载，参考 opencode）
import codeSymbolsPrompt from './prompts/code-symbols.txt'
import codeReferencePrompt from './prompts/code-reference.txt'
import codeDefinitionPrompt from './prompts/code-definition.txt'
import codeSemanticEditPrompt from './prompts/code-semantic-edit.txt'

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
    description: codeSymbolsPrompt.trim(),
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
    description: codeReferencePrompt.trim(),
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
    description: codeDefinitionPrompt.trim(),
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
    description: codeSemanticEditPrompt.trim(),
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