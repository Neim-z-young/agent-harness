# 对外接入方案：A2A 协议 与 VSCode UI

> 状态：**方案待评审**（仅设计，未实现）
> 日期：2026-09-30
> 范围：让 agent-harness（下称 harness）① 作为 A2A 服务被其他 Agent/系统调用；② 以 VSCode 作为人机 UI。
> 修订：2026-09-30 评审后修订 —— §3.1 协议口径重写为 v1.0（原稿整体是 v0.3 写法）；§2 修正 MCP 基建方向、补 `harness teammate`；§3.2 改为基于官方 SDK 骨架；新增 §3.4 挂起与唤醒、§3.5 并发幂等隔离；B1 降级为"需自建 MCP server"；P0 补接口清单与搬迁清单、新增 P0.5 spike。

---

## 1. 背景与目标

harness 当前的人机界面是 CLI/REPL/TUI（OpenTUI 终端），对外的非交互方式只有 `harness run`（一次性 headless）与 `harness teammate`（长驻 out-of-process 成员，走共享目录 mailbox 协作）。两类新诉求：

1. **A2A（机器对机器）**：harness 被 agent 生态发现与调用——其他框架/厂商的 Agent 能通过标准协议发起任务、拿流式结果、取消、续接会话。
2. **VSCode（人）**：用户不离开编辑器即可使用 harness，并逐步把 TUI 的多块渲染、会话/任务/统计侧栏搬进 IDE。

设计目标：

- **core 零改动**：协议与 UI 都是"宿主"，全部能力经现有公共 API + 插件机制接入，符合项目插件化硬约束。
- **一份装配、多个宿主**：CLI / A2A server / VSCode sidecar 共用同一套 harness 装配逻辑，不允许各壳复制一份再分叉。
- **不发明私有协议**：机器侧直接采用 A2A v1.0（Linux Foundation）；IDE 侧优先利用 VSCode 原生 Chat API，终态才上自研 webview。

**边界申明（对齐 AGENTS.md「业务能力一律通过插件注入」）**：`@harness/host` 与 `@harness/a2a-server` 定位为**宿主/适配器层**（与 `@harness/cli` 同级），不是业务能力插件；它们只做装配与协议翻译，不内置任何业务决策。反之，**把 harness 工具对外暴露（B1）属于"能力"**，按纪律应做成插件（详见 §4.1）。

---

## 2. 现状盘点：已具备的接入面

| 能力 | 现状 | 接入意义 |
|---|---|---|
| 统一入口 | `createHarness(options: AgentHarnessOptions): Promise<Harness>`（`packages/core` 4511 行） | 任意宿主可直接装配，无需 CLI |
| 流式会话 | `session.promptStream(sessionId, text, maxSteps?, signal?) → AsyncGenerator<AgentStreamEvent>`（`core:1095`） | A2A SSE / VSCode 流的同一数据源 |
| 事件完备性 | `text_delta` / `reasoning_delta` / `tool_call_start` / `tool_call_result` / `done`（每步）/ `turn_end`（整轮终态，含 `aborted`）/ `step_gate`（等待心跳，含 `overBudget`）；定义见 `core:651` | 协议映射所需语义齐全，无需引擎补事件 |
| 会话持久化 | `create/get/list/search`，会话与消息落盘在 dataDir，跨进程可恢复 | A2A `contextId` 天然映射 sessionId；断线重连/历史查询零额外存储 |
| 权限接口 | `PermissionEngine.ask(req)` 为异步可插拔接口；`CliPermissionEngine extends DefaultPermissionEngine` 只覆盖 ask 实现 | 远程 UI 只需换一个实现，check→ask 两步语义不变，**core 无需改动** |
| 事件总线 | `AgentEvents.stepGate`、`SubagentEvents.*`、`LifecycleEvents.*`、barrier | 外部 UI 订阅 bus 即可呈现后台任务面板/终态 |
| headless | `harness run "prompt"`（stdout 纯结果，用量走 stderr） | 最粗粒度的零开发远程调用方式 |
| 跨进程先例 | `harness teammate`：长驻 out-of-process 进程，经**共享目录 mailbox** + 任务面协作（`packages/plugins/swarm`） | 已有"一条 harness 进程被外部驱动"的现成形态，sidecar 设计应先说明为何不复用它 |
| MCP **客户端**基建 | `mcp-client`（stdio/http/sse transport、OAuth2 PKCE、token 加密持久化）+ `mcp-server-registry`（**注册"要连的" server**，`McpClient` + `convertMcpToolToHarnessTool` 把**对方**工具转成 harness 工具；computer-use 的"进程内 server"也是 harness 自连自） | ⚠️ **方向是 client，不是 server**：它让 harness 会**用** MCP，不提供"被 IDE 当 MCP server 调"的能力。仓库内无 server 端实现，也无 `@modelcontextprotocol/sdk` 依赖 ⇒ B1 是**从零写 MCP server**，不是复用（见 §4.1） |

**三个需要正视的现状：**

1. **装配逻辑集中在 CLI**：config.json 读取、provider 归一化与密钥解析（`SecretCipher`，明文/`${ENV}`/`enc:v1:`）、两级插件目录加载（user `~/.harness` + project `.harness`）、`CliPermissionEngine`、内置工具 L1 元信息+L2 惰性加载，目前都在 CLI 的 `HarnessApp.boot()` 中（`packages/cli/src/index.ts:2896`–`3325`，约 **430 行**，内含 **16 处 `stdout?.write`**）。这是三个宿主共同的复用前提，必须先抽出（见 §6 P0）。
2. **要搬迁的不止 boot 的方法体**：`BuiltinPluginRegistry` / `getBuiltinRegistry` / `resolveBuiltinPlugins` / `preloadBuiltinToolMetas` / `loadPluginDirs` / `buildProviderWindowTable` 等装配符号**全部定义在 `packages/cli/src/index.ts`**（不在 core），且 `cli.test.ts` 直接 import 它们 ⇒ "抽 host"实际是把上千行从 cli 搬到新包并保持 re-export 兼容，不是"把 boot 参数化"就算完（见 §6 P0）。
3. **运行时是 Bun**：各包直接导出 TS 源码（`exports → ./src/index.ts`，无 dist），由 Bun 消费。非测试源码中仅 `@harness/snapshot` 使用 `Bun.spawn` / `Bun.spawnSync`（3 处），其余均为 `node:*` API —— 这是 fork 结论，但**不代表 sidecar 可以无脑 `--compile`**（见 §8）。

---

## 3. 方案 A：A2A Server

### 3.1 协议口径（**以 `@a2a-js/sdk` 导出常量为唯一事实源**）

A2A 当前 **v1.0，已捐赠 Linux Foundation**（原 Google 贡献）。TS 官方 SDK `@a2a-js/sdk` 的 1.0 **GA 于 2026-07-22**，实现规范 v1.0.0，并带一层 opt-in 的 v0.3 兼容（`@a2a-js/sdk/compat/v0_3`）。

> ⚠️ **纪律**：v0.3 → v1.0 是 **breaking 变更**（方法名、枚举名、Part 结构都改过），网上大量示例仍是 v0.3。本方案所有方法名/枚举名/路径**一律取自 SDK 常量**（`AGENT_CARD_PATH`、`A2A_PROTOCOL_VERSION`、`A2A_VERSION_HEADER`、SDK 生成的 `TaskState` 类型），不照抄博客与旧文档。**开工前钉死 SDK 版本号**。

