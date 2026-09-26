/**
 * dsh-wb-memory 纯文本检索模块（无向量库/无 sqlite/无外部依赖）。
 * 借鉴 dsh-agent-memory（多维度评分）+ Max-Null/dsh-memory（CJK 单字+2-gram）
 * 的轻量思路，用于分层注入的 L2 相关条目召回 + L1 摘要层。
 *
 * MEMORY.md 约定（兼容自由格式，不破坏现有记忆）：
 *   - 每条记忆以 `## 标题` 分段；无标题则整篇作一条
 *   - 可选 frontmatter 行（紧跟标题后的注释行）：
 *     <!-- tags: 投资,基金 / date: 2026-08-20 / expiry: none / importance: high -->
 *   - 不带 frontmatter 的旧记忆也能用：靠正文关键词匹配
 */

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
export function readMemoryEntries(md) {
  if (!md) return []
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
      cur = { title: m[1].trim(), bodyLines: [], preLines: pendingComments }
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
  return entries
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

// ---------- 评分（标题>tag>首行>正文，近期 date + 高 importance 加成）----------
function scoreEntry(entry, queryTokens) {
  if (queryTokens.size === 0) return 0
  const titleTokens = tokenize(entry.title)
  const headTokens = tokenize(entry.headLine)
  const bodyTokens = tokenize(entry.body)
  const tagTokens = new Set()
  for (const t of entry.tags) for (const tk of tokenize(t)) tagTokens.add(tk)
  let score = 0
  for (const t of queryTokens) {
    if (titleTokens.has(t)) score += 3
    if (tagTokens.has(t)) score += 2
    if (headTokens.has(t)) score += 1.5
    if (bodyTokens.has(t)) score += 1
  }
  if (entry.date) {
    const d = new Date(entry.date)
    if (!isNaN(d.getTime())) {
      const days = (Date.now() - d.getTime()) / 86400000
      if (days < 30) score *= 1.2
      else if (days < 90) score *= 1.1
    }
  }
  if (entry.importance === 'high') score *= 1.3
  return score
}

// ---------- 召回 top-K ----------
// filter（v8，N2）：可选候选过滤，发生在评分之前——避免「先取 top-K 再过滤」
// 把排名靠后但符合条件（如日期范围）的条目挤掉。向后兼容：不传即不过滤。
export function retrieveRelevant(md, query, k = 5, filter = null) {
  const qt = tokenize(query)
  if (qt.size === 0) return []
  let entries = readMemoryEntries(md)
  if (filter) entries = entries.filter(filter)
  const scored = entries
    .map((e) => ({ e, s: scoreEntry(e, qt) }))
    .filter((x) => x.s > 0)
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, k).map((x) => x.e)
}

// ---------- 检索 + 日期过滤（N2，v8）----------
// memory_search 工具与 /wb-memory/search 端点共用的检索入口。
// 日期口径（与 Hana 一致）：条目无 frontmatter date 不过滤；有 date 则须落在
// [dateFrom, dateTo] 闭区间（边界可空；YYYY-MM-DD 字符串字典序即日期序）。
export function searchMemory(md, opts = {}) {
  const { q = '', dateFrom = null, dateTo = null, k = 5 } = opts
  if (!q) return []
  const inRange = (d) => {
    if (!d) return true
    if (dateFrom && d < dateFrom) return false
    if (dateTo && d > dateTo) return false
    return true
  }
  return retrieveRelevant(md, q, k, (e) => inRange(e.date))
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
