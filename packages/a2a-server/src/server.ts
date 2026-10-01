/**
 * A2A 服务端宿主（plan §3）：把 `@harness/host` 的装配挂到 `Bun.serve` 上。
 *
 * ## 职责边界（plan §3.2）
 * 本文件只做**路由与协议**：卡路由 / 认证 / 版本校验 / 并发与幂等 / SSE 透传。
 * 任务生命周期归 `executor.ts`，线上/内部表示翻译归 `mapping.ts`，卡片归 `card.ts`。
 * **不内置业务决策、不绕过权限、不直接调工具**。
 *
 * ## 为什么不用框架
 * P0.5 spike 实测：`JsonRpcTransportHandler.handle(body, ctx)` 是**纯 JSON-RPC 进出**、
 * 完全不接触 HTTP —— 直挂 `Bun.serve` 即可，无需任何框架 peer dep（express/grpc 入口
 * 都在 SDK 里，但我们不用）。SSE 自己写：SDK 只给 `formatSSEEvent` + `SSE_HEADERS`。
 *
 * ## 三个"宿主必须自己做"的点（SDK 不做）
 * 1. **版本校验**：`validateVersion(requestedVersion, card, 'JSONRPC')` 不归 transport 管。
 *    头缺失时 `requestedVersion` 默认 `'0.3'` ⇒ 卡片只声明 `1.0` 时必然被拒（这正是我们要的）。
 * 2. **认证**：transport 不认识 `Authorization`；须在入口先判（见 `auth.ts`）。
 * 3. **并发/幂等/隔离**：SDK 只管"一条任务怎么跑"，不管"同一会话能不能并行两条"、
 *    "同一 messageId 重复发会怎样"、"这个 contextId 是不是你的"。
 */
import { createHash } from 'node:crypto'
import {
  AGENT_CARD_PATH,
  A2A_VERSION_HEADER,
  SSE_HEADERS,
  TaskState,
  formatSSEErrorEvent,
  formatSSEEvent,
  taskStateToJSON,
  type AgentCard,
} from '@a2a-js/sdk'
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  defaultServerCallContextBuilder,
  validateVersion,
  type ExecutionEventBus,
  type ServerCallContext,
} from '@a2a-js/sdk/server'
import type { Host } from '@harness/host'
import { CallerRegistry, callerKey, verifyBearer } from './auth'
import { JSONRPC_BINDING, buildAgentCard, cardToJSON } from './card'
import { ControlError, DEFAULT_CONTROL_PATH, dispatchControl } from './control'
import {
  A2aServerError,
  ConcurrentTaskError,
  ContextForbiddenError,
  ContextTaskMismatchError,
  DuplicateMessageError,
  TaskTerminalError,
  TooManyTasksError,
  UnauthorizedError,
} from './errors'
import { HarnessAgentExecutor, type A2aLogger } from './executor'

/** 默认端口（本机开发用；生产由调用方显式给） */
export const DEFAULT_A2A_PORT = 4321
/** 默认 JSON-RPC 端点路径 */
export const DEFAULT_JSONRPC_PATH = '/a2a'
/** 默认监听地址 —— **只监听本机**（plan §3：默认不对外） */
export const DEFAULT_A2A_HOSTNAME = '127.0.0.1'
/** 默认单进程并发上限 */
export const DEFAULT_MAX_CONCURRENT_TASKS = 16

/**
 * 卡片路由的 `Cache-Control: max-age`（秒）。
 *
 * 卡片在**进程生命周期内是固定的**（`cardJson` 只算一次），故可放心给缓存头。
 * 规范 §8.6.1 要求卡片端点带 `Cache-Control` / `ETag`（SHOULD）、`Last-Modified`（MAY），
 * 并支持条件请求回 `304` —— 轮询卡片注册表的行为者直接受益（官方 a2a-tck 的
 * CARD-CACHE-001/002/003 即测这三条）。
 */
export const DEFAULT_CARD_CACHE_MAX_AGE_SECONDS = 300

