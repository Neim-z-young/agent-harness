# 用量纳管（引擎层）与 ACP 手册注入的缓存方案

> 立项背景：会话 `s_1789916436883_ra6w1` 分析与 token 归因（报告见 `reference/workbuddy/`）暴露出
> 两个遗留问题：① 用量累计与写盘的**唯一实现方在 TUI 层**，headless/REPL 宿主与子 agent 会话的
> 用量完全不可见；② ACP 压缩手册刚改成"按需注入"，但它是**前缀元素**，翻转会冲掉 prompt 缓存。
> 本文给这两件事的落地方案。文中所有行号均为 2026-09-21 工作区实测。

---

## 0. 结论速览

**① 用量纳管**：把累加器从 `packages/cli` 搬到 `@harness/core`（纯函数抽成新包 `@harness/usage`），
TUI 退化为**渲染器**。核心难点不是"算"，而是**幂等**——必须带 fold checkpoint + 自愈重建，
否则重开会话会把历史消息再算一遍（**重复计数**），而这正是 `status: shouldPersistUsage` 当初要挡的坑。

**② 缓存**：按需注入的**方向对、位置错**。当前手册注入在 `system[1]`（整个历史之前），
一旦越阈值翻转，其后**全部前缀（含历史）**变为未命中：

| | 量级 |
|---|---|
| 翻转一次的成本 | ≈ **95K token-equiv**（前缀 ≈105K tokens × 未命中溢价 0.9） |
| 按需省下的成本 | ≈ **259 token-equiv/次**（1.9K tokens × 缓存命中折算 0.137） |
| 回本需要 | ≈ **366 次调用** |

⇒ 对**会越阈值的会话是净亏**，对不越阈值的会话是纯赚（ra6w1 峰值仅 13.3%，属后者）。
改法：**变量部分改用 `user` role 注入到尾部**（与 nudge 同位置），前缀只留常量 → 两个场景都纯赚。

> ⚠️ 不能用 `system` role 移到尾部：`provider-anthropic:125` 的 `extractSystemPrompt` 与
> `provider-gemini:117` 的 `extractSystem` 会把**任意位置**的 system 消息上提进顶层 system /
> systemInstruction 字段（`provider-anthropic:215`、`provider-gemini:211` 跳过原位置）——
> 移到尾部等于**白移**。只有 OpenAI（`provider-openai:173-179`）保持原序。nudge 早就用 `user`
> role 注入尾部（`acp-context:997`），是现成的正确先例。

---

## 1. 证据基线

| # | 事实 | 证据 |
|---|---|---|
| 1 | 每次调用的 usage 引擎侧**已经拿得到** | `core:1994` 声明 → `core:2047`（流式 chunk）/ `core:2089`（complete）赋值 |
| 2 | 已经落在消息上、且随消息落盘 | `core:2105-2115` 写 `assistant.meta.tokenUsage {input,output,cacheRead,cacheWrite}`，`core:2266` 入库 |
| 3 | 累加与写盘的**唯一实现方**在 TUI | `tui.tsx:1085-1115`（`recordCall`/`recordTool`）、`tui.tsx:1220-1222`（写 `meta[USAGE_STATS_KEY]` + 800ms 防抖落盘） |
| 4 | 累加器是**零依赖纯函数**，可抽包 | `usage-stats.ts:111 recordCall` / `:200 recordTool` / `:309 mergeUsage` / `:391 sumUsage` |
| 5 | 已存在"从消息重建用量"的能力 | `usage-stats.ts:495 usageFromMessages()`（含"本轮 LLM 用量归并到紧随的首个工具"规则） |
| 6 | 会话 meta 可由引擎写 | `core:951 updateMeta(sessionId, patch)`；`:1056` 已有同款写法 |
| 7 | 子 agent 会话走**同一条**引擎路径 | subagent 内部 `session.create()` 后仍由 `core._runOneStep` 执行 ⇒ 引擎层累加自动覆盖 |
| 8 | provider 侧缓存命中**当前无数据** | `telemetry.ts:214 buildProviderCacheEvent` **只有定义、全仓无调用方**（注释称"由 core 层追加"，实际未接线） |
| 9 | 全仓**无人设置**显式缓存断点 | `cache_control` / `cachedContent` 均只出现在"读用量"侧 ⇒ 缓存全依赖 provider 自动前缀缓存 |
| 10 | ACP 手册注入点与 nudge 注入点 | 手册 `acp-context:973-974`（`system`）；nudge `acp-context:997`（`user`，尾部） |
| 11 | ra6w1 从未越阈值 | 遥测 33 轮 `preModel`，占用率 0.009→0.133，阈值 `0.35×0.9=0.315`，**越阈轮次为空** |

