import assert from 'node:assert/strict'
import { manualCompact, CompactManualError } from '../lib/compact-manual.js'
const revision = 'a'.repeat(64)
const input = { workspace: 'A', expectedRevision: revision, confirmed: true }
function fixture(overrides = {}) {
  const state = { running: false }, counts = { compact: 0, save: 0 }
  const source = { A: { __compact__: { day: 'today', ok: true }, log: { added: 3 } }, B: { unchanged: true } }
  const deps = {
    state, ready: true, workspaces: ['A'], revision: () => revision,
    readMarkers: () => source,
    compact: async (ws, markers) => { counts.compact++; assert.equal(state.running, true); markers[ws].__compact__.ok = false; return { ok: true } },
    save: async () => { counts.save++; assert.equal(state.running, true) }, ...overrides,
  }
  return { deps, state, counts, source }
}
async function rejects(body, code, overrides = {}, status = 409) {
  const f = fixture(overrides)
  await assert.rejects(manualCompact(body, f.deps), e => e instanceof CompactManualError && e.code === code && e.status === status)
  assert.equal(f.counts.compact, 0); assert.equal(f.counts.save, 0)
  if (!overrides.state) assert.equal(f.state.running, false)
}
for (const body of [null, [], 'A', {}, { ...input, confirmed: false }, { ...input, workspace: 'B' }, { ...input, expectedRevision: 'A'.repeat(64) }, { ...input, path: '/other' }, { ...input, maxTokens: 999 }]) await rejects(body, 'invalid-request', {}, 400)
await rejects(input, 'not-ready', { ready: false }, 503)
const occupied = { running: true }
await rejects(input, 'busy', { state: occupied }); assert.equal(occupied.running, true)
await rejects(input, 'stale-revision', { revision: () => 'b'.repeat(64) })
const success = fixture(); assert.equal((await manualCompact(input, success.deps)).ok, true)
assert.equal(success.counts.compact, 1); assert.equal(success.counts.save, 1); assert.equal(success.state.running, false)
assert.equal(success.source.A.__compact__.ok, true, '不得在结果提交前污染原日记录')
const empty = fixture({ compact: async () => null }); const skipped = await manualCompact(input, empty.deps)
assert.equal(skipped.skipped, 'no-memory'); assert.equal(skipped.ok, false); assert.equal(empty.counts.save, 0); assert.equal(empty.state.running, false)
for (const phase of ['compact', 'save']) {
  const f = fixture({ [phase]: async () => { throw new Error('SECRET upstream') } })
  await assert.rejects(manualCompact(input, f.deps), e => e.code === 'attempt-failed' && e.status === 500 && !e.message.includes('SECRET'))
  assert.equal(f.state.running, false, '执行或提交异常必须释放锁')
}
let release, entered
const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
const concurrent = fixture({ compact: async () => { entered(); await gate; return { ok: false } } })
const pending = manualCompact(input, concurrent.deps); await started
await assert.rejects(manualCompact(input, concurrent.deps), e => e.code === 'busy')
release(); assert.equal((await pending).ok, false); assert.equal(concurrent.state.running, false)
console.log('compact-manual: 白名单/资格/revision/原记录隔离/空记忆/异常脱敏与解锁/连续点击互斥 passed')
