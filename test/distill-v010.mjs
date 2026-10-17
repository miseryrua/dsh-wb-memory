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
try {
  begin('长日志分块，块数限额，断点续跑，已完成后追加')
  const sb = mkSandbox([resp('（空，什么都不写）')])
  config(sb, { distillMaxInputChars: 120, distillMaxBlocksPerSweep: 2 })
  const file = join(sb.memDir, OLD_DATE + '.md')
  const raw = '# 日志\n' + '- 一二三四五六七八九十\n'.repeat(120)
  writeFileSync(file, raw)
  await boot(sb); await callDistill(sb)
  A(sb.st.calls.length === 2, '单轮严格限制块数')
  A(dateMarker(sb, OLD_DATE).offset < raw.length, '未整日误标完成')
  for(let i=0;i<30 && dateMarker(sb, OLD_DATE).offset<raw.length;i++) await callDistill(sb)
  A(dateMarker(sb, OLD_DATE).offset === raw.length, '全部尾部已消费')
  const calls = sb.st.calls.length; await callDistill(sb)
  A(sb.st.calls.length === calls, '无新增不重复调用')
  writeFileSync(file, raw + '- 新增稳定流水\n'); await callDistill(sb)
  A(dateMarker(sb, OLD_DATE).offset === raw.length + '- 新增稳定流水\n'.length, '新增尾部续跑')
  A(sb.st.calls.length === calls + 1, '只调用新增块')
  A(memRaw(sb) === null, '明确零条不创建MEMORY')
  cleanup(sb); end()

  begin('崩溃窗口：MEMORY已提交，游标提交失败，重启靠回执不再调用模型')
  const crash = mkSandbox([resp(ENTRY)])
  mkdirSync(join(crash.pluginDir, 'distilled.json')) // 注入 rename 目标为目录的失败
  await boot(crash); await callDistill(crash)
  const committed = memRaw(crash)
  A(committed?.includes('wb-distill-batch:'), '正文与批次回执同时落盘')
  A(dateMarker(crash, OLD_DATE) === undefined, '失败游标未推进')
  // 删除已验证的隔离插件路径内故障目录，不涉及真实插件。
  const broken = join(crash.pluginDir, 'distilled.json')
  A(broken.startsWith(crash.root) && statSync(broken).isDirectory(), '故障路径校验')
  rmSync(broken, { recursive: true })
  const beforeCalls = crash.st.calls.length
  await boot(crash); await callDistill(crash)
  A(crash.st.calls.length === beforeCalls, '恢复不再次调用模型')
  A(memRaw(crash) === committed, '恢复不重复写正文')
  A(dateMarker(crash, OLD_DATE)?.done === true, '恢复完成游标提交')
  cleanup(crash); end()

  begin('推理窗口源前缀被编辑，失败不推进；下一轮可重试')
  const changed = mkSandbox([resp('（空，什么都不写）')])
  const changedFile = join(changed.memDir, OLD_DATE + '.md')
  changed.llm.stream = async function* () {
    writeFileSync(changedFile, '# 改过的日志\n- 更新后的内容\n')
    yield { type: 'text-delta', text: ENTRY }; yield { type: 'finish', reason: 'stop' }
  }
  await boot(changed); await callDistill(changed)
  A(memRaw(changed) === null, '来源变化拒绝正文')
  A(dateMarker(changed, OLD_DATE) === undefined, '来源变化游标不推进')
  changed.llm.stream = async function* () { yield { type:'text-delta', text:'（空，什么都不写）' }; yield {type:'finish', reason:'stop'} }
  await callDistill(changed)
  A(dateMarker(changed, OLD_DATE)?.done, '下一轮按新源成功处理')
  cleanup(changed); end()

  begin('巡检重入串行：正在推理时第二次请求不得重复调用')
  const serial = mkSandbox([resp('（空，什么都不写）')]); let release, entered
  const gate = new Promise(r => release=r), began = new Promise(r => entered=r)
  let concurrentCalls=0
  serial.llm.stream = async function* () { concurrentCalls++; entered(); await gate; yield {type:'text-delta',text:'（空，什么都不写）'}; yield {type:'finish',reason:'stop'} }
  await boot(serial)
  const running = callDistill(serial); await began
  await callDistill(serial); release(); await running
  A(concurrentCalls===1, '并行触发只执行一个模型任务')
  cleanup(serial); end()

  begin('当天闲置门槛、最小新增量和完成行续跑')
  const daily = mkSandbox([resp('（空，什么都不写）')])
  config(daily, { dailyDistillIdleMs: 1, dailyDistillMinChars: 30, distillMaxInputChars: 50 })
  const oldFile = join(daily.memDir, OLD_DATE + '.md')
  A(oldFile.startsWith(daily.root), '隔离旧日志路径验证'); rmSync(oldFile)
  await boot(daily)
  const day = daily.idx.logicalDayStamp({dayBoundaryHour:0})
  const dayFile = join(daily.memDir, day + '.md')
  writeFileSync(dayFile, '尾部未完成'.repeat(100))
  await callDistill(daily)
  A(daily.st.calls.length === 0, '超长未完成行不调用模型')
  writeFileSync(dayFile, '- 新增稳定流水足够长，可以当日分块提炼而不等待次日。\n'.repeat(10))
  // 为文件证明已经闲置，直接设置隔离样本mtime，无真实等待。
  const {utimesSync} = await import('node:fs')
  utimesSync(dayFile, new Date(Date.now()-10000), new Date(Date.now()-10000))
  await callDistill(daily)
  A(daily.st.calls.length > 0 && dateMarker(daily, day)?.offset > 0, '当天可提炼且游标推进')
  const beforeDaily = daily.st.calls.length
  config(daily, { dailyDistill: false }); await callDistill(daily)
  A(daily.st.calls.length === beforeDaily, '当天提炼关闭不再推进')
  cleanup(daily); end()

  begin('相同正文的不同日期，不能共享完成回执')
  const dates = mkSandbox([resp(ENTRY), resp('（空，什么都不写）')])
  const originalLog = readFileSync(join(dates.memDir, OLD_DATE + '.md'), 'utf8')
  writeFileSync(join(dates.memDir, '2020-01-03.md'), originalLog)
  await boot(dates); await callDistill(dates)
  A(dates.st.calls.length === 2, '每个日期分别提炼，正文相同也不跳过')
  A(dateMarker(dates, OLD_DATE)?.done && dateMarker(dates, '2020-01-03')?.done, '两个日期各自保存游标')
  cleanup(dates); end()
} finally {
  if (ENV_BACKUP === undefined) delete process.env.DSH_WORKSPACE_ROOT; else process.env.DSH_WORKSPACE_ROOT = ENV_BACKUP
}
let fails=0
for (const s of scenarios) { console.log((s.fails.length ? 'FAIL ' : 'PASS ') + s.name); for(const f of s.fails){ console.log('  '+f); fails++ } }
console.log('distill-v010: '+scenarios.length+' scenarios / '+fails+' failures')
if(fails) process.exitCode=1