---

## 2. 方案 A：用量纳管搬到引擎层

### 2.1 口径分裂的实质

```
现在（两条链，互不知情）：
  引擎：assistant.meta.tokenUsage  ──→  随消息落盘（所有宿主都有）
  宿主：TUI 内存累加器            ──→  sess.meta[usageStats]（只有 TUI 写）
                                   └─→  headless / REPL / ACP 宿主 / 子会话 → 无人写 → 用量不可见
```

子 agent 那约 1.5M 输入 token 之所以"不入账"，不是子 agent 特殊，而是**它没有 TUI**。

### 2.2 目标 / 非目标

**目标**
1. 任何宿主（TUI / REPL / headless / ACP）与任何会话（含子 agent）都有 `meta.usageStats`；
2. 同一会话的用量**只被累加一次**（幂等），重复打开不翻倍；
3. TUI 的 `/stats`、`/stats-export`、重连后数字与落盘一致（口径单一）。

**非目标**（本次不做）
- 计费换算（不同 provider 单价不同，保持"token 口径"）；
- 实时推送（宿主轮末读一次足够，避免为展示引入每步事件）。

### 2.3 分层

```
@harness/usage（新包，纯函数，零依赖）
  ├─ UsageStats / recordCall / recordTool / recordTaskDone / mergeUsage / sumUsage
  ├─ usageFromMessages()      ← 自愈与迁移共用
  ├─ hydrateUsage / renderStatsText / usageFromLines…
  └─ foldAssistantStep(usage, message) ← 新增：单步折叠（与 usageFromMessages 同一套规则）

@harness/core
  └─ 唯一累加者：每步结束时 foldAssistantStep → session.updateMeta(USAGE_STATS_KEY)
                  + checkpoint（见 2.4）

宿主（cli/tui、repl、headless、acp）
  └─ 只读：harness.usage.get(sessionId) / 读 session.meta[USAGE_STATS_KEY] 渲染
```

- `packages/cli/src/usage-stats.ts` 变为**薄再导出**（`export * from '@harness/usage'`），
  保 378 个 cli 测试与既有一切导入不动 —— 与 `tui.tsx:698-712` 现有 re-export 手法一致。
- core 新增只读 API：`harness.usage.get(sessionId) → UsageStats`，内部即 `hydrateUsage(session.meta)`。

### 2.4 关键正确性：fold checkpoint + 自愈（**这是本方案唯一的硬骨头**）

引擎每步折叠一次，就必须回答"这一步算过没有"。规则：

1. **checkpoint**：在 `meta.usageStats` 旁存 `usageFold: { upToMessageId: string }` —— 已折叠到的
   assistant 消息 id（会话内消息**追加为主**，最后一个已折叠 id 足以定位）；
2. **正常打开**：读 `hydrateUsage(meta)` 作为起点，只折叠 id **不在** checkpoint 之前的部分（增量）；
3. **自愈**：若 checkpoint 的 id 在消息列表里**找不到**（被 `/compact`、`deleteMessage`、手工编辑
   破坏），放弃增量、用 `usageFromMessages(messages)` **全量重建**并重写 checkpoint。
   —— 这条是必需的：`usageFromMessages` 已存在且经过测试，重建比"猜测漏算了什么"更可靠；
4. **写入时机**：复用刚上线（续 173）的脏会话机制——`updateMeta` 会标脏，CLI 在轮末
   `flushDirtySessions()` 落盘。**不要**在引擎里直接 `sessionStore.save`（会与宿主写盘打架）。
5. **子会话**：无特殊处理，`_runOneStep` 自动覆盖；父会话只做**展示层聚合**（见 §5 待拍板）。

> 反例警告（历史教训）：`tui.tsx` 模块 4 注释里记的"空累积器覆盖已持久化历史 ⇒ 重连后清零"
> 就是**没有 checkpoint/幂等设计**的后果。搬到引擎层时若只搬逻辑不搬幂等，会把同一个 bug
> 从'清零'变成'翻倍'。

