/**
 * dsh-wb-memory 0.10.0 会话小结持久化恢复测试（test/summary-v010.mjs）。
 *
 * 运行：node test/summary-v010.mjs（进程内执行，不派子进程——run_code 沙箱 spawnSync
 * node 会 EPERM；temp 用本仓库 .tmp/ 显式目录——run_code 进程 env 为空时 os.tmpdir()
 * 返回 'undefined\temp'）。全 mock：api / LLM / 日志目录均指向 .tmp 临时目录，
 * 不读不写任何真实记忆（MEMORY.md / PINNED.md / USER.md / 真实日期日志）。
 *
 * 覆盖：快照持久化字段、主会话守卫、禁用不落盘、崩溃恢复幂等（batchId 去重）、
 * 失败保留与退避、空输出按失败、原逻辑日补写、禁用不补写、重复恢复不重写、
 * 继续聊天产生新版本、推理中新增轮次不丢失、同会话/跨会话并发、每日上限、
 * 恢复限额、过期与无效记录清理、恢复只扫 listMemoryDirs 范围。
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installSessionSummary,
  summaryConfig,
  summaryGate,
  summaryInputText,
  countSummariesToday,
  recoverPendingSummaries,
  appendSessionSummary,
  bufferSnapshotKey,
  retryBackoff,
} from '../lib/summary.js'
import {
  readPendingStore,
  getPendingSession,
  updatePendingSession,
  pendingStorePath,
  mkBatchId,
  logHasBatch,
} from '../lib/summary-store.js'

process.env.WB_SUMMARY_PERSIST_DELAY_MS = '10' // 落盘节流调小（事件→落盘 10ms）

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.error('  ✗ ' + name)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 显式 temp 根：本仓库 .tmp/（不依赖 os.tmpdir()）
const TMP_ROOT = join(dirnameSafe(fileURLToPath(import.meta.url)), '..', '.tmp')
function dirnameSafe(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? '.' : p.slice(0, i)
}
mkdirSync(TMP_ROOT, { recursive: true })
const ROOT = mkdtempSync(join(TMP_ROOT, 'summary-v010-'))
console.log('temp root: ' + ROOT)

// ---- mock 设施工厂 ----

function mkEnv(t) {
  // t: { day, cfg, call }，call(sys,userText) → string | Promise | throw
  const dir = join(ROOT, t.name)
  mkdirSync(dir, { recursive: true })
  const cfg = Object.assign({ enabled: true, distillModel: 'mock-model', distillProvider: 'mock' }, t.cfg)
  const api = {
    readConfig: () => cfg,
    digestClip: (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s)),
    digestTextOf: (c) => (typeof c === 'string' ? c : JSON.stringify(c || '')),
    resolveActiveProject: () => t.workspace || '测试工作区',
    memoryDirOf: () => dir,
    logicalDayStamp: () => t.day || '2026-10-14',
    distillConfig: () => ({ provider: cfg.distillProvider, model: cfg.distillModel, timeoutMs: 1000 }),
    distillCallLlm: async (llm, dc, sys, userText) => {
      api.calls.push(userText)
      return t.call(sys, userText)
    },
    getLlm: () => ({ stream: async function* () {} }),
    listMemoryDirs: () => (t.dirs ? t.dirs : [dir]),
    calls: [],
  }
  return { dir, api, cfg, t }
}

function mkCtx() {
  let handler = null
  const ctx = {
    on: (name, h) => {
      handler = h
      return () => {
        handler = null
      }
    },
  }
  ctx.emit = (session, event) => handler && handler(session, event)
  return ctx
}

function userMsg(text) {
  return { type: 'user/message', data: { role: 'user', content: text, source: { kind: 'user' } } }
}
function assistantMsg(text) {
  return { type: 'assistant/message', data: { message: { content: text } } }
}
function turnEnd() {
  return { type: 'turn/end', data: { reason: { kind: 'completed' } } }
}
function session(id, hdr) {
  return { id, header: Object.assign({ cwd: 'D:/x' }, hdr || {}) }
}
const LONG = '这是一段足够长的用户消息，用来通过 300 字门槛。'.repeat(12) // ~360 字
const SUMMARY_TEXT = '用户修复了会话小结持久化：新增 summary-store.js 落盘待处理快照，崩溃后由启动恢复补写，batchId 幂等去重。'

// ---- 1. 快照持久化字段 ----
console.log('\n--- 1. 待处理快照持久化（事件→summary-pending.json）---')
{
  const e = mkEnv({ name: 't1', day: '2026-10-14', cfg: { summaryIdleMs: 400 }, call: () => SUMMARY_TEXT })
  const ctx = mkCtx()
  const dispose = installSessionSummary(ctx, e.api)
  const s = session('sess-1')
  ctx.emit(s, userMsg(LONG))
  ctx.emit(s, assistantMsg('助手第一次回复。'))
  ctx.emit(s, turnEnd())
  await sleep(80) // 落盘节流 10ms
  const rec = getPendingSession(e.dir, 'sess-1')
  ok(rec !== null, '事件后 summary-pending.json 落盘')
  ok(
    rec && rec.sessionId === 'sess-1' && rec.workspace === '测试工作区' && rec.dir === e.dir &&
      rec.logicalDay === '2026-10-14' && rec.turn === 1 && rec.inputVersion >= 1 &&
      rec.state === 'pending' && typeof rec.snapshotKey === 'string',
    '记录含 sessionId/工作区目录/原逻辑日/完整轮次/inputVersion/快照指纹',
  )
  ok(
    rec && Array.isArray(rec.buffer.userTexts) && rec.buffer.userTexts.length === 1 &&
      rec.buffer.userTexts[0].length <= 2000 && rec.buffer.userTexts[0] === LONG && Array.isArray(rec.buffer.lastAssistants),
    'buffer保留预算内完整用户消息（2000字符上限），无提前300字截断',
  )
  dispose()
}

// ---- 2. 主会话守卫：子代理 / 非真实用户不小结不落盘 ----
console.log('\n--- 2. 主会话守卫（parentSession / delegationDepth / source.kind）---')
{
  const e = mkEnv({ name: 't2', day: '2026-10-14', call: () => SUMMARY_TEXT })
  const ctx = mkCtx()
  const dispose = installSessionSummary(ctx, e.api)
  ctx.emit(session('sub-1', { parentSession: 'p' }), userMsg(LONG))
  ctx.emit(session('sub-2', { delegationDepth: 2 }), userMsg(LONG))
  ctx.emit(session('sess-2'), { type: 'user/message', data: { role: 'user', content: LONG, source: { kind: 'agent' } } })
  ctx.emit(session('sess-2'), turnEnd())
  await sleep(60)
  ok(getPendingSession(e.dir, 'sub-1') === null && getPendingSession(e.dir, 'sub-2') === null, '子代理/委派会话不入库')
  ok(getPendingSession(e.dir, 'sess-2') === null, 'source.kind 非 user 的消息不触发落盘')
  dispose()
}

// ---- 3. 禁用：事件不落盘、恢复不补写 ----
console.log('\n--- 3. 禁用不补写 ---')
{
  const e = mkEnv({ name: 't3', day: '2026-10-14', cfg: { sessionSummary: false }, call: () => SUMMARY_TEXT })
  const ctx = mkCtx()
  const dispose = installSessionSummary(ctx, e.api)
  ctx.emit(session('sess-3'), userMsg(LONG))
  ctx.emit(session('sess-3'), turnEnd())
  await sleep(60)
  ok(!existsSync(pendingStorePath(e.dir)) || Object.keys(readPendingStore(e.dir).sessions).length === 0, 'sessionSummary=false：事件不落盘')
  dispose()

  // 预置一条历史待处理记录，验证禁用时恢复跳过且保留记录（不补写也不删除）
  updatePendingSession(e.dir, {
    sessionId: 'sess-3b', workspace: '测试工作区', dir: e.dir, logicalDay: '2026-10-13',
    turn: 2, inputVersion: 1, snapshotKey: 'k', buffer: { userTexts: [LONG], lastAssistants: [] },
    idleSince: Date.now() - 3600000, // 本场景只测试恢复/失败/限额，明确已超过闲置门槛
    attempts: 0, nextRetryAt: 0, lastError: null, state: 'pending', updatedAt: new Date().toISOString(),
  })
  const r = await recoverPendingSummaries(e.api)
  ok(r.skipped === 'disabled', '禁用：恢复直接跳过（skipped=disabled）')
  ok(getPendingSession(e.dir, 'sess-3b') !== null, '禁用不补写也不清除待处理记录')
  ok(e.api.calls.length === 0, '禁用时不调用 LLM')
}

// ---- 4. 空闲触发 + 崩溃窗口幂等（append 成功、墓碑化前崩溃）----
console.log('\n--- 4. 空闲触发写小结；append 后墓碑化前崩溃 → 恢复去重不重写 ---')
{
  const e = mkEnv({ name: 't4', day: '2026-10-14', cfg: { summaryIdleMs: 60 }, call: () => SUMMARY_TEXT })
  const ctx = mkCtx()
  const dispose = installSessionSummary(ctx, e.api)
  const s = session('sess-4')
  ctx.emit(s, userMsg(LONG))
  ctx.emit(s, turnEnd())
  await sleep(300) // idle 60ms + LLM mock
  const logPath = join(e.dir, '2026-10-14.md')
  ok(existsSync(logPath) && countSummariesToday(logPath) === 1, '空闲超时触发小结并写入当日日志')
  ok(e.api.calls.length === 1, 'LLM 恰好调用一次')
  const recDone = getPendingSession(e.dir, 'sess-4')
  ok(recDone && recDone.state === 'done', '成功后记录转 done 墓碑（保留版本与去重依据）')
  ok(logHasBatch(logPath, mkBatchId('sess-4', '2026-10-14', recDone.inputVersion)), '日志标题含稳定 batchId 幂等标记')
  dispose()

  // 模拟崩溃窗口：手工把墓碑改回 running（= append 成功但清理前进程死亡）
  recDone.state = 'running'
  updatePendingSession(e.dir, recDone)
  const before = readFileSync(logPath, 'utf8')
  const r = await recoverPendingSummaries(e.api)
  ok(r.recovered === 1 && r.deduped === 1, '崩溃恢复：logHasBatch 命中 → 去重补墓碑（recovered+deduped）')
  ok(readFileSync(logPath, 'utf8') === before, '日志未重复写入（幂等）')
  ok(e.api.calls.length === 1, '去重路径不重复调用 LLM')
  ok(getPendingSession(e.dir, 'sess-4').state === 'done', '去重后墓碑恢复 done')
}

// ---- 5. 失败保留与退避 ----
console.log('\n--- 5. 失败保留、指数退避、空输出按失败 ---')
{
  // 5a. LLM 抛错 → failed + attempts/nextRetryAt；退避未到 → 保留不重试
  let boom = true
  const e = mkEnv({ name: 't5a', day: '2026-10-14', cfg: { summaryRetryBackoffBaseMs: 60000 }, call: () => { if (boom) throw new Error('llm timeout'); return SUMMARY_TEXT } })
  updatePendingSession(e.dir, {
    sessionId: 'sess-5a', workspace: '测试工作区', dir: e.dir, logicalDay: '2026-10-14',
    turn: 1, inputVersion: 1, snapshotKey: 'k', buffer: { userTexts: [LONG], lastAssistants: [] },
    idleSince: Date.now() - 3600000, // 本场景只测试恢复/失败/限额，明确已超过闲置门槛
    attempts: 0, nextRetryAt: 0, lastError: null, state: 'pending', updatedAt: new Date().toISOString(),
  })
  let r = await recoverPendingSummaries(e.api)
  ok(r.kept === 1, 'LLM 失败：恢复统计 kept（保留待重试）')
  let rec = getPendingSession(e.dir, 'sess-5a')
  ok(rec.state === 'failed' && rec.attempts === 1 && rec.nextRetryAt > Date.now() && /timeout/.test(rec.lastError || ''), '失败记录含 attempts=1、未来 nextRetryAt、lastError')
  r = await recoverPendingSummaries(e.api)
  ok(r.retried === 1 && r.recovered === 0, '退避未到：二次恢复跳过（retried），不烧 LLM')
  // 退避到期 → 重试成功
  rec.nextRetryAt = 0
  updatePendingSession(e.dir, rec)
  boom = false
  r = await recoverPendingSummaries(e.api)
  ok(r.recovered === 1, '退避到期后重试成功（recovered=1）')
  ok(countSummariesToday(join(e.dir, '2026-10-14.md')) === 1, '重试成功写入小结')
  ok(retryBackoff(1, 60000) === 60000 && retryBackoff(2, 60000) === 120000 && retryBackoff(20, 60000) === 24 * 3600 * 1000, '退避 2^(n-1) 倍增封顶 24h')

  // 5b. 空输出（非空校验）→ 按失败保留
  const e2 = mkEnv({ name: 't5b', day: '2026-10-14', call: () => '' })
  updatePendingSession(e2.dir, {
    sessionId: 'sess-5b', workspace: '测试工作区', dir: e2.dir, logicalDay: '2026-10-14',
    turn: 1, inputVersion: 1, snapshotKey: 'k', buffer: { userTexts: [LONG], lastAssistants: [] },
    idleSince: Date.now() - 3600000, // 本场景只测试恢复/失败/限额，明确已超过闲置门槛
    attempts: 0, nextRetryAt: 0, lastError: null, state: 'pending', updatedAt: new Date().toISOString(),
  })
  const r2 = await recoverPendingSummaries(e2.api)
  ok(r2.kept === 1, '空输出：按失败保留（不清待处理记录）')
  const rec2 = getPendingSession(e2.dir, 'sess-5b')
  ok(rec2 && rec2.state === 'failed' && rec2.attempts === 1, '空输出记录 attempts=1 failed')
  ok(!existsSync(join(e2.dir, '2026-10-14.md')) || countSummariesToday(join(e2.dir, '2026-10-14.md')) === 0, '空输出不写日志')
}

// ---- 6. 原逻辑日补写（跨日崩溃恢复写原天日志）----
console.log('\n--- 6. 原逻辑日补写 ---')
{
  const e = mkEnv({ name: 't6', day: '2026-10-14', call: () => SUMMARY_TEXT }) // 当前逻辑日是新一天
  updatePendingSession(e.dir, {
    sessionId: 'sess-6', workspace: '测试工作区', dir: e.dir, logicalDay: '2026-10-01',
    turn: 3, inputVersion: 2, snapshotKey: 'k', buffer: { userTexts: [LONG], lastAssistants: ['旧回复'] },
    idleSince: Date.now() - 3600000, // 本场景只测试恢复/失败/限额，明确已超过闲置门槛
    attempts: 0, nextRetryAt: 0, lastError: null, state: 'pending', updatedAt: new Date().toISOString(),
  })
  const r = await recoverPendingSummaries(e.api)
  ok(r.recovered === 1, '跨日记录恢复成功')
  ok(existsSync(join(e.dir, '2026-10-01.md')) && countSummariesToday(join(e.dir, '2026-10-01.md')) === 1, '补写写入原逻辑日 2026-10-01.md')
  ok(!existsSync(join(e.dir, '2026-10-14.md')), '不写入当前逻辑日文件')
  const rec = getPendingSession(e.dir, 'sess-6')
  ok(rec.logicalDay === '2026-10-01' && rec.state === 'done', '墓碑保留原逻辑日')
}

// ---- 7. 重复恢复：墓碑不重复补写 ----
console.log('\n--- 7. 重复恢复不重写 ---')
{
  const e = mkEnv({ name: 't7', day: '2026-10-14', call: () => SUMMARY_TEXT })
  updatePendingSession(e.dir, {
    sessionId: 'sess-7', workspace: '测试工作区', dir: e.dir, logicalDay: '2026-10-14',
    turn: 1, inputVersion: 1, snapshotKey: 'k', buffer: { userTexts: [LONG], lastAssistants: [] },
    idleSince: Date.now() - 3600000, // 本场景只测试恢复/失败/限额，明确已超过闲置门槛
    attempts: 0, nextRetryAt: 0, lastError: null, state: 'pending', updatedAt: new Date().toISOString(),
  })
  await recoverPendingSummaries(e.api)
  const logPath = join(e.dir, '2026-10-14.md')
  const before = readFileSync(logPath, 'utf8')
  const r = await recoverPendingSummaries(e.api)
  ok(r.candidates === 0 && r.recovered === 0, '二次恢复：done 墓碑不计候选')
  ok(readFileSync(logPath, 'utf8') === before, '日志内容不变')
  ok(e.api.calls.length === 1, 'LLM 总调用数仍为 1')
}

// ---- 8. 继续聊天：小结后产生新待处理版本，而非永远 done ----
console.log('\n--- 8. 会话小结后继续聊天 → 新版本再小结 ---')
{
  const e = mkEnv({ name: 't8', day: '2026-10-14', cfg: { summaryIdleMs: 60 }, call: () => SUMMARY_TEXT })
  const ctx = mkCtx()
  const dispose = installSessionSummary(ctx, e.api)
  const s = session('sess-8')
  ctx.emit(s, userMsg(LONG))
  ctx.emit(s, turnEnd())
  await sleep(250)
  const v1 = getPendingSession(e.dir, 'sess-8').inputVersion
  // 继续聊天（新内容）
  ctx.emit(s, userMsg(LONG + ' 追加了新的工作内容与结论，内容指纹变化。'))
  ctx.emit(s, turnEnd())
  await sleep(30) // 落盘(10ms)已完成、空闲定时器(60ms)未触发
  const rec2 = getPendingSession(e.dir, 'sess-8')
  ok(rec2.state === 'pending' && rec2.inputVersion > v1, '新内容推进 inputVersion 且记录回到 pending（非永远 done）')
  await sleep(300)
  const logPath = join(e.dir, '2026-10-14.md')
  ok(countSummariesToday(logPath) === 2, '第二个空闲窗口写出第二段小结')
  ok(e.api.calls.length === 2, '两次小结 = 两次 LLM 调用')
  ok(getPendingSession(e.dir, 'sess-8').state === 'done', '最终墓碑 done')
  dispose()
}

// ---- 9. 推理中新增轮次不丢失 ----
console.log('\n--- 9. LLM 推理期间新增轮次：成功清理不覆盖新版本 ---')
{
  let resolveLlm
  let llmCallCount = 0
  const e = mkEnv({
    name: 't9', day: '2026-10-14', cfg: { summaryIdleMs: 50 },
    call: () => {
      llmCallCount++
      if (llmCallCount === 1) return new Promise((res) => { resolveLlm = res })
      return SUMMARY_TEXT
    },
  })
  const ctx = mkCtx()
  const dispose = installSessionSummary(ctx, e.api)
  const s = session('sess-9')
  ctx.emit(s, userMsg(LONG))
  ctx.emit(s, turnEnd())
  await sleep(120) // 进入 LLM 推理中（promise 未 resolve）
  const runningRec = getPendingSession(e.dir, 'sess-9')
  ok(runningRec && runningRec.state === 'running', '推理中盘上状态为 running（崩溃→恢复可重试）')
  // 推理期间新增轮次
  ctx.emit(s, userMsg(LONG + ' 推理期间追加的新轮次内容，不能丢。'))
  ctx.emit(s, turnEnd())
  await sleep(60)
  const mid = getPendingSession(e.dir, 'sess-9')
  ok(mid.inputVersion > runningRec.inputVersion && mid.state === 'pending', '推理期间新轮次已落盘为新版本 pending')
  resolveLlm(SUMMARY_TEXT) // 第一次小结完成
  await sleep(20) // 完成路径为同步 fs；第二个空闲定时器 50ms 后才触发
  const after = getPendingSession(e.dir, 'sess-9')
  ok(after.state === 'pending' && after.inputVersion === mid.inputVersion, '第一次小结成功后新版本记录保留 pending（不被旧版本墓碑覆盖）')
  await sleep(400) // 新版本走第二个空闲窗口
  const logPath = join(e.dir, '2026-10-14.md')
  ok(countSummariesToday(logPath) === 2, '新增轮次随后也被小结（日志两段）')
  const fin = getPendingSession(e.dir, 'sess-9')
  ok(fin.state === 'done' && fin.inputVersion === mid.inputVersion && llmCallCount === 2, '新增轮次小结完成后墓碑 done（两次 LLM）')
  dispose()
}

// ---- 10. 并发：多会话 + 同会话多定时器 ----
console.log('\n--- 10. 并发会话与同会话定时器防并发 ---')
{
  const e = mkEnv({ name: 't10', day: '2026-10-14', cfg: { summaryIdleMs: 40 }, call: async () => { await sleep(30); return SUMMARY_TEXT } })
  const ctx = mkCtx()
  const dispose = installSessionSummary(ctx, e.api)
  const a = session('conc-a')
  const b = session('conc-b')
  ctx.emit(a, userMsg(LONG + ' 会话A的工作。'))
  ctx.emit(b, userMsg(LONG + ' 会话B的工作。'))
  ctx.emit(a, turnEnd())
  ctx.emit(b, turnEnd())
  await sleep(500)
  const logPath = join(e.dir, '2026-10-14.md')
  ok(countSummariesToday(logPath) === 2, '两个并发会话各自完成小结（互不覆盖）')
  ok(getPendingSession(e.dir, 'conc-a') && getPendingSession(e.dir, 'conc-b'), '两会话记录独立存在')
  // 同会话连续 turn/end 不产生多个并行定时器：再触发一轮
  const callsBefore = e.api.calls.length
  ctx.emit(a, userMsg(LONG + ' 会话A的第二轮。'))
  ctx.emit(a, turnEnd())
  ctx.emit(a, turnEnd()) // 重复 turn/end 不应叠加定时器
  await sleep(300)
  ok(e.api.calls.length === callsBefore + 1, '同会话第二阶段只小结一次（定时器不叠加）')
  dispose()
}

// ---- 11. 每日上限 ----
console.log('\n--- 11. 超每日上限：保留不补写 ---')
{
  const e = mkEnv({ name: 't11', day: '2026-10-14', call: () => SUMMARY_TEXT })
  // 预置当天日志已有 8 段小结（默认 maxPerDay=8）
  writeFileSync(
    join(e.dir, '2026-10-14.md'),
    Array.from({ length: 8 }, (_, i) => '## 会话小结 0' + i + ':00 [batch:cap' + i + ']\n第' + i + '段。\n').join('\n'),
    'utf8',
  )
  updatePendingSession(e.dir, {
    sessionId: 'sess-11', workspace: '测试工作区', dir: e.dir, logicalDay: '2026-10-14',
    turn: 1, inputVersion: 1, snapshotKey: 'k', buffer: { userTexts: [LONG], lastAssistants: [] },
    idleSince: Date.now() - 3600000, // 本场景只测试恢复/失败/限额，明确已超过闲置门槛
    attempts: 0, nextRetryAt: 0, lastError: null, state: 'pending', updatedAt: new Date().toISOString(),
  })
  const r = await recoverPendingSummaries(e.api)
  ok(r.kept === 1, '当日已达上限：恢复返回 kept')
  ok(e.api.calls.length === 0, '超上限不调用 LLM')
  ok(countSummariesToday(join(e.dir, '2026-10-14.md')) === 8, '日志不新增')
  ok(getPendingSession(e.dir, 'sess-11') !== null, '超上限记录保留（次日可再试）')
}

// ---- 12. 过期与无效记录清理 ----
console.log('\n--- 12. 过期 / 无效记录清理、恢复限额、恢复范围 ---')
{
  const e = mkEnv({ name: 't12', day: '2026-10-14', call: () => SUMMARY_TEXT })
  const mk = (sid, extra) => Object.assign({
    sessionId: sid, workspace: '测试工作区', dir: e.dir, logicalDay: '2026-10-14',
    turn: 1, inputVersion: 1, snapshotKey: 'k', buffer: { userTexts: [LONG], lastAssistants: [] },
    idleSince: Date.now() - 3600000, // 本场景只测试恢复/失败/限额，明确已超过闲置门槛
    attempts: 0, nextRetryAt: 0, lastError: null, state: 'pending', updatedAt: new Date().toISOString(),
  }, extra)
  updatePendingSession(e.dir, mk('expired-1', { updatedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() }))
  updatePendingSession(e.dir, mk('invalid-1', { workspace: undefined }))
  updatePendingSession(e.dir, mk('valid-1'))
  updatePendingSession(e.dir, mk('valid-2'))
  updatePendingSession(e.dir, mk('valid-3'))
  updatePendingSession(e.dir, mk('valid-4'))
  const r = await recoverPendingSummaries(e.api)
  ok(r.expired === 1 && r.dropped === 1, '过期 72h 清理 1 条、无效记录清理 1 条')
  ok(r.recovered === 3, '恢复限额 summaryRecoverMaxBatch=3：只补写 3 条')
  ok(getPendingSession(e.dir, 'valid-4') !== null && getPendingSession(e.dir, 'valid-4').state === 'pending', '第 4 条保留待下次恢复')
  ok(getPendingSession(e.dir, 'expired-1') === null && getPendingSession(e.dir, 'invalid-1') === null, '过期/无效记录已从盘上清除')

  // 恢复范围 = listMemoryDirs：范围外目录不扫
  const outside = join(ROOT, 't12-outside')
  mkdirSync(outside, { recursive: true })
  updatePendingSession(outside, mk('outside-1', { dir: outside }))
  const e2 = mkEnv({ name: 't12b', day: '2026-10-14', dirs: [e.dir], call: () => SUMMARY_TEXT })
  const r2 = await recoverPendingSummaries(e2.api)
  ok(r2.scanned === 1 && r2.recovered === 1 && getPendingSession(outside, 'outside-1') !== null, '恢复只扫 listMemoryDirs 返回范围，范围外目录不读不动')

  // 缺 listMemoryDirs / 空数组 / 无 api
  const e3 = mkEnv({ name: 't12c', day: '2026-10-14', call: () => SUMMARY_TEXT })
  const api3 = Object.assign({}, e3.api, { listMemoryDirs: undefined })
  ok((await recoverPendingSummaries(api3)).skipped === 'no-listMemoryDirs', 'api 缺 listMemoryDirs → skipped=no-listMemoryDirs')
  ok((await recoverPendingSummaries(null)).skipped === 'no-api', '无 api → skipped=no-api')
}

// ---- 13. 纯函数回归（兼容 smoke.mjs v8 断言口径）----
console.log('\n--- 13. 纯函数回归 ---')
{
  const sc = summaryConfig({})
  ok(sc.on === true && sc.minUserChars === 300 && sc.maxPerDay === 8 && sc.idleMs === 600000, '默认配置不变（开/300字/8次日/10分钟）')
  ok(summaryGate(sc, { modelReady: true, alreadyDone: false, userChars: 400, countToday: 0 }).pass === true, '全闸通过')
  ok(summaryGate(sc, { modelReady: true, alreadyDone: false, userChars: 100, countToday: 0 }).reason === 'too-short', 'too-short 闸不变')
  ok(summaryGate(sc, { modelReady: true, alreadyDone: false, userChars: 400, countToday: 8 }).reason === 'daily-cap', 'daily-cap 闸不变')
  ok(summaryGate(sc, { modelReady: true, alreadyDone: true, userChars: 400, countToday: 0 }).reason === 'already-summarized', 'already-summarized 闸不变')
  ok(summaryGate(sc, { modelReady: false, alreadyDone: false, userChars: 400, countToday: 0 }).reason === 'no-model', 'no-model 闸不变')
  ok(summaryGate(summaryConfig({ sessionSummary: false }), { modelReady: true, alreadyDone: false, userChars: 400, countToday: 0 }).reason === 'disabled', 'disabled 闸不变')
  const input = summaryInputText({ userTexts: ['帮我修插件', '再检查一遍逻辑日'], lastAssistants: ['第一次回复内容。'.repeat(80), '最终结论：已修复'] }, sc)
  ok(input.startsWith('--- 用户消息 ---') && input.includes('帮我修插件') && input.includes('最终结论：已修复'), 'summaryInputText 格式不变')
  ok(bufferSnapshotKey({ userTexts: ['a'], lastAssistants: [] }) !== bufferSnapshotKey({ userTexts: ['a', 'b'], lastAssistants: [] }), '快照指纹随输入内容变化')
  // countSummariesToday 兼容带 [batch:...] 后缀的标题（幂等标记不破坏计数）
  const cdir = join(ROOT, 'count-check')
  mkdirSync(cdir, { recursive: true })
  appendSessionSummary(join(cdir, '2026-10-14.md'), '2026-10-14', '段落一', mkBatchId('x', '2026-10-14', 1))
  appendSessionSummary(join(cdir, '2026-10-14.md'), '2026-10-14', '段落二', mkBatchId('x', '2026-10-14', 2))
  ok(countSummariesToday(join(cdir, '2026-10-14.md')) === 2, '带 batch 标记的标题计入当日小结数')
  ok(logHasBatch(join(cdir, '2026-10-14.md'), mkBatchId('x', '2026-10-14', 1)), 'logHasBatch 识别已写 batch')
}

// ---- 清理 ----
try {
  rmSync(ROOT, { recursive: true, force: true })
  console.log('temp cleaned: ' + ROOT)
} catch (e) {
  console.log('temp cleanup skipped: ' + e.message)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exitCode = 1
