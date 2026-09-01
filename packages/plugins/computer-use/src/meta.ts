/**
 * computer-use 工具静态元信息（多级加载 L1，纯数据、无副作用）。
 *
 * computer-use 是进程内 MCP server，其工具在 mcp-server-registry 连接后
 * 以 `mcp__computer-use__<toolName>` 的 id 暴露（见 @harness/mcp-client 的
 * convertMcpToolToHarnessTool）。本模块预登记这些工具的描述/安全声明/权限键，
 * 使 REPL `/tools` 在 server 尚未连接加载时也能展示其元信息。
 *
 * 约束：本模块必须保持自包含，不得 import 本包 index.ts（否则会让"惰性加载"失效）。
 * 结构对齐 BuiltinToolMeta（字段为静态布尔/字符串）。
 */
import type { BuiltinToolMeta } from '@harness/tools-builtin/meta'

/** server 名，与 COMPUTER_USE_SERVER_NAME 保持一致 */
const SERVER = 'computer-use'
/** 运行时工具 id 前缀：mcp__computer-use__ */
const ID = `mcp__${SERVER}__`

/** computer-use MCP 工具清单（与 server.ts 的 tools() 一一对应） */
export const COMPUTER_USE_TOOL_META: BuiltinToolMeta[] = [
  { id: `${ID}check_permissions`, description: '检查「辅助功能」与「屏幕录制」权限状态', isReadOnly: true, isConcurrencySafe: false, permissionKey: 'read' },
  { id: `${ID}list_apps`, description: '列出本机运行中的应用（name、pid、运行状态，可选 windowId 丰富）', isReadOnly: true, isConcurrencySafe: false, permissionKey: 'read' },
  { id: `${ID}get_app_state`, description: '获取应用当前状态：辅助功能 UI 树 + 可选窗口截图。每次交互前先调用。', isReadOnly: true, isConcurrencySafe: false, permissionKey: 'read' },
  { id: `${ID}click`, description: '按图片像素坐标或 UI 树 element_id 点击。左键后台交付不抢焦点。', isReadOnly: false, isConcurrencySafe: false, permissionKey: 'write' },
  { id: `${ID}scroll`, description: '按方向滚动元素。优先用 element_id；deltaY>0 向下，deltaY<0 向上。', isReadOnly: false, isConcurrencySafe: false, permissionKey: 'write' },
  { id: `${ID}drag`, description: '从一点拖到另一点（图片像素坐标）', isReadOnly: false, isConcurrencySafe: false, permissionKey: 'write' },
  { id: `${ID}type_text`, description: '向目标输入框输入文本（后台不抢焦点）。务必先 click 目标字段。', isReadOnly: false, isConcurrencySafe: false, permissionKey: 'write' },
  { id: `${ID}press_key`, description: '按键或组合键。如 press_key(key="enter") / press_key(key="v", modifiers=["cmd"])', isReadOnly: false, isConcurrencySafe: false, permissionKey: 'write' },
  { id: `${ID}perform_action`, description: '对 UI 元素调用辅助功能动作（AXPress/AXShowMenu）。失败可退回 click。', isReadOnly: false, isConcurrencySafe: false, permissionKey: 'write' },
  { id: `${ID}set_value`, description: '设置可写辅助功能元素的值。Electron 等应用可能拒写，可退回 click + type_text。', isReadOnly: false, isConcurrencySafe: false, permissionKey: 'write' },
  { id: `${ID}select_text`, description: '在元素内选中文本或定位光标（text | cursor_before | cursor_after）', isReadOnly: false, isConcurrencySafe: false, permissionKey: 'write' },
]