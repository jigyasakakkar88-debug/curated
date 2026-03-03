// api/admin.js
const https = require('https');
const http = require('http');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

const DEFAULT_BRANDS = [
  { id: "gangafashions", name: "Ganga Fashions", url: "https://gangafashions.com" },
  { id: "kharakapas",    name: "Khara Kapas",    url: "https://kharakapas.com"    }
];

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method === "GET") {
    return res.status(200).json({ brands: getBrands() });
  }

  if (req.method === "POST" && req.query.action === "test") {
    const { url } = req.body;
    const result = await testShopifyStore(url);
    return res.status(200).json(result);
  }

  if (req.method === "POST") {
    const { url, name } = req.body;
    if (!url || !name) return res.status(400).json({ error: "url and name are required" });

    const brands = getBrands();
    const id = url.replace(/https?:\/\//, "").replace(/\//g, "").replace(/\./g, "-").toLowerCase();

    if (brands.find(b => b.url === url.replace(/\/$/, ""))) {
      return res.status(409).json({ error: "Brand already exists" });
    }

    brands.push({ id, name, url: url.replace(/\/$/, "") });

    return res.status(200).json({
      success: true,
      brands,
      envValue: JSON.stringify(brands),
    });
  }

  if (req.method === "DELETE") {
    const { id } = req.body;
    const brands = getBrands().filter(b => b.id !== id);
    return res.status(200).json({
      success: true,
      brands,
      envValue: JSON.stringify(brands),
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
};

function getBrands() {
  try {
    if (process.env.BRANDS_JSON) return JSON.parse(process.env.BRANDS_JSON);
  } catch (_) {}
  return DEFAULT_BRANDS;
}

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirect = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).href;
        return fetchUrl(redirect).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
  });
}

async function testShopifyStore(url) {
  try {
    const baseUrl = url.replace(/\/$/, "");
    const result = await fetchUrl(`${baseUrl}/products.json?limit=3`);
    if (!result.body || !result.body.products) {
      return { valid: false, error: "Not a Shopify store (no products.json endpoint)" };
    }
    return {
      valid: true,
      productCount: result.body.products.length,
      sampleProduct: result.body.products[0] ? result.body.products[0].title : null,
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
