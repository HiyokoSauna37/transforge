// E2E: 拡張を Chromium に読み込み、モック API に対してページ翻訳 / 復元 / 対訳 / 選択翻訳を検証
// usage: npm test  （playwright-core と chromium が必要: npm i && npx playwright install chromium）
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, stats } from "./mock_server.mjs";
import { launch } from "./harness.mjs";

let failures = 0;
let step = "start";
const log = (s) => { step = s; console.log(`${new Date().toISOString().slice(11, 19)} ${s}`); };
setTimeout(() => { console.log(`\nWATCHDOG: timed out at step "${step}"`); process.exit(3); }, Number(process.env.E2E_TIMEOUT || 180000)).unref();
function check(cond, name, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
}

const { server, port } = await startServer();
const BASE = `http://127.0.0.1:${port}`;
log(`mock server ${BASE}`);

log("launching chromium");
const h = await launch({ headless: !process.env.E2E_HEADED, prefix: "tf-e2e-" });
const { ctx, sw, extId, clearCache, tabIdOf, waitContent, msg } = h;
log(`service worker: ${sw.url()}`);

const baseSettings = {
  schema: 2, apiKey: "test-key", apiBase: BASE, model: "claude-opus-5-5", effort: "low", targetLang: "日本語",
  displayMode: "replace", customInstructions: "", glossary: "", batchChars: 2500, concurrency: 4,
  cacheEnabled: true, skipNav: true, autoHosts: [], usdJpy: 150,
};
const setSettings = (partial) => h.setSettings({ ...baseSettings, ...partial });

// ---------------- synthetic fixture ----------------
log("[synthetic] replace mode");
await setSettings({});
await clearCache();
stats.requests.length = 0;
let page = await ctx.newPage();
await page.goto(`${BASE}/synthetic.html`);
let tabId = await tabIdOf(page);
await waitContent(tabId);
const snapshot = await page.evaluate(() => document.body.innerHTML);
let st = await msg(tabId, { type: "tf:translate", mode: "replace" });
check(st.status === "translated", "status translated", JSON.stringify(st));
check(!st.error, "no error", st.error || "");
check(st.progress.done === st.progress.total && st.progress.total > 0, `progress ${st.progress.done}/${st.progress.total}`);
check(await page.evaluate(() => document.documentElement.getAttribute("translate") === "no" && document.body.getAttribute("translate") === "no"), "page-wide translate=no preserved while translating (OWASP regression)");

