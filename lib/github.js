// Shared GitHub-as-database helpers (Contents API).
// Same behaviour as the copies inside api/*.js, which are left untouched.
// GITHUB_BRANCH lets a preview deployment read/write a branch other than main.
const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

function isConfigured() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path, method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'curated-style-aggregator',
        'Content-Type':  'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { return reject(new Error(`Invalid GitHub response (${resp.statusCode})`)); }
        if (resp.statusCode >= 400) {
          const err = new Error(parsed.message || `GitHub ${resp.statusCode}`);
          err.status = resp.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Read a JSON file → { data, sha }. Returns { data: null, sha: null } if the file doesn't exist.
async function readFileWithSha(filename) {
  try {
    const resp = await githubRequest('GET',
      `/repos/${GITHUB_REPO}/contents/${filename}?ref=${GITHUB_BRANCH}`);
    return { data: JSON.parse(Buffer.from(resp.content, 'base64').toString('utf8')), sha: resp.sha };
  } catch (e) {
    if (e.status === 404) return { data: null, sha: null };
    throw e;
  }
}

async function readJson(filename, fallback = null) {
  const { data } = await readFileWithSha(filename);
  return data ?? fallback;
}

async function getFileSha(filename) {
  return (await readFileWithSha(filename)).sha;
}

// Write a JSON file (one commit). Pass the sha from the read; null creates the file.
async function writeJson(filename, data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  return githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${filename}`, {
    message, content, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}),
  });
}

// Read → modify → write, retrying once if someone else committed in between (409 SHA conflict).
async function updateJson(filename, fallback, mutate, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readFileWithSha(filename);
    const next = await mutate(data ?? fallback);
    try {
      await writeJson(filename, next, sha, message);
      return next;
    } catch (e) {
      if (e.status !== 409 || attempt === 1) throw e;
    }
  }
}

module.exports = {
  GITHUB_BRANCH, isConfigured, githubRequest,
  readFileWithSha, readJson, getFileSha, writeJson, updateJson,
};
