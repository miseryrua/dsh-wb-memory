/**
 * dsh-wb-memory 会话小结待处理状态持久化（0.10.0 新增）。
 *
 * 每个工作区 memory 目录一个 summary-pending.json：sessions[sessionId] 记录该会话
 * 的最新快照（sessionId / workspace / dir / logicalDay / turn / inputVersion /
 * snapshotKey / buffer / attempts / nextRetryAt / lastError / state / updatedAt）。
 * state 取值：pending（待处理）/ running（空闲触发中）/ failed（失败可重试）/
 * done（已小结的墓碑，保留以维持版本单调与去重，按 recoverMaxAgeMs 过期清理）。
 *
 * 写入策略：单写者 + 原子替换。本模块全部为同步 fs 调用，读-合并-写在同一同步
 * 区间内完成，进程内无 await 间隙 → 同一宿主进程内天然单写者；落盘走「同目录
 * 临时文件 + renameSync 覆盖」，崩溃时读者只会看到旧版或新版完整 JSON。跨进程
 * （多个 DSH 宿主共用同一工作区）未加文件锁，属已知边界：最坏情况是后写者覆盖
 * 先写者的记录，不会损坏日志/记忆文件本身。
 *
 * 幂等标记：mkBatchId(sessionId, logicalDay, inputVersion) 生成稳定 batchId，
 * 小结日志标题行携带 [batch:<id>]；「append 成功但清理（墓碑化）前崩溃」的恢复
 * 靠 logHasBatch 去重，不会重复写日志。
 *
 * 隐私边界：只读写 summary-pending.json 与目标日日志标题计数，不读 MEMORY.md /
 * PINNED.md / USER.md 等真实记忆内容；buffer 内容由 summary.js 按既有裁剪口径
 * （用户2000字符/条，超长保头尾；助手1500/条 × 尾部4条）裁剪后进入本模块。
 * 0.10.1新增idleSince（毫秒），只在完整轮次结束时更新；旧记录由updatedAt保守兼容。
 *
 * 纯 node:fs/node:path，零外部依赖。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const STORE_VERSION = 1
export const PENDING_FILE = 'summary-pending.json'

export function pendingStorePath(dir) {
  return join(dir, PENDING_FILE)
}

function emptyStore() {
  return { version: STORE_VERSION, sessions: {} }
}

// 读不存在的目录/文件/坏 JSON 一律返回空 store（恢复路径必须永不抛）。
export function readPendingStore(dir) {
  try {
    const raw = readFileSync(pendingStorePath(dir), 'utf8')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return emptyStore()
    const sessions = j.sessions && typeof j.sessions === 'object' && !Array.isArray(j.sessions) ? j.sessions : {}
    return { version: STORE_VERSION, sessions }
  } catch {
    return emptyStore()
  }
}

// 原子替换：同目录临时文件 + renameSync 覆盖（Windows 下 Node 走
// MoveFileEx(REPLACE_EXISTING)，可覆盖已存在的目标文件）。
export function writePendingStore(dir, store) {
  const p = pendingStorePath(dir)
  mkdirSync(dir, { recursive: true })
  const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(tmp, p)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw e
  }
}

export function getPendingSession(dir, sid) {
  if (!dir || !sid) return null
  return (readPendingStore(dir).sessions || {})[sid] || null
}

export function updatePendingSession(dir, record) {
  if (!dir || !record || !record.sessionId) return null
  const store = readPendingStore(dir)
  store.sessions[record.sessionId] = record
  writePendingStore(dir, store)
  return record
}

export function removePendingSession(dir, sid) {
  if (!dir || !sid) return false
  const store = readPendingStore(dir)
  if (!(sid in store.sessions)) return false
  delete store.sessions[sid]
  writePendingStore(dir, store)
  return true
}

// 扫描多个 memory 目录，汇总待处理记录（去重目录、容忍不存在/坏文件）。
export function listPendingRecords(dirs) {
  const out = []
  const seen = new Set()
  for (const dir of dirs || []) {
    if (!dir || typeof dir !== 'string' || seen.has(dir)) continue
    seen.add(dir)
    const store = readPendingStore(dir)
    for (const sid of Object.keys(store.sessions || {})) {
      out.push({ dir, sid, record: store.sessions[sid] })
    }
  }
  return out
}

// 完整 SHA-256 指纹用于幂等与版本判定，避免短指纹碰撞误跳小结。
export function hashString(s) {
  return createHash('sha256').update(String(s)).digest('hex')
}

export function mkBatchId(sessionId, logicalDay, inputVersion) {
  return hashString(String(sessionId) + '|' + String(logicalDay) + '|' + String(inputVersion))
}

export function batchMarker(batchId) {
  return '[batch:' + batchId + ']'
}

// 目标日日志是否已含该 batch 的小结（幂等：append 成功但墓碑化前崩溃的判定）。
export function logHasBatch(logPath, batchId) {
  try {
    return readFileSync(logPath, 'utf8').split('\n').some(line => line.startsWith('## 会话小结 ') && line.includes(batchMarker(batchId)))
  } catch {
    return false
  }
}