const r1 = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const links = [...q("#reorder").querySelectorAll("a")];
  return {
    h1: q("#h1").textContent,
    h1em: q("#h1 em") && q("#h1 em").textContent,
    reorderText: q("#reorder").textContent,
    reorderFirstLink: links[0] && links[0].id,
    reorderHrefs: links.map((a) => a.getAttribute("href")),
    nestedCode: q("#nested code") && q("#nested code").textContent,
    nestedCodeInsideA: !!q("#nested a code"),
    nestedStrong: q("#nested strong") && q("#nested strong").textContent,
    brCount: q("#br").querySelectorAll("br").length,
    brText: q("#br").textContent,
    codeOnly: q("#code-only").textContent,
    notrans: q("#notrans").textContent,
    notrans2: q("#notrans2").textContent,
    hidden: q("#hidden").textContent,
    hiddenContents: q("#hidden-contents").textContent,
    contentsHeading: q("#contents-heading").textContent,
    contentsBody: q("#contents-body").textContent,
    pre: q("#pre").textContent,
    listNested: q("#list ul li").textContent,
    tdType: [...document.querySelectorAll("#table td")].map((td) => td.textContent),
    detailsP: q("#details-p").textContent,
    nav: q("#nav").textContent,
    jp: q("#jp").textContent,
    sym: q("#sym").textContent,
    num: q("#num").textContent,
    btn: q("#btn").textContent,
    mixed: q("#mixed").textContent,
    shadow: q("#shadow-host").shadowRoot.querySelector("p").textContent,
    markersLeft: /<\/?i\d+\/?>/.test(document.body.innerText),
  };
});
check(r1.h1.includes("【Component】") && r1.h1em === "【Options】", "h1 translated incl. <em>", r1.h1);
check(r1.reorderFirstLink === "l2", "reordered markers: originally-second link now first", r1.reorderText);
check(JSON.stringify(r1.reorderHrefs) === JSON.stringify(["/details", "/docs"]), "reordered links keep hrefs", JSON.stringify(r1.reorderHrefs));
check(r1.nestedCode === "as2From" && r1.nestedCodeInsideA, "inline <code> inside <a> kept verbatim", r1.nestedCode);
check(r1.nestedStrong === "【sender】", "<strong> translated", r1.nestedStrong);
check(r1.brCount === 1 && r1.brText.includes("【First line】") && r1.brText.includes("【Second line】"), "<br> preserved", r1.brText);
check(r1.codeOnly === "only code", "code-only paragraph untouched", r1.codeOnly);
check(r1.notrans === "Do not translate me" && r1.notrans2 === "Nor me", "translate=no / .notranslate untouched");
check(r1.hidden === "Hidden paragraph should stay", "display:none untouched");
check(r1.hiddenContents === "Hidden contents should stay", "display:contents inside display:none untouched");
check(r1.contentsHeading === "【Visible article heading】" && r1.contentsBody === "【Visible article paragraph should translate.】", "display:contents article children translated");
check(r1.pre.startsWith("<dependency>"), "<pre> untouched");
check(r1.listNested === "【Nested item】", "nested list item translated", r1.listNested);
check(r1.tdType[1] === "【String】" && r1.tdType[0].includes("bridgeErrorHandler"), "table cells translated", JSON.stringify(r1.tdType));
check(r1.detailsP === "Collapsed content", "closed <details> content untouched initially", r1.detailsP);
check(r1.nav === "Nav link one Nav link two", "nav skipped (skipNav)", r1.nav);
check(r1.jp === "これは既に日本語の文です。", "already-Japanese paragraph skipped");
check(r1.sym === "— • —" && r1.num === "12345", "symbol / number only paragraphs skipped");
check(r1.btn === "【Click me】", "button label translated", r1.btn);
check(r1.mixed.includes("【Leading text】") && r1.mixed.includes("【Inner block paragraph】") && r1.mixed.includes("【trailing text】"), "mixed content runs translated", r1.mixed);
check(r1.shadow === "【Shadow paragraph】", "open shadow DOM translated", r1.shadow);
check(!r1.markersLeft, "no literal markers left in text");

// details を開く → MutationObserver で追加翻訳
await page.evaluate(() => { document.getElementById("details").open = true; });
await page.waitForFunction(() => document.getElementById("details-p").textContent.includes("【"), null, { timeout: 5000 }).catch(() => {});
const detailsAfter = await page.evaluate(() => document.getElementById("details-p").textContent);
check(detailsAfter === "【Collapsed content】", "opened <details> translated incrementally", detailsAfter);

// 動的追加
await page.evaluate(() => { const p = document.createElement("p"); p.id = "dyn"; p.textContent = "Dynamically added"; document.body.appendChild(p); });
await page.waitForFunction(() => document.getElementById("dyn").textContent.includes("【"), null, { timeout: 5000 }).catch(() => {});
check((await page.evaluate(() => document.getElementById("dyn").textContent)) === "【Dynamically added】", "dynamically added paragraph translated");

await page.evaluate(() => { const p = document.createElement("p"); p.id = "dyn-contents"; p.textContent = "Dynamically added article text"; document.getElementById("display-contents").appendChild(p); });
await page.waitForFunction(() => document.getElementById("dyn-contents").textContent.includes("【"), null, { timeout: 5000 }).catch(() => {});
check((await page.evaluate(() => document.getElementById("dyn-contents").textContent)) === "【Dynamically added article text】", "dynamically added text inside display:contents translated");

// 復元（details/dyn 追加後なので body 全体一致は不可 → 主要要素で確認）
st = await msg(tabId, { type: "tf:restore" });
check(st.status === "idle", "restore → idle");
const r2 = await page.evaluate(() => ({
  reorder: document.querySelector("#reorder").innerHTML,
  h1: document.querySelector("#h1").innerHTML,
  nested: document.querySelector("#nested").innerHTML,
  mixed: document.querySelector("#mixed").innerHTML,
  contentsBody: document.querySelector("#contents-body").textContent,
  dynContents: document.querySelector("#dyn-contents").textContent,
  trans: document.querySelectorAll("[data-tf]").length,
}));
check(r2.reorder === 'See <a href="/docs" id="l1">the documentation</a> for <a href="/details" id="l2">details</a>.', "restore: reordered paragraph back to original", r2.reorder);
check(r2.h1 === "Component <em>Options</em>", "restore: h1 original", r2.h1);
check(r2.contentsBody === "Visible article paragraph should translate." && r2.dynContents === "Dynamically added article text", "restore: display:contents article text original");
check(r2.nested === 'Set the <a href="/opt"><code>as2From</code> header</a> to the <strong>sender</strong> value.', "restore: nested original", r2.nested);
check(r2.trans === 1, "restore: only the UI host remains tagged", String(r2.trans));

