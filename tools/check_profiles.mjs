// デッキの種類の判定テスト。使い方: node tools/check_profiles.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { pickProfile, profileByName } = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../profiles.js"));
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed++; };

const vocab = ["Headword", "IPA", "Meaning", "ExampleEN", "ExampleJA", "AudioHW", "AudioEx"];
const grammar = ["Front", "Back", "Note", "Source", "Id", "Audio"];
check(pickProfile(vocab)?.name === "vocab", "単語デッキの項目 -> vocab");
check(pickProfile([...vocab, "Extra"])?.name === "vocab", "項目が増えても vocab");
check(pickProfile(grammar)?.name === "grammar", "文法デッキの項目 -> grammar");
check(pickProfile(["Front", "Back"]) === null, "足りない項目 -> null(取り込み拒否)");
check(pickProfile([]) === null, "空 -> null");
check(profileByName(undefined).name === "vocab", "profile の無い古い記録 -> vocab");
check(profileByName("zzz").name === "vocab", "不明な名前 -> vocab");
check(profileByName("grammar").name === "grammar", "grammar の記録 -> grammar");
check(profileByName(undefined).ipa === "ipa" && profileByName("grammar").ipa === null, "IPA は単語デッキだけ");
const g = pickProfile(grammar);
check(g.back.join() === "back,audio,note,source" && g.front.join() === "front", "文法: 表=Front、裏=Back,Audio,Note,Source");
check(!g.front.includes("audio"), "文法: 表に音声は無い");
process.exit(failed ? 1 : 0);
