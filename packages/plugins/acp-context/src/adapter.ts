/**
 * Harness Message[] ↔ acp-kernel CoreMessage[] 双向映射。
 *
 * - toCores：把会话历史压平成 CoreMessage（一条消息 → 0..n 个 core，复合 id `${base}#${i}`），
 *   供 acp-kernel 的 processTurn / applyCompression 消费。每个 core 的 id 通过 idMap 关联回原始 Message，
 *   便于压缩后用"原始对象复用"的方式重建持久化历史。
 * - requestMessages：把 processTurn 返回的 core 列表忠实地重建为"本轮发给模型"的 Message[]
 *   （含工具调用 / 工具结果，provider 序列化兼容）。
 * - compactHistory：把 processTurn 返回的 core 列表重建为"精简持久化"的 Message[]，
 *   未被我方压缩过的原始消息尽量复用对象（保留图片/附件等 part），kernel 生成的摘要块则为新消息。
 */

import type {
  CoreMessage,
  MessageRole as CoreRole,
  MessageContentType,
} from 'acp-kernel'
import type { Message, Part, ToolCallPart, TextPart } from '@harness/session'

const SEP = '#'

/** toCores 的结果：core 列表 + 反查映射 */
export interface Flat {
  cores: CoreMessage[]
  /** core.id → 原始 harness Message */
  byId: Map<string, Message>
  /** 原始 harness Message.id → 其展开出的 core id 列表 */
  byBase: Map<string, string[]>
}

/** 把任意值安全地转成字符串（用于工具入参 / 结果的文本投影） */
export function safeString(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function safeParse(v: string | undefined): unknown {
  if (!v) return {}
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** 提取一条消息的"文本视图"（text + reasoning + 附件占位） */
function renderText(m: Message): string {
  const parts: string[] = []
  for (const p of m.parts) {
    if (p.type === 'text') parts.push((p as TextPart).text)
    else if (p.type === 'reasoning') parts.push(`<reasoning>\n${(p as any).text ?? ''}`)
    else if (p.type === 'file') parts.push(`[file: ${(p as any).path ?? 'inline'}]`)
    else if (p.type === 'image') parts.push(`[image: ${(p as any).path ?? 'inline'}]`)
    else if (p.type === 'patch') parts.push(`[patch: ${(p as any).path ?? 'unknown'}]`)
    else parts.push(`[${p.type ?? 'part'}]`)
  }
  return parts.join('\n')
}

/** 把一个原始 Message.id 消毒成可用于复合 core id 的安全串 */
export function baseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_:\-]/g, '_')
}

/** core.id → 原始 base id */
export function idBase(coreId: string): string {
  const i = coreId.indexOf(SEP)
  return i === -1 ? coreId : coreId.slice(0, i)
}

/** 会话历史 → CoreMessage[] + 反查映射 */
export function toCores(messages: Message[]): Flat {
  const cores: CoreMessage[] = []
  const byId = new Map<string, Message>()
  const byBase = new Map<string, string[]>()
  let idx = 0

  for (const m of messages) {
    const base = m.id
    const expanded: string[] = []

    // 工具调用 / 工具结果：每个 tool part 一个 core
    for (const p of m.parts) {
      if (p.type !== 'tool') continue
      const tp = p as ToolCallPart
      const isResult = tp.result !== undefined
      const id = `${baseId(base)}${SEP}${idx++}`
      expanded.push(id)
      byId.set(id, m)
      cores.push({
        id,
        role: (isResult ? 'tool' : 'assistant') as CoreRole,
        contentType: (isResult ? 'tool-result' : 'tool-call') as MessageContentType,
        text: safeString(isResult ? tp.result : tp.input),
        toolName: tp.toolId,
        toolCallId: tp.toolUseId,
      })
    }

    // 文本/推理/附件：一条消息至多一个 text core（含全部文本视图）
    const text = renderText(m)
    if (text.length > 0 || m.parts.every((p) => p.type !== 'tool')) {
      const id = `${baseId(base)}${SEP}${idx++}`
      expanded.push(id)
      byId.set(id, m)
      cores.push({
        id,
        role: m.role as CoreRole,
        contentType: 'text',
        text,
      })
    }
    if (expanded.length === 0 && byId.size > 0) {
      // 空消息也保留占位，避免丢消息（极罕见）
    }

    byBase.set(baseId(base), expanded)
  }

  return { cores, byId, byBase }
}

/** 由 CoreMessage 重建一个全新的 harness Message（用于 kernel 生成的摘要块等） */
function makeMessageFromCore(core: CoreMessage): Message {
  const parts: Part[] = []
  if (core.contentType === 'tool-call') {
    parts.push({
      type: 'tool',
      toolUseId: core.toolCallId ?? `call_${baseId(core.id)}`,
      toolId: core.toolName ?? '',
      input: safeParse(core.text),
    })
  } else if (core.contentType === 'tool-result') {
    parts.push({
      type: 'tool',
      toolUseId: core.toolCallId ?? `call_${baseId(core.id)}`,
      toolId: core.toolName ?? '',
      result: safeParse(core.text),
    })
  } else if (core.contentType === 'reasoning') {
    parts.push({ type: 'reasoning', text: core.text ?? '' })
  } else {
    parts.push({ type: 'text', text: core.text ?? '' })
  }
  return {
    id: core.id,
    role: (core.role === 'tool' ? 'assistant' : core.role) as Message['role'],
    parts,
    createdAt: Date.now(),
  }
}

/**
 * 把 processTurn 输出的 core 列表重建为"本轮发给模型"的 Message[]（忠实重建，保留工具调用结构）。
 */
export function requestMessages(cores: CoreMessage[]): Message[] {
  return cores.map(makeMessageFromCore)
}

export interface CompactResult {
  messages: Message[]
  /** 是否发生了实际变化（有消息被压缩 / 插入了摘要块） */
  changed: boolean
}

/**
 * 把 processTurn 输出的 core 列表重建为"精简持久化"的 Message[]。
 * 未被压缩的原始消息复用对象（保留图片/附件等 part），压缩掉的原始消息被丢弃，
 * kernel 生成的摘要文本块作为新的 assistant 消息补入。
 */
export function compactHistory(inFlat: Flat, outCores: CoreMessage[]): CompactResult {
  const emittedBase = new Set<string>()
  const messages: Message[] = []
  let changed = false

  for (const core of outCores) {
    const base = idBase(core.id)
    const orig = inFlat.byId.get(core.id)

    if (orig) {
      // 该 core 对应一条原始消息：整条复用（按 base 去重）
      const b = baseId(orig.id)
      if (emittedBase.has(b)) continue
      emittedBase.add(b)
      messages.push(orig)
      continue
    }

    // kernel 生成的新 core（摘要块）：构建新消息
    const b = base
    if (emittedBase.has(b)) continue
    emittedBase.add(b)
    changed = true
    messages.push(makeMessageFromCore(core))
  }

  // 原始 base 中有被压缩丢弃的 → changed
  for (const base of inFlat.byBase.keys()) {
    if (!emittedBase.has(base)) {
      changed = true
      break
    }
  }

  return { messages, changed }
}

/** 估算文本 token 数（chars/4，与 acp-kernel 默认 tokenizer 一致） */
export function estimateTokens(cores: CoreMessage[]): number {
  let n = 0
  for (const c of cores) n += (c.text ?? '').length
  return Math.ceil(n / 4)
}