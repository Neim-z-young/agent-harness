/**
 * @harness/tool - Tool 运行时协议
 *
 * Tool 是完整的运行时协议对象，不只是 call() 函数。
 * 包含：
 * - 安全声明（Fail-Closed 默认值）
 * - Schema 校验（inputSchema / outputSchema）
 * - 语义校验（validateInput）
 * - 权限声明（permission.key + extractPatterns）
 * - 执行入口（call）
 * - UI 呈现（renderUse / renderResult / renderError）
 *
 * 同时提供 Tool.define() 工厂函数和 partitionToolCalls 并发分批调度。
 */

// ===== 基础工具类型 =====

/** 支持 Promise 或同步值的类型 */
export type Awaitable<T> = T | Promise<T>

/**
 * 工具入参的 JSON Schema（对象形态）。
 * 供 Provider 生成 `tools` 载荷 —— 这是模型认识工具参数的**唯一**渠道：
 * 缺了它，模型只能看到工具名 + 一句散文描述，参数全靠猜（实测会退化成空参调用与原地空转）。
 */
export interface JsonSchemaObject {
  type: 'object'
  /** 常规单模式必填；用 oneOf 表达多模式（联合入参，如 code_semantic_edit）时可省略 */
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [k: string]: unknown
}

/**
 * {@link fromJsonSchema} 的入参类型：**强制 schema 的 `properties` 逐个覆盖入参接口的字段**。
 *
 * 为什么把"对齐"这件事放在类型上：
 * - 接口字段是**类型层面**的东西，运行时拿不到 ⇒ 写不出运行时断言；
 * - 而漏声明的后果恰好只在类型层面可判 —— 模型看不到那个参数，运行期却照收。
 *   实测漏过：glob 少了 `exclude` / `minSizeBytes` / `maxSizeBytes` / `maxDepth`（4 个），
 *   web_fetch 少了 `followRedirects` / `maxResponseBytes` / `allowPrivateNetwork`（3 个）——
 *   这 7 个参数都是"能传、但模型不知道能传"，表现为能力凭空消失且无任何报错。
 * - 放在类型上 ⇒ 与 `bun run typecheck` 同一道闸，零运行时成本、零新增基建。
 *
 * 两种合法形态：
 * - **单模式**：`properties` 必须逐个列出 `keyof T`（少一个、多一个都编译不过），
 *   `required` 也只能取 `keyof T` 里的键；
 * - **多模式**（顶层 `oneOf`，如 `code_semantic_edit`）：顶层无 `properties`，
 *   各模式在 `oneOf[].properties` 里各自声明 —— 自动豁免对齐检查。
 *
 * ⚠️ 要"**故意**不暴露"某个入参字段时，正确做法是给该工具一个更窄的入参类型
 * （范例：`bash_ro` 用 `Omit<BashInput,'env'>` 表达"不接受 env"），
 * 而不是让 schema 与类型各说各话 —— 后者会退化成"模型传了但被静默忽略"。
 */
export type JsonSchemaFor<T> =
  | {
      type: 'object'
      properties: { [K in keyof T & string]: unknown }
      required?: Array<keyof T & string>
      additionalProperties?: boolean
      [k: string]: unknown
    }
  | { type: 'object'; oneOf: unknown[]; [k: string]: unknown }

/**
 * 通用 Schema 接口（抽象层，兼容 zod / valibot / 自定义校验）
 * 用于 Tool 的 inputSchema / outputSchema 硬校验
 */
export interface Schema<T> {
  /** 严格解析，失败抛错 */
  parse(value: unknown): T
  /** 安全解析，返回结果对象 */
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }
  /**
   * 可选：入参的 JSON Schema（声明式描述，给模型阅读）。
   *
   * ⚠️ 这是 provider 生成 tools 载荷时的**唯一**参数来源（openai / anthropic / gemini 三个适配器
   * 都读它），缺失时工具会以空对象 schema 发出 —— 模型看不到任何参数名/类型/必填项。
   * 新工具请用 {@link fromJsonSchema} 提供：一份声明同时充当"给模型读的描述"与"运行期校验规则"。
   */
  __jsonSchema?: JsonSchemaObject
}

/**
 * 给**已有** schema 补 JSON Schema（不改变运行时校验行为，只追加模型可读的入参描述）。
 *
 * 新工具请直接用 {@link fromJsonSchema} —— 一份声明同时管"模型读到什么"与"运行期接受什么"。
 * 本函数保留给"已自带 safeParse 实现、只想补一份模型可读描述"的场合（如 MCP 透传服务端 schema）。
 *
 * @example
 * inputSchema: withJsonSchema(myOwnSchema(), {
 *   type: 'object',
 *   properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
 *   required: ['command'],
 *   additionalProperties: false,
 * }),
 */
export function withJsonSchema<T>(
  schema: Schema<T>,
  jsonSchema: JsonSchemaObject,
): Schema<T> & { __jsonSchema: JsonSchemaObject } {
  return Object.assign(schema, { __jsonSchema: jsonSchema })
}

// ===== 由 JSON Schema 派生的运行时校验 =====

/** 校验失败的**规则类别** —— 工具内的守卫据此按"哪类问题"分流错误码（见 {@link JsonSchemaIssue.rule}） */
export type JsonSchemaRule =
  | 'required' // 缺必填
  | 'type' // 类型不符
  | 'enum' // 枚举越界
  | 'union' // oneOf / anyOf 各分支均不匹配
  | 'additional' // 未声明的字段（strictProperties 下）
  | 'items' // 数组元素个数越界
  | 'length' // 字符串长度越界
  | 'range' // 数值越界

/**
 * 单个校验问题。
 *
 * `message` 会被 {@link ToolSchemaError} 拼进错误文本，是模型「入参自愈」时能拿到的**全部**信息 ——
 * 必须写清"哪个参数、要什么、收到什么"，而不是只说"校验失败"。
 */
export interface JsonSchemaIssue {
  /** 出问题的入参路径（点号分隔，数组下标用 `[i]`；根为 `(root)`） */
  path: string
  /** 可读说明 */
  message: string
  /**
   * 规则类别 —— 给工具内的守卫按"**哪类问题**"分流错误码用。
   *
   * 存在的理由：同一个字段可能出**不同性质**的错，而"缺必填"与"类型不符"在 {@link path}
   * 上长得一模一样（都是 `'path'` / `'command'`）。只看 path 会把类型错也归成「缺参数」——
   * 码说"缺"，消息说"应为 字符串，收到 数字"，两者打架。
   *
   * 守卫**判它，不要判 `message`**（文案会改，判据会静默失效）。
   */
  rule?: JsonSchemaRule
}

/** `fromJsonSchema` 校验失败 —— 带结构化 issues，`message` 已可直接给模型看 */
export class JsonSchemaValidationError extends Error {
  readonly issues: JsonSchemaIssue[]

  constructor(issues: JsonSchemaIssue[]) {
    super(
      issues.length === 1
        ? `入参不符合工具声明的 schema：${issues[0]!.message}`
        : `入参不符合工具声明的 schema（${issues.length} 处）：${issues.map((i) => i.message).join('；')}`,
    )
    this.name = 'JsonSchemaValidationError'
    this.issues = issues
  }
}

/** {@link fromJsonSchema} 选项 */
export interface FromJsonSchemaOptions {
  /**
   * 是否拒绝 schema 未声明的字段，默认 `false`（容忍）。
   *
   * 默认容忍的两个理由：
   * 1. 模型偶尔带无害冗余（多一个 `timeout` / `recursive` 之类）。为此拒掉整次调用等于凭空造出
   *    一类新失败，代价高于收益 —— 拒绝权的收益只在"模型反复瞎填参数"时才兑现。
   * 2. `oneOf` 多模式的 schema（如 code_semantic_edit）**刻意省略 `properties`**（见
   *    {@link JsonSchemaObject}），此时"未声明字段"是合法入参，一律拒绝会误伤。
   *
   * 需要与给模型看的声明完全一致（让 `additionalProperties:false` 真正生效）时显式打开。
   */
  strictProperties?: boolean
}

