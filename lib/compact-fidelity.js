// 整理保真（迭代 D）：提炼回执由代码托管 + 事实锚点保留校验。全部为纯函数，无 IO。
//
// 为什么需要：2026-11-12 真实整理把 25623 字符压到 14052 字符并被「带警告接受」写回，
// 16 条提炼回执全丢（lifecyclePreserved 只看带稳定 ID 的条目，对无 ID 库形同虚设），
// 并丢了约束、限定条件与一个粗体小节主题。回执能否留下不应取决于模型自觉。

// ---------- 回执托管 ----------
// 回执 = <!-- wb-distill-batch:YYYY-MM-DD:<64 位十六进制> -->，见 index.js distillWorkspaceDate。
// 判定口径与 injection-slim.js 一致（宽松：允许空白差异），比较时折叠空白。
const RECEIPT_ONE = /<!--\s*wb-distill-batch:[^>]*?-->/
const RECEIPT_ALL = /<!--\s*wb-distill-batch:[^>]*?-->/g
const normReceipt = (s) => String(s).replace(/\s+/g, ' ').trim()

export function extractReceipts(text) {
  return (String(text ?? '').match(RECEIPT_ALL) || []).map(normReceipt)
}

// 摘出回执：整行都是回执的行连同换行删除；行内回执只删回执本身。
// 删行造成的「空行-空行」叠加折成一个，其余空白原样不动。没有回执时返回同一个字符串（逐字节不变）。
export function stripReceipts(text) {
  const s = String(text ?? '')
  if (!s.includes('wb-distill-batch')) return { text: s, receipts: [] }
  const receipts = []
  const lines = s.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!RECEIPT_ONE.test(line)) { out.push(line); continue }
    const rest = line.replace(RECEIPT_ALL, (m) => { receipts.push(normReceipt(m)); return '' })
    if (rest.trim() === '') {
      if (out.length && out[out.length - 1].trim() === '' && i + 1 < lines.length && lines[i + 1].trim() === '') i++
      continue
    }
    out.push(rest.replace(/[ \t]+$/, ''))
  }
  return { text: out.join('\n'), receipts }
}

// 写回：回执去重后按原文首次出现顺序，作为一个块放在文件末尾（与 distillWorkspaceDate 追加回执的位置一致）。
// 文本为空（模型无有效输出）时不补回执，避免把「空输出」变成「非空」。无回执时原样返回。
export function restoreReceipts(text, receipts) {
  const uniq = [...new Set(receipts || [])]
  const body = String(text ?? '')
  if (!uniq.length || body.trim() === '') return body
  return body.replace(/\s+$/, '') + '\n\n' + uniq.join('\n') + '\n'
}

// 硬校验：最终文本的回执集合必须等于原文回执集合——不多、不少、不重复。位置不限。
// 只返回计数，不返回回执内容。
export function checkReceiptsPreserved(original, final) {
  const expected = new Set(extractReceipts(original))
  const got = extractReceipts(final)
  const gotSet = new Set(got)
  const missing = [...expected].filter((r) => !gotSet.has(r)).length
  const extra = [...gotSet].filter((r) => !expected.has(r)).length
  const duplicated = got.length - gotSet.size
  return { ok: missing === 0 && extra === 0 && duplicated === 0, expected: expected.size, found: got.length, missing, extra, duplicated }
}

// ---------- 事实锚点 ----------
// 锚点 = 原文里可机械提取、改写后也应逐字存在的硬信息：反引号代码片段、路径与 URL、命令、
// 版本号、哈希、配置键（camelCase / snake_case / UPPER_SNAKE / 点分 / --选项 / 文件名）。
// 不含日期与普通数字（压缩时合理改写）、不含 <!-- --> 元数据行（生命周期校验已覆盖）。
// 比较口径：小写、反斜杠视为斜杠、空白折叠；按词边界匹配，避免短锚点命中无关子串。
export const ANCHOR_MIN_RETENTION = 0.85 // 全局保留率下限
export const ANCHOR_MAX_LOST_TOPICS = 0 // 允许丢失的主题数
export const ANCHOR_MIN_TOPIC_ANCHORS = 1 // 主题至少有这么多锚点才参与「主题丢失」判定

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/
const CMD_TOOLS = 'git|npm|pnpm|npx|node|pwsh|powershell|cmd|python3?|pip|curl|yarn|cargo|docker|winget|gh|dsh'
const norm = (s) => String(s).toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim()
const trimTail = (s) => s.replace(/[.,;:!?)\]}'"，。；：！？）、]+$/, '')

