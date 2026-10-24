// TransForge content script: ページ翻訳の進行・適用・復元、選択範囲翻訳、UI（shadow DOM）
(() => {
  if (globalThis.__tfLoaded) return;
  globalThis.__tfLoaded = true;
  const Seg = globalThis.TFSeg;
  if (!Seg) return;

  const state = {
    status: "idle", // idle | running | translated
    mode: "replace",
    sessionId: null,
    records: [],
    progress: { done: 0, total: 0 },
    usage: { input: 0, output: 0, costUsd: 0, cached: 0, requests: 0, model: null },
    error: null,
    settings: null,
    incrementalRuns: 0,
  };
  let done = new WeakSet(); // 翻訳済み（原文ノード + 生成ノード）
  const translatedText = new WeakMap(); // in-place で書き換えた text node → 訳文
  let cancelled = false;
  let pendingUnits = null;
  let observer = null;
  let observerTimer = null;
  let suppressed = false;
  let keepAliveTimer = null;

  // ---------- messaging ----------
  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message));
          else resolve(r);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function loadSettings() {
    const r = await send({ type: "getSettings" });
    if (!r || !r.ok) throw new Error((r && r.error) || "設定を取得できません");
    state.settings = r.settings;
    return r.settings;
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => { send({ type: "tf:keepalive" }).catch(() => {}); }, 20000);
  }
  function stopKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  // ---------- UI (shadow DOM) ----------
  const ui = {};
  // 羽根ロゴ(icons/feather.svg と同一。tools/make_icons.py が生成)
  const FE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" class="fe"><g transform="rotate(38 64 64)" fill="none" stroke-linecap="round"><path class="fe-c" d="M64 90 C64 100 65 110 67 122" stroke="#FAF9F5" stroke-width="6"/><path class="fe-c" d="M64 12 C40 28 30 64 46 92 C52 95 58 96 64 96 C70 96 74 94 78 90 C92 64 86 30 64 12 Z" fill="#FAF9F5" stroke="none"/><path class="fe-x" d="M64 20 C62 48 62 86 64 92" stroke="#D97757" stroke-width="2.6"/><path class="fe-x" d="M62 50 L37 36 M62 72 L33 62 M66 60 L92 48" stroke="#D97757" stroke-width="3.2"/></g></svg>';
  function ensureUi() {
    if (ui.host && ui.host.isConnected) return ui;
    const host = document.createElement("div");
    host.setAttribute("data-tf", "ui");
    host.id = "tf-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
<style>
:host{all:initial}
*{box-sizing:border-box}
.badge,.panel,.selbtn{
  --bg:#FFFFFF;--bg2:#F2F0E9;--line:#E7E4DB;--line2:#D8D4C8;--accent:#D97757;--accent2:#C4623F;--accent-soft:#F7E9E1;
  --ink:#1F1E1D;--ink2:#5E5C57;--muted:#8E8B82;--ok:#5B8A5F;--err:#C0493D;--err-soft:#F9E6E3;
  --shadow:0 1px 2px rgba(31,30,29,.06),0 10px 30px rgba(31,30,29,.12);
  font-family:"TransForge Rounded","M PLUS Rounded 1c","Hiragino Maru Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif;
  color:var(--ink);line-height:1.6;letter-spacing:.01em;-webkit-font-smoothing:antialiased
}
@media (prefers-color-scheme: dark){
  .badge,.panel,.selbtn{--bg:#30302E;--bg2:#3A3936;--line:#3E3D39;--line2:#4C4A45;--ink:#ECEAE3;--ink2:#B8B5AC;--muted:#8C8982;
    --accent-soft:#473730;--err-soft:#45302D;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35)}
}
.badge{position:fixed;right:18px;bottom:18px;display:flex;align-items:center;gap:10px;overflow:hidden;
  background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:9px 14px 9px 14px;font-size:12.5px;
  box-shadow:var(--shadow);min-width:200px;max-width:440px}
.badge .tag{width:18px;height:18px;border-radius:6px;background:var(--accent);display:flex;align-items:center;justify-content:center;flex:none}
.tag svg,.mk svg{width:13px;height:13px;display:block}
.selbtn svg{width:14px;height:14px;display:block;margin-right:5px}
.fe-x{stroke:var(--accent)}
.selbtn:hover .fe-x{stroke:var(--accent2)}
.badge .txt{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink2)}
.badge.err{border-radius:14px}
.badge.err .txt{color:var(--err);white-space:normal}
.badge .bar{height:3px;background:var(--bg2);position:absolute;left:0;right:0;bottom:0}
.badge .bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .25s}
.badge .spin{width:10px;height:10px;border:2px solid var(--accent);border-right-color:transparent;border-radius:50%;animation:tfspin .8s linear infinite;flex:none}
@keyframes tfspin{to{transform:rotate(360deg)}}
.badge button,.panel button{font:inherit;font-size:11.5px;cursor:pointer;background:var(--bg2);border:1px solid transparent;color:var(--ink2);padding:3px 11px;border-radius:999px}
.badge button:hover,.panel button:hover{background:var(--accent-soft);color:var(--accent2)}
.selbtn{position:fixed;display:flex;align-items:center;background:var(--accent);border:none;color:#fff;font-size:12px;font-weight:700;
  padding:4px 11px 4px 8px;border-radius:999px;cursor:pointer;box-shadow:0 2px 10px rgba(217,119,87,.4)}
