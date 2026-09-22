/*
 * KhanaPro Portion-Scaling — scaling.js
 * UMD: exposes window.KhanaProScale (browser) and module.exports (Node) — identical API.
 *
 * Self-contained. No dependency on any other module (operates on a recipe object).
 * Pure / no-throw: every method guards against bad input and returns a sensible value.
 * Browser-safe: never assumes `document` exists.
 *
 * Recipe shape (per kb/KB_SPEC.md):
 *   recipe.servings  : Number
 *   recipe.ingredients : [{ name, qty, unit }]   unit in g|ml|pc|tbsp|tsp|cup
 *   recipe.nutrition : { kcal, protein, fibre, fat, carbs }  // PER SERVING
 *
 * API:
 *   factorFor(recipe, targetServings) -> Number      (targetServings / baseServings)
 *   niceQty(qty, unit) -> Number                      (sensible per-unit rounding)
 *   scale(recipe, targetServings) -> {
 *       servings, factor,
 *       ingredients:[{name,qty,unit}],                (qty * factor, niceQty-rounded)
 *       nutrition:{kcal,protein,fibre,fat,carbs},     (PER SERVING — unchanged)
 *       totalNutrition:{kcal,protein,fibre,fat,carbs} (perServing * targetServings)
 *   }
 *   toCartItems(recipe, targetServings) -> scaled ingredients [{name,qty,unit}]
 */
