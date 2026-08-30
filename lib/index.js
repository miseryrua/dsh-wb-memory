/**
 * dsh-wb-memory host entry (v7.5).
 *
 * Replicates WorkBuddy's file-based memory inside DeepSeek Harness, but the
 * SOURCE OF TRUTH is now each dsh WORKSPACE's own `.workbuddy/memory/` folder
 * (i.e. D:\datas\Deepseek Harness\<workspace>\.workbuddy\memory\), NOT the old
 * ~/.dsh/wb-memory/projects/ store nor the original WorkBuddy path. All reads
 * and writes (the agent injecting memory, and the panel managing files) go
 * directly through the dsh workspace directory.
 *
 * Resolution of "which workspace memory to load":
 *   1. If the session cwd is inside a known dsh workspace folder, that workspace
 *      is auto-loaded.
 *   2. Otherwise, the manually selected `activeProject` (workspace name) from
 *      config is used.
 * The resolved workspace's MEMORY.md + today's log are injected verbatim
 * (capped), in addition to the GLOBAL user profile (this plugin's USER.md).
 *
 * No vector DB, no embeddings: the agent reads/writes Markdown directly, exactly
 * like WorkBuddy's own memory model.
 *
 * NOTE: webserver registers `kind:'exact'` routes keyed by PATH only, so each
 * path gets a single handler that branches on `request.method`.
 * NOTE: the `systemPrompt` `text` callback must be SYNCHRONOUS.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  appendFileSync,
  existsSync,
  copyFileSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { retrieveRelevant, summarizeEntries, readMemoryEntries, jaccard, overlapCoeff } from './retrieve.js'
import { runGc, safeTrash } from './governance.js'

export const name = 'wb-memory'

// Plugin's own directory (parent of lib/). All runtime data (USER.md global
// profile + config.json) now lives HERE, NOT in the old ~/.dsh/wb-memory store.
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MEM_DIR = () => PLUGIN_ROOT
const CONFIG_FILE = () => join(MEM_DIR(), 'config.json')

// Root that holds all dsh workspaces. Override with DSH_WORKSPACE_ROOT if yours
// lives elsewhere. Each workspace's memory lives at <root>/<name>/.workbuddy/memory.
const DSH_ROOT = process.env.DSH_WORKSPACE_ROOT || 'D:\\datas\\Deepseek Harness'

// ---- debug: capture the last session cwd to verify cwd-based auto-matching ----
// Updated inside the systemPrompt injection on every turn; inspectable via
// GET /wb-memory/debug-cwd (also echoed to stdout for the boot log).
const debugCwd = { lastCwd: null, lastResolved: null, lastAt: null, _prevCwd: null, _prevResolved: null }

// ---------- low-level helpers ----------
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow })
  res.end()
}

function sameOrigin(req) {
  const o = req.headers.origin
  const h = req.headers.host
  if (o === undefined || h === undefined) return false
  try {
    return new URL(o).host === h
  } catch {
    return false
  }
}

function readJsonBody(req) {
  const chunks = []
  let size = 0
  return new Promise((resolve, reject) => {
    req.on('data', (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += b.length
      if (size > 256 * 1024) return reject(new Error('request body too large'))
      chunks.push(b)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// 全部默认值（v7）：作为 config 缺字段时的合并底座；字段与各 *Config() 的
// fallback 保持一致。之前 bootstrap 会用 {enabled, activeProject} 整体重置，
// 静默抹掉 distill 路由、预算、保留期等所有其他字段。
function defaultConfig() {
  return {
    enabled: true,
    activeProject: null,
    profileMaxChars: 2000,
    summaryMaxChars: 1500,
    logMaxChars: 1500,
    entryMaxChars: 800,
    relevantTopK: 5,
    gcEnabled: true,
    logRetentionDays: 30,
    memoryCharThreshold: 8000,
    dupThreshold: 0.45,
    trashRetentionDays: 30,
    archiveRetentionDays: 365,
    autoDigest: true,
    digestMaxPerDay: 60,
    digestUserChars: 80,
    digestAssistantChars: 180,
    autoDistill: true,
    distillProvider: 'zai-coding-cn',
    distillModel: '',
    compactProvider: '',
    compactModel: '',
    compactMaxTokens: 8000,
    distillMaxInputChars: 12000,
    distillMaxTokens: 2000,
    distillTimeoutMs: 180000,
    distillIntervalMs: 3600000,
    distillStartDelayMs: 60000,
  }
}

// BOM 容错的 JSON 读取：Node 的 JSON.parse 不接受 UTF-8 BOM，而 Windows
// PowerShell 5.1 的 Set-Content -Encoding UTF8 必写 BOM。历史事故（2026-08-30）：
// distilled.json 被 PowerShell 写入 BOM → JSON.parse 失败 → 标记全丢 →
// 插件把所有历史日志当作未提炼全量重跑 → 各工作区 MEMORY.md 追加大量重复条目。
// （导出供 smoke 测试直接验证 BOM 行为。）
export function readJsonBomSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function readConfig() {
  return readJsonBomSafe(CONFIG_FILE()) || { enabled: false }
}

function writeConfig(cfg) {
  mkdirSync(MEM_DIR(), { recursive: true })
  writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), 'utf8')
}

function ensureStructure() {
  mkdirSync(MEM_DIR(), { recursive: true })
}

function todayStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 按指定字符预算截断读取（分层注入用；适合"重要内容在头部"的文件如 MEMORY.md）
function safeReadCap(p, cap) {
  try {
    let s = readFileSync(p, 'utf8')
    if (cap && s.length > cap) s = s.slice(0, cap) + '\n…(内容已截断，完整版请直接读取文件)'
    return s
  } catch {
    return null
  }
}

// 不截断读取（给检索模块用完整文本）
function safeReadRaw(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// 追加式文件（如每日日志）按预算保尾截断：最新记录写在文件尾部，
// 保头截断会把当天最新内容切掉。截取后对齐到行首，避免半行开头。
function safeReadTailCap(p, cap) {
  try {
    const s = readFileSync(p, 'utf8')
    if (cap && s.length > cap) {
      let t = s.slice(-cap)
      const nl = t.indexOf('\n')
      if (nl >= 0 && nl < t.length - 1) t = t.slice(nl + 1)
      return '…(更早内容已截断，完整版请直接读取文件)\n' + t
    }
    return s
  } catch {
    return null
  }
}

function normSlash(p) {
  return String(p || '').replace(/\\/g, '/')
}

// 从 config 取预算项，缺失回退默认
function budget(cfg, key, def) {
  const n = Number(cfg && cfg[key])
  return Number.isFinite(n) && n > 0 ? n : def
}

// 从注入 context 尝试拿最近一条 user message 文本作为检索 query。
// systemPrompt 注入时机不一定有当前 user message，拿不到返回 null（走摘要层）。
function getQuery(context) {
  try {
    const msgs = context?.messages || context?.agent?.session?.messages
    if (Array.isArray(msgs)) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m && m.role === 'user' && m.source?.kind !== 'plugin') {
          const c = m.content
          if (typeof c === 'string') return c
          if (Array.isArray(c)) {
            const t = c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ')
            if (t) return t
          }
        }
      }
    }
  } catch {}
  return null
}

// ---------- workspace discovery ----------
// A "workspace" is any directory directly under DSH_ROOT (excluding hidden
// dot-folders). This is the live source of truth — no separate index file.
function listWorkspaces() {
  try {
    return readdirSync(DSH_ROOT)
      .filter((n) => {
        if (n.startsWith('.')) return false
        try {
          return statSync(join(DSH_ROOT, n)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

function memoryDirOf(name) {
  if (!name) return null
  return join(DSH_ROOT, name, '.workbuddy', 'memory')
}

// cwd 是否直接落在某 dsh 工作区目录下：返回工作区名（原始大小写）或 null。
// 单独导出此判定，供注入块区分「cwd 自动匹配」与「面板指定」两种来源。
function cwdWorkspaceHit(cwd) {
  if (!cwd) return null
  const cn = normSlash(cwd).toLowerCase()
  const rn = normSlash(DSH_ROOT).toLowerCase().replace(/\/+$/, '')
  if (!cn.startsWith(rn + '/')) return null
  const seg = cn.slice(rn.length + 1).split('/')[0]
  if (!seg) return null
  // 大小写不敏感匹配，返回工作区原始大小写名
  return listWorkspaces().find((w) => w.toLowerCase() === seg) || null
}

// Resolve which workspace memory to auto-load:
//   1) session cwd is inside a known dsh workspace -> that workspace
//   2) else config.activeProject (manually selected in the panel)
// Returns the workspace name, or null.
function resolveActiveProject(cwd) {
  const hit = cwdWorkspaceHit(cwd)
  if (hit) return hit
  const cfg = readConfig()
  if (cfg.activeProject && listWorkspaces().includes(cfg.activeProject)) {
    return cfg.activeProject
  }
  return null
}

// ---------- the injected memory block (layered, built synchronously) ----------
// L0 全局画像(预算) + L1 摘要/L2 相关条目(看有无 query) + L3 当日日志(预算)
// 完整 MEMORY.md 不再全量注入，模型用文件工具按需读详情。
function buildMemoryBlock(cwd, context, cfg) {
  const bProfile = budget(cfg, 'profileMaxChars', 2000)
  const bSummary = budget(cfg, 'summaryMaxChars', 1500)
  const bLog = budget(cfg, 'logMaxChars', 1500)
  const bEntry = budget(cfg, 'entryMaxChars', 800)
  const topK = budget(cfg, 'relevantTopK', 5)

  const lines = []
  lines.push('# WorkBuddy 记忆（由 dsh-wb-memory 插件注入，启用时生效）')
  lines.push('')
  lines.push('你拥有跨会话长期记忆，纯 Markdown 文件（无向量库），存于各 dsh 工作区 `.workbuddy/memory/`：')
  lines.push('- `<工作区>/.workbuddy/memory/MEMORY.md`：长期记忆（条目式，可带 frontmatter）')
  lines.push('- `<工作区>/.workbuddy/memory/<YYYY-MM-DD>.md`：每日日志')
  lines.push('- 全局用户画像：插件目录 USER.md')
  lines.push('- ⚠️ 为省 token，此处只注入【画像 + 摘要/相关条目 + 今日日志】，完整记忆请用文件读取工具按需打开。')
  lines.push('')

  // L0 全局画像
  const userMd = safeReadCap(join(MEM_DIR(), 'USER.md'), bProfile)
  if (userMd) {
    lines.push('## 全局用户记忆（USER.md）')
    lines.push(userMd)
    lines.push('')
  }

  const cwdHit = cwdWorkspaceHit(cwd)
  const active = resolveActiveProject(cwd)
  if (active) {
    lines.push(`## 当前工作区：${active}（${cwdHit ? '已自动匹配' : '面板指定'}）`)
    const dir = memoryDirOf(active)
    const query = getQuery(context)
    const memMd = safeReadRaw(join(dir, 'MEMORY.md'))
    if (memMd) {
      if (query) {
        // L2 相关条目（按当前任务召回 top-K）
        const rel = retrieveRelevant(memMd, query, topK)
        if (rel.length) {
          lines.push(`### 长期记忆 / 相关条目（按当前任务召回 top-${rel.length}）`)
          for (const e of rel) {
            lines.push(`#### ${e.title}`)
            const body = e.body.length > bEntry ? e.body.slice(0, bEntry) + '\n…(截断，完整见 MEMORY.md)' : e.body
            lines.push(body)
            lines.push('')
          }
        } else {
          lines.push('### 长期记忆 / 摘要（无高度相关条目，完整内容按需读 MEMORY.md）')
          lines.push(summarizeEntries(memMd, bSummary))
          lines.push('')
        }
      } else {
        // L1 摘要层（注入时机无当前 query，只给条目标题+首行）
        lines.push('### 长期记忆 / 摘要（完整内容请按需读取 MEMORY.md）')
        lines.push(summarizeEntries(memMd, bSummary))
        lines.push('')
      }
    }
    // L3 当日日志（追加式文件：保尾截断，最新记录一定注入）
    const today = todayStamp() + '.md'
    const log = safeReadTailCap(join(dir, today), bLog)
    if (log) {
      lines.push(`### 今日日志（${today}）`)
      lines.push(log)
      lines.push('')
    }
  } else {
    lines.push('## 未匹配到工作区')
    lines.push('当前会话工作目录不在已知 dsh 工作区下，也未在面板中选择工作区，仅注入了全局用户记忆。如需载入某工作区记忆，请在面板「当前激活工作区」中选择，或在该工作区下开启会话。')
    lines.push('')
  }

  const projects = listWorkspaces()
  if (projects.length) {
    lines.push('## 可用工作区')
    lines.push(projects.map((p) => '- ' + p + (p === active ? '  ← 当前' : '')).join('\n'))
    lines.push('')
  }

  lines.push('## 记忆纪律')
  lines.push('- **读**：接到任务先读 `<工作区>/.workbuddy/memory/MEMORY.md` 确认已有约定与坑；按关键词召回用 `GET /wb-memory/search?q=关键词&workspace=工作区名`（比读全文省 token）；当日上下文读今日日志。')
  lines.push('- **何时写**（实质性工作完成后立即记）：修复 bug、选定技术方案、踩了非显然的坑（环境/编码/工具缺陷）、用户表达偏好或约定、产出报告或完成重构。')
  lines.push('- **不写**：搜索与抓取内容、临时路径、工具报错本身（除非揭示可复现的环境坑）、一次性数据快照、寒暄短问答、密钥令牌。')
  lines.push('- **写到哪**：项目约定/选型/决策/坑 → MEMORY.md（条目带 frontmatter `<!-- tags: x,y / date: YYYY-MM-DD / importance: high -->`）；今天做了什么 → 今日日志；可复现流程 → 写成 Skill 不进记忆。口诀：下次照着做 → Skill；下次要知道 → 记忆。')
  lines.push('- **冲突消解**：新信息覆盖旧条目并留修订痕（`YYYY-MM-DD 用户更正：新值，此前旧值X`），不得并列矛盾事实。坑条目用四段式：现象 → 根因 → 绕过办法 → 影响边界，具体到命令与报错文本。')
  lines.push(`- **画像只读**：USER.md 不要直接改；跨项目通用的新发现按行追加到 \`${USERMD_CANDIDATES()}\`（一行一条，注明日期），巡检会自动评估并入画像。`)
  lines.push(`- 当前会话工作目录：${cwd || '(未知)'}`)
  lines.push('')
  return lines.join('\n')
}

// ---------- auto-digest: rule-based session memory capture (v4) ----------
// Subscribes to `session/event` and, at each successfully completed turn,
// appends a compact "user asked -> assistant concluded" line to the resolved
// workspace's daily log. This is the automatic counterpart to the manual
// "收尾时追加记录" convention: a skeleton of the day's activity, NOT a
// distilled insight — keep entries short, dedup by user-text prefix.
// Per-session in-memory buffer: { userTexts: string[], lastAssistant: string, sawUser: boolean }

const digestBuffers = new Map() // sessionId -> buffer
const digestStats = new Map() // 'YYYY-MM-DD' -> count written today (any workspace; anti-spam cap)

function digestConfig(cfg) {
  return {
    on: cfg && cfg.autoDigest === false ? false : true, // default ON
    maxPerDay: budget(cfg, 'digestMaxPerDay', 60),
    userChars: budget(cfg, 'digestUserChars', 80),
    assistantChars: budget(cfg, 'digestAssistantChars', 180),
    minUserChars: 12, // shorter prompts (纯寒暄/“继续”等) not worth a line
  }
}

// Extract plain text from a message content (string or parts array).
function digestTextOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ')
  }
  return ''
}

function digestNormalize(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function digestClip(s, n) {
  const t = digestNormalize(s)
  return t.length > n ? t.slice(0, n) + '…' : t
}

// 助手回复的结论常在尾部（开头多是复述任务与寒暄），纯头部截取会把结论截掉
// ——这正是 auto-digest 流水「记不到结论」的根因之一。改为头尾各取：
// 头 60% + 省略号 + 尾 40%，总长仍受 n 约束。（导出供 smoke 测试）
export function digestClipEnds(s, n) {
  const t = digestNormalize(s)
  if (t.length <= n) return t
  const head = Math.max(1, Math.floor(n * 0.6))
  const tail = Math.max(0, n - head - 1)
  return t.slice(0, head) + (tail > 0 ? '…' + t.slice(-tail) : '…')
}

function digestOnEvent(session, event) {
  try {
    const cfg = readConfig()
    const dc = digestConfig(cfg)
    if (!cfg.enabled || !dc.on) return
    // Main conversations only: skip subagents/delegations.
    const h = session && session.header
    if (!h) return
    if (h.parentSession || (h.delegationDepth || 0) > 0) return

    // 泄漏防护：异常路径（会话中止、turn/end 非 completed）可能让 buffer 残留；
    // 超上限时丢弃最旧会话的 buffer（Map 保持插入序），防长期运行累积。
    if (digestBuffers.size > 128) {
      const oldest = digestBuffers.keys().next().value
      if (oldest !== undefined) digestBuffers.delete(oldest)
    }

    if (event.type === 'user/message') {
      const m = event.data
      if (!m || m.role !== 'user') return
      // Only real human input: source.kind 'user'. Plugin injections
      // (memory blocks, system reminders), tool results, and relays are excluded.
      if (!m.source || m.source.kind !== 'user') return
      const b = digestBuffers.get(session.id) || { userTexts: [], lastAssistant: '' }
      const t = digestClip(digestTextOf(m.content), 300)
      if (t) b.userTexts.push(t)
      digestBuffers.set(session.id, b)
      return
    }
    if (event.type === 'assistant/message') {
      const m = event.data && event.data.message
      if (!m) return
      const t = digestTextOf(m.content)
      if (t) {
        const b = digestBuffers.get(session.id) || { userTexts: [], lastAssistant: '' }
        b.lastAssistant = t
        digestBuffers.set(session.id, b)
      }
      return
    }
    if (event.type === 'turn/end') {
      const b = digestBuffers.get(session.id)
      digestBuffers.delete(session.id)
      if (!b || b.userTexts.length === 0) return
      // TurnEndReason: { kind: 'completed' | 'blocked' | 'error' | 'aborted' | 'interrupted' | ... }
      // Only successfully completed turns produce a digest line.
      const reason = event.data && event.data.reason && event.data.reason.kind
      if (reason !== 'completed') return
      const ws = resolveActiveProject(h.cwd)
      if (!ws) return
      const dir = memoryDirOf(ws)
      const userText = digestNormalize(b.userTexts.join(' / '))
      if (userText.length < dc.minUserChars) return
      const day = todayStamp()
      // 跨天清理旧键（digestStats 按 day 计数，旧键不清理会随运行天数无限增长）
      for (const k of digestStats.keys()) if (k !== day) digestStats.delete(k)
      if ((digestStats.get(day) || 0) >= dc.maxPerDay) return
      const logPath = join(dir, day + '.md')
      // Dedup: same user prefix already logged today -> skip.
      const key = userText.slice(0, 60)
      const existing = safeReadRaw(logPath) || ''
      if (existing.includes(key)) return
      const hhmm = new Date(event.time || Date.now()).toTimeString().slice(0, 5)
      const line = `- ${hhmm}【自动】${digestClip(userText, dc.userChars)} → ${digestClipEnds(b.lastAssistant, dc.assistantChars)}`
      mkdirSync(dir, { recursive: true })
      appendFileSync(logPath, (existing ? (existing.endsWith('\n') ? '' : '\n') : `# ${day} 日志（含自动流水）\n`) + line + '\n', 'utf8')
      digestStats.set(day, (digestStats.get(day) || 0) + 1)
    }
  } catch (e) {
    // Never let digest failures break the session pipeline.
    try { console.log('[wb-memory][digest] skipped: ' + String((e && e.message) || e)) } catch {}
  }
}

// ---------- auto-distill: daily log -> MEMORY.md LLM distillation (v5) ----------
// State-driven scheduler (no cron in DSH): on startup (delayed) + every hour,
// scan each workspace's memory dir for date-stamped logs OLDER than today that
// were never distilled (marker file in the plugin dir), feed each to one LLM
// call, parse the returned entries, and append them to that workspace's
// MEMORY.md. Idempotent per (workspace, date): a marker entry is written only
// after a successful (possibly zero-entry) distillation, so crashes/restarts
// retry naturally. Logs dated today are left alone while auto-digest may still
// be appending to them.

const DISTILL_MARKER_FILE = () => join(MEM_DIR(), 'distilled.json') // { ws: { 'YYYY-MM-DD': { at, added } } }
const distillState = { running: false, warnedNoModel: false }

function distillConfig(cfg) {
  return {
    on: cfg && cfg.autoDistill === false ? false : true,
    provider: (cfg && cfg.distillProvider) || 'zai-coding-cn',
    model: (cfg && cfg.distillModel) || '',
    maxInputChars: budget(cfg, 'distillMaxInputChars', 12000),
    maxTokens: budget(cfg, 'distillMaxTokens', 2000),
    timeoutMs: budget(cfg, 'distillTimeoutMs', 180000),
    intervalMs: budget(cfg, 'distillIntervalMs', 60 * 60 * 1000),
    startDelayMs: budget(cfg, 'distillStartDelayMs', 60 * 1000),
    dupThreshold: (cfg && Number(cfg.dupThreshold) > 0 && Number(cfg.dupThreshold) <= 1) ? Number(cfg.dupThreshold) : 0.45,
  }
}

// compact（MEMORY.md 超阈值整理）的 LLM 路由：可独立配置 compactProvider /
// compactModel，缺省回落到提炼路由。独立配置的动机：flash 级模型对「条目数
// 不得少于 N 条」这类数值硬约束的指令遵循很差（实测 deepseek-v4-flash 连续
// 3 天无视 ≥半数条目要求被护栏拒收），整理任务需要更强的模型。
// 预算与思考档：思考型模型（glm-5.3 官方不支持关思考）在提炼路由的 2000
// maxTokens 下思考就能烧完全部预算、正文输出为空（实测 2026-08-30 compact
// 返回 0 字符）。整理正文本身需要 ~5k token，故 compact 默认 8000 预算；显式
// 配置了整理模型时同时压低思考档（机械合并任务不需要深度思考）。
function compactRoute(cfg, dc) {
  const explicit = Boolean(cfg && cfg.compactModel)
  return {
    provider: (cfg && cfg.compactProvider) || dc.provider,
    model: (cfg && cfg.compactModel) || dc.model,
    maxTokens: budget(cfg, 'compactMaxTokens', 8000),
    reasoningEffort: explicit ? 'low' : undefined,
  }
}

function readDistillMarkers() {
  return readJsonBomSafe(DISTILL_MARKER_FILE()) || {}
}

function writeDistillMarkers(m) {
  writeFileSync(DISTILL_MARKER_FILE(), JSON.stringify(m, null, 2), 'utf8')
}

// Date-stamped logs older than today, not yet distilled. Scans BOTH the memory
// dir root AND archive/ (v7): a manual GC may archive a log away before the
// distiller ever saw it — archived logs must remain distillable, otherwise
// they are silently lost to distillation forever. (.trash/ is NOT scanned:
// deleted content must stay deleted.)
function pendingDistillLogs(dir, done) {
  const today = todayStamp()
  const out = []
  const seen = new Set()
  for (const root of [dir, join(dir, 'archive')]) {
    try {
      for (const f of readdirSync(root)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f)
        if (!m || m[1] >= today) continue
        if (done[m[1]] || seen.has(m[1])) continue
        seen.add(m[1])
        out.push({ date: m[1], file: join(root, f) })
      }
    } catch {}
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

// Existing MEMORY.md entry titles, so the LLM avoids duplicating them.
function memoryEntryTitles(dir) {
  const raw = safeReadRaw(join(dir, 'MEMORY.md')) || ''
  const titles = []
  for (const line of raw.split('\n')) {
    const t = /^##\s+(.*)/.exec(line)
    if (t) titles.push(t[1].trim())
  }
  return titles
}

function distillSystemPrompt() {
  return [
    '你是记忆提炼器。给你一个 dsh 工作区某天的工作日志，提炼出具有长期价值的记忆条目。',
    '',
    '记入标准（至少满足一条）：',
    '- 可复用的结论、教训、踩坑（下次同类任务可直接用）',
    '- 稳定的偏好或约定（用户明确表达的工作方式）',
    '- 关键事实（路径、版本、配置值、最终决策结果）',
    '不记：一次性任务的过程细节、临时状态、纯流水。',
    '「坑」类条目必须用四段式：**现象** → **根因** → **绕过办法** → **影响边界**，要具体到命令、报错文本、可执行的替代方案，并标注实测无效的反例。',
    '结论的适用范围有限时，必须顺带标注可信边界（例：「仅作信号参考，绝对值不可信，盈亏须回源核实」）。',
    '',
    '输出格式（严格遵守，除条目外不要输出任何说明文字）：',
    '每个条目：',
    '<!-- tags: 逗号分隔关键词 / date: 日志日期 / importance: high|medium|low -->',
    '## 简短标题',
    '正文 2-4 行，写结论不写过程。',
    '',
    '多个条目直接依次排列。若整个日志没有长期价值，输出：（空，什么都不写）。',
  ].join('\n')
}

// One LLM call: raw chunks -> text. No BlockAssembler import (keeps the plugin
// dependency-free); this call only ever needs text blocks.
// `route` 可选覆盖 provider/model（compact 走独立路由时传入）。
async function distillCallLlm(llm, dc, system, userText, route) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), dc.timeoutMs)
  try {
    const options = {
      provider: (route && route.provider) || dc.provider,
      model: (route && route.model) || dc.model,
      system,
      messages: [
        {
          id: 'wb-memory-distill-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          content: [{ type: 'text', text: userText }],
          source: { kind: 'plugin', plugin: 'dsh-wb-memory' },
        },
      ],
      maxTokens: (route && route.maxTokens) || dc.maxTokens,
      signal: ac.signal,
    }
    if (route && route.reasoningEffort) options.reasoningEffort = route.reasoningEffort
    let text = ''
    let finish = null
    for await (const chunk of llm.stream(options)) {
      if (chunk && chunk.type === 'text-delta') text += chunk.text || ''
      else if (chunk && chunk.type === 'finish') finish = chunk
    }
    if (finish && (finish.reason === 'error' || finish.reason === 'aborted')) {
      throw new Error('llm finish: ' + JSON.stringify(finish.reason))
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

// Parse the model output into entry blocks. Each entry starts with a
// "<!-- tags:" comment line and contains a "## " heading; junk is dropped.
function parseDistillEntries(out) {
  const entries = []
  const parts = String(out || '').split(/\n(?=<!--)/)
  for (let p of parts) {
    p = p.trim()
    if (!p.startsWith('<!--')) continue
    const headingAt = p.search(/^##\s+/m)
    if (headingAt < 0) continue
    const fm = /<!--[\s\S]*?-->/.exec(p)
    if (!fm) continue
    const body = p.slice(headingAt).trim()
    entries.push(fm[0].trim() + '\n' + body)
  }
  return entries
}

async function distillWorkspaceDate(ctx, dc, ws, dir, item) {
  const logRaw = safeReadRaw(item.file) || ''
  const logText = logRaw.length > dc.maxInputChars ? logRaw.slice(0, dc.maxInputChars) + '\n…(截断)' : logRaw
  const titles = memoryEntryTitles(dir)
  const userText = [
    `工作区：${ws}`,
    `日志日期：${item.date}`,
    titles.length ? `已有记忆条目标题（勿重复）：\n${titles.map((t) => '- ' + t).join('\n')}` : '（该工作区还没有长期记忆条目）',
    '',
    '--- 日志全文 ---',
    logText,
  ].join('\n')

  const out = await distillCallLlm(globalThis.__wbMemoryLlm, dc, distillSystemPrompt(), userText)
  let entries = parseDistillEntries(out)
  // 幂等护栏（v7.3）：标记文件丢失/损坏导致同一日志被重复提炼时（2026-08-30
  // BOM 事故即此），与 MEMORY.md 现有条目高度相似的新条目直接丢弃，不再盲目
  // 追加。相似度口径与面板近重复检测一致：max(Jaccard, 重叠率) ≥ dupThreshold。
  if (entries.length > 0) {
    const memPath = join(dir, 'MEMORY.md')
    const existing = readMemoryEntries(safeReadRaw(memPath) || '')
    if (existing.length) {
      const kept = []
      let dropped = 0
      for (const ne of entries) {
        const title = (/^##\s+(.+)$/m.exec(ne) || [])[1] || ''
        const body = ne.replace(/^<!--[\s\S]*?-->\s*/m, '')
        const text = title + '\n' + body
        const dup = existing.some((ex) => {
          const t = ex.title + '\n' + ex.body
          return Math.max(jaccard(text, t), overlapCoeff(text, t)) >= dc.dupThreshold
        })
        if (dup) dropped++
        else kept.push(ne)
      }
      if (dropped > 0) {
        console.log(`[wb-memory][distill] ${ws} ${item.date}: ${dropped} 条与现有记忆高度相似，已丢弃（幂等护栏）`)
      }
      entries = kept
    }
  }
  if (entries.length > 0) {
    const memPath = join(dir, 'MEMORY.md')
    mkdirSync(dir, { recursive: true })
    let mem = safeReadRaw(memPath) || ''
    if (mem && !mem.startsWith('# ')) mem = '# 项目长期记忆\n\n' + mem
    if (!mem.endsWith('\n')) mem += '\n'
    mem += '\n' + entries.join('\n\n') + '\n'
    writeFileSync(memPath, mem, 'utf8')
  }
  return entries.length
}

