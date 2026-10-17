import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=join(dirname(fileURLToPath(import.meta.url)),'..')
const sandbox=join(root,'.tmp','assembly-'+Date.now()), plugin=join(sandbox,'plugin'), wsroot=join(sandbox,'workspaces'), cwd=join(wsroot,'A')
mkdirSync(join(plugin,'lib'),{recursive:true});mkdirSync(join(cwd,'.workbuddy','memory'),{recursive:true})
for(const f of readdirSync(join(root,'lib')))if(f.endsWith('.js'))copyFileSync(join(root,'lib',f),join(plugin,'lib',f))
copyFileSync(join(root,'package.json'),join(plugin,'package.json'))
const cfg={enabled:true,workspaceRoot:wsroot,activeProject:'A',autoDistill:false,sessionSummary:false,memoryHeat:false}
writeFileSync(join(plugin,'config.json'),JSON.stringify(cfg))
writeFileSync(join(plugin,'USER.md'),'画像只供诊断，不得修改。')
writeFileSync(join(cwd,'.workbuddy','memory','PINNED.md'),'# 置顶\n- [2026-01-01] 发布前必须确认回滚方案。')
writeFileSync(join(cwd,'.workbuddy','memory','MEMORY.md'),['## 发布回滚', '发布回滚需要先确认版本与告警。'.repeat(700),'## 夜间备份','夜间备份每天03:20执行。'].join('\n'))
const idx=await import(pathToFileURL(join(plugin,'lib','index.js')))
// 由尚未加入第三批接线的0.12.1组装器生成；仅归一隔离沙箱绝对路径。
const expected=["3017094a79f48f5c0347a1825796164eb19dbbd61f2ebc01052051decdc7fb2f","99e00aa76563cb73573cb4dc22353c4064baeabcafcf7ddf1ed5177119d63b07","ac056cec5157b3314a5dc0998fd98c4bce65bd8db6e2295e4b3e0504a173dfca","99e00aa76563cb73573cb4dc22353c4064baeabcafcf7ddf1ed5177119d63b07","c40eae57db562188ab96b78a2a75a240cb75bd2c348a126d8b2a3be6b025e478","99e00aa76563cb73573cb4dc22353c4064baeabcafcf7ddf1ed5177119d63b07","c40eae57db562188ab96b78a2a75a240cb75bd2c348a126d8b2a3be6b025e478","99e00aa76563cb73573cb4dc22353c4064baeabcafcf7ddf1ed5177119d63b07"]
let i=0
for(const dynamicBudget of [true,false])for(const injectionMaxChars of [4000,12000])for(const query of ['发布回滚','']){
 const c={...cfg,dynamicBudget,injectionMaxChars};const context={messages:[{role:'user',content:query}]}
 const plain=idx.buildMemoryBlock(cwd,context,c);let trace
 assert.equal(idx.buildMemoryBlock(cwd,context,c,r=>trace=r),plain)
 assert.equal(idx.buildMemoryBlock(cwd,context,c,()=>{throw Error('observer')}),plain)
 const hash=createHash('sha256').update(plain.replaceAll(sandbox,'<sandbox>').replaceAll(String.fromCharCode(92),'/')).digest('hex')
 assert.equal(hash,expected[i],JSON.stringify({dynamicBudget,injectionMaxChars,query}))
 i++
}
console.log('assembly-v013: '+i+' frozen-baseline cases passed')