### 2.5 落地阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** | 抽包 `@harness/usage`；cli 侧改再导出 | 全量测试仍 1665 pass；cli 378 例不动 |
| **P2** | core 折叠 + checkpoint + 自愈 + `harness.usage.get`；**移除** TUI 对 `meta` 的写入（保留内存展示，改从引擎读） | 新增：① 同一会话重开两次，用量**不翻倍**；② checkpoint 被破坏 ⇒ 自愈重建且数值与 `usageFromMessages` 一致；③ 子 agent 会话 `meta.usageStats` 非空；④ headless `run` 也写出 `meta.usageStats` |
| **P3** | 接 `providerCache` 遥测（见 §3.7）；`/stats` 增"缓存命中率"行 | 遥测出现 `kind:'providerCache'` 行；与 usage 侧 `cacheReadTokens` 对得上 |
| **P4** | 展示层：父会话聚合子 agent 用量（可选，见 §5） | `/stats` 能区分"本会话 / 含子 agent" |

### 2.6 风险与回退

- **风险 1：双写期数字打架**。P2 若与旧 TUI 并存（同一次会话被新旧代码先后打开），
  以 checkpoint 为准即可收敛（第 3 条的 id 找不到就会重建）。为稳妥，P2 上线时把 TUI 写盘
  一并**在同一提交里**删掉，不留中间态。
- **风险 2：`updateMeta` 频率**。折叠发生在每步结束，`updateMeta` 是内存更新（标脏），
  真正 IO 由已有的 800ms/轮末防抖承担 ⇒ 不引入新 IO 压力。
- **回退**：`@harness/usage` 是纯函数，回退只需让 TUI 恢复为累加者（保留本方案的再导出层即可）。

---

## 3. 方案 B：ACP 手册注入的缓存修正

### 3.1 前缀缓存的几何

请求布局（`acp-context:960-1000`）：

```
[ system(Agent 提示) ][ system(手册 | 提示行) ][ …整段历史 … ][ (可选) nudge(user) ]
   ↑ 常量                ↑ 现在在这里：变量、且在前缀最前面          ↑ 尾部：变量，天然不伤缓存
```

自动前缀缓存按**最长公共 token 前缀**命中。手册在第 2 位 ⇒ 它一变，**后面全不匹配**（含历史）。

### 3.2 翻转频率：几乎不会来回抖

占用率 = `estimateTokens(res.messages)/modelContextLimit`（与遥测同公式，`acp-context:968-973`）。
历史只追加 ⇒ **占用率单调不减**，唯一下降来源是"真的压缩了"。所以：

- 未越阈值：始终 `HINT`（常量）⇒ 缓存正常；
- 首次越 `0.315`：`HINT → 全部手册`，**一次失效**；
- 之后：手册保持（占用率不回落）⇒ 缓存恢复正常；
- 压缩后若占用率掉回 `0.315` 以下：`手册 → HINT`，**看似第二次失效 —— 但那一轮历史本身已被
  改写**（`acp-context:931-933` 检测消息数变化即 `ctx.needFull`，provider 侧同样必然 miss），
  **等于免费**。

⇒ 有效翻转次数 ≈ **1 次/会话**（对会越阈值的会话）。问题不在频率，在这 1 次的**代价**。

### 3.3 代价量化（为什么必须改位置）

越阈值时的前缀规模 = 工具载荷 8,354 tok + system 2,504 tok + 历史 `0.315×300K = 94,500` tok
≈ **105K tokens**。翻转使这些 token 由"命中价（≈0.1×）"变成"全价（1×）"：

```
一次翻转的额外成本 ≈ 105K × 0.9 ≈ 94.5K token-equiv
按需注入的收益     ≈ 1,888 tok/次 × 0.137 ≈ 259 token-equiv/次
回本需要           ≈ 366 次调用
```

也就是说：**短会话（不越阈值）赚，长会话（越阈值，正是需要压缩的那类）亏**。
根因不是"要不要按需"，而是"把变量放进了前缀"。

### 3.4 改法：常量在前缀、变量在尾部、兜底在工具文档

