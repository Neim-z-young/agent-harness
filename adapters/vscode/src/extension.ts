/**
 * 扩展入口：装配 sidecar + 传输 + 参与者。
 *
 * 装配纪律与 `packages/a2a-server/src/server.ts` 一致：**顺序有讲究** ——
 * 参与者可以先注册（它自己是懒启动的），但传输必须先拿到 sidecar 句柄。
 */

import * as vscode from 'vscode'
import { existsSync } from 'node:fs'
import { buildFollowups, type FollowupsStateLike } from './followups'
import { resolveLaunchOptions } from './launch'
import { createParticipantHandler } from './participant'
import { Sidecar } from './sidecar'
import { A2aTransport } from './transport/a2a'
import { HarnessPanelProvider, PANEL_VIEW_ID } from './webview/panel'
import { TimelineStore } from './webview/timeline'

let current: { sidecar: Sidecar; transport: A2aTransport } | undefined
let channel: vscode.OutputChannel | undefined

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Agent Harness')
  context.subscriptions.push(channel)

  const sidecar = new Sidecar({
    ...resolveLaunch(context),
    onStderr: (c) => channel?.append(c),
  })
  const transport = new A2aTransport({ sidecar, token: tokenOf() })
  current = { sidecar, transport }

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
    }),
    vscode.commands.registerCommand('harness.restartSidecar', async () => {
      await sidecar.dispose()
      await transport.start()
      void vscode.window.showInformationMessage('Agent Harness：sidecar 已重启')
    }),
  )

  context.subscriptions.push({ dispose: () => void sidecar.dispose() })
}

export function deactivate(): void {
  current = undefined
}

/**
 * 决定"用什么跑 CLI"。
 *
 * 优先级与理由都写在 `launch.ts`（纯模块）：显式配置 > 工作区内的**编译二进制**
 * （P3-A：`bun run build:sidecar` 产出，自包含）> 工作区内的 TS 入口（配 bun）
 * > PATH 上的 `harness`。这里只负责把 vscode 的配置/工作区喂进去。
 */
function resolveLaunch(_context: vscode.ExtensionContext): {
  cliPath: string
  runner?: string
  cwd: string
  token?: string
} {
  const cfg = vscode.workspace.getConfiguration('harness')
  const folders = vscode.workspace.workspaceFolders ?? []
  const cwd = folders[0]?.uri.fsPath ?? process.cwd()

  return resolveLaunchOptions({
    cwd,
    sidecarPath: cfg.get<string>('sidecarPath', ''),
    cliPath: cfg.get<string>('cliPath', ''),
    token: cfg.get<string>('token', ''),
    bun: findBun(),
    exists: (p) => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    },
  })
}

function tokenOf(): string | undefined {
  const t = vscode.workspace.getConfiguration('harness').get<string>('token', '').trim()
  return t === '' ? undefined : t
}

/**
 * 找 bun。
 *
 * 注意：`bun` 常常**不在 extension host 的 PATH 里**（macOS 上 homebrew 装到
 * `/opt/homebrew/bin`，而 GUI 启动的 VSCode 继承的是 login shell 之外的环境）。
 * 故显式列几个常见位置兜底。
 */
function findBun(): string {
  const candidates = ['bun', '/opt/homebrew/bin/bun', '/usr/local/bin/bun', `${process.env['HOME'] ?? ''}/.bun/bin/bun`]
  const fs = require('node:fs') as typeof import('node:fs')
  for (const c of candidates) {
    if (c.includes('/')) {
      try {
        if (fs.existsSync(c)) return c
      } catch {
        continue
      }
    } else {
      return c
    }
  }
  return 'bun'
}
