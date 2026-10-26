// Yomeru service worker: Claude API 呼び出し・再試行・キャッシュ・使用量・コンテンツスクリプト注入
import { MODELS, estimateCostUsd } from "./shared/models.js";
import { buildRequest, extractText, usageOf, describeHttpError, checkStop } from "./shared/api.js";
import { buildSystemPrompt, buildUserMessage, parseSegments } from "./shared/prompt.js";
import { cacheGetMany, cacheSetMany, cacheClear, cacheCount, cachePrune, sha256 } from "./shared/cache.js";
import { getSettings, saveSettings, addUsage, resetUsage } from "./shared/settings.js";
import { EXPLAIN_VERSION, normalizeExplanation, buildExplanationSystem, buildExplanationMessage } from "./shared/explain.js";
import { loadYouTubeCaptions } from "./shared/youtube.js";
import { IMAGE_VERSION, normalizeImageRequest, imageSenderAllowed, buildImageSystem, buildImageMessage, parseImageResult, fetchRemoteImage } from "./shared/image.js";
import { SUBTITLES_VERSION, normalizeSubtitles, subtitleSenderAllowed, subtitleVideoUrlAllowed, buildSubtitleSystem, buildSubtitleMessage, parseSubtitleResult } from "./shared/subtitles.js";

// インストール前から開いていたタブへの注入順も manifest の定義を使う。
const { js: CONTENT_JS, css: CONTENT_CSS } = chrome.runtime.getManifest().content_scripts[0];
const MENU_PAGE = "tf-page";
const MENU_SELECTION = "tf-selection";
const MENU_EXPLAIN = "tf-explain-selection";
const MENU_IMAGE = "tf-image";
const MAX_RETRY_AFTER_MS = 30000;

const inflight = new Map(); // sessionId -> Set<AbortController>

// ---------- ブラウザ側のイベント ----------
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_PAGE, title: "このページを Yomeru で翻訳", contexts: ["all"] });
  chrome.contextMenus.create({ id: MENU_SELECTION, title: "選択範囲を Claude で翻訳", contexts: ["selection"] });
  chrome.contextMenus.create({ id: MENU_IMAGE, title: "画像を翻訳", contexts: ["image"] });
  const s = await getSettings();
  chrome.contextMenus.create({ id: MENU_EXPLAIN, title: "選択範囲を Yomeru で解説", contexts: ["selection"], visible: s.explanationEnabled !== false });
  cachePrune();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_IMAGE) {
    if (tab?.id && info.srcUrl && await ensureContent(tab.id)) sendToTab(tab.id, { type: "tf:translateImage", srcUrl: info.srcUrl });
    return;
  }
  const type = {
    [MENU_PAGE]: "tf:translate",
    [MENU_SELECTION]: "tf:translateSelection",
    [MENU_EXPLAIN]: "tf:explainSelection",
  }[info.menuItemId];
  if (!type || !tab?.id) return;
  if (await ensureContent(tab.id)) sendToTab(tab.id, { type });
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  if (await ensureContent(tab.id)) sendToTab(tab.id, { type: "tf:toggle" });
});

function sendToTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

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

// ---------- メッセージ ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const p = handle(msg, sender);
  if (!p) return false;
  p.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e), fatal: !!(e && e.fatal) }));
  return true;
});

const fromExtensionPage = (sender) => !!sender.url && sender.url.startsWith(chrome.runtime.getURL(""));
const FORBIDDEN = Promise.resolve({ ok: false, error: "forbidden" });

// apiKey を外に出さない（content script / popup 向け）
function publicSettings(s) {
  const { apiKey, ...rest } = s;
  return { ...rest, hasKey: !!apiKey, models: MODELS.map(({ id, label }) => ({ id, label })) };
}

function handle(msg, sender) {
  switch (msg && msg.type) {
    case "tf:keepalive":
      return Promise.resolve({ ok: true });
    case "getSettings":
      return getSettings().then((s) => ({ ok: true, settings: publicSettings(s) }));
    case "getSettingsFull": // options ページ専用（拡張ページからのみ）
      return fromExtensionPage(sender) ? getSettings().then((s) => ({ ok: true, settings: s })) : FORBIDDEN;
    case "saveSettings":
      return fromExtensionPage(sender) ? saveSettings(msg.partial || {}).then(async (s) => {
        await chrome.contextMenus.update(MENU_EXPLAIN, { visible: s.explanationEnabled !== false }).catch(() => {});
        return { ok: true, settings: publicSettings(s) };
      }) : FORBIDDEN;
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
    case "fetchImage":
      return imageSenderAllowed(sender) ? fetchImage(msg) : FORBIDDEN;
    case "translateImage":
      return imageSenderAllowed(sender) ? translateImage(msg) : FORBIDDEN;
    case "getYouTubeCaptions":
      return loadYouTubeCaptions(sender, msg.videoId);
    case "translateSubtitles":
      return subtitleSenderAllowed(sender) ? translateSubtitles(msg, sender) : FORBIDDEN;
    case "explain":
      return explain(msg);
    case "cancel":
      cancelSession(msg.sessionId);
      return Promise.resolve({ ok: true });
    default:
      return null;
  }
}

