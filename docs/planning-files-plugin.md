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
| SessionStart / UserPromptSubmit | `prompt.system.transform`（每轮重建 system prompt 片段数组） | `packages/core/src/index.ts#L1244-L1248`、`#L1422-L1426` |
| PreCompact | `session.compacting` | `packages/plugin/src/index.ts#L182` |
| 斜杠命令 | `cli.commands` / `cli.command` | `packages/plugin/src/index.ts#L204-L208`、`packages/cli/src/index.ts#L1497/L1994` |
| Skill 注册 | `harness.init` + `skillManager.register`（loadedFrom: 'plugin'） | 参考 `packages/plugins/computer-use/src/index.ts#L62-L78` |
| 读写三文件 | 复用既有 `read_file` / `write_file` / `bash` 工具 | `tools-builtin` |

关键发现：本项目已有 `core.skill-injection` 插件用 `prompt.system.transform` 注入 Skill 内容（`packages/core/src/index.ts#L1923-L1972`）——**计划注入走同一接缝，工程一致、天然跨会话/压缩存活**。

---

## 2. 目标

- **持久**：计划在盘，`/clear`、重启、崩溃、上下文压缩后下轮自动恢复。
- **注入**：每轮把「当前阶段 / 下一步 / 目标 / 完成度」注入 system prompt，模型不再依赖易失上下文记忆计划。
- **防漂移**：目标与已选下一步常驻上下文（smart 策略），治 goal drift。
- **防篡改**：SHA-256 认证，被外部静默改写时告警。
- **可插拔**：纯插件实现，enable/disable 不影响其余系统；未启用时零行为。

---

## 3. 总体架构（数据流）

```
┌──────────── 模型每轮 ────────────┐
│   user 消息 → query → system prompt 组装
│      ↓
│   prompt.system.transform hook：读 .planning/ 三文件
│      → 计算 attestation → 注入 ===BEGIN PLAN DATA=== 块
│   （smart 策略：只注入 目标+当前阶段+下一步+完成度）
└──────────────┬───────────────────┘
               │ 模型调用 write_file / read_file
┌──────────────▼───────────────────┐
│  .planning/（磁盘，跨会话存活）    │
│   task_plan.md    阶段+复选框     │
│   findings.md     研究/决策       │
│   progress.md     进度/测试日志   │
│   .active_plan    多计划指向      │
└───────────────────────────────────┘
```

- **注入**：`prompt.system.transform` 每轮从盘读最新状态 → 组装注入块 → 追加 `parts`。
- **更新**：模型用既有 `write_file`/`read_file` 直接编辑三文件（复用工具策略，不加专用工具）。
- **认证**：注入时计算三文件 SHA-256，与上次注入的哈希比对；不匹配（且非模型本轮改动）→ 注入 `[PLAN TAMPERED]` 告警。
- **命令**：`/plan`（初始化/展示）、`/plan-status`（状态）、`/plan-doctor`（自检）、`/plan-complete`（完成度）。

---

## 4. 关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 注入走 `prompt.system.transform`，而非 `session.preModel` 插消息 | 与 skill-injection 同机制；不污染历史；与压缩正交；计划是权威上下文放 system prompt 语义正确 |
| D2 | 三文件放 `.planning/` 目录 | 不污染仓库根；支持 `.active_plan` 多计划；默认 gitignore |
| D3 | 复用 `read_file`/`write_file` 更新三文件，不注入专用工具 | 实现最简、权限走既有工具链；attestation 由注入 hook 侧计算，不依赖工具 |
| D4 | attestation 为「动态哈希 + 告警」而非「拒绝写入」 | 复用工具模式下无法拦写；模型合法改动后哈希自然更新，外部静默改写时告警足够 |
| D5 | smart 注入策略（PWF_INJECT=smart 类比） | 长计划只注入目标+当前阶段+下一步+完成度，省 token、防上下文被计划占满 |
| D6 | 并发保护降级为「checked 计数提示」 | 复用工具模式下无法强锁文件；注入块携带上次 checked 计数，模型写入时发现下降可获提示 |
| D7 | Skill 注册 + CLI 命令齐备 | 与 computer-use 插件同模式：插件工厂 + skillManager.register + cli.commands/command |

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
- `prompt.system.transform` hook：
  - 每轮 `resolvePlanDir` → 读三文件 → `parsePlan` → 计算 attestation → 组装注入块
  - 注入块格式：
    ```
    ===BEGIN PLAN DATA===
    计划: .planning/task_plan.md
    目标: …
    当前阶段: Phase 2 (进行中)  [完成度 3/5]
    下一步: …
    哈希: sha256:abcd…（上次: sha256:xxxx，若变化且非本轮写入 → [PLAN TAMPERED]）
    ===END PLAN DATA===
    ```
  - smart 策略：`planning.inject: 'smart' | 'full'`（选项，默认 smart）
- `session.compacting` hook：压缩前把 `progress.md` 尾部（本轮进度）flush 到盘（PreCompact 对应，防压缩丢尾部日志）
- 单测：注入块内容/格式、smart 裁剪、tampered 告警

### 阶段三：CLI 命令 + Skill 注册
- `cli.commands` 注册：`plan`、`plan-status`、`plan-doctor`、`plan-complete`
- `cli.command` 处理：
  - `/plan [任务描述]`：初始化三文件（若不存在）并展示
  - `/plan-status`：展示阶段/完成度/下一步
  - `/plan-doctor`：自检（文件存在、parse 成功、hook 已注册、注入耗时）
  - `/plan-complete`：全部勾选时提示可收尾
- `harness.init`：`skillManager.register`（loadedFrom: 'plugin'）注册精简版 SKILL 指南，指导模型何时/如何维护三文件
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
| ACP 上下文压缩 | 计划注入在 system prompt，ACP 处理的是 messages | **正交**，压缩不影响计划注入；压缩前 flush 由 session.compacting 兜底 |
| session 原生 Compaction | 同上；PreCompact flush progress 尾部 | 正交，无二次压缩 |
| Skill 系统 | plugin 来源 skill 注册 + prompt.system.transform 注入 | 与 core.skill-injection 同机制，无冲突（注入顺序：skill 片段之后追加 PLAN DATA 块） |
| 既有 todo / TodoList | todo 在上下文窗口（易失）；plan 在盘（持久） | 互补：todo 管短期执行、plan 管长期目标 |
| 工具权限 | 复用 read_file/write_file，权限走既有工具链 | 无需新增权限键；`.planning/` 建议加入默认可读写路径 |

---

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 复用工具模式下 attestation 无法强制"拒绝写入" | D4：降级为动态哈希+告警；模型合法改动哈希自然更新 |
| 并发会话互相覆盖完成项 | D6：checked 计数提示（本阶段可接受；后续可加文件锁增强） |
| 注入块占用 system 侧 token | smart 策略默认裁剪；`inject: 'full'` 显式开启全量 |
| 模板与上游格式漂移 | 模板外置 .md，文档标注与上游三文件格式对应关系 |
| 计划文件损坏导致 parse 失败 | `/plan-doctor` 检测 + 注入块降级为「计划解析失败，建议 /plan 重建」 |

---

## 8. 实施顺序

按 **阶段一 → 阶段二 → 阶段三 → 阶段四** 实施，每阶段收尾：
1. 该包 `typecheck` + `bun test` 通过；
2. 根 `tsconfig.json` paths + 根/插件 `package.json` 注册 `@harness/planning-files`，`bun install`；
3. 更新 `docs/development-log.md`（续 N）；
4. git 提交（风格 `feat(planning-files): 中文描述`）。
