/**
 * 从插件目录的 prompts/*.txt 加载 ACP 默认提示词（t1/t2/t3 与压缩哲学）。
 *
 * 这些 txt 是 acp-kernel 内置 defaultPrompts 的原始内容复制，用户可直接编辑本地文件定制。
 * 加载失败（如打包后 dist 未携带 txt）时回退到 acp-kernel 的 defaultPrompts。
 * 返回的 Prompts 作为「文件默认」，config 传入的 prompts 覆盖在其上合并。
 */

import { readFileSync } from 'node:fs'
import type { Prompts } from 'acp-kernel'
import { defaultPrompts } from 'acp-kernel'

const FILES = {
  compressPhilosophy: 'compressPhilosophy.txt',
  howToCompressRules: 'howToCompressRules.txt',
  tier2DistillRules: 'tier2DistillRules.txt',
  tier3CondenseRules: 'tier3CondenseRules.txt',
} as const

type PromptKey = keyof typeof FILES

function readPrompt(key: PromptKey): string | undefined {
  try {
    return readFileSync(new URL(`../prompts/${FILES[key]}`, import.meta.url), 'utf-8')
  } catch {
    return undefined
  }
}

/** 加载文件默认提示词；任一文件缺失则该项回退内核默认，全部失败才整体回退。 */
export function loadPromptFiles(): Prompts {
  const out: Prompts = { ...defaultPrompts }
  let any = false
  for (const key of Object.keys(FILES) as PromptKey[]) {
    const text = readPrompt(key)
    if (text !== undefined) {
      out[key] = text
      any = true
    }
  }
  return any ? out : defaultPrompts
}