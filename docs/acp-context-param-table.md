# ACP 压缩最优参数表（速查卡）

> **用法**：常用窗口（200K / 300K / 1M）照下表直接在 `config.json` 的 `compression` 段配置；
> **其它窗口不要手调**，把 `compression.autoTune` 设为 `true` 让公式按窗口自动适配。
>
> 推导过程、8 档窗口实测、为什么是这几个系数 → `docs/acp-context-config.md` **§7.5**
> （公式的唯一实现是 `packages/plugins/acp-context/src/auto-tune.ts`，锚点表 `AUTO_TUNE_ANCHORS`
> 有单测「参数表 ↔ 公式一致」兜底，改表请同步本页与 §7.5）。
>
> 实测口径：同会话长度 500k/700k/1M 原文、`perTurn=5000`、`sysTok=13000`、仅 nudge 触发折叠；
> 有效成本 = `均请求 tok × [(1−命中) + 命中 × 1/25]`。

## 一、最优参数表

| 窗口 W | `preserveRecentTokens` | `nudge.growthFloor`<br>= `growthCap` = `minGrowthFloor` | `compress.minCompressRange`<br>（单位 chars） | 单次折叠压缩比 | 缓存命中 | 峰值占窗 |
|---|---|---|---|---|---|---|
| **200 000** | **35000** | **52500** | **140000** | 14:1 | 89.2% | 73.4% |
| **300 000** | **50000** | **75000** | **200000** | 20:1 | 91.9% | 59.3% |
| **1 000 000** | **100000** | **150000** | **400000** | 40:1 | 95.3% | 32.2% |

三档**共用**的固定值（已实测为死键或安全值）：

| 配置项 | 取值 |
|---|---|
| `preserveRecentMessages` | `5` |
| `promotionThreshold` | `10` |
| `tiers.tier2Trigger` / `tiers.tier3Trigger` | `5` / `18` |
| `nudge.growthRatio` / `nudge.minGrowthRatio` | `0` / `0`（让折叠节奏恒等于 `growthFloor`） |
| `nudge.maxContextLimitPct` / `minContextLimitPct` / `emergencyThresholdPct` | `0.65` / `0.35` / `0.80` |
| `config.compress.maxSummaryLength` / `minSummaryLength` | `10000` / `1000` |

## 二、直接抄（以 300K 为例）

```jsonc
{
  "compression": {
    "enabled": true,
    "modelContextLimit": 300000,
    "preserveRecentMessages": 5,
    "preserveRecentTokens": 50000,
    "promotionThreshold": 10,
    "tiers": { "tier2Trigger": 5, "tier3Trigger": 18 },
    "nudge": {
      "growthFloor": 75000,
      "growthCap": 75000,
      "minGrowthFloor": 75000,
      "growthRatio": 0,
      "minGrowthRatio": 0,
      "maxContextLimitPct": 0.65,
      "minContextLimitPct": 0.35,
      "emergencyThresholdPct": 0.80
    },
    "config": {
      "compress": { "minCompressRange": 200000, "maxSummaryLength": 10000, "minSummaryLength": 1000 }
    }
  }
}
```

200K / 1M 只改四处：`modelContextLimit`、`preserveRecentTokens`、`nudge.growthFloor`+`growthCap`+`minGrowthFloor`、
`config.compress.minCompressRange`。

## 三、其它窗口 → 开 `autoTune`

```jsonc
{ "compression": { "enabled": true, "autoTune": true } }
```

窗口取自 `providers[].contextWindowTokens`（或 `compression.modelContextLimit`）。推导值：

| 窗口 | 102 400 | 128 000 | 150 000 | 200 000 | 250 000 | 300 000 | 400 000 | 500 000 | 750 000 | 1 000 000 | 1 500 000 | 2 000 000 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `preserveRecentTokens` | 15000 | 18500 | 24500 | **35000** | 43500 | **50000** | 62000 | 71000 | 88000 | **100000** | 117000 | 129000 |
| `growthFloor`（=cap=minFloor） | 22500 | 28000 | 37000 | **52500** | 65500 | **75000** | 93000 | 106500 | 132000 | **150000** | 175500 | 193500 |
| `minCompressRange` | 60000 | 74000 | 98000 | **140000** | 174000 | **200000** | 248000 | 284000 | 352000 | **400000** | 468000 | 516000 |

