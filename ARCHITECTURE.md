# Curated — System Architecture

## The three types of components

### 1. Interface
What humans look at and interact with.

- **`admin.html`** — your browser tab. Shows information, lets you click buttons. No intelligence of its own. Sends requests to Vercel and renders whatever comes back.

### 2. Services
Things that do work when called upon. Sit idle until triggered.

- **Vercel** — your backend. Five small programs that run in the cloud when your browser calls them (`discover.js`, `products.js`, `admin.js`, `recommendations.js`, `feedback.js`). Vercel has no intelligence — it reads files, does simple counting and string-joining, and orchestrates calls to other services. Everything Vercel does is mechanical if/else logic, not judgement.
- **Claude (Anthropic API)** — the only intelligent component in the system. Called with a text message, returns a text message. Has no memory between calls and cannot call anything externally — you must hand it everything it needs every single time. All of Claude's apparent "actions" (searching, saving) are just structured text that Vercel interprets and acts on.
- **SerpAPI** — a middleman that lets your code search Google. Google doesn't allow direct software access, so SerpAPI sits in between and returns structured results. Claude cannot call SerpAPI directly — it can only ask Vercel to do it.
- **Shopify (brand websites)** — not a subscribed service. Every Shopify store publicly exposes a `/products.json` URL. Vercel just reads that open door to verify a brand is real.

### 3. Data sources
Where information lives at rest. Your entire database is six JSON files on GitHub.

| File | What it stores |
|---|---|
| `brands.json` | Accepted brands (name, URL, timestamps, which run found them) |
| `recommendations.json` | Pending and rejected brand suggestions |
| `user_feedback.json` | Your Vibe / Price / Design ratings and notes per brand |
| `discovery_log.json` | Full record of every discovery run (queries, scores, results) |
| `discovery_learnings.json` | Claude's own analysis of what's working — written by Claude, read back to Claude next run |
| `settings.json` | Sale threshold, new arrivals window |

Every read and write goes through the **GitHub API**. Every write creates a git commit — that's the audit trail.

---

## How the components communicate

| From | To | Protocol | What travels |
|---|---|---|---|
| Browser | Vercel | HTTP POST `/api/discover` | Your query text + password |
| Vercel | GitHub API | HTTP GET | Reads the JSON files |
| Vercel | Anthropic API | HTTP POST `/v1/messages` | Assembled brief + full conversation so far |
| Anthropic API | Vercel | HTTP response | Claude's next move, written as structured text |
| Vercel | SerpAPI | HTTP GET | A search query string |
| SerpAPI | Vercel | HTTP response | 10 results: title, URL, snippet |
| Vercel | Brand websites | HTTP GET `/products.json` | Nothing — just knocking |
| Brand websites | Vercel | HTTP response | Product count + sample product name |
| Vercel | GitHub API | HTTP PUT | Updated JSON files as new git commits |
| Vercel | Browser | HTTP response | Final list of found brands |

All connections in a single discovery run are **sequential** — the browser sends one request and waits. Vercel orchestrates everything and only replies when fully done. This is why discovery takes 30–60 seconds.

**Important: Claude cannot call anything directly.** Claude is text-in, text-out. It has no internet access, no ability to read files, no ability to call APIs. When Claude "searches", it is writing a structured text message that Vercel reads, acts on, and reports back. The same is true of every LLM — GPT, Gemini, all of them. "Tool use" is a convention, not a superpower.

---

## How tool use actually works

Before the discovery loop starts, Vercel sends Claude a **tools menu** alongside the brief — a precise description of what tools exist and what format to use when requesting them:

```
Tool: search_web       → input required: { "query": "..." }
Tool: save_recommendations → input required: { "recommendations": [...] }
```

This is just text. When Claude wants to search, instead of writing prose, it writes a structured response:

```
type: tool_use
name: search_web
input: { "query": "Kutch embroidery brand India" }
```

Vercel receives this, runs a simple if/else check:
- If tool name is `search_web` → call SerpAPI with the query, pass results back to Claude
- If tool name is `save_recommendations` → store the brands, end the loop
- If no tool use → Claude is done, end the loop

Claude decides **when** to search, **what** to search for, and **when to stop**. Vercel just watches for the structured signal and mechanically executes whatever Claude requested. The tool definitions we wrote are a menu handed to Claude. Claude picks from the menu. Vercel fulfils the order.

---

## What we wrote the code for vs. what Claude does

### What the code does (written by us, mechanical)

- **The tools menu** — defines `search_web` and `save_recommendations` with their exact input formats. Without this, Claude wouldn't know what structured format to write back.
- **The orchestration loop** — the `while` loop that sends messages to Claude, checks for tool calls, routes to the right action, appends results back to the conversation, and repeats.
- **The blocklist filter** — 40+ domains Claude must never recommend (Myntra, Instagram, Vogue, etc.), stripped from SerpAPI results before Claude even sees them.
- **The brief assembly** — reads all five JSON files, counts feedback tags, joins brand names into a comma list, copy-pastes Claude's own prior learnings text. All mechanical string operations, no interpretation.
- **The evaluator call** — sends the final shortlist to Claude with a scoring rubric. We wrote the rubric; Claude applies it.
- **The learning trigger** — fires a separate Claude call every 3 runs with past performance data. We decide when and what data to send; Claude writes the analysis.
- **The Shopify tester** — hits `/products.json` on each recommended URL. Pure mechanical HTTP check, no Claude.
- **The GitHub writes** — reads file SHAs, writes updated JSON, creates commits.

