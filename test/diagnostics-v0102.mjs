// 0.10.0 真实路由隔离验收：分块/追加/崩溃幂等/来源变化/串行。
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_COPY = resolve(HERE, '..')
const SRC_LIB = process.env.WB_MEM_SRC ? resolve(process.env.WB_MEM_SRC) : join(PLUGIN_COPY, 'lib')
const SRC_PKG = existsSync(join(SRC_LIB, '..', 'package.json')) ? join(SRC_LIB, '..', 'package.json') : join(PLUGIN_COPY, 'package.json')
const TMP_ROOT = join(PLUGIN_COPY, '.tmp')
const KEEP = process.env.WB_MEM_KEEP === '1'
const ENV_BACKUP = process.env.DSH_WORKSPACE_ROOT

const WS = 'RGWs'
const OLD_DATE = '2020-01-02'

// ---------------------------------------------------------------- 结果记账
const scenarios = []
let cur = null
function begin(name) { cur = { name, fails: [], notes: [] } }
function end() { scenarios.push(cur); cur = null }
function A(cond, label, detail) { if (!cond) cur.fails.push(label + (detail === undefined ? '' : ' [' + detail + ']')) }
function note(s) { cur.notes.push(s) }

// ---------------------------------------------------------------- mock llm
// resp 规格：{ text, finish, throw }
//   finish 省略 / 'stop'                              -> 旧版字符串 reason（smoke.mjs 的假 llm 风格）
//   finish: 'error' | 'aborted' | 'max-tokens'        -> 旧版字符串 reason
//   finish: { kind: 'error', failure: { code, message } } -> 新版对象 reason（真实宿主行为）
//   finish: 'none'                                    -> 完全不发 finish chunk（流被截断/中止）
function resp(text, finish) { return { text, finish } }

function mockLlm(queue) {
  const st = { calls: [] }
  const llm = {
    listProviders: () => [{ id: 'mockprov', models: ['mock-model'] }],
    stream: async function* (options) {
      const spec = queue.length > 1 ? queue.shift() : queue[0]
      st.calls.push({ maxTokens: options.maxTokens, model: options.model, provider: options.provider })
      if (!spec) return
      if (spec.throw) throw new Error(spec.throw)
      if (spec.text) yield { type: 'text-delta', text: spec.text }
      const fin = spec.finish === undefined ? 'stop' : spec.finish
      if (fin !== 'none' && fin !== false) yield { type: 'finish', reason: fin }
    },
  }
  return { llm, st }
}

// ---------------------------------------------------------------- 沙箱
let seq = 0
function mkSandbox(queue) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '') + '-' + (++seq)
  const root = join(TMP_ROOT, stamp + '-' + Math.random().toString(36).slice(2, 6))
  const pluginDir = join(root, 'plugin')
  mkdirSync(join(pluginDir, 'lib'), { recursive: true })
  for (const f of readdirSync(SRC_LIB)) {
    const full = join(SRC_LIB, f)
    if (!statSync(full).isFile()) continue
    copyFileSync(full, join(pluginDir, 'lib', f))
  }
  try { copyFileSync(SRC_PKG, join(pluginDir, 'package.json')) } catch {}

  const wsRoot = join(root, 'wsroot')
  const memDir = join(wsRoot, WS, '.workbuddy', 'memory')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, OLD_DATE + '.md'), '# ' + OLD_DATE + ' 日志（含自动流水）\n- 09:00【自动】mock 日志：蒸馏回归测试用的一行流水\n', 'utf8')
  writeFileSync(join(pluginDir, 'config.json'), JSON.stringify({
    enabled: true,
    autoDistill: true,
    distillProvider: 'mockprov',
    distillModel: 'mock-model',
    dayBoundaryHour: 0,
    memoryCharThreshold: 8000,
    dupThreshold: 0.45,
    sessionSummary: true,
    summaryIdleMs: 60,
    summaryMinUserChars: 300,
    summaryMaxPerDay: 8,
    distillIntervalMs: 3600000,
    distillStartDelayMs: 60000,
  }, null, 2), 'utf8')

  const { llm, st } = mockLlm(queue)
  const injections = []
  const effects = []
  const listeners = {}
  const routes = []
  const ctx = {
    inject: (deps, cb) => injections.push({ deps, cb }),
    effect: (fn, label) => effects.push({ fn, label }),
    on: (ev, fn) => { (listeners[ev] || (listeners[ev] = [])).push(fn); return () => {} },
  }
  return { root, pluginDir, wsRoot, memDir, llm, st, ctx, injections, effects, listeners, routes }
}

