/**
 * 配置模型与配置层语义检查（P0 收尾 S2 第一步：自 @harness/cli 上移）
 *
 * 这一层回答的是「config.json 写了什么、生效了没有」，与 `./provider.ts`（分母从哪来）分开：
 *   - `HarnessConfig` + `AcpScopeSection`：配置模型本身；
 *   - `ModelResolution` / `resolveModelArg`：`/model <arg>` 的解析（见其注释）；
 *   - `validateProviderConfigs` / `checkProviderConfigs` / `formatApiKeyTag` / `findTokenOnlyDuplicates`：
 *     Provider 配置校验与展示口径；
 *   - `toAcpConfig` / `toAcpScope` / `toAcpScopeMap`：结构化字段 → acp-kernel config 的**唯一一份**翻译；
 *   - `check*Config`（compression / compaction / memory / telemetry）+ `checkCompactionReachability`：
 *     各段的「未知键被静默丢弃 / 取值拼错静默降级」检查 —— 本仓"静默失效"老病的正面防线；
 *   - `buildConfigOverview` / `formatProviderTypeList` / `buildProviderTypesSection`：配置概览文案。
 *
 * ## 为什么上移（而不是留在 cli）
 * `boot()` 直接依赖上面几乎每一项（装配 ACP 要 `toAcpConfig`、跑各段检查、构造窗口表、写启动横幅）。
 * P0 要把 `boot` 搬进本包，host 又**不能反向 import cli** ⇒ 这一层必须一起上移。
 *
 * ## 与 `ProviderWindowConfigSource` 窄类型的关系
 * 窗口推导（`./provider.ts`）刻意只声明自己真读的两个字段，因此**不需要** `HarnessConfig`；
 * 反过来这里是宽类型，传给 `buildProviderWindowTable` 天然兼容（依赖倒置，不是两份定义）。
 *
 * 本文件全部是**纯函数、无 IO**（`lazyMockProvider` / `lazyAnthropicProvider` 除外，它们只做惰性
 * `import()`）。cli 侧保持 re-export，导出面逐字不变。
 */
import type { ChatProvider } from '@harness/core'
import type { AgentPlugin, ProviderConfig, ProviderTypeRegistry } from '@harness/plugin'
import type { McpServerEntry } from '@harness/mcp-server-registry'
import type { MockProviderConfig } from '@harness/provider-mock'
import type { CompactOptions } from '@harness/session'
import { lazyImport } from './lazy'
import {
  buildProviderWindowTable,
  formatModel,
  isUsableWindow,
  normalizeProviderConfigs,
  parseModelSpec,
  resolveContextWindowTokens,
} from './provider'
import type { ProviderConfigIssue, ResolvedProviderConfig } from './provider'


/**
 * ACP「作用域档位」段：`compression.subagent` 与 `compression.perAgent[<agentId>]`。
 *
 * 字段刻意与 `compression` 顶层**同形**（少了 `tokenCalibration` / `tokenCalibrationScale`）：
 * 折算口径与 acp-kernel 注入的 `countTokens` 是**同一个函数**，全进程只能有一把尺子。
 * 按档位分化必然让"占用率"与"阈值"不同源 —— 本仓早年"显示 26% 实际已 103%"就是这一类。
 *
 * 生效优先级（后写覆盖前写）：**顶层 → `subagent`（子会话）→ `perAgent[agentId]`**。
 */
export interface AcpScopeSection {
  /** 该档位的上下文窗口覆盖；缺省沿用顶层推导值（`compression.modelContextLimit → 默认 Provider → 200000`） */
  modelContextLimit?: number
  /** 该档位的压缩提示注入策略（`'off'` = 前缀提示 / 尾部手册 / nudge 三处全静默） */
  manualInjection?: 'on-demand' | 'always' | 'off'
  /** 层保留：保留最近 N 条原始消息 */
  preserveRecentMessages?: number
  /** 层保留：最近 N tokens 的原始上下文始终保留不压缩 */
  preserveRecentTokens?: number
  /** 块"存活次数"达该值才升层 */
  promotionThreshold?: number
  /**
 * t1/t2/t3 各层压缩触发阈值。
 * **只收这两个键** —— 内核 `TierConfig` 的 `enabled` 等其余字段写进 `config.tiers`
 * （结构化口只暴露常用键，避免同一个东西两套写法）。
 */
  tiers?: {
    tier2Trigger?: number
    tier3Trigger?: number
  }
  /**
 * 上下文压力档位（nudge 触发阈值）。
 * **只收这三个占用率百分比键** —— 内核 `NudgeConfig` 的其余 10 个字段（`growthFloor` /
 * `growthCap` / `growthRatio` / `minGrowthFloor` / `minGrowthRatio` / `frequency` / `force` /
 * `iterationThreshold` / `tier2GrowthMultiplier` / `minPressureBenefitTokens`）写进
 * `config.nudge`。写在 `nudge` 里会被校验器抓出，告警会直接指明该写到哪。
 */
  nudge?: {
    maxContextLimitPct?: number
    minContextLimitPct?: number
    emergencyThresholdPct?: number
  }
  /** 高级透传：其余 kernel config（compress / truncate / absorb / protectedTools 等） */
  config?: Record<string, unknown>
}

