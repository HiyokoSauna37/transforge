// YouTube の視聴ページに既に渡されている字幕と文字起こしを取得する。
// API キーや拡張の設定は MAIN world に渡さない。
const VIDEO_ID = /^[\w-]{11}$/;
const MAX_CUES = 20000;
const MAX_TEXT = 800000;

function watchId(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://www.youtube.com" && url.pathname === "/watch" ? url.searchParams.get("v") : null;
  } catch { return null; }
}

export async function loadYouTubeCaptions(sender, expectedVideoId) {
  // SPA で sender.url が最初の動画/ホームを指す場合もある。現在動画は直後の tabs.get で判定する。
  let senderOrigin = "";
  try { senderOrigin = new URL(sender?.url).origin; } catch { /* 不正な送信元 */ }
  if (!sender?.tab?.id || sender.frameId !== 0 || !VIDEO_ID.test(expectedVideoId || "") || senderOrigin !== "https://www.youtube.com") {
    return { ok: false, error: "YouTube の通常の動画ページで字幕を開始してください。" };
  }
  try {
    const tab = await chrome.tabs.get(sender.tab.id);
    if (watchId(tab.url) !== expectedVideoId) return { ok: false, error: "動画が切り替わりました。もう一度開始してください。" };
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [0] }, world: "MAIN", func: extractYouTubeCaptions, args: [expectedVideoId],
    });
    const current = await chrome.tabs.get(sender.tab.id);
    if (watchId(current.url) !== expectedVideoId) return { ok: false, error: "動画が切り替わりました。もう一度開始してください。" };
    const result = injection?.result;
    if (!result?.ok) return { ok: false, error: typeof result?.error === "string" ? result.error.slice(0,500) : "字幕を取得できませんでした。動画の文字起こしを開いてから、もう一度お試しください。" };
    // ページのデータは未信頼。返値を再検証し、必要なフィールドだけ拡張へ返す。
    if (result.videoId !== expectedVideoId || !Array.isArray(result.cues) || !result.cues.length || result.cues.length > MAX_CUES) throw new Error("字幕データの形式が正しくありません。");
    let total = 0;
    let lastStart = -1;
    const cues = result.cues.map((cue) => {
      if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.start < lastStart || cue.end <= cue.start || cue.end > 86400 || typeof cue.text !== "string" || !cue.text.trim() || cue.text.length > 2000) throw new Error("字幕データの形式が正しくありません。");
      total += cue.text.length;
      if (total > MAX_TEXT) throw new Error("字幕が長すぎます。より短い動画でお試しください。");
      lastStart = cue.start;
      return { start: cue.start, end: cue.end, text: cue.text };
    });
    return { ok: true, videoId: expectedVideoId, title: String(result.title || "").slice(0,300), sourceLang: String(result.sourceLang || "auto").slice(0,40), sourceLabel: String(result.sourceLabel || "YouTubeの字幕").slice(0,120), cues };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0,500) };
  }
}

