// 大输入预分批：完整条目切分，最多两批；无额外汇总模型调用。
import { inspectMemory } from './memory-lifecycle.js'

// ---- 自愈策略常量（任务 A，2026-11-11）----
// 分批路径无同轮反馈重试，大文件一次压不进阈值很常见（实测 23454→16381，缩 30%）。
// 只要其余安全校验全过且「确有实质进展」，underThreshold 就降为建议项：带警告接受，逐日收敛。
export const COMPACT_MIN_PROGRESS = 0.1 // 带警告接受所需的最小缩短比例（相对原文）
// 每批目标不得低于该批输入的此比例：占比分摊在超大输入下会得出不现实的小目标（如 24%），
// 模型必然超标；40% 与实测可达成的 ~70% 压缩结果之间仍留余量。
export const COMPACT_BATCH_TARGET_MIN_RATIO = 0.4
// 条目数有界容忍：模型拆条是实测现象（34→40），并无证据表明条目变多本身会丢内容（带管理标记的
// 条目已由 lifecyclePreserved 保护）。≤原文：无警告；≤ceil(原文×(1+容忍度))：带警告接受；超过：硬拒收。
export const COMPACT_ENTRY_GROWTH_TOLERANCE = 0.25
export function compactEntryGrowthLimit(oldCount) {
  return oldCount > 0 ? Math.ceil(oldCount * (1 + COMPACT_ENTRY_GROWTH_TOLERANCE)) : Infinity
}
export function compactMadeProgress(before, after) {
  return Number.isFinite(before) && Number.isFinite(after) && before > 0 && after <= before * (1 - COMPACT_MIN_PROGRESS)
}
// 迭代 F1：分批与单批（含第二轮）两条路径共用的进展判定。此前只有分批路径有此门槛，单批第二轮
// 「哪怕只短 2% 也带警告接受」——实测 23465→22827（仅缩 2.7%、仍超阈值）被写回，次日再来一遍，每天空转。
// 接受条件：结果 ≤ 阈值，或比原文缩短 ≥ COMPACT_MIN_PROGRESS。只回答「有没有实质进展」；
// 非空/更短/条目数/生命周期/回执/事实锚点等硬条件由调用方另行判定，保真条件不因本函数放宽。
export function compactProgressOk(before, after, threshold) {
  return (Number.isFinite(after) && Number.isFinite(threshold) && after <= threshold) || compactMadeProgress(before, after)
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
