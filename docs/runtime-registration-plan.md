# 运行期注册：Provider / Agent 供给计划

> 状态：**S1 + S2 + S3 已实施并提交**（2026-09-29，`36d170d` / `fd30fe7` / `10e9afd`）。
> 目标：把「Agent 定义 / Provider 实例」的供给从**装配期钉死**变成**运行期可增删**，
> 并顺带修掉由此暴露的两个既有缺陷（注册键口径不一致、默认裁决隐式化）。
> 本文只做现状盘点、方案设计与排期；每节的「验收」即实施时的回归闸门。
> 承接 `docs/agent-harness-architecture.md` 的插件体系，与 `docs/memory-and-skill-forge-plan.md` 同格式。
> 实施后的实际形态与偏差见 §8「实施记录（S1+S2）」与 §9「实施记录（S3）」。

---

## 0. 结论先行

调研下来，这件事**不是「从零加一个运行期注册表」**，两侧的成熟度差得很远：

1. **Agent 侧其实已经具备运行期注册能力**，只是没有契约与守卫。
   `AgentRuntime.register(def)` 早已是公开接口（`packages/core/src/index.ts:1629`），
   CLI 的 `applyConfigAgentOverrides` 就在运行期用它；而工具池是**每轮 query 重算**的
   （`_prepareQueryOnce` 每次 `new DefaultToolPool` + `trigger('core.tool.pool.assemble', {agentId})`，
   `packages/core/src/index.ts:2281-2283`）⇒ 运行期新注册一个 Agent，**下一轮 query 立刻有工具**。
   缺的是：来源追踪、同 id 覆盖告警、反注册、事实事件。

2. **Provider 侧是真的缺**，而且缺得很不体面。
   实例层只有 `HarnessImpl._setChatProvider(p)` —— `@internal`、**不在 `Harness` 接口里**、
   被 **16 个 provider 插件跨包 cast 调用**（`harness as { _setChatProvider?: ... }`）。
   它一次做三件事：设默认 `this.chatProvider`、覆盖 `context['chat.provider']`、写注册表
   （`packages/core/src/index.ts:4133-4137`）。**想「只追加一个实例、不动默认」是做不到的。**

3. **顺带查出一个真 bug（P2，本方案 S1 必须一起修）**：
   注册表的 key 取的是**被注册对象自报的 `p.id`**（`this.chatProviders.set(p.id, p)`），
   而 `ProviderConfig.id`（CLI 派生、保证唯一）从未参与。
   - openai 系（含 glm / qwen，基于 `OpenAIChatProvider`）**透传** `config.id` ⇒ 多实例正常
     （`packages/plugins/provider-openai/src/index.ts` 工厂末尾 `providerId: config.id`；
     glm/qwen 用 `config?.providerId ?? 'glm'` 派生 `pluginId = 'provider.'+providerId`）。
   - **anthropic / gemini / mock 是硬编码单例**：`readonly id = 'anthropic'` / `'gemini'` / `'mock'`。
   ⇒ 同一 type 的多个实例**互相覆盖同一个 key**，而 `agent.model.providerId = 'hy3'`
   （`ProviderConfig.id` 派生值）在 core 侧**根本不存在** ⇒ `resolveChatProvider` 静默回退默认。
   `ProviderConfig` 的注释明明写着「仅在需要『同一模型挂多个端点』时才显式写 id」——
   这个被明确支持的场景，对 anthropic 系是坏的。CLI 只能在 `packages/cli/src/index.ts:3919`
   把「请求的 id」与「实际命中的 `provider.id`」比一下来**提示**，修不了。

**建议排期**：S1（Provider 口径 + 契约，含 P2 修复）→ S2（Agent 侧守卫）→ S3（可观测）。
S1 独立成立且能立刻修掉 P2，即使后面两阶段暂缓也值得做。

---

## 1. 现状取证

### 1.1 Provider 供给链

