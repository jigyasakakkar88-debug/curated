// api/admin.js
// Admin panel backend — reads/writes brands.json directly to GitHub repo
// No redeployment needed for reads; writes trigger auto-redeploy via GitHub

const https = require('https');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN   || "";
const GITHUB_REPO    = process.env.GITHUB_REPO    || ""; // e.g. "yourusername/curated"
const BRANDS_FILE    = "brands.json";
const GITHUB_BRANCH  = "main";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Check GitHub is configured
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({
      error: "GitHub not configured. Please set GITHUB_TOKEN and GITHUB_REPO in Vercel environment variables."
    });
  }

  // GET — return current brands
  if (req.method === "GET") {
    try {
      const { brands } = await readBrandsFromGitHub();
      return res.status(200).json({ brands });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST ?action=test — test a Shopify URL
  if (req.method === "POST" && req.query.action === "test") {
    const { url } = req.body;
    const result = await testShopifyStore(url);
    return res.status(200).json(result);
  }

  // POST — add a brand
  if (req.method === "POST") {
    const { url, name } = req.body;
    if (!url || !name) return res.status(400).json({ error: "url and name are required" });

    try {
      const { brands, sha } = await readBrandsFromGitHub();
      const id = url.replace(/https?:\/\//, "").replace(/\//g, "").replace(/\./g, "-").toLowerCase();

      if (brands.find(b => b.url === url.replace(/\/$/, ""))) {
        return res.status(409).json({ error: "Brand already exists" });
      }

      brands.push({ id, name, url: url.replace(/\/$/, "") });
      await writeBrandsToGitHub(brands, sha, `Add brand: ${name}`);

      return res.status(200).json({ success: true, brands, message: `${name} added! Your site will update in ~1 minute.` });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE — remove a brand
  if (req.method === "DELETE") {
    const { id } = req.body;
    try {
      const { brands, sha } = await readBrandsFromGitHub();
      const updated = brands.filter(b => b.id !== id);
      const removed = brands.find(b => b.id === id);
      await writeBrandsToGitHub(updated, sha, `Remove brand: ${removed?.name || id}`);
      return res.status(200).json({ success: true, brands: updated, message: `Brand removed. Site will update in ~1 minute.` });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};

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
          if (resp.statusCode >= 400) {
            reject(new Error(parsed.message || `GitHub API error ${resp.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error('Invalid response from GitHub'));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function readBrandsFromGitHub() {
  try {
    const data = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${BRANDS_FILE}?ref=${GITHUB_BRANCH}`);
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const brands = JSON.parse(content);
    return { brands, sha: data.sha };
  } catch(e) {
    // File doesn't exist yet — return defaults
    if (e.message && e.message.includes('Not Found')) {
      return {
        brands: [
          { id: "gangafashions", name: "Ganga Fashions", url: "https://gangafashions.com" },
          { id: "kharakapas",    name: "Khara Kapas",    url: "https://kharakapas.com"    }
        ],
        sha: null
      };
    }
    throw e;
  }
}

async function writeBrandsToGitHub(brands, sha, commitMessage) {
  const content = Buffer.from(JSON.stringify(brands, null, 2)).toString('base64');
  const body = {
    message: commitMessage,
    content,
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {}), // sha required for updates, omit for new file
  };
  return githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${BRANDS_FILE}`, body);
}

// ── Shopify store tester ──────────────────────────────────

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : require('http');
    const req = lib.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 8000,
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        const redirect = resp.headers.location.startsWith('http')
          ? resp.headers.location
          : new URL(resp.headers.location, urlStr).href;
        return fetchUrl(redirect).then(resolve).catch(reject);
      }
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: resp.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
  });
}

async function testShopifyStore(url) {
  try {
    const baseUrl = url.replace(/\/$/, "");
    const result = await fetchUrl(`${baseUrl}/products.json?limit=3`);
    if (!result.body || !result.body.products) {
      return { valid: false, error: "Not a Shopify store — no products.json found" };
    }
    return {
      valid: true,
      productCount: result.body.products.length,
      sampleProduct: result.body.products[0]?.title || null,
    };
  } catch(e) {
    return { valid: false, error: e.message };
  }
}
