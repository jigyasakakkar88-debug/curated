// Fetch every product from a Shopify brand's public /products.json and map it to a catalog record.
// Unlike api/products.js this paginates until a short page (no 5-page cap) and keeps descriptions.
const https = require('https');
const http  = require('http');
const { classifyDepartment } = require('./departments');

const MAX_PAGES = 40;          // 10,000 products per brand — a safety stop, not a business rule
const PAGE_SIZE = 250;
const SKIP_TYPES = new Set(['gift card', 'gift-card', 'giftcard', 'gift cards']);

function fetchJson(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StyleAggregator/1.0)', 'Accept': 'application/json' },
      timeout: 15000,
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirects < 5) {
        resp.resume();
        return fetchJson(new URL(resp.headers.location, urlStr).href, redirects + 1).then(resolve, reject);
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        const err = new Error(`HTTP ${resp.statusCode}`);
        err.status = resp.statusCode;
        return reject(err);
      }
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// One retry after a pause on 429 / network errors; Shopify rate-limits bursts.
async function fetchPage(url) {
  try {
    return await fetchJson(url);
  } catch (e) {
    if (e.status && e.status !== 429 && e.status < 500) throw e;
    await new Promise(r => setTimeout(r, 2000));
    return fetchJson(url);
  }
}

// Styling text ("Pair with a cotton kurta…") makes a necklace match "cotton kurta" in keyword search,
// but it's useful advice. Split it into its own field: stored and shown to the Stylist, not searched.
const STYLING = /\b(styling guide|styling tips?|style (it|this) with|pair (it |this )?with|complete the look|team (it )?with|wear (it )?with)\b/i;

function truncate(text, max) {
  return text.length > max ? text.slice(0, max).replace(/\s\S*$/, '') + '…' : text;
}

function splitDescription(html) {
  const text = stripHtml(html, 5000);
  const cut  = text.search(STYLING);
  if (cut <= 0) return { description: truncate(text, 600), stylingNotes: '' };
  return {
    description:  truncate(text.slice(0, cut).trim(), 600),
    stylingNotes: truncate(text.slice(cut).trim(), 400),
  };
}

function stripHtml(html, max) {
  const text = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max).replace(/\s\S*$/, '') + '…' : text;
}

function toTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(list.map(t => t.trim()).filter(Boolean))].slice(0, 40);
}

// Sizes come from the option named "size" when there is one; otherwise from variant titles.
function availableSizes(product) {
  const variants = (product.variants || []).filter(v => v.available);
  const sizeIdx = (product.options || []).findIndex(o => /size/i.test(o.name || ''));
  const raw = sizeIdx >= 0
    ? variants.map(v => v[`option${sizeIdx + 1}`])
    : variants.map(v => v.title).filter(t => t && t !== 'Default Title');
  return [...new Set(raw.filter(Boolean).map(s => String(s).trim().toUpperCase()))].slice(0, 20);
}

function toRecord(brand, baseUrl, product) {
  const variant = product.variants && product.variants[0];
  if (!variant) return null;
  const type = (product.product_type || '').trim();
  if (SKIP_TYPES.has(type.toLowerCase())) return null;

  // Same price rule as the feed (first variant), so the Stylist and the feed agree.
  const price        = parseFloat(variant.price || 0);
  const compare      = parseFloat(variant.compare_at_price || 0);
  const comparePrice = compare > price ? compare : null;
  const tags         = toTags(product.tags);
  const { description, stylingNotes } = splitDescription(product.body_html);

  return {
    objectID:       `${brand.id}-${product.id}`,   // same id format as the feed and the wishlist
    brandId:        brand.id,
    brandName:      brand.name,
    name:           product.title,
    productUrl:     `${baseUrl}/products/${product.handle}`,
    image:          product.images && product.images[0] ? product.images[0].src : null,
    price,
    comparePrice,
    discountPct:    comparePrice ? Math.round((comparePrice - price) / comparePrice * 100) : 0,
    productType:    type,
    department:     classifyDepartment({ name: product.title, productType: type, tags }),
    tags,
    description,
    stylingNotes,                                  // retrievable, deliberately not searchable
    sizesAvailable: availableSizes(product),
    inStock:        (product.variants || []).some(v => v.available),
    publishedAt:    product.published_at || null,
  };
}

async function fetchBrandRecords(brand) {
  const baseUrl = brand.url.replace(/\/$/, '');
  const records = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPage(`${baseUrl}/products.json?limit=${PAGE_SIZE}&page=${page}`);
    const products = data.products || [];
    for (const p of products) {
      const r = toRecord(brand, baseUrl, p);
      if (r) records.push(r);
    }
    if (products.length < PAGE_SIZE) break;
  }
  return records;
}

// Run fn over items with at most `limit` in flight.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (e) { out[i] = { status: 'rejected', reason: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = { fetchBrandRecords, toRecord, stripHtml, splitDescription, mapLimit };
