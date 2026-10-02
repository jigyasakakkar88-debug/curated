// Algolia client, index settings and synonyms for the Stylist catalog.
const { algoliasearch } = require('algoliasearch');
const synonymsFile = require('../evals/synonyms.json');

const INDEX = 'products';

// Policy fields copied onto every product record (from policies.json, step 1.4).
const POLICY_FIELDS = ['returnable', 'returnWindowDays', 'exchangeOnly', 'cod', 'international'];

const INDEX_SETTINGS = {
  searchableAttributes: ['name', 'tags', 'productType', 'description', 'brandName'],
  attributesForFaceting: [
    'filterOnly(brandId)', 'filterOnly(department)', 'filterOnly(sizesAvailable)',
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

async function recordsForBrand(client, brandId, indexName = INDEX) {
  const hits = [];
  if (!(await client.indexExists({ indexName }))) return hits;
  await client.browseObjects({
    indexName,
    browseParams: { filters: `brandId:"${brandId}"`, hitsPerPage: 1000 },
    aggregator: (res) => hits.push(...res.hits),
  });
  return hits.map(({ _highlightResult, ...rest }) => rest);
}

module.exports = {
  INDEX, INDEX_SETTINGS, POLICY_FIELDS, hasCredentials, getClient,
  synonymHits, applyIndexConfig, policyFieldsFor, countRecords, recordsForBrand,
};
