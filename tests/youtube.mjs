// 実際の拡張/background/MAIN world抽出を通し、YouTubeだけをローカルfixtureに置換する。
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launch, EXT } from "./harness.mjs";

const VIDEO = "dQw4w9WgXcQ";
const URL = `https://www.youtube.com/watch?v=${VIDEO}`;
const fixture = readFileSync(join(EXT, "tests/fixture/youtube.html"), "utf8");
const requests = [];
let delay = 20;
let malformed = false;
let captionFetches = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (text) => console.log(`✓ ${text}`);
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/messages") { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const request = JSON.parse(body);
    const payload = JSON.parse(request.messages[0].content);
    requests.push({ request, payload });
    const cues = payload.cues.map(({ id }) => ({ id, text: `Natural subtitle ${id}.` }));
    if (malformed) cues.pop();
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: request.model, content: [{ type: "text", text: JSON.stringify({ cues }) }], stop_reason: "end_turn",
        usage: { input_tokens: 120, output_tokens: 60 },
      }));
    }, delay);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
let h;
try {
  h = await launch({ prefix: "yomeru-youtube-", viewport: { width: 1200, height: 850 } });
  await h.ctx.route("https://www.youtube.com/**", async (route) => {
    const url = new globalThis.URL(route.request().url());
    if (url.pathname === "/watch") return route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture });
    if (url.pathname === "/api/timedtext") {
      captionFetches++;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        events: Array.from({ length: 24 }, (_, id) => ({ tStartMs: id * 5000, dDurationMs: 2000, segs: [{ utf8: `元の字幕 ${id} です。` }] })),
      }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await h.ctx.route("https://example.test/**", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  const settings = { schema: 2, apiKey: "test-key", apiBase: `http://127.0.0.1:${port}`, model: "claude-sonnet-5-5", effort: "low",
    targetLang: "日本語", displayMode: "replace", cacheEnabled: true, skipNav: true, autoHosts: [] };
  await h.setSettings(settings);
  const { page, tabId } = await h.open(URL);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector("video").readyState >= 1);
  const message = (msg) => h.msg(tabId, msg);
  const state = () => message({ type: "tf:youtubeState" });
  async function waitState(test, description) {
    for (let i = 0; i < 100; i++) { const value = await state(); if (test(value)) return value; await wait(100); }
    throw new Error(`${description}: ${JSON.stringify(await state())}`);
  }
  async function waitRequests(count) {
    for (let i = 0; i < 100; i++) { if (requests.length >= count) return; await wait(50); }
    throw new Error(`Expected ${count} API requests, got ${requests.length}`);
  }
  async function setTime(time) {
    await page.evaluate((value) => { document.querySelector("video").currentTime = value; }, time);
    await page.waitForFunction((value) => Math.abs(document.querySelector("video").currentTime - value) < 0.1, time);
  }
  const waitLine = (id) => page.waitForFunction((id) => {
    const line = document.getElementById("tf-youtube-subtitles")?.shadowRoot?.querySelector(".translated");
    return line && !line.hidden && line.textContent === `Natural subtitle ${id}.`;
  }, id);
  const nativeVisibility = () => page.locator(".ytp-caption-window-container").evaluate((el) => getComputedStyle(el).visibility);
  const bgFromTab = (id, msg, allFrames = false) => h.sw.evaluate(async ({ id, msg, allFrames }) => {
    return chrome.scripting.executeScript({ target: { tabId: id, allFrames }, func: (m) => chrome.runtime.sendMessage(m), args: [msg] });
  }, { id, msg, allFrames });

  await wait(350);
  assert.equal((await state()).status, "idle");
  assert.equal(requests.length, 0);
  assert.equal(captionFetches, 0);
  let popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup/popup.html?tab=${tabId}`);
  await popup.locator("#youtube").waitFor({ state: "visible" });
  assert.equal(await popup.inputValue("#subtitleLang"), "日本語");
  assert.equal(await popup.inputValue("#subtitleModel"), "claude-haiku-5-5");
  assert.equal(await popup.inputValue("#model"), "claude-sonnet-5-5");
  await popup.selectOption("#model", "claude-opus-5-5");
  await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "getSettings" })).settings.model === "claude-opus-5-5");
  assert.equal(await popup.inputValue("#subtitleModel"), "claude-haiku-5-5");
  await popup.reload();
  await popup.locator("#youtube").waitFor({ state: "visible" });
  assert.equal(await popup.inputValue("#subtitleLang"), "日本語");
  assert.equal(await popup.inputValue("#subtitleModel"), "claude-haiku-5-5");
  await popup.selectOption("#subtitleMode", "bilingual");
  await popup.waitForFunction(async () => {
    const settings = (await chrome.runtime.sendMessage({ type: "getSettings" })).settings;
    return settings.subtitleTargetLang === "日本語" && settings.subtitleMode === "bilingual" && settings.targetLang === "日本語";
  });
  assert.equal(requests.length, 0);
  await popup.locator("#subtitleStart").click();
  const initial = await waitState((s) => s.status === "active" && s.done === 9, "first subtitle batch");
  await popup.waitForFunction(() => document.getElementById("subtitleStatus").textContent.includes("9/24"));
  assert.equal(await popup.locator("#subtitleLang").isDisabled(), true);
  await popup.close();
  await page.bringToFront();
  assert.equal(initial.total, 24);
  assert.equal(initial.sourceLang, "ja");
  assert.equal(captionFetches, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.target_language, "日本語");
  assert.equal(requests[0].request.model, "claude-haiku-5-5");
  assert.equal(requests[0].payload.context_after.length, 3);
  assert.match(requests[0].request.system[0].text, /untrusted source material/);
  await waitLine(0);
  assert.equal(await page.locator("#tf-youtube-subtitles .original").isVisible(), true);
  assert.match(await page.locator("#tf-youtube-subtitles .original").textContent(), /元の字幕 0/);
  assert.equal(await nativeVisibility(), "hidden");
  check("no automatic API traffic; explicit start extracts MAIN-world captions, translates only the look-ahead batch and overlays synchronized bilingual text");
  check("popup defaults and API requests use Japanese/Haiku; changing the page model leaves the subtitle model independent");

  await message({ type: "tf:youtubeMode", mode: "replace" });
  assert.equal(await page.locator("#tf-youtube-subtitles .original").isVisible(), false);
  await message({ type: "tf:youtubeMode", mode: "bilingual" });
  await setTime(3);
  await page.waitForFunction(() => {
    const root = document.getElementById("tf-youtube-subtitles").shadowRoot;
    return root.querySelector(".translated").hidden && root.querySelector(".original").hidden && root.querySelector(".notice").hidden;
  });
  await setTime(1);
  await waitLine(0);
  assert.equal(requests.length, 1);
  check("single/bilingual display switches without retranslation; caption gaps clear both lines and backward seeking reuses translated text");

  await page.evaluate(() => document.getElementById("movie_player").classList.add("ad-showing"));
  await setTime(95);
  await page.waitForFunction(() => document.getElementById("tf-youtube-subtitles").hidden);
  assert.equal(await page.locator("#tf-youtube-subtitles").evaluate((host) => getComputedStyle(host).display), "none");
  assert.equal(await nativeVisibility(), "visible");
  await wait(300);
  assert.equal(requests.length, 1);
  await page.evaluate(() => document.getElementById("movie_player").classList.remove("ad-showing"));
  await waitLine(19);
  assert.equal(await page.locator("#tf-youtube-subtitles .translated").isVisible(), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].payload.cues[0].id, 18);
  assert.equal(requests[1].payload.context_before.length, 3);
  await setTime(1);
  await waitLine(0);
  assert.equal(requests.length, 2);
  await page.screenshot({ path: join(tmpdir(), "yomeru-youtube.png") });
  check("advertisements hide the overlay and suspend translation; seeking translates the relevant future batch and retains earlier results");

  popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup/popup.html?tab=${tabId}`);
  await popup.locator("#subtitleStop").waitFor({ state: "visible" });
  await popup.locator("#subtitleStop").click();
  await popup.locator("#subtitleStart").waitFor({ state: "visible" });
  await popup.close();
  await page.bringToFront();
  assert.equal((await state()).status, "idle");
  assert.equal(await page.locator("#tf-youtube-subtitles").count(), 0);
  assert.equal(await nativeVisibility(), "visible");
  await message({ type: "tf:youtubeStart", mode: "replace" });
  const cached = await waitState((s) => s.done === 9, "cached restart");
  assert.equal(cached.usage.cached, 9);
  assert.equal(cached.usage.requests, 0);
  assert.equal(requests.length, 2);
  await waitLine(0);
  check("popup stop removes extension subtitles and restores native captions; restarting uses persistent cache without another model call");

  await message({ type: "tf:youtubeStop" });
  popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup/popup.html?tab=${tabId}`);
  await popup.locator("#youtube").waitFor({ state: "visible" });
  await popup.selectOption("#subtitleModel", "claude-sonnet-5-5");
  await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "getSettings" })).settings.subtitleModel === "claude-sonnet-5-5");
  assert.equal(await popup.inputValue("#model"), "claude-opus-5-5");
  const independentSettings = await popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: "getSettings" })).settings);
  assert.equal(independentSettings.model, "claude-opus-5-5");
  await popup.locator("#subtitleStart").click();
  await waitState((s) => s.done === 9, "different-model subtitle batch");
  assert.equal(requests.length, 3);
  assert.equal(requests.at(-1).request.model, "claude-sonnet-5-5");
  assert.equal(requests.at(-1).payload.target_language, "日本語");
  await popup.locator("#subtitleStop").click();
  await popup.locator("#subtitleStart").waitFor({ state: "visible" });
  await popup.selectOption("#subtitleModel", "claude-haiku-5-5");
  await popup.selectOption("#subtitleLang", "English");
  await popup.waitForFunction(async () => {
    const s = (await chrome.runtime.sendMessage({ type: "getSettings" })).settings;
    return s.subtitleModel === "claude-haiku-5-5" && s.subtitleTargetLang === "English";
  });
  await popup.reload();
  await popup.locator("#youtube").waitFor({ state: "visible" });
  assert.equal(await popup.inputValue("#subtitleLang"), "English");
  await popup.selectOption("#subtitleLang", "日本語");
  await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "getSettings" })).settings.subtitleTargetLang === "日本語");
  await popup.locator("#subtitleStart").click();
  const originalModelCache = await waitState((s) => s.done === 9, "original-model subtitle cache");
  assert.equal(originalModelCache.usage.cached, 9);
  assert.equal(requests.length, 3);
  await popup.close();
  await page.bringToFront();
  check("subtitle model changes leave the page model untouched, reach the API and use separate caches; explicit English remains selectable");

  // ページ翻訳のMutationObserverに字幕領域が巻き込まれないことも確認する。
  await page.addScriptTag({ path: join(EXT, "content/segmenter.js") });
  const excluded = await page.evaluate(() => {
    return TFSeg.collectUnits(document.body, { skipNav: true }).map((run) => run.text).join("\n");
  });
  assert.doesNotMatch(excluded, /YouTube の元字幕|Natural subtitle/);
  check("page translation excludes the video player and extension subtitle overlay");

  // 不完全なモデル応答は時刻ずれにつながるため、表示せず元字幕へ戻す。
  await message({ type: "tf:youtubeStop" });
  await h.setSettings({ ...settings, cacheEnabled: false });
  malformed = true;
  await message({ type: "tf:youtubeStart", targetLang: "English", mode: "replace" });
  const bad = await waitState((s) => s.status === "error", "missing response cue");
  assert.match(bad.error, /一致しません/);
  assert.equal(await nativeVisibility(), "visible");
  assert.equal(await page.locator("#tf-youtube-subtitles .captions").isVisible(), false);
  malformed = false;
  check("a missing translated cue fails visibly, preserves synchronization and restores native captions");

  await message({ type: "tf:youtubeStop" });
  delay = 700;
  const beforePending = requests.length;
  await message({ type: "tf:youtubeStart", targetLang: "English", mode: "bilingual" });
  await waitRequests(beforePending + 1);
  await message({ type: "tf:youtubeStop" });
  await wait(900);
  assert.equal((await state()).status, "idle");
  assert.equal(await page.locator("#tf-youtube-subtitles").count(), 0);
  assert.equal(await nativeVisibility(), "visible");
  check("stopping while the model is pending cancels work and a late response never resurrects subtitles");

  const beforeSeek = requests.length;
  await message({ type: "tf:youtubeStart", targetLang: "English", mode: "bilingual" });
  await waitRequests(beforeSeek + 1);
  await setTime(95);
  await waitLine(19);
  assert.equal((await state()).status, "active");
  assert.equal(requests.length, beforeSeek + 2);
  assert.equal(requests.at(-1).payload.cues[0].id, 18);
  check("seeking away from an in-flight batch cancels it and prioritizes the new playback position");

  await page.evaluate(() => {
    document.dispatchEvent(new Event("yt-navigate-start"));
    history.pushState({}, "", "/watch?v=aaaaaaaaaaa");
    document.querySelector("ytd-watch-flexy").setAttribute("video-id", "aaaaaaaaaaa");
    window.ytInitialPlayerResponse.videoDetails.videoId = "aaaaaaaaaaa";
    window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl = "https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=ja";
  });
  assert.equal((await state()).status, "idle");
  assert.equal(await page.locator("#tf-youtube-subtitles").count(), 0);
  const afterNavigation = requests.length;
  await wait(350);
  assert.equal(requests.length, afterNavigation);
  check("YouTube SPA navigation stops the previous video and never automatically sends the new video's captions");

  const forbiddenMessage = { type: "translateSubtitles", sessionId: "test", videoId: VIDEO, cues: [{ id: 0, start: 0, end: 1, text: "x" }] };
  const stale = await bgFromTab(tabId, forbiddenMessage);
  assert.equal(stale[0].result.ok, false);
  const staleCaptions = await bgFromTab(tabId, { type: "getYouTubeCaptions", videoId: VIDEO });
  assert.equal(staleCaptions[0].result.ok, false);
  assert.equal(requests.length, afterNavigation);
  delay = 20;
  await message({ type: "tf:youtubeStart", targetLang: "English", mode: "bilingual" });
  await waitLine(19);
  assert.equal(requests.at(-1).payload.video_id, "aaaaaaaaaaa");
  await message({ type: "tf:youtubeStop" });
  const afterRestart = requests.length;
  check("after SPA navigation, stale-video messages are rejected and explicit start works for the new current video");
  const foreign = await h.open("https://example.test/page");
  const notYouTube = await bgFromTab(foreign.tabId, forbiddenMessage);
  assert.equal(notYouTube[0].result.ok, false);
  const notCaption = await bgFromTab(foreign.tabId, { type: "getYouTubeCaptions", videoId: VIDEO });
  assert.equal(notCaption[0].result.ok, false);
  await page.evaluate((url) => {
    const frame = document.createElement("iframe"); frame.src = url; frame.id = "caption-frame"; document.body.append(frame);
  }, URL);
  await page.waitForFunction((url) => {
    const doc = document.querySelector("#caption-frame").contentDocument;
    return doc?.readyState === "complete" && doc.location.href === url;
  }, URL);
  const framed = await bgFromTab(tabId, forbiddenMessage, true);
  assert.ok(framed.some((item) => item.frameId !== 0));
  assert.ok(framed.every((item) => item.result.ok === false));
  const framedCaptions = await bgFromTab(tabId, { type: "getYouTubeCaptions", videoId: VIDEO }, true);
  assert.ok(framedCaptions.every((item) => item.result.ok === false));
  assert.equal(requests.length, afterRestart);
  check("stale-video, foreign-site and iframe messages cannot invoke caption extraction or translation");
  assert.deepEqual(errors, []);
  console.log("YouTube subtitle E2E passed.");
} finally {
  if (h) await h.close();
  await new Promise((resolve) => server.close(resolve));
}
