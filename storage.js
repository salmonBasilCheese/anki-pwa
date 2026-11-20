"use strict";

// ---------------------------------------------------------------
// IndexedDB の薄いラッパー。グローバル `DeckStore` として公開する。
//
// ストア構成 (DB "anki-pwa" version 1)
//   decks        key: id(文字列)          {id, name, cardCount, size, addedAt, lastOpenedAt}
//   deckFiles    key: deckId              {deckId, blob}   .apkg の Blob そのまま
//   progress     key: deckId              {deckId, lastIndex, updatedAt}
//   cardRecords  key: [deckId, cardId]    次ミッション用(カードごとの学習記録)。今は空。
//                                         レコードは {deckId, cardId, ...学習記録} の形にする
//
// 一覧取得で大きい Blob を読まないよう、decks と deckFiles は分けてある。
// ---------------------------------------------------------------
const DeckStore = (() => {
  const DB_NAME = "anki-pwa";
  const DB_VERSION = 1;
  const ALL_STORES = ["decks", "deckFiles", "progress", "cardRecords"];

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("decks")) {
          db.createObjectStore("decks", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("deckFiles")) {
          db.createObjectStore("deckFiles", { keyPath: "deckId" });
        }
        if (!db.objectStoreNames.contains("progress")) {
          db.createObjectStore("progress", { keyPath: "deckId" });
        }
        if (!db.objectStoreNames.contains("cardRecords")) {
          const s = db.createObjectStore("cardRecords", { keyPath: ["deckId", "cardId"] });
          s.createIndex("byDeck", "deckId");
          // 復習日の index([deckId, due] など)は、次ミッションで version 2 として追加する
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error("他のタブがデータベースを使用中です")); };
    });
    return dbPromise;
  }

  const reqToPromise = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

  // 1トランザクションで fn を実行する。完了(commit)してから結果を返す。
  // fn の中で待ってよいのは IndexedDB のリクエストだけ(他を待つとトランザクションが閉じる)。
  async function run(storeNames, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new DOMException("中断されました", "AbortError"));
      const stores = Object.fromEntries(storeNames.map((n) => [n, tx.objectStore(n)]));
      Promise.resolve(fn(stores)).then(
        (r) => { result = r; },
        (e) => { try { tx.abort(); } catch { /* 既に終了 */ } reject(e); }
      );
    });
  }

  // デッキに紐づくデータを全て消す(呼び出し側のトランザクション内で使う)
  async function deleteAllOf(stores, id) {
    stores.decks.delete(id);
    stores.deckFiles.delete(id);
    stores.progress.delete(id);
    stores.cardRecords.delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
  }

  // -------------------------------------------------------------
  // 公開API
  // -------------------------------------------------------------

  // 保存データを勝手に消されにくくする。拒否・未対応でも保存自体は動く。
  async function requestPersistence() {
    if (!navigator.storage?.persist) return { supported: false, persisted: false };
    let persisted = await navigator.storage.persisted();
    if (!persisted) persisted = await navigator.storage.persist();
    return { supported: true, persisted };
  }

  // 保存済みデッキの一覧(Blob は読まない)。lastIndex は未学習なら null。
  async function listDecks() {
    const [decks, progress] = await run(["decks", "progress"], "readonly", (s) =>
      Promise.all([reqToPromise(s.decks.getAll()), reqToPromise(s.progress.getAll())])
    );
    const lastIndexById = new Map(progress.map((p) => [p.deckId, p.lastIndex]));
    return decks
      .map((d) => ({ ...d, lastIndex: lastIndexById.get(d.id) ?? null }))
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  // id が同じ、または名前が同じ保存済みデッキ(複数ありうる)
  async function findDuplicates({ id, name }) {
    const decks = await run(["decks"], "readonly", (s) => reqToPromise(s.decks.getAll()));
    return decks.filter((d) => d.id === id || d.name === name);
  }

  // デッキを保存する。replaceIds に入れた既存デッキは同じトランザクション内で置き換える。
  //  - id が同じ既存デッキ: 進み具合と cardRecords を引き継ぐ(位置はカード数に丸める)
  //  - id が違う既存デッキ(名前だけ一致): 全データを削除し、新規として扱う
  // 途中で失敗(容量不足など)したら全体がロールバックされる。
  async function saveDeck(meta, blob, { replaceIds = [] } = {}) {
    const now = Date.now();
    await run(ALL_STORES, "readwrite", async (s) => {
      const existing = await reqToPromise(s.decks.get(meta.id));

      for (const oldId of replaceIds) {
        if (oldId !== meta.id) await deleteAllOf(s, oldId);
      }

      s.decks.put({
        id: meta.id,
        name: meta.name,
        cardCount: meta.cardCount,
        size: blob.size,
        addedAt: existing?.addedAt ?? now,
        lastOpenedAt: now,
      });
      s.deckFiles.put({ deckId: meta.id, blob });

      if (existing) {
        const p = await reqToPromise(s.progress.get(meta.id));
        if (p && p.lastIndex > meta.cardCount - 1) {
          s.progress.put({ ...p, lastIndex: Math.max(0, meta.cardCount - 1), updatedAt: now });
        }
      }
    });
  }

  async function getDeckBlob(id) {
    const rec = await run(["deckFiles"], "readonly", (s) => reqToPromise(s.deckFiles.get(id)));
    return rec?.blob ?? null;
  }

  async function touchDeck(id) {
    await run(["decks"], "readwrite", async (s) => {
      const d = await reqToPromise(s.decks.get(id));
      if (d) s.decks.put({ ...d, lastOpenedAt: Date.now() });
    });
  }

  async function getLastIndex(id) {
    const p = await run(["progress"], "readonly", (s) => reqToPromise(s.progress.get(id)));
    return p?.lastIndex ?? null;
  }

  async function setLastIndex(id, lastIndex) {
    await run(["progress"], "readwrite", (s) => {
      s.progress.put({ deckId: id, lastIndex, updatedAt: Date.now() });
    });
  }

  // デッキと、その進み具合・学習記録を全て削除する(1トランザクション)
  async function deleteDeck(id) {
    await run(ALL_STORES, "readwrite", (s) => deleteAllOf(s, id));
  }

  return {
    requestPersistence, listDecks, findDuplicates, saveDeck,
    getDeckBlob, touchDeck, getLastIndex, setLastIndex, deleteDeck,
  };
})();
