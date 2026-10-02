/**
 * 控制通道（P2-A）：`POST /harness/rpc` —— **A2A 协议里没有的那一半**。
 *
 * ## 为什么必须有它（不是一个"顺手加的便利接口"）
 * A2A transport 只认 6 个方法（`SendMessage` / `SendStreamingMessage` / `GetTask` /
 * `CancelTask` / `ListTasks` / `SubscribeToTask`），而 CLI 有 18 个斜杠命令，其中
 * **12 个是本进程管理操作**（`/compact` `/stats` `/agent` `/model` `/permission` `/skills` …）——
 * 它们要的是"改这个 sidecar 的运行时状态"，协议里**无处安放**。这不是协议缺陷而是协议定位：
 * A2A 是"远程 agent 互操作协议"，不负责"本地管理面"。
 *
 * ## 为什么另开一条路径，而不是塞进 `/a2a` 的方法空间
 * 三条理由，按重要性排序：
 * 1. **`/a2a` 的每一点行为都被官方 TCK 盯着**（"未知方法必须 `MethodNotFound`"是它的断言项）。
 *    把私有方法塞进去，日后每次动 A2A 都要重新推演"这条会不会影响控制面"。
 * 2. **协议面 vs 实现面**。P0 花四步拆掉的就是这种耦合；再粘回去等于把刚拆的东西装回来。
 * 3. 另开路径后 **TCK 永远碰不到它**（它的取卡 URL 只指向 `/a2a`），外部验收的语义保持纯净。
 *
 * ## 为什么不进 AgentCard
 * 卡片是发给 **A2A 客户端**的发现文档。控制面是本扩展私有的实现细节 —— 声明出去等于对外
 * 承诺一套并不打算标准化的 API。守卫测试钉住了这条（卡片 JSON 里不得出现控制路径）。
 *
 * ## 入参是结构化的，**不收 CLI 的模糊词法**（一处刻意的设计判断）
 * CLI 的 `/model hy3`、`/permission bash=deny` 是**人类输入词法**：解析它需要 `resolveModelArg`
 * 之类的歧义消解（序号 / 实例 id / 模型名 / `provider/model` 四种写法）。这套词法属于**终端输入面**，
 * 与 `host/permission.ts` 文件头那条既有判断完全同构 ——「文本 → 四态的翻译属 CLI 的输入词汇，
 * 留在 `@harness/cli`」。
 * 所以控制面收 `{ providerId, modelId }` 这样的**结构化字段**：歧义消解留在敲命令的那一端
 * （VSCode 扩展 / CLI），sidecar 只做"把话说清楚的一次翻译"。好处是**协议没有歧义态**，
 * 不必定义"我让用户再选一次"这种回环。
 *
 * ## 边界纪律（与 `@harness/a2a-server` 其余部分同一条）
 * 每个方法只做**参数校验 + 调 host 公共面 + 组织出参**。**不在这里另写业务逻辑** ——
 * 一旦在 sidecar 里补一句"顺便也把 X 改了"，就与 CLI 的 `/xxx` 长成两份实现。
 *
 * ## 与 `/a2a` 的差异（有意为之，逐条写下来免得被当成遗漏）
 * | | `/a2a`（协议面） | `/harness/rpc`（控制面） |
 * |---|---|---|
 * | 版本校验（`A2A-Version`） | **必须** | **不做** —— 它根本不是 A2A |
 * | 错误码词汇 | A2A 的（`A2aErrorCode`） | 控制面自己的（`ControlErrorCode`） |
 * | 幂等键（`messageId`） | 有 | 无（管理操作不需要回放语义） |
 * | 调用方隔离（`contextId` 归属） | 有 | 无 —— 控制面是"持有 token 者即管理员" |
 * | 鉴权 | Bearer | **同一个 Bearer**（同一端口不该有两套凭据） |
 */
