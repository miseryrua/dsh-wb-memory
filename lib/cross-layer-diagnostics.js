/**
 * 跨层一致性诊断（第三批，纯只读）。
 *
 * 输入：analyzeCrossLayer({ memoryMd, sources }, opts)
 *   - memoryMd：MEMORY.md 全文（可含 wb-memory 生命周期标记，可 CRLF）
 *   - sources：[{ sourceId, layer, label, text }]，layer ∈
 *     profile/pinned/memory/summary/today/review；text 为主线传入的最终可见片段
 *     或明确标注的 before-fit 候选。本模块不做任何 IO，不调用 LLM，不修改任何输入。
 *
 * 输出字段（稳定契约；主线 sanitize 白名单按此保留有界 finding，改名须同步主线）：
 *   ok: true            —— 本模块不抛业务异常，坏输入一律 fail-soft 并记入 degraded
 *   degraded: [{ stage, reason }]          —— 可见降级原因（空输入/坏元数据/截断等）
 *   scanned: { sources, sourceChars, memoryEntries, inactiveEntries, pairs }
 *   truncated: { sourcesDropped, sourcesSkipped, sourcesClipped, memoryMdClipped,
 *                memoryEntriesClipped, pairsSkipped, findingsClipped }  —— 截断可见
 *   findings: [{
 *     kind: 'duplicate' | 'possible-conflict' | 'inactive-reference',
 *     a / b: { sourceId, layer, label },   // a=记忆条目侧或较前来源，b=另一侧；
 *                                          // label 经净化，绝不输出绝对路径
 *     basis: { containment, matchedCount, matchedTokens[, numeric][, state] },
 *     evidence: { a, b },                  // 各 ≤60 字符、折叠空白的短证据
 *     note
 *   }]
 *
 * 判定口径（刻意保守，宁漏勿误；阈值均可用 opts 覆盖）：
 *   duplicate         特征 token 重叠 containment ≥ 0.7 且命中 ≥ 4，且数值呈包含关系
 *   possible-conflict 主题相似（containment ≥ 0.5 且命中 ≥ 3）但两侧数值互不包含。
 *                     仅为疑似，需人工核实；相似绝不等于事实矛盾。
 *   inactive-reference 已 superseded/retracted 条目的特征 token 在
 *                     today/review/pinned/profile 层 containment ≥ 0.6 且命中 ≥ 3；
 *                     条目含数字时要求其数字全部再现，避免“更正后的新事实”误伤。
 *   防误报：纯数字、中文单字、短通用词、独立项目（token 重叠不足）均不构成依据；
 *           两侧任一特征 token 数 < 3 的配对直接跳过。
 *   边界：无命中不代表无冲突；inactive-reference 按接口约定只查日志（today/review）、
 *         置顶（pinned）、画像（profile），不查 summary 层；memory×memory 重复归
 *         retrieve.detectDuplicates，本模块只做跨层（memory×source、source×source）。
 */
import { inspectMemory } from './memory-lifecycle.js'
import { readMemoryEntries } from './retrieve.js'

const KNOWN_LAYERS = new Set(['profile', 'pinned', 'memory', 'summary', 'today', 'review'])
const INACTIVE_LAYERS = new Set(['today', 'review', 'pinned', 'profile'])
const KIND_ORDER = new Map([['duplicate', 0], ['possible-conflict', 1], ['inactive-reference', 2]])
const NOTES = {
  duplicate: '高度重叠的近重复；相似不等于矛盾，是否合并需人工确认',
  'possible-conflict': '主题相似但数值不一致，仅为疑似冲突，需人工核实；相似不等于事实矛盾',
  'inactive-reference': '已失效（superseded/retracted）条目的正文片段再现，建议人工核实是否残留旧事实',
}

// 与 retrieve.js 同源的停用字/停用词口径（本模块只用于剔“两字皆停用”的 bigram）。
const STOP_CJK = new Set('的了着过吗呢吧啊呀哦嗯是在与及或和也就才又还再很太更最们我你他她它这那哪什么怎样为以之其于由被把给对从向往个些上下里外得地所如若则并且但却因故自等不没无'.split(''))
const STOP_EN = new Set(('a an the and or not no yes is are was were be been being am do does did doing ' +
  'have has had will would can could should shall may might must to of in on at by ' +
  'for with from as into over under about it its this that these those i you he she ' +
  'they we me my your his her their our us them if then than so but when where which ' +
  'who what how why there here all any each more most some such only own same too very').split(' '))

