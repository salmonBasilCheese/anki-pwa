"use strict";

// ---------------------------------------------------------------
// 学習記録とカードの結び付け(付け替え)の、計算だけを行う部分。
// IndexedDB や画面には触れない。ブラウザではグローバル `Relink`、Node では
// require("./relink.js") で使える(tools/check_relink.mjs・check_storage.mjs がテストする)。
//
// カードの識別(カードキー)は note の guid。デッキを作り直しても guid は変わらないが、
// カード ID(cards.id)は作るたびに変わることがある。1つの note に複数のカードがあるときは
// 2枚目以降を "guid#ord" で区別する(今のデッキはすべて 1 note 1 カード)。
//
// 古い版の記録は cardId に数値のカード ID を持つ。付け替えで、デッキにあるカードの記録は
// cardId をカードキー(文字列)に書き換え、どのカードにも結び付かない記録は
// unlinkedRecords(結び付かない記録の置き場)に移す。消すことはしない。
// ---------------------------------------------------------------
const Relink = (() => {
  function cardKey(guid, ord) {
    return ord ? `${guid}#${ord}` : String(guid);
  }

  // .apkg のカードの行 [{ cid, ord, guid }] → [{ key, cid }](並び順はそのまま)。
  // guid が重なるカードが万一あっても開けるように、2 枚目以降は数値の ID を足して見分ける
  // (その分は作り直すと結び付かなくなるが、記録は置き場に残る)。
  function cardsFrom(rows) {
    const seen = new Set();
    return rows.map(({ cid, ord, guid }) => {
      let key = cardKey(guid, ord);
      if (seen.has(key)) key = `${key}@${cid}`;
      seen.add(key);
      return { key, cid };
    });
  }

  const lastReviewOf = (r) => (r && r.last_review != null ? r.last_review : -Infinity);

  // 結び付かなくなった古いカード ID を、今のデッキのカードに戻せるか調べる。
  // デッキを作るツール(genanki)は ID を「作った時刻(ms)から 1 ずつ」振り、1 note につき
  // note・カードの順に 2 つ使う。なので同じ回に作ったカードの ID は 2 ずつ離れ、
  // (ID − いちばん小さい ID) ÷ 2 が作った順番になる。新規カードは作った順に出すので、
  // 学習したカードの順番は 0 から途切れずに並ぶはず。これを全部満たすときだけ戻す。
  // cards: [{ key, cid }]  ids: 戻したい数値 ID
  // 戻り値: { map: Map(古い ID → カードキー), groups: [{ count, ok, reason }] }
  function recover(cards, ids) {
    const map = new Map();
    const groups = [];
    const uniq = [...new Set(ids)].filter((x) => Number.isSafeInteger(x)).sort((a, b) => a - b);
    if (uniq.length === 0) return { map, groups };

    const order = cards.filter((c) => Number.isSafeInteger(c.cid)).sort((a, b) => a.cid - b.cid);
    const n = order.length;
    const regular = n > 0 && n === cards.length && order.every((c, i) => c.cid === order[0].cid + 2 * i);
    if (!regular) {
      groups.push({ count: uniq.length, ok: false, reason: "今のデッキの ID の並びが決まった形ではない" });
      return { map, groups };
    }

    // 同じ回に作った ID は 2×枚数 の幅に収まる。それより離れた ID は別の回に作ったものとして分ける
    const clusters = [];
    for (const id of uniq) {
      const last = clusters[clusters.length - 1];
      if (last && id - last[0] < 2 * n) last.push(id); else clusters.push([id]);
    }
    for (const ids1 of clusters) {
      const base = ids1[0];
      const idx = ids1.map((id) => (id - base) / 2);
      let reason = null;
      if (!idx.every((i) => Number.isInteger(i))) reason = "ID の間隔が 2 ずつになっていない";
      else if (idx[idx.length - 1] !== idx.length - 1) reason = "学習した順番が 0 から途切れずに並んでいない";
      groups.push({ count: ids1.length, ok: !reason, reason });
      if (reason) continue;
      ids1.forEach((id, j) => map.set(id, order[idx[j]].key));
    }
    return { map, groups };
  }

  // 1 つのデッキの付け替え計画。
  //  cards: 今のデッキのカード [{ key, cid }](並び順は問わない)
  //  records: cardRecords にある、このデッキの記録(cardId は数値かカードキー)
  //  unlinked: unlinkedRecords にある、このデッキの記録({ uid, ... })
  // 戻り値:
  //  recordsDelete: cardRecords から消す cardId / recordsPut: cardRecords に書く記録(cardId はカードキー)
  //  unlinkedDelete: unlinkedRecords から消す uid / unlinkedAdd: unlinkedRecords に足す記録
  //  logKey: Map(数値のカード ID → カードキー)。回答履歴の書き換えに使う
  //  stats: { linked, converted, recovered, restored, unlinked, conflicts }, groups: recover の結果
  // 先に recordsDelete を、そのあと recordsPut を行うこと(同じキーを消して書き直すことがあるため)。
  function plan({ cards, records, unlinked }) {
    const keys = new Set(cards.map((c) => c.key));
    const byCid = new Map(cards.map((c) => [c.cid, c.key]));
    const direct = (id) => (typeof id === "string" ? (keys.has(id) ? id : null) : byCid.get(id) ?? null);

    const cands = [
      ...records.map((row) => ({ row, from: "rec" })),
      ...unlinked.map((row) => ({ row, from: "unl" })),
    ];
    const missing = cands.filter((c) => direct(c.row.cardId) === null && typeof c.row.cardId === "number");
    const rec = recover(cards, missing.map((c) => c.row.cardId));
    const resolve = (id) => direct(id) ?? (typeof id === "number" ? rec.map.get(id) ?? null : null);

    const out = {
      recordsDelete: [], recordsPut: [], unlinkedDelete: [], unlinkedAdd: [],
      logKey: new Map([...byCid, ...rec.map]),
      stats: { linked: 0, converted: 0, recovered: 0, restored: 0, unlinked: 0, conflicts: 0 },
      groups: rec.groups,
    };
    const strip = ({ uid, ...r }) => r;

    // カードキーごとにまとめ、最後に答えた日が新しい記録を使う。
    // 同じなら、今 cardRecords にあって正しく結び付いている記録 → cardRecords の記録 → 置き場の記録 の順に優先
    const groups = new Map();
    for (const c of cands) {
      const key = resolve(c.row.cardId);
      if (key === null) {
        out.stats.unlinked++;
        if (c.from === "rec") { out.recordsDelete.push(c.row.cardId); out.unlinkedAdd.push(strip(c.row)); }
        continue;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const rank = (c, key) => (c.from === "rec" && c.row.cardId === key ? 0 : c.from === "rec" ? 1 : 2);
    for (const [key, list] of groups) {
      list.sort((a, b) => lastReviewOf(b.row) - lastReviewOf(a.row) || rank(a, key) - rank(b, key));
      const [win, ...lose] = list;
      out.stats.linked++;
      if (lose.length) out.stats.conflicts++;
      if (!(win.from === "rec" && win.row.cardId === key)) {
        if (win.from === "rec") out.recordsDelete.push(win.row.cardId);
        else out.unlinkedDelete.push(win.row.uid);
        out.recordsPut.push({ ...strip(win.row), cardId: key });
        if (win.from === "unl") out.stats.restored++;
        else if (rec.map.has(win.row.cardId)) out.stats.recovered++;
        else out.stats.converted++;
      }
      // 使わなかった記録も消さずに置き場に残す(置き場にあるものはそのまま)
      for (const c of lose) {
        if (c.from === "rec") { out.recordsDelete.push(c.row.cardId); out.unlinkedAdd.push(strip(c.row)); }
      }
    }
    return out;
  }

  return { cardKey, cardsFrom, recover, plan };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Relink;
