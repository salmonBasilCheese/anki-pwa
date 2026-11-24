"use strict";

// ---------------------------------------------------------------
// デッキの種類(プロファイル)。Anki のノートタイプのフィールド名で見分ける。
//  fields : 役割 -> Anki のフィールド名(全部あるデッキだけがその種類になる)
//  front / back : 表・裏に出す役割(上から順)
//  audioButtons : 「その役割の横に置く音声ボタン -> 鳴らす音声の役割」
//  audioRows    : 「音声だけの行(ボタンだけ出す)になる役割」
//  ipa : IPA の役割(無い種類は null)
// ---------------------------------------------------------------
const DECK_PROFILES = [
  {
    name: "vocab",
    fields: {
      headword: "Headword", ipa: "IPA", meaning: "Meaning", exampleEN: "ExampleEN",
      exampleJA: "ExampleJA", audioWord: "AudioHW", audioExample: "AudioEx",
    },
    front: ["headword"],
    back: ["ipa", "meaning", "exampleEN", "exampleJA"],
    audioButtons: { headword: "audioWord", exampleEN: "audioExample" },
    audioRows: [],
    ipa: "ipa",
  },
  {
    // 文法デッキ。音声は裏面でだけ鳴らす(表で鳴ると答えが分かるため)
    name: "grammar",
    fields: { front: "Front", back: "Back", note: "Note", source: "Source", id: "Id", audio: "Audio" },
    front: ["front"],
    back: ["back", "audio", "note", "source"],
    audioButtons: {},
    audioRows: ["audio"],
    ipa: null,
  },
];

// 項目名の一覧から種類を選ぶ。合うものが無ければ null。
function pickProfile(fieldNames) {
  return DECK_PROFILES.find((p) => Object.values(p.fields).every((n) => fieldNames.includes(n))) ?? null;
}

// 保存済みデッキの記録に書いた種類名から選ぶ。無い・不明は単語デッキ(古い記録は全部こちら)
function profileByName(name) {
  return DECK_PROFILES.find((p) => p.name === name) ?? DECK_PROFILES[0];
}

if (typeof module !== "undefined") module.exports = { DECK_PROFILES, pickProfile, profileByName };
