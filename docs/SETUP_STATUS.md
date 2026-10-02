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


### Brands added 2026-10-01 (9 new → 22 total)

| Brand | Products (real) | Main product types (page 1) | Refund | Shipping |
|---|---|---|---|---|
| Terra Luna India | 1,398 | shirts, pants, tees, jackets | ✅ 2.4k | ✅ 1.7k |
| Charkha Tales | 565 | co-ords, kurta sets, sarees, fabric | ✅ 1.8k | ⚠️ empty |
| Tjori | 2,373 | suits & sets, kurtas, bottoms (+ rakhis) | ✅ 2.1k | ✅ 3.7k |
| Khamir | 551 | fabric, sarees, dupattas, stoles | ✅ 6.5k | ✅ 3.5k |
| Bagh India | 313 | kurtas, pants, shirts, dresses | ✅ 3.6k | ✅ 5.0k |
| Nolabels | 1,262 | co-ords, dresses, tops, skirts | ✅ 2.2k | ⚠️ empty |
| Hidesign | ~4,000 | **bags, wallets** (leather) | ✅ 2.2k | ✅ 1.0k |
| Tan & Loom | 205 | **bags** (slings, totes) | ✅ 2.1k | ⚠️ empty |
| Nappa Dori | 533 | clothing, bags, accessories | ✅ 1.7k | ✅ 1.8k |

- **The real catalog is now about 20,800 products.** Hidesign alone is about 4,000 (roughly 20%) and is almost all bags, which outnumber clothing in some queries. Possible fixes: exclude non-apparel `productType`s at sync time, or keep them and let the agent filter. This is a decision for step 1.3.
- 4 of the new brands have more than 1,250 products and would be cut off by the current feed's 5-page limit.
- Shipping text to paste by hand in 1.4 is now needed for: Farog, Ganga Fashions, Okhai, SREYA SAMANTA, Doodlage, Charkha Tales, Nolabels, Tan & Loom.

### Full catalog, measured 2026-10-02 (23 brands, Pinklay added)

Fetched with no page limit: **26,835 products** (median record 1.3 KB, 34 MB total). Largest: Hidesign 7,435, Okhai 4,999, Tjori 2,337, Khara Kapas 1,571, Pinklay 1,478. Departments: clothing 14,176 · accessories 10,648 · home 1,239 · fabric 433 · other 339. A full fetch takes about 45 s. **9,210 are sold out** (Hidesign 6,057 of 7,435), so the index holds only in-stock products: about 17,600 records. Algolia free plan = 50,000 records: live index plus one frozen eval copy is about 35,000.

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
2. 1.3: Algolia catalog with descriptions, no 5-page cap (about 20.8k records; decide on non-apparel) + `vercel.json` durations + daily sync cron
3. 1.4: `policies.json`; paste shipping text by hand for the 8 brands listed above
4. 1.5: search tools · 1.6: traces · 1.7: eval harness + baseline

## Later (outside the Stylist build)

- **Brand Scout doesn't look at images.** `discover.js` sends the model only text: search snippets plus one sample product *name*. Its "aesthetic" scores are inferred from wording. Improvement: send 3–4 product image URLs from `/products.json` to the scoring call as image inputs.
- **`/admin` returns 404**; only `/admin.html` works. Fix the route in `vercel.json`.
- **Diagnose why Brand Scout takes so long.** A discovery run takes a long time to return. Find out where the time goes (Claude turns, SerpAPI calls, Shopify checks, the scoring call, GitHub writes) before optimising.
- **Diagnose why some briefs return zero results.** Briefs like "dress materials" and "cotton sarees" found nothing. Check the search queries Claude ran, what SerpAPI returned, and what the domain blocklist, the India-only rule, the Shopify check and the score ≥ 3 cut removed (`discovery_log.json` should show this per run).
- **Add only some categories from a brand.** Example: khaddarvas.com is only worth it for dress materials. Quick check: its `product_type` is unreliable (121 of the first 250 products are blank, and some types are tags like "14 Days Easy Return"), but its Shopify **collections** are clean: `dress-material` (41), `fabric` (192), `plain-khadi-fabric-online` (47). Shopify serves `/collections/<handle>/products.json`, so a brand entry could carry an optional `collections: ["dress-material"]` (or `productTypes` / `excludeTypes`). The feed, the catalog sync and the admin "add brand" form would then fetch only those. This could also handle the Hidesign bags question.
- **Evaluate multimodal inputs.** Two places: (a) Brand Scout scoring looks at product images instead of text only (see above); (b) the Stylist accepts a photo from the user ("find me something like this"), or reads product images when answering questions about colour, print or drape. Evaluate cost and accuracy against text-only before building.
- **Ground Brand Scout's summaries in real catalog data.** Today the "reason" is written from Google snippets only, and the scoring call adds one product name. Any comment on pricing comes from snippets, Claude's background knowledge, or your price-tier feedback, never from the store. Example: Bagh India was described as "~₹3,500–4,500", but the real first 250 products range from ₹740 to ₹14,400 with a median of ₹2,750 (middle half ₹2,350–4,950). Fix: the code already fetches `/products.json`, so pass the scoring call a catalog summary (price range and median, top product types, a dozen titles and descriptions, optionally images from the multimodal item above), and say the reason must not state prices that aren't in that data.
- **Log the search snippets.** `discovery_log.json` saves queries but not the snippets Claude saw, so a claim in a reason can't be traced back to its source. Save the (trimmed) snippets per query.
- **Main page scrolls sideways on phones (~20px).** Pre-existing: the header's Admin link and the nav dropdowns are wider than a 390px screen. Not caused by the Stylist.
- **Brand-level hints.** `catalog-hints.json` sets gender for brands whose products never say (SURMA, Dhuni, IndieFab, SREYA SAMANTA, Tan & Loom = women). Okhai and Nappa Dori still have unlabelled products (mixed catalogs). An admin field per brand would be nicer than editing the file.
