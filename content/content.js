// Yomeru content script: ページ翻訳の進行・適用・復元、追加翻訳（MutationObserver）、選択範囲の翻訳・解説。
// DOM の分割/復元は segmenter.js（TFSeg）、画面表示は ui.js（TFUi）に分けてある。
(() => {
  if (globalThis.__tfLoaded) return;
  globalThis.__tfLoaded = true;
  const Seg = globalThis.TFSeg;
  const Ui = globalThis.TFUi;
  const Context = globalThis.TFContext;
  if (!Seg || !Ui || !Context) return;

  const RESCAN_DELAY_MS = 700;     // DOM 変化からの追加翻訳までの待ち
  const MAX_INCREMENTAL_RUNS = 60; // ページが書き戻し続ける場合の無限ループ防止
  const KEEPALIVE_MS = 20000;      // service worker を起こしておく間隔
  const RETRY_LIMIT = 40;          // 欠落・失敗セグメントを単体で再試行する上限

  const state = {
    status: "idle", // idle | running | translated
    mode: "replace",
    sessionId: null,
    records: [],    // 復元用の変更記録
    progress: { done: 0, total: 0 },
    usage: { input: 0, output: 0, costUsd: 0, cached: 0, requests: 0, model: null },
    error: null,
    settings: null,
    incrementalRuns: 0,
  };
  let done = new WeakSet();              // 翻訳済み（原文ノード + 生成ノード）
  const translatedText = new WeakMap();  // in-place で書き換えた text node → 訳文
  let cancelled = false;
  let pendingUnits = null;               // 今回の run で未適用のユニット
  let observer = null;
  let observerTimer = null;
  let suppressed = false;
  let keepAliveTimer = null;
  let ui = null;

  const errorMessage = (e) => String((e && e.message) || e);
  const newSessionId = () => (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
  const pageContext = () => ({ title: document.title, url: location.href });

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

  // segments: [{id, text}] → background の translate 応答（{ok, results, usage, cached, model} か {ok:false, error, fatal}）
  async function requestTranslation(segments, sessionId, nocache = false) {
    try {
      const r = await send({ type: "translate", sessionId, nocache, context: pageContext(), segments });
      return r || { ok: false, error: "応答なし" };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => { send({ type: "tf:keepalive" }).catch(() => {}); }, KEEPALIVE_MS);
  }
  function stopKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  // ---------- UI ----------
  function getUi() {
    if (!ui || !ui.connected) ui = Ui.create({
      onStop: cancel,
      onTranslateSelection: translateSelection,
      onExplainSelection: () => runSelection("explain"),
      onAskSelection: openQuestionComposer,
      onAskQuestion: (question) => runSelection("explain", "brief", false, question, questionSnapshot),
      onExplainDetail: (detail) => runSelection("explain", detail, true, explanationSnapshot?.question || ""),
      onPanelClose: () => { cancelSelection(); questionSnapshot = null; },
    });
    return ui;
  }

  function costText(usd) {
    const rate = (state.settings && state.settings.usdJpy) || 150;
    const jpy = usd * rate;
    const usdS = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
    const jpyS = jpy < 1 ? `¥${jpy.toFixed(2)}` : `¥${Math.round(jpy).toLocaleString("ja-JP")}`;
    return `${usdS} ≈ ${jpyS}`;
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

  // ---------- observer（翻訳後に増えた/書き戻された部分を追加翻訳） ----------
  function suppress(fn) {
    suppressed = true;
    try { return fn(); } finally {
      if (observer) observer.takeRecords();
      suppressed = false;
    }
  }
  const isOurs = (n) => !!n && n.nodeType === 1 && n.hasAttribute("data-tf");

  function isInterestingMutation(m) {
    if (m.type === "characterData") {
      const n = m.target;
      if (!done.has(n)) return true;
      const t = translatedText.get(n);
      if (t != null && n.data !== t) { done.delete(n); return true; } // ページ側が原文を書き戻した
      return false;
    }
    if (isOurs(m.target)) return false;
    if (m.type !== "childList") return true;
    for (const n of m.addedNodes) if (!done.has(n) && !isOurs(n)) return true;
    return false;
  }
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      if (suppressed || state.status !== "translated") return;
      if (muts.some(isInterestingMutation)) scheduleRescan();
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
      if (state.status !== "translated" || state.incrementalRuns >= MAX_INCREMENTAL_RUNS) return;
      const s = state.settings || (await loadSettings().catch(() => null));
      if (!s) return;
      const units = collectUnits(s);
      if (!units.length) return;
      state.incrementalRuns++;
      await runUnits(units, s, { quiet: true });
    }, RESCAN_DELAY_MS);
  }

  // ---------- translate ----------
  function collectUnits(settings) {
    return Seg.collectUnits(document.body, { exclude: done, targetLang: settings.targetLang, skipNav: settings.skipNav });
  }

  async function translatePage(opts = {}) {
    if (state.status === "running") return;
    state.error = null;
    const settings = await loadSettings();
    if (!settings.hasKey) {
      getUi().showBadge("APIキーが未設定です。拡張の設定画面で登録してください", "error", 5000);
      return;
    }
    const mode = opts.mode || settings.displayMode || "replace";
    if (state.status === "translated" && state.mode !== mode) restorePage();
    state.mode = mode;
    const units = collectUnits(settings);
    if (!units.length) {
      if (state.status !== "translated") getUi().showBadge("翻訳する文が見つかりません", "info", 2500);
      return;
    }
    await runUnits(units, settings, {});
  }

  // 同時実行数 n のワーカープール
  function pool(items, n, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length && !cancelled) await worker(items[i++]);
    });
    return Promise.all(runners);
  }

  async function runUnits(units, settings, { quiet = false } = {}) {
    cancelled = false;
    const wasTranslated = state.status === "translated";
    state.status = "running";
    state.error = null;
    const sessionId = newSessionId();
    state.sessionId = sessionId;
    Seg.sortByViewport(units);
    units.forEach((u, i) => { u.id = i; for (const n of u.nodes) done.add(n); });
    pendingUnits = new Set(units); // 適用できなかったものは最後に done から外して再試行可能にする
    const batches = Seg.makeBatches(units, settings.batchChars || 2500);
    const concurrency = settings.concurrency || 4;
    state.progress = { done: 0, total: units.length };
    startKeepAlive();
    const showProgress = () => { if (!quiet) getUi().showProgress(state.progress.done, state.progress.total); };
    showProgress();
    const retry = [];
    let fatal = null;
    const noteFailure = (r) => {
      if (r.fatal) { fatal = r.error; cancelled = true; } else state.error = r.error;
    };

    await pool(batches, concurrency, async (batch) => {
      if (cancelled || fatal) return;
      const r = await requestTranslation(batch.map((u) => ({ id: u.id, text: u.text })), sessionId);
      if (cancelled) return;
      if (!r.ok) {
        noteFailure(r);
        retry.push(...batch);
      } else {
        addUsage(r);
        for (const u of batch) {
          const t = r.results && r.results[u.id];
          if (t == null || !applyTranslation(u, t, { allowLoose: false })) retry.push(u);
        }
      }
      state.progress.done += batch.length;
      showProgress();
    });

    // 失敗・欠落したものを単体で再試行（キャッシュを避けて再生成し、復元に失敗しても緩く適用する）
    if (!cancelled && !fatal && retry.length) {
      await pool(retry.slice(0, RETRY_LIMIT), Math.min(4, concurrency), async (u) => {
        if (cancelled) return;
        const r = await requestTranslation([{ id: u.id, text: u.text }], sessionId, true);
        if (cancelled) return;
        if (!r.ok) { noteFailure(r); return; }
        addUsage(r);
        const t = r.results && r.results[u.id];
        if (t != null) applyTranslation(u, t, { allowLoose: true });
      });
    }
    stopKeepAlive();
    state.sessionId = null;
    for (const u of pendingUnits) for (const n of u.nodes) done.delete(n);
    pendingUnits = null;
    finishRun({ fatal, wasTranslated, quiet });
  }

  function finishRun({ fatal, wasTranslated, quiet }) {
    if (fatal) {
      state.error = fatal;
      state.status = state.records.length ? "translated" : "idle";
      getUi().showBadge(fatal, "error", 8000);
    } else if (cancelled && !wasTranslated && !state.records.length) {
      state.status = "idle";
      getUi().showBadge("中止しました", "info", 2000);
    } else {
      state.status = "translated";
      if (!quiet) {
        const cached = state.usage.cached ? ` · キャッシュ ${state.usage.cached}` : "";
        if (state.error) getUi().showBadge(`一部失敗: ${state.error}`, "error", 8000);
        else getUi().showBadge(`翻訳完了 · ${costText(state.usage.costUsd)}${cached}`, "done", 3500);
      }
    }
    if (state.status === "translated") startObserver();
  }

  // ---------- DOM への適用 ----------
  // 訳文をユニットに適用。マーカー復元に失敗したら allowLoose のときだけ緩く適用する。戻り値: 適用したか
  function applyTranslation(u, text, { allowLoose }) {
    const tree = Seg.parseTranslated(text, u.kinds);
    if (tree) { applyTree(u, tree); return true; }
    if (!allowLoose) return false;
    applyLoose(u, text);
    return true;
  }

  function withUnit(u, fn) {
    if (!u.nodes[0].isConnected) return;
    if (pendingUnits) pendingUnits.delete(u);
    suppress(fn);
  }

  function markGenerated(frag) {
    const walk = (n) => {
      done.add(n);
      if (n.nodeType === 1) n.setAttribute("data-tf", "gen");
      for (const c of n.childNodes) walk(c);
    };
    for (const c of frag.childNodes) walk(c);
  }

  function applyTree(u, tree) {
    withUnit(u, () => {
      if (state.mode === "bilingual") {
        const frag = Seg.build(tree, u, { stripId: true });
        markGenerated(frag);
        insertBilingual(u, frag, false);
        return;
      }
      // replace: まず in-place（元ノードを残す）を試み、構造が違えばクローン置換
      const inplace = Seg.applyInPlace(tree, u);
      if (inplace) {
        for (const n of inplace.touched) { done.add(n); translatedText.set(n, n.data); }
        for (const r of u.refs) done.add(r);
        state.records.push({ kind: "inplace", changes: inplace.changes });
        return;
      }
      const frag = Seg.build(tree, u, { stripId: false });
      markGenerated(frag);
      replaceRun(u, frag, false);
    });
  }

  function applyLoose(u, text) {
    withUnit(u, () => {
      const bilingual = state.mode === "bilingual";
      const frag = Seg.buildLoose(text, u, { stripId: bilingual });
      markGenerated(frag);
      if (bilingual) insertBilingual(u, frag, true);
      else replaceRun(u, frag, true);
    });
  }

  function replaceRun(u, frag, loose) {
    const first = u.nodes[0];
    const parent = first.parentNode;
    if (!parent) return;
    let generated = Array.from(frag.childNodes);
    if (loose) {
      const span = document.createElement("span");
      span.setAttribute("data-tf", "gen");
      span.setAttribute("data-tf-loose", "1");
      span.title = "書式マーカーの復元に失敗したため、書式の位置が原文と異なる可能性があります";
      span.appendChild(frag);
      done.add(span);
      generated = [span];
      parent.insertBefore(span, first);
    } else {
      parent.insertBefore(frag, first);
    }
    for (const n of u.nodes) n.remove();
    state.records.push({ kind: "replace", originals: u.nodes, generated, parent });
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

  function revertRecord(r) {
    if (r.kind === "inplace") { Seg.revertInPlace(r.changes); return; }
    if (r.kind === "bilingual") { r.wrapper.remove(); return; }
    const anchor = r.generated.find((n) => n.parentNode === r.parent);
    for (const o of r.originals) {
      if (anchor) r.parent.insertBefore(o, anchor);
      else r.parent.appendChild(o);
    }
    for (const g of r.generated) g.remove();
  }

  // ---------- 復元 / 中止 ----------
  function cancelSession() {
    cancelled = true;
    if (state.sessionId) send({ type: "cancel", sessionId: state.sessionId }).catch(() => {});
  }

  function restorePage() {
    cancelSession();
    stopObserver();
    stopKeepAlive();
    suppress(() => {
      for (let i = state.records.length - 1; i >= 0; i--) {
        try { revertRecord(state.records[i]); } catch { /* ページ側で既に消えた等 */ }
      }
    });
    state.records = [];
    done = new WeakSet();
    state.status = "idle";
    state.progress = { done: 0, total: 0 };
    state.incrementalRuns = 0;
    state.error = null;
    if (ui) ui.hideBadge();
  }

  function cancel() {
    if (state.status === "running") cancelSession();
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
  let selectionSnapshot = null;
  let explanationSnapshot = null;
  let questionSnapshot = null;
  let selectionSessionId = null;
  let selectionRequest = 0;
  let selectionToolbarActive = false;
  let selectionPositionFrame = 0;

  function visibleSelectionRect(range) {
    try {
      const rects = [...range.getClientRects()];
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i];
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }
      }
    } catch { /* 選択範囲が DOM から外れた場合 */ }
    return null;
  }

  function refreshSelectionToolbar() {
    if (!selectionToolbarActive || !selectionSnapshot || ui?.panelOpen) return;
    const rect = visibleSelectionRect(selectionSnapshot.range);
    if (rect) getUi().showSelButton(rect, state.settings?.explanationEnabled !== false);
    else ui?.hideSelButton();
  }

  function scheduleSelectionToolbar() {
    if (!selectionToolbarActive || selectionPositionFrame) return;
    selectionPositionFrame = requestAnimationFrame(() => {
      selectionPositionFrame = 0;
      refreshSelectionToolbar();
    });
  }

  function snapshotSelection() {
    const sel = window.getSelection();
    const text = sel && sel.rangeCount ? sel.toString().trim() : "";
    if (!text || (ui && ui.ownsNode(sel.anchorNode))) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const rect = visibleSelectionRect(range);
    return { text, range, rect };
  }

  function checkSelection() {
    const current = snapshotSelection();
    if (!current) { selectionToolbarActive = false; if (ui) ui.hideSelButton(); return; }
    if (ui?.panelOpen) ui.hidePanel();
    selectionSnapshot = current;
    selectionToolbarActive = true;
    refreshSelectionToolbar();
  }

  // 段落区切りは保ち、行内の空白だけ畳む
  const normalizeSelection = (text) =>
    text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");

  function cancelSelection() {
    selectionRequest++;
    if (selectionSessionId) send({ type: "cancel", sessionId: selectionSessionId }).catch(() => {});
    selectionSessionId = null;
  }

  const translateSelection = () => runSelection("translate");

  function openQuestionComposer() {
    const captured = snapshotSelection() || selectionSnapshot;
    if (!captured?.text) return;
    selectionToolbarActive = false;
    questionSnapshot = captured;
    const panel = getUi();
    panel.hideSelButton();
    panel.openQuestionPanel(captured.rect || { left: 40, right: 40, top: 40, bottom: 40 }, captured.text);
  }

  async function runSelection(mode, detail = "brief", reuse = false, question = "", capturedOverride = null) {
    const captured = reuse ? explanationSnapshot : (capturedOverride || snapshotSelection() || selectionSnapshot);
    if (!captured?.text) return;
    selectionToolbarActive = false;
    cancelSelection();
    const request = selectionRequest;
    const panel = getUi();
    panel.hideSelButton();
    panel.openPanel(captured.rect || { left: 40, right: 40, top: 40, bottom: 40 }, captured.text, { mode, question });
    try {
      const settings = await loadSettings();
      if (request !== selectionRequest || !panel.panelOpen) return;
      if (!settings.hasKey) { panel.setPanelMessage("APIキーが未設定です。拡張の設定画面で登録してください。"); return; }
      if (mode === "explain" && settings.explanationEnabled === false) { panel.setPanelMessage("解説機能は設定で無効になっています。"); return; }
      if (mode === "explain" && captured.text.length > 6000) { panel.setPanelMessage("選択範囲を6,000文字以内にしてください。"); return; }
      let context = null;
      if (mode === "explain") {
        context = reuse ? captured.context : Context.collect(captured.text, captured.range, question);
        explanationSnapshot = { ...captured, context, question };
        panel.setPanelSources(context);
      } else explanationSnapshot = null;
      const sessionId = newSessionId();
      selectionSessionId = sessionId;
      const keepAlive = setInterval(() => { send({ type: "tf:keepalive" }).catch(() => {}); }, KEEPALIVE_MS);
      let r;
      try {
        r = mode === "explain"
          ? await send({ type: "explain", sessionId, selection: captured.text, context, detail, question })
          : await requestTranslation([{ id: 0, text: Seg.esc(normalizeSelection(captured.text)) }], sessionId);
      } finally { clearInterval(keepAlive); }
      if (r?.ok) addUsage(r);
      if (request !== selectionRequest || !panel.panelOpen) return;
      selectionSessionId = null;
      if (!r?.ok) { panel.setPanelMessage(`エラー: ${r?.error || "応答なし"}`); return; }
      const text = mode === "explain" ? r.text : r.results?.[0];
      const cost = r.usage ? costText(r.usage.costUsd || 0) : r.cached ? "cache" : "";
      panel.setPanelResult(text != null ? (mode === "explain" ? text : Seg.unesc(Seg.stripMarkers(text))) : "結果を取得できませんでした", cost);
    } catch (e) {
      if (request === selectionRequest && panel.panelOpen) panel.setPanelMessage(`エラー: ${errorMessage(e)}`);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings || !state.settings) return;
    const enabled = changes.settings.newValue?.explanationEnabled !== false;
    state.settings.explanationEnabled = enabled;
    refreshSelectionToolbar();
  });

  const fromUi = (e) => !!ui && ui.ownsEvent(e);
  window.addEventListener("scroll", scheduleSelectionToolbar, true);
  window.addEventListener("resize", scheduleSelectionToolbar);
  document.addEventListener("contextmenu", (e) => { if (!fromUi(e)) checkSelection(); }, true);
  document.addEventListener("mouseup", (e) => {
    if (!fromUi(e)) setTimeout(checkSelection, 10);
  }, true);
  document.addEventListener("mousedown", (e) => {
    if (fromUi(e) || !ui) return;
    selectionToolbarActive = false;
    ui.hideSelButton();
    if (ui.panelOpen) ui.hidePanel();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ui) { selectionToolbarActive = false; ui.hideSelButton(); ui.hidePanel(); }
  }, true);

  // ---------- message handler ----------
  // 非同期処理の完了後に状態を返す（失敗時はエラーを添える）
  function respondWhenDone(promise, sendResponse) {
    promise.then(() => sendResponse(getState()), (e) => sendResponse({ ...getState(), error: errorMessage(e) }));
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "tf:ping":
        sendResponse({ ok: true });
        return false;
      case "tf:state":
        sendResponse(getState());
        return false;
      case "tf:translate":
        return respondWhenDone(translatePage({ mode: msg.mode }), sendResponse);
      case "tf:restore":
        restorePage();
        sendResponse(getState());
        return false;
      case "tf:cancel":
        cancel();
        sendResponse(getState());
        return false;
      case "tf:toggle":
        if (state.status === "running") cancel();
        else if (state.status === "translated") restorePage();
        else return respondWhenDone(translatePage(), sendResponse);
        sendResponse(getState());
        return false;
      case "tf:explainSelection":
        runSelection("explain");
        sendResponse({ ok: true });
        return false;
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
