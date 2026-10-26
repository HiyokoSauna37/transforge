// chrome.storage.local に保存する設定（既定値とのマージ）
import { DEFAULTS, SETTINGS_SCHEMA } from "./models.js";

const KEY = "settings";
let pending = Promise.resolve();

// ページ翻訳・字幕・解説が並行しても使用量や設定のread-modify-writeを上書きしない。
function serialize(operation) {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

async function readSettings() {
  const got = await chrome.storage.local.get(KEY);
  const s = got[KEY] || {};
  if (Object.keys(s).length && (s.schema || 1) < SETTINGS_SCHEMA) await migrate(s);
  return { ...DEFAULTS, ...s, usage: { ...DEFAULTS.usage, ...(s.usage || {}) } };
}

export function getSettings() {
  return serialize(readSettings);
}

// 保存済み設定の一度きりの追従。明示的に選んだ値は触らず、旧既定のまま残っているものだけ新既定へ寄せる
async function migrate(s) {
  const from = s.schema || 1;
  if (from < 2 && (!s.model || s.model === "claude-opus-5-5")) s.model = DEFAULTS.model;  // 旧既定 Opus → Sonnet
  s.schema = SETTINGS_SCHEMA;
  await chrome.storage.local.set({ [KEY]: s });
}

export function saveSettings(partial) {
  return serialize(async () => {
    const cur = await readSettings();
    const next = { ...cur, ...partial };
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  });
}

export function addUsage(delta) {
  return serialize(async () => {
    const cur = await readSettings();
    const u = cur.usage;
    const next = {
      input: u.input + (delta.input || 0),
      output: u.output + (delta.output || 0),
      costUsd: u.costUsd + (delta.costUsd || 0),
      requests: u.requests + 1,
    };
    await chrome.storage.local.set({ [KEY]: { ...cur, usage: next } });
    return next;
  });
}

export async function resetUsage() {
  return saveSettings({ usage: { ...DEFAULTS.usage } });
}
