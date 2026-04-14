// Service worker: precache the app shell, keep data fetches network-first
// (Firebase) with no caching so we always get the latest timestamps when
// online.

const CACHE = "yt-ts-sync-v1";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => null)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept cross-origin data fetches (Firebase, YouTube thumbnails)
  if (url.origin !== self.location.origin) {
    // Thumbnails: opportunistic cache
    if (url.hostname === "i.ytimg.com") {
      event.respondWith(
        caches.open(CACHE).then(async (cache) => {
          const cached = await cache.match(req);
          if (cached) return cached;
          try {
            const resp = await fetch(req);
            if (resp.ok) cache.put(req, resp.clone());
            return resp;
          } catch {
            return cached || Response.error();
          }
        })
      );
    }
    return; // let everything else pass through
  }

  // Same-origin: cache-first for app shell, network fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
