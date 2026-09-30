# 对外接入方案：A2A 协议 与 VSCode UI

> 状态：**方案待评审**（仅设计，未实现）
> 日期：2026-09-30
> 范围：让 agent-harness（下称 harness）① 作为 A2A 服务被其他 Agent/系统调用；② 以 VSCode 作为人机 UI。

---

## 1. 背景与目标

harness 当前的人机界面是 CLI/REPL/TUI（OpenTUI 终端），对外只有 `harness run` 一次性 headless 调用。两类新诉求：

1. **A2A（机器对机器）**：harness 被 agent 生态发现与调用——其他框架/厂商的 Agent 能通过标准协议发起任务、拿流式结果、取消、续接会话。
2. **VSCode（人）**：用户不离开编辑器即可使用 harness，并逐步把 TUI 的多块渲染、会话/任务/统计侧栏搬进 IDE。

设计目标：

- **core 零改动**：协议与 UI 都是"宿主"，全部能力经现有公共 API + 插件机制接入，符合项目插件化硬约束。
- **一份装配、多个宿主**：CLI / A2A server / VSCode sidecar 共用同一套 harness 装配逻辑，不允许各壳复制一份再分叉。
- **不发明私有协议**：机器侧直接采用 A2A v1.0（Linux Foundation）；IDE 侧优先利用 VSCode 原生 Chat API，终态才上自研 webview。

---

## 2. 现状盘点：已具备的接入面

| 能力 | 现状 | 接入意义 |
|---|---|---|
| 统一入口 | `createHarness(options): Promise<Harness>`（`packages/core`） | 任意宿主可直接装配，无需 CLI |
| 流式会话 | `session.promptStream(sessionId, text, maxSteps?, signal?) → AsyncGenerator<AgentStreamEvent>` | A2A SSE / VSCode 流的同一数据源 |
| 事件完备性 | `text_delta` / `reasoning_delta` / `tool_call_start` / `tool_call_result` / `done`（每步）/ `turn_end`（整轮终态）/ `step_gate`（等待心跳，含 `overBudget`） | 协议映射所需语义齐全，无需引擎补事件 |
| 会话持久化 | `create/get/list/search`，会话与消息落盘在 dataDir，跨进程可恢复 | A2A `contextId` 天然映射 sessionId；断线重连/历史查询零额外存储 |
| 权限接口 | `PermissionEngine.ask(req)` 为异步可插拔接口，无交互器时默认 deny | 远程 UI 实现一个 ask 回问前端即可，check→ask 两步语义不变 |
| 事件总线 | `AgentEvents.stepGate`、`SubagentEvents.*`、`LifecycleEvents.*`、barrier | 外部 UI 订阅 bus 即可呈现后台任务面板/终态 |
| headless | `harness run "prompt"`（stdout 纯结果，用量走 stderr） | 最粗粒度的零开发远程调用方式 |
| MCP 基建 | `mcp-server-registry` + `mcp-client`（stdio/SSE transport、OAuth） | harness 当 MCP server 被 IDE 调用的现成地基 |

**两个需要正视的现状：**

1. **装配逻辑集中在 CLI**：config.json 读取、provider 归一化与密钥解析（`SecretCipher`，明文/`${ENV}`/`enc:v1:`）、两级插件目录加载（user `~/.harness` + project `.harness`）、`CliPermissionEngine`、内置工具 L1 元信息+L2 惰性加载，目前都在 CLI 的 `HarnessApp.boot()` 中，约数百行，与 stdout/REPL 有少量缠绕。这是三个宿主共同的复用前提，必须先抽出（见 §6 P0）。
2. **运行时是 Bun**：各包直接导出 TS 源码（`exports → ./src/index.ts`，无 dist），由 Bun 消费。非测试源码中仅 `@harness/snapshot` 的 git 调用使用 `Bun.spawn`，其余均为 `node:*` API。这决定 VSCode 侧 v1 应走 sidecar 子进程而非进程内嵌入 Node host（见 §5）。

---

## 3. 方案 A：A2A Server

### 3.1 协议选型（外部事实）

A2A 当前 **v1.0，已捐赠 Linux Foundation**。TS 侧有官方 `@a2a-js/sdk`。

- 绑定：JSON-RPC 2.0 over HTTP；流式为 SSE；另有 gRPC / HTTP-REST binding（本期不选）。
- 发现：`/.well-known/agent-card.json` 返回 **AgentCard**（身份、能力、skills、输入输出 MIME、认证方案）。
- 核心对象：
  - **Task**：`id` + `contextId` + `status` + `artifacts` + `history` + `metadata`。
  - **TaskState**：`SUBMITTED / WORKING / COMPLETED / FAILED / CANCELED / REJECTED`（终态）与 `INPUT_REQUIRED / AUTH_REQUIRED`（中断态）。
  - **Message / Part**：role=USER/AGENT，Part 为 text/raw/url/data；**Artifact** 为任务产出（一个或多个 Part）。
