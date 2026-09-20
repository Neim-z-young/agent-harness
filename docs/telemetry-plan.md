# Agent Harness 遥测（Telemetry）方案

> 状态：方案稿（v0.1）· 第 1 步已落地（`@harness/telemetry` 建包 + bus→envelope→本地 writer + cli 装配，见 `docs/development-log.md` 续 167）
> 适用范围：本仓库（XiaoZhi-new / agent-harness）的 CLI 与 core 宿主
> 设计原则：**本地采集为主 + 可选 OTLP 上报**；插件化实现，不侵入 core/CLI 主逻辑；默认零隐私负担，用户可控。

---

## 1. 背景与目标

当前项目已有一套**局部、定制化**的遥测：`@harness/acp-context` 插件把每轮 preModel / compress / providerCache 事件写入
`dataDir/sessions/{sessionId}.telemetry.jsonl`（见 `packages/plugins/acp-context/src/telemetry.ts`）。它解决了 ACP 压缩
效果分析，但：

- 职责耦合在单个业务插件里，其他宿主 / 其他插件无从复用。
- 只有「写本地 JSONL」一条通路，没有统一事件模型、没有批处理/队列、没有可选的 OTLP 上报适配。
- 事件类型靠各插件自造，命名与维度不统一，难以做跨会话 / 跨参数聚合（现有 bench 脚本是事后手工 merge）。

本方案希望把这些能力下沉为**通用遥测设施**，同时：
- 复用现有 `@harness/bus` 的类型安全事件总线作为采集接入点（已大量使用 `harness.initialized` / `harness.started` / `tool.enabled` 等事件）。
- 对齐 Claude Code 的匿名会话级遥测属性、OpenCode 的 OTLP 出口，设计成**本地优先、远程可选**。

### 与其他方案的关系
- `docs/acp-context-config.md` / `docs/acp-context-benchmark.md`：ACP 压缩参数与效果的工程分析（维持现状，仅通过本遥测统一接入点收敛到同一事件总线）。
- 远期 Console/服务端（OpenCode 的 `console + stats` 思路）：不在本方案范围，仅预留上报协议兼容性。

---

## 2. 参考对象

| 维度 | Anthropic Claude Code | Vercel OpenCode | 本项目取舍 |
| --- | --- | --- | --- |
| 采集方式 | 会话内收集用户 ID + session ID + OAuth/org 属性，作为 OTEL attributes（`telemetryAttributes.ts`） | `packages/core/src/observability/otlp.ts`：effect/OpenTelemetry，`OtlpLogger` + OTLP trace/log 导出，endpoint 由 flag/env 控制（`OTEL_EXPORTER_OTLP_ENDPOINT` 等） | 复用 bus 事件既成事实；统一事件模型 |
| 出口 | 常闭可关（设置项 / `DISABLE_TELEMETRY` 类环境变量） | OTLP `v1/logs`、`v1/traces`，endpoint 为空即不加载任何 exporter | 默认只写本地；OTLP 需显式配置 endpoint 才开启 |
| 维度 | user.id、session.id、app.version、organization 等（带配额裁剪开关） | serviceName/serviceVersion/runID、channel/instance | 以 sessionId 为第一聚合键，绝不含代码正文 |
| 幂等/批处理 | — | BatchSpanProcessor | debounce 批量写盘 + 失败静默（沿用现有 `createWriter` 思路） |

参考目录：
- `reference/claude-code-analysis-main/src/utils/telemetryAttributes.ts`
- `reference/opencode-dev/packages/core/src/observability/otlp.ts`

---

## 3. 架构分层

遥测作为**独立插件** `@harness/telemetry`（`packages/plugins/telemetry`），不上耦合进 core/CLI：

```
[bus 事件] ──► @harness/telemetry ──► 本地 JSONL（默认）
                 │                   └─► OTLP (可选，配置 endpoint 后追加)
                 └─► 提供 API：记录结构化事件（供插件直接调用，扩展 bus 事件覆盖不到的点）
```

- **采集接入**：优先订阅 `core.bus` 既有事件（`harness.*` / `tool.*` / `mcp.*` / `plugin.*` 等），缺料处由业务插件经遥测插件公开的 `telemetry.record()` 补充。
- **转换**：bus 事件（带 `source`、时间戳）→ 标准化遥测事件（统一 envelope：`{ts, kind, sessionId, metrics, attrs}`）。
- **输出**：全量写本地 JSONL；若配置 `telemetry.otlp.endpoint`，异步导出到 OTLP logs（不改本地行为）。