// ---------- auto-compact: LLM 整理超阈值 MEMORY.md (v6) ----------
// 巡逻时发现某工作区 MEMORY.md 超 memoryCharThreshold → 先备份到 archive/，
// 再让 LLM 整理（合并重复/删过时/精炼表述），校验通过才落盘。
// 护栏：必须变更短、压回阈值内、条目数不少于原来一半、每天每工作区最多
// 尝试一次（无论成败——防震荡、防烧 token；失败明天巡逻再试）。

function countMdEntries(md) {
  return (String(md || '').match(/^##\s+/gm) || []).length
}

// compact 目标字符数（v7.5 自适应，退出「与阈值军备竞赛」）：无有效历史时兜底
// 0.8×threshold；否则用上次实测超幅（after/target）反推 threshold/超幅×0.95
// （5% 安全边），并限幅在 [0.3, 0.8]×threshold。导出供 smoke 测试。
// 实测依据（2026-08-30，glm-5.3）：target 6400→实际 9380、8000→10180、
// 9600→12745，恒超 27%~47%——固定系数与护栏阈值之间没有余量，拒收后每天
// 重试一次、永不自愈。
export function compactTargetChars(threshold, last) {
  const fallback = Math.floor(threshold * 0.8)
  if (!last || !Number.isFinite(last.target) || !Number.isFinite(last.after) || last.target <= 0 || last.after <= 0) {
    return fallback
  }
  const overshoot = last.after / last.target
  const adaptive = Math.floor((threshold / overshoot) * 0.95)
  return Math.max(Math.floor(threshold * 0.3), Math.min(fallback, adaptive))
}

function compactSystemPrompt(threshold, size, target, minCount) {
  return [
    '你是记忆整理器。给你一个工作区的 MEMORY.md 全文，当前 ' + size + ' 字符，已超容量阈值 ' + threshold + '。',
    '请把内容整理压缩到 ' + target + ' 字符以内（约阈值的八成）。',
    '',
    '两项硬性要求（违反任何一条都会被直接拒收）：',
    'A. 条目数（"## " 标题计数）不得少于 ' + minCount + ' 条——宁可保留更多短条目，也不得丢弃一半以上主题',
    'B. 输出总长度不超过 ' + threshold + ' 字符——当与要求 A 冲突时，优先满足 A（保条目数），把每条正文压缩到 1-2 行短句',
    '',
    '压缩策略（按此顺序执行）：',
    '1. 合并重复或高度相似的条目：同主题多条合一条，保留各自关键事实，标题概括合并后主题',
    '2. 删除已过时失效的内容：已解决的环境问题、旧版本信息、被后续结论推翻的条目',
    '3. 压缩正文：每条正文限 1-2 行短句，只留结论与关键值（路径/配置值/版本号/命令）；能删的修饰语、背景、过程全部删掉',
    '仍有长期价值的关键事实宁短勿丢——可缩写不可删除主题',
    '',
    '格式要求（严格遵守）：',
    '- 首行保留 "# 项目长期记忆"',
    '- 每条保持：<!-- tags: 关键词 / date: 日期 / importance: 等级 --> 随后 "## 标题" 再正文',
    '- 合并条目的 date 取其中较新者，importance 取较高者，tags 取并集',
    '- 直接输出整理后的完整文件内容，前后不要任何说明文字',
  ].join('\n')
}

async function compactMemoryIfOver(llm, cfg, dc, ws, dir, markers) {
  const threshold = budget(cfg, 'memoryCharThreshold', 8000)
  const memPath = join(dir, 'MEMORY.md')
  const raw = safeReadRaw(memPath)
  if (!raw || raw.length <= threshold) return null // 未超阈值，无事可做
  const day = todayStamp()
  if (!markers[ws]) markers[ws] = {}
  const last = markers[ws]['__compact__']
  if (last && last.day === day) return null // 今天已试过（成败都算），防震荡

  const oldCount = countMdEntries(raw)
  // 先备份原版（整理失败也有退路）
  const arch = join(dir, 'archive')
  try {
    mkdirSync(arch, { recursive: true })
    writeFileSync(join(arch, 'MEMORY.bak-' + day + '.md'), raw, 'utf8')
  } catch {}

  let outcome
  try {
    // 自适应目标（v7.5）：用上一次 compact 的实测超幅反推本次 target，
    // 见 compactTargetChars 注释。target 会记入 outcome 供下次自适应取用。
    const target = compactTargetChars(threshold, last)
    const minCount = Math.max(1, Math.ceil(oldCount / 2))
    const out = await distillCallLlm(llm, dc, compactSystemPrompt(threshold, raw.length, target, minCount), '--- MEMORY.md 全文 ---\n' + raw, compactRoute(cfg, dc))
    const trimmed = String(out || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const newCount = countMdEntries(trimmed)
    const checks = {
      nonEmpty: trimmed.length > 0,
      shorter: trimmed.length < raw.length,
      underThreshold: trimmed.length <= threshold,
      keptHalfEntries: newCount >= Math.max(1, Math.ceil(oldCount / 2)),
    }
    const ok = Object.values(checks).every(Boolean)
    if (ok) {
      writeFileSync(memPath, trimmed.endsWith('\n') ? trimmed : trimmed + '\n', 'utf8')
      console.log('[wb-memory][compact] ' + ws + ': ' + raw.length + ' -> ' + trimmed.length + ' 字符（' + oldCount + ' -> ' + newCount + ' 条）')
    } else {
      console.log('[wb-memory][compact] ' + ws + ' 校验未过 ' + JSON.stringify(checks) + '，保留原文件')
    }
    outcome = { ok, before: raw.length, after: trimmed.length, oldCount, newCount, checks, target }
  } catch (e) {
    console.log('[wb-memory][compact] ' + ws + ' 失败（明天再试）: ' + String((e && e.message) || e))
    outcome = { ok: false, error: String((e && e.message) || e), before: raw.length, target }
  }
  // 无论成败都记录今天已尝试（键名 __compact__ 不与日期键冲突）
  markers[ws]['__compact__'] = { day, at: new Date().toISOString(), ...outcome }
  return outcome
}

// ---------- USER.md 画像候选机制（v7.5） ----------
// 「画像只读」纪律的工程侧：agent 不直接改 USER.md（注入块已声明），跨项目通用
// 的新发现按行追加到插件目录 USER-CANDIDATES.md；sweep 发现非空时调提炼路由
// 评估并入（旧画像先备份 .bak），处理留痕 USER-CANDIDATES.log 后清空候选。
// 幂等与限频：处理成功即清空候选文件；失败每天至多重试一次（markers.__usermd__）。
const USERMD_FILE = () => join(MEM_DIR(), 'USER.md')
const USERMD_CANDIDATES = () => join(MEM_DIR(), 'USER-CANDIDATES.md')
const USERMD_LOG = () => join(MEM_DIR(), 'USER-CANDIDATES.log')
const USERMD_MAX_CHARS = 6000 // 画像文件硬上限（注入另有 profileMaxChars 截断）

function userMdMergePrompt() {
  return [
    '你是用户画像维护器。给你当前画像（USER.md）与候选新信息（各会话按行追加），产出更新后的完整 USER.md。',
    '',
    '并入标准（只并入跨项目且三个月后仍有用的）：',
    '- 稳定的个人偏好与工作习惯',
    '- 跨项目的环境坑（机器/系统/工具层面的）',
    '- 通用的事实性信息（设备、账号体系、路径约定）',
    '丢弃：项目专属信息、一次性事实、密钥/令牌/密码、与画像无关的流水。',
    '',
    '规则：',
    '- 新信息与画像矛盾时覆盖旧内容并留修订痕：（YYYY-MM-DD 更正：新值，此前旧值X）',
    '- 同主题信息合并进已有小节，不新开重复小节；无候选可并入时原样输出当前画像',
    '- 输出总长不超过 ' + USERMD_MAX_CHARS + ' 字符，保持精炼',
    '- 直接输出更新后的完整文件内容，前后不要任何说明文字',
  ].join('\n')
}

async function processUserCandidates(llm, dc, markers) {
  const day = todayStamp()
  const last = markers.__usermd__
  if (last && last.day === day && !last.ok) return { skipped: 'failed-today' }
  let raw = ''
  try {
    raw = readFileSync(USERMD_CANDIDATES(), 'utf8')
  } catch {
    return { skipped: 'no-file' }
  }
  raw = raw.trim()
  if (!raw) return { skipped: 'empty' }
  const current = safeReadRaw(USERMD_FILE()) || ''
  const userText = [
    '--- 当前 USER.md ---',
    current || '（尚无画像）',
    '',
    '--- 候选新信息（一行一条，由各会话追加） ---',
    raw,
  ].join('\n')
  const out = await distillCallLlm(llm, dc, userMdMergePrompt(), userText)
  const trimmed = String(out || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  const checks = {
    nonEmpty: trimmed.length > 0,
    withinCap: trimmed.length <= USERMD_MAX_CHARS,
    noMassDeletion: current ? trimmed.length >= Math.floor(current.length * 0.3) : true,
  }
  const ok = Object.values(checks).every(Boolean)
  markers.__usermd__ = { day, at: new Date().toISOString(), ok, checks, before: current.length, after: trimmed.length }
  if (!ok) {
    console.log('[wb-memory][usermd] 候选评估校验未过 ' + JSON.stringify(checks) + '，候选保留明天再试')
    return { ok: false, checks }
  }
  try {
    if (current) copyFileSync(USERMD_FILE(), USERMD_FILE() + '.bak')
  } catch {}
  writeFileSync(USERMD_FILE(), trimmed.endsWith('\n') ? trimmed : trimmed + '\n', 'utf8')
  try {
    appendFileSync(USERMD_LOG(), `[${new Date().toISOString()}] 处理 ${raw.split('\n').length} 行候选：USER.md ${current.length} -> ${trimmed.length} 字符\n--- 候选原文 ---\n${raw}\n\n`, 'utf8')
  } catch {}
  writeFileSync(USERMD_CANDIDATES(), '', 'utf8')
  console.log(`[wb-memory][usermd] 候选已评估并入：USER.md ${current.length} -> ${trimmed.length} 字符`)
  return { ok: true, processed: raw.split('\n').length, before: current.length, after: trimmed.length }
}

async function checkAndDistill(ctx, manual) {
  if (distillState.running) return { ok: true, skipped: 'busy' }
  distillState.running = true
  const results = {}
  try {
    const cfg = readConfig()
    const dc = distillConfig(cfg)
    if (!cfg.enabled || !dc.on) return { ok: true, skipped: 'disabled' }
    const croute = compactRoute(cfg, dc)
    if (!dc.model && !croute.model) {
      if (!distillState.warnedNoModel || manual) {
        distillState.warnedNoModel = true
        console.log('[wb-memory][distill] 未配置 distillModel/compactModel，提炼与整理均未启用（config.json 设 distillProvider/distillModel，可选 compactProvider/compactModel）')
      }
      return { ok: true, skipped: 'no-model' }
    }
    let providerIds = []
    let llmErr = ''
    const llm = globalThis.__wbMemoryLlm
    if (!llm) {
      llmErr = ' llm service not injected yet'
    } else {
      try {
        providerIds = llm.listProviders().map((p) => (p && (p.id || p.provider)) || p)
      } catch (e) {
        llmErr = ' listProviders error: ' + String((e && e.message) || e)
      }
    }
    // 双路由就绪检查：提炼路由（dc）与整理路由（croute）各自的 provider 都必须在位
    const needed = []
    if (dc.model && !needed.includes(dc.provider)) needed.push(dc.provider)
    if (croute.model && !needed.includes(croute.provider)) needed.push(croute.provider)
    const missing = needed.filter((p) => !providerIds.some((x) => String(x) === p))
    if (missing.length) {
      // 诊断：带上实际可见的 provider 列表与 llm 取用错误，便于定位路由名差异
      const msg = 'provider-not-ready:' + missing.join(',') + ' (visible: [' + providerIds.join(', ') + ']' + llmErr + ')'
      if (manual) console.log('[wb-memory][distill] ' + msg)
      return { ok: true, skipped: msg }
    }
    const markers = readDistillMarkers()
    // v7.5: 画像候选评估（全局，先于各工作区提炼；需提炼路由就绪）
    if (dc.model) {
      try {
        const ur = await processUserCandidates(llm, dc, markers)
        if (ur && ur.ok) results['usermd'] = ur.after + ' chars (' + ur.processed + ' lines)'
        else if (ur && ur.checks) results['usermd'] = 'kept candidates (' + JSON.stringify(ur.checks) + ')'
      } catch (e) {
        markers.__usermd__ = { day: todayStamp(), at: new Date().toISOString(), ok: false, error: String((e && e.message) || e) }
        results['usermd'] = 'error: ' + String((e && e.message) || e)
        console.log('[wb-memory][usermd] 候选评估失败（明天再试）: ' + String((e && e.message) || e))
      }
    }
    const wsList = listWorkspaces()
    console.log('[wb-memory][distill] sweep: ' + wsList.length + ' workspaces (' + wsList.join(', ') + '), root=' + DSH_ROOT)
    for (const ws of wsList) {
      const dir = memoryDirOf(ws)
      const done = markers[ws] || {}
      // 仅配置了整理路由（无提炼模型）时跳过逐日提炼，只做 compact
      if (dc.model) {
        const pending = pendingDistillLogs(dir, done)
        for (const item of pending) {
          try {
            const added = await distillWorkspaceDate(ctx, dc, ws, dir, item)
            done[item.date] = { at: new Date().toISOString(), added }
            results[ws + '/' + item.date] = added + ' entries'
            console.log(`[wb-memory][distill] ${ws} ${item.date}: +${added} 条进入 MEMORY.md`)
          } catch (e) {
            // Leave the date unmarked; the next sweep retries it.
            results[ws + '/' + item.date] = 'error: ' + String((e && e.message) || e)
            console.log(`[wb-memory][distill] ${ws} ${item.date} 失败（稍后重试）: ` + String((e && e.message) || e))
          }
        }
        if (Object.keys(done).length) markers[ws] = done
      }
      // v6: 该工作区 MEMORY.md 超阈值则 LLM 整理（提炼之后做，先增后压）
      try {
        const cr = await compactMemoryIfOver(llm, cfg, dc, ws, dir, markers)
        if (cr) {
          results[ws + '/compact'] = cr.ok
            ? 'compressed ' + cr.before + ' -> ' + cr.after + ' chars (' + cr.oldCount + ' -> ' + cr.newCount + ' entries)'
            : 'kept original (' + (cr.error || 'checks failed') + ')'
        }
      } catch (e) {
        results[ws + '/compact'] = 'error: ' + String((e && e.message) || e)
      }
    }
    writeDistillMarkers(markers)
    return { ok: true, results }
  } catch (e) {
    console.log('[wb-memory][distill] sweep error: ' + String((e && e.message) || e))
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    distillState.running = false
  }
}

// 手动触发提炼（面板/调试用；GET 后台跑不等待，?wait=1 同步等待结果）
async function handleDistill(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  try {
    const u = new URL(req.url, 'http://x')
    if (u.searchParams.get('wait') === '1') {
      const r = await checkAndDistill(globalThis.__wbMemoryCtx, true)
      sendJson(res, 200, r)
    } else {
      checkAndDistill(globalThis.__wbMemoryCtx, true).catch(() => {})
      sendJson(res, 200, { ok: true, started: true })
    }
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// 可用 LLM 路由列表（给面板"提炼模型"下拉框）：providers -> models。
async function handleModels(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  try {
    const llm = globalThis.__wbMemoryLlm
    if (!llm) {
      sendJson(res, 200, { providers: [], note: 'llm service not injected yet (restart or wait)' })
      return
    }
    const providers = (llm.listProviders() || []).map((p) => (p && (p.id || p.provider)) || p)
    const out = []
    for (const pid of providers) {
      let models = []
      try {
        models = await llm.listModels(pid)
      } catch {}
      out.push({
        id: pid,
        models: (models || []).map((m) => {
          if (m && typeof m === 'object') return { id: m.id || m.model || String(m), name: m.name || '' }
          return { id: String(m), name: '' }
        }),
      })
    }
    sendJson(res, 200, { providers: out })
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// ---------- HTTP route handlers (one per path; branch on method) ----------
async function handleConfig(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, readConfig())
    return
  }
  if (req.method === 'POST') {
    if (!sameOrigin(req)) {
      res.writeHead(403)
      res.end()
      return
    }
    try {
      const body = await readJsonBody(req)
      const cfg = readConfig()
      if (typeof body.enabled === 'boolean') cfg.enabled = body.enabled
      if (typeof body.autoDigest === 'boolean') cfg.autoDigest = body.autoDigest
      if (typeof body.autoDistill === 'boolean') cfg.autoDistill = body.autoDistill
      if (typeof body.gcEnabled === 'boolean') cfg.gcEnabled = body.gcEnabled
      if (typeof body.distillProvider === 'string') cfg.distillProvider = body.distillProvider
      if (typeof body.distillModel === 'string') cfg.distillModel = body.distillModel
      if (typeof body.compactProvider === 'string') cfg.compactProvider = body.compactProvider
      if (typeof body.compactModel === 'string') cfg.compactModel = body.compactModel
      if (Number.isFinite(Number(body.compactMaxTokens)) && Number(body.compactMaxTokens) > 0) {
        cfg.compactMaxTokens = Math.floor(Number(body.compactMaxTokens))
      }
      if ('activeProject' in body) {
        const v = body.activeProject
        // '' / null / undefined => clear; otherwise must be a known workspace
        if (!v) cfg.activeProject = null
        else if (listWorkspaces().includes(String(v))) cfg.activeProject = String(v)
        else {
          sendJson(res, 400, { error: 'unknown workspace: ' + String(v) })
          return
        }
      }
      writeConfig(cfg)
      ensureStructure()
      sendJson(res, 200, { ok: true, ...cfg })
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) })
    }
    return
  }
  methodNotAllowed(res, 'GET, POST')
}

// List workspace names (for the panel dropdown).
function handleWorkspaces(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  try {
    sendJson(res, 200, { workspaces: listWorkspaces() })
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// Collect memory files for the ACTIVE workspace (from its .workbuddy/memory dir).
function listFiles() {
  const cfg = readConfig()
  const active = cfg.activeProject
  const out = []
  if (!active) return out
  const dir = memoryDirOf(active)
  let ents
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    if (!e.isFile()) continue
    const a = join(dir, e.name)
    let st
    try {
      st = statSync(a)
    } catch {
      continue
    }
    out.push({
      path: e.name,
      workspace: active,
      created: st.birthtime.toISOString(),
      modified: st.mtime.toISOString(),
      size: st.size,
    })
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  return out
}

function handleFiles(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  try {
    sendJson(res, 200, { files: listFiles(), workspace: readConfig().activeProject })
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// All file ops are scoped to the ACTIVE workspace's .workbuddy/memory dir.
// `path` is just a filename; ".." traversal is stripped via basename + a
// boundary check against the memory dir.
function resolveMemoryPath(active, rawRel) {
  const dir = memoryDirOf(active)
  if (!dir) return null
  const fn = basename(String(rawRel || ''))
  if (!fn) return null
  const abs = join(dir, fn)
  if (!abs.startsWith(dir)) return null
  return abs
}

async function handleFile(req, res) {
  const active = readConfig().activeProject
  if (req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost')
      const abs = resolveMemoryPath(active, u.searchParams.get('path') || '')
      if (!abs) {
        sendJson(res, 400, { error: 'bad path or no active workspace' })
        return
      }
      sendJson(res, 200, { path: basename(abs), workspace: active, content: readFileSync(abs, 'utf8') })
    } catch (e) {
      sendJson(res, 404, { error: String((e && e.message) || e) })
    }
    return
  }
  if (req.method === 'POST') {
    if (!sameOrigin(req)) {
      res.writeHead(403)
      res.end()
      return
    }
    try {
      const body = await readJsonBody(req)
      const abs = resolveMemoryPath(active, body.path || '')
      if (!abs) {
        sendJson(res, 400, { error: 'bad path or no active workspace' })
        return
      }
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, String(body.content || ''), 'utf8')
      sendJson(res, 200, { ok: true })
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) })
    }
    return
  }
  if (req.method === 'DELETE') {
    if (!sameOrigin(req)) {
      res.writeHead(403)
      res.end()
      return
    }
    try {
      const u = new URL(req.url, 'http://localhost')
      const abs = resolveMemoryPath(active, u.searchParams.get('path') || '')
      if (!abs) {
        sendJson(res, 400, { error: 'bad path or no active workspace' })
        return
      }
      // 删除守卫：rename 到 .trash/ 而非 unlink（可回滚，绕 safe-delete shim）
      const trashed = safeTrash(memoryDirOf(active), basename(abs))
      if (trashed.ok) sendJson(res, 200, { ok: true, trashedTo: trashed.trashedTo })
      else sendJson(res, 500, { error: trashed.error })
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) })
    }
    return
  }
  methodNotAllowed(res, 'GET, POST, DELETE')
}

