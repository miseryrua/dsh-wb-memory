// 注入块按会话冻结（lib/inject-cache.js + lib/index.js 的 systemPrompt text 回调）。
// 全部在临时沙箱里跑：合成工作区与合成记忆，不触碰任何真实 .workbuddy/memory。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, readdirSync, copyFileSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { InjectCache, buildInjectKey, hashText, stableStringify } from '../lib/inject-cache.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const test = (name, fn) => { fn(); console.log('PASS ' + name); passed++ }

// ---------- 纯函数与小类 ----------
test('stableStringify 与键序无关', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } }), stableStringify({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }))
})
test('hashText：null 与空串区分，相同内容同哈希', () => {
  assert.notEqual(hashText(null), hashText(''))
  assert.equal(hashText('甲'), hashText('甲'))
  assert.notEqual(hashText('甲'), hashText('乙'))
})
const base = { config: { enabled: true, logMaxChars: 1500 }, cwd: 'C:/w/A', root: 'C:/w', resolved: 'A', user: 'u', pinned: 'p', memory: 'm', day: '2026-01-01', workspaces: ['A', 'B'] }
test('buildInjectKey：每个稳定输入变化都改键，其余不变', () => {
  const k = buildInjectKey(base)
  assert.equal(buildInjectKey({ ...base, config: { logMaxChars: 1500, enabled: true } }), k)
  for (const [f, v] of [['config', { enabled: true, logMaxChars: 1600 }], ['cwd', 'C:/w/B'], ['root', 'D:/w'], ['resolved', 'B'], ['user', 'u2'], ['pinned', 'p2'], ['memory', 'm2'], ['day', '2026-01-02'], ['workspaces', ['A']]]) {
    assert.notEqual(buildInjectKey({ ...base, [f]: v }), k, f)
  }
})
test('InjectCache：键一致才命中，容量逐出最旧，delete/clear', () => {
  const c = new InjectCache(3)
  c.set('a', 'k1', 'A'); c.set('b', 'k1', 'B'); c.set('c', 'k1', 'C')
  assert.equal(c.get('a', 'k1'), 'A')
  assert.equal(c.get('a', 'k2'), undefined)
  c.set('d', 'k1', 'D')
  assert.equal(c.size, 3); assert.ok(!c.has('a')); assert.ok(c.has('d'))
  assert.ok(c.delete('b')); assert.equal(c.size, 2)
  c.clear(); assert.equal(c.size, 0)
})

// ---------- 接入宿主回调（沙箱插件副本） ----------
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-wb-memory-inject-'))
process.on('exit', () => { try { rmSync(sandbox, { recursive: true, force: true }) } catch {} })
const plugin = join(sandbox, 'plugin'), wsroot = join(sandbox, 'workspaces')
const wsA = join(wsroot, 'A'), wsB = join(wsroot, 'B')
const memA = join(wsA, '.workbuddy', 'memory')
mkdirSync(join(plugin, 'lib'), { recursive: true }); mkdirSync(memA, { recursive: true }); mkdirSync(join(wsB, '.workbuddy', 'memory'), { recursive: true })
for (const f of readdirSync(join(root, 'lib'))) if (f.endsWith('.js')) copyFileSync(join(root, 'lib', f), join(plugin, 'lib', f))
copyFileSync(join(root, 'package.json'), join(plugin, 'package.json'))
const cfg = { enabled: true, workspaceRoot: wsroot, activeProject: null, autoDigest: false, autoDistill: false, sessionSummary: false, memorySearchTool: false, memoryHeat: true, relevantTopK: 1 }
const cfgFile = join(plugin, 'config.json')
const setCfg = (patch) => writeFileSync(cfgFile, JSON.stringify({ ...cfg, ...patch }))
setCfg({})
writeFileSync(join(plugin, 'USER.md'), '合成画像甲')
writeFileSync(join(memA, 'PINNED.md'), '- [2026-01-01] 合成置顶甲')
const entries = (extra = '') => ['## 蓝鲸迁移', '蓝鲸迁移需先停服再切换数据库。', '', '## 夜间备份', '夜间备份每天凌晨执行。', extra].join('\n')
writeFileSync(join(memA, 'MEMORY.md'), entries())
const logFile = (day) => join(memA, day + '.md')

// 固定"现在"，用于逻辑日变化用例（dayBoundaryHour 默认 4，取中午避开分界）
const RealDate = Date
let fakeNow = null
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(fakeNow ?? RealDate.now()) }
  static now() { return fakeNow ?? RealDate.now() }
}
const at = (iso) => { fakeNow = new RealDate(iso).getTime(); globalThis.Date = FakeDate }
const realTime = () => { fakeNow = null; globalThis.Date = RealDate }
at('2026-03-10T12:00:00')

