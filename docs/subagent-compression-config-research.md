# 子 Agent 的压缩配置能单独设吗？——本仓现状核查 + 业内调研

> **调研问题**：`@harness/acp-context` 的**压缩方法**（用哪套提示词 / tier 策略 / 手册注入策略）与**压缩率**（保留量、触发阈值、层提升阈值）能否按子 Agent（`reader` / `reviewer` / `explorer` …）单独配置？
>
> **一句话结论**：本仓**当前不能**，而且这不是"漏了一个配置项"，是「**单个插件实例 + 工厂期冻结的闭包配置**」这一形态的必然结果。业内头部 harness 里，Claude Code、OpenCode、Gemini CLI、Aider **同样不支持** per-subagent 压缩配置；唯一真正做到的是 **Codex CLI**——区别在**它把 agent 定义当成"会话配置的配置层"，而不是"固定字段的 schema"**。本仓要加，改动量比想象中小得多：hook 入参里**本来就有 `agentId`**。

本文只做调研与方案设计，**未改动任何代码**。

---

## 0. 结论速览

| 问题 | 答案 |
|---|---|
| 本仓能给子 Agent 单独设压缩吗？ | **不能。** `compression` 是**全局扁平配置段**（`packages/cli/src/index.ts:360-432`），插件在 `createAcpContextPlugin()` 时把 `config` / `modelContextLimit` / `countTokens` / `manualInjection` / `systemPrompt` **全部闭包冻结**（`packages/plugins/acp-context/src/index.ts:424-453`），主 Agent 与所有子 Agent 共用同一份。 |
| 加这个能力成本高吗？ | **低。** `SessionPreModelInput` **本来就带 `agentId` / `providerId` / `modelId`**（`packages/plugin/src/index.ts:215-223`），只是 ACP 插件的 `runPreModel` 没接收、没用。`engine` 是纯状态机（`config` 是**每次调用传入的参数**，不是构造参数）⇒ 不需要重建引擎。 |
| 业内主流怎么做？ | 三条路线：**①上下文隔离 + 摘要回传**（Claude Code / OpenAI Agents SDK / LangGraph / CrewAI / Google ADK / Manus —— 绝对主流）；**②集中压缩**（AutoGen `CompressibleGroupManager`，孤例）；**③各压各的**（所有框架的默认兜底）。 |
| 有哪家真支持 per-subagent？ | **Codex CLI**（自定义 agent 文件 = spawn 会话的配置层，与 session config 同键 ⇒ 压缩三项天然可按 agent 覆盖）。Claude Code **明确不支持**，官方原话：*"Subagents support automatic compaction using the same logic as the main conversation. Compaction triggers under the same conditions."* |
| 本仓该不该加？ | **建议按方案 B′（§4.3）做**：加"子 Agent 档位"而不做全量 per-agent 覆盖。理由见 §4.5——本仓子 Agent 的真实痛点是「只读子 Agent 被压缩手册诱导越权」（续 218 取证 P0-1，12 次 100% 撞 `TOOL_NOT_ALLOWED`），**不是"压缩率不合适"**。 |

---

## 1. 本仓现状核查

### 1.1 配置入口只有一个，且是全局扁平段

```
config.json → compression{...}          ← 唯一入口，无 agent 维度
        ↓  packages/cli/src/index.ts:2691-2731（装配点）
createAcpContextPlugin({ modelContextLimit, config, prompts, systemPrompt,
                         manualInjection, tokenCalibration, tokenCalibrationScale,
                         toolIds, telemetry* })
        ↓  packages/plugins/acp-context/src/index.ts:423-465（工厂）
   const config = resolveAcpConfig(...)      // ← 闭包常量
   const engine = createCore({ countTokens }) // ← 闭包常量
   const sessions = new Map<sessionId, AcpSessionCtx>()  // ← 只有"状态"是 per-session
```

`compression` 段可配的键（`packages/cli/src/index.ts:360-432`）：`enabled` / `autoTune` / `tokenCalibration` / `tokenCalibrationScale` / `modelContextLimit` / `prompts` / `systemPrompt` / `preserveRecentMessages` / `preserveRecentTokens` / `promotionThreshold` / `tiers.{tier2Trigger,tier3Trigger}` / `nudge.{maxContextLimitPct,minContextLimitPct,emergencyThresholdPct}` / `config`（透传） / `telemetry`。

