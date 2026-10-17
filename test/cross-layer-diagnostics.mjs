import assert from 'node:assert/strict'
import { inspectMemory, migrateMemory, applyMemoryAction, memoryRevision } from '../lib/memory-lifecycle.js'
import { analyzeCrossLayer } from '../lib/cross-layer-diagnostics.js'

let passed = 0
const test = (name, fn) => { fn(); console.log('PASS ' + name); passed++ }
const kinds = (out) => out.findings.map((f) => f.kind)
const fd = (out, kind) => out.findings.find((f) => f.kind === kind)
const between = (f, la, lb) =>
  (f.a.layer === la && f.b.layer === lb) || (f.a.layer === lb && f.b.layer === la)
const src = (over = {}) => ({ sourceId: 's1', layer: 'today', label: '今日日志', text: '', ...over })

// ---------- 夹具构造 ----------
const baseMd = migrateMemory([
  '## 备份约定',
  '每天凌晨03:20执行全量备份，避开白天交互时段。',
  '',
  '## 发布流程',
  '发布前必须确认回滚脚本可用，并通知值班同事。',
  '',
  '## 独立项目甲',
  '渲染服务超时阈值设为800毫秒，由甲团队维护。',
].join('\n')).text
const p = inspectMemory(baseMd)
const backupId = p.records[0].meta.id
// 更正：03:20 -> 03:30（旧正文成为 superseded，仍留在文件中）
const corrected = applyMemoryAction(baseMd, {
  revision: memoryRevision(baseMd), id: backupId, action: 'correct',
  title: '备份约定', body: '每天凌晨03:30执行全量备份，避开白天交互时段。', reason: '用户更正备份时间',
}, { now: '2026-10-17T08:00:00.000Z' }).text
const cp = inspectMemory(corrected)
const newBackupId = [...cp.byId.values()].find((r) => r.meta.state === 'current' && r.title === '备份约定').meta.id
// 撤回“发布流程”条目（正文保留，状态 retracted）
const retracted = applyMemoryAction(corrected, {
  revision: memoryRevision(corrected), id: cp.records[1].meta.id, action: 'retract', reason: '流程已废弃',
}, { now: '2026-10-17T08:05:00.000Z' }).text

// ---------- 基础形状 ----------
test('输出契约字段稳定且只读（输入不变）', () => {
  const before = structuredClone({ memoryMd: retracted, sources: [src({ text: '每天凌晨03:20执行全量备份。' })] })
  const out = analyzeCrossLayer(before)
  assert.equal(out.ok, true)
  for (const k of ['degraded', 'scanned', 'truncated', 'findings']) assert.ok(k in out, 'missing ' + k)
  assert.deepEqual(before, { memoryMd: retracted, sources: [src({ text: '每天凌晨03:20执行全量备份。' })] })
})

test('无输入 fail-soft 且 degraded 可见', () => {
  const out = analyzeCrossLayer({})
  assert.equal(out.ok, true)
  assert.equal(out.findings.length, 0)
  assert.ok(out.degraded.some((d) => d.stage === 'memoryMd' && d.reason === 'empty'))
  assert.ok(out.degraded.some((d) => d.stage === 'sources' && d.reason === 'empty'))
  assert.equal(out.scanned.sources, 0)
})

test('坏元数据 memoryMd fail-soft 可见，不抛异常', () => {
  const bad = baseMd.replace(/<!-- wb-memory:[A-Za-z0-9_-]+ -->/, '<!-- wb-memory:broken -->')
  const out = analyzeCrossLayer({ memoryMd: bad, sources: [src({ text: '每天凌晨03:20执行全量备份，避开白天交互时段。' })] })
  assert.equal(out.ok, true)
  assert.ok(out.degraded.some((d) => d.stage === 'memory-metadata' && d.reason === 'invalid-metadata'))
})