- 方法：

| 方法 | 说明 | 本期 |
|---|---|---|
| `message/send` | 发起/续接任务（非流式） | ✅ 一期 |
| `message/stream` | 发起任务，SSE 实时更新 | ✅ 一期 |
| `tasks/get` | 取任务当前状态 | ✅ 一期 |
| `tasks/{id}:cancel` | 取消任务 | ✅ 一期 |
| `tasks/list` | 过滤分页列出 | ⏳ 二期（映射 session.list） |
| `tasks/{id}:subscribe` | 订阅既有任务的 SSE 更新（断线重连） | ⏳ 二期（文件持久化天然支持） |
| push notification / extended card / 多租户 | webhook、认证后详细卡片、mTLS | ❌ 附录 |

### 3.2 架构

新增包 `packages/a2a-server`（核心宿主类，非业务插件；仅负责协议壳与映射）：

```
A2A Client（其他 Agent）
   │  HTTP JSON-RPC + SSE（Bearer 认证）
   ▼
A2A 协议壳（Bun.serve + @a2a-js/sdk，薄层）
   ├─ AgentCard 生成器   ← harness.agent 注册表（AgentDefinition → skills）
   ├─ 消息映射层          A2A Message/Part ↔ harness Message
   ├─ 事件映射层          AgentStreamEvent → SSE StreamEvent
   ├─ 任务表（进程内）    taskId → { sessionId(contextId), AbortController }
   ├─ 权限回问通道        engine.ask() → TaskState.INPUT_REQUIRED
   └─ 取消桥              tasks/:cancel → AbortController.abort()
   ▼
@harness/host（§6 P0 抽出的装配层）→ createHarness
```

定位约束：协议壳**只做翻译**，不内置任何业务决策、不绕过权限、不直接调工具。

### 3.3 事件映射（最小语义映射）

原则：**逐条转发 + 结束事件归一为终态**，不在中间层引入聚合状态机。

| harness 侧 | A2A 侧 |
|---|---|
| 请求带 `contextId` 且会话存在 | `session.get(contextId)` 恢复；否则 `session.create()`（contextId 取新 sessionId） |
| 收到请求 | Task `SUBMITTED` → `WORKING` |
| `text_delta` | artifact 追加更新；整轮结束后输出最终文本 Artifact |
| `reasoning_delta` | `status-update(WORKING, final=false)`，内容放 message 摘要或 metadata |
| `tool_call_start/result` | `status-update(WORKING)` + metadata（工具名/入参摘要/成败），不作为 Artifact 正文 |
| `step_gate`（含 overBudget） | `status-update(WORKING)` 心跳；超预算时在 message 注明"等待异常偏久" |
| `turn_end`（正常） | `status-update(final=true, state=COMPLETED)` + 最终 Artifact |
| `turn_end.aborted` | `CANCELED` |
| 异常 / DOOM_LOOP / 权限硬拒 | `FAILED`（结构化 code + message，不泄露堆栈） |
| 权限 `ask()` | **`INPUT_REQUIRED`**：A2A 原生中断态；客户端答复后以同一 contextId 续接 |
| `tasks/:cancel` | `AbortController.abort()`（harness 在步边界/工具前生效，保留已完成部分） |

### 3.4 关键设计点

- **会话与任务两个 id 不混用**：`contextId = sessionId`（多轮归属），`taskId = 单次请求 id`（取消/查询单元）。进程内 Map 维护映射；任务结束后保留摘要供 `tasks/get`，历史落盘靠会话文件。
- **流式与非流式同源**：`message/send` 内部消费同一个 AsyncGenerator，只是聚合到终态后一次性返回，避免两条执行路径行为分叉。
- **认证**：一期单一 Bearer token / API key（AgentCard 声明 `securitySchemes`，支持 `${ENV_VAR}` 引用）；不做 OAuth/mTLS。
- **安全默认**：服务默认仅监听 `127.0.0.1`；暴露到网络需显式配置并同时要求认证。工具写操作仍全部经过 harness 权限引擎，协议层不加旁路。
- **AgentCard.skills 映射**：由 `AgentDefinition`（id/name/description/mode）生成；`mode: 'subagent'` 的 agent 是否暴露为独立 card 由配置开关决定（默认只暴露 primary）。
- **与 MCP 的分工**：A2A 暴露的是"自治 Agent（带会话与任务生命周期）"；MCP 暴露的是"工具集"。同一 harness 可同时开两种服务，不互相替代。

---

## 4. 方案 B：VSCode 接入

