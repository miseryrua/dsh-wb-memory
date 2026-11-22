// 迭代 E：分批整理的批级保真反馈重试（E1）、拒收候选留存（E2）、批级诊断（E3）。
// 全部用自造合成文本与假模型，系统临时目录；不读写真实记忆库、不调用真实模型。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compactStatus } from '../lib/compact-status.js'
import { gcArchive, runGc } from '../lib/governance.js'

const root = mkdtempSync(join(tmpdir(), 'wb-compact-batch-retry-'))
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name) }

const entry = (i, filler) =>
  '<!-- tags: 测试' + i + ' / date: 2026-01-01 / importance: high -->\n## 条目' + i + '\n' +
  '**限定条件** 仅当 `npm run task' + i + ' --force` 在 lib/mod' + i + '/core.js 修改后执行。\n' +
  '配置键 cfgKey' + i + 'Timeout 取 ' + i + '.2.0 版本默认值。\n' +
  '注意：必须先备份再执行，禁止并行；风险：误删不可恢复。\n' +
  '事'.repeat(filler) + '\n\n'
const mk = (n, filler = 650) => '# 项目长期记忆\n\n' + Array.from({ length: n }, (_, i) => entry(i, filler)).join('')
const big = mk(34)
assert.ok(big.length > 18000, 'big=' + big.length)

