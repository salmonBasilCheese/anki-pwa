"use strict";

// ---------------------------------------------------------------
// 学習記録のバックアップ(書き出し・読み込み)の、計算だけを行う部分。
// IndexedDB や画面には触れない。ブラウザではグローバル `Backup`、Node では
// require("./backup.js") で使える(tools/check_backup.mjs がテストする)。
//
// バックアップファイル(JSON) schemaVersion 2
//   { app: "anki-pwa-backup", schemaVersion: 2, exportedAt: ms,
//     decks: [ { id, name, newPerDay: 整数|null, showIpa: true|false|null, fontScale: FONT_SCALES のどれか|null(古い版の 1.4 は 1.2 に丸める),
//                layout: { front: [フィールド名], back: [フィールド名] }|null(showIpa・fontScale・layout は省略可。古いファイルには無い),
//                autoPlay: true|false|null(省略可),
//                cardRecords: [ srs.js の record(形は srs.js の先頭コメント。deckId は持たない) ],
//                unlinkedRecords: [ どのカードにも結び付かない記録(形は cardRecords と同じ。省略可) ],
//                reviewLogs:  [ 回答履歴(deckId・自動採番の id は持たない) ] } ] }
// cardId は、カードキー(note の guid。relink.js)の文字列か、古い版の数値のカード ID。
// version 1 → 2: cardId が数値だけだった。読み込むときに .apkg を見てカードキーに直す(plan)。
// 含めないもの: .apkg 本体・教材の中身(カードの内容)。
//
// バックアップの形を変えるときは SCHEMA_VERSION を上げ、MIGRATIONS に
// 「1 → 2 に変換する関数」を足す(古いファイルも読めるように)。
// ---------------------------------------------------------------
const Backup = (() => {
  const APP = "anki-pwa-backup";
  const SCHEMA_VERSION = 2;
  // MIGRATIONS[n] は、schemaVersion n のデータを n+1 の形に変換して返す
  const MIGRATIONS = {
    // 1 → 2: 形は同じ(数値の cardId は読み込むときに plan が直す)。新しい項目は省略扱い
    1: (d) => ({ ...d, schemaVersion: 2 }),
  };
  // カードの文字の倍率の選択肢(app.js の設定画面と同じ。標準は 1)
  const FONT_SCALES = [0.85, 1, 1.2];
  // 選択肢に無い数(古い版にあった 1.4 など)は、いちばん近い選択肢に丸める。数でない・範囲外は null
  const normalizeFontScale = (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 3
      ? FONT_SCALES.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best))
      : null;

  const FONT_SCALE_LABELS = { 0.85: "小", 1: "中", 1.2: "大" };

  // 表示する項目の設定(デッキごと)。{ front: [フィールド名...], back: [...] }。表面には 1 つ以上要る。
  // 決まった形だけを取り出して返す。不正なら undefined(null は「設定なし」として null のまま通す)
  function cleanLayout(x) {
    if (x == null) return null;
    if (!isObj(x)) return undefined;
    const side = (a, min) => {
      if (!Array.isArray(a) || a.length < min || a.length > 30) return undefined;
      if (!a.every((n) => typeof n === "string" && n.length >= 1 && n.length <= 200)) return undefined;
      return [...new Set(a)];
    };
    const front = side(x.front, 1);
    const back = side(x.back, 0);
    return front && back ? { front, back } : undefined;
  }

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const isInt = (x) => Number.isSafeInteger(x);
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  // カードの識別: カードキー(文字列)か、古い版の数値のカード ID
  const isCardId = (x) => isInt(x) || (typeof x === "string" && x.length >= 1 && x.length <= 200);

  // ---- 1件ずつの検査。決まった項目だけを取り出して返す(余計な項目は捨てる)。不正なら null ----
  function cleanRecord(r) {
    if (!isObj(r)) return null;
    if (!isCardId(r.cardId)) return null;
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
    if (!isCardId(l.cardId)) return null;
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
  // decks: [{ id, name, newPerDay, showIpa, fontScale, layout, autoPlay, records, unlinked, logs }]
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
        fontScale: normalizeFontScale(d.fontScale),
        layout: cleanLayout(d.layout) ?? null,
        autoPlay: typeof d.autoPlay === "boolean" ? d.autoPlay : null,
        cardRecords: d.records.map(pickRecord),
        unlinkedRecords: (d.unlinked ?? []).map(pickRecord),
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
      if (d.fontScale != null && normalizeFontScale(d.fontScale) === null) {
        return { ok: false, error: `${at} の文字サイズの設定が正しくありません` };
      }
      if (cleanLayout(d.layout) === undefined) {
        return { ok: false, error: `${at} の表示項目の設定が正しくありません` };
      }
      if (d.autoPlay != null && typeof d.autoPlay !== "boolean") {
        return { ok: false, error: `${at} の音声の自動再生の設定が正しくありません` };
      }
      if (d.unlinkedRecords != null && !Array.isArray(d.unlinkedRecords)) {
        return { ok: false, error: `${at} の結び付かない記録が読み取れません` };
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
      const unlinkedRecords = [];
      for (const [j, r] of (d.unlinkedRecords ?? []).entries()) {
        const c = cleanRecord(r);
        if (!c) return { ok: false, error: `${at}.unlinkedRecords[${j}] の形式が正しくありません` };
        unlinkedRecords.push(c);
      }
      const reviewLogs = [];
      for (const [j, l] of d.reviewLogs.entries()) {
        const c = cleanLog(l);
        if (!c) return { ok: false, error: `${at}.reviewLogs[${j}] の形式が正しくありません` };
        reviewLogs.push(c);
      }
      decks.push({ id: d.id, name: d.name, newPerDay: d.newPerDay ?? null, showIpa: d.showIpa ?? null, fontScale: normalizeFontScale(d.fontScale), layout: cleanLayout(d.layout), autoPlay: d.autoPlay ?? null, cardRecords, unlinkedRecords, reviewLogs });
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
  // local: 端末の全デッキ [{ id, name, newPerDay, showIpa, fontScale, layout, autoPlay, records, logs, unlinked, cards }]
  //   records/logs/unlinked/cards が要るのは、バックアップにも含まれるデッキだけ。
  //   cards = そのデッキ(.apkg)のカード [{ key: カードキー, cid: 数値のカード ID }]。
  // バックアップの cardId(カードキーか数値の ID)は cards で今のカードキーに直す。
  // どのカードにも結び付かない記録は捨てずに writes.unlinked(結び付かない記録の置き場)に入れる。
  // 戻り値: { decks: デッキごとの結果, totals, writes: { records, unlinked, logs, newPerDay, showIpa, fontScale, layout, autoPlay }, hasChanges }
  function plan(backup, local) {
    const localById = new Map(local.map((d) => [d.id, d]));
    const writes = { records: [], unlinked: [], logs: [], newPerDay: [], showIpa: [], fontScale: [], layout: [], autoPlay: [] };
    const decks = [];
    const totals = {
      recordsApply: 0, recordsKeep: 0, logsAdd: 0, logsDup: 0,
      orphanCards: 0, orphanLogs: 0, unlinkedAdd: 0, missingDecks: 0, missingRecords: 0,
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
      if (!Array.isArray(ld.cards)) {
        throw new Error(`デッキ「${ld.name}」のカード一覧が渡されていません`);
      }
      const keys = new Set(ld.cards.map((c) => c.key));
      const byCid = new Map(ld.cards.map((c) => [c.cid, c.key]));
      // 今のカードキーに直す。結び付かなければ null
      const resolve = (id) => (typeof id === "string" ? (keys.has(id) ? id : null) : byCid.get(id) ?? null);

      const orphan = new Set(); // 端末のデッキに無いカードの ID(記録・履歴の両方)
      const d = {
        id: bd.id, name: ld.name, status: "ok",
        recordsApply: 0, recordsKeep: 0, logsAdd: 0, logsDup: 0,
        orphanCards: 0, orphanLogs: 0, unlinkedAdd: 0,
        newPerDayApplied: null, showIpaApplied: null, fontScaleApplied: null, layoutApplied: false, autoPlayApplied: null,
      };

      // 結び付かない記録は、端末の置き場に同じもの(カード ID と最後に答えた日が同じ)が無ければ足す
      const unlinkedSeen = new Set(ld.unlinked.map((r) => `${r.cardId}|${r.last_review}`));
      const keepUnlinked = (r) => {
        const k = `${r.cardId}|${r.last_review}`;
        if (unlinkedSeen.has(k)) return;
        unlinkedSeen.add(k);
        writes.unlinked.push({ ...r, deckId: bd.id });
        d.unlinkedAdd++;
      };

      // バックアップ内に同じカードが複数あれば、新しいほうだけを使う。負けた記録も置き場に残す
      const best = new Map();
      for (const r of [...bd.cardRecords, ...bd.unlinkedRecords]) {
        const key = resolve(r.cardId);
        if (key === null) { orphan.add(r.cardId); keepUnlinked(r); continue; }
        const prev = best.get(key);
        if (isNewer(r, prev)) { if (prev) keepUnlinked(prev); best.set(key, r); } else keepUnlinked(r);
      }
      const localRecs = new Map(ld.records.map((r) => [resolve(r.cardId) ?? r.cardId, r]));
      for (const [key, r] of best) {
        if (isNewer(r, localRecs.get(key))) {
          writes.records.push({ ...r, cardId: key, deckId: bd.id });
          d.recordsApply++;
        } else {
          d.recordsKeep++;
        }
      }
      // 置き換えられる端末の記録は、付け替え(relink)のときに使われなくなるだけで、ここでは消さない
      // (cardRecords の同じキーに上書きされる。上書きされる側は回答履歴に残っている)

      // 回答履歴: (カード, 回答時刻)が同じものは重複として追加しない。結び付かない履歴も元の ID のまま残す
      const logKeys = new Set(ld.logs.map((l) => `${resolve(l.cardId) ?? l.cardId}|${l.review}`));
      for (const l of bd.reviewLogs) {
        const key = resolve(l.cardId);
        if (key === null) { orphan.add(l.cardId); d.orphanLogs++; }
        const id = key ?? l.cardId;
        const k = `${id}|${l.review}`;
        if (logKeys.has(k)) { d.logsDup++; continue; }
        logKeys.add(k);
        writes.logs.push({ ...l, cardId: id, deckId: bd.id });
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

      // 文字サイズ: 同じく、端末に設定が無いときだけ反映する
      if (FONT_SCALES.includes(bd.fontScale) && ld.fontScale == null) {
        writes.fontScale.push({ deckId: bd.id, value: bd.fontScale });
        d.fontScaleApplied = bd.fontScale;
      }

      // 表示する項目: 同じく、端末に設定が無いときだけ反映する
      if (bd.layout && ld.layout == null) {
        writes.layout.push({ deckId: bd.id, value: bd.layout });
        d.layoutApplied = true;
      }

      // 音声の自動再生: 同じく、端末に設定が無いときだけ反映する
      if (typeof bd.autoPlay === "boolean" && ld.autoPlay == null) {
        writes.autoPlay.push({ deckId: bd.id, value: bd.autoPlay });
        d.autoPlayApplied = bd.autoPlay;
      }

      d.orphanCards = orphan.size;
      decks.push(d);
      totals.recordsApply += d.recordsApply;
      totals.recordsKeep += d.recordsKeep;
      totals.logsAdd += d.logsAdd;
      totals.logsDup += d.logsDup;
      totals.orphanCards += d.orphanCards;
      totals.orphanLogs += d.orphanLogs;
      totals.unlinkedAdd += d.unlinkedAdd;
    }

    const hasChanges = Object.values(writes).some((list) => list.length > 0);
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
      if (d.fontScaleApplied != null) lines.push(`  文字サイズ: ${FONT_SCALE_LABELS[d.fontScaleApplied]} を反映${done ? "しました" : "します"}`);
      if (d.layoutApplied) lines.push(`  表示する項目の設定を反映${done ? "しました" : "します"}`);
      if (d.autoPlayApplied != null) lines.push(`  音声の自動再生: ${d.autoPlayApplied ? "する" : "しない"} を反映${done ? "しました" : "します"}`);
      if (d.orphanCards > 0) {
        lines.push(`  ⚠ ${n(d.orphanCards)} 枚はデッキに該当するカードがありません。` +
          `消さずに「結び付かない記録」として保存${done ? "しました" : "します"}` +
          (d.unlinkedAdd ? `(新しく ${n(d.unlinkedAdd)} 件)` : "(保存済み)") + "。");
      }
    }
    return lines.join("\n");
  }

  return { SCHEMA_VERSION, cleanLayout, normalizeFontScale, FONT_SCALES, FONT_SCALE_LABELS, build, counts, validate, plan, describe, isNewer };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Backup;
