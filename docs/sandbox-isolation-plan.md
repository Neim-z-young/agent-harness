# 沙箱隔离方案（盘点 + 分层目标形态）

> 起点：2026-10-10。承接[跨平台能力补齐计划](cross-platform-plan.md) §5 **原先**那句「本文不涉及
> **远程/沙箱隔离**（那是宿主职责，另议）」—— 本文就是那份"另议"（该句已改为指向本文）。
>
> **范围**：工具**执行侧**的隔离（命令执行 / 文件读写 / 网络 / 资源 / 代码加载）+ 宿主侧的
> 身份与边界。**不涉及**"换执行后端"（把 harness 接到 Codex / Claude Code 之类，见
> `external-integration-plan.md` §9）。
>
> **排法**：「静默失效或安全漏判」→「能力缺口」→「体验一致」→「工程防回归」四档。
> 每条给**现有代码位置**与**判据**，便于逐条开工与验收。
>
> **§7 是调研附录**（业界方案光谱 / 共识 / 采纳建议），用来把下面的 L0–L3 锚定到业界坐标；
> 它**不引入新待办**，待办一律以 §3 为准。
>
> **§8 是权限设计评审**（三个直答 + 缺陷清单 D1–D7）。缺陷里 D1/D2 已按 **P0-8 / P0-9** 收编
> 进 §3.0，其余（D5→P1-9、D4/D6/D7→P2-5~P2-7）同表归位 —— 本节只做分析与判据，**清单以 §3 为准**。

## 0. 现状一句话

今天的"沙箱"是**策略级（in-process policy）**，**不是 OS 级**：所有闸门都在同一个 Node 进程里、
以当前用户的全权限执行。策略能拦"模型写了什么"，拦不住"那段代码真的能干什么"。

| 能力 | 现状 | 位置 |
|---|---|---|
| 命令级策略（危险表 / AST 复核 / 白名单） | ✅ 有，且真机打磨过多轮 | `tools-builtin/src/index.ts`、`bash-ast.ts` |
| 工作目录边界 | ⚠️ **纯字符串前缀**判定，无 symlink 解析；**6 份副本** | `tools-builtin` / `tools-glob` / `tools-search` / `tools-media` / `code-intel` |
| 环境变量隔离 | ⚠️ **只覆盖 `bash`**；MCP 子进程全量继承 | `tools-builtin` / `mcp-client/src/index.ts:147` |
| 权限引擎（三模式 + 规则写回 + 风险分级 + 审计） | ✅ 有，三宿主共用一份；⚠️ **作用域是工作区级（跨会话、跨进程持久）**，不跟会话/调用方走（见 §8 D2） | `host/src/permission.ts`、`host/src/audit.ts` |
| 身份 / 调用方隔离（A2A） | ✅ token + `contextId` 归属绑定 + 默认只听 `127.0.0.1` | `a2a-server/src/auth.ts` |
| 网络出口 | ⚠️ 只有 `tools-web` 的 SSRF 防护；**`bash` 里的 `curl` 出网完全不受限** | `tools-web` / `tools-builtin` |
| 资源上限（CPU / 内存 / 磁盘 / 进程数） | ❌ **无**（只有 bash 30s 超时） | — |
| OS 级文件系统 / 网络绑定 | ❌ **无**（无 seatbelt / bwrap / landlock / 容器 / chroot） | — |
| 插件代码隔离 | ❌ 开闸即进程内全权 | `host/src/plugins.ts`、`host/src/host.ts:748` |
| 沙箱策略**可配置** | ❌ `BashSandboxConfig` 从 `config.json` **设不到** | `host/src/plugins.ts:320` |
| 补偿回滚（快照） | ✅ git 快照 + `/revert` + `/snapshot` | `packages/snapshot`、`packages/revert` |
| 多 Agent 文件系统隔离 | ✅ subagent git worktree | `subagent/src/worktree.ts` |
| 人工决策审计 | ✅ `decision.human` 落 `.audit.jsonl`（三宿主） | `host/src/audit.ts` |

一句话结论：**"该拦的都拦了，但拦在同一个进程里"** —— 缺的不是策略，是**执行边界**与
**资源边界**。

## 1. 已具备（按层归类，避免重复造）

### 1.1 工具层（`tools-builtin` 的 bash 工具，`createBashTool(config)`）

| 层 | 内容 | 位置 |
|---|---|---|
| 危险命令检测（前置硬性拒绝，回退也不可豁免） | 默认 **12 条**正则：fork bomb / `rm -rf /` / `rm -rf ~` / `mkfs.*` / `dd` 写裸盘 / 重定向写裸盘 / 破坏性命令带裸设备 / 关机重启 / `format /s /f /q` / `curl\|bash` / `chmod -R 777 /` / `sudo rm -rf /` | `DEFAULT_DANGEROUS_PATTERNS` |
| **AST 复核门**（增强，非替代） | 在**引号解码后**的字面量上重跑危险表 + 「命令名含展开 ⇒ 拒（除 `$(which x)` 路径解析惯用法）」；wasm 不可用/语法错 ⇒ 回落原始正则，**绝不因此放行** | `bash-ast.ts`、`detectAstDangerous` |
| cwd 限制 | `input.cwd` 必须落在 `rootDir`（默认 `ctx.cwd`）内 | `SANDBOX_CWD` |
| env 隔离 | 按 6 条敏感名正则过滤（AWS / GitHub / OPENAI·ANTHROPIC·… / API_KEY·SECRET / PASSWORD / PRIVATE_KEY） | `DEFAULT_SENSITIVE_ENV`、`sanitizeEnv` |
| 命令白名单 | 只认**首命令名**或**完整片段**；`allowlist=['git']` 不会放过 `echo git && rm -rf /` | `SANDBOX_ALLOWLIST` |
| 宿主回退 + 二次确认 | 白名单外非破坏性命令 / 沙箱内非零退出 ⇒ 提升宿主 bash，**回退前再经权限引擎**（pattern 前缀 `host:`，ask 模式再问一次） | `fallbackToHost`、`requireHostApproval` |
| 只读哨兵 `bash_ro` | 白名单 + 结构门（重定向 / 进程替换 / heredoc / 命令替换 / 提权）+ AST 双门 | `createReadOnlyBashTool` |
| 文件工具路径边界 | `read_file` / `write_file` / `edit_file` 一律 `PATH_OUTSIDE_CWD` | `tools-builtin:144/287/1465` |
| 网络工具 SSRF | 拒非 http(s)、拒私有 IP / localhost；`permission.key='network'` | `tools-web/src/index.ts` |

