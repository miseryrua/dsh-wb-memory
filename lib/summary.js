/**
 * dsh-wb-memory 会话收尾小结（N4，v8）。
 *
 * 会话空闲超时（summaryIdleMs，默认 10 分钟）后触发一次 LLM 小结（150-300 字，
 * 含决策理由与未竟事项），追加到当日【逻辑日】日志的 `## 会话小结 HH:MM` 段。
 * 它是 distill 的高价值原料（F3 已在 distillSystemPrompt 声明）与近 N 日回顾
 * （buildWeekSection）的优先装配内容——把 digest 的「结论对」升级为「有语境的
 * 结论」（Hana 滚动摘要同款思想）。
 *
 * 复用 digest 的 session/event 订阅模式与主会话守卫（跳过 parentSession /
 * delegationDepth>0）。成本四道闸（任一不过即跳过）：
 *   ① sessionSummary 开关（config）
 *   ② 提炼路由就绪（llm 服务已注入且 distillModel 已配置；未配置时静默）
 *   ③ 本会话未小结过（内存 Set；插件重载即清零，重载后同会话再小结一次属可接受误差）
 *   ④ 用户文本累计 ≥ summaryMinUserChars（短寒暄不烧 LLM）
 *   ⑤ 当日小结数 < summaryMaxPerDay（以日志文件 `## 会话小结` 计数为准，重启安全）
 *
 * 依赖注入：宿主 index.js 通过 installSessionSummary(ctx, api) 传入 readConfig /
 * digestClip / digestTextOf / resolveActiveProject / memoryDirOf / logicalDayStamp /
 * distillConfig / distillCallLlm / getLlm——避免与 index.js 循环 import。
 * 纯 node:fs/node:path，零外部依赖；真删无（只 append），绕开 safe-delete shim。
 */

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

function num(cfg, key, def) {
  const n = Number(cfg && cfg[key])
  return Number.isFinite(n) && n > 0 ? n : def
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
  }
}

export function summarySystemPrompt() {
  return '你是会话总结器。用 150-300 字概括这个会话：做了什么、为什么这么决定、未竟事项或遗留问题。直接输出一段文字，不要列表、不要标题。'
}

// 四道闸（纯函数，导出供 smoke 测试）。
export function summaryGate(sc, cond) {
  if (!sc || !sc.on) return { pass: false, reason: 'disabled' }
  if (!cond.modelReady) return { pass: false, reason: 'no-model' }
  if (cond.alreadyDone) return { pass: false, reason: 'already-summarized' }
  if ((cond.userChars || 0) < sc.minUserChars) return { pass: false, reason: 'too-short' }
  if ((cond.countToday || 0) >= sc.maxPerDay) return { pass: false, reason: 'daily-cap' }
  return { pass: true }
}

