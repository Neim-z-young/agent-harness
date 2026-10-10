# Benchmark 跑分框架方案（@harness/bench · M1）

> 方案定稿 2026-10-09。M1 = τ³-bench（retail 域）适配；同批定稿的生成式 UI / 人工决策卡片
> 属 M2-M4，见文末路线图。

## 1. 背景与选型

- 目标：给 harness 引擎与 agent 配置一个可复现、可对比的**外部客观基准**，替代「自建任务集」
  的自说自话。起步选 τ-bench 系（客服域、工具调用 + 环境终态判定、官方任务数据 + judge 全公开）。
- **数据源用 τ³-bench（github.com/sierra-research/tau2-bench）**：原 tau-bench 仓库已弃用且任务
  存在已知 bug；τ³ 是官方维护的现行版本，retail 域任务数据经修复。
- 落地形态：新包 `packages/bench`（`@harness/bench`），**直接 import HarnessHost SDK 进程内驱动**
  —— `harness run` CLI 仅支持单轮一次性执行，无法承载 user simulator 的多轮外层循环；进程内
  SDK 也符合「直接引用功能包」的工程惯例。

## 2. retail 域数据（src/data/retail/）

| 文件 | 内容 | 来源（tau2-bench main） |
|---|---|---|
| `tasks.json` | 114 个任务（含 golden actions、user scenario、evaluation criteria） | `data/retail/domain/tasks.json` |
| `db.json` | 初始环境：50 商品 / 500 用户 / 1000 订单 | `data/retail/domain/database.json` |
| `policy.md` | 客服政策全文（注入 agent system prompt） | `data/retail/domain/policy.md` |
| `split_tasks.json` | train / test 官方切分 | `data/retail/domain/split_tasks.json` |
| `../simulation_guidelines.md` | user simulator 全局指令 | `data/retail/user_simulator_prompt.md` |

任务结构（`TauTask`，见 `src/types.ts`）：`user_scenario.instructions`（模拟客户的任务卡）+
`evaluation_criteria.actions`（golden 工具调用序列）+ `reward_basis`（DB / NL_ASSERTION /
COMMUNICATE_INFO 等）。snake_case 字段与官方 JSON 一一对应，不做改名。

## 3. 三块适配

### 3.1 域 API 工具桥接（src/retail/tools.ts）

- 16 个官方域工具的忠实 TS 翻译（`calculate` / `get_order_details` / `modify_pending_order_items` …），
  `defineTool + fromJsonSchema` 一处声明同时决定模型可见载荷与运行期校验。
- `executeRetailTool(db, name, args)`：**纯函数调度**（DB 引用传入、原地演进），judge 与
  harness 共享同一份实现 —— gold 回放与轨迹回放的数值路径（`round2`、算式求值）必然一致。
- `createRetailPlugin(db)`：`AgentPlugin`，经 `core.tool.pool.assemble` 把 16 个工具注入
  工具池；每任务一个实例（DB 深拷贝隔离）。
- `MUTATES_STATE_TOOLS`：官方 `is_tool(mutates_state=…)` 语义的 7 个写工具集合，judge 只回放
  这些；**官方疑似 bug（`modify_pending_order_items` 循环外 variant 引用）按原样保留**并有注释，
  行为与官方实现对齐（有专门测试钉住）。

### 3.2 user simulator 外层循环（src/user-sim.ts + src/runner.ts）

- `UserSimulator`：官方 `user_simulator.py` 等价。system prompt = simulation guidelines +
  `<scenario>` 任务卡；对话历史 **flip_roles**（agent 文本→`user` 角色，客户发言→`assistant`，
  模型以 assistant 身份扮客户）；retail 客户无工具。
- **独立模型调用**：`provider.complete()` 直调（`buildUserSimProvider` 直接 `new` provider 类，
  不走插件装置 —— 插件的 provider getter 惰性创建，install 前访问会抛错），不进 agent 主循环。
- 终止 token：`###STOP###` / `###TRANSFER###` / `###OUT-OF-SCOPE###`（`detectTermination`）。
- `runTask()` 半双工循环（对齐官方 `Orchestrator.step`）：
  1. 固定初始问候 `Hi! How can I help you today?`
  2. user sim 响应 → 客户消息或终止
  3. `host.send()` 驱动 agent（工具调用在 harness 引擎内完成，`permissionMode: 'allow-all'`）
  4. 每轮从 `session.messages` 提取新增 `ToolCallPart`（judge 回放原料）
  5. 终止：三个 token / `maxTurns`（默认 25）/ agent 空回复（官方 communication error）
- agent 定义 `createRetailAgentDef`：`systemPrompt` **完整覆盖**（官方 AGENT_INSTRUCTION +
  `<policy>` 全文，不带 harness 默认提示词），tools 白名单 16 个，`maxSteps` 默认 30。

### 3.3 judge（src/judge.ts）

