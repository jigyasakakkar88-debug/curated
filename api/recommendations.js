const https = require('https');

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN   || "";
const GITHUB_REPO    = process.env.GITHUB_REPO    || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const GITHUB_BRANCH  = "main";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.headers["authorization"] !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // GET — return pending recommendations
  if (req.method === "GET") {
    try {
      const data = await readFromGitHub('recommendations.json').catch(() => ({ pending: [], rejected: [] }));
      return res.status(200).json({ pending: data.pending || [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — accept or reject a recommendation
  if (req.method === "POST") {
    const { id, action } = req.body || {};
    if (!id || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: "id and action ('accept' or 'reject') are required" });
    }

    try {
      const [recFile, brandsFile] = await Promise.all([
        readFileWithSha('recommendations.json'),
        readFileWithSha('brands.json'),
      ]);

      const recData = recFile.data;
      const rec     = (recData.pending || []).find(r => r.id === id);

      if (!rec) return res.status(404).json({ error: "Recommendation not found" });

      // Remove from pending
      recData.pending = (recData.pending || []).filter(r => r.id !== id);

      if (action === 'reject') {
        recData.rejected = [...new Set([...(recData.rejected || []), id])];
        await writeToGitHub('recommendations.json', recData, recFile.sha, `Dismiss recommendation: ${rec.name}`);
        return res.status(200).json({ success: true, pending: recData.pending });
      }

      if (action === 'accept') {
        if (!rec.isShopify) {
          return res.status(400).json({ error: "Only Shopify brands can be added directly. Visit the site manually to confirm it supports Shopify." });
        }
        const brands = brandsFile.data;
        // Avoid duplicate
        if (!brands.find(b => b.url === rec.url)) {
          brands.push({
            id:            rec.id,
            name:          rec.name,
            url:           rec.url,
            discoveredAt:  rec.discoveredAt  || null,
            acceptedAt:    new Date().toISOString(),
            runNumber:     rec.runNumber     || null,
            searchAxis:    rec.searchAxis    || null,
          });
        }
        // Write both files (sequential — each needs the other's SHA to be stable)
        await writeToGitHub('brands.json', brands, brandsFile.sha, `Add brand: ${rec.name}`);
        // Re-fetch recommendations SHA after the brands commit (GitHub SHA changes per commit)
        const freshRecSha = await getFileSha('recommendations.json');
        await writeToGitHub('recommendations.json', recData, freshRecSha, `Accept recommendation: ${rec.name}`);

        return res.status(200).json({ success: true, pending: recData.pending, brands });
      }

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

async function readFileWithSha(filename) {
  const resp = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${filename}?ref=${GITHUB_BRANCH}`);
  return { data: JSON.parse(Buffer.from(resp.content, 'base64').toString('utf8')), sha: resp.sha };
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
