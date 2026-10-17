import assert from 'node:assert/strict'
import { protectRoute } from '../lib/route-auth.js'
let ran=0, passed=0
const req={headers:{host:'untrusted.invalid'},method:'POST'}
const handler=()=>{ran++;return 'accepted'}
async function check(label,getConnection,expected) {
 let status,body,headers
 const res={writeHead:(s,h)=>{status=s;headers=h},end:b=>body=JSON.parse(b)}
 const before=ran
 await protectRoute(handler,getConnection)(req,res)
 assert.equal(status,expected,label)
 assert.equal(ran,before+(expected===undefined?1:0),label+' handler dispatch')
 if(expected) {assert.equal(headers['Cache-Control'],'no-store');assert.ok(body.error)}
 console.log('PASS '+label);passed++
}
await check('缺少服务默认拒绝',()=>undefined,503)
await check('缺少方法默认拒绝',()=>({}),503)
await check('服务访问异常默认拒绝',()=>{throw Error('private')},503)
await check('认证异常默认拒绝',()=>({requestRejection(){throw Error('secret')}}),503)
for(const invalid of [null,false,true,0,200,'401',Promise.resolve(undefined),Promise.reject(Error('private'))])await check('不合法返回值默认拒绝 '+String(invalid),()=>({requestRejection:()=>invalid}),503)
for(const denied of [401,403])await check('宿主拒绝 '+denied,()=>({requestRejection:r=>{assert.equal(r,req);return denied}}),denied)
await check('宿主明确准入才调处理器',()=>({requestRejection:r=>{assert.equal(r,req);return undefined}}),undefined)
let verdict=undefined
const connection={requestRejection:()=>verdict}
await check('不缓存认证通过',()=>connection,undefined);verdict=401
await check('撤销后下一请求即拒绝',()=>connection,401)
console.log('route-auth: '+passed+' passed')
