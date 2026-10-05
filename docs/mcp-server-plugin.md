# MCP Server 插件（`@harness/mcp-server`）设计稿

> 状态：**已实现**（2026-10-05：续 252 设计定稿 / 续 253 落地，见文末 §11 实现记录）
> 来源：`docs/external-integration-plan.md` §4.1「B1：MCP Server（需自建）」、`remaining-work-plan.md` §2-B
> 包路径：`packages/plugins/mcp-server/`（**插件包**，非宿主包 —— §4.1 的纪律要求）

## 0. 一句话与边界

把 **harness 的工具集**通过 MCP 协议暴露给外部 MCP 客户端（VSCode Copilot Chat / Continue / Cline 等），
让"在 IDE 里被调用"成立。

与 A2A 的分工（`external-integration-plan.md` §3.6）：**A2A 暴露"自治 Agent（带会话与任务生命周期）"，
MCP 暴露"工具集"**。同一 harness 可同时开两种服务，互不替代。

⚠️ **与 `@harness/mcp-server-registry` 的区别**（这两名字极易混）：
`mcp-server-registry` 管的是**"harness 要去连哪些 server"**（它是 client 侧的清单）；
本包是**"harness 自己当 server"**。文档与配置里必须分开说。

## 1. 现状勘察：§2-B 的「从零写」不准确

原判断「全仓无 MCP server 端，须从零实现」只看了包名。回代码核实，已有四块可复用资产：

| # | 资产 | 位置 | 可复用什么 |
|---|---|---|---|
| 1 | 进程内 MCP server（JSON-RPC 2.0 + `initialize`/`tools/list`/`tools/call`） | `code-intel/src/server.ts:202-260`（293 行）、`computer-use/src/server.ts:345-390`（432 行） | **协议壳的现成范式**（两处同构：`handle(msg, reply)` 单入口 + switch） |
| 2 | `McpTransport` 接口 + **HTTP（Streamable HTTP）客户端** | `mcp-client/src/index.ts:130-145`（接口）、`:213-306`（`HttpTransport`） | server 侧必须与它**对得上**（见 §5）；对齐后可直接用它做端到端测试 |
| 3 | 进程内 transport 桥 | `code-intel/src/server.ts:271-293`、`computer-use/src/server.ts:399-425` | 桥的写法（`send` 喂 server、`reply` 回 handler、未注册 handler 时排队） |
| 4 | server 注册与启停两路（`config` / `createTransport`） | `mcp-server-registry/src/index.ts:215-221` | 装配侧**不用动** |

**真正要新写的只有四件**：
1. server 侧 **Streamable HTTP transport**（客户端侧已有，server 侧没有）；
2. **动态** `Tool` → MCP tool 描述映射（已有两处都是**硬编码**工具表，harness 必须动态枚举）；
3. **权限桥**（`ask` → elicitation，含 Fail-Closed 降级）；
4. 插件装配与命令。

> 又是「文档说没做、代码有八成基础」—— 这次在**开工前**发现了。判据是上面四条 `文件:行号`，
> 下次直接复跑核。

## 2. 形态决策（两条，已拍板）

| 决策 | 选定 | 理由 / 代价 |
|---|---|---|
| **transport** | **进程内 Streamable HTTP**（斜杠命令拉起 `Bun.serve`，IDE 侧配 `url`） | 可与 TUI 共存；**且只有 HTTP 才可能承载 server→client 的 elicitation**（stdio 是单向帧流，双向要另开机制）。代价：需端口 + 网络面（默认仅 `127.0.0.1`）。与设计稿原定的 stdio 不同，**该偏离需回写 §4.1** |
| **暴露范围** | **全暴露**（含写工具）+ **elicitation 确认** | 写操作的确认由 MCP 客户端 UI 承担；客户端不支持 elicitation 时 **Fail-Closed 拒绝**（见 §6） |

## 3. 协议层（`src/protocol.ts`，零 IO）

- **JSON-RPC 2.0**：`{jsonrpc:'2.0', id, method, params}` / `result` / `error`。
- **错误码**：`-32700` parse / `-32600` invalid request / `-32601` method not found /
  `-32602` invalid params / `-32603` internal。与既有两处 server 一致（`code-intel:227` 用 `-32601`/`-32602`）。
- **方法面（一期只 tools）**：`initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`。
  **不做** `resources/*` / `prompts/*` / `sampling`（一期范围外，见 §9）。
- **版本协商**：`SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']`。
  `initialize` 时**回显**客户端版本（若在列表内），否则返回我们的最新版并让客户端决定去留（MCP 规范行为）。
  注意 **`elicitation` 是 2025-06-18 引入的** ⇒ 客户端声明旧版本时天然不支持 elicitation，走 §6 降级。
