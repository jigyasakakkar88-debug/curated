// api/products.js
// Fetches live product data from all configured Shopify stores
// Called by the frontend on page load and on manual refresh

const DEFAULT_BRANDS = [
  { id: "gangafashions", name: "Ganga Fashions", url: "https://gangafashions.com" },
  { id: "kharakapas",    name: "Khara Kapas",    url: "https://kharakapas.com"    }
];

const SALE_THRESHOLD = 10; // percent — items discounted >= this appear in Sale section

export default async function handler(req, res) {
  // CORS — allow the frontend to call this from any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Load brands: prefer KV store (set via admin panel), fall back to defaults
  let brands = DEFAULT_BRANDS;
  try {
    if (process.env.BRANDS_JSON) {
      const parsed = JSON.parse(process.env.BRANDS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) brands = parsed;
    }
  } catch (_) {}

  // Fetch all brands in parallel
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

  // Mark items as new (added in last 7 days) and on sale
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
}

async function fetchBrand(brand) {
  const baseUrl = brand.url.replace(/\/$/, "");
  const products = [];
  let page = 1;
  const limit = 250; // Shopify max per page

  // Shopify's public /products.json endpoint — no API key required
  while (true) {
    const url = `${baseUrl}/products.json?limit=${limit}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; StyleAggregator/1.0)",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${brand.name}`);
    }

    const data = await response.json();
    if (!data.products || data.products.length === 0) break;

    for (const product of data.products) {
      // Only include clothing (filter out non-apparel if product_type is set)
      const type = (product.product_type || "").toLowerCase();
      const skip = ["gift card", "gift-card", "giftcard"].includes(type);
      if (skip) continue;

      // Use the first variant for pricing
      const variant = product.variants?.[0];
      if (!variant) continue;

      const price = parseFloat(variant.price || 0);
      const comparePrice = parseFloat(variant.compare_at_price || 0);

      // Get the best image
      const image = product.images?.[0]?.src || null;

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
        availableSizes: product.variants
          ?.filter(v => v.available)
          .map(v => v.title)
          .filter(t => t !== "Default Title")
          .slice(0, 8) || [],
        totalVariants: product.variants?.length || 0,
      });
    }

    // Stop if fewer than limit returned (last page)
    if (data.products.length < limit) break;
    page++;

    // Safety cap — don't fetch more than 5 pages per brand (1250 products)
    if (page > 5) break;
  }

  return products;
}
