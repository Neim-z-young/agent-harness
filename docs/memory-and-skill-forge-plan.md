# 记忆能力与技能锻造：功能计划

> 状态：**规划阶段，未动码**（调研日期 2026-09-19）。
> 目标：让 Harness 具备 ①跨会话记忆（记住偏好与项目事实）②自动把重复流程固化成技能。
> 本文只做现状盘点、方案设计与排期；每节的"验收"即实施时的回归闸门。

---

## 0. 结论先行

两套能力都**不必从零起步** —— 基建已就绪（两级 workspace 目录、SKILL.md 加载器、会话压缩记忆、
`core.prompt.system.transform` 注入链）。真正的缺口只有三处：

1. **没有跨会话记忆的存储与注入**（现有的 `CompactMemory` 是**会话内**压缩摘要，换会话即失）；
2. **技能系统只读**（`SkillManager` 有 load/reload/enable/disable，**没有 save/create**）；
3. **新发现的风险**：注入到 system prompt 的内容**可能被 ACP 折叠** —— 内核与 adapter 都未对
   `role: 'system'` 做特殊处理（grep 无命中），而 `core.session.preModel` 会把 system 消息与普通消息
   一并交给压缩管道 ⇒ 初稿据此推断"可能被压掉"。**已实证推翻**：core 合成的 system 消息
   （走 `core.prompt.system.transform`）**拿不到 `<acp>` ref 标签** ⇒ 模型无从把它圈进压缩范围
   ⇒ ACP 不会压缩它（见 §3.4 的逐条实测）。记忆注入因此是安全的，B1 解除。

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
| 技能注入插件（**最佳范式**） | `core/src/index.ts:2506-2524` | `core.skill-injection`：内部插件 + `core.prompt.system.transform` 注入。记忆注入应照抄此形态 |
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
  挂 `core.prompt.system.transform`：注入 `user MEMORY.md` → `project MEMORY.md` → L0 指令片段。
- **预算**：MEMORY.md **前 200 行或 25KB**（与 Claude Code 一致，实测过的量级）；主题文件不预载，
  靠既有读文件工具按需读取 —— 索引里的"一句话 + 相对路径"就是检索入口。
- **去重与优先级**：project 覆盖 user（与 skills/agents 的覆盖规则一致：后者覆盖前者）。

### 3.4 ✅ 已实证：ACP **不会**压缩我们注入的 system 提示词（原 B1 风险解除）

> 初稿曾推断"可能被折叠"（理由是内核与 adapter 都无 `role === 'system'` 分支）。
> **该推断已被实证推翻** —— 这是本轮最有价值的结论，因为它直接决定了实现方式。

**实证方法**：走真实插件链路（`@harness/acp-context` 的 `core.session.preModel` → `compress` 工具 →
再 preModel），在 system 提示词里放独占标记 `SYSTEM_MEMORY_MARKER_9f3a`，压缩后检查标记是否存活。

**结果**：

| 场景 | system 存活 | 标记存活 |
|---|---|---|
| 正常范围压缩（首尾 ref 之间） | ✅ | ✅ |
| 压缩发生后新一轮 preModel | ✅ | ✅ |

**为什么安全（机制层面，比结论更重要）**：

```
逐条消息的 role → ref：
  system     m0                      ref=（无标签）   ← 我们注入的（core 合成）
  system     acp_system_s_xxx        ref=m00175       ← ACP 自己注入的指令
  user       m1#x                    ref=m00001
  assistant  m2#x                    ref=m00002
```

core 合成的 system 消息（走 `core.prompt.system.transform` ⇒ `_buildStepMessages` 的 `sysParts`）
**拿不到 ref 标签** ⇒ 模型在 `<acp>` 标签里看不到它 ⇒ **根本无法把它圈进压缩范围**。
（ACP 自己那条 `acp_system_*` 有标签，说明"system role"并非天然免疫 —— 免疫来自**不打标签**，
即来自它走的是 core 的 sysParts 通道而非 ACP 的消息列表。这一点要在实现时守住。）

