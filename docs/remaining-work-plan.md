# 剩余工作计划（2026-10-05 盘点）

> 口径：**每条都回代码核过**（grep 判据写在表里），不只读 docs 的"遗留"段落。
> 立此文档的原因：`docs/*.md` 里的「遗留 / 后续」会过期 —— 续 214/215/219 记的多条遗留
> 已被后续轮次悄悄收掉；反过来也有**文档说没做、代码其实做了**的情形（见下节更正）。

---

## 0. 先更正一处上一轮盘点的误判

上一轮我把「上下文压缩·阶段四（前端按需渲染）」列为**可立即开工**，**这是错的** ——
它早已落地（开发日志续 111），文档 `docs/context-compression-plan.md` §5 阶段四也写着"已落地"。

误判根因：我只 grep 了 `flushHistory|loadFullHistory`（server 侧链路名），而 CLI/TUI 侧消费的是
**`loadHistory`**。判据应该是：

```
packages/cli/src/index.ts:2204   loadHistory: (sid, range) => app.loadFullHistory(sid, range)
packages/cli/src/tui.tsx:664     expandCompactBlocks()   ← 点提示行 → 按块惰性取回原文
packages/cli/src/tui.tsx:685     loadOlderBlocks()       ← 点"更早"提示 → 向前翻页
packages/cli/src/tui.tsx:168     ChatBlockKind 含 'compact' | 'loadmore'
```

⇒ **`docs/context-compression-plan.md` 四阶段全部完成**，该计划已收口，不再有剩余项。

### 追加更正（续 251）：项 D 里的「`read_file` 直调守卫」早已闭合

§2-D 原把「`read_file` 直调守卫」列为待办，**实际续 216（直调入参守卫）那轮就收掉了**。
判据是 `packages/plugins/tools-builtin/src/index.ts` 各工具 `call()` 的入口：

```
:139    read_file    guardInput(readFileInputSchema,  input, 'path', 'PATH_REQUIRED')
:281    write_file   guardInput(writeFileInputSchema, input, 'path', 'PATH_REQUIRED')
:569    bash         guardInput(bashInputSchema,       input, 'command', 'COMMAND_REQUIRED')
:1325   edit_file    guardInput(editFileInputSchema,  input, 'path', 'PATH_REQUIRED')
```

四个入口齐了 ⇒ 越过管道直调 `readFileTool.call({}, ctx)` 拿到的是结构化错误（`PATH_REQUIRED`），
不再是 `resolvePath(undefined, cwd)` 抛出的 TypeError。**该项移入 §1，不再列待办。**

> 教训：这条是从续 214/215 的「遗留」段落抄进 §2 的 —— 而遗留段落在叙述当轮时点是准的，
> 抄进新文档时**没有回代码复核**就成了过期项。**凡从旧日志搬进新计划的条目，搬的时候就要重核一遍。**

---

## 1. 已闭合（不要再重复推进）

