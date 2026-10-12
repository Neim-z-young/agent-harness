/**
 * P0-4：**引号方言**解析（`./shell-quoting.ts`）与三层判定的一致性。
 *
 * 为什么单独一个文件：这是"结构投影"的地基 —— 投影算错，重定向/进程替换/heredoc 的判定
 * 就全跟着错（而且错的方向是**漏判**）。所以判据要钉在最底层，而不是只测"某条命令被拒了"。
 *
 * ⚠️ 本机（macOS）**没有 pwsh / powershell**，PowerShell 那一列是按官方语法实现的，
 * **没有跑过真 PowerShell**。这些用例钉的是"我们的投影算法算得对不对"，
 * 不构成"已验证 PS 行为"—— 真机接入 PS 时应先补一次端到端复核（见文件头注释）。
 */
import { describe, it, expect } from 'bun:test'
import {
  buildQuotedMask,
  checkReadOnlyCommand,
  extractFirstCommand,
  projectWithoutQuoted,
  scanQuotedSpans,
  splitSegments,
} from './index'

/** 投影里引号区间被替换成的占位符 */
const P = '""'

describe('scanQuotedSpans · bash（POSIX）', () => {
  it('单引号 / 双引号各自成区间', () => {
    expect(scanQuotedSpans(`echo 'a b' "c d"`, 'bash')).toEqual([
      { start: 5, end: 9, kind: 'single', here: false },
      { start: 11, end: 15, kind: 'double', here: false },
    ])
  })

  it('★双引号内 `\\"` 是转义 ⇒ 不结束字符串（旧实现会在这里提前闭合）', () => {
    const cmd = `echo "a\\"b" ; ls`
    const spans = scanQuotedSpans(cmd, 'bash')
    expect(spans).toHaveLength(1)
    // 整段 `"a\"b"` 是一个区间，于是后面的 `;` 在引号**外**、照常切段
    expect(splitSegments(cmd, 'bash')).toEqual([`echo "a\\"b"`, 'ls'])
  })

  it('单引号内一切字面（`\\` 不起作用）', () => {
    expect(scanQuotedSpans(String.raw`echo 'a\'b'`, 'bash')).toHaveLength(1)
  })

  it('反引号**不是**引号（bash 里是命令替换，另由 SUBSTITUTION_PATTERNS 管）', () => {
    expect(scanQuotedSpans('echo `date` ; ls', 'bash')).toHaveLength(0)
  })
})

describe('scanQuotedSpans · powershell', () => {
  it('★`\'\'` 是转义的字面单引号 ⇒ 不结束字符串（旧实现会在这里提前闭合）', () => {
    const cmd = `Get-ChildItem 'it''s a;test'`
    const spans = scanQuotedSpans(cmd, 'powershell')
    expect(spans).toHaveLength(1)
    // 引号内的 `;` 不该被切段（bash 语义下这里只会切出一个错段）
    expect(splitSegments(cmd, 'powershell')).toEqual([`Get-ChildItem 'it''s a;test'`])
  })

  it('★双引号内反引号是转义 ⇒ `` "a`"b" `` 是一个字符串', () => {
    const cmd = 'echo "a`"b" ; ls'
    expect(scanQuotedSpans(cmd, 'powershell')).toHaveLength(1)
    expect(splitSegments(cmd, 'powershell')).toEqual(['echo "a`"b"', 'ls'])
  })

  it('★here-string：`@"…"@` 可跨行，整体是一个区间', () => {
    const cmd = '@"\nline1;still-line\nline2 & line3\n"@ ; ls'
    const spans = scanQuotedSpans(cmd, 'powershell')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.here).toBe(true)
    // here-string 里的 `;` 与 `&` 都不是分段符
    expect(splitSegments(cmd, 'powershell')).toEqual(['@"\nline1;still-line\nline2 & line3\n"@', 'ls'])
  })

  it('here-string 单引号形态 `@\'…\'@` 同理', () => {
    const cmd = "@'\nnot $expanded; literal\n'@"
    const spans = scanQuotedSpans(cmd, 'powershell')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.kind).toBe('single')
  })
})

describe('scanQuotedSpans · cmd', () => {
  it('★单引号在 CMD 里**不是**引号（`echo \'a;b\'` 的 `;` 照常切）', () => {
    expect(scanQuotedSpans(`echo 'a;b'`, 'cmd')).toHaveLength(0)
    expect(splitSegments(`echo 'a;b'`, 'cmd')).toEqual([`echo 'a`, `b'`])
  })

  it('双引号是引号（无转义）', () => {
    expect(scanQuotedSpans('echo "a;b"', 'cmd')).toHaveLength(1)
    expect(splitSegments('echo "a;b"', 'cmd')).toEqual(['echo "a;b"'])
  })
})