import { resolve } from 'node:path'
import { buildCompactionOptions, formatModel, renderNotice, resolveCompactionWindow } from '@harness/host'
import type { Host, HostNotice, PermissionMode } from '@harness/host'
import {
  collectTodayUsage,
  renderChildAgentRollup,
  renderContextOccupancy,
  renderStatsText,
  resolveCurrentUsage,
  todayUsageLine,
} from '@harness/usage'
import type { Session } from '@harness/session'

/** 默认控制端点路径（本扩展私有，非 A2A 协议面） */
export const DEFAULT_CONTROL_PATH = '/harness/rpc'
/** 控制方法的命名空间前缀 —— 与 A2A 方法名**没有任何交集** */
export const CONTROL_METHOD_PREFIX = 'harness/'

/**
 * 控制面错误码。
 *
 * **刻意与 `A2aErrorCode` 分开**：那份词汇是 A2A 协议的一部分（会进任务 metadata、被 TCK
 * 按 code 断言），控制面既不是 A2A、也不该让 A2A 的枚举为它长出新成员。
 */
export type ControlErrorCode =
  /** 方法不在控制面注册表里（客户端拼错 / 版本不匹配） */
  | 'METHOD_NOT_FOUND'
  /** 参数缺失、类型不对、取值不在允许集合内 */
  | 'INVALID_PARAMS'
  /** 目标不存在（会话 id / 技能 id 查不到） */
  | 'NOT_FOUND'
  /** 宿主内部异常（**只回安全文案，不回堆栈**） */
  | 'INTERNAL'

/** 控制错误码 → JSON-RPC 错误码（-32601/-32602/-32603 是协议标准码） */
const CONTROL_JSONRPC_CODE: Record<ControlErrorCode, number> = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  // -32004 落在"实现自定义服务器错误"区间；A2A 把它用作 UnsupportedOperation，
  // 但两条路径的错误码词汇互不解释（客户端按 `data.controlCode` 分支，不按数字）。
  NOT_FOUND: -32004,
  INTERNAL: -32603,
}

/**
 * 控制面错误。
 *
 * `data.controlCode` 是**唯一**供客户端分支的字段 —— 与 `A2aServerError.toJsonRpc()` 同一形态
 * （文案可改、code 不可改），便于客户端两套接口共用一个错误处理骨架。
 */
export class ControlError extends Error {
  readonly controlCode: ControlErrorCode
  readonly detail: Record<string, unknown> | undefined
  readonly jsonRpcCode: number

  constructor(code: ControlErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'ControlError'
    this.controlCode = code
    this.detail = detail
    this.jsonRpcCode = CONTROL_JSONRPC_CODE[code]
  }

  toJsonRpc(): { code: number; message: string; data: Record<string, unknown> } {
    return {
      code: this.jsonRpcCode,
      message: this.message,
      data: { controlCode: this.controlCode, ...(this.detail ?? {}) },
    }
  }
}

// ========================================================================
// 参数校验小工具（只做"形状不对就报 INVALID_PARAMS"，不做类型体操）
// ========================================================================

function asRecord(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new ControlError('INVALID_PARAMS', 'params 必须是对象')
  }
  return params as Record<string, unknown>
}

function requireString(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  if (typeof v !== 'string' || v === '') {
    throw new ControlError('INVALID_PARAMS', `params.${key} 必填，且必须是非空字符串`)
  }
  return v
}

function optionalString(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v === '') {
    throw new ControlError('INVALID_PARAMS', `params.${key} 若给就必须是非空字符串`)
  }
  return v
}

function optionalBoolean(p: Record<string, unknown>, key: string): boolean | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') {
    throw new ControlError('INVALID_PARAMS', `params.${key} 若是布尔值`)
  }
  return v
}

function optionalEnum<T extends string>(
  p: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new ControlError('INVALID_PARAMS', `params.${key} 只能是 ${allowed.join(' / ')}（收到 ${JSON.stringify(v)}）`)
  }
  return v as T
}

// ========================================================================
// 会话寻址
// ========================================================================

