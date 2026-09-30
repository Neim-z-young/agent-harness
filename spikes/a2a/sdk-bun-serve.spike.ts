/**
 * Spike ①：@a2a-js/sdk 无框架 server 入口 + Bun.serve 对接验证
 *
 * 验证清单：
 *  1/.well-known/agent-card.json 取卡
 *  2/非流式 SendMessage → COMPLETED + artifact
 *  3/流式 SendStreamingMessage → SSE 事件序列
 *  4/GetTask 查询
 *  5/CancelTask 取消在跑的任务
 *  6/INPUT_REQUIRED 挂起 → 第二次 SendMessage（同 taskId）续接（P1 核心机制）
 *  7/A2A-Version 头缺失 → 被拒
 *  8/executor 抛异常 → FAILED
 */
import {
  AGENT_CARD_PATH,
  A2A_VERSION_HEADER,
  SSE_HEADERS,
  formatSSEEvent,
  Message,
  Role,
  TaskState,
  type AgentCard,
  type Message as A2aMessage,
  type Part,
} from '@a2a-js/sdk'
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  defaultServerCallContextBuilder,
  validateVersion,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type ServerCallContext,
} from '@a2a-js/sdk/server'

const PORT = Number(process.env.PORT ?? 4321)
const BASE = `http://127.0.0.1:${PORT}`
const JSONRPC_PATH = '/a2a'

const now = () => new Date().toISOString()
const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`

function textPart(value: string): Part {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' }
}

function extractText(msg: Message): string {
  return msg.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join('')
}

function status(state: TaskState, message?: Message) {
  return { state, message, timestamp: now() }
}

// ---------------------------------------------------------------- 挂起表
// 模式 A：executor 在 ask 处 await（不返回），答复由后续 SendMessage 投递
const gates = new Map<string, (answer: string) => void>()

// ---------------------------------------------------------------- executor
const executor: AgentExecutor = {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx
    const text = extractText(ctx.userMessage)
    const prev = ctx.task

    // 续接轮：上一次停在 INPUT_REQUIRED，这次的消息就是答复
    if (prev && prev.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      const resolve = gates.get(taskId)
      if (resolve) {
        gates.delete(taskId)
        resolve(text) // 唤醒仍在 await 的第一轮 executor
      }
      return // 本轮不再发事件，终态由第一轮补上
    }

    // 首个事件必须是 task 或 message
    bus.publish(AgentEvent.task({
      id: taskId,
      contextId,
      status: status(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [],
      metadata: undefined,
    }))
    bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(TaskState.TASK_STATE_WORKING), metadata: undefined }))

    if (text.startsWith('boom')) {
      throw new Error('模拟 executor 抛异常')
    }

    if (text.startsWith('slow:')) {
      const total = Number(text.slice(5) || 5)
      for (let i = 1; i <= total; i++) {
        await new Promise((r) => setTimeout(r, 300))
        bus.publish(AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: uid('art'),
            name: 'answer',
            description: '',
            parts: [textPart(`chunk ${i}/${total} `)],
            metadata: undefined,
            extensions: [],
          },
          append: i > 1,
          lastChunk: i === total,
          metadata: undefined,
        }))
      }
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(TaskState.TASK_STATE_COMPLETED), metadata: undefined }))
      return
    }

    if (text.startsWith('ask:')) {
      const question = text.slice(4)
      bus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_INPUT_REQUIRED, {
          messageId: uid('msg'),
          contextId,
          taskId,
          role: Role.ROLE_AGENT,
          parts: [textPart(`需要授权：${question}`)],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        }),
        metadata: { tool: 'bash', options: ['allow-once', 'allow-session', 'deny'] },
      }))
      // 挂起：不返回，等答复
      const answer = await new Promise<string>((resolve) => gates.set(taskId, resolve))
      bus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: uid('art'),
          name: 'answer',
          description: '',
          parts: [textPart(`已授权(${answer})，任务完成`)],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }))
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(TaskState.TASK_STATE_COMPLETED), metadata: undefined }))
      return
    }

    bus.publish(AgentEvent.artifactUpdate({
      taskId,
      contextId,
      artifact: {
        artifactId: uid('art'),
        name: 'answer',
        description: '',
        parts: [textPart(`echo: ${text}`)],
        metadata: undefined,
        extensions: [],
      },
      append: false,
      lastChunk: true,
      metadata: undefined,
    }))
    bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(TaskState.TASK_STATE_COMPLETED), metadata: undefined }))
  },

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const gate = gates.get(taskId)
    if (gate) {
      gates.delete(taskId)
      gate('__canceled__')
    }
    bus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId: '',
      status: status(TaskState.TASK_STATE_CANCELED),
      metadata: undefined,
    }))
  },
}

// ---------------------------------------------------------------- 装配
const agentCard: AgentCard = {
  name: 'Harness Spike Agent',
  description: '验证 SDK 无框架 server 入口能否挂到 Bun.serve 上',
  version: '0.0.1-spike',
  supportedInterfaces: [
    { url: `${BASE}${JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
  ],
  provider: undefined,
  capabilities: { streaming: true, pushNotifications: false, extensions: [] },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    { id: 'echo', name: 'echo', description: '回显', tags: ['echo'], examples: ['hello'], inputModes: [], outputModes: [], securityRequirements: [] },
  ],
  securitySchemes: {},
  securityRequirements: [],
  signatures: [],
}

