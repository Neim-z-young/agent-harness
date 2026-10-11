import { describe, expect, it } from 'bun:test'
import {
  ISOLATION_LEVELS,
  METADATA_HOSTS,
  NETWORK_COMMANDS,
  OS_BINDING_SELFTEST_SENTINEL,
  DEV_WRITE_LITERALS,
  assessNetAccess,
  buildOsBinding,
  detectOsBindingFailure,
  extractNetHost,
  DENIAL_HOW_PREFIX,
  formatDenial,
  renderSandboxProfile,
  verifyOsBinding,
  formatIsolationLine,
  hostMatchesAllow,
  isBlockedNetTarget,
  isMetadataHost,
  isPrivateHost,
  levelRank,
  probeIsolation,
  resolveIsolation,
  resolveNetPolicy,
} from './index'

// ===== P1-4 / P3-2：档位与探测 =====

describe('probeIsolation（P3-2：注入 platform/exists，不需真机）', () => {
  it('darwin：有 sandbox-exec ⇒ 原语可用，但 maxLevel 仍是 L1（未接线）', () => {
    const p = probeIsolation({ platform: 'darwin', exists: (f) => f === '/usr/bin/sandbox-exec' })
    expect(p.primitives.sandboxExec).toBe(true)
    expect(p.primitives.bwrap).toBe(false)
    // ★不模拟：探到原语 ≠ 达到 L2
    expect(p.maxLevel).toBe('L1')
    expect(p.reasons.join()).toContain('未启用')
  })

  it('darwin：没有 sandbox-exec ⇒ 理由说清"没有原语"', () => {
    const p = probeIsolation({ platform: 'darwin', exists: () => false })
    expect(p.primitives.sandboxExec).toBe(false)
    expect(p.reasons.join()).toContain('没有 sandbox-exec')
  })

  it('linux：bwrap 探到也算未接线；landlock 无法命令行探测（恒 false）', () => {
    const p = probeIsolation({ platform: 'linux', exists: (f) => f === '/usr/bin/bwrap' })
    expect(p.primitives.bwrap).toBe(true)
    expect(p.primitives.landlock).toBe(false)
    expect(p.maxLevel).toBe('L1')
  })

  it('win32：无已接线原语', () => {
    const p = probeIsolation({ platform: 'win32', exists: () => true })
    expect(p.primitives.sandboxExec).toBe(false)
    expect(p.primitives.bwrap).toBe(false)
    expect(p.maxLevel).toBe('L1')
    expect(p.reasons.join()).toContain('win32')
  })

  it('★osBinding=true 才报 L2（P1-3 落地后由接线方显式声明，不自动升档）', () => {
    expect(probeIsolation({ platform: 'darwin', exists: () => true, osBinding: true }).maxLevel).toBe('L2')
  })
})

describe('resolveIsolation / levelRank / formatIsolationLine（P1-4）', () => {
  it('档位序由低到高', () => {
    expect(ISOLATION_LEVELS).toEqual(['L0', 'L1', 'L2', 'L3'])
    expect(levelRank('L0')).toBeLessThan(levelRank('L1'))
    expect(levelRank('L3')).toBeGreaterThan(levelRank('L2'))
  })

  it('不要求（缺省 L0）⇒ met，无 reasons', () => {
    const r = resolveIsolation({ probe: probeIsolation({ platform: 'linux', exists: () => false }) })
    expect(r.required).toBe('L0')
    expect(r.level).toBe('L1')
    expect(r.met).toBe(true)
    expect(r.reasons).toEqual([])
    expect(formatIsolationLine(r)).toContain('已达标')
  })

  it('★要求 L2 ⇒ 未达标 + downgraded，且理由来自探测（这就是"拒绝启动"的判据）', () => {
    const r = resolveIsolation({ required: 'L2', probe: probeIsolation({ platform: 'darwin', exists: () => false }) })
    expect(r.met).toBe(false)
    expect(r.downgraded).toBe(true)
    expect(r.level).toBe('L1')
    expect(r.reasons.length).toBeGreaterThan(0)
    expect(formatIsolationLine(r)).toContain('未达到要求的 L2')
  })

  it('要求 L1 ⇒ 达标（L1 是当前实际具备的档位）', () => {
    const r = resolveIsolation({ required: 'L1', probe: probeIsolation({ platform: 'linux', exists: () => false }) })
    expect(r.met).toBe(true)
  })
})