### 分发包与依赖方向
遵循仓库 `bus → tool → plugin → core → cli/插件包` 顺序：
- `@harness/telemetry` 只依赖 `@harness/bus`（事件定义）与标准库；不依赖 core，插件化可装卸（enable / disable / reload）。
- core 只暴露能力：`harness.bus.publish(...)`、`harness.plugin.listHooks(...)`、dataDir 注入；业务插件如需记录非总线事件，通过 cli 注入遥测 writer / 路径（沿用 ACP 的 `telemetryPathBuilder` 注入模式）。

---

## 4. 事件模型（统一 Envelope）

所有遥测事件统一包一层 envelope，便于聚合与迁移：

```ts
interface TelemetryEvent<TName extends string, M extends Record<string, unknown>> {
  schema: 1
  kind: TName              // 事件名，snake_case，如 "hard.request", "tool.call", "session.end"
  ts: number               // epoch ms（bus 事件自带 timestamp 可直接透传）
  sessionId: string
  round?: number           // 会话内轮次（有则填）
  attrs: Partial<{         // 低基数标签，供分组/剪裁
    provider: string
    model: string
    agentId?: string
    pluginId?: string
    toolId?: string
    source: string         // 事件来源（CLI/core/plugin）
  }>
  metrics: M               // 数值指标
}
```

**命名规范**：沿用仓库「事件走 `core.bus` 发布订阅」的语义，遥测 `kind` 用点分层，如需与 hook 分界清晰则统一前缀 `telemetry.`（如
`telemetry.request`、`telemetry.tool.call`）。**绝不把正文、代码、提示词、工具输出写入 attrs**——只记录长度/token 计数等标量。

### 建议最小事件集（初版）
| kind | 来源 | 关键 metrics |
| --- | --- | --- |
| `telemetry.session.start` / `session.end` | `harness.initialized` / `stopped` | durationMs、turns、totalTokens、toolCalls |
| `telemetry.request` | core 每轮模型调用 | round、inputTokens、outputTokens、cacheRead、cacheWrite、latencyMs、firstTokenMs |
| `telemetry.tool.call` | `tool` 执行完成 | toolId、ok、durationMs、exitCode、(permission=allow/ask/deny) |
| `telemetry.error` | `harness.error` / 运行期异常 | stage、(errName) |
| `telemetry.plugin` | `plugin.loaded` 等 | id、action |
| `telemetry.acp.*` | ACP 压缩插件（迁移现有 3 类） | 沿用 `telemetry.ts` 的 preModel/compress/providerCache 字段 |
| `telemetry.request.fail` | 模型/Provider 调用失败 | round、provider、model、errName、retries |
| `telemetry.tool.fail` | 工具执行失败 | toolId、code、exitCode、interrupted |
| `telemetry.permission.deny` | `ToolPermissionDeniedError`（`err.name` 判定） | toolId、mode |
| `telemetry.doomloop` | `DOOM_LOOP` 硬中断（不挂权限 hook） | code=DOOM_LOOP、toolId/stepSig |
| `telemetry.crash` | 进程信号/未捕获异常 | signal(exit/abort/timeout)、lastRound、lastKind |

初版事件集 = 现有 `HarnessEvents` + `LifecycleEvents` 的映射 + ACP 迁移，**无需新增埋点即可上线**；后续按需补 `request`/`tool.call`。

---

## 5. 本地存储

沿用现有 `createWriter` 思路（`packages/plugins/acp-context/src/telemetry.ts` L138-167），提升为通用模块：
- 路径：`dataDir/sessions/{sessionId}.telemetry.jsonl`（会话维度，与现有 ACP 文件同目录，可并行；或用 `dataDir/telemetry/{date}.jsonl` 统一聚合，二选一，建议会话维度优先满足「还原单会话行为」）。
- 写入：纯 append，JSONL 每行一个完整 envelope；debounce（如 500ms）批量 flush；异常吞掉，绝不影响主流程。
- 退出：`session.end`/进程退出前 `flush()`；注意信号退出（SIGTERM/SIGHUP）需单独挂监听，不能只靠 `process.once('exit')`（仓库已知教训）。
- 幂等：`sessionId` 天然去重键；重复写入同一会话事件靠 `ts`+`kind`+`round` 可判别。

---

## 6. 可选 OTLP 上报（对齐 OpenCode）

默认**闭**：未配置 endpoint 时，只写本地，零网络、零隐私顾虑。配置后追加导出，本地行为不变。

