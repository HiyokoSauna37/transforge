// 設定を読む前にパネルが閉じられても、後から解説APIを送信しないことを検証する。
import assert from "node:assert/strict";
import { launch } from "./harness.mjs";
import { startServer, stats } from "./mock_server.mjs";

const { server, port } = await startServer();
let h;
try {
  h = await launch({ prefix: "yomeru-explain-cancel-" });
  await h.setSettings({ schema: 2, apiKey: "test-key", apiBase: `http://127.0.0.1:${port}`, model: "claude-sonnet-5-5", effort: "low", targetLang: "日本語", cacheEnabled: false });
  const page = await h.ctx.newPage();
  await page.goto(`chrome-extension://${h.extId}/options/options.html`);
  await page.waitForFunction(() => document.getElementById("model")?.options.length > 0);
  await h.sw.evaluate(() => {
    const original = chrome.storage.local.get;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.__releaseExplanationRead = () => { chrome.storage.local.get = original; release(); };
    chrome.storage.local.get = async (...args) => { await gate; return original.apply(chrome.storage.local, args); };
  });
  await page.evaluate(() => {
    globalThis.pendingExplanation = chrome.runtime.sendMessage({ type: "explain", sessionId: "before-settings", selection: "lease", context: {} });
  });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "cancel", sessionId: "before-settings" }));
  await h.sw.evaluate(() => { globalThis.__releaseExplanationRead(); delete globalThis.__releaseExplanationRead; });
  const canceled = await page.evaluate(() => globalThis.pendingExplanation);
  assert.equal(canceled.ok, false);
  assert.equal(canceled.error, "cancelled");
  assert.equal(stats.requests.length, 0);
  console.log("✓ closing an explanation while settings are pending prevents any later API call");
  const success = await page.evaluate(() => chrome.runtime.sendMessage({ type: "explain", sessionId: "normal", selection: "lease", context: {} }));
  assert.equal(success.ok, true);
  assert.equal(stats.requests.length, 1);
  assert.match(success.text, /lease/);
  console.log("✓ the following explanation still completes normally after cancellation");
} finally {
  if (h) {
    await h.sw.evaluate(() => { globalThis.__releaseExplanationRead?.(); delete globalThis.__releaseExplanationRead; }).catch(() => {});
    await h.close();
  }
  server.close();
}
