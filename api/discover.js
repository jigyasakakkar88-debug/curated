const https  = require('https');
const crypto = require('crypto');

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN       || "";
const GITHUB_REPO    = process.env.GITHUB_REPO        || "";
const SERPAPI_KEY    = process.env.SERPAPI_KEY         || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD      || "changeme123";
const GITHUB_BRANCH  = "main";
const MAX_TURNS      = 15;
const LEARNING_INTERVAL = 3;  // run learning analysis every N runs
const MAX_LOG_RUNS   = 60;    // cap log size

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.headers["authorization"] !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!SERPAPI_KEY)    return res.status(500).json({ error: "SERPAPI_KEY not configured." });
  if (!ANTHROPIC_KEY)  return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });

  const { brief = '' } = req.body || {};

  try {
    // ── 1. Load all data in parallel ──────────────────────
    const [brands, recData, logData, learnings, feedback] = await Promise.all([
      readFromGitHub('brands.json').catch(() => []),
      readFromGitHub('recommendations.json').catch(() => ({ pending: [], rejected: [] })),
      readFromGitHub('discovery_log.json').catch(() => ({ runs: [] })),
      readFromGitHub('discovery_learnings.json').catch(() => null),
      readFromGitHub('user_feedback.json').catch(() => ({ entries: [] })),
    ]);

    const existingUrls      = new Set(brands.map(b => rootDomain(b.url)).filter(Boolean));
    const pendingUrls       = new Set((recData.pending || []).map(r => rootDomain(r.url)).filter(Boolean));
    const rejectedIds       = new Set(recData.rejected || []);
    const existingBrandList = brands.map(b => b.name).join(', ') || 'none yet';

    // Brands marked not_relevant by user — exclude from recommendations
    const feedbackEntries     = feedback?.entries || [];
    const userExcludedIds     = new Set(
      feedbackEntries.filter(e => e.rating === 'not_relevant').map(e => e.storefrontId)
    );
    const userExcludedUrls    = new Set(
      feedbackEntries.filter(e => e.rating === 'not_relevant').map(e => rootDomain(e.storefrontUrl)).filter(Boolean)
    );

    // Current run number
    const runNumber = (logData.runs || []).length + 1;

    // ── 2. Exploration axes (base + learned new axes) ─────
    const baseAxes = [
      {
        theme: 'Regional craft traditions',
        angles: ['Kutch embroidery and mirror work India brand', 'Ajrakh block print Rajasthan brand storefront', 'Chanderi Maheshwari weaves MP clothing brand', 'Pochampally Ikat Telangana Odisha brand', 'Kalamkari hand-painted textiles Andhra brand'],
      },
      {
        theme: 'Slow fashion and sustainable labels',
        angles: ['natural dye indie label India clothing brand', 'zero-waste upcycled Indian fashion brand', 'handspun khadi clothing brand India storefront', 'organic cotton indie label India women', 'artisan cooperative clothing brand India'],
      },
      {
        theme: 'Contemporary Indian designers',
        angles: ['independent Indian womenswear designer brand', 'contemporary fusion Indian clothing label storefront', 'minimalist Indian ethnic wear brand', 'NID NIFT graduate fashion label India', 'emerging Indian designer brand official website'],
      },
      {
        theme: 'Specific garment categories',
        angles: ['hand block printed kurta brand India storefront', 'Indian linen cotton co-ord set brand', 'indie Indian saree label brand website', 'Indian resort vacation wear brand storefront', 'artisanal Indian jacket cape brand'],
      },
    ];

    // Append any new axes learned from previous runs
    const allAxes = [...baseAxes, ...(learnings?.newAxes || [])];

    // If learnings flag axes to emphasize, weight them by inserting duplicates
    if (learnings?.emphasizeAxes?.length) {
      const boosted = allAxes.filter(a => learnings.emphasizeAxes.includes(a.theme));
      allAxes.push(...boosted); // appears twice → double chance of selection
    }

    const axis = allAxes[new Date().getDate() % allAxes.length];

    // ── 3. Build system prompt with injected learnings + feedback ─
    const learningsSection  = buildLearningsSection(learnings);
    const feedbackSection   = await buildFeedbackSection(feedbackEntries);

    const systemPrompt = `You are a fashion brand discovery agent for Curated, a personal Indian fashion aggregator. Your job is to discover new INDIAN fashion brands.

You have two tools:
- search_web: run a Google search; returns up to 10 results with position number, title, URL, snippet
- save_recommendations: save your final curated list (call this once done)

STRICT RULES — no exceptions:
1. INDIA ONLY — every brand must be founded in India, headquartered in India, and primarily serve Indian customers. If the snippet/title does not clearly confirm the brand is Indian, skip it.
2. Only recommend direct BRAND STOREFRONTS (the brand's own website, e.g. anokhi.com). No blogs, magazines, multi-brand retailers, aggregators, or marketplaces.
3. Never recommend: Myntra, Nykaa, Amazon, Flipkart, Ajio, Meesho, Indiamart, Craftsvilla, TataCliq, Vogue, Elle, Harper's Bazaar, Wikipedia, Reddit, Quora, Medium, Instagram, Pinterest, Zara India, H&M India, or any global brand with an India storefront.
4. Never recommend an article, listicle, review, or "top 10 brands" page — these are disqualified even if the URL looks like a brand.
5. Run 6-8 targeted searches before saving. Each search must explore a genuinely different angle.
6. Find 4-8 genuinely new Indian brand storefronts, then call save_recommendations.

Search strategies that work well:
- "[craft/technique] brand India official website" — e.g. "ajrakh block print brand India official website"
- "[Indian region] handloom clothing brand" — e.g. "Kutch weave women clothing brand"
- "indie [aesthetic] Indian label storefront" — e.g. "indie slow fashion Indian label storefront"
- "[designer name] Indian fashion label" — follow up on designer names you spot in snippets
- Add "site:shopify.com" occasionally to surface indie Shopify storefronts directly
${learningsSection}${feedbackSection}
Existing brands already on Curated — do NOT recommend these: ${existingBrandList}`;

    const userMsg = brief.trim()
      ? `Style brief: "${brief.trim()}"\n\nDiscover 4-8 new Indian fashion brand websites matching this brief. Search from multiple distinct angles — aesthetics, materials, occasions, regional craft traditions. Only recommend clearly Indian brands.`
      : `Discover 4-8 new Indian fashion brand websites for Curated.\n\nToday's exploration theme: **${axis.theme}**\nAngles to explore: ${axis.angles.join(' · ')}\n\nSearch each angle with a targeted query. After exhausting this theme, branch into adjacent Indian craft traditions or indie labels you spot in snippets. Only recommend brands clearly based in India.`;

    // ── 4. Tool definitions ───────────────────────────────
    const tools = [
      {
        name: "search_web",
        description: "Search Google for Indian fashion brands. Returns up to 10 results with position (1=top), title, URL, snippet. Run 6-8 targeted searches before saving.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "save_recommendations",
        description: "Save your final curated list. Call once you have 4-8 high-quality Indian brand storefronts.",
        input_schema: {
          type: "object",
          properties: {
            recommendations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  url:    { type: "string", description: "Brand website URL" },
                  name:   { type: "string" },
                  reason: { type: "string", description: "Why this is a good Indian fashion brand (1-2 sentences)" },
                },
                required: ["url", "name", "reason"],
              },
            },
          },
          required: ["recommendations"],
        },
      },
    ];

    // ── 5. Agentic discovery loop ─────────────────────────
    let messages    = [{ role: 'user', content: userMsg }];
    let finalRecs   = null;
    let turns       = 0;
    const searchLog     = [];
    const searchResults = []; // [{query, results:[{position,title,url,snippet}]}]

    while (turns < MAX_TURNS && !finalRecs) {
      turns++;
      const response = await callClaude(systemPrompt, messages, tools);
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') break;

      if (response.stop_reason === 'tool_use') {
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          if (block.name === 'search_web') {
            const query = block.input.query || '';
            searchLog.push(query);
            let resultText;
            try {
              const raw = await googleSearch(query);
              const filtered = (raw.items || []).filter(item => {
                const domain = rootDomain(item.link);
                if (!domain) return false;
                try {
                  const hostname = new URL(domain).hostname.replace(/^www\./, '');
                  if (SKIP_DOMAINS.has(hostname)) return false;
                } catch { return false; }
                return !existingUrls.has(domain) && !pendingUrls.has(domain) && !userExcludedUrls.has(domain);
              });
              const top = filtered.slice(0, 10).map((r, i) => ({
                position: i + 1,
                title:    r.title,
                url:      r.link,
                snippet:  r.snippet || '',
              }));
              searchResults.push({ query, results: top });
              resultText = top.length ? JSON.stringify(top) : 'No relevant results. Try a different query.';
            } catch (e) {
              searchResults.push({ query, results: [] });
              resultText = `Search error: ${e.message}`;
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
          }

          if (block.name === 'save_recommendations') {
            finalRecs = block.input.recommendations || [];
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Saved.' });
          }
        }

        if (toolResults.length) messages.push({ role: 'user', content: toolResults });
      }
    }

    if (!finalRecs || !finalRecs.length) {
      return res.status(200).json({
        success: true, newFound: 0,
        totalPending: (recData.pending || []).length,
        pending: recData.pending || [],
        debug: { turns, searchLog, axis: axis.theme },
      });
    }

    // ── 6. Shopify test + source tracking ─────────────────
    const urlsToTest   = finalRecs.map(r => rootDomain(r.url) || r.url);
    const shopifyTests = await Promise.allSettled(urlsToTest.map(u => testShopify(u)));

    const newRecs = [];
    finalRecs.forEach((r, i) => {
      const url = urlsToTest[i];
      const id  = makeId(url);
      if (rejectedIds.has(id) || userExcludedIds.has(id)) return;

      const st        = shopifyTests[i];
      const isShopify = st.status === 'fulfilled' && st.value.valid;

      // Find which query and position surfaced this URL
      let sourceQuery = null, sourcePosition = null;
      for (const { query, results } of searchResults) {
        const hit = results.find(res => rootDomain(res.url) === url || res.url === url);
        if (hit) { sourceQuery = query; sourcePosition = hit.position; break; }
      }

      newRecs.push({
        id, name: r.name, url, reason: r.reason,
        isShopify,
        sampleProduct:  isShopify ? st.value.sampleProduct : null,
        productCount:   isShopify ? st.value.productCount  : null,
        discoveredAt:   new Date().toISOString(),
        runNumber,
        searchAxis:     axis.theme,
        sourceQuery,
        sourcePosition,
      });
    });

    // ── 7. Evaluate recommendations ───────────────────────
    const evaluatedRecs = await evaluateRecommendations(newRecs, brief || axis.theme);

    // ── 8. Save quality recs (score >= 3) to pending ──────
    const qualityRecs        = evaluatedRecs.filter(r => r.score >= 3);
    const existingPendingIds = new Set((recData.pending || []).map(r => r.id));
    const merged = [
      ...(recData.pending || []),
      ...qualityRecs.filter(r => !existingPendingIds.has(r.id)),
    ];
    const updatedRecs = { pending: merged, rejected: recData.rejected || [] };
    let recSha = null;
    try { recSha = await getFileSha('recommendations.json'); } catch {}
    await writeToGitHub('recommendations.json', updatedRecs, recSha,
      `Discover: +${qualityRecs.length} recommendations`);

    // ── 9. Append to discovery log ────────────────────────
    const runEntry = {
      runId:     crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      brief:     brief || null,
      axis:      axis.theme,
      turns,
      searchLog,
      recommendations: evaluatedRecs, // log ALL including underperforming
      axisScore: evaluatedRecs.length
        ? +(evaluatedRecs.reduce((s, r) => s + (r.score || 0), 0) / evaluatedRecs.length).toFixed(2)
        : null,
    };

    const updatedLog = {
      runs: [...(logData.runs || []), runEntry].slice(-MAX_LOG_RUNS),
    };
    let logSha = null;
    try { logSha = await getFileSha('discovery_log.json'); } catch {}
    await writeToGitHub('discovery_log.json', updatedLog, logSha,
      `Discovery log: run ${updatedLog.runs.length}`);

    // ── 10. Trigger learning every N runs ─────────────────
    let learningResult = null;
    const runsSinceLearning = learnings?.lastAnalyzed
      ? updatedLog.runs.filter(r => r.timestamp > learnings.lastAnalyzed).length
      : updatedLog.runs.length;

    if (runsSinceLearning >= LEARNING_INTERVAL) {
      try {
        learningResult = await runLearningAnalysis(updatedLog);
        let learnSha = null;
        try { learnSha = await getFileSha('discovery_learnings.json'); } catch {}
        await writeToGitHub('discovery_learnings.json', learningResult, learnSha,
          'Update discovery learnings');
      } catch (e) {
        console.error('Learning analysis failed:', e.message);
      }
    }

    return res.status(200).json({
      success:      true,
      newFound:     qualityRecs.length,
      totalPending: merged.length,
      pending:      merged,
      debug: {
        turns,
        searchLog,
        axis:              axis.theme,
        axisScore:         runEntry.axisScore,
        evaluated:         evaluatedRecs.length,
        underperforming:   evaluatedRecs.filter(r => r.score < 3).length,
        learningTriggered: !!learningResult,
        learningSummary:   learningResult?.summary || null,
      },
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};

// ── Feedback → system prompt injection ───────────────────

async function buildFeedbackSection(entries) {
  if (!entries?.length) return '';

  const liked      = entries.filter(e => e.rating === 'thumbs_up');
  const notRelevant = entries.filter(e => e.rating === 'not_relevant');
  const withComment = entries.filter(e => e.comment);

  const lines = ['\n## User feedback from previous recommendations:'];

  // Use Claude to extract actionable patterns from comments
  if (withComment.length > 0) {
    try {
      const prompt = `Analyze these user feedback comments for an Indian fashion brand discovery system.
Extract actionable patterns in 3 concise sentences:
1. What qualities users appreciate (e.g. natural dyes, artisanal craft, specific aesthetics)
2. What barriers or dislikes they flag (e.g. high prices, too formal, wrong vibe)
3. One concrete search guidance (e.g. "prioritise brands under ₹3000", "avoid heavy embroidery")

Feedback:
${withComment.map(e => `- "${e.storefrontName}" (${e.rating}): "${e.comment}"`).join('\n')}

Return only the 3 sentences, nothing else.`;

      const resp = await callClaude(
        'Extract concise actionable patterns from user feedback. Return exactly 3 sentences.',
        [{ role: 'user', content: prompt }],
        []
      );
      const summary = resp.content.find(b => b.type === 'text')?.text?.trim();
      if (summary) lines.push(summary);
    } catch {}
  }

  if (liked.length) {
    lines.push(`Brands users liked: ${liked.slice(-8).map(e => e.storefrontName).join(', ')}`);
  }

  if (notRelevant.length) {
    lines.push(`\nBrands marked NOT RELEVANT by user — do NOT recommend similar brands:`);
    notRelevant.slice(-10).forEach(e => {
      const why = e.comment ? ` — user said: "${e.comment}"` : '';
      lines.push(`  - ${e.storefrontName} (${e.storefrontUrl})${why}`);
    });
  }

  return '\n' + lines.join('\n');
}

// ── Learnings → system prompt injection ───────────────────

function buildLearningsSection(learnings) {
  if (!learnings?.summary) return '';
  const lines = [
    '\n## Learnings from previous runs — use these to guide your searches:',
    learnings.summary,
  ];
  if (learnings.emphasizeAxes?.length) {
    lines.push(`High-performing themes to emphasize: ${learnings.emphasizeAxes.join(', ')}`);
  }
  if (learnings.topQueryPatterns?.length) {
    lines.push(`Query patterns that found the best brands: ${learnings.topQueryPatterns.slice(0, 4).join(' · ')}`);
  }
  if (learnings.searchPositionInsight) {
    lines.push(`Search position insight: ${learnings.searchPositionInsight}`);
  }
  return '\n' + lines.join('\n');
}

// ── Evaluation ────────────────────────────────────────────

async function evaluateRecommendations(recs, context) {
  if (!recs.length) return [];

  const prompt = `Evaluate these Indian fashion brand recommendations for quality and relevance.

Context/brief: "${context}"

Score each brand 1-5 on OVERALL RELEVANCE:
5 = Excellent: genuine Indian indie storefront, strong earthy/artisanal aesthetic, clearly a curated label
4 = Good: real Indian brand storefront, solid fit for slow/artisan fashion
3 = Acceptable: real brand but more generic or mass-market
2 = Poor: possibly not India-based, multi-brand aggregator, very generic, or unclear storefront
1 = Bad: article, listicle, blog, international brand, marketplace — clearly wrong

Also score sub-dimensions 1-5:
- aesthetic: earthy, handmade, artisanal, slow-fashion sensibility
- briefMatch: alignment with the context/brief
- quality: indie curated label vs mass-market generic

Brands to evaluate:
${JSON.stringify(recs.map(r => ({
  id: r.id, name: r.name, url: r.url,
  reason: r.reason, isShopify: r.isShopify, sampleProduct: r.sampleProduct,
})), null, 2)}

Return ONLY a valid JSON array — no other text, no markdown:
[{"id":"...","score":N,"isStorefront":true/false,"isIndian":true/false,"aesthetic":N,"briefMatch":N,"quality":N,"notes":"one sentence"}]`;

  try {
    const resp  = await callClaude(
      'You are a precise evaluator. Return only a valid JSON array, nothing else.',
      [{ role: 'user', content: prompt }],
      []
    );
    const text   = resp.content.find(b => b.type === 'text')?.text || '[]';
    const match  = text.match(/\[[\s\S]*\]/);
    const scores = match ? JSON.parse(match[0]) : [];

    return recs.map(r => {
      const s = scores.find(x => x.id === r.id) || {};
      return {
        ...r,
        score: s.score ?? 3,
        scoreDetails: {
          isStorefront: s.isStorefront ?? null,
          isIndian:     s.isIndian     ?? null,
          aesthetic:    s.aesthetic    ?? null,
          briefMatch:   s.briefMatch   ?? null,
          quality:      s.quality      ?? null,
        },
        evaluatorNotes: s.notes || '',
        underperforming: (s.score ?? 3) < 3,
      };
    });
  } catch {
    return recs.map(r => ({
      ...r, score: 3,
      scoreDetails: {}, evaluatorNotes: 'Evaluation failed', underperforming: false,
    }));
  }
}

// ── Learning analysis ─────────────────────────────────────

async function runLearningAnalysis(log) {
  const runs = (log.runs || []).slice(-20);

  const axisMap  = {};
  const queryMap = {};
  const posMap   = {};

  for (const run of runs) {
    const scored = (run.recommendations || []).filter(r => r.score != null);
    if (!scored.length) continue;
    const runAvg = scored.reduce((s, r) => s + r.score, 0) / scored.length;

    if (run.axis) {
      if (!axisMap[run.axis]) axisMap[run.axis] = { total: 0, count: 0 };
      axisMap[run.axis].total += runAvg;
      axisMap[run.axis].count += 1;
    }

    for (const r of scored) {
      if (r.sourceQuery) {
        if (!queryMap[r.sourceQuery]) queryMap[r.sourceQuery] = { total: 0, count: 0 };
        queryMap[r.sourceQuery].total += r.score;
        queryMap[r.sourceQuery].count += 1;
      }
      if (r.sourcePosition != null) {
        const p = String(r.sourcePosition);
        if (!posMap[p]) posMap[p] = { total: 0, count: 0 };
        posMap[p].total += r.score;
        posMap[p].count += 1;
      }
    }
  }

  const axisPerf  = Object.entries(axisMap)
    .map(([axis, d]) => ({ axis, avgScore: +(d.total/d.count).toFixed(2), runs: d.count }))
    .sort((a, b) => b.avgScore - a.avgScore);

  const queryPerf = Object.entries(queryMap)
    .map(([query, d]) => ({ query, avgScore: +(d.total/d.count).toFixed(2), uses: d.count }))
    .sort((a, b) => b.avgScore - a.avgScore)
    .slice(0, 15);

  const posPerf = Object.entries(posMap)
    .map(([pos, d]) => ({ position: parseInt(pos), avgScore: +(d.total/d.count).toFixed(2), count: d.count }))
    .sort((a, b) => a.position - b.position);

  const prompt = `You are analyzing performance data from an Indian fashion brand discovery system to improve future runs.

Axis performance (theme → avg quality score, max 5):
${JSON.stringify(axisPerf)}

Top query performance (which exact search queries found the best brands):
${JSON.stringify(queryPerf)}

Search result position performance (position 1-10 within results → avg brand quality score):
${JSON.stringify(posPerf)}

Total runs analyzed: ${runs.length}

Based on this, generate:
1. A 2-3 sentence summary of what's working and what isn't
2. Which axes to emphasize in future runs (top 2-3 performers)
3. 2-3 new exploration axes NOT yet covered (consider: menswear, bridal, accessories, luxury handloom, specific underexplored states like Kerala/Karnataka/Northeast, plus-size Indian fashion, kidswear)
4. Top 5 query patterns to continue using (generalize from the best-performing specific queries)
5. One-sentence insight about which search result positions (1-10) yield the best brand discoveries

Return ONLY valid JSON — no other text:
{
  "summary": "...",
  "emphasizeAxes": ["axis name", "axis name"],
  "newAxes": [{"theme":"...","angles":["...","...","..."]}],
  "topQueryPatterns": ["pattern","pattern","pattern","pattern","pattern"],
  "searchPositionInsight": "..."
}`;

  const resp  = await callClaude(
    'You are a data analyst. Return only valid JSON, no other text.',
    [{ role: 'user', content: prompt }],
    []
  );
  const text  = resp.content.find(b => b.type === 'text')?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  const result = match ? JSON.parse(match[0]) : {};

  return {
    ...result,
    lastAnalyzed:           new Date().toISOString(),
    runsAnalyzed:           runs.length,
    axisPerformance:        axisPerf,
    queryPerformance:       queryPerf,
    searchPositionInsights: posPerf,
  };
}

// ── Anthropic API ─────────────────────────────────────────

function callClaude(system, messages, tools) {
  return new Promise((resolve, reject) => {
    const bodyObj = {
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      system,
      messages,
    };
    if (tools.length) bodyObj.tools = tools;
    const body = JSON.stringify(bodyObj);

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode >= 400) reject(new Error(parsed.error?.message || `Anthropic ${resp.statusCode}`));
          else resolve(parsed);
        } catch { reject(new Error('Invalid Anthropic response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('Anthropic request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Domains to skip ───────────────────────────────────────

const SKIP_DOMAINS = new Set([
  'instagram.com','pinterest.com','facebook.com','twitter.com','x.com','youtube.com','linkedin.com',
  'myntra.com','amazon.in','amazon.com','flipkart.com','nykaa.com','nykaafashion.com','ajio.com','meesho.com',
  'indiamart.com','snapdeal.com','tatacliq.com','craftsvilla.com','gleam.io',
  'vogue.in','elle.in','harpersbazaar.in','femina.in','grazia.in',
  'wikipedia.org','reddit.com','quora.com','medium.com','blogspot.com','wordpress.com',
  'zara.com','hm.com','uniqlo.com','shein.com',
  'so.city','ecocult.com','thegoodtrade.com','fashionrevolution.org',
]);

// ── SerpAPI ───────────────────────────────────────────────

function googleSearch(query) {
  return new Promise((resolve, reject) => {
    const qs  = `api_key=${encodeURIComponent(SERPAPI_KEY)}&q=${encodeURIComponent(query)}&num=10&engine=google`;
    const req = https.get(
      `https://serpapi.com/search.json?${qs}`,
      { headers: { 'Accept': 'application/json' }, timeout: 15000 },
      (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const items  = (parsed.organic_results || []).map(r => ({
              title:   r.title,
              link:    r.link,
              snippet: r.snippet || '',
            }));
            resolve({ items });
          } catch { reject(new Error('Invalid JSON from SerpAPI')); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SerpAPI timed out')); });
  });
}

// ── Shopify tester ────────────────────────────────────────

function testShopify(url) {
  return new Promise((resolve) => {
    const req = https.get(`${url}/products.json?limit=3`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 8000,
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400) {
        resolve({ valid: false }); return;
      }
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.products || !Array.isArray(parsed.products)) {
            resolve({ valid: false }); return;
          }
          resolve({
            valid:         true,
            productCount:  parsed.products.length,
            sampleProduct: parsed.products[0]?.title || null,
          });
        } catch { resolve({ valid: false }); }
      });
    });
    req.on('error', () => resolve({ valid: false }));
    req.on('timeout', () => { req.destroy(); resolve({ valid: false }); });
  });
}

// ── Utils ─────────────────────────────────────────────────

function rootDomain(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.hostname}`;
  } catch { return null; }
}

function makeId(url) {
  return (rootDomain(url) || url)
    .replace(/https?:\/\/(www\.)?/, '')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// ── GitHub helpers ────────────────────────────────────────

function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization':  `token ${GITHUB_TOKEN}`,
        'Accept':         'application/vnd.github.v3+json',
        'User-Agent':     'curated-style-aggregator',
        'Content-Type':   'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode >= 400) reject(new Error(parsed.message || `GitHub ${resp.statusCode}`));
          else resolve(parsed);
        } catch { reject(new Error('Invalid GitHub response')); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function readFromGitHub(filename) {
  const resp = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${filename}?ref=${GITHUB_BRANCH}`);
  return JSON.parse(Buffer.from(resp.content, 'base64').toString('utf8'));
}

async function getFileSha(filename) {
  const resp = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${filename}?ref=${GITHUB_BRANCH}`);
  return resp.sha;
}

async function writeToGitHub(filename, data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  return githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${filename}`, {
    message, content, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}),
  });
}
