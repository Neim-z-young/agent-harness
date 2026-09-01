/**
 * tools-web 工具静态元信息（多级加载 L1，纯数据、无副作用）。
 *
 * 目的：描述/别名/安全声明/权限键可在不 import 本包运行时实现（index.ts）的前提下提前获取，
 * 供 REPL `/tools` 等展示层使用；运行时工具模块（L2）仍保持惰性加载。
 *
 * 约束：本模块必须保持自包含，不得 import 本包的 index.ts（否则会让"惰性加载"失效）。
 * 结构对齐 `@harness/tools-builtin/meta` 的 BuiltinToolMeta（字段为静态布尔/字符串）。
 */

import type { BuiltinToolMeta } from '@harness/tools-builtin/meta'
import type { ToolMetaSource } from '@harness/plugin'

/** 一个网页抓取工具 */
export const WEB_TOOL_META: BuiltinToolMeta[] = [
  {
    id: 'web_fetch',
    description: '通过 HTTP(S) 抓取 URL 内容。支持自定义方法/头/体，返回 text/json/base64。默认禁止访问私有网络（SSRF 防护）。',
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: true,
    permissionKey: 'network',
  },
]

/** 网页抓取工具元信息来源（多级加载 L1，抽象契约 ToolMetaSource） */
export const toolMetaSource: ToolMetaSource = {
  id: 'tools-web',
  description: '网页抓取工具插件：web_fetch HTTP(S) 抓取 URL 内容（文本/JSON/原始字节）',
  list: () => WEB_TOOL_META,
}