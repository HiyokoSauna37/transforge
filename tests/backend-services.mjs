// 共通セッション管理が、準備中の中止・並列バッチ・タイムアウトを維持することを確認する。
import assert from "node:assert/strict";
import { abortError, cancelSession, withSession } from "../background/requests.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const settings = deferred();
let requested = false;
const pending = withSession("preparing", async (signal) => {
  await settings.promise;
  if (signal.aborted) throw abortError();
  requested = true;
});
cancelSession("preparing");
settings.resolve();
await assert.rejects(pending, (error) => error.message === "cancelled" && error.cancelled === true);
assert.equal(requested, false);
console.log("✓ cancellation before preparation finishes prevents later API work");

const batch = deferred();
let activeSignal;
let otherSignal;
const finished = withSession("batch", () => "first batch");
const active = withSession("batch", async (signal) => {
  activeSignal = signal;
  await batch.promise;
  if (signal.aborted) throw abortError();
});
const other = withSession("other", async (signal) => {
  otherSignal = signal;
  await batch.promise;
  return "other session";
});
assert.equal(await finished, "first batch");
cancelSession("batch");
assert.equal(activeSignal.aborted, true);
assert.equal(otherSignal.aborted, false);
batch.resolve();
await assert.rejects(active, /cancelled/);
assert.equal(await other, "other session");
console.log("✓ completed batches do not unregister active siblings or cancel other sessions");

let failedSignal;
await assert.rejects(withSession("failed", (signal) => {
  failedSignal = signal;
  throw new Error("validation failed");
}), /validation failed/);
cancelSession("failed");
assert.equal(failedSignal.aborted, false);

let completedSignal;
assert.equal(await withSession("complete", (signal) => {
  completedSignal = signal;
  return "done";
}, { timeoutMs: 5, timeoutMessage: "unexpected timeout" }), "done");
cancelSession("complete");
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(completedSignal.aborted, false);
console.log("✓ success and validation failures both remove session registrations and timers");

await assert.rejects(withSession("timeout", (signal) => new Promise((resolve, reject) => {
  signal.addEventListener("abort", () => reject(abortError()), { once: true });
}), { timeoutMs: 5, timeoutMessage: "字幕の翻訳がタイムアウトしました" }), /字幕の翻訳がタイムアウトしました/);
assert.equal(await withSession("timeout", () => "restarted"), "restarted");
console.log("✓ timeouts keep the feature-specific error and allow the next request to run");