| 位置 | 放什么 | 性质 |
|---|---|---|
| `system[1]`（前缀，常量） | 极简提示行（现有 `COMPRESS_MANUAL_HINT`，57 字符） | **永不变化** ⇒ 零缓存代价 |
| 尾部（`user` role，变量） | 完整手册；仅当 `occupancy ≥ minContextLimitPct × 0.9` **或** nudge 将要注入时 | 与 nudge 同位置、同 role ⇒ 不进入前缀 |
| `compress` 工具的 `documentation`（已做） | 223 字符的"何时压/给什么"要点 | 在工具载荷里，常量、随缓存复用 |

实现要点（`acp-context:960-1000`）：

```ts
// 1) 前缀只留常量（行为不变）
request.push(deps.tempMessage('system', COMPRESS_MANUAL_HINT, sessionId))

// 2) 渲染历史（原逻辑不动）…

// 3) 尾部：手册与 nudge **合并进同一条 user 消息**（避免两条相邻临时消息各触发一次尾部差异）
const needFullManual = deps.manualInjection === 'always'
  || deps.explicitSystemPrompt === true
  || occupancy >= manualThreshold
const nudgeText = res.nudge?.shouldInject ? renderNudgeText(res.nudge, deps.prompts).text : ''
if (needFullManual || nudgeText) {
  const tail = [nudgeText, needFullManual ? deps.makeSystemPrompt() : ''].filter(Boolean).join('\n\n')
  request.push(deps.tempMessage('user', tail, sessionId))
}
```

- `manualInjection: 'always'` 语义改为"每轮都在尾部注入完整手册"（**缓存代价仍为 0**，
  因为它不再进前缀）；这比现在的"回到旧行为（进前缀）"更好，也顺手把该选项从"缓存陷阱开关"
  变成"提示强度开关"；
- `systemPrompt` 显式覆盖 ⇒ 同上，始终在尾部注入（保持"用户显式要求优先"）；
- 不要用 `system` role（§0 的 ⚠️）。

### 3.5 顺带发现：Anthropic 侧**根本没有缓存**

`cache_control` 全仓无人设置（§1 第 9 条），而 Anthropic 的 prompt caching 需要显式断点
（`cache_control: {type:'ephemeral'}`）才会启用。也就是说：

- **DeepSeek / OpenAI / Gemini 用户**：走自动前缀缓存 → §3.3 的位置分析成立，本方案收益为正；
- **Anthropic 用户**：压根没有缓存 ⇒ 按需注入**纯省**（省的是全价 token），但同时说明
  Anthropic 侧一直在**全额重付 system + 工具 + 历史** —— 这是个比手册大小大得多的优化空间，
  建议单独立项（加 1~2 个断点：工具+system 之后一个、历史尾部一个）。

### 3.6 为什么这方案不牺牲压缩能力

"手册只在需要时出现"完全符合手册本身的用途——它教模型**何时压、怎么给 range**，而模型决定
压缩的时机由 nudge 驱动。尾部注入让手册与 nudge **同轮出现、位置相邻**，可读性反而优于
"手册 8K 字符埋在第 2 位、nudge 在尾部"的现状。持久信息仍由 `compress` 工具文档承载。

### 3.7 验收前提：先把 provider 缓存接上遥测

现在**无法用数据回答"缓存命中受影响吗"**，因为 `buildProviderCacheEvent`（`telemetry.ts:214`）
从未被调用。接线方式（保持分层，core 不反向依赖 acp-context）：

```
core（拿到 tokenUsage 处，core:2105 附近）
  └─ bus.publish('provider.usage', { sessionId, round, cacheRead, cacheWrite, input, output })
       └─ acp-context 订阅 → appendTelemetry(buildProviderCacheEvent(...))
```

验收标准（做 A/B）：
1. 构造一个**必然越阈值**的小窗口会话（如 `modelContextLimit: 6000`，跑 20+ 轮）；
2. 记录每轮 `providerCache.cacheRead`；预期：改位置前有**一次骤降**（≈ 前缀规模），改位置后
   无骤降、全程平滑；
3. 对照 `acpCacheHit`（ACP 自己的渲染前缀命中）区分"ACP 层失效"与"provider 层失效"。

---

