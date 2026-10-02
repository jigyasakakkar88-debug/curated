// One trace record per Stylist question (docs/STYLIST.md §5).
// Live traces are printed as a single "TRACE {json}" line (Vercel logs); eval traces are returned to the caller.
const crypto = require('crypto');
const { costINR } = require('./pricing');

function startTrace({ source = 'live', runId = null, queryId = null, query = '', system = null, model = null, index = null } = {}) {
  const started = Date.now();
  const seenIds = new Set();
  const data = {
    traceId: crypto.randomUUID(),
    ts: new Date(started).toISOString(),
    source, runId, queryId, query, system, model, index,
    steps: [],
    llmCalls: 0,
    tokens: { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 },
  };

  return {
    data,
    // One tool call.
    step(tool, input, { resultCount = null, relaxed = null, ms = 0, error = null } = {}) {
      data.steps.push({ tool, input, resultCount, relaxed, ms, ...(error ? { error } : {}) });
    },
    // Product ids a tool actually returned — anything else the agent names is invalid.
    seen(ids) { for (const id of ids || []) seenIds.add(id); },
    // One model call; usage = Anthropic response.usage.
    llm(usage = {}) {
      data.llmCalls++;
      data.tokens.in         += usage.input_tokens || 0;
      data.tokens.out        += usage.output_tokens || 0;
      data.tokens.cacheWrite += usage.cache_creation_input_tokens || 0;
      data.tokens.cacheRead  += usage.cache_read_input_tokens || 0;
    },
    // answer = the agent's `respond` input (or null for tool-only runs like /api/search).
    finish(answer = null) {
      const productIds = (answer && answer.product_ids) || [];
      Object.assign(data, {
        answer,
        stepCount: data.steps.length,
        firstTool: data.steps[0]?.tool || null,
        latencyMs: Date.now() - started,
        costINR: data.model ? costINR(data.model, {
          input_tokens: data.tokens.in, output_tokens: data.tokens.out,
          cache_creation_input_tokens: data.tokens.cacheWrite, cache_read_input_tokens: data.tokens.cacheRead,
        }) : 0,
        productIds,
        invalidIds: productIds.filter(id => !seenIds.has(id)),
        checks: data.checks || {},
        humanGrade: null, note: null, feedback: null,
      });
      if (data.source !== 'eval') console.log('TRACE ' + JSON.stringify(data));
      return data;
    },
  };
}

module.exports = { startTrace };
