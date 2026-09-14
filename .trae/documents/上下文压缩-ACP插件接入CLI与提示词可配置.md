# ACP 插件接入 CLI 与提示词可配置

## 摘要 / Summary

把 `@harness/acp-context` 插件正式接入 CLI：在 `config.json` 新增顶层 `compression` 配置段作为入口，boot 时按需装配。同时落实「提示词可配置」——支持通过 `compression.prompts` 覆盖 t1/t2/t3 各层压缩提示词、`compression.systemPrompt` 整段覆盖压缩系统提示。

核心侧（统一块模型的 `session.blocks` / `blocksPatch` / `setBlocks` / `source:'acp'`）已在前期完成，本次不再改动 core。

## 现状分析 / Current State

- **插件工厂** `packages/plugins/acp-context/src/index.ts`：
  - `AcpContextPluginOptions` 目前仅支持 `modelContextLimit` / `config` / `toolIds`（[index.ts:142-149](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/acp-context/src/index.ts#L142-L149)）。
  - 压缩系统提示在 `session.preModel` 里**硬编码**为 `makeSystemPrompt: () => buildCompressSystemPrompt()`（[index.ts:417](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/acp-context/src/index.ts#L417)），无任何配置入口 → 「提示词可配置」尚未落实。
  - nudge 文本 `renderNudgeText(nudge)`（[index.ts:697](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/acp-context/src/index.ts#L697)）同样走默认提示，未与自定义提示保持一致。
- **acp-kernel 已提供提示覆盖原语**：`Prompts` 接口含 `compressPhilosophy`（哲学）`howToCompressRules`（t1）`tier2DistillRules`（t2）`tier3CondenseRules`（t3），经 `resolvePrompts(overrides, { acknowledgeRisk: true })` 合并默认，`buildCompressSystemPrompt(prompts?)` / `renderNudgeText(decision, prompts?)` 均接受该对象（`prompts.d.ts` / `nudge-text.d.ts` / `compress-tools.d.ts:124`）。t1/t2/t3 等阈值、保留 token 数本就经 `defaultConfig(contextWindow, config)` 的 `config.preserveRecentTokens/preserveRecentMessages` 配置，插件 `options.config` 已透传。
- **CLI** `packages/cli/src/index.ts`：
  - `HarnessConfig`（[index.ts:218-253](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L218-L253)）无 compression 字段。
  - `boot()` 在 [index.ts:1296-1312](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1296-L1312) 汇总 `providerPlugins` 数组 → 作为 `createHarness({ internalPlugins })` 传入（[index.ts:1324-1354](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1324-L1354)）。内置能力插件（tools-builtin / tools-manager / manage-plugin / workspace / revert / snapshot）均 push 进该数组。
  - `packages/cli/package.json` 的 `dependencies` **尚未**包含 `@harness/acp-context`。
  - 已有 `lazyImport(specifier)` 惰性加载助手（[index.ts:295](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L295)），可用于 ACP 插件的按需装载，避免硬编码依赖。

## 变更方案 / Proposed Changes

### 1. 插件：提示词可配置（`@harness/acp-context/src/index.ts`)

- **导入**：从 `acp-kernel` 增加 `resolvePrompts`、`defaultPrompts`，以及类型 `Prompts`。
- **扩展 `AcpContextPluginOptions`**，新增两个字段：
  ```ts
  /** t1/t2/t3 及压缩哲学提示词覆盖（key 见 acp-kernel Prompts） */
  prompts?: Partial<Prompts>
  /** 整段覆盖压缩系统提示（优先级最高，覆盖 prompts 合成的 buildCompressSystemPrompt 输出） */
  systemPrompt?: string
  ```
- **工厂形态**：在 `createAcpContextPlugin` 顶部解析一次（启动期）：
  ```ts
  const resolvedPrompts = options.prompts
    ? resolvePrompts(options.prompts, { acknowledgeRisk: true })
    : defaultPrompts
  const makeSystemPrompt = (): string =>
    options.systemPrompt ?? buildCompressSystemPrompt(resolvedPrompts)
  ```
- **`session.preModel`**：把硬编码的 `makeSystemPrompt: () => buildCompressSystemPrompt()` 改为引用上面的 `makeSystemPrompt`；并把 `resolvedPrompts` 传入 nudge：`renderNudgeText(nudge, resolvedPrompts)`。
- **`RunPreModelDeps`**：新增可选 `prompts?: Prompts`（供 `runPreModel` 内的 nudge 渲染使用）。在 hook 传值时透传 `{ prompts: resolvedPrompts }`。
- **测试**（`index.test.ts`）：新增用例——`systemPrompt` 覆盖后产出该字符串；`prompts` 覆盖 t1/t2/t3 字段后 nudge/系统提示体现自定义文本；未配置时回退默认。

### 2. CLI：新增 `compression` 配置入口

- **`packages/cli/package.json`**：`dependencies` 增加 `"@harness/acp-context": "workspace:*"`（与 workspace 中其它内置插件一致）；然后根目录 `bun install`。
- **`HarnessConfig`**（`packages/cli/src/index.ts`）新增字段：
  ```ts
  /** ACP 上下文压缩配置（compression.enabled 开启才装配 @harness/acp-context 插件） */
  compression?: {
    enabled?: boolean
    modelContextLimit?: number
    /** 覆盖 t1(t2/t3) 压缩提示词 / 压缩哲学（需 acknowledgeRisk） */
    prompts?: Partial<import('acp-kernel').Prompts>
    /** 整段覆盖压缩系统提示 */
    systemPrompt?: string
    /** 透传 kernel 配置：preserveRecentTokens/preserveRecentMessages/tiers/nudge 等 */
    config?: Record<string, unknown>
  }
  ```
  （`config` 用宽松 `Record` 避免深层类型耦合，插件侧仍收 `Partial<AcpConfig>`。）
- **`boot()` 装配**：在 [index.ts:1296-1312](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1296-L1312) 汇总 `providerPlugins` 处，追加（放在其它内置能力插件之后、`externalPlugins` 之前）：
  ```ts
  const compression = cfg.compression
  if (compression?.enabled) {
    const { createAcpContextPlugin } = await lazyImport<{ createAcpContextPlugin: any }>('@harness/acp-context')
    providerPlugins.push(createAcpContextPlugin({
      modelContextLimit: compression.modelContextLimit,
      systemPrompt: compression.systemPrompt,
      prompts: compression.prompts as any,
      config: compression.config,
    }))
  }
  ```
  保持「惰性加载、开启才装配」，符合 CLI 不硬编码依赖的既有风格。
- **`buildConfigOverview` 展示**（可选，低优先）：在 `/config` 概览中追加一行 ACP 启用/未启用提示，作为配置文件入口的可见反馈。

### 3. 配置示例（文档/示例）

在 `config.json` 顶层：
```jsonc
{
  "compression": {
    "enabled": true,
    "modelContextLimit": 200000,
    "config": { "preserveRecentTokens": 8000, "preserveRecentMessages": 10 },
    "prompts": {
      "howToCompressRules": "……自定义 t1 摘要规则……",
      "tier2DistillRules": "……自定义 t2 蒸馏规则……",
      "tier3CondenseRules": "……自定义 t3 压缩规则……"
    }
  }
}
```

## 假设与决策 / Assumptions & Decisions

- **默认关闭**：`compression.enabled` 缺省为 false（不改变现有行为，显式开启才装配 ACP）。
- **提示覆盖需主动承担质量风险**：`prompts` 覆盖走 `resolvePrompts(..., { acknowledgeRisk: true })`，字段为 load-bearing，配置错误类型会静默丢弃（继承 kernel 既有约定）。
- **core 无需改动**：统一块模型（`setBlocks`/`blocksPatch`/`source:'acp'`）前期已完成，本次只做 CLI 装配 + 提示可配置。
- **不新增 CLI 子命令**：只用 `config.json` 作为配置文件入口（符合「增加配置文件入口」的明确要求）；`/config` 仅展示状态，不提供运行时修改。
- **类型解耦**：`compression.config` 用宽松 `Record<string, unknown>`，插件工厂内部收窄为 `Partial<AcpConfig>`，避免 CLI 与 acp-kernel 深层类型绑定。

## 验证 / Verification

1. `cd packages/plugins/acp-context && bun run typecheck && bun test`（新加提示覆盖用例通过）。
2. `cd packages/cli && bun run typecheck && bun test`（现有 boot/配置用例不受影响）。
3. 根目录 `bun run typecheck` 全量通过。
4. 手动：写一份带 `compression.enabled:true` + `prompts` 的 `config.json`，启动 CLI，验证日志出现「ACP 上下文压缩插件已加载」、`/acp_status`/`/config` 正常，提示词体现自定义内容；去掉 `enabled` 重启则不再装配。