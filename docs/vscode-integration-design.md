# VSCode 接入设计稿（P2 / P3）

> 状态：**设计稿（§10 推荐项已按"案 A + 控制面 `POST /harness/rpc`"开工）** · 2026-10-01
> 落地进度：**P2-A 控制通道已实现**（`packages/a2a-server/src/control.ts`，续 240）；
> **P2-B 扩展骨架已实现**（`adapters/vscode/`，含真 sidecar 端到端 + VSIX 实装，续 241）。
> 下表 §9 的分期已更新。§5 的 reasoning 映射与 §3.2 的守卫**按实测订正**（见各节内的订正框）。
> 上游：`docs/external-integration-plan.md` §4（方案 B）/ §5（总体架构）/ §6（P2/P3）
> 前置：`docs/host-extraction-design.md`（P0，已落地）、`packages/a2a-server`（P1，已落地 + 官方 TCK 外部验收）
>
> 本稿回答三件事：**① 走哪种传输；② 扩展怎么放；③ VSCode 的交互面与 harness 的能力面怎么一一对上**。
> 文中所有 VSCode API 签名均取自 `vscode.d.ts`（main 分支，2026-10-01 下载核对），**不凭记忆**；
> 所有 harness 侧符号均标注了实际文件位置。

---

## 0. 一句话结论

**P2 = 一个"薄转发"的 Chat Participant**：VSCode 侧只做「把 `request.prompt` 发给 harness、把 harness 的流事件翻译成 `ChatResponseStream`、把权限/取消两件事双向接起来」，
**harness 自己跑 agent loop、自己选模型、自己执行工具** —— 扩展不参与推理、不碰工具实现。

由此推出本稿最重要的三个设计判断：

| # | 判断 | 依据 |
|---|---|---|
| 1 | **不使用 `request.model`** | harness 自带 Provider 与 agentic loop；用 VSCode 的模型等于把 loop 劈成两半。Chat 视图的模型下拉对本参与者**无效**，需在 UX 上明说 |
| 2 | **必须引入"控制通道"** | A2A 协议只有 6 个方法，而 CLI 有 18 个斜杠命令，其中 12 个是**本进程管理操作**（`/compact` `/stats` `/agent` `/model` `/permission` `/skills` …），协议里没有对应方法 |
| 3 | **两案都要 spawn 子进程** | harness 是 Bun 运行时、VSCode extension host 是 Node ⇒ "复用 A2A"**不等于**"不用 spawn"，区别只在**管道形态**（HTTP+SSE vs stdin/stdout） |

---

## 1. 目标与验收口径

引用 plan §6（不重写）：

| 阶段 | 交付物 | 验收口径 |
|---|---|---|
| **P2** | VSIX 扩展（不发布 Marketplace） | 在 VSCode 中 `@harness` 提问：流式回答、工具进度、斜杠命令可见；终止按钮可中断；权限请求弹窗可决策 |
| **P3** | VSIX 完整版 | 终端 TUI 的核心信息结构在 IDE 内等价呈现（块模型 / 侧栏 / 会话 / 后台任务 / 文件引用 / 统计） |

**本稿只把 P2 设计到"可以直接开工"的粒度**；P3 只定接缝与目录结构，不展开组件级设计。

---

## 2. 传输两案对比（**本稿的核心决策**）

### 2.1 一个先要澄清的前提

plan §4.3 的表里把「spawn bun 进程」和「进程内嵌入 Node host」并列，容易读成"选了 A2A 就不用 spawn"。**不是的**：

```
harness 运行时 = Bun（packages/* 全是 TS，直接跑）
VSCode extension host = Node（VSIX 的硬约束）
⇒ 扩展与 harness 必然跨进程
⇒ 差别只剩「跨进程用什么管道」，不是「要不要跨进程」
```

所以下面两案是**同类比较**：都属于"扩展 spawn 一个 harness 子进程"，只比管道。

### 2.2 案 A：复用已完工的 A2A HTTP+SSE

- 管道：`harness a2a --port <n>` 起 `Bun.serve`（`127.0.0.1`，`packages/cli/src/index.ts:1922` `runA2aCli`）→ 扩展用 HTTP POST `/a2a` + SSE。
- 复用度：**协议层 100% 复用**。`SendMessage` / `SendStreamingMessage(SSE)` / `GetTask` / `CancelTask` / `ListTasks` 全部现成，且已被官方 `a2a-tck` 外部验收（`docs/development-log.md` 续 238：`MUST PASS 57 / FAIL 2`，两条 FAIL 是 TCK 参考 SUT 特化断言，非我方缺陷）。
- 生命周期：扩展负责 spawn / 优雅停止（`SIGINT`/`SIGTERM` 已被 `runA2aCli` 处理）。
- 安全面：本机回环 + 可选 Bearer（`verifyBearer`）+ `CallerRegistry` 的 `contextId` 归属隔离，三层都在。
- 代价：要管端口（冲突 / 残留进程）；本机任意进程只要拿到 token 也能连（默认无 token，仅靠回环）。

### 2.3 案 B：stdio sidecar（newline-delimited JSON-RPC）

- 管道：扩展 spawn harness，走 `stdin`/`stdout`。
- 复用度：**协议层 0 复用** —— 要新写一个 stdio JSON-RPC 宿主（framing + 多路复用 + 取消信令 + 流式分帧），并且 A2A 那套已经验收过的并发/幂等/隔离语义要在新宿主上**再实现一遍并再验收一遍**。
- 生命周期：与扩展同生共死，无需端口协商，进程退出即断连（无残留）。
- 安全面：管道只对本进程可见，**没有网络面** —— 这是它唯一的、但确实重要的优势。
- 代价：两条协议路（A2A 与 stdio）长期并存 ⇒ 两套测试、两处修 bug。

### 2.4 对比矩阵

| 维度 | 案 A：A2A HTTP+SSE | 案 B：stdio sidecar |
|---|---|---|
| 协议复用 | ✅ 现成 + 已外部验收 | ❌ 从零实现 + 需重做验收 |
| P3 复用 | ✅ webview 同一传输 | ❌ 或要再写一遍 |
| 多客户端（CLI / 别的 IDE / 远程 harness） | ✅ 天然 | ❌ 只能本扩展 |
| 安全默认面 | ⚠️ 本机回环端口（有 Bearer 与归属隔离） | ✅ 无网络面 |
| 端口 / 残留进程管理 | ⚠️ 需要 | ✅ 不需要 |
| 调试 | ✅ `curl` / `a2a-inspector` 可直接打 | ⚠️ 要自己做个管道转接 |
| 取消语义 | ✅ `CancelTask` 已定 | ⚠️ 要新定义 |
| 权限挂起语义 | ✅ `INPUT_REQUIRED` 已定 | ⚠️ 要新定义 |
| 新增代码量（估） | 扩展侧：参与者 + 映射 + 控制通道 | 扩展侧 **+** 一套 stdio 宿主 |

### 2.5 建议：**案 A 先行，但把传输抽成接口**

**建议案 A**，理由按权重排序：

1. **P1 的那笔投入只有走案 A 才回收**。P1-C/D/E 做的是"把 A2A 服务端做对并验收"，如果 VSCode 接入改用 stdio，这笔投入对 P2 的价值归零 —— 且 stdio 宿主也要重做一遍并发/幂等/隔离，等于再付一次 P1 的代价。
2. **P2 与 P3 共用**。P3 的 webview 与 B2 是同一个 sidecar，换传输要改两处。
3. **端口问题的量级可接受且可控**：默认 `4321`，被占则用 `--port 0`（`runA2aCli` 已支持 0~65535 且端口 0 时 `server.port` 回填真实端口，`server.ts` 里已有该分支）。"别的进程连上"这件事已被 `verifyBearer` + `CallerRegistry` 挡住（且默认只监听 `127.0.0.1`）。

