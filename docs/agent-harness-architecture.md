# 插件化 Agent Harness 架构设计文档

## 一、设计理念与目标

### 1.1 参考来源与优点提炼

| 维度 | Claude Code 优点 | OpenCode 优点 |
|------|------------------|---------------|
| **架构分层** | 6 层严格解耦，执行内核完全独立可复用（REPL/SDK/MCP Server/Remote） | 4 层清晰分层，每层职责通俗化定义 |
| **扩展机制** | Skill 内嵌 Shell、条件触发 paths、MCP 双端、Swarm 后端可扩展 | Plugin Hooks 流水线（auth/chat.params/system.transform/compacting）、npm 插件热插拔 |
| **工具系统** | Tool 是运行时协议（并发安全/只读/破坏性/权限/UI/interrupt），并发分批调度，Pre-Hook Pipeline | Tool.define() + 独立 .txt 描述文件，Registry 统一注册，Agent 工具白名单过滤 |
| **安全策略** | Fail-Closed 默认值（所有新工具默认不可并发、非只读），MCP Skill 跳过 Shell 执行 | 路径级通配符权限（allow/deny/ask + 路径 glob），PermissionNext 分层匹配 |
| **多 Agent** | 三层体系：Subagent → Coordinator → Swarm，mailbox/task list/权限桥接 | Agent 配置化：权限/工具/模型/prompt 可自定义，subagent 分层 |
| **解耦方式** | QueryEngine 类多入口复用，AsyncLocalStorage 上下文隔离 | Bus 事件总线类型安全，Server-Sent Events 推送 |

### 1.2 核心设计原则

1. **Harness 内核与表现层完全解耦**：同一套执行内核可嵌入 SDK/CLI/IDE/Worker/Server 多形态
2. **一切能力皆可插件化**：工具、技能、Agent、Provider、甚至多 Agent 协作能力都以插件形式加载
3. **运行时协议优于函数接口**：Tool/Agent/Skill 是完整的生命周期协议对象，不只是 call()
4. **Fail-Closed 安全优先**：所有扩展点默认关闭，需显式声明能力边界
5. **Hooks 管道而非继承**：通过明确定义的 Hooks 让插件介入生命周期，而非基类继承

---

## 二、总体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          ① 入口 / 运行形态层                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   CLI    │  │   TUI    │  │   IDE    │  │  SDK/    │  │  Worker  │   │
│  │ (命令行) │  │ (终端UI) │  │ (ACP)    │  │ Library  │  │  (后台)  │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       └─────────────┴──────────────┴──────┬──────┴──────────────┘         │
│                                           │                                │
│                         ┌─────────────────▼──────────────────┐             │
│                         │       Harness Host (HTTP/进程内)    │             │
│                         └─────────────────┬──────────────────┘             │
└───────────────────────────────────────────┼────────────────────────────────┘
                                            │
┌───────────────────────────────────────────▼────────────────────────────────┐
│                          ② Harness 核心层 (Core)                           │
│                                                                            │
│  ┌──────────────────────────┐      ┌────────────────────────────────┐     │
│  │   Harness Instance       │──────▶     Plugin Manager             │     │
│  │  - 生命周期 create/start │      │  - load()/unload()/hotReload() │     │
│  │  - stop/suspend/resume   │      │  - Hooks Registry             │     │
│  │  - Context 容器          │      │  - 依赖图 & 加载顺序           │     │
│  └──────────────┬───────────┘      └──────────────┬─────────────────┘     │
│                 │                                   │                       │
│  ┌──────────────▼───────────────────────────────────▼─────────────────┐    │
│  │                    Bus 事件总线 (类型安全 Pub/Sub)                  │    │
│  └──────────────┬───────────────────┬───────────────────┬─────────────┘    │
│                 │                   │                   │                  │
│  ┌──────────────▼─────┐ ┌───────────▼─────────┐ ┌───────▼──────────────┐ │
│  │  Session Manager   │ │  Agent Runtime      │ │  Permission Engine   │ │
│  │  - 创建/持久化     │ │  - Query Engine     │ │  - 规则匹配          │ │
│  │  - Compaction      │ │  - Tool Pipeline    │ │  - 路径 glob         │ │
│  │  - Snapshot/Revert │ │  - Stream Processor │ │  - Ask/Allow/Deny    │ │
│  │  - Todo List       │ │  - Retry Loop       │ │  - 权限记忆          │ │
│  └──────────────┬─────┘ └───────────┬─────────┘ └───────┬──────────────┘ │
│                 │                   │                   │                │
│  ┌──────────────▼───────────────────▼───────────────────▼──────────────┐ │
│  │                      Context Provider (DI 容器)                      │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
                                            │
┌───────────────────────────────────────────▼────────────────────────────────┐
│                          ③ 能力协议层 (Capabilities)                        │
│                                                                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────────┐  │
│  │   Tool Protocol │  │   Skill Layer   │  │    Agent Definition      │  │
│  │  - call()       │  │  - Markdown     │  │  - 权限配置              │  │
│  │  - 并发安全声明 │  │  - 内嵌 Script  │  │  - 工具白名单            │  │
│  │  - 读写/破坏性  │  │  - paths 触发   │  │  - System Prompt 片段   │  │
│  │  - Pre/Post Hook│  │  - 变量替换     │  │  - 模型偏好              │  │
│  │  - UI Renderer  │  │  - 三来源合并   │  │  - subagent 能力声明    │  │
│  └────────┬────────┘  └────────┬────────┘  └────────────┬─────────────┘  │
│           │                    │                         │                │
└───────────┼────────────────────┼─────────────────────────┼────────────────┘
            │                    │                         │
┌───────────▼────────────────────▼─────────────────────────▼────────────────┐
│                          ④ 扩展插件层 (Plugins)                            │
│                                                                            │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │  Provider    │  │  MCP Client   │  │  Builtin     │  │  Custom NPM   │ │
│  │  插件        │  │  插件         │  │  Tool 插件   │  │  / file://    │ │
│  │ (多模型接入) │  │ (外部工具)    │  │ (读/写/bash) │  │  用户插件     │ │
│  └──────────────┘  └───────────────┘  └──────────────┘  └───────────────┘ │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                   可选协作能力插件 (Swarm Plugin)                     │ │
│  │  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌──────────────────┐  │ │
│  │  │Subagent  │  │Coordinator│  │  Mailbox   │  │ Task List Plane  │  │ │
│  │  │Plugin    │  │  Plugin   │  │  Messaging │  │ Claim/Update/Stop│  │ │
│  │  └──────────┘  └───────────┘  └────────────┘  └──────────────────┘  │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
                                            │
┌───────────────────────────────────────────▼────────────────────────────────┐
│                          ⑤ 基础设施层 (Infra)                              │
│                                                                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐           │
│  │ Storage │ │ Config  │ │  Logger │ │  Cache  │ │ Telemetry│           │
│  │ 持久化  │ │ 加载    │ │ 结构化 │ │ Prompt  │ │ 指标    │           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └──────────┘           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 三、核心模块详细设计

### 3.1 Harness Instance：核心编排器

Harness 是顶层实例，所有能力通过它暴露和访问。纯逻辑内核，不依赖任何 UI/CLI 库。

```typescript
interface Harness {
  // 生命周期
  create(options: HarnessOptions): Promise<Harness>
  start(): Promise<void>
  stop(): Promise<void>
  suspend(): Promise<void>
  resume(): Promise<void>

  // 会话管理（通过 Session Manager）
  session: SessionManager

  // 代理运行时（通过 Agent Runtime）
  agent: AgentRuntime

  // 插件管理
  plugin: PluginManager

  // 事件总线
  bus: Bus

  // 上下文容器
  context: ContextProvider
}
```

**设计要点（借鉴 Claude Code）：**
- Harness 不依赖任何 UI/CLI 库，纯逻辑内核
- 支持 `new QueryEngine(harness)` 直接嵌入 SDK 场景
- `suspend/resume` 支持长任务挂起（如后台 worker）

---

### 3.2 Plugin Manager：插件化的核心

**插件架构结合了两者的优点：**
- OpenCode 风格的 Hooks 流水线（chat.params/system.transform/compacting）
- Claude Code 风格的多来源插件加载（内置 + npm + file:// + 动态卸载）

```typescript
// ===== 插件定义接口 =====
interface AgentPlugin {
  id: string
  version: string
  name: string
  description?: string
  // 依赖其他插件 id（保证加载顺序）
  dependsOn?: string[]

  install(ctx: PluginContext): Promise<Hooks | void>
  uninstall?(): Promise<void>
}

// ===== Hooks 注册表（介入所有生命周期） =====
interface Hooks {
  // === Harness 级 ===
  'harness.init'?: (input, output) => Awaitable<void>
  'harness.start'?: (input, output) => Awaitable<void>

  // === Provider 认证（同 OpenCode auth hook） ===
  'provider.auth'?: (req: AuthRequest) => Awaitable<AuthResult | undefined>

  // === 工具池构建 ===
  'tool.pool.assemble'?: (input: { agentId: string }, pool: ToolPool) => Awaitable<void>

  // === Tool 执行 Pipeline ===
  'tool.pre.execute'?: (ctx: ToolContext, next: () => Promise<ToolResult>) => Promise<ToolResult>
  'tool.post.execute'?: (ctx: ToolContext, result: ToolResult) => Awaitable<ToolResult>

  // === LLM 调用链路（同 OpenCode chat params/headers） ===
  'llm.params'?: (input: LLMInput, params: LLMParams) => Awaitable<void>
  'llm.headers'?: (input: LLMInput, headers: Record<string, string>) => Awaitable<void>

  // === Prompt 构建链 ===
  'prompt.system.transform'?: (input: PromptInput, parts: string[]) => Awaitable<void>
  'prompt.tools.transform'?: (input: PromptInput, toolSchemas: ToolSchema[]) => Awaitable<void>

  // === Session 生命周期 ===
  'session.compacting'?: (input, output: CompactionContext) => Awaitable<void>
  'session.message.created'?: (msg: Message) => Awaitable<void>

  // === Permission 扩展 ===
  'permission.check'?: (req: PermissionRequest, decision: PermissionDecision) => Awaitable<void>

  // === Bus 事件订阅 ===
  'bus.event'?: (event: BusEvent<any>) => Awaitable<void>
}

// ===== Plugin Manager API =====
interface PluginManager {
  // 加载（内置 → 默认 npm → 用户配置顺序，同 OpenCode）
  loadInternal(plugins: AgentPlugin[]): Promise<void>
  loadBuiltin(npmSpecs: string[]): Promise<void>   // 例："@harness/mcp-client@1.0.0"
  loadUser(userSpecs: string[]): Promise<void>     // 支持 file:/// 本地路径

  // 动态能力
  unload(pluginId: string): Promise<void>
  hotReload(pluginId: string): Promise<void>
  list(): LoadedPlugin[]

  // 触发 Hook（同 OpenCode trigger，管道式依次调用）
  trigger<N extends keyof Hooks>(name: N, ...args): Promise<HookResult<N>>
}
```

**插件加载顺序（同 OpenCode 的三级插件 + 依赖图排序）：**
```
1. Internal 内置插件（硬编码）
2. Builtin 默认插件（npm 白名单）
3. User 用户插件（配置文件指定，支持 file:///）
→ 每一级内部按 dependsOn 拓扑排序
```

---

