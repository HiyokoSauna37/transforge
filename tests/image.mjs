// 右クリック画像→取得/縮小→Claude→パネルの経路を、実ブラウザとローカルAPIモックで検証。
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { launch } from "./harness.mjs";

const requests = [];
let imageBytes = null;
const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400"><rect width="100%" height="100%" fill="white"/><text x="60" y="230" font-size="100">Remote SVG</text></svg>');
let remoteFetches = 0;
let remoteSvgFetches = 0;
let delay = 40;
let responseMode = "ok";
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/image.html")) {
    res.writeHead(200, { "content-type": "text/html", ...(req.url.includes("csp=1") ? { "content-security-policy": "img-src data: https://images.example.com" } : {}) });
    return res.end(readFileSync(new URL("./fixture/image.html", import.meta.url)));
  }
  if (req.method === "GET" && req.url === "/image.png") {
    remoteFetches++;
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(imageBytes);
  }
  if (req.method === "GET" && req.url === "/image.svg") {
    remoteSvgFetches++;
    res.writeHead(200, { "content-type": "image/svg+xml" });
    return res.end(svgBytes);
  }
  if (req.method !== "POST" || req.url !== "/v1/messages") { res.writeHead(404); res.end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const multimodal = Array.isArray(body.messages[0].content);
  const text = multimodal
    ? responseMode === "invalid" ? "not json" : JSON.stringify({ original: "Hello from Yomeru", translation: "Yomeruからこんにちは" })
    : "ページの選択箇所の解説です。";
  const result = { id: "image-mock", type: "message", role: "assistant", model: body.model,
    content: [{ type: "text", text }], stop_reason: responseMode === "truncated" ? "max_tokens" : "end_turn",
    usage: { input_tokens: 100, output_tokens: 40 } };
  setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result)); }, delay);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
