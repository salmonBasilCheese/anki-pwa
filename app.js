"use strict";

// スピーカーのアイコン(固定のSVG。ユーザーのデータは含まない)
const AUDIO_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";
// 開発版は localStorage のキーも分ける(同じオリジンの安定版と共有しないため)
const IS_DEV = DeckStore.channel === "dev";
const KEY_PREFIX = IS_DEV ? "dev-" : "";
const DEBUG_OFFSET_KEY = KEY_PREFIX + "anki-pwa-debug-offset-ms";

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file"), status: $("status"), viewer: $("viewer"),
  deckInfo: $("deck-info"), card: $("card"), front: $("front"), back: $("back"),
  library: $("library"), deckList: $("deck-list"), version: $("app-version"),
  persistStatus: $("persist-status"), backToLibrary: $("back-to-library"),
  study: $("study"), showAnswer: $("show-answer"), grades: $("grades"),
  gradeButtons: [...document.querySelectorAll(".grade")],
  counts: { new: $("count-new"), learning: $("count-learning"), review: $("count-review") },
  countBoxes: [...document.querySelectorAll(".count")],
  done: $("done"), doneTitle: $("done-title"), doneNote: $("done-note"),
  doneLater: $("done-later"), doneLaterMain: $("done-later-main"),
  backupLast: $("backup-last"), backupExport: $("backup-export"), backupImport: $("backup-import"),
  backupFile: $("backup-file"), backupResult: $("backup-result"),
  debug: $("debug"), debugClock: $("debug-clock"), debugViewport: $("debug-viewport"),
};

