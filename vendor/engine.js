/* ============================================================================
 * CartPilot Engine — pure logic: list parsing, unit math, product matching,
 * basket optimization (cost > availability > rating > delivery), split orders.
 * Runs in the browser AND under Node (for tests). No DOM, no network here.
 * ==========================================================================*/
(function (root) {
  'use strict';

  // ---- Unit normalization ---------------------------------------------------
  // Everything weight -> grams, volume -> millilitres, count -> pieces.
  const UNIT_MAP = {
    kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'],
    g:  ['g', 'gm', 'gms', 'gram', 'grams'],
    l:  ['l', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'],
    ml: ['ml', 'mls', 'millilitre', 'millilitres'],
    pc: ['pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'nos', 'no', 'pack', 'packs', 'pkt', 'packet'],
    dozen: ['dozen', 'dz'],
  };
  const UNIT_LOOKUP = (() => {
    const m = {};
    for (const canon in UNIT_MAP) for (const a of UNIT_MAP[canon]) m[a] = canon;
    return m;
  })();
  // dimension + factor to base (g / ml / pc)
  const UNIT_BASE = {
    kg: ['weight', 1000], g: ['weight', 1],
    l: ['volume', 1000], ml: ['volume', 1],
    pc: ['count', 1], dozen: ['count', 12],
  };

  function canonUnit(u) {
    if (!u) return null;
    return UNIT_LOOKUP[String(u).toLowerCase().replace(/\./g, '')] || null;
  }

  // Convert {qty, unit} -> {dim, base} e.g. {1,'kg'} -> {dim:'weight', base:1000}
  function toBase(qty, unit) {
    const c = canonUnit(unit);
    if (!c || !UNIT_BASE[c]) return null;
    const [dim, factor] = UNIT_BASE[c];
    return { dim, base: qty * factor };
  }


  // ---- Quantity words & fractions (Hindi + English) -> decimal numbers ------
  // Common in Indian lists: "aadha kg" (half), "paav kg" (quarter), "dedh kg"
  // (1.5), "sava" (1.25), "dhai" (2.5), "pauna" (0.75); also "1/2 kg", "1 1/2 kg".
  const QWORDS = {
    half:0.5, aadha:0.5, adha:0.5, aadhaa:0.5, aadh:0.5,
    quarter:0.25, paav:0.25, pav:0.25, paaw:0.25, paava:0.25, paw:0.25,
    pauna:0.75, paune:0.75, pona:0.75, paun:0.75,
    sava:1.25, sawa:1.25, savaa:1.25, sawaa:1.25,
    dedh:1.5, derh:1.5, deodh:1.5, dhedh:1.5,
    dhai:2.5, dhaai:2.5, adhai:2.5, arhai:2.5, dhayi:2.5,
  };
  const QUNIT_ALT = Object.keys(UNIT_LOOKUP).sort((a, b) => b.length - a.length).join('|');
  // Cardinal number words (Hindi + English) -> digits. Real lists say
  // "do kg aloo" (2), "teen packet maggi" (3), "paanch kela" (5), "ek dozen anda".
  // Ambiguous tokens deliberately omitted: "tin" (a can), "no/nos" (a unit).
  const NUMWORDS = {
    ek:1, ik:1, one:1,
    do:2, doh:2, two:2,
    teen:3, three:3,
    char:4, chaar:4, four:4,
    paanch:5, panch:5, paach:5, five:5,
    chhe:6, chhah:6, chah:6, six:6,
    saat:7, seven:7,
    aath:8, eight:8,
    nau:9, nine:9,
    das:10, dus:10, ten:10,
  };
  const NW_ALT = Object.keys(NUMWORDS).sort((a, b) => b.length - a.length).join('|');
  function normalizeQuant(str) {
    let s = ' ' + String(str || '').toLowerCase() + ' ';
    // mixed fraction "1 1/2" -> 1.5
    s = s.replace(/\b(\d+)\s+(\d+)\s*\/\s*(\d+)\b/g, (m, w, a, b) =>
      (+b ? Math.round((+w + (+a / +b)) * 1000) / 1000 : w).toString());
    // simple fraction "1/2" -> 0.5
    s = s.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, (m, a, b) =>
      (+b ? Math.round((+a / +b) * 1000) / 1000 : a).toString());
    // numeric RANGE "2-3", "2 - 3", "2 to 3", "1\u20132 kg" -> upper bound.
    // Runs AFTER fraction conversion (so 1/2, 1 1/2 are already plain decimals).
    // Picks the higher number so the user always has enough (matches stock-up intent).
    // Guards: 'to' needs word boundaries (so "tomato"/"potato" are untouched); a number
    // immediately glued to letters on its left (e.g. a unit) is not a left operand.
    s = s.replace(/(^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*(?:-|\u2013|\u2014|to)\s*(\d+(?:\.\d+)?)\b/gi,
      (m, pre, a, b) => pre + Math.max(parseFloat(a), parseFloat(b)).toString());
    // cardinal number word + unit  -> digit + unit  ("do kg" -> "2 kg")
    s = s.replace(new RegExp('\\b(' + NW_ALT + ')\\s+(' + QUNIT_ALT + ')\\b', 'gi'),
      (m, w, u) => NUMWORDS[w.toLowerCase()] + ' ' + u);
    // segment-leading cardinal word + item word -> digit + item ("paanch kela" -> "5 kela").
    // Anchored to start or a separator so mid-phrase words are never touched.
    s = s.replace(new RegExp('(^|[\\s,;:/&+])(' + NW_ALT + ')\\s+(?=[a-z])', 'gi'),
      (m, pre, w) => pre + NUMWORDS[w.toLowerCase()] + ' ');
    // quantity words -> number, only when a unit follows (so "pav"=bread stays a word)
    for (const w in QWORDS) {
      s = s.replace(new RegExp('\\b' + w + '\\s+(' + QUNIT_ALT + ')\\b', 'gi'), QWORDS[w] + ' $1');
    }
    // indefinite article = a quantity of one: "an onion" -> "1 onion",
    // "a kg potato" -> "1 kg potato", "a dozen eggs" -> "1 dozen eggs",
    // "a packet bread" -> "1 packet bread". Segment-anchored and must be followed by a
    // letter, so "A2"/"a 2 ..." digit forms are never touched. Without this the article
    // leaked into the product name AND the absent quantity fell through to the stock-up
    // default ("an onion" -> 2 kg). Runs before the bare-dozen rule below.
    s = s.replace(/(^|[\s,;:/&+])an?\s+(?=[a-z])/gi, (m, pre) => pre + '1 ');
    // bare "dozen X" with no leading count -> "1 dozen X" ("dozen banana" -> 12 pc).
    // Negative lookbehinds leave a real count alone ("2 dozen", "0.5 dozen" stay as-is).
    s = s.replace(/(?<![\d.])(?<![\d.]\s)\bdozen\b/gi, '1 dozen');
    // container / packaging words used as a count next to a number -> 'pc'
    // ("2 bottle coke" -> "2 pc coke", "1 can pepsi", "2 carton milk"). Guard:
    // "bottle gourd" / "ridge gourd" must stay product names, never a count.
    s = s.replace(/(\d+(?:\.\d+)?)\s*bottles?\b(?!\s+gourd)/gi, '$1 pc');
    s = s.replace(/(\d+(?:\.\d+)?)\s*(?:cans?|tins?|jars?|boxes|box|cartons?|sachets?|pouch(?:es)?|tubes?|bars?|tetra\s*packs?|tetrapacks?|slabs?)\b/gi, '$1 pc');
    return s.replace(/\s+/g, ' ').trim();
  }

  // ---- Smart normalization: Hindi->English, spell-fix, serving defaults ------
  const HINDI = {
    aloo:'potato', aalu:'potato', alu:'potato', tamatar:'tomato', tamaatar:'tomato',
    pyaaz:'onion', pyaz:'onion', pyaz:'onion', doodh:'milk', dudh:'milk',
    anda:'egg', ande:'egg', ander:'egg', makhan:'butter', dahi:'curd',
    chawal:'rice', chaval:'rice', cheeni:'sugar', chini:'sugar', shakkar:'sugar',
    namak:'salt', tel:'oil', kela:'banana', kele:'banana', seb:'apple',
    nimbu:'lemon', neembu:'lemon', adrak:'ginger', lehsun:'garlic', lasun:'garlic',
    dhania:'coriander', dhaniya:'coriander', haldi:'turmeric', mirch:'chilli',
    jeera:'cumin', kaju:'cashew', badam:'almond', ghee:'ghee', maida:'maida',
    besan:'besan', atta:'atta', paneer:'paneer', dhood:'milk', bhindi:'okra',
    gobi:'cauliflower', gobhi:'cauliflower', matar:'peas', palak:'spinach',
    baingan:'eggplant', brinjal:'eggplant', gajar:'carrot', kheera:'cucumber',
    nariyal:'coconut', biscuit:'biscuit', roti:'bread', double_roti:'bread',
    chai:'tea', paani:'water', pani:'water', sabzi:'vegetable', dal:'dal', daal:'dal',
    pyaj:'onion', pyaaj:'onion', lauki:'bottle gourd', ghiya:'bottle gourd',
    turai:'ridge gourd', tori:'ridge gourd', torai:'ridge gourd', gobi:'cauliflower',
    mung:'moong', moong:'moong', chana:'chana', aamchur:'amchur',
    lahsun:'garlic', lasoon:'garlic', shimla:'capsicum', kheere:'cucumber',
  };
  // Known grocery / brand words used for spell-correction (don't "fix" these)
  const VOCAB = new Set(['potato','tomato','onion','milk','bread','egg','eggs','butter',
    'banana','rice','sugar','oil','atta','flour','maida','besan','curd','paneer','cheese',
    'maggi','noodles','biscuit','tea','coffee','salt','apple','cucumber','lemon','ginger',
    'garlic','chips','water','coke','pepsi','cola','coriander','turmeric','chilli','cumin',
    'spinach','peas','carrot','cauliflower','okra','eggplant','capsicum','coconut','ghee',
    'cashew','almond','dal','vegetable','curd','yogurt','juice','soap','shampoo','oats',
    'honey','jam','sauce','ketchup','mayonnaise','pasta','bread','chicken','fish','mutton',
    'paneer','tofu','corn','beans','potato','mango','orange','grapes','pomegranate',
    'gourd','capsicum','cauliflower','fenugreek','kasuri','methi','paste','powder','masala',
    'moong','chana','toor','arhar','urad','masoor','amchur','turmeric','coriander','cumin',
    'chilli','besan','ghee','bottle','ridge']);
  const BRANDS = new Set(['amul','britannia','tata','fortune','aashirvaad','nescafe','bru',
    'lays','kurkure','parle','bisleri','mother','dairy','gold','maggi','kissan','saffola',
    'patanjali','nestle','cadbury','dabur','colgate','surf','vim','dettol','horlicks',
    'good','day','red','label','everyday','epic','organic','farm','fresh','local','premium']);
  const DEFAULTS = [
    [['milk'],[1,'l']], [['water'],[1,'l']], [['coke','pepsi','cola'],[750,'ml']],
    [['oil'],[500,'ml']], [['curd','yogurt','paneer','cheese'],[200,'g']],
    [['butter'],[100,'g']], [['ghee'],[200,'g']], [['egg','eggs'],[6,'pc']],
    [['banana'],[6,'pc']], [['lemon'],[4,'pc']], [['bread'],[1,'pc']],
    [['ginger','garlic'],[100,'g']], [['rice','atta','flour','maida','besan'],[1,'kg']],
    [['sugar','salt'],[500,'g']], [['tea'],[250,'g']], [['coffee'],[100,'g']],
    [['potato','tomato','onion','cucumber','carrot','spinach','peas','capsicum','okra',
      'eggplant','cauliflower','beans','apple','mango','orange','coriander'],[500,'g']],
  ];
  // Non-perishables -> stock up to avoid repeat orders
  const STAPLE = [
    [['paste'],[1,'pc']],
    [['potato'],[3,'kg']], [['onion'],[2,'kg']], [['tomato'],[2,'kg']],
    [['sugar'],[1.5,'kg']], [['salt'],[1,'kg']], [['rice'],[5,'kg']],
    [['atta','flour','maida'],[5,'kg']], [['besan'],[1,'kg']], [['oil'],[1,'l']],
    [['ghee'],[500,'g']], [['dal','moong','chana','toor','arhar','urad','masoor'],[1,'kg']],
    [['garlic'],[250,'g']], [['ginger'],[200,'g']], [['kasuri'],[100,'g']],
    [['turmeric','coriander','chilli','cumin','amchur','garam'],[200,'g']],
    [['tea'],[250,'g']], [['coffee'],[100,'g']],
  ];
  const HEADSET = new Set([...VOCAB, ...Object.keys(HINDI), ...Object.values(HINDI).join(' ').split(' ')]);
  // Phrase collapses for run-on lines (longest first). _ joins multiword items.
  const PHRASES = [
    [/\badrak\s+lahsun\s+(?:pest|paste)\b/g,'ginger_garlic_paste'],
    [/\b(?:ginger\s+garlic|garlic\s+ginger)\s+(?:pest|paste)\b/g,'ginger_garlic_paste'],
    [/\blahsun\s+(?:pest|paste)\b/g,'garlic_paste'],
    [/\bphool\s+gob(?:h)?i\b/g,'cauliflower'], [/\bgob(?:h)?i\b/g,'cauliflower'],
    [/\bkasuri\s+methi\b/g,'kasuri_methi'],
    [/\bhaldi\s+powder\b/g,'turmeric_powder'],
    [/\bdhan(?:i)?ya\s+powder\b/g,'coriander_powder'],
    [/\b(?:aamchur|amchur)\s+powder\b/g,'amchur_powder'],
    [/\b(?:lal\s+)?mirch\s+powder\b/g,'chilli_powder'], [/\bgaram\s+masala\b/g,'garam_masala'],
    [/\b(?:mung|moong)\s+da+l\b/g,'moong_dal'], [/\bchana\s+da+l\b/g,'chana_dal'],
    [/\b(?:toor|arhar)\s+da+l\b/g,'toor_dal'], [/\burad\s+da+l\b/g,'urad_dal'],
    [/\bmasoor\s+da+l\b/g,'masoor_dal'],
    [/\bbottle\s+gourd\b/g,'bottle_gourd'], [/\bridge\s+gourd\b/g,'ridge_gourd'],
  ];
  function countHeads(text){
    let n=0; for (let t of String(text).toLowerCase().split(/\s+/)){
      t=t.replace(/[^a-z]/g,''); if(!t) continue;
      if (HEADSET.has(t) || HINDI[t]) n++;
    } return n;
  }
  function segmentBlob(part){
    let s=' '+String(part).toLowerCase().replace(/[•*]/g,' ').replace(/\s+/g,' ').trim()+' ';
    s = ' ' + normalizeQuant(s) + ' ';
    for (const [re,rep] of PHRASES) s=s.replace(re,' '+rep+' ');
    s=s.replace(/\s+/g,' ').trim();
    const toks=s.split(' ').map(t=> t.includes('_') ? t : (HINDI[t]||t));
    const isNum=t=>/^\d+(?:\.\d+)?$/.test(t), isUnit=t=>!!canonUnit(t);
    const items=[]; let cur=[];
    for (let t of toks){
      if (t==='and'||t==='&'||t==='+'||t==='aur'||t==='n'||t==='evam'||t==='tatha'||!t) continue;
      if (isNum(t)||isUnit(t)||/^x?\d/.test(t)){ cur.push(t); continue; }
      if (cur.some(x=>!isNum(x)&&!isUnit(x))){ items.push(cur.join(' ')); cur=[]; }
      cur.push(t);
    }
    if (cur.length) items.push(cur.join(' '));
    return items.map(x=>x.replace(/_/g,' ').trim()).filter(Boolean);
  }

  function levDL(a, b) { // Damerau-Levenshtein (transposition = 1)
    const m = a.length, n = b.length; const d = [];
    for (let i = 0; i <= m; i++) { d[i] = [i]; }
    for (let j = 0; j <= n; j++) { d[0][j] = j; }
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost);
      if (i>1 && j>1 && a[i-1]===b[j-2] && a[i-2]===b[j-1]) d[i][j] = Math.min(d[i][j], d[i-2][j-2]+1);
    }
    return d[m][n];
  }
  function fuzzyCorrect(tok) {
    if (tok.length < 4) return tok;
    const thr = tok.length <= 5 ? 1 : 2;
    let best = tok, bestD = thr + 1;
    for (const w of VOCAB) {
      if (Math.abs(w.length - tok.length) > thr) continue;
      const dd = levDL(tok, w);
      if (dd < bestD) { bestD = dd; best = w; }
    }
    return bestD <= thr ? best : tok;
  }
  const FILLER = new Set(['bhaiya','bhai','bhayya','please','pls','plz','kindly','sir','madam','ji','hello','hey','namaste','lao','laana','lana','lena','chahiye','mujhe','bring','plzz']);
  function normalizeName(name) {
    const notes = [], out = [];
    for (const tok of String(name).toLowerCase().split(/\s+/).filter(Boolean)) {
      if (/^\d/.test(tok)) { out.push(tok); continue; }
      if (FILLER.has(tok)) continue;  // drop greeting/filler words (bhaiya, please...)
      if (HINDI[tok]) { if (HINDI[tok] !== tok) notes.push(tok + '→' + HINDI[tok]); out.push(HINDI[tok]); continue; }
      if (VOCAB.has(tok) || BRANDS.has(tok)) { out.push(tok); continue; }
      const fix = fuzzyCorrect(tok);
      if (fix !== tok) { notes.push(tok + '→' + fix); out.push(fix); } else out.push(tok);
    }
    return { name: out.join(' ').trim() || String(name).trim(), notes };
  }
  function fmtQty(q, u) { return (Number.isInteger(q) ? q : q) + (u === 'pc' ? ' pc' : ' ' + u); }
  function defaultServing(name) {
    const toks = String(name).toLowerCase().split(/\s+/);
    const has = k => toks.includes(k);
    if (has('powder') || has('masala')) return { qty: 200, unit: 'g', bulk: true };
    for (const [keys, qu] of STAPLE) if (keys.some(k => toks.includes(k))) return { qty: qu[0], unit: qu[1], bulk: true };
    for (const [keys, qu] of DEFAULTS) if (keys.some(k => toks.includes(k))) return { qty: qu[0], unit: qu[1] };
    return { qty: 1, unit: 'pc' };
  }
  function finalizeItem(item) {
    if (!item) return null;
    const norm = normalizeName(item.name);
    item.original = item.name; item.name = norm.name; item.notes = norm.notes;
    if (item.qty == null || !item.unit) {
      const d = defaultServing(item.name);
      const mult = item.mult && item.mult > 1 ? item.mult : 1;
      item.qty = d.qty * mult; item.unit = d.unit; item.assumed = true;
      item.notes = item.notes.concat([(d.bulk ? 'stocked up ' : 'assumed ') + fmtQty(item.qty, item.unit) + (d.bulk ? ' (non-perishable)' : ' (for 2 people)')]);
    }
    return item;
  }

  // ---- List parsing ---------------------------------------------------------
  // Accepts free text / bullets. One item per line. Handles:
  //  "potato 1 kg", "5 kg tomato", "milk 1L x2", "- 2 dozen eggs", "bread"
  const QTY_UNIT_RE = new RegExp(
    '(\\d+(?:\\.\\d+)?)\\s*' +
    '(' + Object.keys(UNIT_LOOKUP).sort((a, b) => b.length - a.length).join('|') + ')\\b',
    'i'
  );
  const MULT_RE = /(?:x|×|\*)\s*(\d+)\b|\b(\d+)\s*(?:x|×|\*)\b/i; // x2 / 2x

  function parseLine(raw) {
    let line = String(raw || '')
      .replace(/^\s*[-*•·●▪•]\s*/, '')   // strip bullet
      .replace(/^\s*\d+[\.)]\s+/, '')          // strip "1. " "2) " list numbering (require space so "1.5kg" survives)
      .trim();
    if (!line) return null;
    line = normalizeQuant(line);

    let multiplier = 1;
    const mm = line.match(MULT_RE);
    if (mm) {
      multiplier = parseInt(mm[1] || mm[2], 10) || 1;
      line = line.replace(MULT_RE, ' ').trim();
    }

    let qty = null, unit = null;
    const um = line.match(QTY_UNIT_RE);
    if (um) {
      qty = parseFloat(um[1]);
      unit = canonUnit(um[2]);
      line = (line.slice(0, um.index) + ' ' + line.slice(um.index + um[0].length)).trim();
    }

    // leftover bare number with no unit -> treat as count qty (e.g. "6 eggs")
    if (qty == null) {
      const bare = line.match(/\b(\d+(?:\.\d+)?)\b/);
      if (bare) { qty = parseFloat(bare[1]); unit = 'pc'; line = line.replace(bare[0], ' ').trim(); }
    }

    const name = line.replace(/\s{2,}/g, ' ').replace(/[,;]+$/, '').trim();
    if (!name) return null;

    qty = (qty == null) ? null : qty * multiplier;
    return { name, qty, unit, raw: String(raw).trim(), mult: (qty == null && multiplier > 1) ? multiplier : 1 };
  }

  // Split on newlines, commas (not inside parens), and conjunctions
  // (English "and" / Hindi "aur","evam","tatha","और" / shorthand "n","&","+").
  const SPLIT_RE = /\r?\n|,(?![^()]*\))|\s+(?:and|aur|evam|tatha|और)\s+|\s*&\s*|\s+\+\s+|\s+n\s+/i;
  function parseList(text) {
    let parts = String(text || '').split(SPLIT_RE).map(s => s.trim()).filter(Boolean);
    // Expand any run-on chunk (3+ grocery heads, e.g. "aloo tamatar pyaz") into items.
    // The 3+ threshold + PHRASES collapse keep real compounds ("potato chips",
    // "ginger garlic paste", "tomato ketchup") intact.
    const expanded = [];
    for (const p of parts) {
      if (countHeads(p) >= 3) { for (const seg of segmentBlob(p)) expanded.push(seg); }
      else expanded.push(p);
    }
    parts = expanded;
    const items = parts.map(parseLine).map(finalizeItem).filter(Boolean);
    // merge duplicates (same name + unit) by summing quantity
    const merged = [];
    for (const it of items) {
      const m = merged.find(x => x.name === it.name && x.unit === it.unit);
      if (m) { m.qty += it.qty; if (!/listed/.test(m.notes.join())) m.notes.push('combined repeats'); }
      else merged.push(it);
    }
    return merged;
  }

  // ---- Product size parsing (from scraped product name / quantity field) ----
  // "Aloo (Potato) 1 kg" -> {dim:'weight', base:1000}; "500 g" -> 500
  function parseProductSize(prod) {
    const fields = [prod.packSize, prod.quantity, prod.unit, prod.weight, prod.name, prod.title]
      .filter(Boolean).join(' ');
    // handle "2 x 500 g" style
    const multi = fields.match(/(\d+)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|gram|grams|l|ltr|litre|liter|ml)\b/i);
    if (multi) {
      const b = toBase(parseFloat(multi[2]), multi[3]);
      if (b) return { dim: b.dim, base: b.base * parseInt(multi[1], 10) };
    }
    const m = fields.match(QTY_UNIT_RE);
    if (m) return toBase(parseFloat(m[1]), m[2]);
    return null; // unknown — treat as 1 piece
  }

  // ---- Fuzzy relevance ------------------------------------------------------
  const STOP = new Set(['the', 'a', 'of', 'fresh', 'pack', 'combo', 'local', 'and']);
  const SYNON = { aloo: 'potato', pyaaz: 'onion', tamatar: 'tomato', anda: 'egg',
                  doodh: 'milk', kela: 'banana', makhan: 'butter', dahi: 'curd' };
  function stem(t) {
    t = SYNON[t] || t;
    if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
    if (t.length > 3 && t.endsWith('es') && !/[aeiou]es$/.test(t)) return t.slice(0, -2);
    if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
    return t;
  }
  function tokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(Boolean).filter(t => !STOP.has(t)).map(stem);
  }
  function relevance(query, prod) {
    const q = new Set(tokens(query).filter(t => !/^\d+$/.test(t)));
    const p = new Set(tokens(prod.name || prod.title));
    if (!q.size || !p.size) return 0;
    let hit = 0;
    for (const t of q) if (p.has(t)) hit++;
    return hit / q.size; // fraction of query tokens present
  }

  // Typical edible weight per PIECE for produce sold by weight (grams). Prevents the
  // "4 pc tomato -> 4 x 1kg packs" inflation: convert pieces -> grams, then to packs.
  const PIECE_G = { onion:110, tomato:90, potato:130, garlic:6, ginger:20, chilli:6, chili:6,
    mirch:6, lemon:55, lime:45, capsicum:120, carrot:80, cucumber:150, beetroot:130, radish:120,
    brinjal:90, eggplant:90, lady:35, okra:12, bhindi:12, banana:120, apple:150, mango:200,
    cauliflower:600, cabbage:800, beans:6, coriander:40, mint:30, curry:5, spinach:300, palak:300 };
  function pieceGrams(name){
    var n=String(name||'').toLowerCase();
    for(var k in PIECE_G){ if(n.indexOf(k)>=0) return PIECE_G[k]; }
    return null; // not known produce -> caller keeps 1-piece=1-unit behavior
  }
  // ---- Match one requested item to best product on one platform -------------
  // candidates: normalized products [{name,price,mrp,rating,inStock,...}]
  function matchItem(item, candidates) {
    const need = toBase(item.qty, item.unit);
    const scored = candidates
      .filter(c => c.inStock !== false && c.price != null && c.price > 0)
      .map(c => {
        const rel = relevance(item.name, c);
        return { c, rel };
      })
      .filter(x => x.rel >= 0.5)               // must match at least half query tokens
      .sort((a, b) => b.rel - a.rel || a.c.price - b.c.price);

    if (!scored.length) return null;

    // Among the most relevant, choose the cheapest *per requested unit*.
    const topRel = scored[0].rel;
    const pool = scored.filter(x => x.rel >= topRel - 0.001);

    // Avoid premium/organic/imported unless the user explicitly asked for it.
    const PREMIUM = /\b(organic|organi[sc]ally|premium|exotic|imported|gourmet|artisan|cold[\s-]?pressed|specialty|handpicked)\b/i;
    const askedPremium = PREMIUM.test(item.name);
    let bestPlain = null, bestAny = null;
    for (const { c } of pool) {
      const size = parseProductSize(c);
      let packs = 1, effQty = 1;
      if (need && size && size.dim === need.dim && size.base > 0) {
        packs = Math.max(1, Math.ceil(need.base / size.base));
        effQty = packs * size.base;
      } else if (item.unit === 'pc' && size && size.dim === 'weight' && size.base > 0 && pieceGrams(item.name) != null) {
        // pieces of produce sold by weight -> convert via typical per-piece grams
        const grams = Math.max(1, item.qty) * pieceGrams(item.name);
        packs = Math.max(1, Math.ceil(grams / size.base));
        effQty = packs * size.base;
      } else if (item.unit === 'pc') {
        const per = (size && size.dim === 'count') ? size.base : 1; // a loaf/jar = 1 piece
        packs = Math.max(1, Math.ceil(item.qty / per));
        effQty = packs * per;
      }
      const lineCost = packs * c.price;
      const cand = {
        product: c, packs, lineCost,
        unitPrice: need && size && size.dim === need.dim ? c.price / size.base : c.price,
        effQty, sizeKnown: !!size,
      };
      const better = (a, b) => !b || a.lineCost < b.lineCost ||
        (a.lineCost === b.lineCost && (a.product.ratingCount || a.product.rating || 0) > (b.product.ratingCount || b.product.rating || 0));
      if (better(cand, bestAny)) bestAny = cand;
      if (!PREMIUM.test(c.name || '') && better(cand, bestPlain)) bestPlain = cand;
    }
    // Prefer the popular/standard (non-premium) pick unless premium was requested or it's the only option.
    return askedPremium ? bestAny : (bestPlain || bestAny);
  }

  // ---- Build a single-platform basket --------------------------------------
  function buildBasket(platformKey, platformMeta, items, productsByItem) {
    const lines = [];
    let goods = 0, ratingSum = 0, ratingN = 0, maxEta = 0, found = 0;
    for (const item of items) {
      const cands = (productsByItem[item.name] && productsByItem[item.name][platformKey]) || [];
      const m = matchItem(item, cands);
      if (m) {
        found++;
        goods += m.lineCost;
        if (m.product.rating) { ratingSum += m.product.rating; ratingN++; }
        const eta = m.product.etaMinutes || platformMeta.etaMinutes || 0;
        if (eta > maxEta) maxEta = eta;
        lines.push({ item, match: m, eta });
      } else {
        lines.push({ item, match: null, eta: 0 });
      }
    }
    const fees = estimateFees(platformMeta, goods);
    return {
      platform: platformKey,
      platformName: platformMeta.name,
      lines,
      itemsFound: found,
      itemsTotal: items.length,
      complete: found === items.length,
      goods: round2(goods),
      deliveryFee: fees.delivery,
      handlingFee: fees.handling,
      total: round2(goods + fees.delivery + fees.handling),
      avgRating: ratingN ? round2(ratingSum / ratingN) : null,
      maxEta,
    };
  }

  function estimateFees(meta, goods) {
    const free = meta.freeDeliveryAbove != null && goods >= meta.freeDeliveryAbove;
    return {
      delivery: goods === 0 ? 0 : (free ? 0 : (meta.deliveryFee || 0)),
      handling: goods === 0 ? 0 : (meta.handlingFee || 0),
    };
  }

  // ---- Optimizer ------------------------------------------------------------
  // Hierarchy: (1) cost  (2) availability  (3) rating  (4) delivery time.
  // Split into 2 orders only if net saving > splitThreshold (default Rs 50).
  function optimize(items, productsByItem, platforms, opts) {
    opts = opts || {};
    const splitThreshold = opts.splitThreshold != null ? opts.splitThreshold : 50;
    const coupons = normalizeCoupons(opts.coupons);

    const baskets = Object.keys(platforms).map(k => {
      const b = buildBasket(k, platforms[k], items, productsByItem);
      if (coupons[k]) applyCoupon(b, coupons[k]);
      return b;
    });

    // Single-platform plans
    const singlePlans = baskets.map(b => ({
      kind: 'single',
      label: b.platformName,
      orders: [b],
      itemsFound: b.itemsFound,
      itemsTotal: b.itemsTotal,
      complete: b.complete,
      total: b.total,
      avgRating: b.avgRating,
      maxEta: b.maxEta,
    }));

    // Best split plan: per item pick cheapest platform, then keep to <=2 platforms.
    const splitPlan = buildBestSplit(items, productsByItem, platforms, splitThreshold, singlePlans, coupons);

    let plans = singlePlans.slice();
    // Only ever recommend a 2-order split if it clears the savings rule.
    if (splitPlan && splitPlan.beatsThreshold && !splitPlan.suppressed) plans.push(splitPlan);

    plans.sort(planComparator);
    plans = plans.filter(p => p.itemsFound > 0);

    return { baskets, plans, top3: plans.slice(0, 3), splitConsidered: splitPlan || null };
  }

  // Rank: completeness first (all-items plans win), then cost, rating, eta.
  function planComparator(a, b) {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;        // availability gate
    if (!a.complete && a.itemsFound !== b.itemsFound) return b.itemsFound - a.itemsFound;
    if (a.total !== b.total) return a.total - b.total;                // cost
    const ar = a.avgRating || 0, br = b.avgRating || 0;
    if (ar !== br) return br - ar;                                    // rating
    return (a.maxEta || 0) - (b.maxEta || 0);                         // delivery time
  }

  function buildBestSplit(items, productsByItem, platforms, splitThreshold, singlePlans, coupons) {
    coupons = coupons || {};
    // cheapest source per item
    const perItem = items.map(item => {
      let best = null;
      for (const k in platforms) {
        const cands = (productsByItem[item.name] && productsByItem[item.name][k]) || [];
        const m = matchItem(item, cands);
        if (m && (!best || m.lineCost < best.m.lineCost)) best = { platform: k, m };
      }
      return { item, best };
    });
    if (perItem.some(x => !x.best)) {
      // can't fully cover via split either — fall back to top-2 platforms by coverage
    }
    // group items by chosen platform
    const groups = {};
    for (const x of perItem) {
      if (!x.best) continue;
      (groups[x.best.platform] = groups[x.best.platform] || []).push(x);
    }
    const platKeys = Object.keys(groups);
    if (platKeys.length < 2) return null; // not actually a split

    // keep only the 2 platforms that carry the most value, reassign rest to cheaper of the two
    const valueByPlat = platKeys.map(k => ({
      k, val: groups[k].reduce((s, x) => s + x.best.m.lineCost, 0), n: groups[k].length,
    })).sort((a, b) => b.val - a.val);
    const keep = valueByPlat.slice(0, 2).map(v => v.k);

    const assign = {}; keep.forEach(k => assign[k] = []);
    for (const x of perItem) {
      if (!x.best) continue;
      let entry = x;
      let target = keep.includes(x.best.platform) ? x.best.platform : null;
      if (!target) {
        // reassign to whichever kept platform is cheaper for this item
        let bb = null;
        for (const k of keep) {
          const cands = (productsByItem[x.item.name] && productsByItem[x.item.name][k]) || [];
          const m = matchItem(x.item, cands);
          if (m && (!bb || m.lineCost < bb.m.lineCost)) bb = { platform: k, m };
        }
        if (!bb) return null; // item not available on either kept platform -> abort split
        target = bb.platform; entry = { item: x.item, best: bb };
      }
      assign[target].push(entry);
    }

    const orders = keep.map(k => {
      const its = assign[k].map(x => x.item);
      return buildBasket(k, platforms[k], its, productsByItem);
    }).filter(o => o.itemsFound > 0);
    orders.forEach(o => { if (coupons[o.platform]) applyCoupon(o, coupons[o.platform]); });

    const itemsFound = orders.reduce((s, o) => s + o.itemsFound, 0);
    const total = round2(orders.reduce((s, o) => s + o.total, 0));
    const ratings = orders.map(o => o.avgRating).filter(r => r != null);
    const plan = {
      kind: 'split',
      label: orders.map(o => o.platformName).join(' + '),
      orders,
      itemsFound,
      itemsTotal: items.length,
      complete: itemsFound === items.length,
      total,
      avgRating: ratings.length ? round2(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null,
      maxEta: Math.max(...orders.map(o => o.maxEta), 0),
    };

    // Apply split rule: only worth it if it beats best COMPLETE single by > threshold.
    const bestSingle = singlePlans
      .filter(p => p.complete)
      .sort((a, b) => a.total - b.total)[0];
    if (bestSingle) {
      plan.savingVsBestSingle = round2(bestSingle.total - plan.total);
      plan.savingVsBestSingle = round2(bestSingle.total - plan.total);
      plan.beatsThreshold = plan.complete && plan.savingVsBestSingle > splitThreshold;
      if (!plan.beatsThreshold) plan.suppressed = true; // kept but UI hides suppressed
    } else {
      // no complete single exists; a split that covers more is inherently valuable
      plan.beatsThreshold = true;
    }
    return plan;
  }

  // ---- Coupons / promo codes ------------------------------------------------
  // A coupon reduces a single store's goods subtotal (never below 0). Fees are
  // unchanged (platforms evaluate free-delivery on the pre-coupon cart value).
  // When passed via optimize(opts.coupons) the discounted total drives ranking,
  // so the cheapest *effective* basket wins.
  function parseCoupon(input) {
    if (input == null) return null;
    if (typeof input === 'object') return normalizeCoupon(input);
    var s = String(input).trim();
    if (!s) return null;
    var code = s.toUpperCase().replace(/\s+/g, ' ').slice(0, 40);
    var lower = s.toLowerCase();
    var cap = Infinity;
    var capM = lower.match(/(?:max|up\s?to|cap(?:ped)?(?:\s*at)?)\s*₹?\s*(\d+(?:\.\d+)?)/);
    if (capM) cap = parseFloat(capM[1]);
    var minOrder = 0;
    var minM = lower.match(/(?:above|over|min(?:imum)?)\s*₹?\s*(\d+(?:\.\d+)?)/);
    if (minM) minOrder = parseFloat(minM[1]);
    if (/%/.test(s)) {
      var pM = s.match(/(\d+(?:\.\d+)?)\s*%/);
      if (!pM) return null;
      var pv = parseFloat(pM[1]);
      if (!(pv > 0)) return null;
      return { code: code, type: 'percent', value: pv, minOrder: minOrder, cap: cap };
    }
    var offM = lower.match(/off\s*₹?\s*(\d+(?:\.\d+)?)/);
    var nums = (lower.match(/\d+(?:\.\d+)?/g) || []).map(parseFloat);
    if (!nums.length) return null;
    var value = nums[0];
    if (!(value > 0)) return null;
    if (!minM) {
      if (offM) minOrder = parseFloat(offM[1]);
      else if (nums.length >= 2) minOrder = nums[1];
    }
    return { code: code, type: 'flat', value: value, minOrder: minOrder, cap: cap };
  }

  function normalizeCoupon(c) {
    if (!c) return null;
    if (typeof c === 'string') return parseCoupon(c);
    var type = c.type === 'percent' ? 'percent' : 'flat';
    var value = Number(c.value) || 0;
    if (!(value > 0)) return null;
    var cap = (c.cap != null && isFinite(c.cap)) ? Number(c.cap) : Infinity;
    return { code: c.code || null, type: type, value: value, minOrder: Number(c.minOrder) || 0, cap: cap };
  }

  function normalizeCoupons(map) {
    var out = {};
    if (!map || typeof map !== 'object') return out;
    for (var k in map) {
      var c = normalizeCoupon(map[k]);
      if (c) out[k] = c;
    }
    return out;
  }

  function computeCouponDiscount(goods, coupon) {
    var c = normalizeCoupon(coupon);
    if (!c || !(goods > 0)) return 0;
    if (goods < (c.minOrder || 0)) return 0;
    var d = c.type === 'percent' ? goods * (c.value || 0) / 100 : (c.value || 0);
    if (c.type === 'percent' && isFinite(c.cap)) d = Math.min(d, c.cap);
    d = Math.min(d, goods);
    return round2(Math.max(0, d));
  }

  function applyCoupon(order, coupon) {
    if (!order) return order;
    var c = normalizeCoupon(coupon);
    var disc = c ? computeCouponDiscount(order.goods, c) : 0;
    order.couponCode = c ? c.code : null;
    order.couponDiscount = disc;
    order.couponApplied = disc > 0;
    if (disc > 0) {
      order.total = round2(Math.max(0, order.goods - disc + order.deliveryFee + order.handlingFee));
    }
    return order;
  }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  // ---- Shareable basket (text + list-prefill link) -------------------------
  // Pure helpers: turn an optimized plan into a WhatsApp-friendly summary, and
  // round-trip a raw grocery list through a URL hash so a recipient opens the
  // app pre-filled. No DOM / no network — safe in Node and the browser.
  function _shareLineLabel(line) {
    var asked = (line && line.item && (line.item.raw || line.item.name)) || 'item';
    asked = String(asked).trim();
    if (!line || !line.match) return '• ' + asked + ' — not available';
    var m = line.match, p = m.product || {};
    var nm = String(p.name || asked).trim();
    var packs = m.packs > 1 ? (' ×' + m.packs) : '';
    var cost = isFinite(m.lineCost) ? (' ₹' + Math.round(m.lineCost)) : '';
    return '• ' + asked + ' — ' + nm + packs + cost;
  }
  function formatBasketText(plan, opts) {
    opts = opts || {};
    if (!plan || !plan.orders || !plan.orders.length) return '';
    var app = opts.appName || 'KhanaPro';
    var rupee = function (n) { return '₹' + Math.round(n || 0).toLocaleString('en-IN'); };
    var lines = [];
    lines.push('🛒 ' + app + ' basket — ' + (plan.label || 'best pick'));
    lines.push(rupee(plan.total) + ' total' +
      (plan.complete ? '' : ' (' + plan.itemsFound + '/' + plan.itemsTotal + ' items found)'));
    if (isFinite(plan.savingVsBestSingle) && plan.savingVsBestSingle > 0)
      lines.push('saves ' + rupee(plan.savingVsBestSingle) + ' vs single store');
    if (opts.includeItems !== false) {
      var cap = opts.maxItems || 40;
      plan.orders.forEach(function (o) {
        if (plan.orders.length > 1) lines.push('— ' + (o.platformName || o.platform) + ' (' + rupee(o.total) + ') —');
        (o.lines || []).slice(0, cap).forEach(function (ln) { lines.push(_shareLineLabel(ln)); });
        var cpn = o.couponDiscount || 0;
        if (cpn > 0) lines.push('🎟 coupon −' + rupee(cpn) + (o.couponCode ? (' (' + o.couponCode + ')') : ''));
      });
    }
    if (opts.link) lines.push('🔗 ' + opts.link);
    return lines.join('\n');
  }
  function buildShareUrl(baseUrl, listText) {
    var base = String(baseUrl || '').split('#')[0];
    var enc = encodeURIComponent(String(listText == null ? '' : listText));
    return base + '#list=' + enc;
  }
  function parseShareHash(hashOrUrl) {
    var s = String(hashOrUrl == null ? '' : hashOrUrl);
    var h = s.indexOf('#') >= 0 ? s.slice(s.indexOf('#') + 1) : s;
    if (!h) return null;
    var parts = h.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv[0] === 'list' && kv.length > 1) {
        try { var v = decodeURIComponent(kv.slice(1).join('=')); return v || null; }
        catch (e) { return null; }
      }
    }
    return null;
  }

  const api = {
    parseList, parseLine, toBase, canonUnit, parseProductSize, relevance,
    matchItem, buildBasket, optimize, planComparator, round2,
    normalizeName, defaultServing, finalizeItem, fuzzyCorrect, segmentBlob, countHeads,
    parseCoupon, normalizeCoupon, normalizeCoupons, computeCouponDiscount, applyCoupon,
    formatBasketText, buildShareUrl, parseShareHash,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CartPilotEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
