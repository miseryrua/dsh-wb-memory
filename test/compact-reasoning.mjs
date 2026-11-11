import assert from 'node:assert/strict'
import { compactReasoningInfo, compactReasoningOption } from '../lib/compact-reasoning.js'
const fixture = ids => ({ resolveModelInfo: async () => ({ reasoning: { efforts: ids.map(id => ({ id, name: id })) } }) })
for (const explicit of [true, false]) {
  for (const choice of ['auto', undefined]) {
    assert.equal(await compactReasoningOption(fixture(['low','off','high']), 'p','m',choice,explicit), 'off', 'auto must disable thinking when advertised')
    assert.equal(await compactReasoningOption(fixture(['low','high']), 'p','m',choice,explicit), undefined, 'auto must not fall back to low')
    assert.equal(await compactReasoningOption(fixture([]), 'p','m',choice,explicit), undefined)
    assert.equal(await compactReasoningOption({}, 'p','m',choice,explicit), undefined)
    assert.equal(await compactReasoningOption({resolveModelInfo:async()=>{throw Error('lookup')}}, 'p','m',choice,explicit), undefined)
  }
}
assert.equal(await compactReasoningOption(fixture(['off','low']), 'p','m','default',true), undefined)
assert.equal(await compactReasoningOption(fixture(['off','low']), 'p','m','low',true), 'low')
await assert.rejects(compactReasoningOption(fixture(['low']), 'p','m','off',true), /reasoning-unavailable/)
assert.deepEqual((await compactReasoningInfo(fixture(['off','off','auto','default']), 'p','m')).efforts.map(e=>e.id), ['off'])
console.log('compact-reasoning: auto off / no low fallback / inherited model / unknown capability / explicit policy passed')
