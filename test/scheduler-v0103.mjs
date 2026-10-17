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
        connection: { requestRejection: () => undefined }, // 已认证宿主夹具；负例由route-auth测试覆盖
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

// 手动提炼 = 真实面板入口（POST /api/wb-memory/distill?wait=1）
async function callDistill(sb) {
  const route = sb.routes.find((r) => r.path === '/api/wb-memory/distill')
  if (!route) throw new Error('/api/wb-memory/distill 路由未注册')
  const res = { status: 0, body: '' }
  res.writeHead = (s) => { res.status = s }
  res.end = (b) => { res.body = b }
  await route.handler({ method: 'POST', url: '/api/wb-memory/distill?wait=1', headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } }, res)
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
async function natural(sb) {
  const rt = globalThis.setTimeout, ri = globalThis.setInterval
  const old = diag(sb)?.lastSweepEnd?.sweepId
  let cb
  try {
    globalThis.setTimeout = fn => { cb = fn; return null }; globalThis.setInterval = () => null
    runEffect(sb, 'auto-distill scheduler')
  } finally { globalThis.setTimeout = rt; globalThis.setInterval = ri }
  cb()
  for (let i = 0; i < 200; i++) {
    const d = diag(sb)
    if (d?.lastSweepEnd?.sweepId && d.lastSweepEnd.sweepId !== old) return d
    await new Promise(resolve => rt(resolve, 1))
  }
  throw new Error('自然巡检未结束')
}
function diag(sb) { try { return JSON.parse(readFileSync(join(sb.pluginDir, 'distill-diagnostics.json'))) } catch { return null } }
function addWs(sb, ws) { const dir = join(sb.wsRoot, ws, '.workbuddy', 'memory'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, OLD_DATE + '.md'), '# 完整日志\n- 测试事实\n'); return dir }
async function reboot(sb) { sb.injections.length = 0; sb.effects.length = 0; sb.routes.length = 0; await boot(sb) }
await check('长日志不能在一轮内挤占另一工作区的第二个名额', async () => {
  const sb = mkSandbox([resp('（空，什么都不写）')])
  try {
    writeFileSync(join(sb.memDir, OLD_DATE + '.md'), ('- 稳定事实记录。\n').repeat(100)); addWs(sb, 'ZZTail')
    config(sb, { distillMaxBlocksPerSweep: 2, distillMaxInputChars: 60 }); await boot(sb); await callDistill(sb)
    assert.deepEqual(diag(sb).events.filter(e => e.type === 'block' && e.phase === 'start').map(e => e.workspace), [WS, 'ZZTail'])
    assert.equal(sb.st.calls.length, 2)
  } finally { cleanup(sb) }
})
await check('轮转位置在失败后和重启后仍保留', async () => {
  const sb = mkSandbox([resp('不是合法结构')])
  try {
    addWs(sb, 'ZZTail'); config(sb, { distillMaxBlocksPerSweep: 1 }); await boot(sb); await natural(sb); await reboot(sb); await natural(sb)
    const starts = diag(sb).events.filter(e => e.type === 'block' && e.phase === 'start')
    assert.deepEqual(starts.map(e => e.workspace), [WS, 'ZZTail'])
  } finally { cleanup(sb) }
})
await check('相同失败块自动退避且重启不能绕过，明确手动重试可旁路', async () => {
  const sb = mkSandbox([resp('格式错误')])
  try {
    await boot(sb); await natural(sb); await natural(sb); await reboot(sb); await natural(sb)
    assert.equal(sb.st.calls.length, 1)
    assert.ok(diag(sb).events.some(e => e.reason === 'retry-backoff'))
    await callDistill(sb); assert.equal(sb.st.calls.length, 2); assert.equal(dateMarker(sb, OLD_DATE), undefined)
  } finally { cleanup(sb) }
})
await check('同工作区日期也轮转，失败旧日不阻塞后日', async () => {
  const sb = mkSandbox([resp('格式错误')])
  try {
    writeFileSync(join(sb.memDir, '2020-01-03.md'), '# 次日日志\n- 另一事实\n')
    config(sb, { distillMaxBlocksPerSweep: 1 }); await boot(sb); await callDistill(sb); await callDistill(sb)
    assert.deepEqual(diag(sb).events.filter(e => e.type === 'block' && e.phase === 'start').map(e => e.date), [OLD_DATE, '2020-01-03'])
  } finally { cleanup(sb) }
})
await check('调度claim写盘失败则不发提炼模型请求', async () => {
  const sb = mkSandbox([resp(ENTRY)])
  try {
    mkdirSync(join(sb.pluginDir, 'distill-schedule.json')); await boot(sb); await natural(sb)
    assert.equal(sb.st.calls.length, 0); assert.equal(diag(sb).lastSweepEnd.reason, 'scheduler-write'); assert.equal(dateMarker(sb, OLD_DATE), undefined)
  } finally { cleanup(sb) }
})
for (const [output, issue] of [
  ['说明文字不是条目', 'missing-metadata'],
  ['<!-- tags: test', 'incomplete-metadata'],
  ['<!-- tags: test -->\n没有标题', 'missing-heading'],
  ['<!-- tags: test -->\n## 标题\n', 'missing-body'],
]) await check('结构拒收细分：' + issue, async () => {
  const sb = mkSandbox([resp(output)])
  try { await boot(sb); await callDistill(sb); assert.equal(diag(sb).events.find(e => e.type === 'block' && e.phase === 'end').outputIssue, issue); assert.equal(dateMarker(sb, OLD_DATE), undefined); assert.equal(memRaw(sb), null) } finally { cleanup(sb) }
})

