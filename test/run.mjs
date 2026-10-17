import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = ['smoke.mjs', 'recall-regression.mjs', 'distill-regression.mjs', 'retrieve-v010.mjs', 'core-v010.mjs', 'distill-v010.mjs', 'summary-v010.mjs', 'summary-host-v010.mjs', 'summary-v0101.mjs', 'diagnostics-v0102.mjs', 'scheduler-v0103.mjs', 'generation-v0104.mjs', 'parser-v0105.mjs', 'panel-recall.mjs', 'lifecycle.mjs', 'route-auth.mjs', 'injection-sources.mjs', 'assembly-v013.mjs', 'cross-layer-storage.mjs', 'recall-eval.mjs', 'cross-layer-diagnostics.mjs', 'observer-v013.mjs']
for (const file of files) {
  console.log('\n=== ' + file + ' ===')
  const r = spawnSync(process.execPath, [join(root, 'test', file)], { cwd: root, stdio: 'inherit' })
  if (r.error || r.status !== 0) { console.error(r.error || ('测试退出码: ' + r.status)); process.exit(1) }
}
console.log('\n全部' + files.length + '个套件通过。')