| 环节 | 位置 | 事实 |
|---|---|---|
| 类型注册表 | `packages/plugin/src/index.ts:1565` `ProviderTypeRegistry` | **已有**：`register / resolve / list / meta / clear`，`type → factory` |
| 工厂契约 | 同文件 `:1542` `ProviderTypeFactory` | `{ type, createPlugin(config, ...) }` |
| 类型解析 | `packages/cli/src/index.ts:2400` `buildProviderPlugin` | `providerTypes.resolve(pc.type)?.createPlugin(pc)` |
| 实例构造循环 | `packages/cli/src/index.ts:2538-2554` | 先建「非默认」再建「默认」，**默认放最后** |
| 默认裁决 | 同文件注释 | 原文：「默认放到最后 → 作为无前缀模型的兜底」= **顺序即语义** |
| 实例落地 | `packages/core/src/index.ts:4133` `_setChatProvider` | 由插件在 `core.harness.init` 里 cast 调用 |
| 实例路由 | `packages/core/src/index.ts:4119` `resolveChatProvider` | 命中 map → 否则回退 `context['chat.provider']` |
| 公开契约 | `packages/core/src/index.ts:3379` `interface Harness` | **无** provider 相关成员；CLI 靠 duck typing（`packages/cli/src/index.ts:2289`） |

### 1.2 Agent 供给链

| 环节 | 位置 | 事实 |
|---|---|---|
| 构造期来源 | `packages/cli/src/index.ts:2769` | `agents: [defaultAgent(), ...options.agents]` |
| 目录来源 | 同文件 `:2771` `agentDirs` | `user.agents` → `project.agents`（后者覆盖），md frontmatter |
| 配置覆盖 | 同文件 `:2172` `applyConfigAgentOverrides` | **运行期**：`harness.agent.register(merged)` |
| 公开契约 | `packages/core/src/index.ts:1629` `AgentRuntime` | `register / get / list / query / queryStream` —— **register 已公开** |
| 实现 | 同文件 `:2241` | `this.agents.set(def.id, def)` —— 裸写，无来源、无告警、无反注册 |

### 1.3 工具池：per-agent 收窄已是每轮实时

`DefaultToolPool`（`packages/core/src/index.ts:812`）的 `add` **直接写全局 `ToolRegistry`**
（「池」其实是注册表，不是 per-agent 视图）；per-agent 收窄发生在 query 期：

```
_prepareQueryOnce (:2276)
  ├─ new DefaultToolPool(toolRegistry)
  ├─ trigger('core.tool.pool.assemble', { agentId })      ← 插件按 agentId 决定注入什么
  ├─ filterByWhitelist(agent.tools)                       ← 按 agent 定义收窄
  └─ supplyMcpTools(...)                                  ← 再在注册表全量上补 MCP
```

`assembleTools()`（`:4088`）是**幂等预热**入口，已在 MCP server 增删时被 subscribe 调用
（`packages/cli/src/index.ts:3225-3228`）——**这就是本项目现成的「运行期变更后刷新」范式**，
本方案直接复用，不需要发明新机制。

### 1.4 契约缺口清单

| # | 缺口 | 位置 | 影响 |
|---|---|---|---|
| P1 | **注册即改默认** | `:4133` | 无法「只追加实例」；默认由注册顺序决定 |
| P2 | **注册键口径不一致** | `:4136` | 同类多实例互相覆盖；派生 id 路由 miss 后静默回退 |
| P3 | 无反注册 / 无来源 / 无事件 | `:4133`、`:2241` | 插件装完就摘不掉；同名覆盖无声 |
| P4 | 运行期注册绕过拓扑排序 | `packages/plugin/src/index.ts:1067` | 见 §3.6，是**设计约束**不是缺陷，但要写明 |

---

## 2. 设计

### 2.1 总原则：注册键由调用方给，不由对象自报

这是 P2 的根因，也是本方案的第一原则：

> **被注册对象只知道自己「是什么类型」，不知道「这次装配的实例叫什么」。**

`AnthropicChatProvider` 里 `readonly id = 'anthropic'` 作为**类型标识**是对的；
但把它当作**装配实例的唯一键**就错了 —— 同一份 config 数组里可以有两个 anthropic 端点。