/**
 * 会话的**读视图**（活会话与落盘快照的公共部分）。
 *
 * 两类操作刻意分开：
 * - **读**（`session.get` / `agent.list` / `model.get`）走 `readSessionView` —— **不 restore**，
 *   读一次状态不该在 SessionManager 里凭空建出一个会话；
 * - **写**（`agent.set` / `model.set` / `session.new` / `compact`）走 `requireLiveSession` ——
 *   需要真对象才能改（`cur.agentId = …` 那种 in-place 写是 CLI `/agent` 的既有形态，
 *   这里照做而不是自创第二条写路径）。
 */
interface SessionView {
  id: string
  agentId?: string
  meta?: Record<string, unknown>
  title?: string
  cwd?: string
}

/** 宿主是否已完成 boot（没 boot 就没有 `harness` / `session`，报 INTERNAL 而不是 TypeError） */
function assertBooted(host: Host): void {
  if (!host.harness || !host.session) {
    throw new ControlError('INTERNAL', '宿主尚未完成 boot，控制面不可用')
  }
}

/**
 * 会话寻址：`sessionId` 缺省 = sidecar 启动时选中的那条会话。
 *
 * **`sessionId` 就是 A2A 的 `contextId`**（`executor.ensureSession` 钉死的 `contextId = sessionId`）——
 * 于是"控制面改的是哪条会话"与"聊天在跟哪条会话说话"是同一个身份，不需要第二套映射。
 */
async function readSessionView(
  host: Host,
  raw: unknown,
): Promise<{ id: string; view: SessionView; live: Session | undefined }> {
  assertBooted(host)
  const id = typeof raw === 'string' && raw !== '' ? raw : host.session.id
  const live = await host.harness.session.get(id).catch(() => undefined)
  if (live) return { id, view: live, live }
  const saved = await host.sessionStore.load(id).catch(() => undefined)
  if (!saved) throw new ControlError('NOT_FOUND', `会话 ${id} 不存在`)
  return { id, view: saved, live: undefined }
}

/** 变更类操作：活会话优先，其次**恢复**落盘快照（与 executor 同一三级回退的后两级） */
async function requireLiveSession(host: Host, raw: unknown): Promise<Session> {
  const { id, live } = await readSessionView(host, raw)
  if (live) return live
  const saved = await host.sessionStore.load(id)
  if (!saved) throw new ControlError('NOT_FOUND', `会话 ${id} 不存在`)
  return host.restoreSession(saved)
}

// ========================================================================
// 方法注册表
// ========================================================================

type ControlHandler = (params: Record<string, unknown>, host: Host) => Promise<unknown>

/** 一次 notice 的线上形态：原始三元组 + **服务端渲染好的文本** */
interface NoticeWire {
  level: HostNotice['level']
  code: HostNotice['code']
  data: HostNotice['data']
  /** `renderNotice(n)` 的结果 —— 22 条文案只有这一份实现，扩展端直接显示 */
  text: string
}

const METHODS = new Map<string, ControlHandler>()

// ---- 诊断（收掉 plan §6 的那一格：让"降级事实"能到达调用方）----------------

/**
 * `harness/notice.list` —— 宿主装配期的环形缓冲（`host.notices`）。
 *
 * 这是整个控制面**最有价值的一条**：把"未配置 API key，回落到 Mock"这类事实送到消费方，
 * 于是"在 IDE 里拿到 mock 回答却毫无信号"在结构上不可能发生（plan §6 末尾点名的那条风险）。
 *
 * 同时带上 `renderNotice` 的**渲染结果**：文案的唯一定义在 host，扩展端不该抄第二份
 * （设计稿 §11「两套界面文案漂移」的对策）。
 */
METHODS.set('harness/notice.list', async (p, host) => {
  assertBooted(host)
  const level = optionalEnum(p, 'level', ['notice', 'warn', 'log'] as const)
  const rawLimit = p['limit']
  let limit: number | undefined
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit <= 0) {
      throw new ControlError('INVALID_PARAMS', 'params.limit 若是正整数')
    }
    limit = rawLimit
  }
  const filtered = level ? host.notices.filter((n) => n.level === level) : host.notices
  const picked = limit !== undefined ? filtered.slice(-limit) : filtered
  const notices: NoticeWire[] = picked.map((n) => ({
    level: n.level,
    code: n.code,
    data: n.data,
    text: renderNotice(n),
  }))
  return { notices, total: host.notices.length }
})

