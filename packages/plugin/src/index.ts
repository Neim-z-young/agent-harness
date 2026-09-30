/**
 * @harness/plugin - 插件管理
 *
 * 结合 OpenCode Hooks 流水线 + Claude Code 多来源插件加载。
 *
 * 三级插件加载顺序：
 * 1. Internal 内置插件（硬编码）
 * 2. Builtin 默认插件（npm 白名单）
 * 3. User 用户插件（配置文件指定，支持 file:///）
 * 每一级内部按 dependsOn 拓扑排序
 *
 * Hooks 命名规范：**层.域.动作** 格式（如 core.tool.pre.execute、cli.agent.stream）。
 * 首段锁定「谁触发这条 hook」的层，避免同一域下出现两个来源、消费方分不清。
 */

import type { Awaitable, Bus, BusEventRecord } from '@harness/bus'

// ===== PluginContext =====

/**
 * 插件安装上下文
 * 由 PluginManager 在 install() 时注入
 */
/**
 * 宿主工作区路径视图（只读）。
 *
 * 刻意**不** import `@harness/workspace` 的类型：该包依赖 `@harness/session`，
 * 而契约层要保持"只依赖 bus"的轻量依赖方向。这里用结构化最小接口，
 * `Workspace` 对象在结构上可直接赋值（TS 结构化类型），因此不会漏字段 ——
 * 若 workspace 包改了字段名，赋值处会编译报错。
 *
 * 存在意义：插件在 `install(ctx)` 与 `core.session.preModel` / `core.prompt.system.transform`
 * 等**每轮 hook** 里都需要知道"记忆/技能该写到哪、该从哪读"。此前插件只能拿
 * `process.cwd()` 猜，而 CLI 支持 `--cwd` / `--data-dir` ⇒ 会拼错目录
 * （本项目已两次栽在"路径口径分裂"上）。
 */
export interface PluginWorkspaceView {
  /** 工作目录（绝对路径） */
  cwd: string
  /** 用户级数据根（缺省 ~/.harness） */
  dataDir: string
  user: { root: string; plugins: string; skills: string; agents: string; memory: string }
  project: { root: string; plugins: string; skills: string; agents: string; memory: string }
}

export interface PluginContext {
  /** Bus 事件总线（发布/订阅事件） */
  bus: Bus
  /** 配置访问 */
  config: {
    get<T>(key: string): T | undefined
    set<T>(key: string, value: T): void
  }
  /** 日志器 */
  log: {
    info(msg: string, meta?: unknown): void
    warn(msg: string, meta?: unknown): void
    error(msg: string, meta?: unknown): void
    debug(msg: string, meta?: unknown): void
  }
  /**
   * 宿主工作区路径（core 注入；缺省时插件须自行回退）。
   *
   * 可选是刻意的：`createPluginManager` 可被独立使用（单测、非 CLI 宿主），
   * 此时没有 workspace —— 插件应把它当作"路径未知"而不是崩溃。
   */
  workspace?: PluginWorkspaceView
}

// ===== Tool Pool =====

/**
 * 工具池（组装阶段使用）
 * 由 Agent Runtime 构造，插件通过 hook 注入/移除工具
 */
export interface ToolPool {
  /** 添加工具 */
  add(tool: unknown): void
  /** 批量添加 */
  addAll(tools: unknown[]): void
  /** 条件添加（不存在时才加） */
  addIfMissing(toolIds: string[]): void
  /** 移除工具 */
  remove(toolId: string): void
  /** 列出所有工具 */
  list(): unknown[]
}

// ===== Hook 输入/输出类型 =====

export interface HarnessInitInput {
  harnessOptions: unknown
}
export interface HarnessInitOutput {
  harness?: unknown
}

export interface HarnessStartInput {
  harness: unknown
}
export interface HarnessStartOutput {
  started: boolean
}

export interface ToolPoolAssembleInput {
  agentId: string
}

export interface LLMInput {
  providerId: string
  modelId?: string
  messages: unknown[]
}

export interface LLMParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  [key: string]: unknown
}

export interface PromptInput {
  agentId: string
  sessionId: string
  /**
   * 该 Agent 的模式（`primary` / `subagent` / `coordinator` / `teammate`…）。
   *
   * 供 prompt 构建类插件按 agent 类型分流 —— 典型用法：主会话的记忆**不注入子 Agent**
   * （对齐 Claude Code 的 subagent 隔离语义）。此前 hook 只给 agentId，
   * 插件还得自己查注册表（且拿不到），只能在首轮猜。
   */
  agentMode?: string
  /**
   * 本轮用户输入里疑似引用的文件路径（供技能 `paths` 条件触发 —— core 从用户消息提取，
   * 命中 `skill.paths` glob 的技能经 `core.prompt.dynamic.transform` 注入尾部）。
   * 缺省表示未提供（插件不得依赖它做"无 paths 也注入"的判定）。
   */
  involvedPaths?: string[]
}

/**
 * 系统区（前缀区）跨 turn 稳定性报告 —— 回答"这一轮是谁把前缀改了"。
 *
 * 为什么需要：自动前缀缓存按**最长公共 token 前缀**命中，而 system prompt 位于请求位置 0。
 * 它里面任何一个字符变化，其后**整个历史**都要按全价重算（真机量化见 acp-context 的
 * `MANUAL_INJECT_MARGIN` 注释：越阈值时翻转一次 ≈ 95K token-equiv）。而 system 区是
 * **多个插件往同一个数组 push** 拼出来的 —— 出问题时想知道的是"谁 push 的那段变了"，
 * 不是"system 变了"。所以这里做**段级**归因，而不是整段文本比对。
 *
 * 归因结果同时进两处：引擎的 `logger.warn`（人读）与 `core.session.preModel` 的
 * `input.systemStability`（机器读，ACP 写进遥测 `providerCache.systemChangedParts`）。
 */
export interface SystemStabilityReport {
  /** 本轮快照时间戳 */
  at: number
  /** 上一轮快照时间戳（两者间隔越久说明两次变化距得越远） */
  prevAt: number
  /** 本轮 system 段数 */
  parts: number
  /** 上一轮 system 段数 */
  prevParts: number
  /** 内容发生变化的段下标（同下标、指纹不同） */
  changedParts: number[]
  /** 上一轮没有、本轮新增的段下标 */
  addedParts: number[]
  /** 上一轮有、本轮被移除的段下标 */
  removedParts: number[]
  /** 人读归因（每项形如「第 2 段变化：642 → 1 284 字符（原首行：「项目长期记忆」）」） */
  details: string[]
}

export interface CompactionContext {
  /** 保留最近 N 条消息（插件可改写） */
  keepLast?: number
  /** 摘要策略（插件可改写；`prune` 表示仅删除不写摘要） */
  strategy?: 'prune' | 'summary' | 'agent'
  /** 摘要内容（输出；插件若已提供则 core 不再自行生成） */
  summary?: string
  /**
   * 待压缩窗口（将要被删除的消息，只读参考）。core 会在真正删除前的
   * `core.session.compacting` hook 里传入，供 ACP 等插件在删除前保全原文。
   * 语义为只读：插件不应修改该数组（core 之后会按 keepLast 重算并存取）。
   */
  window?: readonly unknown[]
  /**
   * 插件置 true 表示已把 window 原文保全到自身持久化（如 ACP 块/摘要文件），
   * core 可放心物理删除。非强制：未置位时 core 仅按默认行为压缩。
   */
  windowHandled?: boolean
  /**
   * 插件折叠成功后产出的压缩块（统一块模型）。
   * 输出字段：ACP 等插件把孩子折叠成新块时回传，core 将其追加到 session.blocks，
   * 与通用 compact 块一致供视图/loader/reconstructHistory/revert 消费。
   */
  blocksPatch?: {
    id: string
    topic?: string
    summary: string
    startId: string
    endId: string
    source?: 'generic' | 'acp'
    archiveRef?: string
  }[]
  /**
   * 会话 meta 访问器：与 `core.session.preModel` 的 meta 同义，供插件在物理删除前
   * 把窗口原文/状态持久化到 session.meta，跨重启后可回溯。只读/浅合并读写。
   */
  meta?: {
    read: () => Promise<Record<string, unknown> | undefined>
    patch: (patch: Record<string, unknown>) => Promise<void>
  }
}

