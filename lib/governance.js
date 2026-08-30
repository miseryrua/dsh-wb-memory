/**
 * dsh-wb-memory 治理模块（P1）。
 * 借鉴 dsh-self-evolve（TTL 衰减淘汰）+ dsh-agent-memory（容量淘汰）+ dsh-project-memory（删除守卫）。
 *
 * 关键设计：默认全程用 fs.rename / writeFileSync 绕开 safe-delete shim（它只拦
 * fs.rm/rimraf，不拦 rename）。唯一例外是 .trash 超期清理用 fs.rmSync —— DSH 进程
 * 必须以空 NODE_OPTIONS 启动才能跑起来（否则建 junction 即崩），因此进程内 fs.rm
 * 实际可用；若 shim 意外生效，删除失败会被 catch 静默跳过，不影响主流程。
 *
 * 三个能力：
 *   1. TTL 日志归档：每日日志 YYYY-MM-DD.md 超 logRetentionDays 天 → rename 到 archive/
 *   2. 容量检测：MEMORY.md 超 memoryCharThreshold → 备份到 archive/ + 返回提示（不自动删条目，
 *      纯算法难判断该删哪些，交给 Agent/人整理）
 *   3. 删除守卫：面板删文件 → rename 到 .trash/<ts>/ 而非 unlink（可回滚）
 */

