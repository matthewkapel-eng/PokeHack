// Vercel serverless function — PriceCharting API proxy for PokeGrade
//
// PriceCharting requires a paid subscription token (Pro plan, $20/mo).
// We proxy requests server-side so the token is never exposed to the client.
//
// Endpoints:
//   GET  ?action=search&q=charizard+base+set+psa+10   → search products
//   GET  ?action=product&id=12345                      → get single product prices
//   GET  ?action=health                                → sanity check
//
// PriceCharting API docs: https://www.pricecharting.com/api-documentation
//
// Key price fields for Pokémon cards:
//   loose-price       → Ungraded
//   graded-price      → PSA 9
//   manual-only-price → PSA 10
//   box-only-price    → PSA 9.5
//   bgs-10-price      → BGS 10
//   condition-17-price→ CGC 10
//   condition-18-price→ SGC 10

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://matthewkapel-eng.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { PRICECHARTING_TOKEN } = process.env;

  if (!PRICECHARTING_TOKEN) {
    return res.status(500).json({
      error: 'Missing PRICECHARTING_TOKEN in Vercel environment variables.',
      setup: 'Get your token at pricecharting.com → Subscriptions → API/Download button.'
    });
  }

  const params = req.method === 'POST' ? req.body : req.query;
  const { action, q, id } = params;

  // ── Health check ──────────────────────────────────────────────────────────────
  if (action === 'health') {
    return res.status(200).json({ ok: true, has_token: !!PRICECHARTING_TOKEN });
  }

  // ── Search products ───────────────────────────────────────────────────────────
  if (action === 'search') {
    if (!q) return res.status(400).json({ error: 'Missing required parameter: q' });

    try {
      const url = `https://www.pricecharting.com/api/products?t=${PRICECHARTING_TOKEN}&q=${encodeURIComponent(q)}`;
      const r = await fetch(url);
      const data = await r.json();

      if (!r.ok || data.status === 'error') {
        return res.status(r.status || 400).json({ error: data['error-message'] || 'PriceCharting search failed', raw: data });
      }

      // Shape results — filter to Pokémon cards only
      const products = (data.products || [])
        .filter(p => {
          const cn = (p['console-name'] || '').toLowerCase();
          return cn.includes('pokemon') || cn.includes('pokémon');
        })
        .slice(0, 10)
        .map(p => ({
          id: p.id,
          name: p['product-name'],
          set: p['console-name'],
          url: `https://www.pricecharting.com/game/${encodeURIComponent(p['console-name'])}/${encodeURIComponent(p['product-name'])}`
        }));

      return res.status(200).json({ products });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Get single product prices ─────────────────────────────────────────────────
  if (action === 'product') {
    if (!id && !q) return res.status(400).json({ error: 'Missing required parameter: id or q' });

    try {
      const param = id ? `id=${encodeURIComponent(id)}` : `q=${encodeURIComponent(q)}`;
      const url = `https://www.pricecharting.com/api/product?t=${PRICECHARTING_TOKEN}&${param}`;
      const r = await fetch(url);
      const data = await r.json();

      if (!r.ok || data.status === 'error') {
        return res.status(r.status || 400).json({ error: data['error-message'] || 'PriceCharting product fetch failed', raw: data });
      }

      // Convert pennies to dollars and return clean price object
      const cents = (key) => data[key] != null ? (data[key] / 100).toFixed(2) : null;

      return res.status(200).json({
        id: data.id,
        name: data['product-name'],
        set: data['console-name'],
        releaseDate: data['release-date'] || null,
        prices: {
          ungraded:  cents('loose-price'),
          psa8:      cents('new-price'),
          psa9:      cents('graded-price'),
          psa9_5:    cents('box-only-price'),
          psa10:     cents('manual-only-price'),
          bgs10:     cents('bgs-10-price'),
          cgc10:     cents('condition-17-price'),
          sgc10:     cents('condition-18-price'),
        },
        salesVolume: data['sales-volume'] || null,
        pcUrl: `https://www.pricecharting.com/game/${encodeURIComponent(data['console-name'] || '')}/${encodeURIComponent(data['product-name'] || '')}`
      });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({
    error: 'Invalid action.',
    valid_actions: ['search', 'product', 'health']
  });
}
