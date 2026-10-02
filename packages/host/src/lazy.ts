/**
 * 惰性 import 一个随应用打包的模块并返回其命名导出（内置插件的统一惰性加载入口）。
 *
 * ## 为什么是惰性而不是顶部 import
 * 内置插件二十余个（provider-* / tools-* / 编排类），启动时全量加载会明显拖慢首屏，
 * 而绝大多数会话只用到其中两三个。故一律经本函数在「真正用到时」才 dynamic import。
 *
 * ## ⚠️ 契约：specifier 由**消费方**的依赖树解析，不是本包自带的
 * `import(specifier)` 的解析基准是本包文件位置，但这些模块并不在这里：它们由 monorepo
 * 根 `node_modules`（或最终宿主的依赖树）提供。由此派生两条约束：
 *   1. 消费 `@harness/host` 的宿主（cli / a2a-server / 编辑器扩展）必须能解析下表列出的包；
 *   2. 本包 `package.json` 把这份清单声明为 dependencies：既表达真实契约，也给打包器一份
 *      可机读的入口来源（而不是靠"反正是 monorepo 根 node_modules 有"这种隐式事实）。
 *
 * ## 为什么内置包走**静态查表**而不是 `import(变量)`
 * 打包器（含 `bun build --compile`）**只能静态分析字面量**：写成
 * `import(specifier)` 时，这些包不会进 bundle，运行期会按路径去真实文件系统解析 ——
 * 未编译时能命中 monorepo 根 node_modules；**编译成单文件二进制后必挂**：
 *
 * ```
 * Fatal: Cannot find module '@harness/provider-openai' from '/$bunfs/root/harness-a2a'
 * ```
 *
 * （P3-A 实测：77MB 二进制一启动就死在这条上 —— P0.5 的 spike 只验了「用户目录的动态
 * .ts 插件」，而内置插件是**按包名**动态导入的，两者不是同一条路径。）
 *
 * 故内置包改走 `BUILTIN_LAZY` 查表：字面量 ⇒ 可静态分析 ⇒ 进 bundle 且运行期重写命中，
 * 同时**惰性语义不变**（表值是函数，不调用就不加载）。表外 specifier 仍走动态路径 ——
 * 那是外部 / 用户插件目录的绝对路径（`file://` URL），P0.5 已证实在编译产物下可用。
 *
 * **新增内置插件时必须同步本表**：漏一个就是"未编译时好好的、编译后启动即崩"。
 * `builtin-registry.test.ts` 有源码扫描的守卫测试卡这条。
 */

/** 内置包 → 惰性加载器（字面量 import，供打包器静态分析） */
const BUILTIN_LAZY: Record<string, () => Promise<Record<string, unknown>>> = {
  '@harness/acp-context': () => import('@harness/acp-context'),
  '@harness/code-intel': () => import('@harness/code-intel'),
  '@harness/code-intel/meta': () => import('@harness/code-intel/meta'),
  '@harness/computer-use': () => import('@harness/computer-use'),
  '@harness/computer-use/meta': () => import('@harness/computer-use/meta'),
  '@harness/coordinator': () => import('@harness/coordinator'),
  '@harness/herdr': () => import('@harness/herdr'),
  '@harness/manage-plugin': () => import('@harness/manage-plugin'),
  '@harness/mcp-server-registry': () => import('@harness/mcp-server-registry'),
  '@harness/memory': () => import('@harness/memory'),
  '@harness/provider-anthropic': () => import('@harness/provider-anthropic'),
  '@harness/provider-gemini': () => import('@harness/provider-gemini'),
  '@harness/provider-glm': () => import('@harness/provider-glm'),
  '@harness/provider-mock': () => import('@harness/provider-mock'),
  '@harness/provider-openai': () => import('@harness/provider-openai'),
  '@harness/provider-qwen': () => import('@harness/provider-qwen'),
  '@harness/skill-forge': () => import('@harness/skill-forge'),
  '@harness/subagent': () => import('@harness/subagent'),
  '@harness/swarm': () => import('@harness/swarm'),
  '@harness/telemetry': () => import('@harness/telemetry'),
  '@harness/tools-builtin': () => import('@harness/tools-builtin'),
  '@harness/tools-builtin/meta': () => import('@harness/tools-builtin/meta'),
  '@harness/tools-glob': () => import('@harness/tools-glob'),
  '@harness/tools-glob/meta': () => import('@harness/tools-glob/meta'),
  '@harness/tools-manager': () => import('@harness/tools-manager'),
  '@harness/tools-media': () => import('@harness/tools-media'),
  '@harness/tools-media/meta': () => import('@harness/tools-media/meta'),
  '@harness/tools-search': () => import('@harness/tools-search'),
  '@harness/tools-search/meta': () => import('@harness/tools-search/meta'),
  '@harness/tools-web': () => import('@harness/tools-web'),
  '@harness/tools-web/meta': () => import('@harness/tools-web/meta'),
}

/**
 * 惰性 import。
 *
 * @param specifier 内置包名（走静态表）或外部/用户插件的绝对 `file://` URL（走动态）
 */
export async function lazyImport<T extends Record<string, unknown>>(specifier: string): Promise<T> {
  const known = BUILTIN_LAZY[specifier]
  if (known) return (await known()) as T
  // 表外：外部插件 / 用户插件目录（编译产物下由 P0.5 验证过的路径解析兜底）
  return (await import(specifier)) as T
}