**没有任何一处带 agent 维度。** `docs/acp-context-config.md`（配置参考，10 章）同样全篇无 per-agent 语义。

### 1.2 子 Agent 与主 Agent 共用**同一个**插件实例

这一条是理解整件事的关键。子 Agent **不是子进程**：

- `packages/plugins/subagent/src/index.ts` 全包**无 `spawn` / `fork` / `child_process`**；
- 子会话就是 `session.create({ title, parentId: ctx.sessionId, cwd })`（`:1107-1112`），跑在**同一个 Harness、同一份 `internalPlugins`** 上；
- ACP 插件的 per-session 隔离只体现在 `sessions: Map<sessionId, AcpSessionCtx>`（`:463`）——**隔离的是压缩状态（块、refs、nudge 计数），不是配置**。

所以"给子 Agent 换一套压缩参数"在本仓问的是：**同一个闭包里，怎么让不同 sessionId 拿到不同 config**。

### 1.3 落差：`agentId` 已经在链路上，插件没读

| 位置 | 是否带 `agentId` |
|---|---|
| `SessionPreModelInput`（`packages/plugin/src/index.ts:215-223`） | ✅ 有 `agentId` / `providerId` / `modelId` |
| ACP 插件注册的 hook（`index.ts:778`）：`async 'core.session.preModel'(input, rawMessages)` | ✅ 拿得到 `input` |
| 它往下传的东西（`index.ts:781-801`） | ❌ **只传 `sessionId`，`agentId` / `modelId` 被丢掉** |
| `runPreModel` 内部用到的 config（`index.ts:963-967` 解构） | ❌ 全部来自闭包 |
| 工具侧（`compress` / `acp_status`，`index.ts:707-727`） | ❌ 用闭包 `config`；但 `ToolContext.agentId` **是存在的**（`packages/tool/src/index.ts:532`） |

也就是说：**"按 agent 分支"所需的信息全都在手上，缺的只是一个 resolvers。**

### 1.4 「压缩率」在本仓是**观测值**，不是旋钮

遥测里的 `compressRatio` 是**算出来的**（`telemetry.ts:48`，`rawTok / requestTok`），不是配置项。真正能改"压多少"的是 kernel `Config` 里的这几组键：

| 组 | 键 | 作用方向 |
|---|---|---|
| 层保留 | `preserveRecentMessages` / `preserveRecentTokens` | 越大 ⇒ 保留越多 ⇒ 压得越少 |
| 层提升 | `promotionThreshold`（默认 5） | 越大 ⇒ 块越慢升层（t1→t2→t3）⇒ 压得越浅 |
| tier 触发 | `tiers.tier2Trigger`(5) / `tier3Trigger`(10) | 越大 ⇒ 越晚蒸馏/浓缩 |
| nudge | `nudge.maxContextLimitPct`(0.2) / `minContextLimitPct` / `emergencyThresholdPct`(0.98) / `growthFloor` / `growthCap` / `growthRatio` / `minGrowthFloor` / `minGrowthRatio` / `tier2GrowthMultiplier` / `minPressureBenefitTokens` | 决定"什么时候开始劝压" |
| 折叠准入 | `compress.minCompressRange`(5000 字符) / `maxSummaryLength` / `minSummaryLength` | 太短的区间不给折 |
| 截断 | `truncate.threshold` | 工具输出截断线 |
| 瞬时吸收 | `absorb.{enabled,minToolTokens,contextThresholdPct,excludeTools}` | 大工具结果即时吸收 |
| 保护 | `protectedTools` / `isToolProtected` | 白名单不参与折叠 |

「压缩方法」则是另一组：`prompts`（t1/t2/t3 规则 + 压缩哲学）、`systemPrompt`、`manualInjection: 'on-demand' | 'always'`。

**这两组目前都只能全局一套。**

### 1.5 顺带查出一处**已存在的隐性错配**（与 per-agent 无关，但同源）—— ✅ 已修

模型可以按 Agent 换，**压缩窗口不跟着换**：

- 模型解析（`packages/core/src/index.ts`）：`providerId = input.model?.providerId ?? agent.model?.providerId ?? 'default'`，`modelId` 同理 ⇒ **per-agent / per-spawn 覆盖是生效的**；
- 但压缩窗口（`packages/cli/src/index.ts` → `resolveContextWindowTokens`）：`cfg.compression?.modelContextLimit ?? defaultProvider.contextWindowTokens ?? 200_000` ⇒ **只认"默认 Provider"，不认当前 Agent 的模型**（✅ **2026-09-30 已修**：ACP 侧（续 222）与 `compaction` 侧（续 223）都改成按会话实际端点解析）。