### What Claude does (judgement, not code)

- Decides what to search for given the brief
- Reads snippets and judges whether a URL is a real brand vs. a blog or marketplace
- Chooses which results are worth recommending and why
- Writes the reasoning for each recommendation
- Scores brands in the evaluator (applying the rubric we gave it)
- Writes the learnings summary that gets injected back next run

**The honest summary: we built the rails. Claude runs on them.**

---

## The journey of a discovery query

### Step 1 — Browser fires one request
`POST /api/discover` with `{ brief: "your query" }`. Nothing intelligent has happened yet.

### Step 2 — Vercel reads the filing cabinet
Calls GitHub API five times in parallel. Reads all JSON files to build context:
- A **blocklist** of every URL never to recommend (existing brands, rejected ones, brands marked "not for me")
- Your **feedback tags** (Vibe / Price / Design) to count and summarise

### Step 3 — Vercel assembles Claude's brief (mechanically)
Vercel has no intelligence here. It does simple string operations:
- Joins brand names from `brands.json` into a comma list → "don't recommend these"
- Counts your feedback tags (e.g. 3× `price: accessible`) → writes the sentence "user prefers affordable brands"
- Copy-pastes the summary paragraph from `discovery_learnings.json` — this text was **written by Claude in a previous run**, not by Vercel. Vercel is handing Claude its own prior words back.

The result is one large document (the system prompt) assembled from these mechanical operations.

If you wrote a style brief, your words replace the default axis theme as the direction.

### Step 4 — The discovery loop begins
Vercel sends the brief and tools menu to Claude. Claude responds with a tool call. Vercel executes it and sends the result back. This repeats 6–8 times:

1. Vercel sends brief + tools menu to Anthropic API
2. Claude writes back a `search_web` tool call with its chosen query
3. Vercel calls SerpAPI with that query
4. SerpAPI returns 10 results (title, URL, snippet per result)
5. Vercel strips out any blocklisted domains
6. Vercel appends the results to the conversation and sends everything back to Claude
7. Claude reads the snippets, uses its own judgement to decide what looks like a real brand, and picks its next query
8. Repeat

**The whiteboard problem:** The entire conversation — every query and every result — is physically re-sent to Claude on every round. Claude has no persistent memory; the only reason it "remembers" earlier searches is because the full history is included each time. By round 8, Claude is re-reading 80 search results, most of which it already decided were useless. This is the main cost — deferred to Phase 3 optimisation.

**Why crossover brands appear:** Claude reads snippets. When a brand's Google description says "handwoven cotton — clothing and home", it matches a craft-aesthetic brief better than a pure clothing brand. Claude infers this from the brief without being told explicitly. This is the judgement we cannot code.

### Step 5 — Claude saves its picks
After enough searches, Claude writes a `save_recommendations` tool call with 5–8 URLs, names, and reasons. Vercel reads this and exits the loop.

### Step 6 — Vercel verifies each URL independently
Hits every brand's `/products.json` endpoint simultaneously. Pure mechanical checking — no Claude involved. Confirms: real Shopify store? How many products? What's one example product name?

### Step 7 — A second Claude call scores the results
Completely separate from the discovery loop. Vercel sends the shortlist to Claude with a scoring rubric: 1–5 on whether it's genuinely Indian, a real storefront, and strong aesthetic fit. We wrote the rubric; Claude applies it. Brands below 3 are dropped before you see them.

### Step 8 — Vercel writes back to GitHub
Two PUT requests to the GitHub API:
- Updated `recommendations.json` (new pending brands)
- Updated `discovery_log.json` (full record of this run)

Each write = one git commit. That's the audit trail.

### Step 9 — Vercel replies to the browser
The original request — sent 30–60 seconds ago — finally gets a response. The admin panel renders the brand cards.

---

## What has intelligence vs. what doesn't

| Component | Intelligence? | What it actually does |
|---|---|---|
| Browser (`admin.html`) | No | Renders HTML, sends clicks as HTTP requests |
| Vercel | No | Reads files, counts, joins strings, runs if/else logic, orchestrates calls |
| Claude | Yes | Decides what to search, reads snippets, picks brands, scores results, writes learnings |
| SerpAPI | No | Translates a query string into 10 search results |
| Shopify endpoints | No | Returns product data from a public URL |
| GitHub API | No | Reads and writes files, creates commits |

**The key mental model:** Vercel is the operations room — it manages who talks to whom and when. Claude is the expert consultant who does all the actual thinking but cannot pick up the phone itself. GitHub is the filing cabinet. SerpAPI is the researcher with internet access. Brand websites are suppliers being vetted.

---

## Measurement layer (Phase 2)

Every run writes structured data to `discovery_log.json`:
- Which axis / brief was used
- Every search query Claude ran
- Every brand found, with its evaluator score (1–5)
- Which search query and position in results surfaced each brand

Every accepted brand in `brands.json` now carries:
- `discoveredAt` — when Claude found it
- `acceptedAt` — when you approved it
- `runNumber` — which discovery run
- `searchAxis` — which theme found it

Every feedback entry in `user_feedback.json` carries:
- `vibe` — My vibe / Maybe / Not for me
- `price` — Accessible / Premium / Luxe
- `design` — Familiar / Fresh / Standout

Together these three files let you measure whether new features (feedback loop, learning, axis rotation) are improving discovery quality over time — without touching the engine.