// chrome.scripting によって関数本体だけがコピーされるため、依存を内部にまとめる。
export async function extractYouTubeCaptions(expectedVideoId) {
  const MAX_BYTES = 3 * 1024 * 1024;
  const MAX_ROWS = 20000;
  const NAVIGATED = "動画が切り替わりました。もう一度開始してください。";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const textOf = (value) => typeof value?.simpleText === "string" ? value.simpleText : Array.isArray(value?.runs) ? value.runs.map((r) => r.text || "").join("") : "";
  const clean = (value) => String(value || "").replace(/[\u200B\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const player = () => document.getElementById("movie_player");
  function current() {
    const u = new URL(location.href);
    if (u.origin !== "https://www.youtube.com" || u.pathname !== "/watch" || u.searchParams.get("v") !== expectedVideoId) throw new Error(NAVIGATED);
    const id = document.querySelector("ytd-watch-flexy")?.getAttribute("video-id");
    if (id && id !== expectedVideoId) throw new Error(NAVIGATED);
  }
  function response() {
    let data;
    try { data = player()?.getPlayerResponse?.(); } catch { /* プレイヤーの準備中 */ }
    if (data?.videoDetails?.videoId === expectedVideoId) return data;
    data = window.ytInitialPlayerResponse;
    return data?.videoDetails?.videoId === expectedVideoId ? data : null;
  }
  function normalize(rows, duration) {
    if (!rows.length || rows.length > MAX_ROWS) return [];
    rows = rows.filter((r) => Number.isFinite(r.start) && r.start >= 0 && r.start < 86400 && clean(r.text)).map((r) => ({ ...r, text: clean(r.text) })).sort((a,b) => a.start - b.start);
    const out = [];
    let total = 0;
    for (let i=0; i<rows.length; i++) {
      const r = rows[i];
      if (r.text.length > 2000 || (total += r.text.length) > 800000) throw new Error("字幕が長すぎます。より短い動画でお試しください。");
      const next = rows[i+1]?.start;
      let end = Number.isFinite(r.end) && r.end > r.start ? r.end : Number.isFinite(next) && next > r.start ? next : Number.isFinite(duration) && duration > r.start ? Math.min(duration, r.start + 8) : r.start + 8;
      if (Number.isFinite(next) && next > r.start) end = Math.min(end, next);
      end = Math.min(end, 86400);
      if (end <= r.start) continue;
      const previous = out[out.length-1];
      if (previous && previous.start === r.start) {
        if (previous.text !== r.text) previous.text += " " + r.text;
        if (previous.text.length > 2000) throw new Error("字幕が長すぎます。より短い動画でお試しください。");
        previous.end = Math.max(previous.end, end);
        continue;
      }
      out.push({ start: r.start, end, text: r.text });
    }
    for (let i=0; i<out.length-1; i++) out[i].end = Math.min(out[i].end, out[i+1].start);
    return out;
  }
  function parse(body, duration) {
    if (body.trim().startsWith("{")) {
      const events = JSON.parse(body).events;
      if (!Array.isArray(events)) return [];
      const rows = [];
      for (const event of events) {
        if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;
        const text = event.segs.map((s) => s.utf8 || "").join("");
        if (!clean(text)) continue;
        const row = { start: event.tStartMs/1000, end: (event.tStartMs + (Number(event.dDurationMs) || 0))/1000, text };
        const previous = rows[rows.length-1];
        if (event.aAppend && previous && previous.window === event.wWinId) {
          previous.text += text;
          previous.end = Math.max(previous.end, row.end);
        } else rows.push({ ...row, window: event.wWinId });
      }
      return normalize(rows, duration);
    }
    const xml = new DOMParser().parseFromString(body, "text/xml");
    if (xml.querySelector("parsererror")) return [];
    const nodes = [...xml.querySelectorAll("transcript > text, timedtext body > p")];
    return normalize(nodes.map((el) => {
      const ms = el.localName === "p";
      const scale = ms ? 1000 : 1;
      const start = Number(el.getAttribute(ms ? "t" : "start"))/scale;
      const dur = Number(el.getAttribute(ms ? "d" : "dur"))/scale;
      return { start, end: start+dur, text: el.textContent };
    }), duration);
  }
  function timestamp(value) {
    const parts = clean(value).split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d{1,3}$/.test(p))) return NaN;
    if (parts.slice(1).some((p) => Number(p) >= 60)) return NaN;
    return parts.reduce((n,p) => n*60 + Number(p), 0);
  }
  function transcript(duration) {
    const nodes = [...document.querySelectorAll("transcript-segment-view-model, ytd-transcript-segment-renderer")].filter((el) => {
      const panel = el.closest("ytd-engagement-panel-section-list-renderer");
      return el.getClientRects().length && (!panel || panel.getAttribute("visibility") !== "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    });
    if (!nodes.length || nodes.length > MAX_ROWS) return [];
    const panel = nodes[0].closest("ytd-engagement-panel-section-list-renderer");
    if (panel && [...panel.querySelectorAll("input")].some((e) => e.value?.trim())) throw new Error("文字起こしの検索欄を空にしてから、もう一度開始してください。");
    const rows = nodes.map((el) => {
      const time = el.querySelector(".ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp");
      const text = el.querySelector("span[role=text], .segment-text");
      return { start: timestamp(time?.textContent), text: text?.textContent || "" };
    });
    return normalize(rows, duration);
  }
  function safeCaptionUrl(value) {
    try {
      const u = new URL(value);
      return u.origin === "https://www.youtube.com" && u.pathname === "/api/timedtext" && u.searchParams.get("v") === expectedVideoId && !u.username && !u.password ? u : null;
    } catch { return null; }
  }
  async function fetchBody(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    try {
      const res = await fetch(url.href, { credentials: "same-origin", signal: ctrl.signal, redirect: "error" });
      if (!res.ok || Number(res.headers.get("content-length")) > MAX_BYTES || !res.body) return "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let size = 0, result = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BYTES) { await reader.cancel(); return ""; }
          result += decoder.decode(value, { stream: true });
        }
        return result + decoder.decode();
      } finally { reader.releaseLock(); }
    } finally { clearTimeout(timer); }
  }
  try {
    current();
    let data = response();
    for (let i=0; !data && i<12; i++) { await wait(200); current(); data = response(); }
    if (!data) throw new Error("動画プレイヤーの準備ができていません。少し待ってから、もう一度開始してください。");
    if (data.videoDetails?.isLive || data.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow) throw new Error("ライブ配信はまだ対応していません。通常の動画でお試しください。");
    const duration = Number(data.videoDetails?.lengthSeconds) || document.querySelector("#movie_player video")?.duration;
    const title = String(data.videoDetails?.title || document.title).slice(0,300);
    const finish = (cues, sourceLang, sourceLabel) => { current(); if (!response()) throw new Error(NAVIGATED); return { ok: true, videoId: expectedVideoId, title, sourceLang, sourceLabel, cues }; };
    let cues = transcript(duration);
    if (cues.length) return finish(cues, "auto", "YouTubeの文字起こし");
    const list = data.captions?.playerCaptionsTracklistRenderer;
    const tracks = Array.isArray(list?.captionTracks) ? list.captionTracks.slice(0,200) : [];
    let active;
    try { active = player()?.getOption?.("captions", "track"); } catch { /* 字幕が無効 */ }
    const audio = list?.audioTracks?.[list.defaultAudioTrackIndex || 0];
    const track = tracks.find((t) => t.vssId && t.vssId === (active?.vssId || active?.vss_id))
      || tracks[audio?.defaultCaptionTrackIndex]
      || tracks.find((t) => t.kind === "asr")
      || tracks.find((t) => t.languageCode === "en") || tracks[0];
    if (track) {
      const url = safeCaptionUrl(track.baseUrl);
      if (url) {
        url.searchParams.set("fmt", "json3");
        try { cues = parse(await fetchBody(url), duration); } catch { /* 署名の失効、空応答などは文字起こしへ */ }
        current();
        if (cues.length) return finish(cues, track.languageCode || "auto", textOf(track.name) || track.languageCode || "YouTubeの字幕");
      }
    }
    // ユーザーが字幕機能を開始した時だけ、YouTube 自身の文字起こしボタンを使う。
    // 未公開 API のリクエストや認証情報の再現はせず、通常の UI が取得した表示を読む。
    const visible = (el) => el.getClientRects().length && !el.disabled && el.getAttribute("aria-disabled") !== "true";
    const transcriptButton = () => [...document.querySelectorAll("ytd-video-description-transcript-section-renderer button")].find(visible);
    let button = transcriptButton();
    if (!button) {
      const expand = document.querySelector("ytd-watch-metadata #description-inline-expander #expand, ytd-watch-metadata #expand");
      if (expand && visible(expand)) expand.click();
      for (let i=0; !button && i<8; i++) { await wait(150); current(); button = transcriptButton(); }
    }
    if (button) {
      current(); button.click();
      // 新旧 UI の両方を待ち、生成途中の短いリストを読み切ったと扱わない。
      let previousCount = 0;
      let stable = 0;
      for (let i=0; i<32; i++) {
        await wait(200); current();
        cues = transcript(duration);
        if (cues.length && cues.length === previousCount) stable++; else stable = 0;
        if (stable >= 2) return finish(cues, "auto", "YouTubeの文字起こし");
        previousCount = cues.length;
      }
    }
    return { ok: false, error: "字幕を取得できませんでした。YouTube の「文字起こしを表示」を開いてから、もう一度開始してください。字幕のない動画には対応していません。" };
  } catch (error) { return { ok: false, error: String(error?.message || error).slice(0,500) }; }
}
