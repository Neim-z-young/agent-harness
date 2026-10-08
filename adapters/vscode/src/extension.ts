/**
 * 扩展入口：装配 sidecar + 传输 + 参与者 + LM 工具。
 *
 * 装配纪律与 `packages/a2a-server/src/server.ts` 一致：**顺序有讲究** ——
 * 参与者可以先注册（它自己是懒启动的），但传输必须先拿到 sidecar 句柄。
 *
 * P3-D（LM 工具，设计稿 §14）是**唯一在激活期就拉起 sidecar** 的地方：它的调用方是
 * Copilot、发生在参与者轮次之外，注册不能依赖"用户先跟 @harness 说过话"。理由写在
 * `refreshLmTools` 的调用点。
 */

import * as vscode from 'vscode'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { describeBun, resolveBun, type BunResolution } from './bun'
import { buildFollowups, type FollowupsStateLike } from './followups'
import { resolveLaunchOptions, type LaunchOptions } from './launch'
import { ToolRegistrar } from './lm-registrar'
import {
  ApprovalLedger,
  confirmationFor,
  planToolCall,
  renderToolOutcome,
  TOOL_CALL_METHOD,
  TOOL_LIST_METHOD,
  type LmToolSpec,
} from './lmtools'
import { createParticipantHandler } from './participant'
import { SessionTracker } from './session-tracker'
import { Sidecar } from './sidecar'
import { A2aTransport } from './transport/a2a'
import type { HarnessTransport } from './types'
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

  // P3-D（设计稿 §14）：两个**跨轮次**的状态。
  // - sessions：当前会话 —— `lm.invokeTool` 发生在参与者轮次之外，没有 TurnState 可读；
  // - approvals：审批台账 —— 只有"确实弹过框"的调用才带 approve（细节见 lmtools.ts）。
  const sessions = new SessionTracker()
  const approvals = new ApprovalLedger()

  const participant = vscode.chat.createChatParticipant('harness.agent', createParticipantHandler({
    transport,
    timeline,
    sessions,
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

  // ---- P3-D：把 harness 的工具池注册成 LM 工具（设计稿 §14）----
  //
  // 与参与者**有意不同**的一点：这里在激活期就把 sidecar 拉起来。
  // 参与者是懒启动的（首次对话才起），但 P3-D 的前提恰恰是"Copilot 自己编排、
  // 工具调用发生在参与者轮次之外"—— 若注册依赖参与者先跑过一轮，那么
  // "用户从没 @ 过 harness、却让 Copilot 调 harness 工具"这条主路径就永远是死的。
  //
  // 失败一律降级到输出通道：激活期弹错误框是打扰（用户可能根本不用这条线），
  // 而 `[lmtools]` 那几行足以排障；真正的失败在调用时还会以文本回到模型。
  const registrar = new ToolRegistrar({
    list: () => transport.control(TOOL_LIST_METHOD),
    register: (lmName, spec) =>
      vscode.lm.registerTool(lmName, makeHarnessLmTool({ transport, sessions, approvals, spec })),
    // 声明界（见 lm-registrar.ts 文件头第 4 条）：`lm.registerTool` 只接受在
    // `contributes.languageModelTools` 里声明过的名字，而**拒绝是同步 fire-and-forget**、
    // 不会回到扩展宿主 ⇒ 不在这里设界的话，未声明的工具会被我们记成"注册成功"，
    // 同时主进程日志每次激活刷一屏 error（真机 22 条）。
    declared: () => declaredLmToolNames(context),
    log: (m) => channel?.appendLine(m),
  })
  context.subscriptions.push({ dispose: () => registrar.dispose() })
  void refreshLmTools(transport, registrar, (m) => channel?.appendLine(m))

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
      // P3-D：新 sidecar = 新工具池（插件/工具启停都会变）⇒ 重注册一遍。
      // 台账不清：里面的记录代表"用户确实点过 Continue"，与进程无关，且自带 TTL。
      await refreshLmTools(transport, registrar, (m) => channel?.appendLine(m))
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

// ========================================================================
// P3-D：LM 工具（设计稿 §14）
// ========================================================================

/**
 * 拿不到当前会话时的回话。
 *
 * 刻意**不回落** sidecar 的 boot 会话（设计稿 §14.2 ③）：工具执行的遥测、事实事件、
 * 权限询问三处的归属都取 `sessionId`，回落等于把这次调用记到**另一个会话**上。
 * 「归属不明就挑一个」正是本仓反复栽过的那类静默失效，所以这里明确报错并给出补救动作。
 */
const UNBOUND_SESSION_HINT =
  '❌ 还没有 harness 会话可以归属这次调用。请先在 Chat 里对 `@harness` 说一句话'
  + '（或在 `@harness` 里用 `/new`）建立会话，再让我调用 harness 工具。\n\n'
  + '_（这里刻意不猜一个会话出来：工具执行的事件与权限询问都会记到那个会话上，猜错就是静默写错归属。）_'

/**
 * 造一个 LM 工具实现。
 *
 * 为什么每次重注册都要**重新造对象**：LM 工具的元信息（描述 / 入参 schema）全在
 * `package.json` 的 `contributes.languageModelTools` 里，`registerTool` 只提供实现体
 * —— 于是 `spec` 只能闭包捕获，工具集一变就得重造（见 `lm-registrar.ts`）。
 */
function makeHarnessLmTool(deps: {
  readonly transport: HarnessTransport
  readonly sessions: SessionTracker
  readonly approvals: ApprovalLedger
  readonly spec: LmToolSpec
}): vscode.LanguageModelTool<Record<string, unknown>> {
  const { transport, sessions, approvals, spec } = deps
  return {
    /**
     * 唯一确认面（设计稿 §14.2 ②）。
     *
     * 只在 `requiresConfirmation` 时才弹框 —— 它的判据是"工具声明了 `permission`"
     * （= 权限链会启动、可能落到 ask），**不是**"这是个写操作"（只读工具照样可能声明
     * permission，`read_file` 就是），细节见 `tool-exposure.ts`。
     *
     * ⚠️ 这里的 `approvals.note()` 是**有意偏离** `prepareInvocation` 的
     * 「Must be free of side-effects」契约的：不记这一笔，`invoke` 就无法区分
     * "用户点过 Continue" 与 "第三方扩展绕过它直接 invokeTool"。完整论证见 `lmtools.ts`。
     */
    prepareInvocation(options): vscode.PreparedToolInvocation | undefined {
      if (!spec.requiresConfirmation) return undefined
      approvals.note(spec.lmName, options.input)
      return { confirmationMessages: confirmationFor(spec, options.input) }
    },

    async invoke(options, token): Promise<vscode.LanguageModelToolResult> {
      if (token.isCancellationRequested) return textResult('（已取消）')

      const sessionId = sessions.get()
      if (sessionId === undefined) return textResult(UNBOUND_SESSION_HINT)

      // `approve` 的判据只有 `planToolCall` 这一处（它内部消费台账）
      const params = planToolCall(sessionId, spec, options.input, approvals)
      try {
        const raw = await transport.control(TOOL_CALL_METHOD, params)
        return textResult(renderToolOutcome(raw, spec.lmName))
      } catch (e) {
        // 协议级错误（会话不在 / 工具未知 / sidecar 没起来 / 传输失败）也必须是**文本**：
        // 抛出去模型只看到"调用失败"，看不到原因。与工具级失败刻意用不同措辞区分。
        return textResult(protocolFailureText(spec.lmName, e))
      }
    },
  }
}

function textResult(s: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)])
}

