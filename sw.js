// Digital logbooks offline support -- same network-first strategy as the
// shared app's own sw.js (core/sw.js): every successful GET is cached as
// it's fetched (this app's files, the shared app under /core/, the 3D
// model's parts, images), so one online visit caches everything; offline,
// cached copies serve instead and an uncached navigation falls back to the
// cached page. The libraries come from cdnjs (three.js, jsPDF, the QR code
// generator) and jsDelivr (the Supabase client, the QR code reader), cached
// too -- without them the Scrutineering site can't start offline.
// /api/ (AI photo analysis) is never cached.

const CACHE_NAME = "logbook-v1";
const CACHEABLE_ORIGINS = [self.location.origin, "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"];
const SLOW_NETWORK_MS = 4000;
const PRECACHE_URLS =["/", "/index.html", "/config.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

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

  const fallback = async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = (await caches.match("/")) || (await caches.match("/index.html"));
      if (shell) return shell;
    }
    return null;
  };
  const network = fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  });
  // A weak connection (an event's paddock): after a few seconds without an answer, the cached
  // copy serves -- the network one still updates the cache when it comes.
  const slow = new Promise((resolve) => setTimeout(resolve, SLOW_NETWORK_MS)).then(fallback);
  event.respondWith(
    Promise.race([network.catch(() => null), slow.then((cached) => cached || network.catch(() => null))])
      .then((r) => r || fallback())
      .then((r) => r || Response.error())
  );
});
