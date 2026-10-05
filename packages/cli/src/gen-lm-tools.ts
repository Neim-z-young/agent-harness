/**
 * 生成 `adapters/vscode/package.json` 的 `contributes.languageModelTools`（P3-D，设计稿 §14.4）。
 *
 * ## 为什么是"生成"而不是"手写"
 *
 * `lm.registerTool` 只提供实现体 —— **`LanguageModelTool<T>` 接口只有 `invoke` /
 * `prepareInvocation`，没有任何描述字段**（`vscode.d.ts:21165`/`21181`）。也就是说模型能看到的
 * `displayName` / `modelDescription` / `inputSchema` **全部来自 package.json 这份静态声明**。
 * 而 harness 的工具池是运行期动态的（跨 9 个插件包、还会随 config 变动）⇒ 手写必然漂移，
 * 而漂移的后果不是"报错"，是"Copilot 拿不到入参 schema、于是发 `input: {}`"——
 * `read_file` 在真机上就是这样被发了 14 次（`tools-builtin/src/index.ts:119` 有完整记录）。
 *
 * ## 取源是**运行期注册表**，不是静态元信息
 *
 * `src/meta.ts`（各插件包的 L1 静态元信息）有 `id`/`description`/`permissionKey`/`isReadOnly`，
 * 但**没有 `inputSchema`** —— 拿它生成等于交出一份没有 schema 的贡献点，正好踩上面那个坑。
 * 所以这里**真的起一个 host**、读 `harness.tools.list()`。代价是慢一点（约百毫秒），
 * 换来的是"生成结果与客户端运行期注册的那一份**同源**"。
 *
 * ## 为什么必须**密封**（这条是实测踩出来的）
 *
 * 开发机上的真实 sidecar 读的是个人 `config.json`，实测工具池是 **32 个**（含
 * `mcp__wb-llm__web_search` 这类**私有 MCP server 的工具**）。若把它写进扩展清单，
 * 就是把某一个人的机器状态当成产品默认值。故这里用**临时 dataDir** 起 host ⇒
 * 拿到的是**默认装配**的池子（实测 12 插件 / 10 工具，确定性）。
 *
 * ## JSON 没有注释
 *
 * 设计稿 §14.4 原写"生成段落带 `DO NOT EDIT` 头"—— 落地时发现 **JSON 不支持注释**，
 * 于是这条提示改放三处：本文件头、`adapters/vscode/README.md`、守卫用例的名字。
 * 贡献点里**不塞占位字段**（`contributes` 有不认识的键时 VSCode 会校验告警）。
 *
 * ## 跑法
 *
 * ```bash
 * bun run gen:lm-tools            # 生成并写入
 * bun run gen:lm-tools --check    # 只比对（漂移则退出码 1）—— 守卫用例走同一份逻辑
 * ```
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessHost } from '@harness/host'
import { listToolDescriptors, type ToolDescriptor } from '@harness/a2a-server'

// ========================================================================
// 1. 命名规则（必须与扩展侧 `lmtools.ts` 逐字一致 —— 由守卫用例钉住）
// ========================================================================

/**
 * LM 工具名前缀。
 *
 * ⚠️ **与 `adapters/vscode/src/lmtools.ts` 的 `LM_TOOL_PREFIX` 必须逐字相同**：
 * 生成的是"客户端将要注册的名字"，两边不一致的后果是"清单里有、注册时没有"
 * （Copilot 看得到却调不动，或反过来）。守卫用例比对源码文本。
 */
export const LM_TOOL_PREFIX = 'harness_'

/** 工具名净化用的两个正则（与扩展侧同名常量**逐字一致**，守卫用例比对源码文本） */
const NAME_SAFE_RE = /[^A-Za-z0-9_-]+/g
/** 去首尾下划线 */
const NAME_TRIM_RE = /^_+|_+$/g

/** 工具名净化：只留 `[A-Za-z0-9_-]`，其余换成 `_`，并去掉首尾下划线（同扩展侧规则） */
export function sanitizeToolName(raw: string): string {
  return raw.trim().replace(NAME_SAFE_RE, '_').replace(NAME_TRIM_RE, '')
}