- 绑定：JSON-RPC 2.0 over HTTP（`Content-Type: application/json`）；流式为 SSE（`text/event-stream`）；另有 HTTP+REST（`application/a2a+json`）与 gRPC binding（本期不选）。
- **每个请求须带服务参数头**：`A2A-Version: 1.0`（Bun 侧同时是版本协商入口，SDK 有 `validateVersion` / `VersionNotSupportedError`）；`A2A-Extensions` 用于扩展。
- 发现：`AGENT_CARD_PATH` = `/.well-known/agent-card.json` 返回 **AgentCard**。
- 核心对象：
  - **Task**：`id` + `contextId` + `status` + `artifacts` + `history` + `metadata`。
  - **TaskState**（v1.0 为 protobuf 生成，**枚举名带前缀**，共 9 个）：`TASK_STATE_UNSPECIFIED` / `TASK_STATE_SUBMITTED` / `TASK_STATE_WORKING` / `TASK_STATE_COMPLETED`（终态）/ `TASK_STATE_FAILED`（终态）/ `TASK_STATE_CANCELED`（终态）/ `TASK_STATE_REJECTED`（终态）/ `TASK_STATE_INPUT_REQUIRED`（中断态）/ `TASK_STATE_AUTH_REQUIRED`（中断态）。`ListTasks` 过滤示例即 `status=TASK_STATE_WORKING`。
  - **Message / Part**：`role` 取 `ROLE_USER` / `ROLE_AGENT`（带前缀），`SendMessage` **必填 `messageId`**；Part 是 oneOf，v1.0 **已删除 v0.3 的 `kind` 判别符**，改为按存在字段判定 `text` / `raw` / `url` / `data`（另有可选 `metadata` / `filename` / `mediaType`）。**Artifact** 为任务产出（一个或多个 Part）。
- 方法映射（v1.0，JSON-RPC 方法名为 **PascalCase**）：

| 操作 | JSON-RPC 方法 | REST 端点 | 本期 |
|---|---|---|---|
| 发送消息（非流式） | `SendMessage` | `POST /message:send` | ✅ 一期 |
| 发送消息（流式 SSE） | `SendStreamingMessage` | `POST /message:stream` | ✅ 一期 |
| 取任务 | `GetTask` | `GET /tasks/{id}` | ✅ 一期 |
| 取消任务 | `CancelTask` | `POST /tasks/{id}:cancel` | ✅ 一期 |
| 订阅既有任务（断线重连） | `SubscribeToTask` | `POST /tasks/{id}:subscribe` | ⏳ 二期（文件持久化天然支持） |
| 列出任务 | `ListTasks` | `GET /tasks` | ⏳ 二期（**必须映射 task 而非 session**，见 §3.5） |
| 推送通知配置 | `CreateTaskPushNotificationConfig` 等 | `POST /tasks/{id}/pushNotificationConfigs` | ❌ 附录 |
| 扩展卡片 | `GetExtendedAgentCard` | `GET /extendedAgentCard` | ❌ 附录 |

> 注意：`/tasks/{id}:cancel`、`/tasks/{id}:subscribe` 是 **REST 端点**，不是 JSON-RPC 方法名；原稿把两者混进同一列。

#### 3.1.1 spike 实测补充的三条口径（**都会静默失败**）

`@a2a-js/sdk@1.3.0` 已**钉死并实测**（`spikes/a2a/`）。上面取自 SDK 常量的部分全部核对通过，
另有三条是读类型定义读不出来、只有跑起来才会撞上的：

1. **Part / Message 有两套表示，不能混用。** SDK 内部是 protobuf 对象：TS 侧写
   `content: { $case: 'text', value }`，但**线上 JSON 是 `{"text":"...","mediaType":"..."}`**。
   把 TS 内部表示直接 `JSON.stringify` 发出去，服务端 `fromJSON` 会**静默丢弃内容、不报错**
   （实测回显 `echo: hello` 变成 `echo: `）。
   ⇒ **出参一律走 SDK 导出的 `MessageFns.toJSON()`**（`Message` / `Task` / `AgentCard` 都有）；
   入参若由我们构造也要 `toJSON`。**`Response.json()` 可以直接用**：protobuf 对象自带 `toJSON()`，
   `JSON.stringify` 会自动调用 —— 已实测输出格式正确。
2. **`TaskState` 是数字 enum，线上是字符串。** `TaskState.TASK_STATE_COMPLETED === 3`，而 JSON 里是
   `"TASK_STATE_COMPLETED"`。事件映射表与状态比较**必须按字符串**（或用 `taskStateFromJSON`）。
3. **版本校验不归 transport 管。** `JsonRpcTransportHandler` 不校验 `A2A-Version`，
   **宿主必须自己调 `validateVersion(requestedVersion, card, 'JSONRPC')`**；头缺失时
   `ServerCallContext.requestedVersion` 默认 `'0.3'`（卡片只声明 1.0 ⇒ 应拒绝）。
   `validateVersion` 从 `@a2a-js/sdk/server` 导出，**根入口不导出**。

### 3.2 架构：**基于 SDK 骨架，不自建协议壳**

`@a2a-js/sdk` 已提供 `AgentExecutor`（`execute` / `cancelTask`）、`DefaultRequestHandler`（请求路由、任务存储、版本校验、取消、推送）+ `ExecutionEventBus` + `TaskStore`（含 `InMemoryTaskStore`）与三种 transport handler。**自建"任务表 + 事件映射 + 取消桥"等于重做一遍 SDK 的活**，且更容易违反"不发明私有协议"。

新增包 `packages/a2a-server`（宿主/适配器层，非业务插件）：

```
A2A Client（其他 Agent）
   │  HTTP JSON-RPC（SendMessage / SendStreamingMessage / GetTask / CancelTask）
   │  + A2A-Version: 1.0 头 + Bearer 认证
   ▼
@a2a-js/sdk 骨架（DefaultRequestHandler + transport handler，挂在 Bun.serve 上）
   ├─ AgentCard 生成器     ← harness.agent 注册表（AgentDefinition → skills + supportedInterfaces.protocolVersion）
   ├─ AgentExecutor         ← 我实现：execute() 消费 session.promptStream；cancelTask() abort
   ├─ TaskStore             ← 我实现：task 记录（含 state / artifacts）落盘或由会话派生
   ├─ 消息映射层            A2A Message/Part ↔ harness Message
   ├─ 事件映射层            AgentStreamEvent → SDK StreamResponse（Task/StatusUpdate/ArtifactUpdate）
   ├─ 权限回问通道          engine.ask() → TASK_STATE_INPUT_REQUIRED + 挂起任务表（§3.4）
   ▼
@harness/host（§6 P0 抽出的装配层）→ createHarness
```

定位约束：只做翻译与装配，**不内置任何业务决策、不绕过权限、不直接调工具**。需先 spike 确认 SDK 的**无框架** server 入口能与 `Bun.serve`（web 标准 Request/Response）对接——不要走需要 `express` peer dep 的那条集成路径。

### 3.3 事件映射（含**必要的合并**，不是逐条转发）

原则：**终态归一、可合并的按块合并、不引入业务状态机**。原稿"逐条转发"在 token 级事件上不成立（见下表说明）。