function makeHost() {
  const listeners = new Map(), disposers = []
  const scopes = { llm: { llm: { listProviders: () => [] } }, webServer: { effect: (f) => { try { f() } catch {} ; return () => {} }, webServer: { register: () => () => {} } }, connection: { connection: { requestRejection: () => undefined } } }
  const injections = []
  const ctx = {
    on(n, fn) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); return () => listeners.get(n).delete(fn) },
    emit(n, ...a) { for (const fn of [...(listeners.get(n) || [])]) fn(...a) },
    effect(fn) { const d = typeof fn === 'function' ? fn() : undefined; const x = () => { try { if (typeof d === 'function') d() } catch {} }; disposers.push(x); return x },
    inject(names, fn) { injections.push([names, fn]) },
  }
  scopes.systemPrompt = { systemPrompt: { context: (r) => { scopes.registered = r } } }
  return { ctx, scopes, disposers, emit: ctx.emit, activate() { for (const [names, fn] of injections) fn(Object.assign({}, ...names.map((n) => scopes[n]))) } }
}

process.env.DSH_WORKSPACE_ROOT = wsroot
const log0 = console.log
const idx = await import(pathToFileURL(join(plugin, 'lib', 'index.js')))
const host = makeHost()
console.log = () => {}
idx.apply(host.ctx); host.activate()
console.log = log0
const text = host.scopes.registered.text
const cache = idx.injectCacheForTest

const sessions = new Map()
const agentOf = (sid) => { if (!sessions.has(sid)) sessions.set(sid, { session: { id: sid, header: { cwd: wsA }, deriveMessages: () => [] } }); return sessions.get(sid) }
const claim = (sid, q) => host.emit('agent/inbox/claimed', { agent: agentOf(sid), message: { role: 'user', id: 'u' + Math.random(), source: { kind: 'user' }, content: [{ type: 'text', text: q }] } })
const run = (sid) => { const l = console.log; console.log = () => {}; try { return text({ agent: agentOf(sid), scope: agentOf(sid) }) } finally { console.log = l } }
const today = () => '2026-03-10'

