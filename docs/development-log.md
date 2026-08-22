# Agent Harness 开发日志

## 2026-08-23：会话 Compaction（三级压缩 + 系统记忆注入）

### 今日完成

完成 Phase 4 的会话压缩能力：三种压缩策略（prune / summary / agent）、按阈值自动触发 `compactIfNeeded`、压缩后摘要作为长期系统记忆注入到 Agent system prompt；CLI 暴露 `/compact` 斜杠命令、resume/repl/run 启动时自动 compactIfNeeded。

**17 个包 typecheck 全绿（0 error）；与 compaction 相关 4 个新增单元测试全部通过**。

#### 1. 模块开发

| # | 模块 / 变更 | 能力点 | 测试数 |
|---|---|---|---|
| 1 | `@harness/session` Session.meta schema 扩展 | 导出 `CompactionMeta`（压缩统计：count/lastStrategy/totalPrunedMessages 等）+ `CompactMemory`（摘要文本+轮次+记忆起点）+ `COMPACT_META_KEY` / `COMPACT_MEMORY_KEY` 约定；扩展 `CompactOptions`（`strategy` / `thresholdTokens` / `keepRecentMessages` / `summaryMaxChars` / `tokensPerMessage`）；`SessionManager` 接口新增 `compact(…, options?)` / `compactIfNeeded(…)` / `getCompactionInfo(…)` | — |
| 2 | `@harness/core` `DefaultSessionManager` compaction 实现 | 三级策略：`prune`（只截断、保留最近 K 条）/ `summary`（规则摘要：角色分布+首末用户要点+助手节选+工具调用统计，无需 LLM）/ `agent`（复用 AgentRuntime.query 生成摘要，缺失时自动 fallback 到 summary）；多轮合并：把"前一轮 CompactMemory.summaryText"作为上下文附加在新摘要前方，跨压缩轮次保留长期记忆；统计写入 `Session.meta` | — |
| 3 | `@harness/core` `AgentRuntimeImpl` 系统记忆注入 | 新增 `appendCompactionMemory()` helper，在构建 system prompt（`query()` 与流式 `buildContext()` 两处）时把压缩记忆作为独立 system part 追加（在 `prompt.system.transform` hook 之前，允许插件二次改写） | — |
| 4 | `@harness/cli` 命令 + 自动压缩 | 新增 `/compact [prune|summary|agent|auto]` 命令，打印压缩后 meta+memory 摘要；在 `repl / resume / run` 进入交互前调用一次 `compactIfNeeded`，命中阈值时提示压缩结果 | — |
| 5 | `@harness/core` `core.test.ts` Session Compaction 测试块 | 4 个关键验证：① summary 策略长度+meta/memory 统计 ② prune 策略不产生新摘要 ③ compactIfNeeded 阈值触发/no-op ④ system prompt 注入 memory 片段包含压缩标题、轮次与摘要正文 | 4 |

#### 2. 关键技术决策

- **Compaction 不直接压缩 system prompt**：我们的 system prompt 在 AgentRuntime 内动态拼合 agent.promptFragments 与 compaction memory，不写入 session.messages。压缩算法只处理 session.messages（约定不含 system 消息），避免重复拼接。
- **多轮摘要累积而非覆盖**：新一轮压缩时把"旧 CompactMemory.summaryText"作为"更早记忆"段落加在新摘要前方，避免 LLM 丢失更早语义；同时 `round` 单调递增，system memory 注入时会展示轮次。
- **默认阈值（8000 tokens × 500/msg）偏保守**：`compactIfNeeded` 默认使用 8000 tokens 触发（估算 = `messages.length × tokensPerMessage`，默认每条 500），与 keepRecentMessages=6（最近 3 轮）保证短对话永远不触发。
- **agent 策略采用 fail-closed fallback**：`agent` 策略优先走 AgentRuntime.query 调 LLM 生成摘要；若缺少 ChatProvider/AgentRuntime 或调用出错，不抛异常给业务，静默回落到 ruleBasedSummary，保证 compaction 永远可用。
- **summary 策略做确定性、无 LLM 依赖**：规则摘要按"首末用户要点 + 助手节选 + 工具调用统计 + 前压缩轮次提示"组合，可离线、可重复、无费用，作为默认策略。
- **CompactOptions 设计为单源**：`compact()` 的第二参数 `strategy` 与第三参数 `options.strategy` 等价，`strategy` 显式参数优先，便于 CLI 直接传策略、也便于程序化代码通过 CompactOptions 调用。

