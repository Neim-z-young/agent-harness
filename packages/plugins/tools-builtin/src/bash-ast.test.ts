import { describe, expect, it } from 'bun:test'
import { analyzeBashCommand, OPAQUE } from './bash-ast'

/**
 * bash 命令 AST 分析的 L1 纯函数单测。
 *
 * 用例来源：2026-09-30 调研报告的「字符匹配可绕过面」清单 —— 每一类绕过手法
 * 必须能被结构化事实看清（解码字面量 / 展开标记 / 嵌套命令）。
 * wasm 加载失败时全部用例会拿到 null —— 那是基建故障，直接让测试红。
 */
describe('analyzeBashCommand：解码字面量', () => {
  it('引号混淆解码：`"r"m -rf /` 的命令名还原为 rm', async () => {
    const f = await analyzeBashCommand('"r"m -rf /')
    expect(f).not.toBeNull()
    expect(f!.ok).toBe(true)
    expect(f!.commands).toHaveLength(1)
    expect(f!.commands[0]!.name).toBe('rm')
    expect(f!.commands[0]!.nameOpaque).toBe(false)
  })

  it('单引号与 ANSI-C 串解码', async () => {
    const f = await analyzeBashCommand("'rm' -rf /")
    expect(f!.commands[0]!.name).toBe('rm')
    const f2 = await analyzeBashCommand("echo $'a\\tb'")
    expect(f2!.commands[0]!.name).toBe('echo')
    expect(f2!.commands[0]!.args[0]!.text).toBe('a\tb')
  })

  it('双引号串内命令名/参数解码', async () => {
    const f = await analyzeBashCommand('"rm" -rf "/"')
    expect(f!.commands[0]!.name).toBe('rm')
    expect(f!.commands[0]!.args[1]!.text).toBe('/')
  })

  it('反斜杠转义还原：`\\rm -rf /` → rm', async () => {
    const f = await analyzeBashCommand('\\rm -rf /')
    expect(f!.commands[0]!.name).toBe('rm')
  })
})

describe('analyzeBashCommand：展开标记（fail-closed 依据）', () => {
  it('命令名变量展开：`$R -rf /` → nameOpaque=true', async () => {
    const f = await analyzeBashCommand('R=rm; $R -rf /')
    expect(f!.ok).toBe(true)
    expect(f!.commands).toHaveLength(1) // R=rm 是赋值不是命令
    const cmd = f!.commands[0]!
    expect(cmd.name).toBeNull()
    expect(cmd.nameOpaque).toBe(true)
  })

  it('命令名拼接展开：`rm$IFS-rf$IFS/` → nameOpaque=true（OPAQUE 占位进归一化）', async () => {
    const f = await analyzeBashCommand('rm$IFS-rf$IFS/')
    expect(f!.commands[0]!.nameOpaque).toBe(true)
    expect(f!.normalized).toContain(OPAQUE)
  })

  it('命令替换：嵌套命令可见且标 nested，hasCommandSubstitution=true', async () => {
    const f = await analyzeBashCommand('echo $(echo cm0gLXJmIC8= | base64 -d | sh)')
    expect(f!.hasCommandSubstitution).toBe(true)
    expect(f!.commands.map((c) => c.name)).toEqual(['echo', 'echo', 'base64', 'sh'])
    expect(f!.commands.slice(1).every((c) => c.nested)).toBe(true)
  })

  it('子 shell 内命令可见（会真实执行，不算 nested）', async () => {
    const f = await analyzeBashCommand('(rm -rf /)')
    expect(f!.commands).toHaveLength(1)
    expect(f!.commands[0]!.name).toBe('rm')
    expect(f!.commands[0]!.nested).toBe(false)
  })

  it('反引号命令替换同样捕获', async () => {
    const f = await analyzeBashCommand('echo `rm -rf /`')
    expect(f!.hasCommandSubstitution).toBe(true)
    expect(f!.commands.map((c) => c.name)).toEqual(['echo', 'rm'])
  })

  it('参数级展开：参数解码为 OPAQUE，命令名不受影响', async () => {
    const f = await analyzeBashCommand('ls $HOME')
    expect(f!.commands[0]!.name).toBe('ls')
    expect(f!.commands[0]!.nameOpaque).toBe(false)
    expect(f!.commands[0]!.args[0]!.text).toBeNull()
    expect(f!.normalized).toBe(`ls ${OPAQUE}`)
  })

  it('路径解析惯用法：$(which x) 标 namePathResolution（放行例外）', async () => {
    const f = await analyzeBashCommand('$(which docker) ps')
    const cmd = f!.commands[0]!
    expect(cmd.nameOpaque).toBe(true)
    expect(cmd.namePathResolution).toBe(true)
  })

  it('路径解析惯用法：$(command -v x) / $(type -P x) 同样标记', async () => {
    const f = await analyzeBashCommand('$(command -v node) --version')
    expect(f!.commands[0]!.namePathResolution).toBe(true)
    const f2 = await analyzeBashCommand('$(type -P python3) -V')
    expect(f2!.commands[0]!.namePathResolution).toBe(true)
  })

  it('路径解析惯用法旗标不符：$(type x)（缺 -P）/ $(command x)（缺 -v）不标记', async () => {
    const f = await analyzeBashCommand('$(type python3) -V')
    expect(f!.commands[0]!.namePathResolution).toBeUndefined()
    const f2 = await analyzeBashCommand('$(command node) --version')
    expect(f2!.commands[0]!.namePathResolution).toBeUndefined()
  })

  it('非路径解析的命令名替换不标记：$(echo rm)（输出不可审计）', async () => {
    const f = await analyzeBashCommand('$(echo rm) -rf /')
    const cmd = f!.commands[0]!
    expect(cmd.nameOpaque).toBe(true)
    expect(cmd.namePathResolution).toBeUndefined()
  })

  it('变量展开进命令名不标记：$R（无论值是什么都不可审计）', async () => {
    const f = await analyzeBashCommand('R=rm; $R -rf /')
    expect(f!.commands[0]!.nameOpaque).toBe(true)
    expect(f!.commands[0]!.namePathResolution).toBeUndefined()
  })

  it('嵌套替换 / 混入其它展开时不标记：$(which $(echo x)) / pre$HOME$(which x)', async () => {
    const f = await analyzeBashCommand('$(which $(echo docker)) ps')
    expect(f!.commands[0]!.namePathResolution).toBeUndefined()
    const f2 = await analyzeBashCommand('$PRE$(which docker) ps')
    expect(f2!.commands[0]!.namePathResolution).toBeUndefined()
  })
})

