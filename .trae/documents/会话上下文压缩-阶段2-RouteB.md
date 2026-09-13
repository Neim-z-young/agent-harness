# 会话上下文压缩 · 阶段2后续（Route B 彻底改造）

> 目标：`Session` 内存只驻留「压缩摘要块 blocks + 近期消息」，被压缩窗口的**原文落盘到独立档案**、按需经 loader 还原，实现内存瘦身 + 请求 token 瘦身 + 全文可回溯的三赢，且不依赖 ACP。

- 关联插件：`@harness/acp-context`
- 路线：**B（彻底）**（用户已确认）
- 关联文档：`docs/context-compression-plan.md`（阶段二 / D1-D6）、`docs/development-log.md`

---

## 1. 现状与矛盾（勘察结论）

| 项 | 现状 | 落点 |
|----|------|------|
| compact() 物理删消息 | `sess.messages = kept`，被删窗口原文即刻失效 | [core/src/index.ts] `compact()` L852 |
| blocks 未持久化 | `Session.blocks` 已定义，但 `storage.toFile()` 不写、`compact()` 不产 | [session] index.ts L265 / [workspace] storage.ts L55-L66 |
| query 全量投影 | `_prepareQuery`/`query` 直接 `finalMessages.push(...session2.messages)` | [core] L1499 / L1322 |
| resume 全量回填 | boot 逐条 `addMessage` 回填全部 saved.messages | [cli/src/index.ts] L1368-L1383 |
| 惰性加载缺 loader | `flushHistory/setHistoryLoader` 接口存在但无 host 实现 | [core] DefaultSessionManager L701-L715 |
| 原文追溯 | ACP 走 `meta.acp.archive.v1`；通用 compact 无原文落盘 | [acp-context] L695-L704 |

核心矛盾：Route B 要求「内存瘦身 + 原文盘上可回溯」。而 compact 一旦把窗口从 `sess.messages` 删掉，`storage.save(sess)` 序列化的就是近期消息，被删原文会从 `{id}.json` 一并消失。因此必须在删除**那一刻**把原文写出到内存之外（磁盘），再让 loader 从盘还原。core 不直接读写文件，所以原文落盘用「宿主注入的 OriginalStore」完成。

---

## 2. 目标与设计决策

- **内存瘦身**：`sess.messages` = 近期消息（compact 后窗口不再驻留）；被压缩窗口原文写盘，`meta` 不再存原文。
- **请求瘦身（D1）**：query/queryStream 的 `finalMessages` 历史部分 = `renderBlocksAsMessage(blocks)`（摘要占位） + `view.messages`（近期），不再全量拼接。
- **全文可回溯（D3/D4）**：compact 时把窗口原文 `OriginalStore.save` 到 `sessions/{id}.cmp.orig/{blockId}.json`；`flushHistory`/loader 经断点索引按块还原，再与近期拼接成全文。
- **持久化（D2）**：blocks 作为稳定节点随会话落盘 —— `storage.toFile()` 增加 `blocks` 字段。
- **协同（D5）**：ACP 的 `session.compacting` hook（阶段三已接）仍在通用 compact 之前运行，通用 compact 再自行落盘原文到 OriginalStore —— 二者互不覆盖。ACP 可启停，通用瘦身与回溯始终生效。

---

## 3. 逐文件改动（决策完备）

### 3.1 `packages/session/src/index.ts`

1. `CompactionBlock` 增加可选字段 `origKey?: string`（约定该块原文在 OriginalStore 中的 key，缺省=block.id）。
2. 新增共享接口（供 core/workspace/cli 引用）：
   ```ts
   export interface SessionOriginalStore {
     save(sessionId: string, blockId: string, messages: Message[]): Promise<string | void>
     load(sessionId: string, blockId: string): Promise<Message[] | undefined>
   }
   ```
3. 新增纯函数 `reconstructHistory(sess, resolveBlock)`：按 `sess.blocks` 顺序，对每块经 `resolveBlock(block)` 取回原文（默认返回 `[]`），再拼 `sess.messages`，去重、按 `createdAt` 稳定排序，返回「全文 message 列表」。供 CLI loader、core exportMarkdown 共用，逻辑可单测。
4. `buildView` 语义保持不变（blocks+messages+slimmed=有无 blocks），**不在 buildView 里塞摘要占位**，占位只在 core 请求组装处插入，避免波及 revert 的 FakeSessionManager 测试。

### 3.2 `packages/workspace/src/compaction-store.ts`

