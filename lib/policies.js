// Brand policy database (policies.json): fetch Shopify policy pages, extract structured fields with
// Claude Haiku, and verify every quote against the source text.
//
// policies.json:
// { meta: { updatedAt, totalTokens, extractModel },
//   brands: { [brandId]: {
//     name, url, reviewed, extractedAt,
//     sections: { refund|shipping|terms: { url, status: ok|empty|missing|error, text, source: auto|manual } },
//     fields:   { [name]: { value, quote, quoteVerified, source: auto|manual } } } } }
const https = require('https');
const http  = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const { stripHtml } = require('./shopify');

const EXTRACT_MODEL = 'claude-haiku-4-5';
const POLICY_FILE   = 'policies.json';

const SECTIONS = {
  refund:   'refund-policy',
  shipping: 'shipping-policy',
  terms:    'terms-of-service',
};
const MAX_SECTION_CHARS = 20000;   // terms of service can be very long boilerplate

// Field definitions: name → { type, description }. Each extracted value carries the exact source quote.
const FIELDS = {
  returnable:            { type: 'boolean', description: 'Can a customer return an ordinary (non-sale, non-customised) item for a refund or store credit? false if the policy says no returns/refunds (exchange-only counts as false).' },
  returnWindowDays:      { type: 'integer', description: 'Days after delivery within which a return or exchange must be requested.' },
  exchangeOnly:          { type: 'boolean', description: 'true if the brand offers exchanges but not refunds/returns.' },
  saleItemsReturnable:   { type: 'boolean', description: 'Can items bought on sale/discount be returned or exchanged?' },
  customisedReturnable:  { type: 'boolean', description: 'Can customised, altered or made-to-order items be returned?' },
  cod:                   { type: 'boolean', description: 'Is cash on delivery offered?' },
  freeShippingThreshold: { type: 'integer', description: 'Order value in INR above which domestic shipping is free. 0 if all domestic shipping is free.' },
  international:         { type: 'boolean', description: 'Does the brand ship outside India?' },
  dispatchDays:          { type: 'integer', description: 'Typical days to dispatch/ship an order after it is placed (use the upper bound of a range).' },
};

// ── Fetching ───────────────────────────────────────────────

function fetchText(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StyleAggregator/1.0)', 'Accept': 'text/html' },
      timeout: 15000,
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirects < 5) {
        resp.resume();
        return fetchText(new URL(resp.headers.location, urlStr).href, redirects + 1).then(resolve, reject);
      }
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// Policy text lives in <div class="shopify-policy__body"> on every Shopify theme.
function policyBodyText(html) {
  // Match the element's class attribute, not mentions of the class name inside theme scripts.
  const m = /class="[^"]*shopify-policy__body[^"]*"/.exec(html);
  if (!m) return '';
  const start = m.index;
  const rest = html.slice(start);
  const endCandidates = ['</main>', 'shopify-section-footer', 'id="shopify-section'].map(m => rest.indexOf(m)).filter(i => i > 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : rest.length;
  return stripHtml('<div ' + rest.slice(0, end), MAX_SECTION_CHARS).replace(/^class="[^"]*"\s*>?\s*/, '');
}

async function fetchSection(baseUrl, slug) {
  const url = `${baseUrl}/policies/${slug}`;
  try {
    let res = await fetchText(url);
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); res = await fetchText(url); }
    if (res.status === 404) return { url, status: 'missing', text: '' };
    if (res.status !== 200) return { url, status: 'error', text: '', error: `HTTP ${res.status}` };
    const text = policyBodyText(res.body);
    return { url, status: text.length > 40 ? 'ok' : 'empty', text };
  } catch (e) {
    return { url, status: 'error', text: '', error: e.message };
  }
}

// Fetch all sections for a brand. Sections the user pasted by hand (source: manual) are kept.
async function ingestBrand(brand, existing = {}) {
  const baseUrl = brand.url.replace(/\/$/, '');
  const sections = { ...(existing.sections || {}) };
  for (const [key, slug] of Object.entries(SECTIONS)) {
    if (sections[key]?.source === 'manual') continue;
    sections[key] = { ...(await fetchSection(baseUrl, slug)), source: 'auto' };
  }
  return { ...existing, name: brand.name, url: brand.url, sections, ingestedAt: new Date().toISOString() };
}

// ── Extraction ─────────────────────────────────────────────

const normalise = s => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

function quoteIsInSource(quote, sourceText) {
  const q = normalise(quote).replace(/[.…]+$/, '');
  return q.length > 0 && normalise(sourceText).includes(q);
}

function outputSchema() {
  const props = {};
  for (const [name, def] of Object.entries(FIELDS)) {
    props[name] = {
      type: 'object',
      properties: {
        value: { anyOf: [{ type: def.type }, { type: 'null' }] },
        quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['value', 'quote'],
      additionalProperties: false,
    };
  }
  return { type: 'object', properties: props, required: Object.keys(FIELDS), additionalProperties: false };
}

function sourceText(entry) {
  return Object.entries(entry.sections || {})
    .filter(([, s]) => s.text)
    .map(([key, s]) => `## ${key.toUpperCase()} POLICY\n${s.text}`)
    .join('\n\n');
}

function extractionPrompt(brandName, text) {
  const fieldList = Object.entries(FIELDS).map(([n, d]) => `- ${n} (${d.type}): ${d.description}`).join('\n');
  return `Below are the store policies of the Indian fashion brand "${brandName}".

Extract these fields:
${fieldList}

Rules:
- Use only what the policy text states. If a field is not clearly stated, set value to null and quote to null. Never guess or infer from general practice.
- For every non-null value, quote must be the exact sentence (or shortest exact span) from the text that supports it, copied character for character.
- Prices are in INR.

<policies>
${text}
</policies>`;
}

async function extractBrand(client, entry) {
  const text = sourceText(entry);
  if (!text) return { ...entry, extractError: 'No policy text to extract from' };

  const response = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: extractionPrompt(entry.name, text) }],
    output_config: { format: { type: 'json_schema', schema: outputSchema() } },
  });
  if (response.stop_reason !== 'end_turn') {
    return { ...entry, extractError: `Extraction stopped: ${response.stop_reason}` };
  }
  const block = response.content.find(b => b.type === 'text');
  const parsed = JSON.parse(block.text);

  const fields = { ...(entry.fields || {}) };
  for (const name of Object.keys(FIELDS)) {
    if (fields[name]?.source === 'manual') continue;          // never overwrite a reviewed edit
    const { value, quote } = parsed[name] || {};
    fields[name] = {
      value: value ?? null,
      quote: quote ?? null,
      quoteVerified: value == null ? null : quoteIsInSource(quote, text),
      source: 'auto',
    };
  }
  return { ...entry, fields, extractError: null, extractedAt: new Date().toISOString(), usage: response.usage };
}

// Token count of all policy text combined (the figure the build plan asks for).
async function countPolicyTokens(client, policies) {
  const all = Object.values(policies.brands || {}).map(sourceText).filter(Boolean).join('\n\n');
  if (!all) return 0;
  const res = await client.messages.countTokens({ model: EXTRACT_MODEL, messages: [{ role: 'user', content: all }] });
  return res.input_tokens;
}

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured.');
  return new Anthropic();
}

module.exports = {
  POLICY_FILE, SECTIONS, FIELDS, EXTRACT_MODEL,
  ingestBrand, extractBrand, countPolicyTokens, getAnthropic,
  policyBodyText, quoteIsInSource, outputSchema, sourceText,
};
