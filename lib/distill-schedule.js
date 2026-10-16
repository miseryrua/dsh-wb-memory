// 单宿主下的持久调度：与正文消费游标完全分离。claim 必须先落盘再调用模型。
import { readFileSync, statSync } from 'node:fs'
import { atomicJson, fingerprint } from './distill-cursor.js'
const BASE = 2 * 3600000, MAX = 24 * 3600000, TTL = 10 * MAX
const blank = () => ({ version: 1, nextWorkspace: '', nextDates: {}, retries: {} })
const object = v => v && typeof v === 'object' && !Array.isArray(v)
const cleanName = v => typeof v === 'string' && v.length <= 256 && !/[\u0000-\u001f]/.test(v)
export function createDistillSchedule(file, { now = () => Date.now() } = {}) {
  let state = blank(), readFailed = false, writeFailed = false
  try {
    if (statSync(file).size > 1048576) throw new Error('oversize')
    const d = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (d?.version !== 1 || !object(d.nextDates) || !object(d.retries)) throw new Error('invalid')
    state.nextWorkspace = cleanName(d.nextWorkspace) ? d.nextWorkspace : ''
    for (const [k, v] of Object.entries(d.nextDates).slice(-512)) if (cleanName(k) && /^\d{4}-\d{2}-\d{2}$/.test(v)) Object.defineProperty(state.nextDates, k, { value: v, enumerable: true, writable: true, configurable: true })
    for (const [k, v] of Object.entries(d.retries).slice(-2048)) {
      if (/^[a-f0-9]{64}$/.test(k) && object(v) && Number.isInteger(v.attempts) && v.attempts > 0 && Number.isFinite(v.at) && Number.isFinite(v.nextRetryAt) && v.at <= now() && now() - v.at < TTL && v.nextRetryAt >= v.at && v.nextRetryAt <= v.at + MAX) {
        state.retries[k] = { attempts: Math.min(16, v.attempts), at: v.at, nextRetryAt: v.nextRetryAt }
      }
    }
  } catch (e) { readFailed = e?.code !== 'ENOENT' }
  function save(next) {
    try { atomicJson(file, next); state = next; writeFailed = false }
    catch (cause) { writeFailed = true; const e = new Error('distill scheduler state write failed'); e.cause = cause; throw e }
  }
  function key({ workspace, date, blockId, provider, model }) { return fingerprint(JSON.stringify([workspace, date, blockId, provider, model])) }
  function rotate(items, start) { const i = items.indexOf(start); return i > 0 ? [...items.slice(i), ...items.slice(0, i)] : [...items] }
  return {
    orderWorkspaces(items) { return rotate(items, state.nextWorkspace) },
    orderDates(workspace, items) { return rotate(items.map(x => x.date), state.nextDates[workspace]).map(date => items.find(x => x.date === date)) },
    retryAt(meta) { return state.retries[key(meta)]?.nextRetryAt || 0 },
    claim(meta, nextWorkspace, nextDate) {
      const at = now(), k = key(meta), old = state.retries[k]
      const attempts = Math.min(16, (old?.attempts || 0) + 1)
      const next = { ...state, nextWorkspace, nextDates: { ...state.nextDates, [meta.workspace]: nextDate }, retries: { ...state.retries, [k]: { attempts, at, nextRetryAt: at + Math.min(MAX, BASE * 2 ** (attempts - 1)) } } }
      next.nextDates = Object.fromEntries(Object.entries(next.nextDates).slice(-512))
      next.retries = Object.fromEntries(Object.entries(next.retries).filter(([, v]) => at - v.at < TTL).sort((a, b) => a[1].at - b[1].at).slice(-2048))
      save(next)
    },
    success(meta) { const next = { ...state, retries: { ...state.retries } }; delete next.retries[key(meta)]; save(next) },
    snapshot() { return { nextWorkspace: state.nextWorkspace, retryBlocks: Object.keys(state.retries).length, readFailed, writeFailed } },
  }
}