## 4. 顺带修掉的两个小缺陷

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 1 | `buildProviderCacheEvent` 死代码 ⇒ provider 缓存命中**无数据** | `telemetry.ts:214` | §3.7 的 bus 接线 |
| 2 | CLI 无法透传 `compression.manualInjection`（只能吃默认值） | `cli/src/index.ts:2638` 附近 | 装配处补一个透传键；做成对照实验的开关 |

---

## 5. 待拍板

1. **`@harness/usage` 独立成包，还是直接放进 core？**
   它零依赖、约 600 行纯函数。独立包的收益是"宿主可复用、core 不膨胀"；塞进 core 的收益是
   少一个包、少一次 workspace 变更。我倾向前者（cli 侧要长期再导出，独立包语义更清晰）。
2. **父会话是否把子 agent 用量并入总数？**
   子会话现在有独立 `meta.usageStats`，父会话要看"这条链一共花了多少"就得聚合。建议：
   `meta.usageStats` 保持**本会话**口径（不合并，避免历史会话里出现"同一个子会话被算两次"），
   展示层提供"含子 agent"一行（数据齐备，随时可加）。
3. **手册最终形态**：尾部注入（本方案）还是**完全不注入**（只留工具文档 + nudge 文案）？
   后者更省，但会削弱"何时该压"的教学。建议先做尾部注入，观察压缩触发率是否变化。
4. **Anthropic 显式缓存**是否立项？（§3.5，收益量级可能远大于本方案）

---

## 6. 建议的推进顺序

```
P1 抽包（低风险、无行为变化）
 → P2 core 折叠 + checkpoint/自愈（本方案主要工程量）
 → 方案 B 的位置修正（小改动、大收益、可独立验证）
 → P3 providerCache 遥测接线 + A/B 验证（给方案 B 提供证据）
 → P4 展示层聚合 / Anthropic 缓存（另议）
```

> P1/P2 与方案 B **无依赖**，可以并行推进；方案 B 的建议顺序是"先改位置、再用 P3 的遥测证明"。

---

## 7. 落地状态与真机验证（2026-09-21）

§5 的四项拍板结果：**`@harness/usage` 独立成包**；`meta.usageStats` 保持**本会话**口径 +
展示层给"含子 agent"一行；**ACP 手册改尾部注入**（变量不进前缀）；Anthropic 显式缓存
**已实现但默认关**（见 §7.7，等 key 验收）。§7.8 列当前真正剩余的事项。

### 7.1 落点对照

| 项 | 实际落点 |
|---|---|
| P1 抽包 | `packages/usage`（零依赖纯函数，647 行）；`cli/src/usage-stats.ts` 变**薄再导出**，cli 351 例不动 |
| P2 增量折叠 | core `_runOneStep` 末尾 `accumulateUsage()` → `foldMessage()` + `meta.usageFold` 检查点 |
| P2 幂等/自愈 | 检查点 id 失效 ⇒ `rebuildUsage(messages)`；增量与重建**共用** `foldMessage`（有等价性测试） |
| P2 宿主只读 | TUI 删掉写 meta 与 800ms 防抖落盘，轮末 `harness.usage.get()` 对账；落盘交给脏会话刷盘 |
| P3 缓存可观测 | 新 hook `core.llm.usage`（引擎广播 provider 用量）→ acp-context 落 `providerCache` 遥测行 |
| P4 展示聚合 | `harness.usage.children()` + `/stats` 的"含子 agent"行（`renderChildAgentRollup`） |
| B 缓存位置 | 前缀只留 `COMPRESS_MANUAL_HINT`；完整手册改 `user` role 注入**尾部**，与 nudge 合并成一条消息 |

### 7.2 真机验证①：注入几何（方案 B 的关键一格）

小窗口（`modelContextLimit: 6000`）+ 低阈值（`minContextLimitPct: 0.25`）逼出"越阈值"那一刻，
用取证插件抓每轮最终请求：

| 轮 | 消息数 | 前缀 system 长度 | 前缀指纹 | 尾部临时消息 |
|---|---|---|---|---|
| req-01 … 05 | 3→10 | **738** | `8b13b862` | 无 |
| **req-06**（越阈值） | 12 | **738（未变）** | `8b13b862` | **1 条，含 8365 字符手册** |
| req-07 / 08（子会话自己的轮） | 3 / 4 | 5884 | `94b4b232` | 无 |
| req-09（父会话下一轮） | 15 | **738** | `8b13b862` | 1 条，含手册 |