| harness 侧 | A2A 侧 |
|---|---|
| 请求带 `contextId` 且会话存在 | `session.get(contextId)` 恢复；否则 `session.create()`（新 sessionId 即新 contextId） |
| 请求到达 | Task `TASK_STATE_SUBMITTED` → `TASK_STATE_WORKING` |
| `text_delta` | **按块合并**后发 `artifact-update`（`append: true`）；整轮结束输出最终文本 Artifact。⚠️ 不得每个 delta 发一条 |
| `reasoning_delta` | **合并**后周期性发 `status-update(WORKING, final=false)`，或降为 message/artifact 的 `metadata` 摘要。⚠️ 不得逐 token 发状态 |
| `tool_call_start/result` | `status-update(WORKING)` + metadata（工具名/入参摘要/成败），不作为 Artifact 正文 |
| `step_gate`（含 `overBudget`） | `status-update(WORKING)` 心跳；超预算时在 message 注明"等待异常偏久" |
| `turn_end`（正常） | `status-update(final=true, state=TASK_STATE_COMPLETED)` + 最终 Artifact |
| `turn_end.aborted` | `TASK_STATE_CANCELED` |
| 异常 / DOOM_LOOP / 权限硬拒 | `TASK_STATE_FAILED`（结构化 code + message，不泄露堆栈） |
| 权限 `ask()` | **`TASK_STATE_INPUT_REQUIRED`**（A2A 原生中断态）+ 结构化待决描述；客户端答复后**以同一 taskId 续接**（见 §3.4） |
| `CancelTask` | `AbortController.abort()`（harness 在步边界/工具前生效，保留已完成部分） |

> **为什么必须合并**：`text_delta` / `reasoning_delta` 是**分片级**（每几十 token 一次），而 A2A 事件是**任务生命周期级**。逐条转 `status-update` 会产生上千条状态更新（客户端 UI 抖动 + 流量浪费），与原稿"不引入聚合状态机"的自设原则直接冲突。合并只发生在**展示粒度**上，不改引擎语义。

### 3.4 挂起与唤醒：`INPUT_REQUIRED` 怎么跨请求持有

这是远程权限设计的**核心机制**，原稿缺失。要点：

1. 权限询问发生在 `session.promptStream` 生成器**内部**，而答复会从**另一条 HTTP 请求**到达（`SendMessage` 带同一 `taskId`）。因此任务必须能被"停在 ask 上"并跨请求持有：
   - 进程内维护 **挂起任务表** `taskId → { generator, pendingAsk, resolve, deadline }`；
   - `ask()` 返回一个 Promise，**由挂起任务表持有其 resolver**，同时向 SSE 流推一条 `TASK_STATE_INPUT_REQUIRED` 状态更新；
   - 后续 `SendMessage`/答复请求按 `taskId` 找回 resolver → resolve → 生成器继续跑。

> ✅ **spike 实测（1.3.0）：可行，且比上面设想的"保存并恢复生成器"简单一档。** 走的是**模式 A**：
> executor 在 `INPUT_REQUIRED` 之后**不返回**（`await` 答复），挂起表只需 `taskId → resolver`，
> **不必跨请求保存/恢复 generator**：
> - `ExecutionEventQueue.events()` 在 `message`、终态、**或 `INPUT_REQUIRED`** 时终止 ⇒
>   **阻塞式 `SendMessage` 照样立即返回 `INPUT_REQUIRED`**，不必等终态（正好满足下方要点 2）；
> - 后续带同一 `taskId` 的 `SendMessage` 会**再次调用 `execute`**，此时
>   `requestContext.task.status.state === TASK_STATE_INPUT_REQUIRED` ⇒ 这一轮只负责把答复喂给
>   resolver 唤醒第一轮，然后 **立即 return**（不再自己发事件）；
> - 第一轮被唤醒后补发 artifact + `TASK_STATE_COMPLETED` ⇒ **续接请求的调用方直接拿到最终 artifact**
>   （实测 6c/6d 两条断言即验此路径）。
>
> 代价与不变项：① executor 的 Promise 会长期悬挂，**TTL 与回收仍然要做**（要点 4 不变）；
> ② 第一轮那条 SSE 连接会一直挂到答复到达 —— 客户端应自行断连后用 `SubscribeToTask` 重连；
> ③ SDK 的 `DefaultRequestHandlerOptions.keepBusAliveStates` 默认已含
> `INPUT_REQUIRED` / `AUTH_REQUIRED`，是为"executor 返回后仍保活"的模式 B 准备的 ——
> 模式 A 下 executor 根本没返回，bus 天然存活，**这个默认值对我们是多余的保险，不必改**。
2. **不能"聚合到终态才返回"**：非流式 `SendMessage` 也必须能返回 `INPUT_REQUIRED`（以及在工作开始时返回 `WORKING` 的前置状态），否则挂起语义永远到不了客户端。⇒ 原稿 §3.4"message/send 内部聚合到终态后一次性返回"作废，改为"**返回首个非 `WORKING` 的稳定状态，或首个中断/终态**"。
3. **幂等唤醒**：重复答复、答复迟到于超时之后、答复里带旧 `messageId`，都必须被安全忽略（见 §3.5）。
4. **超时与回收**：挂起任务需有 TTL；超时转 `TASK_STATE_FAILED`（或按配置取消），并释放生成器，避免泄漏。
5. **待决描述要结构化**：`INPUT_REQUIRED` 的 message/metadata 必须带工具名、入参摘要、可选项（允许一次 / 本会话始终允许 / 拒绝）——否则标准客户端只看到"需要输入"却不知道该答什么。选项映射进 `CliPermissionEngine` 已有的规则持久化模型（permissions.json）。

### 3.5 并发、幂等与隔离

| 问题 | 现状缺口 | 对策 |
|---|---|---|
| **并发** | 同一 `contextId`（= sessionId）并行两条消息，会让两个 loop **交错写同一会话** | per-session 串行队列；或在检出进行中任务时显式拒绝（返回结构化错误）。二者择一，不能默认并行 |
| **幂等** | 客户端重试同一条 `SendMessage`（网络抖动）会**重复执行、重复计费** | 按 `messageId` 去重（已处理过的 messageId 直接回放其结果/状态） |
| **隔离** | 单一 Bearer 之下，任一持 token 者可 `GetTask`/续接**任意** `contextId`，读到别人的会话 | 多租户可延后，但"**contextId 绑定调用方**"不能延后：至少做 token 维度的命名空间校验 |
| **`ListTasks` 语义** | 原稿把 `tasks/list` 映射到 `session.list` —— 而本方案自己定义了"**一 session 多 task**"（taskId = 单次请求） | 二选一：① 落盘 **task 索引**，`ListTasks` 列 task（推荐，v1.0 新加 ListTasks 正是为解决"丢 taskId 就丢工作"）；② 显式降级为不支持。**不可**用 session.list 顶替 |

### 3.6 关键设计点

- **会话与任务两个 id 不混用**：`contextId = sessionId`（多轮归属），`taskId = 单次请求 id`（取消/查询单位）。**续接一律按 taskId**（含权限答复），contextId 只用于归属与历史。
- **认证**：一期单一 Bearer token / API key（AgentCard `securitySchemes` 声明，支持 `${ENV_VAR}` 引用）；不做 OAuth/mTLS。
- **安全默认**：服务默认仅监听 `127.0.0.1`；暴露到网络需显式配置并同时要求认证。工具写操作仍全部经过 harness 权限引擎，协议层不加旁路。
- **AgentCard 生成**：由 `AgentDefinition`（id/name/description/mode）生成 skills；顶层 `version` = **harness/agent 自身版本**，协议版本写在 `supportedInterfaces[].protocolVersion = "1.0"`；`capabilities.streaming = true`。`mode: 'subagent'` 的 agent 是否暴露为独立 card 由配置开关决定（默认只暴露 primary）。
- **与 MCP 的分工**：A2A 暴露的是"自治 Agent（带会话与任务生命周期）"；MCP 暴露的是"工具集"。同一 harness 可同时开两种服务，不互相替代。