**但把传输抽成一个窄接口**，让案 B 将来是"加一个实现"而不是"改一遍"：

```ts
/** 扩展侧唯一的传输面。案 A / 案 B 各一个实现，参与者只认这个接口 */
interface HarnessTransport {
  start(opts: { cwd: string; token?: string }): Promise<{ endpoint: string }>
  send(ctx: { contextId?: string; messageId: string }, text: string, signal: AbortSignal): AsyncIterable<unknown>  // A2A StreamResponse
  cancel(taskId: string): Promise<void>
  /** 控制通道（见 §6）：斜杠命令走这里，不走 A2A */
  control(method: string, params: unknown): Promise<unknown>
  dispose(): Promise<void>
}
```

> **反方立场（一并记下，供拍板时权衡）**：若产品定位是"**绝不开放任何端口**"（例如面向强合规环境），案 B 的"无网络面"是硬要求，此时应直接选案 B，并接受"重做一遍并发/幂等/隔离"的代价。
> **折中方案**：案 A 先行（复用 P1），案 B 作为第二实现，在 `HarnessTransport` 抽象落地后其增量成本已经很小。

---

## 3. VSCode 侧架构

### 3.1 进程模型

```
┌─ VSCode Extension Host (Node) ──────────────────────────────┐
│  activate()                                                  │
│   ├─ 解析/定位 harness 二进制或 bun                            │
│   ├─ spawn(`harness a2a --port 0 [--token <随机>]`, {cwd:workspace}) │
│   ├─ 读 stdout 拿真实端点（runA2aCli 打印 "JSON-RPC 端点: ..."）│
│   └─ vscode.chat.createChatParticipant('harness.assistant', handler) │
│                                                              │
│  handler(request, context, stream, token)                    │
│   ├─ 控制通道：request.command ∈ {compact,stats,agent,…} ⇒ /harness/rpc │
│   ├─ 普通对话：/a2a SendStreamingMessage(SSE) ⇒ 事件映射 ⇒ stream.*   │
│   ├─ 权限：asker 回调 ⇒ 模态四态对话框 ⇒ 答复回传                    │
│   └─ 取消：token.onCancellationRequested ⇒ CancelTask / abort        │
└──────────────────────────────────────────────────────────────┘
                              │ HTTP 127.0.0.1（可选 Bearer）
┌─ harness sidecar (Bun) ─────▼────────────────────────────────┐
│  createHost()  →  createA2aServer()                           │
│   ├─ POST /a2a        ← 纯 A2A 协议（TCK 只打这里）             │
│   ├─ POST /harness/rpc ← 控制面（本扩展私有，非协议）            │
│   └─ GET  /.well-known/agent-card.json                        │
└──────────────────────────────────────────────────────────────┘
```

**关键约束**：控制面与方法面**分成两条路径**，不复用 `/a2a` 的 JSON-RPC 命名空间。
理由：`/a2a` 的每一点行为都被 TCK 盯着（"未知方法必须 `MethodNotFound`"）、且是**对外协议**；把私有管理方法塞进去会让"协议面"与"实现面"重新耦上 —— 这正是 P0 花四步拆掉的那种耦合。另开一条路径，TCK 永远不会碰到它。

### 3.2 扩展目录结构（对应 plan §10.4 待确认决策）

§10.4 建议"独立仓库，避免 `@types/vscode` 与 webview 构建链污染主包"。**同意方向，但建议做成"仓内目录、不入 workspace"**：

```
agent-harness/                      # 主 monorepo（41 包，bun workspace）
├─ packages/…                       # 不动
└─ adapters/vscode/                 # ← 新目录
    ├─ package.json                 # 自己的依赖；**不加入 root 的 workspaces**
    ├─ tsconfig.json                # 独立，不被 root tsconfig include
    ├─ src/extension.ts             # activate / 命令注册
    ├─ src/participant.ts           # ChatRequestHandler
    ├─ src/transport/a2a.ts         # HarnessTransport 的案 A 实现
    ├─ src/map/stream.ts            # AgentStreamEvent → ChatResponseStream
    ├─ src/map/permission.ts        # 四态 → VSCode UI
    └─ src/sidecar.ts               # spawn / 端口解析 / 生命周期
```

为什么是"仓内目录但不入 workspace"：

| 关注点 | 独立仓库 | 仓内 `adapters/vscode/`（不入 workspace） |
|---|---|---|
| 主仓 typecheck / test 不受污染 | ✅ | ✅ 只要不加进 `workspaces` 与 root `tsconfig.include` |
| 改协议时两边一起改（原子提交） | ❌ 要跨仓两次提交 | ✅ |
| 与 A2A 端点的契约漂移 | ❌ 容易漂 | ✅ 同一个 PR 里就能发现 |
| `@types/vscode` / vsce / webview 链 | ✅ 天然隔离 | ✅ 只要独立 `package.json` |

> ⚠️ **落地时必须验证**：`adapters/vscode/` 不能落进 root `tsconfig.json` 的 `include`，也不能出现在 `package.json` 的 `workspaces` 里 —— 否则 `bun run typecheck`（`bun --filter=* run typecheck`）会把它算进去，而它依赖 `@types/vscode`（需要 VSCode 引擎版本，主仓 CI 没有）。**这条要有一个守卫测试**（类似 P0 里读源码文本的那种防线）。
>
> ✅ **已落地（P2-B，2026-10-01）**：守卫在 `packages/a2a-server/src/adapters-isolation.test.ts`（5 条）——
> ① `workspaces` 不含 adapters；② root `tsconfig.include` 不含 adapters；
> ③ 扩展 `package.json` 不依赖 `@harness/*`；④ 扩展源码不 `import @harness/*`（跨进程只讲协议）；
> ⑤ VSCode 引擎下限 ≥ 1.138。反向验证：把 `adapters/*` 塞进 workspaces ⇒ 第 ①条变红。
> 另：隔离是**天然成立**的（workspaces 只含 packages 下的一层，tsconfig include 只含 packages 下各包的 src），
> 守卫的作用是把"天然"变成"被断言"。

### 3.3 `package.json` 贡献点

```jsonc
{
  "contributes": {
    "chatParticipants": [
      {
        "id": "harness.assistant",
        "name": "harness",
        "fullName": "Harness",
        "description": "让 harness agent 在你的工作区里自主多步执行",
        "isSticky": true,
        "commands": [
          { "name": "compact",   "description": "压缩当前会话上下文" },
          { "name": "stats",     "description": "查看用量与上下文占用" },
          { "name": "agent",     "description": "列出或切换 Agent" },
          { "name": "model",     "description": "查看或切换模型" },
          { "name": "permission", "description": "查看或修改权限规则" },
          { "name": "skills",    "description": "列出或管理技能" }
        ]
      }
    ]
  }
}
```

斜杠命令的 `name` 与 CLI 同名（`/compact` `/stats` …），降低两套界面的认知成本 —— 但**实现不同**（见 §6）。

---

## 4. 参与者实现

### 4.1 注册与签名（取自 `vscode.d.ts` 核对）

```ts
export function activate(ctx: vscode.ExtensionContext) {
  const p = vscode.chat.createChatParticipant('harness.assistant', handler)
  p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'icon.png')
  p.followupProvider = { provideFollowups }
  ctx.subscriptions.push(p)
}
```

