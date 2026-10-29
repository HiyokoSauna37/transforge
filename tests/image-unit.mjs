import assert from "node:assert/strict";
import { IMAGE_MAX_BYTES, IMAGE_SOURCE_TYPES, normalizeImage, normalizeImageRequest, imageSenderAllowed, buildImageSystem, buildImageMessage, imageOutputFormat, parseImageResult, imageFetchUrl, fetchRemoteImage } from "../shared/image.js";

const check = (name) => console.log(`✓ ${name}`);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rXQAAAAASUVORK5CYII=";
const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
const svg = '<?xml version="1.0"?><!-- test --><svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="25">Hello</text></svg>';
const svgBytes = new TextEncoder().encode(svg);
const svgImage = { data: Buffer.from(svgBytes).toString("base64"), mediaType: "image/svg+xml" };
const rasterImage = { data: png, mediaType: "image/png", width: 1, height: 1 };
const input = { image: rasterImage, context: { title: "Example", url: "https://example.com/page?token=private#part" } };
assert.deepEqual(normalizeImage(input.image), input.image);
for (const value of ["", "data:image/png;base64,"+png, png+"\n", "%%%===", "AB=="]) assert.throws(() => normalizeImage({ mediaType: "image/png", data: value }));
assert.throws(() => normalizeImage({ ...rasterImage, mediaType: "image/jpeg" }), /一致/);
assert.throws(() => normalizeImage({ ...rasterImage, data: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'), mediaType: "image/svg+xml" }), /形式/);
assert.throws(() => normalizeImage({ data: png, mediaType: "image/png", width: 0, height: 1 }), /寸法/);
assert.ok(IMAGE_SOURCE_TYPES.includes("image/svg+xml"));
const tooBig = new Uint8Array(IMAGE_MAX_BYTES+1); tooBig.set(bytes.subarray(0,8));
assert.throws(() => normalizeImage({ mediaType: "image/png", data: Buffer.from(tooBig).toString("base64"), width: 1, height: 1 }), /5MB/);
check("API image input stays raster-only while fetched source formats include SVG for client-side conversion");

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
assert.match(system, /bounding box/);
assert.match(system, /empty regions array/);
assert.match(system, /リース/);
assert.notEqual(system, buildImageSystem({ ...settings, targetLang: "English" }));
assert.deepEqual(JSON.parse(buildImageMessage(normalized, settings)), { task: "translate_image_in_place", target_language: "日本語", image: { width: 1, height: 1 }, page: normalized.context });
assert.equal(imageOutputFormat().schema.properties.regions.items.additionalProperties, false);
const resultImage = { width: 400, height: 200 };
const region = { original: "Hello", translation: "こんにちは", box: [10.2, 20.4, 180.1, 50.2], rotation: 0, align: "center", weight: "bold" };
assert.deepEqual(parseImageResult(JSON.stringify({ regions: [region] }), resultImage), { regions: [{ ...region, box: [10, 20, 180, 51] }] });
assert.deepEqual(parseImageResult('{"regions":[]}', resultImage), { regions: [] });
for (const text of ['{}','[]','null','{"regions":{}}','{"regions":[{"original":"x"}]}','{"regions":[],"extra":true}']) assert.throws(() => parseImageResult(text, resultImage));
assert.throws(() => parseImageResult(JSON.stringify({ regions: [{ ...region, box: [10, 20, -1, 20] }] }), resultImage), /文字位置/);
assert.throws(() => parseImageResult(JSON.stringify({ regions: [{ ...region, align: "justify" }] }), resultImage), /文字位置/);
check("OCR prompts and responses bind translations to validated pixel boxes for in-image rendering");

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
  assert.deepEqual(await fetchRemoteImage("https://images.example.com/a.png"), { data: png, mediaType: "image/png" });
  globalThis.fetch = async () => new Response(svgBytes, { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
  assert.deepEqual(await fetchRemoteImage("https://images.example.com/a.svg"), svgImage);
  await assert.rejects(fetchRemoteImage("http://localhost/a.png"), /ローカル/);
  assert.equal(calls, 1);
  check("remote image retrieval accepts verified SVG while omitting credentials/referrer and rejecting local URLs");

  let responseAborted = false;
  globalThis.fetch = async (_url, options) => {
    options.signal.addEventListener("abort", () => { responseAborted = true; });
    return new Response("not an image", { headers: { "content-type": "text/html" } });
  };
  await assert.rejects(fetchRemoteImage("https://images.example.com/a.png"), /だけ翻訳/);
  assert.equal(responseAborted, true);
  globalThis.fetch = async () => new Response(bytes, { headers: { "content-type": "image/jpeg" } });
  await assert.rejects(fetchRemoteImage("https://images.example.com/a.png"), /一致/);
  globalThis.fetch = async () => new Response(new TextEncoder().encode("<html>not svg</html>"), { headers: { "content-type": "image/svg+xml" } });
  await assert.rejects(fetchRemoteImage("https://images.example.com/a.svg"), /一致/);
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
