// README 用の再現可能なデモ撮影。実際の拡張 UI を使用し、用意した訳文をローカル API から返す。
// 外部 API / API キー / 課金は不要。usage: node tools/capture_demo.mjs [outDir]
import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, EXT } from "../tests/harness.mjs";

const out = process.argv[2] || join(EXT, "docs", "shots");
mkdirSync(out, { recursive: true });
const translations = new Map();
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/messages") { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try {
      const json = JSON.parse(body);
      let explanation = null;
      try {
        const input = JSON.parse(json.messages[0].content);
        if (input.selected_passage === "context") explanation = input;
      } catch { /* 通常の翻訳リクエスト */ }
      const segments = [...json.messages[0].content.matchAll(/<seg id="(\d+)">([\s\S]*?)<\/seg>/g)];
      const translated = segments.map(([, id, source]) => {
        if (!translations.has(source)) throw new Error(`Missing demo translation: ${source}`);
        return `<seg id="${id}">${translations.get(source)}</seg>`;
      }).join("\n");
      const text = explanation
        ? "ひとことで\nここでの context は、言葉の意味を判断するための周囲の情報です。\n\nこのページでは\n前後の文章に加えて、ページ内の用語の定義やリンク先も手がかりにしています。[1]\n\n具体例\n同じ単語でも、周囲の説明によって自然な訳し方が変わります。"
        : translated;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_readme_demo", type: "message", role: "assistant", model: json.model,
        content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }));
    } catch (error) {
      console.error(error.message);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let h;
try {
  h = await launch({ prefix: "yomeru-readme-", viewport: { width: 1280, height: 900 } });
  await h.setSettings({ schema: 2, apiKey: "readme-demo-not-a-real-key", apiBase: `http://127.0.0.1:${server.address().port}`,
    model: "claude-sonnet-5-5", effort: "low", targetLang: "日本語", displayMode: "replace", customInstructions: "", glossary: "",
    batchChars: 2500, concurrency: 4, cacheEnabled: true, skipNav: true, autoHosts: [], usdJpy: 150,
    usage: { input: 0, output: 0, costUsd: 0, requests: 0 } });
  await h.ctx.route("https://reading.example/guide", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: readFileSync(join(EXT, "tools/fixtures/reading.html"), "utf8") }));
  const { page, tabId } = await h.open("https://reading.example/guide");
  await page.emulateMedia({ colorScheme: "light" });
  await page.addScriptTag({ path: join(EXT, "content/segmenter.js") });
  const entries = await page.evaluate(() => TFSeg.collectUnits(document.body, { targetLang: "日本語", skipNav: true }).map((u) => {
    const owner = u.nodes[0].parentElement.closest("[data-ja]");
    if (!owner) throw new Error(`Missing data-ja: ${u.text}`);
    return [u.text, owner.getAttribute("data-ja")];
  }));
  for (const [source, target] of entries) translations.set(source, target);
  const selectedSource = await page.locator("#selection-demo").textContent();
  translations.set(selectedSource.trim(), await page.locator("#selection-demo").getAttribute("data-ja"));
  const shot = async (p, name, opts = {}) => {
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: join(out, `${name}.png`), ...opts });
    console.log(`wrote ${name}.png`);
  };
  await shot(page, "before");
  const translate = async (mode) => {
    const state = await h.msg(tabId, { type: "tf:translate", mode });
    if (state.error || state.status !== "translated") throw new Error(JSON.stringify(state));
  };
  await translate("replace");
  await shot(page, "replace");
  const popup = await h.ctx.newPage();
  await popup.emulateMedia({ colorScheme: "light" });
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${h.extId}/popup/popup.html?tab=${tabId}`);
  await popup.waitForSelector("#main:not([hidden])");
  await shot(popup, "popup", { fullPage: true });
  await popup.close();
  await h.msg(tabId, { type: "tf:restore" });
  await translate("bilingual");
  await shot(page, "bilingual");
  await h.msg(tabId, { type: "tf:restore" });
  await page.evaluate(() => {
    const p = document.querySelector("#selection-demo");
    const range = document.createRange(); range.selectNodeContents(p);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForFunction(() => { const host = document.getElementById("tf-host"); return host && !host.shadowRoot.querySelector(".selbtn").hidden; });
  await page.evaluate(() => document.getElementById("tf-host").shadowRoot.querySelector(".selbtn").click());
  await page.waitForFunction(() => { const b = document.getElementById("tf-host").shadowRoot.querySelector(".panel .pb"); return b && !b.classList.contains("wait"); });
  const panelText = await page.evaluate(() => document.getElementById("tf-host").shadowRoot.querySelector(".panel .pb").textContent);
  if (!panelText.startsWith("よい翻訳")) throw new Error(`Selection demo failed: ${panelText}`);
  await shot(page, "selection");
  await page.evaluate(() => {
    const p = document.querySelector("#selection-demo");
    const node = p.firstChild;
    const start = node.data.indexOf("context");
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + "context".length);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForFunction(() => { const host = document.getElementById("tf-host"); return host && !host.shadowRoot.querySelector(".explainbtn").hidden; });
  await page.evaluate(() => document.getElementById("tf-host").shadowRoot.querySelector(".explainbtn").click());
  await page.waitForFunction(() => { const p = document.getElementById("tf-host").shadowRoot.querySelector(".panel .pb"); return p && p.textContent.includes("ここでの context"); });
  const sources = await page.evaluate(() => document.getElementById("tf-host").shadowRoot.querySelector(".sources").textContent);
  if (!sources.includes("definitions elsewhere on the page")) throw new Error(`Explanation demo missing page evidence: ${sources}`);
  const firstEvidence = await page.evaluate(() => document.getElementById("tf-host").shadowRoot.querySelector(".sources p:nth-child(2)")?.textContent || "");
  if (!firstEvidence.includes("surrounding information")) throw new Error(`Explanation demo citation [1] is not supported: ${firstEvidence}`);
  await shot(page, "explanation");
  // 設定画面は通常の接続先を表示。API へは送信せず、デモ用キーのみを使う。
  await h.sw.evaluate(async () => { const { settings } = await chrome.storage.local.get("settings"); await chrome.storage.local.set({ settings: { ...settings, apiBase: "https://api.anthropic.com" } }); });
  const options = await h.ctx.newPage();
  await options.emulateMedia({ colorScheme: "light" });
  await options.setViewportSize({ width: 1280, height: 1000 });
  await options.goto(`chrome-extension://${h.extId}/options/options.html`);
  await options.waitForFunction(() => document.getElementById("model").options.length > 0);
  await shot(options, "options");
} finally {
  if (h) await h.close();
  server.close();
}
