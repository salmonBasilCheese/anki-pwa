// 記録の付け替え(relink.js)の計算部分のテスト。使い方: node tools/check_relink.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Relink = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../relink.js"));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); }
}

// genanki と同じ振り方のデッキ: i 番目のカードの ID = base + 2i + 1、guid は作り直しても同じ
const deck = (base, n, keys = (i) => `g${i}`) =>
  Array.from({ length: n }, (_, i) => ({ key: keys(i), cid: base + 2 * i + 1 }));
const rec = (cardId, last, extra = {}) => ({
  deckId: "D", cardId, state: 2, due: 5000, stability: 3, difficulty: 5, scheduled_days: 2,
  learning_steps: 0, reps: 1, lapses: 0, last_review: last, ...extra,
});
const OLD = 1_790_000_000_000, NEW = 1_795_000_000_000;

test("cardKey: 1枚目は guid のまま、2枚目以降は #ord を付ける", () => {
  assert.equal(Relink.cardKey("abc", 0), "abc");
  assert.equal(Relink.cardKey("abc", 2), "abc#2");
});

test("cardsFrom: guid が重なるカードがあっても、2 枚目以降を見分けて開けるようにする", () => {
  const c = Relink.cardsFrom([{ cid: 11, ord: 0, guid: "a" }, { cid: 13, ord: 0, guid: "a" }, { cid: 15, ord: 1, guid: "a" }]);
  assert.deepEqual(c.map((x) => x.key), ["a", "a@13", "a#1"]);
});

test("安定版の利用者(数値の ID がすべてデッキにある): 全部カードキーに書き換え、置き場には何も移さない", () => {
  const cards = deck(NEW, 10);
  const records = [rec(NEW + 1, 10), rec(NEW + 3, 20, { state: 1 }), rec(NEW + 19, 30, { state: 3 })];
  const p = Relink.plan({ cards, records, unlinked: [] });
  assert.deepEqual(p.recordsDelete, [NEW + 1, NEW + 3, NEW + 19]);
  assert.deepEqual(p.recordsPut, [
    { ...records[0], cardId: "g0" }, { ...records[1], cardId: "g1" }, { ...records[2], cardId: "g9" },
  ], "cardId 以外は何も変わらない");
  assert.deepEqual(p.unlinkedAdd, []);
  assert.deepEqual(p.unlinkedDelete, []);
  assert.equal(p.stats.converted, 3);
  assert.equal(p.stats.unlinked, 0);
  assert.equal(p.logKey.get(NEW + 3), "g1");
});

test("付け替え済みの記録に、もう一度行っても何もしない", () => {
  const cards = deck(NEW, 5);
  const p = Relink.plan({ cards, records: [rec("g0", 1), rec("g4", 2)], unlinked: [] });
  assert.deepEqual([p.recordsDelete, p.recordsPut, p.unlinkedAdd, p.unlinkedDelete], [[], [], [], []]);
});

test("初期設定(アプリ)では、古い ID から推定して戻すことはしない。全部を置き場に残す", () => {
  const cards = deck(NEW, 100);
  const records = [0, 1, 2].map((i) => rec(OLD + 2 * i + 1, 100));
  const p = Relink.plan({ cards, records, unlinked: [] });
  assert.deepEqual(p.recordsPut, []);
  assert.deepEqual(p.unlinkedAdd.map((r) => r.cardId), records.map((r) => r.cardId));
  assert.equal(p.stats.recovered, 0);
  assert.equal(p.logKey.has(OLD + 1), false);
});

test("作り直して ID が全部変わった: 0 番から途切れずに学習していれば、元のカードに戻す", () => {
  const cards = deck(NEW, 100);
  const records = [0, 1, 2, 3, 4].map((i) => rec(OLD + 2 * i + 1, 100 + i, { reps: i }));
  const p = Relink.plan({ cards, records, unlinked: [], recover: true });
  assert.deepEqual(p.recordsPut.map((r) => [r.cardId, r.reps]), [["g0", 0], ["g1", 1], ["g2", 2], ["g3", 3], ["g4", 4]]);
  assert.equal(p.stats.recovered, 5);
  assert.deepEqual(p.unlinkedAdd, []);
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].ok, true);
  assert.equal(p.logKey.get(OLD + 9), "g4", "回答履歴も戻せる");
});

