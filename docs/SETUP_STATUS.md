# Setup status — Stylist build, step 1.1

_Checked 2026-10-01. Code review is complete. **Live checks are pending**: the cloud session's network policy blocked outbound requests to the live site (`curated-xi.vercel.app`) and to every brand storefront (proxy 403)._

## 1. What works (from the code)

| Area | Status |
|---|---|
| Feed | `GET /api/products` reads `brands.json` + `settings.json` from GitHub (`main`), then fetches each brand's `/products.json` (up to 5 pages × 250). Cached 1 h (`s-maxage=3600`). A brand that fails goes into `meta.errors` and doesn't break the feed. |
| Admin | `/admin` → `public/admin.html`. Endpoints: `admin`, `recommendations`, `feedback`, `refresh`, `discover`. All use `Bearer ADMIN_PASSWORD`. |
| Brand Scout | `api/discover.js` runs a Claude tool loop (`claude-sonnet-4-6`, raw HTTPS, no SDK). `maxDuration` 300 s. |
| Cron | `/api/refresh`, Mondays 06:00 UTC. It only counts products and stores nothing. |
| Brands | 13 in `brands.json`. |

## 2. Gaps and risks found in the code

1. **Descriptions are dropped**: `products.js` doesn't keep `body_html`. Tags are cut to 5 and sizes to 8, and only variant[0]'s price is used. The catalog sync (1.3) has to map from raw Shopify data, not from `/api/products` output.
2. **`GITHUB_BRANCH = "main"` is hardcoded** in every handler. Preview deploys of the `stylist` branch therefore **read and write `main`**, so writing `policies.json` or eval runs from a preview commits to the live branch. Decide before 1.4: make the branch configurable (`GITHUB_BRANCH` env), or accept writes to `main` (these are data files only).
3. **Default password**: every handler falls back to `changeme123` if `ADMIN_PASSWORD` is unset. Confirm it is set in Vercel for Production **and Preview**.
4. **No search, policies, catalog store, logs or evals**. This matches manual §1.
5. **Wishlist is `localStorage['wishlist']`** (a set of product IDs shaped like `<brandId>-<shopifyId>`). New Algolia `objectID`s should use the same format so saved IDs resolve.
6. **No `package-lock.json`**, and the only dependency is `node-fetch` (unused; handlers use `https`). Adding `@anthropic-ai/sdk` and `algoliasearch` in 1.2 is the first real dependency install.
7. **Model IDs in the manual**: `claude-sonnet-5` must be confirmed against the current models list before 1.2. Keep it behind `STYLIST_MODEL` so it can change without a code edit.
8. **Function time limits**: only `discover.js` has a raised `maxDuration`. `catalog.js` (sync of about 7k products), `policies.js` and `eval.js` will need entries in `vercel.json`.

## 3. Live checks — pending (run from a machine with network access)

- [ ] `GET /` loads
- [ ] `GET /api/products`: total products, per-brand counts, `meta.errors`, response time
- [ ] `/admin` loads
- [ ] `GET /api/recommendations` with auth responds (don't run discovery)

### Per-brand table

| Brand | URL | `/products.json` | Products | refund-policy | shipping-policy | terms-of-service |
|---|---|---|---|---|---|---|
| Ganga Fashions | gangafashions.com | ? | ? | ? | ? | ? |
| Khara Kapas | kharakapas.com | ? | ? | ? | ? | ? |
| Farog | farog.one | ? | ? | ? | ? | ? |
| Okhai | okhai.org | ? | ? | ? | ? | ? |
| SREYA SAMANTA | sreyasamanta.com | ? | ? | ? | ? | ? |
| SURMA | surma.in | ? | ? | ? | ? | ? |
| THE BURNT SOUL | www.theburntsoul.com | ? | ? | ? | ? | ? |
| Dhuni | labeldhuni.com | ? | ? | ? | ? | ? |
| No Nasties | www.nonasties.in | ? | ? | ? | ? | ? |
| Dressfolk | dressfolk.com | ? | ? | ? | ? | ? |
| Doodlage | doodlage.in | ? | ? | ? | ? | ? |
| The Summer House | thesummerhouse.in | ? | ? | ? | ? | ? |
| IndieFab | indiefabstore.com | ? | ? | ? | ? | ? |

## 4. Environment variables

| Var | Used by | Status |
|---|---|---|
| `GITHUB_TOKEN`, `GITHUB_REPO` | all handlers | existing — check |
| `ADMIN_PASSWORD` | all handlers | existing — check it's set for Preview too |
| `ANTHROPIC_API_KEY` | discover.js, stylist | existing — set a monthly spend limit |
| `SERPAPI_KEY` | discover.js | existing |
| `CRON_SECRET` | refresh.js | set by Vercel |
| `BRANDS_JSON` | products.js fallback | legacy, optional |
| `ALGOLIA_APP_ID` | catalog, tools | **add** |
| `ALGOLIA_ADMIN_KEY` | catalog (server only) | **add** |
| `ALGOLIA_SEARCH_KEY` | tools | **add** |
| `STYLIST_MODEL` | agent | **add** (optional, has a default) |
| `STYLIST_DAILY_LIMIT` | stylist.js | **add** (optional, default 30) |

## 5. Missing pieces, in the order Phase 1 fixes them

1. 1.2: `lib/github.js` (+ branch decision, gap 2), `lib/pricing.js`, dependencies, confirm model IDs
2. 1.3: Algolia catalog with descriptions + `vercel.json` durations + daily sync cron
3. 1.4: `policies.json`; the brands with no standard policy pages get filled in once the table above is complete
4. 1.5: search tools · 1.6: traces · 1.7: eval harness + baseline