const state = {
  deckId: null,           // 学習中のデッキID(保存済みデッキのキー)
  zip: null,
  mediaByName: new Map(), // "example_0001.mp3" -> "123"(zip内のファイル名)
  cards: [],              // 並び順どおりの { id, fields: {フィールド名: 値} }
  cardById: new Map(),
  session: null,          // srs.js のセッション(出題状態)
  showIpa: true,          // 学習中のデッキで IPA を表示するか(デッキごとの設定)
  learnedOtherDecks: 0,   // 学習中以外のデッキで、すでに学習したカードの数
  profile: null,          // 学習中のデッキの種類(profiles.js)
  layout: null,           // 表裏に出すフィールド名 { front: [...], back: [...] }(初期設定)
  current: null,          // 今出しているカード { cardId, kind, record, card }
  revealed: false,
  busy: false,            // 回答の保存中
  audioUrls: new Map(),   // 現在のカードで作った Blob URL
  player: null,
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

// 信頼できないHTMLは必ずここを通す
function setHtml(el, html) {
  el.innerHTML = DOMPurify.sanitize(html);
}

// ---------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------
// .apkg(Blob)を展開して中身を読む。画面や state は触らない(保存前の検証にも使う)。
// 戻り値: { zip, mediaByName, cards, deck: {id, name, cardCount}, deckLabel, fieldNames, profile(合わなければ null) }
async function parseApkg(blob) {
  const zip = await JSZip.loadAsync(blob);

  const dbEntry = zip.file("collection.anki21");
  if (!dbEntry) {
    throw new Error("collection.anki21 が見つかりません(この形式は未対応です)");
  }

  setStatus("データベースを開いています...");
  const SQL = await initSqlJs({ locateFile: (f) => "lib/" + f });
  const db = new SQL.Database(await dbEntry.async("uint8array"));

  try {
    return { zip, ...(await readCollection(db, zip)) };
  } finally {
    db.close();
  }
}

async function readCollection(db, zip) {
  // media: { "0": "example_0001.mp3", ... } を逆引きにする
  const mediaByName = new Map();
  const mediaEntry = zip.file("media");
  if (mediaEntry) {
    const mediaJson = JSON.parse(await mediaEntry.async("string"));
    for (const [num, name] of Object.entries(mediaJson)) {
      mediaByName.set(name, num);
    }
  }

  const [modelsJson, decksJson] = db.exec("SELECT models, decks FROM col")[0].values[0];
  const models = JSON.parse(modelsJson);
  const decks = JSON.parse(decksJson);

  // デッキ名は cards.did が指すデッキから取る(Default を拾わない)
  const didRows = db.exec(
    "SELECT did, COUNT(*) FROM cards GROUP BY did ORDER BY COUNT(*) DESC"
  )[0]?.values ?? [];
  if (didRows.length === 0) throw new Error("カードがありません");
  const deckNames = didRows.map(([did, n]) => {
    const name = decks[String(did)]?.name ?? `(不明なデッキ ${did})`;
    return didRows.length > 1 ? `${name} (${n}枚)` : name;
  });
  const total = didRows.reduce((sum, [, n]) => sum + n, 0);
  const deckLabel = `${deckNames.join(" / ")} ・ ${total}枚`;

  // 保存用のデッキ識別: カード数が最多のデッキの id と名前
  const mainId = String(didRows[0][0]);
  const deck = {
    id: mainId,
    name: decks[mainId]?.name ?? `(不明なデッキ ${mainId})`,
    cardCount: total,
  };

  // ノートタイプごとに フィールド名 -> 位置 を作る
  const fieldNames = new Map(); // mid(string) -> [名前...]
  for (const [mid, model] of Object.entries(models)) {
    fieldNames.set(mid, model.flds.map((f) => f.name));
  }

  // 新規カードの並びは Anki と同じ cards.due(新規の出題位置)順、同値は id 順
  const rows = db.exec(
    "SELECT c.id, n.mid, n.flds FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.due, c.id"
  )[0].values;

  const cards = rows.map(([id, mid, flds]) => {
    const names = fieldNames.get(String(mid)) ?? [];
    const values = String(flds).split("\x1f");
    const fields = {};
    names.forEach((name, i) => { fields[name] = values[i] ?? ""; });
    return { id, fields };
  });

  // 項目名からデッキの種類(profiles.js)を選ぶ。合わなければ取り込むとき・開くときに止める。
  const firstCardFields = Object.keys(cards[0].fields);
  const profile = pickProfile(firstCardFields);
  if (profile) deck.profile = profile.name;

  return { mediaByName, cards, deck, deckLabel, fieldNames: firstCardFields, profile };
}

// ---------------------------------------------------------------
// 保存済みデッキの一覧・取り込み・削除
// ---------------------------------------------------------------
function describeError(e) {
  if (e?.name === "QuotaExceededError") {
    return "保存容量が足りません。不要なデッキを削除するか、ブラウザの空き容量を確認してください。";
  }
  return e?.message ?? String(e);
}

async function renderLibrary() {
  const decks = await DeckStore.listDecks();

  // デッキごとの今日の枚数(今すぐできる枚数と、あとで出る学習中の枚数)
  const nowMs = Srs.now();
  const remainingById = new Map(await Promise.all(decks.map(async (d) => {
    const [records, newToday] = await Promise.all([
      DeckStore.getCardRecords(d.id),
      DeckStore.countNewSince(d.id, Srs.dayStart(nowMs), Srs.nextDayStart(nowMs)),
    ]);
    const left = Srs.remaining({
      records,
      unseenCount: Math.max(0, d.cardCount - d.learnedCount),
      newPerDay: d.newPerDay ?? SRS_CONFIG.defaultNewPerDay,
      newToday, nowMs,
    });
    return [d.id, left];
  })));
  // 今すぐできる枚数が多いデッキほど上に並べる。同じなら、あとで出る枚数が多い順
  // (どちらも同じなら、listDecks の「最後に開いた順」のまま)
  decks.sort((a, b) => {
    const x = remainingById.get(a.id), y = remainingById.get(b.id);
    return (y.now - x.now) || (y.later - x.later);
  });
  els.deckList.replaceChildren();

  if (decks.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "保存済みのデッキはありません。.apkg を選んでください。";
    els.deckList.appendChild(li);
    return;
  }

  for (const d of decks) {
    const li = document.createElement("li");
    li.className = "deck-row";

    // デッキ名はユーザー由来なので textContent で入れる
    const name = document.createElement("div");
    name.className = "deck-name";
    name.textContent = d.name;

    const meta = document.createElement("div");
    meta.className = "deck-meta";
    const left = remainingById.get(d.id);
    const parts = [];
    if (left.now > 0) parts.push(`今すぐ ${left.now}枚`);
    if (left.later > 0) parts.push(`あとで ${left.later}枚(あと${Srs.formatInterval(left.nextDue - nowMs)})`);
    meta.textContent = `学習済み ${d.learnedCount} / ${d.cardCount}枚 ・ ` + (parts.length ? parts.join(" ・ ") : "今日の分は完了");

    li.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "deck-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "open";
    openBtn.textContent = "開く";
    openBtn.addEventListener("click", () => openSaved(d.id));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => removeDeck(d));
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.textContent = "設定";
    settingsBtn.setAttribute("aria-expanded", "false");
    const panel = buildSettingsPanel(d);
    panel.hidden = true;
    settingsBtn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      settingsBtn.setAttribute("aria-expanded", String(!panel.hidden));
    });
    actions.append(openBtn, settingsBtn, delBtn);

    li.append(actions, panel);
    els.deckList.appendChild(li);
  }
}

// デッキごとの設定(「設定」ボタンで開く)。項目を足すときはここに並べる。
function buildSettingsPanel(d) {
  const panel = document.createElement("div");
  panel.className = "deck-settings";
  panel.append(buildLimitInput(d));
  if (profileByName(d.profile).ipa) panel.append(buildIpaToggle(d)); // IPA の無い種類では出さない
  panel.append(buildFontScaleSelect(d));
  return panel;
}

