/**
 * 面板骨架用例。
 *
 * webview 是**能执行代码的浏览器上下文**，而面板内容全部来自 sidecar 回包 ⇒
 * CSP 一旦写漏，注入面就开了。这些用例钉住的是"收紧"本身，不是排版。
 */

import { describe, expect, it } from 'bun:test'
import { PANEL_ELEMENT_IDS, createNonce, renderPanelCsp, renderPanelHtml } from './html'

const OPTS = {
  nonce: 'N0NC3',
  styleUri: 'vscode-webview://x/panel.css',
  scriptUri: 'vscode-webview://x/panel.js',
  cspSource: 'vscode-webview://x',
}

describe('renderPanelCsp', () => {
  it(`default-src 'none' —— 默认全关，脚本只认 nonce`, () => {
    const csp = renderPanelCsp(OPTS.cspSource, OPTS.nonce)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(`script-src 'nonce-${OPTS.nonce}'`)
  })
})

describe('renderPanelHtml', () => {
  it('CSP 带进 meta，且唯一的 script 标签带同一个 nonce', () => {
    const html = renderPanelHtml(OPTS)
    expect(html).toContain(`content="${renderPanelCsp(OPTS.cspSource, OPTS.nonce)}"`)

    const scripts = html.match(/<script\b[^>]*>/g) ?? []
    expect(scripts.length).toBe(1)
    expect(scripts[0]).toContain(`nonce="${OPTS.nonce}"`)
  })

  it('样式与脚本都走传入的 webview URI（无内联脚本）', () => {
    const html = renderPanelHtml(OPTS)
    expect(html).toContain(OPTS.styleUri)
    expect(html).toContain(OPTS.scriptUri)
    // 没有内联脚本体：`<script>` 之外不应再出现第二个 script 开标签
    expect(html).not.toContain('<script>')
  })

  it('容器 id 与 PANEL_ELEMENT_IDS 一一对应（改一处漏一处是最常见的断链）', () => {
    const html = renderPanelHtml(OPTS)
    for (const id of Object.values(PANEL_ELEMENT_IDS)) {
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('首帧不含假数据：内容容器都是空的（由 JS 渲染）', () => {
    const html = renderPanelHtml(OPTS)
    // 状态行是唯一有初始文案的元素（"正在连接 sidecar…"），其余容器为空
    expect(html).toContain('正在连接 sidecar…')
    expect(html).toContain(`<ul id="${PANEL_ELEMENT_IDS.sessions}" class="list"></ul>`)
  })
})

describe('createNonce', () => {
  it('32 位、两次不同（不是密码学用途，只防静态脚本注入）', () => {
    const a = createNonce()
    expect(a.length).toBe(32)
    expect(a).not.toBe(createNonce())
  })
})