后果：一个被派到小窗口模型（或反过来 1M 窗口模型）的子 Agent，occupancy 分母仍是主会话的窗口数 ⇒ **阈值判断系统性偏早/偏晚**，而且没有任何症状。这类"配了却按另一套口径算"的形态，本仓已经栽过两次（`tokenCalibration` 的口径分裂、`compaction` 窗口推导）。

**修法（本轮落地）**：装配时把「Provider 实例 / 模型 → 窗口」表（`buildProviderWindowTable`：`byProvider` / `byModel` / `fallback`）传给 ACP 插件，插件在 `core.session.preModel` hook 里按该轮**实际**的 `providerId` / `modelId` 解析窗口（`lookupProviderWindow`），解析结果存进会话上下文，`acp_status` 报表读同一份。两级都查不到时回落 `fallback` = 原来的默认 Provider 窗口 ⇒ 单一窗口场景**逐位不变**。显式 `compression.modelContextLimit` 仍压过一切（语义是"我不管端点是什么"）。

> 注：**同类问题在 `compaction`（另一套会话压缩机制）上尚未修** —— `buildCompactionOptions` 仍只按默认 Provider 推导单一窗口。它与本条同源但走的是 core 的 `compactIfNeeded`，没有按会话分化的入口，需单独评估。

### 1.6 一个容易踩的坑：往 agent frontmatter 加字段是**静默失效**的

`agentFromMarkdown`（`packages/agent/src/index.ts:445-560`）是**逐字段白名单解析**：只认 `id/name/description/mode/tools/permission/model/tags/skills/mcpServers/excludeMcpServers/background/maxSteps/promptFragments/systemPrompt/swarm`。**未知键静默忽略**——唯一的例外是被删掉的 `subagents` 字段（`:513-519` 保留了一条告警），因为"写了不生效"这件事本身有害。

所以任何"直接在 `reader.md` 里写 `compression:`" 的方案，**如果不改解析器 + 不改消费方，就是制造下一个 `subagents` 式幽灵配置**。

---

## 2. 业内调研

### 2.1 总表

