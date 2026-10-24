// 診断: as2 ページで各フェーズの所要時間を測る（collect / sort / batch をメインワールドで、翻訳進行をポーリング）
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startServer, stats } from "./mock_server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "..");
// playwright-core は node_modules から解決（PW_PATH=<playwright-core/index.mjs> で別の場所を指定可）
const { chromium } = process.env.PW_PATH
  ? await import(pathToFileURL(process.env.PW_PATH).href)
  : await import("playwright-core").catch(() => {
      console.error("playwright-core が見つかりません: npm i && npx playwright install chromium を実行するか、PW_PATH を指定してください");
      process.exit(2);
    });
const t0 = Date.now();
const log = (s) => console.log(`${String(Date.now() - t0).padStart(6)}ms ${s}`);
setTimeout(() => { log("WATCHDOG exit"); process.exit(3); }, 150000).unref();

const { server, port } = await startServer();
const BASE = `http://127.0.0.1:${port}`;
const userDataDir = mkdtempSync(join(tmpdir(), "tf-diag-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: true, channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 30000 });
await sw.evaluate(async (s) => { await chrome.storage.local.set({ settings: s }); }, {
  schema: 2, apiKey: "test-key", apiBase: BASE, model: "claude-opus-5-5", effort: "low", targetLang: "日本語",
  displayMode: "replace", batchChars: 2500, concurrency: 4, cacheEnabled: true, skipNav: true, autoHosts: [], usdJpy: 150,
});
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error" || /TF/.test(m.text())) log(`[page console] ${m.text()}`); });
page.on("pageerror", (e) => log(`[pageerror] ${e.message}`));
await page.goto(`${BASE}/as2.html`);
log("page loaded");
await page.addScriptTag({ path: join(EXT, "content/segmenter.js") });
const phases = await page.evaluate(() => {
  const out = {};
  let t = performance.now();
  const units = TFSeg.collectUnits(document.body, { skipNav: true, targetLang: "日本語" });
  out.collectMs = Math.round(performance.now() - t); out.units = units.length;
  out.chars = units.reduce((a, u) => a + u.text.length, 0);
  t = performance.now();
  TFSeg.sortByViewport(units);
  out.sortMs = Math.round(performance.now() - t);
  t = performance.now();
  const batches = TFSeg.makeBatches(units, 2500);
  out.batchMs = Math.round(performance.now() - t); out.batches = batches.length;
  out.biggest = Math.max(...units.map((u) => u.text.length));
  return out;
});
log(`phases: ${JSON.stringify(phases)}`);

const tabId = await sw.evaluate(async (u) => { const tabs = await chrome.tabs.query({}); return tabs.find((x) => x.url === u).id; }, page.url());
for (let i = 0; i < 30; i++) {
  const ok = await sw.evaluate(async (id) => { try { const r = await chrome.tabs.sendMessage(id, { type: "tf:ping" }); return !!(r && r.ok); } catch { return false; } }, tabId);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 100));
}
log("content ready; sending translate");
const done = sw.evaluate(([id]) => chrome.tabs.sendMessage(id, { type: "tf:translate", mode: "replace" }), [tabId]).then((st) => { log(`translate resolved: ${JSON.stringify({ status: st.status, progress: st.progress, error: st.error })}`); return st; });
let finished = false;
done.then(() => { finished = true; });
for (let i = 0; i < 60 && !finished; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await sw.evaluate(([id]) => chrome.tabs.sendMessage(id, { type: "tf:state" }), [tabId]).catch(() => null);
  log(`poll: status=${st && st.status} progress=${st && JSON.stringify(st.progress)} requests=${stats.requests.length} lastReq=${stats.requests.length ? stats.requests[stats.requests.length - 1].t - t0 - 0 : "-"}`);
}
await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
await ctx.close();
server.close();
rmSync(userDataDir, { recursive: true, force: true });
