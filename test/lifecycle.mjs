import assert from 'node:assert/strict'
import { inspectMemory, migrateMemory, applyMemoryAction, memoryRevision, preservesLifecycle } from '../lib/memory-lifecycle.js'
let passed=0
const test=(name,fn)=>{fn();console.log('PASS '+name);passed++}
const original='# 长期记忆\r\n\r\n<!-- tags: 备份 / date: 2026-10-17 -->\r\n## 备份时间\r\n夜间03:20执行备份。\r\n\r\n## 其他约定\r\n发布前检查回滚。\r\n'
const migrated=migrateMemory(original).text,p=inspectMemory(migrated),id=p.records[0].meta.id
const act=(text,action,extra={})=>applyMemoryAction(text,{revision:memoryRevision(text),id,action,reason:'用户明确更正',...extra})
test('只读不分配ID且不改原文',()=>{assert.equal(inspectMemory(original).byId.size,0);assert.equal(inspectMemory(original).revision,memoryRevision(original))})
test('显式迁移随机唯一ID且可幂等',()=>{assert.equal(p.byId.size,2);assert.match(id,/^mem_[a-f0-9]{32}$/);assert.equal(migrateMemory(migrated).text,migrated);assert.notEqual(migrateMemory(original).text,migrated)})
test('CRLF与旧正文保持',()=>{assert.ok(!migrated.replaceAll('\r\n','').includes('\n'));assert.ok(migrated.includes('夜间03:20执行备份。'));assert.ok(migrated.includes('<!-- tags: 备份 / date: 2026-10-17 -->'))})
const corrected=act(migrated,'correct',{title:'备份时间',body:'夜间03:30执行备份。'}).text
const cp=inspectMemory(corrected),successor=cp.byId.get(id).meta.by
test('更正保留旧原文和新ID双向关联',()=>{assert.equal(cp.byId.get(id).meta.state,'superseded');assert.equal(cp.byId.get(successor).meta.state,'current');assert.equal(cp.byId.get(successor).meta.from,id);assert.ok(corrected.includes('03:20'));assert.ok(corrected.includes('03:30'))})
test('过期revision拒绝',()=>assert.throws(()=>applyMemoryAction(corrected,{revision:p.revision,id,action:'retract'}),e=>e.status===409))
test('有效后继存在时拒绝恢复祖先',()=>assert.throws(()=>act(corrected,'restore'),e=>e.status===409))
const withdrawn=act(corrected,'retract',{id:successor}).text,restored=act(withdrawn,'restore').text
test('撤回不删正文，恢复不新建ID且同链仅一当前',()=>{assert.equal(inspectMemory(withdrawn).byId.get(successor).meta.state,'retracted');assert.equal(inspectMemory(restored).byId.get(id).meta.state,'current');assert.equal(inspectMemory(restored).byId.size,3)})
test('恢复祖先后仍可更正且不丢历史后继',()=>{const next=inspectMemory(act(restored,'correct',{title:'更新备份',body:'改为04:00'}).text);assert.equal(next.byId.size,4);assert.equal(next.byId.get(successor).meta.by,next.records.at(-1).meta.id)})
test('重复ID拒绝',()=>assert.throws(()=>inspectMemory(migrated+'\r\n'+p.records[0].raw),e=>e.status===409))
test('孤立与伪造标记拒绝',()=>{assert.throws(()=>inspectMemory('<!-- wb-memory:broken -->'));assert.throws(()=>act(migrated,'correct',{title:'标题',body:'<!-- wb-memory:evil -->'}));assert.throws(()=>act(migrated,'correct',{title:'标题',body:'内容\n## 注入的新标题'}))})
test('整理保留身份/历史，缺标记或历史改写拒绝',()=>{assert.equal(preservesLifecycle(corrected,corrected),true);assert.equal(preservesLifecycle(corrected,corrected.replace('03:20','02:00')),false);assert.equal(preservesLifecycle(migrated,original),false);assert.equal(preservesLifecycle(migrated,migrated.replace('03:20','03点20分')),true)})
test('代码围栏中标题拒绝迁移',()=>assert.throws(()=>migrateMemory('## 正文\n'+String.fromCharCode(96).repeat(3)+'\n## 代码\n'+String.fromCharCode(96).repeat(3))))
test('空标题与非ASCII空白保持与旧解析相同序号',()=>{const q=inspectMemory(migrateMemory('## '+String.fromCharCode(10)+'正文'+String.fromCharCode(10)+'##'+String.fromCharCode(160)+'标题'+String.fromCharCode(10)+'另一正文').text);assert.equal(q.byId.size,2);assert.equal(q.records[1].title,'标题')})
// 真正整理入口，覆盖第二轮不能以预算降级绕过生命周期保护。
const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs')
const {fileURLToPath}=await import('node:url')
const {join,dirname}=await import('node:path')
const idx=await import('../lib/index.js')
const compactRoot=join(dirname(fileURLToPath(import.meta.url)),'..','.tmp','lifecycle-compact-'+Date.now())
const large=migrateMemory('## 历史约定'+String.fromCharCode(10)+'原文不可改。'+String.fromCharCode(10)+'## 当前长条目'+String.fromCharCode(10)+'正文内容。'.repeat(1200)).text
const firstId=inspectMemory(large).records[0].meta.id
const history=applyMemoryAction(large,{revision:memoryRevision(large),id:firstId,action:'retract',reason:'明确撤回'}).text
const short=history.replace('正文内容。'.repeat(1200),'精简后的正文。')
for(const [name,output,expected] of [['保留全部ID与历史允许整理',short,true],['丢失ID两轮都拒绝',short.split(String.fromCharCode(10)).filter(l=>!l.startsWith('<!-- wb-memory:')).join(String.fromCharCode(10)),false],['篡改历史正文两轮都拒绝',short.replace('原文不可改','历史被改写'),false]]) {
 const dir=join(compactRoot,String(expected)+'-'+name);mkdirSync(dir,{recursive:true});const file=join(dir,'MEMORY.md');writeFileSync(file,history)
 let calls=0;const llm={stream:async function*(){calls++;yield {type:'text-delta',text:output};yield {type:'finish',reason:'stop'}}}
 const result=await idx.compactMemoryIfOver(llm,{memoryCharThreshold:2000,compactRetryFeedback:true},{provider:'fixture',model:'fixture'},'fixture',dir,{})
 test(name,()=>{assert.equal(result.ok,expected);assert.equal(result.checks.lifecyclePreserved,expected);if(!expected){assert.equal(calls,2);assert.equal(readFileSync(file,'utf8'),history)}else assert.ok(preservesLifecycle(history,readFileSync(file,'utf8')))})
}
console.log('lifecycle: '+passed+' passed / 0 failed')
