# Agent 项目规范（agent-harness）

本项目是一个基于 **TypeScript + Bun** 的插件化 Agent Harness 框架（monorepo）。本文件供 AI Agent 在开发时遵循，避免偏离既有约定。

## 1. 仓库结构与命名

- Monorepo，工作空间：`packages/*` 与 `packages/plugins/*`（见根 `package.json` 的 `workspaces`）

- 核心模块命名 `@harness/[module-name]`；插件模块放在 `packages/plugins/[name]`，命名 `@harness/[name]`

- 每个模块必须包含：

  - `src/index.ts`（公共 API 通过 `index.ts` 以清晰接口导出）

  - `src/index.test.ts`（单元测试，尽量覆盖完整）

  - `package.json`、`tsconfig.json`（extends 根 `tsconfig.json`，`outDir: ./dist`，`include: ["src"]`）

- 新包必须同步在根 `tsconfig.json` 的 `paths` 与相关 `package.json` 的 `dependencies` 注册，然后 `bun install`

## 2. 运行命令（本机 bun 在 `/opt/homebrew/bin/bun`）

- 安装依赖：`bun install`

- 单包测试：`cd packages/<pkg> && bun test`

- 单包类型检查：`cd packages/<pkg> && bun run typecheck`

- 全量类型检查：`bun run typecheck`

- 全量测试：`bun run test`（= `bun --filter=* run test`，逐包跑，退出码可用于 CI/脚本判断；此前因 `@harness/permission` 一个测试文件都没有而**恒为 1**，已补该包测试修正）

> 别用根目录的 `bun test`：它会把 `reference/**`（参考代码 / 外部仓库快照）一起扫进来，那里缺 react 等依赖，会产生数百个与本次改动无关的失败。

- **`bun test` 不做类型检查 ⇒ 测试全绿 ≠ 类型正确**：往测试文件里加用例（尤其 `const script = [...]` 这类**先赋值给变量**的字面量，会丢掉调用点的上下文类型 ⇒ `'text_delta'` 被拓宽成 `string` ⇒ TS2345）后，必须**单独跑 `typecheck`**。改完代码的收尾验证要**同时**给出 `typecheck` 与 `test` 两行结果

- **验证结果必须与"最后一次改动"对齐**：不要引用早于最后一次改动的验证结论（曾用旧的全量 typecheck 结果盖过其后新增的测试文件，把 1 个 TS2345 漏报成"39 包 0 error"）。收尾时按「改完 → 跑全量 typecheck + test → 记录数字」的顺序一次做完

- TypeScript 严格模式（`strict: true`）、`target ESNext`、`moduleResolution: bundler`

> 注意：本机 shell `PATH` 异常，运行 bun/git 建议用绝对路径 `/opt/homebrew/bin/bun`、`/usr/bin/git`。

## 3. 分层与依赖方向

开发按依赖顺序推进：**bus → tool → plugin → core → cli/插件包**。

- `@harness/bus`：事件总线

- `@harness/tool`：工具（Tool/ToolResult/Schema/ToolContext）基座，`defineTool`

- `@harness/plugin`：插件体系（`AgentPlugin`、`Hooks`、`PluginManager`）

- `@harness/core`：`createHarness` / `Harness`，组装 agent/session/tool/permission/skill

- 插件包：provider-\* / tools-\* / mcp-client / mcp-server-registry / computer-use 等

## 4. 硬性约束

- **插件化设计**：本项目是插件化项目，所有功能都应以插件形式实现，可插拔、可独立装卸，**不与项目本身（core/CLI 主逻辑）耦合在一起**；core 只提供生命周期、钩子与扩展机制，业务能力一律通过插件注入（如工具、Provider、MCP server、技能）

- `reference/` 目录必须从 Git 排除（不可入库）

- GitHub 仓库必须为 **private**

- 架构/开发文档放在 `docs/`（`agent-harness-architecture.md`、`development-log.md`）

- Agent 与会话消费需要加载的技能/插件目录须支持两级：user（`~/.harness/...`）与 project（`.harness/...`，项目级覆盖用户级）

- MCP server 相关新增插件一律依赖 `@harness/mcp-server-registry` 启动并复用 `@harness/mcp-client` 连接，**不要集成进 core**

- Agent 插件类型不做硬编码，使用注册表/机制（如 `ProviderTypeRegistry`）；Provider 插件 id 由 `providerId` 派生（`provider.{providerId}`），避免同一类型多实例冲突

- 插件与技能均须支持管理（enable / disable / reload），技能标注来源（内置/用户/项目/MCP/插件）

- Provider 配置 API key 支持三种格式：明文、环境变量引用 `${ENV_VAR}`、AES-256-GCM 加密值 `enc:v1:`

- 模型配置来源优先级：**CLI > config.json > 环境变量**

- 权限走「check → ask」两步判定：`resolvePermission` 统一入口，仅 `ask` 时调用引擎 `ask()`；工具执行统一走 `safeExecuteTool` 兜底，把异常归一化为失败 `ToolResult` 反馈给 LLM 而不是中断 agent 流；`ask()` 之前会触发 `core.permission.check`（插件可改写决策，也是"等待用户决策"类上报的唯一入口）

- **Hook 命名规范：`层.域.动作`**（如 `core.tool.pre.execute`、`cli.agent.stream`）。首段锁定**触发层**：`core.` = 引擎层（任何宿主都有：CLI / 库内嵌 / ACP 宿主），`cli.` = CLI 宿主层（只有走 CLI 的宿主才有）。判层判据：**"没有 UI 的宿主里这条还会触发吗？"**。新增 hook 必须二选一，不得只写域（历史事故：`agent.stream` 由 CLI 触发，引擎终态曾塞进同一个名字 ⇒ 消费方分不清来源、按轮计数翻倍）。与总线事件（`harness.started` / `tool.enabled`…）是两套命名空间：事件走 `core.bus` 发布订阅，hook 走 `plugin.trigger`；方法名不受约束（`harness.start()` 是方法，hook 是 `core.harness.start`）

- 宿主需要按序取用 hook 回调时用 `PluginManager.listHooks(name)`（公开只读），**不要** `(plugin as any).hooks.listFor(...)` 去摸私有字段

- `doom-loop` 重复调用守卫是**硬中断，不经权限引擎**（同一工具+同一入参连续 3 次，或连续 3 步整步签名相同）：它是"已经在空转"的资源保护，不是"能不能执行"的权限问题。曾走 `permission.ask()` ⇒ 被 `--permission allow-all`（或已记住的 allow 规则）完全架空（实测 25 步空转 21 秒零拦截）。命中即记 `code: 'DOOM_LOOP'` 的失败 ToolResult 并终止本轮，不再续轮。另：该守卫**不挂 `core.permission.check` hook**——它不走权限路径了，且放行后工具仍会走 pipeline，挂 hook 会让消费方双报

- 权限拒绝判定用错误名 `err.name === 'ToolPermissionDeniedError'`，避免依赖类绑定

- CLI 权限引擎（`CliPermissionEngine`）持久化规则到 `dataDir/permissions.json`，交互模式 `allow-all | ask | deny-all`，提供 `/permission` 命令

- **Agent 能力白名单的四条实操约定**（真机实测得出，别凭直觉写）：
  · `tools:` 只接受**精确 id**（`ToolRegistry.filterByWhitelist`；除整串 `'*'` 外不支持通配，也不支持 `mcp__xxx__*`）；未声明则回落**只读哨兵**（能读不能写）+ 告警，`tools: []` 才是"一个都不给"——而且它是**绝对**的逃生口，连 `mcpServers` 声明的工具也一并拒掉。
  · **`mcpServers` 是「供给」不是「二次收窄」**：core 的组装是 `supplyMcpTools(filterByWhitelist(agent.tools), registry.list(), agent.mcpServers, agent.excludeMcpServers)` —— 声明 `mcpServers: ['code-intel']` 即自动获得该 server **全部**工具，**不必**再把 `mcp__code-intel__*` 逐条写进 `tools:`。语义：非空数组=供给该 server 全部工具（并剔除 `tools:` 里属于列表外 server 的 MCP 工具）；`[]`=拒绝全部 MCP（连 `tools:` 里显式写的也剔除）；**缺省(undefined)=不供给**（MCP 只能靠 `tools:` 显式写 id 或 `'*'` 进来，刻意不是"全可见"——那会让 `tools: ['read_file']` 的只读 agent 静默拿到全部 MCP 工具）；`excludeMcpServers` 仅在 `mcpServers` 缺省时生效（黑名单，连显式写进 `tools:` 的也剔除）。
    ⚠️ **历史坑（2026-09-28 修复）**：旧实现是 `filterMcpTools(filterByWhitelist(agent.tools), …)` —— 第二阶段只能**做减法**，而 MCP 工具在第一步就被剔掉了 ⇒ **声明了 server 也拿到 0 个**（探针实测 `TOOL_NOT_ALLOWED`），只有把 `mcp__…` 逐条手写进 `tools:` 才生效，文档与实现互相打架。**同一件事的另一半：`/tools` 展示必须与执行共用同一判据**（`tools-manager` 的 `agentAllowedTools`）——展示各写一套时，用户会把"其实能调"的工具读成「禁用」，比不显示更坏。
  · `mcpServers: []` = 一个 MCP 工具都不给（fail-closed：将来新增 server 也不会漏进来）；想只留某几个 server 就写 `mcpServers: [名字]`。
  · **白名单是"两处"判定：过滤（模型看到什么）+ 执行期解析（真正调谁）**。执行期曾写成 `allowedTools.find(...) ?? toolRegistry.get(...)` ⇒ 回落全局注册表，模型点名一个"已注册但未授权"的工具照样执行（真机 reader 只授权 4 个只读工具却调通了 `compress`），`tools: []` 同样被架空。回落**只该用于 alias 解析**，取到实例后必须 `allowedTools.includes(实例)` 再验一次；越界回喂 `TOOL_NOT_ALLOWED` + 触发 `core.tool.whitelist.blocked`（"未注册"≠"越界"，后者才要审计）。**只测"配了白名单能否执行"会全绿** —— 必须有一条"注册了但不授权 ⇒ 拒绝"的反向用例。

