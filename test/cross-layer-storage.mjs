import assert from 'node:assert/strict'
import {createRecallDiagnostics} from '../lib/recall-diagnostics.js'
const store=createRecallDiagnostics()
const source={sourceId:'today-1',layer:'today',label:'日志',excerpt:'secret_excerpt',text:'secret_body',sessionId:'secret_session'}
const row={workspace:'A',crossLayer:{findings:[{kind:'inactive-reference',left:source,right:{...source,layer:'inactive'},reason:'secret_body',query:'secret_query'}],scannedSources:2,scannedChars:100,comparedPairs:1,extra:'secret_body'}}
store.record(row)
const actual=store.snapshot('A')
assert.ok(!JSON.stringify(actual).includes('secret_'))
assert.equal(actual.crossLayer.findings.length,1)
assert.equal(actual.crossLayer.scope,'final-assembled-text')
const preview=store.sanitize(row,{includeEvidence:true})
assert.equal(preview.crossLayer.findings[0].left.excerpt,'secret_excerpt')
assert.ok(!JSON.stringify(preview).includes('secret_body'))
preview.crossLayer.findings[0].left.excerpt='changed'
assert.ok(!JSON.stringify(store.snapshot('A')).includes('changed'))
assert.equal(store.snapshot('B'),null)
const capped=store.sanitize({crossLayer:{findings:Array(50).fill(row.crossLayer.findings[0]),scannedChars:Infinity}},{includeEvidence:true})
assert.equal(capped.crossLayer.findings.length,20);assert.equal(capped.crossLayer.truncated,true);assert.equal(capped.crossLayer.scannedChars,0)
store.clear();assert.equal(store.snapshot('A'),null)
console.log('cross-layer-storage: 10 passed')
