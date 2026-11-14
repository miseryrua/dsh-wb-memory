// 任务 A：compact 自愈套件（假模型，系统临时目录，不碰真实数据）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { migrateMemory, preservesLifecycle } from '../lib/memory-lifecycle.js'
import { compactStatus } from '../lib/compact-status.js'
import { COMPACT_MIN_PROGRESS, COMPACT_BATCH_TARGET_MIN_RATIO, planCompactBatches, compactMadeProgress, compactProgressOk, compactEntryGrowthLimit } from '../lib/compact-plan.js'
const root = mkdtempSync(join(tmpdir(), 'wb-compact-selfheal-'))
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name) }
const count = t => (String(t).match(/^##\s+/gm) || []).length
try {
  const plugin = join(root, 'plugin'); mkdirSync(join(plugin, 'lib'), { recursive: true })
  for (const f of readdirSync(new URL('../lib/', import.meta.url))) if (f.endsWith('.js')) copyFileSync(new URL('../lib/' + f, import.meta.url), join(plugin, 'lib', f))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }))
  const { compactMemoryIfOver, compactTargetChars, logicalDayStamp, compactFeedbackText } = await import(pathToFileURL(join(plugin, 'lib/index.js')))

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
  function makeLlm({ ratio, cap, grow = 0, tamper, calls, fail = {} }) {
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
      const f = fail[calls.length]
      if (f === 'few') out = out.split(/\n(?=<!-- tags)/).slice(0, 1).join('\n') // 批内只剩 1 条（不足一半）
      yield { type: 'text-delta', text: f === 'truncate' ? out.slice(0, 50) : out }; yield { type: 'finish', reason: f === 'truncate' ? 'max-tokens' : 'stop' }
    } }
  }
  let seq = 0
  async function run({ raw = big, ratio = 0.7, cap, grow, tamper, fail, config = cfg, markers = {}, dir, name } = {}) {
    name = name || 'ws' + (++seq)
    dir = dir || join(root, name)
    if (!existsSync(dir)) mkdirSync(dir)
    const path = join(dir, 'MEMORY.md'); writeFileSync(path, raw)
    const calls = []
    const result = await compactMemoryIfOver(makeLlm({ ratio, cap, grow, tamper, calls, fail }), config, dc, name, dir, markers)
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
    // 成功但带警告的超幅记录：不传输入长度时仍按旧语义反推；传入后（生产路径）目标以阈值为准，不再自适应下调（迭代 F3）
    const accepted = { ok: true, target: 3600, after: 16381 }
    assert.equal(compactTargetChars(12000, accepted), 3600)
    assert.equal(compactTargetChars(12000, accepted, 16381), 6000, 'F3：自适应下限 0.5×阈值（旧值取输入一半 8191）')
    assert.equal(compactTargetChars(12000, accepted, 40000), 6000, 'F3：自适应下限 0.5×阈值')
    assert.equal(compactTargetChars(12000, { target: 9600, after: 12745 }, 16381), 8586, '温和超幅仍可自适应')
    assert.equal(compactTargetChars(12000, null, 23454), 9600)
  })

  await test('③a2 F3 目标计算：23465/阈值20000 → 16000；输入短于 0.8×阈值；自适应下限与上限', () => {
    assert.equal(compactTargetChars(20000, null, 23465), 16000, '真实整理量级：以阈值 0.8 为准，不取输入一半')
    assert.equal(compactTargetChars(20000, { ok: false, errorCode: 'validation', target: 11733, after: 22827 }, 23465), 16000, '失败记录不影响')
    assert.equal(compactTargetChars(20000, null, 15000), 15000, '输入短于 0.8×阈值：目标不超过输入')
    assert.equal(compactTargetChars(20000, null, 16000), 16000, '边界：输入恰为 0.8×阈值')
    assert.equal(compactTargetChars(20000, null, 16001), 16000)
    // 自适应：after/target 超幅 1.95×（11733→22827）→ floor(20000/1.95×0.95)=9743 → 抬到下限 0.5×阈值=10000
    assert.equal(compactTargetChars(20000, { target: 11733, after: 22827 }, 23465), 10000)
    assert.equal(compactTargetChars(20000, { target: 16000, after: 22827 }, 23465), 13317, '16000→22827 超幅 1.43× → 13317')
    assert.ok(compactTargetChars(20000, { target: 16000, after: 22827 }, 23465) <= 16000)
    assert.ok(compactTargetChars(20000, { target: 16000, after: 12000 }, 23465) <= 16000, '输出未超目标时不超过上限')
    assert.ok(compactTargetChars(20000, { target: 1, after: 1 }, 1e9) <= 20000)
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
      assert.ok(res.target >= 6000, '第 ' + (day + 1) + ' 天目标 ' + res.target + ' 不得塌向 3600 下限（F3 下限 0.5×阈值）')
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

  await test('④ 条目数有界容忍：真实数量级 34→40 条、缩短约30%仍超阈值 → 接受，warnings 同时含超阈值与条目数变化', async () => {
    const r = await run({ ratio: 0.7, grow: 3 }) // 每批 17+3 → 40 条
    const res = r.result
    assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(res.oldCount, 34); assert.equal(res.newCount, 40)
    assert.equal(res.checks.noEntryGrowth, false); assert.equal(res.checks.entryGrowthOk, true)
    assert.match(res.warnings, /仍超阈值 \d+ 字符/); assert.match(res.warnings, /条目数由 34 增至 40/)
    assert.ok(res.after < big.length * 0.9); assert.equal(count(readFileSync(r.path, 'utf8')), 40)
    assert.equal(readFileSync(join(r.dir, 'archive', 'MEMORY.bak-' + logicalDayStamp(cfg) + '.md'), 'utf8'), big)
    const st = compactStatus(r.markers[r.name].__compact__)
    assert.equal(st.lastOk, true); assert.match(st.warnings, /仍超容量阈值/); assert.match(st.warnings, /条目数由 34 增至 40/)
  })

  await test('④ 条目数硬上限：34→60 条（失控拆条）→ 拒收、原文不变', async () => {
    const r = await run({ ratio: 0.7, grow: 13 }) // 每批 17+13=30 > ceil(17×1.25)=22 → 两批均回退 → 全失败
    assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'validation')
    assert.equal(readFileSync(r.path, 'utf8'), big); assert.ok(r.markers[r.name].__compact__.day)
  })

  await test('④ 条目数硬上限：重复输出（同一批内容出现两遍）→ 拒收、原文不变', async () => {
    const r = await run({ ratio: 0.7, tamper: o => o + '\n\n' + o })
    assert.equal(r.result.ok, false); assert.equal(readFileSync(r.path, 'utf8'), big)
  })

  await test('④ 单批路径：拆条在容忍内（12→14）首轮触发反馈重试、第二轮带警告接受；超上限（12→17）拒收', async () => {
    const raw = mk(12, 400), config = { memoryCharThreshold: 2000, compactMaxTokens: 8000 }
    const ok = await run({ raw, ratio: 0.5, grow: 2, config })
    assert.equal(ok.calls.length, 2, '首轮因 noEntryGrowth 触发一次反馈重试'); assert.equal(ok.result.ok, true); assert.match(ok.result.warnings, /条目数由 12 增至 14/)
    const bad = await run({ raw, ratio: 0.5, grow: 5, config })
    assert.equal(bad.calls.length, 2); assert.equal(bad.result.ok, false); assert.equal(bad.result.checks.entryGrowthOk, false)
    assert.equal(readFileSync(bad.path, 'utf8'), raw)
  })

  const planBig = planCompactBatches(big, 12000, 9600)
  await test('⑥ 逐批兜底①：第2批截断 → 第1批落盘、第2批原文逐字保留、带警告、备份存在', async () => {
    const r = await run({ ratio: 0.3, fail: { 2: 'truncate' } })
    const res = r.result, after = readFileSync(r.path, 'utf8')
    assert.equal(r.calls.length, 2, '请求数上限不变'); assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(res.fallbackBatches, 1); assert.equal(res.fallbackError, 'llm-truncated')
    assert.match(res.warnings, /1 批未整理，保留原文/); assert.match(res.warnings, /仍超阈值/)
    assert.ok(after.startsWith(planBig.prefix)); assert.ok(after.endsWith(planBig.batches[1].text.trim() + '\n'), '第2批原文逐字保留（字节不变）')
    assert.ok(!after.includes(planBig.batches[0].text.trim()), '第1批已整理'); assert.ok(after.length < big.length * 0.9)
    assert.equal(count(after), 34); assert.equal(readFileSync(join(r.dir, 'archive', 'MEMORY.bak-' + logicalDayStamp(cfg) + '.md'), 'utf8'), big)
    const st = compactStatus(r.markers[r.name].__compact__)
    assert.equal(st.fallbackBatches, 1); assert.match(st.warnings, /1 批未整理/)
  })

  await test('⑥ 逐批兜底②：第1批条目数不足一半 → 第1批原文保留、第2批整理结果保留', async () => {
    const r = await run({ ratio: 0.3, fail: { 1: 'few' } })
    const after = readFileSync(r.path, 'utf8')
    assert.equal(r.calls.length, 2); assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.result.fallbackBatches, 1); assert.equal(r.result.fallbackError, 'validation')
    assert.ok(after.startsWith(planBig.prefix + planBig.batches[0].text.trim())); assert.ok(!after.includes(planBig.batches[1].text.trim()))
    assert.equal(count(after), 34)
  })

  await test('⑥ 逐批兜底③：两批都失败 → 拒收、原文不变、日锁照旧、errorCode 为首个真实原因', async () => {
    const r = await run({ ratio: 0.3, fail: { 1: 'truncate', 2: 'few' } })
    assert.equal(r.calls.length, 2); assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'llm-truncated')
    assert.equal(readFileSync(r.path, 'utf8'), big); assert.ok(r.markers[r.name].__compact__.day)
    assert.equal(await compactMemoryIfOver(makeLlm({ ratio: 0.3, calls: [] }), cfg, dc, r.name, r.dir, r.markers), null)
  })

  await test('⑥ 逐批兜底④：部分成功但总进展 <10% → insufficient-progress 拒收、原文不变', async () => {
    const r = await run({ ratio: 0.97, fail: { 2: 'truncate' } })
    assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'insufficient-progress'); assert.equal(readFileSync(r.path, 'utf8'), big)
  })

  await test('反馈文本：entryGrowthOk 分支含实际数字与由常量推导的上限；所有分支均无未展开占位符', () => {
    const info = { after: 20000, before: 23454, threshold: 12000, newCount: 60, minCount: 17, oldCount: 34 }
    const t = compactFeedbackText({ entryGrowthOk: false, noEntryGrowth: false }, info)
    assert.ok(t.includes('60') && t.includes('34') && t.includes(String(compactEntryGrowthLimit(34))), t)
    assert.equal(compactEntryGrowthLimit(34), 43); assert.ok(t.includes('超出允许上限 43 条（原文 34 条）'), t)
    assert.ok(!t.includes('${'), t)
    const all = { nonEmpty: false, shorter: false, underThreshold: false, keptHalfEntries: false, entryGrowthOk: false, noEntryGrowth: false, lifecyclePreserved: false }
    for (const key of Object.keys(all)) assert.ok(!compactFeedbackText({ [key]: false }, info).includes('${'), key)
    assert.ok(!compactFeedbackText({ ...all, entryGrowthOk: true }, info).includes('${'), 'noEntryGrowth 分支')
    assert.ok(!compactFeedbackText(all, info).includes('${'), '全分支')
  })

  await test('小项：insufficient-progress 文案由 COMPACT_MIN_PROGRESS 推导', () => {
    assert.ok(compactStatus({ ok: false, errorCode: 'insufficient-progress', checks: { underThreshold: false } }).errorMessage.includes(Math.round(COMPACT_MIN_PROGRESS * 100) + '%'))
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

  await test('⑤ F1 单批第二轮：仍超阈值且只短约2% → insufficient-progress 拒收、原文不变、留存候选', async () => {
    const raw = mk(12, 400)
    const r = await run({ raw, ratio: 0.98, config: { memoryCharThreshold: 2000, compactMaxTokens: 8000 } })
    assert.equal(r.calls.length, 2); assert.equal(r.result.rounds, 2); assert.equal(r.result.ok, false)
    assert.equal(r.result.errorCode, 'insufficient-progress'); assert.equal(r.result.stage, 'validation')
    assert.equal(readFileSync(r.path, 'utf8'), raw)
    assert.ok(r.result.rejectionRetained, '拒收候选留存，字段同分批路径')
    const rec = Object.values(r.markers)[0]['__compact__']
    assert.equal(rec.errorCode, 'insufficient-progress')
  })

  await test('⑤ F1 单批第二轮：仍超阈值但缩短 ≥10% → 带警告接受（与分批路径同口径）', async () => {
    const raw = mk(12, 400)
    const r = await run({ raw, ratio: 0.85, config: { memoryCharThreshold: 2000, compactMaxTokens: 8000 } })
    assert.equal(r.result.ok, true); assert.equal(r.result.rounds, 2); assert.match(r.result.warnings, /^仍超阈值 \d+ 字符$/)
    assert.ok(r.result.after <= raw.length * 0.9)
  })

  await test('⑤ F1 共用判定：compactProgressOk 边界与分批/单批一致', () => {
    assert.equal(compactProgressOk(1000, 500, 600), true, '≤阈值直接通过')
    assert.equal(compactProgressOk(1000, 950, 600), false, '超阈值且只短5%')
    assert.equal(compactProgressOk(1000, 900, 600), true, '恰好缩10%')
    assert.equal(compactProgressOk(1000, 901, 600), false)
    assert.equal(compactProgressOk(0, 0, 0), true, 'after<=threshold 时与 before 无关')
    assert.equal(compactProgressOk(1000, NaN, 600), false)
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