/** core.session.preModel hook 的输入（每轮进入模型前） */
export interface SessionPreModelInput {
  /** 会话 ID */
  sessionId: string
  /** Agent ID */
  agentId: string
  /** 目标 Provider ID */
  providerId: string
  /** 目标模型 ID（可选） */
  modelId?: string
  /**
   * 该 Agent 本轮的**最终可用工具 id 列表**（已过 agent 白名单 + MCP 供给，即真正喂给模型的那一份）。
   *
   * 为什么由 core 传、而不是让插件自己查：preModel 是唯一同时看得到「历史」与「该 Agent 能力边界」
   * 的位置，而插件侧拿不到 agent 定义（`PluginContext` 里没有 agent registry）。判别符本就在上游
   * —— `_prepareQueryOnce` 已经算好了 `agent.tools → allowedTools`，传下来即可（与 `PromptInput.agentMode`
   * 同一决策：hook 只给 agentId 时插件只能去猜）。
   *
   * 典型消费者：ACP 据此决定压缩手册/提示该不该注入 —— 白名单里没有 `compress` 的 Agent 拿到手册
   * 只会照着拼入参、然后撞 `TOOL_NOT_ALLOWED`（真机会话 `s_1790685043685_1p8sw` 里 12 次全撞，
   * 模型自己都只能打断"the compress tool isn't actually available despite the philosophy text"）。
   *
   * **缺省表示未知**（非 core 宿主、单测直调）——消费方应 fail-open（按旧行为处理），不要当成空集。
   */
  agentTools?: readonly string[]
  /**
   * 本会话的父会话 id —— **子 Agent 会话才有**（由 `session.create({ parentId })` 写入）。
   *
   * 是「这是不是子 Agent 会话」的**可靠判据**：比按 agent 定义的 `mode` 反推更准，因为
   * coordinator 也可能被当子 Agent 派出（那时 mode 仍是 `coordinator`）。
   * 缺省 = 不是子会话（或宿主未提供）。
   */
  parentSessionId?: string
  /**
   * 把精简后的会话消息回写持久层（不含 system）。消息 object 形态由 host 决定（本项目为 Message[]）。
   */
  save: (messages: unknown[]) => Promise<void>
  /**
   * 插件本轮折叠产出的压缩块（统一块模型）。
   * 输出字段：ACP 等插件把每轮内部折叠（tier 1/2/3）的块 push 进该数组，
   * host 在 preModel hook 返回后统一合并进 session.blocks（按块 id 去重覆盖），
   * 与通用 compact 块一致供视图/loader/reconstructHistory/revert 消费。
   */
  blocksPatch?: {
    id: string
    topic?: string
    summary: string
    startId: string
    endId: string
    source?: 'generic' | 'acp'
    archiveRef?: string
  }[]
  /**
   * 本轮相对**上一轮 query** 的系统区（前缀）稳定性归因；首轮无基线时为 undefined。
   *
   * 只在确实发生变化时有值（`details` 非空），因此可以直接拿来当"前缀这一轮被改坏了"
   * 的判据 —— 不必自己再维护一份上一轮的 system 快照。
   * 典型消费者：ACP 把 `changedParts` 写进遥测，让 `cacheMissReason: 'system-changed'`
   * 从"系统区变了"细化到"**第 N 段**变了"。
   */
  systemStability?: SystemStabilityReport
  /**
   * 本轮 `core.prompt.dynamic.transform` 收集到的尾部动态片段（原始文本，尚未渲染拼接）。
   *
   * 为什么归因方需要它：core 在 preModel **返回之后**才把这些片段拼成请求末尾的那条 user
   * 消息（见 core 的 `_buildStepMessages`），因此 preModel 里按 `messages` 建视图的插件
   * **完全看不见它**。而它恰好是请求的最后一条 —— 也是 anthropic 显式 promptCache 断点
   * （打最后一条）的落点。不提供这个字段，那种装配下最后一段 cache write 在遥测里就没有
   * 任何解释：`cacheMissReason` 会说 `none`（前缀确实没动），读数却显示有写入。
   * 空数组 = 本轮确实没有尾部动态块，不是"未接线"；宿主不传 = 未接线。
   */
  dynamicParts?: string[]
  /**
   * 会话 meta 访问器：插件可据此在 session.meta 中持久化运行时状态
   * （如 ACP 压缩状态），随会话落盘、重启后恢复。patch 为浅合并。
   */
  meta: {
    /** 读取当前会话 meta（无则 undefined） */
    read: () => Promise<Record<string, unknown> | undefined>
    /** 浅合并写入 session.meta */
    patch: (patch: Record<string, unknown>) => Promise<void>
  }
}

export interface PermissionRequestLike {
  toolKey: string
  patterns: string[]
  input: unknown
  from?: string
  /** 仅参与 deny 判定的附加 pattern（可选；见 @harness/permission PermissionRequest.denyPatterns） */
  denyPatterns?: string[]
}

export interface PermissionDecisionLike {
  behavior: 'allow' | 'deny' | 'ask'
  updatedInput?: unknown
  remember?: boolean
}

// ===== Agent 流式事件（外部集成用） =====

/**
 * Agent 运行时状态快照。由消费层把流式事件归约而成，供集成类插件（状态上报、
 * 遥测、外部 UI 桥接）直接消费，无需各自解释原始事件。
 */
export interface AgentStatusSnapshot {
  /** Agent ID（未知时可缺省 —— 集成类插件不应假定它必然存在） */
  agentId?: string
  /** Agent 显示名（有则填） */
  agentName?: string
  /** Agent 模式（primary / subagent / teammate …，有则填） */
  mode?: string
  /**
   * 当前阶段：
   * - `idle` 等待输入（未开始或整轮已结束）
   * - `thinking` 模型推理中（含工具返回后的继续推理）
   * - `streaming` 正在收到文本增量
   * - `tool` 工具执行中（失败时也留在此态，便于显示「卡在哪个工具上」）
   * - `waiting` 步间等待中（`step_gate`：派工后的后台任务未跑完，引擎在下一步之前让出时间；
   *   此时**没有**模型调用在跑，集成方不要把这一段时间算进"模型耗时"）
   * - `aborted` 被中断（Ctrl-C / 超限被拦）
   */
  phase: 'idle' | 'thinking' | 'streaming' | 'tool' | 'waiting' | 'aborted'
  /** 当前步序号（多步循环下从 1 开始；已知时填） */
  step?: number
  /** 正在执行的工具 ID（phase=tool 时） */
  toolId?: string
  /** 结束原因（stop / tool_calls / length / content_filter / error，已知时填） */
  finish?: string
  /** 是否因外部中断而结束（区别于模型正常收尾） */
  aborted?: boolean
}

/** `cli.agent.stream` hook 的输入 */
export interface AgentStreamSignal {
  /** 原始事件类型名（text_delta / tool_call_start / done / turn_end …），仅供排查 */
  eventType: string
  /** 归约后的当前状态 */
  status: AgentStatusSnapshot
  /** 会话 ID（外部集成可用它做会话关联/恢复） */
  sessionId?: string
}

/**
 * `core.agent.turn.end` hook 的输入：**引擎层**的整轮终态。
 *
 * 与 `cli.agent.stream` 的分工（两者名字必须分得开，否则消费方无法判断"这条是谁发的"）：
 * - `cli.agent.stream`：**UI 消费层**（CLI 的 REPL / TUI / run）把流式事件归约成"现在在干什么"，
 *   只在有 UI 的宿主里触发；它是状态流（一条 turn_end 只是"该收 busy 了"）。
 * - `core.agent.turn.end`：**引擎**（core.queryStream 的 finally）在整轮结束时发出的事实，
 *   任何宿主都有（含以库内嵌、ACP 宿主自己消费事件流）。带的是引擎侧事实字段
 *   （跑了几步、末步 finish、是否被中断），不是 UI 状态。
 *
 * 触发范围：每次 `queryStream` / `query()` 整轮结束 —— **包括子 Agent 的轮**
 * （引擎不做"哪一轮算用户的轮"这种消费侧判断）。消费方按 `mode` / `sessionId` 自行筛。
 */
export interface AgentTurnEndSignal {
  /** 跑完这一轮的 Agent */
  agentId: string
  /** Agent 显示名（有则填） */
  agentName?: string
  /** Agent 模式（primary / subagent / teammate / coordinator，有则填） */
  mode?: string
  /** 会话 ID */
  sessionId?: string
  /** 本轮实际跑了几步（从 1 起；未跑起来就结束时为 0） */
  step: number
  /**
   * 本轮有多少步**没有**计入 `maxSteps` 额度（缺省 0，即有值时才填）。
   *
   * 唯一来源是「必填全缺」的入参回喂步（模型发了零参数工具调用，core 用 `[入参自愈]`
   * 回喂必填清单 —— 那一步只是在把参数补齐，不该吃额度）。没有这个字段时，
   * "步号 30 但额度没耗尽"看起来像 bug；有了它，消费方不必猜。
   */
  freeSteps?: number
  /**
   * 本轮有**几步是空步**（模型什么都没给：无用量 / 无正文 / 无推理 / 无工具调用）。
   *
   * 有值时才填。判据与 `core.step.empty` 同源 —— 那里是单步事实，这里是整轮汇总。
   * 用途：区分「模型连续几次零产出」与「请求层整轮没跑起来」（后者连 `step` 都不会有 outcome）。
   */
  emptySteps?: number
  /** 末步结束原因（stop / tool_calls / length …；中断或未起步时可能缺省） */
  finish?: string
  /** 是否因外部中断（`signal`）而提前结束 */
  aborted?: boolean
}

/**
 * `core.tool.params.missing` hook 的信号：一次工具调用因「必填项没给全」被拒。
 *
 * 只有 core 一个触发点 —— `_runOneStep` 里 `describeMissingRequiredParams` 命中处
 * （那也是 `selfHealOnly` 免计额度的唯一登记点，两者同源、不会分叉）。
 *
 * 为什么不能靠 `core.tool.post.execute` 替代：那条 hook 在**工具入口返回失败时**就触发，
 * 而 core 的 `[入参自愈]` 说明是在它**之后**才拼进错误消息的 ⇒ 消费方在 post hook 里
 * 永远看不到"这次失败是缺参数"。真机 14 次 `input: {}`（s_1790592617954_axqkk）因此
 * 只能统计成"工具失败 N 次"，分不出类型。
 */
export interface ToolParamsMissingSignal {
  /** 工具 id（低基数） */
  toolId: string
  /** 会话 ID（缺失时事件会落到 run 级文件，见 telemetry 的 persist） */
  sessionId?: string
  agentId?: string
  /** 步号（从 1 起） */
  step: number
  /** 缺了几个必填项（不记参数值，只记数量 —— 遥测红线：不落提示词/入参正文） */
  missingCount: number
}

