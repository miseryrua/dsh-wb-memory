/**
 * dsh-wb-memory 会话收尾小结（N4；0.10.0 重写为「持久化 + 启动恢复」版）。
 *
 * 会话空闲超时（summaryIdleMs，默认 10 分钟）后触发一次 LLM 小结（150-300 字，
 * 含决策理由与未竟事项），追加到当日【逻辑日】日志的 `## 会话小结 HH:MM [batch:…]` 段。
 *
 * 0.10.0 相对 v8 的关键变化（对应《可行性评审》第 4 项）：
 *   ① 待处理快照持久化：sessionId / 工作区目录 / 原逻辑日 / 完整轮次 / inputVersion
 *      / 裁剪后的输入 buffer / 重试状态，落盘到各 memory 目录的
 *      summary-pending.json（单写者 + 临时文件原子替换，见 summary-store.js）。
 *      用户消息、助手回复、turn/end completed 都会推进快照；落盘按事件节流
 *      （WB_SUMMARY_PERSIST_DELAY_MS，默认 1s），空闲触发与插件卸载时兜底落盘。
 *   ② 崩溃恢复：recoverPendingSummaries(api) 在宿主启动（LLM 服务注入后）调用，
 *      只扫描 api.listMemoryDirs() 返回的目录，不读任何真实记忆内容。恢复按
 *      原逻辑日 + 原工作区补写；启用/模型/每日上限（summaryMaxPerDay）门禁不过
 *      时保留记录不补写；失败退避（指数，上限 24h）与过期清理（默认 72h）、
 *      每次恢复限额（summaryRecoverMaxBatch，默认 3）。
 *   ③ 幂等：batchId = hash(sessionId|逻辑日|inputVersion) 写进日志标题行；
 *      「append 成功但墓碑化前崩溃」由 logHasBatch 去重，恢复不重复写。
 *      成功后记录转 done 墓碑（保留版本号单调性），不直接删除。
 *   ④ 继续聊天可再次小结：inputVersion 按「输入内容指纹（snapshotKey）」推进——
 *      内容变了才 +1；同内容不再重烧 LLM（跨重启也由墓碑 + logHasBatch 兜底）。
 *   ⑤ 同会话定时器防并发：模块级 RUNNING 哨兵 + 每会话至多一个空闲定时器；
 *      推理（LLM 调用）期间新增轮次不丢失——新内容推进快照版本，成功清理时
 *      保留更新版本的待处理记录，且 busy 时自动重挂定时器。
 *
 * 原有接口全部保留：installSessionSummary(ctx, api) / summaryConfig /
 * summarySystemPrompt / summaryGate / summaryInputText / countSummariesToday。
 * 依赖注入不变：readConfig / digestClip / digestTextOf / resolveActiveProject /
 * memoryDirOf / logicalDayStamp / distillConfig / distillCallLlm / getLlm；
 * 0.10.0 新增可选 api.listMemoryDirs()（返回 memory 目录绝对路径字符串数组，
 * 仅供启动恢复扫描范围；缺省时恢复跳过，其余功能不受影响）。
 *
 * 纯 node:fs/node:path，零外部依赖；真删无（只 append），绕开 safe-delete shim。
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { atomicText } from './distill-cursor.js'
import { join, dirname } from 'node:path'
import {
  getPendingSession,
  updatePendingSession,
  removePendingSession,
  listPendingRecords,
  mkBatchId,
  logHasBatch,
  batchMarker,
  hashString,
} from './summary-store.js'

// 跨 install 实例的并发哨兵：同一 sessionId 任意时刻至多一个 LLM 小结在跑
// （防「多个同会话定时器」与「恢复 + 空闲触发」同时进入）。
const RUNNING = new Set()
const RESERVED = new Map()
// 恢复扫描必须服从本宿主最新轮次，避免落盘节流窗口里读取过时的completed快照。
const LIVE_STATES = new Map()

function num(cfg, key, def) {
  const n = Number(cfg && cfg[key])
  return Number.isFinite(n) && n > 0 ? n : def
}

function envNum(name, def) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? n : def
}

// 落盘节流：事件密集时合并为一次写（测试可用环境变量调小）。
function persistDelayMs() {
  return envNum('WB_SUMMARY_PERSIST_DELAY_MS', 1000)
}

// 失败退避基数与重试定时器上限（测试可调小）。
function backoffBaseMs() {
  return envNum('WB_SUMMARY_BACKOFF_BASE_MS', 60000)
}

function retryTimerCapMs() {
  return envNum('WB_SUMMARY_RETRY_TIMER_CAP_MS', 600000)
}

export function summaryConfig(cfg) {
  return {
    on: cfg && cfg.sessionSummary === false ? false : true,
    idleMs: num(cfg, 'summaryIdleMs', 600000),
    minUserChars: num(cfg, 'summaryMinUserChars', 300),
    maxPerDay: num(cfg, 'summaryMaxPerDay', 8),
    userMaxChars: 2000, // 小结输入：用户侧全量拼接上限（比 digest 的 300 宽）
    assistantKeep: 2, // 助手侧取最后 N 条
    assistantChars: 500, // 每条助手文本上限
    maxOutChars: 600, // 小结落盘硬上限（prompt 要求 150-300 字，这里是保险）
    // 0.10.0 恢复策略
    recoverMaxBatch: num(cfg, 'summaryRecoverMaxBatch', 3),
    recoverMaxAgeMs: num(cfg, 'summaryRecoverMaxAgeMs', 72 * 60 * 60 * 1000),
  }
}

export function summarySystemPrompt() {
  return '你是会话总结器。用 150-300 字概括这个会话：做了什么、为什么这么决定、未竟事项或遗留问题。直接输出一段文字，不要列表、不要标题。'
}

// 四道闸（纯函数，保留原签名与语义供既有测试）。
export function summaryGate(sc, cond) {
  if (!sc || !sc.on) return { pass: false, reason: 'disabled' }
  if (!cond.modelReady) return { pass: false, reason: 'no-model' }
  if (cond.alreadyDone) return { pass: false, reason: 'already-summarized' }
  if ((cond.userChars || 0) < sc.minUserChars) return { pass: false, reason: 'too-short' }
  if ((cond.countToday || 0) >= sc.maxPerDay) return { pass: false, reason: 'daily-cap' }
  return { pass: true }
}

// 当日已有小结数：以日志文件 `## 会话小结` 标题计数为准（重启安全，不依赖内存态）。
// 标题行追加的 [batch:…] 幂等标记不影响该计数。
export function countSummariesToday(logPath) {
  try {
    const raw = readFileSync(logPath, 'utf8')
    return (raw.match(/^## 会话小结/gm) || []).length
  } catch {
    return 0
  }
}

// 小结输入拼装（纯函数，保留原行为）。
function clipUserInput(text, limit) {
  const s = String(text || '')
  if (s.length <= limit) return s
  // 长消息保开头的项目归属与末尾待办；总长严格不超预算。
  const head = Math.floor((limit - 1) / 2)
  return s.slice(0, head).replace(/[\uD800-\uDBFF]$/, '') + '…' + s.slice(-(limit - head - 1)).replace(/^[\uDC00-\uDFFF]/, '')
}

export function summaryInputText(buf, sc) {
  // 累积输入超预算时优先保留最近的消息，不让早期内容挤掉最新决策。
  const user = String((buf && buf.userTexts) ? buf.userTexts.join(' / ') : '').slice(-sc.userMaxChars).replace(/^[\uDC00-\uDFFF]/, '')
  const assist = ((buf && buf.lastAssistants) || [])
    .slice(-sc.assistantKeep)
    .map((t) => (t.length > sc.assistantChars ? t.slice(0, sc.assistantChars) + '…' : t))
    .join('\n---\n')
  return ['--- 用户消息 ---', user, '', '--- 助手最后回复 ---', assist || '（无）'].join('\n')
}

// 输入内容指纹：只有用户/助手输入变了才推进版本（turn 数不参与——turn 前进而
// 输入未变时重烧 LLM 没有意义，墓碑去重也依赖这一点）。
export function bufferSnapshotKey(b) {
  return hashString(
    ((b && b.userTexts) || []).join('\u0001') + '\u0002' + ((b && b.lastAssistants) || []).join('\u0001'),
  )
}

// 失败退避：基数 × 2^(attempts-1)，封顶 24h（纯函数，导出供测试）。
export function retryBackoff(attempts, baseMs) {
  const n = Math.max(1, Number(attempts) || 1)
  const b = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : backoffBaseMs()
  return Math.min(b * Math.pow(2, n - 1), 24 * 60 * 60 * 1000)
}

// 小结段追加（导出供测试与恢复路径复用）：标题行携带 [batch:…] 幂等标记。
export function appendSessionSummary(logPath, day, para, batchId) {
  let existing = ''
  try {
    existing = readFileSync(logPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(logPath), { recursive: true })
  const hhmm = new Date().toTimeString().slice(0, 5)
  const head = existing ? (existing.endsWith('\n') ? '' : '\n') : `# ${day} 日志（含自动流水）\n`
  atomicText(logPath, existing + head + `## 会话小结 ${hhmm} ${batchMarker(batchId)}\n${para}\n\n`)
}

function freshState() {
  return {
    closed: false,
    buffers: new Map(), // sessionId -> { userTexts, lastAssistants, turn, inputVersion }
    sessions: new Map(), // sessionId -> session（落盘时解析工作区用）
    timers: new Map(), // sessionId -> 空闲/重试定时器（每会话至多一个）
    persistTimers: new Map(), // sessionId -> 落盘节流定时器
    doneVersions: new Map(), // sessionId -> 已小结的 inputVersion（本进程生命周期）
  }
}

export function installSessionSummary(ctx, api) {
  const state = freshState()
  const off = ctx.on('session/event', (session, event) => {
    try {
      summaryOnEvent(session, event, state, api)
    } catch (e) {
      try {
        console.log('[wb-memory][summary] skipped: ' + String((e && e.message) || e))
      } catch {}
    }
  })
  return () => {
    state.closed = true
    for (const [sid, liveState] of LIVE_STATES) if (liveState === state) LIVE_STATES.delete(sid)
    try {
      off && off()
    } catch {}
    for (const t of state.timers.values()) clearTimeout(t)
    state.timers.clear()
    for (const t of state.persistTimers.values()) clearTimeout(t)
    state.persistTimers.clear()
    // 卸载（≈宿主退出）前尽力把未小结快照落盘；禁用状态不补写。
    for (const sid of state.buffers.keys()) {
      try {
        persistSnapshot(sid, state, api)
      } catch {}
    }
  }
}

function evictOldest(state) {
  const oldest = state.buffers.keys().next().value
  if (oldest === undefined) return
  state.buffers.delete(oldest)
  if (LIVE_STATES.get(oldest) === state) LIVE_STATES.delete(oldest)
  state.sessions.delete(oldest)
  const t = state.timers.get(oldest)
  if (t) clearTimeout(t)
  state.timers.delete(oldest)
  const pt = state.persistTimers.get(oldest)
  if (pt) clearTimeout(pt)
  state.persistTimers.delete(oldest)
}

function summaryOnEvent(session, event, state, api) {
  const cfg = api.readConfig()
  const sc = summaryConfig(cfg)
  if (!cfg.enabled || !sc.on) return
  // 主会话守卫（与 digestOnEvent 同款）：子代理/委派会话不小结
  const h = session && session.header
  if (!h) return
  if (h.parentSession || (h.delegationDepth || 0) > 0) return
  // 泄漏防护（与 digest 同款）：超上限丢最旧会话 buffer
  if (state.buffers.size > 128) evictOldest(state)
  const sid = session.id

  if (event.type === 'user/message') {
    const m = event.data
    if (!m || m.role !== 'user' || !m.source || m.source.kind !== 'user') return
    const t = clipUserInput(api.digestTextOf(m.content), sc.userMaxChars)
    if (!t) return
    const b = state.buffers.get(sid) || { userTexts: [], lastAssistants: [], turn: 0, inputVersion: 0 }
    b.userTexts.push(t)
    if (b.userTexts.length > 20) b.userTexts.shift()
    b.completed = false
    b.idleSince = 0
    b.inputVersion = (b.inputVersion || 0) + 1
    state.buffers.set(sid, b)
    LIVE_STATES.set(sid, state)
    state.sessions.set(sid, session)
    // 会话仍在继续：取消挂起的小结定时器
    const timer = state.timers.get(sid)
    if (timer) {
      clearTimeout(timer)
      state.timers.delete(sid)
    }
    schedulePersist(sid, state, api)
    return
  }

  if (event.type === 'assistant/message') {
    const m = event.data && event.data.message
    if (!m) return
    const t = api.digestTextOf(m.content)
    if (!t) return
    const b = state.buffers.get(sid) || { userTexts: [], lastAssistants: [], turn: 0, inputVersion: 0 }
    // 审查 R1（2026-09-01）：入 buffer 前先裁剪——summaryInputText 实际只用
    // 最后 2 条 × 500 字符，全文存储在长输出会话（贴日志/文件）下可累积数十 MB。
    b.completed = false
    b.idleSince = 0
    b.lastAssistants.push(api.digestClip(t, 1500))
    if (b.lastAssistants.length > 4) b.lastAssistants.shift() // 只留尾部原料
    b.inputVersion = (b.inputVersion || 0) + 1
    state.buffers.set(sid, b)
    LIVE_STATES.set(sid, state)
    state.sessions.set(sid, session)
    schedulePersist(sid, state, api)
    return
  }

  if (event.type === 'turn/end') {
    const b = state.buffers.get(sid)
    if (!b || b.userTexts.length === 0) return
    const reason = event.data && event.data.reason && event.data.reason.kind
    if (reason !== 'completed') return
    b.turn = (b.turn || 0) + 1 // 完整轮次（持久化字段）
    b.completed = true
    b.idleSince = Date.now()
    LIVE_STATES.set(sid, state)
    b.logicalDay = api.logicalDayStamp(cfg)
    state.sessions.set(sid, session)
    schedulePersist(sid, state, api)
    // (重)臂空闲定时器：turn 完成后 summaryIdleMs 内无新用户消息 → 触发小结
    armIdle(session, state, api, sc.idleMs)
  }
}

// ---- 快照持久化 ----

function nextVersionFor(dir, sid, day, key) {
  const existing = getPendingSession(dir, sid)
  if (!existing) return 1
  if (existing.logicalDay === day && existing.snapshotKey === key) return existing.inputVersion || 1
  return (existing.inputVersion || 0) + 1
}

function buildRecord(sid, ws, dir, day, b, key, version, extra) {
  return Object.assign(
    {
      sessionId: sid,
      workspace: ws,
      dir,
      logicalDay: day,
      turn: (b && b.turn) || 0,
      completed: b?.completed !== false,
      idleSince: Number.isFinite(b?.idleSince) ? b.idleSince : 0,
      inputVersion: version,
      snapshotKey: key,
      buffer: {
        userTexts: ((b && b.userTexts) || []).slice(),
        lastAssistants: ((b && b.lastAssistants) || []).slice(),
      },
      attempts: 0,
      nextRetryAt: 0,
      lastError: null,
      state: 'pending',
      updatedAt: new Date().toISOString(),
      storeVersion: 1,
    },
    extra || {},
  )
}

function persistSnapshot(sid, state, api) {
  const session = state.sessions.get(sid)
  const b = state.buffers.get(sid)
  if (!session || !b || !(b.userTexts || []).length) return
  const cfg = api.readConfig()
  const sc = summaryConfig(cfg)
  if (!cfg.enabled || !sc.on) return // 禁用不补写
  const ws = api.resolveActiveProject(session.header && session.header.cwd)
  if (!ws) return
  const dir = api.memoryDirOf(ws)
  if (!dir) return
  const day = b.logicalDay || api.logicalDayStamp(cfg)
  const key = bufferSnapshotKey(b)
  const existing = getPendingSession(dir, sid)
  const same = existing && existing.logicalDay === day && existing.snapshotKey === key
  const version = nextVersionFor(dir, sid, day, key)
  updatePendingSession(
    dir,
    buildRecord(sid, ws, dir, day, b, key, version, {
      attempts: same ? existing.attempts || 0 : 0,
      nextRetryAt: same ? existing.nextRetryAt || 0 : 0,
      lastError: same ? existing.lastError || null : null,
      state: same && existing.state === 'done' ? 'done' : 'pending',
    }),
  )
}

function schedulePersist(sid, state, api) {
  if (state.persistTimers.has(sid)) return
  const timer = setTimeout(() => {
    state.persistTimers.delete(sid)
    try {
      persistSnapshot(sid, state, api)
    } catch (e) {
      // 落盘失败：保留内存态，下一事件再试（可重试状态）
      try {
        console.log('[wb-memory][summary] 快照落盘异常（下次事件重试）: ' + String((e && e.message) || e))
      } catch {}
    }
  }, persistDelayMs())
  if (timer && typeof timer.unref === 'function') timer.unref()
  state.persistTimers.set(sid, timer)
}

// ---- 空闲触发 / 恢复共用的小结执行 ----

function armIdle(session, state, api, delay, fallback) {
  const sid = session && session.id
  if (!sid) return
  if (state.closed || state.timers.has(sid)) return
  const timer = setTimeout(() => {
    state.timers.delete(sid)
    runSessionSummary(session, state, api, fallback).catch(() => {})
  }, Math.max(0, delay))
  if (timer && typeof timer.unref === 'function') timer.unref()
  state.timers.set(sid, timer)
}

function markFailed(dir, rec, err, session, state, api, fallback) {
  const attempts = (rec.attempts || 0) + 1
  const cfg = api.readConfig()
  const baseMs = num(cfg, 'summaryRetryBackoffBaseMs', backoffBaseMs())
  const delay = retryBackoff(attempts, baseMs)
  const failed = Object.assign({}, rec, {
    attempts,
    nextRetryAt: Date.now() + delay,
    lastError: String((err && err.message) || err).slice(0, 200),
    state: 'failed',
    updatedAt: new Date().toISOString(),
  })
  try {
    // LLM 推理期间可能已有更新版本的快照落盘（推理中新增轮次不丢失）：
    // 只在盘上记录不比本次更新的版本新时才写 failed，否则保留新记录。
    const cur = getPendingSession(dir, rec.sessionId)
    if (!cur || (cur.inputVersion || 0) <= (rec.inputVersion || 0)) {
      updatePendingSession(dir, failed)
    }
  } catch (e) {
    try {
      console.log('[wb-memory][summary] 失败状态落盘异常: ' + String((e && e.message) || e))
    } catch {}
  }
  try {
    console.log(
      '[wb-memory][summary] 小结失败保留待重试（第 ' + attempts + ' 次，' +
        Math.round(delay / 1000) + 's 后可重试）: ' + String((err && err.message) || err).slice(0, 120),
    )
  } catch {}
  // 挂重试定时器（恢复路径也适用；上限 retryTimerCapMs 防长挂）
  if (fallback) {
    armIdle(session, state, api, Math.min(delay, retryTimerCapMs()), { dir, record: failed })
  } else {
    armIdle(session, state, api, Math.min(delay, retryTimerCapMs()))
  }
}

/**
 * 执行一次会话小结（空闲触发与启动恢复共用）。
 * - live 会话：从 state.buffers 取最新输入，按内容指纹推进 inputVersion；
 *   LLM 调用前先把 running 状态记录落盘（崩溃 → 恢复可重试）。
 * - fallback（恢复）：按持久化记录的原工作区 + 原逻辑日补写，版本复用记录值
 *   （重试同一份内容 → 同一 batchId → 幂等）。
 * 返回状态字符串（done / deduped / busy / failed / 闸门原因），供测试与恢复统计。
 */