const CJK = /[㐀-䶿一-鿿豈-﫿]/

// 全角 ASCII → 半角（真实日志出现过全角数字/符号，不归一化就匹配不上）。
function foldWidth(s) {
  return String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

// 特征签名：中文连续 bigram（两字皆停用则弃）+ ≥2 字符英文词（剔停用词）；
// 纯数字不进 token（数值单独成集合，防止“同数字不同项目”误报）。
function signature(text) {
  const s = foldWidth(String(text == null ? '' : text)).toLowerCase()
  const toks = new Set()
  const nums = new Set()
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (CJK.test(ch)) {
      let j = i + 1
      while (j < s.length && CJK.test(s[j])) j++
      const run = s.slice(i, j)
      for (let k = 0; k + 1 < run.length; k++) {
        const bg = run.slice(k, k + 2)
        if (!(STOP_CJK.has(bg[0]) && STOP_CJK.has(bg[1]))) toks.add(bg)
      }
      i = j
    } else if (/[a-z0-9]/.test(ch)) {
      let j = i + 1
      while (j < s.length && /[a-z0-9_-]/.test(s[j])) j++
      const w = s.slice(i, j)
      if (!/^\d+$/.test(w) && w.length >= 2 && !STOP_EN.has(w)) toks.add(w)
      i = j
    } else i++
  }
  // 数值签名取带 : 或 . 分隔的完整数字串（时间 03:20 / 版本 0.12.1 各为一个值），
  // 并按段去前导零（03:20 ≡ 3:20）；纯数字绝不进 token，防“同数字不同项目”误报。
  for (const m of s.matchAll(/\d+(?:[:.]\d+)*/g)) nums.add(m[0].replace(/0+(\d)/g, '$1'))
  return { toks, nums }
}