/**
 * `core.step.empty` hook 的信号：一步跑完，模型**什么都没给**。
 *
 * 判据四条全否：无 tokenUsage、无 text、无 reasoning、无 tool call。
 * 这类步目前完全不可观测 —— 它既没有 `core.llm.usage`（没用量），
 * assistant 消息又是空 parts（`toolCallCount === 0` ⇒ 不续轮 ⇒ 整轮就此结束），
 * 于是遥测里只剩一条 `turn.end`（`step=1`、`billedSteps=1`），看不出"模型根本没说话"。
 *
 * 真机 s_1790592617954_axqkk 开场 3 轮正是这个形态：三条同文输入、各 1 步、
 * 有 `preModel` 无 `providerCache`、无 assistant 落盘。两种假设（请求连续失败 vs
 * 空响应未落盘）此前无法区分 —— 本信号是"空响应"那一种的直接证据；
 * 若整轮连本信号都没有（`step` 计数增长但无 outcome），则是另一种。
 */
export interface StepEmptySignal {
  sessionId?: string
  agentId?: string
  /** 步号（从 1 起） */
  step: number
  /** provider 是否回报了用量（false = 连 usage 都没有，更可能是请求层失败） */
  hasTokenUsage: boolean
  /** 本步是否被外部中断（abort 导致的空步不算"模型没说话"） */
  aborted: boolean
}

/**
 * `core.tool.whitelist.blocked` hook 的信号：一次工具调用点名了「**已注册**、但不在本
 * agent `tools:` 白名单内」的工具，core 已拒绝执行（Fail-Closed）。
 *
 * 为什么单开一条而不是并入工具失败遥测：这是**能力边界**事件，与"工具自身报错"不是一类
 * —— 它意味着模型试图调用一个它本不该看见的工具。真机 s_1790592617954_axqkk：reader 的
 * `tools:` 只有 read_file/list_dir/glob/grep_file，`compress` 却调用成功。根因是执行期
 * 解析曾回落全局注册表（`allowedTools.find(...) ?? toolRegistry.get(...)`），把
 * "看不到" 当成了 "不能调" —— 而模型并不能保证只点自己看得见的工具。
 *
 * 该 hook 只被"越界"触发；不存在的工具 id（单纯拼错）不触发（没有可审计的边界可谈）。
 */
export interface ToolWhitelistBlockedSignal {
  /** 被点名的工具 id（低基数） */
  toolId: string
  sessionId?: string
  agentId?: string
  /** 步号（从 1 起） */
  step: number
}

/**
 * `core.agent.step.gate` hook 的输入：引擎在**下一步开跑前**问"要不要先等一会"。
 *
 * 动机（真机 s_1790163574429_tg1a6）：lead 派完 4 个后台 reader 后无事可做，却仍在
 * 20 秒内把 30 步额度烧光（证据：msg31 / msg66 两次撞顶，共 60 步，而第一次撞顶时
 * 后台任务只做了一半）。步数是"引擎内自主续轮"的预算，烧完就只能在**下一轮 query**
 * 里才可能看到结果 —— 于是要么用户自己敲键唤醒，要么靠 barrier 事件续轮。
 *
 * 闸门机制：每步开跑前（step ≥ 2）触发本 hook，插件报"还有存活的背景任务"时，
 * 引擎按 3s → 6s → 12s → 24s → 48s → 60s（封顶）退避等待，**每个步边界最多等一档**
 * （不是"一直等到没任务为止"——后者会让单独一步阻塞好几分钟）。档内还会按
 * `STEP_GATE_SLICE_MS`（默认 500ms）**分片重探**：后台任务中途跑完就提前结束这一档，
 * 不必把整档睡满。效果是把"20 秒烧 30 步"摊成"后台任务跑完的那段时间里烧同样多的步"，
 * 于是结果更可能在**同一条 query 内**到达。
 *
 * 分层判据：这是引擎事实（CLI / 内嵌库 / ACP 宿主都该有），所以是 `core.` 前缀；
 * 触发者只有 core.queryStream 一处。
 *
 * 与 bus 事件的分工：事件（`subagent.completed` 等）是"发生了什么"的广播，
 * 本 hook 是"要不要等一下"的**询问**（需要返回值），因此走 hook 不走 bus。
 */
export interface AgentStepGateInput {
  /** 会话 ID */
  sessionId: string
  /** 即将开跑的那一步的序号（从 1 起；本 hook 只在 step ≥ 2 触发） */
  nextStep: number
  /** 跑这一轮的 Agent */
  agentId: string
  /**
   * **本轮 query 内**已连续等待的次数（0 = 还没等过）。
   *
   * 注意作用域是「本轮」而不是「本步」——引擎侧变量在步循环**之外**声明、跨步累加，
   * 这正是退避阶梯能在步与步之间递进的原因（第 2 步前取第 1 档、第 3 步前取第 2 档）。
   * 探测到"没有存活任务"时归零，下一波派工从最小档重新起步。
   * 插件可据此把"刚派工"与"已经等了很久"分开处理；引擎只用它取退避阶梯。
   *
   * ⚠️ 想区分"档内分片重探"与"新的一次等待"就看这里：**片间重探属于同一档**，
   * 它传进来的 `waitAttempt` / `waitedMs` 与这一档开始时**完全相同**（引擎要到整档
   * 结束才记一次账），进入下一档才会 +1。
   */
  waitAttempt: number
  /** **本轮 query 内**已累计等待的毫秒数（跨步累加、不随步重置；片间重探期间同样不变） */
  waitedMs: number
  /** 本轮 query 已经跑了多少步 */
  step: number
}

/**
 * `core.agent.step.gate` 的**可变决策**（管道式：插件原地改写）。
 *
 * 多插件都实现时语义是 **OR**：任一插件置 `pending = true` 引擎就等一次
 * （不会按插件个数等多次）。`aliveCount` 取各插件上报的最大值（都是"我这里还有几个在跑"）。
 */
export interface AgentStepGateDecision {
  /** 还有存活的后台任务 ⇒ 值得等一会（默认 false：不等） */
  pending?: boolean
  /** 存活的后台任务数（诊断与界面心跳用；多插件取最大值） */
  aliveCount?: number
  /** 为什么还值得等（写给界面那一行心跳；缺省时引擎自己拼一句） */
  reason?: string
}

/**
 * 一次 LLM 调用的用量事实（引擎 → 插件广播）。
 *
 * 与 `core.agent.turn.end` 同属「引擎事实」：任何宿主都有（CLI / 内嵌库 / ACP 宿主自己
 * 消费事件流）。用途是把 provider 返回的缓存命中/写入交给各自的可观测性去记 ——
 * ACP 遥测的 `providerCache` 行就是靠它（此前 `buildProviderCacheEvent` 只有定义、
 * 全仓没有调用方，于是"按需注入会不会影响缓存命中"这类问题**没有数据可答**）。
 *
 * 语义是**广播事实、不回写**：引擎已经拿到用量并写进 assistant 消息，改它无效。
 */
export interface LlmUsageSignal {
  sessionId: string
  agentId?: string
  model?: string
  /**
   * 本次调用实际命中的 Provider 实例 id（= `ProviderConfig.id`）。
   *
   * 为什么必须带上：`model` 回答「用了哪个模型」，但在「同一模型挂多个端点」这个
   * **被明确支持**的场景下（见 `ProviderConfig` 注释），两个端点的 model 名一模一样 ⇒
   * 只看 model 无法归因到端点。多实例启用后，用量/缓存归因都要靠这个维度才分得开。
   *
   * 缺省（undefined）= 本次走的是**默认** Provider（引擎的 `'default'` 哨兵会被归一掉，
   * 因为注册表里没有这个键，带上去等于造一个假端点）。
   */
  providerId?: string
  /** 引擎的步序号（从 1 起） */
  step?: number
  /** 本次调用的输入 token（provider 口径，含缓存部分） */
  input: number
  output: number
  /** 命中缓存的输入 token（OpenAI/DeepSeek `cached_tokens`、Anthropic `cache_read_input_tokens`） */
  cacheRead?: number
  /** 写入缓存的输入 token（Anthropic `cache_creation_input_tokens`） */
  cacheWrite?: number
  /**
   * 本次请求的**整包**本地 token 估算（system + 工具载荷 + 全部消息）。
   *
   * 消费方据此校正口径：`input / localInputEstimate` 偏离 1 说明本地估算与 provider 实际
   * 计费口径分叉。**不要**拿 ACP 的 `requestTok` 当分母 —— 那个只算历史消息，不含 system 与
   * 工具载荷（真机实测两者相差数倍，比值里混的是"漏算固定开销"而不是 tokenizer 差异）。
   */
  localInputEstimate?: number
}

// ===== Hooks 接口 =====

/**
 * Hooks 注册表
 * 插件通过 install() 返回此对象，介入 Harness 各生命周期
 *
 * ## 命名规范：`层.域.动作`
 *
 * 首段是**触发层**（谁 emit 这条 hook），不是"功能属于哪个模块"。这一条是刻意的：
 * hook 名是一个命名空间，若两层往同一个名字里发，消费方只能靠猜字段形状判断
 * "这条是谁发的" —— 本项目踩过（引擎终态曾被塞进 UI 消费层的 `cli.agent.stream`，
 * 同一个 hook 名出现两个来源，按轮计数的消费方因此翻倍）。
 *
 * | 层 | 语义 | 触发方 | hook |
 * | --- | --- | --- | --- |
 * | `core.` | 引擎层：**任何宿主都有**（CLI / 库内嵌 / ACP 宿主） | core | `core.harness.init` / `core.harness.start`、`core.tool.*`、`core.llm.*`、`core.prompt.*`、`core.session.*`、`core.permission.check`、`core.agent.turn.end`、`core.bus.event` |
 * | `cli.` | CLI 宿主层：只有走 CLI 的宿主才有 | cli | `cli.agent.stream`（UI 状态流）、`cli.command` / `cli.commands`（斜杠命令）、`cli.mcp.configure` |
 *
 * 约定：
 * - 新增 hook 前先定层，判据一句话：**"没有 UI 的宿主里这条还会触发吗？"** 会 → `core.`；只在有 UI 时 → `cli.`。
 * - 动作置于末段（`core.tool.pre.execute`、`core.agent.turn.end`），便于按 `core.agent.*` 前缀聚合。
 * - 触发时机是契约的一部分：声明为 `core.` 就必须在任何宿主里触发；只在 CLI 触发却写成 `core.` 是缺陷。
 * - 与**总线事件**（`harness.started`、`tool.enabled`…）是两套机制、两个命名空间：事件走 `core.bus`
 *   发布/订阅（多订阅者、无入参改写语义），hook 走 `plugin.trigger`（管道式、可原地改写入参）。
 * - 方法名不受本规范约束：`harness.start()` 是 Harness 的方法，hook 名是 `core.harness.start`。
 */