### 1.2 权限层（`@harness/host`，三宿主共用一份）

- **三模式** `allow-all` / `ask` / `deny-all`；**四态**答复 `allow` / `deny` / `always-allow` /
  `always-deny`（`always-*` 写回 `permissions.json`）。
- **缺省 fail-closed**：宿主不给 `asker` ⇒ `InteractivePermissionEngine` 取不到答复即 **deny**。
- **风险分级**（M3）：`assessRisk(toolKey, patterns, input)` → `low|medium|high`，**只打标签不决策**。
- **段级 `denyPatterns`**：`bash` 用引号感知的 `splitSegments` 上报每一段，让 `deny: ['shutdown*']`
  能拦住 `echo hi; shutdown -h now` —— 且**刻意不进 `patterns`**（allow 是任一命中即放行，混进去会放宽）。
- **结构守卫** `guardInput`：越过管道直调 `tool.call()` 那条路径的兜底。
- **审计**：`decision.human` 零内容信封（标量 + `stateHash`）落 `{dataDir}/sessions/{id}.audit.jsonl`。

### 1.3 边界与身份层

- **工作区**：一个工作区 = 一个 `cwd` + 一个 `dataDir`；user 级 `~/.harness` × project 级
  `<cwd>/.harness`，**project 覆盖 user**（见 `workspace-management.md`）。
- **Agent 能力域**：`tools: ['*']` / `mcpServers` / `excludeMcpServers` —— 按 Agent 裁剪工具面。
- **A2A**：`Bearer` token（**未配 ⇒ 匿名放行，但此时只监听 `127.0.0.1`**）；`callerKey()` 把
  `contextId` **首次使用即绑定**给调用方，他人复用同 id ⇒ `ContextForbiddenError`
  （`contextId` 就是 `sessionId`，读同一份历史与工作目录）。
- **subagent**：每个子 Agent 一个独立 **git worktree**，从文件系统层隔离并行写操作。

### 1.4 补偿控制（"拦不住"之后的兜底）

快照（`GitSnapshotService`，每轮 capture + `meta.snapshot`）/ `/revert` / `/snapshot`；
审计；doom-loop 熔断（尾部连续 3 个完全相同签名）。

## 2. 分层目标形态（本方案的骨架）

现状是"一堆布尔开关"，目标是**四层可声明、可观测、可降级**的档位。

| 档 | 名字 | 内容 | 现状 |
|---|---|---|---|
| **L0** | **策略层** | 危险表 + AST 门 + 白名单 + 权限引擎 + 段级 deny + 审计 | ✅ 已有，只差"可配置"（见 P0-1） |
| **L1** | **进程层** | 资源上限（CPU / 内存 / 文件大小 / 进程数）、**超时杀进程树**、env **默认拒绝**（不是默认放行） | ❌ 全缺 |
| **L2** | **文件系统 / 网络绑定** | 目录读/写**分域白名单**；用 OS 原语把可写区**真的**限制在声明目录内（macOS `sandbox-exec` / Linux `bwrap`·`landlock`）；网络策略 `deny` / `allowlist` / `open` | ❌ 全缺 |
| **L3** | **平台层** | 容器 / microVM / 远程 executor（A2A 远程场景的终态） | ❌ 未做（与 `external-integration-plan.md` §9 的"执行后端"合流） |

**四条设计纪律**（与既有仓库纪律同源）：

1. **能力探测**：`probeIsolation()` 与 `resolveShell()` 同范式 —— 探测本机有没有
   `sandbox-exec` / `bwrap` / `landlock`，结果进档位判定。
2. **不模拟**（跨平台那轮定的原则，这里同样适用）：**拿不到 OS 原语就显式降级并告警**，
   绝不"看起来隔离了"。降级必须落 notice + 审计。
3. **可声明**：`config.json → sandbox.{level,fs,net,limits}`；宿主可要求"**至少 L2**，
   达不到就拒绝启动"（而不是静默跑在 L0）。
4. **可观测**：`BashOutput.isolation = { level, fsBound, netPolicy, viaHost }`；审计信封加
   `isolationLevel`。模型与人都要知道"我现在跑在什么边界里"。

## 3. 待补清单

### 3.0 P0 —— **静默失效或安全漏判**（先做这批）

