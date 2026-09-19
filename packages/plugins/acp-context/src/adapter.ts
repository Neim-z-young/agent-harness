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

import {
  countMessageTokens,
  defaultCountTokens,
  type CoreMessage,
  type MessageRole as CoreRole,
  type MessageContentType,
  type TokenCountFn,
} from 'acp-kernel'
import type {
  Message,
  Part,
  ToolCallPart,
  TextPart,
  ReasoningPart,
  FilePart,
  ImagePart,
  PatchPart,
} from '@harness/session'

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

/**
 * 提取一条消息的"文本视图"（text + 附件占位）。
 *
 * **不含 reasoning** —— 推理内容由 toCores 输出为独立的 `contentType: 'reasoning'` core
 * （内核契约，见 reasoning-pairs.d.ts：reasoning 必须与其 assistant 响应成对压缩，
 * 且「每个 adapter 都依赖这个往返契约来重建 reasoning_content」）。若并进 text 视图，
 * 往返后 reasoning part 会降级成 text part，thinking 端点（DeepSeek）要求的
 * `reasoning_content` 回传随之缺失。
 *
 * **不含 tool** —— 工具调用/结果由 toCores 拆成独立的 tool-call/tool-result core。
 * 若在这里输出占位（旧实现会输出 `[tool]`），发给模型的历史里每条工具调用消息都会
 * 跟着一段 `[tool]` 占位文本：模型（DeepSeek 实测）会模仿这种格式、开始在正文里输出
 * `[tool]` 而不是发起真正的 function call，最终无工具调用而终止 —— 表现为
 * 「输出到一半就中断」。真实案例见会话 s_1789516184627_g800t。
 */
