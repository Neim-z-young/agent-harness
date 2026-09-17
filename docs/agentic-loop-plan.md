# Agentic Loop 改造计划

> 目标：让本项目的 Agent 具备**引擎内自主多步执行**能力——模型调用工具后，工具结果自动回喂并触发下一轮推理，直到模型主动 `stop` 或触及步数上限。
>
> 调研基准：`reference/claude-code-analysis-main`（Claude Code 反编译源码）、`reference/opencode-dev`（Opencode 开源源码）。
>
> 状态：**计划阶段，未动码**。所有改造点均已定位到具体文件行号。

---

## 一、结论先行

本项目**不是"没有 loop"，而是 loop 的控制权在引擎外**。

| | Claude Code | Opencode | 本项目 |
|---|---|---|---|
| 主循环 | `queryLoop()` async generator | `runLoop` + `processor` 两层 | **无引擎内循环** |
| 位置 | `query.ts:241`（1729 行） | `session/prompt.ts:1098` | `core/src/index.ts:1332 / 1638` |
| 终止依据 | finish reason 无 tool results | `handle.message.finish` 非 `tool-calls` | —— （跑一轮就停） |
| 步数上限 | `maxTurns` + `turnCount` | `agent.steps` + `MAX_STEPS_PROMPT` | 无 |
| 死循环保护 | maxTurns 兜底 | `DOOM_LOOP_THRESHOLD=3` 主动检测 | 无 |
| 上下文压缩挂载点 | 循环体内 autoCompact | 循环体内 compaction 分支 | 每轮 `session.preModel`（已有） |

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
  → AgentRuntimeImpl.queryStream (core:1638)  ← 单轮
       ├─ _prepareQuery (core:1519)：组装 system / hooks / 工具池 / messages
       ├─ triggerPlugin('session.preModel')   // ACP 在此裁剪
       ├─ provider.stream / complete          // 一次模型调用
       ├─ for (tc of toolCalls) 串行执行工具
       └─ addMessage(assistant) + yield done
```

**模型看不到自己上一轮的工具结果**（除用户输入或 barrier 触发的新一轮）。

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
| P0 | **finish reason 未透传** | `ChatCompletionOutput` core:378 | provider 层**已有**该数据但未暴露 |
| P1 | `_prepareQuery` 每轮重跑 | core:1519-1636 | 循环内重复组装 system/hooks/工具池 |
| P1 | barrier 与内部循环语义重叠 | coordinator:493 + cli:2740 | 可能双重续轮 |
| P2 | abort 是空壳 | core:1503 / 1778 | `new AbortController().signal` 每次新建 |
| P2 | 无步数上限 / 无重复调用检测 | —— | 跑飞无保护 |
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

`session.preModel` 每轮都跑，循环上线后会变成每 step 都跑。但 ACP 本就按"轮"设计：`bench/compress-params.ts` 的 `--steps=100/140/200` 就是模拟多轮对话，参数表（R / GF / MC）就是在此基础上实测出来的。因此**刚调完的参数不用重调**。

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
    // 每轮需要做的：重建 messages + 跑 session.preModel + snapshot capture
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

**S0 — finish reason 透传（零行为变化）**

- `ChatCompletionOutput` 加 `finish?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error'`
- 6 个 provider 补齐映射：anthropic / openai / gemini / glm / qwen / mock
- `ChatStreamChunk` 的 `done` 类型补 `finish`
- 验收：全仓 typecheck 0 错误 + 全部既有测试通过；`finish` 为可选字段 ⇒ 不改任何分支行为

**S1 — `maxSteps=1` 循环骨架（证明等价）**

- 拆出 `_prepareQueryOnce`（只做一次的部分）与 `_buildMessagesForStep`（每轮重建 messages + `session.preModel`）
- 循环体上线，但 `maxSteps` 默认 `1`
- 验收：**用同一组 mock provider 对比 S0 与 S1 的输出，逐事件、逐消息相同**——这是最关键的回归闸门

**S2 — 放开步数 + 保护**

- `maxSteps` 默认值取 20~50（参照 opencode `agent.steps` 语义，可由 Agent 定义覆盖）
- doom-loop 检测：最近 3 次同一 `toolId` 且 `JSON.stringify(input)` 相同 → 请示权限（对齐 opencode）或强制退出
- 到顶时注入收尾提示再跑一轮（对齐 `MAX_STEPS_PROMPT`），而非硬截断
- 验收：构造"模型永远返回同一工具调用"的 mock，验证在第 3 次被拦住；构造"连续 5 步工具链"，验证自主跑完并以文本收尾

**S3 — abort / 中断**

- 打通真实 abort：`ToolContext.signal` 不能再每次 `new AbortController()`，需从 harness 会话级传入
- 中断时把未完成的工具标记为 error（对齐 opencode `cleanup()` 的强制收尾）
- 验收：循环进行中发中断，进程能在一步边界内停下且不丢已完成的 part

**S4 — 插件协调（风险最高，最后做）**

明确三层职责，避免双重驱动：

| 层 | 职责 |
|---|---|
| 引擎内循环 | 工具结果回喂 → 继续推理（同步、同会话、步数受限） |
| coordinator barrier | 后台 subagent 任务集齐后的一次跨轮推进 |
| REPL `<continue/>` | 保留，但只在 barrier 场景使用，不再承担链式执行 |

需要回归的三个插件：

- **coordinator**：barrier 续轮与内部循环可能叠加 → 内部循环跑完后再收到 `<continue/>`，应识别为"上一轮已自然结束"的空转并忽略（可借助 assistant 消息的 step 计数判断）
- **subagent**：`subagent/src/index.ts:743` 调 `queryStream` 一次，循环上线后会跑完整多轮 —— 大概率是改善，但需确认其进度事件与超时假设仍成立
- **swarm**：tick 间隔 × 内部循环步数 的乘积可能超时，需给 tick 设总时长预算

---

## 五、难度评估

**中等偏上**。循环主体本身只有 200~300 行，真正的成本不在循环：

| 部分 | 难度 | 说明 |
|---|---|---|
| 循环骨架 | 低 | ~200 行，形态明确可参照 |
| finish reason 透传 | 低 | 6 个 provider 各补一行映射 |
| `_prepareQuery` 拆分 | 中 | 要精确区分"一次"与"每轮"，拆错会丢 hook 或重复执行 |
| done 事件语义 | 中 | CLI / TUI 都假设收到 `done` 即结束，需区分 `turn_end` 与 `all_done` |
| 插件协调（S4） | 高 | 三个插件的行为回归，且 barrier 与循环语义天然重叠 |
| 无 ACP 成本 | — | ACP 本就按轮设计，参数不用重调 |

**最大的隐性风险**：coordinator 的 `<continue/>` 已经在承担"链式执行"的职责，内部循环上线后两者会打架。建议 S0-S3 保持 `coordinator` 插件关闭状态下验证，S4 再单独处理。

---

## 六、验收清单

- [ ] S0：typecheck 全绿、既有测试全通过、`finish` 字段可选 ⇒ 零行为变化已验证
- [ ] S1：S0 与 S1 在相同输入下输出**逐事件等价**（mock provider 对比）
- [ ] S2：连续多步工具链能自主跑完；doom-loop 在第 3 次被拦；步数到顶注入收尾提示
- [ ] S3：循环中途中断能在步边界停下且状态完整
- [ ] S4：coordinator / subagent / swarm 三插件在循环上线后行为符合预期，无双重驱动
- [ ] 文档：`README.md` 与 `agent-harness-architecture.md` 同步更新 loop 章节

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