export interface Hooks {
  // === Harness 级 ===
  /** Harness 初始化阶段（create 时） */
  'core.harness.init'?: (input: HarnessInitInput, output: HarnessInitOutput) => Awaitable<void>
  /** Harness 启动阶段（start 时） */
  'core.harness.start'?: (input: HarnessStartInput, output: HarnessStartOutput) => Awaitable<void>

  // === 工具池构建 ===
  /** 组装 Agent 工具池（可注入/移除工具） */
  'core.tool.pool.assemble'?: (input: ToolPoolAssembleInput, pool: ToolPool) => Awaitable<void>

  // === Tool 执行 Pipeline ===
  /** 前置 Hook：可拦截、修改输入、提前返回（中间件模式） */
  'core.tool.pre.execute'?: (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>
  /** 后置 Hook：可修改结果 */
  'core.tool.post.execute'?: (ctx: unknown, result: unknown) => Awaitable<unknown>

  // === LLM 调用链路 ===
  /** 修改 LLM 调用参数（temperature/maxTokens 等） */
  'core.llm.params'?: (input: LLMInput, params: LLMParams) => Awaitable<void>
  /** 修改 LLM 请求头（如注入 API key、版本号） */
  'core.llm.headers'?: (input: LLMInput, headers: Record<string, string>) => Awaitable<void>
  /**
   * 每次 LLM 调用拿到 provider 用量后触发（引擎层事实，任何宿主都有）。
   *
   * 用于把 provider 侧的缓存命中/写入落进各自的可观测性（ACP 遥测的 `providerCache` 行
   * 即消费它）。**广播事实、不回写**：引擎已把用量写进 assistant 消息，这里改不动。
   */
  'core.llm.usage'?: (input: LlmUsageSignal) => Awaitable<void>

  // === Prompt 构建链 ===
  /**
   * 修改 System Prompt 片段数组（**前缀区**）。
   *
   * ⚠️ 只放**恒定**文本。自动前缀缓存按最长公共 token 前缀命中，前缀里的文本一变，
   * 其后的全部内容（含整段历史）都要重算。代价已真机量化（见 acp-context 的
   * `MANUAL_INJECT_MARGIN` 注释 / docs/usage-accounting-and-prompt-cache-plan.md §3）：
   * 越阈值时前缀 ≈ 105K tokens，翻转一次 ≈ 95K token-equiv，回本要 366 次调用。
   *
   * 会变的内容（记忆更新、资源缓存增长、一次性提示、按需手册）一律走
   * {@link Hooks['core.prompt.dynamic.transform'] 尾部通道}。
   * 判断标准很简单：**这段文本会不会在会话中途变？会 —— 就走尾部。**
   */
  'core.prompt.system.transform'?: (input: PromptInput, parts: string[]) => Awaitable<void>
  /**
   * 注入**尾部动态上下文**（每轮追加在请求末尾，`user` 角色、不落库、不进前缀）。
   *
   * 与 `core.prompt.system.transform` 的区别只有一个 —— **位置**，但这就是全部：
   * 前缀缓存按最长公共前缀命中，放前缀的文本一变，其后所有内容重算；放尾部则
   * 只影响"本轮新增的那一小段"，翻转代价 ≈ 0（尾部本来就是每轮变化的部分）。
   *
   * 适用：内容会随会话推进变化、且**不需要指令级权威**的注入 —— 记忆刷新、MCP 资源、
   * 一次性提示、按需加载的长文档等。
   *
   * 实现约束（core 已代管，插件不必操心）：
   * - 用 `user` role 追加在**请求末尾**。**不能用 `system` role**：provider-anthropic 的
   *   `extractSystemPrompt` 与 provider-gemini 的 `extractSystem` 会把任意位置的 system
   *   消息上提进顶层 `system` / `systemInstruction` 字段（原位置直接跳过）—— 用 system
   *   挪到尾部等于没挪，它会回到前缀，收益归零。
   * - 在 `core.session.preModel` **之后**拼接，因此不参与压缩插件的折叠/回写，**永不落库**。
   *
   * 多个插件都注入时按 hook 执行顺序拼进**同一条**消息（不推多条相邻临时消息 —— 那只会
   * 多几处尾部差异，没有收益）。
   */
  'core.prompt.dynamic.transform'?: (input: PromptInput, parts: string[]) => Awaitable<void>

  // === Session 生命周期 ===
  /** 会话压缩阶段 */
  'core.session.compacting'?: (input: PromptInput, output: CompactionContext) => Awaitable<void>
  /**
   * 每轮进入模型前 Hook：把本轮待发消息（含 system）交给插件，插件可裁剪/改写 messages 原地生效，
   * 并通过 save(messages) 把精简后的会话消息回写持久层（上下文压缩插件使用）。
   * messages 为待发消息数组，可原地 splice/push（会反映到本轮的模型请求）。
   */
  'core.session.preModel'?: (
    input: SessionPreModelInput,
    messages: unknown[]
  ) => Awaitable<void>

  // === Permission 扩展 ===
  /** 权限检查 Hook：可修改决策（如 teammate 桥接到 leader） */
  'core.permission.check'?: (
    req: PermissionRequestLike,
    decision: PermissionDecisionLike
  ) => Awaitable<void>

  // === Bus 事件订阅 ===
  /** 订阅所有 Bus 事件（用于日志、遥测、桥接） */
  'core.bus.event'?: (event: BusEventRecord) => Awaitable<void>

  // === Agent 流式事件（外部集成用） ===
  /**
   * Agent 执行过程中的每个流式事件，携带**归约后**的状态快照。
   *
   * 为什么带的是归约结果而不是原始事件：原始 AgentStreamEvent 是引擎内部结构
   * （text_delta / tool_call_start / done.step / turn_end 等十来种），让每个集成插件
   * 各自解释一遍既重复又容易分歧；归约器（CLI 侧）已把「现在在干什么」算清楚。
   *
   * 触发点是 **UI 消费层**（REPL / TUI / run），不是引擎 —— 没走 UI 的调用方
   * （如 subagent 的 query()）不触发，集成插件需知悉这一边界。
   *
   * ⚠️ 与 `core.agent.turn.end` 是**两条不同的通道**：本 hook 是 UI 状态流（引擎不会触发它），
   * `core.agent.turn.end` 才是引擎的整轮终态。曾把引擎终态也塞进本 hook，结果是同一个 hook 名
   * 由两层分别触发、消费方无法分辨来源（记忆的按轮计数因此可能被计两次）。
   */
  'cli.agent.stream'?: (input: AgentStreamSignal) => Awaitable<void>

  // === Agent 生命周期（引擎层事实） ===
  /**
   * **整轮结束**（引擎层）：core 在 `queryStream` / `query()` 收尾时触发。
   *
   * 与 `cli.agent.stream` 的区别是刻意的分层：本 hook 是引擎事实（任何宿主都有：CLI、内嵌库、
   * ACP 宿主自己消费事件流），`cli.agent.stream` 只在有 UI 消费层时才有。要"每轮都要发生"的
   * 逻辑（如记忆的攒批放行）挂这里；纯 UI 状态（busy/spinner/侧栏）挂 `cli.agent.stream`。
   */
  'core.agent.turn.end'?: (input: AgentTurnEndSignal) => Awaitable<void>
  /**
   * **步间闸门**（引擎层）：每步开跑前询问"还有存活的背景任务吗"。
   *
   * 置 `pending = true` 的插件会让引擎在下一步之前按退避阶梯休眠一次
   * （3s → 6s → 12s → 24s → 48s → 60s 封顶）。用来把"派完工后反复调工具、
   * 却没有实质进展的那几步"摊到后台任务真正跑完的那段时间里，而不是让 lead 在 20 秒内烧完 30 步额度。
   *
   * ⚠️ **调用远不止"每步一次"**：等待期间引擎按 `STEP_GATE_SLICE_MS`（默认 500ms）
   * **分片重探**，插件一旦静默就提前结束这一档 ⇒ 单档最多被调 `档位 ÷ 切片` 次
   * （60s 档 = 120 次），整轮累计可达数百次。
   * **所以本 hook 必须是纯内存的同步判定：不读文件、不发网络请求、不等锁。**
   * 签名是 `Awaitable`（允许返回 Promise）只是与其它 hook 保持一致的形态，
   * 实现里不该真的去 await 任何 IO —— 那等于把一次等待放大成几百次磁盘/网络往返。
   *
   * ⚠️ 触达条件是**续轮**而非"空转"：引擎在推理**之前**就问，此时还不知道这一步会产出
   * `tool_calls` 还是最终答复；而循环能回到这里，前提是 `shouldContinueStep()` 为真
   * （判据 `toolCallCount > 0`）。所以**上一步没调工具时本轮直接结束、闸门根本不会被触达**，
   * 反过来"有 tool call"的步才是会经过闸门的那批。别把它读成"只对空转步生效"。
   *
   * 实现方应是**能回答"本会话还有几个后台任务在跑"的插件**（subagent / coordinator）。
   * 判据要保守：拿不准就**不要**置 pending —— 等待的成本（每步几十秒）远大于
   * 偶尔少等一次的成本。
   */
  'core.agent.step.gate'?: (input: AgentStepGateInput, decision: AgentStepGateDecision) => Awaitable<void>

  // === 引擎层异常/空载事实（埋点专用，返回 void，不改变控制流） ===
  /**
   * **工具入参缺失**：一次调用因「必填项没给全」被拒，core 已把必填清单拼进回喂消息。
   *
   * 触发点唯一（与 `selfHealOnly` 同源），语义是"这一步被花在补参数上"。
   * 只做上报：不返回值、不影响 pipeline 结果 —— 想改结果请挂 `core.tool.post.execute`。
   */
  'core.tool.params.missing'?: (input: ToolParamsMissingSignal) => Awaitable<void>
  /**
   * **空步**：一步跑完但模型什么都没给（无用量、无文本、无推理、无工具调用）。
   *
   * 这类步意味着"一次完整 prompt 换来零产出"（真机一次约 0.05M token），
   * 且因为无 tool call 会直接结束整轮。引擎不替消费方判断严重性，只报事实。
   */
  'core.step.empty'?: (input: StepEmptySignal) => Awaitable<void>
  /**
   * **白名单越界**：模型点名了一个已注册、但不在本 agent `tools:` 白名单内的工具，
   * 引擎已拒绝执行并回喂 `TOOL_NOT_ALLOWED`。
   *
   * 只做上报：不返回值、不影响 pipeline 结果。用途是让"能力边界被点破"这件事可观测
   * —— `tools:` 是硬边界，不该只在没人看的地方静默生效。
   */
  'core.tool.whitelist.blocked'?: (input: ToolWhitelistBlockedSignal) => Awaitable<void>

  // === CLI 扩展 ===
  /** 注册 CLI 斜杠命令：插件往 input.commands 追加自己的命令定义 */
  'cli.commands'?: (input: CliCommandsInput) => Awaitable<void>
  /** 处理 CLI 斜杠命令：当 REPL 收到非内置 /xxx 时触发，插件设 input.result 表示已处理 */
  'cli.command'?: (input: CliCommandInput) => Awaitable<void>
  /**
   * 注入 MCP 托管列表（配置态，替换语义）：CLI 在 `createHarness` 之后、`core.harness.start`
   * 之前触发，把 config.json 的 `mcpServers` 交给 mcp-server-registry；后者只在 start 时按
   * `enabled` 连接，不在本 hook 里做 I/O。
   *
   * 由 CLI 触发 ⇒ 层前缀 `cli.`（见接口头的分层表）。
   */
  'cli.mcp.configure'?: (input: McpConfigureInput) => Awaitable<void>
}

/** CLI 命令定义（供 /help 展示） */
export interface CliCommandDef {
  /** 命令名（不含 /，如 "mcp" → /mcp） */
  command: string
  /** 简短描述 */
  description: string
  /** 用法说明 */
  usage?: string
}

/** cli.commands hook 的输入 */
export interface CliCommandsInput {
  /** 插件往此数组追加命令定义 */
  commands: CliCommandDef[]
}

/**
 * MCP server 配置条目（`cli.mcp.configure` 的载荷元素）。
 *
 * 与 `@harness/mcp-client` 的 `McpServerConfig` **结构保持一致**，但刻意不 import 它：
 * 契约层要保持"只依赖 bus"的轻量方向，不能反向依赖某个 MCP 插件包。字段口径由
 * `McpServerConfig` 定义，**新增字段须两处同步**（消费方 mcp-server-registry 负责收窄）。
 */
export interface McpServerConfigLike {
  /** 服务器名（工具命名 mcp__${name}__${tool}） */
  name: string
  /** 服务器级开关（缺省 true） */
  enabled?: boolean
  /** 工具级开关：key=工具名（不带 mcp__<server>__ 前缀），value=false 停用单个工具（缺省全开） */
  tools?: Record<string, boolean>
  /** 传输类型；缺省按字段推断（有 command → stdio，有 url → http） */
  transport?: 'stdio' | 'sse' | 'http'
  /** stdio：启动命令 */
  command?: string
  /** stdio：命令参数 */
  args?: string[]
  /** stdio：环境变量 */
  env?: Record<string, string>
  /** sse/http：服务器 URL */
  url?: string
  /** MCP 协议版本号（缺省 '2024-11-05'） */
  protocolVersion?: string
  /** 单次请求超时（毫秒） */
  requestTimeoutMs?: number
  /** 是否自动发现 resources / prompts */
  discoverResources?: boolean
  discoverPrompts?: boolean
}

/** cli.mcp.configure hook 的输入 */
export interface McpConfigureInput {
  /** 托管的 MCP server 列表（替换语义：整表覆盖上一份） */
  mcpServers?: McpServerConfigLike[]
}

/**
 * 内置工具静态元信息条目（多级加载 L1）。
 * 由 cli 注入；工具本身（运行时模块 L2）未加载时也能据此展示描述/别名/安全声明/权限键。
 */
export interface ToolMetaEntry {
  id: string
  description?: string
  aliases?: string[]
  isReadOnly?: boolean
  isDestructive?: boolean
  isConcurrencySafe?: boolean
  permissionKey?: string
}

/** cli 注入：内置工具静态元信息访问（按 id/别名查找、列出） */
export interface ToolMetaLookup {
  get(id: string): ToolMetaEntry | undefined
  list(): ToolMetaEntry[]
}

/**
 * 工具静态元信息来源（多级加载 L1）。
 *
 * 插件包以统一契约暴露内置工具的静态元信息（描述/别名/安全声明/权限键），
 * 供 CLI 展示层（/tools、help）在不加载对应运行时工具模块（L2）的前提下提前获取。
 * CLI 只消费本抽象接口，不硬编码具体插件包的元信息导出。
 */
export interface ToolMetaSource {
  /** 来源标识（一般为插件 id / 包名） */
  id: string
  /** 来源描述（供 /tools --all 或详情视图展示） */
  description?: string
  /** 该来源提供的静态元信息列表 */
  list(): ToolMetaEntry[]
}

/** 工具静态元信息注册表（多级加载 L1）：CLI 经此抽象登记/查询内置工具元信息 */
export interface ToolMetaRegistry {
  registerSource(source: ToolMetaSource): void
  /** 按 id 或别名查找 */
  get(id: string): ToolMetaEntry | undefined
  list(): ToolMetaEntry[]
  readonly size: number
}

/** 默认内存实现：按 id（含别名）索引，登记来源时合并其元信息 */
export function createToolMetaRegistry(): ToolMetaRegistry {
  const byId = new Map<string, ToolMetaEntry>()
  return {
    registerSource(source) {
      for (const m of source.list()) byId.set(m.id, m)
    },
    get(id) {
      if (byId.has(id)) return byId.get(id)
      for (const m of byId.values()) {
        if (m.aliases?.includes(id)) return m
      }
      return undefined
    },
    list() {
      return [...byId.values()]
    },
    get size() {
      return byId.size
    },
  }
}

/** cli.command hook 的输入 */
export interface CliCommandInput {
  /** 原始命令行（不含前缀 /） */
  raw: string
  /** 命令名（第一个 token，不含 /） */
  command: string
  /** 参数部分（命令名后的剩余文本） */
  arg: string
  /** 输出函数（往终端写文本） */
  out: (text: string) => void
  /** 当前会话 ID */
  sessionId: string
  /** 处理结果：插件设为 'continue' 或 'exit' 表示已处理 */
  result?: 'continue' | 'exit'
  /**
   * cli 注入：当前 Agent ID（命令归属的 Agent）
   */
  agentId?: string
  /**
   * cli 注入：持久化某 Agent 的 tools 白名单到 config.json（upsert agents[].tools）
   * 并即时覆盖运行时；供 /tools 等命令管理插件使用。
   */
  setAgentTools?: (agentId: string, tools: string[]) => Promise<void>
  /**
   * cli 注入：harness 能力访问（工具启停等运行时操作）。具体子字段由消费插件自行类型化。
   */
  harness?: unknown
  /**
   * cli 注入：内置工具静态元信息查找（多级加载 L1）。
   * 供工具管理命令在对应工具运行时模块未加载/懒加载时也能展示描述、别名、安全声明与权限键。
   */
  toolMeta?: ToolMetaLookup
}

// ===== AgentPlugin 接口 =====

/**
 * Agent 插件接口
 *
 * 结合 OpenCode 配置化 + Claude Code 多来源加载
 */
export interface AgentPlugin {
  /** 插件 ID（唯一，建议命名空间.功能 格式，如 "core.mcp"） */
  id: string
  /** 版本 */
  version: string
  /** 显示名 */
  name: string
  /** 描述 */
  description?: string
  /** 依赖的其他插件 ID（保证加载顺序，拓扑排序） */
  dependsOn?: string[]

