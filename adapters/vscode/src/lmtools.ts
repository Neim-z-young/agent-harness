/**
 * P3-D（设计稿 §14）：`harness/tools.*` 的线上形状 ↔ VSCode LM 工具的形状。
 *
 * 分层纪律（与 `commands.ts` / `launch.ts` 同一条）：本文件**不 import `vscode`**，
 * 也**不 import `@harness/*`** —— 扩展是独立分发单元（打包后没有 workspace 依赖），
 * 线上形状靠"逐字同步"对齐，并由跨包守卫用例钉住（同 `map/render.ts` 的 `FILE_REF_RE`）。
 *
 * 于是"名字怎么起、哪些条目该丢、确认框写什么、approve 什么时候带、结果怎么渲染"
 * 全部可以脱离编辑器单测；`extension.ts` 只做接线。
 *
 * ## 两份"形状"必须分清
 *
 * - **运行期**：`lm.registerTool(name, tool)` 的 `tool` 只有 `invoke` / `prepareInvocation`
 *   （`vscode.d.ts:21165`/`21181`），**没有任何描述字段**。
 * - **打包期**：模型可见的 `displayName` / `modelDescription` / `inputSchema` 全部来自
 *   `package.json` 的 `contributes.languageModelTools`（§14.4）。
 *
 * ⇒ 本模块产出的是**运行期**那份（`LmToolSpec`）；打包期那份由 `gen-lm-tools` 生成。
 */

// ========================================================================
// 1. 线上形状与方法名
// ========================================================================

/** 摊平工具池（无入参；**不做白名单、不按 agent 过滤**，见 §14.5） */
export const TOOL_LIST_METHOD = 'harness/tools.list'
/** 由外部编排方发起一次工具调用（入参 `{ sessionId, name, input, approve? }`） */
export const TOOL_CALL_METHOD = 'harness/tools.call'

/**
 * `harness/tools.list` 的单条出参。
 *
 * 与 `@harness/a2a-server` 的 `ToolDescriptor` **是同一份形状**（那边是权威定义）；
 * 这里逐字同步一份，因为扩展不能 import 它（见文件头）。
 */
export interface ToolDescriptorWire {
  /** 工具 id，原名（`harness_` 前缀是客户端的命名空间问题，不属暴露面） */
  readonly name: string
  readonly description: string
  /** 入参 JSON Schema（缺省 `{ type: 'object', properties: {} }`） */
  readonly inputSchema: Record<string, unknown>
  /** 只读判定（Fail-Closed：未声明 / 求值抛错 ⇒ false） */
  readonly readOnly: boolean
  /** 是否声明了 `permission`（= 权限链会启动 ⇒ **可能**要问，见 §14.2 ①） */
  readonly requiresConfirmation: boolean
}

/** `harness/tools.call` 的出参：**工具级失败也走正常回包**（`ok: false`），不是协议错误 */
export interface ToolCallOutcomeWire {
  readonly ok: boolean
  readonly output?: unknown
  readonly error?: { readonly message: string; readonly code?: string }
  /** 工具真实耗时（管道 Step 5 已算好） */
  readonly durationMs?: number
}

// ========================================================================
// 2. 工具规格：命名与解析
// ========================================================================

/**
 * LM 工具名前缀。
 *
 * `lm.registerTool` 的工具名是**全局**的（`lm.tools` 对任何扩展可见），而 harness 的
 * `read_file` / `bash` / `glob` 太通用 ⇒ 不加前缀必然与别的扩展撞名（§14.2 ①）。
 */
export const LM_TOOL_PREFIX = 'harness_'

/** 扩展侧注册所需的全部信息（**运行期**那份；不含 schema —— 那是贡献点的事） */
export interface LmToolSpec {
  /** harness 侧工具 id，`harness/tools.call` 用它 */
  readonly harnessName: string
  /** VSCode 侧工具名，`lm.registerTool` 与贡献点用它 */
  readonly lmName: string
  readonly description: string
  readonly readOnly: boolean
  readonly requiresConfirmation: boolean
}

