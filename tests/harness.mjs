// テスト共通: 拡張を読み込んだ Chromium の起動と、service worker 経由のタブ操作ヘルパー
// playwright-core は node_modules から解決（PW_PATH=<playwright-core/index.mjs> で別の場所を指定可）
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadChromium() {
  if (process.env.PW_PATH) return (await import(pathToFileURL(process.env.PW_PATH).href)).chromium;
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    console.error("playwright-core が見つかりません: npm i && npx playwright install chromium を実行するか、PW_PATH を指定してください");
    process.exit(2);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 拡張入りの永続コンテキストを起動し、service worker を待つ
export async function launch({ headless = true, prefix = "tf-", viewport = null } = {}) {
  const chromium = await loadChromium();
  const userDataDir = mkdtempSync(join(tmpdir(), prefix));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: "chromium", // headless shell では拡張を読めない
    viewport,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  const extId = new URL(sw.url()).host;

  // chrome.storage.local の settings を丸ごと置き換える
  const setSettings = (settings) => sw.evaluate(async (s) => { await chrome.storage.local.set({ settings: s }); }, settings);

  // 翻訳キャッシュ(IndexedDB)を削除。拡張側は versionchange で接続を閉じるので完了まで待てる
  const clearCache = () => sw.evaluate(() => new Promise((r) => {
    const q = indexedDB.deleteDatabase("transforge");
    q.onsuccess = q.onerror = () => r("done");
    setTimeout(() => r("timeout"), 5000);
  }));

  async function tabIdOf(page) {
    const url = page.url();
    for (let i = 0; i < 50; i++) {
      const id = await sw.evaluate(async (u) => { const tabs = await chrome.tabs.query({}); const t = tabs.find((x) => x.url === u); return t ? t.id : null; }, url);
      if (id != null) return id;
      await wait(100);
    }
    throw new Error("tab not found");
  }

  async function waitContent(tabId) {
    for (let i = 0; i < 50; i++) {
      const ok = await sw.evaluate(async (id) => { try { const r = await chrome.tabs.sendMessage(id, { type: "tf:ping" }); return !!(r && r.ok); } catch { return false; } }, tabId);
      if (ok) return;
      await wait(100);
    }
    throw new Error("content script not ready");
  }

  // content script へメッセージを送り応答を返す
  const msg = (tabId, m) => sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, m]);

  // ページを開いて content script の準備まで待つ → {page, tabId}
  async function open(url) {
    const page = await ctx.newPage();
    await page.goto(url);
    const tabId = await tabIdOf(page);
    await waitContent(tabId);
    return { page, tabId };
  }

  async function close() {
    await ctx.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  return { ctx, sw, extId, setSettings, clearCache, tabIdOf, waitContent, msg, open, close };
}
