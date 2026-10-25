// Yomeru UI: ページ内に出す進行バッジ / 選択範囲の操作ボタン / 翻訳・解説パネル（shadow DOM）。
// 表示だけを担当し、翻訳ロジックは持たない。content.js と同じ isolated world で globalThis.TFUi として共有。
(() => {
  if (globalThis.TFUi) return;

  // BEGIN GENERATED MARK
  const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 14 108 108" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M18 24 C36 19 53 30 63 47 C75 30 91 20 111 23 C106 48 92 67 72 77 C64 101 49 115 26 109 L29 96 C42 100 53 90 58 77 C37 70 24 50 18 24 Z M31 36 C44 40 56 54 62 67 C48 59 38 47 31 36 Z M98 35 C85 39 73 54 68 67 C81 58 92 46 98 35 Z"/></svg>';
  // END GENERATED MARK

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.badge,.panel,.selbtn,.seltools{
  --bg:#FFFFFF;--bg2:#F2F0E9;--line:#E7E4DB;--line2:#D8D4C8;--accent:#C76B4D;--accent2:#AF573C;--accent-soft:#F7E9E1;
  --ink:#1F1E1D;--ink2:#5E5C57;--muted:#8E8B82;--ok:#5B8A5F;--err:#C0493D;--err-soft:#F9E6E3;
  --shadow:0 1px 2px rgba(31,30,29,.06),0 10px 30px rgba(31,30,29,.12);
  font-family:"Yomeru Rounded","M PLUS Rounded 1c","Hiragino Maru Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif;
  color:var(--ink);line-height:1.6;letter-spacing:.01em;-webkit-font-smoothing:antialiased
}
@media (prefers-color-scheme: dark){
  .badge,.panel,.selbtn,.seltools{--bg:#30302E;--bg2:#3A3936;--line:#3E3D39;--line2:#4C4A45;--ink:#ECEAE3;--ink2:#B8B5AC;--muted:#8C8982;
    --accent-soft:#473730;--err-soft:#45302D;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35)}
}
.mark{width:18px;height:18px;color:var(--accent);display:inline-flex;align-items:center;justify-content:center;flex:none}
.mark svg{width:23px;height:23px;display:block}
button{font:inherit;cursor:pointer}

/* 進行バッジ（右下） */
.badge{position:fixed;right:18px;bottom:18px;display:flex;align-items:center;gap:10px;overflow:hidden;
  background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:9px 14px;font-size:12.5px;
  box-shadow:var(--shadow);min-width:200px;max-width:440px}
.badge .txt{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink2)}
.badge.err{border-radius:14px}
.badge.err .txt{color:var(--err);white-space:normal}
.badge .bar{height:3px;background:var(--bg2);position:absolute;left:0;right:0;bottom:0}
.badge .bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .25s}
.badge .spin{width:10px;height:10px;border:2px solid var(--accent);border-right-color:transparent;border-radius:50%;animation:tfspin .8s linear infinite;flex:none}
@keyframes tfspin{to{transform:rotate(360deg)}}
.badge button,.panel .pf button{font-size:11.5px;background:var(--bg2);border:1px solid transparent;color:var(--ink2);padding:3px 11px;border-radius:999px}
.badge button:hover,.panel .pf button:hover{background:var(--accent-soft);color:var(--accent2)}

/* 選択範囲の「翻訳」ボタン */
.selbtn{position:fixed;display:flex;align-items:center;background:var(--accent);border:none;color:#fff;font-size:12px;font-weight:700;
  padding:4px 11px 4px 8px;border-radius:999px;box-shadow:0 2px 10px rgba(217,119,87,.4)}
.selbtn svg{width:20px;height:20px;display:block;margin-right:5px}
.selbtn:hover{background:var(--accent2)}

/* 翻訳パネル */
.panel{position:fixed;width:min(460px,calc(100vw - 32px));max-height:min(60vh,520px);display:flex;flex-direction:column;
  background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);font-size:14px;overflow:hidden}
.panel .ph{display:flex;align-items:center;gap:10px;padding:9px 12px 9px 14px;border-bottom:1px solid var(--line)}
.panel .ph .t{color:var(--ink);font-size:12.5px;font-weight:600;flex:1;display:flex;align-items:center;gap:8px}
.panel .ph .cost{color:var(--muted);font-size:11px}
.panel .ph .x{background:transparent;border:none;font-size:17px;padding:0 6px;line-height:1;color:var(--muted)}
.panel .pb{padding:12px 16px 14px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--ink);line-height:1.75}
.panel .pb.wait{color:var(--muted)}
.panel .po{padding:10px 16px;border-top:1px dashed var(--line);color:var(--ink2);font-size:12.5px;white-space:pre-wrap;overflow:auto;max-height:140px;background:var(--bg2)}
.panel .pf{display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--line)}
/* ポップアップと揃えた、紙のようなパネル。 */
.badge{padding:11px 16px;border-radius:16px;right:20px;bottom:20px}
.badge .mark{width:23px;height:23px;border-radius:8px}
.badge .bar{height:2px}
.selbtn{padding:7px 13px 7px 10px;border-radius:10px;box-shadow:0 3px 12px rgba(86,46,32,.18)}
.panel{border-radius:18px}
.panel .ph{padding:14px 16px;background:var(--bg2)}
.panel .ph .mark{width:23px;height:23px;border-radius:8px}
.panel .ph .x{width:28px;height:28px;border-radius:7px}
.panel .ph .x:hover{background:var(--line);color:var(--ink)}
.panel .pb{padding:20px 22px;line-height:1.9;font-size:14px}
.panel .po{padding:16px 22px;border-top-style:solid;line-height:1.8}
.panel .pf{padding:11px 16px;gap:8px}
.panel .pf button{border-radius:7px;padding:5px 12px}
button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:480px){.badge{max-width:calc(100vw - 32px);min-width:0;right:16px;bottom:16px}}
@media(prefers-reduced-motion:reduce){.badge .spin{animation:none}.badge .bar i{transition:none}}
.seltools{position:fixed;display:flex;gap:4px;align-items:center;background:var(--bg);border:1px solid var(--line);padding:4px;border-radius:13px;box-shadow:var(--shadow)}
.seltools .selbtn{position:static;box-shadow:none;border-radius:9px;font-size:12px}
.explainbtn,.questionbtn{background:transparent;border:0;border-radius:9px;padding:7px 12px;color:var(--ink2);font-size:12px;font-weight:700}
.explainbtn:hover,.questionbtn:hover{background:var(--accent-soft);color:var(--accent2)}
.panel .question-asked{padding:12px 20px;background:var(--accent-soft);color:var(--ink2);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:116px;overflow:auto}
.panel .question-form{padding:0 20px 18px;display:flex;flex-direction:column;gap:8px}
.panel .question-form label{font-size:12px;font-weight:700;color:var(--ink2)}
.panel .question-form textarea{width:100%;min-height:78px;max-height:160px;resize:vertical;border:1px solid var(--line2);border-radius:9px;background:var(--bg);color:var(--ink);font:inherit;font-size:13px;line-height:1.6;padding:9px 11px}
.panel .question-form textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.panel .question-form button{align-self:flex-end;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:12px;font-weight:700;padding:7px 15px}
.panel .question-form button:hover{background:var(--accent2)}
.panel .pf{flex-wrap:wrap;align-items:center}
.panel .pf .refine{color:var(--accent2);background:var(--accent-soft)}
.panel .sources{padding:14px 20px;border-top:1px solid var(--line);background:var(--bg2);font-size:12px;max-height:190px;overflow:auto}
.panel .sources p{margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}
.panel .sources p:last-child{margin-bottom:0}
.panel .sources strong{display:block;margin-bottom:4px;font-size:11px;color:var(--ink2)}
.panel .pf button:disabled{opacity:.5;cursor:wait}
[hidden]{display:none !important}
`;

  const HTML = `
<style>${CSS}</style>
<div class="badge" hidden><span class="mark">${MARK}</span><span class="spin"></span><span class="txt"></span><button class="stop">中止</button><div class="bar"><i></i></div></div>
<div class="seltools" hidden><button class="selbtn" hidden>${MARK}翻訳</button><button class="explainbtn" hidden>解説</button><button class="questionbtn" hidden>質問</button></div>
<div class="panel" role="dialog" aria-label="Yomeru 選択範囲" hidden>
  <div class="ph"><span class="t"><span class="mark">${MARK}</span><span class="panel-title">Yomeru 翻訳</span></span><span class="cost"></span><button class="x" title="閉じる" aria-label="閉じる">×</button></div>
  <div class="question-asked" hidden></div>
  <div class="pb" aria-live="polite"></div>
  <form class="question-form" hidden><label for="tf-question">選択箇所について聞きたいこと</label><textarea id="tf-question" maxlength="1000" required placeholder="例：ここでの意味は？"></textarea><button type="submit">質問する</button></form>
  <div class="po" hidden></div>
  <div class="sources" hidden></div>
  <div class="pf"><button class="copy">コピー</button><button class="orig">原文を表示</button><button class="refine simple" hidden>もっとやさしく</button><button class="refine detailed" hidden>詳しく</button><button class="source-toggle" aria-expanded="false" hidden>参考箇所</button></div>
</div>`;

  const EDGE = 8; // 画面端からの最小余白(px)

  // 固定位置の要素を rect の下（入らなければ上）に置く
  function placeFixed(el, rect, offsetY) {
    const w = el.offsetWidth || 320;
    const h = el.offsetHeight || 120;
    let left = rect.left;
    let top = rect.bottom + offsetY;
    if (left + w > innerWidth - EDGE) left = Math.max(EDGE, innerWidth - w - EDGE);
    if (top + h > innerHeight - EDGE) top = Math.max(EDGE, rect.top - h - offsetY);
    el.style.left = `${Math.max(EDGE, left)}px`;
    el.style.top = `${Math.max(EDGE, top)}px`;
  }

  // 翻訳停止は content.js、選択範囲の操作は selection.js から受け取る。
  function create(handlers) {
    // 拡張の再読み込み後、ページに残った旧版の UI と重ならないようにする。
    document.querySelectorAll("#tf-host[data-tf=ui]").forEach((old) => old.remove());
    const host = document.createElement("div");
    host.id = "tf-host";
    host.setAttribute("data-tf", "ui");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = HTML;
    (document.documentElement || document.body).appendChild(host);

    const $ = (sel) => root.querySelector(sel);
    const badge = $(".badge");
    const badgeTxt = $(".badge .txt");
    const badgeSpin = $(".badge .spin");
    const badgeStop = $(".badge .stop");
    const badgeBar = $(".badge .bar i");
    const selbtn = $(".selbtn");
    const seltools = $(".seltools");
    const explainbtn = $(".explainbtn");
    const questionbtn = $(".questionbtn");
    const questionForm = $(".question-form");
    const questionInput = $(".question-form textarea");
    const sources = $(".sources");
    const panel = $(".panel");
    const panelBody = $(".panel .pb");
    const panelOrig = $(".panel .po");
    const panelCost = $(".panel .cost");
    let badgeTimer = null;
    let panelRect = null;

    badgeStop.addEventListener("click", () => handlers.onStop());
    $(".panel .x").addEventListener("click", () => hidePanel());
    $(".panel .copy").addEventListener("click", () => navigator.clipboard.writeText(panelBody.textContent || "").catch(() => {}));
    $(".panel .orig").addEventListener("click", () => { panelOrig.hidden = !panelOrig.hidden; });
    seltools.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    selbtn.addEventListener("click", (e) => { e.stopPropagation(); handlers.onTranslateSelection(); });
    explainbtn.addEventListener("click", (e) => { e.stopPropagation(); handlers.onExplainSelection(); });
    questionbtn.addEventListener("click", (e) => { e.stopPropagation(); handlers.onAskSelection(); });
    questionForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = questionInput.value.trim();
      if (question) handlers.onAskQuestion(question);
    });
    $(".simple").addEventListener("click", () => handlers.onExplainDetail("simple"));
    $(".detailed").addEventListener("click", () => handlers.onExplainDetail("detailed"));
    $(".source-toggle").addEventListener("click", () => {
      sources.hidden = !sources.hidden;
      $(".source-toggle").setAttribute("aria-expanded", String(!sources.hidden));
      if (panelRect) placeFixed(panel, panelRect, 8);
    });

    // kind: "info" | "busy" | "done" | "error"
    function showBadge(text, kind = "info", autoHideMs = 0) {
      badge.hidden = false;
      badge.classList.toggle("err", kind === "error");
      badgeTxt.textContent = text;
      badgeSpin.hidden = kind !== "busy";
      badgeStop.hidden = kind !== "busy";
      if (kind !== "busy") badgeBar.style.width = kind === "done" ? "100%" : "0";
      if (badgeTimer) clearTimeout(badgeTimer);
      badgeTimer = autoHideMs ? setTimeout(hideBadge, autoHideMs) : null;
    }
    function hideBadge() {
      badge.hidden = true;
    }
    function showProgress(done, total) {
      showBadge(`翻訳中 ${done}/${total}`, "busy");
      badgeBar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
    }

    function showSelButton(rect, explainEnabled = true) {
      seltools.hidden = false;
      selbtn.hidden = false;
      explainbtn.hidden = !explainEnabled;
      questionbtn.hidden = !explainEnabled;
      placeFixed(seltools, { left: rect.right + 6, right: rect.right, top: rect.top, bottom: rect.bottom }, 4);
    }
    function hideSelButton() {
      seltools.hidden = true;
      selbtn.hidden = true;
      explainbtn.hidden = true;
      questionbtn.hidden = true;
    }

    // パネルを「翻訳中…」状態で開く
    function openPanel(rect, originalText, { mode = "translate", question = "" } = {}) {
      panelRect = rect;
      panel.hidden = false;
      $(".panel-title").textContent = mode === "question" || question ? "Yomeru に質問" : mode === "explain" ? "Yomeru 解説" : "Yomeru 翻訳";
      $(".question-asked").hidden = !question;
      const selectedPreview = originalText.length > 160 ? `${originalText.slice(0, 160)}…` : originalText;
      $(".question-asked").textContent = question ? `選択箇所：${selectedPreview}\n質問：${question}` : "";
      panelBody.textContent = mode === "explain" ? "ページ内の関連情報を集めて解説しています…" : "翻訳中…";
      questionForm.hidden = true;
      $(".panel .pf").hidden = false;
      for (const b of root.querySelectorAll(".refine")) { b.hidden = mode !== "explain"; b.disabled = true; }
      sources.replaceChildren();
      sources.hidden = true;
      $(".source-toggle").hidden = true;
      $(".source-toggle").setAttribute("aria-expanded", "false");
      panelBody.classList.add("wait");
      panelOrig.hidden = true;
      panelOrig.textContent = originalText;
      panelCost.textContent = "";
      placeFixed(panel, rect, 8);
    }
    function openQuestionPanel(rect, originalText) {
      openPanel(rect, originalText, { mode: "question" });
      const selectedPreview = originalText.length > 160 ? `${originalText.slice(0, 160)}…` : originalText;
      $(".question-asked").textContent = `選択箇所：${selectedPreview}`;
      $(".question-asked").hidden = false;
      panelBody.classList.remove("wait");
      panelBody.textContent = "選択箇所とページ内の関連情報をもとに回答します。";
      questionInput.value = "";
      questionForm.hidden = false;
      $(".panel .pf").hidden = true;
      placeFixed(panel, rect, 8);
      questionInput.focus();
    }
    function setPanelResult(text, costLabel = "") {
      for (const b of root.querySelectorAll(".refine")) b.disabled = false;
      panelBody.classList.remove("wait");
      panelBody.textContent = text;
      panelCost.textContent = costLabel;
      if (panelRect) placeFixed(panel, panelRect, 8);
    }
    function setPanelMessage(text) {
      panelBody.classList.remove("wait");
      panelBody.textContent = text;
    }
    function setPanelSources(context) {
      sources.replaceChildren();
      const rows = [{ heading: "選択箇所の周辺", text: context.nearby }, ...context.excerpts.map((e) => ({ heading: `[${e.id}] ${e.heading || "ページ内の関連箇所"}`, text: e.text }))];
      for (const row of rows) {
        if (!row.text) continue;
        const p = document.createElement("p");
        const title = document.createElement("strong"); title.textContent = row.heading;
        p.append(title, document.createTextNode(row.text)); sources.append(p);
      }
      $(".source-toggle").hidden = !sources.childNodes.length;
    }
    function hidePanel() {
      if (!panel.hidden) handlers.onPanelClose?.();
      panel.hidden = true;
    }

    return {
      host,
      get connected() { return host.isConnected; },
      get panelOpen() { return !panel.hidden; },
      // イベントの経路に UI が含まれるか（ページ側のクリック等と区別する）
      ownsEvent: (e) => (e.composedPath ? e.composedPath() : []).includes(host),
      ownsNode: (n) => !!n && (host.contains(n) || root.contains(n)),
      showBadge, hideBadge, showProgress,
      showSelButton, hideSelButton,
      openPanel, openQuestionPanel, setPanelResult, setPanelMessage, setPanelSources, hidePanel,
    };
  }

  globalThis.TFUi = { create };
})();