| Harness | 压缩/上下文管理配置项 | 作用域 | **per-subagent 可设？** | 子 Agent 上下文 | 备注 |
|---|---|---|---|---|---|
| **Claude Code** | `autoCompactEnabled`、`autoCompactWindow`(100K–1M)、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`(1–100，只能**提前**)、`CLAUDE_CODE_MAX_CONTEXT_TOKENS` | settings.json（user/project/managed）+ env，**全局** | ❌ **官方明确不支持** | **默认全新隔离窗口**；可选 `fork` 继承整段对话（共享缓存） | 官方原话：subagent 用"与主对话相同的逻辑、相同触发条件"，`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 对 subagent 同样生效。frontmatter 有 `model` / `effort` / `maxTurns` / `tools` / `permissionMode` / `isolation` / `skills` / `memory` / `hooks` / `omitClaudeMd` / `experimental.cacheTtl` —— **没有压缩相关字段** |
| **Codex CLI** | `model_context_window`、`model_auto_compact_token_limit`、`model_auto_compact_token_limit_scope`(total/body_after_prefix)、`tool_output_token_limit`、`compact_prompt` | `config.toml`（root）+ **named profiles**（`~/.codex/<name>.config.toml`，`--profile`） | ✅ **能**（见 §2.3） | 每个 subagent 独立上下文窗口 | 自定义 agent = `.codex/agents/*.toml`，官方措辞："**Codex loads these files as configuration layers for spawned sessions, so custom agents can override the same settings as a normal Codex session config**"；`[agents].default_subagent_model` / `default_subagent_reasoning_effort` / `max_concurrent_threads_per_session`；`/agent` 可查每条线程 |
| **OpenCode** | `compaction.{auto, prune, reserved}` | `opencode.json` **顶层** | ❌ 文档无 per-agent 压缩键 | fresh subagent（每任务一个新 session） | 有隐藏内置 agent：`title`(用 `small_model`) / `summary` / `compaction`(拒绝所有权限)。agent 可有自己的 `model`；`.opencode/agents/*.md` frontmatter 未列压缩字段 |
| **Gemini CLI** | `model.compressionThreshold`（默认 0.5）、`model.maxSessionTurns`、`model.summarizeToolOutput.{tool:tokenBudget}`、`tools.truncateToolOutputThreshold`(40000 字符) | `settings.json`（workspace 覆盖 user），**全局**；**需重启** | ❌（压缩阈值）。有 `agents.overrides` 但只对"特定 agent 的 model config / run config" | — | 压缩实现是"extract + 保留尾部约 30%"：先按 `COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET=50000` 截断工具输出（原文落临时文件），再按**累计 JSON 字符数** 70% 找切点（切点必须落在非 functionResponse 的 user 消息上），摘要走**独立 model alias** |
| **Aider** | `--map-tokens`(默认 1024)、`--max-chat-history-tokens`（缺省跟模型）、`--weak-model`（**摘要/提交信息专用模型**）、`--map-refresh`、`.aider.model.settings.yml`（`max_input_tokens` 等） | CLI / env / `.aider.conf.yml` / per-model settings 文件 | ❌（单 Agent，无 subagent 概念） | — | 提供 `--architect`/`--editor` **双模型**分工；`/tokens` 实时看预算分解。是"按模型而非按 agent"配置的典型 |
| **Cursor 2.0** | 未公开 per-agent 压缩键 | — | ❌ | 每个 agent 独立 git worktree / 云机 | 重心在**隔离**（worktree + SVFS 合并）与 best-of-N 并行，不在压缩调参 |
| **Anthropic API**（不是 harness，但对 harness 作者最相关） | `context_management.edits[]`：`clear_tool_uses_20250919`（`trigger` / `keep` / `clear_at_least` / `exclude_tools`）、`clear_thinking_20251015`（`keep.thinking_turns`）、`compact_20260112`（`trigger` / `instructions` / `pause_after_compaction`）；SDK 侧 `compaction_control.{enabled, context_token_threshold, model}` | **per-request** | ✅（**天然**——每个请求自己带策略 ⇒ 换 agent 就换策略） | — | 这是"服务端压缩"：摘要由 API 生成，客户端可 `pause_after_compaction` 检查历史。**注意 `clear_*` 会使缓存前缀从编辑点失效**，所以有 `clear_at_least` 这个"别清得太碎"的下限 |
| **LangGraph / LangMem** | `SummarizationNode`（`max_tokens` / `max_tokens_before_summary` / `max_summary_tokens` / `token_counter` / `model`）、`summarize_messages`、独立 state key 存 `RunningSummary` | **每个 graph / subgraph 各自一份** | ✅（**天然**——子 Agent 就是子图，压缩节点是它自己的组成部分） | subgraph 独立 state schema | "compress 什么、什么时候 compress"由**你画图时**决定；LangChain 官方立场是"专门化的 agent 应当拿到专门化的上下文" |
| **AutoGen** | `CompressibleGroupManager` | 组级（**集中式**） | ⚠️ 集中压缩（唯一生产实现） | 共享被压缩后的对话 | 与"谁压谁"的其余答案都不同 |

### 2.2 三种"谁压谁"的架构模式

一份对 8 个框架（Claude Code / OpenAI Agents SDK / LangChain·LangGraph / CrewAI / AutoGen / Cursor / Aider / Google ADK）的横向调查给出的结论是：**每个 agent 管自己的上下文，彼此不协调**；并归纳出三种模式：

| 模式 | 做法 | 采用者 | 为什么它让"per-subagent 压缩配置"这个需求消失 |
|---|---|---|---|
| **① 上下文隔离 + 摘要回传**（主流） | 子 Agent 开**全新窗口**；干完活只把**最终摘要**交回父级。父级**从不持有**子级的原始上下文 | Claude Code、OpenAI Agents SDK、LangGraph、CrewAI、Google ADK、Manus | **父级手上根本没有子级的原始上下文可压** ⇒ "谁来压子 Agent"这个问题不成立。设计原则一言以蔽之：*"Share memory by communicating, don't communicate by sharing memory."* |
| **② 委托压缩 / 集中压缩** | 一个 group manager 压缩**共享的**对话，再把压缩结果广播给所有 agent | AutoGen `CompressibleGroupManager`（唯一生产实现）；学术侧的 `SupervisorAgent` 变体（"自适应观测净化"，报称平均减 29.68% token） | 有一个"压缩决策中心"，配置也自然地集中在那一处 |
| **③ 各压各的** | 每个 agent 自己盯自己的 token，到点自己压，策略/时机/摘要互不相同 | 所有框架在 session 内的默认行为 | 这就是"per-agent 配置"天然成立的世界——但**没人给它做配置面**，因为触发条件通常由模型自己的窗口决定 |

