#!/usr/bin/env node
/**
 * dsh-wb-memory 0.10.0 检索升级测试（lib/retrieve.js v10.0，2026-10-14）
 *
 * 覆盖：
 *   1) 旧查重口径逐字不变（tokenize / jaccard / overlapCoeff / detectDuplicates：源码级 + 运行时）
 *   2) 精准错误码 / 术语 / 路径（含全角归一化）
 *   3) 中文噪声与中英停用词（不误伤合法 bigram）
 *   4) 跨标点 / 中英交界的伪 bigram（红绿对照：旧 tokenize 含「置报」，新检索分词不含）
 *   5) 空查询 / 纯停用词 / 纯单字退化
 *   6) 日期过滤（searchMemory dateFrom/dateTo、retrieveRelevant 第 4 参 filter、非零填充归一化）
 *   7) 打分属性（标题>正文、IDF、时间/重要度加成、无关召回控制、relRatio 裁剪、排序稳定）
 *   8) 接口兼容（retrieveRelevant(md,q,k,filter) / searchMemory / 旧函数输出形状）
 *   9) 小标注集旧新版 top5 对比（打印实测指标，只断言不倒退）
 *
 * 用法：node test/retrieve-v010.mjs   （或在进程内 import，见 test/smoke.mjs 的约定）
 * 旧版参照源码（legacy oracle）默认取 ../../备份/lib/retrieve.js.bak-20261014-prev010，
 * 可用环境变量 WB_V010_LEGACY 覆盖。找不到即显式失败——没有 oracle 就无法验证「逐字不变」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as NEW from '../lib/retrieve.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.error('  ✗ ' + name)
  }
}
function section(t) {
  console.log('\n== ' + t + ' ==')
}
function setEq(a, b) {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}
function fmt(x) {
  return typeof x === 'number' ? x.toFixed(3) : String(x)
}
function titles(list) {
  return list.map((e) => (e && e.entry ? e.entry.title : e.title))
}
function sortByTitle(list) {
  return titles(list).slice().sort()
}
function sameSet(a, b) {
  const x = a.slice().sort()
  const y = b.slice().sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

// ---------- 旧版参照（legacy oracle）----------
function findLegacy() {
  const cands = []
  if (process.env.WB_V010_LEGACY) cands.push(process.env.WB_V010_LEGACY)
  cands.push(path.join(HERE, '..', '..', '备份', 'lib', 'retrieve.js.bak-20261014-prev010'))
  cands.push(path.join(HERE, '..', '备份', 'lib', 'retrieve.js.bak-20261014-prev010'))
  cands.push(path.join(HERE, 'fixtures', 'retrieve-v010-legacy.mjs'))
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c
  }
  // 兜底：在同级「备份/lib」里找名字像旧版的 retrieve 备份
  const dir = path.join(HERE, '..', '..', '备份', 'lib')
  if (fs.existsSync(dir)) {
    const hit = fs
      .readdirSync(dir)
      .filter((f) => /^retrieve.*\.(bak|mjs|js|cjs|txt)/.test(f))
      .sort((a, b) => (b.includes('prev010') ? 1 : 0) - (a.includes('prev010') ? 1 : 0))[0]
    if (hit) return path.join(dir, hit)
  }
  return null
}

const LEGACY_PATH = findLegacy()
let LEGACY = null
if (LEGACY_PATH) {
  // .bak 之类的扩展名 Node 不认（ERR_UNKNOWN_FILE_EXTENSION），改从源码走 data: URL 导入
  const src = fs.readFileSync(LEGACY_PATH, 'utf8')
  LEGACY = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'))
}
console.log('dsh-wb-memory 0.10.0 检索升级测试')
console.log('legacy oracle: ' + (LEGACY_PATH || '(未找到)'))
// 被测文件指纹：便于复核「测的是哪一版」，也便于发现被并发写者覆盖
const selfSrc = fs.readFileSync(fileURLToPath(new URL('../lib/retrieve.js', import.meta.url)))
const selfSha = (await import('node:crypto')).createHash('sha256').update(selfSrc).digest('hex').slice(0, 12)
console.log('被测 retrieve.js: ' + selfSrc.length + 'B sha256=' + selfSha)
if (!LEGACY) {
  console.error('  ✗ 找不到旧版参照源码，无法验证「查重口径逐字不变」与新老对比；请设 WB_V010_LEGACY')
  fail++
}

// ================= 语料 =================
const MD_NOISE = [
  '# 项目长期记忆',
  '',
  '## 日报统计脚本',
  '每天的日报都要汇总到表格里，用 node 跑一次',
  '',
  '## 报错排查记录',
  '乙行 启动时报 ENOENT，检查 D:/softwares/Node.js/node.exe 路径是否正确',
  '',
].join('\n')

const MD_CODE = [
  '# 项目长期记忆',
  '',
  '## 构建脚本记录',
  '乙行 用 node 跑构建，产物落在 dist',
  '',
  '## 启动报错记录',
  '乙行 启动时报 ENOENT 找不到文件',
  '',
  '## 端口问题',
  '乙行 连接被拒绝 ECONNREFUSED',
  '',
  '## 权限错误码',
  '乙行 报 0x80070005 拒绝访问',
  '',
  '## 系统 Node 路径',
  '乙行 D:/softwares/Node.js/node.exe 是本机 Node 24',
  '',
].join('\n')

// 动态日期：保证「40 天前」稳定落在 (30, 90) 的 ×1.1 档，避免测试随运行时间腐化
const dayMs = 86400000
const d40 = new Date(Date.now() - 40 * dayMs).toISOString().slice(0, 10)
const MD_DATES = [
  '# 项目长期记忆',
  '',
  '<!-- tags: t / date: 2026-08-05 -->',
  '## 八月条目',
  '乙行 DATQ 正文',
  '',
  '<!-- tags: t / date: 2026-09-20 -->',
  '## 九月条目',
  '乙行 DATQ 正文',
  '',
  '## 无日期条目',
  '乙行 DATQ 正文',
  '',
].join('\n')

const MD_BONUS_DATE = [
  '# 项目长期记忆',
  '',
  '<!-- tags: t / date: ' + d40 + ' -->',
  '## 四十天前',
  '乙行 ZZZQ 正文',
  '',
  '## 无日期',
  '乙行 ZZZQ 正文',
  '',
].join('\n')

const MD_BONUS_IMP = [
  '# 项目长期记忆',
  '',
  '<!-- tags: t / importance: high -->',
  '## 高重要条目',
  '乙行 ZZZQ 正文',
  '',
  '## 普通条目',
  '乙行 ZZZQ 正文',
  '',
].join('\n')

const MD_TITLE_BODY = [
  '# 项目长期记忆',
  '',
  '## 标题含 ZZZQ',
  '甲行 正文没有该词',
  '',
  '## 正文含',
  '甲行',
  '乙行 这里有 ZZZQ',
  '',
].join('\n')

const MD_REL = [
  '# 项目长期记忆',
  '',
  '## 强相关条目 ZZZQ',
  '乙行 ZZZQ ZZZQ ZZZQ 详细步骤',
  '',
  '## 弱相关条目',
  '甲行',
  '乙行 顺带提一句 ZZZQ',
  '',
].join('\n')

const MD_TIE = [
  '# 项目长期记忆',
  '',
  '## 并列甲',
  '乙行 TIEQ 正文',
  '',
  '## 并列乙',
  '乙行 TIEQ 正文',
  '',
].join('\n')

const mdIdf = (() => {
  const rows = ['# 项目长期记忆', '', '## 罕见词条目', '乙行 RAREQ 出现']
  for (let i = 0; i < 5; i++) rows.push('', '## 常见词条目' + i, '乙行 COMMONQ 出现')
  rows.push('')
  return rows.join('\n')
})()

const mdDup = [
  '# 项目长期记忆',
  '',
  '## 投资记录 甲',
  '定投沪深300，每月一千元，长期持有不动摇',
  '',
  '## 投资记录 乙',
  '定投沪深300，每月一千元，长期持有不动摇',
  '',
].join('\n')

// ================= 1. 旧查重口径逐字不变 =================
section('旧查重口径逐字不变（tokenize / jaccard / overlapCoeff / detectDuplicates）')
if (LEGACY) {
  for (const f of ['tokenize', 'jaccard', 'overlapCoeff', 'detectDuplicates', 'readMemoryEntries']) {
    ok(typeof NEW[f] === 'function' && String(NEW[f]) === String(LEGACY[f]), f + ' 源码逐字相同（与旧版字符串相等）')
  }
  const samples = [
    '配置 node 报错',
    'ENOENT ECONNREFUSED 0x80070005',
    '中文 English 混排 2026-09-01',
    'D:/softwares/Node.js/node.exe',
    '',
    'a',
    '的投资基金',
  ]
  let same = true
  for (const s of samples) if (!setEq(NEW.tokenize(s), LEGACY.tokenize(s))) same = false
  ok(same, 'tokenize 在 7 个样本上集合与旧版逐一相等')
  ok(NEW.tokenize('配置 node 报错').has('置报'), '新版 tokenize 仍按旧口径产出跨片段 bigram「置报」（查重语义不动）')

  const pairs = [
    ['配置 node 报错', '配置 node 报错 排查'],
    ['定投沪深300，每月一千元', '定投沪深300，每月一千元，长期持有'],
    ['完全不同的两句话', '另一个话题的说明'],
    ['', '非空'],
  ]
  let sameSim = true
  for (const [a, b] of pairs) {
    if (NEW.jaccard(a, b) !== LEGACY.jaccard(a, b)) sameSim = false
    if (NEW.overlapCoeff(a, b) !== LEGACY.overlapCoeff(a, b)) sameSim = false
  }
  ok(sameSim, 'jaccard / overlapCoeff 在 4 组文本上数值与旧版完全相等')
  ok(
    JSON.stringify(NEW.detectDuplicates(mdDup)) === JSON.stringify(LEGACY.detectDuplicates(mdDup)),
    'detectDuplicates 输出（含 sim 值）与旧版逐字段相同',
  )
  const nd = NEW.detectDuplicates(mdDup)
  ok(nd.length === 1 && nd[0].sim >= 0.45, '重复对仍被识别（sim=' + fmt(nd[0] && nd[0].sim) + '，阈值 0.45 语义不变）')
} else {
  ok(false, '旧版参照缺失，逐字不变断言无法执行')
}

// ================= 2. 精准错误码 / 术语 =================
section('精准错误码 / 术语 / 路径')
const qc = (s) => NEW.tokenizeForRetrieval(s)
ok(qc('ENOENT').get('enoent') === 1.6, 'ENOENT → 错误码权重 1.6')
ok(qc('ECONNREFUSED').get('econnrefused') === 1.6, 'ECONNREFUSED → 错误码权重 1.6')
ok(qc('0x80070005').get('0x80070005') === 1.6, '0x80070005 → 错误码权重 1.6')
ok(qc('429').get('429') === 1.6 && qc('5').get('5') === 1, '429 视为错误码，小于 3 位的纯数字不升级')
ok(qc('win32').get('win32') === 1.6, '含数字+字母的标识符 win32 → 1.6')
ok(qc('file').get('file') === 1, '普通英文词 file → 权重 1')
ok(qc('ＥＮＯＥＮＴ ＥＲＲＯＲ').get('enoent') === 1.6 && qc('ＥＮＯＥＮＴ ＥＲＲＯＲ').get('error') === 1.6, '全角ＥＮＯＥＮＴ／ＥＲＲＯＲ 归一化后按错误码命中')
const pTok = qc('D:/softwares/Node.js/node.exe')
ok(pTok.get('softwares/node.js/node.exe') === 1.4, '路径整串 → 权重 1.4')
ok(
  pTok.get('softwares') === 0.8 && pTok.get('node') === 0.8 && pTok.get('exe') === 0.8,
  '路径按分隔符拆出的子词 → 权重 0.8（node.js/node.exe 进一步拆成 node/js/exe）',
)
ok(!pTok.has('d'), '盘符单字符 D 不产生 token（长度 < 2 且无数字）')

const codeHits = (q) => titles(NEW.retrieveRelevant(MD_CODE, q, 5))
ok(sameSet(codeHits('ENOENT'), ['启动报错记录']), '查 ENOENT 只召回《启动报错记录》→ ' + codeHits('ENOENT').join(','))
ok(sameSet(codeHits('ECONNREFUSED'), ['端口问题']), '查 ECONNREFUSED 只召回《端口问题》')
ok(sameSet(codeHits('0x80070005'), ['权限错误码']), '查 0x80070005 只召回《权限错误码》')
ok(sameSet(codeHits('ＥＮＯＥＮＴ'), ['启动报错记录']), '全角查询ＥＮＯＥＮＴ 同样精准召回')
ok(sameSet(codeHits('D:/softwares/Node.js/node.exe'), ['系统 Node 路径']), '路径查询召回《系统 Node 路径》')
ok(sameSet(codeHits('启动报错'), ['启动报错记录']), '中文查询「启动报错」只召回《启动报错记录》')

// ================= 3. 中文噪声 / 停用词 =================
section('中文噪声与停用词')
ok(qc('的了吗呢').size === 0, '全停用字「的了吗呢」不产出任何 token')
ok(qc('the and for you with that').size === 0, '英文停用词串不产出任何 token')
ok(NEW.retrieveRelevant(MD_NOISE, '的了吗呢', 5).length === 0, '噪声查询「的了吗呢」返回 0 条（旧版见下）')
if (LEGACY) {
  const oldNoise = LEGACY.retrieveRelevant(MD_NOISE, '的了吗呢', 5)
  ok(oldNoise.length > 0, '红绿对照：旧版同一查询返回 ' + oldNoise.length + ' 条噪声（新版的 0 条是改进而非漏召回）')
}
ok(qc('上海').has('上海') && !qc('上海').has('上'), '「上海」保留 bigram，停用字「上」的单字 token 被剔除')
ok(qc('会上').has('会上'), '「会上」只要有一个实义字就保留 bigram（不按字禁 bigram）')
ok(qc('内存不足').has('内存') && qc('内存不足').has('不足'), '「内存不足」产出「内存」「存不」「不足」三类 bigram')
ok(qc('配置报错').has('配置') && qc('配置报错').has('报错'), '「配置报错」产出「配置」「置报」「报错」，其中「置报」只在本连续片段内产出')

// ================= 4. 跨片段伪 bigram =================
section('跨标点 / 中英交界的伪 bigram')
for (const s of ['配置 node 报错', '配置、报错', '配置\n报错', '配置.报错', '设置 报告']) {
  ok(!qc(s).has('置报'), '「' + s.replace('\n', '\\n') + '」不产出伪 bigram「置报」')
}
const mixed = qc('node报错')
ok(mixed.has('node') && mixed.has('报错') && !mixed.has('node报') && !mixed.has('e报'), '「node报错」不产出中英混拼 token')
if (LEGACY) {
  ok(LEGACY.tokenize('配置 node 报错').has('置报'), '红绿对照：旧 tokenize 确实产出伪 bigram「置报」（故查重仍需旧口径）')
}

// ================= 5. 空查询 / 退化 =================
section('空查询与纯单字退化')
ok(NEW.rankMemory(MD_NOISE, '').length === 0 && NEW.rankMemory(MD_NOISE, '   ').length === 0, '空串 / 纯空白查询返回空数组')
ok(NEW.retrieveRelevant(MD_NOISE, '').length === 0, 'retrieveRelevant 空查询返回空数组')
ok(NEW.searchMemory(MD_NOISE, { q: '' }).length === 0 && NEW.searchMemory(MD_NOISE, {}).length === 0, 'searchMemory 空 q / 无 q 返回空数组')
ok(NEW.retrieveRelevant(MD_NOISE, 'the and for', 5).length === 0, '查询全是英文停用词 → 空数组')
const single = NEW.rankMemory(MD_NOISE, '报')
ok(single.length === 2, '纯单字查询「报」退化为允许单字命中，返回 ' + single.length + ' 条')
ok(single.every((x) => x.contentMatched === 0 && x.matched === 1), '退化结果 contentMatched 全为 0（单字不算有区分度命中）')

// ================= 6. 日期过滤 =================
section('日期过滤与接口兼容')
const dEntries = NEW.readMemoryEntries(MD_DATES)
ok(
  JSON.stringify(dEntries.map((e) => e.date)) === JSON.stringify(['2026-08-05', '2026-09-20', null]),
  'frontmatter date 解析为 [' + dEntries.map((e) => e.date).join(', ') + ']',
)
const dfHits = (opts) => sortByTitle(NEW.searchMemory(MD_DATES, Object.assign({ q: 'DATQ' }, opts)))
ok(sameSet(dfHits({ dateFrom: '2026-09-01' }), ['九月条目', '无日期条目']), 'dateFrom 过滤：无日期条目不过滤，八月条目被剔除')
ok(sameSet(dfHits({ dateTo: '2026-09-01' }), ['八月条目', '无日期条目']), 'dateTo 过滤：九月条目被剔除')
ok(sameSet(dfHits({ dateFrom: '2026-08-05', dateTo: '2026-08-05' }), ['八月条目', '无日期条目']), '闭区间边界：date 恰等于边界时保留')
ok(sameSet(dfHits({ dateFrom: '2026-10-01' }), ['无日期条目']), '区间外全部剔除后仅剩无日期条目')
ok(NEW.retrieveRelevant(MD_DATES, 'DATQ', 5, (e) => e.date === '2026-09-20').length === 1, 'retrieveRelevant 第 4 参 filter 仍然生效（评分前过滤）')
ok(NEW.retrieveRelevant(MD_DATES, 'DATQ', 1).length === 1, 'k 参数生效（k=1 只返回 1 条）')
ok(NEW.retrieveRelevant(MD_DATES, 'DATQ').length === 3, '默认 k=5 时返回全部 3 条候选')
const messy = NEW.readMemoryEntries(['# M', '', '<!-- tags: t / date: 2026-8-5 -->', '## 非零填充', '正文', ''].join('\n'))
ok(messy[0].date === '2026-08-05', '非零填充日期 2026-8-5 归一化为 2026-08-05（字典序比较才可靠）')

// ================= 7. 打分属性 =================
section('打分属性（rankMemory）')
const rTB = NEW.rankMemory(MD_TITLE_BODY, 'ZZZQ')
ok(rTB.length === 2 && rTB[0].entry.title === '标题含 ZZZQ', '标题命中排在正文命中之前（' + rTB[0].score.toFixed(3) + ' vs ' + rTB[1].score.toFixed(3) + '）')
ok(rTB[0].score > 2 * rTB[1].score, '标题命中分数是正文（词在正文第二行）的 2 倍以上（权重 title=3 生效）')
ok(rTB[0].rel === 1 && Math.abs(rTB[1].rel - rTB[1].score / rTB[0].score) < 1e-9, 'rel = score / top 且 top 恒为 1')
ok(rTB.every((x) => x.matched === 1 && x.contentMatched === 1 && typeof x.score === 'number'), '明细字段齐全：score / rel / matched / contentMatched')

const rRare = NEW.rankMemory(mdIdf, 'RAREQ')
const rCommon = NEW.rankMemory(mdIdf, 'COMMONQ')
ok(rRare.length === 1 && rCommon.length === 5, 'IDF 语料：罕见词命中 1 条、常见词命中 5 条')
ok(rRare[0].score > rCommon[0].score, '罕见词条目分数（' + rRare[0].score.toFixed(3) + '）高于常见词条目（' + rCommon[0].score.toFixed(3) + '）→ IDF 生效')
const rBoth = NEW.rankMemory(mdIdf, 'RAREQ COMMONQ')
ok(rBoth.length >= 1 && rBoth[0].entry.title === '罕见词条目', '同时查两词时罕见的《罕见词条目》仍排第一')

const rBD = NEW.rankMemory(MD_BONUS_DATE, 'ZZZQ')
const ratioD = rBD.find((x) => x.entry.title === '四十天前').score / rBD.find((x) => x.entry.title === '无日期').score
ok(Math.abs(ratioD - 1.1) < 0.005, '40 天前条目 ×1.1 时间加成（实测比值 ' + ratioD.toFixed(4) + '）')
const rBI = NEW.rankMemory(MD_BONUS_IMP, 'ZZZQ')
const ratioI = rBI.find((x) => x.entry.title === '高重要条目').score / rBI.find((x) => x.entry.title === '普通条目').score
ok(Math.abs(ratioI - 1.3) < 0.005, 'importance: high ×1.3 加成（实测比值 ' + ratioI.toFixed(4) + '）')

const noiseHits = NEW.rankMemory(MD_NOISE, '报错')
ok(noiseHits.length === 1 && noiseHits[0].entry.title === '报错排查记录', '无关召回控制：只命中低权重单字「报」的《日报统计脚本》不进候选')
const rTie = NEW.rankMemory(MD_TIE, 'TIEQ')
ok(titles(rTie).join(',') === '并列甲,并列乙', '同分按 MEMORY.md 原顺序稳定排序')

section('relRatio 按比例裁剪')
ok(titles(NEW.rankMemory(MD_REL, 'ZZZQ')).join(',') === '强相关条目 ZZZQ', '默认 relRatio=0.2 裁掉相对分过低的《弱相关条目》')
const rRel0 = NEW.rankMemory(MD_REL, 'ZZZQ', { relRatio: 0 })
ok(titles(rRel0).length === 2, 'relRatio=0 关闭裁剪 → 两条都保留')
const rRelSmall = NEW.rankMemory(MD_REL, 'ZZZQ', { relRatio: 0.05 })
ok(titles(rRelSmall).length === 2, 'relRatio=0.05 时弱相关（rel=' + fmt(rRel0[1].rel) + '）仍保留，说明阈值确实在按比例比较')

// ================= 8. 接口兼容 =================
section('接口兼容与旧函数输出形状')
const rvDirect = NEW.retrieveRelevant(MD_DATES, 'DATQ', 5)
const rkDirect = NEW.rankMemory(MD_DATES, 'DATQ', { k: 5 })
ok(
  rvDirect.length === rkDirect.length && titles(rvDirect).join(',') === titles(rkDirect).join(','),
  'retrieveRelevant 与 rankMemory 输出同序同内容（薄封装；每次调用重新解析条目，故不比对象引用）',
)
const entryKeys = Object.keys(rvDirect[0]).sort().join(',')
const expectKeys = ['title', 'bodyLines', 'preLines', 'tags', 'date', 'expiry', 'importance', 'body', 'headLine'].sort().join(',')
ok(entryKeys === expectKeys, '返回条目对象字段与旧版一致（' + entryKeys + '）')
if (LEGACY) {
  const legacyKeys = Object.keys(LEGACY.retrieveRelevant(MD_DATES, 'DATQ', 5)[0]).sort().join(',')
  ok(entryKeys === legacyKeys, '条目字段集合与旧版运行时输出逐字段相同')
}
ok(typeof NEW.searchMemory(MD_DATES, { q: 'DATQ' })[0] === 'object', 'searchMemory 返回条目对象数组')
ok(NEW.searchMemory(MD_DATES, { q: 'DATQ', k: 2 }).length === 2, 'searchMemory 支持 k')
ok(typeof NEW.rankMemory === 'function' && typeof NEW.tokenizeForRetrieval === 'function', '新增导出 rankMemory / tokenizeForRetrieval 可用')

// ================= 9. 小标注集：旧新版 top5 对比 =================
section('小标注集旧新版 top5 对比（实测指标）')
const LABELED = [
  '# 项目长期记忆',
  '',
  '## run_code 里 Node 子进程 EPERM',
  '<!-- tags: node,测试 / date: 2026-09-29 -->',
  'run_code 里 spawnSync node 直接报 EPERM，改为进程内 import 并临时替换 process.exit。',
  '',
  '## os.tmpdir 在 run_code 里为空',
  '<!-- tags: 环境 / date: 2026-09-29 -->',
  'TEMP/TMP 起始为空导致 mkdtemp 报 ENOENT，import 前手动设置临时目录。',
  '',
  '## ENOENT 与 ECONNREFUSED 的区别',
  '<!-- tags: 错误码 -->',
  'ENOENT 是路径或文件不存在，ECONNREFUSED 是端口没人监听，两者定位方向完全不同。',
  '',
  '## wb2api 版本号识别双轨',
  '<!-- tags: wb2api / date: 2026-09-28 -->',
  'exe 不再内嵌版本号，改读 vcs.revision 与 vcs.time，比较走 Compare-ByTime。',
  '',
  '## 面板写操作报空 body',
  '<!-- tags: 面板 / date: 2026-09-26 -->',
  'Unexpected end of JSON input 的根因是服务端 403 返回空 body，前端 readJson 统一兜底。',
  '',
  '## 中文输出与简洁偏好',
  '<!-- tags: 偏好 -->',
  '用户要求始终用中文输出，不写客套开场与总结，术语保留英文结构名。',
  '',
  '## workspace-write 沙箱初始化失败',
  '<!-- tags: 沙箱 / date: 2026-09-26 -->',
  'Windows 上报 SetNamedSecurityInfoW failed Win32 5，改用 danger-full-access 绕过。',
  '',
  '## 记忆写入护栏只收结构化输出',
  '<!-- tags: 记忆 / date: 2026-09-29 -->',
  'compact 散文化输出被拒收，userMdChecks 校验 H1 与二级标题，smoke 由 117 变 135。',
  '',
  '## pwsh 输出取值用 stdout.text',
  '<!-- tags: pwsh / date: 2026-09-25 -->',
  'run_code 里 pwsh 结果没有顶层 text，取值用 r.stdout.text，write 工具要 file_path。',
  '',
  '## CSS grid 自适应卡片布局',
  '<!-- tags: 前端 -->',
  'grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)) 配合 gap 即可。',
  '',
  '## 健身计划每周三次',
  '<!-- tags: 生活 -->',
  '周一三五跑步，其余力量训练，注意拉伸。',
  '',
].join('\n')

const QUERIES = [
  { q: 'ENOENT', want: 'ENOENT 与 ECONNREFUSED 的区别' },
  { q: 'ECONNREFUSED 端口监听', want: 'ENOENT 与 ECONNREFUSED 的区别' },
  { q: 'EPERM spawnSync', want: 'run_code 里 Node 子进程 EPERM' },
  { q: 'os.tmpdir mkdtemp 临时目录', want: 'os.tmpdir 在 run_code 里为空' },
  { q: 'SetNamedSecurityInfoW Win32 5', want: 'workspace-write 沙箱初始化失败' },
  { q: 'Unexpected end of JSON input 空 body', want: '面板写操作报空 body' },
  { q: 'vcs.revision 版本号', want: 'wb2api 版本号识别双轨' },
  { q: 'userMdChecks 散文化输出', want: '记忆写入护栏只收结构化输出' },
  { q: 'pwsh stdout.text', want: 'pwsh 输出取值用 stdout.text' },
  { q: '中文输出 偏好 不客套', want: '中文输出与简洁偏好' },
  { q: 'grid-template-columns auto-fill minmax', want: 'CSS grid 自适应卡片布局' },
  { q: 'SpEL 表达式注入漏洞排查', want: null },
]

function measure(mod) {
  let sumHits = 0
  let sumRet = 0
  let sumP5 = 0
  let relQueries = 0
  let relHits = 0
  let empty = 0
  const rows = []
  for (const item of QUERIES) {
    const list = mod.retrieveRelevant(LABELED, item.q, 5)
    const ts = titles(list)
    const hit = item.want && ts.includes(item.want) ? 1 : 0
    sumHits += hit
    sumRet += ts.length
    sumP5 += hit / 5
    if (item.want) {
      relQueries++
      relHits += hit
    }
    if (ts.length === 0) empty++
    rows.push({ q: item.q, need: item.want || '(真负例)', got: ts.length, rank: item.want ? ts.indexOf(item.want) + 1 : 0 })
  }
  const n = QUERIES.length
  return {
    P5: sumP5 / n,
    P_ret: sumRet ? sumHits / sumRet : 0,
    R5: relQueries ? relHits / relQueries : 0,
    irrRate: sumRet ? (sumRet - sumHits) / sumRet : 0,
    avgRet: sumRet / n,
    avgIrr: (sumRet - sumHits) / n,
    empty,
    rows,
  }
}

const mNew = measure(NEW)
const mLegacy = LEGACY ? measure(LEGACY) : null
console.log('  指标（12 条查询：11 条有唯一标注答案 + 1 条真负例，k=5）')
console.log('    版本    P@5     P(按返回)  R@5     无关召回率  平均返回  平均无关  空返回')
const line = (name, m) =>
  '    ' +
  name.padEnd(8) +
  m.P5.toFixed(3) +
  '   ' +
  m.P_ret.toFixed(3) +
  '      ' +
  m.R5.toFixed(3) +
  '   ' +
  m.irrRate.toFixed(3) +
  '       ' +
  m.avgRet.toFixed(2) +
  '      ' +
  m.avgIrr.toFixed(2) +
  '      ' +
  m.empty +
  '/12'
if (mLegacy) console.log(line('旧版', mLegacy))
console.log(line('新版', mNew))
console.log('  新版逐查询明细（need=标注答案，got=返回条数，rank=命中的名次，0=未命中；真负例期望 0 条）')
for (const r of mNew.rows) {
  console.log('    ' + (r.rank === 1 ? 'rank1 ' : r.rank ? 'rank' + r.rank + ' ' : r.need === '(真负例)' ? 'neg   ' : 'MISS  ') + '| ' + r.q + ' → ' + r.got + ' 条 | ' + r.need)
}
console.log('  P@5 在本集合上无区分度（每查询仅 1 条相关，k=5 时上限 0.2），判别指标是 P(按返回)、无关召回率与平均无关条数。')

if (mLegacy) {
  ok(mNew.R5 >= mLegacy.R5 - 1e-9, 'R@5 不倒退（新 ' + mNew.R5.toFixed(3) + ' ≥ 旧 ' + mLegacy.R5.toFixed(3) + '）')
  ok(mNew.irrRate <= mLegacy.irrRate + 1e-9, '无关召回率不升（新 ' + mNew.irrRate.toFixed(3) + ' ≤ 旧 ' + mLegacy.irrRate.toFixed(3) + '）')
  ok(mNew.avgIrr <= mLegacy.avgIrr + 1e-9, '平均无关条数不升（新 ' + mNew.avgIrr.toFixed(2) + ' ≤ 旧 ' + mLegacy.avgIrr.toFixed(2) + '）')
  ok(mNew.P_ret >= mLegacy.P_ret - 1e-9, 'P(按返回) 不倒退（新 ' + mNew.P_ret.toFixed(3) + ' ≥ 旧 ' + mLegacy.P_ret.toFixed(3) + '）')
}
const negNew = NEW.retrieveRelevant(LABELED, 'SpEL 表达式注入漏洞排查', 5).length
ok(negNew === 0, '真负例查询返回 0 条（旧版返回 ' + (mLegacy ? mLegacy.rows[mLegacy.rows.length - 1].got : '?') + ' 条）')
ok(mNew.rows.filter((r) => r.rank === 1).length >= 9, '至少 9/11 条标注查询首位命中（实测 ' + mNew.rows.filter((r) => r.rank === 1).length + '/11）')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
