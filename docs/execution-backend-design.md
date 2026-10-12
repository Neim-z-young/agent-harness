# 执行后端抽象（L3）设计稿

> 状态：**设计稿**（2026-10-12）。本轮只出文档，不落代码。
> 上游：`docs/sandbox-isolation-plan.md` §2（四层档位）、§7.5（业界对标）、§7.6（参考实现）。
> 目标读者：接下来动手实现 L3 的人（含三个月后的自己）。

---

## 0. 一句话

**L0/L1/L2 都在"同一个内核 + 同一个进程树"里做约束；L3 是唯一跳出这个前提的一档 —— 它把执行
挪到另一个内核（容器 / microVM）或另一台机器（远程 executor）上。** 本稿定的是"怎么接"，
不是"接哪个"。

---

## 1. 为什么必须有这一档（判据）

前四档（含已落地的 L2）都建立在两个前提上：

1. **共享内核**：`sandbox-exec` / `bwrap` / Landlock 限制的是**本机内核**里的主体能做哪些系统调用。
   内核漏洞、`io_uring` 一类新面、以及**用户态逃逸**（解析器/库的漏洞）都不在这一层的射程内。
2. **共享资源池**：CPU / 内存 / 磁盘 / 网络的争用靠 `ulimit` 与策略限流（L1/L2），
   "把宿主拖垮"只能**缓解**不能**隔离**。

L3 的价值就是把这两条前提换掉：

| 维度 | L0~L2（现状） | L3（目标） |
|---|---|---|
| 内核 | 共享（本机） | 独立（guest kernel）或独立机器 |
| 逃逸面 | 内核 + 用户态 | 只剩 hypervisor / 网络边界 |
| 资源 | `ulimit` 限流 | cgroup / VM 配额，硬边界 |
| 生命周期 | 进程 | 沙箱实例（可快照 / 可复用 / 可销毁） |
| 成本 | 零（同进程/同机） | 冷启动开销（容器 ~100ms，microVM ~125ms 级） |

**判据一句话**：当被执行的代码**不是"我们自己的可信代码"**（用户上传的插件、来料不可控的
仓库、多租户共用一台机）时，L2 的"同一内核内约束"就不再是充分的答案。

⚠️ **反过来也成立**：L3 只解决"执行边界"，**不解决"要不要执行"** —— 权限层（谁批准）与
执行边界正交这件事，本方案 §8 已经确立，L3 不改变它。

---

## 2. 现状盘点：L3 要挂到哪些接缝上

**这一节是全文最重要的部分** —— 后端抽象的价值取决于它能不能嵌进现有接缝，而不是它自身多优雅。
逐个列出已经就位的挂点（都是 2026-10-11/12 那两轮沙箱工作留下的）：

| # | 接缝 | 现状 | L3 要做的事 |
|---|---|---|---|
| 1 | `probeIsolation({ platform, exists, osBinding })` | 返回 `{ primitives, maxLevel, reasons }`；`maxLevel` 目前最高 `L2` | 加 `backends` 探测（容器运行时 / microVM / 远程端点可达性）；**探到 ≠ 达到**（同一纪律：要真构造出后端才算） |
| 2 | `resolveIsolation({ required, probe })` | 折"要求 vs 本机能力"，`onUnmet: warn\|refuse` | **不改** —— L3 只是让 `probe.maxLevel` 能到 `'L3'`，语义逐字不变 |
| 3 | `BashOutput.isolation = { level, fsBound, netPolicy, viaHost, fsBoundFailed? }` | 由"这次真绑上了没有"决定 | 加 `backend?: string`（这次跑在哪个后端上）；`fsBound` 的语义扩展为"后端是否真的隔离了文件系统" |
| 4 | `sandbox.osBinding: off\|on` + `buildOsBinding()` | 已落地（L2） | 新增 `sandbox.backend: 'host' \| 'container' \| 'microvm' \| 'remote'`；与 `osBinding` **互斥/降级关系**要定死（见 §5.3） |
| 5 | `mcpServers[].capabilities = { fs, net }` + `mcpSpawnArgv()` | 已落地（P1-7）：`fs:"cwd"` 在 L2 下**真强制** | 后端为 container/microVM 时，`fs:"cwd"` 的强制方式换成**挂载映射**（比 Seatbelt profile 更硬）；`net:"none"` **这时才真能强制**（见 §6.2） |
| 6 | `loadPluginDirs` 的 `runner: 'in-process' \| 'worker'` | 已落地（P1-5）：worker 只给**资源/故障边界**，明确不是安全边界 | 加 `runner: 'backend'`：插件在**后端内**装载，宿主经 RPC 交互（这是 P1-5 真正的答案，worker 只是它的廉价近似） |
| 7 | `tools-web` 的 SSRF 防护 / `assessNetAccess`（L0 静态门） | 静态门，明确"不是内核边界" | 后端内网络策略由**平台**执行（namespace / 代理 / 无网卡） |
| 8 | 审计 `sandbox.escalation` / `permission.rule.changed` | 已落地 | 加 `sandbox.backend.invoked`（去哪儿跑了、耗时、退出码、是否复用实例） |

