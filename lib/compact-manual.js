export class CompactManualError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status }
}
const fail = (code, message, status) => { throw new CompactManualError(code, message, status) }

// 主动整理与旧每日失败重试分离；显式点击+正文revision，不创建或删除日凭据。
export async function manualCompact(input, deps) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['workspace', 'expectedRevision', 'confirmed'].includes(k)) ||
      typeof input.workspace !== 'string' || !deps.workspaces.includes(input.workspace) || input.confirmed !== true ||
      typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    fail('invalid-request', '请选择有效工作区并确认当前正文快照', 400)
  }
  if (deps.state.running) fail('busy', '提炼或整理正在运行，请等待结束')
  if (!deps.ready) fail('not-ready', '记忆总开关、整理模型或LLM服务未就绪', 503)
  deps.state.running = true
  try {
    const ws = input.workspace
    if (deps.revision(ws) !== input.expectedRevision) fail('stale-revision', '记忆正文已变化，请刷新后重新确认')
    const markers = structuredClone(deps.readMarkers())
    try {
      const result = await deps.compact(ws, markers)
      if (result) await deps.save(ws, markers)
      return { ok: result?.ok === true, workspace: ws, skipped: result ? null : 'no-memory', result }
    } catch {
      fail('attempt-failed', '本次执行或状态提交异常，完成情况不可确认；请刷新核对，不自动重发', 500)
    }
  } finally { deps.state.running = false }
}
