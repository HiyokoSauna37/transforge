// 診断: as2 ページで各フェーズの所要時間を測る（collect / sort / batch をメインワールドで、翻訳進行をポーリング）
import { join } from "node:path";
import { startServer, stats } from "./mock_server.mjs";
import { launch, EXT } from "./harness.mjs";

const t0 = Date.now();
const log = (s) => console.log(`${String(Date.now() - t0).padStart(6)}ms ${s}`);
setTimeout(() => { log("WATCHDOG exit"); process.exit(3); }, 150000).unref();

const { server, port } = await startServer();
const BASE = `http://127.0.0.1:${port}`;
const h = await launch({ prefix: "tf-diag-" });
await h.setSettings({
  schema: 2, apiKey: "test-key", apiBase: BASE, model: "claude-opus-5-5", effort: "low", targetLang: "日本語",
  displayMode: "replace", batchChars: 2500, concurrency: 4, cacheEnabled: true, skipNav: true, autoHosts: [], usdJpy: 150,
});
const page = await h.ctx.newPage();
page.on("console", (m) => { if (m.type() === "error" || /TF/.test(m.text())) log(`[page console] ${m.text()}`); });
page.on("pageerror", (e) => log(`[pageerror] ${e.message}`));
await page.goto(`${BASE}/as2.html`);
log("page loaded");

// segmenter 単体の所要時間（メインワールドに読み込んで計測）
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

const tabId = await h.tabIdOf(page);
await h.waitContent(tabId);
log("content ready; sending translate");
let finished = false;
const done = h.msg(tabId, { type: "tf:translate", mode: "replace" }).then((st) => {
  finished = true;
  log(`translate resolved: ${JSON.stringify({ status: st.status, progress: st.progress, error: st.error })}`);
  return st;
});
for (let i = 0; i < 60 && !finished; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await h.msg(tabId, { type: "tf:state" }).catch(() => null);
  const last = stats.requests.length ? stats.requests[stats.requests.length - 1].t - t0 : "-";
  log(`poll: status=${st && st.status} progress=${st && JSON.stringify(st.progress)} requests=${stats.requests.length} lastReq=${last}`);
}
await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
await h.close();
server.close();
