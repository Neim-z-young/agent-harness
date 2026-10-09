/**
 * τ³-bench user simulator —— 官方 `src/tau2/user/user_simulator.py` 的 TS 等价实现
 *
 * 独立模型调用（不进 agent 主循环，方案定稿）。对话视图与官方一致：
 * - system：全局 simulation guidelines + <scenario> 任务指令
 * - 历史 flip_roles：agent 的文本回复 → 'user' 角色；模拟客户的发言 → 'assistant' 角色
 *   （模型以 assistant 身份生成客户回复）
 * - 终止 token：###STOP### / ###TRANSFER### / ###OUT-OF-SCOPE###（官方 user_simulator_base）
 *
 * retail 域客户无工具，simulator 不带 tools（官方 use_tools=False 路径）。
 */
import type { ChatProvider, LLMParams, Message } from '@harness/core'
import { loadUserSimGuidelines } from './data'
import type { TauTask } from './types'

export const STOP = '###STOP###'
export const TRANSFER = '###TRANSFER###'
export const OUT_OF_SCOPE = '###OUT-OF-SCOPE###'

export type UserSimTermination = 'stop' | 'transfer' | 'out_of_scope' | null

export interface UserSimUsage {
  calls: number
  inputTokens: number
  outputTokens: number
}

/** 官方 SYSTEM_PROMPT 模板：guidelines + <scenario> 指令 */
function buildSystemPrompt(task: TauTask): string {
  const inst = task.user_scenario.instructions
  const scenario = [
    `task_instructions: ${inst.task_instructions}`,
    `domain: ${inst.domain}`,
    `reason_for_call: ${inst.reason_for_call}`,
    `known_info: ${inst.known_info}`,
    `unknown_info: ${inst.unknown_info}`,
  ].join('\n')
  return `${loadUserSimGuidelines()}\n\n<scenario>\n${scenario}\n</scenario>`
}

function textMessage(id: string, role: 'system' | 'user' | 'assistant', text: string): Message {
  return { id, role, parts: [{ type: 'text', text }] } as Message
}

export class UserSimulator {
  private readonly provider: ChatProvider
  private readonly providerId: string
  private readonly modelId: string
  private readonly systemPrompt: string
  /** flip 后的对话历史（'user'=agent 发言，'assistant'=客户发言） */
  private history: Message[] = []
  usage: UserSimUsage = { calls: 0, inputTokens: 0, outputTokens: 0 }

  constructor(opts: {
    provider: ChatProvider
    providerId: string
    modelId: string
    task: TauTask
  }) {
    this.provider = opts.provider
    this.providerId = opts.providerId
    this.modelId = opts.modelId
    this.systemPrompt = buildSystemPrompt(opts.task)
  }

  /** 响应 agent 的文本回复，生成客户发言；返回文本（可含终止 token） */
  async respondTo(agentText: string): Promise<{ text: string; termination: UserSimTermination }> {
    this.history.push(textMessage(`us-${this.usage.calls}-in`, 'user', agentText))
    const messages: Message[] = [
      textMessage('us-sys', 'system', this.systemPrompt),
      ...this.history,
    ]
    const params: LLMParams = { maxTokens: 1024 }
    const out = await this.provider.complete({
      providerId: this.providerId,
      modelId: this.modelId,
      messages,
      params,
    })
    this.usage.calls += 1
    this.usage.inputTokens += out.tokenUsage?.input ?? 0
    this.usage.outputTokens += out.tokenUsage?.output ?? 0
    const text = out.content?.trim() ?? ''
    this.history.push(textMessage(`us-${this.usage.calls}-out`, 'assistant', text))
    return { text, termination: detectTermination(text) }
  }
}

/** 官方 UserSimulator.is_stop 的 token 判定 */
export function detectTermination(text: string): UserSimTermination {
  if (text.includes(STOP)) return 'stop'
  if (text.includes(TRANSFER)) return 'transfer'
  if (text.includes(OUT_OF_SCOPE)) return 'out_of_scope'
  return null
}
