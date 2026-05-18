// Vercel serverless function — eBay Browse API proxy for PokeGrade
//
// Architecture fix: The Browse API (buy/browse/v1/item_summary/search) requires
// an APPLICATION token (client credentials grant), NOT a user token.
// The previous authorization-code-grant flow was the root cause of invalid_request.
//
// This handler:
//   GET  ?action=search&query=...   → fetches a fresh app token, then proxies the search
//   POST { action:'search', query } → same, POST variant
//   GET  ?action=health             → sanity check endpoint

export default async function handler(req, res) {
  // CORS — allow requests from GitHub Pages site
  res.setHeader('Access-Control-Allow-Origin', 'https://matthewkapel-eng.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;

  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    return res.status(500).json({
      error: 'Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in Vercel environment variables'
    });
  }

  const params = req.method === 'POST' ? req.body : req.query;
  const { action, query } = params;

  // ── Health check ──────────────────────────────────────────────────────────────
  if (action === 'health') {
    return res.status(200).json({
      ok: true,
      has_client_id: !!EBAY_CLIENT_ID,
      has_client_secret: !!EBAY_CLIENT_SECRET
    });
  }

  // ── Search sold listings ──────────────────────────────────────────────────────
  if (action === 'search') {
    if (!query) {
      return res.status(400).json({ error: 'Missing required parameter: query' });
    }

    try {
      // Step 1: Get a fresh application token via client credentials grant.
      // App tokens are valid for 2 hours; for production you should cache them
      // in a KV store (e.g. Vercel KV / Upstash Redis) to avoid an extra round-trip.
      const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');

      const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'https://api.ebay.com/oauth/api_scope'
        })
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || !tokenData.access_token) {
        console.error('eBay token error:', JSON.stringify(tokenData));
        return res.status(tokenRes.status).json({
          error: 'Failed to obtain eBay application token',
          details: tokenData
        });
      }

      const appToken = tokenData.access_token;

      // Step 2: Search eBay sold / completed listings via Browse API.
      // Note: soldItemsOnly is a filter available on the Browse API.
      // conditionIds:3000 = Used, which covers graded cards.
      // We use EXTENDED fieldgroups to get itemEndDate (sold date).
      const searchUrl = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
      searchUrl.searchParams.set('q', query);
      searchUrl.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE|AUCTION},soldItemsOnly:true');
      searchUrl.searchParams.set('sort', 'endDateRecent');
      searchUrl.searchParams.set('limit', '10');
      searchUrl.searchParams.set('fieldgroups', 'EXTENDED');

      const searchRes = await fetch(searchUrl.toString(), {
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json'
        }
      });

      const searchData = await searchRes.json();

      if (!searchRes.ok) {
        console.error('eBay search error:', JSON.stringify(searchData));
        return res.status(searchRes.status).json({
          error: 'eBay Browse API error',
          details: searchData
        });
      }

      // Step 3: Shape the response for the frontend
      const items = (searchData.itemSummaries || []).map(item => ({
        title: item.title,
        price: item.price?.value,
        currency: item.price?.currency || 'USD',
        soldDate: item.itemEndDate || null,
        itemUrl: item.itemWebUrl,
        condition: item.condition,
        image: item.image?.imageUrl || null
      }));

      return res.status(200).json({
        items,
        total: searchData.total || 0
      });

    } catch (err) {
      console.error('Handler error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Legacy: auth_url / exchange / refresh ─────────────────────────────────────
  // These endpoints are no longer needed because Browse API uses app tokens.
  // Returning a clear explanation instead of silently failing.
  if (action === 'auth_url' || action === 'exchange' || action === 'refresh') {
    return res.status(410).json({
      error: 'This OAuth flow is no longer used.',
      message: 'The eBay Browse API requires an application token (client credentials grant), not a user token. Use action=search directly — the backend handles token acquisition automatically.'
    });
  }

  return res.status(400).json({
    error: 'Invalid action.',
    valid_actions: ['search', 'health']
  });
}
