// Observability + evals (admin). Data lives on the `observability` branch (never deployed).
//   GET  /api/insights?view=traces[&days=7][&source=live|admin|all]  → { summary, traces }
//   GET  /api/insights?view=runs                                      → eval run list with summaries
//   GET  /api/insights?view=run&runId=…                               → one run with every answer
//   GET  /api/insights?view=testset                                   → the eval questions
//   POST /api/insights?action=start    { system: "C"|"baseline", ids?, runs?, index?, label? }
//   POST /api/insights?action=continue { runId }   → processes the next batch (call until remaining = 0)
//   POST /api/insights?action=grade    { runId, queryId, repeat, grade: "pass"|"fail"|null, note? }
const github = require('../lib/github');
const observability = require('../lib/observability');
const evals = require('../lib/evals');
const { INDEX_PATTERN } = require('../lib/tools');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers["authorization"] !== `Bearer ${ADMIN_PASSWORD}`) return res.status(401).json({ error: "Unauthorized" });
  if (!github.isConfigured()) return res.status(500).json({ error: "GitHub not configured (GITHUB_TOKEN, GITHUB_REPO)." });

  const q = req.query || {};
  const body = req.body || {};
  try {
    if (req.method === "GET") {
      if (q.view === 'traces') {
        const days = Math.min(Number(q.days) || 7, 30);
        const source = q.source || 'live';
        const all = await observability.loadTraces(days);
        const traces = source === 'all' ? all : all.filter(t => t.source === source);
        return res.status(200).json({ days, source, summary: observability.summarize(traces),
                                      bySource: countBy(all, t => t.source), traces: traces.slice(0, 100) });
      }
      if (q.view === 'runs') return res.status(200).json({ runs: await evals.listRuns() });
      if (q.view === 'run') {
        const run = await evals.getRun(String(q.runId || ''));
        return run ? res.status(200).json(run) : res.status(404).json({ error: "Run not found" });
      }
      if (q.view === 'testset') return res.status(200).json(evals.testset);
      return res.status(400).json({ error: "view must be traces, runs, run or testset" });
    }
    if (req.method === "POST") {
      if (q.action === 'start') {
        const index = body.index && INDEX_PATTERN.test(body.index) ? body.index : undefined;
        return res.status(200).json(await evals.startRun({ system: body.system, ids: body.ids, runs: body.runs, index, label: body.label }));
      }
      if (q.action === 'continue') return res.status(200).json(await evals.continueRun(String(body.runId || '')));
      if (q.action === 'grade') return res.status(200).json(await evals.gradeResult(String(body.runId || ''), body));
      return res.status(400).json({ error: "action must be start, continue or grade" });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("insights error", e);
    return res.status(500).json({ error: e.message });
  }
};

function countBy(list, fn) {
  const out = {};
  for (const x of list) { const k = fn(x) || 'unknown'; out[k] = (out[k] || 0) + 1; }
  return out;
}
