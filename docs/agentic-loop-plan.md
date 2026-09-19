# Agentic Loop 改造计划

> 目标：让本项目的 Agent 具备**引擎内自主多步执行**能力——模型调用工具后，工具结果自动回喂并触发下一轮推理，直到模型主动 `stop` 或触及步数上限。
>
> 调研基准：`reference/claude-code-analysis-main`（Claude Code 反编译源码）、`reference/opencode-dev`（Opencode 开源源码）。
>
> 状态：**S0 / S1 / S2 / S3 已完成并提交，S4 待启动**。所有改造点均已定位到具体文件行号。

---

## 一、结论先行

本项目**不是"没有 loop"，而是 loop 的控制权在引擎外**（S0~S2 已把它移到引擎内）。

| | Claude Code | Opencode | 本项目（**改造前**；已完成部分见 §四） |
|---|---|---|---|
| 主循环 | `queryLoop()` async generator | `runLoop` + `processor` 两层 | **无引擎内循环** |
| 位置 | `query.ts:241`（1729 行） | `session/prompt.ts:1098` | `core/src/index.ts:1332 / 1638` |
| 终止依据 | finish reason 无 tool results | `handle.message.finish` 非 `tool-calls` | —— （跑一轮就停） |
| 步数上限 | `maxTurns` + `turnCount` | `agent.steps` + `MAX_STEPS_PROMPT` | 无 |
| 死循环保护 | maxTurns 兜底 | `DOOM_LOOP_THRESHOLD=3` 主动检测 | 无 |
| 上下文压缩挂载点 | 循环体内 autoCompact | 循环体内 compaction 分支 | 每轮 `core.session.preModel`（已有） |

---

## 二、参考实现的循环机制

### 2.1 Claude Code：循环即引擎

`src/query.ts:219 query()` 只是一个薄封装，真正主体是 `queryLoop()`（`query.ts:241`）：

```
async function* queryLoop(params, consumedCommandUuids): AsyncGenerator<..., Terminal>
  const { systemPrompt, ..., maxTurns } = params        // 不可变
  let state: State = { messages, turnCount: 1, ... }    // 可变跨轮状态
  while (true) {
    const { messages, turnCount, ... } = state          // 每轮顶部解构
    yield { type: 'stream_request_start' }
    ... 调 API + 流式消费 + 执行工具 ...
    if (无 tool results) return terminal                // 正常退出
    const nextTurnCount = turnCount + 1                 // query.ts:1678
    if (maxTurns && nextTurnCount > maxTurns) {         // query.ts:1705
      yield max_turns_reached 消息
      return { reason: 'max_turns', turnCount }
    }
    state = { ..., turnCount: nextTurnCount }           // 继续下一轮
  }
```

要点：

- **7 个 continue 点**，状态统一走 `state = {...}` 整体重赋值，不做零散赋值；
- 循环体里内联了 autoCompact、reactive compact、fallback model、`max_output_tokens` 恢复子循环、tool result budget、microcompact、memory/skill 预取；
- `maxTurns` 既是上限也是保护：abort 时也会检查（`query.ts:1506`）。

### 2.2 Opencode：runLoop 编排 + processor 单轮

两层分工：`prompt.ts:1098 runLoop` 负责"要不要再跑一轮"，`processor.ts` 负责"这一轮怎么跑"。

退出判断（`prompt.ts:1128`）写得最讲究：

```ts
if (
  lastAssistant?.finish &&
  !["tool-calls"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastUser.id < lastAssistant.id
) break
```

`hasToolCalls` 的兜底注释说明了为什么要这么复杂：**部分 provider 返回 `stop` 但消息体里仍带 tool calls**，只看 finish reason 会提前退出、工具结果永远送不回模型。同时排除 `isOrphanedInterruptedTool`（被打断的孤儿工具）以免为此多跑一轮。

两个本项目完全没有的保护：

1. **doom-loop 检测**（`processor.ts`，`DOOM_LOOP_THRESHOLD = 3`）：最近 3 个 part 是同一工具且 `JSON.stringify(input)` 完全相同 → 弹 `doom_loop` 权限确认，把无限重试挡在人机交互处；
2. **溢出即压缩**：`compaction.isOverflow({ tokens, model })` → 建 compaction task → `continue` 走下一轮，**压缩本身就是一种 continue 分支**。