async function boot(sb) {
  process.env.DSH_WORKSPACE_ROOT = sb.wsRoot
  const href = pathToFileURL(join(sb.pluginDir, 'lib', 'index.js')).href
  const idx = await import(href + '?v=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  idx.apply(sb.ctx)
  for (const inj of sb.injections) {
    if (inj.deps.includes('llm')) inj.cb({ llm: sb.llm })
    else if (inj.deps.includes('systemPrompt')) { try { inj.cb({ systemPrompt: { context: () => {} } }) } catch {} }
    else if (inj.deps.includes('webServer')) {
      inj.cb({
        effect: (fn) => { fn(); return () => {} },
        webServer: { register: (r) => { sb.routes.push(r); return () => {} } },
      })
    }
  }
  sb.idx = idx
  return idx
}

function runEffect(sb, needle) {
  for (const ef of sb.effects) if (String(ef.label || '').includes(needle)) { ef.fn(); return true }
  return false
}

// 手动提炼 = 真实面板入口（GET /wb-memory/distill?wait=1）
async function callDistill(sb) {
  const route = sb.routes.find((r) => r.path === '/wb-memory/distill')
  if (!route) throw new Error('/wb-memory/distill 路由未注册')
  const res = { status: 0, body: '' }
  res.writeHead = (s) => { res.status = s }
  res.end = (b) => { res.body = b }
  await route.handler({ method: 'GET', url: '/wb-memory/distill?wait=1' }, res)
  return { status: res.status, json: JSON.parse(res.body || '{}') }
}

// ---------------------------------------------------------------- 观测器
function readMarkers(sb) {
  try { return JSON.parse(readFileSync(join(sb.pluginDir, 'distilled.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}
function dateMarker(sb, date) {
  const m = readMarkers(sb)
  return m && m[WS] ? m[WS][date] : undefined
}
function memRaw(sb) { try { return readFileSync(join(sb.memDir, 'MEMORY.md'), 'utf8') } catch { return null } }
function compactMarker(sb) {
  const m = readMarkers(sb)
  return m && m[WS] ? m[WS].__compact__ : undefined
}
function cleanup(sb) { if (!KEEP) { try { rmSync(sb.root, { recursive: true, force: true }) } catch {} } }
function config(sb, changes) {
  const p = join(sb.pluginDir, 'config.json')
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p)), ...changes }))
}
const ENTRY = '<!-- tags: 独立实验 / date: 2020-01-02 / importance: high -->\n## Windows外部沙箱边界\n命令执行隔离与工作区文件授权为不同层级，应优先定位具体受限操作。'

const { strict: assert } = await import('node:assert')
let passed = 0, failed = 0
async function check(name, fn) { try { await fn(); passed++; console.log('PASS ' + name) } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message) } }
const secret = 'PRIVATE_INPUT_7823 Bearer PRIVATE_CREDENTIAL_9462'
const cases = [
  ['truncated', { text: secret, finish: 'max-tokens' }, 'truncated', 'llm-truncated'],
  ['missing', { text: secret, finish: 'none' }, 'missing', 'llm-missing'],
  ['empty', { text: '', finish: 'stop' }, 'ok', 'empty-output'],
  ['invalid', { text: secret, finish: 'stop' }, 'ok', 'invalid-output'],
  ['error', { text: secret, finish: { kind: 'error', failure: { code: 'TRANSPORT', message: secret } } }, 'error', 'llm-error'],
  ['throw', { throw: secret }, 'missing', 'unknown-error'],
  ['zero', resp('（空，什么都不写）'), 'ok', null],
  ['success', resp(ENTRY), 'ok', null],
]
for (const [name, spec, finish, reason] of cases) await check(name, async () => {
  const sb = mkSandbox([spec])
  try {
    await boot(sb); await callDistill(sb)
    const p = join(sb.pluginDir, 'distill-diagnostics.json')
    assert.ok(existsSync(p), '真实调用路径必须留下诊断')
    const raw = readFileSync(p, 'utf8'), d = JSON.parse(raw)
    assert.ok(!raw.includes('PRIVATE_') && !raw.includes('Bearer'), '不能记录正文或错误原文')
    const model = d.events.find(e => e.type === 'model' && e.phase === 'end')
    assert.equal(model.finish, finish)
    if (name === 'throw') assert.equal(model.reason, 'stream-error')
    if (name === 'error') assert.equal(model.failureCode, 'TRANSPORT')
    assert.equal(model.workspace, WS)
    assert.equal(model.date, OLD_DATE)
    assert.equal(model.maxTokens, 2000)
    assert.equal(typeof model.outputChars, 'number')
    const block = d.events.find(e => e.type === 'block' && e.phase === 'end')
    assert.equal(block.reason || null, reason)
    assert.equal(block.status, reason ? 'failed' : 'committed')
    assert.equal(Boolean(dateMarker(sb, OLD_DATE)), !reason, '诊断不能使失败推进游标')
    assert.equal(d.lastSweepEnd.type, 'sweep')
    assert.equal(d.lastSweepEnd.failed, reason ? 1 : 0)
    assert.equal(model.sweepId, block.sweepId)
    assert.equal(model.blockId, block.blockId)
    const route = sb.routes.find(r => r.path === '/wb-memory/status')
    const res = { writeHead() {}, end(b) { this.body = b } }
    const before = readFileSync(p, 'utf8')
    await route.handler({ method: 'GET', url: '/wb-memory/status?workspace=' + WS }, res)
    assert.equal(JSON.parse(res.body).diagnostics.scope, 'global')
    assert.equal(readFileSync(p, 'utf8'), before, 'GET不能写诊断')
  } finally { cleanup(sb) }
})
await check('disabled 与 provider-not-ready 跳过也留证据', async () => {
  const sb = mkSandbox([resp(ENTRY)])
  try {
    config(sb, { enabled: false }); await boot(sb); await callDistill(sb)
    let d = JSON.parse(readFileSync(join(sb.pluginDir, 'distill-diagnostics.json')))
    assert.equal(d.lastSweepEnd.reason, 'disabled')
    config(sb, { enabled: true, distillProvider: 'not-registered' }); await callDistill(sb)
    d = JSON.parse(readFileSync(join(sb.pluginDir, 'distill-diagnostics.json')))
    assert.equal(d.lastSweepEnd.reason, 'provider-not-ready')
    assert.equal(sb.st.calls.length, 0)
  } finally { cleanup(sb) }
})
await check('诊断写入失败不改变提炼成功结果', async () => {
  const sb = mkSandbox([resp(ENTRY)])
  try {
    mkdirSync(join(sb.pluginDir, 'distill-diagnostics.json'))
    await boot(sb); await callDistill(sb)
    assert.ok(dateMarker(sb, OLD_DATE)); assert.ok(memRaw(sb).includes('Windows外部沙箱边界'))
    const route = sb.routes.find(r => r.path === '/wb-memory/status')
    const res = { writeHead() {}, end(b) { this.body = b } }
    await route.handler({ method: 'GET', url: '/wb-memory/status?workspace=' + WS }, res)
    assert.equal(JSON.parse(res.body).diagnostics.writeFailed, true)
  } finally { cleanup(sb) }
})