// ヘッダ・ボディ検証
const req0 = stats.requests[0];
check(req0.headers["anthropic-version"] === "2026-10-21", "header anthropic-version 2026-10-21");
check(req0.headers["anthropic-dangerous-direct-browser-access"] === "true", "header dangerous-direct-browser-access");
check(req0.headers["x-api-key"] === "test-key", "header x-api-key");
check(req0.body.fallbacks === "default" && req0.headers["anthropic-beta"] === "server-side-fallback-2026-07-01", "opus: fallbacks default + beta header");
check(req0.body.output_config && req0.body.output_config.effort === "low", "effort low");
check(req0.body.thinking === undefined && req0.body.temperature === undefined, "no thinking / temperature fields");
check(Array.isArray(req0.body.system) && req0.body.system[0].cache_control, "system prompt with cache_control");
check(/WORD ORDER ACROSS MARKERS/.test(req0.body.system[0].text), "prompt contains word-order guidance");

// ---------------- bilingual mode ----------------
log("[synthetic] bilingual mode (cache hit)");
const nReq = stats.requests.length;
st = await msg(tabId, { type: "tf:translate", mode: "bilingual" });
check(st.status === "translated" && st.mode === "bilingual", "bilingual translated");
const r3 = await page.evaluate(() => ({
  trans: document.querySelectorAll(".tf-trans").length,
  reorder: document.querySelector("#reorder").textContent,
  origLinks: document.querySelectorAll("#reorder > a").length,
  dupIds: document.querySelectorAll("#l1").length,
  h1: document.querySelector("#h1").textContent,
}));
check(r3.trans > 5, `bilingual inserts (${r3.trans})`);
check(r3.reorder.startsWith("See the documentation for details.") && r3.reorder.includes("【"), "bilingual keeps original + adds translation", r3.reorder);
check(r3.dupIds === 1, "bilingual clones strip ids");
check(stats.requests.length === nReq, "second translation fully served from cache (no API calls)");
st = await msg(tabId, { type: "tf:restore" });
const r4 = await page.evaluate(() => document.querySelectorAll(".tf-trans").length);
check(r4 === 0, "bilingual restore removes inserts");
await page.close();

// ---------------- haiku: no fallbacks; 401 handling; 529 retry ----------------
log("[synthetic] haiku / errors");
await setSettings({ model: "claude-haiku-5-5", cacheEnabled: false });
page = await ctx.newPage();
await page.goto(`${BASE}/synthetic.html`);
tabId = await tabIdOf(page);
await waitContent(tabId);
stats.requests.length = 0;
st = await msg(tabId, { type: "tf:translate" });
check(st.status === "translated" && stats.requests.length > 0 && stats.requests.every((r) => r.body.fallbacks === undefined && !r.headers["anthropic-beta"]), "haiku: no fallbacks param / beta header");
await msg(tabId, { type: "tf:restore" });

await setSettings({ model: "claude-haiku-5-5", cacheEnabled: false, apiKey: "bad" });
st = await msg(tabId, { type: "tf:translate" });
check(st.status === "idle" && /APIキーが無効/.test(st.error || ""), "401 → fatal error, page stays idle", JSON.stringify(st.error));

await setSettings({ model: "claude-haiku-5-5", cacheEnabled: false, concurrency: 1 });
stats.errorsRemaining = 1;
stats.requests.length = 0;
st = await msg(tabId, { type: "tf:translate" });
check(st.status === "translated" && !st.error && stats.requests.length >= 2, "529 once → retried and succeeded", `${stats.requests.length} requests, err=${st.error}`);
await msg(tabId, { type: "tf:restore" });

