// The Stylist assistant (public). The agent itself arrives in Phase 2; for now only feedback is live.
//   POST /api/stylist?feedback=1  { traceId, rating: "up" | "down", note? }  → logged as a FEEDBACK line
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (req.query.feedback === '1') {
    const { traceId, rating, note } = req.body || {};
    if (!traceId || !['up', 'down'].includes(rating)) {
      return res.status(400).json({ error: "traceId and rating ('up' or 'down') are required" });
    }
    console.log('FEEDBACK ' + JSON.stringify({
      traceId: String(traceId).slice(0, 64), rating,
      note: note ? String(note).slice(0, 500) : null, ts: new Date().toISOString(),
    }));
    return res.status(200).json({ ok: true });
  }

  return res.status(501).json({ error: "The Stylist agent isn't built yet (Phase 2)." });
};