- **DB 终态校验**（官方 evaluator 的 DB 维度）：
  - gold 环境 = 初始 DB + 回放 golden actions
  - predicted 环境 = 初始 DB + 回放轨迹中 `MUTATES_STATE_TOOLS` 的调用（`isError` 跳过）
  - `deepEqualWithDiff`（键序无关、undefined≡缺失、NaN 相等、-0≡0）比较终态，返回首个差异路径
- reward（M1）：reward_basis 含 DB 的任务按 dbMatch 得 0/1；**无 reward_basis 的任务视为 DB 校验**。
- **M1 遗留**：NL_ASSERTION / COMMUNICATE_INFO（LLM judge）未实现，进 `skippedBasis`
  （既不惩罚也不奖励），接口已留。

## 4. 指标口径（src/metrics.ts）

- **pass^k（官方）**：任务级「前 k 次采样全部通过」比例，对 k=1..K 逐级计算。
- 自有指标（方案要求叠加）：avgReward（单采样均值，与 pass^1 语义不同）、平均轮数、平均工具
  调用数、平均延迟；成本 = agent tokens（in/out/cacheRead/llmCalls，取自 harness usage）+
  user sim tokens；终止原因分布。
- 落盘：`results.jsonl`（每 run 一行，含完整轨迹）+ `summary.json` + 控制台报表（未通过任务
  前 20 条明细）。

## 5. CLI

```
bun packages/bench/src/cli.ts \
  --provider openai --model gpt-4o \
  --user-provider openai --user-model gpt-4o \
  [--split test|train|all] [--task-ids 0,1,2] [--k 1] \
  [--max-turns 25] [--max-steps 30] [--concurrency 4] [--out ./bench-results] \
  [--api-key ...] [--base-url ...] [--api-path ...]
```

- provider 类型：`openai`（及一切 OpenAI 兼容端点：glm/qwen/deepseek…）/ `anthropic` / `mock`（测试）。
- API key 可走环境变量（provider 插件自行读取）。
- 任务 × 采样展平后并发 worker pool，每任务独立 session 目录（`sessions/task-<id>-s<n>/`）。

## 6. 测试与验证

- `src/retail/tools.test.ts`（15）：真实 db 数据回放、官方 bug 行为保留、非法参数拒绝、
  114 任务 golden 工具名覆盖校验。
- `src/judge.test.ts`（6）：deepEqual 语义 + **全量 114 任务 golden 轨迹自洽总检**（每任务
  gold 回放判分必得 dbMatch=true，证明工具实现与官方任务数据完全对齐）。
- `src/runner.test.ts`（1）：mock 双端端到端 smoke（boot → 工具池注入 → user sim → judge）。
- CLI mock smoke：`--provider mock --user-provider mock --task-ids 0,1` 全链路跑通
  （pass^k 报表 + 落盘）。

## 7. M1 遗留

| 项 | 说明 |
|---|---|
| LLM judge | NL_ASSERTION / COMMUNICATE_INFO 维度（需独立 judge 模型调用，接口 `skippedBasis` 已留） |
| 真实模型基线 | 首次真机跑分记录（建议 `--split test --k 1` 起步，观察终止分布与成本） |
| 跑分面板 | M4（与审计面板同期） |

## 8. M2-M4 路线（同批定稿，摘要）

- **~~M2 生成式 UI 基础~~**：`WidgetPart` 落 session + `ui_widget` 工具通道 + TUI widget 渲染
  （声明式 widget 声明，宿主无关；headless 走 `renderText` 降级）。✅ **完成（2026-10-10，
  续 265）**：`@harness/ui-widget`（注册表 6 组件 + 工具 + 内置插件）+ TUI widget 块 +
  双渲染规避 + provider 降级，cli 429 / ui-widget 14 测试全绿。
- **~~M3 决策卡片~~**：权限确认升级为卡片（参数表格/diff 预览/风险标签/同类操作历史），规则引擎
  只做风险分级，**无 JEV、决策权归人工**，`decision.human` 审计落
  `~/.harness/sessions/{id}.audit.jsonl`。✅ **完成（2026-10-10，续 266）**：
  `assessRisk` 分级器（host）+ decision-card 组件 + TUI 模态升级（setAsker）+ 审计接缝
  （`InteractivePermissionEngine.ask()` 计时/信封 + cli `createAuditSink` 落盘），
  host 24 / cli 433 测试全绿。遗留：A2A / VSCode 宿主的审计落盘接入（host 接缝已就绪）。
- **~~M4 审计面板 + 跑分面板~~**：决策时间线/放行率/responseMs（衡量 UI 辅助效果）；bench 结果
  可视化（pass^k 趋势、成本/延迟对比）。✅ **完成（2026-10-10，续 267）**：`panels.ts` 纯函数
  （审计 `parseAuditLog` + 跑分 `parseBenchHistory`）+ TUI 侧边栏 `audit`/`bench` 两个 tab +
  bench `history.jsonl` 追加（跨多次跑趋势）。M1-M4 全部完成，路线闭环。