export interface HarnessConfig {
  /** 默认 Agent ID */
  agentId?: string
  /** 默认 Provider id（如 anthropic / openai / gemini / 自定义，来自 config.providers） */
  provider?: string
  /** 默认模型 ID（如 claude-3-5-sonnet，或 openai/gpt-4o 跨 Provider 指定） */
  model?: string
  /** Anthropic API Key（可选，便于命令行快捷配置） */
  anthropicApiKey?: string
  /** 多 Provider 定义：可同时注册多个（anthropic / openai / gemini / mock + 任意 OpenAI 兼容端点如 DeepSeek / Ollama） */
  providers?: ProviderConfig[]
  /**
   * Agent 工具/能力覆盖：`[{ id, tools, mcpServers, excludeMcpServers }]`，启动时按 id 覆盖合并到对应 Agent。
   * 由 `/tools` 等插件持久化；缺省 Agent 为 tools:['*']（全部），配置指定数组则收窄。
   * mcpServers/excludeMcpServers：Agent 级 MCP server 白名单/黑名单（声明式，见 .md frontmatter 同名字段）。
   */
  agents?: Array<{
    id: string
    tools?: string[]
    mcpServers?: string[]
    excludeMcpServers?: string[]
  }>
  /**
   * MCP Server 装配列表：从 config.json 以 JSON 形式新增外部 MCP server（stdio/sse/http）。
   * 元素复用 McpServerConfig 字段 + enabled（服务器级）、tools（工具级）开关。
   * 启动时经 cli.mcp.configure Hook 注入 mcp-server-registry 插件；/mcp 命令可即时启用/禁用并写回。
   */
  mcpServers?: McpServerEntry[]
  /**
   * 内置插件启用列表（**声明式，无需写 `.harness/plugins/*.ts`**）。
   *
   * 元素取 BuiltinPluginRegistry 的 id，例如 `["code-intel", "subagent", "coordinator"]`。
   * 依赖按插件上的 dependsOn 自动补齐（如 coordinator → subagent、computer-use → mcp.server-registry），
   * 安装顺序由 core 的拓扑排序保证（宿主先装）；未登记的 id 只告警、不阻断启动。
   * 与外部插件目录并存时按 id 去重（外部插件目录优先，便于临时替换实现）。
   *
   * 这里的插件实例一律用**无参工厂**创建：需要的配置从别处来（子 Agent 定义取 AgentRuntime
   * 注册表、coordinator 的 forceAsync 走 HARNESS_FORCE_ASYNC 环境变量）；要带参装配
   * （如自定义 subagents 数组）请改用外部插件目录 `.harness/plugins/*.ts` + 下方 `allowPluginCode`。
   */
  plugins?: string[]
  /**
   * 长期记忆（`@harness/memory`）的参数覆盖，**与 `plugins: ["memory"]` 配合**。
   *
   * 只覆盖参数、不负责启用：启用仍看 `plugins` 里有没有 `"memory"`（写了本段却未启用会告警）。
   * 这是目前唯一"带参装配"的内置插件 —— `plugins` 数组只表达「启用」，而记忆的攒批轮数、
   * 注入上限这类参数需要按人/按项目调，且不宜写死在组合根。
   */
  memory?: {
    /**
     * 攒批轮数：记忆**文件**变更后，最多再等几轮才把新内容换进 system prompt。
     *
     * 一轮 = 一次「用户输入 → Agent 跑完」（**不是**一次模型调用；一轮内多步只算一轮）。
     * `0` = 立即生效；缺省 **15**。期间若发生上下文压缩则提前发布（那时缓存本就失效，
     * system 变更搭车不额外花钱）。它的定位是「防静默失效的兜底」，不是节流目标。
     */
    flushAfterTurns?: number
    /** 记忆索引注入上限（行，缺省 200）；超出部分不会被加载 */
    maxLines?: number
    /** 记忆索引注入上限（字节，缺省 25600） */
    maxBytes?: number
    /** 只保留 `/memory` 命令、完全不做注入（对照实验用） */
    disableInjection?: boolean
  }
  /**
   * 是否允许加载**外部插件目录里的代码**（`.harness/plugins/*.ts|js|mjs`，默认 **false**）。
   *
   * 为什么默认关：那些文件是可执行代码。若无条件 `import()`，克隆一个带 `.harness/plugins`
   * 的仓库、在该目录里跑一次 harness 就会执行他人代码（代码注入）。声明式 `plugins` 数组已能
   * 覆盖内置能力，绝大多数场景不需要开这个闸。
   *
   * 注意：开闸后**不会**为插件目录补任何 node_modules 软链（那等于把 harness 内核依赖树暴露
   * 给工作目录下的任意文件），插件需放在能解析到其依赖的位置。
   */
  allowPluginCode?: boolean
  /** 开启文件快照 + /revert 能力（默认 false）；CLI `--snapshot` 优先覆盖此行 */
  snapshot?: boolean
  /**
   * 启动时自动恢复上次会话（默认 **true**）。
   * 规则：不带 `-s/--session` 启动 REPL/TUI 时，取「当前工作目录」内 updatedAt 最新的
   * 会话继续；目录不匹配的会话不会被误恢复。`--no-resume` 可临时关闭。
   */
  autoResume?: boolean
  /**
   * 兼容的嵌套写法（表现同顶层 snapshot）：`{ "harness": { "snapshot": true } }`。
   * 若顶层 snapshot 未填，则回退读此字段。
   */
  harness?: { snapshot?: boolean }
  /**
   * 通用遥测（本地采集为主 + 可选 OTLP）。**写出 `telemetry` 段才装配** `@harness/telemetry`
   * 插件（默认不启用，避免生成遥测文件）；开启后按会话写
   * `dataDir/sessions/{sessionId}.telemetry.jsonl`（bus 事件 → 统一 envelope），
   * 附带崩溃兜底（SIGTERM/SIGHUP / uncaughtException → telemetry.crash）。
   */
  telemetry?: {
    /** 总开关（默认 true，仅在该段存在时生效） */
    enabled?: boolean
    /** 会话文件路径生成（缺省 `{dataDir}/sessions/{sessionId}.telemetry.jsonl`） */
    path?: string
    /** 批量 flush 间隔 ms（缺省 500） */
    debounceMs?: number
    /** 是否挂崩溃兜底（缺省 true） */
    crash?: boolean
    /** 跨会话匿名 user id（缺省从 `.config-key` 派生，仅供聚合，非明文） */
    userId?: string
    /** 可选 OTLP 上报：endpoint 非空才启用（collector 根地址，如 `https://collector:4318`） */
    otlp?: {
      /** 总开关（默认 true，endpoint 非空即启用） */
      enabled?: boolean
      /** collector 端点；为空则完全不上报 */
      endpoint?: string
      /** 附加请求头（如 API key） */
      headers?: Record<string, string>
    }
  }
  /**
   * ACP 上下文压缩配置（`compression.enabled: true` 开启才装配 @harness/acp-context 插件）。
   * 装配后运行 @harness/acp-context 的 runPreModel：保留历次折叠的 source:'acp' 压缩块到统一块模型。
   */
  compression?: {
    /** 是否启用 ACP 上下文压缩（默认 false）。 */
    enabled?: boolean
    /**
     * 按上下文窗口自动推导 compression/nudge 参数（默认 false = 用下面的原始参数控制）。
     *
     * 开启后 `preserveRecentTokens` / `nudge.*` / `compress.minCompressRange` 会按
     * `modelContextLimit` 推导（见 docs/acp-context-config.md §7.4）；**显式写出**的字段
     * 仍优先覆盖推导值，故可「自动打底 + 手工钉一两个键」。
     */
    autoTune?: boolean
    /**
     * token 折算口径（默认 `'auto'`）。
     *
     * - `'auto'`：与 acp-kernel 共用 `defaultCountTokens` —— 中日韩字符 1 token/字、
     *   其余 4 字符/token。**英文会话与旧口径逐位等价**；中文会话修正原先约 4 倍的低估
     *   （旧口径下中文占用率恒显示真值的 1/4，`maxContextLimitPct` /
     *   `emergencyThresholdPct` 等百分比闸门整体偏晚，折叠会被拖到真实已超窗之后）。
     * - `'chars4'`：旧口径，一律 `chars/4`。仅作回退与 A-B 对照。
     */
    tokenCalibration?: 'auto' | 'chars4'
    /**
     * 本地 token 估算的**额外校正系数**（缺省 1 = 不校正，保持既有行为）。
     *
     * 本地口径与 provider 实际计费口径不是同一把尺子。真机实测（DeepSeek / deepseek-flash，
     * 临时 dataDir 跑 3 轮）稳定为 **1.33**（provider 输入 ÷ 本地**整包**估算 = 1.328 / 1.342 /
     * 1.337 / 1.332）⇒ 本地系统性低估约 25%。后果是 occupancy 与 tier 阈值整体偏保守
     * （报"占 26.9%"时实际约 35%），压缩迟迟不触发。
     *
     * 取值方法：看遥测 `providerCache.calibration`（每轮都会打），连续几轮稳定即可取该值。
     * 系数与模型/语料相关（中文 vs 英文 vs 大量 JSON 各不相同），所以**不设默认值**，由实测决定。
     */
    tokenCalibrationScale?: number
    /**
     * 模型上下文窗口（输入 tokens）显式覆盖。缺省时按「当前默认 Provider 的
     * providers[].contextWindowTokens → 插件默认 200_000」推导。
     */
    modelContextLimit?: number
    /** 覆盖 t1/t2/t3 压缩及压缩哲学的提示词（key 见 acp-kernel Prompts，load-bearing） */
    prompts?: Partial<import('acp-kernel').Prompts>
    /** 整段覆盖压缩系统提示（优先级最高，覆盖 prompts 合成的压缩系统提示） */
    systemPrompt?: string
    /** 层保留：保留最近 N 条原始消息（其余按窗口折叠） */
    preserveRecentMessages?: number
    /** 层保留：最近 N tokens 的原始上下文始终保留不压缩 */
    preserveRecentTokens?: number
    /** 块"存活次数"达该值才升层（promotionThreshold，kernel 默认 5；设极大如 1e9 可选为不升层） */
    promotionThreshold?: number
    /**
 * t1/t2/t3 各层压缩触发阈值。
 * **只收这两个键** —— 内核 `TierConfig` 的 `enabled` 等其余字段写进 `config.tiers`
 * （结构化口只暴露常用键，避免同一个东西两套写法）。
 */
    tiers?: {
      /** 活跃 t1 块数达到该值才把部分 t1 蒸馏为 t2（默认 5） */
      tier2Trigger?: number
      /** 活跃 t2 块数达到该值才把部分 t2 压缩为 t3（默认 10） */
      tier3Trigger?: number
    }
    /**
 * 上下文压力档位（nudge 触发阈值）。
 * **只收这三个占用率百分比键** —— 内核 `NudgeConfig` 的其余 10 个字段（`growthFloor` /
 * `growthCap` / `growthRatio` / `minGrowthFloor` / `minGrowthRatio` / `frequency` / `force` /
 * `iterationThreshold` / `tier2GrowthMultiplier` / `minPressureBenefitTokens`）写进
 * `config.nudge`。写在 `nudge` 里会被校验器抓出，告警会直接指明该写到哪。
 */
    nudge?: {
      /** 触发"效率型"压缩提醒的上下文占用下限（默认 0.2 = 20%） */
      maxContextLimitPct?: number
      /** nudge 提示的上下文占用下限（默认 0.02） */
      minContextLimitPct?: number
      /** 紧急提醒占用：≥ 该比例无条件提醒（默认 0.98） */
      emergencyThresholdPct?: number
    }
    /**
     * 压缩提示注入策略（缺省 `'on-demand'`）。
     *
     * - `'on-demand'`：占用率接近压缩阈值时才注入完整手册，否则只在前缀留一行极简提示
     * - `'always'`：每轮把完整手册注入前缀（旧行为，便于 A-B 对照）
     * - `'off'`：前缀提示 / 尾部手册 / nudge 三处全静默
     *
     * 与它叠加的还有一条**能力判据**：Agent 的工具白名单里确实没有 `compress` 时，无论这里
     * 怎么配都不注入 —— 只读 worker 拿着手册只会照着拼入参、然后撞 `TOOL_NOT_ALLOWED`
     * （真机会话 `s_1790685043685_1p8sw` 里 12 次全撞）。`systemPrompt` 被显式赋值时不受两者影响。
     */
    manualInjection?: 'on-demand' | 'always' | 'off'
    /**
     * **子会话档位**：对有父会话（`parentId` —— subagent / swarm 派生的会话）叠加的配置。
     *
     * 不配 = 不叠加 ⇒ 子会话逐位沿用顶层（即改造前的行为）。典型用法：子会话预算小，
     * 把保留量压小，或于白名单里没有 `compress` 的 worker 直接关掉手册注入。
     */
    subagent?: AcpScopeSection
    /**
     * **按 Agent 的档位**（key = agent 定义 id，如 `reader` / `reviewer` / `lead`）。
     *
     * 比 `subagent` 更具体（同样是子会话，"只读速读员"与"实现者"的合理档位并不相同），
     * 故优先级更高：`perAgent[agentId]` > `subagent` > 顶层。
     */
    perAgent?: Record<string, AcpScopeSection>
    /** 高级透传：不入上面的结构化字段的其它 kernel config（compress / truncate / protectedTools 等） */
    config?: Record<string, unknown>
    /**
     * 运行时遥测（默认开启）：每轮 preModel 把压缩指标 / ACP 缓存命中 / 配置快照
     * 追加写入 `dataDir/sessions/{sessionId}.telemetry.jsonl`。
     * 关闭后不写任何遥测文件（零开销）。离线用 `bench/report.ts` 分析。
     */
    telemetry?: { enabled?: boolean }
  }
  /**
   * **会话压缩**（`session.compact` / `/compact`，与上面的 ACP 是**两套独立机制**）。
   *
   * 区别：ACP 按 token 分级折叠、**每轮自动**、摘要可解压回溯；会话压缩按**消息条数**裁剪
   * （丢弃旧消息原文 + 留一段摘要），只在 REPL 启动与 `/compact` 时判定一次。
   * 两者可并存，但会话压缩会丢原文，与 ACP 同时激进启用会造成重复压缩。
   */
  compaction?: {
    /**
     * 压缩策略（默认 `'summary'`）
     * - `prune`：只截断旧消息，不生成摘要（信息全丢）
     * - `summary`：对被截断的窗口做轻量规则摘要（按消息类型统计 + 首尾要点）
     * - `agent`：调 LLM 生成摘要（失败自动 fallback 到 summary）
     */
    strategy?: 'prune' | 'summary' | 'agent'
    /**
     * 自动压缩的触发阈值（估算 token 占「可用窗口 = 窗口 − reservedTokens」的百分比，默认 80）。
     *
     * 注意：窗口**不在本段配置**，按 `compaction.contextWindowTokens → compression.modelContextLimit
     * → 本会话实际端点（Provider / 模型）的窗口 → 默认 Provider 的窗口 → 200000` 推导
     * （见 resolveCompactionWindow）。早些版本 core 内硬编码 200000，于是 providers 写 102400 时
     * 阈值算成 136000 > 窗口本身 ⇒ 永远压不到；再往后是"只按默认 Provider 算"—— 会话用 `/model`
     * 切到小窗口模型后阈值同样落到真实窗口之外。想临时指定窗口可用 `contextWindowTokens` 覆盖。
     */
    autoCompactThresholdPct?: number
    /** 给摘要生成预留的 tokens（默认 30000，参考 Claude Code 的 20K max output + 13K buffer） */
    reservedTokens?: number
    /**
     * 上下文窗口显式覆盖。缺省时按上述优先级推导（推荐留空，跟着 Provider 走）。
     * 乱填会把阈值算到窗口之上或之下，同样导致"配了却不生效"。
     */
    contextWindowTokens?: number
    /** 压缩后保留的最近消息数（user+assistant 算一对；默认 10 条 = 5 轮对话） */
    keepRecentMessages?: number
    /** 摘要最大字符数（仅 summary / agent 策略；默认 8000） */
    summaryMaxChars?: number
    /**
     * token 折算口径（默认 `'auto'` = CJK 感知，与 ACP 层同一口径）。
     * `'chars4'` 会让中文会话的估算只有真值约 1/4 ⇒ 自动压缩更难触发。仅作回退与 A-B 对照。
     */
    tokenCalibration?: 'auto' | 'chars4'
    /** 本地估算的额外校正系数（缺省 1）；与 compression.tokenCalibrationScale 同源，保持一致 */
    tokenCalibrationScale?: number
  }
}

