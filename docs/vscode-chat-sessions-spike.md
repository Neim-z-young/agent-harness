# VSCode 会话选择器 spike —— 真机病史与结论（归档）

> **状态：探针已拆除，本文是它的知识归档（2026-10-13 定格）。**
> 原 `spikes/vscode-chat-sessions/` 目录（未纳入 git 的一次性探针）已删除，四类修复已**移植进生产代码**
> （见下面的落点表）。本文保留的是"为什么这么写"——那些在真机上踩过、且**都会静默失败**的坑。
> 历史上它回答两个问题：① 能不能在 VSCode 原生「会话选择器 / Agent Sessions」里出现"本仓"这一项？
> ② 选中后能不能真的走到本仓 harness 后端？**都能**（Stable 1.141，2026-10-09 两次真机）。

## 0. 修复落点（本 spike 的产出都在这里了）

| 缺陷 | 真机症状 | 生产落点 |
|---|---|---|
| **D2** 只按 SSE 解帧 ⇒ 预流错误被吞成"0 帧静默成功" | 第二条消息"正常结束但什么都没有" | `adapters/vscode/src/transport/a2a.ts` 的 `send()`：按 **content-type** 分流 |
| **D1** 跨轮带 `taskId` | 同上（服务端 `-32004 TASK_TERMINAL`） | `adapters/vscode/src/participant.ts`：`turnMetadata()` + `readState()` 两处 |
| **E1** 授权弹窗无配额 | `ask` 模式下模型陷进"被拒 ⇒ 换工具再试"就狂弹（实测 8 次/54s） | 同上：`MAX_PERMISSION_PROMPTS = 8` |
| **E2** 轮数上限把待决授权**静默丢弃** | 任务永停 `INPUT_REQUIRED` ⇒ 该会话之后每条消息都被 `ConcurrentTaskError` 拒 | 同上：`pending` 提到循环外 + 轮末 `CancelTask` fail-safe |
| 服务端流式续接未发首事件 | 授权后 `-32004`，会话卡死 | `packages/a2a-server/src/executor.ts`（**已修：`805cee7`**） |

回归用例：`adapters/vscode/src/transport/a2a.test.ts`（2 条）、`adapters/vscode/src/participant.test.ts`（9 条）。

---

## 1. 选择器里怎么出现"本仓"这一项

| 判据 | 由什么决定 | 落点 |
|---|---|---|
| 选择器里出现这一项 | `package.json` 的 `contributes.chatSessions` + `chat.createChatSessionItemController` | `type: harness-spike` |
| 选中、发消息能拿到回复 | **`id === 会话类型` 的 ChatAgent**（`chat.createDynamicChatParticipant` 注册）—— **不是** `ChatSession.requestHandler`，见 §3 | extension 的 participant handler |
| 回复由本仓 harness 产出 | A2A 客户端（`src/harness/`，vendored）+ 装配 | spawn `harness a2a` → `SendStreamingMessage` → `mapA2aEvent` → `ChatResponseStream` |
| UI 是不是原生 chat | 平台决定，扩展只给条目 + 标准 `ChatResponseStream` | **不换皮**（见 §6） |

**不是**验证"切到 Codex / Claude Code 外部 CLI 当后端"——那要新增"执行后端"抽象（`docs/external-integration-plan.md` §9，本期不做）；最小可行 = 再实现一份 `HarnessTransport`。

## 2. proposed API 门槛（不先看这段会卡在"没反应"）

`chatSessionsProvider` 是 **proposed API**：不在 `vscode.d.ts` 里，必须①`package.json` 声明 `enabledApiProposals`；②把对应 `vscode.proposed.*.d.ts` 放进源码；③运行时放行。

第 3 条的判定取自 VS Code 源码 `extensionsProposedApi.ts`：

