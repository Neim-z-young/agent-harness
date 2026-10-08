# 上下文压缩·窗口保护闸（B3）与自动压缩合取条件（B2）

> 记录日期：2026-10-07。来源：会话 `s_1791373374635_9hqyb` 取证 + `acp-kernel` / `acp-context` / `core` 源码对账。
> 状态：**B2 / B3 均已实现并验证**（全量 2592 pass / 0 fail；反向验证 6 项，见 §7.1）。
> 本文承载语义与决策，参数细节以代码注释为准。

## 1. 问题：两条压缩管线，两把尺子，却只有一道闸

本仓有**两条互不相干的"省上下文"管线**：

| | ACP 模型侧压缩（`compress` 工具 / 内核折叠） | 会话压缩（`compactIfNeeded` / `/compact`） |
|---|---|---|
| 判据 | `requestTok / modelContextLimit`（**折叠后**；消费方，如窗口闸，另加固定前缀，见 §6.3 ①） | `estimateTokens(sess.messages)`（**原文口径**） |
| 对 `sess.messages` | **不删**（只记 block 引用） | **真删**（`sess.messages = kept`） |
| 原文可回溯 | 可以（`acp.archive.v1` / `.cmp.orig`） | 视归档链而定 |
| 触发点 | 每轮 `core.session.preModel` | **resume / start**、`/compact auto` |
| 守什么 | 语义上是"请求别超窗" | 实现上是"内存/磁盘别膨胀" |

**故障形态**：ACP 把 `requestTok` 压得很低，而 `rawTok` 继续单调增长 ⇒ 原文口径先撞线。
真机 `s_1791373374635_9hqyb`：原文口径 **79.6%**（阈值 85.5%）而真实请求只有 **31.5%** ——
即在模型端还很宽裕时就触发裁剪，且 `keepRecentMessages` 默认 **10** ⇒ 一次裁掉百余条。

**两把尺子本身没错**（各自守一个目标）。错的是：**"窗口保护"这件事被寄存在了那道按原文口径判的闸上**。
只要 ACP 启用（两把尺子分离），窗口保护就事实上缺位 —— ACP 关闭时反而没问题，因为那时两把尺子重合。

> 对称性（本设计的必要性证明）：**ACP 关闭 ⇒ `requestTok ≈ rawTok` ⇒ 原文口径的 autoCompact 恰好等价于窗口闸。**
> 若 B3 无意义，则 ACP 关闭时的行为会显得荒谬。

## 2. 现状盘点：窗口保护其实已经有三层，但都不可见

全在 `acp-kernel`（非本仓），且**都只作用于待发副本**（不改会话本体）：

| 档 | 配置键 | 本机值 | 动作 | 可见性 |
|---|---|---|---|---|
| `overLimit` | `nudge.maxContextLimitPct` | 0.65 | nudge 注入压缩建议 | 只有模型 |
| `emergencyOverride` | `nudge.emergencyThresholdPct` | 0.8 | 同上，文案换 `EMERGENCY` | 只有模型 |
| `truncate` | `config.truncate.threshold` | 0.95 | **静默取头尾切中段**（`truncateLargeToolOutputs`，节点 `emergency-truncate`） | 谁都不知道 |

内核默认 0.75 / 0.95 / 0.95，由 `auto-tune` 覆盖为 0.65 / 0.8。校验约束：
`minContextLimitPct ≤ maxContextLimitPct ≤ emergencyThresholdPct`。

**盘点中发现的既有问题（本文顺带记录，不在本次改动范围）**：

- `telemetry.emergencyCompressed` 是**死字段**：内核从未设置过它（内核里根本没有折叠节点），
  故所有轮次恒为 `false`；`telemetry.ts` 的注释"processTurn 是否内部紧急折叠"与实现不符。
- **内核的压力判据用的是"折叠前"的量**：`ctx.tokenCount = input.tokenCount`（未过滤的全量 core），
  而插件上报的 `occupancy` 用的是 `res.messages`（过滤/折叠后）。两者**不同源**，阈值含义因此不同。
  ⇒ **B3 必须建在插件那份"折叠后"口径上**（这才是"真实上下文占用率"）。

## 3. B2：给自动压缩加**合取条件**（不换口径）

**语义**：原文口径超线 **且** 真实请求也接近窗口时，才裁。缺任一条不裁。

