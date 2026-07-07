/*
 * KhanaPro "Smart Brain" — kb_brain.js
 * UMD: exposes window.KhanaProBrain (browser) and module.exports (Node) — identical API.
 *
 * A natural-language router for healthy-recipe asks that are NOT simple dish lookups.
 * Turns free text into a KB query + a friendly answer.
 *
 * Depends ONLY on:
 *   - window.KhanaProKB (engine)         REQUIRED for real results (guarded if absent)
 *   - window.CookBhaiya (planner)        OPTIONAL — used by handle() for "plan" intent
 *   - window.CartPilotAI                 OPTIONAL — exposes canUseLLM() hook only
 *
 * Conforms to kb/KB_SPEC.md engine + planner contracts. Pure / no-throw: every method
 * guards against a missing engine and always returns a usable object (never throws).
 *
 * KhanaProBrain.route(text)  -> { kind, ... }   kind ∈ "plan"|"filter"|"similar"|"reverse"|"answer"|"themed"|"dayplan"|"none"
 * KhanaProBrain.handle(text) -> { reply, recipes?, meals?, kind, plan?, action?, theme?, notes? }
 * KhanaProBrain.canUseLLM()  -> boolean
 */
;(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.KhanaProBrain = api;
  }
  if (typeof window !== "undefined") {
    window.KhanaProBrain = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this), function (root) {
  "use strict";

  // ---- engine / planner resolution (lazy, guarded) --------------------------
  // Resolve at call-time (not load-time) so the host can load modules in any order.
  function getEngine() {
    try {
      var g = root || (typeof globalThis !== "undefined" ? globalThis : null);
      if (g && g.KhanaProKB) return g.KhanaProKB;
      if (typeof globalThis !== "undefined" && globalThis.KhanaProKB) return globalThis.KhanaProKB;
    } catch (e) { /* ignore */ }
    // Node fallback: require the engine if available.
    try {
      if (typeof module !== "undefined" && module.exports && typeof require === "function") {
        // eslint-disable-next-line global-require
        return require("./kb_engine.js");
      }
    } catch (e2) { /* ignore */ }
    return null;
  }

  function getPlanner() {
    try {
      var g = root || (typeof globalThis !== "undefined" ? globalThis : null);
      if (g && g.CookBhaiya) return g.CookBhaiya;
      if (typeof globalThis !== "undefined" && globalThis.CookBhaiya) return globalThis.CookBhaiya;
    } catch (e) { /* ignore */ }
    try {
      if (typeof module !== "undefined" && module.exports && typeof require === "function") {
        // eslint-disable-next-line global-require
        return require("./cook_bhaiya.js");
      }
    } catch (e2) { /* ignore */ }
    return null;
  }

  function getLLM() {
    try {
      var g = root || (typeof globalThis !== "undefined" ? globalThis : null);
      if (g && g.CartPilotAI) return g.CartPilotAI;
      if (typeof globalThis !== "undefined" && globalThis.CartPilotAI) return globalThis.CartPilotAI;
    } catch (e) { /* ignore */ }
    return null;
  }

  // Scientific health classifier (window.KhanaProHealth / require). Guarded: if
  // absent, every health predicate degrades to "true" (no filtering, never throws).
  function getHealth() {
    try {
      var g = root || (typeof globalThis !== "undefined" ? globalThis : null);
      if (g && g.KhanaProHealth) return g.KhanaProHealth;
      if (typeof globalThis !== "undefined" && globalThis.KhanaProHealth) return globalThis.KhanaProHealth;
    } catch (e) { /* ignore */ }
    try {
      if (typeof module !== "undefined" && module.exports && typeof require === "function") {
        // eslint-disable-next-line global-require
        return require("./health_classifier.js");
      }
    } catch (e2) { /* ignore */ }
    return null;
  }

  // True when a recipe is healthy per the scientific classifier. No classifier
  // (or a throw) => treat as healthy so we never over-filter / dead-end.
  function recipeIsHealthy(r) {
    try {
      var h = getHealth();
      if (h && typeof h.isHealthy === "function") return !!h.isHealthy(r);
    } catch (e) { /* ignore */ }
    return true;
  }

  // The classifier tier for a recipe, or null if unavailable.
  function recipeTier(r) {
    try {
      var h = getHealth();
      if (h && typeof h.classify === "function") {
        var c = h.classify(r);
        return c && c.tier ? c.tier : null;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // Keep only healthy (isHealthy===true) recipes. If that empties the list,
  // return the original so a food ask still never dead-ends.
  function keepHealthy(recipes) {
    var src = safeRecipes(recipes);
    var out = [];
    for (var i = 0; i < src.length; i++) {
      if (recipeIsHealthy(src[i])) out.push(src[i]);
    }
    return out.length ? out : src;
  }

  // Keep only recipes whose classifier tier is in `wantTiers`. Graceful: if the
  // filter empties the list (or no classifier), return the original.
  function keepTier(recipes, wantTiers) {
    if (!isArray(wantTiers) || !wantTiers.length) return safeRecipes(recipes);
    var src = safeRecipes(recipes);
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var tier = recipeTier(src[i]);
      if (tier && wantTiers.indexOf(tier) !== -1) out.push(src[i]);
    }
    return out.length ? out : src;
  }

  // Does the query imply a HEALTHY intent (clean/light/diet/fit/healthiest)?
  function healthyIntent(t) {
    return /\b(health(?:y|ier|iest)?|clean(?: eating)?|light(?:er)?|low[\s-]?cal|low calorie|diet|dieting|fit(?:ness)?|lean|slim(?:ming)?|weight loss|wholesome|nutritious|guilt[\s-]?free|good for me|low[\s-]?fat)\b/.test(t);
  }

  // Map a query to a preferred classifier tier set (Fix 6). null = no tier pref.
  function tierIntent(t) {
    if (/\b(?:high[\s-]?protein|protein[\s-]?rich|protein packed|muscle|gains?|bulk(?:ing)?)\b/.test(t)) {
      return ["protein-rich"];
    }
    if (/\b(?:cheat|indulgent|indulge|treat|decadent|guilty|comfort food)\b/.test(t)) {
      return ["indulgent", "sweet-treat"];
    }
    if (/\b(?:light|lighter|low[\s-]?cal|low calorie|slimming|low[\s-]?fat)\b/.test(t)) {
      return ["light"];
    }
    return null;
  }

  // Apply scientific health/tier shaping to a FOOD result list (never beverages).
  // - if a tier preference is detected, prefer that tier;
  // - else if a healthy intent is detected, keep only isHealthy() recipes.
  // Always graceful (keepHealthy/keepTier fall back rather than emptying).
  function applyHealthShaping(recipes, t) {
    var out = safeRecipes(recipes);
    var tiers = tierIntent(t);
    if (tiers) {
      // a cheat/treat ask should NOT be force-filtered to isHealthy()
      out = keepTier(out, tiers);
      return out;
    }
    if (healthyIntent(t)) {
      out = keepHealthy(out);
    }
    return out;
  }

  // ---- small helpers --------------------------------------------------------
  function isArray(x) { return Object.prototype.toString.call(x) === "[object Array]"; }
  function str(x) { return (x == null) ? "" : String(x); }
  function lc(x) { return str(x).toLowerCase(); }
  function num(x) { var n = Number(x); return isFinite(n) ? n : NaN; }
  function clampList(arr, n) {
    if (!isArray(arr)) return [];
    return arr.slice(0, (n > 0 ? n : 0));
  }
  function safeRecipes(x) { return isArray(x) ? x : []; }

  // ---- beverage categories & intent ----------------------------------------
  // Beverages = drinks AND smoothies (protein shakes, coolers, lassi-like).
  // Food routes must never leak EITHER category. Beverage queries may include both.
  var BEVERAGE_CATS = { "drink": 1, "smoothie": 1 };
  function isBeverage(r) {
    return !!(r && BEVERAGE_CATS[lc(r.category)]);
  }
  // true when the user explicitly asked for a beverage (drink/smoothie/shake/etc.)
  function beverageIntent(text) {
    var t = str(text);
    return /\b(drink|drinks|smoothie|smoothies|shake|shakes|milkshake|milkshakes|lassi|juice|juices|cooler|coolers|summer cooler|summer coolers|mojito|mocktail|mocktails|cocktail|frappe|frappes|sharbat|sherbet|chaas|buttermilk|tea|thandai|beverage|hydration|cold coffee|iced coffee|cold drink|cold drinks|detox water|kombucha|aam panna|nimbu pani|kadha)\b/i.test(t);
  }

  // strip every beverage-category recipe (drink + smoothie) from a list.
  // Food routes must never leak drinks OR smoothies. (Name kept for stability.)
  function excludeDrinks(arr) {
    var src = safeRecipes(arr);
    var out = [];
    for (var i = 0; i < src.length; i++) {
      if (src[i] && !isBeverage(src[i])) out.push(src[i]);
    }
    return out;
  }

  // numbers like "400", "1,200"
  function firstNumberAfter(text, words) {
    // find a number that follows any of the trigger words within a few tokens
    for (var i = 0; i < words.length; i++) {
      var re = new RegExp(words[i] + "\\s*(?:to|of|:)?\\s*(\\d{2,4})", "i");
      var m = text.match(re);
      if (m) { var v = num(m[1].replace(/,/g, "")); if (isFinite(v)) return v; }
    }
    return null;
  }

  // generic "under/below/less than/<= N" capture
  function numberUnder(text) {
    var m = text.match(/(?:under|below|less than|fewer than|<=?|max(?:imum)?|upto|up to)\s*(\d{2,4})/i);
    if (m) { var v = num(m[1].replace(/,/g, "")); if (isFinite(v)) return v; }
    return null;
  }
  function numberOver(text) {
    var m = text.match(/(?:over|above|more than|at least|>=?|min(?:imum)?)\s*(\d{1,4})/i);
    if (m) { var v = num(m[1].replace(/,/g, "")); if (isFinite(v)) return v; }
    return null;
  }

  // ---- intent / constraint vocabulary --------------------------------------
  var CUISINE_MAP = {
    "north indian": "North Indian", "punjabi": "North Indian", "north-indian": "North Indian",
    "south indian": "South Indian", "south-indian": "South Indian",
    "indo-chinese": "Indo-Chinese", "indochinese": "Indo-Chinese", "chinese": "Indo-Chinese",
    "hakka": "Indo-Chinese", "manchurian": "Indo-Chinese",
    "continental": "Continental",
    "mediterranean": "Mediterranean", "greek": "Mediterranean",
    "pan-asian": "Pan-Asian", "pan asian": "Pan-Asian", "asian": "Pan-Asian",
    "thai": "Pan-Asian", "japanese": "Pan-Asian", "korean": "Pan-Asian",
    "healthy": "Healthy",
    "fusion": "Fusion"
  };

  var CATEGORY_MAP = {
    // NOTE: "high protein" is intentionally NOT mapped to the narrow "high-protein"
    // category — it is handled as the highProtein constraint (minProtein + protein sort),
    // which is broader and matches protein-forward dishes across all categories.
    "salad": "salad", "salads": "salad",
    "noodle": "noodles", "noodles": "noodles",
    "bowl": "bowl", "bowls": "bowl", "buddha bowl": "bowl",
    "curry": "curry", "curries": "curry", "gravy": "curry",
    "soup": "soup", "soups": "soup",
    "breakfast": "breakfast",
    "snack": "snack", "snacks": "snack",
    "grill": "grill", "grilled": "grill", "tikka": "grill",
    "smoothie": "smoothie", "shake": "smoothie",
    "wrap": "wrap", "wraps": "wrap", "roll": "wrap", "frankie": "wrap",
    "dessert": "healthy-dessert", "desserts": "healthy-dessert", "sweet": "healthy-dessert",
    "healthy-dessert": "healthy-dessert"
  };

  var MEALTYPE_WORDS = {
    "breakfast": "breakfast",
    "brunch": "breakfast",
    "lunch": "lunch",
    "dinner": "dinner",
    "supper": "dinner",
    "snack": "snack",
    "snacks": "snack"
  };

  // tags that the engine carries on recipes for "with a twist" style asks
  var TWIST_TAGS = ["fusion", "twist", "tangy"];

  function detectCuisine(text) {
    var t = lc(text);
    // longest keys first to avoid "indian" eating "north indian"
    var keys = Object.keys(CUISINE_MAP).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (t.indexOf(keys[i]) !== -1) return CUISINE_MAP[keys[i]];
    }
    return null;
  }

  function detectCategory(text) {
    var t = lc(text);
    var keys = Object.keys(CATEGORY_MAP).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (t.indexOf(keys[i]) !== -1) return CATEGORY_MAP[keys[i]];
    }
    return null;
  }

  function detectMealType(text) {
    var t = lc(text);
    var keys = Object.keys(MEALTYPE_WORDS);
    for (var i = 0; i < keys.length; i++) {
      var re = new RegExp("\\b" + keys[i] + "\\b", "i");
      if (re.test(t)) return MEALTYPE_WORDS[keys[i]];
    }
    return null;
  }

  // ---- constraint parsing for "filter" --------------------------------------
  function parseConstraints(text) {
    var t = lc(text);
    var c = {
      cuisine: detectCuisine(t),
      category: detectCategory(t),
      mealType: detectMealType(t),
      veg: /\bveg\b|\bvegetarian\b/.test(t) && !/\bvegan\b/.test(t) ? true : (/\bvegetarian\b/.test(t) ? true : false),
      vegan: /\bvegan\b/.test(t),
      jain: /\bjain\b/.test(t),
      glutenFree: /gluten[\s-]?free|gluten free|\bgf\b/.test(t),
      eggless: /egg[\s-]?less|eggless|no egg/.test(t),
      noOnionGarlic: /no onion|no garlic|sattvic|without onion|without garlic/.test(t),
      quick: /\bquick\b|\bfast\b|\beasy\b|\b\d+\s*min|in a hurry|under \d+\s*min/.test(t),
      highProtein: /high[\s-]?protein|protein[\s-]?rich|\bprotein\b|muscle|gym/.test(t),
      withTwist: /with a twist|with twist|fusion|twisted|reinvent|jazzed|funky|tangy/.test(t),
      maxKcal: null,
      minProtein: null,
      maxTime: null,
      tags: []
    };

    // vegan implies veg
    if (c.vegan) c.veg = true;

    // ---- fuzzy intent mapping (low gi / cheap-student / no-cooking) ----------
    // "low gi" / "low glycemic" -> diabetic-friendly / high-fibre tags, low sugar
    if (/\blow[\s-]?gi\b|low glycemic|low glycaemic|low gl\b/.test(t)) {
      c.tags.push("low-gi", "diabetic-friendly", "high-fibre");
    }
    if (/diabet/.test(t) && c.tags.indexOf("diabetic-friendly") === -1) {
      c.tags.push("diabetic-friendly");
    }
    // "cheap" / "student" / "budget" / "bachelor" -> quick + common staples
    if (/\bcheap\b|\bbudget\b|\bstudent\b|\bstudents\b|\bbachelor\b|\bbachelors\b|\baffordable\b|\binexpensive\b/.test(t)) {
      c.quick = true;
    }
    // "no cooking" / "no skills" / "15 minute" / "one pot" -> quick / short time
    if (/no cooking|no[\s-]?cook|without cooking|no skill|no cooking skill|cannot cook|can'?t cook|one[\s-]?pot|easy|simple/.test(t)) {
      c.quick = true;
    }

    // calories: "under 400 cal", "400 calories", "low calorie"
    var kcal = firstNumberAfter(t, ["under", "below", "less than", "max", "upto", "up to"]);
    // only treat number-under as kcal if it's calorie-ish context or a 3-4 digit number
    var hasCalWord = /cal|kcal|calorie/.test(t);
    var underN = numberUnder(t);
    if (hasCalWord) {
      // pick number nearest a calorie word
      var calMatch = t.match(/(\d{2,4})\s*(?:k?cal|calorie|calories)/i) || t.match(/(?:cal|kcal|calorie|calories)\D{0,8}(\d{2,4})/i);
      if (calMatch) { var cv = num(calMatch[1]); if (isFinite(cv)) c.maxKcal = cv; }
      if (c.maxKcal == null && underN != null) c.maxKcal = underN;
    } else if (underN != null && underN >= 100 && !/\bmin\b|\bmins\b|minute/.test(t)) {
      // a bare "under 400" with no minutes context → treat as kcal cap
      c.maxKcal = underN;
    }
    if (c.maxKcal == null && /low[\s-]?cal|low calorie|light|lighter|slimming|weight loss/.test(t)) {
      c.maxKcal = 400;
    }

    // protein floor: "at least 25g protein", "30g protein"
    var protMatch = t.match(/(\d{1,3})\s*g?\s*(?:of\s*)?protein/i) || t.match(/protein\D{0,6}(\d{1,3})/i);
    if (protMatch) { var pv = num(protMatch[1]); if (isFinite(pv) && pv > 0 && pv <= 120) c.minProtein = pv; }
    var protOver = numberOver(t);
    if (c.minProtein == null && protOver != null && /protein/.test(t)) c.minProtein = protOver;
    if (c.minProtein == null && c.highProtein) c.minProtein = 20;

    // time: "under 20 min", "15 minute", "in 10 mins"
    var timeMatch = t.match(/(?:under|below|in|within|max|<=?)?\s*(\d{1,3})\s*(?:min|mins|minute|minutes)\b/i);
    if (timeMatch) { var tv = num(timeMatch[1]); if (isFinite(tv) && tv > 0) c.maxTime = tv; }
    if (c.maxTime == null && c.quick) c.maxTime = 20;

    return c;
  }

  // build engine filter opts from parsed constraints
  function constraintsToFilterOpts(c) {
    var opts = {};
    if (c.cuisine) opts.cuisine = c.cuisine;
    if (c.category) opts.category = c.category;
    if (c.veg) opts.veg = true;
    if (c.vegan) opts.vegan = true;
    if (c.jain) opts.jain = true;
    if (c.glutenFree) opts.glutenFree = true;
    if (c.eggless) opts.eggless = true;
    if (c.noOnionGarlic) opts.noOnionGarlic = true;
    if (c.maxKcal != null) opts.maxKcal = c.maxKcal;
    if (c.minProtein != null) opts.minProtein = c.minProtein;
    if (c.maxTime != null) opts.maxTime = c.maxTime;
    // mealType maps to a tag (recipes carry meal tags like "dinner"/"lunch")
    if (c.mealType) opts.tag = c.mealType;
    // sort preference
    // NOTE: deliberately do NOT sort by kcalAsc when a maxKcal cap is set — that
    // surfaces the absolute lowest-kcal items (teas/broths) instead of real, more
    // satisfying dishes that still satisfy the cap. Prefer protein/relevance.
    if (c.highProtein) opts.sort = "protein";
    else if (c.maxKcal != null) opts.sort = "protein";
    else if (c.quick) opts.sort = "timeAsc";
    return opts;
  }

  // ---- "with a twist" reorder: prefer recipes carrying fusion/twist/tangy ----
  function preferTwist(recipes) {
    var arr = safeRecipes(recipes).slice();
    function twistScore(r) {
      var tags = isArray(r.tags) ? r.tags : [];
      var s = 0;
      for (var i = 0; i < TWIST_TAGS.length; i++) {
        if (tags.indexOf(TWIST_TAGS[i]) !== -1) s += 1;
      }
      if (lc(r.cuisine) === "fusion") s += 1;
      return s;
    }
    arr.sort(function (a, b) { return twistScore(b) - twistScore(a); });
    return arr;
  }

  // ---- intent classifiers ---------------------------------------------------
  function isPlanAsk(t) {
    return /\b\d+\s*[- ]?day\b|\bweek(ly)?\b|\bmeal\s*plan\b|\btimetable\b|\bschedule\b|\bplan\b.*\b(week|day|diet|meal)|\b(week|day|diet|meal)\b.*\bplan\b|\b7\s*day|\bmonthly\b/.test(t)
      || /\bcook bhaiya\b/.test(t)
      || /\bplan (me|my|a)\b/.test(t);
  }

  function isSimilarAsk(t) {
    return /\b(something|anything)\s+like\b|\bsimilar to\b|\balternativ(e|es)\s+to\b|\binstead of\b|\blike\b.*\bbut\b|\bother than\b|\bversion of\b|\bsubstitute for\b/.test(t);
  }

  function isReverseAsk(t) {
    return /\bi have\b|\bi've got\b|\bi got\b|what can i (cook|make|prepare)\b|\bcook with\b|\bmake with\b|\busing\b.*\band\b|\bwith just\b|\bonly have\b|\bleftover\b/.test(t);
  }

  function isAnswerAsk(t) {
    return /how (much|many)\b|\bhow's the\b|\bnutrition\b|\bcalories? in\b|\bprotein in\b|\bfibre in\b|\bfiber in\b|\bfat in\b|\bcarbs? in\b|\bis .* (healthy|vegan|veg|gluten)|\bwhat'?s in\b|\btell me about\b/.test(t);
  }

  // detect that a filter-style constraint is present
  function looksLikeFilter(t, c) {
    if (c.cuisine || c.category || c.mealType) return true;
    if (c.maxKcal != null || c.minProtein != null || c.maxTime != null) return true;
    if (c.veg || c.vegan || c.jain || c.glutenFree || c.eggless || c.noOnionGarlic) return true;
    if (c.quick || c.highProtein || c.withTwist) return true;
    return false;
  }

  // ---- "base recipe" extraction for similar ---------------------------------
  function extractSimilarBaseQuery(t) {
    // "something like rajma but lighter" -> "rajma"
    // "alternatives to butter chicken" -> "butter chicken"
    var m;
    m = t.match(/(?:something|anything)\s+like\s+(.+?)(?:\s+but\b|\s+that\b|\s+which\b|[?.!]|$)/i);
    if (m && m[1]) return m[1].trim();
    m = t.match(/\bsimilar to\s+(.+?)(?:\s+but\b|\s+that\b|[?.!]|$)/i);
    if (m && m[1]) return m[1].trim();
    m = t.match(/\balternativ(?:e|es)\s+to\s+(.+?)(?:\s+but\b|\s+that\b|[?.!]|$)/i);
    if (m && m[2 - 1] && m[1]) return m[1].trim();
    m = t.match(/\b(?:instead of|other than|substitute for|version of)\s+(.+?)(?:\s+but\b|\s+that\b|[?.!]|$)/i);
    if (m && m[1]) return m[1].trim();
    m = t.match(/\blike\s+(.+?)\s+but\b/i);
    if (m && m[1]) return m[1].trim();
    return "";
  }

  // ---- ingredient extraction for reverse ------------------------------------
  var STOPWORDS = {
    "i": 1, "have": 1, "ive": 1, "got": 1, "a": 1, "an": 1, "the": 1, "some": 1, "and": 1,
    "with": 1, "what": 1, "can": 1, "cook": 1, "make": 1, "prepare": 1, "using": 1, "use": 1,
    "just": 1, "only": 1, "left": 1, "leftover": 1, "leftovers": 1, "in": 1, "my": 1, "fridge": 1,
    "kitchen": 1, "pantry": 1, "of": 1, "to": 1, "for": 1, "me": 1, "something": 1, "anything": 1,
    "today": 1, "tonight": 1, "dinner": 1, "lunch": 1, "breakfast": 1, "recipe": 1, "recipes": 1,
    "or": 1, "few": 1, "little": 1, "bit": 1, "at": 1, "home": 1, "do": 1, "got": 1, "is": 1, "are": 1
  };

  function extractIngredients(t) {
    var work = t;
    // strip the leading "what can i cook with" / "i have" framing
    work = work.replace(/.*\b(cook|make|prepare)\s+with\b/i, "");
    work = work.replace(/.*\bi\s+(?:have|'ve got|got|only have)\b/i, "");
    work = work.replace(/.*\busing\b/i, "");
    work = work.replace(/[?.!]/g, " ");
    // split on commas, "and", "&", "+", "/"
    var raw = work.split(/,|\band\b|&|\+|\bwith\b|\bor\b|\//i);
    var out = [];
    var seen = {};
    for (var i = 0; i < raw.length; i++) {
      var phrase = lc(raw[i]).trim();
      if (!phrase) continue;
      // keep multi-word ingredient phrases but drop stopwords token-by-token
      var words = phrase.split(/\s+/).filter(function (w) {
        return w && !STOPWORDS[w] && w.length > 1;
      });
      if (!words.length) continue;
      var name = words.join(" ").trim();
      if (name && !seen[name]) { seen[name] = true; out.push(name); }
    }
    return out;
  }

  // rank KB recipes by how many of the wanted ingredients they use
  function rankByIngredients(recipes, have) {
    var scored = [];
    for (var i = 0; i < recipes.length; i++) {
      var r = recipes[i];
      var ingNames = (isArray(r.ingredients) ? r.ingredients : []).map(function (x) { return lc(x && x.name); });
      var ingBlob = ingNames.join(" ") + " " + lc(r.title) + " " + (isArray(r.tags) ? r.tags.join(" ") : "");
      var hits = 0;
      for (var h = 0; h < have.length; h++) {
        var token = have[h];
        // match each have-token against ingredient names / title / tags
        if (ingBlob.indexOf(token) !== -1) hits += 1;
        else {
          // also try the head noun (last word) e.g. "fresh spinach" -> "spinach"
          var head = token.split(/\s+/).pop();
          if (head && head.length > 2 && ingBlob.indexOf(head) !== -1) hits += 1;
        }
      }
      if (hits > 0) scored.push({ r: r, hits: hits, i: i });
    }
    scored.sort(function (a, b) {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.i - b.i;
    });
    return scored.map(function (x) { return x.r; });
  }

  // ---- friendly lead lines --------------------------------------------------
  function leadForFilter(c, n) {
    var bits = [];
    if (c.highProtein) bits.push("protein-packed");
    if (c.maxKcal != null) bits.push("under " + c.maxKcal + " kcal");
    if (c.quick) bits.push("quick");
    if (c.vegan) bits.push("vegan");
    else if (c.veg) bits.push("veg");
    if (c.glutenFree) bits.push("gluten-free");
    if (c.withTwist) bits.push("with a fun twist");
    var what = c.mealType || c.category || "picks";
    var pre = bits.length ? bits.join(", ") + " " : "";
    if (!n) return "Hmm, no exact matches — here are the closest healthy " + what + " I could find.";
    return "Here are " + n + " " + pre + what + " I think you'll love.";
  }

  function leadForSimilar(baseTitle, lighter, n) {
    if (!n) return "Could not find close matches — try naming the dish a bit differently.";
    var l = lighter ? " (lighter ones first)" : "";
    return "If you like " + baseTitle + ", try these" + l + ".";
  }

  function leadForReverse(have, n) {
    if (!have.length) return "Tell me a couple of ingredients you have and I'll find recipes.";
    if (!n) return "Nothing matched " + have.join(" + ") + " exactly — here's the library to browse.";
    return "With " + have.join(" + ") + ", you can make these.";
  }

  // ===========================================================================
  // NEW CAPABILITIES (additive): count parsing, action flag, ingredient
  // suggestions, "themed" (weekday-initial / starts-with), and "dayplan".
  // All deterministic + no-throw; guard a missing engine everywhere.
  // ===========================================================================

  // ---- requested count ("a couple"=2, "a few"=3, "5"/"ten"=N, default given)
  var WORD_NUMS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "a couple": 2, "couple": 2, "a few": 3, "few": 3, "several": 4, "handful": 5,
    "a dozen": 12, "dozen": 12
  };

  function parseCount(t, def) {
    var d = (def > 0) ? def : 8;
    if (!t) return d;
    // explicit digit, e.g. "5 dishes", "give me 3"
    var m = t.match(/\b(\d{1,2})\b/);
    if (m) {
      var v = num(m[1]);
      if (isFinite(v) && v >= 1 && v <= 30) return v;
    }
    // word phrases (longest first so "a couple" wins over "couple")
    var keys = Object.keys(WORD_NUMS).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      var re = new RegExp("\\b" + keys[i].replace(/ /g, "\\s+") + "\\b", "i");
      if (re.test(t)) return WORD_NUMS[keys[i]];
    }
    return d;
  }

  // ---- action flag: does the text ask us to act on the results? -------------
  function detectAction(t) {
    if (/\badd\b[\s\S]*\bcart\b/.test(t)) return "cartCompare";
    if (/\bto cart\b/.test(t)) return "cartCompare";
    if (/\bcompare\b[\s\S]*\bprice/.test(t)) return "cartCompare";
    if (/\bprice[\s\S]*\bcompare\b/.test(t)) return "cartCompare";
    if (/\border\b/.test(t)) return "cartCompare";
    // Fix 5: broaden — "put X in my cart/basket", "add to my basket",
    // "order me X", "price these/this/that", bare "compare".
    if (/\b(?:put|pop|drop|throw|chuck|stick)\b[\s\S]*\b(?:cart|basket|trolley)\b/.test(t)) return "cartCompare";
    if (/\badd\b[\s\S]*\bbasket\b/.test(t)) return "cartCompare";
    if (/\bto\s+(?:my\s+)?basket\b/.test(t)) return "cartCompare";
    if (/\border\s+me\b/.test(t)) return "cartCompare";
    if (/\bprice\s+(?:these|this|that|them|it)\b/.test(t)) return "cartCompare";
    if (/\bcompare\s+prices?\b/.test(t)) return "cartCompare";
    if (/\b(?:buy|purchase)\b[\s\S]*\b(?:cart|basket|order)\b/.test(t)) return "cartCompare";
    return null;
  }

  // ===========================================================================
  // (1) INGREDIENT / KEYWORD SUGGESTIONS
  // "suggest rajma dishes", "a couple of avocado dishes", "dishes with paneer",
  // "some tofu recipes" -> kind "filter" matched by ingredient/title/tags.
  // ===========================================================================
  var SUGGEST_STOP = {
    "suggest": 1, "suggestion": 1, "suggestions": 1, "show": 1, "give": 1, "find": 1,
    "get": 1, "list": 1, "some": 1, "any": 1, "a": 1, "an": 1, "the": 1, "me": 1, "us": 1,
    "couple": 1, "few": 1, "several": 1, "handful": 1, "dozen": 1, "of": 1, "with": 1,
    "dish": 1, "dishes": 1, "recipe": 1, "recipes": 1, "meal": 1, "meals": 1, "food": 1,
    "please": 1, "pls": 1, "made": 1, "using": 1, "use": 1, "containing": 1, "having": 1,
    "that": 1, "have": 1, "has": 1, "for": 1, "my": 1, "i": 1, "want": 1, "would": 1,
    "like": 1, "love": 1, "to": 1, "eat": 1, "cook": 1, "make": 1, "and": 1, "or": 1,
    "good": 1, "nice": 1, "tasty": 1, "healthy": 1, "more": 1, "another": 1, "other": 1,
    "based": 1, "ideas": 1, "idea": 1, "options": 1, "option": 1, "something": 1, "anything": 1,
    "are": 1, "is": 1, "do": 1, "you": 1, "can": 1, "couple of": 1, "around": 1, "about": 1
  };

  // is this a "suggest X dishes" style ask? returns the keyword(s) or null.
  function detectSuggestKeyword(t) {
    var m;
    // "dishes/recipes with|using|containing|made of|of <kw>"
    m = t.match(/\b(?:dishes|recipes|meals|something|options|ideas)\s+(?:with|using|containing|made\s+(?:with|of|from)|of|based\s+on)\s+(.+?)(?:[?.!]|$)/i);
    if (m && m[1]) return cleanKeyword(m[1]);
    // "<kw> dishes/recipes/meals" e.g. "rajma dishes", "tofu recipes"
    m = t.match(/\b(?:suggest|show|give\s+me|find|get|list|some|a\s+couple\s+of|a\s+few|recommend)\b[\s\S]*?\b([a-z][a-z\s\-]*?)\s+(?:dishes|recipes|meals|ideas|options)\b/i);
    if (m && m[1]) {
      var k = cleanKeyword(m[1]);
      if (k) return k;
    }
    // generic "<kw> dishes" / "<kw> recipes" anywhere
    m = t.match(/\b([a-z][a-z\-]+)\s+(?:dishes|recipes)\b/i);
    if (m && m[1]) {
      var k2 = cleanKeyword(m[1]);
      if (k2) return k2;
    }
    return null;
  }

  function cleanKeyword(s) {
    var words = lc(s).replace(/[?.!,]/g, " ").split(/\s+/).filter(function (w) {
      return w && !SUGGEST_STOP[w] && w.length > 1;
    });
    return words.join(" ").trim();
  }

  // rank recipes by how well they match a keyword across ingredients/title/tags
  function rankByKeyword(recipes, kw) {
    if (!kw) return [];
    var head = kw.split(/\s+/).pop();
    var scored = [];
    for (var i = 0; i < recipes.length; i++) {
      var r = recipes[i];
      var ingNames = (isArray(r.ingredients) ? r.ingredients : []).map(function (x) { return lc(x && x.name); });
      var title = lc(r.title);
      var tagBlob = (isArray(r.tags) ? r.tags.join(" ") : "").toLowerCase();
      var ingBlob = ingNames.join(" ");
      var s = 0;
      if (ingBlob.indexOf(kw) !== -1) s += 3;
      if (title.indexOf(kw) !== -1) s += 3;
      if (tagBlob.indexOf(kw) !== -1) s += 2;
      if (s === 0 && head && head.length > 2) {
        if (ingBlob.indexOf(head) !== -1) s += 2;
        if (title.indexOf(head) !== -1) s += 2;
        if (tagBlob.indexOf(head) !== -1) s += 1;
      }
      if (s > 0) scored.push({ r: r, s: s, i: i });
    }
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      return a.i - b.i;
    });
    return scored.map(function (x) { return x.r; });
  }

  function titleCaseWord(s) {
    s = str(s);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ===========================================================================
  // DRINK INTENT — lassi/mojito/juices/coolers/mocktails/etc.
  // Detected BEFORE the generic suggest/filter path. Restricts candidates to
  // recipes with category === "drink" only; never returns food for a drink ask.
  // ===========================================================================
  var DRINK_RE = /\b(drink|drinks|lassi|mojito|mocktail|cocktail|smoothie|smoothies|juice|juices|cooler|coolers|summer cooler|sharbat|chaas|buttermilk|tea|kombucha|shake|shakes|milkshake|frappe|hydration|thandai|sherbet|kadha|detox water|mocktails|cocktails|cold coffee|iced coffee|cold drink|aam panna|nimbu pani|kanji)\b/;

  // specific drink-keyword tokens to rank by (whatever the user actually mentioned)
  // longer multi-word tokens first so e.g. "cold coffee" matches before "cooler".
  var DRINK_KEYWORDS = [
    "summer cooler", "cold coffee", "iced coffee", "cold drink", "detox water",
    "aam panna", "nimbu pani", "milkshake", "lassi", "mojito", "mocktail",
    "cocktail", "smoothie", "juice", "cooler", "frappe", "sharbat", "chaas",
    "buttermilk", "tea", "kombucha", "shake", "thandai", "sherbet", "kadha",
    "detox", "hydration", "coffee"
  ];

  function detectDrinkKeywords(t) {
    var found = [];
    for (var i = 0; i < DRINK_KEYWORDS.length; i++) {
      var kw = DRINK_KEYWORDS[i];
      var re = new RegExp("\\b" + kw.replace(/ /g, "\\s+"), "i");
      if (re.test(t)) found.push(kw);
    }
    return found;
  }

  // rank drink recipes by how well title/tags match the mentioned drink keywords
  function rankDrinks(drinks, keywords) {
    var arr = safeRecipes(drinks).slice();
    if (!keywords || !keywords.length) {
      // stable order by title when nothing specific to match
      arr.sort(function (a, b) {
        var at = lc(a.title), bt = lc(b.title);
        if (at < bt) return -1; if (at > bt) return 1; return 0;
      });
      return arr;
    }
    var scored = [];
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      var title = lc(r.title);
      var tagBlob = (isArray(r.tags) ? r.tags.join(" ") : "").toLowerCase();
      var s = 0;
      for (var k = 0; k < keywords.length; k++) {
        var kw = keywords[k];
        if (title.indexOf(kw) !== -1) s += 3;
        if (tagBlob.indexOf(kw) !== -1) s += 2;
      }
      scored.push({ r: r, s: s, i: i });
    }
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      var at = lc(a.r.title), bt = lc(b.r.title);
      if (at < bt) return -1; if (at > bt) return 1;
      return a.i - b.i;
    });
    return scored.map(function (x) { return x.r; });
  }

  function buildDrinks(engine, hasEngine, keywords, wantN, constraints) {
    var pool = [];
    if (hasEngine) pool = safeRecipes(engine.all && engine.all());
    // restrict strictly to beverage-category recipes (drink + smoothie)
    var drinks = [];
    for (var i = 0; i < pool.length; i++) {
      if (isBeverage(pool[i])) drinks.push(pool[i]);
    }
    // respect diet constraints when stated (graceful: falls back to all drinks)
    var dieted = applyDietFilter(drinks, constraints);
    // applyDietFilter can fall back to the FULL pool if it wipes everything —
    // re-restrict to beverages so we never leak food.
    var safe = [];
    for (var j = 0; j < dieted.length; j++) {
      if (isBeverage(dieted[j])) safe.push(dieted[j]);
    }
    if (!safe.length) safe = drinks;

    var ranked = rankDrinks(safe, keywords);
    // if specific keywords were given but none matched a drink, fall back to ALL
    // drinks (still category === "drink"), already handled since rankDrinks keeps
    // every drink (score 0) — so we always have the full drink set available.
    return clampList(ranked, wantN);
  }

  // ===========================================================================
  // (2) THEMED — weekday-initial + "dishes starting with <X>"
  // ===========================================================================
  var WEEKDAYS = [
    { label: "Monday",    letter: "M" },
    { label: "Tuesday",   letter: "T" },
    { label: "Wednesday", letter: "W" },
    { label: "Thursday",  letter: "T" },
    { label: "Friday",    letter: "F" },
    { label: "Saturday",  letter: "S" },
    { label: "Sunday",    letter: "S" }
  ];

  function isWeekdayInitialAsk(t) {
    if (/start(?:s|ing)?\s+with\s+the\s+(?:first\s+)?letter\s+of\s+(?:that|the|each)?\s*day/.test(t)) return true;
    if (/each\s+(?:of\s+the\s+)?(?:seven|7)\s+days?/.test(t)) return true;
    if (/(?:one|a dish|a recipe)\s+(?:per|for\s+each|each)\s+(?:day|of the (?:seven|7) days)/.test(t)) return true;
    if (/(?:every\s+(?:week)?day)/.test(t) && /(?:letter|start)/.test(t)) return true;
    if (/(?:7|seven)\s+dishes\b[\s\S]*\bone\s+per\s+day/.test(t)) return true;
    if (/for\s+each\s+(?:of\s+the\s+)?(?:seven|7)?\s*days?\b[\s\S]*\b(?:letter|start)/.test(t)) return true;
    if (/(?:dish|recipe|meal)\s+for\s+each\s+day\b/.test(t) && /(?:letter|start)/.test(t)) return true;
    // --- Fix 3: weekday-by-letter / each-weekday phrasings ---
    // "a dish for each weekday by its letter", "by the letter", "weekday by",
    // "each weekday", "one for each day", "day-wise", "letter of the day".
    if (/\bby\s+(?:its|the)\s+letter\b/.test(t)) return true;
    if (/\bletter\s+of\s+(?:the|each|that)\s+(?:week)?day\b/.test(t)) return true;
    if (/\bweekday\s+by\b/.test(t)) return true;
    if (/\beach\s+weekday\b/.test(t)) return true;
    if (/\bone\s+for\s+each\s+(?:week)?day\b/.test(t)) return true;
    if (/\bday[\s-]?wise\b/.test(t)) return true;
    if (/\b(?:for|each)\s+(?:each\s+)?weekday\b/.test(t)) return true;
    return false;
  }

  // generic "dishes starting with R" -> letter, else null
  function detectStartsWithLetter(t) {
    var m = t.match(/\b(?:dishes|recipes|meals|something)\s+(?:that\s+)?start(?:s|ing)?\s+with\s+(?:the\s+letter\s+)?["']?([a-z])["']?\b/i);
    if (m && m[1]) return m[1].toUpperCase();
    m = t.match(/\bstart(?:s|ing)?\s+with\s+(?:the\s+letter\s+)?["']?([a-z])["']?\b/i);
    if (m && m[1] && !/letter of/.test(t)) return m[1].toUpperCase();
    return null;
  }

  function titleStartsWith(r, letter) {
    var ttl = lc(r && r.title).replace(/^[^a-z0-9]+/, "");
    return ttl.charAt(0) === lc(letter);
  }

  // deterministic pick: build a weekday-initial themed set.
  function buildWeekdayThemed(engine, hasEngine, constraints) {
    var pool = [];
    if (hasEngine) pool = safeRecipes(engine.all && engine.all());
    // apply diet constraints to the pool when present (stay graceful)
    pool = applyDietFilter(pool, constraints);
    // deterministic order: by title then id, so picks are stable
    pool = pool.slice().sort(function (a, b) {
      var at = lc(a.title), bt = lc(b.title);
      if (at < bt) return -1; if (at > bt) return 1;
      return lc(a.id) < lc(b.id) ? -1 : 1;
    });

    var used = {};
    var recipes = [];
    var relaxedDays = [];

    for (var d = 0; d < WEEKDAYS.length; d++) {
      var wd = WEEKDAYS[d];
      var pick = null;
      // 1) prefer title starting with the day's letter, unused
      for (var i = 0; i < pool.length; i++) {
        var r = pool[i];
        if (used[r.id]) continue;
        if (titleStartsWith(r, wd.letter)) { pick = r; break; }
      }
      // 2) relax: take any unused recipe
      if (!pick) {
        for (var j = 0; j < pool.length; j++) {
          var r2 = pool[j];
          if (!used[r2.id]) { pick = r2; relaxedDays.push(wd.label); break; }
        }
      }
      if (!pick) break; // pool exhausted
      used[pick.id] = true;
      // annotate a shallow clone so we don't mutate KB objects
      var ann = shallowClone(pick);
      ann.dayLabel = wd.label;
      ann.letter = wd.letter;
      recipes.push(ann);
    }

    var notes = "";
    if (relaxedDays.length) {
      notes = "No title started with the needed letter for: " + relaxedDays.join(", ") +
        " — picked the closest healthy dish instead.";
    }
    return { recipes: recipes, notes: notes };
  }

  function buildStartsWithThemed(engine, hasEngine, letter, constraints) {
    var pool = [];
    if (hasEngine) pool = safeRecipes(engine.all && engine.all());
    pool = applyDietFilter(pool, constraints);
    pool = pool.slice().sort(function (a, b) {
      var at = lc(a.title), bt = lc(b.title);
      if (at < bt) return -1; if (at > bt) return 1; return 0;
    });
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      if (titleStartsWith(pool[i], letter)) out.push(pool[i]);
    }
    return out;
  }

  function shallowClone(o) {
    var c = {};
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k]; }
    return c;
  }

  // diet filter usable on a raw recipe array (graceful: never throws)
  function applyDietFilter(pool, c) {
    if (!c) return pool;
    if (!(c.veg || c.vegan || c.jain || c.glutenFree || c.eggless || c.noOnionGarlic)) return pool;
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      var d = pool[i].diet || {};
      if (c.vegan && !d.vegan) continue;
      if (c.veg && !c.vegan && !(d.veg || d.vegan)) continue;
      if (c.jain && !d.jain) continue;
      if (c.glutenFree && !d.glutenFree) continue;
      if (c.eggless && !(d.eggless || d.vegan)) continue;
      if (c.noOnionGarlic && !d.noOnionGarlic) continue;
      out.push(pool[i]);
    }
    // graceful relaxation: if diet wiped everything, fall back to full pool
    return out.length ? out : pool;
  }

  // ===========================================================================
  // (3) DAYPLAN — Breakfast / Lunch / Snack / Dinner, optional kcal cap
  // ===========================================================================
  // Each meal: eligible categories, meal-affinity tags, a kcal floor, and the
  // fraction of a daily cap it should target (Breakfast .25 / Lunch .30 / Snack
  // .15 / Dinner .30). `def` is the fallback target when no cap is given.
  // NOTE: NO meal slot lists "drink" or "smoothie" in its primary `cats`. Beverages
  // are never meals. Breakfast carries a `fallbackCats` of ["smoothie"] that is used
  // ONLY as a last resort (after real breakfast food fails) — a protein smoothie is
  // an acceptable breakfast stand-in, but never preferred over real food. Lunch /
  // Dinner / Snack never accept a smoothie.
  var DAYPLAN_MEALS = [
    { label: "Breakfast", cats: ["breakfast"],                                        fallbackCats: ["smoothie"], tags: ["breakfast"],            minKcal: 150, maxKcal: Infinity, frac: 0.25, def: 450 },
    { label: "Lunch",     cats: ["curry", "bowl", "high-protein", "grill", "noodles"], tags: ["lunch", "high-protein"],          minKcal: 250, maxKcal: Infinity, frac: 0.30, def: 650 },
    { label: "Snack",     cats: ["snack", "salad"],                                    tags: ["snack", "salad"],                 minKcal: 100, maxKcal: 350,      frac: 0.15, def: 250 },
    { label: "Dinner",    cats: ["curry", "bowl", "high-protein", "grill", "noodles"], tags: ["dinner", "high-protein"],         minKcal: 250, maxKcal: Infinity, frac: 0.30, def: 650 }
  ];

  // Words that disqualify a recipe from being used as a real MEAL in a dayplan
  // (these are wellness drinks/shots/broths, not satisfying meals).
  var DAYPLAN_EXCLUDE_RE = /\b(shot|kadha|detox|wellness\s*shot|broth)\b/;

  function isMealEligible(r, spec) {
    if (!r) return false;
    var cat = lc(r.category);
    // beverages (drink AND smoothie) are NEVER meals via the strict path
    if (isBeverage(r)) return false;
    // exclude shots/kadha/detox/wellness shot/broth by title or tags
    var blob = lc(r.title) + " " + (isArray(r.tags) ? r.tags.map(lc).join(" ") : "");
    if (DAYPLAN_EXCLUDE_RE.test(blob)) return false;
    // category must be one of the eligible cats for this meal
    var okCat = false;
    for (var c = 0; c < spec.cats.length; c++) { if (cat === spec.cats[c]) { okCat = true; break; } }
    if (!okCat) return false;
    // kcal window for this meal
    var kc = kcalOf(r);
    if (kc < spec.minKcal) return false;
    if (kc > spec.maxKcal) return false;
    return true;
  }

  // multi-day / weekly markers — these must defer to the multi-day planner, NOT
  // the single-day dayplan branch.
  function isMultiDayAsk(t) {
    if (/\b(?:7|seven)\s*[- ]?\s*days?\b/.test(t)) return true;
    if (/\b\d+\s*[- ]?\s*days?\b/.test(t) && !/\b1\s*[- ]?\s*day\b/.test(t)) return true;
    if (/\bweek(?:ly|s)?\b/.test(t)) return true;
    if (/\beach\s+day\b/.test(t)) return true;
    if (/\bevery\s+day\b/.test(t)) return true;
    if (/\bmonthly\b/.test(t)) return true;
    return false;
  }

  function isDayPlanAsk(t) {
    // weekly / multi-day phrasings are NOT single-day dayplans
    if (isMultiDayAsk(t)) return false;
    if (/\b(?:all\s+)?(?:four|4)\s+meals?\b/.test(t)) return true;
    if (/\bmeals?\s+of\s+the\s+day\b/.test(t)) return true;
    if (/\bfull\s+day\s+(?:plan|meal|of\s+meals?|of\s+food|of\s+eating)/.test(t)) return true;
    if (/\bfull\s+day\b/.test(t) && /\b(?:meal|food|eat)/.test(t)) return true;
    if (/\ba\s+full\s+day\b/.test(t)) return true;
    if (/\bwhole\s+day\b/.test(t) && /\bmeal/.test(t)) return true;
    if (/\bbreakfast\b[\s\S]*\blunch\b[\s\S]*\bdinner\b/.test(t)) return true;
    if (/\bbreakfast\b[\s\S]*\bsnack\b[\s\S]*\bdinner\b/.test(t)) return true;
    if (/\bday'?s\s+meals\b/.test(t)) return true;
    // "<n> calorie day plan" / "<n> calorie full day" / "day plan" / "day of meals"
    if (/\bday\s*[- ]?\s*plan\b/.test(t)) return true;
    if (/\bday\s+of\s+meals?\b/.test(t)) return true;
    if (/\b\d{3,5}\s*(?:k?cal|calorie|calories)?\s*(?:full\s+)?day\b/.test(t)) return true;
    if (/\b\d{3,5}\s*(?:k?cal|calorie|calories)\s+(?:full\s+)?day\b/.test(t)) return true;
    // --- single-day cues (Fix 1): a SINGLE day's worth of eating, even if the
    //     word "plan" appears. These must beat the multi-day planner.
    //     e.g. "full veg day under 1500", "a full day", "one day", "today",
    //     "1600 calorie day", "plan a full vegan day under 1700".
    if (isSingleDayCue(t)) return true;
    return false;
  }

  // single-day cues — a single day's eating, regardless of a stray "plan" word.
  // Deliberately excludes any multi-day marker (guarded by isMultiDayAsk first).
  function isSingleDayCue(t) {
    if (isMultiDayAsk(t)) return false;
    // "full <diet?> day" — "full veg day", "full vegan day", "a full day"
    if (/\bfull\s+(?:[a-z]+\s+){0,2}day\b/.test(t)) return true;
    // "a/one day" framing — "a full day", "one day", "1 day", "a day's"
    if (/\b(?:a|one|1)\s+(?:[a-z]+\s+){0,2}day\b/.test(t) && !/\b(?:each|every|per)\s+day\b/.test(t)) return true;
    // "today" / "for today"
    if (/\btoday\b/.test(t)) return true;
    // "<n> calorie day" — "1600 calorie day", "1700 cal day"
    if (/\b\d{3,5}\s*(?:k?cal|calorie|calories)\s+(?:[a-z]+\s+){0,2}day\b/.test(t)) return true;
    return false;
  }

  function kcalOf(r) {
    var k = r && r.nutrition && r.nutrition.kcal;
    var v = num(k);
    return isFinite(v) ? v : 0;
  }

  // candidates that are genuinely eligible MEALS of this slot's type
  function poolForMeal(pool, meal) {
    var matched = [];
    for (var i = 0; i < pool.length; i++) {
      if (isMealEligible(pool[i], meal)) matched.push(pool[i]);
    }
    return matched;
  }

  // softer pool used only when the strict eligible pool is empty: drop the kcal
  // floor/ceiling but KEEP the no-drink / no-shot-kadha-broth exclusions and the
  // category match, so we never put a drink/shot into a meal slot.
  function relaxedPoolForMeal(pool, meal) {
    var matched = [];
    for (var i = 0; i < pool.length; i++) {
      var r = pool[i];
      if (!r) continue;
      var cat = lc(r.category);
      if (isBeverage(r)) continue; // never a drink OR smoothie
      var blob = lc(r.title) + " " + (isArray(r.tags) ? r.tags.map(lc).join(" ") : "");
      if (DAYPLAN_EXCLUDE_RE.test(blob)) continue;
      var okCat = false;
      for (var c = 0; c < meal.cats.length; c++) { if (cat === meal.cats[c]) { okCat = true; break; } }
      if (okCat) matched.push(r);
    }
    return matched;
  }

  // Breakfast-only last-resort: smoothie-category candidates (still no "drink").
  // Used only after real breakfast food + relaxed food pools all come up empty.
  function smoothieFallbackPool(pool) {
    var matched = [];
    for (var i = 0; i < pool.length; i++) {
      var r = pool[i];
      if (!r) continue;
      if (lc(r.category) !== "smoothie") continue;
      var blob = lc(r.title) + " " + (isArray(r.tags) ? r.tags.map(lc).join(" ") : "");
      if (DAYPLAN_EXCLUDE_RE.test(blob)) continue;
      matched.push(r);
    }
    return matched;
  }

  // pick the unused candidate whose kcal is CLOSEST to target; if `cap` is given,
  // prefer ones that keep the running total under cap, but never go empty.
  function pickClosest(cands, used, target, cap, runningTotal) {
    var best = null, bestScore = Infinity;
    var bestUnder = null, bestUnderScore = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var r = cands[i];
      if (used[r.id]) continue;
      var kc = kcalOf(r);
      var score = Math.abs(kc - target);
      // global best (closest to target regardless of cap)
      if (score < bestScore) { bestScore = score; best = r; }
      // best that still fits under the cap
      if (cap == null || (runningTotal + kc) <= cap) {
        if (score < bestUnderScore) { bestUnderScore = score; bestUnder = r; }
      }
    }
    return { underCap: bestUnder, any: best };
  }

  function buildDayPlan(engine, hasEngine, constraints, cap) {
    var pool = [];
    if (hasEngine) pool = safeRecipes(engine.all && engine.all());
    pool = applyDietFilter(pool, constraints);
    // deterministic order (stable tie-break by title then id)
    pool = pool.slice().sort(function (a, b) {
      var at = lc(a.title), bt = lc(b.title);
      if (at < bt) return -1; if (at > bt) return 1;
      return lc(a.id) < lc(b.id) ? -1 : 1;
    });

    var used = {};
    var meals = [];
    var notes = [];
    var total = 0;

    for (var m = 0; m < DAYPLAN_MEALS.length; m++) {
      var spec = DAYPLAN_MEALS[m];
      // per-meal kcal target: fraction of the cap, else the slot default
      var target = (cap != null) ? Math.round(cap * spec.frac) : spec.def;

      var cand = poolForMeal(pool, spec);
      var pick = null;

      if (cand.length) {
        var res = pickClosest(cand, used, target, cap, total);
        // prefer the closest one that keeps us under the cap; if none fits, take
        // the overall closest (we'll note it if it pushes over).
        if (res.underCap) {
          pick = res.underCap;
        } else if (res.any) {
          pick = res.any;
          if (cap != null) notes.push(spec.label + " nudges the total a touch over the cap.");
        }
      }

      // relax 1: same exclusions, drop the kcal window, still correct category
      if (!pick) {
        var soft = relaxedPoolForMeal(pool, spec);
        if (soft.length) {
          var res2 = pickClosest(soft, used, target, cap, total);
          pick = res2.underCap || res2.any;
          if (pick) notes.push("Relaxed kcal range for " + spec.label + ".");
        }
      }

      // relax 1b: BREAKFAST ONLY last-resort — allow a smoothie (never a drink)
      // when no real breakfast food is available. Real food is always preferred
      // above; this only fires after the strict + relaxed food pools came up empty.
      if (!pick && isArray(spec.fallbackCats) && spec.fallbackCats.indexOf("smoothie") !== -1) {
        var sm = smoothieFallbackPool(pool);
        if (sm.length) {
          var res3 = pickClosest(sm, used, target, cap, total);
          pick = res3.underCap || res3.any;
          if (pick) notes.push("Used a smoothie for " + spec.label + " (no real breakfast dish left).");
        }
      }

      // relax 2: any unused non-beverage, non-shot/kadha/broth recipe (never empty).
      // Beverages (drink AND smoothie) are excluded here so non-breakfast slots
      // can never fall back to a smoothie.
      if (!pick) {
        for (var k = 0; k < pool.length; k++) {
          var pr = pool[k];
          if (used[pr.id]) continue;
          if (isBeverage(pr)) continue;
          var pblob = lc(pr.title) + " " + (isArray(pr.tags) ? pr.tags.map(lc).join(" ") : "");
          if (DAYPLAN_EXCLUDE_RE.test(pblob)) continue;
          pick = pr; notes.push("Relaxed category match for " + spec.label + "."); break;
        }
      }
      if (!pick) continue;

      used[pick.id] = true;
      var kc = kcalOf(pick);
      total += kc;
      meals.push({ label: spec.label, recipe: pick, kcal: kc });
    }

    return {
      meals: meals,
      totalKcal: total,
      cap: (cap != null ? cap : null),
      notes: notes.join(" ")
    };
  }

  // ---- leads for the new kinds ---------------------------------------------
  function leadForSuggest(kw, n) {
    var pretty = kw ? kw.split(/\s+/).map(titleCaseWord).join(" ") : "";
    if (!n) return "Hmm, no exact " + (kw || "matching") + " dishes — here's the closest I could find.";
    return "Here are some " + (kw ? kw : "tasty") + " dishes 🍲";
  }

  function leadForThemed(theme, n, letter) {
    if (theme === "weekday-initial") {
      if (!n) return "I couldn't build a 7-day set right now — try again once the library is loaded.";
      return "One dish a day — each starting with that day's letter 📆";
    }
    if (!n) return "No dishes start with " + (letter || "that letter") + " yet.";
    return "Dishes starting with " + (letter || "") + " 🍽️";
  }

  function leadForDayPlan(dp) {
    if (!dp.meals || !dp.meals.length) return "I couldn't assemble a full day right now.";
    var capBit = dp.cap != null ? (" under " + dp.cap + " kcal") : "";
    return "Your full day of meals" + capBit + " — " + dp.totalKcal + " kcal total 🍳";
  }

  // ---- food fallbacks & progressive relaxation ------------------------------
  // top healthy NON-drink recipes — used as a last resort so a food/recipe ask
  // never dead-ends. Prefers higher protein + reasonable kcal, stable order.
  function topHealthyFood(engine, hasEngine, constraints, n) {
    var pool = [];
    if (hasEngine) pool = safeRecipes(engine.all && engine.all());
    pool = excludeDrinks(pool);
    pool = applyDietFilter(pool, constraints);
    pool = excludeDrinks(pool); // applyDietFilter may fall back to full pool
    pool = pool.slice().sort(function (a, b) {
      var ap = num(a.nutrition && a.nutrition.protein); ap = isFinite(ap) ? ap : 0;
      var bp = num(b.nutrition && b.nutrition.protein); bp = isFinite(bp) ? bp : 0;
      if (bp !== ap) return bp - ap;
      var at = lc(a.title), bt = lc(b.title);
      if (at < bt) return -1; if (at > bt) return 1; return 0;
    });
    return clampList(pool, (n > 0 ? n : 8));
  }

  // ---- VAGUE ASKS (Fix 4) ---------------------------------------------------
  // "i'm hungry", "surprise me", "bored of dal", "something tasty",
  // "what should i eat", "feeling hungry", "anything". These must NEVER dead-end
  // — they route to kind "filter" with top HEALTHY, varied picks.
  function isVagueAsk(t) {
    if (/\b(?:i'?m|i am|feeling|im)\s+hungry\b/.test(t)) return true;
    if (/\bhungry\b/.test(t)) return true;
    if (/\bsurprise me\b/.test(t)) return true;
    if (/\bbored of\b/.test(t) || /\bbored\b/.test(t)) return true;
    if (/\bsomething\s+(?:tasty|good|nice|yummy|to eat)\b/.test(t)) return true;
    if (/\bwhat\s+should\s+i\s+eat\b/.test(t)) return true;
    if (/\bwhat\s+(?:do|can)\s+i\s+(?:eat|cook|make)\b/.test(t) && !isReverseAsk(t)) return true;
    if (/\bwhat'?s\s+for\s+(?:dinner|lunch|breakfast|food)\b/.test(t)) return true;
    if (/^\s*anything\s*[?.!]?\s*$/.test(t)) return true;
    if (/\banything\s+(?:works|is fine|good|tasty)\b/.test(t)) return true;
    return false;
  }

  // top HEALTHY varied picks — like topHealthyFood but force scientific-healthy
  // and lightly diversify across categories so a vague ask isn't all curries.
  function topHealthyVaried(engine, hasEngine, constraints, n) {
    var base = topHealthyFood(engine, hasEngine, constraints, (n > 0 ? n * 3 : 24));
    // keep only scientifically-healthy items (graceful fallback inside keepHealthy)
    base = keepHealthy(base);
    // diversify across categories: round-robin by category for variety
    var byCat = {};
    var order = [];
    for (var i = 0; i < base.length; i++) {
      var cat = lc(base[i].category) || "other";
      if (!byCat[cat]) { byCat[cat] = []; order.push(cat); }
      byCat[cat].push(base[i]);
    }
    var out = [];
    var want = (n > 0 ? n : 8);
    var added = true;
    while (out.length < want && added) {
      added = false;
      for (var c = 0; c < order.length && out.length < want; c++) {
        var bucket = byCat[order[c]];
        if (bucket && bucket.length) { out.push(bucket.shift()); added = true; }
      }
    }
    return clampList(out, want);
  }

  // keep only recipes whose tags overlap any of the wanted tags (OR match);
  // if no wanted tags, returns the list unchanged.
  function filterByAnyTag(recipes, wantTags) {
    if (!isArray(wantTags) || !wantTags.length) return safeRecipes(recipes);
    var src = safeRecipes(recipes);
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var tags = isArray(src[i].tags) ? src[i].tags : [];
      var hit = false;
      for (var j = 0; j < wantTags.length; j++) {
        if (tags.indexOf(wantTags[j]) !== -1) { hit = true; break; }
      }
      if (hit) out.push(src[i]);
    }
    return out;
  }

  // run engine.filter with progressive relaxation; always drink-free; never empty
  // for a food ask. Drops the narrowest constraint (cuisine→category→maxTime→tag)
  // until we have >=3 results, then falls back to top healthy food.
  function filterWithRelaxation(engine, hasEngine, c, wantN) {
    var notes = "";
    if (!hasEngine) return { recipes: [], notes: notes };

    function run(opts) {
      var res = safeRecipes(engine.filter && engine.filter(opts));
      return excludeDrinks(res); // food route: never drinks
    }

    var base = constraintsToFilterOpts(c);
    var res = run(base);
    // mealType applied as a tag; if it nuked everything retry without it
    if (res.length < 3 && base.tag) {
      var o = {}; for (var k in base) { if (k !== "tag") o[k] = base[k]; }
      res = run(o);
    }
    // apply fuzzy tag preference as a soft narrowing (only if it keeps >=3)
    if (c.tags && c.tags.length) {
      var tagged = filterByAnyTag(res, c.tags);
      if (tagged.length >= 3) res = tagged;
    }

    // progressive relaxation: drop narrowest constraint until >=3 results
    if (res.length < 3) {
      var order = ["cuisine", "category", "maxTime", "tag"];
      var opts2 = constraintsToFilterOpts(c);
      for (var d = 0; d < order.length && res.length < 3; d++) {
        if (opts2[order[d]] != null) {
          delete opts2[order[d]];
          res = run(opts2);
          notes = "Couldn't find exact matches — here are close picks.";
        }
      }
    }
    // still thin? drop diet-y narrow keys too, keep kcal/protein only
    if (res.length < 3) {
      var opts3 = {};
      if (c.maxKcal != null) opts3.maxKcal = c.maxKcal;
      if (c.minProtein != null) opts3.minProtein = c.minProtein;
      res = run(opts3);
      if (res.length) notes = "Couldn't find exact matches — here are close picks.";
    }
    // absolute last resort: top healthy food
    if (res.length < 1) {
      res = topHealthyFood(engine, hasEngine, c, wantN);
      notes = "Couldn't find exact matches — here are close picks.";
    }

    if (c.withTwist) res = preferTwist(res);
    return { recipes: clampList(res, wantN), notes: notes };
  }

  // ---- ROUTE ----------------------------------------------------------------
  function route(text) {
    var raw = str(text);
    var t = lc(raw).trim();
    if (!t) return { kind: "none" };

    var engine = getEngine();
    var hasEngine = !!(engine && typeof engine.filter === "function");
    var action = detectAction(t);
    var constraints = parseConstraints(t);

    // 0a) DAYPLAN — "all four meals of the day", "breakfast lunch snack dinner",
    //     optional "under 3200 calories". Checked before PLAN so it wins.
    if (isDayPlanAsk(t)) {
      var capDP = constraints.maxKcal;
      if (capDP == null) {
        // dayplan-specific cap capture (e.g. "under 3200 calories")
        var cm = t.match(/(?:under|below|less than|max(?:imum)?|<=?|upto|up to)\s*(\d{3,5})\s*(?:k?cal|calorie|calories)?/i);
        if (cm) { var cv = num(cm[1]); if (isFinite(cv) && cv >= 800) capDP = cv; }
      }
      var dp = buildDayPlan(engine, hasEngine, constraints, (capDP != null ? capDP : null));
      var dpOut = {
        kind: "dayplan",
        meals: dp.meals,
        totalKcal: dp.totalKcal,
        cap: dp.cap,
        constraints: constraints,
        notes: dp.notes,
        lead: leadForDayPlan(dp)
      };
      if (action) dpOut.action = action;
      return dpOut;
    }

    // 0b) THEMED — weekday-initial ("one per day, each starting with that day's
    //     letter") or generic "dishes starting with <X>".
    if (isWeekdayInitialAsk(t)) {
      var wt = buildWeekdayThemed(engine, hasEngine, constraints);
      var wtOut = {
        kind: "themed",
        theme: "weekday-initial",
        recipes: wt.recipes,
        notes: wt.notes,
        lead: leadForThemed("weekday-initial", wt.recipes.length)
      };
      if (action) wtOut.action = action;
      return wtOut;
    }
    var swLetter = detectStartsWithLetter(t);
    if (swLetter) {
      var swRecipes = buildStartsWithThemed(engine, hasEngine, swLetter, constraints);
      var swOut = {
        kind: "themed",
        theme: "starts-with",
        letter: swLetter,
        recipes: swRecipes,
        notes: "",
        lead: leadForThemed("starts-with", swRecipes.length, swLetter)
      };
      if (action) swOut.action = action;
      return swOut;
    }

    // 1) PLAN — highest priority multi-day asks; defer to host/CookBhaiya.
    if (isPlanAsk(t)) {
      return { kind: "plan" };
    }

    // 1a) DRINK INTENT (early gate) — any drink ask returns ONLY drinks, and is
    //     checked before reverse/similar/suggest/filter so food routes can safely
    //     assume "never drinks". Net rule: drink query → only drinks.
    if (beverageIntent(t)) {
      var drinkKws = detectDrinkKeywords(t);
      var drinkN = parseCount(t, 8);
      var drinks = buildDrinks(engine, hasEngine, drinkKws, drinkN, constraints);
      var dkOut = {
        kind: "filter",
        constraints: constraints,
        keyword: drinkKws.join(" "),
        drinks: true,
        recipes: drinks,
        lead: drinks.length ? "Here are some drinks 🥤" : "Hmm, no matching drinks in the library yet."
      };
      if (action) dkOut.action = action;
      return dkOut;
    }

    // 2) REVERSE — "what can I cook with X and Y" / "I have X"
    if (isReverseAsk(t)) {
      var have = extractIngredients(t);
      var recipes = [];
      var revNotes = "";
      if (hasEngine && have.length) {
        // food route: never leak drinks
        var all = excludeDrinks(safeRecipes(engine.all && engine.all()));
        recipes = clampList(rankByIngredients(all, have), 6);
      }
      // never dead-end a food ask: fall back to top healthy food
      if (!recipes.length && hasEngine) {
        recipes = topHealthyFood(engine, hasEngine, constraints, 6);
        revNotes = "Couldn't find exact matches — here are close picks.";
      }
      var revOut = {
        kind: "reverse",
        have: have,
        recipes: recipes,
        notes: revNotes,
        lead: leadForReverse(have, recipes.length)
      };
      if (action) revOut.action = action;
      return revOut;
    }

    // 3) SIMILAR — "something like X but lighter" / "alternatives to X"
    if (isSimilarAsk(t)) {
      var baseQ = extractSimilarBaseQuery(t);
      var lighter = /lighter|leaner|lower cal|less cal|healthier|low calorie|low-cal/.test(t);
      var base = null;
      var simRecipes = [];
      if (hasEngine && baseQ) {
        var hits = safeRecipes(engine.search && engine.search(baseQ));
        base = hits.length ? hits[0] : null;
      }
      if (hasEngine && base) {
        var pool = excludeDrinks(safeRecipes(engine.all && engine.all()));
        var baseId = base.id;
        var baseTags = isArray(base.tags) ? base.tags : [];
        var scored = [];
        for (var i = 0; i < pool.length; i++) {
          var r = pool[i];
          if (r.id === baseId) continue;
          var s = 0;
          if (r.cuisine && r.cuisine === base.cuisine) s += 3;
          if (r.category && r.category === base.category) s += 3;
          var rt = isArray(r.tags) ? r.tags : [];
          for (var k = 0; k < rt.length; k++) {
            if (baseTags.indexOf(rt[k]) !== -1) s += 1;
          }
          if (s > 0) scored.push({ r: r, s: s, i: i });
        }
        var baseKcal = base.nutrition && base.nutrition.kcal;
        scored.sort(function (a, b) {
          if (lighter && isFinite(num(baseKcal))) {
            var ak = (a.r.nutrition && a.r.nutrition.kcal);
            var bk = (b.r.nutrition && b.r.nutrition.kcal);
            var aLight = (isFinite(num(ak)) && ak < baseKcal) ? 1 : 0;
            var bLight = (isFinite(num(bk)) && bk < baseKcal) ? 1 : 0;
            if (aLight !== bLight) return bLight - aLight;
          }
          if (b.s !== a.s) return b.s - a.s;
          if (lighter) {
            var ak2 = (a.r.nutrition && a.r.nutrition.kcal);
            var bk2 = (b.r.nutrition && b.r.nutrition.kcal);
            ak2 = isFinite(num(ak2)) ? ak2 : Infinity;
            bk2 = isFinite(num(bk2)) ? bk2 : Infinity;
            if (ak2 !== bk2) return ak2 - bk2;
          }
          return a.i - b.i;
        });
        simRecipes = clampList(excludeDrinks(scored.map(function (x) { return x.r; })), 8);
      }
      // never dead-end a food ask: relax to keyword search on the base query, then
      // to top healthy food. "alternatives to maggi" -> noodles/quick close picks.
      var simNotes = "";
      if (simRecipes.length < 3 && hasEngine) {
        var alt = [];
        if (baseQ) alt = excludeDrinks(safeRecipes(engine.search && engine.search(baseQ)));
        if (alt.length < 3) {
          // map "instead of maggi/noodles" style asks toward quick noodle dishes
          var nd = excludeDrinks(safeRecipes(engine.filter && engine.filter({ category: "noodles" })));
          if (nd.length) alt = alt.concat(nd);
        }
        // de-dup against what we already have + base
        var seenS = {}; if (base) seenS[base.id] = 1;
        for (var si = 0; si < simRecipes.length; si++) seenS[simRecipes[si].id] = 1;
        for (var ai = 0; ai < alt.length && simRecipes.length < 8; ai++) {
          if (!seenS[alt[ai].id]) { seenS[alt[ai].id] = 1; simRecipes.push(alt[ai]); }
        }
        if (simRecipes.length < 1) {
          simRecipes = topHealthyFood(engine, hasEngine, constraints, 8);
        }
        if (simRecipes.length) simNotes = "Couldn't find exact matches — here are close picks.";
      }
      var simOut = {
        kind: "similar",
        base: base,
        recipes: simRecipes,
        notes: simNotes,
        lead: leadForSimilar(base ? base.title : (baseQ || "that dish"), lighter, simRecipes.length)
      };
      if (action) simOut.action = action;
      return simOut;
    }

    // 4) ANSWER — nutrition/info question about a known recipe
    if (isAnswerAsk(t)) {
      var ansRecipe = null;
      if (hasEngine) {
        // strip question framing to get the dish query
        var dishQ = t
          .replace(/how (much|many)\s+\w+(\s+is|\s+are|\s+in)?/i, "")
          .replace(/\b(protein|calories?|kcal|fibre|fiber|fat|carbs?|nutrition)\b/gi, "")
          .replace(/\bin\b|\bof\b|\bthe\b|\bis\b|\bare\b|\bhas\b|\bdoes\b|\bhave\b|\?/gi, " ")
          .replace(/\btell me about\b|\bwhat'?s in\b/gi, " ")
          .trim();
        var found = safeRecipes(engine.search && engine.search(dishQ || raw));
        ansRecipe = found.length ? found[0] : null;
      }
      var reply = answerFor(t, ansRecipe);
      return { kind: "answer", reply: reply, recipe: ansRecipe };
    }

    // 4b) INGREDIENT / KEYWORD SUGGESTIONS — "suggest rajma dishes",
    //     "a couple of avocado dishes", "dishes with paneer", "some tofu recipes".
    //     Returns kind "filter" but matched by ingredient/title/tags. Food route:
    //     never returns drinks.
    var c = parseConstraints(t);
    var suggestKw = detectSuggestKeyword(t);
    // Only treat as a keyword suggestion when the keyword is a real noun (not a
    // bare cuisine/category we already handle, and not empty).
    if (suggestKw && !CUISINE_MAP[suggestKw] && !CATEGORY_MAP[suggestKw]) {
      var wantN = parseCount(t, 8);
      var sRecipes = [];
      var sgNotes = "";
      if (hasEngine) {
        // food route: never leak drinks
        var searched = excludeDrinks(safeRecipes(engine.search && engine.search(suggestKw)));
        var ranked = rankByKeyword(searched, suggestKw);
        if (!ranked.length) {
          // broaden: rank across the whole library
          var allPool = excludeDrinks(safeRecipes(engine.all && engine.all()));
          ranked = rankByKeyword(allPool, suggestKw);
        }
        // also apply any diet constraints the user stated
        ranked = excludeDrinks(applyDietFilter(ranked, c));
        // Fix 6: scientific healthy/tier shaping when the ask implies it.
        ranked = applyHealthShaping(ranked, t);
        sRecipes = clampList(ranked, wantN);
      }
      // never dead-end: fall back to top healthy food
      if (!sRecipes.length && hasEngine) {
        sRecipes = topHealthyFood(engine, hasEngine, c, wantN);
        sgNotes = "Couldn't find exact matches — here are close picks.";
      }
      var sgOut = {
        kind: "filter",
        constraints: c,
        keyword: suggestKw,
        recipes: sRecipes,
        notes: sgNotes,
        lead: leadForSuggest(suggestKw, sRecipes.length)
      };
      if (action) sgOut.action = action;
      return sgOut;
    }

    // 5) FILTER — constraint queries. Food route: never drinks; progressive
    //     relaxation guarantees a non-empty, on-intent result.
    if (looksLikeFilter(t, c)) {
      var fr = filterWithRelaxation(engine, hasEngine, c, 8);
      // Fix 6: scientific healthy/tier shaping (food only; relaxes gracefully).
      var fShaped = clampList(applyHealthShaping(fr.recipes, t), 8);
      var fOut = {
        kind: "filter",
        constraints: c,
        recipes: fShaped,
        notes: fr.notes,
        lead: leadForFilter(c, fShaped.length)
      };
      if (action) fOut.action = action;
      return fOut;
    }

    // 5b) VAGUE ASK (Fix 4) — "i'm hungry", "surprise me", "bored of dal",
    //     "something tasty", "anything". Never dead-end: return top HEALTHY,
    //     varied picks with a friendly lead. (Checked after the specific routes
    //     so genuine constraint/ingredient asks still win.)
    if (isVagueAsk(t)) {
      var vagueN = parseCount(t, 8);
      var vagueRecipes = hasEngine ? topHealthyVaried(engine, hasEngine, c, vagueN) : [];
      var vagueOut = {
        kind: "filter",
        constraints: c,
        recipes: vagueRecipes,
        notes: "",
        lead: vagueRecipes.length
          ? "Not sure what you're craving — here are some tasty, healthy picks to get you started 🍽️"
          : "Tell me a craving or an ingredient and I'll find something tasty."
      };
      if (action) vagueOut.action = action;
      return vagueOut;
    }

    // 6) FOOD FALLBACK — a clearly food/recipe ask that matched no specific route.
    //     Never return kind:"none" for a food/recipe ask: give top healthy food.
    if (looksLikeFoodAsk(t)) {
      var ffRecipes = hasEngine ? topHealthyFood(engine, hasEngine, c, 24) : [];
      ffRecipes = clampList(applyHealthShaping(ffRecipes, t), 8);
      var ffOut = {
        kind: "filter",
        constraints: c,
        recipes: ffRecipes,
        notes: "Couldn't find exact matches — here are close picks.",
        lead: leadForFilter(c, ffRecipes.length)
      };
      if (action) ffOut.action = action;
      return ffOut;
    }

    // else: not our job (simple dish lookups handled elsewhere)
    return { kind: "none" };
  }

  // is this clearly a food / recipe ask (so we must never dead-end with "none")?
  function looksLikeFoodAsk(t) {
    if (beverageIntent(t)) return false; // beverages handled by their own gate
    return /\b(meal|meals|dish|dishes|recipe|recipes|food|eat|eating|dinner|lunch|breakfast|snack|snacks|tiffin|cook|cooking|curry|gravy|sabzi|sabji|roti|rice|dal|paneer|chicken|egg|eggs|veg|protein|healthy)\b/.test(t);
  }

  // ---- answer composer ------------------------------------------------------
  function answerFor(t, recipe) {
    if (!recipe) {
      return "I couldn't find that dish in the library — try the exact name and I'll pull its nutrition.";
    }
    var n = recipe.nutrition || {};
    var title = recipe.title || "this dish";
    if (/protein/.test(t) && n.protein != null) {
      return title + " has about " + n.protein + "g protein per serving.";
    }
    if (/(calorie|kcal|cal\b)/.test(t) && n.kcal != null) {
      return title + " is about " + n.kcal + " kcal per serving.";
    }
    if (/(fibre|fiber)/.test(t) && n.fibre != null) {
      return title + " has about " + n.fibre + "g fibre per serving.";
    }
    if (/fat/.test(t) && n.fat != null) {
      return title + " has about " + n.fat + "g fat per serving.";
    }
    if (/carb/.test(t) && n.carbs != null) {
      return title + " has about " + n.carbs + "g carbs per serving.";
    }
    if (/(vegan)/.test(t)) {
      return title + " is " + (recipe.diet && recipe.diet.vegan ? "vegan-friendly." : "not vegan.");
    }
    if (/(gluten)/.test(t)) {
      return title + " is " + (recipe.diet && recipe.diet.glutenFree ? "gluten-free." : "not gluten-free.");
    }
    // generic nutrition summary
    var parts = [];
    if (n.kcal != null) parts.push(n.kcal + " kcal");
    if (n.protein != null) parts.push(n.protein + "g protein");
    if (n.fibre != null) parts.push(n.fibre + "g fibre");
    if (parts.length) return title + " (per serving): " + parts.join(", ") + ".";
    return "Here's " + title + " from the library.";
  }

  // ---- canUseLLM ------------------------------------------------------------
  function canUseLLM() {
    try {
      var ai = getLLM();
      return !!(ai && typeof ai.available === "function" && ai.available());
    } catch (e) { return false; }
  }

  // ---- HANDLE (convenience) -------------------------------------------------
  function handle(text) {
    var r;
    try { r = route(text); } catch (e) { r = { kind: "none" }; }
    if (!r || typeof r !== "object") r = { kind: "none" };

    // PLAN: hand off to CookBhaiya if present.
    if (r.kind === "plan") {
      var planner = getPlanner();
      if (planner && typeof planner.handle === "function") {
        try {
          var res = planner.handle(text);
          if (res && typeof res === "object") {
            return {
              kind: "plan",
              reply: str(res.reply) || "Here's your meal plan.",
              recipes: collectPlanRecipes(res.plan),
              plan: res.plan || null
            };
          }
        } catch (e) { /* fall through to generic plan reply */ }
      }
      return {
        kind: "plan",
        reply: "I can build a multi-day meal plan - the planner will take it from here.",
        recipes: [],
        plan: null
      };
    }

    // OPTIONAL LLM HOOK:
    // A host with an LLM available could, AFTER the deterministic route() above,
    // await a rerank/summary to polish results, e.g.:
    //
    //   if (canUseLLM()) {
    //     const llm = getLLM();
    //     // r.recipes = await llm.rerank(text, r.recipes);   // reorder for relevance
    //     // r.reply   = await llm.summary(text, r.recipes);  // friendlier one-liner
    //   }
    //
    // The module stays fully functional offline; the hook is purely additive and
    // is intentionally NOT awaited here so handle() remains synchronous + no-throw.

    // DAYPLAN: warm summary over the four meals.
    if (r.kind === "dayplan") {
      var dpReply = str(r.lead || "Here's your full day of meals.");
      if (r.notes) dpReply += " " + r.notes;
      var dpRet = {
        kind: "dayplan",
        reply: dpReply,
        meals: isArray(r.meals) ? r.meals : [],
        recipes: collectMealRecipes(r.meals),
        totalKcal: r.totalKcal,
        cap: r.cap,
        constraints: r.constraints,
        notes: str(r.notes || ""),
        plan: null
      };
      if (r.action) dpRet.action = r.action;
      return dpRet;
    }

    // THEMED: warm summary; recipes already annotated (dayLabel/letter) when weekday.
    if (r.kind === "themed") {
      var thReply = str(r.lead || "Here's a themed set for you.");
      if (r.notes) thReply += " " + r.notes;
      var thRet = {
        kind: "themed",
        theme: r.theme,
        letter: r.letter,
        reply: thReply,
        recipes: safeRecipes(r.recipes),
        notes: str(r.notes || ""),
        plan: null
      };
      if (r.action) thRet.action = r.action;
      return thRet;
    }

    var outRet = {
      kind: r.kind,
      reply: str(r.lead || r.reply || ""),
      recipes: safeRecipes(r.recipes),
      // carry through useful extras without breaking the shape
      base: r.base,
      have: r.have,
      recipe: r.recipe,
      keyword: r.keyword,
      constraints: r.constraints,
      notes: str(r.notes || ""),
      plan: null
    };
    if (r.action) outRet.action = r.action;
    return outRet;
  }

  function collectMealRecipes(meals) {
    var out = [];
    if (isArray(meals)) {
      for (var i = 0; i < meals.length; i++) {
        if (meals[i] && meals[i].recipe) out.push(meals[i].recipe);
      }
    }
    return out;
  }

  function collectPlanRecipes(plan) {
    var out = [];
    if (plan && isArray(plan.days)) {
      for (var i = 0; i < plan.days.length; i++) {
        var d = plan.days[i];
        if (d && d.recipe) out.push(d.recipe);
      }
    }
    return out;
  }

  // ---- public API -----------------------------------------------------------
  return {
    route: route,
    handle: handle,
    canUseLLM: canUseLLM,
    // exposed for hosts/tests that want the raw constraint parser:
    parseConstraints: parseConstraints
  };
});
