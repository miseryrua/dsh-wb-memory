/**
 * test/distill-regression.mjs — 任务B 回归测试：distill / compact / summary 的失败语义。
 *
 * red-green 用法（同一份测试，只换被测源码目录）：
 *   GREEN（修复后副本）: node test/distill-regression.mjs
 *   RED  （修复前源码）: WB_MEM_SRC="<修复前源码目录>/lib" node test/distill-regression.mjs
 *   保留沙箱排查      : WB_MEM_KEEP=1 node test/distill-regression.mjs
 * 也可被 import（run_code 内无子进程权限时用）：const m = await import(pathToFileURL(testfile));
 * 退出码：全部通过 0，有失败 1（不用 process.exit，便于 import 方式复用）。
 *
 * 隔离设计：
 *   - 被测源码（默认 = 本测试所在插件副本的 lib/）整体复制到 <副本>/.tmp/<stamp>/plugin；
 *     插件用 import.meta.url 推出的 PLUGIN_ROOT 就是该副本目录，所以 config.json /
 *     distilled.json / USER.md / USER-CANDIDATES.md 全部落在沙箱内；
 *   - process.env.DSH_WORKSPACE_ROOT 也指向沙箱内的工作区根，
 *     工作区 = <wsRoot>/<ws>/.workbuddy/memory/。
 *   - 源码目录只被读取（copyFileSync 的源），真实配置与真实记忆不被触碰。
 *   - 全程 mock llm（globalThis.__wbMemoryLlm 由真实 apply() 的 llm 注入回调赋值），
 *     不调用真实模型、不起服务。
 *
 * 入口真实性：调 lib/index.js 的 apply(ctx)（假 ctx 只收集 inject/effect/on），
 * 执行 llm 注入回调与 webServer 注册，再用 POST /api/wb-memory/distill?wait=1 调真实
 * handleDistill 走完 checkAndDistill；summary 用同一个 apply() 注册的
 * session-summary effect + 真实 session/event 事件驱动。
 */

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ENTRY = [
  '<!-- tags: 回归, 蒸馏 / date: ' + OLD_DATE + ' / importance: high -->',
  '## 蒸馏回归测试条目',
  '现象：mock 模型输出被写入 MEMORY.md。',
  '根因：测试专用条目。',
  '绕过办法：无，仅用于断言。',
  '影响边界：仅测试环境。',
].join('\n')

// compact 场景用的「能通过校验的压缩结果」：4 条（minCount=4）且远低于阈值 300。
const COMPACT_OUT = [
  '## 摘要 1',
  '要点一。',
  '',
  '## 摘要 2',
  '要点二。',
  '',
  '## 摘要 3',
  '要点三。',
  '',
  '## 摘要 4',
  '要点四。',
].join('\n')

// ---------------------------------------------------------------- 失败语义场景（R1/R2/R3/R4/R5/R7 共用）
async function failureScenario(name, finishSpec, expectWord, textOverride) {
  begin(name)
  const text = textOverride === undefined ? ENTRY : textOverride
  const sb = mkSandbox([resp(text, finishSpec)])
  await boot(sb)
  const r1 = await callDistill(sb)
  const callsAfter1 = sb.st.calls.length
  const marker1 = dateMarker(sb, OLD_DATE)
  const mem1 = memRaw(sb)
  note('results=' + JSON.stringify(r1.json.results))
  A(callsAfter1 === 1, '第一次 sweep 应调用模型一次', callsAfter1)
  A(marker1 === undefined, '失败后不得写该日期的成功标记', JSON.stringify(marker1))
  A(mem1 === null, '失败后不得创建/修改 MEMORY.md', mem1 === null ? 'null' : mem1.length + ' chars')
  const res1 = String((r1.json.results || {})[WS + '/' + OLD_DATE] || '')
  A(res1.startsWith('error:'), 'results 应记为 error', res1)
  if (expectWord) A(res1.includes(expectWord), '错误应可诊断（含 ' + expectWord + '）', res1)
  A(!res1.includes('sk-abcdef123456') && !res1.includes('Bearer sk-'), '错误不得泄露密钥/授权头', res1)
  await callDistill(sb)
  A(sb.st.calls.length === callsAfter1 + 1, '失败日期仍 pending，下一轮 sweep 会重试', sb.st.calls.length)
  A(dateMarker(sb, OLD_DATE) === undefined, '重试仍失败时依旧不写标记')
  cleanup(sb)
  end()
}

