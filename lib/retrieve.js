/**
 * dsh-wb-memory 纯文本检索模块（无向量库/无 sqlite/无外部依赖）。
 * 借鉴 dsh-agent-memory（多维度评分）+ Max-Null/dsh-memory（CJK 单字+2-gram）
 * 的轻量思路，用于分层注入的 L2 相关条目召回 + L1 摘要层。
 *
 * v10.0（2026-10-14）检索升级（依据《可行性评审.md》第 1 条）：
 *   - 检索改用独立分词 tokenizeForRetrieval（英文词/错误码/路径 + 中文「连续片段」
 *     bigram + 低权重单字 + 中英停用词），评分改为字段加权 IDF（非完整 BM25）；
 *   - 查重口径逐字不变：tokenize / jaccard / overlapCoeff / detectDuplicates 仍用
 *     旧分词（dupThreshold=0.45 是按旧分词实测标定的，换分词会悄悄改「近重复」语义）；
 *   - 新增 rankMemory 返回 score/rel（供动态预算等消费方），旧函数输出形状不变。
 *
 * MEMORY.md 约定（兼容自由格式，不破坏现有记忆）：
 *   - 每条记忆以 `## 标题` 分段；无标题则整篇作一条
 *   - 可选 frontmatter 行（紧跟标题后的注释行）：
 *     <!-- tags: 投资,基金 / date: 2026-08-20 / expiry: none / importance: high -->
 *   - 不带 frontmatter 的旧记忆也能用：靠正文关键词匹配
 */

import { inspectMemory } from './memory-lifecycle.js'