⇒ **手册出现的那一刻，前缀字节未变**（`8b13b862` 全程恒定），手册落在尾部。
改造前这一轮会把 `system[1]` 从 738 换成 8365，其后整段历史全部重算（§3.3 的 95K token-equiv）。

### 7.3 真机验证②：providerCache 遥测 + 缓存未塌陷

`providerCache` 行（新接线，此前该 builder 是死代码）：

```
主会话 round: 1      2      3      4      5      6      7
cacheRead  : 1920   9344   9600   9984   10112  10752  10752
```

**第 6 轮（手册首次出现）cacheRead 没有塌陷**（10112 → 10752，继续增长）——这正是"变量没进前缀"
的直接证据；若按旧实现，该轮的 cacheRead 会掉到只覆盖工具+首条 system 的量级。

### 7.4 真机验证③：子 agent 用量终于入账

同一次运行里派了一个后台子 agent（`runInBackground`），落盘结果：

| 会话 | 消息数 | `usageStats` | `parentId` |
|---|---|---|---|
| 主会话 `s_..._iplox` | 12 | 调用 7 · in 75,918 / out 1,704 · cacheRead 62,464 | 无 |
| **子会话 `s_session_..._9ou7q`** | **3** | **调用 2 · in 19,687 · cacheRead 18,048** | 顶层 `parentId` = 主会话 |

改造前子会话**连 `.json` 都没有**（只有遥测），用量自然为 0；现在 `/stats` 的"今日 9 次"
= 主会话 7 + 子会话 2，子 agent 成本终于可核对。

### 7.5 真机暴露并修掉的一个取值错误

`usage.children()` 最初按 `meta.parentId` 反查 ⇒ 真机上永远为空（`/stats` 聚合行不出现）。
核对落盘字段发现 **`parentId` 是 Session 的顶层字段**（`session.create({ parentId })`，
subagent 派生与 CLI 恢复都用它），`meta.parentId` 恒为 null。已改为读顶层字段并补测试。
教训与 §1 的"路径/口径分裂"同源：**先确认真实落盘字段，再写取值代码**。

### 7.6 验证汇总

- 全量 **1683 pass / 0 fail**（+6 核心守卫、+2 providerCache、+3 聚合行、+5 折叠等价性…），typecheck 0 错误；
- 真机三条链路各自独立验证（注入几何、缓存遥测、子会话用量），另有 `/stats` 聚合行；
- 未做（当前剩余的完整清单见 §7.8）；`harness run`（headless）目前没有用量展示入口 ——
  `meta.usageStats` 引擎侧照写不误，但"含子 agent"聚合行只在 REPL/TUI 的 `/stats` 呈现。

### 7.7 Anthropic 显式缓存：已实现，但**默认关、未验收**（2026-09-21 追加）

§3.5 指出的"Anthropic 侧压根没开缓存"已实现（`AnthropicProviderConfig.promptCache`）：
3 个断点（协议上限 4）＝ `tools` 末尾 / `system`（换成 block 数组）/ 当前对话末尾；
独立纯函数 `applyAnthropicCacheBreakpoints()` 便于单测。顺带把 `complete`/`stream` 里**逐字重复的
两份 `buildBody`** 合并成一份（重构当场被测试抓到一处漏改的 `model` 引用）。

**为什么默认 `false`**：开发机只有 DeepSeek 的 key，**没有 Anthropic key ⇒ 无法真机验收**。
按 AGENTS.md「与外部服务对接以真机为准」，未验收的行为不默认影响用户。只做了请求体形状单测（5 例）。

**拿到 key 后的验收步骤**（通过后再把默认值翻成 true）：
1. 同前缀连发两次请求 ⇒ 第二次 `usage.cache_read_input_tokens > 0`；
2. `cache_creation_input_tokens` 只在首次 / 前缀变化时出现（而不是每轮都写）；
3. 顺带验一个**静默失效**点：可缓存前缀有**最小 token 门槛**，不足时不报错也不缓存。

### 7.8 当前剩余事项（按性价比排序）