await check('15工作区跨两轮覆盖所有工作区且每轮不超过8块', async () => {
  const sb = mkSandbox([resp('（空，什么都不写）')])
  try {
    writeFileSync(join(sb.memDir, OLD_DATE + '.md'), ('- 很长的稳定事实日志。\n').repeat(100))
    for (let n = 1; n < 15; n++) { const d = addWs(sb, 'ZZ' + String(n).padStart(2, '0')); writeFileSync(join(d, OLD_DATE + '.md'), ('- 很长的稳定事实日志。\n').repeat(100)) }
    config(sb, { distillMaxBlocksPerSweep: 8, distillMaxInputChars: 60 }); await boot(sb)
    const first = await natural(sb); assert.equal(first.lastSweepEnd.attempted, 8)
    const second = await natural(sb); assert.equal(second.lastSweepEnd.attempted, 8); assert.equal(sb.st.calls.length, 16)
    const all = second.events.filter(e => e.type === 'block' && e.phase === 'start')
    // 诊断64条有界，第二轮之前的事件可能被淘汰，因此联合首轮快照。
    assert.equal(new Set([...first.events, ...second.events].filter(e => e.type === 'block' && e.phase === 'start').map(e => e.workspace)).size, 15)
  } finally { cleanup(sb) }
})
await check('同轮失败日期不重复调用；内容和路由变化可在下轮立即重试', async () => {
  const sb = mkSandbox([resp('无效结构')])
  try {
    config(sb, { distillMaxBlocksPerSweep: 8 }); await boot(sb); await natural(sb); assert.equal(sb.st.calls.length, 1)
    writeFileSync(join(sb.memDir, OLD_DATE + '.md'), '# 编辑后的另一版本日志\n- 稳定变化\n'); await natural(sb); assert.equal(sb.st.calls.length, 2)
    config(sb, { distillModel: 'mock-model-2' }); await natural(sb); assert.equal(sb.st.calls.length, 3)
  } finally { cleanup(sb) }
})
await check('退避2h/4h封顶24h、精确到期、成功清理及有界坏状态恢复', async () => {
  const { createDistillSchedule } = await import('../lib/distill-schedule.js')
  const { fingerprint } = await import('../lib/distill-cursor.js')
  const sb = mkSandbox([])
  try {
    let clock = 2000000000000
    const file = join(sb.root, 'schedule.json'), meta = { workspace: WS, date: OLD_DATE, blockId: 'content-hash', provider: 'mockprov', model: 'mock-model' }
    let s = createDistillSchedule(file, { now: () => clock })
    assert.equal(existsSync(file), false); s.claim(meta, 'NextWs', '2020-01-03')
    assert.equal(s.retryAt(meta), clock + 7200000); assert.equal(s.retryAt({ ...meta, model: 'other' }), 0)
    assert.equal(s.retryAt({ ...meta, blockId: 'new-content' }), 0)
    s = createDistillSchedule(file, { now: () => clock }); assert.deepEqual(s.orderWorkspaces([WS, 'NextWs']), ['NextWs', WS])
    clock = s.retryAt(meta) - 1; assert.ok(s.retryAt(meta) > clock); clock++
    assert.equal(s.retryAt(meta), clock); s.claim(meta, WS, OLD_DATE); assert.equal(s.retryAt(meta), clock + 14400000)
    for (let n = 0; n < 8; n++) { clock = s.retryAt(meta); s.claim(meta, WS, OLD_DATE) }
    assert.equal(s.retryAt(meta), clock + 86400000)
    s.success(meta); assert.equal(s.retryAt(meta), 0)
    writeFileSync(file, 'null'); s = createDistillSchedule(file, { now: () => clock }); assert.equal(s.snapshot().readFailed, true); s.claim(meta, WS, OLD_DATE)
    const retries = {}; for (let n = 0; n < 3000; n++) retries[fingerprint('test' + n)] = { attempts: 1, at: clock, nextRetryAt: clock + 7200000 }
    const nextDates = Object.fromEntries(Array.from({ length: 600 }, (_, n) => ['ws' + n, OLD_DATE]))
    writeFileSync(file, JSON.stringify({ version: 1, nextWorkspace: WS, nextDates, retries, input: 'PRIVATE_BODY' }))
    s = createDistillSchedule(file, { now: () => clock }); assert.equal(s.snapshot().retryBlocks, 2048); s.claim(meta, WS, OLD_DATE)
    const persisted = JSON.parse(readFileSync(file)); assert.ok(Object.keys(persisted.nextDates).length <= 512); assert.equal(Object.keys(persisted.retries).length, 2048); assert.ok(!readFileSync(file, 'utf8').includes('PRIVATE_BODY'))
  } finally { cleanup(sb) }
})
await check('只有精确模型公告low时发送，查询失败/不支持时保持原参数', async () => {
  for (const mode of ['low', 'missing', 'lookup-error']) {
    const sb = mkSandbox([resp('（空，什么都不写）')])
    try {
      let seen; const stream = sb.llm.stream; sb.llm.stream = function(options) { seen = options; return stream(options) }
      sb.llm.resolveModelInfo = async (provider, model) => { assert.equal(provider, 'mockprov'); assert.equal(model, 'mock-model'); if (mode === 'lookup-error') throw new Error('PRIVATE_CAPABILITY_ERROR'); return mode === 'low' ? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } } : {} }
      await boot(sb); await natural(sb)
      assert.equal(seen.reasoningEffort, mode === 'low' ? 'low' : undefined); assert.equal(seen.maxTokens, 2000)
      const end = diag(sb).events.find(e => e.type === 'model' && e.phase === 'end')
      assert.equal(end.reasoningControl, mode === 'low' ? 'low' : mode === 'lookup-error' ? 'lookup-failed' : 'unavailable')
      assert.ok(!JSON.stringify(diag(sb)).includes('PRIVATE_CAPABILITY_ERROR'))
    } finally { cleanup(sb) }
  }
})
await check('能力查询忽略signal也须在超时后退出，不触发模型调用', async () => {
  const sb = mkSandbox([resp(ENTRY)])
  try {
    config(sb, { distillTimeoutMs: 15 }); sb.llm.resolveModelInfo = () => new Promise(() => {})
    await boot(sb); await natural(sb); assert.equal(sb.st.calls.length, 0)
    assert.equal(diag(sb).events.find(e => e.type === 'model' && e.phase === 'end').reason, 'timeout')
  } finally { cleanup(sb) }
})

await check('业务提交后清理冷却写失败，不倒退正文和消费游标', async () => {
  const sb = mkSandbox([resp(ENTRY)])
  try {
    const stream = sb.llm.stream
    sb.llm.stream = async function* (options) {
      yield* stream(options)
      const target = join(sb.pluginDir, 'distill-schedule.json')
      rmSync(target); mkdirSync(target)
    }
    await boot(sb); await natural(sb)
    assert.ok(dateMarker(sb, OLD_DATE)); assert.ok(memRaw(sb).includes('Windows外部沙箱边界'))
    assert.equal(diag(sb).lastSweepEnd.committed, 1); assert.equal(diag(sb).lastSweepEnd.failed, 0)
    assert.ok(diag(sb).events.some(e => e.reason === 'scheduler-write'))
    assert.equal(diag(sb).lastSweepEnd.status, 'partial')
  } finally { cleanup(sb) }
})
if (ENV_BACKUP === undefined) delete process.env.DSH_WORKSPACE_ROOT; else process.env.DSH_WORKSPACE_ROOT = ENV_BACKUP
console.log('调度补丁: ' + passed + ' passed / ' + failed + ' failed')
if (failed) process.exitCode = 1
