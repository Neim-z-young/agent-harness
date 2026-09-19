# 记忆能力与技能锻造：功能计划

> 状态：**规划阶段，未动码**（调研日期 2026-09-19）。
> 目标：让 Harness 具备 ①跨会话记忆（记住偏好与项目事实）②自动把重复流程固化成技能。
> 本文只做现状盘点、方案设计与排期；每节的"验收"即实施时的回归闸门。

---

## 0. 结论先行

两套能力都**不必从零起步** —— 基建已就绪（两级 workspace 目录、SKILL.md 加载器、会话压缩记忆、
`prompt.system.transform` 注入链）。真正的缺口只有三处：

1. **没有跨会话记忆的存储与注入**（现有的 `CompactMemory` 是**会话内**压缩摘要，换会话即失）；
2. **技能系统只读**（`SkillManager` 有 load/reload/enable/disable，**没有 save/create**）；
3. **新发现的风险**：注入到 system prompt 的内容**可能被 ACP 折叠** —— 内核与 adapter 都未对
   `role: 'system'` 做特殊处理（grep 无命中），而 `session.preModel` 会把 system 消息与普通消息
   一并交给压缩管道 ⇒ 记忆/指令有被压掉的可能。**这是第一阶段必须先验证的事**。

建议两条线并行推进，但**记忆先做"读"、技能锻造后做"写"**：读路径零风险且立刻有收益
（项目指令不再被压缩吞掉、偏好不再重复交代），写路径涉及权限、治理与安全，需更谨慎。

一条贯穿两者的设计原则（Claude Code 官方原文）：

> "If an entry is a multi-step procedure or only matters for one part of the codebase,
> move it to a **skill** or a path-scoped rule instead."

即：**记忆存"事实与偏好"，多步流程下沉成"技能"**。这条边界就是两条线的连接点（§5）。

---

## 1. 现状盘点

### 1.1 已有（可直接复用）

| 能力 | 位置 | 说明 |
|---|---|---|
| 两级 workspace 目录 | `workspace/src/index.ts:24-76` | `user`(dataDir) / `project`(<cwd>/.harness)，各有 `plugins`/`skills`/`agents`；`loadDirs` 给出扫描顺序（后者覆盖前者） |
| SKILL.md 加载器 | `skill/src/index.ts:68-134` | frontmatter（name/description/paths/agentBind/userInvocable）+ Markdown 正文；来源标签 `user`/`project`/`mcp`/`plugin`；支持目录式 `<name>/SKILL.md` 与单文件式 |
| 技能注入插件（**最佳范式**） | `core/src/index.ts:2506-2524` | `core.skill-injection`：内部插件 + `prompt.system.transform` 注入。记忆注入应照抄此形态 |
| 技能管理命令 | `cli/src/index.ts:2035-2070` | list / enable / disable / reload |
| 会话压缩记忆 | `session/src/index.ts:146-157`、`core/src/index.ts:911-1004` | `CompactMemory{ round, summaryText, memoryStartAt }`，存 `session.meta`；压缩时累积拼接，经 `appendCompactionMemory` 注入 system prompt |
| 技能目录装配 | `cli/src/index.ts:2414-2418` | `skillDirs: [user, project]` |

### 1.2 缺失

| 缺口 | 影响 |
|---|---|
| `WorkspaceLevel` 无 `memory` 字段 | 记忆无处安放（需新增字段 + `loadDirs.memory`） |
| 无跨会话记忆读写与注入 | 每次新会话都要重述偏好；项目事实无法沉淀 |
| **仓库根 `AGENTS.md` 未被加载** | 文件存在（7809 字节）但 CLI/core 均无加载逻辑（grep 无命中）⇒ 目前纯靠人手工复制进对话 |
| `SkillManager` 无写入 API | 技能只能人工新建文件 |
| 无 `/memory` 命令 | 无法浏览/编辑/删除记忆 |
| 无技能生成模板与治理 | 自动生成无从落地；技能数量膨胀无约束 |

