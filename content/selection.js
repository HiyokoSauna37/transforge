// 選択範囲の翻訳・解説・質問と、選択ツールバーの位置・リクエストを管理する。
(() => {
  if (globalThis.TFSelection) return;

  const Seg = globalThis.TFSeg;
  const Context = globalThis.TFContext;
  if (!Seg || !Context) return;

  const EMPTY_RECT = { left: 40, right: 40, top: 40, bottom: 40 };
  const normalizeSelection = (text) =>
    text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");

  function create({ getUi, peekUi, getSettings, loadSettings, send, requestTranslation, addUsage, costText, newSessionId, errorMessage, keepAliveMs }) {
    let selectionSnapshot = null;
    let explanationSnapshot = null;
    let questionSnapshot = null;
    let sessionId = null;
    let requestId = 0;
    let toolbarActive = false;
    let positionFrame = 0;

    function visibleRect(range) {
      try {
        const rects = [...range.getClientRects()];
        for (let i = rects.length - 1; i >= 0; i--) {
          const rect = rects[i];
          if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) {
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }
        }
      } catch { /* 選択範囲が DOM から外れた場合 */ }
      return null;
    }

    function snapshotSelection() {
      const selected = window.getSelection();
      const text = selected?.rangeCount ? selected.toString().trim() : "";
      if (!text || peekUi()?.ownsNode(selected.anchorNode)) return null;
      const range = selected.getRangeAt(0).cloneRange();
      return { text, range, rect: visibleRect(range) };
    }

    function refreshToolbar() {
      const ui = peekUi();
      if (!toolbarActive || !selectionSnapshot || ui?.panelOpen) return;
      const rect = visibleRect(selectionSnapshot.range);
      if (rect) getUi().showSelButton(rect, getSettings()?.explanationEnabled !== false);
      else ui?.hideSelButton();
    }

    function scheduleToolbar() {
      if (!toolbarActive || positionFrame) return;
      positionFrame = requestAnimationFrame(() => {
        positionFrame = 0;
        refreshToolbar();
      });
    }

    function checkSelection() {
      const current = snapshotSelection();
      if (!current) {
        toolbarActive = false;
        peekUi()?.hideSelButton();
        return;
      }
      const ui = peekUi();
      if (ui?.panelOpen) ui.hidePanel();
      selectionSnapshot = current;
      toolbarActive = true;
      refreshToolbar();
    }

    function cancel() {
      requestId++;
      if (sessionId) send({ type: "cancel", sessionId }).catch(() => {});
      sessionId = null;
    }

    function openQuestionComposer() {
      const captured = snapshotSelection() || selectionSnapshot;
      if (!captured?.text) return;
      toolbarActive = false;
      questionSnapshot = captured;
      const ui = getUi();
      ui.hideSelButton();
      ui.openQuestionPanel(captured.rect || EMPTY_RECT, captured.text);
    }

    async function run(mode, { detail = "brief", reuse = false, question = "", captured = null } = {}) {
      const selected = reuse ? explanationSnapshot : (captured || snapshotSelection() || selectionSnapshot);
      if (!selected?.text) return;
      toolbarActive = false;
      cancel();
      const currentRequest = requestId;
      const ui = getUi();
      ui.hideSelButton();
      ui.openPanel(selected.rect || EMPTY_RECT, selected.text, { mode, question });

      try {
        const settings = await loadSettings();
        if (currentRequest !== requestId || !ui.panelOpen) return;
        if (!settings.hasKey) { ui.setPanelMessage("APIキーが未設定です。拡張の設定画面で登録してください。"); return; }
        if (mode === "explain" && settings.explanationEnabled === false) { ui.setPanelMessage("解説機能は設定で無効になっています。"); return; }
        if (mode === "explain" && selected.text.length > 6000) { ui.setPanelMessage("選択範囲を6,000文字以内にしてください。"); return; }

        let context = null;
        if (mode === "explain") {
          context = reuse ? selected.context : Context.collect(selected.text, selected.range, question);
          explanationSnapshot = { ...selected, context, question };
          ui.setPanelSources(context);
        } else explanationSnapshot = null;

        const requestSessionId = newSessionId();
        sessionId = requestSessionId;
        const keepAlive = setInterval(() => { send({ type: "tf:keepalive" }).catch(() => {}); }, keepAliveMs);
        let response;
        try {
          response = mode === "explain"
            ? await send({ type: "explain", sessionId: requestSessionId, selection: selected.text, context, detail, question })
            : await requestTranslation([{ id: 0, text: Seg.esc(normalizeSelection(selected.text)) }], requestSessionId);
        } finally {
          clearInterval(keepAlive);
          if (sessionId === requestSessionId) sessionId = null;
        }

        if (response?.ok) addUsage(response);
        if (currentRequest !== requestId || !ui.panelOpen) return;
        if (!response?.ok) { ui.setPanelMessage(`エラー: ${response?.error || "応答なし"}`); return; }
        const text = mode === "explain" ? response.text : response.results?.[0];
        const cost = response.usage ? costText(response.usage.costUsd || 0) : response.cached ? "cache" : "";
        ui.setPanelResult(text != null ? (mode === "explain" ? text : Seg.unesc(Seg.stripMarkers(text))) : "結果を取得できませんでした", cost);
      } catch (error) {
        if (currentRequest === requestId && ui.panelOpen) ui.setPanelMessage(`エラー: ${errorMessage(error)}`);
      }
    }

    const handlers = {
      onTranslateSelection: () => run("translate"),
      onExplainSelection: () => run("explain"),
      onAskSelection: openQuestionComposer,
      onAskQuestion: (question) => run("explain", { question, captured: questionSnapshot }),
      onExplainDetail: (detail) => run("explain", { detail, reuse: true, question: explanationSnapshot?.question || "" }),
      onPanelClose: () => { cancel(); questionSnapshot = null; },
    };

    const fromUi = (event) => !!peekUi()?.ownsEvent(event);
    window.addEventListener("scroll", scheduleToolbar, true);
    window.addEventListener("resize", scheduleToolbar);
    document.addEventListener("contextmenu", (event) => { if (!fromUi(event)) checkSelection(); }, true);
    document.addEventListener("mouseup", (event) => {
      if (!fromUi(event)) setTimeout(checkSelection, 10);
    }, true);
    document.addEventListener("mousedown", (event) => {
      const ui = peekUi();
      if (fromUi(event) || !ui) return;
      toolbarActive = false;
      ui.hideSelButton();
      if (ui.panelOpen) ui.hidePanel();
    }, true);
    document.addEventListener("keydown", (event) => {
      const ui = peekUi();
      if (event.key === "Escape" && ui) {
        toolbarActive = false;
        ui.hideSelButton();
        ui.hidePanel();
      }
    }, true);

    return {
      handlers,
      refreshToolbar,
      translate: handlers.onTranslateSelection,
      explain: handlers.onExplainSelection,
    };
  }

  globalThis.TFSelection = { create };
})();
