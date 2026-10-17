#!/usr/bin/env node
// test/recall-regression.mjs — 缺陷 A（按当前任务召回失效 → 固定摘要分支）真实入口红绿回归
//
// 为什么算"真实入口"：走插件 apply(ctx) 的注册路径 —— 由 mock 宿主 ctx 触发
// systemPrompt.context({name:'wb-memory',order:-80,text}) 的 text 回调（正是宿主
// dsh-agent-loop/lib/index.js:907 调用的那个），断言最终 buildMemoryBlock 产出的注入块。
// 公开消息夹具完全合成，只复刻宿主消息来源契约和组装时序，不包含真实会话。
//
// 用法（CLI）：
//   绿（修复后副本）：node test/recall-regression.mjs
//   红（上游原版）  ：WB_MEMORY_ENTRY=<上游副本 lib/index.js 绝对路径> node test/recall-regression.mjs
//   以 import 方式调用：const { runRegression } = await import('./recall-regression.mjs'); await runRegression()
//   （返回 {pass, fails, failNames, cleanup}；cleanup 清理插件注册的定时器/监听器）
//
// 隔离纪律：只读 test/fixtures/wsroot 合成记忆；config.json 写在入口所属插件目录下，
// 结束时恢复原状；不触网、不调 LLM、不写任何真实工作区。
//
// 宿主契约依据（只读宿主源码，行号见 implementation.md）：
//   dsh-agent/lib/index.js:291-297      assembleContextFor(agent, signal) → {agent, scope, signal}（无 messages）
//   dsh-agent-loop/lib/index.js:906     inbox.claim → 同步 emit 'agent/inbox/claimed'
//   dsh-agent-loop/lib/index.js:907     systemPrompt.assemble(assembleContextFor(this, signal)) → 本插件 text 回调
//   dsh-agent-loop/lib/index.js:1061    被认领的 user/message 到此时才 session.append（assemble 之后）
//   dsh-session/lib/index.js:1554-1569  deriveMessages() 只反映已落库 surface 消息
//   seam 回调签名范例：dsh-goal-round-driver/lib/index.js:245、dsh-acp/lib/index.js:1107

import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const WSROOT = join(FIXTURES, 'wsroot')
const WORKSPACE = '演示工作区'
const WORKSPACE_DIR = join(WSROOT, WORKSPACE)
const MEMFILE = join(WORKSPACE_DIR, '.workbuddy', 'memory', 'MEMORY.md')
const REL_TITLE = '### 长期记忆 / 相关条目（按当前任务召回 top-1）'
const SUM_TITLE = '### 长期记忆 / 摘要（完整内容请按需读取 MEMORY.md）'
const ALPHA = '记忆插件注入调查'      // 命中首轮真实任务文本
const GAMMA = '修复方案与验收流程'    // 命中第二轮真实任务文本
const BETA = '电池与充电'             // 对照组：诱导/其它会话文本命中它

// 'agent/inbox/claimed' 是 dispatch emit、**不落库**，存档里没有它的 payload 本体；
// 同一批消息在存档里以 agent/inbox/spliced 的 inserted 项 / user/message 事件存在
// （同一个冻结消息对象）→ 测试直接用它作 claim 的 message（合成内容 + 对应 source.kind/form）。
// agent 包装对象按宿主 driver 形状最小复刻（dsh-agent-loop:777 this.dispatch = agentEvents(loopCtx, this)，
// 故 payload.agent 与 assembleContextFor(this) 的 this 是同一 driver，agent.session 即 Session）。
function makeSession(id, cwd) {
  const s = { id, header: { cwd }, messages: [], committed: [] }
  s.deriveMessages = () => s.committed.slice()
  return s
}
function assembleContextFor(agent, signal) {           // dsh-agent:291-297 真实形状
  return { agent, scope: agent, ...(signal === undefined ? {} : { signal }) }
}
function makeHost() {                                   // cordis ctx 最小复刻
  const listeners = new Map()
  const disposers = []
  const injections = new Map()
  const scopes = {}
  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
    emit(name, ...args) { for (const fn of [...(listeners.get(name) || [])]) fn(...args) },
    effect(fn, label) {
      const d = typeof fn === 'function' ? fn() : undefined
      const dispose = () => { try { if (typeof d === 'function') d() } catch {} }
      dispose.label = label
      disposers.push(dispose)
      return dispose
    },
    inject(names, fn) {
      const key = names.join(','); if (!injections.has(key)) injections.set(key, new Set()); injections.get(key).add(fn)
    },
  }
  ctx.disposers = disposers
  ctx.scopes = scopes
  scopes.llm = { llm: { listProviders: () => [{ id: 'mock-provider' }] } }
  scopes.systemPrompt = { systemPrompt: { context: (reg) => { scopes.registered = reg } } }
  scopes.webServer = { effect: (f) => { try { f() } catch {}; return () => {} }, webServer: { register: () => () => {} } }
  scopes.connection = { connection: { requestRejection: () => undefined } }
  scopes.tools = { tools: { register: () => () => {} } }
  ctx.activate = () => { for (const [name, fns] of injections) for (const fn of fns) fn(Object.assign({}, ...name.split(',').map(n => scopes[n]))) }
  return ctx
}

