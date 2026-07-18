/*
 * KhanaPro — Deterministic Scientific Recipe Health Classifier
 * ------------------------------------------------------------
 * Pure, no-throw. Classifies a recipe into a primary `tier` plus boolean flags
 * and a 0–100 healthfulness score, computed from NUTRITION + COOKING METHOD +
 * INGREDIENTS — deliberately NOT from the (unreliable) `tags` array.
 *
 * Why method matters: this is a "healthy" KB, so a dish called "Pakora" /
 * "Samosa" / "Vada" / "Chilli Paneer" may actually be AIR-FRIED or BAKED
 * (light). The classifier reads the STEPS to find the real cooking method and
 * only falls back to title-noun heuristics when steps give no clearer signal.
 * A genuinely deep-fried dish lands in "indulgent" (cheat-meal); an air-fried
 * or baked version of the same dish does not. Pan-frying a few cubes of tofu in
 * a little oil is treated as sauté-grade, not deep-frying.
 *
 * Exposes window.KhanaProHealth (browser) and module.exports (Node).
 */
;(function (root) {
  "use strict";

  // ---------- tiny safe helpers ----------
  function str(x) { return (x == null) ? "" : String(x); }
  function low(x) { return str(x).toLowerCase(); }
  function num(x) { var n = Number(x); return isFinite(n) ? n : 0; }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function clamp(n, lo, hi) { n = num(n); return n < lo ? lo : (n > hi ? hi : n); }

  function hay(recipe) {
    // searchable text: title + steps + ingredient names (NOT tags — unreliable)
    var r = recipe || {};
    var parts = [low(r.title)];
    var steps = arr(r.steps);
    for (var i = 0; i < steps.length; i++) parts.push(low(steps[i]));
    var ings = arr(r.ingredients);
    for (var j = 0; j < ings.length; j++) parts.push(low(ings[j] && ings[j].name));
    parts.push(low(r.summary));
    return parts.join("  ");
  }
  function any(text, words) {
    // WORD-BOUNDED: "pancake" must never match "cake" (the sweet-cheela disease).
    // A hit counts only when the match is not glued to letters on either side.
    for (var i = 0; i < words.length; i++) {
      var w = words[i], from = 0, idx;
      while ((idx = text.indexOf(w, from)) !== -1) {
        var b = idx === 0 ? "" : text.charAt(idx - 1);
        var a = idx + w.length >= text.length ? "" : text.charAt(idx + w.length);
        if (!/[a-z]/.test(b) && !/[a-z]/.test(a)) return true;
        from = idx + 1;
      }
    }
    return false;
  }

  // ---------- nutrition guards (missing => 0) ----------
  function nut(recipe) {
    var n = (recipe && recipe.nutrition) || {};
    return {
      kcal: num(n.kcal),
      protein: num(n.protein),
      fibre: num(n.fibre),
      fat: num(n.fat),
      carbs: num(n.carbs),
      missing: !(recipe && recipe.nutrition) || (!num(n.kcal) && !num(n.protein) && !num(n.fat))
    };
  }

  // ---------- METHOD DETECTION ----------
  // Step-evidence wins over title nouns: an "Air-Fried Pakora" is baked, not deep-fried.
  function detectMethod(recipe) {
    var r = recipe || {};
    var title = low(r.title);
    var steps = arr(r.steps).map(low).join("  ");
    var text = (title + "  " + steps);

    // Healthier-method overrides that may co-occur with a "fried" noun in the title.
    var airfry = any(text, ["air-fry", "air fry", "air-fried", "airfryer", "air fryer", "air-fryer"]);
    var bakeWords = any(text, ["bake ", "baked", "oven", "preheat", "200c", "180c", "190c", "220c", "roast in the oven"]);
    var grillWords = any(text, ["grill", "tandoor", "tandoori", "skewer", "char on", "barbecue", "bbq", "griddle"]);
    var steamWords = any(text, ["steam", "idli", "dhokla", "momo", "steamer", "double boiler", "steamed"]);

    // Light pan/shallow techniques — must NOT be read as deep-frying.
    var panShallow = any(text, [
      "pan-fry", "pan fry", "panfry", "shallow-fry", "shallow fry",
      "tawa", "little oil", "minimal oil", "drizzle of oil", "drop of oil",
      "1 tbsp oil", "1 tsp oil", "lightly fry", "non-stick"
    ]);

    // Strong DEEP-FRY evidence in the steps/title (true immersion frying).
    var deepFryEvidence = any(text, [
      "deep fry", "deep-fry", "deep fried", "deep-fried", "deep frying",
      "fry in hot oil", "drop into hot oil", "fry in batches", "hot oil and fry",
      "immerse in oil", "fry in plenty of oil"
    ]);
    // "fry until golden/crisp/brown" counts as deep-fry ONLY when no light
    // pan/shallow technique is mentioned (avoids flagging pan-fried tofu).
    if (!panShallow && any(text, [
      "fry until golden", "fry till golden", "fry until crisp", "fry till crisp",
      "fry until brown", "fry till brown", "fry small", "fry the pakora", "fry the vada"
    ])) deepFryEvidence = true;

    // Title nouns that are classically deep-fried IF not overridden by a healthier method.
    var deepFryNoun = any(title, [
      "jalebi", "puri ", "poori", "bhatura", "samosa", "kachori", "pakora", "pakoda",
      "bhaji", "bhajia", "medu vada", "vada", "bonda", "vadai", "namak para", "chakli",
      "gujiya", "mathri", "fryums", "imarti"
    ]);

    if (deepFryEvidence && !airfry && !bakeWords && !steamWords) return "deep-fried";
    if (airfry) return "baked";              // air-frying ~ baked (minimal oil)
    if (steamWords) return "steamed";
    if (bakeWords) return "baked";
    if (grillWords) return "grilled";
    if (deepFryNoun && !panShallow) return "deep-fried"; // classic fried noun, no healthier override

    // Stir-frying / pan-frying / shallow-frying with little oil => sauteed (light).
    if (any(text, ["stir fry", "stir-fry", "saute", "sauté", "toss"])) return "sauteed";
    if (panShallow) return "sauteed";
    // Ordinary shallow frying (oil-forward, no "little oil" qualifier) => fried.
    if (any(text, ["shallow fry", "shallow-fry", "fry on", "fry till", "fry until",
                   "fry for", "fry the", "tawa fry", "fry in oil"])) {
      return "fried";
    }
    if (any(text, ["tandoor", "tandoori"])) return "tandoori";
    if (any(text, ["grill", "skewer", "barbecue", "bbq"])) return "grilled";
    if (any(text, ["roast", "roasted"])) return "roasted";
    if (any(text, ["simmer", "slow cook", "pressure cook", "cook covered", "cook the dal",
                   "let it cook", "bring to a boil and cook"])) return "simmered";
    if (any(text, ["boil", "blanch", "parboil"])) return "boiled";
    if (any(text, ["blend", "smoothie", "puree", "grind smooth", "whizz", "milkshake"])) return "blended";
    if (any(text, ["saute", "sauté", "temper", "tadka", "stir", "cook on medium",
                   "cook the", "cook till"])) return "sauteed";
    if (any(text, ["no-cook", "no cook", "raw", "salad", "assemble", "mix together", "soak",
                   "marinate and serve", "chill", "refrigerate"])) {
      if (any(text, ["blend", "smoothie", "puree"])) return "blended";
      return "raw";
    }
    return "no-cook";
  }

  // ---------- DESSERT / SWEET detection ----------
  function dessertSignals(recipe, text) {
    var r = recipe || {};
    var cat = low(r.category);
    var nameSugar = any(text, [
      "halwa", "kheer", "laddoo", "laddu", "ladoo", "barfi", "burfi", "jalebi", "gulab jamun",
      "rasmalai", "rasgulla", "cake", "brownie", "ice cream", "ice-cream", "kulfi", "phirni",
      "payasam", "sheera", "mishti", "sandesh", "modak", "peda", "shrikhand", "custard",
      "pudding", "mousse", "cheesecake", "cookie", "muffin",
      "\u0939\u0932\u0935\u093e", "\u0916\u0940\u0930", "\u0932\u0921\u094d\u0921\u0942", "\u092c\u0930\u094d\u092b\u0940", "\u091c\u0932\u0947\u092c\u0940", "\u0930\u0938\u0917\u0941\u0932\u094d\u0932\u093e", "\u092e\u093f\u0920\u093e\u0908", "\u0915\u0947\u0915", "\u0930\u092c\u0921\u093c\u0940", "\u0915\u0941\u0932\u094d\u092b\u0940"
    ]);
    var sweetIng = any(text, [
      "sugar", "jaggery", "gur", "condensed milk", "honey", "maple syrup", "chocolate",
      "cocoa", "dates", "date paste", "khajur", "khoya", "mawa"
    ]);
    var isDessertCat = (cat === "healthy-dessert");
    // ingredient-grounded veto: a dish full of onion/chilli/cumin with ZERO sweet
    // ingredients is not a dessert, whatever a stray title word suggests
    var savorySig = any(text, ["onion", "garlic", "chilli", "chili", "mirchi", "cumin", "jeera", "turmeric", "haldi", "masala", "namak"]);
    var isDessert = isDessertCat || nameSugar;
    if (isDessert && !isDessertCat && savorySig && !sweetIng) isDessert = false;
    return { isDessert: isDessert, nameSugar: nameSugar, sweetIng: sweetIng, cat: cat };
  }

  // ---------- MAIN CLASSIFY ----------
  function classify(recipe) {
    var r = recipe || {};
    var text = hay(r);
    var n = nut(r);
    var cat = low(r.category);
    var method = detectMethod(r);
    var dz = dessertSignals(r, text);
    // DISH TAXONOMY override (kb_enrich dcls): the ontology KNOWS cheela is
    // savory and laddoo is sweet - taxonomy beats keyword inference, always.
    if (r.dcls === "savory") { dz.isDessert = false; dz.nameSugar = false; }
    else if (r.dcls === "sweet") { dz.isDessert = true; }

    var deepFried = (method === "deep-fried");
    var fried = (method === "fried");
    var baked = (method === "baked");
    var grilled = (method === "grilled" || method === "tandoori");
    var steamed = (method === "steamed");
    var raw = (method === "raw" || method === "blended" || method === "no-cook");

    var vegForward = any(text, [
      "spinach", "palak", "broccoli", "cauliflower", "gobi", "carrot", "beans", "peas",
      "capsicum", "tomato", "cucumber", "lettuce", "kale", "methi", "lauki", "bhindi",
      "beetroot", "pumpkin", "zucchini", "mushroom", "salad", "veg", "vegetable"
    ]);

    var highProtein = n.protein >= 18;
    var lowCal = n.kcal > 0 && n.kcal <= 250;
    var highCal = n.kcal >= 500;
    var highFat = n.fat >= 18;
    var veryHighFat = n.fat >= 22;
    var highSugar = (n.carbs >= 40) && (dz.isDessert || dz.sweetIng);
    var highFibre = n.fibre >= 6;

    var friedSnackNoun = any(low(r.title), [
      "medu vada", "samosa", "pakora", "pakoda", "vada", "bhaji", "bhajia", "puri",
      "poori", "bhatura", "kachori", "jalebi", "chakli", "bonda"
    ]);
    var methodIndulgent =
      deepFried ||
      fried ||
      (friedSnackNoun && (deepFried || fried)) ||
      (low(r.title).indexOf("chilli paneer") !== -1 && (deepFried || fried));
    // Fat/calorie-heavy dishes count as a "cheat" ONLY when they are NOT protein-forward —
    // a high-protein paneer/chicken/egg dish is protein-rich, not a cheat meal.
    var richIndulgent = (veryHighFat || (highCal && n.fibre < 5)) && !highProtein;
    var indulgent = methodIndulgent || richIndulgent;

    var friedDessert = dz.isDessert && (deepFried || fried);
    if (friedDessert) indulgent = true;

    var wholesome = !indulgent && n.fibre >= 3;

    // ---- TIER (priority order) ----
    var tier;
    if (cat === "drink") {
      tier = "drink";
    } else if (dz.isDessert && !indulgent) {
      tier = "sweet-treat";
    } else if (indulgent) {
      tier = "indulgent";
    } else if (highProtein) {
      tier = "protein-rich";
    } else if (lowCal) {
      tier = "light";
    } else if (!indulgent && (n.fibre >= 4 || vegForward) && n.kcal >= 250 && n.kcal <= 500) {
      tier = "wholesome";
    } else if (cat === "snack" || cat === "salad") {
      tier = "snack";
    } else {
      tier = "wholesome";
    }

    // ---- SCORE (0–100 healthfulness) ----
    var score = 60;
    score += Math.min(n.protein, 30) * 0.6;
    score += Math.min(n.fibre, 12) * 1.2;
    if (steamed) score += 8;
    if (grilled) score += 7;
    if (raw) score += 6;
    if (baked) score += 5;
    if (deepFried) score -= 35;
    if (fried) score -= 20;
    if (veryHighFat) score -= 14; else if (highFat) score -= 8;
    if (highSugar) score -= 12;
    if (highCal) score -= 10;
    if (lowCal) score += 4;
    score = Math.round(clamp(score, 0, 100));

    var labelMap = tierLabels();
    return {
      tier: tier,
      tierLabel: (labelMap[tier] ? labelMap[tier].label : tier),
      method: method,
      score: score,
      flags: {
        deepFried: deepFried, fried: fried, baked: baked, grilled: grilled,
        steamed: steamed, raw: raw, highProtein: highProtein, lowCal: lowCal,
        highCal: highCal, highFat: highFat, highSugar: highSugar, highFibre: highFibre,
        wholesome: wholesome, indulgent: indulgent
      }
    };
  }

  function isHealthy(recipe) {
    var c = classify(recipe);
    return (c.tier === "wholesome" || c.tier === "light" || c.tier === "protein-rich")
      && !c.flags.indulgent && !c.flags.deepFried;
  }

  function tierLabels() {
    return {
      "protein-rich": { id: "protein-rich", label: "Protein-Rich", emoji: "💪" },
      "wholesome":    { id: "wholesome",    label: "Wholesome",    emoji: "🥗" },
      "light":        { id: "light",        label: "Light",        emoji: "🍃" },
      "snack":        { id: "snack",        label: "Snack",        emoji: "🍿" },
      "indulgent":    { id: "indulgent",    label: "Indulgent (Cheat)", emoji: "🍔" },
      "sweet-treat":  { id: "sweet-treat",  label: "Sweet Treat",  emoji: "🍮" },
      "drink":        { id: "drink",        label: "Drink",        emoji: "🥤" }
    };
  }
  function tiers() {
    var m = tierLabels();
    return ["protein-rich", "wholesome", "light", "snack", "indulgent", "sweet-treat", "drink"]
      .map(function (id) { return m[id]; });
  }

  var API = {
    detectMethod: detectMethod,
    classify: classify,
    isHealthy: isHealthy,
    tiers: tiers,
    tierLabels: tierLabels
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (root) root.KhanaProHealth = API;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
