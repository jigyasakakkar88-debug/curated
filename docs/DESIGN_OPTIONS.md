# Curated Stylist: Design Options to Test

19 Nov 2026 · Jigyasa

## Purpose

Keep the built agent (Option C) fixed, then test a small number of alternatives that each change one thing. The principle under test: **anything deterministic code can do, code should do; use an LLM only for judgement and language, and an agent only where steps depend on results.**

Each option answers one question: is this step worth an LLM, and is the agent worth its cost?

## Fixed base: Option C (built)

One Claude Sonnet agent decides every step. Up to 6 rounds, then it answers through a fixed format. Code enforces filters and removes any product no tool returned.

| Tool | What it does |
| --- | --- |
| search_products | Algolia keyword search with exact filters (price, size, gender, returns, brand) |
| get_product | One product's full record |
| get_policies | Brand return and shipping policies from policies.json, with quotes |
| get_wishlist | The shopper's saved items |
| respond | The final answer: text, products, a reason per pick, caveats, policy quotes |

Measured so far (8 Oct run): median 2.5 Claude calls, about ₹2.84 and 8 s per answer. Policy questions cost about ₹6.40 because all policy text is sent.

## Who controls the flow: A and B

**Option A: single pass (the floor, and classic RAG for products).** Parse the question into filters and search words (LLM call 1), run one search (code), write the answer from the top 10 plus policy info (LLM call 2). No loop.

- Give A the same information as C through code: saved items, the anchored product and policy info always go into the answer prompt.
- Let parse output "clarify" or "decline" so A isn't failed for a trivial reason.
- Expected: fine on simple and policy questions; weak on compound questions (one search, cannot react to results).

**Option B: router + fixed routes.** One cheap call labels the question; simple questions take A's path, compound ones go to C's agent.

- B is roughly A on simple questions plus C on compound ones, adjusted for routing accuracy.
- Cheapest way to test it: run A and C fully, build only B's router, measure how often its label is right, then estimate B from the two runs.
- Keep the answering model the same in A, B and C so cost differences come from design, not model size.

## Code-first variants: testing the principle

Each variant moves one step from Claude to code and leaves everything else in C unchanged.

| Variant | Step moved to code | What Claude still does | What it tests |
| --- | --- | --- | --- |
| D1. Code answers policy facts | "Which brands offer free shipping / COD / 14-day returns?" answered by filtering policies.json plus a template with quotes | Nuanced policy questions (exceptions, customised items) | Where structured facts stop being enough; cost ₹6.40 to near zero |
| D2. Code routing and filter parsing | Rules catch clear declines (body type, order status, discount code), missing gender, and hard filters (under ₹3,000, size M, returnable) | Everything the rules can't classify | A code router vs an LLM router: accuracy, misroutes, cost |
| D3. Code enforces selection rules | Final picks capped at 2 per brand, within budget, size in stock, spread of prices | Judges fit and writes the reasons | Whether rules in code raise the constraints score without hurting fit |

Why these three: they are the steps where today's C uses Sonnet for work a rule could do, and each has a clear before/after on the existing evals.

## Optional: retrieval tests (Step 1 of the build plan)

These teach RAG mechanics. At this scale they are not what decides quality, so run them only if time allows.

- **Policy test:** full policy text in the prompt vs full text with prompt caching vs RAG (chunks per brand and section, embedded, top few retrieved). Expect full text with caching to win at about 25–30k tokens; RAG likely fails on "which brands…" questions.
- **Catalog test (about 500 products, one category):** raw vs AI reranker vs occasion enrichment, optionally vs hybrid (keyword + vector) search. Score with hit@10 and precision@10 from the relevance labels.
- **Enrichment vs reranker:** enrichment is a per-product cost (about ₹0.03–0.05 each, only new or changed products); reranking is a per-question cost (about ₹2.3). With about 300 new products a day, enrichment is cheaper above roughly 7 shopping questions a day.
- **Catalog churn:** embed or tag only stable descriptive text, keep price and stock as filters, re-process only changed products (hash), keep tags for sold-out items.

## How to measure

- **Same inputs:** freeze the catalog first; every option runs on the same frozen copy and the same questions.
- **Test set:** the current 22 questions plus about 10 more compound questions and the 8 multi-turn conversations, or C's advantage stays invisible.
- **Quality:** automatic checks plus the 5-part rubric (sample-grade; let AI pre-grade the rest).
- **Products:** precision, recall and nDCG against the relevance labels (11 shopping questions).
- **Cost and speed:** ₹ per answer, ₹ per good answer, median and p90 seconds.
- **Consistency:** 3 runs per question for the final comparison only; code steps should vary less.
- **For B / D2:** routing accuracy and where misroutes went.

## Hypotheses (rewrite in your own words before running)

- **A vs C:** A matches C on simple and policy questions at lower cost; A fails compound questions.
- **B:** B's gain over C is predictability and lower variance more than large savings, since C already takes about 2 calls on simple questions.
- **D1:** code answers 70–80% of policy questions correctly at near-zero cost; exceptions still need the LLM.
- **D2:** rules catch most declines and missing-gender cases but break on Hinglish and vague requests; code router plus LLM fallback beats an LLM router on cost.
- **D3:** code-enforced selection raises the constraints score without lowering fit.

## Recommended order

1. Freeze the catalog; grow the test set (compound + multi-turn).
2. Run C on the frozen catalog; prepare relevance labels; grade a sample.
3. D1 (code policy answers): smallest change, biggest cost win.
4. Build A; run A vs C. Build only B's router and estimate B.
5. D2 and D3, one at a time.
6. Optional: policy RAG test and catalog reranker/enrichment test.
7. Pick the winner, add the audit step to it, then go live.

Open question: confirm Option A's definition matches the build plan (single pass, 2 LLM calls).