### 3.3 Tool Protocol：安全优先的运行时协议

**吸收 Claude Code Tool 是"运行时协议对象"的设计，而非 OpenCode 的简单 define()。**

```typescript
// ===== Tool 接口 =====
interface Tool<Input = any, Output = any, Progress = any> {
  // === 标识 ===
  id: string
  aliases?: string[]
  description: string              // 给 AI 看的短描述
  documentation?: string           // 给 AI 看的完整 .txt 等价内容
  searchHint?: string

  // === 安全声明（Fail-Closed 默认值，借鉴 Claude buildTool） ===
  /** 是否并发安全（默认 false）*/
  isConcurrencySafe?: (input?: Input) => boolean
  /** 是否只读操作（默认 false）*/
  isReadOnly?: (input?: Input) => boolean
  /** 是否破坏性操作（删除/覆盖等，默认 false）*/
  isDestructive?: (input?: Input) => boolean
  /** 是否需要用户交互（默认 false，如 AskUserQuestionTool）*/
  requiresUserInteraction?: boolean

  // === Schema ===
  inputSchema: ZodSchema<Input>
  outputSchema?: ZodSchema<Output>

  // === 语义校验（独立于 Schema，如 Edit 工具字符串存在性校验）===
  validateInput?: (input: Input, ctx: ToolContext) => Awaitable<void>

  // === 权限（同 OpenCode 路径级）===
  permission?: {
    key: string                    // "write" / "bash" / "read"
    extractPatterns: (input: Input) => string[]   // 文件路径或命令模板
  }

  // === 执行入口 ===
  call(
    input: Input,
    ctx: ToolContext,
    onProgress?: (p: Progress) => void
  ): Promise<ToolResult<Output>>

  // === UI 呈现（可选，插件可自定义渲染）===
  renderUse?: (input: Input) => React.ReactNode | string
  renderResult?: (result: ToolResult<Output>) => React.ReactNode | string
  renderError?: (err: Error) => React.ReactNode | string
}
```

**Tool 执行 Pipeline（参考 Claude Code 6 步）：**
```
1. inputSchema.safeParse() 硬校验
2. validateInput() 语义校验
3. Plugin.trigger('tool.pre.execute') 前置 Hook 管道
4. PermissionEngine.check() 权限检查（allow/deny/ask + 路径匹配）
5. tool.call() 真正执行
6. Plugin.trigger('tool.post.execute') 后置 Hook 管道
7. outputSchema 校验 + 结果截断
```

**并发调度（参考 Claude partitionToolCalls）：**
```typescript
function partitionToolCalls(uses: ToolUse[], ctx): ToolBatch[] {
  // 工具按 isConcurrencySafe 分批：
  // - 连续并发安全的工具合批并行执行
  // - 非并发安全的工具各自串行批次
  // - 并批次 contextModifier 延迟应用（防止竞态污染）
}
```

**默认值策略（Claude Code Fail-Closed 精髓）：**
```typescript
const TOOL_DEFAULTS = {
  isConcurrencySafe: () => false,   // 默认不可并发
  isReadOnly: () => false,          // 默认写操作（有风险）
  isDestructive: () => false,
  requiresUserInteraction: false,
}
```

---

### 3.4 Agent Definition：配置化 + 可组合的人设

**结合 OpenCode 配置化 Agent + Claude Code 分层 Multi-Agent 能力：**

```typescript
interface AgentDefinition {
  id: string
  name: string
  description: string
  icon?: string
  tags?: string[]

  // === 分层角色声明（Claude Code 精髓）===
  mode: 'primary' | 'subagent' | 'coordinator' | 'teammate'
  // primary：可作为主 Agent 直接对用户
  // subagent：只能被主 Agent 调用（独立 worker）
  // coordinator：调度器身份（不自己写代码，专派工）
  // teammate：Swarm 协作成员（带 inbox/task list）

  // === 能力白名单 ===
  tools: string[] | ['*']            // 工具 ID 列表，* 为全部
  skills?: string[]                  // 技能 ID 白名单
  subagents?: string[]               // 允许派出哪些 subagent

  // === MCP Server 粒度声明（可选）===
  // 可按 MCP server 名（mcp__<server>__<tool> 中的 <server>）控制该 Agent 可用的 MCP 工具。
  // 白名单优先于黑名单；缺省(undefined) → MCP 全部可见（向后兼容）；[] → 拒绝全部 MCP。
  mcpServers?: string[]              // 白名单：仅用列出的 server
  excludeMcpServers?: string[]       // 黑名单：剔除列出的 server（mcpServers 未定义时生效）

  // === 权限配置（同 OpenCode 结构）===
  permission: PermissionRuleset

  // === 模型偏好（同 OpenCode agent.model） ===
  model?: {
    providerId?: string
    modelId?: string
    temperature?: number
    options?: Record<string, any>
  }

  // === Prompt 片段（可组合叠加） ===
  promptFragments?: string[]         // System Prompt 片段数组
  systemPrompt?: string              // 完整覆盖 Prompt（优先级高）

  // === 协作能力（Claude Code Swarm 能力声明插件读取）===
  swarm?: {
    canSpawnTeammate?: boolean       // 默认 teammate 不能嵌套
    canClaimTask?: boolean           // 是否可认领共享任务
    canUseMailbox?: boolean
  }
}
```

**模型配置与运行时切换（@harness/cli）：**

模型取值优先级（CLI > `config.json` > 环境变量）：

```
CLI:  harness --model <modelId>            # 或 -m
config.json: { "model": "...", "provider": "...", "agentId": "...", "anthropicApiKey": "..." }  # <data-dir>/config.json
env:   ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
```

- `--model` 写入默认 Agent 定义 `model.modelId`；运行时每次推理 `llmIn.modelId` 按 `input.model → agent.model → provider.defaultModel` 取（SubagentTool 派出子 Agent 可用 `input.model` 覆盖）
- `config.json` 由 `ConfigStore` 读写（缺文件/坏 JSON 幂等返回空），提供运行时 `/model` 落盘默认模型
- 运行时 `/model`：`/model` 查看当前模型，`/model <modelId>` 更新当前 Agent 的 model 并写入 `config.json`（影响下次 send）；TUI 状态栏/侧栏初始即展示配置模型，首轮回复后刷新为实际命中模型

**多 Provider 自由切换（自定义模型配置）：**

`config.json` 的 `providers` 数组可同时定义多个 provider（anthropic / openai / gemini / mock + 任意 OpenAI 兼容端点如 DeepSeek / Ollama / GLM / Qwen），每个含 baseUrl / apiKey / model：

```json
{
  "provider": "deepseek-chat",
  "model": "deepseek-chat",
  "providers": [
    { "type": "openai",    "baseUrl": "https://api.openai.com",    "apiKey": "...", "model": "gpt-4o" },
    { "type": "openai",    "baseUrl": "https://api.deepseek.com",  "apiKey": "...", "model": "deepseek-chat" },
    { "type": "openai",    "baseUrl": "http://localhost:11434",                     "model": "qwen2.5" },
    { "id": "glm",         "type": "openai", "baseUrl": "https://open.bigmodel.cn", "apiPath": "/api/paas/v4/chat/completions", "model": "glm-4" },
    { "type": "gemini",    "apiKey": "...", "model": "gemini-2.0-flash" },
    { "type": "anthropic", "apiKey": "...", "model": "claude-3-5-sonnet" }
  ]
}
```

- **实例 id 可省略（默认由 model 派生）**：`normalizeProviderConfigs` 在 boot 时补全实例 id —— 缺省取 `model`（去 `provider/` 前缀、非法字符折叠为 `-`），同名按数组顺序追加 `-2`/`-3`（确定性，可复现）。因此「id 必须唯一且冗长」不再是配置负担：写 `{ "type": "openai", "baseUrl": "...", "model": "hy3" }` 即可，实例 id 就是 `hy3`，顶层 `provider: "hy3"` 直接引用。仅在「同一模型挂多个端点」或想让 id 比模型名更短时才显式写 `id`；显式写时仍须唯一，重复会报错（避免静默覆盖注册）
- **分发**：core 维护 `chatProviders` 注册表，`resolveChatProvider(providerId)` 按 `agent.model.providerId` 路由请求到对应 Provider；无 providerId 或未知 id 回退默认 Provider（配置的 `provider`，未注册时 fallback mock）
- **规格与解析**：`parseModelSpec` / `formatModel` 负责 `provider/modelId` 的拆分与拼回展示；`resolveModelArg` 把「用户敲什么」与「怎么切」解耦，输出结构化的解析结果（实例 / 显式 / 裸模型名 / 歧义 / 序号越界 / 类型名提示 / 未找到）
- **`/model` 四种写法（不再必须 `id/model`）**：① `/model <序号>`（按 `/model ?` 列表，列表项带序号）② `/model <实例 id>` ③ `/model <模型名>` ④ `/model <id>/<model>` 显式跨 Provider。命中唯一实例即自动带上该实例配置的 `model`；跨实例重名要求消歧（列出候选）；已配置 providers 时陌生输入被拒绝（`not-found`）——避免 `/model local-hy4` 这类拼错静默落成垃圾 `config.model`。未配置任何 providers 实例时保留旧用法（裸模型名挂当前 Provider）
- **插件安装**：`HarnessApp.boot()` 依次安装非默认 Provider 插件，默认 Provider 最后安装作兜底；openai 插件 id 随 `providerId` 派生（`provider.{providerId}`），多个兼容端点不冲突
- **切换持久化**：`/model <任意写法>` 解析后**同步**写入 `config.json` 的 `provider` + `model`，保证二者自洽（旧实现只在前缀命中时改 provider，会出现 provider 指向 A、model 属于 B 的不一致配置）

**配置健壮性（显式校验 / 密钥加密 / 自检）：**

- **启动显式校验**：`normalizeProviderConfigs` 负责实例 id 的补全与唯一性（`id` 与 `model` 均缺失 → 报错；显式 `id` 重复 → 报错）；`validateProviderConfigs` 检查未知 type / 默认 provider 未定义（非内置 mock/anthropic）。boot 时一次性输出所有问题并抛 `ConfigValidationError`（不再静默覆盖/丢弃或误导提示）
- **apiKey 三种形式**（`resolveSecret` 统一解析）：
  - 明文（向后兼容）
  - `${ENV_VAR}` 环境变量引用（未设置报错）
  - `enc:v1:<iv>:<tag>:<ct>` 加密值（AES-256-GCM，主密钥 `HARNESS_CONFIG_KEY` 环境变量或 `<data-dir>/.config-key` 文件）
- **密钥管理命令**：`harness config set-key <providerId> <apiKey>` 加密写入；`get-key <providerId>` 解密查看；`check`（或 `--check-config`）打印 Provider/模型概览（apiKey 状态脱敏：已配置/已加密/env(名称)/未配置）并校验；REPL `/config` 查看概览
- **同 URL 不同 key**：注册表按 `id` 分发，两个端点只要 `id` 不同即可共存（如 `gateway-a`/`gateway-b` 指向同一 baseUrl），`/model gateway-a/gpt-4o` 与 `/model gateway-b/gpt-4o` 各自使用对应 apiKey
- **GLM / Qwen 预设**：`type: "glm"` / `type: "qwen"` 使用预设端点与默认模型（智谱 BigModel / 阿里 DashScope），apiKey 默认读 `ZHIPU_API_KEY` / `DASHSCOPE_API_KEY`；或统一用 `type: "openai"` 手动填 baseUrl/apiPath