async function runSessionSummary(session, state, api, fallback) {
  const sid = session && session.id
  if (!sid) return 'no-session'
  // 启动/周期恢复与事件定时器共享最新内存快照，不能绕过未完成轮次。
  const active = LIVE_STATES.get(sid)
  if (fallback && active && !active.closed) {
    state = active
    session = active.sessions.get(sid) || session
    fallback = null
  } else if (fallback) {
    // 重试定时器携带的旧记录也要重新取盘上最新版本。
    const current = getPendingSession(fallback.dir, sid)
    if (!current || current.state === 'done') return 'already-summarized'
    fallback = { ...fallback, record: current }
  }
  if (RUNNING.has(sid)) {
    // 并发防重入：推理中又有新轮次进来 → 重挂定时器，不丢失
    const cfg0 = api.readConfig()
    armIdle(session, state, api, summaryConfig(cfg0).idleMs, fallback)
    return 'busy'
  }
  RUNNING.add(sid)
  let reservedPath = null
  try {
    const cfg = api.readConfig()
    const sc = summaryConfig(cfg)
    if (!cfg.enabled || !sc.on || state.closed) return 'disabled'
    const llm = api.getLlm()
    const dc = api.distillConfig(cfg)
    const live = state.buffers.get(sid)

    let ws, day, b, dir, version, snapshotKey
    if (live) {
      ws = api.resolveActiveProject(session && session.header && session.header.cwd)
      day = live.logicalDay || api.logicalDayStamp(cfg)
      b = { ...live, userTexts: live.userTexts.slice(), lastAssistants: live.lastAssistants.slice() }
      if (!ws) return 'no-workspace'
      dir = api.memoryDirOf(ws)
      snapshotKey = bufferSnapshotKey(b)
      version = nextVersionFor(dir, sid, day, snapshotKey)
    } else if (fallback && fallback.record) {
      const r = fallback.record
      ws = r.workspace
      day = r.logicalDay
      b = { ...(r.buffer || { userTexts: [], lastAssistants: [] }), turn: r.turn || 0, completed: r.completed !== false, idleSince: Number(r.idleSince) > 0 ? Number(r.idleSince) : Date.parse(r.updatedAt || '') }
      dir = fallback.dir || r.dir || (ws ? api.memoryDirOf(ws) : null)
      version = r.inputVersion || 1
      snapshotKey = r.snapshotKey || bufferSnapshotKey(b)
    } else {
      return 'no-buffer'
    }
    if (!ws || !day || !dir || !b || !(b.userTexts || []).length) return 'no-input'

    if ((b.turn || fallback?.record?.turn || 0) < 1 || b.completed === false || fallback?.record?.completed === false) return 'incomplete'
    // 时间锚点只在完整轮次结束时推进，落盘/退避不能重置闲置计时。
    const idleSince = Number(b.idleSince)
    if (!Number.isFinite(idleSince) || idleSince <= 0) return 'invalid-idle-time'
    const remainingIdle = idleSince + sc.idleMs - Date.now()
    if (remainingIdle > 0) {
      // live已持有定时器或可在这里补臂；恢复由宿主下一次60秒扫描再检查。
      if (live) armIdle(session, state, api, remainingIdle)
      return 'not-idle'
    }
    const logPath = join(dir, day + '.md')
    const gate = summaryGate(sc, {
      modelReady: Boolean(llm && dc && dc.model),
      alreadyDone: Boolean(live && version <= (state.doneVersions.get(sid) || 0)),
      userChars: (b.userTexts.join('') || '').length,
      countToday: countSummariesToday(logPath) + (RESERVED.get(logPath) || 0),
    })
    if (!gate.pass) {
      if (gate.reason === 'no-model' || gate.reason === 'disabled') return gate.reason
      try {
        console.log('[wb-memory][summary] skipped (' + gate.reason + ')')
      } catch {}
      // daily-cap：保留记录待恢复/次日；too-short：内容冻结不会再达标，清掉
      if (gate.reason === 'too-short' && !live) {
        try {
          removePendingSession(dir, sid)
        } catch {}
      }
      return gate.reason
    }

    const batchId = mkBatchId(sid, day, version)
    // 幂等：append 成功但墓碑化前崩溃 → 日志已有该 batch，直接补墓碑不重复写
    if (logHasBatch(logPath, batchId)) {
      state.doneVersions.set(sid, version)
      try {
        updatePendingSession(dir, buildRecord(sid, ws, dir, day, b, snapshotKey, version, {
          state: 'done',
          attempts: 0,
          nextRetryAt: 0,
          lastError: null,
          updatedAt: new Date().toISOString(),
        }))
      } catch {}
      try {
        console.log('[wb-memory][summary] 检测到已写入的 batch，跳过重复写入: ' + batchId)
      } catch {}
      return 'deduped'
    }

    // 空闲调用：先把可重试的 running 状态落盘（此间崩溃 → 恢复重试）
    const existing = getPendingSession(dir, sid)
    const sameContent = existing && existing.logicalDay === day && existing.snapshotKey === snapshotKey
    const rec = buildRecord(sid, ws, dir, day, b, snapshotKey, version, {
      attempts: sameContent ? existing.attempts || 0 : 0,
      state: 'running',
      nextRetryAt: 0,
      updatedAt: new Date().toISOString(),
    })
    if (sameContent && existing.nextRetryAt > Date.now()) {
      armIdle(session, state, api, Math.min(existing.nextRetryAt - Date.now(), retryTimerCapMs()), fallback)
      return 'backoff'
    }
    updatePendingSession(dir, rec)
    reservedPath = logPath
    RESERVED.set(logPath, (RESERVED.get(logPath) || 0) + 1)

    // 路由走 distill 路由（便宜模型）；超时/异常 → 失败保留退避重试
    let out
    try {
      out = await api.distillCallLlm(llm, dc, summarySystemPrompt(), summaryInputText(b, sc))
    } catch (e) {
      markFailed(dir, rec, e, session, state, api, live ? null : { dir, record: rec })
      return 'failed'
    }
    const para = String(out || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, sc.maxOutChars)
    if (!para) {
      // 空输出不是合法小结（与 distill 的空输出判定同口径）→ 失败保留
      markFailed(dir, rec, new Error('empty-output'), session, state, api, live ? null : { dir, record: rec })
      return 'failed'
    }
    const commitCfg = api.readConfig()
    if (!commitCfg.enabled || !summaryConfig(commitCfg).on || state.closed) return 'disabled'
    if (countSummariesToday(logPath) >= summaryConfig(commitCfg).maxPerDay) return 'daily-cap'
    try {
      appendSessionSummary(logPath, day, para, batchId)
    } catch (e) {
      markFailed(dir, rec, e, session, state, api, live ? null : { dir, record: rec })
      return 'failed'
    }
    state.doneVersions.set(sid, version)
    if (state.doneVersions.size > 512) {
      const first = state.doneVersions.keys().next().value
      if (first !== undefined) state.doneVersions.delete(first)
    }
    // 成功 → 墓碑化（保留版本单调与去重依据）；若推理期间已有更新版本落盘则保留
    try {
      const cur = getPendingSession(dir, sid)
      if (!cur || cur.inputVersion <= version) {
        updatePendingSession(
          dir,
          buildRecord(sid, ws, dir, day, b, snapshotKey, version, {
            attempts: rec.attempts || 0,
            state: 'done',
            nextRetryAt: 0,
            lastError: null,
            updatedAt: new Date().toISOString(),
          }),
        )
      }
    } catch {}
    try {
      console.log(`[wb-memory][summary] ${ws} ${day}: 会话小结 ${para.length} 字已写入（${batchId}）`)
    } catch {}
    return 'done'
  } finally {
    if (reservedPath) {
      const n = (RESERVED.get(reservedPath) || 1) - 1
      if (n) RESERVED.set(reservedPath, n); else RESERVED.delete(reservedPath)
    }
    RUNNING.delete(sid)
  }
}