/** 内部：把 schema 节点当普通记录读（JsonSchemaObject 只声明了顶层字段） */
type JsonSchemaNode = Record<string, unknown>

const TYPE_LABELS: Record<string, string> = {
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔值',
  object: '对象',
  array: '数组',
  null: 'null',
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function describeTypes(want: unknown): string {
  const list = Array.isArray(want) ? want : [want]
  return list.map((t) => TYPE_LABELS[String(t)] ?? String(t)).join(' 或 ')
}

/** 实际收到的类型（与 describeTypes 同一套中文标签，让"应为 X，收到 Y"读起来对称） */
function describeActual(value: unknown): string {
  const actual = jsonTypeOf(value)
  return TYPE_LABELS[actual] ?? actual
}

function typeMatches(value: unknown, want: string): boolean {
  const actual = jsonTypeOf(value)
  switch (want) {
    case 'string':
      return actual === 'string'
    case 'number':
      return actual === 'number'
    case 'integer':
      return actual === 'number' && Number.isInteger(value)
    case 'boolean':
      return actual === 'boolean'
    case 'object':
      return actual === 'object'
    case 'array':
      return actual === 'array'
    case 'null':
      return actual === 'null'
    // 未识别的类型名放行：宁可漏拦，不可误杀
    default:
      return true
  }
}

function childPath(at: string, key: string): string {
  return at === '(root)' ? key : `${at}.${key}`
}

function validateNode(
  value: unknown,
  node: JsonSchemaNode,
  at: string,
  issues: JsonSchemaIssue[],
  strictProperties: boolean,
): void {
  // oneOf / anyOf：任一分支通过即可（union）。命中即返回 —— 分支内部细节不再逐条比对。
  for (const unionKey of ['oneOf', 'anyOf'] as const) {
    const branches = node[unionKey]
    if (Array.isArray(branches) && branches.length > 0) {
      const passed = branches.some((branch) => {
        const sub: JsonSchemaIssue[] = []
        validateNode(value, branch as JsonSchemaNode, at, sub, strictProperties)
        return sub.length === 0
      })
      if (!passed) {
        issues.push({
          path: at,
          rule: 'union',
          message: `${at} 的形态不受支持（需满足 ${unionKey} 中的一种，收到 ${describeActual(value)}）`,
        })
      }
      return
    }
  }

  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    issues.push({
      path: at,
      rule: 'enum',
      message: `${at} 只能是 ${node.enum.map((v) => JSON.stringify(v)).join(' / ')}，收到 ${JSON.stringify(value)}`,
    })
    return
  }

  const want = node.type
  if (typeof want === 'string' || Array.isArray(want)) {
    const wants = Array.isArray(want) ? want.map(String) : [want]
    if (!wants.some((w) => typeMatches(value, w))) {
      issues.push({ path: at, rule: 'type', message: `${at} 应为 ${describeTypes(want)}，收到 ${describeActual(value)}` })
      return
    }
  }

  const actual = jsonTypeOf(value)

  if (actual === 'object') {
    const obj = value as Record<string, unknown>
    const properties = node.properties as Record<string, JsonSchemaNode> | undefined

    if (Array.isArray(node.required)) {
      for (const key of node.required.map(String)) {
        if (obj[key] === undefined) {
          const decl = properties?.[key]
          const hint = decl && decl.type !== undefined ? `（${describeTypes(decl.type)}）` : ''
          issues.push({ path: childPath(at, key), rule: 'required', message: `缺少必填参数 ${JSON.stringify(key)}${hint}` })
        }
      }
    }

    if (properties) {
      for (const [key, sub] of Object.entries(properties)) {
        if (obj[key] !== undefined) {
          validateNode(obj[key], sub, childPath(at, key), issues, strictProperties)
        }
      }
    }

    // 未声明字段：additionalProperties 为 false 时按 strictProperties 决定拒/容忍；
    // 为「schema 对象」时逐个校验（形如 env: { additionalProperties: { type:'string' } }）。
    const additional = node.additionalProperties
    if (additional !== undefined && additional !== true) {
      const declared = new Set(properties ? Object.keys(properties) : [])
      for (const key of Object.keys(obj)) {
        if (declared.has(key) || obj[key] === undefined) continue
        if (additional === false) {
          if (strictProperties) {
            issues.push({ path: childPath(at, key), rule: 'additional', message: `不接受未声明的参数 ${JSON.stringify(key)}` })
          }
        } else if (typeof additional === 'object' && additional !== null) {
          validateNode(obj[key], additional as JsonSchemaNode, childPath(at, key), issues, strictProperties)
        }
      }
    }
    return
  }

  if (actual === 'array') {
    const arr = value as unknown[]
    const minItems = node.minItems
    const maxItems = node.maxItems
    if (typeof minItems === 'number' && arr.length < minItems) {
      issues.push({ path: at, rule: 'items', message: `${at} 至少需要 ${minItems} 项，收到 ${arr.length} 项` })
    }
    if (typeof maxItems === 'number' && arr.length > maxItems) {
      issues.push({ path: at, rule: 'items', message: `${at} 最多允许 ${maxItems} 项，收到 ${arr.length} 项` })
    }
    const items = node.items
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      arr.forEach((item, i) => {
        validateNode(item, items as JsonSchemaNode, `${at}[${i}]`, issues, strictProperties)
      })
    }
    return
  }

  if (actual === 'string') {
    const len = (value as string).length
    const minLength = node.minLength
    const maxLength = node.maxLength
    if (typeof minLength === 'number' && len < minLength) {
      issues.push({ path: at, rule: 'length', message: `${at} 至少 ${minLength} 个字符，收到 ${len} 个` })
    }
    if (typeof maxLength === 'number' && len > maxLength) {
      issues.push({ path: at, rule: 'length', message: `${at} 最多 ${maxLength} 个字符，收到 ${len} 个` })
    }
    return
  }

  if (actual === 'number') {
    const num = value as number
    const minimum = node.minimum
    const maximum = node.maximum
    if (typeof minimum === 'number' && num < minimum) {
      issues.push({ path: at, rule: 'range', message: `${at} 不得小于 ${minimum}，收到 ${num}` })
    }
    if (typeof maximum === 'number' && num > maximum) {
      issues.push({ path: at, rule: 'range', message: `${at} 不得大于 ${maximum}，收到 ${num}` })
    }
  }
}

/**
 * 从 **JSON Schema 派生**运行时校验，返回一个 `Schema<T>`。
 *
 * 为什么是"派生"而不是另写一套字段 DSL：`__jsonSchema` 已经是给模型看的唯一参数来源，
 * 再声明一份运行时规则就有**两份真值**会漂移。派生之后，一处声明同时决定"模型看到什么"
 * 与"运行期接受什么"，而且模型侧 tools 载荷**字节级不变**。
 *
 * 覆盖的关键字（= 现网工具实际用到的全集）：`type` / `properties` / `required` /
 * `additionalProperties` / `items` / `oneOf` / `anyOf` / `enum` / `minimum` / `maximum` /
 * `minLength` / `maxLength` / `minItems` / `maxItems`。未识别的关键字一律放行。
 *
 * 默认严格度：缺必填 ⇒ 拒；类型不符、枚举越界 ⇒ 拒；**多余字段 ⇒ 容忍**
 * （理由见 {@link FromJsonSchemaOptions.strictProperties}）。
 *
 * 入参形态见 {@link JsonSchemaFor}：它同时把"`properties` 必须覆盖 `keyof T`"变成编译期约束，
 * 漏声明一个入参字段就过不了 `tsc`。
 *
 * @example
 * // BashInput = { command: string; cwd?: string; timeoutMs?: number; env?: ... }
 * // ⇒ properties 必须把四个都列出来，少一个 typecheck 就报错
 * inputSchema: fromJsonSchema<BashInput>({
 *   type: 'object',
 *   properties: {
 *     command: { type: 'string', description: '要执行的 shell 命令' },
 *     cwd: { type: 'string' },
 *     timeoutMs: { type: 'number' },
 *     env: { type: 'object' },
 *   },
 *   required: ['command'],
 *   additionalProperties: false,
 * })
 */
