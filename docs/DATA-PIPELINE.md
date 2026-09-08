# PokeGrade Data Pipeline

Two-tier architecture. Everything below uses real data only - no estimates.

## Tier 1: Tracked watchlist (CARDS in index.html)

94 cards. Per-card real data:

| Signal | Source | Refresh |
|---|---|---|
| PSA 10 pop + total graded | GemRate (search API + per-card PSA breakdown) | Weekly - needs a real browser (Cloudflare blocks plain HTTP). Agent-assisted or a browser-capable runner. |
| Prices, 90d momentum, sales velocity | eBay findCompletedItems via `/api/ebay-token.js` | Live on every app open |
| Sales across auction houses (ALT, Fanatics, Goldin, Heritage) | Card Ladder Pro snapshot in `CL_SALES` | Manual/agent pull; server-side automation needs the user's Card Ladder credentials in an env var (gated on user approval) |
| Raw market prices | TCGplayer via catalog snapshot | Weekly via GitHub Action (below) |

## Tier 2: Full catalog (catalog/)

20,372 cards, 174 sets (Pokemon TCG API snapshot). Lazily loaded per set.
Any card gets live eBay sold comps on demand in the detail modal.

Refresh: `.github/workflows/refresh-catalog.yml` (weekly). Re-pulls sets +
cards, rebuilds `index.json`/`sets.json`, commits if changed. No secrets needed.

## Weekly watchlist refresh (planned, needs one user decision)

A `refresh-watchlist` workflow will snapshot eBay sold medians per tracked card
into `watchlist-sales.json` so the app loads with fresh prices before the live
fetch completes. Needs the eBay App ID added as a GitHub secret
(`EBAY_CLIENT_ID`, same value already configured on Vercel). Card Ladder depth
stays a separate, credential-gated step.

## Adding cards to the watchlist

Mechanical, real-data only: pick from catalog/ by TCGplayer market price,
generate query templates, pull GemRate pops (browser-assisted), mark CL depth
as pending. See commit history for the generator pattern.
