const https = require('https');

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN   || "";
const GITHUB_REPO    = process.env.GITHUB_REPO    || "";
const SERPAPI_KEY    = process.env.SERPAPI_KEY    || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const GITHUB_BRANCH  = "main";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.headers["authorization"] !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: "SerpAPI not configured. Set SERPAPI_KEY in Vercel environment variables." });
  }

  try {
    // 1. Load brands + existing recommendations in parallel
    const [brands, recData] = await Promise.all([
      readFromGitHub('brands.json').catch(() => []),
      readFromGitHub('recommendations.json').catch(() => ({ pending: [], rejected: [] })),
    ]);

    const existingUrls = new Set(brands.map(b => rootDomain(b.url)).filter(Boolean));
    const rejectedIds  = new Set(recData.rejected || []);
    const pendingUrls  = new Set((recData.pending || []).map(r => rootDomain(r.url)).filter(Boolean));

    // 2. Sample products from each brand to build style fingerprint
    const samples = await Promise.allSettled(
      brands.map(b => fetchJson(`${b.url.replace(/\/$/, '')}/products.json?limit=20`))
    );

    const tagFreq = {}, catFreq = {};
    let priceSum = 0, priceN = 0;

    samples.forEach(r => {
      if (r.status !== 'fulfilled' || !r.value?.products) return;
      r.value.products.forEach(p => {
        const tags = Array.isArray(p.tags) ? p.tags : (p.tags || '').split(', ');
        tags.forEach(t => {
          const k = t.toLowerCase().trim();
          if (k.length > 2) tagFreq[k] = (tagFreq[k] || 0) + 1;
        });
        if (p.product_type) catFreq[p.product_type] = (catFreq[p.product_type] || 0) + 1;
        const price = parseFloat(p.variants?.[0]?.price || 0);
        if (price > 0) { priceSum += price; priceN++; }
      });
    });

    const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    const topCats = Object.entries(catFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
    const avgPrice = priceN > 0 ? Math.round(priceSum / priceN) : 0;

    // 3. Build search queries based on style fingerprint
    const queries = buildQueries(brands, topTags, topCats);

    // 4. Run all Google searches in parallel
    const searchResults = await Promise.allSettled(queries.map(q => googleSearch(q.query)));

    // 5. Collect unique candidate URLs, skipping known non-brand domains
    const searchErrors = searchResults
      .map((r, i) => r.status === 'rejected'
        ? `Q${i+1} FAILED: ${r.reason?.message}`
        : `Q${i+1}: ${r.value?._raw ?? (r.value?.items||[]).length + ' results'}`)
      .join(' | ');

    const candidates = new Map();
    searchResults.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      (r.value.items || []).forEach(item => {
        const url = rootDomain(item.link);
        if (!url) return;
        try {
          const hostname = new URL(url).hostname.replace(/^www\./, '');
          if (SKIP_DOMAINS.has(hostname)) return;
        } catch { return; }
        if (existingUrls.has(url) || pendingUrls.has(url)) return;
        if (!candidates.has(url)) {
          candidates.set(url, {
            query:   queries[i].query,
            reason:  queries[i].reason,
            title:   item.title,
            snippet: item.snippet || '',
          });
        }
      });
    });

    // 6. Test candidates for Shopify — cap at 20
    const candidateList = [...candidates.entries()].slice(0, 20);
    const shopifyTests  = await Promise.allSettled(candidateList.map(([url]) => testShopify(url)));

    // 7. Build new recommendation objects — include ALL candidates, marked by Shopify status
    const newRecs = [];
    shopifyTests.forEach((r, i) => {
      const [url, meta] = candidateList[i];
      const id = makeId(url);
      if (rejectedIds.has(id)) return;

      const isShopify = r.status === 'fulfilled' && r.value.valid;

      newRecs.push({
        id,
        name:          guessName(meta.title, url),
        url,
        reason:        meta.reason,
        searchQuery:   meta.query,
        isShopify,
        sampleProduct: isShopify ? r.value.sampleProduct : null,
        productCount:  isShopify ? r.value.productCount  : null,
        discoveredAt:  new Date().toISOString(),
      });
    });

    // 8. Merge with existing pending, avoid duplicates
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
      success: true,
      newFound:         newRecs.length,
      totalPending:     merged.length,
      pending:          merged,
      styleFingerprint: { topTags, topCats, avgPrice },
      debug: {
        queriesRun:      queries.length,
        candidatesFound: candidates.size,
        shopifyTested:   candidateList.length,
        shopifyPassed:   newRecs.length,
        searchErrors,
      },
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};

