import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
const root=mkdtempSync(join(tmpdir(),'wb-retry-route-'))
try {
 const plugin=join(root,'plugin'), wsroot=join(root,'ws');mkdirSync(join(plugin,'lib'),{recursive:true})
 for(const f of readdirSync(new URL('../lib/',import.meta.url)))if(f.endsWith('.js'))copyFileSync(new URL('../lib/'+f,import.meta.url),join(plugin,'lib',f))
 writeFileSync(join(plugin,'package.json'),JSON.stringify({type:'module'}))
 const cfg={enabled:true,workspaceRoot:wsroot,activeProject:'A',autoDistill:true,autoCompact:true,memoryCharThreshold:1000,compactProvider:'fixture',compactModel:'fixture-model',compactMaxTokens:8000,memoryHeat:false}
 writeFileSync(join(plugin,'config.json'),JSON.stringify(cfg))
 const raw=['# 记忆','','## 事实',''].join(String.fromCharCode(10))+'原始事实。'.repeat(900)
 for(const ws of ['A','B']){mkdirSync(join(wsroot,ws,'.workbuddy','memory'),{recursive:true});writeFileSync(join(wsroot,ws,'.workbuddy','memory','MEMORY.md'),raw)}
 const markers={A:{__compact__:{day:'old',at:'old-A',ok:false,error:'llm finish: truncated (max-tokens)'},'2020-01-01':{added:3}},B:{__compact__:{at:'old-B',ok:false}}}
 writeFileSync(join(plugin,'distilled.json'),JSON.stringify(markers))
 let verdict=401,calls=[];const routes=new Map()
 const llm={listProviders:()=>['fixture'],resolveModelInfo:async(p,m)=>({reasoning:{efforts:m==='fixture-model'?[{id:'low',name:'Low'},{id:'high',name:'High'}]:[{id:'max',name:'Max'}]}}),stream:async function*(o){calls.push(o);yield {type:'finish',reason:'max-tokens'}}}
 const host={connection:{requestRejection:()=>verdict},webServer:{register:r=>routes.set(r.path,r.handler)},effect:fn=>fn()}
 const idx=await import(pathToFileURL(join(plugin,'lib/index.js')))
 idx.apply({inject:(deps,fn)=>{if(deps.includes('webServer'))fn(host);else if(deps.includes('llm'))fn({llm})},effect:()=>{}})
 async function request(path,body,method='POST',origin='http://localhost:3190'){
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{url:path,method,headers:{host:'localhost:3190',origin}})
  let status,data;await routes.get(path)(req,{writeHead:s=>status=s,end:b=>data=JSON.parse(b)});return {status,data}
 }
 const route='/api/wb-memory/compact-retry',input={workspace:'A',expectedAt:'old-A',confirmed:true}
 assert.equal((await request(route,input)).status,401);verdict=403;assert.equal((await request(route,input)).status,403)
 verdict=undefined
 assert.equal((await request('/wb-memory/compact-retry',input)).status,410)
 assert.equal((await request(route,input,'GET')).status,405)
 assert.equal((await request(route,input,'POST','http://evil.invalid')).status,403)
 assert.equal((await request(route,{...input,maxTokens:16000})).status,400)
 assert.equal((await request(route,{...input,workspace:'unknown'})).status,400)
 assert.equal((await request(route,{...input,expectedAt:'stale'})).status,409)
 assert.equal(calls.length,0)
 const info=await request('/api/wb-memory/reasoning',undefined,'GET');assert.equal(info.status,400)
 const reasonHandler=routes.get('/api/wb-memory/reasoning');let metadata
 await reasonHandler({url:'/api/wb-memory/reasoning?provider=fixture&model=fixture-model',method:'GET',headers:{}},{writeHead:()=>{},end:b=>metadata=JSON.parse(b)})
 assert.deepEqual(metadata.efforts.map(x=>x.id),['low','high'])
 const configRoute='/api/wb-memory/config'
 assert.equal((await request(configRoute,{compactReasoningEffort:'none'})).status,400)
 assert.equal((await request(configRoute,{compactReasoningEffort:'high'})).status,200)
 const response=await request(route,input);assert.equal(response.status,200);assert.equal(response.data.result.errorCode,'llm-truncated')
 assert.equal(calls[0].reasoningEffort,'high')
 assert.equal(calls.length,1);assert.equal(calls[0].provider,'fixture');assert.equal(calls[0].model,'fixture-model');assert.equal(Object.hasOwn(calls[0],'maxTokens'),false)
 const after=JSON.parse(readFileSync(join(plugin,'distilled.json'),'utf8'));assert.deepEqual(after.B,markers.B);assert.deepEqual(after.A['2020-01-01'],markers.A['2020-01-01'])
 for(const ws of ['A','B'])assert.equal(readFileSync(join(wsroot,ws,'.workbuddy','memory','MEMORY.md'),'utf8'),raw)
 // exact-route harness supplies path separately from URL query below.
 const getStatus=routes.get('/api/wb-memory/status');let projected
 await getStatus({url:'/api/wb-memory/status?workspace=A',method:'GET',headers:{}},{writeHead:()=>{},end:b=>projected=JSON.parse(b)})
 assert.equal(projected.compactRetry.used,true)
 assert.equal((await request(route,{...input,expectedAt:after.A.__compact__.at})).data.code,'already-used');assert.equal(calls.length,1)
 assert.equal(JSON.parse(readFileSync(join(plugin,'config.json'),'utf8')).compactReasoningEffort,'high')
 assert.equal((await request(configRoute,{compactReasoningEffort:'auto'})).status,200)
 mkdirSync(join(wsroot,'C','.workbuddy','memory'),{recursive:true});writeFileSync(join(wsroot,'C','.workbuddy','memory','MEMORY.md'),raw)
 const cMarkers=JSON.parse(readFileSync(join(plugin,'distilled.json'),'utf8'));cMarkers.C={__compact__:{at:'old-C',ok:false}};writeFileSync(join(plugin,'distilled.json'),JSON.stringify(cMarkers))
 assert.equal((await request(route,{workspace:'C',expectedAt:'old-C',confirmed:true})).status,200)
 assert.equal(Object.hasOwn(calls[1],'reasoningEffort'),false) // 未公告 off，不再回落 low
 // 新工作区，验证公告 off 后 auto 在真实 stream 边界传递关闭档位。
 llm.resolveModelInfo=async()=>({reasoning:{efforts:[{id:'off',name:'关闭'},{id:'low',name:'Low'}]}})
 mkdirSync(join(wsroot,'D','.workbuddy','memory'),{recursive:true});writeFileSync(join(wsroot,'D','.workbuddy','memory','MEMORY.md'),raw)
 const dMarkers=JSON.parse(readFileSync(join(plugin,'distilled.json'),'utf8'));dMarkers.D={__compact__:{at:'old-D',ok:false}};writeFileSync(join(plugin,'distilled.json'),JSON.stringify(dMarkers))
 assert.equal((await request(route,{workspace:'D',expectedAt:'old-D',confirmed:true})).status,200)
 assert.equal(calls.at(-1).reasoningEffort,'off')
 llm.resolveModelInfo=async(p,m)=>({reasoning:{efforts:m==='fixture-model'?[{id:'low',name:'Low'},{id:'high',name:'High'}]:[{id:'max',name:'Max'}]}})
 assert.equal((await request(configRoute,{compactReasoningEffort:'default'})).status,200)
 // B 尚未消费，验证默认档位在真实 stream 边界不携带 reasoningEffort。
 markers.B.__compact__.at='old-B'
 const b=await request(route,{workspace:'B',expectedAt:'old-B',confirmed:true});assert.equal(b.status,200)
 assert.equal(Object.hasOwn(calls[3],'reasoningEffort'),false)
 assert.equal((await request(configRoute,{compactModel:'second-model'})).data.compactReasoningEffort,'auto')
 assert.equal((await request(configRoute,{compactReasoningEffort:'high'})).status,400)
 assert.equal((await request(configRoute,{compactReasoningEffort:'max'})).status,200)
 llm.resolveModelInfo=async()=>{throw new Error('secret upstream failure')}
 const beforeConfig=readFileSync(join(plugin,'config.json'),'utf8')
 assert.equal((await request(configRoute,{compactReasoningEffort:'max'})).status,400)
 assert.equal(readFileSync(join(plugin,'config.json'),'utf8'),beforeConfig)
 verdict=401;assert.equal((await request('/api/wb-memory/reasoning',undefined,'GET')).status,401)
 verdict=undefined;assert.equal((await request('/wb-memory/reasoning',undefined,'GET')).status,410)
 assert.equal((await request('/api/wb-memory/reasoning',{})).status,405)
 assert.ok(calls.every(c=>!Object.hasOwn(c,'maxTokens')),'all manual reasoning policies must keep plugin cap omitted')
 console.log('compact-reasoning-route: capability/config/model-switch/default/high/auth/failure passed')
}finally{delete globalThis.__wbMemoryLlm;delete globalThis.__wbMemoryCtx;rmSync(root,{recursive:true,force:true})}