另有一处细节值得抄：`isLastStep` 时往 messages 尾部追加 `MAX_STEPS_PROMPT`（`prompt.ts:1298`），让模型知道"这是最后一轮，请收尾"，而不是硬截断。

### 2.3 共同点（改造的验收标准）

1. 循环在**引擎内部**，调用方无感知；
2. 终止靠 **finish reason**，而非"有没有拼出 tool_calls"；
3. 有**步数上限**，到顶时给模型收尾机会而非直接掐断；
4. 有**重复调用检测**；
5. 每轮都做**上下文溢出检查**；
6. 工具结果在**下一轮请求**里以合规格式回喂。

---

## 三、本项目现状剖析

### 3.1 执行链路

```
用户输入
  → cli processLine (cli/src/index.ts:2811)
  → app.sendStream (cli:2511)            // 仅转发，无循环
  → session.promptStream (core:626)
  → AgentRuntimeImpl.queryStream (core)  ← S1/S2 后：引擎内自主多步
       ├─ _prepareQueryOnce              // 一次：agent/工具池/权限/system prompt/model 解析
       └─ while (step <= maxSteps)       // 默认上限 30；maxSteps=1 为显式单轮
            ├─ _buildStepMessages         // 每轮：重读会话 + getView + core.llm.params/hooks + preModel 裁剪
            ├─ provider.stream / complete // 每步一次模型调用
            ├─ for (tc of toolCalls) 串行执行工具（含 doom-loop 拦截）
            ├─ addMessage(assistant) + yield done(step, finish)
            └─ shouldContinueStep ? 续轮 : 结束（到顶则先注入收尾提示）
```

**模型现在能看到自己上一轮的工具结果** —— 工具结果在下一步的请求里以合规格式回喂
（provider 层序列化时已支持，改造未动消息模型）。引擎自主续轮，直到模型不再要求工具调用、
finish 表示异常终止、被 doom-loop 拦下，或触及步数上限。

### 3.2 现有的"外部续轮"机制

```
coordinator 插件检测到 barrier 完成（所有后台 subagent 任务结束）
  → bus.publish('coordinator.barrier.completed')   coordinator/src/index.ts:493
  → CLI attachAutoContinue 订阅该事件              cli/src/index.ts:2740
  → emitLine('<continue/>') 即 rl.emit('line')     cli:3455
  → readline 的 'line' 处理器再走一次 processLine   cli:3457
```

这是**有意解耦**——coordinator 插件注释明确写着"插件只负责检测 barrier 完成 + 发布事件，不直接驱动 query"。设计上没错（插件不该驱动引擎），但代价是：**只有后台任务集齐才续轮，普通工具链（read → edit → bash）无法自主多步**。

swarm 的 teammate tick（`plugins/swarm/src/index.ts:1171`）同理，每个 tick 只调一次 `agent.query()`。

### 3.3 阻塞点清单（已定位）

| # | 阻塞点 | 位置 | 现状 |
|---|---|---|---|
| ~~P0~~ | ~~**finish reason 未透传**~~ | `ChatCompletionOutput` | ✅ **S0 已解决**（`finish` + `finishRaw` 已贯穿 provider → core → 流式事件） |
| ~~P1~~ | ~~`_prepareQuery` 每轮重跑~~ | core | ✅ **S1 已解决**（拆成 `_prepareQueryOnce` + `_buildStepMessages`） |
| P1 | barrier 与内部循环语义重叠 | coordinator:493 + cli:2740 | 可能双重续轮 |
| ~~P2~~ | ~~abort 是空壳~~ | core | ✅ **S3 已解决**（signal 贯穿 + 步边界/工具前中断 + REPL/TUI 接线） |
| ~~P2~~ | ~~无步数上限 / 无重复调用检测~~ | core | ✅ **S2 已解决**（默认 30 步 + doom-loop 阈值 3） |
| OK | 工具结果回喂格式 | provider-anthropic / provider-openai | **已支持，零改动** |
| OK | ACP 多轮适应性 | acp-context | **本就按"轮"设计** |

