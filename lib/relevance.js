// Relevance labels: the answer key for recall.
// For each discovery question we pool a wide set of candidate products (several searches + everything any eval run
// showed), have Claude Haiku pre-grade each one 0/1/2 from its photo and text, and let the owner confirm or override.
// The final label is the human grade when set, else the AI grade. Eval runs are then scored against the labels:
// precision@k, recall@k (capped at k) and nDCG@k. Files: evals/relevance/<queryId>.json on the observability branch.
const Anthropic = require('@anthropic-ai/sdk');
const github = require('./github');
const algolia = require('./algolia');
const { cleanSearch, browseProducts } = require('./tools');
const { OBS_BRANCH, round } = require('./observability');
const { costINR } = require('./pricing');
const testset = require('../evals/testset.json');

const JUDGE_MODEL = 'claude-haiku-4-5';
const POOL_CAP = 80;
const BATCH = 12;
const file = id => `evals/relevance/${id}.json`;

// Discovery questions = the ones where a good answer shows products.
const labelQueries = () => testset.queries.filter(q => q.checks && q.checks.expectProducts);

function snapshot(r) {
  return { name: r.name, brandId: r.brandId, brandName: r.brandName, price: r.price, image: r.image || null,
           productUrl: r.productUrl || null, productType: r.productType || null, gender: r.gender || null,
           tags: (r.tags || []).slice(0, 8), description: (r.description || '').slice(0, 300) };
}

const finalGrade = it => (it.human != null ? it.human : it.ai ? it.ai.grade : null);

// ── Pool ───────────────────────────────────────────────────

function constraintText(q) {
  const c = q.checks || {}, out = [];
  if (c.maxPrice) out.push(`price at most ₹${c.maxPrice}`);
  if (c.maxTotal) out.push(`two outfits totalling at most ₹${c.maxTotal}`);
  if (c.returnableOnly) out.push('only brands that accept returns');
  if (c.gender) out.push(`for ${c.gender}`);
  if (q.followUp) out.push(`the shopper added: "${q.followUp}"`);
  return out.join('; ') || 'none stated';
}

// Ask Haiku for several differently-worded searches, so the pool isn't limited to one way of phrasing the ask.
async function planSearches(client, q) {
  const prompt = `You are helping build a test set for a fashion search engine covering Indian independent brands.
Shopper request: "${q.query}"
Constraints: ${constraintText(q)}
A good answer must: ${q.must || '-'}

Write 5 varied keyword searches that together would find every product that could fit this request
(different garment types, fabrics and wordings; short product vocabulary like "chanderi kurta set", not sentences).
Reply with JSON only: {"searches":[{"query":"...","maxPrice":number|null,"gender":"women"|"men"|"kids"|null,"returnableOnly":true|false}]}`;
  const res = await client.messages.create({ model: JUDGE_MODEL, max_tokens: 800, messages: [{ role: 'user', content: prompt }] });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let searches = [];
  try { searches = JSON.parse(m ? m[0] : text).searches || []; } catch { searches = []; }
  return { searches: searches.slice(0, 6).map(s => cleanSearch(s)), usage: res.usage };
}

async function recentRunProducts(queryId, max = 15) {
  const index = (await github.readJson('evals/index.json', { runs: [] }, OBS_BRANCH)).runs || [];
  const out = [];
  for (const r of index.slice(0, max)) {
    const run = await github.readJson(`evals/runs/${r.runId}.json`, null, OBS_BRANCH).catch(() => null);
    for (const x of run?.results || []) if (x.queryId === queryId) for (const p of x.products || []) out.push({ id: p.id, runId: r.runId });
  }
  return out;
}