三条路径，投入与体验不同，按阶段采用而非三选一。

### 4.1 B1：MCP Server（最轻，旁路快速交付）

把 harness 的工具经 `mcp-server-registry` 暴露为 MCP server（stdio），VSCode 侧由已支持 MCP 的聊天客户端（Copilot Chat / Continue / Cline 等）挂载。

- 优点：**零自研 UI**，工具调用、确认、流式输出全部复用客户端；约一周级交付。
- 局限：MCP 是"工具集"语义，无法呈现 harness 的自主多步 loop、多 agent roster、子 agent 面板、会话压缩与统计；体验完全受客户端约束。
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

Extension host（Node）+ React webview（Vite）+ 类型化双向消息桥。这是同类自主编程 Agent 插件（如 Opico Agent）已验证的架构：host 侧跑 agent 调度/工具/权限，webview 渲染 reasoning 折叠块、工具块、diff 预览、会话与任务侧栏。

- 优点：UI 完全自主；现有 TUI 的 ChatBlock 块模型、选区、侧栏纯函数（`applyStreamEvent` / `pushConsole` / `computeTuiStats` 等）可直接平移为 web 组件与 reducer。
- 难点：**harness 是 Bun 运行时，VSCode extension host 是 Node**（见下表）。

| 集成方式 | sidecar：spawn bun 进程（推荐 v1） | 进程内嵌入 Node host |
|---|---|---|
| 运行时适配 | **零适配**，harness 原样运行 | 需 esbuild bundle 全部 TS 源码；`@harness/snapshot` 的 `Bun.spawn` 改为 `node:child_process`（仅此一处），其余天然 Node 兼容 |
| 生命周期 | 扩展负责子进程启停、端口/stdio 协商 | 与扩展同生命周期，调试简单 |
| 传输 | stdio JSON-RPC（最简）或本地 HTTP+SSE（复用 A2A） | 函数调用 + bus 订阅（仍需消息桥到 webview） |
| 分发 | 用 `bun build --compile` 产出单文件二进制随扩展分发，免去用户安装 bun | 纯 npm 扩展，无外部依赖 |
| 结论 | **v1 采用** | v2 收敛目标 |

### 4.4 VSCode 侧的权限与取消

- **权限**：host 收到 harness 的 ask 请求 → webview 授权卡（允许一次/本会话始终允许/拒绝）→ 回传决策；映射进 `CliPermissionEngine` 已有的规则持久化模型（permissions.json）。
- **取消**：webview "■ 终止" → extension 调取消 → sidecar abort（stdio 发 cancel / HTTP 调 tasks:cancel）→ harness 在步边界生效，保留已完成部分。
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
 （P0 新建核心包）    │    config / provider / 密钥 / 两级插件目录 /
                    │    权限 / 内置工具 L1+L2 / 会话恢复）
                    │
                    └─ A2A Server（Bun.serve + @a2a-js/sdk）
                          └─ AgentCard / message:send / message:stream(SSE) / tasks:cancel
                                        │
                          createHarness + session.promptStream + bus（core 零改动）