| # | 缺口 | 为什么是 P0（判据） | 位置 |
|---|---|---|---|
| P0-1 | **沙箱策略从 `config.json` 根本设不到** | 组合根用**无参单例**注册：`load: async () => (…).toolsBuiltinPlugin`，而 `toolsBuiltinPlugin = createToolsBuiltinPlugin()`。于是 `allowlist` / `rootDir` / `dangerousDetection` / `sanitizeEnv` / `fallbackToHost` **一条都不可配**。用户"在 config 里写了白名单以为生效"是**静默失效**——比没写更危险 | `host/src/plugins.ts:320`、`tools-builtin/src/index.ts:1630` |
| P0-2 | **MCP 子进程全量继承 env（与 bash 的隔离不对称）** | `spawn(command, args, { env: { ...process.env, ...config.env } })` ⇒ 同一个 `GITHUB_TOKEN`，bash 里被摘掉、**第三方 MCP server 里照样读得到**。而 MCP server 恰恰是外部代码 | `mcp-client/src/index.ts:147` |
| P0-3 | **读侧无隔离：cwd 内的密钥文件默认可读** | `isWithinCwd` 只保证"在 cwd 里"，于是 `cat .env` / `cat .harness/.config-key` / `cat ~/.harness/permissions.json`（若 cwd 覆盖）畅通。bash 的 env 过滤挡不住**从文件里再读一遍** | `tools-builtin` 的 `read_file` / `bash` |
| P0-4 | **路径边界只做字符串前缀，无 `realpath` 解析 ⇒ symlink 逃逸** | `isWithinCwd = !relative(cwd, p).startsWith('..')`，而 `resolvePath` 只用 `resolve`（不做符号链接解析）。cwd 内一条 `ln -s /etc secret` ⇒ `secret/passwd` 的 `relative` 是 `secret/passwd`，**判定通过**，`stat/open` 却跟随链接读到外部。对照：`skill` / `subagent` 已经用 `realpathSync` 兜底，**工具侧没有** | `tools-builtin/src/index.ts:46-52` |
| P0-5 | **`isWithinCwd` / `resolvePath` 在 6 个包各写一份** | `tools-builtin` / `tools-glob` / `tools-search` / `tools-media` / `code-intel` / `subagent`。安全边界**修一处漏五处**，且语义已开始漂移（有的比 `resolve`、有的比真实路径） | 各包 `index.ts` / `core.ts` |
| P0-6 | **超时只杀直接子进程，不杀进程树**（沙箱视角） | `cross-platform-plan.md` P0-5 已从"跨平台"记过；从**隔离**角度更重：超时后沙箱内的 `npm run dev` 还在跑 ⇒ 隔离边界外仍在产生副作用（占端口、写文件、出网） | `runBash` 的 timer 分支 |
| P0-7 | **`fallbackToHost` 的档位下沉没有记录** | 一旦开启，命令从"沙箱约束"升到"宿主全权"（放开白名单 + 放开 env 隔离 + 补系统 `PATH`）。`requireHostApproval` 默认 true 是好的，但 **allow-all 模式下静默放行且不留痕**（`viaHost` 只在返回值里，审计不记） | `tools-builtin` 回退分支 |
| P0-8 | ✅ **已修**（2026-10-11，见开发日志续 272）—— 原文：「始终允许」写回是整键覆盖 ⇒ 段级 `denyPatterns` 永久失效（§8 D1） | 提示里显示的是**具体命令**，写回却是 `rules[toolKey] = 'allow'`：①粒度=**整工具**（`ls` 与 `rm -rf` 同键同命）；②**整键覆盖**已有 PathRules（`deny: ['shutdown*']` 直接丢）；③规则退化为 **string** 后 `check()` 走 `typeof toolRule === 'string'` **直接 return**，`denyTargets` **整体不再参与** ⇒ `echo hi; shutdown -h now` 被放行。**测试盲区**：`permission-deny-patterns.test.ts` 只钉了"string 规则不受 denyPatterns 影响"这一形态，**没有覆盖"always-allow 把 PathRules 变成 string"这条写回路径**。⚠️ 修复时发现 ② 的可行形态与初稿不同：string 形态**没有自己的 deny 列表**，"过 denyTargets"只能落成**全局 deny 否决权**（详见 §8.6） | `host/src/permission.ts:283/300`、`core/src/index.ts:492` |
| P0-9 | **授权不跟调用方走，但身份跟**（§8 D2） | 规则集落 `<dataDir>/permissions.json`（dataDir 缺省 `~/.harness`），而 A2A 与本地 TUI **在该工作区解析到同一份**。身份层做得很干净（`callerKey()` 首次使用即绑定 `contextId`，他人复用 ⇒ `ContextForbiddenError`），**权限层没有跟上**：`check()` 只读 `toolKey/patterns/denyPatterns`，`sessionId` 仅用于 asker 路由与审计归属，**不进规则匹配、也不进写回**。⇒ 本地点一次「始终允许」，同工作区的远程 A2A 调用方一并继承（反向亦成立）。控制面只听 `127.0.0.1` 是缓解、不是隔离。**本仓独有**（Codex / Claude Code 是单机单用户，不存在这个面） | `host/src/host.ts:361`、`workspace/src/index.ts:134`、`a2a-server/src/auth.ts:42/63` |

### 3.1 P1 —— **能力缺口**