因此：

```ts
// ✅ 键由调用方给（调用方持有 ProviderConfig.id，是唯一权威）
harness.providers.register(config.id, provider)

// ❌ 对象自报（同类多实例必冲突）
harness.providers.register(provider)   // 内部用 provider.id
```

### 2.2 Provider 实例契约

新增 `ProviderRuntime`，进 `Harness` 接口（`packages/core/src/index.ts:3379`）：

```ts
/** Provider 实例注册表（运行期可增删；与 ProviderTypeRegistry 的类型层正交） */
export interface ProviderRuntime {
  /**
   * 注册（或替换）一个 Provider 实例。
   * @param id 实例 id —— 必须是 `ProviderConfig.id`（宿主派生/显式给出的唯一键）
   * @param provider ChatProvider 实例
   * @param meta 来源备注（用于归因/告警文案）
   */
  register(id: string, provider: ChatProvider, meta?: ProviderInstanceMeta): void
  /** 反注册；若它是当前默认，默认回落到「首个已注册」并发布事件 */
  unregister(id: string): boolean
  /** 显式指定默认 provider（未注册则抛错，不静默） */
  setDefault(id: string): void

  /**
   * 解析：显式 id 命中 → 显式默认 → 首个已注册 → 构造期 provider。
   * 未命中时**发布 `provider.resolveMiss` 事件**（P2 的静默回退就此可见）。
   */
  resolve(id?: string): ChatProvider
  get(id: string): ChatProvider | undefined
  list(): ProviderInstanceInfo[]
}

export interface ProviderInstanceMeta {
  /** 来源：`config`（config.json）/ `builtin`（内置默认）/ `plugin:<id>` / `runtime` */
  source: string
  /** 该实例对应的 ProviderConfig.type，仅作展示 */
  type?: string
}
```

`Harness` 新增一行：`readonly providers: ProviderRuntime`。

**兼容层**：`_setChatProvider` 保留，改为委托 + 标 deprecated：

```ts
/**
 * @deprecated 用 `providers.register(id, p)` + `providers.setDefault(id)`。
 * 保留仅因 16 个 provider 插件在跨包 cast 调用它；语义等价于「注册 + 设为默认」。
 */
_setChatProvider(p: ChatProvider): void {
  this.providers.register(p.id, p, { source: 'legacy' })
  this.providers.setDefault(p.id)
}
```

> ⚠️ 注意委托后**默认语义变化**：旧实现是「最后一次调用赢」，新实现是「显式 setDefault」。
> 对「CLI 把默认放最后」这条路径，行为等价（最后一次就是默认那次）；但对「A 注册 → B 注册 →
> 再显式设 A 为默认」这类场景，**旧实现无法表达**，这正是要修的地方。

### 2.3 Provider 插件迁移（S1 第二步）

三个硬编码单例按 **glm/qwen 的既有范式**改造，不发明新写法：

```ts
// packages/plugins/provider-anthropic/src/index.ts
export function createProviderAnthropicPlugin(config?: AnthropicProviderConfig): ... {
  const providerId = config?.providerId ?? 'anthropic'   // ← 照抄 provider-glm 的写法
  const pluginId = `provider.${providerId}`
  // ...
  return {
    id: pluginId,
    async install(ctx) {
      return {
        async 'core.harness.init'(_input, output) {
          const harness = output.harness as { providers?: ProviderRuntime } | undefined
          // 新路径优先；老宿主回退 _setChatProvider（渐进迁移，不必一次翻完）
          if (harness?.providers) harness.providers.register(providerId, provider)
          else (harness as any)?._setChatProvider?.(provider)
        },
      }
    },
  }
}
```

`providerTypeFactory.createPlugin` 里补 `providerId: config.id`（与 openai/flags 一致）。
gemini / mock 同法。

> 顺带收益：`pluginId` 随 `providerId` 派生后，**同一进程内多个 anthropic 端点不再撞插件 id**
> （现在它们都是 `provider.anthropic`，靠 `pushBuilt` 的 `builtIds` 去重**静默丢掉**多余实例 ——
> 这是 P2 在插件层的第二个表现，此前没被发现）。

