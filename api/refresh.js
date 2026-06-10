const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = "main";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const isVercelCron = req.headers["authorization"] === `Bearer ${process.env.CRON_SECRET}`;
  const isAdmin      = req.headers["authorization"] === `Bearer ${process.env.ADMIN_PASSWORD || "changeme123"}`;

  if (!isVercelCron && !isAdmin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const brands = (GITHUB_TOKEN && GITHUB_REPO)
      ? await readBrandsFromGitHub()
      : [];

    if (!brands.length) {
      return res.status(200).json({
        success: true,
        refreshedAt: new Date().toISOString(),
        message: "No brands configured — set GITHUB_TOKEN and GITHUB_REPO in Vercel env vars.",
      });
    }

    const results = await Promise.allSettled(brands.map(b => countProducts(b)));

    let totalProducts = 0;
    const brandResults = results.map((r, i) => {
      if (r.status === "fulfilled") {
        totalProducts += r.value;
        return { brand: brands[i].name, count: r.value, ok: true };
      }
      return { brand: brands[i].name, error: r.reason?.message, ok: false };
    });

    return res.status(200).json({
      success: true,
      refreshedAt: new Date().toISOString(),
      totalProducts,
      brands: brandResults,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};

// ── Helpers ───────────────────────────────────────────────

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 12000,
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        const redirect = resp.headers.location.startsWith('http')
          ? resp.headers.location
          : new URL(resp.headers.location, urlStr).href;
        return fetchUrl(redirect).then(resolve).catch(reject);
      }
      if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`));
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

async function countProducts(brand) {
  const baseUrl = brand.url.replace(/\/$/, "");
  let total = 0;
  let page = 1;
  while (true) {
    const data = await fetchUrl(`${baseUrl}/products.json?limit=250&page=${page}`);
    if (!data.products || !data.products.length) break;
    total += data.products.length;
    if (data.products.length < 250) break;
    page++;
    if (page > 5) break;
  }
  return total;
}

function readBrandsFromGitHub() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/brands.json?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'curated-style-aggregator',
      },
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode >= 400) return resolve([]);
          resolve(JSON.parse(Buffer.from(parsed.content, 'base64').toString('utf8')));
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}
