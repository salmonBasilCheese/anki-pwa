// 公開サイトの組み立て(tools/build_site.mjs)のテスト。使い方: node tools/check_site.mjs
// 今の作業フォルダを「安定版」「開発版」の両方として組み立て、結果を調べる。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "anki-site-"));
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed++; };
const read = (p) => fs.readFileSync(path.join(out, p), "utf8");
const bytes = (p) => fs.readFileSync(path.join(out, p));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? [e.name + "/", ...walk(path.join(dir, e.name)).map((x) => e.name + "/" + x)] : [e.name]);

try {
  execFileSync(process.execPath, [path.join(root, "tools/build_site.mjs"), "--stable", root, "--dev", root, "--out", out], { stdio: "pipe" });

  // 安定版(直下)は元のまま
  for (const f of ["index.html", "app.js", "sw.js", "storage.js", "backup.js", "manifest.webmanifest", "icons/icon-192.png"]) {
    check(fs.existsSync(path.join(out, f)), `stable has ${f}`);
  }
  check(bytes("index.html").equals(fs.readFileSync(path.join(root, "index.html"))), "stable index.html is untouched");
  check(JSON.parse(read("manifest.webmanifest")).name === "Anki PWA", "stable manifest name is unchanged");
  check(bytes("icons/icon-192.png").equals(fs.readFileSync(path.join(root, "icons/icon-192.png"))), "stable icon is untouched");

  // 開発版(dev/)は見た目が違う
  check(fs.existsSync(path.join(out, "dev/index.html")), "dev has index.html");
  const dm = JSON.parse(read("dev/manifest.webmanifest"));
  check(dm.name.includes("開発版") && dm.short_name === "Anki Dev", "dev manifest is renamed");
  check(dm.start_url === "./" && dm.scope === "./", "dev manifest keeps relative start_url/scope");
  check(read("dev/index.html").includes('content="Anki Dev"') && read("dev/index.html").includes("<title>anki-pwa (開発版)</title>"), "dev index.html title and app name are patched");
  for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
    check(!bytes(`dev/icons/${f}`).equals(bytes(`icons/${f}`)), `dev icon differs from stable: ${f}`);
    const b = bytes(`dev/icons/${f}`);
    const manifestSize = dm.icons.find((i) => i.src === `icons/${f}`)?.sizes;
    if (manifestSize) check(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` === manifestSize, `dev icon size matches manifest: ${f}`);
  }
  check(read("dev/sw.js") === read("sw.js"), "sw.js is the same file (the channel is chosen by the URL path at runtime)");

  // 公開してはいけないものが入っていない
  const all = walk(out);
  const bad = all.filter((p) => /(^|\/)(\.git|\.github|tools|data|icons-dev|docs|CLAUDE\.md|inspect_apkg\.py)(\/|$)/.test(p) || /\.(apkg|colpkg|anki2|mp3|pdf|epub)$/i.test(p));
  check(bad.length === 0, `no private/dev files in the site ${bad.join(",")}`);
} catch (e) {
  failed++;
  console.log(`FAIL build: ${e.stderr?.toString() || e.message}`);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}

// --- 版の分離: sw.js の安定版のキャッシュ名と、開発版のキャッシュ名が互いに消し合わない ---
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
check(/CACHE_PREFIX = CHANNEL === "dev" \? "dev-anki-pwa-" : "anki-pwa-"/.test(sw), "sw.js: dev cache prefix is 'dev-anki-pwa-', stable is 'anki-pwa-'");
check(!"dev-anki-pwa-v4".startsWith("anki-pwa-"), "a stable-style cleanup cannot match dev caches");
check(/n\.startsWith\(CACHE_PREFIX\)/.test(sw), "sw.js cleanup only touches its own prefix");
const st = fs.readFileSync(path.join(root, "storage.js"), "utf8");
check(/DB_NAME = CHANNEL === "dev" \? "anki-pwa-dev" : "anki-pwa"/.test(st), "storage.js: stable keeps DB 'anki-pwa', dev uses 'anki-pwa-dev'");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
