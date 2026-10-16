// 全程只使用副本临时目录，不触碰真实记忆，不调用模型。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planLogChunk, completeLogChunk, mergeAppendedEntries, fingerprint, atomicJson } from '../lib/distill-cursor.js'
import { fitMemoryBlock, injectionLimit, allocateEntryBudgets } from '../lib/injection-budget.js'
import { createHeatTracker, readHeat } from '../lib/heat.js'
import { configuredWorkspaceRoot, guardedWrite, buildMemoryBlock, logicalDayStamp } from '../lib/index.js'
let passed = 0
function A(value, label) { assert.ok(value, label); passed++ }
const tmp = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp')
mkdirSync(tmp, { recursive: true })
const dir = mkdtempSync(join(tmp, 'core-v010-'))
const raw = '# 日志\n' + ('- 完整流水😀一二三四五六七八九\n'.repeat(60))
let marker, chunks = [], consumed = ''
for (let i = 0; i < 100; i++) {
  const c = planLogChunk(raw, marker, { maxChars: 80 }); if (!c) break
  A(c.text.length <= 80 && c.end > c.start, '分块不超预算且持续前进')
  A(!/[\uD800-\uDBFF]$/.test(c.text), '不切开代理对')
  chunks.push(c); consumed += c.text; marker = completeLogChunk(c, 0, marker)
}
A(consumed === raw && marker.offset === raw.length && marker.done, '长日志全部消费')
A(planLogChunk(raw, marker) === null, '完成无新增不再处理')
A(planLogChunk(raw + '追加\n', marker).start === raw.length, '新增尾部续跑')
A(planLogChunk('修改' + raw.slice(2), marker).start === 0, '前缀被改安全重扫')
A(planLogChunk(raw, { at: 'old', added: 0 }).start === 0, '旧标记迁移重扫')
A(planLogChunk('尚未完成'.repeat(100), null, { today: true, maxChars: 20, minChars: 1 }) === null, '超长未闭合行不能提前消费')
A(planLogChunk('完成行\n尾部未完成', null, { today: true, minChars: 1 }).text === '完成行\n', '今日只消费稳定前缀')
A(planLogChunk('短行\n', null, { today: true, minChars: 300 }) === null, '今日最小阈值')
A(planLogChunk('x'.repeat(200), null, { maxChars: 30 }).end === 30, '历史超长行不会卡死')
const old = '# 记忆\n\n## 原条目\n原正文\n'
A(mergeAppendedEntries(old + '\n## 新条目\n新正文\n', old, '# 记忆\n')?.includes('新正文'), '合并完整新条目')
A(mergeAppendedEntries(old + '\n<!-- tags: 新 -->\n## 新条目\n新正文\n', old, '# 记忆\n')?.includes('tags:'), '完整元数据保留')
for (const tail of ['\n## 半条目', '\n## 完整\n正文\n## 空标题\n', '\n<!-- 半元数据\n## 新\n正文', '\n散文']) A(mergeAppendedEntries(old + tail, old, '结果') === null, '拒绝半条目或散文')
A(mergeAppendedEntries(old.replace('原正文', '被修改'), old, '结果') === null, '非纯追加不合并')
const p = join(dir, 'MEMORY.md'); writeFileSync(p, old)
writeFileSync(p, old + '\n## 新条目\n新正文\n')
A(guardedWrite(p, '结果', old).conflict, '默认写入不允许合并')
const res = guardedWrite(p, '# 记忆\n', old, { allowAppendMerge: true })
A(res.ok && readFileSync(p, 'utf8').includes('新正文'), '显式合并正常提交')
const text = '# WorkBuddy\n说明\n## 全局用户记忆\n' + '画像'.repeat(3000) + '\n## 当前工作区\n### 长期记忆 / 相关条目\n' + '长期'.repeat(8000) + '\n### 今日日志\n' + '日志'.repeat(3000) + '\n### 近 2 日回顾\n' + '回顾'.repeat(2000) + '\n## 可用工作区\n' + '工作区'.repeat(1000) + '\n## 记忆纪律\n必须保留末尾纪律。\n'
for (const limit of [4000, 8000, 12000, 16000]) {
  const output = fitMemoryBlock(text, { injectionMaxChars: limit })
  A(output.length <= limit && output.includes('必须保留末尾纪律'), '包装纪律计入总预算')
}
A(injectionLimit({ injectionMaxChars: 1 }) === 4000, '总预算下限明确')
A(fitMemoryBlock('原样', {}) === '原样', '小块不改')
A(configuredWorkspaceRoot({ workspaceRoot: dir }, {}) === dir, '显式配置根目录')
A(configuredWorkspaceRoot({ workspaceRoot: 'config' }, { DSH_WORKSPACE_ROOT: dir }) === dir, '宿主根目录优先')
const heat = createHeatTracker({ delayMs: 600000, now: () => '2026-10-14T10:00:00Z' })
heat.queue(dir, 'session:1', ['新条目', '新条目']); heat.queue(dir, 'session:1', ['新条目'])
A(!existsSync(join(dir, 'heat.json')), '入队不做磁盘写入')
heat.flush()
A(readHeat(dir).entries[fingerprint('新条目')].count === 1, '同session轮次曝光去重')
heat.queue(dir, 'session:2', ['新条目']); heat.dispose()
A(readHeat(dir).entries[fingerprint('新条目')].count === 2, '新轮次累计并卸载刷盘')
atomicJson(join(dir, 'heat.json'), null)
A(Object.keys(readHeat(dir).entries).length === 0, '损坏热度状态安全回退')
const scores = [{score:10,entry:{body:'x'.repeat(4000)}},{score:1,entry:{body:'x'.repeat(4000)}}]
const allocations = allocateEntryBudgets(scores, 3000)
A(allocations[0] > allocations[1] && allocations.reduce((a,b)=>a+b,0) <= 3000, '分高条目分得更多余量且总配额受限')
A(allocateEntryBudgets([{score:1,entry:{body:'x'.repeat(20)}},scores[0]], 1800)[1] === 1780, '短正文未用配额重新分配')
const previousRoot = process.env.DSH_WORKSPACE_ROOT
try {
  process.env.DSH_WORKSPACE_ROOT = dir
  const ws = join(dir, '隔离预算'), memDir = join(ws, '.workbuddy', 'memory')
  mkdirSync(memDir, {recursive:true})
  writeFileSync(join(memDir,'MEMORY.md'), '<!-- tags: 预算 / importance: high -->\n## 超长召回预算\n' + '预算召回正文。'.repeat(4000))
  writeFileSync(join(memDir,'PINNED.md'), '- 用户明确置顶事项\n')
  writeFileSync(join(memDir,logicalDayStamp({})+'.md'), '当天流水内容\n'.repeat(2000))
  const snapshot = () => readdirSync(memDir).sort().map(f => f + ':' + fingerprint(readFileSync(join(memDir,f),'utf8'))).join('|')
  const before = snapshot()
  const context = {messages:[{role:'user',content:'超长召回预算'}]}
  const full = buildMemoryBlock(ws, context, {injectionMaxChars:12000,logMaxChars:8000})
  A(full.length <= 12000 && full.includes('## 记忆纪律') && full.includes('用户明确置顶事项'), '真实注入包含包装纪律置顶且不超总预算')
  A(full.includes('长期记忆 / 相关条目') && !full.includes('长期记忆 / 摘要'), '摘要与召回互斥')
  for(const cap of [4000,8000,12000]) A(buildMemoryBlock(ws,context,{injectionMaxChars:cap,logMaxChars:8000}).length<=cap,'真实注入不同总预算受限')
  A(before===snapshot() && !existsSync(join(memDir,'heat.json')) && !existsSync(join(memDir,'summary-pending.json')), '同步buildMemoryBlock无文件副作用')
} finally { if(previousRoot===undefined)delete process.env.DSH_WORKSPACE_ROOT;else process.env.DSH_WORKSPACE_ROOT=previousRoot }
console.log('core-v010: ' + passed + ' passed')