| # | 事项 | 状态 | 阻塞 |
|---|---|---|---|
| 1 | **工具载荷按需化**（token 归因报告的建议 #1） | **已做**（续 176） | 9 个现有 agent 改按角色白名单 + 新增 7 个轻量子 agent。真机基线 41 工具/23,674 字符 → coordinator −49%、合规审查员 −87%、reader −90%、summarizer −100%（详见 `docs/development-log.md` 续 176）。注意改动落在仓库外的 `~/.harness/agents/`，未进 git |
| 2 | **Anthropic 缓存真机验收** | 代码已就绪（默认关） | **需要 Anthropic key**；用户已定「先不做」，保持默认关 |
| 3 | **技能 `paths` 条件触发接线** | **未做**（`matchByPath` 仍是死代码，只有测试引用它） | 无。frontmatter 里写 `paths` 目前**写了不生效** —— 属"承诺了但没落地"，也正是本项目最忌的静默失效模式 |
| 4 | `@harness/permission` 之外的匹配语义 | 已做（`**/` 修正 + 12 例测试） | — |
| 5 | `/stats` 给缓存**命中率**（百分比） | 未做（现只印绝对值 `命中 X，写入 Y，未命中 Z`） | 无，很小 |
| 6 | headless（`harness run`）的用量展示入口 | 未做 | 无，小 |
| 7 | **重复侦察结果复用**（token 报告建议 #5） | 未做 | 需先定"时效性"判定，风险中等 |
| 8 | 工具 schema 文案精简（token 报告建议 #6） | **刻意不做** | 与续 160「让模型看懂参数」的目标相反，需权衡 |

已完成的（对照 token 归因报告的 6 条建议）：**#2 子 agent 用量纳管** ✅、**#3 ACP 手册按需注入** ✅
（且进一步改成尾部注入，见 §3/§7.2）、**#4 结果通道去重** ✅。
记忆与技能锻造线（`docs/memory-and-skill-forge-plan.md`）的 M0~M3.1 / F0~F3 **全部完成并已串联**。

---

## 8. 两个待做项方案细化（2026-09-22 补充）

对 §7.8 的 #3（技能 paths 条件触发）与 #7（重复侦察结果复用）做方案设计。两者都受同一条
**前缀缓存几何**约束（§3.3 的推广）：会变的文本绝不能进前缀。

### 8.1 技能 `paths` 条件触发：接线位置必须走尾部动态通道

**现状**（§7.8 #3）：`matchByPath` 已实现（`skill/src/index.ts:513`，glob 匹配 `skill.paths`），
但全仓无调用方 —— frontmatter 写 `paths` 不生效。真正注入走 `core.skill-injection`
（`core/src/index.ts:3116-3135`）：白名单技能 → `core.prompt.system.transform` → `sysParts`（**前缀**）。

**为什么不能直接在前缀接 paths**：paths 触发 = 注入内容**随轮变化**（本轮涉及 `src/foo.ts` 注入技能 A、
下轮涉及 `README.md` 注入技能 B）。白名单注入当前安全，只因为 `agent.skills` 是常量；条件触发把
"会变的文本"放进前缀 ⇒ 每翻转一次 ≈ §3.3 同款代价（越阈值会话 ≈ 95K token-equiv）。这正是
§3.4 的"常量在前缀、变量在尾部"铁律的又一实例。

**方案**（两条通道各司其职）：
- 恒定白名单技能 → 留在 `sysParts`（内容不变，零缓存代价，现状不动）；
- paths 条件触发的技能 → 改走 `core.prompt.dynamic.transform`（`dynParts`：user role 尾部、
  每轮重算、不落库），与 ACP 手册/nudge 同通道。尾部变化不伤前缀缓存，成本 ≈ 0。

**前置依赖**：需要"本轮涉及哪些路径"作为入参 —— 在 prompt 构建时收集（用户消息里显式提到的路径
+ 本轮工具调用目标的文件路径），再喂给 `matchByPath`。

**验收**：构造"不同轮涉及不同路径"的会话，抓每轮最终请求，断言前缀字节指纹恒定、命中的技能只出现在尾部。

### 8.2 重复侦察结果复用：跳过执行 + TTL 窗口 + 占位提示（不做历史折叠）

**目标**：省"重复侦察"的执行开销 + 输出 token（token 报告建议 #5）。

**方案（用户定稿，2026-09-22）**：
1. 工具执行前查缓存：**同工具 + 同参数**，且**近 10 轮对话内 或 60s 内**执行过 ⇒ 命中
   （TTL 双窗口取 OR，可配）；
