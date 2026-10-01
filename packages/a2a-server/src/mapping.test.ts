import { describe, it, expect } from 'bun:test'
import { Message, Role, TaskState } from '@a2a-js/sdk'
import type { AgentStreamEvent } from '@harness/core'
import {
  ANSWER_ARTIFACT_NAME,
  PERMISSION_ANSWERS,
  StreamAdapter,
  buildPermissionMetadata,
  buildPermissionQuestion,
  dataPart,
  extractText,
  isTerminalState,
  messageOf,
  parsePermissionAnswer,
  stateFromName,
  stateName,
  textPart,
} from './mapping'

// ========================================================================
// Part / Message：两套表示的坑（plan §3.1.1 第 1 条）
// ========================================================================

describe('Part / Message 的两套表示', () => {
  it('内部表示 ≠ 线上表示：直接把内部表示当线上 JSON 喂回 ⇒ 文本静默丢失', () => {
    const msg = messageOf({ role: 'user', parts: [textPart('hello')] })

    // ✅ 正确出口：走 SDK 的 toJSON
    const wire = Message.toJSON(msg)
    expect((wire as any).parts[0].text).toBe('hello')
    expect(extractText(Message.fromJSON(wire))).toBe('hello')

    // ❌ 错误出口：内部表示 JSON.stringify 出去 —— 不报错，但内容没了
    const wrongWire = JSON.parse(JSON.stringify(msg))
    expect(JSON.stringify(msg)).not.toContain('"text":"hello"')
    expect(extractText(Message.fromJSON(wrongWire))).toBe('')
  })

  it('extractText 跳过非 text part，多段文本拼接', () => {
    const msg = messageOf({ role: 'user', parts: [textPart('a'), dataPart({ x: 1 }), textPart('b')] })
    expect(extractText(msg)).toBe('ab')
    expect(extractText(undefined)).toBe('')
  })

  it('textPart / dataPart 的 mediaType 正确标注', () => {
    expect(textPart('x').mediaType).toBe('text/plain')
    expect(textPart('x').content).toEqual({ $case: 'text', value: 'x' })
    expect(dataPart({ a: 1 }).content).toEqual({ $case: 'data', value: { a: 1 } })
    expect(dataPart({ a: 1 }).mediaType).toBe('application/json')
  })

  it('messageOf 的 role 与 id 缺省填充', () => {
    const u = messageOf({ role: 'user', parts: [textPart('x')] })
    const a = messageOf({ role: 'agent', parts: [textPart('y')] })
    // ⚠️ `Role` 与 `TaskState` 一样是**数字 enum**（`ROLE_USER === 1`），线上才是字符串。
    // 断言写 `'ROLE_USER'` 会失败 —— 这正是那类"读类型定义看不出来"的双重身份。
    expect(typeof Role.ROLE_USER).toBe('number')
    expect(u.role).toBe(Role.ROLE_USER)
    expect(a.role).toBe(Role.ROLE_AGENT)
    // 出口侧 `Message.toJSON` 会把它转成线上字符串
    expect((Message.toJSON(u) as any).role).toBe('ROLE_USER')
    expect(u.messageId.startsWith('msg-')).toBe(true)
    expect(u.messageId).not.toBe(a.messageId)
    expect(u.contextId).toBe('')
    expect(u.extensions).toEqual([])
  })
})

// ========================================================================
// TaskState：数字 enum vs 线上字符串（plan §3.1.1 第 2 条）
// ========================================================================

