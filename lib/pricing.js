// Claude prices in USD per million tokens.
// Source: https://platform.claude.com/docs/en/about-claude/pricing — re-check when models change.
// cacheWrite = 5-minute cache write (1.25× input). 1-hour writes cost 2× input and aren't used here.
const checkedOn = "2026-10-01";

const MODELS = {
  "claude-sonnet-5-5": { input: 2.00, output: 10.00, cacheWrite: 2.50, cacheRead: 0.20 },
  "claude-sonnet-5":   { input: 2.00, output: 10.00, cacheWrite: 2.50, cacheRead: 0.20 },
  "claude-haiku-4-5":  { input: 1.00, output:  5.00, cacheWrite: 1.25, cacheRead: 0.10 },
};

// Edit this when the rupee moves. Used only for reporting cost in ₹.
const USD_INR = 88;

// usage = Anthropic `response.usage` (or a running total with the same field names).
function costUSD(model, usage = {}) {
  const p = MODELS[model];
  if (!p) return null;
  const perM = (tokens, price) => ((tokens || 0) / 1e6) * price;
  return perM(usage.input_tokens, p.input)
       + perM(usage.output_tokens, p.output)
       + perM(usage.cache_creation_input_tokens, p.cacheWrite)
       + perM(usage.cache_read_input_tokens, p.cacheRead);
}

function costINR(model, usage) {
  const usd = costUSD(model, usage);
  return usd == null ? null : Math.round(usd * USD_INR * 100) / 100;
}

module.exports = { checkedOn, MODELS, USD_INR, costUSD, costINR };