---

## 2. 参考实现（Claude Code，已核实官方文档）

两条记忆并存、互补：

| 维度 | CLAUDE.md（人写） | Auto memory（模型写） |
|---|---|---|
| 内容 | 指令与规则 | 学习到的模式与偏好 |
| 作用域 | project / user / org | **按仓库**（路径由 git 仓库派生 ⇒ 同仓库多 worktree 共享） |
| 加载 | 每会话全量（上限 4 MiB） | 每会话 **MEMORY.md 前 200 行或 25KB**（先到先算） |
| 用途 | 编码规范、架构、工作流 | 你的纠正、Claude 无法从代码推导的项目上下文 |

关键实现细节（可直接借鉴）：

- **存储**：`~/.claude/projects/<project>/memory/`，结构为
  ```
  MEMORY.md            # 索引，每行一条记忆 —— 每会话加载
  user_role.md         # 一条记忆（主题文件）
  feedback_testing.md
  ```
  主题文件**不预载**，模型需要时用文件工具按需读取 ⇒ 索引 + 按需 = 预算可控。
- **写入**：Claude 用标准文件工具自己读写，自行判断"是否对将来对话有用"；
  写入带 frontmatter 时自动记 `modified`（ISO 8601）。
- **跳过规则**：不写"可从代码库推导"的内容（架构、文件路径、调试修复），也不重复 CLAUDE.md 已有的。
- **分类** `type`：`user`（角色/偏好）/ `feedback`（纠正/确认）/ `project`（进行中工作/决策）/ `reference`（外部信息位置）。
- **子代理隔离**：主会话记忆**不**注入 subagent（fork 除外），子代理可有自己的记忆目录。
- **开关**：默认开启；`autoMemoryEnabled: false` 或 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 关闭；
  `autoMemoryDirectory` 可改路径。机器本地、不跨机器同步。

**值得警惕的一条**：写入后若 MEMORY.md 超限，写入仍成功但超出部分"下次加载时被丢弃" ⇒
我们必须做**写入前校验并拒绝/要求重写索引**，否则会出现"记了但读不到"的静默失效
（本项目已两次栽在同类"静默失效"上）。

---

## 3. 能力一：记忆（Memory）

### 3.1 三层模型

| 层 | 谁写 | 生命周期 | 作用域 | 现状 |
|---|---|---|---|---|
| **L0 项目指令** | 人 | 随仓库 | user + project 两级 | 文件存在但**未加载** |
| **L1 长期记忆** | 模型 | 跨会话、持久 | user 级（偏好）/ project 级（项目事实） | **缺失** |
| **L2 会话压缩记忆** | 引擎 | 随会话 | 单会话 | 已有 `CompactMemory` |

L2 不属长期记忆，但应作为 **L1 的候选来源**：压缩时若发现"值得长期保留"的纠正/决策，
提示模型写入 L1（否则长会话纠正过的事，压缩完就只剩摘要，下次照样重犯）。

### 3.2 存储布局

```
~/.harness/memory/                 # user 级：跨项目的个人偏好
  MEMORY.md                        # 索引（每会话加载前 200 行 / 25KB）
  topics/<topic>.md                # 主题记忆，按需读取

<cwd>/.harness/memory/             # project 级：项目事实、决策、约定
  MEMORY.md
  topics/<topic>.md
```

- `WorkspaceLevel` 新增 `memory` 字段，`loadDirs` 新增 `memory: [user, project]`（`workspace/src/index.ts`）。
- **作用域判定规则**（写进系统提示）：个人偏好/工作方式 → user；项目架构/约定/决策 → project。
- ⚠️ **待决策**：项目级 `.harness/` **未被 gitignore**（其内 `.gitignore` 只忽略 `last-session.json`）
  ⇒ project 记忆默认会进版本库、团队共享。这对约定类是好事，但**个人偏好误写进 project 会被提交**，
  需在写入时显式确认作用域，或把 project 记忆加入 `.harness/.gitignore`。