### 2.4 Agent 契约

`AgentRuntime` 增加两个方法与一个元信息：

```ts
export interface AgentRegisterMeta {
  /** 来源：`config` / `dir:<path>` / `plugin:<id>` / `runtime` */
  source: string
  /** 同 id 覆盖是否允许（缺省 true，但**一律发布事件 + WARN**） */
  overwrite?: boolean
}

export interface AgentRuntime {
  register(def: AgentDefinition, meta?: AgentRegisterMeta): void
  unregister(id: string): boolean          // 新增
  get(agentId: string): AgentDefinition | undefined
  list(): AgentDefinition[]
  // query / queryStream 不变
}
```

`register` 实现改为：

```ts
register(def, meta) {
  const prev = this.agents.get(def.id)
  if (prev && meta?.overwrite === false) {
    throw new Error(`Agent "${def.id}" 已注册（source=${prev.source}），overwrite=false 拒绝覆盖`)
  }
  this.agents.set(def.id, { ...def, __source: meta?.source ?? 'runtime' })
  if (prev) this.deps.bus.publish(AgentEvents.reregistered, { id: def.id, from: prev.__source, to: meta?.source })
  else this.deps.bus.publish(AgentEvents.registered, { id: def.id, source: meta?.source })
}
```

> `__source` 不入 `AgentDefinition` 的公开字段（避免污染契约与 md 序列化），
> 用 `WeakMap<AgentDefinition, string>` 持有。**Q4 已拍板：WeakMap**（见 §6）。
> 实际签名还多了 `overlay?: boolean`（文档化覆盖链豁免 WARN），见 §8.1。

**工具池不需要做任何事** —— §1.3 已证明下一轮 query 自动生效。但这条要有**回归测试**锁住
（否则以后有人把 assemble 挪回装配期，运行期注册会静默失效）。

### 2.5 命名与分层

按 `Hooks` 的 `层.域.动作` 规范（`packages/plugin/src/index.ts:543-556`）与
「hook（可改写管道）vs bus（只读广播）」双命名空间：

| 能力 | 形态 | 名字 |
|---|---|---|
| 注册 / 反注册 Provider 实例 | 能力方法 | `harness.providers.register / unregister` |
| 设默认 Provider | 能力方法 | `harness.providers.setDefault` |
| 注册 / 反注册 Agent | 能力方法 | `harness.agent.register / unregister` |
| 注册事实广播 | bus 事件 | `provider.registered` / `provider.unregistered` / `provider.defaultChanged` / `provider.resolveMiss` |
| Agent 事实广播 | bus 事件 | `agent.registered` / `agent.unregistered` / `agent.reregistered` |

**刻意不加管道 hook**（不加 `core.provider.register`）：注册是**配置事实**，不是「可改写管道」。
给它加 `(input, output)` 式 hook，等于允许两个插件静默抢注册同一个 id —— 正是
`Hooks` 注释里警告的「同一个 hook 名出现两个来源」。要观测用 bus，要干预请改配置。

### 2.6 与 dependsOn 拓扑排序的边界（P4）

拓扑排序只在三级加载路径里跑（`loadInternal / loadBuiltin / loadUser`，
`packages/plugin/src/index.ts:1067-1140`）。运行期注册**不在**其中。约定：

- **运行期注册的对象不是插件**，不参与 `dependsOn`，也不触发重新排序。
- 调用方若是插件，其**自身**装载顺序已由拓扑排序保证 ⇒ 无需二次排序。
- **禁止**用运行期注册去「补装本该在 `plugins: []` 里声明的插件」——
  那会把拓扑排序变成可绕过的东西。写进 `AGENTS.md`。

---

## 3. 分阶段实施

### S1 — Provider 口径 + 契约（含 P2 修复）· 独立可交付

