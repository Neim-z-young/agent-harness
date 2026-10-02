/**
 * 面板骨架 HTML（**纯模块**：只拼字符串，不碰 vscode）。
 *
 * 三个刻意的选择：
 *
 * 1. **CSP 收紧到 `default-src 'none'`**，脚本只认 nonce。webview 是"能执行代码
 *    的浏览器上下文"，而面板的内容**全部来自 sidecar 回包**（跨进程、不可信），
 *    所以脚本白名单必须靠 nonce，样式/脚本都从 `media/` 以 `asWebviewUri` 加载。
 * 2. **前端不用框架、不加构建链**（设计稿 §10.4 / §12.3）：为一个信息面板引入
 *    esbuild 会把 `adapters/vscode/` 变成"需要打包的目录"，污染 §3.2 那套隔离。
 * 3. **骨架里只有容器，内容全由 `media/panel.js` 渲染** —— 于是"改样式"不改扩展代码，
 *    且面板首帧不会闪出假数据（容器初始为空，`loading` 占位由 JS 写）。
 */

export interface PanelHtmlOptions {
  /** 每次生成都不同的 nonce（CSP 脚本白名单） */
  readonly nonce: string
  /** `panel.css` 的 webview URI */
  readonly styleUri: string
  /** `panel.js` 的 webview URI */
  readonly scriptUri: string
  /** `webview.cspSource` —— VSCode 给的加载源前缀 */
  readonly cspSource: string
}

/** CSP：脚本只认 nonce，其余全关（面板不需要图片/字体/网络） */
export function renderPanelCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
  ].join('; ')
}

/** 生成一个 nonce（32 位十六进制；不是密码学用途，只防静态脚本注入） */
export function createNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

/** 面板骨架。段落容器 id 与 `media/panel.js` 一一对应（改一处要改两处，故写死常量） */
export const PANEL_ELEMENT_IDS = {
  status: 'panel-status',
  warnings: 'panel-warnings',
  sessions: 'panel-sessions',
  tasks: 'panel-tasks',
  refs: 'panel-refs',
  stats: 'panel-stats',
  notices: 'panel-notices',
  refreshed: 'panel-refreshed',
} as const

export function renderPanelHtml(o: PanelHtmlOptions): string {
  const { nonce, styleUri, scriptUri, cspSource } = o
  const ids = PANEL_ELEMENT_IDS
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${renderPanelCsp(cspSource, nonce)}" />
<link rel="stylesheet" href="${styleUri}" />
<title>Agent Harness</title>
</head>
<body>
<header class="bar">
  <span class="title">Agent Harness</span>
  <span class="spacer"></span>
  <button id="btn-status" class="icon" title="sidecar 状态">ⓘ</button>
  <button id="btn-new" title="新建会话（/new）">新建</button>
  <button id="btn-save" title="立即保存当前会话（/save）">保存</button>
  <button id="btn-compact" title="压缩上下文（/compact）">压缩</button>
  <button id="btn-refresh" class="primary" title="重新拉取面板数据">刷新</button>
</header>

<div id="${ids.status}" class="status">正在连接 sidecar…</div>
<ul id="${ids.warnings}" class="warnings"></ul>

<section>
  <h2>会话</h2>
  <ul id="${ids.sessions}" class="list"></ul>
</section>

<section>
  <h2>后台任务</h2>
  <ul id="${ids.tasks}" class="list"></ul>
</section>

<section>
  <h2>文件引用</h2>
  <ul id="${ids.refs}" class="list"></ul>
</section>

<section>
  <h2>统计</h2>
  <pre id="${ids.stats}" class="pre"></pre>
</section>

<section>
  <h2>通知（宿主降级事实）</h2>
  <ul id="${ids.notices}" class="list"></ul>
</section>

<footer>最近刷新：<span id="${ids.refreshed}">—</span></footer>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>
`
}
