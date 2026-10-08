// Eval harness: run the test set through a system (C = the agent, baseline = plain keyword search),
// apply automatic code checks, and summarise. Runs are stored on the observability branch:
//   evals/runs/<runId>.json   full results (answers, products, checks, traces, human grades)
//   evals/index.json          one summary line per run
const github = require('./github');
const algolia = require('./algolia');
const { createToolbox } = require('./tools');
const { runAgent, getModel } = require('./agent');
const { startTrace } = require('./trace');
const { loadCards } = require('./cards');
const { OBS_BRANCH, pct, round } = require('./observability');
const testset = require('../evals/testset.json');
const pricing = require('./pricing');
const rubric = require('../evals/rubric.json');
const fixtures = require('../evals/fixtures.json');

const SYSTEMS = ['C', 'baseline'];
const runFile = id => `evals/runs/${id}.json`;
const INDEX_FILE = 'evals/index.json';

// Which tool a good answer should start with, per route.
const ROUTE_FIRST_TOOL = { find: 'search_products', policy: 'get_policies', compound: null, advice: null, clarify: 'respond', decline: 'respond' };

// ── Checks ─────────────────────────────────────────────────

function policyBrands(policies, spec) {
  return Object.entries(policies.brands || {}).filter(([, e]) => {
    const f = e.fields || {};
    if (spec.returnable !== undefined && f.returnable?.value !== spec.returnable) return false;
    if (spec.returnWindowDaysMin !== undefined && !(f.returnWindowDays?.value >= spec.returnWindowDaysMin)) return false;
    if (spec.freeShippingThreshold !== undefined && f.freeShippingThreshold?.value !== spec.freeShippingThreshold) return false;
    return true;
  }).map(([id, e]) => ({ id, name: e.name }));
}

// Returns { name: { pass, detail } } for every check the query defines (+ invalidIds always).
function runChecks(q, result, policies) {
  const c = q.checks || {};
  const products = result.products || [];
  const text = (result.answer || '').toLowerCase();
  const caveats = (result.caveats || []).join(' ').toLowerCase();
  const out = {};
  const add = (name, pass, detail) => { out[name] = { pass, detail }; };

  if (c.maxPrice !== undefined) {
    const over = products.filter(p => p.price > c.maxPrice);
    const caveated = over.length > 0 && /₹|price|budget|under|above|over|stretch|closest/.test(caveats + ' ' + text);
    add('maxPrice', over.length === 0 || caveated, over.length ? `${over.length} over ₹${c.maxPrice}${caveated ? ' (explained in caveat)' : ''}` : 'all within');
  }
  if (c.maxTotal !== undefined) {
    const prices = products.map(p => p.price).sort((a, b) => a - b);
    const ok = prices.length >= 2 && prices[0] + prices[1] <= c.maxTotal;
    add('maxTotal', ok, prices.length >= 2 ? `cheapest two = ₹${prices[0] + prices[1]}` : 'fewer than 2 products');
  }
  if (c.size) {
    const miss = products.filter(p => !(p.availableSizes || []).includes(String(c.size).toUpperCase()));
    add('size', miss.length === 0, miss.length ? `${miss.length} without ${c.size}` : 'all have size');
  }
  if (c.minDiscount !== undefined) {
    const low = products.filter(p => (p.discountPct || 0) < c.minDiscount);
    add('minDiscount', low.length === 0, low.length ? `${low.length} below ${c.minDiscount}%` : 'ok');
  }
  if (c.returnableOnly) {
    const bad = products.filter(p => policies.brands?.[p.brandId]?.fields?.returnable?.value !== true);
    add('returnableOnly', bad.length === 0, bad.length ? `${bad.length} from brands not marked returnable (${[...new Set(bad.map(p => p.brandName))].join(', ')})` : 'all returnable');
  }
  if (c.gender) {
    const other = c.gender === 'men' ? ['women', 'kids'] : c.gender === 'women' ? ['men', 'kids'] : [];
    const bad = products.filter(p => other.includes(p.gender));
    add('gender', bad.length === 0, bad.length ? `${bad.length} labelled ${[...new Set(bad.map(p => p.gender))].join('/')}` : 'ok');
  }
  if (c.expectProducts) add('expectProducts', products.length > 0, `${products.length} products`);
  if (c.expectNoProducts) add('expectNoProducts', products.length === 0, `${products.length} products`);
  if (c.asksQuestion) add('asksQuestion', /\?/.test(result.answer || ''), /\?/.test(result.answer || '') ? 'asked' : 'no question');
  if (c.mustMentionPolicyBrands) {
    const expected = policyBrands(policies, c.mustMentionPolicyBrands);
    const missing = expected.filter(b => !text.includes(b.name.toLowerCase()));
    add('mustMentionBrands', expected.length > 0 && missing.length === 0,
        expected.length ? `${expected.length - missing.length}/${expected.length} named${missing.length ? `; missing ${missing.map(b => b.name).join(', ')}` : ''}` : 'no brands match in policies.json');
  }
  const invalid = result.trace?.invalidIds || [];
  add('noInventedProducts', invalid.length === 0, invalid.length ? `${invalid.length} invented ids dropped` : 'ok');
  return out;
}

