# ACP 上下文压缩配置参考（`@harness/acp-context`）

> 本文档列出的默认值以 acp-kernel `defaultConfig(modelContextLimit)` 的**实际默认**为准
> （`node_modules/acp-kernel/dist/index.js` → `defaultConfig`）。带「🔧 = 可在 config.json 结构化配置」、
> 「⬇ = 高级透传（`compression.config`）」标注的是本项目暴露的配置入口。
>
> **如何评估/调参？** 见 [ACP 压测与离线分析脚本使用参考](./acp-context-benchmark.md)（仿真压测 + 运行时遥测 + 参数组合分析）。
>
> **能不能给子 Agent 单独设一套？** 能 —— 用 `compression.subagent`（全部子 Agent）/ `compression.perAgent.<id>`
> （指定 Agent），见 **§11**。本文 §1~§8 的键在档位段里**同名可用**。
> 设计取舍、业内对照（Claude Code / Codex / OpenCode / Gemini CLI / Aider / Anthropic API）见
> [子 Agent 压缩配置调研](./subagent-compression-config-research.md)。

## 0. 启用与入口

`config.json` 顶层 `compression` 段作为唯一装配入口。`enabled: true` 才在 CLI boot 时惰性装配
`@harness/acp-context`；缺省 `enabled` 为 **false**（默认不启用 ACP）。

```jsonc
{ "compression": { "enabled": true } }
```

参数有两种控制方式，用 `compression.autoTune` 切换（详见 **§7.4 / §7.5**）；
**要一份现成的参数表直接看 §7.5① 或速查卡 [`acp-context-param-table.md`](./acp-context-param-table.md)**：

| `autoTune` | 行为 |
|---|---|
| `false`（默认） | **原始压缩参数控制**：本文档 §2~§7 写的键取值即生效，没写的回落 kernel 默认 |
| `true` | **按上下文窗口自动适配**：`preserveRecentTokens` / `nudge.*` / `compress.minCompressRange` 由 `modelContextLimit` 推导打底，配置里显式写出的键仍优先；**除 200K/300K/1M 外的窗口都用这一档**（§7.5③） |

```jsonc
{ "compression": { "enabled": true, "autoTune": true } }   // 换窗口不用改参数
```

另有一个与参数无关、但会决定**所有百分比闸门是否可信**的开关：`compression.tokenCalibration`
（默认 `"auto"`，CJK 感知口径）。中文会话若回退成 `"chars4"`，占用率只剩真值的约 1/3~1/4，
压缩会一路拖到真实超窗之后才触发——详见 **§7.6**。

---

## 1. 模型上下文窗口（输入 tokens）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 🔧 `compression.modelContextLimit` | —（缺省走推导） | 模型输入上下文窗口，ACP 据此算 `contextUsage`、判各层压缩触发。**显式覆盖优先**。 |
| 🔧 `providers[].contextWindowTokens` | — | **模型上下文大小放模型配置**：该 Provider 实例的窗口。 |
| 窗口解析优先级 | — | `compression.modelContextLimit` → `compression.config.modelContextLimit` → **本会话实际用的 Provider / 模型** → 默认 Provider 的窗口 → 插件默认 **200_000** |

> **分母跟着会话走，不跟「默认 Provider」走。** 一个会话实际打到哪个端点，取决于该 Agent 的
> `model` 偏好（agent md frontmatter）与派工时的 `SubagentTool.model` 覆盖 —— **逐会话可以不同**；
> 而 `contextWindowTokens` 是**每个 Provider 实例**各自配的。所以占用率分母按**这一轮实际命中的端点**解析。
>
> 只认默认 Provider 的窗口会怎样：被派到小窗口端点的子 Agent，占用率**虚低**（默认端点 300K、
> 子 Agent 走 200K ⇒ 报 66% 时其实已 100%），阈值判断系统性偏晚、压缩永不触发，且全程没有症状
> （`acp_status` 照常报数，报的是别人的分母）。反方向（子 Agent 窗口更大）则偏早。
>
> 两个维度都查不到时回落「默认 Provider 的窗口 → 200000」，与单一窗口的老口径**逐位一致**。
> 同名模型挂在多个端点上且窗口不同时按**最小**窗口算 —— 保守方向是宁可早压（分母虚高会漏压）。
>
> ⚠️ 显式写 `compression.modelContextLimit` = 「我不管端点是什么，就按这个数算」，它会压过按端点的
> 解析。多端点混用时别写它，否则等于把分母又钉回了单一值。

缺省 window 只在 `compression.enabled` 时生效。示例：

```jsonc
{ "provider": "my-gw",
  "providers": [{ "id": "my-gw", "type": "openai", "contextWindowTokens": 200000 }],
  "compression": { "enabled": true } }   // 未写 modelContextLimit → 用 200000
```

---

## 2. 层保留（保底部）：最近上下文始终不压缩

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 🔧 `compression.preserveRecentMessages` | **5** | 最**近 N 条原始消息**永远保留、不参与折叠（位于"压缩泳道"的最底层保护，先按条保留）。 |
| 🔧 `compression.preserveRecentTokens` | **5000** | 最近 **N tokens** 的原始上下文（向前回溯扩展）始终原样保留、不压缩。两条共同构成"近期可读窗口"底部。 |

> 说明：折叠窗口 = 排在最近**保留区之外**的历史。你问的"触发 t2/t3 会不会把最近的 t1 也丢了"——
> 不会：`preserveRecentMessages` / `preserveRecentTokens` 优先保护最近区；t2 蒸馏的是**更早**的活跃 t1 块，
> t3 压缩的是**更早**的活跃 t2 块，都是历史侧而非最近侧。

---

## 3. 层提升阈值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 🔧 `compression.promotionThreshold` | **5** | 块连续"存活"（未被覆盖/替换）次数 ≥ 该值，才允许升层（t1→t2→t3 的 promotion）。kernel 校验 `>= 1`。给特别大（如 `1e9`）可**关闭升层**，只保留按窗口各自的折叠。 |

---

## 4. t1/t2/t3 各层压缩触发阈值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 🔧 `compression.tiers.tier2Trigger` | **5** | **活跃 t1 块数** ≥ 该值，且 `usage ≥ minContextLimitPct` 时，才把部分 t1 块**蒸馏**为 t2。 |
| 🔧 `compression.tiers.tier3Trigger` | **10** | **活跃 t2 块数** ≥ 该值，且 `usage ≥ minContextLimitPct` 时，才把部分 t2 块**压缩**为 t3。 |

> kernel 校验：`tier3Trigger` 必须 **严格大于** `tier2Trigger`；两者都须 `>= 2`。
> 层压缩面对的是历史侧的活跃块计数，与"最近保留多少 token/message"（见 §2）是**正交**的两套判定。

---

## 5. nudge（上下文压力提醒档位）

`compression.nudge` 控制模型被"提醒压缩"的占用比例门槛（基于 `usage = 当前token/modelContextLimit`）。

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 🔧 `compression.nudge.maxContextLimitPct` | **0.75** | 效率型 nudge（建议早压缩）的占用下限：`usage ≥ 该比例` 且满足增长条件才注入。 |
| 🔧 `compression.nudge.minContextLimitPct` | **0.45** | nudge 提示的最低占用门槛；也作为 t2/t3 块计数触发的 `usage ≥ minContextLimitPct` 门槛。 |
| 🔧 `compression.nudge.emergencyThresholdPct` | **0.95** | 溢出线：`usage ≥ 该比例` 无条件强提醒（提示词为 `⚠️ Context limit reached`）。 |
| ⬇ `compression.config.nudge.*` | 见下 | 高级字段全量透传（见 §7 默认值汇总）。 |

> ⚠️ **写法（本文最容易踩的一处）**：上表的 `nudge.X` 是**字段名**，不等于**能写的路径**。
> 结构化口 `compression.nudge` **只收上面那三个百分比键**；内核 `NudgeConfig` 的其余 10 个 ——
> `growthRatio` / `growthFloor` / `growthCap` / `minGrowthFloor` / `minGrowthRatio` / `frequency` /
> `force` / `iterationThreshold` / `tier2GrowthMultiplier` / `minPressureBenefitTokens` ——
> **必须**写成 `compression.config.nudge.X`，写在 `compression.nudge` 里**不会生效**。
> （校验器会告警，而且会直接指出该写到哪；见 §10。）本文正文为简洁统一记作 `nudge.X`，读到时请按本注还原成路径。
> 同理：`compression.tiers` 只收 `tier2Trigger` / `tier3Trigger`，内核的 `enabled` 要写 `config.tiers.enabled`。
> 作用域档位（`subagent` / `perAgent[*]`）**同一套规则**，透传口就是 `config` 前面多一层档位，例如
> `compression.subagent.config.nudge.growthFloor`。

> kernel 校验：`minContextLimitPct ≤ maxContextLimitPct`，且 `maxContextLimitPct ≤ emergencyThresholdPct`。

---

## 6. 提示词配置（t1/t2/t3 与压缩哲学）

优先级（低 → 高）：**插件目录 `prompts/*.txt`（文件默认）→ `compression.prompts`（config 覆盖）→ `compression.systemPrompt`（整段覆盖）**。

| 配置项 | 默认 | 说明 |
|--------|------|------|
| 📄 插件 `prompts/*.txt` | 内核 `defaultPrompts` 原始复制 | 4 个 txt 存于 `packages/plugins/acp-context/prompts/`：`compressPhilosophy.txt` / `howToCompressRules.txt`(t1) / `tier2DistillRules.txt`(t2) / `tier3CondenseRules.txt`(t3)。**可直接编辑文件改默认**，缺失/读失败回退内核默认。 |
| 🔧 `compression.prompts` | 读文件默认 | 覆盖各层提示词（load-bearing，需 `acknowledgeRisk`）；
  - `prompts.compressPhilosophy`：压缩哲学（进系统提示 + 每条 nudge）
  - `prompts.howToCompressRules`：**t1 摘要规则**
  - `prompts.tier2DistillRules`：**t2 蒸馏规则**
  - `prompts.tier3CondenseRules`：**t3 极简规则** |
| 🔧 `compression.systemPrompt` | —（null） | **整段覆盖**压缩系统提示，优先级最高：设了就用它，否则 `buildCompressSystemPrompt(resolvedPrompts)` 由上面提示词合成。 |

> 说明（对应你问的"t1/t2/t3 压缩的提示词"）：只有 t1 规则会写进**压缩系统提示**；t2/t3 规则用在
> 模型写 t2/t3 蒸馏/极简摘要时（nudge 与蒸馏指令），均取自同一份 `resolvedPrompts`，配置后三者一致生效。

---

## 7. ⬇ 高级透传 `compression.config`（kernel Config 全量）

未入上面结构化字段的其它 kernel 配置可经 `compression.config` 透传（键与 kernel `Partial<Config>` 一致）。
下方是这些项的默认值（含本插件已结构的层级默认，供对齐）。

