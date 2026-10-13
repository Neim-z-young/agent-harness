/**
 * `gen-lm-tools.ts` 的用例 —— 两块**守卫**比什么都重要：
 *
 * 1. **漂移守卫**：现场（密封）取一份工具池，与 `adapters/vscode/package.json` 里
 *    已提交的 `contributes.languageModelTools` 逐条比对。有人加了工具却没重跑生成脚本时
 *    **测试变红**，而不是等真机发现"Copilot 调不动某个工具"。
 * 2. **跨包逐字守卫**：命名规则在 `packages/cli` 与 `adapters/vscode` 各有一份
 *    （扩展是独立分发单元，不能 import）—— 比对**源码文本**，与 `map/render.ts` 的
 *    `FILE_REF_RE` 守卫同一手法。
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyContribution,
  buildContributions,
  collectDescriptors,
  displayNameOf,
  generate,
  LM_TOOL_PREFIX,
  lmToolNameOf,
  readCommitted,
  sanitizeToolName,
  TARGET_RELPATH,
} from './gen-lm-tools'
import type { ToolDescriptor } from '@harness/a2a-server'

/** 仓库根（`packages/cli/src` → 上三级） */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const EXT_SRC = join(REPO_ROOT, 'adapters/vscode/src/lmtools.ts')

/**
 * 读源码文本并**归一为 LF**。
 *
 * ⚠️ 必须归一：下面几条守卫用 `…/g)\n` 这类**以 `\n` 收尾**的正则去抓文本，而 Windows 上
 * git 可能把文件按 **CRLF** 检出（实际序列是 `\r\n`）⇒ 正则静默失配、`exec` 得 `null`，
 * 报出来却是"命名规则不一致"这种**误导性**结论（CI 实测）。
 */
const readSource = (p: string): string => readFileSync(p, 'utf8').replaceAll('\r\n', '\n')

function descriptor(name: string, over: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    description: `${name} 的说明`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    readOnly: false,
    requiresConfirmation: true,
    ...over,
  }
}

// ========================================================================
// 1. 漂移守卫
// ========================================================================

describe('守卫：已提交的贡献点与现场工具池一致', () => {
  it('`adapters/vscode/package.json` 的 languageModelTools 就是重新生成的那一份', async () => {
    const fresh = await generate()
    const committed = readCommitted(REPO_ROOT)
    // 比对整段（字段顺序也算）—— 顺序变了说明生成器改了，那也是应该被看见的改动
    expect(JSON.stringify(committed, null, 2)).toBe(JSON.stringify(fresh, null, 2))
  })

  it('生成的条目非空且带准确 inputSchema（空 schema = 模型会发 `input: {}`，正是要防的）', async () => {
    const fresh = await generate()
    expect(fresh.length).toBeGreaterThan(0)
    for (const e of fresh) {
      expect(e.name.startsWith(LM_TOOL_PREFIX)).toBe(true)
      expect(e.modelDescription).not.toBe('')
      expect(e.inputSchema).toBeObject()
      expect(e.inputSchema['type']).toBe('object')
      expect(e.canBeReferencedInPrompt).toBe(true)
    }
    // 至少要有几个"必须有 schema"的典型工具
    const names = fresh.map((e) => e.name)
    expect(names).toContain('harness_read_file')
    expect(names).toContain('harness_bash')
    const readFile = fresh.find((e) => e.name === 'harness_read_file')!
    expect(Object.keys(readFile.inputSchema['properties'] as object)).toContain('path')
  })

  it('目标文件存在且是扩展的 package.json（守卫不会对着空文件通过）', () => {
    const text = readFileSync(join(REPO_ROOT, TARGET_RELPATH), 'utf8')
    const pkg = JSON.parse(text) as { name?: string }
    expect(pkg.name).toBe('harness-vscode')
  })
})

// ========================================================================
// 2. 跨包逐字守卫（命名规则两份，必须同源）
// ========================================================================

