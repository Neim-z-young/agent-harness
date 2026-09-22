/**
 * @harness/subagent - Subagent 插件
 *
 * 让主 Agent 能派出子 Agent 执行独立任务：
 * - 子 Agent 用独立 session（隔离上下文，不污染父对话）
 * - 子 Agent 有独立的工具白名单和权限配置
 * - 父 Agent 通过 SubagentTool（AgentTool）调用子 Agent
 * - 递归深度通过工具白名单控制：子 Agent 默认无 SubagentTool
 *
 * 安全声明（Fail-Closed）：
 * - isReadOnly: false（子 Agent 可能执行写操作）
 * - isConcurrencySafe: false（子 Agent 可能修改共享状态）
 * - isDestructive: false
 * - requiresUserInteraction: false
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { createSubagentPlugin } from '@harness/subagent'
 *
 * const h = await createHarness({
 *   internalPlugins: [createSubagentPlugin({
 *     subagents: [{
 *       id: 'coder',
 *       name: 'Coder',
 *       description: '负责写代码的子 Agent',
 *       mode: 'subagent',
 *       tools: ['read_file', 'write_file', 'edit_file', 'bash'],
 *       permission: { '*': 'allow' },
 *       promptFragments: ['你是一个专注写代码的子 Agent，只完成分配给你的任务。'],
 *     }],
 *   })],
 * })
 */

import { defineTool, withJsonSchema, Tool, ToolResult, Schema, ToolContext, formatToolWhitelist, READONLY_TOOLS_SENTINEL } from '@harness/tool'
import type { AgentPlugin, Hooks, CliCommandInput, SubagentCapability } from '@harness/plugin'
import type { AgentDefinition, AgentPermissionConfig } from '@harness/agent'
import type { AgentRuntime, SessionManager } from '@harness/core'
import type { Message } from '@harness/session'
import { BusEvent, type Bus } from '@harness/bus'
import { matchGlob } from '@harness/permission'
import { writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join, dirname, resolve as resolvePath, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorktree, getWorktreeDiff, gitTopLevel, listWorktrees, removeWorktree } from './worktree'
// SubagentTool 提示词文本（prompts/*.txt，import 加载，参考 opencode）
import subagentToolDescription from './prompts/subagent-tool-description.txt'
import subagentToolDocumentation from './prompts/subagent-tool-documentation.txt'

// ===== Subagent Bus 事件定义 =====

/**
 * 子 Agent 执行开始事件。
 * 在子 session 创建/续接后、agent.query 调用前发布。
 */
export const SubagentEvents = {
  started: BusEvent.define<{
    /** 子 Agent ID */
    agentId: string
    /** 子 Agent 名称 */
    agentName: string
    /** 子 session ID */
    subSessionId: string
    /** 父 session ID（调用方） */
    parentSessionId: string
    /** 父 Agent ID（调用方） */
    parentAgentId: string
    /** 父消息 ID（触发此工具调用的消息） */
    parentMessageId: string
    /** 工具调用 ID */
    toolUseId: string
    /** 任务描述 */
    prompt: string
    /** 简短描述（UI 展示用） */
    description?: string
    /** 是否续接已有子 session */
    isContinuation: boolean
    /** 开始时间戳 */
    startedAt: number
    /** 后台任务 ID（runInBackground=true 时有值） */
    taskId?: string
    /** 是否为后台执行 */
    background?: boolean
  }>('subagent.started'),

  completed: BusEvent.define<{
    /** 子 Agent ID */
    agentId: string
    /** 子 session ID */
    subSessionId: string
    /** 父 session ID */
    parentSessionId: string
    /** 工具调用 ID */
    toolUseId: string
    /** 子 Agent 最终回复文本（截断预览） */
    replyPreview: string
    /** 子 session 消息总数 */
    messageCount: number
    /** 执行耗时（ms） */
    durationMs: number
    /** 后台任务 ID（runInBackground=true 时有值） */
    taskId?: string
    /** 是否为后台执行 */
    background?: boolean
  }>('subagent.completed'),

  failed: BusEvent.define<{
    /** 子 Agent ID（可能为空，如果 Agent 未找到） */
    agentId?: string
    /** 子 session ID（可能为空，如果创建失败） */
    subSessionId?: string
    /** 父 session ID */
    parentSessionId: string
    /** 工具调用 ID */
    toolUseId: string
    /** 错误码 */
    code: string
    /** 错误消息 */
    message: string
    /** 执行耗时（ms） */
    durationMs: number
    /** 后台任务 ID（runInBackground=true 时有值） */
    taskId?: string
    /** 是否为后台执行 */
    background?: boolean
  }>('subagent.failed'),

  /**
   * 子 Agent 结果已被本地续跑通道取回（coordinator send_message 命中该 taskId）。
   * subagent 插件订阅后把对应后台任务标记为 `resultFetched=true`，使其完成通知降级为简短提示，
   * 不再把结果全文重复注入父会话（去重：另一条通道已先取回结果）。
   */
  resultFetched: BusEvent.define<{
    /** 后台任务 ID */
    taskId: string
    /** 父 session ID（发送续跑消息的协调者会话） */
    parentSessionId: string
    /** 取回时间戳 */
    fetchedAt: number
  }>('subagent.result.fetched'),

  /**
   * 子 Agent 工具调用进度事件（P1-5）。
   * 后台任务执行期间，每次工具调用开始/完成时发布，前端实时展示进度。
   */
  progress: BusEvent.define<{
    /** 后台任务 ID */
    taskId: string
    /** 子 Agent ID */
    agentId: string
    /** 父 session ID */
    parentSessionId: string
    /** 工具调用 ID */
    toolUseId: string
    /** 工具 ID（如 read_file / bash） */
    toolName: string
    /** 工具执行状态 */
    toolStatus: 'running' | 'completed' | 'failed'
    /** 进度摘要（工具输入/结果预览） */
    summary: string
    /** 进度时间戳 */
    timestamp: number
  }>('subagent.progress'),
} as const

// ===== 类型定义 =====

/** SubagentTool 的输入 */
export interface SubagentToolInput {
  /** 子 Agent ID（必须已注册且 mode === 'subagent'） */
  agentId: string
  /**
   * 派给子 Agent 的任务描述
   */
  prompt: string
  /**
   * 本次子任务的步数上限（可选）。优先级高于子 Agent 自身的 `AgentDefinition.maxSteps`
   * 与插件默认值 —— 派工方比 agent 定义更清楚「这一次」的规模（同一 reader 既可能只看一个
   * 文件、也可能通读整个仓库）。不传则保持旧行为。
   */
  maxSteps?: number
  /** 3-5 词简短描述（用于 UI 展示和工具调用日志，类似 Claude Code 的 description 参数） */
  description?: string
  /** 模型覆盖（优先级高于子 Agent 定义中的 model；不传则用子 Agent 自身配置） */
  model?: { providerId?: string; modelId?: string; temperature?: number }
  /** 续接已有子 session（多轮子 Agent 对话）；不传则创建新 session */
  sessionId?: string
  /**
   * 是否在后台运行（fire-and-forget）：
   * - true：立即返回 taskId 和子 sessionId，不等待子 Agent 执行完成
   * - 不传 / false：同步等待子 Agent 完成（默认）
   *
   * 后台任务执行完成后：
   * 1. 通过 Bus 事件 subagent.completed / subagent.failed 推送（带 taskId）
   * 2. 自动向父会话注入 <task-notification> 通知，下一轮推理开始时可见
   * 3. 用户可通过 CLI /tasks 命令查看任务列表
   *
   * 参考 Claude Code fork subagent 的 task-notification 模型：
   * 工具立即返回 "Background task started"，结果通过事件通知。
   */
  runInBackground?: boolean
  /**
   * 该 worker 预计写入的文件/目录（项目相对路径）。
   * 调度元数据：Coordinator 插件据此做"写操作按文件集串行化"（冲突的派工延迟到前序
   * worker 完成后再执行，避免多个 worker 并发改同一批文件）。subagent 工具本身不消费。
   */
  targetFiles?: string[]
}

/** SubagentTool 的输出 */
export interface SubagentToolOutput {
  /** 子 session ID（独立隔离上下文） */
  sessionId: string
  /** 子 Agent 最终回复文本（超过阈值时为摘要） */
  message: string
  /** 子 session 中的消息总数 */
  messageCount: number
  /** 回复是否被摘要截断 */
  summarized: boolean
  /** 子 Agent 内部工具调用次数 */
  toolCallCount: number
  /**
   * 完整输出的落盘路径（summarized=true 时有值）。
   *
   * 落在 `{dataDir}/subagent-results/`（与会话/任务记录同域、系统不清理）；dataDir 不可用时
   * 退化为 OS 临时目录。**该路径通常在调用方工作目录之外**，此时 `read_file`/`grep_file`
   * 会以 `PATH_OUTSIDE_CWD` 拒绝 —— 摘要文本里的提示会如实说明，不要假定可读。
   */
  outputPath?: string
  /** 相对基线 HEAD 的完整 diff 补丁路径（worktree 隔离启用且子 Agent 有改动时有值；与 outputPath 同域） */
  diffPath?: string
  /** 后台任务 ID（runInBackground=true 时有值） */
  taskId?: string
  /** 是否为后台模式（runInBackground=true 时为 true） */
  background?: boolean
}

/** createSubagentPlugin 的配置 */
export interface SubagentPluginOptions {
  /**
   * 启动时**由本插件**注册的子 Agent 定义列表。
   *
   * 注意这不是「全部可调用的子 Agent」：md 定义的子 Agent 走 agentDirs 直接注册进
   * AgentRuntime，不经过本插件。要枚举真正可调用的子 Agent 请查注册表
   * （见 `registrySubagents`），`/subagents` 命令与 subagent 工具都以注册表为准。
   */
  subagents?: AgentDefinition[]
  /** 子 Agent 执行超时（毫秒），缺省 120_000 */
  timeoutMs?: number
  /** 子 Agent 完成后是否删除子 session（缺省 false，保留便于调试） */
  cleanupSession?: boolean
  /** 返回给父 Agent 的最大结果长度（字符），超过则生成摘要。缺省 2000 */
  maxResultLength?: number
  /** 返回给父 Agent 的最大结果行数，超过则生成摘要。缺省 500（先于 maxResultLength 触发更精准） */
  maxResultLines?: number
  /** 注入子 Agent 的结构化输出指令（类似 Claude Code 的 fork directive），要求子 Agent 简洁结构化回复 */
  directive?: string
  /**
   * 是否把「可派工的子 Agent 名单」注入派工方的 system prompt（缺省 true）。
   *
   * 为什么要注入：agent 的 `description` **不进模型上下文**（只有 `/subagents` 展示用），
   * subagent 工具的描述也是静态 txt ⇒ 派工方**看不到有哪些子 Agent 可用**，只能靠用户点名
   * `agentId` 或靠猜。roster 就是把 `id + 一句话触发条件` 摆到它面前。
   *
   * 只给**自己有 subagent 工具**的 Agent 注入（coordinator / lead 这类）；派不了工的 Agent
   * 拿到名单是纯噪音。
   */
  injectRoster?: boolean
  /**
   * 子 Agent 的引擎内自主多步步数上限（缺省 {@link DEFAULT_SUBAGENT_MAX_STEPS} = 20）。
   *
   * 为什么比主 Agent 的默认 30 小：子 Agent 的职责是**聚焦执行**（分析一个文件、改一处、
   * 跑一条命令），不是长链探索；步数越多越容易撞上 `timeoutMs`（缺省 120s）而被判超时。
   * 注意**子 Agent 自己的 `AgentDefinition.maxSteps` 优先**（md 定义的子 Agent 可显式覆盖）。
   */
  maxSteps?: number
}