let h;
const check = text => console.log(`✓ ${text}`);
try {
  h = await launch({ prefix: "yomeru-image-", viewport: { width: 1100, height: 850 } });
  const settings = { schema: 2, apiKey: "test-key", apiBase: `http://127.0.0.1:${port}`, model: "claude-sonnet-5-5", targetLang: "日本語", effort: "low", cacheEnabled: true, autoHosts: [] };
  await h.setSettings(settings);
  const { page, tabId } = await h.open(`http://127.0.0.1:${port}/image.html?private=hidden#secret`);
  await page.waitForFunction(() => ["data-image", "blob-image"].every(id => document.getElementById(id).naturalWidth === 4096) && document.getElementById("svg-image").naturalWidth === 1200);
  const pickImage = async (id) => page.evaluate(id => {
    const img = document.getElementById(id);
    img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true }));
    return img.currentSrc || img.src;
  }, id);
  const translate = async (id, { capture = true } = {}) => {
    const srcUrl = capture ? await pickImage(id) : await page.locator(`#${id}`).getAttribute("src");
    await h.msg(tabId, { type: "tf:translateImage", srcUrl });
  };
  const waitText = text => page.waitForFunction(text => {
    const body = document.getElementById("tf-host")?.shadowRoot?.querySelector(".pb");
    return body && !body.classList.contains("wait") && body.textContent.includes(text);
  }, text);
  const waitRequests = async count => {
    const deadline = Date.now() + 5000;
    while (requests.length < count && Date.now() < deadline) await page.waitForTimeout(20);
    assert.ok(requests.length >= count, "the API request should have started");
  };

  await pickImage("data-image");
  assert.equal(requests.length, 0);
  await translate("data-image");
  await waitText("Yomeruからこんにちは");
  assert.equal(requests.length, 1);
  const imagePart = requests[0].messages[0].content.find(part => part.type === "image");
  assert.equal(imagePart.source.media_type, "image/png");
  const encoded = Buffer.from(imagePart.source.data, "base64");
  assert.equal(encoded.readUInt32BE(16), 2048);
  assert.equal(encoded.readUInt32BE(20), 512);
  assert.ok(encoded.length <= 5 * 1024 * 1024);
  const textPart = JSON.parse(requests[0].messages[0].content.find(part => part.type === "text").text);
  assert.equal(textPart.target_language, "日本語");
  assert.doesNotMatch(textPart.page.url, /private|secret/);
  assert.equal(await page.locator("#tf-host .panel-title").textContent(), "Yomeru 画像翻訳");
  assert.equal(await page.locator("#tf-host .model-row").isVisible(), false);
  assert.equal(await page.locator("#tf-host .followup").isVisible(), false);
  await page.locator("#tf-host .orig").click();
  assert.equal(await page.locator("#tf-host .po").textContent(), "Hello from Yomeru");
  check("right-click alone sends nothing; image translation sends resized image bytes and displays translation plus OCR original");

  await translate("data-image");
  await waitText("Yomeruからこんにちは");
  assert.equal(requests.length, 1);
  assert.equal(await page.locator("#tf-host .cost").textContent(), "cache");
  await h.setSettings({ ...settings, targetLang: "English" });
  await translate("data-image");
  await waitText("Yomeruからこんにちは");
  assert.equal(requests.length, 2);
  assert.match(requests.at(-1).system[0].text, /fluent English/);
  check("image results are cached and changing target language uses a separate translation");

  await h.setSettings({ ...settings, cacheEnabled: false });
  // snapshot がなくても data/blob の URL から読み取れる。
  await page.locator("#tf-host .x").click();
  await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  await translate("blob-image", { capture: false });
  await waitText("Yomeruからこんにちは");
  assert.equal(requests.length, 3);
  check("blob images can be decoded and resized without a stored image element");

  await translate("svg-image", { capture: false });
  await waitText("Yomeruからこんにちは");
  assert.equal(requests.length, 4);
  assert.equal(requests.at(-1).messages[0].content.find(part => part.type === "image").source.media_type, "image/png");
  check("data URL SVG images are rasterized to PNG before being sent to the API");

  imageBytes = Buffer.from((await page.locator("#data-image").getAttribute("src")).split(",")[1], "base64");
  await page.route("https://images.example.com/hello.png", route => route.fulfill({ contentType: "image/png", body: imageBytes }));
  await page.evaluate(() => { document.getElementById("remote-image").src = "https://images.example.com/hello.png"; });
  await page.waitForFunction(() => document.getElementById("remote-image").naturalWidth === 4096);
  // 外部ネットワークの画像取得だけを置き換える。sender/URL/MIME/バイト数の検証は通常経路を通す。
  await h.sw.evaluate(local => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => original(String(url) === "https://images.example.com/hello.png" ? local : url, options);
  }, `http://127.0.0.1:${port}/image.png`);
  await translate("remote-image");
  await waitText("Yomeruからこんにちは");
  assert.equal(remoteFetches, 1);
  assert.equal(requests.length, 5);
  check("cross-origin images fall back from a tainted canvas to bounded background fetching and are resized before the API");

  await page.route("https://images.example.com/hello.svg", route => route.fulfill({ contentType: "image/svg+xml", body: svgBytes }));
  await page.evaluate(() => { document.getElementById("remote-image").src = "https://images.example.com/hello.svg"; });
  await page.waitForFunction(() => document.getElementById("remote-image").naturalWidth === 1200);
  await h.sw.evaluate(local => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => original(String(url) === "https://images.example.com/hello.svg" ? local : url, options);
  }, `http://127.0.0.1:${port}/image.svg`);
  await translate("remote-image");
  await waitText("Yomeruからこんにちは");
  assert.equal(remoteSvgFetches, 1);
  assert.equal(requests.length, 6);
  assert.equal(requests.at(-1).messages[0].content.find(part => part.type === "image").source.media_type, "image/png");
  check("cross-origin SVG images are verified, fetched and rasterized before the API request");

  const { page: strictPage, tabId: strictTab } = await h.open(`http://127.0.0.1:${port}/image.html?csp=1`);
  await strictPage.route("https://images.example.com/hello.png", route => route.fulfill({ contentType: "image/png", body: imageBytes }));
  await strictPage.evaluate(() => { document.getElementById("remote-image").src = "https://images.example.com/hello.png"; });
  await strictPage.waitForFunction(() => document.getElementById("remote-image").naturalWidth === 4096);
  await strictPage.waitForFunction(() => { const image = document.getElementById("blob-image"); return image.complete && image.naturalWidth === 0; });
  await strictPage.evaluate(() => document.getElementById("remote-image").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true })));
  await h.msg(strictTab, { type: "tf:translateImage", srcUrl: "https://images.example.com/hello.png" });
  await strictPage.waitForFunction(() => document.getElementById("tf-host")?.shadowRoot?.querySelector(".pb")?.textContent === "Yomeruからこんにちは");
  assert.equal(remoteFetches, 2);
  await strictPage.route("https://images.example.com/hello.svg", route => route.fulfill({ contentType: "image/svg+xml", body: svgBytes }));
  await strictPage.evaluate(() => { document.getElementById("remote-image").src = "https://images.example.com/hello.svg"; });
  await strictPage.waitForFunction(() => document.getElementById("remote-image").naturalWidth === 1200);
  await strictPage.evaluate(() => document.getElementById("remote-image").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true })));
  await h.msg(strictTab, { type: "tf:translateImage", srcUrl: "https://images.example.com/hello.svg" });
  await strictPage.waitForFunction(() => document.getElementById("tf-host")?.shadowRoot?.querySelector(".pb")?.textContent === "Yomeruからこんにちは");
  assert.equal(remoteSvgFetches, 2);
  await strictPage.close();
  check("cross-origin raster and SVG fallbacks work when page CSP forbids blob image URLs");

  const usageRequests = () => h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings.usage?.requests || 0);
  let usageBefore = await usageRequests();
  responseMode = "invalid";
  await translate("data-image");
  await waitText("エラー:");
  assert.equal(await usageRequests(), usageBefore + 1);
  assert.equal(await page.locator("#tf-host .orig").isVisible(), false);
  usageBefore = await usageRequests();
  responseMode = "truncated";
  await translate("data-image");
  await waitText("途中で切れました");
  assert.equal(await usageRequests(), usageBefore + 1);
  responseMode = "ok";
  check("malformed or truncated image answers show errors without caching a result, while actual API usage is recorded");

  delay = 700;
  let pendingRequests = requests.length;
  await translate("data-image");
  await waitRequests(pendingRequests + 1);
  await page.locator("#tf-host .x").click();
  await page.waitForTimeout(800);
  assert.equal(await page.locator("#tf-host .panel").isVisible(), false);
  pendingRequests = requests.length;
  await translate("data-image");
  await waitRequests(pendingRequests + 1);
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.getElementById("text"));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.locator("#tf-host .explainbtn").click();
  await waitText("ページの選択箇所の解説です。");
  await page.waitForTimeout(800);
  assert.equal(await page.locator("#tf-host .panel-title").textContent(), "Yomeru 解説");
  assert.equal(await page.locator("#tf-host .pb").textContent(), "ページの選択箇所の解説です。");
  check("closing an image panel or switching to a selection cancels it and stale image results cannot overwrite the new panel");
  console.log("ALL IMAGE TESTS PASSED");
} finally {
  if (h) await h.close();
  server.close();
}
