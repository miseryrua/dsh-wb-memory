import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=join(dirname(fileURLToPath(import.meta.url)),'..')
import { mkdtempSync as __mkdtemp, rmSync as __rmTmp } from 'node:fs'
import { tmpdir as __osTmpdir } from 'node:os'
const sandbox=__mkdtemp(join(__osTmpdir(), 'dsh-wb-memory-test-')), plugin=join(sandbox,'plugin'), wsroot=join(sandbox,'workspaces'), cwd=join(wsroot,'A')
process.on('exit', () => { { try { __rmTmp(sandbox, { recursive: true, force: true }) } catch {} } })
mkdirSync(join(plugin,'lib'),{recursive:true});mkdirSync(join(cwd,'.workbuddy','memory'),{recursive:true})
for(const f of readdirSync(join(root,'lib')))if(f.endsWith('.js'))copyFileSync(join(root,'lib',f),join(plugin,'lib',f))
copyFileSync(join(root,'package.json'),join(plugin,'package.json'))
const cfg={enabled:true,workspaceRoot:wsroot,activeProject:'A',autoDistill:false,sessionSummary:false}
writeFileSync(join(plugin,'config.json'),JSON.stringify(cfg))
writeFileSync(join(plugin,'USER.md'),'画像只供诊断，不得修改。')
writeFileSync(join(cwd,'.workbuddy','memory','PINNED.md'),'# 置顶\n- [2026-01-01] 发布前必须确认回滚方案。')
writeFileSync(join(cwd,'.workbuddy','memory','MEMORY.md'),['## 发布回滚', '发布回滚需要先确认版本与告警。'.repeat(700),'## 夜间备份','夜间备份每天03:20执行。'].join('\n'))
const idx=await import(pathToFileURL(join(plugin,'lib','index.js')))
// 由尚未加入第三批接线的0.12.1组装器生成；仅归一隔离沙箱绝对路径。
const expected=["3017094a79f48f5c0347a1825796164eb19dbbd61f2ebc01052051decdc7fb2f","99e00aa76563cb73573cb4dc22353c4064baeabcafcf7ddf1ed5177119d63b07","ac056cec5157b3314a5dc0998fd98c4bce65bd8db6e2295e4b3e0504a173dfca","99e00aa76563cb73573cb4dc22353c4064baeabcafcf7ddf1ed5177119d63b07"]
const OLD_NOWRITE='- **不写**：搜索与抓取内容、临时路径、工具报错本身（除非揭示可复现的环境坑）、一次性数据快照、寒暄短问答、密钥令牌。'
const NEW_NOWRITE='- **不写**：能从代码、git 历史或文件本身直接查到的信息（目录结构、函数签名、提交记录）、搜索与抓取内容、临时路径与进行中的中间状态、工具报错本身（除非揭示可复现的环境坑）、一次性数据快照、未经验证的猜测、寒暄短问答、密钥令牌；MEMORY.md 已有同一事实时改原条目，不另起新条。'
const OLD_PINNED='- **置顶**（N3）：用户明确祈使「记住/钉住/别忘」且要求长期有效的内容，按 `- [YYYY-MM-DD] 内容` 一行一条追加到 `<工作区>/.workbuddy/memory/PINNED.md`；命中置顶的不再写入 MEMORY.md（置顶优先且更强）；PINNED.md 不参与 compact 与治理；若注入显示其被截断（文件超 1000 字符），提醒用户精简或合并同义条目。'
const NEW_PINNED='- **置顶**：用户明确要求「记住/钉住/别忘」的长期内容，按 `- [YYYY-MM-DD] 内容` 一行一条追加到 `<工作区>/.workbuddy/memory/PINNED.md`、不再写 MEMORY.md，超过 1000 字符会被截断，届时提醒用户精简。'
let i=0
for(const injectionMaxChars of [4000,12000])for(const query of ['发布回滚','']){
 const c={...cfg,injectionMaxChars};const context={messages:[{role:'user',content:query}]}
 const plain=idx.buildMemoryBlock(cwd,context,c);let trace
 assert.equal(idx.buildMemoryBlock(cwd,context,c,r=>trace=r),plain)
 assert.equal(idx.buildMemoryBlock(cwd,context,c,()=>{throw Error('observer')}),plain)
 // 会话内冻结提示行（INJECT_FROZEN_HINT）是之后新增的，基线只比其余部分逐字不变。
 // 0.14.4 新增容量行、改写「不写」「置顶」两行纪律：归一回旧文本后其余部分须逐字不变（召回配额与裁剪不受影响）。
 const norm=plain.replace(/\n- 长期记忆容量：MEMORY\.md [^\n]*/,'').replace(NEW_NOWRITE,OLD_NOWRITE).replace(NEW_PINNED,OLD_PINNED)
 assert.ok(plain.includes('- 长期记忆容量：MEMORY.md ')&&plain.includes(NEW_NOWRITE)&&plain.includes(NEW_PINNED),'0.14.4 文本必须出现在注入里')
 const hash=createHash('sha256').update(norm.replace(idx.INJECT_FROZEN_HINT+'\n','').replace('同时覆盖长期记忆、冷存条目与近期日志','同时覆盖长期记忆与近期日志').replaceAll(sandbox,'<sandbox>').replaceAll(String.fromCharCode(92),'/')).digest('hex')
 assert.equal(hash,expected[i],JSON.stringify({injectionMaxChars,query}))
 i++
}
console.log('assembly-v013: '+i+' frozen-baseline cases passed')
