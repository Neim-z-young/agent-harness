/**
 * 渲染映射用例。
 *
 * 输入是 **A2A 线上 JSON**（真机抓包样本），不是 harness 的 `AgentStreamEvent` ——
 * 这条是设计稿 §5 的一处订正：跨进程之后拿到的只能是协议表示。
 */

import { describe, expect, it } from 'bun:test'
import { extractFileRefPaths, extractTaskIds, isTerminalState, mapA2aEvent, textOf } from './render'

const wrap = (result: unknown) => ({ jsonrpc: '2.0', id: 1, result })

describe('mapA2aEvent · 正文', () => {
  it('artifactUpdate ⇒ text 算子', () => {
    const op = mapA2aEvent(
      wrap({
        artifactUpdate: {
          taskId: 't1',
          contextId: 'c1',
          artifact: { artifactId: 'a1', name: 'answer', parts: [{ text: '收到', mediaType: 'text/plain' }] },
          lastChunk: true,
        },
      }),
    )
    expect(op).toEqual({ kind: 'text', text: '收到' })
  })

  it('多 part 拼接（服务端分片增量在 SSE 层已分开，但一条帧内仍可能多个文本 part）', () => {
    const op = mapA2aEvent(
      wrap({ artifactUpdate: { artifact: { name: 'answer', parts: [{ text: 'a' }, { text: 'b' }] } } }),
    )
    expect(op).toEqual({ kind: 'text', text: 'ab' })
  })

  it('非文本产物 ⇒ progress 提示（而不是什么都不显示）', () => {
    const op = mapA2aEvent(
      wrap({ artifactUpdate: { artifact: { name: 'out.txt', parts: [{ mediaType: 'text/plain' }] } } }),
    )
    expect(op.kind).toBe('progress')
  })

  it('SendMessage 返回 Message 时也能取文本', () => {
    const op = mapA2aEvent(wrap({ message: { role: 'agent', parts: [{ text: 'hi' }] } }))
    expect(op).toEqual({ kind: 'text', text: 'hi' })
  })
})

