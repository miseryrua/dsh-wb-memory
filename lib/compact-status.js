import { COMPACT_MIN_PROGRESS } from './compact-plan.js'
// 面板仅公开受控原因，不传上游错误原文（可能包含凭据或响应正文）。
const messages = {
  'llm-truncated': '模型输出达到长度上限而截断，残缺内容未写入；无法仅凭此判断正文或推理预算占比。',
  timeout: '模型调用超时，未写入整理结果。',
  'empty-output': '模型未返回有效正文，未写入整理结果。',
  'llm-missing': '模型流缺少完成标记，未写入整理结果。',
  'llm-error': '模型服务返回错误，未写入整理结果；请检查提供方状态。',
  'llm-aborted': '模型调用被中止，未写入整理结果。',
  'llm-unsupported': '模型完成协议不受支持，未写入整理结果。',
  validation: '整理结果未通过安全校验，保留原文件。',
  fidelity: '整理结果丢失了提炼回执或关键事实（路径、命令、版本、配置键、整个主题等），未写入，已保留原文件。',
  'insufficient-progress': '整理结果仍超阈值且缩短不足 ' + Math.round(COMPACT_MIN_PROGRESS * 100) + '%，视为无实质进展，已保留原文件。',
  conflict: '整理期间原文件被改动，本次未覆盖；下一轮将基于新内容重做。',
  'backup-failed': '整理前备份失败，已停止调用模型并保留原文件。',
  'unsafe-layout': '无法安全识别完整条目边界，已停止分批整理并保留原文件。',
  'input-too-large': '完整条目或总量超出最多两批的安全上限，已停止整理；请人工拆分超长条目或审阅归档。',
  'protected-capacity': '不可改写的历史与管理信息已占满目标容量，已停止整理；请人工审阅归档。',
  'budget-too-small': '现有输出预算不足以安全分批，未调用模型；请检查整理预算配置。',
  'file-io': '整理文件读写失败，未确认完成写回，请检查文件权限与存储状态。',
  'unknown-error': '整理发生未分类异常，未确认完成；请检查插件日志（勿公开凭据）。',
}
export function compactFailureCode(error) {
  const s = String(error?.message || error || '')
  if(s.startsWith('llm finish: aborted (timeout)')) return 'timeout'
  if(s.startsWith('llm finish: ok-but-empty-output')) return 'empty-output'
  for(const k of ['truncated','missing','error','aborted','unsupported']) if(s.startsWith('llm finish: '+k)) return 'llm-'+k
  if(s.startsWith('conflict:')) return 'conflict'
  if(['EACCES','EPERM','ENOSPC','EIO','ENOENT'].includes(error?.code))return 'file-io'
  return Object.hasOwn(messages,s) ? s : 'unknown-error'
}
const number = v => Number.isFinite(v) && v>=0 ? v : null
const checkNames = new Set(['nonEmpty','shorter','underThreshold','keptHalfEntries','noEntryGrowth','entryGrowthOk','lifecyclePreserved','receiptsPreserved','anchorsPreserved'])
// 带警告接受：若记录里有具体超出字符数则一并展示，否则沿用固定文案。
// 只从记录中提取数字重组文案（不透传原文）：超阈值 / 条目数增加 / 回退批数。
const acceptWarning = comp => {
  if(!comp.ok) return null
  const w=String(comp.warnings||'')
  const over=/仍超阈值 (\d{1,9}) 字符/.exec(w), grow=/条目数由 (\d{1,6}) 增至 (\d{1,6})/.exec(w), fb=/(\d{1,3}) 批未整理/.exec(w)
  const parts=[]
  if(over) parts.push('仍超容量阈值 '+over[1]+' 字符')
  if(grow) parts.push('条目数由 '+grow[1]+' 增至 '+grow[2])
  if(fb) parts.push(fb[1]+' 批未整理，已保留原文')
  if(parts.length===1 && over) return parts[0]+'，已通过其余安全校验；将逐日继续整理。'
  if(parts.length) return parts.join('；')+'，已通过其余安全校验。'
  return comp.checks?.underThreshold===false ? '仍超容量阈值，已通过其余安全校验。' : null
}
export function compactStatus(comp) {
  if(!comp)return null
  const failedChecks=Object.entries(comp.checks||{}).filter(([k,v])=>checkNames.has(k)&&v===false).map(([k])=>k)
  const errorCode=comp.ok ? null : (Object.hasOwn(messages,comp.errorCode) ? comp.errorCode : comp.retryError || comp.error ? compactFailureCode(comp.retryError||comp.error) : failedChecks.length ? 'validation' : 'unknown-error')
  return {
    lastDay: typeof comp.day==='string' && /^\d{4}-\d{2}-\d{2}$/.test(comp.day) ? comp.day : null,
    lastAt: typeof comp.at==='string' && Number.isFinite(Date.parse(comp.at)) ? comp.at : null,
    lastOk: comp.ok===true,before:number(comp.before),after:number(comp.after),target:number(comp.target),rounds:number(comp.rounds),
    warnings: acceptWarning(comp),fallbackBatches:number(comp.fallbackBatches),
    retryError: comp.retryError ? messages[compactFailureCode(comp.retryError)] : null,
    failedCheck:failedChecks[0]||null,failedChecks,errorCode,errorMessage:errorCode ? messages[errorCode] : null,
    stage: ['preparation','generation','validation','write','complete'].includes(comp.stage) ? comp.stage : comp.ok ? 'complete' : failedChecks.length ? 'validation' : /^llm finish:/.test(comp.error || comp.retryError || '') ? 'generation' : null,
    tokenBudget:['configured','provider-default'].includes(comp.tokenBudget) ? comp.tokenBudget : null,
    maxTokens:comp.tokenBudget==='provider-default' ? null : number(comp.maxTokens),provider:typeof comp.provider==='string' ? comp.provider.slice(0,128) : null,model:typeof comp.model==='string' ? comp.model.slice(0,128) : null,
    batches:number(comp.batches),totalCalls:number(comp.totalCalls),
    inputChars:number(comp.inputChars),outputChars:number(comp.outputChars),reasoningChars:number(comp.reasoningChars),
    nextAttempt: errorCode==='conflict' ? '下一轮巡检基于新内容重新判断；不会覆盖并发修改。' : '同一逻辑日不再自动尝试；下一逻辑日巡检且仍超阈值时再判断。失败不会自动提高预算或更换模型。',
  }
}
