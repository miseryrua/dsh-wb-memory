import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { coldWorkspace, compactMemoryIfOver, migrateDistillReceipts, distillWorkspaceDateLocked } from '../lib/index.js'
import { splitSinkEntries } from '../lib/compact-sink.js'
const root=mkdtempSync(join(process.cwd(),'.cold-recovery-'))
const file=join(root,'MEMORY.md'), archive=join(root,'MEMORY-archive.md')
const head='# 项目长期记忆\n', ch='# 冷存记忆\n'
const original=head+Array.from({length:10},(_,i)=>'## 条目'+i+'\n'+(i===0?'~~~\n<!-- wb-sunk: 2026-01-01 -->\n~~~\n':'')+'正文。'.repeat(120)+'\n').join('')
const extra='## 外部追加\n外部内容\n'
const text=()=>readFileSync(file,'utf8')
const compact=(checkpoint=()=>{})=>compactMemoryIfOver(null,{memoryCharThreshold:1200},{},'w',root,{w:{__compact__:{day:'2000-01-01',autoPause:{count:2,baselineChars:text().length}}}},{checkpoint})
const reset=()=>{writeFileSync(file,original);writeFileSync(archive,ch);writeFileSync(join(root,'memory-transfer.json'),'{}');writeFileSync(join(root,'memory-sink-retained.json'),'[]')}
function invariant(expected){
  const raw=readFileSync(archive,'utf8'); const list=[];let n=ch.length
  while(n<raw.length){const m=/^<!-- wb-sunk: [^\n]* length=(\d+) -->\n/.exec(raw.slice(n));assert.ok(m);n+=m[0].length;list.push(raw.slice(n,n+Number(m[1])));n+=Number(m[1])}
  assert.deepEqual([...splitSinkEntries(text()).entries.map(e=>e.text),...list].sort(),splitSinkEntries(expected).entries.map(e=>e.text).sort())
}
try {
  for(const phase of ['journal','cold','hot','cleared']){
    reset(); await compact(p=>{if(p===phase)throw Error('interrupt')});
    writeFileSync(file,text()+extra);const list=coldWorkspace(root);assert.ok(list.entries.length);
    const req={revision:list.revision,id:list.entries[0].id};coldWorkspace(root,req);assert.ok(coldWorkspace(root,req).alreadyRestored);
    await compact();invariant(original+extra);console.log('PASS 下沉中断、热存外部追加、直接移回：'+phase)
  }
  for(const phase of ['journal','hot','cold','retained','cleared']){
    reset();await compact();const list=coldWorkspace(root);const req={revision:list.revision,id:list.entries[0].id};
    assert.throws(()=>coldWorkspace(root,req,p=>{if(p===phase)throw Error('interrupt')}),/interrupt/);
    writeFileSync(file,text()+extra);assert.ok(coldWorkspace(root,req).alreadyRestored);await compact();invariant(original+extra);
    assert.ok(JSON.parse(readFileSync(join(root,'memory-sink-retained.json'),'utf8')).includes(req.id));console.log('PASS 移回中断及保留名单：'+phase)
  }
  reset();
  const coldExtra = '## 外部冷存\n外部内容\n';
  const coldExtraBlock = '<!-- wb-sunk: 2026-01-01 length='+coldExtra.length+' -->\n'+coldExtra;
  let wrote=false;
  await compact(p=>{if(p==='before-cold'&&!wrote){wrote=true;writeFileSync(archive,ch+coldExtraBlock)}});
  assert.ok(wrote);assert.equal(readFileSync(archive,'utf8'),ch+coldExtraBlock);
  const latest=coldWorkspace(root);coldWorkspace(root,{id:latest.entries[0].id,revision:latest.revision});await compact();invariant(original+coldExtra);
  console.log('PASS 冷存提交前外部追加未被覆盖');
  reset();const r='<!-- wb-distill-batch:2026-11-20:'+'a'.repeat(64)+'\n-->\n';writeFileSync(file,original+r);
  assert.throws(()=>migrateDistillReceipts(root,()=>{throw Error('interrupt')}),/interrupt/);migrateDistillReceipts(root);
  assert.equal(text(),original);assert.match(readFileSync(join(root,'distill-receipts.txt'),'utf8'),/wb-distill-batch/);
  console.log('PASS 跨行回执中断后无丢失')
  reset();
  const { planLogChunk } = await import('../lib/distill-cursor.js')
  const log='- 09:00【自动】实际日志\n', source=join(root,'2020-01-02.md');writeFileSync(source,log)
  const chunk=planLogChunk(log,null,{maxChars:10000});assert.ok(chunk)
  let calls=0
  globalThis.__wbMemoryLlm={stream:async function*(){calls++;yield {type:'text-delta',text:'<!-- tags: example / date: 2020-01-02 / importance: medium -->\n## 可靠提炼记录\n不同的事实锚点。'};yield {type:'finish',reason:'stop'}}}
  const doDistill=checkpoint=>distillWorkspaceDateLocked(null,{provider:'fake',model:'fake',timeoutMs:1000,dupThreshold:1},'w',root,{file:source,date:'2020-01-02',chunk},checkpoint)
  await assert.rejects(doDistill(p=>{if(p==='body')throw Error('interrupt')}),/interrupt/)
  assert.equal(await doDistill(),0);assert.equal(calls,1);assert.equal(text().split('## 可靠提炼记录').length,2)
  console.log('PASS 新正文提交后中断不重复调用模型或入库')
} finally { rmSync(root,{recursive:true,force:true}) }
