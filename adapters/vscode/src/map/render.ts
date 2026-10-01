/**
 * A2A 事件 → 渲染算子的**纯映射**。
 *
 * 三条纪律：
 *
 * 1. **不 import `vscode`** —— 这样才能单测，也才能在设计稿 §2.5 换传输时不重写。
 * 2. **消费的是 A2A 的线上 JSON，不是 harness 的 `AgentStreamEvent`** —— 跨进程之后
 *    拿到的是什么就是什么。设计稿 §5 原稿按 `AgentStreamEvent` 写是错的，已按此订正。
 * 3. **只产出稳定版 `ChatResponseStream` 表达得出来的算子** —— 稳定版只有 7 个方法，
 *    `thinkingProgress` / `warning` 在 proposed，故推理与警示一律降级成 markdown/progress。
 *
 * 输入形状全部来自实测（`harness a2a` 真起服务抓帧，见设计稿 §9）：
 *
 * ```jsonc
 * {"jsonrpc":"2.0","id":1,"result":{"task":{"id":"…","contextId":"…","status":{"state":"TASK_STATE_SUBMITTED"},"history":[…]}}}
 * {"jsonrpc":"2.0","id":1,"result":{"statusUpdate":{"taskId":"…","contextId":"…","status":{"state":"TASK_STATE_WORKING"},"metadata":{"phase":"tool-start","tool":"bash"}}}}
 * {"jsonrpc":"2.0","id":1,"result":{"artifactUpdate":{"taskId":"…","artifact":{"artifactId":"…","name":"answer","parts":[{"text":"收到","mediaType":"text/plain"}]},"lastChunk":true}}}
 * {"jsonrpc":"2.0","id":1,"result":{"statusUpdate":{"taskId":"…","status":{"state":"TASK_STATE_COMPLETED"}}}}
 * ```
 */

import type { RenderOp } from '../types'

// ========================================================================
// 线上字段的窄类型（只声明用到的，其余一律 unknown）
// ========================================================================

interface WirePart {
  readonly text?: string
  readonly mediaType?: string
}

interface WireMessage {
  readonly parts?: readonly WirePart[]
}

interface WireStatus {
  readonly state?: string
  readonly message?: WireMessage
}

interface WireTask {
  readonly id?: string
  readonly contextId?: string
  readonly status?: WireStatus
}

interface WireArtifact {
  readonly artifactId?: string
  readonly name?: string
  readonly parts?: readonly WirePart[]
}

interface WireStatusUpdate {
  readonly taskId?: string
  readonly contextId?: string
  readonly status?: WireStatus
  readonly metadata?: Record<string, unknown>
}

interface WireArtifactUpdate {
  readonly taskId?: string
  readonly contextId?: string
  readonly artifact?: WireArtifact
  readonly append?: boolean
  readonly lastChunk?: boolean
}

/** 终态集合（A2A v1.0：`INPUT_REQUIRED` 与 `AUTH_REQUIRED` 是**中断态**，不是终态） */
const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
])

// ========================================================================
// 主入口
// ========================================================================

/**
 * 把一条 SSE 帧解析出的对象翻成渲染算子。
 *
 * 既吃 JSON-RPC 响应（`{jsonrpc,id,result|error}`），也吃裸 `StreamResponse`
 * （`{task}` / `{statusUpdate}` / `{artifactUpdate}`）—— 服务端两类都可能出现。
 */
export function mapA2aEvent(frame: unknown): RenderOp {
  if (!isRecord(frame)) return { kind: 'noop' }

  // 协议错误帧（含 SSE 的 `event: error`）—— 统一成 error 算子，不静默丢弃
  const err = frame['error']
  if (isRecord(err)) {
    return {
      kind: 'error',
      code: numOr(err['code'], -32000),
      message: strOr(err['message'], '未知协议错误'),
    }
  }

  const body = isRecord(frame['result']) ? frame['result'] : frame
  return mapStreamResponse(body)
}

/** 裸 `StreamResponse`（`{task}` / `{message}` / `{statusUpdate}` / `{artifactUpdate}`） */
export function mapStreamResponse(body: unknown): RenderOp {
  if (!isRecord(body)) return { kind: 'noop' }

  const artifactUpdate = body['artifactUpdate']
  if (isRecord(artifactUpdate)) return mapArtifactUpdate(artifactUpdate)

  const statusUpdate = body['statusUpdate']
  if (isRecord(statusUpdate)) return mapStatusUpdate(statusUpdate)

  const message = body['message']
  if (isRecord(message)) return mapMessage(message)

  const task = body['task']
  if (isRecord(task)) return mapTask(task)

  return { kind: 'noop' }
}

// ========================================================================
// 分派
// ========================================================================

function mapArtifactUpdate(u: WireArtifactUpdate & Record<string, unknown>): RenderOp {
  const text = textOf(u['artifact']?.['parts'])
  // 没有文本部分的产物（文件/数据 part）当前渲染不出来 —— 用 progress 报一声，
  // 比"什么都不显示、用户以为卡住"强。
  if (text === '') {
    const name = strOr(u['artifact']?.['name'], 'artifact')
    return { kind: 'progress', text: `产出非文本产物：${name}` }
  }
  return { kind: 'text', text }
}

function mapMessage(m: WireMessage & Record<string, unknown>): RenderOp {
  const text = textOf(m['parts'])
  return text === '' ? { kind: 'noop' } : { kind: 'text', text }
}

