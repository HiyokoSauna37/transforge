// 実 API への小さな検証: 拡張と同じリクエストを Node から送り、Camel AS2 ページの実セグメントを翻訳して表示する
// usage: ANTHROPIC_API_KEY=... node tests/real_api_check.mjs [model]
import { buildRequest, extractText, usageOf, describeHttpError, checkStop } from "../shared/api.js";
import { buildSystemPrompt, buildUserMessage, parseSegments } from "../shared/prompt.js";
import { DEFAULTS, estimateCostUsd } from "../shared/models.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("ANTHROPIC_API_KEY が未設定"); process.exit(2); }
const model = process.argv[2] || DEFAULTS.model;
const s = { ...DEFAULTS, apiKey, model };

// Camel AS2 ページから抜いた実セグメント（segmenter の直列化結果と同じ形式）
const segments = [
  { id: 0, text: "Component Options" },
  { id: 1, text: "<i0/> <i1/><i2>bridgeErrorHandler</i2> (consumer)" },
  { id: 2, text: "Allows for bridging the consumer to the Camel routing Error Handler, which mean any exceptions (if possible) occurred while the Camel consumer is trying to pickup incoming messages, or the likes, will now be processed as a message and handled by the routing Error Handler. Important: This is only possible if the 3rd party component allows Camel to be alerted if an exception was thrown. Some components handle this internally only, and therefore bridgeErrorHandler is not possible. In other situations we may improve the Camel component to hook into the 3rd party component and make this possible for future releases. By default the consumer will use the org.apache.camel.spi.ExceptionHandler to deal with exceptions, that will be logged at WARN or ERROR level and ignored." },
  { id: 3, text: "false" },
  { id: 4, text: "String" },
  { id: 5, text: "Whether the producer should be started lazy (on the first message). By starting lazy you can use this to allow CamelContext and routes to startup in situations where a producer may otherwise fail during starting and cause the route to fail being started." },
  { id: 6, text: "The AS2 component provides transport of EDI messages using the HTTP transfer protocol as specified in <i0>RFC4130</i0>." },
  { id: 7, text: "Maven users will need to add the following dependency to their <i0/> for this component:" },
  { id: 8, text: "See <i0>the documentation</i0> for <i1>details</i1> before you <i2>configure the endpoint</i2>." },
  { id: 9, text: "Name" },
  { id: 10, text: "Default" },
  { id: 11, text: "Type" },
];

const req = buildRequest(s, buildSystemPrompt(s), buildUserMessage(segments, { title: "AS2 :: Apache Camel", url: "https://camel.apache.org/components/4.22.x/as2-component.html" }));
console.log(`POST ${req.url} model=${model} effort=${s.effort} beta=${req.headers["anthropic-beta"] || "-"}`);
const t0 = Date.now();
const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
const json = await res.json().catch(() => null);
if (!res.ok) { console.error("HTTP", res.status, describeHttpError(res.status, json).message, JSON.stringify(json)); process.exit(1); }
const stop = checkStop(json);
if (!stop.ok) { console.error(stop.message); process.exit(1); }
const text = extractText(json);
const parsed = parseSegments(text);
const u = usageOf(json);
console.log(`${Date.now() - t0}ms  stop=${json.stop_reason}  in=${u.input} cacheW=${u.cacheWrite} cacheR=${u.cacheRead} out=${u.output}  cost=$${estimateCostUsd(model, u).toFixed(4)}  served_by=${json.model}\n`);
let missing = 0;
for (const seg of segments) {
  const t = parsed[seg.id];
  if (t == null) missing++;
  console.log(`#${seg.id}  ${seg.text.slice(0, 70)}${seg.text.length > 70 ? "…" : ""}\n    → ${t == null ? "(MISSING)" : t}`);
}
if (missing) { console.error(`\n${missing} segment(s) missing. raw:\n${text}`); process.exit(1); }
console.log("\nOK");
