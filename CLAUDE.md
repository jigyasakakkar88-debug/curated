# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run locally (requires Vercel CLI)
vercel dev

# Deploy
vercel --prod
```

There are no tests and no linter configured.

## Architecture

**Curated** is a personal Indian fashion aggregator. It fetches live products from Shopify brand storefronts and surfaces them in a curated feed. There is no database — all persistent state lives as JSON files committed to this GitHub repo itself, read and written by the API handlers via the GitHub Contents API.

### State files (committed to this repo, read at runtime)
- `brands.json` — array of `{ id, name, url }` objects; the brands whose products are fetched
- `recommendations.json` — `{ pending: [...], rejected: [...] }` from the Discover feature
- `settings.json` — `{ saleThreshold: number, newDays: number }` (used by `products.js`)

### Vercel serverless functions (`api/`)
| File | Purpose |
|------|---------|
| `products.js` | Fetches all products from every brand's `/products.json` Shopify endpoint, enriches with `isNew`/`isSale`/`discountPct`, returns unified feed. Cached 1h. |
| `admin.js` | CRUD for `brands.json` and `settings.json`. Also has a Shopify store tester (`?action=test`). |
| `recommendations.js` | GET pending recs; POST to accept (→ adds to `brands.json`) or reject (→ adds id to `rejected[]`). |
| `discover.js` | Agentic brand discovery loop: Claude (claude-sonnet-4-6) uses `search_web` (SerpAPI) and `save_recommendations` tools across up to 12 turns to find new Indian fashion brand storefronts matching an optional style brief. Runs up to 120s. |
| `refresh.js` | Weekly cron (Monday 6am UTC via `vercel.json`) — counts products per brand, used to confirm brands are still live. |

### Frontends (`public/`)
- `index.html` — the main product feed, calls `GET /api/products`
- `admin.html` — admin panel (password-gated), calls all admin/discover/recommendations endpoints

### Auth
All API routes check `Authorization: Bearer <ADMIN_PASSWORD>`. The refresh endpoint also accepts `Bearer <CRON_SECRET>` for the Vercel cron.

### Environment variables required
```
GITHUB_TOKEN        # Fine-grained PAT with read/write on this repo
GITHUB_REPO         # e.g. jigyasakakkar88/curated
ADMIN_PASSWORD      # Admin panel + API password
ANTHROPIC_API_KEY   # For discover.js agentic loop
SERPAPI_KEY         # For web search in discover.js
CRON_SECRET         # Set by Vercel automatically for cron auth
```

### Key patterns
- **GitHub as database**: every write to `brands.json` / `recommendations.json` / `settings.json` creates a git commit. Always fetch the current SHA before writing to avoid conflicts — see `getFileSha()` / `readFileWithSha()` in each handler.
- **Shopify product fetching**: uses the public `/products.json?limit=250&page=N` endpoint (no auth needed). Paginates up to page 5. Skips gift-card product types.
- **Discover agentic loop**: Claude drives the search autonomously. The `SKIP_DOMAINS` set in `discover.js` is applied both to filter search results returned to Claude and referenced in the system prompt so Claude avoids those domains itself.
- **No build step**: the project is pure Node.js serverless functions + static HTML. What you see is what gets deployed.
