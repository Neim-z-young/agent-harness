/**
 * ComputerUseBackend 行为测试
 *
 * 全程注入 exec / execBin（不真的调 osascript / screencapture，不需要辅助功能与屏幕录制权限），
 * 断言"拼出来的脚本"与"边界输入下的行为"。
 */
import { describe, expect, it } from 'bun:test'
import { ComputerUseBackend, ComputerUseError } from './mac'
import type { ExecFn, ExecBinFn } from './mac'

/** 录制型 osascript stub：返回预设输出，记下每次调用的脚本 */
function makeExec(handler: (script: string) => { code?: number; stdout?: string; stderr?: string } = () => ({ stdout: '' })) {
  const scripts: string[] = []
  const exec: ExecFn = async (args) => {
    const script = args[args.length - 1] ?? ''
    scripts.push(script)
    const r = handler(script)
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { exec, scripts }
}

function makeBin(handler: (args: string[]) => { code?: number; bytes?: Buffer } = () => ({ bytes: Buffer.from('png') })) {
  const calls: string[][] = []
  const execBin: ExecBinFn = async (args) => {
    calls.push(args)
    const r = handler(args)
    return { code: r.code ?? 0, stdout: r.bytes ?? Buffer.from(''), stderr: '' }
  }
  return { execBin, calls }
}

function backendWith(handler?: Parameters<typeof makeExec>[0]) {
  const { exec, scripts } = makeExec(handler)
  const backend = new ComputerUseBackend({ exec, allowScreenshot: false })
  return { backend, scripts }
}

describe('click', () => {
  it('坐标点击拼出 click at {x, y} 并包在目标进程里', async () => {
    const { backend, scripts } = backendWith()
    await backend.click({ app: 'Finder', x: 10, y: 20 })
    expect(scripts[0]).toContain('tell process "Finder"')
    expect(scripts[0]).toContain('click at {10, 20}')
  })

  it('element_id 带 name 时用名字定位', async () => {
    const { backend, scripts } = backendWith()
    await backend.click({ app: 'Finder', element_id: 'button|OK|1' })
    expect(scripts[0]).toContain('click button "OK" of front window')
  })

  it('element_id 缺 name（button||3）用 index 定位，而不是 button ""', async () => {
    const { backend, scripts } = backendWith()
    await backend.click({ app: 'Finder', element_id: 'button||3' })
    expect(scripts[0]).toContain('click button 3 of front window')
    expect(scripts[0]).not.toContain('""')
  })

  it('非 left 按钮明确报错，且不执行任何脚本（不默默按左键点）', async () => {
    const { backend, scripts } = backendWith()
    await expect(backend.click({ app: 'Finder', x: 1, y: 2, button: 'right' })).rejects.toThrow(/暂不支持 button=right/)
    expect(scripts).toHaveLength(0)
  })

  it('坐标非法（NaN / 小数）报错且不执行', async () => {
    const { backend, scripts } = backendWith()
    await expect(backend.click({ app: 'Finder', x: NaN, y: 2 })).rejects.toThrow(/必须是整数/)
    await expect(backend.click({ app: 'Finder', x: 1.5, y: 2 })).rejects.toThrow(/必须是整数/)
    expect(scripts).toHaveLength(0)
  })

  it('缺 element_id 与坐标时报可操作错误', async () => {
    const { backend } = backendWith()
    await expect(backend.click({ app: 'Finder' })).rejects.toThrow(/需要 element_id 或 \(x, y\)/)
  })

  it('clickCount=2 真的点两次', async () => {
    const { backend, scripts } = backendWith()
    await backend.click({ app: 'Finder', x: 1, y: 2, clickCount: 2 })
    expect(scripts).toHaveLength(2)
  })

  it('clickCount 越界（0 / 99）报错', async () => {
    const { backend, scripts } = backendWith()
    await expect(backend.click({ app: 'Finder', x: 1, y: 2, clickCount: 0 })).rejects.toThrow(/不能小于 1/)
    await expect(backend.click({ app: 'Finder', x: 1, y: 2, clickCount: 99 })).rejects.toThrow(/不能大于 3/)
    expect(scripts).toHaveLength(0)
  })
})

describe('list_apps', () => {
  it('解析 name 与 pid', async () => {
    const { backend } = backendWith(() => ({ stdout: 'Finder\t101\nSafari\t202\n' }))
    const r = await backend.listApps()
    expect(r.apps).toEqual([
      { name: 'Finder', pid: 101, running: true },
      { name: 'Safari', pid: 202, running: true },
    ])
  })

  it('pid 非法时为 undefined —— 不把 NaN 泄漏进输出', async () => {
    const { backend } = backendWith(() => ({ stdout: 'Finder\tabc\n' }))
    const r = await backend.listApps()
    expect(r.apps[0]!.pid).toBeUndefined()
    expect(JSON.stringify(r.apps)).not.toContain('null')
  })

  it('windowLimit 真的截断（旧实现声明了却完全忽略）', async () => {
    const { backend } = backendWith(() => ({ stdout: 'A\t1\nB\t2\nC\t3\n' }))
    const r = await backend.listApps({ windowLimit: 2 })
    expect(r.apps.map((a) => a.name)).toEqual(['A', 'B'])
  })

  it('includeWindowIds 时额外查一次前窗口 id', async () => {
    const { backend, scripts } = backendWith((s) => ({ stdout: s.includes('front window') ? '4242' : 'Finder\t101\n' }))
    const r = await backend.listApps({ includeWindowIds: true })
    expect(r.apps[0]!.windowId).toBe(4242)
    expect(scripts.length).toBeGreaterThan(1)
  })
})

describe('check_permissions', () => {
  it('UI elements enabled = true → accessibility true', async () => {
    const { backend } = backendWith(() => ({ stdout: 'true' }))
    const p = await backend.checkPermissions()
    expect(p.accessibility).toBe(true)
    expect(p.accessibilityError).toBeUndefined()
  })

  it('查询失败时给出原因，不再静默成 false', async () => {
    const { backend } = backendWith(() => ({ code: 1, stderr: 'not authorized' }))
    const p = await backend.checkPermissions()
    expect(p.accessibility).toBe(false)
    expect(p.accessibilityError).toContain('not authorized')
  })

  it('输出同时含 true 与 error 时判为失败（旧实现会被当成 true）', async () => {
    const { backend } = backendWith(() => ({ stdout: 'error: true' }))
    const p = await backend.checkPermissions()
    expect(p.accessibility).toBe(false)
  })
})

describe('scroll', () => {
  it('按 direction 选择键码并重复指定页数', async () => {
    const { backend, scripts } = backendWith()
    await backend.scroll({ app: 'Finder', direction: 'up', pages: 2 })
    const s = scripts[scripts.length - 1]!
    expect(s).toContain('repeat 2 times')
    expect(s).toContain('key code 126')
  })

  it('deltaX 决定左右（旧实现只认 deltaY）', async () => {
    const { backend, scripts } = backendWith()
    await backend.scroll({ app: 'Finder', deltaX: -5 })
    expect(scripts[scripts.length - 1]).toContain('key code 123')
  })

  it('pages 越界（0 / 51）报错且不执行', async () => {
    const { backend, scripts } = backendWith()
    await expect(backend.scroll({ app: 'Finder', pages: 0 })).rejects.toThrow(/不能小于 1/)
    await expect(backend.scroll({ app: 'Finder', pages: 51 })).rejects.toThrow(/不能大于 50/)
    expect(scripts).toHaveLength(0)
  })
})

describe('drag', () => {
  it('缺坐标时先校验：一条脚本都不执行（旧实现会先动两次界面再抛错）', async () => {
    const { backend, scripts } = backendWith()
    await expect(backend.drag({ app: 'Finder' })).rejects.toThrow(/需要 fromX\/fromY\/toX\/toY/)
    expect(scripts).toHaveLength(0)
  })

  it('坐标齐全时执行（set frontmost + 拖放脚本）', async () => {
    const { backend, scripts } = backendWith()
    await backend.drag({ app: 'Finder', fromX: 1, fromY: 2, toX: 3, toY: 4 })
    expect(scripts).toHaveLength(2)
    expect(scripts[1]).toContain('click at {1, 2}')
  })
})

describe('type_text / press_key', () => {
  it('文本里的引号被转义后拼进 keystroke', async () => {
    const { backend, scripts } = backendWith()
    await backend.typeText({ app: 'Finder', text: 'say "hi"' })
    expect(scripts[0]).toContain('keystroke "say \\"hi\\""')
  })

  it('文本含换行时折叠为空格而不是拼出坏脚本', async () => {
    const { backend, scripts } = backendWith()
    await backend.typeText({ app: 'Finder', text: 'a\nb' })
    expect(scripts[0]).toBe('tell application "System Events" to keystroke "a b"')
  })

  it('缺 text 报错且不执行', async () => {
    const { backend, scripts } = backendWith()
    await expect(backend.typeText({ app: 'Finder', text: undefined as unknown as string })).rejects.toThrow(/缺少 text/)
    expect(scripts).toHaveLength(0)
  })

  it('已知键走 key code，未知键走 keystroke', async () => {
    const { backend, scripts } = backendWith()
    await backend.pressKey({ app: 'Finder', key: 'enter' })
    expect(scripts[0]).toContain('key code 36')
    await backend.pressKey({ app: 'Finder', key: 'é' })
    expect(scripts[1]).toContain('keystroke "é"')
  })

  it('组合键带 using 子句；未知修饰符报错且不执行', async () => {
    const { backend, scripts } = backendWith()
    await backend.pressKey({ app: 'Finder', key: 'v', modifiers: ['cmd'] })
    expect(scripts[0]).toContain('using {command down}')
    await expect(backend.pressKey({ app: 'Finder', key: 'v', modifiers: ['hyper'] })).rejects.toThrow(/不支持的修饰符/)
    expect(scripts).toHaveLength(1)
  })
})

describe('错误可诊断性', () => {
  it('osascript 失败时错误带操作名', async () => {
    const { backend } = backendWith(() => ({ code: 1, stderr: 'System Events 未授权' }))
    await expect(backend.listApps()).rejects.toThrow(/list_apps/)
  })

  it('错误类型是 ComputerUseError 且带 op 字段', async () => {
    const { backend } = backendWith(() => ({ code: 1, stderr: 'boom' }))
    try {
      await backend.listApps()
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ComputerUseError)
      expect((err as ComputerUseError).op).toBe('list_apps')
    }
  })

  it('缺 app 时报错且不执行', async () => {
    const { backend, scripts } = backendWith()
    await expect(backend.click({ app: '', x: 1, y: 2 })).rejects.toThrow(/缺少目标应用名/)
    expect(scripts).toHaveLength(0)
  })
})