/**
 * `/model <arg>` 的解析结果。把「用户敲什么」与「怎么切」解耦：
 * 由本函数一次性判定，调用方只负责按 kind 执行/提示，不再散落 `split('/')` 式判断。
 */
export type ModelResolution =
  /** 命中某个配置实例（按序号 / 实例 id / 模型名），provider 与 model 一并确定 */
  | { kind: 'instance'; providerId: string; modelId?: string; matchedBy: 'index' | 'id' | 'model'; index: number }
  /** 显式 `provider/model`（provider 未在当前进程装配时 providerKnown=false，调用方提示即可） */
  | { kind: 'explicit'; providerId?: string; modelId: string; providerKnown: boolean }
  /** 裸模型名：挂到当前 Provider（仅当未配置 providers 实例时允许，保持旧用法） */
  | { kind: 'model'; modelId: string }
  /** 命中多个实例：必须消歧，不静默选第一个 */
  | { kind: 'ambiguous'; arg: string; candidates: Array<{ index: number; id: string; model?: string; type: string; matchedBy: 'id' | 'model' }> }
  /** 序号越界 */
  | { kind: 'bad-index'; arg: string; total: number }
  /** arg 是 Provider **类型**名而非实例，且没有可用模型 → 给出用法提示，不切换 */
  | { kind: 'type-hint'; arg: string }
  /** 已配置 providers 但 arg 谁都不匹配 → 拒绝并提示（避免把拼错的 provider 名当成模型名写进配置） */
  | { kind: 'not-found'; arg: string }

/**
 * 解析 `/model` 的实参，支持四种写法（优先级由高到低）：
 *
 * 1. `id/model`        显式跨 Provider（旧写法，保留）；provider 是否已装配由调用方提示
 * 2. `序号`（如 `2`）    按 `/model ?` 列表序号选择
 * 3. `实例 id`          如 `hy3` —— 命中实例即同时采用其配置的 model
 * 4. `模型名`           如 `hy3`（与实例 id 同名时同样命中）；跨实例重名则要求消歧
 *
 * 兜底（**仅当未配置任何 providers 实例时**）：裸模型名挂当前 Provider，
 * 即 `/model claude-3-7-sonnet` 这类未声明实例的老用法。
 *
 * 为什么要有 `not-found`：旧实现把任何裸词都当模型名写进 config.model，
 * 于是 `/model local-hy4` 这种「想切 provider 却拼错」会静默落成垃圾模型名。
 * 现在只要配置了 providers，裸词必须命中实例，否则明确报错。
 *
 * 纯函数，便于单测。
 */
export function resolveModelArg(
  arg: string,
  providers: ResolvedProviderConfig[],
  knownRefs: Iterable<string> = [],
): ModelResolution {
  const raw = arg.trim()
  // 已知引用 = 显式传入的（实例 id / Provider 类型 / 默认 provider）+ 本次传入的实例 id
  const known = new Set<string>(knownRefs)
  for (const p of providers) known.add(p.id)

  // 1) 显式 provider/model
  if (raw.includes('/')) {
    const { providerId, modelId } = parseModelSpec(raw)
    const providerKnown = !providerId || known.has(providerId)
    return { kind: 'explicit', providerId, modelId, providerKnown }
  }

  // 2) 纯数字 → 列表序号（1-based）
  if (/^\d+$/.test(raw)) {
    const idx = Number(raw)
    if (idx >= 1 && idx <= providers.length) {
      const p = providers[idx - 1]
      return { kind: 'instance', providerId: p.id, modelId: p.model, matchedBy: 'index', index: idx }
    }
    return { kind: 'bad-index', arg: raw, total: providers.length }
  }

  // 3/4) 按实例 id 或模型名命中（两者取并集：仅唯一命中才自动选择）
  const hits = providers
    .map((p, i) => ({ p, index: i + 1 }))
    .filter(({ p }) => p.id === raw || p.model === raw)
  if (hits.length === 1) {
    const { p, index } = hits[0]
    return {
      kind: 'instance',
      providerId: p.id,
      modelId: p.model,
      matchedBy: p.id === raw ? 'id' : 'model',
      index,
    }
  }
  if (hits.length > 1) {
    return {
      kind: 'ambiguous',
      arg: raw,
      candidates: hits.map(({ p, index }) => ({
        index,
        id: p.id,
        model: p.model,
        type: p.type,
        matchedBy: (p.id === raw ? 'id' : 'model') as 'id' | 'model',
      })),
    }
  }

  // 5) 谁都不匹配：未配置 providers → 旧用法（裸模型名挂当前 Provider）
  if (!providers.length) {
    if (known.has(raw)) return { kind: 'type-hint', arg: raw }
    return { kind: 'model', modelId: raw }
  }
  if (known.has(raw)) return { kind: 'type-hint', arg: raw }
  return { kind: 'not-found', arg: raw }
}

/** 把解析结果格式化成可展示的 `provider/model` 引用（用于「已切换模型 X」回显与持久化前预览） */
export function formatResolutionRef(r: ModelResolution): string | undefined {
  switch (r.kind) {
    case 'instance':
      return formatModel(r.providerId, r.modelId) ?? r.providerId
    case 'explicit':
      return formatModel(r.providerId, r.modelId) ?? r.modelId
    case 'model':
      return r.modelId
    default:
      return undefined
  }
}

// ------------------------------------------------------------------------
// 2.3 密钥加密存储 + 配置校验（多 Provider 健壮性）
// ------------------------------------------------------------------------

// ProviderConfigIssue 已上移到 @harness/host（见上方 B 档说明）。

/**
 * 校验 providers 数组与默认 provider（已知类型由 ProviderTypeRegistry 动态提供，插件化）：
 * - type 未知 → 报错（列出已注册类型）
 * - 默认 provider 指向未定义的 id（非内置 mock/anthropic）→ 报错
 *
 * 注：id 的存在性/唯一性由 `normalizeProviderConfigs` 前置保证（缺省按 model 派生、重名加序号、
 * 显式重复报错），因此本函数收到的是已归一化的列表，`!pc.id` 分支仅为防御性兜底。
 */
export function validateProviderConfigs(
  providers: ProviderConfig[],
  defaultProviderId: string,
  knownTypes: Iterable<string>,
): ProviderConfigIssue[] {
  const issues: ProviderConfigIssue[] = []
  const seen = new Set<string>()
  const known = new Set(knownTypes)
  const knownTypesText = [...known].join(' / ') || '（无已注册类型）'
  providers.forEach((pc, i) => {
    if (!pc.id?.trim()) {
      issues.push({ index: i, message: `providers[${i}] 缺少 id（必须唯一）` })
      return
    }
    if (seen.has(pc.id)) {
      issues.push({ index: i, message: `providers[${i}].id "${pc.id}" 与前面的 provider 重复（id 必须唯一，否则后注册的会被覆盖）` })
    }
    seen.add(pc.id)
    if (!pc.type || !known.has(pc.type)) {
      issues.push({ index: i, message: `providers[${i}].type "${pc.type}" 未知（已注册类型：${knownTypesText}；可在 ~/.harness/plugins 或 .harness/plugins 中添加导出 providerTypeFactory 的插件扩展）` })
    }
  })
  if (defaultProviderId && defaultProviderId !== 'mock' && defaultProviderId !== 'anthropic' && !seen.has(defaultProviderId)) {
    issues.push({ index: -1, message: `默认 provider "${defaultProviderId}" 未在 providers 数组中定义（已注册类型：${knownTypesText}）` })
  }
  return issues
}

