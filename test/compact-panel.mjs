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
    if(String(url).includes('/api/wb-memory/reasoning')) return Promise.resolve({ok:true,status:200,text:async()=>JSON.stringify(options.reasoning ? options.reasoning(String(url)) : {available:true,efforts:options.efforts || []})})
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
 const nav=byLabel(state.node,'记忆管理分区');const button=nav.children.find(n=>treeText(n).includes('自动化与治理'))
 button.props.onClick();const node=state.render();ok(findSection(node,'自动化与治理')?.props.hidden===false,'用户导航确实打开自动化与治理，而非搜索隐藏树');return node
}
const manualData=compact=>({...baseStatus(compact),compactManual:{expectedRevision:'a'.repeat(64),running:false}})
for(const [name,compact] of [['成功',{lastOk:true}],['失败',{lastOk:false}],['无记录',null],['未知',{}]]){
 const state=await renderWithStatus(manualData(compact),{interactive:true});const node=await openAutomation(state),button=manualButton(node)
 ok(Boolean(button) && !button.props.disabled,name+'状态入口常驻且不灰显')
}
{
 const data=manualData({lastOk:true});data.compactRetry={expectedAt:null,used:true};let posts=[]
 const state=await renderWithStatus(data,{interactive:true,config:{autoDistill:false,autoCompact:false},post:(url,opts)=>{posts.push({url,opts});return Promise.reject(Error('network'))}})
 const button=manualButton(await openAutomation(state));ok(Boolean(button)&&!button.props.disabled,'自动功能关闭/旧每日重试已用仍可主动整理')
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
 const state=await renderWithStatus(baseStatus(null),{interactive:true,config:{compactProvider:'fixture',compactModel:'m',compactReasoningEffort:'high'},efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]})
 const select=byLabel(state.node,'整理思考强度')
 ok(Boolean(select),'自动整理模型下有思考强度下拉框')
 ok(select?.props.value==='high','回显已保存的精确思考档位')
 ok(treeText(select).includes('Low') && !treeText(select).includes('Max'),'仅展示当前模型公告的档位')
}
{
 let sent;
 const s=await renderWithStatus(baseStatus(null),{interactive:true,config:{compactProvider:'fixture',compactModel:'m'},efforts:[{id:'low'}],post:async(url,init)=>{sent=JSON.parse(init.body);return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,compactReasoningEffort:'low'})}}});
 await byLabel(s.node,'整理思考强度').props.onChange({target:{value:'low'}});
 ok(sent.compactReasoningEffort==='low' && byLabel(s.render(),'整理思考强度').props.value==='low','选择档位保存并回显，不调用生成');
}
{
 const s=await renderWithStatus(baseStatus(null),{interactive:true,config:{compactProvider:'fixture',compactModel:'m',compactReasoningEffort:'high'},efforts:[{id:'low'}],post:async()=>{throw Error('offline')}});
 await byLabel(s.node,'整理思考强度').props.onChange({target:{value:'low'}});
 ok(byLabel(s.render(),'整理思考强度').props.value==='high','保存失败保留原档位');
}
{
 const s=await renderWithStatus(baseStatus(null),{config:{compactProvider:'fixture',compactModel:'m'},efforts:[{id:'none',name:'关闭'},{id:'low'}]});
 ok(treeText(byLabel(s,'整理思考强度')).includes('关闭'),'模型明确公告关闭时才展示关闭');
}
{
 const s=await renderWithStatus(baseStatus(null),{interactive:true,config:{compactProvider:'fixture',compactModel:'m',compactReasoningEffort:'high'},reasoning:url=>({available:true,efforts:url.includes('model=second')?[{id:'max',name:'新档位'}]:[{id:'high',name:'旧档位'}]}),post:async()=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true,compactReasoningEffort:'auto'})})});
 byLabel(s.node,'自动整理模型').props.onChange({target:{value:'fixture::second'}});
 const tree=await s.flush(),select=byLabel(tree,'整理思考强度');
 ok(select.props.value==='auto' && treeText(select).includes('新档位') && !treeText(select).includes('旧档位'),'切换模型重置策略并重新加载该模型档位');
}
{
 const tree=await renderWithStatus(baseStatus(null),{config:{compactProvider:'fixture',compactModel:'m',compactReasoningEffort:'high'},reasoning:()=>({available:false,efforts:[]})});
 const select=byLabel(tree,'整理思考强度');ok(select.props.disabled && select.props.value==='high','能力查询失败禁用但不清空已保存档位');
}
{
 const tree=await renderWithStatus(baseStatus(null),{config:{compactProvider:'fixture',compactModel:'m'},efforts:[{id:'low',name:'Low'}]});
 const text=treeText(tree);
 ok(text.includes('关闭思考（若支持）') && !text.includes('兼容旧策略'),'auto 显示新的关闭策略，不再显示旧语义');
 ok(text.includes('否则不传参数') && text.includes('不保证关闭'),'无关闭档位时明确说明默认回落不保证关闭');
}
{
 const tree=await renderWithStatus(baseStatus({lastOk:false,tokenBudget:'provider-default',maxTokens:null}));
 const text=treeText(tree);
 ok(text.includes('不设插件上限（上游默认）'),'手动结果预算区别于未知旧记录');
 ok(text.includes('自动整理使用已配置') && text.includes('不回落提炼预算') && text.includes('不保证成功'),'面板明确自动预算和上游限制不变');
}
{
 // 迭代 F2：自动整理暂停提示 + 手动整理入口
 const ap={paused:true,count:2,after:2,lastDay:'2026-11-13',lastRatio:0.027,baselineChars:23465,releaseDelta:0.15}
 const data={...manualData({lastOk:false,errorCode:'insufficient-progress'}),compactAutoPause:ap};let posts=[]
 const state=await renderWithStatus(data,{interactive:true,post:(url,init)=>{posts.push({url,init});return Promise.resolve({ok:true,status:200,text:async()=>JSON.stringify({ok:true})})}})
 const node=await openAutomation(state),text=treeText(node)
 ok(text.includes('自动整理已暂停：连续 2 次进展不足（最近 2026-11-13，缩短 2.7%）'),'暂停提示含次数、最近日期与缩短比例')
 ok(text.includes('15%') && text.includes('阈值'),'提示解除方式（库变化≥15%/降到阈值内）')
 const btn=byLabel(node,'立即手动整理（解除自动整理暂停）')
 ok(Boolean(btn) && !btn.props.disabled,'暂停时提供立即手动整理入口')
 if(btn){window.confirm=()=>true;await btn.props.onClick();ok(posts.length===1 && posts[0].url==='/api/wb-memory/compact-manual' && JSON.parse(posts[0].init.body).confirmed===true,'入口复用手动整理接口')}
 for(const [name,v] of [['paused=false',{...ap,paused:false}],['null',null],['缺字段',undefined]]){
  const st=await renderWithStatus({...manualData({lastOk:false}),compactAutoPause:v},{interactive:true});const n=await openAutomation(st)
  ok(!treeText(n).includes('自动整理已暂停') && !byLabel(n,'立即手动整理（解除自动整理暂停）'),'不暂停时不显示提示：'+name)
 }
}
console.log('compact-panel: ' + passed + ' passed / ' + failed + ' failed')
if (failed > 0) process.exit(1)
