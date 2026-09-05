/**
 * 复制三个语法 wasm 到产物目录（dist/），供 code-intel 多语言引擎经 `import.meta.url` 相对定位读取。
 *
 * 背景：web-tree-sitter 自身即用 `new URL('tree-sitter.wasm', import.meta.url)` 相对模块目录加载，
 * 不依赖 node_modules 落盘。这里在构建后把 `tree-sitter-{go,python,rust}.wasm` 与 bundle 放到同一产物目录，
 * 使 `readGrammarBytes` 的「相邻产物复制」分支在无 node_modules 的部署/打包场景命中。
 *
 * 用法：`bun scripts/copy-grammars.mts [outDir]`（缺省 dist/）。由 package.json `build` 前置调用。
 */

import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const req = createRequire(import.meta.url)

const GRAMMAR_SPECS = [
  'tree-sitter-go/tree-sitter-go.wasm',
  'tree-sitter-python/tree-sitter-python.wasm',
  'tree-sitter-rust/tree-sitter-rust.wasm',
]

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const outDir = resolve(pkgDir, process.argv[2] ?? 'dist')

mkdirSync(outDir, { recursive: true })

for (const spec of GRAMMAR_SPECS) {
  const src = req.resolve(spec)
  const dest = resolve(outDir, basename(src))
  copyFileSync(src, dest)
  console.log(`copied ${basename(src)} -> ${dest}`)
}