**由此得出的实现约束**：记忆/技能注入**必须**走 `core.prompt.system.transform`（core 的 sysParts），
不要塞进 messages 数组冒充 system —— 后者会被 ACP 纳入消息列表、打上 ref、进而可被折叠。

**剩余注意（不是正确性问题，是成本问题）**：system 不被压缩 ⇒ 它占的窗口**永远不会被回收**。
所以 §3.3 的注入预算（前 200 行 / 25KB）不只是"加载限制"，更是**永久性占用**，必须严格控制；
且它与技能注入、CompactMemory 摘要是**共享** system 空间的（详见 §3.8③）。

**ACP 关闭时同样安全**：此时另有 session compaction（按条数裁剪 `session.messages`），
但 system 消息本就不在 `session.messages` 里（每轮在 AgentRuntime 内动态构建）⇒ 实测确认
压缩前后会话里都没有 system（§3.8）。

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

### 3.7 注入时机与缓存：**攒到下次压缩时再注入**

**用户提出的问题**：记忆/技能生成后若立即改写 system 提示词，会破坏 provider 的前缀缓存
（提示词在最前，任何变化都让其后所有分块失配）—— 能否等下次压缩时再一起注入？

**结论：这个思路成立，而且比"立即注入"更优。** 理由与代价如下。

**① 为什么成立**：压缩本身就会改写消息序列 ⇒ **缓存必然整体失效**。把 system 的变更
"搭车"到那一刻，边际失效成本 ≈ 0；反之，在两次压缩之间插入一次 system 变更，等于
**额外制造一次全量失效**。我们 bench 一直以 `--cacheDiscount=0.04` 作为命中折扣假定
（见 `docs/acp-context-param-table.md`），system 每轮失配的成本按这个折扣的倒数放大，
而 system 通常又占几千~几万 token —— 值得省。

**② 代价（必须配套兜底）**：压缩不是每轮都发生（由 nudge 提示模型自主触发），
所以"等下次压缩"可能等好几轮、甚至整个会话都不发生 ⇒ **记忆迟迟不生效**。

**③ 因此按"写入来源"分级**（这是本节的核心设计）：

| 来源 | 时机 | 理由 |
|---|---|---|
| **显式写入**（`/memory` 命令、用户说"记住 X"） | **立即注入** | 用户有明确预期，正确性优先于缓存成本 |
| **自动沉淀**（模型自发判断值得记） | **pending，攒到下次压缩时 flush** | 无人在等，成本优先 |
| **技能（新建/修改）** | **立即注入** | 技能一旦写成很少变（变更天然低频），且它的作用是"下次用到就注入"，延迟无收益 |
| 兜底 | N 轮未压缩（建议 10 轮）或会话结束前 flush | 防"永远不生效" |

**④ 技术落地（flush 信号必须是双源 —— 单源在 ACP 关闭时会永久挂起）**：

| 场景 | 压缩机制 | flush 信号 |
|---|---|---|
| ACP 开启 | 内核折叠（模型调 `compress` 工具） | `core.tool.post.execute`（`toolId === 'compress'`） |
| **ACP 关闭** | **session compaction**（`compactIfNeeded` / `/compact`） | **`core.session.compacting` hook**（core:952，已实证触发） |

⚠️ 原设计只写了 compress 工具这一源 —— 而 **ACP 关闭时根本没有 compress 工具** ⇒ flush 永不触发
⇒ 记忆只能靠兜底（N 轮）生效。补上 `core.session.compacting` 后两种场景都覆盖。

**⑤ 两个实现细节（否则会出隐性 bug）**：

- **pending 必须落盘**：只放内存的话，重启即丢（用户刚说"记住"的东西静默消失）。建议存
  `<scope>/memory/.pending.json` 或 `session.meta`。
- **注入内容必须是"生效快照"，不是实时读文件**。原因是一个两难：插件每轮读 `MEMORY.md`
  才能感知**外部修改**（人直接编辑了文件），但"读到就注入"会让 system 随时变化 ⇒ 缓存失效。
  解法：每轮照读文件、但与**当前生效快照**比对哈希，**只在 flush 点更新生效快照**。
  这样外部修改会在下次 flush 生效，且 system 内容在两次 flush 之间保持稳定（缓存友好）。

