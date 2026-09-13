# 会话上下文压缩改造方案（全内存视图 / 惰性加载）

> 目标：把"会话消息全量驻留内存 + 每轮请求全量投影"改为
> **内存只驻留「压缩摘要块 + 新消息」，全文盘上原样保留、按需惰性加载**，
> 同时保持两条压缩管线（session 原生 Compaction / ACP 插件）可协同、可插拔。

- 关联插件：`@harness/acp-context`
- 讨论对齐的版本：**V5 定稿**（在标记消息、归档文件、懒加载讨论基础上收敛）
- 状态：阶段一→三已实施（持久层 / 视图骨架 / session.compacting 接线），阶段二后续走 Route B 彻底改造已落地（开发日志续 109）；**统一块模型整合已落地**：ACP 折叠经 `blocksPatch` 并入 `session.blocks`（`source: 'generic'|'acp'`）、`revert` 经全文回溯只回退最近消息（开发日志续 110、`.trae/documents/上下文压缩-统一块模型.md`）；阶段四待做

---

## 1. 背景与现状（基于代码勘察）

| 项 | 现状 | 落点 |
|----|------|------|
| 内存模型 | `Session.messages: Message[]` 整块驻留内存 | `packages/session/src/index.ts#L161-L188` |
| 持久化 | `dataDir/sessions/{sessionId}.json` 全量序列化 messages | `packages/workspace/src/storage.ts#L24-L79` |
| 请求组装 | `query` 直接拼接 `session2.messages` 后触发 `session.preModel` | `packages/core/src/index.ts#L1242-L1294` |
| 进入会话 | `resume` 通过 `sessionStore.load(sid)` 全量加载并逐条回填 | `packages/cli/src/index.ts#L1367-L1383` |
| ACP 投影 | 经 `session.preModel` 读原始消息、`processTurn`、写 `meta.acp.v1` | `packages/plugins/acp-context/src/index.ts#L375-L478` |

现有问题：
1. **内存随会话线性膨胀**：超长会话把全部消息留在内存，即使长期用不到。
2. **请求全量投影**：`query` 拼 `sess.messages`，历史越长输入 token 越大（依赖 ACP 每轮瘦身，但 ACP 停用时完全裸跑）。
3. **两管线时序冲突**：进入会话时 `compactIfNeeded` 可能先删旧文，破坏 ACP 保的全文可回溯；且 `compact()` 从未触发已声明的 `session.compacting` hook（核心路径未接线）。
4. **前端一次性渲染**：历史 messages 作为内存数组被 TUI/Web 直接渲染，无按需加载接缝。

---

## 2. 目标

- **内存**：超长会话内存只驻留「摘要块 + 近期消息」，其余原文在盘。
- **请求 token**：模型请求的来源是"精简视图"（非全量原文），天然瘦身，不与 ACP 依赖强耦合。
- **可追溯**：不破坏历史——原文原样保留，可按需还原《全文》。
- **前端**：历史浏览时机再加载，支持虚拟滚动/分页。
- **协同与插拔**：session 压缩与 ACP 可同时生效、可各自独立启停。

---

## 3. 总体架构（三层视图）

```
┌──────────────── 渲染层（前端，按需） ────────────────┐
│  TUI / Web：浏览历史时经 loader 分页读取全文        │
└────────────────────────┬────────────────────────────┘
                         │ flushHistory(range)
┌────────────────────────▼────────────────────────────┐
│  内存视图（?压缩块 + 新消息?）  ← 请求模型输入的来源  │
│   blocks(摘要) + recent(messages)                   │
└────────────────────────┬────────────────────────────┘
                         │ 落盘双写 + 断点索引
┌────────────────────────▼────────────────────────────┐
│  持久层：原文消息(不动) + 会话压缩消息文件(摘要块)   │
│          + 断点索引(块→原文 id 段)                  │
└─────────────────────────────────────────────────────┘
```

- **内存视图**：把 `Session` 的 `messages` 拆成 `blocks`（已压缩摘要块，可来自 session 压缩或 ACP）+ `messages`（尚未压缩的近期英文园）。
- **请求瘦身收归 session 层**：`query` 的 `finalMessages` 改从「内存视图」组装，ACP 退为可选增强（智能摘要/检索），而非唯一瘦身者。→ 兼容 ACP 启停。
- **全文永不删**：原文在盘原样保留；`decompress` / 前端翻历史均通过 loader 按断点索引回读。

---

## 4. 关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 请求瘦身收归 **session 视图**，不依赖 ACP | ACP 启停对 token/内存影响最小 |
| D2 | 压缩块是历史里的**稳定节点**（持久、固定 ref），非临时标记 | ACP 增量路径前缀稳定，命中率高 |
| D3 | 摘要增量写入「会话压缩消息文件」，全文另存原文容器 | 文件固定大小、覆盖式；可追溯由原文容器兜底 |
| D4 | 断点索引 `(blockId → 原文 id 段)` 复用 ACP 的 `messageRefs/blocks` | 少造新机制，`decompress/search` 只差查盘 |
| D5 | `session.compacting` hook 接线、扩展 input | 给 ACP"删除前先保全原文"的窗口，解决时序冲突 |
| D6 | 前端懒加载经统一 loader，不直接 map 全量 messages | 渲染层与内存结构解耦，支持分页 |

---

## 5. 开发阶段划分（按依赖序，每阶段可独立验证/回退）

### 阶段一：双写落盘 + 断点索引（地基）
**目标**：确立"原文不动 + 摘要文件覆盖 + 可从块定位原文段"的持久层。

