import { analyzeCrossLayer } from './cross-layer-diagnostics.js'
import { projectInjectionSources } from './injection-sources.js'
import { inspectMemory } from './memory-lifecycle.js'

// 整库只作退场状态的参照；不得将未注入的 current 候选冒充最终来源。
export function observeCrossLayer(block, memoryMd, analyze = analyzeCrossLayer) {
  try {
    const sources = projectInjectionSources(block)
    const sourceIds = new Set(sources.map(s => s.sourceId))
    let inactiveIds = new Set()
    try { inactiveIds = new Set(inspectMemory((memoryMd || '').slice(0, 200000)).records.filter(r => r.meta && r.meta.state !== 'current').map(r => r.meta.id)) } catch {}
    // 禁止整库current参与比对；整库只给出退场参照，所有现行来源取自最终文本。
    const raw = analyze({ memoryMd: memoryMd || '', sources }, { maxFindings: 2048, includeCurrentMemory: false })
    const eligible = f => sourceIds.has(f.a?.sourceId) && sourceIds.has(f.b?.sourceId) || f.kind === 'inactive-reference' && inactiveIds.has(f.a?.sourceId) && sourceIds.has(f.b?.sourceId)
    const findings = (raw.findings || []).filter(eligible)
    findings.sort((a,b) => Number(b.kind === 'inactive-reference') - Number(a.kind === 'inactive-reference'))
    return {
      findings: findings.map(f => ({ kind: f.kind, left: { ...f.a, excerpt: f.evidence?.a }, right: { ...f.b, excerpt: f.evidence?.b } })),
      degraded: !!raw.degraded?.length,
      truncated: Object.values(raw.truncated || {}).some(Boolean) || findings.length > 20,
      scannedSources: raw.scanned?.sources || 0, scannedChars: raw.scanned?.sourceChars || 0, comparedPairs: raw.scanned?.pairs || 0,
    }
  } catch { return { findings: [], degraded: true, truncated: false, scannedSources: 0, scannedChars: 0, comparedPairs: 0 } }
}