#### P0 详解：数据有，接口没透

`ChatCompletionOutput`（core:378）只有 `content / toolCalls / reasoning / model / tokenUsage / raw`，**没有 finish 字段**。但 provider 内部已经解析了：

- `provider-anthropic/src/index.ts:115` → `stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'`
- `provider-openai/src/index.ts:120` → `finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string`
- openai 已经在用它判 `tool_calls`（`provider-openai:730`），只是没往上传

所以 P0 的成本是**纯加法**：接口加一个可选字段，逐个 provider 补映射，零行为变化。

#### OK 详解：回喂格式已经就绪

两个 provider 都会把 assistant 消息里带 result 的 tool part 自动拆成合规角色：

- Anthropic：`ToolCallPart` 带 result → `tool_result` block（见 provider-anthropic 文件头注释）
- OpenAI：→ `role: 'tool'` 消息带 `tool_call_id`（`provider-openai:227 / 292`）

即 session.messages 里保持"assistant 消息内嵌工具结果"的统一模型，序列化时再拆——**循环改造不需要动消息模型**。

#### OK 详解：ACP 不需要改

`core.session.preModel` 每轮都跑，循环上线后会变成每 step 都跑。但 ACP 本就按"轮"设计：`bench/compress-params.ts` 的 `--steps=100/140/200` 就是模拟多轮对话，参数表（R / GF / MC）就是在此基础上实测出来的。因此**刚调完的参数不用重调**。

---

## 四、改造方案

### 骨架

在 `queryStream` 外包一层循环，`query()` 复用同一循环体（只取最后一轮的 assistant 消息）：

```ts
// core/src/index.ts
async *queryStream(input) {
  const prepared = await this._prepareQueryOnce(input)   // 只跑一次：agent/工具池/hooks/system
  let step = 0
  let turnMessages: Message[] = prepared.finalMessages
  let terminal: ...

  while (true) {
    step++
    // 每轮需要做的：重建 messages + 跑 core.session.preModel + snapshot capture
    const roundMsgs = await this._buildMessagesForStep(prepared, turnMessages, step)
    const { finish, toolCalls, assistant } = await this._runOneStep(prepared, roundMsgs)  //  yields 流式事件
    if (finish === 'stop' || finish === 'length' || finish === 'content_filter') break
    if (maxSteps && step >= maxSteps) { /* 注入收尾提示，再跑最后一轮 */ break }
    if (isDoomLoop(recentParts)) { /* 请示权限 / break */ }
    turnMessages = [...roundMsgs, assistant]
  }
  yield { type: 'done', message: lastAssistant }
}
```

### 各阶段任务

**S0 — finish reason 透传（零行为变化）** ✅ 已完成

- `ChatFinishReason` 联合类型 + `normalizeFinishReason()` 映射（`core/src/index.ts`；含 `'unknown'`，
  缺失/未知值**不落** `'stop'` —— "没有 finish 信息"与"模型明确结束"是两件事）
- `ChatCompletionOutput` / `ChatStreamChunk(done)` / `AgentStreamEvent(done)` 三处加 `finish` + `finishRaw`
- Provider 侧补映射：**实际只改 4 处**——`provider-glm` / `provider-qwen` 复用 `OpenAIChatProvider`，
  改了 openai 即自动覆盖；另有 anthropic（`message_delta.stop_reason`）、gemini（`candidate.finishReason`）、
  mock（按有无 toolCalls 推导）
- 验收：全仓 typecheck 0 错误；core 55 / cli 330 / 6 个 provider 全绿；新增 11 例测试
  （映射定值 7 + core 端到端透传 4）；真实网关（本地 8787 / hy3）实测 `finish=stop finishRaw="stop"`