async function buildPool(queryId, { index = algolia.INDEX, client } = {}) {
  const q = testset.queries.find(x => x.id === queryId);
  if (!q) throw new Error(`Unknown query ${queryId}`);
  client = client || new Anthropic({ maxRetries: 3 });
  const search = algolia.getClient('search');
  const c = q.checks || {};
  const base = { maxPrice: c.maxPrice || null, gender: c.gender || null, returnableOnly: c.returnableOnly || null };

  const { searches, usage } = await planSearches(client, q).catch(() => ({ searches: [], usage: null }));
  const plans = [{ query: q.query, ...base }, ...searches.map(s => ({ ...base, ...s }))].map(cleanSearch);

  const existing = (await github.readJson(file(queryId), null, OBS_BRANCH).catch(() => null)) || { queryId, items: {} };
  const items = { ...existing.items };
  const add = (r, source) => {
    const id = r.objectID || r.id;
    if (!items[id]) items[id] = { snapshot: snapshot(r), ai: null, human: null, sources: [] };
    if (!items[id].sources.includes(source)) items[id].sources.push(source);
  };

  // Plain relevance order, first page (24) of each search: full records, so the pool has photos and links.
  for (const p of plans) {
    const r = await browseProducts(search, index, p, 0);
    for (const hit of r.hits) add(hit, `search: ${p.query}`);
  }
  // Products any eval run showed must be labelled, or their runs can't be scored.
  const shown = await recentRunProducts(queryId);
  const missing = [...new Set(shown.map(s => s.id))].filter(id => !items[id]);
  if (missing.length) {
    const { results } = await search.getObjects({ requests: missing.map(id => ({ indexName: index, objectID: id })) });
    results.filter(Boolean).forEach(r => add(r, 'eval run'));
  }
  // Cap new additions (keep everything already labelled or shown in a run).
  const keep = Object.entries(items).filter(([, it]) => it.human != null || it.ai || it.sources.includes('eval run'));
  const fresh = Object.entries(items).filter(([, it]) => !(it.human != null || it.ai || it.sources.includes('eval run')));
  const capped = Object.fromEntries([...keep, ...fresh.slice(0, Math.max(0, POOL_CAP - keep.length))]);

  const data = { queryId, query: q.query, must: q.must || null, mustNot: q.mustNot || null, constraints: constraintText(q),
                 index, searches: plans, builtAt: new Date().toISOString(), items: capped,
                 cost: { poolINR: usage ? costINR(JUDGE_MODEL, usage) : 0, judgeINR: existing.cost?.judgeINR || 0 } };
  await github.ensureBranch(OBS_BRANCH);
  await github.updateJson(file(queryId), null, () => data, `relevance pool ${queryId}`, OBS_BRANCH);
  return summarizeLabels(data);
}

// ── AI pre-grading ─────────────────────────────────────────

function smallImage(url) {
  if (!url) return null;
  try { const u = new URL(url); u.searchParams.set('width', '256'); return u.toString(); } catch { return null; }
}

function judgePrompt(q, data) {
  return `You are an experienced Indian fashion stylist grading search results for a shopper.
Shopper request: "${q.query}"
Constraints: ${data.constraints}
A good answer must: ${q.must || '-'}
A good answer must NOT: ${q.mustNot || '-'}

Grade each product below for this request, looking at the photo and the text:
2 = great fit: you'd happily recommend it for exactly this request
1 = acceptable: fits, but not ideal (style, occasion or fabric is a stretch)
0 = wrong: wrong category, wrong occasion, wrong gender, or breaks a constraint
Be strict: most search results are not a 2. Reply with JSON only:
{"grades":[{"id":"<product id>","grade":0|1|2,"why":"under 12 words"}]}`;
}

async function judgeBatch(client, q, data, batch, withImages) {
  const content = [{ type: 'text', text: judgePrompt(q, data) }];
  for (const [id, it] of batch) {
    const s = it.snapshot;
    const img = withImages ? smallImage(s.image) : null;
    if (img) content.push({ type: 'image', source: { type: 'url', url: img } });
    content.push({ type: 'text', text: `id: ${id}\n${s.name} | ${s.brandName} | ₹${s.price} | type: ${s.productType || '-'} | gender: ${s.gender || '-'}\ntags: ${(s.tags || []).join(', ')}\n${s.description || ''}` });
  }
  const res = await client.messages.create({ model: JUDGE_MODEL, max_tokens: 2000, messages: [{ role: 'user', content }] });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  const grades = (JSON.parse(m ? m[0] : text).grades || []).filter(g => [0, 1, 2].includes(g.grade));
  return { grades, usage: res.usage, withImages };
}