| # | 缺口 | 说明 | 位置 |
|---|---|---|---|
| P1-1 | **无资源上限** | 没有 CPU / 内存 / 文件大小 / 进程数限制。一条 `yes > /dev/null`、一次 `npm install` 打满内存即可拖垮宿主；`ulimit` / `setrlimit` 可解（L1） | `runBash` |
| P1-2 | **无网络出口策略** | `tools-web` 有 SSRF 防护，但 **`bash` 里的 `curl` / `wget` 出网完全不受限**（含访问云元数据端点 `169.254.169.254`）。需要 `sandbox.net = deny \| allowlist \| open` | `tools-builtin` |
| P1-3 | **无 OS 级只读绑定** | 没有把工作目录"真的"绑定成唯一可写区（macOS `sandbox-exec` profile / Linux `bwrap --ro-bind /` + `--bind cwd` / `landlock`）。L0 的策略一旦被绕过（P0-4 就是例子），没有第二道墙 | 新模块 |
| P1-4 | **无"隔离档位"概念** | 现在是"策略全开 / 全关"的布尔，宿主无法表达"我要 L2，没有就拒绝启动"。**这是 §2 要补的核心结构** | `HostOptions` / `config.json` |
| P1-5 | **插件代码开闸即进程内全权** | `allowPluginCode: true` 后 `.harness/plugins/*.ts` 以完整 Node 权限运行，无 `worker` 边界、无 API 白名单、无静态扫描。默认关闭是好的止损，但**开闸后没有任何边界** | `host/src/plugins.ts`、`host/src/host.ts:748` |
| P1-6 | **swarm 的 `sandbox_permission_*` 是死协议** | 类型联合、`isStructuredProtocolMessage` 白名单、inbox 消费分支**都在**，但**没有任何生产者** ⇒ 多 Agent 场景下"子 Agent 越界申请授权"这条路其实不存在 | `swarm/src/index.ts:271/315/810` |
| P1-7 | **MCP server 无能力声明** | `mcpServers` 只有名单，没有"这个 server 允许读哪些目录 / 能不能出网"的约束；第三方 server 拿到的是全量 env（见 P0-2）与完整 FS（见 P0-4） | `mcp-client` |
| P1-8 | **`read_file` 无大小 / 类型闸** | 读 2GB 日志、读块设备、读 `/dev/zero` 无任何提示（既是可用性问题也是安全问题） | `tools-builtin` 的 `read_file` |
| P1-9 | **手改规则无审计**（§8 D5） | 两条"直接改规则并写盘"的路径**都不发事件**：CLI `/permission <key>=<behavior>` / `reset`（`cli/src/index.ts:1330`）与 A2A 控制面 `harness/permission.set`（`a2a-server/src/control.ts:587`，含 `reset` / `mode` / `rules` / `key+behavior` 四形态）。审计目前**只有 `decision.human` 一种 kind** ⇒ "权限是被谁、何时、从 allow 改成 deny 的"不可回溯。**这是 D2 的配套**：授权对象分层后，规则的每次变更更需要留痕 | `cli/src/index.ts:1330`、`a2a-server/src/control.ts:587`、`host/src/audit.ts` |

### 3.2 P2 —— **体验一致性**

| # | 缺口 | 说明 |
|---|---|---|
| P2-1 | 档位**不可见** | `env-context` 已经在注入 `Shell:`，应并排注入 `Isolation:`（L0/L1/L2 + fs/net 策略）。模型不知道自己的边界，就会反复撞同一面墙 |
| P2-2 | 拒绝文案要**可执行** | 延续既有纪律（`bash_ro` 的结构门带 `why`）：每条隔离拒绝都给「为什么 + 怎么改」。历史教训：文案指向给不出所需信息的工具 ⇒ 模型空转 |
| P2-3 | `BashOutput` 加 `isolation` | `{ level, fsBound, netPolicy, viaHost }`，让模型（与取证脚本）知道这次执行的边界 |
| P2-4 | 文档口径 | README / `AGENTS.md` 要写清「**当前隔离是策略级，不是 OS 级**」，并说明什么场景必须上 L2/L3 |
| P2-5 | **风险标签失去区分度**（§8 D4） | `assessRisk` 的 `HIGH_RISK_TOOL_KEYS` 含 `bash` ⇒ **bash 恒为 `high`**，`ls` / `pwd` / `echo` 与 `rm -rf` 同一个标签。高危模式表（`rm -rf` / `sudo` / `dd if=` …）因此**只在工具键不在表里时**才有机会生效。标签不决策、但它是决策卡片的唯一提示 | `host/src/permission.ts:70/85` |
| P2-6 | **提示文案键位自相矛盾**（§8 D6） | `buildPermissionPrompt().text` 写 `allow / deny / always(a) / deny-always(d)? [a/d/A/D]` —— 前半说 `always` 是 `a`，方括号里 `a` 却是 allow、`A` 才是 always。而实际实现正是 `'A' → always-allow`、`'a' → allow`（`parseCliAnswer`）。照前面读会**把"始终允许"按成"允许一次"**（或反之） | `host/src/permission.ts:141`、`cli/src/index.ts:396` |
| P2-7 | **`mode` 是进程级，"会话级切换"不存在**（§8 D7） | `InteractivePermissionEngine.mode` 是实例字段，一个进程内**所有会话共享**；`setMode()` 注释也写明"不影响持久化规则"。CLI 的 `/permission <mode>` 文案容易被读成"只对当前会话生效"。要么写清"进程级"、要么真做成会话级（依赖 P0-9 的分层结构） | `host/src/permission.ts:194/223`、`cli/src/index.ts:1348` |

### 3.3 P3 —— **工程与防回归**

| # | 缺口 | 说明 |
|---|---|---|
| P3-1 | **路径边界统一到一处** | 把 `resolvePath` / `isWithinCwd`（含 `realpath` 版本）收敛进 `@harness/tool`（或新 `@harness/fs-guard`），一处实现 + 跨包守卫测试双向钉住（延续"同一语义只有一份"纪律，见 `permission.ts` 文件头的同类论证） |
| P3-2 | **`probeIsolation()`** | 探测本机可用的隔离原语，与 `resolveShell()` 同范式（注入 `{ platform, exists }` 即可单测，不需要真机） |
| P3-3 | **三平台 CI** | 与 `cross-platform-plan.md` P1-5 同一条：没有矩阵，任何隔离修复都会在下次改动里静默回归 |
| P3-4 | **渗透用例集** | symlink 逃逸 / env 泄漏 / 内网探测 / fork bomb / 磁盘写满 / 进程树残留 —— 作为回归门，每条都能自动判 |

## 4. 建议实施顺序

1. **P0-1 可配置**（`sandbox` 段进 config + 组合根透传）—— 不先做这条，后面所有策略用户都摸不到。
2. **P0-4 + P0-5 + P3-1 一起做**：把路径边界收敛成一份 **`realpath` 版**实现，替换 6 处副本。
   一次改完、一次测完（可注入 `platform` 做纯函数测试）。