```ts
export type ChatRequestHandler = (
  request: ChatRequest, context: ChatContext,
  response: ChatResponseStream, token: CancellationToken,
) => ProviderResult<ChatResult | void>

export interface ChatRequest {
  readonly prompt: string
  readonly command: string | undefined
  readonly references: readonly ChatPromptReference[]
  readonly toolReferences: readonly ChatLanguageModelToolReference[]
  readonly toolInvocationToken: ChatParticipantToolToken   // 稳定版类型是 never，运行期是真 token
  readonly model: LanguageModelChat
}
export interface ChatContext { readonly history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn> }
```

### 4.2 `ChatResponseStream` 的**稳定**能力面（这是硬约束）

`vscode.d.ts:19910`，稳定版**只有这 7 个**：

```ts
export interface ChatResponseStream {
  markdown(value: string | MarkdownString): void
  anchor(value: Uri | Location, title?: string): void
  button(command: Command): void
  filetree(value: ChatResponseFileTree[], baseUri: Uri): void
  progress(value: string): void
  reference(value: Uri | Location, iconPath?: IconPath): void
  push(part: ChatResponsePart): void
}
```

⚠️ **没有 `thinking` / `warning` / `confirmation` 这些一等公民**：
- `stream.thinkingProgress(...)` / `stream.warning(...)` / `stream.confirmation(...)` 只存在于 **proposed** 的 `vscode.proposed.chatParticipantAdditions.d.ts`，**稳定 API 用不了**。
- ⇒ 设计上必须用 `markdown` / `progress` / `button` / `push` 这四样**拼**出 reasoning 块、工具块、警示块（见 §5）。

### 4.3 跨轮状态的携带（会话绑定）

稳定 API **没有 chat session id**（`ChatContext` 只有 `history`）。可用机制是官方文档写明的两条：

1. `ChatResult.metadata` —— handler 返回值里可塞任意 JSON；
2. `ChatResponseTurn.result` —— 下一轮从 `context.history` 里读回（`ChatResponseTurn.result: ChatResult`，`vscode.d.ts:19641`）。

⇒ 设计：**把 harness 的 `contextId` 放进 `result.metadata.harnessContextId`**，下一轮从 `context.history` 最后一个 `ChatResponseTurn` 读回。`history.length === 0` 视为"新对话"（新建 harness 会话，或按 plan §3.6 的三级回退恢复本目录上次会话）。

> **不要**把 VSCode 的 `history` 塞进 harness 的 prompt。harness 有自己完整的会话历史（`host.sessionStore` / `loadFullHistory`）——塞进去等于同一段上下文存两份，且两份的口径（压缩、token 预算）不一致。

---

## 5. 事件映射：跨进程事件 → `ChatResponseStream`

> **⚠️ 原稿订正（P2-B 实测，2026-10-01）**
>
> 本节原稿写成"`AgentStreamEvent` → `ChatResponseStream`"，**在案 A 下是错的**：
>
> 1. **消费的不是 `AgentStreamEvent`** —— 跨进程之后扩展拿到的是 **A2A 的线上 JSON**
>    （`{task}` / `{statusUpdate}` / `{artifactUpdate}` / `{message}`）。`AgentStreamEvent`
>    在 sidecar 进程内就被 `StreamAdapter` 吃掉了，扩展根本看不见。
>    实现在 `adapters/vscode/src/map/render.ts`，映射表按**实测抓帧**写。
> 2. **`reasoning_delta` 拿不到内容** —— `mapping.ts` 的 `reasoning_delta` 分支
>    **只累计字符数、不发事件**（`this.reasoningChars += ...; return []`）。
>    所以"推理折叠块"在案 A 下**无从渲染**，只能显示"在思考"。
>    设计稿 §10 第 5 项（reasoning 默认渲染）在案 A 下实际不可实现 —— 见下面订正后的表。
>
> 结论：下表"harness 侧事件"一列应读作**"语义来源"**，真正的输入是它经 `StreamAdapter`
> 转成的 A2A 表示（`metadata.phase`：`tool-start` / `tool-result` / `gate` / `step`）。

harness 侧事件源：`host.sendStream(sessionId, text, signal): AsyncGenerator<AgentStreamEvent>`（`packages/host/src/host.ts:1307`），
事件联合定义在 `packages/core/src/index.ts:660`。

| AgentStreamEvent（语义来源） | 案 A 下的实际输入 | ChatResponseStream | 说明 |
|---|---|---|---|
| `text_delta` | `artifactUpdate.artifact.parts[*].text` | `markdown(...)` | 服务端按 `DEFAULT_CHUNK_CHARS` 攒块后**增量**推（`append` + `lastChunk`），不是逐字。注意与 A2A 侧一致：攒块是**任务生命周期粒度**的选择，不是性能 |
| `reasoning_delta` | **无对应事件** | —— | ❌ **订正**：只累计字符数进终态 metadata，**内容不发**。案 A 下无法渲染推理块（§10 第 5 项作废，除非改 `StreamAdapter` 让它发出来） |
| `tool_call_start` | `progress(...)` + `markdown` 工具块头 | 工具块头形如 `\`\`\`\n▸ <toolId> <input 摘要>\n\`\`\``，与 TUI 的 ChatBlock 观感对齐 |
| `tool_call_result` | `markdown` 结果摘要 | `isError === true` ⇒ 前置 `⚠️`（无稳定 warning part）。长结果截断，完整结果走 `reference` 或折入折叠块 |
| `step_gate` | `progress(\`等待后台任务（已等 ${waitMs/1000}s）…\`)` | AGENTS.md 的心跳约定（>15s 必须有可见反馈）；`waitMs` 是**实际**等待值，别用 `plannedMs` |
| `done`（每步） | 一次"收尾渲染" | ⚠️ **不是整轮结束**。语义是"这一步结束"；整轮结束看 `turn_end` |
| `turn_end` | 收尾；`aborted === true` ⇒ 追加"已中断（保留已完成部分）" | `turn_end` 才是"本次查询不会再有任何事件" |
| （工具/闸门详情） | `push(part)` | 需要结构化 part 时用（如 `ChatResponseProgressPart`） |

**与 A2A 侧的关系**：`packages/a2a-server/src/mapping.ts` 的 `StreamAdapter` 解决的是"同一批 harness 事件 → A2A `StreamResponse`"。
**两者必须是同一套文案口径**（工具块头、折叠块、中断文案）—— 建议把**纯渲染函数**抽到一处共用（见 §7 的重构点）。

---

## 6. 控制通道：A2A 协议里**没有**的那一半

### 6.1 问题陈述（这是设计稿里最需要拍板的一点）

A2A 的 transport 只认这几个方法（`@a2a-js/sdk@1.3.0`）：

```
SendMessage / SendStreamingMessage / GetTask / CancelTask / ListTasks
/ SubscribeToTask / *PushNotificationConfig* / GetExtendedAgentCard
```

而 CLI 有 **18** 个斜杠命令（`packages/cli/src/index.ts`）：

```
/help /exit /quit /sessions /save /new /resume /agent /switch /model
/config /compact /stats /stats-export /search /export /permission /skills
```

逐条判断它们能不能落到 A2A 上：

