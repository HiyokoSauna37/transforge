// テスト用: fixture 配信 + Claude Messages API のモック（/v1/messages）
// 訳文 = 各テキスト片を【…】で包む。トップレベルにマーカーが2つ以上ある segment は順序を反転して
// 「語順が変わっても DOM を正しく組み直せるか」を検証する。
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixture");

export const stats = { requests: [], errorsRemaining: 0, explanationDelay: 60 };

function parseTree(str) {
  const re = /<\s*(\/?)\s*i(\d+)\s*(\/?)\s*>/g;
  const root = { children: [] };
  const stack = [root];
  let last = 0;
  let m;
  while ((m = re.exec(str))) {
    const t = str.slice(last, m.index);
    if (t) stack[stack.length - 1].children.push({ type: "text", value: t });
    last = re.lastIndex;
    if (m[1]) { stack.pop(); continue; }
    const node = { type: "el", idx: Number(m[2]), self: !!m[3], children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[3]) stack.push(node);
  }
  const t = str.slice(last);
  if (t) root.children.push({ type: "text", value: t });
  return root.children;
}

function ser(children) {
  return children
    .map((c) => {
      if (c.type === "text") return c.value.trim() ? `【${c.value.trim()}】` : c.value;
      if (c.self) return `<i${c.idx}/>`;
      return `<i${c.idx}>${ser(c.children)}</i${c.idx}>`;
    })
    .join("");
}

export function mockTranslate(segText) {
  const tree = parseTree(segText);
  const els = tree.filter((c) => c.type === "el");
  if (els.length >= 2) {
    // トップレベル要素の順序を反転（テキストはそのまま位置に残す）
    const rev = els.slice().reverse();
    let k = 0;
    for (let i = 0; i < tree.length; i++) if (tree[i].type === "el") tree[i] = rev[k++];
  }
  return ser(tree);
}

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET") {
      if (url.pathname === "/__stats") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(stats));
      }
      const f = join(FIXTURE, url.pathname.replace(/^\/+/, ""));
      if (url.pathname.endsWith(".html") && existsSync(f)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(f));
      }
      res.writeHead(404);
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let json;
        try { json = JSON.parse(body); } catch { res.writeHead(400); return res.end("bad json"); }
        stats.requests.push({ headers: req.headers, body: json, t: Date.now() });
        if (req.headers["x-api-key"] === "bad") {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        }
        if (stats.errorsRemaining > 0) {
          stats.errorsRemaining--;
          res.writeHead(529, { "content-type": "application/json" });
          return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        }
        const user = json.messages[0].content;
        let explanation = null;
        try {
          const payload = JSON.parse(user);
          if (typeof payload.selected_passage === "string" && payload.page) explanation = payload;
        } catch { /* 通常の翻訳メッセージ */ }
        const re = /<seg id="(\d+)">([\s\S]*?)<\/seg>/g;
        const out = [];
        let m;
        while ((m = re.exec(user))) out.push(`<seg id="${m[1]}">${mockTranslate(m[2])}</seg>`);
        const detail = json.system[0].text.includes("everyday words") ? "やさしい説明" : json.system[0].text.includes("mechanism, assumptions") ? "詳しい説明" : "短い説明";
        const text = explanation
          ? `ひとことで\n「${explanation.selected_passage}」の${detail}です。\n\nこのページでは\n${explanation.page.heading || explanation.page.title}\n\n具体例\nページ内の定義と用例を参考にします。${explanation.page.excerpts.length ? " [1]" : ""}`
          : out.join("\n");
        const resp = {
          id: "msg_mock", type: "message", role: "assistant", model: json.model,
          content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text }],
          stop_reason: "end_turn", stop_details: null,
          usage: { input_tokens: Math.ceil(user.length / 4), output_tokens: Math.ceil(text.length / 2), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(resp));
        }, explanation ? stats.explanationDelay : 60);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

if (process.argv[1] && process.argv[1].endsWith("mock_server.mjs") && process.argv.includes("--serve")) {
  startServer(8787).then(({ port }) => console.log(`mock on http://127.0.0.1:${port}`));
}
