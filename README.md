# Agent Harness

A plugin-based Agent Harness framework built with TypeScript + Bun.

Inspired by Claude Code and OpenCode architecture, designed for extensibility through plugins.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.3

### Install

```bash
git clone git@github.com:Neim-z-young/agent-harness.git
cd agent-harness
bun install
```

### Run CLI

```bash
# 交互式 REPL（默认用 Anthropic Claude，需配 API Key）
export ANTHROPIC_API_KEY=sk-ant-xxx
bun run packages/cli/src/index.ts repl

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
  -p, --provider <name>     mock / anthropic
  -s, --session <id>        指定会话 ID
  -d, --data-dir <dir>      持久化目录（默认 ~/.harness）
      --permission <mode>   allow-all / ask（默认 ask）
  -v, --verbose             调试日志
```

### Run Tests

```bash
bun test                    # 全部测试
bun run typecheck           # 全部类型检查
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 CLI / SDK / IDE                  │  入口层
├─────────────────────────────────────────────────┤
│              @harness/cli (REPL)                 │
├─────────────────────────────────────────────────┤
│              @harness/core                       │  核心层
│   Harness · AgentRuntime · SessionManager        │
│   ToolPool · PermissionEngine · ChatProvider     │
├──────────────┬──────────────┬───────────────────┤
│  @harness/   │  @harness/   │  @harness/        │  基础层
│    bus       │    tool      │    plugin         │
│  事件总线    │  工具协议    │  插件管理         │
├──────────────┴──────────────┴───────────────────┤
│              @harness/session · agent ·          │  领域层
│              permission · skill                  │
├─────────────────────────────────────────────────┤
│                 Plugins                          │  插件层
│  provider-mock · provider-anthropic              │
│  tools-builtin (read_file/write_file/bash)       │
└─────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| [`@harness/bus`](packages/bus/src/index.ts) | 类型安全 Pub/Sub 事件总线 |
| [`@harness/tool`](packages/tool/src/index.ts) | Tool 协议 + 注册中心 + 执行流水线 |
| [`@harness/plugin`](packages/plugin/src/index.ts) | 插件管理（三级加载 + 拓扑排序 + Hook 管道） |
| [`@harness/core`](packages/core/src/index.ts) | Harness 编排器（生命周期 + 能力访问器） |
| [`@harness/cli`](packages/cli/src/index.ts) | 命令行入口（REPL + 会话持久化 + 权限交互） |
| [`@harness/provider-mock`](packages/plugins/provider-mock/src/index.ts) | Mock LLM Provider（测试用） |
| [`@harness/provider-anthropic`](packages/plugins/provider-anthropic/src/index.ts) | Anthropic Claude Messages API Provider |
| [`@harness/tools-builtin`](packages/plugins/tools-builtin/src/index.ts) | 内置工具（read_file / write_file / bash） |

## Key Design Decisions

| 决策 | 选型 | 理由 |
|------|------|------|
| 技术栈 | TypeScript + Bun | 原生 TS、零配置、fast test |
| 包结构 | Monorepo (`packages/*`) | 模块边界清晰，可独立发布 |
| 工具默认并发安全 | 否（Fail-Closed） | 新工具默认有风险，需显式声明 |
| 扩展机制 | Hooks 管道 | 12 个 Hook 点，插件介入生命周期 |
| 插件加载顺序 | Internal → Builtin → User + 拓扑排序 | 保证覆盖关系明确 |
| 权限匹配 | 精确路径 → glob → 工具级 → 全局 | 4 级匹配 + 规则记忆 |
| 外部依赖 | 零 | 参数解析 / glob / readline 全部内置 |

## Plugin Development

```typescript
import type { AgentPlugin } from '@harness/plugin'

const myPlugin: AgentPlugin = {
  id: 'my.plugin',
  version: '1.0.0',
  name: 'My Plugin',

  install(ctx) {
    // 注册工具
    ctx.tools.register({
      id: 'my_tool',
      name: 'My Tool',
      description: 'A custom tool',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      permission: { kind: 'read' },
      async execute(input, ctx) {
        return { ok: true, echo: input.msg }
      },
    })

    return {
      // Hook：在工具执行前介入
      'tool.pre.execute'(tool, input, ctx) {
        console.log(`[my-plugin] executing ${tool.id}`)
      },
    }
  },
}
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
