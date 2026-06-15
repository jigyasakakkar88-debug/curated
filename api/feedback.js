const https  = require('https');
const crypto = require('crypto');

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

  // GET — return all feedback indexed by storefrontId
  if (req.method === "GET") {
    try {
      const feedbackData = await readFromGitHub('user_feedback.json').catch(() => ({ entries: [] }));
      const byId = {};
      for (const entry of (feedbackData.entries || [])) {
        if (entry.storefrontId) byId[entry.storefrontId] = entry;
      }
      return res.status(200).json({ feedback: byId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    storefrontId, storefrontName, storefrontUrl,
    rating, comment,
    searchAxis, runNumber, discoveryScore,
  } = req.body || {};

  if (!storefrontId || !rating) {
    return res.status(400).json({ error: "storefrontId and rating are required" });
  }
  if (!['thumbs_up', 'neutral', 'not_relevant'].includes(rating)) {
    return res.status(400).json({ error: "Invalid rating value" });
  }

  try {
    let feedbackData = { entries: [] };
    let sha = null;
    try {
      const resp = await githubRequest('GET',
        `/repos/${GITHUB_REPO}/contents/user_feedback.json?ref=${GITHUB_BRANCH}`);
      feedbackData = JSON.parse(Buffer.from(resp.content, 'base64').toString('utf8'));
      sha = resp.sha;
    } catch {}

    const now = new Date().toISOString();
    const existingIdx = (feedbackData.entries || []).findIndex(e => e.storefrontId === storefrontId);

    if (existingIdx >= 0) {
      // Upsert — update existing entry, preserve original discovery metadata
      feedbackData.entries[existingIdx] = {
        ...feedbackData.entries[existingIdx],
        rating,
        comment:   comment?.trim() || null,
        updatedAt: now,
      };
    } else {
      // New entry
      feedbackData.entries.push({
        id:             crypto.randomUUID(),
        timestamp:      now,
        storefrontId,
        storefrontName,
        storefrontUrl:  storefrontUrl || null,
        rating,
        comment:        comment?.trim() || null,
        searchAxis:     searchAxis || null,
        runNumber:      runNumber  || null,
        discoveryScore: discoveryScore || null,
      });
    }

    const content = Buffer.from(JSON.stringify(feedbackData, null, 2)).toString('base64');
    await githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/user_feedback.json`, {
      message: `Feedback: ${rating} for ${storefrontName}`,
      content,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};

function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path, method,
      headers: {
        'Authorization':  `token ${GITHUB_TOKEN}`,
        'Accept':         'application/vnd.github.v3+json',
        'User-Agent':     'curated-style-aggregator',
        'Content-Type':   'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (resp) => {
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
