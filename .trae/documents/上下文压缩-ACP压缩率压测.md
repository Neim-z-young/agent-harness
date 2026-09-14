# 上下文压缩 · ACP 压缩率压测方案（可复用）

> 目标：量化「模型使用 ACP」在不同上下文窗口长度（40k / 100k / 200k / 300k / 1m token）下的**输入瘦身压缩率**，并沉淀为可重复手动运行的 bench。
> 关联：`docs/context-compression-plan.md`、`.trae/documents/上下文压缩-统一块模型.md`、`packages/plugins/acp-context/bench/ratio.ts`
> 结论速览：全压档压缩比 40k→1m 从 **24x→86x**（保留率 4.1%→1.2%）；保留近期 8k 档 4x→51x。

---

## 1. 关键背景（决定口径的两个事实）

代码勘察确认两条决定性事实（否则压测口径会错）：

1. **ACP 的折叠主要靠模型驱动**：`engine.processTurn`（[acp-kernel processTurn](file:///Users/oyoungy/Documents/project/XiaoZhi-new/node_modules/acp-kernel/dist/index.js#L2180)）只做 ref 指派、裁剪/过滤、产出**压缩建议（nudge）**，并渲染发往模型的调用链。真正的折叠发生在模型调用 `compress` 工具 → `applyCompression`。`emergencyTruncateNode` 只截断超大工具输出，不折叠普通文本。→ **没有模型就没有智能折叠**，无法用纯 `runPreModel` 单轮测出压缩率。

2. **token 估算口径 = chars/4**：`estimateTokens`（[adapter.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/acp-context/src/adapter.ts#L213-L218)）按 4 字符≈1 token 启发式，与 acp-kernel 默认 tokenizer 一致。压缩率用同一估算器度量，内部自洽。

## 2. 压缩率口径

对一个「上下文窗口 = L」的模型，当其使用窗口被 ACP 压缩后的稳态：

```
baseTok   = 系统提示 + 全量历史的 token          （无 ACP 时的模型输入）
requTok   = 系统提示 + ACP 折叠后投影的 token     （有 ACP 时真正发往模型的输入）
保留率     = requTok / baseTok（越小越省）
压缩比     = baseTok / requTok（如 24x 表示输入缩小到 1/24）
```

- 系统提示加入两侧，保证公平（固定开销在小窗口占比高）。
- 「压缩率」在文档中同时报告保留率与压缩比，避免口径歧义。

## 3. 模拟方法（理性模型近似）

无真实模型的前提下，用「**理性模型循环**」逼近模型主动压缩的稳态——等价于模型每次都顺从 ACP 的建议压缩：

```
起始  messages = 全量合成历史（目标窗口长度 L 的 token）
循环：
  res = processTurn({ messages, state, config(window=L), tokenCount, renderTags:'text-only' })
  requTok = 系统提示 + estimateTokens(res.messages)
  ranges  = res.nudge.compressibleRanges          # ACP 本轮建议的可压范围
  if ranges 为空: 收敛退出
  applied = applyCompression({ ranges, messages, state, config })   # 模型压缩动作
  state = applied.state; messages = res.messages; 累计 blocks/被压token
```

- **窗口口径**：`config.modelContextLimit = L`（即"上下文窗口=该长度"），历史填满窗口 → 立即触发压缩，测得该长度窗口满载时 ACP 的"牌面压缩率"。
- **合成历史**：按 L×4 字符拆成等长消息（每条 400/800/1600 token 可选，`--perMsg`），便于 kernel 分层折叠。
- **摘要占位**：`applyCompression` 需要模型写摘要。真实模型摘要内容不等，故用固定中等长度占位（≈50 token/块，`SUMMARY_PLACEHOLDER`）。折叠后保留量 = 保留近期 token + 各块摘要 token，占位长度影响整个压缩率数量级的很小（块数 × ~50 token）。
- **配置**：`compress.maxSummaryLength=25000`、`minCompressRange=0`、`preserveRecentTokens=keep`（0=全压 / 8000=保留近期）、`promotionThreshold=1e9`（禁提升，只看折叠）；nudge 用默认策略。

## 4. 运行方式

```bash
cd packages/plugins/acp-context
bun run bench:acp-ratio                                                    # 五档长度 × 两档保留
bun run bench:acp-ratio --lengths=40000,1000000 --keep=0 --perMsg=1000    # 自定义
# 参数：--lengths（逗号分隔 token）/ --keep（逗号分隔保留近期 token，0=全压）
#       --perMsg（合成单条消息 token，越大核心越少越快）
```

## 5. 首压结果（2026-09-14）

### 档位 A：全压（preserveRecentTokens = 0）

| 上下文窗口 | 原文 token | 请求 token | 保留率 | 压缩比 | 折叠块数 |
|--|--|--|--|--|--|
| 40k   | 40016   | 1656   | 4.14% | 24.16x | 13 |
| 100k  | 100016  | 2867   | 2.87% | 34.89x | 32 |
| 200k  | 200016  | 4843   | 2.42% | 41.30x | 63 |
| 300k  | 300016  | 6820   | 2.27% | 43.99x | 94 |
| 1m    | 1000016 | 11636  | 1.16% | 85.94x | 157 |

### 档位 B：保留近期 8k（preserveRecentTokens = 8000，贴近真实使用）

| 上下文窗口 | 原文 token | 请求 token | 保留率 | 压缩比 | 折叠块数 |
|--|--|--|--|--|--|
| 40k   | 40016   | 9572   | 23.92% | 4.18x  | 10 |
| 100k  | 100016  | 10783  | 10.78% | 9.28x  | 29 |
| 200k  | 200016  | 12760  | 6.38%  | 15.68x | 60 |
| 300k  | 300016  | 14800  | 4.93%  | 20.27x | 92 |
| 1m    | 1000016 | 19564  | 1.96%  | 51.12x | 155 |

### 解读

- **全压档**：压缩比随上下文长度**亚线性增长**（24x→86x），保留率收敛到 ~1-4%。块数也随长度增长（13→157），因 3 层 LSM 分层聚合把大窗口折叠得更彻底。
- **保留 8k 档**：固定保留近期使小窗口（40k）压缩比仅 4x（保留占比高）；随窗口增大，8k 占比稀释 → 1m 达 51x。这更接近真实"保留近期对话"的使用。
- **固定开销影响**：系统提示 + 各块摘要占位是 request 的下限；上下文越大，这部分占比越小，压缩比越高。

## 6. 局限与后续

- **摘要为占位**：真实模型逐块摘要更长（受 `maxSummaryLength=25000` 封顶）。当前 ≈50 token/块对小窗口偏乐观、对 1m 影响极小。可替换为 `defaultRuleSummary` 或接入真实模型验证。
- **一次性满载 vs 多轮渐进**：本测把窗口一次填满再收敛，得到的是"该窗口最高可达压缩率"；真实使用按轮渐进，长期稳态数字会略低于此（因逐轮折叠不追求即时最紧）。
- **tokenizer 为 chars/4**：中英混排/CJK 下真实 token 偏高；若接入真实 tokenizer，压缩比会下降（本测压缩比是字符启发式的上界）。
- 真实模型验证：把 `SUMMARY_PLACEHOLDER` 换成模型摘要输出、或走完整 harness 注入 provider 复跑。

## 7. 后续项映射

本测覆盖「模型使用 ACP」的输入压缩比。与此前的统一块模型（遗留项 2/3/4）正交：这里验证的是 ACP 的**载荷瘦身能力**，块模型验证的是**折叠块的统一性/可回溯**。