export async function runRegression(opts = {}) {
  const sourceEntry = resolve(opts.entry || process.env.WB_MEMORY_ENTRY || join(HERE, '..', 'lib', 'index.js'))
  // 被测目录始终只读：即便调用者给真实安装路径，也只在独立沙箱写配置。
  const sandbox = join(HERE, '..', '.tmp', 'recall-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  mkdirSync(join(sandbox, 'lib'), { recursive: true })
  const sourceLib = dirname(sourceEntry)
  for (const name of readdirSync(sourceLib)) if (name.endsWith('.js')) copyFileSync(join(sourceLib, name), join(sandbox, 'lib', name))
  copyFileSync(join(dirname(sourceLib), 'package.json'), join(sandbox, 'package.json'))
  const entry = join(sandbox, 'lib', 'index.js')
  const previousRoot = process.env.DSH_WORKSPACE_ROOT
  const label = opts.label || (process.env.WB_MEMORY_ENTRY ? 'RED(上游原版)' : 'GREEN(修复后)')
  const pluginRoot = dirname(dirname(entry))
  const cfgFile = join(pluginRoot, 'config.json')
  const FIXTURE_CFG = {
    enabled: true, activeProject: null, relevantTopK: 1,
    autoDigest: false, autoDistill: false, sessionSummary: false, memorySearchTool: false,
  }
  const claims = JSON.parse(readFileSync(join(FIXTURES, 'host-claims.json'), 'utf8'))
  const out = []
  const realLog = opts.logger || console.log.bind(console)
  const pluginLog = []
  console.log = (...a) => { pluginLog.push(a.join(' ')) }        // 插件自身的 console.log 单独收集
  const log = (s) => { out.push(s); if (!opts.quiet) realLog(s) }
  let pass = 0
  const fails = []
  const ok = (name, cond, evidence) => {
    if (cond) { pass++; log('  PASS  ' + name + (evidence ? '  | ' + evidence : '')) }
    else { fails.push(name); log('  FAIL  ' + name + (evidence ? '  | ' + evidence : '')) }
  }
  log('== recall-regression [' + label + '] ==')
  log('入口: ' + entry)

  // ---- 隔离 config ----
  const backup = cfgFile + '.regression-bak'
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    try {
      if (existsSync(backup)) { copyFileSync(backup, cfgFile); unlinkSync(backup) }
      else if (existsSync(cfgFile)) unlinkSync(cfgFile)
    } catch (e) { log('  (恢复 config 失败: ' + e.message + ')') }
  }
  if (existsSync(cfgFile)) copyFileSync(cfgFile, backup)
  writeFileSync(cfgFile, JSON.stringify(FIXTURE_CFG, null, 2), 'utf8')

  process.env.DSH_WORKSPACE_ROOT = WSROOT
  const mod = await import(pathToFileURL(entry).href)
  const ret = await import(pathToFileURL(join(pluginRoot, 'lib', 'retrieve.js')).href)
  const host = makeHost()
  mod.apply(host)
  host.activate()
  const textFn = host.scopes.registered && host.scopes.registered.text
  const cleanup = () => {
    for (const d of host.disposers) d()
    restore()
    console.log = realLog
    if (previousRoot === undefined) delete process.env.DSH_WORKSPACE_ROOT
    else process.env.DSH_WORKSPACE_ROOT = previousRoot
    rmSync(sandbox, { recursive: true, force: true })
  }
  if (typeof textFn !== 'function') {
    restore(); log('插件未注册 systemPrompt text 回调'); return { pass, fails, failNames: fails, out, pluginLog, cleanup }
  }
  ok('apply 注册 systemPrompt.context 段（宿主契约 name/order）',
    host.scopes.registered.name === 'wb-memory' && host.scopes.registered.order === -80,
    'name=' + host.scopes.registered.name + ' order=' + host.scopes.registered.order)

  const sessions = new Map()
  const sessionOf = (sid) => { if (!sessions.has(sid)) sessions.set(sid, makeSession(sid, WORKSPACE_DIR)); return sessions.get(sid) }
  const agentOf = (sid) => ({ session: sessionOf(sid) })
  const claim = (sid, message, turn) => host.emit('agent/inbox/claimed', { agent: agentOf(sid), message, turn })
  const assembleText = (sid) => textFn(assembleContextFor(agentOf(sid), undefined))   // 宿主 :907
  const has = (block, s) => (block || '').includes(s)
  const titles = (block) => ((block || '').match(/^#### (.+)$/gm) || []).map((l) => l.slice(5))
  const tt = (block) => titles(block).join('/')
  const memMd = () => readFileSync(MEMFILE, 'utf8')

  log('')
  log('-- 宿主组装时序（合成消息重放）--')
  const t1ctx = assembleContextFor(agentOf('session-A'), undefined)
  ok('assemble 时刻 context 只有 agent/scope/signal（无 messages）',
    JSON.stringify(Object.keys(t1ctx).sort()) === JSON.stringify(['agent', 'scope']),
    'keys=' + Object.keys(t1ctx).join(','))
  ok('assemble 时刻首轮 session.deriveMessages() 为空（→ 落库/session 路径不可能拿到本轮任务）',
    sessionOf('session-A').deriveMessages().length === 0, 'len=0')

  log('')
  log('-- 用例 1：首轮 claim → assemble 召回当前任务 --')
  claim('session-A', claims.userTurn1, 1)          // 宿主 :906
  const b1 = assembleText('session-A')             // 宿主 :907
  ok('首轮进"相关条目"分支（而非固定摘要）', has(b1, REL_TITLE) && !has(b1, SUM_TITLE),
    'related=' + has(b1, REL_TITLE) + ' summary=' + has(b1, SUM_TITLE))
  ok('首轮召回当前任务条目「' + ALPHA + '」', tt(b1) === ALPHA, 'titles=' + tt(b1))
  sessionOf('session-A').committed.push(structuredClone(claims.userTurn1))  // 宿主 :1061 此刻才落库
  ok('本轮 user/message 落库后再 assemble 结果不变（不依赖落库时序）', has(assembleText('session-A'), '#### ' + ALPHA))

  log('')
  log('-- 用例 2：第二轮新任务 → 换条目 --')
  claim('session-A', claims.userTurn2, 2)
  const b2 = assembleText('session-A')
  ok('第二轮召回新任务条目「' + GAMMA + '」且不再注入上轮条目', tt(b2) === GAMMA, 'titles=' + tt(b2))

  log('')
  log('-- 用例 3：来源过滤（非 user 的 claim 不得改变召回）--')
  const before3 = tt(assembleText('session-A'))
  for (const m of Object.values(claims.nonUserClaimsReal)) claim('session-A', m, 2)
  for (const m of claims.plantedClaims) claim('session-A', m, 2)
  const b3 = assembleText('session-A')
  ok('合成非 user claim（' + Object.keys(claims.nonUserClaimsReal).join(', ') + '）不改变召回',
    tt(b3) === GAMMA && tt(b3) === before3, 'before=' + before3 + ' after=' + tt(b3))
  ok('诱导 claim（runtime-context/time-context/agent-message 形状、文本强命中「' + BETA + '」）被忽略',
    tt(b3) === GAMMA && !has(b3, '#### ' + BETA), 'titles=' + tt(b3))
  const plantedQ = claims.plantedClaims[0].content[0].text
  const plantedTop1 = ret.retrieveRelevant(memMd(), plantedQ, 1).map((e) => e.title).join(',')
  ok('（反证）同一诱导文本作 query 时确实命中「' + BETA + '」→ 上面的过滤是有效判据',
    plantedTop1 === BETA, 'retrieveRelevant(诱导文本, top1)=' + plantedTop1)

  log('')
  log('-- 用例 4：同工作区多 session 隔离 --')
  const betaTask = { role: 'user', id: 'u-beta', source: { kind: 'user', rpcId: 'rpc-beta' }, content: [{ type: 'text', text: '电池健康度充电上限' }] }
  claim('session-B', betaTask, 1)
  const bB = assembleText('session-B')
  const bA = assembleText('session-A')
  ok('B 会话按自己的任务召回「' + BETA + '」', tt(bB) === BETA, 'B titles=' + tt(bB))
  ok('B 的 claim 不污染同工作区的 A 会话', tt(bA) === GAMMA, 'A titles=' + tt(bA))

  log('')
  log('-- 用例 5：无任务会话回退固定摘要（不伪造 query）--')
  const bC = assembleText('session-C')
  ok('无 claim 的新会话 → 固定摘要分支', has(bC, SUM_TITLE) && !has(bC, REL_TITLE),
    'summary=' + has(bC, SUM_TITLE) + ' related=' + has(bC, REL_TITLE))

  log('')
  log('-- 用例 6：enabled=false 不注入 --')
  writeFileSync(cfgFile, JSON.stringify({ ...FIXTURE_CFG, enabled: false }, null, 2), 'utf8')
  const bOff = assembleText('session-A')
  writeFileSync(cfgFile, JSON.stringify(FIXTURE_CFG, null, 2), 'utf8')
  ok('关闭开关 → text() 返回空串', bOff === '', JSON.stringify(bOff).slice(0, 40))

  log('')
  log('-- 用例 7：legacy messages 入参（历史调用方兼容 + 误选修复）--')
  const legacyCtx = (id, msgs) => ({ agent: { session: { id, header: { cwd: WORKSPACE_DIR }, messages: msgs } }, messages: msgs })
  // 真实存档顺序：user 消息（seq18）在前、runtime-context 快照（seq20）在后 → 旧实现从尾往前会误取快照
  const bL1 = mod.buildMemoryBlock(WORKSPACE_DIR, legacyCtx('legacy-1', [betaTask, claims.surfaceNoise.runtimeContext_20]), FIXTURE_CFG)
  ok('legacy 尾部的 runtime-context 快照被跳过，按真实 user 消息召回「' + BETA + '」', tt(bL1) === BETA, 'titles=' + tt(bL1))
  const bL2 = mod.buildMemoryBlock(WORKSPACE_DIR, legacyCtx('legacy-2', [{ role: 'user', content: '电池健康度充电上限' }]), FIXTURE_CFG)
  ok('无 source 的裸 user 消息仍兼容', tt(bL2) === BETA, 'titles=' + tt(bL2))
  const bL3 = mod.buildMemoryBlock(WORKSPACE_DIR, legacyCtx('legacy-3', [claims.surfaceNoise.skillCatalog_21]), FIXTURE_CFG)
  ok('legacy 只给 skill-catalog 时不算用户查询（回退摘要，不拿它检索）',
    has(bL3, SUM_TITLE), 'titles=' + tt(bL3) + ' summary=' + has(bL3, SUM_TITLE))

  log('')
  log('-- 用例 8/9/10：生命周期（按 session 隔离 / 清理 / 卸载）--')
  const cache = mod.claimedQueryCacheForTest
  if (!(cache instanceof Map)) {
    ok('模块导出 claimedQueryCacheForTest（旧版无此实现）', false, 'typeof=' + typeof cache)
    restore()
    log('')
    log('== 结果 [' + label + ']：' + pass + ' PASS / ' + fails.length + ' FAIL ==')
    log('FAIL 明细:\n' + fails.map((f) => '  - ' + f).join('\n'))
    return { pass, fails, failNames: fails, out, pluginLog, cleanup }
  }
  ok('缓存按 session.id 分桶（A/B 各自独立）', cache.has('session-A') && cache.has('session-B'), 'size=' + cache.size)
  host.emit('session/disposed', sessionOf('session-B'))
  ok('session/disposed → 删该会话桶（A 保留）', !cache.has('session-B') && cache.has('session-A'), 'size=' + cache.size)
  for (let i = 0; i < 130; i++) claim('s-cap-' + i, { role: 'user', id: 'u' + i, source: { kind: 'user' }, content: [{ type: 'text', text: '容量测试 ' + i }] })
  ok('容量上限 128：再插 130 个会话后 size=128，最旧被逐出、最新保留',
    cache.size === 128 && cache.has('s-cap-129') && !cache.has('s-cap-0'), 'size=' + cache.size + ' cap0=' + cache.has('s-cap-0'))
  claim('session-A', claims.userTurn2, 3)
  ok('被逐出的会话再次 claim 后可正常召回（无残留脏状态）', tt(assembleText('session-A')) === GAMMA, 'titles=' + tt(assembleText('session-A')))
  const nBefore = cache.size
  for (const d of host.disposers) d()
  ok('卸载：全部 effect disposer 执行后缓存清空', cache.size === 0, 'before=' + nBefore + ' after=' + cache.size)
  claim('session-Z', betaTask, 1)
  ok('卸载后监听器已摘除（再 claim 不再写入）', cache.size === 0, 'size=' + cache.size)

  log('')
  log('-- 用例 11：边界韧性 --')
  const bW = mod.buildMemoryBlock(join(WSROOT, '__noworkspace__'), assembleContextFor(agentOf('session-C'), undefined), FIXTURE_CFG)
  ok('cwd 不在任何工作区 → 不注入长期记忆段且不崩（"未匹配到工作区"分支）',
    has(bW, '## 未匹配到工作区') && !has(bW, REL_TITLE), 'ok=' + has(bW, '## 未匹配到工作区'))

  restore()
  log('')
  log('== 结果 [' + label + ']：' + pass + ' PASS / ' + fails.length + ' FAIL ==')
  if (fails.length) log('FAIL 明细:\n' + fails.map((f) => '  - ' + f).join('\n'))
  return { pass, fails, failNames: fails, out, pluginLog, cleanup }
}

// 直接 CLI 调用时才退出进程（被 import 时只返回结果，便于同一进程跑红绿两份入口）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const r = await runRegression()
  r.cleanup()
  process.exit(r.fails.length ? 1 : 0)
}
