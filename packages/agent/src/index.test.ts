import { describe, it, expect } from 'bun:test'
import { parseFrontmatter, agentFromMarkdown } from './index'

// ===== parseFrontmatter 测试 =====

describe('parseFrontmatter', () => {
  it('解析带 frontmatter 的 Markdown', () => {
    const content = `---
id: coder
name: Coder
mode: subagent
tools:
  - read_file
  - write_file
  - bash
---

你是一个专注写代码的子 Agent。`
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.id).toBe('coder')
    expect(frontmatter.name).toBe('Coder')
    expect(frontmatter.mode).toBe('subagent')
    expect(frontmatter.tools).toEqual(['read_file', 'write_file', 'bash'])
    expect(body.trim()).toBe('你是一个专注写代码的子 Agent。')
  })

  it('无 frontmatter 时返回空对象 + 原文 body', () => {
    const content = '这是一段纯文本'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe('这是一段纯文本')
  })

  it('解析标量类型：字符串/数字/布尔值/null', () => {
    const content = `---
name: "Coder"
count: 42
ratio: 3.14
enabled: true
disabled: false
empty: null
---`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.name).toBe('Coder')
    expect(frontmatter.count).toBe(42)
    expect(frontmatter.ratio).toBe(3.14)
    expect(frontmatter.enabled).toBe(true)
    expect(frontmatter.disabled).toBe(false)
    expect(frontmatter.empty).toBeUndefined()
  })

  it('解析内联列表 [a, b, c]', () => {
    const content = `---
tags: [coding, impl, backend]
---`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.tags).toEqual(['coding', 'impl', 'backend'])
  })

  it('解析嵌套对象（permission 配置）', () => {
    const content = `---
permission:
  read: allow
  write: ask
  bash: deny
  '*': ask
---`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.permission).toEqual({
      read: 'allow',
      write: 'ask',
      bash: 'deny',
      '*': 'ask',
    })
  })

  it('解析嵌套对象（model 配置）', () => {
    const content = `---
model:
  providerId: openai
  modelId: gpt-4o
  temperature: 0.7
---`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.model).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4o',
      temperature: 0.7,
    })
  })

  it('跳过注释行', () => {
    const content = `---
# 这是注释
id: coder
name: Coder
---`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.id).toBe('coder')
    expect(frontmatter.name).toBe('Coder')
  })
})

// ===== agentFromMarkdown 测试 =====

describe('agentFromMarkdown', () => {
  it('完整配置：frontmatter + body → AgentDefinition', () => {
    const content = `---
id: coder
name: Coder
description: 负责写代码的子 Agent
mode: subagent
tools:
  - read_file
  - write_file
  - bash
permission:
  '*': allow
model:
  providerId: openai
  modelId: gpt-4o
tags:
  - coding
  - impl
---

你是一个专注写代码的子 Agent，只完成分配给你的任务。
遵循项目的代码规范和最佳实践。`
    const def = agentFromMarkdown(content)

    expect(def.id).toBe('coder')
    expect(def.name).toBe('Coder')
    expect(def.description).toBe('负责写代码的子 Agent')
    expect(def.mode).toBe('subagent')
    expect(def.tools).toEqual(['read_file', 'write_file', 'bash'])
    expect(def.permission).toEqual({ '*': 'allow' })
    expect(def.model).toEqual({ providerId: 'openai', modelId: 'gpt-4o', temperature: undefined })
    expect(def.tags).toEqual(['coding', 'impl'])
    expect(def.promptFragments).toHaveLength(1)
    expect(def.promptFragments![0]).toInclude('你是一个专注写代码的子 Agent')
  })

  it('简写 permission: allow', () => {
    const content = `---
id: explorer
name: Explorer
description: 探索 Agent
permission: allow
---`
    const def = agentFromMarkdown(content)
    expect(def.permission).toEqual({ '*': 'allow' })
  })

  it('简写 permission: deny', () => {
    const content = `---
id: restricted
name: Restricted
description: 受限 Agent
permission: deny
---`
    const def = agentFromMarkdown(content)
    expect(def.permission).toEqual({ '*': 'deny' })
  })

  it('tools: "*" → ["*"]', () => {
    const content = `---
id: general
name: General
description: 通用 Agent
tools: "*"
---`
    const def = agentFromMarkdown(content)
    expect(def.tools).toEqual(['*'])
  })

  it('无 frontmatter.id 时用 fallbackId（文件名）', () => {
    const content = `---
name: Custom Agent
description: 自定义
---`
    const def = agentFromMarkdown(content, 'custom-agent')
    expect(def.id).toBe('custom-agent')
    expect(def.name).toBe('Custom Agent')
  })

  it('无 frontmatter.id 且无 fallbackId 时抛错', () => {
    const content = `---
name: No ID
description: 无 ID
---`
    expect(() => agentFromMarkdown(content)).toThrow('缺少 id')
  })

  it('缺 mode 时默认 subagent', () => {
    const content = `---
id: coder
name: Coder
description: 子 Agent
---`
    const def = agentFromMarkdown(content)
    expect(def.mode).toBe('subagent')
  })

  it('缺 permission 时默认 { "*": "ask" }', () => {
    const content = `---
id: coder
name: Coder
description: 子 Agent
---`
    const def = agentFromMarkdown(content)
    expect(def.permission).toEqual({ '*': 'ask' })
  })

  it('无 body 时不设 promptFragments', () => {
    const content = `---
id: coder
name: Coder
description: 子 Agent
---`
    const def = agentFromMarkdown(content)
    expect(def.promptFragments).toBeUndefined()
  })

  it('mode: primary → 主 Agent', () => {
    const content = `---
id: primary
name: Primary
description: 主 Agent
mode: primary
tools: "*"
---`
    const def = agentFromMarkdown(content)
    expect(def.mode).toBe('primary')
    expect(def.tools).toEqual(['*'])
  })

  it('subagents 列表', () => {
    const content = `---
id: coordinator
name: Coordinator
description: 调度 Agent
mode: coordinator
subagents:
  - coder
  - reviewer
  - explorer
---`
    const def = agentFromMarkdown(content)
    expect(def.subagents).toEqual(['coder', 'reviewer', 'explorer'])
  })

  it('icon 和 skills 字段', () => {
    const content = `---
id: coder
name: Coder
description: 子 Agent
icon: code
skills:
  - refactor
  - debug
---`
    const def = agentFromMarkdown(content)
    expect(def.icon).toBe('code')
    expect(def.skills).toEqual(['refactor', 'debug'])
  })
})
