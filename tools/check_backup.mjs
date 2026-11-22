// バックアップの計算部分(backup.js)のテスト。使い方: node tools/check_backup.mjs
// IndexedDB は使わない。「端末の状態」は普通のオブジェクトで表し、plan の結果を自前で適用して確かめる。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const Backup = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../backup.js"));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); }
}

// ---- 測定用データ ----
const rec = (cardId, last, extra = {}) => ({
  cardId, state: 2, due: 1000 + cardId, stability: 3.5, difficulty: 5.2, scheduled_days: 3,
  learning_steps: 0, reps: 2, lapses: 0, last_review: last, ...extra,
});
const log = (cardId, review, extra = {}) => ({
  cardId, rating: 3, state: 0, due: 500, stability: 1, difficulty: 4, scheduled_days: 0,
  learning_steps: 0, review, ...extra,
});
const ids = (...n) => new Set(n);

// 端末のデッキ(local の1要素)
const localDeck = (over = {}) => ({
  id: "D1", name: "デッキ1", newPerDay: null, records: [], logs: [], cardIds: ids(1, 2, 3), ...over,
});

// plan の結果を端末に適用する(storage.js の importMerge がやることの模倣)
function apply(local, p) {
  const next = structuredClone(local, {});
  for (const r of p.writes.records) {
    const d = next.find((x) => x.id === r.deckId);
    d.records = d.records.filter((x) => x.cardId !== r.cardId).concat(r);
  }
  for (const l of p.writes.logs) next.find((x) => x.id === l.deckId).logs.push(l);
  for (const { deckId, value } of p.writes.newPerDay) next.find((x) => x.id === deckId).newPerDay = value;
  return next;
}
// Set は structuredClone で保たれる

const makeBackup = (decks, now = 1_700_000_000_000) => Backup.build({ decks, now });
const roundTrip = (b) => Backup.validate(JSON.parse(JSON.stringify(b)));

// ---------------------------------------------------------------
test("書き出し→JSON→検査で、内容が変わらない(deckId・履歴の id は含まれない)", () => {
  const src = [{
    id: "D1", name: "デッキ1", newPerDay: 15,
    records: [{ ...rec(1, 111), deckId: "D1" }, rec(2, null)],
    logs: [{ ...log(1, 111), id: 77, deckId: "D1" }],
  }];
  const b = makeBackup(src);
  assert.equal(b.decks[0].cardRecords[0].deckId, undefined);
  assert.equal(b.decks[0].reviewLogs[0].id, undefined);
  assert.equal(b.decks[0].reviewLogs[0].deckId, undefined);
  const v = roundTrip(b);
  assert.ok(v.ok, v.error);
  assert.deepEqual(v.backup, b);
  assert.deepEqual(Backup.counts(b), { decks: 1, cards: 2, logs: 1 });
});

test("端末が空(.apkg を入れ直した直後)に読み込むと、全部が反映される", () => {
  const b = roundTrip(makeBackup([{ id: "D1", name: "デッキ1", newPerDay: 10, records: [rec(1, 100), rec(2, 200)], logs: [log(1, 100), log(2, 200)] }])).backup;
  const local = [localDeck()];
  const p = Backup.plan(b, local);
  assert.equal(p.totals.recordsApply, 2);
  assert.equal(p.totals.logsAdd, 2);
  assert.equal(p.totals.orphanCards, 0);
  assert.deepEqual(p.writes.newPerDay, [{ deckId: "D1", value: 10 }]);
  assert.ok(p.writes.records.every((r) => r.deckId === "D1"));
  const after = apply(local, p);
  assert.equal(after[0].records.length, 2);
  assert.equal(after[0].logs.length, 2);
});

test("同じバックアップを2回読み込んでも増えない(2回目は変更なし)", () => {
  const b = roundTrip(makeBackup([{ id: "D1", name: "デッキ1", newPerDay: 10, records: [rec(1, 100)], logs: [log(1, 100)] }])).backup;
  let local = [localDeck()];
  local = apply(local, Backup.plan(b, local));
  const p2 = Backup.plan(b, local);
  assert.equal(p2.hasChanges, false);
  assert.equal(p2.totals.recordsApply, 0);
  assert.equal(p2.totals.logsAdd, 0);
  assert.equal(p2.totals.logsDup, 1);
  assert.equal(p2.totals.recordsKeep, 1);
});

