// Vercel serverless function - real eBay SOLD listings proxy for PokeGrade
//
// The Browse API (item_summary/search) only returns ACTIVE listings; the old
// code passed soldItemsOnly:true, which the Browse API silently ignores, so the
// app was showing asking prices as if they were sold comps.
//
// This handler uses the eBay Finding API findCompletedItems operation, which
// returns items that actually ended (sold) within the last ~90 days. It needs
// only the eBay App ID (= EBAY_CLIENT_ID, same value already configured), no
// user OAuth.
//
// Endpoints:
//   GET  ?action=search&query=...&limit=50            -> real sold listings + stats
//   POST { action:'batch', queries:[{key,query,limit}] } -> many queries, one call
//   GET  ?action=health                                -> sanity check

export const config = { maxDuration: 60 };

const FINDING_URL = 'https://svcs.ebay.com/services/search/FindingService/v1';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Stats ────────────────────────────────────────────────────────────────────
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function computeStats(items) {
  const priced = items.filter(i => i.price != null && i.soldDate);
  const prices = priced.map(i => i.price);
  if (!prices.length) return { count: 0, median: null, avg: null, min: null, max: null, weekly: [] };

  // Weekly buckets, oldest -> newest, over the window covered by the sales
  const now = Date.now();
  const weekMs = 7 * 24 * 3600 * 1000;
  const buckets = new Map();
  for (const it of priced) {
    const t = new Date(it.soldDate).getTime();
    if (isNaN(t)) continue;
    const weekIdx = Math.floor((now - t) / weekMs); // 0 = current week
    if (!buckets.has(weekIdx)) buckets.set(weekIdx, []);
    buckets.get(weekIdx).push(it.price);
  }
  const maxIdx = Math.max(...buckets.keys());
  const weekly = [];
  for (let i = Math.min(maxIdx, 12); i >= 0; i--) {
    const arr = buckets.get(i);
    weekly.push({
      weekStart: new Date(now - (i + 1) * weekMs).toISOString().substring(0, 10),
      median: arr ? Math.round(median(arr)) : null,
      count: arr ? arr.length : 0
    });
  }

  return {
    count: prices.length,
    median: Math.round(median(prices)),
    avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    min: Math.round(Math.min(...prices)),
    max: Math.round(Math.max(...prices)),
    weekly
  };
}

// ── Finding API: findCompletedItems (real sold listings) ────────────────────
async function findCompleted(query, limit, appId) {
  const u = new URL(FINDING_URL);
  u.searchParams.set('OPERATION-NAME', 'findCompletedItems');
  u.searchParams.set('SERVICE-VERSION', '1.0.0');
  u.searchParams.set('SECURITY-APPNAME', appId);
  u.searchParams.set('RESPONSE-DATA-FORMAT', 'JSON');
  u.searchParams.set('REST-PAYLOAD', '');
  u.searchParams.set('keywords', query);
  u.searchParams.set('itemFilter(0).name', 'SoldItemsOnly');
  u.searchParams.set('itemFilter(0).value', 'true');
  u.searchParams.set('sortOrder', 'EndTimeSoonest');
  u.searchParams.set('paginationInput.entriesPerPage', String(Math.min(limit || 50, 100)));
  u.searchParams.set('paginationInput.pageNumber', '1');

  const r = await fetch(u.toString(), { headers: { 'User-Agent': 'PokeGrade/2.0' } });
  if (!r.ok) throw new Error('eBay Finding API HTTP ' + r.status);
  const data = await r.json();

  const resp = data && data.findCompletedItemsResponse && data.findCompletedItemsResponse[0];
  if (!resp) throw new Error('Unexpected Finding API response');
  if ((resp.ack || [])[0] !== 'Success') {
    const err = resp.errorMessage && resp.errorMessage[0] && resp.errorMessage[0].error && resp.errorMessage[0].error[0];
    throw new Error('eBay Finding API: ' + ((err && err.message && err.message[0]) || 'request failed'));
  }

  const rawItems = (resp.searchResult && resp.searchResult[0] && resp.searchResult[0].item) || [];
  const items = rawItems.map(it => {
    const selling = (it.sellingStatus && it.sellingStatus[0]) || {};
    const listing = (it.listingInfo && it.listingInfo[0]) || {};
    const priceNode = (selling.currentPrice && selling.currentPrice[0]) || {};
    return {
      title: (it.title || [])[0] || null,
      price: priceNode.__value__ != null ? parseFloat(priceNode.__value__) : null,
      currency: priceNode['@currencyId'] || 'USD',
      soldDate: (listing.endTime || [])[0] || null,
      itemUrl: (it.viewItemURL || [])[0] || null,
      condition: it.condition && it.condition[0] && it.condition[0].conditionDisplayName
        ? it.condition[0].conditionDisplayName[0] : null,
      image: (it.galleryURL || [])[0] || null,
      sellingState: (selling.sellingState || [])[0] || null
    };
  }).filter(it => it.sellingState === 'EndedWithSales' || it.sellingState == null);

  return { items, stats: computeStats(items) };
}