1. `ProviderRuntime` + `ProviderInstanceMeta` 落 `@harness/core`，进 `Harness` 接口。
2. `_setChatProvider` 改委托 + deprecated。
3. `resolveChatProvider` 改为 `providers.resolve()`，**未命中发 `provider.resolveMiss`**。
4. anthropic / gemini / mock 三处加 `providerId`（照抄 glm 范式），工厂透传 `config.id`。
5. CLI boot 的「默认放最后」改为**显式**：构造完所有实例后调 `providers.setDefault(defaultProviderId)`；
   删掉靠顺序的隐式约定（`packages/cli/src/index.ts:2537-2554` 注释同步改写）。

**验收**
- `config.providers` 里两个 anthropic 实例（`id: a1` / `a2`），`agent.model.providerId='a2'` 时
  `resolveChatProvider('a2')` **命中 a2**（不再是 'anthropic' 兜底）；`listProviders()` 两个 id 都在。
- 去掉「默认放最后」后，`cfg.provider` 指定的默认**仍然正确**（行为不变，机制变显式）。
- **反向验证**：把 `register` 的显式 key 改回 `p.id` ⇒ 多实例用例必须变红。

### S2 — Agent 侧守卫

1. `register(def, meta)` + `unregister` + `AgentRegisterMeta`。
2. 内部持有 source；同 id 覆盖发事件 + WARN；`overwrite:false` 抛错。
3. `applyConfigAgentOverrides` 传 `source: 'config'`（`packages/cli/src/index.ts:2172`）。
4. `setAgentTools` 的运行期覆盖（`:2207`）同样传 source，避免与「未知名来源」混淆。

**验收**
- 同 id 两次 register ⇒ 收到 `agent.reregistered`，日志有 WARN，`overwrite:false` 时抛错。
- **运行期注册新 Agent 后立即 query，工具池非空**（工具池不回归的守护测试，见 §2.4）。

### S3 — 可观测与展示

1. bus 事件接进 telemetry 插件（`packages/plugins/telemetry`）。
2. `/model ?` 展示增加「来源」列（config / builtin / runtime），与 `listConfiguredProviders` 对齐。
3. `/plugins` 展示已注册 Provider/Agent 实例数（可选）。

---

## 4. 验证计划（三段式，按项目惯例）

| 步骤 | 命令 | 闸门 |
|---|---|---|
| 类型 | `bun run typecheck` | 39 包 0 error |
| 测试 | `bun test` | 39 包 0 fail；cli / core / plugin 计数只增不减 |
| 反向验证 | 逐条摘改动 | **每条新断言都必须能单独归因变红** |

反向验证清单（S1）：
1. 摘掉显式 key ⇒ 多实例用例红，其余绿
2. 摘掉 `provider.resolveMiss` 发布 ⇒ miss 观测用例红
3. 摘掉 `setDefault` 显式调用、退回顺序 ⇒ 默认用例红

> 依据 `AGENTS.md`：「回退后变红」是断言有效性的唯一证据。断言必须**盯住被改的那一行**。

---

## 5. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 改默认语义会与 CLI「默认放最后」打架，产生双口径 | 同一 commit 改完两侧；CLI 侧注释一并改写 |
| R2 | 16 个 provider 插件迁移面大 | `_setChatProvider` 委托保留；插件按「新路径优先、老宿主回退」渐进迁移 |
| R3 | `core.test.ts:1169` / `:1197` 依赖「最后注册为默认」 | 这是**预期行为变更**，测试同步改，commit message 写明 |
| R4 | `chatProviders` key 从 `p.id` 变显式 id，可能影响未知调用方 | 全仓 grep `_setChatProvider`（已确认调用方仅 6 个 provider 包 + 测试） |
| R5 | Anthropic 多实例启用后，用量/遥测按 `providerId` 归集是否会串 | S3 一并核对 `usage` 包的 provider 维度口径 |

---

## 6. 四项裁决（已拍板，2026-09-29）