describe('extractFirstCommand：引号块作为命令名（PS here-string / 带引号路径）', () => {
  it('带引号路径 ⇒ 取块内容（去引号）', () => {
    expect(extractFirstCommand(`'C:\\Program Files\\x.exe' -x`, 'powershell')).toBe('C:\\Program Files\\x.exe')
  })

  it('★PS here-string 作为首命令 ⇒ 取块内容（去掉 `@"` 与 `"@`）', () => {
    expect(extractFirstCommand('@"\nWrite-Host hi\n"@', 'powershell')).toBe('\nWrite-Host hi\n')
  })
})

describe('安全取舍：未闭合引号按"裸露"处理（宁可多切一段）', () => {
  it('★未闭合 ⇒ 不产生区间 ⇒ 分隔符照常生效（另一条路会让攻击者用不闭合引号吞掉分隔符）', () => {
    const attack = `curl x " ; rm -rf /tmp`
    expect(scanQuotedSpans(attack, 'bash')).toHaveLength(0)
    expect(splitSegments(attack, 'bash')).toEqual(['curl x "', 'rm -rf /tmp'])
  })

  it('同理适用于 PS 与 CMD', () => {
    expect(splitSegments(`echo " ; ls`, 'powershell')).toEqual(['echo "', 'ls'])
    expect(splitSegments(`echo " ; ls`, 'cmd')).toEqual(['echo "', 'ls'])
  })
})

describe('三层判定共用同一份口径', () => {
  it('投影（projectWithoutQuoted）与切段（splitSegments）对引号边界的判断一致', () => {
    for (const [cmd, dialect, segs] of [
      [`echo 'a;b' ; ls`, 'bash', 2],
      [`Get-ChildItem 'it''s ; x' ; ls`, 'powershell', 2],
      // ⚠️ CMD 里单引号**不是**引号 ⇒ 同一串会切成 3 段（这正说明方言必须被真的用上）
      [`echo 'a;b' ; ls`, 'cmd', 3],
    ] as const) {
      const quotedCount = (c: string): number => c.split(P).length - 1
      // 投影里每个区间产出一个 `""`；切段时区间内的分隔符不得生效
      expect(quotedCount(projectWithoutQuoted(cmd, dialect))).toBe(scanQuotedSpans(cmd, dialect).length)
      expect(splitSegments(cmd, dialect).length).toBe(segs)
    }
  })

  it('buildQuotedMask 覆盖引号字符本身（含起始引号）', () => {
    const cmd = `a 'bc' d` // 0:a 1:空格 2:' 3:b 4:c 5:' 6:空格 7:d
    const mask = buildQuotedMask(cmd, scanQuotedSpans(cmd, 'bash'))
    expect(mask.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([2, 3, 4, 5])
  })
})

describe('checkReadOnlyCommand：方言真的改变判定（不是装饰）', () => {
  it('★同一串在 bash / cmd 下结论不同 —— 证明方言被真的用上了', () => {
    const cmd = `echo 'a;b'`
    expect(checkReadOnlyCommand(cmd, ['echo'], 'bash').ok).toBe(true) // 引号内 `;` 不切
    // CMD 里单引号不是引号 ⇒ 切成 `echo 'a` 与 `b'`，第二段首命令不在白名单
    expect(checkReadOnlyCommand(cmd, ['echo'], 'cmd').ok).toBe(false)
  })

  it('★PS：双单引号（转义写法）让 `;` 留在引号内（旧实现会切成两段、误判为不在白名单）', () => {
    const cmd = `Get-Content 'it''s a;log.txt'`
    expect(checkReadOnlyCommand(cmd, ['Get-Content'], 'powershell').ok).toBe(true)
  })

  it('★PS here-string 里的 `>` 不是写通道（结构投影里它被引号吃掉）', () => {
    const cmd = '@"\nnot > a redirect\n"@'
    const verdict = checkReadOnlyCommand(cmd, ['echo'], 'powershell')
    // here-string 整体是数据 ⇒ 不该因 `>` 报 SANDBOX_RO_REDIRECT
    expect(verdict.ok === false ? verdict.code : '').not.toBe('SANDBOX_RO_REDIRECT')
  })

  it('对照：同一形态在 bash 下 `>` 照旧命中（确认上面的"没命中"来自方言而非规则失效）', () => {
    const verdict = checkReadOnlyCommand(`echo "x" > out.txt`, ['echo'], 'bash')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false ? verdict.code : '').toBe('SANDBOX_RO_REDIRECT')
  })
})