**结论**：接缝**已经足够**。L3 的工作量主要不在"设计接口"，而在"把 8 个挂点逐个接对 + 三平台差异"。

---

## 3. 接口设计（draft）

### 3.1 核心类型

```ts
/** 一个执行后端的静态能力（**声明**，不等于运行时一定满足 —— 有探测自检，见 §3.3） */
export interface BackendCapabilities {
  /** 是否独立内核（容器有、microVM 有、宿主进程没有） */
  separateKernel: boolean
  /** 文件系统隔离强度：'policy'（L0 判定）/ 'os'（L2 绑定）/ 'mount'（后端挂载视图） */
  fs: 'policy' | 'os' | 'mount'
  /** 网络隔离强度：'static'（L0 静态门）/ 'proxy'（宿主代理）/ 'none'（无网卡/namespace） */
  net: 'static' | 'proxy' | 'none'
  /** 资源上限是否硬边界（cgroup / VM 配额） */
  hardLimits: boolean
  /** 能否复用实例（温启动） */
  reusable: boolean
  /** 大概的冷启动开销（ms），供上层决定"要不要为一条命令起后端" */
  coldStartMs: number
}

/** 一次执行请求（与 `runBash` 的入参同形 —— 刻意不发明第二套语义） */
export interface BackendExecSpec {
  command: string
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs: number
  limits?: { cpuSeconds?: number; memoryKb?: number; maxFileSizeKb?: number; maxProcesses?: number }
  net?: { mode: 'open' | 'allowlist' | 'deny'; allow: string[] }
  signal?: AbortSignal
}

/** 一次执行结果（对齐 `BashOutput`，多一个 backend 标记） */
export interface BackendExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  durationMs: number
  backend: string
  /** 后端自述：这次真的隔离到了什么程度（与 BashOutput.isolation 同口径） */
  isolation: { level: 'L3'; fs: 'mount'; net: string }
}

export interface ExecutionBackend {
  readonly id: string
  describe(): BackendCapabilities
  /** 一次性准备（建实例 / 起容器 / 建隧道）；可复用则缓存实例 */
  prepare(ctx: { sessionCwd: string; config: SandboxSection }): Promise<void>
  exec(spec: BackendExecSpec): Promise<BackendExecResult>
  /** 释放（容器 stop / 远程 session 关闭）；宿主退出与 onUnmet 路径都要保证被调到 */
  dispose(): Promise<void>
}
```

**三个刻意的决定**：

1. **`exec` 而不是 `spawn`**：后端可能在另一台机器上，"给一个子进程句柄"这个模型不成立。
   交互式会话（把 stdin 接进去）作为**独立能力**另议（`describe().reusable` + 后续 `attach()`），
   本稿不覆盖。
2. **`BackendExecSpec` 与 `runBash` 入参同形**：避免出现"工具层一套参数、后端层另一套参数"，
   那必然导致某个字段在一个方向上被静默丢掉（本仓在 `readDeny` 上踩过）。