  /** 安装：返回 Hooks 注册表 */
  install(ctx: PluginContext): Promise<Hooks | void>
  /** 卸载：清理资源 */
  uninstall?(): Promise<void>
}

// ===== PluginManager 接口 =====

/** 已加载插件信息 */
export interface LoadedPlugin {
  /** 插件定义 */
  plugin: AgentPlugin
  /** 已注册的 Hooks */
  hooks: Hooks | void
  /** 加载时间戳 */
  loadedAt: number
  /** 来源：internal / builtin / user */
  source: 'internal' | 'builtin' | 'user'
}

/**
 * 插件管理器接口
 *
 * 三级加载：Internal → Builtin → User（每级内部按 dependsOn 拓扑排序）
 * 支持：load / unload / hotReload / list / trigger
 */
export interface PluginManager {
  /** 加载内置插件（硬编码，最高优先级） */
  loadInternal(plugins: AgentPlugin[]): Promise<void>
  /** 加载默认 npm 插件（白名单，如 "@harness/mcp-client@1.0.0"） */
  loadBuiltin(npmSpecs: string[]): Promise<void>
  /** 加载用户插件（配置文件指定，支持 file:/// 本地路径） */
  loadUser(userSpecs: string[]): Promise<void>

  /** 卸载插件 */
  unload(pluginId: string): Promise<void>
  /** 热重载插件（卸载后重新加载） */
  hotReload(pluginId: string): Promise<void>
  /** 列出已加载插件 */
  list(): LoadedPlugin[]

