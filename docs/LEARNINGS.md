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

**17. Cost hides where you don't expect it, so break it down by question type.**
"Cotton kurta under ₹3,000" cost ₹3.02: the cached system prompt, 20 product records (~270 tokens each) and the written answer, in roughly equal parts. The products weren't the expensive part. Policy questions cost ₹6.40 because the policy tool sent the full refund and shipping text of all 23 brands, and one combined question cost ₹17.60.
*Lesson:* look at cost per question type, not the average. The fix is usually in what a tool sends back, not in the model.

**18. Split the work: a cheap model widens the window, the smart model decides.**
Claude only ever saw the top 20 products by keyword order, so keyword search was quietly making the shortlist. Giving the expensive model 150 products would cost far more and crowd its context. A cheaper model can read 150 and pass on the best 20, while the expensive model's job and cost stay the same.
*Lesson:* match each model to the size of the job. Wide and shallow goes to the cheap model, narrow and deep to the strong one.

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

**16. Grading what was shown measures precision, not recall.**
The eval checked whether the 6 products the Stylist showed were good. It could never notice that the 3 best pieces in the catalog weren't among them. Measuring recall needs an answer key: a wide pool of candidates per question, each graded, so you know what "the best possible picks" were. An AI judge pre-grades the pool; the owner confirms, and the AI's agreement rate on confirmed items says how far to trust the rest.
*Lesson:* for recommendations, ask both "were these good?" and "were the best ones here?" They need different tests.

**19. A count is not a quality claim.**
The Stylist said "about 760 cotton kurtas fit". They were 760 *keyword matches* (anything containing "cotton" or "kurta" under ₹3,000), including sets and dupattas. Nobody had checked whether they fit.
*Lesson:* say what a number actually counts ("760 matches", not "760 fit"), and don't let a big pool stand in for relevance.

## Evals and decisions

**20. Pass/fail is too coarse to tell you what to fix.**
A single Pass/Fail said whether an answer was OK, not why. A five-part rubric (understood the ask, kept the constraints, product fit, accurate, helpful), with two "critical" parts that fail the answer on their own, shows *where* the agent is weak: product fit points at search, accuracy points at the prompt.
*Lesson:* grade on a few named dimensions, and decide up front which failures are deal-breakers.

**21. A fair comparison needs a frozen world.**
The catalog changes every night. Two eval runs a few days apart are partly measuring different stock, not different designs.
*Lesson:* freeze the inputs (catalog, questions, labels) before comparing options, then change one thing at a time.

**22. Don't spend experiments on obvious wins.**
I nearly ran "agent vs agent + reranker" before comparing the three designs from the plan. Better retrieval helps every design, so the plan is to build it into the shared search tool for all of them and keep the experiments on the open question: which design (A, B or C) is best for quality, cost and speed.
*Lesson:* build the clear improvements into the shared foundation; save A/B tests for decisions that are genuinely uncertain.

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

**15. "Slow" usually has more than one cause, so measure each part.**
The site got slow after adding 10 brands. Two unrelated causes: the product list grew past the size Vercel will cache (10.3 MB), so every visit refetched 23 stores; and the page drew all 15,000 cards at once (65 s on a simulated phone). Trimming unused fields and drawing cards as you scroll brought drawing to about 2 s. Neither was the new AI feature.
*Lesson:* time each step (download, cache, drawing, AI answer) before blaming the newest change.

## Vocabulary I picked up

- **Baseline**: the simplest non-AI version, used only in evals as the floor to beat. Not a product.
- **Eval**: a fixed set of test questions run repeatedly to measure quality, cost and consistency.
- **Trace**: a record of one AI answer: every step, tool call, token and rupee.
- **Structured output**: making the model reply in an exact format (JSON fields) instead of prose.
- **Agentic loop**: the model decides which tool to call next, code runs the tool, repeat until done.
- **Preview deployment**: a test copy of the site per code change, with its own address. The live site is untouched until merge.
- **Token**: the unit AI models read and write (roughly ¾ of a word). Cost = tokens in + tokens out, with output about 5× the price.
- **Prompt caching**: the model provider keeps a repeated prompt for a few minutes, so re-reading it costs about a tenth.
- **Rubric**: a scoring guide with named dimensions (here 0/1/2 each), instead of a single Pass/Fail.
- **LLM-as-a-judge**: a second AI grades answers against criteria; trusted only as far as it agrees with human grades.
- **Precision**: of the products shown, how many were good. **Recall**: of the best products available, how many were shown.
- **nDCG**: whether the best products were placed first (0–1).
- **Relevance labels / pool**: graded candidate products per question, the answer key recall is measured against.
- **Retrieve, then rerank**: a fast search casts a wide net; a model then judges and reorders the candidates.
- **Frozen index**: a fixed copy of the catalog, so every eval run sees exactly the same products.
