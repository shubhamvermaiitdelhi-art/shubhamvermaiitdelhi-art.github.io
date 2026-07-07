/* ============================================================================
 * CartPilot Data Layer — platform registry, Apify live fetch, normalization,
 * deep links, and a realistic demo dataset so the app works with zero setup.
 * ==========================================================================*/
(function (root) {
  'use strict';

  // Defensive field pluck across the many shapes Apify actors return.
  function pick(o, keys) {
    for (const k of keys) {
      if (o == null) continue;
      const v = k.split('.').reduce((a, c) => (a == null ? a : a[c]), o);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }
  function num(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return isNaN(n) ? null : n;
  }

  // Generic normalizer -> {name, price, mrp, rating, inStock, quantity, url, image}
  function normalize(raw, platformKey) {
    const name = pick(raw, ['name', 'title', 'productName', 'product_name', 'product']);
    const price = num(pick(raw, ['price', 'sellingPrice', 'selling_price', 'offerPrice',
      'finalPrice', 'discountedPrice', 'salePrice', 'mrp']));
    const mrp = num(pick(raw, ['mrp', 'MRP', 'originalPrice', 'listPrice', 'strikePrice', 'price']));
    const rating = num(pick(raw, ['rating', 'avgRating', 'ratings', 'star', 'productRating']));
    const quantity = pick(raw, ['quantity', 'packSize', 'pack_size', 'weight', 'unit', 'variant', 'size']);
    const url = pick(raw, ['url', 'productUrl', 'product_url', 'link', 'pdpUrl']);
    const image = pick(raw, ['image', 'imageUrl', 'image_url', 'thumbnail', 'images.0']);
    const eta = num(pick(raw, ['etaMinutes', 'eta', 'deliveryTime', 'delivery_eta', 'deliveryEta']));
    let inStock = pick(raw, ['inStock', 'available', 'isAvailable', 'in_stock', 'availability']);
    if (typeof inStock === 'string') inStock = !/out|unavailable|false|no/i.test(inStock);
    if (inStock === undefined) inStock = true;
    return {
      name, price, mrp, rating, quantity,
      url, image, etaMinutes: eta || null, inStock, _platform: platformKey,
    };
  }

  // ---- Platform registry ----------------------------------------------------
  // live=true  -> first-class Apify search actor wired below
  // live=false -> no reliable free actor; runs in demo / browser-assisted mode
  const PLATFORMS = {
    blinkit: {
      name: 'Blinkit', color: '#F8CB46', ink: '#1a1a1a', live: true,
      actor: 'architjn~blinkit-search-scraper',
      input: (q, loc, n) => ({ queries: [q], latitude: loc.lat, longitude: loc.lng, maxItemsPerQuery: n }),
      needs: 'latlng',
      deepLink: (q) => `https://blinkit.com/s/?q=${encodeURIComponent(q)}`,
      deliveryFee: 25, handlingFee: 8, freeDeliveryAbove: 199, etaMinutes: 12,
    },
    zepto: {
      name: 'Zepto', color: '#7B2FF7', ink: '#fff', live: true,
      actor: 'architjn~zepto-search-scraper',
      input: (q, loc, n) => ({ queries: [q], locationQuery: loc.area + ' ' + loc.city, maxItemsPerQuery: n }),
      needs: 'area',
      deepLink: (q) => `https://www.zeptonow.com/search?query=${encodeURIComponent(q)}`,
      deliveryFee: 25, handlingFee: 7, freeDeliveryAbove: 199, etaMinutes: 10,
    },
    instamart: {
      name: 'Swiggy Instamart', color: '#FC8019', ink: '#fff', live: false, browser: true,
      actor: null, needs: 'latlng',
      deepLink: (q) => `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(q)}`,
      deliveryFee: 30, handlingFee: 9, freeDeliveryAbove: 199, etaMinutes: 15,
    },
    bigbasket: {
      name: 'BigBasket', color: '#84C225', ink: '#fff', live: false, browser: true,
      actor: null, needs: 'area',
      deepLink: (q) => `https://www.bigbasket.com/ps/?q=${encodeURIComponent(q)}`,
      deliveryFee: 0, handlingFee: 5, freeDeliveryAbove: 0, etaMinutes: 120,
    },
    zeptonow_amazon: undefined, // placeholder removed
    amazon: {
      name: 'Amazon Now', color: '#FF9900', ink: '#1a1a1a', live: true,
      actor: 'magicfingers~amazon-product-scraper',
      input: (q, loc, n) => ({ mode: 'SEARCH', searchQueries: [q], domain: 'amazon.in', maxSearchResults: n }),
      needs: 'none',
      deepLink: (q) => `https://www.amazon.in/s?k=${encodeURIComponent(q)}`,
      deliveryFee: 0, handlingFee: 0, freeDeliveryAbove: 0, etaMinutes: 120,
    },
    flipkart: {
      name: 'Flipkart Minutes', color: '#2874F0', ink: '#fff', live: true,
      actor: 'stealth_mode~flipkart-product-search-scraper',
      input: (q, loc, n) => ({ search_queries: [q], max_products: n }),
      needs: 'none',
      deepLink: (q) => `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`,
      deliveryFee: 0, handlingFee: 0, freeDeliveryAbove: 0, etaMinutes: 120,
    },
    jiomart: {
      name: 'JioMart', color: '#008CFF', ink: '#fff', live: true,
      actor: 'aadyantha~jiomart-search-scrapper',
      input: (q, loc, n) => ({ search_strings: [q], max_results: n, location: (loc && loc.city) || 'Gurgaon', proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'IN' } }),
      needs: 'none',
      deepLink: (q) => `https://www.jiomart.com/search/${encodeURIComponent(q)}`,
      deliveryFee: 0, handlingFee: 0, freeDeliveryAbove: 0, etaMinutes: 1440,
    },
  };
  delete PLATFORMS.zeptonow_amazon;

  const PLATFORM_ORDER = ['blinkit', 'zepto', 'instamart', 'amazon', 'flipkart', 'bigbasket', 'jiomart'];

  // ---- Apify fetch (browser, CORS-friendly run-sync endpoint) ---------------
  async function fetchPlatform(platformKey, query, loc, token, maxItems) {
    const meta = PLATFORMS[platformKey];
    if (!meta || !meta.live || !meta.actor || !token) return { ok: false, products: [], reason: 'no-live' };
    const url = `https://api.apify.com/v2/acts/${meta.actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta.input(query, loc, maxItems || 20)),
      });
      if (!res.ok) return { ok: false, products: [], reason: 'http-' + res.status };
      const data = await res.json();
      const arr = Array.isArray(data) ? data : (data.items || []);
      return { ok: true, products: arr.map(r => normalize(r, platformKey)) };
    } catch (e) {
      return { ok: false, products: [], reason: String(e && e.message || e) };
    }
  }

  // ---- Demo dataset ---------------------------------------------------------
  // Realistic-ish prices so the whole flow works with zero setup. Prices in INR.
  // Each entry: per-platform variants for a canonical grocery item.
  const DEMO = {
    potato:   { aliases: ['potato', 'aloo', 'alu', 'aalu'], base: 38, size: '1 kg' },
    tomato:   { aliases: ['tomato', 'tamatar', 'tamater', 'tmatar'], base: 34, size: '1 kg' },
    onion:    { aliases: ['onion', 'pyaaz', 'pyaz', 'pyaz', 'kanda'], base: 36, size: '1 kg' },
    milk:     { aliases: ['milk', 'amul milk', 'amul gold', 'doodh'], base: 67, size: '1 L' },
    bread:    { aliases: ['bread', 'brown bread'], base: 50, size: '400 g' },
    eggs:     { aliases: ['egg', 'eggs', 'anda'], base: 84, size: '12 pcs' },
    butter:   { aliases: ['butter', 'amul butter', 'makhan'], base: 285, size: '500 g' },
    banana:   { aliases: ['banana', 'bananas', 'kela'], base: 44, size: '6 pcs' },
    rice:     { aliases: ['rice', 'basmati', 'chawal'], base: 320, size: '5 kg' },
    sugar:    { aliases: ['sugar', 'cheeni'], base: 45, size: '1 kg' },
    oil:      { aliases: ['oil', 'sunflower oil', 'fortune oil', 'refined oil'], base: 145, size: '1 L' },
    atta:     { aliases: ['atta', 'wheat flour', 'aashirvaad'], base: 240, size: '5 kg' },
    dal:      { aliases: ['dal', 'daal', 'toor dal', 'toor', 'arhar', 'arhar dal', 'moong dal', 'masoor dal', 'chana dal', 'urad dal', 'lentil', 'lentils', 'pulses'], base: 150, size: '1 kg' },
    maida:    { aliases: ['maida', 'flour', 'refined flour', 'all purpose flour', 'plain flour'], base: 55, size: '1 kg' },
    curd:     { aliases: ['curd', 'dahi', 'yogurt'], base: 70, size: '400 g' },
    paneer:   { aliases: ['paneer', 'panir', 'cottage cheese'], base: 95, size: '200 g' },
    cheese:   { aliases: ['cheese', 'amul cheese'], base: 130, size: '200 g' },
    maggi:    { aliases: ['maggi', 'noodles'], base: 60, size: '4 pack' },
    biscuit:  { aliases: ['biscuit', 'parle', 'good day'], base: 30, size: '1 pack' },
    tea:      { aliases: ['tea', 'chai', 'tata tea', 'red label'], base: 270, size: '500 g' },
    coffee:   { aliases: ['coffee', 'nescafe', 'bru'], base: 290, size: '100 g' },
    salt:     { aliases: ['salt', 'namak', 'tata salt'], base: 28, size: '1 kg' },
    apple:    { aliases: ['apple', 'seb'], base: 180, size: '1 kg' },
    cucumber: { aliases: ['cucumber', 'kheera'], base: 30, size: '500 g' },
    lemon:    { aliases: ['lemon', 'nimbu'], base: 25, size: '250 g' },
    ginger:   { aliases: ['ginger', 'adrak'], base: 40, size: '250 g' },
    garlic:   { aliases: ['garlic', 'lehsun'], base: 50, size: '250 g' },
    chips:    { aliases: ['chips', 'lays', 'kurkure'], base: 40, size: '1 pack' },
    water:    { aliases: ['water', 'bisleri', 'water bottle'], base: 20, size: '1 L' },
    coke:     { aliases: ['coke', 'coca cola', 'pepsi', 'cola'], base: 40, size: '750 ml' },
    // ---- expanded ingredient coverage (v2) so recipe baskets are complete ----
    'turmeric':        { aliases: ['turmeric', 'haldi'], base: 60, size: '200 g' },
    'red chilli':      { aliases: ['red chilli', 'lal mirch', 'chilli powder', 'mirch powder'], base: 80, size: '200 g' },
    'garam masala':    { aliases: ['garam masala', 'garam masaala'], base: 90, size: '100 g' },
    'coriander powder': { aliases: ['coriander powder', 'dhania powder'], base: 55, size: '200 g' },
    'pumpkin':     { aliases: ['pumpkin', 'kaddu', 'sitaphal'], base: 40, size: '1 kg' },
    'keema':       { aliases: ['keema', 'mutton mince', 'minced meat'], base: 220, size: '500 g' },
    'mayonnaise':    { aliases: ['mayonnaise', 'mayo'], base: 99, size: '250 g' },
    'brinjal':       { aliases: ['brinjal', 'baingan', 'eggplant', 'aubergine'], base: 40, size: '500 g' },
    'zucchini':      { aliases: ['zucchini', 'courgette'], base: 80, size: '500 g' },
    'cumin':         { aliases: ['cumin', 'jeera'], base: 60, size: '200 g' },
    'oregano':       { aliases: ['oregano', 'mixed herbs'], base: 70, size: '80 g' },
    'paprika':       { aliases: ['paprika', 'red paprika'], base: 90, size: '100 g' },
    'mustard oil':   { aliases: ['mustard oil', 'sarson tel'], base: 150, size: '1 L' },
    'avocado':         { aliases: ['avocado'], base: 120, size: '1 pc' },
    'quinoa':          { aliases: ['quinoa'], base: 260, size: '500 g' },
    'poppy seed':      { aliases: ['poppy seed', 'khus khus'], base: 95, size: '100 g' },
    'lobia':           { aliases: ['lobia', 'black eyed peas'], base: 90, size: '500 g' },
    'papad':           { aliases: ['papad', 'papadum'], base: 55, size: '200 g' },
    'puff sheet':      { aliases: ['puff sheet', 'puff pastry'], base: 140, size: '400 g' },
    'daliya':          { aliases: ['daliya', 'broken wheat', 'cracked wheat'], base: 55, size: '500 g' },
    'mustard seed':    { aliases: ['mustard seed', 'rai', 'sarson'], base: 40, size: '200 g' },
    'mustard greens':  { aliases: ['mustard greens', 'sarson saag'], base: 35, size: '500 g' },
    'radish':          { aliases: ['radish', 'mooli'], base: 25, size: '500 g' },
    'cinnamon':        { aliases: ['cinnamon', 'dalchini'], base: 70, size: '100 g' },
    'spring roll sheet': { aliases: ['spring roll sheet', 'spring roll wrapper'], base: 110, size: '10 pcs' },
    'sprout':          { aliases: ['sprout', 'sprouts', 'moong sprout'], base: 40, size: '250 g' },
    'lasagna sheet':   { aliases: ['lasagna sheet', 'lasagne'], base: 160, size: '500 g' },
    'feta':            { aliases: ['feta', 'feta cheese'], base: 220, size: '200 g' },
    'olive':           { aliases: ['olive', 'olives'], base: 160, size: '450 g' },
    'khoya':           { aliases: ['khoya', 'mawa'], base: 120, size: '250 g' },
    'pistachio':       { aliases: ['pistachio', 'pista'], base: 320, size: '250 g' },
    'custard powder':  { aliases: ['custard powder'], base: 70, size: '300 g' },
    'blueberry':       { aliases: ['blueberry', 'blueberries'], base: 260, size: '125 g' },
    'grapes':          { aliases: ['grapes', 'angoor'], base: 80, size: '500 g' },
    'jam':             { aliases: ['jam', 'mixed fruit jam'], base: 110, size: '500 g' },
    'arbi':            { aliases: ['arbi', 'colocasia', 'taro'], base: 45, size: '500 g' },
    'sausage':         { aliases: ['sausage', 'chicken sausage'], base: 180, size: '250 g' },
    'date':            { aliases: ['date', 'dates', 'khajoor'], base: 140, size: '500 g' },
    'orange':          { aliases: ['orange', 'santra'], base: 70, size: '1 kg' },
    'beetroot':        { aliases: ['beetroot', 'chukandar'], base: 40, size: '500 g' },
    'tuna':            { aliases: ['tuna', 'canned tuna'], base: 180, size: '185 g' },
    'ker sangri':      { aliases: ['ker sangri'], base: 180, size: '200 g' },
    'spring onion':    { aliases: ['spring onion', 'scallion', 'hara pyaaz'], base: 30, size: '100 g' },
    'lemongrass':      { aliases: ['lemongrass'], base: 60, size: '50 g' },
    'galangal':        { aliases: ['galangal', 'thai ginger'], base: 90, size: '100 g' },
    'kaffir lime':     { aliases: ['kaffir lime', 'lime leaf'], base: 70, size: '20 g' },
    'fish sauce':      { aliases: ['fish sauce'], base: 140, size: '200 ml' },
    'oyster sauce':    { aliases: ['oyster sauce'], base: 120, size: '250 g' },
    'sriracha':        { aliases: ['sriracha', 'hot sauce'], base: 130, size: '200 ml' },
    'rice noodles':    { aliases: ['rice noodles', 'flat noodles'], base: 95, size: '400 g' },
    'hoisin':          { aliases: ['hoisin', 'hoisin sauce'], base: 160, size: '250 g' },
    'sesame oil':      { aliases: ['sesame oil', 'til oil'], base: 180, size: '250 ml' },
    'thai curry paste': { aliases: ['thai curry paste', 'red curry paste', 'green curry paste'], base: 170, size: '200 g' },
    'peanut butter':   { aliases: ['peanut butter'], base: 220, size: '340 g' },
    'tomato puree':    { aliases: ['tomato puree', 'tomato paste'], base: 55, size: '200 g' },
    'mozzarella':      { aliases: ['mozzarella', 'pizza cheese'], base: 260, size: '200 g' },
    'parmesan':        { aliases: ['parmesan', 'parmesan cheese'], base: 380, size: '200 g' },
    'tortilla chips':  { aliases: ['tortilla chips', 'nachos'], base: 120, size: '150 g' },
    'kidney red beans': { aliases: ['red kidney beans'], base: 130, size: '500 g' },
    'sour cream':      { aliases: ['sour cream'], base: 150, size: '200 g' },
    'salsa':           { aliases: ['salsa', 'salsa sauce'], base: 160, size: '300 g' },
    'taco shell':      { aliases: ['taco shell', 'tacos'], base: 180, size: '12 pcs' },
    'spinach':       { aliases: ['spinach', 'palak'], base: 30, size: '500 g' },
    'green chilli':  { aliases: ['green chilli', 'hari mirch', 'chilli'], base: 20, size: '100 g' },
    'carrot':        { aliases: ['carrot', 'gajar'], base: 40, size: '500 g' },
    'capsicum':      { aliases: ['capsicum', 'shimla mirch', 'bell pepper'], base: 40, size: '250 g' },
    'chicken':       { aliases: ['chicken', 'murga'], base: 160, size: '500 g' },
    'mutton':        { aliases: ['mutton', 'goat meat'], base: 380, size: '500 g' },
    'fish':          { aliases: ['fish', 'rohu', 'machli'], base: 220, size: '500 g' },
    'prawn':         { aliases: ['prawn', 'jhinga', 'shrimp'], base: 320, size: '250 g' },
    'egg':           { aliases: ['egg whites already? no'], base: 84, size: '12 pcs' },
    'cashew':        { aliases: ['cashew', 'kaju'], base: 180, size: '250 g' },
    'almond':        { aliases: ['almond', 'badam'], base: 230, size: '250 g' },
    'walnut':        { aliases: ['walnut', 'akhrot'], base: 260, size: '250 g' },
    'peanut':        { aliases: ['peanut', 'moongfali', 'groundnut'], base: 60, size: '500 g' },
    'raisin':        { aliases: ['raisin', 'kishmish'], base: 90, size: '250 g' },
    'coconut':       { aliases: ['coconut', 'nariyal', 'coconut milk'], base: 45, size: '1 pc' },
    'besan':         { aliases: ['besan', 'gram flour'], base: 60, size: '500 g' },
    'maida':         { aliases: ['maida', 'flour', 'refined flour', 'all purpose flour', 'plain flour', 'all purpose'], base: 45, size: '1 kg' },
    'sooji':         { aliases: ['sooji', 'suji', 'rava', 'semolina'], base: 48, size: '500 g' },
    'maize flour':   { aliases: ['maize flour', 'makki atta', 'cornmeal'], base: 55, size: '500 g' },
    'corn flour':    { aliases: ['corn flour', 'cornflour', 'corn starch'], base: 40, size: '100 g' },
    'poha':          { aliases: ['poha', 'flattened rice', 'chivda'], base: 50, size: '500 g' },
    'vermicelli':    { aliases: ['vermicelli', 'seviyan'], base: 45, size: '400 g' },
    'oats':          { aliases: ['oats', 'oatmeal'], base: 120, size: '500 g' },
    'pasta':         { aliases: ['pasta', 'penne', 'macaroni', 'spaghetti'], base: 90, size: '500 g' },
    'vinegar':       { aliases: ['vinegar', 'sirka'], base: 45, size: '500 ml' },
    'coriander':     { aliases: ['coriander', 'dhania', 'cilantro'], base: 20, size: '100 g' },
    'mint':          { aliases: ['mint', 'pudina'], base: 20, size: '100 g' },
    'curry leaf':    { aliases: ['curry leaf', 'kadi patta', 'curry leaves'], base: 15, size: '50 g' },
    'fenugreek':     { aliases: ['fenugreek', 'methi', 'kasuri methi'], base: 25, size: '100 g' },
    'basil':         { aliases: ['basil', 'tulsi'], base: 30, size: '50 g' },
    'parsley':       { aliases: ['parsley'], base: 40, size: '50 g' },
    'peas':          { aliases: ['peas', 'matar', 'green peas'], base: 55, size: '500 g' },
    'beans':         { aliases: ['beans', 'french beans', 'green beans'], base: 50, size: '500 g' },
    'cabbage':       { aliases: ['cabbage', 'patta gobi', 'pattagobi', 'bandgobi'], base: 30, size: '1 pc' },
    'cauliflower':   { aliases: ['cauliflower', 'phool gobi', 'gobi', 'ghobi', 'gobhi', 'phulgobi'], base: 40, size: '1 pc' },
    'mushroom':      { aliases: ['mushroom', 'button mushroom'], base: 70, size: '200 g' },
    'lettuce':       { aliases: ['lettuce', 'iceberg'], base: 60, size: '1 pc' },
    'okra':          { aliases: ['okra', 'bhindi', 'lady finger'], base: 40, size: '500 g' },
    'broccoli':      { aliases: ['broccoli'], base: 70, size: '500 g' },
    'corn':          { aliases: ['corn', 'sweet corn', 'bhutta'], base: 45, size: '500 g' },
    'tofu':          { aliases: ['tofu', 'soya paneer'], base: 90, size: '200 g' },
    'bamboo shoot':  { aliases: ['bamboo shoot'], base: 110, size: '200 g' },
    'gourd':         { aliases: ['gourd', 'lauki', 'bottle gourd', 'tinda'], base: 35, size: '1 pc' },
    'mixed vegetable': { aliases: ['mixed vegetable', 'frozen mixed veg'], base: 80, size: '500 g' },
    'jalapeno':      { aliases: ['jalapeno', 'pickled jalapeno'], base: 120, size: '200 g' },
    'toor dal':      { aliases: ['toor dal', 'arhar', 'tur dal'], base: 140, size: '1 kg' },
    'moong dal':     { aliases: ['moong dal', 'yellow moong'], base: 130, size: '1 kg' },
    'chana dal':     { aliases: ['chana dal', 'split gram'], base: 110, size: '1 kg' },
    'urad dal':      { aliases: ['urad dal', 'black gram'], base: 140, size: '1 kg' },
    'masoor dal':    { aliases: ['masoor dal', 'red lentil'], base: 120, size: '1 kg' },
    'chana':         { aliases: ['chana', 'chickpea', 'kabuli chana'], base: 95, size: '500 g' },
    'black chana':   { aliases: ['black chana', 'kala chana'], base: 80, size: '500 g' },
    'kidney beans':  { aliases: ['kidney beans', 'rajma'], base: 130, size: '500 g' },
    'rajma':         { aliases: ['rajma'], base: 130, size: '500 g' },
    'matki':         { aliases: ['matki', 'moth beans'], base: 90, size: '500 g' },
    'soy sauce':     { aliases: ['soy sauce', 'soya sauce'], base: 70, size: '200 ml' },
    'schezwan sauce': { aliases: ['schezwan sauce', 'szechuan sauce'], base: 95, size: '250 g' },
    'tahini':        { aliases: ['tahini', 'sesame paste'], base: 240, size: '300 g' },
    'sesame seed':   { aliases: ['sesame seed', 'til'], base: 60, size: '200 g' },
    'tamarind':      { aliases: ['tamarind', 'imli'], base: 55, size: '200 g' },
    'jaggery':       { aliases: ['jaggery', 'gur'], base: 60, size: '500 g' },
    'honey':         { aliases: ['honey', 'shahad'], base: 180, size: '250 g' },
    'cream':         { aliases: ['cream', 'fresh cream', 'malai'], base: 65, size: '200 ml' },
    'ghee':          { aliases: ['ghee', 'desi ghee'], base: 320, size: '500 ml' },
    'cardamom':      { aliases: ['cardamom', 'elaichi'], base: 180, size: '50 g' },
    'black pepper':  { aliases: ['black pepper', 'kali mirch'], base: 90, size: '100 g' },
    'cocoa':         { aliases: ['cocoa', 'cocoa powder'], base: 150, size: '150 g' },
    'vanilla':       { aliases: ['vanilla', 'vanilla essence'], base: 60, size: '50 ml' },
    'chia seed':     { aliases: ['chia seed', 'chia seeds'], base: 160, size: '200 g' },
    'mango':         { aliases: ['mango', 'aam'], base: 80, size: '1 kg' },
    'pineapple':     { aliases: ['pineapple', 'ananas'], base: 60, size: '1 pc' },
    'strawberry':    { aliases: ['strawberry'], base: 90, size: '200 g' },
    'pomegranate':   { aliases: ['pomegranate', 'anar'], base: 120, size: '500 g' },
    'pav':           { aliases: ['pav', 'bun', 'ladi pav'], base: 35, size: '6 pcs' },
    'sev':           { aliases: ['sev', 'namkeen sev'], base: 45, size: '200 g' },
    'papdi':         { aliases: ['papdi', 'papri'], base: 40, size: '200 g' },
    'sabudana':      { aliases: ['sabudana', 'sago', 'tapioca pearl'], base: 70, size: '500 g' },
    'tortilla':      { aliases: ['tortilla', 'wrap', 'roti wrap'], base: 90, size: '6 pcs' },
    'bell pepper':   { aliases: ['bell pepper', 'colored capsicum'], base: 80, size: '250 g' },
    // ---- v3 ingredient coverage: covers recipe gaps ----
    'ajwain':          { aliases: ['ajwain', 'carom seeds', 'thyme seeds'], base: 40, size: '100 g' },
    'amchur':          { aliases: ['amchur', 'dry mango powder', 'aamchur'], base: 50, size: '100 g' },
    'baking powder':   { aliases: ['baking powder', 'baking soda', 'meetha soda'], base: 45, size: '100 g' },
    'breadcrumb':      { aliases: ['breadcrumb', 'breadcrumbs', 'bread crumbs'], base: 60, size: '200 g' },
    'chocolate':       { aliases: ['chocolate', 'dark chocolate', 'cooking chocolate', 'choco chips'], base: 180, size: '200 g' },
    'cornflakes':      { aliases: ['cornflakes', 'corn flakes', 'breakfast cereal'], base: 95, size: '500 g' },
    'dabeli masala':   { aliases: ['dabeli masala'], base: 55, size: '100 g' },
    'eno':             { aliases: ['eno', 'fruit salt', 'eno fruit salt'], base: 35, size: '100 g' },
    'fennel':          { aliases: ['fennel', 'fennel seeds', 'saunf', 'sonf'], base: 45, size: '100 g' },
    'fennel powder':   { aliases: ['fennel powder', 'saunf powder'], base: 50, size: '100 g' },
    'rasam powder':    { aliases: ['rasam powder', 'rasam masala'], base: 55, size: '100 g' },
    'saffron':         { aliases: ['saffron', 'kesar', 'zafran'], base: 280, size: '1 g' },
    'watermelon':      { aliases: ['watermelon', 'tarbooz', 'tarbuz'], base: 25, size: '1 kg' },
    'wheat':           { aliases: ['wheat', 'gehun', 'gehu'], base: 35, size: '1 kg' },
    'yeast':           { aliases: ['yeast', 'instant yeast', 'dry yeast'], base: 80, size: '100 g' },
  };
  // per-platform price multipliers + rating + availability profile
  const DEMO_PROFILE = {
    blinkit:   { mult: 1.00, rate: 4.3, avail: 0.95 },
    zepto:     { mult: 0.97, rate: 4.2, avail: 0.95 },
    instamart: { mult: 1.03, rate: 4.2, avail: 0.85 },
    amazon:    { mult: 0.92, rate: 4.4, avail: 0.70 },
    flipkart:  { mult: 0.95, rate: 4.3, avail: 0.65 },
    bigbasket: { mult: 0.90, rate: 4.4, avail: 0.90 },
    jiomart:   { mult: 0.88, rate: 4.1, avail: 0.80 },
  };

  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

  // Prefer the REAL live cache (Apify-pulled) when it has this item+store.
  function liveFetch(platformKey, query) {
    const L = (typeof root !== 'undefined' && root.CARTPILOT_LIVE) || (typeof window !== 'undefined' && window.CARTPILOT_LIVE) || null;
    if (!L || !L.byItem) return null;
    const q = String(query).toLowerCase();
    const keys = Object.keys(L.byItem);
    const key = keys.find(k => q.includes(k) || k.includes(q.split(/\s+/)[0]));
    if (!key) return null;
    let rows = L.byItem[key][platformKey];
    if (!rows || !rows.length) return null;
    // Relevance guard: bare queries can surface sponsored/unrelated items.
    const tok = key.split(/\s+/)[0];
    rows = rows.filter(r => String(r.name||'').toLowerCase().includes(tok) || tok.length<3);
    if (!rows.length) return null;
    return rows.map(r => Object.assign({ _platform: platformKey, _live: true, inStock: true,
      etaMinutes: (PLATFORMS[platformKey] && PLATFORMS[platformKey].etaMinutes) || null,
      url: r.url || PLATFORMS[platformKey].deepLink(query) }, r));
  }

  // ---- Smart item resolver: Hindi/Hinglish + fuzzy spelling (general, not per-item) ----
  function _lc(x){ return String(x==null?'':x).toLowerCase().trim(); }
  function _lev(a,b){ a=_lc(a); b=_lc(b); const m=a.length,n=b.length; if(!m)return n; if(!n)return m;
    const dp=Array.from({length:m+1},(_,i)=>[i].concat(Array(n).fill(0)));
    for(let j=0;j<=n;j++)dp[0][j]=j;
    for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){ const c=a[i-1]===b[j-1]?0:1; dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+c);} return dp[m][n]; }
  // Hindi / Hinglish grocery words -> canonical English (maps onto DEMO keys / known items)
  const HINDI = {
    'doodh':'milk','dudh':'milk','anda':'eggs','ande':'eggs','ande wale':'eggs','egg':'eggs','chawal':'rice','chaaval':'rice','chawel':'rice',
    'aata':'atta','atta':'atta','gehu':'atta','namak':'salt','cheeni':'sugar','chini':'sugar','shakkar':'sugar','tel':'oil',
    'dahi':'curd','makhan':'butter','aloo':'potato','aalu':'potato','alu':'potato','pyaz':'onion','pyaaz':'onion','kanda':'onion',
    'tamatar':'tomato','tamaatar':'tomato','tamater':'tomato','adrak':'ginger','lehsun':'garlic','lasun':'garlic','lehsan':'garlic',
    'hari mirch':'green chilli','mirch':'green chilli','mirchi':'green chilli','dhania':'coriander','dhaniya':'coriander','pudina':'mint',
    'nimbu':'lemon','neembu':'lemon','kela':'banana','kele':'banana','seb':'apple','aam':'mango','santra':'orange','angoor':'grapes',
    'gajar':'carrot','matar':'peas','mutter':'peas','gobi':'cauliflower','gobhi':'cauliflower','ghobi':'cauliflower','phool gobi':'cauliflower',
    'phoolgobi':'cauliflower','patta gobi':'cabbage','pattagobi':'cabbage','band gobi':'cabbage','bandgobi':'cabbage','bhindi':'okra','bhindee':'okra',
    'baingan':'brinjal','baigan':'brinjal','lauki':'gourd','ghiya':'gourd','kaddu':'pumpkin','mooli':'radish','palak':'spinach','palakk':'spinach',
    'methi':'fenugreek','shimla mirch':'capsicum','shimla':'capsicum','kheera':'cucumber','khira':'cucumber','chukandar':'beetroot','arbi':'arbi',
    'besan':'besan','maida':'maida','suji':'sooji','sooji':'sooji','rava':'sooji','poha':'poha','sabudana':'sabudana','dalia':'daliya','daliya':'daliya',
    'rajma':'kidney beans','chana':'chana','kabuli chana':'chana','chhole':'chana','chole':'chana','kala chana':'black chana','moong':'moong dal',
    'masoor':'masoor dal','toor':'toor dal','arhar':'toor dal','urad':'urad dal','chai':'tea','chai patti':'tea','chaipatti':'tea','coffee':'coffee',
    'double roti':'bread','bread':'bread','sev':'sev','namkeen':'chips','biscuit':'biscuit','ghee':'ghee','desi ghee':'ghee','malai':'cream',
    'khoya':'khoya','mawa':'khoya','imli':'tamarind','gur':'jaggery','gud':'jaggery','shahad':'honey','til':'sesame seed','jeera':'cumin',
    'zeera':'cumin','haldi':'turmeric','elaichi':'cardamom','dalchini':'cinnamon','kali mirch':'black pepper','rai':'mustard seed','sarson':'mustard oil',
    'sarso':'mustard oil','kaju':'cashew','badam':'almond','pista':'pistachio','akhrot':'walnut','moongfali':'peanut','mungfali':'peanut',
    'kishmish':'raisin','nariyal':'coconut','khajoor':'date','anar':'pomegranate','machhi':'fish','machli':'fish','macchi':'fish','jhinga':'prawn',
    'murga':'chicken','murgh':'chicken','chiken':'chicken','keema':'keema','gosht':'mutton','mutton':'mutton','paneer':'paneer','panir':'paneer',
    'roti':'atta','pav':'pav','soya':'tofu','tofu':'tofu','mushroom':'mushroom','khumb':'mushroom','corn':'corn','makka':'corn','bhutta':'corn',
    'oats':'oats','quinoa':'quinoa','pasta':'pasta','noodles':'noodles','cheese':'cheese','butter':'butter','water':'water','paani':'water'
  };
  function _esc(x){ return String(x).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  function resolveKey(query){
    const q=_lc(query); if(!q) return null;
    const head=q.split(/\s+/)[0];
    const KS=Object.keys(DEMO);
    // 1a) exact alias match (precise — no reverse-substring false hits)
    for(const k of KS){ if(DEMO[k].aliases.some(a=>_lc(a)===q)) return k; }
    // 1b) Hindi/Hinglish exact word -> canonical key
    if(HINDI[q] && DEMO[HINDI[q]]) return HINDI[q];
    // 1c) first token exact alias / hindi
    for(const k of KS){ if(DEMO[k].aliases.some(a=>_lc(a)===head)) return k; }
    if(HINDI[head] && DEMO[HINDI[head]]) return HINDI[head];
    // 2) a full alias WORD appears inside the query (>=3 chars, word boundary)
    const hk=Object.keys(HINDI).sort((a,b)=>b.length-a.length);
    for(const h of hk){ if(h.length>=4 && new RegExp('\\b'+_esc(h)+'\\b').test(q) && DEMO[HINDI[h]]) return HINDI[h]; }
    for(const k of KS){ for(const a of DEMO[k].aliases){ const al=_lc(a); if(al.length>=3 && new RegExp('\\b'+_esc(al)+'\\b').test(q)) return k; } }
    // 3) fuzzy spelling (typos) against aliases + hindi words
    let best=null,bd=99;
    for(const k of KS){ for(const a of DEMO[k].aliases){ const al=_lc(a); const d=Math.min(_lev(q,al),_lev(head,al)); const thr=Math.max(1,Math.floor(al.length*0.34)); if(d<=thr&&d<bd){bd=d;best=k;} } }
    for(const h of hk){ const d=_lev(head,h); const thr=Math.max(1,Math.floor(h.length*0.3)); if(d<=thr&&d<bd&&DEMO[HINDI[h]]){bd=d;best=HINDI[h];} }
    return best;
  }

  function demoFetch(platformKey, query) {
    const _live = liveFetch(platformKey, query);
    if (_live) return _live;
    const key = resolveKey(query);
    if (!key) return [];
    const d = DEMO[key], prof = DEMO_PROFILE[platformKey];
    // deterministic pseudo-variation per platform/item
    const jitter = ((hash(platformKey + key) % 11) - 5) / 100; // -5%..+5%
    const present = (hash(platformKey + key) % 100) / 100 < prof.avail;
    if (!present) return [];
    const price = Math.round(d.base * prof.mult * (1 + jitter));
    const mrp = Math.round(price * 1.12);
    return [{
      name: `${key.charAt(0).toUpperCase() + key.slice(1)} ${d.size}`,
      price, mrp, rating: prof.rate, quantity: d.size, inStock: true,
      etaMinutes: PLATFORMS[platformKey].etaMinutes,
      url: PLATFORMS[platformKey].deepLink(query),
      _platform: platformKey, _demo: true,
    }];
  }

  const api = {
    PLATFORMS, PLATFORM_ORDER, normalize, fetchPlatform, demoFetch, liveFetch, resolveKey,
    DEMO_ITEMS: Object.keys(DEMO),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CartPilotData = api;
})(typeof window !== 'undefined' ? window : globalThis);