**Provider 类型插件化（type 不再硬编码）：**

- `ProviderConfig.type` 是开放字符串；内置类型（openai/anthropic/gemini/glm/qwen/mock）只是「已注册」的默认项
- **抽象层**：`ProviderConfig` / `ProviderTypeFactory` / `ProviderTypeRegistry` / `resolveProviderTypeFactory` 契约统一落在 `@harness/plugin`；core / cli **只经此抽象层接口**与 Provider 插件交互。`provider-*` 包各自导出 `providerTypeFactory` 实现该契约（在包内完成 `ProviderConfig` → 自身配置结构映射）；cli 的 `registerBuiltinProviderTypes` 只登记「`type` → 模块 specifier」，`createPlugin` 时惰性 `import()` + `resolveProviderTypeFactory()` 委托实现方
- `ProviderTypeRegistry`（`type → createPlugin(config)`）替代 CLI 硬编码 switch；`HarnessApp.providerTypes` 公开，boot 前可注入自定义类型
- 外部插件多级加载：`~/.harness/plugins`（user）→ `<project>/.harness/plugins`（project，后加载覆盖）。插件目录统一承载各种插件，一个 `.ts/.js/.mjs` 模块可同时导出：
  - **Provider 类型工厂**（扩展 `config.type`）：`providerTypeFactory` 或 `providerType`+`createProviderPlugin` 约定
  - **通用 AgentPlugin**（Hooks 生命周期插件）：`default` / `plugin` / `plugins` 任何形态；通用插件按插件 `id` 去重，project 覆盖 user

```typescript
// providers 类型工厂约定（注册进 ProviderTypeRegistry）
export const providerType = 'my-gw'
export function createProviderPlugin(config) {
  // 返回 AgentPlugin：install 内通过 harness.init hook 调用 _setChatProvider 注册 ChatProvider
}

// 通用 Hooks 插件约定（这两者可在同一模块同时导出）
export default { id: 'ext.example', version: '1.0.0', name: 'Example', async install() { return { /* hooks */ } } }
```

- 配置校验按注册表动态进行，未知 type 报错时列出已注册类型并提示 plugins 目录扩展方式；`--check-config` / `config check` 加载外部插件后校验

**运行时能力服务契约（subagent / swarm 抽象）：**

- 与 Provider 同理，cli 对 `@harness/subagent` / `@harness/swarm` 的直连残留也收敛到抽象层：抽象契约（`BackgroundTaskMonitorLike`、`SubagentCapability`、`SwarmCapability` / `SwarmLoopDeps` / `SwarmLoopHandle`）统一落在 `@harness/plugin`，全部为最小结构契约，抽象层不反向依赖具体插件
- 具体能力对象由插件包各自导出并实现契约：subagent 导出 `subagentCapability`（`createMonitor` → `BackgroundTaskMonitor`）；swarm 导出 `swarmCapability`（`sanitizeName/formatAgentId/startTeammateLoop`，内部封装 `createSwarmManagers` + teammate 状态 + 循环，并把底层 `TeammateLoopHandle` 适配为抽象 `SwarmLoopHandle`）
- cli 业务逻辑只经抽象接口交互（如 `attachBackgroundTaskPanel` 用 `subagentCapability.createMonitor`、`runTeammateCli` 用 `swarmCapability.startTeammateLoop` 并以 `loop.isDone()` 收尾），不再 import 具体实现类型；组合根仅导入插件导出的能力对象注入（「组合根直连内置插件」为接受的干净架构常态）

---

### 3.5 Skill Layer：双轨技能系统

**结合两者的 Skill 设计：**
- OpenCode 清晰区分：Skill = 知识（Markdown），Tool = 功能（代码）
- Claude Code 增强：内嵌 Shell 执行 + paths 条件触发 + 三来源合并

```typescript
interface Skill {
  id: string
  name: string
  description: string                     // AI 何时使用的触发说明

  // === 来源（五来源：三来源 + mcp + plugin） ===
  loadedFrom: 'bundled' | 'user' | 'project' | 'mcp' | 'plugin'

  // === 条件触发（Claude Code paths 精髓） ===
  paths?: string[]                        // glob 匹配：修改这些文件时自动注入上下文
  userInvocable?: boolean                 // /skill-name 命令可见
  agentBind?: string[]                    // 仅这些 Agent 可用

  // === 内容：双轨制（Markdown + 可选 Script 执行） ===
  content: string                         // Markdown 正文
  embeds?: SkillEmbed[]                   // 内嵌 !`cmd` 或 {{var}}
  allowEmbedShell?: boolean               // MCP 来源强制 false（安全切断同 Claude）

  // === 元数据 ===
  allowedTools?: string[]                  // 加载后额外放开哪些工具
  model?: string                           // 绑定特定模型时使用
  effort?: 'low' | 'medium' | 'high'       // 任务预估（给 coordinator 参考）
}

interface SkillEmbed {
  type: 'shell' | 'variable'
  source: string                           // "git status" / "${SKILL_DIR}"
  // 安全：loadedFrom === 'mcp' 时 shell embed 跳过执行
}
```

**技能来源标注 `formatSkillSource(source)`：** `'bundled'→内置` / `'user'→用户` / `'project'→项目` / `'mcp'→MCP` / `'plugin'→插件`，供管理界面展示来源。

**SkillManager 管理能力（enable / disable / reload）：**
- `disable(id)`：从可用列表移除并缓存，可被 `enable` 恢复；重复禁用幂等返回 `false`
- `enable(id)`：从禁用缓存恢复；未在缓存中则回落 `reload`（等价启用新增技能）
- `isDisabled(id)`：查询禁用状态
- `reload(id)`：从原始来源文件热更新，且保持原启用/禁用状态
- 插件可在 `harness.init` hook 中通过 `harness.skillManager.register(...)` 注册 `'plugin'` 来源技能

---

### 3.6 Session Manager：持久化 + 可恢复

**融合 OpenCode Session 文档的完整结构：**
- Message + Part 模型（text/tool/file/reasoning/patch）
- Compaction 三级：prune → summary → auto agent 压缩
- Snapshot + Revert/Unrevert（同 OpenCode revert.ts）
- Todo List Plane（独立存储 + Bus 通知）

