const https = require('https');

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN       || "";
const GITHUB_REPO    = process.env.GITHUB_REPO        || "";
const SERPAPI_KEY    = process.env.SERPAPI_KEY         || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD      || "changeme123";
const GITHUB_BRANCH  = "main";
const MAX_TURNS      = 12;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.headers["authorization"] !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: "SERPAPI_KEY not configured in Vercel environment variables." });
  }
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured in Vercel environment variables." });
  }

  const { brief = '' } = req.body || {};

  try {
    // Load existing data
    const [brands, recData] = await Promise.all([
      readFromGitHub('brands.json').catch(() => []),
      readFromGitHub('recommendations.json').catch(() => ({ pending: [], rejected: [] })),
    ]);

    const existingUrls = new Set(brands.map(b => rootDomain(b.url)).filter(Boolean));
    const pendingUrls  = new Set((recData.pending || []).map(r => rootDomain(r.url)).filter(Boolean));
    const rejectedIds  = new Set(recData.rejected || []);
    const existingBrandList = brands.map(b => b.name).join(', ') || 'none yet';

    // Tool definitions
    const tools = [
      {
        name: "search_web",
        description: "Search Google for Indian fashion brands. Returns up to 10 results with title, URL, and snippet. Run 4-8 targeted searches before saving.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query to find brand websites" }
          },
          required: ["query"]
        }
      },
      {
        name: "save_recommendations",
        description: "Save your final curated list of brand website URLs. Call this once you have found 3-8 high-quality brand websites. Each recommendation needs a URL, name, and reason.",
        input_schema: {
          type: "object",
          properties: {
            recommendations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  url:    { type: "string", description: "Full URL of the brand website, e.g. https://anokhi.com" },
                  name:   { type: "string", description: "Brand name" },
                  reason: { type: "string", description: "Why this brand matches the style brief (1-2 sentences)" }
                },
                required: ["url", "name", "reason"]
              }
            }
          },
          required: ["recommendations"]
        }
      }
    ];

    const systemPrompt = `You are a fashion brand discovery agent for Curated, a personal Indian fashion aggregator. Your job is to discover new INDIAN fashion brands.

You have two tools:
- search_web: run a Google search and get back 10 results
- save_recommendations: save your final curated list of brand URLs (call this once done)

STRICT RULES — follow these without exception:
1. INDIA ONLY — every brand you recommend must be founded in India, headquartered in India, and primarily serve Indian customers. If the snippet or title does not clearly indicate the brand is Indian, skip it.
2. Only recommend direct BRAND STOREFRONTS with their own website (e.g. anokhi.com, fabindia.com). No blogs, magazines, marketplaces, multi-brand retailers, or aggregators.
3. Never recommend: Myntra, Nykaa Fashion, Amazon, Flipkart, Ajio, Meesho, Indiamart, Craftsvilla, TataCliq, Vogue, Elle, Harper's Bazaar, Wikipedia, Reddit, Quora, Medium, Instagram, Pinterest, or any article/listicle URLs.
4. Never recommend international brands (e.g. Zara India, H&M India, global brands with an India store).
5. Only recommend a brand if you can confirm it is a real fashion brand storefront from the title and snippet — not a search result about a brand, not a review, not a news article.
6. Run 6-8 targeted searches before saving. Each search should explore a distinct angle — don't repeat the same query.
7. After each search, assess results critically. If a result looks like a blog or marketplace, discard it.
8. Find 4-8 genuinely new brand websites, then call save_recommendations.

Search strategies that work well:
- "[specific craft/technique] brand India site" (e.g. "ajrakh block print brand India")
- "[region] handloom clothing brand India" (e.g. "Kutch weave clothing brand India")
- "indie [aesthetic] Indian women's clothing brand" (e.g. "indie cottagecore Indian women's clothing brand")
- "[designer name] Indian fashion label" when you spot a designer name in results
- Include "online store" or "official website" to surface storefronts over articles

Existing brands already on Curated (do NOT recommend these): ${existingBrandList}`;

    // Rotate exploration axes so each no-brief run discovers a different corner of Indian fashion
    const explorationAxes = [
      {
        theme: 'Regional craft traditions',
        angles: ['Kutch embroidery and mirror work', 'Ajrakh and dabu block print from Rajasthan', 'Chanderi and Maheshwari weaves from MP', 'Pochampally and Ikat from Telangana/Odisha', 'Kalamkari hand-painted textiles from Andhra'],
      },
      {
        theme: 'Slow fashion and sustainable labels',
        angles: ['natural dye indie labels', 'zero-waste and upcycled Indian fashion', 'handspun khadi clothing brands', 'organic cotton indie labels India', 'artisan cooperative clothing brands'],
      },
      {
        theme: 'Contemporary Indian designers',
        angles: ['independent Indian women\'s wear designers', 'contemporary fusion Indian label', 'minimalist Indian ethnic wear', 'NID/NIFT graduate fashion labels', 'emerging Indian designer storefronts'],
      },
      {
        theme: 'Specific garment categories',
        angles: ['hand-block-printed kurta brands India', 'Indian linen and cotton co-ord sets', 'indie Indian saree labels', 'Indian resort and vacation wear brands', 'artisanal Indian accessories and textiles'],
      },
    ];

    const axis = explorationAxes[new Date().getDate() % explorationAxes.length];

    const userMsg = brief.trim()
      ? `Style brief: "${brief.trim()}"\n\nDiscover 4-8 new Indian fashion brand websites that match this brief. For each search, try a distinct angle — different aesthetics, materials, occasions, regional craft traditions. Only recommend brands that are clearly Indian.`
      : `Discover 4-8 new Indian fashion brand websites to add to Curated.\n\nToday's exploration theme: **${axis.theme}**\n\nAngles to explore: ${axis.angles.join('; ')}.\n\nSearch each angle specifically. After exhausting this theme, if you still need more brands, branch out to adjacent Indian craft traditions or indie labels you spot in results. Only recommend brands clearly based in India.`;

    // Agentic loop
    let messages   = [{ role: 'user', content: userMsg }];
    let finalRecs  = null;
    let turns      = 0;
    const searchLog = [];

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
              const results = await googleSearch(query);
              const filtered = (results.items || []).filter(item => {
                const domain = rootDomain(item.link);
                if (!domain) return false;
                try {
                  const hostname = new URL(domain).hostname.replace(/^www\./, '');
                  if (SKIP_DOMAINS.has(hostname)) return false;
                } catch { return false; }
                if (existingUrls.has(domain) || pendingUrls.has(domain)) return false;
                return true;
              });
              const top = filtered.slice(0, 10).map(r => ({
                title:   r.title,
                url:     r.link,
                snippet: r.snippet || '',
              }));
              resultText = top.length
                ? JSON.stringify(top)
                : 'No relevant results found for this query. Try a different search.';
            } catch (e) {
              resultText = `Search error: ${e.message}`;
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
          }

          if (block.name === 'save_recommendations') {
            finalRecs = block.input.recommendations || [];
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Saved.' });
          }
        }

        if (toolResults.length > 0) {
          messages.push({ role: 'user', content: toolResults });
        }
      }
    }

    if (!finalRecs || finalRecs.length === 0) {
      return res.status(200).json({
        success:      true,
        newFound:     0,
        totalPending: (recData.pending || []).length,
        pending:      recData.pending || [],
        debug:        { turns, searchLog },
      });
    }

    // Test Shopify for each recommendation in parallel
    const urlsToTest = finalRecs.map(r => rootDomain(r.url) || r.url);
    const shopifyTests = await Promise.allSettled(urlsToTest.map(u => testShopify(u)));

    const newRecs = [];
    finalRecs.forEach((r, i) => {
      const url = urlsToTest[i];
      const id  = makeId(url);
      if (rejectedIds.has(id)) return;
      const st       = shopifyTests[i];
      const isShopify = st.status === 'fulfilled' && st.value.valid;
      newRecs.push({
        id,
        name:          r.name,
        url,
        reason:        r.reason,
        isShopify,
        sampleProduct: isShopify ? st.value.sampleProduct : null,
        productCount:  isShopify ? st.value.productCount  : null,
        discoveredAt:  new Date().toISOString(),
      });
    });

    // Merge with existing pending, avoiding duplicates
    const existingPendingIds = new Set((recData.pending || []).map(r => r.id));
    const merged = [
      ...(recData.pending || []),
      ...newRecs.filter(r => !existingPendingIds.has(r.id)),
    ];

    const updated = { pending: merged, rejected: recData.rejected || [] };
    let sha = null;
    try { sha = await getFileSha('recommendations.json'); } catch {}
    await writeToGitHub('recommendations.json', updated, sha, `Discover: +${newRecs.length} recommendations`);

    return res.status(200).json({
      success:      true,
      newFound:     newRecs.length,
      totalPending: merged.length,
      pending:      merged,
      debug:        { turns, searchLog },
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};

// ── Anthropic API ─────────────────────────────────────────

function callClaude(system, messages, tools) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      system,
      messages,
      tools,
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
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
          if (resp.statusCode >= 400) {
            reject(new Error(parsed.error?.message || `Anthropic ${resp.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch { reject(new Error('Invalid Anthropic response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Anthropic request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Domains to skip — passed to Claude as context and used to filter results ──

const SKIP_DOMAINS = new Set([
  'instagram.com','pinterest.com','facebook.com','twitter.com','x.com','youtube.com','linkedin.com',
  'myntra.com','amazon.in','amazon.com','flipkart.com','nykaa.com','ajio.com','meesho.com',
  'indiamart.com','snapdeal.com','tatacliq.com','craftsvilla.com',
  'vogue.in','elle.in','harpersbazaar.in','femina.in','grazia.in',
  'wikipedia.org','reddit.com','quora.com','medium.com','blogspot.com','wordpress.com',
  'zara.com','hm.com','uniqlo.com','shein.com',
]);

// ── SerpAPI search ────────────────────────────────────────

function googleSearch(query) {
  return new Promise((resolve, reject) => {
    const qs  = `api_key=${encodeURIComponent(SERPAPI_KEY)}&q=${encodeURIComponent(query)}&num=10&engine=google`;
    const req = https.get(
      `https://serpapi.com/search.json?${qs}`,
      { headers: { 'Accept': 'application/json' }, timeout: 12000 },
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
