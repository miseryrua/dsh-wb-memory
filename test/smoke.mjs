/**
 * dsh-wb-memory 纯函数冒烟测试（不依赖 cordis 环境）。
 * 运行：node test/smoke.mjs（需 Node 22+）
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

import {
  readMemoryEntries,
  tokenize,
  retrieveRelevant,
  summarizeEntries,
  jaccard,
  detectDuplicates,
  searchMemory,
} from '../lib/retrieve.js'
import { gcDailyLogs, checkMemorySize, safeTrash, gcTrash, gcArchive, runGc } from '../lib/governance.js'
import { summaryGate, summaryConfig, summaryInputText, countSummariesToday } from '../lib/summary.js'

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

console.log('--- index.logicalDayStamp（v8 F1 逻辑日分界）---')
ok(idx.logicalDayStamp({ dayBoundaryHour: 4 }, new Date(2026, 7, 31, 3, 59)) === '2026-08-30', '03:59 归前一天')
ok(idx.logicalDayStamp({ dayBoundaryHour: 4 }, new Date(2026, 7, 31, 4, 0)) === '2026-08-31', '04:00 归当天')
ok(idx.logicalDayStamp({ dayBoundaryHour: 0 }, new Date(2026, 7, 31, 0, 30)) === '2026-08-31', 'dayBoundaryHour=0 退化为日历日')
ok(idx.logicalDayStamp({ dayBoundaryHour: 4 }, new Date(2026, 2, 1, 2, 0)) === '2026-02-28', '跨月边界：3月1日凌晨归2月28')
ok(idx.logicalDayStamp({}, new Date(2026, 11, 31, 23, 0)) === '2026-12-31', '白天时刻原样返回')

console.log('--- index.buildWeekSection（v8 N1 近 N 日回顾）---')
const wdir = mkdtempSync(join(tmpdir(), 'wbmem-w-'))
try {
  // 8 个历史日期文件（08-24 ~ 08-31）+ 今天文件（09-01）
  for (let d = 24; d <= 31; d++) {
    writeFileSync(join(wdir, `2026-08-${String(d).padStart(2, '0')}.md`), `# 2026-08-${d} 日志\n\n- 21:00【自动】任务${d} → 结论${d}\n`, 'utf8')
  }
  writeFileSync(join(wdir, '2026-09-01.md'), '# 2026-09-01 日志\n\n- 09:00【自动】今日流水 → 不该进回顾\n', 'utf8')
  const wcfg = { weekWindowDays: 6, weekMaxChars: 1200, weekSummaryDailyChars: 400 }
  const week = idx.buildWeekSection(wdir, wcfg, '2026-09-01')
  ok(week && week.includes('### 近 6 日回顾'), '标题为「近 6 日回顾」（不叫本周）')
  ok(week.includes('**08-26**') && week.includes('**08-31**'), '窗口取最近 6 天（08-26 ~ 08-31）')
  ok(!week.includes('**08-25**'), '窗口外的第 7 个历史日（08-25）不进回顾')
  ok(!week.includes('09-01') && !week.includes('今日流水'), '今天的文件不进回顾')
  ok(week.length <= 1200, '总输出 ≤ weekMaxChars')
  // 小结正文优先于流水行装配（用户裁决的优先级）
  writeFileSync(
    join(wdir, '2026-08-31.md'),
    '# 2026-08-31 日志\n\n## 会话小结 23:30\n修好了逻辑日分界，因为凌晨会话归错天，未竟事项是观察一周成本。\n\n- 21:00【自动】任务 → 结论\n',
    'utf8',
  )
  const week2 = idx.buildWeekSection(wdir, wcfg, '2026-09-01')
  const sumPos = week2.indexOf('· 小结：')
  const flowPos = week2.indexOf('21:00【自动】')
  ok(sumPos >= 0 && flowPos >= 0 && sumPos < flowPos, '会话小结正文优先于流水行装配')
  ok(idx.buildWeekSection(join(wdir, 'nonexist'), wcfg, '2026-09-01') === null, '目录无日志返回 null')
} finally {
  rmSync(wdir, { recursive: true, force: true })
}

console.log('--- index.buildPinnedSection（v8 N3 置顶记忆）---')
const pdir = mkdtempSync(join(tmpdir(), 'wbmem-p-'))
try {
  ok(idx.buildPinnedSection(pdir, { pinnedMaxChars: 1000 }) === null, 'PINNED.md 不存在返回 null（不影响其余注入）')
  writeFileSync(join(pdir, 'PINNED.md'), '- [2026-08-31] 充电上限 80%\n- [2026-08-20] 每月校准电池\n', 'utf8')
  const pin = idx.buildPinnedSection(pdir, { pinnedMaxChars: 1000 })
  ok(pin.includes('### 置顶记忆') && pin.includes('充电上限 80%'), '置顶段标题与内容注入')
  const pin2 = idx.buildPinnedSection(pdir, { pinnedMaxChars: 30 })
  ok(pin2.includes('截断'), '超 pinnedMaxChars 保头截断并标注')
} finally {
  rmSync(pdir, { recursive: true, force: true })
}

console.log('--- retrieve.searchMemory（v8 N2 日期过滤）---')
// 专用夹具：两条目文本互不重叠，避免 query token 串门干扰断言
const SEARCH_MD = [
  '# 项目长期记忆',
  '',
  '<!-- tags: alpha / date: 2026-08-01 -->',
  '## 电池策略',
  '充电上限设置为百分之八十',
  '',
  '<!-- tags: beta / date: 2026-08-20 -->',
  '## 显示器排查',
  '外接显示器换线解决 NV-Failsafe',
  '',
].join('\n')
const r1 = searchMemory(SEARCH_MD, { q: '显示器', dateFrom: '2026-08-10', dateTo: '2026-08-25' })
ok(r1.length === 1 && r1[0].title === '显示器排查', '日期范围内命中（2026-08-20）')
ok(searchMemory(SEARCH_MD, { q: '充电上限', dateFrom: '2026-08-10', dateTo: '2026-08-25' }).length === 0, '日期范围外被滤除（电池策略 2026-08-01）')
ok(searchMemory(SEARCH_MD, { q: '显示器', dateFrom: '2026-08-20', dateTo: '2026-08-20' }).length === 1, '闭区间含端点（date_from=date_to=条目日期）')
ok(searchMemory(SEARCH_MD, { q: '' }).length === 0, '空 query 返回空')
const NODATE_MD = '## 无日期条目\n没写 frontmatter 的旧记忆正文\n'
ok(searchMemory(NODATE_MD, { q: '旧记忆', dateFrom: '2999-01-01', dateTo: '2999-12-31' }).length === 1, '无 frontmatter date 的条目不被日期过滤')

console.log('--- index.compactRetryPlan / compactFeedbackText（v8 F2 同轮反馈重试）---')
const PASS_CHECKS = { nonEmpty: true, shorter: true, underThreshold: true, keptHalfEntries: true }
ok(idx.compactRetryPlan(PASS_CHECKS, null).retry === false && idx.compactRetryPlan(PASS_CHECKS, null).reason === 'passed', '首轮全过不重试')
ok(idx.compactRetryPlan({ nonEmpty: true, shorter: true, underThreshold: false, keptHalfEntries: true }, null).retry === true, '校验失败触发重试')
ok(idx.compactRetryPlan(PASS_CHECKS, new Error('llm timeout')).retry === false && idx.compactRetryPlan(PASS_CHECKS, new Error('llm timeout')).reason === 'llm-error', 'LLM 异常不重试（成本闸，明天再试）')
const fb = idx.compactFeedbackText(
  { nonEmpty: true, shorter: true, underThreshold: false, keptHalfEntries: false },
  { after: 9200, threshold: 8000, newCount: 5, minCount: 6, oldCount: 12, before: 10000 },
)
ok(fb.includes('超出阈值 8000 达 1200 字符') && fb.includes('条目数 5 条少于要求的 6 条'), '反馈文本含具体差距数字')

console.log('--- summary.summaryGate / summaryInputText / countSummariesToday（v8 N4 四道闸）---')
const sc0 = summaryConfig({})
ok(sc0.on === true && sc0.minUserChars === 300 && sc0.maxPerDay === 8 && sc0.idleMs === 600000, '默认配置：开/300字/8次日/10分钟')
ok(summaryGate(sc0, { modelReady: true, alreadyDone: false, userChars: 400, countToday: 0 }).pass === true, '全闸通过')
ok(summaryGate(sc0, { modelReady: true, alreadyDone: false, userChars: 100, countToday: 0 }).reason === 'too-short', '短会话跳过（<300 字不烧 LLM）')
ok(summaryGate(sc0, { modelReady: true, alreadyDone: false, userChars: 400, countToday: 8 }).reason === 'daily-cap', '当日上限（8 次）跳过')
ok(summaryGate(sc0, { modelReady: true, alreadyDone: true, userChars: 400, countToday: 0 }).reason === 'already-summarized', '同会话二次小结跳过')
ok(summaryGate(sc0, { modelReady: false, alreadyDone: false, userChars: 400, countToday: 0 }).reason === 'no-model', 'LLM 未就绪跳过')
ok(summaryGate(summaryConfig({ sessionSummary: false }), { modelReady: true, alreadyDone: false, userChars: 400, countToday: 0 }).reason === 'disabled', 'sessionSummary=false 关闭')
const sdir = mkdtempSync(join(tmpdir(), 'wbmem-s-'))
try {
  writeFileSync(
    join(sdir, '2026-09-01.md'),
    '# 日志\n\n## 会话小结 10:00\n第一段小结。\n\n## 会话小结 11:00\n第二段小结。\n\n- 12:00【自动】x → y\n',
    'utf8',
  )
  ok(countSummariesToday(join(sdir, '2026-09-01.md')) === 2, '当日小结计数以日志文件为准（重启安全）')
  ok(countSummariesToday(join(sdir, '2099-01-01.md')) === 0, '日志文件不存在计 0')
  const input = summaryInputText({ userTexts: ['帮我修插件', '再检查一遍逻辑日'], lastAssistants: ['第一次回复内容。'.repeat(80), '最终结论：已修复'] }, sc0)
  ok(input.startsWith('--- 用户消息 ---') && input.includes('帮我修插件') && input.includes('最终结论：已修复'), '小结输入含用户消息与助手结论')
  ok(input.length < 4000, '小结输入受预算约束')
} finally {
  rmSync(sdir, { recursive: true, force: true })
}

console.log('--- index.memory_search 工具（v8 N2 结构 + 临时工作区 e2e）---')
// 结构校验：register() 只做结构校验（dsh-tools/lib/index.js:2762-2770），普通对象
// 字面量即可注册——output 必填 { schema, render }、parameters 普通对象 spec、
// execute 异步。此处静态校验结构，不依赖 cordis 环境。
const toolDef = idx.memorySearchToolDefinition()
ok(
  toolDef.name === 'memory_search' &&
    toolDef.parameters.type === 'object' &&
    Array.isArray(toolDef.parameters.required) &&
    toolDef.parameters.required.includes('q') &&
    toolDef.parameters.properties?.q?.type === 'string',
  '工具名与参数 JSON Schema（对象根，q 必填）正确'
)
ok(toolDef.output && typeof toolDef.output.render === 'function' && toolDef.output.schema, 'output 必填结构齐备（schema + render）')
const RAW_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
ok(RAW_TYPES.includes(toolDef.output.schema.type), 'output.schema.type 属于 raw JSON Schema 七类型（2026-09-01 踩坑：type:json 是 defineTool DSL，裸注册抛错）')
ok(typeof toolDef.execute === 'function', 'execute 为函数')
const rendered = toolDef.output.render({}, { text: 'e2e 预览' })
ok(Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text === 'e2e 预览', 'render 把 canonical JSON 投影为模型文本')
// e2e：以查询串重新 import 模块实例（ESM 按 URL 缓存，必重新求值），把
// DSH_WORKSPACE_ROOT 指向临时目录——不碰真实工作区数据。
const eroot = mkdtempSync(join(tmpdir(), 'wbmem-e-'))
try {
  const ews = 'E2E测试区'
  const emem = join(eroot, ews, '.workbuddy', 'memory')
  mkdirSync(emem, { recursive: true })
  writeFileSync(join(emem, 'MEMORY.md'), '<!-- tags: 显示器 / date: 2026-08-20 / importance: high -->\n## 显示器排查\n外接显示器换线解决 NV-Failsafe\n', 'utf8')
  writeFileSync(join(emem, '2026-08-31.md'), '# 日志\n\n- 21:00【自动】修显示器 → 换线解决 NV-Failsafe\n', 'utf8')
  process.env.DSH_WORKSPACE_ROOT = eroot
  const idx2 = await import('../lib/index.js?v8e2e=' + Date.now())
  const r = await idx2.searchWorkspaceMemory({ q: '显示器', workspace: ews })
  ok(r.ok === true && r.workspace === ews, '工具 e2e：解析到显式 workspace 参数')
  ok(r.text.includes('[长期]') && r.text.includes('显示器排查'), '工具 e2e：长期记忆面命中并带来源标记')
  ok(r.text.includes('[日志 2026-08-31]'), '工具 e2e：日志面命中并带来源标记')
  const r2 = await idx2.searchWorkspaceMemory({ q: '显示器', workspace: ews, date_from: '2026-09-01', date_to: '2026-09-30' })
  ok(r2.ok === true && !r2.text.includes('显示器排查'), '工具 e2e：date_from/date_to 滤除范围外长期条目')
  const r3 = await idx2.searchWorkspaceMemory({ q: '', workspace: ews })
  ok(r3.ok === false, '工具 e2e：空 q 报参数错误')
  // 审查 S4：非法日期参数（非零填充）显式提示被忽略，不静默全量检索
  const r4 = await idx2.searchWorkspaceMemory({ q: '显示器', workspace: ews, date_from: '2026-8-1' })
  ok(r4.ok === true && r4.ignored.includes('date_from'), '工具 e2e：非法 date_from 进入 ignored 数组')
  ok(r4.text.includes('未识别的日期参数已忽略'), '工具 e2e：text 含忽略提示行')
  delete process.env.DSH_WORKSPACE_ROOT
} finally {
  delete process.env.DSH_WORKSPACE_ROOT
  rmSync(eroot, { recursive: true, force: true })
}

console.log('--- 审查修复回补（2026-09-01：S6 date 归一化 / S1 标题区间）---')
// S6：手写非零填充 date 归一化为 YYYY-MM-DD；非法值置 null（条目随即可被日期过滤跳过）
const PAD_MD = [
  '<!-- tags: x / date: 2026-8-5 -->',
  '## 手写条目',
  '正文',
  '',
  '<!-- tags: y / date: 不是日期 -->',
  '## 非法日期条目',
  '正文',
  '',
].join('\n')
const padEs = readMemoryEntries(PAD_MD)
ok(padEs[0].date === '2026-08-05', 'S6：非零填充 date 归一化（2026-8-5 → 2026-08-05）')
ok(padEs[1].date === null, 'S6：非法 date 置 null（不过滤，安全方向）')
// S1：标题区间按实际装入日期计（预算只够 1 天时标题就写 1 日，不再虚标窗口）
const s1dir = mkdtempSync(join(tmpdir(), 'wbmem-s1-'))
try {
  for (const d of ['2026-08-29', '2026-08-30', '2026-08-31']) {
    writeFileSync(join(s1dir, d + '.md'), `# ${d} 日志\n\n- 21:00【自动】${d}任务 → 结论结论结论结论结论结论\n`, 'utf8')
  }
  const w1 = idx.buildWeekSection(s1dir, { weekWindowDays: 6, weekMaxChars: 1200, weekSummaryDailyChars: 400 }, '2026-09-01')
  ok(w1.includes('近 3 日回顾'), 'S1 前置：预算充足时 3 天全装入')
  const w2 = idx.buildWeekSection(s1dir, { weekWindowDays: 6, weekMaxChars: 140, weekSummaryDailyChars: 400 }, '2026-09-01')
  ok(/^### 近 1 日回顾（2026-08-31 ~ 2026-08-31）/m.test(w2) && w2.length <= 140, 'S1：预算只够 1 天时标题写实际装入的 1 日且总长 ≤ 预算')
} finally {
  rmSync(s1dir, { recursive: true, force: true })
}

console.log('\n--- index.guardedWrite（v9.0 W1 写入护栏）---')
const gdir = mkdtempSync(join(tmpdir(), 'wbmem-g-'))
try {
  const g1 = join(gdir, 'MEMORY.md')
  writeFileSync(g1, '# 项目长期记忆\n\n## 甲\n正文甲\n', 'utf8')
  const base1 = readFileSync(g1, 'utf8')
  const r1 = idx.guardedWrite(g1, base1 + '\n## 乙\n正文乙\n', base1)
  ok(r1.ok === true && readFileSync(g1, 'utf8').includes('## 乙'), 'G1：读后无人改动 → 正常落盘')

  // 核心场景：读 →（异步 LLM 窗口）→ 写 之间，文件被别的写者改过
  const base2 = readFileSync(g1, 'utf8')
  writeFileSync(g1, base2 + '\n## 丙\n并发写者的条目\n', 'utf8')
  const r2 = idx.guardedWrite(g1, '被 LLM 整理过的全新内容\n', base2)
  const disk2 = readFileSync(g1, 'utf8')
  ok(r2.ok === false && r2.conflict === true, 'G2a：窗口内被改动 → 拒绝写入')
  ok(disk2.includes('## 丙') && !disk2.includes('被 LLM 整理'), 'G2b：并发方刚写入的条目未被静默覆盖')
  ok(r2.actualLen === disk2.length && r2.expectedLen === base2.length, 'G2c：冲突结果带两侧字符数（供日志定位）')
  ok(disk2 === base2 + '\n## 丙\n并发写者的条目\n', 'G2d：拒绝时文件逐字节未动')

  const g3 = join(gdir, 'NEW.md')
  const r3 = idx.guardedWrite(g3, '# 新建\n', '')
  ok(r3.ok === true && existsSync(g3), 'G3：文件不存在且期望为空 → 允许创建')

  const g4 = join(gdir, 'NEW2.md')
  const r4 = idx.guardedWrite(g4, 'x', '我以为文件里有内容')
  ok(r4.ok === false && !existsSync(g4), 'G4：期望有内容但文件不存在 → 拒绝且不落盘')

  const g5 = join(gdir, 'NEW3.md')
  const r5 = idx.guardedWrite(g5, 'y', null)
  ok(r5.ok === true && existsSync(g5), 'G5：expected=null 与文件不存在同义（与 safeReadRaw 口径一致）')

  // 内容是唯一判据：同长度不同内容必须拒绝（若用 size/mtime 捷径，此例会漏过）
  const g6 = join(gdir, 'SAME.md')
  writeFileSync(g6, 'AAAA', 'utf8')
  const r6 = idx.guardedWrite(g6, 'BBBB', 'AAAB')
  ok(r6.ok === false && readFileSync(g6, 'utf8') === 'AAAA', 'G6：同长度不同内容仍拒绝（按内容比对，不用 size/mtime）')
} finally {
  rmSync(gdir, { recursive: true, force: true })
}

console.log('\n--- index.compactMemoryIfOver 冲突护栏 e2e（v9.0 W1）---')
const ccfg = { memoryCharThreshold: 240, dayBoundaryHour: 4, compactMaxTokens: 800, compactRetryFeedback: false }
const cdc = { provider: 'p', model: 'm', maxTokens: 100, timeoutMs: 5000 }
const MEM_SRC = [
  '# 项目长期记忆', '',
  '## 甲条目', '甲'.repeat(60), '',
  '## 乙条目', '乙'.repeat(60), '',
  '## 丙条目', '丙'.repeat(60), '',
  '## 丁条目', '丁'.repeat(60), '',
].join('\n')
const MEM_NEW = ['# 项目长期记忆', '', '## 甲条目', '压缩甲', '', '## 乙条目', '压缩乙', ''].join('\n')

// 情形 1：LLM 窗口内另一个写者追加了条目 → 必须拒绝写入
const d1 = mkdtempSync(join(tmpdir(), 'wbmem-c1-'))
try {
  const mp1 = join(d1, 'MEMORY.md')
  writeFileSync(mp1, MEM_SRC, 'utf8')
  const mk1 = {}
  const llm1 = {
    stream: async function* () {
      writeFileSync(mp1, MEM_SRC + '\n## 并发写入\n会话在窗口内追加的条目\n', 'utf8')
      yield { type: 'text-delta', text: MEM_NEW }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const r1 = await idx.compactMemoryIfOver(llm1, ccfg, cdc, 'ws1', d1, mk1)
  const disk1 = readFileSync(mp1, 'utf8')
  ok(r1 && r1.conflict === true && r1.ok === false, 'C1a：compact 撞上并发写入 → 报 conflict 而非静默覆盖')
  ok(disk1 === MEM_SRC + '\n## 并发写入\n会话在窗口内追加的条目\n', 'C1b：并发方刚写的条目逐字节留存，LLM 结果未落盘')
  ok(!mk1.ws1 || !mk1.ws1.__compact__, 'C1c：冲突不写 __compact__ 日锁 → 下一轮 sweep 可重试')

  // 情形 2：窗口内无人改动 → 正常落盘（防护栏过度拦截）
  const d2 = mkdtempSync(join(tmpdir(), 'wbmem-c2-'))
  try {
    const mp2 = join(d2, 'MEMORY.md')
    writeFileSync(mp2, MEM_SRC, 'utf8')
    const mk2 = {}
    const llm2 = {
      stream: async function* () {
        yield { type: 'text-delta', text: MEM_NEW }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const r2 = await idx.compactMemoryIfOver(llm2, ccfg, cdc, 'ws2', d2, mk2)
    ok(r2 && r2.ok === true, 'C2a：窗口内无人改动 → 正常整理落盘')
    const disk2b = readFileSync(mp2, 'utf8')
    ok(disk2b.trimEnd() === MEM_NEW.trimEnd() && disk2b.includes('压缩甲'), 'C2b：磁盘内容=LLM 输出（stripFence + 补尾换行）')
    ok(mk2.ws2 && mk2.ws2.__compact__ && !!mk2.ws2.__compact__.day, 'C2c：成功仍写日锁（既有防震荡行为未被破坏）')
  } finally {
    rmSync(d2, { recursive: true, force: true })
  }
} finally {
  rmSync(d1, { recursive: true, force: true })
}

console.log('\n--- index.compactMemoryIfOver 第二轮结构硬卡 e2e（2026-09-29 加固）---')
const ccfg2 = { memoryCharThreshold: 240, dayBoundaryHour: 4, compactMaxTokens: 800 }
// 情形 3：第二轮输出散文化（0 个「## 」条目）→ 必须拒收、保留原文件
const d3 = mkdtempSync(join(tmpdir(), 'wbmem-c3-'))
try {
  const mp3 = join(d3, 'MEMORY.md')
  writeFileSync(mp3, MEM_SRC, 'utf8')
  const mk3 = {}
  let call3 = 0
  const llm3 = {
    stream: async function* () {
      call3++
      if (call3 === 1) yield { type: 'text-delta', text: MEM_SRC }
      else yield { type: 'text-delta', text: '这份记忆可以并入环境备忘，要我直接写入的话确认一下路径。' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const r3 = await idx.compactMemoryIfOver(llm3, ccfg2, cdc, 'ws3', d3, mk3)
  ok(call3 === 2, 'C3a：首轮不合规触发同轮重试（实际调用 ' + call3 + ' 次）')
  ok(r3 && r3.ok === false, 'C3b：第二轮散文化（0 条目）→ 拒收')
  ok(readFileSync(mp3, 'utf8') === MEM_SRC, 'C3c：原文件逐字节保留（旧实现会整份覆盖）')
  ok(r3 && r3.checks && r3.checks.keptHalfEntries === false, 'C3d：失败原因记为 keptHalfEntries=false')
  ok(mk3.ws3 && mk3.ws3.__compact__ && !!mk3.ws3.__compact__.day, 'C3e：拒收仍写日锁（防震荡行为不变）')
} finally {
  rmSync(d3, { recursive: true, force: true })
}

// 情形 4：第二轮条目数达标但超阈值 → 仍带警告接受（自愈路径不许被堵死）
const d4 = mkdtempSync(join(tmpdir(), 'wbmem-c4-'))
try {
  const mp4 = join(d4, 'MEMORY.md')
  writeFileSync(mp4, MEM_SRC, 'utf8')
  const mk4 = {}
  let call4 = 0
  const MEM_NEW4 = ['# 项目长期记忆', '', '## 甲条目', '甲'.repeat(120), '', '## 乙条目', '乙'.repeat(120), ''].join('\n')
  ok(MEM_NEW4.length < MEM_SRC.length && MEM_NEW4.length > ccfg2.memoryCharThreshold, 'C4pre：测试构造满足「更短但超阈值」（' + MEM_NEW4.length + ' vs 原文 ' + MEM_SRC.length + '，阈值 ' + ccfg2.memoryCharThreshold + '）')
  const llm4 = {
    stream: async function* () {
      call4++
      if (call4 === 1) yield { type: 'text-delta', text: MEM_SRC }
      else yield { type: 'text-delta', text: MEM_NEW4 }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const r4 = await idx.compactMemoryIfOver(llm4, ccfg2, cdc, 'ws4', d4, mk4)
  ok(r4 && r4.ok === true && r4.rounds === 2, 'C4a：第二轮条目数达标 + 超阈值 → 带警告接受（underThreshold 仍是建议）')
  ok(!!(r4 && r4.warnings && r4.warnings.includes('仍超阈值')), 'C4b：warnings 记录「仍超阈值」（实际 ' + (r4 && r4.warnings) + '）')
  ok(readFileSync(mp4, 'utf8').trimEnd() === MEM_NEW4.trimEnd(), 'C4c：该路径仍正常落盘')
} finally {
  rmSync(d4, { recursive: true, force: true })
}

console.log('\n--- index.userMdChecks（USER.md 写入前校验，2026-09-29 加结构硬卡）---')
const curMd = '# 用户长期记忆\n\n## 偏好\n- 甲\n\n## 环境备忘（2026-08-28 实测更新）\n- 乙\n'
const nextMd = curMd + '- 丙\n'
const goodC = idx.userMdChecks(nextMd, curMd)
ok(Object.values(goodC).every(Boolean), 'U1：正常画像合并（有标题有小节、未缩水）→ 全项通过')
const orphan = '这条信息值得并入环境备忘——和已有的「WorkBuddy shim 失效」同属 Windows 沙箱/权限类坑。\n\n要我直接写入文件的话，确认一下路径（默认 ~/.dsh/USER.md？）。\n'
const orphanC = idx.userMdChecks(orphan, curMd)
ok(orphanC.nonEmpty === true && orphanC.withinCap === true && orphanC.noMassDeletion === true, 'U2a：2026-09-25 事故原文仍满足旧三条校验（长度类拦不住它）')
ok(orphanC.hasHeading === false && orphanC.hasSection === false, 'U2b：结构校验拦下散文化回答')
ok(!Object.values(orphanC).every(Boolean), 'U2c：综合判定为不过 → 不写、保留旧画像')
ok(idx.userMdChecks('## 小节\n内容', '').hasHeading === false, 'U3：首行是 ## 不算 H1 标题')
ok(idx.userMdChecks('## 小节\n内容', '').hasSection === true, 'U4：## 小节被识别为结构')
ok(idx.userMdChecks('#用户长期记忆\n## 偏好\n- 甲', '').hasHeading === true, 'U5：# 后无空格也算标题行')
ok(idx.userMdChecks('', curMd).nonEmpty === false, 'U6：空输出 → 不过')
ok(idx.userMdChecks('#\n## 偏好\n- 甲', '').hasHeading === false, 'U7：只有 # 号无标题文字 → 不过')

console.log('--- index.sameOrigin（写操作同源门；2026-09-29 修空体 403）---')
ok(idx.sameOrigin({ headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' } }) === true, '同主机同端口 → 放行')
ok(idx.sameOrigin({ headers: { origin: 'http://localhost:19387', host: '127.0.0.1:19387' } }) === true, 'localhost 与 127.0.0.1 视为同一主机（原实现在此误拒）')
ok(idx.sameOrigin({ headers: { host: '127.0.0.1:19387' } }) === true, '无 Origin（curl/脚本客户端）→ 放行')
ok(idx.sameOrigin({ headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' } }) === false, '真跨站写 → 拒绝')
ok(idx.sameOrigin({ headers: { origin: 'null', host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }) === false, '不透明来源 + 跨站 → 拒绝')
ok(idx.sameOrigin({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:19387' } }) === false, '端口不同 → 拒绝')
ok(idx.normHostValue('example.com:80') === 'example.com' && idx.normHostValue('example.com:443') === 'example.com', '默认端口 80/443 归一为省略端口')
ok(idx.sameOrigin({ headers: { origin: 'http://example.com:80', host: 'example.com' } }) === true, 'Origin 带默认端口 :80 与省略端口的 Host 等价')

console.log('--- lib/client.js 语法可解析（面板 bundle）---')
try {
  new vm.Script(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { filename: 'lib/client.js' })
  ok(true, 'client.js 可被 JS 引擎解析（防面板 bundle 语法错误）')
} catch (e) {
  ok(false, 'client.js 语法错误：' + e.message)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
