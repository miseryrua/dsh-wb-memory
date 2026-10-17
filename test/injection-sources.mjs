import assert from 'node:assert/strict'
import { projectInjectionSources } from '../lib/injection-sources.js'
import { fitMemoryBlock } from '../lib/injection-budget.js'
const md = ['# intro','## 全局用户记忆（USER.md）','画像规则','## 当前工作区：A','### 置顶记忆','钉住规则','### 长期记忆 / 相关条目','#### A','长期事实','### 今日日志（2026-01-01.md）','日志正文','### 近 1 日回顾','历史正文','## 可用工作区','- B','## 记忆纪律','纪律不算事实'].join('\n')
const out = projectInjectionSources(md)
assert.deepEqual(out.map(x=>x.layer), ['profile','pinned','memory','today','review'])
assert.ok(!out.some(x=>x.text.includes('纪律')||x.text.includes('- B')))
assert.ok(out.every(x=>md.includes(x.text)))
assert.deepEqual(projectInjectionSources('### 长期记忆 / 摘要\n摘要事实')[0].layer,'summary')
assert.deepEqual(projectInjectionSources(null),[])
const long=md.replace('长期事实','x'.repeat(15000));const final=fitMemoryBlock(long,{injectionMaxChars:4000})
assert.ok(projectInjectionSources(final).every(x=>final.includes(x.text)))
assert.ok(projectInjectionSources(final).every(x=>!x.text.includes('x'.repeat(15000))))
console.log('injection-sources: 7 passed')
