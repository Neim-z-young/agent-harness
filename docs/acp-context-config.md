# ACP 上下文压缩配置参考（`@harness/acp-context`）

> 本文档列出的默认值以 acp-kernel `defaultConfig(modelContextLimit)` 的**实际默认**为准
> （`node_modules/acp-kernel/dist/index.js` → `defaultConfig`）。带「🔧 = 可在 config.json 结构化配置」、
> 「⬇ = 高级透传（`compression.config`）」标注的是本项目暴露的配置入口。

## 0. 启用与入口

`config.json` 顶层 `compression` 段作为唯一装配入口。`enabled: true` 才在 CLI boot 时惰性装配
`@harness/acp-context`；缺省 `enabled` 为 **false**（默认不启用 ACP）。

```jsonc
{ "compression": { "enabled": true } }
```

---

## 1. 模型上下文窗口（输入 tokens）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 🔧 `compression.modelContextLimit` | —（缺省走推导） | 模型输入上下文窗口，ACP 据此算 `contextUsage`、判各层压缩触发。显式覆盖优先。 |
| 🔧 `providers[].contextWindowTokens` | — | **模型上下文大小放模型配置**：默认 Provider 的窗口来源。 |
| 推导优先级 | — | `compression.modelContextLimit` → 默认 Provider 的 `providers[].contextWindowTokens` → 插件默认 **200_000** |

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

## 8. 完整配置示例

```jsonc
{
  "provider": "my-gw",
  "providers": [
    { "id": "my-gw", "type": "openai", "baseUrl": "https://…", "apiKey": "enc:v1:…", "contextWindowTokens": 200000 }
  ],
  "compression": {
    "enabled": true,
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

---

## 9. 默认值汇总速查

| 配置项 | 默认值 |
|--------|--------|
| `compression.enabled` | **false** |
| 窗口推导：`modelContextLimit` → `providers[].contextWindowTokens` → 兜底 | — / — / **200000** |
| `preserveRecentMessages` | **5** |
| `preserveRecentTokens` | **5000** |
| `promotionThreshold` | **5** |
| `tiers.tier2Trigger` | **5** |
| `tiers.tier3Trigger` | **10** |
| `nudge.maxContextLimitPct` | **0.75** |
| `nudge.minContextLimitPct` | **0.45** |
| `nudge.emergencyThresholdPct` | **0.95** |
| `prompts.*` | 插件 `prompts/*.txt`（= 内核 defaultPrompts） |
| `systemPrompt` | 未设（由 prompts 合成） |
| `compress.minCompressRange` / `maxSummaryLength` / `minSummaryLength` | 5000 / 20000 / 50 |
| `truncate.threshold` | 0.95 |
| `protectedTools` | [] |
| `absorb.enabled` | false |

## 10. 校验规则（kernel `validateConfig`）

- `nudge.minContextLimitPct ≤ nudge.maxContextLimitPct ≤ nudge.emergencyThresholdPct`
- `promotionThreshold ≥ 1`
- `tiers.tier2Trigger ≥ 2`、`tiers.tier3Trigger ≥ 2`，且 `tier3Trigger > tier2Trigger`
- 任一违反会抛配置错误（boot 报错而非静默）。