describe('TaskState 的双重身份', () => {
  it('enum 是数字，线上是字符串 —— 比较必须走 stateName', () => {
    // 这一条把"两套身份"钉住：改 SDK 时若枚举名变了，stateName 会跟着变，
    // 而写死的字符串字面量不会 —— 那正是静默不匹配的来源。
    expect(typeof TaskState.TASK_STATE_COMPLETED).toBe('number')
    expect(stateName(TaskState.TASK_STATE_COMPLETED)).toBe('TASK_STATE_COMPLETED')
    expect(stateName(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(stateFromName('TASK_STATE_COMPLETED')).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('isTerminalState 只认四个终态（INPUT_REQUIRED 不是终态）', () => {
    expect(isTerminalState(TaskState.TASK_STATE_COMPLETED)).toBe(true)
    expect(isTerminalState(TaskState.TASK_STATE_FAILED)).toBe(true)
    expect(isTerminalState(TaskState.TASK_STATE_CANCELED)).toBe(true)
    expect(isTerminalState(TaskState.TASK_STATE_REJECTED)).toBe(true)
    expect(isTerminalState(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe(false)
    expect(isTerminalState(TaskState.TASK_STATE_WORKING)).toBe(false)
  })
})

// ========================================================================
// 权限四态词汇表
// ========================================================================

describe('权限答复词汇表', () => {
  it('四态原样可用（不做第二套翻译）', () => {
    for (const a of PERMISSION_ANSWERS) expect(parsePermissionAnswer(a)).toBe(a)
    expect(PERMISSION_ANSWERS).toHaveLength(4)
  })

  it('等价写法与大小写/空白可识别，无法识别返回 undefined', () => {
    expect(parsePermissionAnswer('  ALWAYS-ALLOW ')).toBe('always-allow')
    expect(parsePermissionAnswer('y')).toBe('allow')
    expect(parsePermissionAnswer('N')).toBe('deny')
    expect(parsePermissionAnswer('a')).toBe('always-allow')
    expect(parsePermissionAnswer('d')).toBe('always-deny')
    expect(parsePermissionAnswer('随便')).toBeUndefined()
    expect(parsePermissionAnswer('')).toBeUndefined()
  })

  it('结构化待决描述带工具名/模式/可选项（标准客户端据此知道答什么）', () => {
    const md = buildPermissionMetadata({ toolKey: 'bash', patterns: ['rm -rf /tmp/x'] })
    expect(md.kind).toBe('permission-request')
    expect(md.tool).toBe('bash')
    expect(md.patterns).toEqual(['rm -rf /tmp/x'])
    expect(md.options).toEqual([...PERMISSION_ANSWERS])
  })

  it('待决问题是人话且列出可选项，无模式时不写空', () => {
    const q = buildPermissionQuestion({ toolKey: 'bash', patterns: [] })
    expect(q).toContain('[bash] (无路径)')
    expect(q).toContain('allow')
    expect(buildPermissionQuestion({ toolKey: 'write_file', patterns: ['a.ts'] })).toContain('[write_file] a.ts')
  })
})

// ========================================================================
// StreamAdapter：合并策略（plan §3.3）
// ========================================================================

/** 把一批流事件喂给 adapter，收集全部输出 */
function drive(adapter: StreamAdapter, events: AgentStreamEvent[]): ReturnType<StreamAdapter['push']> {
  return events.flatMap((e) => adapter.push(e))
}

const textDelta = (text: string): AgentStreamEvent => ({ type: 'text_delta', text })

describe('StreamAdapter 的事件合并', () => {
  it('text_delta 按块合并 —— 绝不每个 delta 发一条', () => {
    const a = new StreamAdapter('t1', 'c1', 400)
    // 20 个 10 字符的 delta = 200 字符 < 400 ⇒ 一条都不发
    const out = drive(a, Array.from({ length: 20 }, () => textDelta('0123456789')))
    expect(out).toHaveLength(0)

    // 再补 25 个 ⇒ 跨过 400 阈值，只发一条（而不是 45 条）
    const out2 = drive(a, Array.from({ length: 25 }, () => textDelta('0123456789')))
    expect(out2).toHaveLength(1)
    expect(out2[0]!.kind).toBe('artifact')
    const ev = out2[0] as { kind: 'artifact'; event: any }
    expect(ev.event.append).toBe(false)
    expect(ev.event.lastChunk).toBe(false)
    expect(ev.event.artifact.parts[0].content.value).toHaveLength(400)
    expect(ev.event.artifact.name).toBe(ANSWER_ARTIFACT_NAME)
  })

  it('后续块带 append:true（同一 artifactId 续写，客户端才不会以为又来了一个新产物）', () => {
    const a = new StreamAdapter('t1', 'c1', 10)
    const out = drive(a, [textDelta('aaaaaaaaaa'), textDelta('bbbbbbbbbb')])
    expect(out).toHaveLength(2)
    const [first, second] = out as Array<{ kind: 'artifact'; event: any }>
    expect(first!.event.append).toBe(false)
    expect(second!.event.append).toBe(true)
    expect(second!.event.artifact.artifactId).toBe(first!.event.artifact.artifactId)
  })

  it('reasoning_delta 不进 artifact，只累计规模', () => {
    const a = new StreamAdapter('t1', 'c1', 1)
    const out = drive(a, [
      { type: 'reasoning_delta', text: '想' },
      { type: 'reasoning_delta', text: '了想' },
    ])
    expect(out).toHaveLength(0)
    expect(a.reasoningLength).toBe(3)
    expect(a.textSoFar).toBe('')
  })

  it('工具开始/结果 → WORKING 状态更新 + 结构化 metadata（不作为 artifact 正文）', () => {
    const a = new StreamAdapter('t1', 'c1')
    const out = drive(a, [
      { type: 'tool_call_start', toolId: 'bash' },
      { type: 'tool_call_result', toolId: 'bash', isError: true },
    ])
    expect(out.map((o) => o.kind)).toEqual(['status', 'status'])
    const [s1, s2] = out as Array<{ kind: 'status'; event: any }>
    expect(s1!.event.status.state).toBe(TaskState.TASK_STATE_WORKING)
    expect(s1!.event.metadata).toEqual({ phase: 'tool-start', tool: 'bash' })
    expect(s2!.event.metadata).toEqual({ phase: 'tool-result', tool: 'bash', isError: true })
  })

  it('step_gate → 心跳状态更新（长等待必须可见）', () => {
    const a = new StreamAdapter('t1', 'c1')
    const out = drive(a, [
      { type: 'step_gate', gate: { waitMs: 3000, waitedMs: 3000, attempt: 1, overBudget: true } },
    ])
    expect(out).toHaveLength(1)
    const ev = (out[0] as { kind: 'status'; event: any }).event
    expect(ev.status.state).toBe(TaskState.TASK_STATE_WORKING)
    expect(ev.metadata.phase).toBe('gate')
    expect(ev.metadata.waitMs).toBe(3000)
    expect(ev.metadata.overBudget).toBe(true)
  })

  it('done（一步结束）冲正文 + 报步号', () => {
    const a = new StreamAdapter('t1', 'c1', 5)
    const out = drive(a, [textDelta('hello world'), { type: 'done', step: 2 }])
    expect(out.map((o) => o.kind)).toEqual(['artifact', 'status'])
    const st = (out[1] as { kind: 'status'; event: any }).event
    expect(st.metadata).toEqual({ phase: 'step', step: 2 })
  })

  it('finish() 补发末尾正文（lastChunk:true）并给终态', () => {
    const a = new StreamAdapter('t1', 'c1', 1000)
    drive(a, [textDelta('短')])
    const out = a.finish(TaskState.TASK_STATE_COMPLETED)
    expect(out.map((o) => o.kind)).toEqual(['artifact', 'status'])
    const art = (out[0] as { kind: 'artifact'; event: any }).event
    expect(art.lastChunk).toBe(true)
    expect(art.append).toBe(false)
    expect(art.artifact.parts[0].content.value).toBe('短')
    const st = (out[1] as { kind: 'status'; event: any }).event
    expect(st.status.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('全程无正文（只有工具活动）⇒ finish 不发空 artifact', () => {
    const a = new StreamAdapter('t1', 'c1')
    drive(a, [{ type: 'tool_call_start', toolId: 'read_file' }])
    const out = a.finish(TaskState.TASK_STATE_COMPLETED)
    expect(out.map((o) => o.kind)).toEqual(['status'])
  })

  it('finish 可携带终态 message 与 metadata（超时/失败的结构化说明走这里）', () => {
    const a = new StreamAdapter('t1', 'c1')
    const msg = messageOf({ role: 'agent', parts: [textPart('超时')] })
    const out = a.finish(TaskState.TASK_STATE_FAILED, msg, { code: 'INPUT_REQUIRED_TIMEOUT' })
    const st = (out[0] as { kind: 'status'; event: any }).event
    expect(st.status.message).toBe(msg)
    expect(st.metadata.code).toBe('INPUT_REQUIRED_TIMEOUT')
  })

  it('turn_end 不冲正文（尾巴统一由 finish 冲，避免重复的最后一块）', () => {
    const a = new StreamAdapter('t1', 'c1', 1000)
    const out = drive(a, [textDelta('尾'), { type: 'turn_end' }])
    expect(out).toHaveLength(0)
    // 尾巴没丢：finish() 会把它作为 lastChunk 发出去
    const fin = a.finish(TaskState.TASK_STATE_COMPLETED)
    expect((fin[0] as { kind: 'artifact'; event: any }).event.artifact.parts[0].content.value).toBe('尾')
  })
})
