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
  while(n<raw.length){const m=/^<!-- wb-sunk: [^\n]* length=(\d+)(?: id=[a-f0-9-]+)?(?: sha=[a-f0-9]{16})? -->\n/.exec(raw.slice(n));assert.ok(m);n+=m[0].length;list.push(raw.slice(n,n+Number(m[1])));n+=Number(m[1])}
  assert.deepEqual([...splitSinkEntries(text()).entries.map(e=>e.text),...list].sort(),splitSinkEntries(expected).entries.map(e=>e.text).sort())
}
try {
  for(const phase of ['journal','cold','hot','cleared']){
    reset(); await compact(p=>{if(p===phase)throw Error('interrupt')});
    writeFileSync(file,text()+extra);const list=coldWorkspace(root);assert.ok(list.entries.length);
    const req={revision:list.revision,id:list.entries[0].id};coldWorkspace(root,req);assert.ok(coldWorkspace(root,req).alreadyRestored);
    await compact();invariant(original+extra);console.log('PASS 下沉中断、热存外部追加、直接移回：'+phase)
  }
  for(const phase of ['journal','hot','cold','retained','completed','cleared']){
    reset();await compact();const list=coldWorkspace(root);const req={revision:list.revision,id:list.entries[0].id};
    assert.throws(()=>coldWorkspace(root,req,p=>{if(p===phase)throw Error('interrupt')}),/interrupt/);
    writeFileSync(file,text()+extra);assert.ok(coldWorkspace(root,req).alreadyRestored);await compact();invariant(original+extra);
    assert.ok(JSON.parse(readFileSync(join(root,'memory-sink-retained.json'),'utf8')).includes((await import('../lib/compact-sink.js')).sinkKey(splitSinkEntries(text()).entries.find(e=>e.title===list.entries[0].title).text)));console.log('PASS 移回中断及保留名单：'+phase)
  }
  reset();
  const coldExtra = '## 外部冷存\n外部内容\n';
  const coldExtraBlock = '<!-- wb-sunk: 2026-01-01 length='+coldExtra.length+' -->\n'+coldExtra;
  let wrote=false;
  await compact(p=>{if(p==='before-cold'&&!wrote){wrote=true;writeFileSync(archive,ch+coldExtraBlock)}});
  assert.ok(wrote);assert.equal(readFileSync(archive,'utf8'),ch+coldExtraBlock);
  const latest=coldWorkspace(root);coldWorkspace(root,{id:latest.entries[0].id,revision:latest.revision});await compact();invariant(original+coldExtra);
  console.log('PASS 冷存提交前外部追加未被覆盖');
  reset();
  const first=splitSinkEntries(original).entries[0].text;
  const block=(s,day='2026-01-01')=>'<!-- wb-sunk: '+day+' length='+s.length+' -->\n'+s;
  writeFileSync(archive,ch+block(first));await compact();invariant(original+first);
  assert.equal(coldWorkspace(root).entries.filter(e=>e.title==='条目0').length,2);
  console.log('PASS 原有热冷重复保留两份');
  reset();writeFileSync(file,original+first);await compact();invariant(original+first);
  console.log('PASS 原有热热重复保留两份');
  reset();const a='## A\n内容\n', b=a+'\n';
  writeFileSync(archive,ch+block(a)+block(b)+block(a,'2026-01-02'));
  let ids=coldWorkspace(root);assert.equal(new Set(ids.entries.map(e=>e.id)).size,3);
  coldWorkspace(root,{revision:ids.revision,id:ids.entries[1].id});assert.ok(text().endsWith(b));
  ids=coldWorkspace(root);coldWorkspace(root,{revision:ids.revision,id:ids.entries[1].id});
  assert.equal(coldWorkspace(root).entries[0].sunkDay,'2026-01-01');
  console.log('PASS 冷冷重复记录独立定位与移回');
  reset();const unrelated='## B\n无关\n';writeFileSync(archive,ch+block(a)+block(unrelated));
  let view=coldWorkspace(root);const request={id:view.entries[0].id,revision:view.revision};
  assert.throws(()=>coldWorkspace(root,request,p=>{if(p==='hot')throw Error('interrupt')}),/interrupt/);
  writeFileSync(file,text()+a);view=coldWorkspace(root);assert.equal(view.conflicts.length,1);
  assert.throws(()=>coldWorkspace(root,request),/冲突/);
  coldWorkspace(root,{id:view.entries[1].id,revision:view.revision});assert.ok(text().includes(unrelated));
  const beforeDismiss=text();coldWorkspace(root,{action:'dismiss-conflict',conflictId:view.conflicts[0].id});assert.equal(text(),beforeDismiss);assert.equal(coldWorkspace(root).conflicts.length,0);
  console.log('PASS 冲突条目隔离、无关移回与解除');
  reset();writeFileSync(archive,ch+block(a)+'外部普通文字\n');view=coldWorkspace(root);assert.equal(view.entries.length,1);assert.ok(view.warning);
  assert.throws(()=>coldWorkspace(root,{id:view.entries[0].id,revision:'stale'}),/不可修改/);
  assert.ok(readFileSync(archive,'utf8').endsWith('外部普通文字\n'));
  console.log('PASS 冷存损坏仍返回部分列表');
  reset();const old=join(root,'memory-sink-pending.json');writeFileSync(old,'原样旧日志');coldWorkspace(root);assert.equal(text(),original);
  const {readdirSync}=await import('node:fs');const ignored=readdirSync(root).find(n=>n.startsWith('memory-sink-pending.json.ignored-'));assert.ok(ignored);assert.equal(readFileSync(join(root,ignored),'utf8'),'原样旧日志');
  console.log('PASS 旧事务只改名不执行');
  for(const phase of ['hot','cold']) for(const nth of [1,2,3,4,5]) {
    reset();let hits=0;await compact(p=>{if(p===phase&&++hits===nth)throw Error('interrupt')});assert.equal(hits,nth);
    const next=coldWorkspace(root);coldWorkspace(root,{id:next.entries[0].id,revision:next.revision});await compact();invariant(original);
  }
  console.log('PASS 多条下沉每次冷热写入断点均到达');
  reset();await compact(p=>{if(p==='journal')throw Error('interrupt')});writeFileSync(archive,ch+block(first));coldWorkspace(root);invariant(original+first);console.log('PASS 下沉不认领外部同文副本');
  reset();writeFileSync(archive,ch+block(a));let v=coldWorkspace(root);
  assert.throws(()=>coldWorkspace(root,{id:v.entries[0].id,revision:v.revision},p=>{if(p==='journal')throw Error('interrupt')}),/interrupt/);
  assert.throws(()=>coldWorkspace(root,{action:'dismiss-conflict',conflictId:'missing'}),e=>e.status===404);assert.equal(text(),original);
  assert.throws(()=>coldWorkspace(root,{}),e=>e.status===400);assert.equal(text(),original);
  writeFileSync(file,original+a);v=coldWorkspace(root);assert.equal(v.conflicts.length,1);assert.equal(text(),original+a);assert.equal(readFileSync(archive,'utf8'),ch+block(a));coldWorkspace(root,{action:'dismiss-conflict',conflictId:v.conflicts[0].id});console.log('PASS 移回不认领外部同文；无效请求不恢复');
  reset();await compact();const saved=readFileSync(archive,'utf8');writeFileSync(archive,saved.replace('正文。','改文。'));assert.match(coldWorkspace(root).warning,/哈希不符/);console.log('PASS 等长冷存篡改触发哈希告警');
  reset();const r='<!-- wb-distill-batch:2026-11-20:'+'a'.repeat(64)+'\n-->\n';writeFileSync(file,original+r);
  assert.throws(()=>migrateDistillReceipts(root,()=>{throw Error('interrupt')}),/interrupt/);migrateDistillReceipts(root);
  assert.equal(text(),original);const {extractReceipts}=await import('../lib/compact-fidelity.js');assert.deepEqual(extractReceipts(readFileSync(join(root,'distill-receipts.txt'),'utf8')).sort(),extractReceipts(r).sort());
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
