// APIリクエストの再試行と、機能共通のセッション/中止管理。
import { describeHttpError } from "../shared/api.js";

const MAX_RETRY_AFTER_MS = 30000;
const inflight = new Map(); // sessionId -> Set<AbortController>

function track(sessionId, ctrl) {
  if (!sessionId) return;
  if (!inflight.has(sessionId)) inflight.set(sessionId, new Set());
  inflight.get(sessionId).add(ctrl);
}
function untrack(sessionId, ctrl) {
  const set = inflight.get(sessionId);
  if (!set) return;
  set.delete(ctrl);
  if (!set.size) inflight.delete(sessionId);
}
export function cancelSession(sessionId) {
  const set = inflight.get(sessionId);
  if (!set) return;
  for (const c of set) c.abort();
  inflight.delete(sessionId);
}

// 最初の await より前に登録し、設定/キャッシュの処理中の中止も受け取る。
// 複数バッチを同じセッションで並行実行でき、終了したリクエストだけを解除する。
export async function withSession(sessionId, operation, { timeoutMs = 0, timeoutMessage } = {}) {
  const ctrl = new AbortController();
  track(sessionId, ctrl);
  let timedOut = false;
  const timeout = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
  try {
    return await operation(ctrl.signal);
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timeout);
    untrack(sessionId, ctrl);
  }
}

export function fatalError(message) {
  const e = new Error(message);
  e.fatal = true;
  return e;
}

export function abortError() {
  const e = new Error("cancelled");
  e.cancelled = true;
  return e;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// 429 / 529 / 5xx / ネットワークエラーは待って再試行。それ以外は describeHttpError の内容で即エラー
export async function fetchWithRetry(req, signal, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw abortError();
    let res;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (e) {
      if (signal.aborted) throw abortError();
      lastErr = new Error(`ネットワークエラー: ${(e && e.message) || e}`);
      await sleep(1000 * attempt, signal);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非JSON */ }
    if (res.ok) {
      if (!json) throw new Error("API 応答が JSON ではありません");
      return json;
    }
    const d = describeHttpError(res.status, json);
    const err = new Error(d.message);
    err.fatal = !!d.fatal;
    err.status = res.status;
    if (!d.retry) throw err;
    lastErr = err;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : 1500 * attempt, signal);
  }
  throw lastErr || new Error("再試行上限に達しました");
}