export function fromJsonSchema<T>(
  schema: JsonSchemaFor<T>,
  options: FromJsonSchemaOptions = {},
): Schema<T> & { __jsonSchema: JsonSchemaObject } {
  const strictProperties = options.strictProperties ?? false

  const collect = (value: unknown): JsonSchemaIssue[] => {
    const issues: JsonSchemaIssue[] = []
    validateNode(value, schema as unknown as JsonSchemaNode, '(root)', issues, strictProperties)
    return issues
  }

  return {
    parse(value: unknown): T {
      const issues = collect(value)
      if (issues.length > 0) throw new JsonSchemaValidationError(issues)
      return value as T
    },
    safeParse(value: unknown) {
      const issues = collect(value)
      if (issues.length > 0) {
        return { success: false as const, error: new JsonSchemaValidationError(issues) }
      }
      return { success: true as const, data: value as T }
    },
    // 校验已经由入参类型 JsonSchemaFor<T> 在编译期把关，这里存的就是**同一份**声明对象
    // （provider 生成 tools 载荷读的就是它 ⇒ 模型看到什么与运行期接受什么必然同源）。
    __jsonSchema: schema as JsonSchemaObject,
  }
}

/**
 * 把 `safeParse` 的失败原因压成一行可读文本。
 *
 * 给"工具内守卫"复用同一份 schema 用（bash / glob）：那些守卫的返回值不走 ToolSchemaError，
 * 但错误文本必须与管道内**同源**，否则同一个问题会有两套措辞。
 */
export function formatSchemaError(error: unknown): string {
  if (error instanceof JsonSchemaValidationError) {
    return error.issues.map((i) => i.message).join('；')
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * 取 `safeParse` 失败的结构化 issues（非本校验器产生的错误返回空数组）。
 *
 * 存在的理由：`Schema.safeParse` 的 `error` 契约是 `unknown`，工具内守卫想按"哪个字段出的问题"
 * 分流错误码（如 command 缺失 ⇒ COMMAND_REQUIRED）时，需要一个类型安全的取值口。
 */
export function schemaIssues(error: unknown): JsonSchemaIssue[] {
  return error instanceof JsonSchemaValidationError ? error.issues : []
}

/** 结构守卫的结果：成功给解析后的入参，失败给可直接塞进 `ToolResult` 的错误 */
export type InputGuardResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; code: string } }

/**
 * 直调入参结构守卫（`read_file` / `write_file` / `edit_file` / `bash` / `glob` 共用）。
 *
 * 管道内 Step 1 已经用同一份 schema 拦过一次；这段是**"越过管道直接调 `tool.call()`"**
 * 那条路径的兜底（测试正是直接调的）。规则只留一份 —— 复用的就是喂给模型的那份 schema。
 *
 * **为什么必须有**：这些工具的 `call()` 第一行就会用入参 —— `resolvePath(input.path, ctx.cwd)`
 * 内部先做 `isAbsolute(inputPath)`，传 `undefined` / `null` / 数字 / 对象都会抛
 * `TypeError: The "path" property must be of type string`；bash 则会把 `undefined` 一路送进
 * spawn，由 shell 报出 `bash: undefined: command not found`（真机会话里连撞 6 次）。
 * 更要命的是 `resolvePath` 那行在 `try` **之外**，异常不会被下面的 catch 收敛，会直接冒泡给
 * 调用方（权限引擎的 `extractPatterns` 在此之前还会先拿到 `[undefined]`）。
 *
 * 错误码分两档：缺 `requiredField` ⇒ `requiredCode`（模型从码名就能读出少了哪个参数），
 * 其余结构问题 ⇒ `INVALID_INPUT`。
 *
 * 注意这把守卫只管**结构**。JSON Schema 表达不了的语义判据（如 bash 的"纯空白 command"、
 * glob 的"pattern 全为空"）仍留在各自的 `call()` 里 —— 别为了收口把语义塞进来。
 *
 * 放在 `@harness/tool` 而不是某个插件的私有函数里：它是**跨插件**共用的（`tools-builtin`
 * 的四个文件工具 + `tools-glob`），而它依赖的 `formatSchemaError` / `schemaIssues`
 * 本来就在这个模块。
 *
 * @param requiredField 必填字段名 —— 缺它才算"缺参数"
 * @param requiredCode  缺 `requiredField` 时的对外错误码（如 `PATH_REQUIRED`；glob 传的是
 *                      `GLOB_PATTERN_MISSING`，与它的语义守卫同码，消费方不必区分来源）
 */
export function guardInput<T>(
  schema: Schema<T>,
  input: unknown,
  requiredField: string,
  requiredCode: string,
): InputGuardResult<T> {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { ok: true, data: parsed.data }
  // 判据必须是 rule，不能只看 path：缺必填与"该字段类型不符"的 path 完全相同（都是字段名），
  // 只看 path 会把 `command: 123` 也报成 COMMAND_REQUIRED（码说"缺"、消息说"应为 字符串"）。
  const missing = schemaIssues(parsed.error).some(
    (i) => i.rule === 'required' && i.path === requiredField,
  )
  return {
    ok: false,
    error: {
      message: formatSchemaError(parsed.error),
      code: missing ? requiredCode : 'INVALID_INPUT',
    },
  }
}

// ===== ToolContext =====

/** 权限请求（由 Tool 通过 ctx.requestPermission 发起） */
export interface PermissionRequest {
  /** 权限键："write" / "bash" / "read" */
  toolKey: string
  /** 提取的路径或命令模式 */
  patterns: string[]
  /** 原始输入 */
  input: unknown
  /**
   * 发起该请求的会话 ID（ToolPipeline 在 Step 4 从 `ctx.sessionId` 填入）。
   *
   * 与 `@harness/permission` 的 `PermissionRequest.sessionId` 同义：询问接缝的 `asker` 是全局
   * 单槽，多宿主（TUI / A2A / 进程内 MCP server）并存时靠它区分"这次询问属于谁"，
   * 否则后装的 asker 会顶掉前一个。可选是为了让既有调用点（`ctx.requestPermission`）不必伪造。
   */
  sessionId?: string
  /**
   * 仅参与 **deny** 判定的附加 pattern（可选）。
   *
   * 为什么不让工具直接把它们混进 `patterns`：权限引擎的 allow / ask 是**任一 pattern
   * 命中即生效**（任一命中 allow ⇒ 整条放行）—— 把 bash 的段级命令混进 patterns 会
   * 放宽 allow（`echo hi; rm -rf /` 被 `echo*` 的 allow 规则整条放走）。deny 是任一
   * 命中即拒绝，收紧无害：bash 用它上报段级命令，让 `deny: ['rm*']` 能拦住
   * `echo hi; rm -rf /` 这类「恶意段藏在全串中」的形态。
   */
  denyPatterns?: string[]
}

