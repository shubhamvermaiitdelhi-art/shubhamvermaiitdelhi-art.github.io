/* KhanaPro SW 2.1.2609261955 — self-updating */
const V = "kp-2.1.2609261955";
const SHELL = ["/", "/index.html", "/app.js?v=2.1.2609261955", "/styles.css?v=2.1.2609261955", "/tokens.css?v=2.1.2609261955", "/skin.css?v=2.1.2609261955", "/filter.css?v=2.1.2609261955", "/pro.css?v=2.1.2609261955", "/motion.css?v=2.1.2609261955", "/home.css?v=2.1.2609261955", "/chat.css?v=2.1.2609261955", "/detail.css?v=2.1.2609261955", "/compare.css?v=2.1.2609261955", "/desktop.css?v=2.1.2609261955", "/config.js?v=2.1.2609261955", "/kb/thumb_health.js?v=2.1.2609261955",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png",
  "/vendor/kb_engine.js","/vendor/kb_brain.js","/vendor/health_classifier.js","/vendor/cook_bhaiya.js","/vendor/engine.js","/vendor/data.js","/vendor/shopping_list.js","/vendor/scaling.js",
  "/kb/kb_part_1.js","/kb/kb_part_10.js","/kb/kb_part_11.js"];
self.addEventListener("install", e => e.waitUntil(
  caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).catch(() => {}).then(() => self.skipWaiting())
));
/* IMG cache v2 (audit P0-A): kp-img-v1 persisted opaque/404 ytimg responses
 * cache-first and could blank a device's photos forever - it is NOT in KEEP,
 * so activation deletes it. */
const IMG = "kp-img-v2", IMG_MAX = 600;
const KEEP = [V, "kp-kb-v1", IMG]; // KB + images survive deploys: recipes rarely change, users should never re-download 6MB
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
/* Images: NETWORK-FIRST over CORS (i.ytimg + wikimedia send ACAO:*), so the
 * status is visible. Only a proven-usable response (200, image/*, >1KB) is
 * persisted; a 404/opaque/failed response is never stored. Network failure
 * -> a previously VALIDATED cache entry, else a network error so the page's
 * loader runs its own fallback. A formerly failed image therefore recovers
 * on the next load. */
function imgFetch(req) {
  const cors = new Request(req.url, { mode: "cors", credentials: "omit", cache: "no-cache" });
  return fetch(cors).then(r => {
    const len = +(r.headers.get("content-length") || 0);
    const usable = r.status === 200 && /^image\//.test(r.headers.get("content-type") || "") && (!len || len > 1024);
    if (usable) {
      const c = r.clone();
      caches.open(IMG).then(x => x.put(req.url, c).then(() => x.keys()).then(ks => { if (ks.length > IMG_MAX) return Promise.all(ks.slice(0, ks.length - IMG_MAX).map(k => x.delete(k))); })).catch(() => {});
    }
    return r;
  }, () => caches.open(IMG).then(x => x.match(req.url)).then(hit => hit || fetch(req))); // no CORS/offline: validated copy, else a plain uncached fetch (a rejection lets the page fall back)
}
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
    e.respondWith(imgFetch(e.request));
  } else {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok && url.origin === location.origin) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })));
  }
});