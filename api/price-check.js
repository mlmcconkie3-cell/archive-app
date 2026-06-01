export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

// ─── Environment ─────────────────────────────────────────────────────────────
const OPENAI_KEY      = process.env.OPENAI_API_KEY;
const EBAY_APP_ID     = process.env.EBAY_APP_ID;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY;
// Default to a reliable public SearXNG instance; override via env var
const SEARXNG         = (process.env.SEARXNG_INSTANCE || 'https://searx.be').replace(/\/$/, '');

// ─── Supabase cache ───────────────────────────────────────────────────────────

async function cacheGet(itemId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const now = new Date().toISOString();
    const url =
      `${SUPABASE_URL}/rest/v1/price_cache` +
      `?item_id=eq.${encodeURIComponent(itemId)}` +
      `&expires_at=gt.${encodeURIComponent(now)}` +
      `&select=*&limit=1`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      signal: AbortSignal.timeout(4000),
    });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

async function cacheSet(itemId, payload) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/price_cache`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        item_id:          itemId,
        item_name:        payload.item,
        category:         payload.category,
        verified_price:   payload.verified_price,
        confidence_score: payload.confidence,
        price_range_low:  payload.price_range?.low ?? null,
        price_range_high: payload.price_range?.high ?? null,
        sources:          payload.sources ?? [],
        created_at:       new Date().toISOString(),
        expires_at:       expires,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[cache write]', e.message);
  }
}

// ─── eBay Finding API (completed/sold listings) ───────────────────────────────

async function queryEbaySold(keywords) {
  if (!EBAY_APP_ID) return [];
  try {
    const params = new URLSearchParams({
      'OPERATION-NAME':              'findCompletedItems',
      'SERVICE-VERSION':             '1.0.0',
      'SECURITY-APPNAME':            EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT':        'JSON',
      keywords,
      'itemFilter(0).name':          'SoldItemsOnly',
      'itemFilter(0).value':         'true',
      'paginationInput.entriesPerPage': '12',
      sortOrder:                     'EndTimeSoonest',
    });
    const r = await fetch(
      `https://svcs.ebay.com/services/search/FindingService/v1?${params}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await r.json();
    const items =
      data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item ?? [];
    return items
      .map(i => {
        const raw =
          i?.sellingStatus?.[0]?.soldFor?.[0]?.__value__ ??
          i?.sellingStatus?.[0]?.currentPrice?.[0]?.__value__;
        const date =
          (i?.listingInfo?.[0]?.endTime?.[0] ?? '')
            .split('T')[0] || new Date().toISOString().split('T')[0];
        return { source: 'eBay Sold', price: parseFloat(raw), date, weight: 1.5 };
      })
      .filter(p => isFinite(p.price) && p.price > 0);
  } catch (e) {
    console.error('[eBay]', e.message);
    return [];
  }
}

// ─── SearXNG search ───────────────────────────────────────────────────────────

async function searxSearch(query) {
  try {
    const url =
      `${SEARXNG}/search` +
      `?q=${encodeURIComponent(query)}` +
      `&format=json&categories=general&language=en-US`;
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ArchiveApp/1.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return data?.results ?? [];
  } catch (e) {
    console.error('[searx]', e.message);
    return [];
  }
}

// Extract dollar prices from SearXNG result snippets
function extractPrices(results, sourceName, weight = 1.0, { minVal = 5, maxVal = 500000 } = {}) {
  const prices = [];
  const re = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
  const today = new Date().toISOString().split('T')[0];
  for (const r of results.slice(0, 6)) {
    const text = `${r.title ?? ''} ${r.content ?? ''}`;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val >= minVal && val <= maxVal) {
        prices.push({ source: sourceName, price: val, date: today, weight });
        if (prices.length >= 3) break;
      }
    }
  }
  return prices;
}

// ─── Category routing ─────────────────────────────────────────────────────────

