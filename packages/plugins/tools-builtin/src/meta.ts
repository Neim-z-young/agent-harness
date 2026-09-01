/**
 * 内置工具静态元信息（纯数据，无副作用）。
 *
 * 目的：实现「多级加载」的 L1 级——工具的描述/别名/安全声明/权限键可在不加载对应
 * 运行时工具模块的前提下提前获取，供 REPL `/tools`、help 等展示层使用；
 * 真正的工具实现（index.ts）仍保持惰性/后台加载。
 *
 * 约束：本模块必须保持自包含，不得 import 本包的 index.ts（否则会让"惰性加载"失效）。
 */

import type { ToolMetaSource } from '@harness/plugin'

/** 内置工具静态元信息：与运行时 Tool 的展示字段对齐，字段为静态布尔/字符串 */
export interface BuiltinToolMeta {
  id: string
  description: string
  aliases?: string[]
  isReadOnly?: boolean
  isDestructive?: boolean
  isConcurrencySafe?: boolean
  permissionKey?: string
}

/**
 * 内置工具元信息登记表（key = 工具 id）。
 *
 * 描述与安全字段与 `src/index.ts` 中的工具定义保持同步；
 * 若后续调整工具实现，须在此处同步更新。
 */
export const BUILTIN_TOOL_META: Record<string, BuiltinToolMeta> = {
  read_file: {
    id: 'read_file',
    description: '读取本地文件内容。支持行号范围、行号前缀和截断。只能读取工作目录内的文件。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
  write_file: {
    id: 'write_file',
    description: '写入本地文件。支持覆盖、追加和仅新建模式。只能在工目录内写入。',
    isReadOnly: false,
    isDestructive: true, // 默认 mode=overwrite，属覆盖写入
    isConcurrencySafe: false,
    permissionKey: 'write',
  },
  bash: {
    id: 'bash',
    description: '执行 shell 命令（沙箱受限）。支持超时、工作目录和环境变量。返回 stdout/stderr/exitCode。',
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    permissionKey: 'bash',
  },
  edit_file: {
    id: 'edit_file',
    description: '编辑文件：精确查找并替换文本片段。默认只替换第一个匹配，支持 replaceAll。需要 oldString 在文件中唯一匹配。',
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    permissionKey: 'write',
  },
}

/** 内置工具元信息列表（顺序稳定，便于一次性登记） */
export const builtinToolMetas: BuiltinToolMeta[] = Object.values(BUILTIN_TOOL_META)

/**
 * 内置工具元信息来源（多级加载 L1，抽象契约 ToolMetaSource）。
 * CLI 经 ToolMetaRegistry 统一登记本来源，不硬编码各包的具体导出形态。
 */
export const toolMetaSource: ToolMetaSource = {
  id: 'tools-builtin',
  description: '内置工作台工具（文件读写 + Shell）',
  list: () => builtinToolMetas,
}