// カードの文字サイズ(デッキごと。未設定は標準)
function buildFontScaleSelect(d) {
  const label = document.createElement("label");
  label.className = "deck-limit";
  label.append("文字サイズ");
  const select = document.createElement("select");
  for (const v of Backup.FONT_SCALES) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = Backup.FONT_SCALE_LABELS[v];
    select.append(opt);
  }
  let saved = Backup.normalizeFontScale(d.fontScale) ?? 1;
  select.value = String(saved);
  select.addEventListener("change", async () => {
    const want = Number(select.value);
    try {
      await DeckStore.setFontScale(d.id, want);
      saved = want;
    } catch (e) {
      console.error(e);
      select.value = String(saved);
      setStatus("設定を保存できませんでした: " + describeError(e), true);
    }
  });
  label.append(select);
  return label;
}

// IPA を表示するか(デッキごと。未設定は表示)
function buildIpaToggle(d) {
  const label = document.createElement("label");
  label.className = "deck-toggle";
  const box = document.createElement("input");
  box.type = "checkbox";
  let saved = d.showIpa !== false;
  box.checked = saved;
  box.addEventListener("change", async () => {
    const want = box.checked;
    try {
      await DeckStore.setShowIpa(d.id, want);
      saved = want;
    } catch (e) {
      console.error(e);
      box.checked = saved;
      setStatus("設定を保存できませんでした: " + describeError(e), true);
    }
  });
  label.append(box, "IPA(発音記号)を表示する");
  return label;
}

// 新規カードの1日の上限(デッキごと)
function buildLimitInput(d) {
  const label = document.createElement("label");
  label.className = "deck-limit";
  label.append("新規カード/日");

  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.max = "999";
  input.step = "1";
  input.inputMode = "numeric";
  let saved = d.newPerDay ?? SRS_CONFIG.defaultNewPerDay;
  input.value = String(saved);

  input.addEventListener("change", async () => {
    const n = Number(input.value);
    if (!Number.isInteger(n) || n < 0 || n > 999) {
      input.value = String(saved); // 不正な値は元に戻す
      return;
    }
    try {
      await DeckStore.setNewPerDay(d.id, n);
      saved = n;
    } catch (e) {
      console.error(e);
      input.value = String(saved);
      setStatus("設定を保存できませんでした: " + describeError(e), true);
    }
  });

  label.append(input);
  return label;
}

function showLibrary() {
  releaseAudio();
  state.deckId = null;
  state.session = null;
  state.current = null;
  els.viewer.hidden = true;
  els.library.hidden = false;
  renderBackupStatus();
}

async function updatePersistStatus() {
  const p = await DeckStore.requestPersistence();
  els.persistStatus.textContent = !p.supported
    ? "この環境では保存の永続化に未対応です(保存データはブラウザの判断で消えることがあります)"
    : p.persisted
      ? "保存の永続化: 有効"
      : "保存の永続化: 未許可(ブラウザの判断で消えることがあります)";
}

async function openSaved(id) {
  try {
    setStatus("読み込み中...");
    const blob = await DeckStore.getDeckBlob(id);
    if (!blob) throw new Error("保存データが見つかりません");
    const parsed = await parseApkg(blob);
    await DeckStore.touchDeck(id);
    await startStudy(parsed);
  } catch (e) {
    console.error(e);
    setStatus("開けませんでした: " + describeError(e), true);
  }
}

async function importFile(file) {
  setStatus("展開中...");
  const parsed = await parseApkg(file); // 壊れたファイルはここで失敗し、何も保存されない
  if (!parsed.profile) throw unsupportedDeck(parsed); // 開けないデッキは保存しない

  const dups = await DeckStore.findDuplicates(parsed.deck);
  if (dups.length > 0) {
    const ok = confirm(`「${parsed.deck.name}」は保存済みです。置き換えますか？`);
    if (!ok) {
      setStatus("取り込みをキャンセルしました");
      return;
    }
  }

  setStatus("保存中...");
  await DeckStore.saveDeck(parsed.deck, file, { replaceIds: dups.map((d) => d.id) });
  await updatePersistStatus(); // ユーザー操作の直後なので許可されやすい
  await renderLibrary(); // 項目が足りず開けない場合でも、保存したデッキを一覧に出す
  await startStudy(parsed);
}

async function removeDeck(d) {
  const ok = confirm(
    `「${d.name}」とその学習の進み具合をすべて削除します。元に戻せません。よろしいですか？`
  );
  if (!ok) return;
  try {
    await DeckStore.deleteDeck(d.id);
    await renderLibrary();
    setStatus(`「${d.name}」を削除しました`);
  } catch (e) {
    console.error(e);
    setStatus("削除できませんでした: " + describeError(e), true);
  }
}

// ---------------------------------------------------------------
// バックアップ(計算は backup.js、保存は storage.js)
// ---------------------------------------------------------------
// 「最後のバックアップ」の日時。表示のためだけの目印なので localStorage に置く
// (消えても学習記録には影響せず、「未実施」と表示されるだけ)。
const LAST_BACKUP_KEY = KEY_PREFIX + "anki-pwa-last-backup-ms";

