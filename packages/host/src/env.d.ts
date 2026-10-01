/**
 * 文本文件导入声明（参考 opencode：prompt 文本放 .txt，经 import 加载）。
 * Bun 原生支持 import 任意文本文件为默认导出字符串；tsc 侧用此声明保持类型安全。
 *
 * 本文件随 `default-agent.txt` 一并自 `@harness/cli` 上移：`defaultAgent()` 是装配产物的一部分
 * （见 `./host.ts` 文件头），它的 systemPrompt 得跟着走。
 */
declare module '*.txt' {
  const content: string
  export default content
}