// ---------------- selection translation ----------------
log("[synthetic] selection");
await setSettings({ model: "claude-opus-5-5" });
await page.evaluate(() => {
  const p = document.getElementById("reorder");
  const r = document.createRange(); r.selectNodeContents(p);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
});
await page.mouse.move(50, 50);
await page.mouse.down(); await page.mouse.up();
await page.evaluate(() => {
  const p = document.getElementById("reorder");
  const r = document.createRange(); r.selectNodeContents(p);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await page.waitForFunction(() => { const h = document.getElementById("tf-host"); return h && !h.shadowRoot.querySelector(".selbtn").hidden; }, null, { timeout: 3000 }).catch(() => {});
const selBtnVisible = await page.evaluate(() => { const h = document.getElementById("tf-host"); return h && !h.shadowRoot.querySelector(".selbtn").hidden; });
check(selBtnVisible, "selection button appears");
await page.evaluate(() => document.getElementById("tf-host").shadowRoot.querySelector(".selbtn").click());
await page.waitForFunction(() => { const h = document.getElementById("tf-host"); const pb = h.shadowRoot.querySelector(".panel .pb"); return pb && pb.textContent.includes("【"); }, null, { timeout: 5000 }).catch(() => {});
const panelText = await page.evaluate(() => document.getElementById("tf-host").shadowRoot.querySelector(".panel .pb").textContent);
check(panelText.includes("【See the documentation for details.】"), "selection panel shows translation", panelText);
await page.screenshot({ path: join(process.env.E2E_SHOTS || tmpdir(), "tf-selection.png"), clip: { x: 0, y: 0, width: 640, height: 420 } });
await page.close();

// ---------------- Camel AS2 page (real-world fixture) ----------------
log("[as2] real page fixture");
await setSettings({ model: "claude-opus-5-5", cacheEnabled: true });
await clearCache();
stats.requests.length = 0;
page = await ctx.newPage();
await page.goto(`${BASE}/as2.html`);
tabId = await tabIdOf(page);
await waitContent(tabId);
const before = await page.evaluate(() => ({
  html: document.body.innerHTML,
  codes: [...document.querySelectorAll("article code")].map((c) => c.textContent),
  hrefs: [...document.querySelectorAll("article a[href]")].map((a) => a.getAttribute("href")).sort(),
  pres: [...document.querySelectorAll("pre")].map((p) => p.textContent),
}));
const t0 = Date.now();
st = await msg(tabId, { type: "tf:translate", mode: "replace" });
const dt = Date.now() - t0;
check(st.status === "translated" && !st.error, `as2 translated in ${dt}ms (${st.progress.total} units, ${stats.requests.length} requests)`, st.error || "");
const after = await page.evaluate(() => ({
  codes: [...document.querySelectorAll("article code")].map((c) => c.textContent),
  hrefs: [...document.querySelectorAll("article a[href]")].map((a) => a.getAttribute("href")).sort(),
  pres: [...document.querySelectorAll("pre")].map((p) => p.textContent),
  sample: document.querySelector("#_component_options") && document.querySelector("#_component_options").textContent,
  desc: document.querySelector("#_component_option_bridgeErrorHandler") && document.querySelector("#_component_option_bridgeErrorHandler").closest("tr").textContent,
  markersLeft: /<\/?i\d+\/?>/.test(document.body.innerText),
  loose: document.querySelectorAll("[data-tf-loose]").length,
}));
// モックはマーカー順を反転するので <code> の出現順は変わりうる → 多重集合として比較
check(JSON.stringify(before.codes.slice().sort()) === JSON.stringify(after.codes.slice().sort()), "as2: all <code> texts unchanged", `${before.codes.length} vs ${after.codes.length}`);
check(JSON.stringify(before.hrefs) === JSON.stringify(after.hrefs), "as2: all article hrefs unchanged", `${before.hrefs.length} vs ${after.hrefs.length}`);
check(JSON.stringify(before.pres) === JSON.stringify(after.pres), "as2: <pre> blocks unchanged");
check(after.sample && after.sample.includes("【Component Options】"), "as2: heading translated", after.sample);
check(after.desc && after.desc.includes("bridgeErrorHandler") && after.desc.includes("【"), "as2: option row translated", (after.desc || "").slice(0, 120));
check(!after.markersLeft, "as2: no literal markers");
check(after.loose === 0, "as2: no loose fallbacks needed", String(after.loose));
const maxSeg = Math.max(...stats.requests.map((r) => (r.body.messages[0].content.match(/<seg /g) || []).length));
const maxLen = Math.max(...stats.requests.map((r) => r.body.messages[0].content.length));
check(maxSeg <= 80 && maxLen < 2500 + 3000, `as2: batch limits respected (max ${maxSeg} segs, ${maxLen} chars)`);
st = await msg(tabId, { type: "tf:restore" });
const htmlAfter = await page.evaluate(() => document.body.innerHTML);
check(htmlAfter === before.html, "as2: restore reproduces exact original body innerHTML", `${htmlAfter.length} vs ${before.html.length}`);
await page.close();

// ---------------- extension pages (popup / options) ----------------
log("[ui] extension pages");
const shotDir = process.env.E2E_SHOTS || tmpdir();
const watchErrors = (p) => {
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text()); });
  return errors;
};
{
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1000, height: 1400 });
  const errors = watchErrors(p);
  await p.goto(`chrome-extension://${extId}/options/options.html`);
  await p.waitForTimeout(800);
  await p.screenshot({ path: join(shotDir, "tf-options.png"), fullPage: true });
  check(errors.length === 0, "options page loads without errors", errors.join(" | "));
  const filled = await p.evaluate(() => ({ model: document.getElementById("model").value, lang: document.getElementById("targetLang").value, usage: document.getElementById("usage").textContent }));
  check(filled.model === "claude-opus-5-5" && filled.lang === "日本語" && /requests/.test(filled.usage), "options page reflects stored settings", JSON.stringify(filled));
  await p.close();
}
{
  // popup: 対象タブを ?tab= で固定して、未翻訳 → 翻訳 → 翻訳済みの表示を確認
  const target = await ctx.newPage();
  await target.goto(`${BASE}/synthetic.html`);
  const targetId = await tabIdOf(target);
  await waitContent(targetId);
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 360, height: 560 });
  const errors = watchErrors(p);
  await p.goto(`chrome-extension://${extId}/popup/popup.html?tab=${targetId}`);
  await p.waitForTimeout(800);
  await p.screenshot({ path: join(shotDir, "tf-popup-idle.png") });
  const idle = await p.evaluate(() => ({ main: !document.getElementById("main").hidden, status: document.getElementById("statusText").textContent, tr: !document.getElementById("translate").hidden, label: document.getElementById("autoHostLabel").textContent }));
  check(idle.main && idle.status === "未翻訳" && idle.tr && /127\.0\.0\.1/.test(idle.label), "popup idle state", JSON.stringify(idle));
  await p.click("#translate");
  await p.waitForFunction(() => document.getElementById("statusText").textContent.startsWith("翻訳済み"), null, { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(shotDir, "tf-popup-translated.png") });
  const tr = await p.evaluate(() => ({ status: document.getElementById("statusText").textContent, restore: !document.getElementById("restore").hidden, cost: document.getElementById("pageCost").textContent }));
  check(tr.status === "翻訳済み（置換）" && tr.restore && /tok/.test(tr.cost), "popup translated state with cost", JSON.stringify(tr));
  check((await target.evaluate(() => document.getElementById("h1").textContent)).includes("【"), "popup translate button translated the target tab");
  await p.click("#restore");
  await p.waitForTimeout(300);
  check((await p.evaluate(() => document.getElementById("statusText").textContent)) === "未翻訳", "popup restore button");
  check(errors.length === 0, "popup page loads without errors", errors.join(" | "));
  await p.close();
  await target.close();
}

