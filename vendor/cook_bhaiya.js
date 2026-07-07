/* KhanaPro "Cook Bhaiya" — natural-language meal planner.
 * Exposes window.CookBhaiya (browser) + module.exports (Node).
 * Depends ONLY on the Engine API: window.KhanaProKB.
 * In Node, the engine is loaded via ./kb_engine.js (try/catch — never throw).
 * Conforms to kb/KB_SPEC.md "Planner API" section.
 */
;(function (root) {
  "use strict";

  // ---- Resolve the engine -------------------------------------------------
  // Prefer an already-present global (browser or a test-injected stub).
  // Otherwise, in Node, try to require the sibling engine. Never throw.
  function getKB() {
    if (root && root.KhanaProKB) return root.KhanaProKB;
    if (typeof window !== "undefined" && window.KhanaProKB) return window.KhanaProKB;
    if (typeof globalThis !== "undefined" && globalThis.KhanaProKB) return globalThis.KhanaProKB;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        var eng = require("./kb_engine.js");
        if (eng) return eng;
      } catch (e) { /* engine not available yet — fall through */ }
    }
    return null;
  }

  // ---- Small helpers ------------------------------------------------------
  function num(n, dflt) { n = Number(n); return isFinite(n) ? n : dflt; }
  var dflt; // noop placeholder to keep linters calm
  function toInt(n, d) { n = parseInt(n, 10); return isFinite(n) ? n : d; }

  var WORD_NUM = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14
  };

  var CUISINE_MAP = {
    "north indian": "North Indian", "north-indian": "North Indian",
    "punjabi": "North Indian",
    "south indian": "South Indian", "south-indian": "South Indian",
    "indo-chinese": "Indo-Chinese", "indo chinese": "Indo-Chinese", "chinese": "Indo-Chinese",
    "continental": "Continental",
    "mediterranean": "Mediterranean", "med": "Mediterranean",
    "pan-asian": "Pan-Asian", "pan asian": "Pan-Asian", "asian": "Pan-Asian",
    "thai": "Pan-Asian", "japanese": "Pan-Asian",
    "healthy": "Healthy",
    "fusion": "Fusion"
  };

  // category synonyms -> canonical KB category
  var CATEGORY_MAP = {
    "high-protein": "high-protein", "high protein": "high-protein",
    "salad": "salad", "salads": "salad",
    "noodle": "noodles", "noodles": "noodles",
    "bowl": "bowl", "bowls": "bowl",
    "curry": "curry", "curries": "curry",
    "soup": "soup", "soups": "soup",
    "breakfast": "breakfast",
    "snack": "snack", "snacks": "snack",
    "grill": "grill", "grilled": "grill", "grills": "grill",
    "smoothie": "smoothie", "smoothies": "smoothie", "shake": "smoothie",
    "wrap": "wrap", "wraps": "wrap", "roll": "wrap", "rolls": "wrap",
    "dessert": "healthy-dessert", "desserts": "healthy-dessert",
    "healthy-dessert": "healthy-dessert", "sweet": "healthy-dessert"
  };

  var MEALTYPES = ["snack", "breakfast", "lunch", "dinner"];

  // ---- parse(text) --------------------------------------------------------
  function parse(text) {
    var t = String(text == null ? "" : text).toLowerCase();

    // ---- days (default 7) ----
    var days = 7;
    // explicit "for 5 days", "5-day", "5 day"
    var mDay = t.match(/(\d+)\s*[- ]?\s*days?\b/);
    if (mDay) {
      days = toInt(mDay[1], 7);
    } else {
      // word numbers: "next seven days", "five day"
      var mWord = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen)\b\s*[- ]?\s*days?\b/);
      if (mWord) {
        days = WORD_NUM[mWord[1]] || 7;
      } else if (/\b(fortnight|two\s+weeks)\b/.test(t)) {
        days = 14;
      } else if (/\bweeks?\b/.test(t) || /\bweekly\b/.test(t)) {
        days = 7;
      }
    }
    if (!isFinite(days) || days < 1) days = 7;
    if (days > 30) days = 30;

    // ---- calorie cap (per DAY) & per-meal kcal ----
    var calorieCap = null;
    var perMealKcal = null;

    // per-meal first: "under 400 cal each", "max 350 calories per meal/dish/snack/recipe"
    var mPerMeal = t.match(/(?:under|below|less than|max(?:imum)?|upto|up to|<=?)\s*(\d{2,4})\s*(?:k?cal(?:orie)?s?)?\s*(?:each|per\s*(?:meal|dish|recipe|snack|serving|item))/);
    if (!mPerMeal) {
      mPerMeal = t.match(/(\d{2,4})\s*(?:k?cal(?:orie)?s?)\s*(?:each|per\s*(?:meal|dish|recipe|snack|serving|item))/);
    }
    if (mPerMeal) perMealKcal = toInt(mPerMeal[1], null);

    // per-day / overall cap: "under 3000 calories", "keep calories under 3000",
    // "below 2500 kcal a day", "max 1800 calories per day"
    var mCap = t.match(/(?:under|below|less than|max(?:imum)?|upto|up to|<=?|keep\s+calor(?:ie|ies)?\s+(?:under|below|to))\s*(\d{3,5})\s*(?:k?cal(?:orie)?s?)?/);
    if (!mCap) {
      mCap = t.match(/(?:calor(?:ie|ies)?|kcal)\s*(?:under|below|less than|<=?|to)\s*(\d{3,5})/);
    }
    if (mCap) {
      var capVal = toInt(mCap[1], null);
      // If this number was actually the per-meal value, don't double-count it.
      if (capVal != null && capVal !== perMealKcal) calorieCap = capVal;
    }

    // ---- diet flags ----
    var vegan = /\bvegan\b/.test(t);
    // "veg" but not "vegan"; also "vegetarian"
    var veg = vegan || /\bveg\b/.test(t) || /\bvegetarian\b/.test(t);
    // "non-veg" / "nonveg" explicitly turns veg off (unless vegan stated)
    if (/\bnon[\s-]?veg\b/.test(t) && !vegan) veg = false;
    var jain = /\bjain\b/.test(t);
    var glutenFree = /\bgluten[\s-]?free\b/.test(t) || /\bgf\b/.test(t) || /\bno\s+gluten\b/.test(t);
    var eggless = /\beggless\b/.test(t) || /\begg[\s-]?free\b/.test(t) || /\bno\s+egg\b/.test(t);

    // ---- speed / protein ----
    var quick = /\bquick\b/.test(t) || /\bfast\b/.test(t) || /\beasy\b/.test(t) ||
                /\b\d+\s*[- ]?min(?:ute)?s?\b/.test(t) || /\bunder\s+\d+\s*min/.test(t) ||
                /\bno[\s-]?cook\b/.test(t);
    var highProtein = /\bhigh[\s-]?protein\b/.test(t) || /\bprotein[\s-]?rich\b/.test(t) ||
                      /\bmore\s+protein\b/.test(t) || /\bhigh\s+in\s+protein\b/.test(t);

    // ---- meal type ----
    var mealType = null;
    for (var i = 0; i < MEALTYPES.length; i++) {
      var mt = MEALTYPES[i];
      // match "snack"/"snacks", "breakfast", etc.
      if (new RegExp("\\b" + mt + "s?\\b").test(t)) { mealType = mt; break; }
    }
    // "brunch" -> breakfast-ish; "tea time" -> snack
    if (!mealType) {
      if (/\bbrunch\b/.test(t)) mealType = "breakfast";
      else if (/\btea[\s-]?time\b/.test(t) || /\bevening\b/.test(t) && /\bsnack/.test(t)) mealType = "snack";
    }

    // ---- cuisines ----
    var cuisines = [];
    Object.keys(CUISINE_MAP).forEach(function (k) {
      if (new RegExp("\\b" + k.replace(/[-\s]/g, "[\\s-]") + "\\b").test(t)) {
        var canon = CUISINE_MAP[k];
        if (cuisines.indexOf(canon) === -1) cuisines.push(canon);
      }
    });

    // ---- categories ----
    var categories = [];
    Object.keys(CATEGORY_MAP).forEach(function (k) {
      if (new RegExp("\\b" + k.replace(/[-\s]/g, "[\\s-]") + "\\b").test(t)) {
        var canon = CATEGORY_MAP[k];
        if (categories.indexOf(canon) === -1) categories.push(canon);
      }
    });
    // If the mealType is also a category (snack/breakfast), make sure it's present.
    if (mealType && (mealType === "snack" || mealType === "breakfast")) {
      if (categories.indexOf(mealType) === -1) categories.push(mealType);
    }

    // ---- wants mix / variety ----
    var wantsMix = /\bmix\b/.test(t) || /\bmixed\b/.test(t) || /\bvariety\b/.test(t) ||
                   /\bvaried\b/.test(t) || /\bdifferent\b/.test(t) || /\bassorted\b/.test(t) ||
                   /\brange\s+of\b/.test(t) || /\bvegetables?\s+and\b/.test(t) ||
                   /\bvariation\b/.test(t);

    return {
      days: Number(days),
      calorieCap: calorieCap == null ? null : Number(calorieCap),
      perMealKcal: perMealKcal == null ? null : Number(perMealKcal),
      veg: !!veg,
      vegan: !!vegan,
      jain: !!jain,
      glutenFree: !!glutenFree,
      eggless: !!eggless,
      quick: !!quick,
      highProtein: !!highProtein,
      mealType: mealType,
      cuisines: cuisines,
      categories: categories,
      wantsMix: !!wantsMix
    };
  }

  // ---- internal: build a filter opts object for the engine ----------------
  function buildFilter(opts, overrides) {
    var f = {};
    if (opts.veg) f.veg = true;
    if (opts.vegan) f.vegan = true;
    if (opts.jain) f.jain = true;
    if (opts.glutenFree) f.glutenFree = true;
    if (opts.eggless) f.eggless = true;
    if (opts.quick) f.tag = "quick";
    if (opts.highProtein) f.minProtein = 18; // protein-forward threshold
    if (opts.perMealKcal) f.maxKcal = opts.perMealKcal;
    else if (opts.calorieCap) f.maxKcal = opts.calorieCap; // safety: no single dish over the day cap
    overrides = overrides || {};
    Object.keys(overrides).forEach(function (k) {
      if (overrides[k] === undefined) delete f[k];
      else f[k] = overrides[k];
    });
    return f;
  }

  // ---- internal: run engine filter, no-throw ------------------------------
  function safeFilter(KB, f) {
    try {
      var r = KB.filter(f);
      return Array.isArray(r) ? r.slice() : [];
    } catch (e) { return []; }
  }

  function dishKcal(recipe) {
    if (!recipe || !recipe.nutrition) return 0;
    return num(recipe.nutrition.kcal, 0);
  }

  function whyFor(recipe, opts) {
    var bits = [];
    if (!recipe) return "";
    var p = recipe.nutrition && num(recipe.nutrition.protein, 0);
    if ((opts && opts.highProtein) || p >= 20) {
      if (p) bits.push(p + "g protein");
      else bits.push("high protein");
    }
    if (recipe.timeMins && (opts && opts.quick || recipe.timeMins <= 15)) {
      bits.push(recipe.timeMins + "-min");
    }
    if (recipe.diet) {
      if (recipe.diet.vegan) bits.push("vegan");
      else if (recipe.diet.veg) bits.push("veg");
    }
    if (recipe.nutrition && num(recipe.nutrition.kcal, 0)) {
      bits.push(num(recipe.nutrition.kcal, 0) + " kcal");
    }
    if (!bits.length && recipe.category) bits.push(recipe.category);
    return bits.slice(0, 3).join(", ");
  }

  // ---- internal: pick the candidate pool with graceful relaxation ---------
  // Returns { pool:Recipe[], notes:String[] }
  function buildPool(KB, opts, needed) {
    var notes = [];
    var f = buildFilter(opts);

    // Layered relaxation. We try the strictest filter, and if we don't have
    // enough distinct dishes, we relax one constraint at a time (recording it),
    // never dead-ending.
    var attempts = [];

    // Base attempt honours mealType/category/cuisine by post-filtering, since
    // the engine filter takes a single cuisine/category/tag. We pass the most
    // specific category we can and post-filter for the rest.
    var primaryCategory = (opts.categories && opts.categories[0]) || opts.mealType || null;
    var primaryCuisine = (opts.cuisines && opts.cuisines[0]) || null;

    function attempt(label, filterOverrides, postFilter) {
      var ff = buildFilter(opts, filterOverrides);
      var pool = safeFilter(KB, ff);
      if (postFilter) pool = pool.filter(postFilter);
      return { label: label, pool: dedupe(pool) };
    }

    function inCats(r) {
      if (!opts.categories || !opts.categories.length) {
        if (opts.mealType) return categoryMatches(r, opts.mealType);
        return true;
      }
      return opts.categories.some(function (c) { return categoryMatches(r, c); });
    }
    function inCuisines(r) {
      if (!opts.cuisines || !opts.cuisines.length) return true;
      return opts.cuisines.indexOf(r.cuisine) !== -1;
    }

    // 1) full: cuisine + category + all flags
    attempts.push(attempt("full", {
      cuisine: primaryCuisine || undefined,
      category: primaryCategory || undefined
    }, function (r) { return inCats(r) && inCuisines(r); }));

    // 2) drop cuisine
    attempts.push(attempt("relaxed-cuisine", {
      cuisine: undefined,
      category: primaryCategory || undefined
    }, function (r) { return inCats(r); }));

    // 3) drop category too
    attempts.push(attempt("relaxed-category", {
      cuisine: undefined,
      category: undefined
    }, null));

    // 4) drop quick
    attempts.push(attempt("relaxed-quick", {
      cuisine: undefined,
      category: undefined,
      tag: undefined
    }, null));

    // 5) drop high-protein threshold
    attempts.push(attempt("relaxed-protein", {
      cuisine: undefined,
      category: undefined,
      tag: undefined,
      minProtein: undefined
    }, null));

    // 6) last resort: only honour hard diet constraints (veg/vegan/jain/gf/eggless)
    attempts.push(attempt("relaxed-kcal", {
      cuisine: undefined,
      category: undefined,
      tag: undefined,
      minProtein: undefined,
      maxKcal: undefined
    }, null));

    // Walk attempts; accumulate until we have `needed` distinct dishes.
    var chosen = attempts[0];
    var relaxFlags = { cuisine: false, category: false, quick: false, protein: false, kcal: false };
    for (var i = 0; i < attempts.length; i++) {
      chosen = attempts[i];
      if (chosen.pool.length >= needed) {
        if (i >= 1 && primaryCuisine) relaxFlags.cuisine = true;
        if (i >= 2 && (primaryCategory)) relaxFlags.category = true;
        if (i >= 3 && opts.quick) relaxFlags.quick = true;
        if (i >= 4 && opts.highProtein) relaxFlags.protein = true;
        if (i >= 5 && (opts.perMealKcal || opts.calorieCap)) relaxFlags.kcal = true;
        break;
      }
    }

    if (relaxFlags.cuisine) notes.push("relaxed cuisine filter to find enough dishes");
    if (relaxFlags.category) notes.push("relaxed category/meal-type filter");
    if (relaxFlags.quick) notes.push("included some non-quick recipes");
    if (relaxFlags.protein) notes.push("eased the high-protein requirement");
    if (relaxFlags.kcal) notes.push("eased the per-dish calorie limit");

    return { pool: chosen.pool, notes: notes };
  }

  function categoryMatches(r, c) {
    if (!r) return false;
    if (r.category === c) return true;
    // meal types may live in tags rather than category
    if (r.tags && r.tags.indexOf && r.tags.indexOf(c) !== -1) return true;
    return false;
  }

  function dedupe(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!r || !r.id) continue;
      if (seen[r.id]) continue;
      seen[r.id] = 1;
      out.push(r);
    }
    return out;
  }

  // ---- plan(opts) ---------------------------------------------------------
  function plan(opts) {
    opts = opts || {};
    // Allow callers to pass either a parsed object or raw text.
    if (typeof opts === "string") opts = parse(opts);
    // Normalise any missing fields via parse defaults.
    var norm = {
      days: num(opts.days, 7),
      calorieCap: opts.calorieCap == null ? null : num(opts.calorieCap, null),
      perMealKcal: opts.perMealKcal == null ? null : num(opts.perMealKcal, null),
      veg: !!opts.veg, vegan: !!opts.vegan, jain: !!opts.jain,
      glutenFree: !!opts.glutenFree, eggless: !!opts.eggless,
      quick: !!opts.quick, highProtein: !!opts.highProtein,
      mealType: opts.mealType || null,
      cuisines: opts.cuisines || [],
      categories: opts.categories || [],
      wantsMix: !!opts.wantsMix
    };
    var days = Math.max(1, Math.min(30, Math.round(norm.days || 7)));

    var KB = getKB();
    var notes = [];

    if (!KB || typeof KB.filter !== "function") {
      return {
        days: [],
        totalKcal: 0,
        perDayAvgKcal: 0,
        notes: "Recipe library is not loaded yet — try again once recipes are available.",
        constraints: norm,
        ok: false
      };
    }

    var built = buildPool(KB, norm, days);
    var pool = built.pool;
    notes = notes.concat(built.notes);

    if (!pool.length) {
      return {
        days: [],
        totalKcal: 0,
        perDayAvgKcal: 0,
        notes: "No recipes matched even after relaxing every filter.",
        constraints: norm,
        ok: false
      };
    }

    // ---- ordering for variety ----
    var ordered = orderForVariety(pool, norm);

    // ---- per-day calorie cap handling ----
    // Each day is one dish (single recipe per day, per the plan schema).
    // So a per-day cap effectively means: this dish's kcal <= calorieCap.
    var dayCap = norm.calorieCap;
    var picked = [];
    var usedIds = {};

    function tryPick(candidates) {
      for (var i = 0; i < candidates.length; i++) {
        var r = candidates[i];
        if (usedIds[r.id]) continue;
        if (dayCap != null && dishKcal(r) > dayCap) continue;
        if (norm.perMealKcal != null && dishKcal(r) > norm.perMealKcal) continue;
        usedIds[r.id] = 1;
        return r;
      }
      return null;
    }

    for (var d = 0; d < days; d++) {
      var pick = tryPick(ordered);
      if (!pick) {
        // relax the day cap: pick the lowest-kcal unused dish so we never dead-end
        var fallback = ordered.filter(function (r) { return !usedIds[r.id]; })
          .sort(function (a, b) { return dishKcal(a) - dishKcal(b); })[0];
        if (fallback) {
          usedIds[fallback.id] = 1;
          pick = fallback;
          if ((dayCap != null && dishKcal(fallback) > dayCap) ||
              (norm.perMealKcal != null && dishKcal(fallback) > norm.perMealKcal)) {
            if (notes.indexOf("some days exceed the calorie target (closest available dishes used)") === -1)
              notes.push("some days exceed the calorie target (closest available dishes used)");
          }
        }
      }
      if (!pick) {
        // pool exhausted (fewer distinct dishes than days) — allow a wrap-around
        // but prefer NOT to repeat; only repeat if truly nothing left.
        var anyUnused = ordered.filter(function (r) { return !usedIds[r.id]; })[0];
        if (anyUnused) { usedIds[anyUnused.id] = 1; pick = anyUnused; }
      }
      if (!pick) {
        // genuinely out of distinct dishes — reuse least-recently-used, note it
        pick = ordered[d % ordered.length];
        if (notes.indexOf("not enough distinct dishes — some repeat") === -1)
          notes.push("not enough distinct dishes — some repeat");
      }

      picked.push({
        day: d + 1,
        label: "Day " + (d + 1),
        recipe: pick,
        kcal: dishKcal(pick),
        why: whyFor(pick, norm)
      });
    }

    var totalKcal = picked.reduce(function (s, x) { return s + num(x.kcal, 0); }, 0);
    var perDayAvgKcal = picked.length ? Math.round(totalKcal / picked.length) : 0;

    if (!notes.length) notes.push("All constraints satisfied.");

    return {
      days: picked,
      totalKcal: totalKcal,
      perDayAvgKcal: perDayAvgKcal,
      notes: notes.join(" "),
      constraints: norm,
      ok: true
    };
  }

  // Order the pool to maximise variety. When wantsMix, round-robin across
  // categories (and then cuisines) so consecutive days differ.
  function orderForVariety(pool, opts) {
    var arr = dedupe(pool);
    // Sort within groups: lighter / higher-protein first depending on intent,
    // but the dominant goal is spreading across groups.
    if (!opts.wantsMix) {
      // still avoid clustering same category back-to-back: light interleave
      return interleaveByKey(arr, function (r) { return r.category || "x"; });
    }
    // mix: interleave by category, then by cuisine as a tiebreak
    var byCat = interleaveByKey(arr, function (r) { return r.category || "x"; });
    return interleaveByKey(byCat, function (r) { return r.category + "|" + (r.cuisine || ""); });
  }

  // Round-robin items across the buckets produced by keyFn, preserving each
  // bucket's internal order, so adjacent items tend to have different keys.
  function interleaveByKey(arr, keyFn) {
    var buckets = {}, order = [];
    arr.forEach(function (r) {
      var k = keyFn(r);
      if (!buckets[k]) { buckets[k] = []; order.push(k); }
      buckets[k].push(r);
    });
    var out = [], added = true;
    while (added) {
      added = false;
      for (var i = 0; i < order.length; i++) {
        var b = buckets[order[i]];
        if (b.length) { out.push(b.shift()); added = true; }
      }
    }
    return out;
  }

  // ---- swapDay(plan, dayIndex, opts?) -------------------------------------
  function swapDay(thePlan, dayIndex, opts) {
    if (!thePlan || !Array.isArray(thePlan.days) || !thePlan.days.length) return thePlan;
    var i = toInt(dayIndex, 0);
    if (i < 0 || i >= thePlan.days.length) return thePlan;

    var constraints = opts || thePlan.constraints || {};
    var norm = {
      days: thePlan.days.length,
      calorieCap: constraints.calorieCap == null ? null : num(constraints.calorieCap, null),
      perMealKcal: constraints.perMealKcal == null ? null : num(constraints.perMealKcal, null),
      veg: !!constraints.veg, vegan: !!constraints.vegan, jain: !!constraints.jain,
      glutenFree: !!constraints.glutenFree, eggless: !!constraints.eggless,
      quick: !!constraints.quick, highProtein: !!constraints.highProtein,
      mealType: constraints.mealType || null,
      cuisines: constraints.cuisines || [],
      categories: constraints.categories || [],
      wantsMix: !!constraints.wantsMix
    };

    var KB = getKB();
    if (!KB || typeof KB.filter !== "function") return thePlan;

    // IDs already in the plan (so we never duplicate).
    var usedIds = {};
    thePlan.days.forEach(function (dd) { if (dd.recipe && dd.recipe.id) usedIds[dd.recipe.id] = 1; });

    var built = buildPool(KB, norm, thePlan.days.length + 1);
    var candidates = orderForVariety(built.pool, norm);

    // Prefer a dish that respects the cap AND isn't in the plan.
    var replacement = null;
    for (var c = 0; c < candidates.length; c++) {
      var r = candidates[c];
      if (usedIds[r.id]) continue;
      if (norm.calorieCap != null && dishKcal(r) > norm.calorieCap) continue;
      if (norm.perMealKcal != null && dishKcal(r) > norm.perMealKcal) continue;
      replacement = r; break;
    }
    // Relax cap if needed (still must be a NEW dish).
    if (!replacement) {
      for (var c2 = 0; c2 < candidates.length; c2++) {
        if (!usedIds[candidates[c2].id]) { replacement = candidates[c2]; break; }
      }
    }
    if (!replacement) return thePlan; // nothing new available — leave as-is

    var newDay = {
      day: thePlan.days[i].day,
      label: thePlan.days[i].label,
      recipe: replacement,
      kcal: dishKcal(replacement),
      why: whyFor(replacement, norm)
    };

    var newDays = thePlan.days.slice();
    newDays[i] = newDay;
    var totalKcal = newDays.reduce(function (s, x) { return s + num(x.kcal, 0); }, 0);

    return {
      days: newDays,
      totalKcal: totalKcal,
      perDayAvgKcal: newDays.length ? Math.round(totalKcal / newDays.length) : 0,
      notes: thePlan.notes || "",
      constraints: thePlan.constraints || norm,
      ok: true
    };
  }

  // ---- handle(text) -------------------------------------------------------
  function handle(text) {
    var opts = parse(text);
    var thePlan = plan(opts);
    var reply = buildReply(thePlan, opts);
    return { reply: reply, plan: thePlan, intent: "plan" };
  }

  function buildReply(thePlan, opts) {
    if (!thePlan || !thePlan.ok || !thePlan.days.length) {
      return "Arre, I couldn't put a plan together right now — " +
        ((thePlan && thePlan.notes) || "the recipe library may not be loaded yet.") +
        " Try again in a moment, bhaiya.";
    }
    var n = thePlan.days.length;
    var what = [];
    if (opts.mealType) what.push(opts.mealType);
    if (opts.veg && !opts.vegan) what.push("veg");
    if (opts.vegan) what.push("vegan");
    if (opts.highProtein) what.push("high-protein");
    if (opts.quick) what.push("quick");
    var label = what.length ? what.join(" ") + " " : "";

    var lines = [];
    lines.push("Here's your " + n + "-day " + label + "plan, chef! 🍳");
    thePlan.days.forEach(function (d) {
      var title = (d.recipe && d.recipe.title) || "Surprise dish";
      lines.push(d.label + ": " + title + " — " + d.kcal + " kcal" +
        (d.why ? " (" + d.why + ")" : ""));
    });
    lines.push("");
    lines.push("Total: " + thePlan.totalKcal + " kcal across " + n +
      " day" + (n === 1 ? "" : "s") + " (~" + thePlan.perDayAvgKcal + " kcal/day).");
    if (opts.calorieCap) {
      lines.push("Daily cap was " + opts.calorieCap + " kcal — " +
        (thePlan.days.every(function (d) { return d.kcal <= opts.calorieCap; })
          ? "every day is within budget. ✅" : "a couple of days nudge over; see notes."));
    }
    if (thePlan.notes && thePlan.notes !== "All constraints satisfied.") {
      lines.push("Note: " + thePlan.notes);
    }
    lines.push("Want me to swap any day? Just say the word.");
    return lines.join("\n");
  }

  // ---- export -------------------------------------------------------------
  var CookBhaiya = {
    parse: parse,
    plan: plan,
    swapDay: swapDay,
    handle: handle,
    // expose for the UI/tests
    _getKB: getKB
  };

  if (typeof module !== "undefined" && module.exports) module.exports = CookBhaiya;
  if (root) root.CookBhaiya = CookBhaiya;
  if (typeof window !== "undefined") window.CookBhaiya = CookBhaiya;

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
