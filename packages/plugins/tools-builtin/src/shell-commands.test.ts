import { describe, it, expect } from 'bun:test'

import {
  CROSS_DIALECT_COMMANDS,
  CMD_READONLY_COMMANDS,
  DEFAULT_READONLY_COMMANDS,
  POWERSHELL_READONLY_COMMANDS,
  AST_REVIEW_DIALECTS,
  allowlistNamesFor,
  checkReadOnlyCommand,
  dialectStructurePatterns,
  isCommandAllowed,
  normalizeCommandName,
  readonlyCommandsFor,
  splitSegments,
  tokenLikePaths,
} from './index'

// ===== P1-1：跨方言命令身份 =====
//
// 这一组的价值在于**同一条断言在两种方言下结论不同** —— 只断言 PS 侧的话，
// 一个"两边都写死"的实现也能全绿。所以每条 PS/CMD 用例都配一条 bash 侧的反例。

describe('P1-1 normalizeCommandName：bash 敏感、PS/CMD 折叠', () => {
  it('bash 不折叠（`LS` 与 `ls` 是两个东西）', () => {
    expect(normalizeCommandName('LS', 'bash')).toBe('LS')
    expect(normalizeCommandName('ls', 'bash')).toBe('ls')
  })

  it('PowerShell / CMD 折叠（`DIR` == `dir`）', () => {
    expect(normalizeCommandName('DIR', 'cmd')).toBe('dir')
    expect(normalizeCommandName('Get-ChildItem', 'powershell')).toBe('get-childitem')
  })
})

describe('P1-1 allowlistNamesFor：把白名单条目翻译到目标方言', () => {
  it('bash：原名（不做任何翻译）', () => {
    expect(allowlistNamesFor('ls', 'bash')).toEqual(['ls'])
  })

  it('PowerShell：`ls` ⇒ cmdlet + 内建别名', () => {
    const names = allowlistNamesFor('ls', 'powershell')
    expect(names).toContain('get-childitem')
    expect(names).toContain('gci')
    expect(names).toContain('dir')
  })

  it('CMD：`ls` ⇒ `dir`；`cat` ⇒ `type`；`grep` ⇒ `findstr`', () => {
    expect(allowlistNamesFor('ls', 'cmd')).toEqual(['dir'])
    expect(allowlistNamesFor('cat', 'cmd')).toContain('type')
    expect(allowlistNamesFor('grep', 'cmd')).toContain('findstr')
  })

  it('用户直接写方言名 ⇒ 逐字生效（不必先查等价表）', () => {
    expect(allowlistNamesFor('Get-ChildItem', 'powershell')).toContain('get-childitem')
    expect(allowlistNamesFor('dir', 'cmd')).toContain('dir')
  })

  it('★未命中映射 ⇒ 只返回条目本身（fail-closed 的来源）', () => {
    // `git` 在 PS 里没有等价物 ⇒ PS 下 `git status` 不会被 `allowlist: ['ls']` 放行
    expect(allowlistNamesFor('git', 'powershell')).toEqual(['git'])
  })

  it('★写操作**刻意不映射**：`rm` 在 PS 下不会自动变成 `Remove-Item`', () => {
    // 纪律 3：`rm -rf` 与 `Remove-Item -Recurse -Force` 风险面不同，自动放大超出用户原意。
    expect(allowlistNamesFor('rm', 'powershell')).toEqual(['rm'])
    expect(allowlistNamesFor('rm', 'cmd')).toEqual(['rm'])
    expect(allowlistNamesFor('cp', 'powershell')).toEqual(['cp'])
    expect(allowlistNamesFor('mv', 'cmd')).toEqual(['mv'])
  })
})