3. **P0-2 + P0-3**：env 白名单化（默认拒绝）覆盖 MCP 子进程；读侧对 `.env` / `.config-key` /
   `permissions.json` 这类**已知敏感名**加默认拒绝（可 `keepPaths` 放行）。
4. **P0-6 + P1-1**：进程组 / 进程树 kill + `ulimit` 资源上限（真机验证，或至少 process-group 单测）。
5. ~~**P0-8**~~ ✅ **已完成**（2026-10-11，见开发日志续 272）：`rememberRule` 改 **PathRules 增量写回**；
   `check()` 加**全局 deny 否决权**（措辞订正见 §8.6 —— string 形态**没有自己的 deny 列表**，
   "string allow 也过 denyTargets"只能落成"从全局借 deny 列表"）。
   **剩余 P0-9 + P1-9 一起做（授权域收敛，见 §8）**：③规则**按归属分层**
   （`session:<id>` → `caller:<key>` → 工具 → 全局，`check()` 逐层回退，写回带归属键）；
   ④`kind: 'permission.rule.changed'`（零内容 + `stateHash` + 来源 `cli|control-api|asker`）。
   **必须带反向验证**：补"远程 caller 不继承本地 always-allow"一条。
6. **P1-4 档位结构 + P1-3 OS 绑定**：先定义 `probeIsolation()` 与档位语义，再接第一个
   OS 原语（macOS `sandbox-exec` 最易验证）—— **拿不到原语就按 §2 纪律 2 显式降级告警**。
7. **P1-2 网络策略**、**P1-6 死协议收口**（要么接生产者、要么删掉类型）、**P2 批次**
   （含 D4/D6/D7 文案与判据调整）、**P3-4 渗透集**。
8. **P1-5 / P1-7 / L3**：与 `external-integration-plan.md` §9 的"执行后端抽象"合流后统一做。

> **与 L2 的排期分叉**：第 5 步（授权域）与第 6 步（L2 OS 绑定）**互不阻塞**，但有先后意义 ——
> **若 L2 先做**，第 2 步的 P0-4/P0-5（字符串判定）定位从"主防线"降到"纵深防御"；
> **若 L2 要等**，P0-4 必须马上做，因为它此刻是唯一那道墙。两者都做不是重复投入，
> 但**只做一个则另一个必须紧跟着补位** —— 详见 §8.5。

## 5. 验收口径（每一条都要能自动判）

- **纯函数层**：注入 `{ platform, shellFamily, exists }` 断言判定结果与档位（`resolveShell` 的用例即此范式），
  **不需要真机**。
- **行为层**：跨平台可用的断言（`exitCode` / 文件是否被创建 / 目标文件是否可读），避免 `seq` 之类 POSIX 命令。
- **渗透层**：每条 P0/P1 都要有**反向验证** —— 把修复注释掉，确认**指定条数**变红（本仓既有纪律，
  见 `AGENTS.md` §4 的验证协议）。symlink 逃逸与 env 泄漏两条尤其必须有真机用例。
- **降级可见**：任何"拿不到 OS 原语 ⇒ 降一档"的路径，都要断言**产生了 notice / 审计条目**，
  防止静默降级（这是本方案最容易悄悄退化成"看起来隔离了"的地方）。

## 6. 与其它计划的关系

- **平台差异**（Windows 的 shell / 路径 / 进程树）见 [`cross-platform-plan.md`](cross-platform-plan.md)
  —— 两份计划的 **P0 有交集**：它的 P0-5（超时不杀进程树）、P0-6（UNC 路径）在本方案里同时是
  P0-6 与 P0-4 的形态之一，**修的时候一次改到位**，别各修一半。
- **宿主装配**（`@harness/host` 一份、`HostOptions` 契约）见 [`host-extraction-design.md`](host-extraction-design.md)；
  本方案的 `sandbox` 配置与档位约束都进 `HostOptions`。
- **执行后端替换 / 远程执行**（Codex / Claude Code / 远程 runner）见
  [`external-integration-plan.md`](external-integration-plan.md) §9 —— 那是本方案 **L3** 的落点。
- **权限语义**（四态答复 / 规则写回 / 审计信封）见 `host/src/permission.ts` 与 `host/src/audit.ts`；
  本方案只**新增**档位与执行边界，**不改**权限语义（"决策权归人工"这条不动）。
  §8 提出的 D1/D2 是**缺陷修复**（写回粒度 / 授权作用域），不是语义变更 —— 四态答复、
  规则写回、零内容审计信封的形状都保持；改的只是"**记住什么范围**"与"**记住给谁**"。
- **多 Agent 隔离**（subagent worktree / swarm）见 `agent-harness-architecture.md` §九；
  P1-6 是那里留下的一个空壳。

## 7. 业界方案对照（光谱 · 共识 · 采纳建议）

> 本节是调研附录，用来把 §2 的 L0–L3 **锚定到业界坐标**上：我们现在在哪一格、每一格
> 别人是怎么做的、哪一格可以直接抄。**不引入新待办**（待办仍以 §3 的 P0/P1/P2/P3 为准）。

### 7.1 一条主线：边界由谁强制

不是"用哪个工具"，而是"**谁不让做**"——是应用自己拦 API，还是内核/硬件不让做。