1. `SessionCompactionStore` 增加原文档案读写：
   ```ts
   origDirFor(sessionId): Promise<string>            // sessions/{id}.cmp.orig
   saveOriginals(sessionId, blockId, messages): Promise<string>  // 写 {blockId}.json，tmp+rename 原子
   loadOriginals(sessionId, blockId): Promise<Message[] | undefined>
   countOriginals(sessionId): Promise<number>        // 该会话已归档原文消息总数（供 list 计数）
   ```
   `saveOriginals` 内 `mkdir -p`；返回写入的绝对路径。
2. 新增一个 `createWorkspaceOriginalStore(ws): SessionOriginalStore` 工厂，把上面方法适配成 `SessionOriginalStore` 接口（CLI 注入 core 用）。

### 3.3 `packages/workspace/src/storage.ts`

1. `SessionFile` 增加可选字段 `blocks?: CompactionBlock[]`。
2. `SessionFileStore.toFile()` 由 `blocks: s.blocks`（缺省 undefined）→ 写回 `save()`。
3. `SessionFileStore.load()` 透传 `blocks`（直接来自文件，天然保留）。
4. `list()` 的 `messageCount` 改为 `s.messages.length + await compactionStore.countOriginals(id)`（通过 workspace 构造的 compactionStore 读取，会话已压缩时统计最近+归档，仍反映全量）。

### 3.4 `packages/core/src/index.ts`

1. `AgentHarnessOptions` 增加可选 `originalStore?: SessionOriginalStore`；`HarnessImpl` 持有一个 `private readonly originalStore?`（从 options 读）。
2. `SessionServices` 增加可选 `originalStore?: SessionOriginalStore`；`DefaultSessionManager` 的 services 回调透传 `options.originalStore`（L1928-L1935 处补 `originalStore: options.originalStore`）。
3. **`compact()`**（L763-868）改造：
   - 在「消费插件改写 keepLast/strategy」之后、`sess.messages = kept` 之前：
     ```ts
     if (windowToPrune.length > 0) {
       const blockId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
       if (this.originalStore) {
         try { await this.originalStore.save(sessionId, blockId, windowToPrune) }
         catch { /* 落盘失败仅记录，不阻断压缩 */ }
       }
       sess.blocks = [...(sess.blocks ?? []), {
         id: blockId, topic: '会话压缩', summary: summaryText ?? '',
         startId: windowToPrune[0]?.id ?? '', endId: windowToPrune[windowToPrune.length-1]?.id ?? '',
         at: now, origKey: blockId,
       }]
     }
     ```
   - 继续 `sess.messages = kept`。compactMemory / compaction meta 逻辑不变。
4. **`getView`**（L695-699）：无需改（[blocks, recent, slimmed] 已满足）。新增宏：若服务端注入 originalStore，loader 需要一个实现 —— 见下：在 DefaultSessionManager 增加 `setOriginalStore` 注入或复用 `originalStore`。**决策**：`flushHistory` 的 loader 由 CLI 注册（见 3.5），core 不另写 loader。
5. **`_prepareQuery`（L1490-1499）与 `query`（L1313-1322）**：把
   `finalMessages.push(...session2.messages)` 改为：
   ```ts
   const view = await this.deps.session.getView(sessionId)
   if (view.slimmed) {
     const summaryMsg = renderBlocksAsMessage(view.blocks)
     if (summaryMsg) finalMessages.push(summaryMsg)
     finalMessages.push(...view.messages)
   } else {
     finalMessages.push(...session2.messages)
   }
   ```
   （`session2.messages` 在 slimmed 时等同年近期，但为清晰与回退安全，保持分支。）
   导入 `renderBlocksAsMessage`。
6. **`exportMarkdown`**（L931-960）：当 `sess.blocks?.length` 时，先把 `(await this.flushHistory(sessionId))` 作为全文；为空则回退 `sess.messages`。确保导出仍含全文摘要更全。

### 3.5 `packages/cli/src/index.ts`

1. `HarnessApp`：
   - 构造一个 `originalStore: SessionOriginalStore`（`createWorkspaceOriginalStore(this.workspace)`）传入 `createHarness({ ..., originalStore })`。
2. `boot()` 会话恢复处（L1368-L1383）：
   - `sm.create` 后补 `session.blocks = saved.blocks ?? undefined`（当前 create 不设 blocks）。
   - 注册惰性加载器（仅当该会话存在 blocks 时）：
     ```ts
     sm.setHistoryLoader(sid, { load: async (s, range) =>
       this.loadFullHistory(s, range) })
     ```
   - 新增私有方法 `loadFullHistory(sessionId, range?)`：取 `harness.session.get(sid)` 得到近期+messages+blocks，用 `reconstructHistory`+`originalStore.load(blockId=origKey)` 取回各块原文，合并近期，再按 `range`（startId/endId/blockIds）过滤；无 range 返回全文。异常 one级容错返回近期。
3. `/resume` 命令（L1746-1762）：同样补 `next.blocks = saved.blocks` + 注册 loader。
4. 恢复后的消息统计文案（`saved.messages.length`）可改用 `await this.loadFullHistory(arg)` 长度，汇报全量条数。

### 3.6 `packages/plugins/acp-context`

- 本阶段**不改**。ACP 的 `session.compacting` hook 已在通用 compact 之前运行，已完成自己的折叠与 `meta.acp.archive` 保全；通用 compact 新增的 OriginalStore 落盘与之正交。仅确认：ACP `preModel` 收到的是 slim 视图（近期），其行为不受影响。

---

## 4. 假设与决策

- **原文档案位置**：`dataDir/sessions/{sessionId}.cmp.orig/{blockId}.json`（每块一个文件，块 id 稳定可定位，覆盖式写）。`{sessionId}.json` 仅存「近期 + blocks + meta」，磁盘与内存同步瘦身。
- **`.cmp.json`（阶段一遗留）**：保留为辅助旁路，本阶段不进核心读取路径；blocks 以 `session.blocks`（落 `{id}.json`）为准，避免双源漂移。
- **OriginalStore 落盘是 best-effort**：失败仅告警，压缩照常；此时该块原文不可盘上回溯（退化为只留摘要），但不影响主流程。
- **compact() 仅当真实有修剪**（`windowToPrune.length>0` 且 `msgs.length > keepRecent`）才建块，避免空块。
- **revert 兼容性**：revert 读取 `session.messages`（`get()` 返回对象）。其 `/revert` 目标边界消息为**最近**消息，落在近期 messages 内，天然可工作；若边界已被压缩进块（历史回滚），该 id 不在近期中 → `/revert` 找不到 → 作为**已知限制**留待阶段四处理（届时经 loader 全文回滚）。本阶段不改 revert 包。
- **token 估算**：`estimateTokens/compactIfNeeded` 继续基于 `sess.messages`（近期），代表当前驻留上下文；不额外读盘。
- **ACG 要求**：Route B 仅改 core/workspace/session/cli 本体，保持插件化纪律——原文落盘/loader 走「注入 + 接口」，不把磁盘路径写死进 core。

---

## 5. 实施顺序

按依赖序，每包结束跑 typecheck + 单测，更新开发日志并 commit：

1. **session**：`CompactionBlock.origKey` + `SessionOriginalStore` + `reconstructHistory`（含单测）。
2. **workspace**：`saveOriginals/loadOriginals/countOriginals` + `createWorkspaceOriginalStore` + `storage` 持久化 blocks + `list.messageCount` 含归档（含单测）。
3. **core**：`originalStore` 注入 + `compact()` 产块+落盘 + `_prepareQuery`/`query` 走 slim 视图 + `exportMarkdown` 用全文（含 `core.test` 增量：compact 产块、originalStore.save 被调、slim 视图、export 全文）。
4. **cli**：`createWorkspaceOriginalStore` 注入 + boot/resume 补 blocks+loader + `loadFullHistory`（手测/回归）。
5. 回归：apc / revert 包测试通过；`bun run typecheck` 全绿；`bun test` 全绿；更新 `docs/development-log.md`（续 109）与 `docs/context-compression-plan.md` 状态；按 AGENTS 规则精确暂存 + git commit。

---

## 6. 验证

- **单元**：
  - session：`reconstructHistory` 按块还原原文 + 近期去重排序；`buildView` 兼容性不回归。
  - workspace：blocks 写读 `{id}.json` 往返;`saveOriginals/loadOriginals/countOriginals` 往返;`list.messageCount`=近期+归档。
  - core：compact→`sess.blocks` 追加+`messages` 瘦到 keepRecent+`originalStore.save` 被调用并含窗口；query slim 时 finalMessages 含摘要占位且不含被压缩原文消息；无 blocks 时行为零变化；exportMarkdown 在 blocks 存在时含全文。
- **回归**：`bun run typecheck`、`bun test` 全绿；`@harness/acp-context`、`@harness/revert` 测试不破。
- **手测**：长会话触发 /compact 后，`sess.messages` 条数降为 keepRecent、`sessions/{id}.cmp.orig` 出现块文件；重启 `resume` 后 /history 仍能经 loader 看到被压缩原文；/compact info 显示压缩次数正常；关掉 ACP 后通用压缩+回溯仍生效。