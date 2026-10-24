import { MODELS, EFFORTS, LANG_PRESETS, modelInfo, fmtUsd, fmtJpy } from "../shared/models.js";

const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg);
let settings = null;

function fill(sel, items, value, labelOf) {
  sel.innerHTML = "";
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.id;
    o.textContent = labelOf(it);
    o.selected = it.id === value;
    sel.appendChild(o);
  }
}

function showModelPrice() {
  const m = modelInfo($("model").value);
  $("modelPrice").textContent = m
    ? `入力 $${m.input}/MTok · 出力 $${m.output}/MTok（目安: 英文1万字のページ ≈ ${fmtUsd(estimatePage(m))} ≈ ${fmtJpy(estimatePage(m), Number($("usdJpy").value) || 150)}）`
    : "";
}
// 1万字の英文 ≈ 入力 3,000 tok + システム/マーカー 2,000 tok、出力 ≈ 7,000 tok の概算
function estimatePage(m) {
  return (5000 * m.input + 7000 * m.output) / 1_000_000;
}

function renderUsage() {
  const u = settings.usage;
  $("usage").innerHTML = "";
  const rows = [
    ["requests", `${u.requests.toLocaleString()} 回`],
    ["input", `${u.input.toLocaleString()} tok`],
    ["output", `${u.output.toLocaleString()} tok`],
    ["cost", `${fmtUsd(u.costUsd)} ≈ ${fmtJpy(u.costUsd, settings.usdJpy)}`],
  ];
  for (const [k, v] of rows) {
    const a = document.createElement("span"); a.className = "k"; a.textContent = k;
    const b = document.createElement("span"); b.textContent = v;
    $("usage").append(a, b);
  }
}

function setMode(mode) {
  for (const b of document.querySelectorAll(".segbtn")) b.classList.toggle("on", b.dataset.mode === mode);
}
function getMode() {
  return document.querySelector(".segbtn.on")?.dataset.mode || "replace";
}

async function load() {
  const r = await bg({ type: "getSettingsFull" });
  if (!r || !r.ok) throw new Error((r && r.error) || "設定を読めません");
  settings = r.settings;
  $("ver").textContent = `v${chrome.runtime.getManifest().version}`;
  $("apiKey").value = settings.apiKey || "";
  $("apiBase").value = settings.apiBase || "";
  fill($("model"), MODELS, settings.model, (m) => `${m.label} — ${m.note}`);
  fill($("effort"), EFFORTS, settings.effort, (e) => e.label);
  $("targetLang").value = settings.targetLang;
  for (const l of LANG_PRESETS) { const o = document.createElement("option"); o.value = l; $("langs").appendChild(o); }
  setMode(settings.displayMode);
  $("customInstructions").value = settings.customInstructions || "";
  $("glossary").value = settings.glossary || "";
  $("skipNav").checked = !!settings.skipNav;
  $("batchChars").value = settings.batchChars;
  $("concurrency").value = settings.concurrency;
  $("usdJpy").value = settings.usdJpy;
  $("cacheEnabled").checked = !!settings.cacheEnabled;
  $("autoHosts").value = (settings.autoHosts || []).join("\n");
  showModelPrice();
  renderUsage();
  refreshCache();
}

async function refreshCache() {
  const r = await bg({ type: "cacheStats" });
  $("cacheStats").textContent = `cache: ${r && r.ok ? r.count.toLocaleString() : "?"} entries`;
}

function collect() {
  return {
    apiKey: $("apiKey").value.trim(),
    apiBase: $("apiBase").value.trim() || "https://api.anthropic.com",
    model: $("model").value,
    effort: $("effort").value,
    targetLang: $("targetLang").value.trim() || "日本語",
    displayMode: getMode(),
    customInstructions: $("customInstructions").value,
    glossary: $("glossary").value,
    skipNav: $("skipNav").checked,
    batchChars: clamp(Number($("batchChars").value) || 2500, 500, 8000),
    concurrency: clamp(Number($("concurrency").value) || 4, 1, 8),
    usdJpy: Number($("usdJpy").value) || 150,
    cacheEnabled: $("cacheEnabled").checked,
    autoHosts: $("autoHosts").value.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function save() {
  const partial = collect();
  const r = await bg({ type: "saveSettings", partial });
  if (!r || !r.ok) { alert(`保存に失敗: ${(r && r.error) || "?"}`); return; }
  settings = { ...settings, ...partial };
  $("saved").hidden = false;
  setTimeout(() => { $("saved").hidden = true; }, 1600);
}

$("save").addEventListener("click", save);
$("toggleKey").addEventListener("click", () => {
  const i = $("apiKey");
  i.type = i.type === "password" ? "text" : "password";
  $("toggleKey").textContent = i.type === "password" ? "表示" : "隠す";
});
$("testKey").addEventListener("click", async () => {
  const out = $("testResult");
  out.className = "help testing";
  out.textContent = "接続中…";
  const r = await bg({ type: "testKey", apiKey: $("apiKey").value.trim(), model: $("model").value, apiBase: $("apiBase").value.trim() });
  if (r && r.ok) {
    out.className = "help ok";
    out.textContent = `OK — ${r.model} が応答（${r.text || ""}）· ${fmtUsd(r.costUsd || 0)}`;
  } else {
    out.className = "help err";
    out.textContent = `失敗: ${(r && r.error) || "不明なエラー"}`;
  }
});
$("model").addEventListener("change", showModelPrice);
$("usdJpy").addEventListener("input", showModelPrice);
for (const b of document.querySelectorAll(".segbtn")) b.addEventListener("click", () => setMode(b.dataset.mode));
$("clearCache").addEventListener("click", async () => {
  if (!confirm("翻訳キャッシュをすべて削除します。よろしいですか？")) return;
  await bg({ type: "clearCache" });
  refreshCache();
});
$("resetUsage").addEventListener("click", async () => {
  if (!confirm("累計使用量をリセットします。よろしいですか？")) return;
  const r = await bg({ type: "resetUsage" });
  if (r && r.ok) { settings.usage = r.settings.usage; renderUsage(); }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); }
});

load().catch((e) => {
  document.body.insertAdjacentHTML("afterbegin", `<p class="err" style="padding:20px">${e.message || e}</p>`);
});