// ===== P1-2：网络出口策略 =====

describe('isPrivateHost / isMetadataHost / isBlockedNetTarget（与 tools-web 同一份）', () => {
  it('私有 / 本机地址', () => {
    for (const h of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.254',
      '172.32.0.1' /* 不在私网段 */, '169.254.1.1', '127.1.1.1', 'fd12::1', 'fc00::1',
      '0.0.0.0', '::', 'localhost', 'foo.local', 'x.localhost']) {
      if (h === '172.32.0.1') expect(isPrivateHost(h)).toBe(false)
      else expect(isPrivateHost(h)).toBe(true)
    }
  })

  it('公网域名/地址不误伤', () => {
    for (const h of ['example.com', 'api.github.com', '1.1.1.1', '8.8.8.8', '172.15.0.1', '172.33.0.1', '2606:4700::1111']) {
      expect(isPrivateHost(h)).toBe(false)
    }
    expect(isPrivateHost('')).toBe(false)
  })

  it('★云元数据端点单独认（不是"互联网上的某台主机"）', () => {
    expect(isMetadataHost('169.254.169.254')).toBe(true)
    expect(isMetadataHost('[fd00:ec2::254]')).toBe(true)
    expect(isMetadataHost('metadata.google.internal')).toBe(true)
    expect(isMetadataHost('METADATA.GOOG')).toBe(true)
    expect(isMetadataHost('example.com')).toBe(false)
    expect(METADATA_HOSTS.length).toBeGreaterThan(3)
    expect(isBlockedNetTarget('169.254.169.254')).toBe(true)
    expect(isBlockedNetTarget('10.0.0.1')).toBe(true)
    expect(isBlockedNetTarget('github.com')).toBe(false)
  })
})

describe('hostMatchesAllow（域名白名单：父域覆盖子域，但不做裸后缀匹配）', () => {
  it('精确与父域', () => {
    expect(hostMatchesAllow('github.com', ['github.com'])).toBe(true)
    expect(hostMatchesAllow('api.github.com', ['github.com'])).toBe(true)
    expect(hostMatchesAllow('a.b.github.com', ['github.com'])).toBe(true)
    expect(hostMatchesAllow('github.com', ['api.github.com'])).toBe(false)
  })

  it('★`evil-github.com` 不被 `github.com` 放行（裸 endsWith 是经典绕过）', () => {
    expect(hostMatchesAllow('evil-github.com', ['github.com'])).toBe(false)
    expect(hostMatchesAllow('notgithub.com', ['github.com'])).toBe(false)
  })

  it('大小写与空项', () => {
    expect(hostMatchesAllow('API.GitHub.com', ['github.com'])).toBe(true)
    expect(hostMatchesAllow('x.com', ['', '  '])).toBe(false)
  })
})

describe('extractNetHost（从参数里取目标 host）', () => {
  it('URL / scp 形 / host:port / 裸域名 IP', () => {
    expect(extractNetHost('https://api.github.com/repos')).toBe('api.github.com')
    expect(extractNetHost('http://169.254.169.254/latest/meta-data/')).toBe('169.254.169.254')
    expect(extractNetHost('git@github.com:org/repo.git')).toBe('github.com')
    expect(extractNetHost('example.com:443')).toBe('example.com')
    expect(extractNetHost('example.com')).toBe('example.com')
    expect(extractNetHost('1.2.3.4')).toBe('1.2.3.4')
    expect(extractNetHost('localhost')).toBe('localhost')
  })

  it('不是目标的一律 undefined（选项、普通词、`a:b`）', () => {
    expect(extractNetHost('-sS')).toBeUndefined()
    expect(extractNetHost('--output')).toBeUndefined()
    expect(extractNetHost('a:b')).toBeUndefined()
    expect(extractNetHost('README')).toBeUndefined()
    expect(extractNetHost('')).toBeUndefined()
  })
})