const taskStore = new InMemoryTaskStore()
const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor)
const transport = new JsonRpcTransportHandler(requestHandler)

function contextFor(req: Request): ServerCallContext {
  return defaultServerCallContextBuilder({
    extensions: undefined,
    user: undefined,
    headers: Object.fromEntries(req.headers.entries()),
    requestedVersion: req.headers.get(A2A_VERSION_HEADER) ?? undefined,
  })
}

/**
 * 线上 JSON 是 proto 风格（{"text":"..."}），TS 内部是 content:{$case:'text'}。
 * 直接把内部表示 JSON.stringify 出去会被 fromJSON 静默丢弃（不报错）。
 * ⇒ 出参一律走 MessageFns.toJSON。
 */
function userMessage(text: string, taskId = '', contextId = ''): A2aMessage {
  return {
    messageId: uid('msg'),
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === `/${AGENT_CARD_PATH}`) {
      return Response.json(agentCard)
    }

    if (req.method === 'POST' && url.pathname === JSONRPC_PATH) {
      const body = await req.json()
      const ctx = contextFor(req)
      // 版本校验 JsonRpcTransportHandler 不做，是宿主的责任
      try {
        validateVersion(ctx.requestedVersion, agentCard, 'JSONRPC')
      } catch (err) {
        return Response.json({ jsonrpc: '2.0', id: (body as any)?.id ?? null, error: { code: -32600, message: String(err) } })
      }
      const result = await transport.handle(body, ctx)

      // 流式：结果是 AsyncGenerator<JSONRPCResponse> ⇒ 自己写 SSE
      if (Symbol.asyncIterator in Object(result)) {
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder()
            try {
              for await (const chunk of result as AsyncGenerator<unknown>) {
                controller.enqueue(enc.encode(formatSSEEvent(chunk)))
              }
            } finally {
              controller.close()
            }
          },
        })
        return new Response(stream, { headers: SSE_HEADERS })
      }
      return Response.json(result)
    }

    return new Response('not found', { status: 404 })
  },
})

// ---------------------------------------------------------------- 自检客户端
let failures = 0
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

function rpc(method: string, params: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${JSONRPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [A2A_VERSION_HEADER]: '1.0', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: uid('id'), method, params }),
  }).then((r) => r.json() as Promise<any>)
}

function sendMessage(text: string, taskId?: string, contextId?: string) {
  return rpc('SendMessage', { message: Message.toJSON(userMessage(text, taskId ?? '', contextId ?? '')) })
}