| CLI 命令 | 需要的 harness 能力（实测位置） | A2A 有对应方法？ | 落在哪 |
|---|---|---|---|
| `/compact` | `harness.session.compactIfNeeded` / `buildCompactionOptions`，读 `configStore` | ❌ | 控制通道 |
| `/stats` `/stats-export` | `resolveCurrentUsage` / `resolveTodayUsage` / `renderContextOccupancy` | ❌ | 控制通道 |
| `/agent` `/switch` | `harness.agent.list()` / `get()` / `host.setAgentTools` | ❌ | 控制通道 |
| `/model` | `host.listConfiguredProviders` / `setModel` / `setSessionModel` | ❌ | 控制通道 |
| `/permission` | `host.permission.getMode/getRules` / `host.setPermissionRules` | ❌ | 控制通道 |
| `/skills` | `host.skillInfos` / `enableSkill` / `disableSkill` / `reloadSkill` | ❌ | 控制通道 |
| `/config` `/search` `/export` `/save` | 本地配置 / 会话检索 / 导出 | ❌ | 控制通道 |
| `/sessions` `/resume` | `host.sessionStore.list` / `findResumeTarget` | ⚠️ 部分：`ListTasks` 列的是**任务**不是**会话** | 控制通道（别硬套 ListTasks） |
| `/new` | 新建会话 | ⚠️ 靠 `contextId` 隐式表达 | 控制通道 |
| `/help` `/exit` `/quit` | 纯客户端 | — | 扩展本地 |
| （终止） | — | ✅ `CancelTask` | **A2A 本方法** |

⇒ 12/18 条命令在 A2A 协议里**无处安放**。这不是设计缺陷，而是**协议定位**：A2A 是"远程 agent 互操作协议"，不负责"本地管理面"。

### 6.2 三个候选做法

| 做法 | 评估 |
|---|---|
| (i) 扩展直连 host | ❌ 不可能 —— host 在 sidecar 进程里 |
| (ii) 把 `harness/*` 方法塞进 `/a2a` 的 JSON-RPC 命名空间 | ⚠️ 能跑，但**污染协议面**：`/a2a` 的"未知方法必须 MethodNotFound"是 TCK 的断言项；一个端点两套语义，日后每次改 A2A 都要重想"这条会不会影响私有方法" |
| (iii) **另开路径 `POST /harness/rpc`** | ✅ **建议** |

### 6.3 建议方案：`POST /harness/rpc`（✅ 已落地 · P2-A）

> **落地记录（2026-10-01，`docs/development-log.md` 续 240）**：`packages/a2a-server/src/control.ts`
> 实现了首批 **14 个 `harness/*` 方法**（notice / session / agent / model / permission / skill / compact），
> 路由在 `server.ts` 的 `handle()` 里与 `/a2a` **并列**，共用同一个 Bearer 但不做 A2A 版本校验、
> 不进 AgentCard，错误词汇独立（`ControlError` / `controlCode`）。
> **两处与本节原稿的偏差**（都是实现时才定下来的）：
> ① **入参一律结构化**（如 `harness/model.set` 收 `{ providerId, modelId }` 而不是 `/model hy3` 这类自由文本）
> —— 歧义消解属"输入词汇"，留在敲命令的那一端（见 `control.ts` 文件头）；
> ② `harness/stats.get` 当时未实现 —— ✅ **续 242 已补**（2026-10-02）：四个装配函数
> （`resolveCurrentUsage` / `renderChildAgentRollup` / `renderContextOccupancy` / `collectTodayUsage`）
> 已上移 `@harness/usage`（结构化最小接口、零新增包依赖），CLI 与 sidecar 共用同一份实现。


- 同一个 `Bun.serve`，**不同路径**，自己的小 JSON-RPC（`{jsonrpc,id,method,params}` 形状照搬，便于复用现有错误码词汇）。
- 方法命名空间 `harness/*`，与 A2A 方法**没有任何交集**。
- **不进 AgentCard**：卡片是给 A2A 客户端的，控制面是本扩展私有的实现细节 —— 声明出去等于对外承诺一套并不打算标准化的 API。
- 鉴权沿用同一 Bearer（同一端口，不该有两套凭据）。
- 与 §2.5 的 `HarnessTransport.control()` 直接对应。

首批方法（按 P2 需要排序）：

```
harness/session.list        → [{ id, title, messageCount, updatedAt, cwd }]      （对应 /sessions）
harness/session.resume      → { contextId }                                       （对应 /resume）
harness/session.new         → { contextId }                                       （对应 /new）
harness/session.compact     → { did, info }                                       （对应 /compact）
harness/stats.get           → { usage, today, occupancy }                         （对应 /stats）
harness/agent.list          → [{ id, name, model, current }]                      （对应 /agent）
harness/agent.set           → { ok }                                              （对应 /agent <id>）
harness/model.get / .set    → { spec } / { ok }                                   （对应 /model）
harness/permission.get      → { mode, rules }                                     （对应 /permission）
harness/permission.set      → { ok }                                              （对应 /permission <k>=<v>）
harness/skill.list / .set   → [{ id, name, enabled, sourceLabel }] / { ok }       （对应 /skills）
harness/notice.list         → HostNotice[]                                        （**E2E 可观测性**：见 §8）
```

> **P2 增量（续 242 / 243 落地）**：最终 18 个方法 —— 上表 + `harness/session.get` /
> `harness/permission.set` / `harness/skill.set` / `harness/stats.get`（出参是
> `usage` / `today` / `rollupText` / `occupancyText` / **整页 `text`**，渲染文案唯一在宿主）/
> `harness/session.save` / `harness/tree.get`（磁盘树 + 会话引用标记，节点形状见
> `@harness/host/files.ts` 的 `FileRefTreeNode`）/ `harness/stats.export`（写文件回
> `path`，**不回传 content**）。统计与目录树的纯函数分别上移 `@harness/usage`
> 与 `@harness/host`，sidecar 不反向依赖 CLI。

> `harness/notice.list` 是新加的、也是最有价值的一条：它把 host 的装配期环形缓冲（`host.notices`，`packages/host/src/host.ts:284`）暴露给扩展 —— 于是"**无 key 回落到 Mock**"这类事实能在 VSCode 里显示出来，而不是让用户在 IDE 里拿到 mock 回答却没有任何信号（plan §6 末尾点名的那条风险）。

### 6.4 参与者命令 → 控制通道的映射

```ts
// participant.ts
if (request.command !== undefined) {
  const out = await transport.control(`harness/${request.command}.${verb}`, args)
  stream.markdown(renderControlResult(request.command, out))   // 复用 CLI 的渲染文案（纯函数）
  return { metadata: { harnessContextId } }
}
```

⚠️ **`command` 是扁平字符串**（`request.command: string | undefined`），`/permission bash=deny` 这种带参数的形式要靠解析 `request.prompt`。**注意**：当用户输入 `/permission bash=deny` 时，`request.command === 'permission'`、`request.prompt` 是**剩余部分**（不同 VSCode 版本行为需实测确认）—— 开工第一步就要把这个行为钉住，别假设。

---

## 7. 权限与取消：两条接缝

### 7.1 权限（对应 plan §4.4）

**harness 侧接缝**（已存在，`packages/host/src/permission.ts:62`）：

```ts
export type PermissionAnswer = 'allow' | 'deny' | 'always-allow' | 'always-deny'
export type PermissionAskInput = Pick<PermissionRequest, 'toolKey' | 'patterns'>
export interface PermissionPrompt { toolKey; patterns; summary; text }
export type PermissionAsker = (req: PermissionAskInput, prompt: PermissionPrompt) => Promise<PermissionAnswer | undefined>
```

**VSCode 侧映射**：`showInformationMessage` 的**模态**四按钮 —— 这是四态语义在 VSCode 里最直接的落法：

