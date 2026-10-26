// 明確な広告枠だけを識別する。本文の「ad」「広告」などの単語では判定しない。
(() => {
  if (globalThis.TFExclusions) return;
  const SELECTOR = [
    ".adsbygoogle", "[data-ad-slot]", "[data-ad-client]", "[data-google-query-id]",
    '[id^="div-gpt-ad-"]', '[id^="google_ads_iframe_"]', '[id^="google_ads_frame"]',
    "ytd-ad-slot-renderer", "ytd-display-ad-renderer", "ytd-in-feed-ad-layout-renderer",
    "ytd-promoted-sparkles-web-renderer", "ytd-promoted-video-renderer", "ytd-action-companion-ad-renderer",
    "yt-ad-image-view-model", ".ytp-ad-overlay-container",
  ].join(",");
  const LABEL = /^(?:advertisement|advertisements|広告)$/i;
  const hidden = new Map();

  function isAd(element) {
    return !!element && element.nodeType === 1 &&
      (element.matches(SELECTOR) || LABEL.test((element.getAttribute("aria-label") || "").trim()));
  }

  function isWithinAd(node) {
    let element = node?.nodeType === 1 ? node : node?.parentElement || node?.host;
    while (element) {
      if (isAd(element) || hidden.has(element)) return true;
      element = element.parentElement || element.getRootNode()?.host;
    }
    return false;
  }

  // 元のdisplayだけ保存し、広告DOMやイベントリスナーはそのまま残す。
  // ページ自身がdisplayを書き戻した場合も、最初に保存した状態を保持して再び隠す。
  function hideAds(root = document) {
    let count = 0;
    const visit = (node) => {
      if (node.nodeType === 1) {
        if ((isAd(node) || hidden.has(node)) && node.style) {
          if (!hidden.has(node)) {
            hidden.set(node, { value: node.style.getPropertyValue("display"), priority: node.style.getPropertyPriority("display"), hadStyle: node.hasAttribute("style") });
            count++;
          }
          if (node.style.getPropertyValue("display") !== "none" || node.style.getPropertyPriority("display") !== "important") node.style.setProperty("display", "none", "important");
          return; // 外側の広告枠を隠せば、その中の広告を個別に変更する必要はない。
        }
        if (node.shadowRoot) visit(node.shadowRoot);
      }
      for (const child of node.children || []) visit(child);
    };
    if (root) visit(root);
    return count;
  }

  function restoreAds() {
    const count = hidden.size;
    for (const [element, saved] of hidden) {
      if (saved.value) element.style.setProperty("display", saved.value, saved.priority);
      else element.style.removeProperty("display");
      if (!saved.hadStyle && !element.style.length) element.removeAttribute("style");
    }
    hidden.clear();
    return count;
  }

  globalThis.TFExclusions = { isAd, isWithinAd, hideAds, restoreAds, hasHiddenAds: () => hidden.size > 0 };
})();