| 层 | 边界由谁守 | 代表方案 | 谁在真用 | 越狱成本 |
|---|---|---|---|---|
| 进程内 | 应用自己（拦 API） | Node `vm`、`vm2`✝、`isolated-vm`、QuickJS-Wasm、Deno `--allow-*` | 插件 / 表达式求值 | 极低（vm2 已因无法修补的逃逸**停止维护**） |
| WASM | 运行时 + 能力句柄 | Wasmtime、Wasmer、wasmCloud、Wassette、Pyodide | Envoy 插件、多租户插件、微软 Wassette（跑 MCP） | 中（线性内存 + 无 ambient authority） |
| OS 原语 | 内核 | macOS Seatbelt、Linux bubblewrap / Landlock+seccomp、Win AppContainer+WFP | **Anthropic `srt`**、**OpenAI Codex CLI** | 中高（要内核漏洞） |
| 容器 / 强化容器 | 命名空间+cgroup（共享内核）→ gVisor/Kata 才破共享 | Docker·Podman 加固、Sysbox、gVisor(`runsc`)、Kata Containers | Modal、GKE、企业多租户 | 高 |
| MicroVM | 硬件虚拟化 | Firecracker、Cloud Hypervisor、microsandbox | E2B、Vercel Sandbox、Fly、GKE Agent Sandbox | 极高 |

对应到本文：**今天我们全部落在第 1 格的最弱形态**（甚至不是"拦截 API"，而是"写完命令后检查字符串"），
§2 的 L2 才是往第 3 格走，L3 是第 4/5 格。

### 7.2 冷启动量级（差三到四个数量级，这是选型的核心权衡）

| 方案 | 冷启动（量级） | 每实例内存 |
|---|---|---|
| WASM（Wasmtime AOT） | ~0.04 ms | 1–5 MB |
| V8 isolate（Cloudflare Workers / Dynamic Workers） | ~1.5 ms | 3–10 MB |
| 容器（gVisor） | ~50 ms | 20–50 MB |
| 容器（`runc`） | ~100 ms | 30–100 MB |
| microVM（Firecracker） | ~125 ms | 5–20 MB |
| 云沙箱（预热池：Daytona 90ms / E2B ~150ms） | 90–150 ms | — |

数字来源见 §7.6 各实现文档；此处只需记住**量级**。

### 7.3 三条可直接采纳的业界共识

1. **默认拒绝**，三个面同构：网络 `allow-only` 域名表 + **宿主侧 HTTP/SOCKS 代理**（沙箱内进程
   根本没有网络命名空间）；写 `allow-only` 路径表；读 `deny-then-allow`。加固容器侧对应
   `--cap-drop ALL --security-opt no-new-privileges --read-only --network none --pids-limit`
   + 只挂一个 Unix socket 走代理。**这正是我们 §2-L2 的目标口径**。
2. **违规要"可读"**：`srt` 把拦截事件转成**结构化 JSON 反馈**交给 agent，让它自己改道，而不是
   静默杀进程。与我们既有的 P2-2（拒绝文案必须可执行）是同一纪律；落地时它同时喂
   `BashOutput.isolation`（P2-3）与审计信封。
3. **不自研隔离原语**：各平台一律用系统自带（Seatbelt / bubblewrap·Landlock+seccomp /
   AppContainer+WFP），产品层只做**探测 + 编排 + 降级**。这正是 §2 纪律 1/2（`probeIsolation()`
   与"拿不到就显式降级"）的行业依据。

### 7.4 我们与业界的差异（三点，**不要照抄**）

1. **业界不做"命令级白名单"**。`srt` / Codex 的边界是 **FS + 网络绑定**，它们不解析命令字符串。
   我们今天的危险表 + bash 白名单 + AST 门，是"**因为还没有 L2**"的替代品。⇒ **L2 落地后，
   L0 的命令白名单应从"主边界"退到"纵深防御"**（P0-4 的 symlink 逃逸恰恰证明字符串判定守不住）。
2. **我们必须在"无常驻进程"约束下工作**。云沙箱与 Docker Sandboxes 都以"装一个
   daemon / hypervisor"为前提；我们是本地插件式 harness（CLI / A2A / VSCode 三宿主）。
   ⇒ 默认路线只能落在**第 3 格（OS 原语）**，容器 / microVM 是 **L3 可选**而非默认；这与 §2
   纪律 2「不模拟」一致——拿不到原语就降级告警，不硬凑。
3. **我们的策略层是独有的**。三模式权限引擎 + 四态答复 + 规则写回 + 零内容审计信封，
   业界（`srt` / Codex）只有"permissive / restricted"两档。**这块不抄**——"决策权归人工"是本仓
   的一等公民，本方案只**新增**执行边界，不动权限语义（§6 已钉）。

### 7.5 采纳建议（按我们的档位）

| 我们的档 | 抄谁 | 说明 |
|---|---|---|
| **L0** | （自研，无对标） | 命令级策略是我们的差异项；L2 到位后退居纵深 |
| **L1** | `ulimit` / `setrlimit` + 进程组 kill | 业界共识做法；同时解 P1-1 与 P0-6 |
| **L2** | **`@anthropic-ai/sandbox-runtime`（`srt`）** | 三平台差异已被它抹平：macOS Seatbelt / Linux bubblewrap·Landlock+seccomp / Windows 专用本地账户 + WFP，网络走宿主侧 HTTP+SOCKS 代理 + 域名 allowlist。Apache-2.0，可对标甚至 vendored |
| **L3** | Firecracker 系 | E2B / Vercel Sandbox / GKE Agent Sandbox 同一底座；与 `external-integration-plan.md` §9 合流 |

**Linux 上有一个真实分叉**：`srt` 选 **bubblewrap**（需系统预装 `bwrap`），Codex 选
**Landlock + seccomp**（内核原生 5.13+，**无外部依赖**）。⇒ **我们倾向 Landlock + seccomp**，
因为"无外部依赖"更贴合我们"开箱可用 + 探测降级"的口径；bubblewrap 作为可选增强（探测到才用）。
这条会直接决定 P3-2 `probeIsolation()` 的探测项。

### 7.6 外部参考实现

- **Anthropic `srt`**：`github.com/anthropic-experimental/sandbox-runtime`，
  npm `@anthropic-ai/sandbox-runtime`（Apache-2.0）。**本方案 L2 的首选对标**。
