/**
 * @harness/computer-use - 电脑控制 MCP server 插件
 *
 * 依赖 @harness/mcp-server-registry：通过 registerMcpServer() 注册一个进程内
 * MCP server，registry 在 harness.start 时用 @harness/mcp-client 自动连接，
 * 并把 tools 暴露到 Harness 工具池。后端用 macOS 自动化（osascript）实现。
 *
 * 同时注册一个 plugin 来源的 Skill「Computer Use」作为操作指南。
 *
 * @example
 * createHarness({ internalPlugins: [
 *   createMcpServerRegistryPlugin(),
 *   createComputerUsePlugin(),
 *   toolsBuiltinPlugin,
 * ] })
 */

import type { AgentPlugin, Hooks } from '@harness/plugin'
import type { Skill } from '@harness/skill'
import { registerMcpServer, unregisterMcpServer } from '@harness/mcp-server-registry'
import { ComputerUseBackend, type ComputerUseBackendOptions } from './mac'
import { ComputerUseMcpServer, createComputerUseServerTransport } from './server'

export const COMPUTER_USE_SERVER_NAME = 'computer-use'

/** 插件选项 */
export interface ComputerUsePluginOptions {
  /** 注入 backend 实例（测试用；缺省自动创建真实 osascript backend） */
  backend?: ComputerUseBackend
  /** backend 选项（无注入 backend 时生效） */
  backendOptions?: ComputerUseBackendOptions
}

/** Computer Use 操作指南（plugin 来源 Skill 内容） */
const COMPUTER_USE_SKILL_CONTENT = `# Skill: Computer Use

在通过 Computer Use 操作应用 UI、查看应用 UI 状态或执行桌面交互之前，
必须先遵循本指南。优先使用专门用途的 MCP（如 browseruse）或 CLI，
除非用户明确要求使用 Computer Use。

## 工作流

1. 初始化：先 \`list_apps\` 获取目标应用的 bundleId，再 \`get_app_state\` 获取 UI 树 + 截图。
   \`get_app_state\` 必须在每次与应用交互前调用一次。
2. 执行动作：\`click\` / \`scroll\` / \`drag\` / \`type_text\` / \`press_key\` / \`perform_action\` / \`set_value\` / \`select_text\`。
3. 每次动作后再调用 \`get_app_state\` 获取最新状态，避免使用过期的 element_id。

## 要点
- \`type_text\` 前务必先 \`click\` 目标输入框使其获得焦点。
- 需要等待 UI 更新时不要轮询 \`get_app_state\`，用 Shell 等待（如 \`sleep 3\`）后再取状态。
- 权限不足时先 \`check_permissions\` 检查「辅助功能」与「屏幕录制」授权。
`

/** 创建 computer-use 插件工厂 */
export function createComputerUsePlugin(options: ComputerUsePluginOptions = {}): AgentPlugin {
  let backendRef: ComputerUseBackend | undefined

  return {
    id: 'computer-use',
    version: '0.1.0',
    name: 'Computer Use',
    description: '电脑控制 MCP server 插件：依赖 mcp-server-registry 自动启动进程内 MCP server，用 macOS 自动化（osascript）实现电脑操作',
    dependsOn: ['mcp.server-registry'],

    async install(ctx) {
      const backend = options.backend ?? new ComputerUseBackend(options.backendOptions ?? {})
      backendRef = backend
      const server = new ComputerUseMcpServer(backend)

      // 注册进程内 MCP server：registry 在 harness.start 连接
      registerMcpServer({
        name: COMPUTER_USE_SERVER_NAME,
        createTransport: () => createComputerUseServerTransport(server),
      })
      ctx.log.info(`computer-use 已注册进程内 MCP server（由 mcp-server-registry 启动连接）`)

      return {
        async 'harness.init'(_input, output) {
          const harness = (output as { harness?: unknown }).harness as
            | { skillManager?: { register: (s: Skill) => void } }
            | undefined
          if (harness?.skillManager) {
            harness.skillManager.register({
              id: 'computer-use',
              name: 'Computer Use',
              description: '电脑控制操作指南：本机 macOS 自动化（辅助功能 + 屏幕录制权限）',
              loadedFrom: 'plugin',
              content: COMPUTER_USE_SKILL_CONTENT,
              userInvocable: true,
            })
          }
        },
      } as Hooks
    },

    async uninstall() {
      unregisterMcpServer(COMPUTER_USE_SERVER_NAME)
      backendRef = undefined
    },
  }
}