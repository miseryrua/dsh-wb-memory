import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { compactMemoryIfOver } from '../lib/index.js'
import { splitSinkEntries, planColdSink } from '../lib/compact-sink.js'
import { extractReceipts } from '../lib/compact-fidelity.js'
import { gcDailyLogs } from '../lib/governance.js'

const fixture = '# 项目长期记忆\n\n' + Array.from({ length: 12 }, (_, i) => '<!-- tags: t / date: 2020-01-' + String(i+1).padStart(2,'0') + ' / importance: low -->\n## 条目'+i+'\n' + (i === 0 ? '~~~js\n## 非标题\n~~~\n' : '') + '内容'.repeat(270) + '。'.repeat(8) + '\n\n').join('') + '<!-- wb-distill-batch:2020-01-01:' + 'a'.repeat(64) + ' -->\n'
const [snapshot, heat] = process.argv.slice(2)
const raw = snapshot ? readFileSync(snapshot,'utf8') : fixture
const threshold = snapshot ? 20000 : 4500
const dir = mkdtempSync(join(process.cwd(), '.cold-sink-test-'))
const read = name => readFileSync(join(dir,name),'utf8')
const put = (name,text) => writeFileSync(join(dir,name),text)
try {
  put('MEMORY.md', raw)
  if (heat) put('heat.json', readFileSync(heat))
  const markers = {}, cfg = {memoryCharThreshold:threshold,compactMaxTokens:16000}, dc = {provider:'mock',model:'mock',timeoutMs:1000}
  let calls = 0
  const llm = { stream: async function* (o) {
    calls++
    const wrapped = o.messages[0].content[0].text
    const text = JSON.parse(wrapped.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text.split('\n\n--- 上次输出')[0].replace(/^--- MEMORY.md 全文 ---\n/, '')
    // 删除少量空白与中文标点，不改变关键事实锚点。
    let quota = Math.ceil(text.length * .01)
    yield {type:'text-delta',text:text.replace(/[。！？]/g,m=>quota-- > 0 ? '' : m)}
    yield {type:'finish',reason:'stop'}
  } }
  const result = await compactMemoryIfOver(llm,cfg,dc,'fixture',dir,markers)
  assert.ok(result?.ok && result.sink?.count > 0, JSON.stringify(result))
  assert.equal(result.checks.anchorsPreserved,true)
  const hot = read('MEMORY.md'), cold = read('MEMORY-archive.md')
  assert.ok(hot.length <= Math.floor(threshold*.8))
  const entries = s => splitSinkEntries(s).entries
  const before = raw.replace(/^<!-- wb-distill-batch:[^\n]*\n/gm,'')
  const moved = cold.split(/^<!-- wb-sunk: [^\n]* length=\d+ -->\n/gm).slice(1).map(text=>({text,title:entries(text)[0].title}))
  assert.deepEqual([...entries(hot).map(e=>e.text),...moved.map(e=>e.text)].sort(), entries(before).map(e=>e.text).sort())
  for (const e of entries(before).filter(e=>e.protected)) assert.ok(entries(hot).some(h=>h.text===e.text))
  assert.deepEqual(extractReceipts(read('distill-receipts.txt')).sort(),[...new Set(extractReceipts(raw))].sort())
  assert.equal(await compactMemoryIfOver(llm,cfg,dc,'fixture',dir,markers),null)
  assert.ok(calls > 0)
  gcDailyLogs(dir,0)
  assert.equal(read('MEMORY-archive.md'),cold)
  assert.ok(planColdSink(before,1).remaining >= 5)
  console.log(JSON.stringify({before:raw.length,receipts:extractReceipts(raw).length,...result.sink,original:raw.length,calls,titles:moved.map(e=>e.title)}))
} finally {
  assert.equal(realpathSync(dir),dir)
  for (const name of ['MEMORY.md','MEMORY-archive.md','distill-receipts.txt','heat.json']) rmSync(join(dir,name),{force:true})
  // 仅本用例创建的隔离目录。
  rmSync(dir,{recursive:true,force:true})
}
