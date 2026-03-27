// Vercel serverless function - handles eBay OAuth token exchange and refresh
// Deploy this to Vercel alongside your index.html

export default async function handler(req, res) {
  // Allow requests from your GitHub Pages site
  res.setHeader('Access-Control-Allow-Origin', 'https://matthewkapel-eng.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REDIRECT_URI } = process.env;

  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Missing eBay credentials in environment variables' });
  }

  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const { action, code, refresh_token } = req.method === 'POST' ? req.body : req.query;

  try {
    // ── Return eBay OAuth authorization URL
    if (action === 'auth_url') {
      // redirect_uri must be the RuName exactly as registered on eBay developer portal
      const ruName = process.env.EBAY_RUNAME || 'Mathew_Kapelush-MathewKa-POKEGR-nytmgu';
      const scopes = encodeURIComponent([
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/buy.browse'
      ].join(' '));
      const authUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${EBAY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(ruName)}&scope=${scopes}&prompt=login`;
      return res.status(200).json({ auth_url: authUrl });
    }

    // ── Exchange authorization code for access + refresh token
    if (action === 'exchange') {
      if (!code) return res.status(400).json({ error: 'Missing authorization code' });

      const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: process.env.EBAY_RUNAME || 'Mathew_Kapelush-MathewKa-POKEGR-nytmgu'
        })
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);

      return res.status(200).json({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in
      });
    }

    // ── Refresh access token using refresh token
    if (action === 'refresh') {
      if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });

      const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refresh_token,
          scope: 'https://api.ebay.com/oauth/api_scope'
        })
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);

      return res.status(200).json({
        access_token: data.access_token,
        expires_in: data.expires_in
      });
    }

    // ── Search eBay completed sold listings (proxy to avoid CORS)
    if (action === 'search') {
      const { access_token, query } = req.method === 'POST' ? req.body : req.query;
      if (!access_token || !query) return res.status(400).json({ error: 'Missing access_token or query' });

      const searchUrl = `https://api.ebay.com/buy/browse/v1/item_summary/search?` +
        `q=${encodeURIComponent(query)}&` +
        `filter=buyingOptions:{AUCTION|FIXED_PRICE},conditionIds:{3000},` +
        `soldItemsOnly:true&` +
        `sort=endDateRecent&` +
        `limit=10&` +
        `fieldgroups=EXTENDED`;

      const response = await fetch(searchUrl, {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);

      // Format the results cleanly
      const items = (data.itemSummaries || []).map(item => ({
        title: item.title,
        price: item.price?.value,
        currency: item.price?.currency,
        soldDate: item.itemEndDate,
        itemUrl: item.itemWebUrl,
        condition: item.condition,
        image: item.image?.imageUrl
      }));

      return res.status(200).json({ items, total: data.total || 0 });
    }

    return res.status(400).json({ error: 'Invalid action. Use: exchange, refresh, or search' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