/**
 * 工具名净化用的两个正则。
 *
 * ⚠️ **与 `packages/cli/src/gen-lm-tools.ts` 的同名常量必须逐字一致**：生成的是
 * "贡献点里将要注册的名字"，这里算的是"运行期真正注册的名字"。两边不一致的后果是
 * **清单里有、注册时没有**（Copilot 看得到却调不动），或反过来。
 * 跨包不能 import（扩展是独立分发单元），所以由守卫用例比对**源码文本**钉住
 * （`packages/cli/src/gen-lm-tools.test.ts`，与 `map/render.ts` 的 `FILE_REF_RE` 同一手法）。
 */
const NAME_SAFE_RE = /[^A-Za-z0-9_-]+/g
/** 去首尾下划线 */
const NAME_TRIM_RE = /^_+|_+$/g

/**
 * 工具名净化：只留 `[A-Za-z0-9_-]`，其余替换成 `_`。
 *
 * 净化是**防御性**的，不是洁癖：VSCode 对工具名的要求是 `{verb}_{noun}` 形式、带扩展名前缀，
 * 而 harness 的工具 id 有一部分来自**外部**（MCP 客户端插件把 server 提供的工具注册成
 * `mcp__<server>__<tool>`，`<server>` 由用户配置）⇒ 出现空格 / 冒号 / 斜杠都不奇怪。
 * 与其让 `activate()` 在某台机器上炸掉，不如归一化；归一化导致的同名冲突由
 * {@link parseToolList} 检出并**报出来**（不静默丢）。
 *
 * 返回空串 = 净化后没有可用字符（调用方应丢弃该条目，而不是注册一个 `harness_`）。
 */
export function sanitizeToolName(raw: string): string {
  return raw.trim().replace(NAME_SAFE_RE, '_').replace(NAME_TRIM_RE, '')
}

/** harness 工具 id → LM 工具名 */
export function lmToolNameOf(harnessName: string): string {
  return `${LM_TOOL_PREFIX}${sanitizeToolName(harnessName)}`
}

/** {@link parseToolList} 的结果：能用的 + **被丢掉的及原因**（不静默） */
export interface ToolListParse {
  readonly specs: readonly LmToolSpec[]
  /**
   * 出参里**原始条目数**（= 未被解析丢弃的输入规模）。
   *
   * 单列出来是为了区分"清单本来就是空的"与"清单有东西但一条都没解析出来" ——
   * 两者都表现为 `specs.length === 0`，但一个正常、一个是**解析层失效**，
   * 后者若被当成前者看，症状就是"工具全没了且没人知道为什么"。
   */
  readonly listed: number
  /** 每条是"`<工具名/原样>`：原因"，调用方应打进输出通道 */
  readonly skipped: readonly string[]
}

/**
 * 解析 `harness/tools.list` 的返回。
 *
 * Fail-Closed 三处：
 * 1. 认不出形状 ⇒ 空清单（客户端拿不到工具比拿一半好排查）；
 * 2. `readOnly` / `requiresConfirmation` **只认字面 `true`**（缺字段、给字符串、给 1 都算 false）
 *    —— 前者是"多问一次"，后者是"少带 approve ⇒ sidecar 侧拒绝"，两个方向都 Fail-Closed；
 * 3. 归一化后同名 ⇒ 只留先出现的，后一条**记进 `skipped`**（而不是覆盖，也不是静默）。
 *
 * 同时接受 `{ tools: [...] }`（控制面契约形状）与裸数组（防御：出参形状若演进不会静默变空）。
 */
