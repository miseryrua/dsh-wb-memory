import { BUILTIN_RECALL_CASES, evaluateRecall } from './recall-eval.js'
import { rankMemory } from './retrieve.js'

// 此处对observe案例也展示目标是否满足，不能用测试的宽松断言隐藏薄弱项。
export function runRecallEvaluation(candidateK = 1) {
  if (![1,3,5].includes(candidateK)) throw new RangeError('candidateK仅允许1、3或5')
  const side = k => {
    const raw = evaluateRecall(BUILTIN_RECALL_CASES, (md,q,opts) => rankMemory(md,q,{...opts,k}))
    const cases = raw.perCase.map((r,i) => {
      const c = BUILTIN_RECALL_CASES[i], selectedTitles = r.returnedTitles || []
      const missedTitles = r.error ? c.expectedTitles.slice() : r.missed || []
      const forbiddenHits = r.forbiddenReturned || []
      const unexpectedTitles = selectedTitles.filter(t => !c.expectedTitles.includes(t))
      const passed = !r.error && !missedTitles.length && !forbiddenHits.length && !unexpectedTitles.length && (c.expectEmpty ? selectedTitles.length === 0 : c.expectedTitles.includes(selectedTitles[0]))
      return { id:c.id, query:c.query, passed, selectedTitles, missedTitles, forbiddenHits, unexpectedTitles, error:r.error || null, expectation:c.expectEmpty?'empty':'top1-and-expected', candidateChars:r.candidateChars || 0 }
    })
    return { summary:{caseCount:cases.length, passed:cases.filter(c=>c.passed).length, expectedHits:raw.summary.hitTotal, expectedTotal:raw.summary.expectedTotal, forbiddenHits:cases.reduce((n,c)=>n+c.forbiddenHits.length,0)}, cases }
  }
  return { baselineK:5, candidateK, baseline:side(5), candidate:side(candidateK), synthetic:true }
}
