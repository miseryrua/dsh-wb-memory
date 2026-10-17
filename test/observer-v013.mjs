import assert from 'node:assert/strict'
import { observeCrossLayer } from '../lib/cross-layer-observer.js'
import { runRecallEvaluation } from '../lib/recall-eval-view.js'
import { migrateMemory, applyMemoryAction, inspectMemory } from '../lib/memory-lifecycle.js'
let n=0;const test=(name,fn)=>{fn();n++;console.log('PASS '+name)}
const md='## 夜间备份约定\n每天03:20执行备份并检查回滚副本。\n'
const managed=migrateMemory(md).text, parsed=inspectMemory(managed), id=parsed.records[0].meta.id
const inactive=applyMemoryAction(managed,{action:'retract',id,reason:'合成撤回',revision:parsed.revision}).text
const block='### 今日日志（合成）\n每天03:20执行备份并检查回滚副本。\n'
test('退场参照命中最终日志',()=>assert.ok(observeCrossLayer(block,inactive).findings.some(f=>f.kind==='inactive-reference'&&f.left.sourceId===id&&f.right.layer==='today')))
test('未注入current整库候选不冒充最终来源',()=>assert.equal(observeCrossLayer(block,managed).findings.length,0))
test('分析故障不阻断组装',()=>assert.equal(observeCrossLayer(block,managed,()=>{throw Error('故障')}).degraded,true))
test('无最终来源不凭整库捏造注入',()=>assert.equal(observeCrossLayer('## 记忆纪律\n不做事实裁决',inactive).findings.length,0))
for(const k of [1,3,5])test('合成评测目标全部逐案展示 k='+k,()=>{const r=runRecallEvaluation(k);assert.equal(r.baselineK,5);assert.equal(r.candidateK,k);assert.equal(r.baseline.cases.length,26);assert.ok(r.baseline.cases.some(c=>!c.passed));assert.ok(r.baseline.cases.every(c=>typeof c.passed==='boolean'));assert.equal(r.baseline.summary.passed,r.baseline.cases.filter(c=>c.passed).length)})
test('不接受其它候选参数',()=>assert.throws(()=>runRecallEvaluation(0)))
console.log('observer-v013: '+n+' passed')
