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

  // === 来源（三来源同 Claude Code） ===
  loadedFrom: 'bundled' | 'user' | 'project' | 'mcp'

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

---

### 3.6 Session Manager：持久化 + 可恢复

**融合 OpenCode Session 文档的完整结构：**
- Message + Part 模型（text/tool/file/reasoning/patch）
- Compaction 三级：prune → summary → auto agent 压缩
- Snapshot + Revert/Unrevert（同 OpenCode revert.ts）
- Todo List Plane（独立存储 + Bus 通知）

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

### 3.8 Bus 事件总线：类型安全解耦

**同 OpenCode Bus 设计：**
- `BusEvent.define<T>(name, zodSchema)` 类型安全定义
- `publish/subscribe/subscribeAll` 三 API
- 事件自动桥接 SSE（Web UI）

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

#### P1-5：进度推送（⬜ 待实现）

**目标**：子 Agent 执行中的工具调用进度通过 Bus 事件实时推送到前端。

**改动**：
- 新增 `subagent.progress` Bus 事件，包含 `{ taskId, toolName, toolStatus, summary }`
- 子 Agent 每次工具调用时发布进度事件
- 前端 `BackgroundTaskPanel` 展示实时进度

**参考**：OpenCode `Bus.subscribe(PartUpdated)` → `ctx.metadata` 推送模式

**依赖**：P1-4（前端组件）

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
✅ P1-4 (前端展示: BackgroundTaskMonitor + CLI 任务面板) ──→ ⬜ P1-5 (进度推送)
→ Coordinator 插件承载 (forceAsync / barrier / SendMessage) — 见第九节
```

P0-2 和 P0-3 可并行开发，P0-1 依赖 P0-3 完成后才能在 prompt 中承诺"系统自动通知"。

---

## 九、多 Agent 模式边界：Subagent / Coordinator / Swarm

> 记录日期：2026-08-24。来源：Claude Code `04h-multi-agent.md` 分层体系 + 本项目实现决策。

### 9.1 三层模式定位（不是功能叠加，是抽象升级）

| 层级 | 定位 | 类比 | 状态 |
|------|------|------|------|
| ① Subagent | **执行单元**：一次性、无状态的任务执行器，父 Agent 调用工具 spawn，跑完即走，结果返回创建者 | 派"外包"做单点任务，做完结算走人 | ✅ 已实现（`@harness/subagent`） |
| ② Coordinator | **调度单元**：切换主线程身份为 orchestrator，自己不写代码，负责 Research→Synthesis→Impl→Verify 四阶段派工、汇总、续派 | "项目经理"角色，全程跟进分阶段调度，不亲自干活 | ⬜ 后续计划（P3 新包 `Coordinator Plugin`） |
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
- [ ] P1-5 进度推送（`subagent.progress` Bus 事件）

**划归 `Coordinator Plugin`（新包，P3，架构图 Phase 4 已预留位置）**：
- [ ] 环境变量 `HARNESS_COORDINATOR_MODE` + `AgentDefinition.mode: 'coordinator'` + Coordinator System Prompt（四阶段规则 + "You orchestrate, not implement"）
- [ ] **Barrier 同步原语**：记录 `pendingTaskIdSet`，集齐后自动注入 `<continue/>` 触发下轮 query（直接解决"多调研任务→等待→汇总"场景）
- [ ] forceAsync 开关：所有 subagent spawn 强制 runInBackground（原 P2-6）
- [ ] SendMessage / Resume 工具：续跑已有 taskId（不是新建子 Agent）
- [ ] 写操作按文件集串行化调度策略（检测 target 文件集冲突，延迟执行冲突 worker）

**划归 `Swarm Plugin`（新包，更远期 P3）**：
- [ ] Team 实体 + team file 持久化
- [ ] Mailbox（锁文件）+ Inbox Poller
- [ ] Task List Plane（TaskCreate/List/Claim/Update/Stop）
- [ ] Leader Permission Bridge（队友权限请求借用 leader 的 ToolUseConfirmQueue）
- [ ] in-process teammate（AsyncLocalStorage 隔离）+ tmux/iTerm2 后端
