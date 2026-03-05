// api/products.js
// Reads brands list from GitHub repo (brands.json), falls back to defaults
const https = require('https');
const http  = require('http');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO   = process.env.GITHUB_REPO  || "";
const GITHUB_BRANCH = "main";
const BRANDS_FILE   = "brands.json";
const SALE_THRESHOLD = 10;

const DEFAULT_BRANDS = [
  { id: "gangafashions", name: "Ganga Fashions", url: "https://gangafashions.com" },
  { id: "kharakapas",    name: "Khara Kapas",    url: "https://kharakapas.com"    }
];

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Load brands from GitHub, fall back to defaults
  let brands = DEFAULT_BRANDS;
  try {
    if (GITHUB_TOKEN && GITHUB_REPO) {
      brands = await readBrandsFromGitHub();
    } else if (process.env.BRANDS_JSON) {
      const parsed = JSON.parse(process.env.BRANDS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) brands = parsed;
    }
  } catch(e) {
    console.error('Could not load brands from GitHub, using defaults:', e.message);
  }

  const results = await Promise.allSettled(brands.map(brand => fetchBrand(brand)));

  const allProducts = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") allProducts.push(...result.value);
    else errors.push({ brand: brands[i].name, error: result.reason?.message });
  });

  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  const enriched = allProducts.map(p => ({
    ...p,
    isNew: p.publishedAt ? (now - new Date(p.publishedAt).getTime()) < SEVEN_DAYS : false,
    isSale: p.comparePrice && p.comparePrice > p.price
      ? ((p.comparePrice - p.price) / p.comparePrice * 100) >= SALE_THRESHOLD
      : false,
    discountPct: p.comparePrice && p.comparePrice > p.price
      ? Math.round((p.comparePrice - p.price) / p.comparePrice * 100)
      : 0,
  }));

  return res.status(200).json({
    products: enriched,
    meta: {
      fetchedAt: new Date().toISOString(),
      totalProducts: enriched.length,
      newProducts: enriched.filter(p => p.isNew).length,
      saleProducts: enriched.filter(p => p.isSale).length,
      brands: brands.length,
      errors: errors.length > 0 ? errors : undefined,
    }
  });
};

// ── GitHub brand reader ───────────────────────────────────

async function readBrandsFromGitHub() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${BRANDS_FILE}?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'curated-style-aggregator',
      },
    };

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode === 404) return resolve(DEFAULT_BRANDS);
          if (resp.statusCode >= 400) return reject(new Error(parsed.message));
          const content = Buffer.from(parsed.content, 'base64').toString('utf8');
          resolve(JSON.parse(content));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Shopify fetcher ───────────────────────────────────────

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StyleAggregator/1.0)', 'Accept': 'application/json' },
      timeout: 12000,
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        const redirect = resp.headers.location.startsWith('http')
          ? resp.headers.location
          : new URL(resp.headers.location, urlStr).href;
        return fetchUrl(redirect).then(resolve).catch(reject);
      }
      if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`));
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function fetchBrand(brand) {
  const baseUrl = brand.url.replace(/\/$/, "");
  const products = [];
  let page = 1;

  while (true) {
    const data = await fetchUrl(`${baseUrl}/products.json?limit=250&page=${page}`);
    if (!data.products || data.products.length === 0) break;

    for (const product of data.products) {
      const type = (product.product_type || "").toLowerCase();
      if (["gift card", "gift-card", "giftcard"].includes(type)) continue;

      const variant = product.variants && product.variants[0];
      if (!variant) continue;

      const price       = parseFloat(variant.price || 0);
      const comparePrice = parseFloat(variant.compare_at_price || 0);
      const image       = product.images && product.images[0] ? product.images[0].src : null;

      products.push({
        id:             `${brand.id}-${product.id}`,
        brandId:         brand.id,
        brandName:       brand.name,
        brandUrl:        brand.url,
        name:            product.title,
        handle:          product.handle,
        productUrl:      `${baseUrl}/products/${product.handle}`,
        image,
        price,
        comparePrice:    comparePrice > price ? comparePrice : null,
        category:        product.product_type || "Clothing",
        tags:            Array.isArray(product.tags) ? product.tags.slice(0, 5) : (product.tags ? product.tags.split(", ").slice(0, 5) : []),
        publishedAt:     product.published_at,
        availableSizes:  (product.variants || []).filter(v => v.available).map(v => v.title).filter(t => t !== "Default Title").slice(0, 8),
        totalVariants:   (product.variants || []).length,
      });
    }

    if (data.products.length < 250) break;
    page++;
    if (page > 5) break;
  }

  return products;
}