- **子 agent 派工的两个已知事实**：① 递归深度**只靠白名单**控制（`mode:'subagent'` 不会被自动排除），所以 subagent 的 `tools:` 里不该出现 `subagent` —— 此前 8 个 subagent 全是 `tools:"*"`，等于**能无限往下派工**；② agent 的 `subagents:` 字段**只被解析、无人消费**（声明而不生效，`tools` 之外又一个"配了没用"），`description` 也**不进模型上下文**（仅供 `/subagents` 展示）⇒ 派工时模型看不到可用子 agent 清单，只能靠用户点名指定 `agentId`

- **真机取证必须带"独立证据"，且别把不同层的东西当同一件事**：本轮两次差点得出错误结论 —— ① 用"provider 全量输入 ÷ 本地 history-only 估算"算口径偏差，量出 415×，其实是**漏算固定开销**而非 tokenizer 差异；② 看到"5 次 HTTP 请求 vs 4 行遥测"就断言"末轮丢行"，实际 `usageStats.llmCalls` 就是 4（HTTP 请求数 ≠ LLM 调用数）。取证据的正确姿势：包 `globalThis.fetch` 抓**真正发出去的请求体**（本轮靠它独立确认系统区哈希全程恒定 `c9cbef190aa1`），再与内部指标交叉验证；**任何"指标异常"先找同源计数对齐，再下结论**

- **子 agent 超出摘要阈值时的"全文"落 `{dataDir}/subagent-results/`，不落 `os.tmpdir()`、也不落 cwd**：macOS 会定期清理 `/var/folders/**/T`，而那份全文是**唯一一份**（`{dataDir}/tasks/<taskId>.json` 只存摘要）⇒ 落 tmp 等于随时丢数据。文件名必须**时间戳 + 随机段**（只用 `Date.now()` 会让同毫秒并发的子任务撞名互相覆盖）。默认阈值 `DEFAULT_MAX_RESULT_LENGTH = 8000` 字符（原 2000 太低：真机 9 份报告 4532~10195 字符，9/9 全被截断）

- **摘要提示语只许说"当前为真"的话，且判据要两个一起看**：① `ctx.variables.callerToolIds`（由 core 从 `allowedTools` 注入）里是否真有 `read_file`/`grep_file`；② 落盘路径是否在**调用方 `ctx.cwd`** 内（`read_file` 的边界是它，不是 harness 全局 cwd）。两者缺一 → **不许承诺可读**（承诺了模型必去试、试必被 `PATH_OUTSIDE_CWD` 拒）。历史事故：该字段曾**全仓无写入方**（只有测试手动塞），"可使用 read_file 查看"整段是死代码，真实提示是"请考虑拆分任务"——把"超了字符阈值"误报成"任务太大"

- **`AgentDefinition.maxSteps` 现在能从 agent md 的 `maxSteps:` 解析**（`-1` = 不限）；role 分档：`reader` = 35、`reviewer` = 25（20 是插件默认，实测 6/6 reader 触顶）。派工方还可用 `subagent({ maxSteps })` 按**本次任务**覆盖，优先级 **派工方 > agent 定义 > 插件默认**。**合法值只有 `-1` 与 `>= 1` 的整数**：`0` / `<-1` / `NaN` 一律判非法 → 视为未指定、回落下一优先级并告警（`normalizeMaxSteps` 是引擎侧唯一判定点；md 解析期也不接收）。注意 `0 ?? x` **不会**跳过 `0` —— 非法覆盖值必须在边界拦掉

- **工具调用"入参自愈"在 core，不在各工具**：失败且必填项没给全时，core 把该工具的必填参数（名/类型/描述，取自 `inputSchema.__jsonSchema`）+ 最小示例拼进回喂的错误消息（`[入参自愈] …`），**原 `message`/`code` 一律保留**。动机：真机实测模型在长上下文下会整段丢 tool-call arguments（100 次调用 37 次失败、34 次 `input:{}`，失败率随上下文从 12% 升到 50%）。必填已给齐、或无 schema/无必填 ⇒ **不掺和**

- **改可观测性 / 阈值 / 口径类逻辑，验证要分四层，且别用 mock 越界冒充真机**：L1 纯函数单测（分类规则、算术）→ **L2 端到端 mock**（真实引擎 + 真实插件 + 探针插件造 prompt 形态 + `MockChatProvider.usageSequence` 造逐轮用量台阶；样例见 `packages/cli/src/cache-attribution.test.ts`）→ L3 真机（临时 dataDir + 包 `globalThis.fetch` 抓真实请求体做**独立证据**）→ L4 产线遥测。**mock 能验"逻辑与装配"，验不了"系数取值"与"provider 真实行为"**。写 L2 探针时注意：**改动必须每轮重新施加** —— core 每轮从会话本体重建 messages，只改一轮会在下一轮被还原，看起来像"前缀又变了一次"

- **TUI（OpenTUI 0.5.8）交互的三条实测约束**，踩过就知道不能想当然：① **同一行里相邻两个 `<text>` 的命中测试不可靠** —— 点第二个（如 ✕）会被判到第一个上（debug 实测 copy 连触发 4 次、✕ 处理器一次没进）；要么合成**一个**元素用 `MouseEvent.x - currentTarget.screenX` 按列分派，要么只留一个可点元素。② **`selectionBg`/`selectionFg` 只对纯 `<text>` 生效**，`MarkdownOptions` 没有这两个字段 ⇒ 助手 markdown 块的选区配色改不了（恒为内核默认浅灰）；要"选中文字闪烁"就用这两个属性 + 定时切换，并接受 markdown 块不闪。③ **容器内子元素的宽度不要复用外层常量**：外层 `width` 含边框（26 里 2 列是边框，内部只有 24），子元素再写 26 就会把自身右边缘的滚动条挤出可视区 —— 内部一律 `'100%'`

- **点选区/列表类 UI 时，内容要存快照而不是点击时现取**：点 chip 的 mousedown 会让渲染内核**先清掉选区**，`onMouseUp` 甚至可能落在已卸载的节点上 ⇒ "点了没反应"。修法是 down/up 都挂 + 时间戳去重，并把内容存在 `selection` 事件里维护的快照中

- **TUI 测试两个坐标/颜色口径**：`captureCharFrame()` 的**行号会因交互位移**（拖选会冒泡选中整块、块上方插入「▌已选中」行，正文整体下移）⇒ 断言前重新 `locateChar`；`captureSpans()` 的 fg/bg 是 **0~1 浮点**（不是 0~255），拿 hex 直接比永远不等，要统一 `toFixed(3)` 口径。另：断言"chip 出现/消失"用 `inputLine()`（末行）而非整帧 —— 正文块里有同名的「⧉ 复制」

- **「任务完成」类事件必须在结果真正可消费之后才发布 —— 先入队、后发事件**。事件的下游（如 coordinator barrier → CLI 注入 `<continue/>` 续轮）收到事件会**立即**试着取数据；信号先于数据 ⇒ 取到空 ⇒ 判定"无事可做" ⇒ **放弃且不重试** ⇒ 已跑完的结果滞留到用户下一次发话才送达。真机（s_1790082671456_82ikm）：4 个后台 reader 21:22:15 全部完成、barrier 也触发了，通知却到 21:25:16 才随用户敲「?」进入对话。修法是把 `enqueueNotification()` 移到 `bus.publish(completed|failed)` **之前**，而不是在消费侧加等待

- **「判一次就放弃」是静默丢数据的常见形态**：任何"空转判断"（peek 到空就跳过）**必须退避重试**。两个独立异步分支之间**没有顺序保证**，靠一句 `setTimeout(0)` 去赌"一个宏任务内一定就绪"迟早会输（本项目就输过：结果滞留 3 分钟）。重试预算要远小于误判的代价（本项目约 1s vs 一次模型调用）

