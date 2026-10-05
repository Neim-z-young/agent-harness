/**
 * 模板文件导入声明（与 computer-use 的 prompts/*.txt 同一套路：模板外置、经 import 加载）。
 *
 * 为什么外置而不是内联字符串：
 *   1. 模板是**用户可见的产物**（`/plan` 初始化的就是这份内容），放独立文件可读、可 diff；
 *   2. 上游 planning-with-files 的三文件格式若漂移，改模板文件即可，不动逻辑；
 *   3. 与 tools-builtin / computer-use 的"提示词外置"惯例一致。
 *
 * ⚠️ **后缀必须是 `.txt`，不能是 `.md`** —— Bun 对 `.md` 的默认 loader 是 **markdown→HTML**，
 * `import tpl from './x.md'` 拿到的是 `<h2>Goal</h2>…` 而不是原文（实测：模板写进磁盘后
 * `/plan` 打开就是一堆 HTML 标签）。`.txt` 走 text loader，逐字拿到原文。
 */
declare module '*.txt' {
  const content: string
  export default content
}
