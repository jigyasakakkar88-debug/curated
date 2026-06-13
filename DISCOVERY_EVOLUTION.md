# Discovery Logic Evolution

A record of every change to the brand discovery system, what the logic was, and what results it produced.

---

## Stage 1 — Pure algorithm, Google Custom Search API
**Commits:** `4980841` (Jun 10) → `15eb3f9`, `11ce9e0`, `35eaa98`, `b007eb8`
**No LLM involved.**

**Logic:**
- Read product tags and categories from your existing brands' Shopify stores to build a "style fingerprint"
- Used those to auto-generate hardcoded search queries, e.g.:
  - `"brands similar to Ganga Fashions india clothing online store"`
  - `"cotton casual india clothing brand online store"`
  - `"indie indian sustainable fashion brand ethnic wear online store"`
- Hit Google Custom Search API with those queries
- For every URL returned, tested `/products.json` to check if it was a Shopify store
- No filtering, no judgement — whatever came back from Google was taken at face value

**Results: 0 brands across 4 runs**
Google Custom Search API returned no results (misconfigured API key / CX ID or quota issue).

---

## Stage 2 — Pure algorithm, switched to SerpAPI
**Commits:** `b56edb4` (switch), `1082fa2` (query cleanup), `cb030f8`, `1743968` (debug) → `d20b072`
**No LLM involved.**

**Logic:**
Same hardcoded query approach, same no-filter logic — just swapped the search provider to SerpAPI which actually returned results. Queries were unchanged in structure, e.g.:
- `"india fashion brand similar to Ganga Fashions clothing online store"`
- `"Co-ord Set india artisan clothing brand online store"`
- `"cotton casual india clothing brand online store"`

Brand *names* were grabbed from the raw HTML page title of whatever URL appeared in search results (a `guessName()` function). No LLM involved in naming, filtering, or reasoning.

**Results: 0 across 9 runs, then 20 in one run (all low quality)**

The 20 brands found:
| Name (as stored) | Quality issue |
|---|---|
| "Ganga Fashions" | Wrong — agashestore.com misidentified |
| "Top 10 Indian Ethnic Wear Brands Shipping Worldwide" | SEO article title used as brand name |
| "Buy Traditional Indian Clothing for Wedding & Special..." | SEO article title |
| "26 Top and Best Clothing Brands for Women in India for 2026" | Listicle URL |
| "22 Sustainable and Ethical South Asian Fashion Brands..." | Blog article |
| "9 Best Local Indie Fashion Brands In India To Check Out" | City guide article |
| Nykaa Fashion | Marketplace — explicitly unwanted |
| Aza Fashions | Multi-brand retailer |
| Utsav Fashion | Non-Indian brand |
| Andaaz Fashion | Non-Indian brand |
| + 10 more of similar quality | |

Root cause: no LLM to judge what a result *is* — Google returns articles and aggregators for these queries and the code had no way to distinguish them from brand storefronts.

---

## Stage 3 — Agentic Claude (first LLM introduction)
**Commits:** `49620f7` (Jun 11, code), `93a9a47` (+7), `b3c3324` (+8)

**Logic:**
First introduction of Claude. Instead of the code deciding what to search, Claude gets two tools:
- `search_web` — runs a SerpAPI query and gets back 10 results
- `save_recommendations` — saves final picks and ends the session

Claude autonomously decides what to search, reads results, decides what to search next (up to 12 turns), and only calls `save_recommendations` when it's confident about 3–8 real brand storefronts. No hardcoded queries. Default prompt asked for "handloom, block print, natural dyes, sustainable, indie Indian labels."

No India-only rule yet — Claude might still surface non-Indian brands if not guided.

**Results: 7 brands (run 1), 8 brands (run 2) — all high quality**

Run 1 (`93a9a47`): Prathaa · ILAMRA · Sepia Stories · Cotton Conscious · Soma · Sutra Clothing · The Block Art

Run 2 (`b3c3324`): Dhuni · Kokūn · Dressfolk · Sui · Doodlage · The Summer House · No Nasties · Anuprerna