/**
 * 路径归一：**容忍尾斜杠**（`/a2a` 与 `/a2a/` 等价）。
 *
 * 这不是"顺手加的宽容"，而是一处实测出来的互操作缺陷：官方 `a2a-tck` 的 JSON-RPC
 * 客户端用 `httpx.Client(base_url=interface.url)` 建客户端、再用 `post("/")` 发请求 ——
 * httpx 会把 `base_url` 规范成**带尾斜杠**的形式（`/a2a` → `/a2a/`），实际请求因此落到
 * `/a2a/`。只匹配精确路径会返回 404，而 404 体是 `not found`（非 JSON）⇒ 客户端
 * `response.json()` 抛 `JSONDecodeError`、**不落进它的 `except httpx.HTTPError`** ⇒
 * 一个尾斜杠被放大成整轮验收崩盘（实测 254 条 error）。
 *
 * 根路径 `/` 不剥（剥完是空串，反而匹配不上）。
 */
export function normalizePath(pathname: string): string {
  if (pathname.length <= 1) return pathname
  const stripped = pathname.replace(/\/+$/, '')
  return stripped === '' ? '/' : stripped
}

export interface A2aServerOptions {
  /** 已启动的宿主（`await createHost({…})`） */
  host: Host
  /** 端口（`0` = 由系统分配，测试用） */
  port?: number
  /** 监听地址，默认 `127.0.0.1`。**不要传 `0.0.0.0`**：那会绕过"默认只监听本机"这条约束。 */
  hostname?: string
  /** JSON-RPC 端点路径，默认 `/a2a` */
  path?: string
  /**
   * 控制面路径，默认 `/harness/rpc`（见 `control.ts` 文件头）。
   * 与协议面分开是刻意的：`/a2a` 的行为被官方 TCK 盯着，控制面则是本扩展私有的本地管理面。
   */
  controlPath?: string
  /** 卡片里 `supportedInterfaces[].url` 的基址，默认 `http://<hostname>:<port>` */
  baseUrl?: string
  /** Bearer token：配了则校验 + 卡片声明安全方案；不配则匿名（仅本机可访问） */
  token?: string
  /** 卡片顶层版本（agent/harness 自身版本），默认 `0.1.0` */
  version?: string
  /** 卡片是否暴露非 primary agent，默认 false */
  exposeNonPrimary?: boolean
  /** 卡片只暴露这些 agentId */
  agentIds?: string[]
  /** 并发上限（同一 `contextId` 并行两条一律拒绝；这是**全局**上限） */
  maxConcurrentTasks?: number
  /** 挂起超时（透传 executor） */
  suspendTtlMs?: number
  /** 单轮最大步数（透传 executor） */
  maxSteps?: number
  /** artifact 分块阈值（透传 executor） */
  chunkChars?: number
  logger?: A2aLogger
}

export interface A2aServer {
  /** 任务执行器（自检 / 关闭用） */
  readonly executor: HarnessAgentExecutor
  /** 生成的 AgentCard（内部表示；线上必须经 `cardJson`） */
  readonly card: AgentCard
  /** 卡片的线上 JSON（已走 `AgentCard.toJSON()`，见 `card.ts`） */
  readonly cardJson: unknown
  /** 实际端口（`port: 0` 时由系统分配，启动后从这里读真实值） */
  readonly port: number
  /** JSON-RPC 端点完整 URL */
  readonly url: string
  /** JSON-RPC 端点路径 */
  readonly jsonRpcPath: string
  /** 控制面端点完整 URL（`/harness/rpc`，非 A2A 协议面；见 `control.ts`） */
  readonly controlUrl: string
  /** 控制面路径 */
  readonly controlPath: string
  /** 调用方归属表（自检用） */
  readonly callers: CallerRegistry
  /** 当前已登记的 `messageId` 数（自检用） */
  readonly seenMessageCount: number
  /**
   * 路由器本身。
   *
   * 暴露它有两个用处：① 测试可直接用 `Request` 驱动，不必真起端口；
   * ② 将来要换成别的 HTTP 服务器（如 `node:http`）时只换监听、不重写路由。
   */
  handle(req: Request): Promise<Response>
  /** 停止监听并释放 executor 的挂起与任务 */
  stop(closeActive?: boolean): void
}

