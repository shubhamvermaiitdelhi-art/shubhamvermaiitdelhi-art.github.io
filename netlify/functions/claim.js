/* Payment-claim ledger (server side). Deploys with the next Netlify build.
 * Stores each UTR claim in Netlify Blobs so claims survive devices and
 * Shubham can reconcile from one place. NEVER auto-verifies - reconciliation
 * against the bank statement stays a human step. */
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Content-Type': 'application/json' };
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  let store = null;
  try { const { getStore } = require('@netlify/blobs'); store = getStore('kp-claims'); } catch {}
  if (!store) return { statusCode: 501, headers: H, body: JSON.stringify({ ok: false, error: 'blobs unavailable' }) };
  if (event.httpMethod === 'GET') {
    const key = (event.queryStringParameters || {}).admin_key || '';
    if (!process.env.KP_ADMIN_KEY || key !== process.env.KP_ADMIN_KEY) return { statusCode: 403, headers: H, body: '{"ok":false}' };
    const { blobs } = await store.list();
    const all = [];
    for (const b of blobs || []) { try { all.push(JSON.parse(await store.get(b.key))); } catch {} }
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, claims: all }) };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"ok":false}' };
  try {
    const b = JSON.parse(event.body || '{}');
    const ref = String(b.ref || '').replace(/\D/g, '');
    if (ref.length < 10 || ref.length > 22) return { statusCode: 400, headers: H, body: '{"ok":false,"error":"bad ref"}' };
    const existing = await store.get(ref).catch(() => null);
    if (existing) return { statusCode: 409, headers: H, body: '{"ok":false,"error":"duplicate"}' };
    await store.set(ref, JSON.stringify({ ref, amount: +b.amount || 0, plan: String(b.plan || '').slice(0, 20), ts: +b.ts || Date.now(), ua: String(b.ua || '').slice(0, 80), ip: (event.headers['x-nf-client-connection-ip'] || '').slice(0, 45) }));
    return { statusCode: 200, headers: H, body: '{"ok":true}' };
  } catch (e) { return { statusCode: 500, headers: H, body: JSON.stringify({ ok: false, error: String(e && e.message || e) }) }; }
};