---

## 4. 方案 B：VSCode 接入

三条路径，投入与体验不同，按阶段采用而非三选一。

### 4.1 B1：MCP Server（**需自建，非复用**）

把 harness 的工具暴露为 MCP **server**（stdio），VSCode 侧由支持 MCP 的聊天客户端（Copilot Chat / Continue / Cline 等）挂载。

- ⚠️ **工作量修正**：仓库现有的 `mcp-client` + `mcp-server-registry` 全是**客户端**方向（harness 去连别人的 server）。要做 B1 必须**从零实现 server 端**：`initialize` / `tools/list` / `tools/call` 三组方法 + stdio transport（newline-delimited JSON-RPC）+ 把 harness `Tool` 转成 MCP tool 描述 + 写操作的权限桥。仓内无 `@modelcontextprotocol/sdk` 依赖，可自行实现或引入 SDK。
- 优点：**零自研 UI**，工具调用、确认、流式输出全部复用客户端。
- 局限：MCP 是"工具集"语义，无法呈现 harness 的自主多步 loop、多 agent roster、子 agent 面板、会话压缩与统计；体验完全受客户端约束。
- 纪律：按 AGENTS.md"业务能力一律通过插件注入"，本项应做成**插件**（如 `plugins/mcp-server`），而不是宿主包。
- 定位：**快速验证"在 IDE 里被调用"**，不是终态。

### 4.2 B2：Chat Participant（中等，原生聊天体验）

通过 `chatParticipants` contribution 注册 `@harness` 参与者，使用官方支持的"**转发请求到后端服务**"模式：

```
VSCode Chat 面板 ──► extension host（Node，薄）
                      ├─ 本地 HTTP+SSE 连 A2A server（方案 A），或
                      └─ spawn sidecar 走 stdio JSON-RPC
                   ResponseStream：markdown / progress / button / fileTree
```

- 优点：原生 Copilot Chat 外观；支持流式 markdown、follow-ups、斜杠命令（`/compact`、`/agent`、`/stats`）、文件树/按钮等 response part；开发量集中在转发与渲染。
- 局限：UI 形态被 Copilot Chat 框定；TUI 的多侧栏（会话/任务/文件引用/统计）搬不过去；Chat API 依赖 Copilot Chat 扩展存在。
- 定位：**v1 产品形态**，与 A2A server 天然复用。

### 4.3 B3：独立扩展 + Webview（终态，完整复刻 TUI）

Extension host（Node）+ React webview（Vite）+ 类型化双向消息桥。这是同类自主编程 Agent 插件已验证的架构：host 侧跑 agent 调度/工具/权限，webview 渲染 reasoning 折叠块、工具块、diff 预览、会话与任务侧栏。

- 优点：UI 完全自主；现有 TUI 的 ChatBlock 块模型、选区、侧栏纯函数（`applyStreamEvent` / `pushConsole` / `computeTuiStats` 等）可直接平移为 web 组件与 reducer。
- 难点：**harness 是 Bun 运行时，VSCode extension host 是 Node**（见下表）。

| 集成方式 | sidecar：spawn bun 进程（推荐 v1） | 进程内嵌入 Node host |
|---|---|---|
| 运行时适配 | **零适配**，harness 原样运行 | 需 esbuild bundle 全部 TS 源码；`@harness/snapshot` 的 `Bun.spawn` 改为 `node:child_process`（仅此一处），其余天然 Node 兼容 |
| 生命周期 | 扩展负责子进程启停、端口/stdio 协商 | 与扩展同生命周期，调试简单 |
| 传输 | stdio JSON-RPC（最简）或本地 HTTP+SSE（复用 A2A） | 函数调用 + bus 订阅（仍需消息桥到 webview） |
| 分发 | 用 `bun build --compile` 产出单文件二进制随扩展分发，免去用户安装 bun —— ⚠️ **需先验证**（见 §8 第 1 条） | 纯 npm 扩展，无外部依赖 |
| 结论 | **v1 采用** | v2 收敛目标 |

### 4.4 VSCode 侧的权限与取消

- **权限**：host 收到 harness 的 ask 请求 → webview 授权卡（允许一次/本会话始终允许/拒绝）→ 回传决策；映射进 `CliPermissionEngine` 已有的规则持久化模型（permissions.json）。**与 §3.4 是同一机制的两个壳**。
- **取消**：webview "■ 终止" → extension 调取消 → sidecar abort（stdio 发 cancel / HTTP 调 `CancelTask`）→ harness 在步边界生效，保留已完成部分。
- **工作区**：扩展以当前 workspace folder 作为 harness `cwd`；dataDir 仍走 user/project 两级目录约定。

---

## 5. 总体架构

```
                    ┌─ VSCode 扩展（建议独立仓库 adapters/vscode，避免 IDE 依赖进主 monorepo）
                    │   ├─ B2 Chat Participant（v1，薄转发）
                    │   └─ B3 React Webview（终态，块模型/侧栏平移）
                    │        host ↔ sidecar：stdio JSON-RPC 或本地 SSE
                    │
@harness/host ◄─────┤  （从 HarnessApp.boot 抽出的装配层：
 （P0 新建包）        │    config / provider / 密钥 / 两级插件目录 /
                    │    权限 / 内置工具 L1+L2 / 会话恢复）
                    │
                    └─ A2A Server（SDK DefaultRequestHandler + AgentExecutor，Bun.serve 承载）
                          └─ AgentCard / SendMessage / SendStreamingMessage / GetTask / CancelTask
                                        │
                          createHarness + session.promptStream + bus（core 零改动）
```

三个宿主的差异只在**输入/输出适配器**与 **ask 实现**：

| 宿主 | 输入 | 流式输出 | ask 实现 |
|---|---|---|---|
| CLI（现状） | stdin/REPL | stdout/TUI | 终端询问 |
| A2A server | JSON-RPC HTTP | SSE | `TASK_STATE_INPUT_REQUIRED` + 挂起任务表（§3.4） |
| VSCode sidecar | stdio JSON-RPC / SSE | 消息桥 → webview | webview 授权卡 |

> **`@harness/host` 的依赖面要显式接受**：它会 import 内置插件与工具包（tools-builtin / tools-manager / manage-plugin / workspace-shell / revert / snapshot / subagent / swarm / coordinator …）以及 `core`/`plugin`/`workspace`/`permission`，因此必然成为新的"巨型组合根"。这是"一份装配、多个宿主"的代价；方案接受它，但要求 host **只做装配与注入**，不承载任何业务逻辑。
>
> **（2026-10-01 实测补充）** 依赖分两类，落法不同：
> 1. **静态 import 的包**（`@harness/plugin` / `@harness/workspace`）—— TS 侧可见，直接进 `dependencies`。
> 2. **`lazyImport(specifier)` 惰性引用的内置插件包**（22 个：provider-* / tools-* / 编排类 / memory 等）
>    —— specifier 是 `string`，**TS 看不见**，只在运行期由消费方的依赖树解析。这类依赖已显式写进
>    `packages/host/package.json` 的 `dependencies`，作用是**把隐式依赖显式化**：改内置插件清单时必须
>    同步改 `package.json`，否则运行时才炸；`bun build --compile` 打包时也按这份清单显式收入口
>    （`import(变量)` 无法被静态分析，不会自动进 bundle）。