Quality jump: names are correct brand names, reasons are written per-brand, results are real storefronts. The agentic loop's ability to read snippets and judge "is this actually a brand?" vs "is this an article?" eliminated the garbage entirely.

---

## Stage 4 — Agentic Claude + India-only rules + rotating exploration axes
**Commits:** `9ed9efb` (Jun 13, code), `68080b7` (+6)

**Logic changes:**
1. **India-only rule** added explicitly to system prompt: "every brand must be founded in India, headquartered in India, and primarily serve Indian customers — if the snippet does not confirm this, skip it"
2. **4 rotating daily exploration axes** (keyed by day-of-month) so each no-prompt run covers a different corner automatically:
   - Regional craft traditions (Kutch, Ajrakh, Chanderi, Ikat, Kalamkari)
   - Slow fashion and sustainable labels (natural dye, zero-waste, khadi, organic cotton)
   - Contemporary Indian designers (indie womenswear, NID/NIFT graduates, minimalist ethnic)
   - Specific garment categories (block-printed kurtas, co-ords, sarees, resort wear)
3. **Better search query guidance** in system prompt: specific patterns like `"[craft] brand India official website"`, `"site:shopify.com [aesthetic] Indian"`, following up on designer names spotted in snippets
4. **Search count bumped** from 4–8 to 6–8 required searches before saving

**Results: 6 brands — tighter and more specific**

Run (`68080b7`): Ka-Sha · ILAMRA · Retiyo · Sepia Stories · Nilam India · (+ 1 more)

Qualitative improvement over Stage 3: reasons became location-grounded ("Pune-based slow fashion label by designer Karishma Shahani Khan") and more specific to Indian craft techniques. The rotating axes mean consecutive no-prompt runs explore genuinely different territory.

---

## Stage 5 — Self-learning system (deployed Jun 13, not yet run)
**Commits:** `a963daf`

**Logic changes (3 new steps added after discovery):**

**Step A — Evaluation (every run):**
A second Claude call scores every recommendation 1–5 on five dimensions:
- `isStorefront` — is it a genuine brand's own website?
- `isIndian` — clearly India-based?
- `aesthetic` (1–5) — earthy, artisanal, handmade, slow-fashion sensibility
- `briefMatch` (1–5) — alignment with the style brief or axis
- `quality` (1–5) — indie curated label vs mass-market generic

Only brands scoring ≥ 3 overall are saved to the pending queue. Everything (including underperforming results) is written to `discovery_log.json` for analysis.

**Step B — Logging (every run):**
Each run writes to `discovery_log.json`: axis used, brief, turns taken, all search queries, every recommendation with its scores, source query, and source position (which rank 1–10 in results it came from).

**Step C — Learning analysis (every 3 runs):**
A third Claude call reads the last 20 runs of the log and produces:
- Axis performance ranking (e.g. "Slow fashion: 4.2/5, Regional crafts: 3.8/5")
- Best-performing query patterns
- Which search result positions (1–10) yield the best brands
- 2–3 new exploration axes to add based on gaps (e.g. menswear, bridal, Kerala/Northeast crafts)
- A summary paragraph

This is written to `discovery_learnings.json` and injected into the system prompt on the next run automatically — so the agent gets smarter each cycle without any manual intervention.

**Results: pending first run**

---

## Summary table

| Stage | LLM? | Runs | Total brands found | Quality |
|---|---|---|---|---|
| 1 — Algorithm + Google CSE | No | 4 | 0 | N/A |
| 2 — Algorithm + SerpAPI | No | 10 | 20 | Very poor — article titles, marketplaces, non-Indian brands |
| 3 — Agentic Claude (basic) | Yes | 2 | 15 (7 + 8) | High — all real Indian craft brand storefronts |
| 4 — Agentic + India rules + axes | Yes | 1 | 6 | High + more specific, location-grounded |
| 5 — Self-learning | Yes + self-improving | 0 so far | — | To be measured |

**Key insight:** The quality jump happened entirely at Stage 3 — the moment Claude got agency over the search process. Stages 1–2 were the code deciding what to search and blindly accepting results; the LLM's ability to read a snippet and judge "is this actually a brand storefront?" eliminated all the garbage in one step.
