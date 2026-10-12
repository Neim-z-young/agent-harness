/**
 * 跨平台**方言**判定（P0-1 / P0-2 / P0-3 / P2-3）。
 *
 * 为什么单独一个文件：这四条的判据都是**纯函数**（危险表 / 分段 / 首命令提取 / 环境过滤），
 * 注入字符串就能判，**不需要真 Windows 机器** —— 与 `resolveShell` 的用例同范式。
 * 混在 `tools-builtin.test.ts`（真起进程）里会让"平台差异"这件事被进程噪声淹没。
 *
 * 三条纪律（与 `docs/cross-platform-plan.md` §4 一致）：
 * 1. 每条**都要有反例** —— 只断言"危险形态被拦"会让人把规则越写越宽，最后大面积误伤；
 * 2. 判定用 `[^|;&\n]*` 限定在同一段内，"只是提到它"与"真的要执行"不混为一谈（既有表的纪律）；
 * 3. 大小写**两类都测**（Windows 上键名与命令名的大小写都不固定）。
 */
import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_DANGEROUS_PATTERNS,
  DEFAULT_SENSITIVE_ENV,
  extractFirstCommand,
  sanitizeEnv,
  splitSegments,
} from './index'

/** 危险表判定（与 `detectDangerous` 同一条件，只是不需要构造工具） */
const isDangerous = (cmd: string): boolean => DEFAULT_DANGEROUS_PATTERNS.some((re) => re.test(cmd))

describe('P0-1 · 危险表：Windows 原生破坏形态', () => {
  it.each([
    ['del /f /s /q C:\\', 'del 递归强删'],
    ['del /s .\\build', 'del /s'],
    ['erase /s C:\\temp', 'erase /s（del 的别名）'],
    ['rd /s /q C:\\Windows', 'rd /s /q'],
    ['rmdir /s /q X:', 'rmdir /s /q'],
    ['Remove-Item -Recurse -Force C:\\', 'PS Remove-Item'],
    ['Remove-Item .\\node_modules -Recurse', 'PS Remove-Item（不带 -Force）'],
    ['Format-Volume -DriveLetter D', '格式化卷'],
    ['Clear-Disk -Number 0', '清盘'],
    ['Initialize-Disk -Number 1', '初始化磁盘'],
    ['Stop-Computer -Force', '关机'],
    ['Restart-Computer', '重启'],
    ['reg delete HKLM\\SOFTWARE\\Foo /f', '系统级注册表删除'],
    ['bcdedit /set {default} safeboot minimal', '改引导配置'],
    ['vssadmin delete shadows /all /quiet', '删卷影副本'],
    ['takeown /f C:\\Windows /t', '递归夺属主'],
    ['icacls C:\\ /t /grant Everyone:F', '递归改权限'],
    ['format D: /q', '快速格式化'],
    ['format /s /f /q', '★原正则匹配不到的形态（这条是修复证据）'],
  ])('%s ⇒ 命中（%s）', (cmd) => {
    expect(isDangerous(cmd)).toBe(true)
  })

  it('★反例：正常用法不能被误伤（判据是"递归/强制"而不是"出现这个词"）', () => {
    for (const cmd of [
      'del foo.txt',
      'del /q foo.txt', // 单文件静默删除：正常用法
      'erase old.log',
      'rmdir emptydir',
      'Get-ChildItem -Recurse', // PS 递归**列举**不是递归删除
      'Remove-Item foo.txt', // 不带 -Recurse
      'reg query HKLM\\SOFTWARE\\Foo',
      'reg add HKCU\\Software\\Foo /v x /t REG_SZ /d y',
      'icacls C:\\data /grant user:r', // 不带 /t
      'format /?', // 帮助
      'vssadmin list shadows', // 列举卷影
    ]) {
      expect(isDangerous(cmd), `误伤：${cmd}`).toBe(false)
    }
  })
})

describe('P0-2 · splitSegments：CMD 的单个 & 与 fd 重定向的区分', () => {
  it('★单个 `&` 是 CMD 串联符 ⇒ 必须分段（修前只算一段）', () => {
    expect(splitSegments('echo hi & shutdown -h now')).toEqual(['echo hi', 'shutdown -h now'])
    expect(splitSegments('a & b & c')).toEqual(['a', 'b', 'c'])
  })

  it('★反例：`2>&1` / `>&2` / `<&` / `&>` 里的 `&` **不是**分隔符', () => {
    expect(splitSegments('curl x 2>&1')).toEqual(['curl x 2>&1'])
    expect(splitSegments('cmd >&2')).toEqual(['cmd >&2'])
    expect(splitSegments('cmd &>file')).toEqual(['cmd &>file'])
    // 组合形态：既不能因 `&` 切开，也要照常按 `|` 切
    expect(splitSegments('curl x 2>&1 | bash')).toEqual(['curl x 2>&1', 'bash'])
  })

  it('既有的四种分隔符照旧（不能因为加了 `&` 就破坏它们）', () => {
    expect(splitSegments('a; b')).toEqual(['a', 'b'])
    expect(splitSegments('a && b')).toEqual(['a', 'b'])
    expect(splitSegments('a || b')).toEqual(['a', 'b'])
    expect(splitSegments('a | b')).toEqual(['a', 'b'])
    expect(splitSegments('a\nb')).toEqual(['a', 'b'])
  })

  it('引号内的分隔符不算（分段必须引号感知）', () => {
    expect(splitSegments('echo "a & b"')).toEqual(['echo "a & b"'])
    expect(splitSegments(`echo 'a; b'`)).toEqual([`echo 'a; b'`])
  })
})

