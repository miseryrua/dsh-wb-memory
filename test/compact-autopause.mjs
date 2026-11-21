// 迭代 F2：自动整理连续进展不足 → 停手（假模型，系统临时目录，不碰真实数据）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { nextAutoPause, autoPauseState, autoPauseView, COMPACT_AUTOPAUSE_AFTER, COMPACT_AUTOPAUSE_RELEASE_DELTA } from '../lib/compact-autopause.js'
import { splitSinkEntries, sinkKey } from '../lib/compact-sink.js'
import { compactProgressOk } from '../lib/compact-plan.js'
const root = mkdtempSync(join(tmpdir(), 'wb-compact-autopause-'))
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name) }
try {
  // ---------- 纯函数 ----------
  await test('纯函数：计数/清零/保留口径', () => {
    const ip = { ok: false, errorCode: 'insufficient-progress', before: 1000, after: 950 }
    const p1 = nextAutoPause(null, ip, 1000, '2026-11-01T01:00:00.000Z', '2026-11-01')
    assert.equal(p1.count, 1); assert.equal(p1.lastRatio, 0.05); assert.equal(p1.baselineChars, 1000)
    assert.equal(p1.lastInputChars, 1000); assert.equal(p1.lastAfterChars, 950); assert.equal(p1.since, '2026-11-01T01:00:00.000Z')
    const p2 = nextAutoPause(p1, ip, 1000, '2026-11-02T01:00:00.000Z', '2026-11-02')
    assert.equal(p2.count, 2); assert.equal(p2.since, p1.since, 'since 保留首次时间'); assert.equal(p2.lastDay, '2026-11-02')
    for (const code of ['fidelity', 'validation', 'timeout', 'llm-truncated', 'unknown-error']) {
      assert.equal(nextAutoPause(p1, { ok: false, errorCode: code }, 1000, 'x', 'd'), p1, code + ' 不计数也不清零')
    }
    assert.equal(nextAutoPause(p2, { ok: true }, 1000, 'x', 'd'), null, '成功清零')
    assert.equal(nextAutoPause(null, { ok: false, errorCode: 'fidelity' }, 1000, 'x', 'd'), null)
  })
  await test('纯函数：状态/解除/投影', () => {
    const p = { count: 2, baselineChars: 1000, lastRatio: 0.03, lastDay: '2026-11-02', lastAt: '2026-11-02T01:00:00.000Z', since: '2026-11-01T01:00:00.000Z' }
    assert.equal(autoPauseState(null, 1000, 500).state, 'none')
    assert.equal(autoPauseState({ ...p, count: 1 }, 1000, 500).state, 'counting')
    assert.equal(autoPauseState(p, 1000, 500).state, 'paused')
    assert.equal(autoPauseState(p, 1149, 500).state, 'paused', '变化 <15% 仍停手')
    assert.deepEqual(autoPauseState(p, 1150, 500), { state: 'released', reason: 'library-changed' })
    assert.deepEqual(autoPauseState(p, 850, 500), { state: 'released', reason: 'library-changed' }, '缩小同样解除')
    assert.deepEqual(autoPauseState(p, 500, 500), { state: 'released', reason: 'under-threshold' })
    assert.equal(COMPACT_AUTOPAUSE_AFTER, 2); assert.equal(COMPACT_AUTOPAUSE_RELEASE_DELTA, 0.15)
    const v = autoPauseView(p, 1000, 500)
    assert.equal(v.paused, true); assert.equal(v.count, 2); assert.equal(v.lastRatio, 0.03); assert.equal(v.releaseDelta, 0.15)
    assert.equal(autoPauseView(p, 2000, 500).paused, false, '库已变化：面板不再显示暂停')
    assert.equal(autoPauseView(null, 1000, 500), null)
    assert.ok(!JSON.stringify(v).includes('text'), '投影只含数字与日期')
  })
  await test('共用判定 compactProgressOk：达标或缩短 ≥10%', () => {
    assert.equal(compactProgressOk(10000, 9500, 12000), true, '已 ≤ 阈值')
    assert.equal(compactProgressOk(20000, 19000, 12000), false)
    assert.equal(compactProgressOk(20000, 18000, 12000), true, '恰缩 10%')
    assert.equal(compactProgressOk(20000, NaN, 12000), false)
  })

  // ---------- 端到端（直接驱动 compactMemoryIfOver）----------
  const plugin = join(root, 'plugin'); mkdirSync(join(plugin, 'lib'), { recursive: true })
  for (const f of readdirSync(new URL('../lib/', import.meta.url))) if (f.endsWith('.js')) copyFileSync(new URL('../lib/' + f, import.meta.url), join(plugin, 'lib', f))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }))
  const { compactMemoryIfOver } = await import(pathToFileURL(join(plugin, 'lib/index.js')))
  const mk = (n, bodyLen) => '# 项目长期记忆\n\n' + Array.from({ length: n }, (_, i) => '<!-- tags: 测试' + i + ' / date: 2026-01-01 / importance: high -->\n## 条目' + i + '\n' + '事'.repeat(bodyLen) + '\n\n').join('')
  const shrink = (text, ratio) => text.split('\n').map(l => (!l || l.startsWith('#') || l.startsWith('<!--')) ? l : l.slice(0, Math.max(1, Math.floor(l.length * ratio)))).join('\n')
  const inputOf = o => {
    const full = o.messages[0].content[0].text
    let input = JSON.parse(full.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text
    return input.split('\n\n--- 上次输出')[0].replace(/^--- MEMORY\.md 全文 ---\n/, '')
  }
  const makeLlm = (ratio, calls, truncate) => ({ stream: async function* (o) {
    calls.push(o)
    yield { type: 'text-delta', text: truncate ? '截' : shrink(inputOf(o), ratio) }; yield { type: 'finish', reason: truncate ? 'max-tokens' : 'stop' }
  } })
  const dc = { provider: 'fixture', model: 'fixture', timeoutMs: 1000 }
  const small = { memoryCharThreshold: 2000, compactMaxTokens: 8000 }
  const single = mk(12, 400)
  let seq = 0
  // 一个工作区的连续「逻辑日」：每次先把日锁改成更早日期，模拟下一天
  function ws(raw = single, config = small) {
    const name = 'w' + (++seq), dir = join(root, name); mkdirSync(dir)
    const path = join(dir, 'MEMORY.md'); writeFileSync(path, raw)
    writeFileSync(join(dir, 'memory-sink-retained.json'), JSON.stringify([...splitSinkEntries(raw).entries, ...splitSinkEntries(mk(12, 420)).entries].map(e => sinkKey(e.text))))
    const markers = {}
    const st = { name, dir, path, markers, calls: [] }
    st.day = async ({ ratio = 0.98, truncate = false, opts = {}, cfg = config } = {}) => {
      if (markers[name]?.__compact__) markers[name].__compact__.day = '2000-01-0' + (1 + (seq % 8))
      const before = st.calls.length
      const result = await compactMemoryIfOver(makeLlm(ratio, st.calls, truncate), cfg, dc, name, dir, markers, opts)
      return { result, newCalls: st.calls.length - before }
    }
    st.ap = () => markers[name]?.__compact__?.autoPause
    return st
  }

  await test('连续 2 次进展不足 → 暂停；第 3 次不调用模型、不改原文；记录 skippedDay', async () => {
    const w = ws()
    let r = await w.day()
    assert.equal(r.result.errorCode, 'insufficient-progress'); assert.ok(r.newCalls >= 1)
    assert.equal(w.ap().count, 1); assert.equal(w.ap().baselineChars, single.length)
    assert.equal(w.ap().lastInputChars, single.length); assert.ok(w.ap().lastAfterChars > single.length * 0.9)
    assert.ok(w.ap().lastRatio > 0 && w.ap().lastRatio < 0.1); assert.ok(w.ap().since && w.ap().lastAt)
    r = await w.day(); assert.equal(r.result.errorCode, 'insufficient-progress'); assert.equal(w.ap().count, 2)
    assert.equal(readFileSync(w.path, 'utf8'), single, '拒收：原文不变')
    const rec = JSON.stringify(w.markers[w.name].__compact__)
    r = await w.day()
    assert.equal(r.newCalls, 0, '第 3 次零模型调用'); assert.equal(r.result.sink.count, 0); assert.equal(r.result.ok, false)
    assert.equal(w.ap().count, 2)
    assert.equal(readFileSync(w.path, 'utf8'), single)
    const after = w.markers[w.name].__compact__
    assert.equal(after.errorCode, 'insufficient-progress', '最近一次整理记录保留')
    assert.equal(after.autoPause.count, 2)
    assert.ok(JSON.parse(rec).autoPause.count === 2)
    r = await w.day(); assert.equal(r.newCalls, 0, '之后每个逻辑日仍跳过')
  })

  await test('释放①：手动整理（force）开始即清除，且手动失败不计数', async () => {
    const w = ws(); await w.day(); await w.day(); assert.equal(w.ap().count, 2)
    const r = await w.day({ opts: { force: true }, ratio: 0.98 })
    assert.ok(r.newCalls >= 1, '手动绕过停手')
    assert.equal(w.ap(), undefined, '手动清除且不计入新的一次')
    const r2 = await w.day()
    assert.equal(w.ap().count, 1, '清除后自动重新计数')
    assert.ok(r2.newCalls >= 1)
  })

  await test('释放②：库字符数变化 ≥15%（增/减）→ 清除并重新尝试', async () => {
    for (const next of [mk(16, 400), mk(9, 400)]) {
      const w = ws(); await w.day(); await w.day(); assert.equal(w.ap().count, 2)
      writeFileSync(w.path, next)
      const r = await w.day()
      assert.ok(r.newCalls >= 1, '变化后调用模型：' + next.length + ' vs ' + single.length)
      assert.equal(w.ap().count, 1, '清除后重新从 1 计数')
      assert.equal(w.ap().baselineChars, next.length)
    }
    const w = ws(); await w.day(); await w.day()
    writeFileSync(w.path, mk(12, 420)) // 约 +4.5% < 15%
    const r = await w.day(); assert.equal(r.newCalls, 0, '变化 <15% 仍停手')
  })

  await test('释放③：库 ≤ 阈值 → 清除状态（不调用模型）', async () => {
    const w = ws(); await w.day(); await w.day()
    writeFileSync(w.path, '# 项目长期记忆\n\n## 短\n内容\n')
    const r = await w.day(); assert.equal(r.result, null); assert.equal(r.newCalls, 0)
    assert.equal(w.ap(), undefined, '已清除')
    writeFileSync(w.path, single) // 再长回来：从头计数
    await w.day(); assert.equal(w.ap().count, 1)
  })

  await test('成功接受后计数清零', async () => {
    const w = ws(); await w.day(); assert.equal(w.ap().count, 1)
    const r = await w.day({ ratio: 0.3 }); assert.equal(r.result.ok, true)
    assert.equal(w.ap(), undefined)
    assert.ok(readFileSync(w.path, 'utf8').length < single.length)
  })

  await test('非 insufficient-progress 失败（截断）既不计数也不清零', async () => {
    const w = ws(); await w.day(); assert.equal(w.ap().count, 1)
    const r = await w.day({ truncate: true }); assert.notEqual(r.result.errorCode, 'insufficient-progress'); assert.equal(r.result.ok, false)
    assert.equal(w.ap().count, 1, '保留')
    await w.day(); assert.equal(w.ap().count, 2, '之后第二次进展不足仍达到暂停')
  })

  await test('批路径同样计数/暂停（共用判定）', async () => {
    const big = mk(34, 650), cfg = { memoryCharThreshold: 12000, compactMaxTokens: 16000 }
    const w = ws(big, cfg)
    let r = await w.day({ ratio: 0.97 }); assert.equal(r.result.errorCode, 'insufficient-progress'); assert.equal(w.ap().count, 1)
    r = await w.day({ ratio: 0.97 }); assert.equal(w.ap().count, 2)
    r = await w.day({ ratio: 0.97 }); assert.equal(r.newCalls, 0); assert.equal(r.result.sink.count, 0)
  })

  // ---------- 路由：状态 API 与手动整理 ----------
  const hash = t => createHash('sha256').update(t).digest('hex')
  const proot = join(root, 'route'), wsroot = join(proot, 'ws'), rplugin = join(proot, 'plugin')
  mkdirSync(join(rplugin, 'lib'), { recursive: true })
  for (const f of readdirSync(new URL('../lib/', import.meta.url))) if (f.endsWith('.js')) copyFileSync(new URL('../lib/' + f, import.meta.url), join(rplugin, 'lib', f))
  writeFileSync(join(rplugin, 'package.json'), JSON.stringify({ type: 'module' }))
  const cfg = { enabled: true, workspaceRoot: wsroot, activeProject: 'A', autoDistill: false, autoCompact: false, memoryCharThreshold: 12000, compactProvider: 'fixture', compactModel: 'fixture-model', compactMaxTokens: 8000 }
  writeFileSync(join(rplugin, 'config.json'), JSON.stringify(cfg))
  const raw = mk(20, 700), memPath = join(wsroot, 'A', '.workbuddy', 'memory', 'MEMORY.md')
  mkdirSync(join(wsroot, 'A', '.workbuddy', 'memory'), { recursive: true }); writeFileSync(memPath, raw)
  const pause = { since: '2026-11-12T01:00:00.000Z', count: 2, lastAt: '2026-11-13T01:00:00.000Z', lastDay: '2026-11-13', lastInputChars: raw.length, lastAfterChars: raw.length - 100, lastRatio: 0.0049, baselineChars: raw.length }
  const dpath = join(rplugin, 'distilled.json')
  writeFileSync(dpath, JSON.stringify({ A: { __compact__: { day: '2026-11-13', at: pause.lastAt, ok: false, errorCode: 'insufficient-progress', before: raw.length, after: raw.length - 100, autoPause: pause } } }))
  const routes = new Map(); let verdict
  const llm = { listProviders: () => ['fixture'], stream: async function* (o) { yield { type: 'text-delta', text: shrink(inputOf(o), 0.3) }; yield { type: 'finish', reason: 'stop' } } }
  const host = { connection: { requestRejection: () => verdict }, webServer: { register: r => routes.set(r.path, r.handler) }, effect: fn => fn() }
  const idx = await import(pathToFileURL(join(rplugin, 'lib/index.js')))
  idx.apply({ inject: (deps, fn) => { if (deps.includes('webServer')) fn(host); else if (deps.includes('llm')) fn({ llm }) }, effect: () => {} })
  async function request(path, body, method = 'POST') {
    const url = new URL(path, 'http://localhost:3190'), handler = routes.get(url.pathname); assert.equal(typeof handler, 'function', path)
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); Object.assign(req, { url: path, method, headers: { host: 'localhost:3190', origin: 'http://localhost:3190' } })
    let status, data; await handler(req, { writeHead: s => status = s, end: b => data = JSON.parse(b) }); return { status, data }
  }
  await test('状态 API 携带 compactAutoPause；库变化后 paused=false', async () => {
    const s = (await request('/api/wb-memory/status?workspace=A', undefined, 'GET')).data
    assert.equal(s.compactAutoPause.paused, true); assert.equal(s.compactAutoPause.count, 2); assert.equal(s.compactAutoPause.lastDay, '2026-11-13')
    assert.equal(s.compactAutoPause.lastRatio, 0.0049); assert.equal(s.compactAutoPause.releaseDelta, 0.15)
    assert.equal(s.compact.errorCode, 'insufficient-progress')
    writeFileSync(memPath, mk(30, 700))
    const s2 = (await request('/api/wb-memory/status?workspace=A', undefined, 'GET')).data
    assert.equal(s2.compactAutoPause.paused, false)
    writeFileSync(memPath, raw)
  })
  await test('手动整理路由：清除暂停并写回；之后状态无暂停', async () => {
    const r = await request('/api/wb-memory/compact-manual', { workspace: 'A', expectedRevision: hash(raw), confirmed: true })
    assert.equal(r.status, 200); assert.equal(r.data.ok, true, JSON.stringify(r.data).slice(0, 300))
    const d = JSON.parse(readFileSync(dpath, 'utf8'))
    assert.equal(d.A.__compact__.autoPause, undefined, '手动整理后落盘无暂停')
    const s = (await request('/api/wb-memory/status?workspace=A', undefined, 'GET')).data
    assert.equal(s.compactAutoPause, null)
  })
  await test('冷存坏尾不影响状态与热存搜索', async () => {
    const archive=join(wsroot,'A','.workbuddy','memory','MEMORY-archive.md')
    const block='## 冷存条目\n内容\n'
    writeFileSync(archive,'# 冷存记忆\n<!-- wb-sunk: 2026-11-20 length='+block.length+' -->\n'+block+'外部文本\n')
    const s=await request('/api/wb-memory/status?workspace=A',undefined,'GET')
    assert.equal(s.status,200);assert.equal(s.data.cold.count,1);assert.ok(s.data.cold.error)
    const cold=await request('/api/wb-memory/cold?workspace=A',undefined,'GET')
    assert.equal(cold.status,200);assert.equal(cold.data.entries.length,1);assert.ok(cold.data.warning)
    const search=await request('/api/wb-memory/search?workspace=A&q='+encodeURIComponent('条目1'),undefined,'GET')
    assert.equal(search.status,200);assert.ok(search.data.results.some(e=>e.source==='长期'))
  })
  console.log('compact-autopause: ' + passed + ' passed')
} finally {
  delete globalThis.__wbMemoryLlm; delete globalThis.__wbMemoryCtx
  assert.equal(realpathSync(root), root); rmSync(root, { recursive: true, force: true })
}