推导式（锚点 `(200k,35k) (300k,50k) (1m,100k)`，在 `log10(W)` 上分段线性插值、两端按端点段斜率延伸）：

```
R  = clamp( round500( interp(W) ), 15000, 150000 )          // tokens
GF = round500( 1.5 × R )                                    // growthFloor = growthCap = minGrowthFloor
MC = clamp( 4 × R, 8000, 2 × ( W − R ) )                    // chars；上限保证 nudge 不被抑制
```

**只想钉一两个键**（其余继续自动跟随窗口）——例如大窗口要更保真，把摘要上限按压缩比放大：

```jsonc
{
  "compression": {
    "enabled": true,
    "autoTune": true,
    "preserveRecentTokens": 150000,
    "config": { "compress": { "maxSummaryLength": 40000 } }   // 1M 档压缩比 40:1 → 10:1
  }
}
```

## 四、两条硬约束（踩过坑）

1. **`minCompressRange` 是折叠粒度（chars），不是窗口阈值。** 超过可压缩区会让 kernel 的
   `pendingByTier` 把候选范围全部过滤掉 → nudge 被抑制 → **压缩彻底失效**，请求一路涨到窗口后
   只能靠 `truncate` 兜底（实测 200K 窗口 MC=600000 chars 时峰值 103% 超窗）。公式里的 `2 × (W − R)`
   就是这条护栏。
2. **中文内容下 `chars` 口径会偏 4 倍。** 内核按 `chars/4` 估 token（英文适用），而中文约 1 字 ≈ 1 token
   ⇒ 同一窗口的可压缩区（chars）只有英文的 1/4，`minCompressRange` 必须同步压到 1/4。
   **所以它绝不能写成绝对下限**（这正是上一版公式 `max(200000, 4R)` 失效的原因）。

## 五、偏离参数表的代价（300K 实测，能不改就别改）

表里的 `GF = 1.5R` / `MC = 4R` 是"最优平台的交集"与"成本局部最优"，往任何一侧挪都要付代价：

| 改动（300K，R 固定 50k） | 有效成本 | vs 表值 | 峰值占窗 | 缓存命中 | 说明 |
|---|---|---|---|---|---|
| **表值** `GF=75k(1.5R)` `MC=200k(4R)` | **13588** | — | 59.3% | 91.9% | 基准 |
| 只把 `MC` 降到 150k（3R） | 14011 | **+3.1%** | 71.0% | 91.8% | 折叠更碎 → 总请求变多；换来单次折叠压缩比 20:1→15:1 |
| 只把 `GF` 抬到 100k（2R） | 13721 | **+1.0%** | 71.0% | 92.6% | 折叠更少 → 前缀更稳（命中 +0.7pp），但峰值抬高 |
| `GF=100k` + `MC=150k` | 13795 | **+1.5%** | 65.4% | 92.6% | 两者效果部分抵消；成本升幅不大，**主要是峰值余量变薄** |

要点：**这两个方向都是"反着最优走"**，成本一定会升（8 个会话长度采样：+0.6% ~ +3.1%，均值 +1.5%），
没有一档变便宜。`GF` 抬到 `2R` 在 300K 只贵 1%，但**同样的做法在 1M 上会恶化到 +9.3%**、峰值 32%→52%
（折叠过粗 → 请求体大锯齿），所以不要把这个改动推广到大窗口。

若确实想少折叠、让前缀更稳：**只抬 `GF`（≤2R）、`MC` 留在 `4R`**，代价约 1%。
若想更保真：抬 `maxSummaryLength`（大窗口档压缩比 40:1 的主要来源）比降 `MC` 划算。
