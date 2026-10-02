// Brand policy database (admin).
//   GET  /api/policies                          → policies.json
//   POST /api/policies?action=ingest[&brandId=] → fetch refund/shipping/terms pages (keeps hand-pasted sections)
//   POST /api/policies?action=extract[&brandId=]→ Claude Haiku extracts fields + exact quotes (keeps reviewed edits)
//   POST /api/policies?action=save  { brandId, sections?: {refund|shipping|terms: text}, fields?: {name: {value, quote}}, reviewed? }
// After saving, re-run the catalog sync so returnable/cod/etc. land on product records.
const github   = require('../lib/github');
const policies = require('../lib/policies');
const { mapLimit } = require('../lib/shopify');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const EMPTY = { meta: {}, brands: {} };

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers["authorization"] !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!github.isConfigured()) return res.status(500).json({ error: "GitHub not configured (GITHUB_TOKEN, GITHUB_REPO)." });

  try {
    if (req.method === "GET") {
      return res.status(200).json(await github.readJson(policies.POLICY_FILE, EMPTY));
    }
    const action  = req.query.action;
    const brandId = req.query.brandId || null;
    if (req.method === "POST" && action === "ingest")  return res.status(200).json(await ingest(brandId));
    if (req.method === "POST" && action === "extract") return res.status(200).json(await extract(brandId));
    if (req.method === "POST" && action === "save")    return res.status(200).json(await save(req.body || {}));
    return res.status(405).json({ error: "Use GET, or POST ?action=ingest|extract|save" });
  } catch (e) {
    console.error("policies error", e);
    return res.status(500).json({ error: e.message });
  }
};

async function selectedBrands(brandId) {
  const brands = await github.readJson('brands.json', []);
  const list = brandId ? brands.filter(b => b.id === brandId) : brands;
  if (!list.length) throw new Error(brandId ? `Unknown brand ${brandId}` : "brands.json is empty");
  return list;
}

async function ingest(brandId) {
  const brands  = await selectedBrands(brandId);
  const current = await github.readJson(policies.POLICY_FILE, EMPTY);
  const results = await mapLimit(brands, 6, b => policies.ingestBrand(b, current.brands?.[b.id]));

  const updated = {};
  results.forEach((r, i) => { if (r.status === "fulfilled") updated[brands[i].id] = r.value; });

  const saved = await github.updateJson(policies.POLICY_FILE, EMPTY, data => {
    data.brands = { ...(data.brands || {}) };
    for (const [id, entry] of Object.entries(updated)) {
      // Merge onto the latest copy so a concurrent hand edit isn't lost.
      const latest = data.brands[id] || {};
      const sections = { ...entry.sections };
      for (const [k, s] of Object.entries(latest.sections || {})) if (s.source === 'manual') sections[k] = s;
      data.brands[id] = { ...latest, ...entry, sections, fields: latest.fields || entry.fields || {} };
    }
    data.meta = { ...(data.meta || {}), updatedAt: new Date().toISOString() };
    return data;
  }, brandId ? `Policies: ingest ${brandId}` : "Policies: ingest all brands");

  return { brands: summarise(saved, Object.keys(updated)) };
}

async function extract(brandId) {
  const client  = policies.getAnthropic();
  const current = await github.readJson(policies.POLICY_FILE, EMPTY);
  const ids = brandId ? [brandId] : Object.keys(current.brands || {});
  if (!ids.length) throw new Error("No policy text yet — run ingest first.");

  // Two at a time: a low-tier API key has a small tokens-per-minute allowance.
  const results = await mapLimit(ids, 2, id => policies.extractBrand(client, current.brands[id]));
  const updated = {};
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") { updated[ids[i]] = r.value; return; }
    const error = r.reason?.message || String(r.reason);
    console.error(`policy extract failed for ${ids[i]}: ${error}`);
    errors.push({ brandId: ids[i], error });
    // Keep the brand's existing fields, but record why this run failed so the panel can show it.
    updated[ids[i]] = { ...current.brands[ids[i]], extractError: error };
  });

  let totalTokens = current.meta?.totalTokens ?? null;
  try { totalTokens = await policies.countPolicyTokens(client, current); }
  catch (e) { errors.push({ brandId: null, error: `count_tokens: ${e.message}` }); }

  const saved = await github.updateJson(policies.POLICY_FILE, EMPTY, data => {
    data.brands = { ...(data.brands || {}) };
    for (const [id, entry] of Object.entries(updated)) {
      const latest = data.brands[id] || {};
      const fields = { ...entry.fields };
      for (const [k, f] of Object.entries(latest.fields || {})) if (f.source === 'manual') fields[k] = f;
      const { usage, ...rest } = entry;
      data.brands[id] = { ...latest, ...rest, sections: latest.sections || rest.sections, fields };
    }
    data.meta = { ...(data.meta || {}), updatedAt: new Date().toISOString(), totalTokens,
                  extractModel: policies.EXTRACT_MODEL };
    return data;
  }, brandId ? `Policies: extract ${brandId}` : "Policies: extract all brands");

  return { totalTokens, errors, brands: summarise(saved, Object.keys(updated)) };
}

async function save({ brandId, sections, fields, reviewed }) {
  if (!brandId) throw new Error("brandId is required");
  const saved = await github.updateJson(policies.POLICY_FILE, EMPTY, data => {
    data.brands = { ...(data.brands || {}) };
    const entry = { ...(data.brands[brandId] || {}), sections: { ...(data.brands[brandId]?.sections || {}) },
                    fields: { ...(data.brands[brandId]?.fields || {}) } };
    for (const [key, text] of Object.entries(sections || {})) {
      if (!policies.SECTIONS[key]) continue;
      entry.sections[key] = { ...(entry.sections[key] || {}), text: String(text || '').trim(),
                              status: text && text.trim() ? 'ok' : 'empty', source: 'manual' };
    }
    const allText = policies.sourceText(entry);
    for (const [name, f] of Object.entries(fields || {})) {
      if (!policies.FIELDS[name]) continue;
      const value = f.value === '' || f.value === undefined ? null : f.value;
      entry.fields[name] = { value, quote: f.quote || null, source: 'manual',
                             quoteVerified: value == null ? null : policies.quoteIsInSource(f.quote, allText) };
    }
    if (typeof reviewed === 'boolean') entry.reviewed = reviewed;
    data.brands[brandId] = entry;
    data.meta = { ...(data.meta || {}), updatedAt: new Date().toISOString() };
    return data;
  }, `Policies: edit ${brandId}`);
  return { brand: saved.brands[brandId] };
}

function summarise(data, ids) {
  const out = {};
  for (const id of ids) {
    const e = data.brands[id];
    out[id] = {
      sections: Object.fromEntries(Object.entries(e.sections || {}).map(([k, s]) => [k, s.status])),
      fieldsFound: Object.values(e.fields || {}).filter(f => f.value != null).length,
      unverifiedQuotes: Object.values(e.fields || {}).filter(f => f.quoteVerified === false).length,
      extractError: e.extractError || null,
    };
  }
  return out;
}