function mapTask(t: WireTask & Record<string, unknown>): RenderOp {
  // 首个 `task` 帧只是把 id 与 SUBMITTED 状态交给客户端，本身没有可见内容。
  // 但它**必须**被认出来（而不是掉进 noop），否则 `SUBMITTED` 会被误判成终态。
  const state = strOr(t['status']?.['state'], '')
  if (TERMINAL_STATES.has(state)) return { kind: 'done', state }
  return { kind: 'progress', text: '任务已受理' }
}

function mapStatusUpdate(u: WireStatusUpdate & Record<string, unknown>): RenderOp {
  const state = strOr(u['status']?.['state'], '')
  const md = isRecord(u['metadata']) ? u['metadata'] : undefined

  // 权限待决：**先于**终态判定 —— `INPUT_REQUIRED` 是中断态，不是终态，
  // 若先走终态分支（它不在 TERMINAL_STATES 里）会掉进 phase 分支然后变 noop，弹窗就没了。
  if (state === 'TASK_STATE_INPUT_REQUIRED' && md?.['kind'] === 'permission-request') {
    return {
      kind: 'permission',
      tool: strOr(md['tool'], '(未知工具)'),
      patterns: Array.isArray(md['patterns']) ? md['patterns'].map((p) => String(p)) : [],
      options: Array.isArray(md['options']) ? md['options'].map((p) => String(p)) : [],
      // 人话在 `status.message.parts[0].text`（服务端 `buildPermissionQuestion` 写的）；
      // 拿不到时退化成一句最短的可用文案，而不是空白弹窗。
      question:
        textOf(u['status']?.['message']?.['parts']) ||
        `需要授权：[${strOr(md['tool'], '?')}]`,
    }
  }

  if (TERMINAL_STATES.has(state)) return { kind: 'done', state }

  // 中断态里的另一种：`AUTH_REQUIRED`。协议里它不是终态，本扩展暂不支持续接，
  // 但**不能**当成"结束"—— 明确报出来。
  if (state === 'TASK_STATE_AUTH_REQUIRED') {
    return { kind: 'error', code: -32010, message: '需要认证，扩展当前不支持该中断态' }
  }

  return mapWorkingPhase(md)
}

/** `WORKING` 期间的 `metadata.phase`（服务端 `StreamAdapter` 的四个相位） */
function mapWorkingPhase(md: Record<string, unknown> | undefined): RenderOp {
  if (!md) return { kind: 'noop' }

  switch (strOr(md['phase'], '')) {
    case 'tool-start':
      return { kind: 'progress', text: `调用工具 ${strOr(md['tool'], '?')}` }

    case 'tool-result':
      return {
        kind: 'progress',
        text: `工具 ${strOr(md['tool'], '?')} ${md['isError'] === true ? '失败' : '完成'}`,
      }

    case 'gate': {
      // 长等待心跳：等待期间不烧 token，但用户需要知道"没卡死"。
      const waited = numOr(md['waitedMs'], NaN)
      const planned = numOr(md['plannedMs'], NaN)
      const budget = md['overBudget'] === true ? '（已超预算）' : ''
      if (Number.isNaN(waited)) return { kind: 'progress', text: `等待中${budget}` }
      return {
        kind: 'progress',
        text: Number.isNaN(planned)
          ? `已等待 ${waited}ms${budget}`
          : `已等待 ${waited}/${planned}ms${budget}`,
      }
    }

    case 'step':
      return { kind: 'progress', text: `第 ${numOr(md['step'], 0)} 步` }

    default:
      // 未知相位：不报错也不显示 —— 新增相位时不该让旧扩展崩掉。
      return { kind: 'noop' }
  }
}

// ========================================================================
// 小工具
// ========================================================================

/** 取一组 Part 里的全部文本（非文本 part 忽略） */
export function textOf(parts: readonly WirePart[] | undefined): string {
  if (!Array.isArray(parts)) return ''
  let out = ''
  for (const p of parts) {
    if (p && typeof p['text'] === 'string') out += p['text']
  }
  return out
}

/** 终态判定（供参与者决定"这一轮结束了没"） */
export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state)
}

/**
 * 从任一帧里抽出 `taskId` / `contextId`。
 *
 * 为什么要它：跨轮续接与 `CancelTask` 都要 id，而 id 分散在三种帧里 ——
 * `task.id`、`statusUpdate.taskId`、`artifactUpdate.taskId`。
 * 抽不出来就维持旧值，绝不发明一个。
 */
export function extractTaskIds(frame: unknown): { taskId?: string; contextId?: string } {
  if (!isRecord(frame)) return {}
  const body = isRecord(frame['result']) ? frame['result'] : frame

  const t = body['task']
  if (isRecord(t)) {
    return {
      ...(typeof t['id'] === 'string' ? { taskId: t['id'] } : {}),
      ...(typeof t['contextId'] === 'string' ? { contextId: t['contextId'] } : {}),
    }
  }

  for (const key of ['statusUpdate', 'artifactUpdate'] as const) {
    const u = body[key]
    if (!isRecord(u)) continue
    return {
      ...(typeof u['taskId'] === 'string' ? { taskId: u['taskId'] } : {}),
      ...(typeof u['contextId'] === 'string' ? { contextId: u['contextId'] } : {}),
    }
  }
  return {}
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
