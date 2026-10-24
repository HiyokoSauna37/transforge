// 翻訳キャッシュ（IndexedDB・service worker 用）
const DB_NAME = "transforge";
const STORE = "cache";
const MAX_ENTRIES = 20000;
const PRUNE_TO = 15000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: "k" });
      store.createIndex("ts", "ts");
    };
    req.onsuccess = () => {
      const db = req.result;
      // 別タブ/テストからの deleteDatabase やサイトデータ削除で接続を手放す
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 複数キーを 1 トランザクションで読む → Map<key, value>
export async function cacheGetMany(keys) {
  const out = new Map();
  if (!keys.length) return out;
  try {
    const store = await tx("readonly");
    await Promise.all(keys.map((k) => wrap(store.get(k)).then((row) => { if (row) out.set(k, row.t); })));
  } catch {
    /* ignore */
  }
  return out;
}

// 複数エントリを 1 トランザクションで書く
export async function cacheSetMany(entries) {
  if (!entries.length) return;
  try {
    const store = await tx("readwrite");
    const ts = Date.now();
    await Promise.all(entries.map(({ k, t }) => wrap(store.put({ k, t, ts }))));
  } catch {
    /* ignore */
  }
}

export async function cacheCount() {
  try {
    const store = await tx("readonly");
    return await wrap(store.count());
  } catch {
    return 0;
  }
}

export async function cacheClear() {
  const store = await tx("readwrite");
  await wrap(store.clear());
}

// 古いものから削って上限内に収める
export async function cachePrune() {
  try {
    const n = await cacheCount();
    if (n <= MAX_ENTRIES) return 0;
    const store = await tx("readwrite");
    const idx = store.index("ts");
    let toDelete = n - PRUNE_TO;
    let deleted = 0;
    await new Promise((resolve, reject) => {
      const cur = idx.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || toDelete <= 0) return resolve();
        c.delete();
        deleted++;
        toDelete--;
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    return deleted;
  } catch {
    return 0;
  }
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
