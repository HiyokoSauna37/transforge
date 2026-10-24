// システムプロンプト・セグメント書式（純粋モジュール）

export function isJapanese(lang) {
  return /日本語|japanese|^ja\b/i.test(lang || "");
}

export function buildSystemPrompt(s) {
  const lang = (s.targetLang || "日本語").trim();
  const ja = isJapanese(lang);
  const lines = [
    `You are a professional translator working inside a browser extension. Translate web page text segments into natural, fluent ${lang} that reads as if it had been written in ${lang} from the start. Favor clear, idiomatic phrasing over word-for-word rendering: the reader must understand the page without ever seeing the original.`,
    ``,
    `OUTPUT FORMAT (strict): the user message contains segments as <seg id="N">...</seg>. Reply with exactly the same segments, same ids, same order, each containing only the translation of its content. Output nothing else: no preamble, no notes, no markdown fences.`,
    ``,
    `INLINE MARKERS: inside a segment, <iN>...</iN> wraps formatted text (links, bold, etc.) and <iN/> is an opaque placeholder (inline code, image, line break). Every marker present in the input must appear exactly once in the output, with the same id and the same form (paired stays paired, self-closing stays self-closing). Never drop, add, rename, or re-nest markers. Translate the text inside <iN>...</iN>; never put text inside a self-closing <iN/>.`,
    ``,
    `WORD ORDER ACROSS MARKERS (important): translate each segment as ONE sentence, not as a sequence of marked fragments. ${lang} word order usually differs from the source, so move the markers freely so that each marker wraps the ${lang} phrase that corresponds to the original marked phrase, wherever that phrase naturally falls in the sentence${ja ? `. Example: "See <i0>the documentation</i0> for <i1>details</i1>." → "<i1>詳細</i1>は<i0>ドキュメント</i0>を参照してください。"` : ""}. Never keep the source order at the cost of unnatural ${lang}, and never translate the text inside a marker in isolation from the rest of the sentence. Particles and surrounding words go outside the markers unless they were inside in the source.`,
    ``,
    `DO NOT TRANSLATE: code, identifiers, option / parameter / property names, class / method / function names, file paths, URLs, command lines, product and project names, version numbers, enum constants, and type names such as String, boolean, Integer, Duration, Object, Map. Keep literal values such as true / false / null exactly as written. Keep HTML entities (&lt; &gt; &amp;) as they are.`,
    ``,
    `TERMINOLOGY: use the customary ${lang} equivalents of established technical terms${ja ? " (e.g. producer → プロデューサー, consumer → コンシューマー, endpoint → エンドポイント, route → ルート, exchange → エクスチェンジ, header → ヘッダー, timeout → タイムアウト)" : ""}. When practitioners normally keep an English term as-is, keep it.`,
    ``,
    `SEGMENTS ARE INDEPENDENT: keep each segment's meaning complete, never merge or split segments, never add explanations. Headings, menu items, buttons, and short table cells stay short. If a segment is already in ${lang} or contains nothing translatable (numbers, symbols, a bare identifier or type name), return it unchanged.`,
  ];
  if (ja) {
    lines.push(``, `JAPANESE STYLE: body text in です・ます調 (documentation register); headings, menu items, buttons, and short table cells in concise 体言止め. Keep ASCII letters and digits half-width. Translate "Name / Description / Default / Type" style table headers as 名前 / 説明 / 既定値 / 型. Boolean "Whether ..." option descriptions become "〜するかどうか。".`);
  }
  const custom = (s.customInstructions || "").trim();
  if (custom) lines.push(``, `ADDITIONAL INSTRUCTIONS FROM THE USER:`, custom);
  const gl = parseGlossary(s.glossary);
  if (gl.length) {
    lines.push(``, `GLOSSARY (always use these renderings):`);
    for (const [src, dst] of gl) lines.push(`- ${src} → ${dst}`);
  }
  return lines.join("\n");
}

export function parseGlossary(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.+?)\s*(?:=|→|->|\t)\s*(.+)$/);
    if (m) out.push([m[1].trim(), m[2].trim()]);
  }
  return out;
}

// segments: [{id, text}]（text は既にエスケープ済みのマーカー入り文字列）
export function buildUserMessage(segments, context) {
  const head = [];
  if (context && (context.title || context.url)) {
    head.push(`Context: page "${(context.title || "").slice(0, 200)}"${context.url ? ` at ${context.url.slice(0, 300)}` : ""}.`);
  }
  head.push(`Translate the following ${segments.length} segment(s).`, ``);
  const body = segments.map((s) => `<seg id="${s.id}">${s.text}</seg>`).join("\n");
  return head.join("\n") + body;
}

// モデル出力 → {id: content}
export function parseSegments(text) {
  const out = {};
  if (!text) return out;
  let t = text.trim();
  // 万一コードフェンスで包まれた場合は剥がす
  t = t.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const re = /<seg\s+id\s*=\s*["']?(\d+)["']?\s*>([\s\S]*?)<\/seg\s*>/g;
  let m;
  while ((m = re.exec(t))) {
    const id = Number(m[1]);
    if (!(id in out)) out[id] = m[2].trim();
  }
  return out;
}