```ts
async function vsAsk(req: PermissionAskInput, p: PermissionPrompt): Promise<PermissionAnswer | undefined> {
  const pick = await vscode.window.showInformationMessage(
    p.summary, { modal: true, detail: `工具：${p.toolKey}\n路径：${req.patterns.join(', ') || '(无)'}` },
    '允许一次', '本会话始终允许', '拒绝', '始终拒绝',
  )
  return pick === '允许一次' ? 'allow'
       : pick === '本会话始终允许' ? 'always-allow'
       : pick === '拒绝' ? 'deny'
       : pick === '始终拒绝' ? 'always-deny'
       : undefined            // 关掉对话框 = 取不到答复 ⇒ 引擎按 deny（fail-safe，与 CLI 一致）
}
```

> ⚠️ **不要用 `lm.registerTool` 的 `prepareInvocation`/`confirmationMessages` 来做这件事。**
> 那套机制是"**Copilot 调用你的工具**"路径（`LanguageModelToolConfirmationMessages`，`vscode.d.ts:21184`），
> 而 harness 的场景是"**harness 自己调用自己的工具**" —— Copilot 的编排器根本不在这条链路上，工具确认弹窗永远不会被触发。
> 这是最容易想歪的一处：名字很像，链路完全不同。

**词汇表复用（重构点）**：四态字符串与"问题怎么组织"已经在 `packages/a2a-server/src/mapping.ts` 里定义过
（`PERMISSION_ANSWERS` / `parsePermissionAnswer` / `buildPermissionMetadata` / `buildPermissionQuestion`）。
VSCode 侧不该再写第二份 —— 建议**上移到中性位置**（新建 `packages/protocol-ui` 或暂由 `@harness/a2a-server` re-export），
否则"四态"会长出两个定义，将来加第五态时必漏一处。

**宿主接线**：与 A2A 同构 —— `createA2aServer` 里做 `host.permission.setAsker(...)`（`packages/a2a-server/src/server.ts:288`）。
VSCode 场景下 asker 在**扩展进程**里，而 host 在 **sidecar 进程**里 ⇒ 需要"asker 跨进程"：sidecar 把 ask 变成一个 `harness/ask` 的**反向请求**（HTTP 上没法反向推，只能用长轮询或 SSE 事件），扩展答复后再让挂起解冻。

> **这条是整个 P2 里最绕的一处，必须有独立设计**。两个可行方向：
> **(a) 复用 A2A 的挂起机制**：ask 点直接转成 `TASK_STATE_INPUT_REQUIRED`，扩展侧收到该状态就弹对话框，答复用"带同一 `taskId` 的 `SendMessage`"回传 —— **机制完全现成**（这正是 P1 已经做好并验收过的），代价是权限弹窗要包装成"一个任务被中断"的语义。
> **(b) 控制通道开反向事件流**（`GET /harness/events` 的 SSE），ask 作为事件推给扩展，答复走 `POST /harness/rpc`。
> **建议 (a)** —— 零新增协议，且 §2.5 选案 A 的收益在这里二次兑现：如果选案 B，这套挂起机制要重做。

### 7.2 取消

- 触发：`token.onCancellationRequested`（用户点聊天里的停止）。
- 动作：`CancelTask(taskId)`（A2A 本方法），同时 `abort()` 掉正在读的 SSE 流。
- 语义：harness 在**步边界**生效，**保留已完成部分** —— `AgentStreamEvent.aborted` 会置位，UI 呈现为"已中断"而非"失败"（`packages/core/src/index.ts:706`）。
- ⚠️ 别把"停止渲染"当成"停止执行"：只 `break` 掉 `for await` 而不发 `CancelTask`，harness 会继续跑完并把结果写回会话。

---

## 8. 可观测性与"降级事实"（收掉 plan §6 的那一格）

plan §6 末尾记着一条：装配期 20 处 `stdout.write` 里，① 类（用户必须知道的事实，如"未配置 API key，回落到 Mock"）
若被 A2A 宿主塞进日志通道，**远程调用方会静默拿到 mock 回答**。

现状（本轮核对）：`runA2aCli` 把装配期 notice 全部渲染到 **stderr**（`packages/cli/src/index.ts:1962`），
host 侧另有环形缓冲 `host.notices`（`host.ts:284`，容量 `HOST_NOTICE_LIMIT`）。

⇒ **还差最后一跳**：让调用方（VSCode 扩展）能读到这批事实。设计两条：

1. **启动自检**：扩展 spawn 后调 `harness/notice.list`，把 `level === 'warn'` 的条目在 Chat 里以一行提示呈现（如"⚠️ 未配置 Anthropic key，已回落到 Mock Provider"）。
   —— **这条让"在 IDE 里拿到 mock 回答却毫无信号"变成不可能**。
2. **UI 呈现**：不占用回答区块（`markdown` 会进会话历史）；用 `stream.progress()` 一闪而过，或首次对话时用一条 `markdown` 提示并带 §7.1 的按钮（如"去配置"），`button({ command: 'harness.openConfig' })`。

---

## 9. 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P2-A（✅ 已落地）** | **控制通道**：`POST /harness/rpc` + 14 个 `harness/*` 方法（`packages/a2a-server/src/control.ts`） | `@harness/a2a-server` 70 → **104 pass / 0 fail**；与协议面互不串线（同一方法名打到 `/a2a` ⇒ `MethodNotFound`）；卡片不含控制路径 |
| **P2-B（骨架 / P2-v0）（✅ 已落地 2026-10-01，续 241）** | 扩展注册参与者；spawn sidecar 拿端点；`@harness <prompt>` 能拿到一段完整回答 | **无头可验的部分全绿**：`adapters/vscode` 57 pass / 0 fail（含 6 条真 sidecar 端到端：握手 / 取卡 / 版本头陷阱 / 控制面 / 流式管道 / dispose 无残留）；VSIX 打包并用 `code --install-extension` 实装成功。**仍需人手点验**：在 Chat 视图里 `@harness` 提问（本机未装 Copilot，Chat 视图无模型提供方时不显示参与者） |
| **P2-v1（✅ 已落地 2026-10-02，续 242）** | 事件映射（文本/工具/闸门）流式呈现；取消；权限四态弹窗（三项 P2-B 已落地）；6 个斜杠命令（`/compact /stats /agent /model /permission /skills`，解析在 `commands.ts` 纯模块，`/model` 为 get→resolve→set 两段协议）；启动自检提示（warn notices 每线程首轮一次） | 扩展 79 pass（含 7 条真 sidecar E2E）；主仓 2308 pass / 0 fail |
| **P2-v2（✅ 已落地 2026-10-02，续 243）** | 14 个斜杠命令（+`/sessions /new /resume /save /tree /stats-export /history /help`；`/config /plugins /edit /exit` 为 TUI 专属语义、刻意不适配）；`/new /resume` 换绑 TurnState.contextId，`/resume` 为 session.list→消解→resume 两段协议；`/tree` → `stream.filetree`（树纯函数上移 `@harness/host/files.ts`）；`/stats-export` → `stream.reference`（新控制方法 `session.save` / `tree.get` / `stats.export`）；对话正文文件引用扫描（正则与宿主同源，守卫测试钉住）；follow-ups 三档 | 扩展 101 pass（含 9 条真 sidecar E2E）；主仓 2314 pass / 0 fail |
| **P3-A（✅ 已落地 2026-10-02，续 244）** | sidecar **单文件二进制分发**：`bun run build:sidecar` 产出 `packages/cli/dist/harness-a2a`（79.9MB / 354 modules）；前置是把 `lazyImport` 的内置包改**静态查表**（30 个 specifier）+ 双向守卫测试；扩展新增 `launch.ts` 纯模块（优先级：显式 `sidecarPath` > 显式 `cliPath` > 工作区二进制 > TS 入口配 bun > PATH `harness`）与配置 `harness.sidecarPath` | 扩展 112 pass（含 2 条**真二进制 E2E**：握手 + 取卡 + 控制面）；主仓 2318 pass / 0 fail |
| **P3-B1（✅ 已落地 2026-10-02，续 245）** | **侧栏 webview 面板**：`webview/state.ts`（纯 view-model + `planPanelAction`）/ `webview/html.ts`（纯骨架 + CSP nonce）/ `webview/panel.ts`（唯一碰 `vscode.WebviewView`）/ `media/panel.{css,js}`（手写、无构建链）；五个分区（会话 / 后台任务 / 文件引用 / 统计 / 宿主通知）**并行拉取、分区独立降级**；`HarnessTransport.listTasks()` 走 A2A `ListTasks`（不是控制面） | 扩展 **147 pass / 0 fail**（+35）；真 sidecar 面板 E2E：`ready=true`、`warnings` 为空（无分区降级）；主仓 2318 pass / 0 fail；反向验证 4 处全红；VSIX 62 文件实装成功 |
| **P3-B2（✅ 已落地 2026-10-03，续 246）** | **块模型时间线**（设计稿 §12.8）：`webview/timeline.ts` 纯归约器（块词汇与 TUI 的 `ChatBlockKind` 对齐、差异显式列出）+ `TimelineStore`；参与者写、侧栏订阅，**独立第二条通道**（`{type:'timeline'}`，节流 120ms + 尾部推送）；文本/心跳合并、环形缓冲 200 块 | 扩展 **166 pass / 0 fail**（+19，含 1 条真流式 E2E：真协议帧 → 块）；主仓 2318 pass / 0 fail；反向验证 4 处全红；VSIX 66 文件实装成功 |
| **P3-C（✅ 已落地 2026-10-03，续 247）** | **分发策略定为 A3 + bun 发现**（设计稿 §13）：扩展包不带二进制；`src/bun.ts` 纯模块（配置 > `BUN_INSTALL` > PATH > 已知安装位置），修掉旧 `findBun`"裸 bun 短路 ⇒ 绝对路径兜底永不执行"的缺陷；配置 `harness.bunPath`；`Sidecar.reconfigure` 让配置变更后重启真正生效（重新解析，而非重跑旧参数）；`[launch]` 启动自检三行写输出通道 | 扩展 **195 pass / 0 fail**（+29）；反向验证 4 处全红；`env -i` 模拟 GUI 环境实测命中 `/opt/homebrew/bin/bun`；主仓 2318 pass / 0 fail |

