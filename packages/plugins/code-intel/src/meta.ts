/**
 * code-intel 工具静态元信息（多级加载 L1，纯数据、无副作用）。
 *
 * code-intel 是进程内 MCP server，其工具在 mcp-server-registry 连接后以
 * `mcp__code-intel__<toolName>` 的 id 暴露（见 @harness/mcp-client 的
 * convertMcpToolToHarnessTool）。本模块预登记这些工具的描述/安全声明/权限键，
 * 使 REPL `/tools` 在 server 尚未连接加载时也能展示其元信息。
 *
 * 约束：本模块必须保持自包含，不得 import 本包的 index.ts（否则会让"惰性加载"失效）。
 * 结构对齐 `@harness/tools-builtin/meta` 的 BuiltinToolMeta（字段为静态布尔/字符串）。
 */

import type { BuiltinToolMeta } from '@harness/tools-builtin/meta'
import type { ToolMetaSource } from '@harness/plugin'

/** server 名，与 CODE_INTEL_SERVER_NAME 保持一致 */
const SERVER = 'code-intel'
/** 运行时工具 id 前缀：mcp__code-intel__ */
const ID = `mcp__${SERVER}__`

/** code-intel MCP 工具清单（与 server.ts 的 tools() 一一对应） */
export const CODE_INTEL_TOOL_META: BuiltinToolMeta[] = [
  {
    id: `${ID}code_symbols`,
    description: '列出文件或目录中的代码符号（函数/类/变量/接口/类型/枚举/导入）。基于 AST 解析：TS/TSX/JS/JSX 走 babel，Go/Python/Rust/Java 走 tree-sitter，返回符号名、类型、位置与签名。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
  {
    id: `${ID}code_reference`,
    description: '查找某符号在代码中的引用（usages，含跨文件）。先索引目标目录（AST 解析），再返回所有使用位置（行/列 + 上下文）；TS/JS 语义引用，Go/Python/Rust/Java 名字命中型引用。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
  {
    id: `${ID}code_definition`,
    description: '符号 go-to-definition：返回符号的声明位置（文件/行/列/类型/签名）。先索引目标目录（AST 解析，babel+tree-sitter 双后端），再定位声明。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
  {
    id: `${ID}code_semantic_edit`,
    description: '结构感知编辑：rename（TS/JS 走 babel、Java 走 tree-sitter 语义位点；支持 scope 子目录限定、resolveImporters 跨目录反向 import 含 Java 包名匹配）/ replace_node（行列圈选吸附节点）/ replace_subtree（成员链如 config.server.host 精确定位子表达式，path 可为目录批量）。落盘前重解析校验结构，dryRun 预览。',
    isReadOnly: false,
    isConcurrencySafe: false,
    permissionKey: 'edit',
  },
]

/** 代码情报工具元信息来源（多级加载 L1，抽象契约 ToolMetaSource） */
export const toolMetaSource: ToolMetaSource = {
  id: 'code-intel',
  description: '代码情报 MCP server 工具（mcp__code-intel__*）：code_symbols / code_reference / code_definition / code_semantic_edit（rename TS/JS babel + Java tree-sitter 语义、反向import 含 Java 包名匹配、replace_node、replace_subtree 批量）',
  list: () => CODE_INTEL_TOOL_META,
}
