// README 用スクリーンショット: 実ページを実 API で翻訳して撮る（課金あり・数セント）
// usage: ANTHROPIC_API_KEY=... node tools/capture_readme.mjs [outDir]
//   → <outDir>/{before,replace,bilingual,selection,popup,options}.png（既定 docs/shots。WebP 化と比較画像は tools/make_readme_assets.py）
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { launch, EXT } from "../tests/harness.mjs";

const PAGE_URL = "https://camel.apache.org/components/4.22.x/as2-component.html";
const SCROLL_Y = Number(process.env.SHOT_SCROLL || 0);
const OUT = process.argv[2] || join(EXT, "docs", "shots");
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("ANTHROPIC_API_KEY が未設定"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const shot = (page, name, opts = {}) => page.screenshot({ path: join(OUT, `${name}.png`), ...opts }).then(() => log(`wrote ${name}.png`));

const h = await launch({ prefix: "tf-shots-", viewport: { width: 1280, height: 800 } });
await h.setSettings({
  schema: 2, apiKey, apiBase: "https://api.anthropic.com", model: "claude-sonnet-5-5", effort: "low", targetLang: "日本語",
  displayMode: "replace", customInstructions: "", glossary: "", batchChars: 2500, concurrency: 4,
  cacheEnabled: true, skipNav: true, autoHosts: [], usdJpy: 150,
  usage: { input: 0, output: 0, costUsd: 0, requests: 0 },
});

log(`open ${PAGE_URL}`);
const { page, tabId } = await h.open(PAGE_URL);
await page.evaluate((y) => window.scrollTo(0, y), SCROLL_Y);
await page.waitForTimeout(800);
await shot(page, "before");

log("translate (replace)");
let st = await h.msg(tabId, { type: "tf:translate", mode: "replace" });
log(`→ ${st.status} ${JSON.stringify(st.progress)} ${st.error || ""} $${st.usage.costUsd.toFixed(4)}`);
await page.waitForTimeout(300);
await shot(page, "replace");

// ポップアップ（翻訳済みの状態・このページのコスト入り）
{
  const p = await h.ctx.newPage();
  await p.setViewportSize({ width: 360, height: 600 });
  await p.goto(`chrome-extension://${h.extId}/popup/popup.html?tab=${tabId}`);
  await p.waitForFunction(() => document.getElementById("statusText").textContent.startsWith("翻訳済み"), null, { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(300);
  await shot(p, "popup");
  await p.close();
}

log("translate (bilingual, cache)");
st = await h.msg(tabId, { type: "tf:translate", mode: "bilingual" });
log(`→ ${st.status} ${JSON.stringify(st.progress)} ${st.error || ""}`);
await page.evaluate((y) => window.scrollTo(0, y), SCROLL_Y);
await page.waitForTimeout(4000); // 完了バッジが消えるまで待つ
await shot(page, "bilingual");

// 選択範囲の翻訳（原文に戻してから本文の段落を 1 つ選ぶ）
log("selection");
await h.msg(tabId, { type: "tf:restore" });
await page.evaluate((y) => window.scrollTo(0, y), SCROLL_Y);
const selected = await page.evaluate(() => {
  const paras = [...document.querySelectorAll("article p, main p, .doc p")].filter((p) => p.textContent.trim().length > 80);
  const p = paras[0];
  if (!p) return null;
  p.scrollIntoView({ block: "center" });
  const r = document.createRange(); r.selectNodeContents(p);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return p.textContent.trim().slice(0, 60);
});
log(`selected: ${selected}`);
await page.waitForFunction(() => { const hst = document.getElementById("tf-host"); return hst && !hst.shadowRoot.querySelector(".selbtn").hidden; }, null, { timeout: 3000 });
await page.waitForTimeout(200);
await shot(page, "selection-button");
await page.evaluate(() => document.getElementById("tf-host").shadowRoot.querySelector(".selbtn").click());
await page.waitForFunction(() => { const b = document.getElementById("tf-host").shadowRoot.querySelector(".panel .pb"); return b && !b.classList.contains("wait"); }, null, { timeout: 60000 });
await page.waitForTimeout(300);
await shot(page, "selection");

// 設定ページ
{
  const p = await h.ctx.newPage();
  await p.setViewportSize({ width: 1000, height: 1180 }); // fullPage は固定の保存バーが本文に重なるので使わない
  await p.goto(`chrome-extension://${h.extId}/options/options.html`);
  await p.waitForTimeout(800);
  await shot(p, "options");
  await p.close();
}

await h.close();
log("done");
