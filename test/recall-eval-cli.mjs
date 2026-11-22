import { runRecallEvaluation } from './recall-eval-lib.mjs'

const args = process.argv.slice(2)
if (args.length > 1 || !['1', '3', '5'].includes(args[0] ?? '1')) {
  console.error('用法：node test/recall-eval-cli.mjs [1|3|5]（默认 1）')
  process.exitCode = 1
} else {
  const result = runRecallEvaluation(Number(args[0] ?? 1))
  for (const [label, k, side] of [['基线', result.baselineK, result.baseline], ['候选', result.candidateK, result.candidate]]) {
    const { passed, caseCount, expectedHits, expectedTotal, forbiddenHits } = side.summary
    console.log(label + ' K=' + k + '：通过 ' + passed + '/' + caseCount + '，期望命中 ' + expectedHits + '/' + expectedTotal + '，禁选命中 ' + forbiddenHits)
  }
}
