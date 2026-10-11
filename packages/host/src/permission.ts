/**
 * 权限接缝：四态答复 + 交互引擎（P0 收尾 S2 第二步）
 *
 * ## 为什么必须上移（而不是让每个宿主各写一份 ask）
 * 今天「**先判永久（`A`/`always`）→ 写回规则集 → 再判单次**」这套顺序只写在 `@harness/cli`
 * 的 `CliPermissionEngine.ask` 里。A2A server / VSCode 扩展各起一份实现，就是**同一语义两套写法**
 * —— 将来「always 到底该写 `tool` 还是 `global` 规则」改一处漏一处，而权限是安全边界，
 * 漏一处就是漏一处漏洞。上移后只有这一份。
 *
 * ## 三条接缝（本文件只做前两条，第三条 P1 接）
 * | 接缝 | 归属 | 说明 |
 * |---|---|---|
 * | **问什么**（`PermissionPrompt`） | 本文件 | 结构（`toolKey` / `patterns`）+ 一段默认文案（`text`） |
 * | **怎么问到答复**（`PermissionAsker`） | 宿主 | CLI = readline/TUI 模态；A2A = 挂起任务等答复；VSCode = webview 授权卡 |
 * | **问到之后怎么记**（四态 → 规则写回） | 本文件 | 三个宿主共用一份 |
 *
 * `asker` 刻意返回**四态**而不是原始文本：远程宿主不该做「伪造一段文本、再解析回来」的往返
 * （那是把 CLI 的输入词汇表当成协议）。文本 → 四态的翻译属 CLI 的输入词汇（`y/n/a/d/A/D`），
 * 留在 `@harness/cli`。
 *
 * ## 缺省行为（宿主不给 `asker` 时）
 * 与 `DefaultPermissionEngine` 的 ask→deny 语义一致：**取不到答复 ⇒ deny**。
 * 这条不能反过来 —— 一个"问不到用户就放行"的默认值是安全缺陷，不是便利。
 */
import { createHash } from 'node:crypto'
import { DefaultPermissionEngine, callerScopeKey, scopedRuleKey } from '@harness/core'
import type { PathRules, PermissionBehavior, PermissionDecision, PermissionRequest } from '@harness/core'

/** 规范答复四态。`always-*` 会写回规则集并置 `remember=true` */
export type PermissionAnswer = 'allow' | 'deny' | 'always-allow' | 'always-deny'

/**
 * 询问接缝实际依赖的输入面。
 *
 * 刻意**收窄**到引擎与路由真正要的三项，而不是整个 `PermissionRequest`：引擎读
 * `toolKey` / `patterns`，`sessionId` 则供 **asker 路由**（见下）。其余字段（`input` 等）
 * 引擎与提问材料的组装都不碰，写进契约只会让每个调用点（含测试桩）多伪造一个字段。
 * 宽类型（完整 `PermissionRequest`）传进来天然兼容 —— 依赖倒置，不是第二份定义。
 *
 * ## 为什么 `sessionId` 要进这个"窄"契约
 * `asker` 是**全局单槽**（`InteractivePermissionEngine.setAsker`），而宿主可以并存多个询问源
 * （TUI 里的 Agent、A2A 任务、进程内 MCP server）。收窄时若把归属信息一并裁掉，包装型
 * asker 就无从判断"这次询问该由谁应答"，只能靠"当前谁在忙"这类不可靠标志（并发不安全）。
 * 故它是**路由的最小必要信息**，与"引擎要读什么"是两条独立理由，不能按同一条规则裁。
 */
export type PermissionAskInput = Pick<PermissionRequest, 'toolKey' | 'patterns' | 'sessionId'> & {
  /**
   * 原始工具入参（可选）。M3 决策卡片要渲染参数表格，而窄契约原本裁掉了它。
   * core 的 `resolvePermission` 传完整 `ToolPermissionRequest`（运行时对象本就带 `input`），
   * 这里只是把类型面补上，既有测试桩（只填 toolKey/patterns）天然兼容。
   */
  input?: unknown
}

/** 交互模式：`allow-all` / `deny-all` 直接短路，只有 `ask` 才走 asker */
export type PermissionMode = 'allow-all' | 'ask' | 'deny-all'