// ---- 会话 ----------------------------------------------------------------

/** `harness/session.list` —— 对应 `/sessions`（含"本目录上次 / 本目录 / 当前"三个标记位） */
METHODS.set('harness/session.list', async (_p, host) => {
  assertBooted(host)
  const list = await host.sessionStore.list()
  const pointer = await host.sessionPointer.readIfOwnedBy(host.workspace.dataDir).catch(() => undefined)
  const cwd = host.workspace.cwd
  const currentId = host.session.id
  return {
    cwd,
    dataDir: host.workspace.dataDir,
    pointer: pointer?.sessionId ?? null,
    current: currentId,
    sessions: list.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      messageCount: s.messageCount,
      updatedAt: s.updatedAt,
      cwd: s.cwd ?? null,
      agentId: s.agentId ?? null,
      /** 项目级指针指向它（`.harness/last-session.json`） */
      isPointer: s.id === pointer?.sessionId,
      /** 属于当前工作目录（会话目录是全局共享的，不标出来就只能猜） */
      isCwd: !!s.cwd && resolve(s.cwd) === cwd,
      isCurrent: s.id === currentId,
    })),
  }
})

/** `harness/session.get` —— 单条会话的摘要（扩展侧用它拿 contextId 与当前模型） */
METHODS.set('harness/session.get', async (p, host) => {
  const { id, view, live } = await readSessionView(host, p['sessionId'])
  const endpoint = host.resolveSessionEndpoint(view)
  return {
    id,
    live: live !== undefined,
    title: view.title ?? null,
    agentId: view.agentId ?? null,
    model: host.resolveSessionModel(view) ?? null,
    endpoint: { providerId: endpoint.providerId ?? null, modelId: endpoint.modelId ?? null },
    hasModelOverride: Boolean(host.sessionModelOverride(view)),
  }
})

/**
 * `harness/session.new` —— 对应 `/new`。
 *
 * 与 CLI 逐条对齐的两点（都不是可有可无的细节）：
 * 1. **继承会话级模型覆盖**：用户切完模型再开新会话，预期是"同样的设置、干净的上下文"，
 *    让新会话回落到 Agent 默认反而像是设置被重置了；
 * 2. 新会话要 `rememberSession`（写项目级指针），否则"开完就退出"下次恢复的是旧会话。
 */
METHODS.set('harness/session.new', async (p, host) => {
  const cur = await requireLiveSession(host, p['sessionId'])
  const agentId = optionalString(p, 'agentId') ?? cur.agentId ?? host.defaultAgent().id
  if (!host.harness.agent.get(agentId)) {
    throw new ControlError('INVALID_PARAMS', `Agent "${agentId}" 未注册`, {
      available: host.harness.agent.list().map((a) => a.id),
    })
  }
  const created = await host.harness.session.create({ agentId, cwd: cur.cwd ?? host.workspace.cwd })
  const carry = host.sessionModelOverride(cur)
  let next = created
  if (carry) {
    // 走 host 的既有入口（它自己会 updateMeta + 落盘），不在控制面重写一遍 meta 补丁
    next = await host.setSessionModel(created, carry)
  } else {
    await host.sessionStore.save(created)
  }
  await host.rememberSession(next)
  return {
    sessionId: next.id,
    agentId: next.agentId ?? null,
    model: host.resolveSessionModel(next) ?? null,
    carriedModelOverride: Boolean(carry),
  }
})