// 去掉元数据注释行与代码围栏标记行
function plainLines(text) {
  const { text: noReceipt } = stripReceipts(text)
  return noReceipt.split('\n').filter((l) => {
    const t = l.trim()
    if (t.startsWith('<!--') && t.endsWith('-->')) return false
    if (/^(?:\x60{3,}|~{3,})/.test(t)) return false
    return true
  })
}

export function extractAnchors(text) {
  let s = (Array.isArray(text) ? text : plainLines(text)).join('\n')
  const found = new Set()
  const add = (v) => { const k = norm(v); if (k.length >= 2) found.add(k) }
  // 反引号片段：仅取不含中日韩字符、含字母数字的（含中文的多为散文式强调，不是机械事实）
  for (const m of s.matchAll(/\x60([^\x60\n]{2,60})\x60/g)) {
    const v = m[1].trim()
    if (!CJK.test(v) && /[A-Za-z0-9]/.test(v)) add(v)
  }
  // URL（任意协议头；先取出，避免其内部再被当作路径或盘符）
  s = s.replace(/(?<![\w])[a-z][a-z0-9+.-]*:\/\/[^\s\x60'"<>)）\]\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/gi, (u) => { add(trimTail(u)); return ' ' })
  // Windows 路径
  s = s.replace(/(?<![\w])[A-Za-z]:[\\/][^\s\x60'"<>|*?，。；：、（）()\u3400-\u9fff]+/g, (p) => { add(trimTail(p)); return ' ' })
  // POSIX / 相对路径：有前缀、或≥2 级、或末段带扩展名、或单斜杠且某段含 - _ . 数字
  for (const m of s.matchAll(/(?<![\w.\/\\-])((?:\.{1,2}\/|~\/|\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+)\/?(?![\w])/g)) {
    const p = trimTail(m[1])
    const segs = p.split('/').filter((x) => x && x !== '.' && x !== '..' && x !== '~')
    if (segs.length < 2 || !segs.some((x) => /[A-Za-z]/.test(x))) continue
    const prefixed = /^(?:\.{1,2}\/|~\/|\/)/.test(p)
    const ext = /\.\w{1,6}$/.test(segs[segs.length - 1])
    const decorated = segs.some((x) => /[-_.0-9]/.test(x))
    if (prefixed || segs.length >= 3 || ext || decorated) add(p)
  }
  // 命令：已知工具名 + 子命令（+ 一个选项）
  for (const m of s.matchAll(new RegExp('(?<![\\w-])(?:' + CMD_TOOLS + ')\\s+[A-Za-z][\\w:./-]*(?:\\s+-{1,2}[A-Za-z][\\w-]*)?', 'g'))) add(m[0])
  // 版本号：x.y.z[-pre] 与 vX.Y
  for (const m of s.matchAll(/(?<![\w.])v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?(?![\w])/g)) add(trimTail(m[0]))
  for (const m of s.matchAll(/(?<![\w.])v\d+\.\d+(?![\w.])/g)) add(m[0])
  // 哈希 / 提交号：7-64 位十六进制，须同时含数字与 a-f 字母
  for (const m of s.matchAll(/(?<![0-9A-Za-z])[0-9a-f]{7,64}(?![0-9A-Za-z])/g)) if (/\d/.test(m[0]) && /[a-f]/.test(m[0])) add(m[0])
  // 配置键 / 标识符
  for (const m of s.matchAll(/(?<![\w.\/\\-])[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+(?![\w])/g)) add(m[0]) // camelCase
  for (const m of s.matchAll(/(?<![\w])(?:[A-Z][a-z0-9]+){2,}(?![\w])/g)) add(m[0]) // PascalCase（≥2 节）
  for (const m of s.matchAll(/(?<![\w])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w])/g)) add(m[0]) // snake_case
  for (const m of s.matchAll(/(?<![\w])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\w])/g)) add(m[0]) // UPPER_SNAKE
  for (const m of s.matchAll(/(?<![\w-])--[a-z][\w-]*/g)) add(m[0]) // --选项
  for (const m of s.matchAll(/(?<![\w.\/\\-])[a-z][a-z0-9_]+(?:\.[a-z][a-z0-9_]+){2,}(?![\w])/g)) add(m[0]) // a.b.c 点分键（≥3 段）
  for (const m of s.matchAll(/(?<![\w\/\\.-])[\w.-]*[A-Za-z0-9_-]\.(?:js|mjs|cjs|ts|tsx|json|md|ya?ml|ps1|py|cmd|bat|txt|html|css|toml|ini|lock|log|exe|zip)(?![\w])/g)) add(m[0]) // 文件名
  return [...found]
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
function makePresence(finalText) {
  const hay = norm(plainLines(finalText).join('\n'))
  const cache = new Map()
  return (key) => {
    if (cache.has(key)) return cache.get(key)
    const head = /\w/.test(key[0]) ? '(?<![\\w])' : ''
    const tail = /\w/.test(key[key.length - 1]) ? '(?![\\w])' : ''
    const hit = new RegExp(head + escapeRe(key) + tail).test(hay)
    cache.set(key, hit)
    return hit
  }
}

// 主题 = 每个 ## 条目；条目内以粗体开头的行（**小节名** …）起一个小节，到下一个粗体行或条目结束。
export function splitTopics(text) {
  const topics = []
  let entry = null, section = null
  for (const line of plainLines(text)) {
    if (/^##\s/.test(line)) { entry = { kind: 'entry', lines: [line] }; topics.push(entry); section = null; continue }
    if (!entry) continue // 一级标题与前言不是主题
    entry.lines.push(line)
    if (/^\s*\*\*[^*\n]+\*\*/.test(line)) { section = { kind: 'section', lines: [line], parent: entry }; topics.push(section) }
    else if (section) section.lines.push(line)
  }
  return topics
}

// 硬校验：原文 → 候选输出。通过条件：全局保留率 ≥ minRetention，且丢失主题数 ≤ maxLostTopics。
// 原文没有任何锚点时空通过。返回结构只含计数与少量缺失锚点样本（样本仅供反馈给模型，不应持久化）。
export function checkAnchorFidelity(original, candidate, opts = {}) {
  const minRetention = opts.minRetention ?? ANCHOR_MIN_RETENTION
  const maxLostTopics = opts.maxLostTopics ?? ANCHOR_MAX_LOST_TOPICS
  const minTopicAnchors = opts.minTopicAnchors ?? ANCHOR_MIN_TOPIC_ANCHORS
  const anchors = extractAnchors(original)
  const has = makePresence(candidate)
  const missing = anchors.filter((a) => !has(a))
  const total = anchors.length
  const kept = total - missing.length
  const retention = total ? kept / total : 1
  // 主题判定只看「独有锚点」：同一锚点出现在多个主题里（如通用命令 npm run、共用文件名）时，
  // 它在候选里还在并不能证明本主题还在，会掩盖整条丢失。条目的独有锚点 = 不出现在其它任何条目；
  // 小节的独有锚点 = 不出现在其它任何小节、也不出现在其它条目。
  const tl = splitTopics(original).map((t) => ({ t, set: new Set(extractAnchors(t.lines)) }))
  const entries = tl.filter((x) => x.t.kind === 'entry')
  let topics = 0, lostEntries = 0, lostSections = 0
  const lostEntrySet = new Set()
  for (const x of tl) {
    const parent = x.t.parent
    const own = [...x.set].filter((a) => x.t.kind === 'entry'
      ? !entries.some((y) => y !== x && y.set.has(a))
      : !tl.some((y) => y !== x && y.t !== parent && y.set.has(a)))
    if (own.length < minTopicAnchors) continue
    topics++
    if (!own.every((a) => !has(a))) continue
    if (x.t.kind === 'entry') { lostEntries++; lostEntrySet.add(x.t) }
    else if (!lostEntrySet.has(parent)) lostSections++ // 整条已丢时不再重复计其内部小节
  }
  const lostTopics = lostEntries + lostSections
  const ok = retention >= minRetention && lostTopics <= maxLostTopics
  return { ok, total, kept, retention, topics, lostTopics, lostEntries, lostSections, missingSample: missing.slice(0, 8).map((a) => a.slice(0, 60)) }
}

// 信息项（不参与硬校验）：行首粗体小节标题在候选中是否仍以文本出现。
// 只用于汇报与验收脚本：模型合并改写标题时会有误报，故不作为拒收条件。
export function boldTitleRetention(original, candidate) {
  const hay = norm(String(candidate ?? '').replace(/\*\*/g, ''))
  let total = 0, kept = 0
  for (const line of plainLines(original)) {
    const m = /^\s*\*\*([^*\n]+)\*\*/.exec(line)
    if (!m) continue
    const t = norm(m[1].replace(/[：:\s]+$/, ''))
    if (!t) continue
    total++
    if (hay.includes(t)) kept++
  }
  return { total, kept }
}