**P2-v1 的"开工第一步"**（三个必须先钉死的行为，都不是设计问题而是实测问题）：
1. `request.command` 与 `request.prompt` 对 `/permission bash=deny` 的切分行为（§6.4）。
2. `spawn` 后从 stdout 读端点的时序（`runA2aCli` 的打印格式若变，解析会崩 —— 应改为**结构化输出**：加 `--json` 或写约定文件/环境变量）。
3. 模态对话框与 `token` 取消的竞争（对话框开着时用户点停止，要能关掉对话框）。

---

## 10. 开放问题（待拍板）

| # | 问题 | 本稿倾向 |
|---|---|---|
| 1 | 传输：case A / case B | **案 A**（复用 P1），但抽 `HarnessTransport` 接口（§2.5） |
| 2 | 扩展位置 | **仓内 `adapters/vscode/`，但不入 workspace**（§3.2） |
| 3 | 控制面路径 | **`POST /harness/rpc`**，不进 AgentCard（§6.3） |
| 4 | 权限 asker 跨进程 | **复用 A2A 的 `INPUT_REQUIRED` 挂起**（§7.1 方案 a） |
| 5 | `reasoning_delta` 默认渲染？ | ❌ **案 A 下不可实现**（§5 订正）：`StreamAdapter` 只累计字符数、不发事件，扩展拿不到内容。要么改 `StreamAdapter` 让它发出来（会污染 A2A 产物语义），要么**放弃**该项。当前实现：只显示"在思考"级别的提示 |
| 6 | 要不要同时把 harness 工具注册成 `languageModelTools`（让 Copilot agent mode 直接调）？ | **另开一条线**（即 plan 的 B1 变体），**不混进 P2** —— 二者是"harness 自主"与"Copilot 编排"两种世界观 |
| 7 | 无 Copilot Chat 的环境怎么办？ | P2 只要求 Copilot Chat 存在（plan 已明示该局限）；P3 的 webview 是不依赖 Copilot 的兜底 |

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| `ChatResponseStream` 稳定面太窄（无 reasoning/warning/confirmation） | 全部用 `markdown` + `progress` 拼；**把渲染函数集中一处**，将来 API 补上时只改那一处 |
| 控制面方法随 CLI 漂移 | 控制面方法以"host 公共面"为唯一实现来源，**不许在 sidecar 里另写逻辑**（同 P1 对 a2a-server 的纪律：只做翻译与装配） |
| 端口冲突 / sidecar 残留 | `--port 0` 自动分配 + 扩展 deactivate 时 `kill`；`--token <随机>` 防本机其他进程误连 |
| 两套界面（CLI 与 VSCode）文案漂移 | 渲染文案复用同一批纯函数（`renderStatsText` / `renderContextOccupancy` / `buildPermissionPrompt` 等） |
| 扩展依赖 `harness` 二进制分发 | ~~P3 用 `bun build --compile`（P0.5：61MB / 冷启动 18ms / 能加载用户 TS 插件）~~ **P3-A 实测订正**：光有 P0.5 的结论不够 —— 真编译主 CLI 会**启动即崩**（`Cannot find module '@harness/provider-openai' from '/$bunfs/root/…'`），因为内置插件是**按包名**动态导入、`import(变量)` 进不了 bundle（P0.5 验的是用户插件的 `file://` 绝对路径，不是同一条路）。**对策**：`packages/host/src/lazy.ts` 改静态查表（字面量可静态分析），并加双向守卫（注册点集合 == 表键集合 + 表内逐个真 import）。修完实测：二进制握手 / 取卡 / 控制面全通。**A3 订正（§13）**：二进制**不再随 VSIX 分发** —— 79.9MB 里 60MB 是不可剥离的 Bun runtime，随包分发等于每版让用户重下它。改复用机器上的 bun，并把"能不能找到 bun"当作一等公民来做（`src/bun.ts`） |
| 主仓 CI 被扩展依赖污染 | `adapters/vscode/` 不进 `workspaces`、不进 root `tsconfig.include`，并加**守卫测试**（§3.2） |

---

## 12. P3-B1 组件级设计：侧栏 webview

> P3 在本稿里此前"只定接缝"（§1），P3-B 开工前补这一节。**本轮已落地**（续 245），
> §12.8 的块模型时间线留给 P3-B2。

### 12.1 它补的是什么

P2 的落点是 **Chat 视图**（`chatParticipants`），代价写在开放问题 #7：Chat 视图要 Copilot Chat 存在，且
`ChatResponseStream` 稳定面只有 7 个方法（§4.2）——"侧栏常驻的会话/任务/文件/统计"这类**结构性信息**
在那里无处安放，只能靠 `/sessions` `/stats` `/tree` 一条条命令问出来。

P3-B 补的是**不依赖 Copilot 的那个落点**：一个 webview 侧栏，把控制面已有的事实**常驻呈现 + 可点操作**。

### 12.2 硬纪律（三条，都是本仓既有纪律的延伸）