/**
 * 缺省归属主体（P0-9）：未配 `HostOptions.permissionPrincipal` 的宿主视作**单机单主体**。
 *
 * 与 `a2a-server/src/auth.ts` 的 `LOCAL_CALLER` **同值同义**：匿名 A2A（不配 token、只听
 * 127.0.0.1）= 本机调用方，与本机 CLI 本就是同一个主体，共用一个归属是**正确**的。
 * 真正的隔离诉求在**远程（带 token）调用方** —— 它们的主体标识各不相同，天然分开。
 */
export const DEFAULT_PERMISSION_PRINCIPAL = 'local'

// ===== 风险分级（M3 决策卡片）=====

/** 风险等级：规则引擎只打标签不决策，决策权归人工 */
export type RiskLevel = 'low' | 'medium' | 'high'

/**
 * ⚠️ 下面两张表的键是**权限键**（`ToolDefinition.permission.key`），**不是工具 id**。
 *
 * 依据：`assessRisk` 唯一的生产调用点是 `buildPermissionPrompt`，传的是 `req.toolKey`，
 * 而它出自 `@harness/tool` 的 `tool.permission.key`（`tool/src/index.ts` 的 `doExecute` Step 4：
 * `toolKey: tool.permission.key`）—— 工具 id 从来不经过这里。`cli.test.ts` 的权限审计用例
 * 把这条钉死：工具的 id 是 `needs_approval`，而落到审计里的 `tool` 是 `write`。
 *
 * 本仓真实存在的权限键（`grep -rn "key: '" packages/plugins`）：
 * `read` / `write` / `edit` / `bash` / `bash_ro` / `network` / `agent`，以及 swarm 的
 * `task_*` / `team_*` / `send_*`。
 *
 * ## 为什么专门写这一段（P2-5 的附带发现）
 * 改造前这两张表里写的是**工具 id**（`write_file` / `edit_file` / `delete` / `rm` / `modify_*` …），
 * 它们**一个都不会到达这里** ⇒ 真正的键 `write` 落不到 high，**写文件的决策卡片标的是「中危」**。
 * 比 D4 更隐蔽：D4 是"全打 high、没有区分度"，这里却是高危档**整个空转**。
 */
const LOW_RISK_PERMISSION_KEYS = new Set([
  'read',
  // 只读 shell 变体与 `bash` 同族，但**天然不可写**（白名单 + 拒绝重定向/命令替换/提权，
  // 见 `tools-builtin` 的 `checkReadOnlyCommand`）⇒ 直接落 low，不进命令表。
  'bash_ro',
])

/**
 * 已知高危权限键（写/改类，默认打 high，但仍由人裁决）。
 *
 * ⚠️ P2-5 把 `bash` 从这里**移出**：执行类工具的风险**取决于要跑的那条命令**，按权限键
 * 一刀切会让 `ls` / `pwd` 与 `rm -rf` 拿到同一个标签（D4），而下面的高危模式表也就
 * **再没有机会为 bash 生效**。`bash` 改走 {@link assessShellRisk}。
 */
const HIGH_RISK_PERMISSION_KEYS = new Set([
  'write',      // write_file / edit_file（<data-dir> 之外的文件改写）
  'edit',       // code-intel 的 code_semantic_edit（语义改名/替换，直接改源码）
])

/** 高危命令模式（bash 入参里的危险片段） */
const HIGH_RISK_PATTERNS = [/rm -rf/, /\bsudo\b/, /:?\(\)/, /dd if=/, /mkfs/, /curl .*\| *sh/]

/**
 * 执行类权限键：入参里带一条 shell 命令，风险按**命令内容**分级（P2-5 / D4）。
 * 只有 `bash` —— 只读变体已在 {@link LOW_RISK_PERMISSION_KEYS} 里直接落 low。
 */
const SHELL_PERMISSION_KEYS = new Set(['bash'])

/**
 * 只读命令首词白名单：**整条命令的每一段**（按 `&&` / `||` / `;` / `|` / `&` / 换行切段）
 * 首词都在这里、且没有 {@link SHELL_DANGEROUS_FLAGS}，`bash` 才落 `low`。
 *
 * 收录原则：只收**语义上不产生副作用**的命令。以下刻意**不收**（宁可落 medium —— 标签
 * 保守只是少一点区分度，放宽才是往错的方向偏）：
 * - `sort` / `sed` / `awk` —— 有写文件开关（`sort -o` / `sed -i`）；
 * - `env` / `xargs` / `sh` / `bash` —— 只是"跳板"，真正的动作在参数里；
 * - `git` / `npm` / `docker` —— 同一首词下读（`git log`）与写（`git push`）并存；
 * - `find` 收录，但用 {@link SHELL_DANGEROUS_FLAGS} 挡掉 `-exec` / `-delete`。
 */
