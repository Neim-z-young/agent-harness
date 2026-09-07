# Agent 级 MCP 配置能力

## Context（背景）

当前 Agent 对 MCP 工具只有「逐工具」粒度控制：MCP 工具经 `tool.pool.assemble` 进入工具池后，只能放在 `AgentDefinition.tools` 白名单里逐个列 `mcp__<server>__<tool>`（精确匹配）。agent 无法按 **MCP server 粒度** 声明「哪些 server 可用/禁用」，与 Claude Code subagent 的 `mcpServers` frontmatter、opencode 的 per-agent 工具限制相比能力不足。

目标：让每个 Agent 在**声明式配置**（`.harness/agents/*.md` frontmatter 或 `config.json` 的 `agents[]`）里声明 MCP server 白名单/黑名单，core 在装配工具时按 server 粒度过滤模型可见/可调用工具。**不改** **`/tools`、`/mcp`** **命令语法**，工具级启停仍走 `/tools`。

### 已确认决策

1. **语义**：`AgentDefinition` 新增可选字段 `mcpServers?: string[]`（白名单）与 `excludeMcpServers?: string[]`（黑名单），**白名单优先于黑名单**。
2. **承载**：仅声明式，不改命令。写入 agent 定义（`.md` frontmatter 或 `config.json` 的 `agents[]`）。
3. **继承**：独立判定，无父子继承。
4. **缺省兼容**：两者均 `undefined` → MCP 全可见（与现状一致）；`mcpServers: []` 含义为 **拒绝全部 MCP**，与 `undefined` 刻意区分。

## 现状依据（已复核）

- `AgentDefinition`：`packages/agent/src/index.ts:L88-132`，`tools: string[] | ['*']`（L128）。

- 过滤链路：`packages/core/src/index.ts` `query` \~L1189 与 `_prepareQuery` \~L1349，两处均为 `toolRegistry.filterByWhitelist(agent.tools)`。

- `ToolRegistry.filterByWhitelist`：`packages/tool/src/index.ts:L475-485`，`['*']`→全部，否则精确匹配 id/alias。

- MCP 命名 `mcp__<server>__<tool>`：server 取首个 `__` 之前（mcp-server-registry L284、tools-manager `parseMcpTool` L50-56）。

- config 合并：`packages/cli/src/index.ts` `applyConfigAgentTools` L960-968（仅合并 tools）；`setAgentTools` L974-985（整条覆盖为 `{id, tools}`，会丢 mcp 字段）。

- frontmatter 解析：`agentFromMarkdown`（agent L374-444）目前 `tools` 只支持内联数组/块级列表/字面量 `'*'`，**不支持裸逗号字符串**，新字段需显式处理带逗号写法。

## 改动清单

### 1. `packages/tool/src/index.ts` — 过滤原语（新导出）

新增两个纯函数（可单测、可被 core 与插件复用，收敛 mcp 前缀解析约定）：

```ts
export function parseMcpToolId(id: string): { server: string; tool: string } | undefined
// 取 mcp__ 之后、首个 __ 之前为 server；非 mcp__ 或无 __ 返回 undefined

export function filterMcpTools(
  tools: Tool[], mcpServers?: string[], excludeMcpServers?: string[],
): Tool[]
```

`filterMcpTools` 算法：

- 两者均 undefined → 原样返回（MCP 全可见）。

- `mcpServers !== undefined`（白名单模式）：仅保留 `parseMcpToolId(t).server` 属于白名单的工具；空数组=拒绝全部 MCP。

- 否则（黑名单模式）：剔除 server ∈ excludeMcpServers 的工具。

- 非 MCP 工具（parseMcpToolId 返回 undefined）始终不受影响。

- 白名单模式忽略黑名单；server 名 trim 后匹配。

（可选低风险重构：tools-manager `parseMcpTool` 与 mcp-server-registry L284 改为 import `parseMcpToolId`，收敛重复。）

