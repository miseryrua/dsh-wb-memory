import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { compactMemoryIfOver, coldWorkspace } from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'wb-slim-0143-'))
try {
  const file = dir => join(dir, 'MEMORY.md')
  const entry = i => '## 测试条目 ' + i + '\n' + '普通正文。'.repeat(60) + '\n\n'
  const raw = '# 长期记忆\n\n' + Array.from({ length: 12 }, (_, i) => entry(i)).join('')
  const cfg = { memoryCharThreshold: 200 }, dc = { provider: 'mock', model: 'mock' }
  let calls = 0
  const llm = { stream: async function* () { calls++; yield { type: 'finish', reason: 'max-tokens' } } }
  const dir = join(root, 'A'); mkdirSync(dir); writeFileSync(file(dir), raw)
  const markers = { A: { __compact__: { autoPause: { paused: true, count: 2, lastDay: '2026-11-22', lastRatio: 0.02, baselineChars: raw.length } } } }
  const run = (model, options) => compactMemoryIfOver(model, cfg, dc, 'A', dir, markers, options)
  const first = await run(llm)
  assert.equal(calls, 0)
  assert.equal(first.sink.count, 7)
  assert.equal(coldWorkspace(dir).entries.length, 7)
  assert.equal(first.newCount, 5)
  assert.ok(first.after > cfg.memoryCharThreshold)
  assert.equal(markers.A.__compact__.afterRevision, createHash('sha256').update(readFileSync(file(dir))).digest('hex'))
  assert.equal(Object.hasOwn(markers.A.__compact__, 'autoPause'), false)
  const originalRecord = structuredClone(markers.A.__compact__)
  const backups = readdirSync(join(dir, 'archive'))
  assert.equal(await run(null), null)
  assert.deepEqual(markers.A.__compact__, originalRecord)
  assert.deepEqual(readdirSync(join(dir, 'archive')), backups)
  writeFileSync(file(dir), readFileSync(file(dir), 'utf8') + entry(12) + entry(13))
  const second = await run(null)
  assert.equal(second.sink.day, first.sink.day)
  assert.equal(second.sink.count, 2)
  assert.equal(coldWorkspace(dir).entries.length, 9)
  await run(llm, { force: true })
  assert.equal(calls, 1)
  const failedManual = structuredClone(markers.A.__compact__)
  assert.equal(await run(null), null)
  assert.deepEqual(markers.A.__compact__, failedManual)
  const short = '# 长期记忆\n\n' + Array.from({ length: 6 }, (_, i) => '## 改写 ' + i + '\n' + '正文。'.repeat(15) + '\n\n').join('')
  const success = await run({ stream: async function* () { yield { type: 'text-delta', text: short }; yield { type: 'finish', reason: 'stop' } } }, { force: true })
  assert.equal(success.ok, true)
  assert.ok(readFileSync(file(dir), 'utf8').length > cfg.memoryCharThreshold)
  assert.ok(await run(null))

  async function race(name, checkpoint) {
    const home = join(root, name); mkdirSync(home); writeFileSync(file(home), raw)
    const state = { [name]: {} }
    const attempt = hook => compactMemoryIfOver(null, cfg, dc, name, home, state, { checkpoint: hook })
    const result = await attempt(stage => checkpoint(stage, home))
    assert.equal(state[name].__compact__?.afterRevision, undefined)
    assert.ok(await attempt(), name + ' 应重新判断')
    return result
  }
  const manualDir = join(root, 'manual-sink'); mkdirSync(manualDir); writeFileSync(file(manualDir), raw)
  const manualState = { A: {} }
  const echo = { stream: async function* () { yield { type: 'text-delta', text: raw }; yield { type: 'finish', reason: 'stop' } } }
  const manualSink = await compactMemoryIfOver(echo, cfg, dc, 'A', manualDir, manualState, { force: true })
  assert.equal(manualSink.sink.count, 7)
  const manualRecord = structuredClone(manualState.A.__compact__)
  assert.equal(await compactMemoryIfOver(null, cfg, dc, 'A', manualDir, manualState), null)
  assert.deepEqual(manualState.A.__compact__, manualRecord)
  const cleared = await race('cleared', (stage, home) => {
    if (stage === 'cleared') writeFileSync(file(home), readFileSync(file(home), 'utf8') + entry(40) + entry(41))
  })
  assert.equal(cleared.sink.count, 7)
  const coldRaw = readFileSync(join(dir, 'MEMORY-archive.md'), 'utf8')
  const collision = await race('before-cold', (stage, home) => {
    if (stage === 'before-cold') writeFileSync(join(home, 'MEMORY-archive.md'), coldRaw)
  })
  assert.ok(['sink-failed', 'conflict'].includes(collision.errorCode))
  const lib = new URL('../lib/', import.meta.url)
  for (const name of readdirSync(lib).filter(n => n.endsWith('.js'))) {
    const text = readFileSync(new URL(name, lib), 'utf8')
    assert.doesNotMatch(text, /(?:from|import)\s*[(]?\s*['"][^'"]*(memory-lifecycle|compact-autopause|cross-layer-|injection-sources|recall-eval|\/test\/)/, name)
  }
  const plugin = join(root, 'plugin'), wsroot = join(root, 'workspaces')
  cpSync(lib, join(plugin, 'lib'), { recursive: true })
  writeFileSync(join(plugin, 'package.json'), '{"type":"module"}')
  const memdir = join(wsroot, 'A', '.workbuddy', 'memory')
  mkdirSync(memdir, { recursive: true })
  const settings = { enabled: true, workspaceRoot: wsroot, activeProject: 'A', autoDistill: true, memoryCharThreshold: 200, compactMaxTokens: 8000 }
  const configPath = join(plugin, 'config.json')
  writeFileSync(configPath, JSON.stringify(settings))
  writeFileSync(file(memdir), raw)
  writeFileSync(join(plugin, 'distilled.json'), JSON.stringify({ A: { __compact__: { autoPause: { paused: true, count: 2, lastDay: '2026-11-22', lastRatio: 0.02, baselineChars: raw.length } } } }))
  const routes = new Map()
  const host = { connection: { requestRejection: () => undefined }, webServer: { register: r => routes.set(r.path, r.handler) }, effect: fn => fn() }
  const idx = await import(pathToFileURL(join(plugin, 'lib/index.js')))
  idx.apply({ inject: (deps, fn) => { if (deps.includes('webServer')) fn(host) }, effect: () => {} })
  async function request(path, method = 'GET', body) {
    const url = '/api/wb-memory/' + path
    const handler = routes.get(url.split('?')[0])
    assert.equal(typeof handler, 'function')
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    Object.assign(req, { url, method, headers: { host: 'localhost:3190', origin: 'http://localhost:3190' } })
    let status, data
    await handler(req, { writeHead: s => { status = s }, end: b => { data = JSON.parse(b) } })
    return { status, data }
  }
  assert.equal(routes.has('/api/wb-memory/recall-eval'), false)
  const listing = await request('memories?workspace=A&id=unknown&state=invalid')
  assert.equal(listing.status, 200)
  assert.deepEqual(Object.keys(listing.data).sort(), ['entries', 'offset', 'revision', 'total', 'workspace'])
  assert.deepEqual(Object.keys(listing.data.entries[0]).sort(), ['body', 'title'])
  assert.equal((await request('memories', 'POST', { workspace: 'A' })).status, 405)
  const status = await request('status?workspace=A')
  assert.equal(status.status, 200)
  assert.equal(Object.hasOwn(status.data, 'compactAutoPause'), false)
  const noModel = (await request('distill?wait=1', 'POST')).data
  assert.equal(noModel.skipped, 'no-model')
  assert.match(noModel.results['A/compact'], /已下沉 7 条/)
  writeFileSync(configPath, JSON.stringify({ ...settings, distillProvider: 'missing', distillModel: 'missing' }))
  writeFileSync(file(memdir), raw)
  const missing = (await request('distill?wait=1', 'POST')).data
  assert.equal(missing.skipped, 'provider-not-ready:missing (visible: [] llm service not injected yet)')
  assert.match(missing.results['A/compact'], /已下沉 7 条/)
  writeFileSync(file(memdir), '# 导言\n普通前言\n\n' + Array.from({ length: 26 }, (_, i) => '## 分页 ' + i + '\n\u0060\u0060\u0060md\n## 围栏不是条目\n\u0060\u0060\u0060\n').join(''))
  for (const [offset, length] of [[0, 25], [25, 1]]) {
    const page = await request('memories?workspace=A&offset=' + offset)
    assert.equal(page.status, 200)
    assert.equal(page.data.total, 26)
    assert.equal(page.data.entries.length, length)
    assert.equal(page.data.entries[0].title, '分页 ' + offset)
    assert.ok(page.data.entries.every(item => item.title.startsWith('分页 ')))
  }
  const markerPath = join(plugin, 'distilled.json')
  rmSync(markerPath, { force: true }); mkdirSync(markerPath)
  writeFileSync(configPath, JSON.stringify(settings))
  writeFileSync(file(memdir), raw)
  const markerFailure = (await request('distill?wait=1', 'POST')).data
  assert.equal(markerFailure.ok, true)
  assert.equal(markerFailure.skipped, 'no-model')
  assert.ok(markerFailure.markerError)
  const afterFailure = await request('status?workspace=A')
  assert.equal(afterFailure.status, 200)
  const diagnostics = JSON.parse(readFileSync(join(plugin, 'distill-diagnostics.json'), 'utf8'))
  assert.equal(diagnostics.lastSweepEnd.status, 'skipped')
  assert.equal(diagnostics.lastSweepEnd.reason, 'no-model')
  rmSync(markerPath, { recursive: true })
  const withMarker = '# 长期记忆\n\n## 测试条目\n<!-- wb-memory:example -->\n普通正文\n'
  const saved = await request('file', 'POST', { workspace: 'A', path: 'MEMORY.md', content: withMarker })
  assert.equal(saved.status, 200)
  assert.equal(readFileSync(file(memdir), 'utf8'), withMarker)
  assert.equal((await request('config', 'POST', { compactMaxTokens: 1 })).status, 200)
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(configPath, 'utf8')), 'compactMaxTokens'), false)
  console.log('slim-v0143：自动下沉、手动整理、只读路由、保存与退役设置通过')
} finally { rmSync(root, { recursive: true, force: true }) }
