/**
 * AppleScript 纯逻辑层测试
 *
 * 这些用例不需要辅助功能 / 屏幕录制权限，也不真的调 osascript ——
 * 转义、element_id 解析、结果解析、键码全部是纯函数。
 */
import { describe, expect, it } from 'bun:test'
import {
  assertFiniteInt,
  elementRefClause,
  escapeAppleScriptText,
  keyCodeFor,
  modifierClause,
  parseAppList,
  parseBoolResult,
  parseElementRef,
  parsePid,
  quoteAppleScriptString,
  resolveScrollDirection,
  scrollKeyCode,
} from './applescript'

describe('escapeAppleScriptText（转义唯一口径）', () => {
  it('转义反斜杠与双引号', () => {
    expect(escapeAppleScriptText('a"b\\c')).toBe('a\\"b\\\\c')
  })

  it('把换行/制表等控制字符折叠为空格（裸换行会让脚本语法错）', () => {
    expect(escapeAppleScriptText('a\nb')).toBe('a b')
    expect(escapeAppleScriptText('a\r\nb\tc')).toBe('a  b c')
  })

  it('连续控制字符逐个折叠，不合并', () => {
    expect(escapeAppleScriptText('a\n\nb')).toBe('a  b')
  })

  it('普通文本恒等（不误伤中文与空格）', () => {
    expect(escapeAppleScriptText('Finder 访达')).toBe('Finder 访达')
  })
})

