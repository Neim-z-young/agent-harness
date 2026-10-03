/**
 * 扩展入口：装配 sidecar + 传输 + 参与者。
 *
 * 装配纪律与 `packages/a2a-server/src/server.ts` 一致：**顺序有讲究** ——
 * 参与者可以先注册（它自己是懒启动的），但传输必须先拿到 sidecar 句柄。
 */

import * as vscode from 'vscode'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { describeBun, resolveBun, type BunResolution } from './bun'
import { buildFollowups, type FollowupsStateLike } from './followups'
import { resolveLaunchOptions, type LaunchOptions } from './launch'
import { createParticipantHandler } from './participant'
import { Sidecar } from './sidecar'
import { A2aTransport } from './transport/a2a'
import { HarnessPanelProvider, PANEL_VIEW_ID } from './webview/panel'
import { TimelineStore } from './webview/timeline'

let current: { sidecar: Sidecar; transport: A2aTransport } | undefined
let channel: vscode.OutputChannel | undefined

/** 启动路径的完整解析结果（含 bun 从哪来、为什么降级） */
interface ResolvedLaunch {
  readonly options: LaunchOptions
  readonly bun: BunResolution
}

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Agent Harness')
  context.subscriptions.push(channel)

  const resolved = resolveLaunch()
  const { notes, ...launchOpts } = resolved.options
  const sidecar = new Sidecar({
    ...launchOpts,
    onStderr: (c) => channel?.append(c),
  })
  const transport = new A2aTransport({ sidecar, token: tokenOf() })
  current = { sidecar, transport }
  logLaunch(resolved, notes)

  // 显式配了 bunPath 却不存在：必须当场说 —— "改了配置行为没变"是最难查的一类问题
  if (resolved.bun.configInvalid) {
    void vscode.window
      .showWarningMessage('Agent Harness：harness.bunPath 指向的 bun 不存在，已回落自动发现', '打开设置')
      .then((pick) => {
        if (pick === '打开设置') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'harness.bunPath')
        }
      })
  }

  // 块模型时间线（P3-B2）：参与者写、侧栏订阅。同一个 store 注入两处 ——
  // 参与者只认 `TimelineSink` 接口，面板只认 `TimelineStore`，两边都不依赖对方。
  const timeline = new TimelineStore()

  const participant = vscode.chat.createChatParticipant('harness.agent', createParticipantHandler({
    transport,
    timeline,
    log: (m) => channel?.appendLine(m),
    traceEnabled: () => vscode.workspace.getConfiguration('harness').get<boolean>('trace', false),
  }))
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png')
  // Follow-ups（建议后续问题）：纯建议，不碰传输 —— metadata 里有什么就说什么。
  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult): vscode.ChatFollowup[] {
      return buildFollowups(result?.metadata as FollowupsStateLike | undefined).map((f) => ({
        prompt: f.prompt,
        label: f.label,
      }))
    },
  }
  context.subscriptions.push(participant)

  // 侧栏面板（P3-B）：不依赖 Copilot 的那个落点 —— 会话 / 后台任务 / 文件引用 /
  // 统计 / 宿主通知常驻可见，数据全部来自已有控制面 + A2A ListTasks（设计稿 §12）。
  const panel = new HarnessPanelProvider({
    transport,
    timeline,
    extensionUri: context.extensionUri,
    log: (m) => channel?.appendLine(m),
  })
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panel, {
      // 面板重建 DOM 的代价不大，但会话列表滚动位置会丢 ⇒ 保留上下文
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('harness.refreshPanel', () => void panel.refresh()),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('harness.showStatus', () => {
      const hs = sidecar.started ? sidecar.endpoint : undefined
      if (!hs) {
        void vscode.window.showInformationMessage('Agent Harness：sidecar 未启动')
        return
      }
      void vscode.window.showInformationMessage(
        `Agent Harness：pid ${hs.pid} · 端口 ${hs.port} · ${hs.permissionMode} · ${hs.auth}`,
      )
      channel?.appendLine(`[status] ${JSON.stringify(hs)}`)
      channel?.appendLine(`[status] bun: ${describeBun(resolved.bun)}`)
    }),
    vscode.commands.registerCommand('harness.restartSidecar', async () => {
      await sidecar.dispose()
      // **重新解析**：用户刚改的 bunPath / sidecarPath / cliPath 要生效，
      // 否则"重启"只是把旧参数又跑一遍
      const next = resolveLaunch()
      const { notes: nextNotes, ...nextOpts } = next.options
      try {
        sidecar.reconfigure({
          cliPath: nextOpts.cliPath,
          runner: nextOpts.runner,
          cwd: nextOpts.cwd,
          token: nextOpts.token,
        })
      } catch (e) {
        channel?.appendLine(`[launch] reconfigure 失败：${e instanceof Error ? e.message : String(e)}`)
      }
      logLaunch(next, nextNotes)
      await transport.start()
      void vscode.window.showInformationMessage('Agent Harness：sidecar 已重启')
    }),
  )

  // 启动路径配置变了 ⇒ 提供一键重启（A3 下"找不到 bun"多半就靠这一步解决）
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const touched = ['harness.bunPath', 'harness.sidecarPath', 'harness.cliPath'].filter((k) =>
        e.affectsConfiguration(k),
      )
      if (touched.length === 0) return
      void vscode.window
        .showInformationMessage(`Agent Harness：${touched.join(' / ')} 已修改，重启 sidecar 后生效`, '立即重启')
        .then((pick) => {
          if (pick === '立即重启') void vscode.commands.executeCommand('harness.restartSidecar')
        })
    }),
  )

  context.subscriptions.push({ dispose: () => void sidecar.dispose() })
}