// ── Running one query ──────────────────────────────────────

async function pickWishlist(index) {
  const client = algolia.getClient('search');
  const ids = [];
  for (const brandId of fixtures.wishlist.brandIds) {
    const res = await client.searchSingleIndex({ indexName: index, searchParams: {
      query: fixtures.wishlist.query, filters: `brandId:"${brandId}" AND inStock:true`, hitsPerPage: 1 } });
    if (res.hits[0]) ids.push(res.hits[0].objectID);
  }
  return ids;
}

async function runOne({ q, system, index, runId, brands, wishlistIds, model }) {
  const t0 = Date.now();
  const trace = startTrace({ source: 'eval', runId, queryId: q.id, query: q.query, system,
                             model: system === 'C' ? model : null, index });
  const searchClient = algolia.getClient('search');
  const turns = [];
  let answer, finishedBy;

  if (system === 'baseline') {
    // No LLM: the raw question goes straight into keyword search; top 10 are "the answer".
    const toolbox = createToolbox({ index, trace });
    const r = await toolbox.run('search_products', { query: q.query, limit: 10 });
    const ids = (r.results || []).map(x => x.id);
    answer = { text: ids.length ? `Top ${ids.length} keyword matches.` : 'No keyword matches.', product_ids: ids, caveats: r.relaxed ? [`relaxed: ${r.relaxed}`] : [], policy_quotes: [] };
    finishedBy = 'baseline';
    turns.push({ role: 'user', content: q.query }, { role: 'assistant', content: answer.text });
  } else {
    const history = [{ role: 'user', content: q.query }];
    const wl = q.useWishlist ? wishlistIds : [];
    let res = await runAgent({ history, wishlistIds: wl, index, brands, trace, model });
    // If it asked a clarifying question and the test defines the user's reply, continue once.
    if (q.followUp && !res.answer.product_ids.length && /\?/.test(res.answer.text)) {
      history.push({ role: 'assistant', content: res.answer.text }, { role: 'user', content: q.followUp });
      res = await runAgent({ history, wishlistIds: wl, index, brands, trace, model });
    }
    history.push({ role: 'assistant', content: res.answer.text });
    turns.push(...history);
    answer = res.answer; finishedBy = res.finishedBy;
  }

  const t = trace.finish(answer);
  t.finishedBy = finishedBy;
  const invalid = new Set(t.invalidIds);
  const ids = [...new Set(answer.product_ids)].filter(id => !invalid.has(id)).slice(0, 10);
  const products = await loadCards(searchClient, index, ids);
  return {
    queryId: q.id, query: q.query, route: q.route, system, turns,
    answer: answer.text, caveats: answer.caveats, policy_quotes: answer.policy_quotes,
    products: products.map(p => ({ id: p.id, name: p.name, brandId: p.brandId, brandName: p.brandName, price: p.price,
                                   discountPct: p.discountPct, gender: p.gender, availableSizes: p.availableSizes, image: p.image, productUrl: p.productUrl })),
    trace: t, ms: Date.now() - t0,
  };
}

// ── Summary ────────────────────────────────────────────────