// ── Fallback: Marketplace Insights API (requires approved scope) ─────────────
async function marketplaceInsights(query, limit, clientId, clientSecret) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) throw new Error('eBay app token failed');

  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const u = new URL('https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search');
  u.searchParams.set('q', query);
  u.searchParams.set('filter', `lastSoldDate:[${since}..]`);
  u.searchParams.set('limit', String(Math.min(limit || 50, 100)));
  u.searchParams.set('sort', '-lastSoldDate');

  const r = await fetch(u.toString(), {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }
  });
  if (!r.ok) throw new Error('Marketplace Insights HTTP ' + r.status);
  const data = await r.json();

  const items = (data.itemSales || []).map(it => ({
    title: it.title || null,
    price: it.lastSoldPrice && it.lastSoldPrice.value != null ? parseFloat(it.lastSoldPrice.value) : null,
    currency: (it.lastSoldPrice && it.lastSoldPrice.currency) || 'USD',
    soldDate: it.lastSoldDate || null,
    itemUrl: it.itemHref || null,
    condition: it.condition || null,
    image: it.image && it.image.imageUrl || null,
    sellingState: 'EndedWithSales'
  }));
  return { items, stats: computeStats(items), via: 'marketplace_insights' };
}

async function soldSearch(query, limit, env) {
  try {
    const out = await findCompleted(query, limit, env.EBAY_CLIENT_ID);
    out.via = 'finding_api';
    return out;
  } catch (e1) {
    try {
      return await marketplaceInsights(query, limit, env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET);
    } catch (e2) {
      return { items: [], stats: computeStats([]), error: e1.message + ' | fallback: ' + e2.message };
    }
  }
}

// ── Concurrency-limited map ──────────────────────────────────────────────────
async function pool(tasks, size) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in Vercel environment variables' });
  }

  const params = req.method === 'POST' ? req.body : req.query;
  const { action } = params;

  if (action === 'health') {
    return res.status(200).json({ ok: true, has_client_id: !!EBAY_CLIENT_ID, has_client_secret: !!EBAY_CLIENT_SECRET });
  }

  // ── Single search ──────────────────────────────────────────────────────────
  if (action === 'search') {
    const query = params.query;
    if (!query) return res.status(400).json({ error: 'Missing required parameter: query' });
    const limit = parseInt(params.limit || '50', 10);
    const out = await soldSearch(query, limit, { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET });
    return res.status(200).json({ query, via: out.via || null, error: out.error || null, items: out.items, stats: out.stats });
  }

  // ── Batch search ───────────────────────────────────────────────────────────
  if (action === 'batch') {
    let queries = params.queries;
    if (typeof queries === 'string') { try { queries = JSON.parse(queries); } catch (e) { queries = null; } }
    if (!Array.isArray(queries) || !queries.length) {
      return res.status(400).json({ error: 'Missing required parameter: queries (array of {key, query, limit?})' });
    }
    if (queries.length > 80) return res.status(400).json({ error: 'Too many queries in one batch (max 80)' });

    const tasks = queries.map(q => async () => {
      const out = await soldSearch(String(q.query || ''), q.limit || 40, { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET });
      return [q.key, { via: out.via || null, error: out.error || null, items: out.items.slice(0, 60), stats: out.stats }];
    });
    const pairs = await pool(tasks, 6);
    return res.status(200).json({ results: Object.fromEntries(pairs) });
  }

  return res.status(400).json({ error: 'Invalid action.', valid_actions: ['search', 'batch', 'health'] });
}