describe('assessNetAccess（P1-2 三态）', () => {
  const policy = (net: 'open' | 'allowlist' | 'deny', netAllow: string[] = []) => resolveNetPolicy({ net, netAllow })

  it('open ⇒ 一律放行（与改造前逐位一致）', () => {
    const v = assessNetAccess({ commands: ['curl'], args: ['https://x.com'], astAvailable: true }, policy('open'))
    expect(v.ok).toBe(true)
  })

  it('deny ⇒ 出现出网命令即拒；无出网命令放行', () => {
    const bad = assessNetAccess({ commands: ['curl'], args: ['https://x.com'], astAvailable: true }, policy('deny'))
    expect(bad.ok).toBe(false)
    expect(bad.commands).toContain('curl')
    expect(bad.reason).toContain('deny')
    expect(assessNetAccess({ commands: ['ls'], args: ['-la'], astAvailable: true }, policy('deny')).ok).toBe(true)
  })

  it('allowlist ⇒ 目标在白名单内放行（含子域）', () => {
    const v = assessNetAccess(
      { commands: ['curl'], args: ['https://api.github.com/x'], astAvailable: true },
      policy('allowlist', ['github.com']),
    )
    expect(v.ok).toBe(true)
    expect(v.targets).toEqual(['api.github.com'])
  })

  it('allowlist ⇒ 未授权目标被拒，消息点名目标', () => {
    const v = assessNetAccess(
      { commands: ['curl'], args: ['https://evil.com/x'], astAvailable: true },
      policy('allowlist', ['github.com']),
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('evil.com')
    expect(v.reason).toContain('netAllow')
  })

  it('★allowlist ⇒ 元数据/私有地址硬拒（写进白名单也不放行）', () => {
    const meta = assessNetAccess(
      { commands: ['curl'], args: ['http://169.254.169.254/latest/meta-data/'], astAvailable: true },
      policy('allowlist', ['169.254.169.254']),
    )
    expect(meta.ok).toBe(false)
    expect(meta.reason).toContain('元数据')
    const priv = assessNetAccess(
      { commands: ['curl'], args: ['http://10.0.0.5/'], astAvailable: true },
      policy('allowlist', ['10.0.0.5']),
    )
    expect(priv.ok).toBe(false)
  })

  it('★allowlist ⇒ 提不出目标一律 fail-closed（无法核验 ≠ 已授权）', () => {
    // `ssh myserver`（用 ~/.ssh/config 里的别名）：字面量里没有可提取的 host
    const v = assessNetAccess({ commands: ['ssh'], args: ['myserver'], astAvailable: true }, policy('allowlist', ['github.com']))
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('无法')
  })

  it('命令名含展开（null）⇒ 当未知出网命令处理', () => {
    expect(assessNetAccess({ commands: [null], args: [], astAvailable: true }, policy('deny')).ok).toBe(false)
  })

  it('AST 不可用 ⇒ 文本兜底（deny 认得出 curl）', () => {
    const v = assessNetAccess({ raw: 'curl http://example.com', astAvailable: false }, policy('deny'))
    expect(v.ok).toBe(false)
    expect(v.commands).toContain('curl')
  })

  it('AST 不可用 ⇒ 文本兜底也认得出私有目标（allowlist）', () => {
    const v = assessNetAccess({ raw: 'curl http://169.254.169.254/', astAvailable: false }, policy('allowlist', ['169.254.169.254']))
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('元数据')
  })

  it('AST 不可用且无出网迹象 ⇒ 放行（宁可不误伤；真边界要 L2）', () => {
    expect(assessNetAccess({ raw: 'echo hi', astAvailable: false }, policy('deny')).ok).toBe(true)
  })

  it('NETWORK_COMMANDS 里没有明显非出网命令（清单就是口径）', () => {
    for (const c of ['ls', 'cat', 'git', 'npm', 'python3', 'node', 'make']) {
      expect(NETWORK_COMMANDS.includes(c)).toBe(false)
    }
  })
})

describe('resolveNetPolicy', () => {
  it('非法值回落 open（装配期由 checkSandboxConfig 说话，不在运行期抛）', () => {
    expect(resolveNetPolicy({ net: 'nonsense' as never }).mode).toBe('open')
    expect(resolveNetPolicy({}).mode).toBe('open')
  })
  it('白名单去空、小写化', () => {
    expect(resolveNetPolicy({ net: 'allowlist', netAllow: [' GitHub.com ', '', '  '] }).allow).toEqual(['github.com'])
  })
})

// ===== P2-2：拒绝文案（「为什么 + 怎么改」）=====

describe('formatDenial（P2-2）', () => {
  it('三段齐全按 what｜为什么｜怎么改 拼', () => {
    const s = formatDenial({ what: '拒绝执行 rm -rf /', why: '命中危险模式', how: '换个写法' })
    expect(s).toBe('拒绝执行 rm -rf /｜为什么：命中危险模式｜怎么改：换个写法')
  })

  it('缺段整段省略（不给「为什么：undefined」这种空头衔）', () => {
    expect(formatDenial({ what: '已拒绝' })).toBe('已拒绝')
    expect(formatDenial({ why: '因为 X', how: '做 Y' })).toBe('为什么：因为 X｜怎么改：做 Y')
  })

  it('「怎么改」前缀是常量 —— 回归守卫断言的就是它（改这里，守卫会红）', () => {
    expect(DENIAL_HOW_PREFIX).toBe('怎么改')
    expect(formatDenial({ how: '做 Y' })).toContain(DENIAL_HOW_PREFIX)
  })
})

describe('assessNetAccess 的 why / how 拆分（P2-2）', () => {
  it('deny：why 说命中了什么，how 说改哪个配置键，reason 是拼好的完整文案', () => {
    const v = assessNetAccess({ commands: ['curl'], args: [], astAvailable: true }, { mode: 'deny', allow: [] })
    expect(v.ok).toBe(false)
    expect(v.why).toContain('curl')
    expect(v.how).toContain('sandbox.net')
    expect(v.reason).toBe(formatDenial({ why: v.why, how: v.how }))
  })

  it('allowlist 未授权：how 指向 netAllow（与 reason 同源，不另写一份）', () => {
    const v = assessNetAccess(
      { commands: ['curl'], args: ['https://evil.com/x'], astAvailable: true },
      { mode: 'allowlist', allow: ['github.com'] },
    )
    expect(v.ok).toBe(false)
    expect(v.how).toContain('netAllow')
    expect(v.reason).toContain('怎么改')
  })

  it('元数据/私有地址：how 说清"不受 netAllow 影响"，别让人白加白名单', () => {
    const v = assessNetAccess(
      { commands: ['curl'], args: ['http://169.254.169.254/latest'], astAvailable: true },
      { mode: 'allowlist', allow: ['169.254.169.254'] },
    )
    expect(v.ok).toBe(false)
    expect(v.how).toContain('不受 netAllow 影响')
  })
})

// ===== P1-3：OS 级绑定（L2）=====

describe('renderSandboxProfile（P1-3）', () => {
  it('顺序即语义：可写区 → /dev 例外 → deny file-write* → allow default', () => {
    const p = renderSandboxProfile(['/work'], '/tmp')
    const lines = p.split('\n')
    expect(lines[0]).toBe('(version 1)')
    expect(lines[1]).toBe('(allow file-write* (subpath "/work"))')
    expect(lines[2]).toBe('(allow file-write* (subpath "/tmp"))')
    // deny 必须在**所有 allow 之后、allow default 之前**
    expect(lines.filter((l) => l === '(deny file-write*)')).toHaveLength(1)
    expect(lines[lines.length - 1]).toBe('(allow default)')
    expect(lines.indexOf('(deny file-write*)')).toBe(lines.length - 2)
  })

  it('/dev/null 例外必须有：缺了它连 `cmd 2>/dev/null` 都会 Operation not permitted（实测）', () => {
    const p = renderSandboxProfile(['/work'])
    expect(p).toContain('(allow file-write* (literal "/dev/null"))')
    for (const d of DEV_WRITE_LITERALS) expect(p).toContain(`(literal "${d}")`)
  })

  it('路径里的引号/反斜杠会转义（否则 profile 被截断 ⇒ 静默失效）', () => {
    const p = renderSandboxProfile(['/a"b\\c'])
    expect(p).toContain('/a\\"b\\\\c')
  })

  it('可写区去重（同一目录重复不会让 profile 长一倍）', () => {
    expect(renderSandboxProfile(['/w', '/w']).match(/\(subpath "\/w"\)/g)).toHaveLength(1)
  })
})

describe('buildOsBinding（P1-3）', () => {
  const prim = { sandboxExec: true, bwrap: true, landlock: false }

  it('darwin + sandboxExec ⇒ 拿到 sandbox-exec 前缀，档位 L2', () => {
    const b = buildOsBinding({ platform: 'darwin', writable: ['/work'], primitives: prim, tmpDir: '/tmp' })
    expect(b?.level).toBe('L2')
    expect(b?.prefix[0]).toBe('/usr/bin/sandbox-exec')
    expect(b?.prefix[1]).toBe('-p')
    expect(b?.prefix[2]).toContain('(allow file-write* (subpath "/work"))')
    expect(b?.via).toContain('sandbox-exec')
  })

  it('linux + bwrap ⇒ ro-bind / 后逐个 bind 可写区与 tmp', () => {
    const b = buildOsBinding({ platform: 'linux', writable: ['/work'], primitives: prim, tmpDir: '/tmp' })
    expect(b?.prefix[0]).toBe('/usr/bin/bwrap')
    expect(b?.prefix.slice(1, 4)).toEqual(['--ro-bind', '/', '/'])
    expect(b?.prefix).toContain('--bind')
    expect(b?.prefix).toContain('/work')
    expect(b?.prefix).toContain('/tmp')
    expect(b?.prefix).toContain('--die-with-parent')
  })

  it('win32 ⇒ null（没有原语就不模拟 —— 假装绑上了比不绑更危险）', () => {
    expect(buildOsBinding({ platform: 'win32', writable: ['C:\\w'], primitives: prim })).toBeNull()
  })

  it('有平台但探不到原语 ⇒ null', () => {
    const none = { sandboxExec: false, bwrap: false, landlock: false }
    expect(buildOsBinding({ platform: 'darwin', writable: ['/w'], primitives: none })).toBeNull()
    expect(buildOsBinding({ platform: 'linux', writable: ['/w'], primitives: none })).toBeNull()
  })

  it('可写区为空 ⇒ null（不知道能写哪就无从绑定）', () => {
    expect(buildOsBinding({ platform: 'darwin', writable: [], primitives: prim })).toBeNull()
  })

  it('原语路径可注入（单测不必碰真机路径）', () => {
    const b = buildOsBinding({ platform: 'darwin', writable: ['/w'], primitives: prim, bin: { sandboxExec: '/opt/sbx' } })
    expect(b?.prefix[0]).toBe('/opt/sbx')
  })
})

describe('verifyOsBinding（P1-3 自检）', () => {
  it('跑通 ⇒ true（哨兵出现在输出里）', () => {
    const b = buildOsBinding({ platform: 'darwin', writable: ['/w'], primitives: { sandboxExec: true, bwrap: false, landlock: false }, tmpDir: '/tmp' })!
    expect(verifyOsBinding(b, { run: () => `${OS_BINDING_SELFTEST_SENTINEL}\n` })).toBe(true)
  })

  it('profile 被拒（语法错误 ⇒ 命令根本没执行、退出码还是 0）⇒ false', () => {
    const b = buildOsBinding({ platform: 'darwin', writable: ['/w'], primitives: { sandboxExec: true, bwrap: false, landlock: false }, tmpDir: '/tmp' })!
    expect(verifyOsBinding(b, { run: () => 'sbpl1:37:4: error\n' })).toBe(false)
    expect(verifyOsBinding(b, { run: () => '' })).toBe(false)
  })

  it('自检跑的是「原语 + shell + echo 哨兵」这条完整链（不是只跑原语）', () => {
    const b = buildOsBinding({ platform: 'linux', writable: ['/w'], primitives: { sandboxExec: false, bwrap: true, landlock: false }, tmpDir: '/tmp' })!
    let seen: string[] = []
    verifyOsBinding(b, { run: (argv) => { seen = argv; return OS_BINDING_SELFTEST_SENTINEL } })
    expect(seen[0]).toBe('/usr/bin/bwrap')
    expect(seen).toContain('/bin/sh')
    expect(seen).toContain('-c')
    expect(seen[seen.length - 1]).toBe(`echo ${OS_BINDING_SELFTEST_SENTINEL}`)
  })
})

describe('probeIsolation 的 osBinding 与 P1-3 接线（纪律 2：不模拟）', () => {
  it('osBinding 未接线 ⇒ 有原语也只报 L1，并把"未接线"写进 reasons', () => {
    const p = probeIsolation({ platform: 'darwin', exists: () => true })
    expect(p.primitives.sandboxExec).toBe(true)
    expect(p.maxLevel).toBe('L1')
    expect(p.reasons.join()).toContain('未启用')
  })

  it('osBinding: true ⇒ 报 L2（只有"真构造出来了"才允许传 true）', () => {
    const p = probeIsolation({ platform: 'darwin', exists: () => true, osBinding: true })
    expect(p.maxLevel).toBe('L2')
  })

  it('要求 L2 且已接线 ⇒ met；要求 L2 但没接线 ⇒ downgraded', () => {
    const on = probeIsolation({ platform: 'linux', exists: () => true, osBinding: true })
    expect(resolveIsolation({ required: 'L2', probe: on }).met).toBe(true)
    const off = probeIsolation({ platform: 'linux', exists: () => true })
    const r = resolveIsolation({ required: 'L2', probe: off })
    expect(r.met).toBe(false)
    expect(r.downgraded).toBe(true)
    expect(r.level).toBe('L1') // 实际档位恒为本机上限，不是愿望值
  })
})

describe('detectOsBindingFailure（P1-3 执行期）', () => {
  it('darwin：sandbox_apply 被拒 ⇒ 命中（嵌套沙箱的形态）', () => {
    expect(detectOsBindingFailure('sandbox-exec: sandbox_apply: Operation not permitted', 'darwin')).toBe(true)
  })

  it('linux：bwrap 建不了 namespace ⇒ 命中', () => {
    expect(detectOsBindingFailure('bwrap: Creating new namespace failed: Operation not permitted', 'linux')).toBe(true)
  })

  it('★不吞别的失败（普通命令报错不能被当成"绑定没生效"）', () => {
    expect(detectOsBindingFailure('bash: nope: command not found', 'darwin')).toBe(false)
    expect(detectOsBindingFailure('Operation not permitted', 'darwin')).toBe(false) // 少了 sandbox_apply 前缀
    expect(detectOsBindingFailure('', 'darwin')).toBe(false)
  })

  it('未知平台恒 false（不猜）', () => {
    expect(detectOsBindingFailure('sandbox_apply: Operation not permitted', 'win32')).toBe(false)
  })
})