/** harness 工具 id → LM 工具名 */
export function lmToolNameOf(harnessName: string): string {
  return `${LM_TOOL_PREFIX}${sanitizeToolName(harnessName)}`
}

/**
 * UI 上的显示名：`read_file` → `Read File`。
 *
 * 与工具 id 无关的纯展示，切词用"非字母数字"而不是下划线 —— 于是 `mcp__x__y` 这类
 * 双下划线也能切成人话（`Mcp X Y`）。
 */
export function displayNameOf(harnessName: string): string {
  const words = harnessName.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length === 0) return harnessName
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ========================================================================
// 2. 描述符 → 贡献点条目
// ========================================================================

/** `contributes.languageModelTools` 的一条（字段与顺序即最终写进 package.json 的形状） */
export interface LmToolContribution {
  /** 唯一名；带扩展名前缀，避免与别的扩展撞名（VSCode 命名指南要求） */
  name: string
  /** 供 Chat 视图分组/过滤 */
  tags: string[]
  /** 用户在提示里用 `#` 引用它的名字（`canBeReferencedInPrompt: true` 时必填） */
  toolReferenceName: string
  /** UI 显示名 */
  displayName: string
  /** **模型**据此判断何时调用 —— 直接取工具自己的描述（为模型写的那份） */
  modelDescription: string
  /**
   * 让工具出现在 agent mode 与 `#` 引用里，并允许用户在 Chat 视图里单独关掉它。
   *
   * 取 `true` 是**功能所必需**：官方指南把这一项与"能被 agent 使用"写在同一条
   * （"Set to `true` if the tool can be used with agents or referenced in chat"）。
   * 附带的好处是用户可以关掉他不想要的（例如 `harness_bash`），
   * 代价是这些工具会出现在 Chat 视图的工具清单里（本仓选择暴露全部工具，见 §14.5）。
   */
  canBeReferencedInPrompt: boolean
  /** 入参 JSON Schema：**直出**工具的 `__jsonSchema`，不裁剪、不重写 */
  inputSchema: Record<string, unknown>
}

export function toContribution(d: ToolDescriptor): LmToolContribution {
  return {
    name: lmToolNameOf(d.name),
    tags: ['harness'],
    toolReferenceName: sanitizeToolName(d.name),
    displayName: displayNameOf(d.name),
    modelDescription: d.description,
    canBeReferencedInPrompt: true,
    inputSchema: d.inputSchema,
  }
}

/**
 * 描述符列表 → 贡献点条目（按 LM 工具名排序）。
 *
 * 两个**硬失败**（宁可让生成脚本红，也不写出一份坏清单）：
 * 1. 名字净化后为空 ⇒ 无法命名；
 * 2. 净化后**互相撞名** ⇒ 同一个 `toolReferenceName` / `name` 出现两次，
 *    这在 `package.json` 里是非法清单（而 VSCode 的报错会指向整个贡献点，极难定位）。
 *    扩展侧的 `parseToolList` 对撞名是"留先出现的 + 报出来"，这里更严：
 *    生成期就该有人去修工具 id，而不是让一份带重复的清单上线。
 */