  /**
   * 按名称列出已注册的 hook 回调（顺序 = 插件加载顺序，只读）。
   * 供宿主组装洋葱管道（如 core 的 tool pre/post hook 链）时按序取用。
   */
  listHooks<N extends keyof Hooks>(name: N): ReadonlyArray<{ pluginId: string; fn: NonNullable<Hooks[N]> }>

  /**
   * 触发 Hook（管道式依次调用所有已注册插件）
   * 同 OpenCode trigger 机制
   */
  trigger<N extends keyof Hooks>(
    name: N,
    ...args: Parameters<NonNullable<Hooks[N]>>
  ): Promise<void>
}

// ===== 自定义错误 =====

/** 插件 ID 重复 */
export class PluginDuplicateIdError extends Error {
  readonly pluginId: string
  constructor(id: string) {
    super(`Plugin "${id}" already loaded`)
    this.name = 'PluginDuplicateIdError'
    this.pluginId = id
  }
}

/** 插件未找到 */
export class PluginNotFoundError extends Error {
  readonly pluginId: string
  constructor(id: string) {
    super(`Plugin "${id}" not found`)
    this.name = 'PluginNotFoundError'
    this.pluginId = id
  }
}

/** 循环依赖 */
export class PluginCircularDependencyError extends Error {
  readonly cycle: string[]
  constructor(cycle: string[]) {
    super(`Circular dependency detected among plugins: ${cycle.join(' → ')} → ${cycle[0]}`)
    this.name = 'PluginCircularDependencyError'
    this.cycle = cycle
  }
}

/** 缺失依赖 */
export class PluginMissingDependencyError extends Error {
  readonly pluginId: string
  readonly missingDep: string
  constructor(id: string, missing: string) {
    super(`Plugin "${id}" depends on "${missing}", which is not provided in the same load batch`)
    this.name = 'PluginMissingDependencyError'
    this.pluginId = id
    this.missingDep = missing
  }
}

/** 插件 install 抛错 */
export class PluginInstallError extends Error {
  readonly pluginId: string
  readonly cause: unknown
  constructor(id: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(`Plugin "${id}" install() failed: ${msg}`)
    this.name = 'PluginInstallError'
    this.pluginId = id
    this.cause = cause
  }
}

/** 插件 uninstall 抛错 */
export class PluginUninstallError extends Error {
  readonly pluginId: string
  readonly cause: unknown
  constructor(id: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(`Plugin "${id}" uninstall() failed: ${msg}`)
    this.name = 'PluginUninstallError'
    this.pluginId = id
    this.cause = cause
  }
}

/** Hook 管道执行时某个插件抛错 */
export class PluginHookError extends Error {
  readonly hookName: string
  readonly pluginId: string
  readonly cause: unknown
  constructor(hookName: string, pluginId: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(`Hook "${hookName}" in plugin "${pluginId}" failed: ${msg}`)
    this.name = 'PluginHookError'
    this.hookName = hookName
    this.pluginId = pluginId
    this.cause = cause
  }
}

// ===== 拓扑排序 =====

/**
 * 拓扑排序：按 dependsOn 对插件列表排序
 *
 * - 缺失依赖 → PluginMissingDependencyError
 * - 循环依赖 → PluginCircularDependencyError
 * - 其他按 Kahn BFS 算法排序
 */
export function topologicalSortPlugins(plugins: AgentPlugin[]): AgentPlugin[] {
  const byId = new Map<string, AgentPlugin>()
  for (const p of plugins) {
    if (byId.has(p.id)) throw new PluginDuplicateIdError(p.id)
    byId.set(p.id, p)
  }

  // 依赖是否都在同一批内存在（只对在批内的校验；跨批依赖由调用方保证已加载）
  for (const p of plugins) {
    for (const dep of p.dependsOn ?? []) {
      // 若依赖不在批内但 ID 不重复，假设它是跨批的（已加载），跳过校验
    }
  }

  // Kahn 算法
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of byId.keys()) {
    indeg.set(id, 0)
    adj.set(id, [])
  }
  for (const p of plugins) {
    for (const dep of p.dependsOn ?? []) {
      // 仅对批内节点算入度
      if (byId.has(dep)) {
        indeg.set(p.id, (indeg.get(p.id) ?? 0) + 1)
        adj.get(dep)!.push(p.id)
      }
    }
  }

  const queue: string[] = []
  for (const [id, deg] of indeg) if (deg === 0) queue.push(id)

  const result: AgentPlugin[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(byId.get(id)!)
    for (const nxt of adj.get(id) ?? []) {
      const d = (indeg.get(nxt) ?? 0) - 1
      indeg.set(nxt, d)
      if (d === 0) queue.push(nxt)
    }
  }

  if (result.length !== plugins.length) {
    // 剩余节点组成环，DFS 找一条示例
    const remaining = new Set(plugins.map((p) => p.id).filter((id) => !result.find((r) => r.id === id)))
    const cycle: string[] = []
    const visited = new Set<string>()
    const stack: string[] = []
    const dfs = (u: string): boolean => {
      visited.add(u)
      stack.push(u)
      for (const v of byId.get(u)!.dependsOn ?? []) {
        if (!remaining.has(v)) continue
        if (stack.includes(v)) {
          cycle.push(...stack.slice(stack.indexOf(v)))
          cycle.push(v)
          return true
        }
        if (!visited.has(v) && dfs(v)) return true
      }
      stack.pop()
      return false
    }
    for (const id of remaining) if (!visited.has(id) && dfs(id)) break
    throw new PluginCircularDependencyError(cycle || Array.from(remaining))
  }

  return result
}

// ===== HooksRegistry =====

/**
 * HooksRegistry：Hook name → （pluginId, callback）有序列表
 *
 * trigger(name, args) 按注册顺序依次调用所有回调；
 * - 对 `core.tool.pre.execute` / `core.tool.post.execute` 特殊处理 Promise 链返回值给调用方（见 PluginManager）
 * - 其他 hooks 管道式 mutate 参数（返回值忽略）
 */
export class HooksRegistry {
  private readonly store = new Map<keyof Hooks, Array<{ pluginId: string; fn: NonNullable<Hooks[keyof Hooks]> }>>()

  /** 注册一个插件返回的所有 Hooks */
  register(pluginId: string, hooks: Hooks | void): void {
    if (!hooks) return
    for (const rawKey of Object.keys(hooks) as (keyof Hooks)[]) {
      const fn = hooks[rawKey] as NonNullable<Hooks[keyof Hooks]> | undefined
      if (!fn) continue
      const arr = this.store.get(rawKey) ?? (() => {
        const a: Array<{ pluginId: string; fn: NonNullable<Hooks[keyof Hooks]> }> = []
        this.store.set(rawKey, a)
        return a
      })()
      arr.push({ pluginId, fn })
    }
  }

  /** 注销某个插件的所有 hooks（unload 时调用） */
  unregister(pluginId: string): void {
    for (const [key, arr] of this.store) {
      const filtered = arr.filter((e) => e.pluginId !== pluginId)
      if (filtered.length === 0) this.store.delete(key)
      else this.store.set(key, filtered)
    }
  }

  /** 返回某 hook 名称下按注册顺序的回调列表 */
  listFor<N extends keyof Hooks>(name: N): ReadonlyArray<{ pluginId: string; fn: NonNullable<Hooks[N]> }> {
    return ((this.store.get(name) ?? []) as unknown) as ReadonlyArray<{ pluginId: string; fn: NonNullable<Hooks[N]> }>
  }

  /** 是否有 hook 注册 */
  has<N extends keyof Hooks>(name: N): boolean {
    return (this.store.get(name)?.length ?? 0) > 0
  }
}

// ===== PluginManagerImpl =====

/** createPluginManager 参数 */
export interface PluginManagerOptions {
  /** Bus 事件总线 */
  bus: Bus
  /** 初始配置（可选） */
  initialConfig?: Record<string, unknown>
  /** 日志器实现（可选，缺省时使用 silent logger） */
  logger?: PluginContext['log']
  /** 动态 import 实现（用于 loadBuiltin/loadUser；便于单测注入） */
  dynamicImport?: (spec: string) => Promise<{ default?: unknown } | unknown>
  /**
   * 宿主工作区路径（可选）：注入到所有插件的 `PluginContext.workspace`。
   * 由宿主（core）传入；不传则插件的 `ctx.workspace` 为 undefined。
   */
  workspace?: PluginWorkspaceView
}

