/* KhanaPro SW 2.0.39807 — self-updating */
const V = "kp-2.0.39807";
const SHELL = ["/", "/index.html", "/app.js?v=2.0.39807", "/styles.css?v=2.0.39807", "/tokens.css?v=2.0.39807", "/skin.css?v=2.0.39807", "/config.js?v=2.0.39807",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png",
  "/vendor/kb_engine.js","/vendor/kb_brain.js","/vendor/health_classifier.js","/vendor/cook_bhaiya.js","/vendor/engine.js","/vendor/data.js","/vendor/shopping_list.js","/vendor/scaling.js",
  "/kb/kb_ingested.js","/kb/kb_part_1.js","/kb/kb_part_10.js"];
self.addEventListener("install", e => e.waitUntil(
  caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).catch(() => {}).then(() => self.skipWaiting())
));
const KEEP = [V, "kp-kb-v1", "kp-img-v1"]; // KB + images survive deploys: recipes rarely change, users should never re-download 6MB
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return; // never cache API
  const isHTML = e.request.mode === "navigate" || url.pathname.endsWith(".html");
  if (isHTML) {
    // network-first: fresh deploys win, offline falls back to cache
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
  } else if (url.pathname.startsWith("/kb/")) {
    // stale-while-revalidate in a PERSISTENT cache: instant boot, silent background refresh
    e.respondWith(caches.open("kp-kb-v1").then(c => c.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
  } else if (url.hostname.includes("ytimg") || url.hostname.includes("wikimedia")) {
    e.respondWith(caches.open("kp-img-v1").then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok || r.type === "opaque") c.put(e.request, r.clone()); return r; }))));
  } else {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok && url.origin === location.origin) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })));
  }
});