---

## 6. 分期计划

| 阶段 | 内容 | 交付物 | 验收口径（预期行为，非执行步骤） |
|---|---|---|---|
| **P0.5（✅ 已完成 2026-10-01）** | ① SDK **无框架** server 入口 + `Bun.serve` 最小可跑（回一个 `SendMessage` + 一张 agent-card）；② `bun build --compile` 产出的二进制**能否加载用户目录的动态 TS 插件** | `spikes/a2a/` 两个可复现脚本 + 结论已回写本文档（§3.1.1 / §3.4 / §8） | ① **可行**：`JsonRpcTransportHandler.handle(body, ctx)` 纯 JSON-RPC 进出、**完全不接触 HTTP**，直挂 `Bun.serve`，无需任何框架 peer dep；13 项自检全绿（取卡 / 非流式 / SSE / GetTask / ListTasks / CancelTask / **`INPUT_REQUIRED` 挂起与续接** / 版本校验 / 异常转 FAILED）。② **可行**：`--compile` 二进制**内嵌转译器**，能运行期加载用户目录 `.ts`（不只是 `.js`/`.mjs`），61MB / 冷启动 18ms ⇒ **P3 sidecar 可走单文件二进制**。SDK 版本**钉死 `@a2a-js/sdk@1.3.0`**。**（P1-E 复核：结论在真客户端下成立 —— 官方 `a2a-tck` 全量打此 SUT 未出现"框架缺失/装配不可解析"类错误，`JsonRpcTransportHandler` 直挂 `Bun.serve` 的路径通）** |
| **P0**（✅ 已完成 2026-10-01：**分步搬迁 + 收尾 S1–S4 全部落地**） | 抽出 `@harness/host`：把 `HarnessApp.boot` 与装配符号迁出，CLI 改为消费它 | 新包 + CLI 行为不变（cli 侧保持 re-export） | CLI/TUI/headless 全部现有测试逐字通过；三种宿主的装配差异仅剩适配器。**第一步**：`loadPluginDirs` 簇（A 档）⇒ 2137 pass。**第二步**：内置注册表三节（C 档：Provider 类型工厂 / 内置通用插件 / 内置工具元信息，连同共用的 `lazyImport`）⇒ 2156 pass。**第三步**：配置归一化与窗口推导（B 档：`normalizeProviderConfigs` / `parseModelSpec` / `resolveContextWindowTokens` / `buildProviderWindowTable`，用 `ProviderWindowConfigSource` 窄类型避免拖走 `HarnessConfig`）⇒ **40 包 typecheck exit 0 / 全量 2172 pass**（2156 + host 新增 16，其余逐条不变）。**剩余**：仅 `HarnessApp` 本体（56 个成员 ≈ 1150 行）与它 20 处输出站点。**接口设计稿已出并定稿**：`docs/host-extraction-design.md`（含站点逐条分级表、三条接缝、落地顺序、3 个待定分叉；三处分叉按推荐选项落定：继承 / `renderNotice` 放 host / `asker` 四态，`Host.notices` 环形缓冲要）。**收尾四步已全部落地（2026-10-01）**：**S1** `packages/host/src/notice.ts`（判别联合 code + `NOTICE_LEVEL` 表 + `renderNotice` 逐字复刻 + `installConsoleCapture`，25 条用例）⇒ 全量 2197 pass；**S2-①** 配置层上移 `./config.ts` ⇒ 2197 pass；**S2-②**（原 S3，因 `boot()` 构造期即 `new CliPermissionEngine` 而前插）权限接缝 `./permission.ts` + `CliPermissionEngine` 退化为 asker 适配器 ⇒ 2210 pass；**S2-③ 前置** A/C 档自 `index.ts` 抽成 `./plugins.ts`（`index.ts` 688→125 行纯 barrel，消除 `host.ts → index.ts → host.ts` 环）⇒ 2210 pass 逐条不变；**S2-③** `./host.ts`：`HarnessHost` + `HostOptions` + `createHost()`，21 处 `stdout?.write?.(…)` → `emitNotice`，CLI 变 `HarnessApp extends HarnessHost`（只留 `stdout→onNotice` / `askPrompt→asker` 两个终端适配面）⇒ **40 包 typecheck exit 0 / 全量 2215 pass**（2210 + host notice 端到端 5 条）；**S2-③ 补** `preloadBuiltinToolMetas` 的 `console.warn` 漏网站点纳入 notice（+1 code，共 22）⇒ 2215 pass；**S4 测试收口**（能力归 host / 兼容归 cli：删 cli 侧 24 条重复行为用例、3 处 host 缺口移回、加一条 re-export 兼容断言）⇒ **40 包 typecheck exit 0 / 全量 2194 pass**（host 99 / cli 398）。**P0 收尾全部完成**。详见设计稿 §9（三处实测修正 / 四处有意偏离 / §9.5 收口） |
| **P1**（✅ 已完成 2026-10-01：**P1-A** 新包骨架 + AgentCard + 协议映射层、**P1-B** `HarnessAgentExecutor` + 挂起表 + 权限桥、**P1-C** HTTP/SSE 服务端宿主（认证 / 版本 / 并发 / 幂等 / 隔离）、**P1-D** `harness a2a` 子命令，四步全部落地；**P1-E 外部验收**亦已完成——官方 `a2a-tck`（v1.0.0）终轮 `5 failed / 74 passed / 186 skipped`，剩 5 条均为 TCK 参考 SUT 字面量断言、零真实缺陷遗留） | A2A 一期：AgentCard + SendMessage + SendStreamingMessage(SSE) + GetTask + CancelTask + Bearer + `A2A-Version` 校验 + `INPUT_REQUIRED` 权限（含 §3.4 挂起机制、§3.5 并发/幂等）；默认 127.0.0.1 | `@harness/a2a-server` 与 `harness a2a` 启动方式 | ✅ **外部验收已用官方 `a2a-tck` 跑通**（原口径）：取到 agent-card；发消息后收到 task→artifact/状态更新→`TASK_STATE_COMPLETED` 的事件序列；取消后转 `TASK_STATE_CANCELED`；权限点转 `TASK_STATE_INPUT_REQUIRED` 且答复后续接；同 session 并发请求被串行化或结构化拒绝；重复 `messageId` 不重复执行。**判读**：`overall 69.2% / must 70.4%`，`MUST PASS 57 / FAIL 2`（两条 FAIL = `DM-ART-001`/`DM-MSG-001`，均为 TCK 参考 SUT 字面量断言，非协议要求） |
| **P2**（🚧 进行中：设计稿 `docs/vscode-integration-design.md` 已出；**P2-A 控制通道已落地**；P2-B 扩展骨架待做） | VSCode Chat Participant（B2）：spawn sidecar（stdio）或连本地 A2A，转发流到 ResponseStream，含取消与权限弹窗 | VSIX 扩展（不发布 Marketplace） | 在 VSCode 中 `@harness` 提问可看到流式回答、工具进度、斜杠命令；终止按钮可中断；权限请求弹窗可决策。**P2-A 已交付**：`POST /harness/rpc` 控制面（14 个 `harness/*` 方法）+ 与协议面互不串线的守卫（`control.ts` / `control.test.ts`，a2a-server 70 → 104 用例）—— 这是扩展 `HarnessTransport.control()` 的前置，也顺手收掉了 plan §6 的"降级事实到不了调用方"（`harness/notice.list`）。**设计稿要点**：① 传输建议**复用 A2A HTTP+SSE**（两案都要 spawn，区别只在管道形态）+ 抽 `HarnessTransport` 接口；② **必须新增控制通道 `POST /harness/rpc`** —— A2A 协议里没有 `/compact` `/stats` `/agent` `/model` `/permission` `/skills` 等 12 条本地管理命令的位置；③ 权限四态用 `showInformationMessage({modal:true})` 四按钮，**不能**用 `lm.registerTool` 的确认弹窗（那是"Copilot 调你的工具"，harness 自主 loop 走不到那条链路）；④ 权限 asker 跨进程建议复用 A2A 的 `INPUT_REQUIRED` 挂起（零新增协议） |
| **P3** | VSCode Webview（B3）：平移块模型与侧栏（会话/后台任务/文件引用/统计）；sidecar 分发（`--compile` 或随扩展带 bun，取决于 P0.5 结论） | VSIX 完整版 | 终端 TUI 的核心信息结构在 IDE 内等价呈现 |
| **旁路** | B1 MCP server（**需自建 server 端**，见 §4.1），做成插件 | 插件包 + MCP server 配置 | 支持 MCP 的 IDE 客户端能列出并调用 harness 工具，写操作触发权限 |