/** `harness/session.resume` —— 对应 `/resume <id>`（恢复 + 写回项目指针） */
METHODS.set('harness/session.resume', async (p, host) => {
  assertBooted(host)
  const id = requireString(p, 'id')
  const saved = await host.sessionStore.load(id).catch(() => undefined)
  if (!saved) throw new ControlError('NOT_FOUND', `会话 "${id}" 不存在`)
  const session = await host.restoreSession(saved)
  await host.rememberSession(session)
  return {
    sessionId: session.id,
    title: session.title ?? null,
    agentId: session.agentId ?? null,
    messageCount: saved.messages.length,
    model: host.resolveSessionModel(session) ?? null,
  }
})

// ---- Agent ---------------------------------------------------------------

/** `harness/agent.list` —— 对应 `/agent`（无参） */
METHODS.set('harness/agent.list', async (p, host) => {
  const { id, view } = await readSessionView(host, p['sessionId'])
  const current = view.agentId ?? host.defaultAgent().id
  return {
    sessionId: id,
    current,
    agents: host.harness.agent.list().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description ?? null,
      model: host.getModel(a.id) ?? null,
      current: a.id === current,
    })),
  }
})

/** `harness/agent.set` —— 对应 `/agent <id>`（只改本会话，立即落盘） */
METHODS.set('harness/agent.set', async (p, host) => {
  const agentId = requireString(p, 'agentId')
  if (!host.harness.agent.get(agentId)) {
    throw new ControlError('INVALID_PARAMS', `Agent "${agentId}" 未注册`, {
      available: host.harness.agent.list().map((a) => a.id),
    })
  }
  const cur = await requireLiveSession(host, p['sessionId'])
  if ((cur.agentId ?? '') !== agentId) {
    // 与 CLI `/agent` 逐字一致：agentId 是**会话属性**，立即落盘 ——
    // 等下一次 send 才保存，会在"切完就退出"时丢掉。
    cur.agentId = agentId
    cur.updatedAt = Date.now()
    await host.sessionStore.save(cur)
  }
  const override = host.sessionModelOverride(cur)
  return {
    ok: true,
    sessionId: cur.id,
    agentId,
    model: host.resolveSessionModel(cur) ?? null,
    hasModelOverride: Boolean(override),
  }
})

// ---- 模型 ----------------------------------------------------------------

/** `harness/model.get` —— 对应 `/model`（无参）：当前值 + 来源 + 可选清单 */
METHODS.set('harness/model.get', async (p, host) => {
  const { id, view } = await readSessionView(host, p['sessionId'])
  const agentId = view.agentId ?? host.defaultAgent().id
  const override = host.sessionModelOverride(view)
  const endpoint = host.resolveSessionEndpoint(view)
  const cfg = await host.configStore.load().catch(() => undefined)
  return {
    sessionId: id,
    agentId,
    current: host.resolveSessionModel(view) ?? null,
    /** `session` = 本会话覆盖（只影响本会话）；`agent` = Agent 绑定（全局）、可能再落到 Provider 默认 */
    source: override ? 'session' : 'agent',
    override: override
      ? { providerId: override.providerId ?? null, modelId: override.modelId ?? null }
      : null,
    agentModel: host.getModel(agentId) ?? null,
    endpoint: { providerId: endpoint.providerId ?? null, modelId: endpoint.modelId ?? null },
    registeredProviders: host.listProviders(),
    configured: host.listConfiguredProviders().map((c) => ({
      index: c.index,
      id: c.id,
      model: c.model ?? null,
      baseUrl: c.baseUrl ?? null,
      apiPath: c.apiPath ?? null,
      type: c.type ?? null,
      source: c.source ?? null,
      keyTag: c.keyTag ?? null,
    })),
    configProvider: cfg?.provider ?? null,
  }
})

/**
 * `harness/model.set` —— 对应 `/model <spec>`（结构化版）与 `/model reset`。
 *
 * 入参刻意是 `{ providerId?, modelId? }` 而不是 CLI 的 `/model hy3` 自由文本 —— 理由见文件头
 * 「入参是结构化的」一节：歧义消解（序号 / 实例 id / 模型名 / `provider/model`）属**输入词汇**，
 * 留在敲命令的那一端。
 *
 * 三个作用域（`global` 缺省 = 只改本会话，与 CLI 的默认一致）：
 * - `reset: true` → 清除会话覆盖，回到 Agent 默认；
 * - 缺省 → 写会话覆盖（只影响本会话，随会话落盘）；
 * - `global: true` → 写 Agent 定义的全局默认（**会写 config.json**），并顺手清掉会话覆盖 ——
 *   否则"已切全局"却仍走旧模型，用户会以为命令没生效（CLI 同）。
 */
