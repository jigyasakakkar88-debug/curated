const https = require('https');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN   || "";
const GITHUB_REPO    = process.env.GITHUB_REPO    || "";
const GITHUB_BRANCH  = "main";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({
      error: "GitHub not configured. Please set GITHUB_TOKEN and GITHUB_REPO in Vercel environment variables."
    });
  }

  const resource = req.query.resource || "brands";

  // ── Settings ──────────────────────────────────────────────

  if (resource === "settings") {
    if (req.method === "GET") {
      try {
        const { data } = await readFileFromGitHub('settings.json');
        return res.status(200).json({ settings: data });
      } catch {
        return res.status(200).json({ settings: { saleThreshold: 10, newDays: 7 } });
      }
    }
    if (req.method === "POST") {
      try {
        const newSettings = req.body;
        if (typeof newSettings.saleThreshold !== 'number' || typeof newSettings.newDays !== 'number') {
          return res.status(400).json({ error: "saleThreshold and newDays must be numbers" });
        }
        let sha = null;
        try { ({ sha } = await readFileFromGitHub('settings.json')); } catch {}
        await writeFileToGitHub('settings.json', newSettings, sha, 'Update settings');
        return res.status(200).json({ success: true, settings: newSettings });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }

  // ── Brands ────────────────────────────────────────────────

  if (req.method === "GET") {
    try {
      const { data: brands } = await readFileFromGitHub('brands.json');
      return res.status(200).json({ brands });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST" && req.query.action === "test") {
    const { url } = req.body;
    const result = await testShopifyStore(url);
    return res.status(200).json(result);
  }

  if (req.method === "POST") {
    const { url, name } = req.body;
    if (!url || !name) return res.status(400).json({ error: "url and name are required" });

    try {
      const { data: brands, sha } = await readFileFromGitHub('brands.json');
      const id = url.replace(/https?:\/\//, "").replace(/\//g, "").replace(/\./g, "-").toLowerCase();

      if (brands.find(b => b.url === url.replace(/\/$/, ""))) {
        return res.status(409).json({ error: "Brand already exists" });
      }

      brands.push({ id, name, url: url.replace(/\/$/, ""), addedAt: new Date().toISOString() });
      await writeFileToGitHub('brands.json', brands, sha, `Add brand: ${name}`);

      return res.status(200).json({ success: true, brands, message: `${name} added! Your site will update in ~1 minute.` });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body;
    try {
      const { data: brands, sha } = await readFileFromGitHub('brands.json');
      const updated = brands.filter(b => b.id !== id);
      const removed = brands.find(b => b.id === id);
      await writeFileToGitHub('brands.json', updated, sha, `Remove brand: ${removed?.name || id}`);
      return res.status(200).json({ success: true, brands: updated, message: `Brand removed. Site will update in ~1 minute.` });
    } catch (e) {
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
          if (resp.statusCode >= 400) reject(new Error(parsed.message || `GitHub API error ${resp.statusCode}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error('Invalid response from GitHub'));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function readFileFromGitHub(filename) {
  const resp = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${filename}?ref=${GITHUB_BRANCH}`);
  const content = Buffer.from(resp.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: resp.sha };
}

async function writeFileToGitHub(filename, data, sha, commitMessage) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = {
    message: commitMessage,
    content,
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  };
  return githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${filename}`, body);
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
    const result  = await fetchUrl(`${baseUrl}/products.json?limit=3`);
    if (!result.body || !result.body.products) {
      return { valid: false, error: "Not a Shopify store — no products.json found" };
    }
    return {
      valid: true,
      productCount: result.body.products.length,
      sampleProduct: result.body.products[0]?.title || null,
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