依赖顺序：**P0.5 已出结论，P1/P3 的前置条件已解除**（协议口径与分发路径都定了）；**P0 是 P1/P2/P3 的共同前置**；P1 的 server 可直接充当 P2 的 sidecar 传输层；旁路 B1 与主线并行、互不阻塞。

**P0 的 `createHost` 接口设计 → 见 `docs/host-extraction-design.md`（2026-10-01 定稿；S1 / S2-①②③ / S2-③补 / S4 均已落地）**。
**P2 的 VSCode 接入设计 → 见 `docs/vscode-integration-design.md`（2026-10-01 设计稿；传输两案对比、控制通道、权限/取消接缝、目录结构，§10 列出 7 项待拍板）**。
**`createHost` 现在可直接用**：`import { createHost, type Host } from '@harness/host'` → `const host = await createHost({ agentId, provider, … })`，一步完成装配 + 启动；CLI 仍保留 `new HarnessApp()` + `boot()` 两步以兼容既有 30+ 调用点。

**P1 进度（2026-10-01）**：
- **P1-A ✅**：新包 `packages/a2a-server`（宿主/适配器层）+ 三个纯函数模块 —— `mapping.ts`（Part/Message/State 双向、四态权限词汇表、`StreamAdapter` 事件合并）、`card.ts`（`buildAgentCard` + `cardToJSON`)、`errors.ts`；`index.ts` barrier；root `tsconfig.json` paths / root+cli `package.json` 依赖 / `bun install` 均已登记。40 包 typecheck exit 0 / 全量 2227 pass。
- **P1-B ✅**：`executor.ts`（`HarnessAgentExecutor`：`promptStream` → A2A 任务生命周期，`AsyncLocalStorage` 权限桥，取消/超时/异常归一，`activeTaskFor` 并发自检）+ `suspend.ts`（`taskId → resolver` 挂起表 + TTL + `onSuspend`/`onExpire`）+ `executor.test.ts`（12 条真实装配用例）。全量 2239 pass / 0 fail / 98 文件。
- **P1-C ✅**：`server.ts`（`JsonRpcTransportHandler` 挂 `Bun.serve` + 卡路由 + SSE + `validateVersion` + 并发拒绝 + `messageId` 幂等回放 + `contextId` 归属隔离，默认仅监听 `127.0.0.1`）+ `auth.ts`（`verifyBearer` / `CallerRegistry`）+ `server.test.ts`（18 条，真起 HTTP）。全量 2257 pass / 0 fail / 99 文件。
- **P1-D ✅**：`harness a2a [--port <n>] [--token <t>]`（`parseCliArgs` + `main` 分派 `runA2aCli`，复用 `createHost`）。全量 2258 pass / 0 fail / 99 文件。
- **P1-E ✅（外部验收）**：用官方 `a2a-tck`（A2A **v1.0.0** 规格）对 `harness a2a` 真 SUT 全量打 —— 五轮收敛后终轮 **`5 failed / 74 passed / 186 skipped`**，`overall 69.2% / must 70.4% / should 42.9% / may 100.0%`；逐条 `MUST PASS 57 / FAIL 2 / SKIPPED 33 / NOT TESTED 22`。**剩余 5 条 FAIL 全是 TCK 的"参考 SUT 字面量"断言（`DM-ART-001` 固定 artifact 文本/文件、`DM-MSG-001` 强制 `SendMessage` 返回 `Message` 而协议允许返回 `Task`），非协议要求 ⇒ 零真实缺陷遗留。** 外部验收暴露并修掉 **5 处只有真客户端才触发的互操作缺陷**（尾斜杠路径等价类、幂等回放的 `{task}` 信封、SDK 惰性流"预热首值"、终态/`contextId` 不匹配必须报错、卡片缓存头与 `304`）；每处均做反向验证。详见 `docs/development-log.md`（续 238）。
- **剩余**：无（P1 四步 + 外部验收全部落地）。`a2a-inspector` 是浏览器 UI（无头环境未跑），其能力面已由 TCK 的 agent-card 用例组 + 取卡冒烟等价覆盖。

> **P1 的三处实测教训（写进这里免得踩第二次）**：
> 1. **权限询问不是"工具一执行就自动弹"** —— `ToolPipeline.execute` 仅在**工具声明了 `permission: { key, extractPatterns }` 且有 `checkPermission`** 时才构造 `PermissionRequest` 去问引擎（`packages/tool/src/index.ts:1330`）。测试夹具里不声明 `permission` 的工具 ⇒ 整条 `check → ask → asker → 挂起` 链路不启动，`INPUT_REQUIRED` 用例会**静默退化成"任务直接 COMPLETED"**。另：`SUBMITTED` 挂在 `task` 事件**本体**（`data.status.state`）上，不是独立 `statusUpdate`。
> 2. **权限桥必须接线 + 续接请求会误杀共享 bus** —— 宿主 boot 在 executor 之前 ⇒ 必须在 `createA2aServer` 里 `host.permission.setAsker(executor.asker)`；续接请求的 executor 不发事件，SDK 会据此**立刻结束共享事件总线**（第一轮仍在跑、稍后要补发终态），故需自定义 `EventBusManager.settleByTaskId` 按"任务还在跑"接管。两处均已做反向验证（摘掉分别失败 5 条 / 3 条）。
> 3. **外部验收（TCK）捞到的 5 处只有真客户端才暴露的互操作缺陷** —— ① **路径等价类**：客户端（httpx）会把 `base_url` 规范成带尾斜杠 ⇒ 服务端必须容忍 `/a2a/`；② **出参信封**：同一个 `Task`，`GetTask` 出裸体、`SendMessage`/`SendStreamingMessage` 出 `{task}` 信封，不能"顺手复用"；③ **SDK 流是惰性的**：非法任务/参数要到第一次 `next()` 才抛 ⇒ 必须先"预热首值"，预流错误回**普通 JSON-RPC error**、只在已提交 SSE 后的中途错误才写 `event: error` 帧；④ **带 `taskId` 的守卫要按真实状态判定**：给终态任务发消息（`-32004`）、`taskId`/`contextId` 不匹配（`-32602`）都是 MUST 报错，静态回放会把它们**掩盖成成功**；⑤ 卡片端点要补 `Cache-Control`/`ETag`/`Last-Modified` + `304`。**共同规律：本仓自测是"按我们理解调我们"，外部验收是"按别人的实现调我们"——两者交集之外的坑只能靠后者捞。**

