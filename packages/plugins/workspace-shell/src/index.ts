/**
 * @harness/workspace-shell
 *
 * 工作区查看「薄壳插件」：通过 `cli.commands` / `cli.command` 提供 REPL `/workspace` 命令，
 * 展示由 @harness/workspace `resolveWorkspace` 解析出的两级目录布局（user × project）与 dataDir 数据文件路径。
 *
 * - 数据来源：优先取 cli 注入命令输入的 `input.workspace`，次选 `createWorkspacePlugin({ workspace })` 的入参；
 *   两者皆无则提示（保证插件可独立安装不炸，兼容非 cli 装配场景）。
 * - 本插件只做「展示」，不解析/加载任何资源（文件/技能/插件装载由各资源模块负责），故为薄壳。
 */

import { existsSync } from 'node:fs'
import type { AgentPlugin, Hooks, CliCommandInput, CliCommandsInput } from '@harness/plugin'
import type { Workspace, WorkspaceLevel } from '@harness/workspace'

/** cli.command 输入 + cli 注入的 workspace 布局（运行时注入，插件 cast 消费） */
export interface WorkspaceCmdInput extends CliCommandInput {
  workspace?: Workspace
}

/** createWorkspacePlugin 入参 */
export interface WorkspaceShellOptions {
  /** 注入的工作区布局（缺省改读命令输入的 input.workspace） */
  workspace?: Workspace
  /** 渲染标题，缺省 '工作区' */
  title?: string
}

/** 路径存在标记：✓ 已存在，空则尚未创建 */
function existMark(p: string): string {
  return existsSync(p) ? '✓' : ' '
}

/** 单级目录布局行（plugins / skills / agents） */
function levelLines(l: WorkspaceLevel): string {
  return (
    `  plugins  ${existMark(l.plugins)}${l.plugins}\n` +
    `  skills   ${existMark(l.skills)}${l.skills}\n` +
    `  agents   ${existMark(l.agents)}\n`
  )
}

/**
 * 把 Workspace 布局渲染为可读文本：两级目录 + dataDir 数据文件路径。
 * 纯函数，不依赖 cli / terminal，供 /workspace 与测试复用。
 */
export function renderWorkspace(ws: Workspace, title = '工作区'): string {
  const F = ws.files
  return (
    `${title}\n` +
    `  工作目录  ${ws.cwd}\n` +
    `  dataDir   ${ws.dataDir}   （用户级根，缺省 ~/.harness）\n` +
    `\n` +
    `  数据文件（dataDir 下）\n` +
    `  ────────────────────────────────\n` +
    `     config       ${existMark(F.config)}${F.config}\n` +
    `     permissions  ${existMark(F.permissions)}${F.permissions}\n` +
    `     sessions     ${existMark(F.sessions)}${F.sessions}\n` +
    `     .config-key  ${existMark(F.secretKey)}${F.secretKey}\n` +
    `\n` +
    `  用户级 user（root=${ws.user.root}，全局 ${ws.dataDir}）\n` +
    `  ────────────────────────────────\n` +
    levelLines(ws.user) +
    `   加载顺序：user → project（同 ID/同名后者覆盖前者）\n` +
    `\n` +
    `  项目级 project（root=${ws.project.root}，<cwd>/.harness）\n` +
    `  ────────────────────────────────\n` +
    levelLines(ws.project) +
    `   加载顺序：user → project（同 ID/同名后者覆盖前者）\n` +
    `\n` +
    `  ✓ = 路径已存在（不存在则待创建）\n`
  )
}

export function createWorkspacePlugin(opts: WorkspaceShellOptions = {}): AgentPlugin {
  const hooks: Hooks = {
    'cli.commands'(input: CliCommandsInput) {
      input.commands.push({
        command: 'workspace',
        description: '查看工作区两级目录布局 + dataDir 数据文件路径',
        usage: '/workspace',
      })
    },

    async 'cli.command'(input: CliCommandInput) {
      if (input.command !== 'workspace') return
      const inp = input as WorkspaceCmdInput
      try {
        const ws = inp.workspace ?? opts.workspace
        if (!ws) {
          inp.out('工作区未注入：通常由 cli 装配时提供；亦可 createWorkspacePlugin({ workspace }) 指定。\n')
          return
        }
        inp.out(renderWorkspace(ws, opts.title ?? '工作区') + '\n')
      } finally {
        // 标记命令已处理，避免 cli fallthrough 到"未知命令"
        input.result = 'continue'
      }
    },
  }

  return {
    id: 'workspace-shell',
    name: 'Workspace Shell',
    version: '0.1.0',
    async install() {
      return hooks
    },
  }
}

export default createWorkspacePlugin