const isAbsPath = (s) => /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\/[^/\s]+\/\S/.test(s)
function basename(s) {
  const parts = String(s).split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(s)
}
function clip(s, n) {
  s = String(s)
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
// 来源标识净化：label 绝不输出绝对路径（取 basename）；sourceId 是绝对路径时
// 换成 basename + 确定性短哈希（可区分同名文件，不泄露路径）。
function sanitizeLabel(label, sourceId) {
  let s = String(label == null ? '' : label).trim()
  if (isAbsPath(s)) s = basename(s)
  if (!s && sourceId != null) { s = String(sourceId); if (isAbsPath(s)) s = basename(s) }
  return clip(s.replace(/[\r\n\t]+/g, ' '), 120) || '(unnamed)'
}
function sanitizeSourceId(id, idx) {
  let s = typeof id === 'string' && id.trim() ? id.trim() : 'source-' + idx
  if (isAbsPath(s)) {
    let h = 5381
    for (const ch of s) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
    s = basename(s) + '#' + h.toString(16)
  }
  return clip(s.replace(/[\r\n\t]+/g, ' '), 64)
}

// 短证据：围绕首个命中词的 ≤max 字符窗口，折叠空白；找不到命中词则取开头。
function excerpt(rawText, needles, max) {
  const text = String(rawText == null ? '' : rawText)
  if (!text) return ''
  let best = -1
  const lower = foldWidth(text).toLowerCase()
  for (const n of needles) {
    const i = lower.indexOf(String(n).toLowerCase())
    if (i >= 0 && (best < 0 || i < best)) best = i
  }
  const fold = foldWidth(text)
  let out
  if (best < 0) out = fold.slice(0, max)
  else {
    const start = Math.max(0, best - 20)
    const end = Math.min(fold.length, best + 40)
    out = (start > 0 ? '…' : '') + fold.slice(start, end) + (end < fold.length ? '…' : '')
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > max ? out.slice(0, max - 1) + '…' : out
}

export function analyzeCrossLayer(input = {}, opts = {}) {
  const o = {
    maxSources: 24,          // 最多处理的来源数
    maxSourceChars: 8000,    // 单个来源文本截断长度
    maxMemoryMdChars: 200000,// memoryMd 截断长度
    maxMemoryEntries: 32,    // current 与 inactive 各自的条目上限
    maxPairs: 2048,          // 参与比对的配对上限
    maxFindings: 50,
    maxEvidenceChars: 60,
    maxMatchedTokens: 8,
    minUnitTokens: 3,        // 两侧任一特征 token 少于该值不比对（短通用词防线）
    topicContainment: 0.5, topicMinMatched: 3,
    dupContainment: 0.7, dupMinMatched: 4,
    inactiveContainment: 0.6, inactiveMinMatched: 3,
    ...opts,
  }
  const degraded = []
  const seenDegraded = new Set()
  const degrade = (stage, reason) => {
    const key = stage + ':' + reason
    if (seenDegraded.has(key)) return
    seenDegraded.add(key)
    degraded.push({ stage, reason })
  }
  const truncated = { sourcesDropped: 0, sourcesSkipped: 0, sourcesClipped: 0, memoryMdClipped: false, memoryEntriesClipped: 0, pairsSkipped: 0, findingsClipped: 0 }

  const memoryMd = input ? input.memoryMd : undefined
  const sources = input ? input.sources : undefined
  let md = typeof memoryMd === 'string' ? memoryMd : ''
  if (!md.trim()) degrade('memoryMd', 'empty')
  if (md.length > o.maxMemoryMdChars) {
    md = md.slice(0, o.maxMemoryMdChars)
    truncated.memoryMdClipped = true
    degrade('memoryMd', 'chars-capped')
  }

  let currentEntries = []
  let inactiveEntries = []
  if (md.trim()) {
    if (/<!--\s*wb-memory\b/i.test(md)) {
      try { inspectMemory(md) } catch { degrade('memory-metadata', 'invalid-metadata') }
    }
    try {
      const all = readMemoryEntries(md, { includeInactive: true })
      currentEntries = all.filter((e) => !e.status || e.status === 'current')
      inactiveEntries = all.filter((e) => e.status === 'superseded' || e.status === 'retracted')
    } catch { degrade('memory-parse', 'parse-failed') }
  }
  // 主线仅用整库作为退场参照，current必须来自最终注入sources。
  if (opts.includeCurrentMemory === false) currentEntries = []
  for (const list of [currentEntries, inactiveEntries]) {
    if (list.length > o.maxMemoryEntries) {
      truncated.memoryEntriesClipped += list.length - o.maxMemoryEntries
      list.length = o.maxMemoryEntries
    }
  }
  // 条目文本剔除 frontmatter 注释行：tags/date 注释的 token 与日期数字会污染
  // 重叠率和数值比较（日期数字 ≠ 事实数值）。
  const entryText = (e) => (e.title || '') + '\n' + String(e.body || '').split(/\r?\n/).filter((l) => !/^<!--.*-->\s*$/.test(l.trim())).join('\n')
  const unit = (side, text, extra) => ({ side, text, sig: signature(text), ...extra })
  const memoryUnits = currentEntries.map((e, i) => unit({ sourceId: e.memoryId || 'memory-entry-' + i, layer: 'memory', label: sanitizeLabel(e.title, null) }, entryText(e), {}))
  const inactiveUnits = inactiveEntries.map((e, i) => unit({ sourceId: e.memoryId || 'memory-inactive-' + i, layer: 'memory', label: sanitizeLabel(e.title, null) }, entryText(e), { state: e.status }))

  const rawSources = Array.isArray(sources) ? sources : (sources != null ? (degrade('sources', 'not-array'), []) : [])
  if (rawSources.length === 0 && sources != null) degrade('sources', 'empty')
  if (sources == null) degrade('sources', 'empty')
  const sourceUnits = []
  rawSources.forEach((s, idx) => {
    if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.text !== 'string') {
      truncated.sourcesSkipped++
      degrade('source', 'malformed-source')
      return
    }
    if (sourceUnits.length >= o.maxSources) { truncated.sourcesDropped++; return }
    let text = s.text
    if (text.length > o.maxSourceChars) { text = text.slice(0, o.maxSourceChars); truncated.sourcesClipped++ }
    const sourceId = sanitizeSourceId(s.sourceId, idx)
    let layer = typeof s.layer === 'string' ? s.layer : 'unknown'
    if (!KNOWN_LAYERS.has(layer)) degrade('source-layer', 'unknown-layer')
    layer = clip(layer.replace(/[\r\n\t]+/g, ' '), 24)
    const label = sanitizeLabel(s.label, sourceId)
    sourceUnits.push(unit({ sourceId, layer, label }, text, {}))
  })

  const findings = []
  let pairsExamined = 0
  const takeBudget = () => {
    if (pairsExamined >= o.maxPairs) { truncated.pairsSkipped++; return false }
    pairsExamined++
    return true
  }

  const makeFinding = (kind, A, B, matched, containment, extra) => {
    const needles = matched.slice(0, 3).concat(
      extra.numeric ? extra.numeric.aOnly.slice(0, 2).concat(extra.numeric.bOnly.slice(0, 2)) : [])
    return {
      kind,
      a: { ...A.side },
      b: { ...B.side },
      basis: {
        containment: Math.round(containment * 100) / 100,
        matchedCount: matched.length,
        matchedTokens: [...matched].sort().slice(0, o.maxMatchedTokens).map((t) => clip(t, 16)),
        ...(extra.numeric ? { numeric: extra.numeric } : {}),
        ...(extra.state ? { state: extra.state } : {}),
      },
      evidence: { a: excerpt(A.text, needles, o.maxEvidenceChars), b: excerpt(B.text, needles, o.maxEvidenceChars) },
      note: NOTES[kind],
    }
  }

  // 跨层重复 / 疑似数值冲突（memory×source、source×source；不含 memory×memory）。
  const cross = (A, B) => {
    if (!takeBudget()) return
    const matched = [...A.sig.toks].filter((t) => B.sig.toks.has(t))
    const denom = Math.min(A.sig.toks.size, B.sig.toks.size)
    if (denom < o.minUnitTokens || matched.length < o.topicMinMatched) return
    const containment = matched.length / denom
    if (containment < o.topicContainment) return
    const aOnly = [...A.sig.nums].filter((n) => !B.sig.nums.has(n))
    const bOnly = [...B.sig.nums].filter((n) => !A.sig.nums.has(n))
    // 数值呈包含关系（或一侧无数值）→ 不算数值冲突；互不包含 → 仅疑似。
    const numericDiff = A.sig.nums.size > 0 && B.sig.nums.size > 0 && aOnly.length > 0 && bOnly.length > 0
    if (numericDiff) {
      findings.push(makeFinding('possible-conflict', A, B, matched, containment, { numeric: { aOnly: aOnly.slice(0, 4), bOnly: bOnly.slice(0, 4) } }))
    } else if (containment >= o.dupContainment && matched.length >= o.dupMinMatched) {
      findings.push(makeFinding('duplicate', A, B, matched, containment, {}))
    }
  }

  // 失效条目再现：只查 today/review/pinned/profile（接口约定范围）。
  const inactive = (E, S) => {
    if (!INACTIVE_LAYERS.has(S.side.layer)) return
    if (!takeBudget()) return
    const matched = [...E.sig.toks].filter((t) => S.sig.toks.has(t))
    if (matched.length < o.inactiveMinMatched) return
    const containment = matched.length / E.sig.toks.size
    if (containment < o.inactiveContainment) return
    // 条目含数字时，要求其全部数字在来源中再现：否则更正后的新事实（只差数值）
    // 会误伤成“旧事实再现”。
    if (E.sig.nums.size > 0 && [...E.sig.nums].some((n) => !S.sig.nums.has(n))) return
    findings.push(makeFinding('inactive-reference', E, S, matched, containment, { state: E.state }))
  }

  for (const S of sourceUnits) for (const M of memoryUnits) cross(M, S)
  for (let i = 0; i < sourceUnits.length; i++) for (let j = i + 1; j < sourceUnits.length; j++) cross(sourceUnits[i], sourceUnits[j])
  for (const S of sourceUnits) for (const E of inactiveUnits) inactive(E, S)

  const key = (f) => f.a.layer + '\u0000' + f.a.sourceId + '\u0000' + f.b.layer + '\u0000' + f.b.sourceId + '\u0000' + f.basis.matchedTokens.join(',')
  findings.sort((x, y) =>
    (KIND_ORDER.get(x.kind) - KIND_ORDER.get(y.kind)) ||
    (y.basis.containment - x.basis.containment) ||
    (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0))
  if (findings.length > o.maxFindings) {
    truncated.findingsClipped = findings.length - o.maxFindings
    findings.length = o.maxFindings
  }

  return {
    ok: true,
    degraded,
    scanned: {
      sources: sourceUnits.length,
      sourceChars: sourceUnits.reduce((n, u) => n + u.text.length, 0),
      memoryEntries: memoryUnits.length,
      inactiveEntries: inactiveUnits.length,
      pairs: pairsExamined,
    },
    truncated,
    findings,
  }
}
