"use strict";

// ---------------------------------------------------------------
// IndexedDB の薄いラッパー。グローバル `DeckStore` として公開する。
//
// ストア構成 (DB "anki-pwa" version 1)
//   decks        key: id(文字列)          {id, name, cardCount, size, addedAt, lastOpenedAt}
//   deckFiles    key: deckId              {deckId, blob}   .apkg の Blob そのまま
//   progress     key: deckId              旧「最後に見た位置」。復習画面では使わない(残してあるだけ)
//   cardRecords  key: [deckId, cardId]    カードごとの FSRS の状態(srs.js の record)。
//                                         記録が無いカード = 新規
//   reviewLogs   key: 自動採番            回答の履歴(いつ・どのボタン)。deckId, cardId, rating, review(ms) ...
//
// decks のレコードには、デッキごとの設定 newPerDay(新規の1日の上限)が入ることがある。
// 一覧取得で大きい Blob を読まないよう、decks と deckFiles は分けてある。
//
// version 2: reviewLogs を追加(1 → 2 では既存データはそのまま残る)
// ---------------------------------------------------------------
const DeckStore = (() => {
  const DB_NAME = "anki-pwa";
  const DB_VERSION = 2;
  const ALL_STORES = ["decks", "deckFiles", "progress", "cardRecords", "reviewLogs"];

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
        }
        if (!db.objectStoreNames.contains("reviewLogs")) {
          const s = db.createObjectStore("reviewLogs", { keyPath: "id", autoIncrement: true });
          s.createIndex("byDeck", "deckId");
          s.createIndex("byDeckTime", ["deckId", "review"]);
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
    const logKeys = await reqToPromise(stores.reviewLogs.index("byDeck").getAllKeys(IDBKeyRange.only(id)));
    for (const k of logKeys) stores.reviewLogs.delete(k);
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

  // 保存済みデッキの一覧(Blob は読まない)。learnedCount = 学習記録のあるカード数。
  async function listDecks() {
    return run(["decks", "cardRecords"], "readonly", async (s) => {
      const decks = await reqToPromise(s.decks.getAll());
      const byDeck = s.cardRecords.index("byDeck");
      const counts = await Promise.all(
        decks.map((d) => reqToPromise(byDeck.count(IDBKeyRange.only(d.id))))
      );
      return decks
        .map((d, i) => ({ ...d, learnedCount: counts[i] }))
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    });
  }

  // id が同じ、または名前が同じ保存済みデッキ(複数ありうる)
  async function findDuplicates({ id, name }) {
    const decks = await run(["decks"], "readonly", (s) => reqToPromise(s.decks.getAll()));
    return decks.filter((d) => d.id === id || d.name === name);
  }

  // デッキを保存する。replaceIds に入れた既存デッキは同じトランザクション内で置き換える。
  //  - id が同じ既存デッキ: 学習記録・回答履歴・新規の上限設定を引き継ぐ
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
        ...(existing?.newPerDay != null && { newPerDay: existing.newPerDay }),
      });
      s.deckFiles.put({ deckId: meta.id, blob });
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

  // 新規カードの1日の上限(未設定なら null)
  async function getNewPerDay(id) {
    const d = await run(["decks"], "readonly", (s) => reqToPromise(s.decks.get(id)));
    return d?.newPerDay ?? null;
  }

  async function setNewPerDay(id, n) {
    await run(["decks"], "readwrite", async (s) => {
      const d = await reqToPromise(s.decks.get(id));
      if (d) s.decks.put({ ...d, newPerDay: n });
    });
  }

  // デッキの全カードの学習記録
  async function getCardRecords(deckId) {
    return run(["cardRecords"], "readonly", (s) =>
      reqToPromise(s.cardRecords.index("byDeck").getAll(IDBKeyRange.only(deckId)))
    );
  }

  // 回答を保存する: 学習記録の更新と回答履歴の追加を 1 トランザクションで行う
  async function saveReview(deckId, record, log) {
    await run(["cardRecords", "reviewLogs"], "readwrite", (s) => {
      s.cardRecords.put({ ...record, deckId });
      s.reviewLogs.add({ ...log, deckId });
    });
  }

  // [fromMs, toMs) に導入(初回回答)された新規カードの数
  async function countNewSince(deckId, fromMs, toMs) {
    const logs = await run(["reviewLogs"], "readonly", (s) =>
      reqToPromise(
        s.reviewLogs.index("byDeckTime").getAll(IDBKeyRange.bound([deckId, fromMs], [deckId, toMs], false, true))
      )
    );
    return logs.filter((l) => l.state === 0).length; // state 0 = 回答前が New
  }

  // デッキと、その進み具合・学習記録を全て削除する(1トランザクション)
  async function deleteDeck(id) {
    await run(ALL_STORES, "readwrite", (s) => deleteAllOf(s, id));
  }

  return {
    requestPersistence, listDecks, findDuplicates, saveDeck,
    getDeckBlob, touchDeck, deleteDeck,
    getNewPerDay, setNewPerDay, getCardRecords, saveReview, countNewSince,
  };
})();
