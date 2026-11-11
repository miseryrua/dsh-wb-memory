// 任务 A：compact 自愈套件（假模型，系统临时目录，不碰真实数据）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { migrateMemory, preservesLifecycle } from '../lib/memory-lifecycle.js'
import { compactStatus } from '../lib/compact-status.js'
import { COMPACT_MIN_PROGRESS, COMPACT_BATCH_TARGET_MIN_RATIO, planCompactBatches, compactMadeProgress } from '../lib/compact-plan.js'
const root = mkdtempSync(join(tmpdir(), 'wb-compact-selfheal-'))
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name) }
const count = t => (String(t).match(/^##\s+/gm) || []).length
try {
  const plugin = join(root, 'plugin'); mkdirSync(join(plugin, 'lib'), { recursive: true })
  for (const f of readdirSync(new URL('../lib/', import.meta.url))) if (f.endsWith('.js')) copyFileSync(new URL('../lib/' + f, import.meta.url), join(plugin, 'lib', f))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }))
  const { compactMemoryIfOver, compactTargetChars, logicalDayStamp } = await import(pathToFileURL(join(plugin, 'lib/index.js')))

  // 「DSH折腾」数量级：34 条、约 23.4k 字符、阈值 12000
  const mk = (n, bodyLen) => '# 项目长期记忆\n\n' + Array.from({ length: n }, (_, i) => '<!-- tags: 测试' + i + ' / date: 2026-01-01 / importance: high -->\n## 条目' + i + '\n' + '事'.repeat(bodyLen) + '\n\n').join('')
  const big = mk(34, 650)
  assert.ok(big.length > 22000 && big.length < 25000, '构造规模 ' + big.length)
  const cfg = { memoryCharThreshold: 12000, compactMaxTokens: 16000 }
  const dc = { provider: 'fixture', model: 'fixture', timeoutMs: 1000 }

  // 假模型：正文行按 ratio 截短（保留标题/标签/管理标记行）；ratioFn(targetFromPrompt, bodyChars, otherChars) 可按提示里的目标自适应
  function shrink(text, ratio) {
    return text.split('\n').map(l => (!l || l.startsWith('#') || l.startsWith('<!--')) ? l : l.slice(0, Math.max(1, Math.floor(l.length * ratio)))).join('\n')
  }
  const inputOf = o => {
    const full = o.messages[0].content[0].text
    let input = JSON.parse(full.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text
    input = input.split('\n\n--- 上次输出')[0].replace(/^--- MEMORY\.md 全文 ---\n/, '') // 重试轮只取原文
    return { full, input, target: Number((/整理压缩到 (\d+) 字符以内/.exec(full) || [])[1]) }
  }
  function makeLlm({ ratio, cap, grow = 0, tamper, calls }) {
    return { stream: async function* (o) {
      calls.push(o)
      const { input, target } = inputOf(o)
      let out
      if (cap) { // 按提示目标的 cap 倍输出（模拟恒超标 cap−1 倍的真实模型）
        const body = input.split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('<!--')).join('').length
        const other = input.length - body
        out = shrink(input, Math.min(1, Math.max(0.02, (target * cap - other) / body)))
      } else out = shrink(input, ratio)
      for (let i = 0; i < grow; i++) out += '\n\n## 拆分出的条目' + i + '\n拆条内容\n'
      if (tamper) out = tamper(out)
      yield { type: 'text-delta', text: out }; yield { type: 'finish', reason: 'stop' }
    } }
  }
  let seq = 0
  async function run({ raw = big, ratio = 0.7, cap, grow, tamper, config = cfg, markers = {}, dir, name } = {}) {
    name = name || 'ws' + (++seq)
    dir = dir || join(root, name)
    if (!existsSync(dir)) mkdirSync(dir)
    const path = join(dir, 'MEMORY.md'); writeFileSync(path, raw)
    const calls = []
    const result = await compactMemoryIfOver(makeLlm({ ratio, cap, grow, tamper, calls }), config, dc, name, dir, markers)
    return { dir, path, calls, markers, result, name }
  }

  await test('①「DSH折腾」量级：两批压到约70%仍超阈值 → 带警告接受、变短、备份存在', async () => {
    const r = await run({ ratio: 0.7 })
    const res = r.result, after = readFileSync(r.path, 'utf8')
    assert.equal(r.calls.length, 2); assert.equal(res.batches, 2); assert.equal(res.totalCalls, 2)
    assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(res.stage, 'complete'); assert.equal(res.errorCode, null)
    assert.ok(res.after > 12000, '仍超阈值：' + res.after); assert.equal(res.checks.underThreshold, false)
    assert.match(res.warnings, /^仍超阈值 \d+ 字符$/); assert.equal(res.warnings, '仍超阈值 ' + (res.after - 12000) + ' 字符')
    assert.ok(after.length >= res.after && after.length <= res.after + 1, '落盘内容即整理结果（至多补一个尾换行）')
    assert.ok(after.length < big.length)
    assert.equal(count(after), 34); assert.ok(preservesLifecycle(big, after))
    const bak = join(r.dir, 'archive', 'MEMORY.bak-' + logicalDayStamp(cfg) + '.md')
    assert.equal(readFileSync(bak, 'utf8'), big, '整理前备份为原文')
    assert.equal(r.markers[r.name].__compact__.warnings, res.warnings, '日锁记录同样带 warnings，可与达标区分')
    const st = compactStatus(r.markers[r.name].__compact__)
    assert.equal(st.lastOk, true); assert.match(st.warnings, /仍超容量阈值 \d+ 字符/); assert.equal(st.errorCode, null)
  })

  await test('① 对照：恰好压进阈值 → 达标，无 warnings', async () => {
    const r = await run({ ratio: 0.3 })
    assert.equal(r.result.ok, true); assert.ok(r.result.after <= 12000); assert.equal(r.result.warnings, undefined)
    assert.equal(compactStatus(r.markers[r.name].__compact__).warnings, null)
  })

  await test('② 进展不足（只短约2%）→ 拒收、原文不变、仍有备份', async () => {
    const r = await run({ ratio: 0.97 })
    const res = r.result
    assert.equal(r.calls.length, 2); assert.equal(res.ok, false); assert.equal(res.errorCode, 'insufficient-progress'); assert.equal(res.stage, 'validation')
    assert.ok(res.after > big.length * (1 - COMPACT_MIN_PROGRESS), '缩短不足 10%：' + res.after)
    assert.equal(readFileSync(r.path, 'utf8'), big, '原文逐字节不变')
    assert.equal(readFileSync(join(r.dir, 'archive', 'MEMORY.bak-' + logicalDayStamp(cfg) + '.md'), 'utf8'), big)
    assert.ok(r.markers[r.name].__compact__.day, '拒收仍记每日一次的日锁')
    assert.equal(await compactMemoryIfOver(makeLlm({ ratio: 0.5, calls: [] }), cfg, dc, r.name, r.dir, r.markers), null, '同日不再自动尝试')
    const st = compactStatus(r.markers[r.name].__compact__)
    assert.equal(st.lastOk, false); assert.equal(st.errorCode, 'insufficient-progress'); assert.match(st.errorMessage, /缩短不足/)
    assert.deepEqual(st.failedChecks, ['underThreshold'])
  })

  await test('② 边界：compactMadeProgress 恰好 10% 通过、9.9% 不通过', () => {
    assert.equal(compactMadeProgress(1000, 900), true); assert.equal(compactMadeProgress(1000, 901), false)
    assert.equal(compactMadeProgress(0, 0), false); assert.equal(compactMadeProgress(1000, NaN), false)
  })

  await test('③a compactTargetChars：旧语义不变 + 失败记录不压低 + 输入比例下限', () => {
    // 既有 smoke 语义（两参数）
    assert.equal(compactTargetChars(12000, null), 9600)
    assert.equal(compactTargetChars(12000, { target: 9600, after: 12745 }), 8586)
    assert.equal(compactTargetChars(12000, { target: 9600, after: 40000 }), 3600)
    assert.equal(compactTargetChars(12000, {}), 9600)
    // 失败/拒收记录不参与反推
    assert.equal(compactTargetChars(12000, { ok: false, target: 3600, after: 16381 }), 9600)
    assert.equal(compactTargetChars(12000, { ok: false, errorCode: 'validation', target: 9600, after: 40000 }), 9600)
    assert.equal(compactTargetChars(12000, { ok: false, errorCode: 'llm-truncated', target: 9600, after: 12000 }), 9600)
    // 例外：模型无视目标（无实质进展）仍可反推
    assert.equal(compactTargetChars(12000, { ok: false, errorCode: 'insufficient-progress', target: 9600, after: 12745 }), 8586)
    // 成功但带警告的超幅记录：反推结果受输入比例下限保护（旧实现会塌到 3600）
    const accepted = { ok: true, target: 3600, after: 16381 }
    assert.equal(compactTargetChars(12000, accepted), 3600)
    assert.equal(compactTargetChars(12000, accepted, 16381), 8191)
    assert.equal(compactTargetChars(12000, accepted, 40000), 9600, '下限不超过兜底 0.8×阈值')
    assert.equal(compactTargetChars(12000, null, 23454), 9600)
  })

  await test('③b 分批目标：每批不低于该批输入的 COMPACT_BATCH_TARGET_MIN_RATIO', () => {
    const plan = planCompactBatches(big, 12000, 9600)
    for (const b of plan.batches) assert.ok(b.target >= Math.ceil(b.text.length * COMPACT_BATCH_TARGET_MIN_RATIO), b.target + ' vs ' + b.text.length)
    // 极小整体目标（旧口径会得到 ~15%）也被抬到下限
    const small = planCompactBatches(big, 12000, 6000)
    for (const b of small.batches) assert.ok(b.target >= Math.ceil(b.text.length * COMPACT_BATCH_TARGET_MIN_RATIO))
  })

  await test('③c 连续多日：模型恒超目标70%，目标不塌到下限，文件逐日收敛进阈值', async () => {
    const dir = join(root, 'multi'); mkdirSync(dir)
    const markers = {}; let size = big.length; writeFileSync(join(dir, 'MEMORY.md'), big)
    const targets = [], sizes = [size]
    for (let day = 0; day < 8; day++) {
      const last = markers.multi?.__compact__
      if (last) markers.multi.__compact__ = { ...last, day: '2000-01-0' + (day + 1) } // 模拟日期推进
      const calls = []
      const res = await compactMemoryIfOver(makeLlm({ cap: 1.7, calls }), cfg, dc, 'multi', dir, markers)
      if (res === null) break
      assert.equal(res.ok, true, '第 ' + (day + 1) + ' 天应接受：' + JSON.stringify(res))
      assert.ok(res.target >= 6900, '第 ' + (day + 1) + ' 天目标 ' + res.target + ' 不得塌向 3600 下限')
      assert.ok(res.target !== 3600)
      assert.ok(res.after < size, '逐日变短')
      assert.equal(res.newCount, 34)
      targets.push(res.target); size = res.after; sizes.push(size)
    }
    const finalText = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.ok(finalText.length <= 12000, '收敛进阈值：' + sizes.join(' → ') + '（目标 ' + targets.join('/') + '）')
    assert.ok(targets.length <= 4, '应在几天内收敛：' + sizes.join(' → '))
    assert.equal(count(finalText), 34); assert.ok(preservesLifecycle(big, finalText))
  })

  await test('③d 失败日不连累次日目标：上一日 ok:false（目标 3600/超幅 4.5×）后次日仍用兜底目标', async () => {
    const markers = { wsx: { __compact__: { day: '2000-01-01', ok: false, errorCode: 'validation', target: 3600, after: 16381, before: 23454 } } }
    const r = await run({ ratio: 0.5, markers, name: 'wsx' })
    assert.equal(r.result.target, 9600); assert.equal(r.result.ok, true)
  })

  await test('④ 条目数护栏：模型拆条（34→36）即使已压到70% 也拒收，原文不变', async () => {
    const r = await run({ ratio: 0.7, grow: 1 }) // 每批多拆 1 条 → 36 条
    assert.equal(r.result.ok, false); assert.equal(r.result.checks.noEntryGrowth, false); assert.equal(r.result.errorCode, 'validation')
    assert.equal(r.result.newCount, 36); assert.equal(r.result.oldCount, 34)
    assert.equal(readFileSync(r.path, 'utf8'), big)
    assert.ok(compactStatus(r.markers[r.name].__compact__).failedChecks.includes('noEntryGrowth'))
  })

  await test('④ 条目数护栏：单批路径同样拒收拆条（含同轮重试后）', async () => {
    const raw = mk(12, 400)
    const r = await run({ raw, ratio: 0.5, grow: 2, config: { memoryCharThreshold: 2000, compactMaxTokens: 8000 } })
    assert.equal(r.calls.length, 2, '首轮校验失败触发一次反馈重试'); assert.equal(r.result.ok, false); assert.equal(r.result.checks.noEntryGrowth, false)
    assert.equal(readFileSync(r.path, 'utf8'), raw)
  })

  await test('④ 生命周期护栏：删除管理标记的输出（即便压缩进展充分）拒收', async () => {
    const withIds = migrateMemory(big).text
    const r = await run({ raw: withIds, ratio: 0.7, tamper: o => o.replace(/<!-- wb-memory:[^\n]+ -->\n/, '') })
    assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'validation'); assert.equal(r.result.checks.lifecyclePreserved, false)
    assert.equal(readFileSync(r.path, 'utf8'), withIds)
    const ok = await run({ raw: withIds, ratio: 0.7 })
    assert.equal(ok.result.ok, true, '无篡改时带管理标记的两批整理照常带警告接受'); assert.match(ok.result.warnings, /仍超阈值/)
  })

  await test('④ 条目数下限护栏仍有效：某批丢掉大半条目 → 拒收', async () => {
    const r = await run({ ratio: 0.7, tamper: o => o.split(/\n(?=<!-- tags)/).slice(0, 3).join('\n') })
    assert.equal(r.result.ok, false); assert.equal(readFileSync(r.path, 'utf8'), big)
  })

  await test('⑤ 单批路径不变：首轮达标 → 一次调用、无警告', async () => {
    const raw = mk(12, 400) // 约 5k
    const r = await run({ raw, ratio: 0.3, config: { memoryCharThreshold: 4000, compactMaxTokens: 8000 } })
    assert.equal(r.calls.length, 1); assert.equal(r.result.rounds, 1); assert.equal(r.result.ok, true); assert.equal(r.result.warnings, undefined); assert.equal(r.result.batches, 1)
  })

  await test('⑤ 单批路径不变：第二轮仍超阈值但更短（哪怕只短2%）→ 带警告接受；无进展要求', async () => {
    const raw = mk(12, 400)
    const r = await run({ raw, ratio: 0.98, config: { memoryCharThreshold: 2000, compactMaxTokens: 8000 } })
    assert.equal(r.calls.length, 2); assert.equal(r.result.rounds, 2); assert.equal(r.result.ok, true); assert.match(r.result.warnings, /^仍超阈值 \d+ 字符$/)
    assert.ok(r.result.after > raw.length * 0.9)
  })

  await test('⑤ 单批路径不变：第二轮不比原文短 → 拒收', async () => {
    const raw = mk(12, 400)
    const r = await run({ raw, ratio: 1, tamper: o => o + '追加'.repeat(10), config: { memoryCharThreshold: 2000, compactMaxTokens: 8000 } })
    assert.equal(r.result.ok, false); assert.equal(r.result.checks.shorter, false); assert.equal(readFileSync(r.path, 'utf8'), raw)
  })

  await test('护栏回归：conflict（整理期间被改）仍不写回、不设日锁；force 可重试', async () => {
    const dir = join(root, 'conflict'); mkdirSync(dir); const path = join(dir, 'MEMORY.md'); writeFileSync(path, big)
    const markers = {}, calls = []
    const llm = { stream: async function* (o) { calls.push(o); writeFileSync(path, big.replace('项目长期记忆', '人工编辑')); const { input } = inputOf(o); yield { type: 'text-delta', text: shrink(input, 0.7) }; yield { type: 'finish', reason: 'stop' } } }
    const res = await compactMemoryIfOver(llm, cfg, dc, 'conflict', dir, markers)
    assert.equal(res.conflict, true); assert.equal(markers.conflict.__compact__, undefined); assert.match(readFileSync(path, 'utf8'), /人工编辑/)
  })

  console.log('compact-selfheal: ' + passed + ' passed')
} finally { rmSync(root, { recursive: true, force: true }) }
