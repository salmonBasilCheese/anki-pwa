// 学習ロジック(srs.js)のうち、枚数の数え方のテスト。使い方: node tools/check_srs.mjs
// ts-fsrs は使わない部分だけを調べるので、FSRS は空のダミーで読み込む。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ FSRS: { State: { New: 0, Learning: 1, Review: 2, Relearning: 3 } } });
vm.runInContext(fs.readFileSync(path.join(root, "srs.js"), "utf8"), ctx);
const Srs = vm.runInContext("Srs", ctx);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); }
}

// ローカル時刻の (年, 月, 日, 時) → ms。1日の区切りは午前4時
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();

const rec = (cardId, state, due) => ({ cardId, state, due, stability: 1, difficulty: 1, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, last_review: 0 });

const now = (o) => o.now;

test("今日の残り: 新規は 1 日の上限と未学習の少ないほう", () => {
  const n = at(2026, 5, 10);
  assert.equal(now(Srs.remaining({ records: [], unseenCount: 50, newPerDay: 20, newToday: 0, nowMs: n })), 20);
  assert.equal(now(Srs.remaining({ records: [], unseenCount: 50, newPerDay: 20, newToday: 15, nowMs: n })), 5);
  assert.equal(now(Srs.remaining({ records: [], unseenCount: 3, newPerDay: 20, newToday: 0, nowMs: n })), 3);
  assert.equal(now(Srs.remaining({ records: [], unseenCount: 50, newPerDay: 20, newToday: 25, nowMs: n })), 0);
  assert.equal(now(Srs.remaining({ records: [], unseenCount: 50, newPerDay: 0, newToday: 0, nowMs: n })), 0);
});

test("今日の残り: 今日が期限の復習・期限が来た学習中を足し、明日以降は数えない", () => {
  const n = at(2026, 5, 10, 10);
  const records = [
    rec(1, 2, at(2026, 5, 10, 5)),   // 復習: 今日が期限
    rec(2, 2, at(2026, 5, 9, 5)),    // 復習: 期限切れ(今日の分に含める)
    rec(3, 2, at(2026, 5, 11, 12)),  // 復習: 明日
    rec(4, 1, at(2026, 5, 10, 10)),  // 学習中: 今
    rec(5, 1, at(2026, 5, 11, 12)),  // 学習中: 明日の午前4時より後
  ];
  assert.deepEqual({ ...Srs.remaining({ records, unseenCount: 0, newPerDay: 20, newToday: 0, nowMs: n }) }, { now: 3, later: 0, nextDue: null });
  assert.equal(now(Srs.remaining({ records, unseenCount: 4, newPerDay: 20, newToday: 0, nowMs: n })), 7);
});

test("今日の残り: 期限前の学習中は「あとで」。先読みの時間内なら「今すぐ」", () => {
  const n = at(2026, 5, 10, 10);
  const M = 60 * 1000;
  const records = [
    rec(1, 1, n + 10 * M),           // 学習中: 10分後(先読み 20分以内 → 今すぐ)
    rec(2, 3, n + 30 * M),           // 再学習中: 30分後 → あとで
    rec(3, 1, n + 3 * 60 * M),       // 学習中: 3時間後 → あとで
    rec(4, 1, at(2026, 5, 11, 5)),   // 学習中: 明日の午前4時より後 → 数えない
  ];
  const r = Srs.remaining({ records, unseenCount: 0, newPerDay: 20, newToday: 0, nowMs: n });
  assert.deepEqual({ ...r }, { now: 1, later: 2, nextDue: n + 30 * M });
});

test("あとで出る枚数: 何も出せないとき pickNext は null で、later が残りを数える", () => {
  const n = at(2026, 5, 10, 10);
  const M = 60 * 1000;
  const s = Srs.createSession({ cards: [], records: [rec(1, 1, n + 30 * M), rec(2, 1, n + 90 * M)], newPerDay: 20, newToday: 0, nowMs: n });
  assert.equal(Srs.pickNext(s, n), null);
  assert.deepEqual({ ...Srs.later(s, n) }, { count: 2, nextDue: n + 30 * M });
  assert.deepEqual({ ...Srs.later(s, at(2026, 5, 11, 5)) }, { count: 0, nextDue: null });
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall tests passed");
process.exit(failed ? 1 : 0);
