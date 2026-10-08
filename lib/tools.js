// The Stylist's tools: Anthropic tool definitions + implementations over Algolia and policies.json.
// The index name is passed in so evals can run against a frozen copy. Every call is recorded on the trace.
const algolia = require('./algolia');
const github  = require('./github');
const { POLICY_FILE, FIELDS } = require('./policies');
const { DEPARTMENTS } = require('./departments');

const INDEX_PATTERN = /^products(_eval_\d{4}-\d{2}-\d{2})?$/;
const MIN_RESULTS = 3;

const SEARCH_PROPERTIES = {
  query:           { type: 'string', description: 'Search words. Can be empty to browse by filters only.' },
  maxPrice:        { type: 'number', description: 'Maximum price in INR.' },
  minPrice:        { type: 'number', description: 'Minimum price in INR.' },
  size:            { type: 'string', description: 'Size that must be in stock, e.g. "M", "XL", "32", "FREE SIZE".' },
  brandIds:        { type: 'array', items: { type: 'string' }, description: 'Only these brands.' },
  excludeBrandIds: { type: 'array', items: { type: 'string' }, description: 'Never these brands.' },
  minDiscount:     { type: 'number', description: 'Minimum discount percent, e.g. 20.' },
  returnableOnly:  { type: 'boolean', description: 'Only brands whose policy accepts returns.' },
  gender:          { type: 'string', enum: ['women', 'men', 'kids'],
                     description: 'Who it is for. women/men exclude the other gender and kids; products with no gender label stay in.' },
  departments:     { type: 'array', items: { type: 'string', enum: DEPARTMENTS },
                     description: 'Default ["clothing"]. Add "accessories" for bags/jewellery/footwear, "fabric" for dress materials/unstitched, "home" for home goods.' },
};
const SEARCH_FIELDS = Object.keys(SEARCH_PROPERTIES);
// Keep only known search fields (the model's `browse` and the public See-all endpoint both pass through here).
function cleanSearch(input = {}) {
  const out = {};
  for (const k of SEARCH_FIELDS) if (input[k] !== undefined && input[k] !== null && input[k] !== '') out[k] = input[k];
  if (typeof out.query !== 'string') out.query = '';
  return out;
}

