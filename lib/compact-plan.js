// 大输入预分批：完整条目切分，最多两批；无额外汇总模型调用。
import { inspectMemory } from './memory-lifecycle.js'
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
  const targets=groups.map(g=>Math.floor(available*g.join('').length/total))
  return {prefix,batches:groups.map((g,i)=>({text:g.join(''),count:g.length,target:targets[i]}))}
}
export function compactBatchBody(text) {
  return String(text).replace(/^\s*# [^\r\n]*(?:\r?\n|$)/,'').trim()
}
