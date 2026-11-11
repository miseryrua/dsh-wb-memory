import assert from 'node:assert/strict'
import {readFileSync, existsSync} from 'node:fs'
const source = readFileSync(new URL('../lib/index.js',import.meta.url),'utf8')
const statusModule = new URL('../lib/compact-status.js',import.meta.url)
const compactStatus = existsSync(statusModule) ? (await import(statusModule)).compactStatus : undefined
const start = source.indexOf('    const comp = done.__compact__ || null')
const end = source.indexOf('    const countEntries =', start)
assert.ok(start > 0 && end > start)
const project = new Function('done','compactStatus',source.slice(start,end)+';return compact')
const result = project({__compact__:{day:'2026-10-20',at:'2026-10-20T01:12:15.615Z',ok:false,error:'llm finish: truncated (max-tokens)',before:27715,target:9600}},compactStatus)
assert.equal(result.errorCode,'llm-truncated','真实旧失败记录必须透出受控错误码')
assert.match(result.errorMessage,/截断/)
assert.equal(result.lastAt,'2026-10-20T01:12:15.615Z')
assert.equal(result.maxTokens,null,'旧记录预算未知，不伪造当前配置')
assert.equal(result.after,null,'没有完整输出不能显示0字符')
assert.equal(result.rounds,null,'旧异常记录实际轮数未知')
for(const [error,code] of [['llm finish: aborted (timeout)','timeout'],['Bearer TOP_SECRET api_key=password','unknown-error']]) {
 const v = project({__compact__:{ok:false,error}},compactStatus)
 assert.equal(v.errorCode,code); assert.ok(!JSON.stringify(v).includes('TOP_SECRET'));assert.ok(!JSON.stringify(v).includes('password'))
}
const v = project({__compact__:{ok:false,checks:{nonEmpty:true,shorter:false,lifecyclePreserved:false},retryError:'llm finish: truncated (max-tokens)',rounds:2}},compactStatus)
assert.equal(v.errorCode,'llm-truncated');assert.deepEqual(v.failedChecks,['shorter','lifecyclePreserved']);assert.match(v.retryError,/截断/)
assert.equal(project({},compactStatus),null)
assert.equal(project({__compact__:{ok:false,day:'2026-10-20'}},compactStatus).stage,null,'没有证据的旧失败阶段应显示未知')
assert.equal(result.tokenBudget,null,'旧记录不能被伪造为手动无上限')
const manual=project({__compact__:{ok:false,errorCode:'llm-truncated',tokenBudget:'provider-default',maxTokens:8000}},compactStatus)
assert.equal(manual.tokenBudget,'provider-default');assert.equal(manual.maxTokens,null,'手动模式不应显示配置预算')
assert.equal(project({__compact__:{ok:true,tokenBudget:'configured',maxTokens:4000}},compactStatus).maxTokens,4000)
console.log('整理状态投影回归通过')