export function parseToolList(raw: unknown): ToolListParse {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { tools?: unknown } | null | undefined)?.tools)
      ? ((raw as { tools: unknown[] }).tools)
      : []

  const specs: LmToolSpec[] = []
  const skipped: string[] = []
  const takenByLmName = new Map<string, string>()

  for (const entry of arr) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped.push('（不是对象）')
      continue
    }
    const o = entry as Record<string, unknown>
    const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
    if (name === '') {
      skipped.push('（缺 name）')
      continue
    }
    const safe = sanitizeToolName(name)
    if (safe === '') {
      skipped.push(`${name}：净化后没有可用字符，无法作为工具名`)
      continue
    }
    const lmName = LM_TOOL_PREFIX + safe
    const prev = takenByLmName.get(lmName)
    if (prev !== undefined) {
      skipped.push(`${name}：与 ${prev} 归一化后同名（${lmName}），只保留先出现的`)
      continue
    }
    takenByLmName.set(lmName, name)
    specs.push({
      harnessName: name,
      lmName,
      description: typeof o['description'] === 'string' ? o['description'] : '',
      readOnly: o['readOnly'] === true,
      requiresConfirmation: o['requiresConfirmation'] === true,
    })
  }

  // 顺序稳定：客户端 diff 时不会因注册顺序抖动而误判"工具集变了"
  specs.sort((a, b) => (a.harnessName < b.harnessName ? -1 : a.harnessName > b.harnessName ? 1 : 0))
  return { specs, listed: arr.length, skipped }
}

// ========================================================================
// 3. 确认框文案（`prepareInvocation` 的返回）
// ========================================================================

/** 与 `vscode.LanguageModelToolConfirmationMessages` 同形 */
export interface ConfirmationMessages {
  readonly title: string
  readonly message: string
}

/** 确认框里入参一栏的字符上限（框里放太长没人看，且 markdown 会被撑爆） */
const PREVIEW_LIMIT = 1_200

/**
 * 构造 VSCode 原生确认框的文案（Continue / Cancel）。
 *
 * 与 harness 自己的模态框（`participant.ts` 的 `askPermission`）是**两个落点、一件事**：
 * 那边是"harness 自己编排时问用户"，这边是"Copilot 编排时问用户"。文案刻意都在末尾说清
 * "这次确认只对本次调用有效"，以免用户以为点一次 Continue 就永久放行。
 */
export function confirmationFor(spec: LmToolSpec, input: unknown): ConfirmationMessages {
  return {
    title: `运行 harness 工具 ${spec.harnessName}？`,
    message: [
      `**${spec.harnessName}** — ${spec.description}`,
      '',
      '入参：',
      '```json',
      preview(input, PREVIEW_LIMIT),
      '```',
      '',
      '_点「继续」只代表**本次调用**已确认；harness 侧仍按本机权限规则独立裁决，'
        + '不会因此写入本地规则（没有"总是允许"通道）。_',
    ].join('\n'),
  }
}

// ========================================================================
// 4. 调用入参 + 审批台账
// ========================================================================

/**
 * 审批台账：把"这次询问**真的发生过**"这件事从 `prepareInvocation` 传到 `invoke`。
 *
 * ## 为什么不能简单地"`requiresConfirmation` 为 true 就带 approve"
 *
 * `lm.invokeTool` 是**公开 API** —— `vscode.d.ts:20791` 原文：
 * 「A tool can be invoked by a chat participant, in the context of handling a chat request,
 * or **globally by any extension in any custom flow**」。
 * 也就是说**任何别的扩展**都能直接 `invokeTool('harness_bash', {...})`，**绕过
 * `prepareInvocation`**。那种调用若也被我们当成"用户已确认"，等于把批准权白送给第三方扩展
 * —— 正是 §14.5「一个远端编排器不该有改写本地权限规则的权力」要挡的那件事。
 *
 * ⇒ 只有"我们**确实弹过框**"的那一次调用才带 `approve: true`；其余一律不带，
 * 于是 sidecar 侧委派原 A2A asker ⇒ 控制面不在 A2A 任务上下文 ⇒ **deny + 一条 warn**。
 *
 * ## 键与计数
 *
 * 键 = `lmName` + 入参指纹。带指纹是为了"同工具不同入参"不互相顶掉；用**计数**而不是布尔，
 * 是为了并发两次询问不会被后来的一次 invoke 之一吃掉。
 *
 * ## 与 `prepareInvocation` 文档契约的张力（写清楚，不装作没有）
 *
 * `vscode.d.ts:21178` 写着 prepareInvocation **「Must be free of side-effects」**，
 * 且 21179 补一句「不保证随后一定 invoke」——两句话合起来就是在说"它可能被**试探性**调用"。
 * 而这里的 {@link note} 恰恰是在 prepare 里写状态，**是有意偏离**这条契约的：
 *
 * - 它改的只有**进程内一个计数器**，不碰文件、不发请求、不产生外部可见效果；
 * - 不写这一笔的代价是"无法区分『用户点过 Continue』与『第三方扩展直接 invokeTool』"，
 *   而后者是 `lm.invokeTool` 公开 API 允许的（`vscode.d.ts:20791`）—— 那等于白送批准权；
 * - 试探性调用留下的那笔记录**由 TTL 兜住**（见下），不会无限期有效。
 *
 * ## 残留窗口
 *
 * 「弹了框但用户点取消」会留下一笔记录，接着**同一工具同一入参**的 invoke 会把它消费掉
 * ⇒ 那一次多带一个 `approve: true`，而用户当次没点 Continue。要彻底消掉得给 sidecar 加一个
 * 带 `input` 的 `harness/tools.prepare`（用 `engine.check` 干跑一次），见 §14.2 ② 结尾，本期不做。
 * 窗口被两件事夹住：**TTL**（只认最近 {@link APPROVAL_TTL_MS} 内记下的）+ **入参指纹**
 * （只认用户确实看过的那一份入参）。
 */