```

三个宿主的差异只在**输入/输出适配器**与 **ask 实现**：

| 宿主 | 输入 | 流式输出 | ask 实现 |
|---|---|---|---|
| CLI（现状） | stdin/REPL | stdout/TUI | 终端询问 |
| A2A server | JSON-RPC HTTP | SSE | INPUT_REQUIRED 状态回问 |
| VSCode sidecar | stdio JSON-RPC / SSE | 消息桥 → webview | webview 授权卡 |

---

## 6. 分期计划

| 阶段 | 内容 | 交付物 | 验收口径（预期行为，非执行步骤） |
|---|---|---|---|
| **P0** | 抽出 `@harness/host`：把 `HarnessApp.boot` 中与 stdout 无关的装配参数化为 `createHost({ cwd, dataDir, permissionAsk?, logSink? })`；CLI 改为消费它 | 新包 + CLI 行为不变 | CLI/TUI/headless 全部现有测试逐字通过；三种宿主的装配差异仅剩适配器 |
| **P1** | A2A 一期：AgentCard + send + stream(SSE) + get + cancel + Bearer + INPUT_REQUIRED 权限；默认 127.0.0.1 | `@harness/a2a-server` 与 `harness a2a` 启动方式 | 任意标准 A2A 客户端可：取到 agent-card；发消息后收到 task→artifact/状态更新→final COMPLETED 的事件序列；取消后任务转 CANCELED；权限点转 INPUT_REQUIRED 且答复后续接 |
| **P2** | VSCode Chat Participant（B2）：spawn sidecar（stdio）或连本地 A2A，转发流到 ResponseStream，含取消与权限弹窗 | VSIX 扩展（不发布 Marketplace） | 在 VSCode 中 `@harness` 提问可看到流式回答、工具进度、斜杠命令；终止按钮可中断；权限请求弹窗可决策 |
| **P3** | VSCode Webview（B3）：平移块模型与侧栏（会话/后台任务/文件引用/统计）；sidecar 用 `--compile` 二进制分发 | VSIX 完整版 | 终端 TUI 的核心信息结构在 IDE 内等价呈现；无需用户自行安装 bun |
| **旁路** | B1 MCP server 暴露核心工具（若要优先满足"Copilot 无 UI 调用"） | MCP server 配置 | 支持 MCP 的 IDE 客户端能列出并调用 harness 工具，写操作触发权限 |

依赖顺序：**P0 是 P1/P2/P3 的共同前置**；P1 的 server 可直接充当 P2 的 sidecar 传输层；旁路 B1 与主线并行、互不阻塞。

---

## 7. 共性难点与对策

1. **权限 ask 远程化**：新增 `RemotePermissionEngine`（或对 host 注入 `permissionAsk` 回调），ask 向 UI 发请求并 await 决策；两种宿主各自落地交互（A2A=INPUT_REQUIRED，VSCode=授权卡）。check→ask 两步、`ToolPermissionDeniedError` 判定、规则持久化全部沿用，不改语义。
2. **会话/任务映射**：contextId=sessionId、taskId=请求 id（Map → AbortController）；VSCode 侧直接消费会话列表 API。
3. **长等待心跳**：`step_gate` 一个事件两种壳——A2A 转 WORKING 状态更新，VSCode 转 progress；不在各壳另做超时猜测（预算语义已在引擎内：超预算继续等待但标 `overBudget`）。
4. **日志通道**：复用已落地的 `setLogSink` 机制——A2A server 把 warn/error 收进任务 metadata/服务日志，绝不直写共享 stdout；VSCode 侧经消息桥进 webview console 块。
5. **后台任务可见性**：外部 UI 统一订阅 bus（`SubagentEvents.*`、单任务完成与 barrier 两条事件不合并），不新建轮询通道。
6. **版本兼容**：AgentCard 声明 `protocol_version`；host 装配层接口稳定后，CLI/server/扩展各自独立发版。

---

## 8. 风险与取舍

| 风险/取舍 | 说明 | 对策 |
|---|---|---|
| A2A 规范仍在演进（v0.x→v1.0 有 breaking 调整） | 字段与 binding 可能再变 | 协议壳严格隔离；优先用官方 SDK 的类型；映射表集中一处维护 |
| sidecar 分发体积/启动延迟 | `--compile` 二进制数十 MB，冷启动有成本 | 扩展激活时懒启动、单实例复用；v2 评估进程内化（Node 兼容成本已确认很低：仅 1 处 Bun.spawn） |
| A2A 与现有 MCP 能力边界被混淆 | 一个是自治 Agent、一个是工具集 | 文档与配置中明确两个开关；默认都只监听本机 |
| 远程化放大权限风险 | 网络可达意味着写工具可能被远程触发 | 默认 127.0.0.1 + 强制认证 + 权限引擎不旁路 + deny-all 缺省 |
| 双端漂移（server 与 CLI 行为不一致） | 两份装配必然分叉 | P0 强制收口到 `@harness/host`；协议层禁止内嵌业务规则 |
| VSCode Chat API 依赖 Copilot Chat | 未装 Copilot Chat 的环境不可用 | B2 为 v1、B3 webview 为终态兜底；sidecar+webview 不依赖 Copilot |

---

## 9. 明确不做（本期范围外）

- gRPC / HTTP-REST binding、push notification webhook、extended agent card、多租户/mTLS/OAuth。
- A2A agent 间双向互调（harness 作为 A2A **客户端**去调别的 agent）——本方案只做服务端；客户端能力未来经 mcp-client 同构的插件补。
- Marketplace 发布、自动更新、多 workspace 并发 sidecar 池化（P3 之后）。
- 把 OpenTUI 终端 UI 跨平台到浏览器——webview 是 React 重写，不做终端仿真。

---

## 10. 待确认决策

1. 传输优先级：VSCode v1 是 **stdio sidecar**（最简）还是**直接复用 A2A 本地 HTTP+SSE**（少一种协议，但要管端口）？建议 stdio 先行，P1 完成后再切 SSE。
2. A2A 服务是否随 CLI 发布为子命令（`harness a2a --port`），还是独立可执行包？建议前者（复用 host 装配与配置）。
3. subagent 类 agent 是否对外暴露为独立 AgentCard？建议默认不暴露、配置开启。
4. VSCode 扩展代码放主 monorepo（`adapters/`）还是独立仓库？建议独立仓库，避免 `@types/vscode` 与 webview 构建链污染主包。
