// 字符预算（不是精确 token）。先保留说明/纪律，层预算之外的余量供召回。
export function injectionLimit(cfg = {}) {
  const n = Number(cfg.injectionMaxChars)
  return Number.isFinite(n) && n > 0 ? Math.max(4000, Math.floor(n)) : 12000
}
export function fitMemoryBlock(text, cfg = {}) {
  const limit = injectionLimit(cfg)
  if (text.length <= limit) return text
  const re = /^(?:## 全局用户记忆.*|### 置顶记忆.*|### 长期记忆 \/.*|### 今日日志.*|### 近 .*日回顾.*|## 当前工作区.*|## 可用工作区.*|## 记忆纪律.*)$/gm
  const heads = [...text.matchAll(re)]
  const parts = [{ text: text.slice(0, heads[0]?.index ?? text.length), kind: 'fixed' }]
  for (let i = 0; i < heads.length; i++) {
    const t = text.slice(heads[i].index, heads[i + 1]?.index ?? text.length)
    const kind = t.startsWith('## 全局用户') ? 'profile' : t.startsWith('### 置顶') ? 'pinned'
      : t.startsWith('### 长期') ? 'memory' : t.startsWith('### 今日日志') ? 'log'
      : t.startsWith('### 近 ') ? 'week' : t.startsWith('## 可用') ? 'workspaces' : 'fixed'
    parts.push({ text: t, kind })
  }
  let remaining = limit - parts.filter(p => p.kind === 'fixed').reduce((n, p) => n + p.text.length, 0)
  // 极端路径/纪律开销超限时仍保留纪律末尾，并标识预算截断。
  if (remaining < 0) return text.slice(0, 200) + '\n…(固定信息超预算)\n' + text.slice(-(limit - 230))
  const caps = { pinned: 1050, profile: 2050, log: 1550, week: 1250, workspaces: 500 }
  const rendered = new Map()
  for (const kind of ['pinned', 'profile', 'log', 'week', 'workspaces', 'memory']) {
    for (const p of parts.filter(p => p.kind === kind)) {
      const cap = Math.max(0, Math.min(remaining, kind === 'memory' ? remaining : caps[kind]))
      const value = clipSection(p.text, cap, kind === 'log')
      rendered.set(p, value)
      remaining -= value.length
    }
  }
  return parts.map(p => p.kind === 'fixed' ? p.text : rendered.get(p) || '').join('')
}
// 每条先给基础配额，再按相关分分配余量；短正文未用完的配额重新分配。
export function allocateEntryBudgets(ranked, pool, { base = 800, max = 2000 } = {}) {
  pool = Math.max(0, Math.floor(pool))
  const caps = ranked.map(r => Math.min(max, r.entry.body.length))
  const result = caps.map(n => Math.min(base, n))
  const used = result.reduce((a,b) => a+b, 0)
  if (used > pool) return result.map(n => Math.floor(n * pool / used))
  let remaining = pool - used
  for (let round = 0; round < ranked.length + 2 && remaining > 0; round++) {
    const eligible = ranked.map((r,i) => ({ i, score: Math.max(0.001, Number(r.score) || 0.001) })).filter(r => result[r.i] < caps[r.i])
    if (!eligible.length) break
    const total = eligible.reduce((n,r) => n+r.score, 0), available = remaining
    for (const r of eligible) {
      const add = Math.min(caps[r.i] - result[r.i], remaining, Math.max(1, Math.floor(available * r.score / total)))
      result[r.i] += add; remaining -= add
    }
  }
  return result
}
function clipSection(text, cap, tail) {
  if (text.length <= cap) return text
  const marker = '\n…(总预算截断，完整内容请按需读取)\n\n'
  const header = text.slice(0, text.indexOf('\n') + 1)
  if (cap < header.length + marker.length + 16) return ''
  const n = cap - header.length - marker.length
  const body = text.slice(header.length)
  return header + (tail ? body.slice(-n) : body.slice(0, n)) + marker
}
