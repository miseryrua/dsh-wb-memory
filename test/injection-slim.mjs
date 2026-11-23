#!/usr/bin/env node
/**
 * dsh-wb-memory 任务 B：注入瘦身与相关性门槛（lib/injection-slim.js + rankMemory scene:'inject'）
 *
 * 全部语料为虚构（foo-mem 之类），不读取、不拷贝任何真实记忆正文。
 * 覆盖：
 *   1) 回执 / 元数据注释不进注入文本，MEMORY.md 字节不变，剔除后不留成串空行；
 *   2) 字符预算基于剔除后的正文；
 *   3) 噪声场景合成复现：旧实现（fixtures/retrieve-before-injection-slim.mjs 冻结副本）
 *      会注入无关条目，新实现不注入；
 *   4) 强相关条目仍被召回、排序不变（24 条既有评测逐条对照）；
 *   5) 主动检索（searchMemory / 默认 scene）与旧实现逐条一致，未被收紧；
 *   6) 无合格条目回落「长期摘要」，标题 top-N 用实际条数；
 *   7) 诊断 reason 'generic-only' 与面板文案；
 *   8) 「除这两项有意变更外其余不变」：带注释的 MEMORY.md 与手工去注释的等价 MEMORY.md 组装结果逐字一致。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripInjectionNoise } from '../lib/injection-slim.js'
import { rankMemory, searchMemory, retrieveRelevant, summarizeEntries, INJECT_SCENE_DEFAULTS } from '../lib/retrieve.js'
import { BUILTIN_RECALL_CASES } from './recall-eval-lib.mjs'
import { runRecallEvaluation } from './recall-eval-lib.mjs'
import * as OLD from './fixtures/retrieve-before-injection-slim.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = join(HERE, '..')
let n = 0
const test = (name, fn) => { fn(); n++; console.log('PASS ' + name) }
const sha = (t) => createHash('sha256').update(t).digest('hex')

// ---------------- 虚构语料 ----------------
const H64 = 'ab12cd34'.repeat(8) // 64 位十六进制，形似提炼回执
const receipt = (d) => '<!-- wb-distill-batch:' + d + ':' + H64 + ' -->'
const meta = (tags, d) => '<!-- tags: ' + tags + ' / date: ' + d + ' / importance: high -->'
const longBody = (s) => Array.from({ length: 14 }, (_, i) => s + '第' + i + '段：插件功能与安装路径、版本0.3.0规则见上，后续迭代待验。').join('')
// 库内「到处都有」的通用词：插件 / 功能 / 迭代 / 安装 / 0.3.0
const noiseEntries = [
  ['归档插件0.3.0规则与待验', [meta('归档,插件', '2026-11-02'), 'X', '', receipt('2026-11-02')], longBody('归档')],
  ['长程任务可协作、验收只认独立断言', [], '长程任务可协作，不自动派代理；验收只认独立断言，插件功能迭代另议。'],
  ['整理插件合并与安装路径', [], '整理插件合并，1.0.1 功能迭代，安装须走官方流程，0.3.0 以后版本同理。\n\n' + meta('整理,验收', '2026-11-03') + '\n后续验收设计：插件安装要核对，功能分步推进。\n\n' + receipt('2026-11-02')],
  ['定时任务思考强度0.3.0已安装', [], '定时任务插件0.3.0已安装，功能选择思考强度，后续迭代待验。'],
]
const filler = [
  ['打印机驱动', '办公室打印机驱动安装在二楼。'],
  ['差旅报销规则', '差旅报销按月结算。'],
  ['周会时间', '周会固定周二上午。'],
  ['备份策略', '每周备份一次，保留三份。'],
  ['邮箱配置', '邮箱使用企业域名。'],
  ['路由器密码轮换', '路由器每季度轮换。'],
  ['插件目录约定', '本地插件放在统一目录，功能清单单独维护。'],
]
const REL_TITLE = '记忆插件迁移候选'
const relEntry = () => '\n' + meta('记忆,插件,迁移', '2026-11-06') + '\n## ' + REL_TITLE + '\n评估把 foo-mem 记忆插件迁移到备选方案：优先试用候选 A，保留自动提炼与面板功能。\n\n' + receipt('2026-11-06') + '\n'
function buildMd({ withRelevant = true, withNoise = true } = {}) {
  const parts = ['# 项目长期记忆', '']
  if (withRelevant) parts.push(relEntry())
  if (withNoise) for (const [title, , body] of noiseEntries) {
    const first = noiseEntries.find((e) => e[0] === title)
    const pre = first[1].filter(Boolean)
    // 第二元素是条目前后的簿记行；归档那条把元数据放在标题前、回执放正文后
    if (title.startsWith('归档')) parts.push(pre[0], '## ' + title, body, '', pre[2], '')
    else parts.push('## ' + title, body, '')
  }
  for (const [t, b] of filler) parts.push('## ' + t, b, '')
  return parts.join('\n')
}
const QUERY = '帮我看看 foo-mem 还有没有可以迭代的功能'
const titlesOf = (rows) => rows.map((r) => r.entry.title)
const NOISE_TITLES = noiseEntries.map((e) => e[0])

// ---------------- 1. stripInjectionNoise 单元 ----------------
test('回执 / 管理标记 / 元数据注释被剔除', () => {
  assert.equal(stripInjectionNoise('正文一\n\n' + receipt('2026-11-06') + '\n'), '正文一')
  assert.equal(stripInjectionNoise('甲\n<!-- tags: a,b / date: 2026-11-03 / importance: high -->\n乙'), '甲\n乙')
  assert.equal(stripInjectionNoise('甲 <!-- wb-memory:eyJ2IjoxfQ --> 乙'), '甲 <!-- wb-memory:eyJ2IjoxfQ --> 乙')
  assert.equal(stripInjectionNoise('甲\n<!-- wb-memory:eyJ2IjoxfQ -->\n乙'), '甲\n<!-- wb-memory:eyJ2IjoxfQ -->\n乙')
})
test('剔除后不留成串空行，首尾空行去掉', () => {
  const t = '段一\n\n' + meta('x', '2026-11-03') + '\n\n段二\n\n\n' + receipt('2026-11-02') + '\n\n' + receipt('2026-11-02') + '\n'
  const out = stripInjectionNoise(t)
  assert.equal(out, '段一\n\n段二')
  assert.ok(!/\n{3,}/.test(out))
})
test('其它 HTML 注释与无注释文本保持原样（逐字节）', () => {
  const keep = '正文 <!-- TODO: 用户自己的备注 --> 结尾\n\n\n\n保留多余空行'
  assert.equal(stripInjectionNoise(keep), keep)
  const plain = '无注释\n\n\n三个换行也不动'
  assert.equal(stripInjectionNoise(plain), plain)
  assert.equal(stripInjectionNoise(''), '')
})
test('summarizeEntries 摘要头同样剔除簿记注释', () => {
  const md = '## 甲\n结论一 ' + receipt('2026-11-06') + ' 尾巴\n'
  const out = summarizeEntries(md, 1500)
  assert.ok(out.includes('结论一') && !out.includes('wb-distill-batch'))
})

// ---------------- 搭沙箱（与 assembly-v013 同款：拷贝 lib 到临时插件目录） ----------------
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-wb-memory-test-'))
process.on('exit', () => { try { rmSync(sandbox, { recursive: true, force: true }) } catch {} })
const plugin = join(sandbox, 'plugin'), wsroot = join(sandbox, 'workspaces'), cwd = join(wsroot, 'A')
const memDir = join(cwd, '.workbuddy', 'memory')
mkdirSync(join(plugin, 'lib'), { recursive: true }); mkdirSync(memDir, { recursive: true })
for (const f of readdirSync(join(root, 'lib'))) if (f.endsWith('.js')) copyFileSync(join(root, 'lib', f), join(plugin, 'lib', f))
copyFileSync(join(root, 'package.json'), join(plugin, 'package.json'))
const baseCfg = { enabled: true, workspaceRoot: wsroot, activeProject: 'A', autoDistill: false, sessionSummary: false }
writeFileSync(join(plugin, 'config.json'), JSON.stringify(baseCfg))
writeFileSync(join(plugin, 'USER.md'), '画像只供诊断。')
const idx = await import(pathToFileURL(join(plugin, 'lib', 'index.js')))
const memFile = join(memDir, 'MEMORY.md')
const ctx = (q) => ({ messages: [{ role: 'user', content: q }] })
function assemble(md, q, cfg = baseCfg) {
  writeFileSync(memFile, md)
  let trace = null
  const block = idx.buildMemoryBlock(cwd, ctx(q), cfg, (t) => { trace = t })
  return { block, trace }
}
const memorySection = (block) => {
  const a = block.indexOf('### 长期记忆 /')
  if (a < 0) return ''
  const m = /\n(?:### (?!长期记忆)|## )/g; m.lastIndex = a + 1
  const e = m.exec(block)
  return block.slice(a, e ? e.index : block.length)
}

// ---------------- 2. 注入文本里没有簿记注释，MEMORY.md 字节不变 ----------------
const mdFull = buildMd()
test('改动前：噪声场景的旧实现会注入无关条目，且无关条目排第一（复现）', () => {
  const rows = OLD.rankMemory(mdFull, QUERY, { k: 5 })
  const t = titlesOf(rows)
  const noiseHit = t.filter((x) => NOISE_TITLES.includes(x))
  assert.ok(noiseHit.length >= 3, '旧实现应注入 ≥3 条无关条目，实际 ' + JSON.stringify(t))
  assert.ok(NOISE_TITLES.includes(t[0]), '旧实现 top-1 是无关条目：' + t[0])
  assert.ok(t.includes(REL_TITLE), '相关条目也在其中，只是被噪声挤到后面')
})
test('改动后：同一场景只注入相关条目（诊断含 generic-only）', () => {
  let audit = null
  const rows = rankMemory(mdFull, QUERY, { k: 5, scene: 'inject', onDiagnostics: (a) => { audit = a } })
  assert.deepEqual(titlesOf(rows), [REL_TITLE])
  const reasons = Object.fromEntries(audit.candidates.map((c) => [c.title, c.reason]))
  assert.ok(NOISE_TITLES.some((t) => reasons[t] === 'generic-only'), '至少一条无关条目以 generic-only 被过滤：' + JSON.stringify(reasons))
  assert.equal(audit.scene, 'inject')
})
test('整库注入：相关条目在、无关条目不在；标题 top-N 用实际条数', () => {
  const { block, trace } = assemble(mdFull, QUERY)
  const sec = memorySection(block)
  assert.ok(sec.startsWith('### 长期记忆 / 相关条目（按当前任务召回 top-1）'), sec.slice(0, 60))
  assert.ok(sec.includes('#### ' + REL_TITLE))
  for (const t of NOISE_TITLES) assert.ok(!block.includes('#### ' + t), '不应注入：' + t)
  assert.equal(trace.mode, 'relevant')
})
test('注入文本不含回执 / 元数据注释；MEMORY.md 字节不变', () => {
  const before = readFileSync(memFile)
  const { block } = assemble(mdFull, QUERY)
  // 先写入再读回，确认装配期间没有回写
  const after = readFileSync(memFile)
  assert.equal(sha(after), sha(Buffer.from(mdFull)))
  assert.ok(before.equals(Buffer.from(mdFull)) && after.equals(before))
  assert.ok(!/wb-distill-batch/.test(block), '回执不应出现')
  // 固定的「记忆纪律」说明文字里本来就举例写了 <!-- tags: … -->，所以只检查长期记忆段
  assert.ok(!/<!--/.test(memorySection(block)), '长期记忆段不应含任何簿记注释')
  assert.ok(!/importance:\s*high/.test(memorySection(block)))
  assert.ok(!/[0-9a-f]{64}/.test(block), '64 位十六进制回执哈希不应出现')
})
test('命中带中段元数据注释的无关条目时，正文里也没有注释与成串空行（强制放行：关闭门槛）', () => {
  // 用 relRatio:0 / minContentIdf:0 显式放行，确认「瘦身」独立于「门槛」
  const rows = rankMemory(mdFull, QUERY, { k: 5, scene: 'inject', relRatio: 0, minContentIdf: 0 })
  const t = titlesOf(rows)
  assert.ok(t.includes('整理插件合并与安装路径'))
  const { block } = assemble(mdFull, QUERY, { ...baseCfg, entryMaxChars: 4000 })
  // 默认门槛下该条目不入选，所以直接对 stripInjectionNoise(原正文) 断言
  const e = rows.find((r) => r.entry.title === '整理插件合并与安装路径').entry
  assert.ok(e.body.includes('<!-- tags:'), '原正文确实带中段元数据注释（夹具有效）')
  const slim = stripInjectionNoise(e.body)
  assert.ok(!slim.includes('<!--') && !/\n{3,}/.test(slim))
  assert.ok(slim.includes('后续验收设计') && slim.includes('整理插件合并'))
  assert.ok(block.length > 0)
})

// ---------------- 3. 字符预算基于剔除后的文本 ----------------
test('entryMaxChars 以剔除后的正文计：刚好放得下时不出现截断标记', () => {
  const body = '要点甲。'.repeat(20) // 80 字
  const noisy = body + '\n\n' + meta('x', '2026-11-06') + '\n\n' + receipt('2026-11-06') + '\n'
  const md = '# 项目长期记忆\n\n## 预算演示条目\n' + noisy + '\n' + filler.map(([t, b]) => '## ' + t + '\n' + b + '\n').join('\n')
  // 条目数 8 → 触发 inject 的 idf 门槛；预算演示条目的标题词唯一
  const q = '预算演示条目'
  const cfg = { ...baseCfg, entryMaxChars: body.length + 5 }
  const { block, trace } = assemble(md, q, cfg)
  const sec = memorySection(block)
  assert.ok(sec.includes('#### 预算演示条目'), sec.slice(0, 120))
  assert.ok(!sec.includes('截断，完整见 MEMORY.md'), '剔除后正文 ' + body.length + ' 字，应放得下')
  assert.equal(trace.entries[0].bodyChars, body.length, 'bodyChars 记录剔除后长度')
  assert.ok(!sec.includes('<!--'))
})

// ---------------- 4. 强相关仍召回且排序不变（24 条既有评测逐条对照） ----------------
test('24 条评测：inject 场景期望命中仍 21/21，且是默认场景结果的有序子序列、分数逐条不变', () => {
  let hit = 0, total = 0
  for (const c of BUILTIN_RECALL_CASES) {
    const base = rankMemory(c.memoryMd, c.query, { k: 5, ...(c.rankerOpts || {}) })
    const inj = rankMemory(c.memoryMd, c.query, { k: 5, scene: 'inject', ...(c.rankerOpts || {}) })
    const bt = titlesOf(base), it = titlesOf(inj)
    // 有序子序列
    let p = 0
    for (const t of bt) if (p < it.length && it[p] === t) p++
    assert.equal(p, it.length, c.id + '：inject 结果须是默认结果的有序子序列 ' + JSON.stringify({ bt, it }))
    assert.equal(it[0], bt[0], c.id + '：top-1 不变')
    for (let i = 0; i < inj.length; i++) {
      const same = base.find((b) => b.entry === inj[i].entry || (b.entry.title === inj[i].entry.title && b.score === inj[i].score))
      assert.ok(same && same.score === inj[i].score, c.id + '：分数不变')
    }
    if (!c.expectEmpty) { const pool = it.slice(); for (const t of c.expectedTitles) { total++; const j = pool.indexOf(t); if (j >= 0) { hit++; pool.splice(j, 1) } } }
    else assert.equal(it.length, 0, c.id + ' 应空返回')
  }
  assert.equal(total, 21); assert.equal(hit, 21)
})
test('离线口径：候选 K=5 符合预期数至少 23，期望命中 21/21，无禁选', () => {
  for (const k of [1, 3, 5]) {
    const r = runRecallEvaluation(k)
    assert.ok(r.baseline.summary.passed >= 22, 'k=' + k + ' baseline passed=' + r.baseline.summary.passed)
    assert.equal(r.baseline.summary.expectedHits, 21); assert.equal(r.baseline.summary.expectedTotal, 21)
    assert.equal(r.baseline.summary.forbiddenHits, 0)
    assert.ok(r.candidate.summary.passed >= (k === 1 ? 22 : 20))
  }
  const r5 = runRecallEvaluation(5)
  assert.ok(r5.baseline.summary.passed >= 23, '实际 ' + r5.baseline.summary.passed)
  assert.ok(r5.baseline.cases.some((c) => !c.passed), '弱项如实保留（o2 弱提及条目仍在）')
})
test('强相关条目在噪声库里排第一，且在去噪后仍排第一', () => {
  const rows = rankMemory(mdFull, 'foo-mem 迁移候选', { k: 5, scene: 'inject' })
  assert.equal(rows[0].entry.title, REL_TITLE)
  const rows2 = rankMemory(mdFull, 'foo-mem 迁移候选', { k: 5 })
  assert.equal(rows2[0].entry.title, REL_TITLE)
})

// ---------------- 5. 主动检索未被收紧 ----------------
test('默认 scene（searchMemory / retrieveRelevant / rankMemory 默认）与旧实现逐条一致', () => {
  for (const md of [mdFull, buildMd({ withRelevant: false })]) {
    for (const q of [QUERY, '插件 功能 迭代', 'foo-mem', '安装 0.3.0']) {
      const a = searchMemory(md, { q, k: 5 }).map((e) => e.title)
      const b = OLD.searchMemory(md, { q, k: 5 }).map((e) => e.title)
      assert.deepEqual(a, b, q)
      assert.deepEqual(retrieveRelevant(md, q, 5).map((e) => e.title), OLD.retrieveRelevant(md, q, 5).map((e) => e.title), q)
    }
  }
  for (const c of BUILTIN_RECALL_CASES) {
    const a = rankMemory(c.memoryMd, c.query, { k: 5 }).map((r) => [r.entry.title, r.score])
    const b = OLD.rankMemory(c.memoryMd, c.query, { k: 5 }).map((r) => [r.entry.title, r.score])
    assert.deepEqual(a, b, c.id)
  }
})
test('主动检索仍能找到通用词命中的条目（宁多勿漏）', () => {
  const md = buildMd({ withRelevant: false })
  const hits = searchMemory(md, { q: '插件 功能 迭代 安装', k: 5 }).map((e) => e.title)
  assert.ok(hits.length >= 3, '主动检索应返回多条：' + JSON.stringify(hits))
  assert.deepEqual(rankMemory(md, '插件 功能 迭代 安装', { k: 5, scene: 'inject' }), [], '同一查询在注入场景不凑数')
})
test('index.js 里 memory_search / 检索端点 / 预览之外没有给 searchMemory 传 scene', () => {
  const src = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const calls = [...src.matchAll(/searchMemory\([^\n]+, opts\)/g)].map((m) => m[0])
  assert.ok(calls.length >= 2)
  assert.ok(calls.every((c) => !/scene/.test(c)), calls.join(' | '))
  assert.equal([...src.matchAll(/scene: 'inject'/g)].length, 1, "只有注入拼装一处使用 scene:'inject'")
})
test('显式 relRatio / minContentIdf 优先于场景默认值', () => {
  const t = titlesOf(rankMemory(mdFull, QUERY, { k: 5, scene: 'inject', relRatio: 0, minContentIdf: 0 }))
  assert.ok(t.length >= 4 && t.includes(REL_TITLE), JSON.stringify(t))
  assert.equal(INJECT_SCENE_DEFAULTS.relRatio, 0.4)
})

// ---------------- 6. 无合格条目回落摘要 ----------------
test('只剩通用词命中（库里没有相关条目）：注入不凑数，回落「长期摘要」', () => {
  const md = buildMd({ withRelevant: false })
  assert.ok(titlesOf(OLD.rankMemory(md, QUERY, { k: 5 })).length >= 3, '旧实现会凑出 ≥3 条无关条目')
  assert.deepEqual(rankMemory(md, QUERY, { k: 5, scene: 'inject' }), [])
  const { block, trace } = assemble(md, QUERY)
  assert.ok(block.includes('### 长期记忆 / 摘要（无高度相关条目'), '回落摘要标题')
  assert.ok(!block.includes('### 长期记忆 / 相关条目'))
  assert.equal(trace.mode, 'fallback-summary')
  for (const t of NOISE_TITLES) assert.ok(!block.includes('#### ' + t))
  assert.ok(!/wb-distill-batch/.test(block))
})
test('小库（条目数 < minCorpus）不启用绝对 idf 门槛，只用相对门槛', () => {
  const small = '## 甲\n插件功能迭代\n\n## 乙\n插件安装\n'
  assert.ok(INJECT_SCENE_DEFAULTS.minCorpus > 2)
  assert.equal(titlesOf(rankMemory(small, '插件 安装', { k: 5, scene: 'inject' })).includes('乙'), true)
})

// ---------------- 7. 面板文案 ----------------
test('面板有 generic-only 原因文案', () => {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(/'generic-only':\s*'仅通用词命中'/.test(src))
})

// ---------------- 8. 其余不变：带注释 vs 手工去注释 ----------------
test('带注释的 MEMORY.md 与手工去注释的等价 MEMORY.md 组装结果逐字一致（其余不变）', () => {
  const dirty = [
    '# 项目长期记忆', '',
    meta('发布,回滚', '2026-01-02'), '## 发布回滚方案', '发布回滚需要先确认版本与告警。', '', meta('补充', '2026-01-03'), '回滚后还要核对监控。', '', receipt('2026-01-03'), '',
    '## 夜间备份', '夜间备份每天03:20执行。', '',
  ].join('\n')
  const clean = [
    '# 项目长期记忆', '',
    meta('发布,回滚', '2026-01-02'), '## 发布回滚方案', '发布回滚需要先确认版本与告警。', '', '回滚后还要核对监控。', '',
    '## 夜间备份', '夜间备份每天03:20执行。', '',
  ].join('\n')
  // 0.14.4 容量行按 MEMORY.md 原文字符数（与巡检判超、状态接口同口径），两份原文长度不同，比较时剔除该行并单独核对。
  const cap = /\n- 长期记忆容量：MEMORY\.md (\d+) [^\n]*/
  const noCap = (t) => t.replace(cap, '')
  assert.equal(Number(cap.exec(assemble(dirty, '发布回滚', baseCfg).block)[1]), dirty.length)
  assert.equal(Number(cap.exec(assemble(clean, '发布回滚', baseCfg).block)[1]), clean.length)
  for (const injectionMaxChars of [4000, 12000]) {
    const cfg = { ...baseCfg, injectionMaxChars }
    const a = noCap(assemble(dirty, '发布回滚', cfg).block), b = noCap(assemble(clean, '发布回滚', cfg).block)
    assert.equal(a, b, JSON.stringify({ injectionMaxChars }))
    assert.ok(!a.includes('wb-distill-batch'))
    if (injectionMaxChars === 12000) assert.ok(a.includes('回滚后还要核对监控。'), '预算充足时正文完整保留')
  }
  // 无查询（摘要层）同样不变
  assert.equal(noCap(assemble(dirty, '', baseCfg).block), noCap(assemble(clean, '', baseCfg).block))
})

