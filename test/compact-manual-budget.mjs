import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = mkdtempSync(join(tmpdir(), 'wb-manual-budget-'))
try {
  const plugin = join(root, 'plugin')
  mkdirSync(join(plugin, 'lib'), { recursive: true })
  for (const f of readdirSync(new URL('../lib/', import.meta.url))) if (f.endsWith('.js')) copyFileSync(new URL('../lib/' + f, import.meta.url), join(plugin, 'lib', f))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }))
  const { compactMemoryIfOver } = await import(pathToFileURL(join(plugin, 'lib/index.js')))
  const large = '# 项目长期记忆\n\n' + Array.from({ length: 12 }, (_, i) => '<!-- tags: 测试 / date: 2020-01-01 / importance: high -->\n## 条目' + i + '\n' + '事实'.repeat(900) + '\n\n').join('')
  const cfg = { memoryCharThreshold: 12000, compactModel: 'fixture', compactProvider: 'fixture', compactMaxTokens: 1 }
  async function run(name, tokenBudget, mode = 'ok', config = cfg, raw = large) {
    const dir = join(root, name); mkdirSync(dir); writeFileSync(join(dir, 'MEMORY.md'), raw)
    if (mode === 'backup-failed') writeFileSync(join(dir, 'archive'), 'not a directory')
    const calls = [], markers = {}
    const llm = { stream: async function* (o) {
      calls.push(o)
      const input = JSON.parse(o.messages[0].content[0].text.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text
      const headings = [...new Set([...input.matchAll(/^## (条目\d+|单条)/gm)].map(m => m[1]))] // 去重：重试轮输入附带上次输出，同一标题出现两次，旧假模型会输出重复条目（被条目数护栏 noEntryGrowth 拒收）
      if (mode === 'timeout') { await new Promise(resolve => o.signal.addEventListener('abort', resolve, { once: true })); yield { type: 'finish', reason: 'stop' }; return }
      let text = '# 项目长期记忆\n\n' + headings.map(h => '<!-- tags: 测试 / date: 2020-01-01 / importance: high -->\n## ' + h + '\n保留关键事实。\n\n').join('')
      if (mode === 'feedback' && calls.length === 1) text += '较长内容。'.repeat(300)
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: mode === 'truncated' && calls.length === 2 ? 'max-tokens' : 'stop' }
    } }
    const dc = { provider: 'distill-provider', model: 'distill-model', maxTokens: 37, timeoutMs: mode === 'timeout' ? 10 : 1000 }
    const result = await compactMemoryIfOver(llm, config, dc, name, dir, markers, { force: tokenBudget === 'provider-default' })
    return { calls, markers, result, dir, raw }
  }
  const manual = await run('manual', 'provider-default')
  assert.equal(manual.result.ok, true); assert.equal(manual.calls.length, 2)
  assert.ok(manual.calls.every(c => !Object.hasOwn(c, 'maxTokens')), 'both manual batches must omit plugin cap, not fall back to distill 37')
  assert.equal(manual.result.tokenBudget, 'provider-default'); assert.equal(manual.result.maxTokens, null)
  assert.equal(manual.markers.manual.__compact__.maxTokens, null)
  assert.equal((readFileSync(join(manual.dir, 'MEMORY.md'), 'utf8').match(/^## /gm) || []).length, 12)
  assert.equal(cfg.compactMaxTokens, 1, 'manual retry must not mutate automatic configuration')
  const tiny = await run('tiny-auto', 'configured')
  assert.equal(tiny.calls.length, 0); assert.ok(tiny.result.sink.count > 0)
  const bad = await run('truncated', 'provider-default', 'truncated')
  // 逐批兜底（任务 A 评审）：第二批截断 → 该批回退原文、第一批结果保留；截断的残缺输出绝不写入
  assert.equal(bad.calls.length, 2); assert.equal(bad.result.ok, true); assert.equal(bad.result.fallbackBatches, 1); assert.equal(bad.result.fallbackError, 'llm-truncated')
  const badAfter = readFileSync(join(bad.dir, 'MEMORY.md'), 'utf8')
  assert.ok(badAfter.length < bad.raw.length && badAfter.includes('事实'.repeat(900)), 'truncated batch falls back to original text, never partial model output')
  assert.equal(await compactMemoryIfOver({}, cfg, {}, 'truncated', bad.dir, bad.markers), null, 'failed manual operation still records logical day lock')
  const single = '# 项目长期记忆\n\n## 单条\n' + '事实'.repeat(2500)
  const feedback = await run('feedback', 'provider-default', 'feedback', { ...cfg, memoryCharThreshold: 1000 }, single)
  assert.ok(feedback.result.ok); assert.equal(feedback.calls.length, 2)
  assert.ok(feedback.calls.every(c => !Object.hasOwn(c, 'maxTokens')), 'feedback rewrite must also stay uncapped')
  const backup = await run('backup', 'provider-default', 'backup-failed')
  assert.equal(backup.calls.length, 0); assert.equal(backup.result.errorCode, 'backup-failed'); assert.equal(backup.result.tokenBudget, 'provider-default')
  const timeout = await run('timeout', 'provider-default', 'timeout')
  assert.equal(timeout.calls.length, 1); assert.equal(timeout.result.errorCode, 'timeout')
  assert.equal(readFileSync(join(timeout.dir, 'MEMORY.md'), 'utf8'), timeout.raw)
  console.log('compact-manual-budget: manual/auto/both-batches/feedback/truncation/day-lock/backup/timeout passed')
} finally { rmSync(root, { recursive: true, force: true }) }