describe('守卫：命名规则与扩展侧逐字一致', () => {
  const extSrc = readSource(EXT_SRC)

  it('LM_TOOL_PREFIX 与 `lmtools.ts` 相同', () => {
    const m = /export const LM_TOOL_PREFIX = '([^']*)'/.exec(extSrc)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(LM_TOOL_PREFIX)
  })

  it('净化用的两个正则与 `lmtools.ts` 逐字相同', () => {
    // 扩展侧写的是 `const NAME_SAFE_RE = /.../g`，这里按字面取出（不做 eval —— 只比文本）
    const safe = /const NAME_SAFE_RE = (\/.*?\/g)\n/.exec(extSrc)
    const trim = /const NAME_TRIM_RE = (\/.*?\/g)\n/.exec(extSrc)
    expect(safe).not.toBeNull()
    expect(trim).not.toBeNull()
    expect(safe![1]).toBe('/[^A-Za-z0-9_-]+/g')
    expect(trim![1]).toBe('/^_+|_+$/g')
  })

  it('同一批刁钻名字两侧算出**同一个** LM 工具名（这才是守卫真正要保的性质）', () => {
    // 左侧期望值 = 扩展侧的规则（正则已在上面钉住），这里用生成器实现跑一遍
    const cases: Array<[string, string]> = [
      ['read_file', 'harness_read_file'],
      ['mcp__my server__do:it', 'harness_mcp__my_server__do_it'],
      ['  tool  ', 'harness_tool'],
      ['a-b_c', 'harness_a-b_c'],
    ]
    for (const [input, expected] of cases) expect(lmToolNameOf(input)).toBe(expected)
  })
})

// ========================================================================
// 3. 纯函数
// ========================================================================

describe('描述符 → 贡献点', () => {
  it('字段映射：名字加前缀、tag 固定、显示名切词、描述直出、schema 直出', () => {
    const [e] = buildContributions([descriptor('read_file', { description: '读取文件' })])
    expect(e).toEqual({
      name: 'harness_read_file',
      tags: ['harness'],
      toolReferenceName: 'read_file',
      displayName: 'Read File',
      modelDescription: '读取文件',
      canBeReferencedInPrompt: true,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    })
  })

  it('显示名把双下划线也切成人话', () => {
    expect(displayNameOf('mcp__code-intel__code_symbols')).toBe('Mcp Code Intel Code Symbols')
    expect(displayNameOf('bash')).toBe('Bash')
  })

  it('按 LM 工具名排序（顺序稳定 ⇒ diff 不会因注册顺序抖动）', () => {
    const out = buildContributions([descriptor('zeta_tool'), descriptor('alpha_tool')])
    expect(out.map((e) => e.name)).toEqual(['harness_alpha_tool', 'harness_zeta_tool'])
  })

  it('净化后为空 ⇒ **硬失败**（不写出一份没有名字的清单）', () => {
    expect(() => buildContributions([descriptor('中文工具名')])).toThrow(/净化后为空/)
  })

  it('净化后撞名 ⇒ **硬失败**（同一份清单里 name 重复是非法的，且报错极难定位）', () => {
    expect(() => buildContributions([descriptor('a b'), descriptor('a:b')])).toThrow(/归一化后同名/)
  })
})

describe('写回 package.json', () => {
  it('只多出 languageModelTools 一段，其余逐字不变（往返保真）', () => {
    const text = readFileSync(join(REPO_ROOT, TARGET_RELPATH), 'utf8')
    const entries = [{ name: 'harness_x', tags: ['harness'] }] as never
    const out = applyContribution(text, entries)

    const before = JSON.parse(text) as Record<string, unknown>
    const after = JSON.parse(out) as { contributes: Record<string, unknown> }
    // 除了新键，其余完全一致
    const { contributes: cb, ...restBefore } = before as { contributes: Record<string, unknown> }
    const { contributes: ca, ...restAfter } = after
    expect(restAfter).toEqual(restBefore)
    const { languageModelTools: _drop, ...cbRest } = cb
    expect(ca).toEqual({ ...cbRest, languageModelTools: entries })
    // 末尾换行（与仓库里其它 JSON 一致）
    expect(out.endsWith('}\n')).toBe(true)
  })

  it('没有 contributes 段时也能写（不假设文件形状）', () => {
    expect(JSON.parse(applyContribution('{"name":"x"}', [] as never))).toEqual({
      name: 'x',
      contributes: { languageModelTools: [] },
    })
  })
})

describe('密封取源', () => {
  it('读的是**默认装配**而不是开发机上的个人 config（临时 dataDir + mock provider）', async () => {
    const a = await collectDescriptors()
    const b = await collectDescriptors()
    // 两次独立启动结果完全一致 ⇒ 确定性，不受个人 config / 启动时机影响
    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name))
    // 默认池里不该出现"某个人的私有 MCP server 工具"
    for (const t of a) expect(t.name.startsWith('mcp__')).toBe(false)
  })
})

describe('sanitizeToolName', () => {
  it('常规与边界', () => {
    expect(sanitizeToolName('read_file')).toBe('read_file')
    expect(sanitizeToolName('  x  ')).toBe('x')
    expect(sanitizeToolName('a b')).toBe('a_b')
    expect(sanitizeToolName('...')).toBe('')
    expect(sanitizeToolName('中文名')).toBe('')
  })
})
