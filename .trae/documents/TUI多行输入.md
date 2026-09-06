# TUI 多行输入（Enter=换行，Meta+Enter=提交）

## Context

TUI 底部输入框（`packages/cli/src/tui.tsx` L1277-1294）当前用 OpenTUI 单行 `<input>`（`InputRenderable` 强制单行：剥离换行、Enter 即提交）。用户要求实现多行输入：**Enter 插入换行，Meta/⌘/Alt+Enter 提交**，粘贴多行保留，可上下键/Home/End 编辑。

范围（用户已定）：**仅 TUI**；非 TUI 的 readline REPL 路径不动。键位约定：**Enter=换行**（用户选定）。

## 关键机制（已在 OpenTUI 实测确认）

- `@opentui/core` 的 dispatch 顺序：**全局监听（react `useKeyboard`）先跑，再跑聚焦 renderable 的 keypressHandler**；全局 handler `key.preventDefault()` 可压制 textarea，返回值被忽略。
- `<textarea>` 默认键位：Enter(`return`)=`newline`；`return` + meta = `submit`；↑/↓ = 行移动。`submit()` 触发 `onSubmit`（**无 value 参数**），不自动清空 buffer。
- react `<textarea>` 在本版本**无受控 value / onInput**（`onContentChange` 等为假 props，无 core setter）。可靠读值 = `ref.current.plainText`；可靠写值 = `ref.current.setText(...)`。
- **不要用 remount+initialValue**（实测会损坏 buffer）；用 ref + `plainText`/`setText` 单实例读写。
- 测试：`pressEnter({ meta: true })` 被 `createTestRenderer` 稳定解码为 `{name:'return', meta:true}`；`mockInput.pasteBracketedText("a\nb")` 保留换行。

## 改动文件

- `packages/cli/src/tui.tsx`（主要逻辑）
- `packages/cli/src/tui.test.tsx`（提交手势升级 + 新增多行用例）
- `docs/development-log.md`（本任务条目）

## 实现步骤（tui.tsx）

### 1. 导入
顶部加 `type TextareaRenderable`（随 `CliRenderer` 一并从 `@opentui/core` 导入）。

### 2. HELP_LINES（L85-96）补多行键位提示
- `Enter` → `输入框内换行；列表/菜单中确认选中`
- `⌘/Meta+Enter` → `提交输入`
- `Tab` → 保持 `命令补全；进入文件引用/会话列表`
- 保留 `↑ / ↓` = `命令菜单或历史中选取`

### 3. 输入控件 state/ref 迁移（原 L692-695）
删 `programmaticValueRef`（含三处使用），新增：
```ts
const textareaRef = useRef<TextareaRenderable | null>(null)
const readComposer = useCallback((): string => textareaRef.current?.plainText ?? '', [])
const setComposer = useCallback((value: string) => { textareaRef.current?.setText(value ?? '') }, [])
```
保留 `histIdx`/`histIdxRef`/`setHistIdxSync`（仍驱动回看导航，只是不再驱动 JSX）。

### 4. `submit(value)`（L852-867）清空方式改为 ref
把依赖 `value` prop / onInput 的置空，换成：
```ts
const v = value.trim()
setComposer('')  // 清空底层 textarea buffer
setInput('')
setHistIdxSync(-1)
if (v) { /* 历史入栈 + pendingLines.push + void drain 不变 */ }
```
deps：`[drain, setHistIdxSync, setComposer]`。

### 5. 命令菜单分支（L918-935）——解决 Enter 冲突
每个分支加 `key.preventDefault()`（↑/↓ 不动光标、Tab 不插入 \t、普通 Enter 不换行、Meta+Enter 不自行 submit）。`tab`/`escape` 除写 `input` state 外，再 `setComposer(...)` 回填 buffer。**仅拦截普通 Enter** 选中命令（`key.name === 'return' && !key.meta`）；Meta+Enter 放行提交正文。