- **OpenAI Codex CLI 沙箱**：macOS 12+ Seatbelt（`codex debug seatbelt`）/ Linux Landlock+seccomp
  （`codex debug landlock`）/ Windows restricted token；默认 `workspace-write` 且网络默认关。
- **gVisor / Kata Containers / Firecracker**：第 4/5 格（L3 候选）。
- **WASI（Wasmtime）能力模型**：若未来要给**插件代码**（P1-5）划边界，这是比 `worker` 更强的答案
  ——默认零能力、显式导入才可达。
- ⚠️ **`vm2` 已停止维护**（作者明确"不应作为安全边界"），且**在 Bun 上明确"不是安全边界"**
  （其威胁模型基于 V8 内部，Bun 用 JSC、未审计）。**本仓跑在 Bun 上 ⇒ 这条尤其要记**：
  任何"在同一个进程里跑不可信 JS"的方案，在本仓都不成立。

## 8. 权限设计评审（三问直答 + 缺陷清单）

> 起点 2026-10-11。放在沙箱方案里的理由：**权限层（谁批准）与隔离层（批准之后能做到什么）
> 是正交的两层** —— 我们两层都有，但只把"边界"当成了问题。本节把**权限层自身的缺陷**逐条
> 钉住，其中 D1/D2 与 §3 的 P0 同族（静默失效 / 安全漏判），故已收编为 **P0-8 / P0-9**。

### 8.1 三个问题直答

| 问题 | 答案 | 依据 |
|---|---|---|
| 支持「允许一次 / 始终允许」吗 | ✅ 支持，**四态**：`allow` / `deny` / `always-allow` / `always-deny`；`always-*` 写回规则集与磁盘 | `host/src/permission.ts:30`（类型）、`:277`（`answerToDecision`）、`cli/src/index.ts:393`（`parseCliAnswer`） |
| 权限**跟会话**走吗 | ❌ **不跟**。`check()` 只读 `toolKey` / `patterns` / `denyPatterns`；`sessionId` 仅用于 **① asker 路由 ② 审计归属**，**不参与规则匹配、也不参与写回** | `core/src/index.ts:449`、`host/src/permission.ts:248/300` |
| 那权限的实际作用域是 | **工作区级**：跨会话、跨进程持久，落 `<dataDir>/permissions.json` | `host/src/host.ts:361`（`saveRules`）、`host/src/host.ts:348`（`files.permissions`） |
| `allow-all` / `ask` / `deny-all` 这个**模式**呢 | 是**进程内内存态**，不落盘、重启复位 —— `setMode` 注释写明"不影响持久化规则"。**这条是对的**，但也意味着"会话级切换"并不存在（见 P2-7） | `host/src/permission.ts:222-225` |

### 8.2 缺陷清单（按严重度）

| # | 严重度 | 缺陷 | 收编 |
|---|---|---|---|
| **D1** | 高 | 「始终允许」粒度 = **整工具**、且**整键覆盖**已有 PathRules；写回后规则退化为 string，**段级 `denyPatterns` 从此整体失效** | **P0-8** |
| **D2** | 高 | 授权**不跟调用方/会话**走（规则集是 dataDir 级共享），而**身份**是按 `contextId` 绑定的 ⇒ 一边隔离、一边不隔离 | **P0-9** |
| **D3** | 中 | `allow` 之后以**宿主全权限**执行 ⇒ 「允许一次」与「始终允许」在**本次的实际危害相同** | 无需新条目 —— 就是 §2-L2 缺失的直接后果（见 §8.5） |
| **D4** | 中 | `assessRisk` 对 `bash` **恒为 `high`**（`ls` / `pwd` 也是），标签失去区分度 | P2-5 |
| **D5** | 中 | **手改规则无审计**：CLI `/permission <key>=<behavior>` 与 A2A 控制面 `harness/permission.set` 都直接写盘、**都不发事件** | P1-9 |
| **D6** | 低 | 提示文案键位自相矛盾：写 `always(a)`，实际 `a` = 只放行一次、`A` = 永久 | P2-6 |
| **D7** | 低 | `mode` 是**进程级**（一个进程内多会话共享），"会话级切换"并不存在 | P2-7 |

### 8.3 D1 深挖：提示一套、写回另一套

三层证据链，全部逐字可验：

```
提示（用户看到的）                    host/src/permission.ts:141
  text: `操作: allow / deny / always(a) / deny-always(d)? [a/d/A/D]`
        并列出具体 patterns（`pat = patterns.slice(0,3).join(', ')`）

写回（实际做的）                       host/src/permission.ts:283 → :300
  case 'always-allow': await this.rememberRule(toolKey, 'allow')
  rememberRule: updated = { ...getRules(), [toolKey]: 'allow' }   ← 整键覆盖

生效（下一轮的判定）                    core/src/index.ts:492
  if (typeof toolRule === 'string') return { behavior: toolRule, ... }   ← 直接 return
```

三个后果，逐条都指向"收紧方向失守"：

1. **粒度是整工具，不是命令**。用户在 `bash` 的提示上按「始终允许」，记住的是 **`bash` 整个工具**，
   不是 `ls` / 不是 `npm test`。同一键下 `rm -rf` 与 `ls` 同命。
   （对照业界：Claude Code 记 `Bash(npm test:*)` 这类**命令前缀**，Codex 记**具体命令**。）
2. **整键覆盖丢规则**。`{ bash: { allow: ['echo*'], deny: ['shutdown*'] } }` 按一次 always-allow
   就变成 `{ bash: 'allow' }` —— 用户配的 `deny` 直接消失。
3. **`denyPatterns` 永久失效**。规则退化成 string 后，`check()` 在 492 行**直接返回**，
   `denyTargets`（`[...patterns, ...denyPatterns]`，专为拦 `echo hi; shutdown -h now` 而设）
   **整体不再参与判定**。这是**唯一的段级防线**，且失效是**静默**的。

