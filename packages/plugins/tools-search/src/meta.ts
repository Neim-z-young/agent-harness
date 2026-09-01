/**
 * tools-search 工具静态元信息（多级加载 L1，纯数据、无副作用）。
 *
 * 目的：描述/别名/安全声明/权限键可在不 import 本包运行时实现（index.ts）的前提下提前获取，
 * 供 REPL `/tools` 等展示层使用；运行时工具模块（L2）仍保持惰性加载。
 *
 * 约束：本模块必须保持自包含，不得 import 本包的 index.ts（否则会让"惰性加载"失效）。
 * 结构对齐 `@harness/tools-builtin/meta` 的 BuiltinToolMeta（字段为静态布尔/字符串）。
 */

import type { BuiltinToolMeta } from '@harness/tools-builtin/meta'
import type { ToolMetaSource } from '@harness/plugin'

/** 搜索类工具：list_dir + grep_file */
export const SEARCH_TOOL_META: BuiltinToolMeta[] = [
  {
    id: 'list_dir',
    description: '列出目录内容。支持递归、隐藏文件显示。返回文件名、类型和大小。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
  {
    id: 'grep_file',
    description: '在文件或目录中搜索文本模式（正则表达式）。支持 glob 文件过滤、大小写敏感、递归搜索。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
]

/** 搜索类工具元信息来源（多级加载 L1，抽象契约 ToolMetaSource） */
export const toolMetaSource: ToolMetaSource = {
  id: 'tools-search',
  description: '搜索类工具插件：list_dir 目录列举 + grep_file 内容检索',
  list: () => SEARCH_TOOL_META,
}