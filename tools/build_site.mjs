// 公開用のサイトを組み立てる。GitHub Actions(.github/workflows/pages.yml)と、ローカルのテストが使う。
//   node tools/build_site.mjs --stable <安定版のフォルダ> --dev <開発版のフォルダ> --out <出力先>
// 結果: <出力先>/        = 安定版(子どもたちが使う。URL は今までと同じ)
//       <出力先>/dev/    = 開発版(アイコン・アプリ名・タイトルを差し替えて見分けがつくようにする)
// 公開してはいけないもの(教材・データ・開発用ファイル)は、ここでコピー対象から外す。
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
for (const k of ["stable", "dev", "out"]) {
  if (!args[k]) { console.error(`--${k} が必要です`); process.exit(2); }
}
const stableDir = path.resolve(args.stable);
const devDir = path.resolve(args.dev);
const outDir = path.resolve(args.out);

// 公開しない名前(どの階層でも)と拡張子
const EXCLUDE_NAMES = new Set([".git", ".github", "tools", "data", "node_modules", "icons-dev", "CLAUDE.md", "inspect_apkg.py"]);
const EXCLUDE_EXT = [".apkg", ".colpkg", ".anki2", ".mp3", ".pdf", ".epub"];
const filter = (src) => {
  const base = path.basename(src);
  if (EXCLUDE_NAMES.has(base)) return false;
  return !EXCLUDE_EXT.some((e) => base.toLowerCase().endsWith(e));
};

function copyTree(from, to) {
  if (!fs.existsSync(path.join(from, "index.html"))) throw new Error(`${from} に index.html がありません`);
  fs.cpSync(from, to, { recursive: true, filter });
}

// 置換は必ず 1 か所に当たること(当たらなければ、見た目の差し替えが黙って抜けるので失敗にする)
function replaceOnce(file, from, to) {
  const s = fs.readFileSync(file, "utf8");
  if (s.split(from).length !== 2) throw new Error(`${file}: 「${from}」が 1 か所ではありません`);
  fs.writeFileSync(file, s.replace(from, to));
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
copyTree(stableDir, outDir);

const outDev = path.join(outDir, "dev");
fs.mkdirSync(outDev, { recursive: true });
copyTree(devDir, outDev);

// 開発版の見た目: アイコンを紫のものに、アプリ名とタイトルを開発版と分かるものに
const iconsDev = path.join(devDir, "icons-dev");
if (!fs.existsSync(iconsDev)) throw new Error("icons-dev/ がありません(python tools/make_icons.py --dev で作る)");
for (const f of fs.readdirSync(iconsDev)) {
  const target = path.join(outDev, "icons", f);
  if (!fs.existsSync(target)) throw new Error(`icons/${f} が開発版に無いので差し替えられません`);
  fs.copyFileSync(path.join(iconsDev, f), target);
}
const manifestFile = path.join(outDev, "manifest.webmanifest");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
manifest.name = "Anki PWA (開発版)";
manifest.short_name = "Anki Dev";
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
const indexFile = path.join(outDev, "index.html");
replaceOnce(indexFile, '<meta name="apple-mobile-web-app-title" content="Anki">', '<meta name="apple-mobile-web-app-title" content="Anki Dev">');
replaceOnce(indexFile, "<title>anki-pwa</title>", "<title>anki-pwa (開発版)</title>");

console.log(`site built: ${outDir}`);
