const crypto = require('crypto');
// Algolia client, index settings and synonyms for the Stylist catalog.
const { algoliasearch } = require('algoliasearch');
const synonymsFile = require('../evals/synonyms.json');

const INDEX = 'products';

// Policy fields copied onto every product record (from policies.json, step 1.4).
const POLICY_FIELDS = ['returnable', 'returnWindowDays', 'exchangeOnly', 'cod', 'international'];

const INDEX_SETTINGS = {
  // Name and type say what the product *is*; description is weakest and position-insensitive.
  // stylingNotes ("pair with a kurta…") is stored on each record but intentionally not searchable.
  searchableAttributes: ['name', 'productType', 'tags', 'brandName', 'unordered(description)'],
  attributesForFaceting: [
    'filterOnly(brandId)', 'filterOnly(department)', 'filterOnly(gender)', 'filterOnly(sizesAvailable)',
    'filterOnly(inStock)', 'filterOnly(returnable)', 'filterOnly(exchangeOnly)',
    'filterOnly(cod)', 'filterOnly(international)',
  ],
  numericAttributesForFiltering: ['price', 'discountPct', 'returnWindowDays'],
  typoTolerance: true,
  ignorePlurals: true,
  queryLanguages: ['en', 'hi'],
};

function hasCredentials(kind = 'admin') {
  const key = kind === 'admin' ? process.env.ALGOLIA_ADMIN_KEY : process.env.ALGOLIA_SEARCH_KEY;
  return Boolean(process.env.ALGOLIA_APP_ID && key);
}

// kind: 'admin' for writes (server only), 'search' for read-only queries.
function getClient(kind = 'admin') {
  if (!hasCredentials(kind)) {
    throw new Error(`Algolia not configured: set ALGOLIA_APP_ID and ${kind === 'admin' ? 'ALGOLIA_ADMIN_KEY' : 'ALGOLIA_SEARCH_KEY'}.`);
  }
  const key = kind === 'admin' ? process.env.ALGOLIA_ADMIN_KEY : process.env.ALGOLIA_SEARCH_KEY;
  return algoliasearch(process.env.ALGOLIA_APP_ID, key);
}

function synonymHits() {
  return (synonymsFile.synonyms || []).map((group, i) => ({
    objectID: `syn-${i}-${group[0].replace(/[^a-z0-9]+/gi, '-')}`,
    type: 'synonym',
    synonyms: group,
  }));
}

// Apply settings + synonyms (replacing old synonyms) and wait until both are live.
async function applyIndexConfig(client, indexName = INDEX) {
  const s = await client.setSettings({ indexName, indexSettings: INDEX_SETTINGS });
  await client.waitForTask({ indexName, taskID: s.taskID });
  const y = await client.saveSynonyms({ indexName, synonymHit: synonymHits(), replaceExistingSynonyms: true });
  await client.waitForTask({ indexName, taskID: y.taskID });
}

// policies.json shape: { brands: { [brandId]: { fields: { returnable: { value, quote }, ... } } } }
function policyFieldsFor(policies, brandId) {
  const fields = policies?.brands?.[brandId]?.fields || {};
  const out = {};
  for (const name of POLICY_FIELDS) {
    const v = fields[name]?.value;
    if (v !== null && v !== undefined) out[name] = v;
  }
  return out;
}

async function countRecords(client, indexName = INDEX) {
  if (!(await client.indexExists({ indexName }))) return 0;
  const res = await client.searchSingleIndex({ indexName, searchParams: { query: '', hitsPerPage: 0 } });
  return res.nbHits || 0;
}

// objectID → brandId for every record currently in the index (used to delete stale records).
// Fingerprint of a record's content: keys sorted at every level, Algolia's own fields (_highlightResult…) left out.
// The same function runs on a fresh Shopify record and on the stored copy, so equal content = equal hash.
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (!k.startsWith('_') && v[k] !== undefined) out[k] = stable(v[k]);
    return out;
  }
  return v;
}
function recordHash(r) {
  return crypto.createHash('sha1').update(JSON.stringify(stable(r))).digest('base64');
}

// Every stored record as id → { brandId, hash }. Reads full records (1 browse request per 1,000) but keeps only the
// fingerprint, so the sync can write just the products that are new or changed.
async function existingRecords(client, indexName = INDEX) {
  const recs = new Map();
  if (!(await client.indexExists({ indexName }))) return recs;
  await client.browseObjects({
    indexName,
    browseParams: { hitsPerPage: 1000 },
    aggregator: (res) => { for (const h of res.hits) recs.set(h.objectID, { brandId: h.brandId, hash: recordHash(h) }); },
  });
  return recs;
}

module.exports = {
  INDEX, INDEX_SETTINGS, POLICY_FIELDS, hasCredentials, getClient,
  synonymHits, applyIndexConfig, policyFieldsFor, countRecords, existingRecords, recordHash,
};