// ---------------- 9. 返工：长度归一 / 指令措辞带偏 / 词边界伪 bigram / 无相关回落 ----------------
const topics = ['打印机驱动','差旅报销','周会安排','备份策略','邮箱配置','路由器轮换','门禁卡发放','茶水间清洁','会议室预订','网络带宽']
const fillMd = topics.map((x) => '## ' + x + '\n' + x + '相关的日常约定，按行政流程办理。\n').join('\n')
test('指令措辞带偏：仅正文含稀有指令词的条目不注入（无需硬编码具体词）', () => {
  // 「评审/方案」只在无关条目正文里各出现一次，idf 高，但不在任何标题/标签里
  const md = '# M\n\n## 缓存淘汰策略\n缓存使用 LRU，容量一千条。\n\n## 采购流程\n采购须评审方案后签字，再交给财务。\n\n' + fillMd
  const q = '帮我看看缓存还有没有可以改进的，你只负责出方案与评审，其他交给别人'
  const inj = titlesOf(rankMemory(md, q, { k: 5, scene: 'inject' }))
  assert.deepEqual(inj, ['缓存淘汰策略'])
  assert.ok(titlesOf(OLD.rankMemory(md, q, { k: 5 })).includes('采购流程'), '旧实现会被指令词带进来')
})
test('长条目不能靠篇幅压过短而切题的条目（inject 场景）', () => {
  const longBody = Array.from({ length: 60 }, () => '部署脚本更新说明，部署前检查部署环境。').join('')
  const md = '# M\n\n## 部署排障清单\n' + longBody + '\n\n## 部署回滚口令\n回滚口令是 rollback-now。\n\n' + fillMd
  const q = '部署回滚口令'
  const search = titlesOf(rankMemory(md, q, { k: 5 }))
  const inj = titlesOf(rankMemory(md, q, { k: 5, scene: 'inject' }))
  assert.equal(inj[0], '部署回滚口令')
  assert.ok(search.includes('部署排障清单'), 'search 口径不变')
})
test('词边界伪 bigram 单点锚点不放行；库内无相关条目时回落摘要', () => {
  const md = '# M\n\n## 子代理与团队约定\n子代理按需启动。\n\n' + fillMd
  const q = '对话整理与文件整理的设置是否可以分开'
  assert.deepEqual(rankMemory(md, q, { k: 5, scene: 'inject' }), [])
  const { block, trace } = assemble(md, q)
  assert.ok(block.includes('### 长期记忆 / 摘要（无高度相关条目'))
  assert.equal(trace.mode, 'fallback-summary')
})
test('no-anchor 诊断原因 + 面板文案 + 常量集中', () => {
  const md = '# M\n\n## 采购流程\n采购须评审方案后签字。\n\n## 缓存淘汰策略\n缓存使用 LRU。\n\n' + fillMd
  let a = null
  rankMemory(md, '缓存 评审方案', { k: 5, scene: 'inject', onDiagnostics: (x) => { a = x } })
  assert.ok(a.candidates.some((c) => c.reason === 'no-anchor'), JSON.stringify(a.candidates.map((c) => c.reason)))
  assert.ok(/'no-anchor':/.test(readFileSync(join(root, 'lib', 'client.js'), 'utf8')))
  // 常量集中在 INJECT_SCENE_DEFAULTS；长度归一经快照对照后移除（排序/入选无收益），常量不应残留
  for (const k of ['anchorMinIdf', 'anchorMinCjk', 'headIdentMinIdf', 'echoMaxTitleCjk']) assert.ok(k in INJECT_SCENE_DEFAULTS)
  assert.ok(!('lengthB' in INJECT_SCENE_DEFAULTS))
})

