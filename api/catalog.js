// Catalog admin: Shopify → Algolia sync, and frozen copies of the index for evals.
//   POST /api/catalog?action=sync     update the `products` index from every brand (admin)
//   POST /api/catalog?action=freeze   copy `products` → `products_eval_<YYYY-MM-DD>` (admin)
// Free Algolia plan = 50,000 records, so: only in-stock products are indexed, the sync updates in
// place (no temporary second copy), and freezing replaces the previous eval copy.
//   GET  /api/catalog                 index status (admin) — or a sync when called by the Vercel cron
const github = require('../lib/github');
const algolia = require('../lib/algolia');
const { fetchBrandRecords, mapLimit } = require('../lib/shopify');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const BRAND_CONCURRENCY = 6;
// Refuse to replace the index if the new catalog is less than this share of the old one.
const MIN_KEEP_RATIO = 0.5;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth    = req.headers["authorization"];
  const isCron  = Boolean(process.env.CRON_SECRET) && auth === `Bearer ${process.env.CRON_SECRET}`;
  const isAdmin = auth === `Bearer ${ADMIN_PASSWORD}`;
  if (!isCron && !isAdmin) return res.status(401).json({ error: "Unauthorized" });

  if (!algolia.hasCredentials('admin')) {
    return res.status(500).json({ error: "Algolia not configured. Set ALGOLIA_APP_ID and ALGOLIA_ADMIN_KEY in Vercel." });
  }

  const action = req.query.action || (isCron && req.method === "GET" ? "sync" : "status");

  try {
    if (action === "status" && req.method === "GET") return res.status(200).json(await status());
    if (action === "sync" && (req.method === "POST" || isCron)) {
      return res.status(200).json(await sync({ force: req.query.force === "1" }));
    }
    if (action === "freeze" && req.method === "POST") return res.status(200).json(await freeze());
    return res.status(405).json({ error: "Use POST ?action=sync|freeze or GET for status" });
  } catch (e) {
    console.error("catalog error", e);
    return res.status(500).json({ error: e.message });
  }
};

async function sync({ force }) {
  const started = Date.now();
  const client  = algolia.getClient('admin');

  if (!github.isConfigured()) throw new Error("GitHub not configured (GITHUB_TOKEN, GITHUB_REPO).");
  const brands = await github.readJson('brands.json', []);
  if (!brands.length) throw new Error("brands.json is empty — refusing to sync.");
  const policies = await github.readJson('policies.json', null);

  const lap = label => console.log(`catalog sync: ${label} at ${Math.round((Date.now() - started) / 1000)}s`);
  // Read what's already in the index while the stores download.
  const [results, existing] = await Promise.all([
    mapLimit(brands, BRAND_CONCURRENCY, b => fetchBrandRecords(b)),
    algolia.existingRecordBrands(client),
  ]);
  lap(`shopify fetched, ${existing.size} existing records read`);

  const records = [];
  const perBrand = {};
  const failures = [];
  const failedBrandIds = new Set();
  let soldOut = 0;
  for (let i = 0; i < brands.length; i++) {
    const brand = brands[i];
    if (results[i].status !== "fulfilled") {
      // A store that's down shouldn't vanish from search: its existing records are left untouched.
      failedBrandIds.add(brand.id);
      failures.push({ brandId: brand.id, error: results[i].reason?.message });
      perBrand[brand.id] = { name: brand.name, count: null, source: "kept-previous" };
      continue;
    }
    const all  = results[i].value;
    const recs = all.filter(r => r.inStock);
    soldOut += all.length - recs.length;
    const policy = algolia.policyFieldsFor(policies, brand.id);
    const departments = {};
    for (const r of recs) {
      Object.assign(r, policy);
      departments[r.department] = (departments[r.department] || 0) + 1;
    }
    perBrand[brand.id] = { name: brand.name, count: recs.length, soldOut: all.length - recs.length,
                           source: "shopify", departments, hasPolicy: Object.keys(policy).length > 0 };
    records.push(...recs);
  }

  const keptFromFailed = [...existing.values()].filter(b => failedBrandIds.has(b)).length;
  const previous = existing.size;
  const nextTotal = records.length + keptFromFailed;
  if (!force && previous > 0 && nextTotal < previous * MIN_KEEP_RATIO) {
    throw new Error(`New catalog has ${nextTotal} records vs ${previous} in the index — refusing to replace. Re-run with &force=1 if this is expected.`);
  }

  const newIds = new Set(records.map(r => r.objectID));
  const stale  = [...existing.entries()]
    .filter(([id, brandId]) => !newIds.has(id) && !failedBrandIds.has(brandId))
    .map(([id]) => id);

  await algolia.applyIndexConfig(client);
  lap('settings applied');
  // Send every batch, then wait once: Algolia applies an index's tasks in order, so the last one finishing means all have.
  const batches = await client.saveObjects({ indexName: algolia.INDEX, objects: records, batchSize: 1000, waitForTasks: false });
  if (stale.length) {
    batches.push(...await client.deleteObjects({ indexName: algolia.INDEX, objectIDs: stale, batchSize: 1000, waitForTasks: false }));
  }
  if (batches.length) await client.waitForTask({ indexName: algolia.INDEX, taskID: batches[batches.length - 1].taskID });
  lap(`saved ${records.length}, removed ${stale.length}`);
  for (const id of failedBrandIds) {
    perBrand[id].count = [...existing.values()].filter(b => b === id).length;
  }

  const departments = {};
  for (const r of records) departments[r.department] = (departments[r.department] || 0) + 1;

  return {
    indexName: algolia.INDEX,
    total: nextTotal,
    previous,
    removed: stale.length,
    soldOutSkipped: soldOut,
    departments,
    brands: perBrand,
    failures,
    policiesLoaded: Boolean(policies),
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

async function freeze() {
  const client = algolia.getClient('admin');
  const count  = await algolia.countRecords(client);
  if (!count) throw new Error("`products` index is empty — run a sync first.");
  const destination = `${algolia.INDEX}_eval_${new Date().toISOString().slice(0, 10)}`;
  // Keep one eval copy at a time (record limit). Re-run the baseline on each new copy.
  const { items = [] } = await client.listIndices();
  const removed = items.map(i => i.name).filter(n => n.startsWith(`${algolia.INDEX}_eval_`) && n !== destination);
  for (const indexName of removed) await client.deleteIndex({ indexName });
  const op = await client.operationIndex({
    indexName: algolia.INDEX,
    operationIndexParams: { operation: "copy", destination },
  });
  await client.waitForTask({ indexName: algolia.INDEX, taskID: op.taskID });
  return { indexName: destination, records: count, replaced: removed };
}

async function status() {
  const client = algolia.getClient('admin');
  const { items = [] } = await client.listIndices();
  return {
    indices: items
      .filter(i => i.name === algolia.INDEX || i.name.startsWith(`${algolia.INDEX}_eval_`))
      .map(i => ({ name: i.name, records: i.entries, updatedAt: i.updatedAt })),
  };
}