**⑥ `compress` 信号的覆盖面**：无论 nudge 引导的压缩还是模型自主压缩，最终都走同一个 `compress` 工具
⇒ 一个信号即可全覆盖；次选是比对 ACP state 的 blocks 数量变化。（④ 里写的 `core.tool.post.execute` 是
当时的设想，实查后不可用 —— 见 ⑦。）

**⑤ 一个反直觉的点**：把易变内容**移到 system 末尾**没有用 —— 前缀缓存从开头分块匹配，
变化点之后的所有分块（含后续历史消息）依旧全部失配。关键变量是**变更频率**，不是位置。
把易变内容移出 system 塞进 messages 更糟：那会进入 ACP 的视野，**打上 ref、变成可折叠对象**
（§3.4），既丢了"指令"语义又可能被压掉。

**⑦ 落地后的校正（2026-09-19 续 155，M3 做完再回看）**：

- **兜底轮数取 15**（原建议 10）：它的定位是"防静默失效的兜底"而非节流目标（正常发布由压缩触发，
  那时 system 变更免费），只需"大到平时不抢先、小到长时间不压缩时也能生效"。**单位是"轮"**
  （一次「用户输入 → Agent 跑完」），**不是**模型调用 —— 一轮内多步只算 1。
- **flush 信号的真实形态**：ACP 那条**不能用** `core.tool.post.execute`（实查：其 ctx **没有 toolId**），
  改用 `cli.agent.stream` 的 `status.toolId === 'compress'`；`core.session.compacting` 那条不变。
- **`turn_end` 必须由 core 广播**（原设计默认"上层会广播"）：实查发现全仓只有 CLI 会 ——
  内嵌 / ACP 宿主自己消费事件流时，靠它驱动的兜底计数**永不推进**。终态是引擎的事实
  ⇒ 归 core 收口，但**走独立 hook `core.agent.turn.end`**（不是 `cli.agent.stream`：后者是 UI 消费层的
  状态流，引擎往里塞事件会让同一 hook 名由两层分别触发、消费方分不清来源）。
- **只数主会话的轮**：跳过 `mode === 'subagent'`，并比对主会话 sessionId（teammate / coordinator
  另开 session，不过滤会让攒批提前放行）。
- **⚠️ 压缩信号仍只有 UI 通道**：`cli.agent.stream` 的 `status.toolId === 'compress'` 在无 UI 宿主里
  同样收不到，那时只剩"轮数兜底 + 命令写入"。要根治得让引擎层也暴露"工具执行"信号（未做）。
- **参数出口**：`config.json → memory`（`flushAfterTurns` / `maxLines` / `maxBytes` / `disableInjection`），
  启用仍是 `plugins: ["memory"]`。这段配置**错了不会自己报错**，因此非法值一律丢弃 + 启动告警 + 概览打印。
- **⑤ 的"pending 必须落盘"未做**（pending 目前只活在进程内）：重启会丢掉"待发布"状态，但**不丢内容**
  —— 新进程首次注入必定发布最新内容（时机从"等压缩"变成"立即"）。影响面小，等自动沉淀上线再补。

### 3.8 ACP 关闭时的 session compaction 场景（实证）



用户提示"ACP 关闭时的 session compact 也要考虑"。查证 + 实测结论：**记忆注入在两种场景都安全**，
但有两个连带影响必须设计进去。

**① 为什么安全**：`core/src/index.ts:930` 明写"不包含 `role===system` 的消息（它们在 AgentRuntime
内动态构建，不在 `session.messages` 里）"，实测确认：

| 阶段 | session.messages 的 role 种类 | 含 system 吗 |
|---|---|---|
| 压缩前（16 条） | `assistant, user` | ❌ |
| 压缩后（4 条） | `assistant, user` | ❌ |

⇒ session compaction 裁的只是 user/assistant/tool，**碰不到 system**（我们注入的记忆在 system 通道）。
两套压缩机制的对照：

