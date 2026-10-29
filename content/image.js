// 右クリックした画像を読み取り、画像翻訳の開始・縮小・中止を管理する。
(() => {
  if (globalThis.TFImage) return;
  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_PIXELS = 40_000_000;
  const MAX_SIDE = 2048;
  const API_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const SOURCE_TYPES = new Set([...API_TYPES, "image/svg+xml"]);
  const EMPTY_RECT = { left: 40, right: 40, top: 40, bottom: 40 };
  const aborted = () => new DOMException("中止しました", "AbortError");

  function blobData(blob, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(aborted()); return; }
      const reader = new FileReader();
      const abort = () => reader.abort();
      signal.addEventListener("abort", abort, { once: true });
      reader.onload = () => resolve({ data: String(reader.result).split(",", 2)[1], mediaType: blob.type });
      reader.onerror = () => reject(new Error("画像データを読み取れませんでした。"));
      reader.onabort = () => reject(aborted());
      reader.onloadend = () => signal.removeEventListener("abort", abort);
      reader.readAsDataURL(blob);
    });
  }

  async function encode(source, signal) {
    if (signal.aborted) throw aborted();
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    if (!width || !height) throw new Error("画像の読み込みが終わってから、もう一度お試しください。");
    if (width * height > MAX_PIXELS) throw new Error("画像が大きすぎます。4,000万画素以下の画像を選んでください。");
    const ratio = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("画像を処理できませんでした。");
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const toBlob = (type, quality) => new Promise((resolve, reject) => {
      try { canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像を変換できませんでした。")), type, quality); }
      catch (error) { reject(error); }
    });
    let blob = await toBlob("image/png");
    if (signal.aborted) throw aborted();
    if (blob.size > MAX_BYTES) {
      // JPEG にする場合は透明部分を白で合成する。
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.72, 0.55]) {
        blob = await toBlob("image/jpeg", quality);
        if (signal.aborted) throw aborted();
        if (blob.size <= MAX_BYTES) break;
      }
    }
    if (blob.size > MAX_BYTES) throw new Error("画像を5MB以下に縮小できませんでした。小さい画像でお試しください。");
    return blobData(blob, signal);
  }

  async function decodeAndEncode(blob, signal) {
    if (signal.aborted) throw aborted();
    if (!SOURCE_TYPES.has(blob.type)) throw new Error("PNG・JPEG・WebP・GIF・SVGの画像を選んでください。");
    if (blob.size > MAX_BYTES) throw new Error("画像は5MB以下にしてください。");
    let source;
    let objectUrl = "";
    try {
      try {
        if (blob.type === "image/svg+xml") {
          // Chromium は SVG Blob を createImageBitmap で直接デコードできない。
          // data: を先に使い、ページの img-src が data: を拒む場合だけ blob: も試す。
          const encoded = await blobData(blob, signal);
          const load = (url) => new Promise((resolve, reject) => {
            if (signal.aborted) { reject(aborted()); return; }
            const image = new Image();
            const cleanup = () => signal.removeEventListener("abort", cancel);
            const cancel = () => { cleanup(); image.src = ""; reject(aborted()); };
            signal.addEventListener("abort", cancel, { once: true });
            image.onload = () => { cleanup(); resolve(image); };
            image.onerror = () => { cleanup(); reject(new Error("decode")); };
            image.src = url;
          });
          try { source = await load(`data:image/svg+xml;base64,${encoded.data}`); }
          catch (error) {
            if (error.name === "AbortError") throw error;
            objectUrl = URL.createObjectURL(blob);
            source = await load(objectUrl);
          }
        } else source = await createImageBitmap(blob);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error("画像を読み取れませんでした。破損していない画像を選んでください。");
      }
      return await encode(source, signal);
    } finally {
      if (typeof source?.close === "function") source.close();
      else if (source) source.src = "";
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  async function localBlob(url, signal) {
    if (url.length > MAX_BYTES * 3 + 256) throw new Error("画像は5MB以下にしてください。");
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error("画像を取得できませんでした。");
    const mediaType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!SOURCE_TYPES.has(mediaType)) throw new Error("PNG・JPEG・WebP・GIF・SVGの画像を選んでください。");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw aborted();
        length += value.byteLength;
        if (length > MAX_BYTES) { await reader.cancel(); throw new Error("画像は5MB以下にしてください。"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return new Blob(chunks, { type: mediaType });
  }

  function remoteBlob(image) {
    if (!image || !SOURCE_TYPES.has(image.mediaType) || typeof image.data !== "string" || image.data.length > Math.ceil(MAX_BYTES / 3) * 4) {
      throw new Error("画像の形式またはサイズが不正です。");
    }
    const binary = atob(image.data);
    if (binary.length > MAX_BYTES) throw new Error("画像は5MB以下にしてください。");
    return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: image.mediaType });
  }

  function create({ getUi, send, loadSettings, addUsage, costText, newSessionId, errorMessage, keepAliveMs }) {
    let snapshot = null;
    let generation = 0;
    let active = null;

    document.addEventListener("contextmenu", (event) => {
      const source = event.composedPath().find((node) => node instanceof HTMLImageElement);
      if (!source) { snapshot = null; return; }
      const r = source.getBoundingClientRect();
      snapshot = { source, url: source.currentSrc || source.src, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
    }, true);

    function cancel() {
      generation++;
      if (!active) return;
      active.ctrl.abort();
      clearInterval(active.keepAlive);
      send({ type: "cancel", sessionId: active.sessionId }).catch(() => {});
      active = null;
    }

    async function prepare(url, captured, request) {
      const { signal } = request.ctrl;
      if (captured?.source?.complete && captured.source.naturalWidth && (captured.source.currentSrc || captured.source.src) === url) {
        try { return await encode(captured.source, signal); }
        catch (error) { if (error.name !== "SecurityError") throw error; }
      }
      if (signal.aborted) throw aborted();
      let blob;
      if (/^(?:data|blob):/.test(url)) blob = await localBlob(url, signal);
      else if (/^https?:/.test(url)) {
        const response = await send({ type: "fetchImage", sessionId: request.sessionId, url });
        if (signal.aborted) throw aborted();
        if (!response?.ok) throw new Error(response?.error || "画像を取得できませんでした。");
        blob = remoteBlob(response.image);
      } else throw new Error("通常のWebページにある画像を選んでください。");
      return decodeAndEncode(blob, signal);
    }

    async function translate(srcUrl) {
      cancel();
      const current = generation;
      const url = typeof srcUrl === "string" && srcUrl ? srcUrl : snapshot?.url;
      const captured = snapshot?.url === url ? snapshot : null;
      const ui = getUi();
      ui.hideSelButton();
      ui.openPanel(captured?.rect || EMPTY_RECT, "", { mode: "image" });
      const request = { sessionId: newSessionId(), ctrl: new AbortController(), keepAlive: null };
      active = request;
      request.keepAlive = setInterval(() => send({ type: "tf:keepalive" }).catch(() => {}), keepAliveMs);
      try {
        if (!url) throw new Error("翻訳したい画像を右クリックして「画像を翻訳」を選んでください。");
        const settings = await loadSettings();
        if (current !== generation || !ui.panelOpen) return;
        if (!settings.hasKey) throw new Error("APIキーが未設定です。拡張の設定画面で登録してください。");
        const image = await prepare(url, captured, request);
        if (current !== generation || !ui.panelOpen) return;
        const response = await send({ type: "translateImage", sessionId: request.sessionId, image,
          context: { title: document.title.slice(0, 300), url: location.href.slice(0, 2000) } });
        if (response?.ok) addUsage(response);
        if (current !== generation || !ui.panelOpen) return;
        if (!response?.ok) throw new Error(response?.error || "画像の翻訳結果を取得できませんでした。");
        ui.setPanelOriginal(response.original || "");
        ui.setPanelResult(response.text, response.usage ? costText(response.usage.costUsd || 0) : response.cached ? "cache" : "");
      } catch (error) {
        if (current === generation && ui.panelOpen && error.name !== "AbortError") ui.setPanelMessage(`エラー: ${errorMessage(error)}`);
      } finally {
        clearInterval(request.keepAlive);
        if (active === request) active = null;
      }
    }
    return { translate, cancel };
  }
  globalThis.TFImage = { create };
})();