describe('P1-1 isCommandAllowed：判定（翻译只用于判定，返回布尔）', () => {
  it('bash：`ls` 命中 `[\'ls\']`，`LS` **不**命中（大小写敏感）', () => {
    expect(isCommandAllowed('ls', ['ls'], 'bash')).toBe(true)
    expect(isCommandAllowed('LS', ['ls'], 'bash')).toBe(false)
  })

  it('★PowerShell：`ls` 的白名单条目能认 `Get-ChildItem` / `gci` / `dir`（大小写也不敏感）', () => {
    for (const c of ['Get-ChildItem', 'get-childitem', 'GCI', 'dir', 'ls']) {
      expect(isCommandAllowed(c, ['ls'], 'powershell')).toBe(true)
    }
  })

  it('★CMD：`ls` 的白名单条目能认 `dir` / `DIR`', () => {
    expect(isCommandAllowed('dir', ['ls'], 'cmd')).toBe(true)
    expect(isCommandAllowed('DIR', ['ls'], 'cmd')).toBe(true)
  })

  it('★fail-closed：不在映射覆盖面内的一律拒绝', () => {
    expect(isCommandAllowed('Remove-Item', ['ls'], 'powershell')).toBe(false)
    expect(isCommandAllowed('rm', ['ls'], 'powershell')).toBe(false)
    expect(isCommandAllowed('del', ['ls'], 'cmd')).toBe(false)
    expect(isCommandAllowed('', ['ls'], 'cmd')).toBe(false)
  })
})

// ===== P1-2：只读集与结构门 =====

describe('P1-2 readonlyCommandsFor：只读集按方言切换', () => {
  it('bash ⇒ 调用方给的默认集（既有行为不变）', () => {
    expect(readonlyCommandsFor('bash', DEFAULT_READONLY_COMMANDS)).toBe(DEFAULT_READONLY_COMMANDS)
  })

  it('PowerShell / CMD ⇒ 各自的集', () => {
    expect(readonlyCommandsFor('powershell', DEFAULT_READONLY_COMMANDS)).toBe(POWERSHELL_READONLY_COMMANDS)
    expect(readonlyCommandsFor('cmd', DEFAULT_READONLY_COMMANDS)).toBe(CMD_READONLY_COMMANDS)
  })

  it('★不混用：PS 集里没有 bash 专属名，bash 集里没有 cmdlet 名', () => {
    expect(POWERSHELL_READONLY_COMMANDS).not.toContain('sed')
    expect(POWERSHELL_READONLY_COMMANDS).not.toContain('awk')
    expect(DEFAULT_READONLY_COMMANDS).not.toContain('get-childitem')
  })

  it('★PS 集排除"能执行代码的参数型 cmdlet"（与 POSIX 侧排除 xargs 同理）', () => {
    for (const forbidden of ['foreach-object', 'invoke-expression', 'iex', 'invoke-command', 'start-process', 'add-type', 'new-object', 'measure-command']) {
      expect(POWERSHELL_READONLY_COMMANDS as readonly string[]).not.toContain(forbidden)
    }
  })

  it('★PS 集排除写类 cmdlet', () => {
    for (const forbidden of ['set-content', 'add-content', 'out-file', 'tee-object', 'remove-item', 'new-item', 'export-csv']) {
      expect(POWERSHELL_READONLY_COMMANDS as readonly string[]).not.toContain(forbidden)
    }
  })

  it('★CMD 集排除间接执行主力与写命令', () => {
    for (const forbidden of ['for', 'call', 'start', 'cmd', 'powershell', 'del', 'rd', 'copy', 'move', 'ren', 'reg', 'wmic', 'date', 'set']) {
      expect(CMD_READONLY_COMMANDS as readonly string[]).not.toContain(forbidden)
    }
  })
})

describe('P1-3 AST_REVIEW_DIALECTS：只有 bash 有第二道门', () => {
  it('★常量钉住"PS / CMD 不做语法树复核"这条结论', () => {
    expect(AST_REVIEW_DIALECTS).toEqual(['bash'])
    expect(AST_REVIEW_DIALECTS).not.toContain('powershell')
    expect(AST_REVIEW_DIALECTS).not.toContain('cmd')
  })
})