/** JSON-RPC 错误信封（HTTP 状态仍 200 —— JSON-RPC over HTTP 的惯例是"错误在体里"） */
function rpcError(id: unknown, error: { code: number; message: string; data?: unknown }): Response {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error })
}

/** 把 `A2aServerError` 转成 JSON-RPC 错误响应 */
function serverErrorResponse(err: A2aServerError, id: unknown): Response {
  return rpcError(id, err.toJsonRpc())
}

/** 判断 transport 的返回值是"流"还是"单响应" */
function isAsyncGenerator(v: unknown): v is AsyncGenerator<unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    Symbol.asyncIterator in (v as Record<PropertyKey, unknown>)
  )
}

/**
 * 把一个异步事件流写进 SSE 响应体。
 *
 * 中途出错时**必须补一帧 `event: error`**（SDK 的 `formatSSEErrorEvent`）：SSE 一旦
 * 提交了响应头就无法再回 JSON-RPC error，若只是 `finally { close() }`，客户端只会看到
 * 一段**正常结束的流**——错误被吞掉。SDK 自带的 express 宿主用的是同一策略。
 */
function sseBody(gen: AsyncGenerator<unknown>, requestId?: unknown): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of gen) controller.enqueue(enc.encode(formatSSEEvent(chunk as never)))
      } catch (e) {
        controller.enqueue(
          enc.encode(
            formatSSEErrorEvent({
              jsonrpc: '2.0',
              id: requestId ?? null,
              error: JsonRpcTransportHandler.mapToJSONRPCError(e),
            }),
          ),
        )
      } finally {
        controller.close()
      }
    },
  })
}

/** 把单个值包成只产一个 chunk 的异步流（幂等回放的流式分支用） */
async function* once<T>(v: T): AsyncGenerator<T> {
  yield v
}

const SEND_METHOD = 'SendMessage'
const SEND_STREAM_METHOD = 'SendStreamingMessage'

/**
 * 终态判定（协议 §3）：终态 = completed / failed / canceled / rejected。
 * `input_required` / `auth_required` 是**中断态**（interrupted），不是终态 ——
 * 它们正是"还能继续对话"的状态，判错会把正常续接挡在门外。
 */
function isTerminalState(state: TaskState | undefined): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED
  )
}

/**
 * 事件总线管理器：**接管"续接请求"那条共享 bus 的结算**。
 *
 * ## 为什么需要它（一个真实的坑，spike 靠微任务次序侥幸躲过）
 * SDK 在 executor 返回时调 `_settleBus(taskId, bus, lastObservedState)`：
 * `lastObservedState` 取自**本次 `_runExecutor` 之后**总线上的事件（`trackLatestTaskState`），
 * 默认策略是"终态或不在 `keepBusAliveStates` 里 ⇒ `bus.finished()` + 清理"。
 *
 * 而**续接请求不发布任何事件就返回**（它只是唤醒第一轮）⇒ `lastObservedState === undefined`
 * ⇒ 默认策略**立刻结束这条共享 bus**。可第一轮此刻仍在跑（它随后要往**同一条** bus 上补发
 * artifact + 终态），事件于是全部丢掉，续接请求拿到 `Agent execution finished without a result`。
 *
 * P0.5 spike 没暴露它，只是因为它的第一轮在 `resolve()` 之后**同步**续跑（同一条微任务链上
 * 先于续接请求的 `.finally`），而真实 harness 的第一轮要走 LLM（多个 await）—— 次序反过来。
 *
 * ## 判据是"任务还在跑"，不是"这条请求发了事件"
 * `lastObservedState === undefined` 且该 task 仍在 executor 里 ⇒ 接管（返回 `true`），
 * 让第一轮自己收尾时再走常规结算（那时 `lastObservedState` 是终态，本方法返回 `false`）。
 * 不满足则交回默认策略 —— 避免"executor 什么都没发且也不在跑"时把 bus 永久挂着。
 */