function getLastBackup() {
  try {
    const v = Number(localStorage.getItem(LAST_BACKUP_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

function setLastBackup(ms) {
  try { localStorage.setItem(LAST_BACKUP_KEY, String(ms)); } catch { /* 表示が「未実施」のままになるだけ */ }
}

function renderBackupStatus() {
  const ts = getLastBackup();
  if (ts == null) {
    els.backupLast.textContent = "最後のバックアップ: 未実施";
    return;
  }
  const days = Math.max(0, Math.floor((Date.now() - ts) / 86400000));
  els.backupLast.textContent = "最後のバックアップ: " + (days === 0 ? "今日" : `${days}日前`);
}

function setBackupBusy(busy) {
  els.backupExport.disabled = busy;
  els.backupImport.disabled = busy;
}

// .apkg の中の全カード ID(読み込むバックアップがこのデッキに合うか調べるために使う)
async function readCardIds(blob) {
  const zip = await JSZip.loadAsync(blob);
  const entry = zip.file("collection.anki21");
  if (!entry) throw new Error("collection.anki21 が見つかりません(この形式は未対応です)");
  const SQL = await initSqlJs({ locateFile: (f) => "lib/" + f });
  const db = new SQL.Database(await entry.async("uint8array"));
  try {
    const rows = db.exec("SELECT id FROM cards")[0]?.values ?? [];
    return new Set(rows.map((r) => r[0]));
  } finally {
    db.close();
  }
}

// 共有シート(「ファイルに保存」など)に渡す。使えなければダウンロード。
// 戻り値: 渡せた(または保存を始めた)なら true、ユーザーが共有をやめたなら false
async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return true;
    } catch (e) {
      if (e?.name === "AbortError") return false; // 自分でやめた
      console.warn("共有できなかったのでダウンロードに切り替えます", e);
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

function dateStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function exportBackup() {
  els.backupResult.textContent = "";
  setBackupBusy(true);
  try {
    const now = Date.now();
    const backup = Backup.build({ decks: await DeckStore.exportAll(), now });
    const c = Backup.counts(backup);
    if (c.decks === 0) {
      setStatus("バックアップするデッキがありません", true);
      return;
    }
    const summary = `${c.decks} デッキ・カード ${c.cards.toLocaleString("ja-JP")} 枚・履歴 ${c.logs.toLocaleString("ja-JP")} 件`;
    setStatus(`書き出し中: ${summary}`);
    const file = new File([JSON.stringify(backup)], `anki-pwa-${IS_DEV ? "dev-" : ""}backup-${dateStamp(now)}.json`, { type: "application/json" });
    if (await shareOrDownload(file)) {
      setLastBackup(now);
      renderBackupStatus();
      setStatus(`書き出しました: ${summary}`);
    } else {
      setStatus("書き出しをやめました");
    }
  } catch (e) {
    console.error(e);
    setStatus("書き出せませんでした: " + describeError(e), true);
  } finally {
    setBackupBusy(false);
  }
}

async function importBackup(file) {
  els.backupResult.textContent = "";
  if (file.size > 100 * 1024 * 1024) throw new Error("ファイルが大きすぎます");

  let parsedJson;
  try {
    parsedJson = JSON.parse(await file.text());
  } catch {
    throw new Error("バックアップファイル(JSON)として読めません");
  }
  const v = Backup.validate(parsedJson);
  if (!v.ok) throw new Error(v.error);
  const backup = v.backup;

  // バックアップに含まれ、端末にもあるデッキについて、実在するカード ID を .apkg から調べる
  const local = await DeckStore.listDecks();
  const localIds = new Set(local.map((d) => d.id));
  const targets = backup.decks.filter((d) => localIds.has(d.id));
  const cardIdsByDeck = new Map();
  for (const [i, d] of targets.entries()) {
    setStatus(`デッキを確認中 (${i + 1}/${targets.length})...`);
    const blob = await DeckStore.getDeckBlob(d.id);
    if (!blob) throw new Error(`デッキ「${d.name}」の保存データが見つかりません`);
    cardIdsByDeck.set(d.id, await readCardIds(blob));
  }

  // まず何も書かずに結果の見込みを出し、確認してから書き込む
  const preview = await DeckStore.importMerge(backup, cardIdsByDeck, { dryRun: true });
  const previewText = Backup.describe(preview, { done: false });
  if (!preview.hasChanges) {
    els.backupResult.textContent = "反映するものはありませんでした。\n" + previewText;
    setStatus("読み込みを終了しました(変更なし)");
    return;
  }
  const when = new Date(backup.exportedAt).toLocaleString("ja-JP");
  const ok = confirm(`バックアップ(${when} 書き出し)を読み込みます。\n\n${previewText}\n\nこの内容で読み込みますか？`);
  if (!ok) {
    setStatus("読み込みをキャンセルしました");
    return;
  }

  setStatus("読み込み中...");
  const result = await DeckStore.importMerge(backup, cardIdsByDeck, { dryRun: false });
  els.backupResult.textContent = Backup.describe(result, { done: true });
  await renderLibrary();
  const warn = result.totals.orphanCards > 0 || result.totals.missingDecks > 0;
  setStatus(warn ? "読み込みました(スキップがあります。下の内容を確認してください)" : "読み込みました", warn);
}

// ---------------------------------------------------------------
// 復習(学習画面)
// ---------------------------------------------------------------
async function startStudy(parsed) {
  releaseAudio();
  state.deckId = parsed.deck.id;
  state.zip = parsed.zip;
  state.mediaByName = parsed.mediaByName;
  state.cards = parsed.cards;
  state.cardById = new Map(parsed.cards.map((c) => [c.id, c]));
  // 学習画面の上部に出す「学習した単語」は全デッキの合計。いま学習中のデッキ以外の分をここで数えておく
  state.learnedOtherDecks = (await DeckStore.listDecks())
    .filter((d) => d.id !== state.deckId)
    .reduce((sum, d) => sum + d.learnedCount, 0);

  if (!parsed.profile) throw unsupportedDeck(parsed);
  state.profile = parsed.profile;
  await buildSession();
  els.library.hidden = true;
  els.viewer.hidden = false;
  setStatus("");
  advance();
}

// 保存済みの学習記録・上限・今日の導入数から、出題状態を作る
async function buildSession() {
  const id = state.deckId;
  const nowMs = Srs.now();
  const [records, limit, showIpa, fontScale, newToday] = await Promise.all([
    DeckStore.getCardRecords(id),
    DeckStore.getNewPerDay(id),
    DeckStore.getShowIpa(id),
    DeckStore.getFontScale(id),
    DeckStore.countNewSince(id, Srs.dayStart(nowMs), Srs.nextDayStart(nowMs)),
  ]);
  state.showIpa = showIpa;
  state.layout = resolveLayout();
  els.card.style.setProperty("--card-scale", String(fontScale));
  state.session = Srs.createSession({
    cards: state.cards,
    records: records.filter((r) => state.cardById.has(r.cardId)), // デッキに無いカードの記録は無視
    newPerDay: limit ?? SRS_CONFIG.defaultNewPerDay,
    newToday,
    nowMs,
  });
}

function updateCounts(kind) {
  const c = Srs.counts(state.session, Srs.now());
  els.counts.new.textContent = c.new;
  els.counts.learning.textContent = c.learning;
  els.counts.review.textContent = c.review;
  // 学習した単語 = 一度でも答えたカードの数(全デッキの合計)。答えるたびに増え、減らない
  const learned = state.learnedOtherDecks + state.session.records.size;
  els.deckInfo.textContent = `学習した単語 ${learned.toLocaleString("ja-JP")}語`;
  for (const box of els.countBoxes) box.classList.toggle("current", box.dataset.kind === kind);
}

// 次のカードを選んで表(答えを隠した状態)を出す。無ければ終了表示。
function advance() {
  releaseAudio();
  state.revealed = false;

  const nowMs = Srs.now();
  const pick = Srs.pickNext(state.session, nowMs);
  updateCounts(pick?.kind);

  if (!pick) {
    state.current = null;
    els.study.hidden = true;
    els.done.hidden = false;
    renderDone(nowMs);
    return;
  }

  els.done.hidden = true;
  els.study.hidden = false;

  const card = state.cardById.get(pick.cardId);
  state.current = { ...pick, card };

  const p = state.profile;
  const ipaName = p.ipa && p.fields[p.ipa];
  els.front.classList.toggle("prose", p.longFront);
  renderSide(els.front, state.layout.front, card);
  renderSide(els.back, state.showIpa ? state.layout.back : state.layout.back.filter((n) => n !== ipaName), card);
  els.back.hidden = true;
  els.grades.hidden = true;
  els.showAnswer.hidden = false;
  els.card.scrollTop = 0; // 前のカードで下までスクロールしていても、先頭から見せる
}

// 出せるカードが無いときの画面。あとで出る学習中カードがあれば「今はここまで」として目立たせる
function renderDone(nowMs) {
  const s = state.session;
  const l = Srs.later(s, nowMs);
  els.doneTitle.textContent = l.count > 0 ? "今はここまで" : "今日の学習は終わりです";
  els.doneLater.hidden = l.count === 0;
  if (l.count > 0) {
    els.doneLaterMain.textContent = `あと${Srs.formatInterval(l.nextDue - nowMs)}で ${l.count}枚 出ます`;
  }
  els.doneNote.textContent = s.unseen.length > 0 && s.newToday >= s.newPerDay
    ? `新規カードは今日の上限(${s.newPerDay}枚)に達しました。` : "";
}

function revealAnswer() {
  if (!state.current || state.revealed) return;
  state.revealed = true;
  els.back.hidden = false;
  els.showAnswer.hidden = true;

  const labels = Srs.labels(state.current.record, Srs.now());
  for (const btn of els.gradeButtons) {
    btn.querySelector(".interval").textContent = labels[btn.dataset.grade];
  }
  els.grades.hidden = false;
  document.activeElement?.blur?.(); // Space がボタンを二重に押さないように
}

async function gradeCurrent(grade) {
  if (!state.current || !state.revealed || state.busy) return;
  state.busy = true;
  const session = state.session;
  try {
    const cur = state.current;
    const nowMs = Srs.now();
    const { record, log } = Srs.answer(cur.record, state.deckId, cur.cardId, grade, nowMs);
    await DeckStore.saveReview(state.deckId, record, log); // 保存できてから次へ
    if (state.session !== session) return; // 保存中に一覧へ戻った
    Srs.applyAnswer(session, record, log, nowMs);
    advance();
  } catch (e) {
    console.error(e);
    setStatus("回答を保存できませんでした: " + describeError(e), true);
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------
// 表示
// ---------------------------------------------------------------
function fieldValue(card, key) {
  return card.fields[state.profile.fields[key]] ?? "";
}

function unsupportedDeck(parsed) {
  return new Error("対応していないデッキです(項目: " + parsed.fieldNames.join(", ") + ")");
}

// フィールド名 → 役割(headword など)。初期設定に無いフィールドは null
function roleOfField(name) {
  const F = state.profile.fields;
  return Object.keys(F).find((k) => F[k] === name) ?? null;
}

// 表裏に出すフィールド名(初期設定)。項目の出し分けは IPA の表示・非表示だけ
function resolveLayout() {
  const p = state.profile;
  return { front: p.front.map((k) => p.fields[k]), back: p.back.map((k) => p.fields[k]) };
}

// names: 表示するフィールド名(Anki のフィールド名)
function renderSide(container, names, card) {
  container.replaceChildren();
  for (const name of names) {
    const role = roleOfField(name);
    const div = document.createElement("div");
    div.className = "field " + (role ?? "other");
    if (role && state.profile.audioRows.includes(role)) {
      // 音声だけの行: [sound:...] の文字は出さず、ボタンだけ置く(音声が無ければ行ごと出さない)
      if (!soundName(card, role)) continue;
      div.classList.add("audio-row");
      div.append(buildAudioButton(card, role));
      container.appendChild(div);
      continue;
    }
    // 空の項目は出さない(空の行の余白で崩れないように)
    if (!(card.fields[name] ?? "").replace(/<[^>]*>|&nbsp;|\s/g, "")) continue;
    const audioKey = role && state.profile.audioButtons[role];
    if (audioKey) {
      // 項目の横に小さな音声ボタンを置く
      const text = document.createElement("div");
      text.className = "text";
      setHtml(text, card.fields[name] ?? "");
      div.classList.add("with-audio");
      div.append(text, buildAudioButton(card, audioKey));
    } else {
      setHtml(div, card.fields[name] ?? "");
    }
    container.appendChild(div);
  }
}

function buildAudioButton(card, audioKey) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "audio-btn";
  btn.setAttribute("aria-label", "音声を再生");
  btn.innerHTML = AUDIO_ICON;
  btn.disabled = !hasAudio(soundName(card, audioKey)); // 音声が無いカードでは押せない
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // カードのタップ(答えを見る)にしない
    playSound(audioKey).catch((err) => setStatus("再生できません: " + err.message, true));
  });
  return btn;
}

function soundName(card, profileKey) {
  const m = /\[sound:(.+?)\]/.exec(fieldValue(card, profileKey));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------
// 音声
// ---------------------------------------------------------------
function hasAudio(name) {
  return !!name && state.mediaByName.has(name) && !!state.zip.file(state.mediaByName.get(name));
}

function releaseAudio() {
  if (state.player) { state.player.pause(); state.player = null; }
  for (const url of state.audioUrls.values()) URL.revokeObjectURL(url);
  state.audioUrls.clear();
}

async function playSound(profileKey) {
  const shown = state.current;
  if (!shown) return;
  const name = soundName(shown.card, profileKey);
  if (!hasAudio(name)) return;

  let url = state.audioUrls.get(name);
  if (!url) {
    const blob = await state.zip.file(state.mediaByName.get(name)).async("blob");
    if (state.current !== shown) return; // 取り出し中にカードが変わった
    url = URL.createObjectURL(new Blob([blob], { type: "audio/mpeg" }));
    state.audioUrls.set(name, url);
  }
  if (state.player) state.player.pause();
  state.player = new Audio(url);
  await state.player.play();
}

// ---------------------------------------------------------------
// デバッグ(URL に ?debug=1 を付けたときだけ)
// ---------------------------------------------------------------
function initDebug() {
  if (!DEBUG) return;
  try {
    Srs.setOffset(Number(localStorage.getItem(DEBUG_OFFSET_KEY)) || 0);
  } catch { /* localStorage が使えなくても動く */ }
  els.debug.hidden = false;
  updateDebugClock();

  els.debug.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const next = btn.dataset.reset ? 0 : Srs.getOffset() + Number(btn.dataset.addMs);
    Srs.setOffset(next);
    try { localStorage.setItem(DEBUG_OFFSET_KEY, String(next)); } catch { /* 無視 */ }
    updateDebugClock();
    if (state.deckId) {
      try {
        await buildSession(); // 日付が変わるので、今日の導入数なども取り直す
        advance();
      } catch (err) { setStatus(describeError(err), true); }
    }
  });
}

function updateDebugClock() {
  const off = Srs.getOffset();
  const days = off / 86400000;
  els.debugClock.textContent =
    `デバッグ: 仮想現在時刻 ${new Date(Srs.now()).toLocaleString("ja-JP")}` +
    (off ? `(実際より +${Math.round(days * 100) / 100}日)` : "");
}

// ---------------------------------------------------------------
// 画面幅の崩れ対策(iPhone のホーム画面アプリ)
// アプリを閉じて開き直したときに、画面が拡大されたり横にはみ出したりすることがある。
// 復帰時にそれを検出し、viewport を一瞬書き換えて iOS にレイアウトを計算し直させる。
// ---------------------------------------------------------------
const viewportMeta = document.querySelector('meta[name="viewport"]');
const VIEWPORT_ORIGINAL = viewportMeta?.getAttribute("content") ?? "";

function measureViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  return {
    innerWidth: window.innerWidth,
    contentWidth: root.scrollWidth,
    scale: vv ? vv.scale : 1,
    zoomed: !!vv && Math.abs(vv.scale - 1) > 0.01,
    overflowX: root.scrollWidth > root.clientWidth + 1 || window.scrollX !== 0,
  };
}

// 画面の右端を越えている要素(原因調べ用。?debug=1 のときだけ表示する)
function overflowingElements() {
  const w = document.documentElement.clientWidth;
  return [...document.body.querySelectorAll("*")]
    .filter((el) => el.getBoundingClientRect().right > w + 1)
    .slice(0, 3)
    .map((el) => {
      const cls = typeof el.className === "string" && el.className ? "." + el.className.split(" ")[0] : "";
      return el.id ? `#${el.id}` : el.tagName.toLowerCase() + cls;
    });
}

function updateDebugViewport() {
  if (!DEBUG) return;
  const m = measureViewport();
  const bad = m.overflowX ? overflowingElements() : [];
  els.debugViewport.textContent =
    `画面幅 ${m.innerWidth}px / 内容幅 ${m.contentWidth}px / 拡大率 ${m.scale.toFixed(2)} / 高さ ${window.innerHeight}px` +
    (bad.length ? ` / はみ出し: ${bad.join(", ")}` : "");
}

let stabilizing = false;
function stabilizeViewport() {
  const m = measureViewport();
  updateDebugViewport();
  if ((!m.zoomed && !m.overflowX) || stabilizing || !viewportMeta) return;
  stabilizing = true;
  viewportMeta.setAttribute("content", VIEWPORT_ORIGINAL + ", minimum-scale=1"); // 内容を変えて再解釈させる
  window.scrollTo(0, 0);
  setTimeout(() => {
    viewportMeta.setAttribute("content", VIEWPORT_ORIGINAL);
    stabilizing = false;
    updateDebugViewport();
  }, 150);
}

// ---------------------------------------------------------------
// アプリのバージョン表示(iPhone で更新が届いたかを確かめるため)
// 今動いている Service Worker に尋ねる(sw.js の CACHE_VERSION が返る)。
// ---------------------------------------------------------------
function askServiceWorkerVersion() {
  return new Promise((resolve) => {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return resolve(null);
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data?.version ?? null);
    controller.postMessage("GET_VERSION", [channel.port2]);
    setTimeout(() => resolve(null), 1500);
  });
}

