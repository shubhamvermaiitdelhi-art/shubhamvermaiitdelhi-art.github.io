/* Netlify Function: POST /api/ai -> Gemini answer (key stays server-side).
 * GET /api/ai?selftest=1 verifies the key. Cheap model + token caps. */
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const KEY = process.env.GEMINI_API_KEY || '';  // set via `netlify env:set GEMINI_API_KEY` — never hardcode a secret here
const H = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Allow-Methods':'POST, GET, OPTIONS', 'Content-Type':'application/json' };
async function gemini(text, { system, maxTokens=512, json=false } = {}) {
  if (!KEY) return { ok:false, error:'no GEMINI_API_KEY set' };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(KEY)}`;
  const body = { contents:[{ role:'user', parts:[{ text }] }], generationConfig:{ maxOutputTokens:maxTokens, temperature:0.4, ...(json?{responseMimeType:'application/json'}:{}) }, ...(system?{ systemInstruction:{ parts:[{ text:system }] } }:{}) };
  const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) return { ok:false, error:(j.error&&j.error.message)||('http '+r.status) };
  const out = (((j.candidates||[])[0]||{}).content||{}).parts?.map(p=>p.text).join('') || '';
  return { ok:true, text:out, model:MODEL };
}
// Warm-container cache + soft per-IP rate limit: at 100-1000 users most planner/nutrition
// calls repeat, so we serve them from memory and protect the Gemini quota.
const MEMO = new Map(); // hash -> {t, body}
const HITS = new Map(); // ip -> {t, n}
const MEMO_TTL = 6 * 3600 * 1000, MEMO_MAX = 500, RATE_N = 60, RATE_WIN = 60 * 1000; // one rich chat turn = up to ~6 calls; 60/min supports a real conversation
function memoKey(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return (h >>> 0).toString(36); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  if (event.httpMethod === 'GET') {
    if (!(event.queryStringParameters && event.queryStringParameters.selftest)) return { statusCode:200, headers:H, body: JSON.stringify({ ok:true, model:MODEL, keyPresent:!!KEY }) };
    const t = await gemini('Reply with exactly: OK', { maxTokens:5 });
    return { statusCode: t.ok?200:502, headers:H, body: JSON.stringify(t) };
  }
  if (event.httpMethod !== 'POST') return { statusCode:405, headers:H, body: JSON.stringify({ ok:false, error:'POST only' }) };
  try { const b = JSON.parse(event.body || '{}'); if (!b.message) return { statusCode:400, headers:H, body: JSON.stringify({ ok:false, error:'missing message' }) };
    const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'x');
    const now = Date.now();
    const rl = HITS.get(ip) || { t: now, n: 0 };
    if (now - rl.t > RATE_WIN) { rl.t = now; rl.n = 0; }
    // check BEFORE increment: a limited client retrying its fallback endpoint used
    // to burn 2 slots per ask and never recover inside the window
    if (rl.n >= RATE_N) { HITS.set(ip, rl); return { statusCode: 429, headers: H, body: JSON.stringify({ ok:false, error:'rate limited — try again in a minute' }) }; }
    rl.n++; HITS.set(ip, rl);
    const ck = memoKey(b.message + '|' + (b.system || '') + '|' + !!b.json);
    const hit = MEMO.get(ck);
    if (hit && now - hit.t < MEMO_TTL) return { statusCode: 200, headers: H, body: hit.body };
    const out = await gemini(b.message, { system:b.system, maxTokens:Math.min(+b.maxTokens||512, 1024), json:!!b.json });
    const body = JSON.stringify(out);
    if (out.ok) { if (MEMO.size > MEMO_MAX) MEMO.delete(MEMO.keys().next().value); MEMO.set(ck, { t: now, body }); }
    return { statusCode: out.ok?200:502, headers:H, body };
  } catch (e) { return { statusCode:500, headers:H, body: JSON.stringify({ ok:false, error:String(e&&e.message||e) }) }; }
};