test('坏来源（非对象/缺text/未知layer）跳过且可见', () => {
  const out = analyzeCrossLayer({
    memoryMd: baseMd,
    sources: [null, { sourceId: 'x' }, 'text', src({ layer: 'weird', text: '每天凌晨03:20执行全量备份，避开白天交互时段。' }), src({ layer: 'today', text: '无关内容而已。' })],
  })
  assert.equal(out.ok, true)
  assert.equal(out.scanned.sources, 2)
  assert.equal(out.truncated.sourcesSkipped, 3)
  assert.ok(out.degraded.some((d) => d.stage === 'source' && d.reason === 'malformed-source'))
  assert.ok(out.degraded.some((d) => d.stage === 'source-layer' && d.reason === 'unknown-layer'))
})

// ---------- 核心场景 ----------
test('已更正旧事实(03:20)出现在 today → inactive-reference', () => {
  const out = analyzeCrossLayer({ memoryMd: corrected, sources: [src({ layer: 'today', text: '助手提到每天凌晨03:20执行全量备份，用户确认避开白天交互时段。' })] })
  const f = fd(out, 'inactive-reference')
  assert.ok(f, 'expect inactive-reference, got ' + JSON.stringify(kinds(out)))
  assert.ok(between(f, 'memory', 'today'))
  assert.equal(f.basis.state, 'superseded')
  assert.ok(f.evidence.a.includes('03:20') || f.evidence.b.includes('03:20'), 'evidence carries old value')
  assert.ok(f.note.includes('人工核实'))
})

test('已撤回正文出现在 pinned → inactive-reference', () => {
  const out = analyzeCrossLayer({ memoryMd: retracted, sources: [src({ layer: 'pinned', text: '发布前必须确认回滚脚本可用，并通知值班同事。' })] })
  const f = fd(out, 'inactive-reference')
  assert.ok(f, 'expect inactive-reference, got ' + JSON.stringify(kinds(out)))
  assert.ok(between(f, 'memory', 'pinned'))
  assert.equal(f.basis.state, 'retracted')
})

test('current 条目与日志重复 → duplicate（同数值）', () => {
  const out = analyzeCrossLayer({ memoryMd: baseMd, sources: [src({ layer: 'today', text: '每天凌晨03:20执行全量备份，避开白天交互时段。' })] })
  const f = fd(out, 'duplicate')
  assert.ok(f, 'expect duplicate, got ' + JSON.stringify(kinds(out)))
  assert.ok(between(f, 'memory', 'today'))
  assert.ok(!f.basis.numeric, 'same numbers must not look like a conflict')
  assert.ok(f.basis.containment >= 0.6)
})

test('相似主题数值不一 → possible-conflict（仅疑似）', () => {
  const out = analyzeCrossLayer({ memoryMd: baseMd, sources: [src({ layer: 'review', text: '回顾：每天凌晨03:40执行全量备份，避开白天交互时段。' })] })
  const f = fd(out, 'possible-conflict')
  assert.ok(f, 'expect possible-conflict, got ' + JSON.stringify(kinds(out)))
  assert.ok(between(f, 'memory', 'review'))
  assert.ok(f.basis.numeric && f.basis.numeric.aOnly.includes('3:20') && f.basis.numeric.bOnly.includes('3:40'))
  assert.ok(f.note.includes('疑似') && f.note.includes('人工核实'))
  assert.ok(!out.findings.some((x) => x.kind === 'duplicate' && between(x, 'memory', 'review')))
})

test('两个不同项目同数字（800毫秒）不报', () => {
  const out = analyzeCrossLayer({
    memoryMd: baseMd,
    sources: [src({ layer: 'profile', text: '网关服务超时阈值设为800毫秒，由平台组维护。' })],
  })
  assert.equal(out.findings.length, 0, JSON.stringify(out.findings))
})

test('短通用词/无区分内容不报', () => {
  const out = analyzeCrossLayer({
    memoryMd: baseMd,
    sources: [
      src({ layer: 'today', text: '用户说好的，就这样吧。' }),
      src({ layer: 'today', text: '今天天气不错。' }),
      src({ layer: 'today', text: '12345' }),
      src({ layer: 'today', text: '03:20' }),
    ],
  })
  assert.equal(out.findings.length, 0, JSON.stringify(out.findings))
})