```ts
this._envEnablesProposedApiForAll =
    !_environmentService.isBuilt ||                                   // 从源码跑：全放行
    (_environmentService.isExtensionDevelopment && productService.quality !== 'stable') ||
    (this._envEnabledExtensions.size === 0 && Array.isArray(_environmentService.extensionEnabledProposedApi));
...
if (this._envEnablesProposedApiForAll || this._envEnabledExtensions.has(key)) { return; } // ← 这条**没有** quality 判断
if (!extension.isBuiltin && isNonEmptyArray(extension.enabledApiProposals)) {
    extension.enabledApiProposals = [];                                // 被静默清空 ⇒ API 调用全失效
}
```

**结论**：**Stable 也能用**，只要显式传 `--enable-proposed-api=<publisher>.<name>`（落进那个不带 stable 判断的分支）。
⚠️ `argv.json` 的 `enable-proposed-api` 在 Stable 有已知 issue ⇒ 用命令行 flag。

**类型依赖链（缺一个就 `TS2304`）**：`chatSessionsProvider` → `chatParticipantPrivate`（`ChatRequestTurn2` / `ChatResponseTurn2` 不在稳定 d.ts）→ `chatParticipantAdditions` → `languageModelThinkingPart`。拉 d.ts 时按报错往上补即可。

### 2b. 选择器里那一项是灰的 / 悬停「Upgrade to GitHub Copilot Pro」

**不是 proposed 没放行，也不是 bug** —— 是 VSCode 的会话类型可用性判定（`sessionTypeAvailability.ts`）：
贡献点已注册时，①有指向该类型的模型（BYOK）或 ②该类型 `supportsAutoModel` → 可用；否则 Free / Student 账号 ⇒ `UpgradeRequired`（灰 + 升级悬停）。

**根因**：`chatSessions[].supportsAutoModel` **默认 false**。**修法（1 行）**：贡献点里加 `"supportsAutoModel": true`（含义 = "本类型不绑定具体模型，用合成的 Auto 即可"）。

> 换个角度：**出灰态恰好证明链路前半段已经通了**（扩展激活了、贡献点注册了、条目出现在选择器里了）。

## 3. ★ 请求到底怎么路由（踩过坑，务必读）

**贡献会话里的请求不走 `ChatSession.requestHandler`，而是走"`id` 逐字等于会话类型 `type`"的 ChatAgent。**

```
chatWidget.sendRequest({ agentIdSilent: this._lockedAgent.id })   // 锁定的 agentId = chatSessions[].type
  → chatServiceImpl.sendRequestInternal
      silentAgent = options.agentIdSilent ? chatAgentService.getAgent(options.agentIdSilent) : undefined
      invokeAgent((silentAgent ?? defaultAgent).id, …)            // ★ 拿不到就 fallback 到默认 agent
```

- **必须存在一个 `id === type` 且带实现的 ChatAgent**，请求才会落到本仓；
- 否则 `getAgent(type) === undefined` ⇒ 退回**默认 Copilot agent** ⇒ 症状「**我们没回、却有模型在答**」。

两个反直觉的事实：
1. **`ChatSession.requestHandler` 是遗留字段** —— 全 `src/vs/workbench` 里**没有任何浏览器侧代码**调用它。
2. **注册该 agent 的唯一扩展侧入口是 chat participant**，且 id 必须与会话类型逐字相同：
   - `createChatParticipant(id, h)` → 要求 id **已有静态条目**，否则抛 `Unknown agent`；
   - `createDynamicChatParticipant(id, props, h)` → **无需预置条目**（spike 用的就是它）。

**分流表**（三条日志互斥）：

| 看到的行 | 含义 | 处置 |
|---|---|---|
| `participant handler: "…"` | ✅ 路由到本仓 agent | 正常 |
| 只有 `provideChatSessionContent` / `newChatSessionItemHandler`，聊天里却是**模型回答** | ❌ 没有 `id === type` 的 agent，fallback 到默认 Copilot agent | 检查 `createDynamicChatParticipant(SESSION_TYPE, …)` 的 id |
| 全都没有 | ❌ 请求去了别的会话 | 确认输入框所在会话类型是本仓项 |

## 4. 验收判据（看到什么算通过）

