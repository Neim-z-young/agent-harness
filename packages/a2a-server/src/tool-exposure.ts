/**
 * 工具暴露面（P3-D，设计稿 §14）：`ToolRegistry` → 控制面出参 → 扩展侧 `lm.registerTool`。
 *
 * 纯模块：不碰 `Host`、不碰 HTTP、不碰 `vscode` ⇒ "列哪些工具、怎么描述、怎么判只读"
 * 全部可以脱离端口与编辑器单测（与 `mapping.ts` / `@harness/cli` 的 `commands.ts` 同一条分层纪律）。
 */
import { type Tool, type ToolResult } from '@harness/tool'

/** `harness/tools.list` 的单条出参 —— 也是扩展侧要注册成 LM 工具的形状 */
export interface ToolDescriptor {
  /** 工具 id，**原名直出**（`harness_` 前缀是客户端的命名空间问题，不属暴露面） */
  readonly name: string
  readonly description: string
  /** 入参 JSON Schema：直出工具的 `__jsonSchema`，不裁剪、不重写 */
  readonly inputSchema: Record<string, unknown>
  /** 只读判定（Fail-Closed：未声明 / 求值抛错 ⇒ false） */
  readonly readOnly: boolean
  /**
   * 调用方是否需要**先拿到用户确认**再调用（= 工具声明了 `permission`）。
   *
   * 语义是"**可能被问**"而非"一定被问"：静态规则已 allow 时 `engine.check` 会短路。
   * 调用方据此决定要不要弹确认框，最终裁决仍在 sidecar。
   */
  readonly requiresConfirmation: boolean
}

/**
 * `harness/tools.call` 的出参。
 *
 * **工具级失败也走正常回包**（`ok: false`），不是协议错误 —— 理由与 `@harness/mcp-server`
 * 的 `isError` 判断同源：变成协议错误会让客户端只看到一句"请求失败"，
 * 把"为什么被拒"藏起来，而编排方需要把原因读回上下文才能改。协议错误只留给
 * "会话/工具名/入参形状不对"这类**调用方写错了**的情形（见 `control.ts`）。
 */
export interface ToolCallOutcome {
  readonly ok: boolean
  readonly output?: unknown
  readonly error?: { readonly message: string; readonly code?: string }
  /** 工具真实耗时（管道 Step 5 已经算好的那份，这里不重复计时） */
  readonly durationMs?: number
}

/** 入参 schema 缺省：空对象 schema（Fail-Closed 的"不接受任何具名参数"） */
function emptyInputSchema(): Record<string, unknown> {
  return { type: 'object', properties: {} }
}

function jsonSchemaOf(tool: Tool): Record<string, unknown> {
  const raw = tool.inputSchema.__jsonSchema
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : emptyInputSchema()
}

/**
 * 只读判定 —— Fail-Closed 三条线：
 * 未声明 `isReadOnly` ⇒ false；显式返回 false ⇒ false；**求值抛错 ⇒ false**。
 *
 * 最后一条不是假想：`isReadOnly(input)` 在本处是**不带入参**调用的，任何真的读入参的实现都会抛。
 * 把它 catch 成 `false`（= 当成可写）而不是让它冒出去 —— 判定失败只该导致"多问一次"，不该导致报错。
 */
function isReadOnlyOf(tool: Tool): boolean {
  try {
    return tool.isReadOnly?.() ?? false
  } catch {
    return false
  }
}

export function toToolDescriptor(tool: Tool): ToolDescriptor {
  const readOnly = isReadOnlyOf(tool)
  return {
    name: tool.id,
    description: tool.description,
    inputSchema: jsonSchemaOf(tool),
    readOnly,
    // **判据必须与权限链的启动条件逐字一致**：链启动只看 `tool.permission` 有没有声明
    // （`ToolPipeline.execute` Step 4：`if (tool.permission && this.checkPermission)`），
    // **与只读无关**。曾经这里写成 `&& !readOnly`，后果很实：`read_file` 是只读但**声明了**
    // `permission: { key: 'read' }`（`tools-builtin/src/index.ts:131/133`），默认规则
    // `{ '*': 'ask' }`（`host/src/host.ts:338`）下它照样落到 `ask` —— 于是调用方
    // 以为"只读不用确认"、不带 `approve`，工具被**静默拒绝**且没有任何批准途径。
    //
    // 保守报 true 的代价是"静态规则已 allow 时多问一次"（噪音）；
    // 漏报的代价是"一个照常会问的调用被直接拒"（功能失效）。两者不对称，故取宽。
    requiresConfirmation: tool.permission !== undefined,
  }
}

/** 按名字排序后直出 —— 顺序稳定，客户端 diff 时不会因注册顺序抖动而误判"工具集变了" */
export function listToolDescriptors(tools: readonly Tool[]): ToolDescriptor[] {
  return [...tools]
    .map(toToolDescriptor)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * 归一化一次工具执行的结果。
 *
 * 入参已是 `ToolResult` —— "try/catch + `normalizeToolError`" 那两步由调用方做（`control.ts`），
 * 且刻意与 core 的 `safeExecuteTool` 逐字同构。⇒ "控制面调工具"与"harness 自己调工具"
 * 在错误码与遥测口径上是同一套（`PERMISSION_DENIED` / `TOOL_ERROR`）。
 */
export function toToolCallOutcome(result: ToolResult): ToolCallOutcome {
  const durationMs = result.meta?.durationMs
  const timing = durationMs !== undefined ? { durationMs } : {}
  if (result.ok) return { ok: true, output: result.output, ...timing }
  return {
    ok: false,
    error: {
      message: result.error?.message ?? '工具执行失败',
      ...(result.error?.code ? { code: result.error.code } : {}),
    },
    ...timing,
  }
}