#### 3. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| 测试最初 `h.session.update(id, fn)` 报错 `update` 不存在于 `SessionManager` 接口 | `@harness/session` 暴露的是细粒度的 `updateMessage / addMessage / updatePart`，没有整 session mutate 入口 | 改用 helper `fillMessages(h, sessionId, rounds)` 循环调用 `h.session.addMessage` 注入消息 |
| core typecheck：`SessionManager` import 类型中缺 `CompactOptions / CompactionMeta / CompactMemory / COMPACT_META_KEY / COMPACT_MEMORY_KEY` | 新增类型未同步进 import | 在 `import type` 块补齐，并 `import { COMPACT_META_KEY as COMPACT_META_KEY_VAL, COMPACT_MEMORY_KEY as COMPACT_MEMORY_KEY_VAL }` 引入运行时常量，避免同文件类型/值混合引用问题 |
| 无 test 文件的包（permission/agent/skill/session）`bun test` 返回 exit code 1 | 这些包只有 `scripts.test="bun test"`，默认 bun 找不到 *.test.ts 返回 1 | 暂不在本次修（属 monorepo 历史脚本问题，与 compaction 无关）；逐个包验证 core、cli、builtin/plugin 均 0 fail |

#### 4. 代码统计

```
17 个 packages / typecheck 全绿 / 新增 compaction 单测 4 个 / 核心断言数：
  - 压缩长度：summary 20→6、prune 16→4
  - 统计：count=1 / lastMessagesBefore / totalPrunedMessages / round
  - 注入：system prompt 含"会话压缩记忆"与摘要前缀匹配
会话 compaction 能力对外 API：
  - SessionManager.compact(sessionId, strategy?, options?)
  - SessionManager.compactIfNeeded(sessionId, options?) => boolean
  - SessionManager.getCompactionInfo(sessionId) => { meta?, memory? }
CLI 斜杠命令：
  - /compact [prune|summary|agent]
  - /compact auto (或 ifneeded) = compactIfNeeded
```

---

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

## 2026-08-22：工具插件化持续扩展（glob/web/media 三场景包）

### 今日完成

延续"原语内置，场景按插件接入"的拆分原则，新增三个场景工具包。**17 个包 typecheck 全绿，248 个单元测试全通过（690 断言，较 08-21 +33 测试）**。

#### 1. 模块开发

| # | 模块（新包） | 工具 | 核心能力 | 测试数 |
|---|---|---|---|---|
| 1 | `@harness/tools-glob` v0.1.0 | `glob` | 多模式 `**` / `*` / `?` 通配符；`!` 取反 + `exclude` 便捷字段；隐藏文件默认跳过；文件大小 min/max 过滤；最大深度限制；结果上限截断；cwd 边界保护 | 9 |
| 2 | `@harness/tools-web` v0.1.0 | `web_fetch` | HTTP(S) 抓取，支持 GET/POST/PUT/PATCH/DELETE；自定义 headers / body（对象自动 JSON 序列化）；三种返回格式 `text` / `json` / `base64`（data: URI）；follow redirects / maxBytes 截断 / timeoutMs + AbortSignal；SSRF 防护（默认拦截 10.x / 172.16-31 / 192.168 / 127.x / fc/fd / localhost*.local）；`allowPrivateNetwork` 显式放行 | 14 |
| 3 | `@harness/tools-media` v0.1.0 | `view_image` | 本地图片读取转 base64 data URI + 尺寸解析（PNG/JPEG/GIF/BMP/WebP 魔数识别，含 PNG/GIF/BMP 宽高、JPEG SOF0 段遍历）；maxBytes + strictSize 模式（过大报错 or 仅回元数据）；cwd 路径边界保护 | 10 |