async function priceSneakers(name) {
  const [ebay, stockxR, soldR] = await Promise.all([
    queryEbaySold(name),
    searxSearch(`"${name}" site:stockx.com`),
    searxSearch(`"${name}" sold price sneakers resale`),
  ]);
  return [
    ...ebay,
    ...extractPrices(stockxR, 'StockX', 1.3, { minVal: 20 }),
    ...extractPrices(soldR, 'Sneaker Market', 0.9, { minVal: 20 }),
  ];
}

async function priceTradingCards(name) {
  const [ebay, psaR, soldR] = await Promise.all([
    queryEbaySold(name),
    searxSearch(`"${name}" PSA grade price sold`),
    searxSearch(`"${name}" sold eBay trading card value`),
  ]);
  return [
    ...ebay,
    ...extractPrices(psaR, 'PSA Market', 1.2, { minVal: 1 }),
    ...extractPrices(soldR, 'Card Market', 0.9, { minVal: 1 }),
  ];
}

async function priceWatches(name) {
  const [ebay, chrono24R, wcR] = await Promise.all([
    queryEbaySold(name),
    searxSearch(`"${name}" site:chrono24.com price`),
    searxSearch(`"${name}" watchcharts market value`),
  ]);
  return [
    ...ebay,
    ...extractPrices(chrono24R, 'Chrono24', 1.3, { minVal: 100 }),
    ...extractPrices(wcR, 'WatchCharts', 1.1, { minVal: 100 }),
  ];
}

async function priceLuxury(name) {
  const [ebay, rrrR, resaleR] = await Promise.all([
    queryEbaySold(name),
    searxSearch(`"${name}" site:therealreal.com`),
    searxSearch(`"${name}" site:vestiairecollective.com resale value`),
  ]);
  return [
    ...ebay,
    ...extractPrices(rrrR, 'The RealReal', 1.2, { minVal: 50 }),
    ...extractPrices(resaleR, 'Vestiaire', 1.1, { minVal: 50 }),
  ];
}

async function priceTech(name) {
  const [ebay, swappaR, usedR] = await Promise.all([
    queryEbaySold(name),
    searxSearch(`"${name}" site:swappa.com`),
    searxSearch(`"${name}" used value current market price`),
  ]);
  return [
    ...ebay,
    ...extractPrices(swappaR, 'Swappa', 1.2, { minVal: 10 }),
    ...extractPrices(usedR, 'Used Market', 0.9, { minVal: 10 }),
  ];
}

async function priceCollectibles(name) {
  const [ebay, auctionR, collR] = await Promise.all([
    queryEbaySold(name),
    searxSearch(`"${name}" auction hammer price sold`),
    searxSearch(`"${name}" collector market value`),
  ]);
  return [
    ...ebay,
    ...extractPrices(auctionR, 'Auction Market', 1.2, { minVal: 1 }),
    ...extractPrices(collR, 'Collector Market', 1.0, { minVal: 1 }),
  ];
}

// ─── Route by category ────────────────────────────────────────────────────────

async function fetchPrices(name, category) {
  const c = category.toLowerCase();
  if (c.includes('sneak') || c.includes('shoe'))                      return priceSneakers(name);
  if (c.includes('card') || c.includes('pokemon') || c.includes('sport')) return priceTradingCards(name);
  if (c.includes('watch'))                                            return priceWatches(name);
  if (c.includes('luxury') || c.includes('bag') || c.includes('handbag')) return priceLuxury(name);
  if (c.includes('tech') || c.includes('electronic') || c.includes('phone') || c.includes('laptop')) return priceTech(name);
  return priceCollectibles(name);
}

// ─── Confidence algorithm ─────────────────────────────────────────────────────