describe('P1-2 PS 结构门：脚本块 / 调用运算符 / here-string / .NET 写', () => {
  const hit = (cmd: string) =>
    dialectStructurePatterns('powershell').some((p) => p.re.test(cmd))
  const miss = (cmd: string) => expect(hit(cmd)).toBe(false)

  it('★脚本块 `{ }` 被拦 —— `Where-Object { Remove-Item x }` 是合法 PS 且真的会执行', () => {
    expect(hit('Where-Object { Remove-Item x }')).toBe(true)
    expect(hit('Get-ChildItem | Where-Object { $_.Length -gt 100 }')).toBe(true)
  })

  it('★调用运算符 `&` 被拦；`2>&1` / `&&` **不**误伤', () => {
    expect(hit('& $cmd')).toBe(true)
    expect(hit("Get-Item x & 'C:\\tmp\\evil.exe'")).toBe(true)
    miss('Get-Content a.txt 2>&1')
    miss('Get-ChildItem && Get-Item y')
  })

  it('★here-string `@"…"@` 被拦', () => {
    expect(hit('@"\nWrite-Host hi\n"@')).toBe(true)
  })

  it('★.NET 静态**写**调用被拦；纯计算**不**误伤（反例）', () => {
    expect(hit("[System.IO.File]::WriteAllText('x','y')")).toBe(true)
    expect(hit('[System.IO.Directory]::Delete($p)')).toBe(true)
    miss('[math]::Round(1.5)')
    miss("[string]::Join(',', $a)")
  })

  it('bash 侧这一组为空（它的门在 index.ts 里，且另有 AST 复核）', () => {
    expect(dialectStructurePatterns('bash')).toEqual([])
  })
})

describe('P1-2 CMD 结构门：只挡已知可执行的系统变量展开', () => {
  const hit = (cmd: string) => dialectStructurePatterns('cmd').some((p) => p.re.test(cmd))

  it('★`%COMSPEC%` 被拦（`%COMSPEC% /c …` 是间接执行）', () => {
    expect(hit('%COMSPEC% /c dir')).toBe(true)
    expect(hit('%comspec% /c dir')).toBe(true)
  })

  it('★`echo %PATH%` 这类常见只读用法**不**误伤（全禁 % 会大面积误伤）', () => {
    expect(hit('echo %PATH%')).toBe(false)
    expect(hit('dir %TEMP%')).toBe(false)
  })
})

// ===== P1-2 集成：checkReadOnlyCommand 按方言判定 =====

describe('P1-2 checkReadOnlyCommand：按方言选只读集 + 翻译白名单', () => {
  const ps = (cmd: string) => checkReadOnlyCommand(cmd, POWERSHELL_READONLY_COMMANDS, 'powershell')
  const cmdOf = (cmd: string) => checkReadOnlyCommand(cmd, CMD_READONLY_COMMANDS, 'cmd')
  const bash = (cmd: string) => checkReadOnlyCommand(cmd, DEFAULT_READONLY_COMMANDS, 'bash')

  it('bash 侧行为不变：`ls -la` 放行、`LS` 拒绝', () => {
    expect(bash('ls -la').ok).toBe(true)
    expect(bash('LS -la').ok).toBe(false)
  })

  it('★PowerShell：cmdlet 名与别名都放行（此前整片拒绝）', () => {
    expect(ps('Get-ChildItem .').ok).toBe(true)
    expect(ps('ls -Force').ok).toBe(true)
    expect(ps('Get-ChildItem | Select-String foo').ok).toBe(true)
    expect(ps('where-object').ok).toBe(true)
  })

  it('★PowerShell：写类 cmdlet 拒绝（不在只读集里，fail-closed）', () => {
    const v = ps('Remove-Item x -Recurse')
    expect(v.ok).toBe(false)
    // 拒绝文案里回显的是**原样大小写**的首命令名（便于模型对上自己写的那条）
    expect(v.ok === false && v.reason.toLowerCase()).toContain('remove-item')
  })

  it('★PowerShell：脚本块即使挂在白名单 cmdlet 上也被拒（两道门取交集）', () => {
    expect(ps('Where-Object { Remove-Item x }').ok).toBe(false)
  })

  it('★PowerShell：调用运算符被拒', () => {
    expect(ps("& 'C:\\tmp\\x.exe'").ok).toBe(false)
  })

  it('★PowerShell：重定向仍被拦（`2>&1` 例外保持）', () => {
    expect(ps('Get-Content a.txt > b.txt').ok).toBe(false)
    expect(ps('Get-Content a.txt 2>&1').ok).toBe(true)
  })

  it('★PowerShell：反引号是**转义符**不是命令替换 ⇒ 不误伤（bash 侧同一串要拒）', () => {
    // PS：`` ` `` 转义空格，合法写法
    expect(ps('Get-Content "a` b.txt"').ok).toBe(true)
    // bash：反引号是命令替换
    expect(bash('Get-Content "a` whoami`"').ok).toBe(false)
  })

  it('★CMD：`dir /s` 放行；`del /f /s /q` 拒绝', () => {
    expect(cmdOf('dir /s /b').ok).toBe(true)
    expect(cmdOf('findstr /s foo *.txt').ok).toBe(true)
    expect(cmdOf('del /f /s /q x').ok).toBe(false)
    expect(cmdOf('dir & del /f /s /q x').ok).toBe(false)
  })

  it('★CMD：大写内部命令放行（大小写折叠）', () => {
    expect(cmdOf('DIR').ok).toBe(true)
  })
})