2. 命中 **且上次结果 token 超过阈值**（结果不小）⇒ **跳过执行**，合成占位 `tool_result`
   `[结果与第 N 轮一致（缓存，TTL 内有效）]` —— **历史不变、不折叠**，只是本轮这条 tool_call
   对应一条短占位结果；
3. **结果 token 不多** ⇒ 不省，**直接执行拼最新数据**（执行便宜、结果新鲜，不值得省）；
4. 未命中 / 无缓存 ⇒ 照常执行。

**为什么不做历史折叠**（承接 §8.3）：折叠要改写历史中段 `tool_result` 的字节 ⇒ 断点后整段
历史从命中价变全价（`R×0.1 − L×0.9` 必亏）。本方案历史**一字不动**，跳过执行只产生**新的一条**
占位消息（末尾增量，不伤前缀缓存）——与 §3.4"变量在尾部、历史恒定"同一几何。

**过期控制（对"跳过执行会拿到旧数据"的回应）**：
- TTL 窗口（10 轮 / 60s）把"文件已变"的风险压到会话内的连续侦察场景可接受水平；
- 占位文本带轮次标注，模型知道来源、**可自行决定是否强制重跑**（需提供强制刷新通道：
  再调一次同工具同参数若仍在 TTL 内会再次命中 ⇒ 需要 `force` 参数或在占位提示里明确
  "如需刷新请改参数或等待 TTL 过期"）；
- 结果小的直接重跑 ⇒ 新鲜度关键的小结果永不走缓存。

**硬约束**：
1. **只读白名单**：只有纯只读工具（read_file / grep_file / glob 等）可走缓存；write_file /
   bash 等有副作用工具**永不跳过执行**（同参数也可能改状态）；
2. **协议约束**：跳过执行仍必须产出对应 `tool_result`（占位）——assistant 发起了 tool_call，
   provider 要求每条调用都有 result，否则报错；
3. **只读白名单之外的语义**：命中缓存时工具**实际未执行**（与 §8.2 旧 A 层不同），TTL 是
   唯一的过期护栏，窗口配置要保守。

**影响评估**：与 doom-loop 守卫互补——TTL 缓存命中时直接返回占位，模型很少再连续重复调用，
从源头缓解 doom-loop；命中即"少一次真实执行"，副作用工具被白名单排除故无安全影响。

**验收**：构造"同一 read_file 连续调用"会话，断言：TTL 内第二次调用不真实执行（占位消息，
历史字节不变、`providerCache.cacheRead` 不塌陷）；TTL 过期 / 参数变化后恢复真实执行。

### 8.3 为什么不能折叠历史工具内容（几何与量化）

**机制**：自动前缀缓存按**跨请求公共 token 前缀**命中（t2 vs t1 逐 token 比对，命中段 ≈0.1×，
断点后全价 1×）。折叠 = 改写历史里某条 `tool_result` 的字节 ⇒ t2 与 t1 的公共前缀**在该处断开**，
断点之后所有 token（含其后整段历史）从 0.1× 变 1×。

**收益 vs 损失**（R = 被折叠的重复结果 token，L = 断点后历史 token）：

```
净收益 ≈ R×0.1 − L×0.9
```

- 收益端只值 **0.1×**：不折叠时那份重复结果本来也在前缀缓存里（命中价），折叠省到的绝对值很小；
- 损失端 **0.9×/token**：断点后历史全部按未命中溢价重付。

**推论**：
- 重复结果位于**请求末尾**（L≈0）⇒ 净赚，值得折叠；
- 重复结果位于**历史中段**（后面还有大量历史，长会话几乎必然如此）⇒ `L×0.9 ≫ R×0.1`，**净亏**，
  折叠反而比不折叠更贵；
- 这也是 §3.4 ACP 手册方案"变量放尾部、历史恒定"的根源 —— 尾部变化只影响尾部，历史恒定才吃得到前缀缓存。

**结论**：折叠只对"最新一条、结果很大、确实重复"的场景有正收益；阈值与窗口必须保守，且要按
§8.1 同款"真机抓请求体"方式验证（A/B：折叠前后每轮 `providerCache.cacheRead` 是否塌陷）。
