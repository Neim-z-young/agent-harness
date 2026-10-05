/**
 * 权限询问 ⇄ MCP elicitation 的映射（零 IO、纯函数）。
 *
 * ## 为什么这里用**结构化声明**而不 import `@harness/host` 的类型
 * 本包是被宿主 `lazyImport` 的插件，而 `@harness/host` 的 `package.json` 又把本包声明为
 * 依赖（`lazy.ts` 静态表的解析契约）—— 反向 import 会形成**包级循环**。故这里按
 * 结构声明所需字段（duck typing）：宽类型（真实的 `PermissionAskInput` / `PermissionPrompt`）
 * 传进来天然兼容，与 `host/src/permission.ts` 的"依赖倒置、不是第二份定义"是同一手法。
 *
 * ## 安全口径（两条，都是 Fail-Closed）
 * 1. **不提供 `always-allow`**：elicitation 只给"本次允许 / 拒绝"。远端一次误点不该改写
 *    本地持久权限规则（`permissions.json`）—— 那是把安全边界的写权限交给了网络对面。
 * 2. **不支持 / 超时 / 取消 ⇒ 一律拒绝**：拿不到明确答复就是拒绝，不"默认放行"。
 */
import type { ElicitAnswer } from './session'

/** 询问输入面（与 `@harness/host` 的 `PermissionAskInput` 结构兼容） */
export interface AskInputLike {
  toolKey: string
  patterns?: string[]
  sessionId?: string
}

/** 提问材料（与 `@harness/host` 的 `PermissionPrompt` 结构兼容） */
export interface PromptLike {
  toolKey: string
  patterns: string[]
  sessionId?: string
  summary: string
  text: string
}

/** 与 `@harness/host` 的 `PermissionAnswer` 同名同义 */
export type AnswerLike = 'allow' | 'deny' | 'always-allow' | 'always-deny'

/** elicitation 表单里的确认字段名 */
export const ELICIT_CONFIRM_FIELD = 'confirm'

export interface ElicitParams {
  /** 给用户看的一句话（MCP 客户端直接渲染） */
  message: string
  /** 表单 schema：一个布尔确认项 */
  requestedSchema: Record<string, unknown>
}

/**
 * 组装 elicitation 请求参数。
 *
 * `message` 以 `prompt.summary`（如 `权限请求 [bash] rm -rf /tmp/x`）为骨架再补一句
 * "这是本会话的单次授权"，让用户在 IDE 弹窗里就知道**这是谁在问、问了什么、答复的作用域**。
 */
export function buildElicitParams(req: AskInputLike, prompt: PromptLike): ElicitParams {
  const what = prompt.summary || `权限请求 [${req.toolKey}]`
  return {
    message: `${what} —— 是否允许本次操作？（仅本次，不影响本地权限规则）`,
    requestedSchema: {
      type: 'object',
      properties: {
        [ELICIT_CONFIRM_FIELD]: {
          type: 'boolean',
          title: '允许本次操作',
          description: `工具「${req.toolKey}」请求执行；勾选＝允许，不勾＝拒绝。`,
        },
      },
      required: [ELICIT_CONFIRM_FIELD],
    },
  }
}

/**
 * elicitation 答复 → 权限四态答复。
 *
 * - `accept` 且 `confirm === true` ⇒ `allow`
 * - `accept` 但 `confirm` 非 true（含缺字段）⇒ `deny`
 * - `decline` ⇒ `deny`
 * - `cancel` / 其他未知 action ⇒ `undefined`（交给引擎按 deny 处理，与"问不到人"同路径）
 */
export function answerFromElicit(answer: ElicitAnswer | undefined): AnswerLike | undefined {
  if (!answer) return undefined
  switch (answer.action) {
    case 'accept':
      return answer.content?.[ELICIT_CONFIRM_FIELD] === true ? 'allow' : 'deny'
    case 'decline':
      return 'deny'
    default:
      return undefined
  }
}