3. **`isolation` 由后端自述**：与 `BashOutput.isolation` 同一条纪律 —— **写实际，不写愿望**。
   L2 那条教训（`fsBound` 从"档位推导"改成"真绑上了没有"）在这里要**预先**遵守。

### 3.2 与档位的映射

```
host backend   → 最高 L2（= 现有全部能力；纯 host 后端不是"退步"，是 baseline）
container      → L3（separateKernel=false 但 fs:'mount' + hardLimits + net:'none'；见 §5.2）
microvm        → L3（separateKernel=true）
remote         → L3（separateKernel 取决于对端；**必须显式声明**，不许猜）
```

⚠️ **容器算不算 L3**？本稿的答案是 **算，但要在档位文案里写清**："L3（容器）"与"L3（microVM）"
不是同一个保证 —— 容器共享宿主内核，逃逸面比微虚拟机大。**档位不能只剩一个字母**，
`BashOutput.isolation.backend` 就是为此存在的。

### 3.3 探测与自检（复用 L2 的两条纪律）

| 纪律 | L2 的落地 | L3 的对应 |
|---|---|---|
| **探到 ≠ 达到** | 有 `sandbox-exec` ≠ 达到 L2（要真构造出绑定命令） | 有 `docker` ≠ 达到 L3（要真**跑起来**一个容器并执行探测命令） |
| **不模拟** | 拿不到原语 ⇒ `buildOsBinding` 返回 `null` + notice | 拿不到运行时 ⇒ 后端**不注册** + notice；`maxLevel` 不升 |

具体自检（与 `verifyOsBinding` 同形：跑一次「原语 + shell + echo 哨兵」）：

```
container 自检：docker run --rm --network=none <Img> sh -c 'echo <SENTINEL>'
               + 反向判据：容器内写宿主目录应失败（挂载视图正确）
microvm  自检：同形（firecracker 的启动更重，建议"首次使用时懒执行"而不是 boot 期全跑）
remote   自检：一次 health RPC + 一次最小 exec
```

**boot 期只做"便宜探测"**（二进制在不在、端点通不通），**重自检懒执行**（首次真用到时做一次并缓存
结果）—— 否则冷启动会被拖长到不可接受（microVM/远程尤其）。

---

## 4. 三种后端的取舍

| 形态 | 隔离强度 | 冷启动 | 依赖 | 适用 |
|---|---|---|---|---|
| **host（baseline）** | L0~L2 | 0 | 无 | 默认；可信代码 |
| **container（docker/podman）** | 挂载视图 + cgroup + 网络 namespace | ~100ms（温实例更低） | 本机装运行时 | 用户插件 / 不受信仓库 |
| **microVM（Firecracker 系）** | 独立内核 | ~125ms + 镜像管理 | 复杂（需 KVM、镜像、网络） | 多租户 / 高对抗场景 |
| **remote（A2A 式端点）** | 取决于对端 | 网络往返 | 对端存在且协议对齐 | 本机不允许跑、或需要特定环境 |

**本仓的推荐路径**：`host` → `container` → （按需）`remote` → `microvm`。
理由：container 的**依赖最轻**（一个二进制）、三平台都成熟（Linux 原生 / macOS 走 VM 但用户已装
Docker Desktop 时可用 / Windows 走 WSL2 后端），而且它已经能兑现 L3 的**主要承诺**
（挂载视图 + 硬资源上限 + 真断网）。

**microVM 不进第一批**：它要的镜像/网络/快照管理是独立工程，且在没有多租户需求前收益不明显。
写在这里是为了让"L3"这个词不在实现时被当成"容器"的同义词。

---

## 5. 与现有配置的关系（这里最容易出错）

### 5.1 新增配置

```jsonc
{
  "sandbox": {
    "backend": "host",              // host（默认）| container | microvm | remote
    "backendOptions": {
      "image": "oven/bun:1.3",      // container/microvm 镜像
      "runtime": "docker",          // docker | podman | nerdctl（探测到才用）
      "reuse": true,                // 复用实例（温启动）
      "network": "none",            // none | proxy | allowlist
      "mountCwd": true,             // 把会话 cwd 映射进去（false ⇒ 沙箱内看不到工作区）
      "endpoint": ""                // backend=remote 时的对端
    },
    "level": "L3",
    "onUnmet": "refuse"
  }
}
```

