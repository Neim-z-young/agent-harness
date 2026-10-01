/**
 * Provider / 模型的规格解析、配置归一化与上下文窗口推导（P0 §3）。
 *
 * 从 `index.ts` 拆出（P0 收尾 S2）：配置层（`./config.ts`）与启动装配都要用这一组纯函数，
 * 三者若同处一文件，`config.ts` 就只能反向 import `index.ts` 而形成环。拆开后依赖是单向的：
 * `index.ts` → `config.ts` → `provider.ts`，`provider.ts` 无内部依赖。
 *
 * 本文件全部是**纯函数、无 IO**（`index.ts` 原注释：搬它们不是因为"顺路"，而是因为上下文窗口
 * 这个分母必须全进程一份口径 —— 显示 / 压缩阈值 / ACP 占用率三处各自算一遍，就会出现
 * "概览说 26%、实际已 103%"这类**全程无症状**的故障）。
 */
import type { ProviderConfig } from '@harness/plugin'
import type { ProviderWindowTable } from '@harness/acp-context'

// ========================================================================
// 3. 配置归一化与上下文窗口推导（P0 第三步：B 档）
// ========================================================================
// 纯函数、无 IO。搬它们不是因为"顺路"，而是因为**上下文窗口这个分母必须全进程一份口径**：
// 显示（/stats、TUI 占用率）、会话压缩阈值、ACP 占用率三处各自算一遍，就会出现
// "概览说 26%、实际已 103%"这类**全程无症状**的故障（本仓出过）。
//
// ## 为什么用 `ProviderWindowConfigSource` 窄类型而不是 `HarnessConfig`
// 配置模型（`HarnessConfig`）还住在 `@harness/cli`，它有二十来段（压缩 / 记忆 / 遥测 /
// 插件 / 快照…），而窗口推导只读其中两段。为两个字段把整份配置模型拖进共用装配层，
// 等于让 host 反向依赖 cli 的配置口径 —— 而 A2A server / 编辑器扩展的配置来源未必是
// config.json。用结构化的最小契约是**依赖倒置**，不是本仓的老病"同一个东西两套写法"：
// 它不含任何第二份实现，宽类型（`HarnessConfig`）传进来天然兼容。

/** 解析 `[provider/]modelId` 规格。示例：'openai/gpt-4o' → { providerId:'openai', modelId:'gpt-4o' }；'claude-3-5-sonnet' → { modelId:'claude-3-5-sonnet' } */
export function parseModelSpec(spec: string): { providerId?: string; modelId: string } {
  const s = spec.trim()
  const idx = s.indexOf('/')
  if (idx <= 0) return { providerId: undefined, modelId: s }
  return { providerId: s.slice(0, idx).trim() || undefined, modelId: s.slice(idx + 1).trim() || s }
}

/** 格式化显示 `provider/modelId`（无 providerId 时仅返回 modelId） */
export function formatModel(providerId: string | undefined, modelId: string | undefined): string | undefined {
  if (!modelId) return undefined
  return providerId ? `${providerId}/${modelId}` : modelId
}

/** providers 配置校验问题（index=-1 表示非数组内问题，如默认 provider 未定义） */
export interface ProviderConfigIssue {
  index: number
  message: string
}

/**
 * 已归一化的 Provider 定义：`id` 必定存在（显式指定，或由 `normalizeProviderConfigs` 从 model 派生）。
 * 归一化之后的下游代码（装配 / 路由 / 展示）一律按「id 必有」处理，无需到处判空。
 */
export interface ResolvedProviderConfig extends ProviderConfig {
  id: string
}

