// 0.14.2 精简回归：已移除的路由不再注册；旧配置里退役的四个字段被忽略并在写回时去掉。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
const root=mkdtempSync(join(tmpdir(),'wb-slim-0142-'))
try {
 const plugin=join(root,'plugin'),wsroot=join(root,'ws');mkdirSync(join(plugin,'lib'),{recursive:true})
 for(const f of readdirSync(new URL('../lib/',import.meta.url)))if(f.endsWith('.js'))copyFileSync(new URL('../lib/'+f,import.meta.url),join(plugin,'lib',f))
 writeFileSync(join(plugin,'package.json'),JSON.stringify({type:'module'}))
 const retired=['gcEnabled','dynamicBudget','memoryHeat','compactReasoningEffort']
 const cfg={enabled:true,workspaceRoot:wsroot,activeProject:'A',autoDistill:false,memoryCharThreshold:12000,compactProvider:'fixture',compactModel:'fixture-model',compactMaxTokens:8000,gcEnabled:false,dynamicBudget:false,memoryHeat:false,compactReasoningEffort:'high'}
 writeFileSync(join(plugin,'config.json'),JSON.stringify(cfg))
 const raw='# 长期记忆\n\n<!-- tags: 测试 / date: 2020-01-01 / importance: high -->\n## 重要事实\n'+'重复说明。'.repeat(200)+'\n'
 const hash=text=>createHash('sha256').update(text).digest('hex'),memory=join(wsroot,'A','.workbuddy','memory','MEMORY.md')
 mkdirSync(join(wsroot,'A','.workbuddy','memory'),{recursive:true});writeFileSync(memory,raw)
 writeFileSync(join(plugin,'distilled.json'),JSON.stringify({}))
 let efforts=[{id:'low',name:'Low'},{id:'high',name:'High'}];const calls=[],routes=new Map()
 const llm={listProviders:()=>['fixture'],resolveModelInfo:async()=>({reasoning:{efforts}}),stream:async function*(o){calls.push(o);yield {type:'finish',reason:'max-tokens'}}}
 const host={connection:{requestRejection:()=>undefined},webServer:{register:r=>routes.set(r.path,r.handler)},effect:fn=>fn()}
 const idx=await import(pathToFileURL(join(plugin,'lib/index.js')));idx.apply({inject:(deps,fn)=>{if(deps.includes('webServer'))fn(host);else if(deps.includes('llm'))fn({llm})},effect:()=>{}})
 async function request(path,body,method='POST',origin='http://localhost:3190'){
  const url=new URL(path,'http://localhost:3190'),handler=routes.get(url.pathname);assert.equal(typeof handler,'function','未注册：'+path)
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{url:path,method,headers:{host:'localhost:3190',origin}})
  let status,data;await handler(req,{writeHead:s=>status=s,end:b=>data=JSON.parse(b)});return {status,data}
 }
 // 1. 路由：三条已移除，其余只挂在 /api 下
 for(const gone of ['compact-retry','reasoning','debug-cwd'])assert.equal(routes.has('/api/wb-memory/'+gone),false,gone+' 路由应已移除')
 for(const kept of ['compact-manual','gc','config','status','cold','memories'])assert.equal(routes.has('/api/wb-memory/'+kept),true,kept+' 路由应保留')
 assert.deepEqual([...routes.keys()].filter(p=>!p.startsWith('/api/')),[],'不再注册无 /api 前缀的旧地址')
 // 2. 思考策略固定：旧配置里的 high 不再生效；未公告 off 不传参数，公告 off 才关闭
 const input={workspace:'A',expectedRevision:hash(raw),confirmed:true}
 let response=await request('/api/wb-memory/compact-manual',input)
 assert.equal(response.status,200);assert.equal(response.data.result.errorCode,'llm-truncated');assert.equal(calls.length,1)
 assert.equal(Object.hasOwn(calls[0],'reasoningEffort'),false,'旧配置 compactReasoningEffort=high 被忽略')
 efforts=[{id:'off',name:'关闭'},{id:'high',name:'High'}]
 response=await request('/api/wb-memory/compact-manual',input);assert.equal(response.status,200);assert.equal(calls.length,2)
 assert.equal(calls[1].reasoningEffort,'off','公告 off 档时关闭思考')
 assert.equal(readFileSync(memory,'utf8'),raw,'截断的整理不改正文')
 // 3. 状态不再带重试凭据字段，也没有创建凭据目录
 const status=(await request('/api/wb-memory/status?workspace=A',undefined,'GET')).data
 assert.equal(Object.hasOwn(status,'compactRetry'),false);assert.equal(typeof status.compactManual.expectedRevision,'string')
 assert.equal(readdirSync(plugin).includes('compact-retries'),false)
 // 4. 治理不再受旧配置 gcEnabled=false 拦截
 const gc=await request('/api/wb-memory/gc',{workspace:'A'})
 assert.equal(gc.status,200);assert.equal(gc.data.ok,true);assert.equal(Object.hasOwn(gc.data,'skipped'),false)
 // 5. 配置：退役字段不可再写入，写回时从磁盘去掉；其余设置照常保存
 assert.equal(JSON.parse(readFileSync(join(plugin,'config.json'),'utf8')).compactReasoningEffort,'high','只读路径不改写配置文件')
 const saved=await request('/api/wb-memory/config',{gcEnabled:false,compactReasoningEffort:'high',dynamicBudget:false,memoryHeat:false,autoDigest:false})
 assert.equal(saved.status,200);assert.equal(saved.data.ok,true)
 const disk=JSON.parse(readFileSync(join(plugin,'config.json'),'utf8'))
 for(const key of retired){assert.equal(Object.hasOwn(disk,key),false,key+' 应从配置文件去掉');assert.equal(Object.hasOwn(saved.data,key),false,key+' 不应出现在响应里')}
 assert.equal(disk.autoDigest,false);assert.equal(disk.compactModel,'fixture-model');assert.equal(disk.memoryCharThreshold,12000)
 console.log('slim-v0142: 路由移除/旧地址不注册/思考策略固定/状态字段/治理不受开关/退役配置清理 passed')
}finally{delete globalThis.__wbMemoryLlm;delete globalThis.__wbMemoryCtx;rmSync(root,{recursive:true,force:true})}