三包均按 `tools-search` 模板统一：
- 自包含 helper（resolvePath / isWithinCwd / makeSchema / 场景专用 helper），不反向依赖 `tools-builtin`
- `defineTool` + Fail-Closed 安全声明（`isReadOnly`/`isDestructive`/`isConcurrencySafe`），`permission.key` 按场景分配（`read`/`network`）
- `createXxxPlugin({ toolIds })` 工厂 + 默认导出 `toolsXxxPlugin` 常量
- 通过 `tool.pool.assemble` Hook 注入 `ToolRegistry`

#### 2. 关键技术决策

- **三插件均 `isConcurrencySafe=true` 声明**：glob 纯读、web_fetch 请求幂等、view_image 只读，可并行执行（Fail-Closed 需显式声明）
- **web_fetch 权限键用 `network`（非 `read`/`write`）**：网络访问是独立能力维度，与本地文件的读写权限体系分离，可被 permission 引擎单独管控
- **SSRF 默认 fail-closed，白名单开启**：私有 IP / localhost / .local / 169.254 link-local 全部拦截，仅当调用方显式 `allowPrivateNetwork=true` 才放行——与 fail-closed 哲学一致
- **view_image 尺寸解析零依赖**：纯字节判断 PNG IHDR/JPEG SOF0/GIF6/7/BMP DIB 头，不引入 sharp/jimp 等本地图像库
- **已 abort signal 同步快速路径**：web_fetch 在进入 await fetch 前同步检查 `inner.signal.aborted`，避免 mock fetch 不监听 signal 时悬挂
- **glob 正则按段构建**：`**` 段末尾位置写 `.*`（匹配任何内容到结尾）、非末尾写 `(?:.*/)?`（包含段间 `/`），其它段单独转义后拼接，避免双重 `/` 问题

#### 3. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| glob `**/*.ts` 匹配空（递归、排除两个用例失败） | `globToRegex` 用 join('/') 把 `(?:.*/)?` 与下段之间插入了额外 `/`，导致必须存在 `/` 才能匹配（根层漏掉） | 改为按段逐段拼接：非末尾 `**` → `(?:.*/)?`（自带末尾 `/`）、非末尾普通段 → `escaped` + `/` |
| `readFile(path, null, { length: 32 })` 三参数 TS 错误 | Node `fs/promises.readFile` 仅接受 `(path, options?)` 两参数，无 `length` 选项 | 改用 `open(path, 'r') → fh.read({ buffer, length: 32 }) → fh.close()` 三步 |
| `mkdirSync(join('src', { recursive: true }))` 类型错误 | 把 mkdirSync options 当 join 第三参数传入了（括号错位） | 修正括号：`mkdirSync(join('src'), { recursive: true })` |
| `error.detail` TS 类型不匹配（`JSON_PARSE_ERROR` 中） | Tool `ToolError` 结构仅 `{ message, code?, cause? }`，无 `detail` | 把原始字节片段拼接到 `message` 字符串中，移除非法 `detail` 字段 |
| web_fetch AbortSignal 测试 5s 超时挂死 | 最初 mock fetch 返回永不 settle Promise，inner.signal abort 也无法让 hanging fetch 解挂 | 改写：1) 已 abort 用例改用"提前 abort signal + fetch 前同步检查快速失败"；2) timeout 用例 mock fetch 监听 init.signal 的 abort 事件，收到后 reject AbortError，settle Promise |

#### 4. 代码统计

```
17 个 packages / 248 个测试 / 690 个 expect（较 08-21 +3 包 +33 测试）

场景工具插件（按 tools-search 模板）：
  - @harness/tools-search   v0.1.0 list_dir / grep_file（搜索导航）
  - @harness/tools-glob     v0.1.0 glob（模式匹配）
  - @harness/tools-web      v0.1.0 web_fetch（网络抓取 + SSRF 防护）
  - @harness/tools-media    v0.1.0 view_image（多模态图像 base64 + 尺寸）
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
| ~~**P0**~~ | ~~工具持续插件化~~ | ~~tools-web / tools-glob / tools-media 三场景拆包~~ | ✅ 完成（08-22，三新包 +33 测试） |
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
3. ~~**`@harness/tools-web` / `tools-glob` / `tools-media`**~~ — ✅ 已完成（三场景包 33 测试）
4. **会话 Compaction** — 长对话场景必需
5. ~~**`@harness/provider-openai`**~~ — ✅ 已完成