/**
 * 子 Agent 默认步数上限。
 *
 * 取 20 的依据（真机实测）：会话 `s_1789916436883_ra6w1` 中 R2 任务（测绘 1902 个文件 /
 * 512K 行源码）跑在旧上限 10 被截断，子 Agent 自述「已到达步数上限，未逐一细读」。该量级
 * 的深度遍历任务典型需要 15~20 步，故提升到 20。
 *
 * 为什么仍比主 Agent 默认 30 小：子 Agent 职责是聚焦执行（分析一个文件、改一处、跑一条
 * 命令），不是长链探索；步数越多越容易撞上 `timeoutMs`（缺省 120s）被判超时。需要更长的
 * 子 Agent 应在自己的 AgentDefinition 里显式写 `maxSteps`，或直接用插件 `maxSteps` 选项覆盖。
 */
export const DEFAULT_SUBAGENT_MAX_STEPS = 20

/**
 * 摘要给父 Agent 的最大结果长度（字符），超过则生成摘要并把全文落盘。
 *
 * 由 2000 提到 8000 的依据（真机实测，会话 `s_1789996799007_9cq9r`）：
 * 9 份子 Agent 报告的正文是 **4532 ~ 10195 字符**，在 2000 阈值下 **9/9 全部被截断**；
 * 父 Agent 于是不得不 `bash cp` 把 tmp 文件搬回工作目录再 read_file 逐份读回——
 * 约 10 轮纯管道操作。提到 8000 后 8/9 不再截断，且**上下文增量几乎为零**：
 * 那些报告本来就只比 2000 高一点，截断省下的字数远小于搬运的轮次成本。
 * 之所以不设更大：摘要仍是"子 Agent 返回超长内容"时的安全阀，需要全文时按路径取用。
 */
export const DEFAULT_MAX_RESULT_LENGTH = 8000

/** Harness 引用的最小接口（避免 import core 导致循环依赖） */
interface HarnessLike {
  agent: AgentRuntime
  session: SessionManager
  /** Bus 事件总线（用于发布子 Agent 进度事件） */
  bus?: Bus
  /** 全局工具工作目录（core 传入 HarnessImpl.cwd；子 Agent 判 git worktree 用） */
  cwd?: string
  /** 工具注册表（可选）：把只读哨兵白名单解析成实际工具 id，供 /subagents 展示 */
  tools?: { filterByWhitelist(whitelist: string[] | ['*']): Array<{ id: string }> }
}

// ===== Schema helper（自包含，避免跨包依赖）=====

function makeSchema<T>(): Schema<T> {
  return {
    parse(value: unknown): T {
      return value as T
    },
    safeParse(value: unknown) {
      return { success: true, data: value as T }
    },
  }
}

// ===== 从 Message 提取文本 =====

/** 从消息数组中提取最后一条 assistant 消息的文本部分 */
function extractFinalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const texts = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text?: string }).text ?? '')
      .filter(Boolean)
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

// ===== 基于 caller.permission 过滤 Agent =====

/**
 * 判断子 Agent 是否被父 Agent 的权限配置拒绝。
 *
 * 参考 OpenCode task.ts 的 `PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny"` 逻辑。
 *
 * @harness 的 AgentPermissionConfig 结构兼容 @harness/permission 的 PermissionRuleset：
 * - 简写形式：`agent: 'allow' | 'deny' | 'ask'`（对所有子 Agent 生效）
 * - 详细形式：`agent: { allow: ['coder'], deny: ['admin'] }`（按 agentId glob 匹配）
 * - 未配置：fallback 到 `'*'` 全局规则
 *
 * 可见性判定：不被 deny 即可见（与 OpenCode 一致）。
 * allow / ask 只影响调用时的行为（直接放行 vs 询问），不影响可见性。
 *
 * @param agentId 子 Agent ID
 * @param callerPermission 父 Agent 的权限配置（AgentPermissionConfig）
 * @returns true 表示该子 Agent 被拒绝（不可见/不可调用）
 */
export function isAgentDenied(
  agentId: string,
  callerPermission?: AgentPermissionConfig,
): boolean {
  if (!callerPermission) return false

  // 优先用 'agent' 工具键的规则，fallback 到 '*' 全局规则
  const rule = callerPermission['agent'] ?? callerPermission['*']
  if (rule === undefined) return false

  if (typeof rule === 'string') {
    // 简写形式：'deny' 拒绝所有，'allow'/'ask' 放行所有
    return rule === 'deny'
  }

  // 详细形式（AgentPathRules）：检查 agentId 是否匹配 deny 列表中的 glob
  if (rule.deny && rule.deny.some((p) => matchGlob(p, agentId))) {
    return true
  }
  return false
}

/**
 * 根据父 Agent 的权限配置过滤可访问的子 Agent 列表。
 *
 * 参考 OpenCode task.ts 的 `accessibleAgents = agents.filter(...)` 逻辑。
 *
 * @param agents 所有已注册的子 Agent
 * @param callerPermission 父 Agent 的权限配置（AgentPermissionConfig）
 * @returns 过滤后的可访问子 Agent 列表（不被 deny 的）
 */
export function filterAccessibleAgents(
  agents: AgentDefinition[],
  callerPermission?: AgentPermissionConfig,
): AgentDefinition[] {
  if (!callerPermission) return agents
  return agents.filter((a) => !isAgentDenied(a.id, callerPermission))
}

// ===== 工具调用摘要 =====

/** 从工具输入中提取关键信息用于摘要（按 toolId 定制） */
function summarizeToolInput(toolId: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>

  switch (toolId) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(obj.path ?? obj.filepath ?? '')
    case 'bash':
    case 'shell':
      return truncateStr(String(obj.command ?? ''), 80)
    case 'list_dir':
      return String(obj.path ?? '')
    case 'glob':
      return String(obj.pattern ?? obj.path ?? '')
    case 'grep':
    case 'grep_file':
      return String(obj.pattern ?? '')
    case 'web_fetch':
    case 'web_search':
      return String(obj.url ?? obj.query ?? '')
    default: {
      // 通用：取第一个字符串值
      for (const v of Object.values(obj)) {
        if (typeof v === 'string') return truncateStr(v, 60)
      }
      return ''
    }
  }
}

/** 截断字符串（超过 maxLen 加 ... 后缀） */
function truncateStr(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s
}

/** 统计子 session 中的工具调用次数 */
function countToolCalls(messages: Message[]): number {
  let count = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'tool') count++
    }
  }
  return count
}

/** 完整子 Agent 输出的落盘子目录名（与 `{dataDir}/tasks` 同级） */
export const SUBAGENT_RESULTS_DIRNAME = 'subagent-results'

/**
 * 把子 Agent 的完整输出落盘，返回实际写入路径。
 *
 * - **优先 resultsDir**（`{dataDir}/subagent-results`）：与会话/任务记录同域，系统不清理。
 * - resultsDir 不可用或写失败 ⇒ 退化到 OS 临时目录（调用方据此如实提示，不谎称可读）。
 * - 文件名 = 时间戳 + 随机段。**只用 `Date.now()` 会让同毫秒并发的多个子任务撞名互相覆盖**
 *   ——同批派工的时间戳只差几毫秒，这是真实踩过的坑（子 session ID 也曾因此碰撞）。
 *
 * 全程 best-effort：写失败不抛错，仍返回首个候选路径供提示使用（不静默，由调用方记 warn）。
 */
function writeResultFile(text: string, kind: 'output' | 'diff', resultsDir?: string): string {
  const ext = kind === 'diff' ? 'patch' : 'txt'
  // 随机段必须**定长**：`Math.random().toString(36)` 形如 "0.xxxx"，值 < 0.1 时 slice(2,8)
  // 只剩 1~2 个字符（约 0.08%），那点熵挡不住同毫秒并发的子任务撞名互相覆盖。
  const rand = Math.random().toString(36).slice(2).padEnd(8, '0').slice(0, 8)
  const name = `subagent-${kind}-${Date.now()}-${rand}.${ext}`
  const candidates = resultsDir
    ? [join(resultsDir, name), join(tmpdir(), name)]
    : [join(tmpdir(), name)]
  for (const p of candidates) {
    try {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text, 'utf-8')
      return p
    } catch { /* 换下一个候选目录 */ }
  }
  return candidates[0]
}

/**
 * 判断路径是否落在给定目录内（含目录本身）。
 * 用于回答「read_file / grep_file 到底读不读得到这个文件」——工作目录外的路径它们会被
 * `PATH_OUTSIDE_CWD` 拒绝，所以提示里绝不能承诺可读。
 */
