"use strict";

// ---------------------------------------------------------------
// デッキごとの決め打ち部分はここだけ。
// 将来デッキごとに表裏のフィールドを選べるようにするときは、この
// オブジェクトをデッキ単位の設定として差し替える。
// 値は Anki のノートタイプ(col.models)のフィールド名。
// ---------------------------------------------------------------
const DECK_PROFILE = {
  fields: {
    headword: "Headword",
    ipa: "IPA",
    meaning: "Meaning",
    exampleEN: "ExampleEN",
    exampleJA: "ExampleJA",
    audioWord: "AudioHW",
    audioExample: "AudioEx",
  },
  front: ["headword"],
  back: ["ipa", "meaning", "exampleEN", "exampleJA"],
  audio: { word: "audioWord", example: "audioExample" },
};

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file"), status: $("status"), viewer: $("viewer"),
  deckInfo: $("deck-info"), card: $("card"), front: $("front"),
  back: $("back"), hint: $("hint"), position: $("position"),
  prev: $("prev"), next: $("next"),
  playWord: $("play-word"), playExample: $("play-example"),
  library: $("library"), deckList: $("deck-list"),
  persistStatus: $("persist-status"), backToLibrary: $("back-to-library"),
};

const state = {
  deckId: null,           // 学習中のデッキID(保存済みデッキのキー)
  zip: null,
  mediaByName: new Map(), // "svl2k_3001_w.mp3" -> "123"(zip内のファイル名)
  cards: [],              // { id, fields: {フィールド名: 値} }
  index: 0,
  flipped: false,
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
// 戻り値: { zip, mediaByName, cards, deck: {id, name, cardCount}, deckLabel }
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
  // media: { "0": "svl2k_3001_w.mp3", ... } を逆引きにする
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
  const deckLabel = `${deckNames.join(" / ")} — ${total}枚`;

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

  const rows = db.exec(
    "SELECT c.id, n.mid, n.flds FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.id"
  )[0].values;

  const cards = rows.map(([id, mid, flds]) => {
    const names = fieldNames.get(String(mid)) ?? [];
    const values = String(flds).split("\x1f");
    const fields = {};
    names.forEach((name, i) => { fields[name] = values[i] ?? ""; });
    return { id, fields };
  });

  // プロファイルのフィールドが実在するか確認(決め打ちのずれを早く知らせる)
  const sample = cards[0].fields;
  const missing = Object.values(DECK_PROFILE.fields).filter((n) => !(n in sample));
  if (missing.length) {
    throw new Error("このデッキに無いフィールドがあります: " + missing.join(", "));
  }

  return { mediaByName, cards, deck, deckLabel };
}

// 読み込み済みデッキを学習画面に出す
function showDeck(parsed, startIndex) {
  releaseAudio();
  state.deckId = parsed.deck.id;
  state.zip = parsed.zip;
  state.mediaByName = parsed.mediaByName;
  state.cards = parsed.cards;
  state.index = clampIndex(startIndex, parsed.cards.length);
  els.deckInfo.textContent = parsed.deckLabel;
  els.library.hidden = true;
  els.viewer.hidden = false;
  showCard();
  setStatus("");
}

function clampIndex(i, length) {
  if (!Number.isInteger(i)) return 0;
  return Math.min(Math.max(i, 0), length - 1);
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
    const progress = d.lastIndex === null ? "未学習" : `位置 ${d.lastIndex + 1} / ${d.cardCount}`;
    meta.textContent = `${d.cardCount}枚 ・ ${progress}`;

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
    actions.append(openBtn, delBtn);

    li.append(name, meta, actions);
    els.deckList.appendChild(li);
  }
}

function showLibrary() {
  releaseAudio();
  state.deckId = null;
  els.viewer.hidden = true;
  els.library.hidden = false;
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
    const last = await DeckStore.getLastIndex(id);
    await DeckStore.touchDeck(id);
    showDeck(parsed, last ?? 0);
  } catch (e) {
    console.error(e);
    setStatus("開けませんでした: " + describeError(e), true);
  }
}

async function importFile(file) {
  setStatus("展開中...");
  const parsed = await parseApkg(file); // 壊れたファイルはここで失敗し、何も保存されない

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
  const last = await DeckStore.getLastIndex(parsed.deck.id);
  showDeck(parsed, last ?? 0);
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
// 表示
// ---------------------------------------------------------------
function fieldValue(card, key) {
  return card.fields[DECK_PROFILE.fields[key]] ?? "";
}

function renderSide(container, keys, card) {
  container.replaceChildren();
  for (const key of keys) {
    const div = document.createElement("div");
    div.className = "field " + key;
    setHtml(div, fieldValue(card, key));
    container.appendChild(div);
  }
}

function soundName(card, profileKey) {
  const m = /\[sound:(.+?)\]/.exec(fieldValue(card, profileKey));
  return m ? m[1] : null;
}

function showCard() {
  const card = state.cards[state.index];
  releaseAudio();
  state.flipped = false;

  renderSide(els.front, DECK_PROFILE.front, card);
  renderSide(els.back, DECK_PROFILE.back, card);
  els.back.hidden = true;
  els.hint.hidden = false;

  els.playWord.disabled = !hasAudio(soundName(card, DECK_PROFILE.audio.word));
  els.playExample.disabled = !hasAudio(soundName(card, DECK_PROFILE.audio.example));

  els.position.textContent = `${state.index + 1} / ${state.cards.length}`;
  els.prev.disabled = state.index === 0;
  els.next.disabled = state.index === state.cards.length - 1;
}

function flip() {
  state.flipped = !state.flipped;
  els.back.hidden = !state.flipped;
  els.hint.hidden = state.flipped;
}

function move(delta) {
  const next = state.index + delta;
  if (next < 0 || next >= state.cards.length) return;
  state.index = next;
  showCard();
  DeckStore.setLastIndex(state.deckId, next).catch((e) => console.error("位置の保存に失敗", e));
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
  const card = state.cards[state.index];
  const name = soundName(card, profileKey);
  if (!hasAudio(name)) return;

  const shownIndex = state.index;
  let url = state.audioUrls.get(name);
  if (!url) {
    const blob = await state.zip.file(state.mediaByName.get(name)).async("blob");
    if (state.index !== shownIndex) return; // 取り出し中にカードが変わった
    url = URL.createObjectURL(new Blob([blob], { type: "audio/mpeg" }));
    state.audioUrls.set(name, url);
  }
  if (state.player) state.player.pause();
  state.player = new Audio(url);
  await state.player.play();
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

els.backToLibrary.addEventListener("click", async () => {
  showLibrary();
  setStatus("");
  try { await renderLibrary(); } catch (e) { setStatus(describeError(e), true); }
});

// 起動時: 永続化を要求し、保存済みデッキの一覧を出す
(async () => {
  try {
    await renderLibrary();
    await updatePersistStatus();
  } catch (e) {
    console.error(e);
    setStatus("保存データを開けませんでした: " + describeError(e), true);
  }
})();

els.card.addEventListener("click", flip);
els.prev.addEventListener("click", () => move(-1));
els.next.addEventListener("click", () => move(1));
els.playWord.addEventListener("click", () =>
  playSound(DECK_PROFILE.audio.word).catch((e) => setStatus("再生できません: " + e.message, true)));
els.playExample.addEventListener("click", () =>
  playSound(DECK_PROFILE.audio.example).catch((e) => setStatus("再生できません: " + e.message, true)));