METHODS.set('harness/model.set', async (p, host) => {
  const cur = await requireLiveSession(host, p['sessionId'])
  const agentId = cur.agentId ?? host.defaultAgent().id

  if (optionalBoolean(p, 'reset') === true) {
    const fresh = await host.setSessionModel(cur, undefined)
    return {
      ok: true,
      scope: 'session',
      cleared: true,
      current: host.resolveSessionModel(fresh) ?? null,
      warning: null,
    }
  }

  const providerId = optionalString(p, 'providerId')
  const modelId = optionalString(p, 'modelId')
  if (!providerId && !modelId) {
    throw new ControlError(
      'INVALID_PARAMS',
      'providerId / modelId 至少给一个（若要清除会话覆盖，用 { "reset": true }）',
    )
  }

  const global = optionalBoolean(p, 'global') === true
  if (global) {
    const spec = formatModel(providerId, modelId) ?? modelId
    if (spec === undefined || !(await host.setModel(agentId, spec))) {
      throw new ControlError('INVALID_PARAMS', `无法按 "${spec ?? ''}" 切换 Agent "${agentId}" 的模型`, {
        agentId,
        configured: host.listConfiguredProviders().map((c) => `${c.id}/${c.model ?? ''}`),
      })
    }
    if (host.sessionModelOverride(cur)) await host.setSessionModel(cur, undefined)
  } else {
    await host.setSessionModel(cur, {
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
    })
  }

  // 目标 Provider 未装配到当前进程时会**静默回退默认**（如 mock）——如实回报，
  // 否则用户只会看到"为什么一直是 mock"（CLI 的同一处提醒）。
  let warning: string | null = null
  if (providerId) {
    const actual = host.resolveChatProvider(providerId)?.id
    if (actual && actual !== providerId) {
      warning = `当前进程未装配 Provider "${providerId}"，实际将以 "${actual}" 发送；需重启 sidecar 使配置生效`
    }
  }

  const fresh = (await host.harness.session.get(cur.id)) ?? cur
  return {
    ok: true,
    scope: global ? 'global' : 'session',
    cleared: false,
    current: host.resolveSessionModel(fresh) ?? null,
    warning,
  }
})

// ---- 权限 ----------------------------------------------------------------

/** `harness/permission.get` —— 对应 `/permission`（查看） */
METHODS.set('harness/permission.get', async (_p, host) => {
  assertBooted(host)
  return {
    mode: host.permission.getMode() satisfies PermissionMode,
    rules: host.permission.getRules() as Record<string, unknown>,
  }
})

/**
 * `harness/permission.set` —— 对应 `/permission <mode>` / `/permission <key>=<behavior>` / `reset`。
 *
 * 四种入参形态（互斥性由方法自己校验，客户端不必猜）：
 * - `{ reset: true }` 清空规则、模式回 `ask`；
 * - `{ mode }` 切换交互模式（只作用于"询问型"请求，规则文件不变）；
 * - `{ rules }` 整份替换（用于"删掉某条规则"这类 CLI 表达不了的操作）；
 * - `{ key, behavior }` 单条增改（`behavior ∈ allow|deny|ask`）。
 *
 * ⚠️ 安全边界：本方法会**写盘** `permissions.json`。控制面默认只监听 `127.0.0.1`，
 * 且与 `/a2a` 共用同一个 Bearer —— "持有 token 者即管理员"是显式的信任模型（见文件头表格）。
 */