/**
 * PluginManager 具体实现
 *
 * 流程：
 * 1. 构造时注入 PluginContext（bus + 内存 config + logger + dynamicImport）
 * 2. loadInternal/loadBuiltin/loadUser 三级加载
 *    - 每级：拓扑排序 → 去重检查 → install → hooks 聚合 + core.bus.event 订阅桥接
 *    - loadBuiltin/loadUser 调用 dynamicImport 或 Bun 的自动 npm install
 * 3. trigger(name, ...args) 按插件加载顺序依次回调，出错聚合抛错
 * 4. unload：core.bus.event 退订 → hooks unregister → uninstall
 * 5. hotReload：卸载后再安装
 */
export class PluginManagerImpl implements PluginManager {
  private readonly bus: Bus
  private readonly ctx: PluginContext
  private readonly configStore: Record<string, unknown>
  private readonly dynamicImport: (spec: string) => Promise<{ default?: unknown } | unknown>
  private readonly logger: PluginContext['log']

  /** 已加载插件表 */
  private readonly loaded = new Map<string, LoadedPlugin>()
  /** Hooks 注册表 */
  private readonly hooks = new HooksRegistry()
  /** core.bus.event Hook → Bus unsubscribe 句柄映射 */
  private readonly busEventUnsubs = new Map<string, () => void>()
  /** loadBuiltin / loadUser 动态 import 后保存 spec 对应 pluginId 以支持 hotReload */
  private readonly specById = new Map<string, { source: 'builtin' | 'user'; spec: string }>()
  /** Internal 原始引用以支持 hotReload */
  private readonly internalPlugins = new Map<string, AgentPlugin>()

  constructor(options: PluginManagerOptions) {
    this.bus = options.bus
    this.configStore = { ...(options.initialConfig ?? {}) }
    this.logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} }
    this.dynamicImport = options.dynamicImport ?? ((s) => import(/* @vite-ignore */ s))

    // PluginContext
    this.ctx = {
      bus: this.bus,
      config: {
        get: <T,>(key: string) => this.configStore[key] as T | undefined,
        set: <T,>(key: string, value: T) => {
          this.configStore[key] = value
        },
      },
      log: this.logger,
      ...(options.workspace ? { workspace: options.workspace } : {}),
    }
  }

  // ---- 三级加载 ----

  async loadInternal(plugins: AgentPlugin[]): Promise<void> {
    const ordered = topologicalSortPlugins(plugins)
    for (const p of ordered) {
      if (this.loaded.has(p.id)) throw new PluginDuplicateIdError(p.id)
    }
    for (const p of ordered) {
      await this.installOne(p, 'internal')
      this.internalPlugins.set(p.id, p)
    }
  }

  async loadBuiltin(npmSpecs: string[]): Promise<void> {
    const loaded = await Promise.all(npmSpecs.map((s) => this.resolveSpec(s)))
    await this.loadExternalBatch(loaded, 'builtin', npmSpecs)
  }

  async loadUser(userSpecs: string[]): Promise<void> {
    const loaded = await Promise.all(userSpecs.map((s) => this.resolveSpec(s)))
    await this.loadExternalBatch(loaded, 'user', userSpecs)
  }

  // ---- 卸载 / 热重载 ----

  async unload(pluginId: string): Promise<void> {
    const lp = this.loaded.get(pluginId)
    if (!lp) throw new PluginNotFoundError(pluginId)

    // 1. core.bus.event 退订
    const unsub = this.busEventUnsubs.get(pluginId)
    if (unsub) {
      unsub()
      this.busEventUnsubs.delete(pluginId)
    }

    // 2. hooks 注销
    this.hooks.unregister(pluginId)

    // 3. uninstall()
    try {
      await lp.plugin.uninstall?.()
    } catch (err) {
      throw new PluginUninstallError(pluginId, err)
    }

    // 4. 清理
    this.loaded.delete(pluginId)
    this.specById.delete(pluginId)
    this.internalPlugins.delete(pluginId)
  }

  async hotReload(pluginId: string): Promise<void> {
    const lp = this.loaded.get(pluginId)
    if (!lp) throw new PluginNotFoundError(pluginId)

    const source = lp.source
    // 保存需要的信息
    let plugin: AgentPlugin | null = null

    if (source === 'internal') {
      plugin = this.internalPlugins.get(pluginId) ?? null
    } else {
      const specInfo = this.specById.get(pluginId)
      if (specInfo) {
        const mod = await this.resolveSpec(specInfo.spec)
        plugin = mod
      }
    }

    // 先卸载
    await this.unload(pluginId)

    // 再安装
    if (plugin === null) return

    if (source === 'internal') {
      // 重新按单批加载
      await this.installOne(plugin, 'internal')
      this.internalPlugins.set(pluginId, plugin)
    } else {
      await this.installOne(plugin, source as 'builtin' | 'user')
      this.specById.set(pluginId, { source: source as 'builtin' | 'user', spec: this.specById.get(pluginId)?.spec ?? '' })
    }
  }

  list(): LoadedPlugin[] {
    return Array.from(this.loaded.values())
  }

  // ---- trigger Hook 管道 ----

  /**
   * 按名称列出已注册的 hook 回调（顺序 = 插件加载顺序）。
   *
   * 供宿主自行组装**洋葱管道**的场景使用（core 把 `core.tool.pre.execute` 包成
   * `next()` 链、`core.tool.post.execute` 顺序插入）。此前 core 只能
   * `(plugin as any).hooks.listFor(...)` 去摸私有字段 —— 类型检查因此失效，
   * 这里把它收成公开只读 API。
   */
  listHooks<N extends keyof Hooks>(name: N): ReadonlyArray<{ pluginId: string; fn: NonNullable<Hooks[N]> }> {
    return this.hooks.listFor(name)
  }

  async trigger<N extends keyof Hooks>(
    name: N,
    ...args: Parameters<NonNullable<Hooks[N]>>
  ): Promise<void> {
    const entries = this.hooks.listFor(name)
    if (entries.length === 0) return

    const errors: PluginHookError[] = []
    for (const { pluginId, fn } of entries) {
      try {
        await (fn as (...a: unknown[]) => Promise<unknown> | unknown)(...args)
      } catch (err) {
        errors.push(new PluginHookError(String(name), pluginId, err))
      }
    }

    if (errors.length > 0) {
      // 多个错误时用 AggregateError 包装
      if (errors.length === 1) throw errors[0]
      const agg = new AggregateError(errors, `Hook "${String(name)}": ${errors.length} plugin(s) failed`)
      ;(agg as { hookName?: string }).hookName = String(name)
      throw agg
    }
  }

  // ===== 内部辅助 =====

  private async installOne(plugin: AgentPlugin, source: LoadedPlugin['source']): Promise<void> {
    const start = performance.now()
    let hooksResult: Hooks | void
    try {
      hooksResult = await plugin.install(this.ctx)
    } catch (err) {
      throw new PluginInstallError(plugin.id, err)
    }

    const lp: LoadedPlugin = {
      plugin,
      hooks: hooksResult,
      loadedAt: Date.now(),
      source,
    }
    this.loaded.set(plugin.id, lp)

    // 聚合到 HooksRegistry
    this.hooks.register(plugin.id, hooksResult)

    // core.bus.event 桥接：如果插件声明了 core.bus.event Hook，则用 bus.subscribeAll 订阅
    const busEventFn = hooksResult?.['core.bus.event']
    if (busEventFn) {
      const unsub = this.bus.subscribeAll((record) => {
        return Promise.resolve(busEventFn(record as BusEventRecord)).catch((err) => {
          this.logger.error(`[plugin:${plugin.id}] core.bus.event handler failed`, err)
        })
      })
      this.busEventUnsubs.set(plugin.id, unsub)
    }

    this.logger.info(`[plugin] loaded ${plugin.id}@${plugin.version} (${(performance.now() - start).toFixed(1)}ms, source=${source})`)
  }

  private async loadExternalBatch(
    plugins: AgentPlugin[],
    source: 'builtin' | 'user',
    specs: string[]
  ): Promise<void> {
    const ordered = topologicalSortPlugins(plugins)
    for (const p of ordered) {
      if (this.loaded.has(p.id)) throw new PluginDuplicateIdError(p.id)
    }
    const idToSpec = new Map<string, string>()
    // 简单地按顺序对应：如果顺序不稳定会用插件本身 id 存；实际上 resolver 返回顺序和传入顺序一致
    for (let i = 0; i < specs.length; i++) {
      const plug = plugins[i]
      if (plug) idToSpec.set(plug.id, specs[i]!)
    }
    for (const p of ordered) {
      await this.installOne(p, source)
      const spec = idToSpec.get(p.id)
      if (spec) this.specById.set(p.id, { source, spec })
    }
  }

  /** 将 spec 解析成 AgentPlugin（dynamic import 后找 default 或 匹配的命名导出） */
  private async resolveSpec(spec: string): Promise<AgentPlugin> {
    const mod = await this.dynamicImport(spec)
    const candidates = [
      (mod as { default?: unknown }).default,
      (mod as { default?: { default?: unknown } }).default?.['default'],
      (mod as { plugin?: unknown }).plugin,
    ]
    // 直接是模块对象：找 id + install 字段
    const probe = (o: unknown): AgentPlugin | null => {
      if (!o || typeof o !== 'object') return null
      const x = o as Record<string, unknown>
      if (typeof x['id'] === 'string' && typeof x['install'] === 'function') return x as unknown as AgentPlugin
      return null
    }
    for (const c of candidates) {
      const r = probe(c)
      if (r) return r
    }
    if (probe(mod)) return probe(mod)!
    // 模块是普通对象，尝试遍历找一个 plugin
    if (mod && typeof mod === 'object') {
      for (const v of Object.values(mod as Record<string, unknown>)) {
        const r = probe(v)
        if (r) return r
      }
    }
    throw new PluginInstallError(spec, new Error(`spec "${spec}" did not export a valid AgentPlugin`))
  }
}

