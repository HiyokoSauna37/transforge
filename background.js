// TransForge service worker: Claude API 呼び出し・キャッシュ・使用量・コンテンツスクリプト注入
import { estimateCostUsd } from "./shared/models.js";
import { buildRequest, extractText, usageOf, describeHttpError, checkStop } from "./shared/api.js";
import { buildSystemPrompt, buildUserMessage, parseSegments } from "./shared/prompt.js";
import { cacheGetMany, cacheSetMany, cacheClear, cacheCount, cachePrune, sha256 } from "./shared/cache.js";
import { getSettings, saveSettings, addUsage, resetUsage } from "./shared/settings.js";

const CONTENT_JS = ["content/segmenter.js", "content/content.js"];
const CONTENT_CSS = ["content/content.css"];
const inflight = new Map(); // sessionId -> Set<AbortController>

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "tf-selection",
    title: "選択範囲を Claude で翻訳",
    contexts: ["selection"],
  });
  cachePrune();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "tf-selection" || !tab || !tab.id) return;
  if (!(await ensureContent(tab.id))) return;
  chrome.tabs.sendMessage(tab.id, { type: "tf:translateSelection" }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  if (!(await ensureContent(tab.id))) return;
  chrome.tabs.sendMessage(tab.id, { type: "tf:toggle" }).catch(() => {});
});

// content script が未注入（インストール前から開いていたタブ等）なら注入する
async function ensureContent(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "tf:ping" });
    if (r && r.ok) return true;
  } catch {
    /* 未注入 */
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS });
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS });
    return true;
  } catch {
    return false; // chrome:// や Web ストア等
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const p = handle(msg, sender);
  if (!p) return false;
  p.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e), fatal: !!(e && e.fatal) }));
  return true;
});

function publicSettings(s) {
  const { apiKey, ...rest } = s;
  return { ...rest, hasKey: !!apiKey };
}

function handle(msg, sender) {
  switch (msg && msg.type) {
    case "tf:keepalive":
      return Promise.resolve({ ok: true });
    case "getSettings":
      return getSettings().then((s) => ({ ok: true, settings: publicSettings(s) }));
    case "getSettingsFull": // options ページ専用（拡張ページからのみ）
      if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(""))) return Promise.resolve({ ok: false, error: "forbidden" });
      return getSettings().then((s) => ({ ok: true, settings: s }));
    case "saveSettings":
      if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(""))) return Promise.resolve({ ok: false, error: "forbidden" });
      return saveSettings(msg.partial || {}).then((s) => ({ ok: true, settings: publicSettings(s) }));
    case "resetUsage":
      return resetUsage().then((s) => ({ ok: true, settings: publicSettings(s) }));
    case "cacheStats":
      return cacheCount().then((count) => ({ ok: true, count }));
    case "clearCache":
      return cacheClear().then(() => ({ ok: true }));
    case "ensureContent":
      return ensureContent(msg.tabId).then((ok) => ({ ok }));
    case "openOptions":
      chrome.runtime.openOptionsPage();
      return Promise.resolve({ ok: true });
    case "testKey":
      return testKey(msg);
    case "translate":
      return translate(msg);
    case "cancel":
      cancelSession(msg.sessionId);
      return Promise.resolve({ ok: true });
    default:
      return null;
  }
}

function track(sessionId, ctrl) {
  if (!sessionId) return;
  if (!inflight.has(sessionId)) inflight.set(sessionId, new Set());
  inflight.get(sessionId).add(ctrl);
}
function untrack(sessionId, ctrl) {
  const set = inflight.get(sessionId);
  if (!set) return;
  set.delete(ctrl);
  if (!set.size) inflight.delete(sessionId);
}
function cancelSession(sessionId) {
  const set = inflight.get(sessionId);
  if (!set) return;
  for (const c of set) c.abort();
  inflight.delete(sessionId);
}