| # | 问题 | 裁决 | 落地处 |
|---|---|---|---|
| Q1 | 注册键 | **调用方显式给**（§2.1） | `providers.register(id, p, meta)`；键为空即抛错 |
| Q2 | 默认语义 | **显式 `setDefault`**；未注册即抛错 | `ProviderRuntimeImpl.setDefault`；CLI boot 显式调用 |
| Q3 | `unregister` 掉默认 | **回落「首个已注册」**（无实例则回构造期 Provider）+ 发事件 | `ProviderRuntimeImpl.unregister` |
| Q4 | Agent 的 source 存哪 | **`WeakMap<AgentDefinition, string>`**（不污染契约） | `AgentRuntimeImpl.agentSource` |

---

## 7. 刻意不做

- **不给注册加管道 hook**（理由见 §2.5）。
- **不做 `unregister` 的级联**：摘掉 Provider 不动使用它的 Agent 定义；摘掉 Agent 不动会话里
  已引用它的历史。级联语义复杂且容易造成「静默改历史」，留给调用方显式处理。
- **不做 `config.json` 的运行期热加载**：本方案只解决「程序化注册」，文件监听是另一件事。
- **不碰 `ProviderTypeRegistry`**（类型层已经是对的，别动）。

---

## 8. 实施记录（S1 + S2，2026-09-29）

### 8.1 与计划的偏差

| # | 计划 | 实际 | 原因 |
|---|---|---|---|
| 1 | `AgentRegisterMeta { source, overwrite? }` | 多一个 **`overlay?: boolean`** | 计划要求"同 id 覆盖一律 WARN"，但**文档化的覆盖链**（options → dir:user → dir:project → config）与 `/tools` 落盘都是正常路径，每次启动刷 WARN 会把真正异常的那条淹掉。`overlay: true` 时**只发事件不打 WARN** —— 事实靠事件可见，噪音靠 overlay 压掉 |
| 2 | anthropic 侧"新路径优先、老宿主回退" | 同计划 | 三处硬编码单例（anthropic / gemini / mock）已迁移；`provider-openai` / `glm` / `qwen` **未迁移**（它们本来就透传 `config.id`，走 `_setChatProvider` 老路径正确），留给后续 |
| 3 | CLI「删掉靠顺序的隐式约定」 | 保留"默认实例只构造一次"的跳过，但注释改写 | 跳过是为了避免同一 id 构造出两个实例互相覆盖，**不是**"顺序即语义"；语义改由显式 `setDefault` 承担 |
| 4 | `chosenProviderId` 未在计划中 | 新增，且**刻意不复用展示用的 `cpId`** | 无 key 回退 mock 时两者口径不同：`cpId` 是配置意图（anthropic），实际装配是 mock。拿意图去 `setDefault` 会抛「未注册」 |

### 8.2 两条重要发现

1. **S1 的两处修复在当前状态下互为冗余**：mute「core 的注册键退回 `provider.id`」**不会**让
   CLI 端到端用例变红 —— 因为插件侧已把实例自报 id 修正为 `providerId`，`provider.id === 显式键`。
   core 那半的价值是**防御纵深**（任何自报共享 id 的 provider 都不会再撞键）。
   ⇒ 守卫必须造出"自报 id 与注册键不一致"的形状才测得到（core 用例里两个 spy 都自报
   `'anthropic'`，注册为 `a1` / `a2`）。
2. **「最后注册赢」这条老语义由 `_setChatProvider` 的委托兜住**：mute `setDefault` 会让
   2 条**既有**用例一起变红（它们依赖 `_setChatProvider(pBeta)` 之后 beta 成默认）。
   ⇒ 老路径不做一次性大迁移是对的，否则 6 个 provider 包会一起暴露在"新老语义混用"下。

### 8.3 工具池守护测试的设计陷阱

计划 §2.4 要求"运行期注册新 Agent 后立即 query，工具池非空"。落到测试时有个陷阱：
若工具插件**无差别**注入，那么"构造期已注入全局注册表"的实现也骗得过断言
（`filterByWhitelist` 照旧能在全局表里找到它）—— 断言就没在测"那一轮重新组装了"。
实际做法：注入条件依赖 `input.agentId`（只有目标 Agent 触发才加工具），并加**控制组**
（先跑默认 Agent，断言它看不到该工具），把"按 agentId 分流"本身也纳入断言。

