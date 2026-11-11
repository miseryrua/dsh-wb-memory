import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const { retryCompact, reserveCompactRetry } = await import('../lib/compact-retry.js')
const root=mkdtempSync(join(tmpdir(),'wb-retry-'))
let passed=0
const last={day:'2026-10-20',at:'2026-10-20T01:00:00Z',ok:false,error:'llm-truncated'}
let calls=0, saved=0, state={running:false}, markers={A:{__compact__:last,log:{ok:true}},B:{__compact__:last}}
const input={workspace:'A',expectedAt:last.at,confirmed:true}
const deps={state,day:'2026-10-20',workspaces:['A','B'],ready:true,readMarkers:()=>structuredClone(markers),reserve:(ws,old)=>reserveCompactRetry(root,'2026-10-20',ws,old),compact:async(ws,m)=>{calls++;assert.equal(ws,'A');assert.equal(m.A.__compact__,undefined);assert.deepEqual(m.B.__compact__,last);m.A.__compact__={...last,at:'new',ok:true};return {ok:true}},save:async(ws,m)=>{saved++;markers[ws]=m[ws]}}
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
async function rejects(body,code,overrides={}){await assert.rejects(()=>retryCompact(body,{...deps,...overrides}),e=>e.code===code)}
try{
 await test('未知工作区/未确认/额外参数均零调用',async()=>{await rejects({...input,workspace:'../B'},'invalid-request');await rejects({...input,confirmed:false},'invalid-request');await rejects({...input,maxTokens:99999},'invalid-request');assert.equal(calls,0)})
 await test('忙锁/未就绪不消费凭据',async()=>{await rejects(input,'busy',{state:{running:true}});await rejects(input,'not-ready',{ready:false});assert.equal(calls,0)})
 await test('过期页面和成功记录不得重试',async()=>{await rejects({...input,expectedAt:'stale'},'stale-record');await rejects(input,'not-failed',{readMarkers:()=>({A:{__compact__:{...last,ok:true}}})})})
 await test('一次仅整理指定工作区并保留其他标记',async()=>{assert.equal((await retryCompact(input,deps)).ok,true);assert.equal(calls,1);assert.equal(saved,1);assert.equal(state.running,false);assert.deepEqual(markers.B.__compact__,last);assert.deepEqual(markers.A.log,{ok:true})})
 await test('新页面和重启后同日仍拒绝重复',async()=>{markers.A.__compact__=last;await rejects(input,'already-used',{state:{running:false}});assert.equal(calls,1)})
 await test('凭据写失败零调用并解锁',async()=>{await rejects({...input,workspace:'B'},'receipt-failed',{reserve:()=>{throw Error('disk full')}});assert.equal(state.running,false);assert.equal(calls,1)})
 await test('异常不恢复额度且不清磁盘日锁',async()=>{const d={...deps,reserve:(ws,old)=>reserveCompactRetry(root,'2026-10-21',ws,old),compact:async()=>{throw Error('secret')}};await assert.rejects(()=>retryCompact(input,d),e=>e.code==='attempt-failed'&&!e.message.includes('secret'));await rejects(input,'already-used',d);assert.deepEqual(markers.A.__compact__,last)})
 await test('持久化失败不允许再调用',async()=>{const d={...deps,reserve:(ws,old)=>reserveCompactRetry(root,'2026-10-22',ws,old),save:async()=>{throw Error('write fail')}};await rejects(input,'attempt-failed',d);await rejects(input,'already-used',d)})
 await test('冲突和无需整理保留原失败记录',async()=>{for(const result of [null,{ok:false,conflict:true}]){let output;const d={...deps,reserve:()=>{},compact:async(ws,m)=>{m[ws].__compactConflict__={at:'new'};return result},save:async(ws,m)=>{output=m[ws]}};await retryCompact(input,d);assert.deepEqual(output.__compact__,last)}})
 await test('并发点击第二个被忙锁挡住',async()=>{let release;const wait=new Promise(r=>release=r);const d={...deps,reserve:()=>{},compact:async()=>{await wait;return null}};const p=retryCompact(input,d);await rejects(input,'busy');release();await p})
 console.log('compact-retry: '+passed+' passed')
}finally{rmSync(root,{recursive:true,force:true})}