```ts
if (!listMode && cmdMenuOpen) {
  const last = cmdCandidates.length - 1
  if (key.name === 'up')   { key.preventDefault(); setCmdSel(s => Math.max(0, s - 1)); return true }
  if (key.name === 'down') { key.preventDefault(); setCmdSel(s => Math.min(last, s + 1)); return true }
  if (key.name === 'tab') {
    key.preventDefault()
    const c = cmdCandidates[Math.min(Math.max(cmdSel, 0), last)]
    const filled = c.command + (c.command.endsWith(' ') ? '' : ' ')
    setComposer(filled); setInput(filled); setCmdSel(0); return true
  }
  if (key.name === 'escape') {
    key.preventDefault()
    const head = input.split(/\s+/)[0] ?? ''
    setComposer(head); setInput(head); setCmdSel(0); return true
  }
  if (key.name === 'return' && !key.meta) {
    key.preventDefault()
    const c = cmdCandidates[Math.min(Math.max(cmdSel, 0), last)]
    submitRef.current(c.command); return true
  }
  return true
}
```

### 6. 历史分支（L937-954）——回看仍可用
↑/↓ 由原先只写 `programmaticValueRef` + 依赖 `<input>` value，改为 `key.preventDefault()` + `setComposer`/`setInput` 回填。

### 7. 实时同步 `input` state（useKeyboard 末尾）
末尾追加（微任务回读 plainText → input，供命令菜单过滤 / `input===''` 侧栏门控用），模态/列表分支提前 return 时天然不触发：
```ts
if (!listMode && !helpOpen && approvalQ === null) {
  queueMicrotask(() => {
    const v = textareaRef.current?.plainText ?? ''
    setInput(v); setHistIdxSync(-1)
  })
}
```
时序安全：global handler 排 microtask → textarea 同步改好 buffer → microtask 于整次 dispatch 后执行，读到最新值。

### 8. 替换 `<input>` 元素（L1277-1294）
```tsx
<textarea
  ref={textareaRef}
  focused={!listMode}
  onSubmit={() => submit(readComposer())}
  placeholder="❯ "
/>
```
去掉 `value`/`onInput` 及 `value={history[...]??input}` 表达式——buffer 归 textarea 所有，经 `setComposer`/`readComposer` 驱动。

## 测试（tui.test.tsx）

新增 helper：`const metaEnter = (s) => s.mockInput.pressEnter({ meta: true })`。
- 升级既有**单行提交**手势 `pressEnter()` → `metaEnter()`：`sendMessageWithGap`(L618)、欢迎页 hello(L640-641)、/stats(L652)、/exit(L702)、统计(L763)、复制(L773)、approval`hi`(L728,L743)、file-ref `file`/`bar`(L795,L819)。**列表选中场景**（session/file 模式的 Enter，如 L831）保持普通 `pressEnter()`（那类键由全局列表分支处理、textarea 已让焦）。
- 新增 `describe('多行输入 composer')`：
  1. Enter=换行 + Meta+Enter=提交：`typeText('line1')`+`pressEnter()`+`typeText('line2')` → 帧内 composer 显示 `line1\nline2` 且未回显；再 `pressEnter({meta:true})` → 出现含多行文本的 user 块。
  2. Meta+Enter 提交单行：`hello`+`pressEnter({meta:true})` → 回显 `❯ hello`（替代现有单行用例）。
  3. 粘贴换行保留：`pasteBracketedText('aaa\nbbb')`+`metaEnter` → 提交内容为 `aaa\nbbb`。
  4. 命令菜单 Enter 仍补全而非换行：`/stat`+推进几帧（microtask 同步开菜单）+普通 `pressEnter()` → 提交 `/stats` 且未插入换行、未重复提交残缺文本。
  5. 空提交忽略：空 composer 上 `pressEnter({meta:true})` → 无 user 块，prompt 保持 `❯`。
- `typeText` 与随后 Enter 之间沿用现有 `sendMessageWithGap` 的宽松 pump，保证 microtask flush + React commit 落定。

## 验证

```
cd /Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli
/opt/homebrew/bin/bun test tui.test.tsx      # 多行输入新用例全绿 + 既有用例升级后全绿
/opt/homebrew/bin/bun run typecheck
cd /Users/oyoungy/Documents/project/XiaoZhi-new && /opt/homebrew/bin/bun run typecheck   # 全仓
cd /Users/oyoungy/Documents/project/XiaoZhi-new && /opt/homebrew/bin/bun test            # 全量
```
手动冒烟（真实终端 TUI）：Enter 多行换行 / Meta+Enter 提交；粘贴多行块保留；`/` 菜单 ↑/↓/Tab/Enter 仍补全；↑/↓ 历史回看进 composer。升级 development-log 后精确暂存提交。