async function showVersion() {
  if (!("serviceWorker" in navigator)) { els.version.textContent = ""; return; }
  if (!navigator.serviceWorker.controller) {
    els.version.textContent = "アプリのバージョン: ―(Service Worker は未使用)";
    return;
  }
  const v = await askServiceWorkerVersion();
  els.version.textContent = v ? `アプリのバージョン: ${v}${IS_DEV ? "(開発版)" : ""}` : "アプリのバージョン: 確認できません";
}

// ---------------------------------------------------------------
// イベント
// ---------------------------------------------------------------
els.file.addEventListener("change", async () => {
  const file = els.file.files[0];
  if (!file) return;
  try {
    await importFile(file);
  } catch (e) {
    console.error(e);
    setStatus("読み込みに失敗しました: " + describeError(e), true);
  } finally {
    els.file.value = ""; // 同じファイルをもう一度選んでも change が発火するように
  }
});

els.backupExport.addEventListener("click", exportBackup);
els.backupImport.addEventListener("click", () => els.backupFile.click());
els.backupFile.addEventListener("change", async () => {
  const file = els.backupFile.files[0];
  if (!file) return;
  setBackupBusy(true);
  try {
    await importBackup(file);
  } catch (e) {
    console.error(e);
    setStatus("読み込めませんでした: " + describeError(e), true);
  } finally {
    els.backupFile.value = ""; // 同じファイルをもう一度選んでも change が発火するように
    setBackupBusy(false);
  }
});

