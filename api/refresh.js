// api/refresh.js
// Called weekly by Vercel Cron (Monday 6am UTC) to bust the cache
// Also callable manually from the admin panel

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Vercel cron calls this with a special header for auth
  const isVercelCron = req.headers["authorization"] === `Bearer ${process.env.CRON_SECRET}`;
  const isAdmin = req.headers["authorization"] === `Bearer ${process.env.ADMIN_PASSWORD || "changeme123"}`;

  if (!isVercelCron && !isAdmin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Bust Vercel's edge cache for /api/products by re-fetching it
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

    const response = await fetch(`${baseUrl}/api/products`, {
      headers: { "Cache-Control": "no-cache" }
    });

    const data = await response.json();

    return res.status(200).json({
      success: true,
      refreshedAt: new Date().toISOString(),
      totalProducts: data.meta?.totalProducts,
      newProducts: data.meta?.newProducts,
      saleProducts: data.meta?.saleProducts,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