- **请求超过 ~15s 无任何输出就要有可见心跳**：静默卡死比报错更难自查 —— 用户分不清"卡住了"还是"任务本来就慢"，只能靠重发自救（真机首轮卡 7m20s，用户把同一句话发了三遍）。心跳不改任何超时语义，只结束"毫无反馈"这一段；间隔递增（15s → 60s），收到首个事件或本轮结束即停，**且必须在 `finally` 里停**（请求报错时循环体里的 stop 不会执行 ⇒ 定时器泄漏）

- **注入位置决定代价：会变的文本**绝不**放 system 区**。自动前缀缓存按最长公共 token 前缀命中，system 位于请求**位置 0**，它一变其后**整段历史**都要按全价重算（量化：越阈值时翻转一次 ≈ 95K token-equiv，回本要 366 次调用 —— 见 acp-context 的 `MANUAL_INJECT_MARGIN` 注释）。判断标准一句话：**这段文本会不会在会话中途变？会 —— 就走 `core.prompt.dynamic.transform`（尾部动态区）**。已迁：MCP resources（缓存只增不减）、memory 的一次性沉淀提示（出现一轮、下一轮消失，留 system 会付两次失效）；留在前缀的是恒定文本（agent promptFragments / skill 注入 / subagent roster / coordinator / 压缩记忆块）

- **尾部动态通道的两条硬约束（都不是风格问题）**：① 必须 `user` role —— `provider-anthropic` 的 `extractSystemPrompt` 与 `provider-gemini` 的 `extractSystem` 会把**任意位置**的 system 消息上提进顶层 `system`/`systemInstruction`（原位置直接跳过），用 system 挪到尾部等于把它送回前缀、收益归零；② 必须在 `core.session.preModel` **之后**拼接 —— 那是压缩插件的折叠/回写点，放它之前有被写进持久层的风险（尾部块每轮重算，落库就是脏数据）。core 已代管这两点，用 `packages/cli/src/cache-attribution.test.ts` 的对照实验（同内容 / 同变化幅度、**唯一变量是位置**）守住

- **`tokenCalibrationScale` 不是普适常数，取决于装配**。实测：极简装配下原始比值 ≈**1.33**；完整 CLI 装配（29 个工具、工具载荷 ≈16K tok 固定开销）下原始比值 ≈**1.14** —— 配 1.33 会**过校正 ≈16%**（`calibration` 读数 0.856）。残差的主因是 `estimateToolPayloadTokens` 的近似形状（只取 name/description/parameters），高估/低估工具载荷会整体平移该比值。**取值必须在目标装配下实测**：`bun run probe:cache`。⚠️ 探针会自检并在"历史占比过低"时打 ⚠️ —— 那种读数被固定开销主导，**不能**拿来标定

- **诊断"前缀缓存为什么掉"看遥测的 `cacheMissReason`，不要靠猜**：`providerCache` 行现在自带 `cacheMissReason`（`first-request` / `none` / `system-changed` / `prefix-mutated` / `prefix-shrunk` / `idle-expiry`）、`prefixStableMessages`、`prefixChangedKind`、`cacheDropTokens`、`idleMs`。判据来自 `diffPromptPrefix()` 对**上一轮真正发出去的 prompt** 逐条做**内容指纹**比对（`preModel` 末尾原地替换之后才是最终内容）。**为什么必须用内容指纹而不是 id**：既有的 `commonPrefixHit` 只比 `id`，同 id 消息正文被就地改写时它照样报高命中率——那是误导性的绿灯，比没有指标更糟；而"就地改写"正是本项目最可能的失效源（ACP 折叠/占位符替换）。指纹**刻意不含 `id`**：ACP 每轮的 HINT/nudge 临时消息 id 都是新的，算进去会让指标恒为 0

- **本地 token 估算与 provider 计费口径不是同一把尺子 ⇒ 用 `compression.tokenCalibrationScale` 显式校正**：真机实测（临时 dataDir 跑 3 轮 / DeepSeek deepseek-flash）稳定为 **1.33**（provider 输入 ÷ 本地**整包**估算 = 1.328/1.342/1.337/1.332，即系统性低估约 25%），校正后同一探针的 `calibration` 收敛到 **1.000 ± 0.011**。取数方法：读遥测 `providerCache.calibration`（每轮都打），连续几轮稳定即可。⚠️ **分母必须是"整包"估算（system + 工具载荷 + 消息），不是 ACP 的 `requestTok`** —— 后者只算历史 cores，拿它当分母首轮量出 **415×** 的假偏差（量到的是"漏算固定开销"，不是 tokenizer 差异）。引擎侧由 `core.llm.usage.localInputEstimate` 提供整包估算；`overheadTok = 整包 − 历史` 就是每轮重发的固定开销

- **`timeoutMs` 在流式与非流式两条路径上语义不同，必须分级**：流式里它是 **idle**（多久没数据判死），另有 `× STREAM_TOTAL_TIMEOUT_FACTOR(10)` 的总时长兜底；非流式 `complete()` 只有**一个总时长**计时器，此前直接用 `timeoutMs` ⇒ 同一件事（整段生成要多久）在非流式路径严 10 倍。真机后果：子 Agent 走 `preferComplete` 非流式路径审查 77KB HTML 撞 60s 被误判超时。修法：`completeTimeoutMs = timeoutMs × completeTimeoutFactor`（缺省与流式系数对齐=10，配 1 退回旧行为），三个 provider（openai/anthropic/gemini）统一

- **新增任何字段前先核实"有没有写入方 / 有没有消费者"**：本项目已连撞三次同类缺陷——`subagents:` 只解析不消费（已于 09-22 删除该字段）、`ctx.variables.callerToolIds` 只读不写、`agentFromMarkdown` 不映射 `maxSteps`（插件文档却让子 agent 在定义里写它）。判定手法：全仓 grep 字段名，确认写入点与消费点都存在，再动手

- **非法取值不要静默钳制到"看起来能用"的值 —— 要么回落、要么报错，且必须告警**：真机事故（09-22）——`maxSteps` 的归一化写成 `Math.max(1, Math.floor(configured))`，于是 ① `maxSteps: 0` 被**静默抬成 1 步**（子 Agent 一步就收尾，现象像「任务太小 / 模型不肯干活」，与「入参写错」完全对不上）；② `NaN` 直接算出 `maxSteps = NaN` ⇒ `step >= NaN` **恒为 false** ⇒ **步数上限被静默取消**（只有 doom-loop 守卫兜底，现象是"跑得很久"）。修法：`normalizeMaxSteps` 单点归一化，`-1`/`+Infinity` = 不限、`>= 1` 取下整、其余判为「未指定」并回落下一优先级 + `logger.warn`。判据一句话：**钳制后的值若与作者的本意无关，那它就是在掩盖错误**

- **删掉"只解析不消费"的死配置时，要留一条告警而不是静默忽略**：`AgentDefinition.subagents` 删除后，agent md 里仍可能有它（真实存在：`~/.harness/agents/coordinator.md` 列了 15 项）。静默删除会让作者继续以为它在生效、继续按它推理（"我限制了可派工范围"），所以 `agentFromMarkdown` 遇到该字段仍回调 `onWarn` 说明「已删除、无效果、请移除」。通用判据：**删一个曾经"看起来生效"的配置项，等价于一次行为变更，必须让它可见**

- **「值存在但为空」与「字段缺失」是两种状态，不许用一个 `if (x)` 混过去**：真机事故（09-22 提交后评审）——用量折叠的增量分支用 `hydrateUsage({meta, messages})` 取起点，而它在累积器为空时会**回退到按消息重建**，重建用的 `messages` **已含当前消息** ⇒ 随后再 `foldMessage(message)` 就是第二遍（实测 `llmCalls=2` / `input=300`，正确值 `1` / `150`）。触发条件：某轮 assistant 既无 `tokenUsage` 也无工具调用（provider 未回报用量 / 流式中断）⇒ 折叠后累积器恰好**完全为空**（`llmCalls=0` / `hourly=[]` / `tools=[]`）但检查点仍然有效 ⇒ 下一轮双计。修法：用 `usageFromMeta(...) !== undefined` 区分「存在但为空」（合法状态 → 直接增量折叠）与「字段缺失」（→ 全量重建）。凡 `if (obj.field)` / `x || fallback` 这类"空 ≡ 缺"的写法，先问一句：**空值本身是不是有意义的合法状态？**

- **归因指标的"视野"必须剔除调用方自己每轮现拼的内容，否则会把「版本增长」误读成「内容改写」**：真机事故（09-22 提交后评审）——ACP 每轮在请求末尾现拼尾部动态块（nudge / 压缩手册），它不属于缓存前缀；历史增长一条时，上一轮的尾部块在逐条比对里与「新历史的第一条」相撞（上轮它占 n−1，本轮历史占了 n−1）⇒ 每一轮都报 `prefix-mutated`（"中段某条被就地改写"），而前缀其实完好，排查方向被引向"谁改写了历史中段"。修法：比对前剔除本轮自己追加的尾部块（两轮各自剔除 ⇒ 视野对齐在纯历史前缀上）。通用判据：**凡"逐条比对相邻两轮"的指标，先划清哪些条目是自己造的、不属于被观测对象**

