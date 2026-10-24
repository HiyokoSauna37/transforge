// popup / options 共通の小さな DOM ヘルパー（ES module）
export const $ = (id) => document.getElementById(id);
export const bg = (msg) => chrome.runtime.sendMessage(msg);

// <select> に候補を入れる。items は文字列か {id} の配列。保存値が候補にないときはそのまま 1 項目足す
export function fillSelect(sel, items, value, labelOf = (it) => (typeof it === "string" ? it : it.id)) {
  sel.innerHTML = "";
  let seen = false;
  for (const it of items) {
    const o = document.createElement("option");
    o.value = typeof it === "string" ? it : it.id;
    o.textContent = labelOf(it);
    if (o.value === value) { o.selected = true; seen = true; }
    sel.appendChild(o);
  }
  if (!seen && value) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = value;
    o.selected = true;
    sel.appendChild(o);
  }
}

// data-mode 付きボタン群のセグメントコントロール
export function segmented(root, onChange) {
  const buttons = [...root.querySelectorAll(".segbtn")];
  const set = (mode) => { for (const b of buttons) b.classList.toggle("on", b.dataset.mode === mode); };
  const get = () => (buttons.find((b) => b.classList.contains("on")) || buttons[0]).dataset.mode;
  for (const b of buttons) b.addEventListener("click", () => onChange(b.dataset.mode));
  return { get, set };
}