function isInsideDir(p: string, dir?: string): boolean {
  if (!dir) return false
  const a = resolvePath(p)
  const b = resolvePath(dir)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * 当子 Agent 最终回复过长时生成摘要。
 *
 * 参考 OpenCode `tool/truncation.ts` 的设计：
 * - 双维度阈值（行数 + 字符数），任一超过即触发摘要
 * - head + tail 保留策略（前一半 + 后一半），比单一 head/tail 更能保留首尾信息
 * - 完整输出写入临时文件，返回 outputPath 供父 Agent 用 read_file/grep_file 探索
 * - 智能提示：根据父 Agent 是否拥有探索工具给出不同的后续操作建议
 *
 * 参考 Claude Code `AgentTool/forkSubagent.ts` 的 directive 设计：
 * - 工具调用列表格式参考 Claude Code 的结构化输出（Scope/Result/Key files）
 *
 * 摘要 = head 预览 + 工具调用列表 + tail 预览 + 截断提示（含完整文件路径）
 *
 * @param messages 子 session 的所有消息
 * @param finalText 子 Agent 最终回复文本
 * @param maxResultLength 最大结果长度（字符），超过则摘要
 * @param maxResultLines 最大结果行数，超过则摘要
 * @param callerToolIds 父 Agent 可用工具 ID 列表（用于智能提示）；不传则按「不可读」处理
 * @param resultsDir 完整输出的落盘目录（`{dataDir}/subagent-results`）；不可用时退 OS 临时目录
 * @param callerCwd 父 Agent 工作目录；用于判定 `read_file`/`grep_file` 是否真能读到落盘文件
 * @returns { text, summarized, outputPath } 摘要后的文本、是否被摘要、完整输出文件路径
 */
function summarizeResult(
  messages: Message[],
  finalText: string,
  maxResultLength: number,
  maxResultLines: number,
  callerToolIds?: string[],
  resultsDir?: string,
  callerCwd?: string,
): { text: string; summarized: boolean; outputPath?: string } {
  const lines = finalText.split('\n')
  const totalLines = lines.length
  const totalChars = finalText.length

  // 双维度阈值：行数或字符数任一超过即触发
  const shouldSummarize = totalLines > maxResultLines || totalChars > maxResultLength
  if (!shouldSummarize) {
    return { text: finalText, summarized: false }
  }

  // 提取所有工具调用
  const toolCalls: Array<{ toolId: string; inputPreview: string; isError: boolean }> = []
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue
      const tcp = part as { toolId: string; input?: unknown; isError?: boolean }
      toolCalls.push({
        toolId: tcp.toolId,
        inputPreview: summarizeToolInput(tcp.toolId, tcp.input),
        isError: tcp.isError ?? false,
      })
    }
  }

  // head + tail 保留策略：
  // - 行数超阈值时：按行做 head + tail（前 N/2 行 + 后 N/2 行）
  // - 行数不超但字符数超时：按字符做 head + tail（前一半字符 + 后一半字符）
  const headCount = Math.floor(maxResultLines / 2)
  const tailCount = Math.ceil(maxResultLines / 2)
  let preview: string
  if (totalLines > maxResultLines) {
    // 行级 head + tail
    const headLines = lines.slice(0, headCount)
    const tailLines = totalLines > tailCount ? lines.slice(-tailCount) : []
    const previewLines = headLines.length + tailLines.length < totalLines
      ? [...headLines, '...', ...tailLines]
      : lines
    preview = previewLines.join('\n')
  } else {
    // 字符级 head + tail（行数少但单行很长，如 minified 代码）
    const halfLen = Math.floor(maxResultLength / 2)
    const head = finalText.slice(0, halfLen)
    const tail = totalChars > halfLen ? finalText.slice(-halfLen) : ''
    preview = head.length + tail.length < totalChars
      ? `${head}\n...\n${tail}`
      : finalText
  }

  // 完整输出写入结果目录。
  //
  // 为什么不写 os.tmpdir()：macOS 会定期清理 `/var/folders/**/T`，重启即丢；而这里存的是
  // **全文唯一一份**（落盘的 `{dataDir}/tasks/<taskId>.json` 只存摘要）⇒ 丢了再也找不回来。
  // 所以优先落 `{dataDir}/subagent-results/`（与会话/任务记录同域、不被系统清理、
  // 也不污染用户仓库 cwd）；dataDir 不可用时才退化为 OS 临时目录。
  const outputPath = writeResultFile(finalText, 'output', resultsDir)

  // 智能提示：只说**当前真的成立**的事实。
  //
  // 历史教训：这里曾按「调用方有没有 read_file」拼提示，但 `callerToolIds` 全仓没有写入方
  // （core 从未把 ctx.variables.callerToolIds 填上，只有测试手动塞）⇒ 实际永远走 else 分支，
  // 而 else 分支写的是「请考虑拆分任务」——把「报告超了 2000 字符阈值」误报成「任务太大」。
  // 现在两个判据缺一不可：**调用方真有 read_file/grep_file** 且 **路径确实在工作目录内**，
  // 否则不许承诺能读（承诺了模型必然去试，试必然失败）。
  const hasReadFile = callerToolIds?.includes('read_file') ?? false
  const hasGrepFile = callerToolIds?.includes('grep_file') ?? false
  const hasSubagent = callerToolIds?.includes('subagent') ?? false
  const insideCwd = isInsideDir(outputPath, callerCwd)
  const sizeNote = `（共 ${totalLines} 行 / ${totalChars} 字符）`
  const nextStep = hasSubagent
    ? '如需其中内容，请改派一个更窄的子任务（只取其中需要的部分），不要整篇重读。'
    : '如需其中内容，请缩小派工范围后重试。'
  // 三种情形分别有各自**为真**的说法，不含任何猜测：
  // ① 读得到（有读文件工具 + 路径在工作目录内）⇒ 才敢承诺可读；
  // ② 路径在工作目录内但本次派工方没有读文件工具 ⇒ 只报事实 + 给下一步，不猜它有什么工具；
  // ③ 路径在工作目录之外 ⇒ 明确说明 read_file/grep_file **读不到**（否则模型必去试、试必失败）。
  const location = (hasReadFile || hasGrepFile) && insideCwd
    ? `可使用 read_file 或 grep_file 工具查看。${hasSubagent ? ' 或再次调用 subagent 工具委派 explore agent 处理。' : ''}`
    : insideCwd
      ? nextStep
      : `该路径不在工作目录内，read_file 与 grep_file 读不到它。${nextStep}`
  const hint = `完整输出已保存至：${outputPath}${sizeNote}。${location}`

  // 构建摘要
  const out: string[] = [preview]

  if (toolCalls.length > 0) {
    out.push('')
    out.push(`[工具调用摘要（${toolCalls.length} 次）]`)
    for (const tc of toolCalls) {
      const errFlag = tc.isError ? ' [错误]' : ''
      const inputPart = tc.inputPreview ? `: ${tc.inputPreview}` : ''
      out.push(`- ${tc.toolId}${inputPart}${errFlag}`)
    }
  }

  out.push('')
  out.push(`[完整回复 ${totalLines} 行 / ${totalChars} 字符已截断为摘要]`)
  out.push(hint)

  return { text: out.join('\n'), summarized: true, outputPath }
}

// ===== SubagentTool（AgentTool）=====

/**
 * 创建 SubagentTool
 *
 * @param getHarness 获取 Harness 引用的函数（插件在 core.harness.start 时缓存）
 * @param timeoutMs 执行超时
 * @param cleanupSession 完成后是否删除子 session
 * @param maxResultLength 返回给父 Agent 的最大结果长度（字符），超过则生成摘要。缺省 8000
 * @param maxResultLines 返回给父 Agent 的最大结果行数，超过则生成摘要。缺省 500
 * @param directive 注入子 Agent 的结构化输出指令（类似 Claude Code 的 fork directive），
 *                  要求子 Agent 简洁结构化回复；不传则不注入
 */
/** createSubagentTool 可选的 worktree 隔离依赖（由插件在 core.harness.start 时注入） */
export interface WorktreeHooks {
  /** 解析/创建子 Agent 隔离 worktree 目录（未启用返回 undefined） */
  resolve: (existingCwd?: string) => Promise<string | undefined>
  /** 把 worktree diff 摘要并入结果文本，返回完整 patch 文件路径 */
  attachDiff: (
    result: Readonly<{ text: string }>,
    worktreeDir: string | undefined,
  ) => Promise<{ text: string; diffPath?: string }>
}

