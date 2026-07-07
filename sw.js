/* KhanaPro SW 2.0.23446 — self-updating */
const V = "kp-2.0.23446";
self.addEventListener("install", e => self.skipWaiting());
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