class HarnessEventBusManager extends DefaultExecutionEventBusManager {
  constructor(private readonly isRunning: (taskId: string) => boolean) {
    super()
  }

  // 注意：`DefaultExecutionEventBusManager` **没有**声明 `settleByTaskId`（它只声明在
  // `ExecutionEventBusManager` 这个可选成员上）⇒ 不能写 `override`，写 `override` 会
  // 报 TS4117。这里只是给类补上那个可选成员（结构上仍满足接口）。
  settleByTaskId(
    taskId: string,
    _eventBus: ExecutionEventBus,
    lastObservedState: TaskState | undefined,
  ): boolean {
    if (lastObservedState === undefined && this.isRunning(taskId)) return true
    return false
  }
}

export function createA2aServer(opts: A2aServerOptions): A2aServer {
  const host = opts.host
  const jsonRpcPath = normalizePath(opts.path ?? DEFAULT_JSONRPC_PATH)
  const controlPath = normalizePath(opts.controlPath ?? DEFAULT_CONTROL_PATH)
  const agentCardPath = normalizePath(`/${AGENT_CARD_PATH}`)
  const hostname = opts.hostname ?? DEFAULT_A2A_HOSTNAME
  const token = opts.token
  const maxConcurrent = opts.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS
  const logger = opts.logger

  // ---- 装配（顺序与 CLI 一致：先建 executor 拿 asker，host 已由调用方创建并回填） ----
  const executor = new HarnessAgentExecutor({
    getHost: () => host,
    ...(opts.suspendTtlMs !== undefined ? { suspendTtlMs: opts.suspendTtlMs } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.chunkChars !== undefined ? { chunkChars: opts.chunkChars } : {}),
    ...(logger ? { logger } : {}),
  })

  // 权限桥接线（plan §3.4 的关键一步）。
  //
  // host 由调用方在 `createA2aServer` **之前** boot，而 executor 只能建在 host 之后
  // （它要 `getHost()`）—— 于是 host 的权限引擎在 boot 时拿不到 A2A 的 asker，
  // `ask()` 会走默认 deny。这里把 `executor.asker` 装回 host 的权限引擎：
  // **A2A 宿主的 asker 就是挂起桥**（问不到就 deny，不是"问不到就放行"）。
  // `InteractivePermissionEngine.setAsker` 正是为这种"启动后注入交互器"存在的
  // （TUI 也用它挂模态审批）。若不做这一步，权限点不会挂起，`INPUT_REQUIRED`
  // 用例会静默退化成"任务直接 COMPLETED"。
  host.permission.setAsker(executor.asker)

  const taskStore = new InMemoryTaskStore()
  const eventBusManager = new HarnessEventBusManager((taskId) => executor.isRunning(taskId))

  // 幂等 / 并发的三张表：
  //  - messageIndex: messageId → taskId（已执行完，可回放快照）
  //  - inflight:     正在处理中的 messageId（尚无 taskId 可回放）
  //  - callers:      contextId → 调用方（隔离）
  const messageIndex = new Map<string, string>()
  const inflight = new Set<string>()
  const callers = new CallerRegistry()

  let card!: AgentCard
  /** 卡片的**线上字节**（与 `ETag` 一一对应：ETag 就是对它取的哈希） */
  let cardBody = ''
  let cardHeaders: Record<string, string> = {}
  let transport!: JsonRpcTransportHandler
  let requestHandler!: DefaultRequestHandler

  const buildCard = (url: string): AgentCard =>
    buildAgentCard({
      agents: host.harness.agent.list(),
      url,
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      ...(token ? { token } : {}),
      ...(opts.exposeNonPrimary !== undefined ? { exposeNonPrimary: opts.exposeNonPrimary } : {}),
      ...(opts.agentIds ? { agentIds: opts.agentIds } : {}),
    })

  /** 从请求头构 `ServerCallContext`（版本校验与多租户都读它） */
  const contextOf = (req: Request): ServerCallContext =>
    defaultServerCallContextBuilder({
      extensions: undefined,
      user: undefined,
      headers: Object.fromEntries(req.headers.entries()),
      requestedVersion: req.headers.get(A2A_VERSION_HEADER) ?? undefined,
    })

  /**
   * 幂等回放：把一个已执行过的 `messageId` 映射到任务快照（**不重复执行**，plan §3.5）。
   *
   * ## 为什么不能直接透传 `GetTask` 的 result
   * `GetTask` 的 result 是**裸 Task**（SDK 里是 `Task.toJSON(...)`），而回放要冒充的是
   * `SendMessage` / `SendStreamingMessage` —— 它们的 result 是 `SendMessageResponse` /
   * `StreamResponse`，形态必须是 `{ task }`。直接透传会让线上出参变成"result 直接是
   * Task 字段"，对端按 `SendMessageResponse` 校验即报 `additional properties are not
   * allowed ('artifacts','contextId','history','id','metadata','status' were unexpected)`。
   * 官方 a2a-tck 据此判 CORE-EXECUTION-MODE-001/002 与 JSONRPC-SSE-001 失败（TCK 的多个
   * 需求共用同一个 `messageId`，第 2 条起必然走回放路径）—— 是一个真实的协议形态缺陷，
   * 不是 TCK 苛刻。
   */
  const replay = async (taskId: string, id: unknown, ctx: ServerCallContext, stream: boolean): Promise<Response> => {
    const snapshot = (await transport.handle(
      { jsonrpc: '2.0', id, method: 'GetTask', params: { id: taskId } },
      ctx,
    )) as { error?: unknown; result?: unknown }

    // 回放时任务已不在了（被清理 / 重启）⇒ 如实回错误，**不要伪造成功**
    const payload =
      snapshot.error !== undefined
        ? { jsonrpc: '2.0', id, error: snapshot.error }
        : { jsonrpc: '2.0', id, result: { task: snapshot.result } }

    if (!stream) return Response.json(payload)
    // 流式：单个 `{task}` 事件即合法的 `StreamResponse`
    return new Response(sseBody(once(payload), id), { headers: SSE_HEADERS })
  }

  const handleJsonRpc = async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return rpcError(null, { code: -32700, message: '请求体不是合法 JSON' })
    }

    // ---- 1. 认证先于一切（未认证不该看到任何协议细节）----
    const authHeader = req.headers.get('authorization')
    if (!verifyBearer(authHeader, token)) {
      const err = new UnauthorizedError()
      return Response.json({ jsonrpc: '2.0', id: body['id'] ?? null, error: err.toJsonRpc() }, { status: 401 })
    }

    const ctx = contextOf(req)

    // ---- 2. 版本校验（宿主责任，transport 不管）----
    try {
      validateVersion(ctx.requestedVersion, card, JSONRPC_BINDING)
    } catch (e) {
      return rpcError(body['id'], JsonRpcTransportHandler.mapToJSONRPCError(e))
    }

    const method = body['method']
    const isStream = method === SEND_STREAM_METHOD
    const isSend = method === SEND_METHOD || isStream

    // ---- 3. 发送类方法的前置判定：幂等 → 并发 → 隔离 ----
    let messageId = ''
    if (isSend) {
      const params = body['params'] as Record<string, unknown> | undefined
      const message = params?.['message'] as Record<string, unknown> | undefined
      messageId = typeof message?.['messageId'] === 'string' ? (message['messageId'] as string) : ''
      const contextId = typeof message?.['contextId'] === 'string' ? (message['contextId'] as string) : ''
      const taskId = typeof message?.['taskId'] === 'string' ? (message['taskId'] as string) : ''

      if (!messageId) {
        return rpcError(body['id'], {
          code: -32602,
          message: 'message.messageId 必填（幂等键）',
          data: { a2aCode: 'BAD_REQUEST' },
        })
      }

      // 幂等：已执行过 ⇒ 回放快照
      const known = messageIndex.get(messageId)
      if (known) return replay(known, body['id'], ctx, isStream)
      // 幂等：仍在处理中 ⇒ 结构化拒绝（等它跑完再来查）
      if (inflight.has(messageId)) return serverErrorResponse(new DuplicateMessageError(messageId), body['id'])

      // 带 `taskId` 但挂起表里没有该任务 ⇒ **不是续接**，是"给一个已有的任务发消息"。
      // 这里必须按协议判定（官方 a2a-tck CORE-MULTI-006 / CORE-SEND-002，都是 MUST）：
      //   · `contextId` 与任务所属会话不一致 ⇒ 拒绝
      //   · 任务已终态                     ⇒ 拒绝（不能再给终态任务发消息）
      // 只有既不是上面两种、又查不到终态原因的情况才回放快照兜底。
      //
      // 反面教训：早先这里是一句"一律回放且不报错"（plan §3.4 要点 3 的"安全忽略"）。
      // 那条只对**迟到的权限答复**成立；对普通用法，静默返回旧快照等于把错误掩盖成成功
      // —— TCK 的 CORE-SEND-002 / CORE-MULTI-006 就是这么被"通过"的。**正常续接不受影响**：
      // 真续接时 `suspend.has(taskId)` 为真，在上面就已放行。
      if (taskId && !executor.suspend.has(taskId)) {
        const existing = await taskStore.load(taskId, ctx)
        if (existing) {
          if (contextId && existing.contextId && contextId !== existing.contextId) {
            return serverErrorResponse(new ContextTaskMismatchError(taskId, contextId), body['id'])
          }
          if (isTerminalState(existing.status?.state)) {
            return serverErrorResponse(
              new TaskTerminalError(taskId, taskStateToJSON(existing.status?.state ?? 0)),
              body['id'],
            )
          }
        }
        return replay(taskId, body['id'], ctx, isStream)
      }

      // 并发：同一会话已有活跃任务 ⇒ 直接拒绝（续接轮：taskId 命中自己，不算并发）。
      // 挂起中的任务也算活跃（它仍在 executor.running 里）—— 正是我们要的：同一会话
      // 不能"挂着一条又问另一条"，那会让两个 loop 交错写同一份会话历史。
      const active = executor.activeTaskFor(contextId, taskId || undefined)
      if (active) return serverErrorResponse(new ConcurrentTaskError(contextId, active), body['id'])
      if (executor.runningCount >= maxConcurrent) {
        return serverErrorResponse(new TooManyTasksError(maxConcurrent), body['id'])
      }

      // 隔离：contextId 一旦被某调用方使用即绑定给它
      if (!callers.claim(contextId, callerKey(authHeader, token))) {
        return serverErrorResponse(new ContextForbiddenError(contextId), body['id'])
      }

      inflight.add(messageId)
    }

    // ---- 4. 交给 transport；出参一律由 SDK 的 toJSON 负责 ----
    try {
      const result = await transport.handle(body, ctx)

      if (isAsyncGenerator(result)) {
        // ---- 预热首值：**在提交 SSE 响应之前**先拉一次 ----
        //
        // SDK 的流是惰性的：`sendMessageStream` / `resubscribe` 返回的是生成器，参数或
        // 任务不合法时异常要到第一次 `next()` 才抛出。不预热就直接回 `text/event-stream`，
        // 这个异常会落在 SSE 的写出逻辑里 —— 客户端只会收到一个 **200 空体**，错误被吞掉。
        // 官方 a2a-tck 的 STREAM-SUB-004（订阅不存在的任务必须回 `TaskNotFoundError`）
        // 正是这么判失败的。
        //
        // 与 SDK 自带 express 宿主同一策略：预流错误走普通 JSON-RPC error
        // （`application/json`），只有已经开出 SSE 之后的中途错误才补 `event: error` 帧。
        const iterator = result[Symbol.asyncIterator]()
        let first: IteratorResult<unknown>
        try {
          first = await iterator.next()
        } catch (e) {
          inflight.delete(messageId)
          if (e instanceof A2aServerError) return serverErrorResponse(e, body['id'])
          return rpcError(body['id'], JsonRpcTransportHandler.mapToJSONRPCError(e))
        }

        // 从首个带 task 的 chunk 记下 taskId（供后续重复 messageId 回放）
        const firstTaskId = (first.value as { result?: { task?: { id?: string } } })?.result?.task?.id
        if (typeof firstTaskId === 'string' && firstTaskId) messageIndex.set(messageId, firstTaskId)

        const wrapped = (async function* () {
          try {
            if (!first.done) yield first.value
            for await (const chunk of iterator) yield chunk
          } finally {
            inflight.delete(messageId)
          }
        })()
        return new Response(sseBody(wrapped, body['id']), { headers: SSE_HEADERS })
      }

      inflight.delete(messageId)
      const taskId = (result as { result?: { task?: { id?: string } } })?.result?.task?.id
      if (messageId && typeof taskId === 'string' && taskId) messageIndex.set(messageId, taskId)
      return Response.json(result)
    } catch (e) {
      inflight.delete(messageId)
      if (e instanceof A2aServerError) return serverErrorResponse(e, body['id'])
      logger?.warn?.('a2a: JSON-RPC 处理异常', { message: e instanceof Error ? e.message : String(e) })
      return rpcError(body['id'], JsonRpcTransportHandler.mapToJSONRPCError(e))
    }
  }

  /**
   * 卡片响应（含缓存头 + 条件请求）。
   *
   * 规范 §8.6.1 的三条（官方 a2a-tck CARD-CACHE-001/002/003）：卡片端点应带
   * `Cache-Control`（含 `max-age`）、`ETag`，并且可以带 `Last-Modified`。
   * 卡在进程生命周期内固定 ⇒ 三个校验子**只算一次**，且 `ETag` 取自**实际响应的字节**，
   * 保证 `If-None-Match` 命中时不是"看起来一样"而是**逐字节一样**。
   */
  const cardResponse = (req: Request): Response => {
    const inm = req.headers.get('if-none-match')
    const ims = req.headers.get('if-modified-since')
    const etagHit = inm !== null && inm.split(',').some((t) => t.trim() === cardHeaders['etag'])
    const imsMs = ims === null ? NaN : Date.parse(ims)
    const sinceHit = !Number.isNaN(imsMs) && imsMs >= Date.parse(cardHeaders['last-modified'] ?? '')
    if (etagHit || sinceHit) return new Response(null, { status: 304, headers: cardHeaders })
    return new Response(cardBody, { status: 200, headers: cardHeaders })
  }

  /**
   * 控制面路由（`POST /harness/rpc`）。
   *
   * 与 `handleJsonRpc` 的**三处有意的差异**（理由见 `control.ts` 文件头）：
   * 1. **不做 `validateVersion`** —— 控制面不是 A2A，`A2A-Version` 头对它没有意义。
   *    照抄一遍版本校验会让扩展在升级 A2A 协议时必须同步改控制面客户端，纯属自找。
   * 2. **不查幂等键 / 并发 / 归属** —— 管理操作没有回放语义，也没有多租户问题。
   * 3. **错误词汇不同** —— `ControlError` 而非 `A2aServerError`。
   *
   * 相同的一处：**同一个 Bearer**（同一端口不该有两套凭据；`verifyBearer` 与业务侧的
   * "未配置 token = 匿名但只听 127.0.0.1"语义逐字一致）。
   *
   * HTTP 状态沿用 JSON-RPC over HTTP 的惯例：**错误在体里、状态仍是 200**（401 / 405 除外）。
   */
  const handleControl = async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return rpcError(null, { code: -32700, message: '请求体不是合法 JSON' })
    }

    const authHeader = req.headers.get('authorization')
    if (!verifyBearer(authHeader, token)) {
      const err = new UnauthorizedError()
      return Response.json(
        { jsonrpc: '2.0', id: body['id'] ?? null, error: err.toJsonRpc() },
        { status: 401 },
      )
    }

    const id = body['id'] ?? null
    const method = body['method']
    if (typeof method !== 'string' || method === '') {
      return rpcError(id, new ControlError('INVALID_PARAMS', 'method 必填且必须是非空字符串').toJsonRpc())
    }

    try {
      return Response.json({ jsonrpc: '2.0', id, result: await dispatchControl(host, method, body['params']) })
    } catch (e) {
      if (e instanceof ControlError) return rpcError(id, e.toJsonRpc())
      // 未预期异常：结构化 code + **安全文案**（堆栈只进服务日志，不出网线）
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300)
      logger?.warn?.('a2a: 控制面处理异常', { method, message: msg })
      return rpcError(id, new ControlError('INTERNAL', msg).toJsonRpc())
    }
  }

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const path = normalizePath(url.pathname)
    // 卡路由：客户端据此发现协议版本与安全方案
    if (req.method === 'GET' && path === agentCardPath) {
      return cardResponse(req)
    }
    // 控制面：**与协议面并列的另一条路径**（不共享方法空间，见 control.ts 文件头）
    if (path === controlPath) return handleControl(req)
    if (path === jsonRpcPath) return handleJsonRpc(req)
    return new Response('not found', { status: 404 })
  }

  // ---- 起监听 ----
  const configuredPort = opts.port ?? DEFAULT_A2A_PORT
  const urlFor = (p: number): string => `${opts.baseUrl ?? `http://${hostname}:${p}`}${jsonRpcPath}`
  // 卡片 URL 要在监听**之前**定下；`port: 0` 时先用占位端口，拿到真实端口后重建。
  card = buildCard(urlFor(configuredPort))
  requestHandler = new DefaultRequestHandler(card, taskStore, executor, eventBusManager)
  transport = new JsonRpcTransportHandler(requestHandler)

  const server = Bun.serve({ hostname, port: configuredPort, fetch: handle })

  const actualPort = server.port ?? configuredPort
  const url = urlFor(actualPort)
  if (actualPort !== configuredPort) {
    // 用系统分配的真实端口重建卡片，保证 supportedInterfaces[].url 与实际一致
    card = buildCard(url)
    requestHandler = new DefaultRequestHandler(card, taskStore, executor, eventBusManager)
    transport = new JsonRpcTransportHandler(requestHandler)
  }
  const cardJson = cardToJSON(card)
  // 缓存校验子：卡片固定 ⇒ 只算一次；`ETag` 取自实际响应的字节（base64url(sha256) 截断）
  cardBody = JSON.stringify(cardJson)
  cardHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${DEFAULT_CARD_CACHE_MAX_AGE_SECONDS}`,
    etag: `"${createHash('sha256').update(cardBody).digest('base64url').slice(0, 27)}"`,
    'last-modified': new Date().toUTCString(),
  }

  logger?.info?.('a2a: 服务已启动', { url, port: actualPort, auth: Boolean(token) })

  return {
    executor,
    get card() {
      return card
    },
    cardJson,
    port: actualPort,
    url,
    jsonRpcPath,
    controlPath,
    controlUrl: `${opts.baseUrl ?? `http://${hostname}:${actualPort}`}${controlPath}`,
    callers,
    get seenMessageCount() {
      return messageIndex.size
    },
    handle,
    stop(closeActive = true) {
      try {
        server.stop(closeActive)
      } finally {
        executor.shutdown()
        callers.clear()
        messageIndex.clear()
        inflight.clear()
      }
    },
  }
}
