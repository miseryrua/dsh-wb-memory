// Lead补验：只读开发副本，用临时目录与假模型，不接触真实记忆。
import {mkdtempSync,mkdirSync,readFileSync,existsSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const {installSessionSummary,recoverPendingSummaries,countSummariesToday,bufferSnapshotKey}=await import(process.env.WB_SUMMARY_TEST_SRC || '../lib/summary.js')
import {updatePendingSession} from '../lib/summary-store.js'
const root=join(dirname(fileURLToPath(import.meta.url)),'../.tmp');mkdirSync(root,{recursive:true})
const pause=ms=>new Promise(r=>setTimeout(r,ms))
let seq=0, failures=0
const keepAlive=setInterval(()=>{},1000) // 小结定时器unref，测试需独立存活锚点
function fixture(call) {
 const dir=mkdtempSync(join(root,'summary-host-'));let listener, day='2020-01-01', calls=0
 const cfg={enabled:true,sessionSummary:true,summaryIdleMs:15,summaryMinUserChars:10,summaryMaxPerDay:8,summaryRetryBackoffBaseMs:10}
 const api={readConfig:()=>cfg,digestClip:(s,n)=>String(s).slice(0,n),digestTextOf:s=>String(s||''),resolveActiveProject:()=> '隔离',memoryDirOf:()=>dir,listMemoryDirs:()=>[dir],logicalDayStamp:()=>day,distillConfig:()=>({model:'mock'}),getLlm:()=>({}),distillCallLlm:async()=>{calls++;return await call(calls)}}
 const dispose=installSessionSummary({on:(ev,fn)=>{listener=fn;return()=>{}}},api)
 const session={id:'lead-'+(++seq),header:{cwd:dir}}
 const emit=(type,data,s=session)=>listener(s,{type,data})
 const user=(s=session)=>emit('user/message',{role:'user',source:{kind:'user'},content:'用户有效内容足够长'.repeat(3)},s)
 const turn=(s=session)=>emit('turn/end',{reason:{kind:'completed'}},s)
 return {dir,cfg,api,dispose,session,emit,user,turn,get calls(){return calls},set day(v){day=v}}
}
function check(ok,label){console.log((ok?'PASS ':'FAIL ')+label);if(!ok)failures++}
process.env.WB_SUMMARY_PERSIST_DELAY_MS='0'
process.env.WB_SUMMARY_BACKOFF_BASE_MS='10'
process.env.WB_SUMMARY_RETRY_TIMER_CAP_MS='30'
{
 const f=fixture(async n=>{if(n===1)throw Error('mock failure');return '重试成功小结'})
 f.user();f.turn();await pause(85)
 check(f.calls>=2 && countSummariesToday(join(f.dir,'2020-01-01.md'))===1,'失败后当前宿主自动重试，无需重启或新消息')
 f.dispose()
}
{
 let release,entered;const gate=new Promise(r=>release=r),began=new Promise(r=>entered=r)
 const f=fixture(async()=>{entered();await gate;return '并发小结'})
 f.cfg.summaryMaxPerDay=1
 const other={id:f.session.id+'-other',header:f.session.header}
 f.user();f.turn();f.user(other);f.turn(other);await began;await pause(25);release();await pause(25)
 check(countSummariesToday(join(f.dir,'2020-01-01.md'))<=1,'同工作区不同会话并发仍严格遵守每日上限')
 f.dispose()
}
{
 const f=fixture(async()=> '不该调用')
 const buffer={userTexts:['足够长但是还没完成轮次的用户输入'],lastAssistants:[]}
 updatePendingSession(f.dir,{sessionId:f.session.id,workspace:'隔离',dir:f.dir,logicalDay:'2020-01-01',turn:0,inputVersion:1,snapshotKey:bufferSnapshotKey(buffer),buffer,state:'pending',updatedAt:new Date().toISOString()})
 await recoverPendingSummaries(f.api)
 check(f.calls===0,'崩溃前尚未完成的轮次不能直接恢复小结')
 f.dispose()
}
{
 const f=fixture(async()=> '原逻辑日小结')
 f.user();f.turn();await pause(5);f.day='2020-01-02';await pause(40)
 check(existsSync(join(f.dir,'2020-01-01.md'))&&!existsSync(join(f.dir,'2020-01-02.md')),'空闲跨逻辑日仍提交到最后完成轮次的原日')
 f.dispose()
}
{
 let release,entered;const gate=new Promise(r=>release=r),began=new Promise(r=>entered=r)
 const f=fixture(async n=>{if(n===1){entered();await gate}return '版本'+n+'小结'})
 f.user();f.turn();await began
 f.user();f.emit('assistant/message',{message:{content:'后续轮次助手输出'}});f.turn();await pause(25);release();await pause(65)
 check(f.calls>=2,'推理期间完成新轮次，结束后自动总结新版本')
 f.dispose()
}
{
 let release,entered;const gate=new Promise(r=>release=r),began=new Promise(r=>entered=r)
 const f=fixture(async()=>{entered();await gate;return '已禁用不得写入'})
 f.user();f.turn();await began;f.cfg.enabled=false;release();await pause(25)
 check(!existsSync(join(f.dir,'2020-01-01.md')),'推理期间关闭总开关，返回结果不得继续落盘')
 f.dispose()
}
{
 const f=fixture(async n=>{if(n===1)throw Error('recovery failed once');return '恢复重试成功'})
 const buffer={userTexts:['足够长的已完成轮次输入，用于恢复重试'],lastAssistants:[]}
 updatePendingSession(f.dir,{sessionId:f.session.id,workspace:'隔离',dir:f.dir,logicalDay:'2020-01-01',turn:1,completed:true,idleSince:Date.now()-1000,inputVersion:1,snapshotKey:bufferSnapshotKey(buffer),buffer,state:'pending',updatedAt:new Date().toISOString()})
 await recoverPendingSummaries(f.api);await pause(85)
 check(f.calls>=2 && countSummariesToday(join(f.dir,'2020-01-01.md'))===1,'恢复失败后保留完整轮次字段并可自动重试')
 f.dispose()
}
{
 const f=fixture(async()=> '绝不执行')
 const buffer={userTexts:['足够长的已完成输入但日期非法'],lastAssistants:[]}
 updatePendingSession(f.dir,{sessionId:f.session.id,workspace:'隔离',dir:f.dir,logicalDay:'../escape',turn:1,completed:true,idleSince:Date.now()-1000,inputVersion:1,snapshotKey:bufferSnapshotKey(buffer),buffer,state:'pending',updatedAt:new Date().toISOString()})
 const out=await recoverPendingSummaries(f.api)
 check(f.calls===0 && out.dropped===1,'拒绝恢复非法日期，不能逃逸工作区记忆目录')
 f.dispose()
}
clearInterval(keepAlive)
console.log('summary-host-v010: '+failures+' failures');if(failures)process.exitCode=1
