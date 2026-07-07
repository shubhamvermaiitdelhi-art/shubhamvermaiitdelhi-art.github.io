/*
 * KhanaPro Shopping List — shopping_list.js
 * UMD: exposes window.KhanaProShopping (browser) and module.exports (Node) — identical API.
 *
 * Self-contained. Depends ONLY on the Engine API (window.KhanaProKB) to resolve ids.
 * Pure / no-throw: every method guards against bad input and returns a sensible value.
 * Browser-safe: never assumes `document` exists (renderHTML/css return strings only).
 *
 * API:
 *   build(recipesOrIds) -> { items:[{name,qty,unit,fromCount}], byAisle:{produce,dairy,grains,spices,protein,other} }
 *   toText(list)        -> plaintext checklist grouped by aisle (copy / WhatsApp)
 *   toCSV(list)         -> "name,qty,unit,aisle" CSV string
 *   renderHTML(list)    -> HTML string (grouped, checkbox per item)
 *   css()               -> CSS string (classes prefixed sl-, uses var(--brand) etc.)
 *   aggregateFromPlan(plan) -> build() over plan.days[].recipe (CookBhaiya plan shape)
 */
;(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.KhanaProShopping = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this), function (root) {
  "use strict";

  // ---- helpers --------------------------------------------------------------
  function isArray(x) { return Object.prototype.toString.call(x) === "[object Array]"; }
  function isObj(x) { return x && typeof x === "object" && !isArray(x); }
  function str(x) { return (x == null) ? "" : String(x); }
  function lc(x) { return str(x).toLowerCase(); }
  function num(x) { var n = Number(x); return isFinite(n) ? n : NaN; }

  var AISLES = ["produce", "dairy", "grains", "spices", "protein", "other"];
  var AISLE_LABEL = {
    produce: "Produce",
    dairy: "Dairy",
    grains: "Grains & Staples",
    spices: "Spices & Condiments",
    protein: "Protein",
    other: "Other"
  };

  // Keyword -> aisle classification. First matching aisle (in priority order) wins.
  // Protein checked before dairy so "paneer" / "curd"-ambiguous cases resolve well;
  // dairy words are explicit so they win for milk/cheese/butter etc.
  var KEYWORDS = {
    protein: [
      "tofu", "soya", "soy chunk", "soya chunk", "chicken", "mutton", "fish",
      "prawn", "egg", "rajma", "chana", "chickpea", "kidney bean", "moong",
      "masoor", "dal", "lentil", "lobia", "black bean", "tempeh", "seitan",
      "sprout", "peanut", "almond", "cashew", "walnut", "tuna", "salmon"
    ],
    dairy: [
      "paneer", "milk", "curd", "yogurt", "yoghurt", "cheese", "butter",
      "ghee", "cream", "buttermilk", "khoya", "mozzarella", "ricotta", "malai"
    ],
    produce: [
      "onion", "tomato", "potato", "spinach", "broccoli", "carrot", "capsicum",
      "bell pepper", "cucumber", "lettuce", "cabbage", "cauliflower", "beans",
      "peas", "mushroom", "ginger", "garlic", "lemon", "lime", "chilli", "chili",
      "coriander", "cilantro", "mint", "curry leaf", "lemongrass", "beetroot",
      "pumpkin", "zucchini", "brinjal", "eggplant", "okra", "bhindi", "lauki",
      "gourd", "radish", "celery", "leek", "scallion", "spring onion", "avocado",
      "apple", "banana", "mango", "berry", "berries", "orange", "grape",
      "pineapple", "pomegranate", "fruit", "veg", "vegetable", "greens", "kale",
      "sweet potato", "corn", "sweetcorn"
    ],
    grains: [
      "rice", "noodle", "pasta", "bread", "roti", "atta", "flour", "maida",
      "oats", "oat", "poha", "quinoa", "millet", "ragi", "bajra", "jowar",
      "semolina", "sooji", "rava", "vermicelli", "couscous", "besan", "cornflour",
      "corn flour", "bun", "wrap", "tortilla", "barley", "daliya", "upma",
      "sugar", "jaggery", "honey", "oil", "vinegar", "sauce"
    ],
    spices: [
      "salt", "pepper", "turmeric", "haldi", "cumin", "jeera", "coriander powder",
      "garam masala", "chilli powder", "chili powder", "red chilli", "paprika",
      "masala", "cardamom", "elaichi", "clove", "cinnamon", "dalchini", "bay leaf",
      "tej patta", "mustard seed", "rai", "asafoetida", "hing", "fenugreek",
      "methi", "ajwain", "carom", "nutmeg", "saffron", "kasuri", "oregano",
      "basil", "thyme", "rosemary", "chaat", "amchur", "fennel", "saunf",
      "star anise", "spice", "seasoning", "stock cube"
    ]
  };

  // Aisle resolution priority (protein & dairy win over the more generic produce/grains).
  var AISLE_PRIORITY = ["dairy", "protein", "spices", "grains", "produce"];

  function classify(name) {
    var n = lc(name);
    if (!n) return "other";
    for (var p = 0; p < AISLE_PRIORITY.length; p++) {
      var aisle = AISLE_PRIORITY[p];
      var words = KEYWORDS[aisle];
      for (var i = 0; i < words.length; i++) {
        if (n.indexOf(words[i]) !== -1) return aisle;
      }
    }
    return "other";
  }

  // Resolve the engine (window.KhanaProKB) from globals, then Node require.
  function getKB() {
    try {
      var g = root || (typeof globalThis !== "undefined" ? globalThis : null);
      if (g && g.KhanaProKB && typeof g.KhanaProKB.byId === "function") return g.KhanaProKB;
    } catch (e) { /* ignore */ }
    try {
      var gt = (typeof globalThis !== "undefined") ? globalThis : null;
      if (gt && gt.KhanaProKB && typeof gt.KhanaProKB.byId === "function") return gt.KhanaProKB;
    } catch (e2) { /* ignore */ }
    try {
      if (typeof module !== "undefined" && module.exports && typeof require === "function") {
        var KB = require("./kb_engine.js");
        if (KB && typeof KB.byId === "function") return KB;
      }
    } catch (e3) { /* ignore */ }
    return null;
  }

  // Resolve one entry (recipe object or id) to a recipe with .ingredients.
  function resolveRecipe(entry) {
    if (entry == null) return null;
    if (typeof entry === "string") {
      var kb = getKB();
      if (kb) { try { return kb.byId(entry); } catch (e) { return null; } }
      return null;
    }
    if (isObj(entry)) {
      // Inline recipe object with ingredients — use as-is.
      if (isArray(entry.ingredients)) return entry;
      // Object carrying just an id — resolve via engine.
      if (entry.id) {
        var kb2 = getKB();
        if (kb2) { try { return kb2.byId(str(entry.id)) || null; } catch (e2) { return null; } }
      }
    }
    return null;
  }

  // HTML-escape a string for safe interpolation.
  function esc(s) {
    return str(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  // CSV-escape a field.
  function csvField(s) {
    var v = str(s);
    if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  // Pretty-format a quantity number (drop trailing .0; round to 2dp).
  function fmtQty(q) {
    if (q == null || !isFinite(q)) return "";
    var r = Math.round(q * 100) / 100;
    return str(r);
  }

  // ---- build ----------------------------------------------------------------
  // Accept an array of recipe objects OR ids. Merge duplicate ingredients by name,
  // summing qty ONLY when units match; keep separate lines when units differ.
  function build(recipesOrIds) {
    var out = { items: [], byAisle: {} };
    for (var a = 0; a < AISLES.length; a++) out.byAisle[AISLES[a]] = [];

    try {
      var list = isArray(recipesOrIds) ? recipesOrIds : (recipesOrIds == null ? [] : [recipesOrIds]);

      // Keyed by name|unit so same-name+same-unit merges, different units stay split.
      var map = {};       // key -> item
      var order = [];     // preserve first-seen order of keys

      for (var i = 0; i < list.length; i++) {
        var rec = resolveRecipe(list[i]);
        if (!rec || !isArray(rec.ingredients)) continue;

        for (var j = 0; j < rec.ingredients.length; j++) {
          var ing = rec.ingredients[j];
          if (!isObj(ing)) continue;
          var name = str(ing.name).trim();
          if (!name) continue;
          var unit = str(ing.unit).trim();
          var qtyN = num(ing.qty);
          var hasQty = isFinite(qtyN);

          var key = lc(name) + "|" + lc(unit);
          if (!map[key]) {
            map[key] = {
              name: name,
              qty: hasQty ? qtyN : null,
              unit: unit,
              fromCount: 1
            };
            order.push(key);
          } else {
            var it = map[key];
            it.fromCount += 1;
            if (hasQty) {
              it.qty = (it.qty == null) ? qtyN : (it.qty + qtyN);
            }
          }
        }
      }

      for (var o = 0; o < order.length; o++) {
        var item = map[order[o]];
        out.items.push(item);
        var aisle = classify(item.name);
        if (!out.byAisle[aisle]) out.byAisle[aisle] = [];
        out.byAisle[aisle].push(item);
      }
    } catch (e) { /* no-throw: return whatever we have */ }

    return out;
  }

  // ---- aggregateFromPlan ----------------------------------------------------
  // CookBhaiya plan shape: { days:[ { recipe:Recipe, ... }, ... ], ... }
  function aggregateFromPlan(plan) {
    try {
      if (!isObj(plan) || !isArray(plan.days)) return build([]);
      var recipes = [];
      for (var i = 0; i < plan.days.length; i++) {
        var d = plan.days[i];
        if (isObj(d) && d.recipe != null) recipes.push(d.recipe);
      }
      return build(recipes);
    } catch (e) { return build([]); }
  }

  // ---- toText ---------------------------------------------------------------
  function toText(list) {
    try {
      var L = (isObj(list) && isObj(list.byAisle)) ? list : build(list);
      var lines = ["🛒 Shopping list", ""];
      var any = false;
      for (var a = 0; a < AISLES.length; a++) {
        var aisle = AISLES[a];
        var items = L.byAisle[aisle];
        items = isArray(items) ? items : [];
        if (!items.length) continue;
        any = true;
        lines.push(AISLE_LABEL[aisle]);
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var q = fmtQty(it.qty);
          var tail = (q ? (q + (it.unit ? " " + it.unit : "")) : (it.unit || ""));
          lines.push("• " + cap(it.name) + (tail ? " — " + tail : ""));
        }
        lines.push("");
      }
      if (!any) lines.push("(empty)");
      // trim trailing blank line
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      return lines.join("\n");
    } catch (e) { return "🛒 Shopping list\n\n(empty)"; }
  }

  function cap(s) {
    var v = str(s);
    return v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  }

  // ---- toCSV ----------------------------------------------------------------
  function toCSV(list) {
    try {
      var L = (isObj(list) && isArray(list.items)) ? list : build(list);
      var rows = ["name,qty,unit,aisle"];
      var items = isArray(L.items) ? L.items : [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var aisle = classify(it.name);
        rows.push(
          csvField(it.name) + "," +
          csvField(fmtQty(it.qty)) + "," +
          csvField(it.unit) + "," +
          csvField(aisle)
        );
      }
      return rows.join("\n");
    } catch (e) { return "name,qty,unit,aisle"; }
  }

  // ---- renderHTML -----------------------------------------------------------
  function renderHTML(list) {
    try {
      var L = (isObj(list) && isObj(list.byAisle)) ? list : build(list);
      var html = ['<div class="sl-list">'];
      html.push('<div class="sl-head">🛒 Shopping list</div>');
      var any = false;
      for (var a = 0; a < AISLES.length; a++) {
        var aisle = AISLES[a];
        var items = isArray(L.byAisle[aisle]) ? L.byAisle[aisle] : [];
        if (!items.length) continue;
        any = true;
        html.push('<div class="sl-aisle" data-aisle="' + esc(aisle) + '">');
        html.push('<div class="sl-aisle-title">' + esc(AISLE_LABEL[aisle]) + '</div>');
        html.push('<ul class="sl-items">');
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var q = fmtQty(it.qty);
          var qty = q ? (esc(q) + (it.unit ? " " + esc(it.unit) : "")) : esc(it.unit || "");
          var id = "sl-" + esc(aisle) + "-" + i;
          html.push(
            '<li class="sl-item">' +
              '<input type="checkbox" class="sl-cb" id="' + id + '">' +
              '<label class="sl-label" for="' + id + '">' +
                '<span class="sl-name">' + esc(cap(it.name)) + '</span>' +
                (qty ? '<span class="sl-qty">' + qty + '</span>' : '') +
              '</label>' +
            '</li>'
          );
        }
        html.push('</ul>');
        html.push('</div>');
      }
      if (!any) html.push('<div class="sl-empty">Your shopping list is empty.</div>');
      html.push('</div>');
      return html.join("");
    } catch (e) { return '<div class="sl-list"><div class="sl-empty">Your shopping list is empty.</div></div>'; }
  }

  // ---- css ------------------------------------------------------------------
  function css() {
    return [
      ".sl-list{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink,#1a1a1a);max-width:560px}",
      ".sl-head{font-weight:700;font-size:16px;margin:0 0 12px;color:var(--brand,#16a34a)}",
      ".sl-aisle{margin:0 0 14px;border:1px solid var(--line,#e5e7eb);border-radius:12px;overflow:hidden;background:var(--card,#fff)}",
      ".sl-aisle-title{font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase;padding:8px 12px;background:var(--brand-soft,rgba(22,163,74,.08));color:var(--brand,#16a34a)}",
      ".sl-items{list-style:none;margin:0;padding:4px 0}",
      ".sl-item{display:flex;align-items:center;gap:10px;padding:6px 12px}",
      ".sl-cb{width:18px;height:18px;flex:0 0 auto;accent-color:var(--brand,#16a34a);cursor:pointer}",
      ".sl-label{display:flex;flex:1;align-items:baseline;justify-content:space-between;gap:10px;cursor:pointer}",
      ".sl-cb:checked + .sl-label .sl-name{text-decoration:line-through;opacity:.55}",
      ".sl-name{font-weight:500}",
      ".sl-qty{color:var(--muted,#6b7280);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".sl-empty{padding:16px;color:var(--muted,#6b7280);text-align:center}",
      "@media (prefers-reduced-motion: reduce){.sl-list *{transition:none!important}}"
    ].join("\n");
  }

  return {
    build: build,
    toText: toText,
    toCSV: toCSV,
    renderHTML: renderHTML,
    css: css,
    aggregateFromPlan: aggregateFromPlan,
    // exposed for host/testing convenience (not in the required surface)
    classify: classify
  };
});