// ===== 工厂 =====

export function createPluginManager(options: PluginManagerOptions): PluginManager {
  return new PluginManagerImpl(options)
}

// ===== Provider 契约（抽象层，供 core / cli 消费、Provider 插件实现）=====
// 依赖方向：core / cli -----> @harness/plugin（本抽象层）；Provider 插件 -----> @harness/plugin
// 具体 Provider 实现（provider-* 包）通过导出 providerTypeFactory 实现下方契约，
// 上层只经 ProviderTypeRegistry 按 type 解析，不感知具体实现。

/** 单个 Provider 定义（config.json 的 providers 数组元素 / cli 传入） */
export interface ProviderConfig {
  /**
   * 实例 ID：运行时按 `providerId` 路由到具体 ChatProvider（注册表 key + 插件 id `provider.<id>`）。
   *
   * **可省略**（推荐）：省略时由 CLI 的 `normalizeProviderConfigs` 依据 `model` 自动派生
   * （如 model="hy3" → id="hy3"），同名时按数组顺序追加 `-2` / `-3` 保证唯一。
   * 因此「id 必须全局唯一且冗长」不再是配置者的负担。
   *
   * 仅在需要「同一模型挂多个端点」或想让 id 比模型名更短时才显式写；显式写时仍必须唯一。
   */
  id?: string
  /** Provider 类型：内置支持 anthropic / openai / gemini / glm / qwen / mock；可经插件扩展任意自定义 type */
  type: string
  /** API 根路径（如 api.openai.com / api.deepseek.com / http://localhost:11434） */
  baseUrl?: string
  /** API Key */
  apiKey?: string
  /** 该 Provider 默认模型 */
  model?: string
  /** OpenAI 类型专用：API 路径（默认 /v1/chat/completions；智谱等兼容 API 可改 /chat/completions） */
  apiPath?: string
  /** max_tokens 默认值 */
  maxTokens?: number
  /** 请求超时（ms） */
  timeoutMs?: number
  /**
   * 模型上下文窗口（输入 tokens）。供上下文压缩（@harness/acp-context）等工具据此判断
   * 触发阈值；缺省时各消费者回退自己的默认（默认 200_000）。
   */
  contextWindowTokens?: number
  /**
   * 思考模式开关（OpenAI 兼容 thinking 端点：DeepSeek / GLM 等；仅 openai 系 Provider 消费）。
   * 请求体顶层注入 `thinking: { type }`。缺省不发送（DeepSeek 默认启用；标准 OpenAI 不认识该参数）。
   */
  thinking?: 'enabled' | 'disabled'
  /**
   * 思考力度：请求体顶层注入 `reasoning_effort`。
   * DeepSeek 接受 minimal/low/medium/high/xhigh/max/ultra；OpenAI o 系接受 low/medium/high。
   * 缺省不发送。可被 Agent 定义 `model.options.reasoningEffort` 按覆盖。
   */
  reasoningEffort?: string
  /** 额外透传字段（供特定 Provider 自定义配置，如 mock 的 defaultResponse） */
  [key: string]: unknown
}

/**
 * Provider 类型工厂：`config.type` → 插件构造。
 * Provider 插件实现该接口并导出 providerTypeFactory；`createPlugin` 可为惰性的（内部 await import()），
 * 返回值允许为 Promise（返回 undefined 表示该配置不可用）。
 */
export interface ProviderTypeFactory {
  /** 对应 ProviderConfig.type 的值 */
  type: string
  createPlugin: (config: ProviderConfig) => AgentPlugin | undefined | Promise<AgentPlugin | undefined>
}

/** Provider 类型展示元信息：用于 help / config check 等"无需加载 Provider 模块"即可友好展示的场景 */
export interface ProviderTypeMeta {
  /** 对应 ProviderTypeFactory.type */
  type: string
  /** 人读描述 */
  description?: string
  /** 该类型默认模型 */
  defaultModel?: string
  /** 是否需要 apiKey（用于提示） */
  requiresApiKey?: boolean
  /** 是否为内置类型（随应用打包） */
  builtin?: boolean
  /** 人机交互用法示例（如 `/model openai/gpt-4o`） */
  usage?: string
}

/** Provider 类型注册表：按 type 动态解析工厂（内置 + 外部插件注册，替代硬编码 switch） */
export class ProviderTypeRegistry {
  private readonly factories = new Map<string, ProviderTypeFactory>()
  private readonly metas = new Map<string, ProviderTypeMeta>()

  register(factory: ProviderTypeFactory, meta?: Partial<ProviderTypeMeta>): void {
    this.factories.set(factory.type, factory)
    if (meta) this.metas.set(factory.type, { type: factory.type, ...meta })
  }

  resolve(type: string): ProviderTypeFactory | undefined {
    return this.factories.get(type)
  }

  list(): string[] {
    return [...this.factories.keys()]
  }

  /** 指定 type 的展示元信息（未登记则为 undefined） */
  meta(type: string): ProviderTypeMeta | undefined {
    return this.metas.get(type)
  }

  /** 全部已注册类型的展示元信息；未登记 meta 的类型也返回仅含 type 的占位，保证清单完整 */
  listMeta(): ProviderTypeMeta[] {
    return [...this.factories.keys()].map((t) => this.metas.get(t) ?? { type: t })
  }

  clear(): void {
    this.factories.clear()
    this.metas.clear()
  }
}

/**
 * 从插件模块导出中提取 Provider 类型工厂。
 * 支持三种形态：`providerTypeFactory`、`providerType`+`createProviderPlugin`、`default` 带上述字段。
 * 找不到时返回 undefined。
 */
export function resolveProviderTypeFactory(mod: Record<string, unknown>): ProviderTypeFactory | undefined {
  const holder = (mod.default && typeof mod.default === 'object' ? mod.default : {}) as Record<string, unknown>
  const probe = (o: Record<string, unknown>): ProviderTypeFactory | undefined => {
    if (o.providerTypeFactory && typeof (o.providerTypeFactory as ProviderTypeFactory).createPlugin === 'function') {
      return o.providerTypeFactory as ProviderTypeFactory
    }
    if (
      typeof o.providerType === 'string' &&
      typeof (o as { createProviderPlugin?: unknown }).createProviderPlugin === 'function'
    ) {
      const { providerType, createProviderPlugin } = o as {
        providerType: string
        createProviderPlugin: (config: ProviderConfig) => AgentPlugin | undefined | Promise<AgentPlugin | undefined>
      }
      return { type: providerType, createPlugin: createProviderPlugin }
    }
    return undefined
  }
  return probe(mod) ?? probe(holder) ?? undefined
}

// ===== 运行时能力服务契约（抽象层，供 cli 消费、subagent / swarm 插件实现）=====
// 依赖方向：cli -----> @harness/plugin（本抽象层）；subagent / swarm 插件 -----> @harness/plugin
// 具体能力对象（subagentCapability / swarmCapability）由插件包导出并在运行期注入（组合根装配），
// cli 只经下方抽象接口与之交互，不依赖具体插件的实现细节类型。
// 抽象接口均取"最小结构契约"，实现类天然结构兼容，避免抽象层反向依赖具体插件。

// --- 后台任务监控（subagent 插件实现）---

/** 后台任务进度条目（结构兼容 subagent.BackgroundTaskProgress） */
export interface BackgroundProgressLike {
  toolUseId: string
  toolName: string
  toolStatus: 'running' | 'completed' | 'failed'
  summary: string
}

/** 后台任务只读快照（结构兼容 subagent.BackgroundTaskView） */
export interface BackgroundTaskViewLike {
  taskId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  agentId?: string
  agentName?: string
  description?: string
  result?: string
  durationMs?: number
  error?: { code?: string; message?: string }
  progress?: BackgroundProgressLike[]
}

/** 后台任务变更订阅回调 */
export type BackgroundTaskListenerLike = (tasks: readonly BackgroundTaskViewLike[]) => void

/** 后台任务监控器抽象：subagent 插件的 BackgroundTaskMonitor 实现本接口 */
export interface BackgroundTaskMonitorLike {
  subscribe(listener: BackgroundTaskListenerLike): () => void
  dispose(): void
}

/** subagent 插件能力：创建后台任务监控器（cli 持此抽象，不依赖具体实现） */
export interface SubagentCapability {
  createMonitor(options: { bus: Bus; parentSessionIds?: string[] }): BackgroundTaskMonitorLike
}

// --- 团队成员协作子命令能力（swarm 插件实现）---

/** 团队成员协作循环参数（cli 只传必要参数，mailbox/taskPlane 创建与循环细节由 swarm 插件封装） */
export interface SwarmLoopDeps {
  /** 团队共享数据目录（mailbox / taskPlane 都在此创建） */
  teamsDir: string
  /** 团队名（已规范化） */
  team: string
  /** 成员名（已规范化） */
  name: string
  /** 成员 agentId（agent 定义 id） */
  agentId: string
  /** 关联会话 id */
  sessionId: string
  /** 运行时 harness（接入总线 / 会话） */
  harness: unknown
}

/** 团队成员协作循环句柄 */
export interface SwarmLoopHandle {
  /** 是否已收到 shutdown 决策 / 外部停止请求 */
  isDone(): boolean
  /** 停止循环（幂等） */
  stop(): Promise<void>
}

/** swarm 插件能力：团队成员子命令（cli 持此抽象，不依赖具体实现） */
export interface SwarmCapability {
  sanitizeName(name: string): string
  formatAgentId(name: string, team: string): string
  startTeammateLoop(deps: SwarmLoopDeps): SwarmLoopHandle
}
