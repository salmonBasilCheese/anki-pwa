// 学習ロジック(srs.js)のうち、日付と枚数の数え方のテスト。使い方: node tools/check_srs.mjs
// ts-fsrs は使わない部分だけを調べるので、FSRS は空のダミーで読み込む。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ FSRS: { State: { New: 0, Learning: 1, Review: 2, Relearning: 3 } } });
vm.runInContext(fs.readFileSync(path.join(root, "srs.js"), "utf8"), ctx);
const SrsRaw = vm.runInContext("Srs", ctx);
// vm の中で作られたオブジェクトは deepEqual で別物扱いされるので、普通のオブジェクトに写して返す
const Srs = { ...SrsRaw, streak: (t, n) => ({ ...SrsRaw.streak(t, n) }) };

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); }
}

// ローカル時刻の (年, 月, 日, 時) → ms。1日の区切りは午前4時
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();

test("連続学習: 回答が無ければ 0 日", () => {
  assert.deepEqual(Srs.streak([], at(2026, 5, 10)), { days: 0, studiedToday: false });
});

test("連続学習: 今日までの連続を数える(同じ日の複数回答は 1 日)", () => {
  const t = [at(2026, 5, 8), at(2026, 5, 9, 9), at(2026, 5, 9, 20), at(2026, 5, 10)];
  assert.deepEqual(Srs.streak(t, at(2026, 5, 10, 21)), { days: 3, studiedToday: true });
});

test("連続学習: 今日まだでも、昨日までの連続は途切れない", () => {
  const t = [at(2026, 5, 8), at(2026, 5, 9)];
  assert.deepEqual(Srs.streak(t, at(2026, 5, 10, 8)), { days: 2, studiedToday: false });
});

test("連続学習: 1 日あくと途切れる(昨日が空なら 0 日)", () => {
  const t = [at(2026, 5, 7), at(2026, 5, 8)];
  assert.deepEqual(Srs.streak(t, at(2026, 5, 10)), { days: 0, studiedToday: false });
});

test("連続学習: 途中があいていれば、新しいほうの連続だけを数える", () => {
  const t = [at(2026, 5, 1), at(2026, 5, 2), at(2026, 5, 5), at(2026, 5, 6)];
  assert.equal(Srs.streak(t, at(2026, 5, 6)).days, 2);
});

test("連続学習: 午前 4 時が日の区切り(午前 3 時の回答は前の日)", () => {
  const t = [at(2026, 5, 9, 23), at(2026, 5, 10, 3)]; // どちらも 5/9 の日
  assert.deepEqual(Srs.streak(t, at(2026, 5, 10, 5)), { days: 1, studiedToday: false });
  assert.deepEqual(Srs.streak(t, at(2026, 5, 10, 3)), { days: 1, studiedToday: true });
});

test("連続学習: 月またぎ・年またぎでも数えられる", () => {
  const t = [at(2025, 12, 30), at(2025, 12, 31), at(2026, 1, 1), at(2026, 1, 2)];
  assert.equal(Srs.streak(t, at(2026, 1, 2)).days, 4);
});

test("連続学習: 未来の時刻(時計のずれ)があっても今日までの数え方は変わらない", () => {
  const t = [at(2026, 5, 9), at(2026, 5, 10), at(2026, 5, 20)];
  assert.equal(Srs.streak(t, at(2026, 5, 10)).days, 2);
});

const rec = (cardId, state, due) => ({ cardId, state, due, stability: 1, difficulty: 1, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, last_review: 0 });

test("今日の残り: 新規は 1 日の上限と未学習の少ないほう", () => {
  const n = at(2026, 5, 10);
  assert.equal(Srs.remaining({ records: [], unseenCount: 50, newPerDay: 20, newToday: 0, nowMs: n }), 20);
  assert.equal(Srs.remaining({ records: [], unseenCount: 50, newPerDay: 20, newToday: 15, nowMs: n }), 5);
  assert.equal(Srs.remaining({ records: [], unseenCount: 3, newPerDay: 20, newToday: 0, nowMs: n }), 3);
  assert.equal(Srs.remaining({ records: [], unseenCount: 50, newPerDay: 20, newToday: 25, nowMs: n }), 0);
  assert.equal(Srs.remaining({ records: [], unseenCount: 50, newPerDay: 0, newToday: 0, nowMs: n }), 0);
});

test("今日の残り: 今日が期限の復習・今日中に期限が来る学習中を足し、明日以降は数えない", () => {
  const n = at(2026, 5, 10, 10);
  const records = [
    rec(1, 2, at(2026, 5, 10, 5)),   // 復習: 今日が期限
    rec(2, 2, at(2026, 5, 9, 5)),    // 復習: 期限切れ(今日の分に含める)
    rec(3, 2, at(2026, 5, 11, 12)),  // 復習: 明日
    rec(4, 1, at(2026, 5, 10, 10)),  // 学習中: 今日
    rec(5, 1, at(2026, 5, 11, 12)),  // 学習中: 明日の午前4時より後
  ];
  assert.equal(Srs.remaining({ records, unseenCount: 0, newPerDay: 20, newToday: 0, nowMs: n }), 3);
  assert.equal(Srs.remaining({ records, unseenCount: 4, newPerDay: 20, newToday: 0, nowMs: n }), 7);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall tests passed");
process.exit(failed ? 1 : 0);
