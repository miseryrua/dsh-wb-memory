import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export class CompactRetryError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status }
}
const fail = (code, message, status) => { throw new CompactRetryError(code, message, status) }

const receiptPath = (root, day, workspace) => join(root, createHash('sha256').update(day + ':' + workspace).digest('hex') + '.json')
export const compactRetryUsed = (root, day, workspace) => existsSync(receiptPath(root, day, workspace))

// wx + fsync：先持久消费再调用。崩溃、调用或标记提交失败均不得自动恢复额度。
export function reserveCompactRetry(root, day, workspace, previous) {
  mkdirSync(root, { recursive: true })
  let fd
  try {
    fd = openSync(receiptPath(root, day, workspace), 'wx')
    writeFileSync(fd, JSON.stringify({ day, workspace, reservedAt: new Date().toISOString(), previous }))
    fsyncSync(fd)
  } catch (e) {
    if (e?.code === 'EEXIST') fail('already-used', '本工作区今天的手动重试已使用；不会重复调用')
    fail('receipt-failed', '无法持久保存一次性凭据，未发起调用', 500)
  } finally { if (fd !== undefined) closeSync(fd) }
}

export async function retryCompact(input, deps) {
  if (!input || Array.isArray(input) || Object.keys(input).some(k => !['workspace','expectedAt','confirmed'].includes(k)) ||
      typeof input.workspace !== 'string' || !deps.workspaces.includes(input.workspace) || input.confirmed !== true ||
      typeof input.expectedAt !== 'string' || !input.expectedAt) fail('invalid-request', '请选择有效工作区并明确确认本次整理', 400)
  if (deps.state.running) fail('busy', '提炼或整理正在运行，请等待结束')
  if (!deps.ready) fail('not-ready', '插件、整理模型或LLM服务未就绪', 503)
  deps.state.running = true
  try {
    const ws = input.workspace, markers = structuredClone(deps.readMarkers())
    const previous = markers[ws]?.__compact__
    if (!previous || previous.ok !== false) fail('not-failed', '仅允许重试已记录的整理失败')
    if (previous.at !== input.expectedAt) fail('stale-record', '整理记录已变化，请刷新后核对')
    try { deps.reserve(ws, previous) } catch (e) {
      if (e instanceof CompactRetryError) throw e
      fail('receipt-failed', '无法持久保存一次性凭据，未发起调用', 500)
    }
    // 只在隔离副本移除本工作区日锁；从不先清除磁盘原失败。
    delete markers[ws].__compact__
    try {
      const result = await deps.compact(ws, markers)
      if (!markers[ws].__compact__) markers[ws].__compact__ = previous
      await deps.save(ws, markers)
      return { ok: result?.ok === true, workspace: ws, consumed: true, skipped: result ? null : 'not-needed', result }
    } catch { fail('attempt-failed', '本次重试已消费；执行或状态提交异常，请核对最近状态，勿重复提交', 500) }
  } finally { deps.state.running = false }
}