### 8.4 验收结果

| 闸门 | 结果 |
|---|---|
| `bun run typecheck` | 39 包 0 error |
| `bun run test` | 39 包 0 fail（S1 后 1987 pass / S2 后 1992 pass；core 166 → 177，cli 403 → 404） |
| 反向验证 | S1 五条 + S2 五条，逐条归因（明细见 `docs/development-log.md` 续 212） |

收尾时全仓 typecheck 抓出 2 处测试桩（`subagent` / `coordinator` 的 `createMockAgentRuntime`）
缺 `unregister` —— 只跑单包时看不见；已补。**改公共接口必须跑全仓。**

### 8.5 未做（S3 起）

1. ~~bus 事件接 telemetry 插件 —— 注册事实落 JSONL~~ → **S3 已做**（§9.1）
2. ~~`/model` 展示增加「来源」列~~ → **S3 已做**（§9.3）
3. ~~`/plugins` 展示已注册 Provider / Agent 实例数~~ → **S3 已做**（§9.4）
4. ~~`provider-openai` / `glm` / `qwen` 迁到 `providers.register`~~ → **S3 已做**（§9.5）
5. `unregister` 的级联语义（方案 §7 说刻意不做，仍待真实需求驱动）。
6. `UsageStats` 增加 provider 维度（S3 只做了一半，见 §9.6 与 §9.8）。

---

## 9. 实施记录（S3，2026-09-29，`10e9afd`）

### 9.1 计划外但必须做的：`resolveMiss` 落错了文件

计划里 S3-1 写的是"bus 事件接 telemetry"。核对时发现**这半件事早就成立了** ——
telemetry 用 `subscribeAll` 通配订阅，`ProviderEvents` / `AgentEvents` 一直会落成
`telemetry.bus.provider.*` / `telemetry.bus.agent.*`。真正的问题在别处：

`resolveMiss` 的载荷是 `{ requested, fallbackId }`，**没有会话归属**；而遥测按
`attrs.sessionId` 分文件 ⇒ 它必然落进 **run 级** `run.telemetry.jsonl`。而
「配置指向了不存在的实例」恰恰是**轮内**发生的事（`_runStep` 里 `sessionId` / `agentId`
就在手边）⇒ 按会话取证时"静默回退"永远看不见。与 `telemetry.tool.fail` 曾丢掉
sessionId（真机 79 条全落 run 级）是**同一个坑**。

改法：`ProviderRuntime.resolve(id, ctx)` + `HarnessImpl.resolveChatProvider(id, ctx)` +
`_runStep` 传 `{ sessionId, agentId }`。新增 `ProviderResolveCtx` 类型，注释写明它
**只影响事件归属、不参与选谁**，且与注册侧的 `ProviderInstanceMeta` 刻意分开
（后者是"实例怎么来的"、写进注册表长期有效；前者是"这次解析谁发起的"、只进当次载荷）。

### 9.2 计划外：遥测语义化的判据

`mapBusEvent` 原本只有 `ERROR_NAMES = {'harness.error'}`。改为 `SEMANTIC_KINDS` 映射表，
新增 `provider.resolveMiss` → `telemetry.provider.resolveMiss`，并把 `requested` 提到
标准 `attrs.provider` 维度（原名保留，只加不改）。

判据（写进 `AGENTS.md`）：**错误状态 vs 正常事实**，不是"重要与否"。注册 / 反注册 /
默认变更是正常事实，落通用 `telemetry.bus.*` 就够（本就该按时间线读）；resolveMiss 会让
模型请求悄悄换一个 Provider 去发、表面完全正常，不独立成 kind 会被同类正常事实淹没。
配了控制组断言（`provider.registered` 仍走通用 kind）。

### 9.3 `/model ?` 来源列

`listConfiguredProviders()` 增 `source`：从 `harness.providers.list()` 交叉，命中给运行期
source（`plugin:provider.x` / `legacy` / `runtime`），未命中给 `未注册`。