els.backToLibrary.addEventListener("click", async () => {
  showLibrary();
  setStatus("");
  try { await renderLibrary(); } catch (e) { setStatus(describeError(e), true); }
});

els.card.addEventListener("click", revealAnswer);
els.showAnswer.addEventListener("click", revealAnswer);
for (const btn of els.gradeButtons) {
  btn.addEventListener("click", () => gradeCurrent(Number(btn.dataset.grade)));
}

// キーボード(PC): Space=答えを見る、1〜4=もう一度/難しい/正解/簡単
document.addEventListener("keydown", (e) => {
  if (els.viewer.hidden || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

  if (e.code === "Space") {
    if (state.current && !state.revealed) {
      e.preventDefault();
      revealAnswer();
    }
  } else if (["1", "2", "3", "4"].includes(e.key)) {
    if (state.revealed) {
      e.preventDefault();
      gradeCurrent(Number(e.key));
    }
  }
});

// 「今日の学習は終わりです」の画面で、数分後に学習中カードの期限が来たら自動で再開する
setInterval(() => {
  if (DEBUG) { updateDebugClock(); updateDebugViewport(); }
  if (state.session && !els.done.hidden && !state.busy) advance();
}, 15000);

// 復帰・回転・入力欄のフォーカス解除のあとに、画面の拡大や横はみ出しを確認して直す
window.addEventListener("pageshow", stabilizeViewport);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") stabilizeViewport();
});
window.addEventListener("orientationchange", () => setTimeout(stabilizeViewport, 300));
document.addEventListener("focusout", () => setTimeout(stabilizeViewport, 300));
window.visualViewport?.addEventListener("resize", updateDebugViewport);

