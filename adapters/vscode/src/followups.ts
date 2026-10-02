/**
 * Follow-ups（Chat 输入框下方的建议后续问题）—— 纯模块，不 import `vscode`。
 *
 * `provideFollowups(result, context)` 拿到的是**上一轮的 `ChatResult.metadata`**
 * （`ChatFollowupProvider` 契约）。metadata 里只有 TurnState（contextId/taskId/
 * noticesShown），见 `participant.ts` —— 所以建议只能按"有没有活动会话"分档，
 * 不发明它不该知道的更多信息。
 */

export interface FollowupSuggestion {
  /** 直接作为下一条 prompt 发送（可含斜杠命令） */
  readonly prompt: string
  /** 输入框里展示的按钮文案 */
  readonly label: string
}

/** `/new` `/resume` 换会话后给的两条固定建议（与 TurnState 的 commandUsed 无关） */
const SESSION_SWITCHED: readonly FollowupSuggestion[] = [
  { prompt: '概括一下当前会话进展', label: '概括会话进展' },
  { prompt: '/tree', label: '查看工作区文件树' },
]

/** 有活动会话时的常规建议 */
const ACTIVE: readonly FollowupSuggestion[] = [
  { prompt: '继续', label: '继续' },
  { prompt: '/stats', label: '查看用量与占用' },
  { prompt: '/tree', label: '查看文件树' },
]

/** 新线程（无 harness 会话）时的建议 */
const FRESH: readonly FollowupSuggestion[] = [
  { prompt: '介绍你能做什么', label: '介绍能力' },
  { prompt: '/help', label: '查看斜杠命令' },
]

export interface FollowupsStateLike {
  readonly contextId?: string
  /** 参与者在命令轮写回：刚执行过 /new 或 /resume */
  readonly sessionSwitched?: boolean
}

export function buildFollowups(state: FollowupsStateLike | undefined): readonly FollowupSuggestion[] {
  if (state?.sessionSwitched) return SESSION_SWITCHED
  if (state?.contextId) return ACTIVE
  return FRESH
}
