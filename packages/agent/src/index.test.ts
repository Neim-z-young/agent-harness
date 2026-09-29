import { describe, it, expect } from 'bun:test'
import { parseFrontmatter, agentFromMarkdown, READONLY_TOOLS_SENTINEL } from './index'

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

  it('列表中间的注释行只跳过、不截断列表（回归：曾经静默吞掉后面的项）', () => {
    // 背景：`parseBlock` 的列表分支遇到非 `- ` 开头的行会 **break**，而注释行不匹配 `- `。
    // 后果不是报错而是**静默截断**：frontmatter 是逐字段白名单解析的，列表被砍掉一半后依旧
    // “解析成功”。真实踩到：给 reader.md 的 tools 末尾追加压缩工具时，在中间插了一行说明
    // ⇒ 四个新工具一个都没进白名单，而且没有任何提示。
    const content = `---
id: reader
tools:
  - read_file
  # 压缩类：管的是本会话自己的上下文窗口，不碰文件系统
  - compress
  - decompress
  - acp_status
---`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.tools).toEqual(['read_file', 'compress', 'decompress', 'acp_status'])
  })

  it('内联空数组 `[]` → `[]`（不是 `[""]`）；空内联对象同样（两个解析器的空保护必须对称）', () => {
    // 背景：`''.split(',')` 返回 `['']`，于是 `mcpServers: []` 被解析成 `['']` ——
    // 一个「名字是空字符串的 server」。而 `mcpServers: []` 是有明确契约的写法
    // （空白名单 = 拒绝全部 MCP，见 @harness/tool 的 filterByMcpServers），
    // `['']` 既不是"没有 server"、也匹配不上任何真实 server，且**毫无报错**。
    // 长期没浮出水面是因为下游 `parseStringArr` 有 `.filter(Boolean)` 把它抹平回 `[]`，
    // 但 `parseFrontmatter` 是导出 API，裸输出必须正确。
    // `parseInlineObject` 当初有 `if (!inner) return {}`，两处内联列表调用点漏了同一保护 ——
    // 这里把两侧一起钉住，防止将来只修一边。
    const content = `---
id: reader
tools: [read_file, glob]
mcpServers: []
model: {}
---`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.mcpServers).toEqual([])
    expect(frontmatter.tools).toEqual(['read_file', 'glob']) // 非空内联列表不受影响
    expect(frontmatter.model).toEqual({})
  })

  it('嵌套对象中间的注释行同样只跳过、不截断', () => {
    const content = `---
permission:
  read: allow
  # 写操作一律问
  write: ask
---`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.permission).toEqual({ read: 'allow', write: 'ask' })
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

  // ===== tools 缺省：只读兜底（fail-safe）+ 告警 =====
  // 背景：以前缺省是 []（一个工具都不给），现象是「子 Agent 能派出但什么也干不了」，
  // 且没有任何提示；文档却承诺「tools 缺失抛错」。现在改为只读哨兵 + 显式告警。
  describe('tools 缺省 → 只读哨兵', () => {
    it('未声明 tools → [READONLY_TOOLS_SENTINEL] 并告警', () => {
      const warns: string[] = []
      const def = agentFromMarkdown(`---
id: reviewer
name: Reviewer
mode: subagent
description: 评审
---`, undefined, { onWarn: (m) => warns.push(m) })

      expect(def.tools).toEqual([READONLY_TOOLS_SENTINEL])
      expect(READONLY_TOOLS_SENTINEL).toBe('@readonly')
      expect(warns).toHaveLength(1)
      // 告警要给出可执行的出口，而不只是「有问题」
      expect(warns[0]).toContain('reviewer')
      expect(warns[0]).toContain('tools')
      expect(warns[0]).toContain('写权限')
    })

    it('不传 onWarn 时不抛错（纯函数不依赖日志设施）', () => {
      const def = agentFromMarkdown('---\nid: x\nname: X\n---')
      expect(def.tools).toEqual([READONLY_TOOLS_SENTINEL])
    })

    it('tools: 空字符串 → 视为未声明（只读兜底 + 告警）', () => {
      const warns: string[] = []
      const def = agentFromMarkdown('---\nid: x\nname: X\ntools: ""\n---', undefined, { onWarn: (m) => warns.push(m) })
      expect(def.tools).toEqual([READONLY_TOOLS_SENTINEL])
      expect(warns).toHaveLength(1)
    })

    it('显式 tools: []（block 形式）→ 仍是「一个工具都不给」，不告警', () => {
      const warns: string[] = []
      const def = agentFromMarkdown(`---
id: mute
name: Mute
tools: []
---`, undefined, { onWarn: (m) => warns.push(m) })
      expect(def.tools).toEqual([])
      expect(warns).toEqual([])
    })

    it('tools: readonly / "@readonly" → 哨兵（显式写法，不告警）', () => {
      const warns: string[] = []
      expect(agentFromMarkdown('---\nid: a\nname: A\ntools: readonly\n---', undefined, { onWarn: (m) => warns.push(m) }).tools)
        .toEqual([READONLY_TOOLS_SENTINEL])
      expect(agentFromMarkdown('---\nid: b\nname: B\ntools: "@readonly"\n---', undefined, { onWarn: (m) => warns.push(m) }).tools)
        .toEqual([READONLY_TOOLS_SENTINEL])
      expect(warns).toEqual([])
    })

    it('tools 逗号字符串 → 数组（与 mcpServers 等字段的写法保持一致）', () => {
      const def = agentFromMarkdown('---\nid: a\nname: A\ntools: read_file, bash\n---')
      expect(def.tools).toEqual(['read_file', 'bash'])
    })
  })

  it('mcpServers/excludeMcpServers：块级列表 → 数组', () => {
    const content = `---
id: mcpw
name: McpWhitelist
description: MCP 白名单 Agent
mcpServers:
  - github
  - filesystem
excludeMcpServers:
  - sandbox
---`
    const def = agentFromMarkdown(content)
    expect(def.mcpServers).toEqual(['github', 'filesystem'])
    expect(def.excludeMcpServers).toEqual(['sandbox'])
  })

  it('mcpServers：内联数组与裸逗号字符串 → 数组（含 trim）', () => {
    const inline = `---
id: a
name: A
description: d
mcpServers: [github, filesystem]
---`
    expect(agentFromMarkdown(inline).mcpServers).toEqual(['github', 'filesystem'])
    const csv = `---
id: b
name: B
description: d
mcpServers: github, filesystem
---`
    expect(agentFromMarkdown(csv).mcpServers).toEqual(['github', 'filesystem'])
  })

  it('mcpServers 显式空数组 → []（空白名单=拒绝全部 MCP）', () => {
    const content = `---
id: none
name: None
description: d
mcpServers: []
---`
    expect(agentFromMarkdown(content).mcpServers).toEqual([])
  })

  it('缺省 mcp 字段 → undefined（向后兼容）', () => {
    const content = `---
id: plain
name: Plain
description: d
---`
    const def = agentFromMarkdown(content)
    expect(def.mcpServers).toBeUndefined()
    expect(def.excludeMcpServers).toBeUndefined()
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

  // 已删除字段：`subagents` 历史上有解析、无消费方（配了不生效）。删字段但**保留告警** ——
  // 真实存在这种配置（`~/.harness/agents/coordinator.md` 列了 15 项），静默会让作者继续以为它生效。
  it('subagents 字段已删除：不再映射进定义，但会告警（避免配置静默失效）', () => {
    const warns: string[] = []
    const def = agentFromMarkdown(`---
id: coordinator
name: Coordinator
description: 调度 Agent
mode: coordinator
subagents:
  - coder
  - reviewer
  - explorer
---`, undefined, { onWarn: (m) => warns.push(m) })
    expect((def as unknown as Record<string, unknown>).subagents).toBeUndefined()
    expect(warns.some((w) => w.includes('subagents') && w.includes('3 项'))).toBe(true)
  })

  it('未声明 subagents 时不产生该类告警（不给正常配置添噪音）', () => {
    const warns: string[] = []
    agentFromMarkdown('---\nid: c\nname: C\nmode: subagent\ntools: ["*"]\n---', undefined, {
      onWarn: (m) => warns.push(m),
    })
    expect(warns.filter((w) => w.includes('subagents')).length).toBe(0)
  })

  it('background: true → 默认后台执行声明', () => {
    const content = `---
id: researcher
name: Researcher
description: 调研 Agent
mode: subagent
background: true
---`
    const def = agentFromMarkdown(content)
    expect(def.background).toBe(true)
  })

  it('未声明 background → undefined（默认前台）', () => {
    const content = `---
id: coder
name: Coder
description: 子 Agent
mode: subagent
---`
    const def = agentFromMarkdown(content)
    expect(def.background).toBeUndefined()
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

  it('writesTo: 解析写文件集声明（Coordinator 串行化用）', () => {
    const content = `---
id: coder
name: Coder
description: 实现 Agent
mode: subagent
writesTo:
  - src/
  - package.json
---`
    const def = agentFromMarkdown(content)
    expect(def.writesTo).toEqual(['src/', 'package.json'])
  })

  it('未声明 writesTo → undefined', () => {
    const content = `---
id: coder
name: Coder
description: 子 Agent
mode: subagent
---`
    const def = agentFromMarkdown(content)
    expect(def.writesTo).toBeUndefined()
  })

  // 回归：subagent 插件的 resolveSteps 读 `agent.get(id).maxSteps`，并在文档里写着
  // 「子 Agent 应在自己的 AgentDefinition 里显式写 maxSteps」——但本函数此前从不映射该字段，
  // md 里写它等于没写，所有 md 定义的子 Agent 只能吃插件默认 20（真机 6/6 reader 因此截断）。
  it('maxSteps：从 frontmatter 解析（数字 / 字符串数字），未声明或非法则 undefined', () => {
    const def = agentFromMarkdown(`---
id: reader
name: 速读员
description: 通读回报
mode: subagent
maxSteps: 35
---`)
    expect(def.maxSteps).toBe(35)

    const strDef = agentFromMarkdown(`---
id: reader2
name: R2
description: d
mode: subagent
maxSteps: "40"
---`)
    expect(strDef.maxSteps).toBe(40)

    // -1 = 不限（与 AgentDefinition.maxSteps 语义一致，引擎侧负责转 Infinity）
    const unlimited = agentFromMarkdown(`---
id: reader3
name: R3
description: d
mode: subagent
maxSteps: -1
---`)
    expect(unlimited.maxSteps).toBe(-1)

    const missing = agentFromMarkdown(`---
id: reader4
name: R4
description: d
mode: subagent
---`)
    expect(missing.maxSteps).toBeUndefined()

    const bad = agentFromMarkdown(`---
id: reader5
name: R5
description: d
mode: subagent
maxSteps: 很多
---`)
    expect(bad.maxSteps).toBeUndefined()
  })

  // 回归：`maxSteps: 0` 此前会被原样带进定义，引擎再用 `Math.max(1, 0)` 静默抬成「1 步」——
  // 子 Agent 跑一步就收尾，现象像「任务太小 / 模型不肯干活」，与「配置写错」完全对不上。
  // 现在解析处就判定为非法：视为未声明 + 告警。`< -1` 同理（合法负数只有 `-1` = 不限）。
  it('maxSteps：0 / < -1 视为非法（视为未声明 + 告警），不静默抬成 1 步', () => {
    const zeroWarns: string[] = []
    const zero = agentFromMarkdown(`---
id: reader6
name: R6
description: d
mode: subagent
maxSteps: 0
---`, undefined, { onWarn: (m) => zeroWarns.push(m) })
    expect(zero.maxSteps).toBeUndefined()
    expect(zeroWarns.some((w) => w.includes('maxSteps') && w.includes('无效'))).toBe(true)

    const negWarns: string[] = []
    const neg = agentFromMarkdown(`---
id: reader7
name: R7
description: d
mode: subagent
maxSteps: -2
---`, undefined, { onWarn: (m) => negWarns.push(m) })
    expect(neg.maxSteps).toBeUndefined()
    expect(negWarns.some((w) => w.includes('maxSteps'))).toBe(true)

    // 边界：1（显式单轮）与 -1（不限）是合法值，不得被误判
    expect(agentFromMarkdown('---\nid: r8\nname: R8\nmode: subagent\nmaxSteps: 1\n---').maxSteps).toBe(1)
    expect(agentFromMarkdown('---\nid: r9\nname: R9\nmode: subagent\nmaxSteps: -1\n---').maxSteps).toBe(-1)

    // 未声明不告警
    const noneWarns: string[] = []
    agentFromMarkdown('---\nid: r10\nname: R10\nmode: subagent\ntools: ["*"]\n---', undefined, {
      onWarn: (m) => noneWarns.push(m),
    })
    expect(noneWarns.filter((w) => w.includes('maxSteps')).length).toBe(0)
  })
})
