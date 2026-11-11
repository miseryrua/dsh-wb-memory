import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
const root=mkdtempSync(join(tmpdir(),'wb-manual-route-'))
try {
 const plugin=join(root,'plugin'),wsroot=join(root,'ws');mkdirSync(join(plugin,'lib'),{recursive:true})
 for(const f of readdirSync(new URL('../lib/',import.meta.url)))if(f.endsWith('.js'))copyFileSync(new URL('../lib/'+f,import.meta.url),join(plugin,'lib',f))
 writeFileSync(join(plugin,'package.json'),JSON.stringify({type:'module'}))
 const cfg={enabled:true,workspaceRoot:wsroot,activeProject:'A',autoDistill:false,autoCompact:false,memoryCharThreshold:12000,compactProvider:'fixture',compactModel:'fixture-model',compactMaxTokens:8000,distillMaxTokens:37,memoryHeat:false}
 writeFileSync(join(plugin,'config.json'),JSON.stringify(cfg))
 const raw='# 长期记忆\n\n<!-- tags: 测试 / date: 2020-01-01 / importance: high -->\n## 重要事实\n'+'重复说明。'.repeat(200)+'\n'
 const hash=text=>createHash('sha256').update(text).digest('hex'),memory=ws=>join(wsroot,ws,'.workbuddy','memory','MEMORY.md')
 for(const ws of ['A','B']){mkdirSync(join(wsroot,ws,'.workbuddy','memory'),{recursive:true});writeFileSync(memory(ws),raw)}
 const markers={A:{'2020-01-01':{added:3}},B:{__compact__:{at:'old-B',ok:false}}};writeFileSync(join(plugin,'distilled.json'),JSON.stringify(markers))
 let verdict=401,mode='truncated',calls=[],release,entered
 const enteredPromise=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),routes=new Map()
 const llm={listProviders:()=>['fixture'],stream:async function*(o){calls.push(o);if(mode==='blocked'){entered();await gate}if(mode==='ok'){yield {type:'text-delta',text:'# 长期记忆\n\n<!-- tags: 测试 / date: 2020-01-01 / importance: high -->\n## 重要事实\n保留事实。\n'};yield {type:'finish',reason:'stop'}}else yield {type:'finish',reason:'max-tokens'}}}
 const host={connection:{requestRejection:()=>verdict},webServer:{register:r=>routes.set(r.path,r.handler)},effect:fn=>fn()}
 const idx=await import(pathToFileURL(join(plugin,'lib/index.js')));idx.apply({inject:(deps,fn)=>{if(deps.includes('webServer'))fn(host);else if(deps.includes('llm'))fn({llm})},effect:()=>{}})
 async function request(path,body,method='POST',origin='http://localhost:3190'){
  const url=new URL(path,'http://localhost:3190'),handler=routes.get(url.pathname);assert.equal(typeof handler,'function','新主动整理API必须注册，而非仅修改按钮')
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{url:path,method,headers:{host:'localhost:3190',origin}})
  let status,data;await handler(req,{writeHead:s=>status=s,end:b=>data=JSON.parse(b)});return {status,data}
 }
 const route='/api/wb-memory/compact-manual',input={workspace:'A',expectedRevision:hash(raw),confirmed:true}
 assert.equal((await request(route,input)).status,401);verdict=403;assert.equal((await request(route,input)).status,403);verdict=undefined
 assert.equal((await request('/wb-memory/compact-manual',input)).status,410)
 assert.equal((await request(route,input,'GET')).status,405);assert.equal((await request(route,input,'POST','http://evil.invalid')).status,403)
 for(const invalid of [{...input,maxTokens:2},{...input,path:memory('B')},{...input,expectedAt:'old'}, {...input,workspace:'unknown'},{...input,confirmed:false},{...input,expectedRevision:null},null,[]])assert.equal((await request(route,invalid)).status,400)
 assert.equal((await request(route,{...input,expectedRevision:'a'.repeat(64)})).status,409);assert.equal(calls.length,0)
 const status=(await request('/api/wb-memory/status?workspace=A',undefined,'GET')).data;assert.equal(status.compactManual.expectedRevision,hash(raw));assert.equal(status.compactManual.running,false)
 const before=JSON.stringify(cfg);let response=await request(route,input);assert.equal(response.status,200);assert.equal(response.data.result.errorCode,'llm-truncated');assert.equal(response.data.result.maxTokens,null);assert.equal(calls.length,1)
 assert.equal(readFileSync(memory('A'),'utf8'),raw);assert.equal(existsSync(join(plugin,'compact-retries')),false,'主动入口不消费旧每日重试凭据')
 response=await request(route,input);assert.equal(response.status,200);assert.equal(calls.length,2,'失败后仍可重新明确点击一次，非自动或日资格')
 mode='blocked';const running=request(route,input);await enteredPromise
 assert.equal((await request('/api/wb-memory/status?workspace=A',undefined,'GET')).data.compactManual.running,true)
 assert.equal((await request(route,input)).data.code,'busy');assert.equal((await request('/api/wb-memory/compact-retry',{workspace:'B',expectedAt:'old-B',confirmed:true})).data.code,'busy');assert.equal(calls.length,3,'主动/旧重试共享运行锁')
 release();await running;mode='ok';response=await request(route,input);assert.ok(response.data.ok);assert.equal(calls.length,4)
 const compacted=readFileSync(memory('A'),'utf8');assert.notEqual(compacted,raw)
 assert.equal((await request(route,input)).data.code,'stale-revision');assert.equal(calls.length,4,'成功后旧正文revision不能重复提交')
 response=await request(route,{...input,expectedRevision:hash(compacted)});assert.equal(response.status,200);assert.ok(calls.length>4 && calls.length<=6,'当日成功也可主动再次整理且最多两请求')
 assert.ok(calls.every(c=>c.provider==='fixture' && c.model==='fixture-model' && !Object.hasOwn(c,'maxTokens')),'手动不回落整理/提炼预算')
 const after=JSON.parse(readFileSync(join(plugin,'distilled.json'),'utf8'));assert.deepEqual(after.B,markers.B);assert.deepEqual(after.A['2020-01-01'],markers.A['2020-01-01']);assert.equal(readFileSync(memory('B'),'utf8'),raw);assert.equal(readFileSync(join(plugin,'config.json'),'utf8'),before)
 writeFileSync(join(plugin,'config.json'),JSON.stringify({...cfg,enabled:false}));assert.equal((await request(route,{...input,expectedRevision:hash(readFileSync(memory('A'),'utf8'))})).data.code,'not-ready')
 console.log('compact-manual-route: 认证/同源/方法/白名单/revision/自动关闭/重复显式点击/共享锁/不消费旧凭据/单工作区/预算/状态 passed')
}finally{delete globalThis.__wbMemoryLlm;delete globalThis.__wbMemoryCtx;assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true})}