/**
 * 归一化 + 校验的组合入口（供 `config check` / `--check-config` 使用，与 boot 同一套语义）：
 * 先按 model 派生缺省 id（`normalizeProviderConfigs`），再校验 type / 默认 provider（`validateProviderConfigs`），
 * 返回归一化结果与扁平化的问题文本。避免「概览按派生 id 展示、校验却按原始 config 报 id 缺失」的不一致。
 */
export function checkProviderConfigs(
  rawProviders: ProviderConfig[],
  defaultProviderId: string,
  knownTypes: Iterable<string>,
): { providers: ResolvedProviderConfig[]; issues: string[] } {
  const { providers, issues: idIssues } = normalizeProviderConfigs(rawProviders)
  const issues = idIssues.map((i) => i.message)
  for (const iss of validateProviderConfigs(providers, defaultProviderId, knownTypes)) issues.push(iss.message)
  return { providers, issues }
}

/**
 * apiKey 展示标签（配置概览与 `/model` 列表共用，避免两处口径不一）：
 * - 未配置 → `（未配置）`
 * - 加密态（`enc:v1:`）→ `已加密`（无法回显指纹）
 * - `${ENV}` 引用 → `env(ENV)`（引用名非机密，可直接展示）
 * - 明文：默认脱敏为 `已配置`；`fingerprint` 时附末 4 位（`已配置(…AB12)`），
 *   供「同端点同模型、仅 token 不同」的实例之间互相区分。
 */
export function formatApiKeyTag(
  apiKey: string | undefined,
  opts: { fingerprint?: boolean } = {},
): string {
  const raw = apiKey?.trim()
  if (!raw) return '（未配置）'
  if (raw.startsWith('enc:v1:')) return '已加密'
  if (/^\$\{.*\}$/.test(raw)) return `env(${raw.slice(2, -1)})`
  if (!opts.fingerprint) return '已配置'
  return raw.length > 4 ? `已配置(…${raw.slice(-4)})` : '已配置'
}

/**
 * 找出「type + baseUrl + model 完全相同」的实例组——即**同配置不同 token**（或多端点同模型）的场景。
 *
 * 为什么要单独识别：这类实例的内容差异只在 apiKey 上，而 `/model ?` 列表里 type/baseUrl/model 全同、
 * 人眼无法区分；它们又只能靠 `normalizeProviderConfigs` 派生出的 `-2`/`-3` id 区分，而派生 id 与
 * **数组顺序绑定**（调整顺序后同名 id 会指向另一个 token），因此值得显式提示用户手写 id。
 *
 * `distinctKeys` = 组内不同 apiKey 的个数：1 表示完全重复（多余项，建议删除），>1 即同配置不同 token。
 * 纯函数，便于单测。
 */
export function findTokenOnlyDuplicates(providers: ResolvedProviderConfig[]): Array<{
  key: string
  members: ResolvedProviderConfig[]
  distinctKeys: number
}> {
  const groups = new Map<string, ResolvedProviderConfig[]>()
  for (const p of providers) {
    const key = `${p.type}|${p.baseUrl ?? ''}|${p.model ?? ''}`
    const list = groups.get(key)
    if (list) list.push(p)
    else groups.set(key, [p])
  }
  const out: Array<{ key: string; members: ResolvedProviderConfig[]; distinctKeys: number }> = []
  for (const [key, members] of groups) {
    if (members.length < 2) continue
    const distinctKeys = new Set(members.map((m) => m.apiKey ?? '')).size
    out.push({ key, members, distinctKeys })
  }
  return out
}

// ------------------------------------------------------------------------
// 2.4 compression 配置校验（未知键 / 非法取值）
// ------------------------------------------------------------------------

/**
 * 内核 `defaultConfig` 的合并尾部是 `{...base, ...overrides, 子树:{...}}` ⇒ **未知键被静默丢弃**；
 * 而 `tokenCalibration` 走的是 `=== 'chars4' ? 旧口径 : 自动`，拼错会**静默降级到默认值 auto**
 * （概览还照常显示"自动（CJK 感知）"，全无症状）。
 *
 * 后者的实际代价不是"少一行提示"而是**实验结论反向**：想用 `chars4` 做 A-B 对照组却写成
 * `'chars/4'`，两组都跑 auto ⇒ 实测差 ≈ 0 ⇒ 得出"两个口径没差"，而真相是差约 4 倍。
 *
 * 下列白名单刻意写成 `Record<keyof X, true>` 而不是 `string[]`：内核字段新增 / 改名时**编译期即报错**，
 * 白名单不会静默过期 —— 这是本函数能长期有效的唯一保证。
 */
const KERNEL_CONFIG_KEYS: Record<keyof import('acp-kernel').Config, true> = {
  tiers: true,
  nudge: true,
  promotionThreshold: true,
  truncate: true,
  compress: true,
  protectedTools: true,
  isToolProtected: true,
  preserveRecentMessages: true,
  preserveRecentTokens: true,
  modelContextLimit: true,
  absorb: true,
  messageFilters: true,
}
const KERNEL_TIER_KEYS: Record<keyof import('acp-kernel').TierConfig, true> = {
  enabled: true,
  tier2Trigger: true,
  tier3Trigger: true,
}
const KERNEL_NUDGE_KEYS: Record<keyof import('acp-kernel').NudgeConfig, true> = {
  maxContextLimitPct: true,
  minContextLimitPct: true,
  frequency: true,
  iterationThreshold: true,
  force: true,
  growthRatio: true,
  growthFloor: true,
  growthCap: true,
  minGrowthFloor: true,
  minGrowthRatio: true,
  emergencyThresholdPct: true,
  tier2GrowthMultiplier: true,
  minPressureBenefitTokens: true,
}
const KERNEL_COMPRESS_KEYS: Record<keyof import('acp-kernel').CompressValidationConfig, true> = {
  minCompressRange: true,
  maxSummaryLength: true,
  minSummaryLength: true,
}
const KERNEL_TRUNCATE_KEYS: Record<keyof import('acp-kernel').TruncateConfig, true> = { threshold: true }
const KERNEL_ABSORB_KEYS: Record<keyof import('acp-kernel').AbsorbConfig, true> = {
  enabled: true,
  toolName: true,
  minToolTokens: true,
  contextThresholdPct: true,
  excludeTools: true,
}
const PROMPT_KEYS: Record<keyof import('acp-kernel').Prompts, true> = {
  compressPhilosophy: true,
  howToCompressRules: true,
  tier2DistillRules: true,
  tier3CondenseRules: true,
}
/** compression 顶层合法键（与 HarnessConfig.compression 一一对应） */
const COMPRESSION_KEYS: Record<keyof NonNullable<HarnessConfig['compression']>, true> = {
  enabled: true,
  autoTune: true,
  tokenCalibration: true,
  tokenCalibrationScale: true,
  modelContextLimit: true,
  prompts: true,
  systemPrompt: true,
  preserveRecentMessages: true,
  preserveRecentTokens: true,
  promotionThreshold: true,
  tiers: true,
  nudge: true,
  config: true,
  telemetry: true,
  manualInjection: true,
  subagent: true,
  perAgent: true,
}
const COMPRESSION_TIER_KEYS: Record<keyof NonNullable<HarnessConfig['compression']>['tiers'], true> = {
  tier2Trigger: true,
  tier3Trigger: true,
}
const COMPRESSION_NUDGE_KEYS: Record<keyof NonNullable<HarnessConfig['compression']>['nudge'], true> = {
  maxContextLimitPct: true,
  minContextLimitPct: true,
  emergencyThresholdPct: true,
}
const COMPRESSION_TELEMETRY_KEYS: Record<keyof NonNullable<HarnessConfig['compression']>['telemetry'], true> = {
  enabled: true,
}
/** `compression.manualInjection` 合法取值 */
const MANUAL_INJECTION_MODES: ReadonlySet<string> = new Set(['on-demand', 'always', 'off'])
/** 作用域档位段（`compression.subagent` / `compression.perAgent[*]`）的合法键 */
const COMPRESSION_SCOPE_KEYS: Record<keyof AcpScopeSection, true> = {
  modelContextLimit: true,
  manualInjection: true,
  preserveRecentMessages: true,
  preserveRecentTokens: true,
  promotionThreshold: true,
  tiers: true,
  nudge: true,
  config: true,
}

/**
 * 校验一棵**子树的结构化口**（`.tiers` / `.nudge`；顶层与档位共用），并为"写错了口"指路。
 *
 * 本仓的压缩配置有**两条**通往同一棵内核子树的写法：结构化口（`nudge` / `tiers`）与透传口
 * （`config.nudge` / `config.tiers`）。前者刻意只收少数常用键，内核字段的其余部分必须写后者 ——
 * 但两个口名字相邻，文档正文里参数又统一记作 `nudge.growthFloor`（那是**字段名**，不是可写路径），
 * 于是"把内核字段写进结构化口"成了最容易踩的错法（真机反馈正是
 * `compression.subagent.nudge.growthFloor`）。
 *
 * 只说"未被识别"帮助有限：那个字段确实是内核的、也确实有地方能写 —— 用户只知道"没生效"，
 * 不知道"该搬到哪"。故这里把**能生效的那条路径**直接写进告警。
 * 拼错的键（如 `growthFloar`）不匹配内核字段名 ⇒ 维持朴素文案，不会被指到错误的路上去。
 */
function checkSubtreeUnknown(
  obj: unknown,
  allowed: readonly string[],
  kernel: readonly string[],
  path: string,
  escapePrefix: string,
  push: (paths: string[], tail: string) => void,
): void {
  if (!isPlainObject(obj)) return
  const ok = new Set(allowed)
  const isKernelKey = new Set(kernel)
  for (const k of Object.keys(obj)) {
    if (ok.has(k)) continue
    push(
      [`${path}.${k}`],
      isKernelKey.has(k)
        ? `未被识别（${path} 结构化口只收 ${allowed.join(' / ')}）—— 该键是内核字段，请写到 ${escapePrefix}.${k} 才生效`
        : '未被识别，该配置不会生效',
    )
  }
}