describe('P1-2 splitSegments：PS 的 `&` 是调用运算符（不切段）', () => {
  it('cmd / bash：单个 `&` 切段（既有语义）', () => {
    expect(splitSegments('echo a & echo b', 'cmd')).toHaveLength(2)
    expect(splitSegments('echo a & echo b', 'bash')).toHaveLength(2)
  })

  it('★PowerShell：单个 `&` **不**切段（由结构门单独拦）', () => {
    expect(splitSegments('Get-ChildItem & Remove-Item x', 'powershell')).toHaveLength(1)
  })
})

// ===== P1-3：非 AST 方言的敏感路径文本级扫描 =====

describe('P1-3 tokenLikePaths：无 AST 时的保守近似', () => {
  it('提出形似路径的 token（含分隔符 / 点开头带扩展名）', () => {
    expect(tokenLikePaths('Get-Content .env', 'powershell')).toContain('.env')
    expect(tokenLikePaths("Get-Content -Path 'a/b.txt'", 'powershell')).toContain('a/b.txt')
    expect(tokenLikePaths('type .ssh\\id_rsa', 'cmd')).toContain('.ssh\\id_rsa')
  })

  it('普通参数不误提', () => {
    expect(tokenLikePaths('Get-ChildItem -Recurse -Force', 'powershell')).toEqual([])
    expect(tokenLikePaths('dir /s /b', 'cmd')).toEqual([])
  })

  it('★口径说明：这是**保守近似**（`-Pattern` 里形似路径的值会被误当路径）', () => {
    // 误拒是可接受的代价（模型换个写法即可）；漏放则意味着 `Get-Content .env` 在 PS 上读走凭据。
    expect(tokenLikePaths("Select-String -Pattern '.env' x.txt", 'powershell')).toContain('.env')
  })
})

// ===== 等价表本身的守卫 =====

describe('P1-1 等价表守卫', () => {
  it('每条 posix 名唯一（重复会让翻译结果取决于查找顺序）', () => {
    const names = CROSS_DIALECT_COMMANDS.map((e) => e.posix)
    expect(new Set(names).size).toBe(names.length)
  })

  it('★表里**只有只读类**：写命令一个都不许进（纪律 3）', () => {
    const writeish = ['rm', 'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'tee', 'dd', 'truncate']
    for (const w of writeish) {
      expect(CROSS_DIALECT_COMMANDS.map((e) => e.posix)).not.toContain(w)
    }
  })

  it('没有空的等价项（两边都空 ⇒ 该条目毫无意义，等于写错）', () => {
    for (const e of CROSS_DIALECT_COMMANDS) {
      expect(e.powershell.length + e.cmd.length).toBeGreaterThan(0)
    }
  })
})
