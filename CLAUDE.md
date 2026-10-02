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
- `policies.json` — per-brand policy text (refund/shipping/terms) and extracted fields with source quotes; fields are copied onto Algolia records at catalog sync
- `catalog-hints.json` — per-brand hints applied at sync (e.g. `gender` for brands whose products never say who they're for)
- `evals/synonyms.json` — search synonym groups, pushed to Algolia on every catalog sync

### Vercel serverless functions (`api/`)
| File | Purpose |
|------|---------|
| `products.js` | Fetches all products from every brand's `/products.json` Shopify endpoint, enriches with `isNew`/`isSale`/`discountPct`, returns unified feed. Cached 1h. |
| `admin.js` | CRUD for `brands.json` and `settings.json`. Also has a Shopify store tester (`?action=test`). |
| `recommendations.js` | GET pending recs; POST to accept (→ adds to `brands.json`) or reject (→ adds id to `rejected[]`). |
| `discover.js` | Agentic brand discovery loop: Claude (claude-sonnet-4-6) uses `search_web` (SerpAPI) and `save_recommendations` tools across up to 12 turns to find new Indian fashion brand storefronts matching an optional style brief. Runs up to 120s. |
| `refresh.js` | Weekly cron (Monday 6am UTC via `vercel.json`) — counts products per brand, used to confirm brands are still live. |
| `policies.js` | Brand policy database (admin). `POST ?action=ingest` fetches each brand's refund/shipping/terms pages; `?action=extract` has Claude Haiku pull 9 fields, each with an exact quote that's then verified against the text (`quoteVerified`); `?action=save` stores hand edits (`source: manual`, never overwritten by later ingest/extract). `GET` returns `policies.json`. Optional `&brandId=`. |
| `search.js` | Admin: runs the Stylist's `search_products` tool directly from query params (`query, maxPrice, minPrice, size, brandIds, excludeBrandIds, minDiscount, returnableOnly, departments, limit, index`); returns results + trace and logs a `TRACE` line. |
| `stylist.js` | Public Stylist endpoint. `POST {messages (last 6 turns), wishlistIds?, anchorId?}` → `{answer, products (feed card shape), caveats, policy_quotes, traceId}`. Per-IP daily limit (`STYLIST_DAILY_LIMIT`, in-memory), 500-char input cap; admin Bearer skips the limit, may pass `index`, and gets the full trace. Drops product ids no tool returned. `POST ?feedback=1 {traceId, rating}` logs a `FEEDBACK` line. Up to 120s. |
| `catalog.js` | Stylist catalog. `POST ?action=sync` updates the Algolia `products` index in place from every brand (all pages, descriptions, department label, policy fields from `policies.json`); **only in-stock products are indexed**; stale records are deleted; a failed store's records are left untouched; the sync is refused if the new catalog is under half the old one (`&force=1` overrides). `POST ?action=freeze` copies it to `products_eval_<date>` and deletes older eval copies. Algolia free plan = 50,000 records, so never build a second full copy (no `replaceAllObjects`). `GET` = index status, or a sync when called by the daily cron (1:30am UTC). Up to 300s. |

### Shared modules (`lib/`) — Stylist build, in progress
| File | Purpose |
|------|---------|
| `github.js` | Shared GitHub Contents API helpers: `readFileWithSha`, `readJson`, `writeJson`, `updateJson` (retries once on a 409 SHA conflict). Branch from `GITHUB_BRANCH` (default `main`). Existing `api/*.js` handlers still carry their own copies; new code should use this. |
| `shopify.js` | Full-catalog fetcher for the Stylist: paginates until a short page, strips HTML descriptions (600 chars) and splits styling text ("Pair with…") into `stylingNotes` (stored, not searchable — keeps accessories out of clothing searches but available to the Stylist for pairing/occasion advice), sizes from the "Size" option, one retry on 429/5xx. Record id `<brandId>-<shopifyId>` matches the feed and wishlist. |
| `departments.js` | Rule-based `department` label (clothing / accessories / fabric / home / other) from product type, then name (tags ignored — too noisy); `gender` label (women / men / kids / unisex / unknown) from whole words in type, name and tags. |
| `algolia.js` | Algolia client (`getClient('admin'|'search')`), index settings, synonyms from `evals/synonyms.json`, policy-field mapping. |
| `policies.js` | Policy page fetch/parse (`shopify-policy__body`), field definitions, Haiku extraction with JSON-schema output, quote verification, token count. |
| `tools.js` | The Stylist's tools (Anthropic definitions + implementations): `search_products` (exact Algolia filters, default department clothing, `gender` excludes the opposite gender + kids so unlabelled products stay in, auto-relaxes ONE filter — size → minDiscount → maxPrice +20% — when <3 hits, never returnable/brand exclusions), `get_product`, `get_policies`, `get_wishlist`, `respond`. `createToolbox({index, wishlistIds, trace})`; `run(name, input)` never throws and records a trace step. Index must match `products` or `products_eval_<date>`. |
| `agent.js` | Option C loop: Sonnet 5.5 (`STYLIST_MODEL`), adaptive thinking at effort `medium`, up to 6 model calls, parallel tool calls, finishes via `respond`. Forced `tool_choice` is rejected on Sonnet 5.5, so a plain-text reply gets one nudge and round 5's tool results carry a "last step" note. History is append-only (assistant turns pushed unchanged — required for thinking blocks). System prompt + brand list cached. Server-side refusal fallback (`fallbacks: "default"`); a refusal returns a polite decline. |
| `prompt.js` | The Stylist system prompt (static, cacheable) and brand-list block. |
| `trace.js` | One trace per question: steps (tool, input, resultCount, relaxed, ms), tokens, ₹ cost, latency, productIds, invalidIds (ids the agent named that no tool returned). Live traces → one `TRACE {json}` log line. |
| `pricing.js` | Claude prices (USD/MTok) for `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-4-5`, plus `USD_INR` and `costINR(model, usage)`. Re-check `checkedOn` against the pricing page when models change. |

The Stylist design and build plan is in `docs/STYLIST.md`; the health check, open issues and later list are in `docs/SETUP_STATUS.md`; lessons about building with AI are in `docs/LEARNINGS.md` (add to it when something non-obvious is learned).

### Frontends (`public/`)
- `index.html` — the main product feed, calls `GET /api/products`
- `admin.html` — admin panel (password-gated; Stylist panels are in the right column), calls all admin/discover/recommendations/catalog endpoints (Stylist Catalog: sync, freeze, status, search tester; Test the Stylist: chat with the agent, shows steps/₹/time per answer; Brand Policies: fetch, extract, review/edit). Served at `/admin.html` (the `/admin` route in `vercel.json` currently returns 404)

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
