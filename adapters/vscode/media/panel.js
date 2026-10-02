/**
 * 面板前端（手写，无构建链 —— 设计稿 §12.3）。
 *
 * 两条安全纪律，都是为了"内容来自跨进程回包、不可信"：
 * 1. **只用 `textContent`，绝不用 `innerHTML`** —— 统计文本与通知里可能含任意字符，
 *    拼进 HTML 就是注入面（CSP 挡得住脚本标签，但挡不住属性注入与样式污染）。
 * 2. 面板**不发对话**（那是 Chat 视图的事），只发控制动作；动作的形状由
 *    扩展侧 `planPanelAction` 纯函数校验，前端不自行拼装控制方法名。
 */

// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi()

const IDS = {
  status: 'panel-status',
  warnings: 'panel-warnings',
  timeline: 'panel-timeline',
  sessions: 'panel-sessions',
  tasks: 'panel-tasks',
  refs: 'panel-refs',
  stats: 'panel-stats',
  notices: 'panel-notices',
  refreshed: 'panel-refreshed',
}

/** 块种类 → 徽章文案（与 `timeline.ts` 的 PanelBlockKind 对应） */
const KIND_LABEL = {
  user: '我',
  assistant: '答',
  tool: '工具',
  permission: '权限',
  error: '错误',
  system: '系统',
}

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined && text !== null) n.textContent = String(text)
  return n
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function emptyInto(node, text) {
  clear(node)
  node.appendChild(el('li', 'empty', text))
}

/** 动作 → 宿主；`type` 与扩展侧 `planPanelAction` 的分支一一对应 */
function post(msg) {
  vscode.postMessage(msg)
}

// ---------------------------------------------------------------- 渲染

function renderStatus(state) {
  const node = document.getElementById(IDS.status)
  clear(node)
  if (!state || !state.ready || !state.endpoint) {
    node.textContent = state && state.loading ? '正在刷新…' : 'sidecar 未连接（点“刷新”重试）'
    return
  }
  const e = state.endpoint
  node.textContent = `已连接 · pid ${e.pid} · 端口 ${e.port} · ${e.permissionMode} · ${e.auth}`
}

function renderWarnings(state) {
  const node = document.getElementById(IDS.warnings)
  clear(node)
  const items = (state && state.warnings) || []
  node.style.display = items.length === 0 ? 'none' : 'block'
  for (const w of items) node.appendChild(el('li', null, w))
}

function renderSessions(state) {
  const node = document.getElementById(IDS.sessions)
  const items = (state && state.sessions && state.sessions.items) || []
  if (items.length === 0) {
    emptyInto(node, '暂无会话')
    return
  }
  clear(node)
  for (const s of items) {
    const li = document.createElement('li')
    const row = el('div', 'row')
    const grow = el('div', 'grow')

    const title = el('button', 'link', s.title)
    title.title = `恢复会话 ${s.id}`
    title.disabled = s.isCurrent
    title.addEventListener('click', () => post({ type: 'resume', id: s.id }))

    const head = el('div', 'row')
    head.appendChild(title)
    for (const b of s.badges || []) head.appendChild(el('span', 'badge', b))
    grow.appendChild(head)
    grow.appendChild(el('div', 'meta', [s.subtitle, s.updatedText].filter((x) => x && x !== '').join(' · ')))

    row.appendChild(grow)
    li.appendChild(row)
    node.appendChild(li)
  }
}

function renderTasks(state) {
  const node = document.getElementById(IDS.tasks)
  const items = (state && state.tasks) || []
  if (items.length === 0) {
    emptyInto(node, '无后台任务')
    return
  }
  clear(node)
  for (const t of items) {
    const li = document.createElement('li')
    const row = el('div', 'row')
    row.appendChild(el('span', 'grow', `${t.id} · ${t.stateText}`))
    row.appendChild(el('span', 'badge', t.stateText))
    li.appendChild(row)
    node.appendChild(li)
  }
}