test("新しいほうが残る: 端末が新しければ端末、バックアップが新しければバックアップ、同じなら端末", () => {
  const b = roundTrip(makeBackup([{ id: "D1", name: "デッキ1", records: [rec(1, 500, { reps: 9 }), rec(2, 100, { reps: 9 }), rec(3, 300, { reps: 9 })], logs: [] }])).backup;
  const local = [localDeck({ records: [rec(1, 400, { reps: 1 }), rec(2, 200, { reps: 1 }), rec(3, 300, { reps: 1 })] })];
  const p = Backup.plan(b, local);
  const after = apply(local, p)[0].records;
  const reps = (id) => after.find((r) => r.cardId === id).reps;
  assert.equal(reps(1), 9, "バックアップが新しい → 置き換わる");
  assert.equal(reps(2), 1, "端末が新しい → そのまま");
  assert.equal(reps(3), 1, "同じ時刻 → 端末のまま");
  assert.equal(p.totals.recordsApply, 1);
  assert.equal(p.totals.recordsKeep, 2);
});

test("last_review が null の記録は、回答のある記録に負ける", () => {
  assert.equal(Backup.isNewer(rec(1, 5), rec(1, null)), true);
  assert.equal(Backup.isNewer(rec(1, null), rec(1, 5)), false);
  assert.equal(Backup.isNewer(rec(1, null), rec(1, null)), false);
  assert.equal(Backup.isNewer(rec(1, null), undefined), true);
});

test("バックアップ内に同じカードが複数あれば、新しいほうを使う", () => {
  const b = roundTrip(makeBackup([{ id: "D1", name: "デッキ1", records: [rec(1, 100, { reps: 1 }), rec(1, 300, { reps: 7 }), rec(1, 200, { reps: 4 })], logs: [] }])).backup;
  const p = Backup.plan(b, [localDeck()]);
  assert.equal(p.writes.records.length, 1);
  assert.equal(p.writes.records[0].reps, 7);
});

test("回答履歴は、端末にある分と(カード,時刻)が同じなら追加しない。違う分だけ足す", () => {
  const b = roundTrip(makeBackup([{ id: "D1", name: "デッキ1", records: [], logs: [log(1, 100), log(1, 200), log(2, 100), log(2, 100)] }])).backup;
  const local = [localDeck({ logs: [{ ...log(1, 100), id: 1, deckId: "D1" }] })];
  const p = Backup.plan(b, local);
  assert.equal(p.totals.logsAdd, 2, "(1,200) と (2,100) の1件だけ");
  assert.equal(p.totals.logsDup, 2, "(1,100) と、ファイル内の重複 (2,100)");
});

test("IPA 表示(showIpa)は往復で保たれ、端末に設定が無いときだけ反映する", () => {
  const mk = (v) => roundTrip(makeBackup([{ id: "D1", name: "デッキ1", newPerDay: null, showIpa: v, records: [], logs: [] }])).backup;
  assert.equal(mk(false).decks[0].showIpa, false);
  assert.equal(mk(true).decks[0].showIpa, true);
  assert.deepEqual(Backup.plan(mk(false), [localDeck()]).writes.showIpa, [{ deckId: "D1", value: false }]);
  assert.equal(Backup.plan(mk(false), [localDeck()]).hasChanges, true);
  assert.equal(Backup.plan(mk(false), [localDeck({ showIpa: true })]).writes.showIpa.length, 0, "端末に設定があれば上書きしない");
  assert.equal(Backup.plan(mk(null), [localDeck()]).writes.showIpa.length, 0, "バックアップに設定が無ければ何もしない");
  assert.match(Backup.describe(Backup.plan(mk(false), [localDeck()]), { done: false }), /IPA の表示: 表示しない/);
});

test("showIpa の無い古い形式のバックアップも読める。真偽値以外は拒否する", () => {
  const old = JSON.parse(JSON.stringify(makeBackup([{ id: "D1", name: "デッキ1", newPerDay: 5, records: [], logs: [] }])));
  for (const d of old.decks) delete d.showIpa;
  const r = Backup.validate(old);
  assert.equal(r.ok, true);
  assert.equal(r.backup.decks[0].showIpa, null);
  old.decks[0].showIpa = "yes";
  assert.equal(Backup.validate(old).ok, false);
});

test("文字サイズ(fontScale)は往復で保たれ、端末に設定が無いときだけ反映する", () => {
  const mk = (v) => roundTrip(makeBackup([{ id: "D1", name: "デッキ1", newPerDay: null, fontScale: v, records: [], logs: [] }])).backup;
  assert.equal(mk(1.2).decks[0].fontScale, 1.2);
  assert.deepEqual(Backup.plan(mk(1.4), [localDeck()]).writes.fontScale, [{ deckId: "D1", value: 1.4 }]);
  assert.equal(Backup.plan(mk(1.4), [localDeck({ fontScale: 1 })]).writes.fontScale.length, 0, "端末に設定があれば上書きしない");
  assert.equal(Backup.plan(mk(null), [localDeck()]).writes.fontScale.length, 0, "バックアップに設定が無ければ何もしない");
  assert.match(Backup.describe(Backup.plan(mk(1.4), [localDeck()]), { done: true }), /文字サイズ: 特大 を反映しました/);
});