describe('analyzeBashCommand：重定向', () => {
  it('fd 重定向目标解码：`cat f 2>/dev/null`', async () => {
    const f = await analyzeBashCommand('cat f 2>/dev/null')
    expect(f!.redirects).toHaveLength(1)
    const r = f!.redirects[0]!
    expect(r.fd).toBe('2')
    expect(r.op).toBe('>')
    expect(r.target).toBe('/dev/null')
  })

  it('追加重定向 + tilde 目标', async () => {
    const f = await analyzeBashCommand('echo x >> ~/out.log')
    expect(f!.redirects[0]!.op).toBe('>>')
    expect(f!.redirects[0]!.target).toBe('~/out.log')
  })

  it('heredoc 标记 + 体内容不解析为命令', async () => {
    const f = await analyzeBashCommand('bash <<EOF\nrm -rf /\nEOF')
    expect(f!.hasHeredoc).toBe(true)
    // heredoc 体是数据：rm 不进 commands（防误报，体内容由原文正则覆盖）
    expect(f!.commands.map((c) => c.name)).toEqual(['bash'])
  })

  it('进程替换：hasProcessSubstitution=true 且体内命令可见', async () => {
    const f = await analyzeBashCommand('echo a > >(gzip)')
    expect(f!.hasProcessSubstitution).toBe(true)
    expect(f!.commands.map((c) => c.name)).toEqual(['echo', 'gzip'])
    expect(f!.redirects[0]!.target).toBeNull() // 目标是替换体，不可解码
  })

  it('ANSI-C 串重定向目标到裸设备可解码', async () => {
    const f = await analyzeBashCommand("echo $'a\\tb' > /dev/sda")
    expect(f!.redirects[0]!.target).toBe('/dev/sda')
  })
})

describe('analyzeBashCommand：归一化与函数体', () => {
  it('归一化：解码后的命令行让危险正则重新可见', async () => {
    const f = await analyzeBashCommand('"r"m -rf /')
    expect(f!.normalized).toBe('rm -rf /')
    const f2 = await analyzeBashCommand("rm -rf '/'")
    expect(f2!.normalized).toBe('rm -rf /')
  })

  it('多命令按序拼接（&& 与 ; 分隔的命令各自成行）', async () => {
    const f = await analyzeBashCommand('echo git && rm -rf x')
    expect(f!.commands.map((c) => c.name)).toEqual(['echo', 'rm'])
    expect(f!.normalized).toBe('echo git; rm -rf x')
  })

  it('前缀赋值不算命令', async () => {
    const f = await analyzeBashCommand('FOO=bar BAZ=qux env')
    expect(f!.commands).toHaveLength(1)
    expect(f!.commands[0]!.name).toBe('env')
  })

  it('函数体不下钻（定义不执行，防误报）', async () => {
    const f = await analyzeBashCommand('f() { echo "rm -rf /"; }')
    expect(f!.ok).toBe(true)
    expect(f!.commands).toHaveLength(0)
  })

  it('语法错误 → ok=false（调用方须回落字符串检测）', async () => {
    const f = await analyzeBashCommand('rm -rf "未闭合')
    expect(f!.ok).toBe(false)
  })

  it('空命令', async () => {
    const f = await analyzeBashCommand('')
    expect(f!.ok).toBe(true)
    expect(f!.commands).toHaveLength(0)
    expect(f!.normalized).toBe('')
  })
})