test('source×source 跨层重复也可检出', () => {
  const out = analyzeCrossLayer({
    memoryMd: baseMd,
    sources: [
      src({ sourceId: 'log1', layer: 'today', label: '日志', text: '每天凌晨03:20执行全量备份，避开白天交互时段。' }),
      src({ sourceId: 'pin1', layer: 'pinned', label: '置顶', text: '每天凌晨03:20执行全量备份，避开白天交互时段。' }),
    ],
  })
  const f = out.findings.find((x) => x.kind === 'duplicate' && between(x, 'today', 'pinned'))
  assert.ok(f, JSON.stringify(out.findings))
})

test('inactive-reference 不查 summary 层', () => {
  const out = analyzeCrossLayer({ memoryMd: retracted, sources: [src({ layer: 'summary', text: '发布前必须确认回滚脚本可用，并通知值班同事。' })] })
  assert.ok(!out.findings.some((f) => f.kind === 'inactive-reference' && between(f, 'memory', 'summary')))
})

test('更正后的新事实(03:30)出现在日志 → 不误报 inactive-reference', () => {
  const out = analyzeCrossLayer({ memoryMd: corrected, sources: [src({ layer: 'today', text: '助手提到每天凌晨03:30执行全量备份，避开白天交互时段。' })] })
  assert.ok(!out.findings.some((f) => f.kind === 'inactive-reference' && f.basis.state === 'superseded'), JSON.stringify(out.findings))
  // 它应该作为 current 条目与日志的 duplicate 出现（数值一致）
  assert.ok(out.findings.some((f) => f.kind === 'duplicate' && between(f, 'memory', 'today')))
})

// ---------- 边界与截断 ----------
test('截断可见：超长来源、来源超量、配对与 findings 有上限', () => {
  const long = '每天凌晨03:20执行全量备份，避开白天交互时段。' + '填充内容。'.repeat(3000)
  const many = Array.from({ length: 30 }, (_, i) => src({ sourceId: 's' + i, text: long }))
  const out = analyzeCrossLayer({ memoryMd: baseMd, sources: many })
  assert.equal(out.scanned.sources, 24)
  assert.equal(out.truncated.sourcesDropped, 6)
  assert.ok(out.truncated.sourcesClipped > 0)
  assert.ok(out.truncated.sourcesClipped <= 24)
  assert.ok(out.degraded.some((d) => d.stage === 'source' && d.reason === 'chars-capped') || out.truncated.sourcesClipped > 0)
  assert.ok(out.findings.length <= 50)
})

test('memoryMd 超长截断可见', () => {
  const big = baseMd + '\n' + '闲文。'.repeat(120000)
  const out = analyzeCrossLayer({ memoryMd: big, sources: [src({ text: '每天凌晨03:20执行全量备份，避开白天交互时段。' })] }, { maxMemoryMdChars: 5000 })
  assert.equal(out.truncated.memoryMdClipped, true)
  assert.ok(out.degraded.some((d) => d.stage === 'memoryMd' && d.reason === 'chars-capped'))
})

test('记忆条目超量截断可见', () => {
  const entries = Array.from({ length: 40 }, (_, i) => '## 条目' + i + '\n每天凌晨03:20执行全量备份，避免干扰' + i + '。')
  const md = migrateMemory(entries.join('\n')).text
  const out = analyzeCrossLayer({ memoryMd: md, sources: [src({ text: '每天凌晨03:20执行全量备份。' })] })
  assert.equal(out.scanned.memoryEntries, 32)
  assert.equal(out.truncated.memoryEntriesClipped, 8)
})

test('opts 可收紧阈值且不改变输入', () => {
  const input = { memoryMd: baseMd, sources: [src({ text: '每天凌晨03:20执行全量备份，避开白天交互时段。' })] }
  const before = structuredClone(input)
  const strict = analyzeCrossLayer(input, { dupContainment: 0.99, topicContainment: 0.99, dupMinMatched: 99, topicMinMatched: 99 })
  const loose = analyzeCrossLayer(input)
  assert.equal(strict.findings.length, 0)
  assert.ok(loose.findings.length >= 1)
  assert.deepEqual(input, before)
})