// ---------- 進行中リクエストの管理（中止用） ----------
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

// ---------- 翻訳 ----------
function fatalError(message) {
  const e = new Error(message);
  e.fatal = true;
  return e;
}

// キャッシュ照合。戻り値: {results, pending:[{id,text,key}], cached}
async function lookupCache(s, segments, nocache) {
  const results = {};
  const pending = [];
  let cached = 0;
  if (!s.cacheEnabled) {
    for (const seg of segments) pending.push({ id: seg.id, text: seg.text, key: null });
    return { results, pending, cached };
  }
  // 設定（モデル・言語・指示・用語集）が違えば別のキャッシュ
  const keyBase = await sha256([s.model, s.targetLang, s.customInstructions, s.glossary].join("\u0001"));
  const keys = await Promise.all(segments.map((seg) => sha256(keyBase + "\u0001" + seg.text)));
  const hits = nocache ? new Map() : await cacheGetMany(keys);
  segments.forEach((seg, i) => {
    if (hits.has(keys[i])) {
      results[seg.id] = hits.get(keys[i]);
      cached++;
    } else {
      pending.push({ id: seg.id, text: seg.text, key: keys[i] });
    }
  });
  return { results, pending, cached };
}

// msg: {sessionId, segments:[{id,text}], context:{title,url}, nocache?}
async function translate(msg) {
  const s = await getSettings();
  if (!s.apiKey) throw fatalError("APIキーが未設定です（拡張の設定画面で登録してください）");
  const segments = Array.isArray(msg.segments) ? msg.segments : [];
  const { results, pending, cached } = await lookupCache(s, segments, !!msg.nocache);
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
    if (!stop.ok) throw fatalError(stop.message);
    const parsed = parseSegments(extractText(resp));
    const toCache = [];
    for (const p of pending) {
      const t = parsed[p.id];
      if (t == null) continue;
      results[p.id] = t;
      if (p.key) toCache.push({ k: p.key, t });
    }
    cacheSetMany(toCache);
    const u = usageOf(resp);
    const costUsd = estimateCostUsd(s.model, u);
    usage = { ...u, costUsd, truncated: !!stop.truncated };
    await addUsage({ input: u.input + u.cacheRead + u.cacheWrite, output: u.output, costUsd });
  }
  return { ok: true, results, usage, cached, model: s.model };
}

