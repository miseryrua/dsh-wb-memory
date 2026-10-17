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
function legacyAssert(cond, label, detail) { if (!cond) cur.fails.push(label + (detail === undefined ? '' : ' [' + detail + ']')) }
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

// 0.10.5：以真实源码解析器和真实apply隔离路由同时守住分隔与整批提交边界。
import vm from 'node:vm'
import assert from 'node:assert/strict'
const actualSource=readFileSync(join(SRC_LIB,'index.js'),'utf8')
const fnStart=actualSource.indexOf('function parseDistillEntries(')
const fnEnd=actualSource.indexOf('\n}',fnStart)
assert.ok(fnStart>=0&&fnEnd>fnStart,'必须提取当前被测真实函数')
const parse=vm.runInNewContext('('+actualSource.slice(fnStart,fnEnd+2)+')')
const META='<!-- tags: 回归 / date: 2020-01-02 / importance: high -->'
const A=META+'\n## 网络超时边界\n请求超时17秒，超过即明确报错，不允许无限等待。'
const B=META+'\n## 日志保存约定\n运行日志保留9天，便于覆盖发布后的排查周期。'
let passed=0,failed=0
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+': '+e.message)}}
const valid=[
  ['单条',A,1],['两条单换行',A+'\n'+B,2],['两条空行',A+'\n\n'+B,2],
  ['两条多空行',A+'\n\n\n\n'+B,2],['空行含空格制表符',A+'\n \t\n\t'+B,2],
  ['CRLF空行',(A+'\n\n'+B).replaceAll('\n','\r\n'),2],
  ['外部围栏','\x60\x60\x60markdown\n'+A+'\n\n'+B+'\n\x60\x60\x60',2],
  ['第三条间隔不一',A+'\n\n'+B+'\n\n\n'+META+'\n## 发布窗口\n周二晚上21点发布。',3],
  ['正文内部空行',A+'\n\n同一正文的第二段。\n\n'+B,2],
]
const bad=[
 ['尾部注释未闭合','<!-- tags: 未闭合'],
 ['尾部缺标题',META+'\n只有正文，没有标题。'],
 ['尾部缺正文',META+'\n## 空正文\n   '],
 ['尾部孤立注释','<!-- 仅注释 -->'],
 ['中间残缺条目',META+'\n## 残缺中间条目\n\n'+B],
]
for(const [name,input,n] of valid)await test('解析合法：'+name,()=>assert.equal(parse(input).length,n))
for(const [name,tail] of bad)await test('解析拒收：'+name,()=>assert.throws(()=>parse(A+'\n\n'+tail)))
for(const [name,input] of [['空行',A+'\n\n'+B],['缩进空行',A+'\n \n\t'+B],['CRLF',(A+'\n\n'+B).replaceAll('\n','\r\n')]]){
 await test('真实路由提交两条：'+name,async()=>{const sb=mkSandbox([resp(input)]);try{config(sb,{dupThreshold:1});await boot(sb);await callDistill(sb);assert.equal(sb.st.calls.length,1);assert.equal(sb.st.calls[0].maxTokens,2000);assert.ok(memRaw(sb)?.includes('## 网络超时边界'));assert.ok(memRaw(sb)?.includes('## 日志保存约定'));assert.equal(dateMarker(sb,OLD_DATE)?.added,2);assert.ok(dateMarker(sb,OLD_DATE)?.offset>0)}finally{cleanup(sb)}})
}
for(const [name,tail] of bad){
 await test('真实路由整批拒收且不推进：'+name,async()=>{const sb=mkSandbox([resp(A+'\n\n'+tail)]);const old='# 长期记忆\n\n'+META+'\n## 既有保护条目\n原内容必须逐字保留。\n';try{writeFileSync(join(sb.memDir,'MEMORY.md'),old);await boot(sb);await callDistill(sb);assert.equal(sb.st.calls.length,1);assert.equal(memRaw(sb),old);assert.equal(dateMarker(sb,OLD_DATE),undefined)}finally{cleanup(sb)}})
}
for(const [name,text,finish] of [['聊天输出','已记录，需要继续吗？','stop'],['截断合法外观',A+'\n\n'+B,'max-tokens'],['缺完成标记',A+'\n\n'+B,'none']]){
 await test('原护栏仍拒收：'+name,async()=>{const sb=mkSandbox([resp(text,finish)]);try{await boot(sb);await callDistill(sb);assert.equal(sb.st.calls.length,1);assert.equal(memRaw(sb),null);assert.equal(dateMarker(sb,OLD_DATE),undefined)}finally{cleanup(sb)}})
}
if(ENV_BACKUP===undefined)delete process.env.DSH_WORKSPACE_ROOT;else process.env.DSH_WORKSPACE_ROOT=ENV_BACKUP
console.log('parser-v0105: '+passed+' passed / '+failed+' failed')
if(failed)process.exitCode=1