改动：
- `packages/workspace/src/storage.ts`：新增会话压缩消息文件（如 `dataDir/sessions/{id}.cmp.json`），支持覆盖式写摘要块。
- 持久层新增**断点索引**：`blockId → { file, startId, endId }`，随压缩块落盘。
- 会话 meta 增加版本标记，标注"已启用压缩文件"。
- 保留现有 `messages` 全量序列化（阶段一不拆内存，只加旁路索引）。

验收：
- 压缩一次后生成 `.cmp.json`；断点索引能从摘要块定位回原文 id 段。
- 原有会话加载/保存行为不变（回归测试通过）。

### 阶段二：内存视图 + 惰性加载（切核心结构）
**目标**：`Session` 内存不再全量持有历史（或全量体量下调），请求来源切到精简视图。

改动：
- `packages/session/src/index.ts#L161-L188`：拆分 `Session` 模型——`blocks[]`（摘要）+ `messages[]`（近期），并暴露 `view()`（组装待发请求的精简消息）。
- `packages/session/src/index.ts#L257-L335`：`SessionManager` 增加视图/懒加载方法（`flushHistory(range)` 调盘读全文）。
- `packages/core/src/index.ts#L1242-L1294`：`query` 的 `finalMessages` 改从 `view()` 取；新增惰性加载器负责按需还原全文供 `/compact` 统计、revert 等消费方。
- `packages/cli/src/index.ts#L1367-L1383`：`resume` 改为加载「摘要块 + 近期消息」，不再逐条回填全量原文（原文盘上不动）。

验收：
- 长会话内存占用下降（进程 RSS 对比）。
- `query` 输入消息条数 ≈ 摘要块+近期，请求 token 下降。
- 统计/还原功能（`/compact` info、revert）经 loader 工作正常。
- **此阶段不依赖 ACP**，禁用 ACP 全量通过。

### 阶段三：session.compacting 接线 + ACP 协同（解决时序冲突）
**目标**：两管线能在同一会话协同，且删除前 ACP 可先保全原文。

改动：
- `packages/plugin/src/index.ts`：扩展 `CompactionContext`（加入 `sessionId` 及可读历史窗口引用的入口）。
- `packages/core/src/index.ts`：`compact()` / `compactIfNeeded()` 触发 `session.compacting` hook；`keepLast/strategy/summary` 允许插件改写。
- `packages/plugins/acp-context`：注册 `session.compacting` hook——删除前把待压缩窗口**先行折叠进自己的块/摘要文件**，或将 strategy 置为"已由 ACP 处理"以豁免物理删除；幂等（复用 `state` 的 already-compressed 判定）。
- 摘要读取：`decompress` / `search_context` 改走断点索引回读原文容器。

验收：
- 先 ACP 后 session 顺序下，全文可回溯不丢；反之亦然。
- ACP 启用/禁用/重载后，session 压缩行为正确回退到默认 `ruleBasedSummary`。

### 阶段四：前端按需渲染
**目标**：TUI/Web 历史浏览不再一次性渲染全量。

改动：
- CLI 渲染层：历史列表改为经 loader 分页/虚拟滚动读取；按"已压缩块"显示提示行（不渲染块内容）。
- 语义保留：全量搜索、消息计数等功能经 loader 透传。

验收：
- 超长会话 TUI 打开流畅、滚动按需加载。
- 已压缩段显示为提示标记，点击可展开全文（走 loader）。

---

## 6. 与 ACP 启停的兼容性总表

| 能力 | 归属层 | ACP 禁用后 |
|------|--------|-----------|
| 内存瘦身 | session 视图（阶段二） | 保留 |
| 请求 token 瘦身 | session 视图（阶段二 D1） | 保留（瘦身力度略降，无 ACP 智能摘要） |
| 摘要落盘 | session 压缩文件（阶段一） | 保留（`ruleBasedSummary`） |
| 前端懒加载 | 渲染层（阶段四） | 保留 |
| `decompress` 全文还原 | ACP 专属 | 不支持（原文在盘可手工取） |
| `search_context` 检索 | ACP 专属 | 不支持 |
| 分层蒸馏 / nudge | ACP 专属 | 不支持（请求仍靠视图瘦身） |

ACP 对本方案属**可选增强层**，启停不伤地基。

---

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 拆 `Session.messages` 影响面大（query/CLI/revert/TUI 均依赖全量数组） | 阶段二单独上，给精简视图与 legacy 全量访问并存一个兼容期 |
| 断点索引与原文 id 在重启后漂移 | 断点索引随压缩块落盘，原文 id 稳定（ACP `refs survive restarts` 已证） |
| 懒加载异步化波及渲染层同步逻辑 | 阶段四最后做，loader 提供同步容量版本兜底 |
| 双写文件一致性命中 | 阶段一明确 `cmp.json` 写序与崩溃恢复（先写临时再 rename） |
| 与既有 `compactMemory` 逻辑重复 | 阶段三把 `appendCompactionMemory` 与视图协作，避免双份摘要 |

---

## 8. 实施顺序建议

按 **阶段一 → 阶段二 → 阶段三 → 阶段四** 逐一实施，每阶段结束：
1. 该包 `typecheck` + 单测通过；
2. 更新 `docs/development-log.md`（续 N）；
3. git 提交。

额外建议：阶段二与阶段三存在被 ACP 强耦合的风险，**默认收口点是把请求瘦身划归 session 视图（D1）**，让 ACP 始终是"增强"而非"必需"。