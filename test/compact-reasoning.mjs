import assert from 'node:assert/strict'
import { compactReasoningEffort } from '../lib/compact-reasoning.js'
const fixture = ids => ({ resolveModelInfo: async () => ({ reasoning: { efforts: ids.map(id => ({ id, name: id })) } }) })
assert.equal(await compactReasoningEffort(fixture(['low','off','high']), 'p','m'), 'off', '公告 off 档时关闭思考')
assert.equal(await compactReasoningEffort(fixture(['low','high']), 'p','m'), undefined, '未公告 off 时不回落 low')
assert.equal(await compactReasoningEffort(fixture([]), 'p','m'), undefined)
assert.equal(await compactReasoningEffort({}, 'p','m'), undefined, '宿主不提供能力查询')
assert.equal(await compactReasoningEffort({resolveModelInfo:async()=>{throw Error('lookup')}}, 'p','m'), undefined, '查询失败按未公告处理')
assert.equal(await compactReasoningEffort(fixture(['off']), '', 'm'), undefined, '缺少模型路由时不查询')
assert.equal(await compactReasoningEffort({resolveModelInfo:async()=>({reasoning:{efforts:[{id:5},null,{id:'off'}]}})}, 'p','m'), 'off', '畸形档位被跳过')
const aborted = new AbortController(); aborted.abort()
assert.equal(await compactReasoningEffort({resolveModelInfo:()=>new Promise(()=>{})}, 'p','m', aborted.signal), undefined, '已中止时不挂起')
console.log('compact-reasoning: off when advertised / no low fallback / unknown capability / lookup failure / abort passed')
