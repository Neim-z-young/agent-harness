/**
 * 参与者 handler 的三条真机回归（2026-10-09 真机踩过，见 docs/vscode-chat-sessions-spike.md §5c/§5e）。
 *
 * 这里跑的是**纯 handler**：假 transport + 假 vscode，不起进程。
 *   - **D1**：跨轮带 `taskId` ⇒ 服务端 `-32004 TASK_TERMINAL`（且会被 SSE 解帧吞掉）⇒
 *     轮末 metadata 与 `readState` 两处都不能让它跨轮。
 *   - **E1**：`ask` 模式下模型每调一次工具就是一次询问 ⇒ 必须给**弹窗配额**。
 *   - **E2**：轮数上限退出时若还有待决授权，**必须显式 CancelTask 释放**，绝不能静默丢弃
 *     （丢了 ⇒ 服务端任务永远停在 `INPUT_REQUIRED` ⇒ 该 contextId 之后每条消息都被拒）。
 *
 * `vscode` 模块用 `mock.module` 桩掉：扩展宿主才提供它，测试进程里没有实现。
 * 注意必须**先 mock 再动态 import** —— 静态 import 会被提升到 mock 之前。
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { HarnessTransport, RenderOp } from './types'

/** 已弹过的授权窗（每次调用 `showInformationMessage` 记一条） */
let promptsShown: string[] = []
/** 弹窗返回值：默认选第一个选项（即 `allow`） */
let answerIndex = 0

mock.module('vscode', () => ({
  /** `readState` 用 `instanceof` 判定，必须是个真类 */
  ChatResponseTurn: class ChatResponseTurn {
    constructor(public readonly result?: { metadata?: unknown }) {}
  },
  window: {
    showInformationMessage: async (...args: unknown[]) => {
      const items = args.slice(2) as Array<{ title: string }>
      promptsShown.push(String(args[0]))
      return items[answerIndex]
    },
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}))

const { createParticipantHandler, MAX_PERMISSION_PROMPTS, MAX_PERMISSION_ROUNDS, turnMetadata } = await import(
  './participant'
)

// ---------------------------------------------------------------- 假件

const CTX = 'c1'
const TASK = 't1'

/** 首帧：`{task}` —— 真实一轮的第一帧，也是 `contextId`/`taskId` 的来源 */
function taskFrame(taskId = TASK, contextId = CTX): unknown {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: { task: { id: taskId, contextId, status: { state: 'TASK_STATE_SUBMITTED' } } },
  }
}

function doneFrame(taskId = TASK, contextId = CTX): unknown {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: { statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_COMPLETED' } } },
  }
}

/** 权限待决帧：`INPUT_REQUIRED` + `metadata.kind = permission-request`（与 render.ts 的判据对齐） */
function permissionFrame(taskId = TASK, contextId = CTX): unknown {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: {
      statusUpdate: {
        taskId,
        contextId,
        status: {
          state: 'TASK_STATE_INPUT_REQUIRED',
          message: { parts: [{ kind: 'text', text: '需要授权：bash rm -rf' }] },
        },
        metadata: { kind: 'permission-request', tool: 'bash', options: ['allow', 'deny'] },
      },
    },
  }
}

interface Sent {
  contextId?: string
  taskId?: string
  text: string
}

/** 假 transport：按 `script` 决定每次 send 吐什么帧；记录出参与取消 */
function makeTransport(script: (round: number) => unknown[]): {
  transport: HarnessTransport
  sent: Sent[]
  cancelled: string[]
} {
  const sent: Sent[] = []
  const cancelled: string[] = []
  let round = 0
  const transport = {
    start: async () => {},
    dispose: async () => {},
    cancel: async (taskId: string) => {
      cancelled.push(taskId)
    },
    control: async () => ({}),
    listTasks: async () => ({}),
    send: (ctx: { contextId?: string; taskId?: string }, text: string) => {
      sent.push({ contextId: ctx.contextId, taskId: ctx.taskId, text })
      const frames = script(round++)
      return (async function* () {
        for (const f of frames) yield f
      })()
    },
  } as unknown as HarnessTransport
  return { transport, sent, cancelled }
}

function makeStream(): { parts: Array<{ kind: 'md'; text: string }>; stream: never } {
  const parts: Array<{ kind: 'md'; text: string }> = []
  const stream = {
    markdown: (text: string) => parts.push({ kind: 'md', text }),
    progress: () => {},
    reference: () => {},
    filetree: () => {},
  }
  return { parts, stream: stream as never }
}

function makeToken(): never {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  } as never
}

/** 假 history：`ChatResponseTurn` 实例带上一轮的 metadata */
async function historyWith(metadata: unknown): Promise<unknown> {
  const vscodeMock = await import('vscode')
  const Turn = (vscodeMock as unknown as { ChatResponseTurn: new (r: unknown) => unknown }).ChatResponseTurn
  return { history: [new Turn({ metadata })] }
}

function request(prompt = '你好'): never {
  return { prompt, command: undefined } as never
}

beforeEach(() => {
  promptsShown = []
  answerIndex = 0
})

// ---------------------------------------------------------------- D1

describe('D1：`taskId` 绝不跨轮（跨轮带它 ⇒ -32004，且会被 SSE 解帧吞成 0 帧）', () => {
  it('轮末 metadata 只写 contextId —— 即便本轮帧里带了 taskId', async () => {
    const { transport } = makeTransport(() => [taskFrame(), doneFrame()])
    const handler = createParticipantHandler({ transport })
    const { stream } = makeStream()

    const result = (await handler(request(), await historyWith({}), stream, makeToken())) as {
      metadata?: { contextId?: string; taskId?: string }
    }

    expect(result.metadata?.contextId).toBe(CTX)
    expect(result.metadata?.taskId).toBeUndefined()
  })

  it('★ 上一轮 metadata 里即便残留了 taskId，本轮出参也**不得**带上它', async () => {
    // 这是 D1 的真机形态：readState 曾把上一轮的 taskId 继承进 state，于是下一条消息
    // 带着终态 task 发出去 ⇒ 服务端按 a2a-tck CORE-SEND-002（MUST）拒绝。
    const { transport, sent } = makeTransport(() => [taskFrame(), doneFrame()])
    const handler = createParticipantHandler({ transport })
    const { stream } = makeStream()

    await handler(request(), await historyWith({ contextId: CTX, taskId: TASK }), stream, makeToken())

    expect(sent).toHaveLength(1)
    expect(sent[0]?.contextId).toBe(CTX) // 会话照旧延续
    expect(sent[0]?.taskId).toBeUndefined() // 但 task 绝不跨轮
  })

  it('turnMetadata：剥掉 taskId，其余跨轮字段原样保留（丢 noticesShown 会让自检每轮都弹）', () => {
    expect(turnMetadata({ contextId: CTX, taskId: TASK, noticesShown: true, sessionSwitched: true })).toEqual({
      contextId: CTX,
      taskId: undefined,
      noticesShown: true,
      sessionSwitched: true,
    })
  })

  it('轮内权限续接仍看得见 taskId（只剥跨轮的那一份，别把续接打断）', async () => {
    const { transport, sent } = makeTransport((round) => [round === 0 ? permissionFrame() : taskFrame(), doneFrame()])
    const handler = createParticipantHandler({ transport })
    const { stream } = makeStream()

    await handler(request(), await historyWith({}), stream, makeToken())

    // 第二轮（权限续接）必须仍带同一个 taskId
    expect(sent).toHaveLength(2)
    expect(sent[1]?.taskId).toBe(TASK)
  })
})

// ---------------------------------------------------------------- E1 / E2

describe('E1/E2：弹窗配额 + 到顶 fail-safe 释放会话', () => {
  it('★ 每轮都要求授权时：弹窗 ≤ 配额，但整轮**继续续接**（超配额自动 deny，不是丢请求）', async () => {
    const { transport, sent } = makeTransport(() => [permissionFrame()])
    const handler = createParticipantHandler({ transport })
    const { stream } = makeStream()

    await handler(request(), await historyWith({}), stream, makeToken())

    expect(promptsShown).toHaveLength(MAX_PERMISSION_PROMPTS)
    // 关键：轮次远多于弹窗次数 ⇒ 超配额后仍在续接（自动 deny 让模型看得见"被拒"）
    expect(sent).toHaveLength(MAX_PERMISSION_ROUNDS)
  })

  it('★ 轮数用尽仍有待决授权 ⇒ 发 CancelTask 释放（绝不静默丢弃）', async () => {
    const { transport, sent, cancelled } = makeTransport(() => [permissionFrame()])
    const handler = createParticipantHandler({ transport })
    const { parts, stream } = makeStream()

    const result = (await handler(request(), await historyWith({}), stream, makeToken())) as {
      metadata?: { taskId?: string }
    }

    // 释放动作
    expect(cancelled).toEqual([TASK])
    // 用户看得见的交代（而不是"这一轮结束、什么都没发生"）
    expect(parts.some((p) => p.text.includes('已中止并释放会话'))).toBe(true)
    // 释放之后照样不把 taskId 泄漏到下一轮
    expect(result.metadata?.taskId).toBeUndefined()
    expect(sent).toHaveLength(MAX_PERMISSION_ROUNDS)
  })

  it('授权被拒（用户关掉弹窗）⇒ 立刻 CancelTask 收尾，不再续接', async () => {
    answerIndex = -1 // 模拟 showInformationMessage 返回 undefined（用户取消）
    const { transport, sent, cancelled } = makeTransport(() => [permissionFrame()])
    const handler = createParticipantHandler({ transport })
    const { parts, stream } = makeStream()

    await handler(request(), await historyWith({}), stream, makeToken())

    expect(cancelled).toEqual([TASK])
    expect(sent).toHaveLength(1)
    expect(parts.some((p) => p.text.includes('已取消授权'))).toBe(true)
  })

  it('普通一轮：不进权限分支、不弹窗、也不发 CancelTask', async () => {
    const { transport, sent, cancelled } = makeTransport(() => [taskFrame(), doneFrame()])
    const handler = createParticipantHandler({ transport })
    const { stream } = makeStream()

    await handler(request(), await historyWith({}), stream, makeToken())

    expect(promptsShown).toHaveLength(0)
    expect(cancelled).toHaveLength(0)
    expect(sent).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- 兜底

describe('权限帧 → RenderOp 的判据与用例保持同一份', () => {
  it('permissionFrame 经 mapA2aEvent 确实是 permission 算子（否则上面几条会假绿）', async () => {
    const { mapA2aEvent } = await import('./map/render')
    const op: RenderOp = mapA2aEvent(permissionFrame())
    expect(op.kind).toBe('permission')
  })
})