function calculateConfidence(rawPrices) {
  const valid = rawPrices.filter(p => isFinite(p.price) && p.price > 0);
  if (!valid.length) return null;

  // Remove outliers: prices beyond 2 standard deviations
  const vals = valid.map(p => p.price);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  const stdDev = Math.sqrt(variance);
  const filtered = valid.filter(p => Math.abs(p.price - mean) <= 2 * stdDev);
  if (!filtered.length) return null;

  // Weighted average: source weight × recency multiplier
  let weightedSum = 0, totalWeight = 0;
  const now = Date.now();
  for (const p of filtered) {
    const ageMs  = now - new Date(p.date || now).getTime();
    const ageDays = ageMs / 86_400_000;
    const recency = ageDays <= 30 ? 1.5 : ageDays <= 60 ? 1.0 : 0.7;
    const w = (p.weight ?? 1.0) * recency;
    weightedSum += p.price * w;
    totalWeight += w;
  }

  const verified = Math.round(weightedSum / totalWeight);
  const filteredVals = filtered.map(p => p.price);
  const low  = Math.min(...filteredVals);
  const high = Math.max(...filteredVals);
  const spread = verified > 0 ? (high - low) / verified : 1;
  const n = filtered.length;

  // Confidence: source count + price agreement
  let confidence;
  if      (n >= 4 && spread < 0.15) confidence = 94;
  else if (n >= 4 && spread < 0.30) confidence = 87;
  else if (n >= 3 && spread < 0.25) confidence = 82;
  else if (n >= 3 && spread < 0.45) confidence = 74;
  else if (n >= 2 && spread < 0.40) confidence = 70;
  else if (n >= 2)                  confidence = 62;
  else                              confidence = 45;

  const label =
    confidence >= 90 ? 'High Confidence' :
    confidence >= 70 ? 'Medium Confidence' :
                       'Low Confidence';

  return {
    verified_price:   verified,
    confidence,
    confidence_label: label,
    price_range:      { low: Math.round(low * 0.95), high: Math.round(high * 1.05) },
    sources:          filtered.map(p => ({
      name:  p.source,
      price: Math.round(p.price),
      date:  p.date ?? new Date().toISOString().split('T')[0],
    })),
    sources_checked:  n,
    last_updated:     new Date().toISOString(),
  };
}

// ─── GPT-4o fallback estimate ─────────────────────────────────────────────────
// Used when fewer than 2 market sources return data.

async function gptFallback(itemName, category, condition) {
  if (!OPENAI_KEY) return null;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content:
            `You are an expert resale market appraiser. Estimate the current US resale market value for:\n` +
            `Item: ${itemName}\nCategory: ${category}\nCondition: ${condition}\n\n` +
            `Return ONLY valid JSON — no markdown:\n` +
            `{"verified_price":number,"price_range_low":number,"price_range_high":number,"confidence":number}`,
        }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.replace(/```json|```/g, '').trim();
    const est  = JSON.parse(text);
    return {
      verified_price:   Math.round(est.verified_price),
      confidence:       Math.min(40, est.confidence ?? 35),
      confidence_label: 'Low Confidence',
      price_range:      { low: est.price_range_low, high: est.price_range_high },
      sources:          [{ name: 'AI Estimate', price: Math.round(est.verified_price), date: new Date().toISOString().split('T')[0] }],
      sources_checked:  1,
      last_updated:     new Date().toISOString(),
    };
  } catch (e) {
    console.error('[gptFallback]', e.message);
    return null;
  }
}

// ─── Sources detail builder ───────────────────────────────────────────────────
// Takes the final (averaged, outlier-filtered) sources array and the category,
// and returns a comprehensive per-source status list for the UI to render.
// Works for both live results and cache-hit reconstruction.

function expectedSources(category) {
  const c = category.toLowerCase();
  if (c.includes('sneak') || c.includes('shoe'))
    return ['eBay Sold', 'StockX', 'Sneaker Market'];
  if (c.includes('card') || c.includes('pokemon') || c.includes('sport'))
    return ['eBay Sold', 'PSA Market', 'Card Market'];
  if (c.includes('watch'))
    return ['eBay Sold', 'Chrono24', 'WatchCharts'];
  if (c.includes('luxury') || c.includes('bag') || c.includes('handbag'))
    return ['eBay Sold', 'The RealReal', 'Vestiaire'];
  if (c.includes('tech') || c.includes('electronic') || c.includes('phone') || c.includes('laptop'))
    return ['eBay Sold', 'Swappa', 'Used Market'];
  return ['eBay Sold', 'Auction Market', 'Collector Market'];
}

