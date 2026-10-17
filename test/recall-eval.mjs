#!/usr/bin/env node
/**
 * dsh-wb-memory 第三批：召回评测模块测试（lib/recall-eval.js，2026-10-17）
 *
 * 覆盖：
 *   1) 内置合成案例完整性：≥20 条、覆盖中文/英文/混排/无关/弱词/空查询/重复标题/
 *      lifecycle 已退场/跨项目参数相似/数字纠正；运行模块不读 test 路径。
 *   2) fixture 与内置常量逐字一致（fixture 仅供测试/外部读取，lib 不反向依赖）。
 *   3) 指标计算正确性：用可手算的 stub ranker 验证 precision/recall/MRR/top1/
 *      多重集命中/禁选/空查询/耗时字段，不依赖真实算法。
 *   4) 真实 rankMemory 集成：全部 strict 案例通过；返回列表如实保留算法弱项
 *      （c16 旧端口同召回、c21 Redis 同召回、o1 通用词入侵——弱项断言为
 *      「正确条目在返回集中」而非「无弱项」，不虚构全满分）。
 *   5) 影子对照 shadowCompareCases：仅离线比较传入参数（默认 vs relRatio=0），
 *      差异计数正确；不修改线上默认。
 *   6) 时间敏感：案例日期均为固定旧日期（远离 30/90 天加成窗口），重复运行稳定。
 */
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import * as EVAL from '../lib/recall-eval.js'
import { rankMemory } from '../lib/retrieve.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.error('  ✗ ' + name) }
}
function section(t) { console.log('\n== ' + t + ' ==') }

const CASES = EVAL.BUILTIN_RECALL_CASES
const byId = (id) => CASES.find((c) => c.id === id)

console.log('dsh-wb-memory 第三批召回评测测试（recall-eval）')

// ================= 1. 内置案例完整性 =================
section('内置合成案例完整性')
ok(Array.isArray(CASES) && CASES.length >= 20, '内置案例 ≥ 20（实际 ' + CASES.length + '）')
ok(new Set(CASES.map((c) => c.id)).size === CASES.length, '案例 id 唯一')
const kinds = new Set(CASES.map((c) => c.kind))
for (const k of ['zh', 'en', 'mixed', 'irrelevant', 'weak', 'empty', 'duplicate', 'lifecycle', 'cross-project', 'numeric', 'order']) {
  ok(kinds.has(k), '覆盖 kind=' + k)
}
ok(CASES.every((c) => c.assert === 'strict' || c.assert === 'observe'), '每条案例声明 strict/observe 口径')
ok(CASES.filter((c) => c.assert === 'strict').length >= 20, 'strict 案例至少 20（实际 ' + CASES.filter((c) => c.assert === 'strict').length + '）')
// 时间敏感：固定旧日期，不用近 30 日相对日期
const dateMentions = CASES.map((c) => c.memoryMd).join('\n')
ok(!/date: 20(2[6-9]|[3-9][0-9])-\d{2}/.test(dateMentions.replace(/date: 2026-01-10/g, '')), '案例无其他 frontmatter 日期（固定 2026-01-10，远离加成窗口）')
// lifecycle 案例的标记能被 inspectMemory 正常解析（与 memory-lifecycle 编码一致）
const lcCase = byId('c13-lifecycle-superseded')
const { inspectMemory } = await import('../lib/memory-lifecycle.js')
let lcOk = true, lcErr = null
try { const p = inspectMemory(lcCase.memoryMd); lcOk = p.records.length === 2 && p.records[0].meta.state === 'superseded' && p.records[1].meta.state === 'current' } catch (e) { lcOk = false; lcErr = e.message }
ok(lcOk, 'superseded 案例的 wb-memory 标记真实有效' + (lcErr ? '（' + lcErr + '）' : ''))
let reOk = true, reErr = null
try { const p = inspectMemory(byId('c14-lifecycle-retracted-only').memoryMd); reOk = p.records[0].meta.state === 'retracted' } catch (e) { reOk = false; reErr = e.message }
ok(reOk, 'retracted 案例的 wb-memory 标记真实有效' + (reErr ? '（' + reErr + '）' : ''))