> **两个口可以同时用、会合并**：结构化口（`nudge` / `tiers`）与 `config.*` 透传口描述同一棵子树时按
> **深合并**处理、**结构化口优先**。§7.5 的推荐配置就是这么用的 —— 三个百分比键走结构化口、growth 系列走
> `config.nudge`，两边都活着。**特例：`config` 与结构化字段是同名标量时以结构化字段为准**
> （如 `preserveRecentTokens`）。

| 键 | 默认 | 说明 |
|----|------|------|
| `compress.minCompressRange` | **5000** | 一个折叠范围原文 chars ≥ 该值才允许压缩（0=不设门槛）。 |
| `compress.maxSummaryLength` | **20000** | 摘要超此 chars 会被拒绝（除非模型用 `summaryMaxChars` 覆盖）。 |
| `compress.minSummaryLength` | **50** | 摘要低于此 chars 会被拒绝。 |
| `truncate.threshold` | **0.95** | 上下文溢出兜底截断的占用阈值。 |
| `protectedTools` | **[]** | 永不入压缩范围的工具名。 |
| `absorb.enabled` | **false** | 工具结果瞬时吸收（可选增强），默认关。 |
| 结构化已覆盖项 | — | `tiers.*`、`nudge.*`、`promotionThreshold`、`preserveRecentMessages`、`preserveRecentTokens` 的未结构化键可在此补。 |

**nudge 未结构化字段（用 `config.nudge.*` 覆盖）**：`frequency: 5`（nudge 注入频次上限）、
`iterationThreshold: 15`、`force: "soft"`（"soft"|"strong"，强攻强制注入）、`growthRatio: 0.05`、
`growthFloor: 50000`、`growthCap: 50000`、`minGrowthFloor: 20000`、`minGrowthRatio: 0.45`、
`tier2GrowthMultiplier: 1.5`。

---

## 7.1 nudge 增长阈值详解（`growthFloor` / `growthCap` / `growthRatio` / `minGrowthFloor` / `minGrowthRatio`）

§5 的 `*ContextLimitPct` 是**占用率**门槛；这里的 growth 系列是**token 增量**门槛，两者**并列**触发。

⚠️ 与 §5 那三个百分比键不同，growth 系列**只能**写在 `compression.config.nudge.*`（透传口）——
结构化口 `compression.nudge` 只收百分比键，写进去不会生效（见 §5 的写法注），以 token 计。

**① 触发门槛 `nudgeGrowthTokens`：需要攒够多少「可压缩内容」才会提醒**

```
nudgeGrowthTokens = min( nudge.growthCap,
                         max( nudge.growthFloor, round(modelContextLimit × nudge.growthRatio) ) )
```

| 键 | 默认 | 作用 |
|----|------|------|
| `nudge.growthRatio` | **0.05** | 随窗口线性缩放：`窗口 × 该比值`。 |
| `nudge.growthFloor` | **50000** | 上式的**下限**（窗口/比值算出来太小就兜到它）。 |
| `nudge.growthCap` | **50000** | 上式的**上限**（窗口大时不无限放大）。 |

三个键合成「t1 提醒所需的最少可压缩量」：t1 提醒要求 `pendingT1 ≥ nudgeGrowthTokens`。
即**「触发折叠所需积攒的可压缩量」≈ `nudgeGrowthTokens`**，而不是占用率比例。

**② 提醒节奏（再次提醒前又需增长多少）**

> ⚠️ 有两处易混同名概念：
> - `nudge.growthFloor` **只**出现在 ① 的 `nudgeGrowthTokens` 公式里；
> - 「距离上次提醒后、再次提醒所需的增长量」用的是 **`nudge.minGrowthFloor` / `nudge.minGrowthRatio`**：

```
cadenceFloor = max( nudge.minGrowthFloor, nudge.minGrowthRatio × nudgeGrowthTokens )
```

| 键 | 默认 | 作用 |
|----|------|------|
| `nudge.minGrowthFloor` | **20000** | 节奏下限（token）。调大 = 折叠更「懒」、间隔更长。 |
| `nudge.minGrowthRatio` | **0.45** | 节奏 = 触发门槛的比例。调大 = 拉长折叠间隔、减少前缀重置、提高缓存命中。 |

**③ 与占用率门槛（§5）的关系（谁在真正触发）**

一次 nudge 注入 `shouldInject` 为真，满足**任一**即可：

| 分支 | 条件 | 是否看占用率 |
|------|------|------------|
| 压力（早压缩） | `usage ≥ maxContextLimitPct`（或 `emergencyThresholdPct`） | ✅ 看 |
| 增长 | `growthSinceReference ≥ cadenceFloor` **且** `pending ≥ nudgeGrowthTokens` | ❌ **不看** |
| 首次提醒（first-sight） | 无 nudge 历史 且 `usage ≥ minContextLimitPct` 且 `pending ≥ nudgeGrowthTokens` | ✅ 看 |
| t2/t3「块计数」触发 | 活跃块数 ≥ `tier2/3Trigger` 且 `usage ≥ minContextLimitPct` | ✅ 看 |

> **重要**：`minContextLimitPct` **不是全局触发下限**，它只用于「首次提醒」和「t2/t3 块计数」两个分支；
> **增长分支完全不看占用率**。实测反例（本机 300k 窗口、`minContextLimitPct=0.35`）：
> 首次 nudge 在 **`usage=33.5%`（< 35%）** 就触发，因为增长分支先满足——真正门槛是
> `nudgeGrowthTokens=50000`（需 50k 可压缩；配合 `preserveRecentTokens=50000` ≈ 100k 上下文触发）。

**④ 典型调法**

- **「攒到 ~100k 才折、一次折 50k」**：`preserveRecentTokens=50000`（决定折叠量 = 当前 − 50k）；
  令 `nudgeGrowthTokens≈50000`（即 `growthFloor=growthCap=50000`）→ 需 ~50k 可压缩才提醒 ≈ 100k 触发。
  默认 `growthFloor=growthCap=50000` 已是此行为，显式写出只是固化。
- **折叠更「懒」（更省 token、缓存命中更高）**：调大 `minGrowthFloor` / `minGrowthRatio`（拉长节奏），
  或调大 `growthFloor` / `growthCap`（抬高触发门槛）。
- **想让 `minContextLimitPct` 真正起下限作用**：必须同时抬高 `growthFloor`/`minGrowthFloor`，
  否则增长分支会在占用率之下先触发（如上反例）。

**⑤ 与 `compress.minCompressRange` 的关系**：`minCompressRange`（默认 5000，单位 **chars**）是单个
折叠范围的**最小原文长度**，kernel 用 `mergeRangesToThreshold` 把连续可压缩范围**依次合并到 ≥ 该值**
才算一个折叠块，尾部不足门槛的碎片不计入 pending。所以它是**折叠粒度**（不是简单的门槛）：调大它
（如 30000 ≈ 7.5k tokens）会抬高「可压缩量」的粒度、进一步推迟提醒。
**但它有硬上限**——大到接近可压缩区时合并结果永远不达标 ⇒ pending 恒为 0 ⇒ nudge 被抑制、压缩失效
（机理、实测与安全公式见 §7.4②）。

---

## 7.2 按上下文窗口缩放参数：`R(W)` 拟合（200k / 300k / 1m 实测）

> ⚠️ **本节结论的前提**：§7.1 的 growth 系列与 `preserveRecentTokens` 全是**绝对 token 值**，
> **不随窗口缩放**。窗口一变，同一组绝对阈值语义完全变了。

**① 为什么必须缩放——绝对阈值的两个陷阱**

| 现象 | 机理 |
|------|------|
| 小窗口**超窗** | 绝对阈值给请求量设了一个**地板**：请求 ≈ `sys + 压缩块 + R`，无论窗口多小都降不到这个地板以下。实测 `R=50000`（`minCompressRange=30000`）请求恒为 ~105k ⇒ W=102400 占用 **103.8%**、W=80000 **131.9%**、W=40000 **263.7%**（真实链路会截断/报错）。⇒ **窗口 ≲ 110k 时这套绝对配置必然超窗。** |
| `growthCap` 形同虚设 | `nudgeGrowthTokens = min(growthCap, max(growthFloor, 窗口×growthRatio))`。只要 `growthFloor` 先被取到，`growthCap` 就**不参与**——例如 `growthCap=750000` 对任何 ≤15M 的窗口都是 no-op。想让它生效必须同时调 `growthFloor`。 |

> 注：短会话下看不出超窗。同样 `W=102400 / R=50000`，若只跑 14 轮（累计原文 83000 < 窗口、**一次都没折叠**，保留率 100.37%），
> 占用率只有 81.36% —— 这是"还没触发压缩"而非"没有隐患"。把步数拉到 60（累计原文 313k 撑满窗口）即复现 103.8%。

**② 缓存命中的真实机理（别把它想成"保留窗口每轮都变"）**

投影数组的布局是 **`[b1] [b2] … [bn] [保留窗口原文…]`**——压缩块按创建顺序累积在**保留窗口之前**
（内核 `rebuildMessages`：块一旦渲染过就固定在原下标，新块插在它覆盖的最旧原文位置，即旧块之后）。

| 轮次类型 | 前缀命中情况 |
|---------|------------|
| **非折叠轮**（绝大多数） | 上一轮的整个数组是当前数组的**前缀**，只有本轮新追加的一轮内容失配 ⇒ **命中率 ≈ 1 − 本轮新增 tok / 请求 tok** |
| **折叠轮** | 新块 `b(n+1)` 插在下标 n（`bn` 之后、保留窗口之前）⇒ **保留窗口整体后移一位，该轮全部失配**；命中量只剩 `sys + b1..bn` |

实测（300k / R=55k / steps=42）逐轮：

```
轮次  1 … 22（无折叠，命中率缓升）   23（折叠）  24      25 …   36（折叠）  37 …
命中  78.21% → 96.09%             16.18%     94.05%  94.45%  23.50%     94.39%
```

⇒ **保留窗口不是"每轮都变"，它只在折叠那一刻因位置平移而整体失效一次**，下一轮立刻恢复。
`有效成本` 因此与「折叠频率」强相关：折叠越勤，`R` 被重复计费的次数越多。

**成本口径**（与真实计费一致）：命中缓存的 token 按**未命中的 1/25** 计价。

```
有效成本 = 均请求 tok × [ (1 − 命中率) + 命中率 × 0.04 ]      # bench 的 --cacheDiscount=0.04
```

**③ 拟合式：保留量随窗口「对数」增长，取保真下限**

用单一可调锚点 —— `preserveRecentTokens`（下称 **R**）—— 驱动全套参数。**在 1/25 计价下 R 没有成本最优点**：
R 越大，请求体量（分母）涨得比命中率快，成本单调上升。实测 1m 档：

