// 字幕取得は実際の Chromium DOM / fetch で確認し、ネットワークは固定応答に置き換える。
import assert from "node:assert/strict";
import { loadChromium } from "./harness.mjs";
import { extractYouTubeCaptions, loadYouTubeCaptions } from "../shared/youtube.js";

const id = "jNQXAC9IVRw";
const url = `https://www.youtube.com/watch?v=${id}`;
const chromium = await loadChromium();
const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}) });
const context = await browser.newContext();
const page = await context.newPage();
const check = (name) => console.log(`✓ ${name}`);
let captionBody = "";
let captionDelay = 0;
let captionCalls = 0;
let foreignCalls = 0;
try {
  await context.route("https://example.com/**", async (route) => { foreignCalls++; await route.abort(); });
  await context.route("https://www.youtube.com/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === "/api/timedtext") {
      captionCalls++;
      if (captionDelay) await new Promise((resolve) => setTimeout(resolve, captionDelay));
      await route.fulfill({ status: 200, contentType: "application/json", body: captionBody });
    } else await route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><ytd-watch-flexy video-id="jNQXAC9IVRw"><div id="movie_player"></div><ytd-watch-metadata></ytd-watch-metadata></ytd-watch-flexy></body></html>' });
  });
  async function reset(extra = {}) {
    await page.goto(url);
    await page.evaluate(({ id, extra }) => {
      const data = { videoDetails: { videoId: id, title: "字幕テスト", lengthSeconds: "30" }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { languageCode: "ja", vssId: ".ja", name: { simpleText: "日本語" }, baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=ja` },
        { languageCode: "en", vssId: ".en", name: { simpleText: "English" }, baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=en` },
      ] } }, ...extra };
      window.ytInitialPlayerResponse = data;
      const player = document.getElementById("movie_player");
      player.getPlayerResponse = () => data;
      player.getOption = () => ({ vss_id: ".ja" });
    }, { id, extra });
  }
  captionBody = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: "今日は " }, { utf8: "よい日です。" }] },
    { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: "外へ出ます。" }] },
  ] });
  await reset();
  let result = await page.evaluate(extractYouTubeCaptions, id);
  assert.equal(result.ok, true);
  assert.equal(result.sourceLang, "ja");
  assert.deepEqual(result.cues, [{ start: 0, end: 2, text: "今日は よい日です。" }, { start: 2, end: 5, text: "外へ出ます。" }]);
  check("JSON3 captions use the selected track and normalize word fragments / overlapping timing");

  captionBody = '<transcript><text start="1.5" dur="3">Tea &amp; toast</text><text start="5" dur="2">It&#39;s ready.</text></transcript>';
  await reset();
  result = await page.evaluate(extractYouTubeCaptions, id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cues, [{ start: 1.5, end: 4.5, text: "Tea & toast" }, { start: 5, end: 7, text: "It's ready." }]);
  check("XML captions preserve precise timings and decode text entities without injecting HTML");

  await reset();
  await page.evaluate(() => {
    const panel = document.createElement("ytd-engagement-panel-section-list-renderer");
    panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    panel.innerHTML = '<transcript-segment-view-model><div class="ytwTranscriptSegmentViewModelTimestamp">0:01</div><div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">1 秒</div><span role="text">Hello.</span></transcript-segment-view-model><transcript-segment-view-model><div class="ytwTranscriptSegmentViewModelTimestamp">0:04</div><span role="text">Goodbye.</span></transcript-segment-view-model>';
    document.body.append(panel);
  });
  const beforeDom = captionCalls;
  result = await page.evaluate(extractYouTubeCaptions, id);
  assert.equal(result.ok, true);
  assert.equal(captionCalls, beforeDom);
  assert.equal(result.sourceLang, "auto");
  assert.deepEqual(result.cues, [{ start: 1, end: 4, text: "Hello." }, { start: 4, end: 12, text: "Goodbye." }]);
  check("the current modern transcript DOM is preferred; accessibility timestamps never enter the subtitle text");
  await page.evaluate(() => {
    const search = document.createElement("input"); search.value = "filtered";
    document.querySelector("ytd-engagement-panel-section-list-renderer").append(search);
  });
  result = await page.evaluate(extractYouTubeCaptions, id);
  assert.equal(result.ok, false);
  assert.match(result.error, /検索欄/);
  check("a filtered transcript is rejected instead of silently returning an incomplete subtitle list");

  captionBody = "";
  await reset();
  await page.evaluate(() => {
    const section = document.createElement("ytd-video-description-transcript-section-renderer");
    const button = document.createElement("button"); button.textContent = "文字起こしを表示";
    button.addEventListener("click", () => {
      const panel = document.createElement("ytd-engagement-panel-section-list-renderer");
      panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      panel.innerHTML = '<ytd-transcript-segment-renderer><div class="segment-timestamp">0:02</div><yt-formatted-string class="segment-text">字幕のある動画。</yt-formatted-string></ytd-transcript-segment-renderer><ytd-transcript-segment-renderer><div class="segment-timestamp">0:08</div><yt-formatted-string class="segment-text">最後の文。</yt-formatted-string></ytd-transcript-segment-renderer>';
      document.body.append(panel);
    });
    section.append(button); document.querySelector("ytd-watch-metadata").append(section);
  });
  result = await page.evaluate(extractYouTubeCaptions, id);
  assert.equal(result.ok, true);
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].text, "字幕のある動画。");
  assert.equal(result.cues[0].end, 8);
  check("empty timedtext responses fall back to YouTube's transcript button and support the legacy transcript DOM");

  captionBody = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Old video" }] }] });
  captionDelay = 100;
  await reset();
  const extraction = page.evaluate(extractYouTubeCaptions, id);
  await page.waitForTimeout(30);
  await page.evaluate(() => history.replaceState({}, "", "/watch?v=arj7oStGLkU"));
  result = await extraction;
  assert.equal(result.ok, false);
  assert.match(result.error, /切り替わりました/);
  captionDelay = 0;
  check("a navigation during extraction cannot apply subtitles from the previous video");

  await reset({ videoDetails: { videoId: id, isLive: true } });
  result = await page.evaluate(extractYouTubeCaptions, id);
  assert.equal(result.ok, false);
  assert.match(result.error, /ライブ/);
  check("live streams are explicitly outside the initial supported scope");

  await reset({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", baseUrl: "https://example.com/api/timedtext?v=" + id }] } } });
  const beforeInvalidUrl = captionCalls;
  result = await page.evaluate(extractYouTubeCaptions, id);
  assert.equal(result.ok, false);
  assert.equal(captionCalls, beforeInvalidUrl);
  assert.equal(foreignCalls, 0);
  check("page-supplied caption URLs cannot cause requests to a different host");

  let injected = 0;
  let injectedResult = { ok: true, videoId: id, title: "test", sourceLang: "en", sourceLabel: "English", cues: [{ start: 1, end: 2, text: "Caption" }] };
  globalThis.chrome = { tabs: { get: async () => ({ url }) }, scripting: { executeScript: async () => { injected++; return [{ result: injectedResult }]; } } };
  const sender = { tab: { id: 3 }, frameId: 0, url };
  assert.equal((await loadYouTubeCaptions(sender, id)).ok, true);
  assert.equal((await loadYouTubeCaptions({ ...sender, frameId: 1 }, id)).ok, false);
  assert.equal((await loadYouTubeCaptions({ ...sender, url: "https://example.com/watch?v=" + id }, id)).ok, false);
  assert.equal((await loadYouTubeCaptions(sender, "invalid")).ok, false);
  assert.equal(injected, 1);
  injectedResult = { ...injectedResult, cues: [{ start: 2, end: 1, text: "invalid" }] };
  assert.equal((await loadYouTubeCaptions(sender, id)).ok, false);
  injectedResult = { ...injectedResult, cues: [{ start: 1, end: 2, text: "x".repeat(2001) }] };
  assert.equal((await loadYouTubeCaptions(sender, id)).ok, false);
  check("the extension boundary rejects other origins, subframes, invalid video IDs and malformed page results");
} finally {
  delete globalThis.chrome;
  await browser.close();
}