> ⚠️ **续轮判据的最终形态**（S2 定稿，实现见 `shouldContinueStep`）：
> **续轮 ⇔ 本步有工具调用 且 finish 不是异常终止（length / content_filter / error）。**
> `finish === 'stop'` 且带工具调用时**仍要续轮** —— Gemini 在返回 `functionCall` 时 `finishReason`
> 就是 `STOP`（已由 `provider-gemini/src/index.test.ts` 断言固定），按"只有 tool_calls 才续轮"
> 写会在 Gemini 上直接退化成单轮。反过来 `length`/`content_filter`/`error` 是本步被截断或拦截，
> 即便残留 toolCalls 也不该续。finish 缺失时按"有工具调用即续轮"处理（宁可多跑一步，
> 也不能丢掉工具结果）。

**S1 — `maxSteps=1` 循环骨架（证明等价）** ✅ 已完成

- 拆出 `_prepareQueryOnce`（一次：Agent 解析 / 工具池 / 权限 / 用户消息注入 / system prompt /
  provider-model 解析 / paramsBase）与 `_buildStepMessages`（每轮：重读会话 → getView →
  组装 system+历史 → `core.llm.params`+`core.llm.headers` → `core.session.preModel` → 回写 blocks）
- 单步执行体抽成 `_runOneStep(prepared, step)`（async generator，终值经 `yield*` 传出 `StepOutcome`），
  `queryStream` 只剩「准备一次 + for 循环」
- `AgentQueryInput.maxSteps` 默认 `1`；`session.promptStream(sessionId, text, maxSteps?)` 透传
- **A 方案落地**：`done` 事件加 `step`（从 1 开始），**每步都发** —— 语义是"这一步结束"而非
  "本次查询全部结束"；上层不得用"收到 done"判断整轮完成（`AgentStreamEvent.step` 的 doc 已写明）
- 验收：**逐事件等价对照通过**。同一组 mock 剧本（纯文本 / 带工具调用）跑 S0 与 S1，
  除 `done` 新增的 `step` 字段外**逐字节相同**：
  ```
  4c4
  < EVENT done parts=[text] finish=stop step=-
  ---
  > EVENT done parts=[text] finish=stop step=1
  ```
  同时对照了 hook 调用次数（`core.tool.pool.assemble` / `core.prompt.system.transform` / `core.llm.params` /
  `core.llm.headers` / `core.session.preModel` 各恰好 1 次 —— 证明拆分既没丢 hook 也没重复执行）、
  provider 调用次数、会话消息结构
- 另加 3 例测试锁定骨架本身：缺省 1 步只调一次模型；`maxSteps=2` 时**第二步请求里含第一步的
  assistant 消息与工具结果**（回喂机制的证据，S2 的前提）；两步各自发 done 且 step 递增

> 📌 **计划调整**：本阶段只改 `queryStream`（流式链路，CLI/TUI 走这条）。
> `query()`（非流式，`subagent` / `swarm` 插件走这条）暂未改，留到 S2 与 `query()` 复用同一循环体，
> 避免一次动两条链路、回归面翻倍。
>
> 📌 **S2 需要同步改 CLI/TUI**：A 方案下"收到 done"不再等于"本轮结束"，CLI 的 `processLine`
> 与 TUI 的收尾渲染要改成「done 只做收尾渲染 + 由 `step` 与后续事件判断是否继续」。

**S2 — 放开步数 + 保护** ✅ 已完成

- **步数上限**：`DEFAULT_MAX_STEPS = 30`（导出常量），优先级 `AgentQueryInput.maxSteps` >
  `AgentDefinition.maxSteps` > 默认。`-1` 表示不限。30 是权衡值：够跑完 read → edit → bash → verify
  这类链条（含几次重试），又不至于一次查询烧掉失控的 token。
- **续轮判据**（`shouldContinueStep`，**这是本阶段最容易写错的一处**）：
  ```
  续轮 ⇔ 本步有工具调用 且 finish ∉ { length, content_filter, error }
  ```
  - **不能写成「finish === 'tool_calls' 才续轮」**：Gemini 在返回 `functionCall` 时
    `finishReason` 仍是 `STOP`，那种写法会让它在该续轮时退出、退化成单轮（S0 已用断言固定该语义）。
  - `length` / `content_filter` / `error` 表示本步是**被截断/拦截**的异常结束，即便消息里残留
    toolCalls 也不该续 —— 回喂一个残缺的调用链没有意义。
  - finish 缺失时不阻断续轮：宁可多跑一步，也不能丢掉工具结果。