test("戻す: 学習した順番が途切れている(0,1,3)なら戻さず、置き場に残す", () => {
  const cards = deck(NEW, 100);
  const records = [0, 1, 3].map((i) => rec(OLD + 2 * i + 1, 1));
  const p = Relink.plan({ cards, records, unlinked: [], recover: true });
  assert.deepEqual(p.recordsPut, []);
  assert.equal(p.unlinkedAdd.length, 3);
  assert.deepEqual(p.unlinkedAdd.map((r) => r.cardId), records.map((r) => r.cardId), "元の ID のまま残す");
  assert.equal(p.groups[0].ok, false);
});

test("戻す: ID の間隔が 2 ずつでなければ戻さない", () => {
  const cards = deck(NEW, 100);
  const p = Relink.plan({ cards, records: [rec(OLD + 1, 1), rec(OLD + 2, 1)], unlinked: [], recover: true });
  assert.deepEqual(p.recordsPut, []);
  assert.equal(p.unlinkedAdd.length, 2);
});

test("戻す: 今のデッキの ID の並びが決まった形でなければ戻さない", () => {
  const cards = deck(NEW, 5);
  cards[2] = { ...cards[2], cid: cards[2].cid + 1000 };
  const p = Relink.plan({ cards, records: [rec(OLD + 1, 1)], unlinked: [], recover: true });
  assert.deepEqual(p.recordsPut, []);
  assert.equal(p.unlinkedAdd.length, 1);
});

test("戻す: 別の回に作った ID はまとまりごとに調べる。同じカードに複数あれば、最後に答えた日が新しいほうを使い、もう一方も残す", () => {
  const cards = deck(NEW, 50);
  const OLD2 = OLD + 1_000_000;
  const records = [
    rec(OLD + 1, 100, { reps: 1 }), rec(OLD + 3, 100),       // 1 回目に作ったデッキ: 0, 1
    rec(OLD2 + 1, 200, { reps: 2 }),                        // 2 回目に作ったデッキ: 0
  ];
  const p = Relink.plan({ cards, records, unlinked: [], recover: true });
  const put = new Map(p.recordsPut.map((r) => [r.cardId, r]));
  assert.equal(put.get("g0").reps, 2, "新しいほう");
  assert.ok(put.has("g1"));
  assert.deepEqual(p.unlinkedAdd.map((r) => r.cardId), [OLD + 1], "使わなかった記録も残す");
  assert.equal(p.stats.conflicts, 1);
});

test("今の記録と、戻した古い記録が重なる: 最後に答えた日が新しいほう。同じなら今の記録", () => {
  const cards = deck(NEW, 10);
  const p = Relink.plan({ cards, records: [rec("g0", 500, { reps: 9 }), rec(OLD + 1, 100)], unlinked: [], recover: true });
  assert.deepEqual(p.recordsPut, [], "今の記録はそのまま");
  assert.deepEqual(p.unlinkedAdd.map((r) => r.cardId), [OLD + 1]);
  const q = Relink.plan({ cards, records: [rec("g0", 100, { reps: 9 }), rec(OLD + 1, 100)], unlinked: [], recover: true });
  assert.deepEqual(q.recordsPut, [], "同じ日なら今の記録");
});

test("デッキから消えたカードの記録は置き場へ。作り直しで戻ってきたら、置き場から戻す", () => {
  const before = deck(NEW, 3);
  const p = Relink.plan({ cards: before.slice(0, 2), records: [rec("g2", 1, { reps: 4 })], unlinked: [] });
  assert.deepEqual(p.recordsDelete, ["g2"]);
  assert.deepEqual(p.unlinkedAdd.map((r) => [r.cardId, r.reps]), [["g2", 4]]);
  const q = Relink.plan({ cards: before, records: [], unlinked: [{ ...rec("g2", 1, { reps: 4 }), uid: 7 }] });
  assert.deepEqual(q.unlinkedDelete, [7]);
  assert.deepEqual(q.recordsPut, [{ ...rec("g2", 1, { reps: 4 }) }]);
  assert.equal(q.recordsPut[0].uid, undefined);
  assert.equal(q.stats.restored, 1);
});

test("置き場にあって、今の記録に負けたものは、置き場に置いたまま(何度行っても増えない)", () => {
  const cards = deck(NEW, 3);
  const p = Relink.plan({ cards, records: [rec("g0", 500)], unlinked: [{ ...rec("g0", 100), uid: 1 }] });
  assert.deepEqual([p.recordsDelete, p.recordsPut, p.unlinkedAdd, p.unlinkedDelete], [[], [], [], []]);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall tests passed");
process.exit(failed ? 1 : 0);
