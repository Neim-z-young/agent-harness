# Agent Harness 开发日志

## 2026-08-21：流式输出 + Provider 扩展 + 工具插件化拆分

### 今日完成

在 Phase 3 基础上完成三项交付：流式输出打通全链路、新增 OpenAI Provider、按"原语才内置"原则拆分工具包。**14 个包 typecheck 全绿，215 个单元测试全通过（595 断言）**。

#### 1. 模块开发

| # | 提交 | 模块 / 变更 | 能力 | 测试数 |
|---|---|---|---|---|
| 1 | `fb9c3ae` | `@harness/core` 流式输出 | `ChatStreamChunk` + `AgentStreamEvent` 类型；`ChatProvider.stream?()` 可选方法；`AgentRuntime.queryStream()` 边流式边处理工具调用；`SessionManager.promptStream()`；CLI REPL / `run` 子命令逐 token 打印 | — |
| 2 | `fb9c3ae` | `@harness/provider-anthropic` 流式 | `AnthropicChatProvider.stream()`：解析 SSE（`message_start` / `content_block_delta` / `message_delta`），yield `text_delta` / `tool_use_start` / `tool_use_delta` / `tool_use_stop` / `done` | 4 |
| 3 | `fb9c3ae` | `@harness/provider-mock` 流式 | `MockChatProvider.stream()`：逐 token 模拟输出，供无网络环境测试流式链路 | — |
| 4 | `ddc5db3` | `@harness/tools-builtin` 新增工具 | `list_dir`（目录列举：递归/隐藏文件/类型/大小）、`grep_file`（正则检索：glob 过滤/大小写/递归）、`edit_file`（精确替换：`oldString`→`newString`，`replaceAll`/多行/多重匹配校验） | 16 |
| 5 | `4d39c29` | `@harness/provider-openai`（新包） | OpenAI Chat Completions 对接：Bearer auth、Part→messages 序列化（`tool_calls` 数组 / `role:tool` 带 `tool_call_id` / `image_url` data: URI）、Tool Schema 导出、`complete()` 非流式 + `stream()` 流式（SSE `data:[DONE]` 终止、tool_calls 按 index 累积 arguments 增量） | 17 |
| 6 | `e65543d` | 工具插件化拆分 | `@harness/tools-builtin` 瘦身为 4 个原语（v0.3.0）；`list_dir`/`grep_file` 抽到新包 `@harness/tools-search`（v0.1.0，自包含 helper + `toolsSearchPlugin` 工厂） | 14 |

#### 2. 关键技术决策

- **流式类型分层**：`ChatStreamChunk`（Provider 层，纯 LLM 输出）与 `AgentStreamEvent`（Agent 层，含工具执行结果）解耦，让 Provider 不感知工具执行
- **OpenAI 与 Anthropic 序列化差异**：Anthropic 用 `tool_use`/`tool_result` block；OpenAI 用 assistant.tool_calls 数组 + 独立 `role:tool` 消息（带 `tool_call_id` 关联），两条序列化路径分别实现
- **工具流式增量累积**：OpenAI 的 `tool_calls` 按帧增量（首帧带 id+name，后续只带 arguments 片段），用 `Map<index, state>` 累积并按帧 yield `tool_use_delta`
- **"原语才内置"判定原则**：内置仅留不可替代、不可组合替代、非场景化的工具。`read_file`/`write_file`/`edit_file`/`bash` 是文件 I/O + Shell 原语；`list_dir`/`grep_file` 属搜索导航场景（`bash ls/grep` 可替代），抽为独立插件
- **插件包自包含**：`@harness/tools-search` 自带 `resolvePath`/`isWithinCwd`/`makeSchema`/`globMatch` helper，不反向依赖 `@harness/tools-builtin`，保持插件可独立装卸
- **配置三级来源一致**：OpenAI Provider 沿用 `直接传入 > ctx.config.get('provider.openai') > 环境变量 OPENAI_API_KEY/OPENAI_BASE_URL` 优先级，与 Anthropic Provider 对齐