```
estimated = estimateTokens(sess.messages)                    // 条件一（现状）
occ       = session.meta['acp.occupancy.v1']                 // 条件二的数据源（B3 之外的既有键，见 §5）
裁 ⟺ estimated >= (W - reserved) × autoCompactThresholdPct%  &&
     ( occ 不存在 || occ.requestTok >= W × requestPressurePct )
```

**关键设计点：`occ` 不存在时第二条件视为成立** ⇒ **ACP 关闭时行为与改造前逐位一致**。
这正是 §1 那条对称性的直接落实：没有 ACP 就没有独立的窗口闸，此时原文口径必须继续兼任。

**不做**：不换口径（那是把内存回收闸整个删掉）；不改 `keepRecentMessages`（另行评估）。

## 4. B3：窗口保护闸（新增）

**落点**：`acp-context` 的 `core.session.preModel` —— 它**已经**在同一行算过 `occupancy`，
复用即零成本、零第二口径。**不放 core**：core 拿不到"折叠后"的量，放过去必然重算一遍。

**四档（逐级升级，配置驱动）**：

| 档 | 配置键 | 拟默认 | 动作 | 破坏性 |
|---|---|---|---|---|
| `notify` | `windowGuard.notifyPct` | 0.75 | 宿主可见告警一行（不改请求） | 无 |
| `forceCompress` | `windowGuard.forceCompressPct` | 0.90 | **复用内核能力折一次**（见 §5） | 非破坏（有归档） |
| `fallback` | 内核 `config.truncate.threshold` | 0.95 | 保留既有静默截断 | 有损（仅本轮副本） |
| `refuse` | `windowGuard.onExceedPct` + `onExceed: 'refuse'` | 关闭 | 从 `preModel` 抛错中止本轮 | 不发起请求 |

**排序是本设计的核心**：**非破坏的 `forceCompress` 必须排在破坏性的 `truncate` 之前**。
现状的问题不是"没有兜底"，而是"兜底的形态选错了" —— 到 95% 直接切工具输出，
而"再折一次"这条更干净的路径没有被尝试的机会。

**`refuse` 的可行性**（已核实，非纸面）：`core/src/index.ts:2837` 的
`triggerPlugin('core.session.preModel', …)` **无 try/catch**，插件抛错会上抛并中止本轮；
`:3224` 的注释亦把"preModel 插件异常"列为已知错误路径。
⇒ 错误文案**必须自带出路**（如"请先 `/compact`，或把 `windowGuard.onExceed` 设为 `truncate`"），
否则只是把"静默损坏"换成"静默报错"。

## 5. 机制决定：复用**内核**的压缩，不复用插件的压缩

**内核不自己折叠**（已核实：`processTurn` 的节点链里没有任何产块节点，
`buildNodes()` = assignRefs → syncBlocks → prune → absorbHide → absorbPrompt → filter →
hideCompressCalls → recommend → nudge → emergencyTruncate）。折叠的唯一入口是内核导出的：

```ts
engine.applyCompression({ ranges: [{ startRef, endRef, summary, topic }], messages, state, config })
```

因此：

- **折哪些**：取内核自己算好的 `nudge.compressibleRanges`（= `recommendNode` 的
  `mergeRangesToThreshold(compressible, minCompressRange)`，即 telemetry 的 `suggestedRanges`）。
  **不自己划范围** —— 那正是"内核已经做的事"。
- **怎么折**：调内核 `applyCompression`。**不调插件的 `runCompacting`** ——
  它是**为会话压缩服务**的（响应 `core.session.compacting`，输入是 core 给的待删窗口，语义是"配合别人删"），
  与窗口闸"我自己觉得该压了"的目标不同。（注：`runCompacting` 内部也调 `applyCompression`，
  所以两者在**折叠动作**上本就同源；分道的是**触发与选段**，不是折叠实现。）
- **摘要文本**：`applyCompression` 要求调用方给 `summary`，内核不生成摘要。自动档下只能给规则摘要 ——
  复用既有 `ruleSummary` 纯函数（头尾拼接），**不新增第二份摘要实现**。

**执行顺序（在 `runPreModel` 内）**：

```
1. res1 = engine.processTurn(...)              // 现状
2. 遥测 preModel（记录 res1 的占用 —— 即"闸门看到前的压力"）
3. 若 occupancy(res1) >= forceCompressPct：
     ranges = res1.nudge.compressibleRanges
     applied = engine.applyCompression({ ranges: withRuleSummary(ranges), messages: res1.messages,
                                         state: res1.state, config })
     res2 = engine.processTurn({ state: applied.state, ... })   // 用新 state 重建本轮请求
4. 下游（occupancy / prefixText / 渲染 / 归档持久化）一律用最终那份 res
```

