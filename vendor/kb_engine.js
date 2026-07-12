/*
 * KhanaPro KB Engine — kb_engine.js
 * UMD: exposes window.KhanaProKB (browser) and module.exports (Node) — identical API.
 *
 * Conforms to kb/KB_SPEC.md "Engine API — kb_engine.js exposes window.KhanaProKB".
 *
 * Data sources:
 *   - Browser: reads window.KhanaProKBParts (each data file pushes its DATA array).
 *   - Node:    require()s ./kb/data/kb_part_1.js .. kb_part_6.js with try/catch; ignores missing.
 *
 * Lazy: a flattened, id-deduped recipe list + indexes are built on first use and cached.
 * Pure / no-throw: every method guards against missing data and returns []/null/0 sensibly.
 */
;(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.KhanaProKB = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this), function (root) {
  "use strict";

  // ---- internal cache -------------------------------------------------------
  var _cache = null; // { list, byId, cuisines, categories, tags, channels }

  // ---- health classifier (optional dependency; guard if missing) -----------
  // Resolve KhanaProHealth from: browser global, then Node require(). If it is
  // unavailable for any reason, every health feature degrades gracefully:
  // annotations are left undefined and the new methods return []/[] rather than
  // throwing — preserving the engine's no-throw contract.
  function getHealth() {
    // 1) Browser / global
    try {
      var g = root || (typeof globalThis !== "undefined" ? globalThis : null);
      if (g && g.KhanaProHealth && typeof g.KhanaProHealth.classify === "function") {
        return g.KhanaProHealth;
      }
    } catch (e) { /* ignore */ }
    try {
      var gt = (typeof globalThis !== "undefined") ? globalThis : null;
      if (gt && gt.KhanaProHealth && typeof gt.KhanaProHealth.classify === "function") {
        return gt.KhanaProHealth;
      }
    } catch (e2) { /* ignore */ }
    // 2) Node: require ./health_classifier.js (ignore if absent)
    try {
      if (typeof module !== "undefined" && module.exports && typeof require === "function") {
        var H = require("./health_classifier.js");
        if (H && typeof H.classify === "function") return H;
      }
    } catch (e3) { /* ignore */ }
    return null;
  }

  // ---- helpers --------------------------------------------------------------
  function isArray(x) { return Object.prototype.toString.call(x) === "[object Array]"; }
  function isObj(x) { return x && typeof x === "object" && !isArray(x); }
  function str(x) { return (x == null) ? "" : String(x); }
  function lc(x) { return str(x).toLowerCase(); }
  function num(x) {
    var n = Number(x);
    return isFinite(n) ? n : NaN;
  }

  // tokenise a query into lowercase word tokens
  function tokens(q) {
    return lc(q).split(/[^a-z0-9]+/i).filter(function (t) { return t.length > 0; });
  }

  // Gather raw part arrays from every available source.
  function gatherParts() {
    var parts = [];

    // 1) Browser / global: window.KhanaProKBParts (array of DATA arrays)
    try {
      var g = root || (typeof globalThis !== "undefined" ? globalThis : null);
      if (g && isArray(g.KhanaProKBParts)) {
        for (var i = 0; i < g.KhanaProKBParts.length; i++) {
          if (isArray(g.KhanaProKBParts[i])) parts.push(g.KhanaProKBParts[i]);
        }
      }
    } catch (e) { /* ignore */ }

    // Also check globalThis directly (in case root differs from where data pushed)
    try {
      var gt = (typeof globalThis !== "undefined") ? globalThis : null;
      if (gt && gt !== root && isArray(gt.KhanaProKBParts)) {
        for (var j = 0; j < gt.KhanaProKBParts.length; j++) {
          if (isArray(gt.KhanaProKBParts[j]) && parts.indexOf(gt.KhanaProKBParts[j]) === -1) {
            parts.push(gt.KhanaProKBParts[j]);
          }
        }
      }
    } catch (e2) { /* ignore */ }

    // 2) Node: require fixed list of data files; ignore missing.
    var isNode = (typeof module !== "undefined" && module.exports && typeof require === "function");
    if (isNode) {
      // Dynamically discover every kb/data/kb_part_*.js so new parts auto-load (no hardcoded count).
      try {
        var fs = require("fs"), path = require("path");
        var dir = path.join(__dirname, "kb", "data");
        var files = fs.readdirSync(dir).filter(function (f) { return /^kb_part_\d+\.js$/.test(f); })
          .sort(function (a, b) { return (parseInt(a.match(/\d+/)[0], 10)) - (parseInt(b.match(/\d+/)[0], 10)); });
        for (var fi = 0; fi < files.length; fi++) {
          try { var data = require(path.join(dir, files[fi])); if (isArray(data)) parts.push(data); } catch (e1) { /* ignore bad part */ }
        }
        // Optional ingested file (same wrapper/schema) — ignore if absent.
        try { var ing = require(path.join(dir, "kb_ingested.js")); if (isArray(ing)) parts.push(ing); } catch (eIng) { /* ignore */ }
      } catch (eDir) {
        // Fallback: fixed range if readdir unavailable.
        for (var p = 1; p <= 30; p++) {
          try { var d2 = require("./kb/data/kb_part_" + p + ".js"); if (isArray(d2)) parts.push(d2); } catch (e2) { /* ignore */ }
        }
      }
    }

    return parts;
  }

  // Normalise a recipe so methods never throw on missing keys.
  function normalise(r) {
    if (!isObj(r)) return null;
    var diet = isObj(r.diet) ? r.diet : {};
    var nutrition = isObj(r.nutrition) ? r.nutrition : {};
    return {
      id: str(r.id),
      title: str(r.title),
      cuisine: str(r.cuisine),
      category: str(r.category),
      tags: isArray(r.tags) ? r.tags.map(lc) : [],
      diet: {
        veg: !!diet.veg,
        vegan: !!diet.vegan,
        jain: !!diet.jain,
        glutenFree: !!diet.glutenFree,
        eggless: !!diet.eggless,
        noOnionGarlic: !!diet.noOnionGarlic
      },
      timeMins: isFinite(num(r.timeMins)) ? num(r.timeMins) : null,
      servings: isFinite(num(r.servings)) ? num(r.servings) : null,
      difficulty: str(r.difficulty),
      nutrition: {
        kcal: isFinite(num(nutrition.kcal)) ? num(nutrition.kcal) : null,
        protein: isFinite(num(nutrition.protein)) ? num(nutrition.protein) : null,
        fibre: isFinite(num(nutrition.fibre)) ? num(nutrition.fibre) : null,
        fat: isFinite(num(nutrition.fat)) ? num(nutrition.fat) : null,
        carbs: isFinite(num(nutrition.carbs)) ? num(nutrition.carbs) : null
      },
      summary: str(r.summary),
      channels: isArray(r.channels) ? r.channels.map(str) : [],
      videoQuery: str(r.videoQuery),
      ingredients: isArray(r.ingredients) ? r.ingredients.filter(function (x) { return isObj(x) || typeof x === "string"; }).map(function (ing) {
        if (typeof ing === "string") return { name: str(ing), qty: null, unit: "", staple: false };
        return {
          name: str(ing.name),
          qty: isFinite(num(ing.qty)) ? num(ing.qty) : null,
          unit: str(ing.unit),
          staple: !!ing.staple
        };
      }) : [],
      // enriched-KB fields (kb_enrich.js) — the brain's ground truth
      ing: isArray(r.ing) ? r.ing.map(lc) : [],
      cls: isArray(r.cls) ? r.cls.map(str) : [],
      slots: isArray(r.slots) && r.slots.length ? r.slots.map(str) : null,
      main: isArray(r.main) ? r.main.map(lc) : [],
      thin: r.thin ? 1 : 0,
      canon: r.canon ? str(r.canon) : null,
      steps: isArray(r.steps) ? r.steps.map(str) : [],
      thumb: r.thumb ? str(r.thumb) : null,
      url: r.url ? str(r.url) : null,
      videoId: r.videoId ? str(r.videoId) : null,
      source: r.source ? str(r.source) : null
    };
  }

  // Annotate a normalised recipe in place with health fields. No-op (leaves
  // fields undefined) when the classifier is unavailable. Never throws.
  function annotateHealth(rec, health) {
    if (!rec) return rec;
    if (!health) return rec; // classifier missing => leave fields undefined
    try {
      var c = health.classify(rec);
      if (c) {
        rec.healthTier = c.tier;
        rec.healthScore = c.score;
        rec.healthFlags = c.flags;
      }
    } catch (e) { /* leave health* undefined on error */ }
    try {
      if (typeof health.isHealthy === "function") {
        rec.isHealthy = !!health.isHealthy(rec);
      }
    } catch (e2) { /* leave isHealthy undefined */ }
    return rec;
  }

  // Build (or rebuild) the flattened list + indexes. Cached.
  function build() {
    if (_cache) return _cache;

    var list = [];
    var byId = {};
    var seen = {};

    var health = getHealth();

    var parts = gatherParts();
    for (var i = 0; i < parts.length; i++) {
      var arr = parts[i];
      if (!isArray(arr)) continue;
      for (var k = 0; k < arr.length; k++) {
        var rec = normalise(arr[k]);
        if (!rec || !rec.id) continue;          // need a stable id to dedupe
        if (seen[rec.id]) continue;             // dedupe by id (first wins)
        annotateHealth(rec, health);            // add healthTier/Score/Flags/isHealthy
        seen[rec.id] = true;
        list.push(rec);
        byId[rec.id] = rec;
      }
    }

    // distinct, sorted facets
    var cuiSet = {}, catSet = {}, tagFreq = {}, chFreq = {};
    for (var n = 0; n < list.length; n++) {
      var r = list[n];
      if (r.cuisine) cuiSet[r.cuisine] = true;
      if (r.category) catSet[r.category] = true;
      for (var t = 0; t < r.tags.length; t++) {
        if (r.tags[t]) tagFreq[r.tags[t]] = (tagFreq[r.tags[t]] || 0) + 1;
      }
      for (var c = 0; c < r.channels.length; c++) {
        if (r.channels[c]) chFreq[r.channels[c]] = (chFreq[r.channels[c]] || 0) + 1;
      }
    }

    var cuisines = Object.keys(cuiSet).sort();
    var categories = Object.keys(catSet).sort();
    // tags: by frequency desc, then alpha
    var tags = Object.keys(tagFreq).sort(function (a, b) {
      var d = tagFreq[b] - tagFreq[a];
      return d !== 0 ? d : (a < b ? -1 : (a > b ? 1 : 0));
    });
    // channels: [{name,count}] by count desc, then alpha
    var channels = Object.keys(chFreq).map(function (name) {
      return { name: name, count: chFreq[name] };
    }).sort(function (a, b) {
      var d = b.count - a.count;
      return d !== 0 ? d : (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
    });

    _cache = {
      list: list,
      byId: byId,
      cuisines: cuisines,
      categories: categories,
      tags: tags,
      channels: channels
    };
    return _cache;
  }

  // ---- search / ranking -----------------------------------------------------
  // rank by title > tags > ingredients > summary; tokenized, case-insensitive
  var W_TITLE = 100, W_TAG = 40, W_INGREDIENT = 20, W_SUMMARY = 8, W_CUISINE = 12, W_CATEGORY = 12;

  function scoreRecipe(r, qTokens) {
    if (!qTokens.length) return 0;
    var title = lc(r.title);
    var summary = lc(r.summary);
    var cuisine = lc(r.cuisine);
    var category = lc(r.category);
    var tagStr = r.tags.join(" "); // already lowercase
    var ingStr = r.ingredients.map(function (x) { return lc(x.name); }).join(" ");

    var score = 0;
    var matchedAny = false;

    for (var i = 0; i < qTokens.length; i++) {
      var tok = qTokens[i];
      var hit = false;
      if (title.indexOf(tok) !== -1) { score += W_TITLE; hit = true; }
      if (tagStr.indexOf(tok) !== -1) { score += W_TAG; hit = true; }
      if (ingStr.indexOf(tok) !== -1) { score += W_INGREDIENT; hit = true; }
      if (summary.indexOf(tok) !== -1) { score += W_SUMMARY; hit = true; }
      if (cuisine.indexOf(tok) !== -1) { score += W_CUISINE; hit = true; }
      if (category.indexOf(tok) !== -1) { score += W_CATEGORY; hit = true; }
      if (hit) matchedAny = true;
    }

    // bonus: exact full-title match
    if (title === lc(qTokens.join(" "))) score += 50;

    return matchedAny ? score : 0;
  }

  function doSearch(q) {
    var st = build();
    var qTokens = tokens(q);
    if (!qTokens.length) return [];
    var scored = [];
    for (var i = 0; i < st.list.length; i++) {
      var s = scoreRecipe(st.list[i], qTokens);
      if (s > 0) scored.push({ r: st.list[i], s: s, i: i });
    }
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      return a.i - b.i; // stable-ish: original order
    });
    return scored.map(function (x) { return x.r; });
  }

  // ---- sorting --------------------------------------------------------------
  function applySort(arr, sort, relevanceOrder) {
    var out = arr.slice();
    if (sort === "protein") {
      out.sort(function (a, b) {
        return (b.nutrition.protein || 0) - (a.nutrition.protein || 0);
      });
    } else if (sort === "kcalAsc") {
      out.sort(function (a, b) {
        var av = (a.nutrition.kcal == null) ? Infinity : a.nutrition.kcal;
        var bv = (b.nutrition.kcal == null) ? Infinity : b.nutrition.kcal;
        return av - bv;
      });
    } else if (sort === "timeAsc") {
      out.sort(function (a, b) {
        var av = (a.timeMins == null) ? Infinity : a.timeMins;
        var bv = (b.timeMins == null) ? Infinity : b.timeMins;
        return av - bv;
      });
    } else {
      // "relevance" (default): preserve relevanceOrder if provided, else keep input order
      if (relevanceOrder) {
        out.sort(function (a, b) {
          var ai = relevanceOrder[a.id], bi = relevanceOrder[b.id];
          ai = (ai == null) ? Infinity : ai;
          bi = (bi == null) ? Infinity : bi;
          return ai - bi;
        });
      }
    }
    return out;
  }

  // ---- filter ---------------------------------------------------------------
  function doFilter(opts) {
    var st = build();
    opts = isObj(opts) ? opts : {};

    var base, relevanceOrder = null;

    if (opts.q != null && str(opts.q).trim() !== "") {
      base = doSearch(opts.q);
      relevanceOrder = {};
      for (var ri = 0; ri < base.length; ri++) relevanceOrder[base[ri].id] = ri;
    } else {
      base = st.list.slice();
    }

    var cuisine = opts.cuisine != null ? lc(opts.cuisine) : null;
    var category = opts.category != null ? lc(opts.category) : null;
    var tag = opts.tag != null ? lc(opts.tag) : null;
    var maxTime = isFinite(num(opts.maxTime)) ? num(opts.maxTime) : null;
    var maxKcal = isFinite(num(opts.maxKcal)) ? num(opts.maxKcal) : null;
    var minProtein = isFinite(num(opts.minProtein)) ? num(opts.minProtein) : null;

    // health-aware filters
    var onlyHealthy = (opts.healthy === true);
    var healthTier = opts.healthTier != null ? str(opts.healthTier) : null;
    var minScore = isFinite(num(opts.minScore)) ? num(opts.minScore) : null;

    var dietKeys = ["veg", "vegan", "jain", "glutenFree", "eggless", "noOnionGarlic"];

    var filtered = base.filter(function (r) {
      if (cuisine && lc(r.cuisine) !== cuisine) return false;
      if (category && lc(r.category) !== category) return false;
      if (tag && r.tags.indexOf(tag) === -1) return false;

      if (onlyHealthy && r.isHealthy !== true) return false;
      if (healthTier && r.healthTier !== healthTier) return false;
      if (minScore != null) {
        if (typeof r.healthScore !== "number" || r.healthScore < minScore) return false;
      }

      for (var d = 0; d < dietKeys.length; d++) {
        var key = dietKeys[d];
        if (opts[key] === true && r.diet[key] !== true) return false;
      }

      if (maxTime != null) {
        if (r.timeMins == null || r.timeMins > maxTime) return false;
      }
      if (maxKcal != null) {
        if (r.nutrition.kcal == null || r.nutrition.kcal > maxKcal) return false;
      }
      if (minProtein != null) {
        if (r.nutrition.protein == null || r.nutrition.protein < minProtein) return false;
      }
      return true;
    });

    var sort = opts.sort || "relevance";
    return applySort(filtered, sort, relevanceOrder);
  }

  // ---- resolve a recipe-or-id ----------------------------------------------
  function resolve(recipeOrId) {
    if (recipeOrId == null) return null;
    if (typeof recipeOrId === "string") return byId(recipeOrId);
    if (isObj(recipeOrId)) {
      if (recipeOrId.id) {
        var found = byId(str(recipeOrId.id));
        if (found) return found;
      }
      // accept an inline recipe-like object
      return normalise(recipeOrId);
    }
    return null;
  }

  // ---- public methods -------------------------------------------------------
  function ready() {
    try { return build().list.length > 0; } catch (e) { return false; }
  }

  function all() {
    try { return build().list.slice(); } catch (e) { return []; }
  }

  function byId(id) {
    try {
      var st = build();
      var r = st.byId[str(id)];
      return r || null;
    } catch (e) { return null; }
  }

  function count() {
    try { return build().list.length; } catch (e) { return 0; }
  }

  function cuisines() {
    try { return build().cuisines.slice(); } catch (e) { return []; }
  }

  function categories() {
    try { return build().categories.slice(); } catch (e) { return []; }
  }

  function tags() {
    try { return build().tags.slice(); } catch (e) { return []; }
  }

  function channels() {
    try {
      return build().channels.map(function (c) { return { name: c.name, count: c.count }; });
    } catch (e) { return []; }
  }

  // ---- health-aware methods ------------------------------------------------
  // Distinct healthTiers present, with counts: [{tier,count}] by count desc.
  function tiers() {
    try {
      var st = build();
      var freq = {};
      for (var i = 0; i < st.list.length; i++) {
        var t = st.list[i].healthTier;
        if (t == null || t === "") continue;
        freq[t] = (freq[t] || 0) + 1;
      }
      return Object.keys(freq).map(function (tier) {
        return { tier: tier, count: freq[tier] };
      }).sort(function (a, b) {
        var d = b.count - a.count;
        return d !== 0 ? d : (a.tier < b.tier ? -1 : (a.tier > b.tier ? 1 : 0));
      });
    } catch (e) { return []; }
  }

  // Recipes with a given healthTier.
  function byTier(tier) {
    try {
      var st = build();
      var want = str(tier);
      if (!want) return [];
      return st.list.filter(function (r) { return r.healthTier === want; });
    } catch (e) { return []; }
  }

  // Up to n isHealthy recipes, excluding indulgent/sweet-treat/drink tiers,
  // VARIED across cuisine/category. Optional opts.veg (diet.veg) and
  // opts.protein (prefer protein-rich / higher protein). Deterministic-ish but
  // varied. Never throws; returns [] if none.
  function healthyPicks(n, opts) {
    try {
      var st = build();
      opts = isObj(opts) ? opts : {};
      var want = isFinite(num(n)) && num(n) > 0 ? Math.floor(num(n)) : 8;

      var EXCLUDE = { "indulgent": true, "sweet-treat": true, "drink": true };

      var pool = st.list.filter(function (r) {
        if (r.isHealthy !== true) return false;
        if (r.healthTier && EXCLUDE[r.healthTier]) return false;
        if (opts.veg === true && !(r.diet && r.diet.veg === true)) return false;
        return true;
      });
      if (!pool.length) return [];

      // Order the pool: when protein requested, protein-rich tier and higher
      // protein/score first; otherwise by healthScore desc. Ties broken by id
      // for determinism.
      pool.sort(function (a, b) {
        if (opts.protein === true) {
          var ar = (a.healthTier === "protein-rich") ? 1 : 0;
          var br = (b.healthTier === "protein-rich") ? 1 : 0;
          if (ar !== br) return br - ar;
          var ap = (a.nutrition && typeof a.nutrition.protein === "number") ? a.nutrition.protein : -1;
          var bp = (b.nutrition && typeof b.nutrition.protein === "number") ? b.nutrition.protein : -1;
          if (ap !== bp) return bp - ap;
        }
        var as = (typeof a.healthScore === "number") ? a.healthScore : -1;
        var bs = (typeof b.healthScore === "number") ? b.healthScore : -1;
        if (as !== bs) return bs - as;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });

      // Greedy round-robin for variety: pass through the ordered pool repeatedly,
      // each pass picking at most one recipe per (cuisine|category) bucket not yet
      // used in that pass. This spreads picks across cuisines/categories while
      // honouring the score/protein ordering.
      var picked = [];
      var pickedIds = {};
      var guard = 0;
      while (picked.length < want && guard < 50) {
        guard++;
        var seenBucket = {};
        var progressed = false;
        for (var i = 0; i < pool.length && picked.length < want; i++) {
          var r = pool[i];
          if (pickedIds[r.id]) continue;
          var bucket = lc(r.cuisine) + "|" + lc(r.category);
          if (seenBucket[bucket]) continue;
          seenBucket[bucket] = true;
          pickedIds[r.id] = true;
          picked.push(r);
          progressed = true;
        }
        if (!progressed) break; // nothing left to add
      }

      return picked.slice(0, want);
    } catch (e) { return []; }
  }

  function search(q) {
    try { return doSearch(q); } catch (e) { return []; }
  }

  function filter(opts) {
    try { return doFilter(opts); } catch (e) { return []; }
  }

  function toCartItems(recipeOrId) {
    try {
      var r = resolve(recipeOrId);
      if (!r || !isArray(r.ingredients)) return [];
      // keep all ingredients (spec: "keep all"); map to {name,qty,unit}
      return r.ingredients
        .filter(function (ing) { return ing && ing.name; })
        .map(function (ing) {
          return { name: ing.name, qty: ing.qty, unit: ing.unit };
        });
    } catch (e) { return []; }
  }

  function backlink(recipe) {
    try {
      var r = resolve(recipe);
      var q = "";
      if (r && r.videoQuery) q = r.videoQuery;
      else if (r && r.title) q = r.title;
      else if (typeof recipe === "string") q = recipe;
      if (!q) return null;
      return "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
    } catch (e) { return null; }
  }

  // Allow callers/tests to force a rebuild after data loads late.
  function _reset() { _cache = null; }

  return {
    ready: ready,
    all: all,
    byId: byId,
    count: count,
    cuisines: cuisines,
    categories: categories,
    tags: tags,
    channels: channels,
    tiers: tiers,
    byTier: byTier,
    healthyPicks: healthyPicks,
    search: search,
    filter: filter,
    toCartItems: toCartItems,
    backlink: backlink,
    _reset: _reset
  };
});