| 计划 | 判据 |
|---|---|
| 对外接入 P0 / P0.5 / P1（含官方 `a2a-tck` 验收） | 设计稿 §9 分期表全绿 |
| P2-A/B/v1/v2 + P3-A/B1/B2/C | 同上；最近提交 `0424ca1` 收口 |
| runtime-registration S1/S2/**S3** | S3 见日志续 213（事件归属 / 来源列 / 实例数 / 端点维度） |
| memory & skill-forge M0~M3.1、F0~F3 | `docs/memory-and-skill-forge-plan.md` §3.9 / §4.6 全 ✅ |
| 用量纳管 + 前缀缓存 | `docs/usage-accounting-and-prompt-cache-plan.md` §7.8 |
| `UsageStats` 的 provider 维度 | 续 250；`packages/usage/src/index.ts` 有 `providers[]` + `normalizeUsage`，源文档 §7.9 |
| 工具入参 runtime schema（30 工具）+ 守卫收拢 | 续 214~218；`tools-glob/src/index.ts:144-146` 已有 exclude/minSizeBytes/… |
| `read_file` / `write_file` / `bash` / `edit_file` **直调入参守卫** | 见上节更正；四处 `guardInput`（`tools-builtin/src/index.ts:139/281/569/1325`） |
| 上下文压缩 V5 四阶段 | 见上节 |
| bash AST + Kitty | 调研报告"实施进展"两轮全 ✅ |

---

## 2. 仍可继续（纯代码，本仓可闭环）

> 编号沿用原盘点：**B 已落地**（见下行，续 253）；**C 已落地移入 §1**（不再重复列）；
> **原 D 已按性质拆解** ——
> `read_file` 直调守卫 → §1、`unregister` 级联 → §4、只剩 `_setChatProvider` 删除留在本表（见下方备注）。

| # | 项 | 现状判据 | 依赖 / 风险 |
|---|---|---|---|
| **A** | `@harness/planning-files` 插件 | ✅ **阶段一~四已落地**（续 248/249） | 仅剩「真 harness 装配级端到端」（本包测试走 hook 级） |
| **B** | MCP **server 端**插件（旁路 B1） | ✅ **已落地**（续 253）：`@harness/mcp-server` —— Streamable HTTP + 动态工具映射 + elicitation 权限桥（`optIn`）。§1 勘察已订正原判"从零写"（进程内 server / `McpTransport` / 注册链四块可复用） | 一期不做 `resources`/`prompts`/`sampling`、stdio、`mcp__*` 二级转发；IDE 侧真机联调待外部客户端 |
| D | `_setChatProvider` 最终删除（含 `chat.provider` 老注入链退场） | `core:4791` 标 `@deprecated`；6 个内置 provider 插件（anthropic / openai / glm / gemini / qwen / mock）各留一条 `else if (harness?._setChatProvider)` 回退分支；**生产路径已无调用者**，真走到的只有测试桩（`cli.test.ts:1900`、`core.test.ts:1216+`） | 低风险，但**顺序不能颠倒的三步**（见下）；动手前先确认是否继续支持「老宿主 + 新插件」 |
| E | VSCode 注册 `languageModelTools`（设计稿 §10-6，B1 变体） | 扩展内无 `lm.registerTool` | 点验需 Copilot |
| F | 79.9MB 二进制裁剪 B1/B2（`--minify` + 瘦入口） | `packages/cli/package.json` 的 `build:sidecar` 未带 minify | A3 选定后优先级已降；实测可到 62.1MB / zip 后 ~21MB |

> **§2-D 备注：删除 `_setChatProvider` 的前置三步（顺序不可颠倒）**
>
> 1. 摘掉 6 个内置 provider 插件里的 `else if (harness?._setChatProvider)` 回退分支；
> 2. 摘掉 `context.register('chat.provider', p)` —— 这条老注入路径**正是 `resolve()` 链最后一环的
>    fallback**（`core:4333` 注释：「最后一环：构造期 Provider（或经 context 注入的那一份）」）；
> 3. 最后删 `core:4791` 的方法本体。
>
> 任何一步单做都会让「老宿主 + 新插件」**静默失效**：插件注入不上 ⇒ 回落构造期 Provider，
> 且**一条告警都没有**（`provider.registered` 压根不会发布）。

## 3. 需外部条件（无法在本仓闭环）

- P2/P3 **人手点验**：装 Copilot 后试 `@harness`、14 命令、侧栏面板、时间线、`[launch]` 三行。
- **Anthropic 显式缓存**真机验收（`usage-accounting…plan.md` §7.7）：需 key，用户已定先不做。
- **Kitty 键盘真机矩阵**（kitty / ghostty / WezTerm / iTerm2 / Terminal.app / tmux）。

## 4. 待决策

- 遥测 OTLP 二期（`telemetry-plan.md` §10 第 6 步，可选）。
- codeIntel 插件废弃评估 + `oneOf` 入参自愈（用户既定：等废弃决策一起处理）。
- `unregister` **级联语义**（原 §2-D 里的一项，按其性质挪到这里）：`runtime-registration-plan.md`
  §7 明确写着「**刻意不做**」——摘 Provider **不动**使用它的 Agent 定义、摘 Agent **不动**会话历史
  里的引用，理由是"级联语义复杂且容易造成「静默改历史」，留给调用方显式处理"；§9.9 仍把它列为剩余。
  现状与设计稿**一致**：`AgentRegistry.unregister`（`core:2643`）= `delete` + publish，无级联；
  `ProviderRegistry.unregister`（`core:4350`）= `delete` + 默认回落「首个已注册」+ publish
  `defaultChanged{reason:'unregister'}`。⇒ **它不是欠债，是有意的留白，等真实需求驱动，勿提前实现。**

---

## 5. 本轮开工：A —— `@harness/planning-files`（✅ 阶段一/二/三已落地 2026-10-05，续 248）

> 落地结果：新包 `packages/plugins/planning-files/`（70 pass）；已登记进内置注册表（`optIn: true`）；
> 主仓 42 包 typecheck 0 error / 2389 pass 0 fail；反向验证 4 处全红。
> **未做**：阶段四（多计划切换完整化 / catchup / gated 提示）、真 harness 装配级端到端。
> 与设计稿的偏离（不注册 `core.session.compacting`）已回写 `docs/planning-files-plugin.md` §5。
>
> **后续（续 249）**：阶段四已落地（多计划 / catchup / 进度回退 / gated 提示）；**仅剩**真 harness 装配级端到端。

## 6. 本轮开工：C —— `UsageStats` 的 provider 维度（✅ 已落地 2026-10-05，续 250）

> 落地结果：`UsageStats.providers[]`（键 = 实例路由键）+ 读边界归一（旧落盘记录读作 `[]`）+ 四个渲染/导出出口。
> 主仓 42 包 typecheck 0 error / **2449 pass** 0 fail（2435 → +14）；反向验证 7 处精确命中。
> 四个决策（含 D3「`'default'` 哨兵与 `core.llm.usage` 事件规则相反」、D4「读边界归一而非迁移脚本」）
> 记在 `docs/usage-accounting-and-prompt-cache-plan.md` §7.9。

按 `docs/planning-files-plugin.md` 的阶段划分推进，**阶段一 → 二 → 三**一次交付成可用能力
（阶段四的增强项——多计划切换 / catchup / gated——留作后续）：

| 阶段 | 产出 | 验收 |
|---|---|---|
| 一 | `src/plan-files.ts`（`resolvePlanDir` / `ensurePlanFiles` / `readPlanFiles` / `parsePlan` / `attest` + `verifyAttestation`）+ 外置模板三件 | 解析 / attestation / ensure 幂等单测 |
| 二 | `core.session.preModel` tail 注入（不落历史）+ sig 变化检测（D8）+ `core.session.compacting` flush | 注入块格式 / smart 裁剪 / TAMPERED 告警 / sig 不变逐字一致 / hook 后 messages 复原 |
| 三 | `cli.commands` + `cli.command`（`/plan`、`/plan-status`、`/plan-attest`、`/plan-doctor`、`/plan-complete`）+ `core.harness.init` 注册 SKILL | 命令解析 / doctor 自检 / skill 注册 |

新包登记清单（漏一项守卫测试就红）：`tsconfig.json` paths → `packages/plugins/planning-files/{package.json,tsconfig.json}` →
`host/package.json` dependencies → `host/src/plugins.ts` 注册（`optIn: true`）→ `host/src/lazy.ts` 静态表 → `bun install`。

分块提交：① 阶段一 → ② 阶段二 → ③ 阶段三 + 登记 → ④ 文档落档（日志续 248 + AGENTS.md + 设计稿状态行）。
每轮三段式验证：`bun run typecheck` → `bun run test` → **反向验证逐条变红** + 哈希还原比对。
