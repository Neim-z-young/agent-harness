/**
 * tools-media 工具静态元信息（多级加载 L1，纯数据、无副作用）。
 *
 * 目的：描述/别名/安全声明/权限键可在不 import 本包运行时实现（index.ts）的前提下提前获取，
 * 供 REPL `/tools` 等展示层使用；运行时工具模块（L2）仍保持惰性加载。
 *
 * 约束：本模块必须保持自包含，不得 import 本包的 index.ts（否则会让"惰性加载"失效）。
 * 结构对齐 `@harness/tools-builtin/meta` 的 BuiltinToolMeta（字段为静态布尔/字符串）。
 */

import type { BuiltinToolMeta } from '@harness/tools-builtin/meta'

/** 一个图像读取工具 */
export const MEDIA_TOOL_META: BuiltinToolMeta[] = [
  {
    id: 'view_image',
    description: '读取本地图像文件，返回 base64 data URI 与尺寸/格式信息，供多模态 LLM 识别。支持 PNG/JPEG/GIF/WebP/BMP 自动识别。',
    isReadOnly: true,
    isConcurrencySafe: true,
    permissionKey: 'read',
  },
]