/** 创建 SubagentTool（导出便于单独使用或测试） */
export function createSubagentTool(
  getHarness: () => HarnessLike | undefined,
  timeoutMs: number,
  cleanupSession: boolean,
  maxResultLength: number = DEFAULT_MAX_RESULT_LENGTH,
  maxResultLines: number = 500,
  directive?: string,
  getRegistry?: () => BackgroundTaskRegistry | undefined,
  worktree?: WorktreeHooks,
  subagentMaxSteps: number = DEFAULT_SUBAGENT_MAX_STEPS,
  /** 后台任务结果落盘目录（{dataDir}/tasks）；取不到时退化为不落盘（记 warn，不抛错） */
  getTasksDir?: () => string | undefined,
): Tool<SubagentToolInput, SubagentToolOutput> {
  /**
   * 本次子 Agent 执行的步数上限，优先级（高 → 低）：
   * **派工方传入的 `input.maxSteps` > 子 Agent 自己的 `AgentDefinition.maxSteps` > 插件配置**。
   *
   * 为什么要有最上面那层：`AgentDefinition.maxSteps` 是**固定**的，而同一个 reader 既可能被派去
   * 「看一眼某个文件」（5 步够），也可能被派去「通读 1902 个文件回报事实」（20 步不够）。真机实测
   * 会话 `s_1789996799007_9cq9r`：6 个 reader 因 20 步上限**全部截断**，逼出第二轮补派
   * （额外 41 次 LLM 调用 / 133 万 input token）。派工方比 agent 定义更清楚本次任务有多大，
   * 所以把这一层交给调用方。
   *
   * 非法覆盖值（`0` / 负数 / `NaN` —— 模型在 `subagent({ maxSteps })` 里填错时的典型形态）
   * **不参与优先级**：`0 ?? x` 不会跳过 `0`，透传下去会被引擎判为「未指定」而回落，
   * 若按老逻辑钳成 1 步，子 Agent 会一步就收尾 —— 现象像「任务太小」，与「入参写错」完全对不上。
   * 这里直接忽略并告警，按下一优先级取值。
   */
  const resolveSteps = (agentId: string, override?: number, warn?: (msg: string) => void): number => {
    // `-1` = 不限（透传给引擎转 Infinity），`>= 1` 的有限数才作数
    const valid = (v: number | undefined): number | undefined =>
      v === undefined || v === -1 || (Number.isFinite(v) && v >= 1) ? v : undefined
    if (override !== undefined && valid(override) === undefined) {
      warn?.(
        `subagent 入参 maxSteps=${JSON.stringify(override)} 无效（应为 -1 = 不限，或 >= 1 的整数）：`
        + '已忽略该项，按子 Agent 定义 / 插件默认执行。',
      )
    }
    // 子 Agent 定义侧同样过滤：程序化注册（非 md 解析）时可能塞进非法值
    return valid(override) ?? valid(getHarness()?.agent.get(agentId)?.maxSteps) ?? subagentMaxSteps
  }

  /**
   * 完整输出的落盘目录 = `{dataDir}/subagent-results`（与 `{dataDir}/tasks` 同域）。
   *
   * 为什么与 tasks 同域而不是落 cwd：本插件已有约定「任务落盘统一写到 {dataDir}，避免污染
   * 用户仓库 cwd」（见 install 里的注释）。全文是结果的一部分，理应同域共存。
   * getTasksDir 不可用（缺 dataDir）⇒ 返回 undefined，writeResultFile 退化到 OS 临时目录。
   */
  const resolveResultsDir = (): string | undefined => {
    const tasksDir = getTasksDir?.()
    return tasksDir ? join(dirname(tasksDir), SUBAGENT_RESULTS_DIRNAME) : undefined
  }

  return defineTool<SubagentToolInput, SubagentToolOutput>({
    id: 'subagent',
    aliases: ['agent', 'run_agent', 'task'],
    description: subagentToolDescription.trim(),
    documentation: subagentToolDocumentation.trim(),
    searchHint: 'subagent agent task delegate spawn worker background async',

    // Fail-Closed 安全声明
    isReadOnly: () => false,          // 子 Agent 可能执行写操作
    // 子 Agent 可能修改共享状态（如文件），即使 runInBackground=true 也保持串行调度。
    // 后台并行性由 runInBackground 机制保证（异步执行块），不依赖 partitionToolCalls。
    // 多个写操作 Agent 操作同一文件的冲突由 agent 配置/worktree 隔离负责。
    isConcurrencySafe: () => false,
    isDestructive: () => false,       // 工具本身不破坏，但子 Agent 内部可能
    requiresUserInteraction: false,

    inputSchema: withJsonSchema(makeSchema<SubagentToolInput>(), {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '子 Agent ID（必须已注册且 mode === subagent）' },
        prompt: { type: 'string', description: '派给子 Agent 的任务描述（要自包含：目标、上下文、验收标准）' },
        description: { type: 'string', description: '3-5 词简短描述（用于 UI 展示与调用日志，可选）' },
        model: {
          type: 'object',
          description: '模型覆盖（优先级高于子 Agent 定义，可选）',
          properties: {
            providerId: { type: 'string' },
            modelId: { type: 'string' },
            temperature: { type: 'number' },
          },
        },
        sessionId: { type: 'string', description: '续接已有子 session（多轮子 Agent 对话）；不传则新建' },
        runInBackground: { type: 'boolean', description: 'true = 后台运行，立即返回 taskId，结果经 task-notification 推送；默认同步等待完成' },
        maxSteps: { type: 'number', description: '本次子任务的步数上限（可选）。合法值：>= 1 的整数，或 -1 表示不限；填 0 / 负数会被忽略（按子 Agent 定义、再退插件默认）。不传则用子 Agent 定义的 maxSteps，再退插件默认。通读/遍历类任务请显式给足（如 35）' },
        targetFiles: { type: 'array', items: { type: 'string' }, description: '该 worker 预计写入的文件/目录（项目相对路径）。调度元数据：写操作按文件集串行化' },
      },
      required: ['agentId', 'prompt'],
      additionalProperties: false,
    }),

    permission: {
      key: 'agent',
      extractPatterns: (input) => [input.agentId],
    },

    async call(input: SubagentToolInput, ctx: ToolContext): Promise<ToolResult<SubagentToolOutput>> {
      const startTime = Date.now()
      const harness = getHarness()
      const bus = harness?.bus

      /** 发布 failed 事件（封装避免重复代码） */
      const publishFailed = (code: string, message: string, agentId?: string, subSessionId?: string) => {
        if (!bus) return
        bus.publish(SubagentEvents.failed, {
          agentId,
          subSessionId,
          parentSessionId: ctx.sessionId,
          toolUseId: ctx.toolUseId,
          code,
          message,
          durationMs: Date.now() - startTime,
        }).catch(() => { /* Bus 发布失败不影响主流程 */ })
      }

      if (!harness || !harness.agent || !harness.session) {
        publishFailed('HARNESS_NOT_READY', 'Harness 未就绪（core.harness.start 未触发或 agent/session 缺失）')
        return {
          ok: false,
          error: { message: 'Harness 未就绪（core.harness.start 未触发）', code: 'HARNESS_NOT_READY' },
        }
      }

      const { agent, session } = harness

      // 验证子 Agent 已注册
      const agentDef = agent.get(input.agentId)
      if (!agentDef) {
        publishFailed('AGENT_NOT_FOUND', `子 Agent "${input.agentId}" 未注册`, input.agentId)
        return {
          ok: false,
          error: { message: `子 Agent "${input.agentId}" 未注册`, code: 'AGENT_NOT_FOUND' },
        }
      }

      // 验证 mode === 'subagent'（防止派出 primary/coordinator 自身）
      if (agentDef.mode !== 'subagent') {
        publishFailed('INVALID_AGENT_MODE', `Agent "${input.agentId}" 的 mode 是 "${agentDef.mode}"`, input.agentId)
        return {
          ok: false,
          error: {
            message: `Agent "${input.agentId}" 的 mode 是 "${agentDef.mode}"，不是 "subagent"`,
            code: 'INVALID_AGENT_MODE',
          },
        }
      }

      // 基于 caller.permission 验证调用权限（元信息层友好错误码）
      // 注意：ToolPipeline 已通过 PermissionEngine.check() 做了权限检查，
      // 这里是元信息层的二次验证，提供更友好的错误码和 Bus 事件
      const callerAgent = ctx.agentId ? agent.get(ctx.agentId) : undefined
      if (callerAgent && isAgentDenied(input.agentId, callerAgent.permission)) {
        publishFailed(
          'PERMISSION_DENIED',
          `Agent "${ctx.agentId}" 无权调用子 Agent "${input.agentId}"（被 permission.agent.deny 拒绝）`,
          input.agentId,
        )
        return {
          ok: false,
          error: {
            message: `无权调用子 Agent "${input.agentId}"（被父 Agent permission 配置拒绝）`,
            code: 'PERMISSION_DENIED',
          },
        }
      }

      // 子 session：input.sessionId 有值则续接（多轮子 Agent 对话），无值则创建新 session
      let subSessionId: string
      let isContinuation = false
      if (input.sessionId) {
        // 续接已有子 session
        const existing = await session.get(input.sessionId)
        if (!existing) {
          publishFailed('SESSION_NOT_FOUND', `子 session "${input.sessionId}" 不存在`, input.agentId, input.sessionId)
          return {
            ok: false,
            error: { message: `子 session "${input.sessionId}" 不存在`, code: 'SESSION_NOT_FOUND' },
          }
        }
        subSessionId = input.sessionId
        isContinuation = true
        // 续接：若非隔离 worktree 目录则保持该 session 原执行目录（不强行迁移）
        await worktree?.resolve(existing.cwd)
      } else {
        // 创建新子 session（隔离上下文，关联父 session 便于审计追溯）
        try {
          const title = input.description
            ?? (input.prompt.length > 60 ? input.prompt.slice(0, 60) + '...' : input.prompt)
          const wcwd = await worktree?.resolve(undefined)
          const subSession = await session.create({
            title,
            parentId: ctx.sessionId,
            cwd: wcwd,
            meta: wcwd ? { worktreeDir: wcwd } : undefined,
          })
          subSessionId = subSession.id
        } catch (err) {
          publishFailed('SESSION_CREATE_FAILED', `创建子 session 失败：${(err as Error)?.message ?? err}`, input.agentId)
          return {
            ok: false,
            error: {
              message: `创建子 session 失败：${(err as Error)?.message ?? err}`,
              code: 'SESSION_CREATE_FAILED',
            },
          }
        }
      }

      // ===== 后台模式分流（runInBackground=true 或 Agent 定义 background=true）=====
      // 参考 Claude Code fork subagent 的 task-notification 模型：
      // 工具立即返回 taskId 和 "Background task started" 提示，子 Agent 在后台异步执行。
      // 执行完成后通过 Bus 事件 + enqueueNotification 自动通知父 Agent（task_status 工具已移除）。
      const shouldRunInBackground = input.runInBackground === true || agentDef.background === true
      const registry = getRegistry?.()
      if (shouldRunInBackground && registry) {
        // 1. 注册后台任务，获取 taskId
        const taskId = registry.register({
          agentId: input.agentId,
          agentName: agentDef.name,
          subSessionId,
          parentSessionId: ctx.sessionId,
          parentAgentId: ctx.agentId,
          prompt: input.prompt,
          description: input.description,
        })
        const controller = new AbortController()
        // 把 controller 存到 task 上，便于后续 cancel()
        const task = registry.get(taskId)
        if (task) task.controller = controller
        registry.start(taskId)

        // 2. 发布 started 事件（带 taskId）
        if (bus) {
          bus.publish(SubagentEvents.started, {
            agentId: input.agentId,
            agentName: agentDef.name,
            subSessionId,
            parentSessionId: ctx.sessionId,
            parentAgentId: ctx.agentId,
            parentMessageId: ctx.messageId,
            toolUseId: ctx.toolUseId,
            prompt: input.prompt.length > 500 ? input.prompt.slice(0, 500) + '...' : input.prompt,
            description: input.description,
            isContinuation,
            startedAt: startTime,
            taskId,
            background: true,
          }).catch(() => { /* Bus 发布失败不影响主流程 */ })
        }

        // 3. 异步执行子 Agent（不 await，fire-and-forget）
        //    执行完成后更新 task 状态 + publish completed/failed 事件
        //    使用 queryStream：遍历工具调用事件，实时发布 subagent.progress（P1-5）
        const effectivePromptBg = directive ? `${directive}\n\n${input.prompt}` : input.prompt
        const timerBg = setTimeout(() => controller.abort(), timeoutMs)
        void (async () => {
          try {
            const timeoutPromise = new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error(`后台子 Agent 执行超时（${timeoutMs}ms）`))
              })
            })

            // 进度发布辅助（工具调用开始/完成/失败 → subagent.progress 事件）
            const publishProgress = (
              toolStatus: 'running' | 'completed' | 'failed',
              toolUseId: string,
              toolName: string,
              summary: string,
            ) => {
              if (!bus) return
              bus.publish(SubagentEvents.progress, {
                taskId,
                agentId: input.agentId,
                parentSessionId: ctx.sessionId,
                toolUseId,
                toolName,
                toolStatus,
                summary,
                timestamp: Date.now(),
              }).catch(() => { /* Bus 发布失败不影响主流程 */ })
            }

            // 遍历 queryStream：yield tool_call_start / tool_call_result / done
            const execPromise = (async () => {
              let finalMessage: Message | undefined
              const stream = agent.queryStream({
                sessionId: subSessionId,
                agentId: input.agentId,
                message: effectivePromptBg,
                model: input.model,
                // 把超时信号真正传进去：否则 Promise.race 只是"上层放弃等待"，
                // 底层 queryStream 仍在后台跑（内部循环上线后一次可能几十步，
                // 白烧 token 并继续产生工具副作用）。S3 打通 signal 后这条链才闭环。
                signal: controller.signal,
                // 子 Agent 步数上限比主 Agent 保守（缺省 20）：它的任务是聚焦执行，
                // 步数越多越容易撞上 timeoutMs 被判超时。
                maxSteps: resolveSteps(input.agentId, input.maxSteps),
              })
              for await (const ev of stream) {
                if (ev.type === 'tool_call_start') {
                  const detail = summarizeToolInput(ev.toolId ?? '', ev.input)
                  publishProgress('running', ev.toolUseId ?? '', ev.toolId ?? '', detail)
                } else if (ev.type === 'tool_call_result') {
                  const preview = typeof ev.result === 'string'
                    ? ev.result.slice(0, 120)
                    : JSON.stringify(ev.result ?? '').slice(0, 120)
                  publishProgress(
                    ev.isError ? 'failed' : 'completed',
                    ev.toolUseId ?? '',
                    ev.toolId ?? '',
                    preview || (ev.isError ? '执行失败' : '完成'),
                  )
                } else if (ev.type === 'done') {
                  finalMessage = ev.message
                }
              }
              return finalMessage
            })()
            const finalMessage = await Promise.race([execPromise, timeoutPromise])

            // 提取结果 + 生成摘要
            const subSession = await session.get(subSessionId)
            const messages = subSession?.messages ?? (finalMessage ? [finalMessage] : [])
            const finalText = extractFinalAssistantText(messages) || '(子 Agent 无文本回复)'
            const toolCallCount = countToolCalls(messages)
            const { text: resultText, summarized, outputPath } = summarizeResult(
              messages,
              finalText,
              maxResultLength,
              maxResultLines,
              // 后台路径拿不到父轮的活跃工具表（ctx.variables 不跨轮），按「不可读」如实提示
              undefined,
              resolveResultsDir(),
              // 用调用方的 ctx.cwd：决定 read_file 边界的是**它**，不是 harness 全局 cwd
              ctx.cwd,
            )
            // 附加 worktree diff 摘要 + 完整 patch（会话级隔离目录）
            const { text: resultTextBg, diffPath } = await (
              worktree?.attachDiff({ text: resultText }, subSession?.cwd)
              ?? Promise.resolve<{ text: string; diffPath?: string }>({ text: resultText })
            )

            // 更新 task 为 completed
            registry.complete(taskId, {
              result: resultTextBg,
              summarized,
              messageCount: messages.length,
              toolCallCount,
              outputPath,
              diffPath,
              durationMs: Date.now() - startTime,
            })

            // 落盘（无论通知是否可达，结果都持久化到可回看位置，防止父会话已结束时结果丢失）
            await persistTaskRecord(getTasksDir?.(), registry.get(taskId))

            // publish completed 事件（带 taskId）
            if (bus) {
              bus.publish(SubagentEvents.completed, {
                agentId: input.agentId,
                subSessionId,
                parentSessionId: ctx.sessionId,
                toolUseId: ctx.toolUseId,
                replyPreview: resultTextBg.length > 200 ? resultTextBg.slice(0, 200) + '...' : resultTextBg,
                messageCount: messages.length,
                durationMs: Date.now() - startTime,
                taskId,
                background: true,
              }).catch(() => { /* ignore */ })
            }

            // 自动向父 session 注入 task-notification 通知（去重）
            // 若结果已通过本地续跑通道（send_message）取回，则降级为简短提示，避免重复注入全文
            const task = registry.get(taskId)
            if (task && !task.notified) {
              task.notified = true
              const notification = task.resultFetched
                ? formatTaskNotificationBrief({ taskId, status: 'completed', agentName: input.agentId, description: input.description })
                : formatTaskNotification({
                    taskId,
                    status: 'completed',
                    agentName: input.agentId,
                    description: input.description,
                    result: resultTextBg,
                    outputPath,
                    diffPath,
                    durationMs: Date.now() - startTime,
                    messageCount: messages.length,
                    toolCallCount,
                  })
              try {
                session.enqueueNotification(ctx.sessionId, notification)
              } catch {
                // 父会话不可用/不可写：结果已落盘，忽略投递异常，不向上抛
              }
            }
          } catch (err) {
            const errMsg = `后台子 Agent 执行失败：${(err as Error)?.message ?? err}`
            const failDurationMs = Date.now() - startTime
            // 更新 task 为 failed
            registry.fail(taskId, {
              code: 'SUBAGENT_FAILED',
              message: errMsg,
              durationMs: failDurationMs,
            })

            // 落盘（失败结果同样持久化，防止父会话已结束时错误上下文丢失）
            await persistTaskRecord(getTasksDir?.(), registry.get(taskId))

            // publish failed 事件（带 taskId）
            if (bus) {
              bus.publish(SubagentEvents.failed, {
                agentId: input.agentId,
                subSessionId,
                parentSessionId: ctx.sessionId,
                toolUseId: ctx.toolUseId,
                code: 'SUBAGENT_FAILED',
                message: errMsg,
                durationMs: failDurationMs,
                taskId,
                background: true,
              }).catch(() => { /* ignore */ })
            }

            // 自动向父 session 注入 task-notification 通知（去重）
            // 若结果已通过本地续跑通道（send_message）取回，则降级为简短提示，避免重复注入全文
            const task = registry.get(taskId)
            if (task && !task.notified) {
              task.notified = true
              const notification = task.resultFetched
                ? formatTaskNotificationBrief({ taskId, status: 'failed', agentName: input.agentId, description: input.description })
                : formatTaskNotification({
                    taskId,
                    status: 'failed',
                    agentName: input.agentId,
                    description: input.description,
                    error: errMsg,
                    durationMs: failDurationMs,
                  })
              try {
                session.enqueueNotification(ctx.sessionId, notification)
              } catch {
                // 父会话不可用/不可写：结果已落盘，忽略投递异常，不向上抛
              }
            }
          } finally {
            clearTimeout(timerBg)
          }
        })()

        // 4. 立即返回 taskId（不等待子 Agent 完成）
        return {
          ok: true,
          output: {
            sessionId: subSessionId,
            taskId,
            background: true,
            message: `后台任务已启动（taskId: ${taskId}）。子 Agent 在后台异步执行，执行完成后自动向本会话注入 <task-notification> 通知，无需主动查询。`,
            messageCount: 0,
            summarized: false,
            toolCallCount: 0,
          },
        }
      }

      // ===== 同步模式（默认）=====
      // 发布 subagent.started 事件
      if (bus) {
        bus.publish(SubagentEvents.started, {
          agentId: input.agentId,
          agentName: agentDef.name,
          subSessionId,
          parentSessionId: ctx.sessionId,
          parentAgentId: ctx.agentId,
          parentMessageId: ctx.messageId,
          toolUseId: ctx.toolUseId,
          prompt: input.prompt.length > 500 ? input.prompt.slice(0, 500) + '...' : input.prompt,
          description: input.description,
          isContinuation,
          startedAt: startTime,
        }).catch(() => { /* Bus 发布失败不影响主流程 */ })
      }

      // 带超时调用 agent.query（传入 model 覆盖 + directive 前置注入）
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      // directive 注入：将 directive 前置到 prompt（参考 Claude Code forkSubagent.ts 的 buildChildMessage）
      // directive 用于约束子 Agent 的输出格式（如 Scope/Result/Key files/Files changed）
      const effectivePrompt = directive ? `${directive}\n\n${input.prompt}` : input.prompt

      try {
        // signal 现在能真正透传（S3 打通了 core 的 tool/请求中断链）。
        // 早先 query 不接受 signal，只能用 Promise.race 模拟超时 —— 那样超时后
        // 底层仍在后台继续跑（内部循环上线后一次可能几十步），白白消耗 token 与工具副作用。
        const queryPromise = agent.query({
          sessionId: subSessionId,
          agentId: input.agentId,
          message: effectivePrompt,
          model: input.model,
          signal: controller.signal,
          // 同上：子 Agent 用更保守的步数上限
          maxSteps: resolveSteps(input.agentId, input.maxSteps, (m) => ctx.log?.warn?.(m)),
        })

        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error(`子 Agent 执行超时（${timeoutMs}ms）`))
          })
        })

        let finalMessage: Message
        try {
          finalMessage = await Promise.race([queryPromise, timeoutPromise])
        } catch (err) {
          const errMsg = `子 Agent 执行失败：${(err as Error)?.message ?? err}`
          publishFailed('SUBAGENT_FAILED', errMsg, input.agentId, subSessionId)
          return {
            ok: false,
            error: {
              message: errMsg,
              code: 'SUBAGENT_FAILED',
            },
          }
        }

        // 取子 session 的所有消息，提取最终 assistant 文本
        const subSession = await session.get(subSessionId)
        const messages = subSession?.messages ?? [finalMessage]
        const finalText = extractFinalAssistantText(messages) || '(子 Agent 无文本回复)'
        const toolCallCount = countToolCalls(messages)

        // 超长结果生成摘要，避免上下文膨胀
        // 从 ctx.variables 中读取 callerToolIds（由 core 注入：本轮该 Agent 实际可用的工具 id）
        const callerToolIds = Array.isArray(ctx.variables?.callerToolIds)
          ? ctx.variables.callerToolIds as string[]
          : undefined
        const { text: resultText, summarized, outputPath } = summarizeResult(
          messages,
          finalText,
          maxResultLength,
          maxResultLines,
          callerToolIds,
          resolveResultsDir(),
          // 用调用方的 ctx.cwd：决定 read_file 边界的是**它**，不是 harness 全局 cwd
          ctx.cwd,
        )

        // 附加 worktree 相对基线 HEAD 的 diff 摘要（会话级隔离目录）+ 完整 patch 路径
        const { text: finalResultText, diffPath } = await (
          worktree?.attachDiff({ text: resultText }, subSession?.cwd)
          ?? Promise.resolve<{ text: string; diffPath?: string }>({ text: resultText })
        )

        // 发布 subagent.completed 事件
        if (bus) {
          bus.publish(SubagentEvents.completed, {
            agentId: input.agentId,
            subSessionId,
            parentSessionId: ctx.sessionId,
            toolUseId: ctx.toolUseId,
            replyPreview: finalResultText.length > 200 ? finalResultText.slice(0, 200) + '...' : finalResultText,
            messageCount: messages.length,
            durationMs: Date.now() - startTime,
          }).catch(() => { /* Bus 发布失败不影响主流程 */ })
        }

        return {
          ok: true,
          output: {
            sessionId: subSessionId,
            message: finalResultText,
            messageCount: messages.length,
            summarized,
            toolCallCount,
            outputPath,
            diffPath,
          },
        }
      } finally {
        clearTimeout(timer)
        // 可选清理子 session
        if (cleanupSession) {
          try {
            // SessionManager 没有显式 delete，通过 deleteMessage 逐条清理
            // 或保留 session 便于调试（默认行为）
          } catch { /* ignore */ }
        }
      }
    },

    renderUse: (input) => ({
      agentId: input.agentId,
      description: input.description,
      prompt: input.prompt.length > 100 ? input.prompt.slice(0, 100) + '...' : input.prompt,
      model: input.model?.modelId,
      sessionId: input.sessionId,
      runInBackground: input.runInBackground,
    }),
    renderResult: (result) => {
      if (!result.ok || !result.output) return undefined
      return {
        sessionId: result.output.sessionId,
        taskId: result.output.taskId,
        background: result.output.background,
        preview: result.output.message.length > 200
          ? result.output.message.slice(0, 200) + '...'
          : result.output.message,
        summarized: result.output.summarized,
        toolCallCount: result.output.toolCallCount,
        outputPath: result.output.outputPath,
        diffPath: result.output.diffPath,
      }
    },
  })
}

