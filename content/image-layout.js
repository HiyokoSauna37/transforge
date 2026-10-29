// 画像の表示領域・object-fit・固定要素による遮蔽を計算する。DOM への描画は行わない。
(() => {
  if (globalThis.TFImageLayout) return;

  function contentRect(source, style) {
    const rect = source.getBoundingClientRect();
    const scaleX = source.offsetWidth ? rect.width / source.offsetWidth : 1;
    const scaleY = source.offsetHeight ? rect.height / source.offsetHeight : 1;
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const width = Math.max(1, (source.clientWidth - paddingLeft - paddingRight) * scaleX);
    const height = Math.max(1, (source.clientHeight - paddingTop - paddingBottom) * scaleY);
    const left = rect.left + (source.clientLeft + paddingLeft) * scaleX;
    const top = rect.top + (source.clientTop + paddingTop) * scaleY;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  function positionValue(token, free) {
    if (!token) return free / 2;
    if (token.endsWith("%")) return free * Number.parseFloat(token) / 100;
    if (token.endsWith("px")) return Number.parseFloat(token);
    if (["left", "top"].includes(token)) return 0;
    if (["right", "bottom"].includes(token)) return free;
    return free / 2;
  }

  function fittedRect(width, height, intrinsicWidth, intrinsicHeight, style) {
    let drawWidth = width;
    let drawHeight = height;
    const fit = style.objectFit || "fill";
    if (["contain", "cover", "none", "scale-down"].includes(fit)) {
      let scale = fit === "cover"
        ? Math.max(width / intrinsicWidth, height / intrinsicHeight)
        : Math.min(width / intrinsicWidth, height / intrinsicHeight);
      if (fit === "none") scale = 1;
      if (fit === "scale-down") scale = Math.min(1, scale);
      drawWidth = intrinsicWidth * scale;
      drawHeight = intrinsicHeight * scale;
    }
    const positions = (style.objectPosition || "50% 50%").trim().split(/\s+/);
    return {
      left: positionValue(positions[0], width - drawWidth),
      top: positionValue(positions[1] || "50%", height - drawHeight),
      width: drawWidth,
      height: drawHeight,
    };
  }

  function fixedLayer(element, source, host) {
    for (let node = element; node instanceof HTMLElement && node !== document.documentElement; node = node.parentElement) {
      if (node === source || node === host || node.getRootNode() === host.shadowRoot) return null;
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return node;
    }
    return null;
  }

  function occlusionInsets(rect, source, host) {
    const insets = { top: 0, right: 0, bottom: 0, left: 0 };
    if (rect.width < 1 || rect.height < 1) return insets;
    const clampX = value => Math.min(innerWidth - 1, Math.max(0, value));
    const clampY = value => Math.min(innerHeight - 1, Math.max(0, value));
    const xs = [rect.left + 1, rect.left + rect.width / 2, rect.right - 1].map(clampX);
    const ys = [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1].map(clampY);
    const layers = new Set();
    for (const x of xs) for (const y of ys) {
      const stack = document.elementsFromPoint(x, y);
      const sourceIndex = stack.indexOf(source);
      const candidates = sourceIndex < 0 ? stack.slice(0, 1) : stack.slice(0, sourceIndex);
      for (const candidate of candidates) {
        const layer = fixedLayer(candidate, source, host);
        if (layer) layers.add(layer);
      }
    }
    for (const layer of layers) {
      const cover = layer.getBoundingClientRect();
      const overlapWidth = Math.max(0, Math.min(rect.right, cover.right) - Math.max(rect.left, cover.left));
      const overlapHeight = Math.max(0, Math.min(rect.bottom, cover.bottom) - Math.max(rect.top, cover.top));
      if (overlapWidth >= rect.width / 2) {
        if (cover.top <= rect.top + 1 && cover.bottom > rect.top) insets.top = Math.max(insets.top, cover.bottom - rect.top);
        if (cover.bottom >= rect.bottom - 1 && cover.top < rect.bottom) insets.bottom = Math.max(insets.bottom, rect.bottom - cover.top);
      }
      if (overlapHeight >= rect.height / 2) {
        if (cover.left <= rect.left + 1 && cover.right > rect.left) insets.left = Math.max(insets.left, cover.right - rect.left);
        if (cover.right >= rect.right - 1 && cover.left < rect.right) insets.right = Math.max(insets.right, rect.right - cover.left);
      }
    }
    return insets;
  }

  globalThis.TFImageLayout = { contentRect, fittedRect, occlusionInsets };
})();