// msg: {sessionId, segments:[{id,text}], context:{title,url}, nocache?}
async function translate(msg) {
  const s = await getSettings();
  if (!s.apiKey) {
    const e = new Error("APIキーが未設定です（拡張の設定画面で登録してください）");
    e.fatal = true;
    throw e;
  }
  const segments = Array.isArray(msg.segments) ? msg.segments : [];
  const results = {};
  const pending = [];
  let cached = 0;
  const keyBase = s.cacheEnabled
    ? await sha256([s.model, s.targetLang, s.customInstructions, s.glossary].join("\u0001"))
    : null;
  const keys = keyBase ? await Promise.all(segments.map((seg) => sha256(keyBase + "\u0001" + seg.text))) : [];
  const hits = keyBase && !msg.nocache ? await cacheGetMany(keys) : new Map();
  segments.forEach((seg, i) => {
    const k = keyBase ? keys[i] : null;
    if (k && hits.has(k)) {
      results[seg.id] = hits.get(k);
      cached++;
      return;
    }
    pending.push({ id: seg.id, text: seg.text, k });
  });

  let usage = null;
  if (pending.length) {
    const req = buildRequest(s, buildSystemPrompt(s), buildUserMessage(pending, msg.context || {}));
    const ctrl = new AbortController();
    track(msg.sessionId, ctrl);
    let resp;
    try {
      resp = await fetchWithRetry(req, ctrl.signal);
    } finally {
      untrack(msg.sessionId, ctrl);
    }
    const stop = checkStop(resp);
    if (!stop.ok) {
      const e = new Error(stop.message);
      e.fatal = true;
      throw e;
    }
    const parsed = parseSegments(extractText(resp));
    const toCache = [];
    for (const p of pending) {
      const t = parsed[p.id];
      if (t == null) continue;
      results[p.id] = t;
      if (p.k) toCache.push({ k: p.k, t });
    }
    cacheSetMany(toCache);
    const u = usageOf(resp);
    const costUsd = estimateCostUsd(s.model, u);
    usage = { ...u, costUsd, truncated: !!stop.truncated };
    await addUsage({ input: u.input + u.cacheRead + u.cacheWrite, output: u.output, costUsd });
  }
  return { ok: true, results, usage, cached, model: s.model };
}

function abortError() {
  const e = new Error("cancelled");
  e.cancelled = true;
  return e;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function fetchWithRetry(req, signal, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw abortError();
    let res;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw abortError();
      lastErr = new Error(`ネットワークエラー: ${(e && e.message) || e}`);
      await sleep(1000 * attempt, signal);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非JSON */ }
    if (res.ok) {
      if (!json) throw new Error("API 応答が JSON ではありません");
      return json;
    }
    const d = describeHttpError(res.status, json);
    const err = new Error(d.message);
    err.fatal = !!d.fatal;
    err.status = res.status;
    if (!d.retry) throw err;
    lastErr = err;
    const ra = Number(res.headers.get("retry-after"));
    await sleep(ra > 0 ? Math.min(ra * 1000, 30000) : 1500 * attempt, signal);
  }
  throw lastErr || new Error("再試行上限に達しました");
}

// 設定画面の「接続テスト」
async function testKey(msg) {
  const base = await getSettings();
  const s = { ...base, apiKey: msg.apiKey || base.apiKey, model: msg.model || base.model, apiBase: msg.apiBase || base.apiBase, effort: "low" };
  if (!s.apiKey) return { ok: false, error: "APIキーが空です" };
  const req = buildRequest(s, "Reply with exactly: OK", "ping", { maxTokens: 512 });
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: describeHttpError(res.status, json).message };
    const u = usageOf(json);
    return { ok: true, model: json.model, text: extractText(json).trim(), costUsd: estimateCostUsd(s.model, u) };
  } catch (e) {
    return { ok: false, error: `ネットワークエラー: ${(e && e.message) || e}` };
  }
}
