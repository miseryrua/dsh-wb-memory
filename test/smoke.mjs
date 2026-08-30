/**
 * dsh-wb-memory 纯函数冒烟测试（不依赖 cordis 环境）。
 * 运行：node test/smoke.mjs（需 Node 22+）
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readMemoryEntries,
  tokenize,
  retrieveRelevant,
  summarizeEntries,
  jaccard,
  detectDuplicates,
} from '../lib/retrieve.js'
import { gcDailyLogs, checkMemorySize, safeTrash, gcTrash, gcArchive, runGc } from '../lib/governance.js'

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

console.log('--- retrieve.readMemoryEntries ---')
const MD = [
  '# 项目长期记忆',
  '',
  '<!-- tags: a,b / date: 2026-08-01 / importance: high -->',
  '## 标题甲',
  '正文甲第一行',
  '正文甲第二行',
  '',
  '## 标题乙',
  '<!-- tags: c / date: 2026-08-20 / importance: low -->',
  '正文乙',
  '',
].join('\n')
const es = readMemoryEntries(MD)
ok(es.length === 2, 'H1 标题不计条目，共 2 条（实际 ' + es.length + '）')
ok(es[0].title === '标题甲', '条目标题解析')
ok(es[0].tags.join(',') === 'a,b', 'frontmatter tags 解析（条目头）')
ok(es[0].date === '2026-08-01', 'frontmatter date 解析')
ok(es[0].importance === 'high', 'frontmatter importance 解析')
ok(es[0].headLine === '正文甲第一行', 'headLine 跳过 frontmatter 注释行')
ok(es[1].tags[0] === 'c' && es[1].importance === 'low', '条目体中部 frontmatter 也能解析')
const es2 = readMemoryEntries('游离前言行\n\n## 标题\n正文')
ok(
  es2.length === 2 && es2[0].title === '（前言）' && es2[0].headLine === '游离前言行',
  '前言条目保留且不含 H1 噪音',
)
// auto-distill 产出格式：注释行在标题前（且夹在上一条正文之后）
const DISTILL_MD = [
  '# 项目长期记忆',
  '',
  '<!-- tags: d1 / date: 2026-08-20 / importance: high -->',
  '## 条目一',
  '条目一正文',
  '',
  '<!-- tags: d2 / date: 2026-08-21 / importance: low -->',
  '## 条目二',
  '条目二正文',
  '',
].join('\n')
const es3 = readMemoryEntries(DISTILL_MD)
ok(es3.length === 2, 'distill 格式（注释在标题前）解析出 2 条（实际 ' + es3.length + '）')
ok(es3[0].tags[0] === 'd1' && es3[0].date === '2026-08-20' && es3[0].importance === 'high', 'distill 条目一 frontmatter 归属正确')
ok(es3[1].tags[0] === 'd2' && es3[1].importance === 'low', '夹在条目间的注释归下一条目（不误归上一条）')

console.log('--- retrieve.tokenize / retrieveRelevant / summarizeEntries ---')
const t = tokenize('dsh 记忆插件 memory')
ok(t.has('dsh') && t.has('memory') && t.has('记') && t.has('记忆'), 'tokenize：英文词 + CJK 单字 + 2-gram')
const rel = retrieveRelevant(MD, '标题甲 正文甲', 5)
ok(rel.length >= 1 && rel[0].title === '标题甲', 'retrieveRelevant 命中相关条目')
ok(retrieveRelevant(MD, 'zzzqqq 不存在词', 5).length === 0, '无关 query 返回空')
const sum = summarizeEntries(MD, 1500)
ok(sum.includes('标题甲') && sum.includes('标题乙'), 'summarizeEntries 含各条目标题')
ok(!sum.includes('# 项目长期记忆'), 'summarizeEntries 不再输出 H1 噪音行')

console.log('--- retrieve 相似度 ---')
ok(jaccard('完全相同文本', '完全相同文本') === 1, 'jaccard 自身相似度=1')
const dupMd = '## A\n电池健康度 88 建议充电上限 80\n\n## B\n电池健康度 88.2 建议充电上限 80\n'
const pairs = detectDuplicates(dupMd, 0.45)
ok(pairs.length === 1, 'detectDuplicates 抓到近重复对')
const noPairs = detectDuplicates('## A\n显示器 EDID 问题排查\n\n## B\nNode 版本要求 22 以上\n', 0.45)
ok(noPairs.length === 0, '无关条目不误报')

console.log('--- governance（临时目录）---')
const dir = mkdtempSync(join(tmpdir(), 'wbmem-'))
try {
  writeFileSync(join(dir, '2026-01-01.md'), '# old', 'utf8')
  writeFileSync(join(dir, '2999-01-01.md'), '# future', 'utf8')
  const r1 = gcDailyLogs(dir, 30)
  ok(r1.moved.length === 1 && r1.moved[0] === '2026-01-01.md', 'gcDailyLogs 只归档过期日志')
  ok(existsSync(join(dir, 'archive', '2026-01-01.md')), '归档文件落位 archive/')
  ok(existsSync(join(dir, '2999-01-01.md')), '未来日期日志不动')

  writeFileSync(join(dir, 'MEMORY.md'), 'x'.repeat(9000), 'utf8')
  const r2 = checkMemorySize(dir, 8000)
  ok(r2.over === true && r2.size === 9000, 'checkMemorySize 超阈值检测')
  ok(existsSync(r2.bakPath), '容量备份已写入 archive/')

  writeFileSync(join(dir, 'todel.md'), 'del me', 'utf8')
  const r3 = safeTrash(dir, 'todel.md')
  ok(r3.ok === true && !existsSync(join(dir, 'todel.md')), 'safeTrash 移入 .trash（rename 非 unlink）')
  ok(safeTrash(dir, 'not-exist.md').ok === false, 'safeTrash 不存在的文件报错不抛异常')

  const oldTs = String(Date.now() - 40 * 86400000)
  mkdirSync(join(dir, '.trash', oldTs), { recursive: true })
  writeFileSync(join(dir, '.trash', oldTs, 'x.md'), 'x', 'utf8')
  const r4 = gcTrash(dir, 30)
  ok(r4.cleaned === 1 && !existsSync(join(dir, '.trash', oldTs)), 'gcTrash 清理超期回收站条目')

  writeFileSync(join(dir, 'archive', '2000-01-01.md'), 'old', 'utf8')
  const r5 = gcArchive(dir, 365)
  ok(r5.cleaned === 1 && !existsSync(join(dir, 'archive', '2000-01-01.md')), 'gcArchive 清理超期归档')

  const r6 = runGc(dir, {})
  ok(
    r6.logGc && r6.memCheck && Array.isArray(r6.dupCheck.pairs) && r6.trashGc && r6.archiveGc,
    'runGc 汇总返回各分项',
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('--- index.js 模块可加载（不执行 apply）---')
const idx = await import('../lib/index.js')
ok(typeof idx.apply === 'function' && idx.name === 'wb-memory', 'index.js 可独立 import 且导出 apply')

console.log('--- index.readJsonBomSafe（v7.5 E1 修复）---')
const tmp2 = mkdtempSync(join(tmpdir(), 'wbmem2-'))
try {
  const bomJson = join(tmp2, 'bom.json')
  writeFileSync(bomJson, '\uFEFF{"enabled":true,"x":1}', 'utf8')
  const parsedBom = idx.readJsonBomSafe(bomJson)
  ok(parsedBom !== null && parsedBom.x === 1, '带 BOM 的合法 JSON 正常解析（不再静默重置配置）')
  writeFileSync(bomJson, '{ broken', 'utf8')
  ok(idx.readJsonBomSafe(bomJson) === null, '坏 JSON 返回 null（不抛异常，走备份+默认配置分支）')
} finally {
  rmSync(tmp2, { recursive: true, force: true })
}

console.log('--- index.compactTargetChars（v7.5 自适应 target）---')
ok(idx.compactTargetChars(12000, null) === 9600, '无历史时兜底 0.8×阈值')
ok(idx.compactTargetChars(12000, { target: 9600, after: 12745 }) === 8586, '恒超 32.8%（实测值）时自适应下调到 8586')
ok(idx.compactTargetChars(12000, { target: 9600, after: 9380 }) === 9600, '输出未超目标时受 0.8×上限钳制')
ok(idx.compactTargetChars(12000, { target: 9600, after: 40000 }) === 3600, '极端超幅（4.2×）受 0.3×下限钳制')
ok(idx.compactTargetChars(12000, { target: 0, after: 500 }) === 9600, '无效历史（target=0）走兜底')
ok(idx.compactTargetChars(12000, {}) === 9600, '空历史对象走兜底')

console.log('--- index.digestClipEnds（v7.5 头尾截取）---')
const longReply = 'A' + 'x'.repeat(200) + 'Z'
const clipped = idx.digestClipEnds(longReply, 100)
ok(clipped.length === 100, '总长严格受限（100）')
ok(clipped.startsWith('A') && clipped.endsWith('Z'), '头部与尾部结论都保留')
ok(clipped.includes('…'), '中段以省略号衔接')
ok(idx.digestClipEnds('短回复', 100) === '短回复', '短文本原样返回不截断')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