| | ACP（内核折叠） | session compaction |
|---|---|---|
| 作用对象 | 待发消息（含 ACP 自己注入的消息） | `session.messages`（持久化会话） |
| 会碰到 system 注入吗 | ❌（无 ref 标签，见 §3.4） | ❌（system 不在 session.messages 里） |
| 触发频率 | **每轮**（nudge 引导） | **低频**：boot 一次 + `/compact auto` |

**② 连带影响之一：`core.session.compacting` 已实证触发，但很稀疏**。
实测中挂探针插件确认它被调用 1 次（window=12）。它可用作 flush 信号（见 §3.7④），
但**只在 boot 与 `/compact auto` 时触发** ⇒ ACP 关闭时"下次压缩"可能等很久
⇒ **兜底（N 轮 / 会话结束）从"保险"升级为主要路径之一**，M2 实现时不能省。

**③ 连带影响之二：system 预算是三笔共享的**（新约束）。
ACP 关闭时，`appendCompactionMemory` 会把 `CompactMemory.summaryText` 也注入 system
（定义 `core/src/index.ts:1548`，调用点 `:1677`，在 `_buildStepMessages` 里）；ACP 开启时它同样存在。
所以 system 里的常驻内容至少三笔：

```
技能注入（core.skill-injection） + 记忆（本方案，≤200 行/25KB） + CompactMemory 摘要（≤ session.summaryMaxChars）
```

它们**都不参与压缩、占用永不回收**（§3.4）。因此预算要按"总和"设上限，而不是各自为政 ——
建议给 `core.memory-injection` 一个可配的 `maxBytes`，并在超限时**截断低优先级条目**（user 级优先于
project 级？反之？需实测决定）而不是静默丢弃。

### 3.9 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** ✅ | ~~验证 §3.4 的折叠风险~~（已完成，结论：不会被压缩）；~~`WorkspaceLevel.memory` + `loadDirs.memory`~~（已完成） | 目录字段可用（`ws.user.memory` / `ws.project.memory` / `ws.loadDirs.memory`）；记忆暂不注入。顺手修了 `/workspace` 输出里 agents 行漏路径的既有 bug |
| **M1** ✅ | ~~补 G1/G2 通道~~ + ~~加载 L0（`AGENTS.md` 两级）~~ + ~~L1 索引注入~~ + ~~`/memory list\|show\|path`~~（已完成） | ✅ 端到端实测：主 Agent 请求的 system 含 `<memory>` 与索引/指令内容；subagent 不含；空索引不注入；注入量 ≤25KB |
| **M2** ✅ | ~~写入路径 A~~ + ~~`/memory add\|rm\|reload`~~ + ~~体积/去重校验~~（已完成）；**§3.7 分级注入刻意留到 M3**（理由见 dev-log 续 153：mtime 缓存已保证"文件不变则 system 不变"，变更本就低频，而分级注入会让"写入后何时生效"不可预期，宜与 flush 双源一起做） | ✅ 实测：超限被拒且文件未变；去重生效；原子写无残留；`/memory add` 写入 → 下一轮注入读到（端到端） |
| **M3** ✅ | ~~§3.7 分级注入（flush 双源 + 兜底）~~ + ~~L2→L1 沉淀提示（压缩时一次性）~~（已完成）；子代理隔离在 M1 已落地 | ✅ 实测：外部改动默认攒批不立即生效；ACP `compress` / `core.session.compacting` 均触发 flush；提示一次性；命令写入是例外（立即）；攒够 N 轮兜底放行 |
| **M3.1** ✅ | 复审三处（见 §3.7 ⑦）：~~`turn_end` 广播收口到 core~~（原只有 CLI 会发 ⇒ 内嵌/ACP 宿主下兜底静默失效）+ ~~轮数默认 5→15 且只数主会话~~ + ~~`config.json → memory` 参数出口~~ + ~~快照声明/防重复/截断要求清理~~ | ✅ 实测：core 侧广播 3 例（含 subagent 不发、中断路径）；CLI 侧断言 `turn_end` 只出现一次；`config.json → memory` 端到端（`/memory` 打出的即配置值）；非法值被拒并回落默认 |

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
| B1 | ~~ACP 可能折叠 system 注入的记忆~~ | **✅ 已解除** | §3.4 实证：core 合成的 system 无 ref 标签 ⇒ 模型选不中它。**新的成本项**：system 不被压缩 ⇒ 其占用**永不回收**，注入预算（200 行/25KB）是硬约束 |
| B9 | system 变更破坏前缀缓存 | 中 | §3.7：按来源分级注入（显式立即 / 自动攒到下次压缩 / 技能立即）+ 兜底 flush；**flush 必须双源**（ACP 的 compress 工具 + `core.session.compacting`），否则 ACP 关闭时永久挂起 |
| B10 | system 预算三笔共享、互相挤占 | 中 | §3.8③：技能注入 + 记忆 + CompactMemory 摘要都常驻 system 且永不回收 ⇒ 需按总和设上限 + 超限截断策略（不可静默丢弃） |
| B11 | pending 集合的持久化与"生效快照" | 小 | §3.7⑤：pending 只放内存会重启即丢；注入必须用"生效快照"而非实时读文件（否则外部编辑会让 system 每轮抖动、缓存全失效） |
| B2 | `WorkspaceLevel` 需新增 `memory` | 小 | 加字段 + loadDirs；会波及所有 Fake workspace 测试替身 |
| B3 | `SkillManager` 需 `save()` | 小 | 加载器只读，需新增写入 + 路径校验 |
| B4 | 写入的权限通道 | 中 | ask 模式下每次写记忆都弹窗；需决定记忆写入是否豁免 |
| B5 | 注入预算与 token 成本 | 中 | 200 行/25KB 上限；主题文件按需读 |
| B6 | 子代理记忆隔离 | 决策 | 对齐 Claude Code：主会话记忆不注入 subagent |
| B7 | project 记忆是否入 git | 决策 | `.harness` 未被忽略 ⇒ 默认共享；隐私与共享的取舍 |
| B8 | 生成技能的质量/过时 | 长期 | 靠人工确认 + 治理缓解，无银弹 |