- **doom-loop 检测**：`DOOM_LOOP_THRESHOLD = 3`，同一 `toolId` + 完全相同的 `JSON.stringify(input)`
  连续 3 次 ⇒ **在执行之前**拦下（第 3 次不真的跑），走 `permission.ask()` 征求确认；
  拒绝则把该工具结果标为 `error`（code `DOOM_LOOP`）并终止循环。
  无人交互时 `DefaultPermissionEngine.ask` 默认 deny ⇒ 保守中断，不会静默跑到底。
- **步数到顶**：注入一条收尾提示（对齐 opencode `MAX_STEPS_PROMPT`）再跑一步，而非硬截断。
  **例外：`maxSteps=1` 是「显式单轮」语义**，不追加收尾步 —— 否则「1 步」会变成 2 次模型调用，
  破坏子 Agent 与旧调用方的预期。
- **`query()` 复用同一循环**：删掉原先那份与 `_prepareQuery` 平行的 186 行逻辑副本，改为
  `for await (queryStream)` 取最后一个 `done.message`。循环语义（步数 / doom-loop / 续轮判据）
  对 subagent / swarm 天然一致 —— 它们此前只能单轮。
- **CLI/TUI 多步呈现**：
  - REPL：`done` 改为「本步收尾」——结束时结束当前文本行并记下 `step`；**若之后还有事件到来**
    （说明引擎在自主续轮）就打一行 `🔄 第 N 步（自主续轮）` 分隔，避免长时间无反馈。
  - `run`：工具活动写到 **stderr**，stdout 保持「纯结果」以利脚本消费。
  - TUI：`onEvent` 已携带 `done.step`，分隔由 TUI 自行渲染（不向控制台混入文本行）。
- **mock provider 增补 `once?: boolean`**：规则命中一次后不再参与匹配。用于模拟真实模型的
  行为序列（第一步要求调工具、第二步给出文本结论），是测试多步链路的关键设施 ——
  没有它，可重复命中的规则会让引擎一直续轮直到 doom-loop。
- 验收：core 66 通过（新增 8 例：多步链自主收尾 / `length` 不续轮 / doom-loop 拦截 /
  用户放行时不误伤 / 步数到顶注入提示 / `maxSteps=1` 不追加收尾 / `isDoomLoop` 边界 /
  默认步数守卫）；cli 330、subagent 113、swarm 65、session 32、agent 33、provider-mock 16 全绿；
  全仓 typecheck 0 错误。

> 📌 **S2 暴露的真实行为变化**（测试与文档都要跟上）：
> 1. 用「每次返回同一工具调用」的 mock 写单轮用例，现在会一路续轮到 doom-loop 才停 ——
>    这类用例应显式传 `maxSteps: 1`（本阶段已改 3 处：core 2 处、provider-mock 1 处）。
> 2. TUI 的权限审批模态在自主多步下**每步都可能弹**（工具真的要被调用）。这是正确行为，
>    但测试剧本必须让第二步收敛（用 `once` 规则），否则会陷在反复弹窗里。

**S3 — abort / 中断** ✅ 已完成

- **`ToolContext.signal` 接上真信号**：此前每次 `new AbortController().signal`，是个永不 abort 的空壳
  —— 下游其实早已认真实现（`tool` 的 pipeline 有 `ctx.signal.throwIfAborted()`、`tools-builtin`
  的 bash 会据此 kill 子进程、`tools-web` 用它中止 fetch），**整条链只差 core 这一环**。
  现在传 `AgentQueryInput.signal`；未传时退回新建（向后兼容）。`session.promptStream` 加第四个参数透传。
- **中断生效点**（两处，都不切碎一步）：
  - **步边界**：`signal.aborted` ⇒ 不再开始新的一步；
  - **每个工具执行前**：已 abort ⇒ 该工具不执行，结果标记为 `ABORTED` 错误（对齐 opencode cleanup）。
    检查放在 `tool_call_start` **之前** —— 没执行就不该报"开始"。