同一调查的四条压缩策略（供对照本仓的 t1/t2/t3 定位）：**摘要**（8 家中 6 家的主策略；有实测指出摘要类方法在"记住改过哪些文件"这种产物流转上普遍偏弱，36,611 条生产消息评测仅 2.19–2.45/5.0）、**截断**、**滑窗**（Google ADK 的事件级压缩）、**加密压缩**（OpenAI 的不可读 blob，可能保真更高但完全不可验证）。

### 2.3 为什么 Codex 能而 Claude Code 不能——**架构原因**，不是功能取舍

这是本次调研最有价值的一条发现：

| | Claude Code | Codex CLI |
|---|---|---|
| agent 定义是什么 | **固定字段的 typed frontmatter schema** | **"会话配置的配置层"**（同一套 config.toml 键） |
| 能覆盖什么 | 只有 schema 里**枚举出来**的字段 | **凡是 session config 能设的，都能设** |
| 压缩键在哪 | settings.json / env（**与 agent 文件不同命名空间**） | 与 agent 文件**同命名空间**（`model_auto_compact_token_limit` 等） |
| ⇒ 结果 | 想加 per-subagent 压缩 = **得改 schema + 加消费方** | **自动就有**，零额外代码 |

换句话说：Claude Code 的"不支持"不是没想到，而是**它的 agent 定义形态决定了两者不通**；Codex 的"支持"也不是专门为压缩做的，而是**配置分层带来的副产品**。本仓的 `AgentDefinition` 恰好是**前者**（typed schema + 逐字段解析，§1.6），所以想加就得显式设计。

### 2.4 各家实现的差异对照（只挑本仓可借鉴的）

| 维度 | 业内做法 | 本仓对应 | 差距/可借鉴 |
|---|---|---|---|
| 触发口径 | Gemini `compressionThreshold` 是**占用比例**；Claude Code 已从"纯百分比"改成**token 窗口**（`autoCompactWindow`，且能往后调），百分比版只能提前 | 占用比例 + 绝对量混合（`maxContextLimitPct` / `growthFloor` / `growthCap` / `minPressureBenefitTokens`） | 本仓其实**比 Claude Code 更细**（有 `minPressureBenefitTokens` 这种"清了也没收益就别清"的防抖），不吃亏 |
| 保留尾部 | Gemini：按字符数切在 70%，且切点必须落在"非 functionResponse 的 user 消息"上 | `preserveRecentMessages` / `preserveRecentTokens`（内核按 turn 完整性处理） | 本仓按"消息条/ token"而不是"字符比例"，口径更稳 |
| 摘要用哪个模型 | Aider `--weak-model`；Anthropic SDK `compaction_control.model`；Gemini 用独立 alias + 独立 client | **本仓是"模型驱动"**——摘要由**模型自己调 `compress` 工具**产出，没有独立的摘要模型 | 见 §4.6：子 Agent 场景下"模型驱动"有一个副作用（手册诱导越权） |
| 缓存代价意识 | Anthropic 明确 `clear_*` 会使缓存从编辑点失效 ⇒ 设 `clear_at_least` 下限 | 本仓 `MANUAL_INJECT_MARGIN` 注释里做了同性质的量化（一次前缀翻转 ≈ 95K token-equiv，回本要 366 次） | 持平甚至更细 |
| 配置分层 | Codex：user `config.toml` → project `.codex/config.toml` → profile → **agent 文件**；Claude Code：managed → project → user → CLI | `config.json` 单层 + CLI 推导 | 见 §4 |

---

## 3. 本仓距离"支持"还差什么（最小改动面）

按 §1 的核查，实现 per-agent（或 per-agent-档位）需要碰的点只有三个，且都不涉及重构：