// Inspect the last observed session cwd + how it resolved, to verify whether
// harness passes the workspace folder as the session cwd (enabling auto-match).
function handleDebugCwd(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  try {
    const ws = listWorkspaces().map((name) => ({ name, path: join(DSH_ROOT, name) }))
    sendJson(res, 200, {
      lastCwd: debugCwd.lastCwd,
      lastResolved: debugCwd.lastResolved,
      lastAt: debugCwd.lastAt,
      dshRoot: DSH_ROOT,
      matchRule: 'cwd.startsWith(DSH_ROOT + "/" + <workspaceName>)',
      workspaces: ws,
      note: 'lastCwd 取自上一次会话注入时实际拿到的 context.agent.session.header.cwd。在 harness 切到某工作区开聊后，刷新本接口即可看到 cwd 是否变为 D:\\datas\\Deepseek Harness\\<工作区>；若是，auto-match 生效，记忆自动注入。',
    })
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// 检索：Agent 主动按关键词召回当前工作区相关记忆条目（L2 检索的主动入口）
function handleSearch(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  try {
    const u = new URL(req.url, 'http://localhost')
    const q = u.searchParams.get('q') || ''
    const cfg = readConfig()
    // workspace 参数优先（Agent 显式指定自己所在工作区）；缺省用面板 activeProject
    const wsParam = u.searchParams.get('workspace') || ''
    const active =
      wsParam && listWorkspaces().includes(wsParam) ? wsParam : cfg.activeProject
    if (!active) {
      sendJson(res, 400, { error: 'no active workspace (set panel activeProject or pass ?workspace=)' })
      return
    }
    const dir = memoryDirOf(active)
    const memMd = safeReadRaw(join(dir, 'MEMORY.md'))
    if (!memMd) {
      sendJson(res, 200, { workspace: active, query: q, results: [] })
      return
    }
    const k = budget(cfg, 'relevantTopK', 5)
    const rel = retrieveRelevant(memMd, q, k)
    sendJson(res, 200, {
      workspace: active,
      query: q,
      results: rel.map((e) => ({ title: e.title, body: e.body, tags: e.tags, date: e.date, importance: e.importance })),
    })
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// 治理：手动触发 TTL 日志归档 + MEMORY.md 容量检测（面板按钮调用）
async function handleGc(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  if (!sameOrigin(req)) {
    res.writeHead(403)
    res.end()
    return
  }
  try {
    const cfg = readConfig()
    if (cfg.gcEnabled === false) {
      sendJson(res, 200, { ok: false, skipped: 'gcEnabled=false' })
      return
    }
    const active = cfg.activeProject
    if (!active) {
      sendJson(res, 400, { error: 'no active workspace' })
      return
    }
    const dir = memoryDirOf(active)
    const result = runGc(dir, cfg)
    sendJson(res, 200, { ok: true, workspace: active, ...result })
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// 运行状态（面板状态条数据源；纯只读，不触发任何动作——不要用 POST /gc 轮询）。
// workspace 参数优先（面板锁定工作区时传）；否则按 cwd 自动匹配 → activeProject，
// 与注入块的工作区解析口径一致。未解析到工作区时 resolvedWorkspace 为 null，
// 前端显示「—」，不抛错。
function handleStatus(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  try {
    const cfg = readConfig()
    const u = new URL(req.url, 'http://localhost')
    const wsParam = u.searchParams.get('workspace') || ''
    const cwd = debugCwd.lastCwd
    const cwdHit = cwd ? cwdWorkspaceHit(cwd) : null
    const active =
      wsParam && listWorkspaces().includes(wsParam)
        ? wsParam
        : cwdHit || (cfg.activeProject && listWorkspaces().includes(cfg.activeProject) ? cfg.activeProject : null)
    if (!active) {
      sendJson(res, 200, { resolvedWorkspace: null, cwd: cwd || null, cwdMatched: Boolean(cwdHit) })
      return
    }
    const dir = memoryDirOf(active)
    const memRaw = safeReadRaw(join(dir, 'MEMORY.md')) || ''
    const memory = {
      chars: memRaw.length,
      threshold: budget(cfg, 'memoryCharThreshold', 8000),
      entries: countMdEntries(memRaw),
    }
    // 今日流水计数以日志文件为准（【自动】行数），不用内存态 digestStats（重启即丢）
    const today = todayStamp()
    const logRaw = safeReadRaw(join(dir, today + '.md')) || ''
    const digest = {
      date: today,
      count: (logRaw.match(/^- \d{2}:\d{2}【自动】/gm) || []).length,
      max: budget(cfg, 'digestMaxPerDay', 60),
    }
    const markers = readDistillMarkers()
    const done = markers[active] || {}
    const distill = { lastAt: null, lastAdded: null, pendingDates: pendingDistillLogs(dir, done).length }
    for (const [k, v] of Object.entries(done)) {
      if (k === '__compact__' || !v || !v.at) continue
      if (!distill.lastAt || v.at > distill.lastAt) {
        distill.lastAt = v.at
        distill.lastAdded = typeof v.added === 'number' ? v.added : null
      }
    }
    const comp = done.__compact__ || null
    const compact = comp
      ? {
          lastDay: comp.day,
          lastOk: Boolean(comp.ok),
          before: comp.before,
          after: comp.after,
          target: comp.target,
          failedCheck: comp.checks ? (Object.entries(comp.checks).find(([, ok]) => !ok) || [])[0] || null : null,
        }
      : null
    const countEntries = (p, filter) => {
      try {
        return readdirSync(p, { withFileTypes: true }).filter(filter).length
      } catch {
        return 0
      }
    }
    sendJson(res, 200, {
      resolvedWorkspace: active,
      cwd: cwd || null,
      cwdMatched: Boolean(cwdHit),
      memory,
      digest,
      distill,
      compact,
      trash: { count: countEntries(join(dir, '.trash'), (e) => e.isDirectory()) },
      archive: { count: countEntries(join(dir, 'archive'), (e) => e.isFile()) },
    })
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// The webserver keys exact routes by PATH only, so each path appears once.
const routes = [
  { path: '/wb-memory/config', handler: handleConfig },
  { path: '/wb-memory/status', handler: handleStatus },
  { path: '/wb-memory/workspaces', handler: handleWorkspaces },
  { path: '/wb-memory/files', handler: handleFiles },
  { path: '/wb-memory/file', handler: handleFile },
  { path: '/wb-memory/search', handler: handleSearch },
  { path: '/wb-memory/gc', handler: handleGc },
  { path: '/wb-memory/distill', handler: handleDistill },
  { path: '/wb-memory/models', handler: handleModels },
  { path: '/wb-memory/debug-cwd', handler: handleDebugCwd },
]

export function apply(ctx) {
  ensureStructure()
  // Config bootstrap（v7.5 BOM 修复）：统一走 readJsonBomSafe——带 BOM 的合法
  // JSON 正常解析，不再误入异常分支被静默重置为默认配置（v7.4 及之前裸
  // JSON.parse 遇 PowerShell 写入的 BOM 即抛异常 → catch 备份后写 defaultConfig，
  // memoryCharThreshold/compact 路由等手调配置全部无声丢失）。
  // 真·坏 JSON / 缺文件：备份坏文件为 config.json.bak 再落默认配置（原行为）。
  const bootC = readJsonBomSafe(CONFIG_FILE())
  if (!bootC) {
    try {
      if (existsSync(CONFIG_FILE())) copyFileSync(CONFIG_FILE(), CONFIG_FILE() + '.bak')
    } catch {}
    writeConfig(defaultConfig())
  } else if (typeof bootC.enabled !== 'boolean') {
    writeConfig({ ...defaultConfig(), ...bootC, enabled: true })
  }

  console.log('[wb-memory] apply() entered')

  // Cordis service access REQUIRES declaring the dependency via ctx.inject —
  // bare `ctx.llm` throws "cannot get property llm without inject". NOTE the
  // callback receives an injected SCOPE (a context-like object), and the service
  // itself lives at scope.llm — same pattern as the webServer inject below
  // (ctx.inject(['webServer'], host => host.webServer.register(...))).
  ctx.inject(['llm'], (scope) => {
    const llm = scope.llm
    globalThis.__wbMemoryLlm = llm
    try {
      const ids = (llm.listProviders() || []).map((p) => (p && (p.id || p.provider)) || p)
      console.log('[wb-memory] llm service injected: ' + (ids.join(', ') || '(no providers)'))
    } catch (e) {
      console.log('[wb-memory] llm service injected (provider listing failed: ' + String((e && e.message) || e) + ')')
    }
    return () => {
      if (globalThis.__wbMemoryLlm === llm) globalThis.__wbMemoryLlm = null
    }
  })

  ctx.inject(['systemPrompt'], (scope) => {
    console.log('[wb-memory] systemPrompt provider registering')
    scope.systemPrompt.context({
      name: 'wb-memory',
      order: -80,
      text: (context) => {
        const cKeys = context ? Object.keys(context) : '(no context)'
        console.log('[wb-memory][text] called; context keys=' + JSON.stringify(cKeys) + ' hasAgent=' + Boolean(context && context.agent))
        const rawCwd = context?.agent?.session?.header?.cwd
        debugCwd.lastCwd = rawCwd || process.cwd()
        debugCwd.lastAt = new Date().toISOString()
        const cfg = readConfig()
        if (!cfg.enabled) { debugCwd.lastResolved = '(disabled)'; return '' }
        const cwd = rawCwd || process.cwd()
        const resolved = resolveActiveProject(cwd)
        debugCwd.lastResolved = resolved
        if (debugCwd.lastCwd !== debugCwd._prevCwd || debugCwd.lastResolved !== debugCwd._prevResolved) {
          console.log('[wb-memory][debug-cwd] cwd=' + cwd + ' resolvedWorkspace=' + resolved)
          debugCwd._prevCwd = cwd
          debugCwd._prevResolved = resolved
        }
        return buildMemoryBlock(cwd, context, cfg)
      },
    })
  })

  ctx.inject(['webServer'], (host) => {
    for (const r of routes) {
      host.effect(
        () => host.webServer.register({ kind: 'exact', path: r.path, handler: r.handler }),
        'dsh-wb-memory: ' + r.path,
      )
    }
  })

  // Auto-digest: subscribe to the durable session event feed (same seam the
  // persistence backend uses) and append rule-based turn summaries to the
  // resolved workspace's daily log.
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => digestOnEvent(session, event))
    console.log('[wb-memory] auto-digest listener installed (autoDigest=' + digestConfig(readConfig()).on + ')')
    return () => {
      try { off && off() } catch {}
    }
  }, 'dsh-wb-memory: auto-digest listener')

  // Auto-distill (v5): state-driven daily-log -> MEMORY.md LLM distillation.
  // Delayed startup check (waits for settings/adapter registration) + hourly
  // sweep; idempotent via the plugin-dir marker file.
  globalThis.__wbMemoryCtx = ctx
  ctx.effect(() => {
    // v7 热更新友好：固定 60s 轮询 tick，到点判断重读的 config（intervalMs /
    // autoDistill 改动无需重载插件即生效）；首扫仍按 startDelayMs 延迟。
    let stopped = false
    let lastSweep = Date.now()
    const dc0 = distillConfig(readConfig())
    const t0 = setTimeout(() => {
      if (stopped) return
      lastSweep = Date.now()
      checkAndDistill(ctx).catch(() => {})
    }, dc0.startDelayMs)
    const iv = setInterval(() => {
      if (stopped) return
      const dc = distillConfig(readConfig())
      if (Date.now() - lastSweep >= dc.intervalMs) {
        lastSweep = Date.now()
        checkAndDistill(ctx).catch(() => {})
      }
    }, 60 * 1000)
    console.log('[wb-memory] auto-distill scheduler installed (autoDistill=' + dc0.on + ' provider=' + dc0.provider + ' model=' + (dc0.model || '(未配置)') + ')')
    return () => {
      stopped = true
      if (t0) clearTimeout(t0)
      if (iv) clearInterval(iv)
    }
  }, 'dsh-wb-memory: auto-distill scheduler')
}
