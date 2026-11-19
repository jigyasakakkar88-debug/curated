// Admin: call the Stylist's search_products tool directly, for manual testing.
//   GET /api/search?query=cotton kurta&maxPrice=3000&size=M&brandIds=a,b&excludeBrandIds=c
//                  &minDiscount=20&returnableOnly=1&departments=clothing,fabric&limit=10&index=products
// Returns the tool result plus its trace; also prints a TRACE line to the Vercel logs.
const { createToolbox } = require('../lib/tools');
const { startTrace } = require('../lib/trace');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : undefined);
const num  = v => (v === undefined || v === '' ? undefined : Number(v));

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers["authorization"] !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const q = req.query || {};
  const input = {
    query:           q.query || '',
    maxPrice:        num(q.maxPrice),
    minPrice:        num(q.minPrice),
    size:            q.size || undefined,
    brandIds:        list(q.brandIds),
    excludeBrandIds: list(q.excludeBrandIds),
    minDiscount:     num(q.minDiscount),
    returnableOnly:  q.returnableOnly === '1' || q.returnableOnly === 'true' || undefined,
    departments:     list(q.departments),
    limit:           num(q.limit),
  };
  for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];

  try {
    const index = q.index || 'products';
    const trace = startTrace({ source: 'live', system: 'search-test', query: input.query, index });
    const toolbox = createToolbox({ index, trace });
    const result = await toolbox.run('search_products', input);
    return res.status(result.error ? 500 : 200).json({ input, ...result, trace: trace.finish(null) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