1. **配置载体**：`AcpContextPluginOptions` 加一个覆盖表（或在 `compression` 段加子档位）；
2. **解析入口**：`core.session.preModel` hook（`acp-context/src/index.ts:778`）把 `input.agentId` 传进 `runPreModel`，在 `runPreModel` 里把闭包 `config` 换成 `resolveConfigFor(agentId)`；
3. **第二个入口**：`compress` / `decompress` / `acp_status` 三个工具的 `call()` 用的是同一份闭包 `config`（如 `:713` `engine.status(sctx.state, tokenCount, config)`）——必须**同时**改成按 `ctx.agentId` 解析，否则"决策用一套、工具报表用另一套"，就是本仓最忌讳的口径分裂。

不需要动的：`engine`（纯状态机，`config` 每次调用传入）、会话状态结构、内核、遥测格式（`compressRatio` 等照旧）。

**唯一要提防的**：`resolveAcpConfig()` 是纯函数，按 agent 解析后必须保证同一 `agentId` **每次得到同一份 config 引用/内容**（否则遥测里的"配置快照"会和实际决策漂移）。

---

## 4. 方案选项

### 4.1 方案 A：per-agent 覆盖表（Codex 式，最完整）

```jsonc
// config.json
"compression": {
  "preserveRecentTokens": 20000,          // 全局默认
  "perAgent": {
    "reader":   { "preserveRecentTokens": 60000, "tiers": { "tier2Trigger": 20 } },  // 只读、短命：少压
    "reviewer": { "nudge": { "maxContextLimitPct": 0.5 } },                          // 早压
    "coordinator": { "toolIds": ["acp_status"] }                                     // 只给状态、不给 compress
  }
}
```

- **优点**：表达力最强；与 Codex 的成熟形态对齐；能顺手修 §1.5 的窗口错配（`perAgent.X.modelContextLimit`）。
- **成本**：配置面变大；`checkCompressionConfig` 要加一层键校验与"未知 agentId"告警（否则又是静默失效）；测试要覆盖"两个 agent 同轮不同 config"。
- **风险**：**这是给一个还没被证明存在的需求做满配**。续 218 的取证结论很明确——子 Agent 的 12 次压缩类调用**全部**撞白名单，问题在"该不该给它看到手册/工具"，不在"参数不合适"。

### 4.2 方案 B：写进 agent frontmatter（最直观，但**不推荐**）

```markdown
<!-- ~/.harness/agents/reader.md -->
---
tools: [read_file, list_dir, glob, grep_file]
compression:
  preserveRecentTokens: 60000
---
```

- **致命问题**（§1.6）：`agentFromMarkdown` 是逐字段白名单解析，**加了这个键会静默忽略**。要让它生效，必须①改解析器、②扩 `AgentDefinition` 类型、③在 CLI 装配期把 agent 定义读进来做合并——**而 CLI 装配插件时（`:2691`）手里并没有 agent 注册表**（agent 注册发生在 harness 启动后，`subagent` 插件是 `core.harness.start` 才看到 registry）。
- **架构上也别扭**：这会让"压缩"从**插件的能力**变成**agent 定义的能力**，与 `AgentDefinition` 现有职责（工具/权限/模型/prompt/协作）不同源。
- **结论**：❌ 除非同时接受上面三项改动，否则就是造幽灵配置。

### 4.3 方案 B′：只加"子 Agent 档位"（**推荐**）

不做 per-agent 细粒度覆盖，只回答一个粗粒度问题：**"跑在子会话里时，压缩策略要不要不一样？"**

```jsonc
"compression": {
  // 全局（主会话）参数照旧
  "preserveRecentTokens": 20000,
  // 子会话（parentId 非空）时叠加的覆盖；缺省 {} = 与主会话完全一致（保持现状）
  "subagent": {
    "preserveRecentTokens": 60000,
    "tiers": { "tier2Trigger": 20 },
    "toolIds": []            // 例如：子 Agent 不给 compress/acp_status（治 P0-1）
  }
}
```

- **判据来源**：会话是否有 `parentId`（子会话创建时必带，`subagent/src/index.ts:1109`）；或者更严格——`input.agentId !== 主 agent id`。**建议用 `parentId`**：它表达的是"这是个被派出来的短命会话"，而不是"这个 agent 名是谁"（同名 agent 既可能当主 agent 也可能当子 agent）。
- **优点**：配置面只加一个键，语义一句话讲清；能让 `toolIds: []` 一把掐掉"只读子 Agent 被手册诱导调 `compress`"这条 P0-1（治本，不是治症状）；风险低，缺省行为与现状**逐位一致**（反向验证容易做：不配 `subagent` 时测试必须一字不动全绿）。
- **代价**：表达力止步于"主 vs 子"。要更细就得升级到 A。
- **升级路径**：`subagent` 与 `perAgent` **不冲突**——先上 B′，若日后真出现"reader 和 reviewer 需要不同参数"的实测证据，再把 `perAgent` 叠在 `subagent` 之上（优先级：`perAgent[agentId]` > `subagent` > 全局）。

