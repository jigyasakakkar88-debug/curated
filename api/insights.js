// Observability + evals (admin). Data lives on the `observability` branch (never deployed).
//   GET  /api/insights?view=traces[&days=7][&source=live|admin|all]  → { summary, traces }
//   GET  /api/insights?view=runs                                      → eval run list with summaries
//   GET  /api/insights?view=run&runId=…                               → one run with every answer
//   GET  /api/insights?view=testset                                   → the eval questions
//   POST /api/insights?action=start    { system: "C"|"baseline", ids?, runs?, index?, label? }
//   POST /api/insights?action=continue { runId }   → processes the next batch (call until remaining = 0)
//   POST /api/insights?action=grade    { runId, queryId, repeat, grade?: "pass"|"fail"|null, rubric?: {dimId: 0|1|2|"na"}, note? }
//   Relevance labels (answer key for recall; lib/relevance.js):
//   GET  /api/insights?view=relevance[&queryId=…]   → overview of every discovery question, or one question's pool
//   POST /api/insights?action=pool  { queryId, index? }   → build/extend the candidate pool (several searches + eval-run products)
//   POST /api/insights?action=judge { queryId }           → Claude Haiku pre-grades unlabelled pool items 0/1/2 (call until remaining = 0)
//   POST /api/insights?action=label { queryId, labels: {productId: 0|1|2|null} } → your grades
const github = require('../lib/github');
const observability = require('../lib/observability');
const evals = require('../lib/evals');
const relevance = require('../lib/relevance');
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
        if (!run) return res.status(404).json({ error: "Run not found" });
        run.relevance = await relevance.scoreRun(run).catch(e => ({ error: e.message }));
        return res.status(200).json(run);
      }
      if (q.view === 'testset') return res.status(200).json({ ...evals.testset, rubric: evals.rubric });
      if (q.view === 'relevance') {
        if (q.queryId) return res.status(200).json((await relevance.getLabels(String(q.queryId))) || { queryId: q.queryId, items: {} });
        return res.status(200).json({ queries: await relevance.overview() });
      }
      return res.status(400).json({ error: "view must be traces, runs, run, testset or relevance" });
    }
    if (req.method === "POST") {
      if (q.action === 'start') {
        const index = body.index && INDEX_PATTERN.test(body.index) ? body.index : undefined;
        return res.status(200).json(await evals.startRun({ system: body.system, ids: body.ids, runs: body.runs, index, label: body.label }));
      }
      if (q.action === 'continue') return res.status(200).json(await evals.continueRun(String(body.runId || '')));
      if (q.action === 'grade') return res.status(200).json(await evals.gradeResult(String(body.runId || ''), body));
      if (q.action === 'pool') {
        const index = body.index && INDEX_PATTERN.test(body.index) ? body.index : undefined;
        return res.status(200).json(await relevance.buildPool(String(body.queryId || ''), { index }));
      }
      if (q.action === 'judge') return res.status(200).json(await relevance.judgePool(String(body.queryId || '')));
      if (q.action === 'label') return res.status(200).json(await relevance.saveLabels(String(body.queryId || ''), body.labels));
      return res.status(400).json({ error: "action must be start, continue, grade, pool, judge or label" });
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