export function buildContributions(descriptors: readonly ToolDescriptor[]): LmToolContribution[] {
  const out: LmToolContribution[] = []
  const seen = new Map<string, string>()
  for (const d of descriptors) {
    const safe = sanitizeToolName(d.name)
    if (safe === '') throw new Error(`工具名 "${d.name}" 净化后为空，无法作为 LM 工具名`)
    const name = LM_TOOL_PREFIX + safe
    const prev = seen.get(name)
    if (prev !== undefined) throw new Error(`工具 "${d.name}" 与 "${prev}" 归一化后同名（${name}）`)
    seen.set(name, d.name)
    out.push(toContribution(d))
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// ========================================================================
// 3. 密封取源：临时 dataDir 起一个 host，读默认装配的工具池
// ========================================================================

/**
 * 密封地取一份"默认装配"的工具描述符。
 *
 * 三条密封措施：
 * - `cwd` / `dataDir` 都指向**临时目录** ⇒ 不读个人 `config.json`、不写用户目录；
 * - `provider: 'mock'` ⇒ 不碰网络、不要 API key；
 * - `backgroundPreload: false` + 显式 `warmupBuiltins()` ⇒ **确定性**（不赌"后台预加载跑完了没"）。
 */
export async function collectDescriptors(): Promise<ToolDescriptor[]> {
  const dir = mkdtempSync(join(tmpdir(), 'gen-lm-tools-'))
  const host = new HarnessHost({
    cwd: dir,
    dataDir: join(dir, '.harness'),
    agentId: 'default',
    provider: 'mock',
    permissionMode: 'ask',
    autoResume: false,
    backgroundPreload: false,
  })
  try {
    await host.boot()
    // 工具池"可列"= 非 optIn 内置插件都装了 + assembleTools 跑过；这里显式做掉，
    // 不依赖任何启动顺序（同一个理由写在 `harness/tools.list` 的注释里）
    const warm = await host.warmupBuiltins()
    const tools = host.harness.tools.list()
    if (tools.length === 0) {
      throw new Error(
        `工具池是空的（已装 ${warm.installed.length} 个插件、失败 ${warm.failed.length} 个）—— `
        + '不肯写出一份空清单：那等于让 Copilot 一个 harness 工具都看不到',
      )
    }
    return listToolDescriptors(tools)
  } finally {
    await host.shutdown().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

// ========================================================================
// 4. 写回 package.json
// ========================================================================

/** 目标文件（相对仓库根） */
export const TARGET_RELPATH = 'adapters/vscode/package.json'

/** 读出现有贡献点（没有则 `undefined`）—— 守卫用例与 `--check` 共用 */
export function readContribution(pkgText: string): unknown {
  const pkg = JSON.parse(pkgText) as { contributes?: { languageModelTools?: unknown } }
  return pkg.contributes?.languageModelTools
}

/**
 * 把贡献点写进 `package.json` 文本。
 *
 * 做法是"整体 JSON 往返"（parse → 赋值 → `JSON.stringify(o, null, 2)` + 尾换行）：
 * 实测该文件本身就是这个序列化结果（往返**逐字一致**），所以 diff 只会多出
 * `languageModelTools` 这一段，不会把别的段落格式重排。
 *
 * 键的位置放在 `contributes` 的**末尾**（现有 `configuration` 之后）—— 手工写入的小段落
 * 保持在前面，生成的部分永远在最后，diff 一眼能看出"这次只动了生成段"。
 */
export function applyContribution(pkgText: string, entries: LmToolContribution[]): string {
  const pkg = JSON.parse(pkgText) as { contributes?: Record<string, unknown> }
  pkg.contributes ??= {}
  pkg.contributes['languageModelTools'] = entries
  return `${JSON.stringify(pkg, null, 2)}\n`
}

// ========================================================================
// 5. CLI
// ========================================================================

/** 生成一份新的贡献点数组（两个入口共用） */
export async function generate(): Promise<LmToolContribution[]> {
  return buildContributions(await collectDescriptors())
}

/** 供守卫用例使用：读已提交的那一份 */
export function readCommitted(repoRoot: string): unknown {
  return readContribution(readFileSync(join(repoRoot, TARGET_RELPATH), 'utf8'))
}

async function main(): Promise<number> {
  const repoRoot = join(import.meta.dir, '..', '..', '..')
  const check = process.argv.includes('--check')
  const path = join(repoRoot, TARGET_RELPATH)
  const text = readFileSync(path, 'utf8')

  const entries = await generate()
  const committed = JSON.stringify(readContribution(text))
  const fresh = JSON.stringify(entries)

  if (check) {
    if (committed === fresh) {
      process.stdout.write(`✅ ${TARGET_RELPATH} 的 languageModelTools 是最新的（${entries.length} 条）\n`)
      return 0
    }
    process.stderr.write(
      `❌ ${TARGET_RELPATH} 的 languageModelTools 已漂移 —— 跑 \`bun run gen:lm-tools\` 重新生成\n`,
    )
    return 1
  }

  if (committed === fresh) {
    process.stdout.write(`✅ 无需改动（${entries.length} 条）\n`)
    return 0
  }
  writeFileSync(path, applyContribution(text, entries))
  process.stdout.write(`✍️  已写入 ${TARGET_RELPATH}：${entries.length} 条 languageModelTools\n`)
  return 0
}

if (import.meta.main) {
  process.exitCode = await main()
}