### 4.4 方案 C：明确不做（把结论写进配置文档）

在 `docs/acp-context-config.md` 加一节"为什么压缩是全局的"，并说明：
本仓子 Agent 走的是**模式①（隔离 + 摘要回传）**——它的上下文是**新的**、寿命是**短的**（有 `maxSteps` 兜底），压缩本身在子会话里就是个低频事件；真正需要管的是**别让子 Agent 白烧 tokens**（续 218 的两个 P0 都是这个性质）。

- **优点**：零成本、零风险。
- **缺点**：`toolIds: []` 这类"只想给子 Agent 关掉压缩工具"的朴素需求**没有出口**——而它恰好是有实测证据支持的那一个。

### 4.5 取舍表

| | A（per-agent） | B（frontmatter） | **B′（子 Agent 档位）** | C（不做） |
|---|---|---|---|---|
| 表达力 | ★★★ | ★★★（但要改三处） | ★★ | ☆ |
| 改动面 | 中（配置校验 + 2 个解析点 + 测试） | **大**（解析器 + 类型 + 装配时序） | **小**（+1 键，2 个解析点） | 零 |
| 能治 P0-1（手册诱导越权） | ✅（但要逐 agent 写） | ✅ | ✅（一个 `toolIds: []`） | ❌ |
| 缺省行为是否不变 | 是 | 是 | **是**（不配 `subagent` = 现状） | 是 |
| 静默失效风险 | 低（校验兜住） | **高**（§1.6） | 低 | — |
| 与业界的对应 | Codex | — | — | Claude Code / OpenCode / Gemini CLI |

### 4.6 顺带值得记下的两条观察

1. **本仓的"模型驱动压缩"在子会话里有个特有问题**：摘要由模型自己调 `compress` 产出（不是 Aider / Anthropic 那种"独立摘要模型"）。这意味着**每个子 Agent 都得看懂手册、判断时机、构造入参** —— 而只读子 Agent 连 `compress` 工具都没有。续 218 的取证已经量化了后果：跨过 31.5% 占用率的 **4/4 子会话全调、未跨过的 0/5 全没调，零例外**，12 次全被拒。**"手册注入是否应该按能力边界决定"和"压缩参数是否 per-agent"是两个问题，但同源**——都是"插件不知道对面是谁"。
2. **§1.5 的窗口错配应独立修**：`modelContextLimit` 只认默认 Provider，而模型可以按 agent / 按次派工覆盖。这个修法与 A/B′ 无关，属"口径必须一致"的既有约定（`tokenCalibration` 那条注释就是同一类教训）。

---

## 5. 若采纳 B′：验证要点（按本仓三段式）

1. **typecheck**：39 包 0 error；
2. **全量 `bun run test`**（**必须**用 `bun run test`，裸 `bun test` 会从仓库根递归抓 805 文件）与基线对齐。**关键**：不配 `subagent` 时既有用例必须**一字不动全绿**——这是"缺省零行为变更"的控制组；
3. **反向验证**（"变红"才是断言有效的证据）：
   - 摘掉"按 `parentId` 取子档位"的判断 ⇒ **主会话**用例必须红（证明判据真的在按会话分支）；
   - 把 `subagent` 档位写死成全局默认 ⇒ 新增的"子会话用子档位"用例必须红；
   - **归因要写清楚**：如果只红子会话、主会话全绿，那是**对的**（说明覆盖是单向叠加的），别写成"覆盖没生效"。

---

## 6. 未决 / 建议先议后动

1. **判据选 `parentId` 还是 `agentId`**：前者表达"短命派生会话"，后者表达"角色"。本仓同名 agent 两种身份都可能出现，倾向 `parentId`，但这是**产品口径决策**。
2. **`subagent` 档位的默认值**：建议 `undefined`（= 与主会话一致），把"要不要更激进"留给用户。若倾向给默认值，必须先在真机上量出"子会话平均寿命 / 占用率峰值"再定，不能拍。
3. **`toolIds: []` 是否会误伤**：若子 Agent 被派去做**长**任务（如 `reviewer` 跑满 `maxSteps`），关掉 `compress` 会让它撞窗口。这与 §4.6-① 是同一个问题的两面——**建议和"手册按能力注入"一起议**。