await check('有界保留、重启回读、坏状态和未知字段丢弃', async () => {
  const { createDistillDiagnostics } = await import('../lib/distill-diagnostics.js')
  const sb = mkSandbox([])
  try {
    const p = join(sb.root, 'unit-diagnostic.json'), d = createDistillDiagnostics(p)
    assert.equal(d.snapshot().events.length, 0); assert.equal(existsSync(p), false)
    d.record({ type: 'sweep', phase: 'start', status: 'running', sweepId: 'first' })
    for (let i = 0; i < 100; i++) d.record({ type: 'model', phase: 'end', status: 'failed', finish: 'error', outputChars: i, text: secret, message: secret, failureCode: secret })
    assert.equal(d.snapshot().events.length, 64)
    assert.equal(d.snapshot().lastSweepStart.sweepId, 'first')
    assert.ok(!readFileSync(p, 'utf8').includes('PRIVATE_'))
    const restored = createDistillDiagnostics(p).snapshot()
    assert.equal(restored.events.length, 64); assert.equal(restored.lastSweepStart.sweepId, 'first')
    writeFileSync(p, 'null'); const broken = createDistillDiagnostics(p)
    assert.equal(broken.snapshot().readFailed, true); broken.record({ type: 'sweep', phase: 'start', status: 'running' })
    assert.equal(JSON.parse(readFileSync(p)).events.length, 1)
    writeFileSync(p, 'x'.repeat(262145)); assert.equal(createDistillDiagnostics(p).snapshot().readFailed, true)
  } finally { cleanup(sb) }
})
await check('预算耗尽仍记录后排工作区尚未调用', async () => {
  const sb = mkSandbox([resp('（空，什么都不写）')])
  try {
    for (const name of ['ZZQueue1', 'ZZQueue2']) {
      const dir = join(sb.wsRoot, name, '.workbuddy', 'memory'); mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, OLD_DATE + '.md'), '# 日志\n- 完整记录\n')
    }
    config(sb, { distillMaxBlocksPerSweep: 1 }); await boot(sb); await callDistill(sb)
    const d = JSON.parse(readFileSync(join(sb.pluginDir, 'distill-diagnostics.json')))
    assert.equal(sb.st.calls.length, 1); assert.equal(d.lastSweepEnd.deferredDates, 2)
    assert.ok(d.events.some(e => e.type === 'queue' && e.workspace === 'ZZQueue2' && e.budgetRemaining === 0))
  } finally { cleanup(sb) }
})
await check('自然启动首扫即使provider未就绪也留证据', async () => {
  const sb = mkSandbox([])
  const realTimeout = globalThis.setTimeout, realInterval = globalThis.setInterval
  let callback
  try {
    config(sb, { distillProvider: 'not-registered' }); await boot(sb)
    globalThis.setTimeout = (fn) => { callback = fn; return null }
    globalThis.setInterval = () => null
    assert.equal(runEffect(sb, 'auto-distill scheduler'), true)
    globalThis.setTimeout = realTimeout; globalThis.setInterval = realInterval
    callback(); await new Promise(resolve => realTimeout(resolve, 5))
    const d = JSON.parse(readFileSync(join(sb.pluginDir, 'distill-diagnostics.json')))
    assert.equal(d.lastSweepEnd.manual, false); assert.equal(d.lastSweepEnd.reason, 'provider-not-ready')
  } finally { globalThis.setTimeout = realTimeout; globalThis.setInterval = realInterval; cleanup(sb) }
})

