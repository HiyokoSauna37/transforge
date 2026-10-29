// OCR領域の背景色・文字組みを推定し、透明な翻訳Canvasを生成する。
(() => {
  if (globalThis.TFImageRenderer) return;
  const { remoteBlob, aborted } = globalThis.TFImageCodec;
  function medianColor(samples) {
    if (!samples.length) return [255, 255, 255];
    return [0, 1, 2].map((channel) => {
      const values = samples.map((pixel) => pixel[channel]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    });
  }

  function dominantColor(samples) {
    if (!samples.length) return [255, 255, 255];
    const buckets = new Map();
    for (const pixel of samples) {
      const key = `${pixel[0] >> 4},${pixel[1] >> 4},${pixel[2] >> 4}`;
      const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
      bucket.count++;
      bucket.red += pixel[0];
      bucket.green += pixel[1];
      bucket.blue += pixel[2];
      buckets.set(key, bucket);
    }
    const best = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
    return [best.red / best.count, best.green / best.count, best.blue / best.count];
  }

  function colorDistance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  function cssColor(color) {
    return `rgb(${color.map((value) => Math.round(value)).join(" ")})`;
  }

  function regionColors(image, width, height, box) {
    const [x, y, w, h] = box;
    const pad = Math.max(2, Math.round(Math.min(w, h) * 0.04));
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
    const areaSamples = [];
    const areaStep = Math.max(1, Math.floor(Math.sqrt(Math.max(1, (right - left) * (bottom - top) / 8000))));
    for (let py = top; py < bottom; py += areaStep) {
      for (let px = left; px < right; px += areaStep) {
        const value = pixel(px, py);
        if (value[3] > 32) areaSamples.push(value);
      }
    }
    const background = dominantColor(areaSamples);
    const edges = Object.fromEntries(Object.entries(groups).map(([key, values]) => {
      const edge = medianColor(values.filter((value) => value[3] > 32));
      return [key, colorDistance(edge, background) > 72 ? background : edge];
    }));
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

  globalThis.TFImageRenderer = { render: renderTranslation };
})();
