"use strict";

// ---------------------------------------------------------------
// 復習のロジック(DOM に依存しない)。グローバル `Srs` として公開する。
// 次回復習日の計算は ts-fsrs(グローバル `FSRS`)。
//
// カードの学習記録(record)の形 — 日時はすべて ms の数値:
//   {deckId, cardId, state, due, stability, difficulty,
//    scheduled_days, learning_steps, reps, lapses, last_review}
// 記録が無いカードは「新規」。
// ---------------------------------------------------------------

// 調整したい値はここ
const SRS_CONFIG = {
  dayStartHour: 4,        // 1日の区切り(Anki と同じ午前4時)
  defaultNewPerDay: 20,   // 新規カードの1日の上限の初期値(デッキごとに変更可)
  learnAheadMinutes: 20,  // 他に出すカードが無いとき、これ以内に期限が来る学習中カードを先出しする
};

// ts-fsrs のパラメータ。学習ステップは既定値(1分, 10分 / 再学習 10分)。
// fuzz をオフにしているので、同じ操作なら結果は毎回同じになる。
const FSRS_PARAMS = {
  request_retention: 0.9,
  enable_fuzz: false,
};

const Srs = (() => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  let offsetMs = 0; // デバッグ用に時刻を進める量
  let scheduler = null;

  const S = () => FSRS.State; // New=0, Learning=1, Review=2, Relearning=3
  const getScheduler = () => (scheduler ??= FSRS.fsrs(FSRS_PARAMS));

  // -------------------------------------------------------------
  // 時計と「1日の区切り」
  // -------------------------------------------------------------
  const now = () => Date.now() + offsetMs;
  const setOffset = (ms) => { offsetMs = ms; };
  const getOffset = () => offsetMs;

  // 午前4時区切りの「日」の通し番号(ローカル時間)
  function dayIndex(ms) {
    const d = new Date(ms - SRS_CONFIG.dayStartHour * HOUR);
    return Math.floor((d.getTime() - d.getTimezoneOffset() * MIN) / DAY);
  }
  // ms が属する日の開始時刻(その日の午前4時)
  function dayStart(ms) {
    const d = new Date(ms - SRS_CONFIG.dayStartHour * HOUR);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), SRS_CONFIG.dayStartHour).getTime();
  }
  // 次の午前4時
  function nextDayStart(ms) {
    const d = new Date(ms - SRS_CONFIG.dayStartHour * HOUR);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, SRS_CONFIG.dayStartHour).getTime();
  }

  // -------------------------------------------------------------
  // record <-> ts-fsrs の Card
  // -------------------------------------------------------------
  function toFsrsCard(rec) {
    return {
      due: new Date(rec.due),
      stability: rec.stability,
      difficulty: rec.difficulty,
      scheduled_days: rec.scheduled_days,
      learning_steps: rec.learning_steps,
      reps: rec.reps,
      lapses: rec.lapses,
      state: rec.state,
      last_review: rec.last_review == null ? undefined : new Date(rec.last_review),
    };
  }

  function fromFsrsCard(card, deckId, cardId) {
    return {
      deckId, cardId,
      state: card.state,
      due: card.due.getTime(),
      stability: card.stability,
      difficulty: card.difficulty,
      scheduled_days: card.scheduled_days,
      learning_steps: card.learning_steps,
      reps: card.reps,
      lapses: card.lapses,
      last_review: card.last_review ? card.last_review.getTime() : null,
    };
  }

  const baseCard = (rec, nowMs) =>
    rec ? toFsrsCard(rec) : FSRS.createEmptyCard(new Date(nowMs));

  // -------------------------------------------------------------
  // 回答と間隔表示
  // -------------------------------------------------------------
  function formatInterval(ms) {
    const min = ms / MIN;
    if (min < 1) return "1分未満";
    if (min < 60) return `${Math.round(min)}分`;
    const hours = min / 60;
    if (hours < 24) return `${Math.round(hours)}時間`;
    const days = hours / 24;
    if (days < 30) return `${Math.round(days)}日`;
    if (days < 365) return `${trim1(days / 30)}か月`;
    return `${trim1(days / 365)}年`;
  }
  const trim1 = (x) => String(Math.round(x * 10) / 10);

  // 4つのボタン(1=もう一度 2=難しい 3=正解 4=簡単)を押した場合の次回間隔の表示
  function labels(rec, nowMs) {
    const preview = getScheduler().repeat(baseCard(rec, nowMs), new Date(nowMs));
    const out = {};
    for (const g of [1, 2, 3, 4]) {
      out[g] = formatInterval(preview[g].card.due.getTime() - nowMs);
    }
    return out;
  }

  // 回答した結果の新しい record と、回答履歴(log)を返す。log は ts-fsrs の
  // ReviewLog(回答前の状態を持つ)に deckId/cardId を足したもの。
  function answer(rec, deckId, cardId, grade, nowMs) {
    const r = getScheduler().repeat(baseCard(rec, nowMs), new Date(nowMs))[grade];
    return {
      record: fromFsrsCard(r.card, deckId, cardId),
      log: {
        deckId, cardId,
        rating: r.log.rating,
        state: r.log.state, // 回答前の状態(New なら新規カードの導入)
        due: r.log.due.getTime(),
        stability: r.log.stability,
        difficulty: r.log.difficulty,
        scheduled_days: r.log.scheduled_days,
        learning_steps: r.log.learning_steps,
        review: nowMs,
      },
    };
  }

  // -------------------------------------------------------------
  // セッション(1デッキ分の出題状態)
  // cards: 並び順どおりの [{id, ...}]  records: 既存の学習記録の配列
  // newToday: 今日すでに導入した新規カード数
  // -------------------------------------------------------------
  function createSession({ cards, records, newPerDay, newToday, nowMs }) {
    const recs = new Map(records.map((r) => [r.cardId, r]));
    return {
      records: recs,
      unseen: cards.filter((c) => !recs.has(c.id)).map((c) => c.id), // 新規(並び順)
      newPerDay,
      newToday,
      dayIdx: dayIndex(nowMs),
    };
  }

  const isLearning = (r) => r.state === S().Learning || r.state === S().Relearning;

  // 日付をまたいだら、今日の新規導入数は 0 から数え直す
  function rollDay(session, nowMs) {
    const d = dayIndex(nowMs);
    if (d !== session.dayIdx) { session.dayIdx = d; session.newToday = 0; }
  }

  const earliest = (list) =>
    list.reduce((best, r) => (!best || r.due < best.due || (r.due === best.due && r.cardId < best.cardId) ? r : best), null);

  // 次に出すカードを選ぶ。順序: 復習(今日が期限) → 学習中(期限が来たもの) → 新規 → 学習中(先読み)
  // 戻り値: { cardId, kind: "review"|"learning"|"new", record } か、終了なら null
  function pickNext(session, nowMs) {
    rollDay(session, nowMs);
    const today = session.dayIdx;
    const all = [...session.records.values()];

    const review = earliest(all.filter((r) => r.state === S().Review && dayIndex(r.due) <= today));
    if (review) return { cardId: review.cardId, kind: "review", record: review };

    const learning = earliest(all.filter((r) => isLearning(r) && r.due <= nowMs));
    if (learning) return { cardId: learning.cardId, kind: "learning", record: learning };

    if (session.newToday < session.newPerDay && session.unseen.length > 0) {
      return { cardId: session.unseen[0], kind: "new", record: null };
    }

    const ahead = earliest(
      all.filter((r) => isLearning(r) && r.due <= nowMs + SRS_CONFIG.learnAheadMinutes * MIN)
    );
    if (ahead) return { cardId: ahead.cardId, kind: "learning", record: ahead };

    return null;
  }

  // 画面上部の残り枚数
  function counts(session, nowMs) {
    rollDay(session, nowMs);
    const today = session.dayIdx;
    const end = nextDayStart(nowMs);
    let review = 0, learning = 0;
    for (const r of session.records.values()) {
      if (r.state === S().Review && dayIndex(r.due) <= today) review++;
      else if (isLearning(r) && r.due < end) learning++;
    }
    const newLeft = Math.max(0, Math.min(session.newPerDay - session.newToday, session.unseen.length));
    return { new: newLeft, learning, review };
  }

  // 今日中に期限が来るが、今はまだ出せない学習中カード(先読みの時間より後)。
  // 戻り値: { count, nextDue }。nextDue はいちばん早い期限(ms)、無ければ null
  function later(session, nowMs) {
    const from = nowMs + SRS_CONFIG.learnAheadMinutes * MIN;
    const end = nextDayStart(nowMs);
    let count = 0, nextDue = null;
    for (const r of session.records.values()) {
      if (isLearning(r) && r.due > from && r.due < end) {
        count++;
        if (nextDue === null || r.due < nextDue) nextDue = r.due;
      }
    }
    return { count, nextDue };
  }

  // デッキ一覧に出す今日の枚数。セッションを作らずに、学習記録と未学習の枚数だけで数える。
  // 戻り値: { now: 今すぐできる枚数, later: あとで出る枚数, nextDue: あとで出るいちばん早い期限 }
  function remaining({ records, unseenCount, newPerDay, newToday, nowMs }) {
    const session = {
      records: new Map(records.map((r) => [r.cardId, r])),
      unseen: { length: unseenCount },
      newPerDay, newToday, dayIdx: dayIndex(nowMs),
    };
    const c = counts(session, nowMs);
    const l = later(session, nowMs);
    return { now: c.new + c.learning + c.review - l.count, later: l.count, nextDue: l.nextDue };
  }

  // 回答結果をセッションに反映する(DB への保存に成功したあとで呼ぶ)
  function applyAnswer(session, record, log, nowMs) {
    rollDay(session, nowMs);
    session.records.set(record.cardId, record);
    if (log.state === S().New) {
      const i = session.unseen.indexOf(record.cardId);
      if (i >= 0) session.unseen.splice(i, 1);
      session.newToday++;
    }
  }

  return {
    now, setOffset, getOffset,
    dayIndex, dayStart, nextDayStart,
    labels, answer, formatInterval,
    createSession, pickNext, counts, later, remaining, applyAnswer,
  };
})();