/**
 * 启动恢复：扫描 api.listMemoryDirs() 返回的 memory 目录，补写崩溃前未完成的
 * 会话小结。调用时机：宿主启动、LLM 服务注入之后（Lead 在 index.js 接入；本文件
 * 不自行定时触发）。幂等：成功/去重后记录转 done 墓碑，重复调用不重复写。
 *
 * 精确接口：api.listMemoryDirs() → string[]（memory 目录绝对路径数组；可含不
 * 存在的目录）。恢复只读这些目录下的 summary-pending.json 与目标日日志的标题
 * 计数，不读任何真实记忆（MEMORY.md / PINNED.md / USER.md / 日期日志正文）。
 *
 * 门禁：enabled / sessionSummary 关闭或 LLM 未就绪 → 直接跳过（禁用不补写）；
 * 每日上限（summaryMaxPerDay，按目标日日志 `## 会话小结` 计数）不达标 → 保留记录；
 * 失败退避未到 → 保留记录；过期（recoverMaxAgeMs，默认 72h）→ 清理；
 * 每次最多补写 summaryRecoverMaxBatch（默认 3）条。
 */
export async function recoverPendingSummaries(api) {
  const out = { skipped: null, scanned: 0, candidates: 0, recovered: 0, deduped: 0, kept: 0, retried: 0, expired: 0, dropped: 0 }
  if (!api || typeof api.readConfig !== 'function') {
    out.skipped = 'no-api'
    return out
  }
  const cfg = api.readConfig()
  const sc = summaryConfig(cfg)
  if (!cfg.enabled || !sc.on) {
    out.skipped = 'disabled'
    return out
  }
  const llm = typeof api.getLlm === 'function' ? api.getLlm() : null
  const dc = typeof api.distillConfig === 'function' ? api.distillConfig(cfg) : null
  if (!llm || !dc || !dc.model) {
    out.skipped = 'no-model'
    return out
  }
  if (typeof api.listMemoryDirs !== 'function') {
    out.skipped = 'no-listMemoryDirs'
    return out
  }
  let dirs
  try {
    dirs = api.listMemoryDirs()
  } catch {
    dirs = null
  }
  if (!Array.isArray(dirs) || dirs.length === 0) {
    out.skipped = 'no-dirs'
    return out
  }
  out.scanned = dirs.length
  const now = Date.now()
  const all = listPendingRecords(dirs)

  // ① 过期清理 + 无效记录清理（先于限额，防陈旧记录占位）
  const fresh = []
  for (const x of all) {
    const r = x.record || {}
    const at = Date.parse(r.updatedAt || '')
    const invalid =
      !r.sessionId ||
      r.sessionId !== x.sid ||
      !r.workspace ||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.logicalDay || '') ||
      !r.buffer ||
      !Array.isArray(r.buffer.userTexts) ||
      r.buffer.userTexts.length === 0
    if (invalid) {
      try {
        removePendingSession(x.dir, x.sid)
      } catch {}
      out.dropped++
      continue
    }
    if (!Number.isFinite(at) || now - at > sc.recoverMaxAgeMs) {
      try {
        removePendingSession(x.dir, x.sid)
      } catch {}
      out.expired++
      continue
    }
    if (r.state === 'done') continue // 墓碑：已小结，等过期清理
    fresh.push(x)
  }

  // ② 同 sessionId 跨目录取 updatedAt 最新（防多目录重复补写）
  const bySid = new Map()
  for (const x of fresh) {
    const prev = bySid.get(x.sid)
    if (!prev) {
      bySid.set(x.sid, x)
      continue
    }
    // 同 sessionId 跨目录：保留 updatedAt 最新，清掉旧目录的重复记录（防下次重复补写）
    if (String(x.record.updatedAt || '') > String(prev.record.updatedAt || '')) {
      try {
        removePendingSession(prev.dir, prev.sid)
      } catch {}
      bySid.set(x.sid, x)
    } else {
      try {
        removePendingSession(x.dir, x.sid)
      } catch {}
    }
  }
  out.candidates = bySid.size

  // ③ 限额内逐条补写（串行，LLM 并发可控）
  const state = freshState()
  for (const x of bySid.values()) {
    if (out.recovered + out.kept >= sc.recoverMaxBatch) break
    const r = x.record
    if (r.nextRetryAt && now < r.nextRetryAt) {
      out.retried++ // 退避未到：保留，等待下次恢复/会话复活
      continue
    }
    let res
    try {
      res = await runSessionSummary({ id: r.sessionId }, state, api, { dir: x.dir, record: r })
    } catch {
      res = 'failed'
    }
    if (res === 'done') out.recovered++
    else if (res === 'deduped') {
      out.recovered++
      out.deduped++
    } else if (res === 'not-idle' || res === 'incomplete' || res === 'invalid-idle-time') out.waiting = (out.waiting || 0) + 1
    else if (res === 'failed' || res === 'daily-cap') out.kept++
    else if (res === 'too-short') out.dropped++
    // 其余（no-model 等中途变化）：不计数，记录仍在盘上
  }
  return out
}
