/**
 * 块模型时间线（**纯模块，不 import vscode**）。
 *
 * ## 为什么需要它
 * P3-B1 的侧栏只有"结构性事实"（会话 / 任务 / 文件 / 统计），**看不到一轮对话里发生了什么** ——
 * 那些只活在 Chat 视图里，而 Chat 视图要 Copilot 存在。本模块把参与者每轮的
 * `RenderOp` 流累积成**块**，供侧栏以时间线呈现（设计稿 §12.9）。
 *
 * ## 块词汇与 TUI 对齐（这是纪律，不是顺手）
 * `ChatBlockKind`（`packages/cli/src/tui.tsx`）= system / user / thinking / assistant /
 * tool / compact / loadmore —— 本模块的 `PanelBlockKind` 取其中能用的一档，
 * 并**显式列出差异**：
 * | TUI | 本模块 | 说明 |
 * |---|---|---|
 * | `user` / `assistant` / `tool` / `system` | 同名同义 | 平移 |
 * | `thinking` | ❌ 不平移 | **案 A 下推理内容拿不到**（设计稿 §5 已订正：服务端只累计字符数）|
 * | `compact` / `loadmore` | ❌ 不平移 | 终端分页/折叠专属，IDE 里没有对应交互 |
 * | —— | `permission`（新增）| TUI 用控制台文本呈现权限询问；IDE 里它是**模态对话框**，需要单独一类。差异要在文档里写着，不能悄悄不一致 |
 * | —— | `error`（新增）| TUI 把错误混在控制台块里；IDE 里错误要能一眼看到 |
 *
 * ## 为什么时间线是**独立的第二条通道**
 * 块更新是**流式每帧**触发的，而 `PanelState` 是"手动刷新才拉"的重数据（五个控制面）。
 * 混在一份消息里 ⇒ 每个 token 都要重发整份 state。故 `postMessage` 有两类：
 * `{type:'state'}`（重、低频）与 `{type:'timeline'}`（轻、高频、节流后发）。
 */

import type { RenderOp } from '../types'

/** 侧栏时间线的块种类（与 TUI 的 `ChatBlockKind` 对齐，差异见文件头表格） */
export type PanelBlockKind = 'user' | 'assistant' | 'tool' | 'permission' | 'error' | 'system'

export interface PanelBlock {
  readonly id: number
  readonly kind: PanelBlockKind
  readonly text: string
  /** 流式进行中（工具跑完前 / 文本还没 done） */
  readonly streaming?: boolean
  /** 同一句进度被合并的次数（闸门心跳会重复报同一句，不该刷成一长串） */
  readonly repeats?: number
  /** 文本块里识别出的文件引用（点开直达） */
  readonly refs?: readonly string[]
}

export interface TimelineState {
  readonly blocks: readonly PanelBlock[]
  readonly nextId: number
  /** 当前流式 assistant 块的 id（-1 = 无） */
  readonly assistantId: number
  /** 上一个 tool 块的 id（心跳合并用；-1 = 无） */
  readonly toolId: number
  readonly started: boolean
  /** 本轮终态：done 的 state / `cancelled` / `error`；undefined = 进行中 */
  readonly outcome?: string
  readonly streaming: boolean
}

/** 时间线最多保留的块数（长会话不该让 webview 消息无限膨胀） */
export const MAX_TIMELINE_BLOCKS = 200

/** 时间线推送的最小间隔（毫秒）—— 流式每帧都推会把 postMessage 打满 */
export const TIMELINE_FLUSH_MS = 120

export const EMPTY_TIMELINE: TimelineState = {
  blocks: [],
  nextId: 1,
  assistantId: -1,
  toolId: -1,
  started: false,
  streaming: false,
}

/** 是否该推送（纯函数：节流策略可单测） */
export function shouldFlush(now: number, last: number, intervalMs: number = TIMELINE_FLUSH_MS): boolean {
  return last === 0 || now - last >= intervalMs
}

// ========================================================================
// 归约器（纯函数：旧状态 + 事件 → 新状态）
// ========================================================================

/** 开一轮：先落一个 `user` 块（没有它，时间线不知道这一轮是"谁问的"） */
export function startTimeline(s: TimelineState, prompt: string): TimelineState {
  const text = prompt.trim()
  if (text === '') return s
  const withUser = push(s, { id: s.nextId, kind: 'user', text })
  return { ...withUser, started: true, streaming: true, outcome: undefined }
}

/**
 * 一个 `RenderOp` → 新状态。
 *
 * 合并口径（与服务端 `StreamAdapter` 同类选择，不是性能优化）：
 * - 连续 `text` 并进同一个 assistant 块（逐帧增量不该变成 N 个块）；
 * - 连续**同文案**的 `progress` 合并计数（闸门心跳重复报同一句）；
 * - `done` / `error` 收尾：关掉 streaming 并写一个终态 system 块。
 */