METHODS.set('harness/permission.set', async (p, host) => {
  assertBooted(host)
  const reset = optionalBoolean(p, 'reset') === true
  const mode = optionalEnum(p, 'mode', ['allow-all', 'ask', 'deny-all'] as const)
  const rawRules = p['rules']
  const key = optionalString(p, 'key')

  if (!reset && mode === undefined && rawRules === undefined && key === undefined) {
    throw new ControlError(
      'INVALID_PARAMS',
      '至少要给 reset / mode / rules / key+behavior 之一',
    )
  }

  if (reset) {
    await host.setPermissionRules({ '*': 'ask' })
    host.permission.setMode('ask')
  }
  if (mode !== undefined) host.permission.setMode(mode)
  if (rawRules !== undefined) {
    if (rawRules === null || typeof rawRules !== 'object' || Array.isArray(rawRules)) {
      throw new ControlError('INVALID_PARAMS', 'params.rules 必须是对象（{ 工具键: allow|deny|ask }）')
    }
    await host.setPermissionRules(rawRules as Record<string, unknown>)
  }
  if (key !== undefined) {
    const behavior = requireString(p, 'behavior')
    if (!['allow', 'deny', 'ask'].includes(behavior)) {
      throw new ControlError('INVALID_PARAMS', `behavior 只能是 allow / deny / ask（收到 ${JSON.stringify(behavior)}）`)
    }
    const current = host.permission.getRules() as Record<string, unknown>
    await host.setPermissionRules({ ...current, [key]: behavior })
  }

  return {
    ok: true,
    mode: host.permission.getMode(),
    rules: host.permission.getRules() as Record<string, unknown>,
  }
})

// ---- 技能 ----------------------------------------------------------------

/** `harness/skill.list` —— 对应 `/skills`（无参） */
METHODS.set('harness/skill.list', async (_p, host) => {
  assertBooted(host)
  return host.skillInfos()
})

/** `harness/skill.set` —— 对应 `/skills <enable|disable|reload> <id>` */
METHODS.set('harness/skill.set', async (p, host) => {
  assertBooted(host)
  const op = optionalEnum(p, 'op', ['enable', 'disable', 'reload'] as const)
  if (op === undefined) {
    throw new ControlError('INVALID_PARAMS', 'params.op 必填，且只能是 enable / disable / reload')
  }
  const id = requireString(p, 'id')
  const res =
    op === 'disable'
      ? await host.disableSkill(id)
      : op === 'enable'
        ? await host.enableSkill(id)
        : await host.reloadSkill(id)
  return { ...res, op, id }
})

// ---- 统计 ----------------------------------------------------------------

/**
 * `harness/stats.get` —— 对应 `/stats`。
 *
 * 前置（P2-v1 落地）：`resolveCurrentUsage` / `renderChildAgentRollup` /
 * `renderContextOccupancy` / `collectTodayUsage` 已上移 `@harness/usage` ——
 * CLI 与本方法共用同一批装配函数，文案只有一份（设计稿 §11 的对策）。
 *
 * 与 CLI `/stats` 同口径的三件事：
 * - 「含子 agent」聚合行走 `usage.children()`（展示层聚合，不并进父会话 meta）；
 * - 上下文占用区的窗口/阈值取 `/compact` 同一套 `buildCompactionOptions`，
 *   且**按本会话实际端点**解析分母（子会话分母各自解析）；
 * - 当日用量只读持久化会话文件归集（跨会话），当前会话无条件纳入。
 *
 * 出参同时给**结构化字段**（usage / today）与**服务端渲染好的 text**（整页）——
 * 渲染文案的唯一定义在宿主侧，扩展端直接显示 text，不抄第二份渲染器。
 */