// ---------------- settings migration (schema 1 → 3: ページ既定と字幕既定) ----------------
log("[settings] migration");
{
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup/popup.html`);
  const ask = async (seed) => {
    await sw.evaluate(async (s) => { await chrome.storage.local.set({ settings: s }); }, seed);
    return (await p.evaluate(() => chrome.runtime.sendMessage({ type: "getSettings" }))).settings;
  };
  const a = await ask({ apiKey: "k", model: "claude-opus-5-5" });
  check(a.model === "claude-sonnet-5-5" && a.schema === 3, "migration: old default Opus → Sonnet", JSON.stringify(a));
  const b = await ask({ apiKey: "k", model: "claude-haiku-5-5" });
  check(b.model === "claude-haiku-5-5" && b.schema === 3, "migration: explicit Haiku kept", JSON.stringify(b));
  const c = await ask({ schema: 2, apiKey: "k", model: "claude-opus-5-5" });
  check(c.model === "claude-opus-5-5", "migration: schema 2 Opus untouched", JSON.stringify(c));
  const d = await ask({});
  check(d.model === "claude-sonnet-5-5" && d.schema === 3 && d.subtitleTargetLang === "日本語" && d.subtitleModel === "claude-haiku-5-5", "defaults: page Sonnet, subtitles Japanese/Haiku", JSON.stringify(d));
  await p.close();
}

await h.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