function renderText(m: Message): string {
  const parts: string[] = []
  for (const p of m.parts) {
    if (p.type === 'text') parts.push((p as TextPart).text)
    else if (p.type === 'file') parts.push(`[file: ${(p as FilePart).path ?? 'inline'}]`)
    else if (p.type === 'image') parts.push(`[image: ${(p as ImagePart).path ?? 'inline'}]`)
    else if (p.type === 'patch') parts.push(`[patch: ${(p as PatchPart).path ?? 'unknown'}]`)
    // reasoning / tool：各自有专属 core，不进文本视图
    else if (p.type !== 'reasoning' && p.type !== 'tool') parts.push(`[${p.type ?? 'part'}]`)
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

  for (const m of messages) {
    const base = m.id
    const expanded: string[] = []

    // core id 用「消息内 part 的稳定序号」而非跨消息累加计数器：
    // 同一条消息无论出现在"全量历史"还是"窗口切片"（如 core.session.compacting 的
    // runCompacting 会重新 toCores）里，生成的 id 都必须一致 —— 块的
    // effectiveMessageIds / coveredMessageIds 幂等判定 / archive 去重全靠它。
    // 若 id 随输入前缀漂移，covered 判定必然失效（同一窗口被重复折叠、ref 重复分配）。
    let r = 0
    let t = 0

    // 推理内容：独立 core（内核契约）。内核的 reasoning-pairs 保护语义要求 reasoning
    // 是独立的 contentType:'reasoning' 消息、且紧跟它所属的 assistant text/tool-call 之前 ——
    // 折叠范围会把孤儿半边拉进来成对压缩，不拆散。反向映射据此还原 reasoning part，
    // thinking 端点（DeepSeek）的 reasoning_content 回传才不会缺失。
    for (const p of m.parts) {
      if (p.type !== 'reasoning') continue
      const rp = p as ReasoningPart
      if (!rp.text) continue
      const id = `${baseId(base)}${SEP}r${r++}`
      expanded.push(id)
      byId.set(id, m)
      cores.push({
        id,
        role: m.role as CoreRole,
        contentType: 'reasoning' as MessageContentType,
        text: rp.text,
      })
    }

    // 工具调用 / 工具结果：每个 tool part 一个 core
    for (const p of m.parts) {
      if (p.type !== 'tool') continue
      const tp = p as ToolCallPart
      const isResult = tp.result !== undefined
      const id = `${baseId(base)}${SEP}t${t++}`
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

    // 文本/附件：一条消息至多一个 text core（含全部文本视图）
    const text = renderText(m)
    if (text.length > 0 || m.parts.every((p) => p.type !== 'tool')) {
      const id = `${baseId(base)}${SEP}x`
      expanded.push(id)
      byId.set(id, m)
      cores.push({
        id,
        role: m.role as CoreRole,
        contentType: 'text',
        text,
      })
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
 *
 * reasoning 的往返契约（内核 reasoning-pairs.d.ts）：reasoning core 属于**紧随其后的**
 * assistant text/tool-call —— 重建时并回同一条消息的 parts 开头，而不是生成独立消息。
 * 这样 OpenAI 系序列化时 `reasoning_content` 与 `content`/`tool_calls` 出现在同一条
 * assistant 消息里（DeepSeek Thinking Mode 官方样例的形态）；拆开成两条消息的话，
 * 单独的 assistant+reasoning_content 是否被各端点接受并无契约保证。
 */
export function requestMessages(cores: CoreMessage[]): Message[] {
  const out: Message[] = []
  let pendingReasoning: string[] = []
  const flushOrphan = (id: string): void => {
    if (pendingReasoning.length === 0) return
    // 兜底：孤儿 reasoning（内核配对契约下正常不会发生）保留为独立消息，不丢内容
    out.push({
      id: `${id}_reasoning`,
      role: 'assistant',
      parts: [{ type: 'reasoning', text: pendingReasoning.join('\n') }],
      createdAt: Date.now(),
    })
    pendingReasoning = []
  }
  for (const core of cores) {
    if (core.contentType === 'reasoning') {
      if (core.text) pendingReasoning.push(core.text)
      continue
    }
    const msg = makeMessageFromCore(core)
    if (pendingReasoning.length > 0) {
      if (msg.role === 'assistant') {
        msg.parts.unshift({ type: 'reasoning', text: pendingReasoning.join('\n') })
      } else {
        flushOrphan(core.id)
      }
      pendingReasoning = []
    }
    out.push(msg)
  }
  flushOrphan('tail')
  return out
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

/**
 * token 折算口径（CJK 感知）。直接复用 acp-kernel 的 `defaultCountTokens`——
 * 中日韩字符按 **1 token/字**、其余按 **4 字符/token** 记账。
 *
 * 必须与 `createCore({ countTokens })` 注入的是**同一个函数**：内核内部的
 * 可压缩范围、保护区、工具输出截断都用它计数，而插件传给 `processTurn` 的
 * `tokenCount` 决定占用率百分比（`maxContextLimitPct` / `emergencyThresholdPct`）。
 * 两侧口径一旦分裂，闸门就会按一把尺子量、按另一把尺子裁。
 */
export const cjkAwareCountTokens: TokenCountFn = defaultCountTokens

/**
 * 旧口径：一律 `chars/4`。英文与 `cjkAwareCountTokens` 逐位等价，
 * 但中文会话下会把占用率**低估约 4 倍** ⇒ 压缩触发整体偏晚。仅用于回退 / A-B 对照。
 */
export const chars4CountTokens: TokenCountFn = (text: string): number =>
  text ? Math.ceil(text.length / 4) : 0

/**
 * 估算 cores 的总 token 数。
 *
 * 逐条走内核的 `countMessageTokens`（含 `thinkingTokens`），因此与内核内部
 * 各计数点（范围推荐、保护区、status、截断）**完全同口径**。
 *
 * @param countTokens 折算函数，默认 CJK 感知口径；传 `chars4CountTokens` 可回退旧行为。
 */
export function estimateTokens(
  cores: CoreMessage[],
  countTokens: TokenCountFn = defaultCountTokens,
): number {
  let n = 0
  for (const c of cores) n += countMessageTokens(c, countTokens)
  return n
}
