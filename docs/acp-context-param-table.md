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
2. **`MC` 是 chars，但窗口/保护区是 tokens，两者之间差一个折算率。** `MC` 是折叠粒度，比较对象是
   **真实字符数**（`buildCompressibleRanges` 记 `chars: (msg.text ?? '').length`）；而 `4R` 与护栏
   `2 × (W − R)` 都按 **4 chars/token** 折算——中文约 1 字 = 1 token 时，同一公式给出的 `MC`
   相对中文可压缩区就**粗了 4 倍**（护栏也随之松 4 倍）。**所以绝不能写成绝对下限**
   （这正是上一版公式 `max(200000, 4R)` 失效的原因）。实测（300K 窗口、40 条中文消息共 413k 字、
   R=50k、MC=200k）可压缩区 353k chars，**尚未越界，但余量已从"4 倍"缩到 1.7 倍**。
   ⚠️ 更正：早前此处写"内核按 `chars/4` 估 token"是**错的**——内核默认口径本就 CJK 感知，
   详见 §六（那里有完整实测与已落地的修复）。

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


## 六、中文会话的 token 口径（已落地：`tokenCalibration`，默认 `auto`）

### 1. 问题不是"内核用 chars/4"，而是**两侧口径分裂**

先更正一条早期误判（我只读了 `.d.ts` 注释就下结论，属事实错误）：

- **内核默认口径本来就是 CJK 感知的**。`createCore(ports = {})` 取 `ports.countTokens ?? defaultCountTokens`，
  而 `defaultCountTokens` 是 `中日韩字符 1 token/字 + 其余 4 字符/token` 的混合式
  （`matches /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/`）。且 `computeProtectedRefs` /
  `buildCompressibleRanges` / `pendingByTier` / `truncateLargeToolOutputs` 全部传 `ctx.countTokens` ⇒
  **内核内部计数一直是 CJK 口径**。
- **真正错的是插件侧**：`adapter.ts` 的 `estimateTokens()` 一律 `ceil(Σ chars / 4)`，而它算出的
  `tokenCount` 正是占用率百分比（`maxContextLimitPct` / `emergencyThresholdPct` / `truncate.threshold`）
  的唯一输入。于是形成「**内核按 CJK 口径数范围，闸门按 chars/4 判占用**」的分裂。

### 2. 分裂的实际后果（真实插件链路实测）

`createAcpContextPlugin` → `session.preModel` 驱动，300K 窗口、每轮 1 万中文字、`autoTune` 开启，
读 `acp_status` 上报的占用率与真实占用（真实 = 逐 part 走 `defaultCountTokens`）对比：

| 轮次 | `chars4` 上报 / 真实 | 偏差 | `auto` 上报 / 真实 | 偏差 |
|---|---|---|---|---|
| 11 | 9.7% / 35.4% | **0.27×** | 34.7% / 35.4% | **0.98×** |
| 21 | 19.2% / 67.7% | 0.28× | 67.0% / 67.7% | 0.99× |
| 31 | 29.5% / **100.8%（已超窗）** | 0.29× | 103.8% / 105.0% | 0.99× |
| 40 | 39.3% / 131.1% | 0.30× | 139.2% / 140.4% | 0.99× |

第 31 轮真实已 **100.8%**，旧口径只报 **29.5%**——低于 `maxContextLimitPct=0.65`，
**压缩根本不会触发**；`emergencyThresholdPct=0.80` 同样永不达成。这不是参数值问题，是口径问题，
调 `R`/`GF`/`MC` 一个都救不了。

### 3. 修复：两侧共用同一函数 + 一个开关

```ts
// adapter.ts —— 口径的两个候选，均直接复用内核实现
export const cjkAwareCountTokens: TokenCountFn = defaultCountTokens          // 1 字≈1 token（默认）
export const chars4CountTokens: TokenCountFn = (t) => t ? Math.ceil(t.length / 4) : 0  // 旧口径
export function estimateTokens(cores, countTokens = defaultCountTokens): number  // 逐条 countMessageTokens
```