### 3.3 注入与预算

- **注入点**：照抄 `core.skill-injection`（`core/src/index.ts:2506`）建 `core.memory-injection` 内部插件，
  挂 `prompt.system.transform`：注入 `user MEMORY.md` → `project MEMORY.md` → L0 指令片段。
- **预算**：MEMORY.md **前 200 行或 25KB**（与 Claude Code 一致，实测过的量级）；主题文件不预载，
  靠既有读文件工具按需读取 —— 索引里的"一句话 + 相对路径"就是检索入口。
- **去重与优先级**：project 覆盖 user（与 skills/agents 的覆盖规则一致：后者覆盖前者）。

### 3.4 ⚠️ 风险：注入内容可能被 ACP 折叠（先验证，再谈其余）

```
_buildStepMessages → finalMessages = [system 片段, ...历史]
                  → session.preModel（ACP）→ toCores(全部消息) → 内核折叠
```

内核与 adapter **都没有**对 `role: 'system'` 的特殊分支（grep `role === 'system'` 在
`node_modules/acp-kernel/dist/index.js` 与 `adapter.ts` 均无命中）⇒ system 片段很可能被当作
普通消息参与保护/折叠判定。若为真，则"注入了记忆但很快被压掉"——又是一次静默失效。

**M0 必须先做的验证**：造一个超长记忆 + 触发压缩的会话，断言若干轮后 system 片段是否仍在。
对策（按验证结果选一）：① 记忆走保护区/protected ref；② 在 `session.preModel` **之后**重新追加
记忆片段（即 ACP 裁剪完再挂上，不参与压缩）；③ 由插件在 preModel 里把记忆标记为不可折叠。

### 3.5 写入路径

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（先做）** | 模型用**既有写文件工具**写，靠系统提示约定路径/格式/分类 | 零新增代码；但 `permission=ask` 时每次写入都弹审批，体验差 |
| **B（后做）** | 提供 `memory_write` 工具（或内部 API），**不经权限通道**，内置大小/去重/分类校验 | 需设计权限豁免边界（记忆写入不应被当作危险操作，但也要防写密钥） |

建议：M1 走 A（顺带把 `/memory` 命令做了：list/read/edit/delete），M2 再评估 B。

### 3.6 治理（不做会很快失控）

- **体积**：MEMORY.md 写入前校验；超限则拒绝并提示"先精简索引"（Claude Code 的坑：写了但读不到）。
- **去重**：同主题覆盖而非追加；写入前检索索引里是否已有等价条目。
- **过期**：条目带 `modified`；超 N 天未命中可标记为待回顾（不自动删）。
- **内容红线**：不写可从代码推导的内容（架构、路径）、不写密钥/token（与 `SecretCipher` 相关）、
  不重复 L0 已有的指令。
- **隐私**：user 级记忆在本机；project 级可能入 git ⇒ 写入前提示作用域（见 §3.2 待决策）。

### 3.7 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** | 验证 §3.4 的折叠风险；`WorkspaceLevel.memory` + `loadDirs.memory` | 实测结论 + 目录字段可用；记忆暂不注入 |
| **M1** | 加载 L0（`AGENTS.md` 两级）+ L1 索引注入；`/memory` 命令（list/read） | 新会话能读到既有记忆与项目指令；注入量 ≤25KB |
| **M2** | 写入路径 A + `/memory edit|delete`；体积/去重校验 | 模型能写入并下会话读到；超限被明确拒绝（不静默） |
| **M3** | L2 → L1 候选提示（压缩时提醒沉淀）；子代理记忆隔离策略 | 压缩后不丢失关键纠正 |

---

## 4. 能力二：技能锻造（Skill Forge）

### 4.1 触发方式

