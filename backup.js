"use strict";

// ---------------------------------------------------------------
// 学習記録のバックアップ(書き出し・読み込み)の、計算だけを行う部分。
// IndexedDB や画面には触れない。ブラウザではグローバル `Backup`、Node では
// require("./backup.js") で使える(tools/check_backup.mjs がテストする)。
//
// バックアップファイル(JSON) schemaVersion 1
//   { app: "anki-pwa-backup", schemaVersion: 1, exportedAt: ms,
//     decks: [ { id, name, newPerDay: 整数|null, showIpa: true|false|null(省略可。古いファイルには無い),
//                cardRecords: [ srs.js の record(形は srs.js の先頭コメント。deckId は持たない) ],
//                reviewLogs:  [ 回答履歴(deckId・自動採番の id は持たない) ] } ] }
// 含めないもの: .apkg 本体・教材の中身(カードの内容)。
//
// バックアップの形を変えるときは SCHEMA_VERSION を上げ、MIGRATIONS に
// 「1 → 2 に変換する関数」を足す(古いファイルも読めるように)。
// ---------------------------------------------------------------
const Backup = (() => {
  const APP = "anki-pwa-backup";
  const SCHEMA_VERSION = 1;
  // MIGRATIONS[n] は、schemaVersion n のデータを n+1 の形に変換して返す
  const MIGRATIONS = {};

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const isInt = (x) => Number.isSafeInteger(x);
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

  // ---- 1件ずつの検査。決まった項目だけを取り出して返す(余計な項目は捨てる)。不正なら null ----
  function cleanRecord(r) {
    if (!isObj(r)) return null;
    if (!isInt(r.cardId)) return null;
    if (!isInt(r.state) || r.state < 0 || r.state > 3) return null;
    if (!isNum(r.due) || !isNum(r.stability) || !isNum(r.difficulty) || !isNum(r.scheduled_days)) return null;
    if (!isInt(r.learning_steps) || r.learning_steps < 0) return null;
    if (!isInt(r.reps) || r.reps < 0 || !isInt(r.lapses) || r.lapses < 0) return null;
    if (r.last_review != null && !isNum(r.last_review)) return null;
    return {
      cardId: r.cardId, state: r.state, due: r.due,
      stability: r.stability, difficulty: r.difficulty, scheduled_days: r.scheduled_days,
      learning_steps: r.learning_steps, reps: r.reps, lapses: r.lapses,
      last_review: r.last_review ?? null,
    };
  }

  function cleanLog(l) {
    if (!isObj(l)) return null;
    if (!isInt(l.cardId)) return null;
    if (!isInt(l.rating) || l.rating < 1 || l.rating > 4) return null;
    if (!isInt(l.state) || l.state < 0 || l.state > 3) return null;
    if (!isNum(l.due) || !isNum(l.stability) || !isNum(l.difficulty) || !isNum(l.scheduled_days)) return null;
    if (!isInt(l.learning_steps) || l.learning_steps < 0) return null;
    if (!isNum(l.review)) return null;
    return {
      cardId: l.cardId, rating: l.rating, state: l.state, due: l.due,
      stability: l.stability, difficulty: l.difficulty, scheduled_days: l.scheduled_days,
      learning_steps: l.learning_steps, review: l.review,
    };
  }

  // ---- 書き出し用: 端末のデータからバックアップの形を作る ----
  // decks: [{ id, name, newPerDay, showIpa, records, logs }]
  function build({ decks, now }) {
    const pickRecord = (r) => ({
      cardId: r.cardId, state: r.state, due: r.due,
      stability: r.stability, difficulty: r.difficulty, scheduled_days: r.scheduled_days,
      learning_steps: r.learning_steps, reps: r.reps, lapses: r.lapses,
      last_review: r.last_review ?? null,
    });
    const pickLog = (l) => ({
      cardId: l.cardId, rating: l.rating, state: l.state, due: l.due,
      stability: l.stability, difficulty: l.difficulty, scheduled_days: l.scheduled_days,
      learning_steps: l.learning_steps, review: l.review,
    });
    return {
      app: APP,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: now,
      decks: decks.map((d) => ({
        id: d.id,
        name: d.name,
        newPerDay: d.newPerDay ?? null,
        showIpa: typeof d.showIpa === "boolean" ? d.showIpa : null,
        cardRecords: d.records.map(pickRecord),
        reviewLogs: d.logs.map(pickLog),
      })),
    };
  }

  function counts(backup) {
    let cards = 0, logs = 0;
    for (const d of backup.decks) { cards += d.cardRecords.length; logs += d.reviewLogs.length; }
    return { decks: backup.decks.length, cards, logs };
  }

  // ---- 読み込み用: 読み込んだ JSON を検査する ----
  // 戻り値: { ok: true, backup } または { ok: false, error: 画面に出す文 }
  function validate(input) {
    if (!isObj(input) || input.app !== APP) {
      return { ok: false, error: "anki-pwa のバックアップファイルではありません" };
    }
    if (!isInt(input.schemaVersion) || input.schemaVersion < 1) {
      return { ok: false, error: "バックアップのバージョンが読み取れません" };
    }
    if (input.schemaVersion > SCHEMA_VERSION) {
      return { ok: false, error: "このバックアップは新しいバージョンのアプリで作られています。アプリを更新してから読み込んでください" };
    }

    let data = input;
    for (let v = input.schemaVersion; v < SCHEMA_VERSION; v++) {
      if (!MIGRATIONS[v]) return { ok: false, error: `バックアップのバージョン ${v} は変換できません` };
      data = MIGRATIONS[v](data);
    }

    if (!isNum(data.exportedAt)) return { ok: false, error: "書き出した日時が読み取れません" };
    if (!Array.isArray(data.decks)) return { ok: false, error: "デッキの一覧が読み取れません" };

    const seen = new Set();
    const decks = [];
    for (const [i, d] of data.decks.entries()) {
      const at = `decks[${i}]`;
      if (!isObj(d) || typeof d.id !== "string" || d.id === "" || typeof d.name !== "string") {
        return { ok: false, error: `${at} の形式が正しくありません` };
      }
      if (seen.has(d.id)) return { ok: false, error: `${at} のデッキ ID が重複しています` };
      seen.add(d.id);
      if (d.newPerDay != null && (!isInt(d.newPerDay) || d.newPerDay < 0 || d.newPerDay > 999)) {
        return { ok: false, error: `${at} の新規上限が正しくありません` };
      }
      if (d.showIpa != null && typeof d.showIpa !== "boolean") {
        return { ok: false, error: `${at} の IPA 表示の設定が正しくありません` };
      }
      if (!Array.isArray(d.cardRecords) || !Array.isArray(d.reviewLogs)) {
        return { ok: false, error: `${at} の学習記録が読み取れません` };
      }
      const cardRecords = [];
      for (const [j, r] of d.cardRecords.entries()) {
        const c = cleanRecord(r);
        if (!c) return { ok: false, error: `${at}.cardRecords[${j}] の形式が正しくありません` };
        cardRecords.push(c);
      }
      const reviewLogs = [];
      for (const [j, l] of d.reviewLogs.entries()) {
        const c = cleanLog(l);
        if (!c) return { ok: false, error: `${at}.reviewLogs[${j}] の形式が正しくありません` };
        reviewLogs.push(c);
      }
      decks.push({ id: d.id, name: d.name, newPerDay: d.newPerDay ?? null, showIpa: d.showIpa ?? null, cardRecords, reviewLogs });
    }

    return {
      ok: true,
      backup: { app: APP, schemaVersion: SCHEMA_VERSION, exportedAt: data.exportedAt, decks },
    };
  }

  // ---- 統合: 「新しいほうを残して、何も失わない」 ----
  // 最後に回答した時刻(last_review)が、バックアップのほうが厳密に新しいときだけ置き換える。
  // 同じ・端末のほうが新しいときは端末のものを残す。端末に記録が無ければ追加する。
  const lastReviewOf = (r) => (r && r.last_review != null ? r.last_review : -Infinity);
  const isNewer = (incoming, existing) => !existing || lastReviewOf(incoming) > lastReviewOf(existing);

  // backup: validate 済み。
  // local: 端末の全デッキ [{ id, name, newPerDay, showIpa, records, logs, cardIds }]
  //   records/logs/cardIds が要るのは、バックアップにも含まれるデッキだけ。
  //   cardIds = そのデッキ(.apkg)に実在するカード ID の Set。
  // 戻り値: { decks: デッキごとの結果, totals, writes: { records, logs, newPerDay, showIpa }, hasChanges }
  function plan(backup, local) {
    const localById = new Map(local.map((d) => [d.id, d]));
    const writes = { records: [], logs: [], newPerDay: [], showIpa: [] };
    const decks = [];
    const totals = {
      recordsApply: 0, recordsKeep: 0, logsAdd: 0, logsDup: 0,
      orphanCards: 0, orphanLogs: 0, missingDecks: 0, missingRecords: 0,
    };

    for (const bd of backup.decks) {
      const ld = localById.get(bd.id);

      // 端末にデッキが無い: 何も書かずにスキップ(先に .apkg の取り込みが必要)
      if (!ld) {
        const same = local.find((d) => d.name === bd.name);
        decks.push({
          id: bd.id, name: bd.name, status: "missing",
          sameNameDeckId: same ? same.id : null,
          recordCount: bd.cardRecords.length, logCount: bd.reviewLogs.length,
        });
        totals.missingDecks++;
        totals.missingRecords += bd.cardRecords.length;
        continue;
      }
      if (!(ld.cardIds instanceof Set)) {
        throw new Error(`デッキ「${ld.name}」のカード一覧が渡されていません`);
      }

      const orphan = new Set(); // 端末のデッキに無いカードの ID(記録・履歴の両方)
      const d = {
        id: bd.id, name: ld.name, status: "ok",
        recordsApply: 0, recordsKeep: 0, logsAdd: 0, logsDup: 0,
        orphanCards: 0, orphanLogs: 0, newPerDayApplied: null, showIpaApplied: null,
      };

      // バックアップ内に同じカードが複数あれば、新しいほうだけを使う
      const best = new Map();
      for (const r of bd.cardRecords) {
        if (!ld.cardIds.has(r.cardId)) { orphan.add(r.cardId); continue; }
        if (isNewer(r, best.get(r.cardId))) best.set(r.cardId, r);
      }
      const localRecs = new Map(ld.records.map((r) => [r.cardId, r]));
      for (const r of best.values()) {
        if (isNewer(r, localRecs.get(r.cardId))) {
          writes.records.push({ ...r, deckId: bd.id });
          d.recordsApply++;
        } else {
          d.recordsKeep++;
        }
      }

      // 回答履歴: (カード, 回答時刻)が同じものは重複として追加しない
      const logKeys = new Set(ld.logs.map((l) => `${l.cardId}|${l.review}`));
      for (const l of bd.reviewLogs) {
        if (!ld.cardIds.has(l.cardId)) { orphan.add(l.cardId); d.orphanLogs++; continue; }
        const key = `${l.cardId}|${l.review}`;
        if (logKeys.has(key)) { d.logsDup++; continue; }
        logKeys.add(key);
        writes.logs.push({ ...l, deckId: bd.id });
        d.logsAdd++;
      }

      // 新規の1日の上限: 端末に設定が無いときだけ反映する
      if (bd.newPerDay != null && ld.newPerDay == null) {
        writes.newPerDay.push({ deckId: bd.id, value: bd.newPerDay });
        d.newPerDayApplied = bd.newPerDay;
      }

      // IPA の表示: 同じく、端末に設定が無いときだけ反映する
      if (typeof bd.showIpa === "boolean" && ld.showIpa == null) {
        writes.showIpa.push({ deckId: bd.id, value: bd.showIpa });
        d.showIpaApplied = bd.showIpa;
      }

      d.orphanCards = orphan.size;
      decks.push(d);
      totals.recordsApply += d.recordsApply;
      totals.recordsKeep += d.recordsKeep;
      totals.logsAdd += d.logsAdd;
      totals.logsDup += d.logsDup;
      totals.orphanCards += d.orphanCards;
      totals.orphanLogs += d.orphanLogs;
    }

    const hasChanges =
      writes.records.length > 0 || writes.logs.length > 0 || writes.newPerDay.length > 0 || writes.showIpa.length > 0;
    return { decks, totals, writes, hasChanges };
  }

  // 確認画面・結果に出す文章。done=false なら「〜します」、true なら「〜しました」
  function describe(p, { done }) {
    const n = (x) => x.toLocaleString("ja-JP");
    const lines = [];
    for (const d of p.decks) {
      if (d.status === "missing") {
        lines.push(`「${d.name}」: 端末に無いためスキップ(カード記録 ${n(d.recordCount)} 枚)。先に .apkg を取り込んでください。`);
        if (d.sameNameDeckId) {
          lines.push("  ⚠ 同じ名前のデッキが端末にありますが ID が違います。デッキを作り直した可能性があります。");
        }
        continue;
      }
      lines.push(`「${d.name}」`);
      lines.push(`  カード記録: ${n(d.recordsApply)} 枚を反映${done ? "しました" : "します"}` +
        (d.recordsKeep ? ` / ${n(d.recordsKeep)} 枚は端末のほうが新しいのでそのまま` : ""));
      lines.push(`  回答履歴: ${n(d.logsAdd)} 件を追加${done ? "しました" : "します"}` +
        (d.logsDup ? ` (${n(d.logsDup)} 件は登録済み)` : ""));
      if (d.newPerDayApplied != null) lines.push(`  新規カード/日: ${d.newPerDayApplied} を反映${done ? "しました" : "します"}`);
      if (d.showIpaApplied != null) lines.push(`  IPA の表示: ${d.showIpaApplied ? "表示する" : "表示しない"} を反映${done ? "しました" : "します"}`);
      if (d.orphanCards > 0) {
        lines.push(`  ⚠ ${n(d.orphanCards)} 枚は該当カードなしでスキップ` +
          (d.orphanLogs ? `(履歴 ${n(d.orphanLogs)} 件を含む)` : "") +
          "。デッキを作り直すとカード ID が変わることがあります。");
      }
    }
    return lines.join("\n");
  }

  return { SCHEMA_VERSION, build, counts, validate, plan, describe, isNewer };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Backup;
