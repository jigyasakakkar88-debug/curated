# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (@anthropic-ai/sdk, algoliasearch v5)
npm install

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
- `user_feedback.json`, `discovery_log.json`, `discovery_learnings.json` — Brand Scout feedback, run log and learnings

### Vercel serverless functions (`api/`)
| File | Purpose |
|------|---------|
| `products.js` | Fetches all products from every brand's `/products.json` Shopify endpoint, enriches with `isNew`/`isSale`/`discountPct`, returns unified feed. Cached 1h. |
| `admin.js` | CRUD for `brands.json` and `settings.json`. Also has a Shopify store tester (`?action=test`). |
| `recommendations.js` | GET pending recs; POST to accept (→ adds to `brands.json`) or reject (→ adds id to `rejected[]`). |
| `discover.js` | Agentic brand discovery loop: Claude (claude-sonnet-4-6) uses `search_web` (SerpAPI) and `save_recommendations` tools across up to 12 turns to find new Indian fashion brand storefronts matching an optional style brief. Runs up to 120s. |
| `refresh.js` | Weekly cron (Monday 6am UTC via `vercel.json`) — counts products per brand, used to confirm brands are still live. |

### Shared modules (`lib/`) — Stylist build, in progress
| File | Purpose |
|------|---------|
| `github.js` | Shared GitHub Contents API helpers: `readFileWithSha`, `readJson`, `writeJson`, `updateJson` (retries once on a 409 SHA conflict). Branch from `GITHUB_BRANCH` (default `main`). Existing `api/*.js` handlers still carry their own copies; new code should use this. |
| `pricing.js` | Claude prices (USD/MTok) for `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-4-5`, plus `USD_INR` and `costINR(model, usage)`. Re-check `checkedOn` against the pricing page when models change. |

The Stylist design and build plan is in `docs/STYLIST.md`; the health check, open issues and later list are in `docs/SETUP_STATUS.md`.

### Frontends (`public/`)
- `index.html` — the main product feed, calls `GET /api/products`
- `admin.html` — admin panel (password-gated), calls all admin/discover/recommendations endpoints. Served at `/admin.html` (the `/admin` route in `vercel.json` currently returns 404)

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

# Stylist build
ALGOLIA_APP_ID      # Algolia application ID
ALGOLIA_ADMIN_KEY   # Algolia write key — server only, never sent to the browser
ALGOLIA_SEARCH_KEY  # Algolia search-only key
STYLIST_MODEL       # optional, default claude-sonnet-5-5
STYLIST_DAILY_LIMIT # optional, per-IP questions/day, default 30
GITHUB_BRANCH       # optional, branch lib/github.js reads/writes, default main
```

### Key patterns
- **GitHub as database**: every write to `brands.json` / `recommendations.json` / `settings.json` creates a git commit. Always fetch the current SHA before writing to avoid conflicts — see `getFileSha()` / `readFileWithSha()` in each handler.
- **Shopify product fetching**: uses the public `/products.json?limit=250&page=N` endpoint (no auth needed). Paginates up to page 5. Skips gift-card product types.
- **Discover agentic loop**: Claude drives the search autonomously. The `SKIP_DOMAINS` set in `discover.js` is applied both to filter search results returned to Claude and referenced in the system prompt so Claude avoids those domains itself.
- **No build step**: the project is pure Node.js serverless functions + static HTML. What you see is what gets deployed. Vercel installs `package.json` dependencies on deploy.
- **Shopify pagination**: `products.js` and `refresh.js` stop at page 5 (1,250 products), which cuts off several large brands. New catalog code should paginate until a short page.
