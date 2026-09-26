#!/usr/bin/env node
/* Launch-day synthetic check for the Cook AI gateway (audit round-2 P1-4).
 *
 * Probes production the way a browser does (Origin + signed session), measures
 * latency, reads the admin metrics when a key is available, and ALERTS on:
 *   - probe failures      >= 2 of 3 synthetic calls fail (429/503/timeout/invalid)
 *   - probe latency       median synthetic call > KP_SYNTH_MAX_MS (default 8000)
 *   - sustained errors    last hour error rate >= 30% over >= 20 provider calls
 *   - sustained latency   last hour p95 >= 8000 ms
 *   - degraded            the public health line says degraded
 * Alert delivery: exit code 1 (the scheduled GitHub Actions run fails, and
 * GitHub emails the repo owner) + an optional webhook (Slack/Discord/ntfy style
 * JSON {text, content}) from KP_ALERT_WEBHOOK.
 *
 *   node tools/synthetic_ai_check.js                  # real check
 *   node tools/synthetic_ai_check.js --test-alert     # force an alert to verify delivery
 * Env: KP_SYNTH_BASE (default https://khanapro.netlify.app), KP_SYNTH_ORIGIN
 * (default https://khanapro.com), KP_ADMIN_KEY (optional, never printed),
 * KP_ALERT_WEBHOOK (optional). No prompt text or secret is ever logged. */
"use strict";
const BASE = (process.env.KP_SYNTH_BASE || "https://khanapro.netlify.app").replace(/\/+$/, "");
const ORIGIN = process.env.KP_SYNTH_ORIGIN || "https://khanapro.com";
const MAX_MS = +(process.env.KP_SYNTH_MAX_MS || 8000);
const TEST = process.argv.includes("--test-alert");

async function timed(fn) { const t = Date.now(); try { return { r: await fn(), ms: Date.now() - t }; } catch (e) { return { e, ms: Date.now() - t }; } }
async function get(path, headers = {}, ms = 10000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(BASE + path, { headers: Object.assign({ Origin: ORIGIN }, headers), signal: ac.signal }); return { status: r.status, j: await r.json().catch(() => null) }; }
  finally { clearTimeout(t); }
}
async function post(path, body, headers = {}, ms = 15000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(BASE + path, { method: "POST", headers: Object.assign({ Origin: ORIGIN, "Content-Type": "application/json" }, headers), body: JSON.stringify(body), signal: ac.signal }); return { status: r.status, j: await r.json().catch(() => null) }; }
  finally { clearTimeout(t); }
}
const cid = () => ("syn" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 20);

async function alert(lines) {
  const text = "KhanaPro Cook AI ALERT (" + new Date().toISOString() + ")\n" + lines.map(l => "- " + l).join("\n");
  console.log(text);
  const hook = process.env.KP_ALERT_WEBHOOK;
  if (hook) {
    try {
      const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) });
      console.log("webhook delivery: HTTP " + r.status);
    } catch (e) { console.log("webhook delivery FAILED: " + (e && e.message)); }
  } else console.log("webhook: not configured (KP_ALERT_WEBHOOK) - relying on the failed-run email");
}

(async () => {
  const problems = [];
  const out = { at: new Date().toISOString(), base: BASE, probes: [] };
  if (TEST) problems.push("TEST ALERT - delivery check requested with --test-alert (nothing is wrong)");

  // 1. public health line
  const h = await timed(() => get("/api/ai"));
  out.health = h.r ? { status: h.r.status, degraded: !!(h.r.j && h.r.j.degraded), reason: h.r.j && h.r.j.reason } : { error: String(h.e && h.e.message) };
  if (!h.r || h.r.status !== 200) problems.push("health line unreachable (" + (h.r ? h.r.status : h.e && h.e.message) + ")");
  else if (h.r.j && h.r.j.degraded) problems.push("gateway reports DEGRADED (" + (h.r.j.reason || "?") + ")");

  // 2. synthetic calls through a real signed session
  const s = await timed(() => get("/api/session"));
  const tok = s.r && s.r.j && s.r.j.token;
  if (!tok) problems.push("session endpoint failed (" + (s.r ? s.r.status : s.e && s.e.message) + ")");
  else {
    for (let i = 0; i < 3; i++) {
      const c = cid();
      const p = await timed(() => post("/api/ai", { op: "compose_reply", message: "User: synthetic health check " + i, vars: { hi: false, veg: false, firstName: "Dal Tadka", names: "Dal Tadka (320 kcal, 14g protein)", note: "" }, maxTokens: 20 }, { "X-KP-Session": tok, "X-KP-Cid": c }));
      const okk = p.r && p.r.status === 200 && p.r.j && p.r.j.ok;
      out.probes.push({ cid: c, status: p.r ? p.r.status : 0, cls: p.r && p.r.j ? (p.r.j.cls || p.r.j.error || "") : String(p.e && p.e.name), ms: p.ms, ok: !!okk });
    }
    const fails = out.probes.filter(x => !x.ok).length;
    const med = out.probes.map(x => x.ms).sort((a, b) => a - b)[1];
    out.medianMs = med;
    if (fails >= 2) problems.push(fails + "/3 synthetic calls failed: " + out.probes.map(x => x.status + (x.cls ? ":" + x.cls : "")).join(", "));
    if (med > MAX_MS) problems.push("synthetic median latency " + med + " ms > " + MAX_MS + " ms");
  }

  // 3. sustained signals from the server metrics (admin)
  if (process.env.KP_ADMIN_KEY) {
    const m = await timed(() => get("/api/ai?metrics=1&hours=1", { "X-KP-Admin": process.env.KP_ADMIN_KEY }));
    const j = m.r && m.r.j;
    if (j && j.ok) {
      out.metrics = { volume: j.volume, success: j.success, r429: j.r429, r503: j.r503, timeout: j.timeout, invalid: j.invalid, errorRate: j.errorRate, p50: j.p50, p95: j.p95 };
      const provider = (j.volume || 0) - (j.rejected || 0) - (j.budget || 0);
      if (provider >= 20 && j.errorRate >= 0.3) problems.push("last hour: error rate " + Math.round(j.errorRate * 100) + "% over " + provider + " provider calls (429 " + j.r429 + ", 503 " + j.r503 + ", timeout " + j.timeout + ", invalid " + j.invalid + ")");
      if (j.p95 != null && j.p95 >= 8000 && provider >= 10) problems.push("last hour: p95 latency " + j.p95 + " ms");
    } else out.metrics = { unavailable: true, status: m.r ? m.r.status : 0 };
  } else out.metrics = { skipped: "no KP_ADMIN_KEY" };

  console.log(JSON.stringify(out, null, 1));
  if (problems.length) { await alert(problems); process.exit(1); }
  console.log("synthetic check: OK");
})().catch(async e => { await alert(["synthetic check crashed: " + (e && e.message)]); process.exit(1); });
