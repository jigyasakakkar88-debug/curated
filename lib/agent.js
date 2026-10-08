// Option C: one agent with tools, up to MAX_ROUNDS model calls, finishing via the `respond` tool.
const Anthropic = require('@anthropic-ai/sdk');
const { createToolbox, cleanSearch } = require('./tools');
const { SYSTEM_PROMPT, brandListBlock } = require('./prompt');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_ROUNDS = 6;
const EFFORT = 'medium';                       // starting point for multistep tool use; tune with evals
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function getModel() {
  return process.env.STYLIST_MODEL || DEFAULT_MODEL;
}

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured.');
  return new Anthropic({ maxRetries: 3 });
}

// Client history → API messages: last 6 turns, plain text only, alternating, starting with the user.
function toApiMessages(history = [], { anchorId } = {}) {
  const turns = history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, 2000) }));
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content += '\n' + t.content;
    else merged.push({ ...t });
  }
  if (!merged.length || merged[merged.length - 1].role !== 'user') throw new Error('The last message must be from the user.');
  if (anchorId) {
    const last = merged[merged.length - 1];
    last.content = `[The user is viewing product ${anchorId}. "This", "it" or "this piece" means that product — call get_product to see it.]\n\n${last.content}`;
  }
  return merged;
}

async function createMessage(client, params, useFallbacks) {
  if (!useFallbacks) return client.messages.create(params);
  try {
    return await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' });
  } catch (e) {
    // If the fallback option itself is rejected (e.g. a model that doesn't support it), retry plainly.
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) return client.messages.create(params);
    throw e;
  }
}

/**
 * Run one Stylist turn.
 * @returns {{ answer: {text, product_ids, caveats, policy_quotes}, rawAnswer, finishedBy }}
 */
async function runAgent({ history, wishlistIds = [], anchorId = null, index = 'products', brands = [], trace,
                          client = null, toolbox = null, model = getModel() }) {
  const anthropic = client || getAnthropic();
  const tools = toolbox || createToolbox({ index, wishlistIds, anchorId, trace });
  const useFallbacks = model === 'claude-sonnet-5-5' && !client;   // server-side fallback: Claude API only

  // Stable prefix (tools → system) is cached; the brand list changes only when brands are added.
  const system = [
    { type: 'text', text: SYSTEM_PROMPT },
    { type: 'text', text: brandListBlock(brands), cache_control: { type: 'ephemeral' } },
  ];
  const messages = toApiMessages(history, { anchorId });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const response = await createMessage(anthropic, {
      model, max_tokens: 8000, system, tools: tools.definitions, messages,
      output_config: { effort: EFFORT },
    }, useFallbacks);
    trace?.llm(response.usage);

    if (response.stop_reason === 'refusal') {
      return finish({ text: "Sorry — I can't help with that one. I can help you find pieces from Curated's brands, or answer questions about their sizes, prices and return policies.",
                      product_ids: [] }, 'refusal');
    }

    // Append the assistant turn unchanged (thinking blocks included): history must stay append-only.
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const respond = toolUses.find(b => b.name === 'respond');
    if (respond) {
      await tools.run('respond', respond.input);
      return finish(respond.input, 'respond');
    }

    if (!toolUses.length) {
      // The model answered in plain text instead of calling respond.
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (round < MAX_ROUNDS) {
        messages.push({ role: 'user', content: 'Please deliver that answer by calling the respond tool.' });
        continue;
      }
      return finish({ text: text || "Sorry, I couldn't put an answer together. Please try rephrasing.", product_ids: [] }, 'text');
    }

    // Run every requested tool (in parallel) and return all results in one user message.
    const results = await Promise.all(toolUses.map(async b => ({
      type: 'tool_result', tool_use_id: b.id,
      content: JSON.stringify(await tools.run(b.name, b.input)),
    })));
    const content = [...results];
    if (round === MAX_ROUNDS - 1) {
      content.push({ type: 'text', text: 'This is your last step: call respond now with the best answer you have, noting anything unfinished in caveats.' });
    }
    messages.push({ role: 'user', content });
  }

  return finish({ text: "Sorry, that took too many steps. Could you narrow it down a little (an occasion, budget or type of garment)?",
                  product_ids: [] }, 'max-rounds');

  function finish(raw, finishedBy) {
    const answer = {
      text: String(raw.text || '').trim(),
      product_ids: Array.isArray(raw.product_ids) ? raw.product_ids.map(String) : [],
      caveats: Array.isArray(raw.caveats) ? raw.caveats.map(String) : [],
      policy_quotes: Array.isArray(raw.policy_quotes) ? raw.policy_quotes.filter(q => q && q.quote) : [],
      product_reasons: Array.isArray(raw.product_reasons)
        ? raw.product_reasons.filter(r => r && r.id && r.why).map(r => ({ id: String(r.id), why: String(r.why).slice(0, 160) })) : [],
      browse: raw.browse && typeof raw.browse === 'object' ? cleanSearch(raw.browse) : null,
    };
    return { answer, finishedBy };
  }
}

module.exports = { runAgent, toApiMessages, getModel, MAX_ROUNDS, DEFAULT_MODEL };