const LOW_RISK_COMMAND_HEADS = new Set([
  'ls', 'pwd', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find',
  'which', 'whoami', 'id', 'date', 'uname', 'hostname', 'printenv',
  'stat', 'file', 'du', 'df', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'type', 'true',
])

/**
 * "把只读命令变成写命令"的开关（`find … -exec rm {} \;` / `find . -delete`）。
 * 命中即该段不算只读。
 */
const SHELL_DANGEROUS_FLAGS = /(?:^|\s)(?:-exec|-execdir|-ok|-okdir|-delete|--exec)(?:\s|$)/

/**
 * 写入 / 内联执行的 shell 元字符：重定向（`>` / `<`）、命令替换（反引号 / `$(`）。
 * 命中即不可能是"纯只读" ⇒ 至少 medium。
 *
 * ⚠️ 不要在这里加 `2>` 之类的补丁 —— 空设备重定向由 {@link NULL_SINK_REDIRECT} 先摘掉。
 */
const SHELL_WRITE_HINT = /[<>`]|\$\(/

/**
 * 空设备重定向（`2>/dev/null`、`>/dev/null`、`&>/dev/null`）：不落盘，不算写。
 *
 * 与 `tools-builtin` 的 `NULL_SINK_REDIRECT` **同一形态**（那边管只读判定，这边管风险标签）：
 * 不摘掉的话 `git status 2>/dev/null` 会被 {@link SHELL_WRITE_HINT} 判成写，白丢一个 low。
 * 尾部的负向前瞻是钉子 —— 没有它 `> /dev/nullx` 也会被当成空设备。
 */
const NULL_SINK_REDIRECT = /&?[12]?>{1,2}\s*\/dev\/null(?![\w.-])/g

/** 取命令段的第一个"真正的词"，跳过前置的环境变量赋值（`FOO=1 ls` ⇒ `ls`）。 */
function shellHead(segment: string): string {
  const words = segment.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i += 1
  return words[i] ?? ''
}

/** 从工具入参里取命令文本；取不到返回 `undefined`（调用方按保守档处理）。 */
function shellCommandText(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const c = (input as { command?: unknown }).command
    if (typeof c === 'string') return c
  }
  return undefined
}

/**
 * 执行类命令的分级器（P2-5 / D4）。
 *
 * 判据（按序）：高危模式 → `high`；写入/替换元字符 → `medium`；**每一段**首词都在
 * {@link LOW_RISK_COMMAND_HEADS} 且无 {@link SHELL_DANGEROUS_FLAGS} → `low`；其余 → `medium`。
 *
 * 空命令文本（`''` / 纯空白）⇒ `high`：执行类工具却拿不到要跑什么，按高危处理是唯一
 * 安全的默认。
 */
function assessShellRisk(command: string): RiskLevel {
  if (HIGH_RISK_PATTERNS.some((re) => re.test(command))) return 'high'
  const inspected = command.replace(NULL_SINK_REDIRECT, ' ')
  if (SHELL_WRITE_HINT.test(inspected)) return 'medium'
  const segments = inspected.split(/&&|\|\||[;&|\n]/).map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return 'high'
  const allReadOnly = segments.every((seg) =>
    !SHELL_DANGEROUS_FLAGS.test(seg) && LOW_RISK_COMMAND_HEADS.has(shellHead(seg)))
  return allReadOnly ? 'low' : 'medium'
}

/**
 * 风险分级器（纯函数，规则引擎侧唯一出口）。
 *
 * 定稿语义：**白名单/黑名单可硬拦高危，中间地带只标低/中/高风险，不自动决策** ——
 * 分级结果只作为决策卡片的标签与审计字段，放行与否永远由人工按键决定。
 *
 * 判据（按序，P2-5 起分流）：**执行类权限键**（`bash`）→ {@link assessShellRisk}（看命令内容）；
 * **其余** → 入参高危模式 > 已知权限键表 > 默认 medium。
 * 执行类放到最前，是为了让高危模式表**为 bash 真正生效**（改造前 bash 命中键表就
 * 直接 return high，模式表对它形同虚设 —— 那正是 D4）。
 *
 * ⚠️ 第一个参数是**权限键**（`permission.key`），不是工具 id —— 见
 * {@link HIGH_RISK_PERMISSION_KEYS} 上方的说明。
 */
export function assessRisk(permissionKey: string, patterns: string[] = [], input?: unknown): RiskLevel {
  if (SHELL_PERMISSION_KEYS.has(permissionKey)) {
    const command = shellCommandText(input)
    // 拿不到命令文本 ⇒ 保守 high（与改造前逐位一致）
    return command ? assessShellRisk(command) : 'high'
  }
  const blob = JSON.stringify(input ?? {})
  if (HIGH_RISK_PATTERNS.some((re) => re.test(blob))) return 'high'
  if (HIGH_RISK_PERMISSION_KEYS.has(permissionKey)) return 'high'
  if (LOW_RISK_PERMISSION_KEYS.has(permissionKey)) return 'low'
  return 'medium'
}

/**
 * 宿主无关的提问材料。
 *
 * `text` 是**默认渲染**的完整问题（CLI 直接拿去 readline）；远程宿主可以只用 `summary`
 * 落任务 metadata，也可以完全不用 —— 它是默认值，不是唯一值。
 */
export interface PermissionPrompt {
  toolKey: string
  patterns: string[]
  /** 会话归属，透传自 `PermissionAskInput`（asker 路由用；无归属时为 undefined） */
  sessionId?: string
  /** 一句话摘要，如 `权限请求 [bash] rm -rf /tmp/x`（CLI 的 readline 首行就是它） */
  summary: string
  /** 默认完整问题（含操作说明与 `[a/d/A/D]` 键位提示），CLI 逐字使用 */
  text: string
  /** M3：风险分级标签（assessRisk 产出，决策卡片呈现；向后兼容可选） */
  riskLevel?: RiskLevel
}

/**
 * 询问接缝。返回 `undefined` = 取不到答复 ⇒ 引擎按 **deny** 处理（与既有 readline 兜底一致）。
 * 抛错不在此处捕获：让宿主自己决定是回退 deny 还是暴露故障。
 */
export type PermissionAsker = (
  req: PermissionAskInput,
  prompt: PermissionPrompt,
) => Promise<PermissionAnswer | undefined>

/** 规则持久化（`<data-dir>/permissions.json`） */
export interface PermissionStoreFile {
  rules: Record<string, unknown> // 对应 PermissionRuleset
}

/**
 * 组装默认提问材料。**文案与改造前逐字一致**（`cli.test.ts` 的权限用例与真机输出都钉着它）：
 * 首行 `⚠️  权限请求 [<toolKey>] <patterns>`（注意 `⚠️` 后是两个空格），次行是操作说明。
 */
export function buildPermissionPrompt(req: PermissionAskInput): PermissionPrompt {
  const patterns = req.patterns ?? []
  const pat = patterns.slice(0, 3).join(', ') || '(无路径)'
  const summary = `权限请求 [${req.toolKey}] ${pat}`
  return {
    toolKey: req.toolKey,
    patterns,
    sessionId: req.sessionId,
    summary,
    text:
      `\n⚠️  ${summary}\n` +
      // P2-6 / D6：文案与 `PermissionAnswer` **同一词汇表**，且每个词后面紧跟它的按键。
      // 旧文案 `allow / deny / always(a) / deny-always(d)? [a/d/A/D]` 是**自相矛盾**的 ——
      // 前半说 `always` 是 `a`，方括号里 `a` 却是 allow、`A` 才是 always（实际实现是
      // `parseCliAnswer`：`a`→allow、`A`→always-allow）⇒ 照前半读会把「始终允许」
      // 按成「允许一次」。现在只有 `状态(键)` 一种形态，`cli.test.ts` 有一条守卫把
      // 「文案里的词」与「parseCliAnswer(那个键)」逐对钉住。
      `  操作: allow(a) / deny(d) / always-allow(A) / always-deny(D)? `,
    // M3：决策卡片的风险标签（分级器不决策，只打标）
    riskLevel: assessRisk(req.toolKey, patterns, req.input),
  }
}

// ===== decision.human 审计（M3）=====

/**
 * 人工决策审计事件（零内容约束，与遥测一致）。
 *
 * 只记录标量与摘要哈希，**不记录工具入参原文** —— `stateHash` 是决策上下文
 * （toolKey + patterns + 入参）的 SHA-256，可复核「这次问的是什么」而不可逆推内容。
 * 响应耗时 `responseMs` 与放行率是衡量决策卡片 UI 辅助效果的核心指标（决策权归人工，
 * 指标衡量"人是不是更快/更放心"，而非机器决策准确率）。
 */
export interface HumanDecisionEvent {
  schema: 'harness.audit.v1'
  kind: 'decision.human'
  /** 毫秒时间戳 */
  ts: number
  /** 会话归属（PermissionAskInput.sessionId；无归属时不落审计） */
  sessionId?: string
  /** 决策点（M3 起步 = 权限询问） */
  decisionPoint: 'core.permission.ask'
  /** 工具权限键 */
  tool: string
  /** 决策上下文摘要哈希（SHA-256，零内容） */
  stateHash: string
  /** 风险分级标签（assessRisk 产出） */
  riskLevel: RiskLevel
  /** 人工答复（四态原文） */
  actionTaken: 'allow' | 'deny' | 'always-allow' | 'always-deny'
  /** 人工响应耗时（ms，进入询问到收到答复） */
  responseMs: number
  /** 记忆范围：always-* ⇒ 'tool'（写回规则集）；单次 ⇒ 'once' */
  rememberScope: 'tool' | 'once'
}

/**
 * 规则变更审计事件（P1-9 / §8 D5）。零内容约束同 {@link HumanDecisionEvent}。
 *
 * ## 为什么需要它
 * 审计原本**只有 `decision.human` 一种 kind** ⇒ 规则被改动这件事本身不可回溯：
 * "权限是被谁、何时、从 `allow` 改成 `deny` 的"没有记录。而权限是安全边界，
 * **静默的规则变更**比"没人按过那个按钮"更危险 —— 尤其是授权已经按归属分层（P0-9）之后。
 *
 * 三条写回路径都发这个事件（`source` 区分）：CLI 斜杠命令、A2A 控制面、以及权限询问的
 * `always-*` 写回（`asker`）。
 */
export interface PermissionRuleChangedEvent {
  schema: 'harness.audit.v1'
  kind: 'permission.rule.changed'
  /** 毫秒时间戳 */
  ts: number
  /** 变更来源：`cli` = 斜杠命令；`control-api` = A2A 控制面；`asker` = 权限询问的 always-* 写回 */
  source: 'cli' | 'control-api' | 'asker'
  /** 会话归属（有则落该会话的审计文件，无则落工作区级 `{dataDir}/audit.jsonl`） */
  sessionId?: string
  /** 被改动的规则键（工具键或归属规则键；`reset` 整份重写时为 undefined） */
  key?: string
  /** 该键的新行为；`reset` 表示整份重置 */
  behavior?: PermissionBehavior | 'reset'
  /**
   * 变更**之后**规则集的摘要哈希（SHA-256，零内容）。
   * ⚠️ 只哈希**不落规则原文** —— 归属规则键里含的是**调用方主体的哈希**（见
   * `callerScopeKey`），规则原文本身可能含敏感路径/命令。
   */
  stateHash: string
}

/** 审计事件总集（`schema` 统一为 `harness.audit.v1`，零内容） */
export type AuditEvent = HumanDecisionEvent | PermissionRuleChangedEvent

/** 规则集摘要哈希（SHA-256，零内容：规则原文只进哈希不出明文） */
export function rulesStateHash(rules: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex')
}

/** 决策上下文摘要哈希（SHA-256，零内容：入参只进哈希不出明文） */
export function stateHashOf(req: PermissionAskInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ toolKey: req.toolKey, patterns: req.patterns, input: req.input ?? null }))
    .digest('hex')
}

/**
 * 交互式权限引擎：在 `DefaultPermissionEngine`（四级规则匹配）之上补三件事 ——
 * ① 交互模式短路；② 四态答复；③ `always-*` 的规则写回与落盘。
 *
 * 三个宿主共用这一份；宿主差异全部收在 `asker` 里。
 */
export class InteractivePermissionEngine extends DefaultPermissionEngine {
  /** 进程级默认模式（构造期来自配置；未给 `sessionId` 的 `setMode` 改的就是它） */
  private mode: PermissionMode
  /**
   * P2-7（§8 D7）：**会话级**模式覆盖。
   *
   * 一个进程内多个会话共享同一个引擎，改造前 `mode` 是**裸字段** ⇒ 任一会话（含 A2A
   * 的远程调用方）切模式都会改到全进程，而 CLI 的 `/permission <mode>` 文案又容易被
   * 读成"只对本会话生效"。现在两者一致了：
   * - 会话切过 ⇒ 在本表里；
   * - 没切过 ⇒ 回退 {@link mode}（进程默认）。
   *
   * 与 `mode` 同样的口径：**内存态、不落盘、重启复位**（有意如此 —— 模式是"当下怎么答"，
   * 不是授权策略；策略在 `permissions.json`）。
   */
  private readonly sessionModes = new Map<string, PermissionMode>()
  private asker: PermissionAsker | undefined
  private readonly store: (PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }) | undefined
  /** M3：审计 sink（宿主注入，落盘实现归宿主） */
  private readonly auditSink: ((env: AuditEvent) => void | Promise<void>) | undefined
  /** P0-9：归属主体解析（宿主注入；缺省 ⇒ 无归属，规则只在工具键/全局键两层匹配） */
  private callerResolver: ((sessionId?: string) => string | undefined) | undefined

  constructor(
    rules: Record<string, unknown> = { '*': 'ask' },
    opts: {
      store?: PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }
      mode?: PermissionMode
      asker?: PermissionAsker
      /** M3：审计 sink（零内容 + stateHash；`decision.human` 与 `permission.rule.changed` 共用） */
      audit?: (env: AuditEvent) => void | Promise<void>
      /**
       * P0-9：归属主体解析（`sessionId` → principal；缺省 ⇒ 无归属）。
       * 见 `setCallerResolver` 与基类 `resolvePrincipalKey` 的说明。
       */
      callerResolver?: (sessionId?: string) => string | undefined
    } = {},
  ) {
    super(rules as never)
    this.store = opts.store
    this.mode = opts.mode ?? 'ask'
    this.asker = opts.asker
    this.auditSink = opts.audit
    this.callerResolver = opts.callerResolver
  }

  /**
   * 当前交互模式（allow-all / ask / deny-all），供 `/permission` 查看与切换。
   *
   * `sessionId` 给了 ⇒ 该会话的**生效**模式（会话覆盖优先，否则进程默认）；
   * 不给 ⇒ 进程默认（新建会话的初值）。
   */
  getMode(sessionId?: string): PermissionMode {
    if (sessionId) {
      const scoped = this.sessionModes.get(sessionId)
      if (scoped) return scoped
    }
    return this.mode
  }

  /**
   * 切换交互模式（不影响持久化规则，仅影响「询问型请求」的自动答复）。
   *
   * - `sessionId` 给了 ⇒ **只对该会话生效**（P2-7：多会话共存时不再互相影响）；
   * - 不给 ⇒ 改进程默认，影响所有**未单独切换过**的会话（含之后新建的会话）。
   */
  setMode(mode: PermissionMode, sessionId?: string): void {
    if (sessionId) {
      this.sessionModes.set(sessionId, mode)
      return
    }
    this.mode = mode
  }

  /** 替换询问交互器（TUI 在启动后注入模态审批，替代默认 readline 行内提问） */
  setAsker(fn?: PermissionAsker): void {
    this.asker = fn
  }

  /**
   * 当前询问交互器（`undefined` = 未装，此时 ask → deny）。
   *
   * 存在的理由：**新增的询问源需要"包装"而不是"替换"现有 asker**。典型场景是进程内
   * MCP server —— 它只能处理"属于自己会话"的询问（`PermissionAskInput.sessionId`），
   * 其余的必须交回原 asker，否则就把 TUI 的模态审批顶掉了。没有 getter 时拿不到被包装者，
   * "包装"只能退化成"替换" ⇒ 两个询问源互相顶掉、先装的那个静默失效。
   */
  getAsker(): PermissionAsker | undefined {
    return this.asker
  }

  /**
   * 注入归属主体解析（P0-9）。`fn` 给 `sessionId` 返回**主体标识**（principal），
   * 缺省/返回 `undefined` ⇒ **无归属**（规则只在工具键 / 全局键两层匹配，行为与分层前一致）。
   *
   * ## 为什么是"启动后注入"而不是构造参数
   * 与 `setAsker` 同一条理由：A2A 宿主是**先 boot host、后建 server**，而"调用方是谁"只有
   * server 侧的鉴权上下文（Bearer 头 + `CallerRegistry`）才知道。`createA2aServer` 建完后
   * 把这条解析器装回来即可。
   *
   * ## ⚠️ 契约：返回值会被**哈希**后落盘
   * A2A 的主体标识就是 Bearer token（见 `callerScopeKey` 的说明）。返回**原始标识**即可，
   * `callerScopeKey()` 会把它转成 16 位摘要再进规则键 —— 落盘不留明文。
   */
  setCallerResolver(fn?: (sessionId?: string) => string | undefined): void {
    this.callerResolver = fn
  }

  /** 覆写基类钩子：把宿主注入的解析器接进 `check()` 的作用域回退（见基类 `resolvePrincipalKey`） */
  protected override resolvePrincipalKey(req: PermissionRequest): string | undefined {
    return this.callerResolver?.(req.sessionId)
  }

  /**
   * 询问：`allow-all` / `deny-all` 直接短路；否则经 `asker` 取四态答复。
   * 无法识别的答复与取不到答复一律 deny（与改造前逐位一致）。
   */
  override async ask(req: PermissionAskInput): Promise<PermissionDecision> {
    // P2-7：取**本会话**的生效模式（会话覆盖 → 进程默认），而不是裸字段
    const mode = this.getMode(req.sessionId)
    if (mode === 'allow-all') return { behavior: 'allow', matchedRule: 'global' }
    if (mode === 'deny-all') return { behavior: 'deny', matchedRule: 'global' }
    const startedAt = Date.now()
    const prompt = buildPermissionPrompt(req)
    const answer = this.asker ? await this.asker(req, prompt) : undefined
    const responseMs = Date.now() - startedAt
    const { decision, ruleChange } = await this.answerToDecision(req, answer)
    // M3 审计：只有真正拿到人工答复才记（无答复 ⇒ deny 是兜底，不是人工决策）。
    // allow-all/deny-all 短路已在上方 return，不走这里。
    // 顺序刻意是「决策 → 其后果」：先记人工按了什么，再记它把规则改成了什么。
    if (answer !== undefined && this.auditSink) {
      await this.auditSink({
        schema: 'harness.audit.v1',
        kind: 'decision.human',
        ts: Date.now(),
        sessionId: req.sessionId,
        decisionPoint: 'core.permission.ask',
        tool: req.toolKey,
        stateHash: stateHashOf(req),
        riskLevel: prompt.riskLevel ?? 'medium',
        actionTaken: answer,
        responseMs,
        rememberScope: answer === 'always-allow' || answer === 'always-deny' ? 'tool' : 'once',
      })
    }
    // P1-9：always-* 的规则写回同样是"规则变更"，必须留痕（source=asker）。
    if (ruleChange && this.auditSink) {
      await this.auditSink({
        schema: 'harness.audit.v1',
        kind: 'permission.rule.changed',
        ts: Date.now(),
        source: 'asker',
        sessionId: req.sessionId,
        key: ruleChange.key,
        behavior: ruleChange.behavior,
        stateHash: ruleChange.stateHash,
      })
    }
    return decision
  }

  /** 四态答复 → 决策（含 always-* 的规则写回）；`ruleChange` 供上层落 `permission.rule.changed` 审计 */
  private async answerToDecision(
    req: PermissionAskInput,
    answer: PermissionAnswer | undefined,
  ): Promise<{ decision: PermissionDecision; ruleChange?: { key: string; behavior: 'allow' | 'deny'; stateHash: string } }> {
    switch (answer) {
      // 先判"永久"：写回规则集并置 remember，宿主重启后不再问
      case 'always-allow': {
        const ruleChange = await this.rememberRule(req, 'allow')
        return { decision: { behavior: 'allow', matchedRule: 'tool', remember: true }, ruleChange }
      }
      case 'always-deny': {
        const ruleChange = await this.rememberRule(req, 'deny')
        return { decision: { behavior: 'deny', matchedRule: 'tool', remember: true }, ruleChange }
      }
      // 单次：只影响本次
      case 'allow':
        return { decision: { behavior: 'allow', matchedRule: 'tool' } }
      case 'deny':
        return { decision: { behavior: 'deny', matchedRule: 'tool' } }
      default:
        return { decision: { behavior: 'deny', matchedRule: 'global' } }
    }
  }

  /**
   * 把「永久」答复写回规则集并落盘（`updateRules` 改内存，`save` 落盘，两者必须一起）。
   *
   * ## 为什么是「增量并入 PathRules」而不是整键覆盖（P0-8）
   * 旧实现是 `{ ...getRules(), [toolKey]: behavior }` —— 写回**只按 toolKey**、且**整键覆盖**，
   * 于是三件事同时发生：
   * 1. **粒度失控**：提示卡片里显示的是**具体命令**（`buildPermissionPrompt` 的 `patterns`），
   *    但按一次「始终允许」记的是**整个工具** —— `always-allow bash` 等于放行所有 bash；
   * 2. **丢规则**：把用户已配的 `{ allow, deny, ask }` 整键替换掉（`deny: ['shutdown*']` 直接消失）；
   * 3. **段级防线消失**：规则退化成 **string** 形态后，`DefaultPermissionEngine.check()` 走
   *    `typeof toolRule === 'string'` **直接 return**，`denyTargets`（含 bash 的段级
   *    `denyPatterns`，唯一能拦 `echo hi; shutdown -h now` 的判据）**整体不再参与判定**。
   *
   * 改成"把本次 `patterns` **并入**目标列表、**保留**既有列表"后：①粒度回到**命令级**；
   * ②原来配的 `deny`/`ask` 还在；③规则始终是**对象**形态，段级 deny 照常执行。
   *
   * `patterns` 为空（如 `read` 这类无路径参数的工具）⇒ 用 `['**']` 通配，**等价于旧的 string
   * 语义**，但仍保留既有 `deny`/`ask`（旧实现会把它们一并抹掉）。旧数据里已是 string 的规则
   * 同样归一成 `**` —— 不丢语义，只补回"还能被 deny 拦"的能力。
   *
   * ## 写回**带归属键**（P0-9）
   * 有归属主体时，规则键写成 `caller:<hash>|<toolKey>` 而不是裸 `<toolKey>`。理由见
   * `callerScopeKey` 与 `DefaultPermissionEngine.resolvePrincipalKey`：规则集是 **dataDir 级共享**的，
   * 裸键会让"本机点一次始终允许"被同一工作区的**远程 A2A 调用方**继承（反向亦成立）。
   * 无归属（宿主没装解析器）时退回裸键 —— 与分层前逐位相同。
   *
   * 返回写回键与行为，供上层落 `permission.rule.changed` 审计（P1-9）。
   */
  private async rememberRule(
    req: PermissionAskInput,
    behavior: 'allow' | 'deny',
  ): Promise<{ key: string; behavior: 'allow' | 'deny'; stateHash: string }> {
    const patterns = req.patterns ?? []
    const toolKey = req.toolKey
    // 归属键：主体经 callerScopeKey 哈希（**落盘无明文**，见该函数的说明）
    const principal = this.callerResolver?.(req.sessionId)
    const ruleKey = principal ? scopedRuleKey(callerScopeKey(principal), toolKey) : toolKey

    const current = this.getRules()
    const existing = current[ruleKey]
    // 归一成 PathRules：旧 string 形态只描述"整个工具"，落成 `**` 通配（语义等价，可再被 deny 拦）
    const base: PathRules =
      typeof existing === 'string'
        ? existing === 'allow'
          ? { allow: ['**'] }
          : existing === 'deny'
            ? { deny: ['**'] }
            : { ask: ['**'] }
        : existing && typeof existing === 'object'
          ? { ...existing }
          : {}
    const list = [...((behavior === 'allow' ? base.allow : base.deny) ?? [])]
    for (const p of patterns.length > 0 ? patterns : ['**']) {
      if (!list.includes(p)) list.push(p)
    }
    const updated = { ...current, [ruleKey]: { ...base, [behavior]: list } }
    this.updateRules(updated as never)
    await this.store?.save?.(updated)
    return { key: ruleKey, behavior, stateHash: rulesStateHash(updated as Record<string, unknown>) }
  }
}
