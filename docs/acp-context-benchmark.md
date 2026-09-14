# ACP 压测与离线分析脚本使用参考（`@harness/acp-context`）

> 三套脚本，覆盖「**事前仿真压测 → 实际运行遥测 → 事后数据分析**」完整闭环，帮助在
> 不同上下文长度下对比压缩参数，从而调整 `config.json compression.*`。
>
> 全部脚本位于 `packages/plugins/acp-context/bench/`，运行方式均为 `bun run bench/<name>.ts`。

| 脚本 | 数据源 | 用途 |
|------|--------|------|
| [`compress-params.ts`](#1-自带压测-bench中compress-paramsts) | 合成历史（无真实模型） | 仿真不同上下文长度 × 参数组合 → 压缩比/占用率/缓存命中/tier 块分布 |
| [`analysis-params.ts`](#3-参数组合离线分析-bench中analysis-paramsts) | 运行时遥测 JSONL | 把真实会话按「参数组合 × 窗口」聚合 → 各组合的缓存命中率/占用率 |
| [`report.ts`](#2-会话离线分析-bench中reportts) | 运行时遥测 JSONL（+可选 session 文件） | 逐会话汇总 + 总体统计，看全局健康度 |

指标口径三套脚本一致：

- **上下文占用率** = 发往模型 token / 模型上下文窗口
- **压缩比** = （系统提示 + 全量原文）token / 发往模型 token
- **缓存命中率** = 相邻两轮投影请求的「相同前序 token」/ 本轮请求 token
  - **ACP 侧**：由投影请求序列计算（`acpCacheHit`）
  - **Provider 侧**：由模型返回 `tokenUsage.cacheRead / input` 计算（`analysis-params.ts` / `report.ts` 可选拼 session 文件取得）

---

## 1. 自带压测：`bench/compress-params.ts`

不使用真实模型，用合成历史 + 模拟「理性模型每轮顺从 ACP 建议压缩」逼近稳态，即可在部署前评估参数。

```bash
# 默认基线参数集 × 40k/100k/200k/300k/1m 五档窗口，30 步收敛
bun run bench/compress-params.ts

# 里程碑：换成 config.json 当前实际参数，并扫 preserveRecentTokens 敏感性
bun run bench/compress-params.ts \
    --lengths=40000,100000,200000,300000,1000000 --perTurn=4000 \
    --preserveRecentTokens=50000 --preserveRecentMessages=10 \
    --promotionThreshold=10 --tier2Trigger=5 --tier3Trigger=18 \
    --maxSummaryLength=10000 --minSummaryLength=1000 --minCompressRange=5000 \
    --maxPct=0.65 --minPct=0.35 --emergencyPct=0.80 \
    --sweepPreserve=0,2000,8000,20000,50000 \
    --sweepTier2=3,5,10,18 \
    --sweepMaxSummary=5000,10000,20000
```

参数：

| 参数 | 默认 | 说明 |
|------|------|------|
| `--lengths` | `40000,100000,200000,300000,1000000` | 上下文窗口长度列表（每项单独满载跑一轮） |
| `--perTurn` | 自动（窗口固定比例增量） | 每步追加的 fresh token；缺省按 `--steps` 让各窗口收敛到相近饱和占用率，保证横向可比 |
| `--steps` | `30` | 各窗口统一收敛步数 |
| `--preserveRecentTokens` 等 | 见脚本 `defaultParams` | 直接对应 `config.json compression.*` 的结构化参数 |
| `--sweepPreserve` / `--sweepTier2` / `--sweepMaxSummary` / `--sweepMinCompress` | — | 传逗号列表即开启对应参数的敏感性扫描 |

输出：Markdown 表（基线 + 各扫描维度），列含 `压缩比 / 保留率 / 占用率 / 缓存命中 / t1/t2/t3`。

> 真实「模型摘要」只需替换脚本内 `SUMMARY_PLACEHOLDER` 的质感（内核同源），其余逻辑不变。

---

## 2. 会话离线分析：`bench/report.ts`

读实际运行产生的**遥测 JSONL**，逐会话汇总 + 总体统计，看"这套参数在自己的真实会话里整体表现"。

```bash
# 仅读遥测（ACP 侧指标）
bun run bench/report.ts --glob='~/.harness/sessions/*.telemetry.jsonl'

# 再拼 session 文件，补 Provider 侧缓存命中（assistant.message.meta.tokenUsage）
bun run bench/report.ts \
    --glob='~/.harness/sessions/*.telemetry.jsonl' \
    --sessions='~/.harness/sessions/*.json'
```

参数：

| 参数 | 说明 |
|------|------|
| `--glob` | 必填。遥测 JSONL 通配，支持 `~` 与 `*`。 |
| `--sessions` | 可选。会话消息 JSON 通配，用于解析 Provider 侧 `cacheRead`。 |

输出：逐会话表（轮数/窗口/压缩比/占用率/ACP命中/Provider命中/t1t2t3）+ 按窗口分组的参数敏感性小表 + 全量 avg/p50/p95。

---

## 3. 参数组合离线分析：`bench/analysis-params.ts`

**回答"哪套参数在真实会话里缓存命中率、上下文占用率最好"**。所有会话的 preModel 事件都带当时的
`params` 快照，本脚本把全量事件按「参数组合签名 = params + window」归并，跨会话聚合同组合的所有轮次指标，
适合对比**线上切换参数前后**（或不同会话用了不同参数时）。

```bash
bun run bench/analysis-params.ts \
    --glob='~/.harness/sessions/*.telemetry.jsonl' \
    --sessions='~/.harness/sessions/*.json'      # 可选：补 Provider 侧缓存命中
```

参数：同 `report.ts`（`--glob` 必填，`--sessions` 可选）。

输出：

- 每窗口一张「组合 → 会话数/轮数/占用率/ACP命中/Provider命中/压缩比/保留率/t1t2t3」表
- 一张跨窗口的 **ACP 缓存命中率排行**（前 15 组合降序），直接挑最优参数

```text
### ACP 缓存命中率排行（跨窗口，按命中降序）
| 名次 | 组合 | ACP缓存命中 | 占用率 | 压缩比 |
| 1 | 窗口40000 pTok0 t23 t38 maxSum5000 minCR5000 | 93.0% | 38.0% | 8.00x |
| 2 | 窗口200000 pTok8000 t25 t310 maxSum10000 ... | 55.0% | 60.0% | 8.00x |
```

---

## 4. 数据从哪来：运行时遥测开关

三套脚本中 `analysis-params.ts` 与 `report.ts` 依赖运行时遥测 JSONL。默认开启（`compression.enabled: true` 即写入），
文件路径 `<dataDir>/sessions/{sessionId}.telemetry.jsonl`。

- **开启**（默认）：
  ```jsonc
  { "compression": { "enabled": true } }
  ```
- **关闭**（零开销）：
  ```jsonc
  { "compression": { "enabled": true, "telemetry": { "enabled": false } } }
  ```

每轮进入模型前写入一条 `preModel` 事件（含 `params` 快照 / `acpCacheHit` / `occupancy` / `compressRatio` /
t1t2t3 块数等）；模型主动调用 `compress` 工具时追加 `compress` 事件。

---

## 5. 推荐工作流

1. **部署前**：跑 `compress-params.ts`，用 `--sweep*` 找出对当前窗口最敏感的参数，收敛一个大致合理区间。
2. **线上**：让遥测跑一段时间（多个会话留够轮数，组合才有统计意义）。
3. **事后**：先 `report.ts` 看总体健康度（占用率是否失控、命中率是否过低）；再 `analysis-params.ts`
   对比不同参数组合（尤其调参前后），用排行确定下一轮参数。
4. 回 `config.json compression.*` 改参，回到第 1 步或第 2 步。

> 建议参数调整**单次只改一个旋钮**（配合 `--sweep` 思路），遥测的 `params` 快照才能干净归因。