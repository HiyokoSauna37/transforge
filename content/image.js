// 右クリックした画像を読み取り、画像翻訳の開始・縮小・中止を管理する。
(() => {
  if (globalThis.TFImage) return;
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

  function medianColor(samples) {
    if (!samples.length) return [255, 255, 255];
    return [0, 1, 2].map((channel) => {
      const values = samples.map((pixel) => pixel[channel]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    });
  }

  function colorDistance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  function cssColor(color) {
    return `rgb(${color.map((value) => Math.round(value)).join(" ")})`;
  }

  function regionColors(image, width, height, box) {
    const [x, y, w, h] = box;
    const pad = Math.max(2, Math.round(Math.min(w, h) * 0.08));
    const left = Math.max(0, x - pad);
    const top = Math.max(0, y - pad);
    const right = Math.min(width, x + w + pad);
    const bottom = Math.min(height, y + h + pad);
    const pixel = (px, py) => {
      const index = (Math.max(0, Math.min(height - 1, py)) * width + Math.max(0, Math.min(width - 1, px))) * 4;
      return [image[index], image[index + 1], image[index + 2], image[index + 3]];
    };
    const groups = { top: [], bottom: [], left: [], right: [] };
    const xStep = Math.max(1, Math.floor((right - left) / 80));
    const yStep = Math.max(1, Math.floor((bottom - top) / 80));
    for (let px = left; px < right; px += xStep) {
      groups.top.push(pixel(px, Math.max(0, top - 1)));
      groups.bottom.push(pixel(px, Math.min(height - 1, bottom)));
    }
    for (let py = top; py < bottom; py += yStep) {
      groups.left.push(pixel(Math.max(0, left - 1), py));
      groups.right.push(pixel(Math.min(width - 1, right), py));
    }
    const edges = Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, medianColor(values.filter((value) => value[3] > 32))]));
    const background = medianColor(Object.values(groups).flat().filter((value) => value[3] > 32));
    const candidates = [];
    const insideStep = Math.max(1, Math.floor(Math.min(w, h) / 40));
    for (let py = y; py < y + h; py += insideStep) {
      for (let px = x; px < x + w; px += insideStep) {
        const value = pixel(px, py);
        if (value[3] > 64) candidates.push({ color: value, distance: colorDistance(value, background) });
      }
    }
    candidates.sort((a, b) => b.distance - a.distance);
    const foregroundSamples = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.18))).map((entry) => entry.color);
    let foreground = medianColor(foregroundSamples);
    if (colorDistance(foreground, background) < 90) {
      const luminance = background[0] * 0.2126 + background[1] * 0.7152 + background[2] * 0.0722;
      foreground = luminance > 145 ? [24, 24, 24] : [248, 248, 248];
    }
    return { background, foreground, edges, expanded: [left, top, right - left, bottom - top] };
  }

  function backgroundPaint(ctx, colors, box) {
    const [x, y, w, h] = box;
    const vertical = colorDistance(colors.edges.top, colors.edges.bottom);
    const horizontal = colorDistance(colors.edges.left, colors.edges.right);
    if (Math.max(vertical, horizontal) < 24) return cssColor(colors.background);
    const gradient = horizontal > vertical ? ctx.createLinearGradient(x, y, x + w, y) : ctx.createLinearGradient(x, y, x, y + h);
    gradient.addColorStop(0, cssColor(horizontal > vertical ? colors.edges.left : colors.edges.top));
    gradient.addColorStop(1, cssColor(horizontal > vertical ? colors.edges.right : colors.edges.bottom));
    return gradient;
  }

  function textUnits(text) {
    const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    return [...wordSegmenter.segment(text)].map((part) => part.segment);
  }

  function splitUnit(ctx, unit, maxWidth) {
    if (ctx.measureText(unit).width <= maxWidth) return [unit];
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(unit)].map((part) => part.segment);
    const pieces = [];
    let current = "";
    for (const grapheme of graphemes) {
      if (current && ctx.measureText(current + grapheme).width > maxWidth) { pieces.push(current); current = grapheme; }
      else current += grapheme;
    }
    if (current) pieces.push(current);
    return pieces;
  }

  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of text.split(/\r?\n/)) {
      let line = "";
      for (const rawUnit of textUnits(paragraph)) {
        for (const unit of splitUnit(ctx, rawUnit, maxWidth)) {
          const candidate = line + unit;
          if (line.trim() && ctx.measureText(candidate).width > maxWidth) {
            lines.push(line.trimEnd());
            line = unit.trimStart();
          } else line = candidate;
        }
      }
      lines.push(line.trimEnd());
    }
    return lines.length ? lines : [""];
  }

  function textLayout(ctx, region, box) {
    const [, , width, height] = box;
    const padding = Math.max(1, Math.min(width, height) * 0.08);
    const maxWidth = Math.max(1, width - padding * 2);
    const maxHeight = Math.max(1, height - padding * 2);
    const minSize = Math.max(4, Math.min(11, maxHeight * 0.2));
    let low = minSize;
    let high = Math.max(minSize, maxHeight * 0.82);
    let best = null;
    for (let i = 0; i < 9; i++) {
      const size = (low + high) / 2;
      ctx.font = `${region.weight === "bold" ? 700 : 400} ${size}px "M PLUS Rounded 1c", "Noto Sans JP", sans-serif`;
      const lines = wrapText(ctx, region.translation, maxWidth);
      const lineHeight = size * 1.22;
      const fits = lines.length * lineHeight <= maxHeight && lines.every((line) => ctx.measureText(line).width <= maxWidth + 0.5);
      if (fits) { best = { size, lines, lineHeight, padding }; low = size; }
      else high = size;
    }
    if (best) return best;
    ctx.font = `${region.weight === "bold" ? 700 : 400} ${minSize}px "M PLUS Rounded 1c", "Noto Sans JP", sans-serif`;
    return { size: minSize, lines: wrapText(ctx, region.translation, maxWidth), lineHeight: minSize * 1.18, padding };
  }

  function drawRegion(overlayCtx, sourcePixels, sourceWidth, sourceHeight, region) {
    const colors = regionColors(sourcePixels, sourceWidth, sourceHeight, region.box);
    const [maskX, maskY, maskWidth, maskHeight] = colors.expanded;
    overlayCtx.save();
    overlayCtx.fillStyle = backgroundPaint(overlayCtx, colors, colors.expanded);
    const radius = Math.max(1, Math.min(8, Math.min(maskWidth, maskHeight) * 0.08));
    overlayCtx.beginPath();
    overlayCtx.roundRect(maskX, maskY, maskWidth, maskHeight, radius);
    overlayCtx.fill();

    const [x, y, width, height] = region.box;
    overlayCtx.beginPath();
    overlayCtx.rect(maskX, maskY, maskWidth, maskHeight);
    overlayCtx.clip();
    overlayCtx.translate(x + width / 2, y + height / 2);
    overlayCtx.rotate(region.rotation * Math.PI / 180);
    const localBox = [-width / 2, -height / 2, width, height];
    const layout = textLayout(overlayCtx, region, localBox);
    overlayCtx.font = `${region.weight === "bold" ? 700 : 400} ${layout.size}px "M PLUS Rounded 1c", "Noto Sans JP", sans-serif`;
    overlayCtx.fillStyle = cssColor(colors.foreground);
    overlayCtx.textBaseline = "middle";
    overlayCtx.textAlign = region.align;
    const availableHeight = height - layout.padding * 2;
    const visibleLines = Math.max(1, Math.floor(availableHeight / layout.lineHeight));
    const lines = layout.lines.slice(0, visibleLines);
    const startY = -(lines.length - 1) * layout.lineHeight / 2;
    const textX = region.align === "left" ? localBox[0] + layout.padding : region.align === "right" ? localBox[0] + width - layout.padding : 0;
    lines.forEach((line, index) => overlayCtx.fillText(line, textX, startY + index * layout.lineHeight));
    overlayCtx.restore();
  }

  async function renderTranslation(image, regions, signal) {
    if (signal.aborted) throw aborted();
    let bitmap;
    try {
      bitmap = await createImageBitmap(remoteBlob(image));
      const source = document.createElement("canvas");
      source.width = image.width;
      source.height = image.height;
      const sourceCtx = source.getContext("2d", { willReadFrequently: true });
      const overlay = document.createElement("canvas");
      overlay.width = image.width;
      overlay.height = image.height;
      const overlayCtx = overlay.getContext("2d");
      if (!sourceCtx || !overlayCtx) throw new Error("画像を描画できませんでした。");
      sourceCtx.drawImage(bitmap, 0, 0, image.width, image.height);
      const sourcePixels = sourceCtx.getImageData(0, 0, image.width, image.height).data;
      try { await document.fonts.load('16px "M PLUS Rounded 1c"'); } catch { /* システムフォントで続行する。 */ }
      for (const region of regions) {
        if (signal.aborted) throw aborted();
        drawRegion(overlayCtx, sourcePixels, image.width, image.height, region);
      }
      return overlay;
    } finally { bitmap?.close(); }
  }

  function imageOverlay(onClose) {
    const host = document.createElement("div");
    host.id = "tf-image-host";
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
:host{all:initial}[hidden]{display:none!important}.frame{position:fixed;overflow:hidden;pointer-events:none;box-sizing:border-box}.image{position:absolute;display:block;pointer-events:none}.status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:calc(100% - 16px);padding:8px 12px;border-radius:10px;background:rgba(30,27,25,.9);color:#fff;font:600 12px/1.5 system-ui,sans-serif;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.24)}.status.busy::before{content:"";display:inline-block;width:11px;height:11px;margin-right:7px;vertical-align:-1px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}.status.error{background:rgba(132,38,38,.94)}.actions{position:absolute;right:7px;top:7px;display:flex;gap:5px;pointer-events:auto}.actions button{border:1px solid rgba(255,255,255,.42);border-radius:8px;background:rgba(30,27,25,.88);color:#fff;font:600 11px/1 system-ui,sans-serif;padding:7px 9px;box-shadow:0 2px 9px rgba(0,0,0,.22);cursor:pointer}.actions button:hover{background:rgba(70,61,56,.95)}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.status.busy::before{animation:none}}
</style><div class="frame" hidden><canvas class="image" hidden></canvas><div class="status busy">画像を翻訳しています…</div><div class="actions" hidden><button class="toggle">原文</button><button class="close">戻す</button></div></div>`;
    document.documentElement.append(host);
    const frame = root.querySelector(".frame");
    const canvas = root.querySelector("canvas");
    const status = root.querySelector(".status");
    const actions = root.querySelector(".actions");
    const toggle = root.querySelector(".toggle");
    let source = null;
    let translated = null;
    let showingTranslation = true;
    let timer = null;

    const positionValue = (token, free, axis) => {
      if (!token) return free / 2;
      if (token.endsWith("%")) return free * Number.parseFloat(token) / 100;
      if (token.endsWith("px")) return Number.parseFloat(token);
      if (["left", "top"].includes(token)) return 0;
      if (["right", "bottom"].includes(token)) return free;
      if (token === "center") return free / 2;
      return axis === "x" ? free / 2 : free / 2;
    };

    function update() {
      if (!source?.isConnected) {
        if (source && !source.isConnected) close();
        return;
      }
      const rect = source.getBoundingClientRect();
      const style = getComputedStyle(source);
      const scaleX = source.offsetWidth ? rect.width / source.offsetWidth : 1;
      const scaleY = source.offsetHeight ? rect.height / source.offsetHeight : 1;
      const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(style.paddingRight) || 0;
      const paddingTop = Number.parseFloat(style.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
      const width = Math.max(1, (source.clientWidth - paddingLeft - paddingRight) * scaleX);
      const height = Math.max(1, (source.clientHeight - paddingTop - paddingBottom) * scaleY);
      frame.style.left = `${rect.left + (source.clientLeft + paddingLeft) * scaleX}px`;
      frame.style.top = `${rect.top + (source.clientTop + paddingTop) * scaleY}px`;
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      frame.style.borderRadius = style.borderRadius;
      if (!translated) return;
      const intrinsicWidth = source.naturalWidth || translated.width;
      const intrinsicHeight = source.naturalHeight || translated.height;
      let drawWidth = width;
      let drawHeight = height;
      const fit = style.objectFit || "fill";
      if (["contain", "cover", "none", "scale-down"].includes(fit)) {
        let scale = fit === "cover" ? Math.max(width / intrinsicWidth, height / intrinsicHeight) : Math.min(width / intrinsicWidth, height / intrinsicHeight);
        if (fit === "none") scale = 1;
        if (fit === "scale-down") scale = Math.min(1, scale);
        drawWidth = intrinsicWidth * scale;
        drawHeight = intrinsicHeight * scale;
      }
      const positions = (style.objectPosition || "50% 50%").trim().split(/\s+/);
      canvas.style.left = `${positionValue(positions[0], width - drawWidth, "x")}px`;
      canvas.style.top = `${positionValue(positions[1] || "50%", height - drawHeight, "y")}px`;
      canvas.style.width = `${drawWidth}px`;
      canvas.style.height = `${drawHeight}px`;
    }

    function start(node) {
      source = node;
      translated = null;
      showingTranslation = true;
      frame.hidden = false;
      canvas.hidden = true;
      status.hidden = false;
      status.className = "status busy";
      status.textContent = "画像を翻訳しています…";
      actions.hidden = true;
      clearInterval(timer);
      timer = setInterval(update, 180);
      const rect = source.getBoundingClientRect();
      frame.style.left = `${rect.left}px`;
      frame.style.top = `${rect.top}px`;
      frame.style.width = `${Math.max(1, rect.width)}px`;
      frame.style.height = `${Math.max(1, rect.height)}px`;
    }

    function show(rendered) {
      translated = rendered;
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(rendered, 0, 0);
      showingTranslation = true;
      canvas.hidden = false;
      status.hidden = true;
      actions.hidden = false;
      toggle.hidden = false;
      toggle.textContent = "原文";
      update();
    }

    function message(text, error = false) {
      translated = null;
      canvas.hidden = true;
      status.hidden = false;
      status.className = `status${error ? " error" : ""}`;
      status.textContent = text;
      actions.hidden = false;
      toggle.hidden = true;
    }

    function close() {
      clearInterval(timer);
      timer = null;
      source = null;
      translated = null;
      canvas.width = canvas.height = 1;
      frame.hidden = true;
    }

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      showingTranslation = !showingTranslation;
      canvas.hidden = !showingTranslation;
      toggle.textContent = showingTranslation ? "原文" : "訳文";
    });
    root.querySelector(".close").addEventListener("click", (event) => { event.stopPropagation(); onClose(); });
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return { start, show, message, close, isOpen: () => !frame.hidden };
  }

  function create({ getUi, send, loadSettings, addUsage, newSessionId, errorMessage, keepAliveMs }) {
    let snapshot = null;
    let generation = 0;
    let active = null;
    let overlay;

    document.addEventListener("contextmenu", (event) => {
      const source = event.composedPath().find((node) => node instanceof HTMLImageElement);
      if (!source) { snapshot = null; return; }
      const r = source.getBoundingClientRect();
      snapshot = { source, url: source.currentSrc || source.src, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
    }, true);

    function cancel() {
      generation++;
      overlay?.close();
      if (!active) return;
      active.ctrl.abort();
      clearInterval(active.keepAlive);
      send({ type: "cancel", sessionId: active.sessionId }).catch(() => {});
      active = null;
    }

    overlay = imageOverlay(cancel);

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
      const url = typeof srcUrl === "string" && srcUrl ? srcUrl : snapshot?.url;
      const captured = snapshot?.url === url ? snapshot : null;
      const ui = getUi();
      ui.hideSelButton();
      ui.hidePanel();
      const current = generation;
      const source = captured?.source || [...document.images].find((image) => (image.currentSrc || image.src) === url);
      const request = { sessionId: newSessionId(), ctrl: new AbortController(), keepAlive: null };
      active = request;
      request.keepAlive = setInterval(() => send({ type: "tf:keepalive" }).catch(() => {}), keepAliveMs);
      try {
        if (!url) throw new Error("翻訳したい画像を右クリックして「画像を翻訳」を選んでください。");
        if (!source) throw new Error("翻訳する画像をページ上で見つけられませんでした。もう一度右クリックしてください。");
        overlay.start(source);
        const settings = await loadSettings();
        if (current !== generation || !overlay.isOpen()) return;
        if (!settings.hasKey) throw new Error("APIキーが未設定です。拡張の設定画面で登録してください。");
        const image = await prepare(url, captured, request);
        if (current !== generation || !overlay.isOpen()) return;
        const response = await send({ type: "translateImage", sessionId: request.sessionId, image,
          context: { title: document.title.slice(0, 300), url: location.href.slice(0, 2000) } });
        if (response?.ok) addUsage(response);
        if (current !== generation || !overlay.isOpen()) return;
        if (!response?.ok) throw new Error(response?.error || "画像の翻訳結果を取得できませんでした。");
        if (!response.regions?.length) { overlay.message("読み取れる文字がありませんでした。"); return; }
        const rendered = await renderTranslation(image, response.regions, request.ctrl.signal);
        if (current !== generation || !overlay.isOpen()) return;
        overlay.show(rendered);
      } catch (error) {
        if (current === generation && overlay.isOpen() && error.name !== "AbortError") overlay.message(`エラー: ${errorMessage(error)}`, true);
      } finally {
        clearInterval(request.keepAlive);
        if (active === request) active = null;
      }
    }
    return { translate, cancel };
  }
  globalThis.TFImage = { create };
})();