test("fontScale が選択肢に無い値のバックアップは拒否する。無い古い形式は読める", () => {
  const f = JSON.parse(JSON.stringify(makeBackup([{ id: "D1", name: "デッキ1", newPerDay: null, records: [], logs: [] }])));
  delete f.decks[0].fontScale;
  assert.equal(Backup.validate(f).ok, true);
  for (const bad of [2, 0, "1.2", -1, 999]) { f.decks[0].fontScale = bad; assert.equal(Backup.validate(f).ok, false, `fontScale=${bad}`); }
});

test("新規上限(newPerDay)は端末に設定が無いときだけ反映する", () => {
  const mk = (n) => roundTrip(makeBackup([{ id: "D1", name: "デッキ1", newPerDay: n, records: [], logs: [] }])).backup;
  assert.equal(Backup.plan(mk(30), [localDeck({ newPerDay: null })]).writes.newPerDay.length, 1);
  assert.equal(Backup.plan(mk(30), [localDeck({ newPerDay: 5 })]).writes.newPerDay.length, 0);
  assert.equal(Backup.plan(mk(null), [localDeck({ newPerDay: null })]).writes.newPerDay.length, 0);
});

// ---- 追加要件: 該当カードなし(デッキを作り直して ID が変わった場合など)は黙って捨てない ----
test("一部のカードが端末のデッキに無い: その分はスキップし、枚数を数えて表示する", () => {
  const b = roundTrip(makeBackup([{ id: "D1", name: "デッキ1", records: [rec(1, 100), rec(99, 100), rec(98, 100)], logs: [log(1, 100), log(99, 100)] }])).backup;
  const local = [localDeck()]; // カード 1,2,3 だけが実在
  const p = Backup.plan(b, local);
  assert.equal(p.totals.recordsApply, 1);
  assert.equal(p.totals.orphanCards, 2, "99 と 98");
  assert.equal(p.totals.orphanLogs, 1);
  assert.deepEqual(p.writes.records.map((r) => r.cardId), [1], "該当なしの記録は書き込まれない");
  assert.deepEqual(p.writes.logs.map((l) => l.cardId), [1]);
  const preview = Backup.describe(p, { done: false });
  assert.match(preview, /2 枚は該当カードなしでスキップ/);
  const result = Backup.describe(p, { done: true });
  assert.match(result, /2 枚は該当カードなしでスキップ/);
});

test("デッキを作り直して全カードの ID が変わった: 全部スキップされ、警告が出て、何も書かれない", () => {
  const b = roundTrip(makeBackup([{ id: "D1", name: "デッキ1", records: [rec(1, 100), rec(2, 100), rec(3, 100)], logs: [log(1, 100)] }])).backup;
  const local = [localDeck({ cardIds: ids(1001, 1002, 1003) })]; // ID が全部違う
  const p = Backup.plan(b, local);
  assert.equal(p.hasChanges, false);
  assert.equal(p.totals.orphanCards, 3);
  assert.equal(p.totals.recordsApply, 0);
  assert.match(Backup.describe(p, { done: false }), /3 枚は該当カードなしでスキップ/);
});

test("端末にデッキが無い: スキップして表示する(何も書かない)", () => {
  const b = roundTrip(makeBackup([{ id: "D9", name: "別のデッキ", records: [rec(1, 100), rec(2, 100)], logs: [log(1, 100)] }])).backup;
  const p = Backup.plan(b, [localDeck()]);
  assert.equal(p.hasChanges, false);
  assert.equal(p.totals.missingDecks, 1);
  assert.equal(p.totals.missingRecords, 2);
  assert.equal(p.decks[0].status, "missing");
  assert.match(Backup.describe(p, { done: false }), /端末に無いためスキップ\(カード記録 2 枚\)/);
});

test("端末にデッキ ID は違うが同じ名前のデッキがある: 作り直しの可能性を知らせる", () => {
  const b = roundTrip(makeBackup([{ id: "OLD", name: "デッキ1", records: [rec(1, 100)], logs: [] }])).backup;
  const p = Backup.plan(b, [localDeck({ id: "NEW" })]);
  assert.equal(p.decks[0].status, "missing");
  assert.equal(p.decks[0].sameNameDeckId, "NEW");
  assert.match(Backup.describe(p, { done: false }), /ID が違います/);
});