**难度评估**：单看代码量都不大（记忆 M0~M2 约 200~300 行 + 测试；技能锻造 F0~F1 约 150~250 行），
真正的成本在 **B4/B6/B7 三个决策（已拍板）** 与 **B9 注入时机（§3.7 的分级设计）**。
原最大的不确定项 B1 **已实证解除**，无前置阻塞。

## 7. 里程碑建议

```
M0（目录字段）──► M1（注入 + /memory read）──► F0/F1（技能写入与锻造）
      │                                                 │
      └──► M2（写入与治理 + §3.7 分级注入）      M3（压缩→记忆；F2/F3 治理与隐式检测）
```

下一步就是 M0 的目录字段（`WorkspaceLevel.memory` + `loadDirs.memory`）—— 它没有依赖，
可以立刻开工；B1 的实测结论已经给出，不需要再等验证。

## 8. 决策（2026-09-19 已拍板）

| # | 议题 | 结论 | 落地影响 |
|---|---|---|---|
| B6 | 子代理记忆隔离 | **不注入 subagent**（对齐 Claude Code） | 注入时需能判断"当前是不是子 Agent" ⇒ 见 §9-B2（需 `agentMode` 通道） |
| B7 | project 记忆是否入 git | **入 git（团队共享）** | `.harness` 本就未被忽略（其内只忽略 `last-session.json`）；需在写入时**显式确认作用域**，避免个人偏好被提交 |
| B4 | 写入是否豁免权限审批 | **豁免** | 记忆/技能写入走插件内 fs，**不经工具权限通道**；但限定目录 + 禁写密钥 |
| — | 首期范围 | 记忆 + 技能锻造一起（分阶段、分提交） | 见 §7；M0 已无前置依赖（B1 实测解除） |
| — | 记忆注入时机 | **显式立即 / 自动攒到下次压缩 / 技能立即**（+ 兜底 flush） | §3.7；省前缀缓存成本，前提是 B1 为假（已实证） |

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
| 重复流程检测 | `cli.agent.stream` hook（2026-09-19 新增） | 统计工具序列即可。⚠️ 该 hook 是 **UI 消费层**的（只有走 CLI 的宿主才触发）⇒ 要做 F3 得先有引擎层的"工具执行"信号，否则内嵌宿主下同样静默失效（同 §3.7 ⑦ 的教训） |
| 注入 system prompt | `core.prompt.system.transform` hook | 范式照抄 `core.skill-injection`（`core/src/index.ts:2506`）；**已实证不会被 ACP 压缩**（§3.4），注入时机见 §3.7 |
| 压缩时提示沉淀（L2→L1） | `core.session.compacting` hook | 已有 |

