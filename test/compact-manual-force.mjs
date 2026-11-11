import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root=mkdtempSync(join(tmpdir(),'wb-manual-force-'))
try {
 const plugin=join(root,'plugin');mkdirSync(join(plugin,'lib'),{recursive:true})
 for(const f of readdirSync(new URL('../lib/',import.meta.url)))if(f.endsWith('.js'))copyFileSync(new URL('../lib/'+f,import.meta.url),join(plugin,'lib',f))
 writeFileSync(join(plugin,'package.json'),JSON.stringify({type:'module'}))
 const {compactMemoryIfOver,logicalDayStamp}=await import(pathToFileURL(join(plugin,'lib/index.js')))
 const cfg={memoryCharThreshold:12000,compactMaxTokens:1,compactProvider:'fixture',compactModel:'model'}
 const raw='# 长期记忆\n\n'+Array.from({length:8},(_,i)=>'<!-- tags: 测试 / date: 2020-01-01 / importance: high -->\n## 条目'+i+'\n重要事实。'+'重复说明。'.repeat(80)+'\n\n').join('')
 const day=logicalDayStamp(cfg),last={day,at:'2026-11-02T00:00:00.000Z',ok:true,target:6000,after:6200}
 async function run(name,options,previous=last,mode='ok') {
  const dir=join(root,name);mkdirSync(dir);writeFileSync(join(dir,'MEMORY.md'),raw)
  if(mode==='backup-failed')writeFileSync(join(dir,'archive'),'not a directory')
  const calls=[],markers={[name]:{...(previous?{__compact__:{...previous}}:{}),'2020-01-01':{added:2}}}
  const llm={stream:async function*(o){calls.push(o);const text=JSON.parse(o.messages[0].content[0].text.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text
   if(mode==='conflict')writeFileSync(join(dir,'MEMORY.md'),'# 并发编辑\n\n## 新事实\n不可覆盖')
   const output='# 长期记忆\n\n'+[...text.matchAll(/^## (条目\d+)/gm)].map(m=>'<!-- tags: 测试 / date: 2020-01-01 / importance: high -->\n## '+m[1]+'\n重要事实。\n\n').join('')
   yield {type:'text-delta',text:output};yield {type:'finish',reason:mode==='truncated'?'max-tokens':'stop'}
  }}
  const result=await compactMemoryIfOver(llm,cfg,{provider:'fixture',model:'model',maxTokens:37,timeoutMs:1000},name,dir,markers,options)
  return {result,calls,markers,dir,name}
 }
 const automatic=await run('automatic',{});assert.equal(automatic.result,null);assert.equal(automatic.calls.length,0)
 for(const previous of [last,{...last,ok:false},null]){
  const r=await run('manual-'+String(previous?.ok),{force:true,tokenBudget:'provider-default'},previous)
  assert.ok(r.result?.ok,'主动整理必须允许未超阈值、同日成功/失败及无记录');assert.ok(r.calls.length>0 && r.calls.length<=2)
  assert.ok(r.calls.every(c=>!Object.hasOwn(c,'maxTokens')));assert.ok(r.result.target<raw.length,'手动目标需小于当前短正文，不能鼓励扩写')
  assert.deepEqual(r.markers[r.name]['2020-01-01'],{added:2});assert.equal(readFileSync(join(r.dir,'archive','MEMORY.bak-'+day+'.md'),'utf8'),raw)
  assert.equal(await compactMemoryIfOver({},cfg,{},r.name,r.dir,r.markers),null,'手动不清除自动同日日锁')
 }
 const bad=await run('truncated',{force:true,tokenBudget:'provider-default'},last,'truncated');assert.equal(bad.result.errorCode,'llm-truncated');assert.equal(readFileSync(join(bad.dir,'MEMORY.md'),'utf8'),raw);assert.equal(bad.calls.length,1)
 const backup=await run('backup',{force:true,tokenBudget:'provider-default'},last,'backup-failed');assert.equal(backup.result.errorCode,'backup-failed');assert.equal(backup.calls.length,0)
 const conflict=await run('conflict',{force:true,tokenBudget:'provider-default'},last,'conflict');assert.equal(conflict.result.errorCode,'conflict');assert.equal(readFileSync(join(conflict.dir,'MEMORY.md'),'utf8'),'# 并发编辑\n\n## 新事实\n不可覆盖');assert.deepEqual(conflict.markers.conflict.__compact__,last)
 console.log('compact-manual-force: 主动/未超阈值/同日/无记录/无上限/备份/截断/冲突/自动锁兼容 passed')
}finally{const actual=realpathSync(root);assert.equal(actual,root);rmSync(root,{recursive:true,force:true})}