| # | 纪律 | 理由 |
|---|---|---|
| 1 | **不新增"面板专用"控制方法** | 面板只读/只调**已有**的 `harness/*`（`session.list` / `stats.get` / `tree.get` / `notice.list` / `session.new` / `session.resume` / `session.save` / `compact` / `stats.export`）。控制面一旦为 UI 开后门，就退回到 P0 拆掉的那种耦合 |
| 2 | **后台任务走 A2A 协议方法，不走控制面** | `ListTasks` 是 A2A 自己的方法（不是我方私有），放 `HarnessTransport.listTasks()` 而不是 `harness/tasks.list` —— 协议面能表达的，不许落进控制面（与 §6.3 同一条界线） |
| 3 | **渲染文案只有宿主一份** | 面板的统计/通知/文件树一律显示 sidecar 回传的 **text 字段**（`stats.get.text` / `notice.list[].text` / `tree.get.text`），扩展端不写第二套渲染器（§11「两套界面文案漂移」的对策） |

### 12.3 分层（纯模块 + 薄适配，与 `commands.ts` / `launch.ts` 同一套路）

```
adapters/vscode/
├─ src/webview/state.ts     ← 纯：view-model 归一 + 面板动作规划（不 import vscode）
├─ src/webview/html.ts      ← 纯：面板骨架 + CSP（nonce 由调用方注入）
├─ src/webview/panel.ts     ← 薄：唯一碰 vscode.WebviewView 的文件（拉数据 / 发消息 / 执行动作）
└─ media/panel.{css,js}     ← 前端：手写，无构建链（§10.4「避免 webview 构建链污染」）
```

为什么前端**不引入构建链**：面板是"信息面板"，DOM 量小；为一个 esbuild 配置把 `adapters/vscode/`
变成需要打包的目录，会污染 §3.2 那套隔离（守卫测的是"扩展不依赖 `@harness/*`"，但构建链会引入
另一类依赖面）。手写 JS + CSP nonce 足够，且 VSIX 打包无需额外步骤。

### 12.4 数据流

```
webview (media/panel.js)                    extension host                    sidecar
   │  postMessage {type:'refresh'|'new'|'resume'|…}     │                        │
   ├─ planPanelAction(msg) ─────────────► PanelAction ──┤                        │
   │                                    control(...) ──┼── POST /harness/rpc ───►│
   │                                    listTasks()  ──┼── POST /a2a (ListTasks)►│
   │  ◄── {type:'state', state: PanelState} ───────────┤                        │
```

- **分区独立、并行拉取**（`Promise.allSettled`）：一个分区失败只降级那一个（`warnings` 里写明原因），
  不整块变灰 —— 与 §8「降级事实可见」同一口径。
- **刷新时机**：视图首次可见、面板内点操作后、命令 `harness.refreshPanel`。**不做轮询**
  （sidecar 没有变更推送，轮询只会制造噪声与端口流量）。

### 12.5 view-model 契约（`PanelState`）

`PanelState` 是**扩展与 webview 之间唯一的契约**（`postMessage` 的 payload）：

| 分区 | 来源 | 归一要点 |
|---|---|---|
| `endpoint` | `SidecarHandshake` | pid / port / auth / permissionMode，用于"面板连的是哪个 sidecar" |
| `sessions` | `harness/session.list` | 排序：当前 → 项目指针 → 本目录 → 更新时间倒序；标记徽章（当前/指针/本目录） |
| `tasks` | A2A `ListTasks` | `TASK_STATE_*` 前缀剥掉后人读化；取不到 ⇒ 降级为"不可用"并给原因 |
| `refs` | `harness/tree.get` 的 `refs` | 对话引用过的文件（截断到上限），点开直达 |
| `stats` | `harness/stats.get` 的 `text` | 整页文本直显 |
| `notices` | `harness/notice.list` | 宿主的降级事实（"未配置 key ⇒ 回落 Mock"）**常驻可见** |
| `warnings` | 逐个分区的失败原因 | 面板自己也要能说出"我为什么是空的" |

### 12.6 面板能触发什么（`PanelAction`）

`planPanelAction(msg)` 是纯函数（与 `planCommand` 同源思路），输出**动作描述**而非执行：

```
refresh → 重拉      new/resume/save/compact/stats-export → control(方法, 参数) + 刷新
open    → vscode 打开该文件      show-status → 执行已有命令 harness.showStatus
未知   → noop（带 reason，写进日志，不静默）
```

面板**不发对话**（那是 Chat 视图的事）—— 刻意不把 prompt 输入框搬进来，避免两条对话入口。

### 12.7 验收（可自动化的部分）

- 纯模块单测：`state.ts`（归一/排序/降级/动作规划）+ `html.ts`（CSP nonce 覆盖到 script 标签）。
- 真 sidecar E2E：起真进程 → 拉四个分区 → `buildPanelState` 的 `warnings` 为空且各分区非空。
- 无法自动化：webview 里的点击与样式（要人手点）。

### 12.8 块模型时间线（P3-B2，**已落地** 2026-10-03，续 246）

P3-B1 的侧栏只有"结构性事实"，**看不到一轮对话里发生了什么** —— 那些只活在 Chat 视图里，
而 Chat 视图要 Copilot 存在。时间线把参与者每轮的 `RenderOp` 流累积成**块**，在侧栏呈现。

#### 12.8.1 它是**第二条通道**，不是 `PanelState` 的一个字段

| | `{type:'state'}` | `{type:'timeline'}` |
|---|---|---|
| 内容 | 会话 / 任务 / 引用 / 统计 / 通知 | 本轮的块 |
| 触发 | 手动刷新（首次可见 / 操作后 / 命令） | **流式每帧** |
| 代价 | 五个控制面调用（重） | 一份小数组（轻） |

混进一份消息 ⇒ 每个 token 都要重发整份 `PanelState`。故分成两条，`timeline` 侧**节流**
（`TIMELINE_FLUSH_MS = 120`）后再推，且**带尾部推送**（终态块落在节流窗口里也必须送到）。

#### 12.8.2 块词汇：与 TUI 对齐，差异要**显式列出**

`ChatBlockKind`（`packages/cli/src/tui.tsx`）= system / user / thinking / assistant / tool /
compact / loadmore。本模块取能用的一档，其余不平移并写明理由：

| TUI | 侧栏 | 说明 |
|---|---|---|
| `user` / `assistant` / `tool` / `system` | 同名同义 | 平移 |
| `thinking` | ❌ | **案 A 下推理内容拿不到**（§5 已订正：服务端只累计字符数） |
| `compact` / `loadmore` | ❌ | 终端分页/折叠专属，IDE 里没有对应交互 |
| —— | `permission`（新增） | TUI 用控制台文本呈现权限询问；IDE 里它是**模态对话框**，需单独一类 |
| —— | `error`（新增） | TUI 把错误混在控制台块里；IDE 里错误要能一眼看到 |

差异**写在文件头表格里**，而不是悄悄不一致 —— 这是"两套界面不漂移"（§11）那条的延伸。

#### 12.8.3 合并口径（与服务端 `StreamAdapter` 同类选择，不是性能优化）

- 连续 `text` 并进同一个 assistant 块（逐帧增量不该碎成上百个块）；
- 连续**同文案**的 `progress` 合并计数（闸门心跳重复报同一句，否则一条"等待中"刷满一屏）；
- `done` / `error` 收尾：关掉所有 `streaming` 并写一个终态 system 块。

#### 12.8.4 边界

- **环形缓冲**（`MAX_TIMELINE_BLOCKS = 200`）：时间线是"最近若干块"的视图，不是全量会话历史；
- **参与者只认 `TimelineSink` 接口**、面板只认 `TimelineStore`，两边不互相依赖；
- **清空只是 UI 状态**：不动会话、不调控制面（它不是 harness 的状态）。

---

## 13. 分发：A3 —— 扩展包不带二进制，复用机器上的 bun

