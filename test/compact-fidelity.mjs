// 迭代 D：整理保真（回执由代码托管 + 事实锚点保留）。全部用自造合成文本，假模型，系统临时目录。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  extractReceipts, stripReceipts, restoreReceipts, checkReceiptsPreserved,
  extractAnchors, splitTopics, checkAnchorFidelity, boldTitleRetention,
  ANCHOR_MIN_RETENTION, ANCHOR_MAX_LOST_TOPICS,
} from '../lib/compact-fidelity.js'
import { compactStatus } from '../lib/compact-status.js'
import { readMemoryEntries } from '../lib/retrieve.js'
import { stripInjectionNoise } from '../lib/injection-slim.js'
import { inspectMemory } from '../lib/memory-lifecycle.js'

const root = mkdtempSync(join(tmpdir(), 'wb-compact-fidelity-'))
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name) }
const count = t => (String(t).match(/^##\s+/gm) || []).length
const H = i => createHash('sha256').update('fixture-' + i).digest('hex')
const R = (i, day = '2026-11-0' + (1 + (i % 8))) => '<!-- wb-distill-batch:' + day + ':' + H(i) + ' -->'

// ---------- 合成夹具 ----------
// 条目 i：行 A（命令 + 路径）、行 B（配置键 + 版本）、行 C（约束与步骤，无硬锚点）、填充行。
const entry = (i, filler, withReceipt) =>
  '<!-- tags: 测试' + i + ' / date: 2026-01-01 / importance: high -->\n## 条目' + i + '\n' +
  '**限定条件** 仅当 ' + '`npm run task' + i + ' --force` 在 lib/mod' + i + '/core.js 修改后执行。\n' +
  '配置键 cfgKey' + i + 'Timeout 取 ' + i + '.2.0 版本默认值。\n' +
  '注意：必须先备份再执行，禁止并行；风险：误删不可恢复。\n' +
  '事'.repeat(filler) + '\n' + (withReceipt ? R(i) + '\n' : '') + '\n'
const mk = (n, filler, receiptEvery = 0) =>
  '# 项目长期记忆\n\n' + Array.from({ length: n }, (_, i) => entry(i, filler, receiptEvery > 0 && i % receiptEvery === 0)).join('')
const receiptsOf = raw => extractReceipts(raw)

try {
  // ================= 纯函数：回执 =================
  await test('回执：摘出再补回，集合相等；无回执文本逐字节不变', () => {
    const raw = mk(6, 30, 2)
    const { text, receipts } = stripReceipts(raw)
    assert.equal(receipts.length, 3); assert.ok(!/wb-distill-batch/.test(text))
    const back = restoreReceipts(text, receipts)
    assert.deepEqual([...extractReceipts(back)].sort(), [...receipts].sort())
    assert.equal(count(back), 6)
    const plain = mk(4, 30, 0)
    assert.equal(stripReceipts(plain).text, plain); assert.equal(restoreReceipts(plain, []), plain)
    assert.equal(restoreReceipts('', receipts), '', '空输出不补回执，避免把空输出变成非空')
  })

  await test('回执校验：全丢 / 丢一条 / 重复 / 多出 → 不通过；位置移动但集合相同 → 通过', () => {
    const raw = mk(8, 30, 1)
    const all = receiptsOf(raw); assert.equal(all.length, 8)
    const none = stripReceipts(raw).text
    const r0 = checkReceiptsPreserved(raw, none)
    assert.equal(r0.ok, false); assert.equal(r0.expected, 8); assert.equal(r0.found, 0); assert.equal(r0.missing, 8)
    const oneLess = raw.replace(R(3) + '\n', '')
    const r1 = checkReceiptsPreserved(raw, oneLess); assert.equal(r1.ok, false); assert.equal(r1.missing, 1)
    const dup = raw + '\n' + R(2) + '\n'
    const r2 = checkReceiptsPreserved(raw, dup); assert.equal(r2.ok, false); assert.equal(r2.duplicated, 1)
    const extra = raw + '\n' + R(99) + '\n'
    const r3 = checkReceiptsPreserved(raw, extra); assert.equal(r3.ok, false); assert.equal(r3.extra, 1)
    // 同一集合，位置全部挪到文末、顺序倒置、空白不同 → 通过
    const moved = stripReceipts(raw).text.replace(/\s+$/, '') + '\n\n' + [...all].reverse().map(x => x.replace('<!-- ', '<!--  ')).join('\n') + '\n'
    const r4 = checkReceiptsPreserved(raw, moved); assert.equal(r4.ok, true, JSON.stringify(r4))
    assert.equal(checkReceiptsPreserved(mk(3, 20, 0), mk(3, 10, 0)).ok, true, '无回执的库：空集合相等')
  })

  // ================= 纯函数：事实锚点 =================
  const lib12 = mk(12, 40)
  await test('锚点：提取覆盖反引号、路径、命令、版本、配置键；日期与普通数字不算', () => {
    const a = extractAnchors('见 ' + '`git status --short` 与 D:\\work\\a-b\\c.json，/usr/local/bin/x，v1.2 与 3.4.5-rc.1，提交 3f9a8c1d，键 maxRetryCount、MAX_ROWS、--dry-run，网址 https://example.test/a/b。日期 2026-11-12 共 37 条')
    for (const k of ['git status --short', 'd:/work/a-b/c.json', '/usr/local/bin/x', 'v1.2', '3.4.5-rc.1', '3f9a8c1d', 'maxretrycount', 'max_rows', '--dry-run', 'https://example.test/a/b']) assert.ok(a.includes(k), '缺 ' + k + ' ← ' + JSON.stringify(a))
    assert.ok(!a.includes('2026-11-12') && !a.includes('37'))
  })
  await test('锚点：原文对自身与「只缩短散文」全部通过', () => {
    const r = checkAnchorFidelity(lib12, lib12); assert.equal(r.ok, true); assert.equal(r.retention, 1); assert.ok(r.total >= 12 * 4)
    const shortened = lib12.replace(/事+/g, '事')
    const r2 = checkAnchorFidelity(lib12, shortened); assert.equal(r2.ok, true); assert.equal(r2.lostTopics, 0)
    // 改写路径分隔符与大小写不算丢失
    const r3 = checkAnchorFidelity('见 lib\\Mod\\Core.js', '见 LIB/mod/core.js'); assert.equal(r3.ok, true)
  })
  await test('锚点：全局保留率不足 → 拒收（配置键与版本整行被删，保留率约一半）', () => {
    const lossy = lib12.split('\n').filter(l => !/cfgKey/.test(l)).join('\n')
    const r = checkAnchorFidelity(lib12, lossy)
    assert.equal(r.ok, false); assert.ok(r.retention < ANCHOR_MIN_RETENTION, 'retention=' + r.retention); assert.ok(r.missingSample.length > 0 && r.missingSample.length <= 8)
  })
  await test('锚点：整条目锚点全消失（全局仍高于阈值）→ 主题丢失 → 拒收', () => {
    const big = mk(30, 10)
    // 去掉第 7 条的全部锚点行，其余完好：全局保留率约 29/30 但该主题全灭
    const lossy = big.split('\n').filter(l => !(/mod7\/core|cfgKey7Timeout|task7 |7\.2\.0/.test(l))).join('\n')
    const r = checkAnchorFidelity(big, lossy)
    assert.ok(r.retention >= ANCHOR_MIN_RETENTION, '全局保留率仍达标：' + r.retention)
    assert.equal(r.lostEntries, 1); assert.ok(r.lostTopics >= 1, '条目内的粗体小节随条目一并计为丢失'); assert.equal(r.ok, false)
  })
  await test('锚点：条目内粗体小节的锚点全消失 → 小节主题丢失 → 拒收', () => {
    const body = (n, extra) => '## 总条目\n导言文字。\n' + Array.from({ length: n }, (_, i) => '**小节' + i + '** 说明 ' + '`cmd_' + i + '_x` 与 src/s' + i + '/a.js。\n').join('') + '尾部 `keep_this`。\n'
    const orig = body(20), cand = orig.split('\n').filter(l => !/^\*\*小节5\*\*/.test(l)).join('\n')
    const r = checkAnchorFidelity(orig, cand)
    assert.ok(r.retention >= ANCHOR_MIN_RETENTION); assert.equal(r.lostSections, 1); assert.equal(r.lostEntries, 0); assert.equal(r.ok, false)
    assert.equal(splitTopics(orig).filter(t => t.kind === 'section').length, 20)
  })
  await test('锚点：合法合并（两条合一条，锚点都在）→ 通过', () => {
    const orig = mk(6, 30)
    const parts = orig.split(/(?=<!-- tags:)/)
    const merged = parts[0] + parts[1] + parts[2].replace(/<!-- tags:[^\n]*-->\n## [^\n]*\n/, '') + parts.slice(3).join('')
    assert.equal(count(merged), 5)
    const r = checkAnchorFidelity(orig, merged); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.lostTopics, 0)
  })
  await test('锚点：原文没有任何锚点 → 空通过；常量口径', () => {
    const r = checkAnchorFidelity('## 纯散文\n没有硬信息。\n', '## 合并\n更短。\n'); assert.equal(r.ok, true); assert.equal(r.total, 0)
    assert.equal(ANCHOR_MIN_RETENTION, 0.85); assert.equal(ANCHOR_MAX_LOST_TOPICS, 0)
  })
  await test('粗体小节标题保留数（信息项，不参与硬校验）', () => {
    const t = boldTitleRetention('## a\n**甲方案** x\n**乙方案：** y\n', '## a\n甲方案 x\n')
    assert.equal(t.total, 2); assert.equal(t.kept, 1)
  })

  // ================= 集成：假模型 + 隔离的插件目录 =================
  const plugin = join(root, 'plugin'); mkdirSync(join(plugin, 'lib'), { recursive: true })
  for (const f of readdirSync(new URL('../lib/', import.meta.url))) if (f.endsWith('.js')) copyFileSync(new URL('../lib/' + f, import.meta.url), join(plugin, 'lib', f))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }))
  const { compactMemoryIfOver, compactFeedbackText } = await import(pathToFileURL(join(plugin, 'lib/index.js')))
  const cfg = { memoryCharThreshold: 12000, compactMaxTokens: 16000 }
  const dc = { provider: 'fixture', model: 'fixture', timeoutMs: 1000 }
  const inputOf = o => {
    const full = o.messages[0].content[0].text
    let input = JSON.parse(full.split('<WB_MEMORY_INPUT_JSON>')[1].split('</WB_MEMORY_INPUT_JSON>')[0]).text
    const prev = input.includes('\n\n--- 上次输出') ? input.split('\n\n--- 上次输出')[1] : null
    input = input.split('\n\n--- 上次输出')[0].replace(/^--- MEMORY\.md 全文 ---\n/, '')
    return { full, input, prev }
  }
  // 好模型：保留全部非填充行，填充行按 keep 比例截短；可叠加各种破坏
  const good = (input, keep = 0.05) => input.split('\n').map(l => /^事+$/.test(l) ? l.slice(0, Math.max(1, Math.floor(l.length * keep))) : l).join('\n')
  const dropLines = (text, re) => text.split('\n').filter(l => !re.test(l)).join('\n')
  // transform(input, ctx{n:第几次调用, prev}) → 输出
  function makeLlm(transform, calls) {
    return { stream: async function* (o) {
      const { input, prev, full } = inputOf(o); calls.push({ input, prev, full })
      yield { type: 'text-delta', text: transform(input, { n: calls.length, prev, full }) }; yield { type: 'finish', reason: 'stop' }
    } }
  }
  let seq = 0
  async function run(raw, transform, { markers = {} } = {}) {
    const name = 'ws' + (++seq), dir = join(root, name); mkdirSync(dir)
    const path = join(dir, 'MEMORY.md'); writeFileSync(path, raw)
    const calls = []
    const result = await compactMemoryIfOver(makeLlm(transform, calls), cfg, dc, name, dir, markers)
    return { result, calls, path, dir, after: readFileSync(path, 'utf8'), markers, name }
  }
  const sameSet = (a, b) => assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort())

  const big = mk(34, 650, 2)   // 分批：约 30k 字符，17 条回执
  const small = mk(20, 380, 3) // 单批：12k < 长度 ≤ 18k，7 条回执
  assert.ok(big.length > 18000, 'big=' + big.length); assert.ok(small.length > 12000 && small.length <= 18000, 'small=' + small.length)
  const bigReceipts = receiptsOf(big), smallReceipts = receiptsOf(small)
  assert.equal(bigReceipts.length, 17); assert.equal(smallReceipts.length, 7)

  await test('D1 分批：回执送模型前摘出；模型不输出回执 → 写回后集合与原文完全一致、不重复', async () => {
    const r = await run(big, good)
    assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.calls.length, 2)
    for (const c of r.calls) assert.ok(!/wb-distill-batch/.test(c.input), '送模型的输入不得含回执')
    assert.equal(r.result.checks.receiptsPreserved, true); assert.equal(r.result.checks.anchorsPreserved, true)
    sameSet(receiptsOf(r.after), bigReceipts); assert.equal(receiptsOf(r.after).length, 17)
    assert.equal(checkReceiptsPreserved(big, r.after).ok, true); assert.equal(count(r.after), 34)
  })

  await test('D1 分批：模型自己输出了回执（重复、篡改哈希）→ 以代码托管为准，集合不变', async () => {
    const r = await run(big, (input, c) => good(input) + '\n\n' + R(1) + '\n' + R(1) + '\n<!-- wb-distill-batch:2026-11-09:' + 'f'.repeat(64) + ' -->\n')
    assert.equal(r.result.ok, true, JSON.stringify(r.result))
    sameSet(receiptsOf(r.after), bigReceipts); assert.equal(receiptsOf(r.after).length, 17)
  })

  await test('D1 回执位置：集中在文末；inspectMemory、条目计数、readMemoryEntries、注入瘦身、去重 includes 都照常', async () => {
    const r = await run(big, good)
    const tailBlock = r.after.slice(r.after.lastIndexOf('\n\n') )
    const lastEntryEnd = r.after.lastIndexOf('## 条目33')
    const firstReceipt = r.after.indexOf('<!-- wb-distill-batch')
    assert.ok(firstReceipt > lastEntryEnd, '回执全部在最后一条正文之后')
    assert.ok(r.after.endsWith('-->\n'))
    inspectMemory(r.after)
    assert.equal(readMemoryEntries(r.after).filter(e => e.title !== '（前言）').length, 34)
    assert.ok(!/wb-distill-batch/.test(stripInjectionNoise(r.after)), '注入瘦身剔除回执')
    for (const rc of bigReceipts) assert.ok(r.after.includes(rc), 'distillWorkspaceDate 的 includes 去重仍命中：' + rc.slice(0, 30))
  })

  await test('D1 分批：一批回退原文 → 回执不重复、不缺失', async () => {
    const r = await run(big, (input, c) => c.n === 1 ? input.split(/(?=<!-- tags)/).slice(0, 2).join('') : good(input))
    assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.result.fallbackBatches, 1)
    sameSet(receiptsOf(r.after), bigReceipts); assert.equal(receiptsOf(r.after).length, 17)
    assert.match(r.result.warnings, /1 批未整理/)
  })

  await test('D1 无回执的库：行为不变，不凭空追加任何注释', async () => {
    const plain = mk(34, 650, 0)
    const r = await run(plain, good)
    assert.equal(r.result.ok, true); assert.equal(r.result.checks.receiptsPreserved, true)
    assert.equal(receiptsOf(r.after).length, 0); assert.ok(!r.after.includes('wb-distill-batch'))
    assert.equal(r.after.endsWith('\n'), true)
  })

  await test('D1 单批：模型丢回执 → 代码补齐，首轮即通过（1 次调用）', async () => {
    const r = await run(small, good)
    assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.calls.length, 1)
    for (const c of r.calls) assert.ok(!/wb-distill-batch/.test(c.input))
    sameSet(receiptsOf(r.after), smallReceipts); assert.equal(receiptsOf(r.after).length, 7)
  })

  await test('D2 单批：首轮丢配置键行 → 反馈含「事实锚点」→ 第二轮找回 → 接受，回执齐全', async () => {
    const r = await run(small, (input, c) => c.n === 1 ? dropLines(good(input), /cfgKey/) : good(input))
    assert.equal(r.calls.length, 2); assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.result.rounds, 2)
    assert.match(r.calls[1].full, /事实锚点/); assert.match(r.calls[1].full, /保留 \d+\/\d+/)
    assert.ok(!/wb-distill-batch/.test(r.calls[1].input) && !/wb-distill-batch/.test(r.calls[1].prev || ''), '重试轮输入也不含回执')
    sameSet(receiptsOf(r.after), smallReceipts); assert.equal(r.result.checks.anchorsPreserved, true)
  })

  await test('D2 单批：两轮都丢锚点（压进阈值也不行）→ 拒收，原文逐字节不变，错误码 fidelity', async () => {
    const r = await run(small, input => dropLines(good(input), /cfgKey/))
    assert.equal(r.calls.length, 2); assert.equal(r.result.ok, false); assert.equal(r.result.errorCode, 'fidelity')
    assert.equal(r.result.checks.anchorsPreserved, false); assert.equal(r.after, small)
    const st = compactStatus(r.markers[r.name].__compact__)
    assert.equal(st.lastOk, false); assert.ok(st.failedChecks.includes('anchorsPreserved')); assert.equal(st.errorCode, 'fidelity'); assert.match(st.errorMessage, /关键事实|锚点/)
  })

  await test('D3 单批第二轮降级接受：仍超阈值但保真全过 → 带警告接受，回执齐全', async () => {
    const r = await run(small, input => good(input, 0.99))
    assert.equal(r.calls.length, 2, '首轮仍超阈值 → 触发重试')
    assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.result.checks.underThreshold, false)
    assert.match(r.result.warnings, /仍超阈值/); assert.ok(r.after.length > 12000 && r.after.length < small.length)
    sameSet(receiptsOf(r.after), smallReceipts)
  })

  await test('D3 单批第二轮：仍超阈值且丢锚点 → 不得降级接受', async () => {
    const r = await run(small, (input, c) => dropLines(good(input, 0.99), /cfgKey/))
    assert.equal(r.result.ok, false); assert.equal(r.after, small); assert.equal(r.result.errorCode, 'fidelity')
  })

  await test('D3 分批：仍超阈值但缩短≥10%、丢锚点 → 不被带警告接受；保真通过时仍按任务 A 接受', async () => {
    const lossy = await run(big, input => dropLines(good(input, 0.7), /cfgKey/))
    assert.equal(lossy.result.ok, false, JSON.stringify(lossy.result)); assert.equal(lossy.after, big); assert.equal(lossy.result.errorCode, 'fidelity')
    const faithful = await run(big, input => good(input, 0.7))
    assert.equal(faithful.result.ok, true, JSON.stringify(faithful.result)); assert.match(faithful.result.warnings, /^仍超阈值 \d+ 字符$/)
    assert.ok(faithful.result.after > 12000); sameSet(receiptsOf(faithful.after), bigReceipts)
  })

  await test('D2 分批：仅一批丢锚点 → 该批回退原文，另一批保留，回执不重复', async () => {
    const r = await run(big, (input, c) => c.n === 1 ? dropLines(good(input), /cfgKey/) : good(input))
    assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.result.fallbackBatches, 1); assert.equal(r.result.fallbackError, 'fidelity')
    assert.match(r.result.warnings, /1 批未整理/)
    sameSet(receiptsOf(r.after), bigReceipts); assert.equal(receiptsOf(r.after).length, 17)
    assert.ok(r.result.checks.anchorsPreserved)
  })

  await test('D2 分批：合法的条目合并（锚点都在）不被误拒', async () => {
    const r = await run(big, (input, c) => {
      const parts = good(input).split(/(?=<!-- tags:)/).filter(Boolean)
      const out = []
      for (let i = 0; i < parts.length; i++) {
        if (i === 1) { out[out.length - 1] += parts[i].replace(/<!-- tags:[^\n]*-->\n## [^\n]*\n/, ''); continue }
        out.push(parts[i])
      }
      return out.join('')
    })
    assert.equal(r.result.ok, true, JSON.stringify(r.result)); assert.equal(r.result.checks.anchorsPreserved, true)
    assert.ok(count(r.after) < 34)
  })

  await test('D2 提示词：去掉「删除已过时失效」许可；明确保真约束、顺序、粗体小节、保真优先于容量', async () => {
    const r = await run(small, good)
    const p = r.calls[0].full
    assert.ok(!p.includes('删除已过时失效的内容')); assert.ok(!/每条正文限 1-2 行/.test(p)); assert.ok(!/压缩到 1-2 行短句/.test(p))
    for (const k of ['约束', '限定条件', '风险', '先后顺序', '粗体', '保真优先于容量', '宁可超阈值', '反引号', '回执']) assert.ok(p.includes(k), '提示词缺：' + k)
  })

  await test('D1 面板与反馈：compactFeedbackText 点名回执 / 锚点；compactStatus 与客户端标签认得新校验项', () => {
    const base = { nonEmpty: true, shorter: true, underThreshold: true, keptHalfEntries: true, noEntryGrowth: true, entryGrowthOk: true, lifecyclePreserved: true, receiptsPreserved: true, anchorsPreserved: true }
    assert.equal(compactFeedbackText(base, { after: 1, before: 2, threshold: 3, newCount: 1, minCount: 1, oldCount: 1 }), '')
    const f = compactFeedbackText({ ...base, receiptsPreserved: false, anchorsPreserved: false }, {
      after: 1, before: 2, threshold: 3, newCount: 1, minCount: 1, oldCount: 1,
      receipts: { expected: 8, found: 0, missing: 8, extra: 0, duplicated: 0 },
      anchors: { total: 100, kept: 60, retention: 0.6, lostTopics: 2, missingSample: ['lib/a.js'] },
    })
    assert.match(f, /回执/); assert.match(f, /60\/100/); assert.match(f, /lib\/a\.js/); assert.match(f, /2 个主题/)
    const st = compactStatus({ ok: false, errorCode: 'validation', checks: { ...base, receiptsPreserved: false } })
    assert.deepEqual(st.failedChecks, ['receiptsPreserved'])
    const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    assert.match(client, /receiptsPreserved:\s*"[^"]+"/); assert.match(client, /anchorsPreserved:\s*"[^"]+"/)
  })

  console.log('\n全部 ' + passed + ' 项通过')
} finally { rmSync(root, { recursive: true, force: true }) }