const DEFINITIONS = [
  {
    name: 'search_products',
    description: 'Keyword search over in-stock products from the brands on Curated. Filters are exact. ' +
      'Use clean product vocabulary in `query` (e.g. "cotton kurta", "chanderi saree"), not the whole user sentence. ' +
      'If fewer than 3 products match, ONE filter is relaxed automatically (size, then minDiscount, then maxPrice +20%) ' +
      'and `relaxed` says what changed — tell the user. Results are spread across brands (at most 2 per brand first) unless you ' +
      'filter to one brand. `totalHits` is how many products match in total — use it to tell the user how big the choice is. Returns compact records.',
    input_schema: {
      type: 'object',
      properties: {
        ...SEARCH_PROPERTIES,
        limit:           { type: 'integer', description: 'Max results, default 10, at most 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Full record for one product id: description, all tags, sizes, policy fields and the brand\'s styling notes ' +
      '(brand marketing copy — attribute it as "the brand suggests"). Use for questions about a specific piece.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'get_policies',
    description: 'Return/exchange/shipping/COD policies per brand: structured fields, each with the exact policy sentence, ' +
      'plus the refund and shipping policy text. Quote the policy line when answering. Omit brandIds for all brands.',
    input_schema: { type: 'object', properties: { brandIds: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'get_wishlist',
    description: 'The products the user has saved (hearted) on Curated, as compact records. Saved items that are no longer in stock are listed as unavailable.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'respond',
    description: 'Finish the turn. The ONLY way to answer the user. `text` is the reply; `product_ids` are products to show as cards ' +
      '(only ids returned by tools in this conversation); `product_reasons` gives one short reason per shown product; ' +
      '`browse` is the main search behind your picks so the user can see every match; `caveats` lists anything relaxed, ' +
      'missing or uncertain; `policy_quotes` are exact policy lines supporting a policy answer.',
    input_schema: {
      type: 'object',
      properties: {
        text:          { type: 'string' },
        product_ids:   { type: 'array', items: { type: 'string' } },
        product_reasons: { type: 'array', description: 'One entry per product in product_ids, in the same order.',
                           items: { type: 'object', properties: {
                             id:  { type: 'string' },
                             why: { type: 'string', description: 'Under 15 words: why this piece fits the ask (fabric, cut, occasion, price).' } },
                           required: ['id', 'why'] } },
        browse:        { type: 'object', description: 'The search_products input (query + filters) that produced most of your picks, ' +
                           'copied as-is, so the user can see all matches. Omit when asking a question, declining, or answering policy only.',
                         properties: SEARCH_PROPERTIES },
        caveats:       { type: 'array', items: { type: 'string' } },
        policy_quotes: { type: 'array', items: { type: 'object',
                         properties: { brandId: { type: 'string' }, quote: { type: 'string' } }, required: ['brandId', 'quote'] } },
      },
      required: ['text', 'product_ids'],
    },
  },
];

// ── Filters ────────────────────────────────────────────────

const SIZE_WORDS = { 'extra small': 'XS', 'small': 'S', 'medium': 'M', 'large': 'L', 'extra large': 'XL', 'free': 'FREE SIZE', 'freesize': 'FREE SIZE' };
const normSize = s => { const k = String(s).trim().toLowerCase(); return SIZE_WORDS[k] || String(s).trim().toUpperCase(); };
const quote = v => `"${String(v).replace(/"/g, '\\"')}"`;

function buildFilters(p) {
  const parts = ['inStock:true'];
  const depts = (p.departments && p.departments.length ? p.departments : ['clothing']).filter(d => DEPARTMENTS.includes(d));
  if (depts.length) parts.push(`(${depts.map(d => `department:${quote(d)}`).join(' OR ')})`);
  if (p.maxPrice != null) parts.push(`price <= ${Number(p.maxPrice)}`);
  if (p.minPrice != null) parts.push(`price >= ${Number(p.minPrice)}`);
  if (p.minDiscount != null) parts.push(`discountPct >= ${Number(p.minDiscount)}`);
  if (p.size) parts.push(`sizesAvailable:${quote(normSize(p.size))}`);
  if (p.brandIds && p.brandIds.length) parts.push(`(${p.brandIds.map(b => `brandId:${quote(b)}`).join(' OR ')})`);
  for (const b of p.excludeBrandIds || []) parts.push(`NOT brandId:${quote(b)}`);
  if (p.returnableOnly) parts.push('returnable:true');
  // Exclude the other gender rather than require a label: many products carry none.
  if (p.gender === 'women') parts.push('NOT gender:"men"', 'NOT gender:"kids"');
  if (p.gender === 'men') parts.push('NOT gender:"women"', 'NOT gender:"kids"');
  if (p.gender === 'kids') parts.push('gender:"kids"');
  return parts.join(' AND ');
}

// Relax ONE filter, in this order. Never returnableOnly or brand exclusions.
function relaxOnce(p) {
  if (p.size) return [{ ...p, size: undefined }, `size ${normSize(p.size)} dropped`];
  if (p.minDiscount != null) return [{ ...p, minDiscount: undefined }, `minDiscount ${p.minDiscount}% dropped`];
  if (p.maxPrice != null) {
    const raised = Math.round(p.maxPrice * 1.2);
    return [{ ...p, maxPrice: raised }, `maxPrice ${p.maxPrice}→${raised}`];
  }
  return [null, null];
}

function compact(r) {
  return {
    id: r.objectID, name: r.name, brandId: r.brandId, brandName: r.brandName, price: r.price,
    discountPct: r.discountPct || 0, sizesAvailable: r.sizesAvailable || [], productType: r.productType,
    department: r.department, gender: r.gender, tags: (r.tags || []).slice(0, 6),
    description: (r.description || '').slice(0, 200),
    ...(r.returnable != null ? { returnable: r.returnable } : {}),
  };
}

// Spread results across brands: take hits in relevance order but at most `perBrand` per brand first,
// then fill any remaining slots in order. Keeps one big brand from filling the whole shortlist.
function diversify(hits, limit, perBrand = 2) {
  const out = [], extra = [], n = {};
  for (const h of hits) {
    if ((n[h.brandId] || 0) < perBrand) { out.push(h); n[h.brandId] = (n[h.brandId] || 0) + 1; }
    else extra.push(h);
    if (out.length >= limit) break;
  }
  for (const h of extra) { if (out.length >= limit) break; out.push(h); }
  return out;
}

// "See all matches": the same search, plain relevance order, paged. No LLM involved.
const BROWSE_PAGE = 24;
async function browseProducts(client, index, input, page = 0) {
  if (!INDEX_PATTERN.test(index)) throw new Error(`Invalid index name: ${index}`);
  const p = cleanSearch(input);
  const res = await client.searchSingleIndex({ indexName: index,
    searchParams: { query: p.query, filters: buildFilters(p), hitsPerPage: BROWSE_PAGE, page: Math.max(0, Math.min(Number(page) || 0, 20)) } });
  return { hits: res.hits, total: res.nbHits, page: res.page, hasMore: res.page + 1 < res.nbPages };
}

// ── Toolbox ────────────────────────────────────────────────

function createToolbox({ index = algolia.INDEX, wishlistIds = [], anchorId = null, trace, client } = {}) {
  if (!INDEX_PATTERN.test(index)) throw new Error(`Invalid index name: ${index}`);
  const search = client || algolia.getClient('search');
  let policiesCache = null;
  const loadPolicies = async () => (policiesCache ??= await github.readJson(POLICY_FILE, { brands: {} }));

  async function searchProducts(input) {
    const p = { ...input, limit: Math.min(Math.max(Number(input.limit) || 10, 1), 20) };
    const spread = !(p.brandIds && p.brandIds.length === 1);
    const run = async params => search.searchSingleIndex({
      indexName: index,
      searchParams: { query: params.query || '', filters: buildFilters(params),
                      hitsPerPage: spread ? Math.min(params.limit * 3, 60) : params.limit },
    });
    let res = await run(p);
    let relaxed = null;
    if (res.nbHits < MIN_RESULTS) {
      const [looser, note] = relaxOnce(p);
      if (looser) {
        const res2 = await run(looser);
        if (res2.nbHits > res.nbHits) { res = res2; relaxed = note; }
        else relaxed = `${note} (still ${res2.nbHits} — kept original)`;
      }
    }
    const hits = spread ? diversify(res.hits, p.limit) : res.hits.slice(0, p.limit);
    const results = hits.map(compact);
    trace?.seen(results.map(r => r.id));
    return { result: { results, relaxed, totalHits: res.nbHits }, resultCount: results.length, relaxed, totalHits: res.nbHits };
  }

  async function getProduct({ id }) {
    const { results } = await search.getObjects({ requests: [{ indexName: index, objectID: id }] });
    const r = results[0];
    if (!r) return { result: { error: `Product ${id} not found — it may be sold out or removed.` }, resultCount: 0 };
    trace?.seen([r.objectID]);
    const { _highlightResult, ...rest } = r;
    return { result: { ...rest, id: r.objectID }, resultCount: 1 };
  }

  async function getPolicies({ brandIds } = {}) {
    const data = await loadPolicies();
    const ids = brandIds && brandIds.length ? brandIds : Object.keys(data.brands || {});
    const out = {};
    for (const id of ids) {
      const e = data.brands?.[id];
      if (!e) { out[id] = { error: 'No policy on file for this brand.' }; continue; }
      const fields = {};
      for (const name of Object.keys(FIELDS)) {
        const f = e.fields?.[name];
        if (f && f.value != null) fields[name] = { value: f.value, quote: f.quote, verified: f.quoteVerified !== false };
      }
      out[id] = {
        brandName: e.name, reviewed: Boolean(e.reviewed), fields,
        refundText:   (e.sections?.refund?.text || '').slice(0, 3000) || null,
        shippingText: (e.sections?.shipping?.text || '').slice(0, 3000) || null,
      };
    }
    return { result: out, resultCount: Object.keys(out).length };
  }

  async function getWishlist() {
    if (!wishlistIds.length) return { result: { items: [], note: 'The user has no saved items.' }, resultCount: 0 };
    const { results } = await search.getObjects({ requests: wishlistIds.map(id => ({ indexName: index, objectID: id })) });
    const items = results.map((r, i) => r ? compact(r) : { id: wishlistIds[i], unavailable: true });
    trace?.seen(items.filter(i => !i.unavailable).map(i => i.id));
    return { result: { items }, resultCount: items.filter(i => !i.unavailable).length };
  }

  const impl = {
    search_products: searchProducts,
    get_product: getProduct,
    get_policies: getPolicies,
    get_wishlist: getWishlist,
    respond: async input => ({ result: { ok: true }, resultCount: (input.product_ids || []).length }),
  };

  // Run a tool by name; always records a trace step, never throws (errors go back to the model).
  async function run(name, input = {}) {
    const t = Date.now();
    if (!impl[name]) {
      trace?.step(name, input, { ms: 0, error: 'unknown tool' });
      return { error: `Unknown tool ${name}` };
    }
    try {
      const { result, resultCount, relaxed, totalHits } = await impl[name](input);
      trace?.step(name, input, { resultCount, relaxed: relaxed || null, totalHits, ms: Date.now() - t });
      return result;
    } catch (e) {
      trace?.step(name, input, { ms: Date.now() - t, error: e.message });
      return { error: e.message };
    }
  }

  return { definitions: DEFINITIONS, run, index, anchorId };
}

module.exports = { DEFINITIONS, createToolbox, buildFilters, relaxOnce, compact, diversify, cleanSearch, browseProducts, BROWSE_PAGE, INDEX_PATTERN };
