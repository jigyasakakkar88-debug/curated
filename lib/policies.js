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
  returnable:            { type: 'boolean', description: 'Can a customer return an ordinary item they simply don\'t want (change of mind, size or fit) for a refund OR store credit? Returns allowed only for damaged, defective or wrong items do NOT count (false). Exchange-only also counts as false.' },
  returnWindowDays:      { type: 'integer', description: 'Days after delivery within which an ordinary (change-of-mind) return or exchange must be requested. Convert hours to days (24-48 hours = 2). Ignore deadlines that apply only to reporting damaged/defective/wrong items.' },
  exchangeOnly:          { type: 'boolean', description: 'true if an ordinary item can be exchanged (another size or product) but not returned for a refund or store credit. Exchanges offered only for damaged/defective items do not count.' },
  saleItemsReturnable:   { type: 'boolean', description: 'Can items bought on sale or discount be returned or exchanged (other than for damage)?' },
  customisedReturnable:  { type: 'boolean', description: 'Can customised, altered or made-to-order items be returned or exchanged (other than for damage)?' },
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

// Spacing is ignored: themes split words for drop caps ("U nfortunately").
const squash = s => normalise(s).replace(/\s+/g, '');

function quoteIsInSource(quote, sourceText) {
  const q = squash(quote).replace(/[.…]+$/, '');
  return q.length > 0 && squash(sourceText).includes(q);
}

// Fix systematic slips the model makes, using the quote as evidence.
function normaliseFields(fields) {
  const days = fields.returnWindowDays;
  if (days?.source === 'auto' && days.value != null && /\bhours?\b/i.test(days.quote || '') && !/\bdays?\b/i.test(days.quote || '')) {
    days.value = Math.max(1, Math.ceil(days.value / 24));          // "24-48 hours" → 2 days
    days.note = 'converted from hours';
  }
  const ret = fields.returnable, exch = fields.exchangeOnly;
  if (ret?.source !== 'manual' && (ret?.value == null) && exch?.value === true) {
    fields.returnable = { value: false, quote: exch.quote, quoteVerified: exch.quoteVerified, source: 'auto',
                          note: 'implied by exchange-only' };
  }
  return fields;
}

// No union types (the API caps them; 9 nullable fields exceeded it). "stated: false" means not in the policy.
function outputSchema() {
  const props = {};
  for (const [name, def] of Object.entries(FIELDS)) {
    props[name] = {
      type: 'object',
      properties: {
        stated: { type: 'boolean', description: 'false if the policy does not clearly state this' },
        value:  { type: def.type },
        quote:  { type: 'string', description: 'exact supporting sentence; empty if not stated' },
      },
      required: ['stated', 'value', 'quote'],
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
- Use only what the policy text states. If a field is not clearly stated, set stated to false (value and quote are then ignored). Never guess or infer from general practice.
- Rules for damaged, defective or wrongly-sent items are NOT the brand's return policy. Only use them for a field if the field says so.
- When stated is true, quote must be the exact sentence (or shortest exact span) from the text that supports it, copied character for character.
- Prices are in INR.

<policies>
${text}
</policies>`;
}

const PLAIN_JSON_INSTRUCTION = `

Reply with ONLY a JSON object, no other text. It must have exactly these keys: ${Object.keys(FIELDS).join(', ')}.
Each key maps to {"stated": <true|false>, "value": <boolean or integer>, "quote": <exact sentence, or "" if not stated>}.`;

function parseResponse(response, lenient = false) {
  if (response.stop_reason !== 'end_turn') throw new Error(`Extraction stopped: ${response.stop_reason}`);
  const text = (response.content.find(b => b.type === 'text') || {}).text || '';
  if (!lenient) return JSON.parse(text);
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No JSON object in the reply');
  return JSON.parse(text.slice(start, end + 1));
}

async function extractBrand(client, entry) {
  const text = sourceText(entry);
  if (!text) return { ...entry, extractError: 'No policy text to extract from' };

  const prompt = extractionPrompt(entry.name, text);
  let parsed, mode = 'structured';
  try {
    const response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: outputSchema() } },
    });
    parsed = parseResponse(response);
  } catch (e) {
    // If the API rejects the structured-output request itself (400), ask for plain JSON instead.
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    mode = `plain-json (structured rejected: ${e.message.slice(0, 160)})`;
    const response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt + PLAIN_JSON_INSTRUCTION }],
    });
    parsed = parseResponse(response, true);
  }

  const fields = { ...(entry.fields || {}) };
  for (const name of Object.keys(FIELDS)) {
    if (fields[name]?.source === 'manual') continue;          // never overwrite a reviewed edit
    const raw = parsed[name] || {};
    // Older/plain replies may omit "stated"; treat a null value as not stated.
    const stated = raw.stated !== false && raw.value != null;
    const value = stated ? raw.value : null;
    const quote = stated && raw.quote ? raw.quote : null;
    fields[name] = {
      value,
      quote,
      quoteVerified: value == null ? null : quoteIsInSource(quote, text),
      source: 'auto',
    };
  }
  return { ...entry, fields: normaliseFields(fields), extractError: null, extractMode: mode, extractedAt: new Date().toISOString() };
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
  // Retries honour the API's retry-after on 429/529.
  return new Anthropic({ maxRetries: 5 });
}

module.exports = {
  POLICY_FILE, SECTIONS, FIELDS, EXTRACT_MODEL,
  ingestBrand, extractBrand, countPolicyTokens, getAnthropic,
  policyBodyText, quoteIsInSource, normaliseFields, outputSchema, sourceText,
};
