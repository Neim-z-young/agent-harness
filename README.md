# Agent Harness

基于 TypeScript + Bun 的插件化 Agent Harness 框架。

融合 Claude Code（6 层严格解耦 + Tool 运行时协议 + Fail-Closed 安全策略）与 OpenCode（Plugin Hooks 管道 + 类型安全事件总线 + 路径级权限匹配）两者的优点，一切能力皆可插件化。

## 特性亮点

- **运行时协议优于函数接口**：Tool / Agent / Plugin 是完整的生命周期协议对象，不只是 `call()`
- **Fail-Closed 安全优先**：所有扩展点默认关闭，需显式声明能力边界（`isReadOnly` / `isDestructive` / `isConcurrencySafe`）
- **Hooks 管道而非继承**：12+ 个 Hook 点让插件介入生命周期（`core.harness.start` / `core.tool.pre.execute` / `core.prompt.system.transform` / `cli.command` 等）
- **三 transport MCP Client**：stdio / Streamable HTTP / 旧版 HTTP+SSE，自动发现 tools / resources / prompts
- **会话 Compaction**：三级压缩策略（prune / summary / agent）+ 百分比阈值动态触发 + 系统记忆注入
- **流式输出全链路**：Provider `stream()` → AgentRuntime `queryStream()` → CLI REPL 逐 token 打印
- **双轨制 Skill Layer**：Markdown 知识 + 内嵌 Shell，三来源合并（bundled/user/project/mcp）+ paths 条件触发 + Agent 白名单注入
- **Subagent 派遣**：主 Agent 通过 `subagent` 工具派出子 Agent 执行独立任务（隔离 session + 工具白名单 + 递归深度控制 + Bus 实时进度 + 工具调用摘要）
- **多 Provider 支持**：Anthropic Claude / OpenAI / Gemini / 通义 Qwen / GLM / Mock，6 个 Provider 插件
- **多级配置加载**：Agent 与 Skill 均支持 user 级（`~/.harness/*`）+ project 级（`.harness/*`）两级加载，project 覆盖 user
- **零外部运行时依赖**：参数解析、glob 匹配、readline 交互、SSE 解析全部内置实现

## Quick Start

### 前置要求