/**
 * 校验一个作用域档位段（`compression.subagent` / `compression.perAgent[*]`）。
 *
 * 与顶层走**同一套**校验：只查顶层会让"顶层写错会告警、档位里写错静默"成为新的静默失效面，
 * 而档位恰恰是最容易写错的地方（`.perAgent` 的 key 是 agent id，写错了没有任何反馈）。
 */
function checkCompressionScope(
  scope: unknown,
  path: string,
  push: (paths: string[], tail: string) => void,
): void {
  if (!isPlainObject(scope)) return
  push(collectUnknown(scope, Object.keys(COMPRESSION_SCOPE_KEYS), path), '未被识别，该档位不会生效')
  if (scope.manualInjection !== undefined && !MANUAL_INJECTION_MODES.has(scope.manualInjection as string)) {
    push(
      [`${path}.manualInjection`],
      `取值 ${JSON.stringify(scope.manualInjection)} 未知（可选：on-demand / always / off），已按 on-demand 处理`,
    )
  }
  // 子树结构化口：只收少数常用键，其余内核字段要写 `config.*` —— 走带"指路"的校验
  checkSubtreeUnknown(
    scope.tiers,
    Object.keys(COMPRESSION_TIER_KEYS),
    Object.keys(KERNEL_TIER_KEYS),
    `${path}.tiers`,
    `compression${path}.config.tiers`,
    push,
  )
  checkSubtreeUnknown(
    scope.nudge,
    Object.keys(COMPRESSION_NUDGE_KEYS),
    Object.keys(KERNEL_NUDGE_KEYS),
    `${path}.nudge`,
    `compression${path}.config.nudge`,
    push,
  )
  if (isPlainObject(scope.config)) {
    push(collectUnknown(scope.config, Object.keys(KERNEL_CONFIG_KEYS), `${path}.config`), '内核 Config 无此字段，该配置不会生效')
    push(collectUnknown(scope.config.tiers, Object.keys(KERNEL_TIER_KEYS), `${path}.config.tiers`), '内核 TierConfig 无此字段，该配置不会生效')
    push(collectUnknown(scope.config.nudge, Object.keys(KERNEL_NUDGE_KEYS), `${path}.config.nudge`), '内核 NudgeConfig 无此字段，该配置不会生效')
    push(collectUnknown(scope.config.compress, Object.keys(KERNEL_COMPRESS_KEYS), `${path}.config.compress`), '内核 CompressValidationConfig 无此字段，该配置不会生效')
    push(collectUnknown(scope.config.truncate, Object.keys(KERNEL_TRUNCATE_KEYS), `${path}.config.truncate`), '内核 TruncateConfig 无此字段，该配置不会生效')
    push(collectUnknown(scope.config.absorb, Object.keys(KERNEL_ABSORB_KEYS), `${path}.config.absorb`), '内核 AbsorbConfig 无此字段，该配置不会生效')
  }
}

/**
 * 结构化口 → 内核 loose config 的**共用翻译**：顶层 `compression` 与档位段走同一份。
 *
 * 为什么必须共用：此前顶层（boot 内联）与档位各写一份，两处一旦漂移就是"顶层这么写生效、
 * 档位那样写不生效" —— 本仓最典型的"配了却不生效"。合成一处后漂移无处可生。
 *
 * **子树的合并语义**：`config.tiers` / `config.nudge` 与结构化口 `tiers` / `nudge` 会同时
 * 描述同一棵子树（文档 §6 的推荐用法正是"结构化口写常用的几个 + `config.*` 补其余"），
 * 故按**深合并**处理、结构化口压在上面。曾经是整体替换（`out.nudge = {三个 pct 键}`），
 * 于是 `config: { nudge: { growthFloor: 75000 } }` 遇上 `nudge: { maxContextLimitPct: 0.65 }`
 * 会把 `growthFloor` **静默丢掉** —— 两个键都在"已配置"清单里，却只有一个活着。
 */
export function toAcpConfig(section: AcpScopeSection): Record<string, unknown> {
  // `config` 铺在最下层（高级透传），显式结构化字段压在它上面
  const out: Record<string, unknown> = { ...(section.config ?? {}) }
  /** 同名透传子树（若有）—— 结构化口要合并在它**之上**，而不是把它整个replace掉 */
  const carried = (key: string): Record<string, unknown> =>
    isPlainObject(out[key]) ? (out[key] as Record<string, unknown>) : {}
  if (section.preserveRecentMessages != null) out.preserveRecentMessages = section.preserveRecentMessages
  if (section.preserveRecentTokens != null) out.preserveRecentTokens = section.preserveRecentTokens
  if (section.promotionThreshold != null) out.promotionThreshold = section.promotionThreshold
  if (section.tiers) {
    out.tiers = {
      ...carried('tiers'),
      ...(section.tiers.tier2Trigger != null ? { tier2Trigger: section.tiers.tier2Trigger } : {}),
      ...(section.tiers.tier3Trigger != null ? { tier3Trigger: section.tiers.tier3Trigger } : {}),
    }
  }
  if (section.nudge) {
    out.nudge = {
      ...carried('nudge'),
      ...(section.nudge.maxContextLimitPct != null ? { maxContextLimitPct: section.nudge.maxContextLimitPct } : {}),
      ...(section.nudge.minContextLimitPct != null ? { minContextLimitPct: section.nudge.minContextLimitPct } : {}),
      ...(section.nudge.emergencyThresholdPct != null ? { emergencyThresholdPct: section.nudge.emergencyThresholdPct } : {}),
    }
  }
  return out
}

/**
 * 把 `compression.subagent` / `compression.perAgent[*]` 段翻成 ACP 插件选项的形状。
 *
 * 翻译本体与顶层共用 {@link toAcpConfig}（顶层用 `preserveRecentTokens`、档位里就得写
 * `config.preserveRecentTokens` 这种"同一个东西两套写法"正是"配了却不生效"的温床）；
 * 这里只补两个**仅档位需要单独传**的字段。
 *
 * 返回 `undefined` 表示"该段未配置" ⇒ 调用方不传该选项，插件侧不叠加（缺省零行为变更）。
 */
export function toAcpScope(section: AcpScopeSection | undefined): Record<string, unknown> | undefined {
  if (!section) return undefined
  const out = toAcpConfig(section)
  // 这两个不进内核 config：窗口由插件单独取用（`defaultConfig` 的 overrides 会盖掉第一个参数，
  // 见 acp-context 的 `stripWindow`），`manualInjection` 是插件自己的键。
  if (section.modelContextLimit != null) out.modelContextLimit = section.modelContextLimit
  if (section.manualInjection != null) out.manualInjection = section.manualInjection
  return out
}

