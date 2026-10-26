// 広告本文のAPI除外と、ページ翻訳中だけの広告非表示/復元を実ブラウザで検証。
import assert from "node:assert/strict";
import { join } from "node:path";
import { startServer, stats } from "./mock_server.mjs";
import { launch, EXT } from "./harness.mjs";

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Lease documentation</title>
<style>body{font:16px/1.5 system-ui;padding:20px}p{margin:8px}ins{display:inline}ytd-display-ad-renderer{display:block}</style></head><body>
<header id="header"><p>HEADER: a lease is used in request headers.</p></header>
<main><h1>Lease ownership</h1><p id="meaning">A <span id="term">lease</span> is a time-limited ownership token.</p>
<p id="inline">Read about <span>lease renewal <ins id="inline-ad" class="adsbygoogle">AD_SENTINEL_INLINE lease discount</ins> before expiration.</span></p>
<div id="div-gpt-ad-sidebar" style="display:flex!important;color:red"><p>AD_SENTINEL_GPT lease promotion</p></div>
<div id="slot" data-ad-slot="slot-1"><p>AD_SENTINEL_SLOT lease offer</p></div>
<span id="client" data-ad-client="publisher"><span>AD_SENTINEL_CLIENT lease offer</span></span>
<div id="query" data-google-query-id="query"><p>AD_SENTINEL_QUERY lease discount</p></div>
<section id="labeled-ad" aria-label="Advertisement"><p>AD_SENTINEL_LABEL lease deal</p></section>
<section id="ja-ad" aria-label="広告"><p>AD_SENTINEL_JA lease deal</p></section>
<ytd-display-ad-renderer id="youtube-ad"><p>AD_SENTINEL_YOUTUBE lease promotion</p></ytd-display-ad-renderer>
<article class="sponsored" id="sponsor"><p>SPONSOR: this sponsored article explains lease ownership.</p></article>
<address id="address">ADDRESS: lease recovery contact information.</address>
<p id="ad-words">AD_WORDS: the article discusses advertising, ads and 広告 without being an ad.</p>
<p id="label-analysis" aria-label="Advertisement analysis">ANALYSIS: analysis of advertising terminology and lease systems.</p>
<pre id="code">function ad(address, header) { return address; } // lease</pre>
<div id="later-marker"><p>LATER_MARKER: this content is initially ordinary.</p></div>
<div id="shadow-host"></div>
</main><script>
document.getElementById("shadow-host").attachShadow({mode:"open"}).innerHTML = '<p id="shadow-content">SHADOW_BODY: lease definitions.</p><div id="shadow-ad" data-ad-slot="shadow"><p>AD_SENTINEL_SHADOW lease promotion</p></div>';
window.originalAd = document.getElementById("div-gpt-ad-sidebar");
</script></body></html>`;
const { server, port } = await startServer();
let requestDelay = 0;
const serve = server.listeners("request")[0];
server.removeListener("request", serve);
server.on("request", (req, res) => {
  const forward = () => { if (!res.destroyed) serve(req, res); };
  if (requestDelay && req.method === "POST") setTimeout(forward, requestDelay);
  else forward();
});
const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (text) => console.log(`✓ ${text}`);
let h;
try {
  h = await launch({ prefix: "yomeru-ads-", viewport: { width: 1100, height: 1000 } });
  await h.ctx.route(`${base}/ads.html`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await h.ctx.route(`${base}/ads-only.html`, (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="only-ad" aria-label="Advertisement">AD_SENTINEL_ONLY</div>' }));
  await h.setSettings({ schema: 2, apiKey: "test-key", apiBase: base, model: "claude-sonnet-5-5", effort: "low", targetLang: "日本語",
    displayMode: "replace", cacheEnabled: false, skipNav: false, autoHosts: [], batchChars: 6000, concurrency: 1 });
  const { page, tabId } = await h.open(`${base}/ads.html`);
  // MAIN worldにも純粋DOM関数を読み込み、広告がまだ見えている時点の抽出を確認する。
  for (const name of ["exclusions", "segmenter", "context"]) await page.addScriptTag({ path: join(EXT, `content/${name}.js`) });
  const extracted = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.getElementById("term"));
    const context = TFContext.collect("lease", range);
    return {
      translated: TFSeg.collectUnits(document.body, { skipNav: false, targetLang: "日本語" }).map((unit) => unit.text).join("\n"),
      context: JSON.stringify(context),
      whole: TFContext.textOf(document.body, 10000),
      inline: TFContext.textOf(document.getElementById("inline")),
      shadow: TFContext.textOf(document.getElementById("shadow-host").shadowRoot.getElementById("shadow-ad")),
      falsePositives: ["header", "address", "sponsor", "ad-words", "label-analysis", "code"].map((id) => TFExclusions.isWithinAd(document.getElementById(id))),
    };
  });
  assert.doesNotMatch(extracted.translated, /AD_SENTINEL/);
  assert.doesNotMatch(extracted.context, /AD_SENTINEL/);
  assert.doesNotMatch(extracted.whole, /AD_SENTINEL/);
  assert.equal(extracted.shadow, "");
  assert.match(extracted.inline, /lease renewal.*before expiration/);
  for (const term of ["HEADER", "ADDRESS", "SPONSOR", "AD_WORDS", "ANALYSIS", "SHADOW_BODY"]) assert.match(extracted.translated, new RegExp(term));
  assert.deepEqual(extracted.falsePositives, Array(6).fill(false));
  assert.equal(await page.locator("#div-gpt-ad-sidebar").isVisible(), true);
  check("visible ads are excluded from translation and explanation evidence, including nested inline and shadow content; ordinary ad-related articles and code are retained");

  // ユーザーが広告そのものを明示的に選んだ翻訳操作は妨げない。
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector("#div-gpt-ad-sidebar p"));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.locator("#tf-host .selbtn").waitFor({ state: "visible" });
  await h.msg(tabId, { type: "tf:translateSelection" });
  await page.waitForFunction(() => {
    const body = document.getElementById("tf-host")?.shadowRoot?.querySelector(".pb");
    return body && !body.classList.contains("wait") && body.textContent.includes("AD_SENTINEL_GPT");
  }, null, { timeout: 10000 }).catch(async (error) => {
    const detail = await page.evaluate(() => ({ selection: getSelection().toString(), panel: document.getElementById("tf-host")?.shadowRoot?.querySelector(".panel")?.textContent }));
    throw new Error(`${error.message}; requests=${stats.requests.length}; ${JSON.stringify(detail)}`);
  });
  assert.match(stats.requests.at(-1).body.messages[0].content, /AD_SENTINEL_GPT/);
  await page.locator("#tf-host .x").click();
  await page.evaluate(() => getSelection().removeAllRanges());
  stats.requests.length = 0;
  check("explicitly selecting an advertisement still permits the user's requested selection translation");

  const status = await h.msg(tabId, { type: "tf:translate", mode: "replace" });
  assert.equal(status.status, "translated", status.error);
  assert.ok(stats.requests.length > 0);
  assert.doesNotMatch(JSON.stringify(stats.requests.map((r) => r.body)), /AD_SENTINEL/);
  const adIds = ["div-gpt-ad-sidebar", "slot", "client", "query", "labeled-ad", "ja-ad", "youtube-ad", "inline-ad"];
  for (const id of adIds) {
    assert.equal(await page.locator(`#${id}`).count(), 1);
    assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} hidden`);
  }
  assert.equal(await page.locator("#shadow-host #shadow-ad").isVisible(), false);
  assert.equal(await page.evaluate(() => window.originalAd.isConnected), true);
  assert.match(await page.locator("#meaning").textContent(), /【/);
  for (const id of ["header", "address", "sponsor", "ad-words", "label-analysis"]) assert.equal(await page.locator(`#${id}`).isVisible(), true);
  assert.equal(await page.locator("#code").textContent(), "function ad(address, header) { return address; } // lease");
  check("page translation hides explicit ad containers without deleting them, sends no ad copy to the API and leaves legitimate content visible");

  // ページ側の無関係なstyle更新を復元時に失わないことを確認する。
  await page.locator("#div-gpt-ad-sidebar").evaluate((el) => { el.style.color = "blue"; el.style.display = "block"; });
  await page.waitForFunction(() => {
    const el = document.getElementById("div-gpt-ad-sidebar");
    return el.style.getPropertyValue("display") === "none" && el.style.getPropertyPriority("display") === "important";
  });
  const beforeAds = stats.requests.length;
  await page.evaluate(() => {
    const ad = document.createElement("div"); ad.id = "dynamic-ad"; ad.dataset.adSlot = "dynamic"; ad.textContent = "AD_SENTINEL_DYNAMIC lease deal"; document.querySelector("main").append(ad);
    document.getElementById("later-marker").dataset.adSlot = "new-marker";
    const shadowAd = document.createElement("div"); shadowAd.id = "dynamic-shadow-ad"; shadowAd.setAttribute("aria-label", "広告"); shadowAd.textContent = "AD_SENTINEL_DYNAMIC_SHADOW";
    document.getElementById("shadow-host").shadowRoot.append(shadowAd);
    const host = document.createElement("div"); host.id = "new-shadow-host"; host.attachShadow({ mode: "open" }); document.querySelector("main").append(host);
  });
  await page.waitForFunction(() => {
    return [document.getElementById("dynamic-ad"), document.getElementById("later-marker"), document.getElementById("shadow-host").shadowRoot.getElementById("dynamic-shadow-ad")]
      .every((el) => el.style.getPropertyValue("display") === "none");
  });
  await page.evaluate(() => {
    const ad = document.createElement("span"); ad.id = "new-host-ad"; ad.className = "adsbygoogle"; ad.textContent = "AD_SENTINEL_NEW_HOST";
    document.getElementById("new-shadow-host").shadowRoot.append(ad);
  });
  await page.waitForFunction(() => document.getElementById("new-shadow-host").shadowRoot.getElementById("new-host-ad").style.display === "none");
  await wait(600);
  assert.equal(stats.requests.length, beforeAds);
  await page.evaluate(() => { const p = document.createElement("p"); p.id = "dynamic-body"; p.textContent = "DYNAMIC_BODY: a new lease explanation."; document.querySelector("main").append(p); });
  await page.waitForFunction(() => document.getElementById("dynamic-body").textContent.includes("【"));
  assert.doesNotMatch(JSON.stringify(stats.requests.map((r) => r.body)), /AD_SENTINEL/);
  check("later ad elements, newly marked ads and ads in existing/new shadow roots stay hidden without API calls; ordinary dynamic text still translates");

  await h.msg(tabId, { type: "tf:restore" });
  const restored = await page.locator("#div-gpt-ad-sidebar").evaluate((el) => ({ display: el.style.getPropertyValue("display"), priority: el.style.getPropertyPriority("display"), color: el.style.color, original: el === window.originalAd }));
  assert.deepEqual(restored, { display: "flex", priority: "important", color: "blue", original: true });
  for (const id of [...adIds, "dynamic-ad", "later-marker"]) assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} restored`);
  for (const selector of ["#shadow-host #shadow-ad", "#shadow-host #dynamic-shadow-ad", "#new-shadow-host #new-host-ad"]) assert.equal(await page.locator(selector).isVisible(), true);
  assert.equal(await page.locator("#slot").evaluate((el) => el.style.getPropertyValue("display")), "");
  assert.equal(await page.locator("#meaning").textContent(), "A lease is a time-limited ownership token.");
  assert.equal((await h.msg(tabId, { type: "tf:state" })).status, "idle");
  check("restore returns original display values/priorities and original text while preserving unrelated style changes and dynamic ads");

  const only = await h.open(`${base}/ads-only.html`);
  const beforeOnly = stats.requests.length;
  const onlyState = await h.msg(only.tabId, { type: "tf:translate", mode: "replace" });
  assert.equal(onlyState.status, "translated");
  assert.equal(await only.page.locator("#only-ad").isVisible(), false);
  assert.equal(stats.requests.length, beforeOnly);
  await h.msg(only.tabId, { type: "tf:restore" });
  assert.equal(await only.page.locator("#only-ad").isVisible(), true);
  check("an ads-only page can hide and restore ads without an API request");

  requestDelay = 500;
  const pending = h.msg(tabId, { type: "tf:translate", mode: "replace" });
  let running = false;
  for (let i = 0; i < 100; i++) {
    if ((await h.msg(tabId, { type: "tf:state" })).status === "running") { running = true; break; }
    await wait(20);
  }
  assert.equal(running, true);
  assert.equal(await page.locator("#div-gpt-ad-sidebar").isVisible(), false);
  await wait(50);
  await h.msg(tabId, { type: "tf:restore" });
  await pending;
  await wait(650);
  assert.equal((await h.msg(tabId, { type: "tf:state" })).status, "idle");
  assert.equal(await page.locator("#div-gpt-ad-sidebar").isVisible(), true);
  assert.equal(await page.locator("#meaning").textContent(), "A lease is a time-limited ownership token.");
  check("restoring during an in-flight translation keeps the page idle and ads visible after the pending request settles");
  console.log("Advertisement exclusion E2E passed.");
} finally {
  if (h) await h.close();
  await new Promise((resolve) => server.close(resolve));
}
