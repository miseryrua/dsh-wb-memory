import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { rankMemory, summarizeEntries, readMemoryEntries } from '../lib/retrieve.js'
import { inspectMemory } from '../lib/memory-lifecycle.js'
import { rankMemory as oldRank } from './fixtures/retrieve-before-panel.mjs'
import { createRecallDiagnostics } from '../lib/recall-diagnostics.js'
const here=dirname(fileURLToPath(import.meta.url)), root=join(here,'..')
let passed=0
const test=(name,fn)=>{fn();passed++;console.log('PASS '+name)}
const md=['## 发布回滚','回滚发布需要先检查版本 SHA256 与告警。','## 备份任务','备份任务在夜间执行，检查副本。','## 无关电池','电池循环次数记录。'].join(String.fromCharCode(10))
for (const q of ['发布回滚','SHA256','备份','电池','xyz','的了','', '发','发布 备份']) for (const k of [0,1,5]) {
 test('排序逐值等价 '+JSON.stringify(q)+' k='+k,()=>{
  let trace
  const expected=oldRank(md,q,{k})
  assert.deepEqual(rankMemory(md,q,{k}),expected)
  assert.deepEqual(rankMemory(md,q,{k,onDiagnostics:r=>trace=r}),expected)
  assert.equal(trace.total,3)
  assert.equal(trace.selected,expected.length)
  assert.equal(trace.candidates.length,3)
  assert.deepEqual(rankMemory(md,q,{k,onDiagnostics:()=>{throw Error('observer')}}),expected)
 })
}
let audit
rankMemory(md,'发布回滚',{k:1,onDiagnostics:r=>audit=r})
test('候选筛因完整且无正文',()=>{assert.equal(audit.candidates.filter(x=>x.reason==='selected').length,1);assert.ok(audit.candidates.some(x=>x.reason==='no-match'));assert.ok(!JSON.stringify(audit).includes('需要先检查'))})
const store=createRecallDiagnostics({maxWorkspaces:2,maxCandidates:1})
const row={...audit, workspace:'A',query:'secret_query',body:'secret_body',entries:[{title:'a',body:'secret_body',cap:2}],candidates:[{title:'a'.repeat(200),reason:'no-match',body:'secret_body'},{title:'chosen',reason:'selected',query:'secret_query'}]}
store.record(row)
test('白名单与长度上限且selected优先',()=>{const r=store.snapshot('A');assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].title,'chosen');assert.equal(r.omitted,1);assert.equal(r.counts['no-match'],1);assert.ok(!JSON.stringify(r).includes('secret_'))})
test('工作区隔离/内存上限/快照不可改内部',()=>{const r=store.snapshot('A');r.mode='changed';assert.notEqual(store.snapshot('A').mode,'changed');assert.equal(store.snapshot('B'),null);store.record({...row,workspace:'B'});store.record({...row,workspace:'C'});assert.equal(store.snapshot('A'),null);store.clear();assert.equal(store.snapshot('C'),null)})
// 独立插件副本，绝不改真实配置或用户记忆。保留产物便于排错，不调用删除。
const sandbox=join(root,'.tmp','panel-'+Date.now()), plugin=join(sandbox,'plugin'), wsroot=join(sandbox,'workspaces')
mkdirSync(join(plugin,'lib'),{recursive:true})
for(const f of readdirSync(join(root,'lib')))if(f.endsWith('.js'))copyFileSync(join(root,'lib',f),join(plugin,'lib',f))
copyFileSync(join(root,'package.json'),join(plugin,'package.json'))
const cfg={enabled:true,autoDistill:false,sessionSummary:false,memoryHeat:false,memorySearchTool:false,workspaceRoot:wsroot,relevantTopK:5,injectionMaxChars:12000}
writeFileSync(join(plugin,'config.json'),JSON.stringify(cfg))
for(const ws of ['A','B']){const dir=join(wsroot,ws,'.workbuddy','memory');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'MEMORY.md'),ws==='A'?md:'## 仅B可见'+String.fromCharCode(10)+'其他工作区不能看到的内容。')}
const idx=await import(pathToFileURL(join(plugin,'lib','index.js')))
const cwd=join(wsroot,'A'), context={messages:[{role:'user',content:'发布回滚'}]}
for(const dynamicBudget of [true,false])for(const injectionMaxChars of [4000,12000]){
 const c={...cfg,dynamicBudget,injectionMaxChars};let trace
 const block=idx.buildMemoryBlock(cwd,context,c)
 test('旁路不改变最终注入 '+dynamicBudget+'/'+injectionMaxChars,()=>{assert.equal(idx.buildMemoryBlock(cwd,context,c,r=>trace=r),block);assert.equal(idx.buildMemoryBlock(cwd,context,c,()=>{throw Error('observer')}),block);assert.equal(trace.blockChars,block.length);assert.ok(block.length<=injectionMaxChars);assert.equal(trace.workspace,'A');assert.equal(trace.selected,1)})
}
let emptyTrace
idx.buildMemoryBlock(cwd,{},cfg,r=>emptyTrace=r)
test('无查询如实使用摘要且报告条目总数',()=>{assert.equal(emptyTrace.mode,'no-query');assert.equal(emptyTrace.total,3);assert.equal(emptyTrace.selected,0)})
let authVerdict
const routes=[], injections=[], effects=[];let registered
idx.apply({inject:(deps,fn)=>injections.push({deps,fn}),effect:(fn,label)=>effects.push({fn,label}),on:()=>()=>{}})
for(const {deps,fn} of injections){if(deps.includes('systemPrompt'))fn({systemPrompt:{context:r=>{registered=r}}});if(deps.includes('webServer'))fn({effect:f=>f(),connection:{requestRejection:()=>authVerdict},webServer:{register:r=>{routes.push(r);return()=>{}}}})}
async function call(path,{method='GET',body={},origin='http://localhost:19387',ws='A',query=''}={}){
 const req=Readable.from(method==='POST'?[JSON.stringify(body)]:[]);Object.assign(req,{method,url:path+'?workspace='+ws+query,headers:{host:'127.0.0.1:19387',origin}})
 let status,data;const res={writeHead:s=>status=s,end:b=>data=JSON.parse(b)}
 await routes.find(r=>r.path===path).handler(req,res);return{status,data}
}
let response=await call('/api/wb-memory/status')
test('无组装记录不伪造历史',()=>assert.equal(response.data.recall,null))
const before=readFileSync(join(plugin,'config.json'),'utf8'),mem=readFileSync(join(wsroot,'A','.workbuddy','memory','MEMORY.md'),'utf8')
response=await call('/api/wb-memory/recall-preview',{method:'POST',body:{workspace:'A',q:'发布回滚'}})
test('真实预览路由成功但不记录actual',()=>{assert.equal(response.status,200);assert.equal(response.data.kind,'preview');assert.equal(response.data.selected,1)})
response=await call('/api/wb-memory/status')
test('预览不污染实际账且不写配置/记忆',()=>{assert.equal(response.data.recall,null);assert.equal(readFileSync(join(plugin,'config.json'),'utf8'),before);assert.equal(readFileSync(join(wsroot,'A','.workbuddy','memory','MEMORY.md'),'utf8'),mem)})
registered.text({agent:{session:{id:'mock-A',header:{cwd},messages:context.messages}}})
response=await call('/api/wb-memory/status')
const actual=response.data.recall
test('宿主text回调记录实际组装而非模型使用',()=>{assert.equal(actual.kind,'assembled');assert.equal(actual.workspace,'A');assert.equal(actual.selected,1);assert.ok(actual.entries.some(e=>e.present))})
response=await call('/api/wb-memory/status',{ws:'B'})
test('实际记录严格工作区隔离',()=>assert.equal(response.data.recall,null))
response=await call('/api/wb-memory/recall-preview',{method:'POST',body:{workspace:'B',q:'其他'}})
test('显式B预览不混入A记忆',()=>{assert.equal(response.data.workspace,'B');assert.equal(response.data.total,1);assert.ok(!JSON.stringify(response.data).includes('发布回滚'))})
for(const [options,status] of [[{method:'GET'},405],[{method:'POST',origin:'https://evil.invalid',body:{workspace:'A',q:'发布'}},403],[{method:'POST',body:{workspace:'../A',q:'发布'}},400],[{method:'POST',body:{workspace:'A',q:''}},400],[{method:'POST',body:{workspace:'A',q:'x'.repeat(4001)}},400]]){
 response=await call('/api/wb-memory/recall-preview',options)
 test('请求校验 '+status,()=>assert.equal(response.status,status))
}
writeFileSync(join(plugin,'config.json'),JSON.stringify({...cfg,enabled:false}))
response=await call('/api/wb-memory/recall-preview',{method:'POST',body:{workspace:'A',q:'发布'}})
test('关闭总控仍可预览但明确enabled=false',()=>{assert.equal(response.status,200);assert.equal(response.data.enabled,false)})
// 生命周期与路由测试复用同一隔离宿主，不接触真实工作区。
const memoryFile=join(wsroot,'A','.workbuddy','memory','MEMORY.md')
response=await call('/api/wb-memory/recall-eval',{query:'&candidateK=1'})
test('评测路由真实运行26案并保留弱项',()=>{assert.equal(response.status,200);assert.equal(response.data.baseline.cases.length,26);assert.ok(response.data.baseline.cases.some(c=>!c.passed));assert.equal(readFileSync(join(plugin,'config.json'),'utf8'),JSON.stringify({...cfg,enabled:false}));assert.equal(readFileSync(join(wsroot,'A','.workbuddy','memory','MEMORY.md'),'utf8'),mem)})
response=await call('/api/wb-memory/recall-eval',{query:'&candidateK=2'})
test('评测参数边界400',()=>assert.equal(response.status,400))
response=await call('/api/wb-memory/recall-eval',{method:'POST'})
test('评测禁止POST405',()=>assert.equal(response.status,405))
let listing=await call('/api/wb-memory/memories')
test('管理GET只读且旧条目不自动补ID',()=>{assert.equal(listing.status,200);assert.equal(listing.data.unmanaged,3);assert.equal(readFileSync(memoryFile,'utf8'),mem)})
let preview=await call('/api/wb-memory/memories',{method:'POST',body:{workspace:'A',action:'preview-migration',revision:listing.data.revision}})
test('补ID预览无写入',()=>{assert.equal(preview.status,200);assert.equal(preview.data.planned,3);assert.equal(readFileSync(memoryFile,'utf8'),mem)})
let migratedResponse=await call('/api/wb-memory/memories',{method:'POST',body:{workspace:'A',action:'migrate',revision:preview.data.revision}})
const managed=readFileSync(memoryFile,'utf8'),parsed=inspectMemory(managed),managedId=parsed.records[0].meta.id
test('显式补ID原文备份成功后再写且返回新revision',()=>{assert.equal(migratedResponse.status,200);assert.equal(migratedResponse.data.changed,3);assert.equal(readFileSync(join(wsroot,'A','.workbuddy','memory','archive',migratedResponse.data.backup),'utf8'),mem);assert.equal(migratedResponse.data.revision,parsed.revision)})
response=await call('/api/wb-memory/memories',{method:'POST',body:{workspace:'A',action:'retract',id:managedId,reason:'旧请求',revision:preview.data.revision}})
test('revision过期返回409且不写',()=>{assert.equal(response.status,409);assert.equal(readFileSync(memoryFile,'utf8'),managed)})
response=await call('/api/wb-memory/memories',{method:'POST',body:{workspace:'A',action:'correct',id:managedId,reason:'用户更新发布流程',title:'发布回滚新约定',body:'回滚发布改用新的校验步骤 CURRENT_ONLY。',revision:parsed.revision}})
const amended=readFileSync(memoryFile,'utf8'),amendedParsed=inspectMemory(amended),newId=amendedParsed.byId.get(managedId).meta.by
test('显式更正不经过近重复门并保留旧记录',()=>{assert.equal(response.status,200);assert.equal(amendedParsed.byId.size,4);assert.equal(amendedParsed.byId.get(managedId).meta.state,'superseded');assert.ok(amended.includes('需要先检查版本'))})
let stateAudit
const ranked=rankMemory(amended,'发布回滚',{onDiagnostics:r=>stateAudit=r})
test('相关/摘要/原生检索投影不召回被替代正文或管理标记',()=>{assert.ok(ranked.every(x=>x.entry.memoryId!==managedId));assert.ok(!summarizeEntries(amended).includes('需要先检查版本'));assert.ok(!JSON.stringify(readMemoryEntries(amended)).includes('wb-memory:'));assert.ok(stateAudit.candidates.some(r=>r.reason==='superseded'))})
response=await call('/api/wb-memory/memories',{method:'POST',body:{workspace:'A',action:'restore',id:managedId,reason:'尝试恢复',revision:amendedParsed.revision}})
test('恢复与有效后继冲突返回409',()=>assert.equal(response.status,409))
response=await call('/api/wb-memory/memories',{method:'POST',body:{workspace:'A',action:'retract',id:newId,reason:'用户撤回该条目',revision:amendedParsed.revision}})
const retracted=readFileSync(memoryFile,'utf8')
test('撤回仅改状态且当前检索不命中',()=>{assert.equal(response.status,200);assert.ok(retracted.includes('CURRENT_ONLY'));assert.equal(rankMemory(retracted,'CURRENT_ONLY').length,0)})
response=await call('/api/wb-memory/memories',{method:'POST',body:{workspace:'A',action:'restore',id:managedId,reason:'恢复旧约定',revision:inspectMemory(retracted).revision}})
test('撤回后允许恢复祖先，稳定ID保持',()=>{assert.equal(response.status,200);assert.equal(inspectMemory(readFileSync(memoryFile,'utf8')).byId.get(managedId).meta.state,'current')})
for(const options of [{ws:'../A'},{ws:'unknown'},{method:'POST',origin:'https://evil.invalid',body:{workspace:'A',action:'migrate'}},{method:'POST',body:{workspace:'../A',action:'migrate'}}]){
 response=await call('/api/wb-memory/memories',options)
 test('管理接口拒绝未知工作区/跨源 '+response.status,()=>assert.ok([400,403].includes(response.status)))
}
response=await call('/api/wb-memory/memories',{ws:'B'})
test('B工作区无A条目/ID',()=>{assert.equal(response.status,200);assert.equal(response.data.total,1);assert.equal(response.data.unmanaged,1);assert.ok(!JSON.stringify(response.data).includes(managedId))})
const beforeLegacy=readFileSync(memoryFile,'utf8'),configLegacy=readFileSync(join(plugin,'config.json'),'utf8')
for(const route of routes.filter(r=>r.path.startsWith('/wb-memory/')))for(const method of ['GET','POST','DELETE']){
 response=await call(route.path,{method,body:{enabled:true,workspace:'A'}})
 test('旧地址无条件410 '+route.path+' '+method,()=>assert.equal(response.status,410))
}
test('旧地址所有方法无配置/记忆副作用',()=>{assert.equal(readFileSync(memoryFile,'utf8'),beforeLegacy);assert.equal(readFileSync(join(plugin,'config.json'),'utf8'),configLegacy)})
response=await call('/api/wb-memory/file',{method:'POST',body:{workspace:'A',path:'MEMORY.md',content:'覆盖'}})
test('通用文件接口不可覆盖已管理记忆',()=>{assert.equal(response.status,409);assert.equal(readFileSync(memoryFile,'utf8'),beforeLegacy)})
for (const [method,name,expected] of [['POST','memory.md',409],['DELETE','mEmOrY.md',409],['POST','MEMORY.md.',400],['POST','MEMORY.md::$DATA',400]]) {
 response=await call('/api/wb-memory/file',{method,query:method==='DELETE'?'&path='+encodeURIComponent(name):'',body:{workspace:'A',path:name,content:'别名覆盖'}})
 test('拒绝文件名别名绕过 '+name,()=>{assert.equal(response.status,expected);assert.equal(readFileSync(memoryFile,'utf8'),beforeLegacy)})
}
for (const [options,status] of [[{method:'GET'},405],[{method:'POST',origin:'https://evil.invalid'},403]]) {
 response=await call('/api/wb-memory/distill',options)
 test('提炼禁止GET/跨源POST '+status,()=>assert.equal(response.status,status))
}
const authMemory=readFileSync(memoryFile,'utf8'),authConfig=readFileSync(join(plugin,'config.json'),'utf8')
for (const verdict of [401,403,null]) {
 authVerdict=verdict
 for (const route of routes.filter(r=>r.path.startsWith('/api/')))for(const method of ['GET','POST','DELETE']) {
  response=await call(route.path,{method,body:{workspace:'A',action:'migrate',revision:'stale'}})
  test('注册路由先鉴权 '+verdict+' '+method+' '+route.path,()=>assert.equal(response.status,verdict===null?503:verdict))
 }
}
authVerdict=undefined
test('拒绝请求无配置记忆副作用',()=>{assert.equal(readFileSync(memoryFile,'utf8'),authMemory);assert.equal(readFileSync(join(plugin,'config.json'),'utf8'),authConfig)})
console.log('panel-recall: '+passed+' passed / 0 failed')