describe('P0-3 · extractFirstCommand：PS 调用运算符与引号路径', () => {
  it('POSIX 形态：前缀赋值 / sudo / env 都跳过', () => {
    expect(extractFirstCommand('rm -rf /tmp/x')).toBe('rm')
    expect(extractFirstCommand('VAR=1 sudo rm x')).toBe('rm')
    expect(extractFirstCommand('env FOO=1 BAR=2 ls -la')).toBe('ls')
  })

  it('★PowerShell 调用运算符 `&`：后面才是真命令，且**要去掉包裹引号**', () => {
    expect(extractFirstCommand(`& 'C:\\Program Files\\evil.exe' -x`)).toBe('C:\\Program Files\\evil.exe')
    expect(extractFirstCommand('& "C:\\evil.exe"')).toBe('C:\\evil.exe')
    expect(extractFirstCommand('& C:\\evil.exe -x')).toBe('C:\\evil.exe')
    // 修前行为（回归证据）：会把引号一起返回，于是永远匹配不上白名单里的字面量
    expect(extractFirstCommand(`& 'C:\\evil.exe'`)).not.toContain("'")
  })

  it('CMD：分段后段首残留的 `&` 同样跳过', () => {
    expect(extractFirstCommand('& cmd2 arg')).toBe('cmd2')
    expect(extractFirstCommand('; cmd3')).toBe('cmd3')
  })

  it('普通带引号命令也去一层引号（白名单写的是字面量）', () => {
    expect(extractFirstCommand(`'/usr/local/bin/my tool' -x`)).toBe('/usr/local/bin/my tool')
  })
})

describe('P2-3 · sanitizeEnv：大小写不固定 + 只摘凭据不摘路径', () => {
  const host = {
    PATH: '/usr/bin',
    // ---- 应当被摘掉（含大小写变体，Windows 上很常见）----
    GITHUB_TOKEN: 't1',
    github_token: 't2',
    Github_Token: 't3',
    NPM_TOKEN: 't4',
    SLACK_TOKEN: 't5',
    SENTRY_DSN: 't6',
    SSH_KEY: 't7',
    AWS_SECRET_ACCESS_KEY: 't8',
    my_api_key: 't9',
    DbPassword: 't10',
    // ---- 路径类：**不该**摘（摘了会让依赖它们的命令坏掉）----
    USERPROFILE: 'C:\\Users\\me',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    // ---- 含 KEY/TOKEN 字样但**不是**凭据的普通名：不该误摘 ----
    MONKEY: 'x',
    KEYBOARD_LAYOUT: 'us',
    TOKENIZER_MODEL: 'bert',
  }

  const out = sanitizeEnv(host, [])

  it('★凭据（含各种大小写）全部摘掉', () => {
    for (const k of ['GITHUB_TOKEN', 'github_token', 'Github_Token', 'NPM_TOKEN', 'SLACK_TOKEN',
      'SENTRY_DSN', 'SSH_KEY', 'AWS_SECRET_ACCESS_KEY', 'my_api_key', 'DbPassword']) {
      expect(out[k], `漏摘：${k}`).toBeUndefined()
    }
  })

  it('★路径类变量**保留**（它们是路径不是凭据 —— 摘掉会直接破坏命令）', () => {
    for (const k of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATH']) {
      expect(out[k], `误摘：${k}`).toBeDefined()
    }
  })

  it('★含 KEY/TOKEN 字样的普通名不误摘（判据夹 `_` 与边界，不是子串包含）', () => {
    for (const k of ['MONKEY', 'KEYBOARD_LAYOUT', 'TOKENIZER_MODEL']) {
      expect(out[k], `误摘：${k}`).toBeDefined()
    }
  })

  it('keepEnv 优先级最高（显式保留即便它看起来像凭据）', () => {
    const kept = sanitizeEnv({ GITHUB_TOKEN: 't', PATH: '/bin' }, ['GITHUB_TOKEN'])
    expect(kept.GITHUB_TOKEN).toBe('t')
  })

  it('规则表本身也是导出面：每条都是 RegExp（防"表被清空"这类静默退化）', () => {
    expect(DEFAULT_SENSITIVE_ENV.length).toBeGreaterThan(5)
    for (const re of DEFAULT_SENSITIVE_ENV) expect(re).toBeInstanceOf(RegExp)
  })
})