---

## 7. 参考来源

**本仓（行号为核查时点）**
- `packages/cli/src/index.ts:360-432`（`compression` 配置段）/ `:1530-1534`（`resolveContextWindowTokens`）/ `:2691-2731`（装配点）
- `packages/plugins/acp-context/src/index.ts:261-326`（插件 options）/ `:408-417`（`resolveAcpConfig`）/ `:423-465`（工厂闭包）/ `:778-806`（preModel hook）/ `:707-727`（工具用闭包 config）
- `packages/plugin/src/index.ts:215-223`（`SessionPreModelInput`，含 `agentId`/`providerId`/`modelId`）
- `packages/tool/src/index.ts:529-533`（`ToolContext.agentId`）
- `packages/agent/src/index.ts:89-190`（`AgentDefinition`）/ `:445-560`（`agentFromMarkdown` 逐字段解析）/ `:507-519`（未知/已删字段的处理）
- `packages/plugins/subagent/src/index.ts:1107-1112`（子会话创建，无 spawn/fork）
- `packages/core/src/index.ts:2538-2546`（per-agent / per-spawn 模型覆盖）
- `packages/plugins/acp-context/src/telemetry.ts:47-48`（`occupancy` / `compressRatio`）
- `node_modules/acp-kernel@0.0.63/dist/types.d.ts`（`Config` / `TierConfig` / `NudgeConfig` / `TruncateConfig` / `CompressValidationConfig` / `AbsorbConfig`）

**业内**
- Claude Code — 子代理文档（frontmatter 字段全表；"compaction 用与主对话相同的逻辑、相同触发条件，`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 同样适用"）：<https://code.claude.com/docs/en/sub-agents>
- Claude Code — 模型与自动压缩窗口（`autoCompactEnabled` / `autoCompactWindow` 100K–1M / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS`）：<https://code.claude.com/docs/en/model-config>
- Codex CLI — 子代理与自定义 agent（"configuration layers for spawned sessions"；`[agents].default_subagent_model` 等）：<https://developers.openai.com/codex/subagents>
- Codex CLI — 配置样例（`model_context_window` / `model_auto_compact_token_limit` / `tool_output_token_limit` / `compact_prompt`）：<https://developers.openai.com/codex/config-sample>
- Codex CLI — 配置参考（`agents.*` 全表 / profile 文件）：<https://learn.chatgpt.com/docs/config-file/config-reference>
- OpenCode — 配置（`compaction.{auto,prune,reserved}`，顶层）：<https://opencode.ai/docs/config/>
- Gemini CLI — 配置参考（`model.compressionThreshold` 默认 0.5、`modelConfigs.overrides`）：<https://geminicli.com/docs/reference/configuration>
- Gemini CLI — 配置项逐条镜像（`compressionThreshold` 说明 + `agents.overrides`「按 agent 覆盖 model config / run config」；官方参考页未收录该节）：<https://gemini.openml.io/reference/configuration>
- Gemini CLI — 压缩实现深读（50000 token 工具输出预算、按字符 70% 切点、独立摘要 client）：<https://gist.github.com/sam-saffron-jarvis/0503a15eeb261fc5f6be3ba253e1e645>
- Aider — options 参考（`--map-tokens` / `--max-chat-history-tokens` / `--weak-model`）：<https://github.com/Aider-AI/aider/blob/main/website/docs/options.md>
- Anthropic API — 上下文窗口与 compaction（`clear_tool_uses_*` / `clear_thinking_*` / `compact_20260112`、缓存失效与 `clear_at_least`）：<https://docs.anthropic.com/en/docs/build-with-claude/context-windows>
- Anthropic Cookbook — 成本优化（per-request `context_management`、`applied_edits` 回执）：<https://platform.claude.com/cookbook/cost-optimization-cost-optimization>
- 八框架压缩横向调查（三种"谁压谁"模式、四类策略、各维度打分）：<https://crabtalk.ai/blog/context-compaction>
- LangMem — 摘要节点（`SummarizationNode` / `max_tokens_before_summary` / `max_summary_tokens`）：<https://langchain-ai.github.io/langmem/guides/summarization/>