claim('s1', '蓝鲸迁移怎么做')
const first = run('s1')
test('首次调用照常装配：含相关条目、今日日志，并带冻结提示', () => {
  assert.ok(first.includes('#### 蓝鲸迁移'), '应召回蓝鲸迁移')
  assert.ok(first.includes(idx.INJECT_FROZEN_HINT))
  assert.ok(first.includes('memory_search'))
  assert.equal(cache.size, 1)
})
test('同会话：追加今日日志 + 换 query 后返回逐字相同', () => {
  writeFileSync(logFile(today()), '- 12:01【自动】新增流水甲\n')
  claim('s1', '夜间备份几点执行')
  assert.equal(run('s1'), first)
  appendFileSync(logFile(today()), '- 12:09【自动】新增流水乙\n')
  claim('s1', '完全无关的话题')
  assert.equal(run('s1'), first)
  assert.ok(!run('s1').includes('新增流水'))
})
test('改 MEMORY.md → 重建（含新内容、且新块再次冻结）', () => {
  writeFileSync(join(memA, 'MEMORY.md'), entries('\n## 海豚方案\n海豚方案使用双写。'))
  const b = run('s1')
  assert.notEqual(b, first)
  assert.ok(b.includes('新增流水乙'), '重建后应包含当时的今日日志')
  assert.equal(run('s1'), b)
})
test('改 PINNED.md → 重建', () => {
  const before = run('s1')
  writeFileSync(join(memA, 'PINNED.md'), '- [2026-01-01] 合成置顶乙')
  const b = run('s1'); assert.notEqual(b, before); assert.ok(b.includes('合成置顶乙'))
})
test('改 USER.md → 重建', () => {
  const before = run('s1')
  writeFileSync(join(plugin, 'USER.md'), '合成画像乙')
  const b = run('s1'); assert.notEqual(b, before); assert.ok(b.includes('合成画像乙'))
})
test('配置变化（预算类键）→ 重建', () => {
  const before = run('s1')
  appendFileSync(logFile(today()), '- 12:15【自动】配置变更前流水\n')
  assert.equal(run('s1'), before, '配置未变时仍冻结')
  setCfg({ logMaxChars: 777 })
  const b = run('s1'); assert.ok(b.includes('配置变更前流水'), '配置变化后应重建并带上最新日志')
  assert.equal(run('s1'), b)
})
test('逻辑日变化 → 重建；同一逻辑日内（含凌晨 4 点前仍属前一日）保持冻结', () => {
  setCfg({})
  const b0 = run('s1')
  at('2026-03-10T23:30:00'); assert.equal(run('s1'), b0, '同日晚间仍冻结')
  at('2026-03-11T01:00:00'); assert.equal(run('s1'), b0, '凌晨1点仍属逻辑日 03-10')
  writeFileSync(logFile('2026-03-11'), '- 12:00【自动】次日流水\n')
  at('2026-03-11T12:00:00'); const b1 = run('s1')
  assert.notEqual(b1, b0); assert.ok(b1.includes('2026-03-11.md'))
  assert.equal(run('s1'), b1)
  at('2026-03-10T12:00:00')
})
test('工作区列表变化 → 重建', () => {
  const before = run('s1')
  mkdirSync(join(wsroot, 'C'), { recursive: true })
  const b = run('s1'); assert.notEqual(b, before); assert.ok(b.includes('- C'))
})
test('enabled=false → 返回空并丢弃冻结块；再启用后重建', () => {
  const before = run('s1')
  setCfg({ enabled: false })
  assert.equal(run('s1'), ''); assert.ok(!cache.has('s1'))
  setCfg({})
  claim('s1', '蓝鲸迁移怎么做') // 重建以当时的 query 为准
  const b = run('s1'); assert.ok(b.length > 100); assert.ok(b.includes('#### 蓝鲸迁移')); assert.ok(cache.has('s1'))
  assert.ok(typeof before === 'string')
})
test('不同会话互不影响', () => {
  claim('s2', '夜间备份几点执行')
  const b2 = run('s2'), b1 = run('s1')
  assert.ok(b2.includes('#### 夜间备份'), 's2 按自己的问题召回')
  assert.ok(b1.includes('#### 蓝鲸迁移') && !b1.includes('#### 夜间备份'), 's1 保持自己的块')
  claim('s2', '蓝鲸迁移'); assert.equal(run('s2'), b2)
  assert.equal(cache.size >= 2, true)
})
test('session/disposed 清桶，仅删对应会话', () => {
  assert.ok(cache.has('s1') && cache.has('s2'))
  host.emit('session/disposed', { id: 's2' })
  assert.ok(!cache.has('s2') && cache.has('s1'))
  host.emit('session/disposed', undefined)
  host.emit('session/disposed', {})
})
test('无 session id → 每次现算（日志追加立即可见），且不入缓存', () => {
  const sizeBefore = cache.size
  const noSid = () => { const l = console.log; console.log = () => {}; try { return text({ agent: { session: { header: { cwd: wsA } } } }) } finally { console.log = l } }
  const a = noSid()
  appendFileSync(logFile(today()), '- 12:20【自动】无会话号流水\n')
  const b = noSid()
  assert.notEqual(a, b); assert.ok(b.includes('无会话号流水'))
  const l2 = console.log; console.log = () => {}
  try { assert.equal(text({}).length > 0, true) } finally { console.log = l2 } // 完全没有 agent 也不崩
  assert.equal(cache.size, sizeBefore)
})
test('容量 128：超出逐出最旧会话', () => {
  cache.clear()
  for (let i = 0; i < 130; i++) { claim('cap-' + i, '蓝鲸迁移'); run('cap-' + i) }
  assert.equal(cache.size, 128); assert.ok(!cache.has('cap-0') && !cache.has('cap-1')); assert.ok(cache.has('cap-129'))
})
test('热度只在重建时入队：命中缓存不重复计曝光', () => {
  cache.clear()
  const hs = () => { const f = join(memA, 'heat.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).entries : {} }
  // 用只在本用例出现的专属标题，避开前面用例已入队的曝光计数
  writeFileSync(join(memA, 'MEMORY.md'), entries('\n## 星海协议\n星海协议规定握手顺序。'))
  claim('h1', '星海协议握手顺序'); const hb = run('h1')
  assert.ok(hb.includes('#### 星海协议'))
  for (let i = 0; i < 4; i++) { claim('h1', '星海协议握手 第' + i + '问'); assert.equal(run('h1'), hb) } // 每次新 revision，但命中缓存
  claim('h2', '星海协议握手顺序'); run('h2') // 另一个会话重建一次
  // 卸载 → heatTracker.dispose() → flush
  const l = console.log; console.log = () => {}
  for (const d of host.disposers) d()
  console.log = l
  const e = Object.values(hs()).find((x) => x.title === '星海协议')
  assert.ok(e, '应有热度记录'); assert.equal(e.count, 2, '两个会话各重建一次，共 2 次曝光')
})
test('插件卸载 effect 清空缓存', () => { assert.equal(cache.size, 0) })

realTime()
console.log('inject-cache: ' + passed + ' passed')
