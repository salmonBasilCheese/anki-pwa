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
};

const state = {
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
async function loadApkg(file) {
  setStatus("展開中...");
  els.viewer.hidden = true;
  releaseAudio();

  const zip = await JSZip.loadAsync(file);
  state.zip = zip;

  const dbEntry = zip.file("collection.anki21");
  if (!dbEntry) {
    throw new Error("collection.anki21 が見つかりません(この形式は未対応です)");
  }

  setStatus("データベースを開いています...");
  const SQL = await initSqlJs({ locateFile: (f) => "lib/" + f });
  const db = new SQL.Database(await dbEntry.async("uint8array"));

  try {
    await readCollection(db, zip);
  } finally {
    db.close();
  }

  state.index = 0;
  els.viewer.hidden = false;
  showCard();
  setStatus("");
}

async function readCollection(db, zip) {
  // media: { "0": "svl2k_3001_w.mp3", ... } を逆引きにする
  state.mediaByName = new Map();
  const mediaEntry = zip.file("media");
  if (mediaEntry) {
    const mediaJson = JSON.parse(await mediaEntry.async("string"));
    for (const [num, name] of Object.entries(mediaJson)) {
      state.mediaByName.set(name, num);
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
  els.deckInfo.textContent = `${deckNames.join(" / ")} — ${total}枚`;

  // ノートタイプごとに フィールド名 -> 位置 を作る
  const fieldNames = new Map(); // mid(string) -> [名前...]
  for (const [mid, model] of Object.entries(models)) {
    fieldNames.set(mid, model.flds.map((f) => f.name));
  }

  const rows = db.exec(
    "SELECT c.id, n.mid, n.flds FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.id"
  )[0].values;

  state.cards = rows.map(([id, mid, flds]) => {
    const names = fieldNames.get(String(mid)) ?? [];
    const values = String(flds).split("\x1f");
    const fields = {};
    names.forEach((name, i) => { fields[name] = values[i] ?? ""; });
    return { id, fields };
  });

  // プロファイルのフィールドが実在するか確認(決め打ちのずれを早く知らせる)
  const sample = state.cards[0].fields;
  const missing = Object.values(DECK_PROFILE.fields).filter((n) => !(n in sample));
  if (missing.length) {
    throw new Error("このデッキに無いフィールドがあります: " + missing.join(", "));
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
    await loadApkg(file);
  } catch (e) {
    console.error(e);
    setStatus("読み込みに失敗しました: " + e.message, true);
  }
});

els.card.addEventListener("click", flip);
els.prev.addEventListener("click", () => move(-1));
els.next.addEventListener("click", () => move(1));
els.playWord.addEventListener("click", () =>
  playSound(DECK_PROFILE.audio.word).catch((e) => setStatus("再生できません: " + e.message, true)));
els.playExample.addEventListener("click", () =>
  playSound(DECK_PROFILE.audio.example).catch((e) => setStatus("再生できません: " + e.message, true)));
