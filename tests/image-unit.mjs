import assert from "node:assert/strict";
import { IMAGE_MAX_BYTES, normalizeImage, normalizeImageRequest, imageSenderAllowed, buildImageSystem, buildImageMessage, parseImageResult, imageFetchUrl, fetchRemoteImage } from "../shared/image.js";

const check = (name) => console.log(`✓ ${name}`);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rXQAAAAASUVORK5CYII=";
const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
const input = { image: { data: png, mediaType: "image/png" }, context: { title: "Example", url: "https://example.com/page?token=private#part" } };
assert.deepEqual(normalizeImage(input.image), input.image);
for (const value of ["", "data:image/png;base64,"+png, png+"\n", "%%%===", "AB=="]) assert.throws(() => normalizeImage({ mediaType: "image/png", data: value }));
assert.throws(() => normalizeImage({ data: png, mediaType: "image/jpeg" }), /一致/);
assert.throws(() => normalizeImage({ data: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'), mediaType: "image/svg+xml" }), /形式/);
const tooBig = new Uint8Array(IMAGE_MAX_BYTES+1); tooBig.set(bytes.subarray(0,8));
assert.throws(() => normalizeImage({ mediaType: "image/png", data: Buffer.from(tooBig).toString("base64") }), /5MB/);
check("image input enforces canonical base64, a 5MB decoded limit, allowed raster MIME types and matching file signatures");

const normalized = normalizeImageRequest(input);
assert.equal(normalized.context.url, "https://example.com/page");
assert.equal(normalized.context.title, "Example");
assert.throws(() => normalizeImageRequest({ ...input, context: { title: "a".repeat(301) } }), /ページ情報/);
assert.equal(imageSenderAllowed({ tab: { id: 3 }, frameId: 0, url: "https://example.com/" }), true);
assert.equal(imageSenderAllowed({ tab: { id: 3 }, frameId: 1, url: "https://example.com/" }), false);
assert.equal(imageSenderAllowed({ tab: { id: 3 }, frameId: 0, url: "file:///tmp/image.png" }), false);
assert.equal(imageSenderAllowed({ frameId: 0, url: "https://example.com/" }), false);
check("image requests require a web page top frame and remove irrelevant query, hash and credentials from page context");

const settings = { targetLang: "日本語", customInstructions: "簡潔に", glossary: "lease = リース" };
const system = buildImageSystem(settings);
assert.match(system, /untrusted source material/);
assert.match(system, /Do not guess blurry/);
assert.match(system, /exactly these two string fields/);
assert.match(system, /リース/);
assert.notEqual(system, buildImageSystem({ ...settings, targetLang: "English" }));
assert.deepEqual(JSON.parse(buildImageMessage(normalized, settings)), { task: "translate_image", target_language: "日本語", page: normalized.context });
assert.deepEqual(parseImageResult('{"original":"Hello","translation":"こんにちは"}'), { original: "Hello", text: "こんにちは" });
assert.deepEqual(parseImageResult('{"original":"","translation":"読み取れる文字がありません。"}'), { original: "", text: "読み取れる文字がありません。" });
for (const text of ['{}','[]','null','{"original":"x"}','{"original":1,"translation":"x"}','{"original":"x","translation":" "}','{"original":"x","translation":"y","extra":true}']) assert.throws(() => parseImageResult(text));
assert.throws(() => parseImageResult(JSON.stringify({ original: "x".repeat(24001), translation: "y" })));
check("OCR prompts preserve readable text, reject image instructions and require bounded original/translation JSON responses");

assert.equal(imageFetchUrl("https://images.example.com/a.png#fragment").href, "https://images.example.com/a.png");
for (const url of ["file:///image.png", "data:image/png;base64,"+png, "http://localhost/a.png", "http://localhost./a.png", "http://127.0.0.1/a.png", "http://2130706433/a.png", "http://0x7f000001/a.png", "http://10.0.0.2/a.png", "http://[::1]/a.png", "http://router/a.png", "https://nas.local/a.png", "https://images.example.test/a.png", "https://user:password@example.com/a.png"]) assert.throws(() => imageFetchUrl(url));
check("remote image URLs reject non-web schemes, credentials, local names and alternate IP literal spellings");

const savedFetch = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://images.example.com/a.png");
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(options.redirect, "error");
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  };
  assert.deepEqual(await fetchRemoteImage("https://images.example.com/a.png"), input.image);
  await assert.rejects(fetchRemoteImage("http://localhost/a.png"), /ローカル/);
  assert.equal(calls, 1);
  check("remote image retrieval omits credentials/referrer, forbids redirects and never fetches rejected local URLs");

  let responseAborted = false;
  globalThis.fetch = async (_url, options) => {
    options.signal.addEventListener("abort", () => { responseAborted = true; });
    return new Response("not an image", { headers: { "content-type": "text/html" } });
  };
  await assert.rejects(fetchRemoteImage("https://images.example.com/a.png"), /だけ翻訳/);
  assert.equal(responseAborted, true);
  globalThis.fetch = async () => new Response(bytes, { headers: { "content-type": "image/jpeg" } });
  await assert.rejects(fetchRemoteImage("https://images.example.com/a.png"), /一致/);
  globalThis.fetch = async () => new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(IMAGE_MAX_BYTES+1) } });
  await assert.rejects(fetchRemoteImage("https://images.example.com/a.png"), /5MB/);
  let canceled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(tooBig); }, cancel() { canceled = true; },
  }), { headers: { "content-type": "image/png" } });
  await assert.rejects(fetchRemoteImage("https://images.example.com/a.png"), /5MB/);
  assert.equal(canceled, true);
  check("remote retrieval stops unsupported responses and enforces byte limits even without a Content-Length header");

  const controller = new AbortController();
  let fetchStarted = false;
  globalThis.fetch = async (_url, options) => {
    fetchStarted = true;
    return await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const pending = fetchRemoteImage("https://images.example.com/a.png", controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(fetchStarted, true);
  fetchStarted = false;
  await assert.rejects(fetchRemoteImage("https://images.example.com/a.png", controller.signal), /cancelled/);
  assert.equal(fetchStarted, false);
  check("image downloads honor cancellation both before and during a fetch");
} finally { globalThis.fetch = savedFetch; }