- `/tools` 工具管理命令由插件 `@harness/tools-manager` 提供（`cli.command` hook）：Agent 白名单启停经 cli 注入的 `setAgentTools` 持久化到 config.json 的 `agents[].tools`，`--global` 启停走运行时 `harness.tools`，本地缓存被卸载 Tool 以便恢复

- 插件要持久化 config.json 时不直接自持读写，优先经 cli 注入的 `setAgentTools` / `CliCommandInput` 扩展字段（`agentId`/`harness`），保持解耦

- 内置插件/工具采用**多级加载**：L1 静态元信息（`tools-builtin/src/meta.ts` 的 `BUILTIN_TOOL_META`、`tools-search/glob/web/media` 各自的 `meta.ts`，纯数据、不 import 各自 index.ts）经 `@harness/tools-builtin/meta` 等 `./meta` 子路径提前登记到 cli 的 `BuiltinToolRegistry`（`getBuiltinToolRegistry()` 一次性 `registerAll` 覆盖全部随应用打包工具插件）；L2 运行时模块仍经 `BuiltinPluginRegistry.load()` 惰性/后台加载。`CliCommandInput` 注入 `toolMeta?: ToolMetaLookup`，工具管理命令据此在运行时未加载时也能展示描述/别名/安全声明/权限键，并输出 `ID | 元信息(描述) | 权限键 | 状态`（状态=启用/禁用·已加载/仅元信息·安全声明）对齐表格；boot 末尾 `scheduleBuiltinPreload()` 后台静默预加载（fire-and-forget，`Promise.allSettled`，失败仅 `[WARN]`，`backgroundPreload:false` 可关闭）

- bash 工具走沙箱工厂 `createBashTool(config)`：危险命令检测（前置硬性拒绝、回退也不可豁免）/ cwd 限制 / 命令白名单 / env 隔离；`fallbackToHost` 开启时非破坏性命令沙箱失败可提升宿主 bash 重跑并标 `viaHost`，回退前经权限确认（`requireHostApproval`，复用 bash key，pattern 前缀 `host:`，ask 模式下再次询问）

- bash 工具 `ok` 语义：执行成功即 `ok:true`，命令结果由 `exitCode` 反映；仅 spawn 失败/AbortSignal 中断时 `ok:false`

- 工作区两级目录：user `~/.harness` 与 project `<cwd>/.harness`，project 覆盖 user；`dataDir = args.dataDir ?? ~/.harness` 承载 `config.json`/`permissions.json`/`sessions/`/`.config-key`/快照数据

- 文档索引：架构 `docs/agent-harness-architecture.md`、开发日志 `docs/development-log.md`、工作区模块 `docs/workspace-management.md`、代码情报插件规划 `docs/codeintel-plugin.md`、MCP 服务使用 `docs/mcp-services.md`、ACP 压缩配置参考 `docs/acp-context-config.md`

- **步间闸门 `core.agent.step.gate`（引擎层）挂靠在「续轮」上，不是挂在「空转」上**：检查点 = 每个步边界、即每次模型推理开跑**之前**（`step >= 1`，第 2 步起）；此处引擎**不可能知道**这一步将产出 `tool_calls` 还是最终答复（那是本次推理的结果，尚未发生）⇒ 只要插件报 `pending` 就等，**与这一步的产出形态无关**。真正的触达条件是 `shouldContinueStep()`（判据 `toolCallCount > 0` 且 finish 正常）——**上一步没调工具时本轮直接结束，闸门根本不会被触达**。所以「有 tool call 就不等」是**反的**：恰恰是有 tool call 的步才续轮、下一步开跑前才经过闸门。真机语境里的"空转"指**有 tool call 但无进展**（反复 read_file/bash 查状态），这类步同样续轮、同样被闸门减速。**语义是「每个步边界最多等一档」**（写成 `while (gateClosed)` 会在对端恒报存活时无限卡死）；**档内再分片重探**（`STEP_GATE_SLICE_MS`，默认 500ms）：每过一片重问一次，插件静默即**提前结束这一档**（最多白等一个切片），因此 `step_gate` 的 `waitMs` 报的是**实际**等待、被提前结束时另带 `plannedMs`（原定档位）—— 报「等了 3s」而实际 0.5s 就是假信息。多插件合并是 **OR**、`aliveCount` 取最大；`STEP_GATE_MAX_TOTAL_MS`（默认 300s）已从"终止兜底"改为**提醒阈值**—— 累计等待超过后每档等待带 `overBudget: true`、UI 提示"可能卡死/异常"，但**不会停止等待**；真正终止交还给"插件不再报存活 + 用户中断"，**不要把预算当作硬性停止条件**（旧设计把它当总预算、耗尽即跳过，会让"任务只做一半就撞预算、结果真正跑完却没等到、下一轮才送达"——真机 s_1790163574429_tg1a6）。探测为"静默"时只把**阶梯归零**（下一波派工从最小档重起），**不是关闸门** —— 每个步边界仍会重探（同一轮里 coordinator 可能再派一批）。默认阶梯 `[3s,6s,12s,24s,48s,60s]`，可经 `AgentHarnessOptions.stepGate` 注入覆盖（测试压到毫秒级）。等待**必须发 `step_gate` 事件**（>15s 无输出要有心跳）、CLI 进 `waiting` 相位。纯函数 `stepGateDelayMs(n)` 对 `NaN` 必须显式落 0 档——`Math.floor(NaN)` 是 NaN，索引出 `undefined` 且类型上不报错。**该 hook 必须纯内存、禁 IO**：分片后单档最多被调 `档位 ÷ 切片` 次（60s 档 = 120 次）、整轮可达数百次；签名是 `Awaitable` 只是与其它 hook 保持形态一致，实现里不该 await 任何 IO（那等于把一次等待放大成几百次磁盘/网络往返）。`sliceMs=0`／负数／NaN ⇒ 关掉切片、回退整档硬等（`normalizeGateSliceMs` 是唯一归一化点；负值喂 `setTimeout` 会退化成**忙等**）

- **`coordinator.worker.completed`（单任务完成即唤醒）与 `barrier.completed`（全波收尾）是两条事件**：前者**仅在 `remaining > 0` 时发**（最后一个走 barrier），否则外层会注入两行 `<continue/>`。**`remaining` 必须在 `tracker.onWorkerFinished()` 之前算** —— 后者在计数归零时会 `active.delete`，之后再问 `activeCount()` 恒为 0（"快任务完成也报 0"⇒ 事件永远发不出来）

- **"免费额度 / 豁免"一律必须封顶**：`MAX_SELF_HEAL_FREE_STEPS = 3` 是「必填全缺回喂免计一步」的必要兜底 —— doom-loop 只认「同一工具+同一入参连续 3 次 / 连续 3 步整步签名相同」，**`A,B,A,B…` 交替空参能完美绕开它**；不加天花板就会架空 `maxSteps` 这个唯一刹车。`billedSteps`（吃额度）与 `step`（展示步号）是两套计数，`turn_end` 带 `freeSteps` 解释二者为何不一致

- **中途草稿用"正常结束即删"编码语义**（比额外维护状态标记可靠）：文件存在性本身就是状态 ⇒ **有草稿 ⇔ 这次被掐断**。触发点用**步边界**而非定时器（步边界本就是天然刷盘点）；按 taskId 固定命名 + 覆盖写（同毫秒并发不撞名）；草稿状态必须声明在 `try` **之外**（catch 要用）。落盘仍守既有约定：`{dataDir}/subagent-results/`，**不落 `os.tmpdir()`、不落 cwd**；失败路径给的可读性说明必须**如实**（能不能被 `read_file` 读到要实测判定，不猜）

- **"留存"与"可消费"是两件事：被掐断的任务要把进展**正文**回传，不能只给路径**。草稿/全文落在 `{dataDir}` 下，而调用方 `read_file` 的边界是**它自己的 `ctx.cwd`** ⇒ 路径给了也读不到（真机 `s_session_1790593024558_ced93`：reviewer-4 被 120s 掐断，24 条工具日志全在草稿里，父 Agent 读不到、只好自己重做 **25 轮 / 148 万 token**）。所以失败消息里带一份**进展摘要正文**（工具名 + 入参预览 + 成败 + 已写出的部分正文，`PARTIAL_DIGEST_MAX_CHARS = 4000`，与同域的 20k 落盘档案刻意不同口径）；前台路径原本**连草稿都没有**，从子 session 消息里摘即可。摘要只许说"跑到哪了"，**不许编结论**——被掐断的任务本来就没有结论

- **同一件事的"展示"与"执行"必须共用一个判据函数**：`/tools` 展示的是"模型能调什么"，它若自己再算一套（`tools-manager` 的 `agentAllowedTools` vs core 的 `supplyMcpTools`），两边一旦分叉，用户会把**其实能调**的工具读成「禁用」——比不显示更坏。做能力边界类改动时，把判据抽成一个导出函数让两侧共用，并各留一条断言

