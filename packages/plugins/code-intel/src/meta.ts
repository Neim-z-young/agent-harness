/**
 * code-intel 工具静态元信息（多级加载 L1，纯数据、无副作用）。
 *
 * 目的：描述/别名/安全声明/权限键可在不 import 本包运行时实现（index.ts）的前提下提前获取，
 * 供 REPL `/tools` 等展示层使用；运行时工具模块（L2）仍保持惰性加载。
 *
 * 约束：本模块必须保持自包含，不得 import 本包的 index.ts（否则会让"惰性加载"失效）。
 * 结构对齐 `@harness/tools-builtin/meta` 的 BuiltinToolMeta（字段为静态布尔/字符串）。
 */

import type { BuiltinToolMeta } from '@harness/tools-builtin/meta'
import type { ToolMetaSource } from '@harness/plugin'

/** 代码情报类工具：code_symbols + code_reference + code_definition */
export const CODE_INTEL_TOOL_META: BuiltinToolMeta[] = [
  {
    id: 'code_symbols',
    description: '列出文件或目录中的代码符号（函数/类/变量/接口/类型/枚举/导入）。基于 AST 解析，支持 TS/TSX/JS/JSX，返回符号名、类型、位置与签名。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
  {
    id: 'code_reference',
    description: '查找某符号在代码中的引用（usages，含跨文件）。先索引目标目录（AST 解析），再返回所有使用位置（行/列 + 上下文）。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
  {
    id: 'code_definition',
    description: '符号 go-to-definition：返回符号的声明位置（文件/行/列/类型/签名）。先索引目标目录（AST 解析），再定位声明。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
  {
    id: 'code_semantic_edit',
    description: '结构感知编辑：rename / replace_node（行列圈选吸附节点）/ replace_subtree（成员链如 config.server.host 精确定位子表达式）。落盘前重解析校验结构，dryRun 预览。',
    isReadOnly: false,
    isConcurrencySafe: false,
    permissionKey: 'edit',
  },
]

/** 代码情报工具元信息来源（多级加载 L1，抽象契约 ToolMetaSource） */
export const toolMetaSource: ToolMetaSource = {
  id: 'code-intel',
  description: '代码情报插件：code_symbols / code_reference / code_definition / code_semantic_edit（AST 符号索引与结构感知编辑）',
  list: () => CODE_INTEL_TOOL_META,
}