describe('get_app_state', () => {
  it('允许截图且 execBin 成功时返回 data URI', async () => {
    const { exec, scripts } = makeExec(() => ({ stdout: 'BUTTON "ok"' }))
    const { execBin, calls } = makeBin(() => ({ bytes: Buffer.from([1, 2, 3]) }))
    const backend = new ComputerUseBackend({ exec, execBin })
    const r = await backend.getAppState({ app: 'Finder' })
    expect(r.uiTree).toBe('BUTTON "ok"')
    expect(r.screenshot).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
    expect(calls[0]).toContain('-t')
    expect(scripts.length).toBeGreaterThanOrEqual(1)
  })

  it('allowScreenshot=false 时不截图', async () => {
    const { exec } = makeExec(() => ({ stdout: 'tree' }))
    const backend = new ComputerUseBackend({ exec, allowScreenshot: false })
    const r = await backend.getAppState({ app: 'Finder', windowId: 7 })
    expect(r.screenshot).toBeUndefined()
    expect(r.uiTree).toBe('tree')
  })

  it('截图失败只丢截图，不影响 UI 树', async () => {
    const { exec } = makeExec(() => ({ stdout: 'tree' }))
    const { execBin } = makeBin(() => ({ code: 1 }))
    const backend = new ComputerUseBackend({ exec, execBin })
    const r = await backend.getAppState({ app: 'Finder', windowId: 7 })
    expect(r.uiTree).toBe('tree')
    expect(r.screenshot).toBeUndefined()
  })
})