- **"提醒类"注入的触发条件要用「真出过问题」的直接信号，而不是拿占用率之类的代理量去猜**：B2-3 初稿按"上下文超阈值"注入"工具调用必须带全 arguments"，但真机那次 14 次空入参的会话 occupancy 峰值只有 **22.83%** ⇒ 任何长上下文阈值（25%/35%）都不会触发，等于没修。改用 `core.tool.params.missing`（与 `selfHealOnly` 免计额度同源的直接信号）置一个**粘性**标记，本会话真丢过参数才提醒：零猜测、零误报。**注入位置一律走尾部**（`core.prompt.dynamic.transform` / ACP 的 tailParts），放前缀则每翻转一次都要连带重算其后整段历史

- **测试块约定：顶层 `describe` 不继承外层 `beforeEach/afterEach`** —— 往已有测试文件里追加独立 `describe` 时若忘了自带 setup/cleanup，会因外层 `afterEach` 已清掉临时目录而 ENOENT/`SPAWN_ERROR`（表现为"新写的用例莫名失败"）。另：`ToolResult` 是**非判别联合**（`ok: boolean` + 可选 `output?/error?`），`if (!r.ok)` **不收窄**类型，断言写 `r.error?.code` / `r.output?.exitCode`

- **遥测（telemetry）通道按「事实归属」选，绝不给同一件事开两条通道**：三类落法各有适用面，别一刀切——
  · **core/引擎层已有 hook 的事实**（如整轮终态 `core.agent.turn.end`）⇒ **注册那条 hook**（telemetry 现在这么做，落 `telemetry.turn.end`）。**不要**再补一条同义的 bus 事件：同一个事实两条通道就是历史事故的翻版（同一个名字由两层分别触发 ⇒ 消费方分不清来源、按轮计数翻倍）。
  · **引擎自身的执行事实、且非流式通道上还是空白**（如闸门处置 `AgentEvents.stepGate` / `agent.step.gate`）⇒ **在 core 定义 bus 事件并由引擎发布**。判据不是"core 的事就该走 hook"，而是**现有通道里有没有同义的**：`core.agent.step.gate` 那条 hook 是**输入侧提问**（"还有存活任务吗"），等待的**结果**（实际等了多久、睡了几片、是否被提前结束）回不到 decision 对象里 ⇒ 不构成"同义双通道"。**同时**：`step_gate` 流事件只到 UI（进程结束即蒸发），所以"已经上报过了"是错觉 —— 遥测里仍是零。
  · **同一事实的两个消费者 ≠ 两条通道**：流事件给 UI、bus 事件给遥测/其它插件，是**一份事实往两个消费者投递**，且只有引擎一个发布方；被禁的是**同一件事有两个发布入口**。判断方法：问"这条事实有几个地方会发它"——>1 就是事故原型。
  · **插件自己产生的事实**（如 subagent 的草稿归属）⇒ **走 bus**（`SubagentEvents.draft`）：telemetry 是通用插件，**不该 import 具体插件的类型**，只能靠 bus 解耦。
  · **两条通道都是"聚合后抛"，没有哪条更安全**（别想当然）：`bus.publish` 用 `Promise.allSettled` 并发跑完**全部**订阅者，再把失败收成 `AggregateError` **抛出**；`PluginManager.trigger` 顺序跑完后同样抛。⇒ **凡上报类事件一律挂 `.catch(() => undefined)`**（本项目惯用写法：subagent 的 `bus.publish(...).catch(() => {})`、core 的 `void ...triggerPlugin(...).catch(() => undefined)`）。**上报绝不能顶掉主语义** —— 尤其别让一条遥测把 agent 主循环带下水。
  · **插件已有自己的遥测 writer**（acp-context 的 `sessions/*.telemetry.jsonl` 自有 schema）⇒ **扩自己的 schema**，不要绕道 telemetry。
  「新事件自动入明细」是 telemetry 的设计（`subscribeAll` → `telemetry.bus.<name>`），所以走 bus 时**不必改 telemetry**；改的是"要让 kind 语义化/要派生指标"的时候。
- **布尔字段在遥测里会被自动折叠为 `0 | 1`**，不必手写数值：`pickAttrs` / `pickMetrics` 的 `asNumber()` 已支持（此前只收 `string | number` ⇒ 载荷里的布尔被**静默丢弃**，消费方只能把"字段不存在"当 false，分不清"真是 false"与"压根没采到"）。已确认曾中招：`SubagentEvents.*` 的 `background` / `isContinuation`、`AgentTurnEndSignal.aborted`。事件契约里**照写布尔**（说人话），折叠是提取层的事。注意 `0` 是有意义的值 ⇒ 别指望"缺省即 false"和"显式 false"在落盘后还能区分。

- **不许为"实际到不了的状态"造契约值（枚举/字段/分支）**：闸门遥测初稿写了 `skipReason: 'aborted'`，但中断在**循环顶部的步边界检查**就 `break`（`if (signal?.aborted) break` 在闸门那段之前）⇒ 闸门根本不会被问到，那个值永远是死码。写之前先问"**哪条路径能走到这里**"，验证方式是**写出触发它的那条用例** —— 写不出就是不可达，删掉而不是留着"以防万一"（留着会误导消费方以为"中断也会记一条"，还在给下一轮埋"配了没用"的坑）。同族历史：`subagents:` 字段只解析无人消费、摘要提示语的判据 `ctx.variables.callerToolIds` 曾全仓无写入方。

- **提示词（agent 提示词与工具提示词）一律放独立 `prompts/*.txt`，改提示词不动代码**（现状即如此：`cli/src/prompts/default-agent.txt`、`coordinator/src/prompts/coordinator.txt`、`subagent/src/prompts/*`）。改完要在测试里钉住**关键约束本身**（如"默认指令含结论段/禁流水账/限 60 行"），否则下一个人删掉一句完全看不出来

- **Agent 提示词必须同时写「执行纪律」与「输出纪律」，两条缺一不可**：① 执行纪律 = 只做当前这一步该做的事（用户没要求的重构 / 额外检查 / 顺带修复一律不做；先定"这一轮交付什么"，交付即停；发现别的问题最多记一句备注，不擅自展开）；② 输出纪律 = 1-3 句 + 必要证据（路径 / 行号 / 命令输出关键行），不写开场白、不复述任务、不写过程流水账、不写"接下来可以…"的建议清单、不写客套。判据一句话：**放进上下文的每一句都得能改变下一步决策，否则就是付费噪音**（它会进历史、每轮重发）。同理适用于 coordinator：不播报进度（"我正在派 worker…"），每轮只输出这一轮的**决策结果**

- **派工（subagent）的 prompt 必须自包含五要素**：① 一句话目标；② 相关路径 / 符号 / 行号；③ 你已有的结论与约束（别让它重查）；④ 验收标准（怎样算完成）；⑤ 范围边界（不要做什么）。**子 Agent 看不到父会话**，"看一下 X 有什么问题"这类缺目标缺路径的派工只会换回泛泛而谈。清单要**同时**写进工具 `description` / `documentation` / `inputSchema.prompt` 描述与 roster 末尾 —— 模型最先看到的是 schema 描述，只写在文档 txt 里等于没写

- **子 Agent 的回传同样要约束（插件级默认 directive）**：子 Agent 的整段回复会**原样**进父 Agent 上下文 ⇒ 不加约束就会被"我先读了 X、然后发现 Y"的过程复述灌满（真机 9 份报告 4532~10195 字符，大半是复述）。`createSubagentPlugin` 默认注入 `SUBAGENT_OUTPUT_DIRECTIVE`（结论 / 依据 / 变更 / 未决 四段 + 60 行上限 + 禁流水账、客套、建议、无据结论），宿主可传自己的 `directive` 覆盖，**传空字符串关闭**；`createSubagentTool` 的 directive 参数仍是"不传即不注入"（保持工具可独立测试）

- **回传内容的"省略"必须如实写出来**：工具调用摘要合并同类为 `- read_file: /a.ts ×20`（次数是事实，不能丢），条数上限 `TOOL_SUMMARY_MAX_ITEMS = 12`，超出时在末尾写"其余 N 次已省略"。**静默截断会让父 Agent 以为"它就动了这些"**，与"摘要提示语不许承诺读不到"是同一条纪律

## 5. 工程约定

- 自定义错误类定义在各模块（`*Error`），不抛裸字符串

- 工具拆分：内置原语（文件读写 + Shell，`tools-builtin`/`tools-search`）与场景化业务插件分离

- 插件采用统一模式：自包含 helper + `createXxxPlugin` 工厂 + `core.tool.pool.assemble` Hook 注入；一个插件模块可同时导出 AgentPlugin（`default`/`plugin`/`plugins`）与 Provider 类型工厂（`providerTypeFactory`/`providerType`+`createProviderPlugin`）

- 插件注册技能：在 `core.harness.init` hook 里用 `harness.skillManager.register(skill)`，`loadedFrom: 'plugin'`

- TUI 使用 OpenTUI（@opentui/core + @opentui/react），保留会话内核 `createProcessLine`，仅替换渲染层

- 会话压缩阈值基于模型上下文窗口百分比动态计算（默认保留 30000 token 后窗口的 80%）