await check('游标落盘失败与源改动拒收分别可辨', async () => {
  for (const markerFailure of [true, false]) {
    const sb = mkSandbox([resp(ENTRY)])
    try {
      if (markerFailure) mkdirSync(join(sb.pluginDir, 'distilled.json'))
      else {
        const original = sb.llm.stream
        sb.llm.stream = async function* (opts) { yield* original(opts); writeFileSync(join(sb.memDir, OLD_DATE + '.md'), '# source edited\n') }
      }
      await boot(sb); await callDistill(sb)
      const d = JSON.parse(readFileSync(join(sb.pluginDir, 'distill-diagnostics.json')))
      assert.equal(d.events.find(e => e.type === 'block' && e.phase === 'end').reason, markerFailure ? 'marker-write' : 'source-changed')
      assert.equal(d.lastSweepEnd.committed, 0); assert.equal(d.lastSweepEnd.failed, 1)
    } finally { cleanup(sb) }
  }
})
await check('并发busy不覆盖实际巡检起止摘要', async () => {
  const sb = mkSandbox([resp('（空，什么都不写）')])
  let release, began
  const started = new Promise(resolve => { began = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const original = sb.llm.stream
  sb.llm.stream = async function* (opts) { began(); await gate; yield* original(opts) }
  try {
    await boot(sb); const first = callDistill(sb); await started
    const busy = await callDistill(sb); assert.equal(busy.json.skipped, 'busy')
    release(); await first
    const d = JSON.parse(readFileSync(join(sb.pluginDir, 'distill-diagnostics.json')))
    assert.equal(d.lastSweepEnd.status, 'ok'); assert.equal(d.lastSweepEnd.sweepId, d.lastSweepStart.sweepId)
    assert.ok(d.events.some(e => e.reason === 'busy')); assert.equal(sb.st.calls.length, 1)
  } finally { release(); cleanup(sb) }
})
console.log('诊断补丁: ' + passed + ' passed / ' + failed + ' failed')
if (ENV_BACKUP === undefined) delete process.env.DSH_WORKSPACE_ROOT
else process.env.DSH_WORKSPACE_ROOT = ENV_BACKUP
if (failed) process.exitCode = 1