### 5.2 与 `osBinding`（L2）的关系 —— **必须定死**

两者都能"限制可写区"，同时开会**互相打架**（容器内的 Seatbelt profile 指向的是容器内路径）。

规则（建议）：

1. `backend !== 'host'` 时 **`osBinding` 被忽略**（容器挂载视图比 Seatbelt profile 更硬），
   并在装配期发一条 notice 说明"已按后端挂载视图执行，`osBinding` 未生效"。
2. `backend === 'host'` 时 `osBinding` 照旧生效（L2 路径逐字不变）。
3. **绝不静默**：这条"忽略"必须可见 —— 否则就是本方案反复在治的"写了没生效"。

### 5.3 与 `fallbackToHost` 的关系

`fallbackToHost` 目前的意思是"沙箱内失败 ⇒ 升到宿主全权重跑"，落 `sandbox.escalation` 审计。
在 L3 语境下，"向上回退"的语义变成 **后端 → 更弱后端（最终到宿主）**：

- 必须新增审计字段 `from` / `to`（现在是隐式的"沙箱 → 宿主"）；
- **默认禁止跨档回退**（`backend=container` 失败 ⇒ 不应静默退回宿主执行），要退回必须显式配
  `onBackendFailure: 'refuse' | 'fallback-host'`，默认 `'refuse'`。
  理由：用户选 container 的**全部动机**就是"不要在宿主上跑"，静默回退等于把动机抹掉。

---

## 6. 挂点清单（实现顺序即此表顺序）

### 6.1 `bash` / `bash_ro`（第一优先）

`runBash` 现在是"拼 argv（含 OS 绑定的 prefix）→ spawn"。L3 改造后变成：

```
runBash(spec)
  → backend.exec(spec)          // backend=host 时退化为现有 spawn 路径（零行为变化）
  → 结果映射回 BashOutput（含 isolation.backend）
```

**判据**：`backend: 'host'` 时**逐字等于改造前**（与 `net: 'open'` 同样的"逐位一致"纪律）。

### 6.2 `mcp-client`（`net:"none"` 的真正落地）

P1-7 留的缺口：`net:"none"` 在 L0/L1/L2 下**任何档位都强制不了**（静态门管不到别人的子进程）。
后端为 container 时，这个声明**第一次能被真正执行**：MCP 子进程也放进后端 → 后端无网卡 ⇒
`net:"none"` 从"声明"变成"事实"。

### 6.3 `plugin-runner`（P1-5 的正解）

`runner: 'worker'` 给的是资源/故障边界（实测：env/pid/fs 与宿主一致 ⇒ **不是安全边界**）。
`runner: 'backend'` 才是 P1-5 真正的答案：插件在后端内装载，宿主经 RPC 交互。
代价是**完整 RPC 桥**（插件 API 要全部异步化 + hooks 要改推送模型）—— 这是独立工程，
不要与"把 bash 挪进容器"混在一批做。

### 6.4 `tools-web` / 出网

后端 `network: 'none'` 时，`tools-web` 的请求**根本到不了网**（这是比 SSRF 静态门更强的保证）；
`network: 'proxy'` 时由代理执行域名 allowlist（把 L0 静态门升级成执行点可控的门）。

---

## 7. 可观测与降级（沿用既有三条）

1. **档位可声明**：`sandbox.level: "L3"` + `onUnmet: "refuse"` ⇒ 拿不到后端就**拒绝启动**
   （机制已有，`resolveIsolation` 不用改）。
2. **降级必留痕**：`sandbox.backend-unavailable`（notice）+ `sandbox.escalation`（审计）。
3. **实际档位可见**：`env-context` 注入的「隔离」行、`BashOutput.isolation.backend`
   —— 模型必须知道"我现在跑在哪儿"，否则它会反复撞同一面墙（P2-1 的结论）。

---

## 8. 验收口径（可自动判）