// ---------------- 10. 主题证据门槛（E1–E4）：全部虚构语料 ----------------
const inj = (md, q, o = {}) => titlesOf(rankMemory(md, q, { k: 5, scene: 'inject', ...o }))
const evidenceMd = (extra) => '# M\n\n' + extra + '\n\n' + fillMd
test('E4：仅首行出现的 API 专名（查询不加反引号、标题/标签没有）被召回', () => {
  const md = evidenceMd('## 提交流程要点\nsafeCommit 会在落盘前完整比对原始内容，不一致即拒绝。\n后续补充说明若干。\n\n## 其他约定\n报销按月办理。')
  assert.deepEqual(inj(md, 'safeCommit 的完整比对用于什么'), ['提交流程要点'])
  assert.deepEqual(inj(md, '想问问 safe-commit_v2 流程'), [], '词形相近但库里没有的标识符不放行')
})
test('E4：同样的专名只在正文远处顺带出现 → 不算主题，不召回', () => {
  const md = evidenceMd('## 值班交接规则\n交接时先清点工具，再确认值班表。\n工具清单见附录。\n第三行再说明。\n其实某个脚本里调用过 safeCommit 这个接口，顺带一提。')
  assert.deepEqual(inj(md, 'safeCommit 的完整比对用于什么'), [])
  let a = null
  rankMemory(md, 'safeCommit 的完整比对用于什么', { k: 5, scene: 'inject', onDiagnostics: (x) => { a = x } })
  assert.ok(a.candidates.some((c) => c.title === '值班交接规则' && c.reason === 'no-anchor'), JSON.stringify(a.candidates.map((c) => [c.title, c.reason])))
})
test('E4 形态判据只看词形：camelCase / 字母数字混合 / 连接符多段词均成立，普通英文词不成立', () => {
  for (const [name, q] of [['camel', 'applyPatchSet 做什么'], ['alnum', 'foo2bar 做什么'], ['joined', 'foo-bar-baz 做什么'], ['path', 'a/b/cfg 做什么']]) {
    const md = evidenceMd('## 杂项记录\n' + q.split(' ')[0] + ' 在这里首次定义。\n后续略。')
    assert.deepEqual(inj(md, q), ['杂项记录'], name)
  }
  const plain = evidenceMd('## 杂项记录\nrollout 在这里首次定义。\n后续略。')
  assert.deepEqual(inj(plain, 'rollout 做什么'), [], '普通英文词只在首行出现不算标识符形态')
})
test('E3：单个短中文主题词在标题与正文一致出现 → 召回（含单词查询）', () => {
  const md = evidenceMd('## 缓存淘汰策略\n缓存使用 LRU，容量一千条。\n\n## 采购流程\n采购须评审方案后签字。')
  assert.deepEqual(inj(md, '缓存'), ['缓存淘汰策略'])
  assert.deepEqual(inj(md, '帮我看看缓存还有没有可以改进的，其他交给别人'), ['缓存淘汰策略'])
})
test('E3：标题里有泛词、正文不谈 → 拦；长标题+正文顺带出现 → 也拦', () => {
  const blocked = evidenceMd('## 会议室门禁权限记录\n只讲门禁卡与登记表。')
  assert.deepEqual(inj(blocked, '想问问机房权限怎么弄'), [], '标题有「权限」、正文不谈')
  const longTitle = evidenceMd('## 会议室门禁卡发放登记与补办流程以及访客预约和值班巡检规则汇总\n这里顺带提到权限一次，其余讲流程。')
  assert.deepEqual(inj(longTitle, '想问问机房权限怎么弄'), [], '长标题里单个 bigram 只算顺带')
})
test('稀有指令词带偏：命中只来自首行/正文的指令性措辞 → 拦；真主题仍在', () => {
  const md = evidenceMd('## 存储配额说明\n配额按部门划分。\n\n## 年度计划\n计划由甲方统筹，乙方负责复核备案。')
  assert.deepEqual(inj(md, '帮我看看存储配额，你只负责复核与备案，其他统筹给别人'), ['存储配额说明'])
})
test('无相关条目：整库无证据 → 空 → 组装回落摘要', () => {
  const md = evidenceMd('## 年度计划\n计划由甲方统筹，乙方负责复核备案。')
  assert.deepEqual(inj(md, '你负责统筹与复核，具体备案由别人完成'), [])
  const { trace } = assemble(md, '你负责统筹与复核，具体备案由别人完成')
  assert.equal(trace.mode, 'fallback-summary')
})
test('显式关闭：minContentIdf:0 连同证据门槛一并关闭，返回无证据条目', () => {
  const md = evidenceMd('## 年度计划\n计划由甲方统筹，乙方负责复核备案。')
  const q = '你负责统筹与复核，具体备案由别人完成'
  assert.deepEqual(inj(md, q), [])
  assert.ok(inj(md, q, { minContentIdf: 0, relRatio: 0 }).includes('年度计划'))
})
test('独立开关：requireTopicEvidence:false 只关证据门槛，generic-only 照常生效', () => {
  const md = evidenceMd('## 年度计划\n计划由甲方统筹，乙方负责复核备案。')
  const q = '你负责统筹与复核，具体备案由别人完成'
  assert.ok(inj(md, q, { requireTopicEvidence: false }).includes('年度计划'))
  let a = null
  rankMemory(mdFull, QUERY, { k: 5, scene: 'inject', requireTopicEvidence: false, onDiagnostics: (x) => { a = x } })
  assert.ok(a.candidates.some((c) => c.reason === 'generic-only'), 'generic-only 不受该开关影响')
  // search 场景从不受该选项影响
  assert.deepEqual(titlesOf(rankMemory(md, q, { k: 5 })), titlesOf(rankMemory(md, q, { k: 5, requireTopicEvidence: true })))
})

console.log('injection-slim: ' + n + ' passed')
