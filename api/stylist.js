// The Stylist assistant (public).
//   POST /api/stylist  { messages: [{role, content}], wishlistIds?, anchorId? }
//        → { answer, products, caveats, policy_quotes, traceId }
//   POST /api/stylist?feedback=1  { traceId, rating: "up" | "down", note? }  → logged as a FEEDBACK line
// Admin callers (Bearer ADMIN_PASSWORD) skip the daily limit and may pass `index` (frozen eval copies).
const github = require('../lib/github');
const algolia = require('../lib/algolia');
const { runAgent, getModel } = require('../lib/agent');
const { startTrace } = require('../lib/trace');
const { INDEX_PATTERN } = require('../lib/tools');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const DAILY_LIMIT    = Number(process.env.STYLIST_DAILY_LIMIT) || 30;
const MAX_INPUT      = 500;
const NEW_DAYS       = 7;

// Per-IP daily counter. In-memory: resets when the function instance is recycled (fine for now).
const usage = new Map();
function overLimit(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}|${ip}`;
  const n = (usage.get(key) || 0) + 1;
  usage.set(key, n);
  if (usage.size > 5000) for (const k of usage.keys()) if (!k.startsWith(day)) usage.delete(k);
  return n > DAILY_LIMIT;
}

let brandsCache = { at: 0, list: [] };
async function loadBrands() {
  if (Date.now() - brandsCache.at < 10 * 60 * 1000 && brandsCache.list.length) return brandsCache.list;
  const list = await github.readJson('brands.json', []);
  brandsCache = { at: Date.now(), list };
  return list;
}

// Algolia record → the same shape the feed's card() and product modal use.
function toCard(r) {
  const published = r.publishedAt ? new Date(r.publishedAt).getTime() : 0;
  return {
    id: r.objectID, brandId: r.brandId, brandName: r.brandName, name: r.name,
    productUrl: r.productUrl, brandUrl: (r.productUrl || '').split('/products/')[0],
    image: r.image, price: r.price, comparePrice: r.comparePrice || null, discountPct: r.discountPct || 0,
    isSale: (r.discountPct || 0) >= 10, isNew: published > Date.now() - NEW_DAYS * 864e5,
    category: r.productType || 'Clothing', tags: (r.tags || []).slice(0, 5),
    availableSizes: r.sizesAvailable || [], publishedAt: r.publishedAt,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (req.query.feedback === '1') return feedback(req, res);

  const isAdmin = req.headers["authorization"] === `Bearer ${ADMIN_PASSWORD}`;
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!isAdmin && overLimit(ip)) {
    return res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} questions reached — please come back tomorrow.` });
  }

  const body = req.body || {};
  const history = Array.isArray(body.messages) ? body.messages : [];
  const last = history[history.length - 1];
  if (!last || last.role !== 'user' || typeof last.content !== 'string' || !last.content.trim()) {
    return res.status(400).json({ error: "messages must end with a user message" });
  }
  if (last.content.length > MAX_INPUT) {
    return res.status(400).json({ error: `Please keep questions under ${MAX_INPUT} characters.` });
  }
  const wishlistIds = (Array.isArray(body.wishlistIds) ? body.wishlistIds : []).map(String).filter(Boolean).slice(0, 50);
  const anchorId = body.anchorId ? String(body.anchorId).slice(0, 100) : null;
  const index = isAdmin && body.index && INDEX_PATTERN.test(body.index) ? body.index : algolia.INDEX;

  const model = getModel();
  const trace = startTrace({ source: body.source === 'eval' && isAdmin ? 'eval' : 'live', system: 'C',
                             query: last.content, model, index,
                             runId: isAdmin ? body.runId || null : null, queryId: isAdmin ? body.queryId || null : null });
  let brands = [];
  try {
    brands = await loadBrands();
    const { answer, finishedBy } = await runAgent({ history, wishlistIds, anchorId, index, brands, trace, model });

    // Guardrail: only show products a tool actually returned in this turn.
    const t = trace.finish(answer);
    const invalid = new Set(t.invalidIds);
    const ids = [...new Set(answer.product_ids)].filter(id => !invalid.has(id)).slice(0, 8);

    let products = [];
    if (ids.length) {
      const { results } = await algolia.getClient('search').getObjects({
        requests: ids.map(id => ({ indexName: index, objectID: id })),
      });
      products = results.filter(Boolean).map(toCard);
    }

    const brandNames = Object.fromEntries(brands.map(b => [b.id, b.name]));
    const policy_quotes = answer.policy_quotes.map(q => ({ ...q, brandName: brandNames[q.brandId] || q.brandId }));

    return res.status(200).json({
      answer: answer.text, products, caveats: answer.caveats, policy_quotes,
      traceId: t.traceId, finishedBy,
      ...(isAdmin ? { trace: t } : {}),
    });
  } catch (e) {
    console.error("stylist error", e);
    trace.data.error = e.message;
    trace.finish(null);
    return res.status(503).json({ error: "The stylist couldn't answer just now — please try again.", detail: isAdmin ? e.message : undefined });
  }
};

function feedback(req, res) {
  const { traceId, rating, note } = req.body || {};
  if (!traceId || !['up', 'down'].includes(rating)) {
    return res.status(400).json({ error: "traceId and rating ('up' or 'down') are required" });
  }
  console.log('FEEDBACK ' + JSON.stringify({
    traceId: String(traceId).slice(0, 64), rating,
    note: note ? String(note).slice(0, 500) : null, ts: new Date().toISOString(),
  }));
  return res.status(200).json({ ok: true });
}