// ---------------------------------------------------------------
// PWA: Service Worker の登録と更新通知
// 更新の流れ: sw.js の CACHE_VERSION を上げて公開 → 新しい Service Worker が裏で
// キャッシュを作って待機 → 「新しいバージョンがあります [更新]」を表示 → 押すと切り替えて再読み込み。
// (学習中に勝手に入れ替わらないよう、切り替えは押したときだけ)
// ---------------------------------------------------------------
function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // 開発中(localhost)は古いコードがキャッシュされて混乱するので登録しない。試すときだけ ?sw=1
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (isLocal && new URLSearchParams(location.search).get("sw") !== "1") return;

  const banner = $("update-banner");
  const button = $("update-btn");
  let waiting = null;
  let updateRequested = false;

  // 「更新」として扱うのは、今このページを制御している Service Worker の新しい版だけ。
  // 同じオリジンの別の版(安定版と開発版)の Service Worker が制御している間は、更新ではない。
  const isUpdateOfController = (worker) =>
    navigator.serviceWorker.controller?.scriptURL === worker.scriptURL;

  const offerUpdate = (worker) => {
    waiting = worker;
    banner.hidden = false;
  };

  button.addEventListener("click", () => {
    updateRequested = true;
    button.disabled = true;
    waiting?.postMessage("SKIP_WAITING");
  });

  // 新しい Service Worker に切り替わったら再読み込み(初回インストール時の切り替えでは読み込み直さない)
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    showVersion();
    if (!updateRequested || reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register("sw.js").then((reg) => {
    // すでに待機中の更新がある(前回見つけたが、まだ切り替えていない)
    if (reg.waiting && isUpdateOfController(reg.waiting)) offerUpdate(reg.waiting);

    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        // controller があるときだけ「更新」。無いときは初回インストールなので通知しない
        if (worker.state === "installed" && isUpdateOfController(worker)) offerUpdate(worker);
      });
    });

    // ホーム画面のアプリは起動したまま長く残るので、前面に戻るたびに更新を確認する
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });
  }).catch((e) => console.error("Service Worker の登録に失敗しました", e));
}

// 起動時: デバッグ設定、Service Worker、永続化の要求、保存済みデッキの一覧
(async () => {
  if (IS_DEV) $("dev-badge").hidden = false;
  initDebug();
  updateDebugViewport();
  initServiceWorker();
  showVersion();
  renderBackupStatus();
  try {
    await renderLibrary();
    await updatePersistStatus();
  } catch (e) {
    console.error(e);
    setStatus("保存データを開けませんでした: " + describeError(e), true);
  }
})();
