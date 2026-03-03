// api/products.js
const https = require('https');
const http = require('http');

const DEFAULT_BRANDS = [
  { id: "gangafashions", name: "Ganga Fashions", url: "https://gangafashions.com" },
  { id: "kharakapas",    name: "Khara Kapas",    url: "https://kharakapas.com"    }
];

const SALE_THRESHOLD = 10;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") return res.status(200).end();

  let brands = DEFAULT_BRANDS;
  try {
    if (process.env.BRANDS_JSON) {
      const parsed = JSON.parse(process.env.BRANDS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) brands = parsed;
    }
  } catch (_) {}

  const results = await Promise.allSettled(brands.map(brand => fetchBrand(brand)));

  const allProducts = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      allProducts.push(...result.value);
    } else {
      errors.push({ brand: brands[i].name, error: result.reason?.message });
    }
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

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StyleAggregator/1.0)',
        'Accept': 'application/json',
      },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirect = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).href;
        return fetchUrl(redirect).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${urlStr}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON response')); }
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
  const limit = 250;

  while (true) {
    const url = `${baseUrl}/products.json?limit=${limit}&page=${page}`;
    const data = await fetchUrl(url);

    if (!data.products || data.products.length === 0) break;

    for (const product of data.products) {
      const type = (product.product_type || "").toLowerCase();
      if (["gift card", "gift-card", "giftcard"].includes(type)) continue;

      const variant = product.variants && product.variants[0];
      if (!variant) continue;

      const price = parseFloat(variant.price || 0);
      const comparePrice = parseFloat(variant.compare_at_price || 0);
      const image = product.images && product.images[0] ? product.images[0].src : null;

      products.push({
        id: `${brand.id}-${product.id}`,
        brandId: brand.id,
        brandName: brand.name,
        brandUrl: brand.url,
        name: product.title,
        handle: product.handle,
        productUrl: `${baseUrl}/products/${product.handle}`,
        image,
        price,
        comparePrice: comparePrice > price ? comparePrice : null,
        category: product.product_type || "Clothing",
        tags: product.tags ? product.tags.split(", ").slice(0, 5) : [],
        publishedAt: product.published_at,
        availableSizes: (product.variants || [])
          .filter(v => v.available)
          .map(v => v.title)
          .filter(t => t !== "Default Title")
          .slice(0, 8),
        totalVariants: (product.variants || []).length,
      });
    }

    if (data.products.length < limit) break;
    page++;
    if (page > 5) break;
  }

  return products;
}