| R | 50k | 60k | 75k | 90k | 100k | 120k | 150k |
|---|-----|-----|-----|-----|------|------|------|
| 均请求 tok | 130,784 | 135,705 | 147,021 | 168,993 | 181,183 | 186,175 | 242,658 |
| 缓存命中 | 92.81% | 92.37% | 92.63% | 94.07% | 94.18% | 94.20% | 95.72% |
| **有效成本 tok** | **14,254** | 15,367 | 16,289 | 16,387 | 17,379 | 17,817 | 19,680 |

命中率只涨 2.9pp，请求体量却涨 86% ⇒ **R 越大越贵**。所以 R 应由**保真需求**决定（近期原文不能丢多少），
**取保真区间的下限**，再套对数式平滑：

```
R(W) = 30000 + 28600 × log10( W / 200000 )        单位：tokens，建议夹到 [15000, 150000]
```

等价说法：**窗口每放大一个数量级（×10），保留量约增加 29k**；锚点为 **200k → 30k**。
占比随窗口**下降**：200k ≈ 15%、300k ≈ 12%、1m ≈ 5%。

> 为什么是"下限 + 对数"而不是"找一个最优 R"：成本对 R 是**单调不降**的，但**保真**要求 R 不能太小。
> 于是最优点永远被**顶在保真下界**上，而对数式只是把这个下界随窗口平滑外推。

**④ 依赖参数映射（全部由 R 派生，改窗口只改这一个锚点）**

| 配置键 | 取值 | 说明 |
|--------|------|------|
| `compression.preserveRecentTokens` | **R** | 保护区 token 量；折叠量 = 当前上下文 − R |
| `compression.config.nudge.growthFloor` | **R** | 进 `nudgeGrowthTokens` 公式的下限 |
| `compression.config.nudge.growthCap` | **R** | 与 `growthFloor` 相等 ⇒ `nudgeGrowthTokens ≡ R`（避免 §7.1 的 no-op 陷阱） |
| `compression.config.nudge.growthRatio` | **0** | 置 0 后 `窗口×ratio` 项消失，只由 floor/cap 决定 |
| `compression.config.nudge.minGrowthFloor` | **R** | 折叠节奏下限（`cadenceFloor`） |
| `compression.config.nudge.minGrowthRatio` | **0** | 置 0 后 `cadenceFloor ≡ R`：攒够 R 才再折一次 |
| `compression.config.compress.minCompressRange` | **round(0.6 × R)** | 单位是 **chars**；用户现网 30000 chars ↔ R=50000 tok 正好 0.6，照此沿用 |

> 语义结果：`nudgeGrowthTokens = R` 且折叠量 = 当前 − R ⇒ **攒到约 2R 上下文时折一次，一次折掉 R**。
> ⚠️ 推论：R 调**小**不仅更省，还**减少折叠次数**（攒够 R 就折 ⇒ R 越小折得越勤）——
> 但折叠轮会让 1×R 的保留窗口整体失配，两个效应量级相当，故 200k/300k 档成本曲线很平。

**⑤ 各窗口推荐值**

| 窗口 W | R = preserveRecentTokens | growthFloor / growthCap / minGrowthFloor | minCompressRange (chars) |
|--------|--------------------------|------------------------------------------|--------------------------|
| 100k (102400) | **21,500** | 21500 | 12,900 |
| 128k | **24,500** | 24500 | 14,700 |
| **200k** | **30,000** | 30000 | 18,000 |
| **300k** | **35,000** | 35000 | 21,000 |
| 400k | **38,500** | 38500 | 23,100 |
| 500k | **41,500** | 41500 | 24,900 |
| **1m** | **50,000** | 50000 | 30,000 |
| 1.5M | 57,500 | 57500 | 34,500 |
| 2M | 63,000 | 63000 | 37,800 |
| ≥3M | **150,000**（封顶） | 150000 | 90,000 |

**⑥ 实测复核（`bench/compress-params.ts`，perTurn=5000、sysTok=13000、仅 nudge 触发折叠）**

| W | R | 均请求 tok | 峰值 tok | 峰值占用 | 缓存命中 | **有效成本 tok** |
|---|---|-----------|---------|---------|---------|----------------|
| 102400 | 21685 | 44,150 | 63,220 | 61.7% | 83.47% | **8,771** |
| 128000 | 24457 | 51,693 | 83,114 | 64.9% | 85.77% | 9,129 |
| **200000** | 30000 | 65,022 | 113,246 | 56.6% | 86.25% | 11,184 |
| **300000** | 35036 | 79,206 | 129,084 | 43.0% | 89.24% | 11,351 |
| 400000 | 38609 | 89,372 | 146,080 | 36.5% | 89.74% | 12,376 |
| 500000 | 41381 | 101,623 | 165,201 | 33.0% | 91.25% | 12,600 |
| **1000000** | 49991 | 130,784 | 208,646 | 20.9% | **92.81%** | 14,254 |

**所有窗口均未超窗**，有效成本 8.8k → 14.3k。

> **命中率随窗口单调上升，是否只是"大窗多跑了步数"的假象？——已排除。**
> 上表各窗口步数不同（步数按约 70% 占用率定：14/18/28/42/56/70/140）。把 **步数、每轮增量、累计原文全部固定**
> （steps=60、perTurn=5000 ⇒ 每个窗口都喂 313k 原文）再跑一遍，命中率仍**严格单调**：

| W（同 steps=60 / perTurn=5000 / 原文 313k） | 102400 | 128000 | 200000 | 300000 | 400000 | 500000 | 1000000 |
|---|---|---|---|---|---|---|---|
| 缓存命中率 | 74.01% | 82.77% | 86.17% | 90.11% | 90.16% | 90.43% | **91.73%** |
| 有效成本 tok | 18,343 | 13,709 | 12,747 | **11,981** | 12,331 | 12,772 | 12,659 |

窗口越大，压缩块在请求里占比越高、命中前缀越稳定 ⇒ 命中率红利越明显，**成本从 18.3k 收敛到 ~12k**。
**这正是"大窗口更该开 ACP、小窗口 ROI 低"的量化依据。**

> **稳健性**：R 的单点成本会随会话长度**共振**（同一 R、不同 steps 能差 30%），故选 R 要看**均值**而非单点。
> 多 steps 复测（200k：28/38/48 轮；300k：42/56/70 轮；1m：100/140/180 轮）：
> 200k R=30k 均值 **11.6k**（R=40k 均值 12.4k、且波动 10.3k~13.7k）；300k R=35k 均值 **11.8k**（R=45k 12.6k、R=65k 12.9k 且随会话变长恶化）；
> 1m R=50k 均值 **14.2k**（R=100k 17.2k，差 21%）。⇒ **小 R 更稳、更省**，验证了"取保真下限"。

**⑦ 哪几个键「不用改」**

- `nudge.maxContextLimitPct` / `emergencyThresholdPct`：**当 `maxPct ≥ (2R + sysTok)/W + 约 0.08` 时完全非绑定**——
  增长分支先满足，压力分支再也轮不到。实测 200k/R=40k 从 **0.55** 起逐位一致（0.55/0.60/0.65 结果全同），
  300k/R=55k 从 **0.50** 起逐位一致；而**调低到阈值以下反而更差**：200k 上 0.50 命中率掉到 86.30%、
  0.55/0.60/0.65 均为 89.11%——因为提前走压力分支、折叠次数变多、前缀重置更频繁。
  **保留 0.65 / 0.80 只作安全上限**：本文档位中占比最高的是 102400 档，`0.65` 对每一档都满足非绑定条件。
- `nudge.minContextLimitPct`：只影响「首次提醒」与「t2/t3 块计数」分支（见 §7.1③），保持 0.35。
- `preserveRecentMessages`：与 `preserveRecentTokens` 取**并集**。5 条消息约 25k tok，注意 R 小于 25k 的档位
  （如 102400）实际由 `preserveRecentMessages` 主导保护区，若想精确控制保留量需同步调小它（如 3）。
- `maxSummaryLength` / `tier2Trigger` / `tier3Trigger` / `promotionThreshold`：本拟合未涉及，沿用现值。

**⑧ 注意事项**：`minCompressRange` 在**平台内**敏感度极低——取 `0.6R ~ 1.0R`（chars）时命中率与成本差异 < 1%，
但**它不是单调无害的**：它同时是折叠粒度与「单次折叠的保真度」，且有**硬上限**
`≤ 2 × (W − R)`，越过就会让 nudge 被抑制、压缩失效（实测与机理见 §7.4②）。
只有把它压到远低于 R（如 5000）才会明显增多碎片与块数。故 0.6R 是可安全照抄的经验值。

---

## 7.3 固定 R 时，其余参数怎么调（300k / 1m 实测）

> ⚠️ **本节是早期的专项扫描记录，结论已被 §7.4 / §7.5 取代**：
> `growthFloor` 的推荐值统一为 **`1.5R`**（本节当时给的是 `2R`，在 1m 上会翻车 +9.3%），
> `minCompressRange` 改为 **`clamp(4R, 8000, 2(W−R))`**（本节当时是 `max(200000, 4R)`）。
> 本节仍有价值的只有「**哪些键是死键**」这部分——`tier2/3`、`promotionThreshold`、
> `preserveRecentMessages` 对成本几乎无影响，在任何窗口上都成立。

**① 结论先行：R 钉死后，能动的只有两个键**

把 `preserveRecentTokens` 固定（300k→50000、1m→100000），对余下全部键做了全量扫描
（`growthFloor` / `growthCap` / `growthRatio` / `minGrowthFloor` / `minGrowthRatio` / `minCompressRange` /
`maxSummaryLength` / `minSummaryLength` / `promotionThreshold` / `tier2Trigger` / `tier3Trigger` /
`preserveRecentMessages` / `maxPct` / `minPct` / `emergencyPct`），**只有两个键能改变成本**：

| 键 | 作用 | 实测敏感度 |
|----|------|-----------|
| `nudge.growthFloor`（+ `minGrowthFloor` 同步） | **折叠块大小** | 300k：成本 16460→13795（−16%）；1m：17323→16669 |
| `compress.minCompressRange`（chars） | 候选折叠范围粒度 | 与上者配合，单独动 < 1% |

**其余全是死的**：`tier3Trigger`（12/18/30/50 结果逐位一致）、`promotionThreshold`（3/5/10/20 一致）、
`preserveRecentMessages`（2/3/5/8/12/20 一致——5 条消息远小于 R，并集由 R 主导）；
`tier2Trigger` 仅在 1m 上有 ±1% 的小影响（**≤5 为宜**，取 10 反而跳到 19107）；
`maxPct` / `emergencyPct` 见 §7.2⑥。

**② 机理：`growthFloor` 是一个双刃旋钮**

- 调大 → 一次折掉更多、折叠次数变少 → **前缀重置次数变少** → 命中率上升（300k：90.4% → 92.6%）；
- 同样调大 → 两次折叠之间的请求体更大 → **均请求上升**。

