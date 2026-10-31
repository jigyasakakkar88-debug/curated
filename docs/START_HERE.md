# Start here: Curated Stylist, where we are

*Last updated: 31 Oct 2026. Read this when you feel lost; it's kept short on purpose.*

---

## 1. What this is
**Curated** is your site of 23 independent Indian fashion brands. We're adding the **Stylist**: an AI shopping assistant that answers questions like "cotton kurta under ₹3,000" with real products and real return policies, and never makes them up.

## 2. Where things are

| What | Where |
|---|---|
| Live site (old version, nothing new is live yet) | https://curated-xi.vercel.app |
| **Latest preview (all the new work)** | https://curated-1jjxaybfx-jigyasakakkar88-debugs-projects.vercel.app (add `/admin.html` for the admin panel) |
| Code branch | `claude/repository-settings-nx8ju4`, 40 changes ahead of `main` (the live site) |
| Eval results and traces | the `observability` branch (never deployed) |
| System design diagram | https://claude.ai/artifact/PmFeAWu6LQyHmQCGtMYcjZ |
| Token flow: today vs reranker | https://claude.ai/artifact/FVFt7Jz5H1yXWqA4Q8Cwvs |
| Lessons learned + vocabulary | `docs/LEARNINGS.md` |
| Later / someday list | `docs/SETUP_STATUS.md` (bottom) |
| Design reference | `docs/STYLIST.md` |

Every code change gets a **new** preview address. If a page looks old, you're on an old preview: ask Claude for the newest link, or open Vercel → Deployments.

## 3. What's built

**For shoppers (on the preview, not live yet)**
- Stylist chat drawer: ask bar on the homepage, "Ask about this piece" on any product, thumbs up/down.
- Asks "woman, man or child?" when unclear. Declines body-type advice, order tracking, discount codes and off-topic questions.
- Each answer: 3–8 product cards, **a one-line reason per pick**, caveats, policy quotes, and **"See all N matches"**.
- Picks spread across brands (at most 2 per brand first).
- Instant keyword search box on the feed; the feed loads fast (cards drawn as you scroll).

**Under the hood**
- **Design C:** one Claude Sonnet 5.5 agent with 5 tools (search products, get product, get policies, get wishlist, respond), up to 6 rounds.
- **Algolia** search index of about 17,700 in-stock products, synced nightly from the brands' Shopify stores, labelled by department and gender.
- **Policy database:** Claude Haiku read every brand's refund and shipping pages and extracted 9 fields, each with an exact quote that code verifies.
- Data lives in JSON files in GitHub (no database).

**For you (admin panel, Insights tab)**
- **Observability:** every answer traced (steps, tokens, ₹, time).
- **Evals:** 22 questions from your golden test set, run against the agent or a no-AI baseline. Auto checks, plus your grading with a **5-part rubric** (0/1/2 each; constraints and accuracy are critical). Shows your must/must-not criteria, product photos, reasons, pool size, "See all", and cost per answer and per good answer. Grading saves on every click.
- **Relevance labels** (built, **not used yet**): pool about 50–80 candidates per question, Haiku pre-grades them, you confirm. Gives **recall / precision / nDCG** per run.

## 4. Results so far

| Run | Catalog | Auto checks | Your grades | Cost |
|---|---|---|---|---|
| 2 Oct, agent C | live | 95% | 3 of 22 | ₹65 |
| 8 Oct, agent C (with reasons, pool, brand spread) | live | 91% | none yet | ₹80 |

Typical answer: about ₹3 and 8–9 seconds. Policy questions cost about ₹6 (they send every brand's full policy text), one combined question cost ₹17.

Both runs used the **live** catalog, so treat them as early references, not the final comparison.

## 5. Where we left off: the agreed path

You decided: **don't run experiments on obvious wins; build those in, then spend the experiments on A vs B vs C** (the three designs in your main doc).

| # | Step | Who | Status |
|---|---|---|---|
| 1 | **Upgrade the shared foundation:** (a) AI rerank inside the search tool (Algolia returns 150, Haiku keeps the best 20 for the shopper's `intent`; "See all" shows AI-vetted fits); (b) policy trim (fields + quotes for cross-brand questions; about ₹6 → ₹1.5); (c) honest wording ("760 matches", not "760 fit") | Claude | **Not started.** You'd said OK in principle; say "go" |
| 2 | **Freeze the catalog** (Stylist tab → Catalog → Freeze) | You | after step 1 |
| 3 | **Evaluate C** on the frozen catalog: run evals → Relevance labels → Prepare all → review the 2s → rubric-grade | You (about ₹65 + ₹40–60) | after step 2 |
| 4 | **Build + evaluate B** (router: a cheap first step sorts the question, and only complex ones get the full agent) | Claude, then you | |
| 5 | **Build + evaluate A** (fixed pipeline: one AI call understands, code searches, one AI call writes; no loop) | Claude, then you | **Confirm A's definition from your main doc first** |
| 6 | **Compare A / B / C** (rubric, recall, precision, ₹ per answer, time, failure types), pick the winner, then **go live** (merge to `main`) | You decide | |

Before going live, remember: the Stylist becomes public (about ₹3 per question, capped at 30 questions per person per day), and the nightly catalog sync starts running.

## 6. Key decisions (and why)
- **Design C first:** one agent with tools, as your build plan says. A and B come after.
- **Keyword search + synonyms, no semantic search yet:** add it only if evals show vocabulary misses.
- **Only in-stock products in Algolia:** the free plan caps us at 50,000 records.
- **Styling tips kept but not searchable:** "pair with a kurta" was pulling jewellery into kurta searches.
- **Gender asked once, then filtered:** your first real test found the mixed results.
- **Cheap model offline, strong model live:** Haiku reads policies (and would rerank); Sonnet talks to shoppers.
- **Recall measured against a pooled, graded candidate set:** honest framing is "recall relative to the labelled pool".

## 7. Open questions
- What exactly is **Option A** in your main doc? (Assumed: fixed pipeline.)
- **LLM-as-a-judge** for grading whole answers (not just products): offered, not built.
- 5 brands' policy extractions were flagged for your review (Dhuni, Burnt Soul, Tjori, Okhai, SURMA): done?
- Your golden test set has 30 more single-turn questions and 8 multi-turn conversations not yet in the evals.

## 8. Later list (not now)
Offline occasion/formality tagging of every product · semantic search · photos in reranking · Stylist accepting a photo · Brand Scout improvements (images, grounded pricing, speed, zero results) · per-category brands (e.g. khaddarvas dress materials) · `/admin` 404 · phone sideways scroll · feed size nearing Vercel's cache limit. Details in `docs/SETUP_STATUS.md`.

## 9. Picking up with Claude
Start a session with: **"Read docs/START_HERE.md and let's continue from section 5."**