// ---------- YouTube 字幕 ----------
async function translateSubtitles(msg, sender) {
  const input = normalizeSubtitles(msg);
  if (typeof msg.sessionId !== "string" || !msg.sessionId || msg.sessionId.length > 160) throw fatalError("字幕のセッションIDが不正です");
  async function checkCurrentVideo() {
    const current = await chrome.tabs.get(sender.tab.id);
    if (!subtitleVideoUrlAllowed(current.url, input.videoId)) throw fatalError("動画が切り替わりました。もう一度開始してください");
  }
  // 設定/キャッシュ照合中の中止も取りこぼさないよう、最初の await より前に登録する。
  const ctrl = new AbortController();
  track(msg.sessionId, ctrl);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; ctrl.abort(); }, 60000);
  try {
    await checkCurrentVideo();
    const s = await getSettings();
    if (ctrl.signal.aborted) throw abortError();
    if (!s.apiKey) throw fatalError("APIキーが未設定です（拡張の設定画面で登録してください）");
    const system = buildSubtitleSystem(s, input);
    const message = buildSubtitleMessage(input);
    // 同じ短文でも動画・周辺の発話・翻訳先が変われば訳は変わる。バッチ単位で保存する。
    const key = await sha256(JSON.stringify(["subtitles", SUBTITLES_VERSION, s.model, s.effort, system, message]));
    if (s.cacheEnabled) {
      const hits = await cacheGetMany([key]);
      if (ctrl.signal.aborted) throw abortError();
      if (hits.has(key)) {
        await checkCurrentVideo();
        try {
          const results = parseSubtitleResult(hits.get(key), input.cues);
          return { ok: true, results, cached: input.cues.length, usage: null, model: s.model };
        } catch { /* 古い/壊れたキャッシュは使わず取得し直す */ }
      }
    }
    await checkCurrentVideo();
    if (ctrl.signal.aborted) throw abortError();
    const req = buildRequest(s, system, message, { maxTokens: 6000 });
    const resp = await fetchWithRetry(req, ctrl.signal);
    if (ctrl.signal.aborted) throw abortError();
    const u = usageOf(resp);
    const costUsd = estimateCostUsd(s.model, u);
    // 出力の欠落や途中終了があっても、実際に発生したAPI使用量を記録する。
    await addUsage({ input: u.input + u.cacheRead + u.cacheWrite, output: u.output, costUsd });
    const stop = checkStop(resp);
    if (!stop.ok) throw fatalError(stop.message);
    if (stop.truncated) throw new Error("字幕の応答が途中で切れました。もう一度お試しください");
    const results = parseSubtitleResult(extractText(resp), input.cues);
    if (ctrl.signal.aborted) throw abortError();
    if (s.cacheEnabled) {
      const serialized = JSON.stringify({ cues: input.cues.map((cue) => ({ id: cue.id, text: results[cue.id] })) });
      await cacheSetMany([{ k: key, t: serialized }]);
    }
    await checkCurrentVideo();
    if (ctrl.signal.aborted) throw abortError();
    return { ok: true, results, usage: { ...u, costUsd }, cached: 0, model: s.model };
  } catch (error) {
    if (timedOut) throw new Error("字幕の翻訳がタイムアウトしました。もう一度お試しください");
    throw error;
  } finally {
    clearTimeout(timeout);
    untrack(msg.sessionId, ctrl);
  }
}

// ---------- 画像翻訳 ----------
async function fetchImage(msg) {
  if (msg.sessionId != null && (typeof msg.sessionId !== "string" || !msg.sessionId || msg.sessionId.length > 160)) throw fatalError("画像のセッションIDが不正です");
  const ctrl = new AbortController();
  track(msg.sessionId, ctrl);
  try { return { ok: true, image: await fetchRemoteImage(msg.url, ctrl.signal) }; }
  finally { untrack(msg.sessionId, ctrl); }
}

async function translateImage(msg) {
  if (typeof msg.sessionId !== "string" || !msg.sessionId || msg.sessionId.length > 160) throw fatalError("画像のセッションIDが不正です");
  // 設定・画像ハッシュ・キャッシュの処理中でも中止を取りこぼさない。
  const ctrl = new AbortController();
  track(msg.sessionId, ctrl);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; ctrl.abort(); }, 60000);
  try {
    const input = normalizeImageRequest(msg);
    const s = await getSettings();
    if (ctrl.signal.aborted) throw abortError();
    if (!s.apiKey) throw fatalError("APIキーが未設定です（拡張の設定画面で登録してください）");
    const system = buildImageSystem(s);
    const message = buildImageMessage(input, s);
    const imageHash = await sha256(input.image.data);
    const key = await sha256(JSON.stringify(["image", IMAGE_VERSION, imageHash, input.image.mediaType, s.model, s.effort, system, message]));
    if (s.cacheEnabled) {
      const hits = await cacheGetMany([key]);
      if (ctrl.signal.aborted) throw abortError();
      if (hits.has(key)) {
        try { return { ok: true, ...parseImageResult(hits.get(key)), usage: null, cached: 1, model: s.model }; }
        catch { /* 壊れたキャッシュは使わず翻訳し直す。画像そのものは保存しない。 */ }
      }
    }
    if (ctrl.signal.aborted) throw abortError();
    const req = buildRequest(s, system, message, { maxTokens: 8000 });
    req.body.messages[0].content = [
      { type: "image", source: { type: "base64", media_type: input.image.mediaType, data: input.image.data } },
      { type: "text", text: message },
    ];
    const response = await fetchWithRetry(req, ctrl.signal);
    const u = usageOf(response);
    const costUsd = estimateCostUsd(s.model, u);
    // APIが返した使用量は、不正JSON・拒否・途中終了・直後の中止でも計上する。
    await addUsage({ input: u.input + u.cacheRead + u.cacheWrite, output: u.output, costUsd });
    if (ctrl.signal.aborted) throw abortError();
    const stop = checkStop(response);
    if (!stop.ok) throw fatalError(stop.message);
    if (stop.truncated) throw new Error("画像翻訳の応答が途中で切れました。文字の少ない範囲に分けてお試しください。");
    const result = parseImageResult(extractText(response));
    if (s.cacheEnabled) await cacheSetMany([{ k: key, t: JSON.stringify({ original: result.original, translation: result.text }) }]);
    if (ctrl.signal.aborted) throw abortError();
    return { ok: true, ...result, usage: { ...u, costUsd }, cached: 0, model: s.model };
  } catch (error) {
    if (timedOut) throw new Error("画像の翻訳がタイムアウトしました。もう一度お試しください。");
    throw error;
  } finally {
    clearTimeout(timeout);
    untrack(msg.sessionId, ctrl);
  }
}