两个效应相抵，最优在边际相等处。实测曲线**先陡降、随后进入长平台**（见下），
平台内任意取值差异都在 1% 以内 ⇒ **选点是「取平台中段」，不是「逼近极值」**。

**③ 300k / R=50000 推荐（只改三行）**

| 配置键 | 现网值 | **建议** |
|--------|--------|---------|
| `preserveRecentTokens` | 50000 | 50000（不动） |
| `nudge.growthFloor` | 50000 | **100000** |
| `nudge.minGrowthFloor` | 50000 | **100000** |
| `compress.minCompressRange`（chars） | 30000 | **150000** |
| `nudge.growthCap` / `growthRatio` / `minGrowthRatio` | 750000 / 0.05 / 0.45 | 不动（cap ≥ floor 即可；`0.05×300000=15000 < floor`、`0.45×100000=45000 < minGrowthFloor`，两项天然被压住） |
| 其余（`maxPct` 等） | — | 不动 |

效果（长会话 100/140/200 轮均值）：**成本 16460 → 13795（−16.2%）**，命中 90.4% → 92.6%，
峰请求 192k → 196k（+2%）。语义：**攒到约 R+GF = 150k 折一次、一次折掉 100k**。

**④ 1m / R=100000 推荐**

| 配置键 | **建议** |
|--------|---------|
| `preserveRecentTokens` | 100000（不动） |
| `nudge.growthFloor` / `minGrowthFloor` | **125000** |
| `compress.minCompressRange`（chars） | **80000** |
| 其余 | 不动 |

效果：**成本 → 16669（对现网绝对值基线 −6.3%，对上轮 R 拟合基线 −2.0%）**，
命中 94.5%，峰请求 **320694 → 290169（−9.5%）**——成本与峰值同时改善。

**⑤ 为什么不给统一公式**

`R(W)` 有干净的对数拟合（§7.2），但 `growthFloor` 没有：300k 最优 ≈ **2R**，1m 最优 ≈ **1.25R**。
原因是 R/W 占比不同（17% vs 10%），折叠频率与窗口的相对关系变了。1m 的平台本就宽得多
（100k–175k 全在 2% 以内），取 125000 是「成本最低且峰值安全」的折中；
300k 上 GF=150k 会把峰请求推到 208k+ 才开始反弹，故停在 100k。

**⑥ 会话长度是隐藏变量（bench 新增「谷请求」指标）**

同一配置下，每轮成本随会话变长**持续上升、并不收敛**（300k / GF=100k / MC=150k）：

| 会话轮数 | 42 | 100 | 200 | 300 |
|---|---|---|---|---|
| 均请求 tok | 98934 | 119646 | 129435 | 135493 |
| **谷请求 tok（稳态）** | **73038** | **76117** | **80762** | **85395** |
| 峰请求 tok | 183748 | 191666 | 196300 | 204018 |
| 有效成本 tok | 11850 | 13151 | 14404 | 14680 |

**谷请求（= 刚折叠完的最小请求体）单调抬升** ⇒ 请求地板 = 系统提示词 + R + **累积的压缩块**，
压缩块会缓慢堆积，会话越长地板越高。两条实践含义：

1. 比较两套参数**必须在相同轮数下比**，否则会把「会话更长」误读成「参数更好」；
2. bench 已新增 `谷请求 tok` 列（只取**后半程**最小值；前半程是还没攒够内容折叠的热身区，
   请求体天然很小，计入会掩盖真实地板）。

**⑦ 短会话会把结论反过来**

300k 实测交叉点约在 **60 轮**：

| 会话轮数 | 42 | 60 | 100 | 140 | 200 |
|---|---|---|---|---|---|
| 基线 GF=50k 成本 | 12910 | 12970 | 14340 | 16331 | 18711 |
| 推荐 GF=100k 成本 | **11850** | 13303 | **13151** | **13830** | **14404** |
| 差 | −8% | +3% | −8% | −15% | **−23%** |

更短会话下大折叠块并不占优（折叠机会太少）；更长会话下基线因前缀重置更频繁而持续劣化。
生产里 300k 窗口的会话通常远长于 60 轮，故**长会话数字更有代表性**。

**⑧ 钉住的 R 相对拟合值要付多少溢价（同轮数对照）**

既然 R 由使用方指定（300k→50000、1m→100000），把它和 §7.2 的拟合值放在同一批轮数下比一次：

| 窗口 | 配置 | 成本均值 | 命中 | 峰值 | 占窗 |
|------|------|----------|------|------|------|
| 300k | A 拟合 `R=35k` / `GF=35k` / `MC=21k` | 12114 | 90.29% | 156070 | 52.0% |
| 300k | **B 指定 `R=50k` / `GF=100k` / `MC=150k`（本次推荐）** | **12415** | 92.72% | 196300 | 65.4% |
| 300k | C 指定 `R=50k` / 其余沿用现网（`GF=50k`/`MC=30k`） | 13478 | 90.35% | 192026 | 64.0% |
| 1m | D 拟合 `R=50k` / `GF=50k` / `MC=30k` | 14279 | 93.42% | 231814 | 23.2% |
| 1m | **E 指定 `R=100k` / `GF=125k` / `MC=80k`（本次推荐）** | **16669** | 94.48% | 290169 | 29.0% |
| 1m | F 指定 `R=100k` / 上轮拟合（`GF=100k`/`MC=60k`） | 17014 | 94.48% | 320694 | 32.1% |

（300k 取 42/100/200 轮，1m 取 100/140/200 轮，perTurn=5000、sysTok=13000）

1. **300k 的 `R=50000` 只比拟合值贵 2.5%**（12415 vs 12114）——多留 15k 原文换来命中率 +2.4pp，
   这笔交易基本划算；而在同样的 R 下把其余参数调好，比现网省 **8%**（13478 → 12415）。
2. **1m 的 `R=100000` 比拟合值贵 16.7%**（16669 vs 14279）——这是**保真溢价，不是参数没调好**：
   R 是每轮全价的部分，1m 上把它从 50k 抬到 100k 直接抬高请求地板。
   在 R 钉死的前提下，其余参数已把它压到最低（对比 F 再省 2%）。
3. **峰值余量**：300k 的 B 配置峰值 65.4%，**刚好贴住 `maxPct=0.65`**。
   若想留头部空间，改用 `GF=90000`——成本只差 <0.5%（13795 → 14141 同轮数口径）。

---

## 7.4 按窗口自动适配参数（`compression.autoTune`）与跨窗口拟合公式

**200K / 300K / 1M 三个常用窗口的现成参数表在 §7.5①**；本节讲推导公式本身与 8 档实测。
§7.2 / §7.3 给的是早期的逐窗口手工扫描。若不想跟着窗口改配置，可开启**自动适配**：
参数由模型上下文窗口 `W` 推导，并已在 8 档窗口上实测过。

### ① 怎么切换

```jsonc
{
  "compression": {
    "enabled": true,
    "autoTune": true,          // true = 按上下文窗口自动推导；false / 省略 = 用下面写的原始参数
    "modelContextLimit": 300000 // 窗口来源；省略则用 providers[].contextWindowTokens（再缺省 200000）
  }
}
```

- **`autoTune: false`（默认）** —— 原始压缩参数控制，行为与升级前**完全一致**（`preserveRecentTokens` /
  `nudge.*` / `compress.minCompressRange` 写什么就是什么，没写的回落 kernel 默认）。
- **`autoTune: true`** —— 先按窗口推导一套参数**打底**，再把配置里**显式写出**的键叠在上面。
  因此可以「自动打底 + 手工钉一两个键」，例如只钉住保留量：
  ```jsonc
  { "compression": { "enabled": true, "autoTune": true, "preserveRecentTokens": 120000 } }
  ```
  （此时 `growthFloor` / `minCompressRange` 仍按窗口 `W` 自动推导——**不**跟着你钉的 R 变；
  唯一例外是 `MC` 的 `2 × (W − R)` 上限用**生效的** R 计算，钉大 R 会把 MC 自动压低以防 nudge 被抑制。）

实现位置：`packages/plugins/acp-context/src/auto-tune.ts`（公式单一来源），
装配入口 `resolveAcpConfig()`；`harness config` 概览会显示当前处于
「按窗口自动适配参数（autoTune）」还是「原始压缩参数控制」。

### ② 推导公式（锚点分段插值）

```
R  = clamp( round500( interp(W) ), 15000, 150000 )        // tokens
     interp：在 log10(W) 上按锚点表分段线性插值，两端按端点段斜率延伸
     锚点 (200000, 35000) → (300000, 50000) → (1000000, 100000)
GF = round500( 1.5 × R )      → nudge.growthFloor = growthCap = minGrowthFloor
MC = clamp( 4 × R, 8000, 2 × ( W − R ) )   → compress.minCompressRange（单位 chars，1 token ≈ 4 chars）
```

**为什么是插值而不是解析式**：三个锚点是**实测最优值**（§7.5 参数表），插值保证
`deriveAutoTuneParams(200000/300000/1000000)` 与参数表**逐位一致**——「表是特例、公式是推广」。
单测 `参数表 ↔ 公式一致` 会同时校验公式输出与 `AUTO_TUNE_ANCHORS` 锚点集合，防止只改一处。

| 参数 | 取值 | 说明 |
|------|------|------|
| `preserveRecentTokens` | **R** | 保护区；锚点 **200k → 35000**、**300k → 50000**、**1m → 100000**，其间按 log10(W) 线性插值（200k 以下沿首段斜率延伸并在 ~116k 处触到下限 15000，3.33M 以上触到上限 150000） |
| `nudge.growthFloor` / `growthCap` / `minGrowthFloor` | **GF = 1.5R** | 三者相等 ⇒ `nudgeGrowthTokens ≡ cadenceFloor ≡ GF` |
| `nudge.growthRatio` / `minGrowthRatio` | **0** | 抵消 kernel 默认的 `窗口×0.05` 与 `0.45×growthTokens` |
| `compress.minCompressRange` | **clamp(4R, 8000, 2(W−R))** | 折叠粒度（chars）；上限绑在可压缩区上，**不能用绝对下限**（见下） |
| `nudge.maxContextLimitPct` / `minContextLimitPct` / `emergencyThresholdPct` | 0.65 / 0.35 / 0.80 | 安全上限，实测非绑定（§7.2⑥） |
| `tiers.tier2Trigger` / `tier3Trigger`、`promotionThreshold` | 5 / 18 / 10 | 沿用实测取值（这几项对成本几乎无影响，§7.3） |
| `compress.maxSummaryLength` / `minSummaryLength` | 10000 / 1000 | 摘要保真↔成本旋钮 |
| `preserveRecentMessages` | 5 | 与 `preserveRecentTokens` 取并集，实际由 R 主导 |

**语义**：`nudgeGrowthTokens ≡ cadenceFloor ≡ 1.5R` ⇒ 上下文从 R 涨到约 **2.5R 折一次，一次折掉约 1.5R**；
保护区 R 是「每轮全价」的部分（每轮都在变、永不命中前缀缓存），压缩块才是命中分子。

