// TransForge segmenter: 文書を翻訳単位（run）に分割し、<iN> マーカー付き文字列へ直列化 / 復元する DOM ロジック。
// content.js と同じ isolated world で globalThis.TFSeg として共有。テストからも読み込める純粋 DOM 実装。
(() => {
  if (globalThis.TFSeg) return;

  const SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "PRE", "TEXTAREA", "IFRAME", "OBJECT", "EMBED",
    "CANVAS", "VIDEO", "AUDIO", "SELECT", "OPTION", "OPTGROUP", "DATALIST", "HEAD", "META", "LINK",
    "TITLE", "XMP", "PLAINTEXT", "RP", "RT",
  ]);
  // 書式用インライン要素: 浅くクローンして中身を翻訳
  const INLINE = new Set([
    "A", "ABBR", "ACRONYM", "B", "BDI", "BDO", "BIG", "CITE", "DATA", "DEL", "DFN", "EM", "FONT", "I",
    "INS", "LABEL", "MARK", "Q", "S", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP", "TIME", "U", "NOBR",
  ]);
  // 不透明インライン: そのまま保持（自己閉じプレースホルダ）
  const OPAQUE = new Set([
    "CODE", "KBD", "SAMP", "VAR", "TT", "IMG", "BR", "WBR", "INPUT", "PICTURE", "METER", "PROGRESS",
    "MATH", "SVG", "RUBY",
  ]);
  const NAV = new Set(["NAV", "ASIDE"]);
  const HAS_WORD = /[\p{L}\p{N}]/u;
  const HAS_LETTER = /\p{L}/u;
  const LETTER = /\p{L}/gu;
  const JA = /[぀-ヿ㐀-䶿一-鿿]/g;
  const MARKER = /<\s*(\/?)\s*i(\d+)\s*(\/?)\s*>/g;

  const tagOf = (n) => (n.nodeType === 1 ? n.tagName.toUpperCase() : "");
  const isForeign = (n) =>
    n.namespaceURI === "http://www.w3.org/2000/svg" || n.namespaceURI === "http://www.w3.org/1998/Math/MathML";
  const noTranslate = (el) =>
    el.getAttribute("translate") === "no" || (el.classList && el.classList.contains("notranslate"));
  const isOurs = (el) => el.hasAttribute("data-tf");
  const hasWord = (n) => HAS_WORD.test(n.textContent || "");

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function unesc(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  function stripMarkers(s) {
    return s.replace(MARKER, "");
  }

  function hasBlockDescendant(el, depth) {
    for (const c of el.children) {
      const t = tagOf(c);
      if (isForeign(c) || OPAQUE.has(t) || SKIP.has(t)) continue;
      if (!INLINE.has(t)) return true;
      if (depth < 3 && hasBlockDescendant(c, depth + 1)) return true;
    }
    return false;
  }

  // "skip" | "opaque" | "inline" | "container"
  function classify(el, opts) {
    const tag = tagOf(el);
    if (isForeign(el)) return "opaque";
    if (isOurs(el)) return "skip";
    if (SKIP.has(tag)) return "skip";
    if (opts.skipNav && (NAV.has(tag) || el.getAttribute("role") === "navigation")) return "skip";
    if (el.isContentEditable) return "skip";
    if (OPAQUE.has(tag)) return "opaque";
    if (noTranslate(el)) return INLINE.has(tag) ? "opaque" : "skip";
    if (INLINE.has(tag)) {
      if (hasBlockDescendant(el, 0)) return "container";
      return hasWord(el) ? "inline" : "opaque";
    }
    return "container";
  }

  function visible(el) {
    if (typeof el.checkVisibility === "function") {
      try { return el.checkVisibility({ visibilityProperty: true }); } catch { return true; }
    }
    return true;
  }

  function looksLikeTarget(text, targetLang) {
    if (!/日本語|japanese|^ja\b/i.test(targetLang || "")) return false;
    const letters = (text.match(LETTER) || []).length;
    if (!letters) return false;
    const ja = (text.match(JA) || []).length;
    return ja / letters >= 0.3;
  }

  function coversWhole(nodes, parentEl) {
    const set = new Set(nodes);
    for (const c of parentEl.childNodes) {
      if (set.has(c)) continue;
      if (c.nodeType === 3 && !c.data.trim()) continue;
      if (c.nodeType === 1 && isOurs(c)) continue;
      if (c.nodeType !== 1 && c.nodeType !== 3) continue;
      return false;
    }
    return true;
  }

  // run（連続する text / inline / opaque ノード）→ {text, refs, kinds}
  function serialize(nodes) {
    const refs = [];
    const kinds = [];
    let out = "";
    const ser = (n) => {
      if (n.nodeType === 3) { out += esc(n.data); return; }
      if (n.nodeType !== 1) return;
      const t = tagOf(n);
      const inline =
        !isForeign(n) && !OPAQUE.has(t) && INLINE.has(t) && !noTranslate(n) && !isOurs(n) && hasWord(n) && !hasBlockDescendant(n, 0);
      const i = refs.push(n) - 1;
      kinds.push(inline ? "inline" : "opaque");
      if (inline) {
        out += `<i${i}>`;
        for (const c of n.childNodes) ser(c);
        out += `</i${i}>`;
      } else {
        out += `<i${i}/>`;
      }
    };
    for (const n of nodes) ser(n);
    out = out.replace(/\s+/g, " ").trim();
    return { text: out, refs, kinds };
  }

  function makeUnit(nodes, opts) {
    const { text, refs, kinds } = serialize(nodes);
    const plain = unesc(stripMarkers(text));
    if (!HAS_LETTER.test(plain)) return null; // 数字・記号だけの run は送らない
    if (looksLikeTarget(plain, opts.targetLang)) return null;
    const parentEl = nodes[0].parentElement;
    let block = true;
    if (parentEl) {
      const disp = getComputedStyle(parentEl).display;
      block = coversWhole(nodes, parentEl) && !/^inline/.test(disp) && disp !== "contents";
    }
    return { id: -1, nodes, parent: nodes[0].parentNode, text, refs, kinds, block };
  }

  // root 配下の翻訳単位を DOM 順で収集。opts: {exclude: WeakSet, targetLang, skipNav}
  function collectUnits(root, opts = {}) {
    const exclude = opts.exclude || new WeakSet();
    const units = [];
    const visit = (el) => {
      if (el.nodeType === 1) {
        if (exclude.has(el)) return;
        if (classify(el, opts) !== "container") return;
        if (!visible(el)) return;
        if (el.shadowRoot) visit(el.shadowRoot);
      }
      let run = [];
      const flush = () => {
        if (run.length) {
          const u = makeUnit(run, opts);
          if (u) units.push(u);
          run = [];
        }
      };
      for (const n of el.childNodes) {
        if (n.nodeType === 3) {
          if (exclude.has(n)) { flush(); continue; }
          run.push(n);
          continue;
        }
        if (n.nodeType !== 1) continue; // コメント等
        if (exclude.has(n)) { flush(); continue; }
        const c = classify(n, opts);
        if (c === "inline" || c === "opaque") { run.push(n); continue; }
        flush();
        if (c === "container") visit(n);
      }
      flush();
    };
    visit(root);
    return units;
  }

  // 画面内のものを先頭に、次に上から順に並べ替える
  function sortByViewport(units) {
    const vh = globalThis.innerHeight || 800;
    units.forEach((u, i) => {
      let top = Number.MAX_SAFE_INTEGER;
      try {
        const first = u.nodes[0];
        if (first.nodeType === 1) top = first.getBoundingClientRect().top;
        else {
          const r = document.createRange();
          r.selectNodeContents(first);
          const rect = r.getBoundingClientRect();
          top = rect.height || rect.width ? rect.top : (first.parentElement ? first.parentElement.getBoundingClientRect().top : 0);
        }
      } catch { /* detached 等 */ }
      u._top = top;
      u._vis = top > -100 && top < vh + 200 ? 0 : 1;
      u._idx = i;
    });
    units.sort((a, b) => a._vis - b._vis || (a._vis === 0 ? a._top - b._top : a._idx - b._idx));
    return units;
  }

  function makeBatches(units, maxChars, maxSegs = 80) {
    const batches = [];
    let cur = [];
    let size = 0;
    let limit = Math.min(maxChars, 1200); // 先頭バッチだけ小さくして初回表示を早める
    for (const u of units) {
      const len = u.text.length;
      if (cur.length && (size + len > limit || cur.length >= maxSegs)) {
        batches.push(cur);
        cur = [];
        size = 0;
        limit = maxChars;
      }
      cur.push(u);
      size += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  // 翻訳文字列 → ツリー。検証に失敗したら null
  function parseTranslated(str, kinds) {
    const refCount = kinds.length;
    const root = { type: "root", children: [] };
    const stack = [root];
    const seen = new Set();
    let last = 0;
    const re = new RegExp(MARKER.source, "g");
    const pushText = (s) => { if (s) stack[stack.length - 1].children.push({ type: "text", value: unesc(s) }); };
    let m;
    while ((m = re.exec(str))) {
      pushText(str.slice(last, m.index));
      last = re.lastIndex;
      const closing = !!m[1];
      const idx = Number(m[2]);
      const self = !!m[3];
      if (idx >= refCount) { pushText(m[0]); continue; }
      if (closing) {
        const top = stack[stack.length - 1];
        if (top === root || top.idx !== idx) return null;
        stack.pop();
        continue;
      }
      if (seen.has(idx)) return null;
      seen.add(idx);
      const node = { type: "el", idx, self, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!self) stack.push(node);
    }
    pushText(str.slice(last));
    if (stack.length !== 1) return null;
    if (seen.size !== refCount) return null;
    // inline を自己閉じで返された（中身が失われた）場合は無効
    const okForms = (children) => children.every((c) => c.type === "text" || ((kinds[c.idx] !== "inline" || !c.self) && okForms(c.children)));
    if (!okForms(root.children)) return null;
    return root.children;
  }

  function stripIds(el) {
    if (el.nodeType !== 1) return;
    el.removeAttribute("id");
    for (const d of el.querySelectorAll("[id]")) d.removeAttribute("id");
  }

  // ツリー → DocumentFragment（inline は浅くクローン、opaque は深くクローン）
  function build(tree, unit, { stripId = false } = {}) {
    const frag = document.createDocumentFragment();
    const rec = (children, parent) => {
      for (const c of children) {
        if (c.type === "text") { parent.appendChild(document.createTextNode(c.value)); continue; }
        const orig = unit.refs[c.idx];
        let el;
        if (unit.kinds[c.idx] === "inline") {
          el = orig.cloneNode(false);
          rec(c.children, el);
        } else {
          el = orig.cloneNode(true);
        }
        if (stripId) stripIds(el);
        parent.appendChild(el);
      }
    };
    rec(tree, frag);
    return frag;
  }

  // マーカー復元に失敗したときの緩い組み立て: 訳文テキスト + 上位 ref を原順で後置
  function buildLoose(str, unit, { stripId = false } = {}) {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(unesc(stripMarkers(str))));
    const top = new Set(unit.nodes);
    unit.refs.forEach((orig) => {
      if (!top.has(orig)) return;
      if (!hasWord(orig) && !["IMG", "BR", "INPUT"].includes(tagOf(orig))) return; // 空アンカー等は省く
      frag.appendChild(document.createTextNode(" "));
      const el = orig.cloneNode(true);
      if (stripId) stripIds(el);
      frag.appendChild(el);
    });
    return frag;
  }

  // ---- in-place 適用: 構造が一致するなら元ノードを残して text.data を書き換える（SPA に優しい） ----
  function elOrder(container, unit, topLevel) {
    const list = topLevel ? unit.nodes : Array.from(container.childNodes);
    const out = [];
    for (const n of list) {
      if (n.nodeType !== 1) continue;
      const i = unit.refs.indexOf(n);
      if (i < 0) return null; // 未知の要素
      out.push(i);
    }
    return out;
  }

  function structureMatches(tree, unit) {
    const check = (children, container, topLevel) => {
      const expect = elOrder(container, unit, topLevel);
      if (!expect) return false;
      const got = children.filter((c) => c.type === "el").map((c) => c.idx);
      if (got.length !== expect.length) return false;
      for (let i = 0; i < got.length; i++) if (got[i] !== expect[i]) return false;
      for (const c of children) {
        if (c.type !== "el") continue;
        if (unit.kinds[c.idx] === "inline" && !check(c.children, unit.refs[c.idx], false)) return false;
      }
      return true;
    };
    return check(tree, null, true);
  }

  // 戻り値: changes 配列（restore 用）。構造不一致なら null
  function applyInPlace(tree, unit) {
    if (!structureMatches(tree, unit)) return null;
    const changes = [];
    const touched = [];
    const apply = (children, container, topLevel) => {
      // 新しいテキストスロット: 要素 k の直前テキスト（k=0..n）
      const slots = [""];
      const els = [];
      for (const c of children) {
        if (c.type === "text") slots[slots.length - 1] += c.value;
        else { els.push(c); slots.push(""); }
      }
      // 元のテキストスロット
      const origList = topLevel ? unit.nodes : Array.from(container.childNodes);
      const origSlots = [[]];
      const origEls = [];
      for (const n of origList) {
        if (n.nodeType === 3) origSlots[origSlots.length - 1].push(n);
        else if (n.nodeType === 1) { origEls.push(n); origSlots.push([]); }
      }
      const parentNode = topLevel ? unit.nodes[0].parentNode : container;
      for (let k = 0; k < slots.length; k++) {
        const text = slots[k];
        const orig = origSlots[k];
        if (orig.length) {
          changes.push({ node: orig[0], old: orig[0].data });
          orig[0].data = text;
          touched.push(orig[0]);
          for (let j = 1; j < orig.length; j++) {
            changes.push({ node: orig[j], old: orig[j].data });
            orig[j].data = "";
            touched.push(orig[j]);
          }
        } else if (text) {
          const t = document.createTextNode(text);
          if (k < origEls.length) parentNode.insertBefore(t, origEls[k]);
          else if (topLevel) parentNode.insertBefore(t, unit.nodes[unit.nodes.length - 1].nextSibling);
          else parentNode.appendChild(t);
          changes.push({ inserted: t });
          touched.push(t);
        }
      }
      for (const c of els) {
        if (unit.kinds[c.idx] === "inline") apply(c.children, unit.refs[c.idx], false);
      }
    };
    apply(tree, null, true);
    return { changes, touched };
  }

  function revertInPlace(changes) {
    for (let i = changes.length - 1; i >= 0; i--) {
      const ch = changes[i];
      if (ch.inserted) ch.inserted.remove();
      else ch.node.data = ch.old;
    }
  }

  globalThis.TFSeg = {
    esc, unesc, stripMarkers,
    collectUnits, sortByViewport, makeBatches,
    parseTranslated, build, buildLoose,
    applyInPlace, revertInPlace,
  };
})();