| 方式 | 时机 | 建议 |
|---|---|---|
| **显式命令** `/skill-forge [name]` | 用户主动 | **先做**：可控、可评审 |
| 自然语言（"把这个流程记成技能"） | 用户主动 | M2 后接（需意图识别，可先靠 L0 约定） |
| **隐式：重复轨迹检测** | 引擎自动 | **最后做**：同工具序列出现 N 次才提示，避免噪音 |

隐式检测的价值最高也最危险 —— 历史上"自动沉淀"最容易产出一堆没人看的垃圾技能。
建议默认**只提示不自动写**。

### 4.2 生成

- **来源材料**：本次会话的工具轨迹（成功路径）+ 用户的纠正 + 相关 L1 记忆（若有）+ 已有相似技能（去重参考）。
- **模板**（与现有加载器契约严格对齐，`skill/src/index.ts:68-134`）：
  ```yaml
  ---
  name: acp-param-tuning
  description: 何时用（这一句决定模型会不会选中它，最重要）
  paths: ["packages/plugins/acp-context/**"]   # 可选：改这些文件时自动注入
  agentBind: [...]                              # 可选
  ---
  ## 步骤 / ## 坑 / ## 验收
  ```
  `description` 写"何时用"而非"做什么" —— 它是唯一的检索信号。
- **落位**：默认 **user 级**（不污染仓库）；`--project` 才写项目级（团队共享的流程应入 git）。

### 4.3 验证与注册

1. 模板校验（frontmatter 必填 + 长度上限）；
2. 相似度去重（与已有技能 description 比对，命中则提示"更新已有技能"而非新建）；
3. `skillManager.reload()`（**已有 API**，`skill/src/index.ts:127`）使新技能当轮可用；
4. **人工确认**（写成文件前展示草稿）—— 自动生成的技能一旦错了会被反复执行，成本远高于确认成本。

### 4.4 安全

- **生成的技能 `allowEmbedShell` 默认 false**：不能让模型给自己生成带 `!\`cmd\`` 的可执行技能
  （等于自我授权的 RCE 通道）。MCP 来源已强制 false（`skill/src/index.ts:65`），生成类应对齐此策略。
- 写入路径必须落在 workspace 的 skills 目录内，禁止越界（路径校验）。

### 4.5 治理

- 数量上限与定期回顾；**禁用而非删除**（`disable`/`enable` 已有）；
- 技能执行失败或被用户纠正 ⇒ 回写 L1 记忆（feedback 类），形成闭环；
- 与记忆的分工：单条事实进记忆，多步流程进技能（§0 原则）。

### 4.6 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **F0** | `SkillManager.save()`（写入 + 路径校验 + reload）+ 技能模板 | 能落一个新技能并当轮生效 |
| **F1** | `/skill-forge` 命令（生成草稿 → 人工确认 → 保存 → reload） | 端到端跑通；越界路径被拒 |
| **F2** | 去重 + 相似度提示 + 治理（数量上限、禁用） | 重复流程提示"更新已有" |
| **F3** | 隐式重复检测（**只提示不自动写**）+ 执行失败回写记忆 | 不产生噪音；闭环可验证 |

---

## 5. 两条线的协同

```
用户纠正 ──► L1 记忆（feedback）──► 重复出现 ──► 提示固化为技能 ──► F1 生成
                  ▲                                                    │
                  └──────────── 技能执行失败 / 被纠正 ◄────────────────┘
```

- 记忆是**输入**（提供沉淀素材）也是**输出**（记录技能执行结果）；
- 统一的"沉淀"入口能显著降低两套系统的认知负担，但**不要在首期耦合** —— 先各自跑通，
  再用一个 `/forge`（或 `/memory` 子命令）把它们串起来。

## 6. 阻塞点与难度