async function judgePool(queryId, { client, budgetMs = 240000, concurrency = 3 } = {}) {
  const q = testset.queries.find(x => x.id === queryId);
  const data = await github.readJson(file(queryId), null, OBS_BRANCH);
  if (!q || !data) throw new Error(`Build the pool for ${queryId} first`);
  client = client || new Anthropic({ maxRetries: 3 });
  const todo = Object.entries(data.items).filter(([, it]) => !it.ai);
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  const started = Date.now(), results = [];
  let next = 0;
  async function worker() {
    while (next < batches.length && Date.now() - started < budgetMs) {
      const b = batches[next++];
      try { results.push(await judgeBatch(client, q, data, b, true)); }
      catch (e) {                                   // an image URL the API can't fetch fails the batch: retry without photos
        try { results.push(await judgeBatch(client, q, data, b, false)); } catch (e2) { console.error('judge batch failed', e2.message); }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  let spent = 0;
  const graded = {};
  for (const r of results) {
    spent += costINR(JUDGE_MODEL, r.usage) || 0;
    for (const g of r.grades) graded[g.id] = { grade: g.grade, why: String(g.why || '').slice(0, 120), model: JUDGE_MODEL, photo: r.withImages };
  }
  const saved = await github.updateJson(file(queryId), null, d => {
    for (const [id, a] of Object.entries(graded)) if (d.items[id]) d.items[id].ai = a;
    d.cost = { ...(d.cost || {}), judgeINR: round((d.cost?.judgeINR || 0) + spent) };
    d.judgedAt = new Date().toISOString();
    return d;
  }, `relevance judge ${queryId}`, OBS_BRANCH);
  return { ...summarizeLabels(saved), remaining: Object.values(saved.items).filter(it => !it.ai).length };
}

// ── Human labels ───────────────────────────────────────────

async function saveLabels(queryId, labels) {
  const saved = await github.updateJson(file(queryId), null, d => {
    if (!d) throw new Error(`No pool for ${queryId}`);
    for (const [id, v] of Object.entries(labels || {})) {
      const it = d.items[id];
      if (!it) continue;
      if (v === 'confirm') { if (it.ai) { it.human = it.ai.grade; it.bulk = true; } continue; }   // "agree with AI" in bulk
      it.human = [0, 1, 2].includes(v) ? v : null;
      delete it.bulk;
    }
    return d;
  }, `relevance labels ${queryId}`, OBS_BRANCH);
  return summarizeLabels(saved);
}

function summarizeLabels(d) {
  const items = Object.values(d?.items || {});
  const reviewed = items.filter(it => it.human != null);
  const both = reviewed.filter(it => it.ai && !it.bulk);     // bulk "agree with AI" clicks would inflate agreement
  return {
    queryId: d?.queryId, pool: items.length,
    aiGraded: items.filter(it => it.ai).length,
    humanReviewed: reviewed.length,
    great: items.filter(it => finalGrade(it) === 2).length,
    acceptable: items.filter(it => finalGrade(it) === 1).length,
    // How often the AI judge agreed with you, among items you reviewed: the evidence for trusting its unreviewed grades.
    judgeAgreement: both.length ? round(both.filter(it => it.human === it.ai.grade).length / both.length) : null,
    judgeAgreementN: both.length,
    costINR: round((d?.cost?.poolINR || 0) + (d?.cost?.judgeINR || 0)),
    builtAt: d?.builtAt || null,
  };
}

async function overview() {
  const out = [];
  for (const q of labelQueries()) {
    const d = await github.readJson(file(q.id), null, OBS_BRANCH).catch(() => null);
    out.push({ ...summarizeLabels(d || { queryId: q.id }), queryId: q.id, query: q.query });
  }
  return out;
}

const getLabels = queryId => github.readJson(file(queryId), null, OBS_BRANCH);

// ── Scoring eval runs ──────────────────────────────────────

function scoreResult(x, d) {
  const items = d.items || {};
  const shown = (x.products || []).map(p => p.id);
  const k = shown.length;
  if (!k) return null;
  const grade = id => (items[id] ? finalGrade(items[id]) : null);
  const labelled = shown.filter(id => grade(id) != null);
  const greatIds = Object.keys(items).filter(id => finalGrade(items[id]) === 2);
  const foundGreat = shown.filter(id => grade(id) === 2).length;
  const dcg = shown.reduce((a, id, i) => a + ((2 ** (grade(id) || 0)) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(items).map(finalGrade).filter(g => g != null).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((a, g, i) => a + ((2 ** g) - 1) / Math.log2(i + 2), 0);
  return {
    k, labelled: labelled.length, unlabelled: k - labelled.length,
    precision: labelled.length ? round(labelled.filter(id => grade(id) >= 1).length / labelled.length) : null,
    greatInPool: greatIds.length, foundGreat,
    // Recall capped at k: a 6-card answer can't show 20 great pieces, so the best possible is min(great, k).
    recall: greatIds.length ? round(foundGreat / Math.min(greatIds.length, k)) : null,
    ndcg: idcg ? round(dcg / idcg) : null,
  };
}

async function scoreRun(run) {
  const ids = [...new Set((run.results || []).map(x => x.queryId))].filter(id => labelQueries().some(q => q.id === id));
  const labels = {};
  for (const id of ids) labels[id] = await getLabels(id).catch(() => null);
  const per = {};
  for (const x of run.results || []) {
    const d = labels[x.queryId];
    if (d && Object.keys(d.items || {}).length) per[`${x.queryId}#${x.repeat || 1}`] = scoreResult(x, d);
  }
  const vals = Object.values(per).filter(Boolean);
  const mean = f => { const v = vals.map(f).filter(n => typeof n === 'number'); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  return { per, summary: vals.length ? { scored: vals.length, precision: mean(v => v.precision), recall: mean(v => v.recall),
                                          ndcg: mean(v => v.ndcg), unlabelledShown: vals.reduce((a, v) => a + v.unlabelled, 0) } : null };
}

module.exports = { labelQueries, buildPool, judgePool, saveLabels, getLabels, overview, scoreRun, scoreResult, summarizeLabels, finalGrade, JUDGE_MODEL };
