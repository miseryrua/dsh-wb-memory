import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { recoverColdRestore, compactMemoryIfOver, migrateDistillReceipts } from '../lib/index.js'
import { memoryRevision as hash } from '../lib/memory-lifecycle.js'
import { sinkKey } from '../lib/compact-sink.js'
const dir = mkdtempSync(join(process.cwd(), '.cold-recovery-'))
const put = (n,s) => writeFileSync(join(dir,n),s)
const get = n => readFileSync(join(dir,n),'utf8')
const hot = '# 项目长期记忆\n' + Array.from({length:8},(_,i)=>'## '+i+'\n'+'a'.repeat(400)+'\n').join('')
const head = '# 冷存记忆\n', entry = '## 恢复目标\n内容\n', cold = head + '<!-- wb-sunk: 2026-11-20 -->\n' + entry
try {
  for (const stage of ['hot','cold']) {
    put('MEMORY.md', hot); put('MEMORY-archive.md', cold)
    put('memory-sink-retained.json', JSON.stringify([sinkKey(entry)]))
    put('memory-restore-pending.json', JSON.stringify({hot:hash(hot),hotNext:hash(hot+entry),archive:hash(cold),archiveNext:hash(head),id:0}))
    assert.throws(()=>recoverColdRestore(dir, s=>{if(s===stage)throw Error('interrupt')}), /interrupt/)
    recoverColdRestore(dir); recoverColdRestore(dir)
    assert.equal(get('MEMORY.md'),hot+entry); assert.equal(get('MEMORY-archive.md'),head)
    assert.deepEqual(JSON.parse(get('memory-sink-retained.json')),[sinkKey(entry)])
    console.log('PASS 移回中断恢复：'+stage)
  }
  for (const [nextHot,nextCold] of [[hot+'外部热存\n',cold],[hot,cold+'外部冷存\n']]) {
    put('MEMORY.md',nextHot); put('MEMORY-archive.md',nextCold)
    put('memory-sink-pending.json',JSON.stringify({hot:hash(hot),archive:hash(cold),priorArchive:hash(head),indexes:[0]}))
    const pause={count:2,baselineChars:nextHot.length}
    const r = await compactMemoryIfOver(null,{memoryCharThreshold:1000},{},'x',dir,{x:{__compact__:{day:'2000-01-01',autoPause:pause}}})
    assert.ok(r.conflict); assert.equal(get('MEMORY.md'),nextHot); assert.equal(get('MEMORY-archive.md'),nextCold)
    assert.equal(get('memory-sink-pending.json'),'{}')
  }
  console.log('PASS 下沉中断遇外部热存或冷存修改不覆盖')
  const receipt = '<!-- wb-distill-batch:2026-11-20:' + 'a'.repeat(64) + ' -->\n'
  const other = receipt.replace('a'.repeat(64), 'b'.repeat(64))
  put('MEMORY.md', hot + receipt); put('distill-receipts.txt', other)
  assert.throws(() => migrateDistillReceipts(dir, () => { throw Error('interrupt') }), /interrupt/)
  assert.equal(get('MEMORY.md'), hot + receipt)
  assert.equal(get('distill-receipts.txt'), other + receipt)
  migrateDistillReceipts(dir); migrateDistillReceipts(dir)
  assert.equal(get('MEMORY.md'),hot); assert.equal(get('distill-receipts.txt'),other + receipt)
  console.log('PASS 独立回执落盘后中断仍保留回执并集')
} finally { rmSync(dir,{recursive:true,force:true}) }