- 出口：OpenTelemetry `v1/logs`（初版只做 logs，不做 traces，控制工程量）。
- 实现取向：借鉴 `opencode-dev/.../otlp.ts`——启动时读 endpoint，为空则返回空数组/空 layer，**不加载任何 exporter**（冷路径零成本）。

> 说明：OTLP 一上来可能引入重依赖（`@opentelemetry/sdk-*`）。初版可先做**最小 HTTP BatchLogRecordExporter 直连**，避免把整套 OpenTelemetry SDK 拉进 CLI 启动路径；待需要 traces 时再引入 SDK。此点需在实施前用「真机为准」原则实测确认网络出口与序列化格式。

---

## 7. 配置项

并入 `config.json` 顶层 `telemetry`（由 cli 转发给插件，沿用现有 config 校验/注入模式）：

```jsonc
{
  "telemetry": {
    "enabled": true,              // 总开关；关闭后 0 开销（不订阅/不写盘）
    "store": {
      "directory": "sessions",    // dataDir 下子目录；"sessions"=会话级，自定义=统一级
      "debounceMs": 500
    },
    "otlp": {
      "enabled": false,           // 需显式开启
      "endpoint": "",             // 如 https://collector.example.com:4318
      "headers": {}               // API key 等
    },
    "exclude": {                   // 低基数裁剪：不采集某些 attrs（兼容量化）/kind
      "attrs": ["pluginId"],
      "kinds": []
    }
  }
}
```

- 优先级：`CLI 参数 > config.json > 环境变量`（沿仓库既有约定；同时支持 `OTEL_EXPORTER_OTLP_ENDPOINT` 之类的 env 无关变量由 cli 读取合入）。
- 未知键沿用 cli 现有 `collectUnknown` 校验，给出 `telemetry.xxx` 警告。

---

## 8. 隐私与安全

沿用 Claude Code / OpenCode 的匿名化思路 + 本项目「库内只存标量」红线：

1. **绝不记录**：代码正文、提示词、命令输出、消息内容、API key。所有字段只允许标量指标与低基数标签（个人无风险）。
2. **匿名 id**：会话维度用现有 `sessionId`；如需跨会话用户级聚合，用持久化匿名 user id（参考 `telemetryAttributes.user.id`，可采用 `~/.harness/.config-key` 派生，避免明文身份）。
3. **默认关远程**：OTLP 必须显式开启；本地 JSONL 也仅账号/机器范围的私有文件，不进 git。
4. **可关闭**：`telemetry.enabled:false`（或对应 CLI/env 开关）彻底关闭，含订阅卸载与写盘 no-op。
5. **可审计**：默认文件头部写一条 `schema`/生成版本元数据，便于事后核对采集矩阵。

---

## 9. 异常场景遥测监控（专项）

目标：异常/失败/崩溃是可观测的，**能在本地 JSONL 单独检索、必要时聚合预警**，而不只靠日志 grep。

### 9.1 采集点与脱敏
| 异常类别 | 触发来源（仓库已有判据） | 记录字段（脱敏） |
| --- | --- | --- |
| 引擎/生命周期失败 | `harness.error`（stage init/start/stop/runtime） | stage、errName |
| 权限拒绝 | 工具结果 `err.name === 'ToolPermissionDeniedError'`（`core/index.ts:353`） | toolId、code=PERMISSION_DENIED |
| 死循环硬中断 | `DOOM_LOOP`（`DOOM_LOOP_THRESHOLD=3`，`core/index.ts:1539/2137/2164`，**不挂权限 hook**） | code=DOOM_LOOP、toolId、stepSig |
| 工具执行失败 | `safeExecuteTool` 归一化失败 `ToolResult`（`core/index.ts:352-356`，`ok:false`） | toolId、code(TOOL_ERROR/PERMISSION_DENIED)、exitCode、interrupted |
| 请求中断/超时 | `AbortError` / `TimeoutError`（`core/index.ts:1523`） | kind、round、provider |
| Provider 未返回 | `query() 未产生 assistant 消息`（`core/index.ts:1680`） | provider、round |
| 进程崩溃 | `uncaughtException`/`unhandledRejection`/信号退出 | signal、lastRound、lastKind |

脱敏红线统一：只记标量 + `errName`/`code`，错误 `message` 截断（如 ≤256 字符）、排**堆栈中涉及代码正文的行**；正文内容一律不落盘。

