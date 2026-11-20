"use strict";

// ---------------------------------------------------------------
// アプリを更新したら、この番号を上げる(v1 → v2 ...)。
// 番号が変わると新しいキャッシュが作られ、古いキャッシュは削除される。
// ---------------------------------------------------------------
const CACHE_VERSION = "v2";
const CACHE_NAME = `anki-pwa-${CACHE_VERSION}`;

// オフラインで必要なファイルの一覧(すべて、この sw.js からの相対パス)。
// ファイルを足したら、ここにも足すこと。足し忘れは `node tools/check_pwa.mjs` で検出できる。
const PRECACHE = [
  "./",
  "index.html",
  "app.js",
  "storage.js",
  "srs.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "lib/jszip.min.js",
  "lib/purify.min.js",
  "lib/sql-wasm.js",
  "lib/sql-wasm.wasm",
  "lib/ts-fsrs.umd.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // cache: "reload" … ブラウザの HTTP キャッシュ(GitHub Pages は約10分)に残った
      // 古いファイルを拾わず、必ずサーバーから取り直す。1つでも失敗すれば install 全体が失敗し、
      // 古いバージョンがそのまま使われ続ける(中途半端なキャッシュにならない)。
      await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: "reload" })));
      // skipWaiting() はここでは呼ばない。学習中に勝手に入れ替わらないよう、
      // 画面の「更新」ボタン(message: SKIP_WAITING)で切り替える。
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("anki-pwa-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  // 画面に「アプリのバージョン」を出すための問い合わせ
  if (event.data === "GET_VERSION") event.ports[0]?.postMessage({ version: CACHE_VERSION });
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      // ignoreSearch: ?debug=1 のようなクエリ付きでもキャッシュに当てる
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (err) {
        if (req.mode === "navigate") {
          const shell = await caches.match("./", { ignoreSearch: true });
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