- **不丢已完成的部分**：中断时本步已产生的 assistant 消息（含已执行工具的结果、已收到的流式文本）
  照常写回会话。流式路径里 `AbortError` 被**吞掉**而不是穿透 —— 否则上层只会看到一句"发送失败"，
  已渲染的内容全丢。只吞中断类异常，其它错误照旧上抛（不能把真实故障伪装成"用户取消"）。
- **新增 `turn_end` 事件**（A 方案的补全）：`done` 每步都发，上层无法据此判断"整轮跑完"。
  TUI 的 busy 状态此前在第一个 `done` 就置 false，引擎还在跑第二步时界面已显示空闲 —— 这是 A 方案
  必然带来的缺口。现在在循环结束后收一条 `turn_end`（不带 message，纯状态收尾信号）：
  - REPL：`turn_end` 不触发续轮分隔（它不是"下一步开始了"）；
  - TUI：`busy=false` 从 `done` 移到 `turn_end`，并在 `processLine` 返回处兜底（防事件流异常时卡住）。
- **CLI 接线**：REPL 的 `SIGINT` 与 TUI 的 Ctrl-C 统一为两段语义 ——
  **执行中 ⇒ 中断本次查询**（提示"已请求中断，已完成的步骤会保留"），**空闲 ⇒ 退出**。
  通过 `ProcessLineOptions.activeAbort` 句柄传递（执行期间写入当前 controller，`finally` 清空）。
- 验收：core 73 通过（新增 7 例：`ToolContext.signal` 同一性 / 步边界中断且成果保留 /
  剩余工具标 ABORTED 且第二个工具确实没跑 / 流式中断保留 partial 不抛错 / 不传 signal 行为不变 /
  `turn_end` 只发一次且在最后 / 中断同样以 `turn_end` 收尾）；cli 330、subagent 113、swarm 65、
  session 32、provider-mock 16 全绿；全仓 typecheck 0 错误。

**S4 — 插件协调（风险最高，最后做）** ✅ 已完成（代码侧）

三层职责（最终形态）：

| 层 | 职责 | 触发条件 |
|---|---|---|
| 引擎内循环 | 工具结果回喂 → 继续推理（同步、同会话、受步数限制） | 本步**有工具调用** |
| coordinator barrier | 后台 subagent 任务集齐后的一次跨轮推进 | **所有后台任务完成** |
| REPL/TUI `<continue/>` | barrier 的载体（伪输入），不再承担链式执行 | 由 barrier 事件注入 |

两者的触发条件天然不同（「有工具调用」vs「后台任务集齐」），因此**不会互相递归**。
真正的问题是**空转**：`<continue/>` 的唯一目的是让模型看到后台结果，没有结果时白跑一轮 ——
内部循环上线后一轮可能是多步，代价被放大。

- **coordinator / `<continue/>` 空转识别**（cli）：续轮前 `peekNotifications()`，
  无待处理通知就跳过并提示「无待处理的后台任务结果，跳过本次自动续轮」。
  ⚠️ **必须让出一个宏任务再判断**：subagent 里 `bus.publish(completed)` 排在
  `enqueueNotification()` **之前**，而 publish 会同步驱动 coordinator 的 barrier → 本函数 ——
  同步 peek 会在通知入队前读到空队列而**误判空转**、把真正的结果吞掉。
  REPL 与 TUI 共用 `createProcessLine`，一处改动两条链路同时生效。
- **subagent 接上真 signal**（之前的真 bug）：超时只做了 `Promise.race`，
  **没把 signal 传进 `query()` / `queryStream()`** —— 超时后上层放弃等待，底层仍在后台继续跑
  （内部循环上线后可能几十步），白烧 token 并继续产生工具副作用。两处调用点已传
  `controller.signal`（前台 `query` 的注释「agent.query 不接受 signal」已过时 —— S3 打通后它接受了）。
- **swarm tick 防重叠**：`setInterval(tick, 1000)` + `void tick()` 不等待上一次结束。
  单轮几秒时侥幸无碍，**自主多步后一次 tick 轻易超过 1s** ⇒ 每秒叠加一次新的子 Agent 查询。
  已加 `running` 标志跳过重叠 tick —— 这比「给 tick 设总时长预算」更根本（预算是治标）。

