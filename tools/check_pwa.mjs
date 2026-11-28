// PWA の整合性チェック。使い方: node tools/check_pwa.mjs
//  - sw.js のキャッシュ一覧が、実在するファイルと一致しているか
//    (lib/ と icons/ の全ファイルが一覧に入っているか、一覧のファイルが実在するか)
//  - manifest.webmanifest が正しい JSON で、アイコンの寸法が宣言どおりか
//  - index.html が読み込むスクリプトと manifest が一覧に入っているか
//  - 絶対パス(/ で始まる参照)が無いか(GitHub Pages のサブパスで壊れる)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

// --- sw.js の PRECACHE と CACHE_VERSION ---
const sw = read("sw.js");
const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw);
check(!!list, "sw.js has a PRECACHE list");
const precache = list ? [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
check(/const CACHE_VERSION = "[^"]+";/.test(sw), "sw.js has CACHE_VERSION");

const files = (dir) =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${dir}/${e.name}`);

for (const f of precache) {
  if (f === "./") continue;
  check(fs.existsSync(path.join(root, f)), `precache entry exists: ${f}`);
}
for (const f of [...files("lib"), ...files("icons")]) {
  check(precache.includes(f), `on disk and precached: ${f}`);
}
for (const f of ["index.html", "app.js", "storage.js", "backup.js", "relink.js", "srs.js", "profiles.js", "manifest.webmanifest"]) {
  check(precache.includes(f), `core file precached: ${f}`);
}
check(precache.includes("./"), "start URL './' precached");
check(new Set(precache).size === precache.length, "no duplicate precache entries");

// --- index.html: 読み込むスクリプトは全部キャッシュ対象か / 絶対パスが無いか ---
const html = read("index.html");
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
  check(precache.includes(m[1]), `script is precached: ${m[1]}`);
}
check(/rel="manifest"\s+href="manifest\.webmanifest"/.test(html), "index.html links the manifest");
const abs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
check(abs.length === 0, `no absolute paths in index.html ${abs.join(",")}`);
for (const f of ["app.js", "storage.js", "backup.js", "srs.js", "sw.js"]) {
  const bad = [...read(f).matchAll(/(?:fetch|register)\(\s*["'`](\/[^"'`]*)/g)].map((m) => m[1]);
  check(bad.length === 0, `no absolute fetch/register paths in ${f} ${bad.join(",")}`);
}

// --- manifest ---
let manifest = null;
try { manifest = JSON.parse(read("manifest.webmanifest")); } catch (e) { /* 下で失敗扱い */ }
check(!!manifest, "manifest is valid JSON");
if (manifest) {
  check(manifest.display === "standalone", "display is standalone");
  check(manifest.start_url === "./" && manifest.scope === "./", "start_url and scope are relative");
  for (const icon of manifest.icons ?? []) {
    const file = path.join(root, icon.src);
    check(fs.existsSync(file), `manifest icon exists: ${icon.src}`);
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    const isPng = buf.subarray(1, 4).toString() === "PNG";
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20); // PNG の IHDR
    check(isPng && `${w}x${h}` === icon.sizes, `icon size matches: ${icon.src} is ${w}x${h}, declared ${icon.sizes}`);
  }
  check((manifest.icons ?? []).some((i) => i.purpose === "maskable"), "has a maskable icon");
}
const apple = path.join(root, "icons/apple-touch-icon.png");
if (fs.existsSync(apple)) {
  const b = fs.readFileSync(apple);
  check(b.readUInt32BE(16) === 180 && b.readUInt32BE(20) === 180, "apple-touch-icon is 180x180");
}
check(/rel="apple-touch-icon"\s+href="icons\/apple-touch-icon\.png"/.test(html), "index.html links apple-touch-icon");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
