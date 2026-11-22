import assert from 'node:assert/strict'
import { runRecallEvaluation } from './recall-eval-lib.mjs'
let n=0;const test=(name,fn)=>{fn();n++;console.log('PASS '+name)}
for(const k of [1,3,5])test('合成评测目标全部逐案展示 k='+k,()=>{const r=runRecallEvaluation(k);assert.equal(r.baselineK,5);assert.equal(r.candidateK,k);assert.equal(r.baseline.cases.length,24);assert.ok(r.baseline.cases.some(c=>!c.passed));assert.ok(r.baseline.cases.every(c=>typeof c.passed==='boolean'));assert.equal(r.baseline.summary.passed,r.baseline.cases.filter(c=>c.passed).length)})
test('不接受其它候选参数',()=>assert.throws(()=>runRecallEvaluation(0)))
console.log('observer-v013: '+n+' passed')