**M1 · 路由**：输出通道出现 `activate()` → `已注册动态 participant: id=…`；选择器里出现本仓项；发一句话后出现
`▶ turn` → `▶ send round=0` → `▶ 首帧到达` → `◀ turn 结束 outcome=done frames=N`。
> `▶` / `◀` 两组埋点是**无条件**的（不受 trace 门控）。**缺 `◀` 的那一轮就是卡住的那一轮。**

**M2 · 后端**：装配三行（`bun:` / `cwd` / `cliPath` / `runner`）中 `cliPath` 指向 `packages/cli/src/index.ts` ⇒ 走的是**当前工作树**；回复里出现 harness 才有的东西（工具 `progress`、harness 的报错文案）。

**跨轮**：同一会话接着发第二条 ⇒ 第二轮的 `▶ send` **必须 `ctx=<上一轮 contextId> task=-`**（`task` 为空是**要求**，见 §5.1）；若 `task=<uuid>` 且 `frames=0`，就是老坑复发。

## 5. 真机病史（三次卡死，全部已修）

### 5.1 跨轮「什么都不发生」——D1 + D2

**症状**：首轮好好答，**第二条消息发出去后没反应**（不是报错）。日志：`◀ turn 结束 outcome=done (+20ms frames=0)`；服务端**一条遥测都没有**（请求根本没进 harness）。

| # | 缺陷 | 机制 | 修法 |
|---|---|---|---|
| **D1** | 客户端把上一轮的 `taskId` 带进**新一轮** | `taskId` 只在「回答权限挂起」时成立；上一轮正常结束即终态 ⇒ 服务端按协议拒（`-32004 TASK_TERMINAL`，a2a-tck `CORE-SEND-002` 是 MUST） | 轮末 metadata **只写** `contextId`；`readState` **不回填** `taskId`。轮内续接仍走局部 state |
| **D2** | 只按 SSE 解帧，**吞掉**预流错误 | 预流错误走 `serverErrorResponse` → `Response.json(…)`，即 **HTTP 200 + `application/json`**；`SseDecoder` 解出 **0 帧** ⇒ for-await 一次循环体都不进 ⇒ `outcome=done` | `send()` 按 **`content-type`** 分流：非 `text/event-stream` 就 `JSON.parse` 后 `yield`，交给 `mapA2aEvent` 翻成 `kind:'error'` |

**判据必须是 content-type，不能是状态码 —— 上述所有情形 HTTP 状态码都是 200。**

真机三轮对照：

| 轮次 | 请求 | HTTP | content-type | 耗时 | 客户端帧数 |
|---|---|---|---|---|---|
| ① 首轮 | 不带 id | 200 | `text/event-stream` | 1402ms | 5 ✅ |
| ② 带上一轮 `taskId` | ctx + task | 200 | **`application/json`** | **+5ms** | 旧口径 **0 帧** / 新口径 **1 帧 `error -32004`** |
| ③ 只带 `contextId` | ctx only | 200 | `text/event-stream` | 497ms | 5 ✅（`contextId` 与 ① 相同 ⇒ 会话延续） |

### 5.2 权限续接整体不可用（已修 `805cee7`，缺陷在服务端）

**症状**：Agent 要调工具时弹四态授权框，选完「允许一次」⇒ `❌ Received statusUpdate before initial 'Message'/'Task' event.（code -32004）`，**任务永远停在 `INPUT_REQUIRED`**，且此后**每条消息都被拒**（挂起任务仍算"活跃"）。

**根因**：`packages/a2a-server/src/executor.ts` 的续接分支只调 `resume()`（唤醒第一轮那个挂在**旧 bus** 上的生成器），新 bus 一个事件都不发；SDK 的 `ResultManager` 要求每个响应的**首事件是 `Task`/`Message`** ⇒ 随后到的 `statusUpdate` 被判违规。

**修法**：`resume()` 前补 `if (ctx.task) bus.publish(AgentEvent.task(ctx.task))`。

> **为什么单测长期隐身**：非流式 `SendMessage` 恰好绕过该硬要求（直接取终态快照），而既有用例的续接场景全走 `send()` ⇒ `streamSend()` **从没测过续接轮**。**新增覆盖时先问"这条路径有没有第二种传输形态"。**
> 真机 A/B：`SendStreamingMessage` ❌ / `SendMessage` 非流式 ✅ / 补首事件后再走流式 ✅。
> **不要"改客户端用非流式"绕路** —— 那会失去授权后的流式进度，还让副本多一处分叉。