function summarize(run) {
  const results = run.results || [];
  const done = results.filter(r => !r.error);
  const allPass = r => Object.values(r.checks || {}).every(c => c.pass);
  const byCheck = {};
  for (const r of done) for (const [k, c] of Object.entries(r.checks || {})) {
    byCheck[k] = byCheck[k] || { pass: 0, total: 0 };
    byCheck[k].total++; if (c.pass) byCheck[k].pass++;
  }
  const graded = done.filter(r => r.grade);
  const byQuery = {};
  for (const r of done) (byQuery[r.queryId] = byQuery[r.queryId] || []).push(r);
  const toolCalls = r => (r.trace?.steps || []).filter(s => s.tool !== 'respond').length;
  const routeOk = done.filter(r => ROUTE_FIRST_TOOL[r.route]);
  const sum = f => done.reduce((a, r) => a + (f(r) || 0), 0);
  const totalINR = sum(r => r.trace?.costINR);
  // Cost per good answer: uses your grades once any exist, otherwise the auto checks.
  const passes = graded.length ? graded.filter(r => r.grade === 'pass').length : done.filter(allPass).length;
  return {
    answers: results.length, errors: results.length - done.length,
    codeCheckPassRate: done.length ? round(done.filter(allPass).length / done.length) : null,
    humanPassRate: graded.length ? round(graded.filter(r => r.grade === 'pass').length / graded.length) : null,
    graded: graded.length,
    consistency: run.runs > 1 ? round(Object.values(byQuery).filter(rs => rs.length === run.runs && rs.every(allPass)).length / Object.keys(byQuery).length) : null,
    latencySec: { p50: round(pct(done.map(r => r.trace?.latencyMs), 0.5) / 1000, 1), p90: round(pct(done.map(r => r.trace?.latencyMs), 0.9) / 1000, 1) },
    costINR: { p50: round(pct(done.map(r => r.trace?.costINR), 0.5)), p90: round(pct(done.map(r => r.trace?.costINR), 0.9)),
               total: round(totalINR), mean: done.length ? round(totalINR / done.length) : null,
               perPass: passes ? round(totalINR / passes) : null, perPassBasis: graded.length ? 'your grades' : 'auto checks' },
    // Older runs have no costUSD per answer; re-derive it from the saved tokens.
    costUSD: { total: round(sum(r => r.trace?.costUSD ?? (r.trace?.model ? pricing.costUSD(r.trace.model, {
      input_tokens: r.trace.tokens?.in, output_tokens: r.trace.tokens?.out,
      cache_creation_input_tokens: r.trace.tokens?.cacheWrite, cache_read_input_tokens: r.trace.tokens?.cacheRead }) : 0)), 4) },
    tokens: { in: sum(r => r.trace?.tokens?.in), out: sum(r => r.trace?.tokens?.out),
              cacheWrite: sum(r => r.trace?.tokens?.cacheWrite), cacheRead: sum(r => r.trace?.tokens?.cacheRead) },
    llmCalls: sum(r => r.trace?.llmCalls),
    // Algolia free plan allows 10,000 searches a month, so count them too.
    searches: sum(r => (r.trace?.steps || []).filter(s => s.tool === 'search_products').length),
    toolCalls: { p50: pct(done.map(toolCalls), 0.5), p90: pct(done.map(toolCalls), 0.9) },
    within2ToolCalls: done.length ? round(done.filter(r => toolCalls(r) <= 2).length / done.length) : null,
    routeAgreement: routeOk.length ? round(routeOk.filter(r => r.trace?.firstTool === ROUTE_FIRST_TOOL[r.route]).length / routeOk.length) : null,
    relaxedRate: done.length ? round(done.filter(r => (r.trace?.steps || []).some(s => s.relaxed)).length / done.length) : null,
    byCheck,
    rubric: (() => {
      const rs = done.filter(r => r.rubric && r.rubric.max);
      if (!rs.length) return null;
      const byDimension = {};
      for (const d of rubric.dimensions) {
        const v = rs.map(r => r.rubric.scores[d.id]).filter(x => typeof x === 'number');
        byDimension[d.id] = v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;   // mean out of 2
      }
      return { scored: rs.length, meanPct: round(rs.reduce((a, r) => a + r.rubric.pct, 0) / rs.length), byDimension };
    })(),
  };
}

async function saveIndexEntry(run) {
  await github.updateJson(INDEX_FILE, { runs: [] }, data => {
    const entry = { runId: run.runId, label: run.label, system: run.system, model: run.model, index: run.index,
                    runs: run.runs, createdAt: run.createdAt, total: run.queue.length + (run.results || []).length,
                    finished: run.queue.length === 0, summary: run.summary };
    data.runs = [entry, ...(data.runs || []).filter(r => r.runId !== run.runId)].slice(0, 100);
    return data;
  }, `eval index ${run.runId}`, OBS_BRANCH);
}

// ── Public API ─────────────────────────────────────────────