| # | 阻塞点 | 等级 | 说明 |
|---|---|---|---|
| B1 | **ACP 可能折叠 system 注入的记忆** | **P0（先验证）** | §3.4；不解决则整个记忆能力形同虚设 |
| B2 | `WorkspaceLevel` 需新增 `memory` | 小 | 加字段 + loadDirs；会波及所有 Fake workspace 测试替身 |
| B3 | `SkillManager` 需 `save()` | 小 | 加载器只读，需新增写入 + 路径校验 |
| B4 | 写入的权限通道 | 中 | ask 模式下每次写记忆都弹窗；需决定记忆写入是否豁免 |
| B5 | 注入预算与 token 成本 | 中 | 200 行/25KB 上限；主题文件按需读 |
| B6 | 子代理记忆隔离 | 决策 | 对齐 Claude Code：主会话记忆不注入 subagent |
| B7 | project 记忆是否入 git | 决策 | `.harness` 未被忽略 ⇒ 默认共享；隐私与共享的取舍 |
| B8 | 生成技能的质量/过时 | 长期 | 靠人工确认 + 治理缓解，无银弹 |

**难度评估**：单看代码量都不大（记忆 M0~M2 约 200~300 行 + 测试；技能锻造 F0~F1 约 150~250 行），
真正的成本在 **B1 的验证** 与 **B4/B6/B7 三个决策**。

## 7. 里程碑建议

```
M0（验证 + 目录字段）──► M1（注入 + /memory read）──► F0/F1（技能写入与锻造）
        │                                                      │
        └──► M2（写入与治理）                          M3（压缩→记忆；F2/F3 治理与隐式检测）
```

先 M0 拿到 B1 的结论 —— 它决定记忆注入的实现方式，也可能反过来要求改 ACP。

## 8. 决策（2026-09-19 已拍板）

| # | 议题 | 结论 | 落地影响 |
|---|---|---|---|
| B6 | 子代理记忆隔离 | **不注入 subagent**（对齐 Claude Code） | 注入时需能判断"当前是不是子 Agent" ⇒ 见 §9-B2（需 `agentMode` 通道） |
| B7 | project 记忆是否入 git | **入 git（团队共享）** | `.harness` 本就未被忽略（其内只忽略 `last-session.json`）；需在写入时**显式确认作用域**，避免个人偏好被提交 |
| B4 | 写入是否豁免权限审批 | **豁免** | 记忆/技能写入走插件内 fs，**不经工具权限通道**；但限定目录 + 禁写密钥 |
| — | 首期范围 | 记忆 + 技能锻造一起（分阶段、分提交） | 见 §7；先 M0 拿到 B1 结论 |

---

## 9. 插件化可行性评估

用户追问"功能做成插件的可行性"。逐条核对插件**手里实际有什么通道**后，结论：
**约 85% 可做插件**，剩余是 3 处"只读通道"缺口（每处约 5~10 行，且对所有插件都有益）。

### 9.A 纯插件即可实现（无需改 core/CLI）

| 功能 | 依托的既有通道 | 备注 |
|---|---|---|
| `/memory`（list/read/edit/delete） | `cli.commands` + `cli.command` hook | **关键**：CLI 注入的 `CliCommandInput` 已含 `workspace`（`app.workspace`，见 `cli/src/index.ts:3474`）与 `harness` ⇒ 路径与运行时操作都能拿到，不必猜目录 |
| `/skill-forge`（生成 → 确认 → 落盘 → reload） | 同上 + `harness.skillManager.reload(id)` | `SkillManager` 已有 `reload`（`skill/src/index.ts:127`） |
| 记忆/技能**写入** | 插件内直接 `fs` 写 | **天然不经过工具权限通道** ⇒ 正好满足决策 B4「豁免审批」，无需改权限引擎 |
| 重复流程检测 | `agent.stream` hook（2026-09-19 新增） | 统计工具序列即可 |
| 注入 system prompt | `prompt.system.transform` hook | 范式照抄 `core.skill-injection`（`core/src/index.ts:2506`） |
| 压缩时提示沉淀（L2→L1） | `session.compacting` hook | 已有 |

