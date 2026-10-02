// Observability: every Stylist answer's trace is stored as JSON on a separate git branch
// (default `observability`, never deployed), one file per UTC day: traces/YYYY-MM-DD.json.
// Writes happen after the response is sent (waitUntil), so users never wait for them.
const github = require('./github');

const OBS_BRANCH = process.env.OBS_BRANCH || 'observability';
const MAX_PER_DAY = 1000;

const dayOf = iso => (iso || new Date().toISOString()).slice(0, 10);
const traceFile = day => `traces/${day}.json`;

// Keep traces small: drop bulky fields, cap long strings.
function compactTrace(t) {
  const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) + '…' : v);
  return {
    traceId: t.traceId, ts: t.ts, source: t.source, system: t.system, model: t.model, index: t.index,
    runId: t.runId, queryId: t.queryId,
    query: clip(t.query, 500),
    steps: (t.steps || []).map(s => ({ tool: s.tool, input: s.input, resultCount: s.resultCount,
                                       relaxed: s.relaxed, ms: s.ms, ...(s.error ? { error: clip(s.error, 200) } : {}) })),
    stepCount: t.stepCount, firstTool: t.firstTool, llmCalls: t.llmCalls, tokens: t.tokens,
    costINR: t.costINR, latencyMs: t.latencyMs, finishedBy: t.finishedBy || null,
    answer: t.answer ? { text: clip(t.answer.text, 800), product_ids: t.answer.product_ids,
                         caveats: t.answer.caveats, policy_quotes: t.answer.policy_quotes } : null,
    productIds: t.productIds, invalidIds: t.invalidIds, error: t.error || null,
    feedback: t.feedback || null,
  };
}

async function saveTrace(trace) {
  if (!github.isConfigured()) return;
  try {
    await github.ensureBranch(OBS_BRANCH);
    const day = dayOf(trace.ts);
    await github.updateJson(traceFile(day), { traces: [] }, data => {
      data.traces = [...(data.traces || []), compactTrace(trace)].slice(-MAX_PER_DAY);
      return data;
    }, `trace ${trace.source} ${trace.traceId.slice(0, 8)}`, OBS_BRANCH);
  } catch (e) {
    console.error('saveTrace failed', e.message);   // observability must never break the product
  }
}

// Attach a thumbs up/down to a stored trace (looks in today's and yesterday's files).
async function saveFeedback(traceId, rating, note) {
  if (!github.isConfigured()) return false;
  const today = new Date();
  const days = [0, 1].map(d => dayOf(new Date(today - d * 864e5).toISOString()));
  for (const day of days) {
    let found = false;
    try {
      await github.updateJson(traceFile(day), { traces: [] }, data => {
        const t = (data.traces || []).find(x => x.traceId === traceId);
        if (t) { t.feedback = { rating, note: note || null, ts: new Date().toISOString() }; found = true; }
        return data;
      }, `feedback ${rating} ${traceId.slice(0, 8)}`, OBS_BRANCH);
    } catch (e) {
      console.error('saveFeedback failed', e.message);
    }
    if (found) return true;
  }
  return false;
}

async function loadTraces(days = 7) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const day = dayOf(new Date(Date.now() - d * 864e5).toISOString());
    const data = await github.readJson(traceFile(day), null, OBS_BRANCH).catch(() => null);
    if (data?.traces) out.push(...data.traces);
  }
  return out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

const pct = (arr, p) => {
  const v = arr.filter(x => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
};
const mean = arr => { const v = arr.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const round = (x, n = 2) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

function summarize(traces) {
  const ok = traces.filter(t => !t.error);
  const toolCounts = {};
  for (const t of ok) for (const s of t.steps || []) if (s.tool !== 'respond') toolCounts[s.tool] = (toolCounts[s.tool] || 0) + 1;
  const toolCalls = t => (t.steps || []).filter(s => s.tool !== 'respond').length;
  const rated = traces.filter(t => t.feedback);
  const finishedBy = {};
  for (const t of ok) finishedBy[t.finishedBy || 'unknown'] = (finishedBy[t.finishedBy || 'unknown'] || 0) + 1;
  return {
    questions: traces.length,
    errors: traces.length - ok.length,
    latencySec: { p50: round(pct(ok.map(t => t.latencyMs), 0.5) / 1000, 1), p90: round(pct(ok.map(t => t.latencyMs), 0.9) / 1000, 1) },
    costINR: { p50: round(pct(ok.map(t => t.costINR), 0.5)), p90: round(pct(ok.map(t => t.costINR), 0.9)),
               total: round(ok.reduce((a, t) => a + (t.costINR || 0), 0)) },
    toolCalls: { mean: round(mean(ok.map(toolCalls)), 1), p90: pct(ok.map(toolCalls), 0.9) },
    llmCalls: { mean: round(mean(ok.map(t => t.llmCalls)), 1) },
    within2ToolCalls: ok.length ? round(ok.filter(t => toolCalls(t) <= 2).length / ok.length, 2) : null,
    relaxedRate: ok.length ? round(ok.filter(t => (t.steps || []).some(s => s.relaxed)).length / ok.length, 2) : null,
    invalidIdRate: ok.length ? round(ok.filter(t => (t.invalidIds || []).length).length / ok.length, 2) : null,
    cacheReadShare: (() => { const i = ok.reduce((a, t) => a + (t.tokens?.in || 0) + (t.tokens?.cacheRead || 0), 0);
                             return i ? round(ok.reduce((a, t) => a + (t.tokens?.cacheRead || 0), 0) / i, 2) : null; })(),
    feedback: { up: rated.filter(t => t.feedback.rating === 'up').length, down: rated.filter(t => t.feedback.rating === 'down').length },
    finishedBy, toolCounts,
  };
}

module.exports = { OBS_BRANCH, saveTrace, saveFeedback, loadTraces, summarize, compactTrace, pct, round };