> 2026-10-03（续 247）落地。§11 风险表里"扩展依赖 harness 二进制分发"那条按本节订正。

### 13.1 先算清账：79.9MB 里 60MB 是 runtime

P3-A 产出的 `bun build --compile` 单文件二进制是 **79.9MB**。拆开看（`--metafile` 归组）：

| 构成 | 实测 | 可裁？ |
|---|---|---|
| Bun runtime | ~60MB（75%） | **不可剥离** |
| JS bundle | 5.75MB | 可（其中 **73% 是 TUI 侧**带进来的：`@opentui/core` 1.42 + React 家族 1.42 + Babel 家族 1.38） |
| tree-sitter wasm 资产 | 3.56MB | 可（随 TUI 一起去掉） |

各裁剪路线实测（同一台机器）：

| 路线 | 结果 |
|---|---|
| 基线 `--compile` | 79.9MB |
| `+ --minify` | 73.5MB |
| `--minify --bytecode` | ❌ **编译失败**（`@opentui/core` 的语法不被 bytecode 编译器接受） |
| 瘦入口（不 import `./tui`）+ `--minify` | 62.1MB —— 已贴 runtime 地板 |
| **VSIX 打包后（含二进制）** | **27.1MB**（vsce 走 zip deflate，2.8:1） |

结论：**JS 侧怎么裁，地板都是那 60MB 的 runtime**。要么接受"每版让用户下 27MB"，要么不随包分发。

### 13.2 选择：不随包分发

扩展包只带扩展（VSIX 0.15MB），sidecar 用**用户机器上的 bun** 跑工作区里的 `packages/cli/src/index.ts`。

理由：harness 本来就是 bun 生态的运行时（全链只有 3 处 Bun 专属 API：`Bun.serve` 在 `a2a-server/src/server.ts:605`、`Bun.spawn`/`spawnSync` 在 `packages/snapshot`）—— 用户装 harness 的前置条件里本来就有 bun，让扩展再背一份 60MB 的副本只是重复。

**逃生门保留**：`harness.sidecarPath` 还在。想走二进制分发的人自己 `bun run build:sidecar` 并指过去，扩展照用（优先级仍在最前）。

### 13.3 bun 发现链路（`src/bun.ts`）

纯模块（不 import vscode、不 spawn、不读 fs；`exists` 注入，可单测），顺序**先精确后宽泛、命中即止**：

| # | 来源 | 说明 |
|---|---|---|
| 1 | `harness.bunPath` | 显式配置。绝对路径存在即用；裸命令名（不含分隔符）当"交给 PATH"，不算失效 |
| 2 | `BUN_INSTALL/bin/bun` | bun 官方安装器写进 profile 的环境变量 |
| 3 | `PATH` 逐个目录 | GUI 启动的 VSCode PATH 很短、通常扫不中，但**不能跳过** |
| 4 | 已知安装位置 | `/opt/homebrew/bin`、`/usr/local/bin`、`~/.bun/bin`、`~/.local/bin`、volta / asdf / mise shims、`/usr/bin`、项目本地 `node_modules/.bin` |

只列**能写出出处**的位置 —— 猜错的路径会在排障时误导人，比"没找到"更糟。

#### 13.3.1 旧实现为什么是坏的（实测）

旧 `findBun()` 的候选表第一项是裸 `bun`，逻辑是"不含 `/` 就直接 return" ⇒ **后面所有绝对路径兜底永远不会被执行**。症状正是本仓反复踩到的那个："开发机上好好的，GUI 启动的 VSCode 里 spawn 不到 bun"。

`env -i` 模拟 GUI 启动的 VSCode（PATH 只有 launchd 给的最小值）：

```
$ env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin bun --version
env: bun: No such file or directory                          ← 裸 bun 在这个环境跑不了
旧 findBun → bun                                             ← 所以它必然失败
新 resolveBun → /opt/homebrew/bin/bun（来源：well-known）      ← 已知位置兜底在起作用
```

### 13.4 为什么不做 login shell 探测

`$SHELL -ilc 'command -v bun'` 是 GUI 应用的经典兜底，但两条路都不划算：同步执行会**阻塞扩展激活**（用户 rc 慢就是几秒），异步化要把整条解析链改成异步。已知安装位置 + 显式配置的覆盖面已经够 —— **不做**，留作后续。

### 13.5 失败语义（一律不静默）

| 情况 | 行为 |
|---|---|
| 配了绝对路径但不存在 | 回落自动发现，并置 `configInvalid` ⇒ 激活时 warning + 「打开设置」按钮；输出通道写明 |
| 完全找不到 bun | 不空转：`launch.ts` **跳过**"工作区 TS 入口"路线（自动探测不该选一条跑不起来的路线），回落 PATH `harness`，原因写进 `notes` |
| 显式配的 `.ts` 入口但没有 bun | **照用**（尊重显式选择），`notes` 说明"多半失败 + 怎么修" |
| 改了 `bunPath` / `sidecarPath` / `cliPath` | 提示「重启 sidecar 后生效」+ 一键重启；**重启会重新解析**（`Sidecar.reconfigure`），不是把旧参数再跑一遍 |

排障入口：输出通道的 `[launch]` 三行（跑什么 / 经什么跑 / 为什么降级）；`harness.showStatus` 附带 bun 摘要（`describeBun`）。

### 13.6 验收

- 扩展 **195 pass / 0 fail**（166 → 195，+29）：`bun.test.ts` 新增 17 条（含"GUI 场景"回归与 Windows 分隔符）、`launch.test.ts` +6、`sidecar.test.ts` +5
- **反向验证 4 处全红**：去掉 well-known 兜底 ⇒ 5F / 配置失效静默 ⇒ 2F / 无 bun 仍走 TS 入口 ⇒ 2F / 去掉 reconfigure 守卫 ⇒ 1F；还原后 `shasum -a 256 -c` 逐字一致
- 模拟 GUI 环境实测（`env -i`，见 §13.3.1）命中 `/opt/homebrew/bin/bun`

### 13.7 不做

- **不做 login shell 探测**（§13.4）
- **不做瘦入口 / `--minify`**：既然二进制不再随包分发，这两个只影响"要不要发二进制"时的体积，不是当前问题；要发时再按 §13.1 的表挑

---

## 附：本稿引用的关键位置

| 符号 | 位置 |
|---|---|
| `ChatResponseStream` / `ChatRequest` / `ChatParticipant` / `ChatResult` | `vscode.d.ts`（main，2026-10-01 下载核对）：19910 / 19855 / 19788 / 19696 |
| `LanguageModelTool` / `LanguageModelToolConfirmationMessages` / `lm.invokeTool` | `vscode.d.ts`：21161 / 21184 / lm 命名空间 |
| `AgentStreamEvent` 联合 | `packages/core/src/index.ts:660` |
| `host.sendStream` | `packages/host/src/host.ts:1307` |
| `host.notices` 环形缓冲 | `packages/host/src/host.ts:284` |
| 权限四态接缝 | `packages/host/src/permission.ts:29/38/49/62` |
| 四态词汇表（A2A 侧） | `packages/a2a-server/src/mapping.ts:157/165/184/194` |
| `StreamAdapter`（事件合并口径） | `packages/a2a-server/src/mapping.ts:217` |
| `runA2aCli`（端点打印 / 端口 0 回填） | `packages/cli/src/index.ts:1922` |
| `host.permission.setAsker` 接线点 | `packages/a2a-server/src/server.ts:288` |
| CLI 斜杠命令全集 | `packages/cli/src/index.ts`（`/stats:1313` `/compact:1279` `/agent:1092` `/permission:1363` `/sessions:1036` `/model:1125` `/skills:1405`） |