/** 权限决策（由 PermissionEngine 返回） */
export interface PermissionDecision {
  /** 最终行为：allow / deny / ask */
  behavior: 'allow' | 'deny' | 'ask'
  /** 修正后的输入参数（插件可深度修改） */
  updatedInput?: unknown
  /** 是否记住决策（用户选"始终允许"时写回规则） */
  remember?: boolean
}

/**
 * 工具执行上下文（每次调用注入）
 * 由 Agent Runtime 在调用 tool.call() 时构造
 */
export interface ToolContext {
  /** 当前会话 ID */
  sessionId: string
  /** 当前 Agent ID */
  agentId: string
  /** 当前消息 ID */
  messageId: string
  /** 工具调用 ID（LLM 生成的 tool_use_id） */
  toolUseId: string
  /** AbortSignal，用于中断长任务 */
  signal: AbortSignal
  /** 上下文变量（DI 容器派生） */
  variables: Record<string, unknown>
  /** 当前工作目录 */
  cwd: string
  /** 请求权限的回调（由 PermissionEngine 提供） */
  requestPermission?: (req: PermissionRequest) => Promise<PermissionDecision>
  /** 日志器 */
  log?: {
    info(msg: string, meta?: unknown): void
    warn(msg: string, meta?: unknown): void
    error(msg: string, meta?: unknown): void
  }
}

// ===== ToolResult =====

/**
 * 工具执行结果
 * ok=true 时 output 有值，ok=false 时 error 有值
 */
export interface ToolResult<T = unknown> {
  /** 是否成功 */
  ok: boolean
  /** 输出值（ok=true 时） */
  output?: T
  /** 错误信息（ok=false 时） */
  error?: {
    message: string
    code?: string
    cause?: unknown
  }
  /** 元数据（执行耗时、token 用量等） */
  meta?: {
    durationMs?: number
    tokenUsage?: number
    [key: string]: unknown
  }
  /** 是否被用户中断 */
  interrupted?: boolean
}

// ===== Tool 接口 =====

/**
 * Tool 运行时协议
 *
 * 安全声明采用 Fail-Closed 策略：
 * 所有安全相关字段默认值都是最保守的（false），
 * 必须由工具显式声明为 true 才会启用相应能力。
 */
export interface Tool<Input = any, Output = any, Progress = any> {
  // === 标识 ===
  /** 工具唯一 ID（如 "read_file"、"edit_file"） */
  id: string
  /** 别名（兼容旧名） */
  aliases?: string[]
  /** 给 AI 看的短描述 */
  description: string
  /** 给 AI 看的完整文档（.txt 等价内容） */
  documentation?: string
  /** 搜索提示（用于工具选择/路由） */
  searchHint?: string

  // === 安全声明（Fail-Closed：所有默认值都是最保守的 false）===
  /** 是否并发安全（默认 false，必须显式声明 true 才并发执行） */
  isConcurrencySafe?: (input?: Input) => boolean
  /** 是否只读操作（默认 false，保守认为有写副作用） */
  isReadOnly?: (input?: Input) => boolean
  /** 是否破坏性操作（删除/覆盖等，默认 false） */
  isDestructive?: (input?: Input) => boolean
  /** 是否需要用户交互（如 AskUserQuestionTool，默认 false） */
  requiresUserInteraction?: boolean

  // === Schema ===
  /** 输入 schema（推荐 {@link fromJsonSchema}；zod / 自定义亦可，硬校验） */
  inputSchema: Schema<Input>
  /** 输出 schema（可选，校验结果） */
  outputSchema?: Schema<Output>

  // === 语义校验（独立于 Schema，如 Edit 工具字符串存在性校验）===
  validateInput?: (input: Input, ctx: ToolContext) => Awaitable<void>

  // === 权限（路径级匹配，配合 PermissionEngine）===
  permission?: {
    /** 权限键："write" / "bash" / "read" */
    key: string
    /** 提取需要权限的路径或命令模板 */
    extractPatterns: (input: Input) => string[]
    /** 提取仅参与 deny 判定的附加模式（可选；见 PermissionRequest.denyPatterns） */
    extractDenyPatterns?: (input: Input) => string[]
  }

  // === 执行入口 ===
  call(
    input: Input,
    ctx: ToolContext,
    onProgress?: (p: Progress) => void
  ): Promise<ToolResult<Output>>

  // === UI 呈现（可选，插件可自定义渲染）===
  /** 渲染工具调用参数 */
  renderUse?: (input: Input) => unknown
  /** 渲染工具执行结果 */
  renderResult?: (result: ToolResult<Output>) => unknown
  /** 渲染错误 */
  renderError?: (err: Error) => unknown
}

// ===== Fail-Closed 默认值 =====

/**
 * 工具安全声明默认值：Fail-Closed 策略
 * 所有未显式声明的安全字段都会回退到这里
 */
export const TOOL_DEFAULTS = {
  /** 默认不可并发（保守） */
  isConcurrencySafe: (() => false) as (input?: unknown) => boolean,
  /** 默认非只读（保守，认为有写副作用） */
  isReadOnly: (() => false) as (input?: unknown) => boolean,
  /** 默认非破坏性 */
  isDestructive: (() => false) as (input?: unknown) => boolean,
  /** 默认不需要用户交互 */
  requiresUserInteraction: false,
} as const

// ===== Tool.define 工厂函数 =====

/** Tool 定义参数（id/description/call/inputSchema 必填，其他可选） */
export type ToolDefinition<I = any, O = any, P = any> = {
  id: string
  description: string
  call: Tool<I, O, P>['call']
  inputSchema: Schema<I>
} & Partial<Omit<Tool<I, O, P>, 'id' | 'description' | 'call' | 'inputSchema'>>

/**
 * Tool 工厂函数：创建一个应用 Fail-Closed 默认值的 Tool 实例
 *
 * 所有未显式声明的安全字段都会回退到最保守的默认值。
 *
 * @example
 * const ReadFile = Tool.define({
 *   id: 'read_file',
 *   description: '读取文件内容',
 *   inputSchema: z.object({ path: z.string() }),
 *   isReadOnly: () => true,           // 显式声明只读
 *   isConcurrencySafe: () => true,    // 显式声明并发安全
 *   async call({ path }, ctx) {
 *     return { ok: true, output: await readFile(path) }
 *   }
 * })
 */
export function defineTool<I = any, O = any, P = any>(
  def: ToolDefinition<I, O, P>
): Tool<I, O, P> {
  return {
    // 应用 Fail-Closed 默认值
    isConcurrencySafe: TOOL_DEFAULTS.isConcurrencySafe,
    isReadOnly: TOOL_DEFAULTS.isReadOnly,
    isDestructive: TOOL_DEFAULTS.isDestructive,
    requiresUserInteraction: TOOL_DEFAULTS.requiresUserInteraction,
    // 用户定义（覆盖默认值）
    ...def,
  }
}

// Tool 命名空间：interface + namespace 合并
export namespace Tool {
  /** Tool 定义参数类型 */
  export type Definition<I = any, O = any, P = any> = ToolDefinition<I, O, P>
  /** 工厂函数别名 */
  export const define = defineTool
}

// ===== partitionToolCalls 并发分批调度 =====

/** 一次工具调用（含工具实例和输入） */
export interface ToolUse {
  toolId: string
  tool: Tool
  input: unknown
  toolUseId: string
}

/** 一批工具调用（同批次可并发，批次间串行） */
export interface ToolBatch {
  /** 该批次的工具调用 */
  uses: ToolUse[]
  /** 是否可并行执行（true = 并发，false = 串行） */
  parallel: boolean
  /** 上下文修改器（延迟应用，防竞态） */
  contextModifier?: (ctx: ToolContext) => ToolContext
}