**`MC` 到底是什么（它不是「窗口大小的上限」，而是折叠粒度）**：kernel 用 `mergeRangesToThreshold`
把**连续可压缩范围合并到 ≥ MC chars** 才算一个折叠块，尾部不足 MC 的残块在 `pendingByTier` 里被丢弃、
不计入 pending。因此 MC 同时决定两件事：

| 作用 | 机理 | 后果 |
|------|------|------|
| **① 单次折叠的真实率** | 一个合并范围 → **一个**摘要块，而摘要上限恒为 `maxSummaryLength`（10000 chars） | 单次压缩比 ≈ `MC / maxSummaryLength`。MC 越大，一次吞掉的原文越多、摘要上限不变 ⇒ **真实率越低** |
| **② nudge 是否还能触发** | `MC ≥ 可压缩区 chars` 时，合并结果永远 < MC ⇒ 被过滤掉 ⇒ pending = 0 | 内核原话 `nudge suppressed to avoid offering ranges below minCompressRange` ⇒ **压缩彻底失效**，请求一路涨到窗口后只剩 `truncate` 兜底 |

两条都是实测过的硬边界（200k 窗口、`R=35000`、可压缩区 ≈ 608k chars）：

| `MC`(chars) | 占可压缩区 | 峰请求 tok | 峰占窗 | 结果 |
|---|---|---|---|---|
| 21000 | 3.5% | 146465 | 73.2% | 可用（折叠偏碎、块数最多） |
| **140000（现公式值）** | **23%** | 138348 | **69.2%** | 平台内 |
| 300000 | 49% | 148013 | 74.0% | 仍在平台内 |
| **450000** | **74%** | 170806 | **85.4%** | 开始劣化 |
| **600000** | **99%** | 205960 | **103.0%** | ⚠️ **超窗** |
| **900000** | **148%** | 278972 | **139.5%** | ⚠️ **nudge 已被抑制**（内核日志：`no tier has effective compressible content … suppressed`），压缩名存实亡 |

> **为什么上限写成 `2 × (W − R)`**：按 kernel 自身记账（`chars/4`）可压缩区 ≈ `4 × (W − R)` chars，
> 取其一半即 `2 × (W − R)`。**但这套 chars 口径依赖内容类型**——中文约 1 字 ≈ 1 token，
> 同一窗口的可压缩区只有英文的 1/4，此时 MC 也必须同步压到 1/4。这正是**不能用绝对下限**的原因：
> 上一版的 `max(200000, 4R)` 在中文 200k 窗口下算出来是 200000 chars，
> 而可压缩区只有 ~165k chars ⇒ MC 反而大于可压缩区 ⇒ 压缩直接失效。
> **配额式校准**：`MC / maxSummaryLength` 就是单次折叠的压缩比（≈真实的「真实率」损失），
> 当前公式给出 102400 档 **6:1**、200k 档 **14:1**、1m 档 **39:1**（`describeAutoTune` 日志里会打印该比值）。
> 若某档要求更保真，把 `maxSummaryLength` 按 `MC/目标比` 同步放大即可（代价是成本，§7.3①）。

### ③ 三个系数是怎么定的（实测依据）

| 决策 | 结论 | 证据（同会话长度 500k/700k/1M、`steps=100/140/200` 三步均值） |
|------|------|------|
| 锚点表 | **35k / 50k / 100k** 三点分段插值 | 三点是手工调优并实测的最优值（§7.5）；插值让「表 = 公式的特例」，其余窗口由相邻锚点插值 |
| 折叠块 `GF = 1.5R` | 三窗口**最优平台的交集**取整 | `GF/R` 在 200k 上 1.5R~2.0R 都进平台（1.5R 13146 / 1.75R 13060 / 2.0R 12922）；300k 是 1.25R~1.75R（13588 / 13588 / 13602）；1M 是 1.25R~1.75R（三者均 16595）。**交集 = [1.5R, 1.75R] → 取 1.5R**（离悬崖更远）。悬崖：`GF=2R` 在 1M 上 **18140（+9.3%）**、峰值从 32.2% 跳到 **52.4%**（折叠过粗 → 大锯齿）；下限侧 `GF=1R` 三窗口都差（13805 / 14555 / 16889） |
| 粒度 `MC = clamp(4R, 8000, 2(W−R))` | **成本局部最优 + 保真翻倍** | 成本：200k 的 MC=2R **13516（更差）**、4R 13146、6R 12874、8R 12359；300k 14292/13588/13751/13339；1M 17277/16595/17180/16529。⇒ `MC=2R` 反而更贵（折叠过碎），4R 已是局部最优；6R/8R 只便宜 0~6%，但**单次折叠压缩比翻倍**（200k 档 14:1 → 28:1），保真损失不划算。上限仍受 `2(W−R)` 硬约束（§7.4② 与上一版 `max(200000,4R)` 的教训） |

### ④ 各窗口推导值 + 实测（同会话长度 500k/700k/1M 原文，perTurn=5000、sysTok=13000、仅 nudge 触发折叠）

| W | R | GF | MC | 均请求 tok | 峰值 tok | 峰值占窗 | 缓存命中 | 有效成本\* | 单次折叠压缩比 |
|---|---|---|---|---|---|---|---|---|---|
| 102400 | 15000 | 22500 | 60000 | 65605 | 98159 | 95.9% | 85.20% | 11921 | 6:1 |
| 128000 | 18500 | 28000 | 74000 | 71113 | 101253 | 79.1% | 86.20% | 12237 | 7:1 |
| **200000** | **35000** | **52500** | **140000** | 91877 | 138348 | 69.2% | 89.62% | 12827 | 14:1 |
| **300000** | **50000** | **75000** | **200000** | 114969 | 177756 | 59.3% | 91.85% | 13588 | 20:1 |
| 400000 | 62000 | 93000 | 248000 | 136932 | 214265 | 53.6% | 93.20% | 14410 | 25:1 |
| 500000 | 71000 | 106500 | 284000 | 153192 | 244397 | 48.9% | 93.87% | 15143 | 28:1 |
| **1000000** | **100000** | **150000** | **400000** | 195424 | 322238 | 32.2% | 95.32% | 16595 | 40:1 |
| 2000000 | 129000 | 193500 | 516000 | 230479 | 410316 | 20.5% | 95.72% | 18673 | 52:1 |

\* 有效成本 = `均请求tok × [(1−命中) + 命中 × 0.04]`（命中按未命中的 1/25 计价）。每格取 steps=100/140/200
三次的**均值**（峰值取三次最大）。
**8 档窗口全部不超窗**，命中率 **85.20% → 95.72% 单调上升**，成本 11.9k → 18.7k。
粗体三行是 §7.5 的**最优参数表**（锚点），其余行由公式插值/外插得到。

> 与上一版公式（`R = 35000 + 90000×log10(W/200000)`，300k→51k、1m→98k）的差异：
> 300k 成本 **14183 → 13588（−4.2%）**、峰值 61.4% → 59.3%；128k 成本 12131 → 12237（+0.9%）但
> 峰值 80.5% → **79.1%**；1m 成本**逐位相同**（16595）；2M 成本 18302 → 18673（+2.0%，R 抬高的代价）。

> **MC 的历史**：上一版公式用绝对下限 `max(200000, 4R)`，MC 是 **chars**、而 200000 chars 在小窗口下
> 会吃掉大半可压缩区（102400 档占 **67%**、单次折叠压缩比 **20:1**、峰值贴到 96.2%）。
> 改成 `clamp(4R, 8000, 2(W−R))` 后：102400 档 20:1 → **6:1**、峰值 95.9%，代价是成本 +15.5%。
> 即在**小窗口上用 10~15% 成本换 3 倍保真度 + 峰值余量**；200k 档几乎免费。若某档确实要压成本，
> 把该档 `minCompressRange` 手动放大即可（显式键优先），但**必须先确认它没越过 `2 × (W − R)`**。

### ⑤ 只钉住 R 时，其余参数怎么调（三窗口平台证据）

固定 `preserveRecentTokens`（= 锚点 R）后，只有**折叠块 `GF`** 与**压缩粒度 `MC`** 真正影响成本
（`tier2/3`、`promotionThreshold`、`preserveRecentMessages` 实测全是死键，与 §7.3 一致）。
下表就是 §7.5 参数表「GF 为什么是 1.5R、MC 为什么是 4R」的证据（同会话长度 500k/700k/1M 三步均值）：

**GF 扫描**（MC 固定 4R；粗体 = 该窗口最优区间）

| GF | 200k | 300k | 1m |
|---|---|---|---|
| 1.0R | 13805 | 14555 | 16889 |
| 1.25R | 13221 | **13588** | **16595** |
| **1.5R（公式）** | **13146** | **13588** | **16595** |
| 1.75R | **13060** | **13602** | **16595** |
| 2.0R | **12922** | 13776 | 18140 ⚠️ |

- `GF=1R`（= 把 `GF` 设成 `R` 的老配置）三窗口都最差，200k 上贵 **5.0%**、300k 上贵 **7.1%**。
- 平台随窗口右移：200k 是 1.5R~2.0R，300k/1m 是 1.25R~1.75R ⇒ **交集 [1.5R, 1.75R]，取 1.5R**（离悬崖更远）。
- 悬崖在 `GF=2R` 的 1M 上：成本 +9.3%、峰值占窗 32.2% → **52.4%**（折叠太粗 → 请求体大锯齿）。

**MC 扫描**（GF 固定 1.5R）

| MC | 200k | 300k | 1m | 单次折叠压缩比（200k） |
|---|---|---|---|---|
| 2R | 13516 | 14292 | 17277 | 7:1（**更贵**：折叠太碎） |
| **4R（公式）** | **13146** | **13588** | **16595** | **14:1** |
| 6R | 12874 | 13751 | 17180 | 21:1 |
| 8R | 12359 | 13339 | 16529 | 28:1 |

- `MC=2R` 反而**比 4R 贵** ⇒ 4R 已是成本局部最优，不是「越大越省」的单调旋钮。
- 6R/8R 只便宜 0~6%，但**单次折叠压缩比翻倍**（保真减半）——不划算，故取 4R。

### ⑥ 小窗口注意事项：瓶颈是**会话长度**，不是参数

102400 窗口在 10× 窗口长度的极限会话下峰值会贴到 96.2%（truncate 阈值 0.95）。
把 `GF` 在 1.0R~2.0R 之间怎么调都改变不了这一点——它是「压缩块缓慢堆积 ⇒ 请求地板抬升」（§7.3⑥）的必然结果。
实测 102400 的峰值随会话长度：

| 原文总量 | 100k（1×窗口） | 200k | 300k | 400k | 500k | 700k | 1000k（10×窗口） |
|---|---|---|---|---|---|---|---|
| 峰值占窗 | 76.5% | 80.4% | 81.9% | 84.2% | 85.7% | 88.7% | **96.2%** |