// ---------- 選択範囲の解説 ----------
async function explain(msg) {
  if (msg.sessionId != null && (typeof msg.sessionId !== "string" || !msg.sessionId || msg.sessionId.length > 160)) throw fatalError("解説のセッションIDが不正です");
  const ctrl = new AbortController();
  track(msg.sessionId, ctrl);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; ctrl.abort(); }, 60000);
  try {
    if (msg.model != null && !MODELS.some(({ id }) => id === msg.model)) throw fatalError("選択した解説モデルは使用できません");
    const input = normalizeExplanation(msg);
    const saved = await getSettings();
    if (ctrl.signal.aborted) throw abortError();
    const s = msg.model == null ? saved : { ...saved, model: msg.model };
    if (s.explanationEnabled === false) throw fatalError("解説機能は設定で無効になっています");
    if (!s.apiKey) throw fatalError("APIキーが未設定です（拡張の設定画面で登録してください）");
    const system = buildExplanationSystem(s, input.detail, input.question);
    const message = buildExplanationMessage(input);
    // 文脈・説明の詳しさ・プロンプトが変われば解説も変わる。
    const key = await sha256(JSON.stringify([EXPLAIN_VERSION, s.model, s.effort, system, message]));
    if (s.cacheEnabled) {
      const hits = await cacheGetMany([key]);
      if (ctrl.signal.aborted) throw abortError();
      if (hits.has(key)) return { ok: true, text: hits.get(key), cached: 1, usage: null, model: s.model };
    }
    if (ctrl.signal.aborted) throw abortError();
    const req = buildRequest(s, system, message, { maxTokens: input.detail === "detailed" ? 2800 : 1600 });
    const resp = await fetchWithRetry(req, ctrl.signal);
    const u = usageOf(resp);
    const costUsd = estimateCostUsd(s.model, u);
    await addUsage({ input: u.input + u.cacheRead + u.cacheWrite, output: u.output, costUsd });
    if (ctrl.signal.aborted) throw abortError();
    const stop = checkStop(resp);
    if (!stop.ok) throw fatalError(stop.message);
    let text = extractText(resp).trim();
    if (!text) throw new Error("解説を取得できませんでした");
    if (s.cacheEnabled && !stop.truncated) await cacheSetMany([{ k: key, t: text }]);
    if (ctrl.signal.aborted) throw abortError();
    if (stop.truncated) text += "\n\n（解説が長いため、ここまで表示しています）";
    return { ok: true, text, usage: { ...u, costUsd }, cached: 0, model: s.model };
  } catch (error) {
    if (timedOut) throw new Error("解説の取得がタイムアウトしました。もう一度お試しください。");
    throw error;
  } finally {
    clearTimeout(timeout);
    untrack(msg.sessionId, ctrl);
  }
}

// ---------- HTTP ----------
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

// 429 / 529 / 5xx / ネットワークエラーは待って再試行。それ以外は describeHttpError の内容で即エラー
async function fetchWithRetry(req, signal, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw abortError();
    let res;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal });
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
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : 1500 * attempt, signal);
  }
  throw lastErr || new Error("再試行上限に達しました");
}

// 設定画面の「接続テスト」: 入力中のキー/モデルで 1 回だけ叩く
async function testKey(msg) {
  const base = await getSettings();
  const s = { ...base, apiKey: msg.apiKey || base.apiKey, model: msg.model || base.model, apiBase: msg.apiBase || base.apiBase, effort: "low" };
  if (!s.apiKey) return { ok: false, error: "APIキーが空です" };
  const req = buildRequest(s, "Reply with exactly: OK", "ping", { maxTokens: 512 });
  try {
    const json = await fetchWithRetry(req, new AbortController().signal, 1);
    return { ok: true, model: json.model, text: extractText(json).trim(), costUsd: estimateCostUsd(s.model, usageOf(json)) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