// Domains to skip — marketplaces, social media, publications
const SKIP_DOMAINS = new Set([
  'instagram.com','pinterest.com','facebook.com','twitter.com','youtube.com','linkedin.com',
  'myntra.com','amazon.in','amazon.com','flipkart.com','nykaa.com','ajio.com','meesho.com',
  'indiamart.com','snapdeal.com','tatacliq.com','craftsvilla.com',
  'vogue.in','elle.in','harpersbazaar.in','femina.in','grazia.in',
  'wikipedia.org','reddit.com','quora.com','medium.com','blogspot.com','wordpress.com',
]);

// ── Query builder ─────────────────────────────────────────

function buildQueries(brands, topTags, topCats) {
  const queries = [];

  // Brand similarity
  brands.slice(0, 2).forEach(b => {
    queries.push({
      query:  `india fashion brand similar to ${b.name} clothing online store`,
      reason: `Similar in style to ${b.name}, one of your favourite brands`,
    });
  });

  // Style tag based
  const styleTags = topTags.filter(t => t.length > 3).slice(0, 3);
  if (styleTags.length >= 2) {
    queries.push({
      query:  `${styleTags.slice(0, 2).join(' ')} india clothing brand online store`,
      reason: `Matches your style tags: ${styleTags.slice(0, 2).join(', ')}`,
    });
  }

  // Category based
  topCats.slice(0, 2).forEach(cat => {
    queries.push({
      query:  `${cat} india artisan clothing brand online store`,
      reason: `Matches your favourite category: ${cat}`,
    });
  });

  // Always-on targeted queries
  queries.push({
    query:  'indie indian sustainable handloom fashion brand online store',
    reason: 'Independent Indian sustainable fashion brand matching your aesthetic',
  });
  queries.push({
    query:  'natural dyes hand block print india clothing brand online',
    reason: 'Natural dye or block print Indian clothing brand',
  });
  queries.push({
    query:  'slow fashion india ethnic wear label online store',
    reason: 'Slow fashion Indian ethnic wear label matching your values',
  });

  return queries.slice(0, 8);
}

// ── SerpAPI search ───────────────────────────────────────

function googleSearch(query) {
  return new Promise((resolve, reject) => {
    const qs = `api_key=${encodeURIComponent(SERPAPI_KEY)}&q=${encodeURIComponent(query)}&num=10&engine=google`;
    const req = https.get(
      `https://serpapi.com/search.json?${qs}`,
      { headers: { 'Accept': 'application/json' }, timeout: 10000 },
      (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Normalise to the same shape the rest of the code expects: { items: [...] }
            const items = (parsed.organic_results || []).map(r => ({
              title:   r.title,
              link:    r.link,
              snippet: r.snippet || '',
            }));
            resolve({ items, _raw: parsed.error || parsed.search_metadata?.status || `${items.length} results` });
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
    const testUrl = `${url}/products.json?limit=3`;
    const req = https.get(testUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 8000,
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
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

function guessName(title, url) {
  if (title) {
    const clean = title.replace(/\s*[|–—\-:]\s*.*/,'').trim();
    if (clean.length > 1 && clean.length < 60) return clean;
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    return host.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch { return url; }
}

function fetchJson(urlStr) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 10000,
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
  });
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
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'curated-style-aggregator',
        'Content-Type': 'application/json',
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