结论：**≤7× 窗口的会话在 102400 档仍安全（峰值 ≤89%）**；确实可能出现 10× 窗口会话的小窗口场景，
把 `maxContextLimitPct` 调低无益（§7.2⑥），应改用**更大窗口的模型**或接受 `truncate` 兜底。

**补充：小窗口下 `R` 取多少（102400 实测，steps=140 单点，perTurn=5000、sysTok=13000、maxPct=0.65）**

| R | GF=1.5R | MC=clamp(4R,·,2(W−R)) | 有效成本 | 末轮占用 |
|---|---|---|---|---|
| 50000（约占窗口一半） | 75000 | 30000 | 52415 | **164.2%（超窗）** |
| 35000 | 52500 | 134800 | 14663 | **107.2%（超窗）** |
| 30000 | 45000 | 120000 | 14527 | 90.6% |
| 25000 | 37500 | 100000 | 14363 | 77.0% |
| 20000 | 30000 | 80000 | 12873 | 75.5% |
| **15000（= autoTune 推导值，下限）** | 22500 | 60000 | **11837** | 80.8% |
| 10000（低于推导下限） | 15000 | 40000 | 12728 | 83.6% |

- **最优就是推导值 `R=15000`**，再往下（10000）反而变差（块更碎、命中下降）。
  三点均值（steps=100/140/200）：`R=15000` **11938** vs `R=50000` **52573** ⇒ **−77.3%**。
- ⚠️ **小窗口千万别手写大 `R`**：102400 里写 `preserveRecentTokens: 50000` 会吃掉半个窗口，
  实测末轮占用 134%~209%、缓存命中从 85% 腰斩到 53%~60%。**开 `autoTune` 就别覆盖 `R`**。
- ⚠️ 还要注意窗口来源：默认 Provider 的 `contextWindowTokens` 才是插件实际拿到的窗口。
  曾出现「概览显示 200000、插件按 102400 跑」的显示口径不一致（已修，见 §10②）。

### ⑦ 自证 / 复现

公式与 bench 已打通——bench 支持 `--autoTune=1`，直接消费 `src/auto-tune.ts` 的同一份实现
（不再手抄参数），并逐窗口打印推导值，便于与线上加载日志核对：

```bash
cd packages/plugins/acp-context
# ① 复现 §7.4④ 的 8 档窗口表
/opt/homebrew/bin/bun run bench/compress-params.ts \
  --lengths=102400,128000,200000,300000,400000,500000,1000000,2000000 \
  --steps=100 --perTurn=5000 --sysTok=13000 --foldOnNudge=1 --autoTune=1 \
  --maxPct=0.65 --minPct=0.35 --emergencyPct=0.80 --preserveRecentMessages=5 \
  --maxSummaryLength=10000 --minSummaryLength=1000 --promotionThreshold=10 \
  --tier2Trigger=5 --tier3Trigger=18
# （表里每档取 steps=100/140/200 三步均值，上例只跑 100；换 steps 重跑即可凑齐）

# ② 复现 §7.4⑤ / §7.5 的锚点最优性证据（只钉 R，扫 GF 与 MC）
/opt/homebrew/bin/bun run bench/compress-params.ts --lengths=200000 --steps=140 \
  --perTurn=5000 --sysTok=13000 --foldOnNudge=1 \
  --preserveRecentTokens=35000 --minCompressRange=140000 \
  --sweepGrowthFloor=35000,43750,52500,61250,70000 \
  --maxPct=0.65 --minPct=0.35 --emergencyPct=0.80 --preserveRecentMessages=5 \
  --maxSummaryLength=10000 --minSummaryLength=1000 --promotionThreshold=10 \
  --tier2Trigger=5 --tier3Trigger=18
```

线上加载日志（`plugin install`，仅 autoTune 开启时打印）形如：
`auto-tune 窗口 300000 → preserveRecentTokens=50000 / growthFloor=growthCap=minGrowthFloor=75000 / minCompressRange=200000(chars，单次折叠压缩比≈20:1)`

（末尾的「单次折叠压缩比」= `minCompressRange / maxSummaryLength`，就是**该档的保真度预算**：
值越大说明一次折叠吞掉越多原文、摘要上限不变，真实率越低。102400/200k/1m 三档分别为 6:1 / 14:1 / 40:1。
大窗口若嫌保真不足，把 `maxSummaryLength` 按 `MC / 目标比` 同步放大即可，代价是成本。）

单测：`packages/plugins/acp-context/src/auto-tune.test.ts`（锚点插值/夹取/单调、**参数表↔公式一致**、
覆盖优先级、开关兼容性）。

---

## 7.5 最优参数表（200K / 300K / 1M）＋ 其它窗口的自动适配

> 一句话：**三个常用窗口各有一张调好的表（下表 ①）；其它任何窗口都不要手调，开 `autoTune` 让公式按
> 窗口插值/外插即可（③）**。公式在三个锚点处与表**逐位一致**——表是公式的特例，不会对不上。

### ① 最优参数表（同会话长度 500k/700k/1M 实测）

> 📄 只需**可抄的一页**（含完整 jsonc 与常见窗口推导值）：[`acp-context-param-table.md`](./acp-context-param-table.md)（速查卡）。
> 本节是它的数据来源与推导依据。

| 窗口 W | `preserveRecentTokens`<br>= **R** | `nudge.growthFloor`<br>= `growthCap` = `minGrowthFloor`<br>= **GF** | `compress.minCompressRange`<br>（chars）= **MC** | 折叠节奏 | 单次折叠<br>压缩比 | 实测<br>有效成本 | 峰值<br>占窗 | 缓存<br>命中 |
|---|---|---|---|---|---|---|---|---|
| **200 000** | **35000** | **52500** | **140000** | 每涨 52.5k 触发一次，单次折掉 ≈52.5k | 14:1 | **13146** | 73.4% | 89.2% |
| **300 000** | **50000** | **75000** | **200000** | 每涨 75k 触发一次，单次折掉 ≈75k | 20:1 | **13588** | 59.3% | 91.9% |
| **1 000 000** | **100000** | **150000** | **400000** | 每涨 150k 触发一次，单次折掉 ≈150k | 40:1 | **16595** | 32.2% | 95.3% |

三档共用的**固定参数**（不随窗口变，均已实测为「死键」或安全值）：

```jsonc
{
  "preserveRecentMessages": 5,
  "promotionThreshold": 10,
  "tiers": { "tier2Trigger": 5, "tier3Trigger": 18 },
  "nudge": { "maxContextLimitPct": 0.65, "minContextLimitPct": 0.35, "emergencyThresholdPct": 0.80 },
  "config": {
    // 内核 NudgeConfig 的其余字段只能走透传口（结构化口只收上面那三个百分比键，见 §5 写法注）
    "nudge": { "growthRatio": 0, "minGrowthRatio": 0 },   // 让 nudgeGrowthTokens ≡ cadenceFloor ≡ GF
    "compress": { "maxSummaryLength": 10000, "minSummaryLength": 1000 }
  }
}
```

**直接抄用（模式 A：原始参数控制）** —— 以 300K 窗口为例，把整段贴进 `compression`：

```jsonc
{
  "compression": {
    "enabled": true,
    "modelContextLimit": 300000,
    "preserveRecentMessages": 5,
    "preserveRecentTokens": 50000,
    "promotionThreshold": 10,
    "tiers": { "tier2Trigger": 5, "tier3Trigger": 18 },
    "nudge": { "maxContextLimitPct": 0.65, "minContextLimitPct": 0.35, "emergencyThresholdPct": 0.80 },
    "config": {
      // GF 三键 = 内核 NudgeConfig 字段，只能写透传口（写进 "nudge" 不生效）
      "nudge": {
        "growthFloor": 75000, "growthCap": 75000, "minGrowthFloor": 75000,
        "growthRatio": 0, "minGrowthRatio": 0
      },
      "compress": { "minCompressRange": 200000, "maxSummaryLength": 10000, "minSummaryLength": 1000 }
    }
  }
}
```

200K / 1M 把 `modelContextLimit`、`preserveRecentTokens`、`config.nudge.growth*`、`minCompressRange`
四处换成表里的值即可（其余键三档相同）。

### ② 这三组值是怎么选出来的（每档都验过）

| 参数 | 取值依据 | 最坏情况 |
|---|---|---|
| **R** | 保真锚定（近期原文保底量），用户给定：200k→35k、300k→50k、1m→100k | 成本最优会一路往小压（1m 降到 80k 省 7.7%），但近场细节丢失，故不采用 |
| **GF = 1.5R** | 三窗口最优平台的**交集** [1.5R, 1.75R] 取低位 | 相对各窗口最优 ≤1.7%；`GF=2R` 在 1m 翻车 **+9.3%**、峰值 32%→52% |
| **MC = 4R** | 成本局部最优（`MC=2R` **更贵**）+ 保真度翻倍 | 相对 `MC=8R` 贵 0~6%，换来单次折叠压缩比减半（14:1 ← 28:1） |

扫描细节见 §7.4⑤；`MC` 的两条硬边界（过大会让 nudge 被抑制、过小会折叠碎）见 §7.4②。

### ③ 其它窗口：开 `autoTune`，别手调

```jsonc
{ "compression": { "enabled": true, "autoTune": true } }
```

窗口取**本会话实际用的那个端点**的 `providers[].contextWindowTokens`（或显式的 `compression.modelContextLimit`，
见 §1）—— 多端点混用时各会话的 `R` / `GF` / `MC` 会**各自**推导，不会共用默认 Provider 的一套。推导：

```
R  = clamp(round500(interp(W)), 15000, 150000)     // interp：log10(W) 上按上方三锚点分段线性插值，
GF = round500(1.5 × R)                             //   两端按端点段斜率延伸
MC = clamp(4 × R, 8000, 2 × (W − R))               // chars
```

常见窗口的推导结果（`GF` 为 `growthFloor = growthCap = minGrowthFloor`）：

| 窗口 W | R | GF | MC | 单次折叠压缩比 | 实测有效成本 | 峰值占窗 |
|---|---|---|---|---|---|---|
| 102 400 | 15000 | 22500 | 60000 | 6:1 | 11921 | 95.9%（极限会话） |
| 128 000 | 18500 | 28000 | 74000 | 7:1 | 12237 | 79.1% |
| 150 000 | 24500 | 37000 | 98000 | 10:1 | — | — |
| **200 000** | **35000** | **52500** | **140000** | 14:1 | 12827 | 69.2% |
| 250 000 | 43500 | 65500 | 174000 | 17:1 | — | — |
| **300 000** | **50000** | **75000** | **200000** | 20:1 | 13588 | 59.3% |
| 400 000 | 62000 | 93000 | 248000 | 25:1 | 14410 | 53.6% |
| 500 000 | 71000 | 106500 | 284000 | 28:1 | 15143 | 48.9% |
| 750 000 | 88000 | 132000 | 352000 | 35:1 | — | — |
| **1 000 000** | **100000** | **150000** | **400000** | 40:1 | 16595 | 32.2% |
| 1 500 000 | 117000 | 175500 | 468000 | 47:1 | — | — |
| 2 000 000 | 129000 | 193500 | 516000 | 52:1 | 18673 | 20.5% |