/** 把任意字符串规整为可用的 id 片段：保留 [A-Za-z0-9._-]，其余折叠为 '-'，去首尾连字符 */
export function sanitizeProviderId(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * 归一化 providers 数组：把可选的 `id` 补全为**确定性且唯一**的实例 id。
 *
 * 设计意图（本函数是「id 不再必须冗长/手写」的落点）：
 * - 显式写了 `id` → 原样保留；重复则报错（沿用旧校验语义，避免静默覆盖注册）。
 * - 未写 `id` 但写了 `model` → 由模型名派生（去 `provider/` 前缀、规整非法字符）；
 *   与已占用 id 冲突时按数组顺序追加 `-2` / `-3`…（结果确定、可复现，无需人工起名）。
 * - `id` 与 `model` 都缺失 → 报错（无从派生）。
 *
 * 纯函数（无 IO），`issues[].index` 对应原始数组下标，便于在报错中定位。
 */
export function normalizeProviderConfigs(raw: ProviderConfig[]): {
  providers: ResolvedProviderConfig[]
  issues: ProviderConfigIssue[]
} {
  const issues: ProviderConfigIssue[] = []
  const taken = new Set<string>()
  const providers: ResolvedProviderConfig[] = []
  raw.forEach((pc, index) => {
    const explicit = pc.id?.trim()
    if (explicit) {
      if (taken.has(explicit)) {
        issues.push({
          index,
          message: `providers[${index}].id "${explicit}" 与前面的 provider 重复（显式 id 必须唯一，否则后注册的会被覆盖；也可省略 id，交由系统按 model 自动派生）`,
        })
      }
      taken.add(explicit)
      // 首个同 id 保留，保持与旧行为一致（默认 provider 仍能在数组中找到）
      if (!providers.some((p) => p.id === explicit)) providers.push({ ...pc, id: explicit })
      return
    }
    const derived = pc.model ? sanitizeProviderId(parseModelSpec(pc.model).modelId) : ''
    if (!derived) {
      issues.push({ index, message: `providers[${index}] 既未写 id 也未写 model，无法派生实例 id（至少填写其一）` })
      return
    }
    let id = derived
    for (let n = 2; taken.has(id); n++) id = `${derived}-${n}`
    taken.add(id)
    providers.push({ ...pc, id })
  })
  return { providers, issues }
}

/**
 * 窗口推导所需的最小配置面（见本节开头：为什么不用 `HarnessConfig`）。
 * `providers[]` 提供端点级窗口；`compression.modelContextLimit` 是全局显式覆盖。
 */
export interface ProviderWindowConfigSource {
  providers?: ProviderConfig[]
  compression?: { modelContextLimit?: number }
}

/** 窗口得是个能当分母的正有限数 —— `0` / 负数 / `NaN` 一律按「没配」处理（否则占用率会算出 Infinity/NaN） */
export function isUsableWindow(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * 上下文窗口推导（ACP 默认 Provider 口径）：
 * `compression.modelContextLimit → 默认 Provider 的 contextWindowTokens → 200000`。
 *
 * 抽成函数是因为**三处**都要它：boot 装配 ACP、配置概览、会话压缩选项。此前概览与 boot
 * 各写一份、会话压缩干脆硬编码 200000，于是同一份 config 能同时得出 200000 和 102400
 * 两个窗口 —— 按概览做的判断全部落空，会话压缩则因阈值 136000 > 真实窗口而从不触发。
 * 默认 provider 的 id 可能省略（由 model 派生），故同样走 normalizeProviderConfigs。
 *
 * 各级都要求窗口是**能当分母的正有限数**（见 isUsableWindow）：`contextWindowTokens: 0` 这种
 * 笔误若原样当选，占用率会算出 Infinity、阈值会算成负数 —— 两个都伪装成"正常显示"。
 */
export function resolveContextWindowTokens(cfg: ProviderWindowConfigSource, defaultProviderId: string): number {
  const { providers } = normalizeProviderConfigs(cfg.providers ?? [])
  const explicit = cfg.compression?.modelContextLimit
  if (isUsableWindow(explicit)) return explicit
  const derived = providers.find((p) => p.id === defaultProviderId)?.contextWindowTokens
  return isUsableWindow(derived) ? derived : 200_000
}

/**
 * `buildProviderWindowTable` 的返回形状：两张表**恒存在**（只是内容可能为空），`fallback` 恒有值。
 *
 * 为什么不让它沿用 `ProviderWindowTable` 的可选字段：那是**插件侧**的入参契约（调用方可以只给
 * 一半），而这里是**装配方的产出**——它必然建好两张表。返回类型说"可能没有"会让每个消费方
 * 都写一次 `?.` / `!`，把"实际恒有"的事实藏进断言里。
 */
export type ProviderWindowTableView = ProviderWindowTable & {
  byProvider: Record<string, number>
  byModel: Record<string, number>
  fallback: number
}

/**
 * 构造「Provider / 模型 → 上下文窗口」表，供 ACP 按会话**实际**使用的端点解析占用率分母。
 *
 * 为什么必须按端点分化：`resolveContextWindowTokens` 只回答「**默认** Provider 的窗口是多少」，
 * 而 Provider / 模型是**按 Agent 解析、且每次派工都能覆盖**的
 * （core：`input.model?.providerId ?? agent.model?.providerId ?? 'default'`，见 SubagentTool 的
 * `model` 入参）。子 Agent 被派到小窗口端点时，拿默认 Provider 的窗口当分母会让占用率**虚低** ——
 * 真机形态：默认端点 300K、子 Agent 走 200K 端点 ⇒ 报 66% 时其实已 100%，压缩永不触发，
 * 且全程无任何症状（`acp_status` 照常报数，只是分母不是本会话的）。
 *
 * `fallback` 取 `resolveContextWindowTokens` 的**原值**（不是另算一遍）：查不到端点时逐位回到
 * 改造前的行为。这是「缺省零行为变更」的保证点 —— 换成别的推导就会在无 providers 的场景下
 * 悄悄改掉分母。
 *
 * `byModel` 对同名多实例取**最小**窗口：模型名相同而端点窗口不同时无从分辨到底走哪个，
 * 取最小 = 宁可早压。反方向（取最大）会让分母虚高，正是要避免的那个。
 */
export function buildProviderWindowTable(
  cfg: ProviderWindowConfigSource,
  defaultProviderId: string,
): ProviderWindowTableView {
  const { providers } = normalizeProviderConfigs(cfg.providers ?? [])
  const byProvider: Record<string, number> = {}
  const byModel: Record<string, number> = {}
  for (const p of providers) {
    const w = p.contextWindowTokens
    // 窗口得是能当分母的正有限数；`0` / 负数 / `NaN` 只当"没配"（否则占用率会算出 Infinity/NaN）
    if (!isUsableWindow(w)) continue
    byProvider[p.id] = w
    if (p.model) byModel[p.model] = Math.min(byModel[p.model] ?? Number.POSITIVE_INFINITY, w)
  }
  return { byProvider, byModel, fallback: resolveContextWindowTokens(cfg, defaultProviderId) }
}