// ===== 插件工厂 =====

/**
 * 创建 Subagent 插件
 *
 * @param options 配置
 * @param options.subagents 启动时注册的子 Agent 定义列表
 * @param options.timeoutMs 子 Agent 执行超时（毫秒），缺省 120_000
 * @param options.cleanupSession 子 Agent 完成后是否删除子 session（缺省 false）
 * @param options.maxResultLength 返回给父 Agent 的最大结果长度（字符），超过则生成摘要。缺省 8000
 * @param options.maxResultLines 返回给父 Agent 的最大结果行数，超过则生成摘要。缺省 500
 * @param options.directive 注入子 Agent 的结构化输出指令（类似 Claude Code 的 fork directive）
 */
/**
 * 渲染「可派工的子 Agent 名单」（roster），注入派工方的 system prompt。
 *
 * 每行只给 `id + 一句话触发条件` —— agent 的 `description` 原文动辄上千字符（还常带 3 个
 * example），全量塞进 prompt 会把刚省下来的工具载荷又吃回去；这里取第一句并截断到 60 字符。
 */
export function renderRoster(list: readonly AgentDefinition[]): string {
  const rows = list.map((a) => `- ${a.id} — ${oneLine(a.description ?? a.name ?? a.id)}`)
  return [
    '## 可派工的子 Agent（subagent 工具的 agentId 只能取下列之一）',
    ...rows,
    '派工判断：能一次问清或一次改完的自己做；需要并行、或跨文件集的大块任务才派。',
  ].join('\n')
}

/** 取简介的第一句并截断（roster 的一行） */
function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const m = flat.match(/^[^。．.!！?？\n]{0,120}/)
  const first = (m?.[0] ?? flat).trim()
  return first.length > max ? first.slice(0, max - 1) + '…' : first
}