粗体三行 = ① 的参数表；「—」为未实测档（推导值，8 档实测见 §7.4④）。

**只钉一两个键**（其余继续自动跟随窗口）——例如大窗口嫌保真不足，把摘要上限按压缩比放大：

```jsonc
{
  "compression": {
    "enabled": true,
    "autoTune": true,
    "preserveRecentTokens": 150000,                                   // 钉住保真量
    "config": { "compress": { "maxSummaryLength": 40000 } }            // 1m 档 40:1 → 10:1
  }
}
```

> 注意 `GF` / `MC` 由 **`W`** 推导，**不**跟着你钉的 `R` 变；唯一例外是 `MC` 的
> `2 × (W − R)` 上限会用**生效的 R** 计算，所以把 R 钉得很大时 `MC` 会被自动压低，不会撞上
> 「nudge 被抑制」的坑（单测已覆盖）。
>
> **`nudge` 三键同源**：`growthFloor` / `growthCap` / `minGrowthFloor` 在自动模式下本就是这个模式的
> 同一个概念（`GF`），所以**只显式写其中一键时，未写的两键会跟随它**，例如：
>
> ```jsonc
> { "compression": { "autoTune": true, "config": { "nudge": { "growthFloor": 90000 } } } }
> // 300k 窗口推导 GF=75000 → 生效 90000 / 90000 / 90000
> ```
>
> 若不做这个联动，`growthFloor=90000` 配上未写的 `growthCap=75000` 会让内核的
> `min(growthCap, …)` 把用户写的值**静默截断**回 75000（这是修复前的行为）。
> 三键都显式写时原样采用；此时若 `growthFloor > growthCap` 属配置矛盾，内核以 `cap` 为准。

---

## 7.6 token 折算口径（`compression.tokenCalibration`，默认 `auto`）

### ① 它修的是什么

ACP 的所有百分比闸门（`maxContextLimitPct` / `minContextLimitPct` / `emergencyThresholdPct` /
`truncate.threshold`）都建立在**一个数字**上：本轮请求的 token 量。这个数字由插件算出来传给内核
（`runPreModel` → `engine.processTurn({ tokenCount })`）。

早年插件侧用 `chars/4` 估它，而**内核内部**（可压缩范围、保护区、工具输出截断）用的是内核自带的
CJK 感知口径 `defaultCountTokens`（中日韩 1 token/字、其余 4 字符/token）。两侧分裂的后果是
**中文会话下上报占用率只有真实值的约 1/3~1/4**：

| 轮次（300K 窗口、每轮 1 万中文字） | 旧口径上报 | 真实占用 | 修复后上报 |
|---|---|---|---|
| 第 11 轮 | 9.7% | 35.4% | **34.7%** |
| 第 21 轮 | 19.2% | 67.7% | **67.0%** |
| 第 31 轮 | 29.5% | **100.8%（已超窗）** | **103.8%** |
| 第 40 轮 | 39.3% | 131.1% | **139.2%** |

即：真实已超窗的那一轮，旧口径还显示 29.5% —— 远低于 `maxContextLimitPct`，**压缩永不触发**，
`emergencyThresholdPct` 也永不达成。完整实测与机理见速查卡
[`acp-context-param-table.md`](./acp-context-param-table.md) §六。

### ② 怎么配

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 🔧 `compression.tokenCalibration` | **`"auto"`** | `"auto"` = 与内核共用 `defaultCountTokens`（中日韩 1 token/字）。**一般不用写**。 |
| | | `"chars4"` = 旧口径（一律 `chars/4`），仅作回退 / A-B 对照。中文会话下会让上述闸门整体偏晚。 |

```jsonc
{ "compression": { "enabled": true } }                                  // 默认即 auto，推荐
{ "compression": { "enabled": true, "tokenCalibration": "chars4" } }    // 回退旧口径
```

### ③ 影响面

口径同时注入两处（`createCore({ countTokens })` 与 `estimateTokens(cores, countTokens)`），
因此以下表面全部同步：占用率闸门、`acp_status` 显示的占用、遥测 `rawTok` / `requestTok` /
`occupancy`（导出报告与 TUI 同源）、工具输出截断阈值。

### ④ 对参数表的影响：**不需要重扫**

新实现与**内核内部口径完全一致**（内核各计数点同样逐条调 `countMessageTokens`），这才是修复目标。
相对**旧的插件实现**（`ceil(Σlen/4)`，先求和再取整）纯 ASCII 下会有**逐条 ceil 的舍入差**：
新值恒 ≥ 旧值、差 ≤ core 数 − 1 个 token（实测约 1%），不足以移动任何闸门 ⇒
**英文会话零行为差异**（60 轮对照：首次折叠轮次、折叠次数、真实峰值 157965 全部一致，差 0.00%）。
所以 §7.5 的三窗口参数表继续有效；只有中文会话的**触发时机**被修正。

> 唯一遗留项：`minCompressRange` 是 **chars** 口径，`MC = 4R` 里的 `4` 按英文折算率推得。
> 中文下同一个 `MC` 相对保护区粗 4 倍（不会越界，实测 MC 被拒 0 次），属可选优化，
> 详见速查卡 §六.5。

---

## 8. 完整配置示例

**模式 A：原始压缩参数控制（`autoTune: false`，默认，行为与升级前一致）**

```jsonc
{
  "provider": "my-gw",
  "providers": [
    { "id": "my-gw", "type": "openai", "baseUrl": "https://…", "apiKey": "enc:v1:…", "contextWindowTokens": 200000 }
  ],
  "compression": {
    "enabled": true,
    "autoTune": false,                  // 或直接省略
    "modelContextLimit": 200000,        // 省略则用 providers[].contextWindowTokens（再缺省 200000）
    "preserveRecentMessages": 10,       // 层保留：保留最近 10 条原文
    "preserveRecentTokens": 8000,       // 层保留：最近 8K tokens 不压缩（默认 5000）
    "promotionThreshold": 5,            // 块存活 5 次才升层
    "tiers": { "tier2Trigger": 5, "tier3Trigger": 10 },
    "nudge": { "maxContextLimitPct": 0.75, "minContextLimitPct": 0.45, "emergencyThresholdPct": 0.95 },
    "prompts": { "howToCompressRules": "…你的 t1 规则…" },   // 缺省读 prompts/*.txt
    "systemPrompt": "…整段覆盖压缩系统提示…",                  // 选填，最高优先
    "config": { "compress": { "minSummaryLength": 30 } }      // 高级透传
  }
}
```

**模式 B：按窗口自动适配（`autoTune: true`，推荐——换窗口不用改配置）**

```jsonc
{
  "provider": "my-gw",
  "providers": [
    // 窗口直接由 Provider 声明：换模型即自动换参数
    { "id": "my-gw", "type": "openai", "baseUrl": "https://…", "apiKey": "enc:v1:…", "contextWindowTokens": 1000000 }
  ],
  "compression": {
    "enabled": true,
    "autoTune": true,
    // 推导结果（1m 窗口，见 §7.5①，与参数表逐位一致）：
    //   preserveRecentTokens = 100000
    //   nudge.growthFloor = growthCap = minGrowthFloor = 150000
    //   compress.minCompressRange = 400000 (chars)
    // 示例：只钉住保留量与提示词，其余继续自动跟随窗口
    "preserveRecentTokens": 120000,
    "prompts": { "howToCompressRules": "…你的 t1 规则…" }
  }
}
```

> 模式 B 下**未写**的键（`nudge.*`、`compress.minCompressRange`、`tiers.*`、`promotionThreshold`、
> `maxSummaryLength` 等）由 `W` 推导；**写了**的键按写的生效。
> `harness config` 会显示当前处于哪种模式。

---

## 9. 默认值汇总速查

| 配置项 | 默认值 |
|--------|--------|
| `compression.enabled` | **false** |
| `compression.autoTune` | **false**（= 原始压缩参数控制；true = 按窗口自动推导，见 §7.4） |
| 窗口解析（**按本会话实际端点**，见 §1）：显式 → `providers[].contextWindowTokens` → 兜底 | — / — / **200000** |
| `preserveRecentMessages` | **5** |
| `preserveRecentTokens` | **5000** |
| `promotionThreshold` | **5** |
| `tiers.tier2Trigger` | **5** |
| `tiers.tier3Trigger` | **10** |
| `nudge.maxContextLimitPct` | **0.75** |
| `nudge.minContextLimitPct` | **0.45** |
| `nudge.emergencyThresholdPct` | **0.95** |
| `nudge.growthRatio` / `growthFloor` / `growthCap` | **0.05 / 50000 / 50000**（合成 `nudgeGrowthTokens`，见 §7.1）<br>⚠️ 都是内核字段 ⇒ 写 `config.nudge.*`（见 §5 写法注） |
| `nudge.minGrowthFloor` / `minGrowthRatio` | **20000 / 0.45**（折叠节奏，见 §7.1）<br>⚠️ 同上，写 `config.nudge.*` |
| 窗口缩放推荐 `preserveRecentTokens` | 手工/成本口径版：`R(W) = 30000 + 28600×log10(W/200000)`，夹 [15000,150000]：200k→**30k**、300k→**35k**、1m→**50k**（见 §7.2）<br>**自动适配版（锚定保真值）**：三锚点 `(200k,35k) (300k,50k) (1m,100k)` 在 `log10(W)` 上分段插值、两端延伸，夹 [15000,150000]（见 §7.5③） |
| **最优参数表（200K/300K/1M）** | 200K → `R=35000 / GF=52500 / MC=140000`；300K → **`50000 / 75000 / 200000`**；1M → **`100000 / 150000 / 400000`**（见 §7.5①） |
| `autoTune: true` 的推导组合 | `preserveRecentTokens=R(W)`；`nudge.growthFloor = growthCap = minGrowthFloor = round500(1.5R)`；`compress.minCompressRange = clamp(4R, 8000, 2×(W−R))`；`growthRatio=minGrowthRatio=0`（见 §7.4②/§7.5③） |
| 只钉 `nudge` 中的一键 | **三键同源**：未显式写的两键跟随你写的那一键（避免 `growthFloor > growthCap` 让显式值被内核静默截断）。三键都写则原样采用（见 §7.5③） |
| 固定 R 后的其余参数 | 只有 `nudge.growthFloor`（折叠块大小）与 `compress.minCompressRange` 有效：200k/R=35k → **52500 / 140000**；300k/R=50k → **75000 / 200000**；1m/R=100k → **150000 / 400000**（见 §7.5②，取代 §7.3 的旧值） |
| `tokenCalibration` | **`"auto"`**（CJK 感知：中日韩 1 token/字）、`"chars4"` 回退旧口径（见 §7.6）<br>⚠️ 旧口径下中文会话的占用率只有真值的约 1/3~1/4，百分比闸门整体偏晚 |
| 有效成本口径 | `均请求 tok × [(1−命中) + 命中 × 0.04]`（命中缓存按未命中的 **1/25** 计价，见 §7.2②） |
| 谷请求 tok | 后半程最小请求体 = 请求地板（系统提示词 + R + 累积压缩块），随会话单调抬升（见 §7.3⑥） |
| `prompts.*` | 插件 `prompts/*.txt`（= 内核 defaultPrompts） |
| `systemPrompt` | 未设（由 prompts 合成） |
| `compress.minCompressRange` / `maxSummaryLength` / `minSummaryLength` | 5000 / 20000 / 50 |
| `truncate.threshold` | 0.95 |
| `protectedTools` | [] |
| `absorb.enabled` | false |
| `manualInjection` | **`"on-demand"`**（`"always"` / `"off"` 见 §11②） |
| `subagent` / `perAgent[*]` | 未配 —— 即全部会话逐位沿用顶层，**零行为变更**（见 §11①） |