/** 协议级失败的措辞：与"工具执行失败"分开说，模型才能分辨"改入参"与"先修环境" */
function protocolFailureText(lmName: string, e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: unknown } | null)?.code
  const suffix = typeof code === 'number' ? `（code ${code}）` : ''
  return `❌ harness 工具 \`${lmName}\` 的**请求**失败（不是工具执行失败）：${message}${suffix}\n\n`
    + '_这多半是：会话已不在、工具不在注册表、或 sidecar 没起来。_'
}

/**
 * 本扩展在 `package.json` 的 `contributes.languageModelTools` 里**声明过**的 LM 工具名。
 *
 * 读的是 `context.extension.packageJson`（VSCode 已经把清单解析好了，不必自己读盘）。
 * **Fail-Closed**：认不出形状 ⇒ 空集合 ⇒ 一个都不注册。
 *
 * 空集合在这里是**安全**的（不是"能力凭空消失"）：VSCode 本来就会拒绝所有未声明的名字，
 * 所以"读不出声明"这条路径上我们没有任何可失去的东西；真正的坏情况是**清单本身为空**
 * （生成没跑 / 被手改坏），那一档由 `ToolRegistrar` 打一条显眼警示（见 `refresh`）。
 */
function declaredLmToolNames(context: vscode.ExtensionContext): ReadonlySet<string> {
  const raw = (context.extension.packageJSON as {
    contributes?: { languageModelTools?: unknown }
  }).contributes?.languageModelTools
  const names = new Set<string>()
  if (!Array.isArray(raw)) return names
  for (const entry of raw) {
    const name = (entry as { name?: unknown } | null | undefined)?.name
    if (typeof name === 'string' && name !== '') names.add(name)
  }
  return names
}

/**
 * 起 sidecar 并刷新 LM 工具注册。
 *
 * **不抛**：两个调用点（激活期、重启 sidecar 后）都不该因为这条线失败而中断 ——
 * 失败的表现只是"Copilot 看不到 `harness_*` 工具"，而那件事已经写进日志了。
 */
async function refreshLmTools(
  transport: HarnessTransport,
  registrar: ToolRegistrar,
  log: (m: string) => void,
): Promise<void> {
  try {
    await transport.start()
    await registrar.refresh()
  } catch (e) {
    log(`[lmtools] 注册失败：${e instanceof Error ? e.message : String(e)}`)
  }
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