- [Bun](https://bun.sh/) >= 1.3

### 安装

```bash
git clone git@github.com:Neim-z-young/agent-harness.git
cd agent-harness
bun install
```

### 运行 CLI

```bash
# 交互式 REPL（默认用 Anthropic Claude，需配 API Key）
export ANTHROPIC_API_KEY=sk-ant-xxx
bun run packages/cli/src/index.ts repl

# 使用 OpenAI
export OPENAI_API_KEY=sk-xxx
bun run packages/cli/src/index.ts repl -p openai

# 开发调试：Mock Provider + 允许所有工具权限
bun run packages/cli/src/index.ts repl -p mock --permission allow-all

# 一次性执行
bun run packages/cli/src/index.ts run "读取 package.json 并告诉我项目名" -p mock --permission allow-all
```

### CLI 命令

```
harness [repl|start] [options]        启动交互式 REPL（默认）
harness list-sessions [options]       列出持久化会话
harness resume <sessionId> [options]  恢复指定会话
harness run "<prompt>" [options]      一次性执行 prompt
harness teammate --team <t> --name <n> [options]   以 teammate 身份运行（终端后端 spawn）
harness config                        配置概览（Provider / 模型 / 压缩 概览 + 校验）
harness config set-key <providerId> <apiKey>       加密写入 apiKey（enc:v1 密文）
harness config get-key <providerId>   解密查看 apiKey
harness config check [options]        校验 config.json 并打印概览（等同于 --check-config）
harness help                          显示帮助

选项：
  -c, --cwd <dir>           工作目录
  -a, --agent <id>          默认 Agent ID
  -p, --provider <name>     mock / anthropic / openai
  -s, --session <id>        指定会话 ID
  -d, --data-dir <dir>      持久化目录（默认 ~/.harness）
      --permission <mode>   allow-all / ask（默认 ask）
      --tui                 以 TUI（alt-screen 全屏）模式启动 REPL
      --check-config        校验配置并打印概览后退出
  -v, --verbose             调试日志
```

> `harness config check` / `--check-config` 会做**配置形状校验**：写错键、写错取值、层级写错都会被指出来
> （例如把 `preserveRecentTokens` 写成单数、把 `tokenCalibration` 写成 `'chars/4'`）。这些错误在默认情况下
> **完全无声**——未知键会被 `defaultConfig` 静默丢弃，写错取值会降级到默认值，而概览照常显示正常。
> 详见 [上下文压缩配置](docs/acp-context-config.md) §10。校验属告警级别，不影响退出码（只有 Provider 错误才返回 1）。

### REPL 内斜杠命令

内置命令（`/help` 列出全部，其余命令由插件注册）：

```
/help               显示所有可用命令
/exit  /quit        退出 REPL
/sessions           列出持久化会话
/new                新建会话
/resume <id>        恢复指定会话
/switch <id>        切换到另一会话
/model [spec]       查看 / 切换模型（如 /model openai/gpt-4o）
/config             查看 config.json 配置概览
/save               保存当前会话
/compact [prune|summary|agent|auto]  压缩当前会话历史
/plugins            插件管理（list / enable / disable / reload）
/skills             技能管理（list / enable / disable / reload）
/stats  /stats-export  用量统计
/permission         权限交互模式与规则（permissions.json）
/history            查看输入历史
/tree [path]        打印磁盘文件树（对话引用过的文件带 *）
/edit <file[:line]> 挂起 TUI 前台打开外部编辑器（编辑后回读）
```

### TUI 文件引用与编辑

TUI（`harness repl --tui` 或 `startTuiRepl`）会在对话过程中**自动收集 `path[:line]` 形式的文件引用**，展示在侧栏「文件」标签：

- **Tab** 进入文件引用导航；**↑/↓** 移动选中；**Enter** 用本机编辑器前台打开该文件（解析 `path:line:column`）；**Esc** 返回输入框；**Tab** 切到会话列表。
- **`/edit <file[:line]>`**：挂起 TUI，前台打开外部编辑器，退出后回读文件末尾若干行注入会话，方便把编辑结果交还给 LLM。路径支持 `~` 展开与相对 `cwd`。编辑器优先级：`$EDITOR` / `$VISUAL` → `vim`/`nvim`/`nano`（不采用 macOS `open`，因其异步打开会与 alt-screen 冲突）。
- **`/tree [path]`**：扫描磁盘打印真实目录树；对话中出现过的文件以 `*` 标记。默认排除 `.git`/`node_modules`/`.DS_Store`，限制 3 层深、最多 100 项（超出标注「截断」）。无参默认 `cwd`，也支持 `~` 与相对路径。
- **`/history`**：查看输入历史。

> 完整交互式目录树（多根浏览 / 展开折叠）计划在图形页面实现；TUI 以 `/tree` 命令轻量呈现。

### 运行测试

```bash
bun test                    # 全部测试
bun run typecheck           # 全部类型检查
```

## Configuration（config.json）

配置通过两级 `config.json` 加载：user 级 `~/.harness/config.json` 与 project 级 `.harness/config.json`，**project 级覆盖 user 级**。数据目录由 `--data-dir` 指定（默认 `~/.harness`），承载 `config.json` / `permissions.json` / `sessions/` / `.config-key` / 快照数据。

**配置来源优先级**：CLI 参数 > config.json > 环境变量。例如 `--provider` / `--model` 会覆盖 config.json 的同名项。

### config.json 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | 默认 Agent ID（缺省 `default`） |
| `provider` | string | 默认 Provider id（`anthropic` / `openai` / `gemini` / 自定义） |
| `model` | string | 默认模型 ID；可写 `openai/gpt-4o` 跨 Provider 指定 |
| `anthropicApiKey` | string | Anthropic API Key（命令行快捷配置） |
| `providers` | ProviderConfig[] | 自定义 Provider 定义（见下） |
| `agents` | AgentOverride[] | 按 id 覆盖 Agent 的工具白名单 / MCP server 白名单 |
| `mcpServers` | McpServerEntry[] | 托管的外部 MCP server（支持运行时 `/mcp` 启停，写回本字段） |
| `plugins` | string[] | 声明式启用**内置插件**（如 `["code-intel","subagent","coordinator"]`），依赖按 `dependsOn` 自动补齐；**无需写 `.harness/plugins/*.ts`** |
| `allowPluginCode` | boolean | 是否**执行** `.harness/plugins/*.ts\|js\|mjs` 的插件代码（默认 **false**，防代码注入）。开闸后也不会补任何 `node_modules` 软链 |
| `allowPluginCode` | boolean | 是否加载 `.harness/plugins/*.ts` 里的**插件代码**（默认 **false**，防代码注入）。绝大多数场景用上面那行即可，不需要开 |
| `snapshot` | boolean | 开启文件快照 + `/revert`（缺省 false）；`--snapshot` 优先 |
| `harness.snapshot` | boolean | 顶层 `snapshot` 的兼容嵌套写法 |
| `sandbox` | object | 隔离与沙箱策略（**当前是策略级，不是 OS 级**），见下节 |
| `compression` | object | 上下文压缩（ACP）配置，见下节 |

### compression 对象（上下文压缩 ACP）

启用内置的上下文压缩能力。完整字段说明见 [docs/acp-context-config.md](docs/acp-context-config.md)，参数速查见 [docs/acp-context-param-table.md](docs/acp-context-param-table.md)。

```json
{
  "compression": {
    "enabled": true,
    "autoTune": true,
    "tokenCalibration": "auto"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 是否启用（缺省 false） |
| `autoTune` | boolean | **按上下文窗口自动推导**保护 tokens / 增长阈值 / 最小压缩区间（缺省 **false**）。开启后无需手写下面那些参数 |
| `tokenCalibration` | `'auto'` \| `'chars4'` | token 折算口径。`auto`（默认）为 CJK 感知——中日韩按 1 字 1 token，与内核 `defaultCountTokens` 同口径；`chars4` 为旧的 `chars/4` 回退 |
| `modelContextLimit` | number | 手动指定上下文窗口；缺省取默认 Provider 的 `contextWindowTokens`，再兜底 200000 |
| `preserveRecentTokens` | number | 保护区 tokens（推荐交给 autoTune） |

**三个容易踩的点**：

1. **`autoTune` 默认关闭**，不写就按内核默认值跑；推荐显式开启让参数随窗口自适应。
2. **窗口并非写死的 200000**：实际取 `modelContextLimit` → 默认 Provider 的 `contextWindowTokens` → 200000 三级回退。若 Provider 声明了较小的窗口（如 `102400`）却手写大 `preserveRecentTokens`，会直接吃掉半个窗口导致严重超窗——**小窗口请交给 autoTune 推导**。
3. **写错键完全无声**：未知键被静默丢弃、写错取值降级到默认值，而概览照常显示正常。调参前后请跑 `harness config check`。

### Agentic Loop（引擎内自主多步执行）

Agent 执行**已支持引擎内自主多步**：模型调用工具后，工具结果会自动回喂并触发下一步推理，
直到模型不再要求工具调用、被判定为死循环、被中断，或触及步数上限。

- **步数上限**：默认 `30`。优先级 `AgentQueryInput.maxSteps` > `AgentDefinition.maxSteps` > 默认；`-1` 表示不限。
  传 `maxSteps: 1` 即**显式单轮**（与旧行为一致，旧调用方常用）。
  **子 Agent 更保守**：subagent 派出的子 Agent 默认 `10` 步（聚焦执行，且步数越多越容易撞上
  subagent 的 120s 超时）；个别子 Agent 需要长链时在自己的 `AgentDefinition` 里写 `maxSteps` 覆盖。
- **续轮判据**：本步**有工具调用** 且 `finish` 不是 `length`/`content_filter`/`error`。
  注意 `finish` 与「有工具调用」并不互斥（Gemini 返回 `functionCall` 时 `finishReason` 仍是 `STOP`），
  故不能只看 `finish`。
- **死循环保护**：同一工具 + 完全相同的入参连续 3 次 ⇒ 在执行前拦下并走权限确认；
  拒绝则标 `DOOM_LOOP` 错误并终止。
- **步数到顶**：追加一条收尾提示再跑一步，而不是硬截断。
- **中断**：Ctrl-C（REPL SIGINT / TUI Ctrl-C）在**执行中 = 中断本次查询**、空闲 = 退出；
  已完成的步骤成果保留，未执行的工具标 `ABORTED`。
- **流式事件**：`done` 是「**一步**结束」（带 `step`，多步时会出现多次），
  `turn_end` 才是「**整轮**结束」（只出现一次）。UI 收尾应挂在 `turn_end` 上。

#### Agent 状态显示

多步执行后「现在跑到哪一步、在跑哪个工具」成了最想知道的信息，故把事件流归约成状态并显示：

| 位置 | 形态 |
|---|---|
| TUI 状态栏 | `● openai | agent=coordinator(编排) | model=… | 工具·bash·3步`（忙时显示状态，**并隐藏快捷键提示**让出宽度——状态栏整行需 ≤80 列） |
| REPL 统计行 | `⏱️ 812ms | agent=default · 第2步 · 结束=stop | model=…`（每轮结束打印） |

状态取值：`空闲` / `推理`（reasoning）/ `输出`（text）/ `工具·<名>` / `已中断`。
推导逻辑在 `packages/cli/src/agent-status.ts`（纯函数，可单测），UI 只负责渲染；
中断态不会被 `turn_end` 冲掉，异常路径也能收到 `turn_end` 从而回到空闲（不会一直显示忙）。

改动过程与阶段记录见 [Agentic Loop 改造计划](docs/agentic-loop-plan.md)（S0~S4 已完成）。

### compaction 对象（会话压缩，与 ACP 是两套机制）

`/compact` 命令与 REPL 启动时的自动判定走的是**会话压缩**：按消息条数把旧会话裁掉、留一段摘要。它和上面的 ACP 互不相干——ACP 按 token 分级折叠、**每轮**自动跑、摘要可解压回溯；会话压缩只在 REPL 启动与 `/compact` 时判定一次，且**丢弃原文**。

```json
{
  "compaction": {
    "strategy": "summary",
    "keepRecentMessages": 10,
    "summaryMaxChars": 8000,
    "autoCompactThresholdPct": 80,
    "reservedTokens": 30000
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `strategy` | `'prune'` \| `'summary'` \| `'agent'` | `'summary'` | `prune` 只截断不留摘要；`agent` 调 LLM 生成摘要（失败自动回退 `summary`） |
| `keepRecentMessages` | number | 10 | 压缩后保留的最近消息数（user+assistant 算一对） |
| `summaryMaxChars` | number | 8000 | 摘要最大字符数（仅 `summary` / `agent`） |
| `autoCompactThresholdPct` | number | 80 | 触发阈值：估算 token 占「可用窗口 = 窗口 − `reservedTokens`」的百分比 |
| `reservedTokens` | number | 30000 | 给摘要生成预留的 tokens |
| `contextWindowTokens` | number | 按 Provider 推导 | 本段专用覆盖，一般不填 |
| `tokenCalibration` | `'auto'` \| `'chars4'` | `'auto'` | token 折算口径，与 `compression.tokenCalibration` 同义；**必须两边一致**，否则 ACP 判定已超窗、会话层却说远未到阈值 |

**窗口不在本段硬填**：按 `compaction.contextWindowTokens → compression.modelContextLimit → 本会话实际端点（Provider / 模型）的窗口 → 默认 Provider 的 contextWindowTokens → 200000` 推导。**窗口跟着会话走**：会话内用 `/model` 切到别的模型后，阈值按新端点的窗口重算（`/stats` 与本会话/各子会话的占用率也各用各自的窗口）—— 否则小窗口会话的阈值会落在真实窗口之外，自动压缩永远不触发且没有任何报错。

**最隐蔽的一个坑：阈值 ≥ 窗口**。自动压缩的触发线是 `(窗口 − reservedTokens) × pct%`，一旦算出的阈值高于窗口本身，无论会话多长都不会触发，而且**没有任何报错**（`/compact auto` 只会回一句"未达阈值"）。常见成因是给了一个大 `reservedTokens` 或过高的 `pct`。`harness config check` 与 `/config` 会显式检查这一条并告警。

### plugins 数组（内置插件声明式启用）

不想写插件代码时，用一行配置开内置能力（依赖自动补齐、安装顺序由 core 拓扑排序保证）：

```json
{
  "plugins": ["code-intel", "computer-use", "subagent", "coordinator"]
}
```

- 已登记的内置插件 id：

  | id | 能力 | 依赖 |
  | --- | --- | --- |
  | `mcp.server-registry` | MCP Server 注册表（进程内/外部 MCP server 的宿主）+ `/mcp` 命令 | — |
  | `code-intel` | 代码情报 MCP server（`mcp__code-intel__*`） | `mcp.server-registry` |
  | `computer-use` | 电脑控制 MCP server（`mcp__computer-use__*`） | `mcp.server-registry` |
  | `subagent` | 子 Agent 派工：`subagent` 工具 + `/subagents` 命令 | — |
  | `coordinator` | 主 Agent 编排：四阶段派工 + barrier 续轮 + `send_message` | `subagent` |
  | `swarm` | 长期在线团队协作：Team / Mailbox / Task List 工具 | — |
  | `herdr` | 把 Agent 状态上报到 [Herdr](https://herdr.dev) 侧栏（working / idle / blocked） | — |
  | `memory` | 长期记忆：加载两级 `MEMORY.md` 索引 + `AGENTS.md` 项目指令并注入 system prompt（子 Agent 不注入） | — |

- **Herdr 集成**：Herdr 是 agent 感知的终端复用器（tmux 竞品），侧栏能显示每个 pane 在跑/空闲/等你批准。
  本插件在 Herdr pane 内自动生效（靠 `HERDR_ENV=1` + `HERDR_PANE_ID` / `HERDR_BIN_PATH` 判定），
  **不在 Herdr 里跑时全程 no-op**（零进程、零开销），所以 `"plugins": ["herdr"]` 可以常驻声明。
  状态映射：`thinking`/`streaming`/`tool` → `working`，`idle`/`aborted` → `idle`，
  权限审批弹窗（决策为 `ask`）→ `blocked`（带工具名），进程退出时 `release-agent`。

- **长期记忆**：`"plugins": ["memory"]` 后，每轮把下列文件注入 system prompt（**都不存在时不注入、零噪声**）：

  | 层 | 路径 | 上限 |
  | --- | --- | --- |
  | 项目指令 | `<cwd>/AGENTS.md`（项目级）+ `<dataDir>/AGENTS.md`（用户级） | 32KB |
  | 用户长期记忆 | `~/.harness/memory/MEMORY.md` | 前 200 行 / 25KB |
  | 项目长期记忆 | `<cwd>/.harness/memory/MEMORY.md`（**入 git，团队共享**） | 同上 |

  - 主题文件（`memory/*.md` 除索引外）**不预加载**，由模型按需用 `read` 工具读取 —— 索引里
    写"一句话 + 相对路径"即可（这是控制注入量的关键）。
  - **子 Agent 不注入**（隔离语义）。注入内容只依赖文件内容：文件不变 ⇒ system 逐字不变
    ⇒ **不破坏前缀缓存**。

  **命令**（`/memory`）：

  | 命令 | 作用 |
  | --- | --- |
  | `/memory` | 列出条目（带序号）、各文件状态与剩余额度 |
  | `/memory add [user\|project] <内容>` | 追加一条；**默认 user 级**（项目级会随 git 共享，须显式指定） |
  | `/memory rm [user\|project] <序号\|内容>` | 删除一条 |
  | `/memory show <user\|project\|instruction>` | 查看完整内容 |
  | `/memory path` · `/memory reload` | 查看路径 · 清缓存强制重读（外部改过文件后可用） |

  **写入硬规则**（覆盖 `/memory add|rm` 命令路径）：超限**直接拒绝且不落盘**（避免"写了却读不到"的静默失效）；
  重复条目（空白归一化后相同）跳过；写入是原子的（临时文件 + rename）。条目统一写成 `- 内容` 一行
  —— 细节请写进主题文件，索引里只留一句话 + 相对路径。

  **模型侧写入**：模型用既有 `write` / `edit` 工具直接改 `MEMORY.md`（走常规权限审批），
  格式同样是 `- 一行`。⚠️ **这条路径不经过上面的硬规则**（去重/超限拒绝只在命令路径生效）——
  索引超限时由注入片段显式要求模型"先用 `read` 读全文，合并或删除冗余后再写"作为兜底。

  **注入的是快照**：刚写入的内容可能要到发布时刻才出现在 system 里（文件本身**立即**生效），
  所以片段里明确告诉模型"怀疑过期就直接 `read` 那个文件"——避免它误判"我写了却没生效"而重写。

  **注入时机（分级，省前缀缓存）**：

  | 变更来源 | 何时进 system |
  | --- | --- |
  | `/memory add\|rm`（显式） | **立即**（用户有预期） |
  | 模型 `write`/`edit`、外部编辑文件 | **攒到下次压缩**（ACP 的 `compress` 或 session compaction）；或攒够 15 轮兜底放行 |

  压缩本身已让缓存整体失效 ⇒ 把 system 变更"搭车"到那一刻，边际成本≈0。每次压缩后还会附一条
  **一次性提示**，邀请模型把值得长期保留的纠正/结论写进记忆（不需要就不写）。

  > 一轮 = 一次「用户输入 → Agent 跑完」，**不是**一次模型调用（一轮内多步只算一轮）。
  > 计数由 core 在整轮结束时广播的 **`core.agent.turn.end`**（引擎层 hook：任何宿主都有，含内嵌 / ACP）
  > 驱动，只认主会话、且跳过子 Agent。UI 状态流是另一条 hook（`cli.agent.stream`），两者刻意不混。

  **参数配置**（`config.json`，`memory` 段；启用仍看 `plugins` 里有没有 `"memory"`）：

  | 键 | 默认 | 说明 |
  | --- | --- | --- |
  | `flushAfterTurns` | `15` | 文件变更攒批轮数；`0` = 立即生效（压缩发生则提前发布） |
  | `maxLines` | `200` | 索引注入行数上限（超出部分**不会被加载**） |
  | `maxBytes` | `25600` | 索引注入字节上限 |
  | `disableInjection` | `false` | 只留 `/memory` 命令、完全不注入（对照实验用） |

  键名拼错 / 数值类型不对**不会报错但也不生效**，所以启动时会对未知键与非法值告警，
  `harness config check`（配置概览）也会打印最终生效的参数。

  未做部分（自动沉淀的隐式触发、技能锻造 F0~F3）见
  [记忆能力与技能锻造计划](docs/memory-and-skill-forge-plan.md)。

- 依赖**不必显式写出**；外部 MCP server 也可零代码启用：`plugins: ["mcp.server-registry"]` + `mcpServers: [...]`。
- **这些插件一律「登记但不自动装配」**（`optIn`）：不写进 `plugins` 就不会被装上，也不会在 `/tools` 里
  以「仅元信息」现身——避免把「没装」误读成「可用」。
- 声明式装配的实例**一律无参**：子 Agent 定义以 AgentRuntime 注册表（md frontmatter）为准，
  `coordinator` 的 `forceAsync` 走环境变量 `HARNESS_FORCE_ASYNC`。需要带参装配（自定义 `subagents` 数组等）
  请改用外部插件目录 `.harness/plugins/*.ts`，并同时开 `allowPluginCode`（见 `.harness/plugins/README.md`）。
- 未登记的 id 只告警不阻断启动；`harness config check` 会报为配置错误。
- 与外部插件目录（`.harness/plugins`）**按 id 去重**，外部插件优先，两者可并存。
- **安全**：外部插件目录里的 `.ts/.js/.mjs` 默认**不执行**（只登记并提示），需 `allowPluginCode: true`
  或 `--allow-plugin-code` 才加载 —— 否则克隆一个带 `.harness/plugins` 的仓库、在该目录跑一次
  harness 就会执行他人代码。开闸后也**不会**为插件目录创建指向 harness 内核的 `node_modules` 软链。

### providers 数组

每个 Provider 定义（`ProviderConfig`）：

| 字段 | 说明 |
|------|------|
| `id` | 唯一 ID，运行时 `provider/model` 前缀据此分发（`anthropic` / `openai` / `deepseek` / `ollama`…） |
| `type` | Provider 类型：内置 `anthropic` / `openai` / `gemini` / `glm` / `qwen` / `mock`；可经插件扩展自定义 |
| `baseUrl` | API 根路径（如 `https://api.deepseek.com` / `http://localhost:11434`） |
| `apiKey` | API Key（支持三种格式，见下） |
| `model` | 该 Provider 默认模型 |
| `apiPath` | OpenAI 类型专用：API 路径（默认 `/v1/chat/completions`；智谱等可改 `/chat/completions`） |
| `maxTokens` | `max_tokens` 默认值 |
| `timeoutMs` | 请求超时（ms） |
| `thinking` | OpenAI 系思考模式开关（DeepSeek / GLM 等）：请求体注入 `thinking: {type}`，取值 `enabled` / `disabled`；缺省不发送（DeepSeek 默认启用，标准 OpenAI 不认识该参数） |
| `reasoningEffort` | 思考力度：请求体注入 `reasoning_effort`（DeepSeek 接受 `minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`）；缺省不发送 |

`thinking` / `reasoningEffort` 仅 openai 系 Provider（含 `glm` / `qwen`，它们复用同一实现）消费；
也可按 Agent 覆盖：Agent 定义的 `model.options.reasoningEffort` / `model.options.thinking` 优先于 Provider 配置。
官方回传规则（DeepSeek Thinking Mode）：**请求带 `tools` 时，后续所有请求必须完整回传历史各轮的
`reasoning_content`，否则 400**——引擎已自适应处理（缺失时自动补发并按模型记忆）。

`apiKey` 支持三种格式：

- **明文**：`"apiKey": "sk-xxx"`
- **环境变量引用**：`"apiKey": "${OPENAI_API_KEY}"`（缺失时启动报 `ConfigValidationError`）
- **AES-256-GCM 密文**：`"apiKey": "enc:v1:<base64>…"`（主密钥来源：`HARNESS_CONFIG_KEY` 环境变量 > `<data-dir>/.config-key`）

`/model ?` 会列出这些配置的 Provider 实例及其默认模型（如 `deepseek/deepseek-chat`，附 `baseUrl` / `type`）；`/model <spec>` 跨 Provider 切换（如 `/model local/qwen2.5`）。

### agents 数组

按 `id` 覆盖对应 Agent 的工具与 MCP 能力（由 `/tools` 等插件持久化）：

```json
"agents": [
  { "id": "coder", "tools": ["*"], "mcpServers": ["gh"], "excludeMcpServers": [] }
]
```

- `tools`：工具白名单，指定数组则收窄缺省的 `["*"]`
- `mcpServers` / `excludeMcpServers`：Agent 级 MCP server 白名单 / 黑名单，白名单优先；缺省（undefined）= MCP 全可见，`[]` = 拒绝全部 MCP

### mcpServers 数组

从 config.json 以 JSON 形式托管外部 MCP server（`McpServerEntry` = `McpServerConfig` + 两级启停开关）：

```json
"mcpServers": [
  { "name": "fs", "transport": "stdio", "command": "npx", "args": ["-y", "server-fs", "/tmp"], "enabled": true },
  { "name": "remote", "transport": "http", "url": "https://mcp.example.com/sse",
    "auth": { "bearerToken": "xxx" }, "enabled": true, "tools": { "read_file": true } }
]
```

- transport：`stdio` / `sse` / `http`。缺省时按字段推断：有 `command` → stdio，有 `url` → http。
- stdio：`command` / `args` / `env`；http/sse：`url` + `auth`。
- `auth`：`bearerToken` / `authorizationHeader` / `headers` / `oauth`（OAuth2 PKCE，token 加密存 `dataDir/oauth-tokens.json`）。
- `enabled`：服务器级开关（缺省 true）；`tools`：工具级开关（key=基础工具名，value=false 停用）。
- 经 `/mcp` 命令可即时启停并写回本字段；工具的启停统一走 `/tools` 命令。

### sandbox 对象（隔离策略）

> ⚠️ **默认隔离是「策略级」（L0/L1），不是 OS 级** —— 文件系统边界由**路径判定 + 命令白名单 +
> env 过滤**构成；出网是**静态门**（按命令名与参数字面量判定），不是内核边界。
> 详细盘点与缺口清单见 `docs/sandbox-isolation-plan.md`。
>
> **L2 已可开**：`osBinding: "on"` 会把 bash / MCP 子进程包进平台原语
> （macOS `/usr/bin/sandbox-exec`、Linux `bwrap`），可写区被 OS **真的**限制在
> 工作目录（+ 临时目录）内 —— 这是唯一能挡住 **symlink 逃逸 / TOCTOU** 的一层。
> 默认 `off` 的理由：它会改变命令的执行形态，必须由人显式开；拿不到原语时
> **不模拟**（发 `sandbox.binding-unavailable` 告警，`fsBound` 如实报 false）。
>
> **L3（容器 / microVM / 远程 executor）仍未接线**。需要"跑什么也伤不到宿主"的强保证时，
> 用 `osBinding: "on"` + `level: "L2"` + `onUnmet: "refuse"`（达不到就拒绝启动）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `dangerousDetection` | boolean \| string[] | 危险命令检测。命中即拒绝，**权限卡的「允许」不覆盖它**；默认表不可整表关闭 |
| `rootDir` | string | 沙箱根（缺省为工作目录）；命令的 `cwd` 不得逃出它 |
| `sanitizeEnv` / `keepEnv` | boolean / string[] | env 隔离：默认过滤敏感变量，`keepEnv` 追加保留项 |
| `allowlist` | string[] | 命令白名单（匹配首命令名或完整片段）；为空 = 不启用 |
| `fallbackToHost` | boolean | 白名单外 / 沙箱内失败时回退宿主 bash |
| `requireHostApproval` | boolean | 回退前要人工确认（默认 true）。回退属**档位下沉**，会落 `sandbox.escalation` 审计 |
| `limits` | object | 资源上限：`cpuSeconds` / `maxFileSizeKb` / `maxProcesses` / `memoryKb`（`0` = 不限制、`false` = 全关） |
| `net` | string | 出网策略：`open`（默认）/ `allowlist` / `deny` |
| `netAllow` | string[] | `allowlist` 模式的目标白名单（父域覆盖子域；元数据/私有地址**即使写进来也硬拒**） |
| `readDeny` | object \| false | 读侧敏感文件清单（`.env` / `id_rsa*` / `*.pem` / `.ssh/**` …）；`false` = 关闭 |
| `readMaxBytes` | number | `read_file` 单文件上限（默认 10 MiB，`0` = 不限制）。超限**拒绝**而非截断 |
| `osBinding` | string | **OS 级绑定**（L2）：`off`（默认）/ `on`。开了才把子进程包进 `sandbox-exec` / `bwrap` |
| `pluginCodeScan` | string | 插件代码静态扫描：`warn`（默认）/ `refuse` / `off`。⚠️ **是预警不是边界**（正则挡不住刻意绕过） |
| `level` | string | 要求的隔离档位下限：`L0` ~ `L3` |
| `onUnmet` | string | 达不到 `level` 时：`warn`（默认，发 notice）/ `refuse`（拒绝启动） |

档位口径：**L0** 策略层（危险表 + 白名单 + 权限引擎 + 审计）→ **L1** 进程层（+ 资源上限 +
超时杀进程树 + env 默认拒绝）→ **L2** OS 级绑定（`osBinding: "on"`）→ **L3** 平台层（容器 / microVM，**未接线**）。
`BashOutput.isolation` 会如实回**本次执行**的档位与 `fsBound`（宿主回退 / 无原语 / 自检失败都是 false）。

`mcpServers[]` 还有一个**能力声明**（P1-7）：`capabilities: { fs: "cwd" | "unrestricted", net: "none" | "unrestricted" }`。
`fs: "cwd"` 在 `osBinding: "on"` 时是**真强制**（子进程也套同一份绑定）；`net: "none"` 目前**任何档位都强制不了**
（静态门管不到别人的子进程）—— 声明了但强制不了的项会在启动时发 `config.mcp-inactive` 告警。

### permissions.json

`<data-dir>/permissions.json`：权限规则持久化，由 `/permission` 命令维护：

```json
{ "rules": { "*": "ask", "bash": "deny" } }
```

交互模式（`allow-all` / `ask` / `deny-all`）通过 `--permission` 或 `/permission` 切换。

## Skill Configuration

Skill 是双轨制设计：Skill = 知识（Markdown 正文）+ Tool = 功能（代码执行）。Skill 通过 `agent.skills` 白名单注入到 Agent 的 system prompt。

### SKILL.md 格式

支持两种目录形式：
- **目录形式（Claude Code 风格）**：`.harness/skills/<skill-name>/SKILL.md`
- **单文件形式**：`.harness/skills/<skill-name>.md`

SKILL.md 文件使用 frontmatter + Markdown body：

```markdown
---
name: git-workflow
description: Git 工作流技能
paths:
  - "**/*.ts"
  - "**/*.tsx"
allowedTools:
  - bash
  - read_file
model: claude-sonnet
effort: medium
---

# Git 工作流

当用户要求提交代码时，遵循以下步骤：
1. 检查 git status
2. 运行测试
3. 提交代码
```

### frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 显示名（缺省取目录/文件名） |
| `description` | string | AI 何时使用的触发说明 |
| `paths` | string[] | glob 匹配：修改这些文件时自动注入上下文 |
| `userInvocable` | boolean | `/skill-name` 命令是否对用户可见（缺省 true） |
| `agentBind` | string[] | 仅这些 Agent 可用（不填则所有 Agent 可用） |
| `allowedTools` | string[] | 加载后额外放开哪些工具 |
| `model` | string | 绑定特定模型（不填则跟随 Agent） |
| `effort` | 'low'/'medium'/'high' | 任务预估（给 coordinator 参考） |
| `allowEmbedShell` | boolean | 是否允许内嵌 Shell 执行（MCP 来源强制 false） |

### 多级加载

CLI 默认从两个目录加载 Skill（project 覆盖 user）：

```
~/.harness/skills/         # user 全局（个人配置）
.harness/skills/           # project 项目级（团队共享，git 提交）
```

同 ID 的 Skill，project 级覆盖 user 级。

### 内嵌资源

Skill body 支持内嵌资源：
- `` !`command` `` → Shell 命令（受 `allowEmbedShell` 控制，MCP 来源强制禁用防 RCE）
- `{{variable}}` → 变量替换

### 在 Agent 中绑定 Skill

在 Agent 定义（[Agent Configuration](#agent-configuration)）的 frontmatter 中声明 `skills` 字段：

```markdown
---
id: coder
name: Coder
mode: primary
tools: ['*']
skills:
  - git-workflow
  - code-review
---
```

## Agent Configuration

Agent 通过 Markdown 配置文件定义，支持多级加载（user 级 + project 级）。

### Agent 配置文件

`.harness/agents/<agent-id>.md` 格式：

```markdown
---
id: coder
name: Coder
description: 通用代码 Agent
icon: 💻
tags: [code, dev]
mode: primary
tools: ['*']
skills:
  - git-workflow
subagents:
  - reviewer
  - tester
permission:
  "*": ask
  agent:
    deny:
      - "admin-*"
model:
  providerId: anthropic
  modelId: claude-sonnet-4
  temperature: 0.5
---

你是一名资深的代码工程师，专注于 TypeScript / Bun 开发。

## 工作规范
1. 修改前必先阅读相关文件
2. 提交前运行测试
3. 遵循现有代码风格
```

### Agent 角色模式（mode）

| mode | 说明 |
|------|------|
| `primary` | 主 Agent，可直接对用户 |
| `subagent` | 只能被主 Agent 调用（独立 worker，见 [Subagent](#subagent)） |
| `coordinator` | 调度器（不自己写代码，专派工） |
| `teammate` | Swarm 协作成员（带 inbox/task list） |

### 多级加载

CLI 默认从两个目录加载 Agent（project 覆盖 user）：

```
~/.harness/agents/         # user 全局（个人配置）
.harness/agents/          # project 项目级（团队共享，git 提交）
```

同 ID 的 Agent，project 级覆盖 user 级。

## Subagent

Subagent 插件让主 Agent 通过 `subagent` 工具派出子 Agent 执行独立任务，子 Agent 用独立 session 隔离上下文，有独立工具白名单和权限配置。

### 启用 Subagent 插件

```typescript
import { createSubagentPlugin } from '@harness/subagent'

const subagentPlugin = createSubagentPlugin({
  subagents: [
    {
      id: 'reviewer',
      name: 'Reviewer',
      description: '代码审查专家',
      mode: 'subagent',
      tools: ['read_file', 'grep_file', 'glob'],
      permission: { '*': 'allow' },
      promptFragments: ['你是一名严格的代码审查专家，重点检查：1. 安全漏洞 2. 性能问题 3. 代码风格'],
    },
  ],
  timeoutMs: 120_000,
  maxResultLength: 2000,
  maxResultLines: 500,
  directive: '请结构化输出审查结论，包含：问题列表 + 严重等级 + 修复建议',
})
```

### 配置文件加载 Subagent

也可以通过 `.harness/agents/reviewer.md` 配置文件定义子 Agent（`mode: subagent`）：

```markdown
---
id: reviewer
name: Reviewer
description: 代码审查专家
mode: subagent
tools: ['read_file', 'grep_file', 'glob']
permission:
  "*": allow
---
你是一名严格的代码审查专家...
```

CLI 默认会从 `.harness/agents/` 和 `~/.harness/agents/` 加载所有 Agent 定义。

### 主 Agent 调用 Subagent

主 Agent 配置 `subagents` 白名单后，LLM 可通过 `subagent` 工具调用：

```markdown
---
id: coordinator
name: Coordinator
mode: coordinator
tools: ['*']
subagents:
  - reviewer
  - tester
---
```

`subagent` 工具参数：
- `agentId`：子 Agent ID（必填）
- `prompt`：派给子 Agent 的任务描述（必填）
- `description`：可选，作为子 session 标题
- `model`：可选，覆盖子 Agent 模型
- `sessionId`：可选，续接已有子 session

### 权限过滤

基于 `caller.permission` 自动过滤可用子 Agent：
- `permission.agent = 'deny'` → 拒绝所有子 Agent
- `permission.agent.deny = ['admin-*']` → glob 拒绝特定 Agent
- 无 `agent` 键 → 全部放行

`/subagents` CLI 命令只列出权限允许的子 Agent。

### 工具调用摘要

子 Agent 回复过长时自动生成摘要（参考 Claude Code `agentSummary.ts` + OpenCode `truncation.ts`）：
- 双阈值触发：`maxResultLines`（行数，缺省 500）和 `maxResultLength`（字符，缺省 2000）
- head+tail 保留策略：摘要包含首行和末行
- 智能提示：父 Agent 有 `read_file`/`grep_file` 时提示用工具继续探索；有 `subagent` 工具时提示委派 explore agent
- directive 注入：可注入结构化输出指令到子 Agent 的 prompt 前面

### Bus 实时进度

子 Agent 执行过程中通过 Bus 发布进度事件：
- `subagent.started`：开始（含 prompt 预览、isContinuation 标记）
- `subagent.completed`：成功完成（含 reply 预览）
- `subagent.failed`：失败（含 error、stage）

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   CLI / SDK / IDE / Worker                │  入口层
├──────────────────────────────────────────────────────────┤
│                   @harness/cli (REPL)                     │
│   REPL · 会话持久化 · 权限交互 · 斜杠命令 · 流式打印        │
├──────────────────────────────────────────────────────────┤
│                   @harness/core                           │  核心层
│   Harness · AgentRuntime · SessionManager                │
│   ToolPool · PermissionEngine · ChatProvider             │
│   Compaction · Title/Search/Export · Skill 注入           │
├──────────┬──────────┬──────────┬────────────────────────┤
│ @harness/ │ @harness/│ @harness/│ @harness/              │  基础层
│   bus     │   tool   │  plugin  │  session · agent       │
│ 事件总线  │ 工具协议 │ 插件管理  │  permission · skill    │
├──────────┴──────────┴──────────┴────────────────────────┤
│                        Plugins                            │  插件层
│  provider-mock · provider-anthropic · provider-openai     │
│  provider-gemini · provider-qwen · provider-glm          │
│  tools-builtin (4 原语) · tools-search · tools-glob       │
│  tools-web · tools-media · mcp-client · subagent         │
└──────────────────────────────────────────────────────────┘
```

## Packages

### 核心与基础层

| Package | Description |
|---------|-------------|
| [`@harness/bus`](packages/bus/src/index.ts) | 类型安全 Pub/Sub 事件总线 |
| [`@harness/tool`](packages/tool/src/index.ts) | Tool 运行时协议 + 注册中心 + 执行流水线（Fail-Closed） |
| [`@harness/plugin`](packages/plugin/src/index.ts) | 插件管理（三级加载 + 拓扑排序 + Hook 管道 + `cli.commands`/`cli.command` 扩展） |
| [`@harness/core`](packages/core/src/index.ts) | Harness 编排器 + AgentRuntime + SessionManager + Compaction |
| [`@harness/cli`](packages/cli/src/index.ts) | 命令行入口（REPL + 会话持久化 + 权限交互 + 流式输出） |

### 领域层

| Package | Description |
|---------|-------------|
| [`@harness/session`](packages/session/src/index.ts) | 会话模型 + 持久化 + CompactionMeta/Memory schema |
| [`@harness/agent`](packages/agent/src/index.ts) | Agent 协议（promptFragments + 工具白名单 + 权限配置） |
| [`@harness/permission`](packages/permission/src/index.ts) | 权限引擎（4 级路径匹配 + 规则记忆） |
| [`@harness/skill`](packages/skill/src/index.ts) | Skill 协议（Markdown 技能 + paths 条件触发） |

### Provider 插件

| Package | Description |
|---------|-------------|
| [`@harness/provider-mock`](packages/plugins/provider-mock/src/index.ts) | Mock LLM Provider（测试用，complete + stream） |
| [`@harness/provider-anthropic`](packages/plugins/provider-anthropic/src/index.ts) | Anthropic Claude Messages API（complete + stream） |
| [`@harness/provider-openai`](packages/plugins/provider-openai/src/index.ts) | OpenAI Chat Completions API（complete + stream，apiPath 可配置） |
| [`@harness/provider-gemini`](packages/plugins/provider-gemini/src/index.ts) | Google Gemini API（独立实现，支持系统消息/角色映射/工具调用/图片） |
| [`@harness/provider-qwen`](packages/plugins/provider-qwen/src/index.ts) | 阿里通义 Qwen API（复用 OpenAIChatProvider，兼容 OpenAI 协议） |
| [`@harness/provider-glm`](packages/plugins/provider-glm/src/index.ts) | 智谱 GLM API（复用 OpenAIChatProvider，兼容 OpenAI 协议） |

### 协作插件

| Package | Description |
|---------|-------------|
| [`@harness/subagent`](packages/plugins/subagent/src/index.ts) | Subagent 插件——主 Agent 派出子 Agent（隔离 session + 工具白名单 + 递归控制 + Bus 进度 + 摘要） |

### 工具插件

| Package | Tools | Description |
|---------|-------|-------------|
| [`@harness/tools-builtin`](packages/plugins/tools-builtin/src/index.ts) | `read_file` / `write_file` / `edit_file` / `bash` | 4 个原语工具（文件 I/O + Shell） |
| [`@harness/tools-search`](packages/plugins/tools-search/src/index.ts) | `list_dir` / `grep_file` | 搜索导航类 |
| [`@harness/tools-glob`](packages/plugins/tools-glob/src/index.ts) | `glob` | 多模式通配符匹配 |
| [`@harness/tools-web`](packages/plugins/tools-web/src/index.ts) | `web_fetch` | HTTP(S) 抓取 + SSRF 防护 |
| [`@harness/tools-media`](packages/plugins/tools-media/src/index.ts) | `view_image` | 图片 base64 + 尺寸解析 |

### 协议插件

| Package | Description |
|---------|-------------|
| [`@harness/mcp-client`](packages/plugins/mcp-client/src/index.ts) | MCP Client（stdio + HTTP/SSE transport + resources/prompts 发现 + Bearer 鉴权） |

## Key Design Decisions

| 决策 | 选型 | 理由 |
|------|------|------|
| 技术栈 | TypeScript + Bun | 原生 TS、零配置、fast test |
| 包结构 | Monorepo (`packages/*`) | 模块边界清晰，可独立发布 |
| 工具默认并发安全 | 否（Fail-Closed） | 新工具默认有风险，需显式声明 |
| 扩展机制 | Hooks 管道 | 12+ 个 Hook 点，插件介入生命周期 |
| 插件加载顺序 | Internal → Builtin → User + 拓扑排序 | 保证覆盖关系明确 |
| 权限匹配 | 精确路径 → glob → 工具级 → 全局 | 4 级匹配 + 规则记忆 |
| 会话压缩 | 百分比阈值 + 三级策略 | 适配不同上下文窗口模型（含 1M 模型） |
| MCP transport | 三态抽象（stdio/http/sse） | 统一接口，按配置选择 |
| Skill 双轨制 | 知识（Markdown）+ Tool（功能） | 分离关注点，知识声明式、功能可执行 |
| Skill 多来源 | bundled/user/project/mcp | 同 ID 后加载覆盖先加载；MCP 来源强制禁用 shell embed |
| Subagent 隔离 | 独立 session + 工具白名单 + 递归控制 | 子 Agent 上下文独立，主 Agent 通过 prompt 通信 |
| 多级配置加载 | user（~/.harness）+ project（.harness） | 个人配置 + 团队共享，project 覆盖 user |
| 外部依赖 | 零 | 参数解析 / glob / readline / SSE 解析全部内置 |

## Plugin Development

### 工具插件示例

```typescript
import { defineTool } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

// 自包含 helper
function resolvePath(input: string, cwd: string): string { /* ... */ }

// 定义工具（Fail-Closed 安全声明）
const myTool = defineTool({
  id: 'my_tool',
  description: 'A custom tool',
  isReadOnly: () => true,          // 显式声明只读
  isConcurrencySafe: () => true,   // 显式声明并发安全
  isDestructive: () => false,      // 默认 false，破坏性操作需显式 true
  inputSchema: makeSchema(),       // zod / 自定义 Schema
  permission: { key: 'read', extractPatterns: (input) => [input.path] },
  async call(input, ctx) {
    const path = resolvePath(input.path, ctx.cwd)
    return { ok: true, output: { path } }
  },
})

// 插件工厂
export function createMyPlugin(): AgentPlugin {
  return {
    id: 'my.plugin',
    version: '1.0.0',
    name: 'My Plugin',
    async install(ctx) {
      ctx.log.info('My plugin loaded')
      return {
        // 通过 Hook 注入工具到 ToolRegistry
        'core.tool.pool.assemble'(_input, pool) {
          ;(pool as { add: (t: unknown) => void }).add(myTool)
        },
        // 注册 CLI 斜杠命令
        'cli.commands'(input) {
          input.commands.push({ command: 'my', description: 'My plugin command' })
        },
        async 'cli.command'(input) {
          if (input.command !== 'my') return
          input.out('Hello from my plugin!\n')
          input.result = 'continue'
        },
      } as Hooks
    },
  }
}
```

### MCP Client 插件示例

```typescript
import { createMcpClientPlugin } from '@harness/mcp-client'

const mcpPlugin = createMcpClientPlugin({
  servers: [
    // stdio transport
    { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    // Streamable HTTP transport（MCP 2025-03-26）
    { name: 'remote', transport: 'http', url: 'https://mcp.example.com/sse', auth: { bearerToken: 'xxx' } },
  ],
  // 可选：把所有资源 text 注入到 system prompt
  autoInjectResources: 'all',
})
```

## Documentation

- [架构设计文档](docs/agent-harness-architecture.md) — 设计理念、总体架构、核心模块详解（含 §16 Agentic Loop 已落地形态）、实现路径
- [开发日志](docs/development-log.md) — 每日开发进度、遇到的问题与修复、下一步计划
- [MCP 服务](docs/mcp-services.md) — MCP server 注册方法、配置字段、命令用法、运行机制与凭据安全
- [工作区管理](docs/workspace-management.md) — 两级工作区目录、config/permissions/sessions 数据布局
- [代码情报插件](docs/codeintel-plugin.md) — CodeIntel 插件规划与实现说明

上下文压缩（ACP）系列：

- [ACP 配置参考](docs/acp-context-config.md) — 全部配置字段、推导公式、窗口选择、校验规则与排障
- [ACP 参数速查表](docs/acp-context-param-table.md) — 200K / 300K / 1M 最优参数表与偏离代价实测
- [ACP 压测报告](docs/acp-context-benchmark.md) — 不同上下文长度下的压缩比与敏感性问题
- [上下文压缩改造计划](docs/context-compression-plan.md) — 阶段划分与里程碑

Agent 执行链路：

- [Agentic Loop 改造计划](docs/agentic-loop-plan.md) — 三方（Claude Code / Opencode / 本项目）循环机制对比、阻塞点清单、S0~S4 分阶段实施方案
- [记忆能力与技能锻造计划](docs/memory-and-skill-forge-plan.md) — 跨会话记忆三层模型（项目指令 / 长期记忆 / 会话压缩记忆）、自动把重复流程固化为 SKILL.md，含阻塞点与待决策

## Tech Stack

- **Runtime**: Bun >= 1.3
- **Language**: TypeScript
- **Architecture**: Monorepo (packages/)
- **Dependencies**: Zero external runtime deps

## License

Private
