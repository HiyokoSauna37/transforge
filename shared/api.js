// Claude Messages API のリクエスト組み立て / レスポンス解釈（純粋モジュール・DOM/chrome 非依存）
import { modelInfo } from "./models.js";

export const API_VERSION = "2026-10-21";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// settings: {apiKey, apiBase, model, effort}
export function buildRequest(settings, systemPrompt, userText, { maxTokens = 16000 } = {}) {
  const info = modelInfo(settings.model);
  const headers = {
    "content-type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": API_VERSION,
    // 拡張のサービスワーカーからの直叩き（ブラウザ由来の Origin を持つ）に必要
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const body = {
    model: settings.model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
    output_config: { effort: settings.effort || "low" },
  };
  // thinking は省略 = adaptive（Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1 共通）。temperature 系は 2026-10-21 版で送信不可。
  if (info && info.fallbacks) {
    // 安全分類器による拒否時にサーバー側で別モデルへ再実行（Haiku 5.5 は非対応なので付けない）
    body.fallbacks = "default";
    headers["anthropic-beta"] = FALLBACK_BETA;
  }
  const base = (settings.apiBase || "https://api.anthropic.com").replace(/\/+$/, "");
  return { url: `${base}/v1/messages`, headers, body };
}

export function extractText(resp) {
  return (resp.content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export function usageOf(resp) {
  const u = (resp && resp.usage) || {};
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    model: (resp && resp.model) || null,
  };
}

// HTTP エラー → 人間向けメッセージ。fatal=true は再試行しても無駄なもの
export function describeHttpError(status, json) {
  const apiMsg = json && json.error && json.error.message ? json.error.message : "";
  const type = json && json.error && json.error.type ? json.error.type : "";
  if (status === 401) return { message: "APIキーが無効です（設定画面で確認してください）", fatal: true };
  if (status === 403) return { message: `権限エラー: ${apiMsg || "forbidden"}`, fatal: true };
  if (status === 400) return { message: `リクエストエラー: ${apiMsg || type || "bad request"}`, fatal: true };
  if (status === 404) return { message: `モデルまたはエンドポイントが見つかりません: ${apiMsg || ""}`, fatal: true };
  if (status === 429) return { message: "レート制限に達しました（しばらく待って再試行します）", fatal: false, retry: true };
  if (status === 529) return { message: "API が混雑しています（再試行します）", fatal: false, retry: true };
  if (status >= 500) return { message: `サーバーエラー ${status}: ${apiMsg || ""}`, fatal: false, retry: true };
  return { message: `HTTP ${status}: ${apiMsg || type || ""}`, fatal: status < 500 };
}

// stop_reason の確認。refusal は内容を読まずにエラー扱い
export function checkStop(resp) {
  const sr = resp && resp.stop_reason;
  if (sr === "refusal") {
    const cat = resp.stop_details && resp.stop_details.category;
    return { ok: false, message: `安全分類器により拒否されました${cat ? `（${cat}）` : ""}`, fatal: true };
  }
  if (sr === "max_tokens") return { ok: true, truncated: true };
  return { ok: true };
}