async function main() {
  console.log(`\n=== Spike ①：@a2a-js/sdk 1.3.0 + Bun.serve @ ${BASE} ===\n`)

  // 1 取卡
  const card = await fetch(`${BASE}/${AGENT_CARD_PATH}`).then((r) => r.json())
  check('1 agent-card 可取', card?.name === 'Harness Spike Agent', card)
  check('1b supportedInterfaces.protocolVersion = 1.0', card?.supportedInterfaces?.[0]?.protocolVersion === '1.0', card?.supportedInterfaces)

  // 2 非流式（响应体是 { result: { task } }）
  const r2 = await sendMessage('hello')
  const t2 = r2?.result?.task ?? r2?.result
  // 注意：TaskState 是数字 enum，线上 JSON 是字符串 ⇒ 比较用字符串字面量
  check('2 SendMessage 非流式返回 Task', t2?.id && t2?.status?.state === 'TASK_STATE_COMPLETED', r2)
  check('2b artifact 文本回显（proto JSON 出参）',
    t2?.artifacts?.[0]?.parts?.[0]?.text === 'echo: hello', t2?.artifacts)
  const taskId2 = t2?.id
  const contextId2 = t2?.contextId

  // 3 流式 SSE
  const sseRes = await fetch(`${BASE}${JSONRPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [A2A_VERSION_HEADER]: '1.0' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: uid('id'), method: 'SendStreamingMessage',
      params: { message: Message.toJSON(userMessage('stream me')) },
    }),
  })
  check('3 SSE Content-Type', sseRes.headers.get('content-type')?.includes('text/event-stream'), sseRes.headers.get('content-type'))
  const raw = await sseRes.text()
  const events = raw.split('\n\n').filter((s) => s.startsWith('data:')).map((s) => JSON.parse(s.slice(5).trim()))
  check('3b SSE 收到多个事件', events.length >= 3, events.length)
  const sseStates = events.map((e) => e?.result?.statusUpdate?.status?.state ?? e?.result?.task?.status?.state ?? e?.result?.status?.state)
  check('3c SSE 事件序列以 COMPLETED 收尾', sseStates.includes('TASK_STATE_COMPLETED'), sseStates)

  // 4 GetTask
  const r4 = await rpc('GetTask', { id: taskId2 })
  check('4 GetTask 取回同一任务', (r4?.result?.task?.id ?? r4?.result?.id) === taskId2, r4)

  // 5 CancelTask：先起一个慢任务，再取消
  const slowStart = sendMessage('slow:20')
  await new Promise((r) => setTimeout(r, 700))
  const listed = await rpc('ListTasks', {})
  const liveTask = listed?.result?.tasks?.find((t: any) => !['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(t?.status?.state))
  check('5 ListTasks 能列出在跑的任务', Boolean(liveTask), listed?.result?.tasks?.map((t: any) => t?.status?.state))
  if (liveTask) {
    const r5 = await rpc('CancelTask', { id: liveTask.id })
    check('5b CancelTask 返回 CANCELED',
      (r5?.result?.task?.status?.state ?? r5?.result?.status?.state) === 'TASK_STATE_CANCELED', r5)
  }
  await slowStart.catch(() => {})

  // 6 INPUT_REQUIRED 挂起 + 续接（P1 核心机制）
  const r6a = await sendMessage('ask: 允许执行 rm -rf /tmp/x 吗？')
  const t6a = r6a?.result?.task ?? r6a?.result
  check('6 非流式 SendMessage 返回 INPUT_REQUIRED（不必等到终态）',
    t6a?.status?.state === 'TASK_STATE_INPUT_REQUIRED', t6a?.status)
  check('6b 待决描述可读（status.message 或 metadata）',
    Boolean(t6a?.status?.message?.parts?.[0]?.text) || Boolean(t6a?.status?.metadata?.tool),
    t6a?.status)
  const askTaskId = t6a?.id
  const askContextId = t6a?.contextId

  // 答复（同一 taskId）
  const r6b = await sendMessage('allow-once', askTaskId, askContextId)
  const t6b = r6b?.result?.task ?? r6b?.result
  check('6c 续接后回到 COMPLETED', t6b?.status?.state === 'TASK_STATE_COMPLETED', t6b?.status)
  check('6d 续接后拿到最终 artifact',
    String(t6b?.artifacts?.at(-1)?.parts?.[0]?.text ?? '').includes('已授权'), t6b?.artifacts)

  // 7 A2A-Version 缺失
  const r7 = await fetch(`${BASE}${JSONRPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: uid('id'), method: 'SendMessage',
      params: { message: Message.toJSON(userMessage('no version')) },
    }),
  }).then((r) => r.json() as Promise<any>)
  check('7 缺 A2A-Version 头被拒（宿主层 validateVersion 兜住）', Boolean(r7?.error), r7)

  // 8 executor 抛异常
  const r8 = await sendMessage('boom')
  const t8 = r8?.result?.task ?? r8?.result
  check('8 executor 抛异常 → FAILED', t8?.status?.state === 'TASK_STATE_FAILED', r8)

  console.log(`\n=== ${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  server.stop(true)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
