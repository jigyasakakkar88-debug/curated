// api/admin.js
// Handles admin panel actions: list brands, add brand, remove brand, test brand URL

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth check — simple password in Authorization header
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // GET /api/admin — return current brands list
  if (req.method === "GET") {
    const brands = getBrands();
    return res.status(200).json({ brands });
  }

  // POST /api/admin/test — test if a URL is a valid Shopify store
  if (req.method === "POST" && req.query.action === "test") {
    const { url } = req.body;
    const result = await testShopifyStore(url);
    return res.status(200).json(result);
  }

  // POST /api/admin — add a brand
  if (req.method === "POST") {
    const { url, name } = req.body;
    if (!url || !name) return res.status(400).json({ error: "url and name are required" });

    const brands = getBrands();
    const id = url.replace(/https?:\/\//,"").replace(/\//g,"").replace(/\./g,"-").toLowerCase();

    if (brands.find(b => b.url === url.replace(/\/$/,""))) {
      return res.status(409).json({ error: "Brand already exists" });
    }

    brands.push({ id, name, url: url.replace(/\/$/,"") });

    // In production, update BRANDS_JSON env var via Vercel API
    // Here we return the new JSON for the user to manually set
    return res.status(200).json({
      success: true,
      brands,
      envValue: JSON.stringify(brands),
      message: "Copy the envValue and update BRANDS_JSON in your Vercel environment variables."
    });
  }

  // DELETE /api/admin — remove a brand
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
}

function getBrands() {
  try {
    if (process.env.BRANDS_JSON) return JSON.parse(process.env.BRANDS_JSON);
  } catch (_) {}
  return [
    { id: "gangafashions", name: "Ganga Fashions", url: "https://gangafashions.com" },
    { id: "kharakapas",    name: "Khara Kapas",    url: "https://kharakapas.com"    }
  ];
}

async function testShopifyStore(url) {
  try {
    const baseUrl = url.replace(/\/$/,"");
    const response = await fetch(`${baseUrl}/products.json?limit=5`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { valid: false, error: `Store returned HTTP ${response.status}` };
    const data = await response.json();
    if (!data.products) return { valid: false, error: "Not a Shopify store" };
    return {
      valid: true,
      productCount: data.products.length,
      sampleProduct: data.products[0]?.title,
      message: `✓ Valid Shopify store. Found products.`
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
