// 選択範囲の解説: 文脈抽出・送信・キャッシュ・無効化・キャンセルを実ブラウザで検証。
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, stats } from "./mock_server.mjs";
import { launch, EXT } from "./harness.mjs";
import { normalizeExplanation, CONTEXT_LIMIT } from "../shared/explain.js";

const { server, port } = await startServer();
let h;
const check = (name) => console.log(`✓ ${name}`);
try {
  h = await launch({ prefix: "yomeru-explain-", viewport: { width: 1100, height: 850 } });
  const settings = { schema: 2, apiKey: "test-key", apiBase: `http://127.0.0.1:${port}`, model: "claude-sonnet-5-5", effort: "low",
    targetLang: "日本語", displayMode: "replace", cacheEnabled: true, skipNav: true, autoHosts: [] };
  await h.setSettings(settings);
  const { page, tabId } = await h.open(`http://127.0.0.1:${port}/context.html`);
  await page.addScriptTag({ path: join(EXT, "content/context.js") });
  await page.evaluate(() => {
    const stale = document.createElement("div");
    stale.id = "tf-host";
    stale.dataset.tf = "ui";
    stale.textContent = "旧版の翻訳ボタン";
    document.documentElement.append(stale);
  });
  const pick = async (id = "term") => {
    await page.evaluate((id) => {
      const range = document.createRange(); range.selectNodeContents(document.getElementById(id));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, id);
    await page.waitForFunction(() => { const h = document.getElementById("tf-host"); return h?.shadowRoot && !h.shadowRoot.querySelector(".selbtn").hidden; });
  };
  const waitResult = (text) => page.waitForFunction((text) => {
    const p = document.getElementById("tf-host").shadowRoot.querySelector(".panel .pb");
    return !p.classList.contains("wait") && p.textContent.includes(text);
  }, text);
  await pick();
  assert.equal(await page.locator("#tf-host").count(), 1);
  assert.equal(await page.locator("#tf-host .explainbtn").isVisible(), true);
  assert.equal(stats.requests.length, 0);
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "1800px";
    document.body.append(spacer);
  });
  const beforeScroll = await page.locator("#tf-host .seltools").boundingBox();
  await page.evaluate(() => window.scrollBy(0, 120));
  await page.waitForFunction((top) => {
    const tools = document.getElementById("tf-host").shadowRoot.querySelector(".seltools");
    return !tools.hidden && tools.getBoundingClientRect().top < top - 50;
  }, beforeScroll.y);
  await page.evaluate(() => window.scrollBy(0, 1000));
  await page.waitForFunction(() => document.getElementById("tf-host").shadowRoot.querySelector(".seltools").hidden);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.getElementById("tf-host").shadowRoot.querySelector(".seltools").hidden);
  assert.equal(await page.locator("#tf-host .explainbtn").isVisible(), true);
  check("explanation is enabled by default; selection toolbar follows scrolling, hides offscreen and returns with the selection");
  const context = await page.evaluate(() => TFContext.collect("lease", getSelection().getRangeAt(0)));
  const evidence = JSON.stringify(context);
  assert.match(context.nearby, /Workers coordinate ownership/);
  assert.match(context.nearby, /expired token/);
  assert.match(evidence, /time-limited ownership token/);
  assert.match(evidence, /250 milliseconds/);
  assert.doesNotMatch(evidence, /SENTINEL/);
  check("selection alone makes no API call; surrounding paragraphs, distant definition and linked section are collected without hidden/form/nav content");

  await page.locator("#tf-host .explainbtn").click();
  await waitResult("短い説明");
  assert.equal(stats.requests.length, 1);
  const payload = JSON.parse(stats.requests[0].body.messages[0].content);
  assert.equal(payload.selected_passage, "lease");
  assert.equal("user_question" in payload, false);
  assert.match(JSON.stringify(payload.page), /time-limited ownership token/);
  assert.match(JSON.stringify(payload.page), /250 milliseconds/);
  assert.match(stats.requests[0].body.system[0].text, /untrusted material/);
  assert.equal(stats.requests[0].body.max_tokens, 1600);
  await page.locator("#tf-host .source-toggle").click();
  assert.match(await page.locator("#tf-host .sources").textContent(), /time-limited ownership token/);
  await page.screenshot({ path: join(tmpdir(), "yomeru-explanation.png") });
  check("explanation sends actual page evidence and displays its sources");

  await page.locator("#tf-host .simple").click();
  await waitResult("やさしい説明");
  assert.equal(stats.requests.length, 2);
  assert.deepEqual(JSON.parse(stats.requests[1].body.messages[0].content).page, payload.page);
  await page.locator("#tf-host .detailed").click();
  await waitResult("詳しい説明");
  assert.equal(stats.requests.length, 3);
  assert.equal(stats.requests[2].body.max_tokens, 2800);
  await page.locator("#tf-host .detailed").click();
  await waitResult("詳しい説明");
  assert.equal(stats.requests.length, 3);
  assert.equal(await page.locator("#tf-host .cost").textContent(), "cache");
  check("simpler/detailed variants retain the captured context and use separate cached results");

  await page.evaluate(() => { document.getElementById("definition").textContent += " Context changed: renewal now requires a new generation number."; });
  await pick();
  await page.locator("#tf-host .explainbtn").click();
  await waitResult("短い説明");
  assert.equal(stats.requests.length, 4);
  assert.match(stats.requests[3].body.messages[0].content, /new generation number/);
  await pick();
  await page.locator("#tf-host .selbtn").click();
  await waitResult("【lease】");
  assert.equal(stats.requests.length, 5);
  check("changed page evidence invalidates explanation cache; normal translation remains independent");

  await pick();
  assert.equal(await page.locator("#tf-host .questionbtn").isVisible(), true);
  await page.locator("#tf-host .questionbtn").click();
  assert.equal(stats.requests.length, 5);
  assert.equal(await page.locator("#tf-host .question-form").isVisible(), true);
  await page.locator("#tf-host .question-form button").click();
  assert.equal(stats.requests.length, 5);
  const question = "lease が切れた後、quorum は必要？";
  await page.locator("#tf-host .question-form textarea").fill(question);
  await page.locator("#tf-host .question-form button").click();
  await waitResult("質問への回答");
  assert.equal(stats.requests.length, 6);
  const asked = JSON.parse(stats.requests[5].body.messages[0].content);
  assert.equal(asked.selected_passage, "lease");
  assert.equal(asked.user_question, question);
  assert.match(JSON.stringify(asked.page), /time-limited ownership token/);
  assert.match(JSON.stringify(asked.page), /Quorum recovery requires three healthy workers/);
  assert.match(stats.requests[5].body.system[0].text, /Answer the user's question directly/);
  assert.match(await page.locator("#tf-host .question-asked").textContent(), /quorum は必要/);
  await page.locator("#tf-host .simple").click();
  await waitResult("質問への回答");
  assert.equal(stats.requests.length, 7);
  assert.equal(JSON.parse(stats.requests[6].body.messages[0].content).user_question, question);
  await page.locator("#tf-host .simple").click();
  await waitResult("質問への回答");
  assert.equal(stats.requests.length, 7);
  assert.equal(await page.locator("#tf-host .cost").textContent(), "cache");
  check("question form sends no request until submission; question, selection and page evidence are sent together and refinements keep the question");

  const budget = await page.evaluate(() => {
    const holder = document.createElement("section");
    for (let i = 0; i < 300; i++) { const p = document.createElement("p"); p.textContent = `lease ${i} ` + "related scheduler ownership text ".repeat(70); holder.append(p); }
    document.querySelector("main").append(holder);
    const range = document.createRange(); range.selectNodeContents(document.getElementById("term"));
    const c = TFContext.collect("lease", range);
    holder.remove();
    return { size: c.nearby.length + c.excerpts.reduce((n, e) => n + e.heading.length + e.text.length, 0), count: c.excerpts.length };
  });
  assert.ok(budget.size <= CONTEXT_LIMIT);
  assert.ok(budget.count <= 8);
  const normalized = normalizeExplanation({ selection: "x", context: { nearby: "x".repeat(50000), excerpts: Array.from({ length: 100 }, () => ({ heading: "h".repeat(500), text: "a".repeat(50000) })) } });
  assert.ok(normalized.context.nearby.length + normalized.context.excerpts.reduce((n, e) => n + e.heading.length + e.text.length, 0) <= CONTEXT_LIMIT);
  assert.throws(() => normalizeExplanation({ selection: "x".repeat(6001) }), /6,000/);
  check("both DOM extraction and background normalization enforce bounded context; oversized selections are rejected");

  await h.setSettings({ ...settings, cacheEnabled: false });
  stats.explanationDelay = 700;
  await pick();
  await page.locator("#tf-host .explainbtn").click();
  await page.waitForFunction(() => document.getElementById("tf-host").shadowRoot.querySelector(".panel .pb").classList.contains("wait"));
  await page.locator("#tf-host .x").click();
  await page.waitForTimeout(900);
  assert.equal(await page.locator("#tf-host .panel").isVisible(), false);
  stats.explanationDelay = 60;
  check("closing a pending explanation cancels it and prevents a late result reopening the panel");

  const options = await h.ctx.newPage();
  await options.goto(`chrome-extension://${h.extId}/options/options.html`);
  await options.waitForFunction(() => document.getElementById("model").options.length > 0);
  await options.locator("#explanationEnabled").locator("..").click();
  await options.locator("#save").click();
  await options.waitForSelector("#saved:not([hidden])");
  await pick();
  await page.waitForFunction(() => document.getElementById("tf-host").shadowRoot.querySelector(".explainbtn").hidden);
  assert.equal(await page.locator("#tf-host .explainbtn").isVisible(), false);
  assert.equal(await page.locator("#tf-host .questionbtn").isVisible(), false);
  assert.equal(await page.locator("#tf-host .selbtn").isVisible(), true);
  const disabled = await options.evaluate(() => chrome.runtime.sendMessage({ type: "explain", selection: "lease", context: {} }));
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /無効/);
  await options.locator("#explanationEnabled").locator("..").click();
  await options.locator("#save").click();
  await options.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "getSettings" })).settings.explanationEnabled === true);
  await page.waitForFunction(() => !document.getElementById("tf-host").shadowRoot.querySelector(".explainbtn").hidden);
  await page.reload(); await h.waitContent(tabId);
  await pick();
  assert.equal(await page.locator("#tf-host .explainbtn").isVisible(), true);
  assert.equal(await page.locator("#tf-host .questionbtn").isVisible(), true);
  check("settings persist, update the toolbar live, and prevent disabled explanations in the background");

  const bad = await options.evaluate(() => chrome.runtime.sendMessage({ type: "explain", selection: "x".repeat(6001), context: {} }));
  assert.equal(bad.ok, false);
  const longQuestion = await options.evaluate(() => chrome.runtime.sendMessage({ type: "explain", selection: "lease", question: "x".repeat(1001), context: {} }));
  assert.equal(longQuestion.ok, false);
  assert.match(longQuestion.error, /1,000/);
  const usage = (await h.msg(tabId, { type: "tf:state" })).usage;
  assert.ok(usage.costUsd >= 0);
  console.log("ALL EXPLANATION TESTS PASSED");
} finally {
  if (h) await h.close();
  server.close();
}
