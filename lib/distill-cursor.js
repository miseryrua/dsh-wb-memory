// UTF-16 游标与 slice 一致；旧标记无法证明长度，安全重扫并查重。
import { createHash } from 'node:crypto'
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
export const fingerprint = (text) => createHash('sha256').update(text).digest('hex')
export function atomicText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}
export function atomicJson(path, value) {
  atomicText(path, JSON.stringify(value, null, 2))
}
export function planLogChunk(raw, marker, { maxChars = 12000, today = false, minChars = 300 } = {}) {
  const valid = marker?.version === 2 && Number.isSafeInteger(marker.offset) && marker.offset >= 0 && marker.offset <= raw.length
    && marker.prefixHash === fingerprint(raw.slice(0, marker.offset))
  const start = valid ? marker.offset : 0
  if (start === raw.length) return null
  const limit = Math.max(2, Math.floor(Number(maxChars) || 12000))
  const stableEnd = today ? raw.lastIndexOf('\n') + 1 : raw.length
  let end = Math.min(stableEnd, start + limit)
  if (end < raw.length) {
    const nl = raw.lastIndexOf('\n', end - 1)
    if (nl >= start) end = nl + 1
    if (end > start && /[\uD800-\uDBFF]/.test(raw[end - 1])) end--
  } else if (today && !raw.endsWith('\n')) end = raw.lastIndexOf('\n') + 1
  if (end <= start || (today && stableEnd - start < minChars)) return null
  const text = raw.slice(start, end)
  const id = fingerprint(start + ':' + end + ':' + fingerprint(raw.slice(0, end)))
  return { start, end, text, id, prefixHash: fingerprint(raw.slice(0, end)), done: end === raw.length }
}
export function completeLogChunk(chunk, added, previous = {}) {
  return { version: 2, offset: chunk.end, prefixHash: chunk.prefixHash, done: chunk.done,
    batchId: chunk.id, at: new Date().toISOString(), added, totalAdded: (previous.totalAdded || 0) + added }
}
export function mergeAppendedEntries(current, expected, replacement) {
  if (!expected || !current.startsWith(expected)) return null
  const body = current.slice(expected.length).trim()
  if (!body || !/^(?:<!--[\s\S]*?-->\s*\n)?##[ \t]+[^\n]+\n\S[\s\S]*/.test(body)) return null
  // 每个新标题必须有正文，拒绝无闭合元数据或半条目。
  const entries = body.split(/\n(?=(?:<!--|##[ \t]))/)
  for (const part of entries) {
    if (/^<!--/.test(part) && !/-->\s*$/.test(part)) return null
    if (/^##[ \t]/.test(part) && !/^##[ \t]+[^\n]+\n[\s\S]*\S/.test(part)) return null
  }
  return replacement.trimEnd() + '\n\n' + body + '\n'
}
