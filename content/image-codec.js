// 画像の読み込み・SVGのラスタライズ・API向け縮小。ページへの表示は扱わない。
(() => {
  if (globalThis.TFImageCodec) return;
  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_PIXELS = 40_000_000;
  const MAX_SIDE = 2048;
  // 現在選択可能な Claude 5.x は high-resolution tier。座標ずれを避けるためAPI側の自動縮小前に合わせる。
  const VISION_MAX_EDGE = 2576;
  const VISION_MAX_TOKENS = 4784;
  const API_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const SOURCE_TYPES = new Set([...API_TYPES, "image/svg+xml"]);
  const aborted = () => new DOMException("中止しました", "AbortError");

  function encodedSize(width, height) {
    const ratio = Math.min(1, MAX_SIDE / Math.max(width, height));
    const baseWidth = Math.max(1, Math.round(width * ratio));
    const baseHeight = Math.max(1, Math.round(height * ratio));
    const fitsClaude = (w, h) => Math.ceil(w / 28) * 28 <= VISION_MAX_EDGE && Math.ceil(h / 28) * 28 <= VISION_MAX_EDGE && Math.ceil(w / 28) * Math.ceil(h / 28) <= VISION_MAX_TOKENS;
    if (fitsClaude(baseWidth, baseHeight)) return [baseWidth, baseHeight];
    if (baseHeight > baseWidth) {
      const [h, w] = encodedSize(baseHeight, baseWidth);
      return [w, h];
    }
    const aspect = baseWidth / baseHeight;
    let low = 1;
    let high = baseWidth;
    while (low + 1 < high) {
      const candidateWidth = Math.floor((low + high) / 2);
      const candidateHeight = Math.max(1, Math.round(candidateWidth / aspect));
      if (fitsClaude(candidateWidth, candidateHeight)) low = candidateWidth;
      else high = candidateWidth;
    }
    return [low, Math.max(1, Math.round(low / aspect))];
  }

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
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = encodedSize(width, height);
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
    return { ...(await blobData(blob, signal)), width: canvas.width, height: canvas.height };
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

  async function prepare(url, source, { signal, sessionId, send }) {
    if (source?.complete && source.naturalWidth && (source.currentSrc || source.src) === url) {
      try { return await encode(source, signal); }
      catch (error) { if (error.name !== "SecurityError") throw error; }
    }
    if (signal.aborted) throw aborted();
    let blob;
    if (/^(?:data|blob):/.test(url)) blob = await localBlob(url, signal);
    else if (/^https?:/.test(url)) {
      const response = await send({ type: "fetchImage", sessionId, url });
      if (signal.aborted) throw aborted();
      if (!response?.ok) throw new Error(response?.error || "画像を取得できませんでした。");
      blob = remoteBlob(response.image);
    } else throw new Error("通常のWebページにある画像を選んでください。");
    return decodeAndEncode(blob, signal);
  }

  globalThis.TFImageCodec = { prepare, remoteBlob, aborted };
})();
