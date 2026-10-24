import { MODELS, LANG_PRESETS, fmtUsd, fmtJpy } from "../shared/models.js";

const $ = (id) => document.getElementById(id);
let tab = null;
let settings = null;
let pollTimer = null;

function bg(msg) {
  return chrome.runtime.sendMessage(msg);
}
async function content(msg) {
  if (!tab || !tab.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

function fillSelect(sel, items, value, labelOf) {
  sel.innerHTML = "";
  let seen = false;
  for (const it of items) {
    const o = document.createElement("option");
    o.value = typeof it === "string" ? it : it.id;
    o.textContent = labelOf ? labelOf(it) : it;
    if (o.value === value) { o.selected = true; seen = true; }
    sel.appendChild(o);
  }
  if (!seen && value) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = value;
    o.selected = true;
    sel.appendChild(o);
  }
}

function render(st) {
  const main = $("main");
  main.hidden = false;
  const status = (st && st.status) || "idle";
  $("dot").className = `dot ${status}`;
  const p = (st && st.progress) || { done: 0, total: 0 };
  let text = "未翻訳";
  if (status === "running") text = `翻訳中 ${p.done}/${p.total}`;
  else if (status === "translated") text = st.mode === "bilingual" ? "翻訳済み（対訳）" : "翻訳済み（置換）";
  $("statusText").textContent = text;
  $("bar").style.width = status === "running" && p.total ? `${Math.round((p.done / p.total) * 100)}%` : status === "translated" ? "100%" : "0";
  $("translate").hidden = status !== "idle";
  $("restore").hidden = status !== "translated";
  $("cancel").hidden = status !== "running";
  const err = $("err");
  err.hidden = !(st && st.error);
  err.textContent = (st && st.error) || "";
  const u = st && st.usage;
  $("pageCost").textContent = u && u.requests
    ? `${(u.input + u.output).toLocaleString()} tok · ${fmtUsd(u.costUsd)} ≈ ${fmtJpy(u.costUsd, settings.usdJpy)}${u.cached ? ` · cache ${u.cached}` : ""}`
    : "--";
  const t = settings.usage;
  $("totalCost").textContent = `${fmtUsd(t.costUsd)} ≈ ${fmtJpy(t.costUsd, settings.usdJpy)} / ${t.requests} req`;
  const mode = (st && st.status === "translated" ? st.mode : settings.displayMode) || "replace";
  for (const b of document.querySelectorAll(".segbtn")) b.classList.toggle("on", b.dataset.mode === mode);
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
    if (!pollTimer) pollTimer = setInterval(refresh, 500);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    const r = await bg({ type: "getSettings" });
    if (r && r.ok) settings = r.settings;
  }
}

async function init() {
  // 設定ボタンは初期化の成否に関係なく常に効くよう最初に結ぶ
  for (const id of ["openOptions1", "openOptions2"]) {
    $(id).addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
  // 開発用: popup.html?tab=<tabId> で対象タブを固定（タブとして開いて検証するため）
  const forced = new URLSearchParams(location.search).get("tab");
  if (forced) tab = await chrome.tabs.get(Number(forced)).catch(() => null);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await bg({ type: "getSettings" });
  settings = r.settings;
  if (!settings.hasKey) $("nokey").hidden = false;

  fillSelect($("lang"), LANG_PRESETS, settings.targetLang);
  fillSelect($("model"), MODELS, settings.model, (m) => `${m.label} — ${m.note}`);
  const host = tab && tab.url ? safeHost(tab.url) : "";
  $("autoHost").checked = !!host && settings.autoHosts.includes(host);
  $("autoHostLabel").textContent = host ? `${host} は常に翻訳` : "このサイトは常に翻訳";
  $("autoHost").disabled = !host;

  const ok = tab && tab.id && (await bg({ type: "ensureContent", tabId: tab.id }));
  if (!ok || !ok.ok) {
    $("unsupported").hidden = false;
    return;
  }
  await refresh();

  $("translate").addEventListener("click", async () => {
    if (!settings.hasKey) { $("nokey").hidden = false; return; }
    const mode = document.querySelector(".segbtn.on")?.dataset.mode || settings.displayMode;
    content({ type: "tf:translate", mode }); // 完了を待たない（ポーリングで反映）
    setTimeout(refresh, 150);
  });
  $("restore").addEventListener("click", async () => { await content({ type: "tf:restore" }); refresh(); });
  $("cancel").addEventListener("click", async () => { await content({ type: "tf:cancel" }); refresh(); });
  for (const b of document.querySelectorAll(".segbtn")) {
    b.addEventListener("click", async () => {
      const mode = b.dataset.mode;
      await bg({ type: "saveSettings", partial: { displayMode: mode } });
      settings.displayMode = mode;
      const st = await content({ type: "tf:state" });
      if (st && st.status === "translated" && st.mode !== mode) {
        content({ type: "tf:translate", mode }); // モード切替は再翻訳（キャッシュで速い）
        setTimeout(refresh, 150);
      } else render(st);
    });
  }
  $("lang").addEventListener("change", async (e) => {
    await bg({ type: "saveSettings", partial: { targetLang: e.target.value } });
    settings.targetLang = e.target.value;
  });
  $("model").addEventListener("change", async (e) => {
    await bg({ type: "saveSettings", partial: { model: e.target.value } });
    settings.model = e.target.value;
  });
  $("autoHost").addEventListener("change", async (e) => {
    const set = new Set(settings.autoHosts);
    if (e.target.checked) set.add(host); else set.delete(host);
    settings.autoHosts = [...set];
    await bg({ type: "saveSettings", partial: { autoHosts: settings.autoHosts } });
  });
}

function safeHost(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : "";
  } catch {
    return "";
  }
}

init().catch((e) => {
  $("unsupported").hidden = false;
  $("unsupported").querySelector("p").textContent = `初期化に失敗: ${e.message || e}`;
});
