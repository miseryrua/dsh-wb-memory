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
  const { useState, useEffect, useCallback } = react;

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
  const BTN_PRIMARY = { ...BTN_STYLE, background: "rgba(61,214,140,0.12)", borderColor: "rgba(61,214,140,0.4)" };
  const BTN_DANGER = { ...BTN_STYLE, color: "#e5484d", borderColor: "rgba(229,72,77,0.4)" };

  // 分组卡片（C5）
  const CARD_STYLE = {
    border: "1px solid rgba(128,128,128,0.15)",
    borderRadius: "8px",
    padding: "12px 14px",
    marginBottom: "10px",
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

  function WBMemorySection() {
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
    const [status, setStatus] = useState(null); // GET /wb-memory/status 响应
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
      const q = ws ? "?workspace=" + encodeURIComponent(ws) : "";
      fetch("/wb-memory/files" + q, { cache: "no-store" })
        .then(readJson)
        .then((d) => { setFiles(d.files || []); setFileWorkspace(d.workspace || null); })
        .catch(() => {});
    }, []);

    const fetchStatus = useCallback((ws) => {
      const q = ws ? "?workspace=" + encodeURIComponent(ws) : "";
      fetch("/wb-memory/status" + q, { cache: "no-store" })
        .then(readJson)
        .then((d) => {
          setStatus(d);
          // G5：状态条已按 cwd 自动命中工作区时，文件区跟随同一工作区
          if (d.resolvedWorkspace && d.resolvedWorkspace !== ws) fetchFiles(d.resolvedWorkspace);
        })
        .catch(() => setStatus(null));
    }, [fetchFiles]);

    const refresh = useCallback(() => {
      fetch("/wb-memory/config", { cache: "no-store" })
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
      fetch("/wb-memory/workspaces", { cache: "no-store" })
        .then(readJson)
        .then((d) => setWorkspaces(d.workspaces || []))
        .catch(() => {});
      fetch("/wb-memory/models", { cache: "no-store" })
        .then(readJson)
        .then((d) => { setLlmProviders(d.providers || []); setModelsNote(d.note || ""); })
        .catch((e) => setModelsNote("读取可用模型列表失败：" + e.message + "（模型下拉框会因此为空）"));
    }, [fetchStatus, fetchFiles]);

    useEffect(() => { refresh(); }, [refresh]);

    const toggle = useCallback(() => {
      const next = !enabled;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, activeProject: v }),
      })
        .then(readJson)
        .then((d) => {
          if (d.ok) {
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
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/config", {
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
      fetch("/wb-memory/distill", { cache: "no-store" })
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

    const viewFile = useCallback((path) => {
      setBusy(true);
      setNotice({ kind: "busy", text: "读取中…" });
      const q = "path=" + encodeURIComponent(path) + (panelWs ? "&workspace=" + encodeURIComponent(panelWs) : "");
      fetch("/wb-memory/file?" + q, { cache: "no-store" })
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
      fetch("/wb-memory/file?" + q, { method: "DELETE" })
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
      fetch("/wb-memory/file", {
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
      fetch("/wb-memory/search?" + params.toString(), { cache: "no-store" })
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
      fetch("/wb-memory/gc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(panelWs ? { workspace: panelWs } : {}) })
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
        h("div", { style: { fontSize: "11px", opacity: 0.6, whiteSpace: "nowrap" } }, label),
        h("div", { style: { fontSize: "16px", marginTop: "2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, value),
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

    return h("div", { style: { maxWidth: "760px" } },
      h("style", null, SPIN_CSS),
      h("p", { style: { marginTop: 0, opacity: 0.75, fontSize: "13px", lineHeight: 1.6 } },
        "WorkBuddy 文件化记忆（v8）：画像 + 置顶 + 摘要/相关条目 + 今日日志 + 近 N 日回顾分层注入；流水 / 会话小结 / 提炼 / 整理 / 治理自动化闭环；memory_search 原生检索工具；纯 Markdown，无向量库。"),
      !loaded
        ? h("p", { style: { opacity: 0.6 } }, "加载中…")
        : h("div", null,
          // C1 状态指标条（G1：grid 自适应换行，7 格不再互相挤压；格线用 gap 1px）
          h("div", {
            style: {
              display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: "1px",
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
            h("p", { style: CALLOUT_WARN }, "约束：必须变短且非空；首轮校验（变短/压回阈值/条目数过半）未过会带具体差距同轮重写一轮，第二轮仅硬性要求变短非空、其余降为警告接受；两轮算一次尝试，每天每工作区至多一次。带警告接受时状态条「上次整理」显示琥珀色「带警告」徽章。"),
            h("details", { style: { margin: "6px 0 0" } },
              h("summary", { style: { fontSize: "11px", opacity: 0.75, cursor: "pointer", userSelect: "none" } }, "建议（点开查看）"),
              h("p", { style: CALLOUT_INFO }, "整理需严格遵守条目数下限，flash 级小模型易违规被拒——建议配指令遵循更强的模型（如 glm-5.3；显式配置时自动压低思考档）。"),
            ),
          ),
        ),
      notice.kind === "busy"
        ? h("p", { style: { opacity: 0.75, fontSize: "13px", margin: "6px 0", display: "flex", alignItems: "center", gap: "6px" } },
            h("span", { style: SPINNER }), notice.text)
        : notice.kind === "ok"
          ? h("p", { style: { color: "inherit", opacity: 0.85, fontSize: "13px", margin: "6px 0" } }, notice.text)
          : notice.kind === "error"
            ? h("p", { style: { color: "#e5484d", fontSize: "13px", margin: "6px 0" } }, notice.text)
            : null,

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

      // C6 检索 / 治理（G5：跟随 panelWs；G8：日期范围过滤；G10：治理按钮中性色——
      // 治理全程可回滚/有确认，红色应留给真破坏性动作）
      h("div", { style: { marginTop: "12px", padding: "10px", border: "1px solid rgba(128,128,128,0.2)", borderRadius: "6px" } },
        h("strong", { style: { fontSize: "13px" } }, "检索 / 治理"),
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
      h("p", { style: { opacity: 0.6, fontSize: "12px", marginTop: "8px" } }, "记忆目录：各 dsh 工作区的 <工作区>\\.workbuddy\\memory\\（全局画像在插件目录 dsh-wb-memory/USER.md，只读；候选信息按行追加到 USER-CANDIDATES.md）—— 纯 Markdown，可直接编辑或由 Agent 读写。归档在 archive/，回收站在 .trash/。"),
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