// ---------------------------------------------------------------- 主流程
const MAIN = async () => {
  // R0 旧版字符串 reason（smoke.mjs 的假 llm 风格）必须仍视为成功
  begin('R0 legacy 字符串 reason=stop + 合法条目 -> 成功且落盘')
  {
    const sb = mkSandbox([resp(ENTRY, 'stop')])
    await boot(sb)
    const r = await callDistill(sb)
    const mem = memRaw(sb) || ''
    note('results=' + JSON.stringify(r.json.results))
    A(r.json.results[WS + '/' + OLD_DATE] === '1 entries', 'results 记 1 entries', r.json.results[WS + '/' + OLD_DATE])
    A(mem.includes('## 蒸馏回归测试条目'), 'MEMORY.md 含新条目')
    A(mem.trimStart().startsWith('<!-- tags:'), 'MEMORY.md 首个非空行即条目 frontmatter（既有行为：新建文件不补 H1 前缀、正文前有一个空行）', JSON.stringify(mem.slice(0, 24)))
    A(dateMarker(sb, OLD_DATE) && dateMarker(sb, OLD_DATE).added === 1, '成功标记 added=1', JSON.stringify(dateMarker(sb, OLD_DATE)))
    const calls = sb.st.calls.length
    await callDistill(sb)
    A(sb.st.calls.length === calls, '已标记日期不再 pending（不重复调用模型）', sb.st.calls.length)
    cleanup(sb)
  }
  end()

  // R1 新版对象 reason {kind:'error', failure}
  await failureScenario(
    'R1 新版 reason={kind:error,failure{code,message}} + 文本 -> 不落盘、不写标记、pending 保留',
    { kind: 'error', failure: { code: 'MOCK_ERR', message: 'mock upstream failed, Authorization: Bearer sk-abcdef123456' } },
    'MOCK_ERR',
  )

  // R2 新版对象 reason {kind:'aborted'}
  await failureScenario(
    'R2 新版 reason={kind:aborted} -> 不落盘、不写标记、pending 保留',
    { kind: 'aborted', failure: { code: 'ABORTED', message: 'timeout after 180000ms' } },
    'ABORTED',
  )

  // R3 旧版字符串 reason='error'（修复前后都应失败）
  await failureScenario('R3 legacy 字符串 reason=error -> 依旧按失败处理', 'error', 'error')

  // R4 无 finish chunk
  await failureScenario('R4 流结束但无 finish chunk -> 按失败处理（文本不得落盘）', 'none', 'missing')

  // R5 空输出 + reason=stop
  await failureScenario('R5 空输出（reason=stop）-> 按失败处理（ok-but-empty-output）', 'stop', 'ok-but-empty-output', '')

  // R7 残缺输出（max-tokens）
  await failureScenario('R7 finish 原因 max-tokens（残缺输出）-> 按失败处理，不落盘', { kind: 'max-tokens' }, 'truncated')

  // 主代理补充：纯文本任务仅明确 stop 可成功；含“无”的错误说明不是零新增。
  await failureScenario('R12 未知完成态不成功', { kind: 'future-kind' }, 'unsupported')
  await failureScenario('R13 缺失 reason.kind 不成功', {}, 'unsupported')
  await failureScenario('R14 tool-calls 不是纯文本任务完成', { kind: 'tool-calls' }, 'unsupported')
  await failureScenario('R15 含无字的模型错误不等于零新增', 'stop', 'unparsable', '无法连接模型，请重试')
  await failureScenario('R16 未加载日志不等于零新增', 'stop', 'unparsable', '日志没有加载完成，请稍后重试')

  await failureScenario('R17 条目只有标题没有正文不得成功', 'stop', 'unparsable', '<!-- tags: test / date: 2026-10-09 / importance: high -->\n## 只有标题')
  await failureScenario('R18 正常条目夹残缺后半条不得部分成功', 'stop', 'unparsable', ENTRY + '\n<!-- tags: unfinished')

  // R6 合法「明确零条」必须仍按成功记账（防过度修复）
  begin('R6 提示词约定的明确空输出（空，什么都不写）-> 成功标记 added=0')
  {
    const sb = mkSandbox([resp('（空，什么都不写）', 'stop')])
    await boot(sb)
    const r = await callDistill(sb)
    const m = dateMarker(sb, OLD_DATE)
    note('results=' + JSON.stringify(r.json.results))
    A(r.json.results[WS + '/' + OLD_DATE] === '0 entries', 'results 记 0 entries', r.json.results[WS + '/' + OLD_DATE])
    A(m && m.added === 0, '成功标记 added=0（该日期不再重试）', JSON.stringify(m))
    A(memRaw(sb) === null, '零条不创建 MEMORY.md')
    const calls = sb.st.calls.length
    await callDistill(sb)
    A(sb.st.calls.length === calls, '零条成功后不再 pending', sb.st.calls.length)
    cleanup(sb)
  }
  end()

  // R8 失败 -> 失败 -> 成功：只有成功后写标记；再删标记重跑靠幂等护栏去重
  begin('R8 同日期 失败x2 -> 成功：成功后写标记；删标记重跑靠幂等护栏去重')
  {
    const sb = mkSandbox([
      resp(ENTRY, { kind: 'error', failure: { code: 'E1', message: 'boom' } }),
      resp(ENTRY, { kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } }),
      resp(ENTRY, 'stop'),
    ])
    await boot(sb)
    await callDistill(sb)
    A(dateMarker(sb, OLD_DATE) === undefined, '第 1 轮失败不写标记')
    await callDistill(sb)
    A(dateMarker(sb, OLD_DATE) === undefined, '第 2 轮失败不写标记')
    await callDistill(sb)
    const m3 = dateMarker(sb, OLD_DATE)
    const mem3 = memRaw(sb) || ''
    note('第 3 轮 calls=' + sb.st.calls.length + ' marker=' + JSON.stringify(m3))
    A(m3 && m3.added === 1, '第 3 轮成功才写标记 added=1', JSON.stringify(m3))
    A(mem3.includes('## 蒸馏回归测试条目'), '第 3 轮条目落盘')
    const calls = sb.st.calls.length
    await callDistill(sb)
    A(sb.st.calls.length === calls, '成功后不再重复调用', sb.st.calls.length)
    // 模拟 distilled.json 丢失（2026-08-30 BOM 事故同款）：标记没了但内容在 -> 幂等护栏去重
    rmSync(join(sb.pluginDir, 'distilled.json'), { force: true })
    await callDistill(sb)
    const mem4 = memRaw(sb)
    const m4 = dateMarker(sb, OLD_DATE)
    note('删标记重跑 marker=' + JSON.stringify(m4) + ' MEMORY 长度 ' + (mem4 || '').length)
    A(mem4 === mem3, '条目未被重复追加（幂等护栏生效）', (mem4 || '').length + ' vs ' + mem3.length)
    A((String(mem4).match(/## 蒸馏回归测试条目/g) || []).length === 1, 'MEMORY.md 中该标题只出现一次')
    A(m4 && m4.added === 0, '去重后记为 0 条成功标记', JSON.stringify(m4))
    cleanup(sb)
  }
  end()

  // R9 compact：失败原因 + 文本恰好能过校验 -> 绝不覆盖原文件
  begin('R9 compact 遇 reason={kind:error} 且文本能过校验 -> 保留原文件（逐字节）')
  {
    const big = []
    for (let i = 1; i <= 8; i++) {
      big.push('<!-- tags: t' + i + ' / date: 2020-01-01 / importance: medium -->')
      big.push('## 大条目 ' + i)
      big.push('正文内容'.repeat(30) + ' ' + i)
      big.push('')
    }
    const sb = mkSandbox([resp(COMPACT_OUT, { kind: 'error', failure: { code: 'COMPACT_FAIL', message: 'stream broke mid-compaction' } })])
    writeFileSync(join(sb.memDir, 'MEMORY.md'), '# 项目长期记忆\n\n' + big.join('\n'), 'utf8')
    const conf = JSON.parse(readFileSync(join(sb.pluginDir, 'config.json'), 'utf8'))
    conf.memoryCharThreshold = 300
    writeFileSync(join(sb.pluginDir, 'config.json'), JSON.stringify(conf, null, 2), 'utf8')
    const before = readFileSync(join(sb.memDir, 'MEMORY.md'))
    await boot(sb)
    const r = await callDistill(sb)
    const after = readFileSync(join(sb.memDir, 'MEMORY.md'))
    const cm = compactMarker(sb)
    note('results=' + JSON.stringify(r.json.results) + ' compactMarker=' + JSON.stringify(cm))
    A(before.equals(after), 'MEMORY.md 逐字节未变（失败不得覆盖）', before.length + ' -> ' + after.length)
    A(cm && cm.ok === false, 'compact 结果记为 ok:false', JSON.stringify(cm && cm.ok))
    A(String(r.json.results[WS + '/compact'] || '').includes('kept original'), 'results 记 kept original', r.json.results[WS + '/compact'])
    A(String(r.json.results[WS + '/compact'] || '').includes('COMPACT_FAIL'), '真实失败原因未被掩盖（可诊断）', r.json.results[WS + '/compact'])
    A(Boolean(cm) && typeof cm.day === 'string' && cm.day.length === 10, '失败也写下当日 __compact__ 日锁（同日不反复重试）', JSON.stringify(cm && cm.day))
    cleanup(sb)
  }
  end()

  // R9b compact 正常路径（legacy 字符串 stop）：确认没把正常压缩也拦掉
  begin('R9b compact 正常路径（legacy reason=stop，文本通过校验）-> 仍然压缩成功')
  {
    const big = []
    for (let i = 1; i <= 8; i++) {
      big.push('<!-- tags: t' + i + ' / date: 2020-01-01 / importance: medium -->')
      big.push('## 大条目 ' + i)
      big.push('正文内容'.repeat(30) + ' ' + i)
      big.push('')
    }
    const sb = mkSandbox([resp(COMPACT_OUT, 'stop')])
    writeFileSync(join(sb.memDir, 'MEMORY.md'), '# 项目长期记忆\n\n' + big.join('\n'), 'utf8')
    const conf = JSON.parse(readFileSync(join(sb.pluginDir, 'config.json'), 'utf8'))
    conf.memoryCharThreshold = 300
    writeFileSync(join(sb.pluginDir, 'config.json'), JSON.stringify(conf, null, 2), 'utf8')
    await boot(sb)
    const r = await callDistill(sb)
    const cm = compactMarker(sb)
    const memLen = (memRaw(sb) || '').length
    note('results=' + JSON.stringify(r.json.results) + ' compactMarker=' + JSON.stringify(cm))
    A(cm && cm.ok === true, 'compact 成功', JSON.stringify(cm && cm.ok))
    A(memLen < 2400, 'MEMORY.md 被压缩', memLen)
    A((memRaw(sb) || '').includes('## 摘要 4'), '压缩结果已落地到 MEMORY.md')
    cleanup(sb)
  }
  end()

  // ------------------------------------------------------------ R10 会话小结
  // 真实链路：apply() 注册的 session-summary effect -> 真实 session/event 事件 -> 空闲定时器
  // -> runSessionSummary -> api.distillCallLlm（被修复的同一函数）。
  const todayStr = (() => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  })()

  async function summaryScenario(label, finishSpec, text, expectWritten) {
    begin(label)
    const sb = mkSandbox([resp(text, finishSpec)])
    await boot(sb)
    const installed = runEffect(sb, 'session-summary')
    A(installed, 'session-summary effect 已注册')
    const fire = (event) => {
      for (const fn of (sb.listeners['session/event'] || [])) {
        try { fn({ id: 'sess-1', header: { cwd: join(sb.wsRoot, WS) } }, event) } catch (e) { note('listener threw: ' + String(e && e.message)) }
      }
    }
    fire({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: '用户问题'.repeat(100) } })
    fire({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'mock 助手回复' }] } } })
    fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await sleep(300)
    let logRaw = null
    try { logRaw = readFileSync(join(sb.memDir, todayStr + '.md'), 'utf8') } catch {}
    const calls = sb.st.calls.length
    note('model calls=' + calls + ' log=' + (logRaw === null ? 'null' : logRaw.length + ' chars'))
    A(calls === 1, '已调用模型一次（前置闸通过）', calls)
    if (expectWritten) {
      A(logRaw !== null && logRaw.includes('## 会话小结'), '小结应写入当日日志', logRaw === null ? 'no file' : logRaw.slice(-120))
      A(logRaw !== null && logRaw.includes('mock 小结正文'), '小结正文来自模型输出')
    } else {
      A(logRaw === null || !logRaw.includes('## 会话小结'), '失败不得写小结（不得写空小结）', logRaw === null ? 'no file' : logRaw.slice(-120))
    }
    cleanup(sb)
    end()
  }

  await summaryScenario('R10a summary 遇 reason={kind:error} -> 不写小结', { kind: 'error', failure: { code: 'SUM_FAIL', message: 'mock failed' } }, 'mock 小结正文', false)
  await summaryScenario('R10b summary 遇 reason={kind:aborted} -> 不写小结', { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } }, 'mock 小结正文', false)
  await summaryScenario('R10c summary 正常（legacy reason=stop）-> 写小结（对照，确认没拦掉正常路径）', 'stop', 'mock 小结正文', true)

  // ------------------------------------------------------------ R11 单元：分类器与零条判定
  begin('R11 classifyLlmFinish / isExplicitNoEntries 真值表（含旧版字符串）')
  {
    const sb = mkSandbox([resp(ENTRY, 'stop')])
    const idx = await boot(sb)
    const C = idx.classifyLlmFinish
    const N = idx.isExplicitNoEntries
    A(typeof C === 'function', 'classifyLlmFinish 已导出（RED 时缺失即为预期的失败）')
    A(typeof N === 'function', 'isExplicitNoEntries 已导出（RED 时缺失即为预期的失败）')
    if (typeof C === 'function') {
      const cases = [
        ['legacy 字符串 stop', 'stop', 'ok'],
        ['legacy 字符串 tool-calls', 'tool-calls', 'unsupported'],
        ['legacy 字符串 max-tokens', 'max-tokens', 'truncated'],
        ['legacy 字符串 error', 'error', 'error'],
        ['legacy 字符串 aborted', 'aborted', 'aborted'],
        ['新版对象 error', { kind: 'error', failure: { code: 'C1', message: 'm' } }, 'error'],
        ['新版对象 aborted', { kind: 'aborted', failure: { code: 'ABORTED' } }, 'aborted'],
        ['新版对象 stop', { kind: 'stop' }, 'ok'],
        ['新版对象 max-tokens', { kind: 'max-tokens' }, 'truncated'],
        ['未来未知 kind', { kind: 'brand-new-kind-from-future-host' }, 'unsupported'],
        ['undefined', undefined, 'unsupported'],
        ['null', null, 'unsupported'],
      ]
      for (const [label, input, want] of cases) {
        const got = C(input)
        A(got && got.status === want, label + ' -> ' + want, JSON.stringify(got))
      }
      const d = C({ kind: 'error', failure: { code: 'X', message: 'Authorization: Bearer sk-abcdef123456 and more' } }).detail || ''
      A(d.length < 260, 'detail 有长度上限', d.length)
      A(!d.includes('sk-abcdef123456'), 'detail 不得泄露密钥', d)
    }
    if (typeof N === 'function') {
      A(N('（空，什么都不写）') === true, '提示词约定的零条输出 -> true')
      A(N('' + String.fromCharCode(96, 96, 96) + 'text\n（空，什么都不写）\n' + String.fromCharCode(96, 96, 96) + '') === true, '围栏包裹的零条输出 -> true')
      A(N(ENTRY) === false, '正常条目 -> false')
      A(N('') === false, '空串 -> false（空串由 ok-but-empty-output 单独拦）')
      A(N('输出被截断，正文如下：' + '正文'.repeat(60)) === false, '残缺长文本 -> false')
      A(N('not sure') === false, '随意短语 -> false')
      A(N('无法完成请求') === false, '包含无字的错误文本 -> false')
      A(N('nothing was generated due to failure') === false, '英文错误文本 -> false')
    }
    cleanup(sb)
  }
  end()

  // ------------------------------------------------------------ 汇总
  const fails = scenarios.reduce((n, s) => n + s.fails.length, 0)
  const srcIdx = readFileSync(join(SRC_LIB, 'index.js'), 'utf8')
  const patched = srcIdx.includes('classifyLlmFinish') && srcIdx.includes('isExplicitNoEntries')
  console.log('')
  console.log('被测源码: ' + join(SRC_LIB, 'index.js'))
  console.log('源码特征: classifyLlmFinish/isExplicitNoEntries ' + (patched ? '存在（修复版）' : '缺失（修复前）'))
  console.log('场景数: ' + scenarios.length + '，断言失败: ' + fails)
  for (const s of scenarios) {
    if (s.fails.length === 0) { console.log('  PASS  ' + s.name); continue }
    console.log('  FAIL  ' + s.name)
    for (const f of s.fails) console.log('        - ' + f)
    for (const n of s.notes) console.log('        · ' + n)
  }
  if (!KEEP) { try { rmSync(TMP_ROOT, { recursive: true, force: true }) } catch {} }
  if (ENV_BACKUP === undefined) delete process.env.DSH_WORKSPACE_ROOT
  else process.env.DSH_WORKSPACE_ROOT = ENV_BACKUP
  console.log('')
  console.log('RESULT: ' + (fails === 0 && patched ? 'GREEN（修复版通过；如需 RED 证据请用 WB_MEM_SRC 指向修复前 lib）' : fails === 0 ? 'GREEN(未修复源码也全过？请检查场景有效性)' : 'RED（修复前/存在回归）'))
  process.exitCode = fails === 0 ? 0 : 1
}

await MAIN()
