/**
 * dsh-wb-memory 整理失败可观测性前端测试（compact-panel）。
 * 运行：node test/compact-panel.mjs（需 Node 22+；不依赖真实登录、不调用模型）
 *
 * 覆盖场景：
 *  1. 截断（llm-truncated）失败 —— 总览直接中文原因 + 自动整理卡详情
 *  2. 超时（timeout）失败
 *  3. 结构校验失败（validation + failedChecks）
 *  4. 成功带警告（ok + warnings）
 *  5. 旧字段缺失兼容（只有 lastDay/lastOk 的旧记录 → 显示「未知」而非 0/空）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
// 可用 WB_MEMORY_CLIENT_OVERRIDE 指向替代 client bundle（本测试验证修改版时使用）
const clientOverride = process.env.WB_MEMORY_CLIENT_OVERRIDE
const src = readFileSync(clientOverride || join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.error('  ✗ ' + name) }
}

// ---------- 1. 语法可解析（同 smoke.mjs 口径）----------
try {
  new vm.Script(src, { filename: 'lib/client.js' })
  ok(true, 'client.js 可被 JS 引擎解析')
} catch (e) {
  ok(false, 'client.js 语法错误：' + e.message)
}

// ---------- 2. 加载 factory ----------
let factory
globalThis.window = { __ModuleLoader__: { load: (def) => { factory = def.factory } } }
new vm.Script(src, { filename: 'lib/client.js' }).runInThisContext()

// ---------- 3. 假 React：createElement 记录树 + hooks ----------
function makeReact(st) {
  // hooks 状态容器：每次组件调用重建
  let hookIndex = 0
  const hooks = st.__hooks || (st.__hooks = [])
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(2).filter(c => c != null && c !== false) }),
    useState: (init) => {
      const i = hookIndex++
      if (!(i in hooks)) hooks[i] = { value: typeof init === 'function' ? init() : init }
      return [hooks[i].value, (v) => { hooks[i].value = typeof v === 'function' ? v(hooks[i].value) : v }]
    },
    useEffect: (fn,deps) => {
      const i=hookIndex++, previous=hooks[i];
      if(!previous || !deps || deps.some((v,n)=>v!==previous.deps?.[n])){
        hooks[i]={deps,cleanup:previous?.cleanup};
        (st.__effects || (st.__effects=[])).push(()=>{hooks[i].cleanup?.();hooks[i].cleanup=fn()});
      }
    },
    useCallback: (fn,deps) => react.useMemo(()=>fn,deps),
    useRef: (init) => {const i=hookIndex++;if(!(i in hooks))hooks[i]={current:init};return hooks[i]},
    useMemo: (fn,deps) => {const i=hookIndex++;const prev=hooks[i];if(!prev || !deps || deps.some((v,n)=>v!==prev.deps?.[n]))hooks[i]={deps,value:fn()};return hooks[i].value},
  }
  react.hooks = { reset: () => { hookIndex = 0 } }
  return react
}

const react = makeReact({ __hooks: [] })
const require = (id) => {
  if (id === 'react') return react
  throw new Error('未预期的 require: ' + id)
}
const exports1 = factory(require)
ok(typeof exports1.apply === 'function', 'factory 导出 apply')
const coldView = new Function('h', src.slice(src.indexOf('  function coldEntriesView('), src.indexOf('  function ColdMemoryPanel(')) + '; return coldEntriesView')(react.createElement)
let restored = null
const coldTree = coldView({ entries: [{ id: 5, title: '冷存样例', date: '2026-01-01', importance: 'high', sunkDay: '2026-11-20', chars: 42 }] }, false, id => { restored = id })
const coldRow = coldTree.children[0]
ok(coldRow.children[0].includes('冷存样例 · 日期 2026-01-01 · 重要度 high · 下沉 2026-11-20 · 42 字符'), '冷存列表展示全部元数据')
coldRow.children[1].props.onClick()
ok(restored === 5 && coldRow.children[1].children[0] === '移回', '冷存移回按钮绑定对应条目')

// ---------- 4. 渲染辅助 ----------
// 收集整棵树的所有文本
function treeText(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join('')
  if (node.type === 'br') return '\n'
  // title 属性承载 metric 详情，一并收集
  let s = (node.props && typeof node.props.title === 'string') ? node.props.title : ''
  for (const c of node.children || []) s += treeText(c)
  return s
}
// 找到 section 标题匹配的 section 节点
function findSection(node, ariaLabel) {
  if (node == null || node === false) return null
  if (Array.isArray(node)) { for (const n of node) { const r = findSection(n, ariaLabel); if (r) return r } }
  if (typeof node !== 'object') return null
  if (node.type === 'section' && node.props && node.props['aria-label'] === ariaLabel) return node
  for (const c of node.children || []) { const r = findSection(c, ariaLabel); if (r) return r }
  return null
}

// ---------- 5. fetch mock：status 响应注入 ----------
async function renderWithStatus(statusData, options = {}) {
  const state = { __hooks: [] }
  const r = makeReact(state)
  const req = (id) => { if (id === 'react') return r; throw new Error('unexpected require ' + id) }
  const exp = factory(req)
  // 捕获 slot 注册的组件
  let component
  const slots = {
    inject: (slot, fn) => { component = fn() },
    register: (meta, comp) => comp,
  }
  globalThis.fetch = (url, init) => {
    if(init?.method === 'POST' && options.post) return options.post(url,init)
    if (String(url).includes('/api/wb-memory/status')) {
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify(statusData)) })
    }
    // 其他接口（config/files/llm/providers）返回最小可解析响应，避免渲染中断
    if (String(url).includes('/api/wb-memory/config')) {
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify({ enabled: true, autoCompact: true, ...options.config })) })
    }
    if (String(url).includes('/api/wb-memory/files')) {
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify({ files: [], workspace: statusData.resolvedWorkspace })) })
    }
    if (String(url).includes('/api/wb-memory/models')) {
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify({ providers: [] })) })
    }
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('{}') })
  }
  exp.apply({ slots })
  if (!component) throw new Error('未捕获到 settings.section 组件')
  const render = () => {
    r.hooks.reset()
    let node = component()
    // component 是 () => h(WBMemorySection, null)：返回元素的 type 即组件函数，需再调用
    if (node && typeof node.type === 'function') node = node.type(node.props)
    return node
  }
  let node = render()
  // flush effects：refresh() 发出 fetch promise，setState 写入 hooks 容器
  for (let round = 0; round < 8; round++) {
    const effects = state.__effects || []
    state.__effects = []
    for (const fn of effects) fn()
    await new Promise(resolve => setTimeout(resolve, 0))
    node = render()
  }
  node = render()
  const flush=async()=>{for(let n=0;n<4;n++){node=render();const effects=state.__effects||[];state.__effects=[];for(const fn of effects)fn();await new Promise(resolve=>setTimeout(resolve,0));}return render()};
  return options.interactive ? {node,render,flush} : node
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children || []) { const match=findNode(child,predicate); if(match)return match }
  return null
}
// ---------- 6. 场景测试 ----------
const baseStatus = (compact) => ({
  runtimeRevision: 'test',
  resolvedWorkspace: '测试工作区',
  cwd: '/tmp/x', cwdMatched: true,
  memory: { chars: 9000, threshold: 8000, entries: 40 },
  digest: { date: '2026-10-20', count: 1, max: 60 },
  summary: { count: 0, max: 8 },
  pinned: { lines: 0 },
  distill: { lastAt: null, lastAdded: null, pendingDates: 0 },
  compact,
  trash: { count: 0 }, archive: { count: 1 },
})

{
  const ui=await renderWithStatus({...baseStatus(null),cold:{count:2}}, {interactive:true})
  const nav=findNode(ui.node,n=>n.props?.['aria-label']==='记忆管理分区')
  ok(nav.children.map(n=>n.props.key).join(',')==='overview,content,recall,distill,maintain,settings','六面板顺序正确')
  for(const [label,id,items] of [['总览','overview',['需要关注','冷存条目','今日小结']],['记忆内容','content',['长期条目','冷存条目','文件']],['召回与检索','recall',['最近一次实际组装','手动预览','记忆检索工具','检索']],['提炼与整理','distill',['自动流水','会话小结','立即提炼','手动整理当前工作区一次']],['维护','maintain',['治理','回收站','备份']],['设置','settings',['逻辑日分界']]]) {
    const panel=findSection(ui.node,label)
    ok(panel.props.id==='wb-panel-'+id && items.every(item=>treeText(panel).includes(item)),label+' 保留指定控件')
  }
  const automation=findSection(ui.node,'提炼与整理')
  const jump=findNode(automation,n=>n.type==='button' && treeText(n)==='查看冷存条目')
  ok(Boolean(jump) && treeText(automation).includes('冷存共 2 条'), '04 保留冷存统计与跳转按钮')
  jump.props.onClick()
  const mounted=ui.render(), files=findSection(mounted,'记忆内容')
  const panel=n=>typeof n.type==='function' && n.type.name==='ColdMemoryPanel'
  const mount=findNode(files,panel)
  ok(Boolean(mount) && !findNode(findSection(mounted,'提炼与整理'),panel), '冷存面板仅挂载于 02 记忆内容')
  const calls=[]
  globalThis.fetch=async url=>{calls.push(url);return {ok:true,text:async()=>JSON.stringify({entries:[]})}}
  const fixture={__hooks:[]}, child=makeReact(fixture)
  const source=src.slice(src.indexOf('  function coldEntriesView('),src.indexOf('  function compactStatusView('))
  const renderCold=new Function('h','useState','useRef','useEffect','readJson',source+'; return ColdMemoryPanel')(child.createElement,child.useState,child.useRef,child.useEffect,r=>r.text().then(JSON.parse))
  for(const workspace of ['工作区甲','工作区乙']) {
    child.hooks.reset();renderCold({...mount.props,open:true,workspace,onChanged:()=>{}})
    for(const effect of fixture.__effects.splice(0)) effect()
    await new Promise(resolve=>setTimeout(resolve,0))
  }
  ok(calls.length===2 && calls[0].endsWith(encodeURIComponent('工作区甲')) && calls[1].endsWith(encodeURIComponent('工作区乙')), '冷存展开时切换工作区会重新请求')
}

// 场景 1：截断失败（新字段齐全）
{
  const node = await renderWithStatus(baseStatus({
    lastDay: '2026-10-20', lastAt: '2026-10-20T05:00:00.000Z', lastOk: false,
    before: 22367, after: null, target: 6400, rounds: 1,
    warnings: null, retryError: null, failedCheck: null, failedChecks: [],
    errorCode: 'llm-truncated', errorMessage: '模型输出达到长度上限而截断，残缺内容未写入；无法仅凭此判断正文或推理预算占比。',
    stage: 'generation', maxTokens: 8000, provider: 'wb2api', model: 'cn:deepseek-v4.1-flash',
    batches: 1, totalCalls: 1, inputChars: 22367, outputChars: null, reasoningChars: null,
    nextAttempt: '同一逻辑日不再自动尝试；下一逻辑日巡检且仍超阈值时再判断。失败不会自动提高预算或更换模型。',
  }))
  const overview = treeText(findSection(node, '总览'))
  ok(overview.includes('上次整理未通过：模型输出达到长度上限而截断'), '截断失败：总览 attention 直接给出中文原因')
  ok(overview.includes('✗'), '截断失败：总览 metric 显示失败标记')
  const govText = treeText(node)
  ok(govText.includes('模型输出达到长度上限而截断'), '截断失败：面板可见中文原因')
}

// 场景 2：超时失败
{
  const node = await renderWithStatus(baseStatus({
    lastDay: '2026-10-20', lastAt: '2026-10-20T05:00:00.000Z', lastOk: false,
    before: 22367, after: null, target: 6400, rounds: 1,
    warnings: null, retryError: null, failedCheck: null, failedChecks: [],
    errorCode: 'timeout', errorMessage: '模型调用超时，未写入整理结果。',
    stage: 'generation', maxTokens: 8000, provider: 'wb2api', model: 'cn:deepseek-v4.1-flash',
    batches: 1, totalCalls: 1, inputChars: 22367, outputChars: null, reasoningChars: null,
    nextAttempt: '同一逻辑日不再自动尝试；下一逻辑日巡检且仍超阈值时再判断。失败不会自动提高预算或更换模型。',
  }))
  const overview = treeText(findSection(node, '总览'))
  ok(overview.includes('超时'), '超时失败：总览给出超时中文原因')
}

// 场景 3：结构校验失败
{
  const node = await renderWithStatus(baseStatus({
    lastDay: '2026-10-20', lastAt: '2026-10-20T05:00:00.000Z', lastOk: false,
    before: 22367, after: 20100, target: 6400, rounds: 2,
    warnings: null, retryError: null,
    failedCheck: 'shorter', failedChecks: ['shorter', 'underThreshold'],
    errorCode: 'validation', errorMessage: '整理结果未通过安全校验，保留原文件。',
    stage: 'validation', maxTokens: 8000, provider: 'wb2api', model: 'cn:deepseek-v4.1-flash',
    batches: 1, totalCalls: 2, inputChars: 22367, outputChars: 20100, reasoningChars: null,
    nextAttempt: '同一逻辑日不再自动尝试；下一逻辑日巡检且仍超阈值时再判断。失败不会自动提高预算或更换模型。',
  }))
  const overview = treeText(findSection(node, '总览'))
  ok(overview.includes('整理结果未通过安全校验'), '结构失败：总览给出校验失败原因')
  const all = treeText(node)
  ok(all.includes('未过校验') && all.includes('必须变短') && all.includes('压回容量阈值'), '结构失败：自动整理卡列出中文校验项')
}

// 场景 4：成功带警告
{
  const node = await renderWithStatus(baseStatus({
    lastDay: '2026-10-20', lastAt: '2026-10-20T05:00:00.000Z', lastOk: true,
    before: 22367, after: 7500, target: 6400, rounds: 1,
    warnings: '仍超容量阈值，已通过其余安全校验。', retryError: null, failedCheck: null, failedChecks: [],
    errorCode: null, errorMessage: null,
    stage: 'complete', maxTokens: 8000, provider: 'wb2api', model: 'cn:deepseek-v4.1-flash',
    batches: 1, totalCalls: 1, inputChars: 22367, outputChars: 7500, reasoningChars: null,
    nextAttempt: '同一逻辑日不再自动尝试；下一逻辑日巡检且仍超阈值时再判断。失败不会自动提高预算或更换模型。',
  }))
  const overview = treeText(findSection(node, '总览'))
  ok(overview.includes('成功') && overview.includes('仍超容量阈值'), '成功带警告：总览不显示失败提示')
  ok(!overview.includes('上次整理未通过'), '成功带警告：总览无失败文案')
}

// 场景 5：旧字段缺失（旧版本记录只有 lastDay/lastOk）
{
  const node = await renderWithStatus(baseStatus({
    lastDay: '2026-10-18', lastOk: false,
  }))
  const overview = treeText(findSection(node, '总览'))
  ok(overview.includes('原因未记录'), '旧记录：总览给出「原因未记录」而非空白')
  ok(overview.includes('未知'), '旧记录：缺失数值显示「未知」')
  ok(!/输出预算：\s*0/.test(overview) && !/轮数：\s*0/.test(treeText(node)), '旧记录：缺失值不显示为 0')
  const all = treeText(node)
  ok(all.includes('2026-10-18（按日记录）'), '旧记录：时间回落到 lastDay（按日记录）')
}

// 后台会把旧记录缺失值投影为 null，而不只是 undefined。
{
  const node = await renderWithStatus(baseStatus({ lastDay: '2026-10-18', lastOk: false, maxTokens: null, rounds: null, before: null, batches: null, totalCalls: null }))
  const text = treeText(node)
  ok(!/输出预算：\s*0|轮数：\s*0|0 次|0 批/.test(text), 'null 数值不伪造成零')
}
function manualButton(node) { return byLabel(node,'手动整理当前工作区一次') }
async function openAutomation(state) {
 const nav=byLabel(state.node,'记忆管理分区');const button=nav.children.find(n=>treeText(n).includes('提炼与整理'))
 button.props.onClick();const node=state.render();ok(findSection(node,'提炼与整理')?.props.hidden===false,'用户导航确实打开提炼与整理，而非搜索隐藏树');return node
}
const manualData=compact=>({...baseStatus(compact),compactManual:{expectedRevision:'a'.repeat(64),running:false}})
for(const [name,compact] of [['成功',{lastOk:true}],['失败',{lastOk:false}],['无记录',null],['未知',{}]]){
 const state=await renderWithStatus(manualData(compact),{interactive:true});const node=await openAutomation(state),button=manualButton(node)
 ok(Boolean(button) && !button.props.disabled,name+'状态入口常驻且不灰显')
}
{
 const data=manualData({lastOk:true});let posts=[]
 const state=await renderWithStatus(data,{interactive:true,config:{autoDistill:false,autoCompact:false},post:(url,opts)=>{posts.push({url,opts});return Promise.reject(Error('network'))}})
 const button=manualButton(await openAutomation(state));ok(Boolean(button)&&!button.props.disabled,'自动功能关闭仍可主动整理')
 if(button){
  window.confirm=()=>false;await button.props.onClick();ok(posts.length===0,'取消确认零POST')
  let confirmation='';window.confirm=t=>{confirmation=t;return true};await button.props.onClick();ok(posts.length===1 && posts[0].url==='/api/wb-memory/compact-manual','确认主动单工作区请求，断网不自动重发')
  const sent=JSON.parse(posts[0].opts.body);ok(sent.workspace===data.resolvedWorkspace && sent.expectedRevision==='a'.repeat(64) && sent.confirmed===true && Object.keys(sent).length===3,'绑定正文revision而非失败记录，不传预算/路径/模型')
  ok(confirmation.includes('不设插件输出 token 上限') && confirmation.includes('最多四次') && confirmation.includes('超时') && confirmation.includes('每日') && !confirmation.includes('额度已消费'),'确认框区分主动与自动日锁及上游限制')
 }
}
{
 let posts=[],release;const pending=new Promise(resolve=>release=resolve)
 const state=await renderWithStatus(manualData(null),{interactive:true,post:async(url,init)=>{posts.push({url,init});await pending;return {ok:true,status:200,text:async()=>JSON.stringify({ok:true})}}})
 const button=manualButton(await openAutomation(state));if(button){window.confirm=()=>true;const first=button.props.onClick();const duplicate=button.props.onClick();await duplicate;ok(posts.length===1,'未重渲染同一事件闭包连续点击也只发一次');ok(!manualButton(state.render()).props.disabled,'运行期间入口仍不灰显');release();await first;ok(treeText(state.render()).includes('整理完成'),'收到成功响应才提示完成')}
}
for(const [name,data,config] of [['旧后端',baseStatus(null),{}],['未选工作区',{...manualData(null),resolvedWorkspace:null},{}],['总开关关闭',manualData(null),{enabled:false}],['后台忙',{...manualData(null),compactManual:{expectedRevision:'a'.repeat(64),running:true}},{}]]){
 let posts=[];const state=await renderWithStatus(data,{interactive:true,config,post:async()=>{posts.push(1);return {ok:true,text:async()=>JSON.stringify({ok:true})}}});const button=manualButton(await openAutomation(state));ok(Boolean(button)&&!button.props.disabled,name+'不灰显');if(button){window.confirm=()=>true;await button.props.onClick();ok(posts.length===0,name+'点击解释未就绪、不调用模型')}
}
function byLabel(node,label) {
 if(!node || typeof node!=='object')return null
 if(node.props?.['aria-label']===label)return node
 for(const c of (Array.isArray(node)?node:node.children || [])){const x=byLabel(c,label);if(x)return x}return null
}
{
 // 0.14.2：思考强度不再可配，治理不再有开关；旧配置值不影响面板
 const tree=await renderWithStatus(baseStatus(null),{config:{compactProvider:'fixture',compactModel:'m',compactReasoningEffort:'high',gcEnabled:false}});
 const text=treeText(tree);
 ok(!byLabel(tree,'整理思考强度') && !text.includes('关闭思考（若支持）'),'思考强度下拉框已移除');
 ok(text.includes('否则不传思考参数') && text.includes('不保证关闭'),'面板说明固定的思考策略');
 const gc=findNode(tree,n=>n.type==='button' && n.children.length===1 && n.children[0]==='治理');
 ok(Boolean(gc) && !gc.props.disabled,'旧配置 gcEnabled=false 不再禁用治理按钮');
 ok(!text.includes('治理已关') && !text.includes('治理已开'),'不再显示治理开关状态');
}
{
 const tree=await renderWithStatus(baseStatus({lastOk:false,tokenBudget:'provider-default',maxTokens:null}));
 const text=treeText(tree);
 ok(text.includes('不设插件上限（上游默认）'),'手动结果预算区别于未知旧记录');
 ok(text.includes('不调用模型、不改写原文') && text.includes('不回落提炼预算') && text.includes('不保证成功'),'面板说明自动无需模型、手动上游限制不变');
}
{
 // 迭代 F2：自动整理暂停提示 + 手动整理入口
 const ap={paused:true,count:2,after:2,lastDay:'2026-11-13',lastRatio:0.027,baselineChars:23465,releaseDelta:0.15}
 const data={...manualData({lastOk:false,errorCode:'insufficient-progress'}),compactAutoPause:ap};let posts=[]
 const state=await renderWithStatus(data,{interactive:true,post:(url,init)=>{posts.push({url,init});return Promise.resolve({ok:true,status:200,text:async()=>JSON.stringify({ok:true})})}})
 const node=await openAutomation(state),text=treeText(node)
 ok(!text.includes('自动整理已暂停'),'忽略旧暂停状态')
 const btn=byLabel(node,'立即手动整理（解除自动整理暂停）')
 ok(!btn && posts.length === 0, '旧解除暂停按钮不存在');
 for(const [name,v] of [['paused=false',{...ap,paused:false}],['null',null],['缺字段',undefined]]){
  const st=await renderWithStatus({...manualData({lastOk:false}),compactAutoPause:v},{interactive:true});const n=await openAutomation(st)
  ok(!treeText(n).includes('自动整理已暂停') && !byLabel(n,'立即手动整理（解除自动整理暂停）'),'不暂停时不显示提示：'+name)
 }
}
{
 // 结构：六个面板必须并列在同一个容器下，且任一面板被选中时自己与全部祖先都不带 hidden
 const ids=['overview','content','recall','distill','maintain','settings']
 const ui=await renderWithStatus({...baseStatus(null),cold:{count:2}},{interactive:true})
 const parentOf=(root,target)=>{let found=null;(function walk(n){if(!n||typeof n!=='object'||found)return;for(const c of n.children||[]){if(c===target){found=n;return}walk(c)}})(root);return found}
 const pathTo=(root,target,trail=[])=>{if(!root||typeof root!=='object')return null;if(root===target)return [...trail,root];for(const c of root.children||[]){const p=pathTo(c,target,[...trail,root]);if(p)return p}return null}
 const panelsOf=tree=>ids.map(id=>findNode(tree,n=>n.type==='section'&&n.props?.id==='wb-panel-'+id))
 const first=panelsOf(ui.node)
 ok(first.every(Boolean),'六个面板节点都存在')
 const parents=first.map(p=>parentOf(ui.node,p))
 ok(parents.every(p=>p&&p===parents[0]),'六面板互为兄弟（同一父节点）')
 ok(parents[0].children.filter(c=>c.type==='section').map(c=>c.props.id).join(',')===ids.map(id=>'wb-panel-'+id).join(','),'面板容器内 section 顺序与导航一致')
 ok(first.every(p=>!findNode({children:p.children},n=>n.type==='section')),'面板内部不嵌套其他面板')
 const nav=findNode(ui.node,n=>n.props?.['aria-label']==='记忆管理分区')
 for(const id of ids){
  findNode(findNode(ui.render(),n=>n.props?.['aria-label']==='记忆管理分区'),n=>n.props?.key===id).props.onClick()
  const tree=await ui.flush(),panels=panelsOf(tree),me=panels[ids.indexOf(id)]
  const trail=pathTo(tree,me)||[]
  ok(trail.length>0 && trail.every(n=>!n.props?.hidden),'切到 '+id+' 时面板及其祖先都可见')
  ok(panels.filter(p=>!p.props.hidden).length===1,'切到 '+id+' 时只显示一个面板')
  ok(treeText(me).replace(/\s/g,'').length>20,'切到 '+id+' 时面板有内容')
 }
 ok(Boolean(nav),'导航存在')
 // 开关：全部为 role=switch，带可读名称
 const tree=ui.render(),switches=[];(function walk(n){if(!n||typeof n!=='object')return;if(n.props?.role==='switch')switches.push(n);for(const c of n.children||[])walk(c)})(tree)
 const names=switches.map(n=>n.props['aria-label']).sort().join(',')
 ok(names===['会话小结','自动提炼（含超阈值整理）','自动流水','记忆总开关','记忆检索工具'].sort().join(','),'五个开关齐全且有名称：'+names)
 const text=treeText(tree)
 ok(!/auto-distill|auto-compact/.test(text),'说明文字不含内部用语 auto-distill / auto-compact')
}
{
 // 评审必须修 1：HTTP 200 + ok:false 的明确拒收要显示原因，不得报成连接中断
 const state=await renderWithStatus(manualData({lastOk:false}),{interactive:true,post:()=>Promise.resolve({ok:true,status:200,text:async()=>JSON.stringify({ok:false,workspace:'测试工作区',skipped:null,result:{lastOk:false,errorCode:'insufficient-progress',errorMessage:'整理后仍超阈值且缩短不足 10%'}})})})
 const node=await openAutomation(state);window.confirm=()=>true
 await manualButton(node).props.onClick()
 const text=treeText(await state.flush())
 ok(text.includes('未通过整理：整理后仍超阈值且缩短不足 10%') && !text.includes('连接中断'),'明确拒收显示原因而非连接中断')
 const s2=await renderWithStatus(manualData({lastOk:false}),{interactive:true,post:()=>Promise.resolve({ok:true,status:200,text:async()=>JSON.stringify({ok:false,workspace:'测试工作区',skipped:null,result:{lastOk:false,failedChecks:['entries']}})})})
 const n2=await openAutomation(s2);await manualButton(n2).props.onClick()
 const t2=treeText(await s2.flush())
 ok(t2.includes('未通过整理：') && t2.includes('未过校验') && !t2.includes('连接中断'),'仅有校验项的拒收也显示原因')
}
{
 // 评审必须修 2：暂停提示不得承诺原文不动（停手库仍会下沉）
 const ap={paused:true,count:2,after:2,lastDay:'2026-11-13',lastRatio:0.027,baselineChars:23465,releaseDelta:0.15}
 const st=await renderWithStatus({...manualData({lastOk:false}),compactAutoPause:ap},{interactive:true});const text=treeText(await openAutomation(st))
 ok(!text.includes('原文不动') && text.includes('原样移到冷存') && text.includes('不调用模型'),'暂停提示说明仍可能下沉冷条目')
}
{
 // 按面板找控件：开关与关键控件在各自面板内
 const ui=await renderWithStatus({...baseStatus(null),cold:{count:2}},{interactive:true})
 const tree=ui.render(),has=(label,name)=>Boolean(findNode(findSection(tree,label),n=>n.props?.['aria-label']===name))
 for(const [label,name] of [['召回与检索','记忆检索工具'],['召回与检索','预览查询'],['提炼与整理','自动流水'],['提炼与整理','会话小结'],['提炼与整理','自动提炼（含超阈值整理）'],['提炼与整理','手动整理模型'],['提炼与整理','手动整理当前工作区一次'],['设置','记忆总开关']]) ok(has(label,name),label+' 面板内含控件：'+name)
 ok(Boolean(findNode(findSection(tree,'维护'),n=>n.type==='button' && n.children.length===1 && n.children[0]==='治理')),'维护 面板内含治理按钮')
 ok(!treeText(findSection(tree,'维护')).includes('到文件列表查看'),'维护面板不再把回收站与备份导向文件列表')
}

{
 const { compactStatus } = await import('../lib/compact-status.js');
 const base = { ok:false, before:3754, after:1570, errorCode:'insufficient-progress', totalCalls:0 };
 for (const [record, code, text] of [
  [{...base,sink:{count:7,after:1570}},'sink-partial','已下沉 7 条到冷存，热存仍超容量阈值（至少保留 5 条，或其余条目不可下沉）；可手动整理或人工精简。'],
  [{...base,sink:{count:0}},'sink-none','没有可下沉的条目，热存仍超容量阈值；可手动整理或人工精简。'],
  [{...base,errorCode:'sink-failed'},'sink-failed','下沉读写失败，热存未改动；下次巡检会重试。'],
  [{...base,totalCalls:1,sink:{count:0}},'insufficient-progress','整理结果仍超阈值且缩短不足 10%，视为无实质进展，已保留原文件。'],
 ]) {
  const compact = compactStatus(record);
  ok(compact.errorCode === code && compact.errorMessage === text, '原因投影：' + code);
  if (code === 'sink-partial') {
   const ui = await renderWithStatus(baseStatus(compact));
   const shown = treeText(ui);
   ok(shown.includes(text) && shown.includes('3754 → 1570') && !/已保留原文件|未写回/.test(shown), '部分下沉显示实际写入且不误报保留原文');
  }
 }
}

console.log('compact-panel: ' + passed + ' passed / ' + failed + ' failed')
if (failed > 0) process.exit(1)