// ---------- 来源标识与证据卫生 ----------
test('label/sourceId 不含绝对路径', () => {
  const out = analyzeCrossLayer({
    memoryMd: baseMd,
    sources: [src({
      sourceId: 'D:/datas/Deepseek Harness/程序开发/ws/.workbuddy/memory/2026-10-17.md',
      label: 'D:/workspaces/程序开发/logs/today.md',
      text: '每天凌晨03:20执行全量备份，避开白天交互时段。',
    })],
  })
  const f = fd(out, 'duplicate')
  assert.ok(f)
  assert.ok(!/D:/.test(f.a.label) && !/D:/.test(f.b.label), JSON.stringify(f))
  assert.ok(!f.b.sourceId.includes('D:/datas') && !f.b.sourceId.includes('Deepseek Harness'), f.b.sourceId)
  assert.ok(/2026-10-17\.md#/.test(f.b.sourceId), f.b.sourceId)
})

test('证据有界且折叠空白', () => {
  const out = analyzeCrossLayer({ memoryMd: baseMd, sources: [src({ text: '每天凌晨03:20执行全量备份，\r\n避开白天交互时段。' })] })
  for (const f of out.findings) {
    assert.ok(f.evidence.a.length <= 60, f.evidence.a.length)
    assert.ok(f.evidence.b.length <= 60, f.evidence.b.length)
    assert.ok(!/[\r\n\t]/.test(f.evidence.a + f.evidence.b))
  }
})

test('CRLF 输入正常工作且不改字节', () => {
  const crlfMd = baseMd.replaceAll('\n', '\r\n')
  const sources = [src({ text: '每天凌晨03:20执行全量备份，避开白天交互时段。' })]
  const before = { memoryMd: crlfMd, sources: structuredClone(sources) }
  const out = analyzeCrossLayer(before)
  assert.ok(out.findings.some((f) => f.kind === 'duplicate'))
  assert.equal(before.memoryMd, crlfMd)
  assert.deepEqual(before.sources, sources)
})

test('确定性：同输入两次运行结果逐值一致', () => {
  const input = () => ({ memoryMd: retracted, sources: [src({ text: '每天凌晨03:20执行全量备份，避开白天交互时段。' }), src({ layer: 'pinned', sourceId: 'p2', label: '置顶', text: '每天凌晨03:40执行全量备份，避开白天交互时段。' })] })
  assert.deepEqual(analyzeCrossLayer(input()), analyzeCrossLayer(input()))
})

test('findings 排序稳定：duplicate < possible-conflict < inactive-reference', () => {
  const out = analyzeCrossLayer({
    memoryMd: retracted,
    sources: [
      src({ sourceId: 'dup', layer: 'today', text: '每天凌晨03:20执行全量备份，避开白天交互时段。' }),
      src({ sourceId: 'conf', layer: 'review', text: '每天凌晨03:40执行全量备份，避开白天交互时段。' }),
      src({ sourceId: 'old', layer: 'pinned', text: '发布前必须确认回滚脚本可用，并通知值班同事。' }),
    ],
  })
  const order = kinds(out)
  const rank = (k) => ['duplicate', 'possible-conflict', 'inactive-reference'].indexOf(k)
  const ranks = order.map(rank)
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), order.join(','))
})

test('无命中不保证无冲突的措辞：note 不使用断言性语言', () => {
  const out = analyzeCrossLayer({ memoryMd: baseMd, sources: [src({ text: '完全无关的一段话。' })] })
  assert.equal(out.findings.length, 0)
  for (const f of analyzeCrossLayer({ memoryMd: baseMd, sources: [src({ text: '每天凌晨03:40执行全量备份，避开白天交互时段。' })] }).findings) {
    assert.ok(!/矛盾|错误|冲突！/.test(f.note) || f.note.includes('疑似'), f.note)
  }
})

console.log('cross-layer-diagnostics: ' + passed + ' passed / 0 failed')
