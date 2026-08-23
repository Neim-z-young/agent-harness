import { describe, it, expect } from 'bun:test'
import {
  skillFromMarkdown,
  createSkillManager,
  formatSkillForPrompt,
  type Skill,
  type SkillSource,
} from './index'

// ===== skillFromMarkdown 测试 =====

describe('skillFromMarkdown', () => {
  it('完整 frontmatter + body → Skill', () => {
    const content = `---
name: git-workflow
description: Git 工作流技能
paths:
  - "**/*.ts"
  - "**/*.tsx"
allowedTools:
  - bash
  - read_file
model: claude-sonnet
effort: medium
---

# Git 工作流

当用户要求提交代码时，遵循以下步骤：
1. 检查 git status
2. 运行测试
3. 提交代码`
    const skill = skillFromMarkdown(content, 'fallback', 'project')

    expect(skill.id).toBe('fallback')
    expect(skill.name).toBe('git-workflow')
    expect(skill.description).toBe('Git 工作流技能')
    expect(skill.loadedFrom).toBe('project')
    expect(skill.paths).toEqual(['**/*.ts', '**/*.tsx'])
    expect(skill.allowedTools).toEqual(['bash', 'read_file'])
    expect(skill.model).toBe('claude-sonnet')
    expect(skill.effort).toBe('medium')
    expect(skill.userInvocable).toBe(true)
    expect(skill.allowEmbedShell).toBe(true)
    expect(skill.content).toInclude('# Git 工作流')
    expect(skill.content).toInclude('检查 git status')
  })

  it('无 frontmatter.name 时用 fallbackId', () => {
    const content = `---
description: 测试技能
---
body`
    const skill = skillFromMarkdown(content, 'my-skill', 'project')
    expect(skill.id).toBe('my-skill')
    expect(skill.name).toBe('my-skill')
  })

  it('无 frontmatter 时全部用 fallbackId 和默认值', () => {
    const content = '这是一段纯正文'
    const skill = skillFromMarkdown(content, 'plain', 'project')
    expect(skill.id).toBe('plain')
    expect(skill.name).toBe('plain')
    expect(skill.description).toBe('')
    expect(skill.content).toBe('这是一段纯正文')
    expect(skill.paths).toBeUndefined()
    expect(skill.userInvocable).toBe(true)
  })

  it('MCP 来源强制 allowEmbedShell = false', () => {
    const content = `---
name: mcp-skill
allowEmbedShell: true
---
body`
    const skill = skillFromMarkdown(content, 'mcp-skill', 'mcp')
    expect(skill.allowEmbedShell).toBe(false)
    expect(skill.loadedFrom).toBe('mcp')
  })

  it('非 MCP 来源 allowEmbedShell 默认 true', () => {
    const content = `---
name: project-skill
---
body`
    const skill = skillFromMarkdown(content, 'project-skill', 'project')
    expect(skill.allowEmbedShell).toBe(true)
  })

  it('userInvocable: false → 不可见', () => {
    const content = `---
name: hidden
userInvocable: false
---
body`
    const skill = skillFromMarkdown(content, 'hidden', 'project')
    expect(skill.userInvocable).toBe(false)
  })

  it('agentBind 绑定特定 Agent', () => {
    const content = `---
name: coder-skill
agentBind:
  - coder
  - reviewer
---
body`
    const skill = skillFromMarkdown(content, 'coder-skill', 'project')
    expect(skill.agentBind).toEqual(['coder', 'reviewer'])
  })

  it('内嵌资源提取：!`cmd` 和 {{var}}', () => {
    const content = `---
name: embed-test
---
当前分支：!\`git branch --show-current\`
项目目录：{{PROJECT_DIR}}`
    const skill = skillFromMarkdown(content, 'embed-test', 'project')
    expect(skill.embeds).toBeDefined()
    expect(skill.embeds!.length).toBe(2)
    expect(skill.embeds![0]).toEqual({ type: 'shell', source: 'git branch --show-current' })
    expect(skill.embeds![1]).toEqual({ type: 'variable', source: 'PROJECT_DIR' })
  })
})

// ===== SkillManagerImpl 测试 =====

