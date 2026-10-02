# Learnings: building with AI

Insights from building Curated's Stylist, kept for future projects. Newest at the bottom of each section. Each entry: what happened, and the lesson.

---

## Working with LLMs

**1. "Looks like it understands" ≠ "looked at it."**
Brand Scout gave confident opinions on brands' designs and pricing. It never saw a single product photo or price: it was reading Google snippets and one product name. Its "₹3,500–4,500" for Bagh India was a guess; the real median is ₹2,750.
*Lesson:* for any AI judgement, ask "what exactly was it given?" Fluent output hides thin input.

**2. Vague definitions produce confident wrong answers.**
Asked "is this brand returnable?", Haiku treated "we'll exchange damaged items" as a return policy, and "store credit only" as no returns. Both answers were well-quoted and wrong by our meaning. Rewriting the field definitions to spell out what counts and what doesn't fixed most of it.
*Lesson:* when extraction is wrong, fix the instructions before blaming the model. The model answered the question it was asked.

**3. Make the model show its evidence, then check it with plain code.**
Every policy field must come with the exact sentence it came from. Ordinary code then checks the sentence really exists in the source. It caught paraphrased and invented quotes automatically.
*Lesson:* AI output + a cheap non-AI check beats trusting the AI or checking everything by hand.

**4. Some mistakes are systematic, so fix them in code, not by hand.**
"24–48 hours" came back as 48 *days*. "Exchange only" brands came back with "returns accepted: blank". These repeat across brands, so a few lines of code now correct them every time.
*Lesson:* review a sample, look for patterns, and fix the pattern once.

**5. Use the cheapest model that can do the job, and keep it off the hot path.**
Policy extraction is form-filling, not reasoning: Haiku, about ₹10–15 for all 23 brands, run once on a button press. The expensive model (Sonnet) is saved for the conversation itself.
*Lesson:* split "understand the data once" from "answer the user every time".

**6. API features have undocumented limits.**
Asking for a strict answer format with 9 "value-or-nothing" fields was rejected ("too many union types") on every call. The documentation lists no such limit. The first symptom was "0 fields extracted" with no visible error.
*Lesson:* always surface the real error message. Have a fallback path (plain JSON) so one API quirk doesn't block everything.

## Search and data

**7. The AI is only as good as what it can search.**
Before any agent existed, the catalog was missing 30% of products (a hidden 1,250-per-brand cap), had no descriptions, and 9,200 of 26,800 products were sold out.
*Lesson:* fix the data before building the clever part. Most "AI quality" problems are data problems.

**8. Marketing copy pollutes search.**
Jewellery descriptions said "pair with a cotton kurta", so searching "cotton kurta" returned necklaces. The fix wasn't deleting the text (it's useful styling advice) but storing it in a separate field the AI can read and keyword search ignores.
*Lesson:* the same text can be good for answering and bad for retrieving. Keep them apart.

**9. Don't "fix" a test by teaching to it.**
Search couldn't correct "cotn" to "cotton". Adding that exact misspelling as a synonym would have made test question S05 pass while proving nothing. The agent rewriting the user's words is the real fix, and the eval should show that.
*Lesson:* if a fix only helps the test question, it's gaming the measurement.

**10. Labels from rules are good enough, if you check the misses.**
Simple keyword rules sorted 27,000 products into clothing / accessories / fabric / home / other. Each check of the leftovers found a new pattern: tags are noisy, "Apparel & Accessories" says nothing, and Indian jewellery words (nath, maang tikka) weren't covered.
*Lesson:* start with rules, inspect what lands in the wrong bucket, iterate. No ML needed yet.

**14. Your first real test question finds what your test set missed.**
"Cotton kurta for office" returned a mix of men's and women's kurtas. Nothing in the 20-question eval set asks the agent to work out *who* something is for, and the catalog had no gender data at all. One real question from the owner found it.
*Lesson:* try the agent yourself before trusting the eval set; then add what you found to it.

## Building and shipping

**11. Free tiers shape the architecture.**
Algolia's free plan (50,000 records) ruled out the "build a fresh copy and swap" approach and kept one eval copy at a time. The paid plan would likely have cost $0 at this size anyway.
*Lesson:* read the limits early; a plan's *terms* (logo required, hard caps) matter as much as its price.

**12. Silent failure is the worst failure.**
Three problems this week looked like success or nothing: a sync timing out (garbled error), an extraction "completing" with 23 hidden errors, and a browser tab stuck on an old version of the site.
*Lesson:* every action should say clearly what it did, what failed, and which version ran it.

**13. Measure before you optimise, and decide what "good" means before you build.**
The plan builds tracing (cost, steps, time per question) and an eval set with a no-AI baseline *before* the agent exists, so the agent's first run already has something to beat.
*Lesson:* without a baseline, "it seems good" is the only evidence you'll have.

## Vocabulary I picked up

- **Baseline**: the simplest non-AI version, used only in evals as the floor to beat. Not a product.
- **Eval**: a fixed set of test questions run repeatedly to measure quality, cost and consistency.
- **Trace**: a record of one AI answer: every step, tool call, token and rupee.
- **Structured output**: making the model reply in an exact format (JSON fields) instead of prose.
- **Agentic loop**: the model decides which tool to call next, code runs the tool, repeat until done.
- **Preview deployment**: a test copy of the site per code change, with its own address. The live site is untouched until merge.
