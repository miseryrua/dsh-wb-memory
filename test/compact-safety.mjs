import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {inspectMemory,migrateMemory,applyMemoryAction,memoryRevision,preservesLifecycle} from '../lib/memory-lifecycle.js'
import {planCompactBatches} from '../lib/compact-plan.js'
const root=mkdtempSync(join(tmpdir(),'wb-compact-safety-'))
let passed=0
const test=(name,fn)=>{fn();passed++;console.log('PASS '+name)}
try {
 const plugin=join(root,'plugin');mkdirSync(join(plugin,'lib'),{recursive:true})
 for(const f of readdirSync(new URL('../lib/',import.meta.url)))if(f.endsWith('.js'))copyFileSync(new URL('../lib/'+f,import.meta.url),join(plugin,'lib',f))
 writeFileSync(join(plugin,'package.json'),JSON.stringify({type:'module'}))
 const {compactMemoryIfOver,logicalDayStamp}=await import(pathToFileURL(join(plugin,'lib/index.js')))
 let raw=migrateMemory('# 长期记忆\n\n<!-- tags: 历史 -->\n## 原约定\n历史原文不可改。\n\n## 撤回约定\n已撤回原文。\n\n'+Array.from({length:10},(_,i)=>'<!-- tags: 批次'+i+' -->\n## 条目'+i+'\n'+'重复'.repeat(1100)+'\n\n').join('')).text
 const ids=inspectMemory(raw).records.map(r=>r.meta.id)
 raw=applyMemoryAction(raw,{revision:memoryRevision(raw),id:ids[0],action:'correct',title:'现约定',body:'新的有效约定。',reason:'明确更正'}).text
 raw=applyMemoryAction(raw,{revision:memoryRevision(raw),id:ids[1],action:'retract',reason:'明确撤回'}).text
 const plan=planCompactBatches(raw,12000,9600)
 test('完整重组含前置tags与跨批链',()=>{
  assert.equal(plan.prefix+plan.batches.map(b=>b.text).join(''),raw)
  const successor=inspectMemory(raw).byId.get(ids[0]).meta.by
  assert.ok(plan.batches[0].text.includes(inspectMemory(raw).byId.get(ids[0]).raw.trim()));assert.ok(plan.batches[1].text.includes(inspectMemory(raw).byId.get(successor).raw.trim()))
  assert.ok(plan.batches.every(b=>b.text.startsWith('<!-- tags:')||b.text.startsWith('## ')))
 })
 async function run(name,{text=raw,mode='ok',cfg={},setup}={}){
  const dir=join(root,name);mkdirSync(dir);const path=join(dir,'MEMORY.md');writeFileSync(path,text);if(setup)setup(dir)
  const calls=[],markers={}
  const llm={stream:async function*(o){
   calls.push(o)
   const input=JSON.parse(o.messages[0].content[0].text.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text
   let out=input.replace(/(?:重复){1100}/g,'精简的有效事实。')
   if(mode==='tamper')out=out.replace('历史原文不可改','篡改历史')
   if(mode==='drop')out=out.replace(/<!-- wb-memory:[^\n]+ -->\n/,'')
   if(mode==='conflict')writeFileSync(path,text.replace('长期记忆','已被人工编辑'))
   if(mode==='append')writeFileSync(path,text+'\n## 新增\n并发事实必须保留。\n')
   yield {type:'text-delta',text:out};yield {type:'finish',reason:'stop'}
  }}
  const result=await compactMemoryIfOver(llm,{memoryCharThreshold:12000,compactMaxTokens:8000,...cfg},{provider:'fixture',model:'fixture'},name,dir,markers)
  return {dir,path,result,calls,markers}
 }
 const good=await run('mixed')
 test('两批整理保留current/superseded/retracted完整链',()=>{assert.ok(good.result.ok);assert.equal(good.calls.length,2);assert.ok(preservesLifecycle(raw,readFileSync(good.path,'utf8')))})
 for(const mode of ['tamper','drop']){
  const r=await run(mode,{mode})
  test(mode+'不得写回',()=>{assert.equal(r.result.ok,false);assert.equal(r.result.errorCode,'validation');assert.equal(readFileSync(r.path,'utf8'),raw);assert.equal(r.calls.length,2)})
 }
 const conflict=await run('conflict',{mode:'conflict'})
 test('非追加冲突保留人工编辑且不设日锁',()=>{assert.ok(conflict.result.conflict);assert.ok(conflict.markers.conflict.__compactConflict__);assert.equal(conflict.markers.conflict.__compact__,undefined);assert.match(readFileSync(conflict.path,'utf8'),/已被人工编辑/)})
 const append=await run('append',{mode:'append'})
 test('批间追加不会丢失',()=>{assert.ok(append.result.ok);assert.match(readFileSync(append.path,'utf8'),/并发事实必须保留/)})
 const backup=await run('backup',{setup:dir=>{mkdirSync(join(dir,'archive'));writeFileSync(join(dir,'archive','MEMORY.bak-'+logicalDayStamp({})+'.md'),'首份备份不可覆盖')}})
 test('同日备份不覆盖且另有原文快照',()=>{const contents=readdirSync(join(backup.dir,'archive')).map(f=>readFileSync(join(backup.dir,'archive',f),'utf8'));assert.ok(contents.includes('首份备份不可覆盖'));assert.ok(contents.includes(raw))})
 const failed=await run('backup-failed',{setup:dir=>writeFileSync(join(dir,'archive'),'非目录')})
 test('备份失败零调用',()=>{assert.equal(failed.result.errorCode,'backup-failed');assert.equal(failed.calls.length,0);assert.equal(readFileSync(failed.path,'utf8'),raw)})
 const budget=await run('budget',{cfg:{compactMaxTokens:1}})
 test('小预算零调用',()=>{assert.equal(budget.result.errorCode,'budget-too-small');assert.equal(budget.calls.length,0)})
 for(const [name,text] of [['single','# 长期记忆\n## 超长条目\n'+'长'.repeat(41000)+'\n## 另一条\n事实'],['many','# 长期记忆\n'+Array.from({length:9},(_,i)=>'## 条目'+i+'\n'+'长'.repeat(10000)+'\n').join('')]]){
  const r=await run(name,{text})
  test(name+'超上限零调用且原文不变',()=>{assert.equal(r.result.errorCode,'input-too-large');assert.equal(r.calls.length,0);assert.equal(readFileSync(r.path,'utf8'),text)})
 }
 test('不安全围栏拒绝切分',()=>assert.throws(()=>planCompactBatches('# 长期记忆\n## 条目\n'+'长'.repeat(20000)+'\n~~~\n## 假标题\n~~~',12000,9600),/unsafe-layout/))
 console.log('compact-safety: '+passed+' passed')
}finally{rmSync(root,{recursive:true,force:true})}
