/**
 * Chat Participant：把 A2A 流翻成 `ChatResponseStream`。
 *
 * 两个刻意的设计（设计稿 §4）：
 *
 * 1. **不使用 `request.model`** —— harness 自带 Provider 与 agentic loop，
 *    借 VSCode 的模型等于把 loop 劈成两半。代价要认：Chat 视图的模型下拉对本参与者无效。
 * 2. **权限弹窗必须自己做** —— `lm.registerTool` 的 `prepareInvocation` / `confirmationMessages`
 *    看着像权限确认，但那是"Copilot 编排器调你的工具"的路径；**本参与者**是 harness 自己调
 *    自己的工具，编排器不在链路上，所以那个弹窗在这条线上**永远不会被触发**。正确落法是
 *    模态对话框 + 四态按钮。
 *    （P3-D 是**另一条线**：那里 Copilot 是编排方，`prepareInvocation` 正是唯一确认面，
 *     见 `lmtools.ts` 与设计稿 §14.2 ②。两条线刻意不混，本文件一行不改它的机制。）
 */

import * as vscode from 'vscode'
import {
  planCommand,
  renderCommandHelp,
  renderControlResult,
  renderWarnNotices,
  resolveModelSpec,
  resolveSessionSpec,
  type ConfiguredProvider,
  type SessionListEntry,
} from './commands'
import { extractTaskIds, mapA2aEvent } from './map/render'
import type { FileTreeWireNode, HarnessTransport, RenderOp } from './types'

/**
 * 用户最多被问几次授权（**弹窗配额**）。
 *
 * 超过之后**不再打扰用户**，剩余授权请求按 `deny` 自动处理（fail-safe）。为什么必须有这道闸：
 * `permissionMode: ask` 下模型**每调一次工具就是一次询问**，一旦它陷进"工具被拒 ⇒ 换个工具
 * 再试"的循环就会一直弹窗 —— **实测一轮弹过 8 次**（真机记录见
 * `docs/vscode-chat-sessions-spike.md` §5e）。
 */
export const MAX_PERMISSION_PROMPTS = 8

/**
 * 权限续接的轮数**硬**上限（防死循环：每轮一次挂起）。
 *
 * 与 `MAX_PERMISSION_PROMPTS` 的分工：前者只限制"问用户几次"，这条限制"整轮一共能发几次"；
 * 到顶即 fail-safe 收尾。
 *
 * ⚠️ 为什么收尾必须显式做（真机踩过，2026-10-09）：`pending` 原先声明在循环**内部**，
 * 循环因上限退出时那笔待决授权就被**静默丢弃**了 ⇒ 服务端任务永远停在 `INPUT_REQUIRED`，
 * 而它仍算"活跃任务" ⇒ 该 `contextId` 之后**每条消息**都被 `ConcurrentTaskError` 拒
 * （会话卡死，只能重启 sidecar）。**铁律：任何退出路径都不得留下未答复的授权请求。**
 */
export const MAX_PERMISSION_ROUNDS = 40

/**
 * 块模型时间线的写入口（P3-B2）。
 *
 * 参与者**只认这个接口**，不认 `TimelineStore` —— 于是"每轮做了什么"既能喂侧栏，
 * 也能将来喂别的落点（而参与者本身不需要知道谁在消费）。
 */
export interface TimelineSink {
  startTurn(prompt: string): void
  append(op: RenderOp): void
  finish(outcome: string): void
}

/**
 * 会话承载点的**写入口**（P3-D，设计稿 §14.2 ③）。
 *
 * 参与者只认这个接口，不认 `SessionTracker` —— 于是"当前会话"既能喂 P3-D 的 LM 工具
 * （Copilot 编排那条线），也能将来喂别的落点，而参与者本身不需要知道谁在消费。
 *
 * 为什么这里必须写：**Copilot 的 `lm.invokeTool` 发生在参与者轮次之外**，
 * 那时候没有 `ChatContext` / `TurnState` 可读 ⇒ 轮次内不记下来，工具调用就归属不明。
 */
export interface SessionSink {
  /** 记下当前会话；`undefined` / 空串 = 空操作（调用点直接写 `set(ids.contextId)`） */
  set(sessionId: string | undefined): void
}

