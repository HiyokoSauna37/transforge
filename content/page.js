// Yomeru page DOM controller: 翻訳対象の追跡、訳文の適用、原文への復元をまとめて管理する。
// content.js と同じ isolated world で globalThis.TFPage として共有する。
(() => {
  if (globalThis.TFPage) return;

  const Seg = globalThis.TFSeg;
  if (!Seg) return;

  function create({ getMode, mutate }) {
    let records = [];
    let done = new WeakSet();
    let translatedText = new WeakMap();
    let pendingUnits = null;

    function collectUnits(root, opts) {
      return Seg.collectUnits(root, { ...opts, exclude: done });
    }

    // run 開始時に全ノードを予約し、並行バッチや observer による重複翻訳を防ぐ。
    function begin(units) {
      units.forEach((unit, index) => {
        unit.id = index;
        for (const node of unit.nodes) done.add(node);
      });
      pendingUnits = new Set(units);
    }

    // 適用できなかったユニットだけを次回の翻訳対象へ戻す。
    function releasePending() {
      if (!pendingUnits) return;
      for (const unit of pendingUnits) for (const node of unit.nodes) done.delete(node);
      pendingUnits = null;
    }

    function withUnit(unit, fn) {
      if (!unit.nodes[0].isConnected) return;
      pendingUnits?.delete(unit);
      mutate(fn);
    }

    function markGenerated(fragment) {
      const walk = (node) => {
        done.add(node);
        if (node.nodeType === 1) node.setAttribute("data-tf", "gen");
        for (const child of node.childNodes) walk(child);
      };
      for (const child of fragment.childNodes) walk(child);
    }

    function replaceRun(unit, fragment, loose) {
      const first = unit.nodes[0];
      const parent = first.parentNode;
      if (!parent) return;
      let generated = Array.from(fragment.childNodes);
      if (loose) {
        const span = document.createElement("span");
        span.setAttribute("data-tf", "gen");
        span.setAttribute("data-tf-loose", "1");
        span.title = "書式マーカーの復元に失敗したため、書式の位置が原文と異なる可能性があります";
        span.appendChild(fragment);
        done.add(span);
        generated = [span];
        parent.insertBefore(span, first);
      } else {
        parent.insertBefore(fragment, first);
      }
      for (const node of unit.nodes) node.remove();
      records.push({ kind: "replace", originals: unit.nodes, generated, parent });
    }

    function insertBilingual(unit, fragment, loose) {
      const wrapper = document.createElement(unit.block ? "div" : "span");
      wrapper.className = "tf-trans" + (unit.block ? " tf-trans-block" : "");
      wrapper.setAttribute("data-tf", "gen");
      if (loose) wrapper.setAttribute("data-tf-loose", "1");
      wrapper.appendChild(fragment);
      done.add(wrapper);
      const last = unit.nodes[unit.nodes.length - 1];
      last.parentNode.insertBefore(wrapper, last.nextSibling);
      records.push({ kind: "bilingual", wrapper });
    }

    function applyTree(unit, tree) {
      withUnit(unit, () => {
        if (getMode() === "bilingual") {
          const fragment = Seg.build(tree, unit, { stripId: true });
          markGenerated(fragment);
          insertBilingual(unit, fragment, false);
          return;
        }
        // replace: まず in-place（元ノードを残す）を試み、構造が違えばクローン置換
        const inplace = Seg.applyInPlace(tree, unit);
        if (inplace) {
          for (const node of inplace.touched) {
            done.add(node);
            translatedText.set(node, node.data);
          }
          for (const ref of unit.refs) done.add(ref);
          records.push({ kind: "inplace", changes: inplace.changes });
          return;
        }
        const fragment = Seg.build(tree, unit, { stripId: false });
        markGenerated(fragment);
        replaceRun(unit, fragment, false);
      });
    }

    function applyLoose(unit, text) {
      withUnit(unit, () => {
        const bilingual = getMode() === "bilingual";
        const fragment = Seg.buildLoose(text, unit, { stripId: bilingual });
        markGenerated(fragment);
        if (bilingual) insertBilingual(unit, fragment, true);
        else replaceRun(unit, fragment, true);
      });
    }

    // マーカー復元に失敗したら、allowLoose のときだけ書式を緩く復元する。
    function applyTranslation(unit, text, { allowLoose }) {
      const tree = Seg.parseTranslated(text, unit.kinds);
      if (tree) {
        applyTree(unit, tree);
        return true;
      }
      if (!allowLoose) return false;
      applyLoose(unit, text);
      return true;
    }

    function revertRecord(record) {
      if (record.kind === "inplace") {
        Seg.revertInPlace(record.changes);
        return;
      }
      if (record.kind === "bilingual") {
        record.wrapper.remove();
        return;
      }
      const anchor = record.generated.find((node) => node.parentNode === record.parent);
      for (const original of record.originals) {
        if (anchor) record.parent.insertBefore(original, anchor);
        else record.parent.appendChild(original);
      }
      for (const generated of record.generated) generated.remove();
    }

    function restore() {
      mutate(() => {
        for (let index = records.length - 1; index >= 0; index--) {
          try {
            revertRecord(records[index]);
          } catch {
            /* ページ側で既に消えた等 */
          }
        }
      });
      records = [];
      done = new WeakSet();
      translatedText = new WeakMap();
      pendingUnits = null;
    }

    return {
      collectUnits,
      begin,
      releasePending,
      applyTranslation,
      restore,
      hasChanges: () => records.length > 0,
      isDone: (node) => done.has(node),
      translatedValue: (node) => translatedText.get(node),
      forget: (node) => done.delete(node),
    };
  }

  globalThis.TFPage = { create };
})();
