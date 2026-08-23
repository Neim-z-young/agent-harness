# Agent Harness

基于 TypeScript + Bun 的插件化 Agent Harness 框架。

融合 Claude Code（6 层严格解耦 + Tool 运行时协议 + Fail-Closed 安全策略）与 OpenCode（Plugin Hooks 管道 + 类型安全事件总线 + 路径级权限匹配）两者的优点，一切能力皆可插件化。

## 特性亮点

- **运行时协议优于函数接口**：Tool / Agent / Plugin 是完整的生命周期协议对象，不只是 `call()`
- **Fail-Closed 安全优先**：所有扩展点默认关闭，需显式声明能力边界（`isReadOnly` / `isDestructive` / `isConcurrencySafe`）
- **Hooks 管道而非继承**：12+ 个 Hook 点让插件介入生命周期（`harness.start` / `tool.pre.execute` / `prompt.system.transform` / `cli.command` 等）
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
harness help                          显示帮助

选项：
  -c, --cwd <dir>           工作目录
  -a, --agent <id>          默认 Agent ID
  -p, --provider <name>     mock / anthropic / openai
  -s, --session <id>        指定会话 ID
  -d, --data-dir <dir>      持久化目录（默认 ~/.harness）
      --permission <mode>   allow-all / ask（默认 ask）
  -v, --verbose             调试日志
```

### REPL 内斜杠命令

```
/help                              显示所有可用命令
/compact [prune|summary|agent|auto] 压缩当前会话历史
/search <keyword>                 关键词搜索历史会话
/export [path]                    导出当前会话为 Markdown
/mcp [servers|tools|resources|read <uri>|prompts|prompt <name>]  MCP 服务器管理
/subagents                        列出已注册的子 Agent
/exit                              退出 REPL
```

### 运行测试

```bash
bun test                    # 全部测试
bun run typecheck           # 全部类型检查
```

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
        'tool.pool.assemble'(_input, pool) {
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

- [架构设计文档](docs/agent-harness-architecture.md) — 设计理念、总体架构、核心模块详解、实现路径
- [开发日志](docs/development-log.md) — 每日开发进度、遇到的问题与修复、下一步计划

## Tech Stack

- **Runtime**: Bun >= 1.3
- **Language**: TypeScript
- **Architecture**: Monorepo (packages/)
- **Dependencies**: Zero external runtime deps

## License

Private