try {
  const plugin = join(root, 'plugin'); mkdirSync(join(plugin, 'lib'), { recursive: true })
  for (const f of readdirSync(new URL('../lib/', import.meta.url))) if (f.endsWith('.js')) copyFileSync(new URL('../lib/' + f, import.meta.url), join(plugin, 'lib', f))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }))
  const { compactMemoryIfOver } = await import(pathToFileURL(join(plugin, 'lib/index.js')))
  const baseCfg = { memoryCharThreshold: 12000, compactMaxTokens: 16000 }
  const dc = { provider: 'fixture', model: 'fixture', timeoutMs: 1000 }

  const inputOf = o => {
    const full = o.messages[0].content[0].text
    let input = JSON.parse(full.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text
    const prev = input.includes('\n\n--- 上次输出') ? input.split('\n\n--- 上次输出')[1] : null
    input = input.split('\n\n--- 上次输出')[0].replace(/^--- MEMORY\.md 全文 ---\n/, '')
    return { full, input, prev }
  }
  const good = input => input.split('\n').map(l => /^事+$/.test(l) ? l.slice(0, 30) : l).join('\n')
  const lossy = input => good(input).split('\n').filter(l => !/cfgKey/.test(l)).join('\n')
  const isBatch1 = input => /^## 条目0$/m.test(input)
  // transform(input, {b: 批号, k: 该批第几次调用, prev, full}) → 字符串 | {hang:true}
  function makeLlm(transform, calls) {
    const seen = { 1: 0, 2: 0 }
    return { stream: async function* (o) {
      const { input, prev, full } = inputOf(o)
      const b = isBatch1(input) ? 1 : 2, k = ++seen[b]
      calls.push({ b, k, input, prev, full, maxTokens: o.maxTokens })
      const out = transform(input, { b, k, prev, full })
      if (out && out.hang) { await new Promise(r => o.signal.addEventListener('abort', r, { once: true })); yield { type: 'finish', reason: 'stop' }; return }
      yield { type: 'text-delta', text: out }; yield { type: 'finish', reason: 'stop' }
    } }
  }
  let seq = 0
  async function run(transform, { raw = big, config = baseCfg, timeoutMs, name } = {}) {
    name = name || 'ws' + (++seq); const dir = join(root, name)
    if (!existsSync(dir)) mkdirSync(dir)
    const path = join(dir, 'MEMORY.md'); writeFileSync(path, raw)
    const calls = [], markers = {}
    const result = await compactMemoryIfOver(makeLlm(transform, calls), config, timeoutMs ? { ...dc, timeoutMs } : dc, name, dir, markers, { force: true })
    return { result, calls, dir, path, after: readFileSync(path, 'utf8'), markers, name }
  }
  const retained = dir => { const p = join(dir, 'archive', 'compact-rejected.latest.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null }
  const seqOf = r => r.calls.map(c => c.b + ':' + c.k)

  await test('E1 首轮保真不过 → 带缺失清单重试 → 通过则采用（共 3 次调用，另一批不重试）', async () => {
    const r = await run((input, c) => c.b === 1 && c.k === 1 ? lossy(input) : good(input))
    assert.equal(r.result.ok, true, JSON.stringify(r.result))
    assert.deepEqual(seqOf(r), ['1:1', '1:2', '2:1'])
    assert.equal(r.result.totalCalls, 3); assert.equal(r.result.rounds, 2); assert.ok(!r.result.fallbackBatches)
    assert.ok(r.after.includes('cfgKey0Timeout') && r.after.includes('cfgKey33Timeout'), '重试补回后的批被采用')
    const d = r.result.batchDetail
    assert.equal(d.length, 2); assert.equal(d[0].retried, true); assert.equal(d[0].retry.result, 'adopted'); assert.equal(d[0].final, 'adopted')
    assert.equal(d[1].retried, false); assert.equal(d[1].retry, null)
    assert.equal(d[0].anchorKept, d[0].anchorTotal, '采用的是重试后的数字')
    assert.equal(retained(r.dir), null, '无拒收、无退回批 → 不留存')
  })

  await test('E1 重试提示词含上次输出、缺失锚点原文与丢失主题', async () => {
    const r = await run((input, c) => c.b === 1 && c.k === 1 ? lossy(input) : good(input))
    const first = r.calls[0], retry = r.calls[1]
    assert.ok(!first.full.includes('上次输出未通过关键事实校验'), '首轮不含反馈')
    assert.ok(retry.full.includes('上次输出未通过关键事实校验'))
    assert.ok(/cfgkey0timeout/i.test(retry.full) && /cfgkey16timeout/i.test(retry.full), '缺失锚点原文在提示里')
    assert.ok(retry.full.includes('缺失的硬信息') && retry.full.includes('逐字补回'))
    assert.ok(retry.prev && retry.prev.includes('## 条目0') && !/cfgKey0Timeout/.test(retry.prev), '喂回的是上次（有缺失的）输出')
    assert.equal(retry.maxTokens, first.maxTokens, '重试沿用同批 perBatch 上限')
  })

  await test('E1/E2 重试仍不过 → 该批回退原文 + 留存两次输出与缺失清单；另一批照常', async () => {
    const r = await run((input, c) => c.b === 1 ? lossy(input) : good(input))
    assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.result.fallbackBatches, 1); assert.equal(r.result.fallbackError, 'fidelity')
    assert.deepEqual(seqOf(r), ['1:1', '1:2', '2:1'])
    assert.ok(r.after.includes('cfgKey0Timeout'), '退回的批保留原文')
    const d = r.result.batchDetail[0]
    assert.equal(d.retried, true); assert.equal(d.retry.result, 'rejected'); assert.equal(d.retry.reason, 'fidelity'); assert.equal(d.final, 'fallback'); assert.equal(d.reason, 'fidelity')
    assert.equal(r.result.rejectionRetained, true)
    const f = retained(r.dir)
    assert.equal(f.version, 1); assert.equal(f.errorCode, 'batch-fallback'); assert.equal(f.workspace, r.name)
    assert.equal(f.rejectedBatches.length, 1); const b = f.rejectedBatches[0]
    assert.equal(b.index, 0); assert.equal(b.finalReason, 'fidelity'); assert.equal(b.attempts.length, 2)
    for (const a of b.attempts) {
      assert.equal(a.reason, 'fidelity'); assert.ok(a.output.includes('## 条目0') && !/cfgKey0Timeout/.test(a.output), '模型原始输出')
      assert.ok(a.gaps.missingAnchors.some(x => /cfgkey0timeout/i.test(x)), '缺失清单')
    }
  })

  await test('E1 条目数校验失败不重试（只 1 次调用，该批退回原文）', async () => {
    const r = await run((input, c) => c.b === 1 ? input.split(/\n(?=<!-- tags)/).slice(0, 1).join('\n') : good(input))
    assert.deepEqual(seqOf(r), ['1:1', '2:1'])
    assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.result.fallbackBatches, 1); assert.equal(r.result.fallbackError, 'validation')
    const d = r.result.batchDetail[0]
    assert.equal(d.retried, false); assert.equal(d.final, 'fallback'); assert.equal(d.reason, 'validation')
  })

  await test('E1 首轮超时不重试，后续批不再调用', async () => {
    const r = await run((input, c) => c.b === 1 ? { hang: true } : good(input), { timeoutMs: 60 })
    assert.deepEqual(seqOf(r), ['1:1'])
    assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'timeout'); assert.equal(r.after, big, '原文不变')
    assert.equal(r.result.batchDetail[0].retried, false)
    assert.equal(r.result.batchDetail[1].skipped, true); assert.equal(r.result.batchDetail[1].final, 'fallback')
  })

  await test('E1 重试轮超时：不再继续，后续批不再调用，原文不变', async () => {
    const r = await run((input, c) => c.b === 1 ? (c.k === 1 ? lossy(input) : { hang: true }) : good(input), { timeoutMs: 60 })
    assert.deepEqual(seqOf(r), ['1:1', '1:2'])
    assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'timeout'); assert.equal(r.after, big)
    assert.equal(r.result.batchDetail[0].retry.reason, 'timeout')
  })

  await test('E1 compactRetryFeedback=false 关闭批级重试（两批各 1 次调用）', async () => {
    const r = await run((input, c) => c.b === 1 ? lossy(input) : good(input), { config: { ...baseCfg, compactRetryFeedback: false } })
    assert.equal(r.calls.length, 2); assert.equal(r.result.fallbackBatches, 1)
    assert.equal(r.result.batchDetail[0].retried, false); assert.equal(r.result.batchDetail[0].retry, null)
    assert.equal(retained(r.dir).rejectedBatches[0].attempts.length, 1)
  })

  await test('E1 调用上限 4 次；手动整理每次均不传插件预算', async () => {
    const r = await run(input => lossy(input))
    assert.equal(r.calls.length, 4); assert.equal(r.result.totalCalls, 4)
    assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'fidelity'); assert.equal(r.after, big)
    assert.ok(r.calls.every(c => c.maxTokens === undefined))
    assert.equal(r.result.rejectionRetained, true); assert.equal(retained(r.dir).rejectedBatches.length, 2)
  })

  await test('E2 留存只保留最近 1 份：新一次覆盖旧的；成功写回且无退回批时清除', async () => {
    const dir = join(root, 'ws-keep1'); mkdirSync(dir)
    const a = await run(input => lossy(input), { name: 'ws-keep1' })
    const t1 = retained(dir).at
    await new Promise(r => setTimeout(r, 15))
    const b = await run((input, c) => c.b === 1 ? lossy(input) : good(input), { name: 'ws-keep1' })
    const arch = readdirSync(join(dir, 'archive')).filter(n => n.startsWith('compact-rejected.'))
    assert.deepEqual(arch, ['compact-rejected.latest.json'], '只有 1 份，且无 tmp 残留')
    const f = retained(dir); assert.notEqual(f.at, t1); assert.equal(f.errorCode, 'batch-fallback'); assert.equal(a.result.ok, false); assert.equal(b.result.ok, true)
    const c = await run(good, { name: 'ws-keep1' })
    assert.equal(c.result.ok, true); assert.equal(retained(dir), null, '成功且无退回批 → 清除旧留存')
  })

  await test('E2 单批路径整理被拒收：留存最终候选全文与首轮候选', async () => {
    const small = mk(20, 440)
    assert.ok(small.length > 12000 && small.length <= 18000, 'small=' + small.length)
    const r = await run(input => lossy(input), { raw: small })
    assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'fidelity'); assert.equal(r.after, small)
    const f = retained(r.dir)
    assert.equal(typeof f.candidate, 'string'); assert.ok(f.candidate.includes('## 条目0') && !/cfgKey/.test(f.candidate))
    assert.equal(f.rawChars, small.length); assert.equal(f.candidateChars, f.candidate.length)
    assert.ok(f.firstRoundCandidate && typeof f.firstRoundCandidate.output === 'string')
  })

  await test('E2 留存不被备份列举/清理逻辑拾取；不在记忆根目录、不进插件目录', async () => {
    const r = await run(input => lossy(input), { name: 'ws-gc' })
    const arch = join(r.dir, 'archive'), names = readdirSync(arch)
    assert.ok(names.includes('compact-rejected.latest.json'))
    assert.ok(names.some(n => /^MEMORY\.bak-/.test(n)), '整理前备份仍在')
    assert.ok(!existsSync(join(r.dir, 'compact-rejected.latest.json')))
    gcArchive(r.dir, 1); runGc(r.dir, { archiveRetentionDays: 1, logRetentionDays: 1 })
    assert.ok(existsSync(join(arch, 'compact-rejected.latest.json')), '清理逻辑不碰留存')
    const n = 'compact-rejected.latest.json'
    assert.ok(!/^\d{4}-\d{2}-\d{2}\.md$/.test(n) && !/^MEMORY\.(bak|lifecycle)-/.test(n), '不匹配日志/备份/撤回备份文件名')
    assert.ok(!readdirSync(plugin).some(x => x.startsWith('compact-rejected')), '插件目录无留存')
    assert.deepEqual(readdirSync(r.dir).filter(x => x !== 'archive' && x !== 'MEMORY.md'), [], '记忆根目录无新增文件')
  })

  await test('E2 留存写入失败不影响整理结果', async () => {
    const dir = join(root, 'ws-wfail'); mkdirSync(join(dir, 'archive', 'compact-rejected.latest.json'), { recursive: true }) // 目标被同名目录占用
    writeFileSync(join(dir, 'archive', 'compact-rejected.latest.json', 'x'), 'x')
    const r = await run(input => lossy(input), { name: 'ws-wfail' })
    assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'fidelity'); assert.equal(r.after, big)
    assert.equal(r.result.rejectionRetained, false)
    assert.ok(r.markers[r.name].__compact__, '整理记录仍写入')
  })

  await test('E3 诊断明细只含数字、布尔与受控错误码，不含正文/锚点文本', async () => {
    const r = await run((input, c) => c.b === 1 ? lossy(input) : good(input))
    const json = JSON.stringify(r.markers[r.name].__compact__.batchDetail)
    for (const bad of ['cfgKey', 'cfgkey', 'npm run', 'core.js', '条目', '事事', '限定条件']) assert.ok(!json.includes(bad), '诊断含正文：' + bad)
    const walk = (v, path) => {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return
      if (typeof v === 'string') { assert.ok(/^[a-z-]+$/.test(v), path + '=' + v); return }
      for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k)
    }
    walk(JSON.parse(json), 'batchDetail')
    const d = r.result.batchDetail[0]
    for (const k of ['inputChars', 'outputChars', 'entriesBefore', 'entriesAfter', 'anchorTotal', 'anchorKept', 'lostTopics']) assert.equal(typeof d[k], 'number', k)
    assert.ok(d.entriesBefore > 0); assert.equal(d.retry.result, 'rejected'); assert.ok(d.retry.anchorKept < d.retry.anchorTotal)
    const st = compactStatus(r.markers[r.name].__compact__)
    assert.equal(st.retriedBatches, 1); assert.equal(st.retryAdoptedBatches, 0); assert.equal(st.rejectionRetained, true)
    assert.equal(st.batchDetail.filter(x => x.final === 'fallback').length, 1)
    assert.ok(!JSON.stringify(st).includes('cfgKey'))
  })

  await test('E3 状态投影：未知/可疑字符串被丢弃，缺失字段安全', () => {
    const st = compactStatus({ ok: true, day: '2026-11-12', batchDetail: [{ index: 0, retried: true, final: 'fallback', reason: 'Bearer SECRET_TOKEN', retry: { result: 'rejected', reason: 'api_key=zzz', outputChars: 5 }, inputChars: -3 }, null] })
    const s = JSON.stringify(st)
    assert.ok(!s.includes('SECRET') && !s.includes('zzz'))
    assert.equal(st.batchDetail[0].reason, null); assert.equal(st.batchDetail[0].retry.reason, null); assert.equal(st.batchDetail[0].inputChars, null)
    assert.equal(compactStatus({ ok: true, day: '2026-11-12' }).batchDetail.length, 0)
  })

  console.log('全部 ' + passed + ' 项通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
