// 字幕の時刻・先読みバッチ。DOM/API 非依存で、content script とテストで共有する。
(() => {
  if (globalThis.TFSubtitleTimeline) return;
  function normalize(input) {
    if (!Array.isArray(input) || input.length > 12000) throw new Error("字幕が多すぎるか、形式を読み取れませんでした");
    const rows = input.map((c) => ({ start: c.start, end: c.end, text: typeof c.text === "string" ? c.text.replace(/\s+/g, " ").trim() : "" }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start && c.text)
      .sort((a, b) => a.start - b.start);
    if (rows.some((c) => c.text.length > 2000) || rows.reduce((n, c) => n + c.text.length, 0) > 1000000) throw new Error("字幕の長さが対応範囲を超えています");
    const out = [];
    for (const c of rows) {
      const prev = out.at(-1);
      if (prev && prev.text === c.text && c.start <= prev.end + 0.1) { prev.end = Math.max(prev.end, c.end); continue; }
      if (prev && prev.start === c.start) { prev.text = `${prev.text} ${c.text}`; prev.end = Math.max(prev.end, c.end); continue; }
      out.push({ ...c });
    }
    out.forEach((c, id) => {
      c.id = id;
      if (out[id + 1]) c.end = Math.min(c.end, out[id + 1].start);
      if (c.text.length > 2000) throw new Error("字幕の長さが対応範囲を超えています");
    });
    return out;
  }
  function indexAt(cues, time) {
    let lo = 0, hi = cues.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cues[mid].start <= time) lo = mid + 1; else hi = mid; }
    const i = lo - 1;
    return i >= 0 && time < cues[i].end ? i : -1;
  }
  function batches(cues) {
    const out = [];
    let current = [], size = 0;
    for (const c of cues) {
      if (current.length && (current.length >= 12 || size + c.text.length > 5000 || c.start - current[0].start >= 45)) {
        out.push(current); current = []; size = 0;
      }
      current.push(c); size += c.text.length;
    }
    if (current.length) out.push(current);
    return out;
  }
  function nextBatch(groups, time, translated, ahead = 40) {
    return groups.findIndex((g) => g.at(-1).end > time && g[0].start <= time + ahead && g.some((c) => !translated.has(c.id)));
  }
  function context(cues, first, last) {
    // 長い字幕でも元の字幕は切らず、参考用の前後文脈だけを予算に収める。
    const take = (rows) => rows.map(({ text }) => ({ text: text.slice(0, 650) }));
    return { before: take(cues.slice(Math.max(0, first - 3), first)), after: take(cues.slice(last + 1, last + 4)) };
  }
  globalThis.TFSubtitleTimeline = { normalize, indexAt, batches, nextBatch, context };
})();
