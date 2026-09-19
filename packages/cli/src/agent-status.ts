/**
 * Agent 状态显示：把 agentic loop 的事件流归约成「当前 agent 在干什么」。
 *
 * 设计取舍：
 * - **纯函数**（reduceAgentStatus / format*），不碰 IO、不依赖 React —— UI 层（TUI 状态栏、
 *   REPL 统计行）只负责渲染，状态推导可以单测。
 * - 事件流是多步的（A 方案：每步都发 done，末尾发 turn_end），所以状态机必须能表达
 *   「第几步 / 正在执行哪个工具 / 是否被中断」—— 这些正是自主多步上线后用户看不见、
 *   却最想知道的信息（此前 UI 只有 "忙 / 不忙" 两种）。
 *
 * 与 harness 的对应关系：agentId/name/mode 取自 AgentDefinition（Harness.agent.get），
 * 运行态（phase/step/tool）取自 AgentStreamEvent。
 */
import type { AgentStreamEvent } from '@harness/core'

export type AgentPhase =
  /** 空闲：未开始，或整轮已结束（turn_end） */
  | 'idle'
  /** 推理中：收到 reasoning_delta（thinking 模型可见） */
  | 'thinking'
  /** 输出正文：收到 text_delta */
  | 'streaming'
  /** 执行工具：tool_call_start 之后、tool_call_result 之前 */
  | 'tool'
  /** 已中断：done/turn_end 带 aborted */
  | 'aborted'

/** Agent 的静态信息（来自 AgentDefinition） */
export interface AgentIdentity {
  agentId?: string
  agentName?: string
  /** primary / coordinator / subagent */
  mode?: string
}

export interface AgentStatus extends AgentIdentity {
  phase: AgentPhase
  /** 当前步号（从 1 开始，A 方案每步一个 done 事件） */
  step?: number
  /** 正在执行 / 刚执行完的工具 */
  toolId?: string
  /** 末步的结束原因（finish） */
  finish?: string
}

export function initialAgentStatus(identity: AgentIdentity = {}): AgentStatus {
  return { ...identity, phase: 'idle' }
}

/**
 * 事件 → 状态。纯函数：同样输入必得同样输出。
 *
 * 注意 phase 的回落规则：工具执行完（tool_call_result）后回到 'thinking' 而不是 'idle' ——
 * 此时模型仍在本次 Turn 内（可能继续输出或发起下一个工具），只有 turn_end 才代表整轮结束。
 */
export function reduceAgentStatus(prev: AgentStatus, ev: AgentStreamEvent): AgentStatus {
  switch (ev.type) {
    case 'reasoning_delta':
      return { ...prev, phase: 'thinking' }
    case 'text_delta':
      return { ...prev, phase: 'streaming' }
    case 'tool_call_start':
      return { ...prev, phase: 'tool', toolId: ev.toolId }
    case 'tool_call_result':
      // 工具已返回，等待模型下一步（同一 Turn 内）
      return { ...prev, phase: ev.isError ? 'tool' : 'thinking', toolId: ev.toolId ?? prev.toolId }
    case 'done':
      return {
        ...prev,
        step: ev.step ?? prev.step,
        ...(ev.finish ? { finish: ev.finish } : {}),
        ...(ev.aborted ? { phase: 'aborted' as AgentPhase } : {}),
      }
    case 'turn_end':
      // 整轮结束（异常路径也会送达 —— core 用 try/finally 保证）
      return { ...prev, phase: prev.phase === 'aborted' ? 'aborted' : 'idle' }
    default:
      return prev
  }
}

/** 顺序归约整个事件流（便于单测与回放） */
export function reduceAgentStatusAll(
  identity: AgentIdentity,
  events: readonly AgentStreamEvent[],
): AgentStatus {
  return events.reduce(reduceAgentStatus, initialAgentStatus(identity))
}

/** 是否在忙（用于 UI 的 ●/○ 指示与 spinner） */
export function isAgentBusy(s: AgentStatus): boolean {
  return s.phase !== 'idle' && s.phase !== 'aborted'
}

/**
 * 紧凑显示（TUI 状态栏用）：预算很小（状态栏整行需 ≤80 列），只给「干什么」。
 */
export function formatAgentPhase(s: AgentStatus): string {
  switch (s.phase) {
    case 'idle':
      return '空闲'
    case 'thinking':
      return '推理'
    case 'streaming':
      return '输出'
    case 'tool':
      return s.toolId ? `工具·${shorten(s.toolId, 10)}` : '工具'
    case 'aborted':
      return '已中断'
    default:
      return ''
  }
}

/**
 * 详细显示（REPL 统计行 / 侧栏用）：把「哪个 agent + 第几步 + 干什么 + 结束原因」一次说清。
 */
export function formatAgentStatus(s: AgentStatus): string {
  const id = s.agentId ?? 'default'
  const mode = s.mode && s.mode !== 'primary' ? `(${modeText(s.mode)})` : ''
  const parts = [`agent=${id}${mode}`]
  if (s.step != null) parts.push(`第${s.step}步`)
  const phase = formatAgentPhase(s)
  if (phase && s.phase !== 'idle') parts.push(phase)
  if (s.finish && s.phase === 'idle') parts.push(`结束=${s.finish}`)
  return parts.join(' · ')
}

function modeText(mode: string): string {
  switch (mode) {
    case 'coordinator':
      return '编排'
    case 'subagent':
      return '子代理'
    default:
      return mode
  }
}

function shorten(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}