.selbtn:hover{background:var(--accent2)}
.panel{position:fixed;width:min(460px,calc(100vw - 32px));max-height:min(60vh,520px);display:flex;flex-direction:column;
  background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);font-size:14px;overflow:hidden}
.panel .ph{display:flex;align-items:center;gap:10px;padding:9px 12px 9px 14px;border-bottom:1px solid var(--line);background:var(--bg)}
.panel .ph .t{color:var(--ink);font-size:12.5px;font-weight:600;flex:1;display:flex;align-items:center;gap:8px}
.panel .ph .t .mk{width:18px;height:18px;border-radius:6px;background:var(--accent);display:inline-flex;align-items:center;justify-content:center;flex:none}
.panel .ph .cost{color:var(--muted);font-size:11px}
.panel .ph .x{background:transparent;font-size:17px;padding:0 6px;line-height:1;color:var(--muted)}
.panel .pb{padding:12px 16px 14px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--ink);line-height:1.75}
.panel .pb.wait{color:var(--muted)}
.panel .po{padding:10px 16px;border-top:1px dashed var(--line);color:var(--ink2);font-size:12.5px;white-space:pre-wrap;overflow:auto;max-height:140px;background:var(--bg2)}
.panel .pf{display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--line)}
[hidden]{display:none !important}
</style>
<div class="badge" hidden><span class="tag">${FE}</span><span class="spin"></span><span class="txt"></span><button class="stop">中止</button><div class="bar"><i></i></div></div>
<button class="selbtn" hidden>${FE}翻訳</button>
<div class="panel" hidden>
  <div class="ph"><span class="t"><span class="mk">${FE}</span>Claude 翻訳</span><span class="cost"></span><button class="x" title="閉じる">×</button></div>
  <div class="pb"></div>
  <div class="po" hidden></div>
  <div class="pf"><button class="copy">コピー</button><button class="orig">原文を表示</button></div>
