// YouTube 字幕の表示と後片付け。字幕取得・翻訳・再生時刻の管理は youtube.js が担当する。
(() => {
  if (globalThis.TFYouTubeUi) return;

  const HTML = `<style>
    :host{all:initial}:host([hidden]){display:none!important}*{box-sizing:border-box}[hidden]{display:none!important}
    .captions{position:absolute;left:6%;right:6%;bottom:13%;text-align:center;color:#fff;font-family:system-ui,sans-serif;line-height:1.5;pointer-events:none}
    .line{width:fit-content;max-width:100%;margin:3px auto;padding:3px 12px;border-radius:6px;background:rgba(20,19,17,.86);white-space:pre-wrap;overflow-wrap:anywhere;font-size:clamp(17px,2.1vw,30px)}
    .original{font-size:clamp(13px,1.5vw,21px);color:#e2dfd7}
    .notice{color:#e2dfd7;font-size:12px}.tools{position:absolute;top:12px;left:12px;display:flex;gap:8px;align-items:center;max-width:85%;font:12px/1.6 system-ui,sans-serif;color:#eee9df}
    .tools button{font:inherit;border:1px solid #625e54;border-radius:8px;background:rgba(36,34,30,.88);color:#eee9df;padding:5px 10px;cursor:pointer;pointer-events:auto}
    .tools button:focus-visible{outline:2px solid #eee9df;outline-offset:3px}
    .status{border-radius:6px;background:rgba(36,34,30,.88);padding:4px 8px;white-space:pre-wrap;overflow-wrap:anywhere}
  </style><div class="tools"><button type="button" aria-label="Yomeru の字幕を停止" title="字幕を停止">yomeru ×</button><span class="status" role="status" aria-live="polite"></span></div><div class="captions"><div class="line translated" lang="en" hidden></div><div class="line original" hidden></div><div class="line notice" hidden>翻訳を準備しています…</div></div>`;

  function create({ onStop }) {
    let host = null;
    let root = null;
    let nativeStyle = null;

    function destroy() {
      nativeStyle?.remove(); nativeStyle = null;
      host?.remove(); host = root = null;
    }

    function mount(player) {
      if (!player) throw new Error("動画プレイヤーが見つかりません。動画を開いてから開始してください");
      if (host?.parentElement === player) return;
      destroy();
      document.querySelectorAll("#tf-youtube-subtitles[data-tf]").forEach((el) => el.remove());
      host = document.createElement("div");
      host.id = "tf-youtube-subtitles"; host.dataset.tf = "subtitles";
      host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:60;";
      root = host.attachShadow({ mode: "open" });
      root.innerHTML = HTML;
      root.querySelector("button").addEventListener("click", onStop);
      player.append(host);
      nativeStyle = document.createElement("style"); nativeStyle.dataset.tf = "subtitles";
      nativeStyle.textContent = "#movie_player .ytp-caption-window-container{visibility:hidden!important}";
      // 元の字幕設定は変えず、翻訳字幕を出す間だけ隠す。停止・エラー時は style を外して復元する。
    }

    function showStatus(text) {
      if (!root) return;
      const node = root.querySelector(".status");
      if (node.textContent !== text) node.textContent = text;
      node.hidden = !text;
    }

    function showError(message) {
      nativeStyle?.remove();
      if (root) {
        root.querySelector(".captions").hidden = true;
        showStatus(message);
      }
    }

    function render(player, { status, error, ad, cue, translated, targetLang, sourceLang, mode, busy }) {
      mount(player);
      host.hidden = ad;
      if (ad) { nativeStyle.remove(); return; }
      if (status === "error") { showError(error); return; }
      if (status === "loading") { showStatus("字幕を読み込んでいます…"); return; }
      if (!nativeStyle.isConnected) player.append(nativeStyle);
      root.querySelector(".captions").hidden = false;
      const line = root.querySelector(".translated"), original = root.querySelector(".original");
      line.textContent = translated || ""; line.hidden = !translated;
      line.lang = targetLang === "日本語" ? "ja" : "en";
      original.textContent = cue?.text || ""; original.hidden = !cue || (mode !== "bilingual" && !!translated);
      original.lang = sourceLang;
      root.querySelector(".notice").hidden = !cue || !!translated;
      showStatus(!cue && busy ? "字幕を先読みしています…" : "");
    }

    return { render, showError, destroy };
  }

  globalThis.TFYouTubeUi = { create };
})();
