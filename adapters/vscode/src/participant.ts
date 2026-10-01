/**
 * Chat Participant：把 A2A 流翻成 `ChatResponseStream`。
 *
 * 两个刻意的设计（设计稿 §4）：
 *
 * 1. **不使用 `request.model`** —— harness 自带 Provider 与 agentic loop，
 *    借 VSCode 的模型等于把 loop 劈成两半。代价要认：Chat 视图的模型下拉对本参与者无效。
 * 2. **权限弹窗必须自己做** —— `lm.registerTool` 的 `prepareInvocation` / `confirmationMessages`
 *    看着像权限确认，但那是"Copilot 编排器调你的工具"的路径；harness 是自己调自己的工具，
 *    编排器不在链路上，那个弹窗**永远不会被触发**。正确落法是模态对话框 + 四态按钮。
 */

import * as vscode from 'vscode'
import { extractTaskIds, mapA2aEvent } from './map/render'
import type { HarnessTransport, RenderOp } from './types'

/** 权限续接的最大轮数（防死循环：每轮一次挂起） */
const MAX_PERMISSION_ROUNDS = 8

export interface ParticipantDeps {
  readonly transport: HarnessTransport
  /** 追踪输出；`harness.trace` 打开时才写字 */
  readonly log?: (msg: string) => void
  /** 是否显示"在思考"之类提示（案 A 下拿不到推理内容，只有规模） */
  readonly traceEnabled?: () => boolean
}

/** 跨轮状态：写进 `ChatResult.metadata`，下轮从 `ChatResponseTurn.result` 读回 */
interface TurnState {
  readonly contextId?: string
  readonly taskId?: string
}

export function createParticipantHandler(deps: ParticipantDeps): vscode.ChatRequestHandler {
  return async (request, context, stream, token) => {
    const log = deps.log ?? (() => {})

    let state = readState(context)
    const controller = new AbortController()
    const abort = () => controller.abort()
    token.onCancellationRequested(abort)

    try {
      await deps.transport.start()

      // 斜杠命令 → 控制通道（设计稿 §6）。它们改的是 sidecar 进程状态，
      // A2A 协议里无处安放，故不走 /a2a。
      const command = request.command
      if (command) {
        return await handleCommand(deps, command, request.prompt, stream)
      }

      let prompt = request.prompt
      let outcome: 'done' | 'cancelled' | 'error' = 'done'

      // 权限续接：挂起 ⇒ 弹窗 ⇒ 把答复当作新一条消息发回（带 taskId + contextId）
      for (let round = 0; round < MAX_PERMISSION_ROUNDS; round++) {
        if (token.isCancellationRequested) {
          outcome = 'cancelled'
          break
        }

        let pending: Extract<RenderOp, { kind: 'permission' }> | undefined
        let textOut = ''

        for await (const frame of deps.transport.send(
          { contextId: state.contextId, taskId: state.taskId },
          prompt,
          controller.signal,
        )) {
          if (deps.traceEnabled?.()) log(`[a2a] ${JSON.stringify(frame)}`)

          const ids = extractTaskIds(frame)
          if (ids.contextId) state = { ...state, contextId: ids.contextId }
          if (ids.taskId) state = { ...state, taskId: ids.taskId }

          const op = mapA2aEvent(frame)
          switch (op.kind) {
            case 'text':
              textOut += op.text
              stream.markdown(op.text)
              break
            case 'progress':
              stream.progress(op.text)
              break
            case 'permission':
              pending = op
              break
            case 'error':
              stream.markdown(`\n\n❌ ${op.message}（code ${op.code}）\n\n`)
              outcome = 'error'
              break
            case 'done':
              if (op.state === 'TASK_STATE_CANCELED') outcome = 'cancelled'
              break
            case 'noop':
              break
          }

          if (op.kind === 'done' || op.kind === 'error') break
        }

        if (token.isCancellationRequested && !pending) {
          // 用户点了停止：显式发一次 CancelTask，让 sidecar 侧也停下来
          // （只 abort 本地流不会让 harness 那一轮结束）。
          if (state.taskId) await deps.transport.cancel(state.taskId).catch(() => {})
          outcome = 'cancelled'
          break
        }

        if (!pending) break

        // ---- 权限待决：弹窗 → 答复 → 续接 ----
        const answer = await askPermission(pending, token)
        if (answer === undefined) {
          stream.markdown('\n\n（已取消授权，本轮结束）\n\n')
          outcome = 'cancelled'
          if (state.taskId) await deps.transport.cancel(state.taskId).catch(() => {})
          break
        }
        prompt = answer
        round++
      }

      if (outcome === 'cancelled') stream.markdown('\n\n_已停止_\n')
      return { metadata: state satisfies TurnState }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      stream.markdown(`\n\n❌ ${msg}\n\n`)
      log(`[error] ${msg}`)
      return { metadata: state }
    } finally {
      token.onCancellationRequested(() => {})
      controller.abort()
    }
  }
}