- **工具必须带参数 JSON schema**：`withJsonSchema(schema, {...})`（或 MCP 服务端 inputSchema 透传）——这是 provider 生成 tools 载荷时模型认识参数的**唯一**渠道（openai/anthropic/gemini 都读 `inputSchema.__jsonSchema`），缺失即退化为空对象 schema，模型只能空参瞎猜并原地空转（实测 25 步）。新工具不写 schema 视为缺陷

- **schema 声明必填 ≠ 运行时校验**：schema 只影响模型"看不看得懂"，缺参的保护必须在工具 `call` 入口自己做。反例（真机会话实测）：`bash {}` 被送进 shell 得到 `bash: undefined: command not found`；`task_create {}` 在 `sanitizeName` 里抛 `name.trim` 的 TypeError；`task_list {}` 静默返回 `[]`（无法与"真的没任务"区分）。凡必填参数一律在入口挡下并返回 `{ ok:false, error:{ code:'XXX_REQUIRED' } }` 形式的结构化错误

- **文件工具的边界语义（刻意不对称，别再摇摆）**：`read_file` / `write_file` / `edit_file` 只在**工作目录内**工作（`PATH_OUTSIDE_CWD`），这是"防误触 + 防越权写"的作用域约定；`bash` **不做读取面限制**（它的 cwd 受限、危险命令有黑名单，但读什么路径不拦）——bash 本就被权限系统与危险模式单独把关。真机实测过模型会绕过：read_file 被拒后立刻改用 `bash cat <绝对路径>` 读同一文件（3 次里成功 2 次）。这是**已知且接受**的行为，不要在提示词里引导"用 bash 绕过"，也不要把 read_file 的拒绝文案写成绕过指引；若将来要把 cwd 变成硬安全边界，须同时收紧 bash 的读取面（属架构级改动，需先拍板）

- **prompt 前缀只放恒定文本，会变的注入一律放尾部**：provider 的自动前缀缓存按**最长公共 token 前缀**命中，所以放在历史之前的文本一变，其后**全部内容（含整段历史）**都要重算。真机量化（ACP 压缩手册，越阈值时前缀 ≈ 105K tokens）：翻转一次 ≈ **95K token-equiv**，而按需省下的只有 ≈ 259 token-equiv/次 ⇒ 回本要 366 次调用，**对会越阈值的会话是净亏**。改造后手册改为 `user` role 注入尾部，前缀只留恒定的一行提示（`COMPRESS_MANUAL_HINT`）。细节与量化过程见 `docs/usage-accounting-and-prompt-cache-plan.md` §3

- **想让注入落在"尾部"，必须用 `user` role**（`system` 会被上提）：`provider-anthropic` 的 `extractSystemPrompt` 与 `provider-gemini` 的 `extractSystem` 会把**任意位置**的 `system` 消息抽进顶层 `system` / `systemInstruction` 字段（原位置直接跳过）⇒ 把 system 消息挪到数组尾部**等于没挪**，它会回到前缀、缓存收益归零。只有 `provider-openai` 保持原序，不能指望它。nudge 一直用 `user` role 就是这个原因

- **跨轮/跨进程的累加必须带 checkpoint + 自愈**：引擎每步把用量折叠进 `session.meta`，靠「已折叠到哪条消息」的检查点保证幂等；检查点指向的消息若不在（`/compact`、`deleteMessage`、手工改过）就退化为**全量重建**。增量与重建必须共用同一个折叠函数（`foldMessage`），否则自愈那一刻数字会跳变。只做累加不做幂等，会把「空累积器覆盖历史 ⇒ 重连后清零」变成反面的「历史被重折 ⇒ 数字翻倍」

- **用量口径引擎层唯一**：`meta.usageStats` 只由 core 的 `accumulateUsage` 写（每步折叠一次），宿主（TUI/REPL/headless）一律**只读**（`harness.usage.get()`），落盘走脏会话刷盘（`updateMeta` 标脏 + CLI 轮末 `flushDirtySessions`）。宿主自己也写会与引擎分叉 —— 之前正是只有 TUI 会写，导致 headless 宿主与**子 agent 会话**完全不入账。子 agent 用量按会话各自累积，父会话的聚合在**展示层**做（`usage.children()` + `sumUsage`），不要并进父会话 meta（会让同一条链在"全部会话·当日"里被重复计入）

- **Anthropic 侧此前压根没开 prompt 缓存**：它的缓存在 API 层需要显式标 `cache_control`（OpenAI/DeepSeek 是自动前缀缓存，无需配置）。已实现断点（`AnthropicProviderConfig.promptCache`，**默认 false**）：tools 末尾 / system / 当前对话末尾共 3 个（协议上限 4，写入 ≈1.25x、命中 ≈0.1x）。**默认关是因为开发机没有 Anthropic key、无法真机验收**（只有请求体形状的单测）。验收方法：第二次同前缀请求的 `usage.cache_read_input_tokens > 0`，且 `cache_creation_input_tokens` 只在首次/前缀变化时出现；通过后才把默认值翻成 true。同一处顺带把 `complete`/`stream` 里**逐字重复的两份 buildBody** 合并成一个 —— 加请求参数只改一处的意义就在这（"只改了一处"是本项目反复出现的静默失效来源）

- 与外部工具/服务对接协议时（herdr 这类终端/服务集成）**以真机为准**：官方文档没写清的边界必须实测确认后再实现。已知的三个坑都在文档之外且**静默失效**（读代码看不出来）：① 上报用过 `--seq` 后，`release-agent` 也必须带一个更高的 `--seq`，否则被 Herdr 当旧序号丢弃；② 序号水位线按 (pane, source) 存、**跨进程不重置**，新进程从 1 起算的前 N 条上报会被静默丢弃（故序号基线取微秒级时钟）；③ `process.once('exit')` **覆盖不到信号退出**（SIGTERM/SIGHUP 直接终止进程，而"关 pane"就是 SIGHUP），信号类退出必须单独挂监听，且不能抢 SIGINT（REPL/TUI 用它表示"中断当前查询"）。详见 `docs/development-log.md` 续 158

- **归因视野要覆盖"框架注入、且不在缓存前缀内"的内容，否则会把"有代价"读成"无异常"**：`prefixChangedKind` / `cacheMissReason` 只看**前缀**，而 core 的尾部动态区（`core.prompt.dynamic.transform`：MCP resources / memory 提示 / 条件 skill）是在 `core.session.preModel` **返回之后**才拼成请求末尾那条 `user` 消息的 —— preModel 里的插件按 `messages` 建视图时**根本看不见它**。后果：anthropic 显式 promptCache 断点打在最后一条时，末尾那条每轮现拼 ⇒ 最后一段必然 cache write，而归因报 `none`（前缀确实没动），这个成本在遥测里**没有任何解释**。修法：core 经 `SessionPreModelInput.dynamicParts` 把片段告知 preModel，ACP 记规模并在 providerCache 行输出 `tailDynamicParts` / `tailDynamicChars`。通用判据：**归因说"一切正常"时，先确认它的视野覆盖了请求的全部来源**（前缀 / 尾部动态区 / 工具载荷），漏看一处就会把有代价读成无异常

- **不要对同一个文件并行发起多个编辑**（工具使用纪律）：并行编辑是"各自读取 → 各自写回"，两次读取都发生在任何写入之前 ⇒ 后完成的那次基于旧内容，**把前一次的改动整段覆盖掉**，且两次都报成功。本轮实测丢了 3 处（core / plugin 的 `dynamicParts` 定义、acp-context 的 hook 传参），全靠收尾 `grep` 关键标识符 + 测试断言失败才反查到 —— 其中两处只表现为"测试期望值对不上"，极易被当成逻辑 bug 去查错方向。批量改同一文件时按「改一处 → grep 复核落点 → 再改下一处」推进；**跨文件才可以并行**

- **展示层不得丢弃上游已给的完整信息；要截断必须"看得见"**：`tool_call_start` 的 `input` 与 `tool_call_result` 的 `result` 都是**完整值**（core 的事件注释明写"含 input 完整值"），而 CLI 展示层曾写死 `JSON.stringify(input).slice(0, 60) + '...'` 与 `result.slice(0, 120)` —— 用户看到的是一条**已被改形**的命令（少了重定向、少了后半段管道），末尾那个 `...` 只说明"被砍过"、不说明砍掉了什么，复核得回去翻原始日志；长输出（grep / read_file / 测试日志）的结论永远落在 120 字符之外，用户只能让模型复述一遍 = 多烧一轮上下文且可能失真。判据：**截断只允许出现在"数据进上下文"的那一层**（如 `resultMaxChars`，有明确预算理由），**展示层默认完整**；确要截断必须带可核对标记（省了多少、原文在哪）。同理，序列化的兜底路径也不能丢内容（`String(cyclicObj)` → `[object Object]` 等于又丢一次；用 `util.inspect(v, { depth: null, breakLength: Infinity })`）