/** 批量翻译 `perAgent` 表；空表返回 `undefined`（不传选项，与没配等价） */
export function toAcpScopeMap(
  map: Record<string, AcpScopeSection> | undefined,
): Record<string, unknown> | undefined {
  if (!map) return undefined
  const out: Record<string, unknown> = {}
  for (const [agentId, section] of Object.entries(map)) {
    const scoped = toAcpScope(section)
    if (scoped) out[agentId] = scoped
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 收集 `obj` 里不属于 `allowed` 的键，返回 `[问题路径]`（空值/非对象视为无问题） */
function collectUnknown(obj: unknown, allowed: Iterable<string>, path: string): string[] {
  if (!isPlainObject(obj)) return []
  const ok = new Set(allowed)
  return Object.keys(obj)
    .filter((k) => !ok.has(k))
    .map((k) => `${path}.${k}`)
}

/**
 * 校验 `config.json → compression`：未知键 + `tokenCalibration` 非法取值。
 *
 * 纯函数（无 IO），便于单测。返回**人类可读**的问题列表（空数组表示无问题）。
 *
 * 形参刻意标为 `unknown` 而不是 `HarnessConfig['compression']`：本函数存在的理由就是
 * "config.json 由 `JSON.parse` 得来、形状完全不受编译期保护"。若标成结构化类型，反而会让
 * 调用方误以为形状已被类型系统保证（TS 也**不会**拦住运行时的多余键，只拦字面量）。
 *
 * 检查深度只到"内核真正消费的那一层"：比 `config.nudge.xxx` 更深的键不报 ——
 * 内核读的就是 `tiers` / `nudge` / `compress` / `truncate` / `absorb` 这几个子树本身，
 * 越级的字段既不会被读取也没有默认值可言。
 */
export function checkCompressionConfig(c: unknown): string[] {
  if (!isPlainObject(c)) return []
  const out: string[] = []
  const push = (paths: string[], tail: string): void => {
    for (const p of paths) out.push(`compression${p} ${tail}`)
  }

  push(collectUnknown(c, Object.keys(COMPRESSION_KEYS), ''), '未被识别，该配置不会生效')
  if (c.tokenCalibration !== undefined && c.tokenCalibration !== 'auto' && c.tokenCalibration !== 'chars4') {
    out.push(
      `compression.tokenCalibration 取值 ${JSON.stringify(c.tokenCalibration)} 未知（可选：auto / chars4），已按默认 auto 处理`,
    )
  }
  if (
    c.tokenCalibrationScale !== undefined &&
    !(typeof c.tokenCalibrationScale === 'number' && Number.isFinite(c.tokenCalibrationScale) && c.tokenCalibrationScale > 0)
  ) {
    out.push(
      `compression.tokenCalibrationScale 取值 ${JSON.stringify(c.tokenCalibrationScale)} 非法（应为 > 0 的数），已按不校正（1）处理`,
    )
  }
  // 子树结构化口：只收少数常用键，其余内核字段要写 `config.*` —— 走带"指路"的校验
  checkSubtreeUnknown(
    c.tiers,
    Object.keys(COMPRESSION_TIER_KEYS),
    Object.keys(KERNEL_TIER_KEYS),
    '.tiers',
    'compression.config.tiers',
    push,
  )
  checkSubtreeUnknown(
    c.nudge,
    Object.keys(COMPRESSION_NUDGE_KEYS),
    Object.keys(KERNEL_NUDGE_KEYS),
    '.nudge',
    'compression.config.nudge',
    push,
  )
  push(collectUnknown(c.telemetry, Object.keys(COMPRESSION_TELEMETRY_KEYS), '.telemetry'), '未被识别，该配置不会生效')
  push(collectUnknown(c.prompts, Object.keys(PROMPT_KEYS), '.prompts'), '不是 acp-kernel Prompts 的字段，该配置不会生效')
  if (c.manualInjection !== undefined && !MANUAL_INJECTION_MODES.has(c.manualInjection as string)) {
    out.push(
      `compression.manualInjection 取值 ${JSON.stringify(c.manualInjection)} 未知（可选：on-demand / always / off），已按 on-demand 处理`,
    )
  }
  // 作用域档位
  checkCompressionScope(c.subagent, '.subagent', push)
  if (isPlainObject(c.perAgent)) {
    for (const [agentId, section] of Object.entries(c.perAgent)) {
      checkCompressionScope(section, `.perAgent.${agentId}`, push)
    }
  }

  // config：高级透传，原样喂给内核 defaultConfig 的 overrides ⇒ 按内核 Config 形状校验
  if (isPlainObject(c.config)) {
    push(collectUnknown(c.config, Object.keys(KERNEL_CONFIG_KEYS), '.config'), '内核 Config 无此字段，该配置不会生效')
    push(collectUnknown(c.config.tiers, Object.keys(KERNEL_TIER_KEYS), '.config.tiers'), '内核 TierConfig 无此字段，该配置不会生效')
    push(collectUnknown(c.config.nudge, Object.keys(KERNEL_NUDGE_KEYS), '.config.nudge'), '内核 NudgeConfig 无此字段，该配置不会生效')
    push(collectUnknown(c.config.compress, Object.keys(KERNEL_COMPRESS_KEYS), '.config.compress'), '内核 CompressValidationConfig 无此字段，该配置不会生效')
    push(collectUnknown(c.config.truncate, Object.keys(KERNEL_TRUNCATE_KEYS), '.config.truncate'), '内核 TruncateConfig 无此字段，该配置不会生效')
    push(collectUnknown(c.config.absorb, Object.keys(KERNEL_ABSORB_KEYS), '.config.absorb'), '内核 AbsorbConfig 无此字段，该配置不会生效')
  }
  return out
}

/** compaction 段合法键（与 HarnessConfig.compaction 一一对应） */
const COMPACTION_KEYS: Record<keyof NonNullable<HarnessConfig['compaction']>, true> = {
  strategy: true,
  autoCompactThresholdPct: true,
  reservedTokens: true,
  contextWindowTokens: true,
  keepRecentMessages: true,
  summaryMaxChars: true,
  tokenCalibration: true,
  tokenCalibrationScale: true,
}
const COMPACTION_STRATEGIES: ReadonlySet<string> = new Set(['prune', 'summary', 'agent'])

// 上下文窗口推导（resolveContextWindowTokens / buildProviderWindowTable / isUsableWindow）已上移到
// @harness/host —— P0 第三步（B 档）。窗口这个分母必须全进程一份口径（显示 / 压缩阈值 / ACP
// 占用率三处对不上就是「显示 26% 实际已 103%」那类静默故障），故与配置归一化同处一包。


/**
 * 某个会话**实际**使用的端点（`providerId` / `modelId`）。
 *
 * 两者都可能缺：只绑了 Provider 没绑模型时 `modelId` 为空（用端点默认模型）；都没绑时两个都空
 * —— 查表侧把空字段当"未指定"处理，落回默认 Provider 的窗口。
 */
export interface SessionEndpoint {
  providerId?: string
  modelId?: string
}



/**
 * 按**本会话实际端点**解析上下文窗口 —— 会话压缩（compaction）全链的唯一入口：
 * `/compact`、启动时的自动压缩判定、`/stats` 与 TUI 的占用率展示都从这里取分母。
 *
 * 优先级（与 ACP 侧 `resolveContextWindowTokens` / acp-context 的 `scopeFor` 保持同一把尺子）：
 * `compaction.contextWindowTokens`（本段专用显式）→ `compression.modelContextLimit`（全局显式）
 * → 按本会话端点查表（`byProvider` → `byModel`）→ 默认 Provider 的窗口 → 200000。
 *
 * 为什么窗口不能只有一个数：Provider / 模型是**按 Agent 解析、会话内还能用 `/model` 切换**的
 * （core：`input.model?.providerId ?? agent.model?.providerId ?? 'default'`）。同一份 config 下
 * 不同会话的窗口**本来就不一样** —— 拿默认 Provider 的窗口当分母，会让小窗口会话的阈值算到
 * 自身窗口之外：真机形态（默认端点 300K、会话切到 hy3 200K）下阈值 = 95% × (300000 − 30000)
 * = 256500 > 200000，**自动压缩永远不触发**，而且没有任何症状（工具照常报数，只是分母不是本会话的）。
 *
 * 显式值排在推导前面是刻意的：`compaction.contextWindowTokens` / `compression.modelContextLimit`
 * 的文档语义就是"我不管端点是什么，就按这个数算"，排在后面等于让用户写了也不生效。
 *
 * `endpoint` 缺省（undefined）时逐位回到改造前的行为：查表落 `fallback`，而 fallback 就是
 * 默认 Provider 的窗口 —— 这是「缺省零行为变更」的保证点。
 */
export function resolveCompactionWindow(
  cfg: HarnessConfig,
  defaultProviderId: string,
  endpoint?: SessionEndpoint,
): number {
  const explicit = cfg.compaction?.contextWindowTokens ?? cfg.compression?.modelContextLimit
  if (explicit !== undefined) return explicit
  // 查表顺序与 acp-context 的 lookupProviderWindow 一致：实例维度（byProvider）最具体，先查。
  // 刻意不复用那份实现：acp-context 连带 acp-kernel，为 6 行代码在 CLI 启动路径上加载整棵内核
  // 不划算（同 lazyImport 的理由）。两者一致性由 cli.test.ts 的守卫用例对照钉住。
  const table = buildProviderWindowTable(cfg, defaultProviderId)
  const byProvider = endpoint?.providerId ? table.byProvider?.[endpoint.providerId] : undefined
  if (isUsableWindow(byProvider)) return byProvider
  const byModel = endpoint?.modelId ? table.byModel?.[endpoint.modelId] : undefined
  if (isUsableWindow(byModel)) return byModel
  return table.fallback
}

/** 校验 `config.json → compaction`：未知键 + `strategy` / `tokenCalibration` 非法取值 */
export function checkCompactionConfig(c: unknown): string[] {
  if (!isPlainObject(c)) return []
  const out: string[] = []
  for (const k of collectUnknown(c, Object.keys(COMPACTION_KEYS), 'compaction')) {
    out.push(`${k} 未被识别，该配置不会生效`)
  }
  if (c.strategy !== undefined && !COMPACTION_STRATEGIES.has(c.strategy as string)) {
    out.push(
      `compaction.strategy 取值 ${JSON.stringify(c.strategy)} 未知（可选：prune / summary / agent），已按默认 summary 处理`,
    )
  }
  if (c.tokenCalibration !== undefined && c.tokenCalibration !== 'auto' && c.tokenCalibration !== 'chars4') {
    out.push(
      `compaction.tokenCalibration 取值 ${JSON.stringify(c.tokenCalibration)} 未知（可选：auto / chars4），已按默认 auto 处理`,
    )
  }
  return out
}

/**
 * 会话压缩的 `CompactOptions`：配置 → core 的入参。
 *
 * 窗口**按会话实际端点解析**（见 {@link resolveCompactionWindow}），不是"一个全局数"：
 * `endpoint` 传本会话的端点；缺省时逐位回到「默认 Provider 口径」。调用方一律应该传 ——
 * 不传就等于把会话切过的模型/子 Agent 的端点一起忽略掉，分母错而无声。
 */
export function buildCompactionOptions(
  cfg: HarnessConfig,
  defaultProviderId: string,
  endpoint?: SessionEndpoint,
): CompactOptions {
  const k = cfg.compaction
  return {
    contextWindowTokens: resolveCompactionWindow(cfg, defaultProviderId, endpoint),
    ...(k?.strategy != null ? { strategy: k.strategy } : {}),
    ...(k?.keepRecentMessages != null ? { keepRecentMessages: k.keepRecentMessages } : {}),
    ...(k?.summaryMaxChars != null ? { summaryMaxChars: k.summaryMaxChars } : {}),
    ...(k?.autoCompactThresholdPct != null ? { autoCompactThresholdPct: k.autoCompactThresholdPct } : {}),
    ...(k?.reservedTokens != null ? { reservedTokens: k.reservedTokens } : {}),
    ...(k?.tokenCalibration != null ? { tokenCalibration: k.tokenCalibration } : {}),
    ...(k?.tokenCalibrationScale != null ? { tokenCalibrationScale: k.tokenCalibrationScale } : {}),
  }
}

/**
 * 会话压缩的**阈值可达性**提醒：阈值 = (窗口 − reservedTokens) × pct%，
 * 若阈值 ≥ 窗口，则无论会话多长都不可能自动触发 —— 配置写了一堆却零效果，且全程静默。
 *
 * 这条必须由配置算出而不是靠人记住：窗口来自 Provider，阈值来自本段配置，两边任一改动
 * 都可能悄悄越过这条线。返回 undefined 表示可达。
 *
 * 口径是**默认 Provider 的窗口**（这里拿不到会话，只能做配置级检查）。会话实际按自身端点解析
 * （见 {@link resolveCompactionWindow}），所以这条告警只保证「即使按默认口径也不可达」，
 * 不保证反过来：默认端点可达、而会话切到更小窗口端点后依然不可达。
 */
export function checkCompactionReachability(cfg: HarnessConfig, defaultProviderId: string): string | undefined {
  const opt = buildCompactionOptions(cfg, defaultProviderId)
  const window = opt.contextWindowTokens ?? 200_000
  const reserved = opt.reservedTokens ?? 30_000
  const pct = opt.autoCompactThresholdPct ?? 80
  const threshold = Math.floor((window - reserved) * (pct / 100))
  if (threshold < window) return undefined
  return (
    `会话压缩阈值（${threshold} tokens）≥ 上下文窗口（${window}），自动压缩永远不会触发。` +
    `请降低 compaction.autoCompactThresholdPct 或 reservedTokens，或确认 providers[].contextWindowTokens 填写正确`
  )
}

/** memory 段合法键（与 HarnessConfig.memory 一一对应） */
const MEMORY_KEYS: Record<keyof NonNullable<HarnessConfig['memory']>, true> = {
  flushAfterTurns: true,
  maxLines: true,
  maxBytes: true,
  disableInjection: true,
}

/**
 * 概览里显示的默认上限。刻意抄一份常量而不是静态 import `@harness/memory`：
 * CLI 对插件一律懒加载（`lazyImport`），为两个数字在启动路径上加载整个插件模块不划算。
 * 改动时需与 memory 包的 `MEMORY_INDEX_MAX_LINES` / `MEMORY_INDEX_MAX_BYTES` 保持一致。
 */
const MEMORY_INDEX_LINES_HINT = 200
const MEMORY_INDEX_BYTES_HINT = 25 * 1024

/**
 * 校验 `config.json → memory`：未知键 + 类型/取值。纯函数（无 IO），便于单测。
 *
 * 为什么必须校验：这段配置**没有任何一处会主动报错** —— 键拼错会被静默忽略（记忆照旧工作、
 * 看起来一切正常），而 `flushAfterTurns` 若写成字符串（JSON 没有类型保护），
 * `dirtyTurns >= flushAfter` 恒为 false ⇒ 兜底永不触发，表现是"改了记忆好几轮都不生效"。
 * 偏偏记忆是「开了就不再盯着」的能力，只能靠这里的白名单比对暴露出来。
 */
export function checkMemoryConfig(c: unknown): string[] {
  if (!isPlainObject(c)) return []
  const out: string[] = []
  for (const k of collectUnknown(c, Object.keys(MEMORY_KEYS), 'memory')) {
    out.push(`${k} 未被识别，该配置不会生效`)
  }
  const numeric: Array<[string, unknown]> = [
    ['memory.flushAfterTurns', c.flushAfterTurns],
    ['memory.maxLines', c.maxLines],
    ['memory.maxBytes', c.maxBytes],
  ]
  for (const [path, v] of numeric) {
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      out.push(`${path} 应为非负整数，收到 ${JSON.stringify(v)} ⇒ 已忽略该项`)
    }
  }
  if (typeof c.disableInjection === 'boolean' || c.disableInjection === undefined) {
    // ok
  } else {
    out.push(`memory.disableInjection 应为布尔值，收到 ${JSON.stringify(c.disableInjection)} ⇒ 已忽略该项`)
  }
  if (c.maxLines === 0 || c.maxBytes === 0) {
    out.push('memory.maxLines / maxBytes 为 0 会让索引完全不注入（等于只留 /memory 命令），请确认是否有意如此')
  }
  return out
}

/**
 * `config.json → memory` → memory 插件的构造参数。
 *
 * **逐项显式映射**（而不是整段 spread）：JSON 里的值不受类型系统保护，非法值若直接透传，
 * 插件侧只会"按默认以外的怪值工作"（如 `flushAfterTurns: "15"` ⇒ 兜底永不触发）。
 * 这里只放行校验过的值，非法项一律丢弃（并在 checkMemoryConfig 里给出提示）。
 */
export function memoryPluginOptions(c: HarnessConfig['memory']): Record<string, unknown> {
  if (!c) return {}
  const out: Record<string, unknown> = {}
  const int = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
  const flush = int(c.flushAfterTurns)
  if (flush !== undefined) out.flushAfterTurns = flush
  const lines = int(c.maxLines)
  if (lines !== undefined) out.maxLines = lines
  const bytes = int(c.maxBytes)
  if (bytes !== undefined) out.maxBytes = bytes
  if (typeof c.disableInjection === 'boolean') out.disableInjection = c.disableInjection
  return out
}

/**
 * `config.json → telemetry` → telemetry 插件的构造参数（含秘设备注入前的显式映射）。
 *
 * 与 memory 同模式：逐项显式映射，非法值丢弃并在 checkTelemetryConfig 里提示。
 * 返回 `null` 表示「未装配」（config 没写 telemetry 段）——保持默认零影响。
 */
export function telemetryPluginOptions(c: HarnessConfig['telemetry']): Record<string, unknown> | null {
  if (!c) return null
  const out: Record<string, unknown> = {}
  if (typeof c.enabled === 'boolean') out.enabled = c.enabled
  if (typeof c.path === 'string' && c.path.length > 0) out.pathBuilder = (_sid?: string) => c.path as string
  if (typeof c.debounceMs === 'number' && Number.isInteger(c.debounceMs) && c.debounceMs >= 0) out.debounceMs = c.debounceMs
  if (typeof c.crash === 'boolean') out.crash = c.crash
  if (typeof c.userId === 'string' && c.userId.length > 0) out.userID = c.userId
  if (c.otlp && typeof c.otlp === 'object') {
    const o: Record<string, unknown> = {}
    if (typeof c.otlp.enabled === 'boolean') o.enabled = c.otlp.enabled
    if (typeof c.otlp.endpoint === 'string' && c.otlp.endpoint.length > 0) o.endpoint = c.otlp.endpoint
    if (c.otlp.headers && typeof c.otlp.headers === 'object' && !Array.isArray(c.otlp.headers)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(c.otlp.headers)) if (typeof v === 'string') headers[k] = v
      if (Object.keys(headers).length) o.headers = headers
    }
    out.otlp = o as import('@harness/telemetry').OtlpOptions
  }
  return out
}