/**
 * 并发分批调度：按 isConcurrencySafe 把工具调用分成多个批次
 *
 * 策略（参考 Claude Code partitionToolCalls）：
 * - 连续并发安全的工具合批并行执行
 * - 非并发安全的工具各自串行批次
 * - 批次间 contextModifier 延迟应用（防止竞态污染）
 *
 * @example
 * const batches = partitionToolCalls([
 *   { tool: ReadFile, ... },   // safe
 *   { tool: ReadFile, ... },   // safe → 合批并行
 *   { tool: WriteFile, ... },  // unsafe → 单独批次串行
 *   { tool: ReadFile, ... },   // safe → 新批次并行
 * ])
 * // 3 个批次：[parallel, serial, parallel]
 */
export function partitionToolCalls(uses: ToolUse[]): ToolBatch[] {
  const batches: ToolBatch[] = []
  let currentBatch: ToolBatch | null = null

  for (const use of uses) {
    const safe = use.tool.isConcurrencySafe?.(use.input) ?? false

    if (safe) {
      // 并发安全：尝试合批
      if (!currentBatch || !currentBatch.parallel) {
        // 开新并行批次
        currentBatch = { uses: [use], parallel: true }
        batches.push(currentBatch)
      } else {
        // 加入当前并行批次
        currentBatch.uses.push(use)
      }
    } else {
      // 非并发安全：单独串行批次
      currentBatch = { uses: [use], parallel: false }
      batches.push(currentBatch)
    }
  }

  return batches
}

// ===== Tool 自定义错误 =====

/** Schema 校验失败错误（inputSchema 或 outputSchema） */
export class ToolSchemaError extends Error {
  /** 'input' 或 'output' */
  readonly stage: 'input' | 'output'
  readonly toolId: string
  readonly cause: unknown

  constructor(toolId: string, stage: 'input' | 'output', cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause)
    super(`[${toolId}] ${stage} schema validation failed: ${causeMsg}`)
    this.name = 'ToolSchemaError'
    this.toolId = toolId
    this.stage = stage
    this.cause = cause
  }
}

/** 语义校验失败错误（validateInput） */
export class ToolValidationError extends Error {
  readonly toolId: string
  readonly cause: unknown

  constructor(toolId: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause)
    super(`[${toolId}] semantic validation failed: ${causeMsg}`)
    this.name = 'ToolValidationError'
    this.toolId = toolId
    this.cause = cause
  }
}

/** 权限拒绝错误 */
export class ToolPermissionDeniedError extends Error {
  readonly toolId: string
  readonly toolKey?: string
  readonly patterns?: string[]

  constructor(toolId: string, toolKey?: string, patterns?: string[]) {
    super(`[${toolId}] permission denied (key=${toolKey ?? 'n/a'}, patterns=${JSON.stringify(patterns)})`)
    this.name = 'ToolPermissionDeniedError'
    this.toolId = toolId
    this.toolKey = toolKey
    this.patterns = patterns
  }
}

/** 权限需要询问用户错误（Pipeline 无法自行决策，返回给上层 UI 处理） */
export class ToolPermissionAskRequiredError extends Error {
  readonly toolId: string
  readonly toolKey?: string
  readonly patterns?: string[]

  constructor(toolId: string, toolKey?: string, patterns?: string[]) {
    super(`[${toolId}] user permission required (key=${toolKey ?? 'n/a'})`)
    this.name = 'ToolPermissionAskRequiredError'
    this.toolId = toolId
    this.toolKey = toolKey
    this.patterns = patterns
  }
}

// ===== 错误 → ToolResult 的**唯一**映射点 =====

/**
 * 把 pipeline 抛出的错误归一化为失败 `ToolResult`。
 *
 * 为什么必须集中在这一处：同一个失败会走两条路 ——
 * ① `safeExecuteTool`（core）兜住异常后把它变成回给**模型**的结果；
 * ② `ToolPipeline` 的错误路径用它喂 **PostHook**（遥测 / 轨迹 / 记忆）。
 * 两处各写一份映射就会漂移 ⇒ 遥测里看到的 code 与模型看到的不是一回事，排查时对不上账。
 *
 * 权限拒绝按**错误名**判定（不依赖类绑定，AGENTS.md 约定）。
 */
export function normalizeToolError(err: unknown): ToolResult {
  const name = (err as { name?: string } | undefined)?.name
  const message = (err as { message?: string } | undefined)?.message ?? String(err)
  if (name === 'ToolPermissionDeniedError') {
    return { ok: false, error: { message: `权限被拒绝：${message}`, code: 'PERMISSION_DENIED' } }
  }
  return { ok: false, error: { message, code: 'TOOL_ERROR' } }
}

// ===== Tool Pipeline Hooks =====

/** PreHook 回调：在权限检查之后、真正 tool.call 之前被调用（中间件风格支持 next） */
export interface ToolPreHookContext {
  tool: Tool
  input: unknown
  ctx: ToolContext
  toolUseId: string
}

export type ToolPreHook = (
  ctx: ToolPreHookContext,
  next: (modifiedInput?: unknown) => Promise<ToolResult>
) => Promise<ToolResult>

/** PostHook 回调：在 tool.call 返回结果之后调用（可观察/修改结果） */
export interface ToolPostHookContext {
  tool: Tool
  input: unknown
  ctx: ToolContext
  toolUseId: string
}

export type ToolPostHook = (ctx: ToolPostHookContext, result: ToolResult) => Awaitable<ToolResult>

// ===== ToolRegistry =====

/** 注册参数 */
export interface ToolRegisterOptions {
  /** 若 ID 已存在是否覆盖，默认 false 抛错 */
  override?: boolean
}

/**
 * 工具白名单哨兵：『只读工具』。
 *
 * 语义由 {@link ToolRegistry.filterByWhitelist} 解析：展开为注册表中 `isReadOnly()` 为 true
 * 的全部工具（Fail-Closed —— 未显式声明只读的工具不算只读）。
 * 用途：Agent 没声明 `tools:` 时给一个「能读不能写」的安全兜底，
 * 见 `@harness/agent` 的 markdown 解析（`agentFromMarkdown` 缺 tools 时写入本值）。
 *
 * 注意：`@harness/agent` 与该包都是零依赖叶子包、不能互相 import，故字面量各留一份
 * （同 `agent/READONLY_TOOLS_SENTINEL`），**改动必须同步**。
 */
export const READONLY_TOOLS_SENTINEL = '@readonly'

/**
 * 工具白名单的人类可读呈现（供 /tools、/subagents 等展示）：
 * 哨兵换成「只读工具」，空数组为「（无）」。
 */
export function formatToolWhitelist(whitelist: string[] | ['*'] | undefined): string {
  if (!whitelist || whitelist.length === 0) return '（无）'
  if (whitelist.length === 1 && whitelist[0] === '*') return '*（全部工具）'
  return whitelist.map((t) => (t === READONLY_TOOLS_SENTINEL ? '只读工具（缺省）' : t)).join(', ')
}

/**
 * ToolRegistry：工具注册中心
 *
 * 负责：
 * - register / unregister / get / has 基本 CRUD
 * - alias 解析（工具别名也可查找）
 * - filterByWhitelist：按 Agent 的 tools 白名单过滤
 * - toSchemas：导出给 LLM 的工具 schema 描述（需要适配具体 Provider 时做转换）
 */
export class ToolRegistry {
  private readonly byId = new Map<string, Tool>()

  /**
   * 注册一个工具
   * @throws 如果 ID 已存在且 options.override !== true
   */
  register(tool: Tool, options: ToolRegisterOptions = {}): this {
    if (this.byId.has(tool.id) && !options.override) {
      throw new Error(`ToolRegistry: tool id "${tool.id}" already registered`)
    }
    this.byId.set(tool.id, tool)
    return this
  }

