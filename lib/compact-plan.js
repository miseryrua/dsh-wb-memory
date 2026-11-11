// 大输入预分批：完整条目切分，最多两批；无额外汇总模型调用。
import { inspectMemory } from './memory-lifecycle.js'

// ---- 自愈策略常量（任务 A，2026-11-11）----
// 分批路径无同轮反馈重试，大文件一次压不进阈值很常见（实测 23454→16381，缩 30%）。
// 只要其余安全校验全过且「确有实质进展」，underThreshold 就降为建议项：带警告接受，逐日收敛。
export const COMPACT_MIN_PROGRESS = 0.1 // 带警告接受所需的最小缩短比例（相对原文）
// 每批目标不得低于该批输入的此比例：占比分摊在超大输入下会得出不现实的小目标（如 24%），
// 模型必然超标；40% 与实测可达成的 ~70% 压缩结果之间仍留余量。
export const COMPACT_BATCH_TARGET_MIN_RATIO = 0.4
// 整体目标不得低于输入长度的此比例（见 index.js compactTargetChars 第三参数）。
export const COMPACT_TARGET_INPUT_FLOOR_RATIO = 0.5
export function compactMadeProgress(before, after) {
  return Number.isFinite(before) && Number.isFinite(after) && before > 0 && after <= before * (1 - COMPACT_MIN_PROGRESS)
}
export function planCompactBatches(raw, threshold, target) {
  if(raw.length<=Math.max(16000,threshold*1.5))return null
  let parsed
  try{parsed=inspectMemory(raw)}catch{throw new Error('unsafe-layout')}
  let fence=null
  for(const line of raw.split(/\r?\n/)){
    const match=/^\s*(\x60{3,}|~{3,})/.exec(line)
    if(match){if(!fence)fence=match[1][0];else if(fence===match[1][0])fence=null;continue}
    if(fence && /^##\s/.test(line))throw new Error('unsafe-layout')
  }
  if(fence || parsed.records.length<2)throw new Error('unsafe-layout')
  // tags 是下一个条目的前置元数据，切分时必须一起移动。
  const starts=parsed.records.map(r=>{
    const before=raw.slice(0,r.start), tag=/<!-- tags:[^\r\n]*-->[\t \r\n]*$/.exec(before)
    return tag ? tag.index : r.start
  })
  const prefix=raw.slice(0,starts[0])
  const blocks=starts.map((s,i)=>raw.slice(s,starts[i+1]??raw.length))
  if(blocks.some(b=>b.length>40000))throw new Error('input-too-large')
  let best=1,delta=Infinity
  for(let i=1;i<blocks.length;i++){
    const left=blocks.slice(0,i).join('').length,right=blocks.slice(i).join('').length
    if(Math.max(left,right)<=40000 && Math.abs(left-right)<delta){best=i;delta=Math.abs(left-right)}
  }
  if(!Number.isFinite(delta))throw new Error('input-too-large')
  const groups=[blocks.slice(0,best),blocks.slice(best)]
  const available=target-prefix.length-4
  if(available<groups.reduce((n,g)=>n+g.length*8,0))throw new Error('protected-capacity')
  const total=blocks.join('').length
  const targets=groups.map(g=>{const len=g.join('').length;return Math.max(Math.floor(available*len/total),Math.ceil(len*COMPACT_BATCH_TARGET_MIN_RATIO))})
  return {prefix,batches:groups.map((g,i)=>({text:g.join(''),count:g.length,target:targets[i]}))}
}
export function compactBatchBody(text) {
  return String(text).replace(/^\s*# [^\r\n]*(?:\r?\n|$)/,'').trim()
}
