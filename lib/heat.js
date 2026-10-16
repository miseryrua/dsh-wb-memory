// 仅曝光统计，不影响检索权重/置顶/归档。同步注入路径只入队，IO在定时器。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicJson, fingerprint } from './distill-cursor.js'
export function readHeat(dir) {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'heat.json'), 'utf8'))
    if (value?.version === 1 && value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)) return value
  } catch {}
  return { version: 1, entries: {} }
}
export function createHeatTracker({ delayMs = 5000, now = () => new Date().toISOString() } = {}) {
  const seen = new Set(), pending = new Map()
  let timer = null
  function queue(dir, turnKey, titles) {
    if (!dir || !turnKey || !titles.length) return
    const key = dir + ':' + turnKey
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > 512) seen.delete(seen.values().next().value)
    const bucket = pending.get(dir) || new Map()
    for (const title of new Set(titles)) {
      const id = fingerprint(title.trim().toLowerCase())
      const entry = bucket.get(id) || { title: title.slice(0, 160), count: 0 }
      entry.count++; entry.lastExposedAt = now()
      bucket.set(id, entry)
    }
    pending.set(dir, bucket)
    if (!timer) { timer = setTimeout(flush, delayMs); timer.unref?.() }
  }
  function flush() {
    if (timer) clearTimeout(timer)
    timer = null
    for (const [dir, bucket] of pending) {
      try {
        const previous = readHeat(dir)
        const entries = { ...previous.entries }
        for (const [id, e] of bucket) entries[id] = { title: e.title, count: (entries[id]?.count || 0) + e.count, lastExposedAt: e.lastExposedAt }
        const bounded = Object.fromEntries(Object.entries(entries).sort((a,b) => String(b[1].lastExposedAt).localeCompare(String(a[1].lastExposedAt))).slice(0, 4096))
        atomicJson(join(dir, 'heat.json'), { version: 1, entries: bounded })
        pending.delete(dir)
      } catch (e) { console.warn('[wb-memory][heat] flush failed: ' + String(e?.message || e)) }
    }
    if (pending.size && !timer) { timer = setTimeout(flush, delayMs); timer.unref?.() }
  }
  function dispose() { flush(); if (timer) clearTimeout(timer); timer = null }
  return { queue, flush, dispose }
}
