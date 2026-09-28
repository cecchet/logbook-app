// Digital logbooks offline support -- same network-first strategy as the
// shared app's own sw.js (core/sw.js): every successful GET is cached as
// it's fetched (this app's files, the shared app under /core/, the 3D
// model's parts, images), so one online visit caches everything; offline,
// cached copies serve instead and an uncached navigation falls back to the
// cached page. The three.js / jsPDF libraries come from cdnjs, cached too.
// /api/ (AI photo analysis) is never cached.

const CACHE_NAME = "logbook-v1";
const CACHEABLE_ORIGINS = [self.location.origin, "https://cdnjs.cloudflare.com"];
const PRECACHE_URLS = ["/", "/index.html", "/config.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!CACHEABLE_ORIGINS.includes(url.origin) || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = (await caches.match("/")) || (await caches.match("/index.html"));
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
