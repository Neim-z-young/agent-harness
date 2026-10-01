# Agent Harness 开发日志

## 2026-10-01（续 238）A2A P1 外部验收：官方 `a2a-tck` 五轮收敛 —— 5 处互操作缺陷 + 零真实遗留

### 做什么

P1 的验收口径最后一格是「用官方 `a2a-inspector` / `a2a-tck` 跑通同一序列」（plan §6）。本仓自测（`server.test.ts`）已覆盖该序列，这一步是**外部**复核：把 `harness a2a` 起成真 SUT，用官方 TCK（`a2aproject/a2a-tck`，Python + uv，规格版本 **A2A v1.0.0**）从 `{sut}/.well-known/agent-card.json` 取卡后全量打。

- `a2a-inspector` 是**浏览器 UI**，本环境无头、未跑；等价能力由 TCK 的 agent-card 用例组 + 手工 curl 取卡覆盖。
- 结论：**跑通**。终轮 `5 failed / 74 passed / 186 skipped`，**剩余 5 条全部是"参考 SUT 字面量断言"**（见下），**零真实协议缺陷遗留**。

### 环境坑（先把 SUT 起稳，否则全是假阳性）

两条叠加，把首轮放大成 **254 条 error（全 `502 Bad Gateway`）**：

1. **后台进程随命令回收** —— Bash 里 `nohup … &` 起的 SUT 在该条命令结束时被一并收回，TCK 打过去全是连接失败。修：用 `run_in_background: true` + `exec` 常驻。
2. **沙箱代理劫持 `127.0.0.1`** —— shell 里有 `HTTP_PROXY=http://127.0.0.1:62038`，任何对本机回环的 HTTP 都被代理吞掉、统一回 **502**（不是连接被拒，更像"服务在但返 502"，极易误判成 SUT bug）。修：TCK 侧 `export NO_PROXY="127.0.0.1,localhost"`（curl 侧 `--noproxy '*'`）。

### 五轮收敛曲线（每轮只修一类根因）

| 轮次 | 结果 | 当轮暴露的根因 |
|---|---|---|
| 首轮 | `4 failed, 4 passed, 254 errors` | 代理 502 + 进程回收（环境） |
| 第 2 轮 | `64 failed, 18 passed, 177 skipped, 6 errors` | **尾斜杠 404** ⇒ 一个斜杠级联成全轮崩盘 |
| 第 3 轮 | `14 failed, 61 passed, 190 skipped` | 修尾斜杠后暴露真问题：幂等回放信封 + 惰性流吞错 |
| 第 4 轮 | `11 failed, 68 passed, 186 skipped` | 修回放 + 预热后，**新暴露 2 条 MUST**（终态 / MISMATCH 被回放掩盖） |
| 第 5 轮 | `9 failed, 70 passed, 186 skipped` | 终态/MISMATCH 修完，卡片缓存头前的中间态 |
| **终轮** | **`5 failed, 74 passed, 186 skipped`** | **剩 5 条全是参考 SUT 字面量断言** |

兼容性数字（`reports/compatibility.json`）：`overall 69.2%` / `must 70.4%` / `should 42.9%` / `may 100.0%`。
逐条分布（更权威，共 129 条需求）：`MUST PASS 57 / FAIL 2 / SKIPPED 33 / NOT TESTED 22`；`SHOULD PASS 3 / SKIPPED 4 / NOT TESTED 4`；`MAY PASS 3 / SKIPPED 1`。

### 五处互操作缺陷（全部是"本仓自测覆盖不到、只有真客户端才暴露"的）

1. **尾斜杠互操作（`normalizePath`）** —— TCK 的 `JsonRpcClient` 用 `httpx.Client(base_url=interface.url)`，httpx 会把 `base_url` 规范成**带尾斜杠**（`/a2a` → `/a2a/`），再 `post("/")` ⇒ 实际请求 `POST /a2a/`。我们只做精确路径匹配 ⇒ 404 + **非 JSON 体** ⇒ 客户端 `response.json()` 抛 `JSONDecodeError`，**不落进它自己的 `except httpx.HTTPError`** ⇒ 一个尾斜杠放大成 64 failed。修：`normalizePath()` 剥尾斜杠，JSON-RPC 路由与卡路由都过它。**教训：服务端对"路径等价类"的容忍度，是互操作的一部分，不是洁癖。**
2. **幂等回放的"信封"**（`CORE-EXECUTION-MODE-001/002`、`JSONRPC-SSE-001`） —— 重复 `messageId` 时我们直接透传 `GetTask` 的**裸 Task**，但 `SendMessage` / `SendStreamingMessage` 的 `result` 必须是 `{task}` **信封**（`Task` 字段裸放 ⇒ 对端按 `SendMessageResponse` 校验报 `additional properties are not allowed`）。修：`replay()` 统一包一层（非流式 `{result:{task}}`；流式走 `once()` 生成器，帧同样是 `StreamResponse`）。**同一个 Task 对象，`GetTask` 出裸体、`SendMessage` 出信封 —— 这是 SDK 出参形态的差异，不能"顺手复用"。**
3. **SDK 的流是惰性的 ⇒ 必须"预热首值"**（`STREAM-SUB-004`） —— `sendMessageStream` / `resubscribe` 返回生成器，参数或任务非法时异常要到**第一次 `next()`** 才抛。我们已提前回了 `text/event-stream` 头 ⇒ 客户端收到 **200 空体**，`TaskNotFoundError` 被吞。修：流式分支先 `await iterator.next()` **预热**，预流抛错 ⇒ 回**普通 JSON-RPC error（200 + application/json）**；只在已提交 SSE 之后的**中途错误**才 `formatSSEErrorEvent` 写 `event: error` 帧（`sseBody` 里补上，此前 `finally { close() }` 把错误静默丢弃）。这正是 SDK 自带 express 宿主的做法。
4. **带 `taskId` 的守卫要按协议判定，不能一律回放**（`CORE-SEND-002`、`CORE-MULTI-006`，修完 3 之后才暴露） —— 此前的逻辑是"带 `taskId` 且挂起表里没有 ⇒ 一律回放快照、不报错"，把两件 **MUST 要报错**的事**掩盖成成功**：① 给**终态任务**发消息（协议 MUST 报 `UnsupportedOperationError` = `-32004`）；② `taskId` 与 `contextId` 不匹配（MUST 报 `-32602`）。修：改成先 `taskStore.load()` 取真实状态 → `isTerminalState()` ⇒ `TASK_TERMINAL`；`contextId` 与任务既有 `contextId` 不符 ⇒ `CONTEXT_TASK_MISMATCH`；只有两者都过才回放。配套新增 `TaskTerminalError` / `ContextTaskMismatchError`（`errors.ts`）。**注意 `INPUT_REQUIRED`（6）/ `AUTH_REQUIRED` 是"中断态"不是终态** —— 反面保险用例专门钉住"中断态续接照常放行"，否则会把正常续接一起杀。
5. **卡片缓存头 + 条件请求**（`CARD-CACHE-001/002/003`，SHOULD/MAY） —— 协议 §8.6.1：卡片端点 SHOULD 带 `Cache-Control`（含 `max-age`）/ `ETag`、MAY 带 `Last-Modified`，并支持条件请求回 `304`。修：`Cache-Control: public, max-age=300` + `ETag`（对**实际响应字节**取 sha256，base64url 截 27 位）+ `Last-Modified`；`If-None-Match` / `If-Modified-Since` 命中 → `304`（头照带）。

### 反向验证（证明 5 处不是装饰）

每处修复都做了"回退变红"，**还原后 `diff -q` 逐字一致**：

| 摘掉/改坏 | 变红条数 |
|---|---|
| 摘 `normalizePath` | 1 fail |
| 回放透传裸 Task | 2 fail |
| 不预热首值 | 1 fail |
| 去掉卡片缓存头 | 1 fail |
| `isTerminalState` 恒 `false` | 2 fail |

### 剩余 5 条 FAIL 的归因（**均为 TCK 的"参考 SUT 特化"断言，非协议要求**）

- `DM-ART-001`：断言 artifact 字面量 —— 文本必须是 `'Generated text content'`、文件部分 filename 必须是 `'output.txt'`、还要有 file/data part（`{'key':'value','count':42}`）。这是 TCK 内置参考 SUT 的固定产出，**协议不要求**具体内容。
- `DM-MSG-001`：**强制要求 `SendMessage` 返回 `Message`**，而协议**允许返回 `Task`**。我们返回 `Task`（正确的 A2A 语义）。

`SKIPPED` 主要是未声明 gRPC / HTTP+JSON 传输、未声明 push notification（TCK 据此跳过）；`NOT TESTED` 是 TCK 自己没挂上测试。**故"零真实缺陷遗留"。**

### 产物与验证

改动文件：`packages/a2a-server/src/server.ts`（`normalizePath` / `sseBody` 补 error 帧 + `once()` / `replay()` 信封 / 流式预热首值 / 终态与 MISMATCH 守卫 + `isTerminalState` / 卡片缓存头与 304）、`packages/a2a-server/src/errors.ts`（`TASK_TERMINAL` / `CONTEXT_TASK_MISMATCH` + 两个错误类）、`packages/a2a-server/src/server.test.ts`（**18 → 25 条**：新增尾斜杠容忍 / 回放信封 / 流式回放 / 订阅不存在 / 卡片缓存与 304 / 终态 / MISMATCH / 中断态反面保险共 8 条，**改写 1 条** —— 旧"迟到答复 ⇒ 回放快照、不报错"改为"⇒ 任务已终态、结构化拒绝"）。

验证：`bun run typecheck` **41 包 exit 0**；`@harness/a2a-server` **70 pass / 0 fail**（63 → 70，+7）；`bun run test` **2265 pass / 0 fail / 99 文件 / 41 包 exit 0**（较 P1-D 的 2258 增 7 条）。

证据文件（`reference/` 已 gitignore，不入库）：`reference/a2a-tck/reports/compatibility.{json,html}`、`reports/tck_report.html`、`reports/junitreport.xml`。

## 2026-10-01（续 237）A2A P1-D：`harness a2a` 子命令（P1 收口）

### 做什么

给 P1-C 的服务端一个**可用的入口**：`harness a2a [--port <n>] [--token <t>]`。

- `CliArgs` 加 `'a2a'` 命令 + `a2aPort` / `a2aToken`；`parseCliArgs` 识别 `a2a` 与 `--port` / `--token`；`main` 在 `teammate` 之后分派 `runA2aCli`；`HELP_TEXT` 补用法与选项块。
- `runA2aCli` **复用 `createHost` 而不是 `HarnessApp`**：A2A 是**无终端**宿主，`HarnessApp` 多带的两个终端适配面（`stdout → onNotice`、`askPrompt → asker`）在这里没意义，用它会把"装配"与"终端形态"重新绑回一起。装配期诊断经 `onNotice → stderr`，stdout 只留服务启动信息（脚本可消费）。
- 端口校验（0~65535 整数）；`SIGINT` / `SIGTERM` 优雅停止（`server.stop(true)` 释放 executor 的挂起与任务）。
- 权限模式默认 `ask`（远程权限点应挂起、等客户端答复）；`allow-all` / `deny-all` 会短路、**不产生挂起** —— help 里已标明，这是"信任调用方"的主动选择，不是默认。
- **CLI 侧不传 `asker`**：`createA2aServer` 会把 executor 的 asker 装回 host 的权限引擎，CLI 再传就是两份装配抢同一个接缝。
- `@harness/a2a-server` barrel 转出 `AGENT_CARD_PATH`（协议常量取自 SDK）⇒ CLI / 文档不必直接依赖 SDK。

### 冒烟（真起服务，不只是单测）

`harness a2a --port 4501 -p mock -d <tmp>` → 取卡 `protocolVersion=1.0` / `protocolBinding=JSONRPC`；
`SendMessage("hello")` 返回 `TASK_STATE_COMPLETED` + artifact `(Mock Provider) 你好，我是测试助手。`；
`SIGINT` 打印"正在停止"后进程退出。

### 产物与验证

改动文件：`packages/cli/src/index.ts`（CliArgs / parseCliArgs / HELP_TEXT / `runA2aCli`）、`packages/cli/src/cli.test.ts`（a2a 用例 + HELP_TEXT 断言）、`packages/a2a-server/src/index.ts`（转出 `AGENT_CARD_PATH`）。

验证：`bun run typecheck` **41 包 exit 0**；`bun test ./packages` **2258 pass / 0 fail / 99 文件**。**P1 全部落地。**

## 2026-10-01（续 236）A2A P1-C：HTTP/SSE 服务端宿主 —— 两个"不接线就静默失效"的坑

### 做什么

`createA2aServer`：把 `@harness/host` 的装配挂到 `Bun.serve` 上（plan §3）。只做**路由与协议**，任务生命周期归 `executor.ts`。

- 路由：`GET /.well-known/agent-card.json` → `cardToJSON(card)`；`POST /a2a` → JSON-RPC。
- **SSE**：`SendStreamingMessage` 返回 `AsyncGenerator` ⇒ 自己用 `formatSSEEvent` + `SSE_HEADERS` 写 `ReadableStream`（SDK 只管分帧函数，不管 HTTP）。
- **三处"宿主必须自己做"的**（SDK 不做）：① 版本校验（头缺失时 `requestedVersion` 默认 `'0.3'` ⇒ 卡片只声明 `1.0` 时必然被拒，正是我们要的）；② 认证（transport 不认识 `Authorization`）；③ 并发 / 幂等 / 隔离。
- `auth.ts`：`verifyBearer` / `callerKey` / **`CallerRegistry`**（`contextId → 调用方` 归属绑定 —— `contextId` 就是 `sessionId`，**会读写同一份会话历史与工作目录状态**，别的调用方猜到它就能接上别人的会话）。
- 并发：同一 `contextId` 并行第二条**直接拒绝**（`CONCURRENT_TASK`，一期不排队），挂起中的任务也算活跃；全局上限 `TOO_MANY_TASKS`。
- 幂等：`messageId` 已执行完 ⇒ **回放任务快照**（走 GetTask，不重复执行）；仍在处理中 ⇒ `DUPLICATE_MESSAGE`（客户端应等待而非重试）。

### 坑 1：权限桥必须**接线**，否则挂起链路不启动

初跑 5 条失败（`INPUT_REQUIRED` 全退化成 `COMPLETED`）。根因：**host 由调用方在 `createA2aServer` 之前 boot，而 executor 只能建在 host 之后**（它要 `getHost()`）⇒ host 的权限引擎在 boot 时拿不到 A2A 的 asker，`ask()` 走默认 deny。

修：`createA2aServer` 里 `host.permission.setAsker(executor.asker)` —— 这正是 `InteractivePermissionEngine.setAsker` 存在的场景（TUI 也用它启动后注入模态审批）。**CLI 侧不要再传 `asker`**，否则两份装配抢同一个接缝。

### 坑 2：续接请求会**误杀共享事件总线**（spike 靠微任务次序侥幸躲过）

续接请求的 executor **不发任何事件就返回**，SDK 因此观察到 `lastObservedState === undefined` ⇒ `_settleBus` 默认策略**立刻 `bus.finished()` + 清理这条共享 bus**。可第一轮此刻仍在跑（它随后要往**同一条** bus 上补发 artifact + 终态）⇒ 事件全丢，续接请求报 `Agent execution finished without a result`。

P0.5 spike 没暴露它，只因 spike 的第一轮在 `resolve()` 之后**同步**续跑（同一条微任务链上先于续接请求的 `.finally`）；真实 harness 的第一轮要走 LLM（多个 `await`），次序正好反过来。

修：自定义 `EventBusManager.settleByTaskId` —— **判据是"任务还在跑"而不是"这条请求发了事件"**：`lastObservedState === undefined` 且 `executor.isRunning(taskId)` ⇒ 接管（返回 `true`，不结束），等第一轮收尾时再走常规结算。

配套：**只有"确实挂着一个待决询问"的续接请求才放行进 executor**（`taskId && !executor.suspend.has(taskId)` ⇒ 回放快照）。否则迟到 / 重复的答复会走到"executor 不发事件"的悬挂路径。

### 反向验证（证明这两处不是装饰）

1. 摘掉 `host.permission.setAsker(...)` ⇒ **5 条失败**（全部是权限挂起相关）。
2. 摘掉 `settleByTaskId` 的接管（恒 `return false`）⇒ **3 条失败**（续接 / 迟到答复）。
3. 还原 ⇒ 18 条全绿。两处均已执行并还原（文件与还原前逐字一致）。

### 产物与验证

改动文件：`packages/a2a-server/src/{server,auth,server.test}.ts`（新建）、`{errors,executor,index}.ts`（补码 / `isRunning` / barrel）。

验证：`bun run typecheck` **41 包 exit 0**；`bun test ./packages` **2257 pass / 0 fail / 99 文件**（2239 + 18：卡路由 / SSE / 版本 / 认证 / INPUT_REQUIRED 续接 / 并发拒绝 / 幂等回放 / 调用方隔离）。

## 2026-10-01（续 234）A2A P1-B：`HarnessAgentExecutor` + 挂起表 + 权限桥 —— 权限链路的触发条件是个坑

### 做什么

P1 的第二步：把 `@harness/host` 的流式会话翻译成 A2A 的**任务生命周期**，并落地远程权限的挂起/续接机制。

- `executor.ts` — `HarnessAgentExecutor implements AgentExecutor`。`execute(ctx, bus)`：续接轮（`task.status.state === INPUT_REQUIRED`）直接走 `resume` 并 return；新任务则发 `task(SUBMITTED)` → `statusUpdate(WORKING)` → 在 `AsyncLocalStorage.run({taskId,contextId,bus,running})` 里 `ensureSession` + 遍历 `host.harness.session.promptStream(...)`，把流事件喂给 `StreamAdapter` 合并成 A2A 事件。`cancelTask` 走 `controller.abort()` + `suspendTable.cancel()`。终态裁决 `finalize`：`canceled > expired > aborted > COMPLETED`。
- `suspend.ts` — `SuspendTable`：`taskId → resolver` 的挂起表，带 TTL（默认 5 分钟）+ `onSuspend`（登记后**同步**发 `INPUT_REQUIRED`）+ `onExpire`。`answer()`/`cancel()` 命中不存在时返回 `false`，调用方据**安全忽略**（幂等，plan §3.4 要点 3）。
- `errors.ts` — `A2aServerError`（带 `code` / `detail` / `jsonRpcCode` / `toJsonRpc()`）+ `ConcurrentTaskError` / `UnauthorizedError`（-32001）/ `ContextForbiddenError`。

### 为什么权限桥必须用 `AsyncLocalStorage`

`ask()` 发生在 `promptStream` 生成器**内部**，它只认得 `toolKey`/`patterns` —— 不知道自己是哪个 task、往哪条 bus 发 `INPUT_REQUIRED`。模块级可变变量在**并发两条任务**下必然串话（两条生成器的 `await` 交错）。`AsyncLocalStorage`（`node:async_hooks`）按**异步调用链**隔离：实测（`/tmp/als-probe.ts`）跨 `await` 保持，并发任务互不串话（`A: ["task-A","task-A"] B: ["task-B","task-B"]`）。

### 模式 A：`INPUT_REQUIRED` 之后**不返回**

executor 在挂起时**不 return**，`await` 答复 ⇒ 挂起表只需 `taskId → resolver`，**不必跨请求保存/恢复 generator**。后续带同一 `taskId` 的 `SendMessage` 会**再次调用 `execute`**（此时 `ctx.task.status.state === INPUT_REQUIRED`），把答复喂给 resolver 后**立即 return**，第一轮被唤醒后补发 artifact + 终态。代价：executor 的 Promise 长期悬挂 ⇒ **TTL 是必需项，不是锦上添花**（无 TTL 时挂起表与 task 记录一起泄漏）。

### ⚠️ 最大的坑：权限询问的**触发条件**

12 条测试初跑 **3 pass / 9 fail**，6 条 `waitUntil 超时`（`suspend.size === 1` 从未成立）。根因不是 executor、也不是挂起表 —— 是**权限点根本没被触达**：

权限询问**不是"工具一执行就自动弹"**。`ToolPipeline.execute` 只在**工具声明了 `permission: { key, extractPatterns }` 且 pipeline 有 `checkPermission`** 时才构造 `PermissionRequest` 去问引擎（`packages/tool/src/index.ts:1330`）。测试夹具的 `echo` 工具**没声明 `permission`** ⇒ `check → ask → asker → 挂起` 整条链路**根本不启动**，任务直接 COMPLETED。

修法：给夹具工具补上与真实工具同形的 `permission: { key: 'echo', extractPatterns: (input) => [input.msg] }`。`isReadOnly` **不影响**权限（它只参与白名单展开），所以只读工具照样要声明 `permission`。

### 另一处断言修正：`SUBMITTED` 挂在 `task` 事件本体上

`statuses(events)[0]` 期望 `SUBMITTED` 实收 `WORKING` —— 因为 `SUBMITTED` 在 **`task` 事件本体**的 `data.status.state` 里（SDK 的 `ResultManager` 据此建任务记录），不是一条独立 `statusUpdate`。断言改为 `events[0].data.status.state === SUBMITTED` + `statuses(events)[0] === WORKING`。

### 产物与验证

改动文件：`packages/a2a-server/src/{executor,suspend,errors}.ts`（新建）、`packages/a2a-server/src/executor.test.ts`（新建 12 条）、`packages/a2a-server/src/index.ts`（barrel 补 errors/suspend/executor 导出）。

验证：`bun run typecheck` **41 包 exit 0**；`bun test ./packages` **2239 pass / 0 fail / 98 文件**（2227 + 12）。**P1-B 完成。**

## 2026-10-01（续 233）A2A P1-A：新包 `@harness/a2a-server` 骨架 + AgentCard + 协议映射层

### 做什么

按 `docs/external-integration-plan.md` §6 的依赖顺序开工 P1 第一步。新包定位是**宿主/适配器层**（与 `@harness/cli` 同级，**不是**业务能力插件）—— 只做协议翻译与装配，不内置业务决策、不绕过权限、不直接调工具。

- `mapping.ts`（约 400 行，纯映射、零 IO）——`Part`/`Message` 双向构造与解析、`stateName`/`stateFromName`（**不写状态字面量**）、四态权限词汇表（**直接复用 host 的 `PermissionAnswer`，不做第二套翻译**）、`buildPermissionMetadata`/`buildPermissionQuestion`，以及 `StreamAdapter`（`text_delta`/`reasoning_delta` 按块合并；`reasoning_delta` 不进 artifact；tool/gate → `WORKING` + metadata）。
- `card.ts`（约 170 行）——`buildAgentCard`（顶层 `version` = agent 自身版本；协议版本只写 `supportedInterfaces[].protocolVersion`；默认只暴露 `mode:'primary'`；配 token 才同时给 `securitySchemes` + `securityRequirements`）+ `cardToJSON`。
- `errors.ts` 的结构化错误码（本步先落盘，P1-B 用）。

### 三个静默失败坑（P0.5 spike 实测 + 本步复核）

1. **Part/Message 有两套表示**：TS 内部是 `content: {$case:'text', value}`，线上是 `{"text":"..."}`。出参必须走 `MessageFns.toJSON()`，裸 `JSON.stringify` 会让对端 `fromJSON` **静默丢掉内容**。
2. **`TaskState` 是数字 enum**：`TASK_STATE_COMPLETED === 3`，线上是 `"TASK_STATE_COMPLETED"` ⇒ 比较一律走 `taskStateToJSON`，不写字面量。
3. **`Role` 也是数字 enum**（本步新发现）：`ROLE_USER === 1`，线上才是 `"ROLE_USER"`。
4. **`AgentCard` 必须走 `AgentCard.toJSON()`**（本步新发现）：`securitySchemes[*].scheme` 是判别式联合 `{$case, value}`，裸序列化输出 `{$case,value}` 而线上是 `{httpAuthSecurityScheme:{…}}` ⇒ 客户端 `fromJSON` **静默丢掉整个安全方案**。P0.5 spike 用 `securitySchemes: {}` 恰好绕过，故此前没暴露。新增 `cardToJSON()` 并加反向守卫用例（同时断言裸序列化**确实**丢掉 `httpAuthSecurityScheme`）。

### 权限接缝的一处补漏

`mapping.ts` 需要 `PermissionAskInput`，但 `@harness/host` 的权限接缝 type 转出块**只导出了 `PermissionAsker`** ⇒ 补上 `PermissionAskInput`。

### 新包登记（AGENTS.md 硬约定，逐项齐）

root `tsconfig.json` paths（`"@harness/a2a-server": ["./packages/a2a-server/src"]`）、root `package.json` dependencies、`packages/cli/package.json` dependencies、`bun install`（`@a2a-js/sdk@1.3.0` 钉死，已在 bun 缓存，离线可装）。

### 产物与验证

改动文件：`packages/a2a-server/{package.json,tsconfig.json,src/{index,mapping,card,errors}.ts}`（新建）、`packages/host/src/index.ts`（补 `PermissionAskInput` 转出）、root `tsconfig.json` / `package.json`、`packages/cli/package.json`、`bun.lock`。测试：`mapping.test.ts`（20 条）+ `card.test.ts`（13 条）。

验证：`bun run typecheck` **41 包 exit 0**；`bun test ./packages` **2227 pass / 0 fail / 97 文件**。commit `7590abc`。

## 2026-10-01（续 232）P0 收尾 S4：测试收口「能力归 host，兼容归 cli」—— 顺带补齐 host 自测缺口

### 背景：这份「有意重叠」本来就登记着要收

P0 分步搬迁时，为了让"CLI 导出面逐字不变"这条约定有据可依，`cli.test.ts` / `provider-model.test.ts`
里**原样保留**了一份与 host 同能力的用例。计划 §5 当时就写明：「两处的重叠是**有意的**，待第二步搬
`boot` 时统一收口去重」。S2-③ 把 `boot` 搬完之后，这一步（S4）就到期了。

先摸清重叠面：host 侧 6 个文件 **89 条**是搬迁时按"能力归属"新建的 canonical 用例；cli 侧存在同
覆盖。口径按一条原则定：**能力测试只留 host 一份，cli 只留「re-export 兼容」+「CLI 专属」**。

### ① 删掉的 24 条重复（同一符号两侧都有覆盖）

| 位置 | 删除 | host 侧对应 |
|---|---|---|
| `cli.test.ts` `ProviderTypeRegistry / 插件化扩展` | `loadPluginDirs` 9 条 + `registerBuiltinProviderTypes` 6 类型 + `listMeta` + `BuiltinPluginRegistry` + `BuiltinToolRegistry` L1 | `load-plugin-dirs.test.ts` / `builtin-registry.test.ts` |
| `cli.test.ts` `内置插件声明式启用` | `resolveBuiltinPlugins` 依赖闭包/去重/coordinator + `unknownBuiltinPluginIds`（4 条） | `builtin-registry.test.ts` |
| `cli.test.ts` `配置校验` | `resolveContextWindowTokens` + `buildProviderWindowTable`（2 条） | `config-window.test.ts` |
| `cli.test.ts` `CliPermissionEngine` | allow-all / deny-all / getMode-setMode（3 条模式短路） | `permission.test.ts` |
| `provider-model.test.ts` | `normalizeProviderConfigs` / `sanitizeProviderId` / `checkProviderConfigs` 整个 describe（8 条） | `config-window.test.ts` |

### ② 从「只有 cli 覆盖」移回 host 的 3 处（host 拥有该能力，只能搬不能删）

`resolveCompactionWindow`、`buildCompactionOptions`（→ `config-window.test.ts`）、
`loadPluginDirs` 相对路径导入失败（→ `load-plugin-dirs.test.ts`）。删前先把 `provider-model` 里
2 条**独有用例**（同模型多实例保留各自 baseUrl、显式 id 与派生 id 不冲突）并入 host，避免删出覆盖洞。

### ③ 换成一条 re-export 兼容断言

`cli.test.ts` 新增 describe：逐个断言 35 个上移符号从 `@harness/cli` 与从 `@harness/host` 取到的
是**同一个引用**。这把"导出面不变"从"靠 24 条行为用例顺带守着"变成一条直指的断言 —— 而且它钉的
比 24 条更强：**是同一个函数，不是重新包一层**。（补充：任一条 re-export 被删，`cli.test.ts` 的
静态 import 会先以 `SyntaxError` 报错 —— 两层保护都在。）

### ④ 刻意保留在 cli 的

presentation（`formatProviderTypeList` / `buildProviderTypesSection`）、`parseCliArgs`、
`CliPermissionEngine` 的 `askPrompt → 四态` 映射、provider 包工厂契约、boot 预加载集成、
REPL `/tools`、日志 sink、ACP 装配**源码守卫**，以及跨包一致性守卫（`resolveCompactionWindow`
与 `acp-context.lookupProviderWindow` 对照）。

### ⑤ 一处刻意不动的残留（不是"重叠"）

`provider-model.test.ts` 里仍有若干 **host 拥有但只有 cli 覆盖**的直接函数用例（`resolveModelArg` /
`formatResolutionRef` / `formatApiKeyTag` / `findTokenOnlyDuplicates`），以及它们被 CLI 集成用例
当 helper 复用的部分。它们**不是"两侧都有一份"的重叠**，按"先不动"留待一次单独的**能力归位** ——
把直接函数用例搬进 host、集成用例留 cli。这条边界写进了设计稿 §9.5 ⑤，免得下次被当成漏网。

### 顺带修掉两处因删除而失效的行号引用

`notice.test.ts` 里「`cli.test.ts:1939` 钉的就是这条」与设计稿 §5 表里的 `:1939` / `:1027` / `:3185`
在删除后全部漂了（cli.test.ts 净删约 330 行）。**改成按用例名指认**（"boot「有未登记 id 时只告警」"
等）而不是行号 —— 行号是易失的，用例名才是稳定的锚点。另 `:1939` 断言现位于 `:1597`。

### 反向验证（证明收口后的用例不是装饰）

6. 把 `resolveCompactionWindow` 的端点查表摘掉（恒回 `fallback`）⇒ 刚移入 host 的两条用例失败
   （`resolveCompactionWindow`、`buildCompactionOptions` 各一条）。✅
7. 从 `cli/src/index.ts` 摘掉任一条 re-export ⇒ 模块加载即 `SyntaxError`（兼容断言也被触发）。✅

### 产物与验证

改动文件：`packages/host/src/{config-window,load-plugin-dirs,builtin-registry,notice}.test.ts`、
`packages/cli/src/{cli,provider-model}.test.ts`、`docs/host-extraction-design.md`（§4/§5/§9.4/§9.5）、
`docs/external-integration-plan.md`（P0 行 / §5 / §9 指针）、`AGENTS.md`（新增「测试归属」条）。

验证：`bun run typecheck` **40 包 exit 0**；`bun test ./packages` **2194 pass / 0 fail / 95 文件**
（2215 − 24 − 8 + 10 + 1 = 2194：host 89 → **99**、cli 429 → **398**）。**P0 收尾 S1–S4 全部落地。**

## 2026-10-01（续 231）P0 收尾 S2：`HarnessHost` 上移 + notice 全量接线 —— 顺带补掉一枚漏网 code

### 为什么这一步被拆成三个 commit

设计稿把这次改造写成"S2 一步"（搬 `HarnessApp` 主体 + 20 处改 `emitNotice` + `HarnessApp extends`）。
实测**一步搬不动**，根因是环：`host.ts` 要用 `loadPluginDirs` / `getBuiltinRegistry` /
`preloadBuiltinToolMetas` / `registerBuiltinProviderTypes` / `resolveBuiltinPlugins` —— 它们当时都定义在
`index.ts`。`host.ts` 若从 `./index` 取就形成 `host.ts → index.ts → host.ts` 的环，而本仓已明确回避
该形态（`./lazy.ts` 就是为此拆的）。⇒ 先做一步**纯搬移**把 A 档 + C 档抽成 `./plugins.ts`，
`index.ts` 退化为纯 barrel（688 → 125 行）。这一步零行为变化、单独验证成本极低 —— 属于"先拆环、再搬家"。

同时权限引擎是**构造期**依赖而非运行期依赖：`boot()` 里就 `new CliPermissionEngine(...)`，主体不先拿到
一个宿主无关的引擎就搬不走。⇒ 原 S3（权限接缝）实际前插为 **S2-②**，排在主体之前。于是实际序列是
S1 → S2-① 配置层 → S2-② 权限接缝 → S2-③ 前置（拆环）+ 主体 → S2-③ 补（漏网站点）。

### `createPermissionEngine` 覆写点的取舍

主体上移后 `app.permission` 若直接是 `InteractivePermissionEngine`，`tui.tsx:1515` 的
`setAskPrompt(...)` 就没有了（`cli.test.ts` 也依赖 `CliPermissionEngine` 这个导出）。两条路：
改 TUI 用 `setAsker(cliAsker(...))`（动 2 处 + 导出内部函数），或给 host 一个覆写点。选了后者 ——
`protected createPermissionEngine(rules, save, mode)`，CLI 覆写成返回 `CliPermissionEngine`，并用
`declare public permission: CliPermissionEngine` 窄化字段类型。**收益**：`tui.tsx` / `cli.test.ts` /
`CliPermissionEngine` 全部逐字未改，且四态语义依然只有一份（CLI 覆写的只是"用什么问"，不是
"问到之后怎么记"）。

### 四处**有意偏离**设计稿（每处都留痕在 §9.2）

1. **`type Host = HarnessHost`，不另立 interface**：设计稿写 `interface Host { …（56 成员） }` +
   `class HarnessHost implements Host`。那是把同一份 56 个成员写两遍（名称、签名、只读性各维护一次）
   —— 且漂移是**静默的**（interface 不会因 class 改了而报错）。`type` 别名让两者定义上同一。
2. **多补一个 `logLine?: (line: string) => void`**：设计稿只列了装配期的 `onNotice`，漏了**运行期**
   `emitLog` 的兜底出口。host 不再有 `stdout`，不补则运行期引擎 warn/error 在 headless 下无处可去。
   它与 `onNotice` 仍是**两条通道**（时机 / 内容 / 消费方都不同），不是合并。
3. **`anthropicProviderConfig?: any` 保留原类型**：设计稿写 `unknown`，但会把
   `this.options.anthropicProviderConfig?.apiKey` 与 `...spread` 逼出四处无谓 cast，收益为零。
   不为"更严"制造噪音。
4. **`stdout` 缺省落 `process.stdout`** + 多一个覆写点：`stdout ?? process.stdout` 是**搬迁前**的既有
   语义（`main()` 不传 stdout），不补就会让真 CLI 的装配诊断全部消失 —— 这是"零行为变化"判据要求的。

### 反向验证三连（证明 20 处输出**确实**走这条通道）

① 只摘 CLI 侧 `onNotice` ⇒ **仍通过**：`logLine` 兜底同字节 —— 这正是"两条出口不是两份事实"的
可执行证据。② 两条出口**同时**摘掉 ⇒ `boot：config.json → plugins 有未登记 id 时只告警` 报
`Received: ""`，文案用例失败 ⇒ 证明 20 处输出确实经过 `emitNotice`。③ **不给**任何输出出口 ⇒
文本丢失，但 `app.notices` 环形缓冲里仍能按 `code` 取回降级事实 ⇒ 固化为 `notices.test.ts` 的常驻
用例（治"静默丢弃"的正面断言）。

### 顺带补掉 S1 遗漏的漏网站点（+1 code）

`preloadBuiltinToolMetas` 用 `console.warn` 直写，既不走 `stdout` 也不走 `setLogSink` —— 是本轮唯一
"两个出口都不沾"的装配期诊断。S2-③ 补（`6dc4e69`）新增 code `preload.meta-source-failed`（`warn` 级），
与 `loadPluginDirs` 同形的 `onNotice?` 双出口。注意模板要**显式带结尾换行** —— 改造前那个 `\n` 是
`console.warn` 代劳的，sink 出口没有人代劳。code 总数 **22**。

### 一处守卫改址（不是改断言）

`cli.test.ts` 有一条读**源码文本**的防回归守卫（守 `acp.createAcpContextPlugin({...})` 必须传
`modelContextLimit` 与 `providerWindows`）。装配行随 `boot()` 搬进 `packages/host/src/host.ts`
⇒ 守卫改读 `../../host/src/host.ts`，**两条断言逐字未改**。这是本次改造唯一暴露的测试失败，
而它报的正是这个：**守卫必须跟着代码走**，否则"代码搬走了"会以"测试失败"的形式误报。
**教训：搬代码时务必搜一遍「读 `./index.ts` 源码」这类测试。**

### 产物

`packages/host/src/host.ts`（`HarnessHost` + `HostOptions` + `createHost()` + `type Host`）、
`plugins.ts`（A/C 档）、`config.ts` / `provider.ts`（S2-①）、`permission.ts`（S2-②）、
`index.ts` 退化为纯 barrel、`notices.test.ts`（5 条端到端）、`cli/src/index.ts` 变薄子类
（3415 → 2156 行）。三个 commit：`bbb366d`（拆环）/ `b13f81a`（主体）/ `6dc4e69`（补漏网）。

验证：`bun run typecheck` 40 包 exit 0；`bun test ./packages` **2215 pass / 0 fail / 95 文件**
（基线 2210 + host notice 端到端 5）；`packages/host` 89 pass。**剩余：仅 S4**（收口 host/cli 之间
有意重叠的测试 + 文档收尾）。

## 2026-10-01（续 230）P0 收尾 S1：装配期诊断通道（`renderNotice` 逐字复刻 + 等级只有一份）

### 为什么先落 S1 而不是直接搬 `boot`

设计稿（`docs/host-extraction-design.md`，本轮定稿）把 P0 收尾拆成 S1–S4，**S1 是纯新增、不接线**：
先把"文案"从"会不会被 boot 的其它改动顺带改掉"里摘出来。20 处输出今天**只有 1 条被测试钉住**
（`cli.test.ts:1939`），其余 19 条既无断言也没进任何结构化通道 —— 直接搬 boot，等于在没有任何
判据的情况下同时改动 20 条文案。S1 之后，S2 的"文案逐字不变"成为**可执行的断言**。

### 三处实测修正（相对设计稿）

1. **`level` 只有一份**：设计稿让调用点自己填 `level`。那等于把"这条算不算必须知道的事实"
   复制到 20 个调用点 —— 本仓"同一个东西两套写法"的老病。改为 `NOTICE_LEVEL: Record<NoticeCode,
   NoticeLevel>` 是唯一来源，`makeNotice()` 从表里盖 ⇒ 调用点**类型上无从填错**，降级必须改表。
   反向验证已确认：把 `provider.fallback-mock` 降成 `log` ⇒ 2 条用例失败（含"从表里盖等级"那条）。
2. **站点是 21 个 `code`，不是 20 个**：原表把 `2336` 行记成一个站点，实际那是 `loadPluginDirs`
   的 `log` 回调，背后有**三条不同消息**（代码注入闸门块 / 单模块加载失败 / 模块既无通用插件
   也无 Provider 工厂），前两条还是**多次 `write` 的扇出** ⇒ 模板按整块字节复刻。
   另发现**一条漏网站点**：`preloadBuiltinToolMetas` 用 `console.warn` 直写，既不走 `stdout`
   也不走 `setLogSink`，是本轮唯一"两个出口都不沾"的装配期诊断（S2 要一并处理）。
3. **外部插件目录那三条是"双换行"，且必须保留**：`out()` 参数自带 `\n`，CLI 回调又加一个
   ⇒ 每个 `out` 落成 `…\n\n`。要 S2 零 diff 就得复刻它；测试里专门跑一遍真实 `loadPluginDirs`
   对比**捕获字节**，因此这不是"本模块的风格选择"，而是与实现对齐的硬约束。

### 顺带修掉上一轮遗留的 typecheck 缺口

上一轮 B 档写了"typecheck 40 包 exit 0"，但那是在 `config-window.test.ts` **写出来之前**跑的 ——
该文件 4 处 `t.byProvider[...]` / `t.byModel[...]` 一直没过类型检查（`ProviderWindowTable` 的两个
字段在插件侧是**可选**的）。本轮补类型时暴露并修掉：`buildProviderWindowTable` 的返回类型收紧为
`ProviderWindowTableView`（三字段恒存在）——装配方的**产出**不该说"可能没有"，否则每个消费方
都要写一次 `?.` / `!`。**教训：验收口径要跑在最后一个改动之后，测试文件也是产物。**

### 产物

`packages/host/src/notice.ts`（`NoticeLevel` / `NoticePayloads` 判别联合 / `NOTICE_LEVEL` /
`makeNotice` / `renderNotice` / `installConsoleCapture`）、`notice.test.ts`（25 条）、
`packages/host/src/index.ts` 转出。**不接线** ⇒ 除 host 新增 25 条外，其余测试逐条不变。

验证：`bun run typecheck` 40 包 exit 0；`bun test ./packages` **2197 pass / 0 fail**（93 文件，
原 2172/92 + 25）；`packages/host` 71 pass。反向验证两条均已执行并确认失败。

## 2026-10-01（续 229）P0 第三步：搬配置归一化与窗口推导（B 档）—— 顺带定下"窄类型"这条边界

### 切口：B 档连着 config 层，但**不搬 config 模型**

原计划 B 档只列了 `buildProviderWindowTable` 一个符号。实测它的闭包是一条**推导链**：
`buildProviderWindowTable → resolveContextWindowTokens → normalizeProviderConfigs → parseModelSpec`
（外加 `sanitizeProviderId` / `isUsableWindow` 两个判据与 `ResolvedProviderConfig` / `ProviderConfigIssue`
两个类型）⇒ 一并搬走。真正需要裁剪的只有一处：**`HarnessConfig` 不搬**。

`HarnessConfig` 是 cli 的配置模型（三百来行，二十来段：compression / compaction / memory /
telemetry / plugins / snapshots…），而窗口链只读其中两段。为两个字段把整份模型拖进共用装配层，
等于让 host 反向依赖 cli 的配置口径 —— 而 A2A server / 编辑器扩展的配置来源未必是 config.json。

**处理：引入 `ProviderWindowConfigSource` 窄类型**（`providers` + `compression.modelContextLimit`）。
这不是本仓的老病"同一个东西两套写法"—— 它不含任何第二份实现，是**依赖倒置**：函数只声明自己
真读的字段，宽类型（`HarnessConfig`）传进来天然兼容。测试里专门留了一条用例钉住这点
（传带 `agentId` / `compaction` / `plugins` 等多余字段的宽对象，行为不变）。

### 为什么窗口链值得和配置归一化同处一包

窗口是占用率的**分母**。此前概览与 boot 各写一份、会话压缩干脆硬编码 200000，于是同一份 config
能同时得出 200000 与 102400 —— 按概览做的判断全部落空，会话压缩则因阈值算到真实窗口之外
（256500 > 200000）**永不触发**，且全程无任何症状。搬到 host 后三处（显示 / 压缩阈值 / ACP 占用率）
共用同一份实现，`cli.test.ts` 里那条"查表顺序与 acp-context 的 `lookupProviderWindow` 一致"的
守卫用例继续钉住取小 / 判空 / 优先级规则。

### 迁出符号（10 个）

`parseModelSpec` · `formatModel` · `sanitizeProviderId` · `normalizeProviderConfigs` ·
`isUsableWindow`（原本私有，本次导出 —— cli 的 compaction 层仍在用它判断查表结果）·
`resolveContextWindowTokens` · `buildProviderWindowTable` · 类型 `ResolvedProviderConfig` /
`ProviderConfigIssue` / `ProviderWindowConfigSource`（新）。

新增依赖：`@harness/acp-context`（**仅类型** —— 窗口表的形状定义在那边，写内联结构体就会与插件侧
两份定义漂移）。`import type` 完全擦除，不会把 ACP 内核拖上启动路径。

### 验证

| 项 | 结果 |
|---|---|
| `bun run typecheck` | **40 包 exit 0** |
| `bun test ./packages` | **2172 pass / 0 fail**（92 文件）—— 原 2156 / 91 **+16 / +1**，其余逐条不变 |
| `packages/cli` 单包 | **429 pass / 0 fail**，与搬迁前逐条一致（含读源码文本断言的 ACP 装配行守卫） |
| `packages/host` 单包 | **46 pass / 0 fail**（原 30 + 新增 16 条配置/窗口用例） |

新写的 `config-window.test.ts` 按能力覆盖且不经过 cli；`cli.test.ts` / `provider-model.test.ts`
侧原用例保留测导出面兼容。重叠仍是有意的，收口留到 `boot` 搬完。

### 剩下的只有 boot 主体了

P0 的外部依赖已全部就位：`loadPluginDirs`（A）+ 三个注册表（C）+ 配置与窗口（B）。
下一步把 `HarnessApp.boot`（约 1200 行，重度依赖 `this.permission` / `this.loadedProviders` /
`this.configStore` / `this.workspace` / `this.options` 等实例状态）抽成
`createHost({...})`，并给 boot 内 16 处 `stdout.write` 做三级分级。

## 2026-10-01（续 228）P0 第二步：搬内置注册表三节（C 档）—— 顺带把"隐式依赖"显式化

### 切口：先搬 C 档，不碰 `boot`

第一步（续 227）已把 A 档 `loadPluginDirs` 簇搬完。第二步原计划直接动 `HarnessApp.boot`，
但那要连 `lazyImport`（cli 内 27 处使用）与 `BuiltinToolRegistry` 一起拖走。故改为**先搬 C 档
（内置注册表三节）**，用小步换定位成本：这一步搬完，`boot` 主体剩下的外部依赖就只有
`buildProviderWindowTable`（B 档，连着 config 解析层）。

### 闭包实测：原清单又漏了 4 个符号

| 档 | 本次搬走的符号 | 备注 |
|---|---|---|
| **C** | `lazyImport` · `registerBuiltinProviderTypes`（含私有 `BUILTIN_PROVIDER_META` / `registerBuiltinProviderType`）· `BuiltinGeneralPlugin` · `BuiltinPluginRegistry` · `getBuiltinRegistry` · `unknownBuiltinPluginIds` · `resolveBuiltinPlugins` · `BuiltinToolRegistry` · `getBuiltinToolRegistry` · `preloadBuiltinToolMetas` | 计划文档原清单只列了 4 个；实测**多出** `BuiltinToolRegistry` / `getBuiltinToolRegistry` / `unknownBuiltinPluginIds` / `registerBuiltinProviderTypes` —— 它们是闭包带出来的 |

搬走后 cli 变死的 import（顺带清理）：`ProviderTypeMeta`、`ProviderTypeFactory`、
`resolveProviderTypeFactory`、`ToolMetaEntry`、`ToolMetaRegistry`、`ToolMetaSource`。
**保留** `ProviderTypeRegistry` / `ProviderConfig` / `ToolMetaLookup` / `AgentPlugin`（cli 别处仍在用）。
`loadPluginDirs` 反过来要在 cli 内继续 import —— 第一轮以为它只在 re-export 面，实测 cli 内部
两处仍在用（boot 装配与 `config check`），typecheck 直接把这个假设打回来了。

### 新增的一类约束：`lazyImport` 的 specifier 是**隐式依赖**

`getBuiltinRegistry()` 用 `lazyImport('@harness/tools-builtin')` 这类字符串引用 22 个内置插件包。
两个后果此前没有明确记录：

1. **TS 看不见**（specifier 是 `string`，不是 import 语句）⇒ typecheck 全绿不代表运行时能解析；
2. **`bun build --compile` 无法静态分析 `import(变量)`** ⇒ 这些包不会自动进 bundle。

处理：把这 22 个包**显式写进 `packages/host/package.json` 的 `dependencies`**。这是本步真正的
架构产出 —— 把"反正是 monorepo 根 node_modules 有"这种隐式事实，换成一份可机读的契约
（改内置插件清单 ⇒ 必须同步改 `package.json`；打包器按同一清单收入口）。AGENTS.md §3 与
计划文档 §7 都已补上这条纪律。

### 验证

| 项 | 结果 |
|---|---|
| `bun run typecheck` | **40 包 exit 0** |
| `bun test ./packages` | **2156 pass / 0 fail**（91 文件）—— 原 2137 / 90 文件 **+19 / +1**，其余逐条不变 |
| `packages/cli` 单包 | **429 pass / 0 fail**，与搬迁前**逐条一致**（re-export 兼容的验收口径） |
| `packages/host` 单包 | **30 pass / 0 fail**（原 11 + 新增 19 条内置注册表用例） |

测试仍**有意重叠**：`cli.test.ts` 侧保留原用例测"符号还能从 `@harness/cli` 拿到"，host 侧新写的
`builtin-registry.test.ts` 测"能力本身成立且不经过 cli"（将来 A2A server 也吃这份实现）。收口留到
`boot` 搬完时统一做。

### 实现细节：大段搬迁用行区间删除而非逐段 Edit

cli 的 C 档是连续 407 行（含注释），逐段 `Edit` 需要 12 次精确匹配。改用 Python 按行区间删除 +
断言校验边界（起止行必须分别是 `// ---` 与 `}`、紧随其后的 `lazyMockProvider` 必须存在），
并在原位置留三行说明注释。**断言是必要的**：第一次就因断言索引写错而中止，等于顺手确认了
"删错行会立刻失败"而不是静默截断。

## 2026-10-01（续 227）P0 第一步：抽出 `@harness/host`，先搬 `loadPluginDirs` 簇

### 调研把"6 个符号一次搬完"这个前提否掉了

计划文档列的 6 个装配符号，实测依赖闭包后**差三档**，一次搬完等于把 cli 的启动基建与 config
解析层一起拖走：

| 档 | 符号 | 闭包 |
|---|---|---|
| **A** | `loadPluginDirs` + `PluginLoadResult` + `probeAgentPlugin` + `collectAgentPlugins` + `registerProviderTypeFactory` | **自足** —— 只依赖 `@harness/plugin` 类型与 `@harness/workspace` 的 `MultiDirLoader`/`normalizeDirs`（后者在 cli 内只此一处用） |
| B | `buildProviderWindowTable` | 连着 config 解析层（`normalizeProviderConfigs` / `resolveContextWindowTokens` / `HarnessConfig`），在 cli 别处大量复用 |
| C | `BuiltinPluginRegistry` / `getBuiltinRegistry` / `resolveBuiltinPlugins` / `preloadBuiltinToolMetas` | 连着 `lazyImport`（cli 内 **27 处**）与 `BuiltinToolRegistry`（**8 处**）；`preloadBuiltinToolMetas` 还连带 `BuiltinToolRegistry` + `getBuiltinToolRegistry` —— **这两个不在原清单里，是闭包带出来的** |

⇒ **`lazyImport` 才是 P0 真正的搬迁重心**（27 处使用），原清单只是"看得见的冰山尖"。

### 第一步做了什么

新建 `packages/host`（`@harness/host`），迁 A 档；`@harness/cli` 顶部 `import ... from '@harness/host'`
+ `export { ... }` 保持**导出面逐字不变**（`cli.test.ts` 直接 import 这些符号）。顺带清掉 cli 里
因此变成死引用的 `MultiDirLoader` / `normalizeDirs` / `pathToFileURL` 三个 import。

选择 A 档先做的第二个理由：它是 A2A 宿主**必需**的能力 —— server 侧同样要能加载用户插件，
这一步同时也是 P1 的铺路，不只是"为了搬而搬"。

**新包登记**（AGENTS.md §1）：根 `tsconfig.json` paths、根 `package.json` 与 `packages/cli/package.json`
的 `dependencies`、`bun install`，四件事齐了才算完成定义。

### 验证

| 项 | 结果 |
|---|---|
| `bun run typecheck` | **40 包 exit 0**（含新增 `@harness/host`） |
| `bun test ./packages` | **2137 pass / 0 fail**（90 文件）—— 原 2126 / 89 文件 **+11 / +1**，其余逐条不变 |
| `packages/cli` 单包 | **429 pass / 0 fail**（含 9 条 `loadPluginDirs` 用例 —— re-export 兼容的验收口径） |
| `packages/host` 单包 | **11 pass / 0 fail**（新写的归属测试） |

**测试的有意重叠**：那 9 条 cli 侧用例保留原样（它们是 re-export 兼容回归），host 侧另写 11 条
按能力归属覆盖实现。两处重叠是刻意的，待第二步搬 `boot` 时统一收口去重 —— 现在删任何一边都会
要么丢兼容保护、要么丢能力覆盖。

### 踩坑

`bun test packages/cli`（**无 `./` 前缀**）会把 `reference/opencode-dev/packages/cli` 一起扫进来，
报 4 个与本次改动无关的 `Cannot find package 'effect'`。两个正确跑法：`cd packages/cli && bun test`，
或带前缀的 `bun test ./packages`。这与 AGENTS.md §2 已记的"别用根目录 `bun test`"同源 —— 路径参数的
模糊匹配也会踩到同一个坑，值得补进 §2。

## 2026-10-01（续 226）A2A P0.5 两个 spike：**两条风险假设都被证伪**

`docs/external-integration-plan.md` §6 的 P0.5 要求先用两个 spike 定案协议口径与分发路径。
结果**两个都是"可行"**，原先写在 §8 风险表里的悲观预期不成立。可复现脚本在 `spikes/a2a/`。

### Spike ①：SDK 无框架入口 + `Bun.serve`（`@a2a-js/sdk@1.3.0`，13 项自检全绿）

`@a2a-js/sdk/server` 的 `JsonRpcTransportHandler.handle(body, ctx)` 只吃 JSON-RPC body
（`string | Record`）、吐纯对象或 `AsyncGenerator` —— **完全不接触 HTTP Request/Response**。
⇒ 直接挂 `Bun.serve`，**不需要 express 等任何框架 peer dep**；SSE 用 SDK 的
`formatSSEEvent()` + `SSE_HEADERS` 自己写。自检覆盖：取卡 / 非流式 `SendMessage` / 流式 SSE /
`GetTask` / `ListTasks` / `CancelTask` / **`INPUT_REQUIRED` 挂起与续接** / `A2A-Version` 校验 /
executor 抛异常转 `FAILED`。

三条**静默失败**的口径坑（读类型定义读不出来，只有跑起来才会撞）：

1. **Part 有两套表示**：TS 侧 `content: { $case: 'text', value }`，线上 JSON 是 `{"text":"..."}`。
   把内部表示直接 `JSON.stringify` 发出去，对端 `fromJSON` **静默丢弃、不报错**
   （实测 `echo: hello` 退化成 `echo: `）⇒ 出参一律走 `MessageFns.toJSON()`。
2. **`TaskState` 是数字 enum**（`TASK_STATE_COMPLETED === 3`）而线上是字符串 ⇒ 状态比较按字符串。
3. **版本校验不归 transport 管**，宿主必须自己调 `validateVersion(v, card, 'JSONRPC')`
   （它从 `@a2a-js/sdk/server` 导出，根入口没有）；头缺失按 `'0.3'` 处理。

**挂起/续接实测可行，且比文档设想的简单一档**：走**模式 A** —— executor 在 `INPUT_REQUIRED`
之后**不返回**（`await` 答复），挂起表只需 `taskId → resolver`，**不必跨请求保存/恢复生成器**。
`ExecutionEventQueue` 在 `INPUT_REQUIRED` 处就终止 ⇒ 阻塞式 `SendMessage` 照样立即返回该状态；
带同一 `taskId` 的下一条 `SendMessage` 会**再次调用 `execute`**，此时
`requestContext.task.status.state === INPUT_REQUIRED`，用它把答复喂给 resolver 唤醒第一轮即可 ——
第一轮补发 COMPLETED，**续接请求的调用方直接拿到最终 artifact**。代价：executor 的 Promise 会长期
悬挂 ⇒ **TTL 从"锦上添花"变成必需项**（已回写 §10 第 5 条）。

副作用观察：SDK 自己在 executor 抛异常时 `console.error` 打印**完整堆栈** ⇒ P0 抽 host 时
日志出口要罩住 SDK 的 console，不只是 harness 自己那 16 处 `stdout.write`。

### Spike ②：`bun build --compile` 与动态 TS 插件（**原风险假设被证伪**）

单文件二进制**内嵌了转译器**，运行期 `await import(pathToFileURL(full).href)` 能直接加载用户目录的
`.ts`（不只是 `.js`/`.mjs`）。实测通过：三种扩展名；插件的裸依赖按**插件文件所在目录向上**解析
（与未编译时一致 —— 不是 `--compile` 引入的新限制）；绝对路径、相对 `.ts` 导入、`node:` 内置模块
全部正常；**61MB / 冷启动 18ms** ⇒ **P3 sidecar 可走 `--compile` 单文件二进制**，"随扩展带 bun"
降级为备选。唯一遗留是**既有问题、与 `--compile` 无关**：用户插件目录解析不到 `@harness/plugin`
这类裸依赖（`loadPluginDirs` 现有提示文案已覆盖）。

### 落档

`spikes/a2a/`（两个 spike 脚本 + README，含跑法与结论）；计划文档新增 **§3.1.1**、§3.4 追加实测
结论段、§6 P0.5 行改为结论并标注依赖解除、§8 风险表改两条（`--compile` 证伪 + 新增"SDK 自己写
console"）、§10 第 5 条补 TTL 必要性；`AGENTS.md` §5 新增一条"protobuf SDK 两套表示"的纪律。
**SDK 版本钉死 `@a2a-js/sdk@1.3.0`**（1.0 GA 于 2026-07-22，1.1/1.2/1.3 是 GA 后 minor 迭代）。

下一步是 **P0：抽 `@harness/host`**（P1/P2/P3 的共同前置）：搬 `HarnessApp.boot` 与 6 个装配符号
（`BuiltinPluginRegistry` / `getBuiltinRegistry` / `resolveBuiltinPlugins` / `preloadBuiltinToolMetas` /
`loadPluginDirs` / `buildProviderWindowTable`），CLI 保持 re-export 兼容，并给 boot 内 16 处
`stdout.write` 做三级分级（P0.5 后追加：还要罩住 SDK 的 console）。

## 2026-09-30（续 225）回合结束闸门：模型收尾 ≠ 本轮结束（引擎级等待 + 反抢活提示词）

### 缺口：步间闸门挂在"续轮"上，覆盖不到最常见的收尾形态

`shouldContinueStep()` 的判据是 `toolCallCount > 0`；模型给出**最终答复**时循环直接 `break`，
挂在循环顶部的步间闸门（续 196/198/203）**根本不会被触达** —— 而"派完工、报一句、收尾"恰恰是
coordinator/lead 最常见的形态。真机 `s_1790756963376_7r3x8`：

| 时刻 | 事件 |
|---|---|
| +26.1s | 派 4 个后台 reader（`runInBackground: true`） |
| +33.0s | 播报一句后给最终答复 ⇒ 本轮结束 |
| +33.0s ~ +67.4s | **引擎完全空闲 34.4s** |
| +67.4s 起 | 4 个 worker 分批完成 ⇒ 宿主各注入一次 `<continue/>` ⇒ **3 次"只收通知"的完整模型调用** |

三块代价互相独立：① 空档 34.4s 界面无事发生；② 每 worker 一次整轮重放；③ 送达依赖**宿主约定**
（没订 `worker.completed` / `barrier.completed` 的宿主会让已跑完的结果滞留 —— `axqkk` 实测
barrier `+527s` 完成、结果 `+2816s` 才送达）。

### 改动：`waitAtTurnEnd`（宿主开关）＋ 插件**声明位**

| 环节 | 行为 |
|---|---|
| 武装 | 插件在步间探测（`phase: 'step'`）里置 `AgentStepGateDecision.waitAtTurnEnd` ⇒ 本轮武装；subagent 插件的条件是"本会话仍有存活后台任务" |
| 触发 | 模型收尾（`!shouldContinueStep`）且已武装 ⇒ break 前再问一次（`phase: 'turn_end'`） |
| 等待 | 仍报存活 ⇒ 原地等（切片 500ms 重探），**等待期间一次模型都不调**；静默即收工 |
| 送达 | `drainNotifications` ⇒ 通知作为 user 消息入对话；**有结果才 `continue`**，模型在同一条 query 内处理 |
| 兜底 | `STEP_GATE_TURN_END_MAX_WAIT_MS`（默认 5 分钟）**入口**归零 ⇒ 不探测不 drain，交还宿主 auto-continue |

三条边界（每条都有理由，不是默认值堆出来的）：

1. **声明制而非无条件探测** —— 无条件探测会让没有后台任务概念的插件也在回合末多挨一次询问，
   且一句顺口的"存活"就能让引擎真的等下去。谁有能力产生"需要等的任务"，谁负责声明。
2. **预算是真终止条件** —— 步间闸门的 `maxTotalMs` 刻意只是**提醒阈值**（续 203）；这一条不同：
   它等的是"任务全跑完"，没终止条件时一个卡住的后台任务会让**整条 query 永不返回**。
3. **预算见底不 ping-pong** —— 等待**途中**见底仍 drain 一次（已到达的结果值得处理），
   但下一次回合末等待在**入口**就返回 ⇒ 最多多一次模型调用。

### 提示词：把"等"写死，否则模型会用重复劳动/空转填时间

引擎给了等待能力还不够 —— 模型不知道"系统会替我等"时，会拿**重复劳动**（自己把子 Agent 的活
再做一遍）或**空转**（反复 `read_file` / `bash` 查状态）填满空档。三个落点：
`coordinator.txt`「等待：有依赖的活别抢着干」、`subagent-tool-documentation.txt`「派工后：等结果，
别抢活」、`renderRoster()` 末行；`inputSchema.prompt` 描述同步补一句。核心一句可判定的动作：
**「你下一步依赖它 ⇒ 停手，系统替你等；不依赖的独立活可以并行做」**，并明说"等待期间不调用模型、
不烧步数"—— 不写这句，模型不会信任"停手"是安全的。同步补了 `~/.harness/agents/lead.md`。

### 契约变化：CLI `<continue/>` 从"送达通道"退化为"兜底"

`barrier-integration.test.ts` 实测到引擎在轮内把通知 drain 进对话，随后注入的 `<continue/>`
读队列为空 ⇒ 正确跳过。该用例据此改为断言"**结果进了对话**"（比旧版"队列里还有、等着被取走"更强）。
CLI 的跳过提示同步改准确：`无待处理的后台结果（已处理或未就绪），跳过本次自动续轮` ——
措辞要同时覆盖"引擎已接管"与"理论上尚未就绪"两种来源。

### 验证

| 项 | 结果 |
|---|---|
| `bun run typecheck` | 39 包 **exit 0** |
| `bun test ./packages` | **2126 pass / 0 fail**（89 文件） |
| `step-gate.test.ts` | 新增 4 条回合结束闸门用例 + 3 条 `normalizeTurnEndWaitMs` + 1 条常量守卫，**37 pass** |
| `barrier-integration.test.ts` | 契约更新后 **2 pass**（真实插件链端到端） |

新增可观测：`step_gate` 流事件与 `agent.step.gate` bus 事件都带 `phase: 'step' | 'turn_end'`
（两者 `waitMs` 语义不同，不可直接比较）；流事件**必须由调用方 yield**（等待在普通 async
私有方法里）—— 这正是"长等待期间界面安静"那个观感问题的解。

## 2026-09-30（续 224）派工提示词三项收敛：先算账（要不要派 / 派几路）+ 多路范围互斥

从两会话取证（`s_1790756296342_9yvoc` 未派工 / `s_1790756963376_7r3x8` 派 4 路，同一句 prompt、同一 cwd）得到
**成本侧结论**：派工开销**随路数线性增长** —— 4 路总输入 `6.32M`，是主会话自己做的 `5.67×`，
其中 `4.82M` 全在子会话（每个子 Agent 是一份独立上下文，彼此不共享前缀缓存）；
并行的墙钟收益（`77.3s` vs 串行 `225.2s`）会被等待损耗（gate 空转 34.3s + 通知延迟 20.7s）吃掉。
于是给派工提示词补三条硬约束：

| 约束 | 落点 |
|---|---|
| **派工前先评估复杂度**：门槛 = 可切分 ＋ 每块够重（≥10 步或 ≥30s）＋ 至少 2 块；达不到就自己做 | `subagent-tool-documentation.txt` 新增「派工前先算账」；`coordinator.txt` 派工规则首条 |
| **默认 2–3 路、最多 4 路**（路数是成本第一乘数，宁可每路大一点，不要切碎） | 同上 ＋ `renderRoster()` ＋ `inputSchema.prompt` 描述 |
| **多路范围必须两两互斥**（逐路写文件集声明；公共文件只让一路读，或父 Agent 先读完写进 prompt） | 新增「多路派工：先划界，再派」；`renderRoster()`；`coordinator.txt` |

- `documentation` 是**每次请求都随 tools 发送**的（provider 侧把 `tool.documentation` 合并进 `description`），
  所以新增文本按"能否改变下一步决策"逐句筛过；两条新约束同时写进 `description` / `documentation` /
  `inputSchema.prompt` / `renderRoster()` **四个入口**（沿用 §18.2 的"少一处就漏"约定）。
- `coordinator.txt` 走 `core.prompt.system.transform`，对 `mode === 'coordinator'` **无条件注入**
  （`lead.md` 自带正文也照收）⇒ 改它同时覆盖 lead 与空正文 coordinator。
- 提交 `93bf480`；`~/.harness/agents/lead.md`（用户级、不在仓库）同步补同一套判定。

### 验证

| 项 | 结果 |
|---|---|
| `bun run typecheck` | 30 包 **exit 0** |
| `bun test packages/plugins/subagent` | **159 pass / 0 fail** |
| `bun test packages/plugins/coordinator` | **33 pass / 0 fail**（含 `COORDINATOR_SYSTEM_PROMPT 包含四阶段与反模式`） |

未改任何代码逻辑，只改提示词文本 ＋ `renderRoster()` 的两行字符串。

## 2026-09-30（续 223）`compaction` 的窗口同样按会话端点解析（续 222 遗留的"同源未修"项）

### 起因：续 222 只修了 ACP 一侧，`compaction` 一侧仍在

`compaction`（core 自带的会话压缩：`/compact`、REPL 启动时的自动判定、headless `run`、`/stats`、TUI 统计面板）与 ACP 是**两套机制**，窗口却各自算一份：`buildCompactionOptions(cfg, defaultProviderId)` 里写着 `k?.contextWindowTokens ?? resolveContextWindowTokens(cfg, defaultProviderId)` —— **只认默认 Provider**。

后果与续 222 同源，但落在另一条链上：默认端点 300K、会话用 `/model` 切到 hy3（200K）后，阈值 = 80% × (300000 − 30000) = 216000 已经**超过本会话真实窗口 200000** ⇒ 会话压缩永不触发，而 `/stats`、概览、`/compact auto` 全都"看起来正常"（同一份 config 下不同会话本来就该有两个分母）。`/stats` 更直白：子会话占用率**逐行列出**，却一律拿父会话的窗口当分母（代码里明写"同窗口近似"）。

### 改动

**`packages/cli/src/index.ts`**

- 新增 `SessionEndpoint`（`providerId?` / `modelId?`）与 `resolveCompactionWindow(cfg, defaultProviderId, endpoint?)`：`compaction.contextWindowTokens` / `compression.modelContextLimit`（显式）→ 按端点查表（`byProvider` → `byModel`）→ `fallback` → 200000。`buildCompactionOptions` 加第三个参数并改用它。
- 新增 `HarnessApp.resolveSessionEndpoint(session)`：解析链与 core `_prepareQueryOnce` 对齐（`Session.meta.model` 会话级覆盖 → Agent 定义 model）；解析不出返回 `{}` ⇒ 落 `fallback`（= 改造前逐位）。
- 四个消费点改传各自会话的端点：`/compact`（并回源 `session.get` 取最新一份，避免拿"切模型前"的快照算阈值）、`/stats`（本会话 + 每个子会话**各自**解析）、启动自动判定（REPL/TUI 之前那道 `compactIfNeeded`）。
- `renderContextOccupancy` 加第四个参数 `resolveWindow`：本会话与每个子会话分别取分母；不传 = 改造前行为（测试替身 / 拿不到 config 的宿主走这条）。
- `resolveContextWindowTokens` 各级加"能当分母"甄别（`0` / 负数 / `NaN` 按"没配"处理）；`buildProviderWindowTable` 的内联判空改用同一个 `isUsableWindow`。
- 概览的会话压缩行在 providers 窗口不一致时补注「（默认 Provider 口径；各会话按自身端点解析）」—— 不注明就会被读成"我的会话就是这个分母"。

**`packages/cli/src/tui.tsx`**：统计面板的占用行透传 `resolveWindow`（闭包只捕获 config，会话对象由渲染层回源取最新一份）。

**`packages/plugins/subagent/src/index.ts`**：创建子会话时把派工传入的 `model` 覆盖写进 `Session.meta.model`。

### 设计取舍（5 条）

1. **为什么必须补 `subagent` 落盘**：`SubagentTool.model` 原先只活在一次 `agent.query({ model })` 入参里，会话记录不留痕 ⇒ 子会话的端点**事后不可恢复**，占用率分母只能退回默认 Provider —— "修好了解析链却拿不到判别符"等于没修。写进 `Session.meta.model`（与「会话级模型覆盖」同一约定，`getSessionModelOverride` 直接可读），**只在显式传了 model 时才写**（不制造多余覆盖）。
2. **显式值仍排最前**：`compaction.contextWindowTokens` > `compression.modelContextLimit` > 端点查表 > fallback。与 ACP 侧同一把尺子（`modelContextLimit` 两边都压过查表）；`compaction` 自己的键更具体，排最前是改造前就有的语义。
3. **`endpoint` 缺省 = 逐位回到改造前**：查表落 `fallback`，而 `fallback` 就是默认 Provider 的窗口。所有"不做端点分化"的旧调用点（含既有测试）因此零行为变更。
4. **刻意不复用 acp-context 的 `lookupProviderWindow`**：该模块连带 acp-kernel，为 6 行查表在 CLI 启动路径上加载整棵内核不划算（同 `lazyImport` 的理由）。改成**加一条对照用例**钉住两边一致（遍历一组端点在两处各算一次、断言相等）——"同一把尺子"由用例保证，而不是由 import 保证。
5. **`renderContextOccupancy` 回源取会话**：调用方手里的会话对象是快照（TUI 只传得进 `sessionId`），`/model` 切过模型后快照上的 `meta.model` 已过期 ⇒ 由渲染层 `session.get(id)` 回源；取不到（测试替身没有 `get`）再用手上那份。

### 顺带

- `resolveContextWindowTokens` 之前会把 `contextWindowTokens: 0` 原样当选（占用率算成 `Infinity`、阈值算成负数，且都"显示正常"）—— 现在各级一律按"没配"处理、回落 200000。不改任何 sane 配置的行为。
- README 的 compaction 段、调研文档 §1.5 的"尚**未**修"注记、`AGENTS.md` §5 的纪律条目、`harness-config-scope-audit` 技能（两处"未修" → 已修，并新增"逐个消费点过一遍""判别符要落盘"两条判据）同步更新。

### 验证（三段式 + 5 个反向实验）

- typecheck：**39 包 0 error**；`bun run test`：**39 包全部 `0 fail`**（EXIT=0；cli 420 pass、subagent 159 pass）。
- 新增用例 7 条（cli 3 + cli 集成 1 + 占用展示 2 + subagent 1）+ 2 处既有用例扩展（`buildCompactionOptions` 的端点参数、`resolveContextWindowTokens` 的甄别）：端点分化 / 显式优先 / 缺省口径、与 acp-context 的对照守卫、概览注记、真实 boot 上 `/model` 切到小窗口端点后分母变 200000（并断言"按 300000 算阈值 216000 > 200000"）、子会话按自身端点（解析不出时回落）、`meta.model` 落地（只给 modelId / 不传覆盖时不写）。
- 反向验证：① 摘掉端点查表 ⇒ 4 条红；② `resolveSessionEndpoint` 忽略会话级覆盖 ⇒ 集成那条红；③ 子会话沿用父会话窗口 ⇒ 显示层那条红（收到 50.0% 而非 75.0%）；④ subagent 不写 `meta.model` ⇒ 子会话端点那条红；⑤ 窗口不做"能当分母"甄别 ⇒ 2 条红。恢复后 `git diff` 与备份 patch 逐字一致、`grep 反向验证临时` 无残留。

## 2026-09-30（续 222）占用率分母按「本会话实际端点」解析（调研轮 §1.5 遗留项）

### 起因

模型可以按 Agent 换（`packages/core/src/index.ts`：`providerId = input.model?.providerId ?? agent.model?.providerId ?? 'default'`，`modelId` 同理；agent md 的 `model:` 与 `SubagentTool.model` 都能覆盖，**逐会话可不同**），而压缩窗口**不跟着换** —— 装配期 `resolveContextWindowTokens(cfg, defaultProviderId)` 只认默认 Provider，一个数发给插件，此后所有会话（主 + 子）共用。

后果：被派到小窗口端点的子 Agent 占用率**虚低**（默认端点 300K、子 Agent 走 200K ⇒ 报 66% 时其实已 100%），压缩阈值永不触发，且**没有任何症状** —— `acp_status` 照常报数，报的是别人的分母。

### 改动

**`packages/plugins/acp-context/src/index.ts`**

- 新增选项 `providerWindows: ProviderWindowTable`（`byProvider?` / `byModel?` / `fallback?`）。
- 新增纯函数 `lookupProviderWindow(table, providerId, modelId)`：实例维度优先于模型维度；`0` / `NaN` / 负数视作"没配"（当分母会算出 `Infinity`）。
- `scopeFor(agentId, parentSessionId, providerId, modelId)` 的窗口解析链：
  `config.modelContextLimit` → 插件选项 `modelContextLimit` → 查端点表 → `providerWindows.fallback` → `200_000`。
- **缓存 key 补 `providerId` / `modelId`**：漏了会拿先到者的窗口去算后来者（同一 Agent 换端点时正是这个形态）。
- 工厂内不再 `?? 200_000` 预先兜底（那会让查表那条腿恒被截胡）；保留一个 `modelContextLimit` 常量仅作**诊断口径**（install 日志 / autoTune 摘要）。
- preModel hook 传 `input.providerId` / `input.modelId`；install 日志补 `providerWindows` 摘要。

**`packages/cli/src/index.ts`**

- 新增导出 `buildProviderWindowTable(cfg, defaultProviderId)`：`byProvider` 按实例 id、`byModel` 按模型名（**同名多实例取最小**）、`fallback = resolveContextWindowTokens(...)`。
- 装配处改传 `modelContextLimit: compression.modelContextLimit`（**只传显式值**）+ `providerWindows: buildProviderWindowTable(cfg, defaultProviderId)`。

### 设计取舍（6 条）

1. **`fallback` 必须是原来那个数**：查不到端点时逐位回到旧行为 —— 这是"缺省零行为变更"的保证点。若另推一遍（如"默认 Provider 的窗口"重算），在没有 `providers` 的场景下会悄悄改掉分母。
2. **显式与推导分两路**：旧代码把 `compression.modelContextLimit ?? 默认Provider窗口 ?? 200000` **合成一个数**传下去，于是"显式优先"与"按端点分化"挤在一条链上，必然有一条永远走不到。现在显式单列一路（排最前），推导单列一路。
3. **`byProvider` 优先于 `byModel`**：`contextWindowTokens` 挂在 **Provider 实例**上（config 里没有"模型级窗口"这一层），实例信息更具体；而 `providerId` 缺省时 core 传 `'default'` 哨兵 —— 它不在表里 ⇒ 落 fallback，正好等于"默认 Provider 的窗口"。
4. **不做组合键**（`providerId + '/' + modelId`）：查不出更细的答案，只会多一个永远 miss 的分支。
5. **模型维度必须留**：agent md 里写 `model: { modelId: 'hy3' }` 比写"派生出的 provider id"自然得多，只做实例维度会漏掉这条真实路径。
6. **同名多实例取最小**：分辨不出走哪个端点时取最小 = 宁可早压；取最大会让分母虚高，正是要避免的方向。

### 顺带

- 调研文档 §1.5「已存在的隐性错配」→ **✅ 已修**，并注明 `compaction`（另一套会话压缩机制）上的**同源问题尚未修**：`buildCompactionOptions` 仍只按默认 Provider 推导单一窗口，而它走 core 的 `compactIfNeeded`，没有按会话分化的入口，需单独评估。
- 文档 §1 重写窗口解析（新优先级 + 为什么按端点 + 为什么显式会压过它）；§7.5③ / §9 / §11① 同步口径。

### 验证（三段式 + 4 个反向实验）

- typecheck：**39 包 0 error**；`bun run test`：**39 包全部 `0 fail`**。
- 新增用例：acp-context 3 条（`lookupProviderWindow` 纯函数 / 按端点解析全链（含"同一实例换端点"）/ 显式压过查表 + 缺省口径不变）、cli 2 条（建表逻辑 / 装配行守卫）。
- 反向验证：① 摘掉端点查表 ⇒ 2 条红；② 缓存 key 去掉 `providerId`/`modelId` ⇒ "同一实例换端点"那条红；③ 摘掉 `fallback` ⇒ 2 条断言红；④ 装配行改回 `resolveContextWindowTokens(...)` ⇒ 装配守卫红。恢复后 222 pass / 0 fail、`grep 反向验证临时` 无残留。

### 一条新守卫的说明

装配行**没有**别的守卫覆盖它：插件侧用例无论收到什么选项都成立，类型上 `modelContextLimit?: number` 也收得下任何数字 —— 而把它写回推导值就是**复活本轮修的 bug**。故加一条读源码文本的短断言（本仓已有"扫 docs 全部 jsonc 片段"这类文本守卫先例），失败信息直接指出"装配行写错了"。配套纪律写进 `AGENTS.md` §5：*凡"按某个东西算出来的分子/分母"，都要问一句「这个东西会不会在运行期变」* + 显式/推导分两路。

## 2026-09-30（续 221）压缩配置的两条真机告警：告警可执行化 + 双口深合并 + 文档修正

### 起因：启动时的两条告警（用户实机贴出）

```
[WARN] config.json → compression 有以下未生效项：
       - compression.subagent.nudge.growthFloor 未被识别，该配置不会生效
[WARN] config.json → telemetry 有以下问题：
       - telemetry.store 未被识别，该配置不会生效
```

### 判定：两条告警不是同一个性质

| 告警 | 判定 | 依据 |
|---|---|---|
| `compression.subagent.nudge.growthFloor` | **位置写错**（字段名对、口写错） | `COMPRESSION_NUDGE_KEYS` 只开放 3 个占用率百分比键（`cli/src/index.ts:1499`）；`growthFloor` 是内核 `NudgeConfig` 字段（`acp-kernel/dist/types.d.ts:126`），按文档 §6 须写 `config.nudge.*` |
| `telemetry.store` | **字段不存在** | `TelemetryOptions`（`plugins/telemetry/src/index.ts:40-58`）只有 `enabled` / `dataDir` / `pathBuilder` / `debounceMs` / `crash` / `userID` / `otlp`；`directory: "sessions"` 本就是默认目录且不可单独配 |

**但第一条的根因在文档侧**：`docs/acp-context-config.md` §7.5① 两段标着"直接抄用"的示例，**自己**就把
`growthFloor` / `growthCap` / `minGrowthFloor` / `growthRatio` / `minGrowthRatio` 写在了结构化 `nudge` 里
（`:737-739` / `:756-760`）—— 照抄会各报 3~5 条同类告警。正文另有 40 余处把**字段名**记作 `nudge.growthFloor`，
读者按字面还原成路径就必然踩中；速查卡 `acp-context-param-table.md` 的「直接抄」块同病（本轮扫文档时才发现）。

### 决策：为什么不动契约

给了三条路并请用户定：① 把 `nudge` 加宽到收内核 `NudgeConfig` 全部字段；② 五棵子树全部加宽、统一
"结构化口收全 + `config.*` 兜底"；③ **契约不动**，改告警文案与文档。**用户选 ③** —— 理由是"结构化口只收常用键、
其余走 `config.*`"这条规则与 `compress` / `truncate` / `absorb`（本来就只有 `config.*` 一条路）**本来就是同一套**，
单独加宽 `nudge` 会让它变成特例。于是技术债**记在文档里**（§5 写法警示）而不是藏进代码。

### 改动清单

| 文件 | 改动 |
|---|---|
| `cli/src/index.ts` | ① 抽 `toAcpConfig()`：顶层与档位**共用同一份翻译**（此前 boot 内联一份、`toAcpScope` 一份）；② `tiers` / `nudge` 由**整体替换**改为**深合并**（结构化口优先）；③ 新增 `checkSubtreeUnknown()`：结构化口的未知键**若是内核字段** ⇒ 告警直接给出能生效的路径 `…config.<subtree>.<key>`，**拼错的键**维持朴素文案；④ `telemetry` 未知键附可用键清单 |
| `cli/src/index.ts`（类型注释） | `compression.nudge` / `compression.tiers`（顶层与档位两处）补"只收这几个键、其余写 `config.*`" |
| `cli/src/cli.test.ts` | 新增 5 条：指路告警（顶层 / 档位 / perAgent）、拼错不指路、telemetry 可用键、`toAcpConfig` 深合并、**docs 全部 jsonc 片段过校验器**（带"片段数 > 10"守门断言） |
| `docs/acp-context-config.md` | §5 新增"写法"警示（**字段名 ≠ 可写路径**）；§6 说明两口会深合并、结构化口优先；§7.1 修正"growth 系列可写结构化口"的错述；§7.5① 两段示例改为合法写法；§10 补"告警会指路"与两类错误的区别；§11① 补档位的两口规则与 `subagent.config.nudge.growthFloor` 示例；§9 两行补口径提醒 |
| `docs/acp-context-param-table.md` | 页首新增 ⚠️ 写法提醒；「直接抄」示例改为合法写法 |
| `~/.harness/config.json`（仓库外） | `subagent.nudge.growthFloor` → `subagent.config.nudge.growthFloor`；`telemetry.store` 拍平为顶层 `debounceMs`（`directory: "sessions"` 本就是默认，删掉即可）。已备份 `*.bak-20260930-083140` |
| `AGENTS.md` | 新增"结构化口 + 透传口"三条纪律 + 文档示例受检这一条 |

### 两个设计取舍

- **告警指路只认内核真实字段名**：`growthFloar` 这类拼错的键**在内核里也不存在** ⇒ 保持朴素文案。
  若把"长得像"的键也指路，用户会照着告警抄一条**同样无效**的路径 —— 比不指路更糟。
  （既有用例恰好用的是拼错键，所以"两类错误分开处理"这件事被两边同时钉住了。）
- **`telemetry` 附可用键清单、`compression` 不附**：前者段内**没有**透传口可兜底，写错的键没有别的去处；
  后者有 `config` 兜底，且顶层合法键有 17 个，列出来只是噪音。

### 验证（三段式）

- typecheck：**39 包 0 error**
- `bun run test`：**39 包全部 `0 fail`**（cli 163）
- **反向验证**（"回退后变红"）：
  - 摘掉深合并（`carried()` 恒返回 `{}`）⇒ `toAcpConfig` 用例红；
  - `checkSubtreeUnknown` 恒走朴素文案 ⇒ 指路用例红（**拼错那条仍绿**，正是它测的路径）；
  - 把速查卡示例改回 `nudge.growthFloor` ⇒ docs 扫描用例红；
  - 去掉 telemetry 可用键 ⇒ telemetry 用例红；
  - 恢复后 `grep 反向验证临时` 无残留，cli 163 pass / 0 fail。
- **用户 config 复验**：用仓库自身 `checkCompressionConfig` / `checkTelemetryConfig` 跑其 `~/.harness/config.json`
  ⇒ 两条告警均清零；并打印翻译结果确认 `subagent` 段确实产出 `{"nudge":{"growthFloor":70000},...}`
  （而不是"配了却不生效"）。
- **文档示例复验**：扫 `docs/*.md` 全部 `jsonc` 片段（22 个）跑校验器 ⇒ 零告警。

### 遗留

- `compaction` 段的未知键告警仍是朴素文案（该段也没有透传口，同属"写错的键没有别的去处"）。
  要不要一并附可用键清单，另议 —— 它现有 2 条用例钉着精确文案，改动要连带更新。

## 2026-09-29（续 220）子 Agent / 指定 Agent 的压缩配置分化（方案 B′ 落地）

### 起因

承续 219 的调研（结论：本仓原本**不能**按子 Agent 单独配压缩，且原因是架构性的 —— `AgentDefinition` 是 typed
schema + 逐字段白名单解析、插件在工厂期闭包冻结配置、子 Agent 不是子进程而是同 Harness 上的会话）。
用户拍板：**按推荐方案（B′），同时考虑只读 Agent 也支持压缩工具**。

### 落地形态（与原推荐方案 B′ 的差异）

原 B′ 是「加一个 `subagent` 档位，用 `toolIds: []` 把压缩工具**从**只读子 Agent 拿掉」。用户要求「只读 Agent
也要能压」后**形态反转**，变成两条**互补**的修复：

| # | 层次 | 改动 |
|---|---|---|
| ① | 配置层 | 给 `reader` / `reviewer` 的 `tools:` **真的授予** 4 个压缩工具（`compress` / `decompress` / `search_context` / `acp_status`，与 `coordinator.md` 既有口径一致） |
| ② | 代码层 | 把「手册按能力边界注入」做成**通用机制**：任何白名单里没有 `compress` 的 Agent 都不再被诱导。这是**治本**，且自动覆盖将来新增的只读 Agent |

### 改动清单

| 文件 | 改动 |
|---|---|
| `plugin/src/index.ts` | `SessionPreModelInput` 新增 `agentTools`（该 Agent 最终可用工具 id，已过白名单 + MCP 供给）与 `parentSessionId`（子会话**可靠**判据） |
| `core/src/index.ts` | `PreparedQuery` 新增 `agentToolIds`（`allowedTools` 的 id 投影，每轮算一次）；`_buildStepMessages` 的 preModel hook 透传两个判别符 |
| `acp-context/src/index.ts` | 新增 `AcpScopeOverride` / `AcpResolvedScope` / `mergeScopeConfig` / `stripWindow` / `agentCanUseCompress` / `scopeFor()`（带缓存）；`manualInjection` 增 `'off'` 档；`runPreModel` 增 `canCompress` 与 `'off'` 两条抑制；`core.harness.start` 新增 `perAgent` key 校验 |
| `cli/src/index.ts` | `compression` 段新增 `manualInjection` / `subagent` / `perAgent`；`checkCompressionScope` 与顶层走同一套校验 |
| `agent/src/index.ts` | **顺带修**（见下"坑 1 / 坑 2"）：`parseBlock` 两分支遇注释行改为跳过；抽 `parseInlineList` 补空保护 |
| `~/.harness/agents/reader.md` `reviewer.md` | tools 白名单 + 正文引导（已备份 `*.bak-20260929-232714`） |

### 关键设计取舍

1. **两个档位都留**：`perAgent[agentId]` > `subagent`（按 `parentSessionId`）> 顶层。二者回答不同问题
   （「凡是派生出来的会话该怎么压」vs「这一种 Agent 该怎么压」）。
2. **判据用 `parentSessionId` 而非 `agent.mode`**：`Session.parentId` 是顶层字段（由 `session.create({ parentId })`
   写入），`meta.parentId` 为 null；按 mode 反推会把"被当子 Agent 派出的 coordinator"误判。
3. **`canCompress === undefined` ⇒ fail-open**：判别符缺失（非 core 宿主 / 单测直调）不抑制。判错代价不对称 ——
   未知时只是多付一份说明书的 token，误判成空集会**静默关掉**一个本来能用压缩的 Agent 的全部提示。
4. **窗口必须由调用方独占**：`defaultConfig(modelContextLimit, overrides)` 里 overrides 的 `modelContextLimit`
   会**盖掉**第一个参数 ⇒ 引入 `stripWindow()` 在 `resolveAcpConfig` 前抹掉。
5. **档位不允许写 `tokenCalibration`**：与 `createCore` 注入的 `countTokens` 是同一把尺子，全进程只能有一份。
6. **`manualInjection: 'always'` 优先于自动抑制**：显式要求不该被自动推断悄悄推翻。

### 两个真实踩坑（都已补回归用例）

**坑 1：注释插在 YAML 序列中间 ⇒ tools 白名单静默截断。** 改完 `reader.md` 后用仓库自身 `agentFromMarkdown`
复验，得到 `tools=["read_file","list_dir","glob","grep_file"]` —— 4 个新工具**全丢**，且无任何告警。
根因是 `parseBlock` 列表分支遇注释行 `break`。修后复验得到全部 8 个。
**这是"改配置后必须用仓库自身解析器验证"的实证。**

**坑 2：`mcpServers: []` 被解析成 `[""]`。** 由坑 1 的新用例顺带炸出来的（断言 `mcpServers: []` 时变红）。
根因：`value.slice(1,-1).split(',')` 在空串上返回 `['']`；而 `parseInlineObject` 当初有 `if (!inner) return {}`
—— 两处内联列表调用点漏了同一保护。长期没浮出水面是因为下游 `parseStringArr` 有 `.filter(Boolean)` 把它抹平。
已抽 `parseInlineList` 补空保护（两处调用点共用）。

### 验证（三段式）

| 段 | 命令 | 结果 |
|---|---|---|
| ① typecheck | `bun run typecheck` | **39 包 0 error** |
| ② 全量测试 | `bun run test` | **39 包全部 `0 fail`**（acp-context 91 / core 181 / cli 407 / agent 39） |
| ③ 反向验证 | 见下 | 3 个实验各按预期变红，恢复后全绿（94 pass / 0 fail） |

反向验证明细（"回退后变红"是断言有效性的唯一证据）：

| 实验 | 摘掉什么 | 变红用例 |
|---|---|---|
| A | `agentCanUseCompress` 恒返 `undefined` | 三态 1 条 + 能力判据抑制 1 条（fail-open 那条**仍绿** —— 正是它测的路径） |
| B | `scopeFor` 的 `layers` 置空 | 档位 3 条（perAgent 生效 / subagent + 优先级 / 窗口两处同源） |
| C | `parseInlineList` 的空保护 | 空数组 1 条 |

### 遗留

- 219 调研指出的**另一处隐性错配**（子 Agent 换到不同窗口的模型时，occupancy 分母仍是默认 Provider 的窗口）
  与本轮无关，**未动**，待独立处理。
- `perAgent` 的 agent id 写错只告警、不阻断（刻意）；若将来要让"配了却完全不命中"成为硬错误，需另议。

## 2026-09-29（续 219）调研：子 Agent 的压缩配置能否单独设（**只写文档，未改代码**）

### 起因

问：`@harness/acp-context` 的压缩方法 / 压缩率能否按子 Agent 单独配置？业界其它 harness 怎么做？

### 核查结论（本仓）

**不能。** 而且不是漏了一个配置项，是形态决定的：

| 事实 | 位置 |
|---|---|
| `compression` 是**全局扁平段**，无 agent 维度 | `packages/cli/src/index.ts:360-432` |
| 插件在 `createAcpContextPlugin()` 期把 `config` / `modelContextLimit` / `countTokens` / `manualInjection` / `systemPrompt` **闭包冻结** | `acp-context/src/index.ts:424-453` |
| 子 Agent **非子进程**（全包无 spawn/fork），与主 Agent 共用同一 Harness、同一份 `internalPlugins` | `subagent/src/index.ts:1107-1112` |
| per-session 只隔离**状态**（`sessions: Map<sessionId,…>`），不隔离**配置** | `acp-context/src/index.ts:463` |

**关键落差**：`SessionPreModelInput` **本来就带 `agentId` / `providerId` / `modelId`**（`plugin/src/index.ts:215-223`），
但 ACP 的 `runPreModel` 只传 `sessionId`，把这三个丢了（`acp-context/src/index.ts:781-801`）⇒ 想按 agent 分支，
**信息全在手边，缺的只是一个 resolver**。工具侧同理：`ToolContext.agentId` 存在，但 `acp_status` 等仍用闭包 `config`。

**顺带查出一处既有隐性错配**：模型可 per-agent / per-spawn 覆盖（`core/src/index.ts:2539-2540`），
但压缩窗口只认**默认 Provider**（`cli/src/index.ts:2717` → `resolveWindowTokens`，`:1530-1533`）⇒ 子 Agent 换到
不同窗口的模型时，occupancy 分母仍是主会话的 ⇒ 阈值整体偏早/偏晚，**无症状**。此项与 per-agent 无关，应独立修。

**一个必避的坑**：`agentFromMarkdown` 是**逐字段白名单解析**，未知 frontmatter 键**静默忽略**
（`agent/src/index.ts:445-560`；唯一的例外是已删字段 `subagents` 保留了告警，`:507-519`）
⇒ 任何"直接在 `reader.md` 写 `compression:`"的方案，不改解析器就是造下一个幽灵配置。

### 调研结论（业内）

- **主流是"上下文隔离 + 摘要回传"**：子 Agent 开新窗口，干完只回摘要 ⇒ 父级手上没有子级原始上下文，
  "谁来压子 Agent"这个问题**不成立**（Claude Code / OpenAI Agents SDK / LangGraph / CrewAI / Google ADK / Manus）。
- **真支持 per-subagent 压缩配置的只有 Codex CLI**，且原因是**架构性**的：它的自定义 agent 文件是
  「spawn 会话的**配置层**」，与 session config **同一套键** ⇒ `model_auto_compact_token_limit` /
  `model_context_window` / `tool_output_token_limit` 天然可按 agent 覆盖。Claude Code 的 agent 定义是
  **固定字段 schema**，压缩键在另一个命名空间（settings.json / env）⇒ 官方明确写"用与主对话相同的逻辑与触发条件"。
  **本仓 `AgentDefinition` 属前者**，所以想加必须显式设计。
- 其余：OpenCode `compaction.{auto,prune,reserved}` 顶层全局；Gemini CLI `model.compressionThreshold` 全局（需重启）；
  Aider 是**按模型**配置（`--map-tokens` / `--max-chat-history-tokens` / `--weak-model` 摘要专用模型）；
  Anthropic API 的 `context_management` 是 **per-request**，天然可按 agent 换策略（含 `compact_20260112` 的
  `instructions` / `pause_after_compaction`）；LangGraph 的 `SummarizationNode` 挂在子图上 ⇒ 天然 per-agent。

### 产出

- 新增 `docs/subagent-compression-config-research.md`：现状核查（含行号级证据）/ 业内总表 + 三种"谁压谁"模式 /
  「为什么 Codex 能而 Claude Code 不能」架构对照 / 四个方案（A per-agent、B frontmatter、**B′ 子 Agent 档位（推荐）**、C 不做）+
  取舍表 / B′ 的三段式验证要点 / 三条未决项。
- `docs/acp-context-config.md` 顶部加一行交叉引用（明确"本文所有配置项都是全局的"）。
- **未改任何代码**；方案 B′ 的判据（`parentId` vs `agentId`）、默认值、`toolIds: []` 是否误伤属产品口径，建议先议后动。

## 2026-09-29（续 218）`guardInput` 跨包共用：glob 的守卫收拢（"口径决策"被证伪）

### 起因

续 217 的遗留写着"`glob` 的守卫仍是自带一份 —— 要收拢得先决定『非 pattern 的结构错该报什么码』（口径决策，不是机械改动）"。

**这个判断是错的。** 把两处判据摊开对齐后，它们是**逐字同构**的：

| | 判据 | 专用码 | 其余 |
|---|---|---|---|
| `guardInput` | `rule === 'required' && path === requiredField` | `requiredCode`（调用方给） | `INVALID_INPUT` |
| glob 内联守卫 | `rule === 'required' && path === 'pattern'` | `GLOB_PATTERN_MISSING` | `INVALID_INPUT` |

`guardInput(globInputSchema, input, 'pattern', 'GLOB_PATTERN_MISSING')` 与现状**行为完全一致** ——
没有任何码需要新决定。真正的阻碍是**工程性**的：`guardInput` 当时是 `tools-builtin` 的模块私有函数，
glob 在另一个包里根本调不到。

### 改动

| 位置 | 改动 |
|---|---|
| `packages/tool/src/index.ts` | 新增并导出 `InputGuardResult<T>` + `guardInput<T>()`（JSDoc 从 tools-builtin 迁来，改写成跨插件口径） |
| `packages/plugins/tools-builtin/src/index.ts` | 删掉私有副本，import 改取 `@harness/tool`；`Schema` / `formatSchemaError` / `schemaIssues` 三个导入随之不再需要 |
| `packages/plugins/tools-glob/src/index.ts` | `call()` 内联守卫（约 18 行）→ 一行 `guardInput(...)`；`formatSchemaError` / `schemaIssues` 导入移除 |

放在 `@harness/tool` 而不是某个插件里的理由：它天然跨插件（`tools-builtin` 的四个工具 + `tools-glob`），
且它依赖的 `formatSchemaError` / `schemaIssues` 本来就在那个模块 —— 搬家不产生任何新的依赖方向。

### 反向验证：1 组，且续 217 的归因模板在这里被打破

摘掉 glob 的守卫返回后，**只有 1 条**变红：

```
tools-glob.test.ts:170  Expected: "INVALID_INPUT"  Received: "GLOB_PATTERN_MISSING"
```

**"pattern 缺失 / 全为空 ⇒ `GLOB_PATTERN_MISSING`"那条仍然绿 —— 而且这是对的**：
glob 的"缺 pattern"有**双防线且同码** —— 结构守卫给 `GLOB_PATTERN_MISSING`，`call()` 尾部的语义守卫
（`rawPatterns.filter(isUsable).length === 0`）也给同一个码（刻意如此，消费方不必区分来源）。
摘掉结构守卫，语义守卫照样兜住它。

⇒ **判据**：写反向验证前先想清楚"哪条**应该**红"。存在同码双防线的工具（glob 就是），
"缺必填 ⇒ `XXX_REQUIRED`"那类用例**不构成**守卫存在的证据；真正在证明它的是
"类型不符 / 其它字段结构错 ⇒ `INVALID_INPUT`"那两条。这与续 217 的 E1（"仍然绿是对的"）是同一类归因。

### 验收

`typecheck` 39 包 0 error；全量 `test` **2034 → 2034** pass / 0 fail —— **数字一动不动**，
既有零改动的用例就是"纯搬家、零行为变更"的控制组。

- 反向验证脚本：先 `cp` 备份 + `shasum -a 256` 记基线，还原后 `diff` 断言"与基线快照逐字节一致"
  （续 216 的教训：同文件多补丁的备份会互相覆盖，还原可能留下"仍能编译通过"的中间态）
- 顺带勘误：全量测试必须用 `bun run test`（根脚本是 `bun --filter=* run test`）。
  裸 `bun test` 会从仓库根递归抓测试，把 805 个文件 / 3238 条用例（含本仓之外的 DOM 相关测试）一起跑出来
  ⇒ 2631 pass / 607 fail，看着像大面积回归，实则命令用错

### 遗留

- `UsageStats` 的 provider 维度、`unregister` 级联、`_setChatProvider` 最终删除（承续 213）
- 结构层错误码现状：`INVALID_INPUT` / `PATH_REQUIRED` / `COMMAND_REQUIRED` / `GLOB_PATTERN_MISSING`
  四个，全仓唯一入口 `guardInput`（`@harness/tool`）

## 2026-09-29（续 217）入参守卫收拢：三份形态 → 一份 `guardInput`

### 起因

续 216 的遗留：bash 的守卫当时**内联**着写，形态与 `guardPathInput` 一致、代码却各有一份。
`glob` 因错误码口径不同（`GLOB_PATTERN_MISSING` 只对应 pattern 缺失）不参与收拢。

### 改动

| 位置 | 收拢前 | 收拢后 |
|---|---|---|
| `read_file` / `write_file` / `edit_file` | `guardPathInput(schema, input, 'PATH_REQUIRED')` | `guardInput(schema, input, 'path', 'PATH_REQUIRED')` |
| `bash` | 内联（`safeParse` + `rule` 判据 + 两档码，约 15 行） | 同一个助手，`'command'` / `'COMMAND_REQUIRED'` |
| `bashInputSchema` | 工厂函数体内（只为让 `call()` 复用） | 模块级常量（与三兄弟同形） |
| `glob` | 自带一份（码口径不同） | 不变 |

签名 `guardInput<T>(schema: Schema<T>, input: unknown, requiredField: string, requiredCode: string)`。
把"字段名"与"错误码"都提成参数、而不是让助手写死 `'path'` —— 因为"缺哪个字段""对外报哪个码"是**工具自己的契约**，
助手只负责"怎么判"。这也让 bash 与三兄弟的调用点长得完全一样。

**`bash_ro` 仍不接**：它的 `call()` 第一行是 `checkReadOnlyCommand(input?.command, allowlist)`，
内部 `String(command ?? '')` 已把缺失/非字符串归一成空串并返回 `COMMAND_REQUIRED` —— "非空"是那个语义校验器
契约的一部分，与 schema 不重复。

### 顺手修掉一处注释错位

续 216 插入 `JsonSchemaRule` 时，把它放在了 `JsonSchemaIssue` 的 JSDoc 与 `interface` 之间 ⇒
"单个校验问题。`message` 会被 `ToolSchemaError` 拼进错误文本…"这段文档挂到了 `JsonSchemaRule` 头上，
而 `JsonSchemaIssue` 反而失去了自己的文档。已各归其位。

### 反向验证：4 组，全部按预期命中

| 实验 | 摘掉什么 | 变红 |
|---|---|---|
| E1 | bash 的结构守卫（退回历史手写 `typeof` 形态） | 3（两条类型错 + 新用例） |
| E2 | 助手的 `rule === 'required'` 判据（退回只看 `path`） | 2（bash **与** read_file，跨工具） |
| E3 | bash 的语义判据（纯空白 command） | 2（既有空串用例 + 新用例） |
| E4 | `requiredCode` 写死成 `INVALID_INPUT` | 5（四个工具的"缺必填码"全红） |

两点归因要写清楚：
- **E1 里"缺 command ⇒ COMMAND_REQUIRED"仍然绿是对的** —— 历史手写守卫也拦得住它。这条实验证明的是
  "结构判据（性质分流 + 消息来源）由 `guardInput` 提供"，不是"缺必填只有它拦得住"。
- **E2 / E4 的红都是跨工具同时红** —— 判据与码各只有一份，改一处必影响多处，这正是收拢想要的效果。

### 验收

`typecheck` 39 包 0 error；全量 `test` 2033 → **2034** pass / 0 fail。
新增 1 条用例锁的是**两段式的边界**：同一个码 `COMMAND_REQUIRED` 有两个来源 ——
缺 command 由 schema 派生（message 含"缺少必填参数"），纯空白由 `call()` 内手判（message 是手写的）。
既有 92 条一字未改即全绿，是"重构未改行为"的控制组。

### 遗留

- `glob` 的守卫仍是自带一份 —— 要收拢得先决定"非 pattern 的结构错该报什么码"（口径决策，不是机械改动）
- `UsageStats` 的 provider 维度、`unregister` 级联、`_setChatProvider` 最终删除（承续 213）

## 2026-09-29（续 216）直调入参守卫 + 守卫判据的结构化（rule）

### 起因

续 215 遗留第 2 项：`read_file` 的**直接调用**仍是裸 `resolvePath(input.path)` —— 生产路径已被管道
Step 1 保护，但"越过管道直调 `tool.call()`"仍会抛 `TypeError`。核对发现 `write_file` / `edit_file`
完全同构（用户裁决：**三兄弟一起修**）。

### 根因：三处一行代码，叠了三个条件

| 工具 | 位置 | 现状 |
|---|---|---|
| `read_file` | `call()` 第一行 | `resolvePath(input.path, ctx.cwd)` |
| `write_file` | 同上 | 同上 |
| `edit_file` | 同上 | 同上 |

叠了三个条件才成为真问题：

1. `resolvePath` 内部先做 `isAbsolute(inputPath)` —— `undefined` / `null` / 数字 / 对象全抛
   `TypeError: The "path" property must be of type string`（实测四种全抛）；
2. 那行在 `try` **之外**（`try` 要到 `stat` 才开），异常不被下面的 catch 收敛 ⇒ **直接冒泡**给调用方；
3. 权限引擎的 `permission.extractPatterns: (input) => [input.path]` 排在 `call()` 之前 ⇒ 先拿到 `[undefined]`。

管道路径不受影响（Step 1 用 `readFileInputSchema` 拦了，`tools-builtin.test.ts:231` 有用例锁定）。

### 形态：一个共用助手，而不是三份守卫

三处同构 ⇒ 抽 `guardPathInput(schema, input, requiredCode)`（`tools-builtin/src/index.ts`）。
三个工具的 `inputSchema` 因此从内联提到模块级常量（`readFileInputSchema` / `writeFileInputSchema` /
`editFileInputSchema`）—— `call()` 复用的就是**喂给模型的那一份**，规则只留一份。
错误码：缺 `path` ⇒ `PATH_REQUIRED`（与 `COMMAND_REQUIRED` / `GLOB_PATTERN_MISSING` 同构，
模型从码名就能读出少了哪个参数），其余结构问题 ⇒ `INVALID_INPUT`。

`bash` 的内联守卫形态与此完全一致，**本次未动**（它有自己成型的历史注释与两段式结构），
可后续收拢 —— 属可选改动。

### 实施中发现的新缺陷：判据分不清"缺"与"类型错"

写测试时实测发现：`read_file.call({ path: 123 })` 得到 `PATH_REQUIRED`，而消息写着
`path 应为 字符串，收到 数字` —— **码说"缺"、消息说"类型错"，自相矛盾**。

根因：`JsonSchemaIssue` 只有 `{ path, message }`，而"缺必填"（`childPath(at,key)`）与
"类型不符"（`properties` 循环里 `at` 已降级为 `key`）的 `path` **完全相同**。
上一轮的 bash 守卫用的是 `i.path === 'command'`，同一个缺陷 —— 只是那条用例恰好错在
**另一个字段**（`timeoutMs: 'soon'`，`command` 本身合法）而绕过了它。

修法（用户裁决：**加结构化判据**）：`JsonSchemaIssue` 增可选 `rule`，取值
`required | type | enum | union | additional | items | length | range`，11 个 `issues.push` 点全部标注。
三处守卫改判 `i.rule === 'required' && i.path === X`。**不判 `message`** —— 文案会改，判据会静默失效。

顺带修正 `glob` 的过宽判据：它原来是"任何结构错 ⇒ `GLOB_PATTERN_MISSING`"，现在缺 `pattern` ⇒
`GLOB_PATTERN_MISSING`、其它字段错 ⇒ `INVALID_INPUT`。这条改了既有测试的一条期望 ——
原用例把"`pattern: {}` 类型错"和"缺 pattern"混在一起断言同一个码。

### 改动清单

| 文件 | 改动 |
|---|---|
| `packages/tool/src/index.ts` | `JsonSchemaRule` 类型 + `JsonSchemaIssue.rule?` + 11 个 push 点标注 |
| `packages/plugins/tools-builtin/src/index.ts` | `guardPathInput` 助手；三处 schema 提模块级；三处 `call()` 接守卫；bash 判据改 rule |
| `packages/plugins/tools-glob/src/index.ts` | 结构守卫判据改 rule，错误码按性质分流 |
| 三个包的测试 | tool +2、tools-builtin +6、tools-glob 重构 1 组断言 |

### 反向验证：5 组实验

| 实验 | 摘掉什么 | 变红的用例 |
|---|---|---|
| E1 | `read_file` 的守卫调用 | `read_file 缺 path ⇒ PATH_REQUIRED（不再是 TypeError）` + `path 类型不符` |
| E2 | `guardPathInput` 里的 `rule === 'required'` | `read_file 的 path 类型不符 ⇒ INVALID_INPUT` |
| E3 | bash 守卫的 `rule === 'required'` | `bashTool：必填字段**本身**类型不符 ⇒ INVALID_INPUT` |
| E4 | glob 的码分流（退回一律 `GLOB_PATTERN_MISSING`） | `结构不合法 ⇒ 码反映失败的性质` |
| E5 | `required` 那条 issue 的 `rule` 标注 | `fromJsonSchema：缺必填 ⇒ rule=required` |

E1 的红是**必须**的：那条用例的措辞就是"不再是 TypeError"，摘掉守卫即回到 `TypeError`。
E2/E3 证明 `rule` 判据真的在起作用（不是碰巧）；E5 证明 `rule` 字段本身是判据的依据。

脚本仍用"基线快照 + 每轮从快照重写"的还原方式，并断言结束时四个文件与快照**逐字节一致**
（续 215 的教训：同文件多补丁互相覆盖备份，会留下**仍能编译通过**的中间态）。

### 验收

- `bun run typecheck`：39 包 0 error
- `bun run test`：39 包 0 fail，2025 → **2033** pass（tool +2、tools-builtin +6）
- 反向验证 5 组全部命中预期；还原复验三包全绿

### 遗留

- `bash` 的内联守卫可收拢进 `guardPathInput`（形态已一致，属可选改动，按惯例先不动）
- `UsageStats` 的 provider 维度、`unregister` 级联、`_setChatProvider` 最终删除（承续 213）

## 2026-09-29（续 215）入参字段 ↔ schema properties：全量核对 + 编译期守卫

### 起因：上一轮那条"意外收获"

续 214 的 E3 实验暴露出 glob 的 schema 少了 4 个字段，当时留作遗留第 1 项：**运行期容忍所以不断功能，
但模型发现不了这些参数**。本轮把它做成全量核对，并设法让这类漂移不可能再发生。

### 核对方法

写脚本解析每个 `fromJsonSchema<T>({...})` 的 `properties` 顶层键与对应 `interface XInput` 的字段，
双向比对（缺 / 多 / required 越界）。两个必须处理的解析坑：

- **`required` 只能取顶层的**：`compress` 的 schema 在数组 `items` 里还有一层
  `required: ['startId','endId','summary']`，正则取第一个命中会误报 4 处"假不对齐"；
- **同一个类型名会出现两次**：`bash` 与 `bash_ro` 都用 `BashInput`，按类型名建字典会互相覆盖，
  必须按出现次序编号 —— 正是这次覆盖把 `bash_ro` 少 `env` 那一处藏了起来。

### 结论：29 个 schema、3 处不对齐

| 工具 | 性质 | 缺的字段 |
|---|---|---|
| `glob` | **真漏** | `exclude` / `minSizeBytes` / `maxSizeBytes` / `maxDepth` |
| `web_fetch` | **真漏** | `followRedirects` / `maxResponseBytes` / `allowPrivateNetwork` |
| `bash_ro` | **刻意**，但类型比契约宽 | `env` —— 只读工具不接受入参覆盖环境变量 |

其余 26 个（含 4 处 ACP、10 处 swarm、4 处 code-intel）字段与 properties 一一对应，`required` 无一越界。

`bash_ro` 那处不是 bug 而是**表达问题**：注释写明"ENV 是绕过只读的常见后门（`PYTHONSTARTUP` /
`NODE_OPTIONS` 都能让只读命令执行任意代码）"，所以 schema 少 `env` 是对的；错的是它的入参类型仍声明
`BashInput`（含 `env?`）—— 后果是模型传 `env` 会被**静默忽略**，且没有任何机制能表达"这里少一个字段是故意的"。

### 形态：把对齐做成**编译期**约束

三个选项：

| 方案 | 判定 |
|---|---|
| 运行时断言 | **写不出来** —— 接口字段是类型层面的东西，运行期拿不到 |
| 独立审计脚本进 CI | 可行，但要为 Bun/TS 仓引入 Python 依赖与一份"自己解析 TS"的脆弱代码，且与 typecheck 分属两道闸 |
| **入参类型约束（选用）** | 漏声明恰好只在类型层面可判 ⇒ 与 `bun run typecheck` 同一道闸，零运行时成本、零新增基建 |

新增 `JsonSchemaFor<T>` 作为 `fromJsonSchema` 的入参类型，两个分支：

```ts
export type JsonSchemaFor<T> =
  | { type: 'object'
      properties: { [K in keyof T & string]: unknown }   // 逐个覆盖 keyof T，多一个少一个都编译不过
      required?: Array<keyof T & string>                 // required 也不能列接口外的键
      additionalProperties?: boolean
      [k: string]: unknown }
  | { type: 'object'; oneOf: unknown[]; [k: string]: unknown }   // 多模式豁免（code_semantic_edit 顶层无 properties）
```

**"故意不暴露某字段"的正解不是删 schema 字段，而是收窄入参类型** —— `bash_ro` 改用
`export type ReadOnlyBashInput = Omit<BashInput, 'env'>`，把这个安全决定写进类型，schema 与类型才一致。

### 反向验证：5 组实验逐条归因

| 实验 | 期望 | 实际 | 报错包 | 码 |
|---|---|---|---|---|
| E1 摘掉 glob 的 `maxDepth` | error | error ✓ | `@harness/tools-glob` | TS2345 |
| E2 守卫退回松散 `JsonSchemaObject`（负向用例一并摘掉） | **no-error** | no-error ✓ | 无 | 无 |
| E3 `bash_ro` 入参改回 `BashInput` | error | error ✓ | `@harness/tools-builtin` + `@harness/core` | TS2345 |
| E4 摘掉 web_fetch 的 `allowPrivateNetwork` | error | error ✓ | `@harness/tools-web` | TS2345 |
| E5 `required` 约束放松成 `string[]` | error | error ✓ | `@harness/tool` | TS2578 |

两条值得单说：

- **E2 是最关键的一条**：守卫一旦退回松散形态，那个漏字段**完全没人拦**（连 TS2345 都没有）——
  证明抓到它的确实是守卫本身，而不是别的什么。若只做 E1 不做 E2，"是守卫在拦"这个结论其实没有证据。
- **E3 的报错跨了两个包**：`@harness/core` 也红，因为 root `tsconfig` 用 paths 直接映射到
  tools-builtin 的**源码**（非 dist）⇒ 一处类型不符会顺着路径映射往上传染。这是好事（改错立刻可见），
  但也意味着**工具包的类型改动会让无关包一起变红**，归因时要认得出来。

### 脚本自身的两个坑（值得记）

1. **macOS 的 BSD grep 不支持 `\|` 交替**：`grep "a\|b"` 会当成字面量，静默返回空 ——
   一度误判"type 定义被删了"。跨模式搜索一律用 ERE（`grep -E`）或专用工具。
2. **反向验证脚本在同一文件打多处补丁时，第二轮备份会覆盖第一轮** ⇒ 还原时留下"补丁一已生效、
   补丁二未生效"的中间态。危险在于**这个中间态仍然能编译通过**，只看末尾 typecheck 的 exit code 抓不到。
   修法：同文件只记**最初**快照，并在末尾对全部被触碰文件做一次"与快照逐字节一致"的断言。

### 验收

`typecheck` 39 包 0 error；全量 `test` 39 包 0 fail，2022 → **2025** pass（tool +3：两条 `@ts-expect-error`
负向用例 + 一条 oneOf 豁免的正向对照）。审计脚本**未入库**：编译期守卫已覆盖全部静态工具的**双向**对齐，
脚本只剩"跨文件接口 + 动态工具"的报告价值，为此在 Bun/TS 仓里长期养一份 Python 不划算（方法记录在本文）。

### 遗留

1. `read_file` 的**直接调用**仍是裸 `resolvePath(input.path)`（生产路径已被管道 Step 1 保护）—— 承续 214。
2. `UsageStats` 的 provider 维度、`unregister` 级联、`_setChatProvider` 最终删除 —— 承续 213。

## 2026-09-29（续 214）工具入参运行时校验：从 JSON Schema 派生 + 30 个工具迁移

### 起因：三层落差

核对"工具定义有没有类似 zod 的运行时校验"，答案是**有拟 zod 的接口、有真实执行点，但没有字段级校验**：

| 层 | 事实 | 判定 |
|---|---|---|
| 接口层 | `Schema<T> = { parse, safeParse, __jsonSchema? }`（`packages/tool/src/index.ts`），注释写"兼容 zod / valibot / 自定义校验" | zod 只是**形状目标**：全仓无 zod（`bun.lock` 零命中、`node_modules/zod` 不存在、`acp-kernel` 的 `safeParse` 只是它自己 5 行 `JSON.parse` 帮手） |
| 执行层 | `ToolPipeline.execute` Step 1 真调 `inputSchema.safeParse(rawInput)` → 失败抛 `ToolSchemaError(stage='input')`；Step 6 校 outputSchema | **真的会抛**，且经 `_throwToolFailureWithHooks` 归一化后喂 PostHook ⇒ 遥测 `tool.fail` 看得到 |
| 内容层 | 10 个包各自抄了一份 `makeSchema<T>()`，`safeParse` **恒返回 `success: true`** | 对内置工具 Step 1 就是 **no-op**。`tool.validateInput` 接口在，但**全仓零实现** |

结果：字段级把关其实没人做，全靠工具 `call()` 里手写守卫（`COMMAND_REQUIRED` / `GLOB_PATTERN_MISSING`），
而 `read_file` 连守卫都没有 —— 缺 `path` 时 `resolvePath(undefined)` 在 `call()` 里抛 TypeError。

三类失败三种表现，正是这次要收掉的。

### 形态：从 JSON Schema **派生**，而不是另写一套 DSL

新增 `fromJsonSchema<T>(schema, opts?)`：走一遍已有 JSON Schema 做运行时校验，并把它挂成 `__jsonSchema`。

选它而不是字段 DSL / zod 的理由：

- **单一取源**：`__jsonSchema` 本来就是"给模型看的唯一参数来源"（openai / anthropic / gemini 三个适配器都读它）。
  再声明一份运行时规则就是**两份真值会漂移**；派生之后一处声明同时决定"模型看到什么"与"运行期接受什么"。
- **模型侧载荷字节级不变**（`__jsonSchema` 就是传入的那个对象，测试锁 `toBe`），provider 适配层零回归风险。
- **逐工具改动只有一行**：`withJsonSchema(makeSchema<X>(), {` → `fromJsonSchema<X>({`（收尾的 `}),` 都不用动）。
- 沿用仓里"不依赖 zod"的一贯约定。

覆盖关键字 = 现网工具实际用到的**全集**（`type`/`properties`/`required`/`additionalProperties`/`items`/
`oneOf`/`anyOf`/`enum`/`minimum`/`maximum`/`minLength`/`maxLength`/`minItems`/`maxItems`）；
**未识别的关键字一律放行**（宁可漏拦，不可误杀 —— `pattern`/`format` 不参与运行期校验）。

### 严格度的三档取舍（用户裁决）

| 项 | 取值 | 理由 |
|---|---|---|
| 缺必填 / 类型不符 / 枚举越界 | **拒** | 真机的主要失败形态（`read_file` 发过 14 次 `input:{}`） |
| 多余字段 | **容忍**（默认） | ① 模型偶尔带无害冗余，拒它等于凭空造一类新失败；② `oneOf` 多模式的 schema **刻意省略 `properties`**（`JsonSchemaObject` 注释明写），一律拒会误伤合法入参 |
| `additionalProperties:false` 真生效 | `strictProperties: true` 显式开 | 需要与"给模型看的声明"完全一致时才付这个代价 |

**第 2 条不是想当然 —— 是 E3 实验打出来的**：把默认改成拒绝后，`glob` 的
`exclude 参数便捷字段` 与 `文件大小过滤` 两条既有用例直接变红。查下来是 `GlobInput` 有 8 个字段、
而 glob 的 JSON Schema 只声明了 4 个 —— **`exclude` / `minSizeBytes` / `maxSizeBytes` / `maxDepth`
是"工具接受、但没告诉模型"的**。若当初选了"多余字段也拒"，这个功能当场断掉。

### 30 个工具迁移（10 个包）

tools-builtin 5、swarm 10、code-intel 4、acp-context 4、tools-search 2、tools-glob 1、tools-web 1、
tools-media 1、subagent 1、coordinator 1。同时删掉各包本地重复的 `makeSchema`（三种变体：多行 /
单行返回 / 紧凑单行方法）与随之失效的 `withJsonSchema` / `Schema` 导入。

> `withJsonSchema` 本身**保留**（`tool.test.ts` 有用例锁定它"只追加 `__jsonSchema`、不改变
> parse/safeParse 行为"）。它的定位收窄为"已自带 safeParse、只想补一份模型可读描述"，如
> mcp-client 透传服务端 schema；mcp-client 不在本次 30 个之内（动态工具，schema 来自 server）。

### 守卫**没有删**，而是改成由同一份 schema 派生

原计划是"删掉重复守卫"，核对后发现删不得：`tools-builtin.test.ts:198` 与 `tools-glob.test.ts:157`
都是**直接调 `tool.call()`**，绕过管道 —— 守卫是"越过管道那条路径"的防线，删掉会红测试，
并把 `bash: undefined: command not found` 的真机 bug 放回来。

于是改成**两段式**，规则只留一份：

```ts
const parsedInput = bashInputSchema.safeParse(input)   // 结构：与管道 Step 1 同一份 schema
if (!parsedInput.success) {
  const missingCommand = schemaIssues(parsedInput.error).some((i) => i.path === 'command')
  return { ok: false, error: {
    message: formatSchemaError(parsedInput.error),
    code: missingCommand ? 'COMMAND_REQUIRED' : 'INVALID_INPUT',
  } }
}
if (parsedInput.data.command.trim() === '') { /* 语义：JSON Schema 表达不了，留手判 */ }
```

- 对外错误码不变（`COMMAND_REQUIRED` / `GLOB_PATTERN_MISSING`），既有用例与消费方零改动；
- schema 因此被提到模块级（glob）或工厂函数局部（bash），`call()` 复用的就是喂给模型的那一份；
- glob 的"全空白 / 空数组"判断保留 —— 那是 `if (!pat) continue` 静默跳过 ⇒ 兜底成全仓遍历的入口，
  JSON Schema 表达不了"非空白"。
- `bash_ro` 未动：它的 `checkReadOnlyCommand` 是**语义**校验器（白名单 + 写通道检测），
  非空判断只是它自己契约的一部分，不算 schema 的重复。

### 反向验证：4 组实验逐条归因

| 实验 | `@harness/tool` | tools-builtin | tools-glob |
|---|---|---|---|
| **E1** 摘掉 `required` | 6 红：缺必填 / oneOf 两分支 / parse 抛出 / formatSchemaError / schemaIssues / Pipeline 缺必填 | 2 红：bash 缺 command、read_file 空入参 | **0 红** |
| **E2** 摘掉类型检查 | 3 红：类型不符 / 数组 items / `additionalProperties` 为对象 | 1 红：类型不符 ⇒ INVALID_INPUT | 1 红：结构不合法（message 断言） |
| **E3** 多余字段改成默认拒 | 1 红：多余字段容忍 | 1 红：控制组 | **2 红**：exclude 便捷字段、文件大小过滤 |
| **E4** 回到恒过 schema | 12 红 | 3 红 | 1 红 |

两条值得单独记：

- **E1 的 glob 0 红不是遗漏，是真实归因**：`pattern` 缺失时 schema 虽放行，但 `rawPatterns` 过滤后为空
  ⇒ 仍走语义守卫返回 `GLOB_PATTERN_MISSING`。那条断言测的是"**拒绝静默退化**"，不是"required 生效"，
  所以对 required 不敏感是正确的。
- **E4 是迁移有效性的总证据**：把校验器还原成恒过，三个包合计 16 条用例变红 ⇒ `fromJsonSchema`
  确实接在了执行路径上，不是装饰。

### 验收

`typecheck` 39 包 0 error；全量 `test` 39 包 **0 fail**，2000 → **2022** pass（+22：tool +19、
tools-builtin +3、tools-glob +1）。反向验证后源码已还原并复测三包全绿。

### 遗留（未做，等发话）

- **glob 的 schema 不完整**（上表 E3 暴露）：`GlobInput` 8 字段 vs schema 4 字段，
  `additionalProperties:false` 等于在告诉模型"没有 exclude / minSizeBytes / maxSizeBytes / maxDepth"。
  运行期容忍所以不断功能，但**模型发现不了这 4 个参数**。建议按"tool schemas 补全"主线做一次
  全量核对（input 接口字段 ↔ schema properties），本次只确证了 glob 一处。
- `read_file` 的**直接调用**仍是裸 `resolvePath(input.path)`：生产路径已被 Step 1 保护，
  但越过管道直调仍会抛 TypeError。是否补守卫未定（倾向先不动，与 bash/glob 的处理保持一致需要评估）。
- `UsageStats` 的 provider 维度、`unregister` 级联、`_setChatProvider` 最终删除（承续 213）。

## 2026-09-29（续 213）运行期注册 S3：事件归属、来源列、实例数、端点维度

S1+S2 把「运行期注册」的能力与守卫补齐之后，S3 收口在**可观测与展示**：把已经存在的
事实接进可观测面，并补掉两处「事实缺维度」的缺口。方案 `docs/runtime-registration-plan.md` §9；
提交 `10e9afd`。

### 计划里写的 S3-1 其实早就成立 —— 问题在别处

计划 S3-1 是"bus 事件接 telemetry 插件"。核对发现 telemetry 用的是 `subscribeAll` **通配**
订阅（`packages/plugins/telemetry/src/index.ts::install`），`ProviderEvents` / `AgentEvents`
一直会落成 `telemetry.bus.provider.*` —— 这半件事不用做。

真正的问题：`resolveMiss` 的载荷只有 `{ requested, fallbackId }`，**没有会话归属**，而遥测
按 `attrs.sessionId` 分文件 ⇒ 它必然落进 **run 级** `run.telemetry.jsonl`。而「配置指向了不
存在的实例」恰恰是**轮内**发生的事（`_runStep` 里 `sessionId` / `agentId` 就在手边）
⇒ **按会话取证时"静默回退"永远看不见**。

这跟 `map.ts` 里已经记过一次的坑完全同源：

| | 事件 | 丢的东西 | 后果 |
|---|---|---|---|
| 先例 | `telemetry.tool.fail` | `sessionId`（79 条全为 undefined） | 9 个会话文件合计 0 条工具失败 —— 而工具失败最需要会话归属 |
| 本轮 | `provider.resolveMiss` | `sessionId` / `agentId` | 静默回退只在 run 级文件里，按会话查不到 |

改法：`ProviderRuntime.resolve(id, ctx)` + `HarnessImpl.resolveChatProvider(id, ctx)` +
`_runStep` 传 `{ sessionId, agentId }`。新增 `ProviderResolveCtx`，与注册侧的
`ProviderInstanceMeta` **刻意分开**：后者是"实例怎么来的"（写进注册表、长期有效），
前者是"这次解析谁发起的"（只进当次载荷）—— 合在一起会让同一次注册被不同会话的解析反复改写归属。

### 遥测语义化的判据：错误状态 vs 正常事实

`mapBusEvent` 原本只认 `harness.error`（`ERROR_NAMES`）。改成 `SEMANTIC_KINDS` 映射表，
新增 `provider.resolveMiss` → `telemetry.provider.resolveMiss`，并把 `requested` 提到标准
`attrs.provider` 维度（原名保留，只加不改）。

判据不是"重要与否"：注册 / 反注册 / 默认变更是**正常事实**，落通用 `telemetry.bus.*`
就够（本就该按时间线读）；resolveMiss 会让模型请求**悄悄换一个 Provider 去发**、表面完全
正常，不独立成 kind 就会被同类正常事实淹没。配了控制组断言（`provider.registered` 仍走通用）。

### 展示层的两处收口

| 命令 | 改前 | 改后 | 判据 |
|---|---|---|---|
| `/model ?` | 只有 type/baseUrl/model/key | 增 `来源=plugin:provider.x`（未装配时 `来源=未注册`） | **来源回答「谁把它装上去的」，不是配置意图** —— 只有它能区分"配置写了却没装配" |
| `/plugins` | 只列插件 | 增 `已注册 Provider 实例 N：…（默认）` / `已注册 Agent M` | **装了什么插件 与 注册了什么实例是两个维度**：装了可能一个实例都没注册，一个插件也能注册多个实例 |

两处都做了"没信息就不展示"：`/model` 在 boot 前（harness 未建）不做交叉、不出该列；
`/plugins` 的 `HarnessView.providers` / `agent` 是可选字段，老宿主不注入就不报这一行
（而不是报 0）。

### openai / glm / qwen 迁移

三包是同一模板，照 anthropic / gemini / mock 的范式改「新路径优先、老宿主回退」。
迁完只剩第三方桩走老路径 —— `cli.test.ts` 里用 `_setChatProvider` 的 my-gw 桩正好成了
**回退分支的活证据**，一次断言里同时成立两件事。

### 原风险 R5：用量口径会不会串

**结论：会。** `UsageStats` 的维度是 model / agent / tool / hourly，**没有 provider**；
而 `ProviderConfig` 明确支持「同一模型挂多个端点」，此时 **model 名重复** ⇒ 用量与缓存行
在端点之间不可区分。

处置**刻意分两半**：

| 动作 | 做不做 | 理由 |
|---|---|---|
| `LlmUsageSignal` 增 `providerId` + `_runStep` 带上 | 做 | 纯增量；core 本来就知道这个事实，不带才是丢信息 |
| ACP `providerCache` 行增 `providerId` | 做 | 最常被消费的遥测行（bench 脚本用它），收益最大 |
| `UsageStats` 加 provider 维度 | **不做** | 那是**落盘格式变更**（`session.meta.usageStats`），影响旧会话恢复与展示层 —— 留给独立决策 |

ACP 行里 `providerId` 用 `null` 而非 undefined：**`null` 与「字段不存在」是两种意思**，
后者会让消费方怀疑是采集漏了。

### 一个"忠实"反而错的细节：哨兵 `'default'`

`prepared.providerId` 的兜底是 `'default'`（`_runStep` 与 `providers.resolve` 都拿它当
"未指定 ⇒ 走默认"的**哨兵**，注册表里**没有**这个键）。首版实现直接 `...(providerId ? {providerId} : {})`
⇒ 未绑定 providerId 的 agent 落了 `providerId: 'default'`，等于**凭空造出一个叫 default 的端点**。

改法：`providerId !== 'default'` 才带。这条是反向验证第 ⑩ 条测出来的 —— 先按"忠实反映引擎口径"
写了一版，被断言纠正。**"忠实"不等于"正确"：落进事实载荷的 id 必须在对应注册表里查得到。**

### 反向验证：10 条逐条归因

| # | 摘掉什么 | 变红的用例 |
|---|---|---|
| ① | `_runStep` 的归属透传 | 仅"轮内 providerId 未命中" |
| ② | `ProviderRuntime.resolve` 的 ctx 合并 | 仅 2 条归属用例 |
| ③ | resolveMiss 语义化 | 仅 2 条 resolveMiss 用例 |
| ④ | `requested → provider` 维度映射 | 同 2 条（不同断言） |
| ⑤ | `listConfiguredProviders` 的来源交叉 | 仅 `/model ?` 用例 |
| ⑥ | `/plugins` 实例数输出 | 仅 `/plugins` 用例 |
| ⑦ | glm 退回老路径 | 仅"内置 Provider 类型全部走运行期注册表"（**功能用例仍绿** ⇒ 测的是"来源可区分"而非"功能坏了"） |
| ⑧ | `core.llm.usage` 的 providerId | 仅 usage 用例 |
| ⑨ | ACP 透传 providerId | 仅 providerCache 行用例 |
| ⑩ | 去掉哨兵归一 | `toBeUndefined()` 收到 `"default"`（**先红后绿 = 这条返工**） |

### 收尾

- `typecheck` 39 包 0 error；全量 `test` 39 包 0 fail（**1992 → 2000** pass / +8：
  core +3、cli +1、telemetry +3、acp-context +1）
- `AGENTS.md` 新增四条：事实事件必须带会话归属（否则落 run 级文件）；遥测语义化的判据；
  哨兵值不是实体 id；以及把"两处都做了'没信息就不展示'"这条口径固化在展示层约定里
- 剩余未做：`UsageStats` 的 provider 维度（格式变更，独立决策）、`unregister` 级联、
  `_setChatProvider` 的最终删除（当前只剩第三方桩在走）

## 2026-09-29（续 212）运行期注册 S1+S2：注册键口径、默认显式化、Agent 守卫

起因是与 Pi Coding Agent 的扩展架构比较后得出的结论：**「灵活」的第一刀不是把 hook 面铺大，
而是运行期注册**（Agent / Provider 从构造参数变成运行期可增删）。方案见
`docs/runtime-registration-plan.md`；本轮按四项裁决（Q1 显式键 / Q2 显式 setDefault /
Q3 回落首个 / Q4 WeakMap）落地 S1 + S2。

### 调研先推翻了一个粗判：两侧成熟度差得很远

- **Agent 侧早已具备运行期注册能力**：`AgentRuntime.register(def)` 是公开接口（CLI 的
  `applyConfigAgentOverrides` 就在运行期调它），而且**工具池是每轮 query 重算**的 ——
  `_prepareQueryOnce` 每次 `new DefaultToolPool(toolRegistry)` + `trigger('core.tool.pool.assemble', {agentId})`
  + `filterByWhitelist(agent.tools)`。缺的从来不是能力，是**守卫**。
- **Provider 侧是真的缺**：实例层只有 `HarnessImpl._setChatProvider` —— `@internal`、
  **不在 `Harness` 接口里**、被 6 个 provider 包跨包 cast 调用，且「注册」与「设默认」被绑成同一件事。

### P2：注册键口径不一致（真 bug，影响现网）

注册表 key 取的是被注册对象**自报**的 `p.id`：

```ts
if (p?.id) this.chatProviders.set(p.id, p)      // ← 对象自报，不是调用方给的实例键
```

| Provider | 实例 id | 结果 |
|---|---|---|
| openai（含 glm / qwen） | 透传 `config.id` | ✅ 多实例正常 |
| **anthropic / gemini / mock** | **硬编码 `readonly id = 'anthropic'`** | ❌ 同类多实例互相覆盖同一 key |

⇒ `agent.model.providerId = 'a2'`（`ProviderConfig.id` 的派生值）在 core 侧**根本不存在** ⇒
`resolveChatProvider` 静默回退默认。而 `ProviderConfig.id` 的注释明写支持「同一模型挂多个端点」——
这个被明确支持的场景对 anthropic 系是坏的。CLI 只能在展示层把「请求的 id」与「实际命中的
`provider.id`」比一下来**提示**，修不了。同一 bug 在插件层还有第二个表现：多个 anthropic 实例的
`pluginId` 都是 `provider.anthropic`，被 `pushBuilt` 的 `builtIds` **静默去重丢掉**。

### S1 改法

| 环节 | 旧 | 新 |
|---|---|---|
| 实例注册 | `_setChatProvider(p)`：按 `p.id` 入表 + 设默认 | `providers.register(id, p, meta)`：**键由调用方给**；注册**不设默认** |
| 默认 | 「最后注册赢」= 注册顺序即语义 | `providers.setDefault(id)`（未注册即抛错） |
| 解析 miss | 静默回退默认 | 发 `provider.resolveMiss`（静默回退就此可见） |
| 反注册 | 无 | `unregister(id)`；摘掉默认则回落「首个已注册」+ 发 `defaultChanged` |
| 兼容 | —— | `_setChatProvider` 改**委托 + deprecated**（= 按 `p.id` 注册 + 设默认），老调用点行为不变 |

**第一原则：注册键由调用方给，不由被注册对象自报** —— 被注册对象只知道自己「是什么类型」，
不知道「这次装配的实例叫什么」。`readonly id = 'anthropic'` 作类型标识是对的，当唯一键就错了。

三处硬编码单例照 `provider-glm` 的既有范式改造：实例 `id` 取自 `config.providerId`，工厂从
`ProviderConfig.id` 透传，`pluginId` 随 providerId 派生，注册走 `harness.providers.register(...)`，
老宿主回退 `_setChatProvider`。CLI boot 删掉「默认放最后 = 顺序即语义」，构造完所有实例后显式
`providers.setDefault(chosenProviderId)` —— 特别注意 `chosenProviderId` 取**实际装配**的实例，
**不能复用展示用的 `cpId`**：无 key 回退 mock 时配置意图是 anthropic、实际装配是 mock，拿意图去
`setDefault('anthropic')` 会抛「未注册」。

### S2 改法：Agent 侧补守卫（工具池一行没改）

`register(def, meta?)` + `AgentRegisterMeta { source, overwrite?, overlay? }` + `unregister(id)`。

- 同 id 覆盖 ⇒ 发 `agent.reregistered { id, from, to }`。载荷给**前后两个来源** ——
  覆盖最需要看见的是"改动前后各是谁注册的"，只给 id 归因不了。
- 覆盖打 WARN，但 `overlay: true` 豁免：文档化覆盖链（options → dir:user → dir:project → config）
  与 `/tools` 落盘是正常路径，每次启动刷一条 WARN 会把真正异常的那条淹掉。
  **事实靠事件可见，噪音靠 overlay 压掉。**
- `overwrite: false` ⇒ 抛错，且抛错时**不动**已有定义（否则"拒绝覆盖"反而把旧定义弄丢）。
- 来源用 `WeakMap<AgentDefinition, string>` 持有：来源是「注册这件事」的属性，加字段会跟着
  md 序列化 / 快照落盘，还会在每次覆盖时被旧对象带进新对象。
- 工具池**一行没改**（本来就每轮重算），但补了守护测试 —— 见下。

### 验证：反向验证逐条归因（8 条）

| # | 摘掉的改动 | 变红的用例 |
|---|---|---|
| S1-1 | `register` 退回 `provider.id` 作键 | core P2 用例（1 红） |
| S1-2 | 摘掉 `resolveMiss` 发布 | core miss 用例（1 红） |
| S1-3 | `setDefault` 变空操作 | core 默认相关 3 条 + **2 条既有用例**（见下） |
| S1-4 | 摘掉 anthropic 的 `providerId` 透传 | CLI 端到端 anthropic 用例（1 红） |
| S1-5 | 摘掉 CLI 显式 `setDefault` | 仅 anthropic 用例红 |
| S2-1 | 摘掉每轮 `assemble` 触发（"挪回装配期"的等价物） | 工具池守护用例 |
| S2-2 | 摘掉 `overlay` 豁免 | CLI「配置覆盖不打 WARN」 |
| S2-3 | 摘掉 `reregistered` 发布 | 2 条事件用例 |
| S2-4 | 不记来源 | from/to 退化成 `unknown`，归因用例单独红 |
| S2-5 | 摘掉 `overwrite:false` 拒绝 | 仅该用例红 |

**本轮最有价值的三条发现：**

1. **mute S1-1（core 键退回自报）不会让 CLI 端到端用例变红。** 因为插件侧已把实例自报 id
   修正为 `providerId`，`provider.id === 显式键`，两处修复在当前状态下**互为冗余**。core 那半的
   价值是**防御纵深**：任何自报共享 id 的 provider 都不会再撞键。⇒ 断言必须造出"自报 id 与
   注册键不一致"的形状（core 用例里两个 spy 都自报 `'anthropic'`，注册为 `a1`/`a2`），
   否则测不到。
2. **mute S1-3 让 2 条既有用例变红** —— 证明「最后注册赢」这条老语义确实由
   `_setChatProvider` 委托的 `setDefault` 兜住；老路径不做一次性大迁移是对的，否则 6 个
   provider 包一起改，风险全落在"新老语义混用"上。
3. **mute S1-5 只有 anthropic 用例红、gateway 用例绿** —— 因为 openai 系仍走 `_setChatProvider`
   老路径（它自己会 setDefault）。这正是"渐进迁移"的预期形态，也说明迁移完成度决定了
   "显式 setDefault"是不是 load-bearing。

### 一条测试设计上的陷阱（S2 工具池守护）

要锁住「运行期注册的 Agent 下一轮 query 立刻有工具」，**工具注入必须按 `agentId` 分流**：

```ts
async 'core.tool.pool.assemble'(input, pool) {
  if (input?.agentId === 'late') pool.add(createEchoTool())   // ← 条件依赖 agentId
}
```

若插件无差别注入，"构造期已注入全局注册表"的实现也骗得过断言（`filterByWhitelist` 照旧能在
全局表里找到它）—— 断言就没在测"那一轮重新组装了"。另加**控制组**（先跑默认 Agent，断言它
看不到 `echo`），把"按 agentId 分流"这件事本身也纳入断言。

### 收尾

- 全仓 typecheck 抓出 2 处测试桩（`subagent` / `coordinator` 的 `createMockAgentRuntime`）缺
  `unregister` —— **只跑单包时看不见**，这是"改公共接口必须跑全仓"的又一例。
- typecheck 39 包 0 error；全量 test 39 包 0 fail（S1 后 1987 / S2 后 1992）。
- 新增守卫：core 11 条（S1 六条 + S2 五条）+ CLI 2 条（anthropic 两端点端到端、配置覆盖不打 WARN）。
- **未做**：S3（可观测与展示：bus 事件接 telemetry、`/model` 增来源列、`/plugins` 显实例数）；
  `unregister` 的级联（摘 Provider 不动用它的 Agent、摘 Agent 不动历史）按方案 §7 刻意不做；
  config.json 热加载不在本方案范围。

## 2026-09-29（续 211）会话恢复后工具输出不显示：历史渲染压根没读 tool part

用户报："会话恢复后，工具输出就不显示了"。

### 根因：恢复通道把 `tool` part 整个丢掉了（与上一轮无关，是更早就有的漏）

`messagesToBlocks`（TUI 铺历史的唯一入口，启动自动恢复与 `/resume` 共用）走
`messageToBlock → messageText`，而 `messageText` 只拼 `text` / `reasoning`：

```ts
for (const p of msg.parts) {
  if (p.type === 'text' && ...) out += p.text
  else if (p.type === 'reasoning' && ...) out += '\n💭' + p.text   // ← tool part 无声跳过
}
```

真机会话文件（`~/.harness/sessions/*.json`）里的形状是：**tool part 挂在 assistant 消息上**
（不是独立的 role:`tool` 消息），带 `toolUseId` / `toolId` / `input` / `result` / `isError`：

```
('user','text') 1   ('assistant','reasoning') 3   ('assistant','tool') 2   ('assistant','text') 1
```

⇒ 恢复出来的会话只剩「提问 + 结论」，中间每一步工具干什么全不见。一个 40 步的任务恢复后
看起来像一气呵成。之所以现在才被报出来：`0fb36a7` 加了**启动自动恢复**，一进来就铺历史，
这个缺失从"偶尔 `/resume` 才遇到"变成"每次启动都在眼前"。

### 取证（真机帧，`createTestRenderer` + `captureCharFrame()`）

| 场景 | `contains('🔧')` | 画面 |
|---|---|---|
| 修复前 · 自动恢复含 tool part 的会话 | **false** | 只有 `❯ 跑一下 ls` / `我执行了。`，`ls -la` 与 `a.txt` 都搜不到 |
| 修复后 · 同场景 | **true** | `🔧  bash {"command":"ls -la"}` + `│ ✅  → a.txt` + `└ b.txt` |
| 修复后 · 恢复后再跑一轮（实时通道） | **true** | 新工具行照常出现 ⇒ 只有历史那一半有问题 |

### 改法：按 part 顺序切块，形状与实时输出逐字一致

`messageToBlocks(m, idStart)` 取代原来的单块 `messageToBlock`，按 part 出现顺序切：

- `text` / `reasoning` → 角色对应的正文块（markdown）；`tool` → `tool` 块（等宽树状）
- 正文与工具**不能合进一个块**：正文走 markdown、工具行走树状渲染，混在一起必然有一方被当错的语法渲染
- 连续多个 tool part 并成一个块（与实时输出"一步里多条工具并到一个块"一致）；正文与工具交替时按序 flush
- 行文本复用 `formatToolInput` / `formatToolResult` —— 与 REPL/TUI 实时通道**同一对函数**，
  所以历史里看到的入参/结果与当时实时看到的是同一份文本，也保证 `windowToolText` 的 `🔧` 分段照常生效
- `result === undefined` 的 tool part（被中断 / 崩在工具里就落盘）只留 `🔧` 行，不补空结果行假装跑过
- id 由调用方从 `nextId` 起顺排（一条消息可能产出多块），保证不与 `pushConsole` 追加的实时块撞号

### 验证

- 反向验证**逐条归因**（不是一次全回退）：① 摘掉 `tool` 分支 ⇒ 4 条守卫全红、其余 131 条全绿；
  ② 摘掉结果行 ⇒ 只红 3 条（第 4 条只断言分块顺序、本就不涉及结果内容）⇒ 归因准确
- `typecheck` 39 包 0 error；全量 `bun test` 39 包 0 fail（cli 403 pass / +4）
- 新增守卫：纯函数 3 条（tool part → 工具块形状 / 连续合并 + ❌ + 无 result / 正文工具交替切块与 id）+ 真实帧 1 条

### 顺带一条方法论：`<markdown>` 不是首帧就绘制的

探针里 `waitFrame(..., f => f.includes('❯'))` 一命中就取样，结果恢复出来的助手正文
**看起来全是空白**，一度以为"恢复后正文也看不见"。真相是 `<markdown>` 要再跑几十帧才绘制
（工具行/用户行是 `<text>`，首帧即出）。多 pump 60 拍后一切正常。
⇒ **断言前先确认东西已经画出来了**，否则会把"还没画"误判成"画不出来"。

## 2026-09-28（续 210）工具块改「首尾窗口」：完整打印把工具调用行挤出了对话框

用户报："现在对话框里没有工具调用信息了"。**根因就是续 209 那轮**：结果的两处 `slice()` 一起拿掉后，
单条工具块不再有任何上限，而 TUI 的 scrollbox 是 `stickyScroll stickyStart="bottom"`。

### 取证（真实 `createTestRenderer` + `captureCharFrame()`，与 TUI 同一套挂载方式）

| 场景 | 帧里 `contains('🔧')` | 画面内容 |
|---|---|---|
| `bash {command:"echo ok"}` | **true** | 🔧 行 + `└ ✅ → …` 完整可见（所以短命令时看不出问题） |
| 80 字符命令 + 30 行输出 | **false** | 只剩结果中段/尾部 |
| `bash {command:"seq 1 3000"}` | **false** | 满屏 `n2989\n2990…3000`，`🔧`/`✅` 一行不见 |
| 同场景（修复后） | **true** | `🔧  bash {"command":"seq 1 3000"}` + `…（本行省略 16812 字符）…` + 尾部 `n3000` + `⧉ 复制全文（17026 字符）` |

阶段 1 的失败帧（当时已经"按行收窄"过）：

```
│ n71\n72\n73…                                      │
│ n106\n107…  …（本行省略 16092 字符）…              │   ← 🔧 行仍在画面外
│ n2940…3000\n","stderr":"","exitCode":0,…          │
│ ⧉ 复制全文（17026 字符）                           │
```

### 为什么窗口必须加在渲染层、且不能按整块收窄

1. **块文本保持全文**：`pushConsole` 把一次应答的所有 tool 行**合并成一个块**，块文本即全文 ——
   「复制全文」才有全文可取。在传输层（`formatToolResult`）截断的话，全文到此就没了。
2. **必须按「工具调用段落」分段**（🔧 行起、到下一条 🔧 行前）：合并块里有多条工具，按整块收窄
   会把**中间几条**的 `🔧` 行整段切掉 —— 那正是要修的毛病本身。
3. **行数预算 + 字符预算都要**：
   - 行数（首 6 / 末 4）挡"很多短行"（`seq 1 3000` 是 3000 行 × 6 字符）；
   - 字符（首 260 / 末 220）挡"少数超长行"：工具返回**对象**时 `JSON.stringify` 把换行转义掉
     ⇒ 结果是**一整行** 16000 字符，80 列终端折成 ~13 行，**只限行数等于没限**（首版就栽在这：
     行窗口明明生效了、🔧 仍被挤出画面）；
   - 单行（200 字符）挡 `write_file` 的 content（JSON 单行，几十 KB）。

一屏按**最小 80×24** 算：工具块 ≤ ~14 渲染行，加上其后的 `⧉ 复制`/助手正文/`⏱️` 才塞得下。

### 复制按钮：改名，而不是加一个

被窗口化时按钮显示 `⧉ 复制全文（N 字符）`（**仍然复制 `b.text` 全文**，语义没变，只是让人知道
拿到的是全文而不是可见那段）。没有另开第二个按钮：可见内容本来就能拖选 + Ctrl-Y 复制，
两个按钮里必有一个是垃圾。

性能：`windowToolText` 是 O(文本长度)，而流式期间每次 `text_delta` 都会重渲染所有块 ⇒ 按块 id 缓存、
用**字符串同一性**判失效（React 对未变的块复用同一字符串引用，命中比较是 O(1)）。

### 验证

- 反向验证（把 `windowToolText` 改成直通）：**4 条守卫全部变红**（含真实帧那条）
  —— 注意真实帧用例是**先红后绿**的：修复前它就在这个仓库里跑红过，断言有效性有直接证据
- `typecheck` 39 包 0 error；全量 `bun test` 39 包 0 fail（cli 399 pass / +5）
- 新增守卫：纯函数 5 条（其中 2 条是"★"级的机制守卫：分段落、字符预算）+ 真实帧 1 条

范围：**只收 TUI 渲染层**。REPL 仍是完整 print（纯 stdout、无视口问题，而且是脚本友好的），
headless `harness run` 也保持原样（写 stderr、首行 + 300 字符，刻意脚本友好）。

## 2026-09-28（续 209）工具回显改成完整打印（入参 + 结果），不截断

用户要求："工具命令打印完整的信息，不要截断"。经确认，指的是 REPL/TUI 里**工具调用的两行回显**
（`createProcessLine` 的事件循环 —— REPL 与 TUI 共用；TUI 的工具块正是由这里的 `out()` 经
`pushConsole` 归类而来，`applyStreamEvent` 只处理文本/推理增量，不碰工具行）。

### 改了什么

| 位置 | 改前 | 改后 |
|---|---|---|
| `tool_call_start` | `JSON.stringify(input).slice(0, 60) + '...'` | `formatToolInput(input)` —— 完整序列化 |
| `tool_call_result` | `typeof r === 'string' ? r.slice(0,120) : JSON.stringify(r).slice(0,120)` | `formatToolResult(result, !!onEvent)` —— 完整打印 |

新增两个导出助手（`packages/cli/src/index.ts`）：

- `formatToolInput`：`JSON.stringify`；`undefined → '{}'`；不可序列化（循环引用 / BigInt）
  退化为 `util.inspect(value, { depth: null, breakLength: Infinity })`。**两条路径都完整** ——
  原来的兜底是 `String(v)`，环形对象只剩 `[object Object]`，等于又丢一次信息
- `formatToolResult`：string 原样（保留换行）；其它 JSON 化；多行时按 `markContinuation` 加续行标记

事件的载荷本来就是完整的：core 侧 `tool_call_start` 的注释明写"含 input 完整值"，
`tool_call_result` 带的就是完整输出 —— **截断发生在展示层，是自己把上游给的信息丢掉**。

### 顺带必须解决的：多行结果会被 TUI 劈成两块

截断一去掉，多行结果就成了常态，而 `pushConsole` 是**逐行**分类的：续行读不出前缀 ⇒ 落成
`system` 块。而 tool 块渲染器**本就按多行设计**（首行加粗、结果行自动补 `│` / `└` 树状缩进），
且**每个块各带一个「⧉ 复制」按钮** ⇒ 一次工具调用会冒出两个复制按钮。

修法：给续行一个**传输用**标记 `TOOL_CONT_MARK = '┆'`，`classifyConsoleLine` 认它并**剥掉**
（界面与复制出的文本里都看不到）。且**只在 TUI 模式加** —— REPL 是直写 stdout 的纯文本通道
（`out = (s) => (options.stdout ?? process.stdout).write(s)`），带标记就是往用户眼前打符号；
判据用现成的 `onEvent`（本文件里"有 onEvent = TUI 结构化模式"，与推理/文本增量的分支同源）。

> 为什么这个标记实际是给 MCP 用的：内置工具的 `output` **全是对象**（`JSON.stringify` 会把换行
> 转义成 `\n` 两个字符，压根不带真实换行）；而 MCP 工具返回的是**纯字符串**
> （`mcp-client` 的 `texts.length === 1 ? texts[0] : texts.join('\n')`），多行是常态。

### 验证

- 反向验证**逐条归因**（不是一次全回退，否则说不清是哪条断言在守）：
  - 只把入参切回 60 字符 ⇒ 「整条命令都在」变红
  - 只把结果切回 120 字符 ⇒ 「最后一行输出在」变红
  - 去掉 `!!onEvent` 开关 ⇒ 「TUI 模式带续行标记」变红
  - 注释掉 `classifyConsoleLine` 的续行分支 ⇒ tui 侧 3 条变红
- 全量 typecheck 39 包 0 error；cli 154 pass（+6）、tui 125 pass（+3）；全量 39 包 0 fail

### 测试踩到的两个坑（值得记）

1. 第一版断言写的是"整段输出里包含完整命令"，回退验证时**照样通过** —— 因为 `bash` 工具的
   output 里**回显了 command**（`{stdout, stderr, exitCode, command}`），那份回显把被截断的
   入参行蒙混过去了。断言必须**盯住 🔧 那一行**（`text.split('\n').find(l => l.startsWith('🔧'))`）。
   **"回退验证变红"才暴露了这条断言是假的** —— 只看绿灯会以为覆盖到了。
2. 造"多行字符串结果"不能用内置工具（output 都是对象），要用 `extraPlugins` 注入一个返回
   `'alpha\nbeta\ngamma'` 的工具 —— 这正是 MCP 工具的形状。

### 未做（先不动）

`harness run`（headless）那条通道仍是收窄的：`[工具] <id>` 不打入参，结果只取**首行 + 300 字符**
（`packages/cli/src/index.ts:4670-4682`，写 stderr、刻意保持"脚本友好"）。这与本次改的交互通道
是两套消费场景，未一并动；要改需先定"headless 的 stderr 是否要承载完整结果"。

## 2026-09-28（续 208）MCP 工具供给语义修复 + A1-4 超时回传进展正文 + B2-3 入参提醒

用户报："mcp 服务的工具没有自动注册到 tools 列表上"。查证下来**文档与实现互相打架**，
不是配置写错。

### MCP：`mcpServers` 写成"二次过滤"，导致声明了 server 也拿到 0 个工具

`packages/agent/src/index.ts` 的 `AgentDefinition.mcpServers` 文档写的是
"声明该 Agent 可用哪些 MCP server 的**全部工具**"（= 供给），但 core 的实现是：

```ts
filterMcpTools(this.deps.toolRegistry.filterByWhitelist(agent.tools), agent.mcpServers, …)
```

`filterMcpTools` 是**纯收窄**（只能做减法），而它的入参已经把 MCP 工具剔掉了
（MCP 工具不在显式 `tools:` 列表里）⇒ 第二阶段再筛也是空集。

真机探针（`outputs/session-analysis/probe-mcp-whitelist.ts`，真实 core + 真实装配链路）：

| 组合 | 修复前 | 修复后 |
|---|---|---|
| ① `tools:['*']` + `mcpServers:['gh']` | 可执行 ✓ | 可执行 ✓（对照） |
| ② `tools:[read_file,…]` + `mcpServers:['gh']` | `TOOL_NOT_ALLOWED` ✗ | **可执行 ✓** |
| ③ `tools:[…, mcp__gh__create_issue]` | 可执行 ✓（老绕法） | 可执行 ✓ |
| ④ `tools:[read_file]` + 未声明 `mcpServers` | `TOOL_NOT_ALLOWED` ✗ | `TOOL_NOT_ALLOWED` ✗（保持不供给） |

**改法**：新增 `supplyMcpTools(picked, all, mcpServers, excludeMcpServers, index)`，
在**注册表全量**上补齐声明 server 的工具；core 与 `tools-manager` 共用它（展示与执行同一判据）。
语义三条：非空数组 ⇒ 供给该 server 全部工具（并剔除列表外 server 的 MCP 工具）；
`[]` ⇒ 拒绝全部 MCP（连显式写进 `tools:` 的也剔除）；**缺省 ⇒ 不供给**（刻意不做成
"全可见"，那会让 `tools: ['read_file']` 的只读 agent 静默拿到全部 MCP 工具 = fail-open）。
另：`tools: []` 是"一个都不给"的**绝对**逃生口，连 MCP 供给也一并关掉。

> 那批 agent md（`AI 集成工程师.md` / `coder.md` / `lead.md` / 前端/后端架构师…）里
> `mcpServers: ['code-intel']` + 手写 4 条 `mcp__code-intel__*` 的组合，**后者其实是绕前者的 bug**。

### A1-4：被掐断时回传**进展正文**，不再只给路径

草稿/全文都落 `{dataDir}` 下，调用方 `read_file` 的边界是它自己的 `ctx.cwd` ⇒ 路径给了也读不到。
新增 `buildPartialDigest` / `buildPartialDigestFromLines`（上限 4000 字符），把
"工具名 + 入参预览 + 成败 + 已写出的部分正文"拼进失败消息；前台超时路径此前**连草稿都没有**，
改为从子 session 消息里摘。只报"跑到哪了"，不编结论。

### B2-3：入参提醒改用「真丢过参数」触发，而不是占用率

初稿方案是"上下文超阈值时提醒"。但那次事故（14 次空入参）的 **occupancy 峰值只有 22.83%**
⇒ 任何长上下文阈值（25% / 35%）都不会触发，等于没修。改用批 3 刚落地的
`core.tool.params.missing`（与 `selfHealOnly` 免计额度同源）置**粘性**标记，
从下一轮起在 **ACP 尾部**常驻 `TOOL_ARGS_REMINDER`（尾部翻转不伤前缀缓存）。

### 验证

- **反向验证**（三条各自回退确认变红）：关掉 `supplyMcpTools` 的供给段 ⇒ core ★ 用例 + tool 包 4 条变红；
  去掉前台 `digestNote` ⇒ subagent 2 条变红；去掉尾部注入 ⇒ acp-context 1 条变红
- 全量 `typecheck` **39 包 0 error**；`tool` 77 pass(+9)、`core` 59 pass(+3)、`tools-manager` 16 pass(+3)、
  `subagent` 158 pass(+3)、`acp-context` 82 pass(+2)；全量 **39 包 0 fail**
- 探针复跑：② 由 `TOOL_NOT_ALLOWED` 转 ✓，④ 保持拒绝

## 2026-09-28（续 207）批次 3：白名单越界的真根因 + 三条埋点落地（越界 / 空步 / 入参缺失）

批次 3 原计划是"补埋点"。**实施时把 C2 的根因判断改写了** —— 它本来就是不安全的。

### C2 根因：`tools:` 白名单在**执行期**被一条回落架空

方案原文说"当前代码里没有 `bypassWhitelist` 之类的机制 ⇒ 更可能是白名单过滤本身有漏"。
查证结论：过滤没错，**执行期解析多了一步回落**（`core/src/index.ts:3026`）——

```ts
const tool = allowedTools.find((t) => t.id === tc.toolId) ?? this.deps.toolRegistry.get(tc.toolId)
```

`allowedTools.find` 未命中就回落**全局注册表**：模型点名一个"已注册、但不在白名单"的工具
（真机 `s_1790592617954_axqkk` 里 reader 只授权 `read_file/list_dir/glob/grep_file`，
却成功调用了 `compress`），照样能取到实例并执行。**`tools:` 只是"模型看得到什么"，
不等于"模型只能调什么"** —— 有没有 MCP 豁免、有没有内置白名单都不是原因，就这一行。

同一处还架空了两条既有约定：`tools: []`（AGENTS.md 明写"一个都不给"）此前任何调用都会被
这条回落放行；alias 调用则是**唯一**需要回落 的真实理由（`allowedTools` 存真实 id）。

**改法**：回落仍保留（alias 要靠它），但解析结果**必须回白名单验一次身份**：

```ts
const resolved = allowedTools.find((t) => t.id === tc.toolId) ?? this.deps.toolRegistry.get(tc.toolId)
const tool = resolved !== undefined && allowedTools.includes(resolved) ? resolved : undefined
```

并把"越界"与"未注册"分开：越界回喂 `TOOL_NOT_ALLOWED`（明确原因，别让模型当临时故障原地重试），
未注册仍按原样静默（多半只是拼错名字，没有可审计的边界）。

### C2-b（`compress` 前置短路）：**不做**，理由记档

方案原文的行动 2 是"`minCompressRange` 未达时，在**执行前**就短路返回 `NO_EFFECT`"。
核实后判定不划算，先不动：

- 内核 `applyCompression` 的 gate（`acp-kernel/dist/index.js:2107`）**在任何块被构建之前**就返回，
  且返回的是 `state: input.state` —— **不改状态**。所谓"白烧"是**模型那一步**（模型自己发起的调用，
  引擎无法提前知道），不是被浪费的压缩计算。
- 想在插件侧"前置"就必须复刻内核的 `totalRangeChars` / `hasBlockBoundaryRange` 判据，
  而插件只有 `measureRangeChars`（按 ref 序号区间估算，block 边界判别不出来）⇒ 判据必然与内核漂移，
  可能**误拒合法压缩**。风险换不到收益。
- 顺带发现一个**微小**的真实浪费：零收益时 `sctx.needFull = true` 会强制下一轮全量重渲染
  （CPU，非 token —— 内容逐字节不变，provider 侧前缀缓存仍命中）。收益量级不值得动 ACP 状态机。

### 三条埋点（每条都是三件套：hook 声明 + core 触发 + telemetry 落盘）

| 事件 | core 触发点 | 解决的问题 |
|---|---|---|
| `core.tool.whitelist.blocked` | 解析结果不在 `allowedTools` 内 | 能力边界事件此前**静默放行**，遥测里与正常调用同形 |
| `core.step.empty` | 无用量 + 无正文 + 无推理 + 无工具调用 | "一次完整 prompt 换零产出"此前**完全隐形**（无 usage ⇒ 无 `providerCache` 行；无 tool call ⇒ 整轮结束） |
| `core.tool.params.missing` | `describeMissingRequiredParams` 命中处（与 `selfHealOnly` 同源） | 分不出"缺参数型失败"（真机 14 次 `input: {}`）——`core.tool.post.execute` 触发得更早，那时自愈文本还没拼进消息 |

`turn.end` 另补 `emptySteps` 整轮回填（单步事实走 `core.step.empty`，整轮汇总走 turn.end，
两处同源不同粒度）。为让两个消费方共用同一判据，`describeMissingRequiredParams` 内部抽出
`missingRequiredKeys`（否则"免计额度"与"埋点计数"各按一套口径算，对不上账）。

### 验证

- **反向验证**（AGENTS.md 要求）：临时把 `allowedTools.includes` 校验去掉 ⇒ 两条新守卫
  （越界 / `tools: []`）**双双变红**；恢复后绿。不是"写完就绿"的假守卫。
- **端到端落盘**（L3-lite，真实引擎 + 真实 telemetry 插件 + 临时 `dataDir`）：
  `outputs/session-analysis/verify-batch3-e2e.ts` 把三种形态各真跑一轮 query，
  断言 `telemetry.tool.whitelist.blocked` / `telemetry.step.empty` /
  `telemetry.tool.params.missing` 三条都落进 `sessions/*.telemetry.jsonl`。
  该脚本用脚本化 provider 而非 `MockChatProvider`：后者**总会带 tokenUsage 与正文**，造不出"空步"。

| 项目 | 结果 |
|---|---|
| 全量 `bun run typecheck` | 39 包 0 error |
| `core` | **56 pass / 0 fail**（新增 2 条白名单守卫） |
| `telemetry` | **53 pass / 0 fail**（新增 3 条 envelope + 1 条落盘） |
| 全量 `bun run test` | 39 包 **0 fail** |
| 端到端落盘 | 三条埋点全部落盘（场景 A 越界 ✓ / B 空步 ✓ / C 自愈 ✓） |

### 复用要点

- **"白名单/边界类"配置要查两处**：过滤（模型看到什么）与解析（执行时取谁）。
  只测"配了白名单能否执行"会全绿 —— 真机那条 8 个 subagent 全 `tools:"*"` 的旧账是同一类。
- **"埋点"落地必须是三件套**，缺一即死代码。查死 hook 的最快方式：`grep` 消费方是否存在，
  而不是看 hook 有没有被触发。
- 端到端脚本里，**工具桩的 `safeParse` 必须真的失败**才能走到"入参自愈" —— 恒成功的桩会让
  工具"执行成功"，看着像功能没生效，其实是场景没造出来。

## 2026-09-28（续 206）结果滞留的真机根因是 TUI 没挂自动续轮（不是退避不够）

方案 A2 原本判断"barrier 事件与通知入队是两个独立分支，靠退避赌"，并建议再加退避/重投。
**实施时证伪**：`subagent` 早就改成「先 `enqueueNotification()`、后 `bus.publish(completed)`」
（`index.ts:1342`、`:1406` 两处注释写明该契约），顺序不是问题。

真机根因是 `attachAutoContinue` **只在 REPL（readline）分支挂载**（`cli/src/index.ts:4332`，
`rl.emit('line', line)`），**TUI 模式一次都没订阅** —— 不管顺序怎么调，TUI 里根本没人把
`<continue/>` 投进输入队列 ⇒ 结果就绪后要等用户自己敲下一句话。
真机 `s_1790592617954_axqkk`：barrier +527s 完成，通知 +2816s 才随用户敲「结果有了吗」进入对话。

### 改动

`packages/cli/src/tui.tsx`：组件内补一个 effect 订阅两条 Coordinator 事件，注入
`pendingLines.current.push(line)` + `drain()`。TUI 与 REPL 共用 `createProcessLine`
（内含 `<continue/>` 的空转判定与退避 peek），所以**内核一行没改**，只补事件源。

### 验证（两条断言都做了反向验证）

- 「barrier 事件 ⇒ 通知进入对话」：不发任何按键，只入队 + publish，断言会话消息数 +2。
  **临时禁用挂载（`__PROBE_NO_AUTOCONTINUE__=1`）⇒ 用例红，且消息数增长为 0** ——
  这正是真机"结果滞留"的最小复现，反证根因判断成立。
- 「无待处理通知 ⇒ 跳过续轮」：只 publish 不入队，断言消息数不变（不凭空多烧一次模型调用）。

### 同批：`read_file` 描述补可照抄示例（B2 的低成本部分）

真机 14 次 `input: {}`（jeha1 6 / rra6h 6 / goggv 2），每次触发一轮「入参自愈」回喂
（自愈不吃步数，但每轮都是一次完整 prompt，约 0.68M token ≈ 10%）。
字段清单说明"要什么"，**示例说明"长什么样"** —— 后者才是长上下文里可照抄的形状。
故 `tools-builtin/src/index.ts` 的 `read_file` description 直接带上两个完整调用示例。

> **B2 的埋点部分本轮没做，理由记在这里**：想精确统计"入参缺失型失败"，需要
> `core.tool.params.missing` hook + telemetry 新 kind + severity 映射**三件套**；
> 只加 hook 而无消费方落盘就是死代码。现有 `telemetry.tool.fail` 能统计失败次数，
> 但 hook 触发在 core 拼装 `[入参自愈]` 文本**之前** ⇒ envelope 里不含该特征，无法区分类型。
> 留到批次 3，与"长上下文 nudge（提醒携带完整 arguments）"一起做。

### 验证汇总（与最后一次改动对齐）

| 项目 | 结果 |
|---|---|
| 全量 `bun run typecheck` | 39 包 0 error |
| `cli` | **383 pass / 0 fail**（新增 2 条自动续轮断言） |
| `tools-builtin` | 83 pass / 0 fail |
| 全量 `bun run test` | 39 包 0 fail |

### 复用要点

- **"断言某功能存在"之前先断言它挂在哪**：`attachAutoContinue` 有单元测试、REPL 也正常，
  但**只有一个调用点** —— 覆盖率掩盖了"另一半宿主没接"。查这类问题直接 grep **调用点数量**，
  比读实现快得多。
- 反向验证的价值在这里最直观：禁用后消息数增长 **0**，与真机"滞留 2,289s"是同一现象。

## 2026-09-28（续 205）会话 s_1790592617954_axqkk 优化方案批次 1：glob 拒绝静默全仓 + subagent 派工级 timeoutMs

由会话取证（报告 `outputs/session-analysis/session-axqkk-report.html`、方案
`optimization-plan-axqkk.md`）推出的第一批落地。**缓存侧健康（命中 93.1%、drop 0、
compression 0）⇒ 优化空间全在调度与工具层**，本批专挑"小改动堵大漏斗"的两项。

### 一、`glob` 不再静默退化成全仓遍历（P1，≈16%）

真机一次调用返回 **215,562 字符（约 1,937 文件）**，合法入参重调只有 665 字符；
受害子会话成本是干同类活的另一个的 **3.05 倍**。根因是两行：falsy 的 pattern 被
`if (!pat) continue` 静默跳过 ⇒ `includes` 为空 ⇒ 兜底 `**/*` 扫到 `MAX_GLOB_RESULTS(5000)`。
`pattern` 在 schema 里是 `required`，但**内置工具的 Step 1 是 no-op**（`makeSchema` 的
safeParse 恒通过）⇒ 运行期零校验。

改动（`packages/plugins/tools-glob/src/index.ts`）：
1. **非空判定改用 `trim()`** —— `''` / 纯空白 / 非法类型都算空；全空时直接返回
   `GLOB_PATTERN_MISSING` **而不是兜底**，让模型走「入参自愈」补参数。
2. **保留合法兜底**：pattern 全是 `!xxx` 排除项时"除这些之外的全部"是正确语义，不能报错；
   但新增 `FALLBACK_MAX_RESULTS = 200` 压制规模（同时减少扫描 I/O）。
3. **新增输出字符预算 `MAX_GLOB_OUTPUT_CHARS = 20_000`**：`MAX_GLOB_RESULTS` 只管条目数、
   不管体积，几千条短路径照样撑爆上下文。超预算就裁到预算内并置 `truncated`（至少留 1 条）。

> 实测两道闸取严：本例每条约 150 字符 ⇒ **字符预算先撞**（131 条 < 200 条上限）。
> 断言因此写成上界契约（≤200 且 < 命中数），体积本身由另一条断言直接守。

### 二、`subagent` 挂钟超时可被派工方按任务放宽（P0，≈31% 的前置）

真机：reviewer 定义 `maxSteps: 25`，**跑到第 13 步就被插件级 120s 挂钟掐断** ⇒ 步数上限
根本没机会生效；120s 里吐 28,229 个 reasoning token、可交付正文只有 81 字符，主 Agent
只好用 25 轮 / 148 万 token 手工重做。

根因：`timeoutMs` 只有**插件级**（缺省 `120_000`），而 `maxSteps` 早就有派工级三层覆盖。
挂钟是**资源保护**，不该顺带当"任务该做多久"的主控参数；主控权应交给 `maxSteps`。

改动（`packages/plugins/subagent/src/index.ts`），与 `resolveSteps` 同构：
- `SubagentToolInput.timeoutMs` + inputSchema 描述（写明"让步数而不是挂钟成为终止条件"）；
- `resolveTimeoutMs()`：派工方 > 插件配置（`AgentDefinition` 目前**没有** `timeoutMs`
  字段 ⇒ 这里是两层，将来 md 支持时插中间层即可）；
- 合法值 `>= 1000`；新增 `MIN/MAX_SUBAGENT_TIMEOUT_MS`，**上限 600_000 钳制并告警**
  —— 放宽是为了让步数生效，不是解除熔断（否则模型填个天文数字就把唯一外部熔断解掉）；
- 前台（同步）与后台两条路径都改用 `effectiveTimeoutMs`，超时消息里的毫秒数同步。

配置侧（`~/.harness/agents/reviewer.md`）：**`maxSteps` 保持 25 不砍** —— 挂钟既然能放宽，
砍步数只会削减产出；改为在注释里写明"派工时用 `subagent({ timeoutMs })` 放宽，否则 120s
会让步数上限失效"，并在正文加「防空转」三条（不写推理过程 / 8 步无线索先回报 /
先 grep 后 read_file），直接对冲"reasoning 烧光预算"这一现象。

### 三、验证（与最后一次改动对齐）

| 项目 | 结果 |
|---|---|
| 全量 `bun run typecheck` | 39 包全 0 error |
| `tools-glob` | **14 pass / 0 fail**（新增 2 条） |
| `subagent` | **155 pass / 0 fail**（新增 4 条） |
| `cli` | **381 pass / 0 fail**（无回归） |
| 全量 `bun run test` | 见本节末 |

两条新断言都做了**反向验证**（临时回退修复 ⇒ 必须变红，否则是假守卫）：
- glob：`if (false && ...)` 恢复旧兜底 ⇒ `GLOB_PATTERN_MISSING` 用例红（`ok` 收到 true）；
  `MAX_GLOB_OUTPUT_CHARS` 放大 ⇒ 字符预算用例红（收到 300 条未被裁剪）。
- subagent：`resolveTimeoutMs(undefined, ...)` 禁用派工方层 ⇒ "优先于插件配置"用例红
  （收到 `（1000ms）` 而非 `（1200ms）`）。

### 四、复用要点

- **"required" 在运行期不算数**：内置工具的 Step 1 是 no-op，schema 必填**必须**在
  `call()` 入口自己拦，否则缺参会被静默降级成"语义完全不同的兜底行为"。
- **上限要按"体积"设，不能只按"条数"设**：条数闸挡不住几千条短路径；体积闸才是上下文的守门员。
- **两类超时/上限要分清职责**：步数 = 任务该做多久（主控，可按任务给），挂钟 = 资源保护
  （兜底，只允许放宽到有界范围）。让兜底抢了主控的位置，症状就是"步数配了但永远摸不到"。

## 2026-09-28（续 204）选区闪烁真机取证：markdown 块两条通道都是死的，改为命令式上色

用户：「鼠标选取闪烁功能没有实现，研究下为啥」。结论不是"没写"，而是**写了但两条通道在真机上都不闪**，
且测试断言只查"标记文案出现"、没查"标记在闪"，所以一直绿。

### 一、取证手法（真机探针，非测试渲染器）

`createCliRenderer({ stdin: PassThrough, stdout: PassThrough, bufferedOutput: 'memory' })` 挂载真实
`TuiApp`，往 stdin 灌真实 SGR 拖选序列（`\x1b[<0;X;YM` / drag / up），再从
`renderer.currentRenderBuffer.getSpanLines()` 采样 span 的 fg/bg（0~1 浮点，要 `toFixed(3)` 归一）。
渲染路径与生产**同一个 `CliRenderer` 类**（`createTestRenderer` 内部就是它），证据可信。

### 二、两条通道的实测结论

| 通道 | 对象 | 实测 |
|---|---|---|
| `selectionBg/selectionFg` 声明式 props（user / tool / thinking 的纯 `<text>`） | 纯 text 块 | **真的在闪**：8 次采样稳定 A(#d7a521) → B(#3a4150) → A → B |
| 块顶标记行 `reverse`（assistant `<markdown>`） | markdown 块 | **恒不闪**：`attributes` 8 次采样恒为 33（BOLD｜INVERSE） |
| markdown 选中文字 | markdown 块 | A/B 命中恒 0 —— `MarkdownOptions` 无该字段，内核默认色 |

### 三、根因

`tui.tsx` 标记行原写法 `inSelection && selBlink ? { reverse: true } : { bold: true, reverse: selected }`
—— 拖选结束的 mouseUp 必然冒泡到块容器（`onMouseUp ⇒ setSelectedBlockId`）⇒ `selected` 恒为 true
⇒ **两个分支都算出 `reverse: true`** ⇒ 标记恒定反显，`selBlink` 翻转被完全吞掉。而 markdown 的选中
文字又不吃 `selectionBg`，于是助手块（占屏最多、最常被拖选）**完全没有闪烁**。

### 四、修法（两条都修）

- **命令式上色（新增）**：selection 事件里把 `sel.selectedRenderables` 存进 `selRenderablesRef`，
  在 `selBlink` 翻转时逐个赋 `selectionBg/selectionFg`。依据：markdown 内部承载正文的
  `CodeRenderable`（`markdown-1-block-0`）就是 `TextBufferRenderable` 子类，**直接赋值立刻生效**
  （探针强制 A/B/A，屏上底色随之切换）；且它本来就在 `selectedRenderables` 里，无需遍历渲染树。
  ⇒ markdown 选中文字**真闪**，与纯 text 通道同源。
- **标记行判据修正**：改成 `inSelection ? { bold: true, reverse: selBlink } : { ... reverse: selected }`
  —— 是否闪只由「是否在选区里」决定，「是否被点选」退为非选区态兜底。

### 五、验证（新断言先证明会红）

- 新断言：① markdown 选中文字底色在 A/B 间交替；② 标记行 `attributes` 至少出现 2 个不同值。
- **反向验证**：改回旧 ternary ⇒ ② 立即红（attrs.size 恒 1）；用 env 开关临时禁用命令式通道 ⇒
  ① 立即红（A 命中 0）。两条都是真守卫，不是"写完就绿"。
- cli 包 `typecheck` 0 error；cli `bun test` **381 pass / 0 fail**；全量 `bun run typecheck` 39 包 0 error。

### 六、复用要点

- **断言"出现" ≠ 断言"闪烁"**：闪烁/动画类功能必须断言**状态在两个值之间变化**（这里就是
  renderable 的 `attributes` 数值），只查文案出现会让整条通道死掉还全绿。
- **`getSpanLines()` 不返回 attributes**：INVERSE 之类属性不在 span 的 fg/bg 里，验证"反显有没有在切"
  必须直接读 renderable 的 `attributes` 数值（渲染树从 `renderer.root` 递归 `getChildren()`）。
- **按字节切片还原终端行会整体错位**（CJK 占 2 列）：要按 spans 逐字 + 字宽重建可视列；宽字符在可视
  行里是「字 + 一个填充空格」，子串搜索得改成单字定位。
- **选中后块顶插入标记行 ⇒ 行号位移**，第二次拖选前必须重新取帧定位（第一轮就因此误判成
  "markdown 选不中"）。
- **内核没暴露的字段，未必改不了**：`MarkdownOptions` 没有 `selectionBg`，但内部 `CodeRenderable`
  可以直接赋值 —— 遇到"上游没暴露"先下沉一层看实际 renderable 类型，别急着写"做不到"。

## 2026-09-24（续 203）闸门预算改语义：`maxTotalMs` 从"终止条件"变"提醒阈值"，超预算仍等待并从 CLI 提示用户

用户：「超过 5 分钟后也不应该 skip，而是继续 60s 等待，但需要探测任务执行情况，有异常就提示用户」。

### 问题

旧设计把 `STEP_GATE_MAX_TOTAL_MS` 当**等待总预算**：累计等待达到它就关闸门、本轮的
后续步不再等待（`skipped/budget_exhausted`）。但这是"该等却没等"的形态 —— 后台任务
只做了一半就撞预算，结果真正跑完却没等到、下一轮才送达（真机 s_1790163574429_tg1a6）。
用户要求：超预算**不是放弃等待**，而是**继续等**，同时把"可能异常"明确提示出来。

### 改动

- **core**（`packages/core/src/index.ts`）：
  - 等待分支条件去掉 `gateWaitedMs + waitMs <= maxTotalMs`，改为 `waitMs > 0 && !signal.aborted`：
    只要插件报存活且未中断就照常等待（档位 60s 封顶）。
  - 新增 `overBudget = gateWaitedMs + waitMs > maxTotalMs`，超预算的每档等待在 `gate` 流事件
    与 `AgentStepGateRecord` 上都带 `overBudget: true`。
  - `skipped` 分支只剩 `zero_ladder`（阶梯配空数组），删掉 `budget_exhausted` 枚举与 `plannedMs` 附带
    —— 因为预算不再产生 skipping。
  - 注释泛化：`STEP_GATE_MAX_TOTAL_MS`、`StepGateOptions.maxTotalMs` 语义全部改写为"提醒阈值"。
- **CLI**（`packages/cli/src/index.ts`）：`step_gate` case 里当 `g.overBudget` 且本轮未提示过时，
  打一行 `⚠️ 等待后台任务已超过 5 分钟预算，可能卡死/异常；可 Ctrl-C 结束本轮…`；用 per-query
  `overBudgetNotified` 去重，后续心跳照发但不重复刷屏。

### 验证

- core `step-gate.test.ts`：预算耗尽用例重写为"超预算仍等待 + overBudget 标记"（`waitMs/attempt/waitedMs`
  逐档递增，`outcome` 恒为 waited）；删除 budget_exhausted 断言。
- telemetry `index.test.ts`：`overBudget` 布尔折叠登记（`metrics.overBudget: 1`）+ `zero_ladder`
  为唯一合法 skipReason。
- 全量 `bun run typecheck`：0 error；全量 test：39 包 0 fail。

### 复用要点

- **"预算耗尽就放行"这类兜底，得先问"放行之后结果能马上拿到吗"** —— 后台任务没跑完就放行，
  等于把"等一会儿就能拿到的结果"推迟到下一轮，这是静默丢数据的变体。宁可继续等 + 明说"可能异常"，
  也不要静默跳过。
- **终止条件不能交给"预估毫秒"，必须交给"确凿信号"**（插件不再报存活 / 用户中断）；
  `maxTotalMs` 这类阈值只配做"提醒"，不当"哨兵"。

---

## 2026-09-24（续 202）TUI 两处实测问题修复：选区闪烁 + 引擎告警不再污染渲染流

用户：「从新读下最近提交，并解决这两个问题 —— ①鼠标选区闪烁功能没实现；②缓存失效告警日志
打印到了 TUI 页面，导致 UI 错位」。两处都在 `packages/cli/src/tui.tsx` 与 `index.ts`，逐条落地。

### 一、问题 ②：缓存失效告警打进 TUI 渲染流，UI 错位

`core` 的 `noteSystemStability` 在「system 区前缀变化 ⇒ 缓存整段重算」时会 `logger.warn`。
CLI 的 boot logger 把 `warn/error` 直写 `options.stdout` —— 可 TUI 模式里 stdout 已被 OpenTUI
**接管做布局排版**，引擎每轮跑出的告警变成一行字节**混进渲染字符流**，把面板挤错位（用户反馈）。

修法（`HarnessApp`，`packages/cli/src/index.ts`）：

- 新增 `emitLog(level, msg, meta)` 统一出口 + `setLogSink(fn | undefined)` 挂接槽。
- boot logger 的 `warn/error` 改走 `emitLog`（`info/debug` 仍只在 verbose 下可写，不动）。
- TUI `mount` 时注册 sink：把 `warn/error` 经 `pushConsole` 渲染成**应用内 console 块**（UI 里
  正常一块，不再污染字节流）；卸载时 `setLogSink(undefined)` 复位。
- headless / REPL 不挂 sink ⇒ 行为不变（仍写 stdout）。

关键点：**TUI 不是"不显示告警"而是"把它变成 UI 内的一块"** —— 直写 stdout 的问题是"错位"，
不是"不该提示"；渲染进 console 块既保留提示、又不破坏布局。

### 二、问题 ①：鼠标选区闪烁两套通道，对 markdown 也生效

OpenTUI 没有"选区样式"API，拖选高亮是内核默认反显，在一屏彩色 markdown 里很难分辨
"到底选上没有"（用户反馈）。修法分两路：

- **`selectionBg / selectionFg`（user / tool / thinking 的纯 `<text>`）**：OpenTUI 的
  `TextBufferRenderable` 这两个属性就是内核读选区配色的入口。`selBlink` 每 `SELECTION_BLINK_MS`
  在 `SELECTION_BLINK_A`（亮黄底黑字）/ `SELECTION_BLINK_B`（暗灰底浅字）间切换 ⇒ 选中的
  文字反显会"闪"。只在有选区时开定时器、清选区即停（不留后台定时器）。
- **整块响应式高亮（assistant `<markdown>` 块）**：内核**改不了 markdown 的选区配色**
  （`MarkdownOptions` 没有 `selectionBg/Fg`，续 192 已实测），改用应用层：
  在 selection 事件里沿 `sel.selectedRenderables` 的 `parent` 链定位到我们给块容器加的
  `id="blk_<id>"`，算出被选区覆盖的块集合 `selBlockIds`；被覆盖块顶部渲染一行
  `⏳ 选区已选中此块 · 再次拖选可复制 / [Ctrl-Y] 复制文字`，随 `selBlink` 反显交替 ⇒ 整块"闪"。
  与纯 text 通道不同源、互不干扰。

### 三、验证

- cli 包 `typecheck`：**0 error**。
- cli 包 `bun test`：**381 pass / 0 fail**（新增「HarnessApp 日志 sink」+「拖选 assistant
  markdown 块 ⇒ 块顶部选区标记」两个用例）。
- 全量 `bun run typecheck`：**0 error**（39 包 Exited with code 0）。

### 四、复用要点

- **"直写 stdout"在 TUI 下永远危险**：OpenTUI 接管 stdout 做布局，"想打印一行日志"实际是往
  渲染字节流里塞一个不可预测的字符 → 任何宿主层日志都必须有"挂接槽"（sink）让渲染层接入，
  而不是自以为 stdout 还能写。
- **内核没有的选区 API，用"整块标记 + 应用层发散闪烁"绕过**：比起改内核，给被选区覆盖的
  容器沿 parent 链打标更稳，且对内核无法着色的 `<markdown>` 同样生效。

---

## 2026-09-24（续 201）提示词收敛三项：agent 执行/输出纪律 + 派工给足上下文 + 子 Agent 回传精简

用户：「优化 agent 提示词及子任务工具的提示词。使 agent 完成当前该做的事，不要发散，同时减少
输出长度。调用子任务工具时如果有可用上下文，需要给出足够的上下文，任务返回给父 agent 的信息
也要精简并准确，不做无用输出」。三句话正好对应三处，逐条落地。

### 一、Agent 提示词：补「执行纪律」+「输出纪律」

原 `packages/cli/src/prompts/default-agent.txt` 只有一句 `Be concise and precise.` —— 太抽象，
模型没什么可对齐的。现在拆成两条可检查的纪律：

- **执行纪律**：只做当前这一步该做的事（用户没要求的重构/额外检查一律不做）；先定"这一轮交付
  什么"、交付即停；发现别的问题最多记一句备注；信息够用就动手，不为"更保险"再查一遍。
- **输出纪律**：默认 1-3 句 + 必要证据（路径 / 行号 / 命令输出关键行）；不写开场白、不复述任务、
  不写"接下来还可以…"的建议清单、不写客套；猜测标"推测"。

`packages/plugins/coordinator/src/prompts/coordinator.txt` 同改，另加两条 coordinator 特有的：
**不播报进度**（"我正在派 worker…"一律不写，每轮只输出这一轮的**决策结果**）、
**不为"更保险"重复派工**。

判据写进了 `AGENTS.md`：**放进上下文的每一句都得能改变下一步决策，否则就是付费噪音**
（它会进历史、每轮重发，成本不止一次）。

### 二、派工给足上下文（子任务工具提示词）

子 Agent **看不到父会话**，缺上下文的派工只会换回泛泛而谈。清单（目标 / 路径与符号 / 已知结论
与约束 / 验收标准 / 范围边界）写在**三个模型真会看到的地方**，只写一处等于没写：

1. `inputSchema.prompt` 的 description（模型填参时最先看到的）；
2. 工具 `description`（工具列表里那一行）+ `documentation`（新增「怎么写 prompt」「结果怎么用」两节）；
3. `renderRoster()` 末尾一行（roster 是本插件唯一进派工方 system prompt 的东西）。

附反例（"看一下 packages/core 有什么问题"），以及续接 `sessionId` 时**只写增量要求**。

### 三、子 Agent 回传：默认 directive + 工具调用摘要折叠

**默认输出指令**（新增 `prompts/subagent-directive.txt`，导出 `SUBAGENT_OUTPUT_DIRECTIVE`）：
结论 / 依据 / 变更 / 未决 四段 + 60 行上限 + 禁过程流水账、客套、建议、无据结论。

- 动机：子 Agent 的整段回复**原样**进父 Agent 上下文；真机 9 份报告 4532~10195 字符，大半是
  "我先读了 X、然后发现 Y"的复述 —— 付了钱、挤占上下文、还把结论埋了。
- 层级：`createSubagentPlugin` 缺省注入（宿主可传 `directive` 覆盖，**传空字符串关闭**）；
  `createSubagentTool` 的 directive 参数仍严格"不传即不注入"，保持工具可独立测试。
- 只约束**结构与长度**，不约束内容 —— 该有的证据一条不能少。

**工具调用摘要折叠**（`TOOL_SUMMARY_MAX_ITEMS = 12`）：按 `toolId + 入参预览` 合并同类，
重复调用写成 `- read_file: /a.ts ×20`（次数是事实，不能丢），超出上限时末尾写
"其余 N 次已省略"。**静默截断会让父 Agent 以为"它就动了这些"** —— 与既有"摘要提示语不许
承诺读不到"是同一条纪律。

### 四、验证

- `bun run typecheck`：**0 error**（39 包，Exited with code 0）。
- `bun run test`：**1916 pass / 0 fail**（39 包，较上一篇 1911 **+5**）：subagent 148 → **151**
  （+2 摘要折叠、+3 默认 directive），端到端那条断言从"精确相等"改成"含 directive + 含任务原文"。

### 五、复用要点

- **提示词的收敛只能靠"可检查的纪律"，不能靠"be concise"**：抽象形容词没有对齐面，
  写"不写建议清单 / 不写过程流水账 / 60 行以内"才有。
- **同一条约束要写进所有"模型真会看到"的入口**：schema 描述 / 工具描述 / 文档 / system 注入，
  少一处就漏 —— 模型不一定读到你想让它读的那一段。
- **改提示词也要在测试里钉住关键约束本身**（默认指令含结论段 / 禁流水账 / 限 60 行），
  否则下一个人删掉一句完全看不出来。

---

## 2026-09-24（续 200）闸门遥测走 bus：`agent.step.gate`（含"该等却没等"）—— 顺带删掉一个不可达状态

上一篇给出的通道判据是"按**事实归属**选"，闸门那条留了待定：本次按用户定的"**走 bus**"落地。

### 一、为什么闸门可以走 bus（而不违反"同一事实不开两条通道"）

禁令针对的是**同一件事有两个发布入口**（历史上同一个 hook 名字由两层分别触发 ⇒
消费方分不清来源、按轮计数翻倍）。闸门不符合那个形态，两点理由：

1. **`core.agent.step.gate` hook 是输入侧提问**（"还有存活任务吗"），等待的**结果**
   （实际等了多久、睡了几片、是否被切片提前结束）**回不到 `decision` 对象里** ⇒
   非流式通道上没有任何同义的东西，这不是"再补一条"。
2. **`step_gate` 流事件只到 UI**（进程结束即蒸发）—— 这一点最容易误判成"已经上报过了"。
   实测：该事件在 `sessions/*.telemetry.jsonl` 里**一条都没有**，产线遥测里闸门是完整盲区，
   而切片粒度/退避档位只能靠线上数据调。

所以规则补成三条（已同步 `AGENTS.md` §4）：

- core 已有 hook 的事实 ⇒ 注册 hook（**不要**补同义 bus 事件）；
- **引擎自身的执行事实、且非流式通道上还是空白** ⇒ core 定义 bus 事件并由引擎发布；
- 同一事实的**两个消费者**（UI / 遥测）≠ 两条通道 —— 判据是"**这条事实有几个地方会发它**"，>1 才是事故原型。

### 二、core：`AgentEvents.stepGate`（事件名 `agent.step.gate`）

新开一组 `AgentEvents`（与 `LifecycleEvents` 分开：那组是"插件启停"的跨层解耦命令，本组是
引擎自身的执行轨迹）。**事件名 + 一个 `outcome` 判别式**（照 `harness.error` 用 `stage` 分档的先例），
而不是拆成 `waited` / `skipped` 两个名字 —— 它们是同一个问题的两个答案，拆开要消费方自己 join。

- `outcome: 'waited'`：`waitMs`（**实际**）/ `slices` / `sliceMs` / `plannedMs?`（仅提前结束时）……
- `outcome: 'skipped'`：`plannedMs`（**没能等的那一档**）/ `skipReason`。

发布点就在已有的 `step_gate` yield 旁边，同一份事实投递给两个消费者；`slices` 同时补进流事件
（它说明**引擎问了几次**，而探测次数正是 gate hook 的实现成本量级）。

发布方式是 **fire-and-forget + `.catch`**：`bus.publish` **不是**错误隔离（上一篇已实测），
一条写坏的遥测订阅者能把 agent 主循环带下水。守卫用例：`step-gate.test.ts` 的
「订阅者抛错不打断本轮」（少了 `.catch` 会冒 unhandled rejection / 主循环中断）。

### 三、⚠️ 删掉一个我自己刚写的不可达状态：`skipReason: 'aborted'`

初稿的 `skipReason` 是 `'budget_exhausted' | 'aborted' | 'zero_ladder'`，还配着注释
"`aborted` 是用户中断（正常，但要让本轮为何没减速可解释）"。**测试直接把它证伪了**：
断言 `records` 长度为 1，实际是 **0**。

真因：中断检查 `if (signal?.aborted) break` 在**循环顶部**（`core/src/index.ts:2487`），
**在闸门那段之前** —— 中断时循环直接 break，闸门**根本不会被问到**。所以那次写成
`signal?.aborted ? 'aborted' : …` 的三元分支永远取不到第一个值，是**死码**。

修法：把该分支收敛为 `} else if (!signal?.aborted) {`（信号在探测期间被置上的窄窗口不值得
为它造一个到不了的状态），`skipReason` 只剩两个真实可达值；中断用例反手改成**负断言**
（`probe.probes === 0` + `records.length === 0`），钉住"闸门在中断检查之后"这个顺序 ——
将来有人把闸门挪到中断检查之前，这条会红。

### 四、顺带纠正 `@harness/bus` 里两处误导性注释

`Bus.publish` 的接口文档写着"某个订阅者抛错不影响其他订阅者，错误收集到 AggregateError"、
类文档写"单个错误隔离" —— 读起来像"错误被隔离掉、调用方不必管"，**这正是上一轮把我带偏的源头**
（结论当时已在 `AGENTS.md` 纠正，但代码注释没改，会继续误导下一个读它的人）。
已改为"订阅者之间互不影响、**调用方不隔离**，失败收成 `AggregateError` 抛给调用方 ⇒
上报类事件请自行 `.catch`"。

### 五、telemetry：**零改动**

`subscribeAll` → `telemetry.bus.<name>`，新事件按名字自动入明细。补了 2 条口径测试钉住字段落法
（`waitMs`/`plannedMs`/`slices`/`waitedMs`/`aliveCount` 进 metrics 可求和；`outcome`/`skipReason`/`reason`
与归属 `sessionId`/`agentId` 进 attrs）。测试里刻意**不 import core 的类型**（事件按名匹配），
保持 telemetry 对具体包零依赖。

读法（会话级遥测，一条事件一行 JSON）：

```bash
jq -c 'select(.kind=="telemetry.bus.agent.step.gate") | {ts, o:.attrs.outcome, a:.attrs.agentId} + .metrics' \
  ~/.harness/sessions/<sid>.telemetry.jsonl
```

聚合口径：`sum(waitMs)` = 真的让出了多少时间；`sum(plannedMs - waitMs)` = 切片重探省掉的等待
（只在被提前结束时不等，故用两者相减才不重复计数）；`outcome=="skipped"` 条数 ÷ 检查点数 =
闸门实际退化比例，配 `attrs.skipReason` 看原因。

### 六、验证

- `bun run typecheck`：**39 包 0 error**（`EXIT=0`）。
- `bun run test`：**1911 pass / 0 fail**（39 包，较上一篇 1902 **+9**）。分项：core 154 → **161**（+7）、
  telemetry 39 → **41**（+2）、bus 包（注释改动，条数不变 22）。
- 新增用例（core）：waited 与流事件同源（含 `slices`）、提前结束 `waitMs < plannedMs`、
  预算用尽 `skipped(budget_exhausted)`、空阶梯 `skipped(zero_ladder)`、**静默不落事件**、
  无插件零事件、**订阅者抛错不打断本轮**；中断用例改为负断言。

### 七、复用要点

- **写枚举值之前先问"哪条路径能走到这里"，并写出触发它的用例**：写不出就是不可达。
  留着的代价不只是死码 —— 它会让消费方以为"中断也会记一条"，还会养成"契约里多写几个值没关系"的习惯。
  这一条靠测试发现（我原本很自信地把它写进了 doc 注释）。
- **"流事件 = 已上报"是个反复出现的错觉**：判可见性要看**落盘文件里有没有**，不看 UI 上有没有打印。
- **注释里的错误结论比没有注释更坏**：`@harness/bus` 那两行注释把我带偏了一整轮，
  而纠正结论时只改了 `AGENTS.md`、没改源头 ⇒ 这轮补上。发现一处就要连源头一起扫。

---

## 2026-09-24（续 199）给本轮新机制补遥测：整轮终态落盘 + 草稿归属事件 + 布尔字段不再静默丢

用户「增加遥测」。先盘了一遍**本轮六个观察点各自的遥测现状**，结论比预想的分化：

| 机制 | 原状 | 处置 |
|---|---|---|
| 观察点 2 · `coordinator.worker.completed` | **已有**（走 `ctx.bus` ⇒ telemetry 的 `subscribeAll` 自动落 `telemetry.bus.coordinator.worker.completed`） | 不动 |
| 观察点 3 · 闸门等待 | **零遥测**（只发 `step_gate` **流式事件**，只到 UI；core 的 bus 只有 7 条生命周期事件） | **待定通道**（见下） |
| 观察点 7 · 中途草稿 | **零遥测**（"有草稿文件 ⇔ 被掐断"只能靠 `ls`） | **本次落地** `SubagentEvents.draft` |
| 观察点 8 · 零收益压缩 | **已有**（`CompressEvent.zeroYield`，已写已测） | 不动 |
| 观察点 9 · 免计步 `freeSteps` | **零遥测**（只在 `turn_end` 流事件 + `core.agent.turn.end` hook 里） | **本次落地**（注册既有 hook） |

### 一、通道不是"全局选一个"，而是按**事实归属**选

三类落法，各有适用面（已写进 `AGENTS.md` §4）：

- **core 已有 hook 的事实**（整轮终态）⇒ **注册那条 hook**，**不要**再补同义的 bus 事件 ——
  同一个事实两条通道＝历史事故翻版（同名字由两层触发 ⇒ 消费方按轮计数翻倍）。
- **插件自己产生的事实**（草稿）⇒ **必须走 bus**：telemetry 是通用插件，**不该 import 具体插件的类型**。
- **插件已有自己的遥测 writer**（acp-context 的 `sessions/*.telemetry.jsonl` 自有 schema）⇒ 扩自己的 schema。

> ⚠️ 顺带纠正了我自己上一轮说法里的一处**想当然**：我当时以为 `bus.publish` 是"错误隔离、不会把发布方带下水"。
> 实测**不是** —— 它用 `Promise.allSettled` 并发跑完**全部**订阅者后，把失败收成 `AggregateError` **抛出**；
> `PluginManager.trigger` 顺序跑完后**同样抛**。两条通道都会抛，**没有哪条更安全** ⇒
> 凡上报类事件一律挂 `.catch(() => undefined)`（别让一条遥测把 agent 主循环带下水）。

### 二、观察点 9：注册 `core.agent.turn.end` → `telemetry.turn.end`

- 新增纯函数 `turnEndEnvelope()`（`telemetry/map.ts`）：落 `sessionId / agentId / agentName / mode / finish`
  作 attrs，`step / freeSteps / billedSteps` 作 metrics。
- **`billedSteps` 是派生量**（`step - freeSteps`），它才是 `maxSteps` 的消耗口径 ——
  观察点 9 之后"步号 30 但额度没耗尽"是**常态**，只看 `step` 会以为额度算错了。两个都落，消费方不必猜。
- `freeSteps === 0` 时**不落该字段**（缺省即 0，不塞无用字段）；`aborted` 只在真中断时记 1。
- 缺 `sessionId` **不丢事件**（照 `toolFailureEnvelope` 的口径：只在语义上该过滤时才返回 null）——
  无 sessionId 的轮落到 run 级文件，那也是它的正确归宿。
- 子 Agent 的轮**也会**走这条 hook（引擎不做"哪一轮算用户的轮"的判断）⇒ 靠 `mode` 标签区分，消费方自己筛。

### 三、观察点 7：`SubagentEvents.draft`（草稿的最终归属）

- 只在**真的写过草稿**时发（`flushCount > 0`）：15s 内跑完的快任务从不写草稿，
  给它发一条"没有草稿"是用噪声充数；**分母由 `completed` / `failed` 提供**。
- 载荷：`kept`（true = 被掐断、草稿是唯一留存；false = 正常结束已删除）、`chars`（保留时的字符数，
  `kept=false` 时为 0）、`flushCount`（步边界刷了几次）、`durationMs`、`path`（仅 kept 时给）。
- 顺带把"正常结束删草稿"那段改成**记录删除是否成功**：`rmSync` 失败时（原来静默 `catch {}`）
  草稿文件仍在，此时**必须上报 `kept=true`** —— 否则 `subagent-results/` 里会出现一个遥测无法解释的
  孤儿文件，"有草稿文件 ⇔ 被掐断"的等式就破了。
- `flushCount` / `chars` **只在写成功时递增**：写失败却报"刷了 3 次"会让线上排查拿到假证据。

### 四、修掉一类**静默丢字段**：布尔在遥测里一直是被丢的

`pickAttrs` / `pickMetrics` 原本只收 `string | number` ⇒ 载荷里的**布尔字段整条消失**。
已确认中招：`SubagentEvents.started { isContinuation: boolean }`、
`SubagentEvents.* { background?: boolean }`（`background: true` 一直在发、一直在丢）、
`AgentTurnEndSignal { aborted?: boolean }`。消费方只能把"字段不存在"当 false，
**分不清"真是 false"与"压根没采到"**。

修法：新增 `asNumber()` 把布尔折叠为 `0 | 1`（真实布尔以外的值——对象/数组/null/NaN/Infinity/空串——仍旧丢弃）。
事件契约里**照写布尔**（说人话），折叠是提取层的事。

### 五、验证

- `bun run typecheck`：**39 包 0 error**（`EXIT=0`）。
- `bun run test`：**1902 pass / 0 fail**（较上一篇 1890 **+12**）。分项：telemetry 30 → **39**（+9）、
  subagent 143 → **146**（+3）。
- 新增用例：`turnEndEnvelope` 6 条（含 `billedSteps` 分叉、aborted 折叠、缺 sessionId 不丢、子 Agent 轮）、
  提取器布尔折叠 2 条（含"不放宽其它类型"）、插件 hook 落会话文件 1 条（端到端，`crash: false`）；
  subagent 草稿事件 3 条（掐断 kept=true / 正常结束 kept=false 且 chars=0 / 快任务不发）。

### 六、复用要点

- **加遥测前先盘"这件事现在有没有人看得见"**：本轮五个机制里三个已有、两个为零 ——
  不盘就动手，很可能写一堆重复采集。判据：`grep` 事件名 + 看它走的是 `bus` 还是**流式事件**
  （**流式事件只到 UI，遥测一条都看不到**，这是最容易误判的一处）。
- **"文件存在性 = 状态"这类隐式语义，一旦要统计就必须事件化**：`ls` 能验证不变量，
  但答不了"掐断率是多少"。
- **别把"我以为的框架行为"当事实**：本轮我误判 `bus.publish` 错误隔离，差点把它当"更安全的通道"写进
  `AGENTS.md`（那条会进每次会话的上下文）。**判据要看实现，不看直觉**。

---

## 2026-09-24（续 198）闸门等待语义改为「分片睡眠 + 片间重探」（方案 A）：不再睡满整档

用户追问"闸门是硬等固定时间，还是有结果就可以返回执行了"，复核后确认是**硬等一档**，
随即定方向"**按 a 修**"（见架构文档 §17.7 的三方案对比）。

> 编号说明：本篇编号从 197 跳到 198。原因是上一篇勘误（闸门挂靠"续轮"而非"空转"）当时被**折进
> 续 196 的正文**（以 `⚠️ 勘误（次日自查）` 的形式），提交 `ae47cb1` 的信息虽写"新增续 197"，
> 但文档里**没有** 197 这个标题；记忆文件 `2026-09-24.md` 已用 197 指代那次勘误。
> 为避免同一编号指两件事，本篇沿用 198。

### 一、问题的定性：硬等的代价落在"快任务"上

`sleepAbortable(ms, signal)` 原来只有两条 resolve 路径：`setTimeout` 到点、`signal` 中断
（全仓 grep 无任何 `wake` / `notifyStepGate` 入口）。于是**子任务第 1 秒跑完，闸门仍会睡满这一档**
（最坏 60s）。最难受的情形是"任务其实全完成了，而闸门正睡在 60s 档上"，界面还显示"等待后台任务"。

取舍算清楚：档位本身 3~60s，迟到 500ms 占比 <2% —— 于是用这点延迟换"零新 API + 无状态 +
降级即现状"，而不是引入事件唤醒（方案 B 是 A 的**超集**：唤醒后仍要重探，只多了"更精准的触发器"
却要付"会话→唤醒器表的四路清理 + 唤醒先于注册到达的竞态"）。

### 二、core：一档切成若干片，片间重探

- 新增 `STEP_GATE_SLICE_MS = 500` 与 `normalizeSliceMs(n)`（`<=0` / `NaN` ⇒ 0 = 退化为整档硬等，
  保证"测试里的毫秒级档位"行为与改造前**逐字一致**）。
- 等待循环改为：`while (本档剩余 > 0 && !aborted)` → 睡 `min(片长, 剩余)` → **重跑一次
  `core.agent.step.gate`** → 插件静默即 break。
- 片间重探传的 `waitAttempt` / `waitedMs` 与**这一档开始时完全相同** —— 引擎要到整档结束才记一次账，
  插件正是靠这两个值区分"片间重探"与"新的一次等待"。
- **正好睡满时不再补一次探测**（那时问了只会得到"还有任务"，纯浪费）。
- 累计预算 `STEP_GATE_MAX_TOTAL_MS`（300s）与"每步边界最多等一次"两条边界不变。

### 三、事件与 UI：`waitMs` 报实际值，被提前结束另带 `plannedMs`

- `gate.waitMs` 从"本档原定"改为"**实际**等待"；被提前结束时另带 `plannedMs`（本档原定时长）——
  报"等了 3s"而实际只有 0.5s 就是假信息。
- CLI 那行心跳相应改为 `本次 1.5s（原定 3s），累计 1.5s`，**秒数保留一位小数**
  （取整会把 500ms 报成 1s，恰好把这个机制在界面上抹掉）。
- 顺带修掉上一轮的**漏改**：`AgentStreamEvent.gate` 的字段注释仍写"本步本次/本步已累计"，
  而这两个量实为**本轮 query 内跨步累加**（同一处错误当时只改了 `plugin` 侧，`core` 侧漏了）。

### 四、协议：把「禁 IO」从建议升为硬约束

分片让 hook 调用次数放大到 `档位÷切片`（60s 档 = **120 次**）。原有注释只写"判据要保守"，
现改为**硬约束**：**本 hook 必须纯内存判定、禁止 IO**（`plugin/src/index.ts` 的 hook 注释
与 `AGENTS.md` §4 均已写明）。当前实现 `registry.list().filter()` 是纯内存过滤，符合。

### 五、测试（`step-gate.test.ts` 15 → 21 pass）

- L1：`normalizeSliceMs` 的 `0` / 负数 / `NaN` 全部规约到 0（退化为硬等）。
- L2 三条新用例：
  - **片内静默 ⇒ 提前结束**：档位 400ms、切片 25ms，任务在第 2 片后翻"静默"——
    实测等待 `< 档位`，且事件 `waitMs < plannedMs`；
  - **全程 pending ⇒ 睡满档位**，且 `waitMs === plannedMs`（不报假账）；
  - **`sliceMs: 0` ⇒ 与改造前一致**（仍发一次事件、`waitMs === 档位`）。
- 中断用例改为**覆盖"切片等待中被打断"**：单档 10s，断言实际返回 `<< 10000ms`
  （切片不会让中断变慢 —— 每片都会查 `signal.aborted`）。

### 六、文档

- `docs/agent-harness-architecture.md`：§17.4 由「硬等一档，不提前返回」改写为
  「分片重探，最多迟一个切片」（含时序示例、代价收益、两个实现细节）；§17.7 标题去掉"（未落地）"，
  方案 A 标 **已落地**，并补"B 是 A 的超集""何时才该上 B"。
- `AGENTS.md` §4 闸门那条补"分片重探 + 禁 IO 硬约束 + `plannedMs` 语义"。
- `packages/plugin/src/index.ts`：hook 注释补机制说明（分片、禁 IO）与触达条件。

### 七、验证

- `bun run typecheck`：**39 包 0 error**（`EXIT=0`）。
- `bun run test`：**1890 pass / 0 fail**（39 包逐包跑、`TEST_EXIT=0`；较上一篇 1884 **+6 条**，
  全部来自 `step-gate.test.ts` 15 → **21**）。分项：core 154 / plugin 42 / subagent 143 /
  coordinator 33 / cli 379 / tools-builtin 83 / acp-context 80 / memory 88 / skill-forge 57。
- 报告 `outputs/session-analysis/session-tg1a6-report.html` 重建为 **97.7 KB**：
  观察点 3 与第十二章 · 修复 6 补入切片重探、验证矩阵换新数字、勘误卡由三处扩到**四处**、
  共同设计原则 9 → **11 条**（新增"阻塞要有明确的提前返回上界""轮询要写明被调方必须轻量"）。

### 八、复用要点

- **"等待"这类阻塞要给出"多久能提前返回"的明确上界**，否则用户只能靠重发自救。
  本项目的上界是**一个切片**，不是一整档。
- **改等待语义时把"实际值"与"计划值"分开上报**（`waitMs` / `plannedMs`）——
  只报一个数，调用方分不清"按计划等完了"还是"提前醒了"。
- **轮询是放大器**：任何"片间重探 / 定时重试"的协议，都要把"被调方必须轻量"写成硬约束，
  不能停留在"建议"（否则 120 次/档会打爆一个做 IO 的实现）。
- **切片粒度要能被注入**：默认 500ms 在生产足够，测试压到 5~25ms 才能进单测。
  设计时就让切片与阶梯**都**可注入，比事后加参数省事。观察点 2/3/4/7/8/9 全部落地：单任务完成即唤醒 + 步间退避闸门 + 只读 bash + 中途草稿 + 跳过空压缩 + 免计步

用户逐条定方向："2 改成单任务完成即入队；3 派任务后，会话每执行一轮都等一会再跑，考虑指数退避，
例如先 3s, 6s 再 12s，最长 60s 之类的，等到最大后需要探测子任务是否存活。4 可以 7 可以 8 可以 9 可以"。
续 195 只落了 1/5/6/10（正确性缺陷），剩 6 条属"s 策略 or 产品判断"，本轮全部闭环。

### 一、观察点 2：barrier 拆出「单任务完成」事件（`coordinator` + `cli`）

- 新增 `CoordinatorEvents.workerCompleted`（载荷 `{sessionId, taskId, status, remaining}`），
  **仅 `remaining > 0` 才发** —— 最后一个任务仍走 `barrier.completed`，否则外层会注入两行 `<continue/>`。
- **关键顺序**：`remaining` 必须在 `tracker.onWorkerFinished()` **之前**算 —— 后者在计数归零时会
  `active.delete(parentSessionId)`，之后再问 `activeCount()` 恒为 0（"快任务完成也报 remaining=0"
  ⇒ `workerCompleted` 永远发不出来）。
- `attachAutoContinue` 同时订阅两条事件，卸载函数**两条都摘**；`coordinator.txt` 派工规则改为
  "系统**不等全部任务结束**"，续轮段新增"**部分到达是常态**…不要因为'还差几个'就空转等待"。
- 测试：coordinator 33 pass（+3 条）、cli 379 pass（+1 条）。

### 二、观察点 3：步间闸门 + 指数退避（本轮最大改动；`core` + `plugin` + `subagent` + `cli`）

**病根重新定性**：原观察点写作「任务通知注入 = maxSteps 额度重置」，但真病根不是"额度给少了"，
而是**空转把额度烧光**（lead 撞顶两次共 60 步）。所以解法不是改额度语义，而是**让等待不耗步**。

- 引擎层新 hook **`core.agent.step.gate`**：每步开跑前问插件"还有存活后台任务吗"，插件置
  `decision.pending = true` 即等待。多插件语义是 **OR**，`aliveCount` 取最大。
- 退避参数可注入（测试可压到毫秒）：`STEP_GATE_BACKOFF_MS = [3s, 6s, 12s, 24s, 48s, 60s]`、
  累计上限 `STEP_GATE_MAX_TOTAL_MS = 300s`；宿主经 `AgentHarnessOptions.stepGate` /
  `AgentRuntimeImpl.deps.stepGate` 覆盖。
- **`stepGateDelayMs(NaN)` 的坑**：`Math.floor(NaN)` 是 NaN，`Math.max/min` 拦不住 ⇒ `ladder[NaN]`
  返回 `undefined`（类型上还骗过了 `number`）。必须显式 `Number.isNaN(attempt) ? 0 : Math.floor(attempt)`。
- **语义是「每个步边界最多等一次」** —— 写成 `while (gateClosed)` 会在探针恒报存活时**无限卡死**
  （e2e 5000ms 超时暴露）。等待只发生在**一次模型推理开跑之前**，不插在任何一次工具执行前后。
- **⚠️ 勘误（次日自查）**：本篇初稿把闸门的触达条件写成"只在**空转步**前有意义、干活的步没有机会等到
  对端"——**说反了**。事实是 `shouldContinueStep()` 的判据为 `toolCallCount > 0`：**上一步调了工具才算续轮**，
  所以**能走到闸门的步边界，前提全都是上一步调用过工具**；上一步没调工具（给最终答复）时本轮直接结束，
  闸门**根本不会被触达**。"有 tool call 就不等"是反的。真机语境里的"空转"指**有 tool call 但无进展**
  （反复 read_file/bash 查状态），这类步同样续轮、同样被闸门减速 —— 闸门治的正是它们。
  闸门自己也不可能预判产出形态：它在推理**之前**执行，那时 `tool_calls` 还没发生。
- **`step-gate.test.ts` 顶部注释的同类错误**：初稿写"插件说没了 ⇒ 整轮关闭、不逐步重探"，而实现是
  **每步重探 + 阶梯归零**（`gateAttempt = 0`，不关闸门）——同文件第 206 行注释与断言 `probe.probes === 2`
  都指向后者，属于同一文件内自相矛盾。已一并改正。
- 等待**必须可见**（>15s 无输出要有心跳）：发 `step_gate` 流事件（载荷 `waitMs/waitedMs/attempt/
  aliveCount/reason`）；CLI 新增 `waiting` 相位、`formatAgentPhase` 返回「等待后台任务」。
- 插件侧实现（`subagent`）：**唯一地面真相是 `BackgroundTaskRegistry`**，只认 `pending` / `running`。
- 终止条件依赖插件上报 ⇒ 引擎侧**必须有等待总预算兜底**（`maxTotalMs`）—— 硬约束。
- 测试：新建 `packages/core/src/step-gate.test.ts` **15 pass**（L1 阶梯/NaN/空阶梯/decision 清洗；
  L2 端到端 8 条：逐次发事件 / 静默即归零 / 每步重探 / 预算兜底 / `enabled:false` 连探测都不做 /
  `maxSteps=1` 不触发 / 中断可打断 / 无插件行为不变）。

### 三、观察点 4：只读哨兵给沙箱只读 bash（`bash_ro`，`tools-builtin`）

- `wc` / `grep` / `python3 -c` 一类只读命令可用；**入参不可覆盖环境变量**（ENV 是绕过只读的后门，
  实测注入被拒、退出码非 0）。
- **测试坑**：新增的 `describe('bash_ro…')` 是**顶层** describe，不在外层
  `describe('@harness/tools-builtin')` 里 ⇒ 外层 `beforeEach`（建 TMP_DIR）/`afterEach`（删 TMP_DIR）
  **管不到它**，其他用例的 `afterEach` 已删掉 TMP_DIR ⇒ `writeFile` ENOENT、`spawn` 的 `cwd` 不存在
  ⇒ `SPAWN_ERROR`。修法是给该 describe 补自己的 `beforeEach/afterEach`。
- **类型坑**：`ToolResult` 是**非判别联合**（`ok: boolean` + 可选 `output?/error?`）⇒ `if (!r.ok)`
  **不收窄**类型，断言要写 `r.error?.code` / `r.output?.exitCode`。
- 测试：tools-builtin 83 pass（两处修复后 0 fail）。

### 四、观察点 7：长任务中途草稿落盘（`subagent`）

- `writeDraftFile(taskId, body, resultsDir)`：按 taskId **固定命名 + 覆盖写**（永远只有一份最新草稿）。
- **触发点用「步边界」而不是定时器** —— 步边界本来就是天然刷盘点；草稿状态（`draftDigest`/`draftPath`）
  必须声明在 `try` **之外**（catch 里要用 `flushDraft()`）。
- **正常结束 `rmSync(draftPath, { force: true })`** ⇒ 于是「有草稿文件 ⇔ 这次被掐断」成为可判定的事实；
  失败/超时路径把草稿路径 + **如实**的可读性说明（`describeDraftLocation`）拼进 `errorMessage`。
- 落盘位置守既有约定：`{dataDir}/subagent-results/`，**不落 `os.tmpdir()`**（macOS 定期清理），**不落 cwd**。
- 测试：subagent 143 pass（新增 3 条：掐断留稿 / 覆盖只一份 / 正常结束无残留）。

### 五、观察点 8：跳过零收益空压缩（`acp-context` + `core`）

零收益时（`createdBlocks:0 && tokensCompressed:0 && ranges:[{chars:0}]`）`compress` 改回
**`ok:false + NO_EFFECT`**；core `compact()` 空窗口不生成摘要 ⇒ 省一次完整 LLM 调用。

### 六、观察点 9：必填全缺的回喂免计一步（`core` + `plugin`）

- **两套计数**：`billedSteps`（吃额度）与 `step`（展示步号）；`StepOutcome.selfHealOnly` 在"本步
  `toolCalls` **全部**命中入参自愈"时置真（用 `selfHealIdx: Set<number>` 在 `[入参自愈]` 追加处
  **单点登记**，漏出口只会更保守）。
- **硬上限 `MAX_SELF_HEAL_FREE_STEPS = 3` 是必要兜底**：doom-loop 只认「同一工具+同一入参连续 3 次 /
  连续 3 步整步签名相同」，**`A,B,A,B…` 交替空参能完美绕开它** ⇒ 免费额度必须有天花板，
  否则会架空 `maxSteps` 这个唯一刹车。
- `turn_end` 事件与 `core.agent.turn.end` hook 都带 `freeSteps`，解释"步号 ≠ 额度"。
- 测试：`tool-arg-selfheal.test.ts` 8 pass（+4 条，含交替空参不无限循环：`freeSteps=3`、`provider.calls=6`）。

### 七、验证

- `bun run typecheck`：**39 包全 0 error**。
- `bun run test`：**1884 pass / 0 fail**、39 包逐包跑、**`EXIT=0`**；较本轮起点（1840）**+44 条**。
- 报告更新为 **92.5 KB**：观察点表 10 项全 `已修`、第十二章标题改「（十项）」+ 新增 6 行改动一览、
  验证矩阵换新数字并新增 5 行、共同设计原则 4→9 条、附录补齐修复 5~10。

### 八、复用要点

- **判机制挂在哪个判据上时，别用效果描述代替机制描述** —— 闸门初稿被写"只在空转步前有意义"，
  把"真机现象（反复无效调工具）"当成了"代码判据（`toolCallCount > 0` 才续轮）"，因果正好颠倒。
  写这类注释前先找到**那一行判定函数**（本项目是 `shouldContinueStep`），别从现象反推。
- **事件载荷要用的计数，必须在会改它的那次调用之前取**（`remaining` vs `onWorkerFinished`）。
- **任何"免费额度/豁免"都必须封顶**，并顺带检查它会不会绕开既有的循环守卫。
- **草稿类落盘用"正常结束即删"编码语义**，比额外写状态标记可靠（文件存在性本身就是状态）。
- 顶层 `describe` 不继承外层 `beforeEach/afterEach` —— 拆分测试块时最容易踩的一脚。
- 本机两个小坑：`grep 'a\|b'` 在 BSD grep 下不可靠（用 Grep 工具）；**BSD awk 不支持三参
  `match($0, re, arr)`**（聚合日志改用 Python）。

---

## 2026-09-23（续 195）四项修复：grep_file 契约 / throw 型失败遥测 / FEEDBACK.md 单列 / skill-forge 会话隔离 + 线上迁移

用户："1、技能的也要修一下 2、选单列 FEEDBACK.md 3、还有其他优化的也一起优化"。

### 修复 1：grep_file 契约错位（`packages/plugins/tools-search`）

**根因不是"模型不会用工具"，是 schema 描述与实现直接矛盾**：`pattern` 描述原文写「要搜索的文本（**字面量**）」，
实现却按 `new RegExp` 编译；`caseSensitive` 描述写「默认 false」实际默认 true。
⇒ 改为：默认仍按正则；**编译失败自动退化为字面量再搜一次**，输出带 `mode:'literal'` + `notify` 说明
（**不静默改口径**）；新增显式 `literal:true`；新增纯函数 `escapeRegExp()`；两处文案修正。
测试 18 pass（删旧的"无效正则硬报错"1 条，新增 3 条）。

### 修复 2：throw 型失败遥测盲区（`tool` / `core` / `telemetry`）

- 关键设计：**不在 `safeExecuteTool` 的 catch 里补上报**（那会开出第二条实现路径、与 pipeline 漂移）；
  改为在 pipeline 内部**把错误路径也接进 postHooks** —— `_throwToolFailureWithHooks()` 先归一化成失败
  `ToolResult` 喂 hook，**然后原样 rethrow**（调用方仍按错误名判权限拒绝、模型看到的 message 不变）。
  `ToolPermissionAskRequiredError` 是控制流信号，刻意不上报。
- 新增 `normalizeToolError()` 作**全仓唯一**「错误 → ToolResult」映射点，core 的 `safeExecuteTool` 改为委托它。
- Step 1/2 包进 try/catch；Step 3~6 的 dispatch 同样包 ⇒ 错误路径全部可达 Step 7
  （`telemetry.permission.deny` 此前恒为 0 的成因同上）。domm-loop 两处短路手工补派发
  （`_emitUnpipelinedToolFailure`）；`toolFailureEnvelope` 带上 `sessionId`。

### 修复 3：feedback 单列 `FEEDBACK.md` 并改走尾部动态区（`memory` + `skill-forge`）

用户选 C。理由：feedback 是**机器自动回写、时刻与用户的轮无关**，住 system 前缀区等于
"一次工具报错换一次全量前缀失效"；尾部动态区不参与前缀缓存（代价是每轮全价，故条数/字节压到
**5 条 / 800 B**，文件不存在时零成本）。

- `renderFeedbackSection()`（尾部、逐条从最新往旧、超字节丢最旧）、`splitFeedbackEntries()`（迁移纯函数）、
  `MemoryStore.rawText()/rewrite()`、`/memory migrate` 显式命令、`/memory path|show|list` 扩展。
- `renderMemorySection()` 参数化（`MemorySectionStyle`），**默认措辞逐字不动**（那是前缀缓存的一部分）。
- **顺带修的权限缺陷**：`writeAtomic` 的"临时文件 + rename"会把权限重置成 umask 默认（644）⇒ 迁移后
  `FEEDBACK.md` 果然从 600 掉到 644。已 `chmodSync(tmp, 原 mode)` 再 rename
  （`writeFileSync` 的 `mode` 会被 umask 掩掉，只有 chmod 准）。
- skill-forge 的失败回写目标一并改指 `FEEDBACK.md`。
- 测试：memory 88 pass（+19 条）。

### 修复 4：skill-forge 延迟注入按会话隔离

与 memory（续 194）同构：`Map<sessionId, SkillInjectScheduler>` + `mainSessions` 白名单
（由 `core.prompt.system.transform` 登记）+ 缺 sessionId fail-closed。
**额外堵住一条反向泄漏**：原 `takeDue()` 不判会话 ⇒ **子 Agent 建 prompt 会把主会话的待发布队列消费掉**
（技能被"领走"却没注入主会话）。测试 57 pass（新增 6 条会话隔离，含"主会话自己 compress 照常发布"的正向对照）。

### 线上迁移（一次性）

`~/.harness/memory/MEMORY.md` 的 5 条 `[feedback]`（570 B）→ `FEEDBACK.md`（570 B，chmod 600）；
备份 `MEMORY.md.bak-20260923-223151`；`MEMORY.md` 归 0 字节。迁移经 `/memory migrate` 显式发起
（不静默改用户记忆文件）。

---

## 2026-09-23（续 194）查清并修掉「子 Agent 的压缩击穿主会话前缀缓存」（memory 发布器按会话隔离）

用户问："memory 写入会击穿前缀缓存，但之前已实现新 memory 不直接进系统提示词。"
结论：**分级注入（M3）没有失效，失效的是"谁有权按下发布键"。**

### 根因（证据链闭合到字符级）

1. **system 区「一次查询内不变」**：`core/src/index.ts:1993 _prepareQueryOnce`（"一次查询内**只做一次**的准备"）
   → `PreparedQuery{sysParts,dynParts,systemStability}` 被该 turn 的每一轮复用 ⇒ 记忆段只在**轮边界**落地；
   也解释了遥测 round 32~35 的 `systemChangedDetail`/`tailDynamicChars` **四行完全一样**（同一份对象）。
2. **发布器/沉淀提示是 `install()` 的闭包局部量**，主会话与所有子 Agent 会话共用；而
   `core.tool.post.execute` 里 `if (toolId === 'compress')` **无会话条件**（hook ctx 里一直有 `ctx.sessionId`）。
3. 本 run **仅有的 2 次 compress 都在失败 reader `s_Markdown…t7oks` 会话**：19:42:55（未达阈值）、
   19:43:23（成功，压缩 77,563 token）⇒ 主会话 `publisher.forced = true`。
4. 19:43:47 skill-forge F3 把该 reader 的 2 条 grep 失败回写 `~/.harness/memory/MEMORY.md`（401 字符，+192）。
5. turn 2 第一轮（round 32）重建 system 区 → `forced` → 直接发布 619 版
   ⇒ `cacheMissReason: system-changed` / `prefixStableMessages: 0` / **`cacheDropTokens: 52,096`**（占该轮 87.7%）。

### 复算（逐字符）

- `renderMemorySection` 固定装饰 = **218 字符**；3 条 209 → 427、5 条 401 → 619，**与遥测逐位吻合**。
- 前 3 条来源用"扫全部会话的错误串"定位：09-21 `s_…ra6w1`（read_file 越界）、09-22 `s_…9cq9r`（bash / subagent 未注册）
  ⇒ **本会话 turn 1 起该段就是 427**，turn 1 全程缓存健康（没有"中途长出记忆段"这回事）。
- **独立证据**：round 32 `tailDynamicChars = 270` == `buildReflectionHint(...)` 逐字长度；而主会话
  `stats.compressionCount = 0` ⇒ 那句"刚刚发生了上下文压缩"是**子会话产生、主会话消费**的**假事实**
  （正确性问题，不只是成本）。

### 修复（`packages/plugins/memory/src/index.ts`）

- `publishers: Map<sid, MemoryPublisher>` / `hints: Map<sid, string>` / `mainSessions: Set<sid>`；
  `publisherFor()` 只为主会话惰性创建（数量与主会话数同阶，不被派工刷爆）。
- compress 与 `core.session.compacting` 都加 `mainSessions.has(ctx.sessionId)`；**缺 sessionId 一律
  fail-closed 不 flush**（代价不对称：晚发布几轮 vs 5 万 token 前缀报废）。
- `turn.end` 只推进"确实发布过的主会话"；字段缺失时对所有已发布主会话各推进一格（保住"兜底不能变死代码"）。
- `/memory add|reload|list` 同样只作用于发起会话。
- 验证：memory **69 pass / 0 fail**（新增 7 条会话隔离回归，含正向对照）。

---

## 2026-09-23（续 193）会话 s_1790163574429_tg1a6 及遥测取证分析（产出报告，未改代码）

用户："分析这个会话及遥测"。对象 = 19:39:34~19:46:39（425.2s）的 lead 会话，任务
「分析 claude-code-analysis-main 并生成 html 文档」，模型 deepseek-flash，62 轮 / 68 消息 /
输入 3,286,491 tok / 输出 46,971 / cacheRead 3,154,176（96.0%）。

产出：`outputs/session-analysis/session-tg1a6-report.html`（54.9 KB）+ 可复用脚本
`analyze_session.py`、`build_report.py`。

### 四条发现（按硬度排序）

1. **唯一缓存失效点 = `<memory>` 段中途变大**。round 32 遥测给到
   `systemChangedDetail: ["第 2 段变化：427 → 619 字符（首行：「<memory>」）"]`、
   `prefixChangedKind=mutated` + `cacheDropTokens=52096`。溯源到 `~/.harness/memory/MEMORY.md`（570 B）：
   **后 2 条正是失败 subagent 产生的「grep_file 反复失败」feedback**，前 3 行包装 ≈427 字符、
   5 行 ≈619 字符，数字吻合 ⇒ **一个 subagent 的工具报错 → 记忆写入 → 主会话 52K token 前缀缓存归零**。
2. **`grep_file` 缺字面量语义** —— 43 次 `INVALID_REGEX`，模型想搜的是 markdown 链接语法
   `](` `![` `](../` 这类**字面量**，被当正则编译。失败率 43/113=38%，该工具独吞 944,575 input token
   （占该 subagent 输入的 66%）。错误消息里**无修正指引**。
3. **两个 reader 同任务对照，结局相反**：成功者 36 轮 / 66.6s / grep 22 次 0 失败；失败者 35 轮 /
   **119,916ms 撞后台 120s 硬超时** / grep 113 次 43 失败。**LLM 轮次几乎相同（36 vs 35），耗时差 1.8 倍**
   ⇒ 瓶颈是工具形态不是模型。失败者另撞 `reader.md` 的 `maxSteps: 35` 上限，正在生成最终答复时被杀，
   `tasksDone=0` —— **只读任务无中途落盘，成果全丢**；round 11 还有一次零收益空压缩
   （`createdBlocks:0, tokensCompressed:0, ranges:[{chars:0}]`）。
4. **遥测埋点错位**：`toolFailureEnvelope` 挂在 `core.tool.post.execute` = `ToolPipeline.execute()` 的 **Step 7**；
   而 Step 1（`inputSchema.safeParse`）、Step 2（`validateInput`）、Step 3（preHook 洋葱）**失败即 throw，
   跳过 Step 7** ⇒ **schema 校验类 / preHook 拦截类失败全部不上报**。证据：同会话 6 次「模型丢入参」
   （`input={}`），bash 的 3 次（工具内部 `return`，code `COMMAND_REQUIRED`）上报了，read_file 的 3 次
   （`throw` 后被 `safeExecuteTool` 归一化为 code `TOOL_ERROR`）**没上报**。

### 顺带确认的两条工程事实

- **`barrier` 等全部任务完成才发通知**：reader#2 19:43:10 完成，`barrier.completed` 19:44:03 才触发
  （与最慢任务同毫秒）⇒ 快结果被拖 53s，就绪时 lead 已无活跃 query ⇒ 滞留到 19:45:06 用户敲「？」才注入。
- **`<task-notification>` 注入会重置 maxSteps 额度**：lead 无 `maxSteps` ⇒ 走 `DEFAULT_MAX_STEPS=30`，
  但本会话撞顶两次（msg31/msg66），两份额度共 60 步；通知以 `user` 角色注入 ⇒ 新 query ⇒ 计数从 0 重开。

### ⚠️ 读遥测的口径陷阱（下次别再踩）

- `~/.harness/sessions/run.telemetry.jsonl` 是**跨 run 累积**（1258 行 / 9 次 harness 初始化），不是单会话；
  单会话口径要读 `sessions/<sid>.telemetry.jsonl`。混用两个文件的计数会得出荒谬结论。
- **Grep 工具默认遵守 .gitignore ⇒ 搜不到 `dist/`**；要连构建产物一起搜得走 Bash 的 `grep -rn`。

---
## 2026-09-22（续 192）TUI 三项：侧栏滚动条 / 统计加缓存命中率 / 选区闪烁与可点击复制

用户："1、Tab 页实现滚动条 2、tab 统计信息增加缓存命中率 3、鼠标选区时能否增加选中文字闪烁，
选区后输入框里的复制图标目前不能点击直接复制"。

### 一、侧栏滚动条：**宽度算错 2 列，滚动条被父容器裁掉**（真 bug）

侧栏外层是 `width: SIDEBAR_WIDTH(26) + border: true` —— 26 里含左右两条边框，**内部可用只有 24 列**；
而内层 scrollbox 又写死 `width: SIDEBAR_WIDTH(26)`，于是它比容器宽 2 列，位于其右边缘的垂直滚动条
被推到可视区之外 ⇒ 表现为"面板没有滚动条、内容还溢出边框"。

修法：`width: '100%'`（跟随内层可用宽度）。另显式给滚动条配色 —— OpenTUI 滑块默认色是
`RGBA(37,37,39)`（近黑），深色背景上等于隐身。

**反证**：把宽度改回 `SIDEBAR_WIDTH` 后，测试断言"侧栏列范围内滑块数 > 0"失败（实测 0）——
即滚动条确实被裁掉，不是"本来就没有"。

### 二、统计 tab 加缓存命中率

`缓存⚡N · 未命中M` → `缓存⚡N · 未命中M · **命中率X%**`。抽成导出的 `cacheUsageLine(u)`，
口径集中走 `@harness/usage` 的 `cacheHitRate()`（它已把非法值/零输入归 0，不会漏 `NaN%`）。

### 三、选区：闪烁 + 复制图标可点

**(a) 选中文字闪烁（真的闪了）**：抓手是 `selectionBg` / `selectionFg`（TextBufferRenderable 的
选区配色）+ 每 450ms 在两套配色间切换。用 `captureSpans()` 逐帧采样证实：选中 span 的底色在
`#3a4150` 与 `#d7a521` 之间交替（`captureSpans` 的 bg 分量是 **0~1 浮点**，不是 0~255）。

⚠️ **限制（实测，非推断）**：`selectionBg/selectionFg` 只对**纯 `<text>`** 生效。
`MarkdownOptions`（@opentui/core 0.5.8）**没有**这两个字段，助手 markdown 块的选区底色恒为内核
默认的浅灰 `#e6edf3`。所以用户/工具/思考块会闪，**助手正文（markdown）不会**。
为此 chip 按钮本身也跟着同节奏闪 —— 即使选中的是 markdown 块，也能一眼看出"选中了"。
上游若补上这两个字段，把 `{...selStyleProps}` 加回 markdown 即可（代码里留了注释与位置）。

**(b) 复制图标可点击**：此前整条 chip 只有"点一下清掉选区"，鼠标用户没有可点的复制入口。
现在 chip 是 `⧉ 复制 N 字符 ✕`：点 Chip 的 ⧉ 区复制、点末尾 ✕ 清除。

三个坑（都是实测踩出来的，逐条记下）：
1. **点击时现取选区会拿到空的**：点 chip 的 mousedown 会让内核**先清掉选区**，所以内容必须取自
   `selection` 事件里存的**快照**（`selSnapshotRef`），不能点击时现取。
2. **只挂 `onMouseUp` 会漏**：mousedown 先清选区、节点可能已卸载，mouseup 就落在空处 ⇒ "点了没反应"。
   改成 down/up 都挂 + 300ms 时间戳去重。
3. **同一行相邻两个 `<text>` 的命中测试不可靠**：最初做成"复制按钮 + ✕ 按钮"两个元素，实测点 ✕
   会被判到复制按钮上（debug 打印显示 copy 连触发 4 次、✕ 处理器一次没进）——
   "想清除选区的点击"变成了"又复制一次"。改成**单个 text、用 `MouseEvent.x - currentTarget.screenX`
   按列分派**后两条路径都对。附带保住了原有契约（点 ✕ = 清除），既有用例不必删、只需改文案。
4. 复制后的 `✓ 已复制` 不能靠"选区清空"来复位（那次 n=0 的事件会把刚设好的反馈立刻抹掉），
   改为只在**出现新选区**时复位；并给"已复制"加 2.5s 自动收起，避免没有 ✕ 时消不掉。

### 四、验证

新增 4 例（滚动条 1 / 命中率 2 / 选区 1）+ 更新 1 例既有 chip 用例（文案与"chip 长在输入行"的断言；
并把它写成"按 x 分派"的回归闸门）。滚动条用例做了反证；选区用例用 `captureSpans` 验了配色交替。
全量见下节。

**踩坑备忘**（TUI 测试通用）：
- `captureCharFrame()` 的**行号会因交互位移** —— 拖选的 mouseUp 会冒泡选中整块，块上方插入
  「▌已选中」标记行，正文整体下移一行，采样前必须**重新定位**（我先按旧行号采样，一直读到别的行）。
- `captureSpans()` 的 fg/bg 是 **0~1 浮点**，拿 hex 直接比永远不相等，断言要统一 `toFixed(3)` 口径。
- 断言"chip 出现/消失"要用 `inputLine()`（最后一行）而不是整帧 —— 正文块里也有同名的「⧉ 复制」。

## 2026-09-22（续 191）修会话复盘暴露的两条 P0：后台结果滞留 + 请求静默卡死

用户："修两 p0 的"（承接 `s_1790082671456_82ikm` 复盘报告；报告见
`outputs/session-analysis/session-82ikm-report.html`）。

### P0-1 后台结果「跑完了却送不到」⇒ 先入队、后发事件 + peek 退避重试

**现象**：4 个后台 reader 21:22:15 全部完成，barrier 也触发了（遥测
`coordinator.barrier.completed @21:22:15.348`），通知却到 21:25:16 才进对话 —— 与用户敲「?」
**同一秒**。中间 3 分 03 秒界面停在「（等待并行研究结果中，稍后汇总完整报告。）」。

**根因（三处叠加）**：
1. `core:2016` `drainNotifications` 只在 `_prepareQueryOnce` 调用 ⇒ 没有用户输入就永不投递；
2. `cli` `attachAutoContinue` 注入 `<continue/>` 前会 `peekNotifications`，**空则放弃且不重试**；
3. `subagent` 里 `bus.publish(completed)` 排在 `enqueueNotification()` **之前**，而 publish 是
   异步的 ⇒ 驱动 barrier 的"全部完成"信号可能**先于数据**到达。CLI 原先靠一句
   `await setTimeout(0)` 去赌"一个宏任务内通知一定入队" —— 真机上赌输了。

**修法（改源头，不在消费侧加等待）**：
- `subagent`：把 `enqueueNotification()` 移到 `bus.publish(completed|failed)` **之前**
  （completed 与 failed 两条路径都改）⇒ barrier 从此真正意味着"结果已就绪"。
- `cli`：删掉那条 `setTimeout(0)`，新增 `waitForPendingNotifications()` —— 退避重试
  `[50, 100, 250, 600]` ms（总预算 ≈1s，远小于误判空转的代价）。

**测试**：新增 2 例顺序回归（在 `completed`/`failed` 事件的**订阅者里** peek 队列，断言已入队）。
并做了**反证**：把 completed 路径换回旧顺序后测试确实失败（`Expected: 1 / Received: 0`）。
（第一次的反证脚本搜索范围越界、改到了 failed 路径，差点把空跑的测试当成有效 —— 值得记一笔。）

### P0-2 请求静默卡死要有可见反馈 ⇒ 停滞心跳

**现象**：首轮请求 21:11:55 发出，440 秒内没有 assistant 消息、也没有任何用量
（`usageStats.inputTokens` 与 18 条 assistant 的 `tu_in` 之和**精确相等** ⇒ 该调用确实没返回）；
期间不报错、不提示，用户只能靠重发自救（同一句话发了三遍）。

**修法**：新增 `startStallNotice()` —— 请求发出后若无任何事件，按递增间隔
`[15s, 15s, 30s, 60s…]` 输出一行 `⏳ 模型尚无响应（已 Ns）…`；收到首个事件即停。
接入 REPL（`out`）与 `harness run`（**stderr**，stdout 保持"纯结果"以便脚本消费）两处。
不改任何超时语义，只结束"毫无反馈"这一段。

**顺带纠正报告里的一处猜测**：CLI 走的是 `sendStream`（流式），全仓 `preferComplete`
**零命中** ⇒ 首轮卡死与续 178 加的 `completeTimeoutFactor` **无关**（那条只影响非流式
`complete()`）。流式路径的兜底是 idle 120s / 总时长 ×10；若 provider 有 SSE keepalive，
idle 计时器不会被触发，因此可能长时间既不断也不出内容 —— 这正是心跳要覆盖的场景。

**注意**：`stall.stop()` 必须在 `finally` 里再调一次 —— 请求报错时循环体里的 stop 不会执行，
定时器会一直往界面写提示。

### 验证

新增 9 例（subagent 顺序 2 + cli helper 7）。另做真实冒烟：`harness run "只回复两个字：收到"`
正常出结果，确认两处接入点没破坏既有流程。

**未做**（仍是 P1/P2）：通知队列是**纯内存** Map（core:1346），进程退出即丢已排队的后台结果；
零产出轮豁免步数配额（16.5% 的输入浪费）；`tokenCalibrationScale` 取值待拍板。

## 2026-09-22（续 190）低危项收尾：配置清理 + cacheHitRate 防 NaN + TUI 字素簇计数 + 归因看见尾部动态块

用户：①「清理那 8 行」（`~/.harness/agents/coordinator.md` 的 `subagents:` 声明）；
②「低危：maxSteps 0 被抬成 1 / cacheHitRate 不防 NaN / ACP 归因视野不含 dynParts / TUI 字符数用 UTF-16 length。这里其他优化项都做了吗」

**核查结论**：四项里只有 `maxSteps` 在续 189 做了，其余三项此前只是**记录在案、未做**。本次补齐三项 + 清理配置。

### 0. 配置清理（用户 home 下的文件：先备份再改）

`~/.harness/agents/coordinator.md` 删掉 `subagents:` 与 15 项列表（备份为 `coordinator.md.bak-20260922`）。
这是续 189 删字段后**唯一会让用户看到告警**的地方 —— 清掉后启动不再有那条 warn。
清理后 `mcpServers: []` 紧随 tools 列表，YAML 结构正常。

### 1. `cacheHitRate` 不防 NaN（P3 → 已修）

原实现是 `if (u.inputTokens <= 0) return 0`。**`NaN <= 0` 是 false**，所以这个判断挡不住任何 NaN：
分子（`cacheReadTokens`）为 NaN 时照算不误，而两个消费方都是**直接插值**——
`renderStatsText`（`缓存：命中 N（X%）`）与 CLI 的 run 摘要，用户看到的是「命中 NaN%」。
**修法**：非有限值 / 负值一律归 0（分母、分子各判一次）。
**测试**：分子 NaN、分母 NaN、负值、`Infinity` 各一组 + `renderStatsText` 端到端断言输出不含 `NaN`。

### 2. TUI 选区字符数按字素簇（P3 → 已修）

`sel.getSelectedText().length` 是 **UTF-16 码元数**：1 个非 BMP 字符（emoji、部分罕见汉字）算 2，
选一个 🙂 显示「已选 2 字符」。
**修法**：新增 `countGraphemes()` —— `Intl.Segmenter`（`granularity: 'grapheme'`，本机 JSC 支持）优先，
构造失败/不可用时降级 `Array.from`（码点数，对代理对已正确，且不抛）。
**测试**：ASCII / 中文 / emoji / 混排四组，并显式断言 `'🙂'.length === 2` 而 `countGraphemes('🙂') === 1`
（把"差值"本身钉住，免得将来有人改回 `.length` 还全绿）。

### 3. ACP 归因视野不含 `dynParts`（P3 → 已修，**未真机验收**）

**事实链**（追调用顺序得出，不是照注释推断）：core 的尾部动态区在 `_prepareQueryOnce` 里**收集**、
在 `_buildStepMessages` 的 `core.session.preModel` **返回之后**才**拼接**成请求末尾那条 `user` 消息
⇒ ACP 在 preModel 里按 `messages` 建归因视图时**完全看不见它**。
**为什么值得修**：anthropic 显式 promptCache 的断点打在"当前对话末尾"那条 —— 正是 core 追加的
`dynParts` 所在位置。它每轮现拼 ⇒ 最后一段必然 cache write，而 `cacheMissReason` 只能报 `none`
（前缀确实没动）⇒ 遥测出现"读数有写入、归因说无事"，排查时无从归因。
**修法**：core 经 `SessionPreModelInput.dynamicParts` 把本轮片段告知 preModel（`dynParts` 在 preModel
之前已经算好，只是拼接在后）；ACP 只记**规模**（`lastTailDyn: {parts, chars}`，每轮显式覆盖含置空 ——
上一轮的规模留在这里会被读成"本轮还有块"），providerCache 行输出 `tailDynamicParts` / `tailDynamicChars`。
**边界**：自动前缀缓存（OpenAI / DeepSeek）不受影响 —— 末尾一条本就在公共前缀之外。
本机没有 anthropic key，**该字段在真实 anthropic 缓存行为下的正确性未验收**（本次只验了链路与装配）。

### 过程事故：并行编辑同一文件，静默丢 3 处改动（**值得记**）

改 core / plugin / acp-context 时，我对**同一个文件**并行发起了两个 `Edit`。两次编辑各自"读取 → 写回"，
且两次读取都发生在任何写入之前 ⇒ 后完成的那次基于**旧内容**，把前一次整段覆盖 —— 而两次都返回成功。
丢了 3 处：`AcpSessionCtx.lastTailDyn` 定义、`ProviderCacheEvent` 的两个字段、ACP hook 里的传参。
**暴露方式**：前两处靠收尾 `grep` 关键标识符发现（编译期报"字段不存在"）；第三处表现为
"端到端断言拿到 `null`"，我一度按逻辑 bug 去查（怀疑模块解析走了 dist、怀疑 ctx 不同源），
实际原因只是**代码没落盘**。
**纪律**：同一文件按「改一处 → grep 复核落点 → 再改下一处」推进；跨文件才并行。已写进 AGENTS.md 第 5 节。

**验证**：`bun run typecheck` 全绿；`bun run test` **39 包退出码全 0**
（core 127 / cli 367 / acp-context 76 / usage 30）。新增回归用例 4 条（`cacheHitRate` 非法输入、
`countGraphemes`、遥测尾部字段透传、tail 档端到端 + system 档记 `null` 的对照），均断言具体取值。
**仍未做**：codeIntel 插件废弃评估（用户既定：oneOf 入参自愈先不动，等废弃决策一起处理）。



## 2026-09-22（续 189）评审遗留三项处置：subagents 死字段删除（附影响面）+ maxSteps 非法取值不再静默钳制

用户对续 188 的「未修清单」逐条拍板：**① 入参自愈对 oneOf 工具失效 → 先不动**（后续考虑废弃 codeIntel 插件）；
**② `AgentDefinition.subagents` → 删除，并评估影响面**；**③ `maxSteps: 0` 被抬成 1 → 优化**。

### ① 先不动（记录理由）

`code_semantic_edit` 顶层无 `required`（三模式写在 `oneOf` 分支里）⇒ 模型给 `input:{}` 时不触发入参自愈，
而多模式工具恰恰最需要。既然 codeIntel 插件在废弃评估中，此时改自愈的分支选择逻辑投入产出比不划算。

### ② 删除 `AgentDefinition.subagents`：影响面实测

**删除前取证**（全仓 grep + 类型层）：该字段只有「写入方」没有「消费方」——`packages/agent/src/index.ts`
有定义与解析赋值，而全仓 `.subagents` 的读取点为**零**（唯一命中是插件自己的 `SubagentPluginOptions.subagents`，
那是另一个东西：插件自注册列表，被 `ownSubagents()` / `/subagents` 消费，**保留不动**）。

**删除后的可见变化**（逐项核实）：

| 项 | 变化 |
| --- | --- |
| 运行时行为 | **零变化** —— 字段从未被消费，删定义/解析/赋值不触及任何执行路径 |
| agent md 校验 | md 里写 `subagents:` 会在解析期回调 `onWarn`（core 已接到 `logger.warn`，无 logger 时 `console.warn`）⇒ **启动时多一条告警** |
| 类型层 | `AgentDefinition` 少一个可选字段；全仓 `bun run typecheck` 全绿 ⇒ 无调用方受影响 |
| `/subagents` 与 subagent 工具 | 不受影响（两者以 AgentRuntime 注册表为准，不读该字段） |
| 文档 | `docs/agent-harness-architecture.md` 字段表已改为「已删除」说明 |

**实际配置会中招**：`~/.harness/agents/coordinator.md` 列了 15 项 `subagents:`（coder/reviewer/reader/…）。
它此前**一直没生效**，删除后仍不生效，只是启动多一条告警。该文件在用户 home 下，**未动**（待用户决定是否清掉）。

**为什么删字段还要留告警**：删一个"曾经看起来生效"的配置等价于一次行为变更，静默删除会让作者继续按它推理
（"我限制了可派工范围"）。通用判据已写进 AGENTS.md：**删死配置必须让它可见**。

### ③ maxSteps：非法取值不再静默钳制

原实现一行两个坑（`packages/core/src/index.ts`）：

```ts
const maxSteps = configured === -1 ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(configured))
```

1. **`0` 被静默抬成 1**：子 Agent 跑一步就收尾 ⇒ 现象像「任务太小 / 模型不肯干活」，真实原因是入参写错；
   且 `0 ?? x` **不会**跳过 `0`，模型的 `subagent({ maxSteps: 0 })` 能一路透传到引擎。
2. **`NaN` 直接把上限取消**：`Math.max(1, NaN) = NaN` ⇒ `step >= NaN` **恒为 false** ⇒ 步数上限失效，
   只剩 doom-loop 守卫兜底。现象是"跑得很久"，实际是"没有上限了" —— 比第一条危险得多。

**修法：单点归一化 + 三层边界拦截**

| 层 | 位置 | 行为 |
| --- | --- | --- |
| 引擎（唯一判定点） | core 新增 `normalizeMaxSteps()` | `-1`/`+Infinity` = 不限；`>= 1` 取下整；**其余 → `undefined`（视为未指定）**，按优先级回落 + `logger.warn` |
| md 解析 | `agentFromMarkdown` | `0` / `< -1` 判非法 ⇒ 视为未声明 + 告警（`-1`、`1` 边界不得误判） |
| 派工入参 | subagent `resolveSteps` | 非法覆盖值（含 `NaN`）不参与优先级 ⇒ 回落子 Agent 定义/插件默认 + `ctx.log.warn`；`-1` 合法透传 |

优先级链不变：**input.maxSteps > AgentDefinition.maxSteps > DEFAULT_MAX_STEPS(30)**（subagent 侧插件默认 20）。

**验证**：新增 `packages/core/src/max-steps.test.ts`（L1 纯函数 4 组 + L2 端到端 6 条）——`0` 回落 agent 定义
（26 次调用，不是 1 次）、`NaN` 回落 agent 定义（修复前会取消上限）、入参与定义都非法 ⇒ 回落 30、
`maxSteps: 1` = 显式单轮（1 次调用）、合法值零告警；`packages/agent` 新增 subagents 告警 2 条 + maxSteps 边界 1 条；
subagent 新增 3 条（非法值回落 / `-1` 透传 / 告警经 `ctx.log.warn`）。

**仍未做**：codeIntel 插件废弃评估（待用户决策）。

## 2026-09-22（续 188）提交后评审 843773f..HEAD（44 提交）：1 数据错误 + 1 归因误报 + 3 处清理

用户："评审下上次评审至今的提交"。上次评审的修复提交是 `843773f`（09-20「telemetry 提交后评审」），
本次区间 **44 提交 / 58 文件 / +7430−917**（其中非文档改动 55 文件）。

**方法**：4 路并行子代理按主题切分（① 用量纳管 ② core 提示词装配/入参自愈/token 口径
③ acp-context 遥测 + provider ④ TUI/CLI 交互 + 子 agent/多插件），**本人对每条「严重」结论实测复现后才动手**。
（沿用 09-16 起的纪律；本轮再次证明必要：子代理给的 2 条 P1 里，1 条要换触发场景才成立、1 条不成立。）

### 修了什么（3 笔提交，未 push）

| 级别 | 问题 | 位置 | 实测 |
| --- | --- | --- | --- |
| **P1 数据** | 用量折叠把当前消息折两遍 | `core/index.ts` `accumulateUsage` | 修复前 `llmCalls=2/input=300`，正确 `1/150` |
| **P2 归因** | 历史每增长一轮就误报 `prefix-mutated` | `acp-context/index.ts` 归因视野 | `stable=4`、`mutated`（应为 `appended`） |
| P3 | `writeResultFile` 随机段变长 → 同毫秒撞名风险 | `subagent/index.ts` | `Math.random().toString(36)` 值 <0.1 时只剩 1~2 字符 |
| P3 | 注释「缺省 10」实为 20 | `subagent/index.ts` | `DEFAULT_SUBAGENT_MAX_STEPS = 20` |
| P3 | `providerTypeFactory` 吞掉 `promptCache`（配了没用） | `provider-anthropic/index.ts` | 已补透传 + 测试 |
| P3 | `shouldPersistUsage` 零调用方（TUI 只余 import） | `usage/index.ts` + `tui.tsx` | 删除函数 + 5 条测试 + 残留 import |

**P1 根因**：增量分支用 `hydrateUsage({meta, messages})` 取起点，而它在 meta 累积器为空时会
**回退到按消息重建** —— 此刻 `message` 已在 `sess.messages` 里，重建已含它，随后再 `foldMessage` 就是第二遍。
触发条件是「某轮 assistant 既无 tokenUsage 也无工具」（provider 未回报用量 / 流式中断）⇒
折叠后累积器恰好**完全为空**（`llmCalls=0 / hourly=[] / tools=[]`）但检查点有效 ⇒ 下一轮双计。
**关键区分：`累积器存在但为空` 是合法状态（该步确实没用量），`字段缺失` 才该重建。**
修法：增量分支只认 `usageFromMeta`，`if (fromMeta)` 而非"非空才算有"。

**P2 根因**：ACP 每轮在请求末尾现拼尾部动态块（nudge / 压缩手册），它不属于缓存前缀。
历史增长一条时，上一轮的尾部块在逐条比对里与「新历史的第一条」相撞（上轮它占 n−1，本轮历史占了 n−1）
⇒ 判成"中段被就地改写"。修法：比对前剔除本轮自己追加的尾部块（两轮各自剔除 ⇒ 视野对齐纯历史前缀）。

### 评审过程中的一次方法论纠错（值得记）

P1 一开始被判「不成立」：我先按子代理给的场景造探针（**首步无 usage 但有工具调用**），
实测 `llmCalls=1` 正确、没翻倍 —— 若就此收尾就是漏报。
换成「首步纯文本且无 usage」立刻复现（`2/300`）：**差别在"折叠后累积器是否真的完全为空"**，
有工具则 `tools` 非空、`isBlankUsage` 为 false，走不到重建分支。
**教训：复现不了 ≠ 不存在 —— 要先把触发条件摸清（是"某个前置状态"而不是"某个动作"），
再判定真假。** 反向也成立：子代理的另外几条「确认」级结论我逐条核对后，有 3 条其实是设计取舍而非缺陷。

### 未修（需你拍板 / 低危，已核实）

1. **入参自愈对 oneOf 工具失效**（`code_semantic_edit` 顶层无 `required`，三模式写在 oneOf 分支里）：
   模型给 `input:{}` 时不触发自愈 —— 而多模式工具恰恰最需要。修法有两种（按 `mode` 判别字段选分支 /
   合并各分支 required 但可能误导"全必填"），涉及回喂文案语义，**先不动待你选**。
2. **`AgentDefinition.subagents` 是死配置**（AGENTS.md 已点名，仍未消费）：要么按它过滤可派子 Agent，
   要么删字段 —— 产品语义决策，先不动。
3. `maxSteps: 0` 被 `Math.max(1, …)` 静默抬成 1（`-1` = 不限已有明确定义，`0` 无）；低危。
4. `cacheHitRate` 对 `NaN` 输入不降级（真实来源未观察到）；已核实为非当前路径。
5. ACP 的归因视野不含 core 在 `preModel` **之后**追加的 `dynParts`（尾部动态区，通常不在缓存前缀内）；
   仅在 anthropic `promptCache` 开启（断点打最后一条）时可能漏判 —— 该功能本机无 key 未验收。
6. TUI「已选 N 字符」用 UTF-16 `.length`，emoji 会多算 1；显示细节。
7. `acpCacheHit`（只比 message id）与内容指纹口径并存，仍可能误导读者。

**验证**：`bun run typecheck` 全绿；`bun run test` 39 个包退出码全 0（core 117、acp-context 74、
usage 29、subagent 135、anthropic 26、cli 366）。新增回归用例 3 条（用量双计 / 归因 appended / promptCache 透传）。

## 2026-09-22（续 187）TUI 鼠标选区高亮：拖选后输入行显示「已选 N 字符 · ✕」

用户续反馈"还有鼠标选区的高亮"（拖选文本）。OpenTUI 选区着色由 Zig 内核负责（默认反转），
`createCliRenderer` 无选区样式配置项；且测试渲染器里拖选确实派发 `selection` 事件，
故在应用层给"选没选中"一个明确指示：

- 订阅渲染器 `selection` 事件（`renderer.on('selection')`，CliRenderer 是 EventEmitter）：
  拖选后输入行显示 **`⧉ 已选 N 字符 · ✕`**（bold+underline），点 ✕ 清除选区（clearSelection）。
- 布局：放在输入行左侧，与「■ 终止」同排；选区存在的指示与忙碌按钮互不干扰。

**踩坑（isActive 过滤回弹）**：点击 ✕ 清除后，Zig 会再发一次 selection 事件且
`getSelection()` 仍返回旧 Selection ⇒ 只按 `getSelectedText().length` 判的话，
`selChars` 会从 0 回弹成"N 字符"（实测：清除后指示重现，测试抓包发现）。修复：
`setSelChars(sel?.isActive ? len : 0)` —— 清除后 Selection.isActive=false，事件被过滤。
**教训：事件回读 state 时，先看对象有没有"活跃/生效"标志，别只信长度类字段。**

测试：tui +1（拖选 →「已选 3 字符 · ✕」→ 点 ✕ →「⧉ 已选」消失）共 114 例；cli 366 全过；
全量 typecheck 绿。注意测试断言用「⧉ 已选」精确匹配（「▌已选中」块标记也含"已选"二字）。

## 2026-09-22（续 186）TUI 鼠标选块高亮：点击消息块整块高亮选中

用户反馈"鼠标选块分不清有没有选中"。原交互只有「⧉ 复制」按钮文字变化（dim→reverse），
块本身无选中反馈。

- 新增 `selectedBlockId` state：点击 用户/助手/工具/推理 块任意处 → 整块选中（box 加边框 +
  顶部「▌已选中 · 再次点击取消」reverse 标记行），再点取消；
- 复制/折叠/展开等内部按钮点击冒泡连带选中该块（行为一致、可接受）；
- 「⧉ 复制」按钮常态从 dim 提为 bold+underline（更易发现），点击后 reverse 不变；
- 拖选文本（startSelection）发生在 dispatchMouseEvent 之前，不受 onMouseUp 影响（既有注释保证）。

测试：tui +1（点击块 → ▌已选中 → 再点取消）共 113 例；cli 365 全过；全量 typecheck 绿。

## 2026-09-22（续 185）TUI：统计面板加上下文占用 + 运行中「■ 终止」按钮

**① 统计 tab 加上下文占用**：新子组件 `ContextOccupancyLine`（tui.tsx）复用 /stats 的
`renderContextOccupancy`（本会话 + 各子会话占用率，窗口/阈值取 buildCompactionOptions 同一套推导），
每 3s 刷新（执行中占用会变）。config 只加载一次（`configStore.load` → buildCompactionOptions 缓存）。

**② 输入框「■ 终止」按钮**：运行中（busyNow）在输入行左侧显示 `■ 终止`（reverse 高亮），
点击走 `abortCurrent()`——与 Ctrl-C 中断共用 `abortCtlRef.current.current.abort()`，已完成的步骤保留。
空闲时不渲染（不占版面）。textarea 包进 flexDirection row，终止按钮 flexShrink、输入框 flexGrow。

**踩坑**：`createTextAttributes` 的 TextAttributes 类型**没有 `fg` 字段**（SyntaxStyle 里才有），
首版 `fg: RGBA(255,80,80)` 编译报错 ⇒ 改用 `reverse: true` 高亮（对属性集零依赖，稳妥）。

测试：tui +2（stats tab 含"上下文占用/自动压缩阈值"、空闲无"■ 终止"）共 112 例；cli 全量 364 全过；
全量 typecheck 绿。

## 2026-09-22（续 184）/stats 增上下文占用区：本会话 + 子会话占用率

统计信息页（`/stats`）新增「上下文占用」区块：

- **本会话行**：`上下文占用：45,000 / 200,000 tokens（22.5%）· 自动压缩阈值 136,000（80% ×（窗口−保留 30,000））`；
- **子会话逐行**：每个子会话单独一行占用率（`子会话 c1：占用 20,000 / 200,000 tokens（10.0%）`），无值不占版面；
- 数据源全部复用既有口径，不新造尺子：
  - 窗口/保留/阈值/口径 = `buildCompactionOptions`（与 `/compact`、配置概览同一套推导，避免"同一 config 两个窗口"的老坑）；
  - 占用 token = `harness.session.estimateTokens`（会话压缩同口径，CJK 感知）；
  - 子会话清单 = `usage.children()`（与聚合行同源）。
- 新函数 `renderContextOccupancy`（cli 展示层，纯展示不写盘）。

测试：cli +3 例（usage-rollup.test：主行/子会话行/估算失败不占版面）共 362 全过；全量 typecheck 绿。

## 2026-09-22（续 183）§7.8 四项待做全部落地（paths 接线 / 命中率 / headless 用量 / 结果复用）

`docs/usage-accounting-and-prompt-cache-plan.md` §7.8 的 #3/#5/#6/#7 一并实现，状态表已更新为"已做"。

**#3 技能 paths 条件触发接线**（此前 `matchByPath` 是死代码）：
- `PromptInput` 新增 `involvedPaths?: string[]`（plugin 包）；
- core `_prepareQueryOnce` 从用户消息提取疑似路径（新 `extractFilePaths`：中文标点先换空格防粘连、排除版本号），塞进 promptIn；
- `core.skill-injection` 增注册 `core.prompt.dynamic.transform`：遍历 involvedPaths 调 `matchByPath`，命中技能注入**尾部动态通道**（user role、每轮重算、不落库）——system 前缀仍只放白名单常量技能，条件触发内容随轮变化也不伤前缀缓存（§8.1）。
- 踩坑：`extractFilePaths` 首版被"中文逗号后跟中文词"粘连（`a.ts，还有` 成整串）、版本号 `v1.2` 误报；修法=中文标点替换为空格再切分 + 版本号正则排除。

**#5 /stats 缓存命中率**：`@harness/usage` 新增 `cacheHitRate()`，`renderStatsText` 缓存行改为 `命中 X（Y%）`。

**#6 headless 用量入口**：`harness run` 结束在 **stderr** 打印 `[用量] LLM 调用 N 次 · in/out · 缓存命中（%）` + 含子 agent 聚合行；stdout 保持纯结果（脚本可安全消费）。

**#7 重复侦察结果复用**（§8.2 终稿落地）：
- core `maybeTruncateRepeatResult`：只读白名单（`read_file/list_dir/grep_file/glob`）+ 大结果（≥2000 字符）+ TTL（60s 或 10 轮，OR）+ 同工具同参（`stableStringify`）同 hash（`shortHash` sha256×16）⇒ 本轮 `tool_result` 只写提示 `[结果与第 N 轮一致（缓存，TTL 内有效，全文见该轮）]`；
- 工具**照常执行**（hash 是执行得来的真凭实据）；历史一字不动 ⇒ 前缀缓存不打断；
- `resultPayload` 支持对象结果（read_file 输出取 `content` 字段截写，保留 path/行数）。
- 序列化基元 `stableStringify`/`shortHash`/`resultPayload` 导出为纯函数并单测。

测试：core 53（+5：extractFilePaths×3、序列化基元×4、结果截写集成×1）、usage 34（+3 命中率）、cli 359 全过；全量 typecheck 绿。
待办剩余：Anthropic 缓存真机验收（等 key）、工具 schema 文案精简（刻意不做）。

## 2026-09-22（续 182）结果复用方案再修正：工具照常执行，仅新消息不重放全文

用户第二轮澄清："**工具要执行**，只是不要折叠历史消息"。§8.2 从"跳过执行 + 占位提示"
改为：

- 工具**照常执行**（执行 = 新鲜度验证 + hash 来源，副作用/工具语义全保留）；
- 执行后与 TTL 窗口（近 10 轮或 60s）同工具同参数结果比对，一致且结果大 ⇒
  本轮 `tool_result` 只写提示 `[结果与第 N 轮一致（全文见第 N 轮）]`，**历史旧消息一字不动**；
- 结果小 / 未命中 ⇒ 照常写全文；
- hash 一致 = 执行证明"此刻内容与上次相同"，模型直接用历史全文 —— 判定是执行得来的，不是猜；
- 与 §8.3 折叠的本质区别：折叠改写**历史中段**（必亏），本方案只控制**新消息**（末尾增量），
  历史恒定、前缀不断点。

对比"跳过执行"版：协议约束（tool_call 必须有 result）自然消失 —— 工具真执行了，结果真实，
只是消息里写提示而非全文。

## 2026-09-22（续 181）结果复用方案修正：跳过执行 + TTL 窗口，放弃历史折叠

用户否定了 §8.2 的"A 层折叠呈现"：**不要折叠历史工具内容**（折叠要改历史中段字节，
打断前缀缓存，§8.3 的 `R×0.1 − L×0.9` 必亏），改为：

- **命中即跳过执行**：同工具+同参数，近 **10 轮对话 或 60s**（TTL 双窗口 OR，可配）内执行过
  ⇒ 不真实执行，合成占位 `tool_result` `[结果与第 N 轮一致（缓存，TTL 内有效）]`；
- **结果 token 不多 ⇒ 直接执行拼最新**（执行便宜、结果新鲜，不值得省）；
- 历史一字不动，占位是**末尾新消息** ⇒ 前缀缓存不伤（与 §3.4 同一几何）；
- 过期护栏：TTL 窗口 + 占位带轮次标注（模型可判断是否强制重跑）+ 结果小必重跑；
- 硬约束：只读白名单（write_file/bash 永不跳过）；**协议要求跳过执行仍产出对应 tool_result**
  （assistant 发起 tool_call 必须配 result，否则 provider 报错）；
- 与 doom-loop 互补：命中直接返回占位 ⇒ 模型少连续重复调用，从源头缓解空转。

文档 §8.2 已按用户定稿重写，§8.3 标题改为"为什么不能折叠历史工具内容"（作为该方案的依据）。

## 2026-09-22（续 180）用量/缓存方案文档补 §8：paths 条件触发与结果折叠

`docs/usage-accounting-and-prompt-cache-plan.md` 新增 §8，为 §7.8 剩余事项 #3 / #7 补方案设计：

- **§8.1 技能 paths 条件触发**：`matchByPath` 接线位置必须走尾部动态通道（`core.prompt.dynamic.transform`
  / dynParts / user role 尾部），不能进 `sysParts` 前缀 —— 条件触发使注入内容随轮变化，
  进前缀即每翻转一次 ≈ §3.3 同款 95K token-equiv 代价（白名单注入当前安全只因 `agent.skills` 是常量）。
  恒定白名单留前缀、条件触发走尾部，两条通道各司其职；前置依赖"本轮涉及路径"的收集。
- **§8.2 重复侦察结果复用（A 层）**：工具**照常执行**（执行是"此刻内容"唯一证明，hash 相同 ≠ 现在相同，
  跳过执行的 B 层危险被否），结果 hash 与最近 N 轮同工具同参数比对，一致且超阈值才折叠为
  `[结果与第 N 轮一致（hash）]` 并带轮次标注。只读白名单才可折叠，有副作用工具永不折叠。
- **§8.3 折叠打断前缀缓存的几何**：净收益 ≈ `R×0.1 − L×0.9`（R=重复结果 token，L=断点后历史）。
  折叠改历史中段字节 ⇒ 断点后整段历史从命中价变全价；只有结果位于请求末尾（L≈0）才净赚，
  历史中段的重复结果折叠必亏 —— 与 §3.4"变量放尾部"同一根因。

用户疑问"折叠为啥影响缓存"已在 §8.3 给出公式化答案：缓存命中要求跨请求前缀逐字节不变，
折叠恰恰改了前缀中段的字节。

提交：文档补充，无代码改动。

## 2026-09-22（续 179）"插件往系统区插标记"从定位到解决 + 探针固化

用户："可以（固化 L3 探针），插件插标记的问题能解决不"。

### 结论先说

**能解决，而且解法在本项目里已经存在** —— `acp-context` 早就把原理量化过（`MANUAL_INJECT_MARGIN`
注释）："**完整手册必须注入在尾部**，不能放前缀……放前缀翻转一次 ≈ 95K token-equiv，回本要 366 次
调用"。缺的不是认知，而是**通用机制 + 约束各插件遵守**。本轮把两件都补上。

### 一、机制：`core.prompt.dynamic.transform`（尾部动态区）

- 新增 hook，签名与 `core.prompt.system.transform` 相同（`(PromptInput, string[]) => void`）。
- core 把结果拼成**一条 `user` 临时消息，追加在请求最末尾**，并代管两条硬约束：
  1. **必须 `user` role**：`provider-anthropic.extractSystemPrompt` / `provider-gemini.extractSystem`
     会把**任意位置**的 system 消息上提进顶层 `system`/`systemInstruction`（原位置跳过）——
     用 system 挪到尾部等于没挪。
  2. **必须在 `core.session.preModel` 之后拼接**：那是压缩插件的折叠/回写点；放它之前有被写进
     持久层的风险，而尾部块每轮重算，落库即脏数据。放后面 = "发送时拼接"，天然不落库。
- 渲染成 `<host-context note="宿主注入，非用户发言；内容可能每轮变化">…</host-context>`：
  不给标记的话模型会把它当用户发言，影响回复对象与口吻。

### 二、迁移：谁本来就该待在尾部

| 消费方 | 内容 | 判定 | 处理 |
|---|---|---|---|
| `mcp-client` | MCP resources | 缓存**只增不减**（每 read 一份就多一条）⇒ 每份新资源都让整段历史重算 | **迁移** |
| `memory` | 一次性沉淀提示 | "出现一轮、下一轮消失"⇒ 留 system 付**两次**失效，而"消失"那次无压缩可搭车 | **迁移** |
| `memory` | 记忆正文 | 设计上搭压缩的车（`PublishOptions.flushAfterTurns` 注释：压缩时 system 本就因 `appendCompactionMemory` 而变），只在 15 轮兜底时才是纯失效 | 留在前缀 |
| core | 压缩记忆块 | 只随压缩变，同上一行 | 留在前缀 |
| `subagent` roster / `core.skill-injection` / `coordinator` | 名单/技能/规则 | 恒定文本 | 留在前缀（由归因兜底） |

### 三、归因：system 变了要能**点名到段**

`core.prompt.system.transform` 是**多个插件往同一个数组 push** 拼出来的 ⇒ 只说"system-changed"
等于没说。新增段级归因：

- core：每 query 算 sysParts 的**段级指纹快照**（指纹 / 长度 / 首行预览），与上一轮比对，产出
  `SystemStabilityReport`（`changedParts` / `addedParts` / `removedParts` / `details`）。
  变化时 `logger.warn` 一条人读日志，并把报告经 `core.session.preModel` 的
  `input.systemStability` 交给插件。首轮无基线不报（否则每个新会话都误报一次）。
- ACP 遥测：`providerCache` 行新增 `systemChangedParts` / `systemChangedDetail`。
- 判据是**内容指纹**，不是长度、也不是 message id：R2→R3 那种"只差一个数字、字符数相同"的
  变化也必须判出来（provider 按字节命中，这是真失效）。已用单测钉住。

### 四、验证：位置对照实验（决定性证据）

`packages/cli/src/cache-attribution.test.ts` 新增两条 —— **同一份内容、同一变化幅度、唯一变量是位置**：

- 放 `system` 区：`cacheMissReason = system-changed`、`prefixStableMessages = 0`、归因点名
  `systemChangedParts = [1]` 且 detail 里能看到新旧首行。
- 放尾部动态区：内容同样每轮不同（断言请求体最后一条确实带 `PROBE_VOLATILE_R1/R2/R3`），
  而**前缀区三份请求逐字相同** ⇒ `reason` 恒为 `none`、`systemChangedParts` 恒为 `null`。
  并额外断言**不落库**（`session.messages` 里既无 `PROBE_VOLATILE` 也无 `host-context`）。

### 五、固化 L3 真机探针：`bun run probe:cache`

原先是"一次性脚本，用完就删"的方法论。现已固化为 `packages/cli/src/probe-cache-telemetry.ts`
（放在 cli 包内 ⇒ 进 `tsc --noEmit`，不会腐烂）：

- 临时 dataDir + 复制真实 config（**复制而非软链**：软链会把探针的临时改动写回真实配置）；
- **包 `globalThis.fetch` 抓真实请求体**做**独立证据**（系统区哈希、消息数、工具数、body 字节），
  与内部指标交叉验证；
- 读 ACP 遥测逐轮打印 `preModel` + `providerCache`（含 `systemChangedParts` 点名）；
- `PROBE_ROUNDS` / `PROBE_IDLE_MIN` / `PROBE_PROMPT` / `PROBE_KEEP` 可调。

#### 实跑发现（**需要拍板**，未自行改动配置）

在同一台机器、同一份 config 下跑 3 轮（真实长度正文）：

| 装配 | 原始比值（provider 输入 ÷ 本地未校正估算） |
|---|---|
| 续 178 测量的极简装配 | **1.33**（1.328 / 1.342 / 1.337 / 1.332） |
| 本轮完整 CLI 装配（29 工具、固定开销 ≈16.0K tok） | **≈1.14**（`calibration` 稳定在 0.854~0.859，÷1.33 反推） |

⇒ **1.33 在完整装配下过校正 ≈16%**，occupancy 会偏高、压缩偏早。残差主因推测是
`estimateToolPayloadTokens` 的近似形状（只取 `name`/`description`/`parameters`，未含
`strict`/`additionalProperties` 等），工具载荷估低会把整体比值往上推 —— 也就是说这个 scale
实际在替"工具载荷估算误差"背锅，因此**与装配强相关，不是普适常数**。

**未改动 `~/.harness/config.json`**（现值 1.33 保留）：取值属行为决策，且"全局单一常数"本身是
一阶近似。三个候选：① 改成 1.14；② 保留 1.33（偏保守、压缩更早）；③ 不再用常数，改为在线
用观测到的 `calibration` 缓慢自校正（去掉假设，但要防反馈回路）。需要拍板。

### 六、验证

新增测试 17 例（core 归因/渲染 8、acp-context 遥测 1、cli 位置对照 2、memory 位置与隔离 2、
mcp-client 位置 2、更新既有用例）。全量 **1751 pass / 0 fail**、39 包全退出码 0、typecheck 全绿。

**未做/待观察**：`cacheMissReason` 仍需等真实断崖点名（能力已就位）；memory 正文是否也值得
下沉到尾部（取决于"搭压缩车"的假设在真实长会话里的命中率，值得用探针在长会话上量一次）。

## 2026-09-22（续 178）前缀缓存回退可观测 + token 口径校正（实测 1.33）+ 非流式超时分级

用户："做2和3"（承接续 177 末尾列出的未做项：② turn 边界前缀缓存回退定位、③ 本地 token 口径校正 + provider 超时分级）。

### 一、前缀缓存回退：从"只有一个数字"到"一行说清原因"

**新增遥测（`packages/plugins/acp-context`）**

- `diffPromptPrefix(prev, curr)`：对**上一轮真正发出去的 prompt**（`preModel` hook 末尾原地替换之后）
  逐条做**内容指纹**比对。指纹 = `role + 正文`，**刻意不含 `id`**。
- `providerCache` 行新增：`cacheMissReason`（`first-request` / `none` / `system-changed` /
  `prefix-mutated` / `prefix-shrunk` / `idle-expiry`）、`prefixStableMessages`、`prefixChangedKind`、
  `cacheDropTokens`、`idleMs`。
- 分类还区分了 `appended`（尾部追加，前缀未动）与 `tail-rewritten`（只有最后一条被改写——
  nudge/手册的常规形态，廉价），避免把"正常追加"误报成"前缀失效"。

**为什么必须换判据**：既有的 `commonPrefixHit` **只比较 message id**，同 id 消息正文被就地改写时
它照样报高命中率 —— 是**误导性的绿灯**；而"就地改写"恰是本项目最可能的失效源（ACP 折叠/占位符替换）。

**真机取证（临时 dataDir + 复用真实 config，同会话连发 3 轮，中间 6 分钟空闲）**

| round | cacheRead | idleMs | prefixStable | kind | reason | calibration |
|---|---|---|---|---|---|---|
| 1 | 6912 | — | — | — | first-request | 1.328 |
| 2 | 7040 | 945 | 3 | appended | none | 1.342 |
| 3 | 7296 | 1074 | 5 | appended | none | 1.337 |
| 4 | 7424 | **361 076** | 7 | appended | **none** | 1.332 |

**独立证据**（包 `globalThis.fetch` 抓真正发出去的请求体）：5 次请求的**系统区哈希全程恒定**
`c9cbef190aa1`、`msgs` 单调递增 ⇒ 前缀确实是纯追加。

**结论（推翻两个原假设）**：**turn 边界重组**与**6 分钟空闲**都**不会**打破前缀缓存。
历史会话 `s_1789996799007_9cq9r` 那两处断崖（−12.9K / −46.7K）另有原因（当前最强嫌疑：插件注入的
系统区中途变化，如 memory 注入 / subagent roster），且**下一次发生时会由 `cacheMissReason` 直接点名**。
⇒ 交付的是"定位能力"，不是"已定位"。这一点如实记录，不冒充结论。

### 二、token 口径校正：从"凭感觉说差 33%"到"实测 1.33 且可复现收敛"

- **先修了一个测量错误**：最初把 `calibration` 的分母取成 ACP 的 `requestTok`，首轮量出 **415×** ——
  因为 `requestTok` **只算历史 cores，不含 system 与工具载荷**，而 provider 计费是整包。
  量的其实是"漏算固定开销"。改为由引擎提供整包估算（`core.llm.usage.localInputEstimate` =
  `estimateMessagesTokens(finalMessages) + estimateToolPayloadTokens(allowedTools)`，后者是新增的
  近似 payload 估算），并新增 `overheadTok = 整包 − 历史` 把固定开销显式化。
- **实测**：稳定 **1.33**（1.328 / 1.342 / 1.337 / 1.332）⇒ 本地系统性低估约 25%。
- **落地**：`resolveCountTokens(calibration, scale)` + `compression.tokenCalibrationScale`
  （缺省 1 = 不改变行为），CLI 把**同一个值**同时传给 acp-context 与 `createHarness`
  （只在一侧校正等于制造新的口径分裂——本项目已栽过一次）。已按实测把 `~/.harness/config.json`
  设为 **1.33**（备份 `config.json.bak-20260922-080355`）。
- **验收**：同一真机探针，`calibration` 收敛到 **1.000 ± 0.011**（0.999 / 1.008 / 1.005 / 0.995）。

### 三、非流式超时分级

`timeoutMs` 在两条路径上语义不同：流式是 **idle**（另有 `×10` 总时长兜底），而非流式 `complete()`
只有**一个总时长**计时器、此前直接用它 ⇒ 同一件事在非流式路径严 10 倍。子 Agent 走 `preferComplete`
非流式路径时因此更容易被误判超时（续 177 查到的 reviewer 60s 超时即此）。

- `completeTimeoutMs = timeoutMs × completeTimeoutFactor`（缺省 = `STREAM_TOTAL_TIMEOUT_FACTOR`=10，
  配 1 退回旧行为）；错误消息写明两个乘数便于诊断；**openai / anthropic / gemini 三个 provider 统一**。
- 单测实测触发时刻 201.8ms / 301.4ms / 41.5ms（= 40×5 / 30×10 / 40×1），与系数吻合。

### 四、顺带修的结构性缺口

`acp-context.uninstall()` 只 `sessions.clear()`，**从不 flush** 遥测 writer —— 而 writer 的 `flush()`
注释明确写着"正常退出 / 信号兜底时调用"，即又一个"只有定义没有调用方"。已补（逐 session flush，
单个失败不影响其余）。**注**：并未观测到真实丢行事故（三次取证的 `providerCache` 行数都与
`usageStats.llmCalls` 精确相等：4/4、5/5、4/4），修的是结构性缺口。

### 五、本轮两次自我纠错（方法论，值得重复）

1. 用"provider 全量输入 ÷ 本地 history-only 估算"算口径偏差 ⇒ 415× 假偏差（见上）。
2. 看到"5 次 HTTP 请求 vs 4 行遥测"就断言"末轮丢行" ⇒ 实际 `llmCalls` 就是 4；
   **HTTP 请求数 ≠ LLM 调用数**（一次调用可能发多次 HTTP，如 reasoning_content 重试）。
⇒ 教训：**任何"指标异常"先找同源计数对齐，再下结论**；取证要包 fetch 抓真实请求体做交叉验证。

### 六、验证

新增测试 11 例（acp-context 遥测 6 + acp-context uninstall 1 + session 校正系数 3 + provider 超时分级 3
+ cli 配置 2，含更新）。全量 **1734 pass / 0 fail**、typecheck 全绿。

**未做/待观察**：`cacheMissReason` 需等下一次真实断崖来点名（已具备能力）；memory 注入与 subagent
roster 是否改动系统区未验证（那是最强嫌疑，值得用同一探针加插件复现）。

### 七、验证矩阵（回答「如何验证 / 能不能用 mock 数据验」）

**能，但必须分清"验逻辑"与"验结论"** —— 分四层：

| 层 | 手段 | 能验证什么 | **验不了什么** | 命令 |
|---|---|---|---|---|
| **L1 纯函数** | 单测 | 分类规则（四形态 × 六 reason）、口径算术、非法值兜底 | 装配是否正确、字段是否真的落到文件 | `cd packages/plugins/acp-context && bun test src/telemetry.test.ts` |
| **L2 端到端 mock** | `packages/cli/src/cache-attribution.test.ts`（**本轮新增**） | **归因闭环**：真实引擎 + 真实 acp-context 插件 + 探针插件（按轮次制造系统区变化 / 中段改写 / 删一批）+ `MockChatProvider.usageSequence`（逐轮 cacheRead 台阶）⇒ 断言 6 轮 reason 序列、kind、降幅、`prefixStableMessages`、`idleMs`、以及 `calibration` 的分母确实是**整包**估算 | **系数取值**（1.33 只能真机测）、provider 的**真实缓存行为**（何时真的过期/逐出） | `cd packages/cli && bun test src/cache-attribution.test.ts` |
| **L3 真机** | 临时 dataDir + 真实 provider + **包 `globalThis.fetch` 抓真实请求体**做独立证据 | 系数取值、真实缓存曲线、turn 边界/空闲是否真会打破前缀 | 成本（token + 时间）；且**单次样本不能当规律** | 探针脚本（方法见 §1，用完已删） |
| **L4 产线观察** | 遥测 `cacheMissReason` | 真实断崖的成因（**下次发生即点名**） | 已发生但没埋点的历史事件 | 读 `{dataDir}/sessions/*.telemetry.jsonl` |

**L2 的额外收获（它不只是"测了一下"）**：探针里"插件在中途往系统区塞标记 ⇒ `system-changed`"
这条路径，正是历史会话那两处断崖的**最强嫌疑**。L2 证明该机制**确实会产生这个标签**
⇒ 一旦真实复现，遥测会直接点名，不必再靠推断。

**mock 的三条边界（别越界使用）**：
1. mock 的 `input`/`cacheRead` 是**编的**，所以 `calibration` 的**数值**无意义 —— L2 只断言
   "分母是整包估算"这个**结构与算术**关系（若退回 `requestTok` 当分母，断言立刻算不平）。
2. mock 不会"真的过期"或"真的按字节命中"，`idle-expiry` 在 L2 里是我把 `cacheRead` 编低触发的
   ⇒ 它验的是**归因逻辑**，不是 provider 行为。
3. 探针的改动必须**每轮重新施加**（core 每轮从会话本体重建 messages，只改一轮下一轮就被还原，
   会看到"前缀又变一次"的假象）。这是写 L2 时实际踩到的坑，已写进测试注释。

**顺带修的一处分类规则**：写 L2 时发现「删中段消息」会被报成 `mutated` 而非 `shrunk`。
改为"**净变短一律归 `shrunk`**"（压缩/截断 pruned 的是旧消息，说"内容被改写"会把真正的原因盖掉）；
同时明确：只删 1 条而历史每轮 +2 的情形，整体仍在变长，本就该是 `mutated` —— 那是改写不是截断。

## 2026-09-21（续 177）子 agent 结果落盘/提示语/步数三修 + 入参自愈（起因：会话遥测复盘）

用户先让我复盘会话 `s_1789996799007_9cq9r`（lead「扫描当前项目代码生成架构图」，18.5 min /
96 次 LLM 调用），再按其结论"实现改进建议并解决 Q1 发现的问题"。

### 一、复盘结论（量化，报告 `outputs/session-analysis/session-report.html`）

- **96 次调用里 100 次工具调用失败 37 次（37%）**，其中 **34 次是 `input: {}`（参数整段为空）**，
  这些轮的 output 中位数只有 **22 token**（发个空壳就结束）。**与推理长度无关，只与上下文长度相关**：
  `<20K 12% → 20-40K 39% → 40-60K 38% → 60-100K 50%`。失败轮吃掉全部上下文的 **43.6%**。
- ACP 压缩**全程 0 次触发**（峰值仅占 300K 窗口的 26.9%）⇒ 本会话的浪费与压缩无关。
- **本地 token 估算比 provider 少约 33%**（本地 Σ 4,737,214 vs provider 6,311,323）；
  `cacheWrite` 96 轮恒为 0 ⇒ 只知命中、不知写入。
- 前缀缓存整体 97.35%，但有 **两处断崖都在 turn 边界**：round 11（用户「继续?」）−12,928、
  round 42（用户「继续」，前有 7 分钟空等）−46,720。

### 二、Q1 查出的问题：子 agent 全文只写在 `os.tmpdir()`

`subagent/index.ts` 的 `summarizeResult()` 把**全文**写 `join(os.tmpdir(), 'subagent-output-<Date.now()>.txt')`，
返回给父 agent 的只是 head+tail 摘要。而落盘的 `{dataDir}/tasks/<taskId>.json` 实测只存**摘要**
（3466 字符，含"已截断为摘要"）⇒ **全文只此一份，且在 macOS 会被定期清理的 `/var/folders/**/T` 里**。
真机上父 agent 只能 `bash cp` 把它搬回工作目录再 `read_file`（约 10 轮纯管道操作）。

顺带**推翻我自己上一轮的一个结论**：我曾说"提示语主动指了 read_file 这条被禁的路"——核实后是错的。
`callerToolIds` **全仓没有任何写入方**（core 从未填 `ctx.variables.callerToolIds`，只有测试手动塞），
所以那段"可使用 read_file 或 grep_file 工具查看"是**死代码**；真实提示走 else 分支，而 else 写的是
**"请考虑拆分任务"**（把"报告超了 2000 字符阈值"误报成"任务太大"，会话里出现 11 次）。
⇒ 教训：**新增字段必须核实"有没有写入方 / 有没有消费者"**（同 `subagents:` 只解析不消费）。

### 三、另一个同类缺陷：`maxSteps` 在 agent md 里写了等于没写

`agentFromMarkdown()` **从不映射 `maxSteps`**，而 subagent 插件的 `resolveSteps` 读的正是
`agent.get(id).maxSteps`，其文档还明确写着"子 Agent 应在自己的 AgentDefinition 里显式写 maxSteps"
⇒ 所有 md 定义的子 agent 只能吃插件默认 **20**。真机 6/6 个 reader 因此全部触顶、报告被截断，
逼出第二轮补派（额外 **41 次调用 / 133 万 input token**）。

### 四、落地（按用户主题分块的 3 组改动）

**① subagent 结果落盘 + 提示语（`packages/plugins/subagent`）**

- 全文改落 `{dataDir}/subagent-results/`（与 `tasks/` 同域、系统不清理、不污染用户仓库 cwd）；
  无 dataDir 才退化到 `os.tmpdir()`（best-effort，不抛错）。`subagent-diff-*.patch` 同处理。
- 文件名 = `时间戳 + 随机段`。**只用 `Date.now()` 会让同毫秒并发的多个子任务撞名互相覆盖**。
- 提示语改为**只说自己为真的事实**，三种情形分开：路径可读（调用方确有读文件工具 **且** 路径在
  调用方 `ctx.cwd` 内）才承诺 `read_file`；路径在 cwd 内但调用方没读文件工具 ⇒ 只报事实 + 给下一步；
  路径在 cwd 外 ⇒ **明确说 read_file/grep_file 读不到**（不再误报"请考虑拆分任务"）。
- `callerToolIds` 由 core 注入（见 ③），死字段被复活；判 cwd 用**调用方的 `ctx.cwd`**（决定
  read_file 边界的是它，不是 harness 全局 cwd）。
- **摘要阈值 2000 → 8000 字符**（`DEFAULT_MAX_RESULT_LENGTH`）。依据：实测 9 份报告正文是
  **4532~10195 字符**，2000 阈值下 **9/9 全被截断**；8000 后 8/9 不再截断，而**上下文增量几乎为零**
  （那些报告本来就只比 2000 高一点），却省掉整段搬运轮次。

**② 步数：解封 + 分档 + 派工方覆盖**

- `agentFromMarkdown` 补 `maxSteps` 解析（数字 / 字符串数字 / `-1` 不限；非法则忽略）。
- `reader` = 35、`reviewer` = 25（`~/.harness/agents/*.md`，已备份 `agents.bak-20260921-225726`）；
  真机脚本验证解析结果：`reader=35 reviewer=25 coder/lead/coordinator=(默认)`，0 告警。
- `subagent({ maxSteps })` 新增可选入参，优先级 **派工方 > 子 Agent 定义 > 插件默认**：
  同一个 reader 既可能"看一眼某个文件"（5 步够）也可能"通读 1902 个文件"（20 步不够），
  派工方比 agent 定义更清楚**这一次**的规模。

**③ core：入参自愈 + 注入 callerToolIds（`packages/core`）**

- 新增 `describeMissingRequiredParams()`：工具调用失败**且必填项没给全**时，把该工具的
  必填参数（名/类型/描述，取自 `inputSchema.__jsonSchema`）+ 最小示例（按 type 生成占位值）
  直接拼进回喂给模型的错误消息（`[入参自愈] …`）。必填已给齐 ⇒ 不掺和（避免噪音）；
  无 schema/无必填 ⇒ 不动文案。**原错误信息与 `code` 一律保留**（下游按 code 判定）。
- `ctx.variables.callerToolIds = allowedTools.map(t => t.id)`：复活上面那个死字段。

### 五、验证

- 新增测试 13 例：core 入参自愈 4、agent `maxSteps` 解析 1、subagent 落盘/提示语/步数覆盖 8；
  并更新 3 个编码了旧提示语行为的旧用例。
- 全量 **1717 pass / 0 fail**、39 个包全退出码 0；`bun run typecheck` 全绿。
- 顺带修掉 3 个**预存**的类型错误（`subagent/index.test.ts` 的 fixture 缺 `description`/`permission`，
  是 AgentDefinition 加必填字段时漏改的；stash 验证过与本轮改动无关）。
- 未改（需拍板）：步数配额对"零产出轮"豁免（有死循环风险，靠 doom-loop 兜底不充分）、
  turn 边界前缀缓存回退定位、本地 token 估算口径校正、provider 超时按任务分级。


## 2026-09-21（续 176）工具载荷按需化 + 新增 7 个轻量子 agent（真机逐 agent 测了实际载荷）

用户定：**#2（Anthropic 验收）/ #6（重复侦察复用）/ #7（schema 精简）先不做**，转做 #1 工具载荷按需化，
并"和子 agent 提示词一起优化、创建几个简单提示词的子 agent、现有 agent 模式改一下、不常用工具不加载"。

### 一、9 个现有 agent 从 `tools:"*"` 改成按角色白名单

真机基线（`tools:"*"`）：**41 个工具 / 23,674 字符 / 16 个 MCP 工具**。改后逐 agent 实测（抓真正发到
网络上的请求体 body.tools）：

| agent | 工具数 | 载荷字符 | 降幅 | 说明 |
|---|---|---|---|---|
| coordinator | 21 | 12,111 | −49% | 能读侦察 + 派工/团队/上下文；**不写不跑命令**；MCP 全不给 |
| 前端架构师 | 12 | 8,333 | −65% | 8 原生 + code-intel×4 |
| coder（新） | 11 | 7,859 | −67% | 7 原生 + code-intel×4 |
| 合规审查员 | 5 | 3,123 | −87% | **真只读**：不给 write/edit/bash（此前 `*` 时它能 rm -rf） |
| reader（新） | 4 | 2,352 | −90% | 只读检索 |
| summarizer（新） | **0** | 0 | −100% | `tools: []` ⇒ 请求体里 `tools` 字段整个不发出（三个 provider 都是 `if (length > 0)` 才挂） |

其余（AI 集成/后端架构/性能优化 11~13 个，DevOps/API 测试 8 个，UI 设计 7 个）同理。
外部估算：主会话 + 子 agent 合计每次省 5~7K，94 次约 500~650K/会话。

### 二、新增 7 个轻量子 agent（提示词 12~18 行，按成本分档）

`summarizer`（0 工具，纯文本压缩）→ `fetcher`(web_fetch) / `patcher`(read+edit) / `runner`(bash+read) →
`reader`（只读 4 件套）→ `reviewer`（只读审查）→ `coder`（可写可跑 + code-intel）。
其中 `coder` / `reviewer` 是**补上 coordinator 名单里挂了但从未存在的两个 id**。

### 三、踩到的三个机制坑（都已写进 AGENTS.md）

1. **`tools:` 精确匹配，且会先于 `mcpServers` 生效**：core 顺序是
   `filterByWhitelist(agent.tools)` → `filterMcpTools(..., agent.mcpServers)`，所以 `mcpServers` 是
   **二次过滤不是补充**。第一版只写 `mcpServers:[code-intel]` ⇒ 实测拿到 **0 个** MCP 工具
   （MCP 工具在第一步就因不在 `tools:` 里被剔除）。修法：把 4 个 `mcp__code-intel__*` id 也写进 `tools:`。
2. **递归派工只靠白名单**：`mode:'subagent'` 不会被自动排除 ⇒ 8 个 subagent 全是 `tools:"*"` 时
   **可以无限往下派工**。新白名单一律不含 `subagent`。
3. `subagents:` 字段**只解析不消费**（又一个"配了没用"）；`description` **不进模型上下文** ⇒
   派工时模型看不到可用子 agent 清单，只能用户点名。这是**未修**的可用性缺口（要修可以给 subagent
   工具动态注入一行 id+触发条件的 roster，代价约 1K 字符，待用户定）。

### 四、"不加载"留给配置层（未动用户 config）

- MCP 类由 config 决定：computer-use（10 工具）不用就从 `plugins` 移除 ⇒ 连 MCP server 都不启；
  OCR server（`uvx` 起进程，较重）不用就 `enabled:false`。
- 顺带发现：config 里 `remote` 那条指向 `mcp.example.com`（占位），**每次启动都会尝试连接并失败**。
- 原生工具插件（builtin/search/glob/web/media）是默认启用，运行时可用 `/tools --global` 停。

### 五、验证与备份

- 改动落在 `~/.harness/agents/`（仓库外，未进 git），已备份到 `~/.harness/agents.bak-20260921-130642`。
- 16 个 agent 全部用仓库解析器 `agentFromMarkdown` 校验过 tools/mcpServers 取值。
- 真机 6 个 agent + 1 个基线逐次实测（探针包 `globalThis.fetch` 抓请求体；第一版探针读
  `harness.context.resolve('chat.provider').calls` 拿到的是包装器，读不到 —— 改用抓网络请求才对）。

## 2026-09-21（续 175）Anthropic 显式 prompt 缓存（未验收，默认关）+ matchGlob 的 `**/` 语义修正 + permission 补测试

用户说「继续实施」⇒ 接着落方案文档 §7.6 的未做项。**先撞上硬阻塞：本机只有 DeepSeek 的 key，
没有 Anthropic key** ⇒ 按 AGENTS.md「与外部服务对接以真机为准」，把 Anthropic 缓存做成
**默认关 + 只做请求体形状单测**，并把验收方法写进选项注释 —— 不谎称验收过的行为。

### 一、Anthropic 显式 prompt 缓存（`AnthropicProviderConfig.promptCache`，默认 false）

- 现状：**该 provider 此前压根没开缓存** —— Anthropic 的 prompt 缓存必须在请求体显式标
  `cache_control`（OpenAI/DeepSeek 是自动前缀缓存，无需配置）⇒ system + tools + 历史一直在按
  input 全价重付。
- 实现：3 个断点（协议上限 4）—— `tools` 最后一个（一次覆盖整块工具定义）、`system`、
  当前对话最后一个 block（下一轮它成为历史，整段即可命中）。`system` 必须从 string 换成
  block 数组才承载得了标记。
- 配置可达性**核实过**：`providers[]` 条目经 `providerTypes.resolve(type).createPlugin(pc)` 整体
  透传 ⇒ `promptCache` 能生效（不是"写了没用"）。旧路径（`ANTHROPIC_API_KEY` + 默认 provider=anthropic）
  只构造 `{ apiKey }`，不透传该键 —— 已知边界，用 `providers[]` 声明即可。
- **顺带把 `complete`/`stream` 里逐字重复的两份 `buildBody` 合并成一个**（加任何请求参数原本要改
  两处，"只改了一处"正是本项目反复出现的静默失效来源）。重构当场被测试抓到一处漏改的
  `model` 引用（`modelOut ?? model` → `body.model`）—— 这两份重复确实危险。

### 二、`matchGlob` 的 `**/` 语义修正（不安全方向的漏判）

补 `@harness/permission` 测试时发现：`**/x` 展开成 `.*\/x`，**要求至少一层目录** ⇒
- `**/*.ts` 漏掉根级 `a.ts`；
- `deny: ['**/secrets*']` **漏判根级 `secrets.txt`** —— 该拒的没拒，属**不安全方向**。

已按标准 glob 语义（minimatch 同此）修正为 `(?:.*/)?`，并**调整替换顺序**：展开出来的正则片段
自身含 `*`/`?`，必须最后处理，否则 `(?:` 里那个 `?` 会被当通配符吃掉、非捕获组语义坏掉。
已知刻意差异：`src/**` 不匹配 `src` 自身（写成 `src(?:/.*)?` 会让两套写法分歧）。

### 三、`@harness/permission` 补测试（清掉"根测试退出码恒为 1"）

该包此前**一个测试文件都没有** ⇒ `bun test` 在其上报 "No tests found!" 退出 1 ⇒ 根
`bun run test` 退出码**恒为 1**（CI/脚本无法用退出码判断）。补 12 例（结构语义 / 元字符转义 /
`**/` 回归 / 已知差异），`matchGlob` 是路径级 allow/deny 判定的基础，判错方向可能不安全。

### 四、踩坑记录

块注释里写 `(?:.*/)?` 会因其中的 `*/` **提前闭合注释**，bun 直接报 `Unexpected )` —— 注释里
不要出现 `*/` 这个序列（改写措辞即可）。

### 五、验证

typecheck 0 错误；全量 **1700 pass / 0 fail**；**根 `bun run test` 退出码首次为 0**（全仓再无
"No tests found"）。Anthropic 缓存**未真机验收**（无 key），验收步骤写在选项注释与 AGENTS.md 里：
① 第二次同前缀请求 `usage.cache_read_input_tokens > 0`；② `cache_creation_input_tokens` 只在首次/
前缀变化时出现。通过后再把默认值翻成 true。

## 2026-09-21（续 174）用量纳管搬到引擎层 + ACP 手册改尾部注入（修前缀缓存失效）

实施 `docs/usage-accounting-and-prompt-cache-plan.md`（该文件为本轮方案稿，同批落地）。
用户拍板：**手册尾部注入**；`@harness/usage` 独立成包；`meta.usageStats` 保持本会话口径 + 展示层给聚合行。

### 一、用量纳管（P1+P2+P4）

- **抽包**：`packages/usage`（零依赖纯函数，647 行），`cli/src/usage-stats.ts` 变薄再导出
  —— cli 351 例一行不改（迁包目的是让 core 也能累加，不是改导入路径）。
- **引擎层唯一累加**：core `_runOneStep` 末尾 `accumulateUsage()`，把本步 assistant 消息
  折叠进 `session.meta.usageStats`；新增 `harness.usage.get/children`。
- **幂等靠检查点、自愈靠重建**：`meta.usageFold = { upToMessageId, state }`（state 含跨消息的
  pending/attributed，丢了会让工具 token 归因错位）；检查点指向的消息不在（`/compact`、
  `deleteMessage`）⇒ `rebuildUsage(messages)` 全量重算。**增量与重建共用 `foldMessage`**
  （`usageFromMessages` 也改成它的 wrapper），有等价性测试守住"两条路径同结果"。
  不做幂等就会把历史上"空累积器覆盖历史 ⇒ 重连清零"变成反面的"历史被重折 ⇒ 数字翻倍"。
- **宿主只读**：TUI 删掉写 meta 与 800ms 防抖落盘，轮末向引擎对账；落盘复用脏会话刷盘。
- **子 agent 可见**：`/stats` 增"含子 agent"行（`children()` + `sumUsage`，展示层聚合，
  不并进父会话 meta —— 并进去会让同一条链在"全部会话·当日"里被重复计入）。

### 二、ACP 手册尾部注入（方案 B）

前缀（`system[1]`）只留恒定的 `COMPRESS_MANUAL_HINT`；完整手册改 **`user` role 注入尾部**，
与 nudge 合并成同一条消息。`manualInjection:'always'` 与显式 `systemPrompt` 仍走前缀
（两者都恒定，无翻转风险）。

⚠️ 不能用 `system` role 挪到尾部：`provider-anthropic` 的 `extractSystemPrompt` 与
`provider-gemini` 的 `extractSystem` 会把**任意位置**的 system 消息上提进顶层 system /
systemInstruction 字段（原位置直接跳过）—— 等于没挪，它会回到前缀。只有 OpenAI 保序。

### 三、providerCache 遥测接线

新增 hook `core.llm.usage`（引擎广播 provider 用量，含 cacheRead/cacheWrite；**事实广播不回写**），
acp-context 订阅后落 `providerCache` 遥测行。此前 `buildProviderCacheEvent` 的注释写着"由 core 层
追加"但全仓无调用方 ⇒ provider 侧缓存命中**一直没有数据**，"按需注入会不会伤缓存"根本无从验证。

### 四、真机验证（临时 dataDir + 真实 DeepSeek，三条链路各自独立验证）

| 验证 | 结果 |
|---|---|
| 注入几何（小窗口逼越阈值，抓每轮请求） | 手册出现那一刻前缀**字节未变**（738 字符、指纹 `8b13b862` 全程恒定），8365 字符手册落在尾部 |
| 缓存遥测（新接线） | 主会话 7 轮 cacheRead 1920→9344→9600→9984→10112→**10752→10752**；第 6 轮（手册首现）**未塌陷** |
| 子 agent 用量 | 子会话 `s_session_...` 落盘 3 条消息 + `usageStats`（2 次调用 / in 19,687 / cacheRead 18,048），顶层 `parentId` 指向主会话 |
| `/stats` 聚合行 | `含子 agent：1 个子会话 · 调用 2 次 · in 19683 / out 81（缓存命中 19328）`；"今日 5 次" = 主 3 + 子 2 |

改造前对照：子会话**连 .json 都没有**（只有遥测），用量恒为 0；手册进前缀时该轮会让其后整段历史重算。

### 五、真机暴露并修掉的一个取值错误

`usage.children()` 最初按 `meta.parentId` 反查 ⇒ 真机永远为空（聚合行不出现）。核对落盘字段：
**`parentId` 是 Session 的顶层字段**（`session.create({ parentId })`，subagent 派生与 CLI 恢复都用它），
`meta.parentId` 恒为 null。改为读顶层字段 + 补测试。教训：**先确认真实落盘字段，再写取值代码**。

验证：全量 **1683 pass / 0 fail**；typecheck 0 错误（新增 +6 核心守卫、+5 折叠等价性、
+2 providerCache、+3 聚合行）。AGENTS.md 新增四条硬约定（前缀只放恒定文本 / 尾部注入必须用
user role / 累积必须 checkpoint+自愈 / 用量口径引擎层唯一）。

## 2026-09-21（续 173）会话分析暴露的 8 个问题：全部修复（含 2 个 worker 因限流中断后的接手）

来源：对会话 `s_1789916436883_ra6w1` 的取证分析 + token 归因（两份报告在 `reference/workbuddy/`）。
按文件集分 4 组并行修复（worker-swarm / worker-session / worker-subagent / worker-acp），
其中 **worker-session 与 worker-subagent 均因 429 限流中断**（DeepSeek 配额，12:49 重置）——
落盘检查后确认 worker-session 的改动已完整（core/session/cli 测试全绿），
worker-subagent 的收尾修正（落盘路径）也已落地；**我的追加项（用量统计口径）由我接手完成**。

| # | 问题 | 修法 | 真机验证 |
|---|---|---|---|
| 1 | swarm 字段名不一致 ⇒ `Team not found: undefined` | team_* 接受 `name ?? team` + schema 同步 | ✅ 传 `team="probe-team"` 得到 `Team not found: probe-team` |
| 2 | `task_create {}` 抛 `name.trim` TypeError；`task_list {}` 静默 `[]` | 五个 task_* 入口 `requireTeam()`；`TaskListPlane` 入口 `assertTeamName()` | 单测 6 例 |
| 3 | `bash {}` 被送进 shell（6 次 `undefined: command not found`） | 入口校验 ⇒ `COMMAND_REQUIRED` | 单测 2 例 |
| 4 | 越界读被 bash 绕过 | 三处提示改为说明边界（工作目录/作用域/走用户确认），**不写成绕过指引**；AGENTS.md 记为已知取舍 | — |
| 5 | 子会话 ID 中文全变下划线 + 同毫秒碰撞 | `slugifyTitle()`（ASCII-only slug）+ 5 位随机段 + 已存在 id 去重 | ✅ 落盘 `s_session_..._ftn4x`（中文 title 不再产出下划线） |
| 6 | 子会话消息不落盘（用量与过程全丢） | SessionManager 脏集合 + CLI `flushDirtySessions()` 只存脏会话 | ✅ 子会话 `.json` 出现（3 条消息，2774B） |
| 7 | 完成任务时父会话已结束 ⇒ 结果无人消费；结果双通道重复注入 | 落盘 `{dataDir}/tasks/*.json` + `index.jsonl`；`resultFetched` bus 事件把通知降级为一句提示 | ✅ `/tmp/verify-real/tasks/task-muajt7fr-1.json`；仓库 cwd 无污染 |
| 8 | 用量统计"调用 0 次 / 错误 1 次" | `recordTool` 改为每次调用都计 count，失败另计 errors（并更新两处锁死旧语义的测试） | 单测 2 例 |

**token 侧顺带落地**：ACP 压缩手册改为按需注入（占用率 ≥ `minContextLimitPct × 0.9` 才发完整手册，
否则一行提示 + compress 工具 documentation 兜底）。真机抓到 system 第二段 8,365 → **57 字符**。

**⚠️ 未完成的另一半（需拍板）**：子会话用量仍未"实时纳管" —— 用量累计与写盘的**唯一实现方在 TUI 层**
（`packages/cli/src/tui.tsx:1202` 的模块 4），非 TUI 宿主（headless/REPL）与子 agent 会话都不会写
`meta.usageStats`。本次修复让子会话**消息**落盘，因此用量可用现成的 `usageFromMessages()`
（`usage-stats.ts:495`）从消息重建，但那是"可重建"而非"实时可见"。彻底解决需把用量累计从 TUI
搬到引擎层（core），并处理与 TUI 现有累计的**重复计数**风险 —— 属架构级改动，先不动。

提交：`9659fd3`（swarm）`423ee69`（子会话可观测性）`bab5941`（用量口径）`0e5e609`（工具校验）
`63490af`（subagent/coordinator）`69361f4`（acp-context）。全量 **1665 pass / 0 fail**，typecheck 0 错误。

## 2026-09-20（续 172）修复 provider-openai 序列化丢弃内嵌工具结果 → DOOM_LOOP 中断

**根因（provider 层）**：某真实会话（如 `s_1789916436883_ra6w1`）"输出到一半就中断"，模型推理区出现
*"I keep failing to make tool calls"*。core 把工具执行结果**内嵌**进同一条 assistant 消息的 tool part
（`{type:'tool', toolUseId, toolId, input, result}`，见 core `_buildStepMessages`），会话里不单独生成
`role:'tool'` 消息。而 OpenAI Chat Completions 要求 `assistant(tool_calls)` + 紧随的 `role:'tool'`
（带 `tool_call_id`）结果消息严格成对。

`toOpenAIMessages` 的原实现只在 `tp.result === undefined` 时把 tool part 转成 `tool_calls`；**带 result
的 tool part 被静默丢弃**——既不入 tool_calls，也不落入 `role:'tool'` 分支。结果模型看不到工具结果、
反复重试同一调用直至触发 DOOM_LOOP 硬中断。**该 bug 只在未启用 ACP 压缩时触发**（ACP 的 adapter 会把
tool part 先拆成独立 `role:'tool'` 消息，绕开了这条序列化路径）。

**修复**：`toOpenAIMessages` 的 assistant 分支里，tool part 无论是否带 result 都输出为 `tool_calls`；
带 result 的额外收集进 `embeddedResults`，在同一条 assistant 消息序列化后紧随其后补发 `role:'tool'`
结果消息，顺序与 part 一致。

**验证**：provider-openai 新增回归用例"assistant 内 ToolCallPart 带 result：同时输出 tool_calls 与独立
role:tool 消息"（断言 tool_calls 2 条 + 2 条独立 tool 结果顺序/内容完整）→ 29 例全过；core agentic-loop
24 例全过；全量 typecheck 绿。

## 2026-09-20（续 171）遥测四提交后独立评审：2 个 P1 + 3 个 P2 修复

按续 136/166 方法论，对 7927498/c905afb/9b3b8c5/c62bc89 做提交后独立审查（自查 + 独立子代理交叉）。

**P1 —— 任意 `id` 被误当 sessionId（真实运行期 bug）**：`extractIdentity` 的 `SESSION_KEY_HINTS` 含 `'id'`，
于是 `tool.enabled {id:'bash'}` / `plugin.loaded {id:'code-intel'}` 等事件的 tool/plugin id 会被顶成 sessionId，
`switchWriter` 把会话遥测切散到 `{toolId}.telemetry.jsonl` 之类错误文件，并污染 `lastKnown.sessionId`
（崩溃事件归属错 session）。修复：只认明确会话键 `sessionId/session_id`，`pickAttrs` 里 `id→sessionId`
别名归一一并移除。教训：**订阅 subscribeAll 的遥测会收到任意 payload，把通用 `id` 当主键极其危险**。

**P1 —— `unhandledRejection` 被静默吞掉**：挂监听后 Node 不再按默认（未处理 rejection → 退出）处理，
`rejectionHandler` 只 record+flush 不退出 ⇒ 进程带病运行，违背"交还原行为"契约。修复：记录后
`process.exit(1)`（对照 exceptionHandler rethrow、signal re-emit）。

**P2×3**：`checkTelemetryConfig` 漏校验 `userId`（非字符串被静默丢）；概览对 `otlp:{}` 误显示"上报开启"→
改为"已配置但无有效 endpoint（不会上报）"；`telemetry.path` 固定单文件与会话分隔语义冲突（有意为之，记录知悉）。

测试：telemetry 29 例、cli 376 例（+1 userId 校验、+1 otlp 空 endpoint 概览、map 断言改防污染）全过；全量 typecheck 绿。

## 2026-09-20（续 170）ACP 遥测迁移到通用设施（复用 @harness/telemetry writer）

`acp-context` 撤掉自研 JSONL writer，复用 `@harness/telemetry` 的通用 `createJsonlWriter`。

- `telemetry.ts`：删除本地 `writeFileSync/mkdirSync/existsSync` 实现的 `createWriter`（该实现正是
  通用 writer 的来源），改为 `export const createWriter = createJsonlWriter as (path?)=>JsonlWriter<TelemetryEvent>`；
  `TelemetryWriter` type 保留为 `JsonlWriter<TelemetryEvent>`。
- **关键约束**：复用 writer 但**不套用统一 envelope**——ACP 事件每行仍是
  `{kind:'preModel'|'compress'|'providerCache', ...}`，保住现有 bench 脚本（`bench/*.ts`）兼容。
- 依赖：`acp-context` 新加 `@harness/telemetry`。

至此通用遥测设施闭环：bus→envelope→本地写 + OTLP + 崩溃兜底 + 异常专项埋点（续 167~169），
ACP 压缩遥测也统一到通用 writer（去重后仅事件模型仍独立）。

测试：acp-context 55 例 + telemetry 28 例，cli 375 例，全量 typecheck 绿。

## 2026-09-20（续 169）遥测异常场景专项埋点（权限拒绝 / DOOM_LOOP / 工具失败细分 kind）

遥测插件把三类工具失败单独细分 kind，而非全落在通用的 `telemetry.bus.*`，便于异常检索/告警。

先摸清 core：目前**只有**生命周期 + 生命周期解耦事件（harness.* / plugin.* / mcp.* / tool.enabled），
没有运行期的权限拒绝 / DOOM_LOOP / tool.call 结果事件。故**不改 core**，利用既有的
`core.tool.post.execute` hook（核心实测始终带 `ctx.tool.id`）：

- `map.ts` 新增纯函数 `toolFailureEnvelope(ctx, result)`：`result.ok===false` 时按 `error.code` 细分——
  `PERMISSION_DENIED` → `telemetry.permission.deny`（errName=ToolPermissionDeniedError）、
  `DOOM_LOOP` → `telemetry.doomloop`、其它 → `telemetry.tool.fail`；成功/null 返回 null。
- `index.ts` 的 `install` 现在返回 `Hooks`：注册 `core.tool.post.execute`，失败即 `persist` 该 envelope，
  原样返回 result 保持 pipeline 语义（遥测只读不改写）。

说明：DOOM_LOOP 的 fail 结果可能不总经过 post.execute（agent 循环内直接产出），这条线属「尽力而为」；
`harness.error`/crash 兜底已覆盖其主线。权限拒绝必经过工具 pipeline ⇒ 必命中。

测试：telemetry 包 +5 例（permission.deny / doomloop / tool.fail / 成功 null / 空 result）共 28 例全过；
全量 typecheck 绿。

残留待办：ACP 遥测迁移到本包（`telemetry.acp.*`）。

## 2026-09-20（续 168）遥测 OTLP 最小直连导出

在 `@harness/telemetry` 上加可选 OTLP 出口（对齐 `reference/opencode-dev/.../otlp.ts` 思路），用户已定「最小直连 batch log exporter、不引整套 SDK」。

**`src/otlp.ts`**：只发 `v1/logs`（不做 traces）；endpoint 为空 → 整体 no-op（冷路径零成本）。序列化走 OTLP/HTTP `application/json` 的 `ExportLogsServiceRequest`，不引入 protobuf 依赖：
- `toOtlpLogRecord`：envelope → LogRecord（`timeUnixNano`、`severity`、`body`、`attributes`），异常类 kind（`error|fail|crash|doomloop|deny`）自动标 ERROR 级便于远端告警；
- `toExportRequest`：批量包 resourceLogs 结构（纯函数，可单测）；
- `createOtlpExporter`：batch + debounce 合并请求、`AbortController` 超时、失败静默丢弃本批。

**接线**：`createTelemetryService` 增加 `otlp` 选项，`persist` 双写（本地始终落盘 + OTLP 上报），`flush()` 联动发送、`uninstall` close。**本地行为零变化**，OTLP 仅作添加上报。

**cli**：`telemetry.otlp {enabled, endpoint, headers}` 逐项显式映射 + 白名单校验（未知键/非法类型在 `--check-config`/概览、boot WARN 双处暴露），概览加 `OTLP 上报开启（endpoint）`。

**测试**：telemetry 包 +8 例（otlp 序列化/severity/close）共 23 例；cli +3 例（otlp 校验/映射/概览）共 375 例，全过；全量 typecheck 绿。
真机联调：OTLP/HTTP 收 JSON 还是 protobuf 取决于 collector 配置，本地无法联调；已留「真机为准」校验点（见规划 §6 注释）。

残留待办：ACP 遥测迁移到本包（`telemetry.acp.*`）、异常遥测的权限/doomloop 专项埋点（当前由通用 `telemetry.bus.*` 覆盖，未细分 kind）。

## 2026-09-20（续 167）通用遥测插件 `@harness/telemetry`（本地采集 + 可选 OTLP）

按 `docs/telemetry-plan.md` 落地第一步：通用遥测设施 + cli 装配。用户已定三项决策：**会话级**存储、
**最小直连** OTLP（未实现，留二期）、需要**跨会话匿名 user id**。

**现状复盘**：此前只有 ACP 压缩的定制遥测（`acp-context/src/telemetry.ts`），写 `{sessionId}.telemetry.jsonl`，
且事件名/维度自造、无统一模型。本包把它提升为通用模块：

- `envelope.ts`：统一 `TelemetryEnvelope {schema, kind, ts, attrs, metrics}`，隐私红线 = 只记标量/低基数标签，
  从 bus 载荷通用提取 `pickMetrics/pickAttrs/extractIdentity`。
- `writer.ts`：`createJsonlWriter`（提升自 ACP `createWriter`，泛型化、debounce、失败静默、无 path=no-op）。
- `map.ts`：任意 bus 事件 → `telemetry.bus.<name>`，`harness.error` → `telemetry.error`；初版即可覆盖现有
  `HarnessEvents`/`LifecycleEvents`，免逐条枚举。
- `crash.ts`：崩溃兜底——SIGTERM/SIGHUP（**不抢 SIGINT**）、`uncaughtException`/`unhandledRejection` →
  `telemetry.crash` + flush 后交还原信号/异常默认行为；堆栈哈希去重、截断防泄露。
- `index.ts`：`createTelemetryService`（返回 `{plugin, telemetry}`）与 `createTelemetryPlugin`（仅插件）；
  `install` 订阅 `ctx.bus.subscribeAll`，会话边界切换活跃 writer；`deriveUserID` 从 `.config-key` 派生匿名 id。

**cli 装配**（零影响默认）：config.json 写 `telemetry` 段才装配，逐项显式映射 + 白名单校验
（`telemetryPluginOptions`/`checkTelemetryConfig`，未知键/非法类型在 `--check-config`/概览、boot WARN 双处暴露），
概览加 `遥测（telemetry）：…` 行。dataDir 用 CLI 实际 workspace，避免路径口径分裂。

**踩坑（很关键）**：`switchWriter` 的 `activeSessionId === undefined` 守卫在首条**无 sessionId** 的 bus 事件上
恒真 → 永远不建 writer、不发文件。修复：用唯一哨兵 `UNSET` 代替 `undefined` 当"未初始化"态。教训：
**「比较未初始化态防重复」在首个值为 undefined/null 时会直接吞掉首写**，这类守卫应选一个业务值永远
不会命中的哨兵。

测试：telemetry 包 15 例 + cli telemetry-config 11 例全过；cli 全量 372 pass（含新 11 例）；全量 typecheck 绿。
root `bun test` 的 607 处 `document is not defined` 为既有 TUI/dom 环境性失败，与本次改动无关。

提交待续。OTLP 最小直连 + ACP 遥测迁移到本包（`telemetry.acp.*`）留二期。

## 2026-09-20（续 166）提交后评审：59e296e..HEAD（63 提交，续 157~165）—— 1 安全 + 4 缺陷

按续 136 固化的方法论（**提交后再跑一次独立审查**）：我自查 + 独立子代理复审，交叉确认。

**P0 安全 —— save() 中间目录符号链接逃逸**：`root/<id>` 被预置为指向外部的 symlink、且外部
无 SKILL.md 时，`existsSync(target)=false` 绕过全部既有检查，tmp 与最终文件都经链接写到根
目录**外**（本地探针实锤）。修复：mkdir 后对父目录 realpath 校验（根自身也取 realpath，
兼容 macOS /var→/private/var）。教训：**只校验最终路径挡不住中间目录链接**，每一级写入点
都要验。

**P1 —— /forge memory add 丢内容**：`split(/\s+/).slice(3)` 把内容里的词当分隔符丢掉
（"这个项目用 bun 跑测试"只写入"bun 跑测试"）——**就藏在自己的真机 e2e 输出里**，当时
只看了"已写入"没核对内容。改用 parseArgs 的 positional。

**P2×3**（独立评审抓出 2 个、自查 1 个）：schedule() 重置 forced（冲掉 compress 触发的
立即发布）、pending 草稿 Map 无界、非法 id 拖到 confirm 才报错。另修 cli run 空 detail。

**P3**：writeAtomic / writeFeedbackMemory 对已是符号链接的目标拒绝写入。

独立评审同时确认了四个"不是缺陷"（post.execute 契约、/forge skill 切片、__jsonSchema
转发、doom-loop 硬中断），避免追假阳性。结论：可合入，P2 已全部修复后再提交。

提交 `8528601`（修复，+10 例守卫）。全量 1595 pass / 0 fail。
经验：真机 e2e 断言"写入了"不够，要**断言写入的内容**；安全检查要覆盖中间路径组件。

## 2026-09-20（续 165）ACP 压缩信号统一到引擎层（回答"和 memory 保持一致还是都改引擎层"）

用户追问两条路的区别。结论：**照抄 memory 旧方式（cli.agent.stream）保持的"一致"是与缺陷一致**
—— UI 消费层通道在内嵌/ACP 宿主收不到，正是本项目三次静默失效事故（herdr 上报、turn_end 广播、
memory flush）的同源模式；且 memory 旧注释的技术前提（"post.execute 的 ctx 没有 toolId"）早已
不成立，`ToolPostHookContext` 一直带 `tool.id`。

统一后的触发源三件套（两插件一致）：post.execute 识别 compress（ACP 模型驱动压缩，
**不触发 compacting**）+ compacting（session compaction）+ turn.end 攒轮兜底。
附带的语义改进：旧 UI 方式在 tool_call_start（压缩前）就 flush，压缩失败也发布；现在
`ok:false` 不发布（软失败——返回 errors 但 ok 仍真——照常发布，真机就撞上了 anchor 失败
折叠 0 块的 case）。

真机（ACP 开、小窗口逼模型调 compress）：锻造+绑定后连续 9 轮 system 恒定；compress 后下一轮
技能进入（变化一次），随后恒定。memory 60 例（改 1 补 2）、skill-forge 46 例（+3）；
全量 1589 pass / 0 fail。提交 `f71c1d7` + 计划文档 §5.1。

## 2026-09-20（续 164）锻造的技能改延迟注入 + `/forge` 统一入口把两条线串起来

**延迟注入**（用户拍板：技能也跟记忆一样延迟）：技能进 `agent.skills` 白名单 ⇒ 下一轮 system
就变 ⇒ 前缀缓存失效一次；而锻造常常连着做几件，逐个立即绑定会连付 N 次代价。改为与记忆同一判据：
`--bind` 只排队列；触发源**双份**（`core.session.compacting` + `core.agent.turn.end` 攒够 15 轮兜底，
只数主会话）；到期后在 `core.prompt.system.transform` 统一绑白名单；`--now` 例外。

真机（抓每轮 system 指纹）：锻造+绑定后**连续 6 轮完全不变**，`/forge flush` 后第 7 轮才变一次
（+125 字符）并随后恒定 ⇒ 连续锻造 N 个技能只付一次缓存代价。

**`/forge` 统一入口**（§5 落地，两条线一个入口）：面板（可固化流程 / 待注入技能含轮数进度 /
记忆条数 / 技能数）+ `memory add|list`（单条事实）+ `skill`（多步流程，转发）+ `flush`（立即发布）。
记忆写入不依赖 @harness/memory（用户可能没启用它）。

**修一个自己写出来的 bug**：`/forge flush` 只调 `takeDue()` 没先 `flush()` ⇒ 面板显示"待注入"、
flush 却说"没有"（真机当场暴露，已修并补用例）。

提交 `a7ab020`（延迟注入 + /forge，+10 例）+ `840c920`（计划文档 §8 决策表 + §5.1）。
typecheck 0 错误；全量 1584 pass / 0 fail。记忆线与技能线至此**全部完成并已串联**。

## 2026-09-20（续 163）F3 收尾 + 「自动创建的技能注入」缓存实测（抓每轮 system 指纹）

**F3 落地**：`/skill-forge suggest` 做隐式重复检测（同工具+同入参：单步 ≥3 次 / 2~6 步序列
完整重复 ≥2 轮），**只提示不自动写、且刻意不进 system**（每轮改 system 会让前缀缓存持续
失效，而提示根本不需要进模型上下文）；工具失败 ≥2 次回写一条 `[feedback]` 到 MEMORY.md
（一次会话一条，不依赖 @harness/memory）。

**缓存实测结论（用户问"自动创建的技能注入是否也走缓存"）**：
用取证插件抓每轮 system 指纹 —— 锻造前 3 轮恒定；`--bind` 后第 1 轮变化一次（+130 字符，
技能进入）；之后恢复恒定。**注入每轮从内存 manager 取，无磁盘/mtime 参与** ⇒ 不会像文件
那样因外部改动让 system 每轮抖动；绑定只在那一刻失效一次前缀缓存，符合 §3.7「技能立即」。

**实测顺带挖出两个真缺口（都已修）**：
1. `core.skill-injection` 原判据 `skillManager.all().length > 0` ⇒ **空 skills 目录启动的会话，
   之后锻造的技能永远进不了提示词**（6 轮指纹全一致且不含该技能）。改为「宿主编配了
   skillDirs 即注册」（不是"当前有技能"，也不是无条件——无条件会把 core 3 条插件清单断言打红）。
2. 注入只认 `agent.skills` 白名单，而 `paths` 条件触发是**死代码**（matchByPath 无调用方）
   ⇒ 新增 `--bind`（运行时加入白名单 + 打印该写进 frontmatter 的那一行；插件不替用户改配置）。

**踩坑**：测试替身把 workspace 的 memory 留成空串 ⇒ `join('', 'MEMORY.md')` 变成相对路径，
一条 [feedback] 写进了包目录（已清理）。插件侧补「目录为空不落笔」，与"路径口径分裂"同源。

提交 `84ac2a9`（core 注入注册判据）+ `0f7a73c`（F3）+ `28531e3`（空路径防护）+ `8ddd5ab`（计划文档）。
typecheck 0 错误；全量 1574 pass / 0 fail。技能线 F0~F3 全部完成（仅剩两条线用统一 /forge 串联）。

## 2026-09-20（续 162）技能锻造 F0/F1/F2 落地（记忆线 M0~M3.1 之后的能力二）

按 docs/memory-and-skill-forge-plan.md §4 推进：记忆线已收口，接着做「把跑通的流程固化成技能」。

**F0（@harness/skill）**：新增 `SkillManager.save()` + `skillToMarkdown()`。安全边界四道：
目标目录必须已登记（不给任意路径）、id 只允许 `a-z0-9-_`（id 即目录名）、目标为符号链接
或 realpath 越界一律拒绝、同目录临时文件 → rename 的原子写；写后 reload（未命中源时 register
兜底）⇒ 落盘即当轮可用。配套：`load()` 在目录不存在时也登记 sourceDirs（首次锻造时 skills
目录往往还没建）；realpath 越界校验的基准也要取 realpath（macOS 的 /var → /private/var
符号链接会误判，单测当场抓出）。

**F1/F2（新包 @harness/skill-forge，optIn）**：`/skill-forge <name> [--project] [--desc "何时用"]`
出草稿（**不落盘**）→ `/skill-forge --confirm <name>` 才写文件并当轮生效；另有 list / path /
disable。要点：
- 轨迹采集走引擎层 `core.tool.post.execute`（不用 UI 层的 `cli.agent.stream`，内嵌宿主下会静默失效）；
- 命令两段式：`CliCommandInput` 只有 out 没有 stdin，这是唯一不阻塞 REPL 的确认方式；
- 生成**不接 LLM**（照实记录跑通的路径，避免幻觉步骤）；默认 user 级（项目级会随 git 共享）；
- 步骤去噪三级（真机观察驱动）：折叠相邻重复 → 折叠完整周期 → 按「工具+入参」全局去重。
  实测把 list_dir/read_file 反复跑出的 12 步压成 3 步，且不丢不同入参的步骤。
- F2：描述相似度（Jaccard 0.5）提示"更新已有技能"、数量上限 50、禁用而非删除。
- 生成技能 `allowEmbedShell: false` 写死（防模型给自己生成 !`cmd` 可执行技能）。

**真机端到端**（临时 dataDir + 真实 DeepSeek，REPL 用管道喂命令并留足等待时间）：
工具调用 → 草稿 → --confirm → SKILL.md 落盘 → `/skill-forge list` 当轮可见。
（坑：管道喂命令太快会在模型跑完前就 `/exit`，轨迹为空 —— 需 sleep 等待。）

提交 `2a06a5d`（F0，+9 例）+ `2c098cf`（F1/F2，+23 例）+ `4d0e3a1`（计划文档）。
typecheck 0 错误；全量 1564 pass / 0 fail。**F3（隐式重复检测 + 失败回写记忆）未做**。

## 2026-09-20（续 161）schema 补齐至 42/42 + headless 失败结果可见

**① 剩余工具 schema 全部补齐（17 个）**：swarm 9（task 系 status 用五态 enum；shutdown 决策
两工具）、coordinator send_message（mailbox/续跑两套路由分别说明）、subagent（runInBackground/
targetFiles 语义进参数描述）、code-intel 4（code_semantic_edit 联合入参用 oneOf 三模式）、
view_image、web_fetch。加上续 160 的 10 个与 MCP 透传的 computer-use 10 个，全仓 42 工具全覆盖；
脚本终检「未包 withJsonSchema 的 makeSchema」= 0。

**顺带修掉一个会让 oneOf 白写的转发缺陷**：三个 provider 此前只挑 properties/required/
additionalProperties 三个字段转发 —— oneOf/anyOf/items 会被静默剥掉，code_semantic_edit 发到
模型侧就退化成空对象。改为整体转发（`{ ...schema, type: schema.type ?? 'object' }`）；
JsonSchemaObject.properties 相应改为可选。

**② headless run 失败可见**：run 模式此前只渲染 tool_call_start，tool_call_result 整个忽略 ⇒
DOOM_LOOP/权限拒绝/执行异常在脚本里完全无声。现在 isError 结果**始终**打 stderr
（`[工具失败] <toolId>: <message 单行 300 字>`），成功结果仅 --verbose 给一行摘要，
stdout 保持纯结果。真机复验：coordinator 空转被守卫切断时 stderr 明确打印中断原因。

提交 `d169025`（schema，10 文件）+ `d5c8e1f`（cli）。typecheck 0 错误、全量 1532 pass / 0 fail。

遗留观察：本次真机 run 中模型仍高频调 acp_status（27 次里 11 次）——参数/schema 都对，
纯粹是它「每步开工前看一眼状态」的习惯；守卫会在同参连续 3 次时切断，暂不进一步干预。

## 2026-09-20（续 160）提示词取证：42 个工具的参数 schema 全是空的 —— 补上后同一句 prompt 从空转变成正常完成

顺着续 159 的空转追"构造出的提示词"，用临时 dataDir + 用户插件（`core.session.preModel`）把每轮
**真正发给模型**的 messages 落了盘，provider 层的 tools 载荷用真实工具定义直接调 `buildBody` 打印。

### 首轮请求构成（coordinator + 「分析当前会话」，实测）

| 部分 | 长度 | 内容 |
| --- | --- | --- |
| system[0] | 738 字符 | Agent 提示（身份 + 派工规则，本身写得干净） |
| system[1] | 8380 字符 | **ACP 压缩手册**（第二条 system，插在 system 与 user 之间，每轮全量重发） |
| user | 47 字符 | 其中 31 字符是内核注入的 `<acp tokens="6" type="text">m00001</acp>` 前缀 |

**任务本身只占首轮内容的 0.7%**。

### P0-1　42 个工具的参数 schema 全部为空（本次最重要的发现）

三个 provider 适配器都读 `inputSchema.__jsonSchema` 生成 tools 载荷，但**全仓没有任何写入方**；
工具全是裸 `{parse, safeParse}`（acp-context 的 `makeSchema`、MCP 的 `PassthroughSchema` 连服务端
声明好的 inputSchema 都丢掉）。实测所有工具发出都是：

```json
{"type":"object","properties":{},"additionalProperties":true}
```

⇒ 模型认识工具参数的**唯一**渠道断了：`list_dir` 描述仅 31 字符 ⇒ 只能 `list_dir {}` ⇒ 每轮同一个
默认目录列表 ⇒ 原地打转；`acp_status` 无参数可填 ⇒ 变成"万能安慰工具"；`compress`（模型驱动压缩的
核心工具）参数完全不可见。b0c2s 里模型那句 "the tools require parameters even if empty" 就是在描述
这个感知。**这不是模型"变笨"，是我们没给参数。**

修复：
- `@harness/tool`：`Schema` 增加可选 `__jsonSchema`；新增 `withJsonSchema(schema, json)`（只追加描述，
  不改运行时校验行为）。
- mcp-client：`convertMcpToolToHarnessTool` 把服务端声明的 inputSchema **透传**成 `__jsonSchema`。
- 补齐 10 个高频工具：bash/read_file/write_file/edit_file、list_dir/grep_file、glob、
  compress/decompress/search_context/acp_status。其余（swarm/computer-use/web 等）待补。

### P0-2　工具清单未按 agent 过滤

provider 的 toolsGetter 是 `harness.tools.list()`（全局注册表）⇒ coordinator 一轮收到 **42 个工具**
（含 computer-use 的 click/drag/type_text、OCR、文件编辑、code-intel、swarm 的 team/task 工具），
而提示写着「你负责调度，不亲自执行」。改法：`ChatProvider.complete/stream` 增加可选 `tools?: Tool[]`，
core 传入本 agent 的 `allowedTools`；三个适配器载荷优先用 `params.tools`，缺省才退回全局注册表
（toolsGetter 保留，兼容旧调用方与单测）。

### P1　ACP 手册的示例标签脱敏

内核压缩系统提示里带一个**字面示例** `<acp tokens="2.1K" type="tool:bash">m00175</acp>`，同一页又要求
"NEVER echo these tags" —— 一边给可复制模板一边禁模仿，g800t 实测模型照抄（连 `[tool]` 一起）。
宿主侧能做的：`sanitizeExampleTags()` 在 `makeSystemPrompt` 处把示例脱敏成不完整形态
（`<acp tokens=… type=…>mNNNNN</acp>`），保住"每条消息都带 ref 标签"的语义、不再提供可复制模板；
消息上的**真实** ref 标签不受影响（那是 compress 选段的机制）。load-bearing 的四段规则文本未动。

### 真机前后对比（同一句 prompt、同模型同环境）

| | 修前（b0c2s） | 修后（实测） |
| --- | --- | --- |
| 工具载荷 | 42 个工具、全部空 schema | 白名单内、常用工具带完整参数 schema |
| 行为 | 24 次空参 `acp_status`/`list_dir {}`，原地打转 | `list_dir {"path":".","maxDepth":2}` 等真实参数探索 |
| 收尾 | 第 25 步无文本无工具 ⇒ 静默结束（用户看到"中断"） | 正常给出带表格的最终答复（13 步，exit 0） |

**验证**：typecheck 0 错误；全量 1532 pass / 0 fail（新增 withJsonSchema、MCP 透传、params.tools
优先级 3 条防回归）。AGENTS.md 新增硬约定：**新工具不写参数 schema 视为缺陷**。

**遗留**：① swarm/computer-use/web 等其余工具的 schema 待补；② `harness run` 模式不打印工具结果
（DOOM_LOOP 在 headless 不可见）；③ ACP 手册 8.4k 字符的固定成本与「两条 system 消息」的排布
属内核设计，宿主侧只能整段覆盖（`systemPrompt` 选项），整段接管会引入内核升级漂移，暂不做。

## 2026-09-20（续 159）doom-loop 守卫改为硬中断（不再受权限模式影响）+ ACP 对照实验

用户问：会话 `s_1789862291973_b0c2s`「跑到一半中断了，还是之前遇到的问题吗」。

**先答：不是。** 之前那条根因（`renderText` 把 tool part 渲染成 `[tool]` 占位 → 模型模仿 → 不再调工具，
续 ⑦）本会话 **0 次复现**（`[tool]` 计数 0）。本次是**另一个**问题，而且拆开是两层。

### 会话落盘还原（`~/.harness/sessions/`）

- title「分析当前会话」，agentId=coordinator，model=`online/deepseek-flash`，cwd=claude-code-analysis-main
  （= TUI 的 `-c` 参数），**21 秒内 25 次 LLM 调用**：24 次 `acp_status`（多为空参 `{}`）+ 若干 `list_dir`；
  每步 output 仅 53~60 token。
- 模型 reasoning 反复自述"我没能发出工具调用"，并乱试三种协议（`antml:invoke` / `function_calls` /
  JSON `{"name":..}`）—— 全仓 grep 确认这些格式**不来自我们的提示词**，是模型自身先验；实际调用是发出去了的。
- 最后一步只有 53 token 推理、**既无文本也无工具调用** ⇒ 引擎按「无工具调用 ⇒ 收尾」正常结束本轮
  ⇒ 用户看到的「中断」、没有最终答复。**收尾方式与上次相同，但成因不同。**

### 修的第一层：守卫被权限模式架空（本次的实锤缺陷）

用落盘数据复算「整步重复」判据（阈值 3）：**[15][16][17][18][24] 共 5 步命中** —— 判据工作正常，
但守卫的实现是 `permission.ask()`，而该 TUI 用 `--permission allow-all` 启动 ⇒ `CliPermissionEngine.ask`
直接返回 allow ⇒ **5 次命中全部被放行，25 步空转零拦截**。续 ⑦ 里"doom-loop 未拦住属预期（步签名不命中）"
的解释在本次不成立。

改法（`core`）：**守卫与权限解耦，命中即硬中断**。
- 两处（每步聚合签名 / 每次调用签名）删掉 `permission.ask()` 与"用户放行则继续"的分支；命中即记
  `code: 'DOOM_LOOP'` 的失败 ToolResult 并 `break`/`doomLoopTripped`，不再续轮。
- 文案改为「已自动中断本轮以避免死循环。若确有需要，请换一种入参或策略后重试。」
- 理由写进注释：这是「已经在空转」的**资源保护**，不是「能不能执行」的**权限问题**；用权限引擎裁决
  必然被 allow-all / 已记住的 allow 规则架空。
- 顺带删掉每调用分支里那段"确认期间可能 Ctrl-C"的中断兜底 —— 不再有阻塞式询问，而循环顶部已有
  abort 检查（`signal?.aborted` ⇒ ABORTED）。

**防回归测试**（`agentic-loop.test.ts`）：两条旧用例原本断言"用户放行 ⇒ 继续执行"，现改为
「**即使权限引擎一律放行（allow-all）也必须硬中断**」，并断言 `engine.asks === 0`（守卫不得再咨询权限引擎）
与 `provider.calls === DOOM_LOOP_THRESHOLD`（拦下即收手）。`AllowAskEngine` 顺势加了 `asks` 计数。

### 修的第二层：ACP 是不是诱因？—— 对照实验（结论：不是）

怀疑点：ACP 内核每轮给每条消息注入 `<acp tokens=… type=…>mNNNNN</acp>` ref 标签（内核 system prompt 明写
"NEVER echo these tags"），b0c2s 的模型 reasoning 里出现过 "the acp tag"。于是做了一次受控 A/B。

**实验设计**（不碰用户 `~/.harness`）：
- 两个临时 dataDir（`/tmp/acp-ab/{on,off}`），配置**唯一差别**是 `compression.enabled`（acp-context 的装配开关），
  其余（provider/model/plugins）逐字复制；`apiKey` 用 `${AB_DEEPSEEK_KEY}` 环境变量引用 ⇒ **密钥不落盘**。
- 同一 prompt（`分析当前会话`）、同 cwd、同 agent（coordinator）、同 `--permission allow-all`，`harness run` 单跑。

| 臂 | ACP | 实际步序列 | 结果 |
| --- | --- | --- | --- |
| A | 开 | `acp_status`(空参) ×3，签名完全相同 | 第 3 步被新守卫切断（DOOM_LOOP×1），**2 秒**结束 |
| B | 关 | bash/list_dir/glob 交替 13 步（入参多变），第 11~13 步出现完全相同的 `bash+list_dir` | 第 13 步切断（DOOM_LOOP×2），**15 秒**结束 |

**结论**：关掉 ACP 照样空转 ⇒ **空转与 ACP（含 ref 标签）无关**，病根在「模型 + coordinator 提示词 +
这个 prompt」这一侧；ACP 只改变了它挑来空转的工具（开 ACP 时盯上 `acp_status`，关掉后改盯 bash/list_dir）。
两臂 `[tool]` / `<acp>` 计数都是 0，也再次确认续 ⑦ 的修复有效。**A 臂同时是本次守卫修复的真机验收**：
同样的空转，修前 25 步（21 秒）无拦截，修后第 3 步就断。

**顺带记录（未改）**：`harness run` 模式只把 `[工具] <name>` 写 stderr，**不打印工具结果** ⇒ DOOM_LOOP
在 run 模式下对用户不可见；TUI/REPL 走 `createProcessLine` 会渲染 `❌ → {"message":"检测到重复调用…"}`，
所以 TUI 用户能看到中断原因。若要让 headless 也可见，得给 run 的渲染加一条失败结果输出（另议）。

**验证**：core 87 全绿（2 例改写为 allow-all 硬中断 + 引擎不被咨询）；全仓 typecheck 0 错误；
全量测试 1530 pass / 0 fail。真机：A 臂（ACP 开）与 B 臂（ACP 关）都在守卫处被切断，未再出现"静默中断"。

## 2026-09-20（续 158）herdr 上报「启动不显示已启动 / 退出不显示已退出」—— 三条根因，全部真机证实

用户报：「herdr 插件的状态上报似乎有问题，启动时没有立即显示已启动，退出后也没有显示已退出」。
两条症状看起来像两件事，查下来是**三条**根因，而且每条都不是"代码写错了"，而是**按官方文档字面实现、
却没在真机上对过账**。本机恰好装着 `/opt/homebrew/bin/herdr`（0.9.0，server 在跑），于是全程用真机验证，
而不是靠读代码推断。

### 真机手段

- `herdr --help` / `pane report-agent --help` / `release-agent --help`：确认 `--state` 合法值
  （`idle|working|blocked|unknown`）与 **`release-agent` 也有 `--seq`**（官方文档示例里没有！）。
- `herdr pane get <id>` / `herdr api snapshot`：读 pane 上真实的 `agent` / `agent_status` / `state_change_seq`。
- 对 `w2:p3` 用**独立 source**（`custom:harness-probe`）做上报实验，每次实验后 `release-agent` 收尾，
  不触碰用户正在运行会话的 `w2:p1`；实验结束已核对无残留。

### 根因 ①：`--seq` 的水位线跨进程不重置，新进程从 1 起算 ⇒ 前 N 条上报全被丢弃

| 步骤 | 命令 | pane 实际状态 |
| --- | --- | --- |
| 埋高水位 | `report --state idle --seq 100` | `idle` ✅ |
| 模拟新进程 | `report --state working --seq 1` | **仍是 `idle`**（seq=1 被丢弃） |
| 超过水位线 | `report --state working --seq 101` | `working` ✅ |

⇒ 官方原文只写了 "Herdr ignores stale sequence numbers from the same source"，没说水位线的生命周期；
实测它**按 (pane, source) 存、与上报方进程无关**。旧实现 `seq` 每个进程都从 0 自增，于是只要上一次运行
没来得及 release，新进程的前 N 条上报全被当 stale 丢掉 —— 这就是「启动后侧边栏半天不动」。
（更糟的是它**静默**丢弃，没有任何返回码或日志。）

### 根因 ②：`release-agent` 不带 `--seq` 会被同一个水位线丢掉 ⇒ 退出后标签一直在

A/B 实测（同一 pane、两个独立 source）：

| 实验 | 上报 | release | 结果 |
| --- | --- | --- | --- |
| A | `--seq 50` | `release-agent`（不带 seq，**照官方示例写的**） | ❌ 标签仍在、状态停在 `working` |
| B | `--seq 50` | `release-agent --seq 51` | ✅ 标签清掉、状态回到 `unknown` |

⇒ 旧 `buildReleaseArgs` 恰好就是 A 的写法：**释放命令发出去了，但被 herdr 丢了**。
这条解释了「退出后不显示已退出」，而且与进程怎么退出的无关 —— 哪怕优雅退出也不会释放。

### 根因 ③：`process.once('exit')` 覆盖不到信号退出

Bun 1.3.14 实测（`process.on('exit')` 里 `spawnSync` 落一个 marker 文件）：

| 退出方式 | 'exit' 处理器 | release 是否发出 |
| --- | --- | --- |
| `process.exit(0)`（`/exit`、Ctrl-D、TUI 关闭） | ✅ 运行 | ✅ |
| SIGTERM | ❌ 不运行 | ❌ |
| SIGHUP（**关掉 pane 就是它**） | ❌ 不运行 | ❌ |
| SIGINT | ——（Bun 未按默认处置终止；CLI 自己注册了处理） | —— |

⇒ 「关 pane」这个最常见的退出方式，旧实现**永远不会 release**（正好把根因 ② 的水位线留给了下一次运行，
于是下一次连"启动"都不显示 —— 三条根因是这样串起来的）。刻意**没挂 SIGINT**：CLI 的 REPL/TUI 用它
表示「中断当前查询」，插件抢这个信号会把用户的 Ctrl-C 语义改坏；正常 Ctrl-C 退出会经 `process.exit()`
⇒ 仍由 'exit' 兜住。

### 改法（`@harness/herdr` 0.1.0 → 0.2.0）

1. **启动即上报**：新增 `core.harness.start` hook → 报一次 `idle`（= 已启动、等待输入）。
   只挂 `cli.agent.stream` 的话，侧栏要等用户按下第一个回车才有状态。
2. **序号基线改为微秒级墙上时钟**（`nextSeqBase()`，≈1.8e15，真机确认该量级被接受）：
   恒大于任何一次历史运行的末序号，跨进程也不会撞上水位线。
3. **退出序列 `shutdown()`**：先报 `unknown`（离开 working/idle 语义态），再 `release-agent **带序号**`；
   两步都走同步执行器（退出时事件循环已不再调度），幂等。
4. **退出覆盖信号**：`process.on('SIGTERM'|'SIGHUP')` → 同步 shutdown → 卸掉自己的监听 →
   `process.kill(pid, sig)` 按默认处置重发（保住退出码/信号语义，也让进程真的能退出）。`EXIT_SIGNALS` 导出供测试。
5. 顺手把「已启用」日志从恒为 `pane=ok` 改成真实 `pane=w2:p1` 这类实际 pane id（排查时才有用）。

### 写测试时又抓出一个自己的洞

第一版基线用 `Date.now()`（毫秒），回归测试立刻红：

```
Expected: > 1789862553376      // 上一次运行的末序号 = 基线 + 2
Received:   1789862553375      // 新进程的首序号 = 同一毫秒的基线 + 1
```

即**同一毫秒内重启仍会撞车**（我先写了"放大 1000 倍"的版本，测试证明那并不能解决——同一个毫秒的基线
是同一个值，槽位号才是撞车的原因）。最终改用**微秒级**时钟（`performance.timeOrigin + performance.now()`），
并把这条不变量做成确定性可测的形式：`nextSeqBase(固定输入)` 断言量级、`seqBase` 注入两个"不同启动时刻"
的 reporter 断言跨运行严格递增。**这个洞不是推演出来的，是测试逼出来的** —— 值得记一笔。

### 端到端验证（真实插件 + 真实 herdr 服务）

用真实 `createHerdrPlugin()`（真 runner = spawn/spawnSync）打到真实 `herdr`：

| 场景 | 结果 |
| --- | --- |
| 先埋「上次残留水位线 `seq=500` 的 working」 | pane 停在 `working`（复现用户症状） |
| 启动插件（`core.harness.start`） | 0.6s 内状态被改写（`done`）、1.9s 流式后 `working` ✅ |
| 发 SIGTERM | 进程按信号语义退出 + pane 变 `agent=(无) status=unknown` ✅ |
| 走 `process.exit(0)`（/exit 路径） | pane 干净（`agent=(无) status=unknown`）✅ |

**顺带实测**：herdr 侧栏把 `working → idle` 的转换显示为 **`done`**（"做完待查看"，你看过才消失），
`done` 不在 `report-agent --state` 的合法值里 —— 它是 herdr 自己的 rollup 状态。所以「上次残留 working」的
pane 启动时会显示 `done` 而不是 `idle`，这是 herdr 的状态机，不是本插件的 bug（已在插件注释里写明）。

**验证**：herdr 包 26 个用例全绿（新增 8 条：序号基线量级/跨运行单调、release 必须带更高序号、
shutdown 顺序与同步性、启动上报、信号注册与卸载、信号重发）；全仓 typecheck 0 错误；全量测试 1530 pass / 0 fail。

**教训**：外部集成的契约**以真机为准**。这次三处都是"官方原文没写 / 例子与实现不一致"的地方：
release 要带 `--seq`（文档示例不带）、水位线跨进程存在（文档只说"同 source 旧序号被忽略"）、
信号退出不触发 'exit'（Node/Bun 通病但容易被忘）。三处都是**静默失效**，读代码看不出来 ——
能真机验就别只读文档。

## 2026-09-19（续 157）hook 名加层前缀 `core.` / `cli.`，并补上一直"只声明没接线"的 `core.permission.check`

用户要求：「不同层的 hooks 增加对应层前缀，识别当前项目中的 hooks 命名问题并优化」。

续 156 已经按层**拆**过 hook（`agent.stream` / `agent.turn.end`），但两条名字仍共用 `agent.` 这个域 ——
消费方读名字依然看不出"这条是谁发的"。**拆了却没有留痕**：当时靠契约注释和回归测试去守，
而注释管不住下一个人。这次把层直接写进名字。

### 新规范：`层.域.动作`

| 层 | 语义 | 触发方 | hook |
| --- | --- | --- | --- |
| `core.` | 引擎层：**任何宿主都有**（CLI / 库内嵌 / ACP 宿主） | core | `core.harness.init` / `core.harness.start`、`core.tool.*`、`core.llm.*`、`core.prompt.*`、`core.session.*`、`core.permission.check`、`core.agent.turn.end`、`core.bus.event` |
| `cli.` | CLI 宿主层：只有走 CLI 的宿主才有 | cli | `cli.agent.stream`（UI 状态流）、`cli.command` / `cli.commands`、`cli.mcp.configure` |

判层判据一句话：**"没有 UI 的宿主里这条还会触发吗？"** 会 → `core.`，只在有 UI 时 → `cli.`。
（选 `core.`/`cli.` 而非 `engine.`/`ui.`：贴合上一轮"core 层与 cli 层要区分开"的原话，且与发包一一对应、可直接 grep 到 owner。）

### 重命名映射（硬改名，不留旧名别名）

| 旧名 | 新名 | 触发层 |
| --- | --- | --- |
| `harness.init` | `core.harness.init` | core |
| `harness.start` | `core.harness.start` | core |
| `tool.pool.assemble` | `core.tool.pool.assemble` | core |
| `tool.pre.execute` | `core.tool.pre.execute` | core |
| `tool.post.execute` | `core.tool.post.execute` | core |
| `llm.params` | `core.llm.params` | core |
| `llm.headers` | `core.llm.headers` | core |
| `prompt.system.transform` | `core.prompt.system.transform` | core |
| `session.compacting` | `core.session.compacting` | core |
| `session.preModel` | `core.session.preModel` | core |
| `permission.check` | `core.permission.check` | core |
| `agent.turn.end` | `core.agent.turn.end` | core |
| `bus.event` | `core.bus.event` | plugin 注册表（见下"取舍 ②"） |
| `agent.stream` | `cli.agent.stream` | cli |
| `mcp.configure` | `cli.mcp.configure` | cli |
| `cli.commands` / `cli.command` | **不变** | cli（本来就是唯一自带层前缀的） |

改名落点：`packages/**/*.ts` 的**带引号字面量**（hook key / `Hooks['x']` 索引 / `trigger('x')`）全部机械替换；
注释与文档里的**裸词**另跑一遍，并加了"不后随 `(`"的保护 —— `await harness.start()` 是 Harness 的**方法**，
与 hook `core.harness.start` 是两回事（这条区分也写进了契约注释）。实测只有 2 处会被误伤，都被保护挡住。

### 顺带修掉的三个命名/契约问题（都不止是"名字难看"）

**① `mcp.configure` 从来没被声明过。** 插件（mcp-server-registry）注册它，CLI 用
`(harness.plugin as any)?.trigger?.('mcp.configure', ...)` 调它 —— **hook 名写错也不会编译报错**，
`as any` + 可选链把两个保护都关了。现补进 `Hooks` 为 `cli.mcp.configure`，CLI 改强类型调用。
契约层为它加了 `McpConfigureInput` / `McpServerConfigLike`：字段与 `@harness/mcp-client` 的
`McpServerConfig` 结构一致但**刻意不 import mcp 包**（契约层只依赖 bus，不能反向依赖插件包），
新增字段须两处同步，消费方 mcp-server-registry 负责收窄。

**② `permission.check` 只声明、从未触发 —— herdr 的"等待用户决策"上报静默失效。**
`resolvePermission` 只走 `engine.check()` →（必要时）`engine.ask()`，中间没有 trigger。
现接线在 **check 之后、ask 之前**：这个位置是刻意的，只有此刻 `decision.behavior` 还可能是 `'ask'`，
消费方才能分辨"真会弹窗"与"规则已记住、不会弹窗"；放到 ask 之后就永远看不到 ask 了。
语义：插件可把 behavior 改成 allow/deny（直接采纳、不再询问），也可写 `updatedInput`（补回给 pipeline 重写工具入参）。
新增 `packages/core/src/permission-hook.test.ts`（**不 import CLI**，5 条）：载荷正确、hook 早于 ask
（改成 allow 后 ask 一次都不发生）、updatedInput 被采纳、allow/deny 路径同样触发。

**③ core 组装工具洋葱管道时在摸插件管理器的私有字段。** `(this.plugin as any).hooks?.listFor('core.tool.pre.execute')`
绕过了类型。`PluginManager` 新增公开只读 `listHooks(name)`，core 三处 `as any` 一并去掉；
顺带把 `(this.plugin as any).trigger(...)` 收口成 `bindTrigger(plugin)` ——
`trigger` 是类方法，实现里读 `this.hooks`，**直接把方法引用传出去会丢 this**，这是原来必须写 `as any` 的原因。

### 三处刻意的取舍

- **doom-loop 的重复确认不挂权限 hook**：它是独立闸门（同一工具+同一入参连续 N 次），且放行后工具仍会走
  pipeline 再触发一次 hook ⇒ 挂上去会让消费方**双报**（正是续 156 那个"同一轮计两次"的老坑）。
  宁可漏一个边界，不造重复计数；这一条已写进 AGENTS.md 与 hook 契约注释。
- **`bus.event` 归 `core.`**：它既不是内核业务、也不经 `trigger`（由 plugin 管理器桥接 `bus.subscribeAll`，
  卸载时自动退订）。两前缀词表里取更近的一侧，并在注释里写明它与别的 hook 机制不同 ——
  宁愿"不完全贴切但只有两个前缀"，也不要为它开第三个。
- **历史日志不回改**：`development-log.md` 的既有条目（含续 156 那张表）保持原名 —— 那是当时的记录，
  回改反而抹掉"名字曾经分不清层"这条教训。参考文档（architecture / 各 plan / workspace-management 等）
  已全部同步到新名；架构文档里顺带删掉了两个从未存在的 hook（`provider.auth`、`prompt.tools.transform`）
  与一个不存在的 `session.message.created`，并注明"权威定义见 `packages/plugin/src/index.ts`"。

另外记一笔：`docs/agent-harness-architecture.md` 的 `Hooks` 清单此前与实现已经漂移（列的 3 个 hook 根本不存在），
说明**文档里的接口草图迟早会烂**。这次的做法是让文档注明权威来源，并把清单与实现对齐一次。

**验证**：全仓 36 包 typecheck 0 错误；测试 **1522 pass / 0 fail**（core 87、cli 361、plugin 42、memory 58、
subagent 114、mcp-server-registry 11、herdr 18 …），其中 core 新增 5 条权限 hook 守卫。
已知既有问题（本次未动）：`@harness/permission` 没有任何测试文件，`bun test` 在该包报 "No tests found!" 并退 1，
使根 `bun run test` 退出码为 1 —— 与本次改动无关，按 AGENTS.md"每模块必须有 `src/index.test.ts`"应补。

## 2026-09-19（续 156）hook 分层：引擎终态独立成 `agent.turn.end`，不再借用 `agent.stream`

用户看上一轮的改动时点出一句：「core 层插件名与 cli 层插件名要区分开」（随后补明确：说的是
hook 名 `agent.stream`）。这是对的 —— 我上一轮把引擎终态塞进了 **UI 消费层的通道**，而
`agent.stream` 的契约注释里早就写着「触发点是 UI 消费层（REPL / TUI / run），不是引擎」。
一条被自己文档否掉的做法，当天就踩了。

**问题到底出在哪**：hook 名是一个**命名空间**。`agent.stream` 由 CLI 触发时，携带的是
"归约后的 UI 状态"；我让 core 也往里发一条 turn_end，于是：

1. 同一个 hook 名出现两个来源，消费方**无法分辨"这条是谁发的"**（只能靠猜字段形状）；
2. 语义被污染：那条 turn_end 是引擎事实还是 UI 状态收尾？两者寿命不同（引擎那条在任何宿主都有）；
3. 上一轮为此打的补丁（"CLI 停发 turn_end"）本质是用**行为约束**去补**命名缺陷** ——
   一旦有人忘了这条约束，同一轮就被计两次。

**改法：按层拆成两条 hook，而不是让一条 hook 兼容两层。**

| hook | 层 | 谁触发 | 载荷 | 消费方 |
| --- | --- | --- | --- | --- |
| `agent.stream` | **UI 消费层** | CLI（`createProcessLine` / `run`） | 归约后的状态快照（`eventType` + `status` + `sessionId`） | herdr 侧栏、TUI 类外部 UI |
| `agent.turn.end` | **引擎层** | core（`queryStream` / `query()` 收尾） | 引擎事实：`agentId`/`agentName`/`mode`/`sessionId`/`step`/`finish`/`aborted` | 记忆的按轮计数；任何"每轮必须发生"的逻辑 |

- CLI **恢复**广播 `turn_end`（回滚上一轮的"停发"补丁）：UI 收 busy/idle 本来就靠它，
  两条通道分开后不存在重复计数。
- core 改发 `agent.turn.end`，且**不再带 `phase: 'idle'` 这种 UI 词汇** —— 引擎只说事实
  （跑了几步、末步 finish、是否被中断）。
- 触发范围改为**包含子 Agent 的轮**：引擎不该做"哪一轮算用户的轮"这种消费侧判断，
  要不要筛由消费方按 `mode` / `sessionId` 决定（记忆侧两条都筛）。
- 回归守卫（`packages/core/src/agent-turn-end.test.ts`，**不 import CLI**）：除了断言
  `agent.turn.end` 恰好一次且字段正确，还断言 **`agent.stream` 一条都没有** —— 把"引擎不碰 UI 通道"
  钉成测试，而不只是注释。

**记忆插件的两处调整**：按轮计数改挂 `agent.turn.end`（并跳过 `mode === 'subagent'`）；
ACP 压缩识别仍只能挂在 `agent.stream` 上 —— 于是留下一个**同类的已知缺口**：
无 UI 宿主里压缩信号也收不到，那时只剩"轮数兜底 + 命令写入"。要根治得让引擎层也有"工具执行"信号，
已记进计划 §3.7 ⑦（与 F3 的"工具序列统计"是同一件事，将来一起做）。

**教训（值得单独记）**：新增/复用 hook 前先读它的契约注释里写的**触发层**；
"某条事件由谁发"是契约的一部分，不能因为"能发"就往里发。上一轮的错误正是"能发"——
core 恰好持有插件管理器，于是顺手就发了。

**验证**：全仓 typecheck 0 错误；core 82、cli 361、memory 58 全绿；
其中 memory 新增两条专门守分层：UI 通道的 turn_end **不计数**、子 Agent 的轮**不计数**。

## 2026-09-19（续 155）turn_end 广播收口到 core + memory 参数可配 + 三处"防误判"补丁

起因是两句提问：「配置里的 5 轮是 5 轮对话还是 5 次模型调用？」「记忆没刷新的话，模型会认为
记忆没生效吗？」——查证过程中发现三件比原问题更要紧的事。

**先答问题（顺便把语义写进注释与 `/memory` 输出）**

- 「5 轮」= **5 次 `turn_end`** = 5 次完整 `queryStream`（一次用户输入跑到跑完），**不是** 5 次
  模型调用：`done` 每步一条、`turn_end` 只在 `finally` 收一条（core:1834）。一轮内多步只算 1。
- 模型**看不见"没刷新"**：`system` 是快照，文件才是真相。真风险不是"模型以为没生效"，而是它
  看不到自己刚写的那条 ⇒ 可能判断"没写成功"而重写（近似重复条目会堆积）。

**① `turn_end` 的广播归属从 CLI 收口到 core（本次最重要的一处）**

原先前全仓只有两处广播（`createProcessLine` / `harness run`）——**都在 CLI 里**。也就是说，
以库内嵌、或宿主（ACP）自己消费事件流时，插件**永远收不到整轮结束**：靠它驱动的兜底（记忆攒批
放行）会静默失效，而且是"什么都没发生"式的失效，极难排查。

- core：`queryStream` 的 `finally` 里广播 `agent.stream`（终态是引擎的事实，不该由宿主代劳），
  带 `sessionId` + `status{agentId,agentName,mode,phase,step,finish,aborted}`（finish 取自
  循环内保存的末步 `outcome` —— 原先那个位置根本拿不到）。
- 子 Agent **不发**（它的"轮"不是用户的轮，且另开 session 会污染按会话计数的消费方）；
  其余模式照发，消费方可用 `status.mode` 自筛。
- CLI 两处**停发** `turn_end`（否则同一轮被计两次，记忆的攒批计数直接翻倍）。归约照做——TUI 要用。
- 回归守卫：《core 侧广播》（3 例，不 import CLI）+ CLI 侧断言"`turn_end` 只出现一次"。

> ⚠️ **本节 ① 的做法在续 156 被修正**：当时把引擎终态写进了 `agent.stream`（UI 通道），
> 造成同一个 hook 名由两层分别触发。现已改为独立的 `agent.turn.end`，CLI 恢复在
> `agent.stream` 上广播 `turn_end`（UI 收 busy 靠它）。下面这段历史记录保留原样。

**② 三处"防误判"补丁（对应提问的第二问）**

| 补丁 | 治什么 |
| --- | --- |
| `<memory>` 段声明"这是**快照**，怀疑过期请 `read` 对应文件" | 模型判断不了"我写的生效没有"，给它自证手段 |
| 沉淀提示加"**先 `read` 一眼**确认这条还没有" | 防重复追加（快照里可能还没有刚写的条目） |
| 截断提示从"去读全文"改成"**先合并/删除冗余再写**" | 截断是保留前 N 行 ⇒ 只追加永远读不到（治"只写不清理"） |

顺带确认一个此前没注意到的**不对称**：硬规则（去重/超限拒绝）只覆盖 `/memory add` 命令路径，
模型用 `write` 工具改索引时**不经过** `MemoryStore` —— 这条只写在代码注释里容易被忘，已写进 README。

**③ 攒批默认 5 → 15 轮，并且可以配了**

- 默认 15：它是"防静默失效的兜底"，不是节流目标（正常发布由压缩触发，那时 system 变更免费），
  所以只需"大到平时不抢先、小到长时间不压缩也能生效"。按一轮 1~3 次模型调用估，15 轮 ≈ 几十次调用内。
- **参数怎么配**（原先无处可配：内置插件工厂刻意"一律不传参"，要为 memory 加一段）：
  `config.json → memory.{flushAfterTurns, maxLines, maxBytes, disableInjection}`。
  启用仍是 `plugins: ["memory"]`；写了段却未启用会告警。装配点刻意放在「外部插件目录之后、
  注册表声明之前」，保住"外部插件目录优先"的既有语义（与 compression → acp-context 同一模式）。
- 校验（`checkMemoryConfig` + `memoryPluginOptions`）不是形式主义：这段配置**错了不报错**——
  键名拼错被静默忽略；`flushAfterTurns` 传成字符串（JSON 无类型保护）会让 `dirtyTurns >= flushAfter`
  恒为 false ⇒ **兜底永不触发**，表现是"改了记忆好多轮都不生效"。故非法值一律丢弃并告警，
  概览里还会打印最终生效的参数。

**④ 一个真 bug：缓存戳精度（被自己的测试咬出来）**

排查一条失败用例时发现读到的还是旧内容 ——根因是 `MemoryReader` 的缓存戳用 `mtimeMs + size`，
而「**同毫秒内写入 + 内容字节数相同**」会被判成"没变"，缓存返回旧内容。改为 `mtimeNs`（纳秒）。
现实中最容易踩的正是模型 `write` 重写等长条目。已补一条针对性用例（等长改写连做三次）。

**顺带确认的一个设计事实**：`dirty` 只在**注入时**算出 ⇒ 兜底计数从"变更被某次注入发现"之后才开始
（真实链路里就是下一轮开头那一次）。测试里漏了这一步会误判成 bug——记在这里免得下次再撞。

**验证**：全仓 typecheck 0 错误；core 82（+3 广播）、cli 361（+13 memory 配置）、memory 56（+7）；
其中含真装配端到端：`config.json → memory 段 → /memory` 打出的上限与轮数确实是配置值。

## 2026-09-19（续 154）记忆能力 M3：分级注入（flush 双源）+ 压缩时提示沉淀

M3 做两件在 M2 时特意推迟的事（当时理由是"变更本就低频、而分级注入会让生效时机不可预期，
宜与 flush 双源一起做"），现在条件齐了：`agent.stream` hook 已在，且 M2 的 mtime 缓存语义已稳定。

**分级发布 `MemoryPublisher`（§3.7 落地）**

```
内容有变 → 不立即换 system，而是标记 dirty、继续用旧内容
         → 直到以下任一信号：
             ① 发生压缩（ACP compress 工具 / session compaction）⇒ flush（搭车，边际缓存成本≈0）
             ② 攒够 N 轮（默认 5，`turn_end` 计数）⇒ flush（兜底，防"永远等不到压缩"）
             ③ 显式写入（/memory add|rm）或 /memory reload ⇒ flush（用户有即时预期）
             ④ flushAfterTurns: 0 ⇒ 关闭攒批（等价 M2 行为，测试用）
```

- 首次注入必须立即发布（否则永不注入）——**不变的铁律**。
- 内容**变回**已发布状态时清除 dirty（例如用户撤销了编辑）：否则会带着一个永远不会被发布的
  状态空转、并在攒够轮数后白发布一次。这条是**测试抓出来的**（我最初只写了 `dirty = true`）。

**flush 双源怎么识别（一个实查出来的约束）**
`tool.post.execute` 的 ctx **没有 toolId** ⇒ 无法用它识别 `compress`。改用 `agent.stream` 的
`status.toolId`（M1 之前刚加的字段正好派上用场）：`eventType === 'tool_call_start' &&
status.toolId === 'compress'` ⇒ ACP 压缩。session compaction 则由 `session.compacting` hook 覆盖。
两者都触发 flush + 一次性沉淀提示，覆盖"ACP 开 / 关"两种状态（§3.8 的结论在此落地）。

**压缩时提示沉淀（L2 → L1）**：`buildReflectionHint()` 生成一次性提示，指引模型把值得长期保留的
纠正/决策**用 write 工具追加到记忆索引**，并明确"只在确有值得记的内容时才写"（避免为完成提示
制造垃圾记忆）。它搭在压缩这一时机上 ⇒ 额外的 system 变更是**免费**的（缓存已失效）。

**顺带**：`/memory` 的 list 现在显示注入时机与"是否有未发布变更（已积 N 轮）"，便于排障。

**验证**：memory 49 例（+12：分级发布器 6 + 提示文本 1 + 插件级 5，覆盖"外部改动攒批不立即生效"、
"ACP 压缩触发 flush 且提示只出现一次"、"session compaction 触发 flush"、"攒够轮数兜底放行"、
"命令写入是例外：不参与攒批"）；全仓 typecheck 0 错误；cli 全绿。

至此记忆能力的 M0~M3 全部落地。**未做**：技能锻造（F0~F3，独立一条线）。

## 2026-09-19（续 153）记忆能力 M2：写入路径 + 三条硬规则

M2 做"写入与校验"。**分级注入（§3.7）本轮刻意未做**，理由见下。

**`MemoryStore`（写入内核）**，三条硬规则：

1. **超限即拒绝且不落盘** —— 先预演新内容再校验行数/字节，超限直接返回 `over-limit` 且文件不动。
   这条直接对治 Claude Code 的坑（写入成功、下次加载被丢弃，全程无声）。
   验收方式是"写入前后读文件比对"（测试里断言内容逐字未变）。
2. **去重** —— 空白归一化后完全相同 ⇒ `duplicate`，不重复追加（反复"记住同一件事"不该撑爆索引）。
3. **原子写** —— 临时文件 + `rename`，避免中途崩溃留下半截索引；测试断言不留 `.tmp-` 残留。

条目格式统一 `- 内容`（一行一条），`parseEntries` 只认该前缀 ⇒ 标题/空行/其它 Markdown 结构不受影响。

**命令**：`/memory add [user|project] <内容>` · `/memory rm [user|project] <序号|内容>` ·
`/memory reload`（清缓存强制重读）· `list` 改为展示条目编号 + 逐级预算（写入前自查额度）。

**一个反直觉但必要的细节**：命令写入后**必须显式 `reader.clear()`**，不能依赖 `mtime` 缓存自动失效
—— 同一毫秒内的写入 mtime 可能不变。测试「rm 后下一轮注入立即读到」正是盯这条。

**默认写 user 级**：项目级记忆会随 git 提交（决策 B7 明确要共享），所以 `add` 不指定 scope 时
写 user，避免"随手记一句个人偏好"被提交进仓库。

**模型侧写入**走计划 §3.5 的方案 A：模型用既有 `write` / `edit` 工具改 `MEMORY.md`（走常规权限
审批，格式同为 `- 一行`），下一轮注入即生效 —— 与我们刚做好的 `mtime` 失效语义天然衔接，
故 M2 不再新增 `memory_write` 工具。

**为什么分级注入（§3.7）留到下一步**：它的收益是"把 system 变更搭车到压缩那一刻"，但当前
`MemoryReader` 的 mtime 缓存已经保证"**文件不变 ⇒ system 逐字不变**"，也就是说只有"真的写了内容"
才会变更一次 —— 变更本就低频。而它的代价是让"写入后何时生效"变得不可预期（要等压缩，可能数轮），
需要配套兜底与提示。**建议与 M3 的 flush 双源一起做**，届时用真实使用数据判断是否值得。

**验证**：memory 37 例（+13：写入内核 7 + 写入命令 5 + **1 条端到端**「`/memory add` 写入 →
下一轮 queryStream 的 system 里真的出现该条目」）；全仓 typecheck 0 错误；core 79 / cli 348 全绿。
`list` 用例按新输出格式更新（契约变更，而非回归）。

## 2026-09-19（续 152）记忆能力 M1：补插件路径通道（G1/G2）+ 新建 `@harness/memory` 插件

M1 = 读路径（加载 + 注入 + `/memory` 命令）。计划 §9 指出插件化前必须先补两处"只读视野"通道，
本次一并落地。

**G1：`PluginContext.workspace`（插件终于能知道路径）**
此前插件在 `install(ctx)` 与每轮 hook 里都拿不到工作区路径，只能 `process.cwd()` 猜 —— 而 CLI 支持
`--cwd` / `--data-dir` ⇒ 必然拼错目录（本项目已两次栽在路径口径分裂上）。三处改动：
- `@harness/plugin`：新增 `PluginWorkspaceView`（**结构化最小接口，刻意不 import `@harness/workspace`**
  —— 该包依赖 `@harness/session`，契约层要保持"只依赖 bus"的轻量依赖方向）；`PluginContext.workspace?`
  与 `PluginManagerOptions.workspace?`
- `core`：`AgentHarnessOptions.workspace?`；`createPluginManager({ workspace: options.workspace ??
  resolveWorkspace({ cwd: options.cwd }) })`
  ⚠️ 这里踩到一个**真坑**：初版写的是 `resolveWorkspace({ cwd: this.cwd })`，而 `this.cwd` 在**本行之后**
  （:2376）才赋值 ⇒ 运行时是 `undefined`、静默退回 `process.cwd()` —— **恰好造成注释里声称要避免的
  口径分裂**（typecheck 不报错，只有实测才暴露）。改用 `options.cwd` 后实测确认
  `ctx.workspace.cwd = /tmp/probe-cwd`（等于传入 cwd，而非 process.cwd()）。
- `cli`：boot 时传 `workspace: this.workspace`（含 `--data-dir` 的实际取值）

**G2：`PromptInput.agentMode`**
决策 B6 要求"主会话记忆不注入 subagent"，但注入 hook 只给 `agentId` —— 插件无法判断模式（`agent.stream`
的 `status.mode` 能拿到，但晚于注入）。core 在构造 `promptIn` 时带上 `agent.mode`。

**新包 `@harness/memory`（M1 读路径）**
- L0 项目指令：`<cwd>/AGENTS.md`（项目）+ `<dataDir>/AGENTS.md`（用户），上限 32KB
  —— 补上了"仓库根有 AGENTS.md 但从来没被加载过"这个长期缺口。
- L1 长期记忆：`<scope>/memory/MEMORY.md`，**前 200 行 / 25KB**（对齐 Claude Code auto memory 的
  实测量级）；主题文件不预载、由模型按需 `read`。
- 注入走 `prompt.system.transform`，包装成 `<memory>` 段并声明"只在相关时遵循、不要复述"
  —— 这条路径的 system 消息**没有 `<acp>` ref 标签**，因此 ACP 无从压缩它（实证见计划 §3.4）。
- **截断是显式的**：超限时在片段里写明"因行数/字节上限被截断，完整内容请读该文件"
  （Claude Code 的坑：写入成功但下次加载被丢弃，全程无声）。
- **缓存友好**：`MemoryReader` 按 `mtime + size` 缓存 ⇒ 文件不变则渲染结果逐字相同 ⇒ 前缀缓存不受
  影响；文件被外部编辑时下次 hook 即失效读到新内容。
- 硬约束：**全部文件不存在 ⇒ 完全不注入**（零噪声）；**无 workspace 视图 ⇒ 返回空 Hooks**
  （宁可不做，也不靠猜路径）；`agentMode === 'subagent'` ⇒ 不注入。
- `/memory list | show <user|project|instruction> | path`（写入能力留到 M2）。

**验证**：memory 包 24 例（21 单测 + **3 条真实链路端到端**：用 `createHarness` + 探针 Provider
捕获请求体，断言主 Agent 的 system 里真的出现 `<memory>` 与索引/指令内容、**subagent 的请求里不含
记忆**、空索引时不注入）；全仓 typecheck 0 错误；core 79 / cli 348 全绿；
`unknownBuiltinPluginIds(["memory"])` 为空 ⇒ 声明式启用路径可用。

**下一步 M2**：写入路径（`/memory edit` 等）+ 体积/去重校验 + §3.7 的分级注入（显式立即 /
自动攒到下次压缩 flush，flush 双源：`tool.post.execute` compress + `session.compacting`）。

## 2026-09-19（续 151）记忆能力 M0：workspace 落地 memory 目录字段

[记忆能力与技能锻造计划](memory-and-skill-forge-plan.md) 的 M0。原 M0 有两件事，其中"验证记忆
会不会被 ACP 压缩"已提前完成（续 150 之后单独提交 `a51c683`，结论：**不会**——core 合成的
system 消息没有 `<acp>` ref 标签，模型选不中它），故本次只做目录字段。

**改动**（`packages/workspace/src/index.ts`）：
- `WorkspaceLevel` 加 `memory`：`<root>/memory`（user 与 project 各一处）
- `Workspace.loadDirs` 加 `memory: [user.memory, project.memory]`，与 skills/agents 同序
  （user 在前、project 覆盖）
- 定位于"路径约定"：本包**只给路径、不预创建目录、不解析内容** —— 与 plugins/skills/agents
  完全一致（CLI 里本来就没有 mkdirSync 逻辑）。写入与加载由后续的记忆插件负责。

**一致性改动**（`packages/plugins/workspace-shell/src/index.ts`）：`/workspace` 的目录清单加
`memory` 行。顺手修掉一个**既有 bug**：`agents` 行只输出了存在标记、**漏了路径本身**
（`${existMark(l.agents)}` 后面没有 `${l.agents}`），plugins/skills 两行都是全的 —— 属纯展示缺陷。

**验证**：workspace 39（+1：记忆目录两级路径 + 断言目录未被预创建）、workspace-shell 17、
cli 348 全绿；全仓 typecheck 0 错误。`workspace.test.ts` 的 `level()` 定值断言按新契约更新
（这正是"契约变更必须同步测试"的正常代价，不是回归）。

**文档**：`docs/workspace-management.md` 的目录布局图 + 覆盖顺序表补 memory 行，并注明
"不预创建、由记忆插件负责"；计划文档 §3.9 的 M0 标记为完成。

**下一步 M1**：加载 L0（`AGENTS.md` 两级）+ L1（`MEMORY.md` 索引注入）+ `/memory` 命令（list/read）。
实现形态按 §9 走 `@harness/memory` 插件；需要先补 G1（`PluginContext.workspace` /
`PromptInput.cwd`）与 G2（`agentMode`，用于"不注入 subagent"）。

## 2026-09-19（续 150）Herdr 集成做成插件：`agent.stream` hook + `@harness/herdr`

上一轮做了 Agent 状态显示（UI 内），本轮把同一份状态也送到**外部终端复用器**
[Herdr](https://herdr.dev)（agent 感知的 tmux 竞品：侧栏显示每个 pane 在跑/空闲/等你批准）。
用户要求**做成插件**而非内嵌 CLI —— 状态上报属环境集成，与 CLI 主流程无耦合，插件化后
`plugins: ["herdr"]` 按需启用，不在 Herdr 里跑的用户零开销、零代码路径。

**唯一的引擎侧缺口：`agent.stream` hook。** 现有 Hooks 覆盖工具池/LLM 参数/prompt/会话/权限
/CLI 命令，但**没有任何流式事件入口** —— 而「现在在干什么」只存在于事件流里。新增：

- `@harness/plugin` 的 `Hooks['agent.stream']`，入参是**归约后**的状态快照（不是原始事件）。
  理由：原始 AgentStreamEvent 有十来种类型（text_delta / tool_call_start / done.step / turn_end…），
  让每个集成插件各自解释一遍既重复又容易分歧；归约器（CLI 侧 `agent-status.ts`，上一轮产物）
  已把语义算清楚，直接复用。
- 触发点在 **UI 消费层**（REPL / TUI / run 三处），不是在引擎内 —— 没走 UI 的调用方
  （如 subagent 的 `query()`）不触发，已在 hook 注释里写明这一边界。
- 刻意 **不 await**：每个 text_delta 都等一次插件链会把流式渲染拖成串行；代价是上报可能乱序，
  这正是插件必须带严格递增 `--seq` 的原因（Herdr 会丢弃同源旧序号）。

**插件 `@harness/herdr`（新包 packages/plugins/herdr）**，协议逐条对齐官方文档
（herdr.dev/docs/integrations「Integrate your own agent」）：

- 只在 `HERDR_ENV=1` 且 `HERDR_PANE_ID`/`HERDR_BIN_PATH` 齐备时生效，否则 install 返回**空 Hooks**
  （官方硬要求："keeps the integration a no-op outside Herdr"）。双保险：`optIn` 不声明不加载、
  声明了但不在 Herdr 内也不产生任何进程。
- 三态映射：thinking/streaming/tool → working；idle/aborted → idle（中断是回到等待输入，
  不是「等你决策」，故不是 blocked）；权限审批 → blocked。
- **blocked 只在决策确实是 `ask` 时才报** —— 规则已记住（allow/deny）时根本不会弹窗，报 blocked
  会制造假阳性（侧栏高亮但没人真的在等你）。
- 节流是**必需**而非优化：text_delta 每帧都触发 hook，一轮成百上千次，不节流既打满 CPU
  也让侧栏抖动；判定键 = state + sessionId + message。
- 退出要 `release-agent`（协议**没有 done** 态）交还生命周期权威，否则 Herdr 会一直认为该 pane
  归本 source 管。`release` 走**同步** spawn —— 进程 `exit` 钩子里事件循环已不再调度，异步等不到。

核实了一处上一轮的口述结论：官方文档确认 `--seq` **真实存在**且用于乱序防护（"If reports can
arrive out of order, include a strictly increasing `--seq`"），故实现里带上；同时确认
`--agent-session-id` / `--message` / `release-agent` 均属实。本机未安装 Herdr ⇒ 无端到端真机验证。

验证：herdr 包 18 例（环境探测 4 / 映射 2 / 命令构造 3 / reporter 5 / 装配 4，含「环境外零调用」
与「release 同步且幂等」两条不变量）；cli +1 端到端（真实 processLine 跑多步，断言广播确实发生、
末事件 idle+finish=stop、存在 step=2）；cli 348 全绿；全仓 typecheck 0 错误；
`unknownBuiltinPluginIds(["herdr"])` 为空且拼错仍报错 ⇒ 声明式启用路径正常。

## 2026-09-19（续 149）Agent 状态显示：把事件流归约成「现在在干什么」

自主多步上线后，用户最想知道的变成「跑到第几步、在跑哪个工具、是否被中断」——此前 UI 只有
"忙/不忙"两种状态（`●/○`）。新增 `packages/cli/src/agent-status.ts`：

- **纯函数状态机**：`reduceAgentStatus(prev, ev)` 把 AgentStreamEvent 归约成
  `{agentId/name/mode, phase, step, toolId, finish}`。抽成纯函数是为了能在无 UI 环境下完整单测，
  UI（TUI 状态栏 / REPL 统计行）只负责渲染。
- **phase 回落规则值得记**：工具执行完（`tool_call_result`）回到 `thinking` 而不是 `idle` ——
  此时模型仍在同一 Turn 内；只有 `turn_end` 才代表整轮结束。工具**失败**则留在 `tool` 态，
  便于显示"卡在哪个工具上"。
- **中断态不被冲掉**：`done.aborted` / `turn_end.aborted` 记为 `aborted`，后续 `turn_end`
  不会把它改成 `idle`（否则"已中断"会一闪而过）。中断后 `isAgentBusy=false`，UI 收起 spinner。
- **TUI 状态栏宽度约束**：整行需 ≤80 列（测试 renderer 固定 80 宽），靠**忙时让位**解决 ——
  忙时隐藏快捷键提示（此时也用不上），把这几列让给状态文本；闲时恢复。总长不超过原最长形态。
- **REPL 统计行**：`⏱️ xxms | agent=default · 第2步 · 结束=stop | model=…`。

验证：新增 9 例（8 条状态机纯单测 + 1 条端到端：真实 processLine 跑多步工具链，断言统计行含
"第2步/结束=stop"）；cli 347 全绿（TUI 状态栏改动无回归）；全仓 typecheck 0 错误。

## 2026-09-18（续 148）TUI 鼠标点击消息区后键盘失效修复

用户报告：鼠标点到消息框（消息区）后再敲键盘没反应，必须重新点击输入框。

根因（`@opentui/core` 渲染器）：对 left-button down 事件默认执行 **autoFocus** —— 从命中
元素向上找第一个 `focusable` 的 renderable 并 `focus()`。消息区文本（assistant 回复 /
thinking / 复制按钮等）都可聚焦，点击后焦点从 textarea 被抢走；React 层 `focused` prop
不变不会重新 focus，键盘输入就此失效。

修复（`packages/cli/src/tui.tsx`）：在根容器 `onMouseDown` 冒泡阶段统一处理——

- `e.preventDefault()` 阻止渲染器 autoFocus 抢焦点（autoFocus 条件为 `!defaultPrevented`）；
- 显式 `textareaRef.current?.focus()` 把焦点还给输入框（幂等）；
- **不影响既有交互**：拖选文本（startSelection）发生在 `dispatchMouseEvent` 之前，
  不受 preventDefault 影响；复制按钮 / thinking 折叠 / 侧栏 tab 等 onMouseUp 交互照常触发；
- 列表模式（Tab 导航）/ 帮助面板 / 审批模态期间不干预（让出键盘）。

验证：新增集成用例「鼠标点击消息区后键盘输入仍直接生效」（点击 assistant 文本后
直接敲字符进入输入框）；cli 338 用例全绿（+1），全仓 typecheck 0 错误。

## 2026-09-18（续 147）TUI 各块输出视觉区分 + thinking 推理块可折叠

用户需求：前端渲染更人性化地区分各块输出，thinking 块可折叠。改动（`packages/cli/src/tui.tsx`）：

1. **thinking 块可折叠**：新增 `collapsedThinking` 状态 + `toggleThinking`。
   - 默认**长推理（正文 > 160 字符）折叠成一行标题**：`▸ 💭 推理 · {前 52 字符摘要}…`
     （italic + dim + underline，可点击），避免长推理占屏；
   - 点击标题行展开/收起（`▾ 💭 推理` + 完整正文）；短推理与流式中的推理保持直接显示；
   - 流式中（`streaming`）不折叠，避免推理实时滚动时跳动。
2. **tool 块树状输出**：首行（工具调用）加粗，结果行加 `│ ` / 末行 `└ ` 竖线缩进前缀，
   与 system 命令输出在视觉上区分开。

验证：
- 新增 2 个集成用例（长推理折叠→点击展开→再点收起；短推理不折叠）；
- 排障中确认：mock provider 的 `reasoning` 字段可驱动 `reasoning_delta` 流式；
  长正文在 80 列帧中被 `wrapMode="word"` 折行，逐句/长串文本断言不可靠，改用
  `▸`/`▾` 标题切换 + 稳定帧（含 `最终回答`）断言交互闭环；
- cli 337 用例全绿（+2），全仓 typecheck 0 错误。

## 2026-09-18（续 146）TUI 同一输出多个「⧉ 复制」按钮修复

用户报告：一次 agent 应答的 TUI 输出里出现 4 个复制按钮。根因有二：

1. **`pushConsole` 只合并相邻同类块**，一次应答的多步工具调用（`🔧`/`✅`）被中间的 `💭` thinking /
   自述行打断，裂成多个 tool 块，每个都带复制按钮；
2. **`system` 块也带复制按钮**，导致 `⏱️ 耗时` 行、`<acp ...>tool` 这类旧版占位污染文本等
   状态/元信息各自生成一个按钮。

修复（`tui.tsx`）：
- `pushConsole`：system/tool 类块改为**向前跳过一个或多个 thinking 块**与上一个同类块合并，
  一次应答的多步工具输出归为单块，复制按钮只在整段末尾出现一次（thinking 独立保留可视）；
- `renderBlock`：`copyable` 排除 `system`（耗时行 / 元信息 / 占位文本不再出现按钮）。

验证：新增用例「tool 块跨 thinking 合并」；cli 335 用例全绿（+1），全仓 typecheck 0 错误。

## 2026-09-18（续 145）DeepSeek 官方文档确认回传规则 + 真实 barrier 链路实测通过

### ① DeepSeek 官方文档：`reasoning_content` 的确切规则（回应"为什么不复现 400"）

查官方 Thinking Mode 文档（`api-docs.deepseek.com/guides/thinking_mode`，`deepseek-flash` 正是文档示例模型）：

- **thinking 模式默认启用**（默认 effort=high）；
- 是否要回传 `reasoning_content` **取决于请求是否带 `tools`**（原文）：
  > "for requests carrying the `tools` parameter, the reasoning_content must be **fully** passed back
  > to the API in **all subsequent requests** — even for turns where the model did not perform a tool
  > call. If your code does not correctly pass back reasoning_content, the API will return a **400** error."
  - 带 `tools` ⇒ 所有后续请求必须完整回传历史各轮的 reasoning_content；
  - 不带 `tools` ⇒ 不需要回传，**传了也会被忽略**（不拼进上下文）。
- 旧版 `deepseek-reasoner`（不支持 function call）规则**相反**：输入消息里带该字段 ⇒ 400。

对本项目的意义：
1. **自适应设计被双重确认**：新规则要求"必须带"、旧 reasoner 要求"绝不能带" —— 两种端点相反的
   要求决定了"无条件带/不带都错"，按 400 探测 + 按 modelId 记忆是唯一稳妥解。
2. **为什么此前实测不复现**：探针构造的历史 assistant 是手工造的，模型从未在那些消息上**真实产生过**
   reasoning_content，服务端无从校验"曾产生但未回传"。真实报错发生在模型真实产出推理后的下一轮。
3. 两个已知缺口：**ACP 折叠可能截断历史 reasoning part**，与"必须**完整**回传"存在张力，
   重发兜底只补空串救不了"内容不完整"；thinking 模式下 `temperature` 静默无效（无害）。
   —— 其中 `thinking` / `reasoning_effort` **透传已在同日补上**（见下）。

**④ `thinking` / `reasoningEffort` 配置透传（同日补上）**

`config.json → providers[]` 新增两个可选字段（仅 openai 系消费，glm/qwen 复用实现自动获得）：

- `thinking: 'enabled' | 'disabled'` → 请求体顶层 `thinking: { type }`
- `reasoningEffort: string` → 请求体顶层 `reasoning_effort`（DeepSeek：minimal/low/medium/high/xhigh/max/ultra）

Agent 级可覆盖：`model.options.reasoningEffort` / `model.options.thinking` 优先于 Provider 配置。
**缺省一律不发送**（标准 OpenAI 不认识这两个参数，多传 400）；工厂映射处做取值校验
（`thinking` 只认 enabled/disabled，其余按未配置处理 —— ProviderConfig 有 index signature，
这里校验是唯一闸门）。测试 1 例覆盖三种形态（缺省不带 / 配置注入 / params 覆盖）。

**⑤ ACP 的 reasoning 往返修复（"完整回传"张力的真正根源，比预想严重）**

追查"ACP 折叠与完整回传的张力"时发现问题的真实形态不是"折叠截断"，而是**所有消息都丢**：

ACP 的 preModel 把**整段历史**经 `toCores → processTurn → requestMessages` 完全重建（不只折叠区，
保留区同样如此），而 adapter 此前把 reasoning part 拼进 text 视图（`<reasoning>\n...` 前缀）——
往返后 reasoning part **降级成 text part**，发给 DeepSeek 时进 `content` 而非 `reasoning_content`
字段。也就是说开 ACP 的会话里 `reasoning_content` 从来就没回传过，全靠自适应补空串兜底不炸；
推理文本混在 content 里，模型也拿不到结构化的思维链回传。

而内核 `reasoning-pairs.d.ts` 写明了契约：reasoning 应是独立的 `contentType: 'reasoning'` core、
紧跟它所属的 assistant text/tool-call 之前；压缩范围会把孤儿半边拉进来**成对**压缩（不拆散）；
且原文直说"**每个 adapter 都依赖这个往返契约来重建 reasoning_content**"。我们的 adapter 恰恰
违背了它。

修复（`adapter.ts`）：
- `toCores`：reasoning part 输出为独立 reasoning core（位于 tool/text core 之前，满足配对依据）；
  `renderText` 不再拼接 reasoning（避免重复计数）；
- `requestMessages`：reasoning core 并回**紧随的 assistant 消息** parts 开头 —— `reasoning_content`
  与 `content`/`tool_calls` 出现在同一条 assistant 消息（DeepSeek 官方样例形态；拆成两条消息
  是否被端点接受并无契约保证）；孤儿 reasoning 兜底为独立消息不丢内容。

效果：保留区/折叠区的 reasoning 结构化往返；DeepSeek 回传恢复；内核配对保护真正生效
（reasoning 与它的 tool-call 同进退，不会被拆开折叠）。

**回传张力的最终结论**：此修复后"完整回传"在结构层面成立；剩余的仅有内容层面 —— 被折叠轮次的
推理已压进摘要（不可恢复），但这与正文折叠同理，是压缩的固有代价而非缺陷。

验证：新增 `adapter.test.ts` 4 例（独立 core 顺序 / 并回 assistant / 往返不丢内容 / 孤儿兜底）；
acp-context 52（+4）全绿；bench 300K 自证点与基线逐位相同（纯文本剧本，符合预期）；全仓
typecheck 0 错误。

**⑦ 诊断会话中断：`[tool]` 占位文本污染历史，模型模仿后停止调用工具（已修）**

用户报告会话 s_1789516184627_g800t「输出到一半就中断」。落盘数据还原的完整链条：

- 会话里两段（间隔 8 小时）各出现 **5~6 条间隔仅几百毫秒的 assistant 消息**（真实推理轮次不可能），
  每步 tokenUsage.output 只有 25~124 —— 模型在快速输出占位符。
- 模型的 reasoning 自述："I keep outputting `[tool]` text instead of actual tool invocations"、
  "I've been stuck in a loop outputting `[tool]` placeholders"。
- 最后一步输出 `<acp tokens="4" ...>m00160</acp>\n[tool]\n[tool]`（连标签一起复读），**无工具调用**
  ⇒ finish=stop ⇒ 循环终止 —— 用户看到的「中断」。

根因：`renderText` 的兜底分支把 **tool part 渲染成 `[tool]` 占位**并塞进 text core —— 发给模型的
历史里，每条工具调用消息都跟着一段 `[tool]` 占位文本（同时还有真正的 tool-call core ⇒ 双重表示）。
模型（DeepSeek）看到历史里这种格式后**模仿**，开始在正文里输出 `[tool]` 而非发起真正的 function
call；一旦某步没有工具调用，S2 判据（无工具调用 ⇒ 终止）正确地结束了循环。这也是 agentic loop
上线后才会显性化的问题 —— 单轮时代模型模仿一次也就停了，多步循环让它连续退化 5~6 步、耗掉整轮。

修复：`renderText` 跳过 reasoning 与 tool（各自有专属 core，不进文本视图）。连带收益：纯工具消息
不再生成只含占位的空 text core。doom-loop 未拦住属预期：每次工具入参微调、中间夹纯文本步，
"连续 3 步完全相同"的步签名判据不命中（判据本身工作正常）。

验证：新增用例「text 视图不含 [tool] 占位」；acp-context 57（+1）全绿；bench 300K 自证点与基线
逐位相同；全仓 typecheck 0 错误。**旧会话已污染的历史不会自动痊愈**（模型模仿源已移除，但存量
`[tool]` 文本仍在），建议该会话 `/new` 或接受首几轮的质量折扣。

**⑥ 内核契约全面核对（reasoning 修复引发的系统性排查）**

对 acp-kernel 的全部公开契约（34 个 .d.ts）与我们 import 的 API 面逐组核对，新发现 4 处、确认 5 处正确：

- **P1 core id 位置漂移（已修）**：`toCores` 的 core id 用跨消息累加计数器（`base#0/#1/…`），
  同一条消息在全量历史与窗口切片（runCompacting 会重新 toCores）里会得到**不同 id** ⇒
  块的 `effectiveMessageIds` / `coveredMessageIds` 幂等判定失效（同一窗口重复折叠、ref 重复分配）。
  修复：id 改为 `base#(r|t|x)partIdx` —— 只依赖消息自身（part 类型 + 消息内序号），跨调用稳定。
- **P1 状态水合浅展开（已修）**：`{...createInitialState(), ...saved}` 会让旧存档的
  `nudge`/`stats` 嵌套对象**整体替换**新默认 ⇒ 内核升级后加的字段（如 `nudge.lastShownByTier`）
  水合后缺失、功能静默失效。改为嵌套键二级合并（`messageRefs`/`tokenSnapshot`/`nudge`/`stats`）。
- **P1 prompts 绕过 resolvePrompts（已修）**：契约要求任何覆盖必须 `acknowledgeRisk: true`
  （所有 Prompts 字段 load-bearing，是防呆设计），且只有 string 值生效。我们此前手工合并
  零门槛生效。已改走 `resolvePrompts`。遗留注意：filePrompts 是内核默认的本地快照，
  内核升级后若 txt 未同步会以旧规则覆盖新规则。
- **P0→已知权衡：`read_file` 不在内核 NEVER_PRESERVE_RECENT 名单**：内核按工具名硬编码匹配
  （`read`/`bash`/`decompress`/`search_context`），本宿主读文件工具叫 `read_file` ⇒ 名单失配，
  刚读的大文件结果会落入 preserveRecent 软保护区（保护区被撑大、该内容暂不可回收）。
  内核名单**无配置口**，宿主侧无法修复；且权衡并非单向（刚读的文件本就是活跃工作集，
  不被立即压掉也有价值）。缓解建议：对 read 频繁的大输出场景开启 `compression.config.truncate`。
- **确认正确**：`thinkingTokens` 恒 undefined 无实质影响（reasoning text 走 core.text 正常计数，
  口径一致）；`assignRefs` 的 `nextIndex` 经 `highestUsedIndex` 正确延续；compress/decompress/
  search_context 工具名与内核 ALWAYS_PROTECTED / NEVER_PRESERVE 名单逐字匹配；
  `parseCompressInput` 签名与 `compress-tools.d.ts:81` 一致；autoTune 对 tiers/minSummaryLength
  的覆盖属有意 bench 值而非漏传。
- **有意取舍已注释**：`renderTags: 'text-only'`（ref 标签不进工具输出，避免污染其内容语义；
  代价是模型看不到工具结果的 ref，压缩范围只能用相邻文本消息的 ref 近似表达 —— 原先无注释）。

验证：acp-context 56（+2：core id 稳定性 / 水合二级合并）全绿；bench 300K 自证点与基线逐位相同；
全仓 typecheck 0 错误。

### ② 真实 barrier 链路实测通过（S4 的最后一项未闭环）

新增 `packages/cli/src/barrier-integration.test.ts`（2 例，cli 全包 334）：与既有用例（手工
enqueue/publish 单环验证）不同，这里走**真实插件链**——subagent 工具真的后台派发、coordinator
真的计数集齐、事件真的从 `subagent.completed` 链式触发，覆盖三层职责的全部接缝。

**时序实证**（此前只有源码推导）：`bus.publish` 同步调用订阅者（bus:177，async 包装无前置 await），
而 subagent 的 `bus.publish(completed)`（:834）排在 `enqueueNotification`（:864）**之前** ⇒
测试断言 CLI 收到 `<continue/>` 的瞬间 `peekNotifications()` 为**空**。若 CLI 同步决策就会把
真正的后台结果误判为空转、整条吞掉 —— S4 空转识别里"让出宏任务再 peek"不是过度设计，是必要的。

**端到端行为**：后台任务集齐 → 真实注入 `<continue/>` → 续轮真实发生（模型再被调用、通知 drain
注入上下文、无"跳过"提示）；对照用例：前台（非后台）派发不触发 barrier（无事不扰）。

S0~S4 评审时挂起的"真实 barrier 全链路未验证"至此闭环：双重驱动不会发生，三层协同正常。

## 2026-09-18（续 144）对 agentic loop 全线的独立代码评审：1 个 P0 + 5 个 P1

对最近 9 个提交（agentic loop S0~S4 + 三处修复）做独立评审。方法沿用上次的结论：**派子代理读代码、
自己复核关键项**。这轮抓到的问题里有一条是**我自己上一轮引入的回归**，且净效果是安全性下降。

### P0：沙箱「重定向裸设备」正则改出了更大的漏报（我上轮引入）

上一轮修 `echo x > /dev/sda` 漏报时，把规则从 `\b>` 改成 `(?:^|\s)>>?`，并加了测试固定
「空格形态能被拦」。**测试通过了，但覆盖是片面的** —— 实测（`bun -e` 逐个跑正则）：

| 命令 | 旧 `\b>` | 上轮改后 | 修正后 `\d*>>?` |
|---|---|---|---|
| `echo x > /dev/sda` | 放行（原漏报） | 拦截 | 拦截 |
| `echo hi>/dev/sda` | 拦截 | **放行** | 拦截 |
| `echo x 1>/dev/sda` | 拦截 | **放行** | 拦截 |
| `cat f 2>/dev/nvme0n1` | 拦截 | **放行** | 拦截 |

即：修好一种形态的同时，把 `> ` 左侧是「fd 数字」或「无空格」的形态全放行了 —— 而这些原本能拦。
根因是**用左侧字符类去约束 `>`**，两种写法各漏一半。正解是不限定左侧：`\d*>>?`（0 个或多个数字）。

根因反思：改安全规则时只补了「已知漏报」的用例，**没有反过来跑一遍"原本能拦的都还能拦吗"**。
后者才是这类改动的主要风险面。

### P1：删 `/dev/sda` 字面量后，非重定向的毁盘命令无人管

`shred -n1 /dev/sda`、`wipefs -a /dev/sda`、`mkfs -t ext4 /dev/sda1`（`\bmkfs\.\w+` 要求带点，
`mkfs -t` 不匹配）、`parted /dev/sda mklabel gpt`、`sgdisk -Z /dev/nvme0n1` —— 旧版靠裸
`/dev/sda` 字面量兜住，上轮删掉后**全部放行**。新增一条「破坏性命令 + 裸设备」规则补上，
**刻意不含 `fdisk`**（`fdisk -l /dev/sda` 是常见只读查看，无差别拦截会直接卡住正常使用，
已加正向用例固定放行）。

### P1：doom-loop 对「每步多个工具调用」完全漏检

`recentSigs` 只保留 `THRESHOLD-1` 个签名、判定看「尾部连续 3 个相同」。模型每步并行返回
2 个调用（read+read、grep+read 很常见）时，全局序列是 `A,B,A,B,A,B…`，尾部连续 3 个**永不相同**
⇒ 保护恒不生效，一路跑到 `maxSteps`（默认 30；若配 `-1` 则真无限）。

修法不是放大窗口（交替序列放多大都不满足），而是**改判定维度**：新增「整步聚合签名」
（`StepOutcome.stepSig` = 本步所有调用签名排序后拼接），连续 3 **步**相同即拦。
保留原有的「同一调用连续 N 次」（覆盖单调用循环），两者互补。整步重复只征求**一次**确认。

### P1：`turn_end` 在异常路径漏发

它原本写在 `while` 之后，中间任一步抛错（网络断连、preModel 插件异常、`addMessage` 失败）
都会被跳过 —— 以 `turn_end` 收状态的消费者（TUI 的 busy、swarm tick）会永久卡在"运行中"。
改为 `try { while … } finally { yield turn_end }`：异常仍照常上抛（先收尾、再传播）。

### P1：provider 的自适应开关是**实例级**，会把同实例的其它模型毒化

一个 openai provider 实例可同时服务 thinking 模型与普通模型（如 deepseek-reasoner + gpt-4o）。
实例级开关一旦在 thinking 模型上置位，之后发给普通模型的请求也会补 `reasoning_content`
⇒ 标准 OpenAI 不认识该参数 ⇒ 400；而开关已开又不再走重发分支 ⇒ **该实例此后永久失败**。
改为按 `modelId` 记忆（`Set<string>`）。

### P1：400 判据用了 `!resp.ok` + 错误文本匹配

`401/429/500` 的 `error.message` 常回显请求体或未知参数，文本里可能恰好含 `reasoning_content`
⇒ 误开开关 + 多打一次请求（429 下加重限流），并把真实错误掩盖成第二次响应。收紧为
`resp.status === 400`（线上实测就是 400）。另修两处排障信息失真：重发后更新 `calls` 记录的
请求体（原来留的是未补字段的旧体，会让人得出"明明带了却没生效"的错误结论）；
把 `(no history)` 兜底移入 `buildBody`（原来在两个调用点，重发路径会丢）。

### P2：中断的两处补强

- `permission.ask` 期间不响应中断：用户在 doom-loop 确认框停留时按 Ctrl-C，批准返回后第 3 次
  调用**仍会真的执行**（与「执行前拦截」的初衷相反）。两个 ask 点都加了 ask 后的 signal 复检。
- 中断对外不可见：`done` / `turn_end` 新增 `aborted`。此前「模型正常收尾」与「用户按 Ctrl-C」
  的事件序列完全一致（都是 done + finish=stop），UI 只能靠侧信道猜。
  判据取 `aborted || signal.aborted` **两者之一** —— 写第一版时只看了前者，中断恰好落在
  最后一个工具执行期间就漏报成正常收尾，**被新加的测试当场抓到**。

### 验证方法（这轮最有价值的一条）

**先把测试写好，再回滚实现跑一遍**（`git stash push -- <实现文件>`，只回滚实现、保留测试）：
确认新测试在旧实现下**确实 fail**，才能证明它抓的是真 bug 而非空断言。这轮 2 条关键用例
（整步重复被拦、turn_end 异常路径）在旧实现下如期 fail、修复后 pass。

未能端到端复现的项：**线上 DeepSeek 当前已不复现那个 400**（用带 tools 的多步历史跑
complete/stream 各一次，首发即通过）。因此「自适应补发在收紧判据后仍生效」只能靠单测覆盖
（mock 构造 400 → 断言重发且请求体带字段）。不过上一轮探针实测过该错误返回的就是 `HTTP 400`，
故收紧判据不会破坏原修复。

## 2026-09-17（续 143）thinking 回传修复（续）：DeepSeek 要求**每条** assistant 都带 `reasoning_content`

续 142 的修复**不完整** —— 用户重启后仍报同一个错。用探针逐场景定位（对线上 DeepSeek 直接打）：

| assistant 消息形态 | 结果 |
|---|---|
| **不带** `reasoning_content` 字段 | ❌ HTTP 400 —— 正是用户那个错 |
| 带 `reasoning_content: ""`（空串） | ✅ 通过 |
| 带真实推理文本 | ✅ 通过 |

⇒ **DeepSeek 在 thinking 模式下要求「每条 assistant 都必须带该字段」，内容可以是空串**。

续 142 写成了「只在**有**推理内容时才带」⇒ 对**旧会话历史**（旧版本代码存下的、没有 reasoning part 的
assistant 消息）不生效 ⇒ 重启后照样报错。这正是"修复了却还报错"的原因。

**为什么不能无条件带**：标准 OpenAI 端点不认识该参数，多传会 400。**两种端点的要求相反**，
且无法从配置事先判断（靠模型名猜太脆弱 —— 用户配置里的 `deepseek-flash` 就是个自定义别名）。

⇒ 定为**自适应探测**：首次命中相关 400 时打开**实例级开关**并重发一次，此后该实例的所有请求
都给 assistant 补 `reasoning_content`（无内容时空串）。`complete` 与 `stream` 两条路径都实现
（stream 的重试发生在 `!resp.ok` 分支，此时尚未 yield 任何事件，重发安全）。

**验证**
- 单测 2 条：① 首发 400 → 自动重发成功，且第二次请求体里 assistant 带空串；
  ② 标准 OpenAI 端点不补该字段（防未知参数 400）。
- 真实链路（线上 DeepSeek，两个独立 provider 实例）：`complete + 旧消息` ✅、`stream + 旧消息` ✅
  —— 首发必然 400，能通过即证明自适应用效。

**探针顺带确认的两件事**
- 用户的现网配置已切到 `online` / `deepseek-flash`（线上），不再是本地的 hy3 —— 所以本地探针复现不了。
- 本地 8787 的 hy3 **忽略请求里的 `tools` 参数**（探针实测它自称拥有 WebSearch/WebFetch 等工具），
  不适合做工具链路验证；真实工具链路验证请用线上 provider。

## 2026-09-17（续 142）多步上线后暴露的三个真问题：thinking 回传 / 沙箱误报 + 漏报 / 子 Agent 步数

用户用带工具的模型实测时报错，顺着一查发现三处问题 —— 都属于「单轮时代不会暴露、
多步后必现」的类型。

### 1. thinking 模式的 `reasoning_content` 从未回传（阻塞性）

**现象**：第二步请求被服务端拒绝：
`The reasoning_content in the thinking mode must be passed back to the API.`

**根因**（两处，缺一不可）：
- `provider-openai` 的**流式解析只读 `delta.content`**，完全没解析 `delta.reasoning_content`
  ⇒ 推理内容压根没进 core，自然也无从回传；
- 序列化 assistant 消息时，ReasoningPart 被**拼进 `content` 文本**（加 `[thinking]` 前缀），
  而 thinking 端点要求它以**独立字段 `reasoning_content`** 回传。

**为什么单轮没事**：单轮时 assistant 消息不回喂给模型，这条路径根本不走。多步上线后
第二步必然带上第一步的 assistant 消息 ⇒ 必现。

**修法**：流式解析补 `delta.reasoning_content` → `reasoning_delta` 事件；非流式补
`choice.message.reasoning_content` → `completion.reasoning`；序列化时改写独立字段
（**只在确实有推理内容时才带** —— 非 thinking 模型不产生 reasoning part，于是标准 OpenAI
端点永远不会收到它们不认识的参数）。

### 2. 沙箱危险命令正则：一处误报 + 一处漏报

**误报**：`>\s*\/dev\/null\b` 把 `2>/dev/null` / `>/dev/null` 判为危险 —— 这是最常见的
「丢弃输出」写法。实测 `git rev-parse --is-inside-work-tree 2>/dev/null` 直接被拒。
（该模式与更完整的「重定向裸设备」规则重复，属多余。）
**漏报**：`\b>(>>)?\s*\/dev\/(sd|...)` 里的 `\b` 要求 `>` 左侧是单词字符，于是
`echo x > /dev/sda`（`>` 前是空格）**不匹配** —— 真正的破坏性写入反而放过去了。
改为 `(?:^|\s)>>?\s*\/dev\/...`。两处都有新测试固定。

### 3. 子 Agent 步数收窄到 10（用户决策）

子 Agent 默认继承 30 步，但它的任务是聚焦执行，且 subagent 超时固定 120s ——
30 步很容易超时。新增 `SubagentPluginOptions.maxSteps`（缺省 `DEFAULT_SUBAGENT_MAX_STEPS = 10`），
**子 Agent 自己的 `AgentDefinition.maxSteps` 优先**（个别需要长链的可单独放宽）。

### 顺带：`query()` 不该被顺带改成走流式

`query()` 复用循环后发现它开始走 `provider.stream()` —— 但它是**非流式入口**，只要最终消息，
走流式既多一层解析开销，也让「只实现 complete 的端点/测试替身」直接失效（一个 provider-openai
集成测试就是这么挂的）。新增 `AgentQueryInput.preferComplete`（内部标志）让 `query()` 走 complete，
并加测试锁定两条路径的分离。

### 附带：又是同一类测试适配

`tools-builtin` 有 6 处端到端测试用「每次返回同一工具调用」的 mock + `h.agent.query()` ⇒
多步后会跑到 doom-loop 拦截、取错那一步。统一加 `maxSteps: 1`（这已是第 4 个包出现同类问题，
说明「固定剧本 mock + query()」是本仓测试的常见写法）。

### 验证
core 74 / cli 332 / subagent 114 / swarm 65 / tools-builtin 67 / provider-mock 16 /
provider-anthropic 20 / provider-gemini 24 / revert 36 全绿；全仓 typecheck 0 错误。

### 已知限制（未修）
`provider-anthropic` 的 thinking 仍是「降级为 `[thinking]` 文本」（源码注释称 thinking block
未公开）。若启用 Anthropic extended thinking，会遇到与 openai 系同类的问题（需回传
`signature`）—— 当前未实现，留待需要时补。

## 2026-09-17（续 141）Agentic Loop 改造 S0~S4：引擎内自主多步执行

### 起因
此前 Agent 执行是**单轮**的：一次模型调用 → 执行工具 → 结束，工具结果不会自动回喂。
续轮只能靠用户输入或 coordinator 的 barrier（后台子任务集齐）注入 `<continue/>` 伪输入。
代价是 read → edit → bash 这类连续工具链无法自主跑完，模型看完文件就停了。

调研 `reference/claude-code-analysis-main`（`queryLoop()`，1729 行）与 `reference/opencode-dev`
（`runLoop` + `processor` 两层）后结论：本项目不是"没有 loop"，而是 **loop 的控制权在引擎外**。
完整计划见 `docs/agentic-loop-plan.md`，按 S0~S4 分阶段实施，每步独立可验证。

### S0（`8ac6c55`）finish reason 端到端透传
数据一直存在但被 Provider 内部消费掉就丢（anthropic `stop_reason`、openai `finish_reason`
都只用于内部分支），引擎看不到 ⇒ 无法判断该不该续轮。
- 新增 `ChatFinishReason` + `FINISH_REASON_MAP` + `normalizeFinishReason()`，`finish` / `finishRaw`
  贯穿 `ChatCompletionOutput` → `ChatStreamChunk(done)` → `AgentStreamEvent(done)`。
- **关键设计**：缺失/未知 finish 落 `'unknown'`，**绝不落 `'stop'`** —— "没有 finish 信息"与
  "模型明确结束"是两件事，混同会让循环在"有工具调用但 finish 缺失"时直接退出、退化成单轮。
- Provider 实为 4 处：`provider-glm` / `provider-qwen` 复用 `OpenAIChatProvider`。

### S1（`5ce98c2`）循环骨架（maxSteps 默认 1）
`_prepareQuery` 一分为三：`_prepareQueryOnce`（一次）/ `_buildStepMessages`（每轮）/
`_runOneStep`（单步，终值经 `yield*` 传出）。分界依据是「hook 入参是否随轮次变化」——
`llm.params`/`llm.headers` 因此刻意留在每轮。
**逐事件等价对照通过**：用同一组 mock 剧本在 S0 与 S1 各跑一遍，diff 仅 `done.step` 一处不同，
其余（事件序列/消息结构/5 个 hook 各自调用次数/provider 调用次数）逐字节相同。

### S2（`f330686`）放开步数 + 保护
- 续轮判据（`shouldContinueStep`）：`续轮 ⇔ 有工具调用 且 finish ∉ {length, content_filter, error}`。
  **不能写成「finish === 'tool_calls' 才续轮」**—— Gemini 返回 `functionCall` 时 `finishReason` 仍是
  `STOP`（S0 已用断言固定），那样写会在该续轮时退出。
- 默认 30 步（`input.maxSteps` > `AgentDefinition.maxSteps` > 默认）；**`maxSteps=1` 保留"显式单轮"**
  语义、不追加收尾步（否则 1 步变 2 次模型调用 —— 这个是踩出来的：hook 顺序断言立刻炸了）。
- doom-loop：同工具 + 完全同入参连续 3 次 ⇒ 执行前拦下 + 权限确认，拒绝则标 `DOOM_LOOP` 并终止。
- 步数到顶注入收尾提示再跑一步（对齐 opencode `MAX_STEPS_PROMPT`）。
- **`query()` 复用同一循环**，删掉 186 行重复副本 ⇒ subagent / swarm 也获得多步能力。
- provider-mock 增补 `once` 规则（模拟"先调工具、再给结论"的行为序列，测多步的关键设施）。

### S3（`b2f2aa3`）真 abort + turn_end
- `ToolContext.signal` 此前是每次 `new AbortController().signal`（永不 abort 的空壳），
  而 `tool` 的 pipeline、`tools-builtin` 的 bash、`tools-web` **早已实现 signal 响应** ——
  整条链只差 core 这一环。现在传 `AgentQueryInput.signal`。
- 中断在**步边界**与**每个工具执行前**生效（后者放在 `tool_call_start` 之前）；
  已完成的成果照常写回，未执行的标 `ABORTED`；流式 `AbortError` 被吞掉（只吞中断类，
  其它错误照旧上抛，不能把真实故障伪装成"用户取消"）。
- 新增 `turn_end` 事件：`done` 每步都发 ⇒ 上层无法判断"整轮跑完"（TUI 的 busy 曾因此在引擎
  仍在跑时显示空闲）。UI 收尾改为挂 `turn_end`。
- REPL SIGINT / TUI Ctrl-C = 「执行中中断、空闲退出」。

### S4（`bc7e4ce`）插件协调
厘清后确认**不会双重驱动**：引擎循环由「本步有工具调用」触发，barrier 由「后台任务集齐」触发。
真正的代价是空转，据此三处修复：
- `<continue/>` 空转识别：无待处理通知则跳过。⚠️ 判断前必须让出一个宏任务 —— subagent 里
  `bus.publish(completed)` 排在 `enqueueNotification()` **之前**，同步 peek 会误判空转。
  为此给 `SessionManager` 加只读的 `peekNotifications()`。
- **subagent 接上真 signal**（真 bug）：超时此前只做 `Promise.race`，signal 没传进去 ⇒
  超时后底层仍在后台跑（多步后可能几十步），白烧 token。
- **swarm tick 防重叠**：`setInterval(tick, 1000)` + `void tick()` 不等待 ⇒ 多步后单次 tick
  轻易超过 1s，每秒叠加一次新的子 Agent 查询。加 `running` 标志跳过重叠。

### 文档（`a487e46`）
README 新增 Agentic Loop 小节；architecture §16 由「现状与改造方向」改写为落地后形态；
功能矩阵与 swarm 描述同步修正。

### 验证
core 73 / cli 332 / subagent 113 / swarm 65 / session 32 / agent 33 / revert 36 / provider 系列全绿；
全仓 typecheck 0 错误。**未做**真实 barrier 全链路实测（需实际后台任务）。
待决策：subagent 默认超时 120s vs 子 Agent 可跑 30 步 —— 倾向给子 Agent 设更小 `maxSteps`（~10）。

### 方法论沉淀
- **逐事件等价对照法**：先写对照脚本 → 工作区跑 → `git stash` → 基线跑 → `pop` → diff；
  hook 调用次数必须纳入对照（拆分"一次 vs 每轮"时，丢 hook / 重复执行只体现在次数上）。
- **引用数值前必须实读那个文件**（本项目已两次因把文档示例值当配置实况而得出错误结论）。
- 新增事件类型后要回头检查所有"非 X 即 Y"的判断（`turn_end` 曾被 REPL 误当成"下一步开始了"）。
- 新增 session 接口方法会打破所有测试替身（`grep -rn "implements SessionManager"`）。

## 2026-09-17（续 140）会话压缩（session compaction）：窗口按 Provider 推导 + CJK 口径 + 参数可配置

### 起因：项目里有两套压缩，此前只调了其中一套

排查「筛选层」时发现 `packages/session` 另有一套 compaction（`/compact` 命令 + REPL 启动时的 `compactIfNeeded`），
与 ACP 完全独立：ACP 按 token 分级折叠、**每轮**跑、摘要可解压；会话压缩按**消息条数**裁剪 + 规则摘要、
只在启动与 `/compact` 判定一次、且丢弃原文。它的参数确实比 ACP 小一档（`summaryMaxChars` 8000 vs 10000）。

更麻烦的是这套**长期形同虚设**：

1. **窗口硬编码 200000**（`core:952`）：`compactIfNeeded` 从不接窗口，阈值 = `(200000−30000)×80% = 136000`。
   任何窗口小于 136000 的 provider ⇒ 阈值高于窗口本身 ⇒ **永远不可能触发**，且毫无症状
   （`/compact auto` 只会回一句「未达阈值（估算 xxx tokens）」）。
2. **估算仍用 chars/4**（`estimateTokensForMessages`）：没跟 ACP 一起改 CJK 感知，中文会话再低约 4 倍。
3. **完全不可配置**：所有只能通过改代码调整。

### 方案（三件事）

- **① 窗口**：抽 `resolveContextWindowTokens(cfg, defaultProviderId)`（三级推导），
  boot 装配 ACP、配置概览、`buildCompactionOptions` **三处共用**；两处 `compactIfNeeded` 调用点显式传入。
- **② 口径**：`packages/session` 新增 `countTokensCJK` / `countTokensChars4` / `resolveCountTokens`
  （与 `acp-kernel` 的 `defaultCountTokens` 同口径：中日韩 1 token/字 + 其余 4 字符/token；
  不直接 import 内核，避免把第三方压缩内核变成底层包的硬依赖，代价是靠 `token-count.test.ts`
  的定值断言守漂移）。`core.estimateTokensForMessages` 改为接收 `countTokens`，
  并**先拼整段再计数**（逐段 ceiling 会累积出系统性高估，也会让「英文两口径逐位等价」失效）。
- **③ 配置**：新增顶层 `compaction` 段（strategy / keepRecentMessages / summaryMaxChars /
  autoCompactThresholdPct / reservedTokens / contextWindowTokens / tokenCalibration），
  CLI 透传给 `compact` / `compactIfNeeded`。

### 额外的一道防线：阈值可达性

新增 `checkCompactionReachability(cfg, id)`：**阈值 ≥ 窗口**就告警（这条此前完全无声，是本类问题的主要成因）。
`checkCompactionConfig` 同步做未知键白名单 diff（同样用 `Record<keyof ..., true>`）+ `strategy` /
`tokenCalibration` 取值校验，两处都接进 boot 告警与 `/config`、`--check-config` 概览。

### 验证

- session 32 / core 44 / cli 330 全通过；全仓 typecheck 0 错误。
- 新测试 16 例：口径定值断言 8 例（含「中文相差 4 倍」「英文逐位等价」两条不变量）
  + core 3 例（**同一会话在 102400 触发、在旧硬编码 200000 下永不触发**；两种口径下一触发一不触发）
  + cli 5 例（窗口三级推导 / 选项透传 / 拼错键点名 / 白名单完整性 / 阈值可达性）。
- README 新增 `### compaction 对象`，写明两套机制的区别与「阈值 ≥ 窗口」这个坑。

## 2026-09-17（续 139）配置概览的 ACP 窗口改为与 boot 同一套推导（+ 现网配置优化）

### 起因：一个把三份评估全部作废的显示 bug

概览里的 `fitWindow` 此前直接兜底 `200000`，不看 `providers[].contextWindowTokens`；而 boot 装配插件时用的是「`compression.modelContextLimit` → 默认 provider 的 `contextWindowTokens` → 200000」三级推导。**同一个数两处两个值**，按概览做的判断全部落空。

> **更正（当日晚些核实，见续 140）**：本条开头写的「所有 provider 都写着 `contextWindowTokens: 102400`」
> **与事实不符**。实读配置：默认 provider `hy3` 是 `200000`，其余三个（`online` / `deepseek-v4.1-flash` /
> `hy4-preview-f`）是 `300000`，全仓没有任何 `102400`（那是 `@harness/plugin` 里 ProviderConfig 的文档示例值）。
> 因此下面的收益数字是在**错误窗口前提**下算出来的，真实（200K）收益见续 140。**逻辑上要改的那些键依然
> 是死键/有害键**，改动方向没错，错的只是收益幅度。

~~现网~~ 排查时误以为 providers 写着 `contextWindowTokens: 102400`，据此认为概览一直显示 `fitWindow=200000` 是偏差，并在 102400 窗口下算出了下面那组触目惊心的数字（本段保留作为「前提错了会把结论带偏多远」的记录）。

改为同样走 `normalizeProviderConfigs`（默认 provider 的 id 可能省略、由 model 派生），再按三级回退。cli 全包 324 通过。

### 现网 `~/.harness/config.json` 优化（备份 `config.json.bak-20260917-1347`）

删掉 5 类键，全部交回 autoTune 推导：`config.preserveRecentTokens: 50000`（主因）、`config.compress.minCompressRange: 30000`、`nudge.growthRatio/Floor/Cap/minGrowthFloor`（层级写错，从未生效）、`compression.maxSummaryLength`、`telemetry.maxEvents`（均不存在）。

删掉 5 类键，全部交回 autoTune 推导：`config.preserveRecentTokens: 50000`（主因）、`config.compress.minCompressRange: 30000`、`nudge.growthRatio/Floor/Cap/minGrowthFloor`（层级写错，从未生效）、`compression.maxSummaryLength`、`telemetry.maxEvents`（均不存在）。

**当时报的收益作废**：称「`fitWindow=102400`、生效值 R=15000 / GF=22500 / MC=60000、三点均值 52573 → 11938（−77.3%）」，全部建立在「窗口 = 102400」这个错误前提上。真实窗口 200000 下的实测见续 140：**16068 → 12833（−20.1%）**。

R 扫描（steps=140，W=102400）本身是独立实验，结论仍成立（10000 反而变差到 12728，块更碎，15000 最优）——它证明的是「小窗口别手写大 R」，不构成对现网的判断。

## 2026-09-17（续 138）CLI 侧 compression 配置写错键 / 写错取值时告警

### 根因

`JSON.parse(config.json)` 无编译期保护 → CLI 白名单搬运 → `defaultConfig` 合并尾部 `{...base, ...overrides, 子树:{...}}` **静默丢弃所有未知键**。于是 `preserveRecentToken`（少 s）、`nudge.growthFloar`、`tokenCalibration: 'chars/4'` 一律无声。

后者尤其危险：它**静默降级到默认值 auto**，而 CLI 概览照常显示「token 口径 自动（CJK 感知）」。想拿 `chars4` 做 A/B 对照组却拼错 ⇒ 两组都跑 auto ⇒ 实测差 ≈ 0 ⇒ 得出「两个口径没差」的反向结论（真相差约 4 倍）。**与「遥测漏传 countTokens」是同一类假阴性**。

### 方案

新增纯函数 `checkCompressionConfig(c: unknown): string[]`，白名单 diff 覆盖 `compression` 顶层 / `tiers` / `nudge` / `telemetry` / `prompts`，以及高级透传里的 `config.tiers` / `config.nudge` / `config.compress` / `config.truncate` / `config.absorb`，外加 `tokenCalibration` 取值校验。

两处接线：boot 装配 ACP 前（放在 `enabled` 判断之外——「开关关着却怎么也不生效」正是最高发的困惑场景）；`buildConfigOverview` 的「配置告警」段（`--check-config` 与 `/config` 均可见）。**不改退出码**，告警不属错误，只有 providers 问题才 `return 1`。

### 三个实现取舍

1. 白名单写成 `Record<keyof 内核类型, true>` ⇒ 内核增删/改名时**编译期即报错**，白名单不会静默过期；
2. 形参标 `unknown` 而非 `HarnessConfig['compression']`——本函数存在的理由就是 `JSON.parse` 的形状不受保护，标成结构化类型反而让调用方误以为已受保护（TS 只拦字面量，不拦运行时多余键）；
3. 测试加一条「所有合法键写满 ⇒ 零告警」的守卫，防白名单漏列变成误报噪音。

验证：真实 CLI 跑 `--check-config` 端到端确认「深层拼错精确命中 + 合法配置零告警」；对现网配置一跑就抓出 6 个死键（其中一个 `minCompressRange: 30000` 正在付出约 25% 成本）。cli 全包 323 → 326。

## 2026-09-17（续 137）清理四处多余的 `as any` 类型逃逸

上一轮代码审查遗留项。逐处删掉后 `tsc --noEmit` **干净通过**、48 测试 / 202 断言全绿、`renderText` 输出逐位不变 ⇒ 确认四处**均非必需**：

- `index.ts` allowToolIds 改 `new Set<string>(...)`：`toolIds` 是字面量联合数组，`Set<联合>.has(string)` 才不兼容；正解是放宽集合元素类型，不是对入参投毒。
- `index.ts` `buildCompressEvent` 的 window 直接用 `config.modelContextLimit`：内核 `types.d.ts:168` 里该字段是**必填** number，`defaultConfig`（`dist/index.js:331`）也确实写入产物 ⇒ 原来的 `?? 0` 是**永不执行的死分支**，却让读者误以为该字段可能缺失。顺带证明遥测里 `window` 一直是真窗口值，历史数据没被污染。
- `index.ts` `buildPreModelEvent` 的 config 去掉断言：形参 `Config` 与插件 `AcpConfig` 是同一类型别名。
- `adapter.ts` renderText 分支改 cast 到具体 Part interface：**唯一有实质价值的一处**。`Part` 联合末尾的兜底成员 `{ type: string; [key: string]: unknown }`（`session/src/index.ts:89`）使 `p.type === 'reasoning'` 无法 narrowing，作者只好上 `any`；代价是字段名写错（如 `FilePart.path` 写成 `filePath`）编译照样过、运行时被 `?? 'inline'` 兜住 ⇒ 每条附件都变 `[file: inline]`，模型看不见文件名，全程无声。现在编译器能兜住。

## 2026-09-17（续 136）独立代码审查修复：遥测口径透传 + nudge 三键同源

提交后派子代理（无我的上下文包袱、直接读代码）做独立审查，抓出两处自审两轮漏掉的问题：

**P1 —— telemetry 漏传 `countTokens`（假阴性）**：`59e296e` 本应让遥测跟随同一口径，但 `telemetry.ts` 里两处 `estimateTokens(inp.xxx, inp.countTokens)` 被**同文件并行 Edit 静默回滚**，而提交信息已经写了「遥测跟随同一口径」。表象与上次修的 P1 同源：**日志/提交信息声称在生效，实际没有**。已修复并新增测试断言该分支（`telemetry.test.ts` 3 例，含 chars4 分支与"两口径占用率差约 4 倍"）。

**P2 —— applyAutoTune 单键覆盖时 cap/floor 不联动**：只写 `growthFloor: 90000`（300K 推导 cap=75000）⇒ 内核 `min()` 静默截断成 75000，显式值失效。改为三键同源 `effectiveGrowthFloor = uNudge.growthFloor ?? uNudge.growthCap ?? uNudge.minGrowthFloor ?? p.growthFloor`。中间曾写 `cap = Math.max(自动值, 生效floor)`，自否（会抬高用户显式 cap），最终取「让自动值向显式值让步」。

方法论固化：**提交后再跑一次独立审查**；以及**提交信息里每一句"改了什么"，提交前都要 grep 核对**。

## 2026-09-17（续 135）token 折算口径对齐内核（`tokenCalibration`，默认 auto）

### 根因更正

此前我判断"内核默认 `chars/4`"——**错了**。读 JS 实现发现 `createCore` 取 `ports.countTokens ?? defaultCountTokens`，而 `defaultCountTokens` **本就 CJK 感知**（中日韩 1 token/字 + 其余 4 char/token）。真正错在**插件侧**：`adapter.estimateTokens` 一律 `ceil(Σchars/4)`，而它产出的 `tokenCount` 是占用率闸门的唯一输入 ⇒ 中文会话上报仅占真值的 0.27~0.30×，两侧口径分裂。

### 方案

新增 `tokenCalibration?: 'auto' | 'chars4'`（默认 `auto`）：`auto` 走内核 `defaultCountTokens`，`chars4` 保留旧口径回退。`createCore({ countTokens })` 传参，`runPreModel` / `acp_status` 上报同一口径。

### 实测（真实插件链路）

中文会话上报/真值偏差：`chars4` 0.27~0.30× → `auto` **0.98~0.99×**。第 31 轮真值超窗 100.8% 时，旧口径只报 29.5%。内核链路中文峰值 207.2% 超窗 → 91.6%；**英文零回归（差 0.00%）**。

一处不追求的目标说明：新实现逐条 ceil 累加、旧实现先求和再 ceil，纯 ASCII 下最多差 `core 数 − 1` token（7 条实测 265 → 268，约 1%）。「逐位等价」过强，与内核口径一致才是目标；英文 60 轮折叠指标逐位相同。

## 2026-09-17（续 134）压缩参数按窗口自动适配（autoTune）+ 200K/300K/1M 最优参数表

### 需求

> 200K/300K/1M 的上下文窗口，给一个最优参数表，其他上下文大小的窗口用这个调优方法自动适配。

### 方案：三锚点分段插值（而非单条对数拟合）

`AUTO_TUNE_ANCHORS = [[200000, 35000], [300000, 50000], [1000000, 100000]]`，在 `log10(W)` 上分段线性插值、两端延伸，夹 `[15000, 150000]`。**刻意选插值而非拟合**：保证「参数表给出的值 = 公式在锚点处的取值」，文档与实现对得上，不会出现"表里写 50000、公式算出 48130"的割裂。

推导式：`R = clamp(round500(interp(W)), 15000, 150000)`；`GF = round500(1.5R)`（growthFloor = growthCap = minGrowthFloor）；`MC = clamp(4R, 8000, 2(W−R))`（**chars 口径**）。

注意 `MC = 4R` 里的 `4` 按英文折算率，中文下相对保护区粗 4 倍（实测不越界）；若改为 `R × 折算率` 需重扫中文锚点，留作后续。

### 实测

300K 偏离对照（表值 R=50k/GF=75k/MC=200k = 13588）：GF=100k + MC=150k = 13795（**+1.5%**）；仅 MC→150k = +3.1%，仅 GF→100k = +1.0%；峰值占窗 58.6% → 65.5%（贴 0.65 线）。`GF = 2R` 在 1M 会 +9.3%，**不可推广**。

`autoTune` 默认 `false`（零行为变化），需显式开启。测试：acp-context 48 例、cli 320 例全绿，34 个 typecheck 目标 0 错误。新增 `docs/acp-context-param-table.md` 速查卡。

## 2026-09-16（续 133）revert 测试替身补 `setBlocks`，修复 HEAD 上的 typecheck 失败

既有问题，与近期改动无关。commit `3aaa096`（ACP 每轮内部压缩块同步进 `session.blocks`）给 `SessionManager` 接口加了 `setBlocks`，但漏改 `packages/revert` 的测试替身 `FakeSessionManager`，导致全仓 typecheck 在该包报 exit 2：

```
index.test.ts(30,7)   TS2420: FakeSessionManager incorrectly implements SessionManager
index.test.ts(179/210/221/247/272/299/320,42)  TS2741: Property 'setBlocks' is missing
```

补 `setBlocks`，实现与 `packages/core/src/index.ts:704` 逐行对齐（**不是** `throw 'not implemented'`——该替身是内存实现，其余成员都真实改内存状态，抛异常会让走到该路径的用例挂掉）：blocks 为空或会话不存在则直接返回，否则按块 id 建 Map 去重覆盖，每块 `at` 更新为 `now`，写回 `session.blocks` 并刷新 `updatedAt`。

同时逐条比对 `SessionManager` 的 27 个成员，确认除 `setBlocks` 外无其它遗漏——**TS2420 只报第一个缺失成员，很容易漏掉后面的**。

验证：revert 包 8 条错误全消、36 pass / 0 fail；全仓 34 个 typecheck 目标全部 exit 0（此前 revert 是唯一失败项）。

## 2026-09-16（续 132）删除 apiKey 明文回显链路（`reveal` / `maskKey`）

`formatApiKeyTag` 的 `reveal` 选项会把 apiKey 明文原样输出，它唯一的真实用途是给 `buildConfigOverview(cfg, id, maskKey)` 当透传参数（`{ reveal: !maskKey }`）。而 `buildConfigOverview` 的 3 个生产调用方（`/config`、两处 `--check-config`）全部使用默认 `maskKey=true` ⇒ **reveal 在生产运行时恒为 false，CLI 没有任何入口能触发它**。

一个"有测试覆盖、但永远走不到的明文回显密钥能力"：留着意味着将来谁手滑传个 `false`，就会把密钥打到终端或日志里。整条删掉，含 `maskKey` 参数本身：

- `formatApiKeyTag` 的 opts 收敛为 `{ fingerprint?: boolean }`；
- `buildConfigOverview` 去掉第三个参数，内部改为 `formatApiKeyTag(pc.apiKey)`——这正是当前生产行为（默认脱敏为「已配置」），**无行为变化**。

`fingerprint`（附末 4 位）保留：用于区分「同端点同模型、仅 token 不同」的实例，唯一调用方只在重复组上才附指纹，有实际价值。

测试删除 5 条 reveal/maskKey 断言，**新增反向保护**：`buildConfigOverview` 的输出不得包含明文 apiKey——将来若有人把明文回显加回来，测试会红。cli 316 pass / 0 fail。

## 2026-09-16（续 131）provider-gemini：收尾窗口不再长于 idle 超时

`DRAIN_MS` 原为 `min(300, max(50, timeoutMs/4))`。50ms 的硬下限在 `timeoutMs < 200` 时把窗口顶到 50ms，**反而长于请求自己的空闲超时**；而 idle 计时器在收到 finishReason 后**不再续期**（没有新数据），于是还没收工就被 idle 抢先触发，把已经正常输出完毕的流判成「空闲超时」，用户看到「发送失败」。

改为 `min(300, timeoutMs, timeoutMs/4)` 并去掉 50ms 硬下限（下限只保留 1ms 防 0）：正常配置（`timeoutMs ≥ 1200`，默认 120s）结果仍是 300ms，与旧行为完全一致；`timeoutMs = 20` 时为 5ms，先于 20ms 的 idle 收工。

注意窗口必须**严格短于** timeoutMs——只是「不超过」仍会与 idle 撞在一起。已 A/B 验证：旧公式下新用例失败（实测 24.89ms，正是 idle 20ms 抢先触发），新公式下通过。gemini 24 pass / 0 fail。

## 2026-09-16（续 130）`@readonly` 哨兵让真实工具优先，不再霸占命名空间

`filterByWhitelist` 先判哨兵再查注册表，于是哨兵值 `'@readonly'` 霸占了同名工具的命名空间：万一某个工具（内置或 MCP）真的叫 `@readonly`，用户把它写进白名单后拿到的却是「全部只读工具」，**永远无法直选到它本身**。

改为真实工具优先、哨兵兜底：

```ts
const direct = this.get(id)
if (direct) { push(direct); continue }            // 含真叫 @readonly 的工具
if (id === READONLY_TOOLS_SENTINEL) { 展开只读 }   // 无同名工具时才展开
```

对现有行为零影响（当前注册表里没有 `'@readonly'` 这个 id）。JSDoc 一并写清两点此前没说破的语义：哨兵是**查询期动态展开**（同一份白名单在 MCP 只读工具晚注册的前后两次调用结果可能不同，不是静态快照）；注册表里若存在同名工具则优先直选。tool 62 pass（新增 3 例），改前确认新用例失败。

## 2026-09-16（续 129）会话恢复指针再校验 `saved.cwd`，避免 `.harness` 被复制后跨目录串台

`findResumeTarget` 的指针分支此前只校验「指针归属的 dataDir」（上一提交加的），不校验会话自己的 cwd。于是把 `.harness/` 整目录（含指针文件）复制到别处后，在新目录启动会恢复出**旧目录的会话**——与注释里「不会跨目录串台」的说法不符。

同 cwd 兜底分支本来就有 `resolve(s.cwd) === this.workspace.cwd` 的比对，指针分支是个漏网的。现在补上：指针命中后 `saved.cwd` 与当前 cwd 不一致（含旧会话 `saved.cwd` 为 undefined）时不从指针分支返回，静默落到兜底分支。

语义与 `rememberSession` 对齐——后者只在会话属于当前目录时才写指针，**「写指针时认目录，读指针时也该认目录」**。cli 316 pass（新增 4 例，含「指针失效时仍能走同 cwd 兜底」），已确认新用例在改动前失败。

## 2026-09-16（续 128）流式请求补回总时长上限（空闲超时之外的兜底）

三个 provider 的流控从「总时长超时」改成「空闲超时」后丢掉了总时长上限：上游**持续慢速吐数据**（每帧间隔 < timeoutMs，默认 120s）时，idle 计时器被不断重置，请求永不结束——旧行为至少还有总时长兜底。

openai / anthropic / gemini 各加一个总时长计时器：`STREAM_TOTAL_TIMEOUT_FACTOR = 10`，即 `timeoutMs × 10` 作为整条流的硬上限，与 idle 计时器并存、谁先到谁生效，`finally` 里统一清理。

系数取 10 是刻意的宽松值：只兜「真的卡死了」，不干扰正常的长回复——**长回复表现为持续有帧，idle 不会触发，但也不该被总时长误杀**。三个包各新增 1 例「持续慢速吐数据（永不结束）触发总时长兜底，而非空闲超时」（openai 22 / anthropic 20 / gemini 23 pass）。

## 2026-09-16（续 127）会话指针原子写 + 绑定 dataDir

会话恢复指针（`.harness/last-session.json` 一类）此前有两个隐患：

**1. 非原子写**：`write()` 直接 `writeFile` 覆盖，同目录多进程并发写会损坏文件（JSON 尾部出现 NUL / 长度异常），`read()` 的容错会静默返回 undefined，表现为「指针无故失效」——不崩溃但恢复路径退到兜底。`ensureGitignoreEntry` 同样是 read-modify-write，一并中招。
→ 新增 `writeFileAtomic(path, content)`：同目录写 `.tmp` 再 `rename`（同文件系统才保证原子），失败清理临时文件；`write()` 与 `ensureGitignoreEntry` 均改用，且后者先 mkdir 再读，避免首次无目录时读失败。

**2. 指针不绑定 dataDir**：只存 sessionId，同 cwd 用不同 `--data-dir` 且 sessionId 恰好相同（形如 `s_<ts>_<5位随机>`）时会把另一个 dataDir 的会话恢复出来。
→ `SessionPointerFile` 新增 `dataDir?: string`；新增 `readIfOwnedBy(dataDir)`：解析出 dataDir 才比对归属，**旧指针无该字段照常返回**（向后兼容）。内部 `normalizeDataDir` 做 `resolve` + 去尾分隔符 + `realpathSync`（失败兜底），以兼容 `/tmp ↔ /private/tmp` 这类符号链接差异。

workspace 38 pass（新增 5 例）、cli 312 pass。

## 2026-09-15（续 126）模型配置 id 优化：id 可省略 + `/model` 智能解析

### 问题（用户反馈）

> 优化模型配置 id，现在 id 很长还必须唯一，但现在切换模型时必须 id/model 才能切换成功，设计显然有问题。

现象：配置里要写 `{ "id": "local-deepseek-v4.1-flash", "model": "deepseek-v4.1-flash" }` 这种把模型名重复一遍的长 id；切换时还得 `/model local-hy3/hy3`，同一个模型名敲两遍。

### 根因

`providers[].id` **一个字段承担了三件事**：

1. **路由键** —— core 的 `chatProviders` 注册表 key，且 openai 等插件 id 派生为 `provider.{id}`，插件 id 必须唯一 → 于是 id 被迫全局唯一且越写越长；
2. **显示名** —— `/model ?` 列表、`/model` 回显；
3. **切换参数** —— `/model` 强制 `id/model`，而 model 明明已经是配置字段。

即「机器身份」与「人类名字」耦合。附带一个真实故障：旧实现把任何裸词都当模型名写进 `config.model`，于是想切 provider 却拼错（如 `/model local-hy4`）会**静默落成垃圾模型名**——用户 `~/.harness/config.json` 里 `"provider": "local-hy3"` + `"model": "local-hy4"` 的不自洽配置正是这么来的。

### 方案

**1. `id` 变为可选，缺省由 `model` 自动派生**（`packages/plugin/src/index.ts` 契约 + `normalizeProviderConfigs`）

- 省略 `id` → 取 `model`（去 `provider/` 前缀、非法字符折叠为 `-`）；同名按数组顺序追加 `-2`/`-3`（确定性，无需人工起名）；
- 显式 `id` 仍支持（同模型多端点、或想让 id 更短）；显式重复仍报错（避免静默覆盖注册）；
- `id` 与 `model` 都缺失 → 报错（无从派生）；
- 归一化后引入 `ResolvedProviderConfig`（`id: string`），下游（装配/路由/校验/展示）一律按「id 必有」处理，不再到处判空。

**2. `/model <arg>` 智能解析**（`resolveModelArg`，纯函数）

优先级：`id/model` 显式 → 纯数字序号 → 按实例 id / 模型名命中唯一实例 → 兜底。
结果类型化：`instance` / `explicit` / `model` / `ambiguous`（列出候选要求消歧）/ `bad-index` / `type-hint`（是 Provider 类型名，给用法提示）/ `not-found`。

**关键取舍**：兜底「裸模型名挂当前 Provider」**仅当未配置任何 providers 实例时**才允许。
已配置 providers 时裸词必须命中实例，否则拒绝 —— 这正是堵住「拼错静默写进 config.model」的那个洞。

**3. 持久化自洽**：`applyModel` 把解析出的 provider 与 model **同步**写入 `config.json`；实例未声明 `model` 时清空 `modelId`，交由该 Provider 的默认模型接管（不再把上一个模型的 id 带过去）。

**4. 展示**：`/model ?` 列表带 1-based 序号（可直接 `/model 2`）并给出三种写法示例；`/model` 回显解析后的 provider/model 与来源（`provider=x · model=y`）；`getModel` 在只绑 provider 时显示 `<provider>/(provider 默认模型)`。

### 验证

新增 `packages/cli/src/provider-model.test.ts`（19 用例）：归一化 6（派生/去重序号/显式保留/显式重复报错/两者皆缺报错/字符规整）+ 解析 10（序号/越界/模型名/实例 id/显式/歧义/旧用法兜底/**拼错拒绝**/类型名提示/引用格式化）+ 集成 3（省略 id 的 config 直接按模型名切换并落盘自洽、`/model ?` 序号列表、拼错不污染 `config.model`）。cli 全量 **257 用例通过**、全仓 typecheck 通过（`packages/revert` 为既有错误，与本次无关）。

### 附带

- `/help` 的 `/model` 说明补四种写法；`buildConfigOverview`（`config check` / `/config`）改为展示归一化后的实例 id，与实际装配一致。
- 用户 `~/.harness/config.json` 迁移：删掉与模型名重复的 `local-*` 前缀 id（改用派生 id），保留 `online`（短且非模型名派生的有意义别名），修正 `provider: "local-hy3"` → `"hy3"`、`model: "local-hy4"`（垃圾值）→ `"hy3"`；改前已备份。

### 踩坑记录（工具使用）

在**同一条消息里对同一文件发两个 Edit** 会出现后发编辑覆盖先发编辑（两次都被静默丢弃过）。改同一文件的多处编辑必须**顺序分开发送**，改完用 grep 复核落盘结果。

## 2026-09-15（续 125）提交键反转：Enter 提交，`\`+Enter / Shift+Enter 换行

### 背景（接续 124）

续 124 加了 Shift+Enter / Ctrl+J 提交，但用户在 herdr 里实测：

| 场景 | Shift+Enter | Option+Enter | Ctrl+J |
| --- | --- | --- | --- |
| 输入 `/xxx`（菜单展开，不带空格） | 「有效」 | 无效 | 无效 |
| 输入 `/xxx `（带空格）或普通正文 | 无效 | 无效 | 无效 |

### 判读

命令态那次「有效」并非 Shift 生效，而是**菜单在拦截 Enter 选中候选命令**（`__KEYLOG`
此前不记修饰键，无法直接分辨）。结论：**只有 Enter 的原生 CR(0x0D) 能送达到应用**，
其余组合（含 LF 0x0A）全部丢失或被复用器吞掉。继续给修饰键加绑定没有意义 ——
提交键必须是 Enter 本身，否则用户在 herdr 里根本无法发送消息。

### 改动

- **反转按键约定**（`tui.tsx` 全局 `useKeyboard`，置于列表模式之后以便列表优先）：
  - `Enter` / `LF(Ctrl+J)` → 提交（一并接受 LF：部分终端/复用器把 Enter 上报成 LF）
  - `Shift+Enter` → 换行（仅终端上报修饰键时，如 Kitty 协议；传统终端下等同 Enter 提交）
  - `` `\` + Enter `` → 换行：消费行尾转义反斜杠后插入换行，**不依赖任何修饰键上报**
- 交接顺序调整：该分支从「Ctrl+C 之后」下移到「文件/会话列表分支之后」，
  保证列表模式的 Enter（恢复会话 / 打开文件引用）与命令菜单的 Enter（选中候选）优先。
- `__KEYLOG` 改为记录修饰键（`name:C/S/M`）。此前只记 `ctrl`，导致
  「Shift 到底有没有送达」在日志里无从判断 —— 这次排查正是卡在这里。
- 帮助面板按键表同步（Enter 提交、`\`+Enter 换行、Shift+Enter 换行、Ctrl+J 同 Enter）。

### 已知取舍

`` `\`+Enter `` 只认**整段缓冲的行尾**反斜杠（不做光标偏移计算，避免 CJK 下
`cursorOffset` 单位歧义导致误删字符）。因此多行缓冲中在中间行插反斜杠换行不生效，
会走提交 —— 聊天输入以尾部追加为主，可接受；键入场景光标即在末尾。

### 验证

`tui.test.tsx` 新增/改写 5 个用例：Enter 提交、Shift+Enter（Kitty）换行不提交、
Ctrl+J 提交、`` `\`+Enter `` 换行且反斜杠被消费、菜单展开时 Shift+Enter 不被菜单拦截。
另用断言确认**换行只插一次**（`preventDefault` 确实拦住了 textarea 默认换行，
已在输入区验证两行相邻无空行）。cli 全量 238 用例通过、typecheck 通过。

## 2026-09-15（续 124）输入框提交键：新增 Shift+Enter 与 Ctrl+J 兜底

### 背景

用户在 herdr（tmux 式终端复用器）里 Option+Enter 无法提交。排查结论（详见续 123 前的排查记录）：
提交键来自 OpenTUI Textarea 默认绑定（`Enter = newline`、`Meta+Enter = submit`），
`meta` 只能来自 ESC 前缀，而 macOS 上 Option 默认用于「组合输入特殊字符」不发 ESC 前缀。
用户要求改为 Shift+Enter 提交。

### 两个关键发现（影响实现方式）

1. **`@opentui/react` 不透传 textarea 的 `keyBindings`**（react 包中零匹配）。
   该 prop 传了会被直接丢弃，因此自定义提交键**不能**靠 `keyBindings`
   （虽然 core 的 `TextareaRenderable` 构造函数是用 `mergeKeyBindings` 合并的）。
   最终改为在全局 `useKeyboard` 里直接调 `textareaRef.current.submit()` 触发 `onSubmit`。
2. **传统终端下 Shift+Enter 无法与 Enter 区分**。OpenTUI 的测试 mock 层忠实反映了这点：
   关闭 kitty 协议时，`pressEnter({ shift: true })` 走的路径既不处理转义序列也不处理
   单字符修饰，最终发出的仍是裸 `\r`（shift 丢失）。只有开启 Kitty keyboard protocol
   （或 modifyOtherKeys）才能编码 Shift 修饰。

### 改动

- `tui.tsx` 全局 `useKeyboard`：
  - `return && shift` → `preventDefault()` + `textarea.submit()`；
  - `linefeed`（Ctrl+J，LF 0x0A）→ 同样提交。**这是可靠兜底**：LF 与 CR 天然可区分，
    不依赖终端上报修饰键。
- `tui.tsx` 命令菜单分支：`return && !meta` 改为 `&& !key.shift`，
  避免菜单展开时 Shift+Enter 被拦截去选中候选命令（否则提交不了）。
- 帮助面板按键表补充 `Shift+Enter` / `Ctrl+J` 两条，并标注各自前提。
- 默认约定不变：Enter 换行；Option+Enter 仍由 Textarea 默认绑定提交。

### 测试

- `tui.test.tsx` 的 `mountTui` 新增 `kittyKeyboard` 选项（透传给 `createTestRenderer`），
  用于验证依赖修饰键的用例。
- 新增 3 用例：Shift+Enter 提交（kitty 模式下）、Ctrl+J 提交（默认模式，证明不依赖协议）、
  命令菜单展开时 Shift+Enter 提交正文而非选中候选。
- cli 全量 **238 用例通过**、typecheck 通过。

### 待办

- 用户环境实测：herdr 是否转发 Kitty 协议协商未知，若不可用则 Ctrl+J 是唯一可靠提交键。
- harness 的 Ctrl+B（侧栏）与 herdr 默认前缀键冲突，未处理。

## 2026-09-15（续 123）用量统计修复的代码评审：修 4 个缺陷 + 抽出当日归集模块

### 评审背景

对续 122（重连后 token 清零修复）做提交后评审。核心修复（初值水合、空累积器防覆盖、消息时间归属）
方向正确，但评审中另发现 4 个缺陷，均已当场修复并补回归测试。

### 修复项

- **P1 `resolveCurrentUsage` 回源失效**：回源条件写成 `current.messages?.length ? current : await get()`，
  内存视图消息非空时短路，磁盘历史永远读不到。实测：磁盘有 999 输入 token 仍返回 `llmCalls=0`。
  改为「水合结果为空才回源」，并注释说明不能用 `messages.length` 判断（消息非空也可能全无 `tokenUsage`）。
- **P1 当日归集 effect 过频 + 会话文件读两遍**：`tui.tsx` effect 依赖 `[usage.llmCalls, options.session, options.app]`，
  每次 LLM 调用都全量扫描；而 `workspace/storage.ts` 的 `list()` 内部已对每个 id `await load(id)`，
  归集又对当日会话逐个 `load()`。改为 800ms 防抖（根因在读两遍，见遗留建议 A）。
- **P2 `shouldPersistUsage` 不防「部分覆盖」**：只防全空覆盖，实测 persisted 100 次 vs next 1 次仍允许写入、丢 99 次。
  加单调性守卫 `next.llmCalls < persisted.llmCalls` 时不写入。
- **P2 归集逻辑重复 + 漏当前会话**：index 与 tui 各写一遍约 30 行，且只按 `list()` 归集——
  新建会话未落盘时不在 list 里，其当日用量被漏掉（TUI「今日」不增长）。

### 新增模块

- `packages/cli/src/usage-today.ts`：`collectTodayUsage(store, current, now)`。
  放独立模块而非 index/tui 的原因：两者互相 import 已存在循环依赖，公共逻辑放任一文件都会加重循环；
  且 usage-stats.ts 需保持纯函数无 IO。当前会话无条件纳入（`ids.unshift(current.id)`），
  按 `updatedAt >= 当日零点` 过滤避免全量 IO，任一步失败回落「仅当前会话」。
- `packages/cli/src/usage-today.test.ts`（7 用例）：假 store 精确控制 list/load，覆盖跨会话合并、
  历史会话不被加载、当前会话 updatedAt 早于零点仍纳入、只算今天桶、store 抛错回落、无 store 退化。

### 遗留建议（未改）

- A. `workspace/storage.ts` 的 `list()` 对每个 id 全量 `load()` 后丢弃 messages，归集需再 load 一次。
  建议加 `listSince(ts)` 或 `loadMeta(id)`。属 workspace 接口变更，影响面大。
- B. 时区：小时桶按 UTC 整点切，当日按本地零点切；整小时偏移（含 UTC+8）自洽，
  印度 UTC+5:30 等半小时时区在零点前后有 30/45 分钟归错天。
- C. 当日归集丢失 `models/tools/agents` 维度（小时桶不含模型信息），导出 today 段无模型明细。

### 验证

- cli 全量 **235 用例通过**（原 225 + 新增 10）、typecheck 通过。
- 两个缺陷用探针测试实测确认后再修（非静态推断）。
- 评审报告：`reference/workbuddy/code-review-usage-stats.html`。

## 2026-09-15（续 122）用量统计：修复重连后 token 清零 + 新增当日（跨会话）用量

### 问题

- TUI 每次重连（resume）后 token 用量显示为 0。
- 根因两处，且第二处会造成**数据丢失**：
  1. `tui.tsx` 用量累积器初值恒为 `emptyUsage()`，从不从 `session.meta[usageStats]` 水合 → 重连后从 0 开始。
  2. 持久化 effect 在挂载时无条件执行 `sess.meta = { ..., [USAGE_STATS_KEY]: usage }` 并防抖落盘 → 把已持久化的历史用量**覆盖成全 0**；又因 `usageFromMeta` 对「空累积器对象」照样返回值（非 undefined），`/stats` 显示 0、`/stats-export` 也导不出重连前数据。
- 附带缺陷：`usageFromMessages` 重建时 `recordCall` 未传 `ts`，统一取 `Date.now()`，历史消息会被全部算到「今天」。

### 修复

- `packages/cli/src/usage-stats.ts`：
  - 新增 `hydrateUsage`（meta 有数据优先 → 否则由消息历史重建）、`isBlankUsage`、`shouldPersistUsage`（空累积器不得覆盖已有历史）。
  - 新增当日归集：`dayStart` / `usageSince` / `todayUsage` / `mergeUsage` / `sumUsage` / `todayUsageLine`。
  - `usageFromMessages` 按消息 `createdAt` 归并小时桶（缺失才回落 now），修正跨天归属。
  - 导出报告支持可选 `today`：JSON 增 `today` 字段，Markdown 增「当日汇总（全部会话）」小节。
- `packages/cli/src/tui.tsx`：累积器初值改为 `hydrateUsage(options.session)`；持久化 effect 加 `hydratedSessionRef`（切换/恢复会话时重新水合）+ `shouldPersistUsage` 守卫；新增当日跨会话归集 effect（只读会话文件、不写回）与统计面板「今日 N次 · inX/outY（全部会话）」行。
- `packages/cli/src/index.ts`：`resolveCurrentUsage` 统一走 `hydrateUsage`；新增并导出 `resolveTodayUsage`（跨会话归集当天，失败回落当前会话）；`/stats` 追加当日行，`/stats-export` 报告带当日汇总。

### 验证

- 新增 `packages/cli/src/usage-stats.test.ts`（23 用例：跨天时间归属、当日截取、跨会话小时桶归并、水合优先级、防覆盖守卫、导出字段）。
- 新增 `packages/cli/src/usage-reconnect.test.ts`（3 用例端到端：落盘 → 从磁盘重连 → 用量不为 0；当日只算当天 2/3 次；导出含重连前数据；meta 被写空时由消息历史兜底重建）。
- cli 全量 **225 用例通过**、typecheck 通过。
  （`packages/revert` 的 `FakeSessionManager` 缺 `setBlocks` 为既有类型错误，本次未触碰。）

## 2026-09-14（续 121）ACP 参数组合离线分析脚本 + 压测/分析使用文档

- 新增 `bench/analysis-params.ts`：按「参数组合签名 = params 快照 + window」归并遥测 JSONL 全量事件，
  跨会话聚合同组合指标，输出每窗口「组合 → 会话数/轮数/占用率/ACP缓存命中/Provider命中/压缩比/保留率/t1t2t3」表
  + 跨窗口 ACP 缓存命中率排行（前 15），直接对比不同参数组合的命中率与占用率（可选 `--sessions` 拼 Provider 侧 cacheRead）。
- 修复 `report.ts` / `analysis-params.ts` 公共 `glob` 通配 bug：目录提取应取「星号前一 / 」，文件名按
  `前缀 + .* + 后缀` 重建正则（原来丢弃了 `*` 前的文件名前缀，`t00_*.jsonl` 类 pattern 匹配不到）。
- 新增 `docs/acp-context-benchmark.md`：汇总 `compress-params.ts`（仿真压测）/ `report.ts`（会话分析）/
  `analysis-params.ts`（参数组合分析)三脚本作用、命令参数、输出与推荐工作流；`docs/acp-context-config.md` 顶部加引用链接。
- 验证：`bench/analysis-params.ts` 用合成遥测数据跑通（5 组合正确归并、命中率降序排行正确），acp-context typecheck 通过、全仓库 typecheck 通过。

## 2026-09-14（续 120）ACP 运行时遥测：独立 JSONL 文件 + 离线分析

- 新增 `packages/plugins/acp-context/src/telemetry.ts`：独立 JSONL 遥测模块，三类事件：
  - **preModel**（每轮必记）：ACP 侧压缩指标（压缩比 / 占用率 / 保留率）+ ACP 侧缓存命中（同前缀占比）+ 配置参数快照 + t1/t2/t3 块分布 + nudge 触发建议数
  - **compress**（模型主动调用时）：压缩范围 / 创建块数 / 折叠 token 数 / 块分布变化
  - **providerCache**（模型返回后追加）：provider 侧 cacheRead/cacheWrite（preModel 阶段拿不到，离线从 session 文件 assistant.message.meta.tokenUsage 解析）
- 独立 JSONL 文件，路径由宿主（cli）通过 `telemetryPathBuilder(sessionId)` 注入；debounce 500ms flush，失败吞掉。
- 新增 `AcpContextPluginOptions.telemetryEnabled`（默认 true）+ `telemetryPathBuilder`；未注入时 writer 为 no-op，零额外开销。
- 新增 `bench/report.ts` 离线分析脚本：glob 读遥测 JSONL（可选拼 session 文件 tokenUsage），输出和压测脚本同口径 Markdown 表。
- index.ts 两处埋点：`runPreModel`（processTurn 返回后）+ `compressTool`（applyCompression 返回后）。类型安全，可选字段不破坏现有测试。
- 与续 119 压测脚本口径一致：`rawTok`/`requestTok`/`occupancy`/`compressRatio`/`retention`/`acpCacheHit`/t1t2t3 块数同源，离线报告直接对比压测基线。
- CLI 层接入（续 120.1）：
  - `HarnessConfig.compression.telemetry?: { enabled?: boolean }` 新字段（默认 true），设为 false 关闭遥测。
  - 装配点 `createAcpContextPlugin({ ..., telemetryEnabled, telemetryPathBuilder: (sid) => join(workspace.dataDir, 'sessions', `${sid}.telemetry.jsonl`) })`。
  - 遥测文件落 `dataDir/sessions/{sessionId}.telemetry.jsonl`，与同目录下的 `{sessionId}.json` 配对，`bench/report.ts` 用同一 glob 即可收集。
- 验证：全包 typecheck 通过、acp-context 24 测试全过。

## 2026-09-14（续 119）ACP 压缩压测脚本：`bench/compress-params.ts` 参数 × 上下文长度敏感性分析

- 新增 `packages/plugins/acp-context/bench/compress-params.ts`：由用户 config.json `compression.*` 各可调参数驱动，
  对不同上下文窗口（40k/100k/200k/300k/1m token）做「渐进填充 + 理性模型逐轮顺从 ACP 折叠」压测，
  统计压缩比 / 保留率 / 上下文占用率 / 缓存命中率（相邻两轮投影请求的同前序 token）/ t1/t2/t3 活跃块分布。
- 口径收敛：各窗口以「每步增量 = 窗口固定比例」填充到相近饱和占用率（`--rate=0.9 --steps=30`），
  使不同长度的结果横向可比；同步修复原 `--perTurn` 固定增量导致小窗口步数不缩放、40k/100k 结果失真的问题。
- 支持参数敏感性扫描：`--sweepPreserve`/`--sweepTier2`/`--sweepMaxSummary`/`--sweepMinCompress`。
- 关键结论（基线 `preserveRecentTokens=50000, tier2Trigger=5, tier3Trigger=18, maxContextLimitPct=0.65`）：
  - **缓存命中率随窗口增大而下降**（40k→~88%，1m→~22%）：窗口越大每步增量 token 越多，命中占比被新内容稀释。
  - **`preserveRecentTokens` 相对窗口的比例是关键敏感项**：当其≥窗口（如 50k≥40k）时压缩完全失效、
    占用率高达 91%；降到 8k 以下后 40k 窗口恢复折叠（占用 64%）。对 ≥100k 窗口影响消失。
  - **`tier2Trigger` 仅在小窗口敏感**：越大越迟蒸馏、保留更多 t1 原稿（10→8~9 个 t1 块），大窗口（≥100k）影响甚微。

## 2026-09-14（续 118）ACP 配置文档化：新增 `docs/acp-context-config.md` 配置参考

- 新增 `docs/acp-context-config.md`：ACP 上下文压缩全部配置项的**默认值与逐参数使用说明**。
- 默认值以 acp-kernel `defaultConfig` 实际默认核校：`preserveRecentMessages=5`、`preserveRecentTokens=5000`、
  `promotionThreshold=5`、`tier2Trigger=5`、`tier3Trigger=10`、`nudge.max/min/emergency=0.75/0.45/0.95`、
  `compress.minCompressRange/maxSummaryLength/minSummaryLength=5000/20000/50`、`truncate.threshold=0.95`、
  窗口推导 `modelContextLimit→providers[].contextWindowTokens→200000`。
- 纠正 `packages/cli/src/index.ts` `compression.promotionThreshold` 注释（内核默认是 5，非"极大=不提升"）。
- AGENTS.md 文档索引登记 `docs/acp-context-config.md`。

## 2026-09-14（续 117）ACP 压缩：提示词落 txt、上下文窗口进模型配置、t1/t2/t3 阈值结构化配置

### 背景
承接续 116（ACP 插件接入 CLI + 提示词可配置）。本期落实三点：默认压缩提示词改为插件目录 txt 文件（可本地编辑）；模型上下文窗口从「模型/provider 配置」推导而非写在 compression 里；t1/t2/t3 各层压缩阈值与层保留（preserveRecent*）结构化进入 config.json。

### 改动
- **提示词 txt 化**（packages/plugins/acp-context）
  - 新增 `prompts/compressPhilosophy.txt`、`howToCompressRules.txt`(t1)、`tier2DistillRules.txt`(t2)、`tier3CondenseRules.txt`(t3)——内容为 acp-kernel `defaultPrompts` 原始复制。
  - 新增 `src/prompts.ts`：`loadPromptFiles()` 用 `fs.readFileSync` 读取上述 txt（`import.meta.url` 定位），任一文件缺失该项回退内核默认，全失败才整体回退内核 `defaultPrompts`。
  - 工厂 `createAcpContextPlugin`：`resolvedPrompts = { ...loadPromptFiles(), ...options.prompts }`，`systemPrompt` 仍为最高优先级。移除 `resolvePrompts` 依赖（config 覆盖本就是显式 opt-in，无需 acknowledgeRisk）。
- **上下文窗口进模型配置**（packages/plugin + packages/cli）
  - `ProviderConfig` 新增 `contextWindowTokens?: number`（模型输入窗口，供压缩等消费者判断阈值）。
  - CLI boot 装配 ACP 时窗口推导优先级：`compression.modelContextLimit → 默认 Provider 的 providers[].contextWindowTokens → 插件默认 200_000`。
- **t1/t2/t3 阈值与层保留结构化配置**（packages/cli）
  - `HarnessConfig.compression` 拆出结构化字段：`preserveRecentTokens` / `preserveRecentMessages` / `promotionThreshold` / `tiers.{tier2Trigger,tier3Trigger}` / `nudge.{maxContextLimitPct,minContextLimitPct,emergencyThresholdPct}`，并保留 `config` 高级透传。
  - CLI boot 把这些结构化字段翻译为 kernel `Config` 的 `Partial`（仅填非空的 key）后再传给插件 `config`。
- **测试**：插件新增 `loadPromptFiles` 用例（验证 txt 装载）；CLI 新增 boot 集成用例（compression.enabled 装配 `context.acp`、结构化阈值持久保留）。插件 24 测例、CLI 199 测例、根 typecheck 全绿。

### 配置示例
```jsonc
{ "provider": "my-gw",
  "providers": [{ "id": "my-gw", "type": "openai", "baseUrl": "…", "contextWindowTokens": 200000 }],
  "compression": {
    "enabled": true,
    "preserveRecentTokens": 8000,
    "preserveRecentMessages": 10,
    "tiers": { "tier2Trigger": 5, "tier3Trigger": 10 },
    "nudge": { "maxContextLimitPct": 0.2, "minContextLimitPct": 0.02, "emergencyThresholdPct": 0.98 },
    "prompts": { "howToCompressRules": "…t1…" }   // 缺省则读 prompts/*.txt
} }
```

### 决定
- 提示词基线可本地编辑（txt），config `prompts`/`systemPrompt` 覆盖优先于文件。
- `compression.modelContextLimit` 保留为显式覆盖；缺省走 Provider 的 `contextWindowTokens`，再回退 200000。

### 验证
- `packages/plugins/acp-context`：typecheck + 24 测例过；`packages/cli`：typecheck + 199 测例过；根 `bun run typecheck` 全绿。

## 2026-09-14（续 116）ACP 上下文压缩：接入 CLI 配置文件入口 + 提示词可配置

### 背景
ACP 插件此前需代码内 `createAcpContextPlugin` 手动装配，且压缩提示词（t1/t2/t3/哲学）与压缩系统提示硬编码不可配。本次把它正式接入 CLI——`config.json` 新增 `compression` 段作为入口，并按「提示词可配置」落实（t1/t2/t3 规则逐层可覆盖、压缩系统提示可整段覆盖）。core 侧统一块模型（`setBlocks`/`blocksPatch`/`source:'acp'`）前期已完成，本次不改 core。

### 改动
- **插件 `@harness/acp-context`**（packages/plugins/acp-context/src/index.ts）
  - `AcpContextPluginOptions` 新增 `prompts?: Partial<Prompts>`（t1=`howToCompressRules`、t2=`tier2DistillRules`、t3=`tier3CondenseRules`、哲学=`compressPhilosophy`）和 `systemPrompt?: string`（整段覆盖，优先级最高）。
  - 工厂启动期解析一次：`resolvedPrompts = options.prompts ? resolvePrompts(options.prompts,{acknowledgeRisk:true}) : defaultPrompts`；`makeSystemPrompt()` 优先生效 `systemPrompt`，否则 `buildCompressSystemPrompt(resolvedPrompts)`。
  - `session.preModel` 复用该 `makeSystemPrompt`，并把 `resolvedPrompts` 透传进 `runPreModel`，nudge 渲染 `renderNudgeText(nudge, prompts)` 与系统提示保持同一套自定义提示（`RunPreModelDeps` 新增 `prompts?`）。
  - 测例 +2（共 25）：`systemPrompt` 整段覆盖后系统提示即该串；`prompts` 覆盖 t1 后系统提示体现自定义规则且默认提示不被冲掉。
- **CLI `@harness/cli`**（packages/cli/src/index.ts + package.json）
  - `HarnessConfig` 新增 `compression?: { enabled, modelContextLimit, prompts, systemPrompt, config }`。
  - `boot()` 在 `createHarness` 前：`compression.enabled` 为真才 `lazyImport('@harness/acp-context')` 惰性装配并透传配置（默认关闭、惰性加载，符合 CLI 不硬编码依赖风格）。
  - `buildConfigOverview`（/config、config check）新增一行「上下文压缩（ACP）：启用/未启用」状态，自定义提示词时标注。
  - cli/package.json 增加 `@harness/acp-context: workspace:*`。
  - 测例 +1（共 198 pass）：config 概览展示 ACP 启用/未启用与 fitWindow/自定义提示词。

### 配置示例
```jsonc
{ "compression": {
    "enabled": true,
    "modelContextLimit": 200000,
    "config": { "preserveRecentTokens": 8000, "preserveRecentMessages": 10 },
    "prompts": { "howToCompressRules": "…t1…", "tier2DistillRules": "…t2…", "tier3CondenseRules": "…t3…" }
} }
```

### 决定
- **默认关闭**：`enabled` 缺省 false，改变行为需显式开启。
- **提示覆盖承担质量风险**：`prompts` 经 `resolvePrompts(...,{acknowledgeRisk:true})`，load-bearing 字段，错误类型静默丢弃。
- **不新增 CLI 子命令**：仅 `config.json` 作为配置文件入口；`/config` 只展示不运行时改。

### 验证
- 插件 typecheck + 25 测例全过；CLI typecheck + 198 测例全过；根 `bun run typecheck` 全绿。

## 2026-09-14（续 115）ACP 压缩率压测：不同上下文长度下的输入瘦身压缩比

### 背景
需要量化「模型使用 ACP」在 40k/100k/200k/300k/1m token 上下文窗口下的输入瘦身压缩率，并沉淀可复用 bench。

### 代码勘察结论（决定口径）
- ACP 的**智能折叠靠模型驱动**：`engine.processTurn` 只指派 refs/裁剪/产出 nudge 建议并渲染调用链，真正的折叠由模型调 `compress` 工具 → `applyCompression`；`emergencyTruncateNode` 仅截超大工具输出。→ 纯 `runPreModel` 单轮测不出压缩，需模拟"模型主动压缩"。
- `estimateTokens` = chars/4（与 acp-kernel 默认 tokenizer 一致），作为压缩率统一估算器。

### 改动
- 新增 `packages/plugins/acp-context/bench/ratio.ts` + `package.json` 脚本 `bench:acp-ratio`：
  - 口径：`baseTok=系统提示+全量`，`requTok=系统提示+ACP 折叠后投影`；保留率=requTok/baseTok，压缩比 inverse。
  - 模拟「理性模型」循环：每轮 `processTurn` 取 `nudge.compressibleRanges`,立即 `applyCompression`,直至无建议收敛（等价模型每次都顺从 ACP 建议）。
  - 窗口口径：`modelContextLimit=L`、历史填满窗口触发压缩；`--lengths/--keep/--perMsg` 参数化；摘要用固定占位（≈50 token/块）。
- 新增方案 `.trae/documents/上下文压缩-ACP压缩率压测.md`（口径、方法、结果、局限）。

### 首压结果
- 全压档(take0)：40k→24.2x(4.1%)、100k→34.9x(2.9%)、200k→41.3x(2.4%)、300k→44.0x(2.3%)、1m→85.9x(1.2%)；块数 13→157。
- 保留近期 8k 档：40k→4.2x、100k→9.3x、200k→15.7x、300k→20.3x、1m→51.1x。
- 解读：压缩比随上下文长度亚线性增长；固定保留占比随窗口稀释。真实使用（渐进压缩）稳态略低于此上限。

### 局限
- 摘要为占位（真实模型更长、受 maxSummaryLength=25000 封顶）；chars/4 在 CJK/真实 tokenizer 下压缩比会回调；一次性满载为"最高可达"而非长期逐轮稳态。

## 2026-09-13（续 114）上下文压缩·统一块模型性能压测（可复用 bench，mock 模型）

### 背景
遗留项4（风险表记项）：`session.compacting` 敏感路径「折叠时才落块、不折叠不写」已实现，但 `setBlocks`/`blocksPatch` 的合并去重与持久化频率是否最优未量。本次落地可复用压测脚本（先 mock 模型+合成数据，后续可切真实 ChatProvider 复跑），给该项一次定量结论。

### 改动
- 新增 `packages/core/bench/helpers.ts`：`createMockProvider`/`makeAgent`/`makeMessages`/`makeBlocks`/`createSessionId`/`timeMs`，装配低成本 mock 环境。
- 新增 `packages/core/bench/block-perf.ts` 三个场景：
  1. **setBlocks 规模伸缩**：已有 N 块基础上追加 1 块，量 the whole-array 重建成本随 N 的线性。
  2. **完整 query 链路**：mock model + 插件每轮 `session.preModel` push 1 个 `source:'acp'` 块，测每轮写块频率与平均 query 耗时。
  3. **compactIfNeeded 折叠门控**：每轮真折叠 vs 不折叠 no-op，对比写块侧成本。
- `package.json` 增 `bench:blocks` 脚本；CLI 支持 `--scenario`/`--rounds`/`--sizes`/`--rep`。

### 首压结论（mock 数据）
- **场景1**：append 1 块成本 ~17μs@100 块 → ~1.1ms@20000 块，随块数线性；绝对值低，真实会话块数级（<几千）在亚毫秒内。
- **场景2**：200 轮共 201 块，平均 0.04ms/query，每轮写块开销可忽略。
- **场景3**：真折叠 0.0145ms vs no-op 0.0012ms（约 12×），但均为微秒级。
- 结论：风险项4 **性能无瓶颈**，降级为低风险观察项；若极端会话（数万块）再优化（如新增块时才重建数组、跨重启不重灌全量块）。

### 后续
- 需真实模型时：`createHarness({ chatProvider: <真实Provider> })` 复跑其余装配不变。
- 场景3 首次压测曾因两处 bug 失真（`h.session.create()` 返回对象被当 id、幂等 id 去重成单块），已修复。

## 2026-09-13（续 113）上下文压缩·遗留项2：ACP 每轮内部压缩块同步进 session.blocks（统一块模型补写 runPreModel 侧）

### 背景
续 110 统一块模型整合后，`session.blocks` 只覆盖了 `session.compacting`（core 物理裁剪）时折叠出的窗口；`runPreModel` / 模型主动 compress 产生的 ACP 内部块（tier 1/2/3）仍只落在 `meta['acp.v1']` 的 messageRefs。`/revert` 与全历史重建无法定位 ACP 每轮内部折叠量。本次按统一块模型文档第 4 步补写 `runPreModel` 侧，使全部折叠量（无论来自 compacting 还是 ACP 每轮内部）都进入同一份 `session.blocks`。

### 改动

**packages/plugin/src/index.ts**
- `SessionPreModelInput` 新增 `blocksPatch?`：插件把本轮折叠产出的块（`id`/`topic`/`summary`/`startId`/`endId`/`source`/`archiveRef`）回传给 host，Host 合并进统一块模型。

**packages/core/src/index.ts**
- `SessionManager.setBlocks(sessionId, blocks)`：按块 id 合并去重（覆盖）写入 `session.blocks`，并填充 `at` 时间戳；`blocks` 为空或会话不存在时 no-op。
- 复用了 `session.preModel` 钩子返回的 `blocksPatch`：查询路径里 `triggerPlugin('session.preModel', { ..., blocksPatch })` 后，若回传块非空则调用 `session.setBlocks` 落库。

**packages/session/src/index.ts**
- `CompactionBlock.at` 改为可选（`at?: number`），由写入方 `setBlocks` 填充，兼容 blocksPatch 未带时间戳。

**packages/plugins/acp-context/src/index.ts**
- `AcpSessionCtx` 新增 `recordedBlockIds: Set<string>`，记录已回传 session.blocks 的 ACP 内部块 id（幂等，避免每轮重复写）。
- `runPreModel` 新增 `recordBlocks?` 回调；折叠轮筛选未回传的块，用 `coveredSpan` 计算断点索引 `startId`/`endId`，构造 `source:'acp'` 块（`archiveRef: acp:<sessionId>:<blockId>`）经回调 push 进 `input.blocksPatch`，并更新 `recordedBlockIds`。缺省 `recordBlocks` 时（无 host blocksPatch 的测试/独立环境）仅落在 ACP 自身状态，不破坏既有行为。

### 验证
- acp-context 新增 `recordedBlockIds` 字段与环境初始化，21 用例全绿。
- core 新增用例：`session.preModel` 回传 `blocksPatch` 后 ACP 块合并进 `session.blocks`（`source:'acp'`），多轮幂等去重（第二次 query 不重复写块）。
- `CompactionBlock.at` 可选化后，cli `tui.tsx` 排序处补 `?? 0`，全 workspace typecheck 通过。

### 后续
- ACP 内部折叠块现与通用 compact 块同源；后续 `revert`/全历史重建可直接经统一 loader 消费两类块。

## 2026-09-13（续 112）上下文压缩·遗留项3：decompress/search_context 走断点索引回读原文容器（tier 嵌套还原 + 跨重启原文持久化）

### 背景
阶段三收尾后，`decompress`/`search_context` 的原文回溯仍只依赖进程内 `ctx.archive`（meta 水合原文），跨重启后 ACP 内部逐层（tier2/3 嵌套）折叠块的完整还原路径未完全打通到统一 loader。本次实现"断点索引回读原文容器"：①折叠窗口原文在 `runPreModel`/`runCompacting` 折叠轮持久化进 `session.meta[acp.archive.v1]`；②`restoreBlockMessages` 递归收集 `directBlockIds` 覆盖的嵌套子块消息 id，保证 tier2/3 完整还原；③工具输出附 `startId`/`endId` 断点索引，对齐 CLI `resolveAcpBlockOriginals` 的容器切片回读。

### 改动

**packages/plugins/acp-context/src/index.ts**
- 新增 `collectCoveredIds(state, block, out)`：递归收集块的 `effectiveMessageIds` + `directMessageIds` + 其 `directBlockIds` 嵌套子块覆盖的全部消息 id/ref。
- `restoreBlockMessages` 改为经 `collectCoveredIds` 走断点索引回读：不仅取回直连消息，还穿透 tier2/3 子块还原完整原文。
- 新增 `ctx.archivedKeys: Set<string>`，记录已持久化到 `ACP_ARCHIVE_KEY` 的键，供幂等合并；`runPreModel` 水合时与 `runCompacting` 水合时同步填充（跨重启不重复写）。
- `runPreModel` 折叠轮（新增块或已有块覆盖未归档原文）把所覆盖原文合并持久化到 `session.meta[ACP_ARCHIVE_KEY]`，解决跨重启原文丢失。
- `compress` 的 `DecompressOutput` 与 `search_context` 的 `SearchResult` 增加断点索引 `startId`/`endId`；新增 `blockSpan`（还原数组→夹角）与 `coveredSpan`（状态+归档轻量计算）。

### 验证
- acp-context 新增用例：`collectCoveredIds` tier 嵌套深度收集、`restoreBlockMessages` tier 嵌套完整还原、`blockSpan`/`coveredSpan` 断点索引、`runPreModel` 压缩块创建后原文持久化到 `ACP_ARCHIVE_KEY` 且跨重启新 ctx 仍可还原全文。
- acp-context 21 用例全绿；单包 typecheck 通过。CLI 侧 `loadFullHistory`/`resolveAcpBlockOriginals` 已在此前的统一块模型接线中消费该容器，无需改动。

### 后续
- `.cmp.json`/断点索引（阶段一产物）仍无需接入 ACP：当前经 `session.meta` 归档已满足跨重启回溯；如需压缩文件独立出 meta 防膨胀，再回到 `SessionCompactionStore` 路线。

## 2026-09-13（续 111）上下文压缩·阶段四：TUI 前端按需渲染（压缩提示行 + 惰性展开 + 更早分页）

### 背景
续 110 统一块模型落地后，压缩块已进入 `session.blocks`，但 TUI 历史渲染仍是 `setSession` 时一次性 `messagesToBlocks(s.messages)` 全量转换：压缩过的会话看不到压缩块（原文在盘只存档案），未压缩的超长会话首屏也会全量构建 ChatBlock。本次实现前端按需渲染：压缩块渲染为**提示行**（不渲染内容，仅提示"已自动压缩"），点击经 loader 惰性取回原文；超长近期段只渲染最近一页 + "更早省略"提示、点击向前加载。

### 改动

**packages/cli/src/tui.tsx**
- `ChatBlockKind` 增加 `'compact' | 'loadmore'`；`ChatBlock` 增加可选 `msgId`（关联原文消息）/ `blockId`（关联压缩块）/ `loading`（展开中）。
- `messagesToBlocks(messages, blocks?, page = HISTORY_PAGE)`：`blocks` 按 `at` 升序渲染为 compact 提示块置于最前（无 blocks 零变化）；`messages` 超过 `page`（100）条时只渲染最近一页 + loadmore 提示块。
- 新增纯函数 `compactBlockText`（只显示来源/主题/摘要字数，不渲染摘要全文）、`expandCompactBlocks`（把某块原文替换提示块位置）、`loadOlderBlocks`（插入更早一页，到底移除提示）。
- `TuiReplOptions` 增加可选 `loadHistory`；`renderBlockBody` 增加 compact/loadmore 分支（dim 提示行，鼠标点击展开/加载更多，loading 显示 ⏳）；`TuiApp.setSession` 传 `s.blocks` 渲染压缩提示行。

**packages/cli/src/index.ts**
- `loadFullHistory` 增加 `range.blockIds` 分支：只对命中块逐个 resolve 取原文段返回（按块惰性加载，不回落全量）。
- `startTuiRepl` 注入 `loadHistory: (sid, range) => app.loadFullHistory(sid, range)`。

### 验证
- tui 纯函数用例：compact 提示文本（acp/通用来源、不渲染摘要）、blocks 前置 + at 升序、无 blocks 零变化、超长分页 + loadmore、expand 命中/未命中/空原文、loadOlder 两页到底移除提示。
- cli 用例：`loadFullHistory({ blockIds })` 只返回命中块原文、未命中返回空。
- cli 197 全绿（新增 7 用例）；session/workspace/core 回归全绿；全仓 typecheck 通过。

---

## 2026-09-13（续 110）上下文压缩·统一块模型整合（ACP 折叠并入 session.blocks + revert 全文回溯）

### 背景
续 106~109 分别打通了「通用 compact 块 + 原文落盘（Route B）」、「session.compacting 接线 + ACP 协同」。但两块体系仍未统一：ACP 压缩块（`acp-kernel` 内部摘要）与 `session.blocks` 不一致，且 ACP 压缩频率较高、一次对话会多次压缩——导致 `view.slimmed` 请求瘦身漏掉 ACP 折叠量、高频多块在 `sess.blocks` 中无从定位、`/revert` 无法只回退最近消息（边界可能已缩进块里）。本次把两类折叠收敛为**统一块模型**：给块打 `source: 'generic' | 'acp'` 标记 + ACP 折叠经 `blocksPatch` 并入 `session.blocks`，定位/取回/回退统一走同一套块 & 原文回溯路径。

### 改动

**packages/session**
- `CompactionBlock` 增加可选 `source: 'generic' | 'acp'`、`archiveRef?: string`（ACP 原文取回引用）。
- `SessionOriginalStore` 增加可选 `loadRef?(sessionId, ref)`（按引用取回原文，供 ACP 归档）。
- 新增 `buildResolveBlock(store, sessionId)`：统一取原文入口——acp 块优先经 `loadRef(archiveRef)`，失败回退 `load(origKey ?? id)`；generic 走 `load`。

**packages/workspace**
- `createWorkspaceOriginalStore` 增加 `loadRef`：`orig:{sessionId}:{blockId}` 转本地归档读，其他（`acp:`）返回 undefined（交回 CLI/宿主的 ACP 归档）。

**packages/core**
- `compact()`：`windowHandled`（ACP 已认领窗口）时跳过硬编码 generic 块生成，避免同一窗口双击/双归档；产 generic 块标 `source: 'generic'`。
- `compact()`：消费插件回传 `compactCtx.blocksPatch[]`，按块 id 合并去重进 `sess.blocks`（`at: now`）。

**packages/plugins/acp-context**
- `runCompacting`：折叠成功后构造 `source:'acp'` 块（topic=ACP 折叠、startId/endId、archiveRef=`acp:{sessionId}:{blockId}`）回传 `input.blocksPatch`；窗口已被覆盖时置 `windowHandled=true` 不重复折叠。

**packages/revert**
- `SessionRevertOptions` 增加可选 `getFullHistory`；`stage()` 经全文回溯定位 boundary：折叠后边界已不在近期消息时也能在完整历史中定位并收集边界之后文件快照，实现「只回退最近消息」。

**packages/cli**
- `loadFullHistory` 按块 `source`/`archiveRef` 区分双源取数：acp 块经 `session.meta['acp.archive.v1']`（`resolveAcpBlockOriginals` 按 startId/endId 切片）还原，generic 块经 `originalStore` 还原。
- 新增 `getFullHistory`（=`loadFullHistory`）供 `/revert` 插件注入，实现压缩后全文定位。

### 验证
- session `buildResolveBlock`（source/引用/回退）单测；workspace `loadRef` 单测；core 统一块模型用例（generic/ACP 双源块入 blocks、windowHandled 免重复）；acp-context `runCompacting` 产出 blocksPatch 用例；revert 折叠块内 boundary 定位用例。
- 所涉包全绿：session 15、workspace 27、core 40、revert 36、acp-context 16、cli 190；全仓 typecheck 通过。
- 全仓 `bun test` 的失败均为 `reference/`（opencode-dev）环境性失败（缺 `react/jsx-dev-runtime` 等依赖），与本次改动无关。

---

## 2026-09-13（续 109）上下文压缩改造·阶段二后续（Route B 彻底）：内存瘦身 + 原文落盘 + 惰性回溯

### 背景
续 106/107 确立「内存视图 + 惰性加载」接口骨架、续 108 由 ACP 经 `session.meta` 保全窗口原文。但通用 `compact()` 仍物理截断 `sess.messages`，被删窗口原文一旦离开会话文件即失效，`.cmp.json`/断点索引也未接入核心读取路径。本次落实 Route B 彻底改造：内存只驻留「压缩摘要块 blocks + 近期消息」，被压缩窗口原文落盘到独立档案，按需经 loader 还原——内存瘦身 + 请求 token 瘦身 + 全文可回溯三赢，且不依赖 ACP（ACP 可启停）。

### 改动

**packages/session**
- `CompactionBlock` 增加可选 `origKey`（原文在 OriginalStore 的 key，缺省=block.id）。
- 新增共享接口 `SessionOriginalStore`（`save`/`load`），供 core/workspace/cli 跨包引用。
- 新增纯函数 `reconstructHistory(sess, resolveBlock?)`：按 `blocks` 顺序经 resolveBlock 取回各块归档原文，再拼近期 `messages`，按 id 去重、稳定排序还原全文。
- `buildView` 语义不变（blocks+messages+slimmed），摘要占位只在 core 请求组装处插入，避免波及 revert 的 FakeSessionManager。

**packages/workspace**
- `SessionCompactionStore` 新增原文档案读写：`saveOriginals`（写 `sessions/{id}.cmp.orig/{blockId}.json`，tmp+rename 原子）、`loadOriginals`、`countOriginals`（该会话归档消息总数，供 list 计数）。
- 新增工厂 `createWorkspaceOriginalStore(ws)`，把上述方法适配成 `SessionOriginalStore`（CLI 注入 core 用）。
- `SessionFileStore`：`SessionFile` 增加 `blocks` 字段并随 `save/load` 往返；`list().messageCount` = 近期 + `countOriginals`（仍反映全量）。

**packages/core**
- `AgentHarnessOptions`/`SessionServices`/`HarnessImpl` 注入可选 `originalStore`。
- `compact()`：裁剪前若 `windowToPrune` 非空，生成 `b_{ts}_{rand}` 块 id，`originalStore.save` 落盘窗口原文（best-effort，失败仅告警不阻断），并把块追加进 `sess.blocks`（`topic=会话压缩`、`startId/endId` 断点、`origKey=blockId`）。
- `_prepareQuery`/`query`/`queryStream`：有压缩块（`view.slimmed`）时请求历史改为「`renderBlocksAsMessage(blocks)` 摘要占位 + `view.messages` 近期」，不再全量拼接原文；无块零变化。
- `exportMarkdown`：`sess.blocks` 存在时经 `flushHistory` 取全文再导出。

**packages/cli**
- `createHarness` 注入 `createWorkspaceOriginalStore(this.workspace)`。
- `boot()` 会话恢复处：`session.blocks = saved.blocks`，存在块时 `setHistoryLoader` 注册惰性加载器。
- `/resume` 命令同样补 `blocks` + 注册 loader；恢复条数改用 `loadFullHistory` 汇报全量。
- 新增 `loadFullHistory(sessionId, range?)`：以近期+blocks 为骨架经 originalStore 逐块取回原文，`reconstructHistory` 合并去重排序，支持按 id 范围过滤；无块/读盘失败 best-effort 返回近期。

### 验证
- session `reconstructHistory` 单测；workspace `saveOriginals/loadOriginals/countOriginals` + blocks 写读 + `list.count` 单测；core 新增 Route B 用例（compact 产块+归档、无 store 不阻断、query slim 视图、export 全文）。
- 所涉包全绿：session 10、workspace 26、core 38、cli 190；acp-context 16、revert 35 不破；全仓 typecheck 通过。
- 全仓 `bun test` 的 607 失败均为既有 opentui/DOM/TUI 环境性失败，与本阶段改动无关。

### 后续
- revert `/revert` 目标是近期消息，天然可工作；若边界已被压缩进块（历史回滚）为已知限制，留待阶段四经 loader 全文回滚。
- 阶段四：TUI/Web 历史按需分页渲染，压缩块只显示提示行。

---

### 背景
续 107 `runCompacting` 折叠窗口原文只进内存 `ctx.archive`，重启即失；且 core 每次都物理删除窗口，`.json` 里的断点也无从回读。本次打通"跨重启后 `decompress` 仍能还原被 session 压缩删掉的窗口全文"。

### 改动
**packages/plugin**
- `CompactionContext` 增加 `meta` 访问器（`read`/`patch`，与 `session.preModel` 同义），供插件在物理删除前持久化到 `session.meta`。

**packages/core**
- `compact()` 构造 `compactCtx.meta`，用会话自身的读/写实现（`sess.meta` + `updatedAt`），把真实持久化入口交给 ACP。

**packages/plugins/acp-context**
- 新增 `ACP_ARCHIVE_KEY = 'acp.archive.v1'`，把被折叠窗口的原文（coreId → Message）持久化到 `session.meta`（覆盖式合并窗口内原文，不下沉本轮新消息）。
- `runCompacting` / `runPreModel` 水合时从 meta 恢复归档进 `ctx.archive`，保证跨重启后 `restoreBlockMessages`/`decompress` 仍能还原全文。
- hook 注册改为透传 `compactCtx.meta`（替换此前的假 meta）。

### 验证
- 新增 1 用例：折叠后 meta 持久化状态+原文归档，模拟全新 ctx 从 meta 水合后仍可还原窗口全文；acp-context 16 全过。
- core 35 全过；全仓 typecheck 通过。

### 后续
- `.cmp.json`/断点索引（阶段一产物）仍无需接入 ACP：当前经 `session.meta` 归档已满足跨重启回溯；如需压缩文件独立出 meta 防膨胀，再回到 `SessionCompactionStore` 路线（阶段四前的可选优化）。

---

## 2026-09-13（续 107）上下文压缩改造·阶段三：session.compacting 接线 + ACP 协同

### 背景

前两阶段建立了压缩消息文件/断点索引与内存视图接口骨架，但两条压缩管线（session 原生 Compaction 物理回收 / ACP 模型压缩）存在时序冲突：进入会话时 `compactIfNeeded` 可能先物理删旧文，破坏 ACP 保的"全文可回溯"。阶段三目标：把此前从未接线的 `session.compacting` hook 真正打通，让 ACP 在 core 物理删除窗口前先保全原文。

### 改动

**packages/plugin**
- `CompactionContext` 扩展 `window`（待压缩窗口，只读参考）与 `windowHandled`（插件已保全窗口，core 可放心删除）。

**packages/core**
- `compact()` 在真正删除窗口前触发 `session.compacting` hook，传入 `{ agentId, sessionId }` 与 `compactCtx`（含 `window`）。
- 消费插件改写：`keepLast` 变化 → 重算保留段/裁剪窗口；`strategy` 覆盖；`summary` 已提供则跳过自行生成（避免双份摘要）。
- `SessionServices` 新增 `triggerPlugin`，并把 `createHarness` 的构造处接入（复用 AgentRuntime 的 trigger 桥）。

**packages/plugins/acp-context**
- 注册 `session.compacting` hook，处理核心为可单测纯函数 `runCompacting`：先水合 ACP 压缩状态 → 把窗口整体压平成 core，幂等判定（复用 `coveredMessageIds`，已覆盖即跳过并仅置 `windowHandled`）→ 对"尚未覆盖"片段指派 refs 并折叠成一个摘要块（规则摘要兜底）→ 窗口原文归档进 `ctx.archive`（折叠后 decompress 仍可全文还原）→ 状态持久化到 `session.meta`，并把 `summary`/`windowHandled` 写回给 core。
- 导出 `defaultRuleSummary` 作规则摘要兜底。

### 验证

- acp-context 新增 3 用例：折叠+豁免 core 摘要、幂等（二次处理不重复折叠）、折叠后 decompress 仍可还原窗口原文；15 测试全过。
- core 35、revert 35 全过；全仓 typecheck 通过。

### 后续

阶段三摘要在 ACP 侧落进 `session.meta`，`decompress`/`search_context` 的原文回溯暂依赖进程内 `archive` 归档；跨重启的全文回读待阶段三收尾接入断点索引回读（`HistoryLoader`/压缩消息文件）。阶段四：TUI/Web 历史按需分页渲染。

---

## 2026-09-13（续 106）上下文压缩改造·阶段二：压缩视图接口骨架

### 背景

阶段一完成"会话压缩消息文件 + 断点索引"持久层后，阶段二本应切"内存视图 + 惰性加载"。考虑到 `query`/`resume`/TUI 均直接消费 `Session.messages` 全量数组，直接改核心风险高；经确认采取「先搭接口骨架、默认退化、标题不切 query/resume」路线：先确立视图类型与惰性加载接口，为阶段三接入数据做准备，现有行为零变化。

### 改动

**packages/session**
- 新增类型：`CompactionBlock`（与 workspace 的 CompactionBlock 同构，session 不反向依赖 workspace）、`SessionView { blocks, messages, slimmed }`、`HistoryLoadRange`、`HistoryLoader { load(sessionId, range?) }`。
- 纯函数：`buildView(blocks?, messages)`——无 blocks 时退化为 `slimmed=false、messages 原样`，保证无压缩块时零行为变化；`renderBlocksAsMessage(blocks?)`——把压缩块渲染为一条 user text 摘要占位消息，供未来 query 折叠已压缩历史。
- `Session` 新增可选字段 `blocks?: CompactionBlock[]`（内存驻留的已压缩历史摘要；缺省表示未启用压缩视图）。
- `SessionManager` 接口新增：`getView`、`setHistoryLoader`、`flushHistory`。

**packages/core**
- `DefaultSessionManager` 实现三方法：`historyLoaders` Map 承载注入的 loader；`getView` 经 `buildView(sess.blocks, sess.messages)`；`flushHistory` 调注入 loader、失败 try/catch 容错返回空，不抛错。

**packages/revert**：`FakeSessionManager` 补齐三方法。

### 验证

- session 新增 6 用例（buildView 退化/精简、renderBlocksAsMessage、CompactionBlock 结构）全过；revert 35、core 35 全过；全仓 typecheck 通过。

### 后续

阶段二将"标题接核心"：query 的 finalMessages 改从 `getView()` 组装（含 `renderBlocksAsMessage` 折叠历史）、cli resume 改为加载「摘要块+近期」；届时需将与 ACP 增量缓存（基于 finalMessages 原文 id）的交互一并验证。阶段三：`session.compacting` 接线 + ACP 协同。

---

## 2026-09-13（续 105）上下文压缩改造·阶段一：会话压缩消息文件存储

### 背景

按 `docs/context-compression-plan.md`（V5 定稿）推进"内存只驻留压缩摘要块+新消息、全文盘上原样保留、按需惰性加载"的改造。阶段一打地基：确立"原文不动 + 摘要文件覆盖 + 可从块定位原文段"的持久层，不改内存结构、不拆 messages。

### 改动（packages/workspace）

1. 新增 `src/compaction-store.ts`：`SessionCompactionStore`
   - 旁路只读落盘文件 `sessions/{sessionId}.cmp.json`（`CompactionFile`，含 `version:1` + blocks），与既有原文文件 `{id}.json` 共存。
   - 类型：`CompactionBlock { id, topic?, summary, startId, endId, at }`；`CompactionPoint { blockId, file, startId, endId, summary }`。
   - 写路径：`save()`（覆盖式整体写，对应"每次压缩覆盖内容"语义；`append=true` 则合并去重追加）、`append()`；tmp + rename 原子落盘。
   - 读路径：`load()` / `loadBlocks()` / `readBlock()` / `exists()`。
   - 断点索引：`buildIndex()` 由 blocks 生成 `blockId → { file, startId, endId, summary }`，`file` 指向该会话原文文件，供 loader 按块定位原文 id 段。
   - 导出常量：`COMPACTION_FILE_VERSION`、`COMPACTION_META_KEY`（会话 meta"已启用压缩文件"预留键）。
2. `src/index.ts` 导出 `compaction-store`。
3. 新增 `src/compaction-store.test.ts`：9 个用例（路径定位、覆盖式、append 去重与同 id 更新、blockId 注入、文件结构、buildIndex、readBlock、无文件安全默认、tmp 无残留）。

### 验证

- workspace 包 23 pass 0 fail（含新增 9）；全仓 typecheck 通过。
- 原文文件与既有 SessionFileStore 行为零改动（回归覆盖）。

### 后续

阶段二：session 内存视图 + 惰性加载；阶段三：`session.compacting` 接线 + ACP 协同；阶段四：前端按需渲染。

---

## 2026-09-12（续 104）ACP 压缩增量渲染缓存优化

### 背景

针对「每轮都进 `session.preModel` 是否性能受影响」的疑问，选定"增量 + 缓存"路线：内核 `processTurn` 每轮对完整历史跑 pipeline（assignRefs→sync→prune→recommend→nudge→truncate），其 O(n) 核心扫描不可避免；真正可省的是宿主侧**历史前缀反复 `core↔message` 往返渲染**（`toCores`/`requestMessages`）的开销。

### 改动（packages/plugins/acp-context）

1. `AcpSessionCtx` 新增增量缓存字段：`prefixIds`（已渲染前缀的原始消息 id 序列）、`prefixRender`（对应渲染结果，不含 system）、`needFull`（是否强制全量重建）、`lastTokens`（最后一次全量的 token 估算）。
2. `adapter.ts` 导出 `baseId`（核心链路需按原始 id 前缀反解 core 数）。
3. `runPreModel` 渲染路径二选一：
   - **增量（常态）**：当 `!needFull`、缓存前缀与当前历史前缀逐 id 对齐、且 `res.messages` 与输入 cores 等长（本轮无压缩/截断）时，复用 `prefixRender`，只对新增尾部 core 做 `requestMessages`；并把尾部并入缓存供下一轮继续命中。
   - **全量**：压缩发生 / 历史前缀漂移 / 消息数变化（截断）时全量重建并刷新缓存。
4. 安全兜底：本轮 `res.messages` 数量 ≠ 输入 cores 数量（发生了压缩/截断）即强制 `needFull`，避免缓存与请求内容错位。
5. `compress` 工具 `applyCompression` 后置 `needFull = true`（块结构/历史已改写，缓存失效）。

### 设计取舍

- 压缩是**旁路优化**，失败仅 warn 不阻断本轮模型请求；增量缓存命中失效也只会回落全量，不影响正确性。
- 常态下只对新增尾部做渲染 + token 估算，超长会话的每轮宿主开销从 O(总量) 降到 O(新增尾部)；一旦真正压缩/截断则下一轮全量一次，之后恢复增量。

### 验证

- acp-context 单测 12 pass 0 fail：新增增量命中（前缀复用+尾部并入缓存）、压缩后置 needFull 全量重建、前缀漂移回落全量。typecheck 通过。
- 架构文档 `docs/agent-harness-architecture.md` 新增 3.9 节（ACP 插件：session.preModel 接入、模型驱动压缩分工、持久化与恢复、增量缓存）与第四节补充示例，并区分其与 session 原生 Compaction 的正交关系。

---

## 2026-09-12（续 103）补全 ACP 压缩会话状态与原始消息持久化

### 背景

续 102 实现 ACP 上下文压缩插件后遗留两个取舍：压缩状态仅存内存、重启丢失；被压缩的原始消息被移出历史、decompress 无法还原全文。本次补全两者。

### 改动

1. **core**（packages/core/src/index.ts）
   - `DefaultSessionManager` 新增 `updateMeta(sessionId, patch)`：浅合并写入 session.meta（随 SessionFileStore 落盘）。
   - `session.preModel` hook 输入新增 `meta: { read, patch }`（query 与 queryStream 两处），让插件可读写 session.meta 持久化运行时状态。
2. **plugin**（packages/plugin/src/index.ts）
   - `SessionPreModelInput` 新增 `meta` 访问器。
3. **`@harness/acp-context`**（packages/plugins/acp-context）
   - 会话上下文（AcpSessionCtx）新增 `archive`（core.id→原始 Message）、`hydrated`、`stateSnapshot`。
   - `runPreModel`：
     - 首次从 `session.meta[ACP_META_KEY]` 水合压缩状态（重启恢复）；
     - 每次保留本轮原始消息归档（即使被压缩出请求，仍可全文还原）；
     - 压缩状态变化时写入 meta（按 stateSnapshot 判重，避免每轮无谓 IO）；
     - **不再裁减持久历史**——会话历史保留全文，压缩只作用于"本轮发给模型的请求"。既满足原始消息持久化，也让块的可解析性跨重启稳定。
   - 新增导出 `restoreBlockMessages(engine, state, archive, blockId)`：按"ref→core id→归档 Message"反解，返回被压缩原始消息全文。`decompress` 工具输出 `originalMessages` 字段。
   - `session` 包 `SessionManager` 接口新增 `updateMeta`，同步补齐 revert 测试 Fake。

### 设计取舍

- 压缩不回收持久化存储（会话历史保留全文），只节省每次请求的上下文 token；换取「decompress 可完整还原原文」与「块跨重启稳定」。若需存储回收，可由宿主另行调用既有 `session.compact`。
- 压缩状态仍按会话随 `session.meta` 落盘，重启后水合；`CompressionState` 为纯 JSON，可安全 `JSON.stringify` 持久化，契合 kernel "refs survive restarts" 的设计。

### 验证

- acp-context 单测 8 pass 0 fail：adapter 压平/还原；普通轮状态入 meta、请求含完整历史并注入 ACP 哲学；压缩后请求被精简 + 状态持久化 + `restoreBlockMessages` 还原原文；重启后从 meta 水合、块仍可定位。
- core / plugin / session / revert 单测与类型检查通过；全量 typecheck 通过。

---

## 2026-09-12（续 102）ACP 上下文压缩插件（基于 acp-kernel）

### 背景

基于参考插件 [billion-context](https://github.com/ranxianglei/billion-context) 所拆出的纯引擎 [acp-kernel](https://github.com/ranxianglei/acp-kernel)（零宿主依赖，MIT），实现本项目自己的上下文压缩插件。采用**直接引用功能包做插件开发**：插件只做宿主适配，算法/状态机全部复用 acp-kernel。

### 模型驱动压缩机制

- **每轮接入**：给 core 新增 `session.preModel` hook（query 与 queryStream 两条路径），在进入模型前把本轮待发消息交给插件裁剪/改写，并可通过 `save(messages)` 把精简后的会话历史回写持久层；以此支撑「模型写完摘要、内核编排」的模型驱动压缩。
- **模型驱动工具**：注入 `compress` / `decompress` / `search_context` / `acp_status` 4 个工具，由模型决定压缩时机与范围（compress 调用 `engine.applyCompression`，其余读状态）。
- **主机兜底**：即使模型不主动压缩，`processTurn` 的 nudge 决策会在上下文增长达到阈值时以 user 消息提醒；kernel 的压力带/截断策略做最终兜底。

### 改动

1. **core**（packages/core/src/index.ts）
   - `DefaultSessionManager` 新增 `setMessages(sessionId, messages)`：整体覆盖会话消息。
   - `query` / `queryStream` 构建 finalMessages 后、调用模型前触发 `session.preModel` hook，注入 `save` 回写精简历史。
2. **plugin**（packages/plugin/src/index.ts）
   - Hooks 新增 `session.preModel` 钩子与 `SessionPreModelInput`（sessionId / agentId / providerId / modelId / save）。
3. **新插件 `@harness/acp-context`**（packages/plugins/acp-context）
   - `adapter.ts`：Message[] ↔ acp `CoreMessage[]` 双向映射。`toCores` 把消息压平成 core（文本/工具调用/工具结果拆分，复合 id `${base}#${i}`）；`requestMessages` 忠实重建本轮请求（provider 序列化兼容）；`compactHistory` 精简持久化历史——未被压缩的原始消息复用对象（保留图片等 part），压缩掉的丢弃，kernel 摘要块作为新消息补入，并给出 `changed` 判定避免每轮无谓回写。
   - `index.ts`：`createAcpContextPlugin({ modelContextLimit, config, toolIds })`。核心函数 `runPreModel`：压平历史 → `processTurn(renderTags:'text-only')` 指派 refs/分层压缩/nudge → 变化时 `save` 回写 → 每轮注入 ACP 哲学 system 提示 + nudge（需压缩时）。压缩是旁路优化，处理失败仅 warn 不阻断本轮请求。
   - ACP 工具不声明 `permission`（权限仅在声明时才检查），天然放行；`isConcurrencySafe:false`，`compress` 串行写 state。

### 验证

- acp-context 单测 7 pass 0 fail：adapter 压平/还原、compactHistory 变化判定与对象复用、runPreModel 普通轮不 save、ACP 哲学每轮注入一次、compress 应用后下一轮回写精简历史（消息变少且含摘要）。
- 全量 typecheck 通过（含受影响包 core / plugin / revert）。
- 顺带修复 revert 包 `FakeSessionManager` 因 `setMessages` 入接口而缺失方法的问题。

### 背景

承接续 100（4 个原语工具 documentation 外置），本次针对 **edit_file** 参考 Claude Code（FileEditTool/utils.ts）与 opencode（edit.ts）的替换逻辑，增强匹配与删除的健壮性，避免常见的「精确匹配失败」与「删除留空行」问题。

### 改动（packages/plugins/tools-builtin/src/index.ts）

1. **换行归一**（参考 opencode `convertToLineEnding`）
   - 读取文件真实换行风格（LF/CRLF），把 old/new string 归一化到同样风格再匹配，CRLF 文件传 `\n` 也能匹配，插入内容保持 CRLF。
2. **引号归一**（参考 Claude Code `findActualString` / `normalizeQuotes`）
   - 精确匹配失败时，把花引号（“”‘’）归一为直引号再定位文件里真实的匹配片段，替换为模型提供的 newString。
3. **整行删除**（参考 Claude Code `applyEditToFile`）
   - newString 为空且 oldString 不在行末、且内容里真实存在「old+换行」时，顺带删除尾随换行，不留空行；文件末尾无换行时正常直接替换。

新增 helper：`normalizeQuotes` / `findActualString`。同时更新 `prompts/edit-file.txt` 说明这三项增强。

### 验证

- typecheck 通过（30 包全部 Exit 0）。
- tools-builtin 测试 65 pass 0 fail（新增 4 个用例：花引号匹配、CRLF 归一、行首删行不留空行、文件末尾删行）。

## 2026-09-11（续 100）4 个原语工具 documentation 外置并注入 LLM 工具定义

### 背景

承接续 98/99 把运行时提示词外置到文本文件的策略，本次把 **tools-builtin 的 4 个原语工具（read_file / write_file / bash / edit_file）** 基于 reference 里 Claude Code（claude-code-analysis）与 opencode 的原语工具提示词，为每个工具补充一份完整 `documentation`（详细用法 / 前置约束 / 安全限制），并使其能真正注入到各 LLM 提供商的工具定义里，稳定基础功能。

### 改动

1. **tools-builtin**（packages/plugins/tools-builtin/src）
   - 新增 `prompts/read-file.txt` / `write-file.txt` / `bash.txt` / `edit-file.txt`（参考 Claude Code 的 read/write/bash/edit 工具提示词编写）。
   - 4 个原语工具定义新增 `documentation` 字段：`documentation: xDoc.trim()`。
   - 新增 `src/env.d.ts`（`declare module '*.txt'`）保证 tsc 通过。
2. **provider 序列化注入 documentation**（此前各 provider 仅把 `tool.description` 发给 LLM，`documentation` 未被消费）
   - `provider-openai`：新增 `fullDescription(tool)` helper，合并到 `toolToOpenAIDef` 的两个分支。
   - `provider-anthropic`：`toolToAnthropicDef` 内拼接 `description + '\n\n' + documentation`。
   - `provider-gemini`：`toolToGeminiDecl` 内同样拼接。
   - 均采用条件合并：仅当 `documentation` 存在时追加，无 documentation 的工具保持原样，不影响既有测试。

### 验证

- 全量 typecheck 通过（30 包全部 Exit 0）。
- tools-builtin 61 pass、provider-openai 18 pass（新增「带 documentation 的工具会合并为完整 description」用例）、provider-anthropic 16 pass、provider-gemini 19 pass，均 0 fail。
- 全量测试 1654 pass，剩余 fail 为 reference/opencode、opentui（theme/titlebar 等）预存问题，与本改动无关。

## 2026-09-11（续 99）工具插件提示词外置（长文本）——code-intel + computer-use

### 背景

承接续 97/98，用户要求把各工具插件里面向 LLM 的提示词也统一外置。经确认采用「只外置长文本提示词」策略：**短单行 description（≤110 字符）是结构化工具签名，保留内联**；**指令性长文本外置**。

### 现状盘点

- tools-builtin（read/write/bash/edit）、tools-search（list_dir/grep_file）、tools-glob、tools-media（view_image）、tools-web（web_fetch）、swarm（约 10 个工具）：description 均为短单行，不符合外置策略，保留。
- **code-intel**：4 个工具 description 较长（`code_semantic_edit` 约 200+ 字符）→ 外置。
- **computer-use**：`COMPUTER_USE_SKILL_CONTENT`（一整段 Skill 操作指南）→ 外置。

### 改动

1. **code-intel**（packages/plugins/code-intel/src）
   - 新增 `prompts/code-symbols.txt` / `code-reference.txt` / `code-definition.txt` / `code-semantic-edit.txt`。
   - `tools.ts` 的 4 个 `description` 改由 import 文本加载（`.trim()`）。
2. **computer-use**（packages/plugins/computer-use/src）
   - 新增 `prompts/computer-use-skill.txt`。
   - `COMPUTER_USE_SKILL_CONTENT = computerUseSkillContent.trim()`，`register` Skill 时仍复用该常量（测试/逻辑不变）。

各包新增 `src/env.d.ts`（`declare module '*.txt'`）保证 tsc 通过。

### 验证

- 全量 typecheck 通过（30 包全部 Exit 0）。
- code-intel + computer-use 测试 86 pass 0 fail。

此后所有运行时提示词（默认 Agent / Coordinator / Subagent / MCP 资源 / 工具插件长文本 / Computer Use Skill）均已外置为独立 `.txt` 文件，统一 `import` 加载。

## 2026-09-11（续 98）工具/MCP/Coordinator 提示词外置到文本文件

### 背景

承接续 97（默认 Agent 提示词外置），用户要求把其余运行时提示词（工具、MCP 等）也统一外置到文本文件，通过文本加载。

### 改动（三处，均为 prompts/*.txt + import 加载，参考 opencode）

1. **Coordinator System Prompt**（packages/plugins/coordinator）
   - 新增 `src/prompts/coordinator.txt`（orchestrator 职责/派工规则/反模式/续轮指令）。
   - `COORDINATOR_SYSTEM_PROMPT = coordinatorPrompt.trim()`，仍保持导出常量（测试兼容）。

2. **Subagent 工具提示词**（packages/plugins/subagent）
   - 新增 `src/prompts/subagent-tool-description.txt`（工具 description，单行决策规则）。
   - 新增 `src/prompts/subagent-tool-documentation.txt`（工具 documentation，前台/后台规则 + 反模式 + 并行说明）。
   - `createSubagentTool` 的 `description` / `documentation` 改由文本加载（trim 后使用）。

3. **MCP 资源注入模板**（packages/plugins/mcp-client）
   - 新增 `src/prompts/mcp-resources.txt`：`# MCP Resources` 标题 + `## MCP Resource: {uri}` / `{text}` 占位符。
   - `prompt.system.transform` 按模板渲染：第一条自带标题，后续条目剥离标题行拼接，避免标题重复；标题行从模板动态提取（编辑文件后仍跟随）。

各包新增 `src/env.d.ts`（`declare module '*.txt'`）保证 tsc 通过。

### 验证

- 全量 typecheck 通过（30 包全部 Exit 0）。
- coordinator / subagent / mcp-client 三包测试 165 pass 0 fail。

## 2026-09-11（续 97）Agent 提示词文本外置：独立 .txt 文件 + import 加载（参考 opencode）

### 背景

用户要求把代码中与 Agent 提示词相关的文本分别放到独立文本文件里，通过文本加载，参考 Claude Code 与 opencode 的做法。

### 现状盘点

运行时硬编码的 Agent 提示词只有一处：CLI 默认 Agent（`defaultAgent()`）的 2 条 `promptFragments`（`packages/cli/src/index.ts`）。其余为测试夹具与 JSDoc 示例，不属于运行时提示词。外部 Agent 已支持从 `.harness/agents/*.md` 文本加载（frontmatter + body 作 prompt）。

### 改动

- 新增 `packages/cli/src/prompts/default-agent.txt`：默认 Agent 提示词全文（原 2 条 fragment 合并为一段）。
- `defaultAgent()` 改为 `systemPrompt: defaultAgentPrompt.trim()`，经 `import defaultAgentPrompt from './prompts/default-agent.txt'` 加载（Bun 原生支持文本文件导入，build 时内联，直接编辑 txt 即可改提示词）。
- 新增 `packages/cli/src/env.d.ts`：`declare module '*.txt'`，让 tsc 类型检查通过（对齐 opencode 的 `*.txt` 声明方式）。

### 验证

- 全量 typecheck 通过（30 包全部 Exit 0）。
- 运行时验证：txt 文本正确加载为字符串。
- cli 测试 190 pass（唯一 fail/error 来自 reference/ 目录缺 `effect` 依赖，属既有环境问题）；agent/core 单测 62 pass 0 fail。

## 2026-09-11（续 96）命令输出复制按钮每行重复 → 相邻同类块合并，只在末尾显示

### 问题

上一轮给 `system` 块加了复制按钮后，命令输出被**逐行**拆成多个块，每一行都出现「⧉ 复制」：

```
❯ /switch ?
⧉ 复制
已注册 Agent：
✓ 已复制
 default  -  Harness Agent
⧉ 复制
```

### 根因

CLI 命令处理（`createProcessLine`）的 `out()` 是**逐行**回调的，而 `pushConsole` 按 `\n` 拆行、每行新建一个独立块——每个块都渲染一个复制按钮。

### 改动（packages/cli/src/tui.tsx）

- `pushConsole` 增加相邻同类块合并：当新行归类与最后一块**同为 `system`（命令输出）/ `tool`（工具输出）**且该块非流式时，追加 `\n` 合并进最后一块，不再新建块。
- 合并**跳过欢迎块（id 0）**，避免首条命令输出污染静态欢迎文本；`user`/`thinking`/`assistant` 各自独立不合并（防两条用户输入误并）。
- 效果：一次命令输出聚合为单个块，「⧉ 复制」只在命令最后出现一次。

### 验证

- tui.test.tsx 新增 3 用例（连续 system 行合并 / 欢迎块不合并 / tool 合并且 user 不合并），90 pass 0 fail。
- 全量 typecheck 通过；cli 包 89 项本项目测试全绿（唯一 fail/error 来自 reference/ 参考目录缺 `effect` 依赖，属预先存在的环境性问题）。

## 2026-09-10（续 95）MCP 懒加载 / 插件可解析 / 命令输出复制按钮

### 一、MCP 服务懒加载，不影响应用启动

**问题**：`config.json` 里配置的 MCP 服务在 `harness.start` 同步连接，连接慢或失败会阻塞应用启动。

**改动（packages/plugins/mcp-server-registry/src/index.ts）**：
- 移除 `harness.start` 中的同步连接逻辑。
- 新增 `ensureConnected()`：在**首次 `tool.pool.assemble`（首条消息 / `/tools` / `/mcp` 等真正需要工具时）**才连接所有「启用」server。
- 用 `managedInflight` / `codeInflight` 做 in-flight 去重，避免并发重复连接；单个 server 连接失败仅被跳过，不影响启动与其他 server。
- 修正 `/mcp servers` 与 server 列表：懒加载下运行时为空，改把 `reg.list()`（代码注册 & 托管登记）纳入判断，确保注册 server 始终可见。
- `tool.pool.assemble` 在装配前先调 `ensureConnected`，保证首次用到工具时已连接。

**验证**：单测在启动后手动触发一次 `tool.pool.assemble` 再断言连接与工具装配，mcp-server-registry 相关测试全绿。

### 二、/plugins 未显示 SubagentPlugin / CoordinatorPlugin（插件配置未生效）

**问题**：根目录插件（`.harness/plugins/coordinator.ts` 等）启动报 `Cannot find module '@harness/subagent'`，`/plugins` 看不到这两个插件。

**根因**：项目根目录 `.harness/plugins/*.ts` 的运行时入口解析 `@harness/*` 依赖时，根 `node_modules` 没有这些包的链接，导致插件加载报错被吞、插件未登记。

**改动（根 package.json）**：
- 根 `package.json` 增加 `dependencies`，列出全部 `@harness/*` 包的 `workspace:*` 依赖，使根 `node_modules` 生成链接。
- 重新 `bun install` 后，`.harness/plugins/coordinator.ts` 等插件可被正确解析、加载并出现在 `/plugins`。

### 三、命令执行结果支持复制按钮

**状态与改动（packages/cli/src/tui.tsx）**：
- 复制按钮原来只对 `user` / `assistant` / `tool` 块开放；命令输出（如 `/plugins`、目录列表等）属于 `system` 块，无复制按钮。
- 将 `system` 块纳入 `copyable` 判断（文本非空即可复制），使 `/plugins` 等命令执行结果也显示「⧉ 复制」按钮。

### 验证

- 全量 `typecheck` 通过（30 个包全部 Exit 0）。
- 存量 607 个 fail 全部来自各包 `dist` 构建产物内嵌的 OpenTUI 第三方测试（`reference/` 与第三方测试框架产物），属预先存在的环境性问题，与本改动无关。
- 本项目 packages 相关测试全绿：`packages/`（不含第三方产物）与 subagent/coordinator/plugin/mcp 等均 pass、0 fail。

## 2026-09-10（续 94）启动时输出默认 Provider 装配日志

### 问题

用户多次困惑「刚启动时是 mock，要切换模型才有用」。实际根因是跑的是旧进程/旧构建：最新代码在真实 config.json（`provider: "local"`）下 boot，默认 ChatProvider 本就正确装配为 `local` 而非 mock。缺少启动日志，用户无从确认当前默认 Provider。

### 改动（packages/cli/src/index.ts）

- boot 装配默认 Provider 完毕后，输出一行明确日志：
  `✅ 默认 Provider: local（type=openai · model=deepseek-flash）`
- 仅直接使用已解析的配置信息（`defaultProviderId` / `defaultPc`），**不触碰 chosenProvider.provider 的 lazy getter**——boot 阶段插件尚未 install，提前访问 getter 会抛 `OpenAIChatProvider 未创建` 异常。

### 验证

- 沙箱外真实 boot 诊断：`resolveChatProvider() = local`，启动日志正确输出，类型检查通过。
- `bun test` 187 全绿，无回归。

## 2026-09-10（续 93）`/model` 切换到未装配 Provider 时明确警告（不再静默回退 mock）

### 问题

用户在 config.json `providers` 里定义了 `local`（type openai），`/model local/deepseek-flash` 切换后 send 却一直是 `(Mock Provider)`。根因：**当前运行进程的默认 Provider 落在 mock，且 harness 未装配 `local` 的 ChatProvider**；运行时 `/model` 只改 agent.model 与 config.json，并未把新 Provider 加载进 harness。于是 `resolveChatProvider('local')` 静默回退到默认 mock。

### 改动（packages/cli/src/index.ts）

- 新增公开方法 `resolveChatProvider(providerId)`，代理到底层 harness 的 provider 解析。
- `/model <provider>/<model>` 成功切换后，若目标 provider 在当前 harness 未装配（解析到的 actual.id 不等于请求的 providerId），打印明确警告：`⚠️ 当前进程未装配 Provider "xxx"，实际将以 "yyy" 发送。请重启 REPL 使 config.json → providers 生效`。

### 说明

Provider 装配发生在 boot：默认 provider 若已在 config `providers`（type 有效），本就会安装并编程命中；该警告主要兜底「列表里可切换、但当前进程未装配」的边界，避免用户困惑「为什么一直 mock」。

### 验证

- `bun run typecheck` 通过；`bun test` 187 全绿，无回归。

## 2026-09-10（续 92）修复 send 统计行 `model=` 只显示 modelId、丢 provider 前缀

### 问题

`/model local/deepseek-flash` 切换后，send 结束的统计行打印 `model=deepseek-flash`，而非 `model=local/deepseek-flash`。根因：打印取自 `assistant.meta.model`（仅 modelId），而切换后模型是跨 Provider 的，缺 provider 前缀。

### 改动（packages/cli/src/index.ts）

- 发送后的统计行改用 `app.getModel(agentId)` 显示完整 `provider/model`（`formatModel`），并兜底 agent id 为 `'default'`；TUI 状态栏原本就分开展示 `provider` 与 `model`，不受影响。
- 新增测试：mock 场景 `/model mock/deepseek-flash` 切换后 send，断言统计行以 `model=mock/deepseek-flash` 展示。

### 验证

- `bun run typecheck` 通过；`bun test` 187 全绿，无回归。

## 2026-09-10（续 91）`/model ?` 展示 config.json / CLI 配置的 Provider 模型

### 问题

`/model ?` 只列出已注册 Provider 的 id（`app.listProviders()`），不显示 config.json `providers` 里为各 Provider 配置的默认模型，用户无法在 REPL 内一眼看到配置了哪些「provider/model」组合。

### 改动（packages/cli/src/index.ts）

- 新增成员 `loadedProviders`：`boot()` 时记录实际装载的 Provider 配置（CLI `options.providers` 优先，其次 `config.json → providers`）。
- 新增公开方法 `listConfiguredProviders()`：返回各 Provider 实例的 `id / model / baseUrl / apiPath / type`。
- `/model ?`（无参分支）在「已注册 Provider」后追加「配置的模型（providers）」清单：`id/model`、未配置 model 时提示用 Provider 默认，并附 `baseUrl` / `apiPath` / `type`。
- 新增测试：从 config.json 装配 `deepseek/deepseek-chat` 与 `local/qwen2.5`，`/model` 输出包含配置的模型及 baseUrl。

### 验证

- `bun run typecheck` 通过；`bun test` 186 全绿，无回归。

## 2026-09-10（续 90）完善 README：TUI 文件引用/编辑用法 + config.json 配置说明

### 改动

- **README 命令区**：REPL 内置命令段更新为与 `REPL_COMMANDS` + TUI 本地命令一致（含 `/sessions` `/new` `/resume` `/switch` `/model` `/config` `/save` `/plugins` `/skills` `/stats` `/permission` 及 TUI 的 `/history` `/tree` `/edit`）；CLI 选项补充 `--tui`。
- **README 新增「TUI 文件引用与编辑」小节**：侧栏「文件」Tab 自动收集 `path[:line]` 引用、Tab 进入导航/↑↓/Enter 打开/Esc 返回；`/edit <file[:line]>` 前台外部编辑器（`$EDITOR`/`$VISUAL`→vim/nvim/nano，不落 macOS `open`）退出后回读；`/tree [path]` 磁盘文件树 + `*` 引用标记（排除 .git/node_modules，3 层/100 项上限）；`/history`。
- **README 新增「Configuration」章节**：两级 config.json 加载（project 覆盖 user）、CLI > config.json > 环境变量优先级、顶层字段表、`providers[]` 及 apiKey 三种格式（明文 / `${ENV_VAR}` / `enc:v1:` AES-256-GCM）、`agents[]` 工具/MCP 白名单覆盖、`mcpServers[]` 三种 transport + enabled/tools 两级开关、`permissions.json`。
- **README Documentation 链接**：补 `mcp-services.md` / `workspace-management.md` / `codeintel-plugin.md`。

## 2026-09-09（续 89）TUI /tree 语义修正：磁盘真实文件树 + 对话引用 * 标记

### 问题

用户运行 `/tree` 发现输出与磁盘不一致：`~/.harness/` 打印了 `permissions.json`（对话提到过但磁盘不存在），而磁盘上真实存在的 `sessions/` 却没打印。根因：上一版 `/tree` 打印的是「对话引用树」（从对话文本捕捉路径），非磁盘真实结构。

### 决策

`/tree` 语义改为**磁盘真实文件树**，同时兼顾对话上下文：**对话中引用过的文件在树上以 `*` 标记**（两者结合）。交互式目录树仍留给图形页面。

### 改动（tui.tsx）

- 删除引用树纯函数 `buildFileRefTree`（语义废弃），新增 `buildDiskFileTree(root, refs, opts?)`：`readdirSync(withFileTypes)` 递归扫描，目录在前、同级字母序，排除 `.git`/`node_modules`/`.DS_Store`，`maxDepth`（默认 3）与 `maxNodes`（默认 100，超出置 truncated）；引用标记双基准解析（`resolveEditPath` cwd/~ 基准 + `resolve(root, base)` 相对 root 基准），文件 absPath 命中即 `marked`。
- `renderFileRefTree`：`marked` 文件带 `*`，目录带 `/`，根无分支线。
- `/tree [path]`：无参默认 `process.cwd()`，有参经 `resolveEditPath`（支持 `~`）；`statSync` 校验目录，非目录提示「目录不存在」；输出 `文件树（<root>）：` + 树 + 有标记时 `* = 对话中引用过的文件` 图例。不入历史栈、不进会话内核。

### 验证

- 新增用例：`buildDiskFileTree`（排序/排除/标记/深度/截断）、`renderFileRefTree`（`*` 渲染）、`/tree <dir>` 端到端（`a.ts*` 标记 + 图例 + 输入框清空）、目录不存在提示。
- `bun run typecheck` 通过；`bun test` 185 全绿，无回归。

## 2026-09-09（续 88）TUI 新增 /tree 命令打印文件引用目录树（交互树留给图形页面）

### 背景与决策

用户评估后调整方向：**交互式目录树（多根浏览、展开/折叠）不在 TUI 实现，留给图形页面**；TUI 侧栏维持扁平引用列表现状，仅新增 `/tree` 斜杠命令，把对话中已出现的文件引用汇总为「根 → 目录 → 文件」树打印到聊天区。调研（opencode 无侧栏树、Claude Code 为真实磁盘扫描树）确认「汇总已出现引用」是本项目独特能力。

### 改动

- **`tui.tsx`**：
  - 新增纯函数 `buildFileRefTree(refs, opts?)`：根自动推断（cwd→`./` 优先、主目录→`~/`、其余→`其他`，空根剪掉）；目录按相对根的路径逐级建立、`Map` 合并共享父目录；同文件（去 `:行[:列]`）去重保留首个行号；`cwd/home` 可注入便于测试。
  - 新增 `renderFileRefTree(tree)`：根不带分支线，目录带 `/`、文件带 `:行号`，`├─/└─/│` 分支线缩进。
  - `/tree` 命令（submit 拦截，仿 `/history`）：`collectFileReferences(prev, MAX_SAFE_INTEGER)` 全量收集（不受侧栏 8 条上限约束）→ 建树 → system 块打印；无引用提示「（暂无文件引用）」；不入历史栈、不进会话内核。
  - 命令菜单候选追加 `/tree`。
- **`index.ts`**：`REPL_COMMANDS` 追加 `/tree`。

### 验证

- 新增用例：`buildFileRefTree`（多根推断/空根剪除/共享父目录合并/同文件去重/空引用）、`renderFileRefTree`（精确树形文本）、`/tree` 端到端（mock 回复含引用 → 打印树 + 输入框清空；无引用空态）。
- `bun run typecheck` 通过；`bun test` 185 全绿，无回归。

## 2026-09-07（续 83）MCP 工具归属索引统一解析 + 代码注册 server 会话内启停

> 两件事：①把 tools-manager / mcp-server-registry 的 MCP 前缀反解统一到 `@harness/tool` 的 `parseMcpToolId` 语义之上，并用内存缓存的「server → 工具集」映射修正 server 名含 `__` 时的退化；②修复 `/mcp disable code-intel`（代码注册 server）无法禁用的问题。

### 改动

- **`@harness/tool`**：新增 `McpToolIndex`（内存索引：`server` → 完整工具 id 集，含 `index/unindex/serverOf/has/servers/entries`）与模块单例 `globalMcpToolIndex`；新增 `resolveMcpTool(id, index?)` —— 优先用索引精确反解（server 名可含 `__`），未登记时回退 `parseMcpToolId` 启发式切分。索引放在叶节点 `@harness/tool`，装配方与反解方共享同一实例，不引入新包依赖、不影响软件加载。
- **`mcp-server-registry`**：生成工具（`makeRuntime` / 新抽出的 `connectCodeServer`）时登记 `globalMcpToolIndex`，断开（`disconnectServer`）与 `uninstall` 反注册；`harness.start` 代码注册循环复用 `connectCodeServer`。
- **`mcp-server-registry` `/mcp` 命令**：`enable/disable <s>` 不再只允许托管 server —— 对代码注册 server（`reg.has` 命中）做**会话内启停**（无法落盘 config.json，重启后恢复连接）：disable 断开 client + `disabledCode` 标记 + assemble 跳过其工具；enable 经 `connectCodeServer` 重连。`serverList` 对代码注册项展示 `[启用]`/`[会话禁用]` 与连接态。**兼容嵌套写法** `/mcp servers enable|disable <s>`（把动作提升为主子命令归一化处理）。
- **`tools-manager`**：删除本地 `parseMcpTool`（首个 `__` 切分），改经 `mcpToolOf = (id) => resolveMcpTool(id, globalMcpToolIndex)`，server 名含 `__` 时归属/掩码写入总是精确。

### 验证

- tool 50 / mcp-server-registry 10 / tools-manager 13 / cli 169 用例全绿；全量 30 包 typecheck 通过。
- 新增用例：`McpToolIndex`+`resolveMcpTool`（server 含 `__` 精确反解、未登记回退、unindex、幂等重登记）、代码注册 server `/mcp disable/enable` 会话内往返（禁用后 assemble 空、启用后工具恢复）。

## 2026-09-08（续 87）修复 ↑/↓ 历史回看被命令菜单劫持 + 新增 /history

### 现象

上键只能回看一条历史命令：回看出的历史若以 `/` 开头（如 `/stats`、`/mcp ...`），会同时命中 `/` 命令菜单，第二次 ↑ 被命令菜单的「选候选」逻辑接管，历史不再继续回看。

### 根因

命令菜单与输入历史共用 ↑/↓ 且命令菜单分支在前：command menu 仅当输入以 `/` 开头且有候选时开启。回看产出的 `/` 前缀历史恰好满足 → 下一次 ↑ 落入菜单导航而不是历史。

### 改动（tui.tsx）

- ↑/↓ 处理重排为统一优先级：**正在回看（histIdx>=0）→ ↑/↓ 继续回看，不被命令菜单劫持**；否则命令菜单开启 → ↑/↓ 选候选；否则 → ↑ 开始回看。删除原冗余的 `!cmdMenuOpen && history` 旧分支。
- 新增 `/history` 命令（TUI 内拦截 submit，不进会话内核）：聊天区渲染 assistant 块展示输入历史（编号列表），不入历史栈、不触发外部处理。引入 `historyRef` 镜像，供依赖 `[]` 的 submit 闭包同步读取。

### 验证

新增 TUI 用例：连续 ↑ 遍历 `/stats` 与其前一条普通消息（不被菜单劫持）；`/history` 输出后又以 `❯` 回落。TUI 73 全绿、全量 typecheck 通过。

## 2026-09-08（续 86）修复 TUI Tab 补全/历史回看后光标跳回开头

### 现象与根因

Tab 补全命令、↑ 回看历史等场景后，输入框光标有时「回到开头」——后续键入被**前置**到命令开头（如 `/resume <sid>` 变成 `<sid>/resume`），多行缓冲时更明显。

根因：`setComposer` 底层走 `textarea.setText()`（Rust `editBufferSetText`），该调用会**完全重置缓冲状态并把插入点放回 (0,0)**，而此前代码没有在写回后重新定位光标。

### 改动

`tui.tsx` 的 `setComposer` 在 `setText` 后追加 `textareaRef.current?.gotoBufferEnd()`，把光标重新定位到文本末尾，恢复「补全/回看后继续在行尾键入」的直觉。该路径覆盖：Tab 补全、Esc 关闭命令菜单、历史回看（↑/↓）、提交后的清空。

### 验证

TUI 测试 71 pass（含输入历史导航、命令菜单、文件引用导航等），无回归。

## 2026-09-08（续 85）/plugins 装卸与 MCP server 联动 + 文档对齐

### 问题

1. `/plugins disable code-intel` 后 `/plugins` 列表里看不到该插件 → 用户无法重新启用（list 只显示已加载插件）。
2. 禁用插件后其注册的 MCP server 不断开、`mcp__code-intel__*` 工具不收敛 → 仍可被调用。
3. `docs/mcp-services.md` 遗留工作区未提交改动，把已废弃的 `/mcp tool` 子命令写回（倒退），与当前架构矛盾。

### 改动

- **manage-plugin**：list 合并「已加载」+「已登记未加载」（CLI 注入 `availablePlugins`，来自 `app.pluginRegistry`）——禁用后插件仍显示并标注 `[可管理·已禁用]`，可直接 `/plugins enable` 恢复。
- **mcp-server-registry**：`McpServerRegistration` 增加可选 `source`（来源插件 id）；插件维护 `serverSource: Map<server, 插件id>`；订阅 `plugin.unloaded` → 断开该插件注册的 server + 记入 `downTools`（assemble 收敛工具）+ 发 `mcpServerDisabled`；订阅 `plugin.loaded` → 重连并恢复装配（清 `downTools`）+ 发 `mcpServerEnabled`。
- **code-intel**：`registerMcpServer` 携带 `source: 'code-intel'`。
- **docs/mcp-services.md**：去掉 `/mcp tool` 残留；命令列表补 `/mcp servers enable|disable <s>` 嵌套写法；明确工具级启停统一走 `/tools`；补「随插件装卸」运行时机制（`source` 关联、卸载断开/重载重连）。

### 验证

- manage-plugin 8 / mcp-server-registry 11 / code-intel 73 / cli 169 全绿；全量 30 包 typecheck 通过。
- 新增用例：list 显示已禁用插件并可恢复；插件卸载 → 工具从池收敛、重载 → 重连恢复。

## 2026-09-07（续 84）修复 `/mcp disable` 后工具仍显示「启用」且残留可调用

`/tools` 状态矛盾（`启用·…·server已禁用`）的根因：禁用/移除 server 只跳过 `tool.pool.assemble` 的「新增」，而运行时 `ToolRegistry` 早已在启动时登记过这些工具；`DefaultToolPool.add` 只增不减，导致旧工具残留下线、仍可被 LLM 调用、`/tools` 仍判为「启用」。

### 改动

- **mcp-server-registry**：禁用标记 `disabledCode:Set` 升级为 `downTools:Map<server, string[]>`（server → 待移除工具 id）。`tool.pool.assemble` 先按 `downTools` 用 `pool.remove` 收敛注册表、再装配启用 server 的工具；`enable`/`disable`/`remove` 在断开前捕获该 server 的工具 id 记入 `downTools`，供下一次 assemble 移除。这样禁用/移除在运行时真正生效，而非仅「不再加入」。
- **CLI**：新增 `attachMcpReassemble(harness)`，订阅 `mcp.server.disabled/enabled/added/removed` 事件 → `harness.assembleTools()`，让禁用即时收敛（REPL 生命周期挂载/退订）。否则事件只是通知、注册表不会自动重组。
- **tools-manager**：`renderToolTable` 对来源 server 已禁用的 MCP 工具，把状态前缀 `启用` 改写为 `禁用`，消除与白名单判定的矛盾（作为残留期的显示安全网）。

### 验证

- mcp-server-registry 复用同一 pool 断言禁用后工具确实被移除、启用后恢复；tools-manager 13、cli 169、core/tool 等全绿；全量 30 包 typecheck 通过。

## 2026-09-07（续 82）Agent 级 MCP 配置能力（server 粒度白名单/黑名单）

> 让 Agent 在声明式配置里按 **MCP server 粒度** 控制可用 MCP，而不必在 `tools` 白名单里逐个列 `mcp__<server>__<tool>`。设计文档见 `.trae/documents/agent-mcp-config.md`。

### 改动

- **`@harness/tool`**：新增 `parseMcpToolId`（解析 `mcp__<server>__<tool>`，server 取首个 `__` 之前）与 `filterMcpTools`（按 server 白名单/黑名单对工具集收窄；白名单优先于黑名单、缺省透传、非 MCP 工具恒保留、server 名 trim）。作为 filterByWhitelist 之后的第二阶段。
- **`@harness/agent`**：`AgentDefinition` 新增可选 `mcpServers?`/`excludeMcpServers?`；`agentFromMarkdown` 增加 `parseStringArr` 支持内联数组/块级列表/裸逗号字符串；显式 `[]` 表示拒绝全部 MCP。
- **`@harness/core`**：`query` 与 `queryStream`(`_prepareQuery`) 两处统一接入 `filterMcpTools`，server 粒度过滤参与 allowedTools 组装，只影响模型可见/可调用工具集，不改 `/tools`/`/mcp` 命令语法。
- **`packages/cli`**：`cfg.agents[]` 类型扩为含 mcp 三字段；`applyConfigAgentTools` 更名为 `applyConfigAgentOverrides` 并合并三字段；修复 `setAgentTools` 整条覆盖会静默丢弃手写 mcp 声明的坑（保留原 entry mcp 字段）。
- **文档**：架构文档 agent 能力白名单补充 MCP server 粒度声明说明。

### 验证

- tool 44 / agent 27 / core 35 / cli 169 用例全绿；全量 typecheck 通过。
- 覆盖：parseMcpToolId（含 server 含 `__`）、filterMcpTools 全分支（缺省/白名单/空数组/黑名单/白优先黑/非 MCP/trim）、frontmatter 三种写法、config.json 合并与 setAgentTools mcp 字段保留、core 装配接线不破坏执行 + 缺省向后兼容。

## 2026-09-07（续 81）命令单一职责 + 事件跨层解耦

> 承接「MCP Server 配置化管理」。落实插件/服务/工具三类命令的单一职责，并以事件总线解耦上层命令对下层的副作用。设计文档见 `.trae/documents/command-srp-event-decoupling.md`。

### 改动

- **`@harness/core`**：导出 `LifecycleEvents` 事件常量（`plugin.*` / `mcp.*` / `tool.*`），供跨插件的类型安全发布/订阅。
- **新增 `@harness/manage-plugin`（`/plugins`）**：独立插件包负责插件生命周期（查看 / 启用 / 禁用 / 重载），成功时发布 `plugin.loaded/unloaded/updated`。从 `HarnessApp` 移除 `disablePlugin/enablePlugin/reloadPlugin`，改为注入 `manageablePlugin` / `pluginManageable` 能力。
- **`mcp-server-registry`（`/mcp`）**：删掉 `tool` 子命令，只管理 server 生命周期；`enable/disable/add/remove` 发布 `mcp.*` 事件；并在 `install` 订阅 `plugin.unloaded`，宿主插件卸载时自检清理孤儿 runtime。
- **`tools-manager`（`/tools`）**：统一工具启停唯一入口，支持 `mcp__<server>__<tool>` 前缀把掩码写入 `mcpServers[].tools`；发布 `tool.*` 事件；订阅 `mcp.server.disabled` 刷新清单、订阅 `plugin.*` 状态同步。
- **`packages/cli/src/index.ts`**：插件分发时 `arg` 由「仅第二个 token」修正为「命令名之外的完整剩余内容」（此前 `line.split(/\s+/,2)` 截断导致 `/plugins disable <id>`、`/mcp <sub> <json>` 等参数丢失）。
- **修复 `manage-plugin`**：`out(...) + '\n'` 因优先级错误生成 `undefined\n` 被丢弃，改为 `out(msg + '\n')`。

### 验证

- manage-plugin 7 用例、mcp-server-registry 9 用例、tools-manager 13 用例、code-intel 12 用例、mcp-client 55 用例、subagent 109 用例、cli 96 用例全绿；全量 30 包 typecheck 通过。
- 顺带修正 `cli.test.ts` 幂等往返用例：原测试用全新 app 二次 boot（boot 时 mock provider 已默认加载）导致 enable 永远命中「已是启用状态」，改为同一 app 内 disable→enable→重复 enable 验证「禁用后恢复 + 幂等」。

## 2026-09-07（续 80）MCP 服务文档 + /help 展示插件命令 usage

> 承接「MCP Server 配置化管理」。补齐 MCP 服务使用文档，并修复 `/help` 只打印插件命令 `description`、忽略注入的 `usage` 的问题。

### 改动

- **新增 `docs/mcp-services.md`**：MCP 服务使用文档——代码注册 vs config.json 托管两种装配方式、`McpServerEntry` 字段表、`/mcp` 命令全量用法（含 `enable/disable/tool/add/remove`）、运行时机制（`mcp.configure` 注入 → start 按 enabled 连接 → assemble 工具级过滤 → `setMcpServers` 持久化）、凭证安全（明文/`${ENV}`/`enc:v1:`/OAuth）、相关文档索引。
- **AGENTS.md**：文档索引补充 `docs/mcp-services.md`。
- **`packages/cli/src/index.ts` `/help`**：插件命令列表在 `/${command} + description` 后，若插件注册了 `usage` 则追加一行 `用法：<usage>`（如 `/mcp`、`/subagents`、`/worktrees`、`/tasks`、`/workspace` 等均受益）。

### 验证

- cli 96 用例全绿；全量 17 包 typecheck 通过。

## 2026-09-06（续 79）MCP Server 配置化管理：config.json 装配 + 服务器/工具两级启停

> 承接待办「OAuth2 PKCE / MCP OAuth 授权」之外的方向。此前 MCP Server 只能经 `.harness/plugins/mcp.ts` 代码显式装配，无法从配置文件新增外部 server，也没有运行时启停；`/plugins` 只管理整插件粒度、`/mcp` 只读展示。本交付：从 `config.json` 以 JSON 新增 MCP server（stdio/sse/http），并支持**服务器 + 工具两级**启用/禁用、**即时生效（免重启）**，状态持久化回 `config.json`。

### 配置模型

`HarnessConfig.mcpServers: McpServerEntry[]`；`McpServerEntry` 复用 `@harness/mcp-client` 的 `McpServerConfig` 字段 + `enabled`（服务器级）、`tools`（工具级，`{ 工具名: false }` 停用单个工具）。

```json
{ "mcpServers": [{ "name": "github", "transport": "stdio", "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
  { "name": "notes", "url": "...", "auth": { "bearerToken": "enc:v1:..." }, "tools": { "notes_search": false } }] }
```

### 改动清单

- **`packages/plugins/mcp-server-registry`（v0.2.0）**：
  - 新增 `McpServerEntry` / `McpCliStore` 类型导出；工厂内新增托管配置态 `managed: Map<name, ManagedEntry>`（含 server `enabled` + 工具级 `tools`）。
  - 新增自定义 Hook **`mcp.configure`**：注入 config.json 的 `mcpServers` 替换托管列表（仅配置态，start 时按 `enabled` 连接）。
  - `harness.start`：代码注册 server 照旧连接；托管条目只连接 `enabled` 的。
  - `tool.pool.assemble`：先按 server `enabled`（未连接自然不在 runtimes），再按工具 base 名过滤 `tools[name]===false`；每 query 组装 → 工具级即时生效。
  - `/mcp` 命令扩展：`servers`（含启停状态）/ `tools`（含工具级状态）/ `enable|disable <s>`（即时连接/断开）/ `tool <s> <t> on|off` / `add <json>` / `remove <s>`；每次变更经注入的 `setMcpServers` 持久化。
- **`packages/cli`**：`HarnessConfig` 加 `mcpServers?`；新增 `getMcpServers` / `setMcpServers`（configStore 读写）+ `applyMcpServers`（createHarness 后、start 前触发 `mcp.configure`）；`CliCommandInput` 注入 `mcpServers` / `setMcpServers`（对齐 `setAgentTools` 模式）；新增 `@harness/mcp-server-registry` 依赖。
- **配置装配**：`.harness/plugins/mcp.ts` 无需改动（配置经 `mcp.configure` Hook 注入）。

### 测试

- registry 包 8 用例（新增 4：configure 注入态展示 / 工具级启停持久化 / 服务器级启停持久化 / add+remove 持久化）；cli 96 用例（新增 getMcpServers/setMcpServers + boot 注入）。全量 17 包 typecheck 通过。

### 后续

- `/mcp` CLI 全量管理已落地；界面（TUI/Web）添加及管理可复用 `mcp.configure` Hook + `McpCliStore.save` 数据接口，core 无需改动，另行排期。

## 2026-09-06（续 78）Subagent git worktree 隔离：子代理独立工作区免写冲突

> 承接待办「Subagent git worktree 隔离」。为避免多个子代理并发写操作与父工作区冲突，为每个子会话在独立 git worktree 中执行，并把相对基线 HEAD 的 diff 摘要 + patch 回传给父会话 / 注入后台通知。

### 机制

- 利用 `git worktree add --detach --force <dir> HEAD` 为每个子代理创建一个从当前 HEAD 派生的独立工作目录，落点 `<repo>/.harness/worktrees/<token>`。
- worktree 之间文件系统级隔离，子代理的写操作互不冲突，也与父工作区隔离。
- 子代理完成时用 `git -C <worktree> diff HEAD --stat` + `diff HEAD` 生成变更摘要；非零改动才回传摘要文本并写临时 `.patch` 文件（返回 `diffPath`）。后台路径随 `<task-notification>` 注入 `<diff-file>` 标记。
- 非 git 仓库 / worktree 创建失败自动降级：回退无隔离执行（`session.cwd` undefined、无 diff 摘要），不中断子代理。

### 改动清单

- **`packages/core/src/index.ts`**：`ToolContext` 构造（同步 L1317、流式 L1520 区域）支持会话级 `cwd` 优先——`sess?.cwd ?? this.deps.cwd`；`Harness` 接口与 `HarnessImpl` 新增只读 `cwd`（= `options.cwd ?? process.cwd()`），供子代理判 `git worktree` 用。
- **新增 `packages/plugins/subagent/src/worktree.ts`**：自包含 git worktree 模块——`runGit`（错误归一化为 `GitCommandError`）、`gitTopLevel` / `isGitRepo`、`worktreeDirFor`（清洗 token）、`ensureWorktreeIgnored`（幂等写 `.harness/.gitignore` 含 `worktrees/`）、`createWorktree`（幂等）、`getWorktreeDiff`、`removeWorktree`、`listWorktrees`（解析 `--porcelain`）。
- **`packages/plugins/subagent/src/index.ts`**：`HarnessLike` 加只读 `cwd?`；模块级状态 `baseCwd` / `worktreeEnabled`；`resolveWorktree`（复用已有 worktree / 新建）；`attachWorktreeDiff`（生成 diff 摘要 + 写临时 patch）；同步 / 后台路径接入；`/worktrees` 命令支持 `list` / `remove <token>` / `remove-all`。
- **测试**：`worktree.ts` 单测 12 用例（gitTopLevel / createWorktree 幂等 / listWorktrees / getWorktreeDiff / ensureWorktreeIgnored / removeWorktree / GitCommandError）；`index.test.ts` 新增 4 集成用例（git 仓库隔离 + 续接复用 + diff 回传、非 git 回退、后台通知含 diffPath、`/worktrees` 命令）。subagent 包 109 用例全绿，全量 typecheck 通过。

### 待办

- `.harness/.gitignore` 已含 `worktrees/`，worktree 目录不入库。
- 子代理 worktree 生命周期内置管理：续接复用同一 worktree，任务完成不自动删除，可由 `/worktrees remove` 回收。

## 2026-09-06（续 77）TUI/REPL 多行输入：readline 单行 → OpenTUI

> 承接续 76 标注的「TUI/REPL 多行输入」方向。把 cli TUI 底部输入从单行 `<input>` 升级为 OpenTUI `<textarea>` 多行编辑器：Enter 插入换行、Meta/⌘+Enter 提交，同时保留命令菜单 / 输入历史 / 文件引用导航等既有交互，并验证粘贴多行文本被完整保留。

### 实现（`packages/cli/src/tui.tsx`）

* **组件替换**：底部 `<input value+onInput>`（受控单行）→ `<textarea ref+onSubmit>`（非受控多行）。`<textarea>` 无受控 value/onInput，故用 `textareaRef` 直接读写底层 `TextareaRenderable` 的 `plainText` / `setText`（`readComposer` / `setComposer`，用回调稳定引用，单实例无 remount，避免 buffer 损坏）；`submit` 改用 `setComposer('')` 清空。默认键位：`return`→newline、`return`+meta→submit，天然满足"Enter 换行 / Meta+Enter 提交"。
* **输入状态同步（关键）**：`input` state 仍被命令菜单过滤 / 历史回看 / 侧栏切换依赖，但 `<textarea>` 不再有受控 value 回写。OpenTUI 的 `InternalKeyHandler` 保证全局 `useKeyboard` 先于聚焦组件处理按键，故在全局 handler 末尾用 `queueMicrotask` 等聚焦 textarea 写入本次字符后再读 composer 回填 `input`，并把 `histIdx → -1` 退出回看态。
* **命令菜单 / 历史按键冲突**：`↑/↓/Tab/Esc/Enter` 在命令菜单与历史分支统一加 `key.preventDefault()`（只有它是真正阻止聚焦组件处理的开关；`useKeyboard` 的返回值不生效），阻止 textarea 把 Enter 误当换行；删除命令菜单末尾无效的 `return true` 吞键——否则键入字符会被截断无法收窄菜单，改为让其回落末尾微任务正常同步 `input`，命令过滤器随键入实时更新。Meta+Enter 在菜单打开时也放行（提交正文而非菜单项）。
* **HELP_LINES**：登记 Enter=输入框内换行 / ⌘/Meta+Enter=提交。

### 测试与验证

* `tui.test.tsx`：新增 `pressMetaEnter` 辅助（`pressEnter({ meta: true })`），既有「键入后提交」类用例统一升级为 Meta+Enter；新增 3 条：① 命令输入（`/stats`/`/exit`）改 Meta+Enter 提交命令文本（不依赖菜单时序）；② 命令菜单 `/` 前缀展开后普通 Enter 选中首个候选提交；③ 多行输入 Enter 换行不提交、Meta+Enter 提交整段；④ 粘贴换行文本（`pasteBracketedText`）保留并提交。tui.test.tsx 71 用例全过，cli 全量 166 通过，全仓 typecheck 通过。

### 后记修复：Ctrl-? 帮助面板乱码 / 对齐 / 换行异常

* 新增的提交键位行含特殊字符 `⌘`（U+2318），多数终端字体渲染为豆腐块乱码；且 `l.key.padEnd(18)` 按 JS 字符数对齐，遇 `↑ ↓ ◀ ▶` 等非 ASCII 箭头（渲染列宽≠字符数）时各 key 行 desc 起始列错位 → 换行/对齐不对。
* 修复：键位文案 `⌘ / Meta+Enter` → `Alt/Meta+Enter`（纯 ASCII，消除乱码）；帮助面板渲染由 `padEnd` 拼接改两列固定宽度布局（key 列 `width:20` + desc 列 `wrapMode:"word"`），desc 起始列不再受 key 字符宽度影响。tui 71 用例全过。

## 2026-09-06（续 76）开发方向核实：同步 3 处「已实现但文档未同步」留痕

> 盘点剩余开发方向时发现历史日志中有「已实现但文档仍标待办」的遗漏，经代码核验后在本期同步标注。均为文档留痕，不改业务代码。

### 核实结论

* **快照自动集成（原「后续待办」）——已实现**：cli 启动时把 `snapshotService` 注入 AgentRuntime 的 snapshot factory（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1305)）；core `AgentRuntimeImpl.captureForMessage()` 在 `query`/`queryStream` 主循环开始时 `capture()` 并把 `{ start, files }` 挂到 assistant 消息 `meta.snapshot`（[core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)），`core.test.ts` 已有单测覆盖。
* **基于 caller.permission 过滤子 Agent —— 已实现**：subagent `isAgentDenied` / `filterAccessibleAgents` 已接入 `/subagents` 命令，按父 Agent 权限隐藏不可用子 Agent。
* **配置文件加载 Agent —— 已实现**：core 经 `agentDirs`（user → project）多级目录加载 Agent 定义并支持同名覆盖（`core.test.ts` 覆盖）。
* 以上三处本期在本文件同步为「已完成」，并在下方「剩余待办」表格对应行补 ✅。

### 真正 still-open 的方向（本期不实现）

* **OAuth2 PKCE／MCP OAuth 授权**：mcp-client 当前仅支持 `bearerToken`/自定义 Authorization header，无授权码流程/PKCE/token 刷新。
* **TUI/REPL 多行输入**：CLI 走 readline 单行 `'line'` 事件，无多行输入组件。
* **Subagent git worktree 隔离**：子代理在独立 git worktree 中执行以避免与父会话写冲突，目前仅注释提及、未实现。

## 2026-09-06（续 75）code-intel：语义编辑方向决策（搁置多语言扩展，保留导航）

> 调研 Serena（oraios/serena，MIT，~24k stars）后定方向。Serena 是标准 MCP 分发、以 LSP（pyright/gopls/jdtls/rust-analyzer 等 40+ 语言服务器）驱动**真作用域/类型感知**的语义能力，工具集（`find_symbol` / `find_referencing_symbols` / `rename_symbol` / `replace_symbol_body` / `safe_delete`）与本项目 `code_symbols` / `code_reference` / `code_definition` / `code_semantic_edit` 目标重叠。

### 结论：停止扩展，保留导航

* 本项目语义编辑基于本地 AST（babel + tree-sitter），tree-sitter 无作用域绑定，rename 为**同名 token 弱语义**，精度天然弱于 LSP；继续扩展到 Kotlin/PHP 需为每语言固化 descriptor + 补测试，只为达成弱于 LSP 的效果，性价比低。
* code-intel 的差异化不在语义编辑精度，而在**零外部依赖、wasm 全内嵌、可单二进制部署**的轻量能力；重型语义编辑场景可由外部标准 MCP（如 Serena）按需接入，符合插件化定位。
* 已提交的 Java 语义编辑（续 72/73/74）保留为**离线兜底**能力，不回退。
* 本次会话未提交的多语言 LanguageEditDriver 重构（`languages.ts`、`core.ts`/`multi.ts`/`index.test.ts`/`package.json`/`bun.lock` 的 Kotlin/PHP 扩展及探针）已全部 `git restore` 回滚到 `af7bae4`，新增文件删除，工作区干净（code-intel 73 用例全绿，typecheck 通过）。

### 后续可选方向

* 需重型语义能力时，把 Serena 作为可选 MCP 外部 server 接入 harness（标准 MCP，cheap），不内置复刻。

## 2026-09-06（续 75）mcp-client：OAuth2 PKCE 授权码 + token 加密持久化

> 承接续 74。为 `@harness/mcp-client` 的 HTTP/SSE transport 增加 OAuth2 PKCE 授权码流程：端点 well-known 自动发现 / 显式配置，access 过期自动 refresh，token 用 `@harness/workspace` 的 `SecretCipher`（AES-256-GCM）加密持久化到 `dataDir/oauth-tokens.json`。授权码交互形态：打印授权 URL → 浏览器授权 → 把回调 URL（或其中 code）粘贴回 REPL（不做本地回调服务器）。

### 实现

* **`src/oauth.ts`**（新增，纯逻辑 + 交互注入）：`discoverOAuthMetadata`（RFC 8414 well-known）、`generatePkce`/`createPkceChallenge`（base64url(SHA256)，verifier 定长 43 无 padding）、`exchangeAuthorizationCode`、`refreshOAuthToken`（均 `fetchImpl` 可注入）、`buildAuthorizationUrl`；`class OAuthFlow` 对外只暴露 `ensureAccessToken({refresh?})`——命中缓存/磁盘直接返回 → 过期用 refresh_token 刷新 → 再否则交互授权，`pending` 并发去重；`readCode`/`log` 可注入（缺省读 stdin 一行）。
* **`src/token-store.ts`**（新增）：`OAuthTokenStore` 用 `SecretCipher` 加解密 token 落盘到 `dataDir/oauth-tokens.json`，每 server 一项 `{ enc: 'enc:v1:...' }`；`serverKey = base64url(sha256(baseUrl))` 稳定不可逆；`load/save/clear/hasStored`。解密失败（密钥不符/篡改）抛错，由 OAuthFlow 捕获回落重授权。
* **`src/index.ts`**（改）：`McpAuthConfig` 增 `oauth?: McpOauthConfig`；`buildAuthHeaders` 改 **async** 并接收 `oauthResolver`（oauth 存在优先取动态 token，回落静态 bearerToken）；`HttpTransport`/`SseTransport` 增 `oauthResolver` 构造注入；Http 401/403 **强制 refresh 后重试一次**，再失败抛错，非 oauth 的 401 直接抛错；新增 `TransportFactoryContext{ dataDir?; fetchImpl?; readCode?; log? }`，`defaultTransportFactory(config, ctx?)` 装配 OAuthFlow；`createMcpClientPlugin` 透传 `dataDir`。
* **`mcp-server-registry`**（改）：`registerMcpServer` 支持单项 `dataDir?`，`createMcpServerRegistryPlugin` 增 `options.dataDir` 缺省，`defaultTransportFactory(item.config, { dataDir })` 透传；装配经 `.harness/plugins` 外部插件目录完成，cli 主逻辑不耦合。

### 测试与版本

* 新增 `oauth.test.ts`（16）+ `token-store.test.ts`（4）+ 补 `index.test.ts` 5 条（OAuth 头注入优先、401 刷新重试一次、重试仍拒抛错、非 oauth 401 抛错、factory 端到端 OAuth 装配+落盘）。修复一处逻辑 bug：`expires_in=0` 时原 `obtained_at && expires_in` 判成永不过期（误返回过期 token）——改 `!= null` 判定。mcp-client 55 用例全过，全量 typecheck 通过。mcp-client version 0.1.0 → 0.2.0。

## 2026-09-06（续 74）code-intel：Java 反向 import 跨目录解析

> 承接续 73。`code_semantic_edit` rename 的 `resolveImporters` 从仅覆盖 TS/JS 扩展到 Java：把 scope 外、但通过 `import <pkg>.<symbol>` 引用声明方符号的外部导入方一并纳入改名。

### 实现

* **`multi.ts`**：新增 `collectJavaModuleInfo(content)`——解析 Java 文件的 `package a.b;`（取 `scoped_identifier` 命名子节点，非 `name` 字段）与 `import a.b.Symbol;` 完整限定名列表（含 static 导入），供包名匹配。
* **`core.ts`**：`reverseImporters` 增加 Java 分支——预计算声明方（declaringFiles 中的 `.java` 文件）的包名集合；对每个外部导入方取它的 import 限定名，凡末段 == 符号且前缀 == 任一声明方包名，即用 `collectJavaRenameSites` 将整文件纳入（声明+引用全改）。仅全限定名引用（无 import 绑定）或非本包文件不误拉入。

### 测试与版本

* `index.test.ts` 新增 1 条：声明在 `app/Shape.java`（`package app`，类+构造），scope 设 `app`；scope 外 `consumer/Main.java` 经 `import app.Shape` 引用——`path:'app', resolveImporters:true` 后 `app/Shape.java` 类名/构造器与 `consumer/Main.java` 的 import 说明符/类型/构造引用全改，`importers` 记为 1；同根下仅「全限定名引用、无 import 绑定」的 `other/Other.java` 不被拉入。code-intel 包 73 用例全过，typecheck 通过。插件 version 0.13.0，meta 描述同步。

## 2026-09-06（续 73）code-intel：Java 语义 rename 接入结构编辑

> 承接续 72。把 Java 从「名字命中型引用」提升为「语义编辑位点」：`code_semantic_edit` 的 rename 现对 `.java` 走 CST 标识符 token 级实现（声明位点精确化 + 引用识别 + 重解析校验），对齐 TS/JS 的 babel 语义 rename。

### 实现

* **`core.ts`**：`CodeIntelIndex.collectRenameSitesFromScope` 按 `.java` 分派到 `collectJavaRenameSites`（其余走 babel `tryParse` + `collectRenameSites`）；`execRename` 落盘前校验分支——Java 文件用 `verifyJavaSource`（`!root.hasError`）而不是 `tryParse`，任一失败整体放弃（不落盘）。
* **`multi.ts`**：`collectJavaRenameSites` 收集同名声明/引用 token 位点——声明仅取拥有 `name` 字段的节点（class/record/interface/annotation_type/enum → type_identifier、method/constructor → identifier、variable_declarator → identifier），标记 `decl`；其余 `identifier`/`type_identifier`/`field_identifier` 同名 token（含 import 说明符、字段访问、类型引用、调用）归 `ref`。注释/字符串/字面量非 token 天然隔离。`verifyJavaSource` 重解析无 ERROR 节点即校验通过。
* **偏移修正（关键）**：web-tree-sitter 的 `startIndex/endIndex` 已把 UTF-8 字节偏移换算为 JS 字符索引（实测含中文注释时仍与 `content.slice` 精确对齐），位点可直接用于替换。此前为实现"字节→字符换算"而引入的 `jsIndexAt` 反而把已正确的字符索引当字节再换算一次，导致含非 ASCII 前文的 token 范围错位（出现 2 字符跨度等异常）——已删除，位点直接用 `n.startIndex/n.endIndex`。

### 测试与版本

* `index.test.ts` 新增 2 条：① 单文件字段重命名——声明 1 + 引用 3（`this.count`/`count+1`/`return count`）共 4 位点同步，注释中同名 token 不触碰、中文注释场景验证字符偏移换算正确、`validated=true`；② 类名跨文件——`util/Shape.java` 声明 + `Main.java` import 说明符与类型/构造引用同步改名。code-intel 包 72 用例全过（原 70 + 新增 2），typecheck 通过；全量 typecheck 通过。插件 version 0.12.0，meta 描述同步（rename TS/JS babel + Java tree-sitter 语义）。

## 2026-09-06（续 72）code-intel：进程内 MCP server 解耦

> 承接续 71。把 code-intel 从"直装 `@harness/tool` 工具"重构为「进程内 MCP server + 直装工具」双路径，核心逻辑与 harness 解耦：索引 / 符号 / 引用 / 定义 / 结构感知编辑引擎下沉到 `core.ts`（零 `@harness/tool` / `@harness/plugin` 依赖），MCP server 由 `@harness/mcp-server-registry` 进程内连接并暴露为 `mcp__code-intel__*` 工具，可独立部署 / 跨进程调用。

### 实现（src 拆分三件套）

* **`core.ts`**：从原 `index.ts` 拆出全部核心逻辑——`CodeIntelIndex`（按需增量 + mtime/size 缓存）、babel 符号/引用提取、tree-sitter 多语言导航入口、`execSemanticEdit`（rename / replace_node / replace_subtree 结构感知编辑引擎）。定义独立契约 `CoreResult` / `ok` / `fail` / `CoreContext`（仅 `cwd`）。
* **`server.ts`**：进程内 MCP JSON-RPC server（`CodeIntelMcpServer`）——`initialize` / `tools/list` / `tools/call`，四个工具入参支持可选 `cwd`、返回文本（便于 LLM 直接阅读）；`createCodeIntelServerTransport` 包装为 `@harness/mcp-client` 的 `McpTransport`（send 喂给 server、onMessage 回传、提前接收走队列）。
* **`tools.ts`**：薄适配层，把 `core.ts` 能力适配为 `@harness/tool` 的 Tool（同 id），保留只读/并发安全/权限键声明，供 REPL `/tools` 展示与既有测试兼容。
* **`index.ts`**：插件入口 `createCodeIntelPlugin` 装配方式对齐 computer-use（可插拔 / 独立装卸）——`install` 钩子内用 `registerMcpServer({ name, createTransport })` 注册进程内 server（同名覆盖、幂等）、`uninstall` 注销（`unregisterMcpServer`）；同时经 `tool.pool.assemble` 注入直装工具；`dependsOn: ['mcp.server-registry']`；重导出 core/tools/server 公共符号。

### 装配方式（.harness/plugins 纯 MCP，可插拔）

* `createCodeIntelPlugin` **改为纯 MCP server 装配**（对齐 computer-use）：install 只 `registerMcpServer`，**不再直装 harness 工具**（移除 `tool.pool.assemble`），工具统一由 registry 连接后以 `mcp__code-intel__*` 暴露；core 能力仍可经 `./tools` 薄适配程序化调用。
* **CLI 派发成 metaOnly**：cli 里 code-intel 内置项与 computer-use 同为 `metaOnly: true`（仅预登记 `mcp__code-intel__*` 元信息供 /tools 展示，不后台预加载实例化）。
* **`.harness/plugins/mcp.ts` 装配**：加入 `createCodeIntelPlugin()`（与 `createMcpServerRegistryPlugin` / `createComputerUsePlugin` 并列），删除该文件即停用；`meta.ts` 四个工具 id 加 `mcp__code-intel__` 前缀，description 对齐。
* 新增端到端用例：code-intel + registry 装配 → `harness.start` 连接 → `tool.pool.assemble` 暴露 4 个 `mcp__code-intel__*` 工具且无前缀直装工具不在池中。

### 测试与版本

* 新增 `server.test.ts` 用例：initialize、tools/list、tools/call 四工具、未知工具/方法走 JSON-RPC 错误码、rename dryRun 不落盘、transport 响应回传与队列，以及 3 条插件装配集成用例（install 后 registry 可见 code-intel 条目 + 纯 MCP 无直装工具；transport 经 `@harness/mcp-client` `McpClient.connect` + `listTools`=4 + `callTool` 可用；端到端 harness.start 连接暴露 `mcp__code-intel__*`）。修复 `fail(message, code)` 参数顺序、`resolvePathRelative` 未定义、测试同步等待异步 `tools/call` 响应三类问题。code-intel 包 70 用例全过、typecheck 通过；cli 95 用例全过。插件 version 0.11.0。

## 2026-09-06（续 71）code-intel：多语言导航新增 Java

> 承接续 70。为 tree-sitter 后端补 Java 支持，与 Go/Python/Rust 同一条链路（名字命中型引用，非语义编辑）。

### 实现（src/multi.ts + scripts/copy-grammars.mts）

* `MULTI_EXT` / `GRAMMAR` / `WASM_FILE` 增 `.java` → `tree-sitter-java`（依赖 `tree-sitter-java@^0.23.5`，wasm 已确认）。
* `javaSymbols` 提取器：class/record → class；interface/annotation_type → interface；enum → enum；method/constructor → function；字段/局部变量（`variable_declarator`，可多声明符）→ variable；import（`scoped_identifier` 最末段，含 `import static java.lang.Math.max` 取 `max`）→ import。
* `TOKEN_TYPES['.java'] = {identifier, type_identifier}`（经实探确认 Java 无 `field_identifier`，类型引用走 `type_identifier`）。
* `copy-grammars.mts` 增 Java wasm，构建时复制到 `dist/`。
* `index.ts` 的 `SUPPORTED_EXT = BABEL_EXT ∪ MULTI_EXT` 自动含 `.java`，无需改分派。

### 测试与版本

* 新增 3 用例：Java 符号提取（class/interface/enum/record/方法/构造器/字段/局部变量/导入，含 static 导入与行号）、Java 引用（类型标识符与方法调用、声明处排除）、目录聚合（babel .ts + tree-sitter .py/.go/.java 合并）。code-intel 58 用例全过、typecheck 通过。插件 version 0.10.0。

## 2026-09-06（续 70）code-intel：多语言 wasm 显式复制到产物（import.meta.url 相对定位）

> 更正续 69 实现。用户指定对齐 web-tree-sitter 自身做法：ESM 内 `new URL('tree-sitter.wasm', import.meta.url)` 相对模块目录定位，构建脚本把三个语法 wasm **显式复制**到产物目录，运行时 `Language.load(bytes)` 命中相邻文件即可、无需 node_modules 落盘。弃用续 69 的 env base64 注入方案。

### 相邻产物复制（src/multi.ts + scripts/copy-grammars.mts）

* `WASM_FILE`：`.go/.py/.rs` → `tree-sitter-{go,python,rust}.wasm` 文件名（定位于本模块同目录）。
* `readGrammarBytes(ext)` 来源优先级：
  1) **相邻产物**：`fileURLToPath(new URL(WASM_FILE[ext], import.meta.url))` 相对模块定位，命中即用（对齐 web-tree-sitter 自身）；
  2) **磁盘回退**：`createRequire.resolve` + `readFileSync`（dev/测试路径）。
* `languageFor` 保持 `Language.load(bytes)`（Uint8Array），同一 API 兼容两来源。
* 新增 `scripts/copy-grammars.mts`：`createRequire.resolve` 定位三个 node_modules 语法 wasm，`copyFileSync` 复制到 `dist/`（缺省出参 `process.argv[2]`），`build` 脚本前置执行。dist 已 gitignore。

### 测试与版本

* 用例改为「相邻产物复制优先 + node_modules 回退」：无相邻文件时回退校验字节长度、放置相邻文件后校验字节一致。工作区全量 452 用例全过、typecheck 通过。插件 version 0.9.0。

## 2026-09-06（续 69）code-intel：多语言 wasm 支持内联字节（适配单二进制打包）

> 承接续 68。解决「语法 wasm 依赖 node_modules 落盘文件、单二进制打包后路径失效」的问题。经实测 bun 1.3.14 无法经导入查询（`?arraybuffer`/`?raw`/import attribute）无损内联二进制，转用**环境变量注入**（方案3）：运行时优先进 `Language.load(bytes)` 用内联 Uint8Array，未注入则回退磁盘读取。

### 字节化加载（src/multi.ts）

* `readGrammarBytes(ext)`：返回语法 wasm 的 `Uint8Array`（供 `Language.load(bytes)`）。
  1) **env 内联**：读 `HARNESS_GRAMMAR_B64_GO/_PY/_RS`（各语言语法 wasm 的 base64）→ `Buffer.from(b64,'base64')` 解码；base64 非法则回退。
  2) **磁盘回退**：`createRequire.resolve` 定位 node_modules 语法 wasm + `readFileSync`（dev/测试路径）。
* `languageFor` 由 `Language.load(path)` 改为 `Language.load(bytes)`，同一 API 兼容内联/磁盘两来源。
* 单二进制打包用法：构建时把某语言 wasm 转 base64 写入对应 env 再跑 `bun build --compile`，运行时即无需 node_modules 落盘。

### 测试与版本

* 新增用例「env 内联字节注入」：注入 Go wasm base64，验证 `readGrammarBytes` 返回字节且完整索引链路可解析 `injectedFn`。code-intel 55 用例全过、typecheck 通过。插件 version 0.8.0。

## 2026-09-05（续 68）code-intel：换 web-tree-sitter 支持多语言导航

> 承接续 67。为 code_symbols / code_reference / code_definition 补上 Go / Python / Rust 多语言导航能力，采用**双后端**策略：TS/JS 保留 babel（语义引用），Go/Python/Rust 走 web-tree-sitter（名字命中型引用）。语义编辑（rename/replace_*）不扩到非 JS 语言。

### 多语言引擎（src/multi.ts）

* `getMultiParser()`：惰性单例 Parser + `Parser.init()`，预加载三语法 wasm；任一语言失败只降级该语言，不整包失败（返回 null 由上层跳过、不中断索引）。
* `GRAMMAR` 映射 `.go/.py/.rs` → 各 `tree-sitter-*` 包的 wasm，经 `createRequire.resolve` 定位。校验了包内 wasm 文件全部就位（`web-tree-sitter.wasm` / 三语言 `*.wasm`）。
* `extractMulti(content, filePath, relativePath, ext)`：`parser.parse`（返回值可为 null，取 `tree.rootNode`）→ 各语言提取器产出 `CodeSymbol[]` + 名字命中型 `CodeReference[]`。
  * **Python**（pythonSymbols）：函数/异步函数/类；import_statement / import_from_statement（name 字段，带别名时含 `json as js`）；assignment / augmented_assignment 的标识符左目标（排除 self/cls）→ variable。
  * **Go**（goSymbols）：function_declaration / method_declaration / method_spec → function；type_spec → struct_type 为 class / interface_type 为 interface / 其余 type；const_spec / var_spec → variable；import_spec 取别名或裸串。
  * **Rust**（rustSymbols）：function_item / struct_item / enum_item / trait_item / type_item / const_item / static_item 按 `KIND_BY_TYPE` 映射；use_declaration 取 `name` 末段 → import。
  * 引用为 token 文本命中 + 排除声明 name 节点的集合式匹配（tree-sitter 无作用域绑定，故非语义级；babel 语义引用不受影响）。

### 后端分派（src/index.ts）

* `SUPPORTED_EXT` = babel 扩展 ∪ `MULTI_EXT(.go/.py/.rs)`；`indexFile` 按扩展名分派到 babel（`BABEL_EXT`）或 tree-sitter（`extractMulti`），失败降级为「不支持」，不中断索引。

### 测试

* 新增「多语言导航（tree-sitter）」块 6 用例：Py 符号（函数/类/变量/导入 + 行号）、Py 名字命中型引用（排除声明处）、Go 符号（函数/方法/struct→class/interface/变量/导入）、Rust 符号（fn/struct/trait/enum/const + 引用）、目录聚合（babel(.ts)+Py+Go 合并）、编辑隔离（对 .py rename 报 SYMBOL_NOT_FOUND 且不落盘）。全仓 code-intel 54 用例全过、typecheck 通过。插件 version 0.7.0，meta 描述补多语言双后端标注。

## 2026-09-05（续 67）code-intel v2：rename 跨目录全局反向 import 解析

> 承接续 66。解决 import 反向查找：当符号定义在扫描根内、但被根之外的文件 `import { symbol } from '...'` 使用时，重新命名能同步外部导入方，避免改名字不一致。

### resolveImporters + importRoot

* `CodeSemanticEditRenameInput` 增 `resolveImporters?: boolean`（默认关，伪入开关）与 `importRoot?: string`（反向扫描根，缺省 ctx.cwd，可收紧）。
* `resolveModuleFile(spec, importerDir)`：仅相对说明符，补齐扩展名 / index 文件解析为本地绝对路径；裸包/别名/未命中返回 null。
* `CodeIntelIndex.reverseImporters(reverseRoot, relBase, symbol, declaringFiles, skip)`：在 reverseRoot 内枚举文件，遍历 `ImportDeclaration` / `ExportNamedDeclaration`（含 source），凡 import/再导出 `symbol` 且说明符解析命中 declaringFiles 中模块的文件 → 复用 `collectRenameSites` 收集改名位点。
* `execRename`：先经 scope 过滤，再据索引缓存 `symbols`（kind !== 'import'）判定真实声明模块（排除仅 import 的本地绑定），开启时反向拉入外部导入方并 merge 进 byFile；输出回显 `resolveImporters` / `importRoot` 与 `importers[]`。外部导入文件同样先内存变换 + tryParse 校验，任一失败整体放弃。

### 测试

* code-intel 扩至 48 用例全过（跨目录反向改名/缺省不越界/再导出/importRoot 收紧/importRoot 越界）；全仓 typecheck 通过。插件 version 0.6.0，meta/文档/开发日志同步。

## 2026-09-05（续 66）code-intel v2：rename 加 scope 限定 + replace_subtree 目录批量

> 承接续 65。补齐两处批量编辑能力：rename 子目录白名单限定（控制改名爆炸半径），replace_subtree 支持目录一键批量替换所有匹配文件。

### rename + scope（子目录白名单）

* 输入 `CodeSemanticEditRenameInput` 增 `scope?: string`：在已扫描的根 `path` 下，仅编辑该子目录/文件内的命中，相对根解析。
* `filterByScope`：`file === scopeAbs || file.startsWith(scopeAbs + sep)` 白名单过滤；越界报 `PATH_OUTSIDE_CWD`，scope 内无命中报 `SYMBOL_NOT_FOUND`（与 path 同语义）。输出回显 `scope`，permission `extractPatterns` 追加 scope。

### replace_subtree 目录批量

* `path` 语义扩展为「文件或目录」；`CodeIntelIndex` 新增 `collectSubtreeFromScope`（镜像 `collectRenameSitesFromScope`，成员链选择器内容定位天然可跨文件）。
* 输出重构为逐文件 `files[]`（`CodeSemanticEditSubtreeFileResult`：path/relativePath/count/matches/preview），顶层 `total` 为全部文件匹配总数。
* 隔离性：逐文件先内存变换 + `tryParse` 重解析，任一失败整体放弃；根路径不存在报 `PATH_NOT_FOUND`（区别于"存在但无匹配"的 `SUBTREE_NOT_FOUND`）；dryRun 只预览不落盘。

### 测试

* code-intel 扩至 43 用例全过（scope 白名单/无命中/越界、目录批量/无匹配/根不存在 + 原 dryRun 断言适配 `files[]`）；全仓 typecheck 通过。插件 version 0.5.0，meta/文档/开发日志同步。

## 2026-09-04（续 65）code-intel v2：code_semantic_edit 新增 replace_subtree（成员链子表达式替换）

> 承接续 64。在 replace_node（行列范围吸附节点）基础上，补第三种结构编辑模式：按成员链路径（`config.server.host`）精确定位并替换子表达式。

### replace_subtree

* 输入：单目标文件 + 成员链选择器（`selector`，如 `config.server.host`，仅标识符/字符串属性，含下标按非法拒绝）+ replacement（空串=删除该子表达式）+ dryRun。
* `memberChainText`：把 AST 节点还原成 `a.b.c` 文本（`MemberExpression`/`OptionalMemberExpression`/`Identifier`，computed 仅接受字符串字面量）。
* `collectSubtreeMatches`：遍历 AST 收集 `chainText === selector` 的**topmost**节点——排除作为更长成员链 object 的匹配，避免 `a.b.c` 里误伤 `a.b`。
* 从后向前替换每个精确 AST 范围，落盘前内存 `tryParse` 重解析校验结构（`EDIT_INVALID_STRUCTURE` 整体放弃）；dryRun 返回匹配列表（行/列/文本）与替换后预览；写盘后缓存失效。

### 测试

* code-intel 扩至 37 用例全过（全量替换/topmost 排除/dryRun/非法选择器/未找到/越界）；全仓 typecheck 通过。插件 version 0.4.0，meta 描述同步三种 edit 模式。

## 2026-09-04（续 64）code-intel v2：code_semantic_edit 新增 replace_node（按 AST 节点范围替换）

> 承接续 63。先把上轮遗留的 workspace-management.md 表格空白清理提交（纯格式），再实现 replace_node。

### `code_semantic_edit` 重构为 mode 分发的联合输入/输出

* 输入按 `mode` 联合：`CodeSemanticEditRenameInput | CodeSemanticEditReplaceNodeInput`，输出对应联合（Rename/ReplaceNode）。
* 工具 `call` 按 mode 分派到 `execRename` / `execReplaceNode`；写声明/安全声明保持一致（isReadOnly=false、isConcurrencySafe=false、permission.key='edit'）。

### replace_node

* 输入：目标文件 + 行列范围（1-based line/column，列=该行第 1 字符为 1；`endColumn 0`=行末不含换行）+ replacement + dryRun。
* `findContainingNode`：遍历 AST 找**完全包含**用户范围的最小节点（吸附）；精确命中节点边界→relation `exact`，否则 `absorbed`（`hasInner` 提示圈选过大）。
* 行列↔偏移用 `buildLineStarts` + `lineEndExclusive` 换算（末行带换行/不带换行两态）。
* 隔离性：仅替换 AST 节点精确范围；整行圈选顺带消费紧随节点的行尾换行（避免替换后残留空行）；落盘前内存重解析校验（`EDIT_INVALID_STRUCTURE` 整体放弃）；dryRun 返回吸附节点 + 替换后预览。写盘后缓存失效。

### 测试

* code-intel 扩至 31 用例全过；cli 163 全过；全仓 typecheck 通过。定位了两处真实的边界（末行换行换算、节点类型为 VariableDeclaration 而非 ExpressionStatement）并在实现/断言中修正。

## 2026-09-04（续 63）code-intel v2：code_semantic_edit 结构感知编辑（符号重命名）

> 承接续 62，落地 codeintel-plugin.md §4 的 v2 项：结构感知编辑。

### 新增 `code_semantic_edit` 工具（mode=rename）

* 仅替换**精确的 AST 标识符 token 范围**（声明 + 引用 + import 源名），字符串/注释中的同名文本与 `obj.x` 属性访问一律不触碰——"编辑前校验隔离性"的结构保证。
* 位点收集 `collectRenameSites`：函数/类/变量/接口/类型/枚举声明、import 本地绑定与源名（`import { X as Y }`）、export 说明符本地名、ReferencedIdentifier（含对象简写）；按字符范围去重、偏移转行号。
* **编辑前校验**：全部文件先在内存中完成变换并 `tryParse` 重解析，任一失败整体放弃、不落盘（`EDIT_INVALID_STRUCTURE`）；`dryRun` 预览计划位点；写盘后 `index.invalidate` 使缓存失效。
* 安全声明：`isReadOnly=false`、`isConcurrencySafe=false`、`permission.key='edit'`（对齐 tools-builtin 写工具约定）。
* `CodeIntelIndex` 新增 `collectRenameSitesFromScope`（复用目录发现）与 `invalidate`。

### 装配与元信息

* `createCodeIntelPlugin` 注入 4 个工具（version 0.2.0）；`meta.ts` 增 `code_semantic_edit`（只读=false/非并发/edit）；cli `BuiltinPluginRegistry` 描述同步。

### 测试

* code-intel 扩至 24 用例全过（跨文件重命名隔离性/dryRun/对象简写/非法标识符/符号不存在/越界/安全声明/meta）；cli 163 全过；全仓 typecheck 通过。烟测验证：`greet`→`salute` 三处（声明/import/引用）更新，`"greet"` 字符串与 `obj.greet` 未动。

## 2026-09-04（续 62）实现 code-intel 插件（`@harness/code-intel`）

> 落地 [codeintel-plugin.md](codeintel-plugin.md) 规划的 v1：代码情报（AST 符号索引）插件化。

### 技术选型

* 按规划 §3「纯 TS 域可退化为 @babel/parser 起步」选用 **`@babel/parser` + `@babel/traverse`**（纯 JS、同步、可单测），支持 TS/TSX/JS/JSX；多语言 web-tree-sitter 留作后续演进，不改工具/插件契约。
* 索引为**内存内 + 按需增量**：parse 目标文件/目录，缓存按 mtime+size 失效；解析失败多配置回退（TS 加 jsx、纯 JS 兼容 TS 语法），单文件失败跳过不中断目录索引。

### 新包 `packages/plugins/code-intel`

* `CodeIntelIndex`：`symbols`/`allReferences`/`allDefinitions` 查询；`ignoreDirs`（默认 .git/node_modules/dist 等）、`maxFiles`(500)、`maxDepth`(8) 可配。
* 三个只读工具（`isReadOnly`+`isConcurrencySafe`+`permission.key='read'`）：
  * `code_symbols`：列文件/目录符号（函数/类/变量/接口/类型/枚举/导入），含位置、签名、exported。
  * `code_reference`：查某符号引用（跨文件，行/列 + 上下文）。
  * `code_definition`：go-to-definition（声明位置，排除 import 绑定）。
* `meta.ts`（L1 静态元信息）自包含，供 `/tools` 提前展示。

### 装配

* 根 `tsconfig.json` 注册 `@harness/code-intel`（含 `/meta` 子路径）；cli `getBuiltinRegistry()` 登记 `code-intel`（惰性 load + metaSource），boot 后台预加载即开箱即用，烟测通过（注入三工具）。

### 测试

* code-intel 17 用例全过（符号提取/缓存/三工具/越界/插件装配/meta）；cli 163 用例全过（其中 1 例 `/snapshot status` 断言随续 60 输出变更同步更新）；全仓 typecheck 通过。

## 2026-09-03（续 61）文档：整理 /snapshot 命令清单与多工作区快照隔离说明

> 承接续 59/60，把快照命令与隔离设计沉淀进 [workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3。

* §7.3.1：新增 `/snapshot` 命令清单表（查询/捕获/预览/回滚/维护五类 + 服务端方法映射），`status` 自省说明。
* §7.3.2：多工作区快照隔离——git/file 两后端存储目录默认按 `sha256(worktree)[0:16]` 派生，天然隔离；显式隔离走 `gitDirectory`/`dataDir`，将来跨工作区共享可加按 workspace 解析存储根的一层 provider，不改两后端。

纯文档，无代码变更；全仓 typecheck 不受影响。

## 2026-09-03（续 60）快照管理补全 preview/gc + status 增强（后端/启用/最新快照）

> 承接续 59。按用户需求补上 `preview`、`gc` 命令，并把 `status` 从「一句已启用」增强为展示后端与启用态、快照计数、最新快照。

### 服务层自省（@harness/snapshot）

* `SnapshotService` 接口新增只读自省字段：`backend: 'git' | 'file'`（工厂 auto 探测后两后端各自固定暴露）与 `enabled: boolean`。
* `GitSnapshotService.backend='git'`、`FileSnapshotService.backend='file'`；`enabled` 由 `private` 提升为 `readonly` 公开。

### 命令层（@harness/revert `createSnapshotPlugin`）

* `status` 增强：输出「状态（已/未启用）/ 后端 / 快照数 / 最新快照 ID / 捕获时间」，无快照给出捕获指引。
* 新增子命令：
  * `preview <to> <path...>`：零副作用回滚预览——从快照 `<to>` 恢复指定文件的 diff（不落盘，复用服务端 `preview`）。
  * `gc`：清理过期快照存储（git `git gc` / file 清理无引用备份）；后端不支持时提示。
* 帮助文本与 usage 同步补全。

### 测试

* snapshot 新增自省字段用例（两后端 + disabled 语义）。
* revert 新增 status 空快照、preview（含缺参 / diff 输出）、gc（含不支持回退）共 6 用例——revert 共 35、snapshot 共 28 用例全过；全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3

## 2026-09-03（续 59）快照管理命令扩展：list / diff / restore / checkout

> 承接续 57/58，按用户需求「增加更多快照管理命令和回滚命令，如快照列表、内容 diff」，把 `/snapshot` 从只读信息命令扩成完整管理工具。

### 服务层（@harness/snapshot）

* `SnapshotService` 接口新增 `list(): Promise<SnapshotInfo[]>`，返回快照历史（最新在前）。
* 新增 `SnapshotInfo` 类型（`id` + 可选 `timestamp`），两后端一致：
  * `GitSnapshotService.list()` 读 `snapshot-ids.json`，旧版纯字符串数组自动迁移（ts=unknown）。
  * `FileSnapshotService.list()` 读 `snapshots.json` 快照链。

### 命令层（@harness/revert `createSnapshotPlugin`）

* 新增子命令：
  * `list`：列出快照历史（最新在前，含本地化时间戳；无快照给出捕获指引）。
  * `diff <from> <to> [path]`：两快照间增量统计（新增/修改/删除 + 行数）；给 path 时附 unified 补丁。
  * `restore <to> <path...>`：从快照 `<to>` 选择性恢复指定文件（目标快照中不存在则删除）。
  * `checkout <to>`：整仓恢复到快照 `<to>`。
* 对齐助手补全 `/snapshot` 帮助文本与 usage（统一缩进对齐）。

### 测试

* revert 新增 list（含时间戳 / 空快照）、diff（摘要 + 补丁 / 缺参 / 无差异）、restore（恢复映射 / 缺参）、checkout（成功 / 缺参）等 8 用例——revert 共 30 用例全过。
* snapshot、cli 用例仍全过；全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3

## 2026-09-03（续 58）修复 config.json 快照配置未生效（兼容嵌套 harness.snapshot）

> 承接续 57。用户按帮助提示在 `~/.harness/config.json` 写了 `"harness": { "snapshot": true }` 但未生效——续 57 代码只读顶层 `cfg.snapshot`，而现有 config 为扁平结构，本身并无 `harness` 包裹层，是帮助文字给了嵌套写法示例导致的错配。

* `HarnessConfig` 增加 `harness?: { snapshot?: boolean }`（文档标注为兼容写法）。
* `main()` 快照解析改为 `args.snapshot ?? cfg.snapshot ?? cfg.harness?.snapshot ?? false`，兼容顶层与嵌套两种写法。
* 帮助文字与 `/snapshot` 未启用提示统一：顶层 `"snapshot": true` 为主，嵌套 `"harness": { "snapshot": true }` 亦可用。

`@harness/cli` 163 + `@harness/revert` 22 用例仍全过；全仓 typecheck 通过。

## 2026-09-03（续 57）快照功能开启 + `/snapshot` 信息命令（方案 A+B+C）

> 承接续 55/56 调研结论落地：A（CLI `--snapshot` flag）+ B（config.json `harness.snapshot` 持久化，优先级 CLI>config>默认 false）+ C（新增薄壳 `/snapshot` 命令）。

### 开启快照（@harness/cli）

* `CliArgs`/`parseCliArgs` 增加布尔 `--snapshot`；`HarnessConfig` 增加 `snapshot?: boolean`。
* `main()` 解析 `args.snapshot ?? cfg.snapshot ?? false` 传入 `HarnessApp({ snapshot })`，覆盖 repl / run / resume 路径。
* `HELP_TEXT` 增加 `--snapshot` 说明。

### `/snapshot` 薄壳命令（@harness/revert）

* 新增 `createSnapshotPlugin`（id=`snapshot-shell`）：`cli.commands` 注册 `/snapshot`；`cli.command` 处理 `status|capture [scope]|files <from> <to>|help`，只读/轻量操作。
* 依赖 cli 注入的 `input.snapshotService`；未启用时给出开启指引（`--snapshot` / config.json），不抛错。cli `providerPlugins.push(createSnapshotPlugin())` 并将其登记（同 revert-shell）。

### 测试与验证

* revert 新增 `createSnapshotPlugin` 7 用例（命令注册 / 未启用提示 / 缺省 status / capture / files·缺参 / 非 snapshot 不设 result / 稳定 id）——revert 共 22 用例全过。
* cli 新增 `--snapshot` 解析用例 + 4 条 `/snapshot` boot 集成用例（未启用提示 / status / files 缺参 / /help 包含）——cli 共 163 用例全过。全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3

## 2026-09-03（续 56）snapshot/revert 薄壳插件化：`createRevertPlugin`

> 承接续 55，落实 workspace-management §7.3「预创建 + 薄壳」模式同样适用于 snapshot 插件化。把内联在 cli 的 `/revert` 命令抽成 `@harness/revert` 包内的薄壳 AgentPlugin，快照服务由 cli 预创建后经 cmdInput 注入，消灭 cli 内联回滚逻辑。

### 实现（@harness/revert）

* 新增 `createRevertPlugin(opts?)` 薄壳插件（id=`revert-shell`）：
  * `cli.commands` 注册 `/revert` 命令定义（自动并入 `/help` 与 TUI 命令面板）。
  * `cli.command` 提供 `stage|clear|commit|status|help` 五子命令，复用同包 `createSessionRevert` 三态控制器。
  * 数据依赖全部来自 cli 注入：`input.snapshotService`（HarnessApp.snapshotService）+ `input.harness.session/bus`；未启用 snapshot 或未注入时给出提示不抛错。
  * 子命令/参数从完整 `input.raw` 解析（cli 注入的 arg 只含第二 token，同 workspace-shell 处理）。
* 新增 `@harness/plugin` 依赖。

### cli 接入

* `providerPlugins.push(createRevertPlugin())`（与 workspace-shell 并列）；cmdInput 注入 `snapshotService: app.snapshotService`。
* 删除内联 `case '/revert'` 块与已不再使用的 `createSessionRevert/RevertEvents/RevertState` import；`/help` 里硬编码的 `/revert` 行移除，改由 `cli.commands` 自动列出（避免重复）。

### 测试与验证

* revert 新增薄壳插件 5 用例（命令注册 / 未启用提示 / session·bus 未注入提示 / 非 revert 不设 result / 稳定 id）——revert 共 15 用例全过。
* cli 既有 6 条 `/revert` 集成用例经 boot+REPL 走插件路径仍全过（@harness/cli 158 用例全过）；全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3

## 2026-09-03（续 55）workspace-shell 扩展 `/workspace open` 子命令

> 承接续 54。给薄壳插件 `@harness/workspace-shell` 增加子命令，用于用系统文件管理器打开各工作区目录，仍保持薄壳（仅展示 + 打开，不解析资源）。

### 实现（@harness/workspace-shell）

* `resolveOpenTarget(ws, target?)`：纯函数，解析 `/workspace open [target]` 目标路径——
  * 缺省 / `user` / `data` → `dataDir`（用户级根 ~/.harness）
  * `cwd` → 工作目录；`project` → 项目级根（<cwd>/.harness）
  * 其他 → 相对 cwd resolve，存在返回路径、不存在返回 `{ error }`。
* `openInFileManager(path)`：跨平台打开目录（darwin `open` / win32 `explorer` / Linux `xdg-open`），spawn 失败返回 `{ ok:false, error }`；签名 `OpenDir` 可注入（`opts.open`），测试注 spy。
* `cli.command` handler 增加子命令解析：`open`（经 resolveOpenTarget → open，输出已打开/失败/目录不存在）、`help`（用法说明）；其余（含空）仍渲染布局。命令 `usage` 更新为 `/workspace [open [cwd|user|project|路径]]`。

### 测试与验证

* 新增 8 用例：resolveOpenTarget 三类（别名映射/相对路径/不存在）；open 子命令缺省目标、cwd/project、目录不存在、失败、help。
* workspace-shell 共 16 用例全过；全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.1

## 2026-09-03（续 54）core 的 agents/skills 内部加载改用 MultiDirLoader（扫描逻辑收敛）

> 承接续 52/53。把 core 装配 agentDirs/skillDirs 时手写的 `readdir + 来源标注 + join` 骨架也收敛到 workspace 的 `MultiDirLoader`，消除 core 与 cli 的重复扫描逻辑。

### MultiDirLoader 扩展（@harness/workspace）

* `DirItem` 新增 `kind: 'file' | 'dir'` 字段（由 `readdirSync({withFileTypes:true})` 的 `Dirent.isDirectory()` 判定）。
* `MultiDirFilter` 新增 `kind?: 'file' | 'dir'` 过滤条件，支持「仅枚举文件/仅枚举目录」的消费方（如 agent 加载只处理 .md 文件）。

### core 接入

* **Agent 加载**：`agentLoader.scan({ kind: 'file', name: n => extname(n) === '.md' })` 枚举 .md 文件并逐项容错解析，替换手写 readdir 循环；来源仅用于日志（AgentDefinition 无 loadedFrom，覆盖由加载顺序保证）。
* **Skill 加载**：`normalizeDirs(skillDirs, 'project')` 归一（兼容 string / {dir,source} 对象），遍历 `skillLoader.dirs` 调 `skillManager.load(dir, source)`，每目录失败仅 warn 不阻塞。
* 删除 core 不再使用的 `existsSync`/`readdirSync` 相关手工枚举导入；`@harness/workspace` 依赖已在 package.json 注册。

### 测试与验证

* MultiDirLoader 新增 `kind 标注 + kind 过滤（仅文件/仅目录）` 用例（workspace 共 14 用例全过）。
* core 新增「多级目录加载」集成套件 2 例：agentDirs user→project 同名覆盖 + 仅 user 保留；skillDirs 目录式/单文件式加载 + 同名 project 覆盖（core 共 33 用例全过）。
* 全仓 20 包 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.4

## 2026-09-02（续 53）工作区管理（四）：薄壳插件 @harness/workspace-shell + /workspace 命令

> 承接续 52。落实规划文档 §7.1/§7.3：用薄壳 AgentPlugin 把「解析好的 Workspace 布局」以 /workspace 命令展示在 REPL，业务能力经插件注入，不与 cli 主逻辑耦合。

### 新增插件包 @harness/workspace-shell（packages/plugins/workspace-shell）

* `renderWorkspace(ws, title?)`：纯函数，把 Workspace 渲染为文本——cwd/dataDir、dataDir 数据文件（config/permissions/sessions/.config-key）、两级（user×project）各 plugins/skills/agents 路径，`✓` 标记已存在路径，并注明「user → project 后者覆盖前者」加载顺序。
* `createWorkspacePlugin(opts?)`：cli.commands 注册 /workspace；cli.command 命中则输出 renderWorkspace。数据来源优先级 `input.workspace`（cli 注入）→ `opts.workspace`（显式入参），两者皆无则提示「工作区未注入」（插件可独立安装/测试不炸）。处理完成设 `input.result='continue'`，未命中其他命令不设 result（fallthrough 交给别的插件）。
* 依赖 `@harness/plugin` + `@harness/workspace`。

### CLI 接入

* boot 装配：`providerPlugins.push(createWorkspacePlugin())`（与 tools-manager 并列，随应用打包的内置插件）。
* cmdInput 构造加注入 `workspace: app.workspace`（HarnessApp 已解析的 Workspace，见续 51），薄壳插件经 `input.workspace` 消费；类型由 cli 侧声明 `workspace: Workspace`。
* 根 tsconfig paths 与 cli dependencies 注册 `@harness/workspace-shell`。

### 测试与验证

* 新增插件 8 用例（workspace-shell）：render 输出与 ✓ 标记、命中/未命中/未注入分支、cli.commands 注册、id 稳定。
* cli 158 用例全过；全仓 20 包 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.1/§7.3

## 2026-09-02（续 52）工作区管理（三）：MultiDirLoader 通用多级目录加载器

> 承接续 51。落实规划文档 §7.4 的第一步——把 cli 与 core 各自重复手写的「readdir + 来源(user/project)标注 + join(dir,name)」多级扫描骨架收敛为 workspace 通用原语 `MultiDirLoader`，并让 cli 装配改走解析好的 workspace 路径（消灭 magic path）。

### 实现（@harness/workspace）

* 新建 `packages/workspace/src/multi-dir.ts`：
  * `DirSource = 'user' | 'project'`、`DirEntry{dir,source}`、`DirItem{source,name,full}`、`DirEntryInput`。
  * `normalizeDirs(dirs, defaultSource?)`：字符串 → `{dir,source}` 归一（缺省 source 可配，默认 user）。
  * `dirsFromPair([userDir, projectDir])`：`workspace.loadDirs` 目录对 → 两级 `DirEntry[]`。
  * `MultiDirLoader`：`scan({name?})` 同步枚举全部目录项并标注来源（目录缺失/不可读跳过，不阻塞）；`collect(parse, key, filter?)` 异步收集 + 按 key 去重（后扫描覆盖先扫描 → project 覆盖 user），`parse` 返回 undefined 忽略（容错）。
* `index.ts` 补 `export * from './multi-dir'`。

### core 修正：目录解析 `join → resolve`

* core 装配 agentDirs/skillDirs 用 `join(cwd, dirPath)` 解析——对**绝对路径会拼接在 cwd 下而错位**（`path.join('/a','/b') === '/a/b'`），导致 workspace 传入的绝对 user/project 目录不可达（并掩盖既有的 user 绝对目录 bug）。
* 改为 `resolve(cwd, dirPath)`：相对目录仍正确落在 cwd 下（行为不变），绝对目录正确原样命中。属严格修复，对齐「workflow dataDir 绝对化」诉求。

### 接入（cli）

* `loadPluginDirs` 内部改用 `MultiDirLoader(normalizeDirs(dirs)).scan(...)` 枚举（保留既有「按 id 去重 / 单模块容错 / Provider 类型注册」语义），删去手写 readdir 循环与不用的 `readdir` 导入。
* boot 装配外链插件 / agents / skills / buildCheckRegistry / teammate teamsDir：由 `join(home,'.harness','plugins')` 等硬编码改为 `this.workspace.user|project.{plugins,agents,skills}` 与 `app.workspace.files.teams`，`--data-dir` 覆盖真正生效；删去 cli 不再使用的 `homedir` 导入。

### 测试与验证

* 新增多级目录 8 条用例（multi-dir.test.ts）：normalize 缺省来源 / dirsFromPair / scan 枚举+来源标注+覆盖顺序 / filter.filter / 目录缺失跳过 / collect 去重覆盖 / parse undefined 忽略。workspace 共 13 用例全过。
* @harness/cli 158、@harness/core 31 用例全过；全仓 20 包 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.2/§7.4

## 2026-09-02（续 51）存储类工厂迁移：配置/会话/密钥存储消费 Workspace 路径

> 承接续 45 的 `resolveWorkspace`，落实「工作区管理（二）」：把 cli 里私有、硬编码 `join(dataDir, 'xxx')` 相对路径的 `ConfigStore` / `SessionFileStore` / `SecretCipher` / `ConfigValidationError` / `resolveSecret` 抽离到 `@harness/workspace`，改为消费 `Workspace` 解析出的路径（`ws.files.*`），消灭 magic path。

### 包形态（@harness/workspace）

* 新建 `packages/workspace/src/storage.ts`（仅「定位 + 读写」，不含业务装配），并加依赖 `@harness/session`（`Message` / `Session` 类型）；`index.ts` `export * from './storage'` 收敛导出。
* 导出（均构造于 `Workspace`）：
  * `ConfigValidationError`
  * `SessionFileStore`（`workspace.files.sessions`；`ensureDir/pathFor/toFile/save/load/list`）
  * `ConfigStore<T extends object>`（`workspace.files.config`；`load` 幂等返回空对象）
  * `SecretCipher`（`workspace.files.secretKey`；AES-256-GCM，主密钥来源 `HARNESS_CONFIG_KEY` 优先于 `.config-key`）
  * `resolveSecret(value, cipher)`（`${ENV_VAR}` 展开 / `enc:v1:` 解密 / 明文透传）

### 接入（cli）

* 移除本地 `ConfigStore` / `ConfigValidationError` / `SecretCipher` / `resolveSecret` 定义（`SessionFileStore` 同前已删），改为从 `@harness/workspace` 导入并**统一重导出**（`export { ... } from '@harness/workspace'`），对外含测试接口不变；同时删去 cli 侧不再使用的 `node:crypto` 导入。
* `HarnessApp` 新增 `workspace: Workspace`（`resolveWorkspace({ cwd, dataDir })` 构造），`sessionStore` / `permissionStorePath` / `configStore`（`ConfigStore<HarnessConfig>`）/ boot 的 `SecretCipher` 均改为消费 `this.workspace`。
* `runConfigCommand` 入参由 `dataDir`/`cwd` 收敛为 `workspace: Workspace`（`check` 子命令改用 `workspace.cwd`）；`main()` 复用既有 `ws` 构造 `ConfigStore<HarnessConfig>` / `SessionFileStore`。

### 测试与验证

* cli.test.ts 存储相关构造由传 `dir` 改为 `resolveWorkspace({ dataDir: dir })`。
* `@harness/workspace` 5 用例、`@harness/cli` 158 用例全部通过；两个包 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md)（工作区管理（二）存储工厂）

## 2026-09-02（续 45）工作区管理（一）：@harness/workspace 核心库 resolveWorkspace

> 归属「工作区管理插件化」规划（docs/workspace-management.md §7）第一步——核心库「定位与解析」。用户选定先做 `resolveWorkspace`，其余存储工厂 / MultiDirLoader / 薄壳插件后续逐个推进。

### 包形态

* 新建 `packages/workspace`（`@harness/workspace`），仅做「定位与解析 + 目录布局」，不含 Provider/插件装配，不与 core/CLI 主逻辑耦合（对齐"全功能插件化"约束，借鉴 `@harness/snapshot`）。

### 实现（workspace/src/index.ts）

* `resolveWorkspace({ cwd?, dataDir? })`：`cwd` 缺省 process.cwd()、`dataDir` 缺省 ~/.harness，均 resolve 为绝对路径；项目级目录固定 `<cwd>/.harness`。
* 返回结构：
  * `cwd` / `dataDir`（用户级根）
  * `user` / `project`：两级 `WorkspaceLevel`（root / plugins / skills / agents）
  * `files`：dataDir 下全局数据文件/目录（config.json / permissions.json / sessions / .config-key / snapshots / file-snapshots / backups / teams）
  * `loadDirs`：两级扫描路径对（plugins/skills/agents，user 在前、project 在后，后者覆盖）
* 导出 helpers：`level(root)`、`dataFiles(dataDir)`、`defaultUserDir()`。

### 接入（cli）

* `main()` 删去硬编码 `dataDir = args.dataDir ?? join(home, '.harness')`，改用 `resolveWorkspace({ cwd, dataDir })` 取 cwd/dataDir，路径解析收敛至核心库。

### 配置

* `tsconfig.json` 增 `@harness/workspace` → `./packages/workspace/src` 路径映射。
* 依赖序：workspace 不依赖其他包（纯 node path/os）。

### 测试与验证

* 新增 5 条用例（workspace.test.ts）：两级目录 + 数据文件路径绝对化 / 两级扫描覆盖序 / dataDir 缺省 / 项目级与用户级目录独立 / helpers。全部通过。
* 全仓 typecheck 通过（含新包 + cli 接入）；@harness/cli 90 用例全过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.2/§7.3

## 2026-09-01（续 44）config.json 的 agents[].tools 回读消费端

> 归属「/tools 可插件化（方案 A：补 core/CLI 配置接口）」第一步。先打通 Agent 白名单持久化的读取端。

### 调研结论（2026-09-01）

- core 的 `Harness` 接口无配置持久化访问器；`PluginContext.config.get/set` 仅是 `initialConfig` 种子的**内存 map**，set 不写盘，且 cli 调 `createHarness` 未传 `config`，运行期为 `{}`。
- config.json 唯一读写实现是 cli 私有 `ConfigStore`，不暴露给插件；`cli.command` 输入 `{raw,command,arg,out,sessionId}` 不含 dataDir/configStore。
- **缺口**：`HarnessConfig` 原无 `agents[]`，即使插件写入 Agent 白名单，cli 启动回读也无消费端 → 死数据。须先补读取端。

### 实现（cli）

- `HarnessConfig` 新增 `agents?: Array<{ id: string; tools: string[] }>`（Agent 工具白名单覆盖）。
- 新增 `HarnessApp.applyConfigAgentTools(harness)`：读 config.json → 对每项按 id 命中的已注册 Agent 用 `register({...existing, tools})` 覆盖 tools。**位置须在 createHarness 全部组装后、query 前**——工具池在 query 时经 `filterByWhitelist(agent.tools)` 实时读白名单，故可覆盖 default / options.agents / agentDirs（md）任何来源的同名 Agent。
- boot() 中 createHarness 后、`harness.start()` 前调用。

### 测试

- cli.test.ts：预置 config.json `agents:[{id:'default',tools:['bash','echo']}]`，boot 后断言 `harness.agent.get('default').tools` 被覆盖（缺省 `tools:['*']`）。

### 下一步

- 写 `/tools` 插件持久化端（upsert config.json 的 agents[].tools）+ `--global` 运行时启停（方案 B 所见即所得）。

## 2026-09-01（续 45）实现：/tools 工具管理插件

> 承接续 44 的回读消费端，按「可插件化」落地 `/tools` 命令。新增插件包 `packages/plugins/tools-manager`（`@harness/tools-manager`）。

### cli 侧注入能力

- `PluginContext` 无持久化接口，故在 `CliCommandInput`（`@harness/plugin`）扩展可选字段：`agentId`、`setAgentTools(agentId, tools)`、`harness`（unknown，由消费插件自行类型化）。
- `HarnessApp` 新增 `setAgentTools(agentId, tools)`：upsert config.json 的 `agents[].tools` 并即时 `register({...existing, tools})` 覆盖运行时（写盘 + 内存一次完成）。
- REPL 内核构造 `cli.command` 输入时注入上述三字段。

### tools-manager 插件（`/tools`）

- 经 `cli.commands` / `cli.command` hook 注册，按"全功能插件化"约束实现，不耦合 cli/core。
- 命令语义：
  - `/tools` → 当前 Agent 可用工具（filterByWhitelist）；`/tools --all`/`--json` → 全局注册清单。
  - `/tools <id>` → 详情（描述/别名/安全声明/启用态）。
  - 作用域 A（默认）：`/tools <id> on|off` → 改 agent 白名单并 `setAgentTools` 持久化。`off` 遇 `*` 白名单展开为显式（除目标外全部注册工具）后持久化。
  - 作用域 B：`/tools <id> --global on|off` → 运行时 `harness.tools.unregister/register`，插件内 `suspended` Map 缓存被卸载 Tool 供 on 恢复；不持久化，仅本轮进程。
- 安全声明为函数（`isReadOnly(isDestructive)`），展示时 `?.(undefined)` 求值。

### 注册

- 根 tsconfig `paths`、cli `dependencies` 注册 `@harness/tools-manager`；经 `BuiltinPluginRegistry` + boot 惰性加载。

### 测试

- tools-manager.test.ts 7 例：命令注册 / 空参列表 / `--global` off+on 往返 / 作用域 A off、on、通配展开 / 详情未找到。cli 86 例保持通过，全仓 typecheck 通过。

### 修复：命令处理后 fallthrough 到"未知命令"（2026-09-02）

- 现象：`/tools` 已输出工具列表，但 cli 仍打印 `未知命令：/tools`。
- 根因：cli 的 `cli.command` dispatch 只在 `cmdInput.result === 'continue'` 时认为命令已处理，否则落到 `未知命令`；tools-manager 未设置 `result`。
- 修复：hook 用 `try/finally` 统一在 `finally` 置 `input.result = 'continue'`，任何分支（含空列表）都不会 fallthrough。
- 测试：`run()` 返回 input，列表 / off 用例断言 `result === 'continue'`，防止回归。

## 2026-09-02（续 46）优化懒加载：后台静默加载 + 多级加载（描述提前加载）

> 承接续 45 的 `/tools`。目标是让启动更快、`/tools` 信息即时可看：把「静态元信息」与「运行时模块」拆成两级加载。

### 问题

- `/tools` 依赖运行时工具模块（L2）加载完成后才有 `harness.tools`，懒加载切换期间 `/tools` 未显示/滞后显示工具信息。
- 内置插件用 `lazyImport` 惰性加载，但缺少"描述提前可用"与"失败静默"机制。

### 设计：多级加载（L1 描述 / L2 模块）

- **L1（静态元信息，启动即可用）**：新增 `packages/plugins/tools-builtin/src/meta.ts` —— 纯静态 `BUILTIN_TOOL_META`（id/描述/别名/安全声明/权限键），**无副作用、不 import index.ts**（保证不含 `node:child_process` 等重依赖）。经子路径 `@harness/tools-builtin/meta` 导出（package.json `exports` + 根 tsconfig `paths`）。
- **L2（运行时模块，惰性/后台）**：`BuiltinPluginRegistry` 的 `load()` 动态 import 真正的工具实现，保持不变。
- cli 新增 `BuiltinToolRegistry`（实现 `ToolMetaLookup`）：`boot()` 早期 `getBuiltinToolRegistry()` 同步登记全部内置工具 meta；REPL 的 `cli.command` 输入注入 `toolMeta`。

### 后台静默加载

- `HarnessApp.scheduleBuiltinPreload()`：boot 末尾 **fire-and-forget** 后台预加载内置插件/工具，经 `Promise.allSettled` 采集，失败仅写 `[WARN]`，不阻塞 boot、不抛错。`options.backgroundPreload === false` 可关闭。

### tools-manager 合并展示

- `/tools --all`/`--json`：`unionTools(已加载, toolMeta)` 合并未加载的内置工具（`(meta)` 标记）。
- `/tools <id>` 详情：运行时未加载时回退内置 meta（标注"运行时未加载，以下为内置静态元信息"）。
- 归一化 `entryFlags`：兼容运行时 `isXxx`（函数）与 meta `isXxx`（布尔）两种形态。

### @harness/plugin 扩展

- `CliCommandInput` 新增可选 `toolMeta?: ToolMetaLookup`；导出 `ToolMetaEntry` / `ToolMetaLookup` 类型。

### 测试

- tools-builtin `meta.test.ts` 4 例：登记表覆盖全 / 非空 / 长度一致 / 静态安全字段。
- cli 新增 2 例：`BuiltinToolRegistry` 同步登记+别名查找；`backgroundPreload` 后台预热有日志、`false` 关闭无日志且 boot 不阻塞。
- 全量 typecheck 通过；tools-builtin（60）/ tools-manager（7）/ cli（155）测试通过。

## 2026-09-02（续 47）补全工具元信息 + /tools 状态列（元信息可提前加载覆盖全场景插件）

> 承接续 46 的多级加载（L1 元信息 / L2 运行时）。把"元信息可提前加载 + `/tools` 显示完整元信息"从工具内置原语扩展到全部随应用打包的场景化工具插件。

### 补全其他插件的工具元信息（L1）

- 新增 4 个场景工具插件各自的 `meta.ts`（纯数据、不 import 各自 index.ts，对齐 `@harness/tools-builtin/meta` 的 `BuiltinToolMeta` 结构）：
  - `@harness/tools-search/meta`：`list_dir`、`grep_file`（只读，权限键 `read`）
  - `@harness/tools-glob/meta`：`glob`（只读，权限键 `read`）
  - `@harness/tools-web/meta`：`web_fetch`（非只读/非危险，权限键 `network`）
  - `@harness/tools-media/meta`：`view_image`（只读，权限键 `read`）
- 各 package.json `exports` 新增 `./meta` 子路径；根 `tsconfig.json` `paths` 注册 `@harness/tools-*/meta`。
- cli `getBuiltinToolRegistry()` 启动早期一次性 `registerAll` 全部工具 meta（内置原语 + 场景插件），无需加载任意 L2 运行时模块即可在 `/tools` 展示描述/别名/安全声明/权限键。

### /tools 列表：元信息 + 状态列

- 列表改为对齐表格：`ID | 元信息(描述) | 权限键 | 状态`。
- **状态列** = 启用/禁用（相对当前 Agent 白名单）· 加载状态（`已加载` / `仅元信息`）· 安全声明（只读/危险/非并发）：
  - 未加载的元信息占位仅在 Agent 白名单为通配 `*` 时视为"启用"，否则"禁用"。
- 详情视图补齐：已加载工具也输出 `权限键` 行；未加载工具回退静态元信息输出描述/别名/权限键/安全。
- 归一化 `entryFlags` + 新增 `permKeyOf` / `entryLoaded` / `entryStatus` / `renderToolTable`。

### 测试

- 4 个场景插件各新增 `meta.test.ts`：覆盖工具 id/描述/只读/并发/权限键。
- cli `BuiltinToolRegistry` 测试扩展断言 search/glob/web/media 工具及其权限键。
- tools-manager 新增 2 例：列表含"状态/权限"列与 `启用·已加载`；`--all` 合并未加载元信息显示 `仅元信息` 且详情含权限键。
- 本批涉及测试全部通过；全量 typecheck 通过（存量 TUI/dom 第三方测试失败与本批无关）。

## 2026-09-02（续 48）修复：/tools 元信息、Agent 可用工具、computer-use 元信息、后台预加载、命令历史

> 承接续 47。用户反馈 4 个问题：1) `/tools` 未打印元信息且 Agent 可用工具受懒加载影响；2) computer-use 的 MCP 工具元信息需补充；3) 懒加载的后台加载功能未生效；4) 命令历史无法上下切换。

### 1) `/tools` 打印元信息 + Agent 可用工具不受懒加载影响（tools-manager）

- 原列表默认走 `filterByWhitelist`，只输出**已加载**工具 → 懒加载期间大量工具"消失"、元信息缺失。
- 新增 `agentUsableEntries(inp)`：合并「已加载且在白名单内的运行时工具」+「白名单内未加载的静态元信息」，补齐描述。
  - 通配 `*` 白名单 → 全部静态元信息（`unionTools`）；显式白名单 → 仅补白名单内未加载的工具。
- `entryStatus` 修正：未加载但显式在白名单的元信息工具标记为 `启用·仅元信息`（原只有通配 `*` 才算启用）。

### 2) computer-use MCP 工具元信息补充（L1）

- 新增 `packages/plugins/computer-use/src/meta.ts`：登记 11 个 MCP 工具（`mcp__computer-use__<toolName>`）的静态元信息（只读/可写、非并发、权限键）。
- `package.json` `exports` 新增 `./meta` 子路径；根 `tsconfig.json` `paths` 注册 `@harness/computer-use/meta`。
- cli `getBuiltinToolRegistry().registerAll` 追加 `COMPUTER_USE_TOOL_META`，使 `/tools` 在 server 未连接加载时也能展示其描述/安全/权限键。
- 新增 `meta.test.ts` 覆盖 id 前缀/非空描述/只读语义/唯一性。

### 3) 懒加载的后台加载功能未生效（cli）

- 根因：`BuiltinPluginRegistry` 只登记 `tools-builtin` 与 `tools-manager`，而这两者已在 boot 早期被**急切加载**，故 `scheduleBuiltinPreload` 实际上"无事可预热"。
- 修复：把随应用打包的场景化工具插件并入 `BuiltinPluginRegistry`（`tools-search` / `tools-glob` / `tools-web` / `tools-media`），使 boot 末尾的后台预加载真正 `lazyImport` 预热这些运行时模块，不再停留在"仅元信息"。

### 4) 命令历史无法上下切换（TUI）

- `tui.tsx` 模块 C：移除输入框为空的限制，允许输入内容时用 ↑ 回看 / ↓ 前进历史命令；输入任意字符即取消回看（`onInput` 重置 `histIdx`）。

### 测试与提交

- 根 `bun run typecheck` 全部通过；`@harness/cli`（88 例）、`@harness/tools-manager`（9 例）、`@harness/computer-use`（12 例）测试全绿。

## 2026-09-02（续 49）修复：后台预加载仍未生效 + 命令历史仍只回看一条

> 承接续 48。用户复测反馈两个问题仍未解决：1) `/tools` 一直显示「仅元信息」，手动发一条消息后才变「已加载」，且 `list_dir` 等场景化插件工具始终「仅元信息」；2) 命令历史 ↑ 仍只能取到最近一条。

### 1) 后台预加载仍未生效：工具只在首条消息后才注册（core + cli）

- 根因：续 48 的 `scheduleBuiltinPreload` 只 `lazyImport` **预热模块**（缓存 import），但**没有把预加载出的插件安装进 Harness，也没有触发工具注册**；而 `tool.pool.assemble` Hook 只在用户首条消息（query 内）才执行，故 `/tools` 一直停在「仅元信息」，`list_dir` 等场景插件也始终未注册。
- 修复（core）：`Harness` 新增 `assembleTools()`——遍历所有 Agent 触发 `tool.pool.assemble`，把插件工具注册进全局 `ToolRegistry`（幂等，`DefaultToolPool.add` 只注册尚未注册的工具）。
- 修复（cli）：`scheduleBuiltinPreload` 预加载完成后：① 把未安装的插件经 `harness.plugin.loadInternal()` 安装；② 调用 `harness.assembleTools()` 主动组装工具池。这样 boot 后无需首条消息，`/tools` 即显示「已加载」，`list_dir`/`grep_file`/`glob`/`web_fetch` 等开箱即用。
- 场景化插件依赖补齐：cli `package.json` 增加 `@harness/tools-search|glob|web|media`，根 `tsconfig.json` 增加对应 `paths`（此前 `lazyImport` 报 `Cannot find module`）。

### 2) 命令历史仍只回看一条：`__HISTLOG` 未定义导致每次 render 抛 ReferenceError（tui）

- 根因：`tui.tsx` 残留调试用的 `__HISTLOG.push(...)`，但 `__HISTLOG` 从未定义，导致 `TuiApp` **每次 render 都抛 `ReferenceError: __HISTLOG is not defined`**，历史导航与整个 TUI 渲染实质失效（测试也因 `waitFrame` 捕获到该异常超时）。
- 修复：移除三处 `__HISTLOG` 调试残留（submit / render 主体 / onInput）。
- 同时保留续 48 的导航机制并补齐细节：`histIdxRef` 同步真源（连按/自动重复 ↑ 逐级回看）+ `programmaticValueRef` 区分程序式 value 变更与用户输入（避免 OpenTUI `InputRenderable` 的 value setter 触发 `onInput` 立即重置回看索引）；↓ 到底部退出回看恢复当前输入。

### 测试与提交

- 新增 REPL 级集成测试：boot 后等待预加载完成直接 `/tools`，断言 `read_file` 与 `list_dir` 均显示「已加载」且非「仅元信息」；新增 TUI 历史导航集成测试（连按 ↑ 逐级回看 → ↓ 前进 → 底部 ↓ 退出回看）。
- 根 `bun run typecheck` 全部通过；`@harness/cli`（cli.test + tui.test 共 158 例）、`@harness/core`（31）、`tools-manager`（9）、`tools-search`（15）、`tools-builtin`（60）测试全绿。

## 2026-09-02（续 50）重构：工具元信息经抽象接口解耦（ToolMetaSource / ToolMetaRegistry）

> 承接续 49。用户提出：core/cli 里直接 `import { builtinToolMetas, type BuiltinToolMeta } from '@harness/tools-builtin/meta'`、`import { SEARCH_TOOL_META as searchToolMetas } ...` 等 6 处硬编码元信息导入，可用抽象接口解耦。

### 抽象契约（@harness/plugin）

- 新增 `ToolMetaSource`：插件包以统一契约暴露内置工具静态元信息（`{ id, description?, list(): ToolMetaEntry[] }`），自描述、不暴露具体数组结构。
- 新增 `ToolMetaRegistry` + `createToolMetaRegistry()`：CLI 经此抽象登记（`registerSource`）/查询（`get` 含别名反查 / `list` / `size`）。
- `BuiltinToolMeta` 已结构兼容 `ToolMetaEntry`（`ToolMetaEntry.description` 可选），无需改元数据字段。

### 各插件 meta 模块（L1，纯数据）

- `tools-builtin` / `tools-search` / `tools-glob` / `tools-web` / `tools-media` / `computer-use` 各自新增导出 `toolMetaSource: ToolMetaSource`（`list()` 复用既有 `*_TOOL_META`/`builtinToolMetas`），原有数组导出保留供既有测试与引用使用。

### cli（消费端）

- 移除对具体数组/类型的硬编码导入（`builtinToolMetas`、`SEARCH_TOOL_META` 等、`type BuiltinToolMeta`），改为仅消费 `toolMetaSource` 抽象契约。
- `BuiltinToolRegistry` 实现 `ToolMetaRegistry`（内部存储统一为 `ToolMetaEntry`），新增 `registerSource()`；`getBuiltinToolRegistry()` 改为逐个 `registerSource(...)` 登记 6 个来源，不再手工展开数组。

### 测试

- `@harness/plugin` 新增 4 例：`createToolMetaRegistry` 合并来源 / id+别名反查 / 多来源覆盖 / 纯静态来源实现契约。
- 6 个插件包各新增 1 例：`toolMetaSource.id` 与 `list() === 既有元信息`。
- cli `BuiltinToolRegistry` 测试补充 `registerSource` 合并断言。
- 根 `bun run typecheck` 全部通过；`@harness/plugin`（42）、`@harness/cli`（158）、`tools-builtin`（61）、`tools-search`（16）、`tools-glob`（12）、`tools-web`（16）、`tools-media`（11）、`computer-use`（13）测试全绿（存量 reference/ 第三方测试失败与本批无关）。

## 2026-08-31（续 43）开发计划：workspace 与 codeintel 插件化

> 状态：规划（待实现）。用户要求：workspace 与 codeintel 都规划成插件实现（对齐"全功能插件化"约束）。

### workspace 插件化（`@harness/workspace`）

- 「核心库 + 薄 AgentPlugin 壳」双形态：核心库只做定位/解析/存储；`createWorkspacePlugin(opts)` 薄壳复用 `harness.init`/`cli.commands` 提供 `/workspace` 命令与生命周期。
- 从 cli 抽离：路径解析、ConfigStore/SessionFileStore/SecretCipher、权限持久化路径、`MultiDirLoader`（多级扫描+来源+覆盖收敛）。
- 基础设施插件特殊性：cli 需在 harness 创建前预创建服务（路径先行），再以 internal/builtin 装载薄壳。
- 详见 [workspace-management.md](docs/workspace-management.md) §7。

### codeintel 插件化（`@harness/code-intel`）

- 独立插件包 `packages/plugins/code-intel`，引入 AST（推荐 web-tree-sitter）——该层唯一引入 AST 处。
- 注入只读工具：`code_symbols` / `code_reference` / `code_definition`（+v2 可选 `code_semantic_edit`）。
- 详见 [codeintel-plugin.md](docs/codeintel-plugin.md)。

### 相关文档

- [docs/workspace-management.md](docs/workspace-management.md)、[docs/codeintel-plugin.md](docs/codeintel-plugin.md)

## 2026-08-31（续 42）开发计划：/tools 工具管理命令

> 状态：计划（待实现）。用户已确认范围：查看 + 启停 + 其他；启停作用域双轨（当前 Agent 白名单持久化 + 全局工具池运行时）；仅 REPL、暂不 TUI 面板。

### 目标

提供 REPL 工具管理命令 `/tools`，查看可用工具、查看详情、按 Agent 白名单或全局启停、并提供结构化/权限联动等扩展。

### 命令语法

```
/tools                          # 列出当前 Agent 可用工具（filterByWhitelist(agent.tools)）
/tools --all                    # 列出全局注册的全部工具（harness.tools.list()）
/tools --json                   # 与上一视图同，JSON 结构化输出
/tools <toolId>                 # 详情：描述/文档/别名/权限key/安全声明/来源/启用态
/tools <toolId> on              # 作用域A：加入当前 agent.tools 并持久化（已在则幂等）
/tools <toolId> off             # 作用域A：从当前 agent.tools 移除并持久化
/tools <toolId> --global on|off # 作用域B：全局工具池运行时 register/unregister（本次进程生效）
/tools --permission <key>       # 联动查看某权限 key 的规则（读 permissions.json）
```

### 查看字段与局限

* 列表列：`id`、描述（截断）、来源（内置/插件，见下）、权限 key、安全声明（isReadOnly / isDestructive / isConcurrencySafe）、启用态（agent 白名单禁用 / 全局禁用 / 正常）。

* 详情额外：`documentation`、`aliases`。

* **局限**：内置工具 inputSchema 为 `makeSchema` 轻量透传（非 zod），无法内省字段结构，schema 字段暂不展示。

### 作用域 A — Agent 白名单持久化（on/off 默认路径）

* 复用 `setModel` 模式：读 `harness.agent.get(agentId)` → 改 `def.tools` → 持久化到 config 中对应 agent 定义的 `tools`（同在 configStore 装配 agents）。

* `off`：`def.tools` 非 `'*'` 时 `filter(t => t !== id)`；为 `'*'` 时转为显式 `['*', ...]` 后再剔除，或提示先转显式白名单。

* `on`：`def.tools` 为 `'*'` 或已含 id 则幂等；否则加入 `def.tools` 并持久化。

### 作用域 B — 全局工具池运行时（--global on|off）

* HarnessApp 新增 `setToolGlobalEnabled(id, on)`：`off` → `harness.tools.unregister(id)` 并缓存原 Tool 至内存 Map；`on` → `register(缓存对象)`。

* 仅本次进程生效、不持久化；与作用域 A 正交独立。

### 来源标注

* 第一版：从注册登记表/插件清单匹配工具 id 推断「内置 / 插件」，或扩展 `tool.pool.assemble` 记录来源；下限不强制精确，先标 registry 维度。

### 实施步骤

1. `packages/cli/src/index.ts`：`HarnessApp` 增 `toolInfos(opts)`、`setAgentToolsTool(id, on)`、`setToolGlobalEnabled(id, on)` 三个方法 + 工具来源推断 helper。
2. REPL dispatch 增 `case '/tools'`，解析子命令（list / <id> / on / off / --global / --all / --json / --permission）。
3. 持久化：定位 config 中 agents 的 `tools` 读写（对齐 `/model` 持久化机制），实现 Agent 白名单落盘。
4. 测试（`cli.test.tsx`）：`/tools` 列出内置工具 / 详情 / `<id> off` 持久化到 agent def 与 config / `--global off` 从 registry 移除且可 `on` 恢复 / `--all` 清单 / `--json`。
5. 文档：记录本计划到 development-log；实现完成后在 AGENTS.md 补 `/tools` 约定。
6. 全量 typecheck + test（跑测试补 `PATH=/bin:/usr/bin`）。

### 安全注意

* 全局 off 影响所有 agent，需明确提示。

* 不禁止标注：是否允许禁用 read\_file/write\_file/bash/edit\_file 等核心工具由用户决定，不在命令层强制。

### 可插件化结论（调研 2026-08-31）

`/tools` **可以做成可插拔插件**，且是更优形态（对齐"全功能插件化"，可经 `/plugins` 启停）：

- **既定模式**：`mcp-client /mcp`、`subagent /tasks`、`mcp-server-registry` 已用 `cli.commands`（注册命令）+ `cli.command`（处理命令）实现，`/tools` 照此即可。
- **harness 可达**：插件经 `harness.init` hook 捕获 `output.harness`，即可访问 `harness.tools`（register/unregister）与 `harness.agent`——查看 + `--global` 运行时启停全在插件内完成，不再需要 HarnessApp 私有方法。
- **唯一张力 —— Agent 白名单持久化**：插件不持有 cli 的 `ConfigStore`（provider/model/permissions 专用），`on/off` 写回 config.json 需二选一：
  1. **插件自持**：用 workspace 解析的 `dataDir` 直接读写 config.json 的 agent.tools（推荐，自包含，与 workspace 插件协作）；
  2. 保留该子命令在 cli 内置，插件只做查看 + `--global`。
- 落点调整：`toolInfos / setToolGlobalEnabled` 等 helper 移进 `/tools` 插件；HarnessApp 不再新增方法；REPL 内置不再加 `case '/tools'`。

### 相关文档

* [docs/agent-harness-architecture.md](docs/agent-harness-architecture.md)

## 2026-08-31（续 41）：bash 宿主回退前权限确认（requireHostApproval）

(user-request) 宿主 bash 回退会把"沙箱约束已批准"的命令提升到更特权环境执行，需在 ask 模式提示确认。

### 实现（tools-builtin）

* `BashSandboxConfig` 新增 `requireHostApproval?: boolean`（默认 true）。

* 新增 `confirmHostRun(input, ctx, config)`：宿主回退前调用 `ctx.requestPermission`，复用 bash 权限 key，pattern 前缀 `host:` 标识宿主回退执行；`decision.behavior === 'deny'` 拦截（返回 `SANDBOX_HOST_DENIED`），否则放行。无 `requestPermission`（纯工具调用）或 `requireHostApproval=false` 时静默放行。

* 白名单拦截回退、沙箱非零退出回退两个分支均接入确认；危险命令检测仍前置硬性拒绝、不进入确认环节。

### 行为

* ask 模式：宿主回退再次询问用户；allow：静默放行；deny：拦截宿主回退。

### 测试与验证

* 新增 3 条用例：requestPermission deny 拦截返回 SANDBOX\_HOST\_DENIED / allow 放行并标 viaHost / requireHostApproval=false 即使 deny 也宿主回退。

* tools-builtin 49 用例 + typecheck 通过。

### 相关文档

* [AGENTS.md](AGENTS.md)、[docs/agent-harness-architecture.md](docs/agent-harness-architecture.md) §十三

## 2026-08-31（续 40）：补全架构文档 + 工作区管理调研 + bash 沙箱宿主回退

(user-request) 三项：①将最近提交中未记录的功能补进架构文档、提取规则到 AGENTS.md；②调研工作区管理模块并输出开发文档；③沙箱非破坏性命令失败后尝试提升宿主 bash 执行。

### 架构文档补全（agent-harness-architecture.md）

* 新增 §十二「命令审批交互链路」：check→ask 两步判定、safeExecuteTool 兜底、CliPermissionEngine、TUI 审批模态。

* 新增 §十三「bash 沙箱安全防护与宿主回退」；新增 §十四「TUI 增强落地补全」（续 33\~38 + 续 35：复制/选区/欢迎页/用量统计/命令回显）。

* 新增 §十五「工作区 / 数据目录管理」（索引独立文档）。

* 在 §十一 末尾补实现状态（模块 A\~E 已落地）。

### 提取规则到 AGENTS.md

* 补充「check→ask 权限判定」「safeExecuteTool 兜底」「ToolPermissionDeniedError 用错误名判定」「permissions.json / /permission」「bash 沙箱 createBashTool 多层防护 + fallbackToHost 宿主回退 + viaHost」「bash ok 语义」「workspace 两级目录与 dataDir 约定」等规则。

### 工作区管理模块调研（workspace-management.md）

* 整理 dataDir（\~/.harness）与 project（<cwd>/.harness）两级布局、各数据存储（sessions/config/permissions/.config-key/snapshot）、plugins/skills/agents 两级加载与覆盖规则。

* 明确可抽成 `@harness/workspace` 的边界（只负责定位与解析，不含装配逻辑）。

### bash 沙箱宿主回退（tools-builtin）

* `createBashTool(config)` 新增 `fallbackToHost`：沙箱内非破坏性命令被白名单拦截 / spawn 失败 / 命令非零退出（如敏感 env 被隔离）时，提升到宿主 bash（放开白名单与 env 隔离、含系统 PATH）重跑，并在 `BashOutput.viaHost` 标注。

* 危险命令检测前置硬性拒绝，宿主回退也不可豁免（安全红线）。

* 修正 refactor 引入的 `ok` 语义：保持「执行成功即 ok:true，命令结果由 exitCode 反映」，回退触发改用 `exitCode !== 0` 判定，避免破坏既有用例（超时 kill、命令非零退出）。

### 测试与验证

* tools-builtin 新增回退用例：白名单外命令宿主回退 / 危险命令不可回退 / env 隔离致非零退出后宿主回退成功并标 viaHost。

* tools-builtin 46 用例通过 + typecheck 通过（跑测试需补 `PATH=/bin:/usr/bin`，本机 shell PATH 被精简）。

### 相关文档

* [docs/agent-harness-architecture.md](docs/agent-harness-architecture.md)

* [docs/workspace-management.md](docs/workspace-management.md)

* [AGENTS.md](AGENTS.md)

## 2026-08-31（续 39）：命令审批交互 + bash 沙箱安全防护

(user-request: 完善沙箱功能及命令审批) 本轮补齐「命令审批」的完整交互链路与「bash 沙箱」的多层安全防护。

### 权限链路：check → ask 两步判定 + 工具异常兜底

* `core` 新增 `resolvePermission`：先 `engine.check(req)`，命中非 ask 直接返回；需询问时调 `engine.ask(req)` 交上层交互。

* 三处工具执行入口（agent loop 内联工具调用 + 后置 parsed 工具调用 + `HarnessImpl` 的 `ToolPipeline.checkPermission`）统一改走 `resolvePermission`，权限请求不再止步于 `check`。

* `core` 新增 `safeExecuteTool`：把权限拒绝 / 未知异常归一化为失败的 `ToolResult`（`PERMISSION_DENIED` / `TOOL_ERROR`），作为 tool error 反馈 LLM 而非中断 agent 流；用错误名判定 `ToolPermissionDeniedError`，避免依赖类绑定。

### CLI 权限引擎

* `CliPermissionEngine` 支持 `allow-all / ask / deny-all` 三模式；`ask` 时交互支持 `allow / deny / always(a) / deny-always(d)`，永久选择写回规则并落盘 `permissions.json`。

* 新增 `setAskPrompt` 允许上层替换默认 readline 行内提问（给 TUI 注入模态审批用）；新增 `/permission` 命令查看/切换模式、设置规则、reset。

### TUI 审批模态

* `TuiApp` 注入 TUI 版 `askPrompt`：权限引擎 `ask()` 触发时把问题投递为审批弹窗并挂起 Promise。

* 全局快捷键在审批挂起期间吞掉所有按键，仅响应 `y`（允许）/ `n`/`Esc`（拒绝）/ `Shift-y`（始终允许）/ `Shift-n`（始终拒绝）。

### bash 沙箱（tools-builtin，`createBashTool(config)` 工厂）

* **危险命令检测**：默认正则表拦截 `rm -rf /`、fork bomb、`mkfs.*`、裸盘 `dd`/重定向、`shutdown/reboot`、`curl|bash`、`sudo rm -rf` 等；支持 `additionalDangerous` 追加并可用 `dangerousDetection:false` 关闭。

* **cwd 限制**：cwd 必须位于 `rootDir`（默认 `ctx.cwd`）内，防路径逃逸，命中返回 `SANDBOX_CWD`。

* **env 隔离**：从继承环境过滤敏感变量（AWS/GitHub/OpenAI/API\_KEY/PASSWORD/PRIVATE\_KEY 等），可 `keepEnv` 保留必要变量、`sanitizeEnv:false` 关闭。

* **命令白名单**：配置 `allowlist` 后仅首命令名或完整片段命中的命令可执行，其余返回 `SANDBOX_ALLOWLIST`。

* 导出 `createBashTool` 工厂后，原 `bashTool` 改为默认实例，插件可通过 `createToolsBuiltinPlugin({ bash: config })` 注入受限配置。

### 测试与踩坑

* tools-builtin 新增「bash 沙箱防护」套件：危险命令检测 / cwd 限制 / 白名单 / env 隔离（含 keepEnv）/ 插件级 bash 配置注入 / 端到端。

* cli 新增「/permission」命令用例与 TUI 审批模态用例（ask 弹窗 → `y` 允许后工具执行、`n` 拒绝后工具被拒）。

* TUI 审批模态用例一度超时：mock 工具型回复 `response:''`，工具执行后**没有**后续 assistant 正文，而断言误等「你好」；改为断言工具结果的 `stdout`（允许）与 `权限被拒绝`（拒绝）后稳定通过。

* 某终端 `PATH` 被精简（缺 `/bin`），`spawn('bash')` 报 `Executable not found in $PATH`，纯环境问题，非代码缺陷；跑片段用完整 PATH 验证。

### 相关文档

* [docs/agent-harness-architecture.md](docs/agent-harness-architecture.md)

## 2026-08-30（续 38）：TUI 命令输入回显 — 命令进入对话历史并触发欢迎页切换

用户反馈：TUI 对话历史里看不到 `/` 命令发送记录；新会话执行命令时欢迎页不消失，只有发普通消息才切换。

### 根因

`createProcessLine` 命令分支只输出命令结果，不回显命令输入。TUI 捕获按键生成输入（不经过终端原生回显），因此命令从未作为 user 块进入聊天区。而欢迎页切换条件 `hasChat = blocks.some(kind !== 'system')` —— 命令结果多为 system/文本块，无法触发切换。

### 修复

* `createProcessLine` 命令分支开头，在 TUI 模式（`options.onEvent` 存在，REPL 靠终端原生显示不重复回显）回显 `🧑  ${line}` 为 user 块：

  * 命令输入随之出现在对话历史；

  * 产生非 system 块 → 欢迎页在执行首个命令时即切换（与发消息一致）。

### 验证

* cli+tui 新增「命令输入回显为 user 块，并触发欢迎页切换」集成测试；全量 **144 用例通过**，typecheck 通过。

## 2026-08-30（续 37）：修复 `/resume` 恢复会话后发送报 `Session not found`

TUI/REPL 中用 `/resume` 恢复持久化会话后，发送消息报 `Session "<id>" not found`（会话恢复成功但无法继续对话）。

### 根因

`SessionManager` 用 `Map<id, Session>` 索引会话，键是 `create()` 生成的临时 id。CLI 恢复会话时先 `create` + `addMessage` 回填，再 `(session as any).id = savedId` 裸改对象 id —— **只改了对象属性、未同步 Map 键**。因此按 `savedId` 调用 `promptStream`/`prompt` 时 `get(savedId)` 返回 undefined 抛出 `Session not found`。`boot()` 的 `--session` 恢复路径存在同样的隐患。

### 修复

* `@harness/session` `SessionManager` 新增 `setId(oldId, newId)`：校验存在后同步删除旧键、改写 `session.id`、设新键，返回重命名后的会话。

* `@harness/core` `DefaultSessionManager.setId` 实现；`packages/revert` 的 `FakeSessionManager` 补齐该接口。

* `packages/cli` `boot()` 与 `/resume` 命令用 `await session.setId(tmpId, savedId)` 替代裸改 `(session as any).id = savedId`。

### 验证

* core 新增 `setId` 单测（重命名后新 id 命中/旧 id 失效 + 不存在抛错）；cli 新增 `/resume 恢复后发送` 集成回归测试。

* cli **143 用例**、core 31、revert 10 全通过，全 repo typecheck 通过。

## 2026-08-30（续 36）：统计命令健壮性修复 — `/stats-export` 无参数崩溃 + 报错信息可复制

续 35 交付后，用户反馈：`/stats-export` 命令报错，且 TUI 中报错堆栈渲染到了聊天框、报错信息无法复制。

### 修复 1：`/stats-export` 无参数 TypeError

* 根因：`const [cmd, arg] = line.split(/\s+/, 2)` 在无参数时 `arg === undefined`，命令分支内 `arg.trim()` 抛 TypeError。

* 修复：`(arg ?? '').trim().split(/\s+/)`，与 `default` 分支（插件命令兜底）的既有写法保持一致。

### 修复 2：命令异常友好处理，抑制裸堆栈上屏

* `if (line.startsWith('/'))` 命令分支整体包 `try/catch`，命令抛异常时输出 `❌  /<cmd> 执行失败：<message>` 并返回 `'continue'`，避免异常向上传播到 TUI 渲染层打印凌乱堆栈、破坏输入队列。

### 修复 3：报错信息可复制

* TUI `renderBlock` 的「复制」按钮由仅 user/assistant 块扩展到 **tool 块**（`🔧`/`✅`/`❌` 前缀归类），因此命令错误（以 `❌` 开头，归为 tool 块）也能一键复制到剪贴板。

### 验证

* cli+tui 全量 **142 用例通过**（新增 `/stats 与 /stats-export（无参数）正常工作且不崩溃`），typecheck 通过。

## 2026-08-30（续 35）：用量统计增强 — 会话级持久化 + 多维度时序 + 报告导出 + 侧栏图标 tab

在既有「侧栏统计面板」（本地估算 + 消息数/token/任务/用时）基础上，将统计从「本地估算」升级为「本地 + API 实际用量 + 多维归并」，并新增会话级持久化与报告导出，同时把侧栏各模块改为顶部图标 tab 切换。

### M1：扩展 TokenUsage 缓存明细并贯通链路

* `@harness/core` `TokenUsage` 新增 `cacheRead`（命中缓存输入 token）、`cacheWrite`（写入缓存输入 token），`query` / `queryStream` 的 done 事件透出；未命中缓存 = `input - cacheRead - cacheWrite`。

* provider 映射各自的缓存字段：anthropic（`usage.cache_read_input_tokens` / `cache_creation_input_tokens`）、openai/gemini/qwen（`prompt_tokens_details.cached_tokens` 等）、mock 支持模拟缓存。

### M2：UsageStats 累积器（`packages/cli/src/usage-stats.ts`）

* 统计粒度：**单轮 llm 对话**（每条 done = 一次 `llmCalls`）→ **一次 agent 任务**（agents 维度 `calls`/`tasksDone`）→ **会话级别**（整体聚合）→ **工具维度 token 用量**（本轮用量归并到紧随的工具调用）。

* 维度：`models[]` / `agents[]` / `tools[]`（含失败数）/ `hourly[]`（小时时序）。

* 纯函数 `emptyUsage` / `recordCall` / `recordTool` / `recordTaskDone` / `uncachedInput` 及格式化 `modelUsageRow` / `toolUsageRow` / `agentUsageRow` / `hourLabel` / `hourlyRow` / `sparkline`，便于单测。

### M3：TUI 接线 + 侧栏渲染

* `TuiApp.onEvent` 累积：`done` → `recordCall`（读 `message.meta.model` / `tokenUsage`）；`tool_call_result` → `recordTool`（含 `isError`，失败只计错误数）；agent 任务完成 → `recordTaskDone`。

* 统计面板展示：LLM 调用、缓存命中/写入/未命中、按模型、按 agent/任务、按工具、按小时迷你条形时序。

### M4：会话级持久化 + `/stats` 与 `/stats-export`

* 用量变化时写入 `session.meta[usageStats]` 并防抖（800ms）落盘，恢复/切换会话后 `/stats` 仍能读到历史。

* `/stats` 输出纯文本报告；`/stats-export [md|json] [path]` 导出 Markdown/JSON（默认打印，给定 path 写文件）。`usageFromMeta` / `usageFromMessages` 供未走 TUI onEvent 的场景反推统计。

### M5：侧栏顶部图标 tab

* 侧栏各模块（会话上下文/会话/任务/文件/统计）改为顶部图标 tab + 左右切换（◀/▶）与 Tab 进入列表的互斥逻辑。

### 设备与验证

* cli+tui 全量 **141 用例通过**、全 repo typecheck 通过。

* 修复两个 TUI 集成测试竞态：初始渲染后被动 effect（`useKeyboard` 订阅）异步 flush，`mountTui` 新增 `settleEffects` 统一 pump 拍数，消除「按下按键时钩子未注册」导致的 `Ctrl-B 切换侧栏面板` 失败。

## 2026-08-28（续 30）：TUI 交互增强（开工 + 模块 A/B 落地）— 方案定案并推进

用户盘点 TUI 缺口后，确认本期覆盖四项：后台任务实时面板、会话列表切换、输入体验（/命令菜单 + 历史）、帮助面板 + 复制辅助。鼠标点击/选区复制与 OpenTUI 多行输入依赖底层 API，列入后续增强。方案细节（能力边界、各模块落点、验证计划）已写入 [architecture §十一](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md#L1024-L1070)。实现按模块 A→B→C→D 推进，每模块补 `tui.test.tsx` / `cli.test.tsx` 用例并 typecheck。

### 模块 A：侧栏后台任务实时面板（完成）

* `tui.tsx` 订阅 `subagentCapability.createMonitor`，任务状态并入 React state 滑入侧栏「后台任务」块；`⏳/✅/❌` + taskId + agentName + 进度步数，进行中置顶限量。

* 纯函数 `applyBackgroundTaskSnapshot` / `bgTaskRow` / `splitBgTasks` 便于单测，`tui.test.tsx` 覆盖。

### 模块 B：TUI 会话列表展示与切换（完成）

* `createProcessLine` 新增 `/resume <sessionId>`：`sessionStore.load` 恢复 → `harness.session.create` 回填 → 换绑 `current` + `setSession`（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）。

* `tui.tsx` 侧栏「会话」块列出持久化会话，`sessionMode`（Tab 进入，文件引用之后）↑/↓ 选中、Enter 触发 `/resume <id>` 切换。

* `setSession` 回调用 `messagesToBlocks` 把新会话历史还原为对话块刷新聊天区。

* 纯函数 `messageText` / `roleToKind` / `messagesToBlocks` / `toSessionRows` / `sessionRowText` + 5 项 `tui.test.tsx` 用例。

* cli+tui 全量 126 用例通过、typecheck 通过。

下一步：模块 C（/命令菜单补全 + 输入历史）、模块 D（帮助面板 + 复制辅助）。

***

## 2026-08-30（续 31）：TUI 交互增强 — 模块 C 输入体验（/命令菜单 + 输入历史）落地

### 模块 C：输入体验增强 — /命令补全菜单 + 输入历史（完成）

* `index.ts` 新增 `listReplCommands(harness)`：收集 TUI `/` 命令补全候选 = 内置 REPL 命令 + 插件经 `cli.commands` hook 注册的命令，异步合并去重。

* `tui.tsx`：

  * 脚本加载后调用 `listReplCommands` 预取候选；输入以 `/` 开头时按前缀过滤渲染命令菜单弹层（输入框上方、带边框、限量 8 条）。

  * 命令菜单键盘：`↑/↓` 选中，`Tab` 补全当前命令（命令以 `/` 结尾自动补齐空格），`Enter` 提交选中命令，`Esc` 收起命令菜单，其余按键被吞掉避免影响输入。

  * 输入历史：输入框为空且无命令菜单时即回看模式，`↑` 回看 / `↓` 前进，历史值回显到输入框，`Enter` 直接用回看值提交；提交成功后去重（保持最近项）并限量 100 条入栈，输入时重置回看索引。

* 模块 A/B/C 与既有能力在 `tui.tsx` 的键盘分发中按优先级互斥：会话列表 > 文件引用 > 命令菜单 > 输入回看，避免按键冲突。

* cli+tui 全量 126 用例通过、`tsc --noEmit` 通过。

> 说明：多行输入（Textarea 渲染件）、鼠标点击/选区复制依赖 OpenTUI 底层渲染触控能力，与模块 D 一并列入后续增强；命令行文本编辑方向键/退格等仍走 OpenTUI `<input>` 内置按键绑定。

下一步：模块 D（帮助面板 + 鼠标/复制辅助，视 OpenTUI 能力）。

## 2026-08-30（续 32）：TUI 交互增强 — 模块 D（帮助面板 + 复制辅助）与侧栏统计面板落地

### 模块 D1：帮助面板 + Ctrl-Y 复制辅助（完成）

* `tui.tsx` 新增 `HELP_LINES` 常量（快捷键 → 说明映射：Ctrl-C 退出 / Ctrl-B 切换面板 / Ctrl-/ 帮助 / Ctrl-Y 复制 / Tab / ↑↓ / Enter / Esc / /help）。

* 帮助面板：`Ctrl-/` 触发 `helpOpen`，在输入框上方渲染带边框的 modal 弹层，任意键关闭（`useKeyboard` 顶部拦截）。实测 OpenTUI 将 `Ctrl+/`（0x1F）解码为 `key.name === '_'`（ctl+\_），故快捷键判断同时匹配 `'/'`、`'_'`、`'?'`，与真实终端上报一致。

* 复制辅助：`Ctrl-Y` 触发 — `latestAssistantText(blocks)` 取最近 assistant 块纯文本，`copyTextToClipboard` 用 `spawn('pbcopy')` 写入系统剪贴板（macOS），失败静默不打断交互。

### 模块 D2：侧栏统计面板（完成）

* 新增纯函数 `computeTuiStats`（按角色块计数 users/assistants/thinking/tools + 字符数 + token 估算 chars/4 + 后台任务进行中/已结束 + 会话已运行毫秒）、`formatDuration`（s / m s / h m 友好时长）。

* 侧栏新增「统计」区：`消息 Nu/a Nt/ T`、`字符 N · ~N tok`、`任务 ⏳N/✅N · 时长`，随对话块与后台任务实时归并。

* 侧栏外层容器由 `<box>` 升级为 `<scrollbox>`，塞入统计块后内容不再溢出塌陷；状态栏精简至 80 列内（移除冗余 session 字段，`·` 分隔）。

* 新增 TuiStats 纯函数测试与集成测试（帮助开关、统计随块更新），修正统计初始断言（欢迎语 system 块计入字符，故初始 chars≠0）。

* cli+tui 全量 132 用例通过、`tsc --noEmit` 通过。

## 2026-08-30（续 33）：TUI 鼠标复制 — 每条消息增加可点击「复制」按钮

### 背景

模块 D1 已有 `Ctrl-Y` 复制最近助理回复，但需逐条复制历史消息时不够顺手。本续将复制能力下沉到单条消息，实现鼠标点击复制，作为 `Ctrl-Y` 的鼠标替代方案。

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

* `startTuiRepl` 创建渲染器时开启 `createCliRenderer({ useMouse: true })`，启用 SGR 鼠标协议（测试渲染器 `createTestRenderer` 亦 `useMouse: true`）。

* `TuiApp` 新增 `copiedId` 状态：标记当前已复制的块 id，用于「✓ 已复制」临时高亮。

* `renderBlock`：对非空 user/assistant 块，在正文下方渲染一行 `<text>` 复制按钮，绑定 `onMouseUp`：

  * 点击即 `preventDefault()` + `setCopiedId(b.id)` + `copyTextToClipboard(b.text)`（复用 D1 的 pbcopy 实现）。

  * 按钮文案 `⧉ 复制` ⇄ `✓ 已复制`（`copiedId === b.id` 反色加粗切换，dim+underline 常态）。

  * 复用 `copyTextToClipboard`：为其补上 `child.on('error')` 处理 —— pbcopy 缺失（非 macOS / PATH 异常）时 ENOENT 以异步 `error` 事件抛出，原 try/catch 只接同步 `spawn` 抛错，二者叠加可完全静默失败、不中断 TUI 交互。

### 测试（[tui.test.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.test.tsx)）

* 新增 `locateChar` 助手：在整宽字符帧（每行按终端宽度空格填充）中用 `indexOf` 定位任意子串的 0-based 单元格坐标，供 `mockMouse.click` 使用。

* 新增集成测试「鼠标点击消息复制按钮 → 变 ✓ 已复制」：发送消息 → 帧中出现 `⧉ 复制` → 定位其坐标 → `mockMouse.click(x, y)` → 断言该按钮翻转为 `✓ 已复制`（证明 `onMouseUp` 触发、状态更新）。

* 首轮测试暴露 pbcopy 在测试环境不可用（PATH 异常导致 `error`），正是上文 `child.on('error')` 修复的验证用例。

### 验证

* cli+tui 全量 **133** 用例通过（含新增鼠标复制集成测试）、`tsc --noEmit` 通过。

## 2026-08-30（续 34）：选区复制 + 欢迎页

### 背景

续 33 实现了每条消息的鼠标点击「复制」按钮，但尚未覆盖"鼠标拖拽选区后复制"这类交互（此前已确认可选择文本会自动建立 OpenTUI 选区，但缺少读取入口）。同时 TUI 启动时只有一行欢迎语，缺少面向新手的欢迎页引导。

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

**选区复制（模块 D4）**

* 经 `@opentui/react` 的 `useAppContext()` 在 `TuiApp` 内取到全局 `renderer`（`createRoot` 已以 `AppContext.Provider` 注入 `{ renderer }`），从而读取 `renderer.getSelection()`。

* 新增纯函数 `selectionTextFrom(renderer)`：结构性读取 `getSelection().getSelectedText()`；无 renderer/无选区/空选取均返回空串，便于单测。

* Ctrl-Y 语义升级：**有选区先复制选区并** **`clearSelection()`，否则回落复制最近 assistant 回复**（`HELP_LINES` 同步更新说明）。

**欢迎页（WelcomePanel）**

* `HARNESS_LETTERS` 5×5 字模 + `buildWelcomeBanner()`：横向拼接 "HARNESS" 生成 5 行字标（每行 ≤60 列，适配 80 列 + 26 列侧栏后的主区宽度）。

* `WelcomePanel` 组件：贯穿渲染"欢迎"头部、字标、provider/model、快捷键列表、上手引导。

* `TuiApp` 新增 `hasChat = blocks.some(b => b.kind !== 'system')`；主区 scrollbox 在会话开始前渲染 `WelcomePanel`，首条消息后切换为对话块列表（复用既有 `initialChatWithWelcome`，此处仅做可视化替换）。

### 测试（[tui.test.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.test.tsx)）

* 单测：`buildWelcomeBanner` 返回 5 行且宽度可控并含字模横笔画；`selectionTextFrom` 各无选区/有选区分支。

* 集成：欢迎页在初始（仅 system 块）展示字标与引导、首条消息后消失并切换为对话块。

### 验证

* cli+tui 全量 **136** 用例通过（新增 3 例）、`tsc --noEmit` 通过。

## 2026-08-28（续 29）：`/model` 补全列出插件注册的 Provider — `listProviders` 合并注册表类型

### 背景

`/model` 命令只列出 `config.providers` 显式定义的实例 id 与默认 provider，未查询 `ProviderTypeRegistry`。用户通过插件（`~/.harness/plugins` / `.harness/plugins` 导出 `providerTypeFactory`）注册的自定义 type，即使 boot 时已由 `loadPluginDirs` 注入注册表，也无法在 `/model` 候选列表中出现，导致无法选中或切换。

### 根因

并非惰性加载所致（boot 时 `loadPluginDirs` 已把自定义 type 注册进 `this.providerTypes`），而是 `listProviders()` 的候选枚举来源没有包括注册表里的已注册类型。

### 改动

1. **`listProviders()`** **合并注册表类型**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：候选顺序为 `config.providers` 实例 id → 默认 provider → `this.providerTypes.list()`（内置 + 插件扩展的自定义 type）。后两者不依赖该 type 是否已在 config 定义实例，因此插件注册的 type 也能在 `/model` 展示与校验。
2. 测试：新增 "listProviders 合并插件注册的自定义 type" 集成用例，boot 一个带 `.harness/plugins` 的自定义 provider 插件，断言 `listProviders()` 同时包含默认 provider、内置注册表类型（anthropic）与插件自定义类型（my-gw）。

### 验证

* `@harness/cli` 78 例全绿（含新增用例）；typecheck 通过。

* 惰性语义不变：仍不主动 import 任何 Provider 模块，仅同步读取注册表类型。

## 2026-08-28（续 28）：惰性 Provider 展示元信息 — help/config check 未加载插件即可列出

### 背景

Provider 已惰性加载（续 26 / 续 27），但 help 只静态硬编码示例、`/model?` 只列运行时已配置 id；依赖 Provider 模块 import 才能展示的类型清单在 help 场景出现缺口。用户要求：help 里列出可支持的 provider 时，即使插件未完全加载，也应能展示，且人机交互友好（附描述/默认模型/用法，调用时再自动加载）。

### 改动

1. **抽象层** **`@harness/plugin`** **增加展示元信息通道**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）

   * 新增 `ProviderTypeMeta`：`type/description/defaultModel/requiresApiKey/builtin/usage`。

   * `ProviderTypeRegistry.register(factory, meta?)` 可附带登记元信息；新增 `meta(type)` 与 `listMeta()`（未登记 meta 的类型也返回仅含 type 的占位，保证清单完整）。

   * 元信息在 register 时同步写入，**不调用 createPlugin、不 import 任何 Provider 模块**。
2. **cli 内置元信息表 + 惰性注册同步登记**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

   * 新增 `BUILTIN_PROVIDER_META`（anthropic/openai/gemini/glm/qwen/mock 的描述、默认模型、是否需 key、用法示例），`registerBuiltinProviderType` 注册惰性工厂的同时登记该元信息。

   * 新增 `formatProviderTypeList(registry, includeUsage)` 与 `buildProviderTypesSection(registry)`：从 listMeta 生成友好清单（`[内置]`/`[插件]` 标注、需 key 提示、默认模型、`/model` 用法），纯元信息驱动、零模块加载。
3. **接线展示**：`main` 的 `help` 分支追加 `buildProviderTypesSection`（同步登记内置元信息即可展示）；`config config check` 在概览后追加含外部插件的完整清单（`buildCheckRegistry` 已加载 plugins）。
4. 测试：`@harness/plugin` 增加 registry meta/listMeta（含占位）用例；cli 增加"同步注册后 listMeta 即可列出、无需加载模块"与 `formatProviderTypeList`/`buildProviderTypesSection` 输出用例。

### 验证

* 全 28 包 typecheck 通过；`@harness/plugin` 38 例、`@harness/cli` 116 例全绿。

* 惰性语义不变：`resolve(type).createPlugin` 仍按需 dynamic import；列表展示仅读元信息，不触发 Provider 模块加载。

## 2026-08-28（续 27）：抽象层扩至运行时能力（subagent / swarm），消除 cli 对业务插件的依赖倒置残留

### 背景

续 26 已把 Provider 依赖倒置消除。cli 仍残留对两个业务插件的直连：`attachBackgroundTaskPanel` 直接 `import { BackgroundTaskMonitor }` 自 `@harness/subagent`，`runTeammateCli` 直接 `import { createSwarmManagers/startTeammateLoop/TeammateTaskState/… }` 自 `@harness/swarm`。经与用户确认：「组合根直连内置插件」作为干净架构常态基线被接受，但该处残留按「完整抽象：swarm+subagent」推进。因此抽象层持续下垫：cli 业务逻辑只经抽象接口交互，具体能力对象由插件包导出并在组合根装配。

### 改动

1. **抽象契约落位** **`@harness/plugin`**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）新增「运行时能力服务契约」，全部取最小结构契约，抽象层不反向依赖具体插件：

   * `BackgroundProgressLike` / `BackgroundTaskViewLike` / `BackgroundTaskListenerLike` / `BackgroundTaskMonitorLike`：后台任务监控的最小结构视图（与 subagent `BackgroundTaskProgress/View/Listener/Monitor` 结构兼容）。

   * `SubagentCapability`（`createMonitor({ bus, parentSessionIds? })`）。

   * `SwarmLoopDeps` / `SwarmLoopHandle`（`isDone/stop`）/ `SwarmCapability`（`sanitizeName/formatAgentId/startTeammateLoop`）。
2. **subagent 插件实现抽象并导出能力**（[subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）：新增 `subagentCapability: SubagentCapability`，内部 `new BackgroundTaskMonitor(options)`。
3. **swarm 插件实现抽象并导出能力**（[swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：新增 `swarmCapability: SwarmCapability`，`startTeammateLoop(deps)` 内部完成 `createSwarmManagers`、teammate 状态构建与循环封装，并把底层 `TeammateLoopHandle` 适配为抽象 `SwarmLoopHandle`（`isDone = !running`）。
4. **cli 只消费抽象层**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：

   * 删除对 `BackgroundTaskMonitor`/`BackgroundTaskView`/`createSwarmManagers`/`startTeammateLoop`/`TeammateTaskState`/`TeammateTickDeps` 等具体实现类型的直接引用；cli 业务函数不再 import 这些类型。

   * `attachBackgroundTaskPanel` 改经 `subagentCapability.createMonitor(...)`，打印状态映射改用抽象 `BackgroundTaskViewLike['status']`。

   * `runTeammateCli` 改经 `swarmCapability.sanitizeName/formatAgentId/startTeammateLoop`，等待收尾改用 `loop.isDone()` 而非读取具体 `state.status`。

   * 组合根仅导入具体插件导出的能力对象（`subagentCapability` / `swarmCapability`），属「组合根直连内置插件」基线内。
5. 附带修复 `@harness/plugin` 的 `plugin.test.ts` 两处既有类型错误：`resolveProviderTypeFactory` 用例的 `createPlugin` 返回体补齐 AgentPlugin 最小桩，因抽象契约已把返回类型收紧为 `AgentPlugin | undefined`。

### 验证

* 全量 28 包 typecheck 通过

* `@harness/plugin` 37 例、`@harness/subagent` 93 例（新增 capability 1 例）、`@harness/swarm` 65 例（新增 capability 2 例）、`@harness/cli` 114 例均全绿

* 注：根目录 `bun test` 扫描未装依赖的 `reference/` 私有目录产生的既有失败与本改动无关

## 2026-08-28（续 26）：Provider 抽象层，消除 core/cli 对具体 Provider 的依赖倒置

### 背景

续 20 已用 `ProviderTypeRegistry` 替代硬编码 `type` 枚举，但抽象契约仍定义在 cli 内部（cli 自建 `ProviderTypeFactory`/`ProviderTypeRegistry`、`registerBuiltinProviderTypes` 逐个 `import()` 具体 `provider-*` 包并做各自的配置映射）。这仍是**高层（core/cli）直接依赖低层具体 Provider 实现**，违背依赖倒置。要求：建立一层抽象层，core 和 cli 只使用抽象层接口，插件（Provider 包）实现抽象层，core 只经抽象层交互。

### 改动

1. **抽象层落位** **`@harness/plugin`**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）：

   * 新增 `ProviderConfig`（含 `[key: string]: unknown` 透传）契约；

   * 新增 `ProviderTypeFactory`（`type` + 可异步的 `createPlugin`）契约；

   * 新增 `ProviderTypeRegistry`（`register/resolve/list/clear`）注册表；

   * 新增 `resolveProviderTypeFactory(mod)`：统一从插件模块导出识别三种工厂形态（`providerTypeFactory` / `providerType`+`createProviderPlugin` / `default` 包装）。
2. **6 个 Provider 包实现抽象层**（`provider-*`）：

   * 各包新增导出 `providerTypeFactory`，`createPlugin(config: ProviderConfig)` 在**包内部**完成「`ProviderConfig` → 该 Provider 配置结构」的映射（`model`→`defaultModel`、`id`→`providerId` 等），把原本散落在 cli 的逐类型映射下沉到实现方。
3. **cli 只消费抽象层**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：

   * 删除 cli 本地重复的 `ProviderTypeFactory` 接口、`ProviderTypeRegistry` 类、`ProviderConfig` 接口，改用 `@harness/plugin` 导入；

   * 删除对 `@harness/provider-openai/gemini/glm/qwen` 的具体配置类型导入；

   * `registerBuiltinProviderTypes` 重写为**通用惰性登记**：只登记「`type` → 模块 specifier」，`createPlugin` 时 `lazyImport()` + `resolveProviderTypeFactory()` 解析出实现方工厂并委托，**不再含任何具体 Provider 配置结构/工厂的硬编码映射**，仍保持惰性加载不影响启动速度。

   * `registerBuiltinProviderTypes` 签名收敛为单参数 `(registry)`，两处调用点与 cli 测试同步更新。

### 验证

* 全量 26 包 typecheck 通过

* `@harness/plugin` 37 例全绿（新增：`ProviderTypeRegistry`、`resolveProviderTypeFactory` 三种形态 + 无契约回退 5 例）

* `@harness/cli` 114 例全绿（新增：内置 6 个 `provider-*` 包装 `providerTypeFactory` 契约逐包校验 1 例）

* 6 个 `provider-*` 包各自用例全绿

* 注：根目录 `bun test` 会扫描未装依赖的 `reference/` 私有目录产生大量既有失败（含 `tools-builtin`/`Ctrl-B` 环境性 flaky），与本次改动无关；本改动未触碰这些文件

## 2026-08-28（续 25）：内置插件统一注册 + 惰性加载

### 背景

内置 Provider 模块（anthropic/openai/gemini/glm/qwen/mock）与 `tools-builtin` 此前在 cli 顶部**静态 import**，进程一启动就全部求值，既不"支持加载"（无法与外部插件统一管理/装卸），也拖慢启动。要求：**随应用打包的内部插件也要支持加载**，且**插件加载支持惰性加载**，尽量不影响启动速度。

### 改动

1. **内置 Provider 类型惰性化**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：

   * `registerBuiltinProviderTypes` 改为登记「`type` → 惰性 `createPlugin`」，`createPlugin` 内部经 `lazyImport()` 在真正按 `config.type` 解析 Provider 时才 `import()` 对应模块；`type` 名仍在启动时登记（供配置校验）。

   * `ProviderTypeFactory.createPlugin` 返回值放宽为 `AgentPlugin | undefined | Promise<AgentPlugin | undefined>`，`buildProviderPlugin` 改为异步；`mock`/`anthropic` 兜底改用 `lazyMockProvider()`/`lazyAnthropicProvider()`。

   * 顶部仅保留 `import type`（配置类型），移除运行时静态 import。
2. **内置通用插件统一注册表**（新增 `BuiltinPluginRegistry` / `getBuiltinRegistry` / `BuiltinGeneralPlugin`）：登记「id + 描述 + source=`builtin` + 惰性 `load()`」，`tools-builtin` 经此惰性加载（boot 时才 import），与外部插件目录 `loadPluginDirs` 并列，满足"内部插件也要支持加载"。
3. **启动速度**：`harness --help` / `--check-config` 不再加载任何 Provider 模块；repl 也只在真正用到对应 type 时加载所需 Provider，未用到的 anthropic/gemini/glm/qwen 不会加载。

### 验证

* cli 113 用例全绿（新增：内置 Provider 惰性解析、BuiltinPluginRegistry 惰性加载 2 例）；全量 26 包 typecheck 通过

* 注：`Ctrl-B 切换侧栏` TUI 用例为既有偶发 flaky（原代码上复现），与本次改动无关

## 2026-08-28（续 24）：消除 CLI 对业务插件的依赖倒置

### 背景

项目约束强调"插件化、所有插件可插拔、不与项目本身耦合"。续 23 中电脑控制实现把 `mcp-server-registry` 与 `computer-use` 硬编码进 CLI，属高层（CLI）直接依赖低层具体插件，违背依赖倒置原则，本次修正。

### 改动

1. **移除 CLI 硬编码依赖**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：

   * 删除 `import { createMcpServerRegistryPlugin } from '@harness/mcp-server-registry'`、`import { createComputerUsePlugin } from '@harness/computer-use'`

   * 删除 `providerPlugins.push(createMcpServerRegistryPlugin()); providerPlugins.push(createComputerUsePlugin())`

   * 移除 cli/package.json 中 `@harness/computer-use`、`@harness/mcp-server-registry` 依赖
2. **改为项目级可插拔插件**（[.harness/plugins/mcp.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/.harness/plugins/mcp.ts)）：经既有 `loadPluginDirs`（user `~/.harness/plugins` → project `.harness/plugins`）加载，`export const plugins = [createMcpServerRegistryPlugin(), createComputerUsePlugin()]`；删除该文件即可停用，无需改动 CLI/core
3. **消除误报警告**（cli/src/index.ts `registerProviderTypeFactory`）：已导出通用 AgentPlugin 的模块直接返回，不再打印"未导出 Provider 工厂，已忽略"的误导日志

### 验证

* `loadPluginDirs` 实际加载 `.harness/plugins/mcp.ts` → 得到 `mcp.server-registry`、`computer-use` 两个插件，无警告

* cli 111 用例全绿；全量 26 包 typecheck 通过

## 2026-08-28（续 23）：电脑控制 MCP server 插件 + MCP Server Registry

### 背景

用户希望基于 `reference/电脑控制mcp 功能.md` 实现一个「电脑控制」MCP server 插件：插件加载时自动启动并注册到 MCP，连接统一由 mcp-client 管理。为避免与 core 集成，注册机制采用独立的 `mcp-server-registry` 插件：所有 mcp server 相关插件都依赖它去启动，提高复用度。后端选「真实 macOS 自动化」（osascript）。

### 实现

**1.** **`@harness/mcp-server-registry`（[mcp-server-registry/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/mcp-server-registry/src/index.ts)）**

* `McpServerRegistry`：`register / unregister / has / list / clear`，支持两条注册路径：

  * `config`：外部 server（stdio/http/sse），用 `@harness/mcp-client` 的 `defaultTransportFactory` 拉起

  * `createTransport`：进程内 / 自定义启动器，返回 `@harness/mcp-client` 的 `McpTransport`

* `registerMcpServer() / unregisterMcpServer() / listRegisteredMcpServers()`：模块级默认注册表

* `createMcpServerRegistryPlugin()`：在 `harness.start` 连接所有已注册 server（`McpClient` + `connect`）、`tool.pool.assemble` 暴露 `convertMcpToolToHarnessTool` 转出的工具、提供 `/mcp [servers | tools]` 命令、unload 时断开

**2.** **`@harness/computer-use`（[computer-use/src/mac.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/mac.ts)** **+** **[server.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/server.ts)** **+** **[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/index.ts)）**

* `ComputerUseBackend`：通过 `/usr/bin/osascript`（System Events）+ `/usr/sbin/screencapture` 实现 11 种电脑操作（check\_permissions / list\_apps / get\_app\_state / click / scroll / drag / type\_text / press\_key / perform\_action / set\_value / select\_text），执行器可注入（测试 mock）

* `ComputerUseMcpServer`：进程内 MCP JSON-RPC server（initialize / tools/list / tools/call），把后端方法映射为 MCP 工具，工具 schema 对齐参考文档

* `createComputerUseServerTransport()`：把进程内 server 包装为 `McpTransport`，供 registry 连接

* `createComputerUsePlugin()`：`dependsOn ['mcp.server-registry']`，`install` 时 `registerMcpServer` 注册进程内 server，`harness.init` 时经 `output.harness.skillManager.register` 注册一个 `loadedFrom: 'plugin'` 的「Computer Use」操作指南技能

**3. 装配（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）**

* CLI 默认安装 `createMcpServerRegistryPlugin()` + `createComputerUsePlugin()`，实现「注册 → harness.start 自动启动进程内 server 并通过 mcp-client 连接 → 工具进工具池」

### 验证

* mcp-server-registry 4 用例：注册表 CRUD、harness.start 连接 + assemble 暴露工具 + 工具可调用（pass-through）、`/mcp servers|tools`、config 缺失 command 不阻塞其余

* computer-use 9 用例：JSON-RPC initialize / tools/list（11 工具）/ tools/call 分发与报错 / 通知无响应 / 未知方法 / transport 对接 McpClient 连通性 / 插件注册 server + 注册 plugin 来源 Skill

* cli 111 用例全绿（接入新插件后无回归）；全部 26 包 typecheck 通过

## 2026-08-28（续 22）：插件 / 技能管理（enable / disable / reload + 技能来源标注）

### 背景

续 21 统一 `plugins` 目录后可加载各种插件，但缺少对插件与技能的运行时管理能力，也无法从插件注册技能、标注技能的加载来源。本次补齐「插件管理 + 技能管理 + 插件来源技能 + 来源标注」闭环。

### 实现

**1. 技能来源标注（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）**

* `SkillSource` 增加 `'plugin'`（插件注册来源），与 `bundled / user / project / mcp` 并列为五来源

* 新增 `formatSkillSource(source)`：五来源的中文标注（内置 / 用户 / 项目 / MCP / 插件），供 `/skills` 界面展示

**2. SkillManager 管理能力（同文件）**

* 接口与实现新增 `disable(id)`、`enable(id)`、`isDisabled(id)`

  * `disable`：从可用列表移除，缓存到 `disabled`（enable 可恢复），重复禁用幂等返回 `false`

  * `enable`：从禁用缓存恢复；未在缓存中则回落到 `reload`（从来源文件重载，等价新增技能启用）

  * `reload` 保持原启用/禁用状态：禁用技能重载后仍不可见，启用技能重载后仍可见

**3. core 暴露 skillManager（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）**

* `Harness` 接口与实现新增 `readonly skillManager?: SkillManager`；插件可在 `harness.init` hook 中通过 `output.harness.skillManager.register(...)` 注册 `plugin` 来源的技能

**4. CLI 管理命令（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）**

* `HarnessApp` 新增 `pluginRegistry`（boot 时登记「可管理」插件对象：Provider / 插件目录 / extraPlugins，排除 `toolsBuiltin` 与 `core.*`）

* 插件管理 API：`pluginInfos()`、`disablePlugin()`（unload）、`enablePlugin()`（按登记对象重装）、`reloadPlugin()`（hotReload）

* 技能管理 API：`skillInfos()`（含 `sourceLabel` 中文标注）、`disableSkill()`、`enableSkill()`、`reloadSkill()`

* REPL 新增 `/plugins` 与 `/skills` 命令（`enable | disable | reload` + 列表），并加入 `REPL_COMMANDS`（`/help` 可见）

### 验证

* skill 包新增 `formatSkillSource`、disable/enable/reload 状态保持与禁用心得等用例；skill 29 用例全绿

* cli 新增 `/plugins`、`/skills` 命令（列表/禁用/启用/未知来源/help）等用例；cli 72 用例全绿

* core / plugin 61 用例全绿；全部 26 包 typecheck 通过

## 2026-08-27（续 21）：统一 plugins 插件目录（支持各类插件）

### 背景

续 20 的 `provider-plugins` 专用目录只承担「Provider 类型工厂」一种插件约定，无法承载通用 AgentPlugin（Hooks 生命周期插件），且目录命名与「插件」的通用语义不符。用户要求统一为 `plugins` 文件夹，在一个目录里支持加载各种插件类型。

### 实现（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

1. **目录统一**：`~/.harness/provider-plugins` / `.harness/provider-plugins` → `~/.harness/plugins` / `.harness/plugins`（user → project，后加载覆盖）
2. **`loadPluginDirs(registry, dirs, log?)`** 取代 `loadProviderPluginDirs`，返回 `PluginLoadResult { plugins }`；一个模块可同时导出两类插件：

   * **通用 AgentPlugin**（Hooks 插件）：`default` / `plugin` / `plugins` 三种形态（含一层 default 包装）；按插件 `id` 去重，project 覆盖 user，最终随 `internalPlugins` 安装进 Harness

   * **Provider 类型工厂**（扩展 `config.type`）：`providerTypeFactory` 或 `providerType`+`createProviderPlugin`，注册进 `ProviderTypeRegistry`
3. **校验/自检联动**：`buildCheckRegistry` 与 boot 均改用 `loadPluginDirs`；未知 type 报错与帮助文案改指 `plugins` 目录
4. 坏模块（既无 AgentPlugin 也无 Provider 工厂）忽略并告警，不静默、不崩溃

### 验证

* CLI 测试重构为 64 个：新增 `providerTypeFactory` 形态、通用 AgentPlugin（default/plugin/plugins）、通用插件按 id 去重（project 覆盖 user）等用例

* cli 64 用例全绿，cli typecheck 通过

## 2026-08-27（续 17）：模型配置及切换

### 背景

模型缺失统一的配置入口与运行时切换能力：此前只能通过 Provider 插件传入（anthropic 的 `defaultModel` 或 Agent 定义 `model.modelId`），命令行/会话运行时无法便捷查看与切换模型。本次补齐「配置 → 运行时切换 → 状态展示」闭环。

### 实现（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts) / [tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

1. **配置来源统一（优先级：CLI > config.json > 环境变量）**

   * `ConfigStore`（dataDir/config.json）：读写 `agentId / provider / model / anthropicApiKey`，缺文件/坏 JSON 幂等返回空

   * `resolveConfig`：main() 里把 CLI 参数与 config 合并（CLI 优先），代理/mock 测试注入不受影响
2. **CLI** **`-m, --model <modelId>`**：写入默认 Agent 定义 `model.modelId`（运行时 llmIn 取 `agent.model.modelId`），并作为 provider 的 `defaultModel` 兜底
3. **运行时** **`/model`** **命令**：`/model` 查看当前模型；`/model <modelId>` 更新当前 Agent 的 model 并持久化 config.json（影响下次 send）；列入 `/help` 与 REPL\_COMMANDS
4. **TUI 状态展示**：`TuiReplOptions.model` 传入后，状态栏/侧栏初始即显示配置模型（此前要到首轮 done 才显示实际命中模型）
5. **boot() provider 合并**：anthropic 分支可按 config.json 的 `anthropicApiKey` 直接提供 key（显式配置 > config > 环境变量）

### 验证

* cli 74 用例全绿（新增 `--model` 解析、ConfigStore 往返/坏 JSON、resolveConfig 优先级、REPL `/model` 查看+切换+落盘、TUI 状态栏初始模型展示共 8 个），cli typecheck 通过

## 2026-08-27（续 20）：Provider 类型插件化（去掉硬编码 type 枚举）

### 背景

`ProviderConfig.type` 之前是硬编码枚举（anthropic/openai/gemini/glm/qwen/mock），CLI 内部 switch 分发，新增 Provider 类型必须改 CLI 代码——违背系统插件化理念。本次改为注册表 + 多级插件目录加载。

### 实现（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

1. **`ProviderConfig.type`** **开放为任意字符串**：内置类型只是「已注册」的默认项，不再是枚举限制
2. **`ProviderTypeRegistry`**：`type → createPlugin(config)` 工厂注册表，`resolve/list` 动态解析（替代硬编码 switch）

   * `registerBuiltinProviderTypes(registry, options)`：内置 openai/anthropic/gemini/glm/qwen/mock 以注册方式装配（anthropic 仍捕获 options 兜底 key）

   * `HarnessApp.providerTypes` 公开注册表，第三方可在 boot 前注入自定义 type
3. **外部插件多级加载**：`loadProviderPluginDirs` 扫描 `~/.harness/provider-plugins`（user）→ `<project>/.harness/provider-plugins`（project，后加载覆盖）

   * 插件模块约定导出 `providerType: string` + `createProviderPlugin(config): AgentPlugin`（或 `providerTypeFactory` / default 同构）

   * 缺声明/加载失败 → 告警跳过（不静默、不崩溃）
4. **校验动态化**：`validateProviderConfigs(providers, defaultId, knownTypes)` 已知类型由注册表提供，未知 type 报错时列出已注册类型并提示 provider-plugins 扩展方式
5. **自检联动**：`--check-config` / `config check` 通过 `buildCheckRegistry` 加载外部插件后再校验

### 验证

* 新增测试：ProviderTypeRegistry（register/resolve/list/覆盖）、内置 6 类型齐全、loadProviderPluginDirs（约定加载/多级覆盖/坏文件告警）、校验按注册表动态、自定义 type 经注册表装配并参与分发

* cli 101 用例全绿，cli typecheck 通过；真实冒烟：`.harness/provider-plugins` 放 my-gw 插件 → `--check-config` 识别 `type=my-gw` 并校验通过

## 2026-08-27（续 19）：多 Provider 配置健壮性增强

### 背景

续 18 的多 Provider 支持存在静默失败路径（重复 id 静默覆盖、未知 type 静默丢弃、默认 provider 缺失误导提示），apiKey 只能明文落盘。用户确认增强：启动显式校验、apiKey 环境变量引用 + 加密存储、配置自检命令。

### 实现

1. **显式校验（boot 一次性报错）**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

   * `validateProviderConfigs`：重复 id / 未知 type / 默认 provider 未定义（非内置 mock/anthropic）→ 收集全部问题

   * `ConfigValidationError`：boot 时输出所有问题后抛错，不再静默跳过或误导提示
2. **密钥加密存储**：`SecretCipher`（AES-256-GCM）

   * 主密钥：`HARNESS_CONFIG_KEY` 环境变量（sha256 派生）→ `<data-dir>/.config-key` 文件（首次自动生成，chmod 600）

   * 格式 `enc:v1:<iv>:<tag>:<ct>`（base64），明文不落盘

   * `resolveSecret`：`${ENV_VAR}` 环境变量引用 / `enc:v1:` 解密 / 明文透传；未设置变量或解密失败报 ConfigValidationError
3. **config 子命令**：`harness config set-key <providerId> <apiKey>` 加密写入；`get-key <providerId>` 解密查看；`check` 校验 + 概览
4. **自检命令**：`--check-config`（等价 `config check`）打印 Provider/模型概览（apiKey 状态脱敏展示：已配置 / 已加密 / env(名称) / 未配置）+ 校验，REPL 新增 `/config`
5. **接入 GLM / Qwen 预设 Provider**（[packages/plugins/provider-glm](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-glm/src/index.ts) / [provider-qwen](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-qwen/src/index.ts)）

   * CLI `ProviderConfig.type` 支持 `glm` / `qwen`：预设 baseUrl/apiPath/默认模型（GLM=bigmodel，Qwen=dashscope），apiKey 环境变量 ZHIPU\_API\_KEY / DASHSCOPE\_API\_KEY

   * 插件 providerId 可覆盖、插件 id 随 providerId 派生（同 openai 多实例不冲突）
6. **parseCliArgs**：`config` 子命令（arg=子命令，rest=剩余非选项参数）+ `--check-config`

### 验证

* 新增测试：SecretCipher 往返/主密钥优先级、resolveSecret（env 展开/未设置报错/解密）、validateProviderConfigs（重复/未知/默认缺失）、buildConfigOverview 脱敏、boot 显式报错（一次性输出）、glm/qwen 注册分发、${ENV} boot 展开、main config set-key/get-key/check、--check-config 通过与报错

* cli 94 用例全绿，glm/qwen/cli 三包 typecheck 通过；真实 CLI 冒烟：check 概览、set-key 加密落盘、get-key 还原、错误配置一次性报错且退出码 1

## 2026-08-27（续 18）：多 Provider 自由切换（自定义模型配置）

### 背景

用户确认「自定义模型配置」期望的能力范围 = 多 Provider 自由切换：config.json 定义多个 provider（anthropic / openai / glm / qwen / gemini + 任意 OpenAI 兼容端点如 Ollama / DeepSeek），每个含 baseUrl / apiKey / model，`-m` / `/model` 可跨 Provider 任意切换。

### 实现

1. **core：ChatProvider 注册表**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

   * `chatProviders: Map<providerId, ChatProvider>`：`_setChatProvider` 按 `p.id` 入表

   * `resolveChatProvider(providerId)`：命中注册表 → 该 Provider；否则回退默认（context 记的 `chat.provider` / `chatProvider`）

   * AgentRuntime 调用点改为 `this.deps.chatProvider(llmIn.providerId)`，`provider.complete({ providerId, modelId, ... })` 动态分发
2. **CLI：providers 多配置 + 规格解析**

   * `HarnessConfig.providers: ProviderConfig[]`（config.json），`ProviderConfig = { id, type, baseUrl?, apiKey?, model?, apiPath?, maxTokens?, timeoutMs? }`

   * `parseModelSpec` / `formatModel`：`provider/modelId` 规格解析与格式化

   * `HarnessApp.boot()` 动态安装：非默认 Provider 先注册，默认 Provider 最后注册作兜底；`buildProviderPlugin()` 按 type 构造 openai / anthropic / gemini / mock 插件，openai 可对接任意兼容端点（DeepSeek / Ollama / GLM 等）
3. **修复 PluginDuplicateIdError**（[packages/plugins/provider-openai/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-openai/src/index.ts)）

   * openai 插件 id 由写死的 `provider.openai` 改为随 `config.providerId` 派生（`provider.{providerId}`），使多个 OpenAI 兼容 Provider 不冲突
4. **`-m, --model <provider/model>`**：CLI 解析 `provider/model` 绑定 Agent 的 `providerId + modelId`，同时作为默认 Provider 的 `defaultModel` 兜底
5. **`/model`** **支持跨 Provider**：`/model openai/gpt-4o` 校验 provider 是否注册 → 更新 Agent 并持久化（provider + model）到 config.json；`/model` / `/model ?` 展示已注册 Provider 列表
6. **listProviders()**：汇总 config.providers 显式 id + 默认 provider（供状态栏 / /model 展示）

### 验证

* 新增核心测试：多 Provider 按 `agent.model.providerId` 分发 / 回退默认 / 未知 id 回退默认

* 新增 CLI 测试：`parseModelSpec` / `formatModel`、`-m provider/model` 绑定、`setModel` 跨 Provider 切换 + 落盘、多 Provider 注册按 id 分发

* 修复 openai 插件重复注册冲突 + 测试绑定丢失 `this` 的问题；cli 78 用例全绿，core 29 用例全绿，core / cli / provider-openai 三包 typecheck 通过

## 2026-08-27（续 16）：文件引用跳转验证 + Markdown 长文本流式性能优化

### 背景

续 15 已实现 Claude Code 风格界面能力：Markdown 流式渲染、代码块高亮、多面板侧栏、文件引用提取、状态栏扩展。本次一起推进两块收尾工作：

1. **文件引用跳转，从「能提取」到「可操作」的验证**：此前只做了引用提取与侧栏渲染，未验证「Tab 进入列表 → 上下键选中 → Enter 打开」这一导航链路在组件层面真正可达、且 `openFile(path, line)` 被以正确解析参数调用
2. **Markdown 长文本流式性能**：assistant 正文流式时文本不断向同一块追加，旧实现 `collectFileReferences(state)` 每次 state 变化都对全部块文本做 O(总文本) 正则重扫，随回复增长代价递增

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx) / [tui.test.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.test.tsx)）

1. **增量文件引用索引 FileRefIndex**：从「每块记录已扫描长度」出发，`indexFileReferences(index, blockId, text)` 只对新增尾部（回看 `REF_SCAN_OVERLAP=64` 窗口以捕获跨增量边界的路径）增量扫描并归一化去重，使单批成本从 O(总文本) 降到 O(增量)。`TuiApp` 侧栏改为对该索引做只增 append（useMemo + ref），而非每次全量重算
2. **导航集成测试补全**：`mountTui` 扩展支持注入 `responses` 与 `openFile` spy；新增用例验证——Tab 进入列表出现 `▸` 选中标记、Esc 退出列表、未 Enter 不触发打开；以及下移选中第二项后 Enter 以 `{path, line}` 正确调用 openFile
3. **FileRefIndex 纯函数单测**：空索引、文本未增长同引用短路、增量尾部识别、跨边界回看窗口捕获、同文件不同行号归并
4. **导航语义修正**：非列表模式下 Tab 进入、列表模式下非导航键均 `return true`（preventDefault 语义），避免列表模式按键误键入输入框

### 验证

* cli 66 用例全绿（含 2 个新导航集成 + 5 个 FileRefIndex 单测），全仓 26 包 typecheck 通过

* 导航链路：mock 回复 `改动 src/foo.ts:12 与 src/bar.ts:3` → Tab → down → Enter → `openFile('src/bar.ts', 3)` 被调用，:行号解析正确

## 2026-08-26（续 15）：TUI 渲染层迁移 OpenTUI（Bun 原生 Zig 渲染核心）

### 背景

自研 ANSI TUI（续 13）满足基础需求，但要做到 Claude Code / opencode 级别的功能齐全（代码高亮、Markdown 渲染、多面板布局、鼠标支持、选区复制等），自研成本过高。对比主流 TUI 方案后选定 **@opentui/core + @opentui/react**：

* **ink**：react-reconciler 方案，但终端重建需 ink 自己的渲染管线，对 Bun 支持一般，且零依赖风格冲突

* **OpenTUI**：Bun 原生（Zig 渲染核心 + Yoga flexbox 布局），`@opentui/react` 提供 React 组件树（box/text/input/scrollbox），自带 `<code>`/`<markdown>` 语法高亮等扩展能力；官方提供 `createTestRenderer` 测试方案，可直接 mock 按键断言帧内容

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

1. **t1 渲染层重写**：`KeyDecoder`/`TuiScreen` 自研 ANSI 全部移除，替换为 `TuiApp` React 组件（状态栏 + scrollbox 日志区自动滚动 + 底部 input 行）；`startTuiRepl` 改为 `createCliRenderer()` + `createRoot(renderer).render(<TuiApp/>)`；**会话内核** **`createProcessLine`** **原样保留**，TUI 与 REPL 依然共用同一套处理逻辑
2. **t2 三处真实 bug 修复**：

   * `processLineRef` 改为渲染期同步初始化（`createProcessLine` 是纯工厂），避免 Enter 提交早于 mount effect 执行时 ref 为 null

   * `<input onSubmit>` 不再读 React 状态闭包（快速输入时状态滞后于输入框内部文本），改用事件携带的 `currentValue`

   * **mount effect 覆盖竞态（pty 冒烟暴露）**：初始欢迎语/状态栏若用 `useEffect` 设置，而 processLine 已同步初始化，用户首个输入可在 effect 前被处理——回复内容先 append 进 logs，随后 effect 的 `setLogs([...欢迎语...])` 整体覆盖丢弃。修复：logs/status 直接用 `useState` 初始值，删除 mount effect
3. **t3 工程适配**：cli 新增依赖 `@opentui/core` / `@opentui/react` / `react`；tsconfig 配置 `jsx: react-jsx` + `jsxImportSource: @opentui/react`；文件名 `tui.ts` → `tui.tsx`、`tui.test.ts` → `tui.test.tsx`
4. **t4 测试重写**：旧 21 用例（KeyDecoder/TuiScreen/scriptedKeys）替换为 `@opentui/core/testing` 的 `createTestRenderer` + `mockInput` 驱动 `TuiApp`（10 用例：appendLog 4 / 集成 4 / --tui 2）；测试渲染器需手动 pump `renderer.loop()` 产出帧（waitForFrame 不驱动循环）

### 验证

* cli 38 用例全绿（含 TuiApp 输入提交流式渲染 / Ctrl-C / /exit 集成），全仓 25 包 typecheck 通过

* python pty 真实终端冒烟：`🧑 hi` 回显 → `🤖 (Mock Provider) 你好，我是测试助手。` 流式渲染 → `⏱️` 计时行 → 状态栏 session/agent 显示；注意 OpenTUI 增量渲染对变化单元格逐格写 ANSI 色码，字节流子串匹配需按单字符断言

* 保留能力：`harness repl --tui` 全屏交互、与 REPL 共用 /命令与插件 hook、自动续轮注入

## 2026-08-26（续 14）：TUI 输入修复——真实终端无法输入字符

### 现象

`harness repl --tui` 启动后界面正常渲染，但键盘输入无反应（字符不显示、回车不提交）。

### 根因（[tui.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.ts)）

两个叠加 bug：

1. **drainQueue busy 标志竞态（致命）**：`draining = (async () => {...})()` 中，async IIFE 同步完成时 `finally { draining = null }` 先执行，随后赋值把已 resolve 的 promise 写回 `draining`。真实终端下字符块与回车块是两次独立 data 事件——字符块的 drainQueue 同步完成后 `draining` 仍非空，回车块调用 drainQueue 被 `if (draining) return` 拦截，**提交的行永不处理**。修复：改用 promise 链（`queueTail = queueTail.then(...)`）串行处理，天然不丢行。
2. **按键不触发重绘**：handleKeys 仅在 Enter 提交时 scheduleRender，char/退格/方向键修改 screen.input 后屏幕不刷新，用户看不到输入的字符。修复：每次按键后统一 scheduleRender。

### 排查过程

* expect（pty）复现不稳定（bun 冷启动慢 + `~/.harness` 写入 EPERM 干扰）→ 用 python `pty.fork()` 复现真实终端输入

* 逐级 stderr 调试定位：`TUI-DATA`（data 事件收到 hi ✓）→ `TUI-KEY`（char 插入 screen.input ✓）→ `TUI-DRAINQ-CALL`（enter 时 `draining=true` 拦截 ✗）

### 验证

* python pty 全流程：`🧑 hi` 回显 → `🤖 (Mock Provider) 你好，我是测试助手。` 流式渲染 → 退出序列收尾

* 新增回归测试「输入与回车分块到达（真实模式时序）也能提交处理」（修复前必失败）

* cli 50 用例全绿（+1），全仓 26 包 typecheck 通过

## 2026-08-26（续 13）：TUI 形态落地——自研 ANSI 渲染（预留迁移）

### 方案决策

* **自研 ANSI TUI**（放弃现成库：ink 依赖 react-reconciler 与零依赖风格冲突、blessed 已停维护带 CVE、clack 满足不了多面板需求）

* **渲染层严格隔离**：TUI 与 REPL 共用同一套会话处理内核（`createProcessLine`），渲染/输入层独立成模块，未来若需求膨胀（鼠标、富布局）可低成本迁移 ink

### 实现（[packages/cli/src](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src)）

1. **t1 重构**：`startReplCore` 的 `processLine` 提取为可复用工厂 `createProcessLine({ app, harness, session, out, onLine?, setSession? })`（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）——流式事件渲染、`/` 命令、插件 cli.command hook、`AUTO_CONTINUE_LINE` 全部共用；REPL 与 TUI 同一内核
2. **t2 新建** **`tui.ts`**：

   * `KeyDecoder`：raw-mode 键盘字节流 → KeyEvent（箭头/Enter/Backspace/Ctrl-C/Tab/Home/End/Delete；跨块转义序列缓冲）

   * `TuiScreen`：alt-screen 全屏渲染（状态栏 + 日志区自动滚动 + 底部输入行 + 光标定位 CSI）；`append` 流式拼接当前行

   * `startTuiRepl`：非阻塞输入循环，Enter 提交 → createProcessLine 处理 → 输出回流日志区；`drainQueue` 共享 promise 防并发；退出前 flushRender 保证退出序列收尾
3. **t3 CLI 入口**：`harness --tui` 进入 TUI 模式（parseCliArgs 新增 tui 标志 + main 分支 + HELP\_TEXT）
4. **t4 测试**：`tui.test.ts` 21 用例（KeyDecoder 10 / TuiScreen 5 / startTuiRepl 4 / --tui 2），cli 28 用例保持全绿

### 修复

* KeyDecoder `\x1b[n~`（Delete）解码：`fin==='~'` 分支不可达，统一到未知 CSI 路径解析

* startTuiRepl 脚本模式并发 drain：`void drainQueue()` 与 `await drainQueue()` 竞争导致提前返回丢流式输出 → 共享进行中 promise

* TuiScreen.append 把流式 token 当独立行 → 改为追加当前行（换行才分行）

### 状态

* cli 49 用例全绿（+21），全仓 26 包 typecheck 通过

* 边界：本次不做鼠标交互、富文本布局（预留迁移口的边界条件）

## 2026-08-26（续 12）：Swarm 待办收尾——tmux/iTerm2 进程后端 + send\_message 路由统一

对照架构 §9.4「Swarm 后续待办」，实现最后 2 项（8、10），Swarm 待办 10 项全部完成：

### 1. tmux/iTerm2 进程后端（out-of-process teammate）

* swarm 新增 `spawnTerminalTeammate`（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

  * tmux：`new-session -d`（已存在则 `new-window`）→ `send-keys` 注入 CLI 启动命令 → paneId 写入 `TeamMember.tmuxPaneId`

  * iTerm2：osascript 创建窗口 + `write text` 启动命令，返回 window id

  * 命令执行器可注入（`run`），默认 `spawn` 收集 stdout，纯逻辑可测试

* CLI 新增 `teammate` 子命令（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：`harness teammate --team <t> --name <n> --agent <a>`——复用 HarnessApp.boot + `startTeammateLoop` 持续轮询 mailbox/认领任务，直到 shutdown 退出

* `spawnTeammate` 统一分流：backend = in-process | tmux | iterm2

### 2. send\_message 路由统一

* coordinator `send_message` 双路由（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：

  * **mailbox 路由**（team + to）：单播到成员 inbox；`to='*'` 广播到团队全部成员

  * **本地续跑路由**（taskId）：原 worker 子会话续跑语义不变

* mailbox 经插件选项依赖注入（`SendMailbox` 鸭子接口，不硬依赖 swarm），未注入时 mailbox 路由返回 `MAILBOX_NOT_CONFIGURED`；无目标返回 `INVALID_TARGET`

### 验证与提交

* 测试：swarm 63 用例全绿（+3：tmux 命令序列/iTerm2 osascript/spawn 分流）、coordinator 29（+4：单播/广播/未配置/无目标）、cli 28（+1：teammate 参数解析）

* 全仓 26 包 typecheck 通过

* 文档：架构 §9.4 Swarm 待办 10 项全部 ✅

## 2026-08-26（续 11）：Swarm 待办 7、9 项落地（plan approval + team file 字段补全）

对照架构 §9.4「Swarm 后续待办」，实现第 7、9 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. plan approval 自动批准 + permissionMode 继承

* helper：`createPlanApprovalRequest`（plan 内容 + 期望 permissionMode）、`createPlanApprovalResponse`（approved + leader permissionMode）

* teammate 侧：`requestPlanApproval`（写 plan\_approval\_request 到 leader inbox + 挂起回调）、`processMailboxPlanApprovalResponse`（命中 requestId 配对 resolve，返回 approved + 继承的 permissionMode）

* leader 侧：`processMailboxPlanApprovalRequests` 自动批准 plan\_approval\_request 并回写响应，携带 leader 当前 permissionMode（宿主传入）供 teammate 继承

* `runTeammateTick` 每轮先处理 plan\_approval\_response 配对（与权限响应并列）

### 2. team file 字段补全 + setLeaderTeamName

* `TeamMember` 增 joinedAt / tmuxPaneId / cwd / subscriptions；lead 与新增成员自动记录 joinedAt（同名覆盖保留原值）

* `TeamFile` 增 leaderTeamName + `TeamManager.setLeaderTeamName`（多后端共享任务池定位；out-of-process teammate 通过它找到归属团队目录）

### 验证与提交

* 测试：swarm 60 用例全绿（+5：字段补全 1 + setLeaderTeamName 1 + plan approval 3）

* 全仓 26 包 typecheck 通过

* 文档：架构 §9.4 第 7、9 项标记 ✅（tmux/iTerm2 后端、send\_message 路由统一 留待办）

## 2026-08-26（续 10）：Swarm 待办 4-6 项落地（poller 优先级 + task 依赖锁 + idle\_notification）

对照架构 §9.4「Swarm 后续待办」，实现第 4-6 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. inbox poller 优先级 + 投递后才 markRead

* `sortMessagesByPriority`：shutdown（request/approved/rejected）最高（防 peer 消息饿死）→ lead 消息 > peer 消息，同级稳定排序保持 FIFO

* `attachInboxPoller` 与 `runTeammateTick` 共用排序；**投递成功后才 markRead**——onMessage/query 失败的消息保持未读，下轮重试（防丢消息）

* `runTeammateTick` 新增中断守卫：消息循环中状态被置 shutdown（如 approve\_shutdown 触发关停）时不再认领任务

### 2. task 依赖（blockedBy）与认领锁

* `SwarmTask.blockedBy?: string[]`（task\_create 工具可选输入）：依赖任务全部 completed 才可认领，指向不存在的任务视为未解决

* `claim` 在 `withLock` 内 busy-check（状态 + 依赖双重校验，文件锁防 TOCTOU）

* `tryClaimNextTask` 跳过依赖未解决/已被并发认领的任务，认领下一个可认领任务

### 3. idle\_notification（每轮结束上报）

* `createIdleNotification` helper（idleReason: available/interrupted/failed + summary）

* `runTeammateTick` 每轮结束向 leader 发 idle\_notification：无任务 → available；结果异常 → failed；消息循环中途被关停 → interrupted（且不再认领任务）

### 验证与提交

* 测试：swarm 55 用例全绿（+10：优先级排序 2 + poller 重试 1 + blockedBy 3 + 空闲通知 3 + createIdleNotification 1）

* 全仓 26 包 typecheck 通过

* 文档：架构 §9.4 第 4-6 项标记 ✅（plan approval / tmux 后端 / team file 字段 / send\_message 路由统一 留待办）

## 2026-08-26（续 9）：Swarm 待办前三项落地（mailbox 协议 + 权限双轨 + shutdown 模型决策）

对照架构 §9.4「Swarm 后续待办」，实现前 3 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. mailbox 协作协议类型扩展

* `MailboxMessageType` 扩至 15 种：message + permission\_request/response + sandbox\_\* + plan\_approval\_\* + shutdown\_request/approved/rejected + idle\_notification + task\_assignment + team\_permission\_update + mode\_set\_request + task\_notification

* `isStructuredProtocolMessage` 路由：结构化协议消息与普通 message 区分（poller/tick 按此路由，避免被当普通 LLM 上下文吞掉）

* 协议 helper 构造函数：`generateRequestId`（前缀+自增序列）、`createPermissionRequest/Response`（requestId/replyTo + data.allow/forever）、`createShutdownRequest/Decision`（shutdown\_request → approved/rejected）

* `SendTeammateMessageInput.type` 同步扩展（shutdown\_request/shutdown\_approved/shutdown\_rejected/idle\_notification）

### 2. 权限 mailbox 双轨 fallback

* `requestSwarmPermission`：有 leader 桥走 confirm queue（workerBadge）；无桥且提供 mailbox/team/leaderName 时降级 mailbox——`sendPermissionRequestViaMailbox` 写 permission\_request 到 leader inbox + `registerPermissionCallback` 挂起回调；leader 写回 permission\_response 后由 `processMailboxPermissionResponse` 命中 requestId 配对 resolve（data.allow/forever）；双轨皆无 fail-closed 拒绝

* `runTeammateTick` 每轮最先处理挂起的权限响应，再读普通消息

* 新增 `unregisterLeaderConfirmQueue`（对称清理，测试复位全局状态）

### 3. shutdown 模型决策

* `runTeammateTick` 对 `shutdown_request` 不直接关停：注入 query（含 requestId）由模型调用 `approve_shutdown`/`reject_shutdown` 工具决策（对齐 Claude Code approveShutdown）

* `createShutdownDecisionTool('approved'|'rejected')`：回发 shutdown\_approved/shutdown\_rejected（replyTo=requestId）；approve 时通过 onDecision 回调触发关停

* 插件注入：approve 工具按 memberName 查 teammateRegistry，命中则 abort + 状态置 shutdown；reject 仅回发响应

### 验证与提交

* 测试：swarm 45 用例全绿（+11：协议 helper 5 + 权限 fallback 3 + shutdown 工具 3），插件注入清单更新为 11 个工具

* 全仓 26 包 typecheck 通过

* 文档：架构 §9.4 前三项标记 ✅（inbox poller 优先级 / task 依赖锁 / idle\_notification / plan approval / tmux 后端 / team file 字段 / send\_message 路由统一 留待办）

## 2026-08-24（续 8）：写锁设计修正（声明级 → 文件级）+ Swarm 待办记录

### 1. FileWriteArbiter：文件级写锁（替代派工声明级仲裁）

**问题（用户反馈）**：初版 `CoordinatorFileArbiter` 只在 subagent 工具调用时触发，且按 `targetFiles`/`writesTo` 在**派工时**整组阻塞——agent 实际写哪些文件执行前并不确定，声明级锁会误伤不相关 worker，且锁持有到 worker 生命周期过长。

**修正**（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：

* 重命名为 `FileWriteArbiter`：按 canonical 路径跨 session 互斥（per-path FIFO 等待队列），同 session 内天然串行直接放行

* 锁持有 = **单次写工具调用**：`tool.pre.execute` 对 `write_file`/`edit_file`（从输入 `path` 提取目标）执行前 `acquireWrite`、finally `releaseWrite`；subagent 派工不再做任何声明级阻塞（仅保留 forceAsync）

* `SubagentToolInput.targetFiles` / `AgentDefinition.writesTo` 保留为提示性声明，不参与仲裁；bash 无法可靠解析写入路径，不纳入（与 Claude Code 一致靠 prompt 纪律兜底）

* 测试：coordinator 25 用例全绿（FileWriteArbiter 6 + 插件集成 5：跨 session 阻塞/并行/顺序释放/非写工具不拦截/开关）

### 2. Swarm 待实现功能记录（对照 Claude Code 源码调研）

已记录到架构文档 §9.4「Swarm 后续待办」10 项：mailbox 协议类型扩展（permission/sandbox/plan\_approval/idle\_notification 等 + isStructuredProtocolMessage 路由）、权限 mailbox 双轨 fallback、shutdown 模型决策（approveShutdown 工具）、inbox poller 优先级 + 投递后 markRead、task blockedBy 依赖 + claim 文件锁防 TOCTOU、idle\_notification、plan approval 自动批准 + permissionMode 继承、tmux/iTerm2 后端、team file 字段补全 + setLeaderTeamName、send\_message 路由统一（resume + mailbox + broadcast）

## 2026-08-24（续 7）：targetFiles 写入源 + in-process teammate 完整执行循环

### 1. targetFiles 写入源修复（Coordinator 串行化真实生效）

* **问题**：`SubagentToolInput.targetFiles` 是可选字段，但 `makeSchema` 不透传 LLM 可见 schema、工具描述未提及、coordinator 只读不填——**无任何写入来源**，仲裁器实际不会触发

* **修复**：`AgentDefinition` 新增 `writesTo?: string[]`（[packages/agent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/agent/src/index.ts)，frontmatter `writesTo:` 解析）；coordinator `tool.pre.execute` 在调用未显式传 `targetFiles` 时，自动从被派 Agent 定义 `writesTo` 填充（显式传参优先）

* 测试：agent 23 用例（+2 writesTo 解析）、coordinator 30 用例（+1 定义回退仲裁）

### 2. in-process teammate 完整执行循环（@harness/swarm）

对齐 Claude Code `spawnInProcessTeammate` + `inProcessRunner` teammateLoop + `tryClaimNextTask`：

* **`spawnInProcessTeammate`**：加入/创建团队（新建时 lead=自身）→ 创建独立子 session → 注册（默认全局 `teammateRegistry` 单例，可注入隔离实例）→ 带初始 prompt 立即执行一轮（AsyncLocalStorage 身份上下文）

* **`runTeammateTick`**（单轮执行体）：① mailbox 未读消息——普通消息作为 query 输入、回复写回发送者、标记已读；shutdown 类型消息触发 abort + 状态置 shutdown；② `tryClaimNextTask`——认领 available 任务 → query 执行 → 更新任务 completed/failed + 向 leader 发 task\_notification（replyTo=taskId）

* **`startTeammateLoop`**：周期驱动 tick（intervalMs 可配），stop()/shutdown 消息停止

* 修复：spawn 时团队新建后 teammate 未入队（补 addMember）

* 测试：swarm 34 用例全绿（+6：tick 消息处理/任务完成/任务失败/shutdown + spawn 注册/loop 自动执行）

### 验证与提交

* 全仓 26 包 typecheck 通过；agent 23 + coordinator 30 + swarm 34 测试全绿

* 文档：架构 §9.4 Coordinator 补 writesTo 自动填充说明、Swarm in-process 完整循环 ✅（tmux/iTerm2 后端留待办）

## 2026-08-24（续 6）：Coordinator 写操作串行化 + Swarm Plugin（@harness/swarm）

### 1. Coordinator 写操作按文件集串行化（§9.4 收官）

* `SubagentToolInput` 新增 `targetFiles?: string[]`（worker 派工时声明要写的文件/目录，调度元数据，subagent 工具本身不消费）

* `CoordinatorFileArbiter`（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：`pathsOverlap` 前缀匹配冲突检测（相同/目录子路径/祖先后代）+ FIFO 等待队列

* `tool.pre.execute` 拦截 subagent 调用：冲突派工 `await acquire(toolUseId, targetFiles)` 阻塞；后台任务由 subagent.completed/failed 事件（按 toolUseId）释放声明，同步任务在 next() 返回时 finally 释放

* `createCoordinatorPlugin({ serializeWrites: true })` 默认开启，仅对声明了 targetFiles 的调用生效；forceAsync 与仲裁合并到同一 preHook

* 测试：coordinator 29 用例全绿（新增 pathsOverlap 6 + arbiter 5 + 串行化集成 5）

### 2. Swarm Plugin 新包 `@harness/swarm`（§9.4 Swarm 项核心落地）

参考 Claude Code swarm（teammateMailbox / TeamCreateTool / TaskCreateTool / TaskStopTool / leaderPermissionBridge / spawnInProcess），存储根 `~/.harness/teams/`：

* **TeamManager**：team file 持久化（`{name}/team.json`，name/description/lead/members，同名成员覆盖），create/get/list/addMember/delete，create 时初始化 inboxes/

* **TeammateMailbox**：`{name}/inboxes/{agent}.json` 文件收件箱，`withLock`（原子 'wx' 锁文件 + EEXIST 重试 + 超时）串行化并发写；readUnread/markMessageAsReadByRef/countUnread

* **TaskListPlane**：`{name}/tasks.json` 共享任务池，状态机 available → in\_progress → completed/failed/cancelled（生命周期校验 + claim 冲突检测 + stop 统一 kill switch）

* **LeaderPermissionBridge**：module-level `registerLeaderConfirmQueue`（CLI/REPL 注册 leader 确认入口）+ `requestPermissionThroughLeader`（teammate ask 权限带 workerBadge 回流 leader；无桥 fail-closed 拒绝）

* **InboxPoller**：`attachInboxPoller` 周期轮询未读消息回调宿主（纯逻辑 + 手动 pollOnce，可独立测试）

* **in-process teammate 基础**：`TeammateRegistry` + `withTeammateIdentity`（AsyncLocalStorage 身份隔离）+ `formatAgentId`（{name}@{team}）；完整执行循环 + tmux/iTerm2 后端列后续

* **工具**（tool.pool.assemble 注入全部 Agent）：team\_create/team\_delete/team\_status、send\_teammate\_message（mailbox 路由，避免与 coordinator send\_message 冲突）、task\_create/list/claim/update/stop

* 测试：swarm 28 用例全绿（sanitizeName 2 + TeamManager 5 + Mailbox 4 + TaskList 5 + PermissionBridge 2 + Poller 2 + teammate 2 + 工具 5 + 插件 1）

* 踩坑：`withLock` 首版 catch 吞掉 ENOENT（父目录不存在）→ 无限重试锁超时；修复为 withLock 内先 mkdir 父目录 + 仅 EEXIST 重试

### 验证与提交

* 全仓 26 包 typecheck 通过；coordinator 29 + swarm 28 + subagent 92 测试全绿

* 文档：架构 §9.4 Coordinator 全部 ✅、Swarm 核心 ✅（完整执行循环/tmux 后端留待办）；development-log 续 6

## 2026-08-24（续 5）：§10.4 双后端 + 存储治理（快照 fallback / gc / 上限）

### 重构 `@harness/snapshot` 为双后端（[packages/snapshot/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/snapshot/src/index.ts)）

实现 §10.4 全部 4 项边界外增强：

* **`SnapshotService`** **从 class 改为 interface**，`GitSnapshotService`（默认，OpenCode git tree 方案）+ 新增 `FileSnapshotService`（Claude Code fileHistory 文件副本方案）双实现

* **工厂 auto 探测**：`createSnapshotService({ backend: 'auto'|'git'|'file' })`；auto 用 `resolveGitBin()`（依次查 PATH / `/usr/bin/git` / `/opt/homebrew/bin/git`，带缓存）探测 git，不可用自动降级 file 后端；`runGit` 同步改用解析出的 git 二进制（修复终端 PATH 异常下 git 不可用）

* **FileSnapshotService**（不依赖 git）：

  * 存储：`~/.harness/file-snapshots/{worktree-hash}/`（`backups/{sha256_16}@v{n}` + `snapshots.json` 快照链，ID `fs-{seq}`）

  * **三级变更检测**（对齐 `checkOriginFileChanged`）：`FileBackupMeta` 记录 `backup/version/mode/size/mtime`；stat（mode/size/mtime）一致直接复用；变化再内容级兜底，一致仍复用（增量快照）；不同才 `copyFile` 新备份

  * `restore`/`checkout` 幂等：目标备份 null → `rm`（对齐 applySnapshot unlink 分支），否则 `copyFile` + `chmod` 恢复权限

  * diff 用简化行 diff（前缀/后缀公共行 + 中间区贪心对齐，识别"插入在中间"的公共行），unified patch + 增删统计

  * `gc()`：清理快照链不再引用的 `@v{n}` 备份

* **check-ignore**：git 后端 `--exclude-standard` 隐式复用用户 .gitignore；file 后端惰性读根 `.gitignore`（简化 matcher：`*`/`**`/`?`/目录 `/` 结尾/`!` 取反/`#` 注释）+ 跳过 `.git` 与 worktree 内 dataDir

* **git gc + 上限**：`GitSnapshotService` 新增 `snapshot-ids.json` 注册表（`maxSnapshots` 默认 100 淘汰最旧）+ `gc()`/`gcUnlocked()`（`git gc --prune=7.days`），capture 每 `gcEvery` 次（默认 50）自动 gc

### 踩坑修复

| 问题                                       | 原因                                                                             | 修复                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| 自动 gc 时 capture 返回 undefined（快照丢失）       | `recordSnapshotId` 内调 `this.gc()`，与外层 capture 的 `mutex.run('tree')` 同 key 嵌套死锁 | 抽 `gcUnlocked()` 无锁内部方法，公共 `gc()` 加锁、锁内路径直调无锁版 |
| file 后端每次 capture 都新建备份（增量快照失效）          | `FileBackupMeta` 未存 size/mtime，`info.size === prev.size` 恒 false               | 补 `size`/`mtime` 字段，三级检测 stat 级对齐              |
| file 后端 diff 统计偏差（公共行 'three' 被算作 -/+）   | 简单前后缀匹配在"插入在中间"时失准                                                             | 中间区贪心对齐：对 a 剩余行在 b 剩余区间顺序查首个匹配                 |
| tsc 报 `number \| bigint` / `Dirent` 泛型错误 | `Awaited<ReturnType<typeof stat>>` 解析为联合类型                                     | 显式 `import type { Stats, Dirent }`             |

### 测试与验证

* snapshot 包 **25 用例全绿**（原 11 + git 后端 gc/上限 3 + file 后端 8 + 工厂 3）；`typecheck` 通过

* 全仓 25 包 typecheck 通过；core/revert/cli 既有用例无回归

* 注：`@harness/tools-builtin`（bash 工具）与 `@harness/permission`/`@harness/session`（无测试文件）失败为既有环境问题（终端 PATH 缺 `/bin` 导致 `spawn('bash')` ENOENT），与本次改动无关

### 文档

* [docs/agent-harness-architecture.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md) §10.4 由「后续增强（边界外）」更新为「双后端 + 存储治理（✅ 已实现）」，4 项 ☐ 全部改为 ✅

## 2026-08-24（续 4）：CLI /revert 命令（文件快照回滚交互）

### 接入 `@harness/cli`（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

实现 §10.3 第 5 条：CLI `/revert` 命令闭环（capture 挂消息 → stage 回滚 → clear/commit）：

* `HarnessAppOptions` 新增 `snapshot?: boolean`（默认 false）：开启时创建 `SnapshotService`（基于 resolve 后的 cwd）注入 `createHarness.snapshot`（自动挂载 meta.snapshot），并启用 `/revert` 命令

* `/revert` 子命令：`stage <messageID>`（回滚 + 逐文件 diff 展示，patch 截断 400 字符）/ `clear`（撤销）/ `commit`（接受）/ `status` / `help`；未启用快照时提示；异常经 try/catch 打印"回滚失败"不崩溃

* `/help` 列表新增 `/revert`；`REPL_COMMANDS` 注册

* cli 新增依赖 `@harness/snapshot`、`@harness/revert`

* 测试：cli 新增 6 用例（未启用提示 / help / status / stage 错误路径 / 未知子命令 / help 列表），27 用例全绿；全仓 typecheck 通过

## 2026-08-24（续 3）：core 自动 capture 挂载（AgentRuntimeImpl.query / queryStream）

### 接入 `@harness/core`（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

实现 §10.3 第 1 条：AgentRuntime 每轮自动快照并挂载到消息：

* `AgentHarnessOptions` 新增可选 `snapshot?: () => SnapshotService`（@harness/snapshot 工厂），`createHarness` 透传给 `AgentRuntimeImpl`

* `AgentRuntimeImpl` 新增 `captureForMessage(sessionId)`：每轮 LLM 调用后、工具执行前 `capture()`，`files` = 相对上一轮快照的变更文件（按 sessionId 维护 `lastSnapshots`，首轮为空）；capture 失败 best-effort（返回 undefined 不中断推理）

* `query()` / `queryStream()` 生成的 assistant 消息挂 `meta.snapshot = { start, files }`（对齐 OpenCode `message.snapshot`），供 `@harness/revert` 的 `collectSnapshotMap` 收集回滚目标

* 未注入 snapshot 工厂则不启用（向后兼容，现有调用不受影响）

* core 新增依赖 `@harness/snapshot`（workspace:\*）

* 测试：core 新增 5 用例（query/queryStream 挂载、第二轮 files 计算、未注入不挂载、capture 失败 best-effort），27 用例全绿；全仓 typecheck 通过

## 2026-08-24（续 2）：Revert 三态 + Bus 事件（`@harness/revert`）

### 新包 `@harness/revert`（[packages/revert](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/revert/src/index.ts)）

实现 §10.3 会话级文件回滚三态（对齐 OpenCode `SessionRevert.stage/clear/commit`）：

* **`SessionRevert.stage({ sessionId, messageID, snapshotMap? })`**：定位边界消息 → `collectSnapshotMap` 收集其后 assistant 消息的快照引用（或显式 `snapshotMap`）→ `SnapshotService.restore` 选择性回滚 → `diff(original → 回滚后)` 生成回滚 diff → 保存 `session.meta.revert`（RevertState）→ 发布 `snapshot.revert.staged`；重复 stage 沿用首次 original

* **`clear(sessionId)`**：按 RevertState 恢复回滚前原始快照（撤销回滚）→ 发布 `snapshot.revert.cleared`；**`commit(sessionId)`**：接受回滚 → 清除状态 → 发布 `snapshot.revert.committed`

* **消息快照引用约定**（对齐 OpenCode `message.snapshot`）：`message.meta.snapshot = { start, files }`，提供 `attachSnapshotToMessage()` / `collectSnapshotMap()` 辅助

* **Bus 事件**：`RevertEvents.staged/cleared/committed`（域 `snapshot.revert.*`）

* 自定义错误 `RevertError(operation, message, cause)`

* 测试：10 用例全绿（stage 回滚 + 事件 / snapshotMap 覆盖 / 错误路径 / clear 撤销 / commit 接受 / 重复 stage 沿用 original / 挂载与收集辅助）；typecheck 通过

* ✅ 已实现（core 集成，见续 76）：AgentRuntime query 开始时自动 capture + attachSnapshotToMessage——cli 注入 `snapshotService` factory（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1305)），core `captureForMessage()` 在 query/queryStream 主循环开始时 capture 并把 `meta.snapshot` 挂到 assistant 消息，`core.test.ts` 覆盖。

## 2026-08-24（续）：Snapshot 调研 + `@harness/snapshot` 包骨架

### 调研：OpenCode / Claude Code 快照与回滚方案

* `reference/` 更新：新增 `opencode-dev/`（OpenCode **完整真实源码 v2**），`claude-code-analysis-main` 补充《快照与回滚.md / 快照与回滚2.md》深度分析文档

* **OpenCode v2**（`packages/core/snapshot.ts` + `git.ts`）：独立 git 仓库 + `git write-tree` 内容寻址；`capture`（diff-files + ls-files → add --sparse → write-tree）、`preview`（临时 GIT\_INDEX\_FILE 零副作用）、`restore`（ls-tree 判定 → checkout / rm）、`checkout`（read-tree + checkout-index）；消息内嵌 `snapshot.start`，`SessionRevert.stage/clear/commit` 三态

* **Claude Code**（fileHistory.ts）：文件副本方案，`{sha256_16}@v{n}` 备份 + 快照链（上限 100）；编辑前 trackEdit + 回合结束 makeSnapshot；三级变更检测（stat/mtime/内容）；`fileHistoryRewind` → applySnapshot（unlink/restoreBackup/skip 幂等）

* **结论**：本项目采用 OpenCode git tree 方案（去重、复用 git 语义、可预览），Claude Code 文件副本保留为非 git fallback

### 新包 `@harness/snapshot`（[packages/snapshot](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/snapshot/src/index.ts)）

* `SnapshotService`：`capture / files / diff / preview / restore / checkout`，快照仓库 `~/.harness/snapshots/{worktree-hash}`（独立于用户 .git）

* `GitRepo`（--git-dir/--work-tree 显式指定）+ `KeyedMutex`（按仓库串行化写操作）+ `SnapshotError`

* 安全边界：restore 路径逃逸校验；>2MB untracked 跳过；capture best-effort

* 踩坑修复：① diff/preview 内嵌套调用同 key 互斥锁 → 死锁超时，抽取 `filesUnlocked`/`diffUnlocked`；② preview 未刷新 index → 基准树过期，先 `refresh('.')` 再 write-tree

* 测试：11 用例全部通过（hash 稳定性 / files / diff / restore / checkout / preview 零副作用 / 大文件跳过 / disabled），typecheck 通过

### 文档

* [docs/agent-harness-architecture.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md) 新增 §10「文件历史与回滚」（选型对比 / 包设计 / 集成路线 / 后续增强）

## 2026-08-24：Subagent 后台展示层完善 + Coordinator 插件

### 今日完成

#### 1. P0-1/P0-2：Prompt 决策指导 + Agent 级后台声明

* `SubagentTool` 描述增强：前台/后台决策规则 + "Don't sleep/poll/peek" 反模式；清理 `task_status` 工具残留文案

* `AgentDefinition` 新增 `background?: boolean`（[packages/agent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/agent/src/index.ts)），`agentFromMarkdown` 支持 frontmatter 解析；后台判定并入 `agentDef.background`

#### 2. P1-4：前端事件驱动展示

* `@harness/subagent` 新增 UI 无关 `BackgroundTaskMonitor`（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）：订阅 subagent.started/completed/failed 维护任务快照

* `@harness/cli` 新增 `attachBackgroundTaskPanel`（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：任务状态实时打印，`startRepl` 自动挂载

#### 3. P1-5：进度推送

* 新增 `subagent.progress` Bus 事件（toolName/toolStatus/summary/timestamp）

* 后台执行改用 `agent.queryStream` 遍历工具调用事件发布进度；Monitor 任务视图新增 `progress[]`；CLI 面板增量打印

#### 4. Coordinator 插件（新包 `@harness/coordinator`）

**新包**：[packages/plugins/coordinator](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)，`dependsOn: ['subagent']`，把主 Agent 变成 orchestrator：

* **Coordinator 身份**：`AgentDefinition.mode === 'coordinator'` 时通过 `prompt.system.transform` 注入 `COORDINATOR_SYSTEM_PROMPT`（四阶段 Research→Synthesis→Implementation→Verification + 派工规则 + 反模式）

* **Barrier 自动集齐**：`CoordinatorBarrierTracker` 跟踪 per-session 后台任务，全部完成/失败后发布 `coordinator.barrier.completed` 事件；CLI `attachAutoContinue` 订阅后注入 `<continue/>` 自动触发下一轮 query（解决"多调研→等齐→自动汇总"）

* **forceAsync**：插件选项或 `HARNESS_FORCE_ASYNC=true`，`tool.pre.execute` 拦截 subagent 调用强制后台化（原 P2-6）

* **send\_message 工具**：续跑已有 taskId（延续 worker 会话上下文），仅注入 mode=coordinator 的 Agent；running 中拒绝、TASK\_NOT\_FOUND 兜底

#### 5. 测试

* coordinator 14 用例：BarrierTracker 单测 / send\_message / prompt 注入 / forceAsync / 事件发布

* cli 新增自动续轮 attachAutoContinue 2 用例；全仓 typecheck 通过

## 2026-08-23（续 6）：Subagent run\_in\_background + 并行执行

### 今日完成

为 Subagent 插件添加后台异步执行和并行子 Agent 调度能力，让主 Agent 能派出多个子 Agent 同时执行任务，提升复杂任务的并行吞吐。参考 Claude Code 的 `forkSubagent.ts` + `LocalAgentTask` 和 OpenCode 的异步任务模型。

#### 1. BackgroundTaskRegistry — 后台任务生命周期管理

**新增类** **`BackgroundTaskRegistry`**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

* 状态机：`pending → running → completed | failed`（每状态对应时间戳 `createdAt` / `startedAt` / `completedAt`）

* `register(input)`：分配 `task-{时间戳36进制}-{计数36进制}` 形式 taskId，状态初始为 `pending`

* `start(taskId)`：切换为 `running`，记录 `startedAt`

* `complete(taskId, result)`：切换为 `completed`，若未显式传 `durationMs` 则用 `completedAt - startedAt` 自动计算

* `fail(taskId, error)`：切换为 `failed`，记录 `errorCode` / `errorMessage`

* `wait(taskId, timeoutMs)`：阻塞等待任务结束，内部用 `resolvers` 队列 + `AbortController` 实现超时，已完成任务立即返回

* `list(filter?)`：支持按 `status` 和 `parentSessionId` 过滤

* `cancel(taskId)`：触发 `AbortController.abort()`，返回是否取消成功

* `clear(filter?)`：清理已完成/失败任务

#### 2. SubagentTool — runInBackground 模式

**`SubagentTool`** **扩展** **`runInBackground`** **参数**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

* 输入 schema 新增 `runInBackground?: boolean`（默认 false，保持同步调用语义）

* `runInBackground=true` 时：

  1. `registry.register()` 注册任务 → 返回 taskId
  2. `registry.start(taskId)` 切换 running
  3. `void (async () => { ... })()` 异步执行子 Agent query，主 Agent 不阻塞
  4. 完成后 `registry.complete/fail(taskId, ...)` 更新状态
  5. 立即返回 `{ ok: true, output: { sessionId, taskId, background: true, message: '后台任务已启动...' } }`

* 异步块内复用同步路径的完整逻辑：超时控制（AbortController + 120s 默认）、工具调用摘要、临时文件输出、Bus 事件发布

* Bus 事件（`subagent.started/completed/failed`）新增 `taskId` 和 `background` 字段，支持后台任务跟踪

#### 3. TaskStatusTool — 后台任务查询

**新增工具** **`task_status`**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

* 输入：`{ taskId: string, wait?: boolean, timeoutMs?: number }`

* `wait=false`（默认）：立即返回任务当前状态（pending/running/completed/failed）

* `wait=true`：阻塞等待任务结束或超时（默认 30s），底层调用 `registry.wait(taskId, timeoutMs)`

* 错误码：`TASK_NOT_FOUND`（taskId 不存在）、`REGISTRY_NOT_READY`（registry 未初始化）、`TASK_WAIT_TIMEOUT`（等待超时）

* `isReadOnly: true`（查询操作不影响状态）

#### 4. /tasks CLI 命令

**新增** **`/tasks`** **命令**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

* 用法：`/tasks [running|completed|failed]`

* 无参数：列出所有后台任务（最多显示 50 条）

* 带状态参数：按状态过滤

* 每条任务显示：taskId、agentId、agentName、status、durationMs、prompt 预览（前 60 字符）

* 无子 Agent 配置时也注册此命令（只要有 harness 引用）

#### 5. 并行子 Agent 执行

`runInBackground=true` 的并行性由异步执行块 `void (async () => {})()` 保证，**不依赖** **`partitionToolCalls`**。

* `SubagentTool.isConcurrencySafe` 保持 `() => false`：子 Agent 可能修改共享状态（如文件），即使后台模式也不做并行调度承诺

* `partitionToolCalls` 会将多个 subagent 调用分到各自的串行批次，但每个批次只是注册任务 + 启动异步块 + 立即返回 taskId，几乎不耗时

* 真正的子 Agent 执行在各自异步块中并行运行，不受 `partitionToolCalls` 影响

* 多个写操作 Agent 操作同一文件的冲突由 agent 配置/worktree 隔离负责，不在工具调度层解决

#### 6. 测试

**@harness/subagent 新增 2 个测试套件共 17 个用例**（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts)）

* `BackgroundTaskRegistry`（8 用例）：register/start/complete/fail/wait/list/cancel/clear 全链路 + 并发任务独立性

* `SubagentTool runInBackground`（9 用例）：立即返回 taskId、子 Agent 失败时状态变 failed、TaskStatusTool 查询/等待/超时/不存在/无 registry、并行 3 个 background subagent 独立完成

* 更新 4 个已有测试断言：`tool.pool.assemble` 注入 2 工具、`/subagents` 注册 2 命令、无子 Agent 时仍注册 `/tasks`、`uninstall` 后 2 工具均不可用

#### 7. 验证

* `@harness/subagent` 单元测试：83 pass / 0 fail（272 assertions）

* 全量 typecheck：22 个包全部通过

* 无回归：原有 66 个测试保持通过

## 2026-08-23（续 5）：Skill / Agent 多级加载修复

### 今日完成

修复 Skill Layer 和 Agent 加载中"承诺多级、实际只有 project 一级"的问题，落地 user 级 + project 级两层加载，实现 project 覆盖 user 的优先级策略。

#### 问题回顾

Skill 代码注释宣称三来源合并（bundled/user/project/mcp）+ 优先级覆盖，实际实现：

* `SkillManagerImpl.load(dir)` 把目录路径硬编码为 `source: 'project'`

* CLI 只配置 `skillDirs: ['.harness/skills']` 单一目录

* core 遍历 skillDirs 不区分来源

Agent 加载存在同样问题：CLI 只配置 `agentDirs: ['.harness/agents']` 单一目录。

#### 1. 模块修复

**@harness/skill —** **`load()`** **接口增加 sourceTag 参数**（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）

* 接口签名：`load(source: SkillSource | string, sourceTag?: SkillSource = 'project')`

* 当 `source` 为目录路径时，用 `sourceTag` 标记来源（user/project/mcp）

* `skillFromMarkdown` 调用时传入 tag，MCP 来源强制 `allowEmbedShell=false`

* 同 ID 后加载覆盖先加载（map.set 覆盖语义）

* 注释更新：MCP 来源建议通过 register() 注册从 MCP Server 拉取的 Skill

**@harness/core —** **`skillDirs`** **/** **`agentDirs`** **接口扩展**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

* `skillDirs?: Array<string | { dir: string; source?: SkillSource }>`（兼容字符串和对象形式）

* `agentDirs?: Array<string | { dir: string; source?: 'user' | 'project' }>`（同上）

* Skill 加载逻辑（init() 中）：从 entry 提取 `dirPath` + `sourceTag`，调用 `this.skillManager.load(resolvedDir, sourceTag)`

* Agent 加载逻辑（构造函数中）：从 entry 提取 `dirPath`，按数组顺序遍历（同 ID 后加载覆盖先加载）

* 顶部 import 补 `type SkillSource`

**@harness/cli — 默认配置两级加载**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

* `agentDirs: [{ dir: '~/.harness/agents', source: 'user' }, '.harness/agents']`

* `skillDirs: [{ dir: '~/.harness/skills', source: 'user' }, '.harness/skills']`

* user 在前、project 在后，project 覆盖 user

#### 2. 测试

**@harness/skill 新增 3 个测试用例**（[packages/skill/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.test.ts)）

* `多级加载：user → project 顺序，project 覆盖 user（同 ID 后加载覆盖先加载）`：同 ID 在 user/project 两级目录分别定义，验证 `loadedFrom === 'project'` 且 content 是 project 版本

* `sourceTag 缺省为 project`：调用 `mgr.load(tmpDir)` 不传 sourceTag，验证 `loadedFrom === 'project'`

* `sourceTag: user 不影响 allowEmbedShell（默认 true）`：验证 user 来源不被强制禁用 shell embed（只有 mcp 来源才强制禁用）

#### 3. 验证

* @harness/skill：21/21 测试通过（67 assertions）

* @harness/core：22/22 测试通过（86 assertions）

* @harness/cli：16/16 测试通过（52 assertions）

* 全部 22 个包 typecheck 通过，无回归

#### 4. 设计决策

* **API 兼容性**：`skillDirs`/`agentDirs` 同时支持字符串和 `{dir, source}` 对象形式，旧用法（字符串数组）默认按 project 处理

* **多级覆盖靠加载顺序**：core 按数组顺序遍历，user 目录在前、project 目录在后，依赖 `register()`/`skills.set()` 的覆盖语义，不需要显式优先级比较

* **MCP 来源不走文件目录**：MCP 来源的 Skill 一般从 MCP Server 拉取，建议通过插件用 `register()` 注册

* **Agent 不加 loadedFrom 字段**：Agent 没有来源相关的安全策略差异（不像 Skill 有 `allowEmbedShell` 安全切断），多级覆盖靠加载顺序保证即可

***

## 2026-08-23（续 4）：Skill Layer 实现

### 今日完成

实现双轨制 Skill Layer：Skill = 知识（Markdown 正文）+ Tool = 功能（代码执行），支持从文件系统加载 Markdown 格式的 Skill 定义，通过 paths 条件触发和 Agent 白名单控制注入到 system prompt。

#### 1. 模块开发

**@harness/skill — 双轨技能系统**（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）

新建包，实现完整 Skill 系统：

* **Skill 接口**：id / name / description / loadedFrom / paths / userInvocable / agentBind / content / embeds / allowEmbedShell / allowedTools / model / effort

* **SkillSource 类型**：`bundled` | `user` | `project` | `mcp`（MCP 来源强制 `allowEmbedShell=false`，防 RCE）

* **SkillManager 接口**：`all() / get(id) / load(source) / matchByPath(path) / filterByAgent(agentId) / reload(id)`

* **SkillManagerImpl 实现**：

  * `load(dir)` 支持两种目录结构：`skills/skill-name/SKILL.md`（目录形式，Claude Code 风格）和 `skills/skill-name.md`（单文件形式）

  * `matchByPath(filePath)` 遍历所有 Skill，检查 paths glob 匹配

  * `filterByAgent(agentId)` 按 agentBind 过滤可用技能

  * `reload(id)` 从原始来源目录热重载

  * 同 ID 优先级：project > user > bundled > mcp（后加载覆盖先加载）

* **skillFromMarkdown** 解析函数：

  * 解析 frontmatter（简化 YAML 解析器，无外部依赖）+ body

  * `id` 优先取 `frontmatter.id`，最后 `fallbackId`（目录名）

  * `name` 优先取 `frontmatter.name`，最后 `fallbackId`

  * 提取内嵌资源：`!\`cmd\` ` → shell embed，`{{var}}\` → variable embed

  * MCP 来源强制 `allowEmbedShell=false`

* **formatSkillForPrompt** 格式化函数：`# Skill: ${name}` + `> ${description}` + Markdown 正文

**@harness/core — SkillManager 集成 + 注入 Hook**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

* `HarnessOptions` 新增 `skillDirs?: string[]` 配置项

* `HarnessImpl` 新增 `skillManager?: SkillManager` 字段（构造函数中实例化，避免构造函数 await）

* `init()` 方法中：

  1. 从 `skillDirs` 异步加载 SKILL.md（构造函数不能 await，延迟到 init）
  2. 仅当有 Skill 加载成功时才注册 `core.skill-injection` 插件（避免空 Hook）
  3. 插件实现 `prompt.system.transform` Hook：读取 `agent.skills` 白名单，注入对应 Skill 到 system prompt

* 新增 `core.skill-injection` 内置插件：`id: 'core.skill-injection'`，`version: '0.1.0'`，install() 返回 Hooks

**@harness/cli — 默认配置 skillDirs**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

* `createHarness` 调用默认配置 `skillDirs: ['.harness/skills']`，支持从项目目录加载 Skill

#### 2. 测试

**@harness/skill 单元测试**（[packages/skill/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.test.ts)）

18 个测试用例，62 个断言，全部通过：

* `skillFromMarkdown`：完整 frontmatter + body、无 name 用 fallbackId、无 frontmatter 用默认值、MCP 来源强制禁用 shell embed、非 MCP 来源默认允许、userInvocable: false、agentBind 绑定、内嵌资源提取

* `SkillManagerImpl`：register+get+all、filterByAgent（无/有 agentBind）、matchByPath glob 匹配、load 目录形式、load 单文件形式、load 不存在目录、reload 热重载

* `formatSkillForPrompt`：带描述格式化、无描述省略描述行

#### 3. 关键设计决策

* **双轨制**：Skill = 知识（Markdown），Tool = 功能（代码执行），分离关注点

* **三来源合并**：bundled / user / project / mcp，同 ID 后加载覆盖先加载

* **MCP 安全切断**：MCP 来源强制 `allowEmbedShell=false`，防 RCE（同 Claude Code 安全策略）

* **paths 条件触发**：glob 匹配文件路径自动注入上下文（参考 Claude Code loadSkillsDir）

* **Agent 白名单**：`agent.skills` 字段控制哪些 Skill 注入到该 Agent 的 system prompt

* **id 与 name 分离**：id 来自目录名或显式 `frontmatter.id`，name 是显示名（与 Claude Code 一致）

#### 4. 验证

* @harness/skill：18/18 测试通过（62 assertions）

* @harness/core：22/22 测试通过（86 assertions）

* @harness/agent：19/19 测试通过（42 assertions）

* 全部 22 个包 typecheck 通过，无回归

***

## 2026-08-23（续 3）：Subagent 工具调用摘要

### 今日完成

在 Subagent Bus 事件推送完成后，实现工具调用摘要功能：当子 Agent 最终回复过长时，自动截断文本 + 附加工具调用列表，避免上下文膨胀。

#### 1. 模块开发

**@harness/subagent — 工具调用摘要**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

新增 4 个 helper 函数 + 2 个输出字段 + 1 个配置项：

* `summarizeToolInput(toolId, input)` — 按 toolId 提取关键信息（read\_file→path, bash→command, glob→pattern, grep\_file→pattern, web\_fetch→url, 默认→第一个字符串值）

* `truncateStr(s, maxLen)` — 截断字符串加 `...` 后缀

* `countToolCalls(messages)` — 统计子 session 中所有 `type: 'tool'` part 数量

* `summarizeResult(messages, finalText, maxResultLength)` — 超过阈值时生成摘要 = 截断文本(500字) + 工具调用列表 + 截断提示

新增配置和字段：

* `SubagentPluginOptions.maxResultLength`（缺省 2000 字符）

* `SubagentToolOutput.summarized`（布尔，标记是否被摘要）

* `SubagentToolOutput.toolCallCount`（子 Agent 内部工具调用次数）

* `renderResult` 输出也包含 `summarized` 和 `toolCallCount`

摘要格式示例：

```
这是子 Agent 的前 500 字回复...

[工具调用摘要（3 次调用）]
- read_file: /src/foo.ts
- bash: npm test
- bash: false [错误]

[完整回复 3000 字符已截断为摘要]
```

#### 2. 测试

* 8 个新增单元测试（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts) 工具调用摘要测试块）

* 覆盖：短结果不摘要 / 长结果摘要+工具调用列表 / 错误工具标记 / maxResultLength 可配置 / 无工具调用仅截断文本 / renderResult 新字段 / summarizeToolInput 按类型提取 / bash 长命令截断到 80 字符

* **subagent 包：41 pass / 0 fail / 154 assertions**

* 全量 typecheck：22 个包全绿

## 2026-08-23（续 2）：Subagent 实时进度推送（Bus 事件）

### 今日完成

在 Subagent 基础插件（独立 session + 递归白名单 + description/model/sessionId/parentId）完成后，实现 Subagent Bus 事件推送功能，让父 Agent / CLI / TUI 能实时感知子 Agent 执行进度。

#### 1. 模块开发

**@harness/subagent — Bus 事件推送**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

定义 3 个类型安全的 Bus 事件（`SubagentEvents`）：

* `subagent.started` — 子 Agent 开始执行（agentId, agentName, subSessionId, parentSessionId, parentAgentId, parentMessageId, toolUseId, prompt, description, isContinuation, startedAt）

* `subagent.completed` — 子 Agent 完成（agentId, subSessionId, parentSessionId, toolUseId, replyPreview, messageCount, durationMs）

* `subagent.failed` — 子 Agent 失败（agentId?, subSessionId?, parentSessionId, toolUseId, code, message, durationMs）

关键设计：

* `HarnessLike` 接口扩展 `bus?: Bus`，在 `harness.start` hook 中自动获取（`HarnessImpl.bus` 是 public 字段）

* `call()` 方法在 6 个关键节点发布事件：HARNESS\_NOT\_READY / AGENT\_NOT\_FOUND / INVALID\_AGENT\_MODE / SESSION\_NOT\_FOUND / SESSION\_CREATE\_FAILED / SUBAGENT\_FAILED → `failed`；session 创建后 → `started`；成功 → `completed`

* `publishFailed` 闭包封装避免重复代码，`bus.publish().catch()` 确保事件发布失败不影响主流程

* 长 prompt 截断到 500 字符，长 reply 截断到 200 字符（均加 `...` 后缀）

* 增强 harness 健壮性检查：`!harness || !harness.agent || !harness.session` 统一返回 HARNESS\_NOT\_READY

#### 2. 测试

* 10 个新增单元测试（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts) Bus 事件测试块）

* 覆盖：成功执行 started+completed / 续接 session isContinuation=true / Agent 未注册 failed / Harness 未就绪 failed / 超时 started+failed / 无 bus 正常工作 / 长 reply 截断 / 长 prompt 截断 / SUBAGENT\_FAILED 含 subSessionId

* **subagent 包：33 pass / 0 fail / 122 assertions**

* 全量 typecheck：22 个包全绿

## 2026-08-22（续）：会话管理增强 + CLI 扩展 + MCP Client 插件

### 今日完成

在 Phase 4 会话 Compaction 之后，连续推进三项 P1/P2 交付：会话管理增强（标题/搜索/导出）、插件化 CLI 命令扩展（`cli.commands` / `cli.command` Hook）、MCP Client 插件（stdio + HTTP/SSE transport + resources/prompts 发现 + Bearer 鉴权）。**18 个包 typecheck 全绿，43 个新增单元测试全通过（@harness/mcp-client 34 + core/cli 新增 9）**。

#### 1. 模块开发

| # | 提交        | 模块 / 变更                                      | 能力                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 测试数 |
| - | --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1 | `33974b1` | `@harness/core` `DefaultSessionManager` 会话增强 | ① `generateTitle()`：规则化标题生成（首条用户消息前 60 字符 + 工具调用密度提示 + 长文本截断标记）② `search(keyword)`：关键词检索（标题 + 消息文本 + 工具名 + 工具输入）③ `exportMarkdown(sessionId)`：渲染完整对话为 Markdown（系统记忆 + 用户/助手轮次 + 工具调用 codeblock + 元数据尾部）                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 6   |
| 2 | `33974b1` | `@harness/cli` 新增斜杠命令                        | `/search <keyword>` 调用 `session.search` 列出匹配会话；`/export [path]` 导出当前会话 Markdown 到文件或 stdout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —   |
| 3 | `195c12f` | `@harness/plugin` Hooks 扩展                   | 新增 `cli.commands(input)` Hook（插件注册可用斜杠命令到 `/help`）+ `cli.command(input)` Hook（插件处理自定义斜杠命令，可输出文本、控制 result: continue/exit）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 3   |
| 4 | `195c12f` | `@harness/cli` 插件命令分发                        | REPL 解析未知 `/xxx` 时依次调用插件的 `cli.command` Hook；`/help` 列出插件注册的命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —   |
| 5 | `82acf8e` | `@harness/mcp-client`（新包 v0.1.0）             | MCP Client 插件首版：`McpClient`（JSON-RPC 2.0 over stdio，initialize/tools/list/tools/call）、`StdioTransport`（spawn 子进程 + 行分隔 JSON 收发）、`convertMcpToolToHarnessTool`（MCP 工具 → Harness Tool，Fail-Closed 默认值）、`createMcpClientPlugin`（harness.start 连接 + tool.pool.assemble 注入 + `/mcp` CLI 命令）                                                                                                                                                                                                                                                                                                                                                                   | 9   |
| 6 | `139c00c` | `@harness/mcp-client` v0.2.0 增强              | ① `HttpTransport`：Streamable HTTP（MCP 2025-03-26），POST JSON-RPC，响应支持 JSON / SSE 流，自动缓存并回传 `Mcp-Session-Id` ② `SseTransport`：旧版 HTTP+SSE，GET 建立 SSE 流接收 `endpoint` 事件，POST 到该端点 ③ `defaultTransportFactory`：根据 `config.transport` 选择 ④ `McpClient` 扩展：缓存 `serverCapabilities`/`serverInfo`/`protocolVersion`；新增 `listResources`/`readResource`/`subscribeResource`/`listPrompts`/`getPrompt`；`onNotification` 接收 `resources/listChanged` 等通知 ⑤ `McpAuthConfig`：bearerToken / authorizationHeader / 自定义 headers ⑥ `/mcp` 子命令扩展：servers/tools/resources/read \<uri>/prompts/prompt \<name> ⑦ `autoInjectResources`：可选把资源 text 注入到 `prompt.system.transform` | 25  |

#### 2. 关键技术决策

* **标题生成不依赖 LLM**：规则化提取首条用户消息前 60 字符 + 工具调用密度提示，可离线、可重复、无费用，作为默认策略。后续可通过 hook 注入 LLM 生成版本。

* **搜索覆盖多维度**：标题 + 消息文本 + 工具名 + 工具输入四维匹配，单条命中即返回，避免漏检。

* **Markdown 导出格式约定**：系统记忆 → 用户/助手轮次（含工具调用 codeblock）→ 元数据尾部（会话 ID、消息数、压缩统计），可直接作为文档归档。

* **CLI 扩展用 Hook 而非硬编码**：插件通过 `cli.commands` 声明命令、`cli.command` 处理命令，CLI 层只做分发，保持开放-封闭原则。

* **MCP Transport 三态抽象**：`McpTransport` 接口统一 stdio/http/sse 三种传输，`send` 返回 `void | Promise<void>` 兼容同步/异步 transport；`defaultTransportFactory` 根据配置字段选择，缺省按 command/url 推断。

* **capabilities 驱动的方法可用性**：`McpClient.listTools/listResources/listPrompts` 先检查 `serverCapabilities` 对应字段，未声明时返回空数组（不调用 server），避免无效请求。

* **Bearer 鉴权分层**：`authorizationHeader` 优先级高于 `bearerToken`，便于用户直接传入完整 Authorization 头（如 OAuth2 流程外层拿到的 token）。

* **autoInjectResources 可选注入**：默认不注入资源到 system prompt（避免污染上下文），通过 `'all'` 或 `string[]` 策略显式启用，注入通过 `prompt.system.transform` hook 完成。

* **OAuth2 PKCE 暂不实现**：完整 OAuth2 授权码 + PKCE 流程需要独立 OAuth client 模块和回调服务器，复杂度高且与 MCP 协议本身解耦。当前提供静态 Bearer Token 注入，足以对接大多数 MCP Server。

#### 3. 遇到的问题与修复

| 问题                                              | 原因                                                                             | 修复                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 标题生成测试"长文本截断"用例失败                               | 测试用例文本长度不足 60 字符                                                               | 扩展测试用例文本长度，确保超过 60 字符触发截断逻辑                           |
| `cli.command` Hook 测试 `cliInput` 类型错误           | 缺少 `result` 可选属性                                                               | 显式定义 `cliInput` 类型，包含 `result?: 'continue' \| 'exit'` |
| MCP Client 旧测试 `listTools` 返回空                  | 扩展后 `listTools` 依赖 `capabilities.tools`，旧测试 mock initialize 响应未声明 capabilities | 补充 mock 响应 `capabilities: { tools: {} }`              |
| MCP Client `listPrompts` 请求悬挂超时                 | autoInject 测试 mock 未注册 `prompts/list`，但 capabilities 声明了 prompts               | 补注册 `prompts/list` 返回空数组                              |
| `defaultTransportFactory` stdio 测试 spawn ENOENT | 受限测试环境 PATH 缺 `/bin`，`echo` 找不到                                                | 改用绝对路径 `/bin/echo`                                    |
| HTTP transport SSE 流解析遗漏最后一段                    | `lastIndexOf('\n\n')` 未 flush 残留 buffer                                        | 循环结束后补 flush `buf + '\n\n'`                           |

#### 4. 代码统计

```
18 个 packages / typecheck 全绿 / 新增 43 个测试
当前 MCP Client 能力：
  - stdio transport（子进程 JSON-RPC）
  - http transport（Streamable HTTP，JSON/SSE 响应，Mcp-Session-Id 会话）
  - sse transport（旧版 HTTP+SSE，endpoint 事件）
  - resources/list + resources/read + subscribe
  - prompts/list + prompts/get
  - Bearer Token 鉴权
  - /mcp 子命令：servers / tools / resources / read / prompts / prompt
  - autoInjectResources 注入 system prompt
对外 API：
  - createMcpClientPlugin({ servers, transportFactory?, autoInjectResources? })
  - McpClient.connect/listTools/callTool/listResources/readResource/listPrompts/getPrompt
  - defaultTransportFactory(config)
```

***

## 2026-08-23：会话 Compaction（三级压缩 + 系统记忆注入）

### 今日完成

完成 Phase 4 的会话压缩能力：三种压缩策略（prune / summary / agent）、按阈值自动触发 `compactIfNeeded`、压缩后摘要作为长期系统记忆注入到 Agent system prompt；CLI 暴露 `/compact` 斜杠命令、resume/repl/run 启动时自动 compactIfNeeded。

**17 个包 typecheck 全绿（0 error）；与 compaction 相关 4 个新增单元测试全部通过**。

#### 1. 模块开发

| # | 模块 / 变更                                               | 能力点                                                                                                                                                                                                                                                                                                                                                              | 测试数     | <br /> | <br />                                                                                      | <br /> |
| - | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | :----- | :------------------------------------------------------------------------------------------ | :----- |
| 1 | `@harness/session` Session.meta schema 扩展             | 导出 `CompactionMeta`（压缩统计：count/lastStrategy/totalPrunedMessages 等）+ `CompactMemory`（摘要文本+轮次+记忆起点）+ `COMPACT_META_KEY` / `COMPACT_MEMORY_KEY` 约定；扩展 `CompactOptions`（`strategy` / `thresholdTokens` / `keepRecentMessages` / `summaryMaxChars` / `tokensPerMessage`）；`SessionManager` 接口新增 `compact(…, options?)` / `compactIfNeeded(…)` / `getCompactionInfo(…)` | —       | <br /> | <br />                                                                                      | <br /> |
| 2 | `@harness/core` `DefaultSessionManager` compaction 实现 | 三级策略：`prune`（只截断、保留最近 K 条）/ `summary`（规则摘要：角色分布+首末用户要点+助手节选+工具调用统计，无需 LLM）/ `agent`（复用 AgentRuntime.query 生成摘要，缺失时自动 fallback 到 summary）；多轮合并：把"前一轮 CompactMemory.summaryText"作为上下文附加在新摘要前方，跨压缩轮次保留长期记忆；统计写入 `Session.meta`                                                                                                                                      | —       | <br /> | <br />                                                                                      | <br /> |
| 3 | `@harness/core` `AgentRuntimeImpl` 系统记忆注入             | 新增 `appendCompactionMemory()` helper，在构建 system prompt（`query()` 与流式 `buildContext()` 两处）时把压缩记忆作为独立 system part 追加（在 `prompt.system.transform` hook 之前，允许插件二次改写）                                                                                                                                                                                                 | —       | <br /> | <br />                                                                                      | <br /> |
| 4 | `@harness/cli` 命令 + 自动压缩                              | 新增 \`/compact \[prune                                                                                                                                                                                                                                                                                                                                            | summary | agent  | auto]`命令，打印压缩后 meta+memory 摘要；在`repl / resume / run`进入交互前调用一次`compactIfNeeded\`，命中阈值时提示压缩结果 | —      |
| 5 | `@harness/core` `core.test.ts` Session Compaction 测试块 | 4 个关键验证：① summary 策略长度+meta/memory 统计 ② prune 策略不产生新摘要 ③ compactIfNeeded 阈值触发/no-op ④ system prompt 注入 memory 片段包含压缩标题、轮次与摘要正文                                                                                                                                                                                                                                   | 4       | <br /> | <br />                                                                                      | <br /> |

#### 2. 关键技术决策

* **Compaction 不直接压缩 system prompt**：我们的 system prompt 在 AgentRuntime 内动态拼合 agent.promptFragments 与 compaction memory，不写入 session.messages。压缩算法只处理 session.messages（约定不含 system 消息），避免重复拼接。

* **多轮摘要累积而非覆盖**：新一轮压缩时把"旧 CompactMemory.summaryText"作为"更早记忆"段落加在新摘要前方，避免 LLM 丢失更早语义；同时 `round` 单调递增，system memory 注入时会展示轮次。

* **默认阈值（8000 tokens × 500/msg）偏保守**：`compactIfNeeded` 默认使用 8000 tokens 触发（估算 = `messages.length × tokensPerMessage`，默认每条 500），与 keepRecentMessages=6（最近 3 轮）保证短对话永远不触发。

* **agent 策略采用 fail-closed fallback**：`agent` 策略优先走 AgentRuntime.query 调 LLM 生成摘要；若缺少 ChatProvider/AgentRuntime 或调用出错，不抛异常给业务，静默回落到 ruleBasedSummary，保证 compaction 永远可用。

* **summary 策略做确定性、无 LLM 依赖**：规则摘要按"首末用户要点 + 助手节选 + 工具调用统计 + 前压缩轮次提示"组合，可离线、可重复、无费用，作为默认策略。

* **CompactOptions 设计为单源**：`compact()` 的第二参数 `strategy` 与第三参数 `options.strategy` 等价，`strategy` 显式参数优先，便于 CLI 直接传策略、也便于程序化代码通过 CompactOptions 调用。

#### 3. 遇到的问题与修复

| 问题                                                                                                                                    | 原因                                                                                          | 修复                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试最初 `h.session.update(id, fn)` 报错 `update` 不存在于 `SessionManager` 接口                                                                  | `@harness/session` 暴露的是细粒度的 `updateMessage / addMessage / updatePart`，没有整 session mutate 入口 | 改用 helper `fillMessages(h, sessionId, rounds)` 循环调用 `h.session.addMessage` 注入消息                                                                   |
| core typecheck：`SessionManager` import 类型中缺 `CompactOptions / CompactionMeta / CompactMemory / COMPACT_META_KEY / COMPACT_MEMORY_KEY` | 新增类型未同步进 import                                                                             | 在 `import type` 块补齐，并 `import { COMPACT_META_KEY as COMPACT_META_KEY_VAL, COMPACT_MEMORY_KEY as COMPACT_MEMORY_KEY_VAL }` 引入运行时常量，避免同文件类型/值混合引用问题 |
| 无 test 文件的包（permission/agent/skill/session）`bun test` 返回 exit code 1                                                                  | 这些包只有 `scripts.test="bun test"`，默认 bun 找不到 \*.test.ts 返回 1                                  | 暂不在本次修（属 monorepo 历史脚本问题，与 compaction 无关）；逐个包验证 core、cli、builtin/plugin 均 0 fail                                                                  |

#### 4. 代码统计

```
17 个 packages / typecheck 全绿 / 新增 compaction 单测 4 个 / 核心断言数：
  - 压缩长度：summary 20→6、prune 16→4
  - 统计：count=1 / lastMessagesBefore / totalPrunedMessages / round
  - 注入：system prompt 含"会话压缩记忆"与摘要前缀匹配
会话 compaction 能力对外 API：
  - SessionManager.compact(sessionId, strategy?, options?)
  - SessionManager.compactIfNeeded(sessionId, options?) => boolean
  - SessionManager.getCompactionInfo(sessionId) => { meta?, memory? }
CLI 斜杠命令：
  - /compact [prune|summary|agent]
  - /compact auto (或 ifneeded) = compactIfNeeded
```

***

## 2026-08-21：流式输出 + Provider 扩展 + 工具插件化拆分

### 今日完成

在 Phase 3 基础上完成三项交付：流式输出打通全链路、新增 OpenAI Provider、按"原语才内置"原则拆分工具包。**14 个包 typecheck 全绿，215 个单元测试全通过（595 断言）**。

#### 1. 模块开发

| # | 提交        | 模块 / 变更                          | 能力                                                                                                                                                                                                                                         | 测试数 |
| - | --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| 1 | `fb9c3ae` | `@harness/core` 流式输出             | `ChatStreamChunk` + `AgentStreamEvent` 类型；`ChatProvider.stream?()` 可选方法；`AgentRuntime.queryStream()` 边流式边处理工具调用；`SessionManager.promptStream()`；CLI REPL / `run` 子命令逐 token 打印                                                             | —   |
| 2 | `fb9c3ae` | `@harness/provider-anthropic` 流式 | `AnthropicChatProvider.stream()`：解析 SSE（`message_start` / `content_block_delta` / `message_delta`），yield `text_delta` / `tool_use_start` / `tool_use_delta` / `tool_use_stop` / `done`                                                     | 4   |
| 3 | `fb9c3ae` | `@harness/provider-mock` 流式      | `MockChatProvider.stream()`：逐 token 模拟输出，供无网络环境测试流式链路                                                                                                                                                                                      | —   |
| 4 | `ddc5db3` | `@harness/tools-builtin` 新增工具    | `list_dir`（目录列举：递归/隐藏文件/类型/大小）、`grep_file`（正则检索：glob 过滤/大小写/递归）、`edit_file`（精确替换：`oldString`→`newString`，`replaceAll`/多行/多重匹配校验）                                                                                                           | 16  |
| 5 | `4d39c29` | `@harness/provider-openai`（新包）   | OpenAI Chat Completions 对接：Bearer auth、Part→messages 序列化（`tool_calls` 数组 / `role:tool` 带 `tool_call_id` / `image_url` data: URI）、Tool Schema 导出、`complete()` 非流式 + `stream()` 流式（SSE `data:[DONE]` 终止、tool\_calls 按 index 累积 arguments 增量） | 17  |
| 6 | `e65543d` | 工具插件化拆分                          | `@harness/tools-builtin` 瘦身为 4 个原语（v0.3.0）；`list_dir`/`grep_file` 抽到新包 `@harness/tools-search`（v0.1.0，自包含 helper + `toolsSearchPlugin` 工厂）                                                                                                 | 14  |

#### 2. 关键技术决策

* **流式类型分层**：`ChatStreamChunk`（Provider 层，纯 LLM 输出）与 `AgentStreamEvent`（Agent 层，含工具执行结果）解耦，让 Provider 不感知工具执行

* **OpenAI 与 Anthropic 序列化差异**：Anthropic 用 `tool_use`/`tool_result` block；OpenAI 用 assistant.tool\_calls 数组 + 独立 `role:tool` 消息（带 `tool_call_id` 关联），两条序列化路径分别实现

* **工具流式增量累积**：OpenAI 的 `tool_calls` 按帧增量（首帧带 id+name，后续只带 arguments 片段），用 `Map<index, state>` 累积并按帧 yield `tool_use_delta`

* **"原语才内置"判定原则**：内置仅留不可替代、不可组合替代、非场景化的工具。`read_file`/`write_file`/`edit_file`/`bash` 是文件 I/O + Shell 原语；`list_dir`/`grep_file` 属搜索导航场景（`bash ls/grep` 可替代），抽为独立插件

* **插件包自包含**：`@harness/tools-search` 自带 `resolvePath`/`isWithinCwd`/`makeSchema`/`globMatch` helper，不反向依赖 `@harness/tools-builtin`，保持插件可独立装卸

* **配置三级来源一致**：OpenAI Provider 沿用 `直接传入 > ctx.config.get('provider.openai') > 环境变量 OPENAI_API_KEY/OPENAI_BASE_URL` 优先级，与 Anthropic Provider 对齐

#### 3. 遇到的问题与修复

| 问题                                                    | 原因                              | 修复                                                                                            |
| ----------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `new-tools.test.ts` 类型错误 `res.output` 可能 undefined    | 测试直接访问 `res.output.count` 未做空断言 | 统一加非空断言 `res.output!.count`（仅在 `res.ok===true` 分支）                                            |
| `ToolContext` 缺 `toolUseId` 字段                        | 测试 ctx 构造遗漏该必填字段                | 补 `toolUseId: 'tu1'`                                                                          |
| 旧测试断言 `builtinTools` 6 个工具                            | 拆分后 builtin 仅 4 个、search 2 个    | 更新断言为 `['bash','edit_file','read_file','write_file']`，search 包独立断言 `['grep_file','list_dir']` |
| Anthropic stream 测试 mock fetch 类型不匹配                  | mock 返回类型与全局 `fetch` 签名冲突       | mock 函数返回类型改 `any`                                                                            |
| 拆分后 `readdir`/`join`/`globMatch` 成为 tools-builtin 死代码 | 仅被迁出的 list\_dir/grep\_file 使用   | 清理 imports 与 helper，迁入 tools-search                                                           |

#### 4. 代码统计

```
14 个 packages / 215 个测试 / 595 个 expect（较 08-16 +6 包 +45 测试）
当前工具分布：
  - @harness/tools-builtin（v0.3.0）：read_file / write_file / bash / edit_file（4 原语）
  - @harness/tools-search（v0.1.0）：list_dir / grep_file（搜索类）
当前 Provider 分布：
  - @harness/provider-anthropic（complete + stream）
  - @harness/provider-openai（complete + stream）
  - @harness/provider-mock（complete + stream，测试用）
```

***

## 2026-08-22：工具插件化持续扩展（glob/web/media 三场景包）

### 今日完成

延续"原语内置，场景按插件接入"的拆分原则，新增三个场景工具包。**17 个包 typecheck 全绿，248 个单元测试全通过（690 断言，较 08-21 +33 测试）**。

#### 1. 模块开发

| # | 模块（新包）                        | 工具           | 核心能力                                                                                                                                                                                                                                                                                    | 测试数 |
| - | ----------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1 | `@harness/tools-glob` v0.1.0  | `glob`       | 多模式 `**` / `*` / `?` 通配符；`!` 取反 + `exclude` 便捷字段；隐藏文件默认跳过；文件大小 min/max 过滤；最大深度限制；结果上限截断；cwd 边界保护                                                                                                                                                                                        | 9   |
| 2 | `@harness/tools-web` v0.1.0   | `web_fetch`  | HTTP(S) 抓取，支持 GET/POST/PUT/PATCH/DELETE；自定义 headers / body（对象自动 JSON 序列化）；三种返回格式 `text` / `json` / `base64`（data: URI）；follow redirects / maxBytes 截断 / timeoutMs + AbortSignal；SSRF 防护（默认拦截 10.x / 172.16-31 / 192.168 / 127.x / fc/fd / localhost\*.local）；`allowPrivateNetwork` 显式放行 | 14  |
| 3 | `@harness/tools-media` v0.1.0 | `view_image` | 本地图片读取转 base64 data URI + 尺寸解析（PNG/JPEG/GIF/BMP/WebP 魔数识别，含 PNG/GIF/BMP 宽高、JPEG SOF0 段遍历）；maxBytes + strictSize 模式（过大报错 or 仅回元数据）；cwd 路径边界保护                                                                                                                                            | 10  |

三包均按 `tools-search` 模板统一：

* 自包含 helper（resolvePath / isWithinCwd / makeSchema / 场景专用 helper），不反向依赖 `tools-builtin`

* `defineTool` + Fail-Closed 安全声明（`isReadOnly`/`isDestructive`/`isConcurrencySafe`），`permission.key` 按场景分配（`read`/`network`）

* `createXxxPlugin({ toolIds })` 工厂 + 默认导出 `toolsXxxPlugin` 常量

* 通过 `tool.pool.assemble` Hook 注入 `ToolRegistry`

#### 2. 关键技术决策

* **三插件均** **`isConcurrencySafe=true`** **声明**：glob 纯读、web\_fetch 请求幂等、view\_image 只读，可并行执行（Fail-Closed 需显式声明）

* **web\_fetch 权限键用** **`network`（非** **`read`/`write`）**：网络访问是独立能力维度，与本地文件的读写权限体系分离，可被 permission 引擎单独管控

* **SSRF 默认 fail-closed，白名单开启**：私有 IP / localhost / .local / 169.254 link-local 全部拦截，仅当调用方显式 `allowPrivateNetwork=true` 才放行——与 fail-closed 哲学一致

* **view\_image 尺寸解析零依赖**：纯字节判断 PNG IHDR/JPEG SOF0/GIF6/7/BMP DIB 头，不引入 sharp/jimp 等本地图像库

* **已 abort signal 同步快速路径**：web\_fetch 在进入 await fetch 前同步检查 `inner.signal.aborted`，避免 mock fetch 不监听 signal 时悬挂

* **glob 正则按段构建**：`**` 段末尾位置写 `.*`（匹配任何内容到结尾）、非末尾写 `(?:.*/)?`（包含段间 `/`），其它段单独转义后拼接，避免双重 `/` 问题

#### 3. 遇到的问题与修复

| 问题                                                 | 原因                                                                          | 修复                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| glob `**/*.ts` 匹配空（递归、排除两个用例失败）                    | `globToRegex` 用 join('/') 把 `(?:.*/)?` 与下段之间插入了额外 `/`，导致必须存在 `/` 才能匹配（根层漏掉） | 改为按段逐段拼接：非末尾 `**` → `(?:.*/)?`（自带末尾 `/`）、非末尾普通段 → `escaped` + `/`                                                                             |
| `readFile(path, null, { length: 32 })` 三参数 TS 错误   | Node `fs/promises.readFile` 仅接受 `(path, options?)` 两参数，无 `length` 选项        | 改用 `open(path, 'r') → fh.read({ buffer, length: 32 }) → fh.close()` 三步                                                                        |
| `mkdirSync(join('src', { recursive: true }))` 类型错误 | 把 mkdirSync options 当 join 第三参数传入了（括号错位）                                    | 修正括号：`mkdirSync(join('src'), { recursive: true })`                                                                                            |
| `error.detail` TS 类型不匹配（`JSON_PARSE_ERROR` 中）      | Tool `ToolError` 结构仅 `{ message, code?, cause? }`，无 `detail`                | 把原始字节片段拼接到 `message` 字符串中，移除非法 `detail` 字段                                                                                                    |
| web\_fetch AbortSignal 测试 5s 超时挂死                  | 最初 mock fetch 返回永不 settle Promise，inner.signal abort 也无法让 hanging fetch 解挂  | 改写：1) 已 abort 用例改用"提前 abort signal + fetch 前同步检查快速失败"；2) timeout 用例 mock fetch 监听 init.signal 的 abort 事件，收到后 reject AbortError，settle Promise |

#### 4. 代码统计

```
17 个 packages / 248 个测试 / 690 个 expect（较 08-21 +3 包 +33 测试）

场景工具插件（按 tools-search 模板）：
  - @harness/tools-search   v0.1.0 list_dir / grep_file（搜索导航）
  - @harness/tools-glob     v0.1.0 glob（模式匹配）
  - @harness/tools-web      v0.1.0 web_fetch（网络抓取 + SSRF 防护）
  - @harness/tools-media    v0.1.0 view_image（多模态图像 base64 + 尺寸）
```

***

## 2026-08-16：Phase 1 \~ Phase 3 核心交付

### 今日完成

从架构设计到可运行的 CLI，一天内完成了 8 个模块的开发、测试与推送，共 **170 个单元测试全绿、12 个包 typecheck 0 error**。

#### 1. 架构设计

* 产出 [agent-harness-architecture.md](./agent-harness-architecture.md)

* 融合 Claude Code（6 层严格解耦 + Tool 运行时协议 + Fail-Closed 安全策略）与 OpenCode（Plugin Hooks 管道 + Bus 类型安全事件总线 + 4 级路径权限匹配）两者的优点

* 明确 4 阶段里程碑、12 项关键设计决策、与两个参考架构的 11 维对比

#### 2. 模块开发（按交付顺序）

| # | 模块                            | 能力                                                                                                                                            | 测试数 | PR |
| - | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --- | -- |
| 1 | `@harness/bus`                | 类型安全 Pub/Sub 事件总线：`BusEvent.define` + `InMemoryBus` + 全局订阅                                                                                    | 24  | #1 |
| 2 | `@harness/tool`               | Tool 协议（10+ 属性 + Fail-Closed）+ `ToolRegistry` 注册中心 + `ToolPipeline` 7 步生命周期 + 拓扑排序                                                            | 32  | #1 |
| 3 | `@harness/plugin`             | `PluginManager` 三级加载（Internal/Builtin/User）+ Kahn 拓扑排序 + 12 个 Hook 管道 + 热重载                                                                   | 32  | #1 |
| 4 | `@harness/core`               | `HarnessImpl` 生命周期编排 + 能力模块访问器（tools/agent/session/permission/bus/chat）+ `AgentRuntimeImpl` 主循环 + `DefaultToolPool` + `DefaultSessionManager` | 13  | #2 |
| 5 | `@harness/provider-mock`      | `MockChatProvider`：可配置默认响应 / 关键词匹配 / tool call 模拟 / 调用记录                                                                                      | 12  | #2 |
| 6 | `@harness/tools-builtin`      | `read_file` / `write_file` / `bash` 三个内置工具插件                                                                                                  | 32  | #3 |
| 7 | `@harness/provider-anthropic` | Anthropic Messages API 对接：Part→Block 序列化、Tool Schema 两级导出、fetch+超时+AbortSignal、配置三级来源                                                         | 12  | #4 |
| 8 | `@harness/cli`                | 命令行入口：REPL + 会话持久化 + 权限交互 + 多子命令（repl/run/resume/list-sessions）                                                                               | 13  | #5 |

#### 3. 关键技术决策

* **TypeScript + Bun**：原生 TS、零配置运行、fast test runner

* **Monorepo**：`packages/*` + `packages/plugins/*`，workspace 协议，tsconfig path mapping

* **Fail-Closed 安全策略**：所有新工具默认不可并发、非只读，需显式声明能力边界

* **Hooks 管道而非继承**：12 个 Hook 点（`harness.init` / `tool.pre.execute` / `permission.check` 等）让插件介入生命周期

* **Provider 自动 fallback**：CLI 检测到无 `ANTHROPIC_API_KEY` 时自动切到 Mock Provider 并打印提示

* **零外部依赖**：参数解析、glob 匹配、readline 交互全部内置实现，不引入 minimist / picomatch / inquirer

#### 4. 遇到的问题与修复

| 问题                                      | 原因                                    | 修复                                    |
| --------------------------------------- | ------------------------------------- | ------------------------------------- |
| Hook 触发顺序断言错误                           | Bad 插件先注册但 Good 插件 Hook 仍执行           | 修正测试断言，确认 Good 插件 Hook 未被执行           |
| logger 错误日志字符串不匹配                       | 实际日志带 `[plugin:X]` 前缀                 | 调整测试断言匹配实际日志                          |
| `loadBuiltin` 重复 ID 测试未注入 dynamicImport | 走到真实 Bun import 失败                    | 测试注入 custom dynamicImport 模拟加载        |
| `ToolRegistry` 重复注册 echo                | 第二次 query 重复注册工具                      | `DefaultToolPool.add/addAll` 已存在时静默跳过 |
| 多行命令测试失败                                | `echo "a\nb\nc"` 未正确解释换行              | 改用 `printf "a\nb\nc\n" \| grep b`     |
| `tool_result` block 多余 `is_error` 字段    | Anthropic API 不接受非错误时的 `is_error`     | 仅 `isError=true` 时写入 `is_error`       |
| CLI 短选项 `-s=foo` 解析失败                   | 未处理短选项 `=` 形式                         | 重写 parseCliArgs 短选项分支                 |
| 权限永久 allow/deny 判断失效                    | `toLowerCase()` 把大写 A/D 变成 a/d 命中单次分支 | 先判断永久（`answer === 'A'`），再判断单次         |

#### 5. 代码统计

```
8 个 packages / 12 个 tsconfig / 170 个测试 / 449 个 expect
5 个 Draft PR（#1 ~ #5）
```

***

### 下一步计划

#### Phase 4：实用化与扩展

| 优先级        | 方向                             | 说明                                                               | 状态                                                                   |
| ---------- | ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| **~~P0~~** | ~~更多内置工具~~                     | ~~`list_dir`~~ ~~/~~ ~~`grep_file`~~ ~~/~~ ~~`edit_file`~~       | ✅ 完成（08-21，edit\_file 留 builtin，list\_dir/grep\_file 抽 tools-search） |
| **~~P0~~** | ~~流式输出~~                       | ~~Provider~~ ~~`stream: true`~~ ~~+ REPL 逐 token~~               | ✅ 完成（08-21，core/anthropic/mock 三端 stream）                            |
| **~~P1~~** | ~~`@harness/provider-openai`~~ | ~~GPT-4o 适配，统一 ChatProvider~~                                    | ✅ 完成（08-21，complete + stream）                                        |
| **~~P0~~** | ~~工具持续插件化~~                    | ~~tools-web / tools-glob / tools-media 三场景拆包~~                   | ✅ 完成（08-22，三新包 +33 测试）                                               |
| **P1**     | 会话管理增强                         | 标题自动生成、关键词搜索、导出 Markdown、Compaction（长会话摘要压缩）                     | ⬜ 待办                                                                 |
| **P1**     | 插件化 CLI 扩展                     | 插件可往 CLI 注册自己的子命令 / `/xxx` 斜杠命令                                  | ⬜ 待办                                                                 |
| **P2**     | MCP Client 插件                  | 对接 Model Context Protocol，支持 local stdio + remote SSE MCP Server | ⬜ 待办                                                                 |
| **P2**     | Subagent 插件                    | `AgentTool` + `runAgent()`，支持子 Agent 嵌套调用                        | ⬜ 待办                                                                 |
| **P2**     | Skill Layer                    | Markdown 技能 + paths 条件触发 + 三来源发现（bundled/user/project）           | ⬜ 待办                                                                 |
| **P3**     | TUI 形态                         | 基于终端 UI 的富交互（类似 Claude Code TUI）                                 | ⬜ 待办                                                                 |
| **P3**     | Swarm 协作                       | Team + Mailbox + Task List + 权限桥接（多 Agent 协作）                    | ⬜ 待办                                                                 |

#### 近期优先推进顺序

1. **~~流式输出~~** — ✅ 已完成
2. **~~`edit_file`~~** **~~+~~** **~~`list_dir`~~** **~~+~~** **~~`grep_file`~~** — ✅ 已完成（含工具插件化拆分）
3. **~~`@harness/tools-web`~~** **~~/~~** **~~`tools-glob`~~** **~~/~~** **~~`tools-media`~~** — ✅ 已完成（三场景包 33 测试）
4. **~~会话 Compaction~~** — ✅ 已完成（三级压缩 + 系统记忆注入）
5. **~~`@harness/provider-openai`~~** — ✅ 已完成
6. **~~会话管理增强~~** — ✅ 已完成（标题生成 + 关键词搜索 + Markdown 导出）
7. **~~插件化 CLI 扩展~~** — ✅ 已完成（cli.commands / cli.command Hook）
8. **~~MCP Client 插件~~** — ✅ 已完成（stdio + HTTP/SSE transport + resources/prompts + Bearer 鉴权）

#### 剩余待办

| 优先级        | 能力                            | 说明                                                                                                                       | 状态 |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -- |
| **P2**     | ~~Subagent 实时进度推送（Bus 事件）~~   | ~~子 Agent 执行过程中通过 Bus 发布进度事件（工具调用开始/结束、中间文本），父 Agent / CLI 可订阅展示~~ ✅ 完成（08-23，3 个事件：started/completed/failed + 10 个单元测试） | ✅  |
| **P2**     | ~~Subagent 工具调用摘要~~           | ~~子 Agent 内部工具调用链过长时生成摘要后返回父 Agent，避免上下文膨胀~~ ✅ 完成（08-23，summarizeResult + 8 个单元测试）                                       | ✅  |
| **P2**     | 基于 caller.permission 过滤 Agent | 根据调用者（父 Agent / 用户）的权限动态过滤可用子 Agent 列表，权限不足的子 Agent 不在 `/subagents` 列出 ✅ 已实现（`/subagents` 经 `filterAccessibleAgents`/`isAgentDenied`） | ✅ | 
| **P2**     | 配置文件加载 Agent                  | 从配置文件（如 `.harness/agents.yaml` 或 `harness.config.ts`）加载 Agent 定义，支持运行时动态注册子 Agent ✅ 已实现（core 经 `agentDirs` user→project 多级目录加载 + 覆盖）  | ✅ |
| **P2**     | Skill Layer                   | Markdown 技能 + paths 条件触发 + 三来源发现（bundled/user/project）                                                                   | 待做 |
| **~~P2~~** | ~~Provider 补全~~               | ~~Gemini / 通义 / 智谱 等多模型适配~~ ✅ 完成（08-23，Gemini 独立实现 + Qwen/GLM 复用 OpenAIChatProvider）                                     | ✅  |
| **P3**     | Subagent run\_in\_background  | 子 Agent 后台异步执行，父 Agent 不阻塞等待，通过 Bus 事件或轮询获取结果                                                                            | 待做 |
| **P3**     | ~~Subagent git worktree 隔离~~    | ~~子 Agent 在独立 git worktree 中执行，避免与父 Agent 工作区冲突~~ ✅ 完成（09-06，worktree.ts + 会话级 cwd 注入 + diff 回传，16 新用例） | ✅ |
| **P3**     | Swarm teammate                | Team + Mailbox + Task List + 权限桥接（多 Agent 协作）                                                                            | 待做 |
| **P3**     | ~~TUI 形态~~                    | ~~基于终端 UI 的富交互（类似 Claude Code TUI）~~ ✅ 完成（08-26，自研 ANSI alt-screen：`--tui` + 日志滚动 + 输入行 + 21 测试）                         | ✅  |
| **P3**     | OAuth2 PKCE                   | 完整 OAuth2 授权码流程（回调服务器 + token 刷新），用于对接 OAuth2-protected MCP Server                                                       | 待做 |

