/* Netlify Function: POST /api/prices -> live store listings via Apify actors.
 * v50: APIFY_TOKEN stays SERVER-SIDE so every Pro user gets live prices without
 * the founder's token ever reaching a device. Per-user daily quota in Netlify
 * Blobs. Mirrors the browser contract (dist/vendor/data.js fetchPlatform):
 * client sends {uid, platform, query, loc, maxItems}; we return RAW actor rows
 * ({ok:true, items:[...]}) and the client runs its own normalize().
 * Without APIFY_TOKEN env: honest {ok:false, reason:"no-server-token"}. */
const TOKEN = process.env.APIFY_TOKEN || '';
const DAILY_CALLS = +(process.env.KP_PRICES_DAILY || 90); // actor calls / user / day
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Content-Type': 'application/json' };

// TWIN TABLE: keep in sync with data.js PLATFORMS (actor + input shape)
const ACTORS = {
  blinkit: { actor: 'architjn~blinkit-search-scraper', input: (q, loc, n) => ({ queries: [q], latitude: loc.lat, longitude: loc.lng, maxItemsPerQuery: n }), needs: 'latlng' },
  zepto: { actor: 'architjn~zepto-search-scraper', input: (q, loc, n) => ({ queries: [q], locationQuery: (loc.area || '') + ' ' + (loc.city || ''), maxItemsPerQuery: n }), needs: 'area' },
  amazon: { actor: 'magicfingers~amazon-product-scraper', input: (q, loc, n) => ({ mode: 'SEARCH', searchQueries: [q], domain: 'amazon.in', maxSearchResults: n }), needs: 'none' },
  flipkart: { actor: 'stealth_mode~flipkart-product-search-scraper', input: (q, loc, n) => ({ search_queries: [q], max_products: n }), needs: 'none' },
  jiomart: { actor: 'aadyantha~jiomart-search-scrapper', input: (q, loc, n) => ({ search_strings: [q], max_results: n, location: (loc && loc.city) || 'Gurgaon', proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'IN' } }), needs: 'none' },
};

async function quotaOk(uid) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('kp-prices-quota');
    const day = new Date().toISOString().slice(0, 10);
    const key = uid + '|' + day;
    const cur = +(await store.get(key)) || 0;
    if (cur >= DAILY_CALLS) return { ok: false, used: cur };
    await store.set(key, String(cur + 1));
    return { ok: true, used: cur + 1 };
  } catch { return { ok: true, used: -1 }; } // quota store down must never break prices
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  if (event.httpMethod === 'GET') return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, tokenPresent: !!TOKEN, platforms: Object.keys(ACTORS), dailyCalls: DAILY_CALLS }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: JSON.stringify({ ok: false, error: 'POST only' }) };
  if (!TOKEN) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, reason: 'no-server-token' }) };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const uid = String(body.uid || event.headers['x-nf-client-connection-ip'] || 'anon').slice(0, 64);
  const meta = ACTORS[body.platform];
  const q = String(body.query || '').slice(0, 80).trim();
  const loc = body.loc && typeof body.loc === 'object' ? body.loc : {};
  if (!meta || !q) return { statusCode: 400, headers: H, body: JSON.stringify({ ok: false, reason: 'bad-request' }) };
  if (meta.needs === 'latlng' && !(loc.lat && loc.lng)) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, reason: 'no-location' }) };
  const quota = await quotaOk(uid);
  if (!quota.ok) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, reason: 'quota', used: quota.used }) };
  const n = Math.min(20, +body.maxItems || 12);
  try {
    const url = 'https://api.apify.com/v2/acts/' + meta.actor + '/run-sync-get-dataset-items?token=' + encodeURIComponent(TOKEN);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 24000); // stay under the function's own timeout
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta.input(q, loc, n)), signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, reason: 'actor-http-' + r.status }) };
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data.items || []);
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, items: arr.slice(0, n), used: quota.used }) };
  } catch (e) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, reason: String(e && e.message || e).slice(0, 80) }) };
  }
};