  /** 批量注册（按数组顺序依次 register） */
  registerAll(tools: Tool[], options: ToolRegisterOptions = {}): this {
    for (const t of tools) this.register(t, options)
    return this
  }

  /** 注销工具（ID 不存在时忽略） */
  unregister(toolId: string): this {
    this.byId.delete(toolId)
    return this
  }

  /** 是否存在（ID 或 alias 匹配） */
  has(idOrAlias: string): boolean {
    if (this.byId.has(idOrAlias)) return true
    for (const t of this.byId.values()) {
      if (t.aliases?.includes(idOrAlias)) return true
    }
    return false
  }

  /**
   * 获取工具实例（ID 或 alias 查找）
   * @returns Tool 或 undefined
   */
  get(idOrAlias: string): Tool | undefined {
    const direct = this.byId.get(idOrAlias)
    if (direct) return direct
    for (const t of this.byId.values()) {
      if (t.aliases?.includes(idOrAlias)) return t
    }
    return undefined
  }

  /** 列出所有已注册工具 */
  list(): Tool[] {
    return Array.from(this.byId.values())
  }

  /**
   * 只读工具（`isReadOnly()` 为 true 的）。
   *
   * Fail-Closed：未声明 `isReadOnly`、声明为 false、或求值抛错，一律视为可写（不返回）。
   * 供白名单哨兵 {@link READONLY_TOOLS_SENTINEL} 展开用；也可用于展示/审计。
   */
  listReadOnly(): Tool[] {
    return this.list().filter((t) => {
      try {
        const v = typeof t.isReadOnly === 'function' ? t.isReadOnly(undefined) : (t as { isReadOnly?: boolean }).isReadOnly
        return v === true
      } catch {
        return false
      }
    })
  }

  /** 当前注册数量 */
  get size(): number {
    return this.byId.size
  }

  /**
   * 按 Agent 的工具白名单过滤
   *
   * 规则：
   * - whitelist = ['*'] → 全部放行
   * - 优先直选：若注册表里存在该 id（含名为 {@link READONLY_TOOLS_SENTINEL} 的普通工具），
   *   则直接返回该工具（优先于哨兵语义）—— 这样同名工具可被直选，不占用哨兵命名空间。
   * - whitelist 含 {@link READONLY_TOOLS_SENTINEL} 且没有同名工具时 → 该位展开为全部只读工具
   *   （可与普通 id 混写，展开处保持注册顺序）。
   *   注意：哨兵在**查询期**动态展开——同一份白名单在 MCP 只读工具晚注册的前后两次调用结果可能不同。
   * - 否则：只保留 ID 在列表里的工具，并同时匹配 alias
   */
  filterByWhitelist(whitelist: string[] | ['*']): Tool[] {
    if (whitelist.length === 1 && whitelist[0] === '*') {
      return this.list()
    }
    const result: Tool[] = []
    const push = (t: Tool | undefined): void => {
      if (t && !result.includes(t)) result.push(t)
    }
    for (const id of whitelist as string[]) {
      const direct = this.get(id)
      if (direct) {
        push(direct)
        continue
      }
      if (id === READONLY_TOOLS_SENTINEL) {
        for (const t of this.listReadOnly()) push(t)
      }
    }
    return result
  }

  /** 清空注册表 */
  clear(): void {
    this.byId.clear()
  }
}

// ===== MCP 工具过滤原语 =====
// 按 Agent 的 MCP server 声明（白名单/黑名单）对工具集做 server 粒度收窄。
// MCP 工具命名约定：`mcp__<server>__<tool>`，server 取首个 `__` 之前（server 名可含 `__`）。

/**
 * 规范化解析 MCP 工具 id：`mcp__<server>__<tool>` → { server, tool }。
 * server 取 `mcp__` 之后、首个 `__` 之前。非 `mcp__` 前缀或无 `__` 返回 undefined。
 */
export function parseMcpToolId(id: string): { server: string; tool: string } | undefined {
  const rest = id.startsWith('mcp__') ? id.slice('mcp__'.length) : id
  if (!rest.includes('__')) return undefined
  const i = rest.indexOf('__')
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}

/**
 * MCP 工具归属索引（内存缓存）：server 名 → 其暴露的完整工具 id 集合。
 *
 * 背景：MCP 工具 id 形如 `mcp__<server>__<tool>`，但 server 名本身可含 `__`
 * （如 `mcp__code-intel__x`、`mcp__a__b__c`）。此时仅凭 `parseMcpToolId` 的
 * 「首个 __ 切分」无法可靠反解出工具的真实来源 server 与 tool 名。
 *
 * 因此由装配方（如 mcp-server-registry）在生成工具时把「server → 全量工具 id」
 * 登记进该索引；反解方（如 tools-manager / 上层 UI）据此精确归属，未登记的工具
 * 再回退到 `parseMcpToolId` 启发式切分。纯内存数据结构，无副作用、无外部依赖。
 */
export class McpToolIndex {
  /** server 名 → 完整工具 id 集合 */
  private readonly serverTools = new Map<string, Set<string>>()
  /** 完整工具 id → server 名（精确归属） */
  private readonly toolServer = new Map<string, string>()

  /** 登记 server 的全部工具 id（幂等；同 server 重复登记以最新为准） */
  index(server: string, toolIds: Iterable<string>): void {
    this.unindex(server) // 先清旧归属，避免重连后残留过期工具
    const set = new Set<string>()
    for (const id of toolIds) {
      set.add(id)
      this.toolServer.set(id, server)
    }
    if (set.size) this.serverTools.set(server, set)
  }
  /** 移除 server 及其全部工具的归属 */
  unindex(server: string): void {
    const set = this.serverTools.get(server)
    if (set) for (const id of set) this.toolServer.delete(id)
    this.serverTools.delete(server)
  }
  /** 精确反解工具来源 server；未登记返回 undefined（调用方回退 parseMcpToolId） */
  serverOf(toolId: string): string | undefined {
    return this.toolServer.get(toolId)
  }
  /** 该工具是否有可靠归属（已登记） */
  has(toolId: string): boolean {
    return this.toolServer.has(toolId)
  }
  /** 已登记的 server 名列表 */
  servers(): string[] {
    return Array.from(this.serverTools.keys())
  }
  /** 已登记全部（server → 工具 id 列表）的只读视图 */
  entries(): Array<{ server: string; tools: string[] }> {
    return Array.from(this.serverTools.entries()).map(([server, set]) => ({ server, tools: Array.from(set) }))
  }
}

/** 全局默认 MCP 工具归属索引（模块单例，装配方与消费方共享） */
export const globalMcpToolIndex = new McpToolIndex()

/**
 * 解析 MCP 工具 id → { server, tool }。
 * 优先使用索引（globalMcpToolIndex 或显式传入）精确反解，可应对 server 名含 `__`
 * 的场景；未登记归属时回退到 `parseMcpToolId` 启发式切分。非 `mcp__` 前缀返回 undefined。
 */
export function resolveMcpTool(
  id: string,
  index: McpToolIndex = globalMcpToolIndex,
): { server: string; tool: string } | undefined {
  if (!id.startsWith('mcp__')) return undefined
  const exact = index?.serverOf(id)
  if (exact !== undefined) {
    const prefix = `mcp__${exact}__`
    if (id.startsWith(prefix)) return { server: exact, tool: id.slice(prefix.length) }
  }
  return parseMcpToolId(id)
}

/**
 * 按 Agent 的 MCP server 声明过滤工具集（常作为 filterByWhitelist 之后的第二阶段收窄）。
 *
 * 规则：
 * - `mcpServers` 定义（含空数组）→ 白名单模式：仅保留 server ∈ mcpServers 的 MCP 工具，空数组=拒绝全部 MCP。
 * - 否则若 `excludeMcpServers` 定义 → 黑名单模式：剔除 server ∈ excludeMcpServers 的工具。
 * - 两者均 undefined → 原样返回（向后兼容：MCP 全可见）。
 * - 白名单优先于黑名单（白名单定义时忽略黑名单）。
 * - 非 MCP 工具（parseMcpToolId 返回 undefined）始终不受影响。
 * - server 名匹配前均 trim。
 */
