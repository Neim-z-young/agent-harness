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

## 0. 现状一句话

今天的"沙箱"是**策略级（in-process policy）**，**不是 OS 级**：所有闸门都在同一个 Node 进程里、
以当前用户的全权限执行。策略能拦"模型写了什么"，拦不住"那段代码真的能干什么"。

| 能力 | 现状 | 位置 |
|---|---|---|
| 命令级策略（危险表 / AST 复核 / 白名单） | ✅ 有，且真机打磨过多轮 | `tools-builtin/src/index.ts`、`bash-ast.ts` |
| 工作目录边界 | ⚠️ **纯字符串前缀**判定，无 symlink 解析；**6 份副本** | `tools-builtin` / `tools-glob` / `tools-search` / `tools-media` / `code-intel` |
| 环境变量隔离 | ⚠️ **只覆盖 `bash`**；MCP 子进程全量继承 | `tools-builtin` / `mcp-client/src/index.ts:147` |
| 权限引擎（三模式 + 规则写回 + 风险分级 + 审计） | ✅ 有，三宿主共用一份 | `host/src/permission.ts`、`host/src/audit.ts` |
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

### 3.2 P2 —— **体验一致性**

| # | 缺口 | 说明 |
|---|---|---|
| P2-1 | 档位**不可见** | `env-context` 已经在注入 `Shell:`，应并排注入 `Isolation:`（L0/L1/L2 + fs/net 策略）。模型不知道自己的边界，就会反复撞同一面墙 |
| P2-2 | 拒绝文案要**可执行** | 延续既有纪律（`bash_ro` 的结构门带 `why`）：每条隔离拒绝都给「为什么 + 怎么改」。历史教训：文案指向给不出所需信息的工具 ⇒ 模型空转 |
| P2-3 | `BashOutput` 加 `isolation` | `{ level, fsBound, netPolicy, viaHost }`，让模型（与取证脚本）知道这次执行的边界 |
| P2-4 | 文档口径 | README / `AGENTS.md` 要写清「**当前隔离是策略级，不是 OS 级**」，并说明什么场景必须上 L2/L3 |

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
5. **P1-4 档位结构 + P1-3 OS 绑定**：先定义 `probeIsolation()` 与档位语义，再接第一个
   OS 原语（macOS `sandbox-exec` 最易验证）—— **拿不到原语就按 §2 纪律 2 显式降级告警**。
6. **P1-2 网络策略**、**P1-6 死协议收口**（要么接生产者、要么删掉类型）、**P2 批次**、**P3-4 渗透集**。
7. **P1-5 / P1-7 / L3**：与 `external-integration-plan.md` §9 的"执行后端抽象"合流后统一做。

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
- **多 Agent 隔离**（subagent worktree / swarm）见 `agent-harness-architecture.md` §九；
  P1-6 是那里留下的一个空壳。