METHODS.set('harness/stats.get', async (p, host) => {
  const cur = await requireLiveSession(host, p['sessionId'])
  const usage = await resolveCurrentUsage(host.harness, cur)
  const today = await collectTodayUsage(host.sessionStore, cur)
  const rollupText = await renderChildAgentRollup(host.harness, cur.id)
  const cfg = await host.configStore.load()
  const providerId = cfg.provider ?? 'anthropic'
  const compactOpts = buildCompactionOptions(cfg, providerId, host.resolveSessionEndpoint(cur))
  const occupancyText = await renderContextOccupancy(host.harness, cur, compactOpts, (s) =>
    resolveCompactionWindow(cfg, providerId, host.resolveSessionEndpoint(s as Session | undefined)))
  return {
    usage,
    today,
    rollupText,
    occupancyText,
    /** 整页文本 = CLI `/stats` 的同一段输出（renderStatsText + 子 agent 聚合 + 占用区 + 当日行） */
    text:
      renderStatsText(usage) +
      '\n' +
      rollupText +
      occupancyText +
      `\n${todayUsageLine(today)}（全部会话·当日）\n`,
  }
})

// ---- 压缩 ----------------------------------------------------------------

/**
 * `harness/compact` —— 对应 `/compact [auto|prune|summary|agent]`。
 *
 * 窗口/阈值口径走 `buildCompactionOptions`（host 里的唯一一份推导），且**按本会话实际端点**解析 ——
 * 这正是 AGENTS.md 记着的那条老病：同一份 config 算出两个窗口，阈值判据就失效了。
 *
 * `stats` 已在 P2-v1 补上（`harness/stats.get`）：其前置是把装配函数上移 `@harness/usage`，
 * 见下方该方法与设计稿 §6.3 的订正框。
 */
METHODS.set('harness/compact', async (p, host) => {
  const cur = await requireLiveSession(host, p['sessionId'])
  const strategy = optionalEnum(p, 'strategy', ['ifneeded', 'prune', 'summary', 'agent'] as const) ?? 'ifneeded'
  const cfg = await host.configStore.load()
  const opts = buildCompactionOptions(
    cfg,
    cfg.provider ?? 'anthropic',
    host.resolveSessionEndpoint(cur),
  )

  let did: boolean
  if (strategy === 'ifneeded') {
    did = await host.harness.session.compactIfNeeded(cur.id, opts)
  } else {
    await host.harness.session.compact(cur.id, strategy, opts)
    did = true
  }
  const info = await host.harness.session.getCompactionInfo(cur.id)
  return {
    did,
    sessionId: cur.id,
    strategy,
    info: {
      count: info.meta?.count ?? 0,
      totalPrunedMessages: info.meta?.totalPrunedMessages ?? 0,
      lastStrategy: info.meta?.lastStrategy ?? null,
      lastMessagesBefore: info.meta?.lastMessagesBefore ?? null,
      lastMessagesAfter: info.meta?.lastMessagesAfter ?? null,
      round: info.memory?.round ?? 0,
      summaryPreview: info.memory?.summaryText ? info.memory.summaryText.slice(0, 400) : null,
    },
  }
})

// ========================================================================
// 分发
// ========================================================================

/** 控制面已注册的全部方法名（自检 / 文档 / 客户端能力探测用；已排序，顺序稳定） */
export function listControlMethods(): string[] {
  return [...METHODS.keys()].sort()
}

/** 是否属于控制面命名空间（命名空间内的未知方法仍走 `METHOD_NOT_FOUND`，只是错误文案不同） */
export function isControlMethod(method: string): boolean {
  return method.startsWith(CONTROL_METHOD_PREFIX)
}

/**
 * 分发一次控制请求。**路由与协议壳不在这里** —— 这里只有"校验 + 调 host + 组织出参"，
 * 于是绝大多数用例可以直接调它（不必起端口、不必发 HTTP）。
 */
export async function dispatchControl(host: Host, method: string, params?: unknown): Promise<unknown> {
  const handler = METHODS.get(method)
  if (!handler) {
    throw new ControlError(
      'METHOD_NOT_FOUND',
      isControlMethod(method)
        ? `未知控制方法 "${method}"`
        : `控制面的方法必须以 "${CONTROL_METHOD_PREFIX}" 开头（收到 "${method}"）`,
      { method, available: listControlMethods() },
    )
  }
  return handler(asRecord(params), host)
}
