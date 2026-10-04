// Service Worker
// 1. オフラインでも開けるようにアプリとAIファイルをキャッシュする
// 2. AIのマルチスレッド(SharedArrayBuffer)に必要なヘッダー(COOP/COEP)を付ける
//    （GitHub Pages ではヘッダーを設定できないため）
const APP_CACHE = "app-v1";
const ENGINE_CACHE = "engine-v762"; // AIを更新したら名前を変える

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== APP_CACHE && key !== ENGINE_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function withIsolation(res) {
  if (!res || res.status === 0 || res.type === "opaque") return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.includes("/engine/")) {
    // AIファイルは大きいので、一度取得したらキャッシュを使う
    event.respondWith((async () => {
      const cache = await caches.open(ENGINE_CACHE);
      let res = await cache.match(req, { ignoreSearch: true });
      if (!res) {
        res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
      }
      return withIsolation(res);
    })());
    return;
  }

  // アプリ本体はネットワーク優先(更新をすぐ反映)、つながらなければキャッシュ
  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res.clone());
      return withIsolation(res);
    } catch {
      const cached = await cache.match(req, { ignoreSearch: req.mode === "navigate" }) ||
        (req.mode === "navigate" ? await cache.match("./") || await cache.match("./index.html") : undefined);
      if (cached) return withIsolation(cached);
      throw new Error("offline");
    }
  })());
});