export function deactivate(): void {
  current = undefined
}

/**
 * 决定"用什么跑 CLI"，以及"bun 从哪来"。
 *
 * 优先级与理由写在 `launch.ts`（纯模块）：显式配置 > 工作区内的**编译二进制**
 * > 工作区内的 TS 入口（配 bun）> PATH 上的 `harness`。
 *
 * 分发策略是 **A3：扩展包不带二进制**（`bun --compile` 产物 79.9MB 里 60MB 是
 * Bun runtime，随 VSIX 分发不划算）⇒ 找到 bun 是这条链路的**前提条件**，
 * 所以探测单独抽成 `bun.ts` 且同样可单测。
 */
function resolveLaunch(): ResolvedLaunch {
  const cfg = vscode.workspace.getConfiguration('harness')
  const folders = vscode.workspace.workspaceFolders ?? []
  const cwd = folders[0]?.uri.fsPath ?? process.cwd()

  const bun = resolveBun({
    platform: process.platform,
    env: process.env,
    home: process.env['HOME'] ?? homedir(),
    cwd,
    configured: cfg.get<string>('bunPath', ''),
    exists: existsOnDisk,
  })

  const options = resolveLaunchOptions({
    cwd,
    sidecarPath: cfg.get<string>('sidecarPath', ''),
    cliPath: cfg.get<string>('cliPath', ''),
    token: cfg.get<string>('token', ''),
    bun: bun.path,
    exists: existsOnDisk,
  })

  return { options, bun }
}

/**
 * 把解析结果写进输出通道 —— 三条事实：跑什么、经什么跑、为什么降级。
 *
 * 这行日志是 A3 下的**主要排障入口**：失败往往只表现为一句 spawn ENOENT，
 * 而"它当时认为该跑哪个文件"只有这里能回答。
 */
function logLaunch(resolved: ResolvedLaunch, notes: readonly string[] = resolved.options.notes): void {
  const o = resolved.options
  const how = o.runner === undefined ? '直接执行' : `经 ${o.runner}`
  channel?.appendLine(`[launch] sidecar: ${o.cliPath}（${how}）`)
  channel?.appendLine(`[launch] bun: ${describeBun(resolved.bun)}`)
  for (const n of notes) channel?.appendLine(`[launch] ${n}`)
}

function existsOnDisk(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

function tokenOf(): string | undefined {
  const t = vscode.workspace.getConfiguration('harness').get<string>('token', '').trim()
  return t === '' ? undefined : t
}
