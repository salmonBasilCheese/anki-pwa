// 保存データ(storage.js)の移行のテスト。使い方: (cd tools && npm ci) のあと node tools/check_storage.mjs
// 本物の IndexedDB の代わりに fake-indexeddb を使う(tools/package.json。公開サイトには入らない)。
//
// 「更新前の安定版」は tools/fixtures/storage_v2.js(DB v2 のときの storage.js をそのまま固定したもの)。
// それで実際の使い方どおりにデータを作り、今の storage.js で開いて、記録が欠けずに引き継がれるかを調べる。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(root, f), "utf8");

// ブラウザで <script> を並べたのと同じように、1 つの環境にファイルを読み込む
function load(factory, files, pathname = "/anki-pwa/") {
  const ctx = vm.createContext({
    indexedDB: factory, IDBKeyRange, location: { pathname }, console, DOMException, structuredClone,
    FSRS: { State: { New: 0, Learning: 1, Review: 2, Relearning: 3 } },
  });
  for (const f of files) vm.runInContext(src(f), ctx, { filename: f });
  return { ctx, get: (name) => vm.runInContext(name, ctx) };
}
const oldApp = (factory) => load(factory, ["backup.js", "tools/fixtures/storage_v2.js"]).get("DeckStore");
const newApp = (factory, pathname) => {
  const env = load(factory, ["backup.js", "relink.js", "srs.js", "storage.js"], pathname);
  return { DeckStore: env.get("DeckStore"), Srs: env.get("Srs"), Backup: env.get("Backup"), Relink: env.get("Relink"), ctx: env.ctx };
};

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e.stack ?? e.message).split("\n").slice(0, 6).join("\n     ")}`); }
}

// ---- テスト用のデッキと学習 ----
const DECK = { id: "1700000000001", name: "テストデッキ", cardCount: 40, profile: "vocab" };
const N = 40;
// genanki と同じ振り方: i 番目のカードの ID = base + 2i + 1。guid は作り直しても同じ
const cardsOf = (base) => Array.from({ length: N }, (_, i) => ({ key: `guid-${i}`, cid: base + 2 * i + 1 }));
const BASE = 1_700_000_100_000, REBUILT = 1_700_500_000_000;
const BLOB = { size: 1234 }; // .apkg の代わり(中身は使わない)
const H = 3600_000, DAY = 24 * H;
const now = Date.now();

const record = (cardId, state, due, last, extra = {}) => ({
  cardId, state, due, stability: 2.5 + state, difficulty: 4.75, scheduled_days: state === 2 ? 3 : 0,
  learning_steps: state === 2 ? 0 : 1, reps: 3, lapses: state === 3 ? 1 : 0, last_review: last, ...extra,
});
const logOf = (cardId, state, review, rating = 3) => ({
  cardId, rating, state, due: review, stability: 1, difficulty: 5, scheduled_days: 0, learning_steps: 0, review,
});

// 安定版での学習: 0〜11 番を学習済み。新規・学習中・再学習中・復習(今日が期限/明日以降)を混ぜる
async function studyOnOldApp(Old, cards) {
  await Old.saveDeck(DECK, BLOB);
  await Old.setNewPerDay(DECK.id, 15);
  await Old.setShowIpa(DECK.id, false);
  await Old.setFontScale(DECK.id, 1.2);
  await Old.setLayout(DECK.id, { front: ["Headword"], back: ["Meaning"] });
  const plan = [
    [0, 2, now - DAY], [1, 2, now - H], [2, 2, now + 3 * DAY], [3, 2, now + 10 * DAY],
    [4, 1, now + 10 * 60_000], [5, 1, now - 60_000], [6, 3, now + 2 * H], [7, 3, now + 30 * 60_000],
    [8, 2, now + DAY], [9, 1, now + 5 * 60_000], [10, 2, now + 40 * DAY], [11, 1, now + 4 * H],
  ];
  for (const [i, state, due] of plan) {
    const cid = cards[i].cid;
    // 前日に 1 回目(新規として導入)、今日 2 回目を答えた。8〜11 は今日導入
    const first = i >= 8 ? now - 2 * H : now - 2 * DAY;
    await Old.saveReview(DECK.id, record(cid, 1, first + 60_000, first), logOf(cid, 0, first));
    await Old.saveReview(DECK.id, record(cid, state, due, first + 600_000), logOf(cid, 1, first + 600_000, 3));
  }
}

// 端末の中身を全部取り出す(比べるため)
async function dump(Store) {
  const [decks] = await Promise.all([Store.exportAll()]);
  return decks.map((d) => ({
    ...d,
    records: [...d.records].sort((a, b) => String(a.cardId).localeCompare(String(b.cardId))),
    logs: [...d.logs].sort((a, b) => a.id - b.id),
    unlinked: [...(d.unlinked ?? [])].sort((a, b) => a.uid - b.uid),
  }));
}

async function snapshotOld(Old, cards, Srs) {
  const [list] = await Promise.all([Old.listDecks()]);
  const records = await Old.getCardRecords(DECK.id);
  const d = list[0];
  const inDeck = records.filter((r) => cards.some((c) => c.cid === r.cardId)); // 古い版の学習画面と同じ数え方
  const newToday = await Old.countNewSince(DECK.id, Srs.dayStart(now), Srs.nextDayStart(now));
  return {
    learnedCount: d.learnedCount, records, newToday,
    remaining: { ...Srs.remaining({ records: inDeck, unseenCount: Math.max(0, d.cardCount - d.learnedCount), newPerDay: 15, newToday, nowMs: now }) },
    settings: [await Old.getNewPerDay(DECK.id), await Old.getShowIpa(DECK.id), await Old.getFontScale(DECK.id), JSON.stringify(await Old.getLayout(DECK.id))],
    logs: (await Old.exportAll())[0].logs,
  };
}

// ---------------------------------------------------------------
await test("安定版の利用者(記録とカードが正しく結び付いている): 更新後も記録・履歴・枚数・設定がそのまま引き継がれる", async () => {
  const factory = new IDBFactory();
  const cards = cardsOf(BASE);
  const Old = oldApp(factory);
  await studyOnOldApp(Old, cards);
  const { DeckStore, Srs } = newApp(factory);
  const before = await snapshotOld(Old, cards, Srs);
  assert.equal(before.records.length, 12);
  assert.equal(before.logs.length, 24);

  // 更新後の初回起動: DB v3 で開く(一覧) → 付け替え
  const listed = await DeckStore.listDecks();
  assert.equal(listed[0].keyType, undefined, "まだ付け替えていない");
  const r = await DeckStore.relinkDeck(DECK.id, cards);
  assert.equal(r.stats.converted, 12);
  assert.equal(r.stats.unlinked, 0);
  assert.equal(r.stats.recovered, 0);

  const keyOf = new Map(cards.map((c) => [c.cid, c.key]));
  const after = await dump(DeckStore);
  const d = after[0];
  // 学習記録: 件数も中身も同じ。cardId だけがカードキーに変わる
  assert.equal(d.records.length, before.records.length);
  for (const old of before.records) {
    const now1 = d.records.find((x) => x.cardId === keyOf.get(old.cardId));
    assert.ok(now1, `記録が見つからない: ${old.cardId}`);
    assert.deepEqual({ ...now1, cardId: old.cardId }, old, "cardId 以外は同じ");
  }
  // 回答履歴: 件数も中身(id 含む)も同じ。cardId だけがカードキーに変わる
  assert.equal(d.logs.length, before.logs.length);
  for (const old of before.logs) {
    const now1 = d.logs.find((x) => x.id === old.id);
    assert.deepEqual({ ...now1, cardId: old.cardId }, old);
    assert.equal(now1.cardId, keyOf.get(old.cardId));
  }
  assert.equal(d.unlinked.length, 0, "結び付かない記録の置き場には何も移らない");

  // 一覧・学習画面の数
  const list = await DeckStore.listDecks();
  assert.equal(list[0].learnedCount, before.learnedCount);
  assert.equal(list[0].keyType, "guid");
  const records = await DeckStore.getCardRecords(DECK.id);
  const newToday = await DeckStore.countNewSince(DECK.id, Srs.dayStart(now), Srs.nextDayStart(now));
  assert.equal(newToday, before.newToday);
  assert.equal(newToday, 4);
  assert.deepEqual(
    { ...Srs.remaining({ records, unseenCount: Math.max(0, list[0].cardCount - list[0].learnedCount), newPerDay: 15, newToday, nowMs: now }) },
    before.remaining,
  );
  const s = Srs.createSession({ cards: cards.map((c) => ({ id: c.key })), records, newPerDay: 15, newToday, nowMs: now });
  assert.equal(s.records.size, 12, "学習画面でも全部の記録が使われる");
  assert.equal(s.unseen.length, N - 12);

  // 設定
  assert.deepEqual(
    [await DeckStore.getNewPerDay(DECK.id), await DeckStore.getShowIpa(DECK.id), await DeckStore.getFontScale(DECK.id), JSON.stringify(await DeckStore.getLayout(DECK.id))],
    before.settings,
  );
  assert.equal(await DeckStore.getAutoPlay(DECK.id), false, "自動再生は初期設定オフ");
});

await test("安定版の利用者: もう一度付け替えても、同じデッキを取り込み直しても、何も変わらない", async () => {
  const factory = new IDBFactory();
  const cards = cardsOf(BASE);
  await studyOnOldApp(oldApp(factory), cards);
  const { DeckStore } = newApp(factory);
  await DeckStore.relinkDeck(DECK.id, cards);
  const once = await dump(DeckStore);
  await DeckStore.relinkDeck(DECK.id, cards);
  assert.deepEqual(await dump(DeckStore), once);
  await DeckStore.saveDeck(DECK, BLOB, { replaceIds: [DECK.id], cards });
  assert.deepEqual(await dump(DeckStore), once);
});

await test("安定版の利用者: 更新前・更新後に書き出したバックアップを読み込んでも、記録は変わらない(重複しない)", async () => {
  const factory = new IDBFactory();
  const cards = cardsOf(BASE);
  const Old = oldApp(factory);
  await studyOnOldApp(Old, cards);
  const { DeckStore, Backup } = newApp(factory);
  const oldBackup = Backup.build({ decks: await Old.exportAll(), now }); // 数値の ID のまま
  oldBackup.schemaVersion = 1;
  await DeckStore.relinkDeck(DECK.id, cards);
  const once = await dump(DeckStore);
  for (const b of [oldBackup, Backup.build({ decks: await DeckStore.exportAll(), now })]) {
    const v = Backup.validate(JSON.parse(JSON.stringify(b)));
    assert.ok(v.ok, v.error);
    const p = await DeckStore.importMerge(v.backup, new Map([[DECK.id, cards]]), { dryRun: false });
    assert.equal(p.totals.recordsApply, 0);
    assert.equal(p.totals.logsAdd, 0);
    assert.equal(p.totals.orphanCards, 0);
  }
  assert.deepEqual(await dump(DeckStore), once);
});

await test("安定版の名前は変わらない: 安定版は DB 'anki-pwa'、開発版は 'anki-pwa-dev' を使い、互いに触れない", async () => {
  const factory = new IDBFactory();
  const cards = cardsOf(BASE);
  await studyOnOldApp(oldApp(factory), cards);
  const dev = newApp(factory, "/anki-pwa/dev/").DeckStore;
  assert.deepEqual(await dev.listDecks(), [], "開発版からは安定版のデッキは見えない");
  const names = (await factory.databases()).map((d) => d.name).sort();
  assert.deepEqual(names, ["anki-pwa", "anki-pwa-dev"]);
  const stable = newApp(factory).DeckStore;
  assert.equal((await stable.listDecks())[0].learnedCount, 12);
});

await test("付け替えたあとは、作り直したデッキ(ID が全部変わった)を取り込んでも、記録は guid で結び付いたまま", async () => {
  const factory = new IDBFactory();
  const oldCards = cardsOf(BASE);
  await studyOnOldApp(oldApp(factory), oldCards);
  const { DeckStore } = newApp(factory);
  await DeckStore.relinkDeck(DECK.id, oldCards); // 更新後の初回起動
  const once = await dump(DeckStore);
  const rebuilt = cardsOf(REBUILT);
  await DeckStore.saveDeck(DECK, BLOB, { replaceIds: [DECK.id], cards: rebuilt });
  const d = (await dump(DeckStore))[0];
  assert.deepEqual(d.records, once[0].records, "記録は 1 件も変わらない");
  assert.deepEqual(d.logs, once[0].logs);
  assert.equal(d.unlinked.length, 0);
  assert.equal((await DeckStore.listDecks())[0].learnedCount, 12);
});

await test("付け替える前に作り直したデッキを取り込んだ: 古い ID の記録は推定で戻さず、消さずに置き場に残す", async () => {
  const factory = new IDBFactory();
  const Old = oldApp(factory);
  await studyOnOldApp(Old, cardsOf(BASE));
  const before = (await Old.exportAll())[0];
  const { DeckStore } = newApp(factory);
  const r = await DeckStore.saveDeck(DECK, BLOB, { replaceIds: [DECK.id], cards: cardsOf(REBUILT) });
  assert.equal(r.stats.recovered, 0);
  const d = (await dump(DeckStore))[0];
  assert.equal(d.records.length, 0);
  assert.equal(d.unlinked.length, 12);
  for (const old of before.records) {
    const u = d.unlinked.find((x) => x.cardId === old.cardId);
    const { uid, ...rest } = u;
    assert.deepEqual(rest, old, "元の ID・中身のまま残る");
  }
  assert.equal(d.logs.length, before.logs.length, "履歴も消えない");
  assert.equal((await DeckStore.listDecks())[0].learnedCount, 0, "一覧には数えない");
});

await test("戻せない記録は消さずに置き場に残し、一覧の「学習済み」には数えない。デッキを消すと一緒に消える", async () => {
  const factory = new IDBFactory();
  const oldCards = cardsOf(BASE);
  const Old = oldApp(factory);
  await Old.saveDeck(DECK, BLOB);
  // 0, 1, 5 番だけ(途切れている)→ 戻せない
  for (const i of [0, 1, 5]) await Old.saveReview(DECK.id, record(oldCards[i].cid, 2, now + DAY, now - DAY), logOf(oldCards[i].cid, 0, now - DAY));
  const { DeckStore } = newApp(factory);
  const rebuilt = cardsOf(REBUILT);
  await DeckStore.saveDeck(DECK, BLOB, { replaceIds: [DECK.id], cards: rebuilt });
  const d = (await dump(DeckStore))[0];
  assert.equal(d.records.length, 0);
  assert.deepEqual(d.unlinked.map((u) => u.cardId).sort(), [0, 1, 5].map((i) => oldCards[i].cid).sort(), "元の ID のまま残る");
  assert.equal(d.logs.length, 3, "履歴も消えない");
  assert.equal((await DeckStore.listDecks())[0].learnedCount, 0);
  // バックアップにも入る
  const { Backup } = newApp(factory);
  assert.equal(Backup.build({ decks: await DeckStore.exportAll(), now }).decks[0].unlinkedRecords.length, 3);
  await DeckStore.deleteDeck(DECK.id);
  assert.equal((await DeckStore.exportAll()).length, 0);
  // 同じデッキを入れ直しても、消した記録・置き場・履歴は残っていない
  await DeckStore.saveDeck(DECK, BLOB, { cards: rebuilt });
  const again = (await dump(DeckStore))[0];
  assert.equal(again.records.length + again.unlinked.length + again.logs.length, 0);
});

await test("付け替えの途中で失敗したら、全部元に戻る(記録が半分だけ書き換わることはない)", async () => {
  const factory = new IDBFactory();
  const cards = cardsOf(BASE);
  await studyOnOldApp(oldApp(factory), cards);
  const app = newApp(factory);
  await app.DeckStore.listDecks();
  const before = await dump(app.DeckStore);
  // 書き込みの途中で不正な記録(キーが無い)を混ぜて失敗させる
  const realPlan = app.Relink.plan;
  app.Relink.plan = (args) => {
    const p = realPlan(args);
    p.recordsPut.push({ state: 2 }); // cardId が無いので put が失敗する
    return p;
  };
  await assert.rejects(app.DeckStore.relinkDeck(DECK.id, cards));
  app.Relink.plan = realPlan;
  assert.deepEqual(await dump(app.DeckStore), before);
  assert.notEqual((await app.DeckStore.listDecks())[0].keyType, "guid", "目印も付かない(次に開くときにもう一度試す)");
});

await test("自動再生の設定: 保存でき、取り込み直しても引き継がれる", async () => {
  const factory = new IDBFactory();
  const { DeckStore } = newApp(factory);
  const cards = cardsOf(BASE);
  await DeckStore.saveDeck(DECK, BLOB, { cards });
  assert.equal(await DeckStore.getAutoPlay(DECK.id), false);
  await DeckStore.setAutoPlay(DECK.id, true);
  await DeckStore.saveDeck(DECK, BLOB, { replaceIds: [DECK.id], cards });
  assert.equal(await DeckStore.getAutoPlay(DECK.id), true);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall tests passed");
process.exit(failed ? 1 : 0);
