// TransForge UI: ページ内に出す進行バッジ / 選択翻訳ボタン / 翻訳パネル（shadow DOM）。
// 表示だけを担当し、翻訳ロジックは持たない。content.js と同じ isolated world で globalThis.TFUi として共有。
(() => {
  if (globalThis.TFUi) return;

  // 羽根ロゴ（icons/feather.svg と同一。tools/make_icons.py が生成）
  const FEATHER =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" class="fe"><g transform="rotate(38 64 64)" fill="none" stroke-linecap="round">' +
    '<path class="fe-c" d="M64 90 C64 100 65 110 67 122" stroke="#FAF9F5" stroke-width="6"/>' +
    '<path class="fe-c" d="M64 12 C40 28 30 64 46 92 C52 95 58 96 64 96 C70 96 74 94 78 90 C92 64 86 30 64 12 Z" fill="#FAF9F5" stroke="none"/>' +
    '<path class="fe-x" d="M64 20 C62 48 62 86 64 92" stroke="#D97757" stroke-width="2.6"/>' +
    '<path class="fe-x" d="M62 50 L37 36 M62 72 L33 62 M66 60 L92 48" stroke="#D97757" stroke-width="3.2"/></g></svg>';

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.badge,.panel,.selbtn{
  --bg:#FFFFFF;--bg2:#F2F0E9;--line:#E7E4DB;--line2:#D8D4C8;--accent:#D97757;--accent2:#C4623F;--accent-soft:#F7E9E1;
  --ink:#1F1E1D;--ink2:#5E5C57;--muted:#8E8B82;--ok:#5B8A5F;--err:#C0493D;--err-soft:#F9E6E3;
  --shadow:0 1px 2px rgba(31,30,29,.06),0 10px 30px rgba(31,30,29,.12);
  font-family:"TransForge Rounded","M PLUS Rounded 1c","Hiragino Maru Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif;
  color:var(--ink);line-height:1.6;letter-spacing:.01em;-webkit-font-smoothing:antialiased
}
@media (prefers-color-scheme: dark){
  .badge,.panel,.selbtn{--bg:#30302E;--bg2:#3A3936;--line:#3E3D39;--line2:#4C4A45;--ink:#ECEAE3;--ink2:#B8B5AC;--muted:#8C8982;
    --accent-soft:#473730;--err-soft:#45302D;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35)}
}
.mark{width:18px;height:18px;border-radius:6px;background:var(--accent);display:inline-flex;align-items:center;justify-content:center;flex:none}
.mark svg{width:13px;height:13px;display:block}
.fe-x{stroke:var(--accent)}
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
.selbtn svg{width:14px;height:14px;display:block;margin-right:5px}
.selbtn:hover{background:var(--accent2)}
.selbtn:hover .fe-x{stroke:var(--accent2)}

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
[hidden]{display:none !important}
`;

  const HTML = `
<style>${CSS}</style>
<div class="badge" hidden><span class="mark">${FEATHER}</span><span class="spin"></span><span class="txt"></span><button class="stop">中止</button><div class="bar"><i></i></div></div>
<button class="selbtn" hidden>${FEATHER}翻訳</button>
<div class="panel" hidden>
  <div class="ph"><span class="t"><span class="mark">${FEATHER}</span>Claude 翻訳</span><span class="cost"></span><button class="x" title="閉じる">×</button></div>
  <div class="pb"></div>
  <div class="po" hidden></div>
  <div class="pf"><button class="copy">コピー</button><button class="orig">原文を表示</button></div>
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

  // handlers: {onStop, onTranslateSelection}
  function create(handlers) {
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
    selbtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    selbtn.addEventListener("click", (e) => { e.stopPropagation(); handlers.onTranslateSelection(); });

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

    function showSelButton(rect) {
      selbtn.hidden = false;
      placeFixed(selbtn, { left: rect.right + 6, right: rect.right, top: rect.top, bottom: rect.bottom }, 4);
    }
    function hideSelButton() {
      selbtn.hidden = true;
    }

    // パネルを「翻訳中…」状態で開く
    function openPanel(rect, originalText) {
      panelRect = rect;
      panel.hidden = false;
      panelBody.textContent = "翻訳中…";
      panelBody.classList.add("wait");
      panelOrig.hidden = true;
      panelOrig.textContent = originalText;
      panelCost.textContent = "";
      placeFixed(panel, rect, 8);
    }
    function setPanelResult(text, costLabel = "") {
      panelBody.classList.remove("wait");
      panelBody.textContent = text;
      panelCost.textContent = costLabel;
      if (panelRect) placeFixed(panel, panelRect, 8);
    }
    function setPanelMessage(text) {
      panelBody.classList.remove("wait");
      panelBody.textContent = text;
    }
    function hidePanel() {
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
      openPanel, setPanelResult, setPanelMessage, hidePanel,
    };
  }

  globalThis.TFUi = { create };
})();
