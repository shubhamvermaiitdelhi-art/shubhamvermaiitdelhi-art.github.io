/* node funnel/livecheck.js "paneer,milk,onion"  — verifies LIVE prices end to end.
 * Reads APIFY_TOKEN from env. Prints per-store source (live/estimated) + the cheapest basket. */
const { compare } = require('./core.js');
(async () => {
  const list = (process.argv[2] || 'paneer,milk,onion,tomato').split(',').join('\n');
  const out = await compare({ list, token: process.env.APIFY_TOKEN || '' });
  if (!out.ok) { console.error('ERROR:', out.error); process.exit(1); }
  console.log('token present :', out.tokenPresent);
  console.log('data mode     :', out.dataMode);
  console.log('per-store src :', out.source);
  const best = out.result.top3[0];
  console.log('cheapest      :', best.label, '₹' + Math.round(best.total), `(${best.itemsFound}/${best.itemsTotal} items)`);
})();