// ---------- MEMORY.md 解析 ----------
// 兼容两种 frontmatter 位置（v7.1 修复）：
//   A. 注释行在条目标题【之后】（人工书写习惯）：
//        ## 标题
//        <!-- tags: ... / date: ... -->
//        正文
//   B. 注释行在条目标题【之前】（auto-distill 产出格式，见 distillSystemPrompt）：
//        <!-- tags: ... / date: ... -->
//        ## 标题
//        正文
//   旧版只解析 A：对 B 格式条目 tags/date/importance 全部丢失，评分加成
//   （近期日期 ×1.2、high ×1.3）对 distill 条目完全失效。
// 另：文件级 H1（如 "# 项目长期记忆"）与空行不计入条目，避免「（前言）」噪音。
export function readMemoryEntries(md, { includeInactive = false } = {}) {
  if (!md) return []
  let lifecycle = null, ordinal = 0
  if (/<!--\s*wb-memory\b/i.test(md)) {
    try { lifecycle = inspectMemory(md) } catch { return [] } // 损坏元数据不可重新当作当前事实。
    md = lifecycle.records.reduceRight((s,r) => r.markerLength ? s.slice(0,r.start+r.headLength)+s.slice(r.start+r.headLength+r.markerLength) : s, md)
  }
  const lines = md.split(/\r?\n/)
  const entries = []
  let cur = null
  let pendingComments = [] // 悬空注释行：归给下一个出现的 ## 条目（格式 B）
  for (const ln of lines) {
    if (/^#\s/.test(ln)) continue // 文件级 H1 标题：非条目内容，跳过
    const m = /^##\s+(.*)$/.exec(ln)
    if (m) {
      if (cur) {
        // 上一条正文末尾紧贴本标题的注释行：属于本条目的 frontmatter（格式 B）
        const tail = []
        while (cur.bodyLines.length && /^<!--/.test(cur.bodyLines[cur.bodyLines.length - 1].trim())) {
          tail.unshift(cur.bodyLines.pop())
        }
        pendingComments = tail.concat(pendingComments)
        entries.push(cur)
      }
      const meta = lifecycle?.records[ordinal++]?.meta
      cur = { title: m[1].trim(), bodyLines: [], preLines: pendingComments, ...(meta ? { memoryId: meta.id, status: meta.state } : {}) }
      pendingComments = []
    } else if (cur) {
      cur.bodyLines.push(ln)
    } else if (ln.trim()) {
      if (/^<!--/.test(ln.trim())) {
        pendingComments.push(ln) // 文件开头/条目间的悬空注释：归下一条目
      } else {
        cur = { title: '（前言）', bodyLines: [ln], preLines: [] }
      }
    }
  }
  if (cur) entries.push(cur)
  for (const e of entries) {
    const fm = parseFrontmatter([...(e.preLines || []), ...e.bodyLines])
    e.tags = fm.tags
    e.date = fm.date
    e.expiry = fm.expiry
    e.importance = fm.importance
    // headLine：跳过 frontmatter 注释行与空行后的第一条实际内容
    e.body = e.bodyLines.join('\n').trim()
    e.headLine = e.body.split('\n').find((x) => x.trim() && !/^<!--/.test(x.trim())) || ''
  }
  return includeInactive ? entries : entries.filter(e => !e.status || e.status === 'current')
}

// date 归一化（审查 S6，2026-09-01）：手写 frontmatter 可能是非零填充
// （`2026-8-5`），字符串字典序比较会让日期过滤出错（'2026-8-5' > '2026-08-10'）。
// 归一化为 YYYY-MM-DD；非法值置 null（该条目随即可被日期过滤跳过——不过滤，
// 与 Hana 口径一致，是安全方向）。
function normalizeDate(v) {
  const s = String(v || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function parseFrontmatter(lines) {
  const out = { tags: [], date: null, expiry: null, importance: null }
  for (const ln of lines.slice(0, 6)) {
    const m = /^<!--\s*(.*)-->\s*$/.exec(ln)
    if (!m) continue
    for (const p of m[1].split('/').map((s) => s.trim())) {
      const idx = p.indexOf(':')
      if (idx < 0) continue
      const k = p.slice(0, idx).trim()
      const v = p.slice(idx + 1).trim()
      if (k === 'tags') out.tags = v.split(',').map((s) => s.trim()).filter(Boolean)
      else if (k === 'date') out.date = normalizeDate(v)
      else if (k === 'expiry') out.expiry = v
      else if (k === 'importance') out.importance = v
    }
  }
  return out
}

// ---------- 分词（CJK 单字 + 2-gram + 英文词）----------
export function tokenize(text) {
  if (!text) return new Set()
  const set = new Set()
  const lower = String(text).toLowerCase()
  const en = lower.match(/[a-z][a-z0-9_-]{1,}/g) || []
  for (const w of en) set.add(w)
  const cjk = lower.match(/[\u4e00-\u9fff]/g) || []
  for (const c of cjk) set.add(c)
  for (let i = 0; i < cjk.length - 1; i++) set.add(cjk[i] + cjk[i + 1])
  return set
}

// ---------- 检索专用分词与评分（v10.0，2026-10-14）----------
// 为什么另起一套：查重的 tokenize + dupThreshold=0.45 是实测标定值，检索需要的是
// 「命中关键术语」而不是「字面重合」，两者的最优分词并不相同（评审第 1 条要求解耦）。
//
// 口径要点：
//   ① 先按字符类切段，段内才做 bigram —— 不跨标点、不把英文与中文拼成伪 bigram。
//      「配置 node 报错」只产出【配置】【报错】，不产出本来不存在的【置报】。
//   ② 中文「连续片段」bigram + 低权重单字：单字只兜底召回，不主导排名。
//   ③ 中英停用词：只剔「单字/单词」token；bigram 仅在「两字皆停用字」时丢弃，绝不
//      按字禁 bigram（否则「上海」「会上」这类合法词被误伤——评审点名）。
//   ④ 错误码 / 路径 / 含数字的标识符给高权重：精准术语是第一命中来源。
//   ⑤ 字段加权 IDF：title > tags > head > body，tf 只做对数饱和。这是字段加权 IDF，
//      不是完整 BM25/BM25F（没有 k1/b、没有长度归一化）；是否继续升级另测。
//   ⑥ 无关召回控制：只命中低权重单字的条目不进候选；命中词全是「近乎每条都有」
//      的词（IDF 极低）也不进候选；相对 top 分过低的靠后条目被裁掉（不硬填充）。

const FIELD_WEIGHTS = [
  ['title', 3],
  ['tags', 2.5],
  ['head', 1.5],
  ['body', 1],
]

// 英文功能词（无语义区分度）。只影响单词 token，不影响任何 bigram。
const STOP_EN = new Set(
  (
    'a an the and or not no yes is are was were be been being am do does did doing ' +
    'have has had will would can could should shall may might must to of in on at by ' +
    'for with from as into over under about it its this that these those i you he she ' +
    'they we me my your his her their our us them if then than so but when where which ' +
    'who what how why there here all any each more most some such only own same too very'
  ).split(' '),
)

// 中文单字停用词：只剔「单字 token」，绝不用来剔 bigram。
const STOP_CJK = new Set([
  '的', '了', '着', '过', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '是', '在', '与', '及',
  '或', '和', '也', '就', '才', '又', '还', '再', '很', '太', '更', '最', '们', '我', '你',
  '他', '她', '它', '这', '那', '哪', '什', '么', '怎', '样', '为', '以', '之', '其', '于',
  '由', '被', '把', '给', '对', '从', '向', '往', '个', '些', '上', '下', '里', '外', '得',
  '地', '所', '如', '若', '则', '并', '且', '但', '却', '因', '故', '自', '等', '不', '没', '无',
])

const W_CODE = 1.6 // 错误码 / 含数字标识符 / 长全大写（精确术语）
const W_PATH = 1.4 // 路径
const W_WORD = 1 // 普通英文词
const W_BIGRAM = 1 // 中文连续片段 bigram
const W_SUB = 0.8 // 长标识符按分隔符拆出的子词
const W_SINGLE = 0.35 // 中文单字（低权重兜底）

const CONTENT_WEIGHT = 0.5 // ≥ 该权重的命中才算「有区分度」；单字（0.35）不算
const DEFAULT_REL_RATIO = 0.2 // 相对 top 分过低的条目不进候选（无关召回控制）
const DEFAULT_MIN_CONTENT_IDF = 0.1 // 命中词全是「近乎每条都有」的词 → 无区分信号

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const JOIN_CHAR = /[-_.+@/\\#]/
const JOIN_SPLIT = /[-_.+@/\\#]+/

// 全角 ASCII → 半角：真实日志里出现过全角错误码/数字，不归一化就匹配不上。
function foldWidth(s) {
  return s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

function classifyWord(trimmed, lower) {
  if (/^0x[0-9a-f]+$/.test(lower)) return W_CODE
  const hasDigit = /\d/.test(lower)
  const hasAlpha = /[a-z]/.test(lower)
  if (hasDigit && hasAlpha) return W_CODE // err11 / win32 / utf8 / sha256 / s4 / v10.0.0
  if (/^\d+$/.test(lower)) return lower.length >= 3 ? W_CODE : W_WORD // 429/404 是错误码，5/22 不是
  if (lower.includes('_')) return W_CODE // err_module_not_found
  if (hasAlpha && trimmed === trimmed.toUpperCase() && lower.length >= 3) return W_CODE // EPERM/ENOENT
  if (/[/\\]/.test(lower)) return W_PATH
  return W_WORD
}

// 切段扫描：段 = 同类字符的极大连续区（汉字段 / 单词段）；段内才产出 bigram 与子词。
// 段间（标点、空白、中英交界）一律不拼，故不会产出跨标点或中英混合的伪 bigram。
function scanTokens(text) {
  const out = []
  if (text == null) return out
  const s = foldWidth(String(text))
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (CJK_CHAR.test(ch)) {
      let j = i + 1
      while (j < s.length && CJK_CHAR.test(s[j])) j++
      const run = s.slice(i, j)
      for (let k = 0; k < run.length; k++) {
        // bigram 只在「两字都是停用字」时丢弃（如「的了」「吗呢」）；只要有一个实义字
        // 就保留——否则「上海」「会上」「不存」这类合法词会被误伤（评审点名）。
        if (k + 1 < run.length && !(STOP_CJK.has(run[k]) && STOP_CJK.has(run[k + 1]))) {
          out.push({ tok: run.slice(k, k + 2), w: W_BIGRAM })
        }
        if (!STOP_CJK.has(run[k])) out.push({ tok: run[k], w: W_SINGLE })
      }
      i = j
    } else if (/[a-z0-9]/i.test(ch)) {
      let j = i + 1
      while (j < s.length && (/[a-z0-9]/i.test(s[j]) || JOIN_CHAR.test(s[j]))) j++
      const trimmedRun = s.slice(i, j).replace(/^[-_.+@/\\#]+/, '').replace(/[-_.+@/\\#]+$/, '')
      if (trimmedRun) {
        const lower = trimmedRun.toLowerCase()
        if (lower.length >= 2 || /\d/.test(lower)) {
          if (!STOP_EN.has(lower)) out.push({ tok: lower, w: classifyWord(trimmedRun, lower) })
          if (JOIN_CHAR.test(lower)) {
            for (const part of lower.split(JOIN_SPLIT)) {
              if (!part || part === lower) continue
              if (part.length < 2 && !/\d/.test(part)) continue
              if (STOP_EN.has(part)) continue
              out.push({ tok: part, w: W_SUB })
            }
          }
        }
      }
      i = j
    } else {
      i++
    }
  }
  return out
}

// 查询侧：token → 权重（同一 token 出现多次取最大权重）。
export function tokenizeForRetrieval(text) {
  const m = new Map()
  for (const t of scanTokens(text)) {
    const cur = m.get(t.tok)
    if (cur === undefined || t.w > cur) m.set(t.tok, t.w)
  }
  return m
}

// 文档侧：token → { w, tf }（tf 供对数饱和用）。
export function analyzeRetrievalText(text) {
  const m = new Map()
  for (const t of scanTokens(text)) {
    const cur = m.get(t.tok)
    if (cur) {
      cur.tf += 1
      if (t.w > cur.w) cur.w = t.w
    } else {
      m.set(t.tok, { w: t.w, tf: 1 })
    }
  }
  return m
}

function entryFieldTokens(entry) {
  return {
    title: analyzeRetrievalText(entry.title),
    tags: analyzeRetrievalText((entry.tags || []).join(' ')),
    head: analyzeRetrievalText(entry.headLine),
    body: analyzeRetrievalText(entry.body),
  }
}

// 语料索引：df 按「条目」计（同一词在一条内跨字段只计一次），idf 取 BM25 的平滑式
// （小语料不会退化成 0，也不会出现负值）。
function buildCorpusIndex(fieldList) {
  const N = fieldList.length
  const df = new Map()
  for (const f of fieldList) {
    const seen = new Set()
    for (const name of ['title', 'tags', 'head', 'body']) for (const t of f[name].keys()) seen.add(t)
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1)
  }
  return {
    N,
    idf(t) {
      const d = df.get(t) || 0
      return Math.log(1 + (N - d + 0.5) / (d + 0.5))
    },
  }
}

// 单条评分 = Σ_查询词 (查询词权重 × idf(词) × Σ_字段(字段权重 × (1 + ln tf)))。
function scoreEntryIdf(fields, qTokens, index) {
  let score = 0
  let matched = 0
  let contentMatched = 0
  let bestContentIdf = 0
  for (const [t, qw] of qTokens) {
    let fieldSum = 0
    for (const [name, fw] of FIELD_WEIGHTS) {
      const at = fields[name].get(t)
      if (at) fieldSum += fw * (1 + Math.log(at.tf))
    }
    if (fieldSum === 0) continue
    const idf = index.idf(t)
    matched++
    if (qw >= CONTENT_WEIGHT) {
      contentMatched++
      if (idf > bestContentIdf) bestContentIdf = idf
    }
    score += qw * idf * fieldSum
  }
  return { score, matched, contentMatched, bestContentIdf }
}

// 既有偏好保持不变（v10 只改命中口径，不悄悄改时间/重要度加成）：
// 30 天内 ×1.2、90 天内 ×1.1；importance=high ×1.3。
function entryBonus(entry) {
  let mul = 1
  if (entry.date) {
    const d = new Date(entry.date)
    if (!isNaN(d.getTime())) {
      const days = (Date.now() - d.getTime()) / 86400000
      if (days < 30) mul *= 1.2
      else if (days < 90) mul *= 1.1
    }
  }
  if (entry.importance === 'high') mul *= 1.3
  return mul
}

// 日期口径（与 Hana 一致）：条目无 frontmatter date 不过滤；有 date 则须落在
// [dateFrom, dateTo] 闭区间（边界可空；YYYY-MM-DD 字符串字典序即日期序）。
function inDateRange(d, dateFrom, dateTo) {
  if (!d) return true
  if (dateFrom && d < dateFrom) return false
  if (dateTo && d > dateTo) return false
  return true
}

// ---------- 打分明细（v10.0 新增，供动态预算等消费方）----------
// 返回 [{ entry, score, rel, matched, contentMatched }]：score 为字段加权 IDF 原始分
// （已含时间/重要度加成），rel = score / top（便于按比例设预算门槛）。排序稳定：
// 同分按条目在 MEMORY.md 中的原顺序。
// options:
//   k            条数上限（默认 5）
//   filter       候选过滤（在评分前执行，避免先取 top-K 再过滤挤掉靠后合格条目，
//                与 v8 的既有语义一致）
//   dateFrom/dateTo  条目 frontmatter date 闭区间过滤
//   relRatio     低于 top×该比例的条目裁掉（默认 0.2；传 0 关闭）
//   minContentIdf  命中词中最高 idf 低于该值时视为无区分信号（默认 0.1；传 0 关闭）
export function rankMemory(md, query, opts = {}) {
  const {
    k = 5,
    filter = null,
    dateFrom = null,
    dateTo = null,
    relRatio = DEFAULT_REL_RATIO,
    minContentIdf = DEFAULT_MIN_CONTENT_IDF,
  } = opts
  // 旁路审计：不携正文，不改变排序/返回值，回调故障不影响主路径。
  const audit = typeof opts.onDiagnostics === 'function' ? { candidates: [], total: 0, queryTokens: 0 } : null
  const finish = (result) => {
    if (audit) { try { opts.onDiagnostics({ ...audit, selected: result.length }) } catch {} }
    return result
  }
  const qTokens = tokenizeForRetrieval(query)
  if (/<!--\s*wb-memory\b/i.test(md)) {
    try { inspectMemory(md) } catch {
      if (audit) audit.candidates.push({ title: '元数据异常', reason: 'invalid-metadata', score: 0 })
      return finish([])
    }
  }
  let entries = readMemoryEntries(md, { includeInactive: true })
  if (audit) audit.total = entries.length
  entries = entries.filter(e => {
    const keep = !e.status || e.status === 'current'
    if (!keep && audit) audit.candidates.push({ title: e.title, reason: e.status, score: 0 })
    return keep
  })
  if (audit) audit.queryTokens = qTokens.size
  if (qTokens.size === 0) {
    if (audit) audit.candidates.push(...entries.map((e, i) => ({ index: i, title: e.title, reason: 'empty-query', score: 0 })))
    return finish([])
  }
  // 查询里一个「有区分度」的词都没有（例如只输入一个汉字）：退化为允许单字命中，
  // 否则单字检索永远返回空——那是可用性倒退，不是降噪。
  let qContent = 0
  for (const [, w] of qTokens) if (w >= CONTENT_WEIGHT) qContent++
  if (dateFrom || dateTo) entries = entries.filter((e) => {
    const keep = inDateRange(e.date, dateFrom, dateTo)
    if (!keep && audit) audit.candidates.push({ title: e.title, reason: 'date-filter', score: 0 })
    return keep
  })
  if (filter) entries = entries.filter(filter)
  if (entries.length === 0) return finish([])
  const fieldList = entries.map(entryFieldTokens)
  const index = buildCorpusIndex(fieldList)
  const scored = []
  for (let i = 0; i < entries.length; i++) {
    const m = scoreEntryIdf(fieldList[i], qTokens, index)
    const row = { index: i, title: entries[i].title, score: m.score * entryBonus(entries[i]), matched: m.matched, contentMatched: m.contentMatched, reason: 'eligible' }
    if (audit) audit.candidates.push(row)
    if (!(m.score > 0)) { row.reason = 'no-match'; continue }
    // 无关召回控制①：有区分度查询下，只命中低权重单字的条目不参与排名。
    if (qContent > 0 && m.contentMatched === 0) { row.reason = 'weak-single'; continue }
    // 无关召回控制②：命中的有区分度词 IDF 全低（近乎每条都有）→ 视为无区分信号。
    if (qContent > 0 && m.bestContentIdf < minContentIdf) { row.reason = 'low-idf'; continue }
    scored.push({
      entry: entries[i],
      score: m.score * entryBonus(entries[i]),
      matched: m.matched,
      contentMatched: m.contentMatched,
      _i: i,
    })
  }
  if (scored.length === 0) return finish([])
  scored.sort((a, b) => b.score - a.score || a._i - b._i)
  const top = scored[0].score
  const floor = relRatio > 0 ? top * relRatio : 0
  const kept = scored.filter((x) => x.score >= floor)
  const chosen = kept.slice(0, k)
  if (audit) {
    audit.floor = floor
    audit.candidates.forEach((r) => {
      if (r.reason !== 'eligible') return
      r.rel = top > 0 ? r.score / top : 0
      r.reason = r.score < floor ? 'relative-floor' : chosen.some(x => x._i === r.index) ? 'selected' : 'top-k'
    })
  }
  return finish(chosen.map((x) => {
    const { _i, ...rest } = x
    return { ...rest, rel: top > 0 ? x.score / top : 0 }
  }))
}

// ---------- 召回 top-K（旧接口，输出形状与语义不变）----------
// filter（v8，N2）：可选候选过滤，发生在评分之前——避免「先取 top-K 再过滤」
// 把排名靠后但符合条件（如日期范围）的条目挤掉。向后兼容：不传即不过滤。
export function retrieveRelevant(md, query, k = 5, filter = null) {
  return rankMemory(md, query, { k, filter }).map((x) => x.entry)
}

// ---------- 检索 + 日期过滤（N2，v8；v10 内部改走 rankMemory）----------
// memory_search 工具与 /wb-memory/search 端点共用的检索入口。
export function searchMemory(md, opts = {}) {
  const { q = '', dateFrom = null, dateTo = null, k = 5 } = opts
  if (!q) return []
  return rankMemory(md, q, { k, dateFrom, dateTo }).map((x) => x.entry)
}

// ---------- 摘要层（每条标题+首行，按预算截断）----------
// headLine 截短到 100 字符：真实记忆的首行常是 150+ 字符的完整结论，
// 不截短时 1500 预算只能容纳 ~5 条，截短后可见条目数翻倍以上。
export function summarizeEntries(md, budget = 1500) {
  const entries = readMemoryEntries(md)
  const lines = []
  let total = 0
  for (const e of entries) {
    let head = e.headLine || ''
    if (head.length > 100) head = head.slice(0, 100) + '…'
    const line = `- **${e.title}**` + (head ? `：${head}` : '')
    if (total + line.length > budget) break
    lines.push(line)
    total += line.length
  }
  if (!lines.length) return '（MEMORY.md 为空或无条目）'
  if (lines.length < entries.length) {
    lines.push(`- …（共 ${entries.length} 条，已列前 ${lines.length} 条；其余用 /wb-memory/search 检索或直读 MEMORY.md）`)
  }
  return lines.join('\n')
}

// ---------- 近重复检测（Jaccard）----------
// 集合相似度 = 交集 ÷ 并集，衡量两条记忆是否在说同一件事。
// 借鉴 dsh-agent-memory：阈值默认 0.7，≥阈值判定为近重复，建议合并。
export function jaccard(textA, textB) {
  const a = tokenize(textA)
  const b = tokenize(textB)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// 重叠率：交集 ÷ 较短集合大小。对"新条目覆盖重写旧条目"型重复（记忆演化常见形态）
// 远比 Jaccard 敏感 —— Jaccard 会把分母撑成并集，一边增删内容就稀释相似度。
export function overlapCoeff(textA, textB) {
  const a = tokenize(textA)
  const b = tokenize(textB)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / Math.min(a.size, b.size)
}

// 两两比对 MEMORY.md 条目，返回疑似重复对（按综合分降序）。
// 综合分 = max(Jaccard, 重叠率)：Jaccard 抓"等长改写"，重叠率抓"子集演化"。
// 注：本插件 tokenize 含 CJK 单字+2-gram，特征空间比纯词级稀疏，纯 Jaccard 阈值
// 不能照搬 dsh-agent-memory 的 0.7（实测近重复对仅 ~0.3），故降为 0.45 并取双指标最大值
// （实测：等长改写 0.45 / 覆盖演化 0.9 / 同题不同事 0.08 / 无关 0.00）。
// v10.0：本段（tokenize/jaccard/overlapCoeff/detectDuplicates）刻意不动——检索已另起
// tokenizeForRetrieval，查重口径必须保持逐字不变。
export function detectDuplicates(md, threshold = 0.45) {
  const entries = readMemoryEntries(md)
  const pairs = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const ta = entries[i].title + '\n' + entries[i].body
      const tb = entries[j].title + '\n' + entries[j].body
      const score = Math.max(jaccard(ta, tb), overlapCoeff(ta, tb))
      if (score >= threshold) {
        pairs.push({ a: entries[i].title, b: entries[j].title, sim: Number(score.toFixed(2)) })
      }
    }
  }
  pairs.sort((x, y) => y.sim - x.sim)
  return pairs
}
