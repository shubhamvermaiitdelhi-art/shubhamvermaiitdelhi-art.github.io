/* CartPilot funnel core — server-side real-time price fetch + optimize.
 * Reuses the SAME tested engine.js + data.js the app uses. Works in Node 18+
 * (global fetch). Apify actors do the real per-store scraping with residential
 * proxies; we never fake "live". If no token, callers fall back to demo data. */
const E = require('../engine.js');
const D = require('../data.js');

const DEFAULT_LOC = { area: 'Essel Towers, MG Road, Sector 28', city: 'Gurgaon', lat: 28.47955, lng: 77.08 };
const cache = new Map();                  // key -> {rows, exp}
const TTL = Number(process.env.PRICE_TTL_MS || 90 * 1000);
const ck = (pk, item, loc) => `${pk}|${String(item).toLowerCase()}|${loc.lat},${loc.lng}`;

async function fetchStoreItem(pk, item, loc, token) {
  const meta = D.PLATFORMS[pk];
  if (!meta) return [];
  const key = ck(pk, item, loc);
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.rows;
  let rows = [];
  let live = false;
  if (meta.live && meta.actor && token) {
    const r = await D.fetchPlatform(pk, item, loc, token, 12);   // real Apify call
    if (r && r.ok && r.products && r.products.length) {
      const tok = String(item).toLowerCase().split(/\s+/)[0];
      const rel = r.products.filter(p => String(p.name||'').toLowerCase().includes(tok) || tok.length < 3);
      rows = (rel.length ? rel : r.products); live = true;   // prefer relevant matches
    }
  }
  if (!rows.length) rows = D.demoFetch(pk, item);                 // honest fallback
  rows = rows.map(x => Object.assign({}, x, { _live: live }));
  if (live) cache.set(key, { rows, exp: Date.now() + TTL });      // only cache real reads
  return rows;
}

// Compare a parsed/free-text list across stores. Returns engine result + source map.
async function compare({ list, items, loc, stores, token }) {
  loc = Object.assign({}, DEFAULT_LOC, loc || {});
  // Respect an explicitly-passed token (even empty = "no live"); only fall back to
  // the server env token when the caller omits it. NEVER hardcode a secret here.
  if (token === undefined || token === null) token = process.env.APIFY_TOKEN || '';
  const parsed = items && items.length ? items.map(E.finalizeItem).filter(Boolean)
                                       : E.parseList(String(list || ''));
  if (!parsed.length) return { ok: false, error: 'empty or unparseable list' };
  const only = (stores && stores.length) ? stores : D.PLATFORM_ORDER;

  const productsByItem = {};
  const source = {};                                             // store -> 'live' | 'estimated'
  for (const it of parsed) productsByItem[it.name] = {};
  await Promise.all(only.flatMap(pk => parsed.map(async (it) => {
    const rows = await fetchStoreItem(pk, it.name, loc, token);
    productsByItem[it.name][pk] = rows;
    if (rows.some(r => r._live)) source[pk] = 'live';
    else if (source[pk] !== 'live') source[pk] = 'estimated';
  })));

  const meta = {};
  for (const pk of only) { const p = D.PLATFORMS[pk]; meta[pk] = { name: p.name, deliveryFee: p.deliveryFee, handlingFee: p.handlingFee, freeDeliveryAbove: p.freeDeliveryAbove, etaMinutes: p.etaMinutes }; }
  const result = E.optimize(parsed, productsByItem, meta, { splitThreshold: 50 });
  const anyLive = Object.values(source).some(v => v === 'live');
  return { ok: true, items: parsed, result, productsByItem, source, dataMode: anyLive ? 'live' : 'estimated', tokenPresent: !!token };
}

module.exports = { compare, fetchStoreItem, DEFAULT_LOC };
