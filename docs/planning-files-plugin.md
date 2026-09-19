# 文件化持久规划插件方案（@harness/planning-files）

> 目标：把开源项目 [planning-with-files](https://github.com/OthmanAdi/planning-with-files) 的
> 「三文件持久化规划」模式实现为本项目的插件化版本：
> **计划放磁盘（task_plan.md / findings.md / progress.md），每轮经 system prompt 注入，
> 跨会话 / 压缩 / 崩溃存活**。

- 参考上游：OthmanAdi/planning-with-files（MIT）
- 本方案决策：注入方式 = **system prompt 注入**；文件位置 = **`.planning/` 目录**；工具策略 = **复用现有读写工具**
- 状态：方案待批，尚未实施

---

## 1. 背景与现状

### 1.1 上游核心机制（planning-with-files）

| 机制 | 说明 |
|------|------|
| 三文件模式 | `task_plan.md`（阶段+复选框）、`findings.md`（研究笔记）、`progress.md`（进度/测试日志） |
| 生命周期注入 | SessionStart / UserPromptSubmit / PreCompact hooks 每轮把 `===BEGIN PLAN DATA===` 块注入上下文 |
| SHA-256 attestation | 计划文件哈希校验，被外部静默改写时注入 `[PLAN TAMPERED]` 拒绝 |
| Gated mode | 有 in_progress 阶段未完成时阻止模型过早停止 |
| parallel-write guard | 检测并发会话把完成项改回未完成（checked 计数下降） |
| Autonomous mode | 每轮不再背诵全文，用固定形状的 ledger 摘要替换 progress 尾部（省 token） |
| 命令 | `/plan`、`/plan-doctor`、`/pwf-status` |
| 多计划 | `.planning/YYYY-MM-DD-slug/` + `.active_plan` 指向，并行任务隔离 |

### 1.2 本项目（@harness）现有能力映射

| 上游 hook | 本项目对应 | 落点 |
|-----------|-----------|------|
| SessionStart / UserPromptSubmit | `core.prompt.system.transform`（每轮重建 system prompt 片段数组） | `packages/core/src/index.ts#L1244-L1248`、`#L1422-L1426` |
| PreCompact | `core.session.compacting` | `packages/plugin/src/index.ts#L182` |
| 斜杠命令 | `cli.commands` / `cli.command` | `packages/plugin/src/index.ts#L204-L208`、`packages/cli/src/index.ts#L1497/L1994` |
| Skill 注册 | `core.harness.init` + `skillManager.register`（loadedFrom: 'plugin'） | 参考 `packages/plugins/computer-use/src/index.ts#L62-L78` |
| 读写三文件 | 复用既有 `read_file` / `write_file` / `bash` 工具 | `tools-builtin` |

关键发现：本项目已有 `core.skill-injection` 插件用 `core.prompt.system.transform` 注入 Skill 内容（`packages/core/src/index.ts#L1923-L1972`）；而 `core.session.preModel`（`packages/plugin/src/index.ts#L188-L191`）每轮进入模型前触发、可原地改 messages——**tail 放置走该 hook：临时插入、不落历史、历史前缀稳定、缓存最优**。

---

## 2. 目标

- **持久**：计划在盘，`/clear`、重启、崩溃、上下文压缩后下轮自动恢复。
- **注入**：每轮在消息尾部临时注入「当前阶段 / 下一步 / 目标 / 完成度」，模型不再依赖易失上下文记忆计划；历史前缀稳定，缓存友好。
- **防漂移**：目标与已选下一步常驻上下文（smart 策略），治 goal drift。
- **防篡改**：approved-hash 认证（`/plan-attest`），被外部静默改写时告警。
- **可插拔**：纯插件实现，enable/disable 不影响其余系统；未启用时零行为。

---

## 3. 总体架构（数据流）

```
┌──────────── 模型每轮 ────────────┐
│   user 消息 → query → finalMessages 组装
│      ↓
│   core.session.preModel hook（tail 放置）：
│      读 .planning/ 三文件 → 组装计划块 → 临时插入 messages 尾部
│      （不 save、不落历史；smart 策略：目标+当前阶段+下一步+完成度）
│      → 历史前缀稳定 → 缓存命中
└──────────────┬───────────────────┘
               │ 模型调用 write_file / read_file
┌──────────────▼───────────────────┐
│  .planning/（磁盘，跨会话存活）    │
│   task_plan.md    阶段+复选框     │
│   findings.md     研究/决策       │
│   progress.md     进度/测试日志   │
│   .active_plan    多计划指向      │
│   .attest.json    approved hash  │
└───────────────────────────────────┘
```

- **注入**：`core.session.preModel` 每轮从盘读最新状态 → 组装计划块 → 在 messages 尾部临时插入一条 user 消息（不 `save`、不落历史）；计划未变化时注入与上轮逐字相同的文本（D8）。
- **更新**：模型用既有 `write_file`/`read_file` 直接编辑三文件（复用工具策略，与原版一致）；改完运行 `/plan-attest` 重新认证。
- **认证**：`/plan-attest` 锁 approved hash；注入时当前哈希 ≠ 已认证哈希 → 注入 `[PLAN TAMPERED]` 并拒绝计划正文。
- **命令**：`/plan`（初始化/展示）、`/plan-status`（状态）、`/plan-attest`（认证）、`/plan-doctor`（自检）、`/plan-complete`（完成度）。

---

## 4. 关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 注入走 `core.session.preModel` **tail 放置**：在 messages 尾部临时插入一条 user 消息（内容为计划块），**不调用 save、不落历史**，本轮请求后即丢弃 | 历史消息前缀完全稳定 → 缓存最大命中（仅 prefill 计划块+新消息）；`core.session.preModel` 本就每轮触发且可原地改 messages，工程代价小；不污染持久历史 |
| D2 | 三文件放 `.planning/` 目录 | 不污染仓库根；支持 `.active_plan` 多计划；默认 gitignore |
| D3 | 复用 `read_file`/`write_file` 更新三文件，不注入专用工具 | 与原版一致（原版就是通用工具改文件）；权限走既有工具链；attestation 由认证命令+注入校验承担 |
| D4 | attestation 为「**approved-hash 认证锁**」（对齐原版 attest-plan）：`/plan-attest` 把当前 task_plan.md 哈希锁进 `.attest.json`；注入时当前哈希 ≠ 已认证哈希 → 注入 `[PLAN TAMPERED]` 并拒绝计划正文 | 复用工具模式下无法拦写，但可区分「合法修改（改后已 attest）」与「未批准修改/外部篡改（未 attest）」；同时形成强制纪律：模型改完必须重新认证 |
| D5 | smart 注入策略（PWF_INJECT=smart 类比） | 长计划只注入目标+当前阶段+下一步+完成度，省 token、防上下文被计划占满；注入块设 token 上限（默认 ≤300），超长只注入摘要行，控制上下文占用 |
| D6 | 并发保护降级为「checked 计数提示」 | 复用工具模式下无法强锁文件；注入块携带上次 checked 计数，模型写入时发现下降可获提示 |
| D7 | Skill 注册 + CLI 命令齐备 | 与 computer-use 插件同模式：插件工厂 + skillManager.register + cli.commands/command |
| D8 | 注入块做**缓存友好设计**：按文件 mtime/哈希做变化检测，计划未变化则注入与上轮**逐字相同**的文本 | 即使 tail 放置，计划块内容变化也会影响「计划块→新消息」段的 prefill；变化检测让计划未变时注入文本逐字一致，进一步稳住缓存 |
| D9 | `injectPlacement: 'tail'`（默认）`\| 'system'`（备选） | `tail`：消息尾部临时插入，历史前缀稳定、缓存最优；`system`：注入 system prompt 尾部，供无法临时插消息的场景兜底 |

---

## 5. 开发阶段划分（每阶段可独立验证/回退）

### 阶段一：核心文件模型 + 模板（纯 TS，无 shell 依赖）
- `packages/plugins/planning-files/src/plan-files.ts`：
  - `resolvePlanDir(cwd)`：项目根 `.planning/`；`readActivePlan()` / `setActivePlan(slug)`（`.active_plan`）
  - `ensurePlanFiles(dir)`：按 `templates/` 生成三文件（task_plan / findings / progress）
  - `readPlanFiles(dir)` / `writePlanFiles(dir)`
  - `parsePlan(md)`：解析 `## Phase N` + `- [ ]` / `- [x]` → `{ phases, doneCount, totalCount, activePhase, complete }`
  - `attest(dir)` / `verifyAttestation(dir)`：node:crypto SHA-256 → `.planning/.attest.json`
- `templates/task_plan.md`、`findings.md`、`progress.md`（外置 .txt 或 .md，经 import 加载，同 tools-builtin 提示词外置惯例）
- 单测：解析、attestation、ensure 幂等

### 阶段二：注入机制（核心）
- `core.session.preModel` hook（tail 放置）：
  - 每轮 `resolvePlanDir` → 读三文件 → `parsePlan` → 校验 approved hash → 组装计划块
  - **临时插入**：在 messages 尾部 push 一条 user 消息（内容为计划块），**不调用 `save`、不落历史**，本轮请求后即丢弃
  - 注入块格式：
    ```
    ===BEGIN PLAN DATA===
    计划: .planning/task_plan.md
    目标: …
    当前阶段: Phase 2 (进行中)  [完成度 3/5]
    下一步: …
    认证: sha256:abcd…（已认证；若不匹配 → [PLAN TAMPERED]，仅注入告警行）
    ===END PLAN DATA===
    ```
  - smart 策略：`planning.inject: 'smart' | 'full'`（选项，默认 smart）；注入块 token 上限（默认 300）
  - **变化检测（缓存友好，D8）**：记录 `{ lastBlockText, lastSig }`（sig = 三文件 mtime+size+hash）；本轮 sig 与上次一致 → 直接复用 `lastBlockText`（逐字相同，前缀缓存命中）；变化 → 重算注入块并更新 `lastBlockText`
- `core.session.compacting` hook：压缩前把 `progress.md` 尾部（本轮进度）flush 到盘（PreCompact 对应，防压缩丢尾部日志）
- 单测：注入块内容/格式、smart 裁剪、tampered 告警、**变化检测（sig 不变时注入文本逐字一致）**、tail 模式不落历史（hook 后 messages 恢复原样）

### 阶段三：CLI 命令 + Skill 注册
- `cli.commands` 注册：`plan`、`plan-status`、`plan-attest`、`plan-doctor`、`plan-complete`
- `cli.command` 处理：
  - `/plan [任务描述]`：初始化三文件（若不存在）并展示
  - `/plan-status`：展示阶段/完成度/下一步
  - `/plan-attest`：锁定当前 task_plan.md 的 approved hash（对齐原版 attest-plan；`--show`/`--clear`）
  - `/plan-doctor`：自检（文件存在、parse 成功、hook 已注册、attest 状态、注入耗时）
  - `/plan-complete`：全部勾选时提示可收尾
- `core.harness.init`：`skillManager.register`（loadedFrom: 'plugin'）注册精简版 SKILL 指南，指导模型何时/如何维护三文件（含「改完必须 /plan-attest」纪律）
- 单测：命令解析、doctor 自检、skill 注册

### 阶段四：增强（可选，按需）
- **parallel-write guard**：注入块携带 checked 计数，`plan_status` 对比（本阶段并发保护降级版）
- **多计划**：`.active_plan` 完整支持 + `/plan use <slug>` 切换
- **catchup**：可选读取 `dataDir/sessions/{sessionId}.json` 汇总历史进度写入 progress.md（显式触发）
- **gated 提示**：注入块包含未完成阶段数，配合 `/plan-complete` 提醒模型勿提前宣布完成

---

## 6. 与现有机制兼容性

| 机制 | 交互 | 结论 |
|------|------|------|
| ACP 上下文压缩 | 计划块在消息尾部临时插入，ACP 处理 messages；未落历史、不参与压缩归档 | **正交**：tail 插入发生在 preModel，ACP 与计划注入同 hook 时按注册顺序依次处理，计划块不入压缩范围；压缩前 flush 由 core.session.compacting 兜底 |
| session 原生 Compaction | 同上；PreCompact flush progress 尾部 | 正交，无二次压缩 |
| Skill 系统 | plugin 来源 skill 注册（`core.prompt.system.transform` 注入由 core.skill-injection 承担）；计划走 `core.session.preModel` tail | 两条注入路径互不冲突：skill 在 system prompt、计划在消息尾部 |
| 既有 todo / TodoList | todo 在上下文窗口（易失）；plan 在盘（持久） | 互补：todo 管短期执行、plan 管长期目标 |
| 工具权限 | 复用 read_file/write_file，权限走既有工具链 | 无需新增权限键；`.planning/` 建议加入默认可读写路径 |

---

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 模型修改计划文件后忘 attest，注入触发 TAMPERED 误报 | D4 语义即"未批准修改"；SKILL 指南明确「改完必须 /plan-attest」纪律；`/plan-attest` 一键修复 |
| 并发会话互相覆盖完成项 | D6：checked 计数提示（本阶段可接受；后续可加文件锁增强） |
| 注入块占用上下文 token | smart 策略默认裁剪；`inject: 'full'` 显式开启全量；token 上限 300 |
| tail 临时插入与 ACP 同 hook 的顺序 | 计划注入 hook 与 ACP 均注册 `core.session.preModel`，按注册顺序执行；计划块插入在最后，不影响 ACP 压缩范围 |
| 模板与上游格式漂移 | 模板外置 .md，文档标注与上游三文件格式对应关系 |
| 计划文件损坏导致 parse 失败 | `/plan-doctor` 检测 + 注入块降级为「计划解析失败，建议 /plan 重建」 |

---

## 8. 实施顺序

按 **阶段一 → 阶段二 → 阶段三 → 阶段四** 实施，每阶段收尾：
1. 该包 `typecheck` + `bun test` 通过；
2. 根 `tsconfig.json` paths + 根/插件 `package.json` 注册 `@harness/planning-files`，`bun install`；
3. 更新 `docs/development-log.md`（续 N）；
4. git 提交（风格 `feat(planning-files): 中文描述`）。
