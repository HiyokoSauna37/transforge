// 翻訳Canvasと操作ボタンの表示・追従・後片付け。画像解析と配置計算は外へ分離する。
(() => {
  if (globalThis.TFImageOverlay) return;
  const layout = globalThis.TFImageLayout;
  const STYLES = `
:host{all:initial}
[hidden]{display:none!important}
.frame{position:fixed;overflow:hidden;pointer-events:none;box-sizing:border-box}
.image{position:absolute;display:block;pointer-events:none}
.status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:calc(100% - 16px);padding:8px 12px;border-radius:10px;background:rgba(30,27,25,.9);color:#fff;font:600 12px/1.5 system-ui,sans-serif;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.24)}
.status.busy::before{content:"";display:inline-block;width:11px;height:11px;margin-right:7px;vertical-align:-1px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
.status.error{background:rgba(132,38,38,.94)}
.actions{position:absolute;right:7px;top:7px;display:flex;gap:5px;pointer-events:auto}
.actions button{border:1px solid rgba(255,255,255,.42);border-radius:8px;background:rgba(30,27,25,.88);color:#fff;font:600 11px/1 system-ui,sans-serif;padding:7px 9px;box-shadow:0 2px 9px rgba(0,0,0,.22);cursor:pointer}
.actions button:hover{background:rgba(70,61,56,.95)}
@keyframes spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.status.busy::before{animation:none}}`;

  function setRect(element, rect) {
    for (const property of ["left", "top", "width", "height"]) element.style[property] = `${rect[property]}px`;
  }

  function imageOverlay(onClose) {
    const host = document.createElement("div");
    host.id = "tf-image-host";
    // サイト側の stacking context より前面に置き、固定ヘッダーとの交差部分だけを後で切り抜く。
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style><div class="frame" hidden><canvas class="image" hidden></canvas><div class="status busy">画像を翻訳しています…</div><div class="actions" hidden><button class="toggle">原文</button><button class="close">戻す</button></div></div>`;
    document.documentElement.append(host);
    const frame = root.querySelector(".frame");
    const canvas = root.querySelector("canvas");
    const status = root.querySelector(".status");
    const actions = root.querySelector(".actions");
    const toggle = root.querySelector(".toggle");
    let source = null;
    let translated = null;
    let showingTranslation = true;
    let timer = null;

    function update() {
      if (!source?.isConnected) {
        if (source && !source.isConnected) close();
        return;
      }
      const style = getComputedStyle(source);
      const rect = layout.contentRect(source, style);
      setRect(frame, rect);
      frame.style.borderRadius = style.borderRadius;
      const visible = layout.occlusionInsets(frame.getBoundingClientRect(), source, host);
      frame.style.clipPath = Object.values(visible).some(Boolean)
        ? `inset(${visible.top}px ${visible.right}px ${visible.bottom}px ${visible.left}px)` : "none";
      actions.style.top = `${visible.top + 7}px`;
      actions.style.right = `${visible.right + 7}px`;
      if (!translated) return;
      const imageRect = layout.fittedRect(rect.width, rect.height,
        source.naturalWidth || translated.width, source.naturalHeight || translated.height, style);
      setRect(canvas, imageRect);
    }

    function start(node) {
      source = node;
      translated = null;
      showingTranslation = true;
      frame.hidden = false;
      canvas.hidden = true;
      status.hidden = false;
      status.className = "status busy";
      status.textContent = "画像を翻訳しています…";
      actions.hidden = true;
      clearInterval(timer);
      window.addEventListener("scroll", update, true);
      window.addEventListener("resize", update);
      timer = setInterval(update, 180);
      update();
    }

    function show(rendered) {
      translated = { width: rendered.width, height: rendered.height };
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(rendered, 0, 0);
      showingTranslation = true;
      canvas.hidden = false;
      status.hidden = true;
      actions.hidden = false;
      toggle.hidden = false;
      toggle.textContent = "原文";
      update();
    }

    function message(text, error = false) {
      translated = null;
      canvas.hidden = true;
      status.hidden = false;
      status.className = `status${error ? " error" : ""}`;
      status.textContent = text;
      actions.hidden = false;
      toggle.hidden = true;
    }

    function close() {
      clearInterval(timer);
      timer = null;
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      source = null;
      translated = null;
      canvas.width = canvas.height = 1;
      frame.hidden = true;
    }

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      showingTranslation = !showingTranslation;
      canvas.hidden = !showingTranslation;
      toggle.textContent = showingTranslation ? "原文" : "訳文";
    });
    root.querySelector(".close").addEventListener("click", (event) => { event.stopPropagation(); onClose(); });
    return { start, show, message, close, isOpen: () => !frame.hidden };
  }

  globalThis.TFImageOverlay = { create: imageOverlay };
})();