const TELEMETRY_OTLP_KEYS: Record<string, true> = { enabled: true, endpoint: true, headers: true }

const TELEMETRY_KEYS: Record<keyof NonNullable<HarnessConfig['telemetry']>, true> = {
  enabled: true,
  path: true,
  debounceMs: true,
  crash: true,
  userId: true,
  otlp: true,
}

/**
 * 校验 `config.json → telemetry`：未知键。纯函数（无 IO），便于单测。
 */
export function checkTelemetryConfig(c: unknown): string[] {
  if (!isPlainObject(c)) return []
  const out: string[] = []
  // 附可用键清单：`telemetry` 段**没有**压缩那样的"高级透传口"可以兜底 —— 写错的键在本段
  // 没有别的去处，只报"未被识别"会逼用户翻源码找合法键（真机反馈 `telemetry.store` 即此形态：
  // 想配"目录 + debounce"，而目录本就是 `sessions`、debounce 是顶层键）。
  const telKeys = Object.keys(TELEMETRY_KEYS).join(' / ')
  for (const k of collectUnknown(c, Object.keys(TELEMETRY_KEYS), 'telemetry')) {
    out.push(`${k} 未被识别，该配置不会生效（可用键：${telKeys}）`)
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
    out.push(`telemetry.enabled 应为布尔值，收到 ${JSON.stringify(c.enabled)} ⇒ 已忽略该项`)
  }
  if (c.path !== undefined && (typeof c.path !== 'string' || c.path.length === 0)) {
    out.push(`telemetry.path 应为非空字符串，已忽略该项`)
  }
  if (c.debounceMs !== undefined && (typeof c.debounceMs !== 'number' || !Number.isInteger(c.debounceMs) || c.debounceMs < 0)) {
    out.push(`telemetry.debounceMs 应为非负整数，收到 ${JSON.stringify(c.debounceMs)} ⇒ 已忽略该项`)
  }
  if (c.crash !== undefined && typeof c.crash !== 'boolean') {
    out.push(`telemetry.crash 应为布尔值，已忽略该项`)
  }
  if (c.userId !== undefined && (typeof c.userId !== 'string' || c.userId.length === 0)) {
    out.push(`telemetry.userId 应为非空字符串，已忽略该项`)
  }
  // otlp 子段（白名单里的 otlp 是被 type 保护的；这里只查子键）
  if (isPlainObject(c.otlp)) {
    for (const k of collectUnknown(c.otlp, Object.keys(TELEMETRY_OTLP_KEYS), 'telemetry.otlp')) {
      out.push(`${k} 未被识别，该配置不会生效（可用键：${Object.keys(TELEMETRY_OTLP_KEYS).join(' / ')}）`)
    }
    if (c.otlp.enabled !== undefined && typeof c.otlp.enabled !== 'boolean') {
      out.push(`telemetry.otlp.enabled 应为布尔值，已忽略该项`)
    }
    if (c.otlp.endpoint !== undefined && (typeof c.otlp.endpoint !== 'string' || c.otlp.endpoint.length === 0)) {
      out.push(`telemetry.otlp.endpoint 应为非空字符串，已忽略该项`)
    }
    if (c.otlp.headers !== undefined && !isPlainObject(c.otlp.headers)) {
      out.push(`telemetry.otlp.headers 应为对象，已忽略该项`)
    }
  }
  return out
}