| # | 判据 | 怎么判 |
|---|---|---|
| 1 | `backend: 'host'` 逐字等于改造前 | 现有全量测试 + `BashOutput.isolation` 快照 |
| 2 | 探到运行时但**没自检通过** ⇒ `maxLevel` 不升档 | 纯函数单测（注入 `exists`/`runtime` 探针） |
| 3 | 容器内写宿主目录**失败**（挂载视图正确） | 真机 e2e（CI 有 docker 则跑，否则 skip 并计数） |
| 4 | 容器内 `curl` 出网**失败**（`network:'none'`） | 同上 |
| 5 | 容器内 `memory` 打满**不影响宿主**（硬上限） | 同上（小配额 + 少量分配） |
| 6 | `backend !== 'host' && osBinding === 'on'` ⇒ **有 notice**（不静默忽略） | notice 快照 |
| 7 | 后端失败**不静默回退**宿主（默认 `refuse`） | 单测：注入失败后端 ⇒ 断言没有第二次 exec |
| 8 | `sandbox.backend-unavailable` 在拿不到运行时时必发 | 与 P1-3 的 `binding-unavailable` 同一套用例形态 |

⚠️ 3~5 依赖本机运行时 ⇒ CI 上**允许 skip，但必须计数**（`scripts/ci/test-summary.sh`
已有 `skip ≤ 200` 的闸，这条缝就是给它准备的）。

---

## 9. 分期建议

| 阶段 | 内容 | 可独立交付？ |
|---|---|---|
| **L3-a** | 探测 + 声明 + 可观测（`probeIsolation` 加 backend 探测、`sandbox.backend` 配置、notice、`isolation.backend`） | ✅ 纯函数 + notice，零运行时依赖；**先把"能声明"做出来**，与 P1-4 对 L2 的关系一样 |
| **L3-b** | `container` 后端真执行（bash 走容器 + 自检 + 挂载视图 + `osBinding` 互斥规则） | ✅ 依赖本机 docker |
| **L3-c** | `mcp-client` / `plugin-runner` 接后端（`net:"none"` 真断网、P1-5 的正解） | ✅ 依赖 L3-b |
| **L3-d** | `remote` 后端（协议对齐、健康检查、成本核算） | ⚠️ 需要先定"远程 executor"与 A2A 的边界（见 §10） |
| **L3-e** | `microvm`（Firecracker 系） | ⚠️ 独立工程，等多租户需求 |

**建议先做 L3-a**：它没有运行时依赖、判据全是纯函数与 notice，能把"L3 可声明、可降级、可见"
这三件事一次性钉死；后面接哪个后端都只是往 `probeIsolation` 里加一项探测。

---

## 10. 明确不做 / 待定

**不做**：

- **不把 L3 当成"更安全的 L2"**：两者解决的是不同问题（同内核内约束 vs 换掉内核前提）。
  文档里不许把 container 与 microVM 合成一个"L3"了事（`isolation.backend` 就是防这个的）。
- **不做"同进程内跑不可信 JS"**：`vm2` 已停维护，且其作者明确"在 Bun（JSC）上不构成安全边界"
  （见沙箱方案 §7.6）。这条路在本仓**不成立**，不要重开。
- **不在 exec 之外发明第二套权限语义**：L3 不改变"谁批准"，只改变"批准之后在哪儿跑"。

**待定**：

1. **远程 executor 与 A2A 的边界**：A2A 的语义是"把任务交给另一个 agent"，而远程 executor 的语义是
   "把命令交给另一台机器"。两者都用 HTTP + 认证，但**控制面不同**（前者有任务生命周期，后者只有
   exec）。建议：远程后端走**独立端口/前缀**（如 `/harness/exec`），不复用 A2A 的 `SendMessage`
   —— 复用会让"这是 agent 还是执行器"在调用方分不清。
2. **交互式会话**（把 stdin 接进后端）：`ExecSpec` 只有"跑完给结果"，不适合 REPL / 长驻服务。
   要不要做、以什么形态做（PTY over stream），留给下一个设计稿。
3. **镜像供应链**：默认镜像从哪来、怎么固定 digest（`image` 写 tag 是不可复现的）——
   建议第一版就要求 `image@sha256:...`，但要评估使用门槛。
