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
| 上下文压缩 V5 四阶段 | 见上节 |
| bash AST + Kitty | 调研报告"实施进展"两轮全 ✅ |

---

## 2. 仍可继续（纯代码，本仓可闭环）

| # | 项 | 现状判据 | 依赖 / 风险 |
|---|---|---|---|
| **A** | `@harness/planning-files` 插件 | ✅ **阶段一~四已落地**（续 248/249） | 仅剩「真 harness 装配级端到端」（本包测试走 hook 级） |
| B | MCP **server 端**插件（旁路 B1） | 全仓无 `@modelcontextprotocol/sdk`；`mcp-server-registry` 是"注册要连的 server"，不是 server 端 | 从零写；独立线 |
| C | ~~`UsageStats` 的 provider 维度~~ | ✅ **已落地**（续 250） | — |
| D | 承续 213/215 小遗留：`unregister` 级联、`_setChatProvider` 最终删除、`read_file` 直调守卫 | `core:4783` 仍在委托；`core:899/2643` 有 unregister 但级联语义需核 | 低风险杂活；**动手前先核现状** |
| E | VSCode 注册 `languageModelTools`（设计稿 §10-6，B1 变体） | 扩展内无 `lm.registerTool` | 点验需 Copilot |
| F | 79.9MB 二进制裁剪 B1/B2（`--minify` + 瘦入口） | `packages/cli/package.json` 的 `build:sidecar` 未带 minify | A3 选定后优先级已降；实测可到 62.1MB / zip 后 ~21MB |

## 3. 需外部条件（无法在本仓闭环）

- P2/P3 **人手点验**：装 Copilot 后试 `@harness`、14 命令、侧栏面板、时间线、`[launch]` 三行。
- **Anthropic 显式缓存**真机验收（`usage-accounting…plan.md` §7.7）：需 key，用户已定先不做。
- **Kitty 键盘真机矩阵**（kitty / ghostty / WezTerm / iTerm2 / Terminal.app / tmux）。

## 4. 待决策

- 遥测 OTLP 二期（`telemetry-plan.md` §10 第 6 步，可选）。
- codeIntel 插件废弃评估 + `oneOf` 入参自愈（用户既定：等废弃决策一起处理）。

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