该文档已按实测重写本节原草稿，两处修正值得记在这里：

- ❌ 原草稿的 `agentDirs?` / `plugins?` **不是 boot 的入参**：`plugins` 来自 `config.json`（boot 内
  `resolveBuiltinPlugins(cfg.plugins)`），`agentDirs`/`skillDirs` 由 `workspace` 派生出 user/project 两级。
  写成入参等于给出第二条口径。
- ❌ 原草稿的 `permissionAsk?` / `logSink?` 两个名词都不准确：真正的接缝是
  `asker(req, prompt) → 四态`（不是文本往返）与 `onNotice(notice: HostNotice)`（三级结构化，与既有
  `setLogSink` 是**两条**通道，不合并）。`askPrompt` / `stdout` 留在 CLI 侧 —— host 不认识 readline 与直写流。

**P0 的搬迁清单（定义在 `packages/cli/src/index.ts`，不在 core）**：`BuiltinPluginRegistry` / `getBuiltinRegistry` / `resolveBuiltinPlugins` / `preloadBuiltinToolMetas` / `loadPluginDirs` / `buildProviderWindowTable`。搬走后 `@harness/cli` 必须继续 re-export 这些符号（`cli.test.ts` 直接 import），否则等于制造一次无谓的测试翻修。

> ⚠️ **实测修正（2026-10-01）：这 6 个符号不能一次搬完 —— 它们的依赖闭包差三档**，"先建包再逐个迁"比"一次搬完整套"风险低得多：
>
> | 档 | 符号 | 闭包 | 处置 |
> |---|---|---|---|
> | **A** | `loadPluginDirs` + `PluginLoadResult` + `probeAgentPlugin` + `collectAgentPlugins` + `registerProviderTypeFactory` | **自足**：只依赖 `@harness/plugin` 的类型与 `@harness/workspace` 的 `MultiDirLoader`/`normalizeDirs`（`normalizeDirs` 在 cli 内只此一处用）。且是 A2A 宿主**必需**的能力（要能加载用户插件） | ✅ **已完成** —— 第一步就搬它 |
> | **B** | `buildProviderWindowTable` | 连着 cli 的 config 解析层（`normalizeProviderConfigs` / `resolveContextWindowTokens` / `HarnessConfig`），这些在 cli 别处大量复用 ⇒ 单搬它会拖出整层 | 第二步，与 config 层一起上移 |
> | **C** | `BuiltinPluginRegistry` / `getBuiltinRegistry` / `resolveBuiltinPlugins` / `preloadBuiltinToolMetas` | 连着 `lazyImport`（cli 内 **27 处**使用）与 `BuiltinToolRegistry`（**8 处**）；`preloadBuiltinToolMetas` 还连带 `BuiltinToolRegistry` + `getBuiltinToolRegistry`（这两个不在原清单里，是闭包带出来的） | 第二步，与 `lazyImport` 启动基建一起上移 |
>
> 另注：`lazyImport` 是 cli 的启动基建（27 处），**它才是 P0 真正的搬迁重心**，不是那 6 个符号。
>
> **第一步的机制验证点**：`cli.test.ts` 有 9 条 `loadPluginDirs` 用例直接 `import` 这些符号 —— 搬走后它们必须**逐字通过**（实测 429 pass / 0 fail），这就是"re-export 兼容"这条约定的验收口径。host 包另建同能力用例（`load-plugin-dirs.test.ts`，11 条）按"能力归属"覆盖实现；两处的重叠是**有意的**。**✅ 已在 P0 收尾 S4 统一收口**：按「能力归 host、兼容归 cli」删掉 cli 侧重复的行为用例（`loadPluginDirs` 9 条 + 内置注册表 6 条 + 窗口 2 条 + 权限 3 条 + `provider-model.test.ts` 8 条），替换为一条 re-export 兼容断言（逐个断言上移符号 `===` host 的那一个）；并把 3 处**只有 cli 覆盖**的 host 能力用例（`resolveCompactionWindow` / `buildCompactionOptions` / `loadPluginDirs` 相对路径）移回 host。全量由 2215 → **2194 pass**（host 99 / cli 398），零覆盖损失。详见 `docs/host-extraction-design.md` §9.5。

**P0 的 stdout 分级要求**：装配期共 **20 处** `stdout?.write`（boot 内 16 + 后台预加载 4）混着三类语义 —— ① 用户可见诊断（如"未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock Provider"）② 告警 ③ verbose 日志。抽 host 时必须先分级：A2A 宿主若把 ① 也塞进日志通道，远程调用方会**静默拿到 mock 回答**。① 应升格为**可观测事件**（P1 落进任务 metadata / 服务日志 / 启动自检输出），并在 host 侧保留环形缓冲供事后回读（今天不传 `stdout` 这 20 条**全部静默丢弃**）。逐条分级表与文案复刻方案见 `docs/host-extraction-design.md` §2.5。**现状参考**：20 处里只有 1 处被测试钉住（`cli.test.ts:1939`），其余 19 处既无断言也不进任何结构化通道。

---

## 7. 共性难点与对策

1. **权限 ask 远程化**：新增 `RemotePermissionEngine`（实现 `PermissionEngine`，与 `CliPermissionEngine` 一样只覆盖 `ask`），ask 向 UI 发请求并 await 决策。**真正的难点不是换实现，而是 §3.4 的挂起/唤醒机制**——两种宿主只是它的两个壳（A2A=`INPUT_REQUIRED`，VSCode=授权卡）。check→ask 两步、`ToolPermissionDeniedError` 判定、规则持久化全部沿用，不改语义。
2. **会话/任务映射**：`contextId=sessionId`、`taskId=请求 id`；**续接按 taskId**；`ListTasks` 走 task 索引而非 session（§3.5）。
3. **长等待心跳**：`step_gate` 一个事件两种壳——A2A 转 WORKING 状态更新，VSCode 转 progress；不在各壳另做超时猜测（预算语义已在引擎内：超预算继续等待但标 `overBudget`）。
4. **日志通道**：`HarnessApp` 已有的 `setLogSink` / `emitLog` **模式**（注意：它在 CLI 宿主层，**不在 core**）随 P0 上移到 `@harness/host`；另新增装配期的 `onNotice`（三级结构化）。**两条通道不合并**——时机（装配期一次性 vs 运行期每轮）、内容（结构化 code vs 自由文本）、挂载方式（构造期 option vs 运行期 setter）都不同，合并要改一个已被 `cli.test.ts:3185` 钉住的契约。见 `docs/host-extraction-design.md` §2.5。A2A server 把 warn/error 收进任务 metadata/服务日志，绝不直写共享 stdout；VSCode 侧经消息桥进 webview console 块。
5. **后台任务可见性**：外部 UI 统一订阅 bus（`SubagentEvents.*`、单任务完成与 barrier 两条事件不合并），不新建轮询通道。
6. **版本兼容**：AgentCard 的 `supportedInterfaces[].protocolVersion` 声明协议版本（顶层 `version` 是 agent 自身版本，**不要**写成 `protocol_version`）；每个请求校验 `A2A-Version` 头。host 装配层接口稳定后，CLI/server/扩展各自独立发版。

