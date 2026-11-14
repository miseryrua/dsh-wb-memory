// 注入块按会话冻结（修复：每轮只有 wb-memory 段变化 → 宿主每轮重复注入整份 runtime-context 快照）。
// 宿主每步调用 systemPrompt 段的 text()，与上次 deep-equal 比较，任一段变化就整份重新注入。
// 记忆块里每轮都在变的两项：今日日志（每轮结束追加一条【自动】流水）与按本轮问题召回的相关条目。
// 做法：每个会话首次装配后缓存文本，同一会话之后返回同一字符串；只有「稳定输入」变了才重建。
// 本模块只含纯函数与一个小类，不读文件、不依赖宿主，便于隔离测试；读文件与接线在 lib/index.js。
import { createHash } from 'node:crypto'

export const INJECT_CACHE_MAX = 128

// 稳定序列化：对象键排序，保证同一份配置无论键序如何得到同一字符串。
export function stableStringify(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

// 文件内容只存哈希，不存全文。null（文件不存在/读失败）与空串区分开。
export function hashText(text) {
  if (text === null || text === undefined) return '\u2205'
  return createHash('sha256').update(String(text)).digest('hex')
}

// 稳定输入 → 缓存键。今日日志文件与当前 query 故意不在其中（它们正是每轮抖动的来源）。
//   config      整份配置（保守：宁可多重建，也不漏掉影响装配的预算类键）
//   cwd/root/resolved  会话目录、工作区根、解析出的工作区
//   user/pinned/memory USER.md / 该工作区 PINNED.md / MEMORY.md 的内容哈希
//   day         logicalDayStamp(cfg)，跨逻辑日重建
//   workspaces  listWorkspaces() 列表（影响「可用工作区」段）
export function buildInjectKey({ config, cwd, root, resolved, user, pinned, memory, day, workspaces }) {
  return createHash('sha256')
    .update(stableStringify({ config, cwd: cwd ?? null, root: root ?? null, resolved: resolved ?? null, user, pinned, memory, day, workspaces: workspaces || [] }))
    .digest('hex')
}

// 按会话分桶的冻结缓存：{ sessionId -> { key, text } }；容量满逐出最旧（Map 插入序）。
export class InjectCache {
  constructor(max = INJECT_CACHE_MAX) {
    this.max = max
    this.buckets = new Map()
  }
  get size() { return this.buckets.size }
  has(sid) { return this.buckets.has(sid) }
  // 键一致返回缓存文本，否则 undefined（调用方重建）。
  get(sid, key) {
    const b = this.buckets.get(sid)
    return b && b.key === key ? b.text : undefined
  }
  set(sid, key, text) {
    this.buckets.delete(sid) // 重建后视为最新，逐出顺序按最近一次写入
    this.buckets.set(sid, { key, text })
    while (this.buckets.size > this.max) this.buckets.delete(this.buckets.keys().next().value)
  }
  delete(sid) { return this.buckets.delete(sid) }
  clear() { this.buckets.clear() }
}
