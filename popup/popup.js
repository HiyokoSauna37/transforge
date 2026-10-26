import { MODELS, LANG_PRESETS, fmtUsd, fmtJpy } from "../shared/models.js";
import { $, bg, fillSelect, segmented } from "../shared/ui.js";

const POLL_MS = 500;
let tab = null;
let settings = null;
let pollTimer = null;
let modeSeg = null;
let subtitleTimer = null;

async function content(msg) {
  if (!tab || !tab.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

function statusLabel(st) {
  if (st.status === "running") return `翻訳中 ${st.progress.done}/${st.progress.total}`;
  if (st.status === "translated") return st.mode === "bilingual" ? "翻訳済み（対訳）" : "翻訳済み（置換）";
  return "未翻訳";
}

function render(st) {
  $("main").hidden = false;
  const status = st.status || "idle";
  const p = st.progress || { done: 0, total: 0 };
  $("dot").className = `dot ${status}`;
  $("statusText").textContent = statusLabel({ ...st, status, progress: p });
  $("bar").style.width = status === "running" && p.total ? `${Math.round((p.done / p.total) * 100)}%` : status === "translated" ? "100%" : "0";
  $("translate").hidden = status !== "idle";
  $("restore").hidden = status !== "translated";
  $("cancel").hidden = status !== "running";
  $("err").hidden = !st.error;
  $("err").textContent = st.error || "";
  const u = st.usage;
  $("pageCost").textContent = u && u.requests
    ? `${(u.input + u.output).toLocaleString()} tok · ${fmtUsd(u.costUsd)} ≈ ${fmtJpy(u.costUsd, settings.usdJpy)}${u.cached ? ` · cache ${u.cached}` : ""}`
    : "--";
  const t = settings.usage;
  $("totalCost").textContent = `${fmtUsd(t.costUsd)} ≈ ${fmtJpy(t.costUsd, settings.usdJpy)} / ${t.requests} req`;
  modeSeg.set((status === "translated" ? st.mode : settings.displayMode) || "replace");
}

async function refresh() {
  const st = await content({ type: "tf:state" });
  if (!st) {
    $("main").hidden = true;
    $("unsupported").hidden = false;
    return;
  }
  $("unsupported").hidden = true;
  render(st);
  if (st.status === "running") {
    if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    const r = await bg({ type: "getSettings" });
    if (r && r.ok) settings = r.settings;
  }
}

function startTranslate(mode) {
  content({ type: "tf:translate", mode }); // 完了を待たない（ポーリングで反映）
  setTimeout(refresh, 150);
}

async function saveSetting(partial) {
  await bg({ type: "saveSettings", partial });
  Object.assign(settings, partial);
}

async function refreshSubtitles() {
  const s = await content({ type: "tf:youtubeState" });
  $("youtube").hidden = !s?.supported;
  if (!s?.supported) return;
  const started = s.status === "loading" || s.status === "active";
  $("subtitleStart").hidden = started;
  $("subtitleStop").hidden = !started && s.status !== "error";
  $("subtitleLang").disabled = started;
  $("subtitleModel").disabled = started;
  $("subtitleMode").value = s.status === "idle" ? settings.subtitleMode || "bilingual" : s.mode;
  $("subtitleLang").value = s.status === "idle" ? settings.subtitleTargetLang || "English" : s.targetLang;
  $("subtitleStatus").textContent = s.status === "loading" ? "字幕を読み込んでいます…" : s.status === "active"
    ? `${s.sourceLabel} → ${s.targetLang} · ${s.done}/${s.total} 件を翻訳済み（再生位置の先を順次翻訳）`
    : "字幕付きの通常動画に対応しています。";
  $("subtitleError").textContent = s.error || "";
  $("subtitleError").hidden = !s.error;
  $("subtitleCost").textContent = s.usage?.requests || s.usage?.cached
    ? `この動画 ${fmtUsd(s.usage.costUsd)} ≈ ${fmtJpy(s.usage.costUsd, settings.usdJpy)}${s.usage.cached ? ` · cache ${s.usage.cached}` : ""}` : "";
}

async function initSubtitles() {
  if (safeHost(tab?.url) !== "www.youtube.com") return;
  fillSelect($("subtitleModel"), MODELS, settings.model, (m) => m.label);
  $("subtitleLang").addEventListener("change", (e) => saveSetting({ subtitleTargetLang: e.target.value }));
  $("subtitleModel").addEventListener("change", async (e) => {
    await saveSetting({ model: e.target.value });
    $("model").value = e.target.value;
  });
  $("subtitleMode").addEventListener("change", async (e) => {
    await saveSetting({ subtitleMode: e.target.value });
    await content({ type: "tf:youtubeMode", mode: e.target.value });
    refreshSubtitles();
  });
  $("subtitleStart").addEventListener("click", async () => {
    await content({ type: "tf:youtubeStart", targetLang: $("subtitleLang").value, mode: $("subtitleMode").value });
    refreshSubtitles();
  });
  $("subtitleStop").addEventListener("click", async () => { await content({ type: "tf:youtubeStop" }); refreshSubtitles(); });
  await refreshSubtitles();
  subtitleTimer = setInterval(refreshSubtitles, POLL_MS);
}
window.addEventListener("pagehide", () => { clearInterval(subtitleTimer); clearInterval(pollTimer); });

function safeHost(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : "";
  } catch {
    return "";
  }
}

async function init() {
  // 設定ボタンは初期化の成否に関係なく常に効くよう最初に結ぶ
  for (const id of ["openOptions1", "openOptions2"]) $(id).addEventListener("click", () => chrome.runtime.openOptionsPage());

  // 開発用: popup.html?tab=<tabId> で対象タブを固定（タブとして開いて検証するため）
  const forced = new URLSearchParams(location.search).get("tab");
  if (forced) tab = await chrome.tabs.get(Number(forced)).catch(() => null);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  settings = (await bg({ type: "getSettings" })).settings;
  if (!settings.hasKey) $("nokey").hidden = false;

  fillSelect($("lang"), LANG_PRESETS, settings.targetLang);
  fillSelect($("model"), MODELS, settings.model, (m) => m.label);
  const host = tab && tab.url ? safeHost(tab.url) : "";
  $("autoHost").checked = !!host && settings.autoHosts.includes(host);
  $("autoHostLabel").textContent = host ? `${host} は常に翻訳` : "このサイトは常に翻訳";
  $("autoHost").disabled = !host;

  modeSeg = segmented($("modeSeg"), async (mode) => {
    await saveSetting({ displayMode: mode });
    const st = await content({ type: "tf:state" });
    if (st && st.status === "translated" && st.mode !== mode) startTranslate(mode); // モード切替は再翻訳（キャッシュで速い）
    else if (st) render(st);
  });

  const ok = tab && tab.id && (await bg({ type: "ensureContent", tabId: tab.id }));
  if (!ok || !ok.ok) {
    $("unsupported").hidden = false;
    return;
  }
  await refresh();
  await initSubtitles();

  $("translate").addEventListener("click", () => {
    if (!settings.hasKey) { $("nokey").hidden = false; return; }
    startTranslate(modeSeg.get() || settings.displayMode);
  });
  $("restore").addEventListener("click", async () => { await content({ type: "tf:restore" }); refresh(); });
  $("cancel").addEventListener("click", async () => { await content({ type: "tf:cancel" }); refresh(); });
  $("lang").addEventListener("change", (e) => saveSetting({ targetLang: e.target.value }));
  $("model").addEventListener("change", (e) => { $("subtitleModel").value = e.target.value; saveSetting({ model: e.target.value }); });
  $("autoHost").addEventListener("change", (e) => {
    const set = new Set(settings.autoHosts);
    if (e.target.checked) set.add(host); else set.delete(host);
    saveSetting({ autoHosts: [...set] });
  });
}

init().catch((e) => {
  $("unsupported").hidden = false;
  $("unsupported").querySelector("p").textContent = `初期化に失敗: ${e.message || e}`;
});