- **多行 console 文本的归属要显式声明，别让逐行分类器猜**：TUI 的 `pushConsole` **逐行**分类，未命中前缀（🧑💭🤖🔧✅❌⏱️）的行一律落成 `system` 块 ⇒ 多行工具结果会被劈成「tool 块 + system 块」两块。而 tool 块渲染器**本就按多行设计**（首行加粗 + 结果行自动补 `│`/`└` 树状缩进），且**每块各带一个「⧉ 复制」按钮** ⇒ 一次工具调用冒出两个复制按钮。修法：续行带**传输用**标记 `TOOL_CONT_MARK`(`┆`)，`classifyConsoleLine` 认它并**剥掉**（界面与复制出的文本都看不到）；且**只在 TUI 模式加** —— REPL 是直写 stdout 的纯文本通道，带标记等于往用户眼前打符号（判据现成：`onEvent` 的 presence 即"TUI 结构化模式"）。通用判据：跨层的东西要有**显式的传输约定**，靠启发式（"不认识的行就算上一块的下文"）迟早把 `ℹ️ …`、`/tools` 表格这类**合法的独立行**粘进上一块

- **"完整"≠"无界"：上限要加在**渲染层**，而且要按「渲染行数」算，不是按文本行数**：把 `slice()` 整段拿掉后，一条 `bash {command:"seq 1 3000"}` 的输出占满几十屏，而 TUI 的 scrollbox 是 `stickyScroll stickyStart="bottom"` ⇒ 对话框里只剩结果尾巴，`🔧 工具名 {入参}` 被挤出视口（用户报"对话框里没有工具调用信息了"，真机帧里 `contains('🔧') === false`）。修法三条：
  · **块文本保持全文**，只在**渲染**时收窄 —— 否则「复制全文」无从取全文（传输层截断 = 永久丢内容）；
  · **按「工具调用段落」分段**（🔧 行起、到下一条 🔧 行前）而不是按整块收窄：`pushConsole` 把一次应答的所有 tool 行合并成**一个**块，按整块收窄会把中间几条工具的 `🔧` 行整段切掉 —— 那正是要修的毛病；
  · **行数预算 + 字符预算都要**：行数挡"很多短行"，字符挡"少数超长行" —— 工具返回**对象**时 `JSON.stringify` 把换行转义掉 ⇒ 结果是**一整行** 16000 字符，80 列终端折成 ~13 行，只限行数等于没限（首版就栽在这里：行窗口生效了、`🔧` 仍不在画面里）。单行另设上限挡 `write_file` 的 content（JSON 单行能到几十 KB）。
  省略必须**看得见**（省了多少行/字符 + 完整内容怎么取），并且"一屏"按**最小 80×24** 算 —— 写这类回归用例要断言**真实渲染帧**（`captureCharFrame()`）里有 `🔧`，纯函数断言证明不了"看得见"

- **写"防守卫"的断言时，要确认它真的只被目标行为满足**：工具回显那轮首版断言写的是"整段输出里包含完整命令"，回退验证（把 slice 加回去）**照样通过** —— 因为 `bash` 的 output 里**回显了 command**，那份回显把被截断的入参行蒙混过去了。断言必须**盯住被改的那一行**（`text.split('\n').find(l => l.startsWith('🔧'))`）。**"回退后变红"是断言有效性的唯一证据**；只看绿灯会把无效断言当成覆盖到位。造场景同理：要测"多行字符串结果"就不能用内置工具（`output` 全是对象，`JSON.stringify` 会把换行转义掉），得注入一个返回 `'a\nb\nc'` 的工具 —— 这才是 MCP 工具的真实形状（`mcp-client` 返回 `texts[0]` / `texts.join('\n')`）

- **同一份会话数据，实时通道与历史恢复通道看到的东西必须一致**：TUI 铺历史只有一个入口 `messagesToBlocks`（启动自动恢复与 `/resume` 共用），而它经 `messageText` 只拼 `text`/`reasoning`，**`tool` part 被无声跳过** ⇒ 恢复出来的会话只剩「提问 + 结论」，中间每一步工具干什么全不见（用户报"会话恢复后工具输出不显示了"；真机 `~/.harness/sessions/*.json` 里 tool part 挂在 assistant 消息上，带 `toolUseId`/`toolId`/`input`/`result`/`isError`）。判据：**渲染一条历史消息时，part 列表就是真相** —— 逐个 part 都要有归宿（`tool` → `tool` 块，形状与实时输出逐字一致，复用 `formatToolInput`/`formatToolResult` 那**同一对**函数，否则两条通道会走两套渲染）；**正文与工具不能合进一个块**（正文走 markdown、工具行走等宽树状，混在一起必有一方被当错的语法渲染）。这类"漏掉一整类 part"的缺陷有个共同征兆：**新加的自动行为把它从"偶尔遇到"变成"每次都在眼前"**（这里是 `0fb36a7` 之后启动即铺历史）

- **断言视觉输出前，先确认东西已经"画出来了"**：探针里 `waitFrame(f => f.includes('❯'))` 一命中就取样，恢复出来的助手正文**看起来全是空白**，一度误判成"恢复后正文也看不见"。真相是 OpenTUI 的 `<markdown>` **不是首帧就绘制**（工具行/用户行是 `<text>`，首帧即出），要多 pump 几十帧才出现。判据：**帧断言要留出稳定的绘制窗口**（固定多 pump 一段再取样，或用"直到出现目标内容"的谓词），否则会把"还没画"误判成"画不出来"，进而照着假根因改错方向

- **"注册"是配置事实，不是可改写管道**：`harness.providers.register/unregister/setDefault` 与 `harness.agent.register/unregister` 都**刻意不给管道 hook**（不加 `core.provider.register` 这类）。hook 是 `(input, output)` 可改写管道，给注册加一条等于允许两个插件**静默抢注册同一个 id** —— 那正是 `Hooks` 注释警告过的"同一个 hook 名出现两个来源"。要观测用 bus 事实事件（`provider.registered/unregistered/defaultChanged/resolveMiss`、`agent.registered/unregistered/reregistered`），要干预请改配置

- **注册键由调用方给，不由被注册对象自报**：被注册对象只知道自己「是什么类型」，不知道「这次装配的实例叫什么」。`AnthropicChatProvider` 里 `readonly id = 'anthropic'` 作**类型标识**是对的，但拿它当**装配实例的唯一键**就错了 —— 同一份 config 数组里可以有两个 anthropic 端点（`ProviderConfig.id` 注释明写支持"同一模型挂多个端点"），两个实例自报同一个 id 就会在注册表里互相覆盖，`agent.model.providerId='a2'` 静默回退默认（已修：实例 id 取自 `config.providerId`，工厂从 `ProviderConfig.id` 透传，注册走显式键）。通用判据：**任何"按 id 入表"的地方，先问这个 id 是"谁给的"** —— 对象自报的 id 只在"一类东西只有一个实例"时才安全

- **默认值要显式裁决，别用"注册顺序"当语义**：CLI boot 曾靠「默认 Provider 放最后注册 ⇒ 兜底无前缀模型」，注释把顺序写成了语义。改成构造完所有实例后显式 `providers.setDefault(id)` 后，"注册 / 设默认"两件事才分开，`unregister` 掉默认才有确定行为（回落"首个已注册"）。旧路径 `_setChatProvider` 保留但降级为**委托**（= 按 `p.id` 注册 + 设默认），16 处老调用点行为不变 —— 渐进迁移，不做一次性大改

- **每次覆盖都要看得见，但"正常路径"的 WARN 要能压掉**：Agent 同 id 重新注册发 `agent.reregistered { id, from, to }`（**给前后两个来源**：覆盖最需要看见的是"改动前后各是谁注册的"，只给 id 归因不了），并打 WARN；但 `AgentRegisterMeta.overlay` 标记的**文档化覆盖链**（options → dir:user → dir:project → config）与用户显式操作（`/tools` 落盘）豁免 WARN —— 每次启动都刷一条 WARN 会把真正异常的那条淹掉。**事实靠事件可见，噪音靠 overlay 压掉**。来源本身用 `WeakMap<AgentDefinition, string>` 持有，**不给 `AgentDefinition` 加字段**：来源是"注册这件事"的属性，加字段会跟着 md 序列化 / 快照落盘，还会在每次覆盖时被旧对象带进新对象

- **测"运行期注册立刻生效"要用「按 agentId 分流」的注入**：`_prepareQueryOnce` 每轮都 `new DefaultToolPool` + `trigger('core.tool.pool.assemble', { agentId })`，所以运行期注册的 Agent 下一轮 query 立刻有工具 —— 但这条必须有回归测试锁住（防止以后有人把组装挪回装配期）。**陷阱**：若工具插件无差别注入，那么"构造期已注入全局注册表"的实现也骗得过断言；必须让注入条件依赖 `input.agentId`（只有目标 Agent 触发才加工具），断言才真的在测"那一轮重新组装了"

- **发事实事件时带上会话归属，否则它一定落进 `run` 级文件**：遥测按 `attrs.sessionId` 分文件，没有归属就落 `run.telemetry.jsonl` ⇒ **按会话取证时永远看不到它**。`provider.resolveMiss` 与 `telemetry.tool.fail`（真机 79 条 sessionId 全为 undefined）先后栽在同一个坑里。判据：**这条事实是不是"某一轮 / 某个会话里发生的"？是 —— 就必须带 `sessionId`（`agentId` 同理）**；哪怕发事件的层本身不认识会话（`ProviderRuntime.resolve` 只认 providerId），也要从调用点把上下文透传进来（`resolve(id, ctx)`，`ctx` 只影响**事件的归属**、不参与选谁）。装配期发生的事实（注册 / 默认变更）落 `run` 级是**正确**的，别硬塞归属

- **遥测语义化 kind 的判据是"错误状态 vs 正常事实"，不是"重要与否"**：`mapBusEvent` 默认把所有 bus 事件落成 `telemetry.bus.<name>`（采集不依赖枚举，新事件自动入明细）。只有**错误状态**才值得独占 kind —— `provider.resolveMiss` 会让模型请求**悄悄换一个 Provider 去发**、表面完全正常，混在 `provider.registered` / `defaultChanged` 这些每次都会发生的正常事实里就再也检索不出来；反过来注册事实落通用 kind 是对的（它就该按时间线读）。**加语义化时配一个控制组断言**（"正常事实仍走通用 kind"），否则这条边界会随时间悄悄松掉

- **哨兵值不是实体 id，别让它落进事实载荷**：`prepared.providerId` 的兜底是 `'default'`（`_runStep` 与 `providers.resolve` 都拿它当"未指定 ⇒ 走默认"的哨兵，而注册表里**没有**这个键）。把哨兵原样写进 `core.llm.usage` / `providerCache` 等于凭空造出一个叫 `default` 的端点，消费方按 providerId 聚合时会多出一个假分组。判据：**凡是要落进事实载荷的 id，先确认它在对应的注册表里真能查到**；查不到就归一为"不带"（缺省本身就表达"这次走默认"）

- **新工具的入参用 `fromJsonSchema`：一份声明同时管"模型读到什么"与"运行期接受什么"**：`__jsonSchema` 是 provider 生成 tools 载荷的**唯一**参数来源，另写一套字段 DSL 做校验就是两份真值会漂移。`withJsonSchema` 收窄为"已自带 `safeParse`、只想补一份模型可读描述"的场合（如 mcp-client 透传服务端 schema）。这条针对的是一个真实历史状态：内置工具的 `inputSchema` 曾全是恒过的 `makeSchema`（`safeParse` 恒 `success:true`）⇒ `ToolPipeline` Step 1 形同 no-op，字段级校验**实际上没人做**

- **校验失败的文本就是模型「入参自愈」能拿到的全部信息**：必须写清"哪个参数、要什么、收到什么"（`缺少必填参数 "command"（字符串）` / `timeoutMs 应为 数字，收到 字符串`），不能只说"校验失败"。真机代价可量化：`read_file` 被发出 **14 次 `input:{}`**，每轮自愈都是一次完整 prompt（全 run 约 0.68M token ≈ 10%）—— 措辞直接决定能不能一次补对

- **工具内的入参守卫是"越过管道直调 `tool.call()`"那条路径的兜底，不是 schema 的重复**：管道 Step 1 已用同一份 schema 拦结构，守卫必须**复用同一份**（`xInputSchema.safeParse` + `formatSchemaError` / `schemaIssues`）并保持对外错误码不变，不得另写一份规则；JSON Schema 表达不了的部分（纯空白串、空数组）才留在守卫里。**同一形态只留一份**：`tools-builtin` 里已抽成 `guardInput(schema, input, requiredField, requiredCode)`（`read_file` / `write_file` / `edit_file` / `bash` 共用），新增工具直接调它、别再内联一份规则；`bash_ro` 不需要它 —— `checkReadOnlyCommand` 自身就含"非空"契约（`String(command ?? '')`），属语义校验器的一部分，与 schema 不重复。判据有两个：① **测试直接调 `tool.call()` 时守卫必须仍然生效**（`tools-builtin.test.ts` / `tools-glob.test.ts` 就是直调的，删守卫除红测试外还会把 `bash: undefined: command not found` 放回来）；② 反向验证时"摘掉 schema 检查"要让守卫相关的用例也变红

- **运行时默认容忍 schema 未声明的字段**：`additionalProperties:false` 是**给模型的声明**，不等于运行期拒收。两条理由：模型偶尔带无害冗余（拒它等于凭空造一类新失败），且 `oneOf` 多模式的 schema **刻意省略 `properties`**（一律拒会误伤合法入参）。要真拒用 `strictProperties: true` 显式开。反向验证时这条被证明不是想当然：把默认改成拒绝 ⇒ `glob` 的 `exclude` / 文件大小过滤两条既有用例直接红 —— 因为 `GlobInput` 有 8 个字段而 glob 的 schema 只声明了 4 个（**输入接口字段 ↔ schema properties 必须对齐**，否则模型发现不了那些参数）

- **入参接口的每个字段都必须在 `schema.properties` 里出现，否则 `tsc` 直接报错**：`fromJsonSchema<T>` 的入参类型是 `JsonSchemaFor<T>`，它把 `properties` 约束成 `{ [K in keyof T & string]: unknown }`、`required` 约束成 `Array<keyof T & string>`，多一个少一个都过不了 `bun run typecheck`。为什么把这件事放在**类型**上而不是写运行时断言：接口字段是**类型层面**的东西，运行时拿不到；而漏声明的后果恰好只在类型层面可判 —— 模型看不到那个参数、运行期却照收，表现为"能力凭空消失且**没有任何报错**"。实测漏过 7 个：`glob` 的 `exclude` / `minSizeBytes` / `maxSizeBytes` / `maxDepth`，`web_fetch` 的 `followRedirects` / `maxResponseBytes` / `allowPrivateNetwork`。**要"故意"不暴露某个字段，就给该工具一个更窄的入参类型**（范例：`bash_ro` 用 `Omit<BashInput,'env'>` 表达"不接受 env —— ENV 是绕过只读的后门"），而不是让 schema 与类型各说各话（那会退化成"模型传了、被静默忽略"）。`oneOf` 多模式（`code_semantic_edit`）走豁免分支：顶层不写 `properties`，各模式在 `oneOf[].properties` 里各自声明

- **守卫判"失败的**性质**"要判 `issue.rule`，不要判 `message`，也不要只看 `issue.path`**：同一个字段可能出不同性质的错，而"缺必填"与"类型不符"在 `path` 上长得**一模一样**（都是 `'path'` / `'command'` / `'pattern'`）。只看 `path` 的判据会把 `command: 123` 冒充成 `COMMAND_REQUIRED` —— 码说"缺"、消息却说"应为 字符串，收到 数字"，两者打架。这条是被一个真实漏网抓出来的：上一轮 bash 那条用例恰好错在**另一个**字段（`timeoutMs: 'soon'`，`command` 本身合法），把缺陷绕过去了。`JsonSchemaIssue.rule` 有 8 档（`required` / `type` / `enum` / `union` / `additional` / `items` / `length` / `range`），11 个 `issues.push` 点已全部标注；判 `message` 则会在文案改动时**静默失效**。守卫已统一按 `rule === 'required'` 分流"缺参数"与"其它结构问题"：`guardInput` **一处**覆盖 `read_file` / `write_file` / `edit_file` / `bash`，`glob` 因错误码口径不同（`GLOB_PATTERN_MISSING` 只对应 pattern 缺失）自带一份

- **凡 `call()` 第一行做路径解析的工具，结构守卫必须排在它之前**：`read_file` / `write_file` / `edit_file` 的开头都是 `resolvePath(input.path, ctx.cwd)`，而 `resolvePath` 内部先做 `isAbsolute(inputPath)` —— 传 `undefined` / `null` / 数字 / 对象都会抛 `TypeError: The "path" property must be of type string`，**且那行在 `try` 之外**，异常不会被下面的 catch 收敛，会直接冒泡给调用方（权限引擎的 `extractPatterns` 在此之前还会先拿到 `[undefined]`）。四个工具共用 `guardInput(schema, input, requiredField, requiredCode)`：缺 `path` ⇒ `PATH_REQUIRED`、缺 `command` ⇒ `COMMAND_REQUIRED`，其余结构问题 ⇒ `INVALID_INPUT`；它们的 `inputSchema` 也因之提到模块级常量，`call()` 复用的就是喂给模型的那一份（bash 的失败形态不同：它把 `undefined` 送进 spawn，由 shell 报 `bash: undefined: command not found`，真机会话里连撞 6 次）

## 6. 安全与协作

- 子代理工具调用 `isConcurrencySafe` 必须为 `false`，防止并发写冲突

- 后台任务完成自动以 `<task-notification>` user-role 注入父会话

- `.harness` 目录统一为 `plugins`（多种插件类型都放这里）、`agents`、`skills`

## 7. 提交流程

- **每次工作结束自动 git 提交**（用户要求）

- 提交信息风格：`feat(scope): 中文描述`，多用 heredoc 构造多行 message

- 不要 `git add -A`，按文件名精确暂存；不上传 `.env` 等敏感文件

## 8. 沟通

- 与用户沟通使用中文

- 交付后更新 `docs/development-log.md`（按"续 N"编号）与相关架构文档