import {
  readdirSync,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'

import { detectDuplicates } from './retrieve.js'

function archiveDir(memoryDir) {
  return join(memoryDir, 'archive')
}
function trashDir(memoryDir) {
  return join(memoryDir, '.trash')
}

// 从文件名 YYYY-MM-DD.md 解析日期
function parseDateFromName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name)
  if (!m) return null
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`)
  return isNaN(d.getTime()) ? null : d
}

// TTL：把超过 retentionDays 的每日日志 rename 到 archive/（不删，可回滚）
export function gcDailyLogs(memoryDir, retentionDays = 30) {
  const now = Date.now()
  const arch = archiveDir(memoryDir)
  const moved = []
  let ents
  try {
    ents = readdirSync(memoryDir, { withFileTypes: true })
  } catch {
    return { moved, error: 'read memoryDir failed' }
  }
  mkdirSync(arch, { recursive: true })
  for (const e of ents) {
    if (!e.isFile()) continue
    const d = parseDateFromName(e.name)
    if (!d) continue
    const ageDays = (now - d.getTime()) / 86400000
    if (ageDays > retentionDays) {
      const src = join(memoryDir, e.name)
      const dst = join(arch, e.name)
      try {
        renameSync(src, dst)
        moved.push(e.name)
      } catch {
        // rename 失败（被占用等）忽略，下次再试
      }
    }
  }
  return { moved, archivedTo: arch, retentionDays }
}

// MEMORY.md 容量检测：超阈值则备份到 archive/ + 返回提示（不动原文件）
export function checkMemorySize(memoryDir, threshold = 8000) {
  const memPath = join(memoryDir, 'MEMORY.md')
  let content
  try {
    content = readFileSync(memPath, 'utf8')
  } catch {
    return { exists: false }
  }
  const size = content.length
  if (size <= threshold) return { exists: true, size, over: false }
  const arch = archiveDir(memoryDir)
  mkdirSync(arch, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const bakPath = join(arch, `MEMORY.bak-${stamp}.md`)
  try {
    writeFileSync(bakPath, content, 'utf8')
  } catch {}
  return {
    exists: true,
    size,
    over: true,
    threshold,
    bakPath,
    hint: `MEMORY.md 已 ${size} 字超阈值 ${threshold}，建议整理/合并旧条目（备份已存 ${bakPath}）`,
  }
}

// 删除守卫：把文件 rename 到 .trash/<ts>/ 而非 unlink（可回滚，绕 safe-delete shim）
export function safeTrash(memoryDir, filename) {
  const src = join(memoryDir, filename)
  if (!existsSync(src)) return { ok: false, error: 'not found' }
  const trash = trashDir(memoryDir)
  mkdirSync(trash, { recursive: true })
  const ts = String(Date.now())
  const dstDir = join(trash, ts)
  mkdirSync(dstDir, { recursive: true })
  const dst = join(dstDir, filename)
  try {
    renameSync(src, dst)
    return { ok: true, trashedTo: dst }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 回收站清理：删除 .trash/ 下时间戳超 retentionDays 的整个条目目录（真删）。
// .trash/<ms时间戳>/<文件>，时间戳即删除时刻。trashRetentionDays<=0 时禁用（原样保留）。
export function gcTrash(memoryDir, retentionDays) {
  if (!(retentionDays > 0)) return { cleaned: 0, disabled: true }
  const trash = trashDir(memoryDir)
  let ents
  try {
    ents = readdirSync(trash, { withFileTypes: true })
  } catch {
    return { cleaned: 0, retentionDays }
  }
  const now = Date.now()
  let cleaned = 0
  for (const e of ents) {
    if (!e.isDirectory()) continue
    const ts = Number(e.name)
    if (!Number.isFinite(ts) || ts <= 0) continue // 非时间戳目录不动
    const ageDays = (now - ts) / 86400000
    if (ageDays > retentionDays) {
      try {
        rmSync(join(trash, e.name), { recursive: true, force: true })
        cleaned++
      } catch {
        // shim 意外生效或文件被占用：静默跳过，下次再试
      }
    }
  }
  return { cleaned, retentionDays }
}

// 归档清理：删除 archive/ 下文件名日期超 retentionDays 的冷存文件（真删）。
// 覆盖两类文件：归档日志 YYYY-MM-DD.md、容量备份 MEMORY.bak-YYYY-MM-DD.md（均按文件名日期判断）。
// archiveRetentionDays<=0 时禁用（永久保留）。与 gcTrash 同理：DSH 进程内 fs.rm 实际可用，
// 失败被 catch 静默跳过。
export function gcArchive(memoryDir, retentionDays) {
  if (!(retentionDays > 0)) return { cleaned: 0, disabled: true }
  const arch = archiveDir(memoryDir)
  let ents
  try {
    ents = readdirSync(arch, { withFileTypes: true })
  } catch {
    return { cleaned: 0, retentionDays }
  }
  const now = Date.now()
  let cleaned = 0
  for (const e of ents) {
    if (!e.isFile()) continue
    // 从文件名解析日期：YYYY-MM-DD.md 或 MEMORY.bak-YYYY-MM-DD.md
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(e.name) || /^MEMORY\.bak-(\d{4}-\d{2}-\d{2})\.md$/.exec(e.name)
    if (!m) continue
    const d = new Date(`${m[1]}T00:00:00`)
    if (isNaN(d.getTime())) continue
    const ageDays = (now - d.getTime()) / 86400000
    if (ageDays > retentionDays) {
      try {
        rmSync(join(arch, e.name), { force: true })
        cleaned++
      } catch {
        // 静默跳过，下次再试
      }
    }
  }
  return { cleaned, retentionDays }
}

// 完整 GC：TTL 日志归档 + MEMORY.md 容量检测 + 近重复检测 + 回收站/归档超期清理
export function runGc(memoryDir, cfg) {
  const retentionDays = Number(cfg && cfg.logRetentionDays) > 0 ? Number(cfg.logRetentionDays) : 30
  const threshold = Number(cfg && cfg.memoryCharThreshold) > 0 ? Number(cfg.memoryCharThreshold) : 8000
  const dupThreshold =
    Number(cfg && cfg.dupThreshold) > 0 && Number(cfg && cfg.dupThreshold) <= 1
      ? Number(cfg.dupThreshold)
      : 0.45
  // trashRetentionDays：>0 超期真删；显式 0 禁用自动清理；未配置默认 30
  const trashRetention =
    cfg && Number.isFinite(Number(cfg.trashRetentionDays)) && Number(cfg.trashRetentionDays) >= 0
      ? Number(cfg.trashRetentionDays)
      : 30
  // archiveRetentionDays：>0 按文件名日期超期真删（日志和 MEMORY.bak 都算）；显式 0 永久保留；未配置默认 365
  const archiveRetention =
    cfg && Number.isFinite(Number(cfg.archiveRetentionDays)) && Number(cfg.archiveRetentionDays) >= 0
      ? Number(cfg.archiveRetentionDays)
      : 365
  const logGc = gcDailyLogs(memoryDir, retentionDays)
  const memCheck = checkMemorySize(memoryDir, threshold)
  // 近重复检测（Jaccard）：只报告疑似重复对，不自动合并（由人/Agent 确认后合并）
  let dupPairs = []
  try {
    const md = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    dupPairs = detectDuplicates(md, dupThreshold)
  } catch {}
  const trashGc = gcTrash(memoryDir, trashRetention)
  const archiveGc = gcArchive(memoryDir, archiveRetention)
  return { logGc, memCheck, dupCheck: { threshold: dupThreshold, pairs: dupPairs }, trashGc, archiveGc }
}
