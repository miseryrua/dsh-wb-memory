// 每工作区仅保留最近一次系统提示组装；内存有界、重启清空，不持久化原始查询/正文/会话ID。
export function createRecallDiagnostics({ maxWorkspaces = 16, maxCandidates = 100 } = {}) {
  const latest = new Map()
  function sanitizeCrossLayer(value, includeEvidence) {
    if (!value || typeof value !== 'object') return null
    const kinds = { duplicate: '跨层存在高度相似片段；不代表事实矛盾。', 'possible-conflict': '相似主题出现不同参数值，需人工核实项目与时间范围。', 'inactive-reference': '已退场条目的内容仍可能出现在其它注入层。' }
    const text = (v, n = 160) => typeof v === 'string' ? v.slice(0, n) : ''
    const side = (s = {}) => ({ sourceId: text(s.sourceId, 100), layer: text(s.layer, 20), label: text(s.label), ...(includeEvidence ? { excerpt: text(s.excerpt) } : {}) })
    const rows = Array.isArray(value.findings) ? value.findings : []
    const findings = rows.filter(f => f && Object.hasOwn(kinds, f.kind)).slice(0, 20).map(f => ({ kind: f.kind, left: side(f.left), right: side(f.right), reason: kinds[f.kind] }))
    const number = v => Number.isFinite(v) && v >= 0 ? Math.min(v, 1e9) : 0
    return { scope: 'final-assembled-text', attribution: 'section-heading-heuristic', findings, degraded: Boolean(value.degraded), truncated: Boolean(value.truncated) || rows.length > findings.length, scannedSources: number(value.scannedSources), scannedChars: number(value.scannedChars), comparedPairs: number(value.comparedPairs) }
  }
  function sanitize(trace = {}, { includeEvidence = false } = {}) {
    trace = trace || {}
    const rows = trace.candidates || []
    const counts = {}
    for (const row of rows) counts[row.reason] = (counts[row.reason] || 0) + 1
    const candidates = [...rows].sort((a, b) => Number(b.reason === 'selected') - Number(a.reason === 'selected')).slice(0, maxCandidates).map(r => ({ title: String(r.title || '').slice(0, 160), index: r.index, score: r.score, matched: r.matched, contentMatched: r.contentMatched, rel: r.rel, reason: r.reason }))
    return {
      at: new Date().toISOString(), kind: 'assembled', workspace: trace.workspace || null,
      mode: trace.mode, queryChars: trace.queryChars || 0, queryTokens: trace.queryTokens || 0,
      total: trace.total || 0, selected: trace.selected || 0, counts, candidates,
      omitted: Math.max(0, rows.length - candidates.length),
      entries: (trace.entries || []).slice(0, maxCandidates).map(e => ({ title: String(e.title || '').slice(0, 160), cap: e.cap, bodyChars: e.bodyChars, plannedChars: e.plannedChars, present: e.present, truncated: e.truncated, finalFitMayTrim: e.finalFitMayTrim })),
      blockChars: trace.blockChars || 0, beforeFitChars: trace.beforeFitChars || 0,
      limitChars: trace.limitChars || 0, globalTrimmed: Boolean(trace.globalTrimmed),
      crossLayer: sanitizeCrossLayer(trace.crossLayer, includeEvidence),
    }
  }
  return {
    sanitize,
    record(trace) {
      if (!trace?.workspace) return
      const row = sanitize(trace)
      latest.delete(row.workspace)
      latest.set(row.workspace, row)
      while (latest.size > Math.max(1, maxWorkspaces)) latest.delete(latest.keys().next().value)
    },
    snapshot(workspace) { const row = latest.get(workspace); return row ? structuredClone(row) : null },
    clear() { latest.clear() },
  }
}
