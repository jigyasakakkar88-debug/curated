# Setup status — Stylist build, step 1.1

_Checked 2026-10-01 against https://curated-xi.vercel.app. Code review and public live checks are done; the authenticated check (`/api/recommendations`) is pending._

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

## 3. Live checks

| Check | Result |
|---|---|
| `GET /` | ✅ 200, 0.5 s |
| `GET /api/products` | ✅ 200, 3.7–5.4 s uncached. **6,730 products**, 98 new, 985 on sale, 13 brands, no brand errors |
| `GET /admin` | ❌ **404**. The `vercel.json` route isn't taking effect. `GET /admin.html` works (200), so the panel is reachable there |
| `GET /api/recommendations` (no auth) | ✅ 401, as expected. Authenticated check pending |

### Findings
- **The feed is truncated for 2 brands.** The 5-page limit (1,250 products) cuts off Khara Kapas (real total 1,574) and **Okhai (real total 3,750)**. The real catalog is about **9,630 products**, not 6,730. The 1.3 sync should raise or drop the page limit. Check that Okhai's 3,750 isn't padded with non-clothing items.
- **Descriptions are confirmed absent** from `/api/products` (0 of 6,730 products).
- **Every brand has a refund policy.** Shipping policy is **missing for Farog** (404) and **empty for Ganga Fashions, Okhai, SREYA SAMANTA and Doodlage** (the page exists but the body is blank). For those 5, shipping info lives elsewhere (FAQ or a custom page) and needs pasting by hand in 1.4.

### Per-brand table

| Brand | `/products.json` | Products (real) | In feed | Refund | Shipping | ToS |
|---|---|---|---|---|---|---|
| Ganga Fashions | ✅ 0.6 s | 486 | 486 | ✅ 1.5k chars | ⚠️ empty | ✅ |
| Khara Kapas | ✅ 0.4 s | 1,574 | **1,250** | ✅ 2.8k | ✅ 1.4k | ✅ |
| Farog | ✅ 0.7 s | 228 | 228 | ✅ 2.1k | ❌ 404 | ✅ |
| Okhai | ✅ 0.5 s | 3,750 | **1,250** | ✅ 2.9k | ⚠️ empty | ✅ |
| SREYA SAMANTA | ✅ 0.6 s | 127 | 127 | ✅ 9.1k | ⚠️ empty | ✅ |
| SURMA | ✅ 0.7 s | 394 | 394 | ✅ 1.8k | ✅ 0.4k | ✅ |
| THE BURNT SOUL | ✅ 0.6 s | 248 | 248 | ✅ 6.3k | ✅ 2.8k | ✅ |
| Dhuni | ✅ 0.4 s | 87 | 87 | ✅ 1.4k ("No Refunds / Exchanges") | ✅ 1.0k | ✅ |
| No Nasties | ✅ 1.8 s | 959 | 959 | ✅ 0.8k | ✅ 0.6k | ✅ |
| Dressfolk | ✅ 0.3 s | 577 | 577 | ✅ 1.7k | ✅ 2.8k | ✅ |
| Doodlage | ✅ 0.8 s | 246 | 246 | ✅ 2.6k | ⚠️ empty | ✅ |
| The Summer House | ✅ 1.4 s | 457 | 457 | ✅ 0.5k | ✅ 0.2k | ✅ |
| IndieFab | ✅ 0.4 s | 421 | 421 | ✅ 4.5k | ✅ 1.7k | ✅ |

_ToS = HTTP status only. Policy sizes = characters of policy body text._

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
2. 1.3: Algolia catalog with descriptions, no 5-page cap (about 9.6k records) + `vercel.json` durations + daily sync cron
3. 1.4: `policies.json`; paste shipping text by hand for Farog, Ganga Fashions, Okhai, SREYA SAMANTA, Doodlage
4. 1.5: search tools · 1.6: traces · 1.7: eval harness + baseline