export class ApprovalLedger {
  /** key → 未消费的询问记录（时间戳，用于 TTL） */
  private readonly pending = new Map<string, number[]>()

  /**
   * 台账上限。满了之后**不再记录**（而不是淘汰旧的）—— 淘汰会把"很久以前问过的那次"
   * 变成有效凭证，那是错的方向；不记录只会让该次调用**少带 approve**（Fail-Closed）。
   */
  private readonly max: number

  /** 取当前时间（注入是为了让 TTL 可单测，不必依赖假时钟） */
  private readonly now: () => number

  constructor(max = 64, now: () => number = Date.now) {
    this.max = max
    this.now = now
  }

  /** `prepareInvocation` 弹框时记一笔 */
  note(lmName: string, input: unknown): void {
    const key = ledgerKey(lmName, input)
    const stamps = this.pending.get(key)
    if (stamps === undefined) {
      if (this.pending.size >= this.max) return
      this.pending.set(key, [this.now()])
      return
    }
    stamps.push(this.now())
  }

  /** `invoke` 消费一笔；**没有对应记录 / 记录已过期 ⇒ false**（Fail-Closed） */
  consume(lmName: string, input: unknown): boolean {
    const key = ledgerKey(lmName, input)
    const stamps = this.pending.get(key)
    if (stamps === undefined) return false

    const cutoff = this.now() - APPROVAL_TTL_MS
    while (stamps.length > 0 && stamps[0]! < cutoff) stamps.shift()
    if (stamps.length === 0) {
      this.pending.delete(key)
      return false
    }
    stamps.shift()
    if (stamps.length === 0) this.pending.delete(key)
    return true
  }

  /** 未消费记录**条数**（用例与自检用；一个 key 下的多笔记作 1） */
  get size(): number {
    return this.pending.size
  }

  /** 清空（扩展停用 / 重启 sidecar 时调 —— 跨进程重启后旧凭证不该继续生效） */
  clear(): void {
    this.pending.clear()
  }
}

/**
 * 询问记录的存活时长。
 *
 * 上界要容得下"确认框弹着、用户过了会儿才点"（那就是 prepare → invoke 的间隔），
 * 下界只要把"很久以前那次试探性调用"挡住即可。10 分钟对两头都很宽松。
 */
const APPROVAL_TTL_MS = 10 * 60 * 1000

/** 台账键：工具名 + 入参指纹 */
function ledgerKey(lmName: string, input: unknown): string {
  return `${lmName}\u0000${fingerprint(input)}`
}

/**
 * 入参指纹。
 *
 * `JSON.stringify` 对同一个对象形状是稳定的（VSCode 把 `options.input` 原样透传给
 * `prepareInvocation` 与 `invoke`）；**序列化不了（循环引用等）⇒ 退化成空串**，
 * 即"按工具名匹配" —— 比抛错好，且方向仍是 Fail-Closed（记录更难命中，只会少带 approve）。
 */
function fingerprint(input: unknown): string {
  try {
    const s = JSON.stringify(input)
    return typeof s === 'string' ? s : ''
  } catch {
    return ''
  }
}