### 9.B 需要补的通道（core 侧小改，**每处都对所有插件有益**）

| # | 缺口 | 为什么插件绕不过去 | 建议 |
|---|---|---|---|
| B1 | **`PluginContext` / `PromptInput` 都没有 workspace、cwd** | 注入发生在 **prompt 构建期**，入参只有 `agentId`/`sessionId`（`plugin/src/index.ts:236`）；install 期也拿不到。变通做法是插件自己用 `process.cwd()` + `homedir()` 拼路径 —— 但 CLI 支持 `--cwd`，`process.cwd()` **未必等于** `workspace.cwd` ⇒ 会拼错目录（正是本项目栽过两次的"路径口径分裂"） | `PluginContext` 增 `workspace`（core 一处赋值，约 5 行）；`PromptInput` 增可选 `cwd` |
| B2 | **判断"当前是否子 Agent"无通道** | 决策 B6 要求不注入 subagent，但注入 hook 拿不到 agent 定义（`mode`）。变通：`agent.stream` 的 `AgentStatusSnapshot.mode` **能拿到 mode**（刚加的字段），但注入发生在事件之前 ⇒ 首轮无从判断 | `PromptInput` 增 `agentMode`（core 一处，约 5 行） |
| B3 | `CliCommandInput.harness?: unknown` 类型过松 | reload/agent 访问要靠 cast，编译期无保障 | 给 `CliCommandInput` 增明确方法（如 `reloadSkill(id)`），或至少类型化 harness |

### 9.C B1（记忆被 ACP 折叠）在插件方案下如何处置

**插件有一条天然的解法**：hook 按注册顺序执行（`plugin/src/index.ts:875`），而
**external 批（声明式 `plugins: ["memory"]`）晚于 internal 批安装** ⇒ 记忆插件的
`session.preModel` 排在 ACP（`id: 'context.acp'`，`acp-context/src/index.ts:504`）**之后**
⇒ 可以在 ACP 裁剪完之后再插入记忆片段，**当轮不会再被裁剪**；下一轮虽会进入 ACP 视野，
但每轮都重新插入 ⇒ 记忆恒在最新一轮（且落在 `preserveRecent` 尾部保护区内）。

两个必须注意的点：

- ⚠️ **不要写 `dependsOn: ['context.acp']`**：拓扑排序只对**同批**依赖建边
  （`plugin/src/index.ts:603-607`，跨批跳过），且 ACP 是**可选**插件（`compression.enabled` 才装配），
  写成硬依赖会在 ACP 关闭时出问题。跨批顺序本身就是"external 晚于 internal"，不必声明。
- 这是**顺序依赖**，换装配方式（如把记忆插件放进 internal 批）就可能失效。
  彻底解法仍在 core：提供显式的"裁剪后注入点"。建议 M0 验证后决定是否需要它。

### 9.D 建议的切分

```
@harness/memory       记忆读写 + 注入 + /memory 命令       （M0~M3）
@harness/skill-forge  技能落盘 + /skill-forge 命令 + 去重   （F0~F3）
core 侧               PluginContext.workspace、PromptInput.{cwd,agentMode}（各约 5 行）
```

首期**分开两个包**（§5：先各自跑通，再用统一 `/forge` 串起来）。两个插件都走
`optIn` + `plugins: [...]` 声明式启用，与刚落地的 `@harness/herdr` 同一套路
（`cli/src/index.ts` 的 `defaultBuiltinRegistry.register`，见 `docs/agentic-loop-plan.md` 的落地范式）。

### 9.E 结论

**可行，且推荐走插件**：写入免审批这个决策本身就与插件路径天然契合（不经工具通道），
命令侧通道已经齐备（workspace + harness 都注入了），剩下 3 处是"给插件补只读视野"的小改，
不是架构性障碍。真正需要提前验证的仍是 §3.4 的 B1 —— 它决定记忆注入走"hook 追加"还是
"core 注入点"，但它**不决定插件化是否成立**。
