// 結び付かなくなった記録を元のカードに戻せるかを、試すだけの道具(何も書き込まない)。
//   node tools/try_relink.mjs <バックアップ.json> <デッキ.apkg> [<デッキ.apkg> ...]
// バックアップ(アプリの「バックアップを書き出す」で作ったもの)の各デッキについて、同じデッキ ID の
// .apkg を探し、付け替え(relink.js)をしたらどうなるかを、枚数だけで表示する(単語などの中身は表示しない)。
// バックアップと .apkg はこのリポジトリに置かないこと(一時フォルダなどに置いて使う)。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Relink = require(path.join(root, "relink.js"));
const Backup = require(path.join(root, "backup.js"));
const JSZip = require(path.join(root, "lib/jszip.min.js"));
const initSqlJs = require(path.join(root, "lib/sql-wasm.js"));

const [backupFile, ...apkgs] = process.argv.slice(2);
if (!backupFile || apkgs.length === 0) {
  console.error("使い方: node tools/try_relink.mjs <バックアップ.json> <デッキ.apkg> [...]");
  process.exit(2);
}

const SQL = await initSqlJs({ locateFile: (f) => path.join(root, "lib", f) });

// .apkg → { deckId, cards: [{ key, cid }] }(アプリの readCollection と同じ決め方)
async function readDeck(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entry = zip.file("collection.anki21");
  if (!entry) throw new Error(`${path.basename(file)}: collection.anki21 がありません`);
  const db = new SQL.Database(await entry.async("uint8array"));
  try {
    const did = db.exec("SELECT did, COUNT(*) FROM cards GROUP BY did ORDER BY COUNT(*) DESC")[0].values[0][0];
    const rows = db.exec("SELECT c.id, c.ord, n.guid FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.due, c.id")[0].values;
    return { deckId: String(did), cards: Relink.cardsFrom(rows.map(([cid, ord, guid]) => ({ cid, ord, guid }))) };
  } finally {
    db.close();
  }
}

const v = Backup.validate(JSON.parse(fs.readFileSync(backupFile, "utf8")));
if (!v.ok) { console.error(v.error); process.exit(1); }
const decks = new Map();
for (const f of apkgs) {
  const d = await readDeck(f);
  decks.set(d.deckId, d);
}

for (const [i, bd] of v.backup.decks.entries()) {
  const label = `デッキ${i + 1}(記録 ${bd.cardRecords.length} 枚・置き場 ${bd.unlinkedRecords.length} 枚・履歴 ${bd.reviewLogs.length} 件)`;
  const d = decks.get(bd.id);
  if (!d) { console.log(`${label}: 同じデッキ ID の .apkg が渡されていません`); continue; }
  const p = Relink.plan({
    cards: d.cards,
    records: bd.cardRecords,
    unlinked: bd.unlinkedRecords.map((r, uid) => ({ ...r, uid })),
    recover: true, // アプリでは使っていない「古い ID から戻す」処理を、ここでは試す
  });
  const logs = bd.reviewLogs.filter((l) => typeof l.cardId === "string" || p.logKey.has(l.cardId)).length;
  console.log(`${label}`);
  console.log(`  デッキのカード ${d.cards.length} 枚`);
  console.log(`  そのまま結び付く ${p.stats.converted} 枚 / 古い ID から戻せる ${p.stats.recovered} 枚 / 置き場から戻る ${p.stats.restored} 枚`);
  console.log(`  結び付く記録の合計 ${p.stats.linked} 枚(うち、同じカードに記録が複数 ${p.stats.conflicts} 枚)`);
  console.log(`  戻せず置き場に残る ${p.stats.unlinked} 枚 / 履歴でカードに結び付く ${logs} / ${bd.reviewLogs.length} 件`);
  for (const g of p.groups) {
    console.log(`  古い ID のまとまり ${g.count} 枚: ${g.ok ? "戻せる" : `戻せない(${g.reason})`}`);
  }
}