## 10. 校验规则

### ① kernel `validateConfig`（违反即 boot 抛错）

- `nudge.minContextLimitPct ≤ nudge.maxContextLimitPct ≤ nudge.emergencyThresholdPct`
- `promotionThreshold ≥ 1`
- `tiers.tier2Trigger ≥ 2`、`tiers.tier3Trigger ≥ 2`，且 `tier3Trigger > tier2Trigger`
- 任一违反会抛配置错误（boot 报错而非静默）。

### ② CLI 侧形状校验（写错键 / 写错取值 → **告警**，不阻断启动）

`defaultConfig` 的合并尾部是 `{...base, ...overrides, 子树:{...}}` ⇒ **未知键被静默丢弃**；
`tokenCalibration` 又是 `=== 'chars4' ? 旧口径 : 自动`，拼错会**静默降级到默认值 auto** ——
两者都"看起来完全正常"（概览照常显示 `token 口径 自动（CJK 感知）`），必须显式比对白名单才能发现。

现已接入 CLI 校验（`checkCompressionConfig`），启动时打印、`--check-config` 与 `/config` 概览里展示：

```
[WARN] config.json → compression 有以下未生效项：
       - compression.preserveRecentToken 未被识别，该配置不会生效
       - compression.tokenCalibration 取值 "chars/4" 未知（可选：auto / chars4），已按默认 auto 处理
       - compression.nudge.growthFloar 未被识别，该配置不会生效
```

**告警会指路（"写错了口"与"拼错了键"分开处理）**：

- **写错了口**（键确实是内核字段，只是写进了只收常用键的结构化口）⇒ 直接给出**能生效的那条路径**：

  ```
  [WARN] config.json → compression 有以下未生效项：
         - compression.subagent.nudge.growthFloor 未被识别（.subagent.nudge 结构化口只收
           maxContextLimitPct / minContextLimitPct / emergencyThresholdPct）—— 该键是内核字段，
           请写到 compression.subagent.config.nudge.growthFloor 才生效
  ```

- **拼错了键**（`growthFloar` 这类内核里**也不存在**的写法）⇒ 维持朴素文案，**不指路**。
  指路只认内核真实字段名；否则用户会照着告警抄一条同样无效的路径，比不指路更糟。
- `telemetry` 段没有压缩那样的高级透传口可兜底，写错的键在本段没有别的去处 ⇒ 告警附**可用键清单**，
  例如 `telemetry.store 未被识别，该配置不会生效（可用键：enabled / path / debounceMs / crash / userId / otlp）`。

- **校验范围**：`compression` 顶层 / `tiers` / `nudge` / `telemetry` / `prompts`，
  作用域档位 `subagent` 与 `perAgent[*]`（含各档位自己的 `manualInjection` / `tiers` / `nudge` / `config`），
  以及高级透传 `config` 的 `config.tiers` / `config.nudge` / `config.compress` / `config.truncate` / `config.absorb`。
  档位里写错键的告警带**作用域路径**，例如 `compression.perAgent.reader.preserveRecentToken 未被识别，该档位不会生效`。
- **不阻断**：这是告警不是错误，`--check-config` 的退出码不受影响（只有 providers 的错误才返回 1）。
- **白名单不过期**：用 `Record<keyof 内核类型, true>` 书写，内核增删/改名时**编译期即报错**。
- ⚠️ 最典型的踩法：照抄 §7.5 参数表时把 `preserveRecentTokens` 写成单数、把 `tokenCalibration: "chars4"`
  写成 `"chars/4"` —— 前者完全不生效，后者会把 A-B 对照实验跑成"两组都是 auto"（实测差 ≈ 0 ⇒ 结论反向）。

---

## 11. 按作用域覆盖：子 Agent 档 / 指定 Agent 档

**要解决什么**：压缩引擎**只有一个实例**，同时服务主 Agent 与全部子 Agent —— 子 Agent 不是子进程，
而是同一 Harness 上 `session.create({ parentId })` 出来的**会话**。默认它们逐位共用顶层配置，但两类会话的
**信息密度**常不同：只读检索型子 Agent 的上下文涨得快、汇报完的原文就再也不会被引用，而主会话每一轮都要保真。

### ① 两个档位

| 配置项 | 作用于 | 判据 |
|--------|--------|------|
| 🔧 `compression.subagent` | **全部子 Agent 会话** | `Session.parentId` 非空（顶层字段，由 `session.create({ parentId })` 写入） |
| 🔧 `compression.perAgent.<agentId>` | **指定的那一类 Agent**（主 / 子 / coordinator 都算） | 该轮 `agentId` 精确相等 |

**优先级：`perAgent[agentId]` > `subagent` > 顶层。** 两者回答的是不同问题
（"凡是派生出来的会话该怎么压" vs "这一种 Agent 该怎么压"），所以都保留。
两者都不写 = 逐位沿用顶层（**缺省零行为变更**）。

```jsonc
{
  "compression": {
    "enabled": true,
    "modelContextLimit": 200000,
    "preserveRecentTokens": 50000,
    "subagent": {
      // 子 Agent 会话：保底部更短 ⇒ 更早折叠（检索型子会话不需要长保真尾部）
      "preserveRecentTokens": 15000
    },
    "perAgent": {
      "reader": { "modelContextLimit": 131072, "preserveRecentTokens": 12000 },
      "coordinator": { "manualInjection": "off" }
    }
  }
}
```

档位段里能写的键 = **与顶层同一套键名**：`modelContextLimit` / `manualInjection` /
`preserveRecentMessages` / `preserveRecentTokens` / `promotionThreshold` / `tiers` / `nudge` / `config`。
刻意不做"顶层一种语法、档位另一种语法"（那种不一致正是"配了却不生效"的温床）。翻译代码也只有**一份**
（`toAcpConfig`），顶层与档位共用 —— 想改语法就得同时改到两边，没有漂移的余地。

⚠️ **`nudge` / `tiers` 的"字段名 ≠ 可写路径"规则在档位里同样适用**（见 §5 写法注）：档位里的结构化口
也只收常用的那几个键，内核字段要写进**档位的 `config`**。例如给子 Agent 单独设折叠块大小：

```jsonc
{ "compression": { "subagent": {
  "preserveRecentTokens": 50000,
  "tiers": { "tier2Trigger": 10 },
  "config": { "nudge": { "growthFloor": 70000 } }   // ← 不是 "nudge": { "growthFloor": ... }
} } }
```

（写在 `subagent.nudge.growthFloor` 会告警，并直接提示该写到 `subagent.config.nudge.growthFloor`。）

**唯一不允许写进档位的是 `tokenCalibration` / `tokenCalibrationScale`**：折算口径与 `createCore` 注入的
`countTokens` 是**同一个函数**，全进程只能有一把尺子；否则会退化成"决策用一把尺、报表用另一把"（本仓反复
得过的病：占用率显示 26% 实际 103%）。

> **窗口同源**：档位改了 `modelContextLimit` 后，**注入决策与 `acp_status` 报表读的是同一份** config
> （会话上下文里存着本次解析出的 scope）。不会出现"按 100k 判该压、报表却按 200k 显示"。
> 同理，**按实际端点解析出的窗口**（§1）也走这一份 —— 报表里的 `modelContextLimit` 就是本会话的分母。

### ② `manualInjection`（压缩手册怎么给）

| 取值 | 行为 |
|------|------|
| `"on-demand"` | **默认**。尾部常驻一行极简提示；真到该压的时候（占用过 `nudge` 档）才注入完整手册 |
| `"always"` | 每轮都注入完整手册（= 改造前的旧行为；调试 / "强制模型手压"场景） |
| `"off"` | **完全不给**任何压缩提示（含 nudge 文案） |

`"always"` 是**显式**要求，优先于下节的自动抑制 —— 显式配置不该被自动推断悄悄推翻。

### ③ 能力边界：白名单里没有 `compress` 就不给手册

手册的内容是"邀请你调用 `compress`"。若该 Agent 的工具白名单里**根本没有** `compress`，这份邀请只会
诱导它去撞 `TOOL_NOT_ALLOWED`（真机证据：某只读子 Agent 12 次调用 100% 被拒）。所以：

- 白名单里没有 `compress` ⇒ 极简提示 / 完整手册 / nudge 文案**全部不注入**；
- **判别符缺失**（非 core 宿主 / 单测直调，拿不到"这个 Agent 能用哪些工具"）⇒ **fail-open**，按旧行为注入。
  两种判错的代价不对称：未知时只是多付一份说明书的 token，而误判成空集会**静默关掉**一个本来能用压缩的
  Agent 的全部提示。

**想让只读子 Agent 也能压缩，正确做法是把压缩工具加进它的白名单**（改 agent md 的 `tools:`），
而不是绕过这条抑制。四个都只动本会话上下文、不碰文件系统：
`compress` / `decompress` / `search_context` / `acp_status`。

> ⚠️ 往 `tools:` 块里加行时**别在序列中间插注释**——`parseBlock` 的列表分支遇到注释行会 `break`，
> 后面的项**静默消失**（frontmatter 逐字段白名单解析，列表被截断后依旧"解析成功"）。
> 该缺陷已修（注释行现在跳过而非终止），但改动配置后仍建议用 `agentFromMarkdown` 复验一遍实际拿到的工具集。

### ④ `perAgent` 的 agent id 写错了怎么办

`perAgent` 的 key 是 agent id，写错**没有任何自然反馈**（档位就是不生效）。所以启动时会核对 `perAgent`
的 key 是否都在 Agent 注册表里：未知的打印 `warn`（附**可用 id 列表**）但**不阻断启动**；
宿主拿不到注册表时安静跳过（不猜、也不制造噪音）。