export function filterMcpTools(
  tools: Tool[],
  mcpServers?: string[],
  excludeMcpServers?: string[],
): Tool[] {
  if (mcpServers === undefined && excludeMcpServers === undefined) return tools
  const white = mcpServers === undefined ? undefined : new Set(mcpServers.map((s) => s.trim()))
  const black = excludeMcpServers === undefined ? undefined : new Set(excludeMcpServers.map((s) => s.trim()))
  return tools.filter((t) => {
    const parsed = parseMcpToolId(t.id)
    if (!parsed) return true // 非 MCP 工具恒保留
    const server = parsed.server.trim()
    if (white !== undefined) return white.has(server) // 白名单优先
    return !black!.has(server)
  })
}

/**
 * Agent 可用工具集的**最终组装**：原生白名单结果 + 声明的 MCP server **供给**的工具。
 *
 * 为什么不能只靠 {@link filterMcpTools}：它是**纯收窄**（intersection），必须喂"含 MCP 的全集"
 * 才能挑出 MCP 工具。而装配链路的实际入参是 `filterByWhitelist(agent.tools)` 的结果 ——
 * MCP 工具**在那一步就被剔掉了**（它们不在显式 `tools:` 列表里），于是第二阶段再怎么筛都是空集。
 * 真机代价：agent md 里写了 `mcpServers: ['code-intel']`，却一个 MCP 工具都拿不到
 * （探针实测 `TOOL_NOT_ALLOWED`），只有把 `mcp__code-intel__*` 逐条手写进 `tools:` 才生效 ——
 * 而文档（`@harness/agent` 的 `AgentDefinition.mcpServers`）写的是"声明该 Agent 可用哪些 server 的**全部工具**"，
 * 即**供给**语义。本函数把实现拉回文档语义。
 *
 * 规则（`picked` = `filterByWhitelist(agent.tools)` 的结果，`all` = 注册表全量）：
 * - `mcpServers` 为**非空数组** → 该列表内每个 server 的**全部**工具补进结果（去重）；
 *   同时把 `picked` 里 server 不在列表内的 MCP 工具剔除（`picked` 可能因 `'*'` 已含 MCP）。
 * - `mcpServers: []` → 拒绝全部 MCP（连 `picked` 里显式列出的 MCP 工具也剔除，fail-closed）。
 * - `mcpServers` undefined → **不供给**：MCP 工具只能靠 `tools:` 显式写 id（或 `'*'`）进入。
 *   （刻意与文档的"undefined = 全可见"不同：那是 fail-open，会让 `tools: ['read_file']` 的
 *   agent 静默拿到全部 MCP 工具。要全可见就写 `'*'`，要让某 agent 用某 server 就声明它。）
 * - `excludeMcpServers` → 黑名单，仅在 `mcpServers` 未定义时生效，剔除对应 server 的 MCP 工具
 *   （含 `picked` 里显式列出的）。白名单优先于黑名单。
 * - 非 MCP 工具始终不受影响；server 名匹配前 trim。
 */
export function supplyMcpTools(
  picked: Tool[],
  all: Tool[],
  mcpServers?: string[],
  excludeMcpServers?: string[],
  index: McpToolIndex = globalMcpToolIndex,
): Tool[] {
  const white = mcpServers === undefined ? undefined : new Set(mcpServers.map((s) => s.trim()))
  const black = excludeMcpServers === undefined ? undefined : new Set(excludeMcpServers.map((s) => s.trim()))
  const serverOf = (id: string): string | undefined => resolveMcpTool(id, index)?.server.trim()

  const kept = picked.filter((t) => {
    const server = serverOf(t.id)
    if (server === undefined) return true // 非 MCP 工具恒保留
    if (white !== undefined) return white.has(server) // 白名单（含空数组=全拒）优先
    return !black?.has(server)
  })

  // 供给：仅当显式声明了非空 server 列表
  if (white === undefined || white.size === 0) return kept
  const seen = new Set(kept.map((t) => t.id))
  const out = [...kept]
  for (const t of all) {
    if (seen.has(t.id)) continue
    const server = serverOf(t.id)
    if (server === undefined || !white.has(server)) continue
    out.push(t)
    seen.add(t.id)
  }
  return out
}

// ===== ToolPipeline =====

/** ToolPipeline 构造参数 */
export interface ToolPipelineOptions {
  /** 权限检查实现（通常由 PermissionEngine 提供），缺省时跳过权限检查（开发模式） */
  checkPermission?: (req: PermissionRequest) => Awaitable<PermissionDecision>
  /** PreHook 列表（按注册顺序执行，洋葱模型） */
  preHooks?: ToolPreHook[]
  /** PostHook 列表（按注册顺序执行） */
  postHooks?: ToolPostHook[]
  /** outputSchema 校验失败时是抛错还是降级为 warning，默认 false（抛错） */
  softOutputSchema?: boolean
  /** 结果最大字符数截断（用于 ToolResult string 输出，防止 LLM 上下文爆炸），默认 200k */
  resultMaxChars?: number
}

/**
 * ToolPipeline：工具调用 7 步生命周期执行器
 *
 * 1. inputSchema.safeParse 硬校验 → 失败抛 ToolSchemaError(stage=input)
 * 2. tool.validateInput 语义校验 → 失败抛 ToolValidationError
 * 3. PreHook 洋葱模型管道（可修改 input）
 * 4. PermissionEngine.check()（若声明了 tool.permission）：
 *    - allow → 继续
 *    - ask   → 抛 ToolPermissionAskRequiredError（交给上层处理用户交互）
 *    - deny  → 抛 ToolPermissionDeniedError
 * 5. tool.call() 真正调用（含耗时统计、AbortSignal 中断检查）
 * 6. outputSchema 校验（soft 模式降级为日志，默认抛错）
 * 7. PostHook 管道（可修改 result）+ 超大结果截断
 */
export class ToolPipeline {
  private readonly checkPermission?: ToolPipelineOptions['checkPermission']
  private readonly preHooks: ToolPreHook[]
  private readonly postHooks: ToolPostHook[]
  private readonly softOutputSchema: boolean
  private readonly resultMaxChars: number

  constructor(options: ToolPipelineOptions = {}) {
    this.checkPermission = options.checkPermission
    this.preHooks = options.preHooks ?? []
    this.postHooks = options.postHooks ?? []
    this.softOutputSchema = options.softOutputSchema ?? false
    this.resultMaxChars = options.resultMaxChars ?? 200_000
  }

  /** 新增 PreHook（链式调用） */
  addPreHook(hook: ToolPreHook): this {
    this.preHooks.push(hook)
    return this
  }

  /** 新增 PostHook（链式调用） */
  addPostHook(hook: ToolPostHook): this {
    this.postHooks.push(hook)
    return this
  }

