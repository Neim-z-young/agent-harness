/**
 * 侧栏面板（**本目录唯一碰 `vscode.WebviewView` 的文件**）。
 *
 * 分层纪律（设计稿 §12.3）：拉数据/发消息/执行动作在这里，形状归一是 `state.ts`、
 * 骨架是 `html.ts` —— 那两个都是纯模块，可脱离 VSCode 单测；这里只做编排与副作用。
 *
 * ## 分区独立降级
 * 五个分区**并行**拉取（`Promise.allSettled` 语义），任一失败只降级该分区：
 * 面板要说得出"我这一块为什么是空的"，而不是整块变灰（设计稿 §8）。
 *
 * ## 不做的事（刻意）
 * - **不轮询**：sidecar 没有变更推送，定时拉只会制造噪声。刷新时机 = 首次可见 /
 *   面板内操作后 / 命令 `harness.refreshPanel`。
 * - **不发对话**：那是 Chat 视图的事，面板不搬输入框（避免两条对话入口）。
 */

import * as vscode from 'vscode'
import { createNonce, renderPanelHtml } from './html'
import {
  buildPanelState,
  describePanelAction,
  planPanelAction,
  type PanelState,
} from './state'
import { TIMELINE_FLUSH_MS, TimelineStore, shouldFlush, type TimelineSnapshot } from './timeline'
import type { HarnessTransport } from '../types'

/** 与 `package.json` 的 `views[].id` 一致（改一处要改两处，故写死常量并加守卫用例） */
export const PANEL_VIEW_ID = 'harness.panel'

export interface PanelDeps {
  readonly transport: HarnessTransport
  /** 扩展根目录（`media/` 在它下面） */
  readonly extensionUri: vscode.Uri
  /** 块模型时间线的共享缓冲（参与者写、面板订阅；P3-B2） */
  readonly timeline?: TimelineStore
  /** 追踪输出 */
  readonly log?: (msg: string) => void
}