> 说明：此处的 Compaction 面向**持久化历史的内存/存储回收**；请求级上下文压缩由 ACP 插件（见 [3.9](#39-acp-上下文压缩插件harnessacp-context)）负责，两者正交。

---

### 3.7 Permission Engine：路径级匹配

**参考 OpenCode next.ts + Claude Code PreToolUse Hooks：**

```typescript
// 匹配优先级（同 OpenCode 4 级）
// 1. 具体路径精确匹配 "src/main.ts"
// 2. 通配符 glob 匹配 "src/**"
// 3. 工具级规则 write: "ask"
// 4. 全局通配 *: "ask"

interface PermissionRuleset {
  // 简写
  [toolKey: string]: PermissionBehavior
                     | { allow?: string[]; deny?: string[]; ask?: string[] }
  '*'?: PermissionBehavior
}

type PermissionBehavior = 'allow' | 'deny' | 'ask'

// PermissionDecision 同 Claude Code，含 updatedInput（可深度修正参数）
interface PermissionDecision {
  behavior: PermissionBehavior
  updatedInput?: any
  remember?: boolean   // 用户选择"始终允许"时写回规则
}
```

---

### 3.9 ACP 上下文压缩插件（@harness/acp-context）

**定位**：通过新增的 `session.preModel` Hook 接入 acp-kernel（billion-context 抽取的纯引擎，MIT）做**模型驱动 3 层 LSM 上下文压缩**。对话越长、token 占用越高，代价越低——超长会话不丢失早期上下文，而是折叠成可检索/可还原的摘要块。

**每轮接入点**：core 在 query 与 queryStream 两处构建 `finalMessages` 后、调用模型前，触发 `session.preModel(input, messages)`。插件据此：
- 调 `processTurn` 指派 refs、按需产出 nudge、执行分层压缩过滤；
- 用 `save(messages)` 回写精简历史、用 `meta.read/patch` 读写 `session.meta` 持久化压缩状态。

```typescript
// plugin/src/index.ts — SessionPreModelInput（核心约定）
interface SessionPreModelInput {
  sessionId: string
  agentId: string
  providerId: string
  modelId?: string
  save: (messages: unknown[]) => Promise<void>   // 回写精简后会话消息
  meta: {                                        // session.meta 持久化访问器
    read: () => Promise<Record<string, unknown> | undefined>
    patch: (patch: Record<string, unknown>) => Promise<void>  // 浅合并
  }
}
// Hooks['session.preModel'] → (input, messages: unknown[]) => Awaitable<void>
```

**模型驱动压缩分工**：

| 环节 | 执行者 |
|------|--------|
| 何时去压（nudge 决策、上下文占比、可压缩范围） | 内核 `processTurn`（每轮，无需模型） |
| 写摘要、选压缩范围（startId/endId/summary/topic） | **模型**（调 `compress` 工具） |
| 折叠成块、分层蒸馏（tier 1→2→3）、token 统计 | 内核 `applyCompression` |
| 范围合法性与摘要长度校验 | 内核 `compress` 配置（minCompressRange/maxSummaryLength） |

插件注入 4 个模型工具：`compress`、`decompress`、`search_context`、`acp_status`，与内置 ACP 哲学 system prompt + nudge 配套。

**持久化与恢复**：
- **原始消息全文**存会话本体（插件不裁减持久历史，压缩只作用于"本轮发给模型的请求"），每次追加落盘；
- **压缩状态**（`CompressionState`：blocks / messageRefs / tokenSnapshot / nudge / stats / nextBlockId）以纯 JSON 存 `session.meta[ACP_META_KEY]`，变化时写、跨重启保留；
- **恢复会话**：历史从会话本体读全文，压缩块从 `meta` **水合复用，不重新生成**；`messageRefs` 随状态持久化，而原始消息 id 重启后不变，故 ref 能对齐（kernel "refs survive restarts"）。恢复后首轮置 `needFull` 走全量渲染重建请求，之后恢复增量。
- `decompress` 可按 `blockId` 还原被压缩的**原始消息全文**（`restoreBlockMessages` 按 ref→core id→归档 Message 反解），因此压缩不损失可回溯性。

**增量渲染缓存（性能）**：内核 `processTurn` 每轮对完整历史跑 pipeline，其 O(n) 扫描不可避免；为省宿主侧"历史前缀反复 `core↔message` 往返渲染"，`runPreModel` 双路径：
- **增量（常态）**：`!needFull` 且缓存前缀与当前历史前缀逐 id 对齐、且本轮无压缩/截断（`res.messages` 与输入 cores 等长）时，复用 `prefixRender`，只对新增尾部做 `requestMessages`，并将尾部并入缓存；
- **全量**：压缩发生 / 历史前缀漂移 / 截断时重建并刷新缓存；本轮消息数变化强制 `needFull`。

**设计取舍**：压缩是**旁路优化**——失败仅 warn、不阻断本轮模型请求；增量缓存失效只回落全量，不影响正确性。

---

## 四、插件化扩展示例

### 示例 1：MCP Client 插件（外部工具接入）

```typescript
const MCPPlugin: AgentPlugin = {
  id: 'core.mcp',
  version: '1.0.0',
  name: 'MCP Client',

  async install(ctx) {
    // Hook：组装工具池时，注入 MCP 工具
    return {
      'tool.pool.assemble'(input, pool) {
        // 从 MCP Server 获取工具 → 转换为 Tool Protocol 对象
        for (const mcpTool of getMCPTools()) {
          // 命名前缀 mcp__${server}__${tool}（同 Claude）
          pool.add(convertMCPToolToHarnessTool(mcpTool))
        }
      },
      // 连接状态变更广播
      'harness.start'() {
        startMCPServerHealthCheck(ctx.bus)
      }
    }
  }
}
```

### 示例 2：Swarm 协作插件（可选，扩展 multi-agent）

```typescript
const SwarmPlugin: AgentPlugin = {
  id: 'collab.swarm',
  version: '1.0.0',
  name: 'Swarm Multi-Agent',
  dependsOn: ['core.tool.agent'],   // 依赖核心 AgentTool

  async install(ctx) {
    return {
      // 为 teammate Agent 强制注入协作工具（同 Claude Code）
      'tool.pool.assemble'({ agentId }, pool) {
        if (getAgentMode(agentId) === 'teammate') {
          pool.addIfMissing([
            'send_message', 'task_create', 'task_list',
            'task_claim', 'task_update', 'mailbox_read',
          ])
        }
      },

      // Hook 权限：teammate 请求权限通过 leader 桥接
      'permission.check'(req, decision) {
        if (req.from === 'teammate' && decision.behavior === 'ask') {
          decision.behavior = bridgeToLeaderPermissionQueue(req)
        }
      }
    }
  }
}
```

### 示例 3：Provider 插件（多模型接入）

```typescript
const AnthropicProviderPlugin: AgentPlugin = {
  id: 'provider.anthropic',
  version: '1.0.0',

  install(ctx) {
    return {
      'provider.auth'(req) {
        if (req.providerId !== 'anthropic') return
        return {
          headers: { 'x-api-key': getEnvAPIKey() }
        }
      },
      'llm.headers'({ providerId }, headers) {
        if (providerId === 'anthropic') {
          headers['anthropic-version'] = '2023-06-01'
        }
      }
    }
  }
}
```

## 四、补充：ACP 上下文压缩插件示例

**官方内置插件，见 3.9 节详述。** 接入方式：把 `createAcpContextPlugin` 加入 `internalPlugins`，通过 `session.preModel` Hook 每轮在进入模型前运行 acp-kernel，并注入 4 个模型驱动压缩工具。

```typescript
import { createHarness } from '@harness/core'
import { createAcpContextPlugin } from '@harness/acp-context'

const h = await createHarness({
  internalPlugins: [
    createAcpContextPlugin({ modelContextLimit: 200_000 }),
    // ...其他内置插件
  ],
  agents: [/* ... */],
})
```

**与既有 Compaction 的关系**：`session` 包自带 prune→summary→auto agent 三级压缩负责**持久化历史的内存/存储回收**；ACP 插件则负责**请求级上下文 token 瘦身**——两者正交：ACP 不裁减持久历史（保留全文供可回溯），只压缩"本轮发给模型的请求"。

---

## 五、实现路径与里程碑

### Phase 1：核心骨架（MVP）

| 模块 | 功能 | 优先级 |
|------|------|--------|
| Harness Instance | create/start/stop + Context 容器 | P0 |
| Plugin Manager | Internal 插件 + Hooks trigger 管道 | P0 |
| Bus | 类型安全 define/publish/subscribe | P0 |
| Tool Protocol | Tool.define + 默认 Fail-Closed | P0 |
| Tool Pipeline | Schema + 语义校验 + Permission.check | P0 |
| Agent Runtime | Query Engine 主循环 + 单轮推理 | P0 |
| Session Manager | 内存态 Message/Part + Todo List | P0 |

### Phase 2：配置化与扩展能力

| 模块 | 功能 | 优先级 |
|------|------|--------|
| Agent Definition | 配置化 Agent（权限/工具/prompt） | P1 |
| Permission Engine | 路径级 glob 匹配 + 规则记忆 | P1 |
| Plugin Manager | npm + file:// 插件加载 + dependsOn | P1 |
| Skill Layer | Markdown + 三来源发现 + paths 触发 | P1 |
| Tool Concurrency | partitionToolCalls 分批调度 | P1 |

### Phase 3：高级能力插件

| 模块 | 功能 | 优先级 |
|------|------|--------|
| Session | Compaction + Snapshot/Revert + 持久化 | P2 |
| MCP Plugin | local/remote MCP Client + OAuth | P2 |
| Provider Plugin | 多模型适配 | P2 |
| Subagent Plugin | AgentTool + runAgent | P2 |

### Phase 4：协作能力（可选进阶）

| 模块 | 功能 | 优先级 |
|------|------|--------|
| Coordinator Plugin | Coordinator Prompt + worker 通知 | P3 |
| Swarm Plugin | Team + Mailbox + Task List + 权限桥接 | P3 |
| Multi-Backend | in-process / tmux / iTerm2 teammate | P3 |
| TUI 形态 | `harness --tui` alt-screen 全屏交互（OpenTUI 渲染：Yoga flexbox 布局 + Zig 渲染核心 + React 组件树） | P3 ✅（08-26） |

---

## 六、关键设计决策速查表

| 决策点 | 选型 | 理由 |
|--------|------|------|
| **技术栈** | TypeScript + Bun | 两个参考项目均为 TS，Bun 原生支持 Shell/文件/子进程 |
| **包结构** | Monorepo 多包 (@harness/core 等) | 模块边界清晰，后续可独立发布 npm |
| **Tool 默认并发安全？** | 否（Fail-Closed） | Claude Code 经验：工具默认有风险，需显式声明 |
| **Skill 内嵌 Shell？** | 开启 + MCP 来源强制跳过 | 同 Claude Code 安全切断，防 RCE |
| **Agent 分层？** | primary/subagent/coordinator/teammate 四模式 | 覆盖 Claude Code 全部场景，且作为插件能力 |
| **Multi-Agent 优先级？** | P1 只做 Subagent，Swarm 做可选插件 | 平衡复杂度与扩展性，Core 只留 Subagent 基础 |
| **插件 Hooks 命名？** | 域.动作 格式，如 `tool.pre.execute` | 扩展性好，支持后续新域不冲突 |
| **Plugin 加载顺序？** | Internal → Builtin → User + dependsOn 拓扑 | 同 OpenCode，保证覆盖关系明确 |
| **权限匹配优先级？** | 精确路径 → glob → 工具级 → 全局通配 | 同 OpenCode 成熟模式 |
| **Harness 是否依赖 UI？** | 否，纯逻辑内核 | 同 Claude Code QueryEngine，支持 SDK/CLI/IDE 多入口 |
| **Session Compaction 策略？** | prune(旧工具结果) → summary Agent 摘要 | 同 OpenCode，先轻量后重量 |

---

## 七、与两个参考架构的对比总结

| 能力维度 | Claude Code | OpenCode | **本 Harness 设计** |
|----------|-------------|----------|---------------------|
| 执行内核与 UI 解耦 | 完整 QueryEngine 独立 | 耦合较深 | Harness 纯内核 + 多形态 |
| 工具运行时协议 | 完整属性（10+） | 简化版 define | Tool Protocol 完整属性 + Fail-Closed |
| 工具并发调度 | partition 分批 | 无 | partition 分批 + contextModifier 延迟应用 |
| Hooks 扩展机制 | 内置但不暴露插件 API | auth/chat/system/compacting | 统一 Hooks Registry + 三级插件加载 |
| npm/file 插件热插拔 | 不详 | 有 | PluginManager 支持 load/unload/hotReload |
| Permission 路径匹配 | 有但不详 | 4 级 glob | PermissionEngine 4 级 + 记忆 |
| Skill 条件触发 paths | 有 | 无 | paths glob 匹配 |
| Skill 内嵌 Shell | 有 + 安全切断 | 无 | embeds shell + MCP 来源切断 |
| 多 Agent 分层 | 三层体系 | 只有 subagent | 四模式声明 + Swarm 可选插件 |
| Agent间通信 + 任务平面 | mailbox + task list | 无 | SwarmPlugin 可选实现 |
| Bus 类型安全事件总线 | 不详 | 有 | BusEvent.define + Zod |

---

## 八、Subagent 后台执行与状态通知增强

### 8.1 问题背景与当前状态

Subagent 后台执行能力已实现 `runInBackground` + `BackgroundTaskRegistry` + `<task-notification>` 通知注入 + `/tasks` 命令。原设计中的三个核心缺陷及处置：

1. **后台判定纯靠模型自行判断**（已修复）：`runInBackground` 参数由大模型自由传参，现补充 Agent 定义级别声明（`AgentDefinition.background` 字段），prompt 已增加何时使用前台/后台的决策指导（P0-1/P0-2）。

2. **完成通知靠模型轮询**（已修复）：`task_status` 工具已整体移除（用户决定 tool 移除但 cli 保留）。后台任务完成后通过 `SessionManager.enqueueNotification` 注入 `<task-notification>` user 消息到后续 turn，大模型无需主动轮询。查询任务状态通过 `/tasks` CLI 命令（保留）。

3. **前端无法自动展示**（待后续）：Bus 事件已发布但无前端组件消费，任务状态只有用户执行 `/tasks` 才能看到（前端事件驱动展示列入 P1-4 计划）。

### 8.2 参考实现对比

| 维度 | Claude Code | OpenCode | 当前实现 |
|------|-------------|----------|----------|
| **后台判定** | 模型传参 + Agent `background:true` + Fork/Coordinator/Assistant 强制异步 | 不支持后台，全同步 | 纯靠模型传参 |
| **完成通知** | `enqueueAgentNotification` → 注入 `<task-notification>` user 消息到后续 turn | 同步返回，无需通知 | `enqueueNotification` → 注入 `<task-notification>`（已实现，task_status 已移除） |
| **前端展示** | `setAppState` + `emitTaskProgress` SDK 事件 + `BackgroundTasksDialog` 组件 | `Bus.subscribe(PartUpdated)` → `ctx.metadata` 推送 | Bus 事件已发布但无消费方 |
| **Prompt 指导** | 前台/后台决策规则 + "Don't peek" + "Don't race" 反模式 | "Launch multiple concurrently... single message multiple tool uses" | 简单描述 |
| **并行机制** | `LocalAgentTask` + `forceAsync` 统一异步 | `BatchTool` 显式 `Promise.all` | `void (async(){})()` 异步块 |

### 8.3 开发计划（6 项）

> 状态标记：✅ 已完成　🔄 进行中　⬜ 待实现　→ Coordinator 已划归下一节「九、模式边界」

#### P0-1：Prompt 增强 — 前台/后台决策指导（✅ 已完成）

**目标**：在 `SubagentTool.description` 中加入明确的决策规则和反模式警示。

**改动**：
- `SubagentTool` 的 `description` 增加前台/后台决策规则：
  - "需要结果才能继续 → 前台（默认）"
  - "有独立工作可并行 → 后台（runInBackground: true）"
- 增加反模式警示（参考 Claude Code `prompt.ts`）：
  - "do NOT sleep, poll, or proactively check on its progress — 完成后系统自动通知"
  - "Don't race — 启动后不要伪造或预测未到达的结果"
  - "Don't peek — 不要主动读取任务输出文件查进度"

**参考**：[Claude Code prompt.ts#L263-264](file:///Users/oyoungy/Documents/project/XiaoZhi-new/reference/claude-code-analysis-main/src/tools/AgentTool/prompt.ts#L263-264)

**依赖**：P0-3（通知自动注入）实现后，prompt 中的"系统自动通知"承诺才成立

---

#### P0-2：AgentDefinition 增加 `background?: boolean`（✅ 已完成）

**目标**：在 Agent 定义级别声明该 Agent 默认后台执行，不依赖模型传参。

**改动**：
- `@harness/agent` 的 `AgentDefinition` 接口增加 `background?: boolean` 字段
- `SubagentTool.call` 中后台判定逻辑改为：
  ```typescript
  const shouldRunInBackground = input.runInBackground === true 
    || agentDef?.background === true
  ```
- 测试：Agent 定义 `background: true` 时，即使模型不传 `runInBackground`，也走后台路径

**参考**：[Claude Code AgentTool.tsx#L567](file:///Users/oyoungy/Documents/project/XiaoZhi-new/reference/claude-code-analysis-main/src/tools/AgentTool/AgentTool.tsx#L567) — `selectedAgent.background === true`

**依赖**：无

---

#### P0-3：完成通知自动注入（核心改进）（✅ 已完成）

**目标**：后台任务完成后，自动向父 session 注入一条 `<task-notification>` 格式的 user-role 消息，大模型在后续 turn 看到后即知任务完成，**不需要主动调用任何查询工具**（`task_status` 工具已整体移除，仅保留 `/tasks` CLI 命令）。

**设计**：

1. **Session 层增加 `pendingNotifications` 队列**：
   - `SessionManager.enqueueNotification(sessionId, message: string)`：将通知消息入队
   - `SessionManager.drainNotifications(sessionId): string[]`：在下一轮 `agent.query` 前取出所有待处理通知，作为 user-role 消息注入到对话开头

2. **SubagentTool 后台任务完成回调**：
   - `BackgroundTaskRegistry.complete(taskId, ...)` 后，调用 `sessionManager.enqueueNotification(parentSessionId, notificationMessage)`
   - 通知消息格式（参考 Claude Code `<task-notification>`）：
     ```
     <task-notification>
     <task-id>{taskId}</task-id>
     <status>{completed|failed}</status>
     <summary>Agent "{agentName}" {completed|failed}</summary>
     <result>{finalMessage}</result>
     <usage><duration-ms>{durationMs}</duration-ms></usage>
     </task-notification>
     ```

3. **AgentRuntime 集成**：
   - `agent.query` 开始时，先调用 `sessionManager.drainNotifications(sessionId)` 取出通知
   - 将通知作为 user-role 消息注入到对话开头（大模型在处理用户输入前先看到任务完成通知）

4. **去重机制**：
   - `BackgroundTaskRegistry` 的 task 记录增加 `notified: boolean` 字段
   - 完成通知只注入一次，防止重复

**参考**：[Claude Code enqueueAgentNotification](file:///Users/oyoungy/Documents/project/XiaoZhi-new/reference/claude-code-analysis-main/src/tasks/LocalAgentTask/LocalAgentTask.tsx#L197-261)

**涉及包**：
- `@harness/session`：增加 `pendingNotifications` 队列 + `enqueueNotification` / `drainNotifications`
- `@harness/core`：`AgentRuntime.query` 开始时 drain 通知
- `@harness/subagent`：`SubagentTool` 后台完成回调中调用 `enqueueNotification`

**依赖**：P0-2（Agent `background` 字段）可并行，P0-1（Prompt）依赖此功能成立

---

#### P1-4：前端事件驱动展示（✅ 已完成）

**目标**：Bus 事件（`subagent.started/completed/failed`）已有，需前端组件订阅并自动渲染任务面板，**不依赖大模型调用**。

**改动**：
- `@harness/subagent` 新增 UI 无关的 `BackgroundTaskMonitor`（订阅 `subagent.started/completed/failed`，维护任务快照 running → completed/failed，支持 `parentSessionIds` 过滤与 `backgroundOnly` 开关，`subscribe()` 广播变更，`dispose()` 释放）
- `@harness/cli` 新增 `attachBackgroundTaskPanel({ harness, stdout })`：挂载 monitor，任务状态变化时增量打印（⏳ 开始 / ✅ 完成+结果预览 / ❌ 失败+错误），**用户无需执行 `/tasks`**
- `startRepl` 自动挂载任务面板（退出时自动卸载）
- 未来 Web UI 可直接复用 `BackgroundTaskMonitor`（纯状态 + 变更订阅，无渲染依赖）

**参考**：Claude Code `BackgroundTasksDialog.tsx` + `setAppState`（本项目无独立 Web 前端，落地为 CLI REPL 实时面板）

**依赖**：前端 UI 框架就绪（TUI 或 Web）→ 已落地为 CLI REPL 面板

---

#### P1-5：进度推送（✅ 已完成）

**目标**：子 Agent 执行中的工具调用进度通过 Bus 事件实时推送到前端。

**改动**：
- 新增 `subagent.progress` Bus 事件，包含 `{ taskId, agentId, parentSessionId, toolUseId, toolName, toolStatus: running|completed|failed, summary, timestamp }`
- 后台执行改用 `agent.queryStream` 替代 `agent.query`：遍历事件流，`tool_call_start` → 发布 `running` 进度（含工具输入摘要，复用 `summarizeToolInput`），`tool_call_result` → 发布 `completed/failed` 进度（含结果预览）
- `BackgroundTaskMonitor` 订阅 progress 事件，任务视图新增 `progress[]`（同 `toolUseId` 的 running 被 completed/failed 覆盖，最新在前）
- CLI `attachBackgroundTaskPanel` 增量打印进度行（🔧 工具执行中 / ✅ 完成 / ❌ 失败）
- 测试 mock 的 `queryStream` 补齐默认实现（走 queryImpl 产出 done 事件），后台测试随 queryStream 迁移

**参考**：OpenCode `Bus.subscribe(PartUpdated)` → `ctx.metadata` 推送模式

**依赖**：P1-4（前端组件）→ 已完成，面板同步支持进度展示

---

#### P2-6：Feature Gate: `forceAsync` 模式（→ 已划归 Coordinator 插件）

**目标**：Fork 模式 / Coordinator 模式开启时，强制所有 Subagent spawn 走后台路径。

**改动**：
- `SubagentPluginOptions` 增加 `forceAsync?: boolean` 选项
- `SubagentTool.call` 中判定逻辑增加 `|| forceAsync`
- CLI 配置或环境变量控制：`HARNESS_FORCE_ASYNC=true`

**参考**：Claude Code `forceAsync = isForkSubagentEnabled()`

**依赖**：无（可独立实现）

### 8.4 实现顺序

```
✅ P0-2 (Agent background 字段) ──────────────┐
                                             ├──→ ✅ P0-3 (通知自动注入) ──→ ✅ P0-1 (Prompt 增强)
✅ P0-3 (通知注入基础设施) ─────────────────┘
✅ P1-4 (前端展示: BackgroundTaskMonitor + CLI 任务面板) ──→ ✅ P1-5 (进度推送: subagent.progress + 面板进度行)
✅ Coordinator 插件 (@harness/coordinator)：mode 身份 + System Prompt / barrier 自动集齐续轮 / forceAsync / send_message
⬜ 后续：写操作按文件集串行化 → Swarm Plugin（见第九节）
```

P0-2 和 P0-3 可并行开发，P0-1 依赖 P0-3 完成后才能在 prompt 中承诺"系统自动通知"。

---

## 九、多 Agent 模式边界：Subagent / Coordinator / Swarm

> 记录日期：2026-08-24。来源：Claude Code `04h-multi-agent.md` 分层体系 + 本项目实现决策。

### 9.1 三层模式定位（不是功能叠加，是抽象升级）

| 层级 | 定位 | 类比 | 状态 |
|------|------|------|------|
| ① Subagent | **执行单元**：一次性、无状态的任务执行器，父 Agent 调用工具 spawn，跑完即走，结果返回创建者 | 派"外包"做单点任务，做完结算走人 | ✅ 已实现（`@harness/subagent`） |
| ② Coordinator | **调度单元**：切换主线程身份为 orchestrator，自己不写代码，负责 Research→Synthesis→Impl→Verify 四阶段派工、汇总、续派 | "项目经理"角色，全程跟进分阶段调度，不亲自干活 | ✅ 已实现核心（`@harness/coordinator`），写操作串行化待后续 |
| ③ Swarm Teammate | **组织单元**：显式创建 team 实体 + 共享任务池 + 长期收件箱 + 权限桥，成员长期在线协作 | "正式团队"，有工位、邮箱、共享任务看板、跨成员审批 | ⬜ 更远期（P3 新包 `Swarm Plugin`） |

### 9.2 功能归属判定规则

功能归属三问：
1. **这是"一次任务执行"还是"持续调度"？** 一次性 → Subagent；持续派工/汇总 → Coordinator。
2. **有没有"我要等齐哪几个 taskId"的集体承诺（barrier）？** 有 → Coordinator（记录 `pendingTaskIdSet`，集齐后静默触发下一轮 query）。
3. **有没有"长期在线成员 + 双向通信 + 共享任务平面"？** 有 → Swarm（mailbox + task list + leader 权限桥）。

### 9.3 边界红线（防止功能越界揉成一个怪胎）

1. **barrier / 自动续轮不能塞进 Subagent 层**：Subagent 是工具层（被调用者），不知道"父 Agent 某次派工期望等几个"；"集齐 N 个 taskId 再汇总"是调用者侧视角，属于 Coordinator/会话层全局状态。
2. **自动触发 query 是运行时职责**：`agent.query()` 入口由外层（CLI/SDK/IDE）驱动。Coordinator 插件在集齐 barrier 后向外层 command queue 塞一条 `<continue/>` 伪消息，让运行时自然启动下一轮。工具层无权驱动 Runtime。
3. **身份切换是 Coordinator 专属**：`AgentDefinition.mode: 'coordinator'` + `prompt.system.transform` hook 改写 system prompt 为 orchestrator。Subagent 工具不管。
4. **拓扑约束**：teammate 不能嵌套 spawn teammate（防 agent graph 失控）；Coordinator 模式下 worker 不能自己再派后台任务（防"等 A 时 A 在等 B"死锁）。跨层约束只能在 Mode/插件层统一执行。

### 9.4 后续开发清单（边界划分后）

**留在 `@harness/subagent` 层（Subagent 内部增强）**：
- [x] runInBackground + BackgroundTaskRegistry + `<task-notification>` 通知（已完成）
- [x] 移除 task_status 工具、保留 `/tasks` CLI（已完成）
- [x] SubagentTool 描述增强：前台/后台决策规则 + "Don't sleep/poll/peek" 反模式（已完成 P0-1）
- [x] AgentDefinition `background?: boolean` 字段（已完成 P0-2）
- [x] P1-4 前端事件驱动展示（`BackgroundTaskMonitor` + CLI `attachBackgroundTaskPanel` 实时面板）
- [x] P1-5 进度推送（`subagent.progress` Bus 事件 + 面板进度行）

**划归 `Coordinator Plugin`（✅ 已实现 `@harness/coordinator`）**：
- [x] `AgentDefinition.mode: 'coordinator'`（AgentMode 已内置）+ `prompt.system.transform` 注入 Coordinator System Prompt（四阶段规则 + orchestrator 身份）
- [x] **Barrier 同步原语**：`CoordinatorBarrierTracker` 跟踪 per-session 后台任务（订阅 subagent.started/completed/failed），全部完成/失败后发布 `coordinator.barrier.completed` 事件；CLI `attachAutoContinue` 订阅后注入 `<continue/>` 自动续轮（直接解决"多调研任务→等待→汇总"场景）
- [x] forceAsync：插件选项或 `HARNESS_FORCE_ASYNC=true`，`tool.pre.execute` 拦截 subagent 调用强制 runInBackground（原 P2-6）
- [x] send_message 工具：续跑已有 taskId（延续 worker 会话上下文返回回复），仅注入 mode=coordinator 的 Agent
- [x] **文件级写锁（设计修正）**：`FileWriteArbiter` 按 canonical 路径跨 session 互斥，锁持有 = 单次写工具调用（write_file/edit_file，从输入 `path` 提取目标）；同一路径被其他 session 的写操作持有时本次写等待，同 session 内天然串行不加锁。`tool.pre.execute` 在写工具执行前 `acquireWrite`、finally `releaseWrite`。
  - **设计修正说明**：初版为"派工声明级"仲裁（subagent 调用按 `targetFiles`/`AgentDefinition.writesTo` 整组阻塞）——但 agent 实际写哪些文件执行前并不确定，声明级锁会误伤不相关 worker 且锁持有到 worker 生命周期过长。改为文件级后，锁粒度 = 单次写调用，subagent 派工不再阻塞；`SubagentToolInput.targetFiles` / `AgentDefinition.writesTo` 保留为提示性声明（不参与仲裁）。bash 工具无法可靠解析写入路径，不纳入（与 Claude Code 一致，靠 prompt 纪律兜底）。

**划归 `Swarm Plugin`（新包 `@harness/swarm`，✅ 已实现核心）**：
- [x] Team 实体 + team file 持久化：`TeamManager`（`~/.harness/teams/{name}/team.json`，name/lead/members + inboxes/ 目录；create/get/list/addMember/delete，同名成员覆盖）
- [x] Mailbox（锁文件）+ Inbox Poller：`TeammateMailbox`（`inboxes/{agent}.json`，`withLock` 原子锁文件串行化并发写，读未读/标记已读）+ `attachInboxPoller`（周期轮询未读消息回调宿主，纯逻辑可独立测试）
- [x] Task List Plane：`TaskListPlane`（tasks.json 共享任务池，状态机 available → in_progress → completed/failed/cancelled + 生命周期校验 + claim 冲突检测），工具 task_create/list/claim/update/stop
- [x] Leader Permission Bridge：`registerLeaderConfirmQueue`（module-level，CLI/REPL 注册 leader 的 confirm queue）+ `requestPermissionThroughLeader`（teammate ask 权限请求带 workerBadge 回流 leader；无桥 fail-closed 拒绝）
- [x] in-process teammate 基础：`TeammateRegistry` + `withTeammateIdentity` AsyncLocalStorage 身份隔离 + `formatAgentId`
- [x] **in-process teammate 完整执行循环**：`spawnInProcessTeammate`（加入/创建团队 + 独立子 session + 注册 + 初始 prompt 立即执行）、`runTeammateTick`（单轮：mailbox 未读消息处理——普通消息 query 后回复写回发送者、`shutdown_request` 注入模型决策（不直接关停）；`tryClaimNextTask` 认领 available 任务 → query 执行 → 更新任务状态 + 向 leader 发 task_notification）、`startTeammateLoop`（周期驱动 tick，stop/mailbox shutdown 停止）
- [ ] tmux/iTerm2 进程后端（out-of-process teammate）→ 后续增强
- [x] 工具：team_create / team_delete / team_status / send_teammate_message（mailbox 路由，避免与 coordinator 的 send_message 冲突）/ task_* 五件套 / approve_shutdown / reject_shutdown，`tool.pool.assemble` 注入全部 Agent

**Swarm 后续待办（对照 Claude Code 源码调研 `04h-multi-agent.md` / teammateMailbox / inProcessRunner / useInboxPoller / tasks.ts）**：

- [x] **mailbox 协作协议类型扩展**：`MailboxMessageType` 扩至 15 种（permission/sandbox/plan_approval/shutdown/idle_notification/task_assignment/team_permission_update/mode_set_request/task_notification）+ `isStructuredProtocolMessage` 路由（结构化消息不进普通 LLM 上下文）+ 协议 helper（`createPermissionRequest/Response`、`createShutdownRequest/Decision`、`generateRequestId`，requestId/replyTo 配对）
- [x] **权限 mailbox 双轨 fallback**：`requestSwarmPermission`——有 leader 桥走 confirm queue（workerBadge）；无桥且提供 mailbox 时降级（`sendPermissionRequestViaMailbox` 写 permission_request → `registerPermissionCallback` 挂起回调 → leader 写回 response → `processMailboxPermissionResponse` 命中 requestId 配对 resolve）；双轨皆无 fail-closed 拒绝
- [x] **shutdown 模型决策**：`runTeammateTick` 对 shutdown_request 不直接关停，注入 query 由模型调用 `approve_shutdown`/`reject_shutdown` 工具决策；工具回发 shutdown_approved/shutdown_rejected（replyTo=requestId），approve 时插件按 memberName 查 registry abort + 置 shutdown
- [x] **inbox poller 优先级**：`sortMessagesByPriority`（shutdown 最高防 peer 消息饿死 → lead 消息 > peer 消息，同级 FIFO）——poller 与 `runTeammateTick` 共用；投递成功后才 markRead（失败留未读，下轮重试，防丢消息）
- [x] **task 依赖与认领锁**：`SwarmTask.blockedBy`（任务创建可选）+ `claim` 锁内 busy-check——依赖任务全部 completed 才可认领（指向不存在的任务视为未解决），`withLock` 文件锁防 TOCTOU；`tryClaimNextTask` 跳过依赖未解决/已被并发认领的任务
- [x] **idle_notification**：`createIdleNotification` + `runTeammateTick` 每轮结束向 leader 发空闲通知（idleReason: available/interrupted/failed + 处理摘要）；消息循环中途被中断（approve_shutdown 触发关停）时发 interrupted 且不再认领任务
- [x] **plan approval 自动批准 + permissionMode 继承**：`createPlanApprovalRequest/Response` + `requestPlanApproval`（teammate 写请求 + 挂起回调配对）；`processMailboxPlanApprovalRequests`（leader 侧自动批准并回写，携带 leader 当前 permissionMode 供对方继承）；`runTeammateTick` 每轮先处理 plan_approval_response 配对
- [x] **tmux/iTerm2 进程后端**：`spawnTerminalTeammate`（tmux new-session + send-keys 启动 CLI / iTerm2 osascript 建窗）→ CLI 新增 `teammate` 子命令（携带 --team/--name/--agent 身份，复用 boot + startTeammateLoop 轮询 mailbox/认领任务）；`spawnTeammate` 按 backend（in-process/tmux/iterm2）分流，tmuxPaneId 写入 TeamMember
- [x] **team file 字段补全**：`TeamMember` 增 joinedAt / tmuxPaneId / cwd / subscriptions；`TeamFile` 增 leaderTeamName + `setLeaderTeamName`（多后端共享任务池定位；TaskListPlane 本就团队绑定，in-process 已天然共享）
- [x] **send_message 路由统一**：coordinator `send_message` 双路由——mailbox 路由（team + to 单播 / `to='*'` 广播到全部成员）与本地续跑路由（taskId → worker 子会话）；mailbox 通过插件选项依赖注入（`SendMailbox` 接口，不硬依赖 swarm），未注入时 mailbox 路由返回 MAILBOX_NOT_CONFIGURED

## 十、文件历史与回滚：Snapshot / Diff / Revert

> 记录日期：2026-08-24。来源：OpenCode v2 真实源码（`opencode-dev/packages/core/snapshot.ts` + `git.ts`）与 Claude Code fileHistory 分析（`claude-code-analysis-main/快照与回滚.md`）。

### 10.1 方案选型（两案对比）

| 维度 | OpenCode v2（git tree 方案） | Claude Code（fileHistory 文件副本方案） |
|------|------------------------------|------------------------------------------|
| 本质 | 独立 git 仓库 + `git write-tree` 内容寻址 | 备份文件 `{sha256_16}@v{n}` + 快照链元数据 |
| 存储 | tree hash 只存引用，对象库自动去重压缩 | 每个变更文件全量副本（mtime/size 跳过） |
| 依赖 | 用户项目必须是 git | 纯文件系统，不依赖 git |
| 回滚 | `git checkout` / `read-tree`，git 语义保证 | `copyFile` + `chmod` + `unlink` |
| 回滚预览 | 临时 index 零副作用 diff | 备份内容对比统计 |
| 并发 | KeyedMutex 按仓库加锁 | 无 |
| 大文件 | >2MB untracked 跳过 | 无限制 |

**本项目选型：主方案采用 OpenCode git tree 方案（`@harness/snapshot`，✅ 已实现骨架）**，理由：
1. content-addressed tree 天然去重，快照开销 = 一个 hash 字符串；
2. 恢复/回滚复用 git 成熟语义（checkout / read-tree），不自行实现文件恢复；
3. preview 借助临时 `GIT_INDEX_FILE` 可做到零副作用回滚预览。
Claude Code 文件副本方案保留为**非 git 项目 fallback**（见 10.4 后续增强）。

### 10.2 `@harness/snapshot` 包设计（已实现）

**存储位置**：`~/.harness/snapshots/{sha256(worktree).slice(0,16)}`（独立 git 仓库，`--git-dir`/`--work-tree` 显式指定；不触碰用户项目 `.git`，避免污染用户 index/对象库）。

**接口**（`createSnapshotService({ worktree, gitDirectory?, maximumUntrackedFileBytes?, enabled? })`）：

| 方法 | 语义 | 底层命令 |
|------|------|----------|
| `capture(scope?)` | 快照当前状态，返回 tree hash；失败 best-effort 返回 undefined | `diff-files` + `ls-files --others` → `rm --cached`（超限）→ `add --all --sparse` → `write-tree` |
| `files(from,to)` | 两个快照间变更文件列表 | `git diff --name-only -z` |
| `diff(from,to)` | 结构化 FileDiff（status/增删/patch） | `--name-status` + `--numstat` + `--unified=3` |
| `preview(files)` | 零副作用回滚预览（不落盘） | 临时 index → `read-tree` → `update-index --cacheinfo` → `write-tree` → diff |
| `restore(files)` | 选择性恢复（目标树不存在则删除） | `ls-tree` 判定 → `checkout {tree} -- file` / `rm` |
| `checkout(tree)` | 整仓恢复（快照外文件保留） | `read-tree` + `checkout-index --all --force` |

**关键设计决策**：
- **锁**：所有写操作经 `KeyedMutex.run('tree', ...)` 按仓库串行化；`diff`/`preview` 内部复用无锁私有方法（`filesUnlocked`/`diffUnlocked`），避免同 key 嵌套死锁（踩坑记录）。
- **index 同步**：`preview` 在 write-tree 前必须先 `refresh('.')`，否则基准树是上次 capture 的过期状态（踩坑记录）。
- **安全边界**：`restore` 校验路径不得逃逸 worktree（`path.relative` 前缀检查）；未跟踪文件超 `maximumUntrackedFileBytes`（默认 2MB）跳过。
- **错误**：统一 `SnapshotError(operation, message, cause)`，模块特定失败场景。

### 10.3 集成路线（Revert 三态 ✅ 已实现 `@harness/revert`）

1. **capture 挂消息**（✅ 已实现）：AgentRuntime（`AgentRuntimeImpl.query` / `queryStream`）在每轮 LLM 调用后、工具执行前自动 `SnapshotService.capture()`，并把 `meta.snapshot = { start, files }` 挂到生成的 assistant 消息上（`files` = 相对上一轮快照的变更文件，首轮为空）。通过 `createHarness({ snapshot: () => SnapshotService })` 注入，未注入则不启用。对齐 OpenCode `llm.ts` 的 `startSnapshot`。
2. **Revert 三态**（✅ 已实现，`@harness/revert` 的 `SessionRevert`，对齐 OpenCode `SessionRevert.stage/clear/commit`）：
   - `stage({ sessionId, messageID, snapshotMap? })`：定位边界消息 → 收集其后 assistant 消息的快照引用（`collectSnapshotMap`）或显式 `snapshotMap` → `restore` 选择性回滚 → `diff(original → 回滚后)` 生成回滚 diff → 保存 `session.meta.revert`（RevertState）→ 发布 `snapshot.revert.staged`；
   - `clear(sessionId)`：按 RevertState 恢复回滚前的原始快照（撤销回滚）→ 发布 `snapshot.revert.cleared`；
   - `commit(sessionId)`：接受回滚（文件保持回滚后状态）→ 清除 revert 状态 → 发布 `snapshot.revert.committed`。
3. **Bus 事件**（✅ 已实现，域 `snapshot.revert.*`）：`staged { sessionId, messageID, diff, files }` / `cleared { sessionId }` / `committed { sessionId, messageID }`，CLI/UI 订阅展示。
4. **Diff 展示**：回合级 diff 复用工具结果内嵌的 structuredPatch（Claude Code useTurnDiffs 思路，增量聚合），git 快照 diff 作为补充。
5. **CLI `/revert` 命令**（✅ 已实现）：`HarnessApp({ snapshot: true })` 启用（默认关闭，避免非 git 环境开销）；`/revert stage <messageID>`（回滚 + diff 展示）/ `clear`（撤销）/ `commit`（接受）/ `status` / `help`。

**待办**：
- [ ] 无（§10.3 集成路线全部落地；后续增强见 §10.4）

### 10.4 双后端 + 存储治理（✅ 已实现）

**背景**：10.1 选型预留的 4 项边界外增强已全部落地——非 git fallback、check-ignore、git gc 定期清理、快照上限淘汰。

- [x] **非 git 项目 fallback**：`SnapshotService` 重构为接口，`GitSnapshotService`（默认）+ `FileSnapshotService`（纯文件系统，对齐 Claude Code fileHistory）双后端，`createSnapshotService({ backend: 'auto' | 'git' | 'file' })` 工厂，auto（默认）探测 git 二进制（`resolveGitBin` 依次查 PATH / `/usr/bin/git` / `/opt/homebrew/bin/git`），不可用自动降级文件副本后端
  - File 后端存储：`~/.harness/file-snapshots/{worktree-hash}/`（`backups/{sha256_16}@v{n}` + `snapshots.json` 快照链，ID 为 `fs-{seq}` 递增序号）
  - **三级变更检测**（对齐 `checkOriginFileChanged`）：stat（mode/size/mtime）一致直接复用上一备份；stat/mtime 变化再读内容兜底，内容一致仍复用（增量快照避免冗余 I/O）；内容不同才 `copyFile` 新备份（`version+1`）
  - 恢复幂等：`restore`/`checkout` 先判目标备份是否为 null（null → `rm` 删除，对齐 applySnapshot 的 unlink 分支），否则 `copyFile` + `chmod` 恢复权限
  - diff 用简化行 diff（前缀/后缀公共行 + 中间区贪心对齐，识别"插入/删除在中间"的公共行），产出 unified patch + 增删统计，足够回滚预览
  - 与 git 后端接口一致：`capture / files / diff / preview / restore / checkout / gc` + `enabled` 语义 + 越界防护
- [x] **check-ignore 语义过滤快照范围**：
  - git 后端：`refresh` 的 `ls-files --others --exclude-standard` 自动复用用户项目 .gitignore（OpenCode 同款）
  - file 后端：惰性读取 worktree 根 `.gitignore`（简化 matcher：`*` / `**` / `?` / 目录 `/` 结尾 / `!` 取反 / `#` 注释），并额外跳过 `.git` 与位于 worktree 内的 dataDir 自身
- [x] **`git gc --prune=7.days` 定期清理**：`GitSnapshotService.gc()`（公共方法，加锁）+ `gcUnlocked()`（无锁内部实现）；capture 每 `gcEvery` 次（默认 50，0 关闭）自动触发，prune 掉快照注册表（`snapshot-ids.json`）淘汰后无引用的旧对象；自动 gc 在 capture 锁内调用无锁内部方法，避免同 key 嵌套死锁
- [x] **快照上限 / 淘汰策略**（对齐 Claude Code `MAX_SNAPSHOTS = 100`）：
  - git 后端：`maxSnapshots`（默认 100）注册表记录已知 tree hash，超出淘汰最旧（对象由后续 `git gc` 物理清理）
  - file 后端：快照链超出 `maxSnapshots` shift 最旧快照；`gc()` 清理快照链中不再被引用的 `@v{n}` 备份（被淘汰快照独有 → 删除；被保留快照复用的 → 保留）

**验证**：snapshot 包 25 用例全绿（原 11 用例 + git 后端 gc/上限 3 用例 + file 后端全流程/上限淘汰/gc/.gitignore/enabled 8 用例 + 工厂后端选择 3 用例）；core/revert/cli 既有用例无回归；全仓 25 包 typecheck 通过。

---

## 十一、TUI 交互增强计划（P-0）

> 记录日期：2026-08-28。基于 `@harness/cli` TUI（OpenTUI 渲染层，见 [tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）。已具备 Markdown 流式渲染 / 语法高亮 / 文件引用侧栏导航 / 状态栏 / 流式增量批合并。本计划补足「输入体验 + 侧栏信息 + 后台任务」类交互。

### 11.1 能力边界（可落地性确认）

四项增强均基于现有 `useKeyboard` + React state + 既有组件（box/text/input/scrollbox）实现，**不依赖未知 OpenTUI 内部 API**。以下能力留作**后续增强**（不强行占用本批范围）：

- OpenTUI 多行输入（input 内嵌换行编辑）
- 鼠标点击 / 选区复制（依赖 OpenTUI 底层选区事件，待确认）

### 11.2 模块 A：侧栏后台任务实时面板

**目标**：架构 §8.1 点3「前端事件驱动展示」在 TUI 侧闭环——REPL 已有 `attachBackgroundTaskPanel`，TUI 改为把任务状态渲染为侧栏实时面板。

**落点**（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）：
- 复用 `subagentCapability.createMonitor`（与 `attachBackgroundTaskPanel` 同一来源）订阅 `subagent.started/completed/failed`，把任务状态/进度存入 React state。
- 侧栏新增「后台任务」块：`⏳/✅/❌` + taskId + agentName + 进度行（P1-5）。
- 纯函数 `applyBackgroundTaskSnapshot(index, tasks)` 归并状态，便于单测。

### 11.3 模块 B：会话列表展示与切换

**目标**：侧栏列出持久化会话（`app.sessionStore.list()`），可选中切换。

**落点**：
- 新增 REPL/TUI 共用命令 `/resume <sessionId>`（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts) `createProcessLine`）：从 `sessionStore.load` 恢复 → `harness.session.create({title,agentId,cwd,meta})`（与 `main()` resume 一致）→ 换绑 `current` + `setSession` 回调。
- TUI 侧栏「会话」块列出会话，选中后触发 `processLine('/resume <id>')`；切换前 `save` 当前。
- 纯函数 `messagesToBlocks(messages)` 把已加载会话历史渲染成 ChatBlock（供 TuiApp 在 `setSession` 时刷新）。

### 11.4 模块 C：输入体验 — /命令菜单补全 + 输入历史

**落点**（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）：
- 命令菜单：输入以 `/` 开头时，基于 `REPL_COMMANDS` + 插件 `cli.commands`（导出供 TUI 复用）生成候选菜单弹层，↑/↓ 选中、Tab/Enter 补全。
- 输入历史：维护 `history[]`，↑/↓ 在无命令菜单时回看/下滚已提交输入；提交成功后入栈。

### 11.5 模块 D：帮助面板 + 复制辅助

**落点**：
- 帮助面板：按 `?`（或 `Ctrl-/`）显示快捷键帮助 overlay（box 弹层），再按任意键关闭。
- 复制辅助：提供快捷键把最近的 assistant 块文本复制到系统剪贴板（spawn `pbcopy`），不依赖 OpenTUI 选区。
- 鼠标滚动/点击选区复制列为后续增强。

### 11.6 验证

- `tui.test.tsx`：新增覆盖（1）后台任务快照归并、（2）`/resume` 换绑会话 + `messagesToBlocks`、（3）命令菜单候选/补全、（4）输入历史上滚、（5）帮助面板开关、（6）`/copy` 复制最近 assistant 块。
- `cli.test.tsx`：`/resume` 命令在 REPL 层行为。
- cli 全量用例 + typecheck 通过；development-log 记收尾。

> **实现状态（2026-08-31 补录）**：模块 A/B/C/D 均已落地并收尾（development-log 续 30~34）。D 的两个"后续增强"项（鼠标点击复制、选区复制）也已实现：续 33 每消息「复制」按钮、续 34 选区复制 + 欢迎页。新增模块 E「侧栏用量统计面板」已在续 35 落地（见下）。

### 11.7 输入框提交键约定（续 125）

> 记录日期：2026-09-15。落点：`tui.tsx` 全局 `useKeyboard` 提交键分支（位于文件/会话列表分支**之后**，保证列表 Enter 优先）。

**约束（实测）**：在 tmux 式终端复用器（herdr）下，**只有 Enter 的原生 CR(0x0D) 能送达应用**；`Option+Enter`（ESC 前缀）、`Shift+Enter`（需 Kitty 协议）、`Ctrl+J`（LF 0x0A）的修饰/区分信息全部丢失或被吞。故提交键必须落在 Enter 本身，否则用户无法发送消息。

| 按键 | 行为 | 前提 |
| --- | --- | --- |
| `Enter` | 提交 | 始终（列表/命令菜单中为确认选中） |
| `Ctrl+J`（LF） | 提交 | 兼容把 Enter 上报为 LF 的终端 |
| `Shift+Enter` | 换行 | 仅终端上报 Shift（Kitty 键盘协议） |
| `` `\` `` + `Enter` | 换行 | 始终：消费行尾转义反斜杠，不依赖修饰键 |

**实现要点**：

- 自定义提交键**不能**用 textarea 的 `keyBindings`（`@opentui/react` 不透传该 prop，传了被静默丢弃），只能在全局处理器里调 `textareaRef.current.submit()` / `newLine()`；换行后需自行 `setInput(readComposer())`（早返回不会落到文末的微任务同步）。
- `` `\` ``+Enter 仅认**整段缓冲行尾**的反斜杠（不做 `cursorOffset` 偏移计算，避免 CJK 下单位歧义误删字符）；多行缓冲中间行插反斜杠不生效，会走提交。
- `__KEYLOG` 记录 `name:C/S/M`（ctrl/shift/meta）——排查按键问题时先看它。

## 十二、命令审批交互链路（续 39）

> 记录日期：2026-08-31。权限从「规则匹配」升级为「可交互的审批链路」，并在 TUI 提供专属审批模态。核心代码：core [resolvePermission / safeExecuteTool](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts) + cli [CliPermissionEngine](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L751-L814) + TUI [审批模态](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx#L1222-L1232)。

### 12.1 check → ask 两步判定

`resolvePermission(engine, req)` 是工具调用的统一权限入口：

- 先 `engine.check(req)`：按规则（tool 级/全局/路径级 glob）判定，返回 `allow | deny | ask`。
- 只有当 `behavior === 'ask'` 时才调用 `engine.ask(req)`（交给上层交互器）。
- 无交互器时引擎 `ask()` 默认 `deny`（保守拒绝），保证安全默认。

### 12.2 工具执行兜底 safeExecuteTool

`safeExecuteTool(pipeline, tool, input, tctx)` 捕获工具执行抛出的异常，归一化为「失败的 `ToolResult`」反馈给 LLM，避免权限拒绝等异常中断 agent 流：

- 通过错误名 `err.name === 'ToolPermissionDeniedError'` 判定（不依赖类绑定），映射为 `code: 'PERMISSION_DENIED'`。
- 其余异常映射为 `code: 'TOOL_ERROR'`。
- 模型可据此调整行为，流程继续推进。

### 12.3 CLI 权限引擎 CliPermissionEngine

继承 `DefaultPermissionEngine`，为 REPL/TUI 提供可交互的 `ask()`，并支持规则持久化：

- 交互模式 `mode`：`allow-all | ask | deny-all`，`ask` 模式下 prompt 用户选择 `allow / deny / always(save) / deny-always(save)`。
- 永久规则写入 `dataDir/permissions.json`（`options.store.save`）。
- `/permission` 命令：`/permission`（查看 mode 与规则）、`/permission allow-all|ask|deny-all`（切 mode）、`/permission <key>=<behavior>`（设工具规则，如 `bash=deny`）、`/permission reset`（恢复全局 ask 并清空规则）。

### 12.4 TUI 审批模态

TUI 通过 `app.permission.setAskPrompt(cb)` 接管 `ask` 交互，渲染审批弹层 + 全局快捷键：

- 弹层提示命令与操作；`y/Shift-y` 允许/始终允许，`n/Shift-n` 拒绝/始终拒绝。
- 每个时刻仅一个待决审批（`approvalResolveRef` 回填答案）。
- 替换默认 readline 行内提问（REPL 环境的提问会被 TUI 覆盖），提升可见性与体验。

## 十三、bash 沙箱安全防护与宿主回退

> 记录日期：2026-08-31。内置 bash 工具通过 [createBashTool(config)](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/tools-builtin/src/index.ts#L414-L492) 工厂注入多层沙箱防护，并新增「宿主回退」提升非破坏性命令执行成功率。

### 13.1 多层防护（config 控制）

| 层 | 防护内容 | 关闭方式 |
| --- | --- | --- |
| 危险命令检测 | 命中默认/自定义危险正则（`rm -rf /`、fork bomb 等）即拒绝 | `dangerousDetection: false` |
| cwd 限制 | cwd 必须位于 `rootDir`（默认 `ctx.cwd`）内，防路径逃逸 | — |
| 命令白名单 | 配置后仅允许的首命令名/片段命令可执行 | `allowlist: []` |
| env 隔离 | 过滤敏感变量（key/token/password/API key 等） | `sanitizeEnv: false` |

危险命令检测**前置硬性拒绝**，即使开启宿主回退也不可豁免（安全红线）。

### 13.2 宿主回退（fallbackToHost）

`fallbackToHost: true` 时，沙箱内**非破坏性**命令出现以下情形会提升到宿主 bash 重跑，并在 `BashOutput.viaHost` 标注本次经宿主执行：

- 被命令白名单拦截（白名单外非破坏性命令）→ 直接走宿主；
- 沙箱内 spawn 失败或命令非零退出（如敏感 env 被隔离导致命令异常）→ 回退宿主重跑。

宿主回退放开白名单与 env 隔离、使用用户完备环境（含系统 `PATH`）。`bash` 工具 `ok` 语义保持「执行成功即 ok，命令自身结果由 `exitCode` 反映」，仅在 spawn 失败或 AbortSignal 中断时 `ok: false`。

**宿主回退独立确认（`requireHostApproval`，默认 true）**：宿主回退会把"在沙箱约束下已批准"的命令提升到更特权环境执行，因此在回退前再经权限引擎确认——复用 `bash` 权限 key，pattern 前缀 `host:` 标识宿主回退执行；ask 模式会再次询问用户，allow 静默放行，deny 拦截（返回 `SANDBOX_HOST_DENIED`）。危险命令检测仍前置硬性拒绝，不进入确认环节。

## 十四、TUI 增强落地补全（续 33~38 + 续 35）

> 记录日期：2026-08-31。十一为「计划」，本节约这些计划之外后续交付的落地特性。

- **鼠标复制（续 33）**：每条消息提供可点击「复制」按钮，把 assistant 块文本写入系统剪贴板（spawn `pbcopy`）。
- **选区复制 + 欢迎页（续 34）**：读取 OpenTUI 拖拽选区并复制；TUI 启动时无会话历史则显示欢迎页引导，`hasChat` 判定（`blocks.some(kind !== 'system'`）在产生任意用户/assistant/文本块时切换到对话布局。
- **侧栏用量统计面板（续 35，模块 E）**：`packages/cli/src/usage-stats.ts` 累积 UsageStats（token 明细/维度时序），会话级持久化，`/stats` 与 `/stats-export` 报告导出，侧栏顶部图标 tab 实时展示。`/stats-export` 无参数补缺省时段、报错折叠为可复制文本（续 36 健壮性）。
- **命令输入回显（续 38）**：REPL/TUI 命令分支在输出结果的同时回显 `🧑  ${line}` user 块，使命令进入对话历史并触发欢迎页切换，历史一致。
- **/resume 修复（续 37）**：恢复会话后正确换绑 session，解决发送「Session not found」。

## 十五、工作区 / 数据目录管理

> 记录日期：2026-08-31。详见独立开发文档 [workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md)。本文档仅列出核心约定：

- **两级加载**：user 级 `~/.harness/…` 与 project 级 `<cwd>/.harness/…`，project 覆盖 user。
- **dataDir**：`args.dataDir ?? ~/.harness`，承载 `config.json` / `permissions.json` / `sessions/` / `.config-key` / 快照数据。
- **可插拔目录**：`plugins` / `skills` / `agents` 均支持 user+project 两级，来源标注（内置/用户/项目/MCP/插件）。

## 十六、Agentic Loop：现状与改造方向

> 记录日期：2026-09-17。完整改造计划见独立文档 [agentic-loop-plan.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agentic-loop-plan.md)。本节只列架构层面的现状结论。

### 16.1 现状：控制权在引擎外

`AgentRuntimeImpl.query()`（`packages/core/src/index.ts:1332`）与 `queryStream()`（`core:1638`）**都是单轮**：一次模型调用 → 执行工具 → `addMessage` → 结束。没有循环、没有 turn 计数、没有 finish reason 概念。

当前的"续轮"由**引擎外部**驱动：

```
coordinator 检测到 barrier 完成（后台 subagent 任务全部集齐）
  → bus.publish('coordinator.barrier.completed')    coordinator/src/index.ts:493
  → CLI attachAutoContinue 订阅                     cli/src/index.ts:2740
  → 注入伪输入 '<continue/>'（rl.emit('line')）      cli:3455
  → readline 的 'line' 处理器再走一次 processLine    cli:3457
```

这是**有意解耦**——coordinator 插件注释明确写着「插件只负责检测 barrier 完成 + 发布事件，不直接驱动 query」，符合 §九 的多 Agent 职责边界。但代价是：**只有后台任务集齐才续轮，普通工具链（read → edit → bash）无法自主多步**。swarm 的 teammate tick（`plugins/swarm/src/index.ts:1171`）同理，每 tick 只调一次 `agent.query()`。

### 16.2 与两个参考架构的差距

| 维度 | Claude Code | Opencode | 本项目 |
|---|---|---|---|
| 主循环 | `queryLoop()`（query.ts:241，1729 行） | `runLoop`（session/prompt.ts:1098） | 无（外部 `<continue/>`） |
| 终止依据 | finish reason 无 tool results | `finish` 非 `tool-calls` + `hasToolCalls` 兜底 | —— |
| 步数上限 | `maxTurns` + `turnCount` | `agent.steps` + `MAX_STEPS_PROMPT` 收尾提示 | 无 |
| 重复调用保护 | maxTurns 兜底 | `DOOM_LOOP_THRESHOLD=3` 主动检测 | 无 |
| 压缩挂载点 | 循环体内 autoCompact | compaction 作为 continue 分支 | `session.preModel`（已有） |

参考实现有两条值得抄的细节：

1. **退出判断不能只看 finish reason**：部分 provider 返回 `stop` 但消息体里仍带 tool calls（opencode `prompt.ts:1123` 的 `hasToolCalls` 兜底），只看 reason 会提前退出、工具结果永远送不回模型；同时要排除被打断的孤儿工具以免多跑一轮。
2. **步数到顶要"请模型收尾"而非硬截断**：opencode 在 `isLastStep` 时往 messages 尾部追加 `MAX_STEPS_PROMPT`（`prompt.ts:1298`）。

### 16.3 改造的阻塞点与已有基础

**唯一 P0 阻塞点**：`ChatCompletionOutput`（`core:378`）没有 finish 字段，而它恰恰是循环终止的核心依据。好消息是**数据已在 provider 层、只是没透传**——`provider-anthropic:115` 有 `stop_reason`、`provider-openai:120` 有 `finish_reason`（openai 甚至已在用它判 `tool_calls`，见 `:730`），故这一步是纯加法、零行为变化。

**已有基础（零改动）**：

- **工具结果回喂格式就绪**：两个主流 provider 都会把 assistant 消息里带 result 的 tool part 自动拆成合规角色（Anthropic → `tool_result` block；OpenAI → `role:'tool'` 消息带 `tool_call_id`，`provider-openai:227/292`）。session 层保持"assistant 消息内嵌工具结果"的统一模型，序列化时再拆 ⇒ **不需要动消息模型**。
- **ACP 按轮设计**：`session.preModel` 本就每轮执行，`bench/compress-params.ts` 的 `--steps=100/140/200` 就是模拟多轮，参数表在此基础上实测 ⇒ 循环上线后无需重调参数。

**主要风险**在协调层：`coordinator` 的 barrier 续轮已在承担「链式执行」职责，内部循环上线后两者可能双重驱动。计划把 S0~S3 在关闭 coordinator 的前提下验证，S4 再单独协调三层职责（引擎内循环 = 工具结果回喂；barrier = 跨轮推进；`<continue/>` = 仅 barrier 场景）。