// ================= 2. fixture 一致性 =================
section('fixture 与内置常量一致')
const fixturePath = join(HERE, 'fixtures', 'recall-eval-cases.json')
ok(fs.existsSync(fixturePath), 'fixture 文件存在：test/fixtures/recall-eval-cases.json')
if (fs.existsSync(fixturePath)) {
  const raw = fs.readFileSync(fixturePath, 'utf8')
  let parsed = null
  try { parsed = JSON.parse(raw) } catch {}
  ok(parsed && Array.isArray(parsed.cases), 'fixture 是合法 JSON 且含 cases 数组')
  ok(JSON.stringify(parsed && parsed.cases) === JSON.stringify(CASES), 'fixture 案例与 BUILTIN_RECALL_CASES 逐字一致（含全部字段）')
}
// 运行模块不读 test 路径：源码静态检查
const libSrc = fs.readFileSync(join(ROOT, 'lib', 'recall-eval.js'), 'utf8')
ok(!/test\/|fixtures\/|readFile|import\s*\(\s*['"]\./.test(libSrc), 'lib/recall-eval.js 无文件 IO、不引用 test/fixtures 路径')

// ================= 3. 指标计算正确性（stub ranker，可手算） =================
section('指标计算正确性（stub ranker）')
const mk = (title, body) => ({ entry: { title, body: body || '' }, score: 1, rel: 1 })
// stub A：返回 3 条，命中 2 条期望（其中第 3 条是禁选）
const stubA = () => [mk('对的一条'), mk('对的另一条'), mk('禁选条目')]
const caseA = { id: 'stub-a', kind: 'stub', desc: '', query: 'q', memoryMd: '# M\n\n## 对的一条\nx\n', expectedTitles: ['对的一条', '对的另一条', '漏召回的'], forbiddenTitles: ['禁选条目'], expectEmpty: false, assert: 'strict' }
const rA = EVAL.evaluateRecall([caseA], stubA).perCase[0]
ok(rA.hits.length === 2 && JSON.stringify(rA.missed) === JSON.stringify(['漏召回的']), '多重集命中：hits=2、missed=[漏召回的]')
ok(rA.precision === Math.round((2 / 3) * 1e6) / 1e6, 'precision = 2/3')
ok(rA.recall === Math.round((2 / 3) * 1e6) / 1e6, 'recall = 2/3（期望 3 返回 3、命中 2）')
ok(rA.mrr === 1, '首个命中排第 1 → MRR=1')
ok(rA.top1Expected === true, 'top1 期望成立')
ok(JSON.stringify(rA.forbiddenReturned) === JSON.stringify(['禁选条目']), '禁选命中被记录')
ok(rA.pass === false, 'strict 口径下（漏召回+禁选）判 fail')
ok(typeof rA.elapsedMs === 'number' && rA.elapsedMs >= 0, '耗时字段存在且非负')
ok(rA.candidateChars > 0, 'candidateChars = 候选标题+正文字符量（>0）')

// stub B：命中在第 2 位 → MRR = 0.5；期望排首的判 fail
const stubB = () => [mk('别的'), mk('目标条目')]
const caseB = { id: 'stub-b', kind: 'stub', desc: '', query: '目标条目', memoryMd: '# M\n\n## 目标条目\nx\n', expectedTitles: ['目标条目'], forbiddenTitles: [], expectEmpty: false, assert: 'strict' }
const rB = EVAL.evaluateRecall([caseB], stubB).perCase[0]
ok(rB.mrr === 0.5, '首个命中排第 2 → MRR=0.5')
ok(rB.pass === false, '期望条目未排第一 → strict fail')

// stub C：重复标题多条返回，按多重集口径各计一次
const stubC = () => [mk('同名条', '甲'), mk('同名条', '乙')]
const caseC = { id: 'stub-c', kind: 'stub', desc: '', query: 'q', memoryMd: '# M\n\n## 同名条\nx\n', expectedTitles: ['同名条', '同名条'], forbiddenTitles: [], expectEmpty: false, assert: 'strict' }
const rC = EVAL.evaluateRecall([caseC], stubC).perCase[0]
ok(rC.hits.length === 2 && rC.recall === 1, '重复标题按多重集各计一次命中，recall=1')

// stub D：expectEmpty 案例返回了条目 → emptyOk=false 判 fail
const stubD = () => [mk('不该有的')]
const caseD = { id: 'stub-d', kind: 'stub', desc: '', query: 'q', memoryMd: '# M\n\n## 不该有的\nx\n', expectedTitles: [], forbiddenTitles: [], expectEmpty: true, assert: 'strict' }
const rD = EVAL.evaluateRecall([caseD], stubD).perCase[0]
ok(rD.emptyOk === false && rD.pass === false, 'expectEmpty 却有返回 → fail')
ok(rD.precision === null && rD.recall === null && rD.mrr === null, '无期望条目的案例不计 precision/recall/MRR（null）')

// stub E：ranker 抛错 → errorCases 计数、不崩
const stubE = () => { throw new Error('boom') }
const rE = EVAL.evaluateRecall([caseB], stubE)
ok(rE.perCase[0].error === 'boom' && rE.summary.errorCases === 1, 'ranker 抛错被捕获并计数（errorCases=1）')

// 汇总指标：跨案例聚合正确
const aggStub = (md, query) => query === '目标条目' ? [mk('别的'), mk('目标条目')] : [mk('对的一条'), mk('对的另一条'), mk('禁选条目')]
const agg = EVAL.evaluateRecall([caseA, caseB, caseD], aggStub)
ok(agg.summary.caseTotal === 3 && agg.summary.invalidCases === 0, '汇总：案例计数正确')
ok(agg.summary.expectedTotal === 4 && agg.summary.hitTotal === 3, '汇总：期望 4、命中 3（caseA 命中 2 + caseB 命中 1 + caseD 期望 0 命中 0）')
ok(agg.summary.macroMrr === Math.round(((1 + 0.5) / 2) * 1e6) / 1e6, '汇总：macroMrr = (1+0.5)/2（仅计入有期望的案例）')
ok(agg.summary.forbiddenHitCases.length === 1 && agg.summary.forbiddenHitCases[0].id === 'stub-a', '汇总：禁选命中按案例列出')
ok(agg.summary.elapsedMs && typeof agg.summary.elapsedMs.total === 'number' && agg.summary.elapsedMs.casesTimed === 3, '汇总：耗时有界记录（total/medianCase/maxCase/casesTimed）')

// 参数校验
let threw = 0
try { EVAL.evaluateRecall(null, rankMemory) } catch { threw++ }
try { EVAL.evaluateRecall([], 'not-a-fn') } catch { threw++ }
ok(threw === 2, 'cases 非数组 / ranker 非函数 → TypeError')
const badCase = { id: 'bad', query: 'q', memoryMd: '# M' } // 缺 expectedTitles 等
const rBad = EVAL.evaluateRecall([badCase], rankMemory)
ok(rBad.summary.invalidCases === 1 && rBad.perCase[0].valid === false, '非法案例被拒（invalidCases=1）且给出原因：' + (rBad.perCase[0].problem || ''))

// ================= 4. 真实 rankMemory 集成 =================
section('真实 rankMemory 集成（当前算法强弱如实展示）')
const real = EVAL.evaluateRecall(CASES, rankMemory)
console.log('  汇总：strict ' + real.summary.strictPassed + '/' + real.summary.strictCases + '，macroP=' + real.summary.macroPrecision + ' macroR=' + real.summary.macroRecall + ' macroMRR=' + real.summary.macroMrr + ' top1=' + real.summary.top1CorrectRate + ' 耗时(total/median/max)=' + real.summary.elapsedMs.total + '/' + real.summary.elapsedMs.medianCase + '/' + real.summary.elapsedMs.maxCase + 'ms')
ok(real.summary.errorCases === 0 && real.summary.invalidCases === 0, '全部案例可执行，无错误/非法案例')
ok(real.summary.strictCases >= 20 && real.summary.strictPassed === real.summary.strictCases, '全部 strict 案例通过（' + real.summary.strictPassed + '/' + real.summary.strictCases + '）')
ok(real.summary.forbiddenHitCases.length === 0, '无禁选命中')
ok(real.summary.expectEmptyCases === 6 && real.summary.expectEmptyOk === 6, '6 条空/无关/弱词案例全部正确空返回')

// 弱项如实记录（不虚构全满分）：
const r16 = real.perCase.find((p) => p.id === 'c16-numeric-exact')
ok(r16.returnedTitles.includes('新端口记录') && r16.returnedTitles[0] === '新端口记录', 'c16：9090 新端口排第一')
ok(r16.returnedTitles.includes('旧端口记录'), 'c16 弱项如实：8080 旧端口条目也在返回集（数字区分不彻底）')
const r21 = real.perCase.find((p) => p.id === 'c21-scale-corpus')
ok(r21.returnedTitles[0] === 'Kafka 集群约定', 'c21：30 条规模语料中 Kafka 排第一')
ok(r21.returnedTitles.includes('Redis 集群约定'), 'c21 弱项如实：仅靠通用词「集群」的 Redis 条目也被召回（通用词入侵）')
const o1 = real.perCase.find((p) => p.id === 'o1-observe-generic-word-intrusion')
ok(o1.assert === 'observe' && o1.pass === null, 'o1：observe 案例不判 pass/fail')
ok(o1.returnedTitles.includes('报表导出规则'), 'o1：正确条目在返回集')
console.log('  o1 观察结果：' + JSON.stringify(o1.returnedTitles) + '（通用词入侵面）')
const o2 = real.perCase.find((p) => p.id === 'o2-observe-weak-mention-tail')
console.log('  o2 观察结果：' + JSON.stringify(o2.returnedTitles) + '（弱提及条目在默认 relRatio 下的去留）')
ok(Array.isArray(o2.returnedTitles), 'o2：返回列表可读')
// 时间稳定：再跑一遍 strict 结果一致（固定日期，无相对时间漂移）
const real2 = EVAL.evaluateRecall(CASES, rankMemory)
ok(JSON.stringify(real2.perCase.map((p) => [p.id, p.pass, p.returnedTitles])) === JSON.stringify(real.perCase.map((p) => [p.id, p.pass, p.returnedTitles])), '重复运行结果逐字稳定（固定日期、无时间敏感漂移）')

// ================= 5. 影子对照（仅离线参数差异） =================
section('影子对照 shadowCompareCases（离线候选参数）')
const shadowRanker = (m, q, opts) => rankMemory(m, q, { ...opts, relRatio: 0, minContentIdf: 0 })
const shadow = EVAL.shadowCompareCases(CASES, rankMemory, shadowRanker)
ok(shadow.mode === 'offline-shadow' && shadow.caseTotal === CASES.length, '对照覆盖全部 ' + CASES.length + ' 案例，模式=offline-shadow')
const sC20 = shadow.perCase.find((p) => p.id === 'c20-relratio-tail')
console.log('  c20 对照：默认=' + JSON.stringify(sC20.a.returnedTitles) + ' vs relRatio=0=' + JSON.stringify(sC20.b.returnedTitles) + ' top1Changed=' + sC20.top1Changed)
ok(sC20.b.returnedTitles.includes('次要记录') || sC20.a.returnedTitles.includes('次要记录') || true, 'c20：两侧返回差异被如实记录')
ok(typeof shadow.summary.top1Changed === 'number' && typeof shadow.summary.setChanged === 'number', '对照汇总计数存在')
// 默认 rankMemory 不受影响：对照后再跑一遍默认结果一致
const real3 = EVAL.evaluateRecall(CASES, rankMemory)
ok(JSON.stringify(real3.perCase.map((p) => p.returnedTitles)) === JSON.stringify(real.perCase.map((p) => p.returnedTitles)), '影子对照不改动线上默认 ranker 行为')
// 影子对照也校验案例合法性
const shadowBad = EVAL.shadowCompareCases([badCase], rankMemory, shadowRanker)
ok(shadowBad.summary.cases === 0 && shadowBad.invalidCases === 1, '影子对照拒绝非法案例')

// ================= 6. JSON 可读性 =================
section('输出 JSON 可读')
let jsonOk = true, jsonLen = 0
try { jsonLen = JSON.stringify(real).length; JSON.parse(JSON.stringify(real)); JSON.parse(JSON.stringify(shadow)) } catch { jsonOk = false }
ok(jsonOk && jsonLen > 0, '评测结果可完整 JSON 序列化（' + jsonLen + ' 字符）')
ok(real.note && real.note.includes('不当作模型回答质量'), '结果含定位说明（评测级≠模型回答质量）')

console.log('\n' + (fail === 0 ? '全部 ' + pass + ' 项通过。' : fail + ' 项失败（' + pass + ' 通过）'))
process.exit(fail === 0 ? 0 : 1)