test("複数デッキ: 反映できるデッキとスキップされるデッキが混ざっても、それぞれ正しく扱う", () => {
  const b = roundTrip(makeBackup([
    { id: "D1", name: "デッキ1", records: [rec(1, 100)], logs: [] },
    { id: "D2", name: "デッキ2", records: [rec(7, 100)], logs: [] },
    { id: "D3", name: "デッキ3", records: [rec(1, 100)], logs: [] },
  ])).backup;
  const local = [localDeck(), localDeck({ id: "D2", name: "デッキ2", cardIds: ids(50) })];
  const p = Backup.plan(b, local);
  assert.deepEqual(p.writes.records.map((r) => `${r.deckId}:${r.cardId}`), ["D1:1"]);
  assert.equal(p.totals.orphanCards, 1);
  assert.equal(p.totals.missingDecks, 1);
});

test("cardIds が渡されていないデッキは、黙って進まずエラーにする", () => {
  const b = roundTrip(makeBackup([{ id: "D1", name: "デッキ1", records: [rec(1, 100)], logs: [] }])).backup;
  assert.throws(() => Backup.plan(b, [localDeck({ cardIds: null })]), /カード一覧/);
});

// ---- 検査(壊れたファイル・知らないファイルを拒否する) ----
const goodJson = () => JSON.parse(JSON.stringify(makeBackup([{ id: "D1", name: "デッキ1", newPerDay: 5, records: [rec(1, 100)], logs: [log(1, 100)] }])));
const mustFail = (obj, pattern) => {
  const v = Backup.validate(obj);
  assert.equal(v.ok, false, "拒否されるはず");
  if (pattern) assert.match(v.error, pattern);
};

test("検査: JSON でない・別アプリのファイルを拒否する", () => {
  mustFail(null, /バックアップファイルではありません/);
  mustFail([], /バックアップファイルではありません/);
  mustFail("text", /バックアップファイルではありません/);
  mustFail({ app: "other", schemaVersion: 1 }, /バックアップファイルではありません/);
});

test("検査: 新しすぎる/不正な schemaVersion を拒否する", () => {
  const a = goodJson(); a.schemaVersion = 2; mustFail(a, /新しいバージョン/);
  const b = goodJson(); b.schemaVersion = "1"; mustFail(b, /バージョン/);
  const c = goodJson(); c.schemaVersion = 0; mustFail(c, /バージョン/);
  const d = goodJson(); delete d.schemaVersion; mustFail(d, /バージョン/);
});

test("検査: 必須項目の欠け・型の違いを拒否する", () => {
  const a = goodJson(); delete a.decks; mustFail(a, /デッキの一覧/);
  const b = goodJson(); b.exportedAt = "昨日"; mustFail(b, /日時/);
  const c = goodJson(); c.decks[0].id = ""; mustFail(c, /decks\[0\]/);
  const d = goodJson(); delete d.decks[0].cardRecords; mustFail(d, /学習記録/);
  const e = goodJson(); e.decks.push({ ...e.decks[0] }); mustFail(e, /重複/);
  const f = goodJson(); f.decks[0].newPerDay = 1000; mustFail(f, /新規上限/);
});

test("検査: 壊れた記録・履歴(位置つきで)を拒否する", () => {
  const a = goodJson(); a.decks[0].cardRecords[0].due = NaN; // JSON.stringify 後は null になるが、直接渡しても拒否
  mustFail(a, /cardRecords\[0\]/);
  const b = goodJson(); b.decks[0].cardRecords[0].state = 9; mustFail(b, /cardRecords\[0\]/);
  const c = goodJson(); c.decks[0].cardRecords[0].cardId = "1"; mustFail(c, /cardRecords\[0\]/);
  const d = goodJson(); d.decks[0].reviewLogs[0].rating = 5; mustFail(d, /reviewLogs\[0\]/);
  const e = goodJson(); delete e.decks[0].reviewLogs[0].review; mustFail(e, /reviewLogs\[0\]/);
  const f = goodJson(); f.decks[0].cardRecords[0] = null; mustFail(f, /cardRecords\[0\]/);
});

test("検査: 知らない項目は捨てる(取り込まない)", () => {
  const a = goodJson();
  a.decks[0].cardRecords[0].evil = "<script>"; a.decks[0].reviewLogs[0].deckId = "OTHER"; a.decks[0].extra = 1;
  const v = Backup.validate(a);
  assert.ok(v.ok, v.error);
  assert.equal(v.backup.decks[0].cardRecords[0].evil, undefined);
  assert.equal(v.backup.decks[0].reviewLogs[0].deckId, undefined);
  assert.equal(v.backup.decks[0].extra, undefined);
});

test("検査: last_review が null の記録(書き出し直後のもの)は受け付ける", () => {
  const a = goodJson(); a.decks[0].cardRecords[0].last_review = null;
  assert.ok(Backup.validate(a).ok);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall tests passed");
process.exit(failed ? 1 : 0);
