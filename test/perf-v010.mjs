import {performance} from 'node:perf_hooks'
import {retrieveRelevant as current} from '../lib/retrieve.js'
import {retrieveRelevant as legacy} from './fixtures/retrieve-v010-legacy.mjs'
for(const n of [30,100,500]) {
 const md=Array.from({length:n},(_,i)=>'<!-- tags: 案例'+i+' / date: 2026-10-14 / importance: normal -->\n## 案例 '+i+'\n'+(i%10===0?'Windows EPERM 命令沙箱权限定位。':'预算阈值与日志轮次处理的其他记录。').repeat(12)).join('\n\n')
 const query='Windows EPERM 沙箱权限'
 const result={entries:n,chars:md.length}
 for(const [name,fn] of [['legacy',legacy],['current',current]]) {
  fn(md,query); const samples=[]
  for(let k=0;k<15;k++){const t=performance.now();fn(md,query);samples.push(performance.now()-t)}
  samples.sort((a,b)=>a-b);result[name]={medianMs:Number(samples[7].toFixed(2)),p95Ms:Number(samples[14].toFixed(2))}
 }
 console.log(JSON.stringify(result))
}