> ⚠️ **未做真实端到端验证**：本阶段的结论基于代码路径分析 + 单元测试（subagent 113 / swarm 65 全绿）。
> 真实的 barrier 场景（派发后台任务 → 任务完成 → barrier → 续轮）需要在开着 coordinator 的
> 实际会话里验证一次；我无法在这里构造真实后台任务。
>
> 📌 **需你决策的权衡（我没擅自改）**：subagent 默认超时 120s，而子 Agent 现在最多可自主跑
> `AgentDefinition.maxSteps`（默认 30）步 —— 30 步很容易超过 120s 而被判超时。两个方向：
> ① 给子 Agent 设更小的 `maxSteps`（任务聚焦，10 步左右通常足够）；
> ② 调大 subagent 的超时。我倾向 ①（子 Agent 的职责是聚焦执行，不是长链探索）。

---

## 五、难度评估

**中等偏上**。循环主体本身只有 200~300 行，真正的成本不在循环：

| 部分 | 难度 | 说明 |
|---|---|---|
| 循环骨架 | 低 | ~200 行，形态明确可参照 |
| finish reason 透传 | 低 | 6 个 provider 各补一行映射 |
| `_prepareQuery` 拆分 | 中 | 要精确区分"一次"与"每轮"，拆错会丢 hook 或重复执行 |
| done 事件语义 | 中 | ✅ 已定 **A 方案**（每步发 done + `step` 序号）；S2 需同步改 CLI/TUI 的"收到 done 即结束"假设 |
| 插件协调（S4） | 高 | 三个插件的行为回归，且 barrier 与循环语义天然重叠 |
| 无 ACP 成本 | — | ACP 本就按轮设计，参数不用重调 |

**最大的隐性风险**：coordinator 的 `<continue/>` 已经在承担"链式执行"的职责，内部循环上线后两者会打架。建议 S0-S3 保持 `coordinator` 插件关闭状态下验证，S4 再单独处理。

---

## 六、验收清单

- [x] S0：typecheck 全绿、既有测试全通过、`finish` 字段可选 ⇒ 零行为变化已验证
  （core 55 / cli 330 / provider 6 包全绿；真实网关实测 finish 正确解析）
- [x] S1：S0 与 S1 在相同输入下输出**逐事件等价**（mock provider 对比）
  —— 除 `done.step` 外逐字节相同；hook 次数 / provider 调用次数 / 会话消息结构均一致
- [x] S2：连续多步工具链能自主跑完（4 步用例）；doom-loop 在第 3 次被拦（用户放行时不误伤）；
  步数到顶注入收尾提示且提示确实进了请求；`maxSteps=1` 不追加收尾步
- [x] S3：循环中途中断能在步边界停下且状态完整（`ToolContext.signal` 已接通真信号；
  剩余工具标 `ABORTED`、已完成的成果保留；REPL SIGINT / TUI Ctrl-C 已接线）
- [x] S4：coordinator / subagent / swarm 三层职责厘清（触发条件天然不同，不互相递归）；
  `<continue/>` 空转识别 / subagent signal 透传 / swarm tick 防重叠 已落地；
  **真实 barrier 全链路（派发后台任务 → 完成 → 续轮）待实测**
- [x] 文档：`README.md`（新增 Agentic Loop 小节）与 `agent-harness-architecture.md` §16（改为落地后的形态）已同步

---

## 七、参考实现速查

| 想看的机制 | 去哪里看 |
|---|---|
| 循环主体与 continue 点 | `claude-code-analysis-main/src/query.ts:241-1729` |
| maxTurns / abort 检查 | `query.ts:1506 / 1705` |
| 循环编排 + 退出判断 | `opencode-dev/packages/opencode/src/session/prompt.ts:1098-1357` |
| 单轮事件处理 | `opencode-dev/packages/opencode/src/session/processor.ts`（+ `processor.md` 中文解析） |
| doom-loop 检测 | `processor.ts` 中 `DOOM_LOOP_THRESHOLD` |
| 压缩作为 continue 分支 | `prompt.ts:1178-1185` |
| 步数到顶收尾提示 | `prompt.ts:1298` 的 `MAX_STEPS_PROMPT` |