### 9.B 需要补的通道（core 侧小改，**每处都对所有插件有益**）

| # | 缺口 | 为什么插件绕不过去 | 建议 |
|---|---|---|---|
| ~~G1~~ ✅ | **`PluginContext` / `PromptInput` 都没有 workspace、cwd**（已补：`PluginContext.workspace` + core 注入 + CLI 传实际 workspace） | 注入发生在 **prompt 构建期**，入参只有 `agentId`/`sessionId`（`plugin/src/index.ts:236`）；install 期也拿不到。变通做法是插件自己用 `process.cwd()` + `homedir()` 拼路径 —— 但 CLI 支持 `--cwd`，`process.cwd()` **未必等于** `workspace.cwd` ⇒ 会拼错目录（正是本项目栽过两次的"路径口径分裂"） | `PluginContext` 增 `workspace`（core 一处赋值，约 5 行）；`PromptInput` 增可选 `cwd` |
| ~~G2~~ ✅ | **判断"当前是否子 Agent"无通道**（已补：`PromptInput.agentMode`；端到端验证 subagent 请求不含记忆） | 决策 B6 要求不注入 subagent，但注入 hook 拿不到 agent 定义（`mode`）。变通：`cli.agent.stream` 的 `AgentStatusSnapshot.mode` **能拿到 mode**（刚加的字段），但注入发生在事件之前 ⇒ 首轮无从判断 | `PromptInput` 增 `agentMode`（core 一处，约 5 行） |
| G3 | `CliCommandInput.harness?: unknown` 类型过松 | reload/agent 访问要靠 cast，编译期无保障 | 给 `CliCommandInput` 增明确方法（如 `reloadSkill(id)`），或至少类型化 harness |

### 9.C 关于"记忆被 ACP 折叠"：无需规避（已实证）

初稿曾设计一条"靠 hook 顺序规避"的路径（external 批晚于 internal ⇒ 记忆插件的
`core.session.preModel` 排在 `context.acp` 之后 ⇒ 裁剪完再插入）。实证（§3.4）表明**不需要**：

- core 合成的 system 消息**没有 ref 标签** ⇒ 模型选不中它 ⇒ ACP 不压缩它。
- 因此记忆**就应该**走 `core.prompt.system.transform`，与技能注入同一条路（`core.skill-injection` 范式）。
- ⚠️ 唯一要守住的边界：**不要把记忆塞进 messages 数组冒充 system** —— 那会进入 ACP 消息列表、
  被打上 ref、变成可折叠对象。这正是"顺序规避法"的隐患所在，所以弃用它反而更安全。

（保留一条备查事实：拓扑排序只对**同批**依赖建边（`plugin/src/index.ts:603-607`，跨批跳过），
且 ACP 是可选插件（`compression.enabled` 才装配）。若将来确有插件间顺序需求，别写
`dependsOn: ['context.acp']` 这种可选依赖。）

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
命令侧通道已经齐备（workspace + harness 都注入了），剩下 3 处是"给插件补只读视野"的小改
（G1~G3），不是架构性障碍。

原先挂着的最大不确定项（B1：记忆会不会被 ACP 压掉）**已实证解除**（§3.4），
且结论对插件方案更有利：记忆走 `core.prompt.system.transform` 即可，**不需要**任何顺序技巧。
因此现在没有任何"必须先验证才能动工"的前置项 —— 可以直接从 M0 的目录字段开工。