export function createSubagentPlugin(options: SubagentPluginOptions = {}): AgentPlugin {
  const {
    subagents = [],
    timeoutMs = 120_000,
    cleanupSession = false,
    maxResultLength = DEFAULT_MAX_RESULT_LENGTH,
    maxResultLines = 500,
    directive,
    maxSteps: subagentMaxSteps = DEFAULT_SUBAGENT_MAX_STEPS,
    injectRoster = true,
  } = options

  let harness: HarnessLike | undefined
  let subagentTool: Tool<SubagentToolInput, SubagentToolOutput>
  /** 后台任务注册表（生命周期与插件实例一致） */
  const registry = new BackgroundTaskRegistry()

  /** git 仓库根（worktree 隔离启用时为非空；null=非 git 回退） */
  let baseCwd: string | null = null
  /** worktree 隔离是否启用（harness.cwd 是 git 仓库时） */
  let worktreeEnabled = false
  /** 用户级 dataDir（来自插件上下文 workspace.dataDir），任务落盘目录 = join(dataDir, 'tasks') */
  let dataDir: string | undefined
  /** 后台任务结果落盘目录（{dataDir}/tasks）；dataDir 不可用时为 undefined → 跳过落盘 */
  let tasksDir: string | undefined

  /**
   * 权威来源：AgentRuntime 注册表里所有 `mode === 'subagent'` 的 Agent。
   *
   * 为什么不能只看本插件的 `subagents` 配置数组：md 定义的子 Agent 经 `agentDirs`
   * 被 core 直接注册进 AgentRuntime，**不经过本插件**。只列插件数组会漏掉它们，
   * 让人误以为「只有配在插件里的那一个能调用」。
   *
   * 口径必须与 subagent 工具一致 —— 工具是用 `agent.get(agentId)` + `mode` 校验
   * 解析目标的（见 createSubagentTool），同样只认注册表、不认插件数组。
   *
   * @returns 注册表里的子 Agent；harness 尚未就绪（如单测未触发 core.harness.start）时
   *          返回 undefined，由调用方回退到插件配置数组。
   */
  const registrySubagents = (): AgentDefinition[] | undefined => {
    const list = harness?.agent?.list?.()
    if (!Array.isArray(list)) return undefined
    return list.filter((a) => a.mode === 'subagent')
  }

  /** 本插件自己配置的子 Agent（用于标注来源 / harness 未就绪时兜底） */
  const ownSubagents = (): AgentDefinition[] => subagents.filter((a) => a.mode === 'subagent')

  /**
   * 为子 Agent 解析/创建隔离 worktree 目录。
   * - 未启用 → undefined。
   * - 续接：existingCwd 已在 worktree 下则复用，否则 undefined（保持原执行目录）。
   * - 新建：createWorktree；失败降级返回 undefined（不影响子 Agent 运行）。
   */
  const resolveWorktree = async (existingCwd?: string): Promise<string | undefined> => {
    if (!worktreeEnabled || !baseCwd) return undefined
    const prefix = join(baseCwd, '.harness', 'worktrees') + '/'
    if (existingCwd) {
      if (existingCwd.startsWith(prefix)) return existingCwd
      return undefined
    }
    try {
      const token = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      return await createWorktree({ base: baseCwd, token })
    } catch (err) {
      console.warn('[subagent] 创建子 Agent worktree 失败，降级为无隔离执行', {
        base: baseCwd,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /**
   * 把 worktree 相对基线 HEAD 的 diff 摘要并入结果文本，并把完整 patch 写入临时文件。
   * 有变更才追加；任何 getWorktreeDiff 失败均返回原样，不中断子 Agent。
   */
  const attachWorktreeDiff = async (
    result: Readonly<{ text: string }>,
    worktreeDir: string | undefined,
  ): Promise<{ text: string; diffPath?: string }> => {
    if (!worktreeEnabled || !baseCwd || !worktreeDir) return { text: result.text }
    let diff: { summary: string; patch: string; hasChanges: boolean }
    try {
      diff = await getWorktreeDiff({ base: baseCwd, dir: worktreeDir })
    } catch {
      return { text: result.text }
    }
    if (!diff.hasChanges || !diff.summary) return { text: result.text }
    // 与完整输出同域落盘（此前写 os.tmpdir()：macOS 会清理，且路径在工作目录外读不到）
    const diffPath = writeResultFile(
      diff.patch,
      'diff',
      dataDir ? join(dataDir, SUBAGENT_RESULTS_DIRNAME) : undefined,
    )
    const text = `${result.text}\n\n## Git Diff 摘要（相对基线 HEAD，目录 ${worktreeDir}）\n${diff.summary}`
    return { text, diffPath }
  }

  return {
    id: 'subagent',
    version: '0.2.0',
    name: 'Subagent',
    description: `Subagent 插件：派出子 Agent 执行独立任务（${subagents.length} 个子 Agent 已注册，支持 runInBackground）`,

    async install(ctx) {
      // 捕获用户级 dataDir（来自插件上下文 workspace.dataDir）与插件 logger。
      // 任务落盘统一写到 {dataDir}/tasks，避免污染用户仓库 cwd（.harness 未被 gitignore）。
      dataDir = (ctx as { workspace?: { dataDir?: string } }).workspace?.dataDir
      pluginLogger = ctx.log

      ctx.log.info('Subagent 插件已加载', {
        subagents: subagents.map((a) => ({ id: a.id, name: a.name, mode: a.mode })),
      })

      // 延迟创建 SubagentTool（需要 harness 引用，在 core.harness.start 时才有）
      subagentTool = createSubagentTool(
        () => harness,
        timeoutMs,
        cleanupSession,
        maxResultLength,
        maxResultLines,
        directive,
        () => registry,
        { resolve: resolveWorktree, attachDiff: attachWorktreeDiff },
        subagentMaxSteps,
        () => tasksDir,
      )


      return {
        async 'core.harness.start'(input) {
          const h = (input as { harness: HarnessLike }).harness
          if (!h?.agent || !h?.session) {
            ctx.log.error('Subagent 插件：core.harness.start 未提供 agent/session 引用')
            return
          }
          harness = h

          // 后台任务结果落盘目录：用户级 {dataDir}/tasks（与会话落盘同层，绝不落到仓库 cwd）。
          // dataDir 不可用则退化为 tasksDir=undefined（跳过落盘 + 记 warn），不回退到 cwd。
          if (dataDir) {
            tasksDir = join(dataDir, 'tasks')
          } else {
            tasksDir = undefined
            pluginLogger?.warn('[subagent] workspace.dataDir 不可用，后台任务结果将不落盘（仅内存注册表可见，防止污染用户仓库）')
          }

          // 订阅"结果已通过本地续跑通道取回"事件：标记对应后台任务，使其完成通知降级为简短提示
          // （bus 解耦：coordinator send_message 取回结果后广播，subagent 不反向依赖 coordinator）
          if (h.bus) {
            h.bus.subscribe(SubagentEvents.resultFetched, ({ payload }) => {
              const t = registry.get(payload.taskId)
              if (t) t.resultFetched = true
            })
          }

          // 检测 git worktree 隔离启用条件：harness 工作目录是 git 仓库
          try {
            baseCwd = h.cwd ? await gitTopLevel(h.cwd) : null
            worktreeEnabled = baseCwd !== null
          } catch {
            baseCwd = null
            worktreeEnabled = false
          }

          // 注册子 Agent 定义到 AgentRuntime
          for (const def of subagents) {
            if (def.mode !== 'subagent') {
              ctx.log.warn(`子 Agent "${def.id}" 的 mode 是 "${def.mode}"，不是 "subagent"，跳过注册`)
              continue
            }
            try {
              h.agent.register(def)
              ctx.log.info(`子 Agent "${def.id}" 已注册`, {
                name: def.name,
                tools: def.tools,
              })
            } catch (err) {
              ctx.log.error(`注册子 Agent "${def.id}" 失败`, { error: String((err as Error)?.message ?? err) })
            }
          }
        },

        'core.tool.pool.assemble'(_input, pool) {
          if (subagentTool) {
            ;(pool as { add: (t: unknown) => void }).add(subagentTool)
          }
        },

        /**
         * 派工 roster 注入：把「可派工的子 Agent 名单」放进派工方的 system prompt。
         *
         * 只给**自己有 subagent 工具**的 Agent 注入 —— 别的 Agent 派不了工，拿到名单是噪音。
         * 每轮重新渲染（不是启动时算一次）：md 定义的子 Agent 可能在运行中注册/热重载。
         */
        'core.prompt.system.transform'(input, parts) {
          if (!injectRoster) return
          if (!harness) return
          const agentId = (input as { agentId?: string } | undefined)?.agentId
          if (!agentId) return
          const def = harness.agent?.get?.(agentId) as { tools?: Array<string> } | undefined
          const tools = def?.tools
          if (!Array.isArray(tools) || !tools.includes('subagent')) return
          const list = registrySubagents() ?? ownSubagents()
          // 排除自己 —— 否则 roster 会把自己列进去，诱导"派给自己"（自派工 = 无深度上限的递归）。
          const targets = list.filter((a) => a.id !== agentId)
          if (targets.length === 0) return
          parts.push(renderRoster(targets))
        },

        'cli.commands'(input) {
          // 注册条件也以注册表为准：插件自己没配、但 md 定义里有子 Agent 时，命令同样可用
          const available = registrySubagents() ?? ownSubagents()
          if (available.length > 0) {
            input.commands.push({
              command: 'subagents',
              description: '列出可调用的子 Agent（读 AgentRuntime 注册表）',
              usage: '/subagents',
            })
          }
          // /tasks 命令：列出后台任务（用户直接在 CLI 查看）
          input.commands.push({
            command: 'tasks',
            description: '列出后台子 Agent 任务（runInBackground=true 派出的任务）',
            usage: '/tasks [running|completed|failed]',
          })
          // /worktrees 命令：管理子 Agent 隔离 worktree（仅 git 仓库启用时）
          if (worktreeEnabled) {
            input.commands.push({
              command: 'worktrees',
              description: '管理子 Agent 隔离 worktree（list | remove <dir> | remove-all），默认保留便于续接/调试',
              usage: '/worktrees [list|remove <dir>|remove-all]',
            })
          }
        },

        async 'cli.command'(input) {
          // ===== /subagents 命令 =====
          if (input.command === 'subagents') {
            // 注册表优先（与 subagent 工具同一口径）；harness 未就绪时回退插件配置数组
            const fromRegistry = registrySubagents()
            const registered = fromRegistry ?? ownSubagents()
            const own = new Set(subagents.map((a) => a.id))
            if (registered.length === 0) {
              input.out('（无已注册的子 Agent）\n')
            } else {
              // 基于 caller.permission 过滤可见子 Agent（参考 OpenCode accessibleAgents 逻辑）
              // 从 sessionId 获取 session，再从 session.agentId 获取父 Agent 定义
              let accessible = registered
              if (harness?.session) {
                try {
                  const session = await harness.session.get(input.sessionId)
                  const callerAgentId = session?.agentId
                  if (callerAgentId && harness.agent) {
                    const callerAgent = harness.agent.get(callerAgentId)
                    if (callerAgent) {
                      accessible = filterAccessibleAgents(registered, callerAgent.permission)
                    }
                  }
                } catch { /* session 不存在或读取失败，列出全部 */ }
              }

              if (accessible.length === 0) {
                input.out('（当前 Agent 无权调用任何子 Agent）\n')
              } else {
                const hiddenCount = registered.length - accessible.length
                const hint = hiddenCount > 0 ? `（${hiddenCount} 个被权限过滤隐藏）` : ''
                input.out(`可调用 ${accessible.length} 个子 Agent${hint}：\n`)
                for (const a of accessible) {
                  const whitelist: string[] = Array.isArray(a.tools) ? (a.tools as string[]) : ['*']
                  // 哨兵白名单（md 未声明 tools 时的只读兜底）解析出实际工具 id ——
                  // 只写「只读工具」四个字，用户仍然不知道它到底能用什么。
                  const resolved = whitelist.includes(READONLY_TOOLS_SENTINEL)
                    ? harness?.tools?.filterByWhitelist(whitelist).map((t) => t.id)
                    : undefined
                  const tools = formatToolWhitelist(whitelist) + (resolved ? ` = ${resolved.join(', ') || '（当前无只读工具）'}` : '')
                  // 标注来源：让「配置在插件里」与「md 定义进来的」一眼可分
                  const origin = fromRegistry ? `  [${own.has(a.id) ? '插件配置' : 'agent 定义'}]` : ''
                  input.out(`  ${a.id}  -  ${a.name}${origin}\n`)
                  input.out(`    描述：${a.description || '（未提供）'}\n`)
                  input.out(`    工具：${tools}\n`)
                  if (a.model?.modelId) input.out(`    模型：${a.model.modelId}\n`)
                }
              }
            }
            input.result = 'continue'
            return
          }

          // ===== /tasks 命令：列出后台子 Agent 任务 =====
          if (input.command === 'tasks') {
            // 解析可选参数：running / completed / failed
            const arg = (input.arg ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
            const statusFilter: BackgroundTaskStatus | undefined =
              arg === 'running' ? 'running'
              : arg === 'completed' ? 'completed'
              : arg === 'failed' ? 'failed'
              : arg === 'pending' ? 'pending'
              : undefined

            const all = registry.list({
              status: statusFilter,
              parentSessionId: input.sessionId,
            })

            if (all.length === 0) {
              const filterHint = statusFilter ? `（${statusFilter}）` : ''
              input.out(`（无后台任务${filterHint}）\n`)
            } else {
              input.out(`后台任务 ${all.length} 个${statusFilter ? `（${statusFilter}）` : ''}：\n`)
              for (const t of all) {
                const ageMs = Date.now() - t.createdAt
                const ageStr = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`
                const statusIcon = t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : t.status === 'running' ? '⏵' : '○'
                input.out(`  ${statusIcon} ${t.taskId}  -  ${t.agentName}（${t.status}, ${ageStr}）\n`)
                if (t.description) input.out(`    描述：${t.description}\n`)
                if (t.result) {
                  const preview = t.result.length > 80 ? t.result.slice(0, 80) + '...' : t.result
                  input.out(`    结果：${preview}\n`)
                }
                if (t.errorMessage) {
                  const preview = t.errorMessage.length > 80 ? t.errorMessage.slice(0, 80) + '...' : t.errorMessage
                  input.out(`    错误：${preview}\n`)
                }
                if (t.durationMs !== undefined) input.out(`    耗时：${t.durationMs}ms\n`)
              }
              input.out('\n')
              input.out('提示：任务完成后系统自动通知父 Agent，无需主动查询。\n')
            }
            input.result = 'continue'
            return
          }

          // ===== /worktrees 命令：管理子 Agent 隔离 worktree =====
          if (input.command === 'worktrees') {
            if (!worktreeEnabled || !baseCwd) {
              input.out('（尚未启用 worktree 隔离：当前工作目录不是 git 仓库）\n')
            } else {
              const arg = (input.arg ?? '').trim()
              if (arg === 'remove-all') {
                const all = await listWorktrees(baseCwd)
                let removed = 0
                for (const wt of all) {
                  if (wt.path !== baseCwd) {
                    try { await removeWorktree({ base: baseCwd, dir: wt.path }); removed += 1 } catch { /* ignore */ }
                  }
                }
                input.out(`已移除 ${removed} 个隔离 worktree（主工作区保留）\n`)
              } else if (arg.startsWith('remove ')) {
                const dir = arg.slice('remove '.length).trim()
                if (!dir) {
                  input.out('用法：/worktrees remove <dir>\n')
                } else {
                  try {
                    await removeWorktree({ base: baseCwd, dir })
                    input.out(`已移除 worktree：${dir}\n`)
                  } catch {
                    input.out(`移除失败：${dir}（可能不存在或正在使用）\n`)
                  }
                }
              } else {
                const all = await listWorktrees(baseCwd)
                input.out(`Worktrees（共 ${all.length} 个）：\n`)
                for (const wt of all) {
                  const marker = wt.path === baseCwd ? '（主工作区）' : ''
                  input.out(`  ${wt.path}${marker}  HEAD=${(wt.head ?? '').slice(0, 12)}\n`)
                }
                if (all.length > 1) {
                  input.out('\n提示：子 Agent 隔离 worktree 默认保留（便于续接/调试）。\n')
                  input.out('可用 /worktrees remove <dir> 或 /worktrees remove-all 回收。\n')
                }
              }
            }
            input.result = 'continue'
            return
          }
        },
      } as Hooks
    },

    async uninstall() {
      harness = undefined
    },
  }
}

// ===== BackgroundTaskRegistry（后台任务注册表）=====

/**
 * 格式化 task-notification 通知消息（注入父 session，供大模型在后续 turn 感知任务完成）。
 * 参考 Claude Code 的 enqueueAgentNotification + `<task-notification>` XML 格式。
 */
export function formatTaskNotification(input: {
  taskId: string
  status: 'completed' | 'failed'
  agentName: string
  description?: string
  result?: string
  error?: string
  outputPath?: string
  diffPath?: string
  durationMs: number
  messageCount?: number
  toolCallCount?: number
}): string {
  const label = input.description || input.agentName
  const summary = input.status === 'completed'
    ? `Agent "${label}" completed`
    : `Agent "${label}" failed: ${input.error ?? 'Unknown error'}`
  const resultSection = input.result ? `\n<result>${input.result}</result>` : ''
  const outputPathSection = input.outputPath
    ? `\n<output-file>${input.outputPath}</output-file>`
    : ''
  const diffPathSection = input.diffPath
    ? `\n<diff-file>${input.diffPath}</diff-file>`
    : ''
  const usageSection = `\n<usage><duration-ms>${input.durationMs}</duration-ms>${
    input.messageCount !== undefined ? `<message-count>${input.messageCount}</message-count>` : ''
  }${
    input.toolCallCount !== undefined ? `<tool-call-count>${input.toolCallCount}</tool-call-count>` : ''
  }</usage>`
  return `<task-notification>
<task-id>${input.taskId}</task-id>
<status>${input.status}</status>
<summary>${summary}</summary>${resultSection}${outputPathSection}${diffPathSection}${usageSection}
</task-notification>`
}

/**
 * 格式化「结果已此前取回」的简短 task-notification 提示。
 * 当后台任务结果已通过本地续跑通道（coordinator send_message）取回时，完成通知降级为此提示，
 * 不再携带结果全文（避免重复注入浪费 token）。
 */
export function formatTaskNotificationBrief(input: {
  taskId: string
  status: 'completed' | 'failed'
  agentName: string
  description?: string
}): string {
  const label = input.description || input.agentName
  const outcome = input.status === 'completed' ? '已完成' : '已失败'
  return `<task-notification>
<task-id>${input.taskId}</task-id>
<status>${input.status}</status>
<summary>后台任务 "${label}" ${outcome}（结果已在此前通过 send_message 返回，不再重复注入）</summary>
</task-notification>`
}

// ===== 后台任务结果落盘（可回看，防止父会话已结束时结果丢失）=====

/** 落盘的后台任务记录（{dataDir}/tasks/<taskId>.json，含 index.jsonl 便于枚举） */
export interface PersistedTaskRecord {
  taskId: string
  status: BackgroundTaskStatus
  agentId: string
  description?: string
  result?: string
  errorCode?: string
  errorMessage?: string
  durationMs?: number
  messageCount?: number
  toolCallCount?: number
  createdAt: number
  finishedAt?: number
}

/** 插件 logger（install 时从插件上下文捕获）；落盘失败时回退用，未就绪则为 undefined */
let pluginLogger: { warn: (msg: string, ...args: unknown[]) => void } | undefined

/**
 * 将后台任务结果落盘到 {tasksDir}/<taskId>.json，并追加一行到 index.jsonl（便于将来 /tasks 枚举）。
 * 全程 best-effort：目录不可用（tasksDir=undefined）或写入失败只记 warn 日志，绝不向上抛异常。
 */
async function persistTaskRecord(tasksDir: string | undefined, task: BackgroundTask | undefined): Promise<void> {
  if (!task) return
  if (tasksDir === undefined) return // 目录不可用：跳过（缺 dataDir 的 warn 已在 core.harness.start 记录）
  const record: PersistedTaskRecord = {
    taskId: task.taskId,
    status: task.status,
    agentId: task.agentId,
    description: task.description,
    result: task.result,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    durationMs: task.durationMs,
    messageCount: task.messageCount,
    toolCallCount: task.toolCallCount,
    createdAt: task.createdAt,
    finishedAt: task.completedAt,
  }
  try {
    await mkdir(tasksDir, { recursive: true })
    await writeFile(join(tasksDir, `${task.taskId}.json`), JSON.stringify(record, null, 2), 'utf-8')
    await appendFile(join(tasksDir, 'index.jsonl'), JSON.stringify(record) + '\n', 'utf-8')
  } catch (err) {
    pluginLogger?.warn('[subagent] 落盘后台任务结果失败', { taskId: task.taskId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * 枚举已落盘的后台任务记录（供 /tasks 命令在父会话已不可用时回看结果）。
 * 读取 {tasksDir}/*.json；任何文件解析失败都跳过，不影响其余。
 */
export async function listPersistedTasks(tasksDir: string): Promise<PersistedTaskRecord[]> {
  try {
    if (!existsSync(tasksDir)) return []
    const out: PersistedTaskRecord[] = []
    for (const f of readdirSync(tasksDir)) {
      if (!f.endsWith('.json')) continue
      try {
        out.push(JSON.parse(readFileSync(join(tasksDir, f), 'utf-8')) as PersistedTaskRecord)
      } catch { /* 跳过损坏文件 */ }
    }
    return out
  } catch {
    return []
  }
}


/**
 * 后台任务状态
 * - pending：已创建但未开始执行
 * - running：正在执行中
 * - completed：成功完成（结果可用）
 * - failed：执行失败
 */
export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

/**
 * 后台任务记录
 */
export interface BackgroundTask {
  /** 任务 ID（唯一） */
  taskId: string
  /** 子 Agent ID */
  agentId: string
  /** 子 Agent 名称 */
  agentName: string
  /** 子 session ID（独立隔离上下文） */
  subSessionId: string
  /** 父 session ID */
  parentSessionId: string
  /** 父 Agent ID */
  parentAgentId?: string
  /** 任务描述 */
  prompt: string
  /** 简短描述 */
  description?: string
  /** 任务状态 */
  status: BackgroundTaskStatus
  /** 创建时间戳 */
  createdAt: number
  /** 开始执行时间戳 */
  startedAt?: number
  /** 完成/失败时间戳 */
  completedAt?: number
  /** 执行耗时（ms，完成/失败后才有） */
  durationMs?: number
  /** 子 Agent 最终回复文本（完成时才有，超过阈值时为摘要） */
  result?: string
  /** 错误码（失败时才有） */
  errorCode?: string
  /** 错误消息（失败时才有） */
  errorMessage?: string
  /** 回复是否被摘要截断 */
  summarized?: boolean
  /** 子 session 消息总数 */
  messageCount?: number
  /** 子 Agent 内部工具调用次数 */
  toolCallCount?: number
  /** 完整输出的临时文件路径 */
  outputPath?: string
  /** 相对基线 HEAD 的完整 diff 补丁临时文件路径（worktree 隔离启用且有改动时有值） */
  diffPath?: string
  /** 用于取消后台任务的 AbortController */
  controller?: AbortController
  /** 完成通知是否已注入父 session（去重，防止重复注入） */
  notified?: boolean
  /** 结果是否已被本地续跑通道（coordinator send_message）取回：取回后完成通知降级为简短提示 */
  resultFetched?: boolean
}

/**
 * 后台任务注册表
 *
 * 管理 runInBackground=true 模式创建的子 Agent 后台任务：
 * - 注册（pending → running）
 * - 查询（get / list）
 * - 等待（wait，可选超时）
 * - 取消（cancel，通过 AbortController.abort 中断 query）
 * - 完成/失败回调（complete / fail）
 *
 * 任务结果保留在内存中，直到显式 clear 或进程退出。
 * 适用于 CLI /tasks 命令展示任务列表。
 */
export class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>()
  private resolvers = new Map<string, Array<(task: BackgroundTask) => void>>()
  private counter = 0

  /**
   * 注册新任务，返回 taskId
   */
  register(input: Omit<BackgroundTask, 'taskId' | 'status' | 'createdAt'>): string {
    this.counter += 1
    const taskId = `task-${Date.now().toString(36)}-${this.counter.toString(36)}`
    const task: BackgroundTask = {
      ...input,
      taskId,
      status: 'pending',
      createdAt: Date.now(),
    }
    this.tasks.set(taskId, task)
    return taskId
  }

  /**
   * 标记任务为 running（开始执行）
   */
  start(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = 'running'
    task.startedAt = Date.now()
  }

  /**
   * 标记任务为 completed，存储结果，触发所有 wait 的 resolver
   */
  complete(taskId: string, result: Partial<Pick<BackgroundTask,
    'result' | 'summarized' | 'messageCount' | 'toolCallCount' | 'outputPath' | 'diffPath' | 'durationMs'
  >>): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = 'completed'
    task.completedAt = Date.now()
    Object.assign(task, result)
    if (!task.durationMs && task.startedAt) {
      task.durationMs = task.completedAt - task.startedAt
    }
    this.notifyResolvers(taskId, task)
  }

  /**
   * 标记任务为 failed，存储错误信息，触发所有 wait 的 resolver
   */
  fail(taskId: string, error: { code: string; message: string; durationMs?: number }): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = 'failed'
    task.completedAt = Date.now()
    task.errorCode = error.code
    task.errorMessage = error.message
    if (error.durationMs !== undefined) {
      task.durationMs = error.durationMs
    } else if (task.startedAt) {
      task.durationMs = task.completedAt - task.startedAt
    }
    this.notifyResolvers(taskId, task)
  }

  /**
   * 查询任务（不等待）
   */
  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 列出所有后台任务（可选过滤状态）
   */
  list(filter?: { status?: BackgroundTaskStatus; parentSessionId?: string }): BackgroundTask[] {
    const all = Array.from(this.tasks.values())
    return all.filter((t) => {
      if (filter?.status && t.status !== filter.status) return false
      if (filter?.parentSessionId && t.parentSessionId !== filter.parentSessionId) return false
      return true
    }).sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 等待任务完成/失败（阻塞直到结果或超时）
   * 已完成/失败的任务立即返回。
   *
   * @param taskId 任务 ID
   * @param timeoutMs 超时（ms），缺省 0 表示无限等待
   * @returns 任务记录，或超时返回 undefined
   */
  async wait(taskId: string, timeoutMs: number = 0): Promise<BackgroundTask | undefined> {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    if (task.status === 'completed' || task.status === 'failed') return task

    return new Promise<BackgroundTask | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // 超时：从 resolvers 中移除当前 resolver，避免内存泄漏
          const arr = this.resolvers.get(taskId) ?? []
          this.resolvers.set(taskId, arr.filter((r) => r !== resolver))
          resolve(undefined)
        }, timeoutMs)
      }

      const resolver = (t: BackgroundTask) => {
        if (timer) clearTimeout(timer)
        resolve(t)
      }
      const arr = this.resolvers.get(taskId) ?? []
      arr.push(resolver)
      this.resolvers.set(taskId, arr)
    })
  }

  /**
   * 取消任务（通过 AbortController 中断 agent.query）
   * 仅 running 状态有效；pending/completed/failed 无效。
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running' || !task.controller) return false
    task.controller.abort()
    return true
  }

  /**
   * 清理已完成/失败的任务（释放内存）
   */
  clear(filter?: { status?: 'completed' | 'failed' }): number {
    const all = Array.from(this.tasks.entries())
    let removed = 0
    for (const [id, t] of all) {
      if (t.status === 'completed' || t.status === 'failed') {
        if (!filter || t.status === filter.status) {
          this.tasks.delete(id)
          this.resolvers.delete(id)
          removed += 1
        }
      }
    }
    return removed
  }

  /** 触发所有 wait 的 resolver */
  private notifyResolvers(taskId: string, task: BackgroundTask): void {
    const arr = this.resolvers.get(taskId) ?? []
    this.resolvers.delete(taskId)
    for (const resolve of arr) resolve(task)
  }
}

// ===== 后台任务展示 Monitor（P1-4 前端事件驱动展示）=====

/** 后台任务展示视图（UI 无关，供 CLI REPL / Web UI 渲染） */
export interface BackgroundTaskView {
  /** 后台任务 ID */
  taskId: string
  /** 子 Agent ID */
  agentId: string
  /** 子 Agent 名称 */
  agentName: string
  /** 父 session ID（任务发起方会话） */
  parentSessionId: string
  /** 父 Agent ID（任务发起方） */
  parentAgentId?: string
  /** 任务描述（完整 prompt） */
  prompt: string
  /** 简短描述（UI 展示用） */
  description?: string
  /** 任务状态 */
  status: 'running' | 'completed' | 'failed'
  /** 开始时间戳 */
  startedAt: number
  /** 结束时间戳（completed/failed 时有值） */
  finishedAt?: number
  /** 执行耗时（ms，completed/failed 时有值） */
  durationMs?: number
  /** 结果预览（completed 时，replyPreview） */
  result?: string
  /** 错误信息（failed 时） */
  error?: { code: string; message: string }
  /** 子 session 消息总数（completed 时） */
  messageCount?: number
  /** 工具调用进度列表（P1-5：最新在前） */
  progress?: BackgroundTaskProgress[]
}

/** 单条工具调用进度（P1-5） */
export interface BackgroundTaskProgress {
  /** 工具调用 ID */
  toolUseId: string
  /** 工具 ID */
  toolName: string
  /** 工具执行状态 */
  toolStatus: 'running' | 'completed' | 'failed'
  /** 进度摘要（工具输入/结果预览） */
  summary: string
  /** 进度时间戳 */
  timestamp: number
}

export interface BackgroundTaskMonitorOptions {
  /** Bus 实例（订阅 subagent.started/completed/failed） */
  bus: Bus
  /** 仅展示这些父 session 派发的任务；不传则展示所有 */
  parentSessionIds?: string[]
  /** 仅展示后台任务（background=true 的事件）；默认 true */
  backgroundOnly?: boolean
}

/** 任务变更订阅回调（每次快照变化时触发） */
export type BackgroundTaskListener = (tasks: readonly BackgroundTaskView[]) => void

/**
 * 后台任务事件驱动 Monitor（P1-4）。
 *
 * 订阅 subagent.started / completed / failed Bus 事件，维护后台任务的
 * 展示状态快照（running → completed/failed），前端（CLI REPL / 未来 Web UI）
 * 通过 subscribe() 自动渲染，无需大模型主动调用查询工具、无需执行 /tasks。
 *
 * UI 无关：只维护状态 + 广播变更，不依赖任何渲染框架。
 *
 * @example
 * const monitor = new BackgroundTaskMonitor({ bus })
 * monitor.subscribe((tasks) => renderPanel(tasks))
 * // 完成后释放
 * monitor.dispose()
 */
export class BackgroundTaskMonitor {
  private readonly tasks = new Map<string, BackgroundTaskView>()
  private readonly listeners = new Set<BackgroundTaskListener>()
  private readonly unsubscribers: Array<() => void> = []
  private readonly backgroundOnly: boolean
  private readonly parentSessionIds?: string[]

  constructor(options: BackgroundTaskMonitorOptions) {
    this.backgroundOnly = options.backgroundOnly ?? true
    this.parentSessionIds = options.parentSessionIds
    const { bus } = options
    const interested = (parentSessionId: string) =>
      !this.parentSessionIds || this.parentSessionIds.length === 0
      || this.parentSessionIds.includes(parentSessionId)

    this.unsubscribers.push(
      bus.subscribe(SubagentEvents.started, ({ payload }) => {
        if (!this.accept(payload.background)) return
        if (!interested(payload.parentSessionId)) return
        if (!payload.taskId) return
        this.tasks.set(payload.taskId, {
          taskId: payload.taskId,
          agentId: payload.agentId,
          agentName: payload.agentName,
          parentSessionId: payload.parentSessionId,
          parentAgentId: payload.parentAgentId,
          prompt: payload.prompt,
          description: payload.description,
          status: 'running',
          startedAt: payload.startedAt,
        })
        this.emit()
      }),
      bus.subscribe(SubagentEvents.completed, ({ payload }) => {
        if (!this.accept(payload.background)) return
        if (!interested(payload.parentSessionId)) return
        if (!payload.taskId) return
        const t = this.tasks.get(payload.taskId)
        if (!t) return
        t.status = 'completed'
        t.finishedAt = Date.now()
        t.durationMs = payload.durationMs
        t.result = payload.replyPreview
        t.messageCount = payload.messageCount
        this.emit()
      }),
      bus.subscribe(SubagentEvents.failed, ({ payload }) => {
        if (!this.accept(payload.background)) return
        if (!interested(payload.parentSessionId)) return
        if (!payload.taskId) return
        const t = this.tasks.get(payload.taskId)
        if (!t) return
        t.status = 'failed'
        t.finishedAt = Date.now()
        t.durationMs = payload.durationMs
        t.error = { code: payload.code, message: payload.message }
        this.emit()
      }),
      // P1-5：工具调用进度 → 追加到对应任务（最新在前）
      bus.subscribe(SubagentEvents.progress, ({ payload }) => {
        if (!interested(payload.parentSessionId)) return
        const t = this.tasks.get(payload.taskId)
        if (!t) return
        const entry: BackgroundTaskProgress = {
          toolUseId: payload.toolUseId,
          toolName: payload.toolName,
          toolStatus: payload.toolStatus,
          summary: payload.summary,
          timestamp: payload.timestamp,
        }
        // 同一 toolUseId 的旧条目（running）被新条目（completed/failed）覆盖
        const others = (t.progress ?? []).filter((p) => p.toolUseId !== entry.toolUseId)
        t.progress = [entry, ...others]
        this.emit()
      }),
    )
  }

  /** 是否纳入展示（后台任务过滤） */
  private accept(background?: boolean): boolean {
    if (!this.backgroundOnly) return true
    return background === true
  }

  /** 当前任务快照（按开始时间升序） */
  getTasks(): readonly BackgroundTaskView[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 获取单个任务视图 */
  get(taskId: string): BackgroundTaskView | undefined {
    return this.tasks.get(taskId)
  }

  /** 订阅任务快照变更（返回取消订阅函数） */
  subscribe(listener: BackgroundTaskListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 取消全部 Bus 订阅并清空监听器 */
  dispose(): void {
    for (const off of this.unsubscribers) off()
    this.unsubscribers.length = 0
    this.listeners.clear()
  }

  private emit(): void {
    const snapshot = this.getTasks()
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch { /* 单个监听器错误不影响其他 */ }
    }
  }
}

/** 创建后台任务 Monitor（便捷工厂） */
export function createBackgroundTaskMonitor(options: BackgroundTaskMonitorOptions): BackgroundTaskMonitor {
  return new BackgroundTaskMonitor(options)
}



// ===== 便捷导出 =====

/** 默认导出（无子 Agent 配置，需要通过 core.harness.start 后外部注册） */
export const subagentPlugin = createSubagentPlugin()

// ===== 运行时能力（抽象层契约）=====
// cli 等宿主只经 @harness/plugin 的 SubagentCapability 抽象接口交互，不依赖具体实现类型。

/** subagent 插件能力：创建后台任务监控器（实现 @harness/plugin.SubagentCapability） */
export const subagentCapability: SubagentCapability = {
  createMonitor: (options) => new BackgroundTaskMonitor(options),
}
