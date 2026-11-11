import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const root=mkdtempSync(join(tmpdir(),'wb-compact-'))
try {
 const plugin=join(root,'plugin');mkdirSync(join(plugin,'lib'),{recursive:true})
 for(const f of readdirSync(new URL('../lib/',import.meta.url)))if(f.endsWith('.js'))copyFileSync(new URL('../lib/'+f,import.meta.url),join(plugin,'lib',f))
 writeFileSync(join(plugin,'package.json'),JSON.stringify({type:'module',version:'0.13.0'}))
 const {compactMemoryIfOver}=await import(pathToFileURL(join(plugin,'lib/index.js')))
 const raw='# 项目长期记忆\n\n'+Array.from({length:12},(_,i)=>'<!-- tags: 测试 / date: 2020-01-01 / importance: high -->\n## 条目'+i+'\n'+'事实'.repeat(900)+'\n\n').join('')
 const cfg={memoryCharThreshold:12000,compactModel:'fixture',compactProvider:'fixture',compactMaxTokens:8000}
 async function run(name,mode) {
  const dir=join(root,name);mkdirSync(dir);writeFileSync(join(dir,'MEMORY.md'),raw)
  const calls=[],markers={}
  const llm={stream:async function*(o){calls.push(o);const index=calls.length
   const input=JSON.parse(o.messages[0].content[0].text.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text
   const headings=[...input.matchAll(/^## (条目\d+)/gm)].map(m=>m[1])
   if(mode==='append')writeFileSync(join(dir,'MEMORY.md'),raw+'\n## 并发新事实\n不得丢失\n')
   const text='# 项目长期记忆\n\n'+headings.map(h=>'## '+h+'\n关键事实。\n\n').join('')
   yield {type:'reasoning-delta',text:'abc'};yield {type:'text-delta',text}
   yield {type:'finish',reason:mode==='truncated' && index===2 ? 'max-tokens' : 'stop'}
  }}
  const result=await compactMemoryIfOver(llm,cfg,{provider:'fixture',model:'fixture',timeoutMs:1000},name,dir,markers)
  return {dir,calls,markers,result}
 }
 const good=await run('good','ok')
 assert.equal(good.calls.length,2,'大记忆按完整条目预分两批，不再整篇请求')
 assert.ok(good.result.ok);assert.equal(good.result.batches,2);assert.equal(good.result.totalCalls,2)
 assert.ok(good.calls.reduce((n,c)=>n+c.maxTokens,0)<=8000,'总生成预算不得因分批膨胀')
 assert.ok(good.calls.every(c=>c.maxTokens===4000))
 assert.equal(good.result.reasoningChars,6);assert.ok(good.result.outputChars>0)
 assert.equal((readFileSync(join(good.dir,'MEMORY.md'),'utf8').match(/^## /gm)||[]).length,12)
 const bad=await run('bad','truncated');assert.equal(bad.result.ok,false);assert.equal(bad.result.errorCode,'llm-truncated');assert.equal(bad.calls.length,2)
 assert.equal(readFileSync(join(bad.dir,'MEMORY.md'),'utf8'),raw,'第二批截断不得部分写回')
 const again=await compactMemoryIfOver({},cfg,{},'bad',bad.dir,bad.markers);assert.equal(again,null,'失败仍保留日锁')
 const changed=await run('changed','append');assert.match(readFileSync(join(changed.dir,'MEMORY.md'),'utf8'),/并发新事实/)
 console.log('安全分批与截断回归通过')
}finally{rmSync(root,{recursive:true,force:true})}