describe('SkillManagerImpl', () => {
  it('register + get + all', () => {
    const mgr = createSkillManager()
    const skill: Skill = {
      id: 'test',
      name: 'Test',
      description: '测试',
      loadedFrom: 'bundled',
      content: 'content',
      userInvocable: true,
      allowEmbedShell: true,
    }
    mgr.register(skill)

    expect(mgr.get('test')).toBeDefined()
    expect(mgr.get('test')!.name).toBe('Test')
    expect(mgr.all()).toHaveLength(1)
  })

  it('filterByAgent：无 agentBind → 所有 Agent 可用', () => {
    const mgr = createSkillManager([{
      id: 'general',
      name: 'General',
      description: '通用',
      loadedFrom: 'bundled',
      content: '',
      userInvocable: true,
      allowEmbedShell: true,
    }])
    expect(mgr.filterByAgent('coder')).toHaveLength(1)
    expect(mgr.filterByAgent('reviewer')).toHaveLength(1)
  })

  it('filterByAgent：有 agentBind → 仅绑定 Agent 可用', () => {
    const mgr = createSkillManager([{
      id: 'coder-only',
      name: 'Coder Only',
      description: '仅 coder',
      loadedFrom: 'bundled',
      content: '',
      userInvocable: true,
      allowEmbedShell: true,
      agentBind: ['coder'],
    }])
    expect(mgr.filterByAgent('coder')).toHaveLength(1)
    expect(mgr.filterByAgent('reviewer')).toHaveLength(0)
  })

  it('matchByPath：glob 匹配 paths', () => {
    const mgr = createSkillManager([
      {
        id: 'ts-skill',
        name: 'TS Skill',
        description: 'TypeScript 技能',
        loadedFrom: 'project',
        content: '',
        userInvocable: true,
        allowEmbedShell: true,
        paths: ['**/*.ts', '**/*.tsx'],
      },
      {
        id: 'py-skill',
        name: 'Python Skill',
        description: 'Python 技能',
        loadedFrom: 'project',
        content: '',
        userInvocable: true,
        allowEmbedShell: true,
        paths: ['**/*.py'],
      },
      {
        id: 'no-paths',
        name: 'No Paths',
        description: '无条件触发',
        loadedFrom: 'project',
        content: '',
        userInvocable: true,
        allowEmbedShell: true,
      },
    ])

    // .ts 文件匹配 ts-skill
    const tsMatch = mgr.matchByPath('src/foo.ts')
    expect(tsMatch).toHaveLength(1)
    expect(tsMatch[0].id).toBe('ts-skill')

    // .tsx 文件匹配 ts-skill
    const tsxMatch = mgr.matchByPath('components/Button.tsx')
    expect(tsxMatch).toHaveLength(1)
    expect(tsxMatch[0].id).toBe('ts-skill')

    // .py 文件匹配 py-skill
    const pyMatch = mgr.matchByPath('scripts/main.py')
    expect(pyMatch).toHaveLength(1)
    expect(pyMatch[0].id).toBe('py-skill')

    // .md 文件不匹配任何
    const mdMatch = mgr.matchByPath('README.md')
    expect(mdMatch).toHaveLength(0)

    // 无 paths 的 Skill 不触发
    expect(mgr.matchByPath('any/file.txt')).toHaveLength(0)
  })

  it('load：从临时目录加载 SKILL.md（目录形式）', async () => {
    // 使用 Bun 的临时目录
    const tmpDir = `/tmp/harness-skill-test-${Date.now()}`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(`${tmpDir}/my-skill`, { recursive: true })
    writeFileSync(`${tmpDir}/my-skill/SKILL.md`, `---
name: My Skill
description: 测试技能
---
这是技能正文`)

    const mgr = createSkillManager()
    const loaded = await mgr.load(tmpDir)

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('my-skill')
    expect(loaded[0].name).toBe('My Skill')
    expect(loaded[0].content).toBe('这是技能正文')
    expect(mgr.get('my-skill')).toBeDefined()
  })

  it('load：从临时目录加载 .md（单文件形式）', async () => {
    const tmpDir = `/tmp/harness-skill-test2-${Date.now()}`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(`${tmpDir}/simple-skill.md`, `---
description: 简单技能
---
简单正文`)

    const mgr = createSkillManager()
    const loaded = await mgr.load(tmpDir)

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('simple-skill')
    expect(loaded[0].name).toBe('simple-skill')
    expect(loaded[0].description).toBe('简单技能')
  })

  it('load：不存在的目录返回空数组', async () => {
    const mgr = createSkillManager()
    const loaded = await mgr.load('/nonexistent/path')
    expect(loaded).toHaveLength(0)
  })

  it('reload：重载已存在的 Skill', async () => {
    const tmpDir = `/tmp/harness-skill-test3-${Date.now()}`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(`${tmpDir}/reload-skill`, { recursive: true })
    writeFileSync(`${tmpDir}/reload-skill/SKILL.md`, `---
name: Reload Skill
---
原始内容`)

    const mgr = createSkillManager()
    await mgr.load(tmpDir)
    expect(mgr.get('reload-skill')!.content).toBe('原始内容')

    // 修改文件后重载
    writeFileSync(`${tmpDir}/reload-skill/SKILL.md`, `---
name: Reload Skill
---
更新后内容`)
    const reloaded = await mgr.reload('reload-skill')
    expect(reloaded!.content).toBe('更新后内容')
  })

  it('多级加载：user → project 顺序，project 覆盖 user（同 ID 后加载覆盖先加载）', async () => {
    const userDir = `/tmp/harness-skill-user-${Date.now()}`
    const projectDir = `/tmp/harness-skill-project-${Date.now() + 1}`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(userDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })

    // user 级定义同名 Skill，但内容是 user 版本
    writeFileSync(`${userDir}/common.md`, `---
name: common
---
这是 user 级 Skill`)

    // project 级覆盖同名 Skill
    writeFileSync(`${projectDir}/common.md`, `---
name: common
---
这是 project 级 Skill`)

    const mgr = createSkillManager()
    // 按 user → project 顺序加载（project 后加载覆盖 user）
    await mgr.load(userDir, 'user')
    await mgr.load(projectDir, 'project')

    const skill = mgr.get('common')!
    expect(skill.loadedFrom).toBe('project')
    expect(skill.content).toBe('这是 project 级 Skill')
  })

  it('sourceTag 缺省为 project', async () => {
    const tmpDir = `/tmp/harness-skill-default-tag-${Date.now()}`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(`${tmpDir}/x.md`, `---
name: x
---
body`)

    const mgr = createSkillManager()
    await mgr.load(tmpDir)
    expect(mgr.get('x')!.loadedFrom).toBe('project')
  })

  it('sourceTag: user 不影响 allowEmbedShell（默认 true）', async () => {
    const tmpDir = `/tmp/harness-skill-user-tag-${Date.now()}`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(`${tmpDir}/u.md`, `---
name: u
---
body`)

    const mgr = createSkillManager()
    await mgr.load(tmpDir, 'user')
    expect(mgr.get('u')!.loadedFrom).toBe('user')
    expect(mgr.get('u')!.allowEmbedShell).toBe(true)
  })
})

// ===== formatSkillForPrompt 测试 =====

describe('formatSkillForPrompt', () => {
  it('格式化为带标题和描述的 prompt 块', () => {
    const skill: Skill = {
      id: 'test',
      name: 'Test Skill',
      description: '测试描述',
      loadedFrom: 'project',
      content: '这是正文',
      userInvocable: true,
      allowEmbedShell: true,
    }
    const formatted = formatSkillForPrompt(skill)
    expect(formatted).toInclude('# Skill: Test Skill')
    expect(formatted).toInclude('> 测试描述')
    expect(formatted).toInclude('这是正文')
  })

  it('无 description 时省略描述行', () => {
    const skill: Skill = {
      id: 'test',
      name: 'Test',
      description: '',
      loadedFrom: 'project',
      content: '正文',
      userInvocable: true,
      allowEmbedShell: true,
    }
    const formatted = formatSkillForPrompt(skill)
    expect(formatted).toInclude('# Skill: Test')
    expect(formatted).not.toInclude('>')
    expect(formatted).toInclude('正文')
  })
})
