import { memoryHeadings, memoryRevision } from './memory-markdown.js'
import { readMemoryEntries } from './retrieve.js'

export function splitSinkEntries(raw) {
  const records = memoryHeadings(raw)
  const starts = records.map(({ start }) => /(?:^|\n)([ \t]*<!-- tags:[^\r\n]*-->[ \t]*\r?\n)$/.exec(raw.slice(0, start))?.[1]?.length || 0)
  return { prefix: raw.slice(0, records.length ? records[0].start - starts[0] : raw.length), entries: records.map((r, i) => {
    const text = raw.slice(r.start - starts[i], records[i+1] ? records[i+1].start - starts[i+1] : raw.length)
    const meta = readMemoryEntries(text).find(e => e.title === r.title) || {}
    return { text, title: r.title, date: meta.date || '', importance: meta.importance, index: i }
  }) }
}
export const sinkKey = text => memoryRevision(text.trimEnd())
export function planColdSink(raw, threshold, heat = {}, retained = []) {
  const { prefix, entries } = splitSinkEntries(raw)
  const keys = new Set(retained)
  const rank = {low:0, medium:1, high:2}
  const ranked = entries.filter(e => !keys.has(sinkKey(e.text))).map(e => ({...e, heat: heat[memoryRevision(e.title.trim().toLowerCase())] || {}}))
  ranked.sort((a,b) => (rank[a.importance] ?? 1) - (rank[b.importance] ?? 1) || a.date.localeCompare(b.date) || (a.heat.count || 0) - (b.heat.count || 0) || (a.heat.lastExposedAt || '').localeCompare(b.heat.lastExposedAt || '') || a.index-b.index)
  const selected = new Set(); let after = raw.length
  for (const e of ranked) {
    if (after <= Math.floor(threshold * .8) || entries.length - selected.size <= 5) break
    selected.add(e.index); after -= e.text.length
  }
  return { hot: prefix + entries.filter(e => !selected.has(e.index)).map(e => e.text).join(''), moved: entries.filter(e => selected.has(e.index)), remaining: entries.length-selected.size }
}
