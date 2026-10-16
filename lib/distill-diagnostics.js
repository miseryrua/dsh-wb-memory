// 只记录受控元数据。无输入/输出/错误原文；失败不参与业务控制流。
import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { atomicJson } from './distill-cursor.js'
export const diagnosticId = () => randomUUID()
export function diagnosticReason(e) {
  const s = String(e?.message || e || '')
  if (s.startsWith('llm finish: aborted (timeout)')) return 'timeout'
  if (s.startsWith('llm finish: ok-but-empty-output')) return 'empty-output'
  for (const k of ['truncated', 'missing', 'error', 'aborted', 'unsupported']) if (s.startsWith('llm finish: ' + k)) return 'llm-' + k
  if (s.startsWith('distill output unparsable')) return 'invalid-output'
  if (s === 'distill scheduler state write failed') return 'scheduler-write'
  if (s === 'distill source changed during inference') return 'source-changed'
  if (['EACCES', 'EPERM', 'ENOENT', 'EISDIR', 'ENOSPC', 'EIO'].includes(e?.code)) return 'file-io'
  return 'unknown-error'
}
const textFields = new Set(['id', 'sweepId', 'callId', 'blockId', 'workspace', 'date', 'provider', 'model'])
const enums = {
  type: ['sweep', 'queue', 'block', 'model'], phase: ['start', 'end', 'visit'],
  status: ['running', 'ok', 'partial', 'failed', 'skipped', 'committed'],
  stage: ['distill', 'compact', 'profile', 'unscoped'],
  finish: ['ok', 'error', 'aborted', 'truncated', 'unsupported', 'missing'],
  reason: ['busy', 'disabled', 'no-model', 'provider-not-ready', 'timeout', 'empty-output', 'llm-truncated', 'llm-missing', 'llm-error', 'llm-aborted', 'llm-unsupported', 'invalid-output', 'source-changed', 'file-io', 'unknown-error', 'stream-error', 'marker-write', 'scheduler-write', 'retry-backoff', 'scheduler-state-reset'],
  reasoningControl: ['low', 'unavailable', 'lookup-failed'],
  outputIssue: ['missing-metadata', 'incomplete-metadata', 'missing-heading', 'missing-body'],
  failureCode: ['TRANSPORT', 'AUTH', 'RATE_LIMIT', 'PROVIDER', 'TIMEOUT', 'UNKNOWN'],
}
const numbers = new Set(['durationMs', 'outputChars', 'reasoningChars', 'maxTokens', 'inputChars', 'start', 'end', 'added', 'attempt', 'pendingDates', 'budgetRemaining', 'attempted', 'failed', 'committed', 'deferredDates', 'workspaces', 'backoffDates', 'nextRetryAt'])
function sanitize(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const [k, v] of Object.entries(input)) {
    if (textFields.has(k) && typeof v === 'string') out[k] = v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128)
    else if (enums[k]?.includes(v)) out[k] = v
    else if (numbers.has(k) && Number.isFinite(v) && v >= 0) out[k] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(v))
    else if (k === 'manual' && typeof v === 'boolean') out[k] = v
    else if (k === 'at' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) out[k] = v
  }
  return out
}
export function createDistillDiagnostics(file, { limit = 64 } = {}) {
  const cap = Math.max(8, Math.min(64, Math.floor(Number(limit) || 64)))
  let state = null, readFailed = false, writeFailed = false
  function load() {
    if (state) return
    state = { version: 1, events: [], lastSweepStart: null, lastSweepEnd: null }
    try {
      if (statSync(file).size > 262144) throw new Error('oversize')
      const d = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (d?.version !== 1 || !Array.isArray(d.events)) throw new Error('invalid')
      state.events = d.events.slice(-cap).map(sanitize)
      state.lastSweepStart = d.lastSweepStart ? sanitize(d.lastSweepStart) : null
      state.lastSweepEnd = d.lastSweepEnd ? sanitize(d.lastSweepEnd) : null
    } catch (e) { readFailed = e?.code !== 'ENOENT' }
  }
  return {
    record(input) {
      try {
        load()
        const event = sanitize({ ...input, at: new Date().toISOString() })
        state.events.push(event)
        state.events = state.events.slice(-cap)
        if (event.type === 'sweep' && event.phase === 'start' && event.status === 'running') state.lastSweepStart = event
        if (event.type === 'sweep' && event.phase === 'end' && event.reason !== 'busy') state.lastSweepEnd = event
        try { atomicJson(file, state); writeFailed = false } catch { writeFailed = true }
      } catch { writeFailed = true }
    },
    snapshot() {
      try { load(); return JSON.parse(JSON.stringify({ ...state, scope: 'global', limit: cap, readFailed, writeFailed })) }
      catch { return { version: 1, scope: 'global', events: [], readFailed: true, writeFailed } }
    },
  }
}
