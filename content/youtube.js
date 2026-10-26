// YouTube の通常動画専用。ユーザーが開始した動画だけを先読みし、再生時刻で表示する。
(() => {
  if (location.hostname !== "www.youtube.com" || globalThis.__tfYouTubeLoaded) return;
  const Timeline = globalThis.TFSubtitleTimeline;
  if (!Timeline) return;
  globalThis.__tfYouTubeLoaded = true;
  const currentVideoId = () => location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") || "" : "";
  const send = (msg) => chrome.runtime.sendMessage(msg);
  const newSession = () => `youtube:${crypto.randomUUID()}`;
  let run = null;
  let host = null;
  let root = null;
  let nativeStyle = null;
  let timer = null;
  let status = "idle";
  let error = "";
  let mode = "bilingual";
  let targetLang = "English";
  let lastKeepAlive = 0;

  function state() {
    return { ok: true, supported: /^[\w-]{11}$/.test(currentVideoId()), status, error, mode, targetLang,
      sourceLabel: run?.sourceLabel || "", sourceLang: run?.sourceLang || "",
      done: run?.translated.size || 0, total: run?.cues.length || 0,
      usage: run?.usage || { costUsd: 0, requests: 0, cached: 0 } };
  }
  function player() { return document.getElementById("movie_player"); }
  function video() { return player()?.querySelector("video"); }
  function active(r) { return run === r && r.videoId === currentVideoId(); }
  function removeUi() {
    nativeStyle?.remove(); nativeStyle = null;
    host?.remove(); host = root = null;
  }
  function stop() {
    const old = run;
    run = null;
    if (old) send({ type: "cancel", sessionId: old.sessionId }).catch(() => {});
    clearInterval(timer); timer = null;
    removeUi(); status = "idle"; error = "";
  }
  function mount() {
    const p = player();
    if (!p) throw new Error("動画プレイヤーが見つかりません。動画を開いてから開始してください");
    if (host?.parentElement === p) return;
    removeUi();
    document.querySelectorAll("#tf-youtube-subtitles[data-tf]").forEach((el) => el.remove());
    host = document.createElement("div");
    host.id = "tf-youtube-subtitles"; host.dataset.tf = "subtitles";
    host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:60;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{all:initial}*{box-sizing:border-box}[hidden]{display:none!important}
      .captions{position:absolute;left:6%;right:6%;bottom:13%;text-align:center;color:#fff;font-family:system-ui,sans-serif;line-height:1.5;pointer-events:none}
      .line{width:fit-content;max-width:100%;margin:3px auto;padding:3px 12px;border-radius:6px;background:rgba(20,19,17,.86);white-space:pre-wrap;overflow-wrap:anywhere;font-size:clamp(17px,2.1vw,30px)}
      .original{font-size:clamp(13px,1.5vw,21px);color:#e2dfd7}
      .notice{color:#e2dfd7;font-size:12px}.tools{position:absolute;top:12px;left:12px;display:flex;gap:8px;align-items:center;max-width:85%;font:12px/1.6 system-ui,sans-serif;color:#eee9df}
      .tools button{font:inherit;border:1px solid #625e54;border-radius:8px;background:rgba(36,34,30,.88);color:#eee9df;padding:5px 10px;cursor:pointer;pointer-events:auto}
      .tools button:focus-visible{outline:2px solid #eee9df;outline-offset:3px}
      .status{border-radius:6px;background:rgba(36,34,30,.88);padding:4px 8px;white-space:pre-wrap;overflow-wrap:anywhere}
    </style><div class="tools"><button type="button" aria-label="Yomeru の字幕を停止" title="字幕を停止">yomeru ×</button><span class="status" role="status" aria-live="polite"></span></div><div class="captions"><div class="line translated" lang="en" hidden></div><div class="line original" hidden></div><div class="line notice" hidden>翻訳を準備しています…</div></div>`;
    root.querySelector("button").addEventListener("click", stop);
    p.append(host);
    nativeStyle = document.createElement("style"); nativeStyle.dataset.tf = "subtitles";
    nativeStyle.textContent = "#movie_player .ytp-caption-window-container{visibility:hidden!important}";
    // 元の字幕の設定は変更せず、開始中だけ表示を隠す。停止時にstyleを外して復元する。
  }
  function showStatus(text) {
    if (!root) return;
    const node = root.querySelector(".status");
    if (node.textContent !== text) node.textContent = text;
    node.hidden = !text;
  }
  function fail(message) {
    status = "error"; error = String(message);
    nativeStyle?.remove();
    if (root) {
      root.querySelector(".captions").hidden = true;
      showStatus(error);
    }
  }
  function render(r) {
    if (!active(r)) return;
    mount();
    const p = player(), v = video();
    const ad = p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting");
    host.hidden = ad;
    if (ad || status === "error") { nativeStyle?.remove(); return; }
    if (status === "loading") { showStatus("字幕を読み込んでいます…"); return; }
    if (!nativeStyle.isConnected) p.append(nativeStyle);
    root.querySelector(".captions").hidden = false;
    const i = Timeline.indexAt(r.cues, v?.currentTime || 0);
    const c = r.cues[i], translated = c && r.translated.get(c.id);
    const line = root.querySelector(".translated"), original = root.querySelector(".original");
    line.textContent = translated || ""; line.hidden = !translated;
    line.lang = targetLang === "日本語" ? "ja" : "en";
    original.textContent = c?.text || ""; original.hidden = !c || (mode !== "bilingual" && !!translated);
    original.lang = r.sourceLang;
    root.querySelector(".notice").hidden = !c || !!translated;
    showStatus(!c && r.busy ? "字幕を先読みしています…" : "");
  }
  async function pump(r) {
    if (!active(r) || status !== "active" || r.busy || !video()) return;
    const p = player();
    if (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")) return;
    const time = video().currentTime || 0;
    const idx = Timeline.nextBatch(r.groups, time, r.translated);
    if (idx < 0) return;
    const cues = r.groups[idx];
    const first = cues[0].id, last = cues.at(-1).id;
    const ticket = ++r.ticket;
    r.busy = true; r.pendingIndex = idx;
    try {
      const response = await send({ type: "translateSubtitles", sessionId: r.sessionId, videoId: r.videoId,
        targetLang: r.targetLang, sourceLang: r.sourceLang, cues,
        context: { title: r.title, ...Timeline.context(r.cues, first, last) } });
      if (!active(r) || ticket !== r.ticket) return;
      if (!response?.ok) throw new Error(response?.error || "字幕を翻訳できませんでした。もう一度開始してください");
      for (const cue of cues) {
        const text = response.results?.[cue.id];
        if (typeof text !== "string" || !text.trim()) throw new Error("字幕の翻訳結果が不足しています。もう一度開始してください");
        r.translated.set(cue.id, text);
      }
      if (response.usage) { r.usage.costUsd += response.usage.costUsd || 0; r.usage.requests++; }
      r.usage.cached += response.cached || 0;
    } catch (e) {
      if (active(r) && ticket === r.ticket) fail(e.message || e);
    } finally {
      if (active(r) && ticket === r.ticket) { r.busy = false; r.pendingIndex = -1; render(r); }
    }
  }
  function tick() {
    const r = run;
    if (!r) return;
    if (!active(r)) { stop(); return; }
    if (!player() || !video()) { stop(); return; }
    const time = video().currentTime || 0;
    if (r.busy && r.pendingIndex >= 0 && Math.abs(time - r.lastTime) > 8) {
      const pending = r.groups[r.pendingIndex];
      if (time < pending[0].start - 40 || time > pending.at(-1).end) {
        send({ type: "cancel", sessionId: r.sessionId }).catch(() => {});
        r.sessionId = newSession(); r.ticket++; r.busy = false; r.pendingIndex = -1;
      }
    }
    r.lastTime = time;
    try { render(r); } catch (e) { fail(e.message || e); }
    if (r.busy && Date.now() - lastKeepAlive > 20000) { lastKeepAlive = Date.now(); send({ type: "tf:keepalive" }).catch(() => {}); }
    pump(r).catch((e) => { if (active(r)) fail(e.message || e); });
  }
  async function start(options = {}) {
    stop();
    const id = currentVideoId();
    if (!/^[\w-]{11}$/.test(id)) { fail("YouTube の通常動画ページで開始してください"); return; }
    if (!video()) { fail("動画の読み込みが終わってから開始してください"); return; }
    targetLang = options.targetLang === "日本語" ? "日本語" : "English";
    mode = options.mode === "replace" ? "replace" : "bilingual";
    const r = { videoId: id, targetLang, sessionId: newSession(), title: document.title, sourceLang: "", sourceLabel: "",
      cues: [], groups: [], translated: new Map(), usage: { costUsd: 0, requests: 0, cached: 0 }, busy: false, ticket: 0, pendingIndex: -1, lastTime: video().currentTime || 0 };
    run = r; status = "loading"; error = "";
    mount(); render(r);
    timer = setInterval(tick, 250);
    try {
      const settings = await send({ type: "getSettings" });
      if (!active(r)) return;
      if (!settings?.settings?.hasKey) throw new Error("APIキーが未設定です。Yomeru の設定画面で登録してください");
      const result = await send({ type: "getYouTubeCaptions", videoId: id });
      if (!active(r)) return;
      if (!result?.ok) throw new Error(result?.error || "字幕を取得できませんでした");
      if (result.videoId !== id) throw new Error("動画が切り替わりました。もう一度開始してください");
      r.cues = Timeline.normalize(result.cues);
      if (!r.cues.length) throw new Error("字幕がありません。字幕付きの動画でお試しください");
      r.groups = Timeline.batches(r.cues); r.sourceLang = result.sourceLang || "";
      r.sourceLabel = result.sourceLabel || "元の字幕"; r.title = result.title || document.title;
      status = "active"; tick();
    } catch (e) { if (active(r)) fail(e.message || e); }
  }
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    switch (msg?.type) {
      case "tf:youtubeState": respond(state()); return false;
      case "tf:youtubeStart": start(msg).catch((e) => fail(e.message || e)); respond({ ok: true }); return false;
      case "tf:youtubeStop": stop(); respond(state()); return false;
      case "tf:youtubeMode": mode = msg.mode === "replace" ? "replace" : "bilingual"; if (run) render(run); respond(state()); return false;
      default: return false;
    }
  });
  document.addEventListener("yt-navigate-start", stop);
  window.addEventListener("pagehide", stop);
})();
