// 迭代 E2：整理被拒收（未写回）或某批因保真不过退回原文时，留存模型输出供事后人工比对。
// 位置：<工作区记忆目录>/archive/compact-rejected.latest.json，只保留最近 1 份（新覆盖旧）。
// 文件名刻意避开 archive/ 下所有既有约定：不是 YYYY-MM-DD.md（gcArchive、pendingDistillLogs），
// 不以 MEMORY.bak- 开头（容量备份与整理备份、gcArchive）。
// 内容含记忆正文，与 MEMORY.bak 同级敏感：只写在工作区记忆目录，不进插件目录，不进注入、检索、提炼、诊断或状态记录。
// 所有失败一律吞掉：留存是尽力而为，绝不影响整理主流程的结果。
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { atomicJson } from './distill-cursor.js'

export const COMPACT_REJECTED_FILE = 'compact-rejected.latest.json'
export const COMPACT_REJECTED_PREFIX = 'compact-rejected.'
export const compactRejectedPath = (memoryDir) => join(memoryDir, 'archive', COMPACT_REJECTED_FILE)

// 返回是否写成功；写入经 tmp+rename，崩溃不会留下半截 JSON（tmp 残留名同样以 compact-rejected. 开头）。
export function retainCompactRejection(memoryDir, payload) {
  try {
    atomicJson(compactRejectedPath(memoryDir), { version: 1, ...payload })
    return true
  } catch {
    return false
  }
}

// 整理成功写回后清除上一份（它对应的是已被取代的旧状态，不应长期留着一份旧正文）。
export function clearCompactRejection(memoryDir) {
  try { rmSync(compactRejectedPath(memoryDir), { force: true }) } catch { /* 尽力而为 */ }
}