- **来源回答的是「谁把它装上去的」，不是配置意图** —— 只有它能区分"配置写了却没装配"。
- boot 前（harness 未建）不做交叉 ⇒ 展示层不出这一列（有信息才展示，不是硬填 `config`）。
- 视图取用可选链（`this.harness?.providers?.list?.()`）：老宿主 / 测试桩没有 `providers`
  时退化成 boot 前的行为。

### 9.4 `/plugins` 实例数

manage-plugin 增两行：`已注册 Provider 实例 N：…（默认）` / `已注册 Agent M`。

**装了什么插件 与 注册了什么实例是两个维度**：装了可能一个实例都没注册（optIn 未触发 /
装配失败），一个插件也能注册多个实例（同类型多端点）—— 只列插件时这两类偏差都不可见。
`HarnessView.providers` / `agent` 是**可选**字段：老宿主不注入就不报这一行（而不是报 0）。

CLI 侧**一行没改** —— `cli.command` 的 `cmdInput.harness` 本来就是完整的 `Harness`。

### 9.5 openai / glm / qwen 迁移

三包结构是同一个模板，照 anthropic / gemini / mock 的范式改成「新路径优先、老宿主回退」。
迁移前它们的 `source` 是 `legacy`；迁完只剩第三方桩走老路径 —— `cli.test.ts` 里那个
用 `_setChatProvider` 的 my-gw 桩正好成了**回退分支的活证据**（断言 `source === 'legacy'`），
两件事在一次断言里同时成立。

### 9.6 端点维度（原风险 R5）

**核对结论**：`UsageStats` 的维度是 model / agent / tool / hourly —— **没有 provider**。
而 `ProviderConfig` 明确支持「同一模型挂多个端点」，此时 **model 名重复** ⇒ 用量与缓存行
在端点之间不可区分。

**处置分两半**：

| | 做不做 | 理由 |
|---|---|---|
| `LlmUsageSignal` 增 `providerId` + `_runStep` 带上 | **做** | 纯增量字段，无破坏；core 本来就知道这个事实，不带才是丢信息 |
| ACP `providerCache` 行增 `providerId` | **做** | 这是最常被消费的遥测行（bench 脚本用它），收益最大 |
| `UsageStats` 加 provider 维度 | **不做** | 那是**落盘格式变更**（`session.meta.usageStats`），影响旧会话恢复与展示层，留给独立决策 |

`providerId` 在 ACP 行里用 `null` 而非 undefined：**`null` 与「字段不存在」是两种意思**，
后者会让消费方怀疑是采集漏了。

### 9.7 一个必须在实施中才发现的细节：哨兵 `'default'`

`prepared.providerId` 的兜底是 `'default'`（`_runStep` 与 `providers.resolve` 都拿它当
"未指定 ⇒ 走默认"的**哨兵**，注册表里**没有**这个键）。首版实现直接 `...(providerId ? {providerId} : {})`
⇒ 未绑定 providerId 的 agent 落了 `providerId: 'default'`，等于**凭空造出一个叫 default
的端点**，消费方按它聚合会多一个假分组。

改法：`providerId && providerId !== 'default'` 才带（缺省本身就表达"这次走默认"）。
这条是反向验证第 ⑩ 条测出来的 —— **先按"忠实反映引擎口径"写了一版，被断言纠正**。

### 9.8 验收结果

| 闸门 | 结果 |
|---|---|
| `bun run typecheck` | 39 包 0 error |
| `bun run test` | 39 包 0 fail（1992 → **2000** pass / +8：core +3、cli +1、telemetry +3、acp-context +1） |
| 反向验证 | **10 条逐条归因**（明细见 `docs/development-log.md` 续 213） |

### 9.9 剩余未做

1. `UsageStats` 的 provider 维度（§9.6 的格式变更部分）。
2. `unregister` 的级联语义（§7 刻意不做）。
3. `_setChatProvider` 的最终删除（当前保留为 deprecated 委托，只剩第三方桩在走）。