**测试盲区（为什么没被早发现）**：`core/src/permission-deny-patterns.test.ts:77` 有一条
「工具级 string 规则不受 denyPatterns 影响」—— 它钉的是**形态本身**（string ⇒ 不走 denyPatterns），
**没有覆盖"always-allow 会把 PathRules 变成 string"这条写回路径**。即：测试固化了"string 规则不受
denyPatterns 影响"这个事实，却没人问"规则**什么时候**会变成 string、变成之后谁来兜"。
⇒ 补 P0-8 时必须加两条反向用例：**①always-allow 之后段级 deny 仍生效；②写回不丢已有 `deny`/`ask`**。

### 8.4 D2 深挖：身份是一等的，授权不是

三层作用域并排看，问题一眼可见 —— **身份层做对了，权限层没跟着做**：

| 维度 | 作用域 | 是否按调用方/会话隔离 | 依据 |
|---|---|---|---|
| 会话历史 / 工作目录 | `contextId`（= `sessionId`） | ✅ 按调用方绑定 | `a2a-server/src/auth.ts:42/63`：`callerKey()` 首次使用即绑定，他人复用 ⇒ `ContextForbiddenError` |
| 询问路由（asker） | 全局单槽 + `sessionId` 分发 | ✅ 有归属 | `packages/permission/src/index.ts:99-112` |
| 审计归属 | `sessionId` 落文件名 | ✅ 有归属 | `host/src/audit.ts` |
| **权限规则** | **`<dataDir>/permissions.json`** | ❌ **无归属** | `host/src/host.ts:361`、`workspace/src/index.ts:134`（`dataDir` 缺省 `~/.harness`） |

`resolveWorkspace({cwd, dataDir})` 在 A2A 与本地 TUI 两侧**默认解析到同一个 `dataDir`**（同 cwd 时），
于是两边共用同一份规则。结果：

- 本地点一次「始终允许」⇒ 同一工作区的**远程 A2A 调用方一并继承**；
- 反向：控制面 `harness/permission.set` 写盘 ⇒ **本地继承**。

控制面只监听 `127.0.0.1` 是**缓解**（不是隔离）：它挡住了"网络上的陌生人"，挡不住"**同一台机器上的
另一个 harness 宿主/进程**"，也挡不住"运维用控制面批量改规则后，本地被顺带提权"。

**这条是本仓独有的**。Codex / Claude Code 是单机单用户，"授权对象是谁"这个问题不存在；我们多出来的
A2A 远程面，把它第一次暴露了出来 —— 而解法不需要新机制，**`PermissionRequest.sessionId` 已经在传了、
asker 路由也已在用了，只差把它接进规则匹配与写回**（P0-9 的第③条）。

### 8.5 与沙箱的关系：正交两层，但失效时互相放大

一句话：**权限管"谁批准"，沙箱管"批准之后能做到什么"。我们现在只有前者。**

- **D3 就是这两层的接缝**：「允许一次」与「始终允许」在**本次**危害相同，因为批准之后一律以
  **宿主全权限**执行（§0 / §7.1 第 1 格）。⇒ 沙箱档位（L2）落地直接缩小 D3 的影响面。
- **P0-7（`fallbackToHost` 升权不留痕）是同一族**：授权之后的执行边界一旦失守，
  "授权"这件事本身就没有意义 —— 所以它不是小毛病。
- **排期分叉（§4 第 5/6 步）**：
  - 若 **L2 先做**：P0-4/P0-5（字符串路径判定）从"主防线"降为"纵深防御"，**仍要做**
    （L2 拿不到原语降级时，它是唯一那道墙）。
  - 若 **L2 要等**：**P0-4 必须马上做**，因为此刻它就是唯一那道墙。
  - 两者都做不是重复投入；**只做一个则另一个必须紧跟着补位**。
- **D1/D2 不依赖沙箱**：它们是纯粹的规则层缺陷，与 L0–L3 任何一档的落地无关 —— 可以现在就修。

### 8.6 修复建议（都不大）

| 针对 | 做法 | 反向验证 |
|---|---|---|
| **D1**（P0-8）✅ **已修** | ①`rememberRule` 改 **PathRules 增量写回**：把本次 `patterns` 并进 `allow`（或 `deny`），**保留**已有 `deny`/`ask`，不再整键覆盖；`patterns` 为空 ⇒ `**` 通配（等价旧 string，但不抹掉既有规则）。②`check()` 收紧：**全局 deny 对所有工具规则形态都有否决权** —— 实现时确认，string 形态**没有自己的 deny 列表**，所以"string allow 也过 `denyTargets`"唯一可行形态是**从全局借 deny 列表**（默认 `'*': 'ask'` 不触发 ⇒ 零行为变化，只收紧不放宽） | `permission-deny-patterns.test.ts` 补"always-allow 后段级 deny 仍生效" + "写回不丢已有 deny/ask" |
| **D2**（P0-9） | 规则分层加归属维度：`session:<id>` → `caller:<key>` → 工具 → 全局，`check()` 逐层回退；写回带归属键。`PermissionRequest.sessionId` 已在传，**只差接进匹配与写回** | 补"远程 caller 不继承本地 always-allow"与"本地不继承控制面写入"两条 |
| **D5**（P1-9） | 加 `kind: 'permission.rule.changed'`（零内容 + `stateHash` + 来源 `cli / control-api / asker`），沿用 `harness.audit.v1` schema | 两条写盘路径各断言产生一条审计 |
| **D4 / D6**（P2-5/P2-6） | 纯判据与文案：`assessRisk` 让 `bash` 走**模式表**（`ls` 不该是 high）；文案键位改成自洽（或直接去掉方括号里的简写）。`cli.test.ts` 钉着文案，**改要同步** | 文案用例同步更新 + `assessRisk` 补 `bash` 分级用例 |