/** `harness/tools.call` 的入参 */
export interface ToolCallParams {
  readonly sessionId: string
  readonly name: string
  readonly input: unknown
  /** 只在**本次询问确实发生过**时才带上（见 {@link ApprovalLedger}） */
  readonly approve?: true
}

/**
 * 组装一次控制面调用的全部入参 —— **唯一**决定 `approve` 的地方。
 *
 * 刻意做成"进来就消费台账"的形式：`approve` 的判据只有一处，`extension.ts` 想绕过它
 * 就得自己拼 params（而那里没有台账）。
 */
export function planToolCall(
  sessionId: string,
  spec: LmToolSpec,
  input: unknown,
  ledger: ApprovalLedger,
): ToolCallParams {
  const approved = ledger.consume(spec.lmName, input)
  return {
    sessionId,
    // 传**原名**：`harness_` 前缀只是 VSCode 侧的命名空间，sidecar 不认识它
    name: spec.harnessName,
    input,
    ...(approved ? { approve: true as const } : {}),
  }
}

// ========================================================================
// 5. 结果渲染（模型要能**读回上下文**）
// ========================================================================

/** 喂给模型的文本上限。tools 自己也会截断，这里是最后一道闸（防一次调用把上下文打满） */
const OUTPUT_LIMIT = 20_000

/**
 * 把 `harness/tools.call` 的返回渲染成**读得懂、可据以改**的文本。
 *
 * 三条纪律：
 * - **工具级失败不是异常**：`ok: false` 也返回正常文本（`LanguageModelToolResult` 是文本，
 *   不是 error 字段），否则模型只看到"调用失败"四个字，改不动。
 * - **权限被拒要单独说**：那是"用户没批准"，不是"入参写错了" ⇒ 提示"不要原样重试"。
 *   两者给同一句建议会让模型陷入"反复重试同一个被拒的调用"。
 * - **认不出形状也不抛**：返回文本（而不是 throw），因为抛出去等于把"为什么"藏起来。
 */
export function renderToolOutcome(raw: unknown, lmName: string): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return `harness 工具 \`${lmName}\` 返回了无法解析的结果（不是对象）：\n\n\`\`\`\n${preview(raw, PREVIEW_LIMIT)}\n\`\`\``
  }
  const o = raw as Record<string, unknown>

  if (o['ok'] === true) {
    return truncate(renderOutput(o['output']), OUTPUT_LIMIT)
  }

  const err = (o['error'] ?? {}) as Record<string, unknown>
  const message = typeof err['message'] === 'string' && err['message'] !== '' ? err['message'] : '工具执行失败'
  const code = typeof err['code'] === 'string' && err['code'] !== '' ? err['code'] : undefined
  const advice =
    code === 'PERMISSION_DENIED'
      ? '这是**权限被拒**（用户没批准，或本机权限规则拒绝）。**不要原样重试**；'
        + '请换个做法，或先说明为什么需要这个操作。'
      : '这是**工具级失败**（不是传输错误）。请根据上面的 message 调整入参或换做法后重试。'

  return `❌ harness 工具 \`${lmName}\` 执行失败：${message}${code ? `（code ${code}）` : ''}\n\n_${advice}_`
}

/** 成功出参 → 文本：字符串直出（工具自己已按需截断），其余走 JSON */
function renderOutput(output: unknown): string {
  if (output === undefined || output === null) return '(无输出)'
  if (typeof output === 'string') return output
  try {
    const s = JSON.stringify(output, null, 2)
    return typeof s === 'string' ? s : String(output)
  } catch {
    return String(output)
  }
}

/** 任何值 → 可放进 markdown 代码块的短文本 */
function preview(value: unknown, limit: number): string {
  let s: string
  try {
    const j = JSON.stringify(value, null, 2)
    s = typeof j === 'string' ? j : String(value)
  } catch {
    s = String(value)
  }
  return truncate(s, limit)
}

/** 截断并**说清截断了**（静默截断会让模型以为自己看到了全部） */
function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}\n\n…[已截断：原长 ${s.length} 字符，此处显示前 ${limit} 字符]`
}
