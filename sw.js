/* KhanaPro SW 2.0.24301 — self-updating */
const V = "kp-2.0.24301";
const SHELL = ["/", "/index.html", "/app.js?v=2.0.24301", "/styles.css?v=2.0.24301", "/config.js?v=2.0.24301",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png",
  "/vendor/kb_engine.js","/vendor/kb_brain.js","/vendor/health_classifier.js","/vendor/cook_bhaiya.js","/vendor/engine.js","/vendor/data.js","/vendor/shopping_list.js",
  "/kb/kb_ingested.js","/kb/kb_part_1.js","/kb/kb_part_10.js"];
self.addEventListener("install", e => e.waitUntil(
  caches.open(V).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return; // never cache API
  const isHTML = e.request.mode === "navigate" || url.pathname.endsWith(".html");
  if (isHTML) {
    // network-first: fresh deploys win, offline falls back to cache
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
  } else {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok && (url.origin === location.origin || url.hostname.includes("ytimg") || url.hostname.includes("wikimedia"))) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })));
  }
});