### 9.2 崩溃兜底（最难、最有价值的点）
顺序保证「崩溃也能留下现场」：
1. 常驻状态：会话运行时在内存维护 `lastKnown = { round, kind }`，每次成功事件后刷新。
2. 常规退出：`session.end` + 进程 `exit` 前 `flush()`。
3. 信号退出：`SIGTERM`/`SIGHUP` 单独挂监听（仓库已知教训：`process.once('exit')` 覆盖不到信号退出），写一条 `telemetry.crash { signal, lastRound, lastKind }` 再退出；不抢 `SIGINT`（REPL/TUI 用它表示"中断当前查询"）。
4. `uncaughtException`/`unhandledRejection`：构造异常事件 + 截断堆栈哈希（`stackHash`）落盘，便于去重、不泄露代码。

### 9.3 可检索与可告警
- 会话卷内可按 `kind in (telemetry.*.fail / doomloop / crash / permission.deny)` 快速过滤出「异常会话」。
- 预留聚合口径（供 bench/分析脚本，如现有 `analysis-params.ts` 模式）：失败率 = 失败轮次 / 总轮次；DOOM_LOOP 次数；按 stage 分桶的错误占比；崩溃会话数。
- 若开 OTLP：异常事件标 `severity=error`，便于远端埋点/告警接入。

### 9.4 可行性结论
现有核心判据（权限名、DOOM_LOOP 标记、`harness.error`、AbortError/TimeoutError、进程信号）都已在代码里暴露，**做成异常场景遥测仅需在遥测插件侧做订阅与转换，不改 core 判定逻辑**；崩溃兜底唯一新增点是 cli 侧的信号/未捕获监听与内存 lastKnown。→ 可实现，且成本集中在崩溃兜底一小块。

---

## 10. 实施路径

按插件化 + 「先用既有事件跑通、再补埋点」的节奏：

1. **建包** `packages/plugins/telemetry`：core bus 事件 → envelope 转换 + 本地 JSONL writer（复用 `createWriter`，提升为通用模块并加单测 `index.test.ts`），映射 `HarnessEvents` + `LifecycleEvents`。
2. **注册接入**：`core.harness.init` hook 里订阅 `harness.bus`；cli 在启动阶段装配 `telemetry` 插件并注入 dataDir 路径（包类型注册进 cli，`id` 由 `providerId`/插件 id 派生避免同型多实例冲突）。
3. **ACP 迁移**：`acp-context` 撤掉自研 writer，改为 `telemetry.record('telemetry.acp.preModel', ...)`，保持现有 `{sessionId}.telemetry.jsonl` 输出兼容 bench 脚本。
4. **补充埋点（可选）**：core 增加 `telemetry.request` / `telemetry.tool.call` 构造，但不改 core 逻辑——由 core 发布新 bus 事件，遥测插件订阅；或由各插件自行调用 `telemetry.record()`。
5. **异常遥测（专项）**：实现第 9 节——遥测插件订阅异常判据（权限名 / DOOM_LOOP / `harness.error` / AbortError/TimeoutError），cli 加信号/未捕获监听与内存 `lastKnown`，`telemetry.crash` 兜底落盘。
6. **OTLP（可选二期）**：endpoint 非空时追加最小直连 batch log exporter（不引整套 OpenTelemetry SDK），静态开启时按 `docs/mcp-services.md` 方式真机实测确认网络出口与序列化格式。
7. **配置 + 文档**：config `telemetry` 校验、开关语义；`docs/telemetry-plan.md` 与 `docs/development-log.md` 更新。

---

## 11. 已确认决策（用户定夺）

| 项 | 决策 |
| --- | --- |
| 存储目录 | 会话级：`dataDir/sessions/{sessionId}.telemetry.jsonl`（兼容现状与 bench；ACP 迁移后同路径但统一 envelope） |
| OTLP 初版 | 最小直连 batch log exporter，不引入整套 OpenTelemetry SDK |
| 跨会话身份 | 需要：持久化匿名 user id（由 `dataDir/.config-key` 派生，非明文身份），用于跨会话聚合 |

跨会话匿名 id 实现要点：沿用 Claude Code 的 `getOrCreateUserID` 思路，首次生成 `~/.harness/.config-key` 派生一个 128-bit 随机 hash 存 `telemetry/user.id`，进程间复用；与 sessionId 一起作为 `session.start/end` 的 attrs，使本地/OTLP 均可按 user 聚合。**仅此一个非会话级标识**，其余全走 sessionId。