</div>`;
    (document.documentElement || document.body).appendChild(host);
    ui.host = host;
    ui.root = root;
    ui.badge = root.querySelector(".badge");
    ui.badgeTxt = root.querySelector(".badge .txt");
    ui.badgeSpin = root.querySelector(".badge .spin");
    ui.badgeStop = root.querySelector(".badge .stop");
    ui.badgeBar = root.querySelector(".badge .bar i");
    ui.selbtn = root.querySelector(".selbtn");
    ui.panel = root.querySelector(".panel");
    ui.pb = root.querySelector(".panel .pb");
    ui.po = root.querySelector(".panel .po");
    ui.pcost = root.querySelector(".panel .cost");
    ui.badgeStop.addEventListener("click", () => cancel());
    root.querySelector(".panel .x").addEventListener("click", hidePanel);
    root.querySelector(".panel .copy").addEventListener("click", () => {
      navigator.clipboard.writeText(ui.pb.textContent || "").catch(() => {});
    });
    root.querySelector(".panel .orig").addEventListener("click", () => { ui.po.hidden = !ui.po.hidden; });
    ui.selbtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    ui.selbtn.addEventListener("click", (e) => { e.stopPropagation(); translateSelection(); });
    return ui;
  }

  let badgeTimer = null;
  function showBadge(text, kind = "info", autoHide = 0) {
    ensureUi();
    ui.badge.hidden = false;
    ui.badge.classList.toggle("err", kind === "error");
    ui.badgeTxt.textContent = text;
    ui.badgeSpin.hidden = kind !== "busy";
    ui.badgeStop.hidden = kind !== "busy";
    if (kind !== "busy") ui.badgeBar.style.width = kind === "done" ? "100%" : "0";
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = autoHide ? setTimeout(hideBadge, autoHide) : null;
  }
  function hideBadge() {
    if (ui.badge) ui.badge.hidden = true;
  }
  function updateBadge() {
    const { done: d, total } = state.progress;
    showBadge(`翻訳中 ${d}/${total}`, "busy");
    ui.badgeBar.style.width = total ? `${Math.round((d / total) * 100)}%` : "0";
  }

  function costText(usd) {
    const rate = (state.settings && state.settings.usdJpy) || 150;
    const jpy = usd * rate;
    const usdS = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
    const jpyS = jpy < 1 ? `¥${jpy.toFixed(2)}` : `¥${Math.round(jpy).toLocaleString("ja-JP")}`;
    return `${usdS} ≈ ${jpyS}`;
  }

  // ---------- observer ----------
  function suppress(fn) {
    suppressed = true;
    try { return fn(); } finally {
      if (observer) observer.takeRecords();
      suppressed = false;
    }
  }
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      if (suppressed || state.status !== "translated") return;
      let interesting = false;
      for (const m of muts) {
        if (m.type === "characterData") {
          const n = m.target;
          if (done.has(n)) {
            const t = translatedText.get(n);
            if (t != null && n.data !== t) { done.delete(n); interesting = true; } // ページ側が書き戻した
          } else interesting = true;
          continue;
        }
        if (m.target && m.target.nodeType === 1 && m.target.hasAttribute("data-tf")) continue;
        if (m.type === "childList") {
          for (const n of m.addedNodes) if (!done.has(n) && !(n.nodeType === 1 && n.hasAttribute("data-tf"))) { interesting = true; break; }
        } else interesting = true;
        if (interesting) break;
      }
      if (interesting) scheduleRescan();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["open", "hidden", "class", "style"],
    });
  }
  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = null;
  }
  function scheduleRescan() {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(async () => {
      observerTimer = null;
      if (state.status !== "translated" || state.incrementalRuns >= 60) return;
      const s = state.settings || (await loadSettings().catch(() => null));
      if (!s) return;
      const units = Seg.collectUnits(document.body, { exclude: done, targetLang: s.targetLang, skipNav: s.skipNav });
      if (!units.length) return;
      state.incrementalRuns++;
      await runUnits(units, s, { quiet: true });
    }, 700);
  }

  // ---------- translate ----------
  async function translatePage(opts = {}) {
    if (state.status === "running") return;
    state.error = null;
    const settings = await loadSettings();
    if (!settings.hasKey) {
      showBadge("APIキーが未設定です。拡張の設定画面で登録してください", "error", 5000);
      return;
    }
    const mode = opts.mode || settings.displayMode || "replace";
    if (state.status === "translated" && state.mode !== mode) restorePage();
    state.mode = mode;
    const units = Seg.collectUnits(document.body, { exclude: done, targetLang: settings.targetLang, skipNav: settings.skipNav });
    if (!units.length) {
      if (state.status !== "translated") showBadge("翻訳する文が見つかりません", "info", 2500);
      return;
    }
    await runUnits(units, settings, {});
  }

  function pool(items, n, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length && !cancelled) {
        const item = items[i++];
        await worker(item);
      }
    });
    return Promise.all(runners);
  }

  async function requestBatch(batch, context, sessionId, nocache) {
    try {
      const r = await send({
        type: "translate",
        sessionId,
        nocache: !!nocache,
        context,
        segments: batch.map((u) => ({ id: u.id, text: u.text })),
      });
      return r || { ok: false, error: "応答なし" };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  async function runUnits(units, settings, { quiet = false } = {}) {
    cancelled = false;
    const wasTranslated = state.status === "translated";
    state.status = "running";
    state.error = null;
    const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    state.sessionId = sessionId;
    Seg.sortByViewport(units);
    units.forEach((u, i) => { u.id = i; for (const n of u.nodes) done.add(n); });
    pendingUnits = new Set(units); // 適用できなかったものは最後に done から外して再試行可能にする
    const batches = Seg.makeBatches(units, settings.batchChars || 2500);
    state.progress = { done: 0, total: units.length };
    startKeepAlive();
    if (!quiet) updateBadge();
    const context = { title: document.title, url: location.href };
    const retry = [];
    let fatal = null;

    await pool(batches, settings.concurrency || 4, async (batch) => {
      if (cancelled || fatal) return;
      const r = await requestBatch(batch, context, sessionId, false);
      if (cancelled) return;
      if (!r.ok) {
        if (r.fatal) { fatal = r.error; cancelled = true; }
        else state.error = r.error;
        for (const u of batch) retry.push(u);
      } else {
        applyBatch(batch, r.results, retry);
        addUsage(r);
      }
      state.progress.done += batch.length;
      if (!quiet) updateBadge();
    });

    // 失敗・欠落したものを単体で再試行（キャッシュを避けて再生成）
    if (!cancelled && !fatal && retry.length) {
      const again = retry.splice(0, 40);
      await pool(again, Math.min(4, settings.concurrency || 4), async (u) => {
        if (cancelled) return;
        const r = await requestBatch([u], context, sessionId, true);
        if (cancelled) return;
        if (!r.ok) { if (r.fatal) { fatal = r.error; cancelled = true; } else state.error = r.error; return; }
        addUsage(r);
        const t = r.results[u.id];
        if (t == null) return;
        const tree = Seg.parseTranslated(t, u.kinds);
        if (tree) applyUnit(u, tree, false);
        else applyLoose(u, t);
      });
    }
    stopKeepAlive();
    state.sessionId = null;
    for (const u of pendingUnits) for (const n of u.nodes) done.delete(n);
    pendingUnits = null;
    if (fatal) {
      state.error = fatal;
      state.status = state.records.length ? "translated" : "idle";
      showBadge(fatal, "error", 8000);
    } else if (cancelled && !wasTranslated && !state.records.length) {
      state.status = "idle";
      showBadge("中止しました", "info", 2000);
    } else {
      state.status = "translated";
      if (!quiet) {
        const msg = state.error
          ? `一部失敗: ${state.error}`
          : `翻訳完了 · ${costText(state.usage.costUsd)}${state.usage.cached ? ` · キャッシュ ${state.usage.cached}` : ""}`;
        showBadge(msg, state.error ? "error" : "done", state.error ? 8000 : 3500);
      }
    }
    if (state.status === "translated") startObserver();
  }

  function addUsage(r) {
    if (r.usage) {
      state.usage.input += r.usage.input + (r.usage.cacheRead || 0) + (r.usage.cacheWrite || 0);
      state.usage.output += r.usage.output;
      state.usage.costUsd += r.usage.costUsd || 0;
      state.usage.requests++;
      state.usage.model = r.model || state.usage.model;
    }
    state.usage.cached += r.cached || 0;
  }

  function applyBatch(batch, results, retry) {
    for (const u of batch) {
      const t = results && results[u.id];
      if (t == null) { retry.push(u); continue; }
      const tree = Seg.parseTranslated(t, u.kinds);
      if (!tree) { retry.push(u); continue; }
      applyUnit(u, tree, false);
    }
  }

  function markGenerated(frag) {
    const walk = (n) => {
      done.add(n);
      if (n.nodeType === 1) n.setAttribute("data-tf", "gen");
      for (const c of n.childNodes) walk(c);
    };
    for (const c of frag.childNodes) walk(c);
  }

  function applyUnit(u, tree, loose) {
    if (!u.nodes[0].isConnected) return;
    if (pendingUnits) pendingUnits.delete(u);
    suppress(() => {
      if (state.mode === "bilingual") {
        const frag = Seg.build(tree, u, { stripId: true });
        markGenerated(frag);
        insertBilingual(u, frag, loose);
        return;
      }
      // replace: まず in-place（元ノードを残す）を試み、構造が違えばクローン置換
      const inplace = loose ? null : Seg.applyInPlace(tree, u);
      if (inplace) {
        for (const n of inplace.touched) { done.add(n); translatedText.set(n, n.data); }
        for (const r of u.refs) done.add(r);
        state.records.push({ kind: "inplace", changes: inplace.changes });
        return;
      }
      const frag = Seg.build(tree, u, { stripId: false });
      markGenerated(frag);
      replaceRun(u, frag, loose);
    });
  }

  function applyLoose(u, text) {
    if (!u.nodes[0].isConnected) return;
    if (pendingUnits) pendingUnits.delete(u);
    suppress(() => {
      const frag = Seg.buildLoose(text, u, { stripId: state.mode === "bilingual" });
      markGenerated(frag);
      if (state.mode === "bilingual") insertBilingual(u, frag, true);
      else replaceRun(u, frag, true);
    });
  }

  function replaceRun(u, frag, loose) {
    const first = u.nodes[0];
    const parent = first.parentNode;
    if (!parent) return;
    let gen = Array.from(frag.childNodes);
    if (loose) {
      const span = document.createElement("span");
      span.setAttribute("data-tf", "gen");
      span.setAttribute("data-tf-loose", "1");
      span.title = "書式マーカーの復元に失敗したため、書式の位置が原文と異なる可能性があります";
      span.appendChild(frag);
      done.add(span);
      gen = [span];
      parent.insertBefore(span, first);
    } else {
      parent.insertBefore(frag, first);
    }
    for (const n of u.nodes) n.remove();
    state.records.push({ kind: "replace", originals: u.nodes, generated: gen, parent });
  }

  function insertBilingual(u, frag, loose) {
    const wrapper = document.createElement(u.block ? "div" : "span");
    wrapper.className = "tf-trans" + (u.block ? " tf-trans-block" : "");
    wrapper.setAttribute("data-tf", "gen");
    if (loose) wrapper.setAttribute("data-tf-loose", "1");
    wrapper.appendChild(frag);
    done.add(wrapper);
    const last = u.nodes[u.nodes.length - 1];
    last.parentNode.insertBefore(wrapper, last.nextSibling);
    state.records.push({ kind: "bilingual", wrapper });
  }

  function restorePage() {
    cancelled = true;
    if (state.sessionId) send({ type: "cancel", sessionId: state.sessionId }).catch(() => {});
    stopObserver();
    stopKeepAlive();
    suppress(() => {
      for (let i = state.records.length - 1; i >= 0; i--) {
        const r = state.records[i];
        try {
          if (r.kind === "inplace") Seg.revertInPlace(r.changes);
          else if (r.kind === "bilingual") r.wrapper.remove();
          else {
            const anchor = r.generated.find((n) => n.parentNode === r.parent);
            if (anchor) for (const o of r.originals) r.parent.insertBefore(o, anchor);
            else for (const o of r.originals) r.parent.appendChild(o);
            for (const g of r.generated) g.remove();
          }
        } catch { /* ページ側で既に消えた等 */ }
      }
    });
    state.records = [];
    done = new WeakSet();
    state.status = "idle";
    state.progress = { done: 0, total: 0 };
    state.incrementalRuns = 0;
    state.error = null;
    hideBadge();
  }

  function cancel() {
    if (state.status !== "running") return;
    cancelled = true;
    if (state.sessionId) send({ type: "cancel", sessionId: state.sessionId }).catch(() => {});
  }

  function getState() {
    return {
      ok: true,
      status: state.status,
      mode: state.mode,
      progress: state.progress,
      usage: state.usage,
      error: state.error,
      host: location.hostname,
      title: document.title,
    };
  }

  // ---------- selection ----------
  let selText = "";
  function hideSelButton() { if (ui.selbtn) ui.selbtn.hidden = true; }
  function hidePanel() { if (ui.panel) ui.panel.hidden = true; }

  function placeFixed(el, rect, offsetY) {
    const vw = innerWidth, vh = innerHeight;
    const w = el.offsetWidth || 320, h = el.offsetHeight || 120;
    let left = rect.left;
    let top = rect.bottom + offsetY;
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    if (top + h > vh - 8) top = Math.max(8, rect.top - h - offsetY);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }

  function checkSelection() {
    const sel = window.getSelection();
    const text = sel && sel.rangeCount ? sel.toString().trim() : "";
    if (!text || text.length < 2) { hideSelButton(); return; }
    const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (anchor && anchor.closest && anchor.closest("[data-tf='ui']")) return;
    selText = text;
    ensureUi();
    const rect = sel.getRangeAt(sel.rangeCount - 1).getBoundingClientRect();
    ui.selbtn.hidden = false;
    placeFixed(ui.selbtn, { left: rect.right + 6, right: rect.right, top: rect.top, bottom: rect.bottom }, 4);
  }

  async function translateSelection() {
    const sel = window.getSelection();
    const text = (sel && sel.rangeCount && sel.toString().trim()) || selText;
    if (!text) return;
    ensureUi();
    hideSelButton();
    let rect = { left: 40, right: 40, top: 40, bottom: 40 };
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { /* none */ }
    ui.panel.hidden = false;
    ui.pb.textContent = "翻訳中…";
    ui.pb.classList.add("wait");
    ui.po.hidden = true;
    ui.po.textContent = text;
    ui.pcost.textContent = "";
    placeFixed(ui.panel, rect, 8);
    const settings = state.settings || (await loadSettings().catch(() => null));
    if (!settings || !settings.hasKey) {
      ui.pb.textContent = "APIキーが未設定です。拡張の設定画面で登録してください。";
      return;
    }
    const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    // 段落区切りは保ち、行内の空白だけ畳む
    const normalized = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");
    const segments = [{ id: 0, text: Seg.esc(normalized) }];
    const r = await send({ type: "translate", sessionId, context: { title: document.title, url: location.href }, segments }).catch((e) => ({ ok: false, error: String(e.message || e) }));
    ui.pb.classList.remove("wait");
    if (!r || !r.ok) { ui.pb.textContent = `エラー: ${(r && r.error) || "不明"}`; return; }
    const t = r.results && r.results[0];
    ui.pb.textContent = t != null ? Seg.unesc(Seg.stripMarkers(t)) : "（翻訳結果を取得できませんでした）";
    addUsage(r);
    if (r.usage) ui.pcost.textContent = costText(r.usage.costUsd || 0);
    else if (r.cached) ui.pcost.textContent = "cache";
    placeFixed(ui.panel, rect, 8);
  }

  document.addEventListener("mouseup", (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (ui.host && path.includes(ui.host)) return;
    setTimeout(checkSelection, 10);
  }, true);
  document.addEventListener("mousedown", (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (ui.host && path.includes(ui.host)) return;
    hideSelButton();
    if (ui.panel && !ui.panel.hidden) hidePanel();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideSelButton(); hidePanel(); }
  }, true);

  // ---------- message handler ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "tf:ping":
        sendResponse({ ok: true });
        return false;
      case "tf:state":
        sendResponse(getState());
        return false;
      case "tf:translate":
        translatePage({ mode: msg.mode }).then(() => sendResponse(getState()), (e) => sendResponse({ ...getState(), error: String(e.message || e) }));
        return true;
      case "tf:restore":
        restorePage();
        sendResponse(getState());
        return false;
      case "tf:cancel":
        cancel();
        sendResponse(getState());
        return false;
      case "tf:toggle":
        if (state.status === "running") { cancel(); sendResponse(getState()); return false; }
        if (state.status === "translated") { restorePage(); sendResponse(getState()); return false; }
        translatePage().then(() => sendResponse(getState()), (e) => sendResponse({ ...getState(), error: String(e.message || e) }));
        return true;
      case "tf:translateSelection":
        translateSelection();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  // 「常に翻訳」ホストなら自動開始
  loadSettings().then((s) => {
    if (s.hasKey && Array.isArray(s.autoHosts) && s.autoHosts.includes(location.hostname)) translatePage();
  }).catch(() => {});
})();
