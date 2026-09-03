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

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentPlugin, Hooks, CliCommandInput, CliCommandsInput } from '@harness/plugin'
import type { Workspace, WorkspaceLevel } from '@harness/workspace'

/** 打开目录的结果（ok=false 时带错误说明） */
export interface OpenResult {
  ok: boolean
  error?: string
}

/** 打开目录的实现签名（可注入，便于测试断言打开了哪个目录） */
export type OpenDir = (path: string) => OpenResult | Promise<OpenResult>

/**
 * 系统默认打开目录的实现：按平台调用 `open` / `xdg-open` / `explorer`。
 * 失败（进程 spawn 出错）返回 { ok: false, error }。
 */
export async function openInFileManager(path: string): Promise<OpenResult> {
  const cmd =
    process.platform === 'darwin' ? ['open', path] :
    process.platform === 'win32' ? ['explorer', path] :
    ['xdg-open', path]
  return new Promise((res) => {
    execFile(cmd[0], cmd.slice(1), (err) => {
      if (err) return res({ ok: false, error: err.message })
      res({ ok: true })
    })
  })
}

/**
 * 解析 `/workspace open [target]` 目标对应的绝对路径。
 * - 无 target / `user` / `data` → dataDir（用户级根）
 * - `cwd` → 工作目录
 * - `project` → 项目级根（<cwd>/.harness）
 * - 其他 → 视为相对 cwd 的路径（resolve + 校验存在），不存在则返回 { error }
 */
export function resolveOpenTarget(
  ws: Workspace,
  target?: string,
): { path: string } | { error: string } {
  const t = (target ?? '').trim().toLowerCase()
  if (t === '' || t === 'user' || t === 'data') return { path: ws.dataDir }
  if (t === 'cwd') return { path: ws.cwd }
  if (t === 'project') return { path: ws.project.root }
  const p = resolve(ws.cwd, target!)
  return existsSync(p) ? { path: p } : { error: `目录不存在：${p}` }
}

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
  /** 打开目录的实现（缺省 openInFileManager，测试可注 spy） */
  open?: OpenDir
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
  const openDir = opts.open ?? openInFileManager
  const hooks: Hooks = {
    'cli.commands'(input: CliCommandsInput) {
      input.commands.push({
        command: 'workspace',
        description: '查看工作区两级目录布局 + dataDir 数据文件路径',
        usage: '/workspace [open [cwd|user|project|路径]]',
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
        // 子命令：open / help；其余（含空）渲染布局。
        // 注意：cli 注入的 arg 只含第二个 token（如 'open'），完整参数在 raw（'workspace open cwd'）中，
        // 故子命令与目标均从 raw 解析，避免 target 被截断而统一落到 dataDir。
        const parts = input.raw.trim().split(/\s+/)
        const sub = parts[1] ?? ''
        const target = parts.slice(2).join(' ')

        if (sub === 'open') {
          const r = resolveOpenTarget(ws, target)
          if ('error' in r) return void inp.out(r.error + '\n')
          const res = await openDir(r.path)
          inp.out(res.ok ? `已打开目录：${r.path}\n` : `打开失败：${res.error}\n`)
          return
        }
        if (sub === 'help') {
          inp.out(
            '用法：\n' +
            '  /workspace                     查看两级目录布局 + dataDir 数据文件路径\n' +
            '  /workspace open [cwd|user|project|路径]  用系统文件管理器打开目录（缺省 dataDir/~）\n' +
            '    cwd=工作目录  user/data=用户级根(~/.harness)  project=项目级根(<cwd>/.harness)\n' +
            '  /workspace help                本帮助\n',
          )
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