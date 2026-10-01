/**
 * 扩展入口：装配 sidecar + 传输 + 参与者。
 *
 * 装配纪律与 `packages/a2a-server/src/server.ts` 一致：**顺序有讲究** ——
 * 参与者可以先注册（它自己是懒启动的），但传输必须先拿到 sidecar 句柄。
 */

import * as vscode from 'vscode'
import { createParticipantHandler } from './participant'
import { Sidecar } from './sidecar'
import { A2aTransport } from './transport/a2a'

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

  const participant = vscode.chat.createChatParticipant('harness.agent', createParticipantHandler({
    transport,
    log: (m) => channel?.appendLine(m),
    traceEnabled: () => vscode.workspace.getConfiguration('harness').get<boolean>('trace', false),
  }))
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png')
  context.subscriptions.push(participant)

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
 * harness 是 **Bun**、extension host 是 **Node** —— 这条边界躲不掉（设计稿 §3.1）。
 * 优先级：显式配置 > 工作区内的 `packages/cli/src/index.ts`（配 bun）> PATH 上的 `harness`。
 */
function resolveLaunch(_context: vscode.ExtensionContext): {
  cliPath: string
  runner?: string
  cwd: string
  token?: string
} {
  const cfg = vscode.workspace.getConfiguration('harness')
  const configured = cfg.get<string>('cliPath', '').trim()
  const token = cfg.get<string>('token', '').trim()
  const folders = vscode.workspace.workspaceFolders ?? []
  const cwd = folders[0]?.uri.fsPath ?? process.cwd()

  if (configured !== '') {
    // 显式给了入口：`.ts` 需要 bun 跑，否则当作可执行
    return {
      cliPath: configured,
      runner: configured.endsWith('.ts') ? findBun() : undefined,
      cwd,
      token,
    }
  }

  // 自动探测：本仓布局 `packages/cli/src/index.ts`
  const inRepo = `${cwd}/packages/cli/src/index.ts`
  try {
    if (require('node:fs').existsSync(inRepo)) {
      return { cliPath: inRepo, runner: findBun(), cwd, token }
    }
  } catch {
    /* 忽略：拿不到 fs 就走兜底 */
  }

  return { cliPath: 'harness', cwd, token }
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