---

## 8. 风险与取舍

| 风险/取舍 | 说明 | 对策 |
|---|---|---|
| ~~`bun build --compile` 与动态插件目录冲突~~（**P0.5 已证伪**） | 原担心 `--compile` 对运行期发现的动态导入与 TS 转译支持有限，产不出"仍能加载用户 TS 插件"的单文件二进制 | **实测可行**：单文件二进制**内嵌转译器**，`.ts`/`.js`/`.mjs` 都能运行期 `import()`；插件的裸依赖按**插件文件所在目录向上**解析（与未编译时一致 —— 不是 `--compile` 引入的新限制）；绝对路径、相对 `.ts` 导入、`node:` 内置模块全部正常；**61MB / 冷启动 18ms** ⇒ **P3 sidecar 走 `--compile`**，"随扩展带 bun"降级为备选。**遗留的是既有问题、与 `--compile` 无关**：用户插件目录（如 `~/.harness/plugins/`）解析不到 `@harness/plugin` 这类裸依赖 —— `loadPluginDirs` 现有提示文案已覆盖 |
| **SDK 自己写 `console`** | `DefaultRequestHandler` 在 executor 抛异常时会 `console.error` 打印**完整堆栈**（实测 "Agent execution failed for message …"） | 宿主日志出口必须能接管 stdout/stderr（P0 的 `logSink` 分级要求因此**比预想更强**：不只 harness 自己的 16 处 `stdout.write`，还要罩住 SDK 的 console）。对外响应仍只给结构化 code + message，不泄露堆栈（§3.3） |
| A2A v0.3→v1.0 breaking + 网上示例过时 | 方法名/枚举/Part 结构都改过；原稿 §3.1 即照抄 v0.3 示例 | 口径**一律取自 SDK 常量**；开工前钉死 SDK 版本；映射表集中一处维护；验收用官方 `a2a-inspector` / `a2a-tck`。**✅ 已执行（P1-E）**：TCK 外部验收确实捞出了 5 处本仓自测覆盖不到的互操作缺陷（尾斜杠路径、回放信封、惰性流预热、终态/`contextId` 判定、卡片缓存头）—— 证明"外部验收"这一步不是走过场 |
| SDK 成熟度 | JS SDK 1.0 GA 于 2026-07-22（距今约两个月），仍在快速迭代 | 钉版本 + 协议壳严格隔离 + 优先用 SDK 类型；升级按 minor 走回归 |
| sidecar 分发体积/启动延迟 | `--compile` 二进制数十 MB，冷启动有成本 | 扩展激活时懒启动、单实例复用；v2 评估进程内化（Node 兼容成本已确认很低：仅 3 处 `Bun.*`） |
| A2A 与现有 MCP 能力边界被混淆 | 一个是自治 Agent、一个是工具集；且现有 MCP 基建**只是 client** | 文档与配置中明确两个开关；默认都只监听本机；B1 单独标注"需自建 server 端" |
| 远程化放大权限风险 | 网络可达意味着写工具可能被远程触发 | 默认 127.0.0.1 + 强制认证 + 权限引擎不旁路 + deny-all 缺省 + **contextId 绑定调用方**（§3.5） |
| 挂起任务泄漏 | `INPUT_REQUIRED` 的活生成器若无人答复会常驻内存 | 挂起表带 TTL + 超时转 `TASK_STATE_FAILED` 并释放（§3.4） |
| 双端漂移（server 与 CLI 行为不一致） | 两份装配必然分叉 | P0 强制收口到 `@harness/host`；协议层禁止内嵌业务规则 |
| host 变成"巨型组合根" | 依赖 ≈10 个插件包 | 接受之（"一份装配"的代价），但要求 host 只做装配与注入、依赖清单写进 README |
| VSCode Chat API 依赖 Copilot Chat | 未装 Copilot Chat 的环境不可用 | B2 为 v1、B3 webview 为终态兜底；sidecar+webview 不依赖 Copilot |
| 新包登记遗漏 | AGENTS.md 要求新包同步登记 root `tsconfig.json` paths + 相关 `package.json` dependencies + `bun install` | P0/P1 的完成定义里加这一条 |

---

## 9. 明确不做（本期范围外）

- gRPC / HTTP-REST binding、push notification webhook、extended agent card、多租户/mTLS/OAuth。
- A2A agent 间双向互调（harness 作为 A2A **客户端**去调别的 agent）——本方案只做服务端；客户端能力未来经 mcp-client 同构的插件补。
- Marketplace 发布、自动更新、多 workspace 并发 sidecar 池化（P3 之后）。
- 把 OpenTUI 终端 UI 跨平台到浏览器——webview 是 React 重写，不做终端仿真。

---

## 10. 待确认决策

1. 传输优先级：VSCode v1 是 **stdio sidecar**（最简）还是**直接复用 A2A 本地 HTTP+SSE**（少一种协议，但要管端口）？建议 stdio 先行，P1 完成后再切 SSE。
   *更新（2026-10-01，P1 已收口）*：**建议改为直接复用 A2A HTTP+SSE**。原建议写于 P1 之前，当时"stdio 先行"能省一套协议；现在 P1 已完工并过了官方 TCK 外部验收，走 stdio 等于让那笔投入对 P2 归零，且 stdio 宿主要把并发/幂等/隔离**再做一遍并再验收一遍**。关键事实：**两案都要 spawn 子进程**（harness 是 Bun、extension host 是 Node），差别只在管道形态。详见 `docs/vscode-integration-design.md` §2。**仍待拍板**。
2. A2A 服务是否随 CLI 发布为子命令（`harness a2a --port`），还是独立可执行包？建议前者（复用 host 装配与配置）。
3. subagent 类 agent 是否对外暴露为独立 AgentCard？建议默认不暴露、配置开启。
4. VSCode 扩展代码放主 monorepo（`adapters/`）还是独立仓库？建议独立仓库，避免 `@types/vscode` 与 webview 构建链污染主包。
   *更新（2026-10-01）*：**同意"隔离"的目标，但建议折中为「仓内 `adapters/vscode/`，但不加入 `workspaces`、不进 root `tsconfig.include`」** —— 同样隔离了 `@types/vscode`/vsce/webview 构建链，但改 A2A 端点的契约漂移能在**同一个提交**里被发现，不必跨仓两次提交。需配一条守卫测试防它被 root typecheck 收进去。详见 `docs/vscode-integration-design.md` §3.2。**仍待拍板**。
5. **挂起任务的 TTL 与超时行为**：超时后是 `TASK_STATE_FAILED` 还是自动取消？建议默认 `FAILED` 并保留已完成部分，可配。
   *补充（P0.5 后）*：spike 走的是模式 A —— executor 在 `INPUT_REQUIRED` 处 `await` 不返回（§3.4），
   因此 **TTL 不是"锦上添花"而是必需项**：没有 TTL 时 executor 的 Promise 会永久悬挂，
   挂起表与 task 记录一起泄漏。TTL 到点必须主动 `resolve`（或 reject）并释放挂起表条目。
6. **并发策略**：同 session 并发请求是**排队**还是**直接拒绝**？建议一期直接拒绝（语义简单、无隐藏积压），二期再评估排队。
