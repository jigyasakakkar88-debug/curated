# Curated — System Architecture

## The three types of components

### 1. Interface
What humans look at and interact with.

- **`admin.html`** — your browser tab. Shows information, lets you click buttons. No intelligence of its own. Sends requests to Vercel and renders whatever comes back.

### 2. Services
Things that do work when called upon. Sit idle until triggered.

- **Vercel** — your backend. Five small programs that run in the cloud when your browser calls them (`discover.js`, `products.js`, `admin.js`, `recommendations.js`, `feedback.js`). Vercel has no intelligence — it reads files, does simple counting/string-joining, and orchestrates calls to other services.
- **Claude (Anthropic API)** — the intelligence layer. Called with a question, returns a response. Has no memory between calls — you must hand it everything it needs every single time.
- **SerpAPI** — a middleman that lets your code search Google. Google doesn't allow direct software access, so SerpAPI sits in between and returns structured results.
- **Shopify (brand websites)** — not a subscribed service. Every Shopify store publicly exposes a `/products.json` URL. Vercel just reads that open door to verify a brand is real.

### 3. Data sources
Where information lives at rest. Your entire database is six JSON files on GitHub.

| File | What it stores |
|---|---|
| `brands.json` | Accepted brands (name, URL, timestamps, which run found them) |
| `recommendations.json` | Pending and rejected brand suggestions |
| `user_feedback.json` | Your Vibe / Price / Design ratings and notes per brand |
| `discovery_log.json` | Full record of every discovery run (queries, scores, results) |
| `discovery_learnings.json` | Claude's own analysis of what's working — written by Claude, read back to Claude |
| `settings.json` | Sale threshold, new arrivals window |

Every read and write goes through the **GitHub API**. Every write creates a git commit — that's the audit trail.

---

## How the components communicate

| From | To | Protocol | What travels |
|---|---|---|---|
| Browser | Vercel | HTTP POST `/api/discover` | Your query text + password |
| Vercel | GitHub API | HTTP GET | Reads the JSON files |
| Vercel | Anthropic API | HTTP POST `/v1/messages` | Assembled brief + full conversation so far |
| Anthropic API | Vercel | HTTP response | Claude's next move (search this / save these) |
| Vercel | SerpAPI | HTTP GET | A search query string |
| SerpAPI | Vercel | HTTP response | 10 results: title, URL, snippet |
| Vercel | Brand websites | HTTP GET `/products.json` | Nothing — just knocking |
| Brand websites | Vercel | HTTP response | Product count + sample product name |
| Vercel | GitHub API | HTTP PUT | Updated JSON files as new git commits |
| Vercel | Browser | HTTP response | Final list of found brands |

All connections in a single discovery run are **sequential** — browser sends one request and waits. Vercel orchestrates everything and only replies when fully done. This is why discovery takes 30–60 seconds.

---

## The journey of a discovery query

### Step 1 — Browser fires one request
`POST /api/discover` with `{ brief: "your query" }`. Nothing intelligent yet.

### Step 2 — Vercel reads the filing cabinet
Calls GitHub API five times in parallel. Reads all JSON files to understand full context:
- Builds a **blocklist** — every URL it must never recommend (existing brands, rejected ones, brands you marked "not for me")
- Prepares **feedback data** — your Vibe/Price/Design tags

### Step 3 — Vercel assembles Claude's brief (mechanically)
Vercel has no intelligence here. It does simple operations:
- Joins brand names from `brands.json` into a comma list → "don't recommend these"
- Counts your feedback tags (e.g. 3× `price: accessible`) → writes "user prefers affordable brands"
- Copy-pastes the summary text from `discovery_learnings.json` — this text was **written by Claude in a previous run**, not by Vercel

The result is one large document (the system prompt) stitched together from these mechanical operations, plus Claude's own prior words handed back to it.

If you wrote a brief, your words become the direction. The axis rotation (today's assigned theme) is skipped.

### Step 4 — The discovery loop begins
Vercel and Claude pass notes back and forth:

1. Vercel sends the brief to the Anthropic API
2. Claude decides its first search query and sends it back
3. Vercel calls SerpAPI with that query
4. SerpAPI returns 10 results
5. Vercel filters out blocklisted URLs and passes the rest back to Claude
6. Claude reads snippets, decides what looks like a real brand storefront, picks its next query
7. Repeat 6–8 times

**Important:** The entire conversation — every search query and every result — accumulates and is re-sent to Claude on every round. Claude has no persistent memory; the only reason it "remembers" earlier searches is because the full history is physically re-sent each time. This is the main token cost.

**Why crossover brands (home + clothing) appear:** Claude reads snippets. When a brand's Google description says "handwoven cotton — clothing and home", that matches a craft-aesthetic brief better than a pure clothing brand. Claude infers this from your words without being told explicitly.

### Step 5 — Claude saves its picks
After enough searches, Claude calls `save_recommendations` with 5–8 URLs, names, and reasons.

### Step 6 — Vercel verifies each URL independently
Hits every brand's `/products.json` endpoint simultaneously. Pure mechanical checking — no Claude involved. Confirms: real Shopify store? How many products? Sample product name?

### Step 7 — A second Claude call scores the results
Separate from the discovery loop. Vercel sends the shortlist to Claude with a scoring rubric: 1–5 on whether it's genuinely Indian, a real storefront, strong aesthetic fit. Brands below 3 are dropped silently.

### Step 8 — Vercel writes back to GitHub
Two PUT requests to GitHub API:
- Updated `recommendations.json` (new pending brands)
- Updated `discovery_log.json` (record of this run)

Each write = one git commit.

### Step 9 — Vercel replies to the browser
The original request — sent 30–60 seconds ago — finally gets a response. The admin panel renders the brand cards.

---

## What has intelligence vs. what doesn't

| Component | Intelligence? | What it actually does |
|---|---|---|
| Browser (`admin.html`) | No | Renders HTML, sends clicks as HTTP requests |
| Vercel | No | Reads files, counts, joins strings, orchestrates calls |
| Claude | Yes | Decides what to search, reads snippets, picks brands, scores, writes learnings |
| SerpAPI | No | Translates a query string into 10 search results |
| Shopify endpoints | No | Returns product data from a public URL |
| GitHub API | No | Reads and writes files, creates commits |

**The key mental model:** Vercel is the operations room — it manages who talks to whom and when. Claude is the expert consultant — it does all the actual thinking. GitHub is the filing cabinet. SerpAPI is the researcher with internet access. Brand websites are the suppliers being vetted.

---

## Measurement layer (Phase 2)

Every run writes structured data to `discovery_log.json`:
- Which axis / brief was used
- Every search query Claude ran
- Every brand found, with its evaluator score (1–5)
- Which search query and position surfaced each brand

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