function buildSourcesDetail(sources, category) {
  const expected   = expectedSources(category);
  const sourceMap  = Object.fromEntries((sources ?? []).map(s => [s.name, s]));
  const detail     = [];

  for (const name of expected) {
    if (name === 'eBay Sold' && !EBAY_APP_ID) {
      detail.push({ name, status: 'pending', note: 'EBAY_APP_ID not configured' });
    } else if (sourceMap[name]) {
      detail.push({ name, status: 'ok', price: sourceMap[name].price, date: sourceMap[name].date });
    } else {
      detail.push({ name, status: 'empty', note: 'No listings found' });
    }
  }

  // AI fallback always goes last, tagged separately
  if (sourceMap['AI Estimate']) {
    detail.push({ name: 'AI Estimate', status: 'fallback', price: sourceMap['AI Estimate'].price, note: 'Fallback — fewer than 2 market sources' });
  }

  return detail;
}

// ─── Stable item ID for cache keying ─────────────────────────────────────────

function makeItemId(name, cat, cond) {
  return `${name}|${cat}|${cond}`
    .toLowerCase()
    .replace(/[^a-z0-9|]/g, '_')
    .slice(0, 200);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { item_name, category, condition } = req.body ?? {};
  if (!item_name) return res.status(400).json({ error: 'item_name is required' });

  const cat  = (category  || 'Other').trim();
  const cond = (condition || 'Good').trim();
  const id   = makeItemId(item_name, cat, cond);

  // ── 1. Cache check ──────────────────────────────────────────────
  const hit = await cacheGet(id);
  if (hit) {
    const cl = hit.confidence_score >= 90 ? 'High Confidence'
             : hit.confidence_score >= 70 ? 'Medium Confidence'
             : 'Low Confidence';
    return res.status(200).json({
      item:             hit.item_name,
      category:         hit.category,
      condition:        cond,
      verified_price:   hit.verified_price,
      confidence:       hit.confidence_score,
      confidence_label: cl,
      price_range:      { low: hit.price_range_low, high: hit.price_range_high },
      sources:          hit.sources,
      sources_detail:   buildSourcesDetail(hit.sources, hit.category),
      sources_checked:  (hit.sources ?? []).length,
      last_updated:     hit.created_at,
      cached:           true,
    });
  }

  // ── 2. Fetch from all sources in parallel ───────────────────────
  let rawPrices = [];
  try {
    rawPrices = await fetchPrices(item_name, cat);
  } catch (e) {
    console.error('[fetchPrices]', e.message);
  }

  // ── 3. Insufficient data → GPT fallback ────────────────────────
  let result = calculateConfidence(rawPrices);
  if (!result || rawPrices.length < 2) {
    console.warn(`[price-check] insufficient data (${rawPrices.length} sources) for "${item_name}" — using GPT fallback`);
    result = await gptFallback(item_name, cat, cond);
  }

  // ── 4. Nothing worked at all ───────────────────────────────────
  if (!result) {
    const emptySources = rawPrices.map(p => ({ name: p.source, price: Math.round(p.price), date: p.date }));
    return res.status(200).json({
      item:             item_name,
      category:         cat,
      condition:        cond,
      verified_price:   null,
      confidence:       0,
      confidence_label: 'Insufficient Data',
      price_range:      { low: null, high: null },
      sources:          emptySources,
      sources_detail:   buildSourcesDetail(emptySources, cat),
      sources_checked:  rawPrices.length,
      last_updated:     new Date().toISOString(),
      note:             'Not enough market data — add a purchase price manually',
    });
  }

  // ── 5. Build and cache the response ───────────────────────────
  const response = {
    item: item_name, category: cat, condition: cond, ...result,
    sources_detail: buildSourcesDetail(result.sources, cat),
  };
  await cacheSet(id, response);

  return res.status(200).json(response);
}