  /**
   * 执行一次工具调用（7 步生命周期）
   */
  async execute(
    tool: Tool,
    rawInput: unknown,
    ctx: ToolContext,
    onProgress?: (p: unknown) => void
  ): Promise<ToolResult> {
    const startedAt = performance.now()

    // --- Step 1: inputSchema 硬校验 + Step 2: 语义校验（validateInput）---
    //
    // ⚠️ 这两步的失败**也必须**让 PostHook 看到：它们挡在 Step 7 之前，直接 throw 会让
    // 所有 PostHook 消费方（遥测 tool.fail / skill-forge 失败轨迹）完全看不到这类失败。
    // 真机代价：同一次会话 6 次丢入参，bash 的 3 次（工具内 return COMMAND_REQUIRED）上报了，
    // read_file 的 3 次（inputSchema 抛错）没上报 —— 只用遥测算失败率会系统性偏低一半。
    // 统一走 `_throwToolFailureWithHooks`：归一化 → 喂 PostHook → 原样 rethrow。
    let input: unknown
    try {
      const parseResult = tool.inputSchema.safeParse(rawInput)
      if (!parseResult.success) {
        throw new ToolSchemaError(tool.id, 'input', parseResult.error)
      }
      input = parseResult.data

      if (tool.validateInput) {
        try {
          await tool.validateInput(input as any, ctx)
        } catch (err) {
          throw new ToolValidationError(tool.id, err)
        }
      }
    } catch (err) {
      return await this._throwToolFailureWithHooks(err, tool, rawInput, ctx)
    }

    // --- 构造 preHook context ---
    const preCtx: ToolPreHookContext = {
      tool,
      input,
      ctx,
      toolUseId: ctx.toolUseId,
    }

    // --- Step 3: PreHook 洋葱管道 + Step 4 权限 + Step 5 tool.call ---
    // PreHook 采用洋葱模型：第一个 hook 的 next 是第二个 hook，... 最后一个 hook 的 next = doExecute()
    const index = 0
    const doExecute = async (finalInput: unknown = input): Promise<ToolResult> => {
      input = finalInput

      // Step 4: 权限检查（声明了 permission + 有 checkPermission 实现时）
      if (tool.permission && this.checkPermission) {
        const permReq: PermissionRequest = {
          toolKey: tool.permission.key,
          patterns: tool.permission.extractPatterns(input as any),
          input,
          denyPatterns: tool.permission.extractDenyPatterns?.(input as any),
          // 会话归属：询问接缝（asker）是全局单槽，多宿主并存时靠它路由。
          // 从 ctx 取而非从 input 取 —— 归属是"谁在调"，不是工具参数的一部分。
          sessionId: ctx.sessionId,
        }
        const decision = await Promise.resolve(this.checkPermission(permReq))
        // 允许插件通过 updatedInput 重写输入（Claude Code 风格）
        if (decision.updatedInput !== undefined) {
          input = decision.updatedInput
        }
        switch (decision.behavior) {
          case 'deny':
            throw new ToolPermissionDeniedError(tool.id, permReq.toolKey, permReq.patterns)
          case 'ask':
            throw new ToolPermissionAskRequiredError(tool.id, permReq.toolKey, permReq.patterns)
          case 'allow':
          default:
            // 放行
            break
        }
      }

      // 中断检查
      ctx.signal.throwIfAborted?.()

      // Step 5: tool.call() 真正执行
      const callStartedAt = performance.now()
      const result0 = await tool.call(input as any, ctx, onProgress)
      const callDurationMs = performance.now() - callStartedAt

      // 附加耗时元数据
      const result: ToolResult = {
        ...result0,
        meta: {
          durationMs: callDurationMs,
          ...(result0.meta ?? {}),
        },
      }

      // --- Step 6: outputSchema 校验（可选）---
      if (tool.outputSchema && result.ok && result.output !== undefined) {
        const r = tool.outputSchema.safeParse(result.output)
        if (!r.success) {
          if (this.softOutputSchema) {
            // soft：仅日志，不抛错
            ctx.log?.error?.('outputSchema failed', { toolId: tool.id, error: r.error })
          } else {
            throw new ToolSchemaError(tool.id, 'output', r.error)
          }
        } else {
          result.output = r.data
        }
      }

      // --- 截断超大结果（string / object→JSON.stringfy→截断→转回字符串提示）---
      this.truncateLargeResult(result, this.resultMaxChars)

      // 附加总耗时 meta
      result.meta = {
        ...(result.meta ?? {}),
        totalDurationMs: performance.now() - startedAt,
      }
      return result
    }

    // PreHook 洋葱调用链
    const dispatch = async (hookIndex: number, currentInput: unknown): Promise<ToolResult> => {
      if (hookIndex >= this.preHooks.length) {
        return doExecute(currentInput)
      }
      const hook = this.preHooks[hookIndex]!
      // 每个 hook 的 preCtx 能看到最新 input
      const c: ToolPreHookContext = { ...preCtx, input: currentInput }
      return hook(c, async (modifiedInput?: unknown): Promise<ToolResult> => {
        return dispatch(hookIndex + 1, modifiedInput ?? currentInput)
      })
    }

    // PostHook 在**成功路径**上按顺序跑
    const postCtx: ToolPostHookContext = {
      tool,
      input,
      ctx,
      toolUseId: ctx.toolUseId,
    }

    let result: ToolResult
    try {
      result = await dispatch(index, input)
    } catch (err) {
      // Step 3（preHook 拦截）/ Step 4（权限拒绝）/ Step 5 / Step 6（outputSchema）
      // 也是"先 throw、后跳过 Step 7"，同样交给统一的失败路径处理。
      // 归一化后的结果只**喂给 PostHook**，然后原样 rethrow —— 调用方（core 的
      // safeExecuteTool）仍按错误名判定权限拒绝、异常语义与模型看到的消息都不变。
      return await this._throwToolFailureWithHooks(err, tool, input, ctx)
    }

    // --- Step 7: PostHook 管道（按顺序）---
    for (const hook of this.postHooks) {
      result = await Promise.resolve(hook(postCtx, result))
    }

    return result
  }

  /**
   * 抛错前先让 PostHook 看到这次失败，然后原样抛出。
   *
   * PostHook 的消费方是"观测类"插件（遥测细分 kind、技能轨迹、失败回写记忆）。它们此前只能在
   * Step 7 被调用，于是**所有挡在 Step 7 之前的失败**（Step 1/2/3/4/6）对它们全部不可见。
   * 真机铁证：`telemetry.permission.deny` 与 `telemetry.doomloop` 两类 kind 全仓 0 条。
   *
   * 两条边界：
   * - `ToolPermissionAskRequiredError` 是"请去问用户"的**控制流信号**，不是失败，不上报
   *   （当失败计入会把权限交互的失败率算高）；
   * - PostHook 自己抛错**不能顶掉原始错误**（否则"到底为什么失败"彻底失真），只记日志。
   */
  private async _throwToolFailureWithHooks(
    err: unknown,
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
  ): Promise<never> {
    if ((err as { name?: string } | undefined)?.name !== 'ToolPermissionAskRequiredError') {
      try {
        const postCtx: ToolPostHookContext = { tool, input, ctx, toolUseId: ctx.toolUseId }
        let r = normalizeToolError(err)
        for (const hook of this.postHooks) {
          r = await Promise.resolve(hook(postCtx, r))
        }
      } catch (hookErr) {
        ctx.log?.error?.('postHook failed on error path', { toolId: tool.id, error: hookErr })
      }
    }
    throw err
  }

  /** 截断超大 ToolResult 输出（仅用于展示层提示，不破坏原结构时尽量保留） */
  private truncateLargeResult(result: ToolResult, maxChars: number): void {
    if (!result.ok || result.output === undefined) return
    if (typeof result.output === 'string') {
      if (result.output.length > maxChars) {
        const truncated = result.output.slice(0, maxChars)
        result.output = truncated + `\n... [truncated, original length=${result.output.length}]` as any
      }
    } else {
      // 对象/数组：尝试 JSON.stringify 估计大小，超了则提示并替换
      try {
        const s = JSON.stringify(result.output)
        if (s.length > maxChars) {
          result.output = s.slice(0, maxChars) + `\n... [truncated, original length=${s.length}]` as any
        }
      } catch {
        // 不可序列化忽略
      }
    }
  }
}