/** 配置概览（--check-config / /config 共用），apiKey 默认脱敏展示 */
export function buildConfigOverview(cfg: HarnessConfig, defaultProviderId: string): string {
  const lines: string[] = []
  lines.push(`默认 provider：${cfg.provider ?? defaultProviderId}`)
  if (cfg.model) lines.push(`默认 model：${cfg.model}`)
  const c = cfg.compression
  // 窗口必须与 boot 装配处、会话压缩处同一套推导：compression.modelContextLimit →
  // 默认 provider 的 contextWindowTokens → 兜底 200_000。此前概览直接兜底 200000、会话压缩
  // 在 core 内另摊一个硬编码 200000，于是同一份 config 能同时得出 200000 和 102400 两个窗口
  // ——按概览做的判断全部落空，会话压缩则因阈值 136000 > 真实窗口而从不触发。
  const acpWindow = resolveContextWindowTokens(cfg, defaultProviderId)
  const acpMode = c?.autoTune
    ? `按窗口自动适配参数（autoTune，窗口 ${acpWindow}）`
    : `原始压缩参数控制（autoTune 关闭）`
  const acpCaliber = c?.tokenCalibration === 'chars4' ? 'token 口径 chars/4（旧）' : 'token 口径 自动（CJK 感知）'
  lines.push(
    c?.enabled
      ? `上下文压缩（ACP）：启用 fitWindow=${acpWindow} · ${acpMode} · ${acpCaliber}${c.prompts ? ' · 自定义提示词' : ''}`
      : '上下文压缩（ACP）：未启用（config.json → compression.enabled: true 开启）'
  )
  // compression 的未生效项：未知键被内核静默丢弃、tokenCalibration 拼错会静默降级到 auto，
  // 两者都「看起来完全正常」，只能在概览/check 时显式比对白名单才发现（详见 checkCompressionConfig 注释）。
  const compressionIssues = checkCompressionConfig(c)
  if (compressionIssues.length) {
    lines.push('上下文压缩（ACP）配置告警（下列项不会被应用）：')
    for (const m of compressionIssues) lines.push(`  - ${m}`)
  }
  // 会话压缩（/compact 与启动自动判定）：与 ACP 是两套机制，单独展示窗口与阈值，
  // 因为"阈值 ≥ 窗口 ⇒ 永远不触发"这类问题只能在这儿看出来。
  {
    const k = cfg.compaction
    const opt = buildCompactionOptions(cfg, defaultProviderId)
    const window = opt.contextWindowTokens ?? 200_000
    const reserved = opt.reservedTokens ?? 30_000
    const pct = opt.autoCompactThresholdPct ?? 80
    const threshold = Math.floor((window - reserved) * (pct / 100))
    // 端点分化提示：providers 里窗口不一致时，"概览上这个窗口"只对**默认 Provider** 成立。
    // 不写出来就会被读成"我的会话就是这个分母"——真机形态：默认端点 300K、会话切到 hy3（200K），
    // 阈值按 300K 算成 256500 > 200000 ⇒ 概览看着一切正常，自动压缩却永不触发。
    // 显式配了窗口（compaction / compression.modelContextLimit）就没有分化可言，不提示。
    const winTable = buildProviderWindowTable(cfg, defaultProviderId)
    const distinctWindows = new Set([
      ...Object.values(winTable.byProvider ?? {}),
      ...Object.values(winTable.byModel ?? {}),
    ])
    const endpointNote =
      k?.contextWindowTokens === undefined && c?.modelContextLimit === undefined && distinctWindows.size > 1
        ? '（默认 Provider 口径；各会话按自身端点解析）'
        : ''
    lines.push(
      `会话压缩（/compact）：窗口 ${window}${endpointNote} · 阈值 ${threshold} tokens（${pct}% ×（窗口−${reserved}））· ` +
        `策略 ${opt.strategy ?? 'summary'} · 保留最近 ${opt.keepRecentMessages ?? 10} 条 · ` +
        `token 口径 ${opt.tokenCalibration === 'chars4' ? 'chars/4（旧）' : '自动（CJK 感知）'}`
        + (typeof c?.tokenCalibrationScale === 'number' && c.tokenCalibrationScale !== 1
          ? ` × 校正 ${c.tokenCalibrationScale}`
          : '') +
        (k ? '' : '（全部默认值，config.json → compaction 可配）'),
    )
    const compactionIssues = checkCompactionConfig(k)
    for (const m of compactionIssues) lines.push(`  - ${m}`)
    const unreachable = checkCompactionReachability(cfg, defaultProviderId)
    if (unreachable) lines.push(`  - ${unreachable}`)
  }
  {
    // 长期记忆：既报「有没有开」，也报「参数最终会怎么用」—— 攒批轮数这类值一旦写错
    // （拼错键名 / 传成字符串）全都不会报错、只是行为不同，只能在概览里对照。
    const m = cfg.memory
    const declared = (cfg.plugins ?? []).some((id) => String(id).trim() === 'memory')
    const opt = memoryPluginOptions(m)
    lines.push(
      declared
        ? `长期记忆（memory）：已启用 · 索引上限 ${opt.maxLines ?? MEMORY_INDEX_LINES_HINT} 行 / ` +
            `${opt.maxBytes ?? MEMORY_INDEX_BYTES_HINT} 字节 · 文件变更攒批 ${
              opt.flushAfterTurns === undefined ? '15（默认）' : `${opt.flushAfterTurns} 轮`
            }` +
            (opt.disableInjection ? ' · 已关闭注入（只留 /memory 命令）' : '')
        : '长期记忆（memory）：未启用（config.json → plugins 加 "memory" 开启；可选 memory 段调参）',
    )
    for (const issue of checkMemoryConfig(m)) lines.push(`  - ${issue}`)
    if (m && !declared) lines.push('  - memory 段已写但未启用 ⇒ 该段不会生效（需 plugins 里加 "memory"）')
  }
  // 通用遥测：报「装没装」「开没开」「崩溃兜底挂没挂」「OTLP 上不上报」。
  {
    const t = cfg.telemetry
    const opt = telemetryPluginOptions(t)
    const on = opt && opt.enabled !== false
    // OTLP 真开 = 有 otlp 段、endpoint 非空、且 otlp.enabled !== false
    const otlp = opt?.otlp as { endpoint?: string; enabled?: boolean } | undefined
    const otlpOn = !!otlp && otlp.enabled !== false && !!otlp.endpoint
    let otlpTag = ''
    if (otlp && otlp.enabled !== false) {
      otlpTag = otlpOn
        ? ` · OTLP 上报开启（${otlp.endpoint}）`
        : ' · OTLP 已配置但无有效 endpoint（不会上报）'
    }
    lines.push(
      t
        ? `遥测（telemetry）：${on ? '已启用 · ' + (opt?.pathBuilder ? '自定义路径' : '会话级 dataDir/sessions/*.telemetry.jsonl') : '已装配但关闭（telemetry.enabled: false）'}${opt?.crash === false ? ' · 崩溃兜底已关' : ' · 崩溃兜底开启'}${otlpTag}`
        : '遥测（telemetry）：未启用（config.json 写 telemetry 段开启；默认不生成遥测文件）',
    )
    for (const issue of checkTelemetryConfig(t)) lines.push(`  - ${issue}`)
  }
  const rawProviders = cfg.providers ?? []
  if (!rawProviders.length) {
    lines.push('providers：（未配置，使用内置 mock / anthropic）')
    return lines.join('\n')
  }
  // 展示归一化后的实例 id（省略 id 的项按 model 派生），与实际装配结果一致
  const providers = normalizeProviderConfigs(rawProviders).providers
  lines.push('providers：')
  for (const pc of providers) {
    const api = formatApiKeyTag(pc.apiKey)
    const isDefault = pc.id === (cfg.provider ?? defaultProviderId) ? ' ← 默认' : ''
    const path = [pc.type, pc.baseUrl ?? '（默认端点）', pc.apiPath ?? ''].filter(Boolean).join(' · ')
    lines.push(`  - ${pc.id}${isDefault}  type=${path}  model=${pc.model ?? '（Provider 默认）'}  apiKey=${api}`)
  }
  return lines.join('\n')
}

/**
 * 生成"可用的 Provider 类型"清单（从 ProviderTypeRegistry 展示元信息构建）。
 * 关键：只读 registry.listMeta()，不触发任何 Provider 模块加载；因此即使插件未完全加载
 * （惰性描述符已登记），help / config check 也能列出并给人机交互友好的用法提示。
 */
export function formatProviderTypeList(registry: ProviderTypeRegistry, includeUsage = true): string {
  const metas = registry.listMeta()
  if (!metas.length) return '（无已注册 Provider 类型）'
  const width = Math.max(...metas.map((m) => m.type.length), 1)
  return metas
    .map((m) => {
      const label = m.type.padEnd(width)
      const tag = m.builtin ? '[内置]' : '[插件]'
      const key = m.requiresApiKey ? '（需 apiKey）' : ''
      const model = m.defaultModel ? `默认模型 ${m.defaultModel}` : '默认模型未指定'
      let line = `  ${label}  ${tag} ${m.description ?? m.type}${key}，${model}`
      if (includeUsage && m.usage) line += `，例 ${m.usage}`
      return line
    })
    .join('\n')
}

/** help / config check 结束时追加"可用的 Provider 类型"段落（含用法提示，不加载 Provider 模块） */
export function buildProviderTypesSection(registry: ProviderTypeRegistry): string {
  return `可用的 Provider 类型（未完全加载即可展示；调用对应 provider 时自动加载模块）：
${formatProviderTypeList(registry)}
  更多类型：在 ~/.harness/plugins 或 <project>/.harness/plugins 中用插件导出 providerTypeFactory 扩展；运行 \`harness config check\` 查看含插件的完整清单。
`
}