;(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.KhanaProScale = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this), function (root) {
  "use strict";

  var DEFAULT_SERVINGS = 2;

  // --- helpers ---------------------------------------------------------------

  function num(v, fallback) {
    var n = Number(v);
    return (typeof n === "number" && isFinite(n)) ? n : fallback;
  }

  // Round to `step`, then trim float noise to at most 2 decimals.
  function roundTo(value, step) {
    if (!(step > 0)) return value;
    var r = Math.round(value / step) * step;
    // kill floating point fuzz like 7.500000000001
    return Math.round(r * 100) / 100;
  }

  // Base servings of a recipe, guarded: missing/zero/negative -> DEFAULT_SERVINGS.
  function baseServings(recipe) {
    var s = num(recipe && recipe.servings, DEFAULT_SERVINGS);
    if (!(s > 0)) s = DEFAULT_SERVINGS;
    return s;
  }

  // Target servings, guarded: missing/zero/negative -> base servings (factor 1).
  function targetOf(recipe, targetServings) {
    var t = num(targetServings, NaN);
    if (!(t > 0)) t = baseServings(recipe);
    return t;
  }

  /*
   * niceQty(qty, unit) — round a scaled quantity to something cook-friendly:
   *   pc            -> ceil to nearest 0.25 (never short a piece), then nice 0.25 grid
   *   g, ml         -> round to nearest 5
   *   tbsp,tsp,cup  -> round to nearest 0.25
   *   anything else -> round to 2 decimals (safe default)
   * Always returns a finite, non-negative number.
   */
  function niceQty(qty, unit) {
    var q = num(qty, 0);
    if (q < 0) q = 0;
    var u = (typeof unit === "string" ? unit : "").toLowerCase().trim();

    if (u === "pc") {
      // ceil to 0.25 so you never end up with too little of a countable item,
      // then snap onto the 0.25 grid for a "nice" value.
      var ceiled = Math.ceil(q / 0.25) * 0.25;
      return Math.round(ceiled * 100) / 100;
    }
    if (u === "g" || u === "ml") {
      return roundTo(q, 5);
    }
    if (u === "tbsp" || u === "tsp" || u === "cup") {
      return roundTo(q, 0.25);
    }
    // unknown unit: don't distort, just clean float noise
    return Math.round(q * 100) / 100;
  }

  /*
   * purchaseQty(qty, unit) - what you can actually BUY (KhanaPro v51, audit KP-UNIT-001):
   *   pc, bunch, packet, pack, dozen, bundle, pod, sprig -> ceil to a whole unit
   *   everything else -> niceQty (grams/ml/spoons are divisible)
   * The recipe keeps the precise scaled quantity; only the cart/list rounds up.
   */
  var COUNT_UNITS = { pc: 1, pcs: 1, piece: 1, pieces: 1, bunch: 1, packet: 1, pack: 1, dozen: 1, bundle: 1, pod: 1, pods: 1, sprig: 1, sprigs: 1, leaf: 1, leaves: 1, clove: 1, cloves: 1, slice: 1, slices: 1, nos: 1, no: 1 };
  function isCountUnit(unit) {
    var u = (typeof unit === "string" ? unit : "").toLowerCase().trim();
    return !!COUNT_UNITS[u];
  }
  function purchaseQty(qty, unit) {
    var q = num(qty, 0);
    if (q < 0) q = 0;
    if (isCountUnit(unit)) return q > 0 ? Math.ceil(q - 1e-9) : 0;
    return niceQty(q, unit);
  }
  /* qtyText(qty, unit) - display form: count units show cook-friendly fractions
   * ("1/2 pc") while remaining precise; other units print the nice number. */
  function qtyText(qty, unit) {
    var q = num(qty, 0);
    if (q < 0) q = 0;
    if (isCountUnit(unit)) {
      var whole = Math.floor(q + 1e-9), frac = q - whole;
      var fr = frac >= 0.875 ? "" : frac >= 0.625 ? "3/4" : frac >= 0.375 ? "1/2" : frac >= 0.125 ? "1/4" : "";
      if (frac >= 0.875) whole += 1;
      if (!whole && !fr) return "0";
      return (whole ? String(whole) : "") + (whole && fr ? " " : "") + fr;
    }
    var n2 = niceQty(q, unit);
    return String(n2);
  }

  // --- public API ------------------------------------------------------------

  function factorFor(recipe, targetServings) {
    var base = baseServings(recipe);
    var target = targetOf(recipe, targetServings);
    if (!(base > 0)) return 1;
    return target / base;
  }

  function scaleIngredients(recipe, factor) {
    var out = [];
    var list = (recipe && Array.isArray(recipe.ingredients)) ? recipe.ingredients : [];
    for (var i = 0; i < list.length; i++) {
      var ing = list[i] || {};
      var name = (ing.name != null) ? ing.name : "";
      var unit = (ing.unit != null) ? ing.unit : "";
      var baseQty = num(ing.qty, 0);
      var scaled = baseQty * factor;
      var item = { name: name, qty: niceQty(scaled, unit), unit: unit };
      // preserve a staple flag if present (cart pricing cares about it)
      if (ing.staple != null) item.staple = ing.staple;
      out.push(item);
    }
    return out;
  }

  function perServingNutrition(recipe) {
    var n = (recipe && recipe.nutrition) ? recipe.nutrition : {};
    return {
      kcal: num(n.kcal, 0),
      protein: num(n.protein, 0),
      fibre: num(n.fibre, 0),
      fat: num(n.fat, 0),
      carbs: num(n.carbs, 0)
    };
  }

  function multiplyNutrition(per, mult) {
    function m(v) { return Math.round(v * mult * 100) / 100; }
    return {
      kcal: m(per.kcal),
      protein: m(per.protein),
      fibre: m(per.fibre),
      fat: m(per.fat),
      carbs: m(per.carbs)
    };
  }

  function scale(recipe, targetServings) {
    var r = recipe || {};
    var target = targetOf(r, targetServings);
    var factor = factorFor(r, target);

    var per = perServingNutrition(r);

    return {
      servings: target,
      factor: factor,
      ingredients: scaleIngredients(r, factor),
      // nutrition is PER SERVING and therefore unchanged by scaling
      nutrition: {
        kcal: per.kcal,
        protein: per.protein,
        fibre: per.fibre,
        fat: per.fat,
        carbs: per.carbs
      },
      // whole-dish totals for the chosen number of servings
      totalNutrition: multiplyNutrition(per, target)
    };
  }

  /* toCartItems: the PURCHASE snapshot for the chosen servings - count units
   * round UP to whole pieces (nobody buys 0.5 of a chilli), precise quantity
   * kept alongside as qtyExact for the recipe view. */
  function toCartItems(recipe, targetServings) {
    var r = recipe || {};
    var target = targetOf(r, targetServings);
    var factor = factorFor(r, target);
    var list = (r && Array.isArray(r.ingredients)) ? r.ingredients : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var ing = list[i] || {};
      var exact = num(ing.qty, 0) * factor;
      out.push({ name: (ing.name != null) ? ing.name : "", qty: purchaseQty(exact, ing.unit), qtyExact: Math.round(exact * 100) / 100, unit: (ing.unit != null) ? ing.unit : "", servings: target });
    }
    return out;
  }

  return {
    scale: scale,
    factorFor: factorFor,
    toCartItems: toCartItems,
    niceQty: niceQty,
    purchaseQty: purchaseQty,
    qtyText: qtyText,
    isCountUnit: isCountUnit,
    // exposed for host/testing convenience (not in the required surface)
    DEFAULT_SERVINGS: DEFAULT_SERVINGS
  };
});
