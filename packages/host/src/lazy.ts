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
 *   2. `bun build --compile` 打包时 `import(变量)` 无法被静态分析 ⇒ 这些包**不会**自动进
 *      bundle，必须由打包配置显式收入口（P3 分发路径的前置项）。
 * 本包 `package.json` 把这份清单声明为 dependencies：既表达真实契约，也给打包器一份可机读
 * 的入口来源（而不是靠"反正是 monorepo 根 node_modules 有"这种隐式事实）。
 */
export async function lazyImport<T extends Record<string, unknown>>(specifier: string): Promise<T> {
  return (await import(specifier)) as T
}