describe('mapA2aEvent · 状态与相位', () => {
  it('首个 task 帧（SUBMITTED）不是终态 ⇒ progress，不能掉进 noop', () => {
    const op = mapA2aEvent(wrap({ task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_SUBMITTED' } } }))
    expect(op.kind).toBe('progress')
  })

  it('WORKING + phase=tool-start ⇒ progress 带工具名', () => {
    const op = mapA2aEvent(
      wrap({ statusUpdate: { status: { state: 'TASK_STATE_WORKING' }, metadata: { phase: 'tool-start', tool: 'bash' } } }),
    )
    expect(op).toEqual({ kind: 'progress', text: '调用工具 bash' })
  })

  it('tool-result 失败要看得出来', () => {
    const op = mapA2aEvent(
      wrap({
        statusUpdate: { status: { state: 'TASK_STATE_WORKING' }, metadata: { phase: 'tool-result', tool: 'bash', isError: true } },
      }),
    )
    expect(op).toEqual({ kind: 'progress', text: '工具 bash 失败' })
  })

  it('gate ⇒ 报已等待 / 计划时长，超预算要标注', () => {
    const op = mapA2aEvent(
      wrap({
        statusUpdate: {
          status: { state: 'TASK_STATE_WORKING' },
          metadata: { phase: 'gate', waitedMs: 3000, plannedMs: 15000, overBudget: true },
        },
      }),
    )
    expect(op).toEqual({ kind: 'progress', text: '已等待 3000/15000ms（已超预算）' })
  })

  it('step ⇒ 报步号', () => {
    const op = mapA2aEvent(
      wrap({ statusUpdate: { status: { state: 'TASK_STATE_WORKING' }, metadata: { phase: 'step', step: 3 } } }),
    )
    expect(op).toEqual({ kind: 'progress', text: '第 3 步' })
  })

  it('未知相位 ⇒ noop（新增相位不该让旧扩展崩）', () => {
    const op = mapA2aEvent(
      wrap({ statusUpdate: { status: { state: 'TASK_STATE_WORKING' }, metadata: { phase: 'future-thing' } } }),
    )
    expect(op.kind).toBe('noop')
  })

  it('COMPLETED ⇒ done', () => {
    const op = mapA2aEvent(wrap({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } }))
    expect(op).toEqual({ kind: 'done', state: 'TASK_STATE_COMPLETED' })
  })
})

describe('mapA2aEvent · 权限挂起', () => {
  const inputRequired = (extra: Record<string, unknown> = {}) =>
    wrap({
      statusUpdate: {
        taskId: 't1',
        contextId: 'c1',
        status: {
          state: 'TASK_STATE_INPUT_REQUIRED',
          message: { role: 'agent', parts: [{ text: '需要授权：[bash] rm -rf\n请以 SendMessage 回复其一：…' }] },
        },
        metadata: { kind: 'permission-request', tool: 'bash', patterns: ['rm -rf'], options: ['allow', 'deny', 'always-allow', 'always-deny'], ...extra },
      },
    })

  it('INPUT_REQUIRED + kind=permission-request ⇒ permission 算子（四态 + 人话）', () => {
    const op = mapA2aEvent(inputRequired())
    expect(op.kind).toBe('permission')
    if (op.kind !== 'permission') return
    expect(op.tool).toBe('bash')
    expect(op.patterns).toEqual(['rm -rf'])
    expect(op.options).toEqual(['allow', 'deny', 'always-allow', 'always-deny'])
    expect(op.question).toContain('需要授权：[bash]')
  })

  it('问题文本取自 status.message.parts（服务端 buildPermissionQuestion 写的）', () => {
    const op = mapA2aEvent(inputRequired())
    if (op.kind !== 'permission') throw new Error('应为 permission')
    expect(op.question.startsWith('需要授权：')).toBe(true)
  })

  it('没有 message 时退化成一句最短可用文案，而不是空白弹窗', () => {
    const op = mapA2aEvent(
      wrap({
        statusUpdate: {
          status: { state: 'TASK_STATE_INPUT_REQUIRED' },
          metadata: { kind: 'permission-request', tool: 'bash' },
        },
      }),
    )
    if (op.kind !== 'permission') throw new Error('应为 permission')
    expect(op.question).toBe('需要授权：[bash]')
  })

  it('INPUT_REQUIRED 是中断态，不是终态 —— 不得被判成 done', () => {
    const op = mapA2aEvent(inputRequired())
    expect(op.kind).toBe('permission')
    expect(isTerminalState('TASK_STATE_INPUT_REQUIRED')).toBe(false)
  })
})

describe('mapA2aEvent · 错误', () => {
  it('JSON-RPC error 帧 ⇒ error 算子（含 code）', () => {
    const op = mapA2aEvent({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32009, message: "The requested A2A protocol version '0.3' is not supported." },
    })
    expect(op).toEqual({ kind: 'error', code: -32009, message: expect.stringContaining('not supported') })
  })

  it('SSE event:error 帧（裸错误对象）也能识别', () => {
    const op = mapA2aEvent({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Task not found' } })
    expect(op.kind).toBe('error')
  })
})

describe('extractTaskIds', () => {
  it('从 task 帧取', () => {
    expect(extractTaskIds(wrap({ task: { id: 't1', contextId: 'c1' } }))).toEqual({ taskId: 't1', contextId: 'c1' })
  })

  it('从 statusUpdate 取', () => {
    expect(extractTaskIds(wrap({ statusUpdate: { taskId: 't2', contextId: 'c2' } }))).toEqual({
      taskId: 't2',
      contextId: 'c2',
    })
  })

  it('从 artifactUpdate 取', () => {
    expect(extractTaskIds(wrap({ artifactUpdate: { taskId: 't3', contextId: 'c3' } }))).toEqual({
      taskId: 't3',
      contextId: 'c3',
    })
  })

  it('裸 StreamResponse（无 jsonrpc 外层）也能取', () => {
    expect(extractTaskIds({ statusUpdate: { taskId: 't4' } })).toEqual({ taskId: 't4' })
  })

  it('取不到就空 —— 绝不发明一个', () => {
    expect(extractTaskIds(wrap({ message: { parts: [] } }))).toEqual({})
  })
})

describe('textOf', () => {
  it('忽略非文本 part', () => {
    expect(textOf([{ text: 'a' }, { mediaType: 'image/png' }, { text: 'b' }])).toBe('ab')
  })
  it('undefined ⇒ 空串', () => {
    expect(textOf(undefined)).toBe('')
  })
})

// ========================================================================
// P2-v2：正文文件引用识别（reference 呈现的数据源）
// ========================================================================

describe('extractFileRefPaths（P2-v2）', () => {
  it('识别带目录前缀的路径，剥 :行:列 后缀去重，限量 8', () => {
    const out = extractFileRefPaths('改了 src/index.ts:12 和 packages/core/src/x.ts，见 docs/guide.md')
    expect(out).toContain('src/index.ts:12')
    expect(out).toContain('packages/core/src/x.ts')
    expect(out).toContain('docs/guide.md')
  })

  it('同一文件不同行号按基础路径去重（保留首次形态）', () => {
    const out = extractFileRefPaths('src/a.ts:1 与 src/a.ts:99')
    expect(out.filter((x) => x.startsWith('src/a.ts'))).toHaveLength(1)
  })

  it('无目录前缀的裸文件名不匹配（与宿主同一口径）', () => {
    expect(extractFileRefPaths('见 package.json 和 README')).toHaveLength(0)
  })
})

describe('正文引用进入 text 算子（P2-v2）', () => {
  it('artifactUpdate 的文本含路径时带回 refs', () => {
    const op = mapA2aEvent({
      artifactUpdate: {
        taskId: 't', contextId: 'c',
        artifact: { artifactId: 'a', name: 'answer', parts: [{ text: '已写入 src/main.ts' }] },
        lastChunk: true,
      },
    })
    expect(op).toMatchObject({ kind: 'text', refs: ['src/main.ts'] })
  })
})