async function startRun({ system = 'C', ids = null, runs = 1, index = algolia.INDEX, label = '' }) {
  if (!SYSTEMS.includes(system)) throw new Error(`system must be one of ${SYSTEMS.join(', ')}`);
  const queries = testset.queries.filter(q => !ids || ids.includes(q.id));
  if (!queries.length) throw new Error('No matching queries');
  runs = Math.min(Math.max(Number(runs) || 1, 1), 3);
  await github.ensureBranch(OBS_BRANCH);
  const runId = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${system}-${Math.random().toString(36).slice(2, 6)}`;
  const wishlistIds = system === 'C' ? await pickWishlist(index) : [];
  const queue = [];
  for (let r = 1; r <= runs; r++) for (const q of queries) queue.push({ queryId: q.id, repeat: r });
  const run = { runId, label, system, model: system === 'C' ? getModel() : null, index, runs, createdAt: new Date().toISOString(),
                wishlistIds, queue, results: [], summary: null,
                // Prices used for this run's ₹ figures, so later runs can be compared (or re-priced) fairly.
                pricing: system === 'C' ? { model: getModel(), usdPerMTok: pricing.MODELS[getModel()] || null,
                                            USD_INR: pricing.USD_INR, checkedOn: pricing.checkedOn } : null };
  await github.writeJson(runFile(runId), run, null, `eval start ${runId}`, OBS_BRANCH);
  await saveIndexEntry(run);
  return { runId, total: queue.length };
}

// Process queued queries with limited concurrency until the time budget is used up.
async function continueRun(runId, { budgetMs = 200000, concurrency = 3 } = {}) {
  const { data: run } = await github.readFileWithSha(runFile(runId), OBS_BRANCH);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.queue.length) return { runId, remaining: 0, summary: run.summary };

  const started = Date.now();
  const brands = await github.readJson('brands.json', []);
  const policies = await github.readJson('policies.json', { brands: {} });
  const newResults = [];
  const taken = [];
  const queue = [...run.queue];

  async function worker() {
    while (queue.length && Date.now() - started < budgetMs - 45000) {
      const item = queue.shift();
      taken.push(item);
      const q = testset.queries.find(x => x.id === item.queryId);
      try {
        const r = await runOne({ q, system: run.system, index: run.index, runId, brands, wishlistIds: run.wishlistIds, model: run.model });
        r.repeat = item.repeat;
        r.checks = runChecks(q, r, policies);
        newResults.push(r);
      } catch (e) {
        newResults.push({ queryId: q.id, query: q.query, route: q.route, repeat: item.repeat, system: run.system, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const saved = await github.updateJson(runFile(runId), run, data => {
    const doneKeys = new Set(taken.map(i => `${i.queryId}#${i.repeat}`));
    data.queue = data.queue.filter(i => !doneKeys.has(`${i.queryId}#${i.repeat}`));
    data.results = [...(data.results || []), ...newResults];
    data.summary = summarize(data);
    return data;
  }, `eval ${runId}: +${newResults.length}`, OBS_BRANCH);
  await saveIndexEntry(saved);
  return { runId, remaining: saved.queue.length, processed: newResults.length, summary: saved.summary };
}

// Rubric: { dimensionId: 0 | 1 | 2 | "na" }. Once every dimension is scored (or N/A) the verdict is derived:
// pass = no critical dimension at 0 AND total ≥ passPct of the applicable maximum.
function scoreRubric(scores) {
  const dims = rubric.dimensions;
  const clean = {};
  for (const d of dims) {
    const v = scores ? scores[d.id] : undefined;
    if (v === 'na' || v === 0 || v === 1 || v === 2) clean[d.id] = v;
  }
  const scored = dims.filter(d => typeof clean[d.id] === 'number');
  const complete = dims.every(d => d.id in clean);
  const max = scored.length * 2;
  const total = scored.reduce((a, d) => a + clean[d.id], 0);
  const pct = max ? round(total / max) : null;
  const criticalZero = dims.some(d => d.critical && clean[d.id] === 0);
  const verdict = complete && max ? (!criticalZero && total / max >= rubric.passPct ? 'pass' : 'fail') : null;
  return { scores: clean, total, max, pct, complete, criticalZero, verdict };
}

async function gradeResult(runId, { queryId, repeat = 1, grade, note, rubric: rubricScores }) {
  if (grade !== undefined && !['pass', 'fail', null].includes(grade)) throw new Error("grade must be 'pass', 'fail' or null");
  const saved = await github.updateJson(runFile(runId), null, data => {
    if (!data) throw new Error(`Run ${runId} not found`);
    const r = data.results.find(x => x.queryId === queryId && (x.repeat || 1) === Number(repeat));
    if (!r) throw new Error(`No result for ${queryId} #${repeat}`);
    if (rubricScores !== undefined) {
      r.rubric = rubricScores ? scoreRubric(rubricScores) : null;
      if (r.rubric && r.rubric.verdict) r.grade = r.rubric.verdict;      // complete rubric decides the verdict
      else if (!r.rubric) r.grade = null;
    }
    if (grade !== undefined) r.grade = grade;                              // quick Pass/Fail still works
    if (note !== undefined) r.note = note ? String(note).slice(0, 500) : null;
    data.summary = summarize(data);
    return data;
  }, `eval grade ${runId} ${queryId}`, OBS_BRANCH);
  await saveIndexEntry(saved);
  const result = saved.results.find(x => x.queryId === queryId && (x.repeat || 1) === Number(repeat));
  return { summary: saved.summary, result: result ? { grade: result.grade, rubric: result.rubric || null, note: result.note || null } : null };
}

async function getRun(runId) {
  return github.readJson(runFile(runId), null, OBS_BRANCH);
}

async function listRuns() {
  return (await github.readJson(INDEX_FILE, { runs: [] }, OBS_BRANCH)).runs || [];
}

module.exports = { rubric, scoreRubric, startRun, continueRun, gradeResult, getRun, listRuns, runChecks, summarize, policyBrands, testset, SYSTEMS };
