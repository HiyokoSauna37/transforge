// 選択箇所の周辺と、ページ内の関連定義・用例を DOM から集める。外部ページは取得しない。
(() => {
  if (globalThis.TFContext) return;
  const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,dt,dd,tr,pre,blockquote,figcaption,[role=row]";
  const OMIT = "script,style,noscript,template,nav,aside,footer,[role=navigation],[hidden],[aria-hidden=true],input,textarea,select,[contenteditable]:not([contenteditable=false]),[data-tf=ui]";
  const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();
  const LIMIT = 10000;
  const COMMON = new Set(["the", "and", "for", "this", "that", "with", "from", "into", "your", "you", "are", "was", "were", "have", "has", "had", "can", "will", "what", "when", "where", "which", "not", "each", "page", "text"]);

  function allowed(el) {
    if (!el || el.closest(OMIT)) return false;
    try { return !el.checkVisibility || el.checkVisibility({ visibilityProperty: true }); } catch { return true; }
  }

  // textContent は hidden/script も含むため、本文のテキストノードだけを収集する。
  function textOf(el, max = 4000) {
    if (!allowed(el)) return "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts = [];
    let size = 0;
    while (walker.nextNode() && size < max) {
      const n = walker.currentNode;
      if (!allowed(n.parentElement)) continue;
      const t = normalize(n.data);
      if (t) { parts.push(t); size += t.length + 1; }
    }
    return normalize(parts.join(" ")).slice(0, max);
  }

  function terms(text) {
    const result = new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []).filter((t) => !COMMON.has(t)).slice(0, 40));
    if (typeof Intl.Segmenter === "function") {
      for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text.toLowerCase())) {
        if (part.isWordLike && part.segment.length >= 2 && !COMMON.has(part.segment)) result.add(part.segment);
        if (result.size >= 50) break;
      }
    }
    return [...result].slice(0, 50);
  }

  function collect(selection, range, question = "") {
    const anchor = range?.startContainer;
    const anchorEl = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
    const selectionRoot = anchorEl?.getRootNode();
    const roots = [document.body];
    if (selectionRoot?.nodeType === 11) roots.push(selectionRoot);
    const candidates = [];
    const byElement = new Map();
    let heading = "";
    let scanned = 0;
    let inspectedChars = 0;
    const add = (el, currentHeading) => {
      if (byElement.has(el)) return byElement.get(el);
      let text = textOf(el, 3000);
      if (el.tagName === "DT") {
        for (let dd = el.nextElementSibling; dd?.tagName === "DD" && text.length < 3000; dd = dd.nextElementSibling) {
          text += ` ${textOf(dd, 1400)}`;
        }
        text = text.slice(0, 3000).trim();
      }
      if (!text) return null;
      const item = { el, text, heading: currentHeading, index: candidates.length, score: 0 };
      candidates.push(item); byElement.set(el, item);
      return item;
    };
    for (const root of roots) {
      let currentHeading = "";
      for (const el of root.querySelectorAll(`${BLOCKS},div,section,article`)) {
        if (++scanned > 3000 || inspectedChars > 240000) break;
        if (!allowed(el)) continue;
        if (el.matches("div,section,article") && el.querySelector(`${BLOCKS},div,section,article`)) continue;
        if (/^H[1-6]$/.test(el.tagName)) currentHeading = textOf(el, 200);
        const item = add(el, currentHeading);
        if (item) inspectedChars += item.text.length;
        if (anchorEl && (el === anchorEl || el.contains(anchorEl))) heading = currentHeading;
      }
    }
    // ページ末尾の選択や div 主体の SPA でも、選択箇所を必ず確保する。
    const localEl = anchorEl?.closest("p,li,dd,dt,tr,pre,blockquote,h1,h2,h3,h4,h5,h6") || anchorEl;
    let local = localEl ? add(localEl, heading) : null;
    if (!local && anchorEl) local = add(anchorEl, heading);
    if (!heading && local) heading = local.heading;
    const localText = local?.text || normalize(selection);
    const selectedTerms = terms(selection);
    const questionTerms = terms(question).filter((t) => t.length >= 3);
    const nearbyTerms = terms(localText).filter((t) => t.length >= 4).slice(0, 20);
    const selected = normalize(selection).toLowerCase();
    const selectedWord = selected.length <= 80 && /^[a-z0-9_]+$/i.test(selected)
      ? new RegExp(`(?:^|[^\\p{L}\\p{N}_])${selected}(?=$|[^\\p{L}\\p{N}_])`, "iu")
      : null;
    const matchesSelection = (text) => selectedWord ? selectedWord.test(text) : text.includes(selected);
    const linked = new Set();
    if (localEl) for (const link of localEl.querySelectorAll('a[href*="#"]')) {
      try {
        const url = new URL(link.href, location.href);
        if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search || !url.hash) continue;
        const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
        if (target) linked.add(target);
      } catch { /* 不正な URL / fragment */ }
    }
    for (const item of candidates) {
      const lower = item.text.toLowerCase();
      const section = item.heading.toLowerCase();
      if (selected && matchesSelection(lower)) item.score += 18;
      if (selected && matchesSelection(section)) item.score += 6;
      for (const t of selectedTerms) {
        if (lower.includes(t)) item.score += 5;
        if (section.includes(t)) item.score += 3;
      }
      for (const t of questionTerms) {
        if (lower.includes(t)) item.score += 10;
        if (section.includes(t)) item.score += 4;
      }
      for (const t of nearbyTerms) if (lower.includes(t)) item.score += 0.5;
      if (heading && item.heading === heading) item.score += 2;
      if (item.el.matches("dt,dd,tr,[role=row]")) item.score += 1;
      for (const target of linked) {
        if (item.el === target || target.contains(item.el) || (target.matches("h1,h2,h3,h4,h5,h6") && item.heading === textOf(target, 200))) item.score += 12;
      }
      if (local && Math.abs(item.index - local.index) <= 2) item.score += 6;
    }
    // 所属段落に加えて直前直後を確保する。長い段落では選択語の位置を中心に切り出す。
    function around(text, max) {
      if (max <= 0) return "";
      if (text.length <= max) return text;
      const pos = text.toLowerCase().indexOf(selected);
      const start = Math.max(0, (pos < 0 ? 0 : pos) - Math.floor(max / 3));
      const length = Math.max(0, max - 2);
      return `${start ? "…" : ""}${text.slice(start, start + length)}${start + length < text.length ? "…" : ""}`;
    }
    const nearParts = [around(localText, 1400)];
    if (localEl) {
      for (const sibling of [localEl.previousElementSibling, localEl.nextElementSibling]) {
        const text = sibling ? textOf(sibling, 1000) : "";
        if (text && text !== localText) nearParts.push(around(text, 450));
      }
    }
    const nearby = nearParts.join("\n\n").slice(0, 2400);
    const seen = new Set([localText]);
    const excerpts = [];
    let budget = LIMIT - nearby.length;
    const ranked = candidates.filter((c) => c !== local && c.score >= 5 && !c.el.matches("h1,h2,h3,h4,h5,h6")).sort((a, b) => b.score - a.score || a.index - b.index);
    for (const item of ranked) {
      if (excerpts.length >= 8 || budget <= 0) break;
      if (seen.has(item.text)) continue;
      seen.add(item.text);
      const label = item.heading.slice(0, Math.min(160, budget));
      budget -= label.length;
      const text = around(item.text, Math.min(1400, budget));
      if (!text) break;
      budget -= text.length;
      excerpts.push({ id: excerpts.length + 1, heading: label, text });
    }
    return { title: document.title.slice(0, 200), url: location.href.slice(0, 300), heading: heading.slice(0, 300), nearby, excerpts };
  }

  globalThis.TFContext = { collect, textOf };
})();