export function appendOp(s: TimelineState, op: RenderOp): TimelineState {
  switch (op.kind) {
    case 'noop':
      return s

    case 'text': {
      const last = s.blocks[s.blocks.length - 1]
      if (last && last.id === s.assistantId && last.kind === 'assistant') {
        const refs = op.refs && op.refs.length > 0 ? mergeRefs(last.refs, op.refs) : last.refs
        return replace(s, { ...last, text: last.text + op.text, streaming: true, ...(refs ? { refs } : {}) })
      }
      const block: PanelBlock = {
        id: s.nextId,
        kind: 'assistant',
        text: op.text,
        streaming: true,
        ...(op.refs && op.refs.length > 0 ? { refs: op.refs } : {}),
      }
      return { ...push(s, block), assistantId: block.id, streaming: true }
    }

    case 'progress': {
      const last = s.blocks[s.blocks.length - 1]
      if (last && last.id === s.toolId && last.kind === 'tool' && last.text === op.text) {
        return replace(s, { ...last, repeats: (last.repeats ?? 1) + 1 })
      }
      const block: PanelBlock = { id: s.nextId, kind: 'tool', text: op.text }
      return { ...push(s, block), toolId: block.id }
    }

    case 'permission': {
      const block: PanelBlock = {
        id: s.nextId,
        kind: 'permission',
        text: `权限待决：${op.tool} —— ${op.question}`,
      }
      return { ...push(s, block), assistantId: -1, toolId: -1 }
    }

    case 'error': {
      const block: PanelBlock = {
        id: s.nextId,
        kind: 'error',
        text: `${op.message}（code ${op.code}）`,
      }
      return closeStreaming({ ...push(s, block), assistantId: -1, toolId: -1 }, 'error')
    }

    case 'done': {
      const outcome = op.state === 'TASK_STATE_CANCELED' ? 'cancelled' : op.state
      const withNote = push(s, { id: s.nextId, kind: 'system', text: outcomeText(outcome) })
      return closeStreaming({ ...withNote, assistantId: -1, toolId: -1 }, outcome)
    }

    case 'filetree':
    case 'reference':
      // 这两类在 Chat 视图里是结构化呈现，时间线里没有对应块（信息已在别处可见）
      return s
  }
}

/** 收尾（取消 / 异常退出时也要有个终态，否则前端一直显示"进行中"） */
export function finishTimeline(s: TimelineState, outcome: string): TimelineState {
  return closeStreaming({ ...s, assistantId: -1, toolId: -1 }, outcome)
}

// ========================================================================
// 内部
// ========================================================================

function push(s: TimelineState, block: PanelBlock): TimelineState {
  const blocks = [...s.blocks, block]
  // 环形缓冲：超上限丢最旧（用户块也可能被丢 —— 时间线是"最近若干块"的视图，不是全量会话）
  const trimmed = blocks.length > MAX_TIMELINE_BLOCKS ? blocks.slice(blocks.length - MAX_TIMELINE_BLOCKS) : blocks
  return { ...s, blocks: trimmed, nextId: s.nextId + 1 }
}

function replace(s: TimelineState, block: PanelBlock): TimelineState {
  const idx = s.blocks.findIndex((b) => b.id === block.id)
  if (idx < 0) return s
  const blocks = s.blocks.slice()
  blocks[idx] = block
  return { ...s, blocks }
}

/** 关掉所有 streaming 标记并写终态 */
function closeStreaming(s: TimelineState, outcome: string): TimelineState {
  const blocks = s.blocks.map((b) => (b.streaming === true ? { ...b, streaming: false } : b))
  return { ...s, blocks, outcome, streaming: false }
}

function mergeRefs(a: readonly string[] | undefined, b: readonly string[]): readonly string[] {
  const out = [...(a ?? [])]
  for (const r of b) if (!out.includes(r)) out.push(r)
  return out
}

export function outcomeText(outcome: string): string {
  switch (outcome) {
    case 'cancelled':
      return '已停止'
    case 'error':
      return '失败'
    case 'TASK_STATE_COMPLETED':
      return '完成'
    default:
      return outcome
  }
}

// ========================================================================
// Store（仍不碰 vscode：订阅/推送是纯 JS，只有 `panel.ts` 碰 webview）
// ========================================================================

export interface TimelineSnapshot {
  readonly blocks: readonly PanelBlock[]
  readonly started: boolean
  readonly outcome?: string
  readonly streaming: boolean
}

/** 参与者写入、面板订阅的那一小块共享状态 */
export class TimelineStore {
  private state: TimelineState = EMPTY_TIMELINE
  private readonly listeners = new Set<(snap: TimelineSnapshot) => void>()

  get snapshot(): TimelineSnapshot {
    const s = this.state
    return { blocks: s.blocks, started: s.started, outcome: s.outcome, streaming: s.streaming }
  }

  startTurn(prompt: string): void {
    this.set(startTimeline(this.state, prompt))
  }

  append(op: RenderOp): void {
    this.set(appendOp(this.state, op))
  }

  finish(outcome: string): void {
    this.set(finishTimeline(this.state, outcome))
  }

  clear(): void {
    this.set(EMPTY_TIMELINE)
  }

  subscribe(fn: (snap: TimelineSnapshot) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(next: TimelineState): void {
    this.state = next
    for (const fn of this.listeners) fn(this.snapshot)
  }
}
