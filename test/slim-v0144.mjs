import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 0.14.4：容量行、「不写」收紧、置顶纪律缩成一句、提炼「不记」收紧、手动整理提示词去掉过期说法。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = mkdtempSync(join(tmpdir(), 'wb-slim-0144-'))
process.on('exit', () => { try { rmSync(sandbox, { recursive: true, force: true }) } catch {} })
const plugin = join(sandbox, 'plugin'), wsroot = join(sandbox, 'workspaces'), cwd = join(wsroot, 'A'), mem = join(cwd, '.workbuddy', 'memory')
mkdirSync(join(plugin, 'lib'), { recursive: true }); mkdirSync(mem, { recursive: true })
for (const f of readdirSync(join(root, 'lib'))) if (f.endsWith('.js')) copyFileSync(join(root, 'lib', f), join(plugin, 'lib', f))
copyFileSync(join(root, 'package.json'), join(plugin, 'package.json'))
const cfg = { enabled: true, workspaceRoot: wsroot, activeProject: 'A', autoDistill: false, sessionSummary: false }
writeFileSync(join(plugin, 'config.json'), JSON.stringify(cfg))
const idx = await import(pathToFileURL(join(plugin, 'lib', 'index.js')))
let n = 0
const test = (name, fn) => { fn(); n++; console.log('PASS ' + name) }

test('容量行三档文案与阈值口径', () => {
  const L = idx.memoryCapacityLine
  assert.equal(L('', {}), null)
  assert.equal(L(null, {}), null)
  assert.equal(L('x'.repeat(1000), { memoryCharThreshold: 2000 }), '- 长期记忆容量：MEMORY.md 1000 / 2000 字符（50%）')
  assert.equal(L('x'.repeat(1600), { memoryCharThreshold: 2000 }), '- 长期记忆容量：MEMORY.md 1600 / 2000 字符（80%），接近上限：新事实优先并入已有条目')
  assert.equal(L('x'.repeat(2000), { memoryCharThreshold: 2000 }), '- 长期记忆容量：MEMORY.md 2000 / 2000 字符（100%），接近上限：新事实优先并入已有条目')
  assert.equal(L('x'.repeat(2001), { memoryCharThreshold: 2000 }), '- 长期记忆容量：MEMORY.md 2001 / 2000 字符（100%），已超上限：新事实优先并入已有条目，不新开重复条目', '按原始字符数判超，不受四舍五入影响')
  assert.equal(L('x'.repeat(1599), { memoryCharThreshold: 2000 }), '- 长期记忆容量：MEMORY.md 1599 / 2000 字符（80%）', '接近档按原始字符数判断')
  assert.match(L('x'.repeat(2100), { memoryCharThreshold: 2000 }), /（105%），已超上限：新事实优先并入已有条目，不新开重复条目$/)
  assert.match(L('x'.repeat(800), {}), / 800 \/ 8000 字符（10%）$/, '缺省阈值 8000')
  assert.match(L('x'.repeat(800), { memoryCharThreshold: 0 }), / 800 \/ 8000 /, '非法阈值回落缺省')
})

const block = (q, extra = {}) => idx.buildMemoryBlock(cwd, { messages: [{ role: 'user', content: q }] }, { ...cfg, ...extra })

test('无 MEMORY.md 时不出容量行', () => {
  assert.ok(!block('任意').includes('长期记忆容量'))
})

writeFileSync(join(mem, 'MEMORY.md'), ['# 项目长期记忆', '## 发布回滚', '发布回滚需要先确认版本与告警。'.repeat(700), '## 夜间备份', '夜间备份每天03:20执行。'].join('\n'))
const size = readFileSync(join(mem, 'MEMORY.md'), 'utf8').length

test('容量行紧跟工作区标题、字符数与状态接口同口径', () => {
  const lines = block('发布回滚', { memoryCharThreshold: 20000 }).split('\n')
  const h = lines.findIndex(l => l.startsWith('## 当前工作区：A'))
  assert.ok(h >= 0)
  assert.equal(lines[h + 1], idx.memoryCapacityLine('x'.repeat(size), { memoryCharThreshold: 20000 }))
  assert.ok(lines[h + 1].startsWith('- 长期记忆容量：MEMORY.md ' + size + ' / 20000 字符'))
})

test('4000 字符总预算下容量行仍在（固定段不裁）', () => {
  for (const q of ['发布回滚', '']) {
    const b = block(q, { injectionMaxChars: 4000 })
    assert.ok(b.length <= 4000)
    assert.ok(b.includes('- 长期记忆容量：MEMORY.md ' + size + ' / 8000 字符'), q)
    assert.ok(b.includes('已超上限'))
  }
})

test('容量行会话内稳定、随 MEMORY.md 变化', () => {
  const a = block('发布回滚'), b = block('夜间备份')
  const pick = t => t.split('\n').find(l => l.startsWith('- 长期记忆容量'))
  assert.equal(pick(a), pick(b))
  appendFileSync(join(mem, 'MEMORY.md'), '\n## 新条目\n新正文。')
  assert.notEqual(pick(block('发布回滚')), pick(a))
})

test('纪律：「不写」收紧、置顶缩成一句', () => {
  const d = block('发布回滚').split('## 记忆纪律')[1]
  const nowrite = d.split('\n').find(l => l.startsWith('- **不写**'))
  for (const s of ['能从代码、git 历史或文件本身直接查到的信息', '未经验证的猜测', '进行中的中间状态', '密钥令牌', 'MEMORY.md 已有同一事实时改原条目']) assert.ok(nowrite.includes(s), s)
  const pin = d.split('\n').find(l => l.startsWith('- **置顶**'))
  assert.equal(pin, '- **置顶**：用户明确要求「记住/钉住/别忘」的长期内容，按 `- [YYYY-MM-DD] 内容` 一行一条追加到 `<工作区>/.workbuddy/memory/PINNED.md`、不再写 MEMORY.md，超过 1000 字符会被截断，届时提醒用户精简。')
  assert.ok(!d.includes('（N3）') && !d.includes('PINNED.md 不参与 compact'))
  assert.ok(block('x', { pinnedMaxChars: 500 }).includes('超过 500 字符会被截断'))
})

test('提示词：提炼「不记」收紧，整理不再提已移除的逐日整理', () => {
  const src = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  assert.ok(src.includes("'不记：一次性任务的过程细节、临时状态、纯流水；能从代码、git 历史或文件本身直接查到的信息（目录结构、函数签名、提交记录）；未经验证的猜测；已有标题已覆盖、又没有新增或更正的事实。'"))
  assert.ok(!src.includes('由后续逐日整理处理'))
  assert.ok(src.includes('之后巡检会把最冷条目原样下沉到冷存'))
})

console.log('slim-v0144: ' + n + ' passed')