function renderRefs(state) {
  const node = document.getElementById(IDS.refs)
  const refs = (state && state.refs) || { items: [], total: 0, truncated: false }
  if (!refs.items || refs.items.length === 0) {
    emptyInto(node, '本轮对话还没引用过文件')
    return
  }
  clear(node)
  for (const r of refs.items) {
    const li = document.createElement('li')
    const btn = el('button', 'link', r.name)
    btn.title = r.path
    btn.addEventListener('click', () => post({ type: 'open', path: r.path }))
    const row = el('div', 'row')
    row.appendChild(btn)
    li.appendChild(row)
    node.appendChild(li)
  }
  if (refs.truncated) node.appendChild(el('li', 'meta', `还有 ${Math.max(refs.total - refs.items.length, 0)} 条未显示`))
}

/**
 * 块模型时间线（P3-B2）—— **第二条通道**：块是流式每帧更新（轻、高频），
 * 而 PanelState 是手动刷新才拉（重、低频），混在一起会让每个 token 都重发整份 state。
 */
function renderTimeline(snap) {
  const node = document.getElementById(IDS.timeline)
  const blocks = (snap && snap.blocks) || []
  if (blocks.length === 0) {
    emptyInto(node, snap && snap.started ? '本轮还没有内容…' : '在 Chat 视图里 @harness 提问后，本轮过程会同步出现在这里')
    return
  }
  clear(node)
  for (const b of blocks) {
    const li = document.createElement('li')

    const head = el('div', 'row')
    head.appendChild(el('span', 'badge', KIND_LABEL[b.kind] || b.kind))
    if (b.repeats && b.repeats > 1) head.appendChild(el('span', 'meta', `×${b.repeats}`))
    if (b.streaming) head.appendChild(el('span', 'badge', '进行中'))
    li.appendChild(head)

    const body = el('div', 'pre')
    body.textContent = b.text
    li.appendChild(body)

    for (const r of b.refs || []) {
      const btn = el('button', 'link', r)
      btn.title = r
      btn.addEventListener('click', () => post({ type: 'open', path: r }))
      li.appendChild(btn)
    }
    node.appendChild(li)
  }
  if (snap && snap.streaming) node.appendChild(el('li', 'meta', '进行中…（流式更新，节流后刷新）'))
}

function renderStats(state) {
  const node = document.getElementById(IDS.stats)
  const stats = state && state.stats
  node.textContent = stats && stats.text ? stats.text : '（暂无统计：需要有活动会话）'
}

function renderNotices(state) {
  const node = document.getElementById(IDS.notices)
  const items = (state && state.notices) || []
  if (items.length === 0) {
    emptyInto(node, '无通知')
    return
  }
  clear(node)
  for (const n of items) {
    const li = document.createElement('li')
    const row = el('div', 'row')
    row.appendChild(el('span', 'badge', n.level))
    if (n.code) row.appendChild(el('span', 'meta', n.code))
    li.appendChild(row)
    li.appendChild(el('div', null, n.text))
    node.appendChild(li)
  }
}

function render(state) {
  renderStatus(state)
  renderWarnings(state)
  renderSessions(state)
  renderTasks(state)
  renderRefs(state)
  renderStats(state)
  renderNotices(state)
  const refreshed = document.getElementById(IDS.refreshed)
  if (refreshed) refreshed.textContent = (state && state.refreshedText) || '—'
}

// ---------------------------------------------------------------- 入口

window.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'state') render(msg.state)
  if (msg.type === 'timeline') renderTimeline(msg.timeline)
})

const bind = (id, msg) => {
  const node = document.getElementById(id)
  if (node) node.addEventListener('click', () => post(msg))
}

bind('btn-refresh', { type: 'refresh' })
bind('btn-new', { type: 'new' })
bind('btn-save', { type: 'save' })
bind('btn-compact', { type: 'compact' })
bind('btn-status', { type: 'show-status' })
bind('btn-clear', { type: 'timeline-clear' })

post({ type: 'refresh' })