只有真正触发的那一轮会跑两次 `processTurn`（罕见），其余轮零开销。

## 6. 配置形态

会话压缩侧（B2 的合取条件写在这里，不在 `compression` 段）：

```jsonc
{
  "compaction": {
    "autoCompactThresholdPct": 95,
    "requestPressurePct": 0.75        // ← B2 新增；省略 = 老行为（不做第二条件）
  }
}
```

ACP 侧（`compression` 顶层；下面这段是**受检示例** —— `cli.test.ts` 有一条常驻用例扫
`docs/*.md` 的 `jsonc` 片段跑 `checkCompressionConfig`，改白名单却漏改示例会立刻红）：

```jsonc
{
  "nudge": { "maxContextLimitPct": 0.65, "minContextLimitPct": 0.35, "emergencyThresholdPct": 0.8 },
  "config": { "truncate": { "threshold": 0.95 } },
  "windowGuard": {
    "enabled": true,
    "notifyPct": 0.75,
    "forceCompressPct": 0.90,
    "onExceedPct": 0.98,
    "onExceed": "truncate",
    "includeFixedOverhead": true
  }
}
```

`onExceed` 的两个取值：`"truncate"`（默认，交还内核静默截断）| `"refuse"`（中止本轮不发请求）。
`includeFixedOverhead` 缺省 `true`：判据与读数都计入固定前缀（见 §6.3），`false` 即回到只算消息体的老口径。

两点刻意的决定：

1. **`windowGuard` 不进 `autoTune`**：autoTune 按窗口推导 nudge/compress 参数，但**硬闸不该被自动调**
   —— 自动调会把安全线的含义弄模糊。
2. **不是作用域档位**（没有 `subagent` / `perAgent` 那一层）：三档阈值都是**占用率**，已随各档位
   自己的 `modelContextLimit` 自动缩放；再分化只会多一处口径来源。

### 6.1 ⚠️ 默认开启**不是**"行为不变"（实现阶段纠正）

设计初稿曾写「默认 `onExceed: "truncate"` ⇒ 保持既有行为不变」。**这条是错的**，实装时被测试抓到：

- 内核既有兜底只在 `truncate.threshold`（0.95）动手，且形态是**静默截断**；
- 本闸的 `forceCompressPct`（0.90）会在 0.90~0.95 这段**新增一次折叠** —— 那就是行为变化。

实证：`acp-context` 既有用例「能力判据：白名单里没有 compress ⇒ 提示全部不注入」用
`modelContextLimit: 2000` + `history(100)`，注释估的占用率是 0.8，**实测约 0.925**
（注释漏算了 `renderTags` 注入的 `<acp mNNNNN>` 标签）—— 越过了 0.90 折叠线，
于是出站历史被折成 1 条摘要，该用例"历史原样"的断言变红。已在该用例里显式
`windowGuard: { enabled: false }`（各测各的：它考察的是**提示通道**，窗口闸是另一条独立机制）。

**保留默认开启**（保护要真的在位），但把回退路径写清：`compression.windowGuard.enabled: false`
逐位恢复改造前行为。真实影响面**窄**：只有真实占用率 ≥90% 的会话才会被动手
（取证会话 `s_1791373374635_9hqyb` 峰值仅 47.5%，一次都不会触发）。

### 6.2 实装落点（与初稿的差异）

| 件 | 落点 |
|---|---|
| 纯决策 / 归一化 / 文案 / 错误类 | 新文件 `packages/plugins/acp-context/src/window-guard.ts`（不依赖内核、不依赖 `./index.js`，避免循环导入） |
| 折叠动作 | `index.ts` 的 `foldForWindowGuard` —— **复用**内核 `nudge.compressibleRanges` + `engine.applyCompression`；摘要复用既有 `defaultRuleSummary` |
| 闸门插入点 | `runPreModel` 内、`processTurn` 返回后**立即**（写遥测/持久化/渲染**之前**）—— 保证下游只有一份 `res` |
| `refuse` 的上抛 | 必须由 `core.session.preModel` hook 特判放行，否则被"压缩是旁路优化"的兜底吞掉 |
| 配置面 | `packages/host/src/config.ts`（类型 + 白名单 + 校验）+ `host.ts` 装配行透传 |

**一处刻意的口径判断**：闸门放在遥测之前 ⇒ 触发折叠的那一轮，`preModel` 遥测记录的是
**折叠后**的请求（而非"闸门看到前的压力"）。取"一份 res 贯穿下游"而不是"两个口径各记一份"
—— 后者正是本仓反复出事的那种分裂。折叠动作本身由 `notify` 日志留痕。

### 6.3 真机跑通后订正的三处（都有实证，不是推演）

首次真机跑四档（`forceCompressPct` 调到 0.3 一类）暴露出三个只有真机才显现的问题，全部已修：

| # | 问题 | 实证 | 修法 |
|---|---|---|---|
| ① | **判据漏算固定前缀**。原 `occupancy = estimateTokens(res.messages) / window` 只算消息体 | 空会话实测 `requestTok 19`（0.0063%）而同一轮真实请求 `in 10,734`（3.2%）—— 差 500 倍；`cacheRead 9,600` 正是 system prompt + 32 个工具 schema 那个跨会话复用前缀。后果：四档**全部偏晚触发**，30 万窗口偏 3.2%，3.2 万窗口偏 **30 个百分点**（notify 0.75 触发时真实请求已超窗） | 新增**实测探针** `AcpSessionCtx.fixedPrefix`：每步读引擎累计 `usageStats.inputTokens`，与上一次读数相减 = 上一步真实发出的 input tokens，再减去 ACP 当时估算的消息体，差值即固定前缀（**实测而非写死配置**，自动跟随任何模型 / 工具集）。判据改为 `(body + fixed) / window`。开关 `includeFixedOverhead`（默认 true）。三条 fail-soft：读不到 ⇒ 保持上次值；读数没前进 ⇒ 保持（不把 0 增量当实测）；差值为负（中文估算偏大）⇒ clamp 0（退回老口径，偏差只许往保守走） |
| ② | **`foldSkipped` 把三种成因压成一句**"没有够格的可折叠内容" —— 对"没有可压原文"是误导 | 副本实测 `suggestedRanges: 1`（内核**确实推荐了**）但整批不够 `minCompressRange`（200,000 chars）⇒ `blocksCreated 0`。即 MEMORY 记的「先大后小把门关上」会原样传导：**越是需要窗口保护的会话越折不动** | `foldForWindowGuard` 返回判别式 `{ok:false, reason}`（`no-ranges` / `no-summary` / `below-threshold`），文案分三种措辞，并补**出路**（`/compact`、`decompress`、调大 `modelContextLimit`） |
| ③ | **`folded` 分支文案两处数字错位** | 实测打印「占用 60.0% → 已强制折叠 … 折叠前 12.0%」，但 60.0% 是 `forceCompressPct`（阈值）、12.0% 是**折叠后**重算值 —— **自证矛盾**（12% 触发不了 60% 的线） | 调用点折前存档 `occupancyBefore`，文案改为「占用 <触发时> 已达强制折叠线 <阈值> → 已强制折叠（…）· 折叠后 <重算值>」 |

**① 的一个副产**：闸门判据从此含固定前缀，而**遥测行仍是纯消息体口径**（有意保留）——
遥测 `occupancy` 是"发往模型的历史 cores 体量"，用于压缩效果归因；闸门判的是"窗口还剩多少"，
固定前缀当然要算。两者差一个固定前缀（真机约 9,600），排查"手册怎么早/晚出现了"时先认这一条。
统计面板则**与判据同源**：前半段仍是消息体口径（既有断言钉的就是它），有固定前缀时**追加**一段
`· 含固定前缀 N（system + 工具 schema） ⇒ 合计 M（P%）`，把判据数显式写出来，
避免读者拿消息体去核闸门告警、误以为"闸门凭空多算了占用"；`includeFixedOverhead: false` 时
这一段一并消失（面板与判据同开关，不留第三种口径）。


## 7. 验收

| # | 项 | 状态 |
|---|---|---|
| 1 | 单测：占用率 × 阈值 → 期望档（0.74 静默 / 0.75 notify / 0.90 forceCompress / 0.98 refuse）+ 边界 + 非单调配置 + 非法占用率 | ✅ `window-guard.test.ts` 13 例 |
| 2 | 单测：B2 的三种输入（无键=老行为 / 键在且宽裕=不裁 / 键在且紧张=裁） | ✅ `core.test.ts` 5 例 |
| 3 | **反向验证**：逐条确认闸门按配置走、不是常量写死 | ✅ 见下表 |
| 4 | 回归：既有用例不因新闸漂移（唯一受影响者已显式关闸并注明原因） | ✅ 全量 **2604 pass / 0 fail** |
| 5 | 真机：把 `forceCompressPct` 临时调低跑一轮 ⇒ 告警 + 折叠块；`decompress` 可回溯；`sess.messages` 未被删 | ✅ 已做（`/tmp/harness-wg-test` 隔离 dataDir，原件 `shasum` 未变）。折叠档实测：`占用 84.9% 已达强制折叠线 5.0% → 已强制折叠（折 3 段 / 回收约 203,758 tokens；原文可用 decompress 还原）· 折叠后 11.9% · 窗口 300,000 · 实际发出 35,703（11.9%）`；折不动档实测：`…但本会话已没有未压缩的原文可折（历史都已在折叠块里） ⇒ 本轮未折叠…` + 三条出路整行送达。`sess.messages` 未被删是 ACP 的既有性质（compress 只在 `core.prompt.preModel` 改待发副本） |

### 7.1 反向验证（每次改一处 ⇒ 只该有预期的那几条变红）

| 变异 | 预期变红 | 实测 |
|---|---|---|
| `decideWindowGuardAction` 的 `onExceed==='refuse'` 改成 `'truncate'` | refuse 2 例 + 决策 2 例 | ✅ 4 条（另 4 条为同一函数的连带影响） |
| `foldForWindowGuard` 恒返回 `undefined` | forceCompress 2 例 | ✅ 恰 2 条 |
| `resolveWindowGuard` 去掉归一化 | 非法阈值回落 1 例 | ✅ 恰 1 条 |
| 宿主 `checkWindowGuard` 去掉单调性检查 | 三档反序告警 1 例 | ✅ 恰 1 条 |
| hook 去掉 `WindowGuardExceededError` 上抛 | refuse 上抛 1 例 | ✅ 恰 1 条（"其余异常仍被吞"那条**保持绿** ⇒ 证明特判是精确的） |
| 装配行去掉 `windowGuard: compression.windowGuard` | 装配行守卫 1 例 | ✅ 恰 1 条 |

补档（§6.3 三处订正各自的反向验证）：

| 变异 | 预期变红 | 实测 |
|---|---|---|
| 折叠文案退回"只留一个变量"（丢掉触发时占用率 + 折叠后） | folded 集成例 1 条 | ✅ 恰 1 条 |
| `foldForWindowGuard` 把 `below-threshold` 混成 `no-ranges` | 门槛档 1 条 | ✅ 恰 1 条 |
| `includeFixedOverhead` 门控失效（无视开关总计入） | 开关档 1 条 | ✅ 恰 1 条 |
| 探针不减自身估算（`cumulative − prev.cumulative`） | 探针 / 开关 / fail-soft 3 条 | ✅ 恰 3 条 |
| `describeFoldSkip` 把三种成因压成一句 | 成因区分 1 条 | ✅ 恰 1 条 |
| `usagePart` 忽略 `fixed` | 通知 1 条 + 拒绝 1 条 | ✅ 恰 2 条 |
| 面板不追加固定前缀段 | 面板固定前缀 1 条 | ✅ 恰 1 条 |

变异全部还原后 `shasum -a 256` 与基线**逐字相等**（7/7）。

## 8. 开放问题

- **判据口径已修**（§6.3 ①）：闸门判据含固定前缀，而遥测行 / 面板那行仍是**消息体口径**（有意，
  两个数各守一件事）。若将来想统一展示，建议给面板加"合计"一列，而**不是**把判据改回消息体。
- 探针依赖 `usageStats.inputTokens` 的**累计性**。多子会话共用同一 `meta` 时是否会被别的写入者扰动？
  当前纪律是"读不到 / 没前进 / 差值为负都不改"，即失败方向保守；需要时再观察。
- `foldSkipped` 真机上最常见的成因是 `no-ranges`（"等下去也不会好"）。当前只打印出路，
  是否要在这一档**主动**建议或直接触发 `/compact`？涉及"窗口闸要不要动内存"，先不越界。
- `forceCompress` 的规则摘要文本：头尾拼接在下游（工具输出为主）的会话里信息量有限。
  是否值得在将来的"agent 策略"里改为 LLM 摘要？留待观察。
- `refuse` 档的错误文案措辞（已给出四条可执行出路，真机上是否够用待观察）。
- 内核 `emergencyCompressed` 死字段与 `truncate` 口径（折叠前）—— 是否要在 upstream 修，另行评估。
- **闸门放在遥测之前**带来的语义变化（遥测记折叠后的请求）。若将来要同时保留"闸门看到的压力"，
  建议加独立遥测字段而不是把 `res` 变成两份。