describe('quoteAppleScriptString', () => {
  it('两侧加引号并转义内部引号', () => {
    expect(quoteAppleScriptString('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('空串得到空字面量', () => {
    expect(quoteAppleScriptString('')).toBe('""')
  })
})

describe('parseElementRef（element_id 唯一口径）', () => {
  it('role|name|index 全量解析', () => {
    expect(parseElementRef('button|OK|2')).toEqual({ role: 'button', name: 'OK', index: 2 })
  })

  it('只给 role 时 index 缺省 1 且没有 name', () => {
    expect(parseElementRef('button')).toEqual({ role: 'button', index: 1 })
  })

  it('name 为空（button||3）按 index 定位，而不是拼出 button ""', () => {
    expect(parseElementRef('button||3')).toEqual({ role: 'button', index: 3 })
  })

  it('name 只有空白同样视为缺省', () => {
    expect(parseElementRef('button|   |4')).toEqual({ role: 'button', index: 4 })
  })

  it('空 / 缺 role 报可操作错误', () => {
    expect(() => parseElementRef('')).toThrow(/element_id 不能为空/)
    expect(() => parseElementRef('|OK|1')).toThrow(/缺少 role/)
  })

  it('index 非正整数报错', () => {
    expect(() => parseElementRef('button|OK|0')).toThrow(/不能小于 1/)
    expect(() => parseElementRef('button|OK|abc')).toThrow(/必须是整数/)
  })
})

describe('elementRefClause', () => {
  it('有 name 用名字定位', () => {
    expect(elementRefClause(parseElementRef('button|OK|1'))).toBe('button "OK"')
  })

  it('无 name 用 index 定位', () => {
    expect(elementRefClause(parseElementRef('button||3'))).toBe('button 3')
  })

  it('name 里的引号被转义后仍可用', () => {
    expect(elementRefClause(parseElementRef('button|say "hi"|1'))).toBe('button "say \\"hi\\""')
  })
})

describe('assertFiniteInt（数值校验，防把任意值拼进脚本）', () => {
  it('接受整数与纯数字字符串', () => {
    expect(assertFiniteInt(42, 'x')).toBe(42)
    expect(assertFiniteInt('42', 'x')).toBe(42)
  })

  it('拒绝 NaN / Infinity / 小数 / 非数字', () => {
    expect(() => assertFiniteInt(NaN, 'x')).toThrow(/必须是整数/)
    expect(() => assertFiniteInt(Infinity, 'x')).toThrow(/必须是整数/)
    expect(() => assertFiniteInt(1.5, 'x')).toThrow(/必须是整数/)
    expect(() => assertFiniteInt('abc', 'x')).toThrow(/必须是整数/)
    expect(() => assertFiniteInt(undefined, 'x')).toThrow(/必须是整数/)
  })

  it('越界按 min/max 拒绝', () => {
    expect(() => assertFiniteInt(0, 'clickCount', { min: 1, max: 3 })).toThrow(/不能小于 1/)
    expect(() => assertFiniteInt(99, 'clickCount', { min: 1, max: 3 })).toThrow(/不能大于 3/)
  })
})

describe('parsePid', () => {
  it('数字串 → number', () => {
    expect(parsePid('101')).toBe(101)
  })

  it('非数字 / 空 / 缺失 → undefined（不泄漏 NaN）', () => {
    expect(parsePid('abc')).toBeUndefined()
    expect(parsePid('')).toBeUndefined()
    expect(parsePid(undefined)).toBeUndefined()
  })

  it('"12abc" 这类半数字同样拒绝（parseInt 会静默取 12）', () => {
    expect(parsePid('12abc')).toBeUndefined()
  })
})

describe('parseAppList', () => {
  it('按 TAB 切分 name 与 pid，空行忽略', () => {
    expect(parseAppList('Finder\t101\nSafari\t202\n\n')).toEqual([
      { name: 'Finder', pid: 101 },
      { name: 'Safari', pid: 202 },
    ])
  })

  it('pid 缺失或非法时为 undefined 而不是 NaN', () => {
    expect(parseAppList('Finder\tnot-a-pid')).toEqual([{ name: 'Finder', pid: undefined }])
    expect(parseAppList('Finder')).toEqual([{ name: 'Finder', pid: undefined }])
  })
})

describe('parseBoolResult', () => {
  it('true / false 精确识别（含大小写与空白）', () => {
    expect(parseBoolResult('true')).toBe(true)
    expect(parseBoolResult('False\n')).toBe(false)
  })

  it('含 error 的文本报错 —— 即使它同时也含 true', () => {
    expect(() => parseBoolResult('error: true-ish')).toThrow(/权限查询失败/)
  })

  it('无法判定时走 fallback 而非抛错', () => {
    expect(parseBoolResult('', true)).toBe(true)
    expect(parseBoolResult('wat')).toBe(false)
  })
})

describe('modifierClause', () => {
  it('已知修饰符 → using 子句，去重', () => {
    expect(modifierClause(['cmd'])).toBe(' using {command down}')
    expect(modifierClause(['cmd', 'command'])).toBe(' using {command down}')
    expect(modifierClause(['ctrl', 'shift'])).toBe(' using {control down, shift down}')
  })

  it('空 / 缺省 → 空串', () => {
    expect(modifierClause([])).toBe('')
    expect(modifierClause(undefined)).toBe('')
  })

  it('未知修饰符报错而不是静默降级为 command（避免误触发 ⌘Q 之类）', () => {
    expect(() => modifierClause(['hyper'])).toThrow(/不支持的修饰符/)
  })
})

describe('keyCodeFor 与 scrollKeyCode', () => {
  it('命名键与字母数字有键码', () => {
    expect(keyCodeFor('enter')).toBe(36)
    expect(keyCodeFor('ESC')).toBe(53)
    expect(keyCodeFor('a')).toBe(0)
  })

  it('未知键返回 null（走 keystroke 兜底）', () => {
    expect(keyCodeFor('f13')).toBeNull()
  })

  it('滚动四方向各有独立键码（左右不再是上下）', () => {
    expect(scrollKeyCode('up')).toBe(126)
    expect(scrollKeyCode('down')).toBe(125)
    expect(scrollKeyCode('left')).toBe(123)
    expect(scrollKeyCode('right')).toBe(124)
  })
})

describe('resolveScrollDirection', () => {
  it('direction 优先', () => {
    expect(resolveScrollDirection({ direction: 'up', deltaY: 100 })).toBe('up')
  })

  it('deltaY 决定上下', () => {
    expect(resolveScrollDirection({ deltaY: -5 })).toBe('up')
    expect(resolveScrollDirection({ deltaY: 5 })).toBe('down')
  })

  it('deltaX 参与左右判定（旧实现完全忽略 deltaX）', () => {
    expect(resolveScrollDirection({ deltaX: -5, deltaY: 0 })).toBe('left')
    expect(resolveScrollDirection({ deltaX: 5, deltaY: 0 })).toBe('right')
  })

  it('未知 direction 报错', () => {
    expect(() => resolveScrollDirection({ direction: 'sideways' })).toThrow(/不支持的滚动方向/)
  })
})
