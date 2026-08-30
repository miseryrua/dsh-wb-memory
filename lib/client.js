// dsh-wb-memory client bundle (v5): 状态条 + 总控分组卡片 + 检索/治理 + 文件管理。
// v5 变更：状态指标条（/wb-memory/status）、总闸+三子开关、影响范围显示、
// 立即提炼二次确认、提示分层 callout、分组卡片、检索/治理解除隐藏、新建文件、
// busy 反馈、按钮视觉体系；词汇统一：流水/提炼/整理/治理/画像。
window.__ModuleLoader__.load({ id: "dsh-wb-memory", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  let react = require("react");
  const h = react.createElement;
  const { useState, useEffect, useCallback } = react;

  const name = "wb-memory";
  const inject = ["slots"];

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
    const [newFileOpen, setNewFileOpen] = useState(false);
    const [newFileName, setNewFileName] = useState("");
    const [newFileBody, setNewFileBody] = useState("");

    const fetchStatus = useCallback((ws) => {
      const q = ws ? "?workspace=" + encodeURIComponent(ws) : "";
      fetch("/wb-memory/status" + q, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setStatus(d))
        .catch(() => setStatus(null));
    }, []);

    const refresh = useCallback(() => {
      fetch("/wb-memory/config", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          setEnabled(Boolean(d.enabled));
          setActiveProject(d.activeProject || null);
          setAutoDigest(d.autoDigest !== false);
          setAutoDistill(d.autoDistill !== false);
          setGcEnabled(d.gcEnabled !== false);
          setDistillRoute(d.distillProvider && d.distillModel ? d.distillProvider + "::" + d.distillModel : "");
          setCompactRoute(d.compactProvider && d.compactModel ? d.compactProvider + "::" + d.compactModel : "");
          setLoaded(true);
          fetchStatus(d.activeProject || null);
        })
        .catch(() => setLoaded(true));
      fetch("/wb-memory/files", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { setFiles(d.files || []); setFileWorkspace(d.workspace || null); })
        .catch(() => {});
      fetch("/wb-memory/workspaces", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setWorkspaces(d.workspaces || []))
        .catch(() => {});
      fetch("/wb-memory/models", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { setLlmProviders(d.providers || []); setModelsNote(d.note || ""); })
        .catch(() => {});
    }, [fetchStatus]);

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
        .then((r) => r.json())
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
        .then((r) => r.json())
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
        .then((r) => r.json())
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
        .then((r) => r.json())
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

    const selectProject = useCallback((value) => {
      const v = value || null;
      setBusy(true);
      setNotice({ kind: "busy", text: "保存配置中…" });
      fetch("/wb-memory/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, activeProject: v }),
      })
        .then((r) => r.json())
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
        .then((r) => r.json())
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
        .then((r) => r.json())
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
        .then((r) => r.json())
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

    const viewFile = useCallback((path) => {
      setBusy(true);
      setNotice({ kind: "busy", text: "读取中…" });
      fetch("/wb-memory/file?path=" + encodeURIComponent(path), { cache: "no-store" })
        .then((r) => r.json())
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
    }, []);

    const delFile = useCallback((path) => {
      if (!window.confirm('将记忆文件 "' + path + '" 移入回收站（.trash/，可回滚）？')) return;
      setBusy(true);
      setNotice({ kind: "busy", text: "删除中…" });
      fetch("/wb-memory/file?path=" + encodeURIComponent(path), { method: "DELETE" })
        .then((r) => r.json())
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
    }, [refresh]);

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
        body: JSON.stringify({ path: fname, content: newFileBody }),
      })
        .then((r) => r.json())
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
    }, [newFileName, newFileBody, files, refresh]);

    const doSearch = useCallback(() => {
      const q = searchQ.trim();
      if (!q) { setSearchResults([]); setSearchDone(false); return; }
      setBusy(true);
      setNotice({ kind: "busy", text: "检索中…" });
      fetch("/wb-memory/search?q=" + encodeURIComponent(q), { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          setSearchResults(d.results || []);
          setSearchDone(true);
          setNotice({ kind: "idle", text: "" });
        })
        .catch((e) => setNotice({ kind: "error", text: "检索失败：" + e.message }))
        .finally(() => setBusy(false));
    }, [searchQ]);

    const doGc = useCallback(() => {
      if (!window.confirm("对该工作区执行治理：① 归档超过保留期的每日日志到 archive/ ② MEMORY.md 超阈值则备份到 archive/ 并提示 ③ 近重复条目检测（只报告不合并） ④ 真删 .trash/ 与 archive/ 中超过保留期的文件（不可恢复）。继续？")) return;
      setBusy(true);
      setNotice({ kind: "busy", text: "治理中…" });
      fetch("/wb-memory/gc", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        .then((r) => r.json())
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
    }, [refresh]);

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
          h("div", { style: { fontSize: "13px", fontWeight: 500, wordBreak: "break-all" } }, f.path),
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
    const compBadge = st && st.compact
      ? (st.compact.lastOk ? { c: "#3dd68c", t: "成功" } : { c: "#e5484d", t: "失败" })
      : null;
    const metric = (label, value, badge, title) =>
      h("div", { style: { flex: 1, minWidth: 0, padding: "8px 10px" }, title: title || undefined },
        h("div", { style: { fontSize: "11px", opacity: 0.6 } }, label),
        h("div", { style: { fontSize: "16px", marginTop: "2px", wordBreak: "break-all" } }, value),
        badge ? h("div", { style: { fontSize: "10px", marginTop: "2px", color: badge.c } }, badge.t) : null,
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
        "WorkBuddy 文件化记忆（v5）：画像 + 摘要/相关条目 + 今日日志分层注入；自动流水 / 提炼 / 整理 / 治理闭环；纯 Markdown，无向量库。"),
      !loaded
        ? h("p", { style: { opacity: 0.6 } }, "加载中…")
        : h("div", null,
          // C1 状态指标条
          h("div", {
            style: {
              display: "flex", gap: "1px", margin: "10px 0",
              border: "1px solid rgba(128,128,128,0.15)", borderRadius: "8px", overflow: "hidden",
            },
          },
            metric("记忆占用", st && st.memory ? st.memory.chars + " / " + st.memory.threshold : "—", memBadge,
              st && st.memory ? "MEMORY.md 字符数 / 容量阈值（memoryCharThreshold）" : undefined),
            metric("条目数", st && st.memory ? String(st.memory.entries) : "—", null, "MEMORY.md 条目（## 计数）"),
            metric("今日流水", st && st.digest ? st.digest.count + " / " + st.digest.max : "—", null, "今日日志【自动】流水行数 / 每日上限"),
            metric("待提炼", st && st.distill ? String(st.distill.pendingDates) : "—", pendBadge, "尚未提炼的历史日志天数（含归档）"),
            metric("上次整理",
              st && st.compact ? ((st.compact.lastOk ? "✓ " : "✗ ") + String(st.compact.lastDay || "").slice(5)) : (st ? "未运行" : "—"),
              compBadge,
              st && st.compact
                ? "结果：" + (st.compact.lastOk ? "成功" : "失败" + (st.compact.failedCheck ? "（未过项：" + st.compact.failedCheck + "）" : "")) +
                  " · " + (st.compact.before != null ? st.compact.before + " → " + (st.compact.after != null ? st.compact.after : "?") + " 字符" : "")
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
              subSwitch("自动流水（digest）", autoDigest, toggleDigest, "每轮对话完成后自动在当日日志追加一条简短流水"),
              subSwitch("自动提炼（distill，含超阈值整理）", autoDistill, toggleDistill, "巡检把昨天及更早的日志提炼进 MEMORY.md；超阈值时自动整理。需已配置提炼模型"),
              subSwitch("治理（gc）", gcEnabled, toggleGc, "「治理」按钮可用性：归档超保留期日志、近重复检测、回收站/归档超期清理"),
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
                ? "→ 已锁定：" + activeProject + "（文件与检索按此工作区）"
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
            h("p", { style: CALLOUT_INFO }, "建议：提炼是分类抽取任务，flash 级小模型通常够用；若发现提炼质量不稳，再换指令遵循更强的模型。"),
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
            h("p", { style: CALLOUT_WARN }, "约束：必须变短、压回阈值内、条目数不少于一半——任一不满足即拒收并保留原文，每天每工作区至多重试一次。"),
            h("p", { style: CALLOUT_INFO }, "建议：整理需严格遵守条目数下限，flash 级小模型易违规被拒——建议配指令遵循更强的模型（如 glm-5.3；显式配置时自动压低思考档）。"),
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

      // 记忆文件（C7 新建入口）
      h("div", { style: { marginTop: "10px" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "10px" } },
          h("strong", { style: { fontSize: "13px" } },
            "记忆文件" + (activeProject ? "（工作区：" + (fileWorkspace || activeProject) + (files.length ? " · " + files.length : "") + "）" : "")),
          activeProject
            ? h("button", { onClick: () => { setNewFileOpen(!newFileOpen); setNotice({ kind: "idle", text: "" }); }, disabled: busy, style: BTN_STYLE },
                newFileOpen ? "收起新建" : "新建")
            : h("span", { style: { opacity: 0.6, fontSize: "12px" } }, "删除即移入回收站"),
        ),
        newFileOpen && activeProject
          ? h("div", { style: { marginTop: "8px", padding: "8px", border: "1px dashed rgba(128,128,128,0.35)", borderRadius: "6px" } },
              h("input", {
                type: "text", value: newFileName,
                onChange: (e) => setNewFileName(e.target.value),
                placeholder: "文件名（如 notes.md；写入激活工作区 .workbuddy/memory/）",
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
        activeProject
          ? (files.length
            ? h("ul", {
              style: { listStyle: "none", padding: 0, margin: "8px 0 0", maxHeight: "340px", overflow: "auto" },
            }, rows)
            : h("p", { style: { opacity: 0.6, fontSize: "12px", marginTop: "8px" } }, "工作区「" + (fileWorkspace || activeProject) + "」的 .workbuddy/memory/ 下暂无记忆文件。"))
          : h("p", { style: { opacity: 0.6, fontSize: "12px", marginTop: "8px" } }, "请先在「激活工作区」选择一个工作区，即可查看 / 管理该工作区的记忆文件。"),
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

      // C6 检索 / 治理（未选工作区时不再隐藏，改禁用态 + 引导）
      h("div", { style: { marginTop: "12px", padding: "10px", border: "1px solid rgba(128,128,128,0.2)", borderRadius: "6px" } },
        h("strong", { style: { fontSize: "13px" } }, "检索 / 治理"),
        h("div", { style: { display: "flex", gap: "8px", margin: "8px 0" } },
          h("input", {
            type: "text",
            value: searchQ,
            onChange: (e) => setSearchQ(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") doSearch(); },
            disabled: busy || !activeProject,
            placeholder: "输入关键词召回相关记忆条目（纯文本检索，无向量库）",
            style: { ...inputStyle, flex: 1 },
          }),
          h("button", { onClick: doSearch, disabled: busy || !activeProject, style: BTN_PRIMARY }, "检索"),
          h("button", {
            onClick: doGc,
            disabled: busy || !activeProject || !gcEnabled,
            style: BTN_DANGER,
            title: gcEnabled
              ? "归档过期日志 + 容量检测 + 近重复检测 + 回收站/归档超期清理（有确认）"
              : "治理已关闭（总控中的「治理」开关）",
          }, "治理"),
        ),
        !activeProject
          ? h("p", { style: { opacity: 0.6, fontSize: "11px", margin: "6px 0 0" } }, "↑ 请先在「激活工作区」选择一个工作区")
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