插件把**同一个函数**同时注入内核与自己的上报路径，口径不可能再分裂：

```ts
const countTokens = options.tokenCalibration === 'chars4' ? chars4CountTokens : cjkAwareCountTokens
const engine = createCore({ countTokens })            // 内核内部计数
const tokenCount = estimateTokens(inflat.cores, countTokens)  // 占用率闸门
```

配置（默认 `auto`，无需显式写）：

```jsonc
{ "compression": { "enabled": true, "tokenCalibration": "auto" } }   // "chars4" 回退旧口径
```

顺带修好：`acp_status` 占用率、遥测 `rawTok` / `requestTok` / `occupancy`（TUI 那条链）、
工具输出截断阈值——它们都走 `estimateTokens`，一处改全线同步。

### 4. 对参数表的影响：**不用重扫**（这也是实测结论）

新实现与**内核内部口径完全一致**（内核每个计数点也走逐条 `countMessageTokens`）——这才是修复目标。
相对**旧的插件实现**（`ceil(Σlen/4)`，先求和再取整）在纯 ASCII 下存在**逐条 ceil 的舍入差**：
新值恒 ≥ 旧值，差额 ≤ core 数 − 1 个 token（7 条混杂消息实测 265 → 268，约 1%）。
这点差异不足以移动任何闸门，**英文会话实测零行为差异**：
同一内核链路（`processTurn` + `applyCompression`，模拟模型按 nudge 折叠）跑 300K / 60 轮对照：

| 场景 | 指标 | 旧口径 | 新口径 |
|---|---|---|---|
| **中文**（每轮 2 万字） | 首次折叠 | 第 15 轮（真实已 **103.3%**） | 第 12 轮（真实 84.7%） |
| | 折叠次数 | 2 | 19 |
| | 真实峰值 / 占窗 | 621540 = **207.2% 超窗** | 274654 = **91.6%** |
| | 末轮真实占窗 | 123.4% | 73.9% |
| **英文**（每轮 2 万字符） | 首次折叠 / 折叠次数 | 第 29 轮 / 2 次 | 第 29 轮 / 2 次 |
| | 真实峰值 / 占窗 | 157965 / 52.7% | **157965 / 52.7%（差 0.00%）** |

⇒ **英文 60 轮所有折叠指标逐位相同**（唯一差异是 reason 里 `growth 40197 → 40198`，即上面那条
+1 token 的逐条 ceil 舍入），**§一 的三窗口参数表继续有效，不需要按新坐标系重扫。**

> 口径差异的**唯一后果**是「中文会话触发时机提前到正确位置」；英文侧连 1 token 的舍入差都没有
> 改变过折叠轮次。所以这条修复不需要重调任何参数——重扫的只是**中文**会话的行为预期。

### 5. 唯一还"悬"着的：`MC` 的 chars 与折算率

`minCompressRange` 是**真实字符数**口径（`buildCompressibleRanges` 里 `chars: (msg.text ?? '').length`，
`pendingByTier` 用 `(r.chars ?? r.tokens * 4) >= minCompressRange` 过滤），**不随 tokenizer 变**。
所以 `MC = 4R` 的本义是「折叠粒度 ≈ R tokens 的内容量」（英文 4 字符/token ⇒ 4R chars）。

中文 1 字 ≈ 1 token ⇒ 同一个 `MC = 4R` chars 对应的其实是 **4R tokens** 的粒度，相对保护区
（`R` tokens）**粗了 4 倍**。实测在 300K 中文会话里**并不会越界**（MC 越界被拒 0 次，
可压缩区仍是 MC 的 1.7 倍余量），只是单次折叠吞得更多、锯齿更大。

要不要按折算率重算（纯中文 ≈ `MC = R`，即令 `MC = R × 折算率`）属于**下一步的可选优化**，
不是本次修复的前置条件；真要做，`AUTO_TUNE_MIN_COMPRESS_FACTOR` 是唯一改动点。
