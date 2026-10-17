/** Markdown 唯一真源；纯变换，不读写文件、不隐式迁移。 */
import { createHash, randomUUID } from 'node:crypto'
const PREFIX = '<!-- wb-memory:'
const ID = /^mem_[a-f0-9]{32}$/
const STATES = new Set(['current', 'superseded', 'retracted'])
export class LifecycleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
const fail = (message, status = 400) => { throw new LifecycleError(message, status) }
export const memoryRevision = (text) => createHash('sha256').update(text).digest('hex')
const newId = () => 'mem_' + randomUUID().replaceAll('-', '')
const encode = (meta) => PREFIX + Buffer.from(JSON.stringify(meta)).toString('base64url') + ' -->'
export function rejectReservedMemorySyntax(text) {
  if (/<!--\s*wb-memory\b/i.test(String(text))) fail('正文包含保留的记忆管理标记')
}
function validateMeta(m) {
  if (!m || m.v !== 1 || !ID.test(m.id) || !STATES.has(m.state) || !Array.isArray(m.events) || !m.events.length || m.events.length > 200) fail('记忆元数据格式无效')
  if (Object.keys(m).some(k => !['v','id','state','by','from','events'].includes(k))) fail('未知记忆元数据字段')
  for (const key of ['by','from']) if (m[key] != null && !ID.test(m[key])) fail('记忆关联ID格式无效')
  for (const e of m.events) {
    if (!e || !['migrate','correct','retract','restore','created'].includes(e.action) || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || typeof e.reason !== 'string' || e.reason.length > 300 || Object.keys(e).some(k => !['action','at','reason','related'].includes(k)) || (e.related != null && !ID.test(e.related))) fail('记忆历史格式无效')
  }
}
/** offsets 按既有 ## 语法；未知/孤立/重复标记拒绝，不静默重编号。 */
export function inspectMemory(text) {
  if (typeof text !== 'string') fail('记忆内容不是文本')
  const headers = [...text.matchAll(/^##[^\S\r\n]+([^\r\n]*)(?:\r?\n|$)/gm)]
  const records = headers.map((h, i) => {
    const start=h.index, end=headers[i+1]?.index ?? text.length
    const raw=text.slice(start,end), headLength=h[0].length, tail=raw.slice(headLength)
    const marker=/^<!-- wb-memory:([A-Za-z0-9_-]+) -->(?:\r?\n|$)/.exec(tail)
    let meta=null
    if(marker) {try {meta=JSON.parse(Buffer.from(marker[1],'base64url').toString('utf8'))}catch {fail('无法解析记忆管理标记')}validateMeta(meta)}
    return {index:i,start,end,title:h[1].trim(),raw,headLength,markerLength:marker?.[0].length || 0,meta,body:tail.slice(marker?.[0].length || 0)}
  })
  const stripped=records.reduceRight((s,r)=>r.markerLength ? s.slice(0,r.start+r.headLength)+s.slice(r.start+r.headLength+r.markerLength) : s,text)
  rejectReservedMemorySyntax(stripped)
  const byId=new Map()
  for(const r of records) if(r.meta) {if(byId.has(r.meta.id))fail('存在重复记忆ID，已停止变更',409);byId.set(r.meta.id,r)}
  for(const r of byId.values()) {
    const m=r.meta
    if(m.state==='superseded' && !m.by)fail('被替代条目缺少后继',409)
    if(m.by && byId.get(m.by)?.meta.from!==m.id)fail('记忆后继关联不完整',409)
    if(m.from && byId.get(m.from)?.meta.by!==m.id)fail('记忆前驱关联不完整',409)
    const seen=new Set([m.id]);let next=m.by
    while(next){if(seen.has(next))fail('记忆替代链形成环',409);seen.add(next);next=byId.get(next)?.meta.by}
  }
  const visited=new Set()
  for(const r of byId.values()) {
    if(visited.has(r.meta.id))continue
    const queue=[r.meta.id];let current=0
    while(queue.length){const id=queue.pop();if(visited.has(id))continue;visited.add(id);const m=byId.get(id).meta;if(m.state==='current')current++;if(m.by)queue.push(m.by);if(m.from)queue.push(m.from)}
    if(current>1)fail('同一替代链存在多个当前条目',409)
  }
  return {revision:memoryRevision(text),records,byId,eol:text.includes('\r\n') ? '\r\n' : '\n'}
}
function withMeta(record,meta,eol) {
  const head=record.raw.slice(0,record.headLength)
  return head+(/\n$/.test(head) ? '' : eol)+encode(meta)+eol+record.body
}
function applyChanges(text,records,changes){return records.reduceRight((s,r)=>changes.has(r.index) ? s.slice(0,r.start)+changes.get(r.index)+s.slice(r.end) : s,text)}
function event(action,reason,at,related){return {action,at,reason,...(related ? {related} : {})}}
export function migrateMemory(text,{now=new Date().toISOString()}={}) {
  const p=inspectMemory(text),changes=new Map()
  if(!p.records.length && text.trim())fail('请先将自由格式记忆整理为 ## 标题条目，再补ID')
  let fence=null
  for(const line of text.split(/\r?\n/)) {
    const trimmed=line.trimStart(), ch=trimmed[0]
    if((ch===String.fromCharCode(96) || ch==='~') && trimmed.startsWith(ch.repeat(3))){if(!fence)fence=ch;else if(fence===ch)fence=null;continue}
    if(fence && /^##\s/.test(line))fail('代码围栏中存在二级标题，无法安全自动补ID')
  }
  for(const r of p.records)if(!r.meta)changes.set(r.index,withMeta(r,{v:1,id:newId(),state:'current',events:[event('migrate','显式补ID',now)]},p.eol))
  const result=applyChanges(text,p.records,changes);inspectMemory(result)
  return {text:result,changed:changes.size}
}
export function applyMemoryAction(text,input,{now=new Date().toISOString()}={}) {
  const p=inspectMemory(text)
  if(!input || typeof input.revision!=='string' || input.revision!==p.revision)fail('记忆已变化，请刷新后重试',409)
  if(input.action==='migrate')return migrateMemory(text,{now})
  const r=p.byId.get(input.id)
  if(!r)fail('指定记忆不存在，或尚未补ID',404)
  const reason=String(input.reason || '').trim()
  if(!reason || reason.length>300)fail('请填写1–300字变更原因')
  rejectReservedMemorySyntax(reason)
  const m=structuredClone(r.meta),changes=new Map()
  if(m.events.length>=200)fail('修订历史已达安全上限，请先人工归档',409)
  if(input.action==='correct') {
    if(m.state!=='current')fail('只能更正当前条目',409)
    const title=String(input.title || '').trim(),body=String(input.body || '').trim()
    if(!title || title.length>160 || /[\r\n]/.test(title) || !body || body.length>16000 || /^#{1,2}\s/m.test(body))fail('请填写有效标题和正文；正文不得包含一级或二级标题')
    rejectReservedMemorySyntax(title+'\n'+body)
    // 恢复祖先后再次更正：追加到既有链末尾，不覆盖/丢失旧后继。
    let tail=r
    while(tail.meta.by)tail=p.byId.get(tail.meta.by)
    const id=newId();m.state='superseded';m.events.push(event('correct',reason,now,id))
    if(tail===r)m.by=id
    else {const tm=structuredClone(tail.meta);if(tm.events.length>=200)fail('后继修订历史已达安全上限',409);tm.by=id;tm.events.push(event('correct',reason,now,id));changes.set(tail.index,withMeta(tail,tm,p.eol))}
    changes.set(r.index,withMeta(r,m,p.eol))
    const meta={v:1,id,state:'current',from:tail.meta.id,events:[event('created',reason,now,m.id)]}
    const added='## '+title+p.eol+encode(meta)+p.eol+body.replace(/\r?\n/g,p.eol)+p.eol
    const result=applyChanges(text,p.records,changes)+p.eol+added;inspectMemory(result)
    return {text:result,changed:changes.size+1,id}
  }
  if(input.action==='retract'){if(m.state!=='current')fail('只能撤回当前条目',409);m.state='retracted'}
  else if(input.action==='restore'){if(m.state==='current')fail('条目已经是当前状态',409);m.state='current'}
  else fail('未知记忆动作')
  m.events.push(event(input.action,reason,now));changes.set(r.index,withMeta(r,m,p.eol))
  const result=applyChanges(text,p.records,changes);inspectMemory(result)
  return {text:result,changed:1,id:m.id}
}
/** 模型只可精简当前条目；所有ID与元数据原样保留，历史正文不可改。 */
export function preservesLifecycle(before,after) {
  try {
    const a=inspectMemory(before),b=inspectMemory(after)
    if(a.byId.size!==b.byId.size)return false
    for(const [id,r]of a.byId){const next=b.byId.get(id);if(!next || JSON.stringify(r.meta)!==JSON.stringify(next.meta))return false;if(r.meta.state!=='current' && r.raw.replace(/\r\n/g,'\n').trim()!==next.raw.replace(/\r\n/g,'\n').trim())return false}
    return true
  }catch{return false}
}