- **SSE 编解码**：`encodeSseEvent` / `decodeSseEvents`，与 `mcp-client` 的 `parseSseChunk`
  （`:195-211`）**对偶**，两侧可互测。

## 4. 工具映射（`src/tools.ts`）

**方向一：`Tool` → MCP tool 描述**（`tools/list`）

| MCP 字段 | 来源 | 备注 |
|---|---|---|
| `name` | `tool.id` | 默认**不加前缀**（保持与 harness 一致，便于辨认）；提供 `--prefix` 选项。MCP 名字约束 `[a-zA-Z0-9_-]`，harness 工具 id 本就符合 |
| `description` | `tool.description` | 原样透传 |
| `inputSchema` | `withJsonSchema` 注入的 JSON Schema **直出** | 不重新推导（`mcp-client` 侧已因"丢参数"修过一次：`:662-668` 的注释） |
| `annotations.readOnlyHint` | `tool.isReadOnly?.(input)` | 无入参时为 `false`（Fail-Closed） |
| `annotations.destructiveHint` | `tool.isDestructive?.(input)` | 同上 |

**方向二：`tools/call` → 执行**

- 参数：`{ name, arguments }`。
- 执行：**必须走流水线**，不裸调 `tool.call()`（否则绕过权限与 pre/post hooks）。
  接线方式见 §6 —— 这是本设计**唯一的开放问题**。
- 结果：`ToolResult` → MCP `{ content: [{type:'text', text}], isError }`。
  `output` 为字符串直接用；对象 `JSON.stringify`；`error` 取 `message`（带 `code`）。
- **排除集**：
  - `requiresUserInteraction: true` 的工具（如 `AskUserQuestion`）—— MCP 下无交互面；
  - id 以 `mcp__` 开头的工具（那是从别的 MCP server 拉进来的）—— 避免二级转发与潜在环路。

## 5. 传输与会话（`src/session.ts` + `src/server.ts`）

与 `HttpTransport`（`mcp-client:213-306`）**逐条对齐**：

| 面 | 客户端行为（现状） | server 必须做到 |
|---|---|---|
| 请求 | `POST`，`Accept: application/json, text/event-stream` | 两种响应都要支持，按 `Accept` 选 |
| 会话 | 从响应头取 `Mcp-Session-Id`，后续请求带上 | `initialize` 响应**必须**带 `Mcp-Session-Id`；无/非法会话 ⇒ 404 |
| JSON 响应 | `Content-Type: application/json`，整体当一条消息 | 单请求单响应时用这条（最简路径） |
| SSE 响应 | `Content-Type: text/event-stream`，按 `\n\n` 切帧、取 `data:` 行 | **需要在响应中途插消息时**才用（即 elicitation） |
| `202` | 视为"响应在后续流里" | 客户端 POST 回 elicitation 答复时返回 202 |
| `GET` | （客户端未用） | 提供 SSE 长连（可选，用于 server→client 推送；一期可只做 POST 内联 SSE） |
| `DELETE` | （客户端未用） | 终止会话 |

- `session.ts`：`Mcp-Session-Id` 生成/校验 + **待决 server→client 请求表**（elicitation 用，带 TTL）。
  范式参照 `a2a-server/src/suspend.ts`（挂起表 + TTL + 超时转失败）。
- `server.ts`：`createMcpServer({ harness, port, path, token? })` → `Bun.serve`，返回 `{ url, port, stop }`。
  默认 `127.0.0.1`（**不监听 0.0.0.0**）；`token` 可选取 Bearer；**stdio 的教训反过来用**：
  日志一律走 stderr/日志器，响应体只放协议帧。

## 6. 权限桥：**本设计唯一的开放问题**（需拍板）

### 已查清的机制

`ToolPipeline.execute` 的 Step 4（`tool/src/index.ts:1330-1352`）调**构造时注入的 `checkPermission`**，
而 harness 装配它时用的是 `resolvePermission(this.permission, req, bindTrigger(this.plugin))`
（`core:4528-4529`）。`resolvePermission`（`core:337-353`）的两步：

```
engine.check(req) → 触发 core.permission.check hook（插件可改判） → 若仍是 ask ⇒ engine.ask(req)
```

`engine.ask` 就是**官方接缝**：`InteractivePermissionEngine.ask`（`host/src/permission.ts:134-154`）
只管"四态 → 规则写回"，**怎么问到答复**交给 `asker`（`PermissionAsker`，`:62-65`），而
**`setAsker(fn)`（`:126`）可运行期替换**；不给 asker 时缺省 **deny**（Fail-Closed，`:21-23`）。