export class HarnessPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  /** 上一次成功拿到的端点（面板重显时先按它渲染，避免闪"未连接"） */
  private lastEndpoint: unknown
  /** 时间线最近一次快照（视图还没就绪时先存着，就绪即补发） */
  private lastTimeline: TimelineSnapshot | undefined
  /** 时间线上次推送时刻（节流） */
  private lastTimelineFlush = 0
  /** 尾部推送的挂起定时器（保证最后一帧一定送到） */
  private pendingFlush: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: PanelDeps) {
    // 块更新是**流式每帧**的，节流后再推 —— 否则每个 token 都要走一次 postMessage。
    // 但**最后一帧必须送到**（终态块落在节流窗口里就永远不显示了）⇒ 补一个尾部推送。
    this.deps.timeline?.subscribe((snap) => {
      this.lastTimeline = snap
      const now = Date.now()
      if (shouldFlush(now, this.lastTimelineFlush)) {
        this.lastTimelineFlush = now
        this.postTimeline(snap)
        return
      }
      if (this.pendingFlush !== undefined) return
      this.pendingFlush = setTimeout(() => {
        this.pendingFlush = undefined
        this.lastTimelineFlush = Date.now()
        if (this.lastTimeline) this.postTimeline(this.lastTimeline)
      }, TIMELINE_FLUSH_MS)
    })
  }

  // ---------------------------------------------------------------- 生命周期

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = view
    const media = vscode.Uri.joinPath(this.deps.extensionUri, 'media')
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    view.webview.html = renderPanelHtml({
      nonce: createNonce(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      cspSource: view.webview.cspSource,
    })
    view.webview.onDidReceiveMessage((msg: unknown) => {
      void this.handle(msg)
    })
    // 视图刚可见：补发时间线（避免"刚切到面板时时间线是空的"）
    if (this.lastTimeline) this.postTimeline(this.lastTimeline)
    // 前端脚本 load 时也会发一次 refresh；这里是"视图刚可见"的那一发
    void this.refresh()
  }

  // ---------------------------------------------------------------- 刷新

  /** 拉全部分区 → 归一 → 推给前端。失败不成抛：面板自己要能显示"取不到" */
  async refresh(): Promise<void> {
    const view = this.view
    if (!view) return

    this.post(buildPanelState({ loading: true, endpoint: this.lastEndpoint }))

    let endpoint: unknown
    try {
      endpoint = await this.deps.transport.start()
      this.lastEndpoint = endpoint
    } catch (e) {
      this.post(buildPanelState({}))
      this.deps.log?.(`[panel] sidecar 启动失败：${messageOf(e)}`)
      return
    }

    // 四个分区走控制面、任务走 A2A 的 ListTasks（纪律：协议面能表达的不落控制面）
    const [sessionList, stats, tree, notices, tasks] = await Promise.all([
      settled(() => this.deps.transport.control('harness/session.list')),
      settled(() => this.deps.transport.control('harness/stats.get')),
      settled(() => this.deps.transport.control('harness/tree.get')),
      settled(() => this.deps.transport.control('harness/notice.list')),
      settled(() => this.deps.transport.listTasks()),
    ])

    this.post(
      buildPanelState({
        endpoint,
        sessionList: sessionList.value,
        sessionListError: sessionList.error,
        stats: stats.value,
        statsError: stats.error,
        tree: tree.value,
        treeError: tree.error,
        notices: notices.value,
        noticesError: notices.error,
        tasks: tasks.value,
        tasksError: tasks.error,
      }),
    )
  }

  // ---------------------------------------------------------------- 动作

  /** 前端消息 → 纯函数规划 → 执行（执行才有副作用，规划可单测） */
  private async handle(msg: unknown): Promise<void> {
    const action = planPanelAction(msg)
    this.deps.log?.(`[panel] ${describePanelAction(action)}`)

    switch (action.kind) {
      case 'refresh':
        await this.refresh()
        return
      case 'noop':
        return
      case 'clear-timeline':
        // 只清视图：不动会话、不调控制面（清空是 UI 状态，不是 harness 状态）
        this.deps.timeline?.clear()
        return
      case 'open-file':
        try {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(action.path))
        } catch (e) {
          void vscode.window.showErrorMessage(`Agent Harness：打不开 ${action.path} — ${messageOf(e)}`)
        }
        return
      case 'command':
        try {
          await vscode.commands.executeCommand(action.id)
        } catch (e) {
          void vscode.window.showErrorMessage(`Agent Harness：命令 ${action.id} 失败 — ${messageOf(e)}`)
        }
        return
      case 'control': {
        try {
          await this.deps.transport.start()
          const result = await this.deps.transport.control(action.method, action.params)
          if (action.method === 'harness/stats.export') {
            const path = (result as { path?: unknown } | undefined)?.path
            if (typeof path === 'string' && path !== '') {
              void vscode.window.showInformationMessage(`Agent Harness：统计已导出 → ${path}`)
            }
          }
          if (action.refresh) await this.refresh()
        } catch (e) {
          void vscode.window.showErrorMessage(`Agent Harness：${action.label}失败 — ${messageOf(e)}`)
          this.deps.log?.(`[panel] ${action.method} 失败：${messageOf(e)}`)
        }
        return
      }
    }
  }

  private post(state: PanelState): void {
    void this.view?.webview.postMessage({ type: 'state', state })
  }

  /** 时间线走**独立通道**（`state` 重且低频；块轻且高频） */
  private postTimeline(snap: TimelineSnapshot): void {
    void this.view?.webview.postMessage({ type: 'timeline', timeline: snap })
  }
}

// ========================================================================
// 小工具
// ========================================================================

interface Settled<T> {
  readonly value?: T
  readonly error?: string
}

/** 把"可能抛的异步调用"变成"值或原因"（分区级降级的落点） */
async function settled<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await run() }
  } catch (e) {
    return { error: messageOf(e) }
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
