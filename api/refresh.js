// api/refresh.js
const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const isVercelCron = req.headers["authorization"] === `Bearer ${process.env.CRON_SECRET}`;
  const isAdmin = req.headers["authorization"] === `Bearer ${process.env.ADMIN_PASSWORD || "changeme123"}`;

  if (!isVercelCron && !isAdmin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.status(200).json({
    success: true,
    refreshedAt: new Date().toISOString(),
    message: "Cache will refresh on next products.json request",
  });
};