#### 3. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| `new-tools.test.ts` 类型错误 `res.output` 可能 undefined | 测试直接访问 `res.output.count` 未做空断言 | 统一加非空断言 `res.output!.count`（仅在 `res.ok===true` 分支） |
| `ToolContext` 缺 `toolUseId` 字段 | 测试 ctx 构造遗漏该必填字段 | 补 `toolUseId: 'tu1'` |
| 旧测试断言 `builtinTools` 6 个工具 | 拆分后 builtin 仅 4 个、search 2 个 | 更新断言为 `['bash','edit_file','read_file','write_file']`，search 包独立断言 `['grep_file','list_dir']` |
| Anthropic stream 测试 mock fetch 类型不匹配 | mock 返回类型与全局 `fetch` 签名冲突 | mock 函数返回类型改 `any` |
| 拆分后 `readdir`/`join`/`globMatch` 成为 tools-builtin 死代码 | 仅被迁出的 list_dir/grep_file 使用 | 清理 imports 与 helper，迁入 tools-search |

#### 4. 代码统计

```
14 个 packages / 215 个测试 / 595 个 expect（较 08-16 +6 包 +45 测试）
当前工具分布：
  - @harness/tools-builtin（v0.3.0）：read_file / write_file / bash / edit_file（4 原语）
  - @harness/tools-search（v0.1.0）：list_dir / grep_file（搜索类）
当前 Provider 分布：
  - @harness/provider-anthropic（complete + stream）
  - @harness/provider-openai（complete + stream）
  - @harness/provider-mock（complete + stream，测试用）
```

---

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

| 优先级 | 方向 | 说明 | 状态 |
|---|---|---|---|
| ~~**P0**~~ | ~~更多内置工具~~ | ~~`list_dir` / `grep_file` / `edit_file`~~ | ✅ 完成（08-21，edit_file 留 builtin，list_dir/grep_file 抽 tools-search） |
| ~~**P0**~~ | ~~流式输出~~ | ~~Provider `stream: true` + REPL 逐 token~~ | ✅ 完成（08-21，core/anthropic/mock 三端 stream） |
| ~~**P1**~~ | ~~`@harness/provider-openai`~~ | ~~GPT-4o 适配，统一 ChatProvider~~ | ✅ 完成（08-21，complete + stream） |
| **P0** | 工具持续插件化 | `@harness/tools-web`（web_fetch）/ `tools-glob` / `tools-media`（view_image）按场景拆包 | ⏳ 进行中 |
| **P1** | 会话管理增强 | 标题自动生成、关键词搜索、导出 Markdown、Compaction（长会话摘要压缩） | ⬜ 待办 |
| **P1** | 插件化 CLI 扩展 | 插件可往 CLI 注册自己的子命令 / `/xxx` 斜杠命令 | ⬜ 待办 |
| **P2** | MCP Client 插件 | 对接 Model Context Protocol，支持 local stdio + remote SSE MCP Server | ⬜ 待办 |
| **P2** | Subagent 插件 | `AgentTool` + `runAgent()`，支持子 Agent 嵌套调用 | ⬜ 待办 |
| **P2** | Skill Layer | Markdown 技能 + paths 条件触发 + 三来源发现（bundled/user/project） | ⬜ 待办 |
| **P3** | TUI 形态 | 基于终端 UI 的富交互（类似 Claude Code TUI） | ⬜ 待办 |
| **P3** | Swarm 协作 | Team + Mailbox + Task List + 权限桥接（多 Agent 协作） | ⬜ 待办 |

#### 近期优先推进顺序

1. ~~**流式输出**~~ — ✅ 已完成
2. ~~**`edit_file` + `list_dir` + `grep_file`**~~ — ✅ 已完成（含工具插件化拆分）
3. **`@harness/tools-web` / `tools-glob` / `tools-media`** — 按场景继续插件化，复用 tools-search 模板（自包含 helper + tool.pool.assemble Hook）
4. **会话 Compaction** — 长对话场景必需
5. ~~**`@harness/provider-openai`**~~ — ✅ 已完成
