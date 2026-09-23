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

- **Agent 能力白名单的三条实操约定**（真机实测得出，别凭直觉写）：
  · `tools:` 只接受**精确 id**（`ToolRegistry.filterByWhitelist`；除整串 `'*'` 外不支持通配，也不支持 `mcp__xxx__*`）；未声明则回落**只读哨兵**（能读不能写）+ 告警，`tools: []` 才是"一个都不给"。
  · **`tools:` 显式列表会先于 `mcpServers` 生效**：core 的顺序是 `filterByWhitelist(agent.tools)` → `filterMcpTools(..., agent.mcpServers)` ⇒ `mcpServers` 是**二次过滤**，不是"补给我某些 MCP 工具"。要拿"部分原生 + 部分 MCP"，必须把 MCP 工具 id 也写进 `tools:`（否则 MCP 在第一步已被剔除，实测拿到 0 个）。
  · `mcpServers: []` = 一个 MCP 工具都不给（fail-closed：将来新增 server 也不会漏进来）；想只留某几个 server 就写 `mcpServers: [名字]`。

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

- **步间闸门 `core.agent.step.gate`（引擎层）挂靠在「续轮」上，不是挂在「空转」上**：检查点 = 每个步边界、即每次模型推理开跑**之前**（`step >= 1`，第 2 步起）；此处引擎**不可能知道**这一步将产出 `tool_calls` 还是最终答复（那是本次推理的结果，尚未发生）⇒ 只要插件报 `pending` 就等，**与这一步的产出形态无关**。真正的触达条件是 `shouldContinueStep()`（判据 `toolCallCount > 0` 且 finish 正常）——**上一步没调工具时本轮直接结束，闸门根本不会被触达**。所以「有 tool call 就不等」是**反的**：恰恰是有 tool call 的步才续轮、下一步开跑前才经过闸门。真机语境里的"空转"指**有 tool call 但无进展**（反复 read_file/bash 查状态），这类步同样续轮、同样被闸门减速。**语义是「每个步边界最多等一次」**（写成 `while (gateClosed)` 会在对端恒报存活时无限卡死）。多插件合并是 **OR**、`aliveCount` 取最大；**引擎侧必须有等待总预算兜底**（`STEP_GATE_MAX_TOTAL_MS`），不能把终止条件全托给插件。探测为"静默"时只把**阶梯归零**（下一波派工从最小档重起），**不是关闸门** —— 每个步边界仍会重探（同一轮里 coordinator 可能再派一批）。默认阶梯 `[3s,6s,12s,24s,48s,60s]`，可经 `AgentHarnessOptions.stepGate` 注入覆盖（测试压到毫秒级）。等待**必须发 `step_gate` 事件**（>15s 无输出要有心跳）、CLI 进 `waiting` 相位。纯函数 `stepGateDelayMs(n)` 对 `NaN` 必须显式落 0 档——`Math.floor(NaN)` 是 NaN，索引出 `undefined` 且类型上不报错

- **`coordinator.worker.completed`（单任务完成即唤醒）与 `barrier.completed`（全波收尾）是两条事件**：前者**仅在 `remaining > 0` 时发**（最后一个走 barrier），否则外层会注入两行 `<continue/>`。**`remaining` 必须在 `tracker.onWorkerFinished()` 之前算** —— 后者在计数归零时会 `active.delete`，之后再问 `activeCount()` 恒为 0（"快任务完成也报 0"⇒ 事件永远发不出来）

- **"免费额度 / 豁免"一律必须封顶**：`MAX_SELF_HEAL_FREE_STEPS = 3` 是「必填全缺回喂免计一步」的必要兜底 —— doom-loop 只认「同一工具+同一入参连续 3 次 / 连续 3 步整步签名相同」，**`A,B,A,B…` 交替空参能完美绕开它**；不加天花板就会架空 `maxSteps` 这个唯一刹车。`billedSteps`（吃额度）与 `step`（展示步号）是两套计数，`turn_end` 带 `freeSteps` 解释二者为何不一致

- **中途草稿用"正常结束即删"编码语义**（比额外维护状态标记可靠）：文件存在性本身就是状态 ⇒ **有草稿 ⇔ 这次被掐断**。触发点用**步边界**而非定时器（步边界本就是天然刷盘点）；按 taskId 固定命名 + 覆盖写（同毫秒并发不撞名）；草稿状态必须声明在 `try` **之外**（catch 要用）。落盘仍守既有约定：`{dataDir}/subagent-results/`，**不落 `os.tmpdir()`、不落 cwd**；失败路径给的可读性说明必须**如实**（能不能被 `read_file` 读到要实测判定，不猜）

- **测试块约定：顶层 `describe` 不继承外层 `beforeEach/afterEach`** —— 往已有测试文件里追加独立 `describe` 时若忘了自带 setup/cleanup，会因外层 `afterEach` 已清掉临时目录而 ENOENT/`SPAWN_ERROR`（表现为"新写的用例莫名失败"）。另：`ToolResult` 是**非判别联合**（`ok: boolean` + 可选 `output?/error?`），`if (!r.ok)` **不收窄**类型，断言写 `r.error?.code` / `r.output?.exitCode`

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

