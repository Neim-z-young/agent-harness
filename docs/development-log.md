# Agent Harness 开发日志

## 2026-08-16：Phase 1 ~ Phase 3 核心交付

### 今日完成

从架构设计到可运行的 CLI，一天内完成了 8 个模块的开发、测试与推送，共 **170 个单元测试全绿、12 个包 typecheck 0 error**。

#### 1. 架构设计

- 产出 [agent-harness-architecture.md](./agent-harness-architecture.md)
- 融合 Claude Code（6 层严格解耦 + Tool 运行时协议 + Fail-Closed 安全策略）与 OpenCode（Plugin Hooks 管道 + Bus 类型安全事件总线 + 4 级路径权限匹配）两者的优点
- 明确 4 阶段里程碑、12 项关键设计决策、与两个参考架构的 11 维对比

#### 2. 模块开发（按交付顺序）

| # | 模块 | 能力 | 测试数 | PR |
|---|---|---|---|---|
| 1 | `@harness/bus` | 类型安全 Pub/Sub 事件总线：`BusEvent.define` + `InMemoryBus` + 全局订阅 | 24 | #1 |
| 2 | `@harness/tool` | Tool 协议（10+ 属性 + Fail-Closed）+ `ToolRegistry` 注册中心 + `ToolPipeline` 7 步生命周期 + 拓扑排序 | 32 | #1 |
| 3 | `@harness/plugin` | `PluginManager` 三级加载（Internal/Builtin/User）+ Kahn 拓扑排序 + 12 个 Hook 管道 + 热重载 | 32 | #1 |
| 4 | `@harness/core` | `HarnessImpl` 生命周期编排 + 能力模块访问器（tools/agent/session/permission/bus/chat）+ `AgentRuntimeImpl` 主循环 + `DefaultToolPool` + `DefaultSessionManager` | 13 | #2 |
| 5 | `@harness/provider-mock` | `MockChatProvider`：可配置默认响应 / 关键词匹配 / tool call 模拟 / 调用记录 | 12 | #2 |
| 6 | `@harness/tools-builtin` | `read_file` / `write_file` / `bash` 三个内置工具插件 | 32 | #3 |
| 7 | `@harness/provider-anthropic` | Anthropic Messages API 对接：Part→Block 序列化、Tool Schema 两级导出、fetch+超时+AbortSignal、配置三级来源 | 12 | #4 |
| 8 | `@harness/cli` | 命令行入口：REPL + 会话持久化 + 权限交互 + 多子命令（repl/run/resume/list-sessions） | 13 | #5 |

#### 3. 关键技术决策

- **TypeScript + Bun**：原生 TS、零配置运行、fast test runner
- **Monorepo**：`packages/*` + `packages/plugins/*`，workspace 协议，tsconfig path mapping
- **Fail-Closed 安全策略**：所有新工具默认不可并发、非只读，需显式声明能力边界
- **Hooks 管道而非继承**：12 个 Hook 点（`harness.init` / `tool.pre.execute` / `permission.check` 等）让插件介入生命周期
- **Provider 自动 fallback**：CLI 检测到无 `ANTHROPIC_API_KEY` 时自动切到 Mock Provider 并打印提示
- **零外部依赖**：参数解析、glob 匹配、readline 交互全部内置实现，不引入 minimist / picomatch / inquirer

#### 4. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| Hook 触发顺序断言错误 | Bad 插件先注册但 Good 插件 Hook 仍执行 | 修正测试断言，确认 Good 插件 Hook 未被执行 |
| logger 错误日志字符串不匹配 | 实际日志带 `[plugin:X]` 前缀 | 调整测试断言匹配实际日志 |
| `loadBuiltin` 重复 ID 测试未注入 dynamicImport | 走到真实 Bun import 失败 | 测试注入 custom dynamicImport 模拟加载 |
| `ToolRegistry` 重复注册 echo | 第二次 query 重复注册工具 | `DefaultToolPool.add/addAll` 已存在时静默跳过 |
| 多行命令测试失败 | `echo "a\nb\nc"` 未正确解释换行 | 改用 `printf "a\nb\nc\n" \| grep b` |
| `tool_result` block 多余 `is_error` 字段 | Anthropic API 不接受非错误时的 `is_error` | 仅 `isError=true` 时写入 `is_error` |
| CLI 短选项 `-s=foo` 解析失败 | 未处理短选项 `=` 形式 | 重写 parseCliArgs 短选项分支 |
| 权限永久 allow/deny 判断失效 | `toLowerCase()` 把大写 A/D 变成 a/d 命中单次分支 | 先判断永久（`answer === 'A'`），再判断单次 |

#### 5. 代码统计

```
8 个 packages / 12 个 tsconfig / 170 个测试 / 449 个 expect
5 个 Draft PR（#1 ~ #5）
```

---

### 下一步计划

#### Phase 4：实用化与扩展

| 优先级 | 方向 | 说明 |
|---|---|---|
| **P0** | 更多内置工具 | `list_dir` / `grep_file` / `edit_file`（让 CLI 真的能读写改代码） |
| **P0** | 流式输出 | Provider 支持 `stream: true`，REPL 逐 token 打印（当前是一次性返回） |
| **P1** | `@harness/provider-openai` | GPT-4o / GPT-4.1 适配，统一 ChatProvider 抽象 |
| **P1** | 会话管理增强 | 标题自动生成、关键词搜索、导出 Markdown、Compaction（长会话摘要压缩） |
| **P1** | 插件化 CLI 扩展 | 插件可往 CLI 注册自己的子命令 / `/xxx` 斜杠命令 |
| **P2** | MCP Client 插件 | 对接 Model Context Protocol，支持 local stdio + remote SSE MCP Server |
| **P2** | Subagent 插件 | `AgentTool` + `runAgent()`，支持子 Agent 嵌套调用 |
| **P2** | Skill Layer | Markdown 技能 + paths 条件触发 + 三来源发现（bundled/user/project） |
| **P3** | TUI 形态 | 基于终端 UI 的富交互（类似 Claude Code TUI） |
| **P3** | Swarm 协作 | Team + Mailbox + Task List + 权限桥接（多 Agent 协作） |

#### 近期优先推进顺序

1. **流式输出** — 体验提升最大，当前 REPL 等待返回时是阻塞的
2. **`edit_file` + `list_dir` + `grep_file`** — 让 CLI 具备基本的代码浏览和编辑能力
3. **会话 Compaction** — 长对话场景必需
4. **`@harness/provider-openai`** — 多模型支持