export interface ParticipantDeps {
  readonly transport: HarnessTransport
  /** 块模型时间线的写入口（侧栏订阅它）；缺省则不记 */
  readonly timeline?: TimelineSink
  /** 当前会话的写入口（P3-D）；缺省则不记 */
  readonly sessions?: SessionSink
  /** 追踪输出；`harness.trace` 打开时才写字 */
  readonly log?: (msg: string) => void
  /** 是否显示"在思考"之类提示（案 A 下拿不到推理内容，只有规模） */
  readonly traceEnabled?: () => boolean
}

/** 跨轮状态：写进 `ChatResult.metadata`，下轮从 `ChatResponseTurn.result` 读回 */
export interface TurnState {
  readonly contextId?: string
  readonly taskId?: string
  /** 启动自检（warn notices）已在本线程展示过 —— 每条线程只提示一次 */
  readonly noticesShown?: boolean
  /** 上一轮刚执行过 /new 或 /resume（follow-ups 换一档建议） */
  readonly sessionSwitched?: boolean
}

/**
 * 轮末要写进 `ChatResult.metadata` 的跨轮状态（纯函数，可单测）。
 *
 * **必须剥掉 `taskId`**：它是**轮内**凭据，只在"回答权限挂起"时成立。上一轮一旦正常结束，
 * 那个任务就是终态，下一条消息带它 ⇒ 服务端按协议拒绝（`-32004 TASK_TERMINAL`，
 * a2a-tck `CORE-SEND-002` 是 MUST）。而只按 SSE 解帧的客户端会把这条错误**吞成 0 帧**
 * 静默成功 —— 表现为"这一轮正常结束、但什么都没有"（传输层已按 content-type 分流，
 * 见 `transport/a2a.ts`；两处必须一起才对得起）。
 *
 * 其余字段（`noticesShown` / `sessionSwitched`）照旧继承 —— 只回 `contextId` 会让
 * "每线程一次"的启动自检变成每轮都弹。
 */
export function turnMetadata(state: TurnState): TurnState {
  return { ...state, taskId: undefined }
}

/**
 * 首帧超时：`send()` 的流在这么久内**一个 SSE 帧都没有** ⇒ 主动 abort。
 *
 * 为什么必须有：UI 上「连接 harness…」是 handler 里**唯一在 `send()` 之前**的 progress，
 * 只要流不吐帧，它就会**无限**停在那儿 —— 既不报错、也不给任何线索（真机踩过，见
 * `docs/vscode-chat-sessions-spike.md` §4）。把它变成明确失败，是「挂住」与「可见故障」的分界线。
 *
 * ⚠️ 这个定时器**不许 `unref`**：被 `await` 的 `setTimeout` 一旦 `unref`，在 Bun/Windows 上
 * 会出现"事件循环里只剩 unref 的工作"⇒ 定时器永不到期 ⇒ 静默挂死。清理由 `finally` 与
 * 首帧到达两条路径保证。
 */
export const FIRST_FRAME_TIMEOUT_MS = 15_000

/**
 * 本轮诊断埋点。**刻意不受 `harness.trace` 门控** —— 这些行是排障判据本身：
 * 缺 `◀` 的那一轮就是卡住的那一轮（真机三次卡死都是靠它把范围缩到单轮）。
 */
function turnLog(deps: ParticipantDeps, msg: string): void {
  deps.log?.(`[turn] ${msg}`)
}

/** prompt 的展示长度（埋点里不放整段长文，否则一行刷满输出通道） */
function brief(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function createParticipantHandler(deps: ParticipantDeps): vscode.ChatRequestHandler {
  return async (request, context, stream, token) => {
    const log = deps.log ?? (() => {})

    let state = readState(context)
    const controller = new AbortController()
    const abort = () => controller.abort()
    token.onCancellationRequested(abort)

    // 本轮诊断埋点的四个状态量（声明在最外层，catch/finally 也要读得到）
    const t0 = Date.now()
    /** 本轮收到的 SSE 帧总数（含权限续接的各段）—— 用来抓「0 帧却报成功」 */
    let totalFrames = 0
    /** 首帧守卫的定时器；`undefined` = 已清或未建（见 FIRST_FRAME_TIMEOUT_MS） */
    let guard: ReturnType<typeof setTimeout> | undefined
    /** 是不是**我们自己的**首帧守卫中止的（区别于用户点停止） */
    let firstFrameTimedOut = false

    try {
      await deps.transport.start()

      // 启动自检（设计稿 §8）：每条线程首轮把 sidecar 的 warn 级降级事实亮出来。
      // 失败静默 —— 自检永远不能挡住正常对话。
      if (!state.noticesShown) {
        state = { ...state, noticesShown: true }
        try {
          const notices = (await deps.transport.control('harness/notice.list', { level: 'warn' })) as {
            notices?: Array<{ text?: unknown }>
          }
          const texts = (notices?.notices ?? [])
            .map((n) => n.text)
            .filter((t): t is string => typeof t === 'string' && t !== '')
          if (texts.length > 0) stream.markdown(renderWarnNotices(texts))
        } catch (e) {
          log(`[self-check] notice.list 失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 斜杠命令 → 控制通道（设计稿 §6）。它们改的是 sidecar 进程状态，
      // A2A 协议里无处安放，故不走 /a2a。
      const command = request.command
      if (command) {
        return await handleCommand(deps, command, request.prompt, stream, state)
      }

      let prompt = request.prompt
      let outcome: 'done' | 'cancelled' | 'error' = 'done'
      // 时间线：本轮的"块"从这里开始累积（侧栏订阅它 —— 设计稿 §12.9）
      deps.timeline?.startTurn(prompt)

      turnLog(deps, `▶ turn "${brief(prompt)}"`)

      /**
       * 待决的授权请求。**声明在循环外**：循环可能因上限退出，那时必须还能看见它、
       * 并把它关掉（见 `MAX_PERMISSION_ROUNDS` 的说明）。
       */
      let pending: Extract<RenderOp, { kind: 'permission' }> | undefined
      /** 已经弹过几次授权窗（配额见 `MAX_PERMISSION_PROMPTS`） */
      let prompts = 0

      // 权限续接：挂起 ⇒ 弹窗 ⇒ 把答复当作新一条消息发回（带 taskId + contextId）
      for (let round = 0; round < MAX_PERMISSION_ROUNDS; round++) {
        if (token.isCancellationRequested) {
          outcome = 'cancelled'
          break
        }

        pending = undefined
        let textOut = ''

        // 首帧守卫（理由见 FIRST_FRAME_TIMEOUT_MS 定义处）
        let sawFrame = false
        if (guard !== undefined) clearTimeout(guard)
        guard = setTimeout(() => {
          if (sawFrame) return
          firstFrameTimedOut = true
          turnLog(
            deps,
            `✗ 首帧超时：${FIRST_FRAME_TIMEOUT_MS}ms 内没有任何 SSE 帧 ⇒ 主动 abort`
              + '（请求多半没真正发出去：调试器 / 网络检查拦截、代理，或 fetch 层问题）',
          )
          controller.abort()
        }, FIRST_FRAME_TIMEOUT_MS)

        turnLog(deps, `▶ send round=${round} ctx=${state.contextId ?? '-'} task=${state.taskId ?? '-'}`)

        for await (const frame of deps.transport.send(
          { contextId: state.contextId, taskId: state.taskId },
          prompt,
          controller.signal,
        )) {
          if (deps.traceEnabled?.()) log(`[a2a] ${JSON.stringify(frame)}`)

          const ids = extractTaskIds(frame)
          if (ids.contextId) {
            state = { ...state, contextId: ids.contextId }
            // 会话归属同步给 P3-D（Copilot 编排那条线在轮次之外用它）
            deps.sessions?.set(ids.contextId)
          }
          if (ids.taskId) state = { ...state, taskId: ids.taskId }

          const op = mapA2aEvent(frame)
          // Chat 视图与时间线**同一份映射**（一份真相，两个落点）
          deps.timeline?.append(op)
          totalFrames++
          if (!sawFrame) {
            sawFrame = true
            if (guard !== undefined) {
              clearTimeout(guard)
              guard = undefined
            }
            turnLog(deps, `▶ 首帧到达 (+${Date.now() - t0}ms)`)
          }
          switch (op.kind) {
            case 'text':
              textOut += op.text
              stream.markdown(op.text)
              // 正文里识别出的文件引用 → Chat 引用区（点开即达）。
              // 相对路径按工作区根解析；sidecar cwd 可能与工作区根不同（--cwd），以它为准。
              for (const ref of op.refs ?? []) {
                const uri = resolveRefUri(ref)
                if (uri) stream.reference(uri)
              }
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
        //
        // 配额用尽后**不再打扰用户**，直接按 `deny` 处理：既让整轮能走到终态，又不至于把用户
        // 按在弹窗上。注意仍走同一轮续接（`prompt = answer`），所以模型看得见"被拒绝"并据此
        // 调整 —— **不是把请求丢掉**（丢掉就会卡死会话，见 MAX_PERMISSION_ROUNDS）。
        let answer: string | undefined
        if (prompts < MAX_PERMISSION_PROMPTS) {
          prompts++
          answer = await askPermission(pending, token)
        } else {
          answer = 'deny'
          log(`[permission] 授权提示已达 ${MAX_PERMISSION_PROMPTS} 次，本轮起自动 deny（不再弹窗）`)
        }
        if (answer === undefined) {
          stream.markdown('\n\n（已取消授权，本轮结束）\n\n')
          outcome = 'cancelled'
          if (state.taskId) await deps.transport.cancel(state.taskId).catch(() => {})
          // ★ 这一笔授权已经用 CancelTask 答复过了 ⇒ 必须清掉，否则轮末的 fail-safe 会
          // **再发一次 CancelTask**，并把"用户主动取消"误报成"连续 N 轮授权询问仍未结束"。
          //（fail-safe 的语义是"轮数用尽仍待决"，只该在那一种情形下触发。）
          pending = undefined
          break
        }
        prompt = answer
      }

      if (outcome === 'cancelled') stream.markdown('\n\n_已停止_\n')

      // ★ 绝不能留着未答复的授权请求就走人（理由见 `MAX_PERMISSION_ROUNDS`）：
      // 服务端那个任务会永远停在 `INPUT_REQUIRED`，而它仍算"活跃任务" ⇒ 整个会话之后发什么都
      // 报 `ConcurrentTaskError`。走到这里说明硬上限都到顶了，直接 CancelTask 把它释放
      //（`SuspendTable.cancel` 会唤醒挂起方，跑完最后一段并落到终态）。
      if (pending !== undefined) {
        log(`[permission] 续接轮数用尽（${MAX_PERMISSION_ROUNDS} 轮）仍有一笔待决授权 ⇒ 发 CancelTask 释放会话`)
        if (state.taskId) await deps.transport.cancel(state.taskId).catch(() => {})
        stream.markdown(
          `\n\n（连续 ${MAX_PERMISSION_ROUNDS} 轮授权询问仍未结束，已中止并释放会话；可以直接继续对话）\n\n`,
        )
        outcome = 'error'
      }

      deps.timeline?.finish(outcome === 'done' ? 'completed' : outcome)
      turnLog(
        deps,
        `◀ turn 结束 outcome=${outcome} frames=${totalFrames}`
          + ` (+${Date.now() - t0}ms tokenCancelled=${token.isCancellationRequested})`,
      )
      // 0 帧是**异常**：正常一轮的首帧一定是 `{task: SUBMITTED}`。
      // 0 帧 = 服务端连流都没开 —— 典型是预流错误（HTTP 200 + application/json）被吞成
      // 静默成功。没有这行告警时，它会伪装成"正常结束、只是没有输出"，极难归因。
      if (totalFrames === 0) {
        turnLog(
          deps,
          '⚠️ 本轮 0 帧：服务端未开流（多为预流错误，HTTP 200 + application/json）'
            + ' ⇒ 检查 transport/a2a.ts 的「非 SSE 分流」分支是否生效',
        )
      }
      return { metadata: turnMetadata(state) }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      stream.markdown(`\n\n❌ ${msg}\n\n`)
      log(`[error] ${msg}`)
      turnLog(deps, `◀ turn 结束 outcome=error frames=${totalFrames} (+${Date.now() - t0}ms)`)
      if (firstFrameTimedOut) {
        // 是我们自己的首帧守卫中止的：给一句能照做的中文，而不是一个英文 AbortError
        stream.markdown(
          `\n\n（${FIRST_FRAME_TIMEOUT_MS}ms 内没有等到任何响应，已主动中止；`
            + '详见输出通道 "Agent Harness"）\n\n',
        )
      }
      // 异常退出也要收尾：否则时间线永远显示"进行中"
      deps.timeline?.finish('error')
      // 失败路径同样只回写跨轮状态（`taskId` 绝不跨轮，见 turnMetadata）
      return { metadata: turnMetadata(state) }
    } finally {
      // 守卫必须在这里清：否则一个 15s 的定时器会把宿主/测试进程钉住
      //（⚠️ 不许用 unref 代替清理，见 FIRST_FRAME_TIMEOUT_MS 的说明）
      if (guard !== undefined) clearTimeout(guard)
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

/**
 * 命令执行（设计稿 §6.4）。解析在 `commands.ts`（纯模块）；这里只编排：
 *
 * - 普通 `call` → `transport.control` → `renderControlResult`；
 * - `/model <spec>` 两段协议：`model.get` 拿清单 → 扩展端消解 → `model.set`；
 * - `/resume <spec>` 两段协议：`session.list` 拿清单 → 消解序号 → `session.resume`；
 * - `/tree`：结构化节点 → `stream.filetree`（这是稳定 API 的目录树呈现落点）；
 * - `/stats-export`：`stream.reference` 指到导出文件（P2-v2 的 reference 落点）；
 * - `/new` `/resume` 成功后**换绑 TurnState**：contextId = 新 sessionId、taskId 清空 ——
 *   否则下一轮还在跟旧会话说话。
 * - 命令轮同样把 `TurnState`（含 noticesShown）写回 metadata。
 */
async function handleCommand(
  deps: ParticipantDeps,
  command: string,
  prompt: string,
  stream: vscode.ChatResponseStream,
  state: TurnState,
): Promise<vscode.ChatResult> {
  const plan = planCommand(command, prompt)

  if (plan.kind === 'unknown') {
    stream.markdown(`❌ ${plan.message}\n\n${renderCommandHelp()}`)
    return { metadata: state }
  }
  if (plan.kind === 'local') {
    stream.markdown(`### /${command}\n\n${plan.message}`)
    return { metadata: state }
  }

  try {
    let contextBinding: string | undefined

    if (plan.kind === 'model-resolve') {
      // 两段：get 清单 → 扩展端消解 → set
      const info = (await deps.transport.control('harness/model.get', {})) as {
        configured?: ConfiguredProvider[]
      }
      const resolved = resolveModelSpec(plan.spec, info?.configured ?? [])
      if (typeof resolved === 'string') {
        stream.markdown(`❌ /model ${plan.spec}：${resolved}\n\n_用 \`/model\` 查看可选清单。_`)
        return { metadata: state }
      }
      stream.markdown(renderControlResult('model', await deps.transport.control('harness/model.set', resolved)))
    } else if (plan.kind === 'session-resolve') {
      // 两段：session.list → 序号消解 → session.resume
      const list = (await deps.transport.control('harness/session.list', {})) as unknown
      const entries = asSessionEntries(list)
      const resolved = resolveSessionSpec(plan.spec, entries)
      if (typeof resolved === 'string') {
        stream.markdown(`❌ /resume ${plan.spec}：${resolved}\n\n_用 \`/sessions\` 查看会话清单。_`)
        return { metadata: state }
      }
      const result = await deps.transport.control('harness/session.resume', { id: resolved.id })
      stream.markdown(renderControlResult('resume', result))
      contextBinding = (result as { sessionId?: unknown })?.sessionId !== undefined
        ? String((result as { sessionId?: unknown }).sessionId)
        : undefined
    } else {
      const result = await deps.transport.control(plan.call.method, plan.call.params)
      stream.markdown(renderControlResult(command, result))

      // 附加呈现（结构化 part，不走 markdown）
      if (command === 'tree') {
        const r = result as { root?: unknown; nodes?: unknown }
        if (typeof r?.root === 'string' && Array.isArray(r.nodes)) {
          stream.filetree(toFileTree(r.nodes as FileTreeWireNode[]), vscode.Uri.file(r.root))
        }
      }
      if (command === 'stats-export') {
        const r = result as { path?: unknown }
        if (typeof r?.path === 'string' && r.path !== '') stream.reference(vscode.Uri.file(r.path))
      }

      // 换绑会话的命令：/new /resume 出参都带 sessionId（= A2A contextId）
      if (plan.affectsContext || command === 'new' || command === 'resume') {
        const sid = (result as { sessionId?: unknown })?.sessionId
        if (typeof sid === 'string' && sid !== '') contextBinding = sid
      }
    }

    if (contextBinding) {
      state = { ...state, contextId: contextBinding, taskId: undefined, sessionSwitched: true }
      // /new 或 /resume 成功后换绑会话归属（P3-D）：LM 工具随后的调用要落到**新**会话上
      deps.sessions?.set(contextBinding)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    stream.markdown(`\n\n❌ \`/${command}\` 失败：${msg}\n\n`)
  }
  // 命令轮同样只回写跨轮状态（`taskId` 绝不跨轮，见 turnMetadata）
  return { metadata: turnMetadata(state) }
}

// ========================================================================
// 呈现辅助
// ========================================================================

/** `harness/session.list` 的线上形状（数组或 { sessions: [...] } 都收）→ 消解入参 */
function asSessionEntries(list: unknown): SessionListEntry[] {
  const arr = Array.isArray(list)
    ? list
    : Array.isArray((list as { sessions?: unknown })?.sessions)
      ? (list as { sessions: unknown[] }).sessions
      : []
  return arr.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>
    return {
      index: typeof o['index'] === 'number' ? o['index'] : i + 1,
      id: String(o['id'] ?? o['sessionId'] ?? ''),
      title: typeof o['title'] === 'string' ? o['title'] : null,
      updatedAt: typeof o['updatedAt'] === 'number' ? o['updatedAt'] : undefined,
      messageCount: typeof o['messageCount'] === 'number' ? o['messageCount'] : undefined,
      current: o['current'] === true,
    }
  }).filter((s) => s.id !== '')
}

/** 控制面节点 → `ChatResponseFileTree`（只有 name/children；标记信息并入 name） */
function toFileTree(nodes: readonly FileTreeWireNode[]): vscode.ChatResponseFileTree[] {
  return nodes.map((n) => ({
    name: n.name + (n.kind === 'dir' ? '/' : '') + (n.marked ? ' *' : ''),
    children: n.children ? toFileTree(n.children) : undefined,
  }))
}

/**
 * 对话正文里的文件引用 → Uri。相对路径按**工作区根**解析；`~` 展开 home；
 * 绝对路径直接用。解析不了返回 undefined（宁可少一条引用，不可给个坏 Uri）。
 *
 * 局限要认：sidecar 的 cwd 可能不等于工作区根（`--cwd`），此时相对路径会指错 ——
 * 控制面 `harness/tree.get` 的出参里带 `cwd`，聊天流程里没有顺手的获取点，
 * P2-v2 先按工作区根近似（与 CLI 常见用法一致），偏差留给后续增量。
 */
export function resolveRefUri(ref: string): vscode.Uri | undefined {
  const cleaned = ref.replace(/:\d+(?::\d+)?$/, '')
  if (cleaned === '') return undefined
  if (cleaned.startsWith('~/')) return vscode.Uri.file(`${process.env['HOME'] ?? ''}${cleaned.slice(1)}`)
  if (cleaned.startsWith('/')) return vscode.Uri.file(cleaned)
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (!root) return undefined
  return vscode.Uri.joinPath(root, cleaned)
}

// ========================================================================
// 跨轮状态
// ========================================================================

/**
 * 从 Chat 历史里读回上一轮的会话 id。
 *
 * `ChatContext` **只有 `history`，没有 session id**（vscode.d.ts 实测）——
 * 所以跨轮状态只能靠 `ChatResult.metadata` 写、`ChatResponseTurn.result` 读。
 *
 * ⚠️ **`taskId` 刻意不继承**：它是**轮内**凭据（只在"回答权限挂起"时成立），上一轮结束即终态，
 * 带进新一轮必被服务端拒（`-32004`）。写不进去（见 `turnMetadata`）+ 读不回来，两道都要有。
 */
function readState(context: vscode.ChatContext): TurnState {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i]
    if (turn instanceof vscode.ChatResponseTurn) {
      const md = turn.result?.metadata as Partial<TurnState> | undefined
      if (md && (md.contextId || md.noticesShown)) {
        // 只继承"每轮都要带上"的两项：`noticesShown` 不带 ⇒ "每线程一次"的启动自检会每轮都弹。
        // （`sessionSwitched` 不在 `state` 里流转 —— follow-ups 是**直接读上一轮的 metadata**
        // 算的，见 `extension.ts` 的 `buildFollowups(result?.metadata)`，两者互不影响。）
        return { contextId: md.contextId, noticesShown: md.noticesShown }
      }
    }
  }
  return {}
}