### 5.3 授权弹窗风暴 + 轮数上限静默丢弃待决请求 —— E1 + E2

**症状**：第二轮真机又卡死。`ask` 模式下**模型每调一次工具 = 一次授权询问**，模型陷进"被拒 ⇒ 换工具再试"就狂弹（实测 8 次/54s）；更严重的是 `pending` 原先声明在权限循环**内部**、轮数上限是硬退出 ⇒ 第 N 轮的授权请求被**静默丢弃**。

**后果**：任务永停 `INPUT_REQUIRED`，且它仍算"活跃" ⇒ 该 `contextId` 之后**每条消息**都被 `ConcurrentTaskError` 拒。
**挂起 TTL 救不了**：超时只置 `running.expired` + warn，**不改任务状态**（实测 5 分钟后仍 `INPUT_REQUIRED`）。

**修法**：把"弹窗配额"与"整轮轮数"拆成两个常量（`MAX_PERMISSION_PROMPTS = 8` / `MAX_PERMISSION_ROUNDS = 40`）；`pending` 提到循环外；超配额自动 `deny`（**仍走同一轮续接** ⇒ 模型看得见拒绝，不是丢请求）；到顶发 `CancelTask` 收尾。
**★ 铁律：任何退出路径都不得留下未答复的授权请求。**

> **`CancelTask` 已验证能解卡**：`TASK_STATE_CANCELED` → `telemetry.permission.deny` → `telemetry.turn.end` → 会话落盘
> ⇒ `execute()` 走到 `finally`、`running` 释放。修好之前，任何一次授权失败都等价于**会话报废**。

> **移植时发现的一处口径（原探针版本没有做对）**：`pending` 必须在"已经用 CancelTask 答复过"的分支里
> **清掉**，否则轮末 fail-safe 会**再发一次** `CancelTask`，并把"用户主动取消"误报成
> "连续 N 轮授权询问仍未结束"。fail-safe 的语义是"轮数用尽仍待决"，只该在那一种情形下触发
> （回归用例：`participant.test.ts` 的「授权被拒 ⇒ 立刻 CancelTask 收尾，不再续接」）。

> **回归排查法（值得复用）**：`settleByTaskId` 的接管条件是 `lastObservedState === undefined`，
> **任何新增事件都可能改变它**；SDK 默认 `keepBusAliveStates` 含 `TASK_STATE_INPUT_REQUIRED`
> ⇒ 发过 task 快照后走"保活"分支，**bus 照样不结算**（所以补发首事件不会引入回归）。

## 6. 已知边界（当初就没假装没有）

- **UI 不换皮**；**Agents 窗口进不去**（官方只支持 Copilot CLI / Cloud / Claude，第三方/本地 agent 回主窗口）。
- **API 不稳定**（proposed 随时可能改）；**不能上 Marketplace**（只能 VSIX 私下分发）。
- **真的会调模型（花钱）**：sidecar 读本机 `~/.harness` 配置。
- **`history` 仍为空**：会话面板看不到历史（可用 harness `/sessions` 填充）；但多轮上下文是通的（`contextId` 续接）。
- **不支持 A2A 的 `AUTH_REQUIRED` 中断态**：明确报错而不是静默结束（与 `adapters/vscode` 同口径）。
- **斜杠命令未接**：`/agent` `/help` `/compact` 会被当普通文本发给模型。

## 7. 下一步（"够不够格做正式形态"仍待定）

1. `provideChatSessionContent` 填 `history`（用 `harness/session.list` + 历史）；
2. 把 `adapters/vscode` 的斜杠命令接进来（`chatSessions[].capabilities.commands`）；
3. 多会话隔离（去掉进程内 `lastContextId` 兜底，改成会话 URI ↔ `contextId` 映射）；
4. **先定**：这条 proposed 路线是否值得作为正式形态（代价见 §6），还是继续用 stable 的 `chatParticipants`。
