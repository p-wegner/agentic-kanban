'use strict';
/*
 * Claude-family counter.
 *
 * Research verdict (June 2026, see references/tokenizers.md): there is NO public
 * local tokenizer for current Claude models. The old @anthropic-ai/tokenizer
 * (v0.0.4, 2023) self-describes as "very rough" for Claude 3+, and the newest
 * Claude tokenizer (Opus 4.7+/Fable 5) has no published spec. So:
 *
 *   - offline  → o200k_base as a RELATIVE metric (the shared normalizer). Good
 *                for ranking/redundancy/compression; keep ~15-20% headroom if
 *                optimizing against a hard Claude context limit.
 *   - exact    → Anthropic Messages `count_tokens` API (free, needs network +
 *                ANTHROPIC_API_KEY, counts against rate limits). Opt-in: --exact.
 *
 * `make(base)` wraps the shared normalizer so the offline number IS the
 * cross-provider o200k_base count, and attaches the async API path as `exact`.
 */

const { postJson } = require('./_api');

const NOTE =
  'Claude has no public local tokenizer — counting with o200k_base as a relative metric ' +
  '(±~15-20% vs real Claude; keep headroom). Use --exact for the Anthropic count_tokens API.';

// alias -> API model id
const MODELS = {
  'opus-4.8': 'claude-opus-4-8', 'sonnet-4.6': 'claude-sonnet-4-6',
  'haiku-4.5': 'claude-haiku-4-5', 'fable-5': 'claude-fable-5', 'claude': 'claude-opus-4-8',
};

async function exactViaApi(text, model = 'claude-opus-4-8') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await postJson(
    'https://api.anthropic.com/v1/messages/count_tokens',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model: MODELS[model] || model, messages: [{ role: 'user', content: text }] },
  );
  if (!r || typeof r.input_tokens !== 'number') throw new Error('unexpected count_tokens response');
  return r.input_tokens;
}

function make(base) {
  return {
    name: `claude (${base.name} est.)`,
    estimate: true,
    note: NOTE,
    count: (t) => base.count(t),
    exact: (t, model) => exactViaApi(t, model),
  };
}

module.exports = { make, exactViaApi, NOTE, MODELS };
