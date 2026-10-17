// dsh-wb-memory client bundle (v8 面板对齐)：状态条 + 总控分组卡片 + 检索/治理 + 文件管理。
// v8 变更（对齐后端 v8.0 功能，2026-09-01 面板改进建议 G1-G12）：
//   状态条 grid 化 + 新增今日小结/置顶指标；compact 徽章支持「带警告/第 2 轮」；
//   文件/检索/治理区跟随 cwd 自动命中（resolvedWorkspace）消除口径分裂；
//   总控开关三分组（自动化/工具/参数）；检索支持日期范围；治理按钮去红色；
//   建议 callout 折叠；文案清除内部代号（v8/F1）。
// 历史（v5）：状态指标条、总闸+子开关、影响范围显示、立即提炼二次确认、
// 提示分层 callout、分组卡片、检索/治理解除隐藏、新建文件、busy 反馈。
// 词汇统一：流水/小结/提炼/整理/治理/画像/置顶。
window.__ModuleLoader__.load({ id: "dsh-wb-memory", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  let react = require("react");
  const h = react.createElement;
  const { useState, useEffect, useCallback, useRef } = react;

  const name = "wb-memory";
  const inject = ["slots"];

  // 统一响应解析（2026-09-29）：不假设响应体一定是 JSON。宿主的 webServer 在
  // 路由未命中 / handler 抛错时返回的是**空体** 404/400，本插件过去在 403/405
  // 时也返回空体，此时 r.json() 只会抛 "Unexpected end of JSON input"，
  // 面板上既看不出状态码也看不出原因。这里把状态码与响应片段带进错误信息。
  async function readJson(res) {
    const text = await res.text();
    if (!res.ok) {
      throw new Error("HTTP " + res.status + (res.statusText ? " " + res.statusText : "") + (text ? "：" + text.slice(0, 200) : "（响应体为空）"));
    }
    if (!text) throw new Error("HTTP " + res.status + "：响应体为空");
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("HTTP " + res.status + "：响应不是 JSON（" + text.slice(0, 200).replace(/\s+/g, " ") + "）");
    }
  }

  const BTN_STYLE = {
    padding: "6px 14px",
    borderRadius: "6px",
    border: "1px solid rgba(128, 128, 128, 0.35)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: "13px",
  };
  const BTN_PRIMARY = { ...BTN_STYLE, background: "rgba(59,130,246,0.12)", borderColor: "rgba(59,130,246,0.4)" };
  const BTN_DANGER = { ...BTN_STYLE, color: "#e5484d", borderColor: "rgba(229,72,77,0.4)" };

  // 分组卡片（C5）
  const CARD_STYLE = {
    border: "1px solid rgba(128,128,128,0.15)",
    borderRadius: "8px",
    padding: "18px 20px",
    marginBottom: "16px",
    background: "color-mix(in srgb, currentColor 2%, transparent)",
  };
  // 提示分层 callout（C4）：约束=橙，建议=蓝
  const CALLOUT_WARN = {
    fontSize: "11px", padding: "6px 8px", borderRadius: "4px",
    background: "rgba(229,165,72,0.1)", borderLeft: "2px solid #e5a548",
    margin: "6px 0 0", lineHeight: 1.5,
  };
  const CALLOUT_INFO = {
    fontSize: "11px", padding: "6px 8px", borderRadius: "4px",
    background: "rgba(90,160,255,0.1)", borderLeft: "2px solid #5a9fff",
    margin: "6px 0 0", lineHeight: 1.5,
  };
  // busy spinner（C8）：动画仅 transform
  const SPIN_CSS = "@keyframes wbmem-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}";
  const SPINNER = {
    display: "inline-block", width: "12px", height: "12px", borderRadius: "50%",
    border: "2px solid rgba(128,128,128,0.35)", borderTopColor: "rgba(128,128,128,0.9)",
    animation: "wbmem-spin 0.8s linear infinite", flexShrink: 0,
  };

  const HUB_CSS = "\n.wb-hub{max-width:1120px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit);--wb-line:var(--dsw-alias-border-l1,rgba(128,128,128,.22));--wb-blue:#3b82f6;padding:4px 0 24px}\n.wb-hub *{box-sizing:border-box}.wb-hub [hidden]{display:none!important}.wb-hub button,.wb-hub input,.wb-hub select,.wb-hub textarea{font-family:inherit}.wb-hub button{color:inherit;transition:background 150ms,border-color 150ms}.wb-hub button:not(:disabled):hover{background:rgba(59,130,246,.12)!important}.wb-hub button:disabled{opacity:.45;cursor:not-allowed!important}.wb-hub :focus-visible{outline:2px solid var(--wb-blue);outline-offset:3px}.wb-hub input,.wb-hub select{min-height:36px;max-width:100%}.wb-hub option{background:var(--dsw-alias-background-primary,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}\n.wb-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0 20px}.wb-eyebrow{font-size:11px;letter-spacing:.12em;opacity:.65}.wb-header>button{flex-shrink:0;white-space:nowrap}.wb-header h2{font-size:20px;line-height:1.4;font-weight:650;margin:6px 0}.wb-meta{font-size:12px;opacity:.74;overflow-wrap:anywhere}.wb-scope{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 16px;border:1px solid var(--wb-line);border-radius:10px}.wb-scope>.wb-meta{margin-left:auto}.wb-nav{display:flex;gap:6px;padding:16px 0;margin-bottom:12px;border-bottom:1px solid var(--wb-line);overflow:auto}.wb-nav button{display:flex;gap:10px;align-items:center;white-space:nowrap;flex:1;padding:12px 16px;border:0;border-radius:8px;background:transparent;font-size:13px;text-align:left;cursor:pointer}.wb-nav button>span{font-size:11px;opacity:.55;font-variant-numeric:tabular-nums}.wb-nav .active{background:rgba(59,130,246,.12);box-shadow:inset 0 -2px var(--wb-blue)}.wb-section-head{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:8px 0 16px}.wb-hub h3{font-size:16px;margin:0}.wb-hub h4{font-size:14px;margin:0 0 12px;font-weight:600}.wb-attention{border-left:3px solid var(--wb-blue);background:rgba(59,130,246,.06);padding:12px 16px;margin:16px 0;border-radius:0 8px 8px 0}.wb-quick{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.wb-flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:12px 0;border:1px solid var(--wb-line);border-radius:8px}.wb-tags{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.wb-tag{display:inline-block;font-size:11px;padding:3px 8px;border:1px solid var(--wb-line);border-radius:6px;line-height:1.5}.wb-selected{background:rgba(34,197,94,.10);border-color:rgba(34,197,94,.35)}.wb-empty{padding:24px 16px;margin:12px 0;border:1px dashed var(--wb-line);border-radius:8px;opacity:.72;font-size:13px}.wb-preview-form{display:flex;gap:8px;margin:16px 0}.wb-table-wrap{overflow:auto;border:1px solid var(--wb-line);border-radius:8px}.wb-table{min-width:520px;width:100%;border-collapse:collapse;font-size:12px}.wb-table th{text-align:left;font-weight:500;opacity:.7;background:color-mix(in srgb,currentColor 4%,transparent)}.wb-table th,.wb-table td{padding:10px 12px;border-bottom:1px solid var(--wb-line);vertical-align:top}.wb-table td:first-child{min-width:180px;overflow-wrap:anywhere}.wb-table td:not(:first-child){white-space:nowrap}.wb-budget{margin-top:16px}.wb-budget summary{cursor:pointer}.wb-error{color:#e5484d;overflow-wrap:anywhere}.wb-footer{border-top:1px solid var(--wb-line);padding-top:16px;margin-top:24px}\n@media(max-width:600px){.wb-flow>div:last-child{grid-column:1/-1}.wb-header{align-items:flex-start}.wb-header h2{font-size:18px}.wb-nav button{flex:0 0 auto;padding:10px 12px}.wb-preview-form{flex-direction:column}.wb-hub li{flex-wrap:wrap}.wb-scope>.wb-meta{margin-left:0}.wb-hub input,.wb-hub select{min-width:0!important}.wb-hub button{min-height:36px}}\n@media(prefers-reduced-motion:reduce){.wb-hub *{animation:none!important;transition:none!important}}\n";

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("zh-CN", { hour12: false });
  }

  function fmtSize(n) {
    if (typeof n !== "number") return "";
    if (n < 1024) return n + " B";
    return (n / 1024).toFixed(1) + " KB";
  }

  // 固定合成语料离线对照；不会读当前工作区记忆或修改线上配置。
  function RecallEvalPanel() {
    const [report, setReport] = useState(null), [candidateK, setCandidateK] = useState('1');
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const ticket = useRef(0), alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; ticket.current++; }; }, []);
    const run = async () => {
      const id = ++ticket.current; setBusy(true); setError(''); setReport(null);
      try {
        const r = await readJson(await fetch('/api/wb-memory/recall-eval?candidateK=' + candidateK));
        if (alive.current && ticket.current === id) setReport(r);
      } catch (e) { if (alive.current && ticket.current === id) setError(String(e?.message || e)); }
      finally { if (alive.current && ticket.current === id) setBusy(false); }
    };
    return h('div', { style: CARD_STYLE, 'aria-label': '离线召回评测' },
      h('h4', null, '用固定问题，观察召回取舍'),
      h('p', { className: 'wb-meta' }, '仅使用内置合成语料，比较现有排序与离线 top-K 对照。不会评测模型回答、读取真实记忆或自动调整线上阈值；失败案例会原样展示。'),
      h('div', { className: 'wb-quick' },
        h('label', null, '离线对照条数 ', h('select', { 'aria-label': '离线对照条数', disabled: busy, value: candidateK, onChange: e => { setCandidateK(e.target.value); setReport(null); ticket.current++; } }, [1,3,5].map(k=>h('option',{key:k,value:String(k)},'top-' + k)))),
        h('button', { style: BTN_PRIMARY, disabled: busy, onClick: run }, busy ? '评测中…' : '运行合成评测')),
      error ? h('p', { role: 'alert', className: 'wb-error' }, error) : null,
      report ? h('div', null,
        h('div', { className: 'wb-flow' }, [report.baseline, report.candidate].map((side,i)=>h('div',{key:i,style:{padding:'12px'}},h('strong',null,i?'离线 top-' + report.candidateK:'基线 top-5'),h('div',null,'符合预期 ' + side.summary.passed + ' / ' + side.summary.caseCount),h('div',{className:'wb-meta'},'期望命中 ' + side.summary.expectedHits + ' / ' + side.summary.expectedTotal + ' · 禁选命中 ' + side.summary.forbiddenHits)))),
        h('p', { className: 'wb-meta' }, '基线固定 top-5，并非当前工作区配置。符合预期要求期望全部命中、首选正确、无禁选且无额外未标注候选；额外候选需复核，不等同错误事实。合成结果不代表模型回答质量。'),
        h('details', null, h('summary',null,'逐案例结果与漏召回'),
          h('div',{className:'wb-table-wrap'},h('table',{className:'wb-table'},
            h('thead',null,h('tr',null,['案例 / 查询','现有排序','离线对照'].map(x=>h('th',{key:x},x)))),
            h('tbody',null,report.baseline.cases.map((r,i)=>h('tr',{key:r.id},
              h('td',null,r.id,h('div',{className:'wb-meta'},r.query)),
              ...[r,report.candidate.cases[i]].map((v,j)=>h('td',{key:j,style:{whiteSpace:'normal'}},v.passed?'符合预期':'待改进',h('div',{className:'wb-meta'},'入选：' + (v.selectedTitles.join('、') || '无')),v.missedTitles.length?h('div',null,'漏选：'+v.missedTitles.join('、')):null,v.forbiddenHits.length?h('div',null,'禁选命中：'+v.forbiddenHits.join('、')):null,v.unexpectedTitles?.length?h('div',null,'额外未标注：'+v.unexpectedTitles.join('、')):null,v.error?h('div',{className:'wb-error'},'评测错误：'+v.error):null))))))))) : null);
  }

  const layerLabels = { profile:'画像', pinned:'置顶', memory:'长期条目', summary:'长期摘要', today:'今日日志', review:'近期回顾', inactive:'已退场条目' };
  function crossLayerView(d, preview) {
    if (!d) return null;
    const names = {duplicate:'重复片段', 'possible-conflict':'疑似值冲突', 'inactive-reference':'历史状态仍被引用'};
    return h('details', { className:'wb-budget', 'aria-label':'跨层来源诊断' },
      h('summary',null,'跨层来源诊断 · ' + (d.findings || []).length + ' 项线索'),
      h('p',{className:'wb-meta'},'仅观察最终组装文本，按章节标题推定来源；相似不等于矛盾，未发现不保证没有冲突。不会自动删改或屏蔽历史。'),
      d.degraded ? h('p',{className:'wb-error'},'本次检测降级，结果不完整。') : null,
      d.truncated ? h('p',{className:'wb-meta'},'达到扫描或展示上限，结果不完整。') : null,
      !(d.findings || []).length ? h('div',{className:'wb-empty'},'本次未发现匹配线索。') : null,
      (d.findings || []).map((f,i)=>h('div',{key:i,style:{borderLeft:'3px solid #b7791f',padding:'8px 12px',margin:'12px 0',overflowWrap:'anywhere'}},
        h('strong',null,names[f.kind] || f.kind),h('span',{className:'wb-tag',style:{marginLeft:'8px'}},'需人工核实'),
        ...[f.left,f.right].map((s,j)=>h('div',{key:j,className:'wb-meta'},(layerLabels[s.layer] || s.layer) + ' · ' + s.label,preview && s.excerpt ? h('blockquote',{style:{margin:'4px 0',whiteSpace:'pre-wrap'}},s.excerpt):null)),
        h('p',{className:'wb-meta'},f.reason))),
      h('p',{className:'wb-meta'},preview?'短证据仅随本次手动预览返回，不保存进实际组装账。':'实际账仅保存来源与检测依据；查看正文短证据请手动预览。'));
  }

  // 独立组件：key绑定工作区；读请求序号与卸载标记隔离迟到响应。
  function MemoryLifecyclePanel({ workspace, onChanged }) {
    const [list, setList] = useState(null), [state, setState] = useState('all'), [offset, setOffset] = useState(0);
    const [entry, setEntry] = useState(null), [edit, setEdit] = useState(null), [plan, setPlan] = useState(null);
    const [pending, setPending] = useState(false), [loading, setLoading] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
    const alive = useRef(true), reads = useRef(0), details = useRef(0);
    useEffect(() => { alive.current = true; return () => { alive.current = false; reads.current++; details.current++; }; }, []);
    const api = '/api/wb-memory/memories';
    const input = { width: '100%', padding: '8px 10px', border: '1px solid var(--wb-line)', borderRadius: '6px', background: 'transparent', color: 'inherit', fontSize: '13px' };
    const labels = { current: '当前有效', superseded: '已替代', retracted: '已撤回' };
    const actions = { correct: '更正', retract: '撤回', restore: '恢复', migrate: '补充稳定 ID' };
    const refresh = useCallback(async () => {
      const ticket = ++reads.current; setLoading(true); setError('');
      try {
        const d = await fetch(api + '?workspace=' + encodeURIComponent(workspace) + '&state=' + state + '&offset=' + offset, { cache: 'no-store' }).then(readJson);
        if (alive.current && reads.current === ticket) setList(d);
      } catch (e) { if (alive.current && reads.current === ticket) { setList(null); setError(e.message); } }
      finally { if (alive.current && reads.current === ticket) setLoading(false); }
    }, [workspace, state, offset]);
    useEffect(() => { setEntry(null); setEdit(null); setPlan(null); details.current++; refresh(); }, [refresh]);
    async function open(id) {
      const ticket = ++details.current; setEntry(null); setEdit(null); setPlan(null); setError('');
      try {
        const d = await fetch(api + '?workspace=' + encodeURIComponent(workspace) + '&id=' + encodeURIComponent(id), { cache: 'no-store' }).then(readJson);
        if (alive.current && details.current === ticket) setEntry(d);
      } catch (e) { if (alive.current && details.current === ticket) setError(e.message); }
    }
    async function post(body, preview = false) {
      setPending(true); setError(''); setMessage('');
      try {
        const d = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, workspace }) }).then(readJson);
        if (!alive.current) return;
        if (preview) { setPlan(d); setEntry(null); setEdit(null); }
        else {
          details.current++; setEntry(null); setEdit(null); setPlan(null);
          setMessage('已' + actions[body.action] + '；原文件已备份。' + (d.backup ? ' 备份：' + d.backup : ''));
          refresh(); if (onChanged) onChanged();
        }
      } catch (e) { if (alive.current) setError(e.message + '。若提示记忆已变化，请刷新列表并重新核对，不会自动覆盖。'); }
      finally { if (alive.current) setPending(false); }
    }
    function submit(e) {
      e.preventDefault();
      if (!edit || !edit.reason.trim()) return;
      if (!window.confirm('工作区「' + workspace + '」：确认' + actions[edit.action] + '「' + edit.originalTitle + '」？原文将保留，并在写入前备份。')) return;
      post({ ...edit, reason: edit.reason.trim() });
    }
    return h('div', { className: 'wb-card', style: { marginBottom: '20px' }, 'aria-label': '长期记忆管理' },
      h('div', { className: 'wb-section-head' }, h('h3', null, '长期记忆管理'), h('button', { style: BTN_STYLE, disabled: pending || loading, onClick: () => { setEntry(null); setEdit(null); setPlan(null); details.current++; refresh(); } }, '刷新列表')),
      h('p', { className: 'wb-meta' }, '工作区：' + workspace + ' · 只管理长期记忆，不改置顶、画像或历史日志。撤回与替代条目不再作为当前长期事实召回；日志仍可能包含旧内容。'),
      h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' } },
        h('label', null, '条目状态 ', h('select', { 'aria-label': '条目状态', value: state, disabled: pending, style: { ...input, width: 'auto' }, onChange: e => { setState(e.target.value); setOffset(0); } },
          [['all', '全部条目'], ['current', '当前有效（含未编号）'], ['superseded', '已替代'], ['retracted', '已撤回'], ['unmanaged', '待补 ID']].map(([v, t]) => h('option', { key: v, value: v }, t)))),
        list ? h('span', { className: 'wb-meta' }, '总计 ' + list.total + ' · 待补 ID ' + list.unmanaged) : null),
      loading ? h('p', { role: 'status', className: 'wb-meta' }, '正在读取条目…') : null,
      error ? h('p', { role: 'alert', className: 'wb-error', style: { overflowWrap: 'anywhere' } }, error) : null,
      message ? h('p', { role: 'status', className: 'wb-meta', style: { overflowWrap: 'anywhere' } }, message) : null,
      list && list.unmanaged > 0 ? h('div', { style: CALLOUT_INFO },
        '旧条目仍可正常召回；查看不会自动写入。补 ID 后才能逐条修订。', h('div', { style: { marginTop: '8px' } }, h('button', { style: BTN_STYLE, disabled: pending || loading, onClick: () => post({ action: 'preview-migration', revision: list.revision }, true) }, '预览补 ID'))) : null,
      plan ? h('div', { style: { ...CARD_STYLE, marginTop: '12px' } },
        h('strong', null, '迁移预览：' + plan.planned + ' 条待补 ID'), h('p', { className: 'wb-meta' }, '仅新增随机稳定 ID 和迁移事件，不改正文与当前状态。实际应用前备份整个文件；记忆变化则拒绝应用。'),
        h('ul', null, (plan.titles || []).map((t, i) => h('li', { key: i, style: { overflowWrap: 'anywhere' } }, t))),
        plan.planned > 20 ? h('p', { className: 'wb-meta' }, '仅展示前 20 个标题。') : null,
        h('button', { style: BTN_PRIMARY, disabled: pending || !plan.planned, onClick: () => { if (window.confirm('确认给工作区「' + workspace + '」的 ' + plan.planned + ' 条旧记忆补充稳定 ID？将先备份原文件。')) post({ action: 'migrate', revision: plan.revision }); } }, '确认应用补 ID'),
        h('button', { style: BTN_STYLE, disabled: pending, onClick: () => setPlan(null) }, '取消迁移')) : null,
      list && !loading ? h('div', { style: { marginTop: '12px' } },
        list.entries.length ? h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, list.entries.map((r, i) => h('li', { key: r.id || offset + ':' + i, style: { padding: '12px 0', borderBottom: '1px solid var(--wb-line)', display: 'flex', alignItems: 'center', gap: '12px' } },
          h('div', { style: { flex: 1, minWidth: 0 } }, h('strong', { style: { overflowWrap: 'anywhere' } }, r.title), h('div', { className: 'wb-meta' }, (labels[r.state] || r.state) + (r.managed ? ' · ' + r.id : ' · 未编号'))),
          r.id ? h('button', { style: { ...BTN_STYLE, flexShrink: 0 }, disabled: pending, onClick: () => open(r.id) }, '查看与修订') : null))) : h('p', { className: 'wb-empty' }, '此状态下暂无条目。'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginTop: '12px' } },
          h('button', { style: BTN_STYLE, disabled: pending || offset === 0, onClick: () => setOffset(Math.max(0, offset - 25)) }, '上一页'),
          h('span', { className: 'wb-meta' }, list.filtered ? (offset + 1) + '–' + Math.min(offset + 25, list.filtered) + ' / ' + list.filtered : '0 / 0'),
          h('button', { style: BTN_STYLE, disabled: pending || offset + 25 >= list.filtered, onClick: () => setOffset(offset + 25) }, '下一页'))) : null,
      entry ? h('div', { style: { ...CARD_STYLE, marginTop: '16px' } },
        h('div', { className: 'wb-section-head' }, h('strong', { style: { overflowWrap: 'anywhere' } }, entry.entry.title), h('button', { style: BTN_STYLE, disabled: pending, onClick: () => { details.current++; setEntry(null); setEdit(null); } }, '关闭条目')),
        h('p', { className: 'wb-meta' }, labels[entry.entry.state] + ' · ' + entry.entry.id),
        h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '320px', overflow: 'auto', fontSize: '13px' } }, entry.entry.body || '（空正文）'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, (entry.entry.state === 'current' ? ['correct', 'retract'] : ['restore']).map(action => h('button', { key: action, disabled: pending, style: action === 'retract' ? BTN_DANGER : BTN_STYLE, onClick: () => { setPlan(null); setEdit({ action, revision: entry.revision, id: entry.entry.id, originalTitle: entry.entry.title, title: entry.entry.title, body: entry.entry.body, reason: '' }); } }, actions[action]))),
        h('details', { style: { marginTop: '12px' } }, h('summary', null, '修订历史与关联'),
          h('p', { className: 'wb-meta' }, '前序：' + (entry.entry.from || '无') + ' · 后继：' + (entry.entry.by || '无')),
          h('ul', null, (entry.entry.events || []).map((v, i) => h('li', { key: i, style: { overflowWrap: 'anywhere' } }, fmtTime(v.at) + ' · ' + (actions[v.action] || v.action) + (v.reason ? ' · ' + v.reason : '') + (v.related ? ' · ' + v.related : '')))))) : null,
      edit ? h('form', { onSubmit: submit, style: { ...CARD_STYLE, marginTop: '12px' } },
        h('strong', null, actions[edit.action] + '条目 · ' + workspace),
        edit.action === 'correct' ? h('div', null,
          h('label', { style: { display: 'block', marginTop: '12px' } }, '更正后标题', h('input', { 'aria-label': '更正后标题', style: input, required: true, maxLength: 160, value: edit.title, disabled: pending, onChange: e => setEdit({ ...edit, title: e.target.value }) })),
          h('label', { style: { display: 'block', marginTop: '12px' } }, '更正后正文', h('textarea', { 'aria-label': '更正后正文', style: { ...input, minHeight: '160px', resize: 'vertical' }, required: true, maxLength: 16000, value: edit.body, disabled: pending, onChange: e => setEdit({ ...edit, body: e.target.value }) })),
          h('p', { className: 'wb-meta' }, '更正会生成新 ID；旧正文以「已替代」保留，不经过模糊去重。正文不要包含一级、二级标题或管理标记。')) : h('p', { className: 'wb-meta' }, edit.action === 'restore' ? '恢复保留原 ID；同一修订链已有当前有效条目时将拒绝。请先撤回有效后继。' : '只停止当前长期事实召回，保留原文和修订链，不删除历史日志。'),
        h('label', { style: { display: 'block', marginTop: '12px' } }, '操作原因（必填）', h('textarea', { 'aria-label': '操作原因（必填）', style: { ...input, minHeight: '64px' }, required: true, maxLength: 300, value: edit.reason, disabled: pending, onChange: e => setEdit({ ...edit, reason: e.target.value }) })),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } }, h('button', { type: 'submit', style: BTN_PRIMARY, disabled: pending || !edit.reason.trim() }, pending ? '正在保存…' : '确认' + actions[edit.action]), h('button', { type: 'button', style: BTN_STYLE, disabled: pending, onClick: () => setEdit(null) }, '取消修订'))) : null);
  }

  function WBMemorySection() {
    const [section, setSection] = useState('overview');
    const [previewQ, setPreviewQ] = useState('');
    const [preview, setPreview] = useState(null);
    const [previewBusy, setPreviewBusy] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const previewRequest = useRef(0);
    const filesRequest = useRef(0);
    const statusRequest = useRef(0);
    const [enabled, setEnabled] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [files, setFiles] = useState([]);
    const [fileWorkspace, setFileWorkspace] = useState(null);
    const [workspaces, setWorkspaces] = useState([]);
    const [activeProject, setActiveProject] = useState(null);
    const [notice, setNotice] = useState({ kind: "idle", text: "" });
    const [busy, setBusy] = useState(false);
    const [searchQ, setSearchQ] = useState("");
    const [searchResults, setSearchResults] = useState([]);
    const [searchDone, setSearchDone] = useState(false);
    const [searchDateFrom, setSearchDateFrom] = useState(""); // G8：检索日期范围（可选）
    const [searchDateTo, setSearchDateTo] = useState("");
    const [llmProviders, setLlmProviders] = useState([]);
    const [modelsNote, setModelsNote] = useState("");
    const [distillRoute, setDistillRoute] = useState(""); // "provider::model"
    const [compactRoute, setCompactRoute] = useState(""); // "provider::model"（空=跟随提炼模型）
    const [autoDigest, setAutoDigest] = useState(true);
    const [viewing, setViewing] = useState(null); // { path, content } | null
    // v5 新增 state
    const [status, setStatus] = useState(null); // GET /api/wb-memory/status 响应
    const [autoDistill, setAutoDistill] = useState(true);
    const [gcEnabled, setGcEnabled] = useState(true);
    // v8 新增 state
    const [sessionSummary, setSessionSummary] = useState(true);
    const [memorySearchTool, setMemorySearchTool] = useState(true);
    const [dayBoundaryHour, setDayBoundaryHour] = useState(4);
    const [newFileOpen, setNewFileOpen] = useState(false);
    const [newFileName, setNewFileName] = useState("");
    const [newFileBody, setNewFileBody] = useState("");

    // G5：文件列表抓取抽离——支持 workspace 覆盖参数。优先级：显式 ws >
    // activeProject；fetchStatus 发现 cwd 自动命中其他工作区时用 resolved 补拉，
    // 消除「状态条有数据、文件区让选人」的口径分裂。
    const fetchFiles = useCallback((ws) => {
      const ticket = ++filesRequest.current;
      const q = ws ? "?workspace=" + encodeURIComponent(ws) : "";
      fetch("/api/wb-memory/files" + q, { cache: "no-store" })
        .then(readJson)
        .then((d) => { if (ticket !== filesRequest.current) return; setFiles(d.files || []); setFileWorkspace(d.workspace || null); })
        .catch(() => {});
    }, []);

    const fetchStatus = useCallback((ws) => {
      const ticket = ++statusRequest.current;
      const q = ws ? "?workspace=" + encodeURIComponent(ws) : "";
      fetch("/api/wb-memory/status" + q, { cache: "no-store" })
        .then(readJson)
        .then((d) => {
          if (ticket !== statusRequest.current) return;
          setStatus(d);
          // G5：状态条已按 cwd 自动命中工作区时，文件区跟随同一工作区
          if (d.resolvedWorkspace && d.resolvedWorkspace !== ws) fetchFiles(d.resolvedWorkspace);
        })
        .catch(() => { if (ticket === statusRequest.current) setStatus(null); });
    }, [fetchFiles]);

    const refresh = useCallback(() => {
      fetch("/api/wb-memory/config", { cache: "no-store" })
        .then(readJson)
        .then((d) => {
          setEnabled(Boolean(d.enabled));
          setActiveProject(d.activeProject || null);
          setAutoDigest(d.autoDigest !== false);
          setAutoDistill(d.autoDistill !== false);
          setGcEnabled(d.gcEnabled !== false);
          setSessionSummary(d.sessionSummary !== false);
          setMemorySearchTool(d.memorySearchTool !== false);
          setDayBoundaryHour(Number.isFinite(Number(d.dayBoundaryHour)) && d.dayBoundaryHour >= 0 && d.dayBoundaryHour <= 23 ? Number(d.dayBoundaryHour) : 4);
          setDistillRoute(d.distillProvider && d.distillModel ? d.distillProvider + "::" + d.distillModel : "");
          setCompactRoute(d.compactProvider && d.compactModel ? d.compactProvider + "::" + d.compactModel : "");
          setLoaded(true);
          fetchStatus(d.activeProject || null);
          fetchFiles(d.activeProject || null);
        })
        .catch((e) => { setLoaded(true); setNotice({ kind: "error", text: "读取配置失败：" + e.message }); });
      fetch("/api/wb-memory/workspaces", { cache: "no-store" })
        .then(readJson)
        .then((d) => setWorkspaces(d.workspaces || []))
        .catch(() => {});
      fetch("/api/wb-memory/models", { cache: "no-store" })
        .then(readJson)
        .then((d) => { setLlmProviders(d.providers || []); setModelsNote(d.note || ""); })
        .catch((e) => setModelsNote("读取可用模型列表失败：" + e.message + "（模型下拉框会因此为空）"));
    }, [fetchStatus, fetchFiles]);

    useEffect(() => { refresh(); }, [refresh]);

    const toggle = useCallback(() => {
      const next = !enabled;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next, activeProject: activeProject || null }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setEnabled(next);
            setNotice({
              kind: "ok",
              text: next
                ? "已启用记忆：会话会自动注入画像 + 摘要/相关条目 + 今日日志（分层，省 token）。"
                : "已关闭记忆：新会话将不再注入记忆上下文。",
            });
            refresh();
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [enabled, activeProject, refresh]);

    const toggleDigest = useCallback(() => {
      const next = !autoDigest;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoDigest: next }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setAutoDigest(next);
            setNotice({
              kind: "ok",
              text: next
                ? "已开启自动流水：每轮对话完成后自动在当日日志追加一条简短记录（做了什么 → 结论）。"
                : "已关闭自动流水：不再自动记录对话流水（收尾手动记录与提炼不受影响）。",
            });
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [autoDigest]);

    const toggleDistill = useCallback(() => {
      const next = !autoDistill;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoDistill: next }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setAutoDistill(next);
            setNotice({
              kind: "ok",
              text: next
                ? "已开启自动提炼：巡检把昨天及更早的日志提炼进 MEMORY.md，超阈值时自动整理（需已配置提炼模型）。"
                : "已关闭自动提炼：日志提炼与超阈值整理全部暂停（流水记录不受影响）。",
            });
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [autoDistill]);

    const toggleGc = useCallback(() => {
      const next = !gcEnabled;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gcEnabled: next }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setGcEnabled(next);
            setNotice({
              kind: "ok",
              text: next
                ? "已开启治理：「治理」按钮可执行归档过期日志、近重复检测与回收站/归档超期清理。"
                : "已关闭治理：「治理」按钮将跳过（gcEnabled=false）。回收站与归档文件原样保留。",
            });
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [gcEnabled]);

    // v8：会话小结开关（N4）
    const toggleSummary = useCallback(() => {
      const next = !sessionSummary;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionSummary: next }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setSessionSummary(next);
            setNotice({
              kind: "ok",
              text: next
                ? "已开启会话小结：会话空闲 10 分钟后自动生成 150-300 字小结（含决策理由与未竟事项）写入当日日志。需已配置提炼模型；短会话（<300 字）与每日上限自动跳过。"
                : "已关闭会话小结：不再自动生成会话小结（流水记录不受影响）。",
            });
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [sessionSummary]);

    // v8：memory_search 工具开关（N2；改动需重载插件生效）
    const toggleSearchTool = useCallback(() => {
      const next = !memorySearchTool;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memorySearchTool: next }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setMemorySearchTool(next);
            setNotice({
              kind: "ok",
              text: next
                ? "已开启记忆检索工具：重启/重载 dsh 后 agent 工具列表出现 memory_search（长期记忆 + 近期日志双源检索）。"
                : "已关闭记忆检索工具：重启/重载 dsh 后不再注册（HTTP 检索端点不受影响）。",
            });
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [memorySearchTool]);

    // v8：逻辑日分界小时（F1）
    const changeDayBoundary = useCallback((value) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 23) return;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dayBoundaryHour: v }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setDayBoundaryHour(v);
            setNotice({
              kind: "ok",
              text: v === 0
                ? "逻辑日分界已设为 0 点：恢复日历日切分（凌晨会话归当天）。"
                : "逻辑日分界已设为 " + v + " 点：凌晨 " + v + ' 点前的会话活动归前一天（"昨晚的延续"）。',
            });
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, []);

    const selectProject = useCallback((value) => {
      const v = value || null;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, activeProject: v }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            filesRequest.current++; statusRequest.current++; previewRequest.current++;
            setFiles([]); setFileWorkspace(null); setStatus(null); setPreview(null); setViewing(null); setSearchDone(false);
            setActiveProject(v);
            setNotice({
              kind: "ok",
              text: v
                ? "已绑定当前工作区：" + v + " —— 新会话将自动载入其 .workbuddy/memory 摘要。"
                : "已设为「自动匹配」：按会话工作目录自动载入对应工作区记忆。",
            });
            refresh();
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [enabled, refresh]);

    const selectDistillRoute = useCallback((value) => {
      const v = value || "";
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      const body = v
        ? { distillProvider: v.split("::")[0], distillModel: v.split("::")[1] || "" }
        : { distillProvider: "", distillModel: "" };
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setDistillRoute(v);
            setNotice({
              kind: "ok",
              text: v
                ? "提炼模型已设为 " + v.replace("::", " · ") + " —— 下一轮巡检（或点「立即提炼」）将用它把历史日志提炼进 MEMORY.md。"
                : "已清空提炼模型：自动提炼暂停（自动流水不受影响）。",
            });
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, []);

    const selectCompactRoute = useCallback((value) => {
      const v = value || "";
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      const body = v
        ? { compactProvider: v.split("::")[0], compactModel: v.split("::")[1] || "" }
        : { compactProvider: "", compactModel: "" };
      fetch("/api/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setCompactRoute(v);
            setNotice({
              kind: "ok",
              text: v
                ? "整理模型已设为 " + v.replace("::", " · ") + " —— MEMORY.md 超阈值时将用它自动整理（建议配指令遵循强的模型）。"
                : "已恢复默认：整理任务使用提炼模型。",
            });
          } else {
            setNotice({ kind: "error", text: "失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, []);

    const runDistillNow = useCallback(() => {
      if (!window.confirm("将扫描全部工作区：提炼各工作区未提炼的历史日志、整理超阈值的 MEMORY.md、评估画像候选。每小时巡检也会做同样的事，此按钮是立即执行。继续？")) return;
      setBusy(true);
      setNotice({ kind: "busy", text: "提炼中…" });
      fetch("/api/wb-memory/distill", { method: "POST", cache: "no-store" })
        .then(readJson)
        .then((d) => {
          if (d.error) {
            setNotice({ kind: "error", text: "失败：" + d.error });
          } else {
            setNotice({ kind: "ok", text: "提炼已在后台启动：正在把各工作区未提炼的历史日志写入 MEMORY.md（每份日志一次 LLM 调用，稍后刷新查看结果）。" });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, []);

    // G5：面板实际操作的工作区——文件列表的实际来源（含 cwd 自动命中补拉）优先，
    // 回落面板 activeProject。文件查看/删除/新建/检索/治理全部对齐此口径。
    const panelWs = fileWorkspace || activeProject;
    useEffect(() => { previewRequest.current++; setPreview(null); setPreviewError(''); setPreviewBusy(false); }, [panelWs]);
    const runPreview = async () => {
      const ticket = ++previewRequest.current;
      setPreviewBusy(true); setPreviewError(''); setPreview(null);
      try {
        const d = await fetch('/api/wb-memory/recall-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: panelWs, q: previewQ }) }).then(readJson);
        if (ticket === previewRequest.current) setPreview(d);
      } catch (e) { if (ticket === previewRequest.current) setPreviewError('预览失败：' + e.message + '；若后端仍为旧版，请重载插件后重试。'); }
      finally { if (ticket === previewRequest.current) setPreviewBusy(false); }
    };

    const viewFile = useCallback((path) => {
      setBusy(true);
      setNotice({ kind: "busy", text: "读取中…" });
      const q = "path=" + encodeURIComponent(path) + (panelWs ? "&workspace=" + encodeURIComponent(panelWs) : "");
      fetch("/api/wb-memory/file?" + q, { cache: "no-store" })
        .then(readJson)
        .then((d) => {
          if (d.error) {
            setNotice({ kind: "error", text: "读取失败：" + d.error });
          } else {
            setViewing({ path: d.path || path, content: d.content || "" });
            setNotice({ kind: "idle", text: "" });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "读取失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [panelWs]);

    const delFile = useCallback((path) => {
      if (!window.confirm('将记忆文件 "' + path + '" 移入回收站（.trash/，可回滚）？')) return;
      setBusy(true);
      setNotice({ kind: "busy", text: "删除中…" });
      const q = "path=" + encodeURIComponent(path) + (panelWs ? "&workspace=" + encodeURIComponent(panelWs) : "");
      fetch("/api/wb-memory/file?" + q, { method: "DELETE" })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setNotice({ kind: "ok", text: "已移入回收站：" + path + (d.trashedTo ? "（" + d.trashedTo + "）" : "") });
            refresh();
          } else {
            setNotice({ kind: "error", text: "删除失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "删除失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [panelWs, refresh]);

    const createFile = useCallback(() => {
      const fname = (newFileName || "").trim();
      if (!/^[\w\u4e00-\u9fa5.\-]+\.md$/.test(fname)) {
        setNotice({ kind: "error", text: "文件名不合法：仅允许 中文/字母/数字/下划线/连字符/点，且以 .md 结尾。" });
        return;
      }
      if (files.some((f) => f.path === fname)) {
        if (!window.confirm('文件 "' + fname + '" 已存在，覆盖写入？')) return;
      }
      setBusy(true);
      setNotice({ kind: "busy", text: "写入中…" });
      fetch("/api/wb-memory/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: fname, content: newFileBody, workspace: panelWs || undefined }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
            setNotice({ kind: "ok", text: "已写入：" + fname });
            setNewFileOpen(false);
            setNewFileName("");
            setNewFileBody("");
            refresh();
          } else {
            setNotice({ kind: "error", text: "写入失败：" + (d.error || "未知错误") });
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "写入失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [newFileName, newFileBody, files, refresh, panelWs]);

    const doSearch = useCallback(() => {
      const q = searchQ.trim();
      if (!q) { setSearchResults([]); setSearchDone(false); return; }
      setBusy(true);
      setNotice({ kind: "busy", text: "检索中…" });
      // G8：日期范围（可选）拼入查询；G5：显式带 workspace 对齐 panelWs 口径
      const params = new URLSearchParams({ q });
      if (panelWs) params.set("workspace", panelWs);
      if (searchDateFrom) params.set("date_from", searchDateFrom);
      if (searchDateTo) params.set("date_to", searchDateTo);
      fetch("/api/wb-memory/search?" + params.toString(), { cache: "no-store" })
        .then(readJson)
        .then((d) => {
          setSearchResults(d.results || []);
          setSearchDone(true);
          setNotice({ kind: "idle", text: "" });
        })
        .catch((e) => setNotice({ kind: "error", text: "检索失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [searchQ, searchDateFrom, searchDateTo, panelWs]);

    const doGc = useCallback(() => {
      if (!window.confirm("对该工作区执行治理：① 归档超过保留期的每日日志到 archive/ ② MEMORY.md 超阈值则备份到 archive/ 并提示 ③ 近重复条目检测（只报告不合并） ④ 真删 .trash/ 与 archive/ 中超过保留期的文件（不可恢复）。继续？")) return;
      setBusy(true);
      setNotice({ kind: "busy", text: "治理中…" });
      fetch("/api/wb-memory/gc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(panelWs ? { workspace: panelWs } : {}) })
        .then(readJson)
        .then((d) => {
          if (d.ok === false && d.skipped) {
            setNotice({ kind: "error", text: "已跳过：" + d.skipped });
          } else if (d.error) {
            setNotice({ kind: "error", text: "失败：" + d.error });
          } else {
            const lg = d.logGc || {};
            const mc = d.memCheck || {};
            const parts = [];
            if (lg.moved && lg.moved.length) parts.push("归档 " + lg.moved.length + " 个过期日志到 archive/：" + lg.moved.join(", "));
            else parts.push("无过期日志需归档");
            if (mc.over) parts.push("MEMORY.md " + mc.size + " 字超阈值 " + mc.threshold + "，已备份到 archive/，建议整理");
            else if (mc.exists) parts.push("MEMORY.md " + mc.size + " 字，未超阈值");
            const dc = d.dupCheck || {};
            if (dc.pairs && dc.pairs.length) parts.push("疑似重复 " + dc.pairs.length + " 对（建议合并）：" + dc.pairs.map((p) => p.a + " ↔ " + p.b + " (" + p.sim + ")").join("、"));
            else parts.push("无疑似重复条目");
            const tg = d.trashGc || {};
            if (!tg.disabled) {
              if (tg.cleaned > 0) parts.push("回收站清理 " + tg.cleaned + " 项（超 " + (tg.retentionDays || 30) + " 天已真删）");
              else parts.push("回收站无超期项（超 " + (tg.retentionDays || 30) + " 天自动真删）");
            }
            const ag = d.archiveGc || {};
            if (!ag.disabled) {
              if (ag.cleaned > 0) parts.push("归档清理 " + ag.cleaned + " 个文件（超 " + (ag.retentionDays || 365) + " 天已真删）");
              else parts.push("归档无超期项（超 " + (ag.retentionDays || 365) + " 天自动真删）");
            }
            setNotice({ kind: "ok", text: parts.join("；") });
            refresh();
          }
        })
        .catch((e) => setNotice({ kind: "error", text: "失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [refresh, panelWs]);

    const rows = files.map((f) =>
      h("li", {
        key: f.path,
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "8px 10px",
          border: "1px solid rgba(128,128,128,0.2)",
          borderRadius: "6px",
          marginBottom: "6px",
        },
      },
        h("div", { style: { minWidth: 0 } },
          h("div", { style: { fontSize: "13px", fontWeight: 500, wordBreak: "break-all" } },
            f.path,
            // G9：置顶记忆身份标识（绿色 pill，同「已启用」色系）
            f.path === "PINNED.md" ? h("span", { style: { marginLeft: "6px", padding: "1px 7px", borderRadius: "9px", fontSize: "10px", fontWeight: 500, color: "#3dd68c", border: "1px solid rgba(61,214,140,0.4)", background: "rgba(61,214,140,0.12)", verticalAlign: "1px" } }, "置顶") : null,
          ),
          h("div", { style: { fontSize: "11px", opacity: 0.6, marginTop: "3px" } },
            "生成 " + fmtTime(f.created) + " · 修改 " + fmtTime(f.modified) + (f.size != null ? " · " + fmtSize(f.size) : "")),
        ),
        h("div", { style: { display: "flex", gap: "6px", flexShrink: 0 } },
          h("button", {
            onClick: () => viewFile(f.path),
            disabled: busy,
            style: BTN_STYLE,
          }, "查看"),
          h("button", {
            onClick: () => delFile(f.path),
            disabled: busy,
            style: BTN_DANGER,
          }, "删除（回收站）"),
        ),
      )
    );

    // ---- C1 状态条数据派生 ----
    const st = status && status.resolvedWorkspace ? status : null;
    const memRatio = st && st.memory && st.memory.threshold ? st.memory.chars / st.memory.threshold : 0;
    const memBadge = !st || !st.memory ? null
      : memRatio >= 1 ? { c: "#e5484d", t: "超限" }
      : memRatio >= 0.8 ? { c: "#e5a548", t: "接近阈值" }
      : { c: "#3dd68c", t: "正常" };
    const pendBadge = st && st.distill && st.distill.pendingDates > 7 ? { c: "#e5a548", t: "积压" } : null;
    // G4：compact 徽章细分——F2 带警告接受（琥珀「带警告」）/ 第 2 轮成功（文案标注轮次）
    const compBadge = st && st.compact
      ? (st.compact.lastOk
          ? (st.compact.warnings ? { c: "#e5a548", t: "带警告" } : { c: "#3dd68c", t: st.compact.rounds === 2 ? "成功·第 2 轮" : "成功" })
          : { c: "#e5484d", t: "失败" })
      : null;
    // G6：今日小结接近上限提示（≥max-2 视为接近）
    const sumBadge = st && st.summary && st.summary.max > 0 && st.summary.count >= st.summary.max - 2
      ? { c: "#e5a548", t: "接近上限" }
      : null;
    // G1：值不折行（数字中间断行是视觉缺陷）；窄格由 grid 整体换行兜底
    const metric = (label, value, badge, title) =>
      h("div", { style: { padding: "8px 10px", minWidth: 0, overflow: "hidden" }, title: title || undefined },
        h("div", { style: { fontSize: "11px", opacity: 0.75, whiteSpace: "nowrap" } }, label),
        h("div", { style: { fontSize: "22px", fontVariantNumeric: "tabular-nums", marginTop: "6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, value),
        badge ? h("div", { style: { fontSize: "10px", marginTop: "2px", color: badge.c, whiteSpace: "nowrap" } }, badge.t) : null,
      );

    // ---- C2 子开关 ----
    const subSwitch = (label, on, onToggle, tip) =>
      h("label", { style: { display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", paddingLeft: "4px" }, title: tip },
        h("input", { type: "checkbox", checked: on, disabled: busy || !enabled, onChange: onToggle, style: { width: "15px", height: "15px" } }),
        h("span", null, label));
    const chipStyle = {
      display: "inline-flex", alignItems: "center", gap: "8px", padding: "5px 14px",
      borderRadius: "14px", cursor: "pointer", fontSize: "13px", fontWeight: 500,
      border: "1px solid " + (enabled ? "rgba(61,214,140,0.4)" : "rgba(128,128,128,0.35)"),
      background: enabled ? "rgba(61,214,140,0.15)" : "transparent",
    };

    const inputStyle = {
      padding: "6px 10px", fontSize: "13px", borderRadius: "6px",
      border: "1px solid rgba(128,128,128,0.35)", background: "transparent", color: "inherit",
    };
    const selectStyle = {
      ...inputStyle, width: "100%", maxWidth: "420px", padding: "7px 10px",
    };

    const reasonLabels = { 'selected': '排序入选', 'no-match': '没有命中', 'weak-single': '仅弱单字命中', 'low-idf': '区分度不足', 'relative-floor': '低于相对门槛', 'top-k': '超过条数上限', 'empty-query': '无有效查询词', 'date-filter': '日期筛除', 'superseded': '已被替代', 'retracted': '已撤回', 'invalid-metadata': '管理元数据无效' };
    const modeLabels = { relevant: '相关条目', 'fallback-summary': '无相关项，回退摘要', 'no-query': '无查询，使用摘要', 'no-memory': '无长期记忆正文', summary: '摘要' };
    const recallView = (r, isPreview) => !r
      ? h('div', { className: 'wb-empty' }, isPreview ? '输入问题，查看当前长期记忆的筛选与预算分配。' : '暂无记录。重载后在该工作区发起一轮对话，再刷新查看；历史记录不会补造。')
      : h('div', null,
        h('div', { className: 'wb-meta' }, (isPreview ? '手动预览' : '实际系统提示组装') + ' · ' + fmtTime(r.at) + ' · ' + (modeLabels[r.mode] || r.mode)),
        h('div', { className: 'wb-flow' },
          metric('候选条目', r.total, null), metric('排序入选', r.selected, null),
          metric('有相关标题的片段', (r.entries || []).filter(e => e.present).length, null),
          metric('最终组装 / 上限', r.blockChars + ' / ' + r.limitChars, null, '字符估计，包含画像、置顶、摘要、日志与纪律；非token数')),
        h('p', { className: 'wb-meta' }, '查询长度 ' + r.queryChars + ' 字符 · 有效词 ' + r.queryTokens + ' · ' + (r.globalTrimmed ? '最终总预算发生裁剪' : '未触发最终总预算裁剪')),
        h('div', { className: 'wb-tags' }, Object.entries(r.counts || {}).map(([key, count]) => h('span', { key, className: 'wb-tag' }, (reasonLabels[key] || key) + ' ' + count))),
        (r.candidates || []).length ? h('div', { className: 'wb-table-wrap' }, h('table', { className: 'wb-table' },
          h('thead', null, h('tr', null, h('th', null, '记忆条目'), h('th', null, '评分 / 相对分'), h('th', null, '筛选结果'))),
          h('tbody', null, r.candidates.map((row, i) => h('tr', { key: i },
            h('td', null, row.title), h('td', null, Number(row.score || 0).toFixed(2) + ' / ' + (row.rel == null ? '—' : Number(row.rel).toFixed(2))),
            h('td', null, h('span', { className: 'wb-tag ' + (row.reason === 'selected' ? 'wb-selected' : '') }, reasonLabels[row.reason] || row.reason))))))) : null,
        crossLayerView(r.crossLayer, isPreview),
        r.omitted ? h('p', { className: 'wb-meta' }, '另有 ' + r.omitted + ' 条未展开，总计仍包含这些条目。') : null,
        (r.entries || []).length ? h('details', { className: 'wb-budget' }, h('summary', null, '条目字符预算与裁剪'),
          r.entries.map((e, i) => h('p', { key: i, className: 'wb-meta' }, e.title + ' · 正文 ' + e.bodyChars + ' · 分配 ' + e.cap + ' · ' + (e.present ? '最终文本含该标题' : '片段未进入最终文本') + (e.truncated ? ' · 正文按预算截断' : '') + (e.finalFitMayTrim ? ' · 最终全局裁剪，请勿据标题推定正文完整' : '')))) : null,
      );
    const tabs = [['overview', '总览', '01'], ['recall', '召回诊断', '02'], ['files', '记忆文件', '03'], ['automation', '自动化与治理', '04']];
    return h('div', { className: 'wb-hub', 'data-wb-revision': 'panel-recall-1' },
      h('style', null, SPIN_CSS + HUB_CSS),
      h('header', { className: 'wb-header' },
        h('div', null, h('div', { className: 'wb-eyebrow' }, 'WORKBUDDY / MEMORY'), h('h2', null, '让有用的经验，留在下一次对话'), h('p', { className: 'wb-meta' }, '文件化记忆工作台 · 纯 Markdown · 无向量库')),
        h('button', { style: BTN_STYLE, onClick: refresh, disabled: busy }, '刷新状态')),
      h('div', { className: 'wb-scope' }, h('span', { className: 'wb-tag ' + (enabled ? 'wb-selected' : '') }, enabled ? '记忆已启用' : '记忆已关闭'), h('span', null, '当前工作区：' + (st?.resolvedWorkspace || panelWs || '未解析')), h('span', { className: 'wb-meta' }, status?.runtimeRevision || '后端未连接')),
      h('nav', { className: 'wb-nav', 'aria-label': '记忆管理分区' }, tabs.map(([id, label, num]) => h('button', { key: id, type: 'button', 'aria-current': section === id ? 'page' : undefined, className: section === id ? 'active' : '', onClick: () => setSection(id) }, h('span', null, num), label))),
      h('div', { role: notice.kind === 'error' ? 'alert' : 'status', 'aria-live': 'polite' },
      notice.kind === "busy"
        ? h("p", { style: { opacity: 0.75, fontSize: "13px", margin: "6px 0", display: "flex", alignItems: "center", gap: "6px" } },
            h("span", { style: SPINNER }), notice.text)
        : notice.kind === "ok"
          ? h("p", { style: { color: "inherit", opacity: 0.85, fontSize: "13px", margin: "6px 0" } }, notice.text)
          : notice.kind === "error"
            ? h("p", { style: { color: "#e5484d", fontSize: "13px", margin: "6px 0" } }, notice.text)
            : null,


      ),
      !loaded ? h('div', { className: 'wb-empty', role: 'status' }, '正在连接记忆工作台…') : h('div', null,
        h('section', { hidden: section !== 'overview', 'aria-label': '总览' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '记忆概况'), h('span', { className: 'wb-meta' }, '先看状态，再处理需要关注的事项')),
          // C1 状态指标条（G1：grid 自适应换行，7 格不再互相挤压；格线用 gap 1px）
          h("div", {
            style: {
              display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "8px",
              margin: "10px 0",
              border: "1px solid rgba(128,128,128,0.15)", borderRadius: "8px", overflow: "hidden",
            },
          },
            metric("记忆占用", st && st.memory ? st.memory.chars + "/" + st.memory.threshold : "—", memBadge,
              st && st.memory ? "MEMORY.md 字符数/容量阈值（memoryCharThreshold）" : undefined),
            metric("条目数", st && st.memory ? String(st.memory.entries) : "—", null, "MEMORY.md 条目（## 计数）"),
            metric("今日流水", st && st.digest ? st.digest.count + "/" + st.digest.max : "—", null, "今日日志【自动】流水行数/每日上限"),
            metric("今日小结", st && st.summary ? st.summary.count + "/" + st.summary.max : "—", sumBadge, "今日日志「会话小结」段数/每日上限（G6 新增）"),
            metric("置顶", st && st.pinned ? st.pinned.lines + " 条" : "—", null, "PINNED.md 非空行数（全量注入、不参与整理与治理）"),
            metric("待提炼", st && st.distill ? String(st.distill.pendingDates) : "—", pendBadge, "尚未提炼的历史日志天数（含归档）"),
            metric("上次整理",
              st && st.compact ? ((st.compact.lastOk ? "✓ " : "✗ ") + String(st.compact.lastDay || "").slice(5)) : (st ? "未运行" : "—"),
              compBadge,
              st && st.compact
                ? "结果：" + (st.compact.lastOk ? "成功" : "失败" + (st.compact.failedCheck ? "（未过项：" + st.compact.failedCheck + "）" : "")) +
                  (st.compact.rounds === 2 ? " · 第 2 轮（首轮未过带反馈重写）" : "") +
                  " · " + (st.compact.before != null ? st.compact.before + " → " + (st.compact.after != null ? st.compact.after : "?") + " 字符" : "") +
                  (st.compact.warnings ? " · 警告：" + st.compact.warnings : "") +
                  (st.compact.retryError ? " · 重试异常：" + st.compact.retryError : "")
                : "MEMORY.md 超阈值时的 LLM 整理（compact），尚未运行过"),
          ),


          h('div', { className: 'wb-attention' }, !enabled ? '记忆总开关已关闭，注入与自动化已暂停。' : !st ? '尚未解析到工作区。请在下方选择，或从工作区发起对话。' : st.compact && !st.compact.lastOk ? '上次整理未通过，请在自动化与治理中检查配置与原因。' : st.distill?.pendingDates ? '有 ' + st.distill.pendingDates + ' 天历史日志待提炼；自动巡检将按调度处理。' : '当前没有待提炼历史日志。运行结果以实际记录为准。'),
          // 激活工作区卡片（含 C3 影响范围）
          h("div", { style: CARD_STYLE },
            h("div", { style: { fontSize: "13px", fontWeight: 500 } }, "激活工作区"),
            h("p", { style: { fontSize: "11px", opacity: 0.6, margin: "4px 0 8px", lineHeight: 1.5 } },
              "按工作区名读写其记忆；「自动匹配」按会话目录解析。"),
            h("select", {
              value: activeProject || "",
              disabled: busy || !enabled,
              onChange: (e) => selectProject(e.target.value),
              style: selectStyle,
            },
              h("option", { value: "" }, "自动匹配（按会话目录，未命中则仅全局）"),
              ...workspaces.map((p) => h("option", { key: p, value: p }, p)),
            ),
            h("p", { style: { fontSize: "11px", opacity: 0.75, margin: "6px 0 0", lineHeight: 1.5 } },
              activeProject
                ? "→ 已锁定：" + activeProject + "（文件与检索优先按此工作区）"
                : "→ 将作用于（自动匹配）：" + (st ? st.resolvedWorkspace : "未解析（仅全局画像）"),
              h("br"),
              "cwd: " + ((status && status.cwd) || "—") + (status && status.cwdMatched ? " · cwd 已命中" : " · cwd 未命中")),
          ),


          h('div', { className: 'wb-quick' }, h('button', { style: BTN_PRIMARY, onClick: () => setSection('recall') }, '检查召回过程'), h('button', { style: BTN_STYLE, onClick: () => setSection('files') }, '浏览记忆文件')),
        ),
        h('section', { hidden: section !== 'recall', 'aria-label': '召回诊断' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '为什么选中了这条记忆？')),
          h('p', { style: CALLOUT_INFO }, '只观察，不改变排名。排序入选 ≠ 最终完整注入 ≠ 模型采用。相对分是 score / top，不是置信概率。候选排名仅针对 MEMORY.md；下方跨层诊断另行检查日志、画像与置顶，不改变排名。'),
          h('div', { style: CARD_STYLE }, h('h4', null, '最近一次实际组装'), recallView(st?.recall, false)),
          h('div', { style: CARD_STYLE }, h('h4', null, '手动预览'), h('p', { className: 'wb-meta' }, '使用当前文件和预算模拟；不调用模型、不写记忆，也不覆盖实际组装记录。关闭记忆时仍可模拟，但不会自动注入。'),
            h('form', { className: 'wb-preview-form', onSubmit: e => { e.preventDefault(); if (!previewBusy && previewQ.trim() && panelWs) runPreview(); } },
              h('input', { 'aria-label': '预览查询', placeholder: '例如：发布失败后该如何回滚？', value: previewQ, maxLength: 4000, onChange: e => setPreviewQ(e.target.value), style: { ...inputStyle, flex: 1, minWidth: 0 }, disabled: !panelWs }),
              h('button', { style: BTN_PRIMARY, disabled: previewBusy || !panelWs || !previewQ.trim() }, previewBusy ? '分析中…' : '预览召回')),
            previewError ? h('p', { role: 'alert', className: 'wb-error' }, previewError) : recallView(preview, true)),
          section === 'recall' ? h(RecallEvalPanel) : null,
        ),
        h('section', { hidden: section !== 'files', 'aria-label': '记忆文件' },
          section === 'files' && panelWs ? h(MemoryLifecyclePanel, { key: panelWs, workspace: panelWs, onChanged: () => { fetchStatus(panelWs); fetchFiles(panelWs); } }) : null,
      // 记忆文件（C7 新建入口；G5：跟随 panelWs——cwd 自动命中时不再「让选人」）
      h("div", { style: { marginTop: "10px" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "10px" } },
          h("strong", { style: { fontSize: "13px" } },
            "记忆文件" + (panelWs ? "（工作区：" + panelWs + (files.length ? " · " + files.length : "") + (panelWs !== activeProject ? " · 自动匹配" : "") + "）" : "")),
          panelWs
            ? h("button", { onClick: () => { setNewFileOpen(!newFileOpen); setNotice({ kind: "idle", text: "" }); }, disabled: busy, style: BTN_STYLE },
                newFileOpen ? "收起新建" : "新建")
            : h("span", { style: { opacity: 0.6, fontSize: "12px" } }, "删除即移入回收站"),
        ),
        newFileOpen && panelWs
          ? h("div", { style: { marginTop: "8px", padding: "8px", border: "1px dashed rgba(128,128,128,0.35)", borderRadius: "6px" } },
              h("input", {
                type: "text", value: newFileName,
                onChange: (e) => setNewFileName(e.target.value),
                placeholder: "文件名，如 PINNED.md（置顶记忆，全量注入）或 notes.md；写入当前工作区 .workbuddy/memory/",
                style: { ...inputStyle, width: "100%", marginBottom: "6px" },
              }),
              h("textarea", {
                value: newFileBody,
                onChange: (e) => setNewFileBody(e.target.value),
                placeholder: "Markdown 正文",
                style: { ...inputStyle, width: "100%", height: "80px", resize: "vertical", boxSizing: "border-box", marginBottom: "6px" },
              }),
              h("div", { style: { display: "flex", gap: "6px" } },
                h("button", { onClick: createFile, disabled: busy, style: BTN_PRIMARY }, "保存"),
                h("button", { onClick: () => { setNewFileOpen(false); setNewFileName(""); setNewFileBody(""); }, disabled: busy, style: BTN_STYLE }, "取消"),
              ),
            )
          : null,
        panelWs
          ? (files.length
            ? h("ul", {
              style: { listStyle: "none", padding: 0, margin: "8px 0 0", maxHeight: "340px", overflow: "auto" },
            }, rows)
            : h("p", { style: { opacity: 0.6, fontSize: "12px", marginTop: "8px" } }, "工作区「" + panelWs + "」的 .workbuddy/memory/ 下暂无记忆文件。"))
          : h("p", { style: { opacity: 0.6, fontSize: "12px", marginTop: "8px" } }, "请先在「激活工作区」选择一个工作区（或让会话 cwd 命中某工作区），即可查看 / 管理该工作区的记忆文件。"),
      ),
      viewing
        ? h("div", { style: { marginTop: "10px", padding: "10px", border: "1px solid rgba(128,128,128,0.25)", borderRadius: "6px" } },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px", gap: "8px" } },
            h("strong", { style: { fontSize: "13px", wordBreak: "break-all" } }, "查看：" + viewing.path),
            h("button", { onClick: () => setViewing(null), style: { ...BTN_STYLE, flexShrink: 0 } }, "关闭"),
          ),
          h("pre", { style: { margin: 0, maxHeight: "320px", overflow: "auto", fontSize: "12px", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, viewing.content || "（空文件）"),
        )
        : null,


        ),
        h('section', { hidden: section !== 'automation', 'aria-label': '自动化与治理' },
          h('div', { className: 'wb-section-head' }, h('h3', null, '自动化与治理'), h('span', { className: 'wb-meta' }, '更改开关与模型前，请确认影响范围')),
          // C2 总控卡片
          h("div", { style: CARD_STYLE },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" } },
              h("div", { style: { fontSize: "13px", fontWeight: 500 } }, "总控"),
              h("button", { onClick: toggle, disabled: busy, style: chipStyle, title: "记忆总开关：关闭后停止注入与全部自动化" },
                h("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: enabled ? "#3dd68c" : "rgba(128,128,128,0.6)" } }),
                enabled ? "已启用" : "已关闭"),
            ),
            h("p", { style: { fontSize: "11px", opacity: 0.6, margin: "6px 0 0", lineHeight: 1.5 } },
              "总开关控制记忆注入与以下全部自动化子开关。"),
            h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px", opacity: enabled ? 1 : 0.4 } },
              // G7：开关按「自动化 / 工具 / 参数」分组，替代扁平列表
              h("div", { style: { fontSize: "11px", opacity: 0.55, marginTop: "2px" } }, "自动化"),
              subSwitch("自动流水", autoDigest, toggleDigest, "每轮对话完成后自动在当日日志追加一条简短流水"),
              subSwitch("会话小结", sessionSummary, toggleSummary, "会话空闲 10 分钟后 LLM 小结（150-300 字，含决策理由与未竟事项）写入当日日志。需提炼模型；短会话与每日上限（8 次）自动跳过"),
              subSwitch("自动提炼（含超阈值整理）", autoDistill, toggleDistill, "巡检把昨天及更早的日志提炼进 MEMORY.md；超阈值时自动整理。需已配置提炼模型"),
              subSwitch("治理", gcEnabled, toggleGc, "「治理」按钮可用性：归档超保留期日志、近重复检测、回收站/归档超期清理"),
              h("div", { style: { fontSize: "11px", opacity: 0.55, marginTop: "6px" } }, "工具"),
              subSwitch("记忆检索工具", memorySearchTool, toggleSearchTool, "注册 memory_search 原生工具：agent 按关键词检索长期记忆与近期日志（改动需重启/重载生效）"),
              h("div", { style: { fontSize: "11px", opacity: 0.55, marginTop: "6px" } }, "参数"),
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "6px 0" } },
                h("div", { style: { fontSize: "12px" } },
                  h("span", null, "逻辑日分界"),
                  h("div", { style: { fontSize: "11px", opacity: 0.6, marginTop: "2px" } }, "凌晨 N 点前的活动归入前一天日志（匹配深夜作息）；选 0 点按自然日切分")),
                h("select", {
                  value: String(dayBoundaryHour),
                  disabled: busy || !enabled,
                  onChange: (e) => changeDayBoundary(e.target.value),
                  style: Object.assign({}, selectStyle, { width: "auto", minWidth: "72px" }),
                },
                  // 审查 S3：与后端白名单（0-23）对齐，避免手改 config 后下拉失配
                  ...Array.from({ length: 24 }, (_, n) => n).map((n) => h("option", { key: n, value: String(n) }, n + " 点" + (n === 4 ? "（默认）" : ""))),
                ),
              ),
            ),
            !enabled ? h("p", { style: { fontSize: "11px", color: "#e5a548", margin: "6px 0 0" } }, "⚠ 总开关关闭，以下全部停用") : null,
          ),


          // 自动提炼卡片（含 C4 callout）
          h("div", { style: CARD_STYLE },
            h("div", { style: { fontSize: "13px", fontWeight: 500 } }, "自动提炼"),
            h("p", { style: { fontSize: "11px", opacity: 0.6, margin: "4px 0 8px", lineHeight: 1.5 } },
              "auto-distill：每小时巡检把「昨天及更早」的每日日志经该模型提炼为带 frontmatter 的条目，追加进对应工作区 MEMORY.md；选「清空」则暂停（流水不受影响）。"),
            h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
              h("select", {
                value: distillRoute,
                disabled: busy || !enabled,
                onChange: (e) => selectDistillRoute(e.target.value),
                style: { ...selectStyle, flex: 1, minWidth: "260px" },
              },
                h("option", { value: "" }, distillRoute ? "（清空——暂停提炼）" : "（未配置——提炼未启用）"),
                ...llmProviders.map((p) =>
                  h("optgroup", { key: p.id, label: p.id },
                    (p.models || []).map((m) =>
                      h("option", { key: p.id + "::" + m.id, value: p.id + "::" + m.id }, (m.name || m.id)),
                    ),
                  ),
                ),
              ),
              h("button", { onClick: runDistillNow, disabled: busy || !enabled || !distillRoute, style: BTN_PRIMARY }, "立即提炼"),
            ),
            !llmProviders.length && modelsNote
              ? h("p", { style: { fontSize: "11px", color: "#e5a548", margin: "6px 0 0" } }, "⚠ " + modelsNote)
              : null,
            h("p", { style: CALLOUT_WARN }, "约束：提炼按（工作区, 日期）幂等；与既有条目近重复（相似度 ≥ dupThreshold）的新条目会被幂等护栏直接丢弃。"),
            h("details", { style: { margin: "6px 0 0" } },
              h("summary", { style: { fontSize: "11px", opacity: 0.75, cursor: "pointer", userSelect: "none" } }, "建议（点开查看）"),
              h("p", { style: CALLOUT_INFO }, "提炼是分类抽取任务，flash 级小模型通常够用；若发现提炼质量不稳，再换指令遵循更强的模型。"),
            ),
          ),

          // 自动整理卡片（含 C4 callout）
          h("div", { style: CARD_STYLE },
            h("div", { style: { fontSize: "13px", fontWeight: 500 } }, "自动整理"),
            h("p", { style: { fontSize: "11px", opacity: 0.6, margin: "4px 0 8px", lineHeight: 1.5 } },
              "auto-compact：巡检发现 MEMORY.md 超容量阈值时，先备份到 archive/ 再由该模型合并重复、精炼表述。目标字符数按上次实测超幅自适应调整。"),
            h("select", {
              value: compactRoute,
              disabled: busy || !enabled,
              onChange: (e) => selectCompactRoute(e.target.value),
              style: selectStyle,
            },
              h("option", { value: "" }, compactRoute ? "（恢复默认——跟随提炼模型）" : "（默认——跟随提炼模型）"),
              ...llmProviders.map((p) =>
                h("optgroup", { key: "c-" + p.id, label: p.id },
                  (p.models || []).map((m) =>
                    h("option", { key: "c-" + p.id + "::" + m.id, value: p.id + "::" + m.id }, (m.name || m.id)),
                  ),
                ),
              ),
            ),
            h("p", { style: CALLOUT_WARN }, "约束：必须变短且非空；首轮校验（变短/压回阈值/条目数过半）未过会带具体差距同轮重写一轮，第二轮仍硬性要求变短非空、条目数至少保留一半；超容量阈值可带警告接受；两轮算一次尝试，每天每工作区至多一次。带警告接受时状态条「上次整理」显示琥珀色「带警告」徽章。"),
            h("details", { style: { margin: "6px 0 0" } },
              h("summary", { style: { fontSize: "11px", opacity: 0.75, cursor: "pointer", userSelect: "none" } }, "建议（点开查看）"),
              h("p", { style: CALLOUT_INFO }, "整理需严格遵守条目数下限，flash 级小模型易违规被拒——建议配指令遵循更强的模型（如 glm-5.3；显式配置时自动压低思考档）。"),
            ),
          ),

      // C6 检索 / 治理（G5：跟随 panelWs；G8：日期范围过滤；G10：治理按钮中性色——
      // 治理全程可回滚/有确认，红色应留给真破坏性动作）
      h("div", { style: { marginTop: "12px", padding: "10px", border: "1px solid rgba(128,128,128,0.2)", borderRadius: "6px" } },
        h("strong", { style: { fontSize: "13px" } }, "检索与维护"),
        h("div", { style: { display: "flex", gap: "8px", margin: "8px 0", flexWrap: "wrap", alignItems: "center" } },
          h("input", {
            type: "text",
            value: searchQ,
            onChange: (e) => setSearchQ(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") doSearch(); },
            disabled: busy || !panelWs,
            placeholder: "关键词召回相关记忆条目（可按日期范围过滤）",
            style: { ...inputStyle, flex: 1, minWidth: "180px" },
          }),
          h("input", {
            type: "date", value: searchDateFrom,
            onChange: (e) => setSearchDateFrom(e.target.value),
            disabled: busy || !panelWs,
            title: "起始日期（含），过滤条目 frontmatter date",
            style: { ...inputStyle, width: "auto" },
          }),
          h("span", { style: { opacity: 0.5, fontSize: "12px" } }, "至"),
          h("input", {
            type: "date", value: searchDateTo,
            onChange: (e) => setSearchDateTo(e.target.value),
            disabled: busy || !panelWs,
            title: "结束日期（含），过滤条目 frontmatter date",
            style: { ...inputStyle, width: "auto" },
          }),
          h("button", { onClick: doSearch, disabled: busy || !panelWs, style: BTN_PRIMARY }, "检索"),
          h("button", {
            onClick: doGc,
            disabled: busy || !panelWs || !gcEnabled,
            style: BTN_STYLE,
            title: gcEnabled
              ? "归档过期日志 + 容量检测 + 近重复检测 + 回收站/归档超期清理（有确认）"
              : "治理已关闭（总控中的「治理」开关）",
          }, "治理"),
        ),
        !panelWs
          ? h("p", { style: { opacity: 0.6, fontSize: "11px", margin: "6px 0 0" } }, "↑ 请先在「激活工作区」选择一个工作区（或让会话 cwd 命中某工作区）")
          : null,
        searchDone ? (searchResults.length
          ? h("ul", { style: { listStyle: "none", padding: 0, margin: "6px 0 0" } },
            searchResults.map((r) => h("li", { key: r.title, style: { padding: "6px 0", borderBottom: "1px solid rgba(128,128,128,0.15)" } },
              h("div", { style: { fontSize: "13px", fontWeight: 500 } }, r.title + (r.tags && r.tags.length ? " [" + r.tags.join(",") + "]" : "")),
              h("div", { style: { fontSize: "12px", opacity: 0.7, marginTop: "2px", whiteSpace: "pre-wrap" } }, r.body.slice(0, 200) + (r.body.length > 200 ? "…" : "")),
            ))
          )
          : h("p", { style: { opacity: 0.6, fontSize: "12px", margin: "6px 0 0" } }, "无相关条目")
        ) : null,
      ),

        ),
      ),
      h('footer', { className: 'wb-meta wb-footer' }, '记忆存于各工作区 .workbuddy/memory/；画像在插件目录。诊断仅保留每工作区最近一次组装，重载后清空，不保存原始查询或正文。'),
    );
  }

  function apply(ctx) {
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "wb-memory",
      order: 30,
      label: () => "WorkBuddy 记忆",
    }, () => h(WBMemorySection, null)));
  }

  exports.name = name;
  exports.inject = inject;
  exports.apply = apply;
  return module.exports;
}
});