// 当日已有小结数：以日志文件 `## 会话小结` 标题计数为准（重启安全，不依赖内存态）。
export function countSummariesToday(logPath) {
  try {
    const raw = readFileSync(logPath, 'utf8')
    return (raw.match(/^## 会话小结/gm) || []).length
  } catch {
    return 0
  }
}

// 小结输入拼装（纯函数，导出供 smoke 测试）。
export function summaryInputText(buf, sc) {
  const user = String((buf && buf.userTexts) ? buf.userTexts.join(' / ') : '').slice(0, sc.userMaxChars)
  const assist = ((buf && buf.lastAssistants) || [])
    .slice(-sc.assistantKeep)
    .map((t) => (t.length > sc.assistantChars ? t.slice(0, sc.assistantChars) + '…' : t))
    .join('\n---\n')
  return ['--- 用户消息 ---', user, '', '--- 助手最后回复 ---', assist || '（无）'].join('\n')
}

export function installSessionSummary(ctx, api) {
  const state = {
    buffers: new Map(), // sessionId -> { userTexts: string[], lastAssistants: string[] }
    timers: new Map(), // sessionId -> idle timer
    doneSessions: new Set(), // 本插件生命周期内已小结的会话（闸③）
  }
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
    try {
      off && off()
    } catch {}
    for (const t of state.timers.values()) clearTimeout(t)
    state.timers.clear()
  }
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
  if (state.buffers.size > 128) {
    const oldest = state.buffers.keys().next().value
    if (oldest !== undefined) state.buffers.delete(oldest)
  }
  const sid = session.id

  if (event.type === 'user/message') {
    const m = event.data
    if (!m || m.role !== 'user' || !m.source || m.source.kind !== 'user') return
    const t = api.digestClip(api.digestTextOf(m.content), 300)
    if (!t) return
    const b = state.buffers.get(sid) || { userTexts: [], lastAssistants: [] }
    b.userTexts.push(t)
    state.buffers.set(sid, b)
    // 会话仍在继续：取消挂起的小结定时器
    const timer = state.timers.get(sid)
    if (timer) {
      clearTimeout(timer)
      state.timers.delete(sid)
    }
    return
  }

  if (event.type === 'assistant/message') {
    const m = event.data && event.data.message
    if (!m) return
    const t = api.digestTextOf(m.content)
    if (!t) return
    const b = state.buffers.get(sid) || { userTexts: [], lastAssistants: [] }
    // 审查 R1（2026-09-01）：入 buffer 前先裁剪——summaryInputText 实际只用
    // 最后 2 条 × 500 字符，全文存储在长输出会话（贴日志/文件）下可累积数十 MB。
    // 裁 1500 约为实际用量的 3 倍余量，对现有行为无损。
    b.lastAssistants.push(api.digestClip(t, 1500))
    if (b.lastAssistants.length > 4) b.lastAssistants.shift() // 只留尾部原料
    state.buffers.set(sid, b)
    return
  }

  if (event.type === 'turn/end') {
    const b = state.buffers.get(sid)
    if (!b || b.userTexts.length === 0) return
    const reason = event.data && event.data.reason && event.data.reason.kind
    if (reason !== 'completed') return
    // (重)臂空闲定时器：turn 完成后 summaryIdleMs 内无新用户消息 → 触发小结
    const old = state.timers.get(sid)
    if (old) clearTimeout(old)
    const timer = setTimeout(() => {
      state.timers.delete(sid)
      runSessionSummary(session, b, state, api).catch(() => {})
    }, sc.idleMs)
    state.timers.set(sid, timer)
  }
}

async function runSessionSummary(session, buf, state, api) {
  const cfg = api.readConfig()
  const sc = summaryConfig(cfg)
  const llm = api.getLlm()
  const dc = api.distillConfig(cfg)
  const ws = api.resolveActiveProject(session && session.header && session.header.cwd)
  if (!ws) return
  const dir = api.memoryDirOf(ws)
  const day = api.logicalDayStamp(cfg)
  const logPath = join(dir, day + '.md')
  const gate = summaryGate(sc, {
    modelReady: Boolean(llm && dc.model),
    alreadyDone: state.doneSessions.has(session.id),
    userChars: buf.userTexts.join('').length,
    countToday: countSummariesToday(logPath),
  })
  if (!gate.pass) {
    // no-model / disabled 是常态（未配置提炼路由），静默；其余跳过原因留一行日志便于观察
    if (gate.reason !== 'no-model' && gate.reason !== 'disabled') {
      console.log('[wb-memory][summary] skipped (' + gate.reason + ')')
    }
    return
  }
  // 路由走 distill 路由（便宜模型）；超时/异常由 distillCallLlm 抛出 → 上层 catch 静默
  const out = await api.distillCallLlm(llm, dc, summarySystemPrompt(), summaryInputText(buf, sc))
  const para = String(out || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, sc.maxOutChars)
  if (!para) return
  const hhmm = new Date().toTimeString().slice(0, 5)
  let existing = ''
  try {
    existing = readFileSync(logPath, 'utf8')
  } catch {}
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    logPath,
    (existing ? (existing.endsWith('\n') ? '' : '\n') : `# ${day} 日志（含自动流水）\n`) + `## 会话小结 ${hhmm}\n${para}\n\n`,
    'utf8',
  )
  state.doneSessions.add(session.id)
  if (state.doneSessions.size > 512) {
    const first = state.doneSessions.keys().next().value
    if (first !== undefined) state.doneSessions.delete(first)
  }
  console.log(`[wb-memory][summary] ${ws} ${day}: 会话小结 ${para.length} 字已写入`)
}