### 2. `packages/agent/src/index.ts` — 字段模型 + frontmatter 解析

- `AgentDefinition` 在 `tools`（L128）后追加两个可选字段（含上述缺省/空数组语义注释）。

- `agentFromMarkdown` 增加通用小工具 `parseStringArr(raw)`：支持内联数组、块级列表、**裸逗号字符串**（split `,` + trim + 过滤空），返回 `string[] | undefined`。

- 解析 `frontmatter.mcpServers` / `frontmatter.excludeMcpServers`，条件赋给 `def`（`if (x) def.x = x`）。

### 3. `packages/core/src/index.ts` — 装配过滤接入

两处（`query` \~L1189、`_prepareQuery` \~L1349）共用同一 helper，作为 `filterByWhitelist` 之后的第二阶段收窄：

```ts
const allowedTools = filterMcpTools(
  this.deps.toolRegistry.filterByWhitelist(agent.tools),
  agent.mcpServers,
  agent.excludeMcpServers,
)
```

import `filterMcpTools` from `@harness/tool`。此过滤只影响模型可见/可调用工具集，MCP 工具实际调用仍走 tool.pool，符合「core 只提供机制」。

### 4. `packages/cli/src/index.ts` — config.json 声明承载

- config 类型 `cfg.agents` 扩为含 `mcpServers?` / `excludeMcpServers?`。

- `applyConfigAgentTools` 改造成合并三者（建议改名 `applyConfigAgentOverrides`）：对每个 entry 取 existing 后 register，仅当 `defined` 才覆盖，避免空数组错误清空。

- **保护声明不丢**：`setAgentTools`（L974-985）整条覆盖 entry 会静默丢弃手写 mcp 字段。改为读回原 entry 的 mcp 字段合并写入（保 `{id, tools, mcpServers?, excludeMcpServers?}`），避免 `/tools` 触发后丢失声明。

### 5. 文档

`docs/agent-harness-architecture.md` agent 章节补一小节：MCP server 粒度声明能力、白名单优先/缺省向后兼容、`.md` frontmatter 三种写法与 `config.json agents[]` 示例、工具级仍走 `/tools`。

## 测试

- **tool**（`tool.test.ts`）：`parseMcpToolId`（含 server 含 `__` 边界）；`filterMcpTools` 各分支——双 undefined 透传、白名单保留/剔除、白名单空数组全拒、黑名单剔除、白名单优先于黑名单、非 MCP 工具恒保留、server trim。

- **agent**（agent index.test.ts）：frontmatter 三种写法（内联/块级/裸逗号）→ 数组；缺省 → undefined（向后兼容）；空数组。

- **core**（core.test.ts）：注册含 `mcpServers` 的 Agent + `tool.pool.assemble` 注入多 server 工具，断言 `allowedTools` 仅含白名单 server 工具。

- **cli**（cli.test.ts）：config.json 预写 `agents:[{id,tools,mcpServers,excludeMcpServers}]`，调 `applyConfigAgentOverrides` 后运行时 agent 合并三字段。

## 验证

1. `packages/tool`、`packages/agent`、`packages/core`、`packages/cli` 各自 `bun test` 全绿。
2. 全量 `bun run typecheck` 通过。
3. 手工端到端：在 `.harness/agents/some.md` frontmatter 写 `mcpServers: [github]`，运行 REPL 确认该 agent 的模型仅可见 `mcp__github__*` 工具、其它 server 工具被过滤；移除字段后全部可见。
4. 完成后 git 提交（`feat(agent): ...`），sync `docs/development-log.md` 续编号。

## 风险

- `setAgentTools` 覆盖逻辑是主要雷区（须保留 mcp 字段）。

- 三处前缀解析规则需统一收敛，避免 server 含 `__` 时漂移。

- `query` 与 `queryStream` 两处必须都用 helper，避免结果不一致。

