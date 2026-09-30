/**
 * Spike ②：bun build --compile 产出的单文件二进制，能否在运行期 import
 * 用户目录里的 .ts / .js / .mjs 插件（对应 loadPluginDirs 的
 * `await import(pathToFileURL(full).href)`）。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('usage: app <plugin-file>')
  process.exit(2)
}

const full = resolve(process.cwd(), target)
console.log(`runtime: ${process.execPath} (embedded=${process.execPath.endsWith('app') || process.execPath.endsWith('main')})`)
console.log(`loading: ${full}`)

try {
  const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>
  console.log(`✅ loaded: id=${String(mod.id)} keys=${Object.keys(mod).join(',')}`)
} catch (err) {
  const msg = (err as Error)?.message ?? String(err)
  console.log(`❌ failed: ${msg.split('\n')[0]}`)
}