⚠️ **缺口**：`PermissionAskInput` 被**刻意收窄**成 `{ toolKey, patterns }`（`:31-38`），
**不含 sessionId / agentId** ⇒ 一个 asker **分不清"这次询问来自 MCP 还是来自 TUI 里的 agent"**。

### 四个候选

| # | 方案 | 改动面 | 优点 | 缺点 |
|---|---|---|---|---|
| **A** | 换全局 `asker`（`setAsker` 包装） | 仅本包 | 最小改动 | **分不清来源** ⇒ 会顶掉/串台 TUI 的模态审批；靠 `isMcpBusy` 标志在并发下**不安全** |
| **B** | 给 `PermissionAskInput` 加 `sessionId`（`PermissionRequest` 同步加，pipeline 从 `ctx` 取） | `@harness/tool` + `@harness/permission` + `@harness/host`（**三包纯增量可选字段**） | **根治**：asker 能按会话归属路由，无并发窗口；与既有判据「事实事件必须带会话归属」同源 | 动 3 个包 |
| **C** | 自建 `ToolPipeline`（`checkPermission` 直连 elicitation；pre/post hooks 用 `harness.plugin.listHooks` 复刻） | 仅本包 | 零侵入；语义清晰 | **双份装配** ⇒ 与 core 的 hooks 序列会漂移（设计稿 §7 明令避免的形态） |
| **D** | 执行前预判 + 临时写规则（`updateRules(allow)` → `execute` → 恢复） | 仅本包 | 复用 `harness.toolPipeline`，hooks 保真 | **临时放行窗口**（执行期间别的调用会被放行）；权限是安全边界，"漏一处就是漏洞" |

### 推荐 **B**，理由

A/C/D 都是在"缺了归属信息"这个根因上做将就：A 靠不可靠的标志、C 引入会漂移的第二份装配、
D 在安全边界上开时间窗。B 把**根因**修掉，且改动是**纯增量可选字段**（不破坏既有 asker/测试）。

C 有一条真实的替身理由：MCP 的工具执行本来就是"外部直接调用单个工具"，**不在 agent 循环内**，
"不同的装配"未必错。若坚持零侵入，C 是次优解（但必须在代码里写清"这是第二条执行路径，
hooks 语义变更要同步改两处"，否则必然漂移）。

> **已拍板 B**（2026-10-05，续 253）：`@harness/permission` + `@harness/tool` 的 `PermissionRequest`
> 与 `@harness/host` 的 `PermissionAskInput` 加 `sessionId`（纯增量可选字段）。
> 实测另需**第 4 处 host 增量** `InteractivePermissionEngine.getAsker()` —— 包装型 asker 必须
> 拿得到被包装者，`setAsker` 只有 setter（缺 getter 就退化成替换、两个询问源互相顶掉）。见 §11-2。

## 7. 装配与命令（`src/index.ts`）

- `createMcpServerPlugin(options)`：`AgentPlugin`。
  - `core.harness.init`：拿 `output.harness`（类型窄化为 `Harness`，`core:3871-3913` 已暴露
    `tools: ToolRegistry` / `toolPipeline` / `permission` / `cwd` / `plugin`）—— **不需要改 core**。
  - `cli.commands` + `cli.command`：`/mcp-serve [--port n] [--token t]`、`/mcp-status`、`/mcp-stop`。
- 登记链路（漏一项守卫就红）：root `tsconfig.json` paths → 包 `package.json` →
  `host/package.json` dependencies → `host/src/lazy.ts` **静态表** → `host/src/plugins.ts` 注册
  （`optIn: true` —— 它占端口、有网络面，不该默认装配）→ `bun install`。

## 8. 分阶段与验收

| 阶段 | 产出 | 验收 |
|---|---|---|
| 一 | `protocol.ts` + `tools.ts`（纯函数） | 编解码往返、版本协商、映射与 `readOnlyHint`、`tools/call` 转发与错误映射 |
| 二 | `session.ts` + `server.ts` | **用 `@harness/mcp-client` 的 `HttpTransport` + `McpClient` 连自己**：`initialize`→`tools/list`→只读 `tools/call` 全通 |
| 三 | `elicit.ts` + 权限接线（**依赖 §6 拍板**） | accept/decline/cancel/超时/客户端不支持 五条分支；写工具逐条过权限 |
| 四 | `index.ts` + 登记 + 命令 | `/mcp-serve` 起停、`/mcp-status`、`builtin-registry` 守卫 |

三段式验证照旧：`bun run typecheck` → `bun run test`（根脚本）→ 反向验证逐处**先写预期变红条数**再跑，
还原后 `shasum -a 256 -c` + `cmp` 逐字比对。

## 9. 一期**不做**（有意）

- `resources/*` / `prompts/*` / `sampling` —— 一期只暴露"工具集"，与 A2A 的分工保持清晰。
- stdio transport —— 见 §2 的取舍；若后续要，加一个 transport 适配即可（server 核心不变）。
- 暴露 `requiresUserInteraction` 工具、二级转发 `mcp__*` 工具（§4 排除集）。
- 多 agent 的"按 agent 过滤工具集" —— 一期暴露全局 `ToolRegistry`。

## 10. 风险

| 风险 | 处置 |
|---|---|
| 两个 MCP 名字混淆（本包 vs `mcp-server-registry`） | §0 明确区分；配置项与文档标题里都写明方向 |
| elicitation 客户端支持度不一（Copilot Chat 等未必实现） | Fail-Closed 降级（§6）：不支持 ⇒ 拒绝写操作并给出可操作提示；只读工具不受影响 |
| 端口/网络暴露 | 默认仅 `127.0.0.1`；可选 Bearer；权限引擎不旁路 |
| 与 TUI 抢 stdout | HTTP 形态天然规避；日志走 stderr |
| 自建协议壳版本漂移 | 协议常量集中一处；`HttpTransport` 互测钉住对齐 |

## 11. 实现记录（续 253）

### 11.1 交付物

| 文件 | 内容 |
|---|---|
| `src/protocol.ts` | JSON-RPC 2.0 编解码 + 错误码 + 版本协商 + SSE 编解码（零 IO） |
| `src/tools.ts` | `ToolRegistry` → MCP 描述 / 调用结果（动态映射；排除 `requiresUserInteraction` 与 `mcp__*`） |
| `src/session.ts` | 会话表 + 待决 elicitation 表（TTL + 超时转 cancel） |
| `src/server.ts` | `Bun.serve` Streamable HTTP（`createMcpServer` → `{url, port, sessions, owns, elicitAsk, asker, stop}`） |
| `src/elicit.ts` | `ask` ⇄ `elicitation/create` 的纯映射 |
| `src/index.ts` | `createMcpServerPlugin` + `/mcp-serve` `/mcp-status` `/mcp-stop` |
| 登记 | root `tsconfig.json` paths、host `package.json` deps、`host/src/lazy.ts`、`host/src/plugins.ts`（`optIn: true`）、`bun install` |
| 权限桥预备 | `permission` / `tool` / `host` 三包加 `sessionId`；`host` 加 `getAsker()` |

### 11.2 与设计稿的四处偏离（实现时才暴露）

1. **`sessionId` 在 `PermissionAskInput` 里的理由与 `toolKey`/`patterns` 不同** —— 后两者是"引擎要读"，
   它是"asker 路由要"。原注释"刻意收窄到引擎真正读的两项"因此改写为"引擎读两项 + 路由读一项"，
   防止后续按单一规则再把它裁掉。
2. **第 4 处 host 增量：`getAsker()`** —— §6 的方案 B 原本只算三包。包装必须能取到被包装者，
   否则只能替换 ⇒ 后装的顶掉先装的（且**零告警**）。`getAsker` 是纯增量读方法。
3. **工具级失败用 `isError` 结果而非 `-32603`** —— MCP 语义下"工具执行失败"是内容结果
   （`content` + `isError: true`）；协议错误只留给"未知工具 / 参数非对象"。否则 IDE 只显示
   "请求失败"，把"为什么被拒"藏起来。
4. **`canElicit` 需要独立的"发不发帧"断言** —— 去掉该检查不会让既有用例变红（客户端回 `-32601`
   时 `answerFromResponse` 兜底 cancel ⇒ 同样 deny）。补了"旧协议版本 ⇒ 首帧即最终结果"的手工
   客户端用例，把行为差异钉住。

### 11.3 会话校验口径（实现时收紧）

除 `initialize` 外的一切 POST（含 **elicitation 答复**与通知）都要求合法 `Mcp-Session-Id`，
否则 404。答复也必须带会话 —— 否则"猜 id 替用户同意一次写操作"成为可能（uuid 只是纵深，不作为主防线）。

### 11.4 验证

`bun run typecheck` ✅ → `bun run test` ✅ 全绿 → 反向验证 8 处（每处预期 1 红 / 实际 1 红，
还原后 `shasum -a 256` 一致）。明细见 `docs/development-log.md` 续 253。

> **计数坑**：反向验证的实际红条数必须取 bun 的**汇总行**（`^ *[0-9]+ fail`）；
> `grep -c '^(fail)'` 会把同一用例双计（文件段落 + 末尾汇总各一次）。