// ========================================================================
// 权限弹窗（四态）
// ========================================================================

const ANSWER_LABELS: Record<string, string> = {
  allow: '允许一次',
  deny: '拒绝一次',
  'always-allow': '总是允许',
  'always-deny': '总是拒绝',
}

/**
 * 弹模态对话框取四态之一。
 *
 * 返回 `undefined` = 用户关闭 / 取消。选项列表**来自服务端 metadata**
 * （`PERMISSION_ANSWERS`），不在这里写第二份 —— 四态词汇表只有一处定义。
 */
async function askPermission(
  op: Extract<RenderOp, { kind: 'permission' }>,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  const options = op.options.length > 0 ? op.options : ['allow', 'deny']
  const items: vscode.MessageItem[] = options.map((o) => ({ title: ANSWER_LABELS[o] ?? o }))

  const picked = await vscode.window.showInformationMessage(
    `${op.question}\n\n工具：${op.tool}`,
    { modal: true },
    ...items,
  )
  if (token.isCancellationRequested) return undefined
  if (!picked) return undefined

  const idx = items.indexOf(picked)
  return options[idx] ?? undefined
}

// ========================================================================
// 斜杠命令 → 控制通道
// ========================================================================

/** 命令名 → 控制面方法；只有这层知道映射，A2A 协议面不掺和 */
const COMMAND_METHODS: Record<string, string> = {
  stats: 'harness/notice.list',
  notice: 'harness/notice.list',
  sessions: 'harness/session.list',
  agents: 'harness/agent.list',
  skills: 'harness/skill.list',
  permission: 'harness/permission.get',
  model: 'harness/model.get',
}

async function handleCommand(
  deps: ParticipantDeps,
  command: string,
  prompt: string,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  const method = COMMAND_METHODS[command]
  if (!method) {
    stream.markdown(`未知命令 \`/${command}\`。可用：${Object.keys(COMMAND_METHODS).map((c) => `\`/${c}\``).join('、')}`)
    return {}
  }
  try {
    const result = await deps.transport.control(method, prompt.trim() === '' ? {} : { text: prompt })
    stream.markdown(`### /${command}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    stream.markdown(`\n\n❌ \`/${command}\` 失败：${msg}\n\n`)
  }
  return {}
}

// ========================================================================
// 跨轮状态
// ========================================================================

/**
 * 从 Chat 历史里读回上一轮的会话/任务 id。
 *
 * `ChatContext` **只有 `history`，没有 session id**（vscode.d.ts 实测）——
 * 所以跨轮状态只能靠 `ChatResult.metadata` 写、`ChatResponseTurn.result` 读。
 */
function readState(context: vscode.ChatContext): TurnState {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i]
    if (turn instanceof vscode.ChatResponseTurn) {
      const md = turn.result?.metadata as Partial<TurnState> | undefined
      if (md && (md.contextId || md.taskId)) {
        return { contextId: md.contextId, taskId: md.taskId }
      }
    }
  }
  return {}
}
