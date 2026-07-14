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

  function toCartItems(recipe, targetServings) {
    return scale(recipe, targetServings).ingredients;
  }

  return {
    scale: scale,
    factorFor: factorFor,
    toCartItems: toCartItems,
    niceQty: niceQty,
    // exposed for host/testing convenience (not in the required surface)
    DEFAULT_SERVINGS: DEFAULT